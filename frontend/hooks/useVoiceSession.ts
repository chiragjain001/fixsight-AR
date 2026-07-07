import { useEffect, useRef, useState } from 'react';
import { useAudioRecorder, useAudioRecorderState, RecordingPresets, setAudioModeAsync, requestRecordingPermissionsAsync } from 'expo-audio';
import * as Speech from 'expo-speech';
import { useWorkflowStore } from '../store/workflowStore';
import { useMemoryManager } from '../store/memoryManager';
import { useARTrackingStore } from '../store/arTrackingStore';
import { BACKEND_URL } from '../src/config';
import { Platform } from 'react-native';
import { useSceneRefreshManager } from './useSceneRefreshManager';
import { useARGrounding } from './useARGrounding';

const SILENCE_DURATION_MS    = 1400;  // ms of silence after speech → submit (longer = less hair-trigger)
const INACTIVITY_DURATION_MS = 12000; // ms with no speech at all → end session
const STATE_POLL_MS          = 100;   // useAudioRecorderState polling rate

// VAD Tuning parameters
const ROLLING_WINDOW_SIZE = 12;      // 1.2s window — smooths transient noise spikes
const BASELINE_SAMPLE_FRAMES = 10;   // first 1s used to determine initial noise floor (more accurate)
const MAX_NOISE_FLOOR = -30;         // lower cap so noisy rooms don't raise the effective floor too high
const SPEECH_CONFIDENCE_THRESHOLD = 0.72; // raised: requires clear speech signal, not just a bump
const BARGE_IN_CONFIDENCE_THRESHOLD = 0.85; // higher bar for interrupting AI — avoids AI voice triggering barge-in

export const useVoiceSession = () => {
  const store = useWorkflowStore();
  const { compressIfNeeded } = useMemoryManager();
  const { analyzeIntent } = useSceneRefreshManager();
  const { groundLabels, clearAll: clearARLabels } = useARGrounding();

  // captureFrame: AR path (preferred) or legacy VisionCamera path
  const captureFrameRef = useRef<(() => Promise<{ base64: string }>) | null>(null);
  useEffect(() => {
    captureFrameRef.current = useWorkflowStore.getState().captureFrame;
  }, [store.captureFrame ?? null]);

  // ── Metering exposed to UI ────────────────────────────────────────────────
  const [metering, setMetering] = useState(-160);

  // ── Refs (stable across renders, no stale closure) ────────────────────────
  const silenceTimer    = useRef(0);
  const inactivityTimer = useRef(0);
  const hasSpoken       = useRef(false);
  const isProcessing    = useRef(false);
  const ttsQueue        = useRef<string[]>([]);
  const isSpeakingQueue = useRef(false);
  const activeXhrRef    = useRef<XMLHttpRequest | null>(null); // tracks in-flight XHR for abort
  const isStartingRecording = useRef(false); // mutex: prevents concurrent prepareToRecordAsync calls
  const isToolRunningRef    = useRef(false);

  // VAD dynamic state
  const recentLevels    = useRef<number[]>([]);
  const baselineNoise   = useRef<number>(-160);
  const frameCount      = useRef<number>(0);

  // Store latest phase in a ref so VAD effect closure is never stale
  const voicePhaseRef  = useRef(store.voicePhase);
  const sessionActiveRef = useRef(store.voiceSessionActive);

  useEffect(() => { voicePhaseRef.current = store.voicePhase; }, [store.voicePhase]);
  useEffect(() => { sessionActiveRef.current = store.voiceSessionActive; }, [store.voiceSessionActive]);

  // ── Audio recorder ────────────────────────────────────────────────────────
  const audioRecorder = useAudioRecorder(
    { ...RecordingPresets.HIGH_QUALITY, isMeteringEnabled: true }
  );

  // useAudioRecorderState polls the recorder at STATE_POLL_MS — gives real-time metering
  const recorderState = useAudioRecorderState(audioRecorder, STATE_POLL_MS);

  // ── Permissions & audio mode (once on mount) ──────────────────────────────
  useEffect(() => {
    (async () => {
      const { granted } = await requestRecordingPermissionsAsync();
      if (!granted) {
        console.warn('[VoiceSession] Microphone permission denied!');
        return;
      }
      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
        interruptionMode: 'doNotMix',
        shouldPlayInBackground: false,
        shouldRouteThroughEarpiece: false,
      });
    })();
  }, []);

  // ── TTS queue ─────────────────────────────────────────────────────────────
  const enqueueTTS = (text: string) => {
    if (!text?.trim()) return;
    ttsQueue.current.push(text);
    processTTSQueue();
  };

  const processTTSQueue = () => {
    if (isSpeakingQueue.current || ttsQueue.current.length === 0) return;
    const sentence = ttsQueue.current.shift();
    if (!sentence) return;
    isSpeakingQueue.current = true;
    // Mark ANSWERING so the VAD barge-in and Stop button work correctly.
    voicePhaseRef.current = 'ANSWERING';
    useWorkflowStore.getState().setVoicePhase('ANSWERING');
    Speech.speak(sentence, {
      language: useWorkflowStore.getState().detectedLanguage || 'en',
      rate: 0.92,
      pitch: 1.0,
      onDone: () => {
        isSpeakingQueue.current = false;
        if (ttsQueue.current.length > 0) {
          processTTSQueue();
        } else if (sessionActiveRef.current) {
          // We MUST guard on isProcessing. If the backend is still streaming (e.g. executing a tool),
          // the queue might be temporarily empty. We should NOT turn the mic back on yet, otherwise
          // the AI's next sentence will trigger a false barge-in.
          // Only delay restart if a visual tool is actively running (taking photo / VLM analysis).
          // In all other cases (normal chat, final sentence after tool), restart immediately
          // without waiting for the HTTP connection to fully close.
          if (isProcessing.current && isToolRunningRef.current) {
            console.log('[TTS] Tool is running. Reverting to VLM_RUNNING, waiting for result...');
            voicePhaseRef.current = 'VLM_RUNNING';
            useWorkflowStore.getState().setVoicePhase('VLM_RUNNING');
          } else {
            console.log('[TTS] All sentences done. Restarting recorder...');
            voicePhaseRef.current = 'LISTENING';
            useWorkflowStore.getState().setVoicePhase('LISTENING');
            startRecording();
          }
        }
      },
      onStopped: () => { isSpeakingQueue.current = false; },
      onError: () => { isSpeakingQueue.current = false; processTTSQueue(); },
    });
  };

  const clearTTSQueue = () => {
    ttsQueue.current = [];
    isSpeakingQueue.current = false;
    Speech.stop();
  };

  // ── Start recording ───────────────────────────────────────────────────────
  const startRecording = async () => {
    if (!sessionActiveRef.current) return;
    // Mutex guard — prevents two concurrent prepareToRecordAsync calls which
    // crash the native AudioRecorder with "already been prepared" error.
    if (isStartingRecording.current) {
      console.log('[VoiceSession] startRecording already in progress — skipping duplicate call.');
      return;
    }
    isStartingRecording.current = true;
    try {
      if (audioRecorder.isRecording) {
        await audioRecorder.stop();
      }
      console.log('[VoiceSession] Preparing recorder...');
      await audioRecorder.prepareToRecordAsync();
      audioRecorder.record();
      hasSpoken.current       = false;
      silenceTimer.current    = 0;
      inactivityTimer.current = 0;
      isProcessing.current    = false;
      recentLevels.current    = [];
      baselineNoise.current   = -160;
      frameCount.current      = 0;
      isToolRunningRef.current = false;
      voicePhaseRef.current   = 'LISTENING';
      useWorkflowStore.getState().setVoicePhase('LISTENING');
      console.log('[VoiceSession] Recording started ✓');
    } catch (err) {
      console.error('[VoiceSession] Failed to start recording:', err);
    } finally {
      isStartingRecording.current = false;
    }
  };

  // ── Stop + Transcribe + Stream ────────────────────────────────────────────
  const stopRecordingAndProcess = async (isManual = false) => {
    if (isProcessing.current) return;
    isProcessing.current = true;
    
    // Set UI to THINKING immediately so it doesn't look frozen while waiting for the recorder to stop.
    useWorkflowStore.getState().setVoicePhase('THINKING');
    voicePhaseRef.current = 'THINKING';

    const didSpeak = hasSpoken.current || isManual;
    hasSpoken.current    = false;
    silenceTimer.current = 0;

    try {
      try {
        console.log('[VoiceSession] Stopping recorder...');
        await audioRecorder.stop(); // MUST await before reading .uri
        console.log('[VoiceSession] Recorder stopped, URI:', audioRecorder.uri);
      } catch (e) {
        console.warn('[VoiceSession] Recorder stop error (or already stopped):', e);
      }

      if (!didSpeak) {
        console.log('[VoiceSession] No speech — restarting.');
        isProcessing.current = false;
        startRecording();
        return;
      }

      const uri = audioRecorder.uri;
      if (!uri) {
        console.warn('[VoiceSession] No URI after stop.');
        isProcessing.current = false;
        startRecording();
        return;
      }

      const s = useWorkflowStore.getState();
      useWorkflowStore.getState().updateSessionStats({ questionsAsked: s.sessionStats.questionsAsked + 1 });

      // 1. Transcribe
      let transcribedText = '';
      let detectedLang    = 'en';
      try {
        console.log('[VoiceSession] Transcribing audio...');
        const result = await attemptTranscription(uri);
        transcribedText = result.text;
        detectedLang    = result.language;
        console.log(`[VoiceSession] Transcribed: "${transcribedText}" (${detectedLang})`);
      } catch (err) {
        console.warn('[VoiceSession] Transcription failed:', err);
        enqueueTTS("I'm having trouble hearing you. Could you try again?");
        isProcessing.current = false;
        startRecording();
        return;
      }

      if (!transcribedText.trim()) {
        console.log('[VoiceSession] Empty transcript — restarting.');
        isProcessing.current = false;
        startRecording();
        return;
      }

      useWorkflowStore.getState().setDetectedLanguage(detectedLang);
      await compressIfNeeded();

      // ── Intent Routing ───────────────────────────────────────────────────────
      const intent = analyzeIntent(transcribedText);
      console.log(`[VoiceSession] Intent: ${intent.category} — ${intent.reason}`);

      // IGNORE: filler / meta speech — restart listening
      if (intent.category === 'ignore') {
        isProcessing.current = false;
        startRecording();
        return;
      }

      // CONTROL: direct store actions — no LLM needed
      if (intent.category === 'control') {
        const st = useWorkflowStore.getState();
        if (intent.controlAction === 'next') {
          if (st.workflowState === 'INTERACTIVE_GUIDE' && st.interactiveTask) {
            const nextStep = st.interactiveTaskStep + 1;
            if (nextStep >= st.interactiveTask.steps.length) {
              st.setWorkflowState('COMPLETED');
              enqueueTTS("Task completed successfully.");
            } else {
              st.setInteractiveTaskStep(nextStep);
              enqueueTTS("Okay, moving to the next step.");
            }
          } else {
            st.nextStep();
            const nextId = st.guideSteps[st.activeStepIndex + 1]?.id;
            if (nextId) st.setStepInProgress(nextId);
            enqueueTTS('Moving to the next step.');
          }
        } else if (intent.controlAction === 'prev') {
          st.prevStep();
          enqueueTTS('Going back to the previous step.');
        } else if (intent.controlAction === 'repeat') {
          const lastAss = [...st.recentTurns].reverse().find(t => t.role === 'assistant');
          if (lastAss) enqueueTTS(lastAss.content);
        }
        isProcessing.current = false;
        startRecording();
        return;
      }

      // VERIFY: user says "done", advance the interactive guide if active
      if (intent.category === 'verify') {
        const st = useWorkflowStore.getState();
        if (st.workflowState === 'INTERACTIVE_GUIDE' && st.interactiveTask) {
          const nextStep = st.interactiveTaskStep + 1;
          if (nextStep >= st.interactiveTask.steps.length) {
            st.setWorkflowState('COMPLETED');
            enqueueTTS("Great. Task completed successfully.");
          } else {
            st.setInteractiveTaskStep(nextStep);
            enqueueTTS("Got it. Let's move to the next step.");
          }
          isProcessing.current = false;
          startRecording();
          return;
        }
        // If not in interactive guide, fall through to chat to evaluate the scene
      }

      let effectiveCategory = intent.category;
      let effectiveText = transcribedText;

      const st = useWorkflowStore.getState();
      if (st.workflowState === 'INTERACTIVE_GUIDE' && effectiveCategory === 'chat') {
        effectiveCategory = 'plan_task';
        effectiveText = `I am currently doing the task: ${st.interactiveTask?.task_name}. I am stuck on step: "${st.interactiveTask?.steps[st.interactiveTaskStep]?.instruction}". User just said: "${transcribedText}". Re-plan the remaining steps based on this new constraint/clarification.`;
      }

      // PLAN TASK: Start Interactive Visual Guidance
      if (effectiveCategory === 'plan_task') {
        try {
          useWorkflowStore.getState().setVoicePhase('VLM_RUNNING');
          enqueueTTS("Okay, let me adjust the plan.");
          const res = await fetch(`${BACKEND_URL}/plan-interactive-task`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              user_request: effectiveText,
              device_context: { device: useWorkflowStore.getState().deviceName }
            })
          });
          const plan = await res.json();
          if (plan && plan.steps && plan.steps.length > 0) {
            const planSt = useWorkflowStore.getState();
            planSt.setInteractiveTask(plan);
            planSt.setInteractiveTaskStep(0);
            planSt.setWorkflowState('INTERACTIVE_GUIDE');
            enqueueTTS(plan.steps[0].instruction || "Let's get started.");
          } else {
            enqueueTTS("I couldn't plan that task. Please try asking again.");
          }
        } catch (e) {
          console.error('[VoiceSession] Task Planning failed:', e);
          enqueueTTS("I had trouble planning that task.");
        }
        isProcessing.current = false;
        startRecording();
        return;
      }

      // 2. Stream chat — speaks sentence-by-sentence as they arrive for minimum latency
      useWorkflowStore.getState().appendRecentTurn('user', transcribedText);
      console.log('[VoiceSession] Fetching stream-chat...');
      await streamChatResponse(transcribedText, detectedLang);

    } catch (err) {
      console.error('[VoiceSession] Processing error:', err);
      enqueueTTS("I encountered an error. Let me try again.");
    } finally {
      isProcessing.current = false;
      // Safety net: if TTS finished before the stream closed, the onDone callback
      // wouldn't have restarted the recorder (guarded by isProcessing). Restart it now.
      if (sessionActiveRef.current && !isSpeakingQueue.current && ttsQueue.current.length === 0) {
        if (voicePhaseRef.current !== 'LISTENING') {
          console.log('[VoiceSession] Safety-net: TTS already done, restarting recorder from finally.');
          useWorkflowStore.getState().setVoicePhase('LISTENING');
          voicePhaseRef.current = 'LISTENING';
          startRecording();
        }
      }
    }
  };

  // ── Transcription ─────────────────────────────────────────────────────────
  const attemptTranscription = async (uri: string, retries = 1): Promise<{ text: string; language: string }> => {
    for (let i = 0; i <= retries; i++) {
      try {
        const formData = new FormData();
        const fileUri = Platform.OS === 'ios' && !uri.startsWith('file://') ? `file://${uri}` : uri;
        const suffix  = uri.split('.').pop()?.split('?')[0] || 'm4a';
        formData.append('file', { uri: fileUri, name: `audio.${suffix}`, type: `audio/${suffix === 'mp4' ? 'mp4' : 'm4a'}` } as any);

        console.log(`[VoiceSession] /transcribe attempt ${i + 1}`);
        const res = await fetch(`${BACKEND_URL}/transcribe`, { method: 'POST', body: formData });
        console.log(`[VoiceSession] /transcribe status: ${res.status}`);
        if (!res.ok) { const b = await res.text(); throw new Error(`HTTP ${res.status}: ${b}`); }
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        return { text: data.text || '', language: data.language || 'en' };
      } catch (err) {
        console.warn(`[VoiceSession] Transcription attempt ${i + 1} failed:`, err);
        if (i === retries) throw err;
      }
    }
    throw new Error('Retries exhausted');
  };

  // ── Non-streaming wrapper over /stream-chat (Temporary for debugging) ──────
  // Uses the same smart tool-calling backend but collects the full response
  // before speaking, eliminating the XHR streaming race condition.
  const fetchChatResponse = async (userText: string, lang: string): Promise<void> => {
    const { sceneSummary, recentTurns, lastCapturedImageB64, sceneId, deviceName } =
      useWorkflowStore.getState();

    const body: any = {
      user_message: userText,
      scene_id: sceneId,
      scene_summary: sceneSummary,
      recent_turns: recentTurns,
      detected_language: lang,
      device_context: {
        device: deviceName,
        task_progress: useWorkflowStore.getState().getTaskSummaryText(),
      },
    };
    if (lastCapturedImageB64) body.full_frame_b64 = lastCapturedImageB64;

    try {
      console.log('[VoiceSession] Fetching /stream-chat (non-streaming consume)...');
      
      // We still need tool_call handling for inspect_current_scene.
      // Use XHR but resolve only after readyState 4, collecting all events.
      const result = await new Promise<{ sentences: string[]; toolCallId: string | null }>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${BACKEND_URL}/stream-chat`);
        xhr.setRequestHeader('Content-Type', 'application/json');

        let seenBytes = 0;
        let buffer = '';
        const sentences: string[] = [];
        let pendingToolCallId: string | null = null;

        xhr.onreadystatechange = () => {
          if (xhr.readyState === 3 || xhr.readyState === 4) {
            const newData = xhr.responseText.substring(seenBytes);
            seenBytes = xhr.responseText.length;
            buffer += newData;
            const lines = buffer.split('\n\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;
              const raw = line.slice(6).trim();
              if (raw === '[DONE]') continue;
              try {
                const data = JSON.parse(raw);
                if (data.type === 'sentence') {
                  sentences.push(data.text);
                } else if (data.type === 'tool_call' && data.name === 'inspect_current_scene') {
                  pendingToolCallId = data.tool_call_id;
                  // Immediately handle the tool call — take a snapshot and upload
                  const cameraRef = useWorkflowStore.getState().cameraRef;
                  if (cameraRef) {
                    console.log('[VoiceSession] Tool call received — taking snapshot...');
                    useWorkflowStore.getState().setVoicePhase('VLM_RUNNING');
                    cameraRef.takePhoto({ flash: 'off', enableShutterSound: false })
                      .then((photo: any) => fetch(`file://${photo.path}`))
                      .then((res: Response) => res.blob())
                      .then((blob: Blob) => new Promise<string>((res, rej) => {
                        const reader = new FileReader();
                        reader.onloadend = () => res((reader.result as string).split(',')[1]);
                        reader.onerror = rej;
                        reader.readAsDataURL(blob);
                      }))
                      .then((b64: string) => {
                        console.log(`[VoiceSession] Uploading tool frame: ${data.tool_call_id}`);
                        return fetch(`${BACKEND_URL}/submit-tool-frame`, {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ tool_call_id: data.tool_call_id, frame_b64: b64 })
                        });
                      })
                      .catch((err: any) => console.warn('[VoiceSession] Tool frame failed:', err));
                  }
                } else if (data.type === 'ar_context' && data.highlight_target) {
                  useARTrackingStore.getState().setChatFocusTarget(data.highlight_target);
                } else if (data.type === 'error') {
                  console.error('[VoiceSession] SSE error:', data.message);
                }
              } catch (e) {
                console.warn('[VoiceSession] Parse error:', raw.substring(0, 60));
              }
            }
          }
          if (xhr.readyState === 4) {
            if (xhr.status >= 200 && xhr.status < 300) {
              resolve({ sentences, toolCallId: pendingToolCallId });
            } else {
              reject(new Error(`HTTP ${xhr.status}`));
            }
          }
        };

        xhr.onerror = () => reject(new Error('Network error'));
        xhr.send(JSON.stringify(body));
      });

      if (!sessionActiveRef.current) return;

      // Now speak the full reply at once
      const fullReply = result.sentences.join(' ');
      if (fullReply.trim()) {
        console.log(`[VoiceSession] Full reply collected: "${fullReply.substring(0, 80)}..."`);
        useWorkflowStore.getState().appendRecentTurn('assistant', fullReply.trim());
        enqueueTTS(fullReply);
      } else {
        console.warn('[VoiceSession] Empty reply from backend.');
      }
    } catch (e) {
      console.error('[VoiceSession] Fetch chat error:', e);
      enqueueTTS("I lost connection. Please check your network.");
    }
  };

  // ── SSE stream chat ───────────────────────────────────────────────────────
  const streamChatResponse = (userText: string, lang: string): Promise<void> => {
    return new Promise((resolve, reject) => {
      const { sceneSummary, recentTurns, lastCapturedImageB64, sceneId, deviceName } =
        useWorkflowStore.getState();

      const xhr = new XMLHttpRequest();
      activeXhrRef.current = xhr; // register so manualStop can abort mid-flight
      xhr.open('POST', `${BACKEND_URL}/stream-chat`);
      xhr.setRequestHeader('Content-Type', 'application/json');

      let seenBytes          = 0;
      let buffer             = '';
      let fullAssistantReply = '';

      xhr.onreadystatechange = () => {
        if (xhr.readyState === 3 || xhr.readyState === 4) {
          const newData = xhr.responseText.substring(seenBytes);
          seenBytes = xhr.responseText.length;
          buffer += newData;
          const lines = buffer.split('\n\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const raw = line.slice(6).trim();
            if (raw === '[DONE]') {
              console.log('[VoiceSession] Stream [DONE] received. Resolving early.');
              activeXhrRef.current = null;
              if (fullAssistantReply.trim()) {
                useWorkflowStore.getState().appendRecentTurn('assistant', fullAssistantReply.trim());
              }
              resolve();
              return;
            }
            try {
              if (!sessionActiveRef.current) {
                xhr.abort();
                return;
              }
              const data = JSON.parse(raw);
              if (data.type === 'error') {
                console.error('[VoiceSession] SSE error:', data.message);
                enqueueTTS("The server had an issue. Please try again.");
              } else if (data.type === 'sentence') {
                isToolRunningRef.current = false;
                enqueueTTS(data.text);
                fullAssistantReply += data.text + ' ';
              } else if (data.type === 'ar_context' && data.highlight_target) {
                useARTrackingStore.getState().setChatFocusTarget(data.highlight_target);
                // Ground any VLM-returned label coordinates as 3D anchors
                if (Array.isArray(data.labels) && data.labels.length > 0) {
                  groundLabels(data.labels).catch((e: any) =>
                    console.warn('[VoiceSession] AR grounding failed (non-fatal):', e)
                  );
                }
              } else if (data.type === 'tool_call') {
                isToolRunningRef.current = true;
                if (data.ack_text) {
                  enqueueTTS(data.ack_text);
                  useWorkflowStore.getState().setVoicePhase('VLM_RUNNING');
                }
                if (data.name === 'inspect_current_scene') {
                  const cameraRef = useWorkflowStore.getState().cameraRef;
                  if (cameraRef) {
                    console.log(`[VoiceSession] Tool invoked. Taking zero-delay snapshot...`);
                    cameraRef.takePhoto({ flash: 'off', enableShutterSound: false })
                      .then((photo: any) => fetch(`file://${photo.path}`))
                      .then((res: Response) => res.blob())
                      .then((blob: Blob) => new Promise<string>((resolve, reject) => {
                         const reader = new FileReader();
                         reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
                         reader.onerror = reject;
                         reader.readAsDataURL(blob);
                      }))
                      .then((b64: string) => {
                        console.log(`[VoiceSession] Uploading lazy frame for tool_call_id: ${data.tool_call_id}`);
                        return fetch(`${BACKEND_URL}/submit-tool-frame`, {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({
                            tool_call_id: data.tool_call_id,
                            frame_b64: b64,
                          })
                        });
                      })
                      .catch((err: any) => console.warn('[VoiceSession] Tool frame capture/upload failed:', err));
                  } else {
                    console.warn('[VoiceSession] No camera available to fulfill tool call.');
                  }
                }
              }
            } catch (e) {
              console.warn('[VoiceSession] Parse error:', raw.substring(0, 60));
            }
          }
        }

        if (xhr.readyState === 4) {
          activeXhrRef.current = null; // clear ref once the request is done
          if (fullAssistantReply.trim()) {
            useWorkflowStore.getState().appendRecentTurn('assistant', fullAssistantReply.trim());
          }
          if (xhr.status >= 200 && xhr.status < 300) { resolve(); }
          else { enqueueTTS("I lost connection. Please check your network."); reject(new Error(`HTTP ${xhr.status}`)); }
        }
      };

      xhr.onerror = () => {
        enqueueTTS("I lost connection. Please check your network.");
        reject(new Error('Network error'));
      };

      const body: any = {
        user_message: userText,
        scene_id: sceneId,
        scene_summary: sceneSummary,
        recent_turns: recentTurns,
        detected_language: lang,
        device_context: {
          device: deviceName,
          task_progress: useWorkflowStore.getState().getTaskSummaryText(),
        },
      };

      console.log('[VoiceSession] Sending summary of the images:', sceneSummary);

      if (lastCapturedImageB64) body.full_frame_b64 = lastCapturedImageB64;
      xhr.send(JSON.stringify(body));
    });
  };

  // ── VAD — Hybrid Speech Endpoint Detection ───────────────────────────────
  // recorderState.metering changes every STATE_POLL_MS while recording
  useEffect(() => {
    if (!recorderState.isRecording) return;
    if (!sessionActiveRef.current) return;

    const phase = voicePhaseRef.current;
    const level = recorderState.metering ?? -160;

    // 1. Maintain Window for Smoothing & Variance
    recentLevels.current.push(level);
    if (recentLevels.current.length > ROLLING_WINDOW_SIZE) {
      recentLevels.current.shift();
    }
    const avgLevel = recentLevels.current.reduce((a, b) => a + b, 0) / recentLevels.current.length;

    // Exposed to UI for visualizer
    setMetering(avgLevel);

    // 2. Establish initial dynamic baseline
    frameCount.current++;
    if (frameCount.current <= BASELINE_SAMPLE_FRAMES) {
      baselineNoise.current = frameCount.current === 1
        ? avgLevel
        : (baselineNoise.current * (frameCount.current - 1) + avgLevel) / frameCount.current;
      return; // Do not process speech during baseline sampling
    }

    const effectiveNoiseFloor = Math.min(baselineNoise.current, MAX_NOISE_FLOOR);

    // 3. Compute Speech Confidence Score (Hybrid VAD)
    // - Energy SNR (Signal-to-Noise Ratio)
    // Raised lower bound (8→15, 5→8) so quiet background bumps don't score anything
    const snr = avgLevel - effectiveNoiseFloor;
    let energyScore = 0;
    if (snr > 15) energyScore = 1.0;
    else if (snr > 8) energyScore = (snr - 8) / 7;

    // - Variance (Burstiness - speech fluctuates rapidly, noise is constant)
    // Raised lower bound (1.2→2.0) so steady ambient hum doesn't contribute variance score
    const variance = recentLevels.current.reduce((sum, val) => sum + Math.pow(val - avgLevel, 2), 0) / recentLevels.current.length;
    const stdDev = Math.sqrt(variance);
    let varianceScore = 0;
    if (stdDev > 4.5) varianceScore = 1.0;
    else if (stdDev > 2.0) varianceScore = (stdDev - 2.0) / 2.5;

    // Combined score — energy weighted slightly higher to require real volume, not just noise variance
    const speechConfidence = (energyScore * 0.65) + (varianceScore * 0.35);

    // 4. Continuously update noise floor if definitely not speaking
    // This allows the threshold to adapt if a fan turns on or the environment changes
    if (speechConfidence < 0.2) {
      baselineNoise.current = (baselineNoise.current * 0.98) + (level * 0.02);
    }

    // Barge-in during AI speaking — uses a HIGHER threshold so the AI's own voice
    // or nearby sounds don't accidentally trigger an interrupt
    if (phase === 'ANSWERING') {
      if (speechConfidence > BARGE_IN_CONFIDENCE_THRESHOLD) {
        console.log(`[VAD] Barge-in detected! Confidence: ${speechConfidence.toFixed(2)}`);
        // Immediately flip the phase ref so the NEXT VAD tick (100ms later) does NOT
        // re-enter this branch and fire a second concurrent startRecording() call.
        voicePhaseRef.current = 'LISTENING';
        clearTTSQueue();
        startRecording();
      }
      return;
    }

    if (phase !== 'LISTENING') return;
    if (isProcessing.current) return;

    if (speechConfidence > SPEECH_CONFIDENCE_THRESHOLD) {
      // Active speech
      hasSpoken.current       = true;
      silenceTimer.current    = 0;
      inactivityTimer.current = 0;
    } else {
      // Silence or Background Noise
      silenceTimer.current    += STATE_POLL_MS;
      inactivityTimer.current += STATE_POLL_MS;

      if (hasSpoken.current && silenceTimer.current >= SILENCE_DURATION_MS) {
        console.log(`[VAD] End-of-utterance detected. Speech ended.`);
        stopRecordingAndProcess(false);
      } else if (!hasSpoken.current && inactivityTimer.current >= INACTIVITY_DURATION_MS) {
        console.log('[VAD] Inactivity timeout — ending session.');
        useWorkflowStore.getState().endVoiceSession();
      }
    }
  }, [recorderState.metering, recorderState.durationMillis]);

  // ── Start recording when session activates ────────────────────────────────
  useEffect(() => {
    if (store.voiceSessionActive) {
      startRecording();
    } else {
      // Cleanup on session end
      if (audioRecorder.isRecording) audioRecorder.stop().catch(() => {});
      clearTTSQueue();
      hasSpoken.current    = false;
      isProcessing.current = false;
      // Clear AR labels when voice session ends
      clearARLabels().catch(() => {});
    }
  }, [store.voiceSessionActive]);


  // ── Manual stop (wired to Stop button) ───────────────────────────────────
  const manualStop = () => {
    const phase = voicePhaseRef.current;
    console.log('[VoiceSession] Manual stop pressed. phase:', phase, 'isProcessing:', isProcessing.current);

    if (phase === 'ANSWERING') {
      // AI is speaking — stop TTS and go straight back to listening
      clearTTSQueue();
      useWorkflowStore.getState().setVoicePhase('LISTENING');
      voicePhaseRef.current = 'LISTENING';
      startRecording();

    } else if (phase === 'THINKING' || phase === 'VLM_RUNNING') {
      // Backend is mid-flight — abort the XHR, release the lock, restart
      console.log('[VoiceSession] Aborting in-flight XHR (phase:', phase, ')');
      if (activeXhrRef.current) {
        activeXhrRef.current.abort();
        activeXhrRef.current = null;
      }
      clearTTSQueue();
      isProcessing.current = false;
      useWorkflowStore.getState().setVoicePhase('LISTENING');
      voicePhaseRef.current = 'LISTENING';
      startRecording();

    } else if (phase === 'LISTENING') {
      // User is listening — force-submit whatever was recorded so far
      isProcessing.current = false;
      stopRecordingAndProcess(true);
    }
  };

  return { metering, manualStop };
};

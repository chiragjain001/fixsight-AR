import { useEffect, useRef } from 'react';
import { useWorkflowStore } from '../store/workflowStore';
import { useARTrackingStore } from '../store/arTrackingStore';
import { BACKEND_URL } from '../src/config';
import * as Speech from 'expo-speech';

export const useInteractiveGuideLoop = () => {
  const workflowState = useWorkflowStore(s => s.workflowState);
  const interactiveTask = useWorkflowStore(s => s.interactiveTask);
  const loopActive = useRef(false);
  const isEvaluating = useRef(false);
  const lastSpokenInstruction = useRef<string | null>(null);

  useEffect(() => {
    if (workflowState !== 'INTERACTIVE_GUIDE' || !interactiveTask) {
      loopActive.current = false;
      return;
    }

    loopActive.current = true;

    // Speak the first instruction immediately — don't wait for the first VLM round-trip.
    const { interactiveTaskStep } = useWorkflowStore.getState();
    const firstStep = interactiveTask.steps[interactiveTaskStep];
    if (firstStep?.instruction && lastSpokenInstruction.current !== firstStep.instruction) {
      Speech.speak(firstStep.instruction);
      lastSpokenInstruction.current = firstStep.instruction;
    }

    const evaluateStep = async () => {
      if (!loopActive.current || isEvaluating.current) return;
      isEvaluating.current = true;

      try {
        const { cameraRef, interactiveTask, interactiveTaskStep, deviceName } = useWorkflowStore.getState();
        if (!cameraRef || !interactiveTask || interactiveTaskStep >= interactiveTask.steps.length) {
          isEvaluating.current = false;
          return;
        }

        const currentStep = interactiveTask.steps[interactiveTaskStep];

        // Take photo and encode to base64.
        const photo = await cameraRef.takePhoto({ flash: 'off', enableShutterSound: false });
        let b64: string = photo.base64 || '';

        if (!b64) {
          const resPhoto = await fetch(`file://${photo.path}`);
          const blob = await resPhoto.blob();
          b64 = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });
        }

        // Send to evaluate-interactive-step.
        const res = await fetch(`${BACKEND_URL}/evaluate-interactive-step`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            image_b64: b64,
            task_state: {
              task_name: interactiveTask.task_name,
              current_step: interactiveTaskStep,
              ...currentStep,
            },
            device_context: { device: deviceName },
          }),
        });

        const data = await res.json();

        // Single confirmation is enough — double-confirmation was adding 2.5+ seconds
        // of unnecessary delay per step.
        if (data.success_condition_met || data.object_found) {
          // Advance step.
          const state = useWorkflowStore.getState();
          const nextStep = state.interactiveTaskStep + 1;
          if (nextStep >= interactiveTask.steps.length) {
            Speech.speak("Task completed successfully.");
            state.setWorkflowState('COMPLETED');
          } else {
            Speech.speak("Got it. Moving to next step.");
            state.setInteractiveTaskStep(nextStep);
            lastSpokenInstruction.current = null;
          }
          useARTrackingStore.getState().clear();
        } else {
          // Object not found yet — speak the instruction if not spoken, show bounding box.
          if (lastSpokenInstruction.current !== currentStep.instruction) {
            Speech.speak(currentStep.instruction);
            lastSpokenInstruction.current = currentStep.instruction;
          }

          if (data.bounding_box_target) {
            useARTrackingStore.getState().initFromVLM([{
              id: 'interactive_target',
              hazard_ref: 'interactive',
              label: currentStep.required_objects?.join(', ') ?? '',
              type: 'neutral_context',
              marker_type: 'box',
              priority: 1,
              risk_level: 'LOW',
              box_2d: data.bounding_box_target,
            } as any]);
          } else if (data.camera_guidance) {
            Speech.speak(data.camera_guidance);
            useARTrackingStore.getState().clear();
          }
        }

      } catch (e) {
        console.error('[InteractiveGuideLoop] Error:', e);
      } finally {
        isEvaluating.current = false;
        // 1.2s between checks — fast enough to feel live, not so fast it hammers the API.
        if (loopActive.current) {
          setTimeout(evaluateStep, 1200);
        }
      }
    };

    evaluateStep();

    return () => {
      loopActive.current = false;
    };
  }, [workflowState, interactiveTask]);
};

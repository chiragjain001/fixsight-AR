import { create } from 'zustand';
import type { Hazard, SceneHazard, SpatialTarget, RiskLevel, ActionStep } from '../src/types';
import { BACKEND_URL } from '../src/config';
import { useARTrackingStore } from './arTrackingStore';
import * as Speech from 'expo-speech';

export type WorkflowState =
  | 'READY'
  | 'SCANNING'
  | 'IDENTIFIED'
  | 'MODE_SELECTION'
  | 'EXPLORE_LABELS'
  | 'VOICE_ACTIVE'
  | 'VOICE_SPEAKING'
  | 'GUIDE_MODE'
  | 'INTERACTIVE_GUIDE'
  | 'COMPLETED'
  | 'VOICE_SESSION_COMPLETED';

export type FacingMode = 'back' | 'front';
export type ActiveModeType = 'troubleshoot' | 'guide' | 'explain' | null;

export interface ComponentInfo {
  id: string;
  label: string;
  description: string;
  status: string;
  statusType: 'success' | 'warning' | 'error';
  box_2d: [number, number, number, number];
}

export interface GuideStep {
  id: string;
  stepNumber: number;
  title: string;
  description: string;
  componentId: string;
}

// ── Task Progress (Action Graph) ──────────────────────────────────────────────
// A structured, deterministic record of the user's repair progress.
// Built from GuideSteps when guide mode starts. Updated as verify confirms steps.
export interface TaskStep {
  id: string;
  stepNumber: number;
  title: string;
  description: string;
  componentId: string;
  status: 'pending' | 'in_progress' | 'completed' | 'skipped';
  completedAt?: number;
}

export const MOCK_COMPONENTS: ComponentInfo[] = [
  {
    id: 'motor_body',
    label: 'Motor Body',
    description: 'Protects internal rotor and stator. Dissipates heat through cooling ribs.',
    status: 'Operational',
    statusType: 'success',
    box_2d: [0.38, 0.32, 0.85, 0.74],
  },
  {
    id: 'cooling_fan',
    label: 'Cooling Fan',
    description: 'Helps in heat dissipation and keeps the motor cool during operation. Check for dust buildup or damage.',
    status: 'Clean',
    statusType: 'success',
    box_2d: [0.65, 0.25, 0.94, 0.58],
  },
  {
    id: 'terminal_box',
    label: 'Terminal Box',
    description: 'Houses electrical connections and wiring. Ensure the cover is secure and there are no loose or damaged wires.',
    status: 'Looks Good',
    statusType: 'success',
    box_2d: [0.15, 0.22, 0.48, 0.46],
  },
  {
    id: 'shaft',
    label: 'Shaft',
    description: 'Transmits mechanical power to connected equipment. Ensure it rotates smoothly without excess vibration.',
    status: 'Aligned',
    statusType: 'success',
    box_2d: [0.05, 0.62, 0.22, 0.78],
  },
];

export const MOCK_GUIDE_STEPS: GuideStep[] = [
  {
    id: 'step_1',
    stepNumber: 1,
    title: 'De-energize Motor Panel',
    description: 'Disconnect power source from the main switchboard and apply Lockout/Tagout (LOTO) procedures.',
    componentId: 'terminal_box',
  },
  {
    id: 'step_2',
    stepNumber: 2,
    title: 'Clean the Cooling Fan',
    description: 'Remove dust or debris from the fan cover and blades for proper airflow and cooling.',
    componentId: 'cooling_fan',
  },
  {
    id: 'step_3',
    stepNumber: 3,
    title: 'Inspect Terminal Box Wiring',
    description: 'Open the cover and inspect wiring for any loose connections or thermal damage.',
    componentId: 'terminal_box',
  },
  {
    id: 'step_4',
    stepNumber: 4,
    title: 'Perform Rotation Test',
    description: 'Turn the shaft manually to verify it moves freely without resistance or grinding noise.',
    componentId: 'shaft',
  },
];

export interface WorkflowStore {
  workflowState: WorkflowState;
  manualScanTick: number;

  // New state machine values
  scanningProgress: number;
  activeMode: ActiveModeType;
  deviceName: string;
  deviceConfidence: number;
  deviceDescription: string;
  lastCapturedImageB64: string | null;
  sceneId: string | null;
  sceneVersion: number;
  taskProgress: TaskStep[];  // increments on every scene refresh or verify that changed scene
  
  components: ComponentInfo[];
  activeComponentIndex: number;

  likelyIssue: string;
  relatedParts: string[];
  troubleshootSummary: string;
  troubleshootCauses: string[];
  troubleshootActions: string[];

  guideSteps: GuideStep[];
  activeStepIndex: number;

  // Interactive Task
  interactiveTask: any | null;
  interactiveTaskStep: number;
  setInteractiveTask: (task: any | null) => void;
  setInteractiveTaskStep: (step: number) => void;

  // Continuous Voice Assistant variables
  voiceSessionActive: boolean;
  voicePhase: 'LISTENING' | 'ANALYZING' | 'THINKING' | 'VLM_RUNNING' | 'ANSWERING' | 'IDLE';
  conversationSummary: string;
  recentTurns: { role: 'user' | 'assistant'; content: string }[];
  sceneSummary: any;
  detectedLanguage: string;
  sessionStats: {
    durationMs: number;
    questionsAsked: number;
    warningsGenerated: number;
    startTime: number | null;
  };

  // Legacy Voice Assistant variables (kept for compat during transition)
  voiceInputText: string;
  voiceResponseText: string;
  voiceSolutions: string[];

  // Legacy compat fields
  allSceneHazards: SceneHazard[];
  selectedHazardId: string | null;
  detectedHazards: Hazard[];
  selectedHazard: Hazard | null;
  completedStepIds: Set<string>;
  activeStepId: string | null;
  guidance: any | null;
  spatialTargets: SpatialTarget[];
  generalSolutions: string[];

  // Camera
  cameraRef: any | null;
  facing: FacingMode;
  torchEnabled: boolean;
  isLandscape: boolean;

  // Sheet snap tracking
  sheetSnapIndex: number;

  // Actions
  setCameraRef: (ref: any | null) => void;
  triggerManualScan: () => void;
  startScanningSim: () => void;
  runRealScan: () => Promise<void>;
  setScanningProgress: (prog: number) => void;
  setWorkflowState: (state: WorkflowState) => void;
  confirmDevice: (confirmed: boolean) => void;
  selectMode: (mode: ActiveModeType) => void;
  setActiveComponentIndex: (index: number) => void;
  setActiveStepIndex: (index: number) => void;
  setVoiceActiveState: (active: boolean) => void;
  setVoiceSpeakingState: (text: string, solutions?: string[]) => void;

  // New Voice Assistant Actions
  startVoiceSession: () => void;
  endVoiceSession: () => void;
  setVoicePhase: (phase: WorkflowStore['voicePhase']) => void;
  appendRecentTurn: (role: 'user' | 'assistant', content: string) => void;
  setDetectedLanguage: (lang: string) => void;
  updateSessionStats: (updates: Partial<WorkflowStore['sessionStats']>) => void;
  setConversationSummary: (summary: string) => void;
  setSceneSummary: (summary: any) => void;
  bumpSceneVersion: () => void;

  // Task Progress (Action Graph)
  initTaskProgress: (steps: GuideStep[]) => void;
  markTaskStepCompleted: (stepId: string) => void;
  setStepInProgress: (stepId: string) => void;
  getTaskSummaryText: () => string;

  nextComponent: () => void;
  prevComponent: () => void;
  nextStep: () => void;
  prevStep: () => void;

  // Backward compatibility actions
  startAnalysis: () => void;
  onHazardsDiscovered: (sceneHazards: SceneHazard[], defaultSelectedId?: string | null) => void;
  selectHazardById: (id: string) => void;
  setSpatialData: (guidance: any, spatialTargets: SpatialTarget[], generalSolutions?: string[]) => void;
  focusHazard: (hazard: Hazard | null) => void;
  openSheet: () => void;

  reset: () => void;
  toggleFacing: () => void;
  toggleTorch: () => void;
  setLandscape: (v: boolean) => void;
  setSheetSnapIndex: (i: number) => void;
}

export const useWorkflowStore = create<WorkflowStore>((set, get) => ({
  workflowState: 'READY',
  manualScanTick: 0,
  scanningProgress: 0,
  activeMode: null,
  deviceName: 'AC Induction Motor',
  deviceConfidence: 94,
  deviceDescription: 'An induction motor converts electrical power into mechanical power. Used in pumps, fans, conveyors and more.',
  lastCapturedImageB64: null,
  sceneId: null,
  sceneVersion: 0,
  taskProgress: [],
  components: MOCK_COMPONENTS,
  activeComponentIndex: 0,
  likelyIssue: 'Overheating',
  relatedParts: ['cooling_fan', 'motor_body'],
  troubleshootSummary: '',
  troubleshootCauses: [],
  troubleshootActions: [],
  guideSteps: MOCK_GUIDE_STEPS,
  activeStepIndex: 0,
  
  interactiveTask: null,
  interactiveTaskStep: 0,
  
  setInteractiveTask: (task) => set({ interactiveTask: task }),
  setInteractiveTaskStep: (step) => set({ interactiveTaskStep: step }),

  voiceSessionActive: false,
  voicePhase: 'IDLE',
  conversationSummary: '',
  recentTurns: [],
  sceneSummary: null,
  detectedLanguage: 'en',
  sessionStats: {
    durationMs: 0,
    questionsAsked: 0,
    warningsGenerated: 0,
    startTime: null,
  },

  voiceInputText: 'How can I help you?',
  voiceResponseText: 'The motor is running hot. Possible causes could be overloading, poor ventilation, or a dirty cooling fan.',
  voiceSolutions: [
    'Check the load on the motor',
    'Clean the cooling fan and vents',
    'Ensure proper airflow'
  ],

  // Legacy fields
  allSceneHazards: [],
  selectedHazardId: null,
  detectedHazards: [],
  selectedHazard: null,
  completedStepIds: new Set(),
  activeStepId: null,
  guidance: null,
  spatialTargets: [],
  generalSolutions: [],
  cameraRef: null,
  facing: 'back',
  torchEnabled: false,
  isLandscape: false,
  sheetSnapIndex: -1,

  setCameraRef: (cameraRef) => set({ cameraRef }),
  triggerManualScan: () => set((state) => ({ manualScanTick: state.manualScanTick + 1 })),

  startScanningSim: () => {
    set({ workflowState: 'SCANNING', scanningProgress: 0 });
    let current = 0;
    const interval = setInterval(() => {
      current += 5;
      if (current >= 100) {
        clearInterval(interval);
        set({ workflowState: 'IDENTIFIED', scanningProgress: 100 });
      } else {
        set({ scanningProgress: current });
      }
    }, 100);
  },

  runRealScan: async () => {
    const { cameraRef } = get();
    if (!cameraRef) {
      alert("Camera is not ready yet!");
      return;
    }
    
    // Clear tracking offset and targets on new scan
    useARTrackingStore.getState().clear();
    set({ workflowState: 'SCANNING', scanningProgress: 0, lastCapturedImageB64: null });
    
    // Simulate premium visual progress ticks
    let progress = 0;
    const progressInterval = setInterval(() => {
      progress += 8;
      if (progress < 90) {
        set({ scanningProgress: progress });
      }
    }, 100);

    try {
      const photo = await cameraRef.takePhoto({ flash: 'off' });
      const response = await fetch(`file://${photo.path}`);
      const blob = await response.blob();
      
      const reader = new FileReader();
      reader.onloadend = async () => {
        const b64 = (reader.result as string).split(',')[1];
        
        try {
          const scanRes = await fetch(`${BACKEND_URL}/scan-scene`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image_b64: b64, device_context: { lighting: 'normal' } })
          });
          
          if (!scanRes.ok) throw new Error('Scan API request failed');
          const scanData = await scanRes.json();
          
          const detectedDevice = scanData.device || 'Unknown Device';
          const detectedConfidence = Math.round((scanData.confidence || 0.5) * 100);
          const detectedSummary = scanData.summary || '';
          const newSceneId = scanData.scene_id || null;
          
          if (scanData.components && scanData.components.length > 0) {
            const mappedComponents = scanData.components.map((c: any) => ({
              id: c.id,
              label: c.name || c.label,
              description: c.description || '',
              status: c.status || 'Detected',
              statusType: c.statusType || 'success',
              box_2d: c.box_2d || c.bbox || [0,0,0,0],
            }));
            
            set({ components: mappedComponents });
            
            const spatialTargets = scanData.components.map((c: any) => ({
              id: c.id,
              hazard_ref: 'haz_motor',
              label: c.name || c.label,
              type: c.importance === 1 ? 'primary_hazard' : 'neutral_context',
              marker_type: 'ring',
              step_reference: null,
              depth_hint: 0.5,
              priority: 1,
              risk_level: 'LOW',
              box_2d: c.box_2d || c.bbox || [0,0,0,0],
            }));
            useARTrackingStore.getState().initFromVLM(spatialTargets);
          }
          
          // Build sceneSummary so the voice assistant has immediate context
          // without re-scanning when the user opens voice right after a scan.
          const newSceneSummary = {
            device: detectedDevice,
            confidence: detectedConfidence / 100,
            currentState: detectedSummary,
            warnings: [],
            components: (scanData.components || []).map((c: any) => c.name || c.label).filter(Boolean),
          };

          clearInterval(progressInterval);
          set({
            workflowState: 'IDENTIFIED',
            scanningProgress: 100,
            deviceName: detectedDevice,
            deviceConfidence: detectedConfidence,
            deviceDescription: detectedSummary,
            lastCapturedImageB64: b64,
            sceneId: newSceneId,
            sceneSummary: newSceneSummary,
          });
          
        } catch (apiError) {
          console.error('[Scan] API failed:', apiError);
          clearInterval(progressInterval);
          set({ workflowState: 'READY', scanningProgress: 0 });
          alert("Identification failed. Please ensure the backend is running and online.");
        }
      };
      reader.readAsDataURL(blob);
      
    } catch (e) {
      console.error('[Scan] Photo capture failed:', e);
      clearInterval(progressInterval);
      set({ workflowState: 'READY', scanningProgress: 0 });
      alert("Failed to capture image.");
    }
  },

  setScanningProgress: (scanningProgress) => set({ scanningProgress }),
  setWorkflowState: (workflowState) => {
    Speech.stop();
    set({ workflowState });
  },

  confirmDevice: (confirmed) => {
    Speech.stop();
    if (confirmed) {
      set({ workflowState: 'MODE_SELECTION' });
    } else {
      const { runRealScan } = get();
      runRealScan();
    }
  },

  selectMode: async (activeMode) => {
    Speech.stop();
    if (activeMode === 'explain') {
      set({ activeMode, workflowState: 'EXPLORE_LABELS', activeComponentIndex: 0 });
    } else if (activeMode === 'guide') {
      const { lastCapturedImageB64, sceneId, deviceName, components, activeComponentIndex } = get();
      
      set({ activeMode, workflowState: 'SCANNING', scanningProgress: 30 });
      
      try {
        const res = await fetch(`${BACKEND_URL}/mode/guide`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            image_b64: sceneId ? null : lastCapturedImageB64,
            scene_id: sceneId,
            device: deviceName,
            component_id: components[activeComponentIndex]?.id || null,
            device_context: {}
          })
        });
        
        if (!res.ok) throw new Error('Guide API failed');
        const data = await res.json();
        
        if (data.steps && data.steps.length > 0) {
          const mappedSteps = data.steps.map((step: any, idx: number) => ({
            id: step.id || `step_${idx + 1}`,
            stepNumber: step.stepNumber || (idx + 1),
            title: step.title || '',
            description: step.instruction || step.description || '',
            componentId: step.componentId || step.target || ''
          }));
          set({ guideSteps: mappedSteps });
          // Initialise Action Graph from loaded steps
          get().initTaskProgress(mappedSteps);
          if (mappedSteps.length > 0) get().setStepInProgress(mappedSteps[0].id);
        }
        
        set({ workflowState: 'GUIDE_MODE', activeStepIndex: 0 });
      } catch (error) {
        console.error('[Guide] API failed:', error);
        alert("Failed to load guided procedure. Using cached/mock steps instead.");
        set({ workflowState: 'GUIDE_MODE', activeStepIndex: 0 });
      }
      
    } else if (activeMode === 'troubleshoot') {
      const { lastCapturedImageB64, sceneId, deviceName, components, activeComponentIndex, likelyIssue } = get();
      
      set({ activeMode, workflowState: 'SCANNING', scanningProgress: 30 });
      
      try {
        const res = await fetch(`${BACKEND_URL}/mode/troubleshoot`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            image_b64: sceneId ? null : lastCapturedImageB64,
            scene_id: sceneId,
            device: deviceName,
            component_id: components[activeComponentIndex]?.id || null,
            issue: likelyIssue || 'general troubleshooting',
            device_context: {}
          })
        });
        
        if (!res.ok) throw new Error('Troubleshoot API failed');
        const data = await res.json();
        
        const returnedRelated = data.related_components || data.ar_targets || [];
        const returnedIssue = data.issue || likelyIssue;
        const returnedSummary = data.summary || '';
        const returnedCauses = data.possible_causes || [];
        const returnedActions = data.actions || [];
        
        set({
          likelyIssue: returnedIssue,
          relatedParts: returnedRelated,
          troubleshootSummary: returnedSummary,
          troubleshootCauses: returnedCauses,
          troubleshootActions: returnedActions,
        });
        
        const firstRelatedIdx = components.findIndex(c => returnedRelated.includes(c.id));
        set({
          workflowState: 'EXPLORE_LABELS',
          activeComponentIndex: firstRelatedIdx !== -1 ? firstRelatedIdx : 0
        });
      } catch (error) {
        console.error('[Troubleshoot] API failed:', error);
        alert("Failed to load troubleshooting steps. Using cached/mock components instead.");
        const firstRelatedIdx = components.findIndex(c => ['cooling_fan', 'motor_body'].includes(c.id));
        set({
          likelyIssue: 'Overheating',
          relatedParts: ['cooling_fan', 'motor_body'],
          troubleshootSummary: 'The motor has a suspected overheating issue due to bearing wear or fan blockage.',
          troubleshootCauses: ['Blocked cooling fan shroud', 'Lack of bearing lubrication'],
          troubleshootActions: ['Inspect cooling fan blades', 'Verify bearing lubrication'],
          workflowState: 'EXPLORE_LABELS',
          activeComponentIndex: firstRelatedIdx !== -1 ? firstRelatedIdx : 0
        });
      }
      
    } else {
      set({ activeMode: null, workflowState: 'MODE_SELECTION' });
    }
  },

  setActiveComponentIndex: (activeComponentIndex) => set({ activeComponentIndex }),
  setActiveStepIndex: (activeStepIndex) => set({ activeStepIndex }),

  setVoiceActiveState: (active) => {
    Speech.stop();
    if (active) {
      set({ workflowState: 'VOICE_ACTIVE' });
    } else {
      // Revert to previous active state
      const { activeMode } = get();
      if (activeMode === 'guide') {
        set({ workflowState: 'GUIDE_MODE' });
      } else if (get().interactiveTask) {
        set({ workflowState: 'INTERACTIVE_GUIDE' });
      } else if (activeMode === 'explain' || activeMode === 'troubleshoot') {
        set({ workflowState: 'EXPLORE_LABELS' });
      } else {
        set({ workflowState: 'MODE_SELECTION' });
      }
    }
  },

  setVoiceSpeakingState: (text, solutions = []) => {
    set({ workflowState: 'VOICE_SPEAKING', voiceResponseText: text, voiceSolutions: solutions });
  },

  startVoiceSession: () => {
    Speech.stop();
    set({
      voiceSessionActive: true,
      voicePhase: 'LISTENING',
      workflowState: 'VOICE_ACTIVE',
      sessionStats: { durationMs: 0, questionsAsked: 0, warningsGenerated: 0, startTime: Date.now() },
      recentTurns: [],
      conversationSummary: '',
    });
  },

  endVoiceSession: () => {
    Speech.stop();
    const { activeMode, sessionStats } = get();
    const finalStats = { 
      ...sessionStats, 
      durationMs: sessionStats.startTime ? Date.now() - sessionStats.startTime : 0 
    };
    set({
      voiceSessionActive: false,
      voicePhase: 'IDLE',
      workflowState: 'VOICE_SESSION_COMPLETED',
      sessionStats: finalStats
    });
  },

  setVoicePhase: (phase) => {
    set({ voicePhase: phase });
    if (phase === 'LISTENING') set({ workflowState: 'VOICE_ACTIVE' });
    else if (phase === 'ANSWERING') set({ workflowState: 'VOICE_SPEAKING' });
  },

  appendRecentTurn: (role, content) => set((state) => ({ recentTurns: [...state.recentTurns, { role, content }] })),
  setDetectedLanguage: (lang) => set({ detectedLanguage: lang }),
  updateSessionStats: (updates) => set((state) => ({ sessionStats: { ...state.sessionStats, ...updates } })),
  setConversationSummary: (summary) => set({ conversationSummary: summary }),
  setSceneSummary: (summary) => set({ sceneSummary: summary }),
  bumpSceneVersion: () => set((s) => ({ sceneVersion: s.sceneVersion + 1 })),

  // ── Task Progress (Action Graph) ─────────────────────────────────────────
  initTaskProgress: (steps) => set({
    taskProgress: steps.map(s => ({
      ...s,
      status: 'pending' as const,
      completedAt: undefined,
    })),
  }),

  markTaskStepCompleted: (stepId) => set((state) => ({
    taskProgress: state.taskProgress.map(t =>
      t.id === stepId ? { ...t, status: 'completed', completedAt: Date.now() } : t
    ),
  })),

  setStepInProgress: (stepId) => set((state) => ({
    taskProgress: state.taskProgress.map(t =>
      t.id === stepId ? { ...t, status: 'in_progress' } :
      t.status === 'in_progress' ? { ...t, status: 'pending' } : t  // demote old active
    ),
  })),

  getTaskSummaryText: (): string => {
    const { taskProgress } = get();
    if (!taskProgress.length) return 'No task progress available.';
    return taskProgress
      .map((t: TaskStep) => {
        const icon = t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▶' : '○';
        return `${icon} Step ${t.stepNumber}: ${t.title} [${t.status}]`;
      })
      .join(' | ');
  },

  nextComponent: () => {
    const { activeComponentIndex, components } = get();
    if (components.length === 0) return;
    const nextIdx = (activeComponentIndex + 1) % components.length;
    set({ activeComponentIndex: nextIdx });
  },

  prevComponent: () => {
    const { activeComponentIndex, components } = get();
    if (components.length === 0) return;
    const prevIdx = (activeComponentIndex - 1 + components.length) % components.length;
    set({ activeComponentIndex: prevIdx });
  },

  nextStep: () => {
    const { activeStepIndex, guideSteps } = get();
    if (activeStepIndex < guideSteps.length - 1) {
      set({ activeStepIndex: activeStepIndex + 1 });
    } else {
      set({ workflowState: 'COMPLETED' });
    }
  },

  prevStep: () => {
    const { activeStepIndex } = get();
    if (activeStepIndex > 0) {
      set({ activeStepIndex: activeStepIndex - 1 });
    }
  },

  // Backward compatibility actions
  startAnalysis: () => {
    set({ workflowState: 'SCANNING', scanningProgress: 0 });
  },

  onHazardsDiscovered: (sceneHazards: SceneHazard[], defaultSelectedId?: string | null) => {
    set({ allSceneHazards: sceneHazards, selectedHazardId: defaultSelectedId ?? null });
  },

  selectHazardById: (id: string) => {
    // No-op for simulated mode
  },

  setSpatialData: (guidance: any, spatialTargets: SpatialTarget[], generalSolutions: string[] = []) => {
    set({ guidance, spatialTargets, generalSolutions });
  },

  focusHazard: (hazard: Hazard | null) => {
    set({ selectedHazard: hazard });
  },

  openSheet: () => {
    set({ sheetSnapIndex: 2 });
  },

  reset: () => {
    Speech.stop();
    useARTrackingStore.getState().clear();
    set({
      workflowState: 'READY',
      scanningProgress: 0,
      activeMode: null,
      activeComponentIndex: 0,
      activeStepIndex: 0,
      lastCapturedImageB64: null,
      sceneId: null,
      sceneVersion: 0,
      taskProgress: [],
      allSceneHazards: [],
      selectedHazardId: null,
      detectedHazards: [],
      selectedHazard: null,
      completedStepIds: new Set(),
      activeStepId: null,
      interactiveTask: null,
      interactiveTaskStep: 0,
      guidance: null,
      spatialTargets: [],
      generalSolutions: [],
      troubleshootSummary: '',
      troubleshootCauses: [],
      troubleshootActions: [],
      sheetSnapIndex: -1,
      voiceSessionActive: false,
      voicePhase: 'IDLE',
      conversationSummary: '',
      recentTurns: [],
      sceneSummary: null,
      sessionStats: { durationMs: 0, questionsAsked: 0, warningsGenerated: 0, startTime: null },
    });
  },

  toggleFacing: () =>
    set((s) => ({ facing: s.facing === 'back' ? 'front' : 'back' })),

  toggleTorch: () =>
    set((s) => ({ torchEnabled: !s.torchEnabled })),

  setLandscape: (v) => set({ isLandscape: v }),

  setSheetSnapIndex: (i) => set({ sheetSnapIndex: i }),
}));


import { create } from 'zustand';
import type {
  SpatialTarget,
  ARDisclosureLevel,
  SpatialTargetType,
  MarkerType,
  RiskLevel,
} from '../src/types';
import { makeMutable, type SharedValue } from 'react-native-reanimated';

// ─── TrackedTarget ───────────────────────────────────────────────────────────
// A VLM-initialized target that is maintained by the local IoU tracker.
// AR markers read `boxSV.value` directly on the UI thread.
export interface TrackedTarget {
  id: string;                    // matches spatial_target.id
  hazard_ref: string;
  label: string;
  type: SpatialTargetType;
  marker_type: MarkerType;
  step_reference: string | null;
  depth_hint: number;
  priority: number;
  risk_level: RiskLevel;

  vlmBox: number[];              // original VLM box (normalized 0–1)
  boxSV: SharedValue<number[]>;  // UI-thread reactive value for 60fps tracking without React renders
  isLost: boolean;               // true after LOST_THRESHOLD frames without match
}

// ─── Store Interface ─────────────────────────────────────────────────────────
interface ARTrackingState {
  targets: TrackedTarget[];
  disclosureLevel: ARDisclosureLevel;
  chatFocusTargetId: string | null;

  // Actions
  initFromVLM: (spatialTargets: SpatialTarget[]) => void;
  updateTargetLostState: (id: string, isLost: boolean) => void;
  setDisclosureLevel: (level: ARDisclosureLevel) => void;
  setChatFocusTarget: (id: string | null) => void;
  clear: () => void;
}

// ─── Store ───────────────────────────────────────────────────────────────────
export const useARTrackingStore = create<ARTrackingState>((set, get) => ({
  targets: [],
  disclosureLevel: 'DETECTION',
  chatFocusTargetId: null,

  // Called once after VLM response arrives — initializes all tracked targets.
  initFromVLM: (spatialTargets) => {
    const seenIds = new Set<string>();
    const targets: TrackedTarget[] = [];
    
    (spatialTargets || []).forEach((t, index) => {
      let rawBox = t.box_2d;
      if (typeof rawBox === 'string') {
        try { rawBox = JSON.parse(rawBox); } catch (e) { rawBox = null; }
      }
      if (Array.isArray(rawBox) && Array.isArray(rawBox[0])) {
        rawBox = rawBox[0];
      }
      if (!Array.isArray(rawBox) || rawBox.length < 4) {
        rawBox = [0, 0, 0, 0];
      }

      // VLM sometimes returns 0-1000 instead of 0.0-1.0
      const box = rawBox.map((v: any) => {
        const num = Number(v) || 0;
        return num > 1 ? num / 1000 : num;
      });
      
      let targetId = t.id ? String(t.id).trim() : `tgt_${index}`;
      if (!targetId || seenIds.has(targetId)) {
        targetId = `${targetId || 'tgt'}_${index}`;
      }
      seenIds.add(targetId);

      targets.push({
        id:             targetId,
        hazard_ref:     t.hazard_ref,
        label:          t.label,
        type:           t.type,
        marker_type:    t.marker_type,
        step_reference: t.step_reference ?? null,
        depth_hint:     t.depth_hint ?? 0.5,
        priority:       t.priority,
        risk_level:     t.risk_level,
        vlmBox:         [...box],
        boxSV:          makeMutable([...box]),
        isLost:         false,
      });
    });
    set({ targets, disclosureLevel: 'DETECTION' });
  },

  updateTargetLostState: (id, isLost) => {
    set((state) => {
      const targets = state.targets.map(t => t.id === id ? { ...t, isLost } : t);
      return { targets };
    });
  },

  setDisclosureLevel: (disclosureLevel) => set({ disclosureLevel }),
  setChatFocusTarget: (chatFocusTargetId) => set({ chatFocusTargetId }),
  clear: () => {
    arOffsetX.value = 0;
    arOffsetY.value = 0;
    set({ targets: [], disclosureLevel: 'DETECTION', chatFocusTargetId: null });
  },
}));

export const arOffsetX = makeMutable(0);
export const arOffsetY = makeMutable(0);

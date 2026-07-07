/**
 * arAnchorStore.ts
 * 
 * Zustand store for 3D AR world anchors.
 * 
 * Design decisions:
 * - screenX / screenY / depth / isVisible are Reanimated SharedValues
 *   so the native bridge can update them at 60fps without triggering
 *   React re-renders. Skia reads them directly on the UI thread.
 * - The store only holds JS-side metadata. The real 3D tracking is done
 *   natively by ARKit / ARCore.
 */

import { create } from 'zustand';
import { makeMutable, SharedValue } from 'react-native-reanimated';
import type { ARScreenPoint } from '../modules/ar-session';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ARAnchor {
  id: string;
  label: string;
  instruction?: string;     // Moondream action hint — shown as subtitle
  color: string;            // hex — '#10B981' green default
  worldMatrix: number[];    // 16-element 4×4 flat row-major from hitTest()
  createdAt: number;        // ms timestamp

  // These SharedValues are updated by the native 60fps projection loop.
  // Skia reads them directly — zero React renders per frame update.
  screenX: SharedValue<number>;
  screenY: SharedValue<number>;
  depth: SharedValue<number>;
  isVisible: SharedValue<boolean>;
}

export type ARTrackingStateType =
  | 'initializing'
  | 'normal'
  | 'limited'
  | 'not_available'
  | 'unsupported';

interface ARAnchorState {
  anchors: ARAnchor[];
  trackingState: ARTrackingStateType;
  isSessionActive: boolean;

  // Actions
  addAnchor: (a: Omit<ARAnchor, 'screenX' | 'screenY' | 'depth' | 'isVisible'>) => void;
  removeAnchor: (id: string) => void;
  clearAll: () => void;

  /**
   * Called every frame by useARSession's projection loop.
   * Updates only SharedValues — no React re-render triggered.
   */
  updatePositions: (positions: ARScreenPoint[]) => void;

  setTrackingState: (state: ARTrackingStateType) => void;
  setSessionActive: (active: boolean) => void;
}

// ─── Store ────────────────────────────────────────────────────────────────────

export const useARAnchorStore = create<ARAnchorState>((set, get) => ({
  anchors: [],
  trackingState: 'initializing',
  isSessionActive: false,

  addAnchor: (anchorData) => {
    const anchor: ARAnchor = {
      ...anchorData,
      screenX: makeMutable(0),
      screenY: makeMutable(0),
      depth: makeMutable(1),
      isVisible: makeMutable(false),
    };
    set((state) => ({ anchors: [...state.anchors, anchor] }));
  },

  removeAnchor: (id) => {
    set((state) => ({
      anchors: state.anchors.filter((a) => a.id !== id),
    }));
  },

  clearAll: () => {
    set({ anchors: [] });
  },

  updatePositions: (positions) => {
    // Build lookup for O(1) access
    const posMap = new Map(positions.map((p) => [p.id, p]));

    // Mutate SharedValues directly — bypasses React scheduler entirely
    for (const anchor of get().anchors) {
      const pos = posMap.get(anchor.id);
      if (pos) {
        anchor.screenX.value = pos.screenX;
        anchor.screenY.value = pos.screenY;
        anchor.depth.value = pos.depth;
        anchor.isVisible.value = pos.isVisible;
      }
    }
    // Note: no set() call — SharedValue mutations are not Zustand state changes
  },

  setTrackingState: (state) => set({ trackingState: state }),
  setSessionActive: (active) => set({ isSessionActive: active }),
}));

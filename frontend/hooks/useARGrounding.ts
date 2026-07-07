/**
 * useARGrounding.ts
 *
 * Converts VLM-returned 2D coordinates into true 3D world anchors.
 *
 * Pipeline:
 *   VLM returns [{ label, xNorm, yNorm, instruction }]
 *       ↓
 *   ARBridge.hitTest(xNorm, yNorm) → 3D world transform matrix
 *       ↓
 *   ARBridge.createAnchor(id, matrix) → native SLAM tracking begins
 *       ↓
 *   arAnchorStore.addAnchor() → label renders via ARMarkerNative
 *
 * Staleness guard: if a second voice query arrives before the first
 * grounding resolves, the first result is discarded.
 *
 * This hook is injected into useVoiceSession via the captureFrame parameter.
 * It does NOT depend on cameraRef or VisionCamera.
 */

import { useRef, useCallback } from 'react';
import { ARBridge } from '../modules/ar-session';
import { useARAnchorStore } from '../store/arAnchorStore';

export interface GroundingLabel {
  id: string;
  label: string;
  instruction?: string;
  xNorm: number;    // 0–1 normalised, from Moondream /point
  yNorm: number;    // 0–1 normalised
  confidence?: number;
}

// Color palette for grounded labels
const LABEL_COLORS = ['#10B981', '#3B82F6', '#F59E0B', '#EF4444', '#8B5CF6'];

export const useARGrounding = () => {
  const store = useARAnchorStore();
  // Monotonically increasing request ID — stale responses are discarded
  const activeRequestId = useRef(0);

  /**
   * Place 3D AR anchors for a list of VLM-grounded labels.
   *
   * @param labels   Array from /ground-label or ar_context SSE event
   * @param captureFrame   Not used here (already called before this) but
   *                       accepted so callers don't need to know the boundary
   */
  const groundLabels = useCallback(
    async (labels: GroundingLabel[]): Promise<void> => {
      if (labels.length === 0) return;

      // 1. Increment request ID — any pending previous grounding is now stale
      const myRequestId = ++activeRequestId.current;

      // 2. Clear previous anchors from native + store
      await ARBridge.removeAllAnchors();
      store.clearAll();

      // 3. For each label, perform hit test and create anchor
      for (let i = 0; i < labels.length; i++) {
        // Abort if a newer request came in while we were processing
        if (myRequestId !== activeRequestId.current) {
          console.log('[useARGrounding] Stale request discarded');
          return;
        }

        const item = labels[i];
        try {
          const matrix = await ARBridge.hitTest(item.xNorm, item.yNorm);

          if (!matrix) {
            // No surface found at this point — skip this label silently
            console.warn(`[useARGrounding] No surface for "${item.label}" at (${item.xNorm.toFixed(2)}, ${item.yNorm.toFixed(2)})`);
            continue;
          }

          if (myRequestId !== activeRequestId.current) return;

          await ARBridge.createAnchor(item.id, matrix);

          store.addAnchor({
            id: item.id,
            label: item.label,
            instruction: item.instruction,
            color: LABEL_COLORS[i % LABEL_COLORS.length],
            worldMatrix: matrix,
            createdAt: Date.now(),
          });

          console.log(`[useARGrounding] Anchor placed: "${item.label}"`);
        } catch (err) {
          // Non-fatal — log and continue with remaining labels
          console.warn(`[useARGrounding] Failed to anchor "${item.label}":`, err);
        }
      }
    },
    [store]
  );

  /**
   * Clear all anchors immediately.
   * Called when a new voice session starts or session ends.
   */
  const clearAll = useCallback(async () => {
    activeRequestId.current++; // invalidate any in-flight grounding
    await ARBridge.removeAllAnchors();
    store.clearAll();
  }, [store]);

  /**
   * Replace existing anchors for a guide step transition.
   * Identical to groundLabels but semantically clearer for Guide mode.
   */
  const groundStep = useCallback(
    async (label: GroundingLabel): Promise<void> => {
      await groundLabels([label]);
    },
    [groundLabels]
  );

  return {
    groundLabels,   // Use for: voice answers, troubleshoot, explain
    groundStep,     // Use for: guide mode step transitions
    clearAll,       // Use for: session end, new query start
  };
};

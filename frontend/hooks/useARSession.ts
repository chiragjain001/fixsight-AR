/**
 * useARSession.ts
 *
 * Manages the full AR session lifecycle and drives the 60fps label
 * position update loop.
 *
 * Responsibilities:
 * 1. Check AR support on mount → set trackingState accordingly
 * 2. Start / stop the native AR session with the app lifecycle
 * 3. Run a requestAnimationFrame loop that calls getProjectedPositions()
 *    and updates the SharedValues in arAnchorStore (60fps, no React renders)
 * 4. Monitor tracking quality via native events and 2s polling
 * 5. Expose captureFrame() — the drop-in replacement for cameraRef.takePhoto()
 *
 * This hook is mounted ONCE in the root CameraView.ar.tsx component.
 * Do not mount it multiple times.
 */

import { useEffect, useRef, useCallback } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import { ARBridge } from '../modules/ar-session';
import { useARAnchorStore } from '../store/arAnchorStore';

// How long to wait (ms) between tracking-quality polls
const TRACKING_POLL_MS = 2000;

export const useARSession = () => {
  const store = useARAnchorStore();
  const frameLoopRef = useRef<number | null>(null);
  const trackingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isRunningRef = useRef(false);

  // ── Frame projection loop ──────────────────────────────────────────────────

  const startFrameLoop = useCallback(() => {
    if (isRunningRef.current) return;
    isRunningRef.current = true;

    const loop = async () => {
      if (!isRunningRef.current) return;
      try {
        const positions = await ARBridge.getProjectedPositions();
        store.updatePositions(positions);
      } catch {
        // Silently skip frames where projection fails (e.g. brief occlusion)
      }
      frameLoopRef.current = requestAnimationFrame(loop);
    };

    frameLoopRef.current = requestAnimationFrame(loop);
  }, [store]);

  const stopFrameLoop = useCallback(() => {
    isRunningRef.current = false;
    if (frameLoopRef.current != null) {
      cancelAnimationFrame(frameLoopRef.current);
      frameLoopRef.current = null;
    }
  }, []);

  // ── Tracking quality monitor ───────────────────────────────────────────────

  const startTrackingMonitor = useCallback(() => {
    if (trackingTimerRef.current) return;
    trackingTimerRef.current = setInterval(async () => {
      try {
        const state = await ARBridge.getTrackingState();
        store.setTrackingState(state);
      } catch {
        store.setTrackingState('not_available');
      }
    }, TRACKING_POLL_MS);
  }, [store]);

  const stopTrackingMonitor = useCallback(() => {
    if (trackingTimerRef.current) {
      clearInterval(trackingTimerRef.current);
      trackingTimerRef.current = null;
    }
  }, []);

  // ── App lifecycle (background / foreground) ────────────────────────────────

  useEffect(() => {
    const sub = AppState.addEventListener('change', (nextState: AppStateStatus) => {
      if (nextState === 'background' || nextState === 'inactive') {
        stopFrameLoop();
        stopTrackingMonitor();
        ARBridge.pauseSession().catch(() => {});
      } else if (nextState === 'active' && store.isSessionActive) {
        ARBridge.resumeSession()
          .then(() => {
            startFrameLoop();
            startTrackingMonitor();
          })
          .catch(() => {});
      }
    });
    return () => sub.remove();
  }, [store.isSessionActive]);

  // ── Native tracking state events ───────────────────────────────────────────

  useEffect(() => {
    const sub = ARBridge.onPositionsUpdated((positions) => {
      store.updatePositions(positions);
    });
    return () => sub.remove();
  }, []);

  // ── Main session startup ───────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const supported = await ARBridge.isSupported();
        if (cancelled) return;

        if (!supported) {
          store.setTrackingState('unsupported');
          store.setSessionActive(false);
          return;
        }

        store.setTrackingState('initializing');
        await ARBridge.startSession();

        if (cancelled) return;

        store.setSessionActive(true);
        startFrameLoop();
        startTrackingMonitor();
      } catch (err) {
        if (!cancelled) {
          console.error('[useARSession] Startup failed:', err);
          store.setTrackingState('not_available');
        }
      }
    })();

    return () => {
      cancelled = true;
      stopFrameLoop();
      stopTrackingMonitor();
      ARBridge.stopSession().catch(() => {});
      store.setSessionActive(false);
    };
  }, []);

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Drop-in replacement for cameraRef.takePhoto().
   * Returns { base64: string } in the same shape as the old VisionCamera call.
   */
  const captureFrame = useCallback(
    (quality = 0.85): Promise<{ base64: string }> =>
      ARBridge.captureFrame(quality),
    []
  );

  return { captureFrame };
};

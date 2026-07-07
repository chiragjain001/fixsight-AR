import { NativeModule, requireNativeModule, NativeModulesProxy } from 'expo-modules-core';
import { NativeEventEmitter, Platform } from 'react-native';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ARScreenPoint {
  id: string;
  screenX: number;
  screenY: number;
  depth: number;       // metres — use for depth-scaled label sizing
  isVisible: boolean;  // false when anchor is behind the camera
}

export type ARTrackingState = 'normal' | 'limited' | 'not_available';

// ─── Native Module Interface ───────────────────────────────────────────────────

interface ARSessionModuleType extends NativeModule {
  // Lifecycle
  isSupported(): Promise<boolean>;
  startSession(): Promise<void>;
  stopSession(): Promise<void>;
  pauseSession(): Promise<void>;
  resumeSession(): Promise<void>;

  // Frame capture — replaces cameraRef.takePhoto() everywhere in the app
  captureFrame(quality: number): Promise<{ base64: string }>;

  // Spatial operations
  hitTest(xNorm: number, yNorm: number): Promise<number[] | null>;
  createAnchor(id: string, matrix: number[]): Promise<void>;
  removeAnchor(id: string): Promise<void>;
  removeAllAnchors(): Promise<void>;

  // Projection — call each frame to get screen coords per anchor
  getProjectedPositions(): Promise<ARScreenPoint[]>;
  getTrackingState(): Promise<ARTrackingState>;
}

// ─── Module Instance ──────────────────────────────────────────────────────────

const ARSessionNativeModule =
  requireNativeModule<ARSessionModuleType>('ARSessionModule');

// ─── Event Emitter ────────────────────────────────────────────────────────────

const emitter = new NativeEventEmitter(
  NativeModulesProxy.ARSessionModule as any
);

// ─── Public ARBridge API ──────────────────────────────────────────────────────
// This is what the rest of the app imports. Never import the native module directly.

export const ARBridge = {
  isSupported: (): Promise<boolean> =>
    ARSessionNativeModule.isSupported(),

  startSession: (): Promise<void> =>
    ARSessionNativeModule.startSession(),

  stopSession: (): Promise<void> =>
    ARSessionNativeModule.stopSession(),

  pauseSession: (): Promise<void> =>
    ARSessionNativeModule.pauseSession(),

  resumeSession: (): Promise<void> =>
    ARSessionNativeModule.resumeSession(),

  /**
   * Captures a JPEG frame from the AR camera.
   * Drop-in replacement for VisionCamera's cameraRef.takePhoto().
   * @param quality  0.0–1.0 JPEG compression quality (default 0.85)
   */
  captureFrame: (quality = 0.85): Promise<{ base64: string }> =>
    ARSessionNativeModule.captureFrame(quality),

  /**
   * Performs an AR hit test at a normalised screen point.
   * Returns a flat 16-element row-major 4×4 world transform matrix,
   * or null if no surface was found.
   */
  hitTest: (xNorm: number, yNorm: number): Promise<number[] | null> =>
    ARSessionNativeModule.hitTest(xNorm, yNorm),

  /**
   * Creates a persistent 3D world anchor from a 4×4 matrix returned by hitTest().
   * The AR engine tracks this point automatically after creation.
   */
  createAnchor: (id: string, matrix: number[]): Promise<void> =>
    ARSessionNativeModule.createAnchor(id, matrix),

  removeAnchor: (id: string): Promise<void> =>
    ARSessionNativeModule.removeAnchor(id),

  removeAllAnchors: (): Promise<void> =>
    ARSessionNativeModule.removeAllAnchors(),

  /**
   * Returns current screen projections for all live anchors.
   * Call this in a requestAnimationFrame loop for 60fps label updates.
   */
  getProjectedPositions: (): Promise<ARScreenPoint[]> =>
    ARSessionNativeModule.getProjectedPositions(),

  getTrackingState: (): Promise<ARTrackingState> =>
    ARSessionNativeModule.getTrackingState(),

  /**
   * Subscribe to continuous anchor position updates emitted by the native layer.
   * Alternative to polling getProjectedPositions() manually.
   */
  onPositionsUpdated: (cb: (positions: ARScreenPoint[]) => void) =>
    emitter.addListener('onAnchorPositionsUpdated', cb),
};

// ─── Re-export native view component name ────────────────────────────────────
// Used by ARNativeView.tsx to render the AR camera feed
export const AR_NATIVE_VIEW_NAME = 'ARSessionView';

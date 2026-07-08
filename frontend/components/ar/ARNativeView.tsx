/**
 * ARNativeView.tsx
 *
 * Wraps the native ARSCNView/GLSurfaceView with an Error Boundary.
 *
 * WHY:
 *   The current installed dev APK has a broken ARSessionView native descriptor
 *   that crashes with "Cannot read property 'bubblingEventTypes' of null" at
 *   render time. requireNativeComponent() succeeds (the name is registered),
 *   but React Native crashes when it tries to process the view's event map.
 *
 * HOW IT'S FIXED:
 *   - ARViewErrorBoundary catches the crash silently.
 *   - Falls back to VisionCamera for the camera feed.
 *   - Exposes a Camera ref (fallbackCameraRef) so captureFrame() still works.
 *   - When a new EAS build is installed (with the fixed Kotlin/Swift), ARCore
 *     renders correctly and VisionCamera is never mounted.
 */

import React from 'react';
import {
  StyleSheet,
  requireNativeComponent,
  ViewStyle,
  View,
} from 'react-native';
import { Camera, CameraDevice } from 'react-native-vision-camera';
import { AR_NATIVE_VIEW_NAME } from '../../modules/ar-session';

// ── Attempt to load native view at import time ────────────────────────────────
let NativeARView: React.ComponentType<{ style?: ViewStyle }> | null = null;
try {
  NativeARView = requireNativeComponent<{ style?: ViewStyle }>(AR_NATIVE_VIEW_NAME);
} catch (e) {
  console.warn('[ARNativeView] requireNativeComponent failed (will use VisionCamera):', e);
}

// ── VisionCamera fallback ─────────────────────────────────────────────────────
interface FallbackProps {
  style?: ViewStyle;
  cameraRef?: React.RefObject<Camera>;
  device?: CameraDevice;
  hasPermission?: boolean;
}

function VisionCameraFallback({ style, cameraRef, device, hasPermission }: FallbackProps) {
  if (!hasPermission || !device) {
    return <View style={[StyleSheet.absoluteFill, { backgroundColor: '#000' }, style]} />;
  }
  return (
    <Camera
      ref={cameraRef}
      style={[StyleSheet.absoluteFill, style]}
      device={device}
      isActive={true}
      photo={true}
    />
  );
}

// ── Error Boundary — catches bubblingEventTypes at render time ────────────────
interface BoundaryProps {
  children: React.ReactNode;
  style?: ViewStyle;
  cameraRef?: React.RefObject<Camera>;
  device?: CameraDevice;
  hasPermission?: boolean;
}
interface BoundaryState { crashed: boolean }

class ARViewErrorBoundary extends React.Component<BoundaryProps, BoundaryState> {
  constructor(props: BoundaryProps) {
    super(props);
    this.state = { crashed: false };
  }

  static getDerivedStateFromError(): BoundaryState {
    return { crashed: true };
  }

  componentDidCatch(error: Error) {
    console.warn(
      '[ARNativeView] Crash caught by ErrorBoundary — falling back to VisionCamera.\n' +
      'Run `eas build --platform android --profile development` to get the fixed build.\n' +
      'Error: ' + error.message
    );
  }

  render() {
    if (this.state.crashed) {
      return (
        <VisionCameraFallback
          style={this.props.style}
          cameraRef={this.props.cameraRef}
          device={this.props.device}
          hasPermission={this.props.hasPermission}
        />
      );
    }
    return this.props.children;
  }
}

// ── Simple ARNativeView (no ref needed) ──────────────────────────────────────
interface Props { style?: ViewStyle }

export function ARNativeView({ style }: Props) {
  if (!NativeARView) {
    return <View style={[StyleSheet.absoluteFill, { backgroundColor: '#000' }, style]} />;
  }
  return (
    <ARViewErrorBoundary style={style}>
      <NativeARView style={[StyleSheet.absoluteFill, style]} />
    </ARViewErrorBoundary>
  );
}

// ── ARNativeViewWithRef (used by CameraView — exposes camera ref for fallback)
interface WithRefProps {
  style?: ViewStyle;
  fallbackCameraRef?: React.RefObject<Camera>;
  device?: CameraDevice;
  hasPermission?: boolean;
}

export function ARNativeViewWithRef({
  style,
  fallbackCameraRef,
  device,
  hasPermission,
}: WithRefProps) {
  if (!NativeARView) {
    // Native view never registered → go straight to VisionCamera
    console.warn('[ARNativeView] Not registered — using VisionCamera.');
    return (
      <VisionCameraFallback
        style={style}
        cameraRef={fallbackCameraRef}
        device={device}
        hasPermission={hasPermission}
      />
    );
  }

  return (
    <ARViewErrorBoundary
      style={style}
      cameraRef={fallbackCameraRef}
      device={device}
      hasPermission={hasPermission}
    >
      <NativeARView style={[StyleSheet.absoluteFill, style]} />
    </ARViewErrorBoundary>
  );
}

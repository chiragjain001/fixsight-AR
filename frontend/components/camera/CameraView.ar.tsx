/**
 * CameraView.ar.tsx
 *
 * The new camera component for Solution A (always-on AR).
 * Replaces CameraView.vision-camera.tsx entirely.
 *
 * What this does:
 * - Renders the native AR camera feed (ARKit/ARCore via ARNativeView)
 * - Starts and owns the AR session lifecycle via useARSession
 * - Renders AROverlayLayer (Skia rings + RN labels) on top
 * - Shows tracking quality banner
 * - Exposes captureFrame via workflowStore so voice session can use it
 *
 * What this does NOT do:
 * - No VisionCamera, no frame processor, no TFLite, no IoU tracking
 */

import React, { useEffect } from 'react';
import { StyleSheet, View, Text } from 'react-native';
import { ARNativeView } from '../ar/ARNativeView';
import { AROverlayLayer } from '../ar/AROverlayLayer';
import { ARTrackingStatus } from '../ar/ARTrackingStatus';
import { useARSession } from '../../hooks/useARSession';
import { useWorkflowStore } from '../../store/workflowStore';
import { useARAnchorStore } from '../../store/arAnchorStore';

export function CameraView() {
  const { captureFrame } = useARSession();
  const setCaptureFrame = useWorkflowStore((s) => s.setCaptureFrame);
  const trackingState = useARAnchorStore((s) => s.trackingState);

  // Register captureFrame with workflowStore so useVoiceSession
  // and any other hook can call it without importing ARBridge directly.
  useEffect(() => {
    setCaptureFrame(captureFrame);
  }, [captureFrame, setCaptureFrame]);

  if (trackingState === 'unsupported') {
    return (
      <View style={styles.errorContainer}>
        <Text style={styles.errorText}>
          AR is not supported on this device.{'\n'}
          This app requires ARCore (Android 8+) or ARKit (iPhone 6s+).
        </Text>
      </View>
    );
  }

  return (
    <>
      {/* Native AR camera feed — owns the camera hardware */}
      <ARNativeView style={StyleSheet.absoluteFill} />

      {/* Skia rings + RN label pills */}
      <AROverlayLayer />

      {/* Non-intrusive tracking quality banner */}
      <ARTrackingStatus />
    </>
  );
}

const styles = StyleSheet.create({
  errorContainer: {
    flex: 1,
    backgroundColor: '#0a0c12',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  errorText: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 22,
  },
});

/**
 * CameraView.tsx
 *
 * Camera component — uses VisionCamera for the camera feed.
 * AR session bridge is still active for anchor/spatial operations.
 */

import React, { useEffect, useRef } from 'react';
import { StyleSheet, View, Text } from 'react-native';
import { Camera, useCameraDevice, useCameraPermission } from 'react-native-vision-camera';
import { AROverlayLayer } from '../ar/AROverlayLayer';
import { ARTrackingStatus } from '../ar/ARTrackingStatus';
import { useARSession } from '../../hooks/useARSession';
import { useWorkflowStore } from '../../store/workflowStore';
import { useARAnchorStore } from '../../store/arAnchorStore';

export function CameraView() {
  const { captureFrame } = useARSession();
  const setCaptureFrame = useWorkflowStore((s) => s.setCaptureFrame);
  const trackingState = useARAnchorStore((s) => s.trackingState);
  const { hasPermission, requestPermission } = useCameraPermission();
  const device = useCameraDevice('back');
  const cameraRef = useRef<Camera>(null);

  useEffect(() => {
    if (!hasPermission) requestPermission();
  }, [hasPermission]);

  // Register captureFrame with workflowStore
  useEffect(() => {
    setCaptureFrame(captureFrame);
  }, [captureFrame, setCaptureFrame]);

  if (!hasPermission) {
    return (
      <View style={styles.errorContainer}>
        <Text style={styles.errorText}>Camera permission is required.</Text>
      </View>
    );
  }

  if (!device) {
    return (
      <View style={styles.errorContainer}>
        <Text style={styles.errorText}>No camera device found.</Text>
      </View>
    );
  }

  return (
    <>
      {/* VisionCamera — stable camera feed */}
      <Camera
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        device={device}
        isActive={true}
        photo={true}
      />

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


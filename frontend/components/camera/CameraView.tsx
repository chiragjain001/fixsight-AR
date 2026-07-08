/**
 * CameraView.tsx
 *
 * Current APK compatibility mode:
 *  - Uses ONLY VisionCamera (ARNativeView is excluded — the old APK's native
 *    descriptor is broken and causes bubblingEventTypes + camera-already-in-use)
 *  - captureFrame uses VisionCamera takePhoto() → expo-file-system base64
 *  - AR labels show in screen-space (2D) via arTrackingStore / AROverlayLayer
 *
 * After new EAS build:
 *  - Swap VisionCamera back to ARNativeViewWithRef and uncomment useARSession
 *  - 3D world-locked labels will then work via ARBridge.hitTest()
 */

import React, { useCallback, useEffect, useRef } from 'react';
import { StyleSheet, View, Text } from 'react-native';
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
} from 'react-native-vision-camera';
import * as FileSystem from 'expo-file-system';
import { AROverlayLayer } from '../ar/AROverlayLayer';
import { ARTrackingStatus } from '../ar/ARTrackingStatus';
import { useWorkflowStore } from '../../store/workflowStore';

export function CameraView() {
  const { hasPermission, requestPermission } = useCameraPermission();
  const device    = useCameraDevice('back');
  const cameraRef = useRef<Camera>(null);

  const setCaptureFrame    = useWorkflowStore((s) => s.setCaptureFrame);
  const setGroundLastImage = useWorkflowStore((s) => s.setGroundLastImage);

  // ── Request camera permission on mount ─────────────────────────────────────
  useEffect(() => {
    if (!hasPermission) requestPermission();
  }, [hasPermission]);

  // ── captureFrame: takes a photo and returns base64 ─────────────────────────
  const captureFrame = useCallback(async (): Promise<{ base64: string }> => {
    const cam = cameraRef.current;
    if (!cam) throw new Error('[CameraView] Camera ref not ready');
    const photo = await cam.takePhoto({ flash: 'off' });
    const base64 = await FileSystem.readAsStringAsync(`file://${photo.path}`, {
      encoding: FileSystem.EncodingType.Base64,
    });
    return { base64 };
  }, []);

  // ── groundLastImage: no-op in current APK (no ARCore hitTest available) ─────
  // In the new EAS build this will be replaced with real hitTest + createAnchor.
  const groundLastImage = useCallback(
    async (_imageB64: string, _query: string) => {
      // ARCore not available in current APK — 2D screen-space labels are used instead.
    },
    []
  );

  // Register both functions with workflowStore
  useEffect(() => {
    setCaptureFrame(captureFrame);
  }, [captureFrame, setCaptureFrame]);

  useEffect(() => {
    setGroundLastImage(groundLastImage);
  }, [groundLastImage, setGroundLastImage]);

  // ── Permission / device guard ───────────────────────────────────────────────
  if (!hasPermission) {
    return (
      <View style={styles.errorContainer}>
        <Text style={styles.errorTitle}>Camera Permission Required</Text>
        <Text style={styles.errorText}>
          Please grant camera access in your device settings.
        </Text>
      </View>
    );
  }

  if (!device) {
    return (
      <View style={styles.errorContainer}>
        <Text style={styles.errorTitle}>No Camera Found</Text>
        <Text style={styles.errorText}>
          Unable to access a rear camera on this device.
        </Text>
      </View>
    );
  }

  return (
    <>
      <Camera
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        device={device}
        isActive={true}
        photo={true}
      />
      <AROverlayLayer />
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
    gap: 12,
  },
  errorTitle: {
    color: '#EF4444',
    fontSize: 18,
    fontWeight: '700',
  },
  errorText: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 22,
  },
});

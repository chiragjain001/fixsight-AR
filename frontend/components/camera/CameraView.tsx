/**
 * CameraView.tsx
 *
 * Camera component with automatic fallback:
 *  - New EAS build → ARNativeView (ARCore, 3D world tracking, captureFrame via ARBridge)
 *  - Old APK        → VisionCamera fallback (auto-switched by ARViewErrorBoundary),
 *                     captureFrame via takePhoto() + expo-file-system
 *
 * Either way the camera works, the app doesn't crash, and the rest of the
 * workflow (scan, labels, voice) continues normally.
 */

import React, { useCallback, useEffect, useRef } from 'react';
import { StyleSheet, View, Text } from 'react-native';
import { Camera, useCameraDevice, useCameraPermission } from 'react-native-vision-camera';
import * as FileSystem from 'expo-file-system';
import { ARNativeViewWithRef } from '../ar/ARNativeView';
import { AROverlayLayer } from '../ar/AROverlayLayer';
import { ARTrackingStatus } from '../ar/ARTrackingStatus';
import { useARSession } from '../../hooks/useARSession';
import { useARGrounding } from '../../hooks/useARGrounding';
import { useWorkflowStore } from '../../store/workflowStore';
import { useARAnchorStore } from '../../store/arAnchorStore';
import { BACKEND_URL } from '../../src/config';

export function CameraView() {
  // ── AR session (provides captureFrame via ARBridge when ARCore is active) ──
  const { captureFrame: arCaptureFrame } = useARSession();
  const { groundLabels, clearAll } = useARGrounding();

  const setCaptureFrame   = useWorkflowStore((s) => s.setCaptureFrame);
  const setGroundLastImage = useWorkflowStore((s) => s.setGroundLastImage);
  const trackingState     = useARAnchorStore((s) => s.trackingState);

  // ── VisionCamera refs (used as fallback when ARNativeView crashes) ─────────
  const { hasPermission, requestPermission } = useCameraPermission();
  const device     = useCameraDevice('back');
  const cameraRef  = useRef<Camera>(null);

  useEffect(() => {
    if (!hasPermission) requestPermission();
  }, [hasPermission]);

  // ── captureFrame: try ARBridge first, fall back to VisionCamera takePhoto ──
  const captureFrame = useCallback(async (): Promise<{ base64: string }> => {
    // ARBridge path: works when ARCore session is active (new EAS build)
    if (arCaptureFrame) {
      try {
        return await arCaptureFrame();
      } catch {
        // ARBridge not ready — fall through to VisionCamera
      }
    }
    // VisionCamera fallback path
    const cam = cameraRef.current;
    if (!cam) throw new Error('[CameraView] Camera not ready');
    const photo = await cam.takePhoto({ flash: 'off' });
    const base64 = await FileSystem.readAsStringAsync(`file://${photo.path}`, {
      encoding: FileSystem.EncodingType.Base64,
    });
    return { base64 };
  }, [arCaptureFrame]);

  // Register captureFrame so workflowStore.runRealScan() can call it
  useEffect(() => {
    setCaptureFrame(captureFrame);
  }, [captureFrame, setCaptureFrame]);

  // ── groundLastImage: calls /ground-label → hitTest → createAnchor ─────────
  const groundLastImage = useCallback(
    async (imageB64: string, query: string) => {
      try {
        clearAll();
        const res = await fetch(`${BACKEND_URL}/ground-label`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image_b64: imageB64, query, max_labels: 6 }),
        });
        if (!res.ok) return;
        const { labels } = await res.json();
        if (labels?.length > 0) await groundLabels(labels);
      } catch (err) {
        console.warn('[CameraView] groundLastImage failed (non-fatal):', err);
      }
    },
    [groundLabels, clearAll]
  );

  // Register groundLastImage so runRealScan and selectMode can trigger it
  useEffect(() => {
    setGroundLastImage(groundLastImage);
  }, [groundLastImage, setGroundLastImage]);

  // ── Unsupported device ─────────────────────────────────────────────────────
  if (trackingState === 'unsupported') {
    return (
      <View style={styles.errorContainer}>
        <Text style={styles.errorTitle}>AR Not Supported</Text>
        <Text style={styles.errorText}>
          This device does not support ARCore.{'\n'}
          AR features require ARCore with Google Play Services for AR installed.
        </Text>
      </View>
    );
  }

  return (
    <>
      {/*
        ARNativeViewWithRef:
        - On NEW EAS build: renders ARCore native view. cameraRef stays unused.
        - On OLD APK:       Error Boundary catches crash → renders VisionCamera
                            and exposes it via cameraRef for captureFrame().
      */}
      <ARNativeViewWithRef
        style={StyleSheet.absoluteFill}
        fallbackCameraRef={cameraRef}
        hasPermission={hasPermission}
        device={device ?? undefined}
      />

      <AROverlayLayer />
      <ARTrackingStatus />
    </>
  );
}

const styles = StyleSheet.create({
  hiddenCamera: {
    width: 1,
    height: 1,
    opacity: 0,
    position: 'absolute',
  },
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

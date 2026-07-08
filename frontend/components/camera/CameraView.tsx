/**
 * CameraView.tsx
 *
 * PRIMARY camera component.
 *
 * Architecture:
 *  - ARNativeView  → ARCore owns the camera, renders the live feed, does SLAM tracking
 *  - useARSession  → lifecycle management, 60fps projection loop
 *  - useARGrounding→ converts VLM 2D coordinates to 3D world anchors via hitTest()
 *  - AROverlayLayer→ renders Skia rings + RN labels on top of the AR feed
 *
 * When ARCore is not supported (rare / unsupported device), falls back gracefully
 * to a plain message rather than crashing.
 */

import React, { useCallback, useEffect } from 'react';
import { StyleSheet, View, Text } from 'react-native';
import { ARNativeView } from '../ar/ARNativeView';
import { AROverlayLayer } from '../ar/AROverlayLayer';
import { ARTrackingStatus } from '../ar/ARTrackingStatus';
import { useARSession } from '../../hooks/useARSession';
import { useARGrounding } from '../../hooks/useARGrounding';
import { useWorkflowStore } from '../../store/workflowStore';
import { useARAnchorStore } from '../../store/arAnchorStore';
import { BACKEND_URL } from '../../src/config';
import { ARBridge } from '../../modules/ar-session';

export function CameraView() {
  const { captureFrame } = useARSession();
  const { groundLabels, clearAll } = useARGrounding();
  const setCaptureFrame = useWorkflowStore((s) => s.setCaptureFrame);
  const trackingState = useARAnchorStore((s) => s.trackingState);

  // Register captureFrame with workflowStore so voice session can call it
  useEffect(() => {
    setCaptureFrame(captureFrame);
  }, [captureFrame, setCaptureFrame]);

  // ── Scan-triggered grounding ───────────────────────────────────────────────
  // Called by the scan button (via workflowStore) AFTER the VLM identifies
  // the device. We send the captured image to /ground-label, which returns
  // Moondream-located coordinates, then we hitTest each and create anchors.
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
        if (labels && labels.length > 0) {
          await groundLabels(labels);
        }
      } catch (err) {
        console.warn('[CameraView] groundLastImage failed:', err);
      }
    },
    [groundLabels, clearAll]
  );

  // Expose groundLastImage to workflowStore so runRealScan and selectMode can trigger it
  const setGroundLastImage = useWorkflowStore((s) => s.setGroundLastImage);
  useEffect(() => {
    setGroundLastImage(groundLastImage);
  }, [groundLastImage, setGroundLastImage]);

  // Unsupported device — show a clear message
  if (trackingState === 'unsupported') {
    return (
      <View style={styles.errorContainer}>
        <Text style={styles.errorTitle}>AR Not Supported</Text>
        <Text style={styles.errorText}>
          This device does not support ARCore.{'\n'}
          AR features require ARCore (Android 7.0+) with Google Play Services for AR installed.
        </Text>
      </View>
    );
  }

  return (
    <>
      {/* ARCore camera feed — owns camera hardware and SLAM tracking */}
      <ARNativeView style={StyleSheet.absoluteFill} />

      {/* Skia rings + RN label pills positioned by 3D anchor projections */}
      <AROverlayLayer />

      {/* Tracking quality banner (limited / initializing / normal) */}
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

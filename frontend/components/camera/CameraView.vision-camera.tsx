import React, { useEffect, useCallback, useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
  useFrameProcessor,
} from 'react-native-vision-camera';
import { useTensorflowModel } from 'react-native-fast-tflite';
import { useSharedValue, Worklets } from 'react-native-worklets-core';
import { useResizePlugin } from 'vision-camera-resize-plugin';
import { useWorkflowStore } from '../../store/workflowStore';
import { useSceneStore } from '../../store/sceneStore';
import { useWsStore } from '../../store/wsStore';
import { AROverlayLayer } from '../ar/AROverlayLayer';
import { useARTrackingStore } from '../../store/arTrackingStore';

function calculateIoU(a: number[], b: number[]): number {
  'worklet';
  const ax1 = a[0], ay1 = a[1], ax2 = a[2], ay2 = a[3];
  const bx1 = b[0], by1 = b[1], bx2 = b[2], by2 = b[3];
  const ix1 = Math.max(ax1, bx1), iy1 = Math.max(ay1, by1);
  const ix2 = Math.min(ax2, bx2), iy2 = Math.min(ay2, by2);
  if (ix2 < ix1 || iy2 < iy1) return 0;
  const inter = (ix2 - ix1) * (iy2 - iy1);
  const areaA = (ax2 - ax1) * (ay2 - ay1);
  const areaB = (bx2 - bx1) * (by2 - by1);
  return inter / (areaA + areaB - inter);
}

function lerpBox(prev: number[], next: number[], alpha: number): number[] {
  'worklet';
  return [
    prev[0] + (next[0] - prev[0]) * alpha,
    prev[1] + (next[1] - prev[1]) * alpha,
    prev[2] + (next[2] - prev[2]) * alpha,
    prev[3] + (next[3] - prev[3]) * alpha,
  ];
}

// ── Component ────────────────────────────────────────────────────────────
export function CameraView() {
  const { hasPermission, requestPermission } = useCameraPermission();
  const { facing, torchEnabled, setCameraRef, cameraRef, startAnalysis } = useWorkflowStore();
  const { markAnalysisSent, analysisStatus, reset: resetScene } = useSceneStore();
  const sendSceneFrame = useWsStore((s) => s.sendSceneFrame);

  const localCameraRef = useRef<Camera>(null);
  const device = useCameraDevice(facing);

  // TFLite model — file exists at assets/models/detect.tflite
  const model = useTensorflowModel(
    require('../../assets/models/detect.tflite')
  );

  // resize plugin instance (worklet-safe, memory managed)
  const { resize } = useResizePlugin();

  // ── Manual scan trigger sync (optimized)
  const manualScanTick = useWorkflowStore((state) => state.manualScanTick);
  const manualTriggerSV = useSharedValue(0);
  useEffect(() => {
    manualTriggerSV.value = manualScanTick;
  }, [manualScanTick, manualTriggerSV]);

  // ── Permission request on mount
  useEffect(() => {
    if (!hasPermission) requestPermission();
  }, [hasPermission, requestPermission]);

  // ── Watchdog timer (increased to 30s to avoid false failures on slow networks)
  useEffect(() => {
    if (analysisStatus !== 'analyzing') return;
    const t = setTimeout(() => {
      resetScene();
      useWorkflowStore.getState().reset();
      console.warn('[FixSight] Analysis timed out (30s) — resetting to READY');
    }, 30000);
    return () => clearTimeout(t);
  }, [analysisStatus, resetScene]);

  // ── UI state update — separate from network layer
  const onStableDetection = useCallback(
    async (hazardBbox: number[]) => {
      try {
        if (!localCameraRef.current) return;
        
        console.log('[FixSight] Found stable object. Taking photo...');
        
        // Instead of doing heavy RGB-to-Base64 inside the Worklet thread,
        // we let the native camera take a high-speed JPEG directly.
        // This completely avoids all JSI TypedArray memory-drop bugs!
        const photo = await localCameraRef.current.takePhoto({
          flash: 'off',
        });
        
        // Convert to Base64 using a standard JS FileReader asynchronously
        const response = await fetch(`file://${photo.path}`);
        const blob = await response.blob();
        const reader = new FileReader();
        
        reader.onloadend = () => {
          const base64Str = (reader.result as string).split(',')[1];
          console.log(`[FixSight] Photo encoded! Base64 size: ${base64Str.length}`);
          
          sendSceneFrame(base64Str, hazardBbox);
          
          // Only update UI state after successfully queueing the websocket send
          markAnalysisSent();
          startAnalysis();
        };
        
        reader.onerror = (e) => console.error('[FixSight] FileReader error:', e);
        reader.readAsDataURL(blob);
        
      } catch (err) {
        console.error('[FixSight] Failed to take/send photo:', err);
      }
    },
    [markAnalysisSent, sendSceneFrame, startAnalysis]
  );
  
  const onStableDetectionJS = Worklets.createRunOnJS(onStableDetection);

  const targets = useARTrackingStore((s) => s.targets);

  const markTargetLostState = useCallback((id: string, isLost: boolean) => {
    useARTrackingStore.getState().updateTargetLostState(id, isLost);
  }, []);
  const markTargetLostStateJS = Worklets.createRunOnJS(markTargetLostState);

  // ── Shared worklet state (persists between frames via useSharedValue)
  const targetLostFrames = useSharedValue<Record<string, number>>({});
  const lastSentAt    = useSharedValue(0);
  const frameCount    = useSharedValue(0);

  const SEND_COOLDOWN = 3000; // ms minimum between sends

  // ─────────────────────────────────────────────────────────────────────────
  // useFrameProcessor runs off the UI thread in a JSI worklet context.
  // ─────────────────────────────────────────────────────────────────────────
  const frameProcessor = useFrameProcessor(
    (frame) => {
      'worklet';
      frameCount.value += 1;

      // Throttle TFLite execution to ~20 FPS (assuming 60fps camera) 
      // This prevents CPU lockup and thermal throttling on Android.
      if (frameCount.value % 3 !== 0) return;

      // ── TFLite local detection ─────────────────────────────
      if (model.state === 'loading' || model.state === 'error') return;
      const tfModel = model.model;
      if (tfModel == null) return;

      try {
        // Resize frame to 300×300 RGB uint8 for MobileNetSSD
        const tensor = resize(frame, {
          scale: { width: 300, height: 300 },
          pixelFormat: 'rgb',
          dataType: 'uint8',
        });

        // MobileNetSSD output tensors
        const outputs = tfModel.runSync([tensor]);

        const locations = outputs[0] as Float32Array;
        const scores    = outputs[2] as Float32Array;
        const numDets   = Math.round((outputs[3] as Float32Array)[0]);

        const isManual = manualTriggerSV.value > 0;
        
        // ── MANUAL OVERRIDE ONLY (Triggers exactly one analysis) ──
        if (isManual) {
            manualTriggerSV.value = 0; // reset
            lastSentAt.value = Date.now();
            
            // Send empty bbox or the highest confidence auto-tracked bbox if available
            // For simplicity, we send empty to let VLM analyze the whole scene
            onStableDetectionJS([]);
            return;
        }

        // ── AUTO TRACKING — UI THREAD IoU MATCHING ──
        if (targets.length > 0) {
          const IOU_THRESHOLD = 0.3;
          const SMOOTH_ALPHA = 0.18;
          const LOST_THRESHOLD = 30;

          const nextLostFrames = Object.assign({}, targetLostFrames.value);

          for (let i = 0; i < targets.length; i++) {
            const target = targets[i];
            const targetId = target.id;
            let bestMatch = null;
            let bestIoU = IOU_THRESHOLD;

            for (let j = 0; j < numDets; j++) {
              const score = scores[j];
              if (score < 0.45) continue;
              const y1 = locations[j * 4 + 0];
              const x1 = locations[j * 4 + 1];
              const y2 = locations[j * 4 + 2];
              const x2 = locations[j * 4 + 3];
              const bbox = [x1, y1, x2, y2];
              
              const iou = calculateIoU(target.boxSV.value, bbox);
              if (iou > bestIoU) {
                bestIoU = iou;
                bestMatch = bbox;
              }
            }

            if (bestMatch) {
              target.boxSV.value = lerpBox(target.boxSV.value, bestMatch, SMOOTH_ALPHA);
              const wasLost = (nextLostFrames[targetId] || 0) > LOST_THRESHOLD;
              nextLostFrames[targetId] = 0;
              if (wasLost) {
                markTargetLostStateJS(targetId, false);
              }
            } else {
              const frames = (nextLostFrames[targetId] || 0) + 1;
              nextLostFrames[targetId] = frames;
              if (frames === LOST_THRESHOLD + 1) {
                markTargetLostStateJS(targetId, true);
              }
            }
          }
          targetLostFrames.value = nextLostFrames;
        }
      } catch (err: any) {
        console.log('[FrameProcessor Error]:', err.message || err);
      }
    },
    [model, resize, targets]
  );

  if (!hasPermission) {
    return (
      <View style={styles.container}>
        <Text style={styles.text}>Requesting Camera Permission…</Text>
      </View>
    );
  }

  if (device == null) {
    return (
      <View style={styles.container}>
        <Text style={styles.text}>No camera device found.</Text>
      </View>
    );
  }

  return (
    <>
      <Camera
        ref={(ref) => {
          (localCameraRef as any).current = ref;
          if (ref !== cameraRef) setCameraRef(ref);
        }}
        style={StyleSheet.absoluteFill}
        device={device}
        isActive={true}
        photo={true}
        frameProcessor={frameProcessor}
        torch={torchEnabled ? 'on' : 'off'}
      />
      
      {/* 2.5D AR Spatial Overlays */}
      <AROverlayLayer />
      
      {/* Scan Flash Effect */}
      {analysisStatus === 'analyzing' && (
        <View style={[StyleSheet.absoluteFill, styles.flash]} pointerEvents="none" />
      )}
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: { color: 'rgba(255,255,255,0.5)', fontSize: 14 },
  flash: { backgroundColor: 'rgba(255,255,255,0.2)' },
});

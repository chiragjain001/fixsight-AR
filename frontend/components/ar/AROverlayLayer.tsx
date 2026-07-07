import React, { useMemo } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import { Canvas } from '@shopify/react-native-skia';
import { useSharedValue, useDerivedValue } from 'react-native-reanimated';
import { useARTrackingStore, arOffsetX, arOffsetY } from '../../store/arTrackingStore';
import { useWorkflowStore } from '../../store/workflowStore';
import { ARMarker } from './ARMarker';
import { ARLabelNative } from './ARLabel';
import { useARAnchorStore } from '../../store/arAnchorStore';
import { ARMarkerNativeSkia, ARMarkerNativeLabel } from './ARMarkerNative';

// Helper to convert workflowStore component to virtual TrackedTarget
function useVirtualTargets() {
  const { components, activeComponentIndex, workflowState, guideSteps, activeStepIndex, activeMode, relatedParts, voiceSessionActive } = useWorkflowStore();
  const chatFocusTargetId = useARTrackingStore((s) => s.chatFocusTargetId);

  return useMemo(() => {
    return components.map((comp, idx) => {
      // Determine if active / faded / hidden based on state & activeMode
      let isActive = false;
      let isFaded = false;
      let isHidden = false;

      if (workflowState === 'GUIDE_MODE') {
        const currentStep = guideSteps[activeStepIndex];
        isActive = comp.id === currentStep?.componentId;
        // In Guide mode, only the target component glows, others fade
        isFaded = !isActive;
      } else if (voiceSessionActive) {
        if (chatFocusTargetId) {
          isActive = comp.id === chatFocusTargetId;
          isFaded = !isActive;
        } else {
          // No specific target highlighted, keep all faintly visible
          isFaded = true;
        }
      } else {
        isActive = idx === activeComponentIndex;
        if (activeMode === 'troubleshoot') {
          // Troubleshoot mode: only related components are visible
          const parts = relatedParts || ['cooling_fan', 'motor_body'];
          const isRelated = parts.includes(comp.id);
          if (!isRelated) {
            isHidden = true;
          }
        } else if (activeMode === 'explain') {
          // Explain mode: only the currently active component is visible
          if (!isActive) {
            isHidden = true;
          }
        }
      }

      // Create a mock boxSV resembling shared value structure
      const boxSV = { value: comp.box_2d };

      return {
        id: comp.id,
        hazard_ref: 'haz_motor',
        label: comp.label,
        type: isActive ? 'primary_hazard' : 'neutral_context',
        marker_type: 'ring',
        step_reference: null,
        depth_hint: 0.5,
        priority: 1,
        risk_level: 'LOW',
        vlmBox: comp.box_2d,
        liveBox: comp.box_2d,
        smoothedBox: comp.box_2d,
        boxSV,
        lostFrames: 0,
        isLost: false,
        isActive,
        isFaded,
        isHidden,
      } as any;
    });
  }, [components, activeComponentIndex, workflowState, guideSteps, activeStepIndex, activeMode, relatedParts, chatFocusTargetId, voiceSessionActive]);
}

// ─── Native Label Overlay ────────────────────────────────────────────────
function ARLabelNativeOverlay({
  target,
  isActive,
  isFaded,
  onPress,
}: {
  target: any;
  isActive: boolean;
  isFaded: boolean;
  onPress: () => void;
}) {
  const { width: screenW, height: screenH } = useWindowDimensions();

  const cx = useDerivedValue(() => {
    const [nx1, ny1, nx2, ny2] = target.boxSV.value;
    return ((nx1 + nx2) / 2) * screenW + arOffsetX.value;
  });

  const cy = useDerivedValue(() => {
    const [nx1, ny1, nx2, ny2] = target.boxSV.value;
    return ((ny1 + ny2) / 2) * screenH + arOffsetY.value;
  });

  const r = useDerivedValue(() => {
    const [nx1, ny1, nx2, ny2] = target.boxSV.value;
    const w = Math.abs(nx2 - nx1) * screenW;
    const h = Math.abs(ny2 - ny1) * screenH;
    const baseR = Math.max(w, h) / 2;
    return baseR;
  });

  // Calculate dynamic Euclidean distance to screen center
  const distance = useDerivedValue(() => {
    const centerScreenX = screenW / 2;
    const centerScreenY = screenH / 2;
    const dx = cx.value - centerScreenX;
    const dy = cy.value - centerScreenY;
    return Math.sqrt(dx * dx + dy * dy);
  });

  // Derived smoothstep opacity based on proximity to center
  const opacity = useDerivedValue(() => {
    if (isFaded) {
      const r_in = 80;
      const r_out = 250;
      const d = distance.value;
      const t = Math.max(0, Math.min(1, (d - r_in) / (r_out - r_in)));
      const smooth = 3 * t * t - 2 * t * t * t;
      const proximity = 1 - smooth;
      return 0.05 + 0.05 * proximity;
    }

    if (isActive) return 1.0;

    const r_in = 80;
    const r_out = 250;
    const d = distance.value;

    const t = Math.max(0, Math.min(1, (d - r_in) / (r_out - r_in)));
    const smooth = 3 * t * t - 2 * t * t * t;
    const proximity = 1 - smooth; // 1.0 when centered, 0.0 when far

    return 0.45 + (1.0 - 0.45) * proximity;
  });

  const color = isActive ? '#10B981' : 'rgba(255,255,255,0.45)';

  return (
    <ARLabelNative
      cx={cx}
      cy={cy}
      ringR={r}
      label={target.label}
      opacity={opacity}
      color={color}
      isCompact={false}
      mounted={true}
      onPress={onPress}
    />
  );
}

// ─── Component ────────────────────────────────────────────────────────────
export function AROverlayLayer() {
  const socketTargets   = useARTrackingStore((s) => s.targets);
  const chatFocusTargetId = useARTrackingStore((s) => s.chatFocusTargetId);
  const workflowState   = useWorkflowStore((s) => s.workflowState);
  const { components, setActiveComponentIndex } = useWorkflowStore();
  const voiceSessionActive = useWorkflowStore((s) => s.voiceSessionActive);
  const virtualTargets  = useVirtualTargets();

  // ── 3D Native AR anchors (Solution A path) ──────────────────────────────
  const arAnchors = useARAnchorStore((s) => s.anchors);
  const hasNativeAnchors = arAnchors.length > 0;

  // When native 3D anchors exist, render them and skip the screen-space branch
  if (hasNativeAnchors) {
    return (
      <View style={[StyleSheet.absoluteFill, { zIndex: 10 }]} pointerEvents="box-none">
        {/* Skia: rings + connector lines for all 3D anchors */}
        <Canvas style={StyleSheet.absoluteFill}>
          {arAnchors.map((anchor) => (
            <ARMarkerNativeSkia key={anchor.id} anchor={anchor} />
          ))}
        </Canvas>

        {/* RN: pill labels for all 3D anchors */}
        {arAnchors.map((anchor) => (
          <ARMarkerNativeLabel
            key={anchor.id}
            anchor={anchor}
            onPress={() => {
              // Tap label → find matching component and expand detail sheet
              const idx = components.findIndex(
                (c) => c.id === anchor.id || c.label === anchor.label
              );
              if (idx !== -1) setActiveComponentIndex(idx);
            }}
          />
        ))}
      </View>
    );
  }

  // ── Legacy screen-space branch (kept as fallback) ──────────────────────
  if (voiceSessionActive && workflowState !== 'INTERACTIVE_GUIDE' && !chatFocusTargetId) return null;

  const isSimulated =
    workflowState === 'EXPLORE_LABELS' ||
    workflowState === 'GUIDE_MODE';

  const shouldRender =
    isSimulated ||
    workflowState === 'INTERACTIVE_GUIDE' ||
    (voiceSessionActive && !!chatFocusTargetId) ||
    (socketTargets.length > 0 &&
      ((workflowState as any) === 'HAZARDS_DISCOVERED' ||
       (workflowState as any) === 'HAZARD_FOCUSED' ||
       (workflowState as any) === 'SHEET_OPEN'));

  if (!shouldRender) return null;

  const displayTargets = isSimulated ? virtualTargets : socketTargets;

  return (
    <View style={[StyleSheet.absoluteFill, { zIndex: 10 }]} pointerEvents="box-none">
      <Canvas style={StyleSheet.absoluteFill}>
        {displayTargets.map((target: any) => {
          if (target.isHidden) return null;
          if (voiceSessionActive && workflowState !== 'INTERACTIVE_GUIDE' && target.id !== chatFocusTargetId) return null;
          const isActive = isSimulated ? target.isActive : true;
          const isFaded  = isSimulated ? target.isFaded  : false;
          const levelVal = isActive ? 'HAZARD_FOCUS' : (isFaded ? 'DETECTION_FADED' : 'DETECTION');
          return (
            <ARMarker
              key={target.id}
              target={target}
              level={levelVal as any}
              spotlightTargetId={null}
              activeStepId={null}
              chatFocusTargetId={chatFocusTargetId}
              hasActiveStep={false}
            />
          );
        })}
      </Canvas>
      {displayTargets.map((target: any) => {
        if (target.isHidden) return null;
        if (voiceSessionActive && workflowState !== 'INTERACTIVE_GUIDE' && target.id !== chatFocusTargetId) return null;
        const isActive = isSimulated ? target.isActive : true;
        const isFaded  = isSimulated ? target.isFaded  : false;
        const handlePress = () => {
          const idx = components.findIndex((c) => c.id === target.id);
          if (idx !== -1) setActiveComponentIndex(idx);
        };
        return (
          <ARLabelNativeOverlay
            key={target.id}
            target={target}
            isActive={isActive}
            isFaded={isFaded}
            onPress={handlePress}
          />
        );
      })}
    </View>
  );
}


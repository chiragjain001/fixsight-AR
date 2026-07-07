/**
 * ARMarkerNative.tsx
 *
 * Renders a single 3D-grounded AR label.
 * Unlike the old ARMarker (screen-space IoU tracking), this reads screen
 * coordinates from SharedValues that are updated by the native 60fps
 * projection loop. Zero React renders per frame.
 *
 * Visual output:
 *   - Skia: pulsing ring + connector line (inside Canvas in AROverlayLayer)
 *   - RN Native: pill label with text (rendered outside Canvas)
 *
 * Exported:
 *   ARMarkerNativeSkia   — renders ring + connector. Use INSIDE <Canvas>
 *   ARMarkerNativeLabel  — renders text pill.        Use OUTSIDE <Canvas>
 */

import React, { useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  useWindowDimensions,
} from 'react-native';
import { Group, Line, Circle, Blur } from '@shopify/react-native-skia';
import Animated, {
  SharedValue,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import type { ARAnchor } from '../../store/arAnchorStore';

const RING_BASE_R   = 32;   // px — base ring radius at 1m depth
const CONNECTOR_GAP = 12;   // px between ring top and label bottom
const LABEL_H       = 28;   // px label pill height

// ─── Skia ring + connector (inside Canvas) ────────────────────────────────────

interface SkiaProps {
  anchor: ARAnchor;
}

export function ARMarkerNativeSkia({ anchor }: SkiaProps) {
  const pulseProgress = useSharedValue(0);
  const pulseOpacity  = useSharedValue(0);
  const mountOpacity  = useSharedValue(0);

  // Entrance animation on mount
  useEffect(() => {
    mountOpacity.value = withTiming(1, { duration: 400 });
    pulseProgress.value = withRepeat(
      withSequence(withTiming(0, { duration: 0 }), withTiming(1, { duration: 900 })),
      -1,
    );
    pulseOpacity.value = withRepeat(
      withSequence(withTiming(0.5, { duration: 0 }), withTiming(0, { duration: 900 })),
      -1,
    );
    return () => {
      mountOpacity.value = 0;
      pulseProgress.value = 0;
      pulseOpacity.value = 0;
    };
  }, []);

  // Depth-scaled ring radius: closer = bigger
  const r = useDerivedValue(() => {
    const scale = Math.max(0.5, Math.min(2.0, 1.0 / anchor.depth.value));
    return RING_BASE_R * scale;
  });

  const pulseR  = useDerivedValue(() => r.value + r.value * 0.6 * pulseProgress.value);
  const opacity = useDerivedValue(() =>
    anchor.isVisible.value ? mountOpacity.value : 0
  );

  // Connector: from label bottom → ring top
  const p1 = useDerivedValue(() => ({
    x: anchor.screenX.value,
    y: anchor.screenY.value - r.value - CONNECTOR_GAP - LABEL_H,
  }));
  const p2 = useDerivedValue(() => ({
    x: anchor.screenX.value,
    y: anchor.screenY.value - r.value - 2,
  }));

  return (
    <Group opacity={opacity}>
      {/* Outer expanding pulse */}
      <Group opacity={pulseOpacity}>
        <Circle
          cx={anchor.screenX}
          cy={anchor.screenY}
          r={pulseR}
          color={anchor.color}
          style="stroke"
          strokeWidth={1.5}
        />
      </Group>

      {/* Soft glow halo */}
      <Group opacity={useSharedValue(0.6)}>
        <Circle
          cx={anchor.screenX}
          cy={anchor.screenY}
          r={r}
          color={anchor.color}
          style="stroke"
          strokeWidth={9}
        >
          <Blur blur={14} />
        </Circle>
      </Group>

      {/* Crisp inner ring */}
      <Circle
        cx={anchor.screenX}
        cy={anchor.screenY}
        r={r}
        color={anchor.color}
        style="stroke"
        strokeWidth={3}
      />

      {/* Connector line */}
      <Line p1={p1} p2={p2} color={anchor.color} strokeWidth={0.9} style="stroke" />
    </Group>
  );
}

// ─── RN Native label pill (outside Canvas) ────────────────────────────────────

interface LabelProps {
  anchor: ARAnchor;
  onPress?: () => void;
}

export function ARMarkerNativeLabel({ anchor, onPress }: LabelProps) {
  const mountOffset  = useSharedValue(12);
  const mountOpacity = useSharedValue(0);

  useEffect(() => {
    mountOffset.value  = withSpring(0, { damping: 18, stiffness: 300 });
    mountOpacity.value = withTiming(1, { duration: 350 });
    return () => {
      mountOffset.value  = 12;
      mountOpacity.value = 0;
    };
  }, []);

  const labelW = Math.max(anchor.label.length * 8 + 28, 90);

  const r = useDerivedValue(() => {
    const scale = Math.max(0.5, Math.min(2.0, 1.0 / anchor.depth.value));
    return RING_BASE_R * scale;
  });

  const animStyle = useAnimatedStyle(() => ({
    left:    anchor.screenX.value - labelW / 2,
    top:     anchor.screenY.value - r.value - CONNECTOR_GAP - LABEL_H + mountOffset.value,
    opacity: anchor.isVisible.value ? mountOpacity.value : 0,
    transform: [{ scale: 1.0 }],
  }));

  const label = anchor.label.charAt(0).toUpperCase() + anchor.label.slice(1);

  return (
    <Animated.View
      style={[
        styles.pill,
        { borderColor: anchor.color, shadowColor: anchor.color, width: labelW },
        animStyle,
      ]}
    >
      <Pressable onPress={onPress} style={styles.pressable}>
        <View style={[styles.dot, { backgroundColor: anchor.color }]} />
        <Text style={styles.labelText} numberOfLines={1}>{label}</Text>
        {anchor.instruction ? (
          <Text style={styles.instructionText} numberOfLines={1}>
            {anchor.instruction}
          </Text>
        ) : null}
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  pill: {
    position: 'absolute',
    height: LABEL_H,
    backgroundColor: 'rgba(15,18,25,0.90)',
    borderRadius: 99,
    borderWidth: 1.2,
    zIndex: 100,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.65,
    shadowRadius: 10,
    elevation: 6,
    overflow: 'hidden',
  },
  pressable: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    gap: 5,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  labelText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.15,
    flexShrink: 1,
  },
  instructionText: {
    color: 'rgba(255,255,255,0.50)',
    fontSize: 9,
    fontWeight: '500',
    flexShrink: 1,
  },
});

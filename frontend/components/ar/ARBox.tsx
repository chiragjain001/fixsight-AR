import React, { useEffect } from 'react';
import { Group, RoundedRect, Path, Blur } from '@shopify/react-native-skia';
import {
  SharedValue,
  useDerivedValue,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

interface Props {
  x: SharedValue<number>;
  y: SharedValue<number>;
  w: SharedValue<number>;
  h: SharedValue<number>;
  opacity: SharedValue<number>;
  color: string;
  isCompact: boolean;
  isActive: boolean;
}

export function ARBox({ x, y, w, h, opacity, color, isCompact, isActive }: Props) {
  const pulseOpacity = useSharedValue(0);
  const floatOffset = useSharedValue(0);

  useEffect(() => {
    const dur = isActive ? 850 : 1800;
    pulseOpacity.value = withRepeat(
      withSequence(
        withTiming(isCompact ? 0 : 0.55, { duration: 0 }),
        withTiming(0, { duration: dur })
      ),
      -1
    );
    floatOffset.value = withRepeat(
      withSequence(
        withTiming(15, { duration: dur }),
        withTiming(0, { duration: dur })
      ),
      -1,
      true
    );
    return () => {
      pulseOpacity.value = 0;
      floatOffset.value = 0;
    };
  }, [isCompact, isActive]);

  const strokeW = useDerivedValue(() => (isActive ? 3.5 : isCompact ? 1.5 : 2.5));
  const glowBlur = useDerivedValue(() => (isCompact ? 3 : isActive ? 16 : 9));
  const glowOpacity = useDerivedValue(() => (isCompact ? 0.25 : isActive ? 0.75 : 0.55));

  // Construct a bouncing arrow path pointing down to the top of the box
  const arrowPath = useDerivedValue(() => {
    const arrowX = x.value + w.value / 2;
    // Arrow ends 10px above the box, starts 40px higher
    const arrowBottomY = Math.max(0, y.value - 10 - floatOffset.value);
    const arrowTopY = arrowBottomY - 30;

    return `M ${arrowX} ${arrowTopY} L ${arrowX} ${arrowBottomY} M ${arrowX - 10} ${arrowBottomY - 10} L ${arrowX} ${arrowBottomY} L ${arrowX + 10} ${arrowBottomY - 10}`;
  });

  return (
    <Group opacity={opacity}>
      {/* Box Glow */}
      <Group opacity={glowOpacity}>
        <RoundedRect x={x} y={y} width={w} height={h} r={8} color={color} style="stroke" strokeWidth={6}>
          <Blur blur={glowBlur} />
        </RoundedRect>
      </Group>

      {/* Crisp Inner Box */}
      <RoundedRect x={x} y={y} width={w} height={h} r={8} color={color} style="stroke" strokeWidth={strokeW} />

      {/* Animated Arrow */}
      <Group opacity={glowOpacity}>
        <Path path={arrowPath} color={color} style="stroke" strokeWidth={5} strokeJoin="round" strokeCap="round">
          <Blur blur={glowBlur} />
        </Path>
      </Group>
      <Path path={arrowPath} color={color} style="stroke" strokeWidth={strokeW} strokeJoin="round" strokeCap="round" />
    </Group>
  );
}

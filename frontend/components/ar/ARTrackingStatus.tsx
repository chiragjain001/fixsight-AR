/**
 * ARTrackingStatus.tsx
 * Shows a non-intrusive banner when AR tracking quality degrades.
 * Auto-dismisses when tracking returns to normal.
 */

import React from 'react';
import { StyleSheet, Text } from 'react-native';
import Animated, {
  FadeInDown,
  FadeOutUp,
} from 'react-native-reanimated';
import { useARAnchorStore } from '../../store/arAnchorStore';

const MESSAGES: Record<string, string> = {
  limited:       'Move phone slowly for better AR tracking',
  not_available: 'Tracking lost — point at a textured surface',
  unsupported:   'AR not supported on this device',
  initializing:  'Initializing AR…',
};

export function ARTrackingStatus() {
  const state = useARAnchorStore((s) => s.trackingState);

  // Only show for degraded or initializing states
  const msg = MESSAGES[state];
  if (!msg || state === 'normal') return null;

  const isError = state === 'not_available' || state === 'unsupported';

  return (
    <Animated.View
      entering={FadeInDown.duration(300)}
      exiting={FadeOutUp.duration(250)}
      style={[styles.banner, isError && styles.bannerError]}
      pointerEvents="none"
    >
      <Text style={styles.text}>{isError ? '⚠ ' : '◌ '}{msg}</Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  banner: {
    position: 'absolute',
    bottom: 120,
    alignSelf: 'center',
    backgroundColor: 'rgba(15,18,25,0.80)',
    borderRadius: 20,
    paddingHorizontal: 18,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: 'rgba(59,130,246,0.4)',
    zIndex: 200,
  },
  bannerError: {
    borderColor: 'rgba(239,68,68,0.4)',
  },
  text: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.2,
  },
});

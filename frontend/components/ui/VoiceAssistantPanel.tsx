import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withRepeat,
  withSequence,
  cancelAnimation,
  withSpring,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X, Square } from 'lucide-react-native';
import { useWorkflowStore } from '../../store/workflowStore';
import { useVoiceSession } from '../../hooks/useVoiceSession';
import * as Speech from 'expo-speech';

function BarView({ height, scaleY }: { height: number; scaleY: any }) {
  const style = useAnimatedStyle(() => ({
    transform: [{ scaleY: scaleY.value }],
  }));

  return (
    <Animated.View
      style={[{ width: 4, height, backgroundColor: '#fff', borderRadius: 2 }, style]}
    />
  );
}

function SoundwaveBars({ bars }: { bars: { h: number; delay: number }[] }) {
  const s0 = useSharedValue(0.3);
  const s1 = useSharedValue(0.3);
  const s2 = useSharedValue(0.3);
  const s3 = useSharedValue(0.3);
  const s4 = useSharedValue(0.3);
  const svs = [s0, s1, s2, s3, s4];
  
  useEffect(() => {
    svs.forEach((sv, i) => {
      if (!bars[i]) return;
      const dur = 400 + bars[i].delay;
      sv.value = withRepeat(
        withSequence(
          withTiming(1,   { duration: dur }),
          withTiming(0.3, { duration: dur })
        ),
        -1,
        true
      );
    });
    return () => {
      svs.forEach(sv => {
        cancelAnimation(sv);
        sv.value = 0.3;
      });
    };
  }, []);
  
  return (
    <View style={styles.bars}>
      {bars.map((bar, i) => (
        <BarView key={i} height={bar.h} scaleY={svs[i]} />
      ))}
    </View>
  );
}

// ─── Pulse ring ───────────────────────────────────────────────────────────────
function PulseRing({ metering, voicePhase, ringColor }: {
  metering: number;
  voicePhase: string;
  ringColor: string;
}) {
  const pulse = useSharedValue(1);

  useEffect(() => {
    pulse.value = withRepeat(
      withSequence(
        withTiming(1.12, { duration: 1200 }),
        withTiming(1,    { duration: 1200 })
      ),
      -1,
      true
    );
    return () => {
      cancelAnimation(pulse);
      pulse.value = 1; // safe static before unmount
    };
  }, []);

  const ringStyle = useAnimatedStyle(() => {
    const amp =
      voicePhase !== 'ANALYZING'
        ? Math.max(1, 1 + (metering + 60) / 200)
        : 1;
    return { transform: [{ scale: pulse.value * amp }] };
  });

  return (
    <Animated.View
      style={[styles.glowRing, { borderColor: ringColor }, ringStyle]}
    />
  );
}

// ─── Inner panel content (only mounted while session is truly active) ─────────
// Keeping animated children in a sub-component means their cleanup useEffects
// run BEFORE the parent null-returns, giving Reanimated time to stop loops.
function PanelContent({
  insets,
  metering,
  manualStop,
}: {
  insets: ReturnType<typeof useSafeAreaInsets>;
  metering: number;
  manualStop: () => void;
}) {
  const store = useWorkflowStore();

  const stopBtnScale = useSharedValue(1);
  const stopBtnStyle = useAnimatedStyle(() => ({
    transform: [{ scale: stopBtnScale.value }]
  }));

  const phaseLabel =
    store.voicePhase === 'LISTENING' ? 'Listening...' :
    ['ANALYZING', 'THINKING', 'VLM_RUNNING'].includes(store.voicePhase) ? 'Thinking...' :
    'Speaking...';

  const phaseSub =
    store.voicePhase === 'LISTENING'  ? "Speak naturally, I'll listen"  :
    store.voicePhase === 'ANALYZING'  ? 'Processing your question...'   :
    store.voicePhase === 'THINKING'   ? 'Sending to AI...'              :
    store.voicePhase === 'VLM_RUNNING'? 'Checking the scene...'         :
                                        'Tap stop to interrupt';

  const ringColor =
    store.voicePhase === 'LISTENING' ? '#3B82F6' :
    ['ANALYZING', 'THINKING', 'VLM_RUNNING'].includes(store.voicePhase) ? '#8B5CF6' :
    '#10B981';

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">

      {/* ── Close (X) button — top left ── */}
      <Pressable
        style={[styles.closeBtnFloat, { top: insets.top + 12, left: 16 }]}
        onPress={() => {
          Speech.stop();
          store.endVoiceSession();
        }}
        hitSlop={16}
      >
        <View style={styles.closeBtnInner}>
          <X size={18} color="#fff" />
        </View>
      </Pressable>

      {/* ── Bottom voice card ── */}
      <View
        style={[styles.bottomCard, { paddingBottom: insets.bottom + 20 }]}
        pointerEvents="box-none"
      >
        {/* Animated ring + icon */}
        <View style={styles.circleWrap}>
          <PulseRing
            metering={metering}
            voicePhase={store.voicePhase}
            ringColor={ringColor}
          />
          <View style={[styles.innerCircle, { borderColor: ringColor }]}>
            {store.voicePhase === 'LISTENING' && (
              <SoundwaveBars bars={[
                {h:14, delay:0}, {h:26, delay:60}, {h:36, delay:30}, {h:26, delay:90}, {h:14, delay:45}
              ]} />
            )}
            {['ANALYZING', 'THINKING', 'VLM_RUNNING'].includes(store.voicePhase) && (
              <Text style={styles.dotsText}>···</Text>
            )}
            {store.voicePhase === 'ANSWERING' && (
              <SoundwaveBars bars={[
                {h:10, delay:80}, {h:30, delay:0}, {h:36, delay:50}, {h:30, delay:20}, {h:10, delay:70}
              ]} />
            )}
          </View>
        </View>

        {/* Phase text */}
        <Text style={[styles.phaseLabel, { color: ringColor }]}>{phaseLabel}</Text>
        <Text style={styles.phaseSub}>{phaseSub}</Text>

        {/* Stop button */}
        <Animated.View style={stopBtnStyle}>
          <Pressable
            style={styles.stopBtn}
            onPressIn={() => { stopBtnScale.value = withSpring(0.92, { damping: 10, stiffness: 200 }); }}
            onPressOut={() => { stopBtnScale.value = withSpring(1, { damping: 10, stiffness: 200 }); }}
            onPress={() => {
              console.log('[UI] Stop button pressed, phase:', store.voicePhase);
              manualStop();
            }}
            hitSlop={12}
          >
            <Square size={14} color="#EF4444" fill="#EF4444" />
            <Text style={styles.stopText}>Stop</Text>
          </Pressable>
        </Animated.View>
      </View>
    </View>
  );
}

export function VoiceAssistantPanel() {
  const insets = useSafeAreaInsets();
  const store  = useWorkflowStore();
  const { metering, manualStop } = useVoiceSession();

  // PanelContent (with all infinite animations) only mounts when session is active.
  // This ensures cleanup useEffects (cancelAnimation) run before the node leaves the tree.
  if (!store.voiceSessionActive) return null;

  return (
    <PanelContent
      insets={insets}
      metering={metering}
      manualStop={manualStop}
    />
  );
}

const styles = StyleSheet.create({
  closeBtnFloat: {
    position: 'absolute',
    zIndex: 100,
  },
  closeBtnInner: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  bottomCard: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    alignItems: 'center',
    paddingTop: 24,
    backgroundColor: 'rgba(8, 10, 18, 0.82)',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    borderTopWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  circleWrap: {
    width: 110,
    height: 110,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  glowRing: {
    position: 'absolute',
    width: 110,
    height: 110,
    borderRadius: 55,
    borderWidth: 1.5,
    opacity: 0.4,
  },
  innerCircle: {
    width: 80,
    height: 80,
    borderRadius: 40,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  bars: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  dotsText: {
    color: '#A78BFA',
    fontSize: 28,
    letterSpacing: 4,
    fontWeight: '700',
  },
  phaseLabel: {
    fontSize: 18,
    fontWeight: '700',
    letterSpacing: 0.3,
    marginBottom: 4,
  },
  phaseSub: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.45)',
    marginBottom: 20,
  },
  stopBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 24,
    backgroundColor: 'rgba(239,68,68,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(239,68,68,0.35)',
    marginBottom: 8,
  },
  stopText: {
    color: '#EF4444',
    fontWeight: '600',
    fontSize: 14,
  },
});

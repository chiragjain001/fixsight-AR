/**
 * ARNativeView.tsx
 * Thin React wrapper around the native ARSCNView (iOS) / GLSurfaceView (Android).
 * This is the camera feed — it replaces <Camera /> from VisionCamera.
 */

import React from 'react';
import { StyleSheet, requireNativeComponent, ViewStyle, View } from 'react-native';
import { AR_NATIVE_VIEW_NAME } from '../../modules/ar-session';

let NativeARView: React.ComponentType<{ style?: ViewStyle }> | null = null;
try {
  NativeARView = requireNativeComponent<{ style?: ViewStyle }>(AR_NATIVE_VIEW_NAME);
} catch (e) {
  console.warn('[ARNativeView] Native AR view not available on this device:', e);
}

interface Props {
  style?: ViewStyle;
}

export function ARNativeView({ style }: Props) {
  if (!NativeARView) {
    // Fallback: transparent view — app still works, just no AR overlay
    return <View style={[StyleSheet.absoluteFill, style]} />;
  }
  return <NativeARView style={[StyleSheet.absoluteFill, style]} />;
}

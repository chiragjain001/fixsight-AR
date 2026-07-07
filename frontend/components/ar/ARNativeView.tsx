/**
 * ARNativeView.tsx
 * Thin React wrapper around the native ARSCNView (iOS) / GLSurfaceView (Android).
 * This is the camera feed — it replaces <Camera /> from VisionCamera.
 */

import React from 'react';
import { StyleSheet, requireNativeComponent, ViewStyle } from 'react-native';
import { AR_NATIVE_VIEW_NAME } from '../../modules/ar-session';

const NativeARView = requireNativeComponent<{ style?: ViewStyle }>(
  AR_NATIVE_VIEW_NAME
);

interface Props {
  style?: ViewStyle;
}

export function ARNativeView({ style }: Props) {
  return <NativeARView style={[StyleSheet.absoluteFill, style]} />;
}

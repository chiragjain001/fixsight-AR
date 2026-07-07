import React, { useState } from 'react';
import {
  View,
  TextInput,
  TouchableOpacity,
  Text,
  StyleSheet,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { ViroARSceneNavigator } from '@reactvision/react-viro';
import ARGuideScene from '../components/ARGuideScene';
import { useARGuide } from '../hooks/useARGuide';

export default function ARGuideScreen() {
  const {
    arNavigatorRef,
    pendingLabels,
    anchoredLabels,
    onAnchored,
    isThinking,
    error,
    askQuery,
    reset,
  } = useARGuide();
  const [query, setQuery] = useState('');

  const handleSubmit = () => {
    if (!query.trim() || isThinking) return;
    askQuery(query.trim());
    setQuery('');
  };

  return (
    <View style={styles.fill}>
      <ViroARSceneNavigator
        ref={arNavigatorRef}
        autofocus
        worldAlignment="Gravity"
        initialScene={{ scene: ARGuideScene }}
        viroAppProps={{ pendingLabels, onAnchored }}
        style={styles.fill}
      />

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.overlay}
        pointerEvents="box-none"
      >
        {error ? (
          <View style={styles.errorBanner}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}

        {anchoredLabels.length > 0 ? (
          <TouchableOpacity style={styles.clearButton} onPress={reset}>
            <Text style={styles.clearButtonText}>Clear labels</Text>
          </TouchableOpacity>
        ) : null}

        <View style={styles.queryBar}>
          <TextInput
            style={styles.input}
            placeholder="Ask about what you're looking at…"
            placeholderTextColor="#9CA3AF"
            value={query}
            onChangeText={setQuery}
            onSubmitEditing={handleSubmit}
            returnKeyType="send"
            editable={!isThinking}
          />
          <TouchableOpacity style={styles.sendButton} onPress={handleSubmit} disabled={isThinking}>
            {isThinking ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={styles.sendButtonText}>Ask</Text>
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  overlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    padding: 16,
  },
  queryBar: {
    flexDirection: 'row',
    backgroundColor: '#111827E6',
    borderRadius: 24,
    padding: 6,
    alignItems: 'center',
  },
  input: {
    flex: 1,
    color: '#FFFFFF',
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
  },
  sendButton: {
    backgroundColor: '#3B82F6',
    borderRadius: 18,
    paddingHorizontal: 18,
    paddingVertical: 10,
  },
  sendButtonText: { color: '#FFFFFF', fontWeight: '600' },
  errorBanner: {
    backgroundColor: '#7F1D1DE6',
    borderRadius: 12,
    padding: 10,
    marginBottom: 10,
  },
  errorText: { color: '#FECACA', fontSize: 13 },
  clearButton: {
    alignSelf: 'flex-start',
    backgroundColor: '#111827E6',
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 8,
    marginBottom: 10,
  },
  clearButtonText: { color: '#FFFFFF', fontSize: 13 },
});

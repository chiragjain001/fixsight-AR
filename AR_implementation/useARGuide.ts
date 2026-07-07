import { useCallback, useRef, useState } from 'react';
import * as FileSystem from 'expo-file-system';
// Bare React Native (no Expo)? Swap the import above for react-native-fs and use
// RNFS.readFile(path, 'base64') instead of FileSystem.readAsStringAsync below.
import { groundQuery } from '../services/vlmService';
import type { AnchoredLabel, GroundedLabel } from '../types';

export function useARGuide() {
  const arNavigatorRef = useRef<any>(null);
  const [pendingLabels, setPendingLabels] = useState<GroundedLabel[]>([]);
  const [anchoredLabels, setAnchoredLabels] = useState<AnchoredLabel[]>([]);
  const [isThinking, setIsThinking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Called by ARGuideScene once it has hit-tested a batch of pending labels. */
  const onAnchored = useCallback((labels: AnchoredLabel[]) => {
    setAnchoredLabels((prev) => [...prev, ...labels]);
    setIsThinking(false);
  }, []);

  /** Clears all AR labels, e.g. when the user starts a fresh scan. */
  const reset = useCallback(() => {
    setPendingLabels([]);
    setAnchoredLabels([]);
    setError(null);
  }, []);

  /** Main entry point: user typed/spoke a query, go find and label the answer. */
  const askQuery = useCallback(async (query: string) => {
    if (!arNavigatorRef.current) return;
    setIsThinking(true);
    setError(null);
    try {
      // 1. Grab the current camera frame from the AR view itself - this is the
      // same feed the user is looking at, so VLM coordinates line up with what's
      // on screen. Viro writes it to a temp file rather than returning bytes.
      const shot = await arNavigatorRef.current.takeScreenshot(
        `ar-guide-${Date.now()}`,
        false, // don't clutter the user's camera roll
      );
      if (!shot?.success) throw new Error('Could not capture the camera frame');

      const base64 = await FileSystem.readAsStringAsync(shot.url, {
        encoding: FileSystem.EncodingType.Base64,
      });
      const dataUrl = `data:image/jpeg;base64,${base64}`;

      // 2. Ask the VLM what's relevant and where it is in the frame.
      const grounded = await groundQuery(dataUrl, query);
      if (!grounded.length) {
        setError("Couldn't find anything relevant in view - try pointing at the device.");
        setIsThinking(false);
        return;
      }

      // 3. Hand off normalized points to the scene; it hit-tests them into 3D
      // and calls onAnchored() above when done.
      setPendingLabels((prev) => [...prev, ...grounded]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
      setIsThinking(false);
    }
  }, []);

  return {
    arNavigatorRef,
    pendingLabels,
    anchoredLabels,
    onAnchored,
    isThinking,
    error,
    askQuery,
    reset,
  };
}

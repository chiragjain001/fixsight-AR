import React, { useEffect, useRef, useState } from 'react';
import { Dimensions, PixelRatio } from 'react-native';
import { ViroARScene, ViroAmbientLight } from '@reactvision/react-viro';
import ARLabelNode from './ARLabelNode';
import type { AnchoredLabel, GroundedLabel } from '../types';

interface ArHitTestResult {
  type: 'ExistingPlaneUsingExtent' | 'ExistingPlane' | 'EstimatedHorizontalPlane' | 'FeaturePoint' | 'DepthPoint';
  transform: { position: number[]; rotation: number[]; scale: number[] };
}

// Preference order: real surfaces first, loose feature points as fallback.
const TYPE_PRIORITY = [
  'ExistingPlaneUsingExtent',
  'ExistingPlane',
  'DepthPoint',
  'EstimatedHorizontalPlane',
  'FeaturePoint',
];

function pickBestHit(results: ArHitTestResult[]): ArHitTestResult | null {
  if (!results?.length) return null;
  return [...results].sort(
    (a, b) => TYPE_PRIORITY.indexOf(a.type) - TYPE_PRIORITY.indexOf(b.type),
  )[0];
}

// ViroReact passes data down into a scene via viroAppProps on the navigator, since
// the navigator instantiates the scene internally (you don't render <ARGuideScene>
// directly - see ARGuideScreen.tsx).
interface SceneProps {
  sceneNavigator: {
    viroAppProps: {
      pendingLabels: GroundedLabel[];
      onAnchored: (labels: AnchoredLabel[]) => void;
    };
  };
}

export default function ARGuideScene({ sceneNavigator }: SceneProps) {
  const { pendingLabels, onAnchored } = sceneNavigator.viroAppProps;
  const sceneRef = useRef<ViroARScene>(null);
  const [anchoredLabels, setAnchoredLabels] = useState<AnchoredLabel[]>([]);
  const processedIds = useRef(new Set<string>());

  useEffect(() => {
    const toProcess = pendingLabels.filter((l) => !processedIds.current.has(l.id));
    if (!toProcess.length || !sceneRef.current) return;

    (async () => {
      const { width, height } = Dimensions.get('window');
      const ratio = PixelRatio.get();

      const results = await Promise.all(
        toProcess.map(async (label) => {
          processedIds.current.add(label.id);
          // Normalized VLM coords -> device pixel coords, as performARHitTestWithPoint expects.
          const px = label.xNorm * width * ratio;
          const py = label.yNorm * height * ratio;

          const hits: ArHitTestResult[] = await (sceneRef.current as any).performARHitTestWithPoint(
            px,
            py,
          );
          const best = pickBestHit(hits);

          const anchored: AnchoredLabel = best
            ? { ...label, worldPosition: best.transform.position as [number, number, number], anchorFound: true }
            : // Fallback so the UI never silently drops a label: place it a fixed
              // distance in front of the camera along the same screen direction.
              { ...label, worldPosition: [0, 0, -0.5], anchorFound: false };

          return anchored;
        }),
      );

      setAnchoredLabels((prev) => [...prev, ...results]);
      onAnchored(results);
    })();
  }, [pendingLabels, onAnchored]);

  return (
    <ViroARScene ref={sceneRef} anchorDetectionTypes={['PlanesHorizontal', 'PlanesVertical']}>
      <ViroAmbientLight color="#FFFFFF" intensity={300} />
      {anchoredLabels.map((label) => (
        <ARLabelNode key={label.id} anchored={label} />
      ))}
    </ViroARScene>
  );
}

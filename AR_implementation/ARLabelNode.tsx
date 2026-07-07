import React from 'react';
import {
  ViroNode,
  ViroSphere,
  ViroPolyline,
  ViroFlexView,
  ViroText,
  ViroMaterials,
} from '@reactvision/react-viro';
import type { AnchoredLabel } from '../types';

ViroMaterials.createMaterials({
  labelDot: { diffuseColor: '#3B82F6' },
  labelLine: { diffuseColor: '#3B82F6' },
});

const LABEL_OFFSET: [number, number, number] = [0, 0.06, 0]; // 6cm above the anchor point

interface Props {
  anchored: AnchoredLabel;
}

/**
 * Renders one AR callout: a small dot pinned to the real-world anchor point, a thin
 * line running up from it, and a camera-facing text card at the end of the line -
 * the same "dot + leader line + floating label" pattern from the reference video.
 *
 * Because this whole group is parented under a ViroNode at a fixed world position,
 * ARKit/ARCore's own tracking keeps it visually pinned to the physical point as the
 * camera moves - no per-frame repositioning logic needed on the JS side.
 */
export default function ARLabelNode({ anchored }: Props) {
  return (
    <ViroNode position={anchored.worldPosition}>
      {/* Anchor dot at the physical point */}
      <ViroSphere radius={0.006} materials={['labelDot']} />

      {/* Leader line from the physical point up to the floating label */}
      <ViroPolyline
        points={[
          [0, 0, 0],
          LABEL_OFFSET,
        ]}
        thickness={0.0015}
        materials={['labelLine']}
      />

      {/* Floating label card, always facing the camera */}
      <ViroNode position={LABEL_OFFSET} transformBehaviors={['billboard']}>
        <ViroFlexView
          style={styles.card}
          width={0.5}
          height={anchored.instruction ? 0.14 : 0.08}
        >
          <ViroText
            text={anchored.label}
            style={styles.title}
            width={0.46}
            height={0.06}
          />
          {anchored.instruction ? (
            <ViroText
              text={anchored.instruction}
              style={styles.subtitle}
              width={0.46}
              height={0.06}
            />
          ) : null}
        </ViroFlexView>
      </ViroNode>
    </ViroNode>
  );
}

const styles = {
  card: {
    flexDirection: 'column' as const,
    backgroundColor: '#111827CC', // translucent dark card, like the reference video
    padding: 0.012,
  },
  title: {
    fontFamily: 'Arial',
    fontSize: 14,
    fontWeight: '700' as const,
    color: '#FFFFFF',
  },
  subtitle: {
    fontFamily: 'Arial',
    fontSize: 11,
    color: '#D1D5DB',
  },
};

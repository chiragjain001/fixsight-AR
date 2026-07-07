// Shared types for the VLM-guided AR labeling feature

/** A single labeled point the VLM found in the frame, in normalized (0-1) image coordinates. */
export interface GroundedLabel {
  id: string;
  label: string;       // short text shown in the AR callout, e.g. "Reset button"
  instruction?: string; // optional one-line guidance, e.g. "Hold for 5 seconds"
  xNorm: number;        // 0-1, left to right
  yNorm: number;        // 0-1, top to bottom
}

/** A GroundedLabel after it has been hit-tested into 3D world space. */
export interface AnchoredLabel extends GroundedLabel {
  worldPosition: [number, number, number]; // AR world space (meters)
  anchorFound: boolean; // false = we fell back to a camera-relative placement
}

export interface VLMReasonResult {
  parts: Array<{ label: string; instruction?: string }>;
}

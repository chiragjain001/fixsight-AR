/**
 * VLM grounding service.
 *
 * Two calls, both to Moondream's free-tier cloud API:
 *   1. reasonAboutQuery()  - "what part(s) of this device answer the user's question?"
 *   2. pointToLabel()      - "where exactly is that part, in normalized image coords?"
 *
 * Splitting these into two calls keeps each one small/fast and lets you swap either
 * side out later (e.g. use Gemini or Claude for step 1's reasoning, keep Moondream
 * for step 2's pointing, which it's specifically tuned for).
 *
 * Get a free API key at https://moondream.ai (Moondream Cloud console).
 * NEVER ship the raw key in a production client bundle - proxy this through your
 * own backend so the key isn't extractable from the app. Fine to call directly
 * from the device while prototyping.
 */
import type { GroundedLabel, VLMReasonResult } from '../types';

const MOONDREAM_BASE_URL = 'https://api.moondream.ai/v1';

// Swap this for a value pulled from secure config / your backend proxy.
const MOONDREAM_API_KEY = process.env.MOONDREAM_API_KEY ?? '';

interface PointResponse {
  points: Array<{ x: number; y: number }>;
}

async function moondreamFetch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${MOONDREAM_BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Moondream-Auth': MOONDREAM_API_KEY,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Moondream ${path} failed: ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

/**
 * Step 1: ask the VLM which physical part(s) answer the user's query, given the
 * current camera frame. Uses Moondream's open-ended /query skill and asks for
 * strict JSON back so it's trivial to parse.
 */
export async function reasonAboutQuery(
  imageDataUrl: string,
  userQuery: string,
): Promise<VLMReasonResult> {
  const prompt = [
    `The user is looking at a physical device through their camera and asked: "${userQuery}".`,
    'Identify the specific physical part(s), button(s), port(s), or control(s) visible',
    'in the image that are relevant to answering this. Respond with ONLY compact JSON',
    'in this exact shape, no markdown, no commentary:',
    '{"parts":[{"label":"short part name","instruction":"one short actionable sentence"}]}',
    'Return at most 3 parts. If nothing in the image is relevant, return {"parts":[]}.',
  ].join(' ');

  const result = await moondreamFetch<{ answer: string }>('/query', {
    image_url: imageDataUrl,
    question: prompt,
    reasoning: false,
  });

  try {
    const cleaned = result.answer.trim().replace(/^```json\s*|```$/g, '');
    return JSON.parse(cleaned) as VLMReasonResult;
  } catch {
    console.warn('Could not parse VLM reasoning response:', result.answer);
    return { parts: [] };
  }
}

/**
 * Step 2: for a single part label, get its normalized (0-1) center point in the
 * current frame using Moondream's /point skill, which is purpose-built for this
 * ("zero-shot pointing" - works on any object description, not a fixed class list).
 */
export async function pointToLabel(
  imageDataUrl: string,
  label: string,
): Promise<{ xNorm: number; yNorm: number } | null> {
  const result = await moondreamFetch<PointResponse>('/point', {
    image_url: imageDataUrl,
    object: label,
  });
  if (!result.points?.length) return null;
  // If multiple instances match, take the first - good enough for most single-device
  // scenes. For cluttered scenes, prefer the point closest to the frame center.
  const { x, y } = result.points[0];
  return { xNorm: x, yNorm: y };
}

/**
 * Full grounding pipeline for one user query against one camera frame.
 * Returns a flat list of labels with normalized image coordinates, ready to be
 * hit-tested into 3D world space by the AR layer.
 */
export async function groundQuery(
  imageDataUrl: string,
  userQuery: string,
): Promise<GroundedLabel[]> {
  const { parts } = await reasonAboutQuery(imageDataUrl, userQuery);
  if (!parts.length) return [];

  // Point calls are independent - run them in parallel to cut total latency.
  const pointed = await Promise.all(
    parts.map(async (part) => {
      const point = await pointToLabel(imageDataUrl, part.label);
      return point ? { ...part, ...point } : null;
    }),
  );

  return pointed
    .filter((p): p is NonNullable<typeof p> => p !== null)
    .map((p, i) => ({
      id: `${Date.now()}-${i}`,
      label: p.label,
      instruction: p.instruction,
      xNorm: p.xNorm,
      yNorm: p.yNorm,
    }));
}

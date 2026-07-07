# Architecture: VLM-guided AR labeling

## What the reference behavior actually is

A callout — a small dot connected by a line to a floating text label — stays
visually locked onto a physical point on an object as the camera moves around
it. That's two separate systems working together, and keeping them separate is
the whole trick to making this feel fast:

1. **Understanding** (slow, ~1-3s, happens occasionally): a vision-language
   model looks at a frame and a text query, and says "the thing you're asking
   about is at this pixel."
2. **Tracking** (fast, 30-60fps, happens continuously): the phone's own AR
   engine (ARKit/ARCore) uses its camera + gyroscope + accelerometer to know
   exactly how the phone has moved since that pixel was identified, and
   repositions everything accordingly — natively, on the GPU, with zero AI
   calls involved.

If you only build #1 and re-run it every frame, the app will feel slow and
janky, and you'll burn through free-tier API quota in seconds. If you lean on
#2 for what it's good at, the VLM only has to run once per question and
everything in between feels instant, because it *is* instant — it's just
native rendering.

## Pipeline

```
User asks a question
        │
        ▼
Capture + downscale current camera frame  (one JPEG, ~768px wide)
        │
        ▼
VLM grounding call — Moondream, runs once per query
   step a: reason about which part(s) answer the question
   step b: point() each part → normalized (x, y) in the frame
        │
        ▼
2D point → 3D hit test  (ARKit / ARCore raycast against the live scene)
        │
        ▼
Anchor + billboard label, held in place by native AR tracking
(60fps, zero further VLM calls, until the next question)
```

## Why two VLM calls instead of one

`vlmService.ts` splits grounding into `reasonAboutQuery()` and `pointToLabel()`
rather than asking one model to do both reasoning and pixel-accurate pointing
in a single shot. Two reasons:

- **Moondream's `/point` skill is purpose-trained for spatial grounding** —
  zero-shot, works on any text description, and is noticeably more accurate at
  "where exactly is X" than asking a general-purpose VQA model to also emit
  coordinates in the same breath as its reasoning.
- It lets you swap the reasoning half for a different model later (Gemini,
  Claude, a local model) without touching the pointing half, or vice versa.

The two `/point` calls per query run in parallel (`Promise.all` in
`groundQuery()`), so total latency is roughly one reasoning call + one point
call, not one call per part.

## The 2D → 3D hit test

`ARGuideScene.tsx` converts a normalized image coordinate into a 3D world
position with:

```ts
const px = label.xNorm * screenWidth * pixelRatio;
const py = label.yNorm * screenHeight * pixelRatio;
const hits = await sceneRef.current.performARHitTestWithPoint(px, py);
```

`performARHitTestWithPoint` is built into ViroReact — it wraps ARKit's/ARCore's
native raycasting, so no custom Swift/Kotlin module is needed. It returns
candidates of several types; the code prefers real detected surfaces
(`ExistingPlaneUsingExtent`) and falls back to raw feature points, which
matters a lot for small electronics: a reset button or a port usually isn't
sitting on a large flat plane the way a table or wall is, so you'll often be
relying on feature points or, on LiDAR-equipped iPhones/iPads, the depth API
(`depthEnabled` on `ViroARSceneNavigator`, giving `DepthPoint` results, which
are meaningfully more accurate for small targets).

**Known rough edge to test on real devices:** the mapping above assumes the
screenshot Viro captures is the same aspect/resolution as `Dimensions.get('window')
× PixelRatio`. That generally holds, but safe-area insets and some
tablet/foldable layouts can shift it slightly. For production robustness,
decode the actual captured image's width/height (e.g. with `Image.getSize`)
and compute the pixel coordinates from *that*, rather than the window
dimensions.

If no hit test candidate is found at all (e.g. pointed at open space), the
current code falls back to placing the label a fixed distance in front of the
camera rather than silently dropping it — better to show something plausible
than nothing.

## Performance rules that matter most

1. **Never call the VLM every frame.** Trigger it only on an explicit query
   (and optionally a manual "rescan" button). This is the single biggest
   lever — everything else is secondary.
2. **Downscale before sending.** A 768px-wide JPEG is plenty for pointing
   accuracy and cuts upload + inference time substantially versus a full
   12MP camera frame.
3. **Run independent VLM calls in parallel**, not sequentially (see
   `groundQuery`).
4. **Let native tracking do the work between queries.** Anchored `ViroNode`s
   don't need any JS-side per-frame position updates — ARKit/ARCore keeps
   them pinned as part of normal scene rendering.
5. **Cap how many labels you place per query** (the reasoning prompt in
   `vlmService.ts` asks for at most 3) — more than a handful of simultaneous
   callouts gets visually cluttered and adds hit-test latency.

## Alternative VLM choices

Moondream is used here because its `/point` endpoint is purpose-built for
exactly this "where is X" use case and has a free cloud tier. Options if you
want to compare:

- **Gemini (Flash models)** — can return bounding boxes directly in its
  response and has a free tier through Google AI Studio; a reasonable choice
  if you'd rather consolidate reasoning + pointing behind one vendor. Check
  current rate limits before committing, they change.
- **Self-hosting Moondream** — the open weights are available, but note the
  license (Business Source License 1.1 with an additional use grant) has
  restrictions around building a competing hosted service; fine for your own
  app, read the license before reselling access to the model itself.
- **Qwen2.5-VL** — strong open-source grounding performance if you want to
  self-host on your own GPU or via an inference provider.

## Extending this starter

- **Voice input**: `useARGuide().askQuery(text)` already accepts plain text,
  so wiring `@react-native-voice/voice`'s `onSpeechResults` callback straight
  into `askQuery` is a small addition — no changes needed elsewhere in the
  pipeline.
- **Cross-session persistence**: ViroReact supports Cloud Anchors, which let
  anchors survive an app restart and be shared between devices at the same
  physical location — useful if you want labels to "remember" where they were
  placed on a specific piece of equipment.
- **Multi-turn guidance**: for a step-by-step task ("now press the button
  you just labeled"), keep the conversation state in your reasoning prompt
  (pass prior Q&A into `reasonAboutQuery`) and reuse already-anchored labels
  where the part is the same, only calling `/point` again for new parts.

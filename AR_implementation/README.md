# AR VLM Guide — starter kit

A React Native starting point for "point your camera at something, ask a question,
get AR labels pointing at the answer" — the pattern from AR instructional overlays
where callouts stay pinned to physical points as the camera moves.

See `docs/ARCHITECTURE.md` for the full pipeline explanation, native-hit-test
details, and performance tuning notes. This README is just setup.

## What's here

```
App.tsx                        entry point
src/screens/ARGuideScreen.tsx  full-screen AR view + query bar
src/components/ARGuideScene.tsx  the ViroARScene: hit-tests points into 3D
src/components/ARLabelNode.tsx   one dot + line + floating text callout
src/hooks/useARGuide.ts        orchestration: capture -> VLM -> anchor
src/services/vlmService.ts     Moondream API calls (grounding)
src/types.ts                   shared types
docs/ARCHITECTURE.md           deep-dive + performance notes
```

## Setup

**1. This needs a custom native build — it will NOT run in Expo Go.**
ViroReact links native ARKit/ARCore code, which Expo Go's precompiled binary
doesn't include. Use an Expo **dev client** or the bare workflow:

```bash
npx create-expo-app ar-vlm-guide -t
cd ar-vlm-guide
npx expo install expo-dev-client expo-file-system
npm install @reactvision/react-viro @react-native-voice/voice
npx expo prebuild
npx expo run:ios      # or: npx expo run:android
```

Then copy the files from `src/` and `App.tsx` in this project over the generated
ones. Full install/permissions walkthrough (camera usage strings, minimum OS
versions, etc.): https://viro-community.readme.io/docs/installation-instructions

**2. Get a free Moondream API key**
Sign up at https://moondream.ai (Moondream Cloud console) and grab a key from
the free tier. Put it somewhere you load into `process.env.MOONDREAM_API_KEY` at
build time (e.g. via `react-native-dotenv` or Expo's `extra` config) — see the
warning in `vlmService.ts` about not shipping it raw in a production bundle.

**3. Run it**
Point the camera at an object, type a question in the bar at the bottom (e.g.
"where's the power button?"), and the app will call Moondream, hit-test the
result into 3D, and drop a pinned label.

## Free-tier bill of materials

| Piece | Library | Cost |
|---|---|---|
| AR rendering + world tracking | `@reactvision/react-viro` | Free, MIT licensed |
| Native AR engine | ARKit (iOS) / ARCore (Android) | Free, built into the OS |
| Scene grounding (text → image point) | Moondream Cloud API | Free tier |
| Voice input (optional) | `@react-native-voice/voice` | Free, uses OS speech recognition |

No paid backend is required to get this running. For a production app, put the
Moondream call behind your own lightweight server so the API key isn't embedded
in the client — see the note in `vlmService.ts`.

## Known limitations of this starter

- Single VLM guess per part label — no disambiguation UI if the same label
  matches multiple things in view (e.g. two identical ports).
- No persistence — labels disappear on app restart. ViroReact's Cloud Anchors
  (see its docs) can add cross-session persistence if you need that later.
- No voice input wired up yet — `useARGuide.askQuery` accepts plain text; wiring
  `@react-native-voice/voice` in is a small addition (see architecture doc).

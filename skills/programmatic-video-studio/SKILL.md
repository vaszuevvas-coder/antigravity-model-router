---
name: programmatic-video-studio
description: Programmatic HTML/GSAP and React video composition, frame-deterministic timeline choreography, and MP4/WebM CLI rendering via HyperFrames and Remotion. Use when creating animated product demos, promo videos, kinetic typography, or Remotion compositions.
---

# Programmatic Video Studio (HyperFrames + Remotion)

Build deterministic, frame-accurate motion graphics, product promos, and UI walkthrough videos from code without non-deterministic render flicker.

## 1. Engine Selection (`HyperFrames` vs `Remotion`)
- **HyperFrames (Default for standalone MP4/WebM promos & UI reels)**: Choose plain HTML/CSS + paused GSAP timelines (`Apache-2.0`) when generating self-contained promos, kinetic typography, or screen captures because headless Chromium + FFmpeg renders seekable web timelines directly without a React bundler setup.
- **Remotion (React / Next.js apps)**: Choose Remotion (`useCurrentFrame`, `useVideoConfig`, `spring`, `interpolate`, `<Sequence>`) when composing data-driven videos inside an existing React codebase or embedding an interactive `<Player>`.
- **Scope Boundary**: For C++ DaVinci Resolve OpenFX plugins, Resolume GLSL/ISF shaders, or Dota 2 live broadcast GSI overlays, switch to `vj-video-fx-studio`.

## 2. Frame-Deterministic Timeline Invariants
- **HyperFrames GSAP Contract**: Initialize `gsap.timeline({ paused: true })`, register it on `window.__timelines[compositionId]` matching `data-composition-id`, and prefer `.fromTo(...)` on `transform`/`opacity` so arbitrary backward/random seeks produce identical frames.
- **Remotion Frame Purity**: Drive every visual state from `useCurrentFrame()` and `spring({ frame, fps })`; omit CSS `transition`, `requestAnimationFrame`, `setInterval`, `Math.random()`, and `Date.now()` because parallel frame workers render out-of-order and will flicker or desync.
- **Compositor-Safe Properties**: Animate `transform` and `opacity` instead of `width`, `height`, `top`, or `left` so Chromium renders smoothly without layout thrash.

## 3. References & Pre-Render Verification Gate
- Consult [references/hyperframes-gsap.md](references/hyperframes-gsap.md) for HyperFrames HTML/GSAP templates, `npx hyperframes` commands, and `Remotion -> HyperFrames` translation.
- Consult [references/remotion-react.md](references/remotion-react.md) for React `<Composition>` / `interpolate(..., { extrapolateRight: 'clamp' })` patterns and `npx remotion` CLI rendering.
- Verify timeline determinism and capture seeked keyframe PNGs before running full MP4 encode:
```bash
node "<skill_dir>/scripts/lint-video-composition.mjs" <file-or-dir> [--snapshot 0,1.5,3 --out-dir <dir>] [--json]
```

## 4. Frame-Accurate Sound Design & Critique (`real-sfx` + `earshot`)
- Extract HyperFrames (`data-start`/GSAP) or Remotion (`<Sequence from={...}>`) cues, synthesize/resolve real WAV effects (`earshot` CLI if installed, otherwise zero-dep PCM synthesis + Openverse audio), mix via FFmpeg at `-16 LUFS`, and audit peaks/silence so rendered videos never ship mute or clipped:
```bash
node "<skill_dir>/scripts/compose-video-sfx.mjs" --cues <composition> --out-dir ./sfx [--render <video.mp4>] [--json]
node "<skill_dir>/scripts/compose-video-sfx.mjs" --synth success --out ./sfx/success.wav --json
node "<skill_dir>/scripts/compose-video-sfx.mjs" --critique ./sfx/success.wav --json
```

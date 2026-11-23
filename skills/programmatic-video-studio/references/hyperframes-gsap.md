# HyperFrames HTML + GSAP Timeline Reference

## 1. Deterministic Composition Template
```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <style>
    html, body { margin: 0; width: 1920px; height: 1080px; overflow: hidden; background: #faf7f2; }
    .headline { opacity: 0; transform: translateY(32px); font: 700 72px/1.1 system-ui, sans-serif; color: #18181b; }
  </style>
  <script src="https://cdn.jsdelivr.net/npm/gsap@3/dist/gsap.min.js"></script>
</head>
<body>
  <div id="root" data-composition-id="promo-intro" data-start="0" data-duration="4" data-width="1920" data-height="1080">
    <h1 id="title" class="headline" data-start="0" data-duration="4" data-track-index="0">Product Launch</h1>
  </div>
  <script>
    const tl = gsap.timeline({ paused: true });
    tl.fromTo('#title', { opacity: 0, y: 32 }, { opacity: 1, y: 0, duration: 0.7, ease: 'power3.out' }, 0);
    window.__timelines = window.__timelines || {};
    window.__timelines['promo-intro'] = tl;
  </script>
</body>
</html>
```

## 2. HyperFrames CLI Workflow
- Lint structure & seek safety: `npx hyperframes lint`
- Capture keyframe PNGs: `npx hyperframes snapshot --at 0,1.5,3`
- Fast draft / final encode: `npx hyperframes render --quality draft --output renders/draft.mp4` or `npx hyperframes render --output out.mp4 --fps 30`

## 3. Remotion -> HyperFrames Translation Map
| Remotion Concept | HyperFrames Equivalent |
| :--- | :--- |
| `<Composition id="..." durationInFrames fps>` | `data-composition-id`, `data-start`, `data-duration`, `data-width`, `data-height` |
| `<Sequence from={30} durationInFrames={90}>` | `data-start="1" data-duration="3"` + `tl.fromTo(..., positionSeconds)` |
| `interpolate(frame, [0, 30], [0, 1], clamp)` | `tl.fromTo(el, { opacity: 0 }, { opacity: 1, duration: 1 }, 0)` |
| `spring({ frame, fps, config })` | `gsap` ease (`back.out`, `elastic.out`) or custom ease function |

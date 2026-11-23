# Remotion React Composition Reference

## 1. Frame-Pure Component Pattern
```tsx
import { AbsoluteFill, Sequence, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';

export const ProductCardDemo: React.FC<{ title: string }> = ({ title }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const progress = spring({ frame, fps, config: { damping: 18, stiffness: 140 } });
  const opacity = interpolate(frame, [0, 15], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill style={{ backgroundColor: '#f8fafc', justifyContent: 'center', alignItems: 'center' }}>
      <Sequence from={0} durationInFrames={90}>
        <div style={{ opacity, transform: `translateY(${(1 - progress) * 28}px)` }}>{title}</div>
      </Sequence>
    </AbsoluteFill>
  );
};
```

## 2. CLI Verification & Rendering
- Single frame still check: `npx remotion still src/index.ts PromoDemo out/frame30.png --frame=30`
- Final MP4 render: `npx remotion render src/index.ts PromoDemo out/promo.mp4`
- Determinism rule: wrap any procedural noise/particles with `random('fixed-seed')` from `remotion` rather than `Math.random()`.

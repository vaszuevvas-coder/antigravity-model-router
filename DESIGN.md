# DESIGN.md — antigravity-model-router (Crimson Rail)

- **Extracted From**: Industrial hardware-grade UI system (Crimson Rail Dark)
- **Surface Mode**: Operate / Product UI (high-density engineering cockpit, crisp 1px structural borders, zero glassmorphism glow)

## Core Palette Tokens (Dark — `glass_teal` / Crimson Rail)
- **Canvas (`--bg-canvas`)**: `#0a0b0d`
- **Shell (`--shell-bg`)**: `#0f1014`
- **Surface (`--glass-card`)**: `#121316`
- **Inset (`--glass-inset`)**: `#08090b`
- **Primary Text (`--text-main`)**: `#f3f4f6`
- **Secondary Text (`--text-sub`)**: `#9ca3af`
- **Accent (`--accent-primary`)**: `#f04848`
- **Border (`--border-subtle`)**: `rgba(255, 255, 255, 0.10)`

## Typography, Radii & Motion
- **Primary Font Stack**: system-ui + `ui-monospace, SFMono-Regular, Menlo, monospace` (`tabular-nums` for all metrics)
- **Radii Scale**: `2px`, `3px`, `4px`, `6px`, `8px` (zero `999px` pill soup or `26px` blobs)
- **Custom Easings**: `cubic-bezier(0.22, 1, 0.36, 1)`, `120ms–180ms` crisp transitions
- **Invariants**: Zero `backdrop-filter`, zero `specular-rim`, zero neon box-shadows, monochromatic 12–14px SVG icons instead of emojis.

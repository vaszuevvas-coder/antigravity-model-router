---
name: game-systems-architect
description: Gameplay systems, simulation math, and deterministic loop architecture across Action, RPG, Strategy, Tycoon, Puzzle, and Roguelike genres on PC/Web/Mobile. Use when designing game mechanics, progression economies, combat pipelines, or SDK save layers.
---

# Game Systems Architect Protocol

## 1. Core Loop, Frame Pacing & Memory
- **Deterministic Reducer**: Model state mutations as pure serializable transitions `(state, action) => nextState` decoupled from Canvas 2D / WebGL / Three.js / DOM rendering.
- **Delta-Time Clamp**: Clamp `dt = Math.min((now - lastTime) / 1000, 0.1)` so background tab throttling never causes physics tunneling or timer spikes.
- **Zero-GC Pooling**: Reuse particles, projectiles, and floating combat text from pre-allocated pools instead of allocating inside `requestAnimationFrame`.

## 2. Economy, Combat & Cross-Platform Ergonomics
- **Scaling & Sinks**: Balance upgrade curves $C(n) = C_0 \cdot r^n$ ($r \in [1.07, 1.15]$) against production/damage yields and meaningful sinks across Core (30s), Meta (15m), and Endgame loops; guard math against `NaN`/`Infinity`/negative balances and seed PRNGs for market/loot simulations.
- **Combat Pipeline & Juice**: Execute `preTick(buffs/cooldowns) -> applyPassives() -> resolveAction(hit/collision) -> triggerReactions() -> postTick(decay/cleanup)`, paired with input buffering, coyote time, hit-stop, and procedural/CC0 `.wav` SFX (generate deterministic cues via `skills/programmatic-video-studio/scripts/compose-video-sfx.mjs --synth` or fetch CC0 beds via `skills/ui-ux-design-system/scripts/fetch-open-media.mjs --type audio` so audio cues never ship silent or broken); adapt HUD aesthetics to the project's genre.
- **SDK & Touch Ergonomics**: Wrap platform SDKs (`YaGames.init()`, Steamworks, CrazyGames) with local offline mocks, versioned save migrations, `visibilitychange` audio/timer pauses, `100dvh`, `touch-action: manipulation`, and $\ge 44 \times 44\text{px}$ hitboxes.

## 3. Verification Gate
- Run a headless simulation smoke test (`npx vitest` / `node --test`) verifying progression curves, boundary collisions, resource sinks, and offline SDK mocks pass with zero `NaN` or console errors.

## Learned Patterns & Verified Recipes
- **[Invariant]** Never mutate the player story progression state when toggling Debug/Unlock-All sandbox modes; store debug flags in an isolated runtime layer (e.g. isUnlocked = debugUnlockAll || storyState.unlocked) so switching back to chapter progression preserves honest save state.
- **[Invariant]** Before executing Hard Reset of game progress, disable auto-save intervals and beforeunload hooks first, then clear storage and reinitialize clean state under the transition screen.
- **[Recipe]** Model in-game stock/crypto markets with 3 combined layers: fundamental trend, macro cycle (Bull/Bear/Flat), and news shock events, guarded by bid-ask spread or fee sinks to prevent infinite arbitrage.

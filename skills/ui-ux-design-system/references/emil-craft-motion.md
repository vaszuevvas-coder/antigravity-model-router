# Craft, Micro-Interactions & Animation Engineering (Emil Kowalski Distilled)

Reference for UI polish, motion engineering, and mobile-native feel. Load when designing, auditing, or fixing interactive components and animations.

## 1. Animation Decision Framework
1. **Frequency Gate — should it animate at all?**
   - **100+ times/day** (keyboard shortcuts, command palette toggle): **no animation ever** — motion feels like lag.
   - **Tens of times/day** (hover rows, list selection): remove or keep ultra-subtle (`<= 120ms`).
   - **Occasional** (modals, drawers, toasts, popovers): standard crisp animation.
   - **Rare / first-time** (onboarding, celebrations): delight allowed.
2. **Easing Rules (never use built-in weak defaults or `ease-in` on UI):**
   - **Enter / Exit (default)**: strong `ease-out` -> `--ease-out: cubic-bezier(0.23, 1, 0.32, 1);` (starts fast, feels responsive).
   - **On-screen move / morph**: strong `ease-in-out` -> `--ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);`
   - **Drawers / iOS sheets**: `--ease-drawer: cubic-bezier(0.32, 0.72, 0, 1);`
   - **Never `ease-in` for dropdowns/popovers**: slow start makes UI feel sluggish.
3. **Duration Ceilings (`< 300ms` for standard UI):**
   - Button press: `100–160ms` | Tooltips/popovers: `125–200ms` | Dropdowns/selects: `150–250ms` | Modals/drawers/toasts (exceptions): `200–500ms`.
4. **Springs**: Use for interruptible gestures, drag momentum, and decorative pointer tracking (`{ type: "spring", duration: 0.5, bounce: 0.2 }`; keep bounce `0.1–0.3`, avoid bounce in utilitarian UI).

## 2. Invisible UI Polish Cheatsheet
| Problem | Fix |
| --- | --- |
| Button feels dead on click | `.btn:active { transform: scale(0.97); }` (`160ms var(--ease-out)`) |
| Element pops from nowhere | Never `scale(0)`; start at `transform: scale(0.95); opacity: 0;` |
| Popover scales from wrong spot | `transform-origin: var(--transform-origin)` anchored to trigger (modals stay `center`) |
| Toolbar tooltips feel slow | Delay first tooltip; skip delay & entrance animation on subsequent sibling hovers |
| Live numbers jitter | `font-variant-numeric: tabular-nums;` |
| Avatar/icon squishes in flex row | `flex-shrink: 0;` on fixed-size media/icons |
| Large headings look loose | Tighter tracking (`letter-spacing: -0.02em`) |
| Body text lines too wide | `max-width: 65ch;` |
| Gradient fade shows hard band | Use multi-stop eased gradient instead of 2-stop linear fade |
| "1 members" / "340 days ago" | Pluralize via `Intl.PluralRules`; switch relative timestamps to absolute dates after 7 days |

## 3. Performance & Mobile-Native Guardrails
- **GPU-only properties**: Animate `transform` and `opacity`; never `transition: all` or layout properties (`width`, `height`, `top`, `left`, `margin`, `padding`).
- **Blur & React perf**: Keep animated `blur()` under `20px`; in high-frequency animation loops, mutate `ref.current.style` instead of React state; apply `will-change: transform` only when a 1px shift is observed.
- **Mobile-native fixes**: Guard hover styles with `@media (hover: hover)` (no sticky mobile hover), use `100dvh`, set mobile input `font-size >= 16px` (prevents iOS auto-zoom), respect `env(safe-area-inset-*)`, and disable ugly tap flashes (`-webkit-tap-highlight-color: transparent` with explicit `:active` feedback).

## 4. UI Review Output Format
When auditing existing UI/motion code, summarize fixes in a compact markdown table:
`| Before | After | Why |`

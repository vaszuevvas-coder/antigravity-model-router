# DESIGN.md — Project Design Contract ({{DOMAIN}})

## 1. Surface Mode & Taste Dials
- **Surface Mode:** {{SURFACE_MODE}}
- **Taste Dials (`1..10`):** {{TASTE_DIALS}}

## 2. Design Tokens (`:root`)
- `--bg-canvas`: `{{BG_CANVAS}}`
- `--bg-surface`: `{{BG_SURFACE}}`
- `--border-subtle`: `{{BORDER_SUBTLE}}`
- `--text-primary`: `{{TEXT_PRIMARY}}` (contrast >= 7:1)
- `--accent-primary`: `{{PRIMARY}}`
- `--accent-secondary`: `{{ACCENT}}`
- **Spacing Scale:** `4 / 8 / 12 / 16 / 24 / 32 / 48px`

## 3. Typography & Hierarchy
- **Heading Font:** `{{HEADING_FONT}}`
- **Body / UI Font:** `{{BODY_FONT}}`
- **Reading Measure:** `60–72ch` for prose, `tabular-nums` for telemetry metrics.

## 4. Motion & Accessibility Invariants
- Animate `transform` and `opacity` only (`150–350ms`); avoid `transition: all`.
- Honor `prefers-reduced-motion: reduce` without killing state feedback (`0.01ms` blanket kill prohibited).
- Every interactive control must have explicit `:hover`, `:active`, `:focus-visible`, and `:disabled` states.

## 5. Domain Anti-Patterns & Pre-Flight Check
- **Avoid:** {{ANTI_PATTERNS}}
- **Pre-Flight:** Run `node <skill_dir>/scripts/audit-ui.mjs <target>` before shipping.

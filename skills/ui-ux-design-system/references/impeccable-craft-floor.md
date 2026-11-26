# Impeccable v4 Craft Floor, Cognitive Load & UI Hardening

Load immediately before executing UI edits (skip during pure planning). Enforces the non-negotiable visual floor and UX resilience pass.

## 1. Non-Negotiable Craft Floor
- **Finish the Deliverable**: No placeholder copy (`Lorem ipsum`), dead buttons, or unstyled hover/focus/disabled states.
- **Scale Ambition to Surface Mode**:
  - `Persuade` / `Experience` (landing, showcase): bold point of view, expressive editorial hierarchy.
  - `Operate` / `Read` (dashboards, IDE, settings, docs): precision, high scanability, familiar conventions, strict restraint.
- **Verify Rendered Pixels**: Inspect the rendered surface at shipped viewports (`1440 / 1024 / 768 / 390`) in batches; fix every defect found in one look before re-capturing.
- **Zero Aesthetic Regressions**: Maintain `>= 7:1` primary / `>= 4.5:1` secondary contrast, crisp focus rings (`:focus-visible`), and zero horizontal overflow.

## 2. Cognitive Load Critique Checklist (8 Points)
Evaluate every screen before declaring it polished:
1. **Single Focus**: Primary user task is unmistakable without competing chrome.
2. **Chunking**: Information grouped in digestible clusters (`<= 4` items per visual group).
3. **Proximity & Grouping**: Related controls share clear visual containers/spacing.
4. **Visual Hierarchy**: Immediate eye-path from primary title/metric -> primary action -> secondary detail.
5. **One Decision at a Time**: Forms and modals do not overload multiple orthogonal decisions into one crowded row.
6. **Minimal Choices**: `<= 4` visible options at any decision point (progressive disclosure for the rest).
7. **Low Working Memory**: Users never need to memorize values from a previous screen/tab to act on the current one.
8. **Progressive Disclosure**: Advanced knobs live behind clear disclosures, never cluttering the default path.

## 3. UI Hardening Pass (`harden`)
- **Text Expansion & Long Strings**: Survive `+40%` i18n expansion (RU/DE labels), unbroken URLs/IDs (`min-width: 0; overflow-wrap: anywhere`), and `0 / 1 / 999+` counters (`tabular-nums`).
- **Complete State Matrix**: Design explicit `loading` (skeleton/shimmer matching final layout height), `empty` (actionable non-apologetic CTA), `error` (cause + retry), and `offline/partial` states.
- **Interactive Bounds**: Minimum `32px` desktop / `44px` touch hit targets, keyboard Tab/Enter/Escape navigation, and `prefers-reduced-motion` safe fallbacks.

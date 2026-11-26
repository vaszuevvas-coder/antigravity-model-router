---
name: ui-ux-design-system
description: Context-driven UI/UX tokens, anti-clone synthesis, Impeccable audit/polish, Taste 3-dial calibration, Pro Max design matrix, A/B/C showroom, and zero-LLM web reference capture. Use when designing, auditing, polishing, or restyling interfaces, themes, layouts, or animations.
---

# UI/UX Design System & Craft Protocol

## 1. Surface Mode, Taste Dials & Design Contract (`DESIGN.md`)
- **Surface Mode (`Impeccable`)**: Classify surface before coding — `Persuade` (landing/onboarding: bold POV), `Operate` (dashboards/IDE/settings: scanability & restraint), `Read` (docs/articles: 60–72ch rhythm), or `Experience` (portfolios/showcases: artifact-first).
- **Taste Three Dials (`1..10`)**: Calibrate `DESIGN_VARIANCE`, `MOTION_INTENSITY`, `VISUAL_DENSITY` and query domain palettes, font pairings, charts & UX rules (`0` LLM tokens; pass `--history .cache/ux-history.json` to avoid repeating palettes across builds) via:
  ```bash
  node "<skill_dir>/scripts/query-ux-matrix.mjs" --domain "<product/screen>" --mode operate [--charts] [--history <file>] [--init-design-md <dir>]
  ```
- **Single Source of Truth (`:root` + `DESIGN.md`)**: Respect existing `DESIGN.md` (or extract from existing CSS via `node "<skill_dir>/scripts/extract-design-md.mjs" . --write`); define `--bg-canvas`, `--bg-surface`, `--bg-elevated`, `--border-subtle`, `--border-strong`, `--text-primary` ($\ge 7:1$), `--text-secondary` ($\ge 4.5:1$), `--text-muted`, `--accent-primary`, `--accent-secondary`, `--status-ok/warn/err` on a `4/8/12/16/24/32/48px` scale.
- **Responsive Overflow & GPU Motion**: `grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr))`, `min-width: 0; overflow: hidden; text-overflow: ellipsis`, `100dvh`, `>= 32px` desktop / `>= 44px` touch targets, `transform`/`opacity` (`150–350ms`), explicit `:hover/:active/:focus-visible/:disabled`, safe `prefers-reduced-motion` (preserve state feedback; avoid `0.01ms` blanket kills), and verify DOM IDs.

## 2. Anti-Clone Synthesis, Trade-Gated FX & Craft Passes
- **Zero Cloning & 2nd-Gen Tells**: Avoid memorized presets (`#0d1117 + #00f2fe`), generic purple SaaS gradients, Claude cream+terracotta (`#f4f1ea + #d97757`), repetitive ALL-CAPS eyebrows, `→` chrome on every button, and fake `01/02/03` numbering on non-sequences; follow Chanel's rule (one focal accent per screen) because restrained hierarchy stops pages from reading as AI templates.
- **Trade-Gated Shaders & Licensed Media (`taste-skill 2.5`)**: Reserve WebGL/shaders/dither scenes for tech, AI, gaming, or fintech surfaces; fetch real `CC0`/`CC-BY` photography via `node "<skill_dir>/scripts/fetch-open-media.mjs" --query "..." --out ./media` for hospitality, retail, and service briefs with a single `CREDITS` footer line.
- **UX Microcopy, Craft Motion & React Engineering**: Keep CTA-to-toast verbs consistent (`"Publish" -> "Published"`), write actionable non-apologetic empty states, and load on-demand references: [references/impeccable-craft-floor.md](references/impeccable-craft-floor.md) (pre-edit quality floor, 8-point cognitive load checklist, i18n/state hardening), [references/emil-craft-motion.md](references/emil-craft-motion.md) (animation frequency gate, strong `ease-out` curves, `:active` press scale, origin-aware popovers), [references/emil-choreography-gestures.md](references/emil-choreography-gestures.md) (multi-element stagger/interruption, gestures, subtraction-only motion audit), [references/break-ui-learn-taste.md](references/break-ui-learn-taste.md) (worst-case data stress-testing & session taste capture into `DESIGN.md`), and [references/react-vercel-rules.md](references/react-vercel-rules.md) for React/Next.js apps and `<ViewTransition>`.
- **5-Axis Synthesis & Verification**: Invent 3 orthogonal concepts across luminance (include light/editorial), color psychology, layout, typography, and motion; run `node "<skill_dir>/scripts/audit-ui.mjs" <file-or-dir> [--viewports]` (checks 5 craft dimensions `/20`, copy-lint, and `1440/1024/768/390` overflow) before completing.

## 3. Preview Gate & `ask_question` Protocol (`uiInspirationMode`)
Before UI/CSS/VFX edits, inspect `uiInspirationMode` (`'ask'` | `'showroom'` | `'web_refs'`):
1. **Q1 (Skip if `'showroom'` or `'web_refs'`)**: Emit in the active user language (`uiLanguage`, EN or RU):
   - EN Question: `"Design & animations: how should we prepare visual examples before implementing code?"`
   - EN Options: `"(Recommended) Generate 3 bespoke variants (A/B/C) in an interactive showroom"` | `"Search open web design references (specify style next or in 'Other')"` | `"Hybrid: search web references → build 3 A/B/C prototypes"` | `"Skip preview — implement directly in code"`
   - RU Question: `"Дизайн и анимации: как подготовим визуальные примеры перед внедрением в код?"`
   - RU Options: `"(Recommended) Сгенерировать 3 авторских варианта (A/B/C) в интерактивной витрине"` | `"Поискать референсы в интернете (укажите стиль в следующем шаге или в поле «Другое»)"` | `"Гибрид: найти рефы в интернете → собрать по ним 3 прототипа A/B/C"` | `"Без превью — сразу внедрять в код"`
2. **Q2 (Target Style — emit in the active user language `uiLanguage` with 3 fresh domain-specific options)**:
   - EN Question: `"Which visual direction should we choose for [project/screen summary]? (You can also describe your own taste in 'Other', e.g., 'Apple liquid glass')"`
   - EN Option 1: `"(Recommended) Compare 3 tailored concepts: A) [...] + B) [...] + C) [...]"`; Option 2: contrasting light/editorial direction; Option 3: atmospheric/tactile/modular direction; Option 4: `"Keep and carefully evolve the current project style"`.
   - RU Question: `"Какое визуальное направление возьмём за основу для [project/screen summary]? (В поле «Другое» можно кратко описать любой свой вкус, например: «жидкое стекло Apple»)"`
   - RU Option 1: `"(Recommended) Сравнить 3 разных концепта под задачу: A) [...] + B) [...] + C) [...]"`; Option 2: contrasting light/editorial direction; Option 3: atmospheric/tactile/modular direction; Option 4: `"Сохранить и аккуратно развить текущий стиль проекта"`.
3. **Inline Interactive Preview First (`<agent-embed>`) & Local Showroom (`showroom` / Q1.1)**: Never ask users to pick UI/animation variants from text alone. Whenever the UI, theme, layout, or motion can be rendered in HTML/CSS/SVG/Canvas, prefer a **live interactive inline HTML preview directly in chat** via the `generative_ui` skill (`<agent-embed src="file:///.../preview.html"></agent-embed>`, compact `<= 450px` tall) with clickable style/state switches instead of static screenshots. Fall back to `node "<skill_dir>/scripts/build-showroom.mjs" <spec.json> --artifact-dir "<artifactDir>" --open` + PNG embeds (`showroom-overview.png`, `variant-A/B/C.png`) in `<artifactDir>/ui-variants-preview.md` (`UserFacing: true`) only when static captures are explicitly requested or required (e.g., external websites).

## 4. Open Web Reference Pipeline (`fetch-web-refs.mjs`)
- **Open Sources**: `21st.dev`, `uiverse.io`, `magicui.design`, `ui.aceternity.com`, `CodePen`, `Codrops`, `godly.website`, `land-book.com`, `minimal.gallery`, `siteinspire.com`, `Awwwards`, `Design Spells`, `Screenlane`, `Apple HIG` (never bypass CAPTCHA/login walls).
- **3-Step Zero-LLM Pipeline**: Run 1–2 `search_web` queries (`5-6` URLs) -> `node "<skill_dir>/scripts/fetch-web-refs.mjs" <url1..url5> --artifact-dir "<artifactDir>" --limit 3 --build-showroom` -> build `<artifactDir>/ui-variants-preview.md` from `cards[].tokens` + `markdownPreview` (reserve `browser` `flash` for `<=1-2` URLs).

## Learned Patterns & Verified Recipes
- **[Invariant]** When combining translucent Liquid Glass (backdrop-filter) with dense text or chat dialogs, keep card background opacity >= 85%, gap >= 12px, and crisp border contrast so adjacent messages never blur into an unreadable wall of text.
- **[Invariant]** Prefer live interactive inline HTML previews in chat via Generative UI (`<agent-embed>`) over static PNG screenshots whenever demonstrating UI layouts, components, themes, or animations; keep static PNG showroom embeds as fallback only when live inline HTML is not feasible.
- **[Invariant]** Never rely solely on --open browser auto-launch in Windows; when using static showroom fallback, always embed rendered PNG previews (`showroom-overview.png`, `variant-A/B/C.png`) directly into the user-facing artifact before asking the user to choose.
- **[Recipe]** For multi-scale telemetry charts (Month / Week / Day), use Canvas 2D with devicePixelRatio scaling, min-max/LTTB downsampling per pixel column, and smooth lerp of [viewStart, viewEnd] in requestAnimationFrame.

# UI Stress-Testing (`break-ui`) & Taste Capture (`learn-taste`)

On-demand protocols distilled from Emil Kowalski's design-engineering workflow.

## 1. Break-UI: Worst-Case Data Stress Protocol
Use when verifying a component/screen against real-world edge cases before shipping.
- **Hard Rules**:
  1. Inject worst-case values **at the data boundary** (fixtures/props/API stubs) — never hand-edit CSS/DOM to fake a break.
  2. Use **plausible or schema-backed** data, never `"aaaaa..."` nonsense.
  3. Add a dev-only toggle (`Demo / Worst case / Empty / 1,000 rows`, e.g., via `?data=worst`) and **report all breaks before fixing**.
- **Worst-Case Fixture Catalog**:
  - **Names**: `Aleksandra Wiśniewska-Kowalczyk` (long hyphenated), `Jo` / `J` (1–2 chars), `Đặng Thị Ngọc Hân` (tall diacritics), `王秀英` (CJK no spaces), `نور الهدى` (RTL `dir="auto"`), `👩🏽‍💻 Priya` (ZWJ emoji), missing name.
  - **Unbreakable strings**: `bartholomew.fitzgerald@northwind-industries-holdings.example.com`, long URLs, UUIDs, `Benachrichtigungseinstellungen` (30-char German compound).
  - **Numbers & Collections**: `0` (empty state), `1` (`"1 members"` pluralization), `1,284`, `$12,345,678.90`, `142%` / `-3%`, live `99 -> 100` (`tabular-nums`), `1,000+` unpaginated rows.
  - **Media & States**: 404 avatar (initials fallback), 4000x200 / 200x4000 aspect extremes (`object-fit: cover`), loading skeleton mismatch, raw API error string, partial optional fields.
- **Check Matrix**: Real container width + `320px` + widest desktop + `200%` zoom + dark mode (and `dir="rtl"` if supported).
- **Top Failure Signatures**:
  - Squished avatar/icon -> `flex-shrink: 0`
  - Overflowing text in flex/grid -> `min-width: 0` (`minmax(0, 1fr)`) + `overflow-wrap: anywhere`
  - Clipped diacritics -> relax tight `line-height` with `overflow: hidden`

## 2. Learn-Taste: Turn Session Corrections into Permanent Rules
Use at the end of a UI session when the user corrected design choices.
1. **Collect signals** across the conversation: explicit corrections, silent manual edits, repeated nudges ("smaller... ok"), rejections/reverts, and confirmed non-obvious choices. Skip one-off copy or functional bug fixes.
2. **Filter**: Keep only rules a fresh agent building a *different* component in this repo would otherwise violate.
3. **Generalize to Component Class** (not single instance, not overly universal): write strict rules with exact tokens/values (`always`/`never`) + the user's `why` (mark *inferred* if not stated, and ask confirmation).
4. **Persist**: Prefer an automated lint/test check (`audit-ui.mjs` or project lint) plus a 1-line rule under the matching section of `DESIGN.md` (`Surfaces · Color · Typography · Spacing & layout · Motion · Interaction · Copy`). Propose rules and write only after user approval.

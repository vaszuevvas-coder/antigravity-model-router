---
name: skill-architect
description: Deterministic SKILL.md linter, progressive-disclosure architect, and local BM25F/trigram trigger evaluator (scripts/audit-skill.mjs). Use when authoring, auditing, compressing, or calibrating SKILL.md bundles and trigger descriptions without Negative Transfer.
---

# Skill Architect (Evaluation-Driven Authoring v2)

Design, evolve, and verify `SKILL.md` bundles against SOTA 2026 standards (`SkillsBench`, `SkillGenBench`, `EvoSkill`) at zero cloud tokens using local deterministic checks.

## 1. Merge-Over-Create & Progressive Disclosure 2.0
1. Inventory existing skills via `node core/router-cli.mjs skills` so overlapping lessons evolve an existing skill instead of fracturing triggers across duplicate folders.
2. Separate layers:
   - `SKILL.md` (`<= 120` lines): compact English routing metadata, causal invariants, exact CLI invocations, and verification gate — kept tight because every line competes with active conversation context.
   - `scripts/*.mjs`: offload deterministic parsing, linting, formatting, or `--dry-run` checks into Node scripts because multi-step LLM text manipulation drifts and wastes output tokens.
   - `references/*.md`: move long schemas, lookup tables, and extended recipes out of `SKILL.md` linked relative to skill root so they load on demand.

## 2. Anti-Negative-Transfer Principles (`SkillsBench` / `EvoSkill`)
- **Delta-Only Knowledge**: Omit generic programming advice the model already knows because textbook priors dilute repository invariants and trigger Negative Transfer.
- **Causal `Why`-Invariants**: Prefer `"Do X because Y prevents Z"` over bare `"ALWAYS"` / `"NEVER"` rules so the agent adapts safely on legitimate edge cases.
- **Trigger Calibration (`description`)**: Write 3rd-person compact English metadata (`60-260` chars) pairing exact capability with `"Use when..."` — keeping `SKILL.md` EN-only saves catalog & back-translation tokens while human-facing Russian UI titles live in `sidecars/panel/lib/panel-state-skills.mjs` (`SKILL_RU_TITLES` / `SKILL_RU_HINTS`).
- **Failure-Driven Distillation (`EvoSkill`)**: Convert resolved `pitfall-ledger` regressions into compact `Why`-invariants rather than stacking duplicate raw error logs.

## 3. Deterministic Audit & Trigger Eval CLI
```bash
# Audit one skill (Negative Transfer + broken script refs + BM25F/trigram Trigger Eval)
node "<skill_dir>/scripts/audit-skill.mjs" <slugOrDir> [--eval evals/evals.json] [--json]

# Audit all skills and inspect sibling trigger collisions across the catalog
node "<skill_dir>/scripts/audit-skill.mjs" --all --strict

# Append a verified causal lesson into an existing or new skill
node core/router-cli.mjs learn --skill <slug> --pattern "<causal lesson>" --category invariant

# Distill recent pitfall-ledger entries into matching skills (preview with --dry-run)
node core/router-cli.mjs distill-pitfalls --dry-run
```
Optional `<skill_dir>/evals/evals.json` supports `{ "positive": ["..."], "negative": ["..."] }` to test false negatives and false positives locally.

## 4. Verification Gate
- Confirm `audit-skill.mjs` passes with `errorsCount === 0`, score `>= 75` (Grade `A` or `B`), `0` broken `scripts/` links, and `0` high sibling collisions (`>= 0.55`).
- For core plugin skills, verify RU display labels exist in `sidecars/panel/lib/panel-state-skills.mjs` (`SKILL_RU_TITLES` / `SKILL_RU_HINTS`) and `SKILL.md` indexes cleanly in `core/local-gpu-engine.mjs`.

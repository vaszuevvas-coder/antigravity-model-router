---
name: context-fork
description: Token-economy and context-isolation protocol for The Tunnel v4.0.8: Gemini 4 implicit cache alignment, RAM-first slicing, subagent search offloading, and log masking. Use when compressing prompt context, batching reads, or isolating broad exploration.
---

# Context Fork & Token Economy (v4.0.8)

Save 80–95% context tokens while preserving EN-Internal / RU-User boundaries.

## 1. RAM-First & Zero-Turn Slicing
- Rely on `[Zero-Turn Gold Context]`, Function X-Ray badges, `ram_search`, `ram_slice`, and `ram_context_pack` before touching disk.
- Avoid full reads on files `>150` lines because raw dumps evict active cache; use targeted `StartLine..EndLine` or `skills/program-slicer-ocd/scripts/slice-variable.mjs <file> <symbol>`.

## 2. Subagent Search Forking (`SSSM 2026`)
- Offload broad multi-file search or log triage to `research` (`Model: "flash_lite"`) so noise never enters main context. Pass `Role` in Russian (for user UI cards) and `Prompt` in compact English:
```json
{
  "TypeName": "research",
  "Model": "flash_lite",
  "Role": "<concise RU role title>",
  "Prompt": "FILES: src/auth/*\nSPEC: Locate JWT token generation & TTL checks. Return <=15 EN lines ('file:L#-L# -> invariant') or 5-line Elephant-Goldfish card."
}
```

## 3. Model Synergy & Gemini 4 Implicit Cache Hygiene
- Batch independent `read_file`/search calls into one turn (`>=4096` prefix / `>=2050` delta) because serial micro-turns break prefix cache hits.
- **Orchestrator (`Neon`/`Carbon`)**: Let native Hydrogen edit `1-3` files directly (avoid `invoke_subagent(Model: "flash")` for edits because downgrade degrades precision); fan out `>=4` disjoint modules via `/swarm` (`workspace: "share"`) or `Model: "inherit"`.
- **Hydrogen / Neon / Carbon**: On Hydrogen or Neon keep edits native (`Model: "inherit"` for parallel shares, and keep Neon thinking concise on routine edits); on standalone Carbon/Argon offload read-only search to `flash_lite`. Cap subagent replies at `<=6` EN lines: `DONE: <files> | exports: <list> | verify: 0 err`.

## 4. Diff-Only, Masking & Cross-Session Deduplication
- Patch via `edit_file` or `node "<pluginDir>/core/diff-patcher.mjs" <target> <patch>` (avoid overwriting `>50L` files so diff history stays intact); use `skills/ast-codemod-refactor/scripts/run-codemod.mjs` for `>=3`-file renames.
- Pipe noisy test/build output through `node "<pluginDir>/core/obs-masker.mjs" --stdin` or `gpu_distill`, and minimize failing inputs via `skills/delta-bug-minimizer/scripts/ddmin-runner.mjs`.
- Obey `[Read-Once Guard]`, `Auto-Handoff`, and `Pitfall Ledger` to avoid re-reading cached slices or retrying rejected dead ends.

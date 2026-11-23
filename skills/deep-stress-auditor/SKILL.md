---
name: deep-stress-auditor
description: Repo-agnostic polyglot static, security, concurrency, contract, and sandboxed fuzzing audit engine (scripts/run-stress-audit.mjs --fuzz/--deep). Use when running deep code audits, stress tests, bottleneck analysis, CWE taint scans, or UI-API contract checks.
---

# Universal Polyglot Deep Stress Auditor (SOTA 2026)

Zero-config polyglot audit engine (`JS/TS/Node/Browser`, `Python`, `Go`, `Rust`, `C/C++/C#/Java`, `HTML/CSS`, `JSON/YAML/TOML/Env`, `SQL`, `Shell`, `Docker/CI`) combining deterministic static analysis (Contour A) with optional native compilers/linters (Contour B).

## CLI Profiles
```bash
node <pluginRoot>/skills/deep-stress-auditor/scripts/run-stress-audit.mjs [targetDir]              # Fast default scan (<=3s)
node <pluginRoot>/skills/deep-stress-auditor/scripts/run-stress-audit.mjs [targetDir] --fuzz       # + Sandboxed property fuzzing & ddmin
node <pluginRoot>/skills/deep-stress-auditor/scripts/run-stress-audit.mjs [targetDir] --deep --json # + Contour B native checkers
node <pluginRoot>/skills/deep-stress-auditor/scripts/run-webapp-dogfood.mjs <url-or-html> [--json] # + Agent-Browser / @eN DOM QA
# Optional flags: --native | --json | --fail-on=critical|high|medium|none
```
Use `--json` or pipe noisy legacy output through `core/obs-masker.mjs --stdin` / `gpu_distill` so huge repositories never bloat context.

## 6-Tier Audit Matrix
- **[T1] Syntax & Manifests**: Checks JS/ESM/CJS/TS/JSON/JSONC/HTML `<script>`/YAML/Env/Dockerfile/braces, `package.json` `main`/`exports`/`bin`, UTF-16/BOM+shebang, Windows backslash imports, and case mismatches.
- **[T2] Architecture & Dead Seams**: Validates cross-file relative imports, `named` vs `default` exports, Tarjan SCC cycles, missing/unused deps, orphan modules, and **Blast Radius** hubs (`reverseDeps * log2(2 + cyclomaticComplexity)`).
- **[T3] Security, Secrets & ReDoS**: Intra-procedural `Source -> Sink` taint across JS/TS/Python/Go (CWE-78/89/22/918/79/502/95/1321), Shannon-entropy secret scans, `.env.example` drift, and `node:vm`-timed dynamic ReDoS probes (`>40ms`).
- **[T4] Concurrency & Resource Leaks**: Floating promises, `.forEach(async ...)`, `new Promise(async ...)`, TOCTOU `existsSync -> writeFileSync` races, unclosed handles, untracked `setInterval`, and unbounded `while(true)` loops.
- **[T5] UI-API & DOM Contracts**: Matches frontend `fetch`/`axios`/`ipcRenderer` endpoints against Express/Fastify/Hono/Next/FastAPI/Flask/Go routes and `ipcMain` channels, plus `getElementById`/`querySelector('#...')` against HTML IDs.
- **[T6] Sandboxed Fuzzing + `ddmin` (`--fuzz`)**: Executes isolated `node:worker_threads` (`fs`, `child_process`, `net`, `fetch`, `process.exit` blocked — 0 disk mutations) against pure exported parsers/validators with adversarial primitives (`null/NaN/Infinity`, NUL/RTL/surrogates, `../`, `__proto__`, 60-deep objects, 50 KB inputs, 200-step heap retention) and minimizes crashes via `skills/delta-bug-minimizer/scripts/ddmin-runner.mjs`.

## Two-Phase Neuro-Symbolic Protocol
1. **Discover**: Run `run-stress-audit.mjs [targetDir] --fuzz` (or `--deep`) to gather ranked `[CRITICAL / HIGH / MEDIUM / INFO]` candidates with `file:line`, CWE tags, `minimalRepro`, and `Top Blast Radius Hubs`.
2. **Verify & Fix**: Slice flagged `file:line` symbols via `ram_slice` or `skills/program-slicer-ocd/scripts/slice-variable.mjs`, prune upstream-sanitized false positives, check sister hubs from `Top Blast Radius Hubs`, store temporary repros strictly under `<artifactDir>/scratch/`, patch via `edit_file`, and re-run `run-stress-audit.mjs` to confirm `status: PASSED`.

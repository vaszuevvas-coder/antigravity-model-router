---
name: model-router
description: Control protocol for The Tunnel v4.0.4 3D Task Tensor (Breadth x Depth x Risk), Gemini 4 Hydrogen/Neon/Carbon/Orchestrator routing, Adaptive Swarm, CPU pool, and Int8 GPU copilot. Use when tuning router-state.json, model tiers, or RAM/VRAM guardrails.
---

# The Tunnel v4.0.4 Control Protocol

Manage routing strategies, 3D Task Tensor verdicts, Adaptive Swarm (`core/swarm-controller.mjs`), Multi-Core CPU pool, Local GPU Copilot (`core/local-gpu-engine.mjs`), guardrails, and the **The Tunnel** sidecar panel.

## 1. 3D Task Tensor (`Breadth × Depth × Risk`), Synergy & Swarm (`router-state.json`)
- **State Path**: `~/.gemini/config/plugins/antigravity-model-router/router-state.json`
- **3D Tensor (`core/tool-pruner.mjs` + `core/model-profile.mjs` + `core/bayesian-router.mjs`)**:
  - Classifies **Breadth** (`narrow` 1F, `moderate` 2–3F, `wide` 4+F/2+sub) × **Depth** (`routine`, `integrated`, `deep_arch` + `evaluateTargetsFragility`) × **Risk** (`clear`, `exploratory`, `critical_blast` for `reverseDeps>=4`/fragile/migration/security):
    - `Narrow/Moderate × Routine × Clear` -> **Hydrogen · Medium/High** or **Orchestrator** (`Flash 3.8` for tiny `S`; avoid `Neon High/XHigh` or `Argon` to prevent 2× overpay).
    - `Wide × Routine × Clear` -> **Hydrogen · High / XHigh** (avoids 2×–2.5× Neon/Carbon overpay on mechanical multi-file edits).
    - `Narrow/Moderate × Deep` or `Critical-Blast (Integrated)` -> **Orchestrator (Neon)** or **Neon · High/XHigh** (Ultra: **Carbon** / **Orchestrator (Carbon)**).
    - `Wide × Integrated` -> **Orchestrator (Neon / Carbon)** or **Hydrogen · XHigh**; `Wide × Deep` -> **Orchestrator (Neon)** (Pro) or **Orchestrator (Carbon)** (`-24%` quota) / **Neon · XHigh**.
  - **Adaptive Options & Selector Guard**: `buildAdaptive3DOptionsBlueprint` injects `[3D Adaptive Options Blueprint]` with real files, dependency counts, and trade-offs (`ddmin`/read-only for `Exploratory`, `workspace:"share"` + `@verifier` for `Critical-Blast`, `run-codemod.mjs`/`dry-run` for `Wide×Routine`); `evaluateAskQuestionSelectorGuard` catches mismatched presets once, and `Plan Approved Follow-Up` runs immediately after confirmation.
- **Strategies**: `flash_dispatcher` (`S/M` fast -> `>=heavyThreshold` escalates to Neon/Carbon/Orchestrator), `auto_balance` (`S` direct, `M` native/scout, `L/XL` Neon/Carbon/Orchestrator + parallel Hydrogen shares), `pro_architect` (Neon/Carbon/Orchestrator main + `flash_lite` scout).
- **Model Lineup & Swarm**:
  - **Orchestrator (`Neon`/`Carbon`/`Argon` + Planner Depth `Low/Medium/High/XHigh`)**: Prefer `Orchestrator (Neon)` (`Medium/High` daily, `XHigh` on `XL/Deep`) for Pro/daily work and `Orchestrator (Carbon)` (`Medium/High`) for Ultra deep redesigns; avoid `Low` planner depth on `L/XL/Deep` and `XHigh` on tiny `S`; native Hydrogen edits 1–3F (avoid `flash` edit subagents); `Read-Once Guard` extends `30m / 55 steps`; `orchestratorSmartSynergy:true` skips pre-gate polls on routine `S/M`.
  - **Hydrogen / Neon (`Low/Medium/High/XHigh`)**: Unlocks 95% implicit prefix caching via `12k–18k` `SessionStart` `RepoMap` (`>4096` tokens) and `250k` compaction epoch; keep parallel shares on `Model:"inherit"` and cap Neon verbosity on simple steps (`$15/1M` out).
  - **Swarm (`swarmMode`, `swarmWorkerTier`, `swarmAutoVerifier`, `swarmQuotaFailover`)**: Idle on `S/M` and narrow `L`; activates on `XL` (`auto_xl`), `L+XL` (`aggressive_l`), or `/swarm` (`manual_only`). Supports `hydrogen_auto` (`gemini-4-hydrogen-medium`) and `neon_auto` (`gemini-4-neon-medium`) in `workspace:"share"`, spawns `@verifier` (`workspace:"inherit"`), blocks `ask_question` in `<swarm_worker>`, and swaps `[quota]` across buckets via `swarm{action:"models"}` + `swarm{action:"model"}`.
- **Pre-Task Gate**: Controlled by `confirmBeforeRun`, `confirmThreshold` (`"ALL"|"M"|"L"`), and `orchestratorSmartSynergy`.

## 2. Guardrails & Coprocessors (v2.0 -> v4.0.4)
- **Context & Safety Guardrails**: `repoMap` (AST + X-Ray `🩻`), `toolPruning` (+ `Context7`), `diffOnly` (`edit_file` / `diff-patcher`), `obsMasking`, `cascadeVerify`, `shadowCheckpoints`, `transactionalPatch`, `blastRadius` (`🔗`), `circuitBreaker` (3 repeats), `historyCompaction` (`compactionTokenThreshold`), `pitfallLedger`, `thinkingLimiter`, `pageRankGraph` (`d=0.50`), `zeroTurnSlices`, `bayesianRouter` (`Beta(α,β)` 14d decay + fragility cap `200`), `testImpactVerify`, `sessionHandoff`, `readDedup` (`800L/46KB`), `skillCrystallizer` v2 (`audit-skill.mjs`), and `securityGuard`.
- **Local GPU Copilot (`core/local-gpu-engine.mjs`)**: Offloads `gpu_distill` (`gemma4:12b`) and Hybrid GPU+RAM `i8bin-v2` semantic search (`qwen3-embedding:0.6b`/`4b`, `ram_search`/`ram_context_pack`/`gpu_semantic_search`) to `127.0.0.1:11434` (`gpuMaxVramMb`, `gpuEmbedKeepAlive`). Inspect or unload via `gpu_status` or `node core/ag-cli.mjs gpu <status|warm|search|distill|unload>`.
- **Multi-Core CPU Coprocessor (`core/cpu-worker-pool.mjs` + `core/cpu-reranker.mjs`, 0 MB VRAM)**: Shared `worker_threads` pool (`cpuMaxThreads`, `unref()` auto-sleep) for parallel AST/cAST parsing, in-RAM Trigram+BM25F + Cross-Reranker (`<15ms`), and concurrent `cpuParallelVerify` micro-tests/linters.

## 3. Panel Link & Learned Recipes
Always include `[The Tunnel](sidecar://antigravity-model-router/panel/)` on `M/L/XL` badges or router settings replies.
- **[Invariant]** Translate conversational creator prompts autonomously by inspecting project files first; never expect the user to specify file names, technical jargon, or manual prompt engineering.
- **[Recipe]** When packaging plugins or projects for external sharing/GitHub release, exclude `.cache/` and temporary logs, verify clean default state, and generate clear Russian documentation with visual previews.

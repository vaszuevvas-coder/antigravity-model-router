<p align="center">
  <img src="assets/banner.svg" alt="The Tunnel v4.0.1 — 3D AI Autopilot & Coprocessor for Google Antigravity" width="100%" />
</p>

# The Tunnel `v4.0.1` — 3D AI Autopilot & Model Router

> Intelligent 3D model routing, multi-core CPU coprocessing, adaptive In-RAM project memory (`4–32 GB`), optional local Ollama Int8 GPU acceleration, and 59 safety & verification guardrails for **Google Antigravity** — built with zero external runtime dependencies on **Node.js `>=22` ESM**.

---

## 🏆 Flagship Features (The Best Parts)

### 1. 3D Task Tensor (`Breadth × Depth × Risk`) & Smart-Synergy Routing
- **Automatic complexity grading (`S / M / L / XL`)**: `core/tool-pruner.mjs` and `core/model-profile.mjs` analyze file breadth, architectural/concurrency depth, and blast radius (`reverseDeps`) before edits begin.
- **Gemini 4 Smart-Synergy & Split-Turn Handoff**: Pairs `Orchestrator` planning with `Hydrogen` execution (`-24%` quota overhead on `L/XL` tasks vs. standalone heavy models), enforces explicit thinking/planner depth (`Low` / `Medium` / `High` / `XHigh`), and supports AGY 2.35+ Split-Turn Model-Switch Handoff (`core/hook-runner.mjs`, `rules/AGENTS.md`) when a selector change is needed.
- **Adaptive Pre-Task Gate & Grill-Me Frontier**: Generates 3 concrete, non-boilerplate plan choices (`buildAdaptive3DOptionsBlueprint`) and surfaces unsettled design-tree decisions upfront when `confirmBeforeRun` is active.

### 2. Adaptive In-RAM Project Memory (`4–32 GB`) & Zero-Turn Context MCP
- **Instant RAM-first code navigation**: `core/ram-memory-engine.mjs` and `core/ram-memory-mcp.mjs` keep your workspace cached in RAM (`Tri-Gram + BM25F`, `ram_search`, `ram_slice`, `ram_context_pack`) to eliminate redundant full-file reads.
- **AST Skeletonizer, RepoGraph & Graphify v2**: `core/cpu-ast-graph-compressor.mjs` provides `LongCodeZip` 0/1 Knapsack folding (`ram_slice({ skeleton: true })`), 1-hop/k-hop `RepoGraph` symbol call graphs (`ram_graph_query`), PageRank blast-radius scoring, `EXTRACTED/INFERRED/AMBIGUOUS` edge provenance with `topologyHash`, Surprising Bridges, `dynamic_import` / `re_exports` traversal, and symbol-level patching (`patch-symbol`).

### 3. Multi-Core CPU Coprocessor (`node:worker_threads`)
- **Zero-VRAM Cross-Reranker (`<15 ms`)**: `core/cpu-reranker.mjs` and `core/ru-en-lexicon.mjs` combine 260+ bilingual RU↔EN engineering stems with multi-core reranking (`core/cpu-worker-pool.mjs`).
- **Token-Economy Compression Suite**:
  - `Drain3` log clustering + `Headroom` JSON array/JSONL smart crusher (`core/obs-masker.mjs`),
  - `Myers` line delta-on-reread (`core/read-dedup.mjs`),
  - `TOON` compact tabular serialization (`-35%` RepoMap tokens via `core/toon-formatter.mjs`),
  - `SimHash64` near-duplicate detection and `CPU Semantic Mutation Guard` (`core/cpu-mutation-guard.mjs`) for verifying test strength in isolated temp copies.

### 4. Local Ollama GPU Engine (`i8bin-v2` · Zero Cloud Tokens)
- **Quantized Int8 MRL-512 Vector Index**: `core/local-gpu-engine.mjs` stores compact `.bin` + `.meta.json` embeddings (`qwen3-embedding:0.6b`) for hybrid semantic + lexical search (`gpu_semantic_search`), auto-detects `gpuModelsDir`, and unloads VRAM cleanly on exit (`gpuUnloadOnExit`).
- **1-Click Ollama Installer & Mirror Support**: `core/gpu/gpu-vram-runtime.mjs` (`startOllamaInstallJob`) provisions Ollama into a user-selected directory (`gpuOllamaDir`) and supports an optional HuggingFace mirror (`gpuPreferHfMirror`).
- **0-Token Local Distillation, Vision & Diff Critic**: `gemma4:12b` compresses massive logs/docs (`gpu_distill`), catches post-edit regressions (`gpuPostEditCritic`), and audits pasted UI screenshots locally (`/api/composer/vision`) without spending cloud quota.

### 5. Native Swarm Orchestration & Quota Burn-Rate Pacer
- **Isolated Multi-Agent Execution**: `core/swarm-controller.mjs` isolates swarm state per `conversationId × workspace`, enforces `workspace: "share"` / `"branch"` separation, auto-attaches `@verifier` + monitor, and protects coordinators from premature role drift.
- **Quota Pacer, Implicit Cache Warmth & Score-Driven Failover**: `core/quota-pacer.mjs` tracks rolling 30m/60m quota consumption, validates Gemini 4 static prompt prefix stability (`>=4096` tokens), tracks live Implicit Cache Warmth windows, pins stateless turn effort (`resolveStatelessTurnEffort`), and routes around cooldowns via `resolveScoreDrivenComboTarget`.

### 6. Turn-Level Time-Machine, Shadow Worktrees & Sidecar Control Panel (`EN / RU`)
- **Atomic Turn Rollback & Git Sandboxes**: `core/shadow-guard.mjs` and `core/shadow-worktree.mjs` bind checkpoints to user turns (`rollbackTurn`) and run risky experiments inside detached git worktrees before promoting changes.
- **Sidecar Control Panel (`sidecars/panel/`)**: CSP-safe localhost HUD (`server.mjs` + `ui.html`) with **Lite / Full** view modes (`panelViewMode`), adaptive UI scaling (`panelUiScale`), safe 1-click GitHub Plugin Updater (`core/plugin-updater.mjs`), native folder pickers, live **EN / RU** switching (`00-i18n.js`), Crimson Rail industrial dark theme, 5-contour Hybrid Guard Dock & 1-click Runtime Health-Doctor, **Smart Composer 2.0** (`@file:`, `@symbol:`, `@git:diff`, `@error:last` chips, Ghost Text, local Vision screenshot audit, optional voice dictation, and `0-token` pre-commit check), live token/cache/CPU/RAM/GPU telemetry, and one-click management of all 15 built-in skills.
- **Interactive Project Map (`?view=graph` & modal)**: Multi-level architecture map (`Folders / Files / Symbols` via `core/project-graph-builder.mjs` + `07*.js`) featuring hybrid architectural layer columns (interactive layer header filter/drag, free node detachment/reattachment & reset), Layered (Sugiyama) and Force layouts, 5 engineering lenses (**Architecture**, **Blast & Diff**, **Tarjan SCC Cycles & Orphans**, **Git Hotspots**, **Path A→B**), a Context Cart (`@file:` batching to Smart Composer with token budget), Edge Bundling, interactive Minimap, GPU semantic search, Mermaid/PNG export, and **Barnes-Hut `O(N log N)` + WebGL2 Instanced Renderer** scaling up to 25k nodes.

---

## ⚙️ Additional Capabilities & Safety Contours

- **Bayesian v2 & File Fragility Matrix**: `core/bayesian-router.mjs` learns domain and file reliability (`fragileFiles`) with a 14-day half-life and prototype/cross-drive collision protection.
- **59 Guardrails (`GUARDRAIL_KEYS`) & Verification Pipeline**: `selfVerify`, `cascadeVerify`, `testImpactVerify`, live `LSP Bridge` (`core/lsp-bridge.mjs`), `circuitBreaker` (with Stalled Tool-Loop Guard), Diff Reuse % metrics, and Fresh/Stale-Test unlazy acceptance gates (`core/completion-gates.mjs` + `GATES.md`), plus `core/shortcut-debt-ledger.mjs` (`// shortcut:` debt scanner & `no-trigger` rot flagging).
- **Lean & Terse Controls, Caveman Blocks & OpenSpec**: Configurable `leanMode` (7-rung Ladder of Laziness) and `terseMode` (ASD-STE100 / ultra-dense telegraphic replies), `core/reusable-blocks-specs.mjs` (cached micro-script blocks + bounded `<=50 KB` OpenSpec feature deltas), RTK command output profiles (`core/obs-masker.mjs`), and `agentskills.io` validation + A/B Eval Benchmark Harness (`audit-skill.mjs`, `eval-skill-benchmark.mjs`).
- **3-Layer Episodic Memory, CCR & Cross-Repo Federation**: `core/sqlite-knowledge-hub.mjs` (`node:sqlite` WAL database) powers reversible Headroom CCR terminal log storage (`ram_ccr_retrieve`), 3-layer episodic recall (`ram_memory_recall`), `victory_recipes`, and `repo_federation` search.
- **Runtime Wiretap & Automated `git bisect`**: `core/runtime-wiretap.mjs` (`node core/ag-cli.mjs watch <cmd...>`) captures crashes with `±6`-line code frames and SimHash64 deduplication, paired with `git_bisect_auto` in an isolated worktree.
- **Security, Secret Redaction & AgentShield**: `core/security-guard.mjs` (including UTF-16LE BOM `.agentignore` support), `core/obs-masker.mjs`, and `core/agent-shield.mjs` block destructive root wipes, protect `.env`/secrets, and audit MCP servers, hooks, and imported skills.
- **Self-Evolution, Stack Recommender & Skill Bridge**: `core/friction-observer.mjs` + `core/skill-crystallizer.mjs` distill repeated pitfalls into skills; `core/project-setup-recommender.mjs` & `core/skill-registry-bridge.mjs` recommend stack setups and quarantine-scan external skills before import.
- **15 Built-in Specialized Skills (`skills/`)**: `model-router`, `context-fork`, `deep-stress-auditor` (with interactive webapp dogfooding), `ui-ux-design-system` (with `DESIGN.md` extractor, WCAG/i18n UI auditor, UX matrix & open media search), `ast-codemod-refactor`, `program-slicer-ocd`, `delta-bug-minimizer`, `skill-architect`, `github-publish-guard` (pre-publish privacy, GitHub policy & release-parity auditor), `cli-anything-harness`, `playwright-cli`, `game-systems-architect`, `binary-app-localizer`, `programmatic-video-studio`, and `vj-video-fx-studio`.

---

## 📁 Project Structure

```text
antigravity-model-router/
├── plugin.json                # Plugin manifest (The Tunnel v4.0.1)
├── package.json               # ESM scripts (test, audit, lint:skills, pack, version:check)
├── router-state.json          # Sanitized default router & guardrail template
├── hooks.json                 # SessionStart / PreInvocation / PreToolUse / PostToolUse / Stop hooks
├── mcp_config.json            # In-RAM Memory & Knowledge Hub MCP configuration
├── install.js                 # Cross-platform installer & i8bin-v2 cache migrator
├── SECURITY.md                # Security policy & local-only architecture guarantees
├── CHANGELOG.md               # Release history
├── core/                      # 57 core ESM modules (65 total with gpu/progress/ram submodules)
├── sidecars/panel/            # Localhost Control Panel (server.mjs, ui-src/, ui.html)
├── agents/                    # Read-only verifier subagent (router-verifier.md)
├── skills/                    # 15 built-in domain skills & deterministic scripts
├── tests/                     # 46 automated test suites (node:test)
└── rules/                     # Autopilot & routing rules (AGENTS.md)
```

---

## 🚀 Installation (Windows, macOS & Linux)

### Option 1 — Cross-Platform CLI (Recommended for Windows / macOS / Linux)
Requires **Node.js `>=22.0.0` LTS**:
```bash
git clone https://github.com/vaszuevvas-coder/antigravity-model-router.git
cd antigravity-model-router
node install.js
```
Then restart **Google Antigravity** (or reload the sidecar panel) to activate hooks, In-RAM MCP, and **The Tunnel** HUD.

### Option 2 — Windows 1-Click Installer (`Setup.exe`) & Portable `.zip`
- Download `The-Tunnel-v4.0.1-Setup.exe` or `The-Tunnel-v4.0.1.zip` from [GitHub Releases](https://github.com/vaszuevvas-coder/antigravity-model-router/releases/latest).
- `Setup.exe`, `install.js`, and `install.sh` auto-detect your OS locale (`en` / `ru`, overridable via `--lang=en|ru` or `TUNNEL_LANG`), and `Setup.exe` supports both GUI and silent CLI flags (`--silent` / `/S`, `--uninstall`) while keeping a backup of `router-state.json`.
- In the portable `.zip`, run `install.bat` / `uninstall.bat` (or `Установить плагин.bat` / `Удалить плагин.bat`) on Windows, or `./install.sh` on macOS / Linux. Direct extraction or `git clone` into `~/.gemini/config/plugins/antigravity-model-router` is also supported — `The Tunnel` auto-calibrates hardware limits and MCP paths on first launch.

### Developer & Release Verification Commands
```bash
# Run full test suite (node:test)
npm test

# Lint all built-in skills strictly
npm run lint:skills

# Build standalone Windows Setup.exe + portable .zip + SHA256SUMS.txt in dist/
npm run pack
```

- **Safe Upgrades**: `install.js` preserves your live `router-state.json` (creating `.cache/router-state.backup.json`), cleans orphaned managed files without touching `.cache`, updates `mcp_config.json` paths/RAM budgets, and migrates legacy vector caches to `i8bin-v2`.

---

## 🛠️ CLI Reference (`core/router-cli.mjs`)

```bash
# Inspect active strategy, quotas, and 59 guardrails
node core/router-cli.mjs status

# Symbol usages, data-flow slicing, file chronos, dead exports & AST codemod
node core/router-cli.mjs usages <symbol> [dir]
node core/router-cli.mjs slice <file> <symbol> [focusLine]
node core/router-cli.mjs chronos [dir] [--reset]
node core/router-cli.mjs dead-exports [dir]
node core/router-cli.mjs codemod --find <old> --replace <new> [--word] [--regex] [--dry-run]

# Profile backup/restore, skill listing & pitfall crystallization
node core/router-cli.mjs backup [path]
node core/router-cli.mjs restore [path]
node core/router-cli.mjs skills
node core/router-cli.mjs learn --skill <slug> --pattern "<rule>" [--category recipe|invariant] [--trigger <keyword>]

# Shortcut debt scanner, OpenSpec deltas, reusable blocks & skill A/B evals
node core/router-cli.mjs debt [dir] [--marker <name>] [--include-tests] [--json]
node core/router-cli.mjs spec (list [--all] | show <slug> | propose|apply|archive <slug> ["markdown"])
node core/router-cli.mjs blocks (list [query] | save <name> "<command>" [description])
node core/router-cli.mjs eval-skill (init <skillDir> | aggregate <iterationDir>)
```

---

## 🔒 Security & License

- See [SECURITY.md](SECURITY.md) for vulnerability reporting and local-only loopback guarantees.
- **Source-Available & Commercial Royalty License** ([LICENSE](LICENSE)) — **free to download and use** for personal, educational, and development workflows. Commercial sale, paid redistribution/forks, or bundling into paid products/SaaS is prohibited without a prior written agreement or royalty arrangement with **Vasili Zuev** (`https://github.com/vaszuevvas-coder`).
- **Created by Vasili Zuev**.

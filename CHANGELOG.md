# Changelog — **The Tunnel**

> **Language:** **English** | [Русский](CHANGELOG.ru.md)

All notable changes to **The Tunnel** (`antigravity-model-router`) are documented in this file in accordance with [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [SemVer](https://semver.org/).

> The timeline from `v3.8.0` to `v4.0.7` was reconstructed from development logs and verified against the codebase (`59` primary / `71` total core ESM modules, `59` `GUARDRAIL_KEYS` contours, `15` built-in skills, and `57` automated test suites).

---

## [4.0.7] — 2026-11-27

### Added & Improved (Modular Bento UI, Bilingual Changelog, Security Hardening & 57 Test Suites)
- **Modular Bento Panel Layout, Variant B Category Pages & Scroll-Fade HUD ([sidecars/panel/ui-src/head-body.html](sidecars/panel/ui-src/head-body.html), [sidecars/panel/ui-src/styles.css](sidecars/panel/ui-src/styles.css), [sidecars/panel/ui-src/js/05-progress-hud.js](sidecars/panel/ui-src/js/05-progress-hud.js), [tests/router-task-progress.test.mjs](tests/router-task-progress.test.mjs))**:
  - Upgraded Behavior, Bugs, Memory, and Settings tabs to a modular Bento layout with seamless Variant B category pages and inline accordions.
  - Added dynamic scroll-fade CSS masks (`has-fade-top` / `has-fade-bottom`) and scroll/resize sync for `#agActiveChatsStack` in the Progress HUD.
- **Bilingual EN/RU Changelog with Automatic `uiLanguage` Switching ([CHANGELOG.md](CHANGELOG.md), [CHANGELOG.ru.md](CHANGELOG.ru.md), [core/changelog-parser.mjs](core/changelog-parser.mjs), [sidecars/panel/server.mjs](sidecars/panel/server.mjs))**:
  - Added a dedicated Russian changelog (`CHANGELOG.ru.md`) alongside English `CHANGELOG.md`, automatically selected in the panel's "What's New" modal according to `uiLanguage`.
- **Security Hardening & Runtime Reliability ([core/security-guard.mjs](core/security-guard.mjs), [core/plugin-updater.mjs](core/plugin-updater.mjs), [sidecars/panel/server.mjs](sidecars/panel/server.mjs), [core/router-cli.mjs](core/router-cli.mjs), [tests/security-cli-depth-contracts.test.mjs](tests/security-cli-depth-contracts.test.mjs))**:
  - Hardened sidecar token/port validation, ALS auth isolation, queue lifecycle, Project Graph initialization races, and repo-pinned SHA-256 verification in `plugin-updater.mjs`.
  - Expanded `redactSecretsInText` coverage for database URIs, PEM blocks, JWTs, Bearer tokens, and Windows paths; decoupled `router-cli.mjs` dependencies.
- **Project Map AI Presets, RU Shorts/Reels Media & 57 Automated Test Suites ([sidecars/panel/ui-src/js/07-project-graph.js](sidecars/panel/ui-src/js/07-project-graph.js), [scripts/render-shorts-ru.mjs](scripts/render-shorts-ru.mjs), [tests/quota-pacer.test.mjs](tests/quota-pacer.test.mjs))**:
  - Upgraded Project Map AI presets (risks/bugs/tests) with richer graph relations context.
  - Added 25-second vertical Russian Shorts/Reels promo video pipeline with Neural TTS, karaoke subtitles, and SFX.
  - Added dedicated unit, edge-case, and regression tests for `core/quota-pacer.mjs` (`tests/quota-pacer.test.mjs`), bringing the suite count to `57`.

---

## [4.0.6] — 2026-11-27

### Added & Improved (Modular In-RAM Engine, 7-Tab Cockpit, Project Map 2.0, Crimson Diamond Branding & Reliability Hardening)
- **In-RAM Engine Decomposition into 4 Specialized Submodules ([core/ram-memory-engine.mjs](core/ram-memory-engine.mjs), [core/ram/ram-search.mjs](core/ram/ram-search.mjs), [core/ram/ram-slicer.mjs](core/ram/ram-slicer.mjs), [core/ram/ram-graph-queries.mjs](core/ram/ram-graph-queries.mjs), [core/ram/ram-context-packs.mjs](core/ram/ram-context-packs.mjs), [core/ram/ram-index-helpers.mjs](core/ram/ram-index-helpers.mjs), [tests/ram-engine-refactor.test.mjs](tests/ram-engine-refactor.test.mjs))**:
  - Extracted search (`BM25F + Trigram + CSR + GPU RRF`), AST slicing (`LongCodeZip` Knapsack), graph queries (`RepoGraph` / blast radius / PageRank), and Zero-Turn context pack assembly from monolithic `ram-memory-engine.mjs` into 4 clean submodules (`71` total core ESM modules) without changing external contracts.
- **Interactive Project Map — Rich Tooltips & Context-Aware Link Dispatch ([sidecars/panel/ui-src/js/07-project-graph.js](sidecars/panel/ui-src/js/07-project-graph.js), [sidecars/panel/ui-src/js/07b-project-graph-lenses.js](sidecars/panel/ui-src/js/07b-project-graph-lenses.js), [sidecars/panel/graph-icon.svg](sidecars/panel/graph-icon.svg), [tests/project-graph-panel.test.mjs](tests/project-graph-panel.test.mjs))**:
  - Added informative hover tooltips for nodes and edges with a `750 / 500 ms` delay.
  - Sending a node or folder from the Project Map to chat or Smart Composer now automatically attaches related modules, folder files, and detected risks (cycles / high blast radius / fragility).
- **7-Tab Full Panel Cockpit, `autoSpecOutput`, `QuotaPacer v2` & Progress ETA Forecasting ([sidecars/panel/server.mjs](sidecars/panel/server.mjs), [sidecars/panel/lib/panel-state-skills.mjs](sidecars/panel/lib/panel-state-skills.mjs), [sidecars/panel/ui-src/](sidecars/panel/ui-src/head-body.html), [core/tool-pruner.mjs](core/tool-pruner.mjs), [core/quota-pacer.mjs](core/quota-pacer.mjs), [core/task-progress.mjs](core/task-progress.mjs), [core/progress/progress-parsers.mjs](core/progress/progress-parsers.mjs))**:
  - Implemented modular Full-panel tab navigation (`panelFullTab`: `cockpit | behavior | economy | hardware | bugs | memory | settings`) with adaptive section loading.
  - Added `autoSpecOutput` (`thinking | chat`) mode for internal execution specs and the `compileUserIntentToTechSpec` / `compileVoiceOrLongRuPromptPivot` intent compiler.
  - Upgraded `QuotaPacer` to v2 schema with a 5-hour rolling window, and added historical duration-based ETA estimation (`determinate / estimated / indeterminate`) for background tasks in the Progress HUD.
- **Crimson Diamond Brand Identity, Security Hardening & 56 Automated Test Suites ([assets/logo.svg](assets/logo.svg), [assets/banner.svg](assets/banner.svg), [scripts/pack-release.mjs](scripts/pack-release.mjs), [core/safe-json.mjs](core/safe-json.mjs), [core/cache-dir.mjs](core/cache-dir.mjs), [install.js](install.js), [sidecars/panel/lib/panel-security.mjs](sidecars/panel/lib/panel-security.mjs), [README.md](README.md))**:
  - Replaced the extension logo, favicon, and installer `.ico` generator with the signature **Crimson Diamond** icon; redesigned the banner and `README.md` in `Crimson Rail` style with real captures, GIF animations, and a 30-second interactive video showcase with audio.
  - Hardened atomic file locks and `.tmp` cleanup in `safe-json.mjs`, path/symlink guards and MCP merging in `install.js`, plus `AsyncLocalStorage` request isolation and token validation in `panel-security.mjs`.
  - Expanded test coverage from `48` to `56` automated suites (`tests/cache-dir.test.mjs`, `tests/ram-engine-refactor.test.mjs`, `tests/router-composer.test.mjs`, `tests/router-gpu.test.mjs`, `tests/router-panel.test.mjs`, `tests/router-release.test.mjs`, `tests/router-task-progress.test.mjs`, `tests/stress-audit-hardening.test.mjs`).

---

## [4.0.5] — 2026-11-26

### Added & Fixed ("What's New" Viewer, NDJSON Debug Logger & Health-Doctor RAM Fix)
- **Built-in "What's New" Viewer ([core/changelog-parser.mjs](core/changelog-parser.mjs), [sidecars/panel/server.mjs](sidecars/panel/server.mjs), [sidecars/panel/ui-src/head-body.html](sidecars/panel/ui-src/head-body.html), [sidecars/panel/ui-src/js/04-sentinel-layout.js](sidecars/panel/ui-src/js/04-sentinel-layout.js), [sidecars/panel/ui-src/js/00-i18n.js](sidecars/panel/ui-src/js/00-i18n.js))**:
  - Added a zero-dependency `CHANGELOG.md` parser and `/api/plugin/changelog` route to display release history directly inside the panel.
  - Placed a compact book icon in the top-right header of the panel to open the "What's New" modal with full RU/EN localization.
- **Rotating NDJSON Logger & Diagnostic Bundle ([core/debug-logger.mjs](core/debug-logger.mjs), [core/hook-runner.mjs](core/hook-runner.mjs), [core/plugin-updater.mjs](core/plugin-updater.mjs), [sidecars/panel/lib/panel-state-skills.mjs](sidecars/panel/lib/panel-state-skills.mjs), [sidecars/panel/server.mjs](sidecars/panel/server.mjs))**:
  - Added `debugLogMode` (`off | errors | verbose`) with automatic log rotation and secret/home-path redaction when recording logs and assembling diagnostic bundles (`buildDiagnosticBundle`).
  - Wired telemetry into `hook-runner.mjs`, `plugin-updater.mjs`, `server.mjs`, and the panel UI.
- **Health-Doctor Persistent RAM Error Fix & Build Cleanup ([core/health-doctor.mjs](core/health-doctor.mjs), [core/ram-memory-mcp.mjs](core/ram-memory-mcp.mjs), [install.js](install.js), [sidecars/panel/ui-src/styles.css](sidecars/panel/ui-src/styles.css), [tests/changelog-debug-panel.test.mjs](tests/changelog-debug-panel.test.mjs), [tests/v335-stage2-features.test.mjs](tests/v335-stage2-features.test.mjs))**:
  - Fixed RAM cache state evaluation in `diagnoseRuntimeHealth` (accounting for `active` and total file count across workspaces) and added IPC route `POST /warm` in `core/ram-memory-mcp.mjs` for instant warming.
  - Added `.github` exclusion when copying plugin files in `install.js`, and removed `backdrop-filter` and `border-radius` drift in `styles.css`.

---

## [4.0.4] — 2026-11-26

### Added (Internal Spec-First / Auto-Spec Mode)
- **Automatic Silent Internal Prompt Compilation ([core/tool-pruner.mjs](core/tool-pruner.mjs), [core/hook-runner.mjs](core/hook-runner.mjs), [rules/AGENTS.md](rules/AGENTS.md))**:
  - Added `resolveAutoSpecMode` (`off | auto | always` plus one-shot prompt overrides `/spec`, `/autospec off|auto|always`, `без авто-тз`) and `buildAutoSpecDirective`, integrated into `estimateTaskGradeAndThinkingBudget` and `SessionStart` (`buildStaticSessionStartHeader`).
  - On `M/L/XL` and deep architectural tasks (in `auto` mode, default) or before any code edits (in `always` mode), after scouting via `ram_search`/`ram_slice`, the agent silently compiles an internal execution spec inside `<thinking>` (`FILES+LINES | SYMBOLS & CONTRACTS | BLAST RADIUS | EDGE CASES | VERIFY`) without dumping a wall of prompt text into chat.
- **State Schema, Control Panel & Automated Tests ([sidecars/panel/lib/panel-state-skills.mjs](sidecars/panel/lib/panel-state-skills.mjs), [sidecars/panel/ui-src/](sidecars/panel/ui-src/head-body.html), [sidecars/panel/ui.html](sidecars/panel/ui.html), [tests/auto-spec-mode.test.mjs](tests/auto-spec-mode.test.mjs))**:
  - Added `autoSpecMode` (default `'auto'`) to `DEFAULT_STATE` and `sanitizeStatePatch`, plus an **Off / Auto M+ / Always** toggle in the sidecar panel with full RU/EN localization in `00-i18n.js`.
  - Added `tests/auto-spec-mode.test.mjs` covering schema validation, directives, triggers, and UI sync.

---

## [4.0.3] — 2026-11-26

### Fixed (Auto-Clearing Restart Modal After Google Antigravity Restart)
- **Eliminated Repeated "Restart Required" Prompt ([core/plugin-updater.mjs](core/plugin-updater.mjs), [sidecars/panel/server.mjs](sidecars/panel/server.mjs), [tests/plugin-updater.test.mjs](tests/plugin-updater.test.mjs))**:
  - `sidecars/panel/server.mjs` now records `PANEL_SERVER_STARTED_AT` and `PANEL_LOADED_VERSION` in memory at startup, while `plugin-update-status.json` stores `appliedByPid` when an update is applied.
  - `getPluginUpdateStatus(pluginRoot, runtimeCtx)` automatically clears stale `needsRestart: true` state on disk once a new panel process boots with the updated version after restarting Google Antigravity (`pid !== appliedByPid` or `serverStartedAt > finishedAt`, and `runningVersion >= targetVersion`), preserving backwards compatibility with legacy status files lacking `appliedByPid`.

---

## [4.0.2] — 2026-11-26

### Fixed (Direct Jump from "Risks · Fragile Files" to Project Map)
- **File Focus on "Map" Click ([sidecars/panel/ui-src/js/04b-guard-dock.js](sidecars/panel/ui-src/js/04b-guard-dock.js), [sidecars/panel/ui-src/js/07-project-graph.js](sidecars/panel/ui-src/js/07-project-graph.js), [sidecars/panel/server.mjs](sidecars/panel/server.mjs), [sidecars/panel/ui.html](sidecars/panel/ui.html), [tests/project-graph-panel.test.mjs](tests/project-graph-panel.test.mjs))**:
  - `openFragileInGraph(filePath)` passes the target file directly into `openProjectGraphModal({ focusFile })`, and `/api/project-graph/open-window` validates and forwards the `focus` query parameter into the standalone Project Map window URL.
  - When opened with `focusFile` (both in the standalone window and inline modal), the Map automatically enables the "Tests" filter for test files, switches to local file view (`mode: 'local'`, `viewLevel: 'files'`), selects the node, centers the camera on it, and opens its inspector card.

---

## [4.0.1] — 2026-11-26

### Fixed (1-Click Auto-Updater Reliability over Proxy/VPN & IPv6)
- **Resilient Update Transport ([core/plugin-updater.mjs](core/plugin-updater.mjs), [sidecars/panel/server.mjs](sidecars/panel/server.mjs), [tests/plugin-updater.test.mjs](tests/plugin-updater.test.mjs))**:
  - Enabled IPv4-first DNS resolution (`dns.setDefaultResultOrder('ipv4first')`) and raised the update check timeout from `6000` to `15000` ms (fixing `fetch` hangs/timeouts on IPv6).
  - Added automatic transport fallback via system proxy (`WinINET` / `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`) and `curl.exe`/`curl` with `-4` on timeout or `fetch failed` for both `checkForPluginUpdate` and `downloadUpdateArchive` (preserving `isAllowedGitHubUrl` and `MAX_UPDATE_ARCHIVE_BYTES`).
  - Added a fallback chain of release check sources: if `api.github.com` fails, checks `github.com/.../releases/latest` redirect (`source: 'release_redirect'`), then `raw.githubusercontent.com/.../main/plugin.json` (`source: 'branch'`), formatting localized error details via `formatUpdateError`.

---

## [4.0.0] — 2026-11-26

### Added & Updated ("Crimson Rail" Redesign, Hybrid Guard Dock, Health-Doctor, 4 Core Hardening Waves & 15 Built-in Skills)
- **Industrial "Crimson Rail" Sidecar Redesign & 5-Contour Hybrid Guard Dock ([DESIGN.md](DESIGN.md), [sidecars/panel/ui-src/js/04b-guard-dock.js](sidecars/panel/ui-src/js/04b-guard-dock.js), [sidecars/panel/ui-src/styles.css](sidecars/panel/ui-src/styles.css), [sidecars/panel/ui-src/head-body.html](sidecars/panel/ui-src/head-body.html), [sidecars/panel/ui-src/js/00-i18n.js](sidecars/panel/ui-src/js/00-i18n.js), [sidecars/panel/ui-src/js/02-telemetry-cards.js](sidecars/panel/ui-src/js/02-telemetry-cards.js), [sidecars/panel/ui-src/js/03-hardware-gpu.js](sidecars/panel/ui-src/js/03-hardware-gpu.js), [sidecars/panel/ui-src/js/04-sentinel-layout.js](sidecars/panel/ui-src/js/04-sentinel-layout.js), [sidecars/panel/ui.html](sidecars/panel/ui.html), [sidecars/panel/server.mjs](sidecars/panel/server.mjs), [sidecars/panel/lib/panel-telemetry-collectors.mjs](sidecars/panel/lib/panel-telemetry-collectors.mjs), [tests/guard-dock-panel.test.mjs](tests/guard-dock-panel.test.mjs))**:
  - Formalized the `Crimson Rail` design contract (`DESIGN.md`): high-density engineering cockpit without heavy glassmorphism, featuring monochrome SVG icons, a compact GPU/GGUF/RAM card, and full bilingual `00-i18n.js` coverage.
  - Introduced **Hybrid Guard Dock** (tiles in Lite + 36px rail in Full): autonomous synchronization of 5 protection contours (Bugs/Sentinel, AgentShield, Instincts, Risks, Environment/Health-Doctor) and live safety pulse checks via `/api/guard-pulse`.
- **Runtime Health-Doctor Self-Diagnostics & ROI Savings Timeline ([core/health-doctor.mjs](core/health-doctor.mjs), [sidecars/panel/lib/panel-telemetry-collectors.mjs](sidecars/panel/lib/panel-telemetry-collectors.mjs), [sidecars/panel/server.mjs](sidecars/panel/server.mjs), [tests/v335-stage2-features.test.mjs](tests/v335-stage2-features.test.mjs))**:
  - Added `core/health-doctor.mjs` for diagnostics and 1-click safe recovery: stale `.lock`/`.tmp` cleanup, orphaned shadow worktree removal, Ollama startup, VRAM fallback, and RAM daemon warming.
  - Implemented `collectRoiTimeline` token savings timeline collection and panel self-healing API endpoints.
- **4 Waves of Core & In-RAM Engine Hardening ([core/ram/ram-index-helpers.mjs](core/ram/ram-index-helpers.mjs), [core/ram-memory-engine.mjs](core/ram-memory-engine.mjs), [core/obs-masker.mjs](core/obs-masker.mjs), [core/friction-observer.mjs](core/friction-observer.mjs), [core/completion-gates.mjs](core/completion-gates.mjs), [core/quota-pacer.mjs](core/quota-pacer.mjs), [core/security-guard.mjs](core/security-guard.mjs), [core/hook-runner.mjs](core/hook-runner.mjs), [core/router-cli.mjs](core/router-cli.mjs), [core/auto-verifier.mjs](core/auto-verifier.mjs), [core/bayesian-router.mjs](core/bayesian-router.mjs), [core/pitfall-ledger.mjs](core/pitfall-ledger.mjs), [skills/deep-stress-auditor/scripts/run-stress-audit.mjs](skills/deep-stress-auditor/scripts/run-stress-audit.mjs), [tests/v336-github-skills-4waves.test.mjs](tests/v336-github-skills-4waves.test.mjs))**:
  - Added `tsconfig.json` (`@/*`) and `package.json` (`#imports`) alias resolution, accurate code-fence-aware Markdown section slicing, RTK terminal output compression profiles, diff constraint-relaxation detector, and 429 quota error classification.
  - Hardened `evaluateComplexityRatchet` in `deep-stress-auditor`, `security-guard` path checks, and `hook-runner` telemetry.
- **New Built-in Skills (`13 → 15`) & Design System ([skills/cli-anything-harness/SKILL.md](skills/cli-anything-harness/SKILL.md), [skills/playwright-cli/SKILL.md](skills/playwright-cli/SKILL.md), [skills/ui-ux-design-system/SKILL.md](skills/ui-ux-design-system/SKILL.md), [scripts/run-mega-diagnostic.mjs](scripts/run-mega-diagnostic.mjs))**:
  - Added `cli-anything-harness` (generates and validates `--json` CLI harnesses for GUI apps) and `playwright-cli` (token-efficient CLI browser automation, mocking, and tracing), plus 4 new references in `ui-ux-design-system`.
  - Synchronized clean `createSanitizedDefaultState` template in `scripts/pack-release.mjs` (`liteQuickCard` in `panelBlockOrder`, `panelTheme`, `panelViewMode`) for clean first-run installs.

---

## [3.35.0] — 2026-11-25

### Added & Improved (Live Auto-Update Modal Overlay, Multi-Source Auto-Skills, Mega-Diagnostic 360° & HUD/Panel Stability)
- **Live Auto-Update Modal Overlay in Panel ([core/plugin-updater.mjs](core/plugin-updater.mjs), [install.js](install.js), [sidecars/panel/ui-src/head-body.html](sidecars/panel/ui-src/head-body.html), [sidecars/panel/ui-src/js/04-sentinel-layout.js](sidecars/panel/ui-src/js/04-sentinel-layout.js), [sidecars/panel/ui-src/js/00-i18n.js](sidecars/panel/ui-src/js/00-i18n.js), [sidecars/panel/ui-src/styles.css](sidecars/panel/ui-src/styles.css), [sidecars/panel/ui.html](sidecars/panel/ui.html), [tests/plugin-updater.test.mjs](tests/plugin-updater.test.mjs), [tests/panel-full-ui-e2e.test.mjs](tests/panel-full-ui-e2e.test.mjs))**:
  - Added fullscreen modal overlay `#pluginUpdateOverlay` with a live progress bar for downloading, unpacking, and installing updates, and moved the notification banner to the top of the panel.
  - Implemented bilingual update error diagnostics (`formatUpdateError`) and `copyFileWithRetrySync` in `install.js` to handle transient Windows file locks (`EBUSY`/`EPERM`/`EACCES`).
- **Multi-Source Skill Auto-Discovery & Vector Matching ([core/gpu/gpu-vector-skills.mjs](core/gpu/gpu-vector-skills.mjs), [core/tool-pruner.mjs](core/tool-pruner.mjs), [core/hook-runner.mjs](core/hook-runner.mjs), [core/ram-memory-mcp.mjs](core/ram-memory-mcp.mjs), [tests/auto-skills.test.mjs](tests/auto-skills.test.mjs))**:
  - Implemented `resolveSkillDiscoveryDirs` to scan active plugins, workspace directories (`.agents/skills`, `.gemini/skills`), personal, and built-in skill catalogs while respecting `enabled: false` and skipping internal swarm skills (`INTERNAL_AUTO_SKIP_SLUGS`).
  - Added `hasSkillIndexDrift` vector index drift detector with end-to-end integration in `PreInvocation` and `tool-pruner`.
- **Unified 6-Contour "Mega-Diagnostic 360°" CLI ([scripts/run-mega-diagnostic.mjs](scripts/run-mega-diagnostic.mjs), [package.json](package.json), [tests/mega-cross-system-e2e.test.mjs](tests/mega-cross-system-e2e.test.mjs))**:
  - Added `npm run audit:mega` for comprehensive validation: hygiene & manifests, `deep-stress-auditor --fuzz`, 8 practical cross-system E2E missions, full regression suite, live GPU/CPU pass, and live CDP panel traversal.
- **HUD Stability, Panel Responsiveness & Regression Tests ([core/task-progress.mjs](core/task-progress.mjs), [core/progress/progress-parsers.mjs](core/progress/progress-parsers.mjs), [sidecars/panel/server.mjs](sidecars/panel/server.mjs), [core/gpu/gpu-critic-chat.mjs](core/gpu/gpu-critic-chat.mjs), [core/gpu/gpu-distill.mjs](core/gpu/gpu-distill.mjs), [tests/panel-ui-audit-regressions.test.mjs](tests/panel-ui-audit-regressions.test.mjs))**:
  - Added auto-close TTLs for stale background tasks (`STALE_BG_TASK_TTL_MS` and `STALE_DAEMON_BG_TASK_TTL_MS`) and a fast settings-save path (`canUseFastPath`) in the panel server.
  - Expanded the automated test suite to `43` files (`tests/auto-skills.test.mjs`, `tests/mega-cross-system-e2e.test.mjs`, `tests/panel-ui-audit-regressions.test.mjs`).

---

## [3.34.1] — 2026-11-25

### Added & Fixed (Progress HUD Background Tasks, SimHash Clone Details, Router v4.2 Calibration & Utility Deduplication)
- **Background Task Tracking & Updated Progress HUD ([core/progress/progress-parsers.mjs](core/progress/progress-parsers.mjs), [core/task-progress.mjs](core/task-progress.mjs), [sidecars/panel/lib/panel-telemetry-collectors.mjs](sidecars/panel/lib/panel-telemetry-collectors.mjs), [sidecars/panel/ui-src/head-body.html](sidecars/panel/ui-src/head-body.html), [sidecars/panel/ui-src/js/05-progress-hud.js](sidecars/panel/ui-src/js/05-progress-hud.js), [sidecars/panel/ui-src/styles.css](sidecars/panel/ui-src/styles.css), [sidecars/panel/ui-src/js/00-i18n.js](sidecars/panel/ui-src/js/00-i18n.js), [sidecars/panel/ui.html](sidecars/panel/ui.html), [tests/router-core.test.mjs](tests/router-core.test.mjs), [tests/panel-browser-layout-cdp.test.mjs](tests/panel-browser-layout-cdp.test.mjs), [tests/panel-full-ui-e2e.test.mjs](tests/panel-full-ui-e2e.test.mjs))**:
  - Implemented full background task history parsing in transcripts (`running`/`done`/`error`/`cancelled`, merging `toolSummary` and `task-*.log`, secret redaction, and auto-hiding finished tasks via `completedHoldMs`).
  - Moved **Subagents** and **Background** buttons to a dedicated row below the step list with expandable drawers, and removed the redundant saved-tokens pill from the HUD.
- **Bayesian Router v4.2 Calibration ([core/bayesian-router.mjs](core/bayesian-router.mjs))**:
  - Rebalanced `SIGNAL_WEIGHTS` and added automatic migration of asymmetric `v4.0 -> v4.2` priors (`migrateV40AsymmetricPriorsInPlace`).
- **SimHash Clone Pair Details in Background Sentinel ([core/background-sentinel.mjs](core/background-sentinel.mjs), [sidecars/panel/lib/panel-sentinel-adapter.mjs](sidecars/panel/lib/panel-sentinel-adapter.mjs), [sidecars/panel/ui-src/js/04-sentinel-layout.js](sidecars/panel/ui-src/js/04-sentinel-layout.js), [tests/background-sentinel.test.mjs](tests/background-sentinel.test.mjs))**:
  - Added collection and rendering of `clonePairs` details (file, symbol, line, similarity %, `detailRu`/`detailEn`) and reset on clearing findings.
- **Deduplication of Cache, PID & Live-Activity Utilities ([core/cache-dir.mjs](core/cache-dir.mjs), [core/cpu-worker-pool.mjs](core/cpu-worker-pool.mjs), [core/floating-hud.mjs](core/floating-hud.mjs), [core/gpu/gpu-composer-copilot.mjs](core/gpu/gpu-composer-copilot.mjs), [core/gpu/gpu-distill.mjs](core/gpu/gpu-distill.mjs), [core/gpu/gpu-shared-state.mjs](core/gpu/gpu-shared-state.mjs), [core/history-compactor.mjs](core/history-compactor.mjs), [core/hook-runner.mjs](core/hook-runner.mjs), [core/ram-memory-engine.mjs](core/ram-memory-engine.mjs), [core/cpu-graph-contracts.mjs](core/cpu-graph-contracts.mjs), [core/cpu-sbfl-healer.mjs](core/cpu-sbfl-healer.mjs), [sidecars/panel/server.mjs](sidecars/panel/server.mjs))**:
  - Extracted shared `pruneObjectMapByTimestamp`, `isPidAlive`, and `createBaseLiveActivityState` helpers into `core/cache-dir.mjs`.

---

## [3.34.0] — 2026-11-25

### Added & Improved (Plugin Auto-Updater, Lite/Full Panel, Ollama Installer, Hybrid Project Map Layers & Split-Turn Model Switch)
- **Safe GitHub Plugin Auto-Updater ([core/plugin-updater.mjs](core/plugin-updater.mjs), [tests/plugin-updater.test.mjs](tests/plugin-updater.test.mjs), [sidecars/panel/server.mjs](sidecars/panel/server.mjs))**:
  - Release check with 6-hour cache, strict GitHub domain allowlist, and `80 MB` archive limit; 1-click install preserving `router-state.json`, `.cache`, `checkpoints`, and `backups`, with `.git` dev-repo protection and symlink checks.
  - Added panel API routes: `/api/plugin/update-check`, `/api/plugin/update-status`, `/api/plugin/update-apply`, and `/api/plugin/update-dismiss`.
- **`Lite / Full` Panel Mode, UI Scale & 1-Click Ollama Auto-Installer ([core/gpu/gpu-vram-runtime.mjs](core/gpu/gpu-vram-runtime.mjs), [sidecars/panel/server.mjs](sidecars/panel/server.mjs), [sidecars/panel/ui-src/js/01-workspace-wizard.js](sidecars/panel/ui-src/js/01-workspace-wizard.js), [sidecars/panel/ui-src/js/02-telemetry-cards.js](sidecars/panel/ui-src/js/02-telemetry-cards.js), [sidecars/panel/ui-src/js/03-hardware-gpu.js](sidecars/panel/ui-src/js/03-hardware-gpu.js), [sidecars/panel/ui-src/js/04-sentinel-layout.js](sidecars/panel/ui-src/js/04-sentinel-layout.js), [router-state.json](router-state.json))**:
  - Added `panelViewMode` switching (`full` / `lite` + `liteQuickCard`), adaptive `panelUiScale`, native folder pickers (`/api/project-graph/pick-folder`, `/api/gpu/pick-folder`), and local chat abort (`/api/local-chat/abort`).
  - Implemented 1-click Ollama auto-installation (`startOllamaInstallJob`) with custom `gpuOllamaDir` and HuggingFace mirror support (`gpuPreferHfMirror`).
- **Interactive Project Map — Hybrid Architectural Layers ([sidecars/panel/ui-src/js/07-project-graph.js](sidecars/panel/ui-src/js/07-project-graph.js), [sidecars/panel/ui-src/styles.css](sidecars/panel/ui-src/styles.css), [tests/project-graph-panel.test.mjs](tests/project-graph-panel.test.mjs))**:
  - Hybrid layered layout with role columns, interactive filtering, draggable column headers, free node detaching/snapping back to layers, position reset, UI scale support, and custom project folder selection.
- **Split-Turn Model-Switch Handoff (AGY 2.35+) & End-to-End Progress Tracking ([core/hook-runner.mjs](core/hook-runner.mjs), [core/tool-pruner.mjs](core/tool-pruner.mjs), [rules/AGENTS.md](rules/AGENTS.md), [core/task-progress.mjs](core/task-progress.mjs), [core/progress/progress-parsers.mjs](core/progress/progress-parsers.mjs), [tests/model-switch-split-turn.test.mjs](tests/model-switch-split-turn.test.mjs))**:
  - Support for pausing/ending a turn to unlock the model selector in AGY 2.35+, end-to-end scanning of Swarm/subagents and background tasks, and clean labeling of non-workspace chats ("No project" / "Без проекта").
- **Release Hygiene & Metadata Sync ([install.js](install.js), [scripts/pack-release.mjs](scripts/pack-release.mjs), [scripts/bump-version.mjs](scripts/bump-version.mjs), [skills/github-publish-guard/scripts/audit-github-publish.mjs](skills/github-publish-guard/scripts/audit-github-publish.mjs), [README.md](README.md))**:
  - Validated `gpuOllamaDir` in the GitHub pre-publisher and installer, synced fallback versions in `core/plugin-updater.mjs`, and updated project counts (`56`/`64` core modules, `40` test suites).

---

## [3.33.1] — 2026-11-24

### Added & Fixed (`github-publish-guard` Skill & Project Map Improvements)
- **GitHub Publish Protection Skill ([skills/github-publish-guard/SKILL.md](skills/github-publish-guard/SKILL.md), [scripts/audit-github-publish.mjs](skills/github-publish-guard/scripts/audit-github-publish.mjs), [tests/github-publish-guard.test.mjs](tests/github-publish-guard.test.mjs))**:
  - Zero-dependency pre-publish auditor (`npm run audit:github`) before pushing to GitHub: detects machine fingerprints and absolute user paths (`C:\Users\<user>`, `/Users/<user>`, `/home/<user>`), local hosts/LAN IPs, secrets/tokens, and dirty template `router-state.json` files.
  - Enforces GitHub policy rules (`50/100 MB` file limits, no tracked `.env`, keys, caches, or OS junk, presence of `LICENSE` / `.gitignore` / `README.md`) and metadata accuracy (version parity across `package.json`, `plugin.json`, `README.md`, `CHANGELOG.md`, `assets/banner.svg`, valid relative Markdown links, accurate counts, and optional `--remote` check against `origin` and GitHub Releases).
  - Added bilingual titles/tooltips in the panel catalog ([sidecars/panel/lib/panel-state-skills.mjs](sidecars/panel/lib/panel-state-skills.mjs)) and `install.js` registration; all `13` skills score `100/100 (Grade A)` in `npm run lint:skills`.
- **Interactive Project Map — Workspace Switcher & Launch Fixes ([sidecars/panel/server.mjs](sidecars/panel/server.mjs), [sidecars/panel/lib/panel-telemetry-collectors.mjs](sidecars/panel/lib/panel-telemetry-collectors.mjs), [sidecars/panel/ui-src/js/07-project-graph.js](sidecars/panel/ui-src/js/07-project-graph.js), [tests/project-graph-panel.test.mjs](tests/project-graph-panel.test.mjs))**:
  - Added `/api/project-graph/workspaces` route and `discoverUserProjectsForGraph` to switch workspaces directly inside the Project Map.
  - Fixed standalone `--app` cold start on Windows (removed `windowsHide: true` that hid the first window) and resolved collapsed left sidebar state on first open.

---

## [3.33.0] — 2026-11-24

### Added (Interactive Project Map — Phases 1–3)
- **Graph Core & In-RAM MCP ([core/project-graph-builder.mjs](core/project-graph-builder.mjs), [core/ram-memory-mcp.mjs](core/ram-memory-mcp.mjs))**:
  - Dependency graph builder with iterative Tarjan SCC cycle detection (`detectImportCyclesTarjan`), isolated orphan detection (`detectOrphanFiles`), test impact map (`testFilesByTarget`), token budget estimation (`estimateNodeTokens`), file AST symbol graph (`buildFileSymbolGraphPayload`), git churn parser (`parseGitChurnOutput`), and semantic hit aggregation (`aggregateSemanticGraphHits`).
  - Added 4 IPC routes to the RAM daemon: `/graph/project-map`, `/graph/path`, `/graph/symbols`, and `/graph/semantic-search`.
- **Panel Backend & Standalone Window ([sidecars/panel/server.mjs](sidecars/panel/server.mjs))**:
  - Added 7 API routes: `/api/project-graph`, `/api/project-graph/path`, `/api/project-graph/git-diff`, `/api/project-graph/symbols`, `/api/project-graph/git-churn`, `/api/project-graph/semantic-search`, and `/api/project-graph/open-window`, plus standalone `?view=graph` window mode.
- **Interactive Project Map UI ([sidecars/panel/ui-src/js/07-project-graph.js](sidecars/panel/ui-src/js/07-project-graph.js), [07b-project-graph-lenses.js](sidecars/panel/ui-src/js/07b-project-graph-lenses.js), [07c-project-graph-visuals.js](sidecars/panel/ui-src/js/07c-project-graph-visuals.js), [07d-project-graph-spatial.js](sidecars/panel/ui-src/js/07d-project-graph-spatial.js), [head-body.html](sidecars/panel/ui-src/head-body.html), [styles.css](sidecars/panel/ui-src/styles.css), [00-i18n.js](sidecars/panel/ui-src/js/00-i18n.js), [sidecars/panel/ui.html](sidecars/panel/ui.html))**:
  - `07-project-graph.js`: Folders / Files / Symbols detail levels, Layers (Sugiyama) and Cloud (Force) layouts, Global / Local (1–3 hops) modes, cluster Convex Hulls, folder drill-down, split inspector (Blast / Imports / Overview / Files), edge-aware adaptive tooltips, dark/light theme sync, and live `EN / RU` translation.
  - `07b-project-graph-lenses.js`: 5 engineering lenses (Architecture, Blast & Diff with 1–3 hop wave and live `git diff`, Cycles Tarjan SCC + orphans, Hotspots churn × coupling, Path A→B via `Shift+click`) and Context Cart with token counting and `@file:` dispatch to Smart Composer.
  - `07c-project-graph-visuals.js`: subsystem Edge Bundling, interactive minimap, AST symbol graph, local GPU semantic search (`Ollama` / lexical fallback), and Mermaid (`MMD`) / PNG export.
  - `07d-project-graph-spatial.js`: mega-scale support (5k–25k nodes) powered by Barnes-Hut `O(N log N)` spatial quadtree and zero-dependency WebGL2 Instanced Renderer (auto-enabled at `>=1200` nodes or manually).
- **Automated Tests & Docs ([tests/project-graph-panel.test.mjs](tests/project-graph-panel.test.mjs), [README.md](README.md))**:
  - Added 9 comprehensive tests covering build & CSP, API/IPC contracts, standalone `?view=graph` launch, lenses, AST symbols, git churn, GPU search, export, 5k-node Barnes-Hut/WebGL2 stress test, and E2E UX polish; updated project counts (`55`/`63` core modules, `37` test suites).

---

## [3.32.2] — 2026-11-23

### Fixed & Improved (Core, RAM/Graphify, Panel & Stress Auditor Audit)
- **In-RAM Memory & `RamMemoryEngine` Lifecycle**:
  - Fixed V8 heap leak in `RamMemoryEngine.evict()`: properly closes and nulls `fs.watch` (`ws.watcher`), timers, indexes (`files`, `tokenIndex`, `trigramIndex`, `fieldPostings`, `forwardDeps`, `reverseDeps`, `repoMapCache`, `speculativeSkeletonCache`, `arena`), and `memoizer.entries` (`~227–371 MB -> 12 MB` on mega-repos `fastapi`/`fiber`/`vite`) ([core/ram-memory-engine.mjs](core/ram-memory-engine.mjs)).
  - Disabled file watcher startup (`startWatcher: false`) for one-shot `/api/graph` requests and ensured guaranteed cleanup via `finally { tmpEngine.evict('all'); }` ([sidecars/panel/server.mjs](sidecars/panel/server.mjs)).
- **Polyglot Import Graph (Python + Go) & Docs Search**:
  - Implemented absolute Python import resolution (`pkg.sub.mod`), `go.mod` parsing, multi-line Go `import (...)` parsing, `*_test.go` matching, stale Go AST SQLite cache bypass, and downranking of translated `docs/<locale>/` files in `RamMemoryEngine.search()` ([core/ram/ram-index-helpers.mjs](core/ram/ram-index-helpers.mjs), [core/repo-mapper.mjs](core/repo-mapper.mjs), [core/cpu-ast-graph-compressor.mjs](core/cpu-ast-graph-compressor.mjs), [core/ram-memory-engine.mjs](core/ram-memory-engine.mjs)).
- **Control Panel, E2E & Release Packing**:
  - Captured pre-optimistic `_batchRollbackSnap` for `updateState()` rollback on HTTP 500, additive `skillModes` merging without resurrecting closed `panelCollapsedCards`/`panelOpenSpoilers`, safe DOM tooltip rendering without `innerHTML`, and bilingual tooltips in `applyHookProfileOverridesToUi()` ([sidecars/panel/ui-src/js/02-telemetry-cards.js](sidecars/panel/ui-src/js/02-telemetry-cards.js), [sidecars/panel/ui-src/js/01-workspace-wizard.js](sidecars/panel/ui-src/js/01-workspace-wizard.js)).
  - Fixed TOCTOU file creation in `/api/setup-recommendations/apply` (`wx` flag), added Windows Defender `EPERM` retry (`retryWinFsOp` up to `30` attempts) when packing `Setup.exe` ([scripts/pack-release.mjs](scripts/pack-release.mjs)), fixed theme race in CDP test ([tests/panel-browser-layout-cdp.test.mjs](tests/panel-browser-layout-cdp.test.mjs)), and isolated `TUNNEL_CACHE_DIR` for Test 21 ([tests/router-core.test.mjs](tests/router-core.test.mjs)).
- **Hooks, Session Metrics, Localization & `deep-stress-auditor`**:
  - Added workspace fallback `pickSessionEntry` for `conversationId === 'default'` ([core/completion-gates.mjs](core/completion-gates.mjs)), `PRE_EDIT_SNAPSHOT_FILE` persistence between `gpuPostEditCritic` and `completionGates`, and `leanMode`/`terseMode` plus `shortcut:` auto-scanner wiring in `PostToolUse` ([core/hook-runner.mjs](core/hook-runner.mjs)).
  - Eliminated `EN/RU` leaks in [core/shortcut-debt-ledger.mjs](core/shortcut-debt-ledger.mjs), [core/router-cli.mjs](core/router-cli.mjs), and [core/project-setup-recommender.mjs](core/project-setup-recommender.mjs); added `null`-argument guards (`T6`), `LOCAL_SKILL_MD_CACHE` caching, and synced `User-Agent` ([core/skill-registry-bridge.mjs](core/skill-registry-bridge.mjs)), invalid RegExp handling in [skills/skill-architect/scripts/eval-skill-benchmark.mjs](skills/skill-architect/scripts/eval-skill-benchmark.mjs), and false-positive filtering in [skills/deep-stress-auditor/](skills/deep-stress-auditor/scripts/lib/file-worker-tasks.mjs).

---

## [3.32.1] — 2026-11-23

### Fixed & Improved
- **Setup Wizard**:
  - Sending PC config to chat (`sendHardwareTunePrompt()` on Step 1) no longer closes the wizard early or skips Steps 2–4 ([03-hardware-gpu.js](sidecars/panel/ui-src/js/03-hardware-gpu.js)).
  - Step 4 resource summary (`.wiz-summary-v`) now wraps cleanly onto multiple lines without `...` truncation, and `.wiz-overlay` modal width is constrained for narrow viewports `<= 420px` ([styles.css](sidecars/panel/ui-src/styles.css)).
- **Panel Layout on Narrow Viewports (`420px`)**:
  - Fixed horizontal overflow of `.lg-card`, `.expert-spoiler`, `.smart-banner`, `.sunken-box`, `.control-row`, and `.sentinel-status-box` (`min-width: 0; max-width: 100%; flex-wrap: wrap` in [styles.css](sidecars/panel/ui-src/styles.css)).
  - Added automated right-overflow regression check (`offendingBoxes`) in [tests/panel-browser-layout-cdp.test.mjs](tests/panel-browser-layout-cdp.test.mjs).
- **State Reliability & Hook Profiles**:
  - Serialized `updateState(patch, opts)` requests through a patch-merging queue (`mergeStatePatches` / `flushPendingStateUpdates`), eliminating races and cancellations on rapid clicks ([02-telemetry-cards.js](sidecars/panel/ui-src/js/02-telemetry-cards.js)).
  - `applyHookProfileOverridesToUi(profile, stateObj)` properly restores checkbox states and the active `#hookProfileGroup` button when switching back from `strict` to `standard`.
- **Full Live `RU ↔ EN` Synchronization**:
  - Removed hardcoded `active` class from the `EN` button in [head-body.html](sidecars/panel/ui-src/head-body.html), eliminating startup `EN` flicker when running in Russian.
  - Added caching and forced re-rendering of all collapsed, deferred, and diagnostic widgets (`flushAllRendersForLanguageChange()` for `AgentShield`, `GATES.md`, `Setup Doctor`, `Graphify v2`, `Shortcut Debt`, `Instincts`, `Episodes` in [02-telemetry-cards.js](sidecars/panel/ui-src/js/02-telemetry-cards.js) and [00-i18n.js](sidecars/panel/ui-src/js/00-i18n.js)) and cached Smart Composer quick chips `_smartChipsLastList` ([06-smart-composer.js](sidecars/panel/ui-src/js/06-smart-composer.js)).
  - Fixed `"Idle (waiting)"` leak in Background Sentinel ([panel-sentinel-adapter.mjs](sidecars/panel/lib/panel-sentinel-adapter.mjs)) and added bilingual `statusTextRu` / `statusTextEn` localization during GPU model cascade loading ([core/gpu/gpu-vram-runtime.mjs](core/gpu/gpu-vram-runtime.mjs), [sidecars/panel/server.mjs](sidecars/panel/server.mjs), [03-hardware-gpu.js](sidecars/panel/ui-src/js/03-hardware-gpu.js)).
  - Rebuilt [sidecars/panel/ui.html](sidecars/panel/ui.html).

---

## [3.32.0] — 2026-11-23

### Added & Adapted (Full 7-Layer `EN / RU` Bilingual Support)
- **Shared Localization Module [core/i18n.mjs](core/i18n.mjs)**: unified `normalizeLang`, `detectOsLocale`, `resolveStateLanguage`, `pickLang`, `detectTextLanguage`, and `readActiveUiLanguage` helpers for core, CLI, and installers.
- **Control Panel (`sidecars/panel/`) & Backend**:
  - Eliminated all Cyrillic leaks in `EN` mode across all 7 frontend modules ([00-i18n.js](sidecars/panel/ui-src/js/00-i18n.js) … [06-smart-composer.js](sidecars/panel/ui-src/js/06-smart-composer.js)) and rebuilt [sidecars/panel/ui.html](sidecars/panel/ui.html).
  - Bilingual output in [sidecars/panel/server.mjs](sidecars/panel/server.mjs), [sidecars/panel/lib/](sidecars/panel/lib/panel-telemetry-collectors.mjs), [core/task-progress.mjs](core/task-progress.mjs), [core/progress/progress-parsers.mjs](core/progress/progress-parsers.mjs), [core/hardware-profiler.mjs](core/hardware-profiler.mjs), and [core/project-setup-recommender.mjs](core/project-setup-recommender.mjs).
- **AI Hooks, Rules & Core Auditors**:
  - Dynamic adaptation to `uiLanguage` (`en` / `ru`) in [rules/AGENTS.md](rules/AGENTS.md), [core/hook-runner.mjs](core/hook-runner.mjs), [core/model-profile.mjs](core/model-profile.mjs), [core/tool-pruner.mjs](core/tool-pruner.mjs), [core/completion-gates.mjs](core/completion-gates.mjs), [core/bayesian-router.mjs](core/bayesian-router.mjs), [core/quota-pacer.mjs](core/quota-pacer.mjs), [core/cpu-worker-pool.mjs](core/cpu-worker-pool.mjs), [core/history-compactor.mjs](core/history-compactor.mjs), [core/agent-shield.mjs](core/agent-shield.mjs), [core/background-sentinel.mjs](core/background-sentinel.mjs), [core/runtime-wiretap.mjs](core/runtime-wiretap.mjs), [core/shadow-guard.mjs](core/shadow-guard.mjs), [core/shadow-worktree.mjs](core/shadow-worktree.mjs), [core/skill-registry-bridge.mjs](core/skill-registry-bridge.mjs), [core/friction-observer.mjs](core/friction-observer.mjs), [core/circuit-breaker.mjs](core/circuit-breaker.mjs), and [core/cpu-mutation-guard.mjs](core/cpu-mutation-guard.mjs) while preserving `*Ru`/`*En` contracts.
- **Local GPU Engine, Floating HUD & Skills**:
  - Localized [core/floating-hud.mjs](core/floating-hud.mjs), [core/gpu/gpu-critic-chat.mjs](core/gpu/gpu-critic-chat.mjs), [core/gpu/gpu-vram-runtime.mjs](core/gpu/gpu-vram-runtime.mjs), [core/gpu/gpu-distill.mjs](core/gpu/gpu-distill.mjs), [core/gpu/gpu-vector-skills.mjs](core/gpu/gpu-vector-skills.mjs), and [core/gpu/gpu-composer-copilot.mjs](core/gpu/gpu-composer-copilot.mjs).
  - Added `--lang=en|ru` / `readActiveUiLanguage()` support in [skills/ui-ux-design-system/scripts/build-showroom.mjs](skills/ui-ux-design-system/scripts/build-showroom.mjs), [skills/ui-ux-design-system/scripts/fetch-web-refs.mjs](skills/ui-ux-design-system/scripts/fetch-web-refs.mjs), [skills/delta-bug-minimizer/scripts/ddmin-runner.mjs](skills/delta-bug-minimizer/scripts/ddmin-runner.mjs), and [skills/ui-ux-design-system/SKILL.md](skills/ui-ux-design-system/SKILL.md).
- **Manifests, Installers, CLI & Tests**:
  - Pure English manifests [plugin.json](plugin.json), [sidecars/panel/sidecar.json](sidecars/panel/sidecar.json), and [package.json](package.json); expanded `EN + RU` version sync rules in [scripts/bump-version.mjs](scripts/bump-version.mjs).
  - OS locale auto-detection (`ru` / `en`, `--lang=en|ru` flags, `TUNNEL_LANG` env var) in [install.js](install.js), [install.sh](install.sh), [core/router-cli.mjs](core/router-cli.mjs), and WinForms C# 5.0 `Setup.exe` ([scripts/pack-release.mjs](scripts/pack-release.mjs)), plus English `uninstall.bat` alongside `Удалить плагин.bat` in the release bundle.
  - Expanded regression suite [tests/i18n-language.test.mjs](tests/i18n-language.test.mjs) (8 tests verifying zero Cyrillic in manifests, core modules in `EN` mode, and static `ui.html` DOM).

---

## [3.31.0] — 2026-11-23

### Added
- **Wave 1 — Minimal Diff Discipline (`Lean / Terse`), Shortcut Debt Ledger & Fresh-Test Gate**:
  - New settings `leanMode` (`off | lite | full | ultra`) and `terseMode` (`off | caveman | ultracave`) in [router-state.json](router-state.json), [sidecars/panel/lib/panel-state-skills.mjs](sidecars/panel/lib/panel-state-skills.mjs), [core/tool-pruner.mjs](core/tool-pruner.mjs), [core/hook-runner.mjs](core/hook-runner.mjs), and the control panel ([sidecars/panel/ui-src/head-body.html](sidecars/panel/ui-src/head-body.html), [sidecars/panel/ui-src/js/00-i18n.js](sidecars/panel/ui-src/js/00-i18n.js), [sidecars/panel/ui-src/js/01-workspace-wizard.js](sidecars/panel/ui-src/js/01-workspace-wizard.js), [sidecars/panel/ui-src/js/04-sentinel-layout.js](sidecars/panel/ui-src/js/04-sentinel-layout.js)).
  - New module [core/shortcut-debt-ledger.mjs](core/shortcut-debt-ledger.mjs) (`scanShortcutDebt`, `extractFileShortcutMarkers`, `parseShortcutCommentBody`) to collect deliberate `// shortcut:` / `// ponytail:` markers and flag `no-trigger` debt without upgrade conditions, plus `debt` CLI subcommand in [core/router-cli.mjs](core/router-cli.mjs) and `/api/debt` route in [sidecars/panel/server.mjs](sidecars/panel/server.mjs).
  - Added diff reuse metrics (`computeDiffReuseMetrics`, `recordSessionReuseMetrics`, `getSessionReuseSummary`) and test freshness gate (`isVerificationTestCommand`, `recordSessionCodeEdit`, `recordSessionTestExecution`, `getSessionVerificationFreshness`) in [core/completion-gates.mjs](core/completion-gates.mjs); updated [agents/router-verifier.md](agents/router-verifier.md) and [GATES.md](GATES.md).
- **Wave 2 — Graphify v2 (Edge Confidence, `topologyHash`, Bridges & `dynamic_import`)**:
  - Added `EXTRACTED / INFERRED / AMBIGUOUS` edge confidence tags, deterministic `computeGraphTopologyHash`, `findSurprisingConnections`, `suggestArchitectureQuestions`, and `dynamic_import`/`re_exports` traversal in `queryAffectedBlastGraph` ([core/cpu-ast-graph-compressor.mjs](core/cpu-ast-graph-compressor.mjs), [core/ram-memory-engine.mjs](core/ram-memory-engine.mjs)).
  - Added `/api/graph` route and interactive "Graph Map / Tech Debt" drawer in [sidecars/panel/ui-src/js/02-telemetry-cards.js](sidecars/panel/ui-src/js/02-telemetry-cards.js).
- **Wave 3 — OmniRoute Guardrails & RTK v2 Profiles**:
  - Idle tool-round stall protection (`recordAndCheckStalledToolRound`, `resetToolRoundHistory`) in [core/circuit-breaker.mjs](core/circuit-breaker.mjs).
  - Added stateless effort selection (`resolveStatelessTurnEffort`), cache warmth auditing (`computeCacheWarmthStatus`), and score-driven failover target selection (`resolveScoreDrivenComboTarget`) in [core/quota-pacer.mjs](core/quota-pacer.mjs).
  - Added `compressRtkCommandOutput` compression profiles (`git status`, test runner summaries) in [core/obs-masker.mjs](core/obs-masker.mjs).
- **Wave 4 — `agentskills.io` Linter, A/B Evals, Caveman Blocks & OpenSpec**:
  - `agentskills.io` spec and Negative Transfer linting in [skills/skill-architect/scripts/audit-skill.mjs](skills/skill-architect/scripts/audit-skill.mjs).
  - Deterministic skill A/B evaluator [skills/skill-architect/scripts/eval-skill-benchmark.mjs](skills/skill-architect/scripts/eval-skill-benchmark.mjs) and `eval-skill` subcommand in [core/router-cli.mjs](core/router-cli.mjs).
  - New module [core/reusable-blocks-specs.mjs](core/reusable-blocks-specs.mjs) for caching diagnostic micro-scripts (`saveReusableBlock`, `listReusableBlocks`) and bounded OpenSpec delta specs up to `50 KB` (`upsertOpenSpecDelta`, `readOpenSpecDelta`, `listOpenSpecDeltas`, `formatActiveSpecsForHandoff` in [core/session-handoff.mjs](core/session-handoff.mjs)), plus `spec` and `blocks` CLI commands.
  - Added test suite [tests/v331-sota-4waves.test.mjs](tests/v331-sota-4waves.test.mjs) (`36` total test suites).

### Fixed & Updated
- Added `isActivePluginInstallDir` in [core/hardware-profiler.mjs](core/hardware-profiler.mjs) to calibrate `mcp_config.json` on direct `git clone` into the plugins folder ([tests/router-core.test.mjs](tests/router-core.test.mjs)).
- Scoped Ollama offline backoff per origin endpoint (`ollamaOfflineEndpoint`) in [core/gpu/gpu-shared-state.mjs](core/gpu/gpu-shared-state.mjs) and [core/gpu/gpu-vram-runtime.mjs](core/gpu/gpu-vram-runtime.mjs).
- Converted paths via `pathToFileURL` in [skills/programmatic-video-studio/scripts/lint-video-composition.mjs](skills/programmatic-video-studio/scripts/lint-video-composition.mjs) and [skills/ui-ux-design-system/scripts/build-showroom.mjs](skills/ui-ux-design-system/scripts/build-showroom.mjs).
- Updated section numbering and counts (`53`/`61` core modules, `59` guardrails in UI & docs instead of `25+`, `36` test suites), rebuilt [sidecars/panel/ui.html](sidecars/panel/ui.html), and updated [LICENSE](LICENSE).

---

## [3.30.0] — 2026-11-23

### Added
- **Full Bilingual UI, Hooks & Rules (`EN` / `RU`)**:
  - `uiLanguage` setting (`en` / `ru`, defaulting to `en` for clean installs and releases while preserving user choice in [install.js](install.js) and [scripts/pack-release.mjs](scripts/pack-release.mjs); validated in [sidecars/panel/lib/panel-state-skills.mjs](sidecars/panel/lib/panel-state-skills.mjs)).
  - Zero-dependency live panel translation engine [sidecars/panel/ui-src/js/00-i18n.js](sidecars/panel/ui-src/js/00-i18n.js) and synchronous [sidecars/panel/ui.html](sidecars/panel/ui.html) build.
  - Dynamic adaptation of `SessionStart` headers (`EN-Chat` / `RU-Chat`) in [core/hook-runner.mjs](core/hook-runner.mjs), `Pre-Task Gate` hints in [core/tool-pruner.mjs](core/tool-pruner.mjs), and instructions in [rules/AGENTS.md](rules/AGENTS.md).
  - Localization test suite [tests/i18n-language.test.mjs](tests/i18n-language.test.mjs) and expanded dual-language version sync rules in [scripts/bump-version.mjs](scripts/bump-version.mjs).

---

## [3.29.0] — 2026-11-22

### Added
- **Project Stack Diagnostics & External Skill Registry Bridge**:
  - Stack analyzer and automation recommender [core/project-setup-recommender.mjs](core/project-setup-recommender.mjs) (built on `stack-detector.mjs`) with `/api/setup-recommendations` route in [sidecars/panel/server.mjs](sidecars/panel/server.mjs).
  - Safe external skill search & quarantine import bridge [core/skill-registry-bridge.mjs](core/skill-registry-bridge.mjs) with `AgentShield` scanning, `audit-skill.mjs` linting, binary file blocking, and `.user-skill.json` preservation across upgrades in [install.js](install.js).
- **Provider Failover, Design Extractor & Dogfooding**:
  - Failover chains and TTL cooldowns in [core/quota-pacer.mjs](core/quota-pacer.mjs) integrated with [core/swarm-controller.mjs](core/swarm-controller.mjs) directives.
  - Design token extraction to `DESIGN.md` ([skills/ui-ux-design-system/scripts/extract-design-md.mjs](skills/ui-ux-design-system/scripts/extract-design-md.mjs)), WCAG contrast & i18n overflow checks in [skills/ui-ux-design-system/scripts/audit-ui.mjs](skills/ui-ux-design-system/scripts/audit-ui.mjs), and interactive web auditor [skills/deep-stress-auditor/scripts/run-webapp-dogfood.mjs](skills/deep-stress-auditor/scripts/run-webapp-dogfood.mjs).
- **Mega-Repo Optimizations & Security**:
  - Accelerated `buildDocConfigReferenceGraph` and `RamMemoryEngine.getContextPack` ([tests/mega-repo-bottlenecks.test.mjs](tests/mega-repo-bottlenecks.test.mjs)), reduced polyglot auditor false positives, added UTF-16LE BOM `.agentignore` support in [core/security-guard.mjs](core/security-guard.mjs), and expanded leak detection in [core/agent-shield.mjs](core/agent-shield.mjs).

---

## [3.28.0] — 2026-11-21

### Added
- **Headroom CCR, 3-Layer Episodic Memory & Config Protection**:
  - Reversible terminal log compression and 3-layer episodic memory in [core/sqlite-knowledge-hub.mjs](core/sqlite-knowledge-hub.mjs) with `ram_ccr_retrieve` and `ram_memory_recall` tools in [core/ram-memory-mcp.mjs](core/ram-memory-mcp.mjs) and [mcp_config.json](mcp_config.json).
  - Offline MCP/hook/skill security auditor [core/agent-shield.mjs](core/agent-shield.mjs) and user-friction instinct detector [core/friction-observer.mjs](core/friction-observer.mjs) evolving into [core/skill-crystallizer.mjs](core/skill-crystallizer.mjs).
  - Acceptance gates `GATES.md`, added-stub scanner, and Stop-hook anti-loop guard in [core/completion-gates.mjs](core/completion-gates.mjs).
- **Ecosystem Integrations, UX Matrix & Video Studio**:
  - `ux-matrix.json` pattern query CLI [skills/ui-ux-design-system/scripts/query-ux-matrix.mjs](skills/ui-ux-design-system/scripts/query-ux-matrix.mjs), `react-vercel-rules.md`, and open media search [skills/ui-ux-design-system/scripts/fetch-open-media.mjs](skills/ui-ux-design-system/scripts/fetch-open-media.mjs).
  - `Grill-Me` directives and 3D options in [core/tool-pruner.mjs](core/tool-pruner.mjs), explicit thinking depth enforcement in [core/model-profile.mjs](core/model-profile.mjs) and [rules/AGENTS.md](rules/AGENTS.md).
  - Programmable video studio skill [skills/programmatic-video-studio/SKILL.md](skills/programmatic-video-studio/SKILL.md) (HyperFrames / Remotion linter and procedural WAV/SFX synthesis).
  - Browser CDP panel layout E2E tests ([tests/panel-browser-layout-cdp.test.mjs](tests/panel-browser-layout-cdp.test.mjs)) and subprocess/install contract tests ([tests/v328-wave1-wave2.test.mjs](tests/v328-wave1-wave2.test.mjs), [tests/v328-ecosystem-integrations.test.mjs](tests/v328-ecosystem-integrations.test.mjs)).

---

## [3.27.0] — 2026-11-20

### Added
- **Smart Composer 2.0 (`@` Chips, Local Vision & Voice) in [sidecars/panel/server.mjs](sidecars/panel/server.mjs), [sidecars/panel/ui.html](sidecars/panel/ui.html) & [core/local-gpu-engine.mjs](core/local-gpu-engine.mjs)**:
  - Fast `@` context menu (`/api/composer/at-suggest`, `<10 ms`): `@file:`, `@symbol:`, `@git:diff`, `@git:staged`, `@error:last`, `@repo:`.
  - UI screenshot pasting (`Ctrl+V` / drag-and-drop, `<=4 MB` limit) and local visual audit via `analyzeUiScreenshotLocally` (Gemma 4 `/api/chat` with `images`, `/api/composer/vision`, **0% cloud tokens**).
  - Optional Web Speech API dictation (`#chk-composerVoiceEnabled`, `structureVoiceTranscriptLocally`, `/api/composer/voice-structure`).
- **Cloud-Free Pre-Commit (`✓ Commit · 0 tok`) in [core/background-sentinel.mjs](core/background-sentinel.mjs)**:
  - `prepare_commit` combines Shadow Guard (AST/imports/LSP), diff secret-leak scan, Local BugBot cache/audit, and Conventional Commit message generation (`generateLocalCommitSummary` with offline fallback).
- **Isolated CPU Semantic Mutation Guard (`core/cpu-mutation-guard.mjs`)**:
  - Verifies test suite strength against 1-point boundary mutants in a temporary OS copy without touching project sources (`runSemanticMutationGuard`, optional `#chk-mutationGuardEnabled` toggle, and lazy `mutation_guard_check` MCP tool in [mcp_config.json](mcp_config.json)).

---

## [3.26.0] — 2026-11-20

### Added
- **Live Error Wiretap & Automated `git bisect` (`core/runtime-wiretap.mjs`)**:
  - `node core/ag-cli.mjs watch <cmd...>` streams process output and captures crashes into `.cache/runtime-wiretap.json` (SimHash64 deduplication, log/secret redaction, `±6`-line local stack frame extraction).
  - Lazy MCP tool `git_bisect_auto` (`"eager": false` in [mcp_config.json](mcp_config.json)) for automated binary regression commit search in a temporary `git worktree` without modifying the working tree.
  - Interactive `#wiretapAlertBar` crash banner in Smart Composer plus `/api/wiretap/fault`, `/api/wiretap/faults`, and `/api/wiretap/clear` routes.
- **Quota Predictor & Prefix Stability Audit (`core/quota-pacer.mjs`)**:
  - 30/60-minute rolling quota window (`Hydrogen / Orchestrator / Neon / Carbon`, `Pro` / `Ultra` limits) plus `#quotaPacerBadge` and Gemini 4 static prefix immutability audit (`>=4096` tokens).

---

## [3.25.0] — 2026-11-20

### Added
- **Turn-Level Time-Machine in [core/shadow-guard.mjs](core/shadow-guard.mjs) & [core/hook-runner.mjs](core/hook-runner.mjs)**:
  - Binds all `edit_file` / `write_file` snapshots to `turnId` and the user's turn label.
  - Implemented `listTurnCheckpoints`, `getTurnDiffSummary`, and atomic `rollbackTurn` restoring the earliest pre-turn state of every modified file and removing newly created files from that turn.
- **Isolated Git Sandbox (`core/shadow-worktree.mjs`)**:
  - Works inside a single detached `git worktree` (`.cache/worktrees/wt_*`) without touching the main working tree: `createShadowWorktree`, `runInShadowWorktree`, `getShadowWorktreeDiff`, `promoteShadowWorktree` (with mandatory shadow checkpoint), and `discardShadowWorktree`.
  - Added `By Turns / By Files` switch, `↶ Rollback Turn` button, `/api/checkpoints/turns`, `/api/checkpoints/rollback-turn`, `/api/worktree/action`, and `#chk-shadowWorktreeEnabled` toggle in the panel.

---

## [3.24.0] — 2026-11-20

### Added
- **NVMe Knowledge Hub on `node:sqlite` (`core/sqlite-knowledge-hub.mjs`)**:
  - Persistent storage for `RepairKV` buckets and SHA-1 AST metadata in WAL database `.cache/tunnel-knowledge.sqlite` for instant cold starts after reboot (without duplicating the `i8bin-v2` binary index).
  - **Victory Recipes (`victory_recipes`)**: automatically records successful test fixes in [core/hook-runner.mjs](core/hook-runner.mjs) and injects `🏆 [Victory Recipe]` hints in `PreInvocation`.
  - **Cross-Project Federation (`repo_federation`)**: links companion repositories (`includeFederated` in `ram_search`) with management UI in the panel ([sidecars/panel/ui.html](sidecars/panel/ui.html), `/api/knowledge/recipes`, `/api/knowledge/federation`).

---

## [3.23.0] — 2026-11-20

### Added
- **Live LSP Bridge (`core/lsp-bridge.mjs`)**:
  - Zero-dependency `Content-Length` JSON-RPC 2.0 multiplexer over `stdio` for `typescript-language-server`, `pyright-langserver`/`pylsp`, `gopls`, and `rust-analyzer` with idle auto-unload.
  - Integrated instant type checking into `/hook/post-edit` and `PostToolUse` (`🧬 [LSP Type Check]`), background diagnostics collection in [core/background-sentinel.mjs](core/background-sentinel.mjs), three lazy MCP tools (`lsp_diagnostics`, `lsp_references`, `lsp_code_actions` in [core/ram-memory-mcp.mjs](core/ram-memory-mcp.mjs) and [mcp_config.json](mcp_config.json)), and `#chk-lspBridgeEnabled` toggle in the panel.

---

## [3.22.0] — 2026-11-18

### Added
- **CPU SOTA Suite (Zero VRAM)**:
  - Implemented 2..3-hop `Personalized PageRank` (`computeBipartiteSymbolPPR`), `Git Co-Change` evolutionary coupling, export arity & key checks, 64-bit AST `SimHash` clone radar, `SBFL Ochiai` defect localization over `NODE_V8_COVERAGE`, `Bitap` fuzzy patch recovery, and fact-table extraction in [core/cpu-graph-contracts.mjs](core/cpu-graph-contracts.mjs) and [core/cpu-sbfl-healer.mjs](core/cpu-sbfl-healer.mjs); integrated with [core/auto-verifier.mjs](core/auto-verifier.mjs), [core/diff-patcher.mjs](core/diff-patcher.mjs), and `chk-cpuSotaEngines`.
- **Zero-Copy `SharedArrayBuffer` RAM Arena, `CSR` Index & `Prefetch`**:
  - Created [core/ram-sota-arena.mjs](core/ram-sota-arena.mjs) (`SharedRamArena`, flat `Uint32Array`-backed `CsrInvertedIndex`, `orderSlicesPrefixStable` for prefix cache stability).
  - Integrated zero-copy buffer passing to the worker pool (`zeroCopyTasks`), speculative 1-hop dependent AST skeleton prefetch after edits (`scheduleSpeculativePrefetch`), and lazy `CSR` indexing in [core/cpu-worker-pool.mjs](core/cpu-worker-pool.mjs) and [core/ram-memory-engine.mjs](core/ram-memory-engine.mjs).
- **Cross-Step *ACON* Memoization & Post-Compaction *RepairKV* Memory**:
  - Added `/hook/memo-check`, `/hook/memo-record`, and `/hook/compaction-archive` routes in [core/ram-sota-arena.mjs](core/ram-sota-arena.mjs), [core/ram-memory-mcp.mjs](core/ram-memory-mcp.mjs), [core/hook-runner.mjs](core/hook-runner.mjs), and [core/history-compactor.mjs](core/history-compactor.mjs) to intercept unchanged long `run_command` outputs with loop protection and restore forgotten facts in `PreInvocation`.
- **GPU ↔ DDR5 RAM Synergy, `OLLAMA_NUM_PARALLEL=1` & Hardware Ceilings**:
  - Added `OLLAMA_NUM_PARALLEL=1` in [core/local-gpu-engine.mjs](core/local-gpu-engine.mjs) (saving 1.5–3 GB VRAM on KV-cache slots), persistent LRU/SimHash cache for `gpu_distill` and `Post-Edit Critic` (`.cache/gpu-distill-cache.json`), and background GGUF weight warming in host DDR5 (`warmGgufModelsInHostRam`).
  - Added dynamic hardware ceilings (`computeHardwareCeilings`) scaling up to `16–24 GB RAM` and `24` CPU threads on 64 GB / 32-thread workstations, `#chk-ramSotaEngines` and `#chk-gpuWarmHostRamCache` toggles, and SOTA RAM savings accounting in [core/hardware-profiler.mjs](core/hardware-profiler.mjs), [install.js](install.js), [sidecars/panel/server.mjs](sidecars/panel/server.mjs), and [sidecars/panel/ui.html](sidecars/panel/ui.html).

---

## [3.21.0] — 2026-11-17

### Added
- **`Frozen Prefix` Shield & Gemini 4 Prefix Quantization (`4096-Token Floor Snap`)**:
  - Removed volatile `Updated:` timestamps from the `SessionStart` prefix in [core/session-handoff.mjs](core/session-handoff.mjs), added word-boundary-safe `truncateCleanly` with balanced brackets and POSIX path normalization; added small-repo padding above 4096 tokens in [core/hook-runner.mjs](core/hook-runner.mjs) (`buildCacheAlignedInjection`) and pre-edit snapshot buffer `.cache/pre-edit-last.json` for accurate `Post-Edit Critic` diffs.
- **Cascading `Post-Edit Critic` & `UTF-16LE/BE` Support in `gpu_distill`**:
  - Added `decodeTextBufferAutoUtf` in [core/local-gpu-engine.mjs](core/local-gpu-engine.mjs) (transparent `UTF-16LE`/`UTF-16BE` PowerShell log decoding with/without BOM while keeping binary guards), fixed cascading fallback to `qwen3:4b` on VRAM pressure (`ollamaTagsCache`), and added enclosing scope header injection.
- **In-RAM `2-Hop Contracts`, `SWE-Pruner` Skimmer, `Cross-Layer Seams` & `AST-Delta`**:
  - Implemented `getTwoHopContractStrip` (embedded in `getContextPack`), `skimCodeBlocksByQuery`, `findCrossLayerSeams`, compact `120|` line format (`compactLines`), and `foldBoilerplateHead` in [core/ram-memory-engine.mjs](core/ram-memory-engine.mjs); added `astSymbolSummary` in [core/cpu-delta-reread.mjs](core/cpu-delta-reread.mjs).
- **`RTK v2` Terminal Filter + `Zero-Turn Fault Pinning`**:
  - Added `\r` progress-spinner and `UTF-16` null stripping, system stack-frame folding (`[... N internal frames folded]`), and linear $O(N)$ `extractTopFaultCodePin` (`📌 [Fault Pin ...]`) in [core/obs-masker.mjs](core/obs-masker.mjs).
- **`TOON v2` Serialization, `Fuzzy-AST` Patcher & `AgentDiet`**:
  - Added `canonicalizeJson`, `toPosixRelPath`, and `flattenNestedConfigToDotPaths` in [core/toon-formatter.mjs](core/toon-formatter.mjs) and [core/ram-memory-mcp.mjs](core/ram-memory-mcp.mjs).
  - Added `Fuzzy Indentation & Trailing-Whitespace Snap` with adaptive indent-step scaling in [core/diff-patcher.mjs](core/diff-patcher.mjs); added `analyzeAgentDietTrajectoryWaste` in [core/history-compactor.mjs](core/history-compactor.mjs).
- **Cognitive Autopilot: `Chain-of-Draft`, `FailFast-RestartSmart`, `ReasoningBank` & `CoDyn Bayesian Router`**:
  - Added `buildAdaptiveReasoningDirective`, native artifact-approval detection (`The user has approved this document.`), and Russian-to-DOM/settings entity anchoring (`anchoredEntities`) in [core/tool-pruner.mjs](core/tool-pruner.mjs).
  - Added `detectSemanticOscillation` and 5-line `buildCleanRestartOverlay` in [core/circuit-breaker.mjs](core/circuit-breaker.mjs); `firstPassRate` and `expectedTurnsEstimate` metrics in [core/bayesian-router.mjs](core/bayesian-router.mjs); `recordContrastiveLesson` in [core/pitfall-ledger.mjs](core/pitfall-ledger.mjs).
- **Token ROI Benchmark & Unified CLI `--output`**:
  - Created [scripts/benchmark-token-roi.mjs](scripts/benchmark-token-roi.mjs) (`npm run benchmark:roi`) and [tests/v321-sota.test.mjs](tests/v321-sota.test.mjs); added `--output`/`-o` (clean UTF-8) across 4 skill CLIs and `mcpSchemaTaxTokens` accounting in [sidecars/panel/server.mjs](sidecars/panel/server.mjs).

### Fixed
- **Auto-Clearing `Pitfall Ledger` for Suites & Redirects**: updated `resolveTestPitfallsFromCommand` in [core/hook-runner.mjs](core/hook-runner.mjs) to support diagnostic redirects (`2>&1`, `| obs-masker`) and partial clearing of passing test files in `tests/*.test.mjs` glob runs; purged 3 stale passing-test entries.
- **Auto-Syncing `--max-old-space-size` in Installed `mcp_config.json`**: updated `saveState` in [sidecars/panel/server.mjs](sidecars/panel/server.mjs) to synchronize V8 heap limits across both the working copy and installed plugin.

---

## [3.20.0] — 2026-11-17

### Added
- **Transparent `RTK-Shield` CLI Interceptor**:
  - Added `compressRtkCommandOutput` in [core/obs-masker.mjs](core/obs-masker.mjs) (collapses dozens of passing TAP/test-runner lines into `[✓ RTK-Test Summary: ...]` and compresses large `git diff` output while preserving file stats) and guards against unbounded `git log -p/--patch` or unfiltered lockfile reads in [core/security-guard.mjs](core/security-guard.mjs).
- **`Serena-Lite AST Ops` Symbol Navigation & Surgery**:
  - Added `callGraph: true` to `ram_slice` ([core/ram-memory-engine.mjs](core/ram-memory-engine.mjs), [core/ram-memory-mcp.mjs](core/ram-memory-mcp.mjs)) to extract full symbol bodies plus 1-hop callers and callees from `RepoGraph`.
  - Implemented `computeSymbolReplacement` and `applySymbolReplacement` in [core/diff-patcher.mjs](core/diff-patcher.mjs) for atomic AST-bounded symbol body replacement with in-memory syntax validation; wired `patch-symbol` into [core/ag-cli.mjs](core/ag-cli.mjs) and [core/router-cli.mjs](core/router-cli.mjs).
- **`SWE-Pruner` Phase-Aware Context Budgeting**:
  - Added `inferContextPruningPhase` (`explore | edit | debug`) in [core/ram-memory-engine.mjs](core/ram-memory-engine.mjs) and [core/ram-memory-mcp.mjs](core/ram-memory-mcp.mjs) to adapt `ram_context_pack` (AST skeleton while exploring, `Program Slicer` data-flow slices while debugging).
- **Tabular `TOON` Serialization (`-35..60%` Tokens)**:
  - Created [core/toon-formatter.mjs](core/toon-formatter.mjs) (`encodeToonTable`, `crushJsonArrayToToon`, `formatRepoMapToon`) with `format: 'toon'` in [core/cpu-log-json-compressor.mjs](core/cpu-log-json-compressor.mjs) and `toon: true` in `getFastRepoMap` / `ram_context_pack`.
- **Bilingual `RU-EN` Lexicon (260+ IT Roots) & `Voice/RU Prompt Pivot`**:
  - Created [core/ru-en-lexicon.mjs](core/ru-en-lexicon.mjs) (`O(1)` prefix index without VRAM), integrated into [core/cpu-reranker.mjs](core/cpu-reranker.mjs) and [core/ram-memory-engine.mjs](core/ram-memory-engine.mjs) (`search`).
  - Added `compileVoiceOrLongRuPromptPivot` in [core/tool-pruner.mjs](core/tool-pruner.mjs) and [core/hook-runner.mjs](core/hook-runner.mjs) to compress verbose conversational/voice Russian prompts into concise English briefs.
- **Post-Edit Diff Reviewer (`Post-Edit Critic`)**:
  - Added ultra-fast CPU undeclared-identifier detector (`scanAddedIdentifiersForRefBugs`) and optional local GPU `gemma4:12b` diff review (`critiqueEditedDiffLocally`) in [core/local-gpu-engine.mjs](core/local-gpu-engine.mjs), [core/hook-runner.mjs](core/hook-runner.mjs), and `gpuPostEditCritic` setting.
- **Prefix Cache Shield & 4-Part Token Savings Counter in Panel**:
  - Added token savings breakdown (`⚡ Cache`, `🧠 RAM`, `⚙️ CPU`, `🎮 GPU`), Implicit Cache hit badge (`Cache: X%`), and `chk-gpuPostEditCritic` toggle in [sidecars/panel/server.mjs](sidecars/panel/server.mjs) and [sidecars/panel/ui.html](sidecars/panel/ui.html); added `\n` normalization in `buildCacheAlignedInjection` ([core/hook-runner.mjs](core/hook-runner.mjs)).

### Fixed
- **Auto-Clearing `Pitfall Ledger` on Passing Tests**: fixed `TEST_OUTPUT_FAIL_RE` false positives on passing `✔` lines containing `AssertionError` or `×`, and ensured test failure entries tied to implementation files are cleared in [core/hook-runner.mjs](core/hook-runner.mjs) (`resolveTestPitfallsFromCommand`).

---

## [3.19.0] — 2026-11-17

### Added
- **Optical Live CPU Pool Telemetry & Unified Resource Limits**:
  - Added inter-process `cpu-live-activity.json` tracker (`beginCpuLiveWork`, `endCpuLiveWork`, `recordCpuInstantWork`, `getCpuLiveActivity`) with `2.8 s` afterglow in [core/cpu-worker-pool.mjs](core/cpu-worker-pool.mjs), wired into parallel verification ([core/auto-verifier.mjs](core/auto-verifier.mjs)), reranker ([core/cpu-reranker.mjs](core/cpu-reranker.mjs)), and `ddmin` minimizer ([skills/delta-bug-minimizer/scripts/ddmin-runner.mjs](skills/delta-bug-minimizer/scripts/ddmin-runner.mjs)).
  - Added `topCpuLivePill` header capsule and segmented `cpuLiveUnitCard` ("CPU Threads") for both themes (`glass_teal` and `studio_titanium`) in [sidecars/panel/ui.html](sidecars/panel/ui.html), and grouped `cpuMaxThreads` alongside In-RAM and VRAM limits.
- **Auto-Unload VRAM on Antigravity Exit (`gpuUnloadOnExit`)**:
  - Implemented automatic Ollama model unloading when the last active Antigravity process exits in [core/ram-memory-mcp.mjs](core/ram-memory-mcp.mjs) (`handleMcpDaemonExit`) and [sidecars/panel/server.mjs](sidecars/panel/server.mjs) (`handleSidecarExitCleanup`, `hasLiveRamDaemon`).
- **Persisting Collapsed Panel Cards & Spoilers**:
  - Added persistent `panelCollapsedCards` and `panelOpenSpoilers` maps validated via `sanitizeBooleanIdMap` in [sidecars/panel/server.mjs](sidecars/panel/server.mjs) and [router-state.json](router-state.json).
- **`--help` / `-h` Support for Skill CLI Scripts**:
  - Added standard `--help` output to `run-codemod.mjs`, `run-stress-audit.mjs`, `slice-variable.mjs`, `build-showroom.mjs`, and `fetch-web-refs.mjs`.

### Changed
- **Native `Swarm` Worker Lifecycle & `worktrees`**:
  - Added board-brief worker auto-detection (`recorded on the board as #N for @name`), `narrator` / `stall monitor` role matching, board system wakeups (`isBoardWakeup`), `worktrees/<parentCid>/<branch>` paths (`parseAntigravityWorktreePath`), proper `completed (100%)` transitions for `swarm_wait`/stopped workers, `[object Object]` protection in `matchedFiles`, `auto_all` / `always_ask` modes, and auto-tiering (`hydrogen_auto` / `argon_auto` / `carbon_auto`) across [core/model-profile.mjs](core/model-profile.mjs), [core/task-progress.mjs](core/task-progress.mjs), [core/swarm-controller.mjs](core/swarm-controller.mjs), and [core/hook-runner.mjs](core/hook-runner.mjs).
- **Adaptive Memory Limits up to 32 GB & Live Indexing**:
  - Raised In-RAM and VRAM context ceiling to `32 GB`, added `warmWorkspaceVectorsOnce` deduplication, `onFileUpsert` callback, and retry file locking on atomic `i8bin-v2` writes in [core/ram-memory-engine.mjs](core/ram-memory-engine.mjs), [core/ram-memory-mcp.mjs](core/ram-memory-mcp.mjs), and [core/local-gpu-engine.mjs](core/local-gpu-engine.mjs).
- **Analytical Modal Questions (`READ_ONLY_MODAL`) & Worker/Reranker Guards**:
  - Added `isModalAnalyticalQuestion` to skip unnecessary `ask_question` prompts on analytical questions ([core/tool-pruner.mjs](core/tool-pruner.mjs)), stripped unsafe V8/CLI flags in `getSafeWorkerExecArgv` ([core/cpu-worker-pool.mjs](core/cpu-worker-pool.mjs)), and enforced word-boundary matching for short tokens (`<=3` chars) in [core/cpu-reranker.mjs](core/cpu-reranker.mjs).

---

## [3.18.0] — 2026-11-15

### Added
- **Semantic Vector Skill Index (`qwen3-embedding:0.6b` + `gemma4:12b`)**:
  - Implemented two-stage AI skill matching `matchSkillsAi` with contrastive `__none__` anchors, removal of hardcoded `SKILL_DOMAIN_KEYWORDS`, and semantic lesson distillation across [core/skill-crystallizer.mjs](core/skill-crystallizer.mjs), [core/local-gpu-engine.mjs](core/local-gpu-engine.mjs), and [core/tool-pruner.mjs](core/tool-pruner.mjs).
- **Optical Live RAM & GPU Telemetry**:
  - Separated quiet memory standby from active computation (`classifyOllamaWorkRequest`, `RamMemoryEngine.liveActivity`), added smooth 3-second afterglow and integrated token-savings indicators for both themes (`glass_teal` and `studio_titanium`).
- **Local GPU Model Selector & Direct In-Chat Model Search**:
  - Added `sel-gpuChatModel` / `sel-gpuEmbedModel` dropdowns and direct `model_search_prompt` (`buildAiModelSearchPrompt`) dispatch to chat without an intermediate modal ([core/hardware-profiler.mjs](core/hardware-profiler.mjs), [sidecars/panel/server.mjs](sidecars/panel/server.mjs), [sidecars/panel/ui.html](sidecars/panel/ui.html)).

### Changed
- **Post-Scout AI Triage & UI Heading Filtering**:
  - Stripped UI card titles in `stripUiTitlesForIntentClassification`, prioritized AI verdict after reading real code (`XL → M`), added two-way selector mismatch checks and zero-badge pre-estimates ([core/tool-pruner.mjs](core/tool-pruner.mjs), [core/hook-runner.mjs](core/hook-runner.mjs), [rules/AGENTS.md](rules/AGENTS.md)).
- **Auto-Clearing Fixed Test Failures in `Pitfall Ledger`**:
  - `resolveTestPitfallsFromCommand` and `PostToolUse` hook automatically purge resolved `test_failure` entries after passing test runs.
- **Release & Versioning Pipeline Hardening**:
  - Eliminated ReDoS risk in `SEMVER_RE` and expanded synced files (`README.md`, `assets/banner.svg`, `SKILL.md`) in [scripts/bump-version.mjs](scripts/bump-version.mjs), added auto-cleanup of old builds in [scripts/pack-release.mjs](scripts/pack-release.mjs), and expanded `DRIFT_CHECK_FILES`.

---

## [3.17.0] — 2026-11-15

### Added
- **Independent Verifier & `Stop` Lifecycle**:
  - Added read-only subagent [router-verifier.md](agents/router-verifier.md) for independent verification of edits, test suites, and audit gates on `L`/`XL` tasks and inside `Swarm`.
  - Subscribed to the `Stop` hook in [hooks.json](hooks.json) for guaranteed task progress finalization.
- **`PreInvocation` Hook & Installed Plugin Drift Guard**:
  - Added zero-token status badge `buildZeroTokenUserBadgeStep` (`user_markdown`) and source-vs-installed sync check `checkInstalledPluginDrift` in [core/hook-runner.mjs](core/hook-runner.mjs).
- **End-to-End Versioning System**:
  - Added synchronous version check and bump script [scripts/bump-version.mjs](scripts/bump-version.mjs) (`npm run version:check`, `version:patch`, `version:minor`) and unit tests [tests/version-sync.test.mjs](tests/version-sync.test.mjs).
- **Documentation & Product Rebrand**:
  - Rebranded product to **The Tunnel** (`The Tunnel · AI Model Router`) while preserving internal package ID `antigravity-model-router` for full cache, MCP, and config compatibility.
  - Created full [CHANGELOG.md](CHANGELOG.md) included in release bundles.

### Changed
- **Stable Progress Scale up to 30 Steps**: increased timeline step cap to `30` in [core/task-progress.mjs](core/task-progress.mjs) and [sidecars/panel/ui.html](sidecars/panel/ui.html), eliminating percentage regressions (`100% → 0% → 16%`) during planner-to-executor `Orchestrator (Carbon)` handoffs via `exit_plan_mode`.
- **Diagnostic Precision & False-Positive Filtering**: updated `formatCompactProcessError` and `runImpactedMicroTests` in [core/auto-verifier.mjs](core/auto-verifier.mjs) to filter passing TAP/`node:test` lines (`✔`, `✓`, `ok N`), and `recordPitfall` in [core/pitfall-ledger.mjs](core/pitfall-ledger.mjs) to ignore false-positive summaries.
- **ReDoS Resilience**: eliminated potential ReDoS patterns in `extractPrimarySymbolFromSnippet` and `formatCommandStepLabel` ([core/task-progress.mjs](core/task-progress.mjs)).

---

## [3.16.0] — 2026-11-14

### Added
- **`skill-architect` Meta-Skill & Local Skill Linter**:
  - Added 11th built-in skill [skills/skill-architect/SKILL.md](skills/skill-architect/SKILL.md) (*Progressive Disclosure 2.0*, *Negative Transfer* protection, *Merge-Over-Create* policy).
  - Added deterministic auditor and trigger benchmark [skills/skill-architect/scripts/audit-skill.mjs](skills/skill-architect/scripts/audit-skill.mjs) (`npm run lint:skills`) — all 11 built-in skills scored `100/100 (Grade A)`.
  - Upgraded auto-crystallization engine [core/skill-crystallizer.mjs](core/skill-crystallizer.mjs) (v2, *EvoSkill* error distillation).
- **Zero-LLM Web Reference Pipeline**:
  - Added [skills/ui-ux-design-system/scripts/fetch-web-refs.mjs](skills/ui-ux-design-system/scripts/fetch-web-refs.mjs) to extract CSS/design tokens, `og:image`, and preview cards directly without launching a heavy browser subagent or burning cloud tokens.

---

## [3.15.0] — 2026-11-14

### Added
- **Monotonic Multi-Chat Progress Engine**:
  - Created [core/task-progress.mjs](core/task-progress.mjs) with a monotonic progress scale (`MAX_RUNNING_PERCENT = 92`), `<= 35%` cap prior to code edits (`hasCodeEdits`), and 3-tier synthesis of compact technical stages from `exit_plan_mode` and AST/commands.
  - Hierarchical subagent & Swarm worker nesting (`inspectSubagentTranscriptMeta` up to `64 KB` in [core/model-profile.mjs](core/model-profile.mjs)) with `cid__wsHash` deduplication and active project grouping (`.ag-project-group`).
- **Parallel Window Isolation in RAM MCP**:
  - Added per-window workspace binding on `initialize` (`extractClientRootFromInitialize`) and active-project relative path resolution in [core/ram-memory-mcp.mjs](core/ram-memory-mcp.mjs).
- **Accurate Ollama VRAM Accounting & Optional Floating HUD**:
  - Implemented `reconcileLoadedModelsVram` in [core/local-gpu-engine.mjs](core/local-gpu-engine.mjs) for accurate VRAM reporting of multimodal builds like `gemma4:12b`.
  - Added [core/floating-hud.mjs](core/floating-hud.mjs) (disabled by default via `floatingHudEnabled: false`).

### Changed
- **Two Refined Visual Themes**: standardized [sidecars/panel/ui.html](sidecars/panel/ui.html) and [sidecars/panel/server.mjs](sidecars/panel/server.mjs) on dark **iOS Liquid Glass** (`glass_teal`) and refined light **Peach Porcelain** (`studio_titanium`); removed intermediate themes.
- **Expert Parameters & Localization**: expanded panel from `12` to `20` guardrails (`22` contours + `14` hardware/swarm flags = `36` keys in `GUARDRAIL_KEYS`) and localized all 47 built-in skill cards.

---

## [3.14.0] — 2026-11-14

### Added
- **Universal Polyglot Auditor SOTA 2026 (`deep-stress-auditor`)**:
  - Decoupled from internal plugin symbols into a zero-config 7-module polyglot engine (`stack-detector`, `file-worker-tasks`, `graph-and-contracts`, `sandbox-fuzzer`, `fuzz-worker`, `native-runners`, `report-formatter`) in [skills/deep-stress-auditor/scripts/](skills/deep-stress-auditor/scripts/).
  - Dual-contour `T1–T6` analysis matrix (JS/TS, Python, Go, Rust, C/C++, HTML, configs), CWE Source→Sink taint analysis, ReDoS, races/leaks, UI-API contracts, and sandbox fuzzing with `ddmin`.
  - Added dedicated test suite [tests/deep-stress-auditor.test.mjs](tests/deep-stress-auditor.test.mjs).

---

## [3.13.0] — 2026-11-14

### Added
- **3D Triage Matrix (`Breadth × Depth × Risk`)**:
  - Added `computeTask3DMatrix` and `buildAdaptive3DOptionsBlueprint` in [core/tool-pruner.mjs](core/tool-pruner.mjs) and [core/model-profile.mjs](core/model-profile.mjs) with `Critical-Blast` escalation for fragile nodes and `reverseDeps >= 4`.
  - Added anti-boilerplate filter `evaluateAskQuestionSelectorGuard` in [core/hook-runner.mjs](core/hook-runner.mjs) and continuous `[plan review]` orchestrator support.
- **Live Telemetry Polling**: lightweight `GET /api/telemetry` endpoint polled sequentially every `2.8 s` with auto-pause when the tab is hidden.

---

## [3.12.0] — 2026-11-14

### Added
- **Release Build Pipeline ([scripts/pack-release.mjs](scripts/pack-release.mjs))**:
  - Compiles standalone Windows installer `*-Setup.exe` (C# WinForms GUI + `--silent` / `/S` + `--uninstall` + embedded `.ico` and payload).
  - Generates portable UTF-8 `ZIP`, `SHA256SUMS.txt`, `release-manifest.json`, plus [install.bat](install.bat), [install.sh](install.sh), [Установить плагин.bat](Установить%20плагин.bat), and auto-generated `Удалить плагин.bat`.

---

## [3.11.0] — 2026-11-14

### Changed
- **iOS 26 Liquid Glass Panel Redesign**:
  - Retired the legacy Windows 95 aesthetic (`MODEL_ROUTER.EXE`, `SETUP_WIZARD.EXE`, `.win95-glass-window`).
  - Introduced glass cards (`backdrop-filter: blur`), specular borders, and a floating navigation pill with a sliding indicator.
  - Removed obsolete `workerModel` (`Flash 3.8`) toggle and key with automatic migration in [install.js](install.js).
  - Switched from single-chat telemetry to incremental aggregate token-savings statistics across all conversations.

---

## [3.10.0] — 2026-11-14

### Added
- **Flexible `UI/UX Preview Gate` (`uiInspirationMode`)**:
  - Strategy selector (`ask | showroom | web_refs`) via panel and [rules/AGENTS.md](rules/AGENTS.md), plus interactive A/B/C showroom generator [skills/ui-ux-design-system/scripts/build-showroom.mjs](skills/ui-ux-design-system/scripts/build-showroom.mjs).
- **GPU Boost**:
  - Dedicated embedder VRAM keep-alive (`gpuEmbedKeepAlive: "90m"`), background warm-up, and zero-token local file distillation `@file:<path>` in [core/local-gpu-engine.mjs](core/local-gpu-engine.mjs).

---

## [3.9.0] — 2026-11-14

### Added
- **Cross-Platform Hardware Auto-Profiler ([core/hardware-profiler.mjs](core/hardware-profiler.mjs))**:
  - Auto-detects CPU (`Intel` / `AMD` / `Apple` / `ARM`), RAM capacity (`1–12 GB` safe buffer), GPU (NVIDIA / AMD / Intel / Apple), and subscription tier on first launch and installation.
- **5-Phase Security & Isolation Hardening**:
  - Sidecar CSP/Origin and `window.sidecar.fetch` protection, inter-process JSON file locks ([core/safe-json.mjs](core/safe-json.mjs)), POSIX/ADS/Win32 path filters ([core/security-guard.mjs](core/security-guard.mjs)), and per-session isolation in [core/circuit-breaker.mjs](core/circuit-breaker.mjs) and [core/shadow-guard.mjs](core/shadow-guard.mjs).

---

## [3.8.0] — 2026-11-14

### Added
- **Multi-Threaded CPU Coprocessor & Cross-Reranker**:
  - Auto-scaling `node:worker_threads` pool with idle `unref()` ([core/cpu-worker-pool.mjs](core/cpu-worker-pool.mjs)).
  - Trigram inverted index + `BM25F` and Zero-VRAM CPU Cross-Reranker (`< 15 ms`) in [core/cpu-reranker.mjs](core/cpu-reranker.mjs).
  - Parallel micro-test execution and `ddmin` delta bug minimizer ([skills/delta-bug-minimizer/scripts/ddmin-runner.mjs](skills/delta-bug-minimizer/scripts/ddmin-runner.mjs)).

---

## [1.0.0 – 3.7.0] — 2026-11-04 .. 2026-11-14

### Early-Generation Milestones
- **v3.0 – v3.7**: Personalized PageRank (`d=0.50`) & `[Zero-Turn Gold Context]`, adaptive Bayesian v2 routing with 14-day half-life and `fragileFiles` matrix, In-RAM MCP server (`ram-memory-mcp.mjs`, up to 12 GB), quantized local GPU search `i8bin-v2` (Ollama `qwen3-embedding:0.6b` + `gemma4:12b`), Gemini 4 family support (`Hydrogen`, `Carbon`, `Argon`, `Orchestrator`), and native Swarm coordination (`core/swarm-controller.mjs`).
- **v2.0 – v2.5**: single-pass `RepoMap` AST index, Function X-Ray, transactional patches & `Shadow Guard` checkpoints, `Circuit Breaker`, history compaction, and episodic `Pitfall Ledger`.
- **v1.0 – v1.2**: initial plugin release, core routing hooks, and `Glass 95` control panel (`sidecars/panel`).

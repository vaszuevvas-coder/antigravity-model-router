# История изменений (Changelog) — **The Tunnel**

Все заметные изменения в **The Tunnel** (`antigravity-model-router`) документируются в этом файле в формате [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/) и [SemVer](https://semver.org/lang/ru/).

> Хронология с `v3.8.0` по `v3.35.0` восстановлена по журналам разработки и проверена по состоянию кодовой базы (`56` основных / `64` всего ESM-модулей ядра, `59` защитных контуров `GUARDRAIL_KEYS`, `13` навыков и `43` наборов автотестов).

---

## [3.35.0] — 2026-11-25

### Добавлено и улучшено (Модальный оверлей живого автообновления, мульти-источниковые авто-скиллы, Мега-диагностика 360° и стабильность HUD/панели)
- **Модальный оверлей живого автообновления в панели ([core/plugin-updater.mjs](core/plugin-updater.mjs), [install.js](install.js), [sidecars/panel/ui-src/head-body.html](sidecars/panel/ui-src/head-body.html), [sidecars/panel/ui-src/js/04-sentinel-layout.js](sidecars/panel/ui-src/js/04-sentinel-layout.js), [sidecars/panel/ui-src/js/00-i18n.js](sidecars/panel/ui-src/js/00-i18n.js), [sidecars/panel/ui-src/styles.css](sidecars/panel/ui-src/styles.css), [sidecars/panel/ui.html](sidecars/panel/ui.html), [tests/plugin-updater.test.mjs](tests/plugin-updater.test.mjs), [tests/panel-full-ui-e2e.test.mjs](tests/panel-full-ui-e2e.test.mjs))**:
  - Добавлен полноэкранный модальный оверлей `#pluginUpdateOverlay` с живой шкалой прогресса скачивания, распаковки и установки обновления, а баннер уведомления перенесён в верхнюю часть панели.
  - Реализована двуязычная диагностика ошибок обновления (`formatUpdateError`) и retry-копирование `copyFileWithRetrySync` в `install.js` при временных блокировках файлов на Windows (`EBUSY`/`EPERM`/`EACCES`).
- **Мульти-источниковое авто-обнаружение и векторный подбор скиллов ([core/gpu/gpu-vector-skills.mjs](core/gpu/gpu-vector-skills.mjs), [core/tool-pruner.mjs](core/tool-pruner.mjs), [core/hook-runner.mjs](core/hook-runner.mjs), [core/ram-memory-mcp.mjs](core/ram-memory-mcp.mjs), [tests/auto-skills.test.mjs](tests/auto-skills.test.mjs))**:
  - Внедрена функция `resolveSkillDiscoveryDirs` для сканирования активных плагинов, воркспейса (`.agents/skills`, `.gemini/skills`), личных и встроенных каталогов скиллов с уважением `enabled: false` и исключением внутренних swarm-скиллов (`INTERNAL_AUTO_SKIP_SLUGS`).
  - Добавлен детектор дрифта векторного индекса `hasSkillIndexDrift` и сквозная интеграция в `PreInvocation` и `tool-pruner`.
- **Единый 6-контурный CLI «Мега-диагностика 360°» ([scripts/run-mega-diagnostic.mjs](scripts/run-mega-diagnostic.mjs), [package.json](package.json), [tests/mega-cross-system-e2e.test.mjs](tests/mega-cross-system-e2e.test.mjs))**:
  - Добавлен скрипт `npm run audit:mega` для комплексной проверки: гигиена и манифесты, `deep-stress-auditor --fuzz`, 8 практических кросс-системных E2E-миссий, полная регрессия, живой GPU/CPU-прогон и живой CDP-обход панели.
- **Стабильность HUD, быстродействие панели и регрессионные тесты ([core/task-progress.mjs](core/task-progress.mjs), [core/progress/progress-parsers.mjs](core/progress/progress-parsers.mjs), [sidecars/panel/server.mjs](sidecars/panel/server.mjs), [core/gpu/gpu-critic-chat.mjs](core/gpu/gpu-critic-chat.mjs), [core/gpu/gpu-distill.mjs](core/gpu/gpu-distill.mjs), [tests/panel-ui-audit-regressions.test.mjs](tests/panel-ui-audit-regressions.test.mjs))**:
  - Введены TTL авто-закрытия зависших фоновых задач (`STALE_BG_TASK_TTL_MS` и `STALE_DAEMON_BG_TASK_TTL_MS`) и ускоренный путь сохранения настроек панели (`canUseFastPath`).
  - Набор автотестов расширен до `43` файлов (`tests/auto-skills.test.mjs`, `tests/mega-cross-system-e2e.test.mjs`, `tests/panel-ui-audit-regressions.test.mjs`).

---

## [3.34.1] — 2026-11-25

### Добавлено и исправлено (Фоновые задачи в HUD прогресса, детализация SimHash-дубликатов, калибровка маршрутизатора v4.2 и дедупликация утилит)
- **Трекинг фоновых задач и обновлённый HUD прогресса ([core/progress/progress-parsers.mjs](core/progress/progress-parsers.mjs), [core/task-progress.mjs](core/task-progress.mjs), [sidecars/panel/lib/panel-telemetry-collectors.mjs](sidecars/panel/lib/panel-telemetry-collectors.mjs), [sidecars/panel/ui-src/head-body.html](sidecars/panel/ui-src/head-body.html), [sidecars/panel/ui-src/js/05-progress-hud.js](sidecars/panel/ui-src/js/05-progress-hud.js), [sidecars/panel/ui-src/styles.css](sidecars/panel/ui-src/styles.css), [sidecars/panel/ui-src/js/00-i18n.js](sidecars/panel/ui-src/js/00-i18n.js), [sidecars/panel/ui.html](sidecars/panel/ui.html), [tests/router-core.test.mjs](tests/router-core.test.mjs), [tests/panel-browser-layout-cdp.test.mjs](tests/panel-browser-layout-cdp.test.mjs), [tests/panel-full-ui-e2e.test.mjs](tests/panel-full-ui-e2e.test.mjs))**:
  - Реализована полная история фоновых задач в транскриптах (`running`/`done`/`error`/`cancelled`, склейка `toolSummary` и `task-*.log`, маскирование секретов и авто-скрытие завершённых задач по `completedHoldMs`).
  - Кнопки **«Субагенты»** и **«Фоновые»** вынесены в отдельную строку под списком шагов с раскрывающимися списками, а лишняя капсула сэкономленных токенов убрана из HUD.
- **Калибровка байесовского маршрутизатора v4.2 ([core/bayesian-router.mjs](core/bayesian-router.mjs))**:
  - Перебалансированы веса сигналов `SIGNAL_WEIGHTS` и добавлена автоматическая миграция асимметричных приоров `v4.0 -> v4.2` (`migrateV40AsymmetricPriorsInPlace`).
- **Детализация пар дубликатов SimHash в Background Sentinel ([core/background-sentinel.mjs](core/background-sentinel.mjs), [sidecars/panel/lib/panel-sentinel-adapter.mjs](sidecars/panel/lib/panel-sentinel-adapter.mjs), [sidecars/panel/ui-src/js/04-sentinel-layout.js](sidecars/panel/ui-src/js/04-sentinel-layout.js), [tests/background-sentinel.test.mjs](tests/background-sentinel.test.mjs))**:
  - Добавлен сбор и отображение подробностей `clonePairs` (файл, символ, строка, % совпадения, `detailRu`/`detailEn`) и их сброс при очистке находок.
- **Дедупликация общих утилит кэша, PID и live-активности ([core/cache-dir.mjs](core/cache-dir.mjs), [core/cpu-worker-pool.mjs](core/cpu-worker-pool.mjs), [core/floating-hud.mjs](core/floating-hud.mjs), [core/gpu/gpu-composer-copilot.mjs](core/gpu/gpu-composer-copilot.mjs), [core/gpu/gpu-distill.mjs](core/gpu/gpu-distill.mjs), [core/gpu/gpu-shared-state.mjs](core/gpu/gpu-shared-state.mjs), [core/history-compactor.mjs](core/history-compactor.mjs), [core/hook-runner.mjs](core/hook-runner.mjs), [core/ram-memory-engine.mjs](core/ram-memory-engine.mjs), [core/cpu-graph-contracts.mjs](core/cpu-graph-contracts.mjs), [core/cpu-sbfl-healer.mjs](core/cpu-sbfl-healer.mjs), [sidecars/panel/server.mjs](sidecars/panel/server.mjs))**:
  - Общие функции `pruneObjectMapByTimestamp`, `isPidAlive` и `createBaseLiveActivityState` вынесены в `core/cache-dir.mjs`.

---

## [3.34.0] — 2026-11-25

### Добавлено и улучшено (Автообновление плагина, Lite/Full-панель, установщик Ollama, гибридные слои Карты проекта и Split-Turn смена модели)
- **Безопасное автообновление плагина с GitHub ([core/plugin-updater.mjs](core/plugin-updater.mjs), [tests/plugin-updater.test.mjs](tests/plugin-updater.test.mjs), [sidecars/panel/server.mjs](sidecars/panel/server.mjs))**:
  - Проверка релизов с 6-часовым кэшем, строгим белым списком доменов GitHub и лимитом архива `80 МБ`; установка в 1 клик с сохранением `router-state.json`, `.cache`, `checkpoints` и `backups`, защитой dev-репозиториев с `.git` и проверкой симлинков.
  - Добавлены API-маршруты панели: `/api/plugin/update-check`, `/api/plugin/update-status`, `/api/plugin/update-apply` и `/api/plugin/update-dismiss`.
- **Режим панели `Lite / Full`, масштаб UI и автоустановка Ollama в 1 клик ([core/gpu/gpu-vram-runtime.mjs](core/gpu/gpu-vram-runtime.mjs), [sidecars/panel/server.mjs](sidecars/panel/server.mjs), [sidecars/panel/ui-src/js/01-workspace-wizard.js](sidecars/panel/ui-src/js/01-workspace-wizard.js), [sidecars/panel/ui-src/js/02-telemetry-cards.js](sidecars/panel/ui-src/js/02-telemetry-cards.js), [sidecars/panel/ui-src/js/03-hardware-gpu.js](sidecars/panel/ui-src/js/03-hardware-gpu.js), [sidecars/panel/ui-src/js/04-sentinel-layout.js](sidecars/panel/ui-src/js/04-sentinel-layout.js), [router-state.json](router-state.json))**:
  - Добавлено переключение режима отображения `panelViewMode` (`full` / `lite` + быстрая карточка `liteQuickCard`), адаптивное масштабирование `panelUiScale`, нативные диалоги выбора папок (`/api/project-graph/pick-folder`, `/api/gpu/pick-folder`) и кнопка прерывания локального чата (`/api/local-chat/abort`).
  - Реализована 1-кликовая автоустановка Ollama (`startOllamaInstallJob`) с пользовательским каталогом `gpuOllamaDir` и поддержкой зеркала HuggingFace (`gpuPreferHfMirror`).
- **Интерактивная «Карта проекта» — гибридные архитектурные слои ([sidecars/panel/ui-src/js/07-project-graph.js](sidecars/panel/ui-src/js/07-project-graph.js), [sidecars/panel/ui-src/styles.css](sidecars/panel/ui-src/styles.css), [tests/project-graph-panel.test.mjs](tests/project-graph-panel.test.mjs))**:
  - Гибридная слоистая раскладка с ролевыми колонками, интерактивной фильтрацией и перетаскиванием колонок за заголовок, свободным откреплением/возвратом узлов к слою и сбросом позиций, поддержкой масштаба UI и выбором произвольной папки проекта.
- **Split-Turn передача смены модели (AGY 2.35+) и сквозной трекинг прогресса ([core/hook-runner.mjs](core/hook-runner.mjs), [core/tool-pruner.mjs](core/tool-pruner.mjs), [rules/AGENTS.md](rules/AGENTS.md), [core/task-progress.mjs](core/task-progress.mjs), [core/progress/progress-parsers.mjs](core/progress/progress-parsers.mjs), [tests/model-switch-split-turn.test.mjs](tests/model-switch-split-turn.test.mjs))**:
  - Поддержка паузы/завершения хода для разблокировки селектора модели в AGY 2.35+, сквозное сканирование Swarm/субагентов и фоновых задач, а также аккуратная маркировка чатов вне проекта («Без проекта» / «No project»).
- **Гигиена релиза и синхронизация метаданных ([install.js](install.js), [scripts/pack-release.mjs](scripts/pack-release.mjs), [scripts/bump-version.mjs](scripts/bump-version.mjs), [skills/github-publish-guard/scripts/audit-github-publish.mjs](skills/github-publish-guard/scripts/audit-github-publish.mjs), [README.md](README.md))**:
  - Валидация `gpuOllamaDir` в пре-аудиторе GitHub и установщике, автосинхронизация версии в `core/plugin-updater.mjs`, актуализация счётчиков проекта (`56`/`64` модулей ядра, `40` наборов автотестов).

---

## [3.33.1] — 2026-11-24

### Добавлено и исправлено (Навык `github-publish-guard` и улучшения «Карты проекта»)
- **Навык защиты публикаций GitHub ([skills/github-publish-guard/SKILL.md](skills/github-publish-guard/SKILL.md), [scripts/audit-github-publish.mjs](skills/github-publish-guard/scripts/audit-github-publish.mjs), [tests/github-publish-guard.test.mjs](tests/github-publish-guard.test.mjs))**:
  - Универсальный нуль-зависимый пре-аудитор (`npm run audit:github`) перед отправкой в GitHub: проверяет отсутствие отпечатков ПК и абсолютных путей пользователя (`C:\Users\<user>`, `/Users/<user>`, `/home/<user>`), локальных хостов/LAN IP, секретов и токенов, а также чистоту шаблонного `router-state.json`.
  - Проверяет соблюдение правил GitHub (лимиты размеров файлов `50/100 МБ`, запрет трекинга `.env`, ключей, кэшей и OS-мусора, наличие `LICENSE` / `.gitignore` / `README.md`) и точность метаданных (совпадение версий в `package.json`, `plugin.json`, `README.md`, `CHANGELOG.md`, `assets/banner.svg`, целостность относительных Markdown-ссылок, счётчиков и опциональную сверку `--remote` с `origin` и GitHub Releases).
  - Добавлены двуязычные названия/подсказки в каталоге панели ([sidecars/panel/lib/panel-state-skills.mjs](sidecars/panel/lib/panel-state-skills.mjs)) и регистрация в `install.js`; все `13` навыков проходят `npm run lint:skills` на `100/100 (Grade A)`.
- **Интерактивная «Карта проекта» — выбор воркспейса и исправления запуска ([sidecars/panel/server.mjs](sidecars/panel/server.mjs), [sidecars/panel/lib/panel-telemetry-collectors.mjs](sidecars/panel/lib/panel-telemetry-collectors.mjs), [sidecars/panel/ui-src/js/07-project-graph.js](sidecars/panel/ui-src/js/07-project-graph.js), [tests/project-graph-panel.test.mjs](tests/project-graph-panel.test.mjs))**:
  - Добавлен маршрут `/api/project-graph/workspaces` и обнаружение пользовательских проектов (`discoverUserProjectsForGraph`) для переключения воркспейсов прямо из карты проекта.
  - Исправлен холодный старт автономного окна `--app` на Windows (убран `windowsHide: true`, который скрывал первое окно) и устранена проблема с появлением свёрнутой левой панели при первом открытии карты.

---

## [3.33.0] — 2026-11-24

### Добавлено (Интерактивная «Карта проекта» — фазы 1–3)
- **Ядро графа и In-RAM MCP ([core/project-graph-builder.mjs](core/project-graph-builder.mjs), [core/ram-memory-mcp.mjs](core/ram-memory-mcp.mjs))**:
  - Построитель графа зависимостей с итеративным детектором циклов Tarjan SCC (`detectImportCyclesTarjan`), поиском изолированных файлов (`detectOrphanFiles`), картой влияния на тесты (`testFilesByTarget`), оценкой бюджета токенов (`estimateNodeTokens`), графом AST-символов файла (`buildFileSymbolGraphPayload`), парсером git churn (`parseGitChurnOutput`) и агрегацией семантических совпадений (`aggregateSemanticGraphHits`).
  - Добавлены 4 IPC-маршрута в RAM-демоне: `/graph/project-map`, `/graph/path`, `/graph/symbols` и `/graph/semantic-search`.
- **Бэкенд панели и автономное окно ([sidecars/panel/server.mjs](sidecars/panel/server.mjs))**:
  - Добавлены 7 API-маршрутов: `/api/project-graph`, `/api/project-graph/path`, `/api/project-graph/git-diff`, `/api/project-graph/symbols`, `/api/project-graph/git-churn`, `/api/project-graph/semantic-search` и `/api/project-graph/open-window`, а также поддержка автономного окна `?view=graph`.
- **Интерактивный UI карты проекта ([sidecars/panel/ui-src/js/07-project-graph.js](sidecars/panel/ui-src/js/07-project-graph.js), [07b-project-graph-lenses.js](sidecars/panel/ui-src/js/07b-project-graph-lenses.js), [07c-project-graph-visuals.js](sidecars/panel/ui-src/js/07c-project-graph-visuals.js), [07d-project-graph-spatial.js](sidecars/panel/ui-src/js/07d-project-graph-spatial.js), [head-body.html](sidecars/panel/ui-src/head-body.html), [styles.css](sidecars/panel/ui-src/styles.css), [00-i18n.js](sidecars/panel/ui-src/js/00-i18n.js), [sidecars/panel/ui.html](sidecars/panel/ui.html))**:
  - `07-project-graph.js`: уровни детализации «Папки / Файлы / Символы», раскладки «Слои» (Sugiyama) и «Облако» (Force), режимы «Глобальный / Локальный» (1–3 хопа), кластерные острова (Convex Hull), drill-down по папкам, сплит-инспектор («Blast / Импорты / Обзор / Файлы»), адаптивные тултипы с переворотом у края экрана, синхронизация тёмной/светлой тем и живой `EN / RU` перевод.
  - `07b-project-graph-lenses.js`: 5 инженерных линз («Архитектура», «Blast & Diff» с волной 1–3 хопа и живым `git diff`, «Циклы» Tarjan SCC + сироты, «Hotspots» churn × связность, «Путь A→B» по `Shift+клик`) и контекстная корзина с подсчётом токенов и отправкой пакета `@file:` в Smart Composer.
  - `07c-project-graph-visuals.js`: Edge Bundling по подсистемам, интерактивная миникарта, граф AST-символов, смысловой GPU-поиск (`Ollama` / лексический фолбэк), экспорт в Mermaid (`MMD`) и PNG.
  - `07d-project-graph-spatial.js`: поддержка мега-масштаба (5k–25k узлов) на базе пространственного квадранта Barnes-Hut `O(N log N)` и нуль-зависимого WebGL2 Instanced Renderer (авто-включение от `>=1200` узлов или вручную).
- **Автотесты и документация ([tests/project-graph-panel.test.mjs](tests/project-graph-panel.test.mjs), [README.md](README.md))**:
  - Добавлен набор из 9 комплексных тестов: проверка сборки и CSP, API/IPC-контракты, автономный запуск `?view=graph`, линзы, AST-символы, git churn, GPU-поиск, экспорт, стресс-тест 5k узлов Barnes-Hut/WebGL2 и E2E UX-полировка; актуализированы счётчики проекта (`55`/`63` модулей ядра, `37` наборов тестов).

---

## [3.32.2] — 2026-11-23

### Исправлено и улучшено (Аудит ядра, RAM/Graphify, Панели и Стресс-аудитора)
- **Память In-RAM и жизненный цикл `RamMemoryEngine`**:
  - Устранена утечка кучи V8 при `RamMemoryEngine.evict()`: закрываются и обнуляются `fs.watch` (`ws.watcher`), таймеры, индексы (`files`, `tokenIndex`, `trigramIndex`, `fieldPostings`, `forwardDeps`, `reverseDeps`, `repoMapCache`, `speculativeSkeletonCache`, `arena`) и `memoizer.entries` (`~227–371 МБ -> 12 МБ` на мега-репозиториях `fastapi`/`fiber`/`vite`) ([core/ram-memory-engine.mjs](core/ram-memory-engine.mjs)).
  - Для одноразового маршрута `/api/graph` отключён запуск вотчера (`startWatcher: false`) и добавлено гарантированное освобождение `finally { tmpEngine.evict('all'); }` ([sidecars/panel/server.mjs](sidecars/panel/server.mjs)).
- **Полиглотный граф импортов (Python + Go) и поиск по документации**:
  - Реализовано разрешение абсолютных Python-импортов (`pkg.sub.mod`), чтение `go.mod`, парсинг многострочных `import (...)` в Go, сопоставление `*_test.go`, обход устаревшего кэша Go AST в SQLite и понижение веса переводов `docs/<locale>/` в ранжировании `RamMemoryEngine.search()` ([core/ram/ram-index-helpers.mjs](core/ram/ram-index-helpers.mjs), [core/repo-mapper.mjs](core/repo-mapper.mjs), [core/cpu-ast-graph-compressor.mjs](core/cpu-ast-graph-compressor.mjs), [core/ram-memory-engine.mjs](core/ram-memory-engine.mjs)).
- **Панель управления, E2E и сборка релизов**:
  - Зафиксирован до-оптимистичный `_batchRollbackSnap` для отката `updateState()` при HTTP 500, аддитивное слияние `skillModes` без воскрешения закрытых DOM-карточек `panelCollapsedCards`/`panelOpenSpoilers`, безопасный DOM-рендер подсказки без `innerHTML` и двуязычные tooltips в `applyHookProfileOverridesToUi()` ([sidecars/panel/ui-src/js/02-telemetry-cards.js](sidecars/panel/ui-src/js/02-telemetry-cards.js), [sidecars/panel/ui-src/js/01-workspace-wizard.js](sidecars/panel/ui-src/js/01-workspace-wizard.js)).
  - Устранён TOCTOU при создании файлов в `/api/setup-recommendations/apply` (флаг `wx`), добавлен retry Windows Defender `EPERM` (`retryWinFsOp` до `30` попыток) при упаковке `Setup.exe` ([scripts/pack-release.mjs](scripts/pack-release.mjs)), исправлена гонка тем в CDP-тесте ([tests/panel-browser-layout-cdp.test.mjs](tests/panel-browser-layout-cdp.test.mjs)) и изолирован `TUNNEL_CACHE_DIR` для Теста 21 ([tests/router-core.test.mjs](tests/router-core.test.mjs)).
- **Хуки, сессионные метрики, локализация и `deep-stress-auditor`**:
  - Добавлен workspace-fallback `pickSessionEntry` для `conversationId === 'default'` ([core/completion-gates.mjs](core/completion-gates.mjs)), сохранение `PRE_EDIT_SNAPSHOT_FILE` между `gpuPostEditCritic` и `completionGates`, подключение `leanMode`/`terseMode` и авто-сканера `shortcut:` в `PostToolUse` ([core/hook-runner.mjs](core/hook-runner.mjs)).
  - Устранены `EN/RU` утечки в [core/shortcut-debt-ledger.mjs](core/shortcut-debt-ledger.mjs), [core/router-cli.mjs](core/router-cli.mjs), [core/project-setup-recommender.mjs](core/project-setup-recommender.mjs); добавлены защита от `null`-аргументов (`T6`), кэширование `LOCAL_SKILL_MD_CACHE` и синхронизированный `User-Agent` ([core/skill-registry-bridge.mjs](core/skill-registry-bridge.mjs)), перехват невалидного RegExp в [skills/skill-architect/scripts/eval-skill-benchmark.mjs](skills/skill-architect/scripts/eval-skill-benchmark.mjs) и фильтрация ложных срабатываний в [skills/deep-stress-auditor/](skills/deep-stress-auditor/scripts/lib/file-worker-tasks.mjs).

---

## [3.32.1] — 2026-11-23

### Исправлено и улучшено
- **Мастер настройки (Setup Wizard)**:
  - Кнопка отправки конфигурации ПК в чат (`sendHardwareTunePrompt()` на Шаге 1) больше не закрывает мастер досрочно и не пропускает Шаги 2–4 ([03-hardware-gpu.js](sidecars/panel/ui-src/js/03-hardware-gpu.js)).
  - Сводка ресурсов на Шаге 4 (`.wiz-summary-v`) переведена на многострочный перенос без обрезки `...`, а ширина модального окна `.wiz-overlay` ограничена под узкие вьюпорты `<= 420px` ([styles.css](sidecars/panel/ui-src/styles.css)).
- **Вёрстка панели на узких экранах (`420px`)**:
  - Устранено горизонтальное растяжение карточек `.lg-card`, `.expert-spoiler`, `.smart-banner`, `.sunken-box`, `.control-row` и `.sentinel-status-box` (`min-width: 0; max-width: 100%; flex-wrap: wrap` в [styles.css](sidecars/panel/ui-src/styles.css)).
  - Добавлена автоматическая регрессионная проверка отсутствия правого переполнения (`offendingBoxes`) в [tests/panel-browser-layout-cdp.test.mjs](tests/panel-browser-layout-cdp.test.mjs).
- **Надёжность состояния и профили хуков**:
  - Запросы `updateState(patch, opts)` сериализованы через очередь слияния патчей (`mergeStatePatches` / `flushPendingStateUpdates`), исключая отмену и гонки при быстрых кликах ([02-telemetry-cards.js](sidecars/panel/ui-src/js/02-telemetry-cards.js)).
  - `applyHookProfileOverridesToUi(profile, stateObj)` корректно восстанавливает состояние чекбоксов и активной кнопки `#hookProfileGroup` при возврате с `strict` на `standard`.
- **Полная живая синхронизация `RU ↔ EN`**:
  - Снят захардкоженный класс `active` с кнопки `EN` в [head-body.html](sidecars/panel/ui-src/head-body.html), убрано стартовое мигание `EN` при запуске на русском языке.
  - Добавлены кэширование и принудительная перерисовка всех свёрнутых, отложенных и диагностических виджетов (`flushAllRendersForLanguageChange()` для `AgentShield`, `GATES.md`, `Setup Doctor`, `Graphify v2`, `Техдолг shortcut:`, `Инстинкты`, `Эпизоды` в [02-telemetry-cards.js](sidecars/panel/ui-src/js/02-telemetry-cards.js) и [00-i18n.js](sidecars/panel/ui-src/js/00-i18n.js)) и кэш быстрых чипов Композера `_smartChipsLastList` ([06-smart-composer.js](sidecars/panel/ui-src/js/06-smart-composer.js)).
  - Устранена утечка `"Idle (waiting)"` в Фоновом Дозоре ([panel-sentinel-adapter.mjs](sidecars/panel/lib/panel-sentinel-adapter.mjs)) и добавлена двуязычная локализация `statusTextRu` / `statusTextEn` при загрузке каскада GPU-моделей ([core/gpu/gpu-vram-runtime.mjs](core/gpu/gpu-vram-runtime.mjs), [sidecars/panel/server.mjs](sidecars/panel/server.mjs), [03-hardware-gpu.js](sidecars/panel/ui-src/js/03-hardware-gpu.js)).
  - Пересобран [sidecars/panel/ui.html](sidecars/panel/ui.html).

---

## [3.32.0] — 2026-11-23

### Добавлено и адаптировано (полная 7-слойная двуязычность `EN / RU`)
- **Общий модуль локализации [core/i18n.mjs](core/i18n.mjs)**: единые функции `normalizeLang`, `detectOsLocale`, `resolveStateLanguage`, `pickLang`, `detectTextLanguage` и `readActiveUiLanguage` для ядра, CLI и установщиков.
- **Панель управления (`sidecars/panel/`) и бэкенд**:
  - Устранены все протечки кириллицы в `EN`-режиме во всех 7 фронтенд-модулях ([00-i18n.js](sidecars/panel/ui-src/js/00-i18n.js) … [06-smart-composer.js](sidecars/panel/ui-src/js/06-smart-composer.js)), пересобран [sidecars/panel/ui.html](sidecars/panel/ui.html).
  - Двуязычная выдача в [sidecars/panel/server.mjs](sidecars/panel/server.mjs), [sidecars/panel/lib/](sidecars/panel/lib/panel-telemetry-collectors.mjs), [core/task-progress.mjs](core/task-progress.mjs), [core/progress/progress-parsers.mjs](core/progress/progress-parsers.mjs), [core/hardware-profiler.mjs](core/hardware-profiler.mjs) и [core/project-setup-recommender.mjs](core/project-setup-recommender.mjs).
- **ИИ-хуки, правила и аудиторы ядра**:
  - Динамическая адаптация под `uiLanguage` (`en` / `ru`) в [rules/AGENTS.md](rules/AGENTS.md), [core/hook-runner.mjs](core/hook-runner.mjs), [core/model-profile.mjs](core/model-profile.mjs), [core/tool-pruner.mjs](core/tool-pruner.mjs), [core/completion-gates.mjs](core/completion-gates.mjs), [core/bayesian-router.mjs](core/bayesian-router.mjs), [core/quota-pacer.mjs](core/quota-pacer.mjs), [core/cpu-worker-pool.mjs](core/cpu-worker-pool.mjs), [core/history-compactor.mjs](core/history-compactor.mjs), [core/agent-shield.mjs](core/agent-shield.mjs), [core/background-sentinel.mjs](core/background-sentinel.mjs), [core/runtime-wiretap.mjs](core/runtime-wiretap.mjs), [core/shadow-guard.mjs](core/shadow-guard.mjs), [core/shadow-worktree.mjs](core/shadow-worktree.mjs), [core/skill-registry-bridge.mjs](core/skill-registry-bridge.mjs), [core/friction-observer.mjs](core/friction-observer.mjs), [core/circuit-breaker.mjs](core/circuit-breaker.mjs) и [core/cpu-mutation-guard.mjs](core/cpu-mutation-guard.mjs) с сохранением контрактов `*Ru`/`*En`.
- **Локальный GPU-движок, Floating HUD и навыки**:
  - Локализованы [core/floating-hud.mjs](core/floating-hud.mjs), [core/gpu/gpu-critic-chat.mjs](core/gpu/gpu-critic-chat.mjs), [core/gpu/gpu-vram-runtime.mjs](core/gpu/gpu-vram-runtime.mjs), [core/gpu/gpu-distill.mjs](core/gpu/gpu-distill.mjs), [core/gpu/gpu-vector-skills.mjs](core/gpu/gpu-vector-skills.mjs) и [core/gpu/gpu-composer-copilot.mjs](core/gpu/gpu-composer-copilot.mjs).
  - Добавлена поддержка `--lang=en|ru` / `readActiveUiLanguage()` в [skills/ui-ux-design-system/scripts/build-showroom.mjs](skills/ui-ux-design-system/scripts/build-showroom.mjs), [skills/ui-ux-design-system/scripts/fetch-web-refs.mjs](skills/ui-ux-design-system/scripts/fetch-web-refs.mjs), [skills/delta-bug-minimizer/scripts/ddmin-runner.mjs](skills/delta-bug-minimizer/scripts/ddmin-runner.mjs) и [skills/ui-ux-design-system/SKILL.md](skills/ui-ux-design-system/SKILL.md).
- **Манифесты, установщики, CLI и тесты**:
  - Англоязычные манифесты [plugin.json](plugin.json), [sidecars/panel/sidecar.json](sidecars/panel/sidecar.json) и [package.json](package.json); расширенные правила синхронизации версий `EN + RU` в [scripts/bump-version.mjs](scripts/bump-version.mjs).
  - Автоопределение локали ОС (`ru` / `en`, флаги `--lang=en|ru`, переменная `TUNNEL_LANG`) в [install.js](install.js), [install.sh](install.sh), [core/router-cli.mjs](core/router-cli.mjs) и в WinForms C# 5.0 `Setup.exe` ([scripts/pack-release.mjs](scripts/pack-release.mjs)), плюс англоязычный `uninstall.bat` рядом с `Удалить плагин.bat` в релизном архиве.
  - Расширен регрессионный набор [tests/i18n-language.test.mjs](tests/i18n-language.test.mjs) (8 тестов, включая проверку отсутствия кириллицы в манифестах, модулях ядра в `EN`-режиме и статическом DOM `ui.html`).

---

## [3.31.0] — 2026-11-23

### Добавлено
- **Wave 1 — Дисциплина минимального диффа (`Lean / Terse`), реестр техдолга и Fresh-Test Gate**:
  - Новые настройки `leanMode` (`off | lite | full | ultra`) и `terseMode` (`off | caveman | ultracave`) в [router-state.json](router-state.json), [sidecars/panel/lib/panel-state-skills.mjs](sidecars/panel/lib/panel-state-skills.mjs), [core/tool-pruner.mjs](core/tool-pruner.mjs), [core/hook-runner.mjs](core/hook-runner.mjs) и в пульте управления ([sidecars/panel/ui-src/head-body.html](sidecars/panel/ui-src/head-body.html), [sidecars/panel/ui-src/js/00-i18n.js](sidecars/panel/ui-src/js/00-i18n.js), [sidecars/panel/ui-src/js/01-workspace-wizard.js](sidecars/panel/ui-src/js/01-workspace-wizard.js), [sidecars/panel/ui-src/js/04-sentinel-layout.js](sidecars/panel/ui-src/js/04-sentinel-layout.js)).
  - Новый модуль [core/shortcut-debt-ledger.mjs](core/shortcut-debt-ledger.mjs) (`scanShortcutDebt`, `extractFileShortcutMarkers`, `parseShortcutCommentBody`) для сбора меток осознанного техдолга `// shortcut:` / `// ponytail:` с детектом рисков `no-trigger` без условия апгрейда, плюс подкоманда `debt` в [core/router-cli.mjs](core/router-cli.mjs) и маршрут `/api/debt` в [sidecars/panel/server.mjs](sidecars/panel/server.mjs).
  - В [core/completion-gates.mjs](core/completion-gates.mjs) добавлены метрики переиспользования кода в диффе (`computeDiffReuseMetrics`, `recordSessionReuseMetrics`, `getSessionReuseSummary`) и гейт свежести тестов (`isVerificationTestCommand`, `recordSessionCodeEdit`, `recordSessionTestExecution`, `getSessionVerificationFreshness`); обновлены [agents/router-verifier.md](agents/router-verifier.md) и [GATES.md](GATES.md).
- **Wave 2 — Graphify v2 (достоверность рёбер, `topologyHash`, мосты и `dynamic_import`)**:
  - В [core/cpu-ast-graph-compressor.mjs](core/cpu-ast-graph-compressor.mjs) и [core/ram-memory-engine.mjs](core/ram-memory-engine.mjs) добавлена разметка достоверности связей `EXTRACTED / INFERRED / AMBIGUOUS`, детерминированный `computeGraphTopologyHash`, поиск неожиданных архитектурных мостов `findSurprisingConnections`, генерация вопросов по архитектуре `suggestArchitectureQuestions`, а также обход `dynamic_import` и `re_exports` в `queryAffectedBlastGraph`.
  - В пульте и сервере добавлен маршрут `/api/graph` и интерактивный ящик «Карта графа / Техдолг» в [sidecars/panel/ui-src/js/02-telemetry-cards.js](sidecars/panel/ui-src/js/02-telemetry-cards.js).
- **Wave 3 — OmniRoute Guardrails и профили RTK v2**:
  - Защита от холостых повторов инструментов (`recordAndCheckStalledToolRound`, `resetToolRoundHistory`) в [core/circuit-breaker.mjs](core/circuit-breaker.mjs).
  - В [core/quota-pacer.mjs](core/quota-pacer.mjs) добавлены stateless-подбор глубины мышления (`resolveStatelessTurnEffort`), аудит теплоты кэша (`computeCacheWarmthStatus`) и score-ориентированный выбор failover-цели (`resolveScoreDrivenComboTarget`).
  - В [core/obs-masker.mjs](core/obs-masker.mjs) добавлены профили сжатия `compressRtkCommandOutput` (`git status`, сводки тестовых прогонов).
- **Wave 4 — Валидатор `agentskills.io`, A/B Evals, Caveman Blocks и OpenSpec**:
  - Проверка спецификации `agentskills.io` и Negative Transfer в [skills/skill-architect/scripts/audit-skill.mjs](skills/skill-architect/scripts/audit-skill.mjs).
  - Детерминированный A/B-оценщик навыков [skills/skill-architect/scripts/eval-skill-benchmark.mjs](skills/skill-architect/scripts/eval-skill-benchmark.mjs) и подкоманда `eval-skill` в [core/router-cli.mjs](core/router-cli.mjs).
  - Новый модуль [core/reusable-blocks-specs.mjs](core/reusable-blocks-specs.mjs) для кэширования диагностических микро-скриптов (`saveReusableBlock`, `listReusableBlocks`) и ограниченных дельта-спецификаций OpenSpec до `50 КБ` (`upsertOpenSpecDelta`, `readOpenSpecDelta`, `listOpenSpecDeltas`, `formatActiveSpecsForHandoff` в [core/session-handoff.mjs](core/session-handoff.mjs)), плюс CLI-команды `spec` и `blocks`.
  - Новый набор автотестов [tests/v331-sota-4waves.test.mjs](tests/v331-sota-4waves.test.mjs) (итого `36` наборов тестов).

### Исправлено и обновлено
- В [core/hardware-profiler.mjs](core/hardware-profiler.mjs) добавлена `isActivePluginInstallDir` для калибровки `mcp_config.json` при прямом `git clone` в папку плагинов ([tests/router-core.test.mjs](tests/router-core.test.mjs)).
- В [core/gpu/gpu-shared-state.mjs](core/gpu/gpu-shared-state.mjs) и [core/gpu/gpu-vram-runtime.mjs](core/gpu/gpu-vram-runtime.mjs) оффлайн-backoff Ollama изолирован по origin endpoint (`ollamaOfflineEndpoint`).
- В [skills/programmatic-video-studio/scripts/lint-video-composition.mjs](skills/programmatic-video-studio/scripts/lint-video-composition.mjs) и [skills/ui-ux-design-system/scripts/build-showroom.mjs](skills/ui-ux-design-system/scripts/build-showroom.mjs) пути преобразуются через `pathToFileURL`.
- Актуализирована нумерация разделов и счётчиков (`53`/`61` модулей ядра, `59` защитных контуров в UI и документации вместо `25+`, `36` наборов тестов), пересобрана панель [sidecars/panel/ui.html](sidecars/panel/ui.html) и обновлена лицензия [LICENSE](LICENSE).

---

## [3.30.0] — 2026-11-23

### Добавлено
- **Полноценная двуязычность интерфейса, хуков и правил (`EN` / `RU`)**:
  - Настройка `uiLanguage` (`en` / `ru`, по умолчанию `en` для чистой установки и релиза с сохранением пользовательского выбора в [install.js](install.js) и [scripts/pack-release.mjs](scripts/pack-release.mjs), валидация в [sidecars/panel/lib/panel-state-skills.mjs](sidecars/panel/lib/panel-state-skills.mjs)).
  - Нуль-зависимый движок живого перевода панели [sidecars/panel/ui-src/js/00-i18n.js](sidecars/panel/ui-src/js/00-i18n.js) и синхронная сборка [sidecars/panel/ui.html](sidecars/panel/ui.html).
  - Динамическая адаптация заголовков `SessionStart` (`EN-Chat` / `RU-Chat`) в [core/hook-runner.mjs](core/hook-runner.mjs), подсказок `Pre-Task Gate` в [core/tool-pruner.mjs](core/tool-pruner.mjs) и инструкций в [rules/AGENTS.md](rules/AGENTS.md).
  - Автотесты локализации [tests/i18n-language.test.mjs](tests/i18n-language.test.mjs); расширенная синхронизация обеих языковых веток и fallback-версий в [scripts/bump-version.mjs](scripts/bump-version.mjs).

---

## [3.29.0] — 2026-11-22

### Добавлено
- **Диагностика стека проекта и мост внешних навыков**:
  - Анализатор стека и рекомендатор автоматизации [core/project-setup-recommender.mjs](core/project-setup-recommender.mjs) (на базе `stack-detector.mjs`) с маршрутом `/api/setup-recommendations` в [sidecars/panel/server.mjs](sidecars/panel/server.mjs).
  - Безопасный мост поиска и карантинного импорта внешних навыков [core/skill-registry-bridge.mjs](core/skill-registry-bridge.mjs) с проверкой через `AgentShield`, линтером `audit-skill.mjs`, блокировкой бинарных файлов и сохранением пользовательских навыков `.user-skill.json` при обновлении в [install.js](install.js).
- **Отказоустойчивость провайдеров, дизайн-экстрактор и dogfooding**:
  - Цепочки failover и TTL-кулдауны в [core/quota-pacer.mjs](core/quota-pacer.mjs) и интеграция с директивами [core/swarm-controller.mjs](core/swarm-controller.mjs).
  - Извлечение токенов дизайна в `DESIGN.md` ([skills/ui-ux-design-system/scripts/extract-design-md.mjs](skills/ui-ux-design-system/scripts/extract-design-md.mjs)), проверка WCAG-контраста и i18n-переполнения в [skills/ui-ux-design-system/scripts/audit-ui.mjs](skills/ui-ux-design-system/scripts/audit-ui.mjs), а также интерактивный веб-аудитор [skills/deep-stress-auditor/scripts/run-webapp-dogfood.mjs](skills/deep-stress-auditor/scripts/run-webapp-dogfood.mjs).
- **Оптимизации под мега-репозитории и безопасность**:
  - Ускорение `buildDocConfigReferenceGraph` и `RamMemoryEngine.getContextPack` ([tests/mega-repo-bottlenecks.test.mjs](tests/mega-repo-bottlenecks.test.mjs)), снижение ложных срабатываний полиглот-аудитора, поддержка UTF-16LE BOM `.agentignore` в [core/security-guard.mjs](core/security-guard.mjs) и расширенный детект утечек в [core/agent-shield.mjs](core/agent-shield.mjs).

---

## [3.28.0] — 2026-11-21

### Добавлено
- **Headroom CCR, 3-уровневая эпизодическая память и защита конфигов**:
  - Обратимая компрессия терминальных логов и 3-слойная эпизодическая память в [core/sqlite-knowledge-hub.mjs](core/sqlite-knowledge-hub.mjs) с инструментами `ram_ccr_retrieve` и `ram_memory_recall` в [core/ram-memory-mcp.mjs](core/ram-memory-mcp.mjs) и [mcp_config.json](mcp_config.json).
  - Оффлайн-аудитор безопасности MCP/хуков/навыков [core/agent-shield.mjs](core/agent-shield.mjs), детектор трения пользователя и накопления инстинктов [core/friction-observer.mjs](core/friction-observer.mjs) с эволюцией в [core/skill-crystallizer.mjs](core/skill-crystallizer.mjs).
  - Гейты приёмки `GATES.md`, сканер добавленных заглушек и анти-луп Stop-хука в [core/completion-gates.mjs](core/completion-gates.mjs).
- **Экосистемные интеграции, UX-матрица и видеостудия**:
  - UX-матрица `ux-matrix.json`, запрос дизайн-паттернов [skills/ui-ux-design-system/scripts/query-ux-matrix.mjs](skills/ui-ux-design-system/scripts/query-ux-matrix.mjs), правила `react-vercel-rules.md` и поиск открытых медиа [skills/ui-ux-design-system/scripts/fetch-open-media.mjs](skills/ui-ux-design-system/scripts/fetch-open-media.mjs).
  - Директивы `Grill-Me` и 3D-опции в [core/tool-pruner.mjs](core/tool-pruner.mjs), принудительная глубина мышления (`explicit thinking depth`) в [core/model-profile.mjs](core/model-profile.mjs) и [rules/AGENTS.md](rules/AGENTS.md).
  - Навык программируемой видеостудии [skills/programmatic-video-studio/SKILL.md](skills/programmatic-video-studio/SKILL.md) (HyperFrames / Remotion линтер и процедурный синтез WAV/SFX).
  - Браузерные CDP E2E-тесты раскладки панели ([tests/panel-browser-layout-cdp.test.mjs](tests/panel-browser-layout-cdp.test.mjs)) и контрактные тесты субпроцессов/установки ([tests/v328-wave1-wave2.test.mjs](tests/v328-wave1-wave2.test.mjs), [tests/v328-ecosystem-integrations.test.mjs](tests/v328-ecosystem-integrations.test.mjs)).

---

## [3.27.0] — 2026-11-20

### Добавлено
- **Умный Композер 2.0 (`@`-чипы, локальный Vision и голос) в [sidecars/panel/server.mjs](sidecars/panel/server.mjs), [sidecars/panel/ui.html](sidecars/panel/ui.html) и [core/local-gpu-engine.mjs](core/local-gpu-engine.mjs)**:
  - Меню быстрого контекста по символу `@` (`/api/composer/at-suggest`, `<10 мс`): `@file:`, `@symbol:`, `@git:diff`, `@git:staged`, `@error:last`, `@repo:`.
  - Вставка UI-скриншотов (`Ctrl+V` / drag-and-drop, лимит `<=4 МБ`) и локальный визуальный аудит через `analyzeUiScreenshotLocally` (Gemma 4 `/api/chat` с `images`, `/api/composer/vision`, **0% облачных токенов**).
  - Опциональная диктовка через Web Speech API (`#chk-composerVoiceEnabled`, `structureVoiceTranscriptLocally`, `/api/composer/voice-structure`).
- **Pre-Commit без облака (`✓ Коммит · 0 тк`) в [core/background-sentinel.mjs](core/background-sentinel.mjs)**:
  - Действие `prepare_commit` объединяет Shadow Guard (AST/импорты/LSP), проверку диффа на утечку секретов, кэш/аудит Local BugBot и генерацию Conventional Commit сообщения (`generateLocalCommitSummary` с оффлайн-фолбэком).
- **Изолированный CPU Semantic Mutation Guard (`core/cpu-mutation-guard.mjs`)**:
  - Проверка стойкости автотестов на 1-точечных граничных мутантах во временной копии каталога ОС без изменения исходников проекта (`runSemanticMutationGuard`, опциональный тумблер `#chk-mutationGuardEnabled` и ленивый MCP-инструмент `mutation_guard_check` в [mcp_config.json](mcp_config.json)).

---

## [3.26.0] — 2026-11-20

### Добавлено
- **Живой перехватчик ошибок и автоматический `git bisect` (`core/runtime-wiretap.mjs`)**:
  - Подкоманда `node core/ag-cli.mjs watch <cmd...>` транслирует вывод запускаемого процесса и мгновенно фиксирует падения в `.cache/runtime-wiretap.json` (SimHash64-дедупликация, маскировка логов и секретов, извлечение локального кадра стека `±6` строк).
  - Ленивый MCP-инструмент `git_bisect_auto` (`"eager": false` в [mcp_config.json](mcp_config.json)) для автоматического бинарного поиска коммита-регрессии во временном `git worktree` без изменения рабочей копии.
  - Интерактивный баннер сбоев `#wiretapAlertBar` в Умном Композере + маршруты `/api/wiretap/fault`, `/api/wiretap/faults`, `/api/wiretap/clear`.
- **Предиктор квоты и аудит стабильности префикса (`core/quota-pacer.mjs`)**:
  - Скользящее окно расхода квоты за 30/60 минут (`Hydrogen / Orchestrator / Neon / Carbon`, лимиты `Pro` / `Ultra`) + бейдж `#quotaPacerBadge` и аудит неизменности статического префикса Gemini 4 (`>=4096` токенов).

---

## [3.25.0] — 2026-11-20

### Добавлено
- **Походовая машина времени (`Turn-Level Time-Machine`) в [core/shadow-guard.mjs](core/shadow-guard.mjs) и [core/hook-runner.mjs](core/hook-runner.mjs)**:
  - Привязка всех снимков `edit_file` / `write_file` к `turnId` и названию пользовательского хода.
  - Реализованы `listTurnCheckpoints`, `getTurnDiffSummary` и атомарный откат целого хода `rollbackTurn` с восстановлением самого раннего пред-ходового состояния каждого файла и удалением созданных за ход новых файлов.
- **Изолированная Git-песочница (`core/shadow-worktree.mjs`)**:
  - Работа в одном detached `git worktree` (`.cache/worktrees/wt_*`) без вмешательства в основную рабочую копию: `createShadowWorktree`, `runInShadowWorktree`, `getShadowWorktreeDiff`, `promoteShadowWorktree` (с обязательным теневым чекпоинтом) и `discardShadowWorktree`.
  - В пульте добавлены переключатель `По ходам / По файлам`, кнопка `↶ Откатить ход`, панель управления песочницами `/api/checkpoints/turns`, `/api/checkpoints/rollback-turn`, `/api/worktree/action` и тумблер `#chk-shadowWorktreeEnabled`.

---

## [3.24.0] — 2026-11-20

### Добавлено
- **NVMe-хаб знаний на `node:sqlite` (`core/sqlite-knowledge-hub.mjs`)**:
  - Персистентное хранение бакетов `RepairKV` и SHA-1 AST-метаданных в WAL-базе `.cache/tunnel-knowledge.sqlite` для мгновенного холодного старта после перезагрузки ПК (не дублирует бинарный индекс `i8bin-v2`).
  - **База «Рецептов побед» (`victory_recipes`)**: автоматическая фиксация успешных починок тестов в [core/hook-runner.mjs](core/hook-runner.mjs) и инжекция подсказки `🏆 [Victory Recipe]` в `PreInvocation`.
  - **Кросс-проектная федерация (`repo_federation`)**: связывание смежных репозиториев (`includeFederated` в `ram_search`) и интерфейс управления в пульте ([sidecars/panel/ui.html](sidecars/panel/ui.html), `/api/knowledge/recipes`, `/api/knowledge/federation`).

---

## [3.23.0] — 2026-11-20

### Добавлено
- **Живой LSP-мост (`core/lsp-bridge.mjs`)**:
  - Реализован JSON-RPC 2.0 мультиплексор `Content-Length` поверх `stdio` без внешних зависимостей для языковых серверов `typescript-language-server`, `pyright-langserver`/`pylsp`, `gopls` и `rust-analyzer` с авто-выгрузкой по простою.
  - Интегрированы мгновенная проверка типов в `/hook/post-edit` и `PostToolUse` (`🧬 [LSP Type Check]`), фоновый сбор диагностик в [core/background-sentinel.mjs](core/background-sentinel.mjs), три ленивых MCP-инструмента (`lsp_diagnostics`, `lsp_references`, `lsp_code_actions` в [core/ram-memory-mcp.mjs](core/ram-memory-mcp.mjs) и [mcp_config.json](mcp_config.json)), а также тумблер `#chk-lspBridgeEnabled` в пульте управления.

---

## [3.22.0] — 2026-11-18

### Добавлено
- **CPU SOTA Suite (без расхода VRAM)**:
  - В [core/cpu-graph-contracts.mjs](core/cpu-graph-contracts.mjs) и [core/cpu-sbfl-healer.mjs](core/cpu-sbfl-healer.mjs) реализованы 2..3-hop граф `Personalized PageRank` (`computeBipartiteSymbolPPR`), анализ эволюционной связности `Git Co-Change`, проверка арности и ключей экспортов, радар 64-битных AST-клонов `SimHash`, локализация дефектов `SBFL Ochiai` поверх `NODE_V8_COVERAGE`, нечёткое восстановление патчей `Bitap` и извлечение таблицы фактов; интеграция в [core/auto-verifier.mjs](core/auto-verifier.mjs), [core/diff-patcher.mjs](core/diff-patcher.mjs) и тумблер `chk-cpuSotaEngines` в пульте.
- **Zero-Copy RAM-арена `SharedArrayBuffer`, `CSR`-индекс и `Prefetch`**:
  - Создан [core/ram-sota-arena.mjs](core/ram-sota-arena.mjs) (`SharedRamArena`, `CsrInvertedIndex` на плоских `Uint32Array`, `orderSlicesPrefixStable` для стабильности префиксного кэша).
  - В [core/cpu-worker-pool.mjs](core/cpu-worker-pool.mjs) и [core/ram-memory-engine.mjs](core/ram-memory-engine.mjs) внедрена передача буферов в пул воркеров без копирования строк (`zeroCopyTasks`), спекулятивный префетч 1-hop зависимых AST-скелетов после правок (`scheduleSpeculativePrefetch`) и ленивый `CSR`-индекс.
- **Межшаговая мемоизация *ACON* и память после компакции *RepairKV***:
  - В [core/ram-sota-arena.mjs](core/ram-sota-arena.mjs), [core/ram-memory-mcp.mjs](core/ram-memory-mcp.mjs), [core/hook-runner.mjs](core/hook-runner.mjs) и [core/history-compactor.mjs](core/history-compactor.mjs) добавлены маршруты `/hook/memo-check`, `/hook/memo-record`, `/hook/compaction-archive`, перехват неизменённых длинных выводов `run_command` с защитой от зацикливания и автоподъём забытых фактов в `PreInvocation`.
- **Синергия GPU ↔ DDR5 RAM, `OLLAMA_NUM_PARALLEL=1` и аппаратные потолки**:
  - В [core/local-gpu-engine.mjs](core/local-gpu-engine.mjs) добавлен флаг `OLLAMA_NUM_PARALLEL=1` (экономия 1.5–3 ГБ VRAM на слотах KV-кэша), постоянный LRU/SimHash-кэш `gpu_distill` и `Post-Edit Critic` (`.cache/gpu-distill-cache.json`) и фоновый прогрев весов GGUF в свободную системную DDR5 (`warmGgufModelsInHostRam`).
  - В [core/hardware-profiler.mjs](core/hardware-profiler.mjs), [install.js](install.js), [sidecars/panel/server.mjs](sidecars/panel/server.mjs) и [sidecars/panel/ui.html](sidecars/panel/ui.html) добавлены динамические аппаратные потолки (`computeHardwareCeilings`), шкала до `16–24 ГБ RAM` и `24` потоков CPU для станций уровня 64 ГБ / 32 потока, тумблеры `#chk-ramSotaEngines` и `#chk-gpuWarmHostRamCache`, а также учёт SOTA-экономии RAM в счётчике пульта.

---

## [3.21.0] — 2026-11-17

### Добавлено
- **Щит `Frozen Prefix` и квантование префикса Gemini 4 (`4096-Token Floor Snap`)**:
  - В [core/session-handoff.mjs](core/session-handoff.mjs) убрана волатильная метка времени `Updated:` из текста префикса `SessionStart`, внедрена аккуратная обрезка по границам слов (`truncateCleanly`) со сбалансированными скобками и нормализация POSIX-путей; в [core/hook-runner.mjs](core/hook-runner.mjs) (`buildCacheAlignedInjection`) добавлено дотягивание малых карт репозитория за порог 4096 токенов и буфер пред-редакторных снимков `.cache/pre-edit-last.json` для точного диффа в `Post-Edit Critic`.
- **Каскадный `Post-Edit Critic` и поддержка `UTF-16LE/BE` в `gpu_distill`**:
  - В [core/local-gpu-engine.mjs](core/local-gpu-engine.mjs) добавлен декодер `decodeTextBufferAutoUtf` (прозрачное чтение PowerShell-логов `UTF-16LE`/`UTF-16BE` с BOM и без BOM, с сохранением защиты от бинарников), исправлен каскадный фоллбэк на `qwen3:4b` при дефиците VRAM (`ollamaTagsCache`) и добавлена инъекция заголовка охватывающей функции (`Enclosing scope`).
- **In-RAM `2-Hop Contracts`, скиммер `SWE-Pruner`, `Cross-Layer Seams` и `AST-Delta`**:
  - В [core/ram-memory-engine.mjs](core/ram-memory-engine.mjs) реализованы `getTwoHopContractStrip` (встроен в `getContextPack`), `skimCodeBlocksByQuery`, `findCrossLayerSeams`, а также компактный формат срезов `120|` (`compactLines`) и сворачивание шапки импортов (`foldBoilerplateHead`); в [core/cpu-delta-reread.mjs](core/cpu-delta-reread.mjs) добавлен `astSymbolSummary`.
- **Терминальный фильтр `RTK v2` + `Zero-Turn Fault Pinning`**:
  - В [core/obs-masker.mjs](core/obs-masker.mjs) добавлены очистка `\r`-спиннеров прогресс-баров и `UTF-16` нулей, сворачивание цепочек системных кадров (`[... N internal frames folded]`) и линейный $O(N)$-поиск `extractTopFaultCodePin` (`📌 [Fault Pin ...]`).
- **Сериализация `TOON v2`, `Fuzzy-AST` патчер и `AgentDiet`**:
  - В [core/toon-formatter.mjs](core/toon-formatter.mjs) и [core/ram-memory-mcp.mjs](core/ram-memory-mcp.mjs) добавлены `canonicalizeJson`, `toPosixRelPath` и `flattenNestedConfigToDotPaths`.
  - В [core/diff-patcher.mjs](core/diff-patcher.mjs) добавлен `Fuzzy Indentation & Trailing-Whitespace Snap` с адаптивным масштабированием шага отступов; в [core/history-compactor.mjs](core/history-compactor.mjs) добавлен анализатор устаревших наблюдений `analyzeAgentDietTrajectoryWaste`.
- **Когнитивный автопилот: `Chain-of-Draft`, `FailFast-RestartSmart`, `ReasoningBank` и `CoDyn Bayesian Router`**:
  - В [core/tool-pruner.mjs](core/tool-pruner.mjs) добавлены `buildAdaptiveReasoningDirective`, нативное распознавание одобрения артефакта (`The user has approved this document.`) и привязка русских фраз к DOM ID/ключам настроек (`anchoredEntities`).
  - В [core/circuit-breaker.mjs](core/circuit-breaker.mjs) добавлены `detectSemanticOscillation` и 5-строчная карточка чистого перезапуска `buildCleanRestartOverlay`; в [core/bayesian-router.mjs](core/bayesian-router.mjs) добавлены метрики `firstPassRate` и `expectedTurnsEstimate`; в [core/pitfall-ledger.mjs](core/pitfall-ledger.mjs) добавлен `recordContrastiveLesson`.
- **Бенчмарк экономии токенов и унификация CLI `--output`**:
  - Создан [scripts/benchmark-token-roi.mjs](scripts/benchmark-token-roi.mjs) (`npm run benchmark:roi`) и набор тестов [tests/v321-sota.test.mjs](tests/v321-sota.test.mjs); добавлена поддержка `--output`/`-o` (чистый UTF-8) в CLI-скрипты 4 скиллов и подсчёт `mcpSchemaTaxTokens` в [sidecars/panel/server.mjs](sidecars/panel/server.mjs).

### Исправлено
- **Авто-очистка `Pitfall Ledger` для пакетов и редиректов**: в [core/hook-runner.mjs](core/hook-runner.mjs) (`resolveTestPitfallsFromCommand`) поддержаны диагностические редиректы (`2>&1`, `| obs-masker`) и частичная очистка зелёных тестовых файлов в запусках вида `tests/*.test.mjs`; удалены 3 призрачные записи о прошедших тестах.
- **Авто-синхронизация `--max-old-space-size` в установленном `mcp_config.json`**: в [sidecars/panel/server.mjs](sidecars/panel/server.mjs) (`saveState`) добавлена синхронизация лимита памяти V8 сразу для рабочей копии и установленного плагина.

---

## [3.20.0] — 2026-11-17

### Добавлено
- **Прозрачный перехватчик CLI `RTK-Shield`**:
  - В [core/obs-masker.mjs](core/obs-masker.mjs) добавлен специализированный компрессор `compressRtkCommandOutput` (схлопывает десятки зелёных строк TAP/тест-раннеров в `[✓ RTK-Test Summary: ...]` и сжимает крупные `git diff` с сохранением статистики по файлам), а в [core/security-guard.mjs](core/security-guard.mjs) добавлены барьеры против безлимитного `git log -p/--patch` и прямого чтения тяжёлых lock-файлов без фильтрации.
- **Символьная навигация и хирургия `Serena-Lite AST Ops`**:
  - В `ram_slice` ([core/ram-memory-engine.mjs](core/ram-memory-engine.mjs), [core/ram-memory-mcp.mjs](core/ram-memory-mcp.mjs)) добавлен параметр `callGraph: true` для извлечения полного тела целевой функции + 1-hop вызывающих и вызываемых символов из графа `RepoGraph`.
  - В [core/diff-patcher.mjs](core/diff-patcher.mjs) реализованы `computeSymbolReplacement` и `applySymbolReplacement` с атомарной заменой тела символа по границам AST и проверкой синтаксиса в ОЗУ; команда `patch-symbol` подключена в [core/ag-cli.mjs](core/ag-cli.mjs) и [core/router-cli.mjs](core/router-cli.mjs).
- **Фазовое бюджетирование контекста `SWE-Pruner`**:
  - В [core/ram-memory-engine.mjs](core/ram-memory-engine.mjs) и [core/ram-memory-mcp.mjs](core/ram-memory-mcp.mjs) добавлен детектор фазы задачи (`inferContextPruningPhase`: `explore | edit | debug`) с адаптацией `ram_context_pack` (AST-скелет при исследовании и data-flow срез `Program Slicer` при отладке).
- **Табличная сериализация `TOON` (`-35..60%` токенов)**:
  - Создан модуль [core/toon-formatter.mjs](core/toon-formatter.mjs) (`encodeToonTable`, `crushJsonArrayToToon`, `formatRepoMapToon`) с поддержкой опции `format: 'toon'` в [core/cpu-log-json-compressor.mjs](core/cpu-log-json-compressor.mjs) и режима `toon: true` в `getFastRepoMap` / `ram_context_pack`.
- **Двуязычный словарь `RU-EN` на 260+ IT-корней и `Voice/RU Prompt Pivot`**:
  - Создан [core/ru-en-lexicon.mjs](core/ru-en-lexicon.mjs) (`O(1)` префиксный индекс без VRAM), интегрированный в [core/cpu-reranker.mjs](core/cpu-reranker.mjs) и [core/ram-memory-engine.mjs](core/ram-memory-engine.mjs) (`search`).
  - В [core/tool-pruner.mjs](core/tool-pruner.mjs) и [core/hook-runner.mjs](core/hook-runner.mjs) добавлен `compileVoiceOrLongRuPromptPivot` для сжатия длинных разговорных/голосовых русских промптов в компактный английский бриф.
- **Пост-редакторный ревизор диффов (`Post-Edit Critic`)**:
  - В [core/local-gpu-engine.mjs](core/local-gpu-engine.mjs), [core/hook-runner.mjs](core/hook-runner.mjs) и настройках (`gpuPostEditCritic`) добавлены сверхбыстрый CPU-детектор необъявленных идентификаторов (`scanAddedIdentifiersForRefBugs`) и опциональная проверка добавленных строк на локальной GPU `gemma4:12b` (`critiqueEditedDiffLocally`).
- **Щит префиксного кэша и 4-компонентный счётчик экономии токенов в пульте**:
  - В [sidecars/panel/server.mjs](sidecars/panel/server.mjs) и [sidecars/panel/ui.html](sidecars/panel/ui.html) добавлена разбивка сэкономленных токенов (`⚡ Кэш`, `🧠 RAM`, `⚙️ CPU`, `🎮 GPU`), бейдж попаданий в Implicit Cache (`Кэш: X%`) и переключатель `chk-gpuPostEditCritic`; в [core/hook-runner.mjs](core/hook-runner.mjs) добавлена нормализация `\n` в `buildCacheAlignedInjection`.

### Исправлено
- **Авто-очистка `Pitfall Ledger` при прохождении тестов**: в [core/hook-runner.mjs](core/hook-runner.mjs) (`resolveTestPitfallsFromCommand`) исправлено ложное срабатывание `TEST_OUTPUT_FAIL_RE` на зелёных строках `✔` с текстом `AssertionError` или знаком `×`, а также снятие записей об ошибках тестов, привязанных к файлам реализации.

---

## [3.19.0] — 2026-11-17

### Добавлено
- **Оптическая live-телеметрия CPU-пула и единый блок лимитов ресурсов**:
  - В [core/cpu-worker-pool.mjs](core/cpu-worker-pool.mjs) добавлен межпроцессный трекер `cpu-live-activity.json` (`beginCpuLiveWork`, `endCpuLiveWork`, `recordCpuInstantWork`, `getCpuLiveActivity`) с послесвечением `2.8 с` и интеграцией в параллельную верификацию ([core/auto-verifier.mjs](core/auto-verifier.mjs)), реранкер ([core/cpu-reranker.mjs](core/cpu-reranker.mjs)) и минимизатор `ddmin` ([skills/delta-bug-minimizer/scripts/ddmin-runner.mjs](skills/delta-bug-minimizer/scripts/ddmin-runner.mjs)).
  - В [sidecars/panel/ui.html](sidecars/panel/ui.html) добавлены верхняя live-капсула `topCpuLivePill`, оптическая карточка `cpuLiveUnitCard` («Потоки CPU») с сегментной шкалой для обеих тем (`glass_teal` и `studio_titanium`), а переключатель `cpuMaxThreads` перенесён в единый блок с лимитами In-RAM и VRAM.
- **Автовыгрузка VRAM при выходе из Antigravity (`gpuUnloadOnExit`)**:
  - В [core/ram-memory-mcp.mjs](core/ram-memory-mcp.mjs) (`handleMcpDaemonExit`) и [sidecars/panel/server.mjs](sidecars/panel/server.mjs) (`handleSidecarExitCleanup`, `hasLiveRamDaemon`) реализована автоматическая выгрузка моделей Ollama при завершении последнего активного процесса Antigravity.
- **Сохранение свёрнутых карточек и спойлеров пульта**:
  - В [sidecars/panel/server.mjs](sidecars/panel/server.mjs) и [router-state.json](router-state.json) добавлены персистентные карты `panelCollapsedCards` и `panelOpenSpoilers` с валидацией `sanitizeBooleanIdMap`.
- **Справка `--help` / `-h` для CLI-скриптов навыков**:
  - Добавлен стандартный вывод `--help` в `run-codemod.mjs`, `run-stress-audit.mjs`, `slice-variable.mjs`, `build-showroom.mjs` и `fetch-web-refs.mjs`.

### Изменено
- **Жизненный цикл воркеров нативного Роя (`Swarm`) и `worktrees`**:
  - В [core/model-profile.mjs](core/model-profile.mjs), [core/task-progress.mjs](core/task-progress.mjs), [core/swarm-controller.mjs](core/swarm-controller.mjs) и [core/hook-runner.mjs](core/hook-runner.mjs) добавлено автораспознавание воркеров по брифу доски (`recorded on the board as #N for @name`), ролям `narrator` / `stall monitor`, системным wakeup-сообщениям доски (`isBoardWakeup`) и путям `worktrees/<parentCid>/<branch>` (`parseAntigravityWorktreePath`), корректный переход уснувших на `swarm_wait` и остановленных воркеров в `completed (100%)`, защита от `[object Object]` в `matchedFiles`, а также режимы `auto_all` / `always_ask` и авто-тиринг (`hydrogen_auto` / `argon_auto` / `carbon_auto`).
- **Адаптивные лимиты памяти до 32 ГБ и живая индексация**:
  - В [core/ram-memory-engine.mjs](core/ram-memory-engine.mjs), [core/ram-memory-mcp.mjs](core/ram-memory-mcp.mjs) и [core/local-gpu-engine.mjs](core/local-gpu-engine.mjs) расширен потолок In-RAM и VRAM-контекста до `32 ГБ`, добавлены дедупликация прогрева векторов `warmWorkspaceVectorsOnce`, коллбэк `onFileUpsert` и файловая блокировка с retry при атомарной записи `i8bin-v2`.
- **Аналитические модальные вопросы (`READ_ONLY_MODAL`) и защита воркеров/реранкера**:
  - В [core/tool-pruner.mjs](core/tool-pruner.mjs) добавлено распознавание аналитических вопросов без лишнего `ask_question` (`isModalAnalyticalQuestion`), в [core/cpu-worker-pool.mjs](core/cpu-worker-pool.mjs) — очистка опасных V8/CLI-флагов (`getSafeWorkerExecArgv`), а в [core/cpu-reranker.mjs](core/cpu-reranker.mjs) — проверка границ слов для коротких токенов (`<=3` символов).

---

## [3.18.0] — 2026-11-15

### Добавлено
- **Семантический векторный индекс навыков (`qwen3-embedding:0.6b` + `gemma4:12b`)**:
  - В [core/skill-crystallizer.mjs](core/skill-crystallizer.mjs), [core/local-gpu-engine.mjs](core/local-gpu-engine.mjs) и [core/tool-pruner.mjs](core/tool-pruner.mjs) реализован двухэтапный ИИ-подбор навыков `matchSkillsAi` с контрастивными якорями `__none__`, удалением жёсткого словаря `SKILL_DOMAIN_KEYWORDS` и семантической дистилляцией уроков.
- **Оптическая live-телеметрия ОЗУ и GPU**:
  - Разделены тихое дежурство в памяти и реальные вычисления (`classifyOllamaWorkRequest`, `RamMemoryEngine.liveActivity`), добавлены плавное 3-секундное послесвечение и интегрированные индикаторы экономии токенов для обеих тем оформления (`glass_teal` и `studio_titanium`).
- **Селектор локальных моделей GPU и прямой поиск моделей в чате**:
  - В пульт добавлены выпадающие списки `sel-gpuChatModel` / `sel-gpuEmbedModel` и прямая отправка диагностического запроса `model_search_prompt` (`buildAiModelSearchPrompt`) в чат без промежуточного модального окна ([core/hardware-profiler.mjs](core/hardware-profiler.mjs), [sidecars/panel/server.mjs](sidecars/panel/server.mjs), [sidecars/panel/ui.html](sidecars/panel/ui.html)).

### Изменено
- **Post-Scout ИИ-триаж и фильтрация заголовков UI**:
  - Очистка названий карточек интерфейса в `stripUiTitlesForIntentClassification`, приоритет вердикта ИИ после чтения реального кода (`XL → M`), двусторонняя проверка соответствия селектора и пред-оценка в нулевой плашке ([core/tool-pruner.mjs](core/tool-pruner.mjs), [core/hook-runner.mjs](core/hook-runner.mjs), [rules/AGENTS.md](rules/AGENTS.md)).
- **Авто-снятие исправленных сбоев тестов в `Pitfall Ledger`**:
  - Функция `resolveTestPitfallsFromCommand` и хук `PostToolUse` автоматически очищают устаревшие записи `test_failure` после успешного прогона тестов.
- **Укрепление конвейера релизов и версионирования**:
  - Закрыт риск ReDoS в `SEMVER_RE` и расширен список синхронизируемых файлов (`README.md`, `assets/banner.svg`, `SKILL.md`) в [scripts/bump-version.mjs](scripts/bump-version.mjs), добавлена автоочистка старых сборок в [scripts/pack-release.mjs](scripts/pack-release.mjs) и расширен контроль дрейфа `DRIFT_CHECK_FILES`.

---

## [3.17.0] — 2026-11-15

### Добавлено
- **Независимый верификатор и жизненный цикл `Stop`**:
  - Добавлен read-only субагент [router-verifier.md](agents/router-verifier.md) для независимой проверки правок, тестов и аудит-барьеров на этапах `L`/`XL` и внутри Роя (`Swarm`).
  - Добавлена подписка на хук `Stop` в [hooks.json](hooks.json) для гарантированной финализации прогресса задач.
- **Хук `PreInvocation` и защита от дрейфа установленного плагина**:
  - Zero-token плашка статуса `buildZeroTokenUserBadgeStep` (`user_markdown`) и проверка синхронности исходников с установленной копией `checkInstalledPluginDrift` в [core/hook-runner.mjs](core/hook-runner.mjs).
- **Сквозная система версионирования**:
  - Скрипт синхронной проверки и обновления версий [scripts/bump-version.mjs](scripts/bump-version.mjs) (`npm run version:check`, `version:patch`, `version:minor`) и модульные тесты [tests/version-sync.test.mjs](tests/version-sync.test.mjs).
- **Документация и переименование продукта**:
  - Продукт переименован в **The Tunnel** (`The Tunnel · Диспетчер моделей ИИ`) с сохранением внутреннего технического ID пакета `antigravity-model-router` для полной совместимости кэшей, MCP и настроек.
  - Создан полный [CHANGELOG.md](CHANGELOG.md), включённый в поставку релиза.

### Изменено
- **Стабильная шкала прогресса до 30 этапов**: расширен лимит шагов таймлайна до `30` в [core/task-progress.mjs](core/task-progress.mjs) и [sidecars/panel/ui.html](sidecars/panel/ui.html), устранены откаты процентов (`100% → 0% → 16%`) при передаче плана между планировщиком и исполнителем `Orchestrator (Carbon)` через `exit_plan_mode`.
- **Точность диагностики и фильтрация ложных срабатываний**: `formatCompactProcessError` и `runImpactedMicroTests` в [core/auto-verifier.mjs](core/auto-verifier.mjs) отфильтровывают успешные строки TAP/`node:test` (`✔`, `✓`, `ok N`), а `recordPitfall` в [core/pitfall-ledger.mjs](core/pitfall-ledger.mjs) игнорирует ложноположительные сводки.
- **Устойчивость к ReDoS**: устранены потенциальные ReDoS-паттерны в `extractPrimarySymbolFromSnippet` и `formatCommandStepLabel` ([core/task-progress.mjs](core/task-progress.mjs)).

---

## [3.16.0] — 2026-11-14

### Добавлено
- **Мета-скилл `skill-architect` и локальный линтер навыков**:
  - Добавлен 11-й встроенный навык [skills/skill-architect/SKILL.md](skills/skill-architect/SKILL.md) (прогрессивное раскрытие *Progressive Disclosure 2.0*, защита от *Negative Transfer*, регламент *Merge-Over-Create*).
  - Добавлен детерминированный аудитор и бенчмарк триггеров [skills/skill-architect/scripts/audit-skill.mjs](skills/skill-architect/scripts/audit-skill.mjs) (`npm run lint:skills`) — все 11 встроенных навыков доведены до оценки `100/100 (Grade A)`.
  - Обновлён движок автокристаллизации [core/skill-crystallizer.mjs](core/skill-crystallizer.mjs) (v2, *EvoSkill* дистилляция ошибок).
- **Zero-LLM конвейер веб-референсов**:
  - Добавлен скрипт [skills/ui-ux-design-system/scripts/fetch-web-refs.mjs](skills/ui-ux-design-system/scripts/fetch-web-refs.mjs) для прямого извлечения CSS/дизайн-токенов, `og:image` и карточек превью без запуска тяжёлого браузерного субагента и траты облачных токенов.

---

## [3.15.0] — 2026-11-14

### Добавлено
- **Монотонная мульти-чатовая машина прогресса**:
  - Новый модуль [core/task-progress.mjs](core/task-progress.mjs) с монотонной шкалой (`MAX_RUNNING_PERCENT = 92`), потолком `<= 35%` до начала правок кода (`hasCodeEdits`) и 3-уровневым синтезом компактных технических этапов из `exit_plan_mode` и AST/команд.
  - Иерархическая вложенность субагентов и воркеров Роя (`inspectSubagentTranscriptMeta` до `64 КБ` в [core/model-profile.mjs](core/model-profile.mjs)) с дедупликацией `cid__wsHash` и группировкой чатов по реально активным проектам (`.ag-project-group`).
- **Изоляция параллельных окон в RAM MCP**:
  - В [core/ram-memory-mcp.mjs](core/ram-memory-mcp.mjs) добавлена привязка воркспейса окна при `initialize` (`extractClientRootFromInitialize`) и разрешение относительных путей по активным проектам.
- **Точный учёт VRAM Ollama и опциональный Floating HUD**:
  - В [core/local-gpu-engine.mjs](core/local-gpu-engine.mjs) реализована сверка `reconcileLoadedModelsVram` для корректного отображения реальной занятости VRAM мультимодальных сборок вроде `gemma4:12b`.
  - Добавлен модуль [core/floating-hud.mjs](core/floating-hud.mjs) (отключён по умолчанию флагом `floatingHudEnabled: false`).

### Изменено
- **Две выверенные темы оформления**: в [sidecars/panel/ui.html](sidecars/panel/ui.html) и [sidecars/panel/server.mjs](sidecars/panel/server.mjs) оставлены тёмная тема **«Жидкое стекло iOS»** (`glass_teal`) и доработанная светлая тема **«Персиковый фарфор»** (`studio_titanium`); удалены лишние промежуточные темы.
- **Экспертные параметры и русификация**: панель расширена с `12` до `20` контуров защиты (`22` контура + `14` аппаратных/роевых флагов = `36` ключей в `GUARDRAIL_KEYS`), переведены все 47 карточек встроенных навыков.

---

## [3.14.0] — 2026-11-14

### Добавлено
- **Универсальный полиглот-аудитор SOTA 2026 (`deep-stress-auditor`)**:
  - Полная отвязка от внутренних символов плагина и переработка в `zero-config` полиглот-движок на 7 модулей (`stack-detector`, `file-worker-tasks`, `graph-and-contracts`, `sandbox-fuzzer`, `fuzz-worker`, `native-runners`, `report-formatter`) в [skills/deep-stress-auditor/scripts/](skills/deep-stress-auditor/scripts/).
  - Двухконтурная матрица анализа `T1–T6` (JS/TS, Python, Go, Rust, C/C++, HTML, конфиги), CWE Source→Sink, ReDoS, гонки/утечки, контракты UI-API и песочный фаззинг с `ddmin`.
  - Выделен отдельный набор тестов [tests/deep-stress-auditor.test.mjs](tests/deep-stress-auditor.test.mjs).

---

## [3.13.0] — 2026-11-14

### Добавлено
- **3D-матрица триажа (`Ширина × Глубина × Риск`)**:
  - Функции `computeTask3DMatrix` и `buildAdaptive3DOptionsBlueprint` в [core/tool-pruner.mjs](core/tool-pruner.mjs) и [core/model-profile.mjs](core/model-profile.mjs) с эскалацией `Critical-Blast` для хрупких узлов и `reverseDeps >= 4`.
  - Анти-шаблонный фильтр `evaluateAskQuestionSelectorGuard` в [core/hook-runner.mjs](core/hook-runner.mjs) и поддержка непрерывного `[plan review]` оркестратора.
- **Live-обновление телеметрии**: лёгкий эндпоинт `GET /api/telemetry` и последовательный опрос каждые `2.8 с` с автопаузой при скрытой вкладке.

---

## [3.12.0] — 2026-11-14

### Добавлено
- **Конвейер релизной сборки ([scripts/pack-release.mjs](scripts/pack-release.mjs))**:
  - Компиляция автономного Windows-установщика `*-Setup.exe` (C# WinForms GUI + тихий режим `--silent` / `/S` + `--uninstall` + встроенный `.ico` и payload).
  - Генерация портативного UTF-8 `ZIP`, `SHA256SUMS.txt`, `release-manifest.json`, а также скриптов [install.bat](install.bat), [install.sh](install.sh), [Установить плагин.bat](Установить%20плагин.bat) и автогенерация `Удалить плагин.bat`.

---

## [3.11.0] — 2026-11-14

### Изменено
- **Редизайн пульта в эстетике iOS 26 Liquid Glass**:
  - Полный отказ от визуального стиля Windows 95 (`MODEL_ROUTER.EXE`, `SETUP_WIZARD.EXE`, `.win95-glass-window`).
  - Внедрены стеклянные карточки (`backdrop-filter: blur`), спекулярные контуры и парящая навигационная капсула со скользящим индикатором.
  - Удалены устаревший переключатель и ключ `workerModel` (`Flash 3.8`), выполнена автомиграция в [install.js](install.js).
  - Переход с телеметрии «одного активного чата» на инкрементальную сводную статистику экономии по всем диалогам.

---

## [3.10.0] — 2026-11-14

### Добавлено
- **Гибкий `UI/UX Preview Gate` (`uiInspirationMode`)**:
  - Выбор стратегии вдохновения (`ask | showroom | web_refs`) через пульт и [rules/AGENTS.md](rules/AGENTS.md), генератор интерактивной витрины A/B/C [skills/ui-ux-design-system/scripts/build-showroom.mjs](skills/ui-ux-design-system/scripts/build-showroom.mjs).
- **GPU Boost**:
  - Раздельное удержание эмбеддера в VRAM (`gpuEmbedKeepAlive: "90m"`), фоновый прогрев и zero-token дистилляция локальных файлов `@file:<path>` в [core/local-gpu-engine.mjs](core/local-gpu-engine.mjs).

---

## [3.9.0] — 2026-11-14

### Добавлено
- **Кросс-платформенный автопрофайлер оборудования ([core/hardware-profiler.mjs](core/hardware-profiler.mjs))**:
  - Автоматическое определение CPU (`Intel` / `AMD` / `Apple` / `ARM`), объёма ОЗУ (`1–12 ГБ` безопасного буфера), видеокарты (NVIDIA / AMD / Intel / Apple) и тарифа подписки при первом запуске и установке.
- **Укрепление безопасности и изоляции (5 фаз)**:
  - Защита CSP/Origin сайдкара и `window.sidecar.fetch`, межпроцессные файловые замки JSON ([core/safe-json.mjs](core/safe-json.mjs)), POSIX/ADS/Win32-фильтры путей ([core/security-guard.mjs](core/security-guard.mjs)), сессионная изоляция [core/circuit-breaker.mjs](core/circuit-breaker.mjs) и [core/shadow-guard.mjs](core/shadow-guard.mjs).

---

## [3.8.0] — 2026-11-14

### Добавлено
- **Многопоточный CPU-сопроцессор и Cross-Reranker**:
  - Пул `node:worker_threads` с авто-масштабированием и idle `unref()` ([core/cpu-worker-pool.mjs](core/cpu-worker-pool.mjs)).
  - Триграммный инвертированный индекс + `BM25F` и Zero-VRAM CPU Cross-Reranker (`< 15 мс`) в [core/cpu-reranker.mjs](core/cpu-reranker.mjs).
  - Параллельный запуск микро-тестов и бинарного минимизатора багов `ddmin` ([skills/delta-bug-minimizer/scripts/ddmin-runner.mjs](skills/delta-bug-minimizer/scripts/ddmin-runner.mjs)).

---

## [1.0.0 – 3.7.0] — 2026-11-04 .. 2026-11-14

### Основные вехи ранних поколений
- **v3.0 – v3.7**: Personalized PageRank (`d=0.50`) и `[Zero-Turn Gold Context]`, адаптивная байесовская маршрутизация v2 с 14-дневным полураспадом и матрицей хрупкости `fragileFiles`, In-RAM MCP сервер (`ram-memory-mcp.mjs`, до 12 ГБ), квантованный локальный GPU-поиск `i8bin-v2` (Ollama `qwen3-embedding:0.6b` + `gemma4:12b`), поддержка линейки Gemini 4 (`Hydrogen`, `Carbon`, `Argon`, `Orchestrator`) и нативного командного Роя (`core/swarm-controller.mjs`).
- **v2.0 – v2.5**: однопроходная AST-карта `RepoMap`, Function X-Ray, транзакционные патчи и теневые чекпоинты (`Shadow Guard`), `Circuit Breaker`, компакция истории и эпизодическая память ошибок (`Pitfall Ledger`).
- **v1.0 – v1.2**: первоначальный релиз плагина, базовые хуки маршрутизации и пульт `Glass 95` (`sidecars/panel`).

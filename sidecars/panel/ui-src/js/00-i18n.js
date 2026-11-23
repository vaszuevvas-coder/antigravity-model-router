    // =========================================================================
    // 00. LOCALIZATION ENGINE (EN / RU) — Zero-dependency live DOM & JS i18n
    // =========================================================================
    let currentUiLanguage = 'en';
    const I18N_ORIG_TEXT = new WeakMap();
    const I18N_ORIG_ATTRS = new WeakMap();
    const I18N_ATTR_NAMES = ['title', 'placeholder', 'data-prompt', 'alt'];

    function normalizeUiLanguage(raw) {
      const s = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
      return s === 'ru' ? 'ru' : 'en';
    }

    function getUiLanguage() {
      return currentUiLanguage === 'ru' ? 'ru' : 'en';
    }

    function isRu() {
      return getUiLanguage() === 'ru';
    }

    function L(ruText, enText) {
      return isRu() ? ruText : enText;
    }

    function pickText(obj, ruKey, enKey, fallback) {
      const fb = fallback !== undefined ? fallback : '';
      if (!obj || typeof obj !== 'object') return fb;
      if (isRu()) {
        return obj[ruKey] !== undefined && obj[ruKey] !== '' ? obj[ruKey] : (obj[enKey] !== undefined && obj[enKey] !== '' ? obj[enKey] : fb);
      }
      return obj[enKey] !== undefined && obj[enKey] !== '' ? obj[enKey] : (obj[ruKey] !== undefined && obj[ruKey] !== '' ? obj[ruKey] : fb);
    }

    function Lplural(n, ruOne, ruFew, ruMany, enOne, enMany) {
      const abs = Math.abs(Math.floor(Number(n) || 0));
      if (!isRu()) {
        return abs + ' ' + (abs === 1 ? enOne : enMany);
      }
      const mod100 = abs % 100;
      const mod10 = abs % 10;
      if (mod100 >= 11 && mod100 <= 14) return abs + ' ' + ruMany;
      if (mod10 === 1) return abs + ' ' + ruOne;
      if (mod10 >= 2 && mod10 <= 4) return abs + ' ' + ruFew;
      return abs + ' ' + ruMany;
    }

    const UI_RU_TO_EN_TEXT = {
      'Все чаты · Автопилот': 'All Chats · Autopilot',
      '↺ Сброс': '↺ Reset',
      'ИИ-Пилот активен': 'AI Pilot Active',
      '· Сам анализирует контекст и подключает навыки под задачу': '· Auto-analyzes context and activates skills for your task',
      '🩺 Стек': '🩺 Stack',
      'Настройка': 'Setup',
      'Прогресс задач': 'Task Progress',
      '🔄 Авто · Проект': '🔄 Auto · Project',
      'Авто': 'Auto',
      '✕ Сброс': '✕ Clear',
      'RAM · Ожидание': 'RAM · Idle',
      'GPU · Ожидание': 'GPU · Idle',
      'CPU · Ожидание': 'CPU · Idle',
      'Ожидание задачи': 'Waiting for task',
      '✦ Умный ввод в чат': '✦ Smart Chat Composer',
      '🔥 Опрос': '🔥 Grill-Me',
      'RAM + GPU · 0 тк': 'RAM + GPU · 0 tok',
      '🐞 Сбой выполнения': '🐞 Runtime fault',
      'В Композер': 'To Composer',
      '🧭 Ревью архитектуры': '🧭 Architecture review',
      '🐞 Найти риски и баги': '🐞 Find risks & bugs',
      '📋 План доработки': '📋 Implementation plan',
      'Скриншот UI': 'UI Screenshot',
      '🔍 Разобрать UI · 0 тк': '🔍 Audit UI · 0 tok',
      'принять': 'accept',
      'контекст': 'context',
      'локально': 'local',
      'в чат': 'to chat',
      'Очистить': 'Clear',
      '✓ Коммит · 0 тк': '✓ Commit · 0 tok',
      '💬 Локально · 0 тк': '💬 Local · 0 tok',
      'В чат ↑': 'Send ↑',
      '🧠 Локальный RAG-диалог · 0 тк': '🧠 Local RAG Chat · 0 tok',
      'Очистить чат': 'Clear chat',
      'Навыки ИИ-Пилота': 'AI Pilot Skills',
      'Умный Авто-режим': 'Smart Auto Mode',
      'Все навыки по умолчанию работают в режиме': 'All skills default to',
      '«Авто»': '"Auto"',
      '— они не загружаются заранее и активируются только под профильный запрос.': '— they are not preloaded and activate only for matching requests.',
      '🔄 Все в Авто': '🔄 All to Auto',
      '🌐 Импорт': '🌐 Import',
      'Пресеты:': 'Presets:',
      '🔍 Найти в каталоге': '🔍 Search catalog',
      '🛡️ Проверить и импортировать': '🛡️ Audit & import',
      'Введите запрос для поиска навыков или адрес репозитория для карантинной проверки AgentShield.': 'Enter a search query for skills or a repository URL for AgentShield quarantine inspection.',
      'Загрузка возможностей ИИ-пилота...': 'Loading AI Pilot capabilities...',
      'Режим работы агента': 'Agent Mode',
      'Тариф подписки:': 'Subscription Tier:',
      'Подписка Pro: бережёт квоту — Hydrogen на S/M и Orchestrator (Neon) на сложных задачах.': 'Pro Tier: saves quota — Hydrogen on S/M and Orchestrator (Neon) on complex tasks.',
      'Режим Pro: скрыты настройки моделей Ultra (Carbon).': 'Pro mode: Ultra (Carbon) model settings are hidden.',
      'Интерактивный советник': 'Interactive Advisor',
      'Рекомендуется': 'Recommended',
      'Агент оценивает задачу и предлагает оптимальную связку моделей и навыков перед стартом.': 'The agent evaluates the task and proposes the optimal model & skill pairing before starting.',
      'Спрашивать в чате:': 'Confirm in chat:',
      'Всегда': 'Always',
      'От M+': 'From M+',
      'Только L/XL': 'L/XL only',
      'Умная связка Orchestrator': 'Smart Orchestrator Synergy',
      '— без лишних опросов на': '— skips extra prompts on',
      'Детальный опрос (Grill-Me):': 'Deep Interview (Grill-Me):',
      'Выкл': 'Off',
      'Авто M+': 'Auto M+',
      'Режим «Авто M+»: предлагает детальный опрос по развилкам в стартовом окне на крупных или новых задачах.': '"Auto M+" mode: offers a decision-tree interview in the Pre-Task Gate for large or ambiguous tasks.',
      'Тихий автопилот': 'Silent Autopilot',
      'Без вопросов': 'No prompts',
      'Агент сразу выполняет задачу по выбранному шаблону без промежуточных подтверждений.': 'The agent executes immediately using the chosen preset without confirmation prompts.',
      'Шаблон:': 'Preset:',
      'Авто-баланс': 'Auto-Balance',
      'Порог Neon:': 'Neon threshold:',
      'Дизайн-витрина и превью UI': 'Design Showroom & UI Preview',
      '🎨 Превью дизайна и анимаций (A/B/C)': '🎨 Design & Animation Preview (A/B/C)',
      'Показывать': 'Show',
      'Сразу в код': 'Direct to code',
      'Перед обновлением UI агент уточняет визуальное направление и готовит 3 интерактивных примера.': 'Before editing UI, the agent clarifies visual direction and prepares 3 interactive prototypes.',
      '🌐 Источник вдохновения': '🌐 Inspiration Source',
      'Спрашивать': 'Ask',
      'Витрина A/B/C': 'A/B/C Showroom',
      'Веб-рефы': 'Web Refs',
      'Режим «Спрашивать»: выбор между 3 прототипами A/B/C, поиском примеров в сети и гибридом.': '"Ask" mode: choose between 3 A/B/C prototypes, live web reference search, or a hybrid.',
      '📊 Статистика чатов и Командный Рой': '📊 Chat Telemetry & Agent Swarm',
      'Кэш: 0%': 'Cache: 0%',
      'Авто XL': 'Auto XL',
      'Сэкономлено всего': 'Total Saved',
      '~0 ток.': '~0 tok',
      '⚡ Кэш': '⚡ Cache',
      'Рой в дежурном режиме': 'Swarm on standby',
      'На S/M/L работает Hydrogen · На XL (4+ модулей) включается параллельный Рой': 'Hydrogen handles S/M/L · Parallel Swarm activates on XL (4+ modules)',
      'Когда включать Рой:': 'When to enable Swarm:',
      'Авто все': 'Auto All',
      'По /swarm': 'On /swarm',
      'Модель воркеров:': 'Worker model:',
      'Как в чате': 'Same as chat',
      'Авто-Ревизор (': 'Auto-Verifier (',
      '— проверка диффов и тестов': '— verifies diffs and tests',
      'Страховка квоты': 'Quota Failover',
      '— авто-пересадка воркера без сброса памяти': '— auto-switches worker model without losing context',
      'Текущий чат: ожидание первого хода · Авто-перенос контекста в новый чат активен': 'Current chat: awaiting first turn · Auto-handoff to new chats is active',
      'Квота: спокойно': 'Quota: calm',
      'Маршрут страховки (Combo): готов': 'Failover route (Combo): ready',
      'Сбросить паузы': 'Reset cooldowns',
      '🎮 Ресурсы ПК: GPU, CPU и память In-RAM': '🎮 PC Resources: GPU, CPU & In-RAM Cache',
      '🧠 Память In-RAM': '🧠 In-RAM Memory',
      '⚪ Ожидание': '⚪ Idle',
      '0 / 4096 МБ': '0 / 4096 MB',
      'Готов к прогреву проекта': 'Ready to warm workspace',
      '🎮 Видеомодель GPU': '🎮 Local GPU Model',
      '⚪ Проверка': '⚪ Checking',
      '0.0 / 4 ГБ': '0.0 / 4 GB',
      'Ожидание данных Ollama': 'Waiting for Ollama data',
      '⚙️ Потоки CPU': '⚙️ CPU Threads',
      '0 / 12 потоков': '0 / 12 threads',
      '0 тригр.': '0 trigrams',
      'Дежурит в пуле · внутренних задач сейчас нет': 'Standing by in pool · no background tasks',
      '🔍 Калибровка': '🔍 Calibrate',
      '✨ Подбор в чате': '✨ Tune in chat',
      '🚀 Индекс': '🚀 Index',
      '🔌 Тест GPU': '🔌 Test GPU',
      '🧹 Сброс VRAM': '🧹 Free VRAM',
      '💬 Чат / сжатие': '💬 Chat / distill',
      '🧭 Поиск (Embed)': '🧭 Search (Embed)',
      '🔎 Поиск моделей': '🔎 Find models',
      'Векторный индекс: ожидание прогрева': 'Vector index: awaiting warmup',
      '⬇️ Каскад моделей': '⬇️ Model Cascade',
      '⬇️ Загрузка каскада моделей...': '⬇️ Downloading model cascade...',
      '✕ Отмена': '✕ Cancel',
      'Подготовка загрузки...': 'Preparing download...',
      '⚠️ Нет подходящей модели для выбранного лимита VRAM': '⚠️ No compatible model for the selected VRAM limit',
      '⬇️ Скачать каскад под все лимиты': '⬇️ Download cascade for all limits',
      '💬 Подобрать в чате': '💬 Pick in chat',
      'Лимит VRAM:': 'VRAM Limit:',
      '4 ГБ': '4 GB',
      '6 ГБ': '6 GB',
      '8 ГБ': '8 GB',
      '12 ГБ': '12 GB',
      '14 ГБ': '14 GB',
      '16 ГБ': '16 GB',
      '24 ГБ': '24 GB',
      '32 ГБ': '32 GB',
      'Лимит In-RAM:': 'In-RAM Limit:',
      '1 ГБ': '1 GB',
      '2 ГБ': '2 GB',
      'Потоки CPU-пула:': 'CPU Pool Threads:',
      'Включить GPU': 'Enable GPU',
      '— локальный помощник на видеокарте': '— local GPU copilot via Ollama',
      'Поиск по смыслу': 'Semantic Search',
      '— находит код по описанию': '— finds code by natural description',
      'Сжатие логов': 'Log Distillation',
      '— локальная выжимка длинных ошибок': '— local summary of long error traces',
      'Ревизор правок': 'Post-Edit Critic',
      '— ловит забытые переменные и баги в диффах': '— catches forgotten variables and diff bugs',
      'Пул потоков CPU': 'CPU Worker Pool',
      '— параллельный разбор AST и чанков': '— parallel AST parsing & chunking',
      'Триграммы + BM25F': 'Trigrams + BM25F',
      '— мгновенный индекс поиска в RAM': '— instant in-RAM search index',
      '— умный локальный отбор совпадений (<15 мс)': '— fast local match reranking (<15 ms)',
      'Параллельная проверка': 'Parallel Verify',
      '— быстрые микро-тесты и ddmin': '— fast micro-tests and ddmin',
      'Граф PPR, SBFL и Bitap-исцеление': 'PPR Graph, SBFL & Bitap Healing',
      '— скрытые пары Git, локализация багов Ochiai и проверка арности': '— hidden Git co-change pairs, Ochiai fault localization & arity checks',
      'SOTA-ускорители ОЗУ (Zero-Copy + RepairKV)': 'RAM SOTA Engines (Zero-Copy + RepairKV)',
      '— общая память SharedArrayBuffer, мемоизация ACON и префетч': '— SharedArrayBuffer zero-copy, ACON memoization & prefetch',
      'Прогрев моделей в DDR5 ОЗУ': 'Warm GGUF Models in Host RAM',
      '— держит веса GGUF в свободной RAM для мгновенного старта GPU': '— keeps GGUF weights warm in free RAM for instant GPU startup',
      '🛡️ Фоновый Дозор · P0 Auto-Yield': '🛡️ Background Sentinel · P0 Auto-Yield',
      'Ожидание простоя': 'Waiting for idle',
      'Тихая проверка контрактов, паспортов и git diff в паузах': 'Silent checks for contracts, symbol passports & git diff during idle pauses',
      'Проверить сейчас': 'Check now',
      'Сброс': 'Reset',
      'Контракты (CPU)': 'Contracts (CPU)',
      'Чисто': 'Clean',
      'Паспорта (GPU)': 'Passports (GPU)',
      'Локальный BugBot': 'Local BugBot',
      'Упреждение / P0': 'Prefetch / P0',
      'Префетч: 0 · Уступок: 0': 'Prefetch: 0 · Yields: 0',
      'Фоновый Дозор (Idle Sentinel)': 'Background Sentinel (Idle)',
      '— индексация и проверка в паузах с мгновенным P0-вытеснением': '— idle indexing & checks with instant P0 preemption',
      'Теневой Дозор (CPU + RAM)': 'Shadow Guard (CPU + RAM)',
      '— контракты аргументов, импорты, пары Git Co-Change и клоны SimHash': '— argument contracts, imports, Git co-change & SimHash clones',
      'Локальный BugBot (GPU)': 'Local BugBot (GPU)',
      '— тихое ИИ-ревью': '— silent AI review of',
      'в глубоком простое': 'during deep idle',
      'Семантические паспорта модулей': 'Semantic Module Passports',
      '— карточки смысла по SHA-256 для точного поиска': '— SHA-256 summary cards for accurate search',
      'Упреждающий прогрев контекста': 'Speculative Context Warmup',
      '— сборка срезов пока вы печатаете в Композере': '— pre-slices context while you type in Composer',
      'Фоновые микро-тесты (песочница)': 'Background Micro-Tests (Sandbox)',
      '— автопрогон только в длинной паузе (по умолч. выкл)': '— auto-runs only during long idle (off by default)',
      'Живой LSP-мост (Типы <50 мс)': 'Live LSP Bridge (Types <50 ms)',
      '— мгновенная диагностика TS/Python/Go/Rust и поиск ссылок': '— instant TS/Python/Go/Rust diagnostics & references',
      '🛡️ Снимки отката, Самообучение и Bayesian v2': '🛡️ Rollback Snapshots, Self-Learning & Bayesian v2',
      'Снимки и откат правок': 'Edit Snapshots & Rollback',
      'По ходам': 'By turns',
      'По файлам': 'By files',
      '↶ Откатить ход': '↶ Rollback turn',
      '↶ Файл': '↶ File',
      'Снимки файлов создаются автоматически перед правками': 'File snapshots are created automatically before edits',
      '🌿 Git-песочница (Worktree)': '🌿 Git Sandbox (Worktree)',
      '+ Песочница': '+ Sandbox',
      'Изолированных песочниц не создано': 'No isolated sandboxes created',
      'Интеллект и самообучение': 'Intelligence & Self-Learning',
      'Активно ✓': 'Active ✓',
      'Глубокое мышление без урезания и разведка файлов активны': 'Unthrottled deep thinking and file scouting are active',
      'Память диалога: в норме · Зацикливаний: нет': 'Dialog memory: nominal · Loops: none',
      '🎯 Bayesian v2 · Хрупкость файлов': '🎯 Bayesian v2 · File Fragility',
      'Доверие: —': 'Confidence: —',
      '↺ Хрупкость': '↺ Fragility',
      '↺ Сбросить': '↺ Reset',
      'Домены: нет накопленных запусков': 'Domains: no recorded runs yet',
      '⚙️ Экспертные параметры (59 контуров защиты и диагностика)': '⚙️ Expert Settings (59 Guardrails & Diagnostics)',
      'НОРМА (0/3)': 'OK (0/3)',
      'Сбросить': 'Reset',
      'Автомат замкнут. Защита от зацикливания правок активна.': 'Circuit closed. Edit-loop protection is active.',
      'Реестр граблей (Pitfall Ledger)': 'Pitfall Ledger',
      'Пока нет зафиксированных сбоев/откатов': 'No recorded failures or rollbacks yet',
      'Рецепты побед и Кросс-репо (SQLite)': 'Win Recipes & Cross-Repo (SQLite)',
      '0 рец.': '0 rec.',
      'Эпизоды': 'Episodes',
      'NVMe-память (': 'NVMe Memory (',
      '— персистентный RepairKV, рецепты побед и кросс-репо поиск': '— persistent RepairKV, win recipes & cross-repo search',
      'Эпизоды: 0 · CCR-блобы: 0 · RepairKV: 0 · Инстинкты: 0': 'Episodes: 0 · CCR blobs: 0 · RepairKV: 0 · Instincts: 0',
      'Пока нет сохранённых рецептов побед': 'No saved win recipes yet',
      'Связать': 'Link',
      '26 контуров разведки и защиты': '26 Scout & Guardrail Contours',
      'Профиль хуков (': 'Hook Profile (',
      'Лёгкий': 'Minimal',
      'Стандарт': 'Standard',
      'Строгий': 'Strict',
      'Профиль «Стандарт»: действуют ваши индивидуальные переключатели контуров.': '"Standard" profile: uses your individual contour toggles below.',
      '🧭 Разведка и память проекта': '🧭 Codebase Scouting & Memory',
      'Умная карта проекта': 'Smart Repo Map',
      ') — граф символов и связей': ') — symbol & dependency graph',
      'Граф PageRank': 'PageRank Graph',
      ') — приоритет ключевых модулей': ') — prioritizes central modules',
      'Точечная нарезка кода': 'Zero-Turn Code Slicing',
      ') — AST-срезы, Call-Graph и 2-Hop контракты': ') — AST slices, call graphs & 2-hop contracts',
      'Память между чатами': 'Cross-Chat Memory',
      ') — перенос цели и контекста': ') — carries goal & context across chats',
      'Память граблей': 'Pitfall Memory',
      ') — фиксация откатов и сбоев': ') — remembers rollbacks & past failures',
      '🧠 3D-Триаж, обучение и бюджет токенов': '🧠 3D Triage, Learning & Token Budget',
      '3D-Триаж и мышление': '3D Triage & Thinking',
      'Ширина × Глубина × Риск': 'Breadth × Depth × Risk',
      ') — шкала': ') — matrix',
      'Самообучение CoDyn Bayesian v2': 'CoDyn Bayesian v2 Learning',
      ') — оценка хрупкости и 1-го прохода': ') — fragility & first-pass confidence',
      'Фильтр инструментов': 'Tool Pruner',
      ') — только нужные под задачу': ') — keeps only task-relevant tools',
      'Дедупликатор чтения': 'Read Deduplicator',
      ') — защита от повторного чтения': ') — prevents duplicate file reads',
      'Сжатие шумных логов': 'Observation Masking',
      ') — компактный вывод тестов и диффов': ') — compact test & diff output',
      'Автозащита от перегруза чата': 'Context Overflow Guard',
      ') — дайджест эпох и перенос в свежий чат': ') — epoch digest & fresh-chat handoff',
      'Заполнение контекста эпохи:': 'Epoch Context Usage:',
      'Эпоха #0 · 0% от 120k': 'Epoch #0 · 0% of 120k',
      'Порог сжатия эпохи:': 'Compaction Threshold:',
      '80k токенов': '80k tokens',
      '120k токенов (рек.)': '120k tokens (rec.)',
      '180k токенов': '180k tokens',
      '250k токенов': '250k tokens',
      '🛡️ Безопасность и верификация правок': '🛡️ Safety & Edit Verification',
      'Безопасные Diff-патчи': 'Safe Diff Patches',
      ') — точечные правки с выравниванием отступов': ') — surgical edits with indent alignment',
      'Проверка до записи': 'Pre-Write Verification',
      ') — тест синтаксиса в RAM': ') — in-RAM syntax validation',
      'Резервные снимки': 'Shadow Checkpoints',
      ') — бэкапы для мгновенного отката': ') — backups for instant rollback',
      'Изолированная Git-песочница': 'Isolated Git Sandbox',
      ') — безопасный прогон патчей в отдельной директории': ') — safe patch testing in a separate worktree',
      'Контроль связей': 'Blast Radius Guard',
      ') — анализ обратных импортов': ') — reverse-dependency impact analysis',
      'Авто-проверка синтаксиса': 'Auto Syntax Verifier',
      ') — мгновенный разбор AST/TS': ') — instant AST/TS check',
      'Каскадная проверка': 'Cascade Verification',
      ') — сигнал при повторных сбоях': ') — escalates on repeated failures',
      'Прогон затронутых тестов': 'Test-Impact Runner',
      ') — микро-тесты по связям': ') — targeted dependency micro-tests',
      'Стоп-кран зацикливания': 'Circuit Breaker',
      ') — пауза на 3 ошибках и осцилляциях': ') — pauses after 3 errors or oscillations',
      'Фаервол команд и секретов': 'Command & Secret Firewall',
      ') — защита': ') — protects',
      'Защита конфигов линтеров': 'Linter Config Protection',
      ') — запрет ослабления правил и': ') — blocks weakening rules and',
      'Перехватчик сбоев рантайма': 'Runtime Fault Wiretap',
      ') — захват ошибок процесса в Композер': ') — captures runtime errors into Composer',
      'Предиктор квоты и префикса': 'Quota & Prefix Pacer',
      ') — контроль темпа расхода за 30/60 мин': ') — tracks 30/60-min burn rate',
      'Микрофон в Умном Композере': 'Voice Input in Smart Composer',
      ', по умолч. выкл) — Web Speech + локальная очистка промпта': ', off by default) — Web Speech + local prompt cleanup',
      'Семантический Mutation Guard': 'Semantic Mutation Guard',
      ', по умолч. выкл) — проверка стойкости тестов на мутантах': ', off by default) — checks test strength against mutants',
      '🛡️ AgentShield и инстинкты проекта': '🛡️ AgentShield & Project Instincts',
      'Не проверено': 'Not checked',
      'Проверить AgentShield': 'Run AgentShield',
      'Инстинкты проекта': 'Project Instincts',
      'Аудит конфигов MCP, хуков и': 'Audits MCP configs, hooks, and',
      'на секреты и prompt-injection.': 'for secrets and prompt injection.',
      'Нажмите «Инстинкты проекта» для просмотра накопленных паттернов.': 'Click "Project Instincts" to view learned workspace patterns.',
      'Ответы и профиль': 'Responses & Profile',
      'Показывать плашку': 'Show status badge',
      '[Режим | Сложность | Исполнитель | Скиллы]': '[Mode | Scope | Executor | Skills]',
      'в ответе': 'in replies',
      'Авто-сохранение успешных паттернов (': 'Auto-save winning patterns (',
      'Контроль доведения задач и заглушек (': 'Completion & stub guard (',
      'GATES.md: не проверен': 'GATES.md: not checked',
      'Проверить': 'Check',
      'Создать GATES.md': 'Create GATES.md',
      'Резервная копия профиля:': 'Profile Backup:',
      '💾 Сохранить': '💾 Backup',
      '📂 Восстановить': '📂 Restore',
      'Контекст и карта кода:': 'Context & Repo Map:',
      '🗜️ Сжать дайджест': '🗜️ Compact Digest',
      '🗺️ Обновить карту': '🗺️ Refresh Map',
      'In-RAM кэш и локальный Ollama / GPU': 'In-RAM Cache & Local Ollama / GPU',
      'In-RAM кэш проекта': 'Project In-RAM Cache',
      ') — мгновенные срезы из памяти': ') — instant slices from memory',
      'Авто-прогрев при старте': 'Auto-warm on startup',
      'Автозапуск Ollama': 'Auto-start Ollama',
      ') — локальный сервер при обращении': ') — starts local server on demand',
      'GPU-подсказки до старта': 'Pre-task GPU hints',
      'Выгружать VRAM при выходе': 'Unload VRAM on exit',
      ') — очищать модели при закрытии Antigravity': ') — frees models when Antigravity closes',
      'Лимит In-RAM (': 'In-RAM Limit (',
      'Chat-модель (': 'Chat Model (',
      'Embed-модель (': 'Embed Model (',
      'Keep-Alive (Chat / Embed) и Контекст:': 'Keep-Alive (Chat / Embed) & Context:',
      'Папка моделей Ollama (': 'Ollama Models Folder (',
      '💾 Применить параметры Ollama / RAM': '💾 Apply Ollama / RAM Settings',
      'Готово · Синхронизировано': 'Ready · Synced',
      'Первый запуск': 'First Run',
      'Быстрая настройка': 'Quick Setup',
      '1. Железо и Тариф': '1. Language & PC',
      '2. Общение': '2. Workflow',
      '3. Стиль и UI': '3. Style & UI',
      '4. Защита и Старт': '4. Safety & Start',
      'Шаг 1 из 4 · Калибровка ПК': 'Step 1 of 4 · Language & PC Calibration',
      '← Назад': '← Back',
      'Далее →': 'Next →',
      'Позже': 'Later',
      '✓ Сохранить и начать': '✓ Save & Start',
      'Лестница лени (Ponytail):': 'Ladder of Laziness (Ponytail):',
      'Плотность ответа (Caveman):': 'Response Density (Caveman):',
      'Graphify v2 · Техдолг shortcut:': 'Graphify v2 · Shortcut Debt:',
      '🕸️ Карта графа': '🕸️ Graph Map',
      '📌 Техдолг': '📌 Tech Debt'
    };

    const UI_RU_TO_EN_ATTR = {
      'Language / Язык интерфейса': 'Interface language',
      'Русский': 'Russian',
      'Превью UI': 'UI Preview',
      'Тема пульта: Жидкое стекло iOS (Тёмная) / Персиковый фарфор (Светлая)': 'Panel theme: Liquid Glass iOS (Dark) / Peach Porcelain (Light)',
      'Жидкое стекло iOS (Тёмная)': 'Liquid Glass iOS (Dark)',
      'Персиковый фарфор (Светлая)': 'Peach Porcelain (Light)',
      'Вернуть исходный порядок всех блоков по умолчанию': 'Reset all cards to default order',
      'Обновить всё (телеметрия обновляется автоматически раз в ~3 сек)': 'Refresh all (telemetry auto-refreshes every ~3s)',
      'Автодиагностика стека проекта, .agentignore, DESIGN.md и GATES.md': 'Auto-diagnose project stack, .agentignore, DESIGN.md & GATES.md',
      'Открыть стартовую и быструю настройку ИИ-Пилота в 4 шага': 'Open the 4-step AI Pilot Setup Wizard',
      'Переключатель проекта: управляет снимками отката, Git-песочницами, Композером, Дозором, граблями и памятью': 'Workspace switcher: controls snapshots, Git sandboxes, Composer, Sentinel, pitfalls & memory',
      'Вернуться к автоопределению активного чата': 'Return to automatic active chat detection',
      'Сбросить зависшие или завершённые карточки чатов': 'Clear stale or finished chat cards',
      'Статус буфера проекта в оперативной памяти (клик — открыть блок ресурсов)': 'Project In-RAM buffer status (click to open Resources)',
      'Статус локальной видеомодели Ollama (клик — открыть блок ресурсов)': 'Local Ollama GPU model status (click to open Resources)',
      'Статус пула потоков процессора на внутренних задачах (клик — открыть блок ресурсов)': 'CPU worker pool status for background tasks (click to open Resources)',
      'Раскрыть список субагентов': 'Expand subagents list',
      'Включить детальный опрос по дереву решений (Grill-Me) перед выполнением следующего запроса': 'Enable detailed decision-tree interview (Grill-Me) before the next request',
      'Двухступенчатое локальное автодополнение (RAM + Ollama GPU) без затрат облачных токенов': 'Two-stage local autocomplete (RAM + Ollama GPU) with zero cloud tokens',
      'Вставить ошибку и фрагмент кода в Умный Композер': 'Insert error and code snippet into Smart Composer',
      'Очистить журнал сбоев': 'Clear runtime fault log',
      'Проведи краткое ревью архитектуры проекта и выдели слабые места': 'Run a concise architecture review of this project and highlight weak spots',
      'Ревью архитектуры проекта': 'Project architecture review',
      'Найди потенциальные баги, гонки или необработанные ошибки в ключевых модулях': 'Find potential bugs, race conditions, or unhandled errors in core modules',
      'Поиск потенциальных багов': 'Find potential bugs',
      'Составь пошаговый инженерный план реализации следующей задачи:': 'Create a step-by-step engineering implementation plan for the following task: ',
      'Шаблон пошагового плана': 'Step-by-step plan template',
      'Нажмите Tab или кликните, чтобы подставить подсказку': 'Press Tab or click to accept suggestion',
      'Начните писать мысль или @файл — серый текст подскажет продолжение, Ctrl+V вставит скриншот...': 'Start typing an idea or @file — ghost text suggests completion, Ctrl+V pastes a screenshot...',
      'Локальный визуальный аудит скриншота (Gemma 4, 0 тк облака)': 'Local visual audit of screenshot (Gemma 4, 0 cloud tokens)',
      'Удалить прикреплённый скриншот': 'Remove attached screenshot',
      'Очистить поле ввода': 'Clear input field',
      'Голосовой ввод и структурирование промпта (Web Speech + локальная очистка)': 'Voice input & prompt structuring (Web Speech + local cleanup)',
      'Локальный Pre-Commit: Shadow Guard, секреты и текст коммита (0% облачной квоты)': 'Local Pre-Commit: Shadow Guard, secret scan & commit message (0% cloud quota)',
      'Спросить локальную модель по индексу CPU+GPU+RAM без затрат облачной квоты (Ctrl+Enter)': 'Ask local model over CPU+GPU+RAM index with zero cloud quota (Ctrl+Enter)',
      'Отправить запрос в активный чат Antigravity (Enter)': 'Send prompt to active Antigravity chat (Enter)',
      'Очистить историю локального диалога': 'Clear local chat history',
      'Скрыть содержимое блока': 'Collapse card content',
      'Перетащите, чтобы изменить порядок блока': 'Drag to reorder card',
      '🔍 Найти навык (дизайн, видео, баги, игра)...': '🔍 Search skills (design, video, bugs, game)...',
      'Вернуть все навыки под управление ИИ-автопилота': 'Reset all skills to AI Autopilot control',
      'Поиск по каталогу и безопасный карантинный импорт внешних навыков': 'Search catalog and safely quarantine-import external skills',
      'Дерево вопросов перед задачей (Matt Pocock)': 'Pre-task decision tree interview (Matt Pocock)',
      'Правила React 19 и Next.js от Vercel': 'React 19 & Next.js guidelines by Vercel',
      'Авто-звукорежиссура видео и таймлайна': 'Automated video & timeline sound design',
      'Инженерный стандарт API от Addy Osmani': 'API engineering standards by Addy Osmani',
      'Хирургические правки без раздувания кода': 'Surgical edits without code bloat',
      'Поиск или owner/repo (GitHub / ClawHub)': 'Search or owner/repo (GitHub / ClawHub)',
      'slug (опц.)': 'slug (opt.)',
      'Тариф Pro: экономия квоты — Hydrogen для S/M и типовых задач, Orchestrator (Neon) / Neon для сложных L/XL': 'Pro Tier: quota-saving — Hydrogen for S/M routine tasks, Orchestrator (Neon) / Neon for complex L/XL',
      'Тариф Ultra: повышенный лимит — раннее подключение Orchestrator (Carbon) и Carbon на сложных задачах': 'Ultra Tier: higher limits — earlier Orchestrator (Carbon) and Carbon on complex tasks',
      'Перед любой задачей (S, M, L, XL)': 'Before any task (S, M, L, XL)',
      'Мелкие задачи S делать сразу, спрашивать начиная со средних M': 'Run small S tasks immediately, ask starting from medium M',
      'Задачи S и M делать сразу, спрашивать только на крупных L/XL': 'Run S and M tasks immediately, ask only on large L/XL',
      'Когда выбран Orchestrator (Neon / Argon), штатный движок сам передаёт правки на Hydrogen (-24% квоты), поэтому на S/M лишние опросы не показываются': 'When Orchestrator (Neon / Argon) is active, native engine delegates edits to Hydrogen (-24% quota), skipping extra S/M prompts',
      'Не предлагать углублённый опрос по дереву решений': 'Do not offer deep decision-tree interview',
      'Предлагать выбор детального опроса в окне Pre-Task Gate для сложных и размытых задач': 'Offer deep interview option in Pre-Task Gate for complex or ambiguous tasks',
      'Всегда проводить детальный опрос по развилкам перед реализацией': 'Always run a detailed decision-tree interview before implementing',
      'Максимальная точность и архитектурный контроль через Orchestrator (Neon) / Neon': 'Maximum precision and architectural control via Orchestrator (Neon) / Neon',
      'Перед изменением внешнего вида ИИ спросит желаемый стиль и покажет 3 примера на выбор': 'Before changing visuals, AI asks your desired style and shows 3 preview options',
      'Делать дизайн и анимации сразу в коде без предварительной витрины вариантов': 'Implement design & animations directly in code without a preview showroom',
      'При старте UI-задачи спрашивать: сгенерировать 3 варианта A/B/C, поискать референсы в интернете или сделать гибрид': 'On UI tasks, ask whether to generate 3 A/B/C prototypes, fetch web references, or combine both',
      'Всегда сразу собирать 3 авторских варианта A/B/C в локальной интерактивной витрине': 'Always build 3 custom A/B/C variants in the local interactive showroom',
      'Всегда сначала собирать живые референсы и CSS-токены через локальный Zero-LLM экстрактор (fetch-web-refs) с кэшем — без расхода токенов на браузерного субагента': 'Always gather live references & CSS tokens first via local Zero-LLM extractor (fetch-web-refs) with cache — zero browser subagent tokens',
      'Попадания в префиксный Implicit Cache (-95% стоимости входных токенов)': 'Prefix Implicit Cache hits (-95% input token cost)',
      'Показать содержимое блока': 'Expand card content',
      'Экономия за счёт попаданий в Implicit Cache': 'Savings from Implicit Cache hits',
      'Экономия за счёт срезов и поиска в In-RAM': 'Savings from In-RAM slicing & search',
      'Экономия за счёт сжатия логов Drain3, TOON и дельт на CPU': 'Savings from CPU Drain3 log compression, TOON & deltas',
      'Экономия за счёт локальной GPU-дистилляции Ollama': 'Savings from local Ollama GPU distillation',
      'Обновить статус Роя': 'Refresh Swarm status',
      'Бережёт квоту на мелких и средних задачах; предлагает Рой только на масштабных XL-задачах (4+ независимых модулей)': 'Saves quota on S/M tasks; suggests Swarm only on large XL tasks (4+ independent modules)',
      'Разрешить командный Рой начиная со средних многофайловых задач L (3+ независимых файлов)': 'Allow Swarm starting from multi-file L tasks (3+ independent files)',
      'Разрешить адаптивный Рой на любой многомодульной задаче (кроме простых вопросов)': 'Allow adaptive Swarm on any multi-module task (except simple questions)',
      'На крупных задачах L/XL предлагает Рой и ждёт подтверждения перед запуском воркеров': 'Suggests Swarm on large L/XL tasks and waits for confirmation before spawning workers',
      'Сам не предлагает Рой, но включает защиту воркеров и квот, когда вы сами пишете /swarm': 'Does not auto-suggest Swarm, but enables worker & quota protection when you type /swarm',
      'Работать только одиночным агентом или штатным Оркестратором': 'Work only with a single agent or native Orchestrator',
      'Координатор планирует на вашей основной модели (Neon), а рабочие авторы пишут код на быстром Gemini 4 Hydrogen в изолированных ветках share': 'Coordinator plans on your main model (Neon) while workers edit code on fast Gemini 4 Hydrogen in isolated share workspaces',
      'Авторы правок работают на кодинг-модели Gemini 4 Neon (Medium/High, Индекс 61) в изолированных ветках share': 'Workers edit on Gemini 4 Neon (Medium/High) in isolated share workspaces',
      'Авторы правок работают на сбалансированной модели Gemini 4 Argon (Medium) в изолированных ветках share': 'Workers edit on balanced Gemini 4 Argon (Medium) in isolated share workspaces',
      'Авторы правок работают на старшей модели Gemini 4 Carbon (Medium) в изолированных ветках share': 'Workers edit on flagship Gemini 4 Carbon (Medium) in isolated share workspaces',
      'Все воркеры запускаются на той же модели, что выбрана у вас в чате': 'All workers run on the same model currently selected in chat',
      'Добавлять независимого проверочного агента @verifier на каждые 2–4 автора для проверки кода и тестов перед сдачей': 'Add an independent @verifier agent for every 2–4 workers to audit diffs and tests',
      'Если у воркера Роя закончилась квота модели, автоматически переключать его на доступную модель без потери памяти диалога': 'If a Swarm worker hits quota limits, automatically switch it to an available model without losing memory',
      'Скорость расхода квоты за 30/60 мин (Quota Burn-Rate Pacer)': 'Quota burn rate over 30/60 min (Quota Burn-Rate Pacer)',
      'Сбросить временные паузы (cooldown) моделей после ошибок 429': 'Reset temporary model cooldowns after 429 errors',
      'Сводный статус буфера In-RAM и локальной видеомодели': 'Summary status of In-RAM buffer and local GPU model',
      'Сэкономлено токенов за счёт быстрых срезов и поиска в ОЗУ': 'Tokens saved via fast In-RAM slicing & search',
      'Сэкономлено токенов локальной видеомоделью GPU': 'Tokens saved via local GPU model',
      'Индекс триграмм BM25F, батчи воркеров и скорость CPU Cross-Reranker': 'BM25F trigram index, worker batches & CPU Cross-Reranker speed',
      'Автоматически определить CPU, ОЗУ и видеокарту и выставить безопасные лимиты': 'Auto-detect CPU, RAM & GPU and apply safe limits',
      'Сформировать паспорт вашего ПК и отправить в чат ИИ для подбора моделей': 'Generate PC hardware passport and send to AI chat for model tuning',
      'Проиндексировать текущий проект для поиска по смыслу': 'Index current workspace for semantic search',
      'Проверить сжатие тестового лога на видеокарте': 'Test log distillation on local GPU',
      'Мгновенно выгрузить нейросети из видеопамяти': 'Immediately unload models from GPU VRAM',
      'Локальная модель Ollama для сжатия логов и анализа': 'Local Ollama model for log distillation & analysis',
      'Локальная модель эмбеддингов для семантического поиска': 'Local embedding model for semantic search',
      'Собрать список установленных моделей и сразу отправить запрос в чат для поиска актуальных версий': 'Collect installed models and ask chat to check for newer versions',
      'Скачать дедуплицированный каскад моделей под все лимиты вашей видеокарты (с автофоллбэком на Hugging Face)': 'Download deduplicated model cascade for your VRAM limits (with Hugging Face fallback)',
      'Сколько оперативной памяти выделить под быстрый кэш файлов и индекс проекта (ramMaxBudgetMb)': 'RAM budget allocated for fast file cache and project index (ramMaxBudgetMb)',
      'Сколько рабочих потоков выделить пулу процессора для параллельного разбора AST, чанков и проверок (cpuMaxThreads)': 'Worker threads allocated to CPU pool for parallel AST parsing, chunking & checks (cpuMaxThreads)',
      'Сверхбыстрая проверка добавленных строк на необъявленные переменные и опциональный разбор диффа на локальной GPU': 'Ultra-fast check of added lines for undeclared variables and optional local GPU diff review',
      'Запустить мгновенную фоновую проверку контрактов и индексацию': 'Trigger immediate background contract check & indexing',
      'Сбросить накопленные предупреждения и находки Фонового Дозора': 'Clear accumulated Background Sentinel warnings & findings',
      'Текущий проект в ленте снимков': 'Current workspace in snapshot timeline',
      'Группировать правки по ходам агента': 'Group edits by agent turn',
      'Отдельные снимки каждого файла': 'Individual snapshots per file',
      'Откатить все файлы последнего хода к состоянию до начала ответа': 'Rollback all files from the last turn to pre-turn state',
      'Откатить последнюю правку файла': 'Rollback last file edit',
      'Создать изолированную копию репозитория git worktree': 'Create an isolated git worktree sandbox',
      'Сбросить список хрупких файлов только для выбранного проекта': 'Reset fragile files list for current workspace only',
      'Полный сброс глобальных весов и хрупкости': 'Full reset of global weights and fragility',
      'Показать сохранённые эпизоды прошлых сессий (SQLite FTS5)': 'Show saved episodes from past sessions (SQLite FTS5)',
      'Очистить сохранённые рецепты успешных починок': 'Clear saved winning fix recipes',
      'Путь к связанному репозиторию (напр. ../api)': 'Path to linked repository (e.g. ../api)',
      'Привязать смежный репозиторий для кросс-проектного поиска': 'Link companion repository for cross-project search',
      'Минимальные задержки для прототипов: отключает тяжёлые каскадные и мутационные проверки': 'Minimal latency for prototypes: disables heavy cascade & mutation checks',
      'Стандартный баланс: использует индивидуальные переключатели ниже': 'Standard balance: uses individual switches below',
      'Строгий аудит: принудительно включает все ключевые щиты, LSP и защиту конфигов': 'Strict audit: forces all core shields, LSP & config protection on',
      'Принудительно собрать компактный дайджест истории диалога': 'Force-build a compact dialog history digest',
      'Пересобрать AST-карту символов текущего проекта': 'Rebuild AST symbol map for current workspace',
      'Keep-Alive для Chat-модели': 'Keep-Alive for Chat model',
      'Keep-Alive для Embed-модели (gpuEmbedKeepAlive)': 'Keep-Alive for Embed model (gpuEmbedKeepAlive)',
      'Окно контекста Ollama (gpuContextTokens)': 'Ollama context window (gpuContextTokens)',
      'Авто (OLLAMA_MODELS / ~/.ollama/models)': 'Auto (OLLAMA_MODELS / ~/.ollama/models)',
      'Отложить или закрыть окно настройки (Esc)': 'Postpone or close setup wizard (Esc)',
      'Отключить правила экономии нового кода Ponytail': 'Disable Ponytail minimal-code rules',
      'Мягкий режим: подсказывать компактные альтернативы на базе существующих функций': 'Lite mode: suggest compact alternatives reusing existing functions',
      'Полная 7-ступенчатая лестница переиспользования кода и метки shortcut:': 'Full 7-rung code reuse ladder & shortcut: deferral markers',
      'Максимальная строгость: оспаривать избыточные требования до написания кода': 'Ultra strictness: push back on speculative scope before coding',
      'Стандартный лаконичный стиль ответов': 'Standard concise response style',
      'Стандарт ASD-STE100: до 20 слов в предложении без вводных фраз, код без сокращений': 'ASD-STE100 standard: <=20 words/sentence, zero filler, verbatim code',
      'Сверхплотный телеграфный ответ до 12 слов в предложении': 'Ultra-dense telegraphic replies <=12 words/sentence',
      'Построить интерактивную карту кластеров, God Nodes, мостов и теплоты кэша': 'Build interactive map of clusters, God Nodes, bridges & cache warmth',
      'Собрать реестр меток осознанного техдолга shortcut: и проверить риски no-trigger': 'Harvest deliberate shortcut: debt markers and flag no-trigger rot risks'
    };

    function translateUiString(raw, dict) {
      if (typeof raw !== 'string' || !raw) return raw;
      const lead = raw.match(/^\s*/)[0];
      const trail = raw.match(/\s*$/)[0];
      const core = raw.replace(/\s+/g, ' ').trim();
      if (!core) return raw;
      if (Object.prototype.hasOwnProperty.call(dict, core)) {
        return lead + dict[core] + trail;
      }
      const wizTitleMatch = core.match(/^The Tunnel · Мастер (v[\d.]+)$/);
      if (wizTitleMatch) {
        return lead + 'The Tunnel · Setup Wizard ' + wizTitleMatch[1] + trail;
      }
      return raw;
    }

    function walkAndTranslateDom(node, lang) {
      if (!node) return;
      if (node.nodeType === 3) {
        const curVal = node.nodeValue;
        if (typeof curVal !== 'string' || !curVal.trim()) return;
        let orig = I18N_ORIG_TEXT.get(node);
        if (orig === undefined) {
          if (/[А-Яа-яЁё]/.test(curVal)) {
            orig = curVal;
            I18N_ORIG_TEXT.set(node, orig);
          } else {
            return;
          }
        }
        node.nodeValue = lang === 'ru' ? orig : translateUiString(orig, UI_RU_TO_EN_TEXT);
        return;
      }
      if (node.nodeType !== 1) return;
      const tag = (node.tagName || '').toUpperCase();
      if (tag === 'SCRIPT' || tag === 'STYLE') return;

      for (let i = 0; i < I18N_ATTR_NAMES.length; i++) {
        const attrName = I18N_ATTR_NAMES[i];
        if (typeof node.getAttribute !== 'function') break;
        const val = node.getAttribute(attrName);
        if (typeof val === 'string' && val.trim()) {
          let attrBag = I18N_ORIG_ATTRS.get(node);
          if (!attrBag || !Object.prototype.hasOwnProperty.call(attrBag, attrName)) {
            if (/[А-Яа-яЁё]/.test(val)) {
              if (!attrBag) {
                attrBag = {};
                I18N_ORIG_ATTRS.set(node, attrBag);
              }
              attrBag[attrName] = val;
            }
          }
          if (attrBag && Object.prototype.hasOwnProperty.call(attrBag, attrName)) {
            const origAttr = attrBag[attrName];
            node.setAttribute(
              attrName,
              lang === 'ru' ? origAttr : translateUiString(origAttr, UI_RU_TO_EN_ATTR)
            );
          }
        }
      }

      const kids = node.childNodes;
      if (kids && kids.length) {
        for (let i = 0; i < kids.length; i++) {
          walkAndTranslateDom(kids[i], lang);
        }
      }
    }

    function applyUiLanguageDom(lang) {
      const valid = normalizeUiLanguage(lang);
      currentUiLanguage = valid;
      try {
        if (document.documentElement) {
          document.documentElement.setAttribute('lang', valid);
        }
        if (document.body) {
          document.body.setAttribute('data-ui-language', valid);
        }
      } catch {}
      document.querySelectorAll('#uiLanguageGroup button').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.lang === valid);
      });
      if (document.body) {
        walkAndTranslateDom(document.body, valid);
      }
    }

    async function setUiLanguage(lang) {
      const valid = normalizeUiLanguage(lang);
      applyUiLanguageDom(valid);
      if (currentState && typeof currentState === 'object') {
        currentState.uiLanguage = valid;
      }
      if (typeof telemetryLastSig !== 'undefined') {
        telemetryLastSig = '';
      }
      if (typeof renderPayload === 'function' && ((typeof lastPayloadCache !== 'undefined' && lastPayloadCache) || (currentState && Object.keys(currentState).length > 0))) {
        const nextPayload = (typeof lastPayloadCache !== 'undefined' && lastPayloadCache)
          ? Object.assign({}, lastPayloadCache, { state: Object.assign({}, lastPayloadCache.state || currentState, { uiLanguage: valid }) })
          : { state: currentState };
        renderPayload(nextPayload);
      }
      if (typeof renderWorkspaceSwitcher === 'function') {
        renderWorkspaceSwitcher(lastPayloadCache);
      }
      if (typeof syncComposerGrillToggleUi === 'function') {
        syncComposerGrillToggleUi();
      }
      if (typeof renderSmartComposerChips === 'function') {
        renderSmartComposerChips();
      }
      if (typeof renderLocalRagMessages === 'function') {
        renderLocalRagMessages();
      }
      if (typeof updateComposerEngineBadge === 'function') {
        updateComposerEngineBadge('', typeof _smartGhostText !== 'undefined' && _smartGhostText
          ? L('RAM · <5 мс', 'RAM · <5 ms')
          : L('RAM + GPU · 0 тк', 'RAM + GPU · 0 tok'));
      }
      if (typeof flashComposerStatus === 'function' && (typeof _smartComposerStatusTimer === 'undefined' || !_smartComposerStatusTimer)) {
        flashComposerStatus('', '');
      }
      if (typeof syncSmartSendButtonLabel === 'function') {
        syncSmartSendButtonLabel();
      }
      const wizModal = document.getElementById('onboardingWizardModal');
      if (wizModal && wizModal.classList.contains('visible') && typeof renderWizardStep === 'function') {
        wizDraft.uiLanguage = valid;
        const launchBadge = document.getElementById('wizLaunchBadge');
        if (launchBadge) {
          const isFresh = currentState.onboardingCompleted === false;
          launchBadge.textContent = isFresh ? L('Первый запуск', 'First Run') : L('Быстрая настройка', 'Quick Setup');
        }
        renderWizardStep();
      }
      await updateState({ uiLanguage: valid });
      if (typeof flashStatus === 'function') {
        flashStatus(valid === 'ru' ? 'Язык интерфейса: Русский' : 'Interface language: English');
      }
    }

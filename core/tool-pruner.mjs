/**
 * @file tool-pruner.mjs
 * @description Когнитивный 3D-маршрутизатор The Tunnel (3D Cognitive Router v4.0.8):
 * Оценивает реальный охват графа кода (Scope-Scout + PageRank), строит 3D-тензор
 * Ширина × Глубина × Неопределённость/Риск, генерирует адаптивные варианты плана и проверяет селектор модели Gemini 4.
 */

import {
  evaluateSelectorMatchForTask,
  formatSelectorSnapshotForPrompt,
  resolveEffectivePreTaskGatePolicy,
} from './model-profile.mjs';
import { expandRuQueryToEnTerms } from './ru-en-lexicon.mjs';
import { normalizeLang, resolveStateLanguage } from './i18n.mjs';

// Регулярные выражения и паттерны для классификации домена задачи
const DOMAIN_PATTERNS = {
  algo_refactor: [
    /\b(?:refactor(?:ing)?|algorithm|parse|parser|math|sort|syntax|benchmark|ast|codemod|ddmin|pageRank|dijkstra|levenshtein|fifo|lru|ring\s*buffer|redos|dead\s*exports|camelCase|snake_case|semver|aes-256-gcm|fenwick|topological|fs\.readFile|fs\/promises|async\/await)\b/i,
    /(?:рефакторинг|рефактор|алгоритм|парсер|парсинг|математик|сортировк|синтаксис|бенчмарк|кодмод|слайсинг|фаззинг|токенизатор|конкатенац|рекурси|стектрейс|кольцев[а-яё]*\s+буфер|семантическ[а-яё]*\s+верси|очеред[а-яё]*\s+на\s+честн|нечетк[а-яё]*\s+поиск|левент?штейн|дейкстр|хэш[-\s]?таблиц|хеш[-\s]?таблиц|красно[-\s]?черн|дерев[оа]\s+фенвик|топологическ|скользящ[а-яё]*\s+окн|дифф[-\s]?патч|клонирован|дедупликац|инвариант|троттлинг|дебаунс|шифрован|бинарн[а-яё]*\s+числ|символическ[а-яё]*\s+ссыл(?:к|ок)|баланс[а-яё]*\s+(?:открывающ|скобок)|условн[а-яё]*\s+конструкц|магическ[а-яё]*\s+чис|файлов[а-яё]*\s+дескриптор|потоков[а-яё]*\s+вывод|байтов[а-яё]*\s+(?:смещен|индекс)|экранирован[а-яё]*\s+спецсимвол|устаревш[а-яё]*\s+колбэк)/i
  ],
  ui_browser: [
    /\b(?:browser|chrome|devtools|frontend|button|layout|dom|react|vue|component|style|page|cookie|a11y|accessibility|lcp|cwv|css|html|svg|design|redesign|ui|ux|animation|animations|animate|vfx|particle|particles|theme|flex|flexbox|grid|safari|viewport|100vh|100dvh|spa|wcag|aria|aria-label|z-index|sticky|ellipsis|overflow|tooltip|modal|sidebar|tabs|accordions?|drag-and-drop|OTP|hover|active|focus|focus-trap|shimmer|skeleton|command\s+palette|tbt)\b/i,
    /(?:браузер|хром|девтулс|девтулз|верстк(?!и\s+и\s+так\s+далее|и,\s+чтобы\s+проверить)|стил(?:[ьияюем]|ев|изац)(?!\s+код)|фронтенд|интерфейс(?!\s+и\s+встроенные\s+подсказки\s+справки)|кноп(?:к|ок)|экран(?!ир)|страниц|рендер|компонент|макет|адаптив|(?:^|[^а-яё])кук[иауеой]?(?=$|[^а-яё])|дизайн|редизайн|анимац|визуал|оформлен(?!и[ея]\s+кода)|эффект(?!ивн)|частиц|сайдбар|навигац|модал(?:к|ок|ьн)|попап|тултип|аккордеон|вклад(?:к|ок)|ползун|слайдер|фокус|скролл|прокрутк|флекс|грид|шрифт|икон(?:к|ок)|темн[а-яё]*\s+тем|светл[а-яё]*\s+тем|палитр|скелетон|лоадер|вьюпорт|мобильн[а-яё]*\s+(?:веб|верси|устройств|экран)|смартфон|контрастност|выпадающ[а-яё]*\s+(?:спис|календар)|лайтбокс|галере[яию]|перетаскиван|онбординг|футер|шапк[ауи]\s+(?:сайт|таблиц)|переключател[а-яё]*\s+вид[а-яё]*\s+каталог)/i
  ],
  backend_db: [
    /\b(?:sql|database|postgres|postgresql|mysql|sqlite|mongo|migration|orm|prisma|endpoint|rest|api|server|route|controller|query|schema|redis|jwt|oauth|webhook|stripe|zod|fastify|express|cursor|row_number|for\s+update|healthz|smtp|soft\s+delete|tsvector|gin|bigint|csv|upsert|graphql|dataloader|rbac|jsonb|abortcontroller|argon2id|etag|timestamptz|brotli|websocket|middleware|bad\s+gateway|502)\b/i,
    /(?:баз[аыеуой]\s+данных(?!\s*\(wait-for-it\))|(?:^|[^а-яёa-z0-9])бд(?=$|[^а-яёa-z0-9])|миграци(?!и\s+со\s+старой\s+версии)|(?<!хэш[-\s]|хеш[-\s]|markdown[-\s]|понятной\s+|сводной\s+|строков[а-яё]*\s+|пример[а-яё]*\s+кода\s+и\s+|команды\s+и\s+)таблиц[а-яё]*(?!\s+(?:умножен|правил|символ|оффсет|смещен|диалог|рекорд|лидер|тариф|стил|ширин|маршрут|сравнен|команд|задержек|перевод|глиф))|эндпоинт|(?<!модел[а-яё]*\s+|двух?ступенчат[а-яё]*\s+|умн[а-яё]*\s+|когнитивн[а-яё]*\s+)роут(?:[аыуеов]|инг)(?!ер|\s+(?:модел|задач|скилл))|(?<!linux[-\s])сервер(?!а\s+и\s+медиасервер)|бэкенд|(?:^|[^а-яёa-z0-9])орм(?=$|[^а-яёa-z0-9])|контроллер|запрос[а-яё]*\s+(?:к\s+бд|sql|n\+1|b-tree|count|к\s+внешнему\s+платеж)|транзакц|пул\s+соедин|пагинац|вебхук|авторизац[а-яё]*\s+(?:по\s+jwt|при\s+рукопожатии)|индекс[а-яё]*\s+(?:в\s+бд|postgresql|gin|b-tree|составн)|взаимн[а-яё]*\s+блокировк|deadlock|платежн[а-яё]*\s+шлюз|хранени[ея]\s+(?:парол|сесси)|сидирован|брокер[а-яё]*\s+сообщен|часов[а-яё]*\s+пояс[а-яё]*.*бд|суточн[а-яё]*\s+статистик[а-яё]*\s+продаж|перехватчик\s+ошиб(?:к|ок)|поллинг[а-яё]*\s+статус)/i
  ],
  docs: [
    /\b(?:docs|documentation|readme(?:\.md)?|changelog(?:\.md)?|contributing(?:\.md)?|security\.md|jsdoc|tsdoc|@param|@returns|mermaid|sequenceDiagram|flowchart|adr|cheat\s*sheet|troubleshooting\s+guide|release\s+notes|style\s+guide|prompt\s+cookbook|release\s+checklist)\b/i,
    /(?:документаци|ридми|справк[уиа]\s+(?:cli|--help)|руководств|чейнджлог|комментари[иев]\s+(?:jsdoc|с\s+типами)|архитектурн[а-яё]*\s+записк|шпаргал(?:к|ок)|глоссари|релиз[-\s]?ноутс|чек[-\s]?лист\s+готовност|стандарт\s+кодирования|обзорн[а-яё]*\s+стать|диаграмм[а-яё]*\s+последовательност|блок[-\s]?схем|(?:напиши|оформи|составь|переведи|обнови|добавь|опиши|сократи).*?(?:документаци|руководств|справочник|инструкци|гайд|мануал|стать[юя]|памятк|шпаргалк|глоссари|описани[ея]\s+(?:пакета|всех\s+метрик|параметров|ошибок\s+в\s+конфигурационн)|примеры\s+(?:использования\s+cli|интеграции\s+хуков)|раздел\s+faq|таблиц[уы]\s+сравнени|сравнение\s+трех\s+режимов|сценарий\s+миграции\s+со\s+старой|спецификаци[юя]\s+протокола|внутреннее\s+устройство\s+кэширования\s+ast|сообщения\s+об\s+ошибках\s+валидатора\s+на\s+русский|интерфейс\s+и\s+встроенные\s+подсказки\s+справки|понятную\s+справку\s+`?--help))/i
  ],
  devops: [
    /\b(?:docker(?:file|ignore|-compose)?|k8s|kubernetes|ci\/cd|github\s+(?:actions?|secrets|packages)|powershell|helm|nginx|reverse-proxy|systemd|oomkilled|sigterm|buildkit|SSL|TLS|HTTPS|Makefile|pre-commit|pm2|loki|promtail|trivy|readinessProbe|livenessProbe|HPA|zero-downtime|wait-for-it|crontab|cron|tmux|screen)\b/i,
    /(?:депло[йяю]|докер|кубер|(?<!(?:flex|grid|флекс|грид|dom)[-\s])контейнер|пайплайн|павершел|многоступенчат[а-яё]*.*dockerfile|ротац[а-яё]*\s+(?:и\s+архивац[а-яё]*\s+)?лог|юнит[-\s]?файл|предкоммитн[а-яё]*\s+хук|кроссплатформенн[а-яё]*\s+бинарник[а-яё]*\s+в\s+ci|свободн[а-яё]*\s+мест[ао]\s+на\s+диске|раздач[ау]\s+статики\s+напрямую\s+через\s+nginx|перевод[а-яё]*\s+трафика|canary\s+rollout|симлинк[а-яё]*\s+релиза|самоподписанн[а-яё]*\s+сертификат|профилирован[а-яё]*\s+времени\s+старта\s+всех\s+сервисов|диагностик[аи]\s+окружения|регистраци[ия]\s+хуков\s+в\s+конфигурационн|конфликт\s+портов\s+при\s+параллельном|зашифрованн[а-яё]*\s+архив[а-яё]*\s+бэкапа|переменн[а-яё]*\s+окружения\s+перед\s+запуском|воркфлоу\s+для\s+автоматической\s+проверки.*при\s+пуше|публикаци[юя]\s+npm-пакета.*git-тег|сесси[юя]\s+screen\s*\/\s*tmux|\.env\.example|\.gitattributes)/i
  ]
};

const PLAIN_INTENT_SPECS = [
  { id: 'UI_DESIGN', rx: /(?:дизайн|редизайн|оформл(?:ени|ить)(?!\s+кода)|модалк|верстк)/i, spec: 'UI_DESIGN: Semantic CSS tokens (:root), contrast >=4.5:1, overflow-safe grid.' },
  { id: 'MOTION_VFX', rx: /(?:анимац|визуальн[а-яё]*\s+эффект|частиц|vfx)/i, spec: 'MOTION_VFX: 60fps GPU-safe transform/opacity transitions.' },
  { id: 'BUGFIX_INTERACTION', rx: /(?:не\s+работает|сломал|глючит|вылетает|почини|исправь)/i, spec: 'BUGFIX: Trace contracts & guards; preserve exports.' },
  { id: 'PERFORMANCE_MEMORY', rx: /(?:тормозит|лагает|медленн|утечк[аиу]\s+памят|ускорь)/i, spec: 'PERFORMANCE: Eliminate layout thrashing, listener leaks & redundant I/O.' },
  { id: 'QA_RELIABILITY', rx: /(?:стресс[-\s]?тест|стресс[-\s]?аудит|большие\s+тесты|узкие\s+места)/i, spec: 'QA_AUDIT: Verify syntax/contracts and run run-stress-audit.mjs --fuzz.' },
];

/**
 * Распознаёт семантические сигналы намерения пользователя:
 * вопрос-консультация (read-only), доработка существующей функции, аналогия/клонирование,
 * догоняющая реплика для нескольких экранов или мутация кода.
 * @param {string} [promptText='']
 * @returns {{
 *   isReadOnlyQuestion: boolean,
 *   hasMutationVerb: boolean,
 *   isExtendExisting: boolean,
 *   isAnalogyOrClone: boolean,
 *   isFollowUpMultiTarget: boolean
 * }}
 */
export function detectPromptIntentSignals(promptText = '') {
  const clean = typeof promptText === 'string' ? promptText.trim() : '';
  if (!clean) {
    return {
      isReadOnlyQuestion: false,
      isModalAnalyticalQuestion: false,
      hasMutationVerb: false,
      hasModalImplIntent: false,
      isExtendExisting: false,
      isAnalogyOrClone: false,
      isFollowUpMultiTarget: false,
      isApprovalFollowUp: false,
      isPlanReview: false
    };
  }

  const hasMutationVerb = /(?:добав[ьи]|дополн[иим]|доработ[аей]|расшир[ьи]|внедр[иим]|реализуй|создай|напиши\s+(?:код|функц|модул|скрипт|тест|миграц|запрос|компонент|сервис|обработчик|конфигурац|воркфлоу|манифест|правил|руководств|документац|инструкци|гайд|справочник|стать|шпаргалк|генератор|парсер|валидатор|бенчмарк|алгоритм|плагин|шейдер|утилит)|переделай|исправ[ьи]|почини|обнови|измени|удали|подключи|сгенерируй|вырежи|смонтируй|русифицируй|оптимизируй|переименуй|замени|примени|включи|отключи|убери|сделай|сверстай|настрой|оформи|перекрас[ьи]|покрас[ьи]|составь|проведи|распакуй|пропатчь|локализуй|выдели|ускорь|упрости|вынеси|перепиши|давай\s+(?:добавим|дополним|сделаем|внедрим|починим|переделаем|обновим))|(?<![-\w])(?:implement|create|add|update|fix|refactor|remove|delete|write|build|patch|rename)(?![-\w])/i.test(clean);

  const hasInquiryPattern = /(?:^\s*(?:почему|зачем|как\s+устроен|как\s+работает|как\s+правильно|какой\s+подход|какой\s+алгоритм|какой\s+способ|какой\s+уровень|какой\s+паттерн|какой\s+формат|какие\s+варианты|в\s+чём\s+разница|в\s+чём\s+отличие|что\s+делает|что\s+происходит|что\s+означает|объясни|расскажи|подскажи|составь\s+список\s+вопросов|покажи\s+список|сколько\s+будет|сколько\s+примерно|а\s+у\s+нас\s+всё|а\s+у\s+нас\s+в|а\s+если\s+пользователь|точно\s+больше\s+нет|точно\s+ли|есть\s+ли\s+в\s+нашем|есть\s+ли\s+разница|проверь\s+нет\s+ли.*покажи\s+список)|(?:\?(?:\s|$)))/i.test(clean);

  // Модально-аналитические вопросы живой речи («А как мы можем доработать/улучшить...?», «Стоит ли переделать...?», «Это баг или ошибка...?»),
  // где инфинитивы действия являются предметом обсуждения, а не императивным приказом менять код прямо сейчас
  const hasDirectImperativeOpener = /^\s*(?:пожалуйста[,\s]+)?(?:сделай|напиши|реализуй|добав[ьи]|исправ[ьи]|почини|удали|обнови|переделай|внедр[иим]|сверстай|настрой|перекрас[ьи]|покрас[ьи]|запусти|проведи|переименуй|вырежи|смонтируй|русифицируй|поправь|устрани|создай|оптимизируй|перепиши|вынеси|проверь\s+(?:через|все\s+\d+|доступность|почему\s+баннер|баланс)|давай\s+(?:сделаем|внедрим|добавим|починим|реализуем|переделаем|обновим))\b/i.test(clean);
  const isModalAnalyticalQuestion =
    !hasDirectImperativeOpener &&
    /\?(?:\s|$)/.test(clean) &&
    /(?:^\s*(?:(?:а|ну|и|слушай|скажи|смотри|кстати)[,\s]+)*(?:как\s+(?:мы\s+можем|нам|можно|лучше|правильнее|бы\s+ты|вообще|эффективнее|максимально)|(?:можем|можешь)\s+ли(?:\s+(?:мы|ты))?|можно\s+ли|может\s+(?:быть|сейчас|ли|уже)|а\s+может|стоит\s+ли|имеет\s+ли\s+смысл|каким\s+образом|насколько\s+(?:сложно|правильно|выгодно|реально)|(?:что\s+)?если\s+мы|как\s+думаешь|что\s+думаешь|в\s+чём\s+(?:проблема|причина|несовершенство|ошибка|баг|подвох)|это\s+какой[-\s]?то\s+баг|какие\s+есть\s+(?:идеи|варианты|способы))|(?:это\s+(?:какой[-\s]?то\s+)?баг\s+или|может\s+сейчас\s+наши\s+алгоритмы|предложил\s+улучшить))/i.test(clean);

  const isExplicitAuditOrTest = /(?:проведи|запусти|протестируй|стресс[-\s]?тест|большие\s+тесты|аудит\s+кода|проверь\s+всё|проверь\s+все\s+500)/i.test(clean);
  const isArchDesignFork =
    /(?:(?:нужно|надо|хочу|требуется)\s+спроектир[а-яё]+|спроектируй\b|\bdesign\s+(?:a\s+)?new\s+arch)/i.test(clean) &&
    /(?:архитектур|систем[уеы]|синхронизац|миграц|выбрат[ьи]|компромисс|вариант|redis|sqlite|ring\s*buffer|trade-?offs?)/i.test(clean);
  const isReadOnlyQuestion =
    hasInquiryPattern &&
    (!hasMutationVerb ||
      isModalAnalyticalQuestion ||
      /(?:нет,\s*просто\s+объясни|покажи\s+список\s+мест|покажи\s+список\s+основных|объясни\s+логику|подскажи\s+как\s+увеличить)/i.test(clean)) &&
    !isExplicitAuditOrTest &&
    !isArchDesignFork;

  const isExtendExisting = /(?:дополн[иим]|доработ[аей]|расшир[ьи]|уже\s+имеющ|в\s+существующ|к\s+существующ|чуть\s+поправ|добавь\s+в\s+(?:функц|модул|класс|компонент|игр|приложен|магазин)|давай\s+там\s+добавим)/i.test(clean);

  const isAnalogyOrClone = /(?:по\s+аналогии|такой\s+же\s+как|такую\s+же\s+как|так\s+же\s+как\s+в|как\s+у\s+нас\s+в|как\s+мы\s+делали\s+в|как\s+у\s+остальных|скопируй\s+механик)/i.test(clean);

  const isFollowUpMultiTarget = /(?:для\s+остальных|во\s+всех\s+остальных|и\s+тут\s+тоже|на\s+остальных\s+экран|ко\s+всем\s+остальным|для\s+всех\s+остальных)/i.test(clean);

  const isPlanReview = /^\[plan review(?:\s+due)?\]/i.test(clean);
  const hasModalImplIntent =
    !isPlanReview &&
    isModalAnalyticalQuestion &&
    (hasMutationVerb ||
      isExtendExisting ||
      /(?:сделать|реализ[а-яё]*|передел[а-яё]*|добав[а-яё]*|внедр[а-яё]*|улучш[а-яё]*|оптимизир[а-яё]*|перепис[а-яё]*|вынес[а-яё]*|подключ[а-яё]*|интегрир[а-яё]*|настро[а-яё]*|почин[а-яё]*|исправ[а-яё]*|\b(?:implement|add|build|refactor|fix|create|update|integrate|optimize)\b)/i.test(clean));
  const isShortApproval =
    clean.length > 0 &&
    clean.length <= 64 &&
    !/\?/.test(clean) &&
    /^(?:(?:(?:да|давай|ок|ok|хорошо|отлично|супер|ага)[,\s]+)?(?:перейд[её]м\s+к\s+(?:меню|делу|реализации)\s+и\s+)?(?:делаем|делай|сделаем|погнали|запускай|запускаем|начинай|начинаем|поехали|внедряй|внедряем|приступай|приступаем|исправляем|исправляй|исправим|чиним|починим|фиксим|обновляем|подтверждаю|proceed)|да|давай|ок|ok|yes|go|го|ага|угу|хорошо|отлично|согласен|подтверждаю|первый\s+вариант|вариант\s*[123abcабв]|да[,\s]+(?:первый|давай|ок)|[123]|пуск|(?:(?:модель\s+)?(?:переключил(?:ся|ась)?|сменил(?:а)?|поменял(?:а)?|готово|switched|ready|resume|continue)(?:\s+(?:модель|model))?)(?:[,\s]+(?:пуск|запускай|запускаем|давай|делаем|go|proceed|1|2|3|вариант\s*[123]))?)[\s!.]*$/i.test(clean);
  const isStructuredGateApproval =
    /^A1\s*:\s*/i.test(clean) &&
    clean.length <= 450 &&
    !/(?:только\s+(?:read-only|диагностик|отч[её]т)|без\s+(?:изменен|записи|правок)|отмен[аи]|витрин[аеыу]|референс|прототип[аы]\s+a\/b\/c|пауз[аеыу].*модел|заверш(?:ить|и)\s+ход.*модел|смен[иыуть].*модел|переключ[иыуть].*модел|end\s+turn.*switch.*model|pause.*switch.*model)/i.test(clean);
  const isArtifactDocApproval =
    /(?:^|\n)The user has approved this document\./i.test(clean) &&
    !/\?/.test(clean);
  const isApprovalFollowUp = !isPlanReview && (isShortApproval || isStructuredGateApproval || isArtifactDocApproval);

  return {
    isReadOnlyQuestion: isReadOnlyQuestion || isPlanReview,
    isModalAnalyticalQuestion: isPlanReview ? false : Boolean(isModalAnalyticalQuestion),
    hasMutationVerb: isPlanReview ? false : hasMutationVerb,
    hasModalImplIntent,
    isExtendExisting,
    isAnalogyOrClone,
    isFollowUpMultiTarget,
    isApprovalFollowUp,
    isArtifactDocApproval,
    isPlanReview
  };
}

/**
 * Оценивает реальный объём и связность задачи по AST-графу кодовой базы (Scope-Scout).
 * Проверяет, какие файлы и функции уже есть в проекте, их размер в строках и число обратных зависимостей.
 * @param {string} [userPrompt='']
 * @param {object} [options={}]
 * @returns {{
 *   scopeTier: 'READ_ONLY'|'ISOLATED'|'COUPLED'|'ARCHITECTURAL'|'UNKNOWN_NEEDS_SCOUT',
 *   matchedFiles: Array<{ file: string, lines: number, symbols: string[], dependentsCount: number }>,
 *   totalLines: number,
 *   maxFileLines: number,
 *   totalReverseDependents: number,
 *   needsScoutFirst: boolean,
 *   signals: object,
 *   scopeHint: string
 * }}
 */
export function estimateCodebaseScope(userPrompt = '', { wsPath = '', repoMapper = null, semanticFiles = [] } = {}) {
  const promptText = typeof userPrompt === 'string' ? userPrompt.trim() : '';
  const signals = detectPromptIntentSignals(promptText);

  const emptyResult = {
    scopeTier: signals.isReadOnlyQuestion ? 'READ_ONLY' : 'ISOLATED',
    matchedFiles: [],
    totalLines: 0,
    maxFileLines: 0,
    totalReverseDependents: 0,
    needsScoutFirst: false,
    signals,
    scopeHint: ''
  };

  if (!promptText || promptText.length < 8 || (signals.isReadOnlyQuestion && !signals.isModalAnalyticalQuestion)) {
    if (signals.isPlanReview) {
      emptyResult.scopeHint = '🔎 [Intent: Orchestrator Plan Review] Verify executor report against plan without Pre-Task Gate.';
    } else if (signals.isReadOnlyQuestion) {
      emptyResult.scopeHint = '💬 [Intent: Read-Only Consultation] Answer directly without triggering code-edit Pre-Task Gate or UI Showroom.';
    }
    return emptyResult;
  }

  const matchedFiles = [];
  const reverseDepsSet = new Set();
  let totalLines = 0;
  let maxFileLines = 0;

  if (wsPath && repoMapper && typeof repoMapper.rankRepoByPageRank === 'function') {
    try {
      const semMap = new Map(
        (Array.isArray(semanticFiles) ? semanticFiles : [])
          .filter((sf) => sf && sf.file && Number(sf.score || 0) >= 0.50)
          .map((sf) => [String(sf.file).replace(/\\/g, '/'), Number(sf.score)])
      );

      const ranked = repoMapper.rankRepoByPageRank(wsPath, promptText, { topK: 8 });
      const cached = typeof repoMapper.getCachedRepoMap === 'function' ? repoMapper.getCachedRepoMap(wsPath) : null;
      const fileMap = new Map((cached?.filesIndex || []).map((f) => [f.file.replace(/\\/g, '/'), f]));

      // Проверяем, назвал ли пользователь конкретные файлы явно (например, safe-json.mjs) без мульти-файлового охвата
      const explicitFileNames = Array.from(
        new Set(
          (promptText.match(/[\w./\\-]+\.(?:mjs|cjs|js|ts|tsx|jsx|py|go|rs|java|cs|cpp|c|h|json|css|scss|html|vue|svelte)\b/gi) || [])
            .map((m) => m.replace(/\\/g, '/').split('/').pop().toLowerCase())
        )
      );
      const hasMultiFilePhrase =
        /\b(?:all\s+files|across\s+files|multi[- ]file|everywhere)\b|(?:во\s+всех|нескольких\s+файл|по\s+всему\s+проект|во\s+всех\s+модул|везде|несколько\s+модулей|всех\s+модул|всей\s+систем)/i.test(promptText);

      const rawCandidates = (ranked?.rankedFiles || []).filter((rf) => rf.seedHits > 0);
      const maxDirectScore = rawCandidates.reduce((mx, rf) => Math.max(mx, Number(rf.directScore || 0)), 0);

      // Отсекаем низкоуровневые утилитные хабы и слабый лексический «хвост», когда есть явный лидер совпадения
      const filteredLexical = rawCandidates.filter((rf) => {
        const normF = rf.file.replace(/\\/g, '/');
        const baseLower = normF.split('/').pop().toLowerCase();
        const isExplicitlyNamed = explicitFileNames.includes(baseLower);
        if (isExplicitlyNamed) return true;
        if (explicitFileNames.length > 0 && !hasMultiFilePhrase) {
          return false;
        }
        if (rf.isUtilityHub && !semMap.has(normF) && (rf.directScore || 0) <= 5) {
          return false;
        }
        if (maxDirectScore >= 8 && (rf.directScore || 0) < maxDirectScore * 0.45 && !semMap.has(normF)) {
          return false;
        }
        return true;
      });

      const mergedMap = new Map();
      for (const rf of filteredLexical.slice(0, 4)) {
        mergedMap.set(rf.file.replace(/\\/g, '/'), rf);
      }
      // Гибридное обогащение целями от локального GPU-индекса: не раздуваем одиночную правку до 4 файлов (wide/XL) документацией, тестами и слабым семантическим хвостом
      if (explicitFileNames.length === 0 || hasMultiFilePhrase) {
        const wantsDocsOrTests = /\b(?:tests?|spec|readme|changelog|docs?|skills?)\b|(?:тест|документац|ридми|чейнджлог|скилл|навык)/i.test(promptText);
        const semEntries = Array.from(semMap.entries()).filter(([semFile]) => {
          if (wantsDocsOrTests) return true;
          if (/\.(?:md|txt)$/i.test(semFile)) return false;
          if (/(?:^|\/)(?:tests?|__tests__)\//i.test(semFile) || /\.(?:test|spec)\.[mc]?[jt]sx?$/i.test(semFile)) return false;
          return true;
        });
        const maxSemScore = semEntries.reduce((mx, [, sc]) => Math.max(mx, sc), 0);
        const hasLexicalLead = filteredLexical.length > 0 && !hasMultiFilePhrase;
        const semCap = hasMultiFilePhrase ? 4 : (hasLexicalLead ? Math.min(3, filteredLexical.length + 1) : 3);
        const minSemThreshold = hasLexicalLead ? Math.max(0.68, maxSemScore - 0.06) : Math.max(0.56, maxSemScore - 0.08);

        for (const [semFile, semScore] of semEntries) {
          if (mergedMap.size >= semCap) break;
          if (!mergedMap.has(semFile) && semScore >= minSemThreshold && fileMap.has(semFile)) {
            mergedMap.set(semFile, {
              file: semFile,
              score: semScore,
              seedHits: 1,
              directScore: 6,
              isUtilityHub: false,
              matchedSymbols: [],
              semanticMatched: true,
            });
          }
        }
      }

      const topHits = Array.from(mergedMap.values()).slice(0, 4);

      for (const hit of topHits) {
        const normFile = hit.file.replace(/\\/g, '/');
        const meta = fileMap.get(normFile);
        const ranges = meta?.symbolsWithRanges || [];
        const fileMaxLine = ranges.reduce((acc, s) => Math.max(acc, Number(s.endLine || 0)), 0) || 60;
        totalLines += fileMaxLine;
        if (fileMaxLine > maxFileLines) maxFileLines = fileMaxLine;

        let depCount = 0;
        if (typeof repoMapper.findReverseImporters === 'function') {
          try {
            const rev = repoMapper.findReverseImporters(wsPath, normFile, 25);
            const deps = (rev?.dependents || []).map((d) => (typeof d === 'string' ? d : d.file)).filter(Boolean);
            depCount = deps.length;
            // Демпфирование раздувания reverseDeps для общих модулей без совпадения конкретных символов
            const hasDirectTarget = (hit.matchedSymbols?.length || 0) > 0 || (hit.directScore || 0) >= 6 || semMap.has(normFile);
            const cappedDeps = (!hasDirectTarget && deps.length > 2) ? deps.slice(0, 2) : deps;
            for (const d of cappedDeps) reverseDepsSet.add(d);
          } catch {}
        }

        const syms = (hit.matchedSymbols || []).slice(0, 3).map((s) => s.name).filter(Boolean);
        matchedFiles.push({
          file: normFile,
          lines: fileMaxLine,
          symbols: syms,
          dependentsCount: depCount,
          semanticScore: semMap.get(normFile) || 0,
        });
      }
    } catch {}
  }

  const totalReverseDependents = reverseDepsSet.size;
  let scopeTier = 'ISOLATED';

  if (signals.isReadOnlyQuestion && !signals.isModalAnalyticalQuestion) {
    scopeTier = 'READ_ONLY';
  } else if (
    matchedFiles.length >= 3 ||
    totalReverseDependents >= 4 ||
    maxFileLines >= 400 ||
    signals.isFollowUpMultiTarget
  ) {
    scopeTier = 'ARCHITECTURAL';
  } else if (
    matchedFiles.length === 2 ||
    totalReverseDependents >= 2 ||
    maxFileLines >= 180 ||
    signals.isAnalogyOrClone
  ) {
    scopeTier = 'COUPLED';
  } else if (
    matchedFiles.length === 0 &&
    (signals.isExtendExisting || signals.isAnalogyOrClone || signals.hasMutationVerb || signals.hasModalImplIntent)
  ) {
    scopeTier = 'UNKNOWN_NEEDS_SCOUT';
  }

  const needsScoutFirst =
    !signals.isReadOnlyQuestion &&
    (scopeTier === 'UNKNOWN_NEEDS_SCOUT' ||
      signals.isExtendExisting ||
      signals.isAnalogyOrClone ||
      scopeTier === 'COUPLED' ||
      scopeTier === 'ARCHITECTURAL');

  let scopeHint = '';
  if (signals.isReadOnlyQuestion) {
    if (matchedFiles.length > 0) {
      const fileSummaries = matchedFiles
        .slice(0, 3)
        .map((m) => `${m.file}(~${m.lines}L, deps:${m.dependentsCount})`)
        .join(', ');
      scopeHint = `💬 [Scope-Scout: READ_ONLY_MODAL] ${fileSummaries} | deps:${totalReverseDependents} (answer directly without ask_question)`;
    } else {
      scopeHint = '💬 [Intent: Read-Only Consultation] Answer directly without triggering code-edit Pre-Task Gate or UI Showroom.';
    }
  } else if (matchedFiles.length > 0) {
    const fileSummaries = matchedFiles
      .slice(0, 3)
      .map((m) => `${m.file}(~${m.lines}L, deps:${m.dependentsCount})`)
      .join(', ');
    scopeHint = `📊 [Scope-Scout: ${scopeTier}] ${fileSummaries} | deps:${totalReverseDependents}${needsScoutFirst ? ' (inspect slices before gate)' : ''}`;
  } else if (scopeTier === 'UNKNOWN_NEEDS_SCOUT' && wsPath && repoMapper) {
    scopeHint = '📊 [Scope-Scout: INSPECT_FIRST] Inspect relevant slices / ram_search before gate.';
  }

  return {
    scopeTier,
    matchedFiles,
    totalLines,
    maxFileLines,
    totalReverseDependents,
    needsScoutFirst,
    signals,
    scopeHint
  };
}

/**
 * Транслирует пользовательский промпт в компактное структурное досье для CLI (ag-cli context).
 * @param {string} [userPrompt=''] Текст запроса пользователя
 * @param {object} [options={}] Дополнительный контекст (wsPath, repoMapper, forceAlways)
 * @returns {{ matchedIds: string[], specs: string[], targetFiles: string[], contracts: string[], verifyHints: string[], formattedSpec: string, formatted: string }}
 */
export function compileUserIntentToTechSpec(userPrompt = '', { wsPath = '', repoMapper = null, forceAlways = false } = {}) {
  const promptText = typeof userPrompt === 'string' ? userPrompt.trim() : '';
  if (!promptText || (!forceAlways && promptText.length < 12) || detectPromptIntentSignals(promptText).isReadOnlyQuestion) {
    return { matchedIds: [], specs: [], targetFiles: [], contracts: [], verifyHints: [], formattedSpec: '', formatted: '' };
  }

  const matchedIds = [];
  const specs = [];
  for (const item of PLAIN_INTENT_SPECS) {
    if (item.rx.test(promptText)) {
      matchedIds.push(item.id);
      specs.push(item.spec);
      if (specs.length >= 3) break;
    }
  }

  const targetFiles = [];
  const targetFileSet = new Set();
  const contracts = [];
  const contractSet = new Set();
  const verifyHints = [];
  const verifySet = new Set();

  if (wsPath && repoMapper && typeof repoMapper.rankRepoByPageRank === 'function') {
    try {
      const ranked = repoMapper.rankRepoByPageRank(wsPath, promptText, { topK: 5 });
      for (const hit of (ranked?.rankedFiles || []).filter((rf) => rf.seedHits > 0).slice(0, 4)) {
        const syms = (hit.matchedSymbols || []).slice(0, 3).map((s) => s.name).filter(Boolean);
        for (const sym of syms) {
          if (!contractSet.has(sym) && contracts.length < 6) {
            contractSet.add(sym);
            contracts.push(sym);
          }
        }
        if (hit.file && !targetFileSet.has(hit.file) && targetFiles.length < 3) {
          targetFileSet.add(hit.file);
          targetFiles.push(syms.length > 0 ? `${hit.file}(${syms.slice(0, 2).join(',')})` : hit.file);
        }
        if (hit.file && /(?:^|\/)tests?\/|\.test\.|\.spec\./i.test(hit.file) && !verifySet.has(hit.file)) {
          verifySet.add(hit.file);
          verifyHints.push(hit.file);
        }
      }
    } catch {}
  }

  if (targetFiles.length < 4) {
    const explicitFiles = promptText.match(/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_./-]+\.[a-zA-Z]{1,6}/g) || [];
    for (const fileRef of explicitFiles) {
      if (!targetFileSet.has(fileRef) && targetFiles.length < 4) {
        targetFileSet.add(fileRef);
        targetFiles.push(fileRef);
      }
      if (/(?:^|\/)tests?\/|\.test\.|\.spec\./i.test(fileRef) && !verifySet.has(fileRef)) {
        verifySet.add(fileRef);
        verifyHints.push(fileRef);
      }
    }
  }

  if (contracts.length < 6) {
    const symScanText = promptText.length > 8000 ? promptText.slice(0, 8000) : promptText;
    const explicitSyms = symScanText.match(/\b[a-z][a-zA-Z0-9_]{3,}\b/g) || [];
    for (const sym of explicitSyms) {
      const isCamel = !sym.includes('_') && /[A-Z]/.test(sym);
      const isSnake = sym.includes('_') && !/[A-Z]/.test(sym) && !sym.endsWith('_') && !sym.includes('__');
      if (!isCamel && !isSnake) continue;
      if (!contractSet.has(sym) && contracts.length < 6) {
        contractSet.add(sym);
        contracts.push(sym);
      }
    }
  }

  if (verifyHints.length === 0 && (targetFiles.length > 0 || specs.length > 0 || forceAlways)) {
    verifyHints.push('run targeted unit tests / syntax check for touched files');
  }

  if (!forceAlways && specs.length === 0 && targetFiles.length === 0) {
    return { matchedIds: [], specs: [], targetFiles: [], contracts: [], verifyHints: [], formattedSpec: '', formatted: '' };
  }

  const lines = ['🧭 [Auto Tech Spec]:'];
  if (specs.length > 0) lines.push(`  • SPEC: ${specs.join(' ')}`);
  if (targetFiles.length > 0) lines.push(`  • TARGETS: ${targetFiles.join(', ')}`);
  if (contracts.length > 0) lines.push(`  • CONTRACTS: ${contracts.join(', ')}`);
  if (verifyHints.length > 0) lines.push(`  • VERIFY: ${verifyHints.join('; ')}`);
  const formattedSpec = lines.join('\n');
  return { matchedIds, specs, targetFiles, contracts, verifyHints, formattedSpec, formatted: formattedSpec };
}

const VOICE_FILLER_RX = /(?:^|[\s,.;:!?])(?:короче|смотри|слушай|в\s+общем|собственно|грубо\s+говоря|как[-\s]?то\s+так|и\s+так\s+далее|не\s+знаю\s+как\s+правильно|давай\s+сделаем\s+так|по\s+сути|типа|ну\s+вот)(?=$|[\s,.;:!?])/gi;

const ENTITY_PIVOT_RULES = [
  { rx: /(?:кэш|кеш|implicit\s*cache)/i, entities: ['metricCacheHitBadge', 'ramCacheEnabled'] },
  { rx: /(?:ревизор|критик|дифф)/i, entities: ['gpuPostEditCritic', 'chk-gpuPostEditCritic'] },
  { rx: /(?:чекпоинт|откат|тенев)/i, entities: ['shadowCheckpoints', 'createShadowCheckpoint'] },
  { rx: /(?:хрупк|надежност|байес)/i, entities: ['fragilityScore', 'evaluateBayesianRoute'] },
  { rx: /(?:рой|воркер|координатор)/i, entities: ['swarmMode', 'swarmWorkerTier'] },
  { rx: /(?:префикс|компакц|переполнен)/i, entities: ['historyCompaction', 'buildCacheAlignedInjection'] },
  { rx: /(?:панел|пульт|интерфейс|плашк)/i, entities: ['sidecars/panel/ui.html', 'sidecars/panel/server.mjs'] },
  { rx: /(?:срез|озу|памят)/i, entities: ['ram_slice', 'ram_context_pack'] },
];

/**
 * Compresses verbose conversational/voice-dictated Russian prompts (or any non-read-only task prompt when forceAlways=true)
 * into a compact English Execution Pivot with TARGETS, CONTRACTS, and VERIFY criteria.
 * @param {string} [userPrompt='']
 * @param {{ wsPath?: string, repoMapper?: object|null, maxChars?: number, forceAlways?: boolean }} [options={}]
 * @returns {{ triggered: boolean, cyrillicChars: number, enTerms: string[], targetFiles: string[], contracts: string[], verifyHints: string[], anchoredEntities: string[], formattedPivot: string, formatted: string }}
 */
export function compileVoiceOrLongRuPromptPivot(userPrompt = '', { wsPath = '', repoMapper = null, maxChars = 0, forceAlways = false } = {}) {
  const promptText = typeof userPrompt === 'string' ? userPrompt.trim() : '';
  const cyrMatches = promptText.match(/[а-яёА-ЯЁ]/g);
  const cyrillicChars = cyrMatches ? cyrMatches.length : 0;
  if (!promptText || (!forceAlways && cyrillicChars < 60) || detectPromptIntentSignals(promptText).isReadOnlyQuestion) {
    return { triggered: false, cyrillicChars, enTerms: [], targetFiles: [], contracts: [], verifyHints: [], anchoredEntities: [], formattedPivot: '', formatted: '' };
  }

  if (!forceAlways) {
    const fillerMatches = promptText.match(VOICE_FILLER_RX) || [];
    const isLongRu = cyrillicChars >= 550;
    const isVoiceRu = promptText.length >= 260 && fillerMatches.length >= 2;
    if (!isLongRu && !isVoiceRu) {
      return { triggered: false, cyrillicChars, enTerms: [], targetFiles: [], contracts: [], verifyHints: [], anchoredEntities: [], formattedPivot: '', formatted: '' };
    }
  }

  const lex = expandRuQueryToEnTerms(promptText, { maxTerms: 14 });
  const tech = compileUserIntentToTechSpec(promptText, { wsPath, repoMapper, forceAlways });
  const asciiTerms = Array.from(new Set(promptText.match(/\b[a-zA-Z_][a-zA-Z0-9_./-]{2,}\b/g) || [])).slice(0, 8);
  const enConceptList = Array.from(new Set([...lex.enTerms, ...asciiTerms])).slice(0, 12);

  const entitySet = new Set();
  for (const rule of ENTITY_PIVOT_RULES) {
    if (rule.rx.test(promptText)) {
      for (const ent of rule.entities) entitySet.add(ent);
    }
  }
  const anchoredEntities = Array.from(entitySet).slice(0, 6);

  const parts = ['🌐 [RU->EN Execution Pivot]:'];
  if (enConceptList.length > 0) {
    parts.push(`  • CONCEPTS: ${enConceptList.join(', ')}`);
  }
  if (anchoredEntities.length > 0) {
    parts.push(`  • ENTITIES: ${anchoredEntities.join(', ')}`);
  }
  if (tech.specs.length > 0) {
    parts.push(`  • INTENT: ${tech.specs.join(' ').slice(0, 180)}`);
  }
  if (tech.targetFiles.length > 0) {
    parts.push(`  • TARGETS: ${tech.targetFiles.join(', ')}`);
  }
  if (tech.contracts.length > 0) {
    parts.push(`  • CONTRACTS: ${tech.contracts.join(', ')}`);
  }
  if (tech.verifyHints.length > 0) {
    parts.push(`  • VERIFY: ${tech.verifyHints.join('; ')}`);
  }
  if (enConceptList.length === 0 && tech.specs.length === 0 && tech.targetFiles.length === 0 && tech.contracts.length === 0) {
    const stripped = promptText.replace(VOICE_FILLER_RX, ' ').replace(/\s+/g, ' ').trim();
    parts.push(`  • DISTILLED: ${stripped.slice(0, 160)}`);
  }

  let formattedPivot = parts.join('\n');
  const defaultCap = forceAlways ? 640 : 460;
  const cap = Math.max(180, Number(maxChars) || defaultCap);
  if (formattedPivot.length > cap) {
    formattedPivot = `${formattedPivot.slice(0, cap - 3)}...`;
  }
  return {
    triggered: true,
    cyrillicChars,
    enTerms: enConceptList,
    targetFiles: tech.targetFiles,
    contracts: tech.contracts,
    verifyHints: tech.verifyHints,
    anchoredEntities,
    formattedPivot,
    formatted: formattedPivot,
  };
}

/**
 * Классифицирует задачу пользователя по домену и определяет список инструментов для отсечения
 * @param {string} userPrompt Текст запроса пользователя
 * @param {object} [state={}] Состояние маршрутизатора из router-state.json
 * @param {object} [context={}] Дополнительный контекст (wsPath, repoMapper)
 * @returns {{ domain: string, prunedGroups: string[], allowedHint: string, compiledSpec?: object }}
 */
export function classifyTaskAndPruneTools(userPrompt = '', state = {}, context = {}) {
  if (!userPrompt || typeof userPrompt !== 'string' || state.toolPruning === false) {
    return {
      domain: 'general',
      prunedGroups: [],
      allowedHint: '',
      needsDesignPreviewGate: false,
      semanticSkills: [],
      matchedSkills: [],
    };
  }

  const promptText = userPrompt.trim();
  const scores = {
    algo_refactor: 0,
    ui_browser: 0,
    backend_db: 0,
    docs: 0,
    devops: 0
  };

  for (const [domain, patterns] of Object.entries(DOMAIN_PATTERNS)) {
    for (const pattern of patterns) {
      const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
      const matches = promptText.match(new RegExp(pattern.source, flags));
      if (matches) {
        scores[domain] += matches.length;
      }
    }
  }

  // Приоритет явного целевого артефакта документации (README, CHANGELOG, CONTRIBUTING, JSDoc, Mermaid, Гайд/Справочник)
  if (
    /(?:^\s*(?:напиши|оформи|составь|переведи|обнови|создай|добавь\s+в|опиши|нарисуй|сократи)(?:\s|$).*(?:readme|changelog|contributing|security\.md|jsdoc|mermaid|документаци|руководств|справочник|инструкци|гайд|мануал|шпаргал(?:к|ок)|глоссари|релиз[-\s]?ноутс|чек[-\s]?лист\s+готовност|стандарт\s+кодирования|обзорн[а-яё]*\s+стать|архитектурн[а-яё]*\s+записк|раздел\s+faq|таблиц[уы]\s+сравнени|сравнение\s+трех\s+режимов|сценарий\s+миграции\s+со\s+старой|спецификаци[юя]\s+протокола|внутреннее\s+устройство\s+кэширования\s+ast|описани[ея]\s+(?:пакета|всех\s+метрик|параметров|ошибок\s+в\s+конфигурационн)|примеры\s+(?:использования\s+cli|интеграции\s+хуков)|сообщения\s+об\s+ошибках\s+валидатора\s+на\s+русский|интерфейс\s+и\s+встроенные\s+подсказки\s+справки|понятную\s+справку\s+`?--help))/i.test(promptText)
  ) {
    scores.docs += 4;
  }

  // Приоритет явного целевого артефакта DevOps (Dockerfile, docker-compose, GitHub Actions, Nginx, K8s, systemd, PM2, CI)
  if (
    /(?:\b(?:dockerfile|docker-compose(?:\.yml)?|github\s+(?:actions?|secrets|packages)|kubernetes|k8s|helm|nginx|systemd|pm2|oomkilled|sigterm|buildkit|trivy|loki|promtail|wait-for-it|tmux|\.dockerignore|\.gitattributes|\.env\.example|makefile)\b|(?:кроссплатформенн[а-яё]*\s+бинарник[а-яё]*\s+в\s+ci|предкоммитн[а-яё]*\s+хук|ротац[а-яё]*\s+(?:и\s+архивац[а-яё]*\s+)?лог|перевод[а-яё]*\s+трафика|canary\s+rollout|симлинк[а-яё]*\s+релиза|самоподписанн[а-яё]*\s+сертификат|диагностик[аи]\s+окружения|регистраци[ия]\s+хуков\s+в\s+конфигурационн|профилирован[а-яё]*\s+времени\s+старта\s+всех\s+сервисов|конфликт\s+портов\s+при\s+параллельном|зашифрованн[а-яё]*\s+архив[а-яё]*\s+бэкапа|воркфлоу\s+для\s+автоматической\s+проверки.*при\s+пуше))/i.test(promptText)
  ) {
    scores.devops += 3;
  }

  // Fallback для чисто технических задач на исправление багов, утечек памяти, тестов и оптимизацию кода,
  // если в промпте нет специфических маркеров UI, БД, DevOps или Документации
  if (
    scores.ui_browser === 0 &&
    scores.backend_db === 0 &&
    scores.devops === 0 &&
    scores.docs === 0 &&
    /(?:\b(?:bug|fix|test|tests|unit|leak|memory|optimiz(?:e|ation)|logic|race\s+condition|deadlock|stack\s+overflow)\b|(?:баг|ошибк|почини|исправь|тест|юнит|утечк|памят|оптимиз|гонк[аи]|логик|валидац|парсер|сериализац|буфер|строк|массив|объект|функц|модул|таймер|кэш|конфиг))/i.test(promptText)
  ) {
    scores.algo_refactor += 2;
  }

  // Выбираем домен с наибольшим числом совпадений
  let selectedDomain = 'general';
  let maxScore = 0;
  const activeDomains = [];

  for (const [domain, score] of Object.entries(scores)) {
    if (score > 0) {
      activeDomains.push(domain);
    }
    if (score > maxScore) {
      maxScore = score;
      selectedDomain = domain;
    }
  }

  const signals = detectPromptIntentSignals(promptText);
  const skillModes = (state && typeof state.skillModes === 'object' && state.skillModes) ? state.skillModes : {};
  const disabledSkills = Object.entries(skillModes)
    .filter(([, mode]) => mode === 'off')
    .map(([id]) => id);
  const isSkillEnabled = (id) => skillModes[id] !== 'off';

  const LEXICAL_SKILL_RULES = [
    { slug: 'github-publish-guard', rx: /(?:\b(?:github|gh\s+release|git\s+push|git\s+tag|pre-publish)\b|(?:выгруз[а-яё]*\s+(?:на|в)\s+github|запуш[а-яё]*|опубликуй.*(?:релиз|github)|нумерац[а-яё]*\s+верси[ия]|актуальност[ьи]\s+верси|утечк[аи]\s+(?:секрет|путей)|перед\s+(?:пушем|публикац)))/i },
    { slug: 'programmatic-video-studio', rx: /(?:\b(?:remotion|hyperframes|gsap|mp4|webm)\b|(?:промо[-\s]?ролик|видео[-\s]?ролик|рендер[а-яё]*\s+видео|кинетическ[а-яё]*\s+типографик|анимац[а-яё]*\s+(?:ролик|видео|презентац|промо)))/i },
    { slug: 'ui-ux-design-system', rx: /(?:\b(?:css|scss|tailwind|showroom|ui\.html|styles\.css)\b|(?:дизайн|стил[ьиейя]|верстк|кноп(?:к|ок)|карточ(?:к|ек)|тем[ауы]|палитр|анимац|витрин|макет))/i, excludeRx: /(?:русифик|перевед[иу].*на\s+русск|локализац|\b(?:remotion|hyperframes|ffmpeg|mp4|webm|glsl|resolume|openfx|davinci)\b|(?:промо[-\s]?ролик|видео[-\s]?ролик|шейдер))/i },
    { slug: 'deep-stress-auditor', rx: /(?:sql[-\s]?инъекц|уязвим|\bcwe\b|\bredos\b|\bfuzz|фаззинг|стресс[-\s]?аудит|гонк[аи]|утечк[аи]\s+ресурс)/i },
    { slug: 'ast-codemod-refactor', rx: /(?:переименуй.*(?:модул|файл|везде|всех)|\bcodemod\b|массов[а-яё]*\s+замен)/i },
    { slug: 'program-slicer-ocd', rx: /(?:отследи\s+откуда|слайс\s+переменн|срез\s+переменн|\bdata[-\s]?flow\b|\bslice-variable\b)/i },
    { slug: 'delta-bug-minimizer', rx: /(?:минимизируй\s+входн|\bddmin\b|минимальн[а-яё]*\s+репро)/i },
    { slug: 'game-systems-architect', rx: /(?:боев[а-яё]*\s+экономик|прогресси[яю]\s+лута|\brpg\b|\broguelike\b|\btycoon\b|игров[а-яё]*\s+механик)/i },
    { slug: 'vj-video-fx-studio', rx: /(?:\bglsl\b|\bresolume\b|\bopenfx\b|\bdavinci\b|шейдер)/i },
    { slug: 'binary-app-localizer', rx: /(?:\bapp\.asar\b|\basar\b|русиф[а-яё]*\s+бинарн|переведи\s+меню\s+electron)/i },
    { slug: 'skill-architect', rx: /(?:\bskill\.md\b|отрицательн[а-яё]*\s+перенос|\baudit-skill\b)/i },
    { slug: 'context-fork', rx: /(?:\b(?:context[-\s]?fork|implicit\s+cache)\b|(?:экономи[яю]\s+токенов|сжать\s+контекст|переполнен[а-яё]*\s+контекст))/i },
    { slug: 'model-router', rx: /(?:бюджет\s+токенов|\brouter-state\.json\b|какая\s+модель\s+лучше)/i },
    { slug: 'playwright-cli', rx: /(?:\bplaywright[-\s]?cli\b|\bplaywright\b.*(?:e2e|тест|клик|снапшот|скриншот|мок)|(?:браузерн[а-яё]*\s+e2e|автотест[а-яё]*\s+в\s+браузере))/i },
  ];

  const rawSemanticSkills = Array.isArray(context?.semanticSkills) ? context.semanticSkills : [];
  const enabledSemanticSkills = rawSemanticSkills.filter((s) => s?.slug && isSkillEnabled(s.slug));
  const lexicalSkills = [];
  for (const rule of LEXICAL_SKILL_RULES) {
    if (!isSkillEnabled(rule.slug)) continue;
    if (rule.rx.test(promptText) && !(rule.excludeRx && rule.excludeRx.test(promptText))) {
      lexicalSkills.push({ slug: rule.slug, score: 0.55, deltaVsNone: 0.12, confident: true, source: 'lexical' });
    }
  }
  const combinedSkills = enabledSemanticSkills.length > 0 ? enabledSemanticSkills : lexicalSkills;
  const topSkill = combinedSkills[0] || null;
  const uiMatch = enabledSemanticSkills.find((s) => s.slug === 'ui-ux-design-system');
  const isSemanticUiDesign = Boolean(
    uiMatch &&
    (uiMatch.score ?? 0) >= 0.47 &&
    (uiMatch.deltaVsNone ?? 0.1) >= 0.04 &&
    (!topSkill || topSkill.slug === 'ui-ux-design-system' || (topSkill.score - uiMatch.score) <= 0.025)
  );
  const isLexicalUiDesign = Boolean(
    !signals.isReadOnlyQuestion &&
    (scores.ui_browser > 0 || /\.(?:css|scss|less|html|vue|svelte)\b/i.test(promptText)) &&
    /(?:дизайн|стил[ьиейя]|цвета?|палитр|тем[ауы]|анимац|верстк|карточ|кнопк|макет|витрин|перекрас|оформ)/i.test(promptText) &&
    (signals.hasMutationVerb || /(?:сверстай|оформи|обнови|добавь|сделай|создай|переделай|улучши|измени|поменяй)/i.test(promptText)) &&
    !/(?:русифик|перевед[иу]|локализац|\b(?:remotion|hyperframes|ffmpeg|mp4|webm|glsl|resolume|openfx|davinci)\b|(?:промо[-\s]?ролик|видео[-\s]?ролик|шейдер))/i.test(promptText)
  );

  const needsDesignPreviewGate =
    state.uiDesignPreviewGate !== false &&
    isSkillEnabled('ui-ux-design-system') &&
    !signals.isReadOnlyQuestion &&
    (isSemanticUiDesign || (!context?.skillIndexWarm && isLexicalUiDesign));
  const uiInspirationMode = (state.uiInspirationMode === 'showroom' || state.uiInspirationMode === 'web_refs')
    ? state.uiInspirationMode
    : 'ask';

  const hints = [];
  if (disabledSkills.length > 0) {
    hints.push(`🚫 [Disabled Skills: ${disabledSkills.join(', ')}] Do not activate disabled skills.`);
  }
  if (needsDesignPreviewGate) {
    const modeAction = uiInspirationMode === 'web_refs'
      ? 'ask target style in ask_question, find 5-6 open URLs via search_web, run fetch-web-refs.mjs (--artifact-dir "<artifactDir>" --limit 3 --build-showroom) for zero-LLM screenshots & DESIGN.md CSS tokens (use browser Model:"flash" <=2 URLs only if live JS interaction is required), and present cards in ui-variants-preview.md before coding.'
      : uiInspirationMode === 'showroom'
        ? 'ask target style in ask_question, render variant-A/B/C.png via build-showroom.mjs, and embed previews in ui-variants-preview.md before coding.'
        : 'ask 2-question source (A/B/C Showroom | Web Refs via fetch-web-refs.mjs | Hybrid | Direct) + target style poll in ask_question, then render previews or zero-LLM web reference cards in ui-variants-preview.md before coding.';
    hints.push(
      `🎨 [UI/UX Design Preview Gate] (uiInspirationMode: ${uiInspirationMode}) Read ui-ux-design-system SKILL.md first; ${modeAction}`
    );
  }
  if (
    !signals.isReadOnlyQuestion &&
    topSkill &&
    topSkill.confident !== false &&
    (topSkill.score ?? 0) >= 0.48 &&
    !(needsDesignPreviewGate && topSkill.slug === 'ui-ux-design-system')
  ) {
    const skillRef = typeof topSkill.skillFile === 'string' && topSkill.skillFile.trim()
      ? `Read ${topSkill.skillFile.trim()} if its workflow applies.`
      : `Read the "${topSkill.slug}" SKILL.md if its workflow applies.`;
    hints.push(
      topSkill.source === 'lexical'
        ? `🎯 [Skill Match: ${topSkill.slug}] ${skillRef}`
        : `🎯 [Semantic Skill Match: ${topSkill.slug} (${Math.round(topSkill.score * 100)}%)] ${skillRef}`
    );
  }

  return {
    domain: selectedDomain,
    prunedGroups: [],
    allowedHint: hints.join('\n'),
    compiledSpec: { matchedIds: [], specs: [], targetFiles: [], formattedSpec: '' },
    bm25Candidates: [],
    needsDesignPreviewGate: Boolean(needsDesignPreviewGate),
    semanticSkills: combinedSkills,
    matchedSkills: combinedSkills.map((s) => s.slug),
  };
}

/**
 * Вычисляет объективную структурную сложность задачи по графу кода и числу затронутых подсистем
 * (без опоры на количество букв/слов в промпте пользователя).
 * @param {object} scope Результат estimateCodebaseScope
 * @param {number} subsystemHits Число независимых функциональных подсистем
 * @param {object} signals Сигналы намерения
 * @param {boolean} isEditor Признак точечной правки
 * @param {boolean} hasExplicitArchitectKeyword Признак архитектурного проектирования
 * @param {boolean} isMultiFileScope Признак мульти-файлового охвата
 * @returns {{ grade: 'S'|'M'|'L'|'XL', phase: 'editor'|'architect'|'standard', structuralScore: number }}
 */
export function computeStructuralComplexity(opts = {}) {
  const {
    scope,
    subsystemHits = 0,
    signals = {},
    isEditor = false,
    hasExplicitArchitectKeyword = false,
    isMultiFileScope = false
  } = opts && typeof opts === 'object' ? opts : {};
  const safeSignals = signals && typeof signals === 'object' ? signals : {};
  if (safeSignals.isReadOnlyQuestion && !safeSignals.isModalAnalyticalQuestion && !hasExplicitArchitectKeyword) {
    return {
      grade: subsystemHits >= 2 ? 'M' : 'S',
      phase: 'standard',
      structuralScore: subsystemHits
    };
  }

  const filesCount = scope?.matchedFiles?.length || 0;
  const reverseDeps = scope?.totalReverseDependents || 0;
  const maxLines = scope?.maxFileLines || 0;

  // Объективный структурный индекс (Code-Graph + Subsystem Breadth, 0 зависимости от длины текста!)
  const fileWeight = filesCount * 1.8;
  const depWeight = reverseDeps * 1.2;
  const sizeWeight = Math.min(3.0, maxLines / 180);
  const subWeight = subsystemHits * 1.6;
  const multiBoost = isMultiFileScope ? 3.0 : 0;
  const archBoost = hasExplicitArchitectKeyword ? 3.5 : 0;

  const structuralScore = Number(
    (fileWeight + depWeight + sizeWeight + subWeight + multiBoost + archBoost).toFixed(2)
  );

  if (isEditor && !hasExplicitArchitectKeyword && filesCount <= 1 && reverseDeps <= 1 && subsystemHits <= 1) {
    return { grade: 'S', phase: 'editor', structuralScore };
  }

  if (
    structuralScore >= 8.5 ||
    (hasExplicitArchitectKeyword && (isMultiFileScope || filesCount >= 3 || reverseDeps >= 4 || subsystemHits >= 3))
  ) {
    return { grade: 'XL', phase: 'architect', structuralScore };
  }

  if (
    structuralScore >= 4.2 ||
    scope?.scopeTier === 'ARCHITECTURAL' ||
    hasExplicitArchitectKeyword ||
    subsystemHits >= 2 ||
    isMultiFileScope
  ) {
    return { grade: 'L', phase: 'architect', structuralScore };
  }

  if (
    structuralScore === 0 &&
    !signals.hasMutationVerb &&
    !signals.hasModalImplIntent &&
    !signals.isExtendExisting &&
    !signals.isAnalogyOrClone
  ) {
    return { grade: 'S', phase: 'standard', structuralScore };
  }

  return { grade: 'M', phase: 'standard', structuralScore };
}

/**
 * Очищает промпт от цитируемых названий кнопок, карточек и разделов интерфейса (например, «Дизайн витрины и превью UI»),
 * чтобы слова внутри заголовков UI-элементов не вызывали ложных архитектурных/исследовательских срабатываний.
 * @param {string} [promptText='']
 * @returns {string}
 */
export function stripUiTitlesForIntentClassification(promptText = '') {
  if (!promptText || typeof promptText !== 'string') return '';
  const stripQuoteIfLabel = (full, inner) => {
    if (/\b[\w.-]+\.(?:m?js|cjs|tsx?|jsx?|html|css|json|py|go|rs|md)\b/i.test(inner)) return full;
    if (/(?:спроектируй|редизайн|перепроектируй|архитектур|миграци|стресс[-\s]?аудит|с\s+нуля)/i.test(inner)) return full;
    return ' ';
  };
  return promptText
    .replace(/«([^»\r\n]{1,70})»/g, stripQuoteIfLabel)
    .replace(/“([^”\r\n]{1,70})”/g, stripQuoteIfLabel)
    .replace(/"([^"\r\n]{1,70})"/g, stripQuoteIfLabel)
    .replace(/дизайн[-\s]+витрин[а-яё]*(?:\s+и\s+превью\s+ui)?/gi, 'блок панели')
    .replace(/превью\s+ui/gi, 'блок панели');
}

/**
 * Вычисляет 3D-матрицу задачи (Ширина охвата Breadth × Когнитивная глубина Depth × Неопределённость/Риск RiskMode),
 * чтобы разделять прозрачную рутину, исследовательский поиск причины и критические узлы ядра (High-Blast).
 */
export function computeTask3DMatrix(rawOpts = {}) {
  const {
    promptText = '',
    scope = {},
    subsystemHits = 0,
    signals = {},
    isEditor = false,
    hasExplicitArchitectKeyword = false,
    isMultiFileScope = false,
    fragilityDepthBoost = 0,
  } = rawOpts && typeof rawOpts === 'object' ? rawOpts : {};
  if (signals?.isReadOnlyQuestion && !signals?.isModalAnalyticalQuestion && !hasExplicitArchitectKeyword) {
    return {
      breadth: 'narrow',
      depth: 'routine',
      riskMode: 'clear',
      isHighBlast: false,
      isExploratory: false,
      riskRu: 'Консультация',
      riskEn: 'Consultation',
      matrixId: 'read_only',
      tensorId: 'read_only',
      labelRu: 'Консультация (без правок кода)',
      labelEn: 'Consultation (read-only)',
      label3DRu: 'Консультация (без правок кода)',
      label3DEn: 'Consultation (read-only)',
      grade: subsystemHits >= 2 ? 'M' : 'S',
      phase: 'standard',
      isDeepAuditOrArch: false,
    };
  }

  const cleanIntentText = stripUiTitlesForIntentClassification(promptText);
  const filesCount = scope?.matchedFiles?.length || 0;
  const reverseDeps = scope?.totalReverseDependents || 0;
  const maxLines = scope?.maxFileLines || 0;

  // 1. Ось Ширины (Breadth: narrow | moderate | wide)
  let breadth = 'narrow';
  if (
    filesCount >= 4 ||
    (isMultiFileScope && (filesCount >= 2 || subsystemHits >= 2)) ||
    subsystemHits >= 3 ||
    (filesCount >= 3 && reverseDeps >= 5)
  ) {
    breadth = 'wide';
  } else if (
    filesCount >= 2 ||
    isMultiFileScope ||
    subsystemHits === 2 ||
    reverseDeps >= 3 ||
    maxLines >= 420
  ) {
    breadth = 'moderate';
  }

  // 2. Ось Глубины мысли (Depth: routine | integrated | deep_arch)
  const hasDeepCognitiveSignal =
    /\b(?:race\s+condition|deadlock|thread\s+starvation|memory\s+leak|prototype\s+pollution|sql\s+injection|xss|csrf|redos|aes-256-gcm|argon2id|idempoten(?:t|cy)|fenwick|dijkstra|pagerank|topological\s+sort|byzantine|lock-free)\b|(?:гонк[аи]\s*(?:потоков|состоян|данных|при|между)?|взаимн[а-яё]*\s+блокировк|утечк[аиу]\s+(?:памят|подключен|слушател)|плавающ[а-яё]*\s+баг|то\s+работает\s+то\s+нет|сложн[а-яё]*\s+баг|хитр[а-яё]*\s+баг|криптограф|шифрован.*тег|идемпотентн|поиск[а-яё]*\s+мостов|топологическ[а-яё]*\s+сортировк|глубок[а-яё]*\s+аудит)/i.test(cleanIntentText);

  const isMechanicalRoutine =
    !hasDeepCognitiveSignal &&
    !hasExplicitArchitectKeyword &&
    (isEditor ||
      /\b(?:codemod|rename\s+across|multi[- ]file\s+rename|bump\s+version)\b|(?:переименуй\s+.*во\s+всех|замени\s+.*во\s+всех|обнови\s+импорты\s+во\s+всех|однотипн[а-яё]*\s+правк|механическ[а-яё]*\s+правк|по\s+готовому\s+шаблону)/i.test(cleanIntentText));

  let depthRank = 0; // 0 = routine, 1 = integrated, 2 = deep_arch
  if (hasDeepCognitiveSignal || hasExplicitArchitectKeyword || (subsystemHits >= 3 && !isMechanicalRoutine)) {
    depthRank = 2;
  } else if (
    !isMechanicalRoutine &&
    (breadth !== 'narrow' || subsystemHits >= 1 || signals.isExtendExisting || signals.isAnalogyOrClone || reverseDeps >= 2)
  ) {
    depthRank = 1;
  }

  // Эскалация от Bayesian v2 / File Fragility при накопленных сбоях на целевых файлах
  if (fragilityDepthBoost > 0 && !isMechanicalRoutine) {
    depthRank = Math.min(2, depthRank + Number(fragilityDepthBoost));
  }

  const depth = depthRank >= 2 ? 'deep_arch' : (depthRank === 1 ? 'integrated' : 'routine');
  const matrixId = `${breadth}_${depth === 'deep_arch' ? 'deep' : depth}`;

  // 3. Ось Неопределённости и Риска (Z: clear | exploratory | critical_blast)
  const hasHighBlastSignal =
    /\b(?:migration|schema\s+change|breaking\s+change|security|auth|encryption|aes-256-gcm|sql\s+injection|xss|csrf|lock-free|atomic|state\s+format|hook-runner|safe-json)\b|(?:миграци|обратн[а-яё]*\s+совместимост|безопасност|авторизац|шифрован|критическ[а-яё]*\s+ядр|не\s+сломал|ничего\s+не\s+сломал|схем[ауы]\s+состоян|контракт[а-яё]*\s+между)/i.test(cleanIntentText);
  const isHighBlast = Boolean(reverseDeps >= 4 || fragilityDepthBoost > 0 || hasHighBlastSignal);

  const hasDiagnosticOrForkSignal =
    /\b(?:intermittent|flaky|mysterious|unknown\s+cause|root\s+cause|memory\s+leak|race\s+condition|deadlock|investigate|diagnose|ddmin|why\s+does\s+it|design|redesign|variants?|options?|trade-?offs?|architecture|from\s+scratch|best\s+way)\b|(?:плавающ[а-яё]*\s+баг|то\s+работает\s+то\s+нет|периодически\s+(?:падает|отваливается|зависает)|непонятно\s+почему|найди\s+(?:узкие\s+места|причину|утечку)|локализовать\s+баг|стресс[-\s]?аудит|дизайн|редизайн|вариант[ыаов]|с\s+нуля|спроектируй|перепроектируй|архитектур|какой\s+способ|несколько\s+вариантов)/i.test(cleanIntentText);
  const isExploratory = Boolean(!isMechanicalRoutine && (hasDeepCognitiveSignal || hasExplicitArchitectKeyword || hasDiagnosticOrForkSignal));

  const riskMode = isHighBlast ? 'critical_blast' : (isExploratory ? 'exploratory' : 'clear');
  const riskShort = riskMode === 'critical_blast' ? 'critical' : riskMode;
  const tensorId = `${matrixId}_${riskShort}`;

  const breadthRu = breadth === 'wide' ? 'Широкий охват' : (breadth === 'moderate' ? 'Средний охват' : 'Точечный охват');
  const breadthEn = breadth === 'wide' ? 'Wide Scope' : (breadth === 'moderate' ? 'Moderate Scope' : 'Narrow Scope');
  const depthRu = depth === 'deep_arch' ? 'Глубокая логика/архитектура' : (depth === 'integrated' ? 'Связная интеграция' : 'Типовая правка');
  const depthEn = depth === 'deep_arch' ? 'Deep Logic & Architecture' : (depth === 'integrated' ? 'Connected Integration' : 'Routine Edit');
  const riskRu = riskMode === 'critical_blast' ? 'Критическое ядро (High-Blast)' : (riskMode === 'exploratory' ? 'Поисковая/вариативная' : 'Прозрачная спека');
  const riskEn = riskMode === 'critical_blast' ? 'Critical Core (High-Blast)' : (riskMode === 'exploratory' ? 'Exploratory / Forks' : 'Clear Spec');
  const labelRu = `${breadthRu} × ${depthRu}`;
  const labelEn = `${breadthEn} × ${depthEn}`;
  const label3DRu = `${breadthRu} × ${depthRu} × ${riskRu}`;
  const label3DEn = `${breadthEn} × ${depthEn} × ${riskEn}`;

  let grade = 'M';
  let phase = 'standard';
  let isDeepAuditOrArch = false;

  if (breadth === 'wide' && depth === 'deep_arch') {
    grade = 'XL';
    phase = 'architect';
    isDeepAuditOrArch = true;
  } else if (breadth === 'wide' && depth === 'integrated') {
    grade = 'XL';
    phase = 'architect';
    isDeepAuditOrArch = false;
  } else if (breadth === 'wide' && depth === 'routine') {
    grade = 'L';
    phase = 'standard';
    isDeepAuditOrArch = false;
  } else if (depth === 'deep_arch') {
    // narrow_deep (1 файл со сложной гонкой/алгоритмом) или moderate_deep -> L с флагом глубокого анализа!
    grade = 'L';
    phase = 'architect';
    isDeepAuditOrArch = true;
  } else if (breadth === 'moderate' && depth === 'integrated') {
    grade = 'L';
    phase = 'architect';
  } else if (breadth === 'narrow' && depth === 'routine' && (isEditor || (filesCount <= 1 && subsystemHits === 0 && !signals.hasMutationVerb && !signals.hasModalImplIntent))) {
    grade = 'S';
    phase = isEditor ? 'editor' : 'standard';
  } else {
    grade = 'M';
    phase = 'standard';
  }

  // Эскалация grade по оси Z для связующих критических узлов
  if (isHighBlast && !isMechanicalRoutine && grade === 'M') {
    grade = 'L';
    phase = 'architect';
  }

  return {
    breadth,
    depth,
    riskMode,
    isHighBlast,
    isExploratory,
    riskRu,
    riskEn,
    matrixId,
    tensorId,
    labelRu,
    labelEn,
    label3DRu,
    label3DEn,
    grade,
    phase,
    isDeepAuditOrArch,
  };
}

/**
 * Обратно-совместимый алиас computeTask2DMatrix -> computeTask3DMatrix.
 */
export function computeTask2DMatrix(options = {}) {
  return computeTask3DMatrix(options);
}

/**
 * Генерирует контекстный 3D-рецепт адаптивных вариантов для ask_question
 * на основе координат 3D-матрицы, реально найденных файлов и обратных зависимостей.
 */
export function buildAdaptive3DOptionsBlueprint({
  matrix3D = null,
  scope = {},
  state = {},
  recModelRu = '',
  recModelEn = '',
  compiledSpec = null,
  grillSignal = null,
  hasSelectorMismatch = false,
  lang = '',
} = {}) {
  const uiLang = lang ? normalizeLang(lang, 'ru') : resolveStateLanguage(state, 'ru');
  const isEn = uiLang === 'en';
  const m = matrix3D || {};
  const tensorId = m.tensorId || m.matrixId || 'standard';
  const matchedFiles = Array.isArray(scope?.matchedFiles) ? scope.matchedFiles : [];
  const rawTargets = matchedFiles.length > 0
    ? matchedFiles.slice(0, 3).map((f) => String(f?.file || '').trim()).filter(Boolean)
    : (Array.isArray(compiledSpec?.targetFiles) ? compiledSpec.targetFiles.slice(0, 3) : []);
  const targetLabel = rawTargets.length > 0
    ? rawTargets.join(', ')
    : (isEn ? '<target files after slice>' : '<целевые файлы после среза>');
  const reverseDeps = Number(scope?.totalReverseDependents || 0);
  const swarmAllowed = m.breadth === 'wide' && state?.swarmMode !== 'off';
  const isProSub = state.subscriptionTier !== 'ultra';
  const modelTag = isEn
    ? (recModelEn || recModelRu || (isProSub
        ? 'Orchestrator (Neon · High)'
        : 'Orchestrator (Neon · High) / Orchestrator (Carbon · Medium/High)'))
    : (recModelRu || (isProSub
        ? 'Orchestrator (Neon · Высокий)'
        : 'Orchestrator (Neon · Высокий) / Orchestrator (Carbon · Средний/Высокий)'));

  let slots;
  if ((m.depth === 'deep_arch' && m.breadth !== 'wide') || (m.riskMode === 'exploratory' && m.breadth === 'narrow')) {
    slots = isEn
      ? [
          `(Recommended) Pinpoint root cause in ${targetLabel} (slicing/ddmin), apply surgical fix, and verify with micro-tests (${modelTag})`,
          'Diagnostics only (read-only): find exact root cause and show 2 patch options in chat without editing disk',
          'Deep stress audit across coupled nodes for races & edge bugs with auto-fix (deep-stress-auditor + tests)',
        ]
      : [
          `(Recommended) Локализовать корень в ${targetLabel} (слайсинг/ddmin), внести точечный фикс и проверить микро-тестами (${modelTag})`,
          `Только диагностика (read-only): найти точную причину и показать 2 варианта патча в чате без правок на диске`,
          `Усиленный стресс-аудит смежных узлов на гонки и краевые баги с авто-фиксом (deep-stress-auditor + тесты)`,
        ];
  } else if (m.breadth === 'wide' && m.depth === 'routine' && !m.isHighBlast) {
    slots = isEn
      ? [
          `(Recommended) Batch refactor across ${targetLabel} (ast-codemod-refactor${swarmAllowed ? ' / parallel /swarm on Hydrogen' : ''}) + syntax checks (${modelTag})`,
          'Sequential per-file diff pass using a single model without Swarm (quota-saver, strict manual control)',
          'Dry-run first: preview complete replacement list before writing to disk',
        ]
      : [
          `(Recommended) Пакетный рефакторинг по ${targetLabel} (ast-codemod-refactor${swarmAllowed ? ' / параллельный /swarm на Hydrogen' : ''}) + проверка синтаксиса (${modelTag})`,
          `Последовательный пофайловый дифф-проход одной моделью без роя (экономно по квоте, строгий контроль)`,
          `Сухой прогон (dry-run): сначала показать полный список точек замены без записи на диск`,
        ];
  } else if (m.riskMode === 'critical_blast') {
    const depsNoteRu = reverseDeps > 0 ? `${reverseDeps} связей` : 'контракты ядра';
    const depsNoteEn = reverseDeps > 0 ? `${reverseDeps} reverse deps` : 'core contracts';
    slots = isEn
      ? [
          `(Recommended) Backward-compatible update of ${targetLabel} (${depsNoteEn}) + run impacted tests (${modelTag})`,
          `Isolated contour: edit in workspace:"share" sandbox${swarmAllowed ? ' (/swarm)' : ''} + independent @verifier contract review before merge`,
          'Minimal-invasive patch to the core node only without restructuring neighbor modules (lowest regression risk)',
        ]
      : [
          `(Recommended) Аккуратное обновление ${targetLabel} с сохранением совместимости (${depsNoteRu}) + прогон затронутых тестов (${modelTag})`,
          `Изолированный контур: правка в песочнице workspace:"share"${swarmAllowed ? ' (/swarm)' : ''} + независимая ревизия контрактов @verifier перед слиянием`,
          `Минимально-инвазивный патч только ключевого узла без перестройки соседних модулей (минимум риска регрессии)`,
        ];
  } else if (m.breadth === 'wide') {
    slots = isEn
      ? [
          `(Recommended) Phased architecture (${modelTag}): unified contract for ${targetLabel} -> implementation & E2E tests`,
          'Parallel module assembly in share branches (/swarm on Hydrogen) + final @verifier architecture review',
          'Contract design & plan decomposition only first without modifying source files',
        ]
      : [
          `(Recommended) Поэтапная архитектура (${modelTag}): единый контракт для ${targetLabel} → реализация и сквозные тесты`,
          `Параллельная сборка модулей в share-ветках (/swarm на Hydrogen) + финальная приёмка архитектором @verifier`,
          `Сначала только проектирование контрактов и декомпозиция плана без изменения кода`,
        ];
  } else {
    slots = isEn
      ? [
          `(Recommended) Targeted implementation in ${targetLabel} matching repo conventions + automated tests (${modelTag})`,
          'Extended pass: update adjacent contracts and cover boundary edge cases with tests',
          'Compact minimal patch covering core logic only (fast & token-efficient)',
        ]
      : [
          `(Recommended) Целевая реализация в ${targetLabel} по текущим конвенциям проекта + авто-тесты (${modelTag})`,
          `Расширенный вариант: попутно обновить смежные контракты и покрыть граничные случаи тестами`,
          `Компактный минимальный патч только основной логики (быстро и экономно по токенам)`,
        ];
  }

  const grillGateSuffix = grillSignal?.mode === 'offer_in_gate'
    ? (isEn
        ? ' | + Add 2nd compact ask_question item: "Run a clarifying interview (Grill-Me) on decision-tree forks and edge cases first?" with options: "(Recommended) No, spec is clear — proceed with the selected plan" | "Yes, blitz interview (1 round on main forks)" | "Yes, full Grill-Me interview (decision tree + record in SPEC.md)".'
        : ' | + Add 2nd compact ask_question item: "Нужен ли детальный опрос (Grill-Me) по развилкам и краевым случаям перед выполнением?" with options: "(Recommended) Нет, ТЗ понятное — сразу выполнять выбранный план" | "Да, блиц-опрос (1 раунд по главным спорным развилкам)" | "Да, полный Grill-Me (дерево решений + фиксация в SPEC.md)".')
    : '';
  const modelSwitchGateSuffix = hasSelectorMismatch
    ? (isEn
        ? ` | + If you still open ask_question (e.g. for architectural forks) while model differs, include option: "⏸ End turn so I can switch model to ${modelTag}" (if chosen — do not edit, confirm direction in 1 line, and end the turn to unlock the selector).`
        : ` | + Если всё же открываешь ask_question (например, нужны развилки архитектуры) при несовпадении модели, добавь вариант: "⏸ Завершить ход, чтобы я переключил модель на ${modelTag}" (при выборе этого варианта — ничего не правь, подтверди направление 1 строкой и заверши ход для разблокировки селектора).`)
    : '';
  const formattedBlueprint = isEn
    ? `🧩 [3D Adaptive Options Blueprint (${tensorId})]: Synthesize 3 task-specific EN options AFTER code inspection, reflecting YOUR post-scout optimal model in option #1 and naming REAL inspected files & trade-offs (NEVER copy static clichés or blind pre-estimates): 1) ${slots[0]} | 2) ${slots[1]} | 3) ${slots[2]}${grillGateSuffix}${modelSwitchGateSuffix}`
    : `🧩 [3D Adaptive Options Blueprint (${tensorId})]: Synthesize 3 task-specific RU options AFTER code inspection, reflecting YOUR post-scout optimal model in option #1 and naming REAL inspected files & trade-offs (NEVER copy static clichés or blind pre-estimates): 1) ${slots[0]} | 2) ${slots[1]} | 3) ${slots[2]}${grillGateSuffix}${modelSwitchGateSuffix}`;

  return {
    tensorId,
    targetLabel,
    slots,
    formattedBlueprint,
  };
}

/**
 * Detects whether a task warrants Grill-Me design-tree frontier interviewing (explicit trigger, state mode, or exploratory M+/L/XL).
 * @param {string} [promptText='']
 * @param {object|null} [matrix3D=null]
 * @param {object} [state={}]
 * @returns {{ active: boolean, mode: 'off'|'explicit'|'always'|'offer_in_gate'|'none', reason: string }}
 */
export function detectGrillMeSignals(promptText = '', matrix3D = null, state = {}) {
  const text = typeof promptText === 'string' ? promptText.trim() : '';
  const grillMode = state?.grillMode === 'off' || state?.grillMode === 'always' ? state.grillMode : 'auto';
  const explicitHit = /\[grill-me[^\]]*\]|(?:^|\s)\/grill-me\b|детальн\w+\s+опрос|подробн\w+\s+интервью|расспроси\s+меня|задай\s+уточняющ/i.test(text);
  if (explicitHit) {
    return { active: true, mode: 'explicit', reason: 'explicit_prompt_trigger' };
  }
  if (grillMode === 'off') {
    return { active: false, mode: 'off', reason: 'state_off' };
  }
  const isReadOnly = Boolean(matrix3D?.riskRu === 'Консультация');
  if (grillMode === 'always' && !isReadOnly) {
    return { active: true, mode: 'always', reason: 'state_always' };
  }
  const grade = matrix3D?.grade || 'M';
  const isFeatureOrExploratory =
    Boolean(matrix3D?.isExploratory) ||
    grade === 'L' ||
    grade === 'XL' ||
    /(?:с\s+нуля|нов(?:ую|ый|ое)\s+(?:фич|модул|систем|страниц|приложен)|спроектир\w+|придумай)/i.test(text);
  if (!isReadOnly && isFeatureOrExploratory) {
    return { active: true, mode: 'offer_in_gate', reason: 'auto_exploratory_or_large' };
  }
  return { active: false, mode: 'none', reason: 'clear_routine' };
}

/**
 * Formats the Grill-Me Design-Tree Frontier directive when interview mode is active or offered.
 * @param {{ grillSignal?: object, grade?: string, matrix3D?: object }} [opts={}]
 * @returns {string}
 */
export function buildGrillMeDirective({ grillSignal = null, grade = 'M', lang = 'ru' } = {}) {
  const mode = grillSignal?.mode || 'none';
  const langLabel = normalizeLang(lang, 'ru') === 'en' ? 'EN' : 'RU';
  if (mode === 'explicit' || mode === 'always') {
    const specHint = (grade === 'L' || grade === 'XL')
      ? ' Record settled decisions in SPEC.md or Pinned Decisions before editing.'
      : '';
    return `🔥 [Grill-Me Design-Tree Frontier: ACTIVE (${mode})] (1) Look up repository facts yourself via RAM/slices (never ask the user codebase facts); (2) Map unsettled product/architecture forks as a decision tree and ask ONLY the current independent frontier (2–3 concise ${langLabel} questions per round via ask_question, option #1 "(Recommended)"); (3) Repeat until frontier is clear before coding.${specHint}`;
  }
  if (mode === 'offer_in_gate') {
    return '🔥 [Grill-Me Available] Pre-Task Gate offers optional Grill-Me design-tree interview; launch frontier questioning only if user selects it.';
  }
  return '';
}

/**
 * Оценивает масштаб задачи (S/M/L/XL + 2D-матрица Breadth × Depth), рабочую фазу (editor/architect/standard)
 * и формулирует директиву для модели.
 * @param {string} userPrompt Запрос пользователя
 * @param {object} [state={}] Состояние маршрутизатора
 * @param {object} [context={}] Контекст рабочей области (wsPath, repoMapper, semanticFiles, fragilityDepthBoost)
 */
/**
 * Builds an adaptive Chain-of-Draft / Counterfactual reasoning directive scaled to the 3D Task Tensor.
 * @param {object} [matrix3D={}]
 * @param {object|null} [modelProfile=null]
 * @returns {string}
 */
export function buildAdaptiveReasoningDirective(matrix3D = {}, modelProfile = null) {
  const grade = matrix3D?.grade || 'M';
  const depth = matrix3D?.depth || 'integrated';
  const risk = matrix3D?.riskMode || matrix3D?.risk || 'clear';
  if (grade === 'S' || depth === 'routine') {
    const isNeonPlannerOrStandalone =
      modelProfile?.isNeon || (modelProfile?.isOrchestrator && modelProfile?.plannerTier === 'neon');
    const neonVerbosityCap =
      isNeonPlannerOrStandalone && (modelProfile.thinkingLevel === 'high' || modelProfile.thinkingLevel === 'xhigh')
        ? ' (cap Neon thinking verbosity — output billed at $15/1M)'
        : '';
    return `⚡ [AdaptThink / CoD] Keep internal thinking ultra-compact (<=6 words/step: target -> invariant -> patch); skip code narration.${neonVerbosityCap}`;
  }
  if (depth === 'deep_arch' || risk === 'critical_blast') {
    return '🧠 [Counterfactual Gate] Before editing, verify 1 falsification edge-case (what input/race breaks this change?) and preserve exported contracts.';
  }
  return '🔗 [Contract CoD] Trace signature -> callers -> edge-cases concisely in EN.';
}

export function estimateTaskGradeAndThinkingBudget(userPrompt = '', state = {}, context = {}) {
  if (state.thinkingLimiter === false || !userPrompt || typeof userPrompt !== 'string' || !userPrompt.trim()) {
    return { grade: 'M', phase: 'standard', budgetHint: '', maxSteps: 0 };
  }

  const promptText = userPrompt.trim();
  const cleanIntentText = stripUiTitlesForIntentClassification(promptText);
  const scope = context?.precomputedScope || estimateCodebaseScope(promptText, context);
  const { signals } = scope;

  // Паттерны фазы Редактора (точечные правки, коммиты, опечатки, применение готового плана)
  const editorPatterns = [
    /\b(?:edit|fix\s+line|typo|rename|commit|git\s+commit|patch|apply\s+plan|replace\s+string|one\s+line)\b/i,
    /(?:точечн|поправь\s+опечатк|исправь\s+опечатк|переименуй|закоммить|коммит|примени\s+план|замени\s+строк|исправь\s+строк|поправь\s+синтаксис)/i
  ];

  // Паттерны архитектурного масштаба (системное проектирование, мульти-модульность, миграция, сквозной аудит)
  const architectPatterns = [
    /\b(?:architect(?:ure)?|redesign|multi[- ]module|system\s+design|reverse(?:-engineering)?|audit|security\s+audit|stress[- ]?test|stress[- ]?audit|algorithm\s+from\s+scratch|scale|migration|design\s+plan|implementation\s+plan|decompose|roadmap)\b/i,
    /(?:спроектируй|архитектур|мульти-модул|системн|реверс(?:-инжиниринг)?|аудит|стресс[-\s]?тест|большие\s+тесты|узкие\s+места|масштаб|с\s+нуля|перепроектируй|редизайн|нормальн[а-яё]*\s+дизайн|миграци|комплексн|сквозн|составь\s+план|спланируй|план\s+реализац|продумай\s+план|декомпозир|русифи(?:ц|к)[а-яё]*\s+(?:десктопн[а-яё]*\s+)?(?:программ|приложен))/i
  ];

  // Независимые функциональные подсистемы, затронутые в задаче
  const subsystemHits = [
    /(?:дизайн|интерфейс|верстк|стил(?:[ьияюем]|ев|изац)(?!\s+код)|ui|ux)/i,
    /(?:анимац|эффект(?!ивн)|частиц|шейдер|vfx)/i,
    /(?:прогресс|уров(?:ен[ь]|н[яеиюей])\s+(?:игрок|персонаж|опыт|xp|наград)|престиж|баланс(?:[ауеом]|(?=$|[^а-яё]))(?!\s*(?:скобок|дерев|нагрузк|между|качества|токенов))|экономик|ордер)/i,
    /(?:тест|аудит|верифик|стресс)/i,
    /(?:баз[аыеуой]\s+данных|сервер|бэкенд|апи|api|транзакц|миграц)/i,
    /(?:монтаж|таймлайн|субтитр|давинчи|аудио|звук)/i
  ].filter((rx) => rx.test(cleanIntentText)).length;

  const isMultiFileScope =
    /\b(?:all\s+files|across\s+files|multi[- ]file|everywhere)\b|(?:во\s+всех|нескольких\s+файл|по\s+всему\s+проект|во\s+всех\s+модул|везде|несколько\s+модулей|всех\s+модул|всей\s+систем)/i.test(cleanIntentText) ||
    signals.isFollowUpMultiTarget;
  const isEditor = editorPatterns.some((p) => p.test(cleanIntentText)) && !isMultiFileScope;
  const hasExplicitArchitectKeyword = architectPatterns.some((p) => p.test(cleanIntentText));

  const { structuralScore } = computeStructuralComplexity({
    scope,
    subsystemHits,
    signals,
    isEditor,
    hasExplicitArchitectKeyword,
    isMultiFileScope
  });

  const matrix3D = computeTask3DMatrix({
    promptText,
    scope,
    subsystemHits,
    signals,
    isEditor,
    hasExplicitArchitectKeyword,
    isMultiFileScope,
    fragilityDepthBoost: Number(context?.fragilityDepthBoost || 0),
  });

  if (signals.isPlanReview) {
    const prevGrade = context?.prevTurnGrade || 'M';
    const prevMatrix = context?.prevTurnMatrix || matrix3D;
    return {
      grade: prevGrade,
      phase: 'standard',
      budgetHint: `🔎 [Orchestrator Plan Review (${prevGrade})] Compare executor changes against the plan and tests — call exit_plan_mode for remaining fixes or conclude directly if verified (do NOT trigger ask_question Pre-Task Gate).`,
      maxSteps: 0,
      scope,
      structuralScore: 0,
      subsystemHits: 0,
      matrix2D: prevMatrix,
      matrix3D: prevMatrix,
      optionsBlueprint: null,
      selectorEval: { match: 'optimal', tipRu: '' },
      compiledSpec: { matchedIds: [], specs: [], targetFiles: [], formattedSpec: '', formatted: '' },
      isReadOnlyQuestion: true,
      isPlanReview: true,
      isApprovalFollowUp: false,
    };
  }

  if (
    signals.isApprovalFollowUp &&
    !signals.isArtifactDocApproval &&
    !/^A1\s*:/i.test(promptText) &&
    context?.prevAskQuestionCalled === false &&
    !context?.prevModelSwitchPending &&
    state.confirmBeforeRun !== false
  ) {
    const effectiveFollowGrade =
      context?.prevProposedGrade ||
      (context?.prevTurnGrade && context.prevTurnGrade !== 'S' ? context.prevTurnGrade : null) ||
      (context?.prevWasReadOnly ? 'M' : matrix3D.grade) ||
      'M';
    const followGatePolicy = resolveEffectivePreTaskGatePolicy({
      state,
      modelProfile: context?.modelProfile || null,
      grade: effectiveFollowGrade,
    });
    const prevMatrix = context?.prevTurnMatrix || matrix3D;
    if (followGatePolicy.shouldAskModelGate) {
      return {
        grade: effectiveFollowGrade,
        phase: 'standard',
        budgetHint: `🗳️ [Two-Phase Plan Gate (${effectiveFollowGrade})] Previous turn was a text-only discussion without an ask_question popup (gateAsked=false). Before editing files, MUST call ask_question NOW so the user can choose the exact implementation options/modules in the interactive popup menu; after they answer, execute immediately.`,
        maxSteps: 0,
        scope,
        structuralScore,
        subsystemHits,
        matrix2D: prevMatrix,
        matrix3D: prevMatrix,
        optionsBlueprint: null,
        selectorEval: { match: 'optimal', tipRu: '' },
        compiledSpec: { matchedIds: [], specs: [], targetFiles: [], formattedSpec: '', formatted: '' },
        isReadOnlyQuestion: false,
        isApprovalFollowUp: false,
        requiresTwoPhaseGate: true,
      };
    }
  }

  if (
    signals.isApprovalFollowUp &&
    (signals.isArtifactDocApproval ||
      /^A1\s*:/i.test(promptText) ||
      context?.prevModelSwitchPending === true ||
      context?.prevAskQuestionCalled === true ||
      (context?.prevAskQuestionCalled === undefined &&
        (context?.prevTurnGrade === 'L' || context?.prevTurnGrade === 'XL')))
  ) {
    const prevGrade =
      (context?.prevTurnGrade && context.prevTurnGrade !== 'S' ? context.prevTurnGrade : null) ||
      context?.prevProposedGrade ||
      context?.prevTurnGrade ||
      matrix3D.grade ||
      'M';
    const prevMatrix = context?.prevTurnMatrix || matrix3D;
    const isModelSwitchResume = Boolean(context?.prevModelSwitchPending);
    return {
      grade: prevGrade,
      phase: 'standard',
      budgetHint: isModelSwitchResume
        ? `🚀 [Plan Approved Follow-Up (${prevGrade}) | Model-Switch Resumed] User switched model / confirmed the proposed plan after Model-Switch Pause — proceed directly with execution without repeating ask_question.`
        : `🚀 [Plan Approved Follow-Up (${prevGrade})] User confirmed the proposed plan — proceed directly with execution without repeating ask_question.`,
      maxSteps: 0,
      scope,
      structuralScore,
      subsystemHits,
      matrix2D: prevMatrix,
      matrix3D: prevMatrix,
      optionsBlueprint: null,
      selectorEval: { match: 'optimal', tipRu: '' },
      compiledSpec: { matchedIds: [], specs: [], targetFiles: [], formattedSpec: '', formatted: '' },
      isReadOnlyQuestion: false,
      isApprovalFollowUp: true,
      modelSwitchSplitTurn: false,
    };
  }

  const uiLang = resolveStateLanguage(state, 'ru');
  const isEnUi = uiLang === 'en';
  const { grade, phase, isDeepAuditOrArch } = matrix3D;
  const modelProfile = context?.modelProfile || null;
  const evalComplexity = !signals.isReadOnlyQuestion || Boolean(signals.isModalAnalyticalQuestion);
  const selectorSnapshot = evalComplexity ? formatSelectorSnapshotForPrompt(modelProfile, uiLang) : '';
  const selectorEval = evaluateSelectorMatchForTask({ modelProfile, grade, isDeepAuditOrArch, matrix2D: matrix3D, state });
  const recModelRu = selectorEval.recommendedRu || 'Hydrogen · Средний/Высокий или Orchestrator (Neon · Средний/Высокий)';
  const recModelEn = selectorEval.recommendedEn || 'Hydrogen · Medium/High or Orchestrator (Neon · Medium/High)';
  const recModel = isEnUi ? recModelEn : recModelRu;
  const evalTip = isEnUi ? (selectorEval.tipEn || selectorEval.tipRu) : selectorEval.tipRu;
  const label3D = isEnUi ? (matrix3D.label3DEn || matrix3D.label3DRu) : matrix3D.label3DRu;
  const gatePolicy = !signals.isReadOnlyQuestion
    ? resolveEffectivePreTaskGatePolicy({ state, modelProfile, grade })
    : { shouldAskModelGate: false, effectiveThreshold: 'OFF', orchestratorBypassSM: false };
  const autoSpecMode = resolveAutoSpecMode(promptText, state);
  const autoSpecOutput = resolveAutoSpecOutput(promptText, state);
  const compiledSpec = !signals.isReadOnlyQuestion
    ? compileUserIntentToTechSpec(promptText, {
        wsPath: context?.wsPath || '',
        repoMapper: context?.repoMapper || null,
        forceAlways: autoSpecMode === 'always',
      })
    : { matchedIds: [], specs: [], targetFiles: [], contracts: [], verifyHints: [], formattedSpec: '', formatted: '' };

  const grillSignal = detectGrillMeSignals(promptText, matrix3D, state);
  const grillDirective = buildGrillMeDirective({ grillSignal, grade, matrix3D, lang: uiLang });
  const autoSpecDirective = buildAutoSpecDirective({
    mode: autoSpecMode,
    output: autoSpecOutput,
    grade,
    isReadOnlyQuestion: Boolean(signals.isReadOnlyQuestion),
    isDeepAuditOrArch: Boolean(isDeepAuditOrArch),
  });

  let budgetHint = '';
  let optionsBlueprint = null;
  let modelSwitchSplitTurn = false;
  const isProSub = String(state?.subscriptionTier || '').trim().toLowerCase() === 'pro';
  const subTag = isProSub ? 'Sub: Pro (max: Neon, no Carbon)' : 'Sub: Ultra';
  const modelExamples = isEnUi
    ? (isProSub
        ? 'Hydrogen · Medium/High, Neon · High/XHigh, or Orchestrator (Neon · Medium/High/XHigh)'
        : 'Hydrogen · Medium/High, Carbon · High, Orchestrator (Neon · Medium/High/XHigh), or Orchestrator (Carbon · Medium/High)')
    : (isProSub
        ? 'Hydrogen · Средний/Высокий, Neon · Высокий/XHigh, or Orchestrator (Neon · Средний/Высокий/XHigh)'
        : 'Hydrogen · Средний/Высокий, Carbon · Высокий, Orchestrator (Neon · Средний/Высокий/XHigh), or Orchestrator (Carbon · Средний/Высокий)');
  const noBareRuleEn = isProSub
    ? 'NEVER write bare Hydrogen/Neon or bare Orchestrator (Neon) without depth; NEVER recommend Carbon on Pro'
    : 'NEVER write bare Hydrogen/Neon/Carbon or bare Orchestrator (Neon/Carbon) without depth';
  const replyLangCode = isEnUi ? 'EN' : 'RU';
  if (signals.isReadOnlyQuestion) {
    if (signals.isModalAnalyticalQuestion) {
      const lines = [
        `💬 [Read-Only / Modal Triage: ${label3D} (${matrix3D.tensorId} -> pre-read ~${grade})${selectorSnapshot ? ` | ${selectorSnapshot}` : ''} | ${subTag} | Optimal: ${recModel}]`,
        `Reply directly in ${replyLangCode} without ask_question. If your answer proposes code changes or implementation, MUST end with preliminary scope (S/M/L/XL), affected files, and recommended model with explicit thinking/planner depth (${recModel}; ${noBareRuleEn}).`,
      ];
      if (evalTip) {
        lines.push(`🎚️ [Pre-Read Selector Hint (re-verify after code read)] ${evalTip}`);
      }
      if (scope.scopeHint) {
        lines.push(scope.scopeHint);
      }
      if (grillSignal.mode === 'explicit' && grillDirective) {
        lines.push(grillDirective);
      }
      budgetHint = lines.join('\n');
    } else {
      const baseReadOnly = `💬 [Read-Only] (${subTag} | Optimal: ${recModel}) Reply directly in ${replyLangCode} without ask_question. If your answer proposes code changes or implementation, MUST end with preliminary scope (S/M/L/XL), affected files, and recommended model with explicit thinking/planner depth (${recModel}; ${noBareRuleEn}).`;
      budgetHint = (grillSignal.mode === 'explicit' && grillDirective) ? `${baseReadOnly}\n${grillDirective}` : baseReadOnly;
    }
  } else {
    const strategyTag =
      state.strategy === 'economy' || state.strategy === 'performance' || state.strategy === 'pro_architect'
        ? ` | Strategy: ${state.strategy}`
        : '';
    const silentTag = state.confirmBeforeRun === false
      ? ` | Silent Autopilot (${state.strategy || 'balanced'}/${gatePolicy.effectiveThreshold || state.heavyThreshold || 'XL'})`
      : '';
    const modeNote = `${gatePolicy.orchestratorBypassSM ? ' | Smart-Synergy: skip S/M gate' : silentTag}${!silentTag ? strategyTag : ''}`;
    const lines = [
      `🧭 [3D Triage: ${label3D} (${matrix3D.tensorId} -> pre-read ~${grade})${selectorSnapshot ? ` | ${selectorSnapshot}` : ''} | ${subTag} | Optimal: ${recModel}${modeNote}]`,
      buildAdaptiveReasoningDirective(matrix3D, modelProfile),
    ];
    if (autoSpecDirective) {
      lines.push(autoSpecDirective);
    }
    if (evalTip) {
      lines.push(`🎚️ [Pre-Read Selector Hint (re-verify after code read)] ${evalTip}`);
    }
    if (grillDirective && grillSignal.mode !== 'offer_in_gate') {
      lines.push(grillDirective);
    }
    if (gatePolicy.shouldAskModelGate || (state.confirmBeforeRun !== false && isDeepAuditOrArch)) {
      const hasSelectorMismatch = Boolean(selectorEval && selectorEval.match && selectorEval.match !== 'optimal' && evalTip);
      modelSwitchSplitTurn = hasSelectorMismatch;
      optionsBlueprint = buildAdaptive3DOptionsBlueprint({
        matrix3D,
        scope,
        state,
        recModelRu,
        recModelEn,
        compiledSpec,
        grillSignal,
        hasSelectorMismatch,
        lang: uiLang,
      });
      lines.push(
        isEnUi
          ? `🚦 [Pre-Task Gate: ON (${grade})] Inspect target slices FIRST, then determine the TRUE post-scout grade (S/M/L/XL) & optimal model WITH explicit thinking/planner depth (e.g. ${modelExamples} — ${noBareRuleEn}) from actual code (override pre-read ~${grade} if code is simpler or deeper!) and reflect YOUR AI verdict identically in EN chat, ask_question header ("Scope", "Recommended power", + "💡 Mode tip" on mismatch), and option #1.`
          : `🚦 [Pre-Task Gate: ON (${grade})] Inspect target slices FIRST, then determine the TRUE post-scout grade (S/M/L/XL) & optimal model WITH explicit thinking/planner depth (e.g. ${modelExamples} — ${noBareRuleEn}) from actual code (override pre-read ~${grade} if code is simpler or deeper!) and reflect YOUR AI verdict identically in RU chat, ask_question header ("Объём", "Рекомендуемая мощность", + "💡 Совет по режиму" on mismatch), and option #1.`
      );
      if (hasSelectorMismatch) {
        lines.push(
          isEnUi
            ? `⏸️ [Model-Switch Split-Turn (AGY 2.35+)] In AGY 2.35.2+, changing the model selector mid-turn only applies on the next turn (not inside ask_question). If post-scout triage confirms switching to ${recModel} is needed: do NOT call ask_question — output the concise plan, 3 numbered options (1/2/3), and a clear prompt to switch the model to ${recModel} in a normal reply and END the turn so the next message runs on ${recModel} (on the next turn after "go" / "1", execute immediately without repeating the gate). If post-scout confirms the current model fits, call ask_question as usual.`
            : `⏸️ [Model-Switch Split-Turn (AGY 2.35+)] В AGY 2.35.2+ смена модели в селекторе применяется только со следующего хода (а не внутри ask_question). Если после разведки кода смена модели на ${recModel} действительно нужна: НЕ вызывай ask_question — выведи краткий план, 3 пронумерованных варианта (1/2/3) и явную просьбу переключить модель на ${recModel} в обычном ответе и ЗАВЕРШИ ход, чтобы следующее сообщение пошло на ${recModel} (на следующем ходе после «пуск» / «1» сразу выполни план без повторного gate). Если после разведки текущая модель подходит — вызывай ask_question как обычно.`
        );
      }
      if (optionsBlueprint?.formattedBlueprint) {
        lines.push(optionsBlueprint.formattedBlueprint);
      }
    } else if (grade !== 'S') {
      lines.push(
        isEnUi
          ? `📋 [Triage Summary (${grade})] Include a concise EN summary of task scope (${grade}), key steps, and optimal model WITH explicit thinking/planner depth (e.g. ${modelExamples}; ${noBareRuleEn}; rec: ${recModel}) in your reply/badge.`
          : `📋 [Triage Summary (${grade})] Include a concise RU summary of task scope (${grade}), key steps, and optimal model WITH explicit thinking/planner depth (e.g. ${modelExamples}; ${noBareRuleEn}; rec: ${recModel}) in your reply/badge.`
      );
    }
    if (compiledSpec.formattedSpec) {
      lines.push(compiledSpec.formattedSpec);
    }
    if (scope.scopeHint) {
      lines.push(scope.scopeHint);
    }
    budgetHint = lines.join('\n');
  }

  return {
    grade,
    phase,
    budgetHint,
    maxSteps: 0,
    scope,
    structuralScore,
    subsystemHits,
    matrix2D: matrix3D,
    matrix3D,
    optionsBlueprint,
    selectorEval,
    compiledSpec,
    grillMe: grillSignal,
    autoSpecMode,
    autoSpecOutput,
    isReadOnlyQuestion: Boolean(signals.isReadOnlyQuestion),
    isModalAnalyticalQuestion: Boolean(signals.isModalAnalyticalQuestion),
    isApprovalFollowUp: false,
    modelSwitchSplitTurn,
  };
}

/**
 * Resolves effective Ponytail Lean-Senior intensity (`off | lite | full | ultra`)
 * from prompt overrides (`/ponytail ultra`) or persisted state.
 */
export function resolveLeanMode(promptText = '', state = {}) {
  const text = String(promptText || '');
  const m = /(?:^|\s)\/ponytail(?:\s+(off|lite|full|ultra))?\b/i.exec(text);
  if (m) {
    return (m[1] || 'full').toLowerCase();
  }
  if (/\b(?:stop\s+ponytail|normal\s+mode)\b/i.test(text)) return 'off';
  const raw = typeof state?.leanMode === 'string' ? state.leanMode.trim().toLowerCase() : 'full';
  return (raw === 'off' || raw === 'lite' || raw === 'full' || raw === 'ultra') ? raw : 'full';
}

/**
 * Builds prefix-stable Ponytail 7-Rung Ladder instructions for SessionStart / prompt overrides.
 */
export function buildLeanModeDirective(mode = 'full') {
  const clean = String(mode || 'full').toLowerCase();
  if (clean === 'off') return '';
  if (clean === 'lite') {
    return '- Lean Senior (lite): prefer existing repo helpers -> stdlib -> native platform before writing new helpers; mention smaller alternatives in 1 line.';
  }
  const ultraTail = clean === 'ultra'
    ? ' Push back on speculative scope the need does not justify before building.'
    : '';
  return `- Lean Senior (${clean}): Ladder of Laziness before coding: (1) Need to exist? (2) Already in repo? (3) Stdlib/platform? (4) Installed dep? (5) One readable line? (6) Minimum complete diff + 1 test on new branch/loop/parser/security. Mark deliberate deferrals with \`// shortcut: <ceiling>, <when to upgrade>\`; NEVER cut trust-boundary validation, security, or a11y.${ultraTail}`;
}

/**
 * Resolves Caveman ASD-STE100 controlled technical brevity (`off | caveman | ultracave`).
 */
export function resolveTerseMode(promptText = '', state = {}) {
  const text = String(promptText || '');
  if (/(?:^|\s)\/ultracave\b/i.test(text)) return 'ultracave';
  if (/(?:^|\s)\/caveman\b/i.test(text)) return 'caveman';
  if (/\bstop\s+caveman\b/i.test(text)) return 'off';
  const raw = typeof state?.terseMode === 'string' ? state.terseMode.trim().toLowerCase() : 'off';
  return (raw === 'caveman' || raw === 'ultracave') ? raw : 'off';
}

export function buildTerseModeDirective(mode = 'off') {
  const clean = String(mode || 'off').toLowerCase();
  if (clean !== 'caveman' && clean !== 'ultracave') return '';
  const maxWords = clean === 'ultracave' ? 12 : 20;
  return `- Controlled Brevity (${clean} · ASD-STE100): answer-first (\`[target] [action] [reason]\`, <=${maxWords} words/sentence, zero filler); keep code, paths, negations, numbers, and security/destructive warnings 100% exact and complete.`;
}

/**
 * Resolves Internal Spec-First mode (`off | auto | always`) from prompt overrides or persisted state.
 * @param {string} [promptText='']
 * @param {object} [state={}]
 * @returns {'off'|'auto'|'always'}
 */
export function resolveAutoSpecMode(promptText = '', state = {}) {
  const text = String(promptText || '');
  const m = /(?:^|\s)\/autospec(?:\s+(off|auto|always))?\b/i.exec(text);
  if (m) {
    return (m[1] || 'always').toLowerCase();
  }
  if (/(?:^|\s)\/spec\b/i.test(text)) return 'always';
  if (/\b(?:stop\s+autospec|no\s+autospec)\b|без\s+авто[-\s]?тз/i.test(text)) return 'off';
  const raw = typeof state?.autoSpecMode === 'string' ? state.autoSpecMode.trim().toLowerCase() : 'auto';
  return (raw === 'off' || raw === 'always') ? raw : 'auto';
}

/**
 * Resolves Internal Spec-First output destination (`thinking | chat`) from prompt overrides or persisted state.
 * @param {string} [promptText='']
 * @param {object} [state={}]
 * @returns {'thinking'|'chat'}
 */
export function resolveAutoSpecOutput(promptText = '', state = {}) {
  const text = String(promptText || '');
  const m = /(?:^|\s)\/autospec\s+(chat|thinking)\b/i.exec(text);
  if (m) return m[1].toLowerCase();
  if (/(?:^|\s)\/spec\s+chat\b/i.test(text)) return 'chat';
  if (/(?:^|\s)\/spec\s+thinking\b/i.test(text)) return 'thinking';
  const raw = typeof state?.autoSpecOutput === 'string' ? state.autoSpecOutput.trim().toLowerCase() : 'thinking';
  return raw === 'chat' ? 'chat' : 'thinking';
}

/**
 * Builds the Internal Spec-First directive so the agent compiles an exact file/line/contract
 * execution prompt in <thinking> (or outputs a compact prompt in chat when output='chat').
 * @param {{ mode?: 'off'|'auto'|'always', output?: 'thinking'|'chat', grade?: string, isReadOnlyQuestion?: boolean, isDeepAuditOrArch?: boolean }} [opts={}]
 * @returns {string}
 */
export function buildAutoSpecDirective({ mode = 'auto', output = 'thinking', grade = 'M', isReadOnlyQuestion = false, isDeepAuditOrArch = false } = {}) {
  if (isReadOnlyQuestion) return '';
  const clean = (mode === 'off' || mode === 'always') ? mode : 'auto';
  if (clean === 'off') return '';
  if (clean === 'auto' && grade === 'S' && !isDeepAuditOrArch) return '';
  const cleanOutput = output === 'chat' ? 'chat' : 'thinking';
  if (cleanOutput === 'chat') {
    return `📐 [Internal Spec-First (${clean} · ${grade} · chat)] Before proposing a plan or editing, scout target files via ram_search/ram_slice and output a compact detailed execution prompt in chat (FILES+LINES | SYMBOLS & CONTRACTS | BLAST RADIUS | EDGE CASES | VERIFY), then execute directly against it.`;
  }
  return `📐 [Internal Spec-First (${clean} · ${grade})] Before proposing a plan or editing, scout target files via ram_search/ram_slice and silently compile an internal execution prompt in <thinking> (FILES+LINES | SYMBOLS & CONTRACTS | BLAST RADIUS | EDGE CASES | VERIFY), then execute directly against it without dumping the raw prompt to chat.`;
}


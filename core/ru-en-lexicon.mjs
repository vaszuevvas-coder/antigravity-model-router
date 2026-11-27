/**
 * @file ru-en-lexicon.mjs
 * @description Fast O(1) prefix-bucketed RU->EN IT stem dictionary (260+ entries)
 * for Zero-VRAM CPU lexical & cross-reranker matching over English codebases.
 */

export const RU_EN_STEM_ENTRIES = [
  // 1. Security, Auth & Secrets
  ['безопас', ['security', 'guard', 'safe', 'sanitize']],
  ['защит', ['protect', 'guard', 'shield', 'firewall']],
  ['фаервол', ['firewall', 'guard', 'block']],
  ['секрет', ['secret', 'redact', 'token', 'key']],
  ['утеч', ['leak', 'exfiltration', 'redact', 'dispose']],
  ['токен', ['token', 'jwt', 'bearer', 'auth']],
  ['авториз', ['auth', 'authorize', 'login', 'session']],
  ['аутентиф', ['auth', 'authenticate', 'verify', 'credential']],
  ['парол', ['password', 'hash', 'argon2', 'bcrypt']],
  ['ключ', ['key', 'token', 'secret', 'apiKey']],
  ['доступ', ['access', 'permission', 'rbac', 'acl']],
  ['разреш', ['allow', 'permission', 'grant', 'scope']],
  ['запрет', ['deny', 'block', 'forbid', 'guard']],
  ['блокир', ['block', 'lock', 'deny', 'mutex']],
  ['подпис', ['signature', 'sign', 'hmac', 'verify']],
  ['шифр', ['encrypt', 'decrypt', 'cipher', 'aes', 'crypto']],
  ['хэш', ['hash', 'sha1', 'sha256', 'digest']],
  ['хеш', ['hash', 'sha1', 'sha256', 'digest']],
  ['кук', ['cookie', 'session', 'samesite', 'set-cookie']],
  ['сесси', ['session', 'convo', 'conversation', 'cookie']],
  ['валидац', ['validate', 'validator', 'schema', 'sanitize']],
  ['провер', ['verify', 'check', 'validate', 'assert']],
  ['санит', ['sanitize', 'clean', 'escape', 'redact']],
  ['инъекц', ['injection', 'xss', 'sqli', 'escape']],
  ['экранир', ['escape', 'quote', 'encode', 'sanitize']],
  ['переменн', ['env', 'variable', 'dotenv', 'config']],
  ['окружен', ['env', 'environment', 'process']],

  // 2. Cache, RAM & Memory Management
  ['кэш', ['cache', 'memo', 'ttl', 'evict', 'hit']],
  ['кеш', ['cache', 'memo', 'ttl', 'evict', 'hit']],
  ['памят', ['memory', 'ram', 'heap', 'rss', 'buffer']],
  ['озу', ['ram', 'memory', 'budget', 'buffer']],
  ['буфер', ['buffer', 'ring', 'chunk', 'bytes']],
  ['вытесн', ['evict', 'lru', 'prune', 'purge']],
  ['очист', ['clear', 'clean', 'purge', 'gc', 'flush']],
  ['сброс', ['reset', 'flush', 'clear', 'invalidate']],
  ['инвалид', ['invalidate', 'stale', 'expire', 'ttl']],
  ['протух', ['stale', 'expire', 'ttl', 'sweep']],
  ['прогрев', ['warm', 'warmup', 'preload', 'hydrate']],
  ['слайс', ['slice', 'chunk', 'range', 'excerpt']],
  ['срез', ['slice', 'range', 'excerpt', 'window']],
  ['сборщик', ['gc', 'sweeper', 'reap', 'cleanup']],
  ['мусор', ['gc', 'orphan', 'stale', 'sweep']],
  ['аллок', ['alloc', 'pool', 'heap', 'memory']],

  // 3. CPU, Threads, Concurrency & Queues
  ['поток', ['thread', 'worker', 'stream', 'pool']],
  ['многопоточ', ['multicore', 'worker', 'thread', 'parallel']],
  ['воркер', ['worker', 'pool', 'slot', 'swarm']],
  ['ядр', ['core', 'cpu', 'thread', 'logical']],
  ['пул', ['pool', 'slot', 'acquire', 'worker']],
  ['параллел', ['parallel', 'concurrent', 'batch', 'promise']],
  ['асинхрон', ['async', 'await', 'promise', 'defer']],
  ['синхрон', ['sync', 'atomic', 'lock', 'mutex']],
  ['гонк', ['race', 'atomic', 'lock', 'tectonic']],
  ['взаимоблок', ['deadlock', 'lock', 'stale', 'timeout']],
  ['дедлок', ['deadlock', 'lock', 'wait', 'timeout']],
  ['очеред', ['queue', 'fifo', 'enqueue', 'drain']],
  ['мьютекс', ['mutex', 'lock', 'withFileLockSync', 'atomic']],
  ['блокиров', ['lock', 'mutex', 'flock', 'stale']],
  ['таймаут', ['timeout', 'deadline', 'abort', 'ttl']],
  ['отмен', ['cancel', 'abort', 'AbortController', 'signal']],
  ['планиров', ['schedule', 'cron', 'timer', 'dispatcher']],
  ['таймер', ['timer', 'interval', 'timeout', 'debounce']],

  // 4. Network, HTTP, MCP & IPC
  ['сервер', ['server', 'http', 'listen', 'sidecar', 'mcp']],
  ['клиент', ['client', 'fetch', 'request', 'agent']],
  ['запрос', ['request', 'query', 'fetch', 'prompt']],
  ['ответ', ['response', 'reply', 'status', 'payload']],
  ['маршрут', ['route', 'router', 'dispatch', 'endpoint']],
  ['эндпоинт', ['endpoint', 'route', 'api', 'handler']],
  ['порт', ['port', 'listen', 'socket', 'loopback']],
  ['сокет', ['socket', 'websocket', 'ipc', 'pipe']],
  ['вебсокет', ['websocket', 'ws', 'stream', 'duplex']],
  ['заголов', ['header', 'headers', 'title', 'meta']],
  ['пейлоад', ['payload', 'body', 'json', 'data']],
  ['вебхук', ['webhook', 'callback', 'hook', 'event']],
  ['прокси', ['proxy', 'tunnel', 'forward', 'agent']],
  ['туннел', ['tunnel', 'proxy', 'ipc', 'pipe']],
  ['ретрансл', ['relay', 'proxy', 'forward']],
  ['повтор', ['retry', 'backoff', 'attempt', 'repeat']],
  ['отказоуст', ['resilient', 'failover', 'fallback', 'retry']],
  ['фоллбэк', ['fallback', 'default', 'backup', 'tier']],
  ['фолбэк', ['fallback', 'default', 'backup', 'tier']],
  ['горяч', ['hmr', 'hot', 'reload', 'live']],
  ['перезагруз', ['hmr', 'reload', 'hot', 'restart']],

  // 5. Database, Storage & Migrations
  ['баз', ['db', 'database', 'sql', 'store']],
  ['таблиц', ['table', 'schema', 'row', 'column']],
  ['строк', ['row', 'line', 'string', 'record']],
  ['колон', ['column', 'field', 'schema', 'key']],
  ['столб', ['column', 'field', 'attr']],
  ['индекс', ['index', 'trigram', 'bm25', 'inverted']],
  ['миграц', ['migrate', 'migration', 'schema', 'upgrade']],
  ['транзакц', ['transaction', 'atomic', 'commit', 'rollback']],
  ['выборк', ['select', 'query', 'filter', 'fetch']],
  ['вставк', ['insert', 'append', 'upsert', 'push']],
  ['обновлен', ['update', 'patch', 'upsert', 'refresh']],
  ['удален', ['delete', 'remove', 'unlink', 'purge']],
  ['схем', ['schema', 'model', 'type', 'struct']],
  ['хранилищ', ['store', 'storage', 'repo', 'persist']],
  ['сериализ', ['serialize', 'stringify', 'encode', 'toon']],
  ['десериал', ['deserialize', 'parse', 'decode']],

  // 6. UI, DOM, CSS & Design System
  ['панел', ['panel', 'sidecar', 'sidebar', 'ui']],
  ['интерфейс', ['ui', 'interface', 'view', 'panel']],
  ['тем', ['theme', 'dark', 'light', 'palette']],
  ['палитр', ['palette', 'color', 'theme', 'token']],
  ['цвет', ['color', 'hex', 'accent', 'bg']],
  ['шрифт', ['font', 'typography', 'glyph', 'text']],
  ['кнопк', ['button', 'btn', 'click', 'action']],
  ['окн', ['window', 'modal', 'dialog', 'viewport']],
  ['модал', ['modal', 'dialog', 'overlay', 'popup']],
  ['попап', ['popup', 'popover', 'tooltip', 'modal']],
  ['тултип', ['tooltip', 'hint', 'title', 'hover']],
  ['вкладк', ['tab', 'tabs', 'pane', 'view']],
  ['список', ['list', 'array', 'items', 'menu']],
  ['карточ', ['card', 'tile', 'panel', 'badge']],
  ['бейдж', ['badge', 'pill', 'chip', 'tag']],
  ['плашк', ['pill', 'badge', 'hud', 'banner']],
  ['баннер', ['banner', 'alert', 'notice', 'header']],
  ['иконк', ['icon', 'svg', 'ico', 'logo']],
  ['верстк', ['layout', 'grid', 'flex', 'css']],
  ['сетк', ['grid', 'columns', 'layout', 'gap']],
  ['скролл', ['scroll', 'overflow', 'sticky', 'viewport']],
  ['прокрут', ['scroll', 'overflow', 'wheel', 'smooth']],
  ['фокус', ['focus', 'focus-visible', 'blur', 'tabindex']],
  ['доступн', ['a11y', 'aria', 'accessibility', 'role']],
  ['адаптив', ['responsive', 'media', 'breakpoint', 'fluid']],
  ['витрин', ['showroom', 'preview', 'variant', 'demo']],
  ['переключ', ['toggle', 'switch', 'checkbox', 'select']],
  ['ползун', ['slider', 'range', 'input', 'scrub']],
  ['выпада', ['dropdown', 'select', 'combobox', 'menu']],
  ['спойлер', ['spoiler', 'details', 'collapse', 'accordion']],
  ['сверн', ['collapse', 'fold', 'minimize', 'details']],
  ['сортир', ['sort', 'order', 'rank', 'reorder']],
  ['перетаск', ['drag', 'drop', 'reorder', 'dnd']],

  // 7. Animations, Canvas, Shaders & VFX
  ['анимац', ['animate', 'animation', 'motion', 'keyframe']],
  ['переход', ['transition', 'ease', 'cubic-bezier', 'lerp']],
  ['отрисов', ['render', 'draw', 'paint', 'canvas']],
  ['рендер', ['render', 'frame', 'paint', 'fps']],
  ['канвас', ['canvas', 'ctx', '2d', 'webgl']],
  ['холст', ['canvas', 'stage', 'surface']],
  ['шейдер', ['shader', 'glsl', 'frag', 'uniform']],
  ['частиц', ['particle', 'emitter', 'vfx', 'spark']],
  ['свечен', ['glow', 'bloom', 'shadow', 'blur']],
  ['размыт', ['blur', 'backdrop-filter', 'glass']],
  ['прозрач', ['alpha', 'opacity', 'transparent', 'glass']],
  ['кадр', ['frame', 'fps', 'raf', 'step']],
  ['видео', ['video', 'ffmpeg', 'resolume', 'resolve']],
  ['звук', ['audio', 'sound', 'gain', 'fft']],
  ['график', ['chart', 'graph', 'plot', 'canvas']],

  // 8. Games & Simulation
  ['игр', ['game', 'engine', 'loop', 'tick']],
  ['физик', ['physics', 'velocity', 'gravity', 'step']],
  ['коллиз', ['collision', 'aabb', 'hitbox', 'overlap']],
  ['хитбокс', ['hitbox', 'bounds', 'rect', 'collider']],
  ['эконом', ['economy', 'cost', 'yield', 'balance']],
  ['баланс', ['balance', 'curve', 'weight', 'tier']],
  ['прогресс', ['progress', 'level', 'xp', 'step']],
  ['инвентар', ['inventory', 'slot', 'item', 'bag']],
  ['сохранен', ['save', 'persist', 'checkpoint', 'state']],

  // 9. Filesystem, Binary, Archives & Streams
  ['файл', ['file', 'path', 'fs', 'read', 'write']],
  ['директор', ['dir', 'directory', 'folder', 'root']],
  ['папк', ['folder', 'dir', 'workspace', 'path']],
  ['пут', ['path', 'resolve', 'join', 'relative']],
  ['чтени', ['read', 'slice', 'stream', 'load']],
  ['запис', ['write', 'append', 'save', 'patch']],
  ['перезап', ['overwrite', 'replace', 'write', 'guard']],
  ['архив', ['zip', 'deflate', 'inflate', 'zlib']],
  ['сжати', ['compress', 'deflate', 'zlib', 'compact']],
  ['распак', ['unpack', 'extract', 'inflate', 'asar']],
  ['бинар', ['binary', 'buffer', 'int8', 'bytes']],
  ['кодиров', ['encoding', 'utf8', 'bom', 'charset']],
  ['наблюд', ['watch', 'fs.watch', 'watcher', 'poll']],
  ['бэкап', ['backup', 'snapshot', 'shadow', 'restore']],
  ['резерв', ['backup', 'restore', 'archive', 'shadow']],
  ['снимок', ['snapshot', 'checkpoint', 'shadow', 'zlib']],
  ['чекпоинт', ['checkpoint', 'snapshot', 'rollback', 'restore']],
  ['откат', ['rollback', 'revert', 'restore', 'undo']],

  // 10. Testing, Fuzzing, Linting & Verification
  ['тест', ['test', 'assert', 'spec', 'suite']],
  ['прогон', ['run', 'exec', 'suite', 'runner']],
  ['ассерт', ['assert', 'expect', 'equal', 'match']],
  ['мок', ['mock', 'stub', 'spy', 'fake']],
  ['заглуш', ['stub', 'mock', 'fallback', 'noop']],
  ['фазз', ['fuzz', 'fuzzer', 'ddmin', 'mutate']],
  ['минимиз', ['minimize', 'ddmin', 'shrink', 'compact']],
  ['линтер', ['lint', 'linter', 'oxlint', 'biome']],
  ['синтакс', ['syntax', 'parse', 'ast', 'verify']],
  ['верифиц', ['verify', 'check', 'audit', 'validate']],
  ['аудит', ['audit', 'stress', 'scan', 'check']],
  ['регресс', ['regression', 'test', 'pitfall', 'verify']],
  ['покрыт', ['coverage', 'tested', 'branch']],
  ['бенчмарк', ['benchmark', 'perf', 'latency', 'ops']],
  ['производ', ['perf', 'performance', 'speed', 'latency']],
  ['задержк', ['latency', 'delay', 'ms', 'overhead']],

  // 11. AST, Parsing, Codemods & Slicing
  ['парсер', ['parse', 'parser', 'lexer', 'ast']],
  ['парсинг', ['parse', 'tokenize', 'extract', 'ast']],
  ['символ', ['symbol', 'function', 'class', 'export']],
  ['экспорт', ['export', 'module', 'dead', 'public']],
  ['импорт', ['import', 'require', 'dep', 'dependency']],
  ['зависим', ['dependency', 'deps', 'reverseDeps', 'import']],
  ['контракт', ['contract', 'interface', 'signature', 'schema']],
  ['сигнатур', ['signature', 'params', 'args', 'skeleton']],
  ['скелет', ['skeleton', 'fold', 'knapsack', 'outline']],
  ['кодмод', ['codemod', 'refactor', 'rename', 'replace']],
  ['рефактор', ['refactor', 'cleanup', 'extract', 'rename']],
  ['переимен', ['rename', 'codemod', 'symbol', 'alias']],
  ['патч', ['patch', 'diff', 'replace', 'edit']],
  ['дифф', ['diff', 'myers', 'delta', 'hunk']],
  ['дельта', ['delta', 'diff', 'myers', 'reread']],
  ['регуляр', ['regex', 'regexp', 'pattern', 'match']],
  ['шаблон', ['template', 'pattern', 'preset', 'drain']],

  // 12. State, Events, Hooks & Throttling
  ['состоян', ['state', 'store', 'context', 'snapshot']],
  ['конфиг', ['config', 'settings', 'state', 'options']],
  ['настрой', ['settings', 'config', 'options', 'tune']],
  ['тумблер', ['toggle', 'flag', 'switch', 'bool']],
  ['событи', ['event', 'emit', 'listener', 'hook']],
  ['слушател', ['listener', 'handler', 'subscribe', 'on']],
  ['подписчик', ['subscriber', 'listener', 'observer', 'hook']],
  ['хук', ['hook', 'preToolUse', 'postToolUse', 'lifecycle']],
  ['перехват', ['intercept', 'hook', 'guard', 'proxy']],
  ['троттл', ['throttle', 'rate', 'limit', 'cooldown']],
  ['дебаунс', ['debounce', 'delay', 'coalesce', 'timer']],
  ['объедин', ['coalesce', 'merge', 'combine', 'batch']],
  ['пакет', ['batch', 'chunk', 'bundle', 'pack']],

  // 13. Build, Installer, OS & Process
  ['сборк', ['build', 'pack', 'bundle', 'compile']],
  ['релиз', ['release', 'dist', 'manifest', 'pack']],
  ['установ', ['install', 'setup', 'deploy', 'copy']],
  ['удалени', ['uninstall', 'remove', 'cleanup', 'purge']],
  ['верси', ['version', 'semver', 'bump', 'tag']],
  ['реестр', ['registry', 'reg', 'hklm', 'win32']],
  ['процесс', ['process', 'pid', 'spawn', 'exec']],
  ['команд', ['command', 'cmd', 'cli', 'exec']],
  ['терминал', ['terminal', 'shell', 'stdout', 'stderr']],
  ['консол', ['console', 'cli', 'stdout', 'terminal']],

  // 14. AI, LLM, Routing, Embeddings & Swarm
  ['модел', ['model', 'tier', 'llm', 'gemini', 'ollama']],
  ['нейросет', ['llm', 'model', 'ai', 'neural']],
  ['диспетч', ['dispatcher', 'router', 'route', 'triage']],
  ['триаж', ['triage', 'grade', 'complexity', 'matrix']],
  ['сложност', ['complexity', 'grade', 'depth', 'breadth']],
  ['байес', ['bayesian', 'prior', 'beta', 'confidence']],
  ['довери', ['confidence', 'trust', 'prior', 'score']],
  ['хрупк', ['fragile', 'fragility', 'risk', 'blast']],
  ['контекст', ['context', 'window', 'pack', 'prefix']],
  ['промпт', ['prompt', 'instruction', 'system', 'pivot']],
  ['инструкц', ['instruction', 'rule', 'prompt', 'skill']],
  ['навык', ['skill', 'crystallizer', 'recipe', 'audit']],
  ['скилл', ['skill', 'skills', 'trigger', 'audit']],
  ['субагент', ['subagent', 'agent', 'invoke', 'delegate']],
  ['рой', ['swarm', 'worker', 'board', 'coordinator']],
  ['квот', ['quota', 'limit', 'failover', 'rate']],
  ['компакц', ['compaction', 'compact', 'epoch', 'digest']],
  ['дистилл', ['distill', 'summary', 'digest', 'compress']],
  ['выжимк', ['digest', 'summary', 'distill', 'extract']],
  ['саммар', ['summary', 'digest', 'compact', 'recap']],
  ['вектор', ['vector', 'embed', 'i8bin', 'cosine']],
  ['эмбед', ['embed', 'embedding', 'qwen', 'mrl']],
  ['семант', ['semantic', 'meaning', 'vector', 'search']],
  ['смысл', ['semantic', 'meaning', 'intent', 'concept']],
  ['поиск', ['search', 'find', 'query', 'lookup']],
  ['ранжир', ['rank', 'rerank', 'bm25', 'rrf', 'score']],
  ['реранк', ['rerank', 'cross', 'score', 'top']],
  ['триграмм', ['trigram', 'inverted', 'index', 'ngram']],

  // 15. Graphs, Algorithms & Math
  ['граф', ['graph', 'node', 'edge', 'pagerank', 'ego']],
  ['связ', ['link', 'edge', 'coupled', 'relation']],
  ['цикл', ['cycle', 'scc', 'tarjan', 'loop']],
  ['зацикл', ['loop', 'thrash', 'circuit', 'breaker']],
  ['дерев', ['tree', 'ast', 'drain3', 'branch']],
  ['рюкзак', ['knapsack', 'dp', 'budget', 'fold']],
  ['взвеш', ['weight', 'score', 'rank', 'idf']],
  ['радиус', ['radius', 'blast', 'impact', 'dependents']],

  // 16. Errors, Logs, Diagnostics & Localization
  ['ошибк', ['error', 'err', 'fault', 'fail', 'exception']],
  ['сбо', ['fail', 'fault', 'crash', 'error']],
  ['исключен', ['exception', 'throw', 'catch', 'error']],
  ['стек', ['stack', 'trace', 'stacktrace', 'frame']],
  ['трасс', ['trace', 'stack', 'frame', 'span']],
  ['грабл', ['pitfall', 'lesson', 'ledger', 'mistake']],
  ['диагност', ['diagnose', 'status', 'health', 'inspect']],
  ['телеметр', ['telemetry', 'metrics', 'stats', 'usage']],
  ['статист', ['stats', 'metrics', 'telemetry', 'count']],
  ['лог', ['log', 'logs', 'drain3', 'output']],
  ['дамп', ['dump', 'payload', 'json', 'log']],
  ['маскир', ['mask', 'obsMask', 'redact', 'hide']],
  ['перевод', ['translate', 'locale', 'ru', 'i18n']],
  ['локализа', ['localize', 'locale', 'i18n', 'ru']],
  ['кирилл', ['cyrillic', 'ru', 'utf8', 'tokenizer']],

  // 17. VideoCard & Hardware
  ['видеокарт', ['gpu', 'vram', 'cuda', 'nvidia', 'ollama']],
  ['гпу', ['gpu', 'vram', 'ollama', 'embed']],
  ['видеопам', ['vram', 'gpuMaxVramMb', 'nvidia', 'fit']],
  ['оллам', ['ollama', 'serve', 'pull', 'gguf']],
  ['желез', ['hardware', 'profiler', 'probe', 'cpu', 'gpu']],
  ['скачив', ['pull', 'download', 'fetch', 'hf']],
  ['загруз', ['load', 'pull', 'warm', 'mount']],
  ['выгруз', ['unload', 'evict', 'free', 'dispose']],
];

export const LEXICON_ENTRY_COUNT = RU_EN_STEM_ENTRIES.length;

// 3-character lowercase prefix bucket index for O(1) candidate lookup
const PREFIX_INDEX = new Map();
for (const entry of RU_EN_STEM_ENTRIES) {
  const stem = entry[0];
  const key = stem.slice(0, 3);
  if (!PREFIX_INDEX.has(key)) {
    PREFIX_INDEX.set(key, []);
  }
  PREFIX_INDEX.get(key).push(entry);
}

/**
 * Expands a Russian/bilingual query into English code stems via O(1) prefix buckets.
 * @param {string} query
 * @param {{ maxTerms?: number }} [options={}]
 * @returns {{ matchedStems: string[], enTerms: string[] }}
 */
export function expandRuQueryToEnTerms(query = '', options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const maxTerms = opts.maxTerms ?? 24;
  const raw = (typeof query === 'string' ? query : String(query || '')).toLowerCase().replace(/ё/g, 'е');
  if (!raw || !/[а-я]/.test(raw)) {
    return { matchedStems: [], enTerms: [] };
  }
  const tokens = raw.match(/[а-я]{3,}/g) || [];
  if (tokens.length === 0) {
    return { matchedStems: [], enTerms: [] };
  }

  const matchedStems = [];
  const seenStems = new Set();
  const enTerms = [];
  const seenEn = new Set();
  const cap = Math.max(4, Math.min(64, Number(maxTerms) || 24));

  for (const tok of tokens) {
    const candidateBuckets = [];
    const seenPrefixes = new Set();
    const headPfx = tok.slice(0, 3);
    seenPrefixes.add(headPfx);
    const headBucket = PREFIX_INDEX.get(headPfx);
    if (headBucket) candidateBuckets.push({ bucket: headBucket, headMatch: true });
    if (tok.length >= 6) {
      const maxOffset = Math.min(6, tok.length - 4);
      for (let off = 1; off <= maxOffset; off++) {
        const subPfx = tok.slice(off, off + 3);
        if (seenPrefixes.has(subPfx)) continue;
        seenPrefixes.add(subPfx);
        const subBucket = PREFIX_INDEX.get(subPfx);
        if (subBucket) candidateBuckets.push({ bucket: subBucket, headMatch: false });
      }
    }
    for (const { bucket, headMatch } of candidateBuckets) {
      for (const [stem, terms] of bucket) {
        const matched = headMatch ? (tok.startsWith(stem) || (stem.length >= 4 && tok.includes(stem))) : (stem.length >= 4 && tok.includes(stem));
        if (matched) {
          if (!seenStems.has(stem)) {
            seenStems.add(stem);
            matchedStems.push(stem);
          }
          for (const en of terms) {
            if (!seenEn.has(en)) {
              seenEn.add(en);
              enTerms.push(en);
              if (enTerms.length >= cap) {
                return { matchedStems, enTerms };
              }
            }
          }
        }
      }
    }
  }

  return { matchedStems, enTerms };
}

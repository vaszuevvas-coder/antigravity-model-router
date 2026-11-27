/**
 * @file gpu-composer-copilot.mjs
 * @description Smart Composer ghost continuation, grounding verification, screenshot/commit/voice helpers.
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import { redactSecretsInText } from '../security-guard.mjs';
import { normalizeLang, readActiveUiLanguage } from '../i18n.mjs';
import {
  CONTINUATION_CACHE_MAX,
  CONTINUATION_CACHE_TTL_MS,
  DEFAULT_GPU_CONFIG,
  clampInt,
  continuationCache,
  loadGpuConfig,
  ollamaHttpJson,
  parseStrictBackgroundJson,
  readFreshTtlLruEntry,
} from './gpu-shared-state.mjs';
import {
  VRAM_CAP_TOLERANCE_MB,
  ensureOllamaRunning,
  estimateModelVramMb,
  evaluateVramModelFit,
  getCachedOrFetchOllamaTagMap,
  isOllamaEmbedModel,
  normalizeOllamaTag,
  probeNvidiaGpu,
  reconcileLoadedModelsVram,
  unloadModelsExceedingBudget,
} from './gpu-vram-runtime.mjs';

const ABBREV_BEFORE_DOT_RE =
  /(?:^|[\s(«"'])(?:т\.\s*[дпе]|и\s+др|и\s+пр|др|пр|см|напр|рис|стр|г|п|ч|ст|e\.g|i\.e|vs|etc)$/i;

// Note: JS `\b` is ASCII-only and fails after Cyrillic letters; replace trailing `\b` with Unicode word-end lookahead
function buildWordEndRegex(patternSrc) {
  return new RegExp(patternSrc.replace(/\\b/g, '(?![A-Za-zА-Яа-яЁё0-9_])'), 'i');
}

const ASSISTANT_REPLY_OPENERS_RE = buildWordEndRegex(
  String.raw`^(?:да(?!\s+и\b)(?:[,!.:;—–-]|\s+(?:это\b|можно\b|можем\b|такое\b|конечно\b|безусловно\b|реально\b|вполне\b|легко\b|просто\b|уже\b|есть\b|будет\b|стоит\b|нужно\b|поддерживается\b|сработает\b|подойдёт\b|подойдет\b|верно\b|точно\b|действительно\b|мы\s+можем\b|я\s+могу\b))|нет(?:[,!.:;—–-]|\s+(?:это\b|так\b|сейчас\b|к\s+сожалению\b|такого\b|напрямую\b|нельзя\b))|конечно\b|безусловно\b|разумеется\b|несомненно\b|однозначно\b|естественно[,!.\s]|к\s+сожалению\b|увы\b|хороший\s+вопрос\b|отличный\s+вопрос\b|отличная\s+идея\b|в\s+целом[, ]|в\s+принципе[, ]|технически[, ]+(?:да\b|нет\b|это\b|можно\b)|теоретически[, ]+(?:да\b|нет\b|это\b|можно\b)|yes[,!.:;—–\s]|no[,!.:;—–]|sure[,!.:;\s]|okay[,!.:;\s]|ok[,!.:;\s]|alright[,!.:;\s]|well[,!.\s]|certainly\b|absolutely\b|of\s+course\b|unfortunately\b|good\s+question\b|great\s+(?:question|idea)\b)`
);

const ASSISTANT_SOLUTION_RE = buildWordEndRegex(
  String.raw`^(?:я\s+(?:могу|помогу|сделаю|реализую|проверю|предлагаю|рекомендую|советую|готов|сейчас\s+(?:проверю|сделаю|посмотрю)|бы\s+(?:рекомендовал|предложил|посоветовал))\b|давайте\s+(?:разберём|разберем|посмотрим|реализуем|начнём|начнем|я\b)|рекомендую\b|рекомендуется\b|советую\b|попробуйте\b|попробуй\b|(?:вам|тебе)\s+(?:стоит|нужно|следует|достаточно|лучше|понадобится)\b|для\s+этого\s+(?:нужно|можно|достаточно|потребуется|понадобится|следует|лучше|стоит|необходимо|используется|применяется)\b|чтобы\s+(?:это\s+)?(?:реализовать|сделать|исправить|улучшить|добавить|включить|подключить)[, ]+(?:нужно|можно|достаточно|следует|стоит|потребуется)\b|(?:это|такое)\s+(?:можно\s+(?:реализовать|сделать|добавить|исправить|настроить|улучшить|решить|обойти|подключить|включить)|реализуется|делается|решается|работает\s+через|происходит\s+(?:из-за|потому)|связано\s+с\s+тем|позволит\s+вам)\b|(?:реализовать|сделать|добавить|настроить|подключить)\s+это\s+можно\b|i\s+(?:can|will|would\s+recommend|recommend|suggest|am\s+happy\s+to)\b|you\s+(?:can|should|need\s+to|could|might\s+want\s+to)\b|this\s+can\s+be\s+(?:implemented|done|achieved|solved|fixed)\b|to\s+(?:do|achieve|implement|fix|solve)\s+this[, ]+(?:you|we)\b|let'?s\s+(?:break\s+down|look\s+at|implement\s+this)\b)`
);

const INTERROGATIVE_DRAFT_RE = buildWordEndRegex(
  String.raw`(?:\?|(?:^|[.?!…]\s+)(?:а\s+|и\s+|но\s+)?(?:мы\s+можем|можно\s+ли|можешь\s+ли|как\s+(?:нам|мне|лучше|можно|сделать|реализовать)|почему\b|зачем\b|из-за\s+чего\b|в\s+чём\s+причина|в\s+чем\s+причина|реально\s+ли|стоит\s+ли|подскажи\b|can\s+we\b|could\s+we\b|how\s+(?:can|do|should)\s+we\b))`
);

const ASSISTANT_POST_QUESTION_RE = buildWordEndRegex(
  String.raw`^(?:мы\s+можем\b|можем\s+(?:реализовать|использовать|сделать|подключить|добавить|применить)\b|(?:дело|причина|суть)\s+в\s+том\b|(?:обычно|чаще\s+всего)\s+это\b|(?:проще|оптимальнее)\s+всего\b|лучше\s+всего\s+(?:использовать|реализовать|сделать|подойдёт|подойдет)\b|(?:скорее|вероятнее)\s+всего\b|это\s+позволит\b|we\s+can\s+(?:implement|use|add|solve|achieve)\b)`
);

/**
 * Checks whether the user's draft already ends with a completed sentence or question
 * (preserving incomplete file/identifier stems such as `sidecars/panel/ui.` or `v3.22.`).
 * @param {string} [draft='']
 * @returns {boolean}
 */
export function isCompletedSentenceDraft(draft = '') {
  const raw = String(draft || '');
  const s = raw.trimEnd();
  if (!s) return false;
  if (/[?!…]$/.test(s)) return true;
  if (!s.endsWith('.')) return false;

  const withoutTrailingDot = s.slice(0, -1);
  if (ABBREV_BEFORE_DOT_RE.test(withoutTrailingDot)) return false;
  if (/\.\s+$/.test(raw)) return true;

  const lastTok = (withoutTrailingDot.match(/(\S+)$/) || [])[1] || '';
  if (!lastTok) return false;
  if (/[А-Яа-яЁё]$/.test(lastTok)) return true;
  if (/\.[A-Za-z][A-Za-z0-9]{0,5}$/.test(lastTok)) return true;
  if (
    /[А-Яа-яЁё]\s+[A-Za-z]{4,}$/.test(withoutTrailingDot) &&
    !/[\\/0-9_.-]/.test(lastTok) &&
    !/^(?:index|server|client|config|package|plugin|router|script|styles?)$/i.test(lastTok)
  ) {
    return true;
  }
  return false;
}

/**
 * Truncates multi-sentence LLM output at the end of the first sentence so a single
 * autocomplete suggestion never finishes a question and immediately answers it in sentence #2.
 * @param {string} [text='']
 * @returns {string}
 */
function truncateAtFirstSentenceBoundary(text = '') {
  const src = String(text || '');
  if (!src) return '';

  let cutIdx = -1;
  const qmMatch = /[?!…]+(?=\s+\S)/.exec(src);
  if (qmMatch) {
    cutIdx = qmMatch.index + qmMatch[0].length;
  }

  const dotRe = /\.(?=\s+[А-ЯЁA-Z«"'])/g;
  let m;
  while ((m = dotRe.exec(src)) !== null) {
    const prefix = src.slice(0, m.index);
    if (ABBREV_BEFORE_DOT_RE.test(prefix)) continue;
    const candidateIdx = m.index + 1;
    if (cutIdx === -1 || candidateIdx < cutIdx) {
      cutIdx = candidateIdx;
    }
    break;
  }

  return cutIdx > 0 ? src.slice(0, cutIdx) : src;
}

/**
 * Detects when an LLM suggestion switches into the AI assistant persona and answers
 * the user's prompt instead of continuing the user's own thought.
 * @param {string} [draft='']
 * @param {string} [candidate='']
 * @returns {boolean}
 */
export function isAssistantAnswerContinuation(draft = '', candidate = '') {
  const probe = String(candidate || '')
    .trim()
    .replace(/^[—–\-:]+\s*/, '');
  if (!probe) return false;

  if (ASSISTANT_REPLY_OPENERS_RE.test(probe)) return true;
  if (ASSISTANT_SOLUTION_RE.test(probe)) return true;
  if (/^(?:(?:okay|ok|well|alright|hmm|so)[,!.\s]+)?(?:the\s+user\s+(?:is\s+|wants|asked|needs|typed)|user\s+(?:is\s+asking|wants)|let\s+me\b|i\s+(?:need|should|have)\s+to\b|looking\s+at\b|here\s+is\b|пользовател[ья]\s+(?:просит|спрашивает|хочет|ввёл|ввел|пишет))/i.test(probe)) {
    return true;
  }
  if (INTERROGATIVE_DRAFT_RE.test(String(draft || '')) && ASSISTANT_POST_QUESTION_RE.test(probe)) {
    return true;
  }
  return false;
}

/**
 * Normalizes raw LLM autocomplete output into a clean inline Ghost Text continuation suffix
 * without repeating the user's draft prefix, thinking blocks, quotes, line breaks, or assistant self-answers.
 * @param {string} [draft='']
 * @param {string} [rawSuggestion='']
 * @returns {string}
 */
export function sanitizeGhostContinuation(draft = '', rawSuggestion = '') {
  const rawStr = String(rawSuggestion || '');
  if (!rawStr.trim()) return '';

  // Strip reasoning blocks (Qwen/DeepSeek <think> & Gemma 4 <thought>/<|thought|>) and fenced code markers
  let stripped = rawStr
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/gi, '')
    .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
    .replace(/<thought>[\s\S]*$/gi, '')
    .replace(/<\|thought\|?>[\s\S]*?(?:<\|\/?thought\|>|<channel\|>|<\/thought>|$)/gi, '')
    .replace(/^```[\w-]*\s*/i, '')
    .replace(/```$/g, '');

  const firstLine = stripped.split(/\r?\n/).find((ln) => ln.trim().length > 0) || '';
  if (!firstLine.trim()) return '';

  const hadLeadingSpace = /^\s/.test(firstLine);
  let cleaned = firstLine
    .trim()
    .replace(/^(?:UNFINISHED_USER_PROMPT|COMPLETED_FIRST_SENTENCE|USER_DRAFT|CONTINUATION|TASK)\s*:\s*/i, '');

  // Unwrap matching outer quotes or backticks
  const quotePairs = [
    ['"', '"'],
    ["'", "'"],
    ['«', '»'],
    ['`', '`'],
  ];
  for (const [openQ, closeQ] of quotePairs) {
    if (cleaned.length >= 2 && cleaned.startsWith(openQ) && cleaned.endsWith(closeQ)) {
      cleaned = cleaned.slice(1, -1).trim();
    }
  }

  cleaned = cleaned.trimEnd();
  while (cleaned.endsWith('...') || cleaned.endsWith('…')) {
    cleaned = (cleaned.endsWith('...') ? cleaned.slice(0, -3) : cleaned.slice(0, -1)).trimEnd();
  }
  if (!cleaned.trim()) return '';

  const draftStr = String(draft || '');
  const draftTrimmed = draftStr.trimEnd();
  const draftEndsWithSpace = /\s$/.test(draftStr);
  let overlapRemoved = false;

  if (draftTrimmed) {
    if (cleaned.toLowerCase().startsWith(draftTrimmed.toLowerCase())) {
      cleaned = cleaned.slice(draftTrimmed.length);
      overlapRemoved = true;
    } else {
      const maxOverlap = Math.min(40, draftTrimmed.length, cleaned.length);
      for (let k = maxOverlap; k >= 2; k--) {
        const startIdx = draftTrimmed.length - k;
        const prevChar = startIdx === 0 ? '' : draftTrimmed[startIdx - 1];
        const isTokenBoundary = startIdx === 0 || !/[A-Za-zА-Яа-яЁё0-9_]/.test(prevChar);
        if (!isTokenBoundary) continue;
        if (draftTrimmed.slice(startIdx).toLowerCase() === cleaned.slice(0, k).toLowerCase()) {
          cleaned = cleaned.slice(k);
          overlapRemoved = true;
          break;
        }
      }
    }
  }

  // Keep at most one sentence per autocomplete step (prevents completing a question + answering it)
  cleaned = truncateAtFirstSentenceBoundary(cleaned);
  if (!cleaned.trim()) return '';

  const startsMidWord =
    overlapRemoved &&
    !/^\s/.test(cleaned) &&
    /[A-Za-zА-Яа-яЁё0-9_./-]$/.test(draftStr) &&
    !draftEndsWithSpace &&
    !isCompletedSentenceDraft(draftStr);

  if (!startsMidWord && isAssistantAnswerContinuation(draftStr, cleaned)) {
    return '';
  }

  // Reject leaked English prose meta-commentary when the user is drafting in Russian
  if (
    /[А-Яа-яЁё]/.test(draftStr) &&
    !/[А-Яа-яЁё]/.test(cleaned) &&
    cleaned.trim().split(/\s+/).length >= 4 &&
    !/[@\\/_.:=-]/.test(cleaned)
  ) {
    return '';
  }

  // Cap continuation length cleanly on a word boundary
  if (cleaned.length > 200) {
    const slice = cleaned.slice(0, 200);
    const lastSpace = slice.lastIndexOf(' ');
    cleaned = lastSpace > 90 ? slice.slice(0, lastSpace) : slice;
  }

  cleaned = cleaned.replace(/\s+$/, '');
  if (!cleaned.trim()) return '';

  if (draftEndsWithSpace) {
    cleaned = cleaned.replace(/^\s+/, '');
  } else if (draftStr) {
    if (/^\s/.test(cleaned)) {
      cleaned = ' ' + cleaned.trimStart();
    } else if (!overlapRemoved) {
      const endsWithWord = /[A-Za-zА-Яа-яЁё0-9_]$/.test(draftStr);
      const endsWithDotBeforeCyrillic = /\.$/.test(draftStr) && /^[А-Яа-яЁё]/.test(cleaned);
      const endsWithPathOrDot = /[./_-]$/.test(draftStr) && !isCompletedSentenceDraft(draftStr) && !endsWithDotBeforeCyrillic;
      const endsWithClausePunct = /[,:;!?)]$/.test(draftStr) || isCompletedSentenceDraft(draftStr) || endsWithDotBeforeCyrillic;
      const startsWithPunct = /^[.,:;!?)/\\-]/.test(cleaned);
      if (endsWithWord && !startsWithPunct) {
        cleaned = ' ' + cleaned;
      } else if (endsWithPathOrDot && hadLeadingSpace && !startsWithPunct) {
        cleaned = ' ' + cleaned;
      } else if (endsWithClausePunct && /^[A-Za-zА-Яа-яЁё0-9(«"']/.test(cleaned)) {
        cleaned = ' ' + cleaned;
      }
    }
  }

  const trimmedResult = cleaned.trim();
  if (trimmedResult.length < 2) return '';
  if (draftTrimmed && trimmedResult.toLowerCase() === draftTrimmed.toLowerCase()) return '';
  return cleaned;
}

function getFreshContinuationCacheEntry(key) {
  return readFreshTtlLruEntry(continuationCache, key, CONTINUATION_CACHE_TTL_MS);
}

function setContinuationCacheEntry(key, entry) {
  if (continuationCache.has(key)) {
    continuationCache.delete(key);
  } else if (continuationCache.size >= CONTINUATION_CACHE_MAX) {
    const oldest = continuationCache.keys().next().value;
    if (oldest !== undefined) continuationCache.delete(oldest);
  }
  continuationCache.set(key, entry);
}

const GROUNDING_ALLOWED_CLI_FLAGS = new Set([
  '--test',
  '--json',
  '--help',
  '--dry-run',
  '--quiet',
  '--silent',
  '--version',
]);

const GROUNDING_IGNORED_SLASH_SEGMENTS = new Set([
  '/api',
  '/ram',
  '/gpu',
  '/tmp',
  '/var',
  '/etc',
  '/usr',
  '/opt',
  '/dev',
  '/proc',
  '/bin',
  '/home',
  '/root',
  '/mnt',
  '/app',
  '/src',
  '/core',
  '/tests',
  '/sidecars',
  '/skills',
  '/rules',
  '/scripts',
  '/hooks',
  '/docs',
  '/dist',
  '/build',
  '/node_modules',
  '/v1',
  '/v2',
]);

const GROUNDING_IGNORED_FRAMEWORK_DOT_JS = new Set([
  'Node.js',
  'Next.js',
  'Vue.js',
  'Nuxt.js',
  'React.js',
  'Express.js',
  'Three.js',
  'Chart.js',
  'Electron.js',
]);

export const GROUNDING_STANDARD_IDENTIFIERS_LOWER = new Set([
  // Tech proper nouns, architectures, protocols & AI models
  'javascript',
  'typescript',
  'powershell',
  'antigravity',
  'github',
  'gitlab',
  'ollama',
  'nodejs',
  'abortcontroller',
  'abortsignal',
  'referenceerror',
  'typeerror',
  'syntaxerror',
  'rangeerror',
  'weakmap',
  'weakset',
  'arraybuffer',
  'sharedarraybuffer',
  'float32array',
  'int8array',
  'uint8array',
  'textencoder',
  'textdecoder',
  'urlsearchparams',
  'regexp',
  'eventemitter',
  'readablestream',
  'writablestream',
  'devtools',
  'keepalive',
  'localstorage',
  'sessionstorage',
  'macos',
  'ios',
  'ipad',
  'iphone',
  'cast',
  'cuda',
  'vulkan',
  'metal',
  'nvidia',
  'windows',
  'linux',
  'darwin',
  'localhost',
  'markdown',
  'ram',
  'gpu',
  'vram',
  'cpu',
  'npu',
  'mcp',
  'ast',
  'rag',
  'llm',
  'cot',
  'mrl',
  'gguf',
  'bm25',
  'bm25f',
  'toon',
  'sse',
  'cli',
  'api',
  'ipc',
  'rpc',
  'csp',
  'cors',
  'dom',
  'esm',
  'cjs',
  'wal',
  'lru',
  'ttl',
  'pid',
  'cwd',
  'env',
  'eof',
  'uri',
  'tls',
  'ssl',
  'ssh',
  'tcp',
  'udp',
  'dns',
  'wsl',
  'ide',
  'sdk',
  'gui',
  'tui',
  'git',
  'npm',
  'npx',
  'pnpm',
  'yarn',
  'node',
  'ripgrep',
  'treesitter',
  'qwen',
  'qwen2',
  'qwen3',
  'gemma',
  'gemma2',
  'gemma3',
  'gemma4',
  'deepseek',
  'llama',
  'mistral',
  'nomic',
  'claude',
  'gemini',
  'openai',
  'toml',
  'yaml',
  'yml',
  'xml',
  'svg',
  'png',
  'webp',
  // JS/TS keywords
  'if',
  'else',
  'for',
  'while',
  'switch',
  'case',
  'break',
  'continue',
  'return',
  'throw',
  'try',
  'catch',
  'finally',
  'function',
  'async',
  'await',
  'yield',
  'class',
  'extends',
  'super',
  'this',
  'new',
  'typeof',
  'instanceof',
  'void',
  'delete',
  'const',
  'let',
  'var',
  'import',
  'export',
  'default',
  'from',
  'true',
  'false',
  'null',
  'undefined',
  'nan',
  'infinity',
  // Standard JS/Web/Node globals & builtin methods
  'object',
  'array',
  'string',
  'number',
  'boolean',
  'symbol',
  'bigint',
  'promise',
  'map',
  'set',
  'weakmap',
  'weakset',
  'date',
  'math',
  'json',
  'regexp',
  'error',
  'buffer',
  'url',
  'urlsearchparams',
  'eventemitter',
  'console',
  'process',
  'window',
  'document',
  'globalthis',
  'navigator',
  'crypto',
  'performance',
  'fetch',
  'require',
  'settimeout',
  'cleartimeout',
  'setinterval',
  'clearinterval',
  'setimmediate',
  'clearimmediate',
  'queuemicrotask',
  'structuredclone',
  'requestanimationframe',
  'cancelanimationframe',
  'parseint',
  'parsefloat',
  'isnan',
  'isfinite',
  'encodeuricomponent',
  'decodeuricomponent',
  'encodeuri',
  'decodeuri',
  'atob',
  'btoa',
  'parse',
  'stringify',
  'trim',
  'trimstart',
  'trimend',
  'slice',
  'substring',
  'substr',
  'split',
  'join',
  'replace',
  'replaceall',
  'match',
  'matchall',
  'search',
  'test',
  'exec',
  'includes',
  'startswith',
  'endswith',
  'indexof',
  'lastindexof',
  'tolowercase',
  'touppercase',
  'tostring',
  'valueof',
  'padstart',
  'padend',
  'repeat',
  'charat',
  'charcodeat',
  'push',
  'pop',
  'shift',
  'unshift',
  'splice',
  'concat',
  'filter',
  'reduce',
  'reduceright',
  'foreach',
  'some',
  'every',
  'find',
  'findindex',
  'flat',
  'flatmap',
  'sort',
  'reverse',
  'fill',
  'keys',
  'values',
  'entries',
  'fromentries',
  'isarray',
  'hasown',
  'assign',
  'freeze',
  'seal',
  'create',
  'defineproperty',
  'has',
  'get',
  'add',
  'clear',
  'min',
  'max',
  'floor',
  'ceil',
  'round',
  'abs',
  'sqrt',
  'pow',
  'trunc',
  'random',
  'sign',
  'now',
  'toisostring',
  'then',
  'all',
  'race',
  'allsettled',
  'any',
  'resolve',
  'reject',
  'abort',
  'log',
  'warn',
  'info',
  'debug',
  'dir',
  'trace',
  'assert',
  'equal',
  'deepequal',
  'notdeepequal',
  'strictequal',
  'throws',
  'doesnotthrow',
  'rejects',
  'doesnotreject',
  'existssync',
  'readfilesync',
  'writefilesync',
  'appendfilesync',
  'mkdirsync',
  'readdirsync',
  'statsync',
  'lstatsync',
  'unlinksync',
  'renamesync',
  'copyfilesync',
  'rmsync',
  'mkdtempsync',
  'opensync',
  'closesync',
  'readsync',
  'createhash',
  'randombytes',
  'randomuuid',
  'execsync',
  'execfilesync',
  'spawn',
  'spawnsync',
  'dirname',
  'basename',
  'extname',
  'relative',
  'normalize',
  'isabsolute',
  'homedir',
  'tmpdir',
  'platform',
  'arch',
  'cpus',
  'totalmem',
  'freemem',
  'isbuffer',
  'subarray',
  'bytelength',
  'addeventlistener',
  'removeeventlistener',
  'dispatchevent',
  'queryselector',
  'queryselectorall',
  'getelementbyid',
  'createelement',
  'appendchild',
  'removechild',
  'setattribute',
  'getattribute',
  'removeattribute',
  'hasattribute',
  'preventdefault',
  'stoppropagation',
  'focus',
  'blur',
  'click',
  'scrollintoview',
  'postmessage',
  'listen',
  'close',
  'writehead',
  'end',
  'write',
  'length',
  'size',
  'name',
  'message',
  'code',
  'status',
  'data',
  'stack',
  'prototype',
  'constructor',
  'role',
  'content',
  'user',
  'assistant',
  'system',
  'utf8',
  'utf16le',
  'sha1',
  'sha256',
  'base64',
  'hex',
  'html',
  'css',
  'http',
  'https',
  'post',
  'put',
  'patch',
  'head',
  'options',
]);

export const GROUNDING_GATED_TECH_ALIAS_TO_CANONICAL = new Map([
  ['redis', 'redis'],
  ['sqlite', 'sqlite'],
  ['postgres', 'postgres'],
  ['postgresql', 'postgres'],
  ['mysql', 'mysql'],
  ['mongodb', 'mongodb'],
  ['supabase', 'supabase'],
  ['firebase', 'firebase'],
  ['prisma', 'prisma'],
  ['drizzle', 'drizzle'],
  ['typeorm', 'typeorm'],
  ['sequelize', 'sequelize'],
  ['graphql', 'graphql'],
  ['grpc', 'grpc'],
  ['trpc', 'trpc'],
  ['kafka', 'kafka'],
  ['rabbitmq', 'rabbitmq'],
  ['celery', 'celery'],
  ['docker', 'docker'],
  ['kubernetes', 'kubernetes'],
  ['k8s', 'kubernetes'],
  ['terraform', 'terraform'],
  ['ansible', 'ansible'],
  ['nginx', 'nginx'],
  ['caddy', 'caddy'],
  ['sonarqube', 'sonarqube'],
  ['indexeddb', 'indexeddb'],
  ['vllm', 'vllm'],
  ['mtls', 'mtls'],
  ['oauth', 'oauth'],
  ['jwt', 'jwt'],
  ['webpack', 'webpack'],
  ['rollup', 'rollup'],
  ['nextjs', 'nextjs'],
  ['nuxt', 'nuxt'],
  ['svelte', 'svelte'],
  ['angular', 'angular'],
  ['fastapi', 'fastapi'],
  ['flask', 'flask'],
  ['django', 'django'],
  ['websocket', 'websocket'],
  ['websockets', 'websocket'],
]);

const GROUNDING_RU_TECH_STEM_PAIRS = [
  [/(?<![А-Яа-яЁё])редис[а-яё]*(?![А-Яа-яЁё])/i, 'redis'],
  [/(?<![А-Яа-яЁё])постгрес[а-яё]*(?![А-Яа-яЁё])/i, 'postgres'],
  [/(?<![А-Яа-яЁё])монго(?![А-Яа-яЁё])/i, 'mongodb'],
  [/(?<![А-Яа-яЁё])кафк[а-яё]*(?![А-Яа-яЁё])/i, 'kafka'],
  [/(?<![А-Яа-яЁё])докер[а-яё]*(?![А-Яа-яЁё])/i, 'docker'],
  [/(?<![А-Яа-яЁё])кубернетес[а-яё]*(?![А-Яа-яЁё])/i, 'kubernetes'],
  [/(?<![А-Яа-яЁё])графкл(?![А-Яа-яЁё])/i, 'graphql'],
  [/(?<![А-Яа-яЁё])вебсокет[а-яё]*(?![А-Яа-яЁё])/i, 'websocket'],
];

export function extractTerminalIdentifierFromExpr(rawExpr = '', { allowArgs = false } = {}) {
  let expr = String(rawExpr || '').trim();
  if (!expr) return '';
  if (allowArgs) {
    const openIdx = expr.indexOf('(');
    if (openIdx > 0 && expr.endsWith(')') && !expr.slice(openIdx + 1, -1).includes('(')) {
      expr = expr.slice(0, openIdx).trim();
    }
  } else if (expr.endsWith('()')) {
    expr = expr.slice(0, -2).trim();
  }
  if (!expr) return '';
  const parts = expr.split('.');
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i];
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(seg)) return '';
  }
  const last = parts[parts.length - 1];
  return last && last.length >= 2 ? last : '';
}

export const GROUNDING_FILE_PATH_RE =
  /(?<![A-Za-z0-9_./:-])([A-Za-z0-9_./-]*[A-Za-z0-9_]\.(?:mjs|cjs|js|ts|tsx|jsx|json|md|html|css|py|go|rs|toml|yaml|yml))\b/g;

export function normalizeGroundingPosixPath(p = '') {
  return String(p || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(?:\.\/)+/, '')
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/');
}

export function getPosixBasename(p = '') {
  const norm = normalizeGroundingPosixPath(p);
  const idx = norm.lastIndexOf('/');
  return idx >= 0 ? norm.slice(idx + 1) : norm;
}

export function stripFileExt(base = '') {
  const idx = base.lastIndexOf('.');
  return idx > 0 ? base.slice(0, idx) : base;
}

export function matchesKnownRepoFile(refPath = '', knownFilesNorm = []) {
  const refNorm = normalizeGroundingPosixPath(refPath).toLowerCase();
  if (!refNorm) return false;
  const refHasSlash = refNorm.includes('/');
  const refBase = getPosixBasename(refNorm);
  for (const k of knownFilesNorm) {
    const kLower = k.toLowerCase();
    if (kLower === refNorm) return true;
    if (refHasSlash) {
      if (kLower.endsWith(`/${refNorm}`)) return true;
      if (!kLower.includes('/') && kLower === refBase) return true;
    } else if (getPosixBasename(kLower) === refNorm) {
      return true;
    }
  }
  return false;
}

export function extractCitedFilePathsFromText(text = '', knownFilesNorm = []) {
  const cleanedUrls = String(text || '').replace(/https?:\/\/[^\s)`"'>]+/gi, ' ');
  const out = [];
  const seen = new Set();
  GROUNDING_FILE_PATH_RE.lastIndex = 0;
  let m;
  while ((m = GROUNDING_FILE_PATH_RE.exec(cleanedUrls)) !== null) {
    const rawCandidate = m[1];
    if (!rawCandidate) continue;
    if (
      !rawCandidate.includes('/') &&
      GROUNDING_IGNORED_FRAMEWORK_DOT_JS.has(rawCandidate) &&
      !matchesKnownRepoFile(rawCandidate, knownFilesNorm)
    ) {
      continue;
    }
    const norm = normalizeGroundingPosixPath(rawCandidate);
    const base = getPosixBasename(norm);
    if (!norm || !base || !/^[A-Za-z0-9_]/.test(base) || norm.includes('..') || norm.includes('/.') || seen.has(norm)) {
      continue;
    }
    seen.add(norm);
    out.push(norm);
  }
  return out;
}

export function buildKnownSymbolSet(symbols = [], extraText = '') {
  const set = new Set();
  if (Array.isArray(symbols)) {
    for (const raw of symbols) {
      const s = String(raw || '').trim();
      if (!s) continue;
      set.add(s);
      if (s.includes('.')) {
        for (const part of s.split('.')) {
          if (part.length >= 3) set.add(part);
        }
      }
    }
  }
  if (extraText) {
    const idRe = /[A-Za-z_$][A-Za-z0-9_$]{2,}/g;
    let m;
    while ((m = idRe.exec(extraText)) !== null) {
      set.add(m[0]);
    }
  }
  return set;
}

function sharesDraftTokenOrStem(item = '', draft = '') {
  const itemStr = String(item || '').toLowerCase();
  const draftStr = String(draft || '').toLowerCase();
  if (!itemStr || !draftStr) return false;

  const rawPathTokens = draftStr.match(/[a-z0-9_./-]{3,}/g) || [];
  for (const tok of rawPathTokens) {
    if (itemStr.includes(tok) || tok.includes(getPosixBasename(itemStr))) return true;
  }

  const splitCamelAndSep = (str) =>
    String(str)
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .match(/[a-zа-яё0-9]{3,}/g) || [];

  const itemTokens = splitCamelAndSep(item);
  const draftTokens = splitCamelAndSep(draft);
  if (itemTokens.length === 0 || draftTokens.length === 0) return false;

  for (const it of itemTokens) {
    if (it === 'mjs' || it === 'cjs' || it === 'json' || it === 'html' || it === 'core' || it === 'tests') continue;
    for (const dt of draftTokens) {
      if (it === dt) return true;
      const minStem = Math.min(4, it.length, dt.length);
      if (minStem >= 3 && it.slice(0, minStem) === dt.slice(0, minStem)) return true;
    }
  }
  return false;
}

/**
 * Deterministically verifies that a Ghost Text continuation only cites real workspace files,
 * AST/repo symbols, CLI flags, and slash commands rather than hallucinating non-existent names.
 * @param {string} [draft='']
 * @param {string} [continuation='']
 * @param {{ repoFiles?: string[], touchedFiles?: string[], symbols?: string[], allowedSlashCommands?: string[] }} [groundingCtx={}]
 */
export function verifyGhostContinuationGrounding(draft = '', continuation = '', groundingCtx = {}) {
  const draftStr = String(draft || '');
  const contStr = String(continuation || '');
  const trimmedCont = contStr.trim();

  if (!trimmedCont || /^(?:NONE|<none>|ПУСТО|НЕТ)[.!?]?$/i.test(trimmedCont)) {
    return {
      valid: false,
      reason: 'model_abstained',
      continuation: '',
      verifiedFiles: [],
      verifiedSymbols: [],
    };
  }

  const repoFiles = Array.isArray(groundingCtx?.repoFiles) ? groundingCtx.repoFiles : [];
  const touchedFiles = Array.isArray(groundingCtx?.touchedFiles) ? groundingCtx.touchedFiles : [];
  const symbols = Array.isArray(groundingCtx?.symbols) ? groundingCtx.symbols : [];
  const symbolsByFile =
    groundingCtx?.symbolsByFile && typeof groundingCtx.symbolsByFile === 'object'
      ? groundingCtx.symbolsByFile
      : null;
  const repoTechTerms = Array.isArray(groundingCtx?.repoTechTerms) ? groundingCtx.repoTechTerms : [];
  const allowedSlashCommands = Array.isArray(groundingCtx?.allowedSlashCommands)
    ? groundingCtx.allowedSlashCommands
    : [];

  // Reconstruct mid-token boundary if draft ended without whitespace and continuation continues that token
  let joinedText = contStr;
  if (draftStr && !/\s$/.test(draftStr) && !/^\s/.test(contStr)) {
    const tailMatch = /(`?[A-Za-z0-9_$/.-]+)$/.exec(draftStr);
    if (tailMatch && tailMatch[1]) {
      joinedText = `${tailMatch[1]}${contStr}`;
    }
  }

  // 1. Slash commands check
  const allowedSlashSet = new Set(
    allowedSlashCommands
      .map((cmd) => String(cmd || '').trim().toLowerCase())
      .filter(Boolean)
      .map((cmd) => (cmd.startsWith('/') ? cmd : `/${cmd}`))
  );
  if (allowedSlashSet.size > 0) {
    const unverifiedSlash = [];
    const slashRe = /(?:^|\s)(\/[a-z][a-z0-9_-]*)(?![a-z0-9_./-])/gi;
    let sm;
    while ((sm = slashRe.exec(joinedText)) !== null) {
      const cmdRaw = sm[1];
      const cmdLower = cmdRaw.toLowerCase();
      if (allowedSlashSet.has(cmdLower)) continue;
      if (GROUNDING_IGNORED_SLASH_SEGMENTS.has(cmdLower)) continue;
      if (!unverifiedSlash.includes(cmdRaw)) unverifiedSlash.push(cmdRaw);
    }
    if (unverifiedSlash.length > 0) {
      return {
        valid: false,
        reason: 'hallucinated_slash_command',
        unverified: unverifiedSlash,
        continuation: '',
        verifiedFiles: [],
        verifiedSymbols: [],
      };
    }
  }

  // 2. File paths check (Fail-Closed even when repoFiles/touchedFiles inventory is empty)
  const knownFilesNorm = [];
  const seenKnownFile = new Set();
  for (const f of [...repoFiles, ...touchedFiles]) {
    const norm = normalizeGroundingPosixPath(f);
    if (!norm || seenKnownFile.has(norm.toLowerCase())) continue;
    seenKnownFile.add(norm.toLowerCase());
    knownFilesNorm.push(norm);
  }

  const citedFiles = extractCitedFilePathsFromText(joinedText, knownFilesNorm);
  const verifiedFiles = [];
  if (citedFiles.length > 0) {
    if (knownFilesNorm.length === 0) {
      return {
        valid: false,
        reason: 'unverified_cold_index',
        unverified: citedFiles,
        continuation: '',
        verifiedFiles: [],
        verifiedSymbols: [],
      };
    }
    const unverifiedFiles = [];
    for (const f of citedFiles) {
      if (matchesKnownRepoFile(f, knownFilesNorm)) {
        verifiedFiles.push(f);
      } else {
        unverifiedFiles.push(f);
      }
    }
    if (unverifiedFiles.length > 0) {
      return {
        valid: false,
        reason: 'hallucinated_file',
        unverified: unverifiedFiles,
        continuation: '',
        verifiedFiles: [],
        verifiedSymbols: [],
      };
    }
  }

  // 3. CLI flags check (reject invented --cli-flags unless draft ends with '-')
  if (!/-$/.test(draftStr)) {
    const unverifiedFlags = [];
    const flagRe = /(?:^|\s)(--[a-z0-9][a-z0-9-]{2,})/gi;
    let fm;
    while ((fm = flagRe.exec(contStr)) !== null) {
      const flag = fm[1];
      if (!GROUNDING_ALLOWED_CLI_FLAGS.has(flag.toLowerCase()) && !unverifiedFlags.includes(flag)) {
        unverifiedFlags.push(flag);
      }
    }
    if (unverifiedFlags.length > 0) {
      return {
        valid: false,
        reason: 'hallucinated_cli_flag',
        unverified: unverifiedFlags,
        continuation: '',
        verifiedFiles: [],
        verifiedSymbols: [],
      };
    }
  }

  // 4. Gated external tech stack check (rejects Redis/SQLite/Docker/GraphQL/etc. unless present in repo or user draft)
  const allowedTechSet = new Set(
    repoTechTerms.map((t) => String(t || '').trim().toLowerCase()).filter(Boolean)
  );
  const draftLower = draftStr.toLowerCase();
  const invJoinedLower = `${knownFilesNorm.join(' ')} ${symbols.join(' ')}`.toLowerCase();
  for (const [alias, canonical] of GROUNDING_GATED_TECH_ALIAS_TO_CANONICAL.entries()) {
    if (draftLower.includes(alias) || invJoinedLower.includes(alias)) {
      allowedTechSet.add(canonical);
    }
  }
  for (const [ruRx, canonical] of GROUNDING_RU_TECH_STEM_PAIRS) {
    if (ruRx.test(draftStr)) {
      allowedTechSet.add(canonical);
    }
  }

  const unverifiedTech = [];
  const asciiWords = joinedText.match(/\b[A-Za-z][A-Za-z0-9]{2,}\b/g) || [];
  for (const w of asciiWords) {
    const canon = GROUNDING_GATED_TECH_ALIAS_TO_CANONICAL.get(w.toLowerCase());
    if (canon && !allowedTechSet.has(canon) && !unverifiedTech.includes(w)) {
      unverifiedTech.push(w);
    }
  }
  for (const [ruRx, canonical] of GROUNDING_RU_TECH_STEM_PAIRS) {
    if (!allowedTechSet.has(canonical)) {
      const m = ruRx.exec(contStr);
      if (m && m[0] && !unverifiedTech.includes(m[0])) {
        unverifiedTech.push(m[0]);
      }
    }
  }
  if (unverifiedTech.length > 0) {
    return {
      valid: false,
      reason: 'hallucinated_tech_term',
      unverified: unverifiedTech,
      continuation: '',
      verifiedFiles: [],
      verifiedSymbols: [],
    };
  }

  // 5. Code symbols check (Backticks, fn(), camelCase, snake_case, multi-hump PascalCase, Fail-Closed + Cross-File Chimera)
  const knownFileBaseLower = new Set();
  for (const kf of [...knownFilesNorm, ...citedFiles]) {
    const base = getPosixBasename(kf).toLowerCase();
    if (base) {
      knownFileBaseLower.add(base);
      const stem = stripFileExt(base);
      if (stem) knownFileBaseLower.add(stem);
    }
  }

  const knownSymbols = buildKnownSymbolSet(symbols);
  const extractedSymbols = [];
  const pushExtractedSym = (cand) => {
    const s = String(cand || '').trim();
    if (!s || s.length < 3) return;
    if (!s.includes('_') && /^[A-Z][A-Z0-9]{1,6}$/.test(s)) return;
    const lower = s.toLowerCase();
    if (GROUNDING_STANDARD_IDENTIFIERS_LOWER.has(lower)) return;
    if (GROUNDING_GATED_TECH_ALIAS_TO_CANONICAL.has(lower)) return;
    if (knownFileBaseLower.has(lower)) return;
    if (!extractedSymbols.includes(s)) extractedSymbols.push(s);
  };

  // Backticked code identifiers in joinedText
  const btRe = /`([^`\r\n]{2,80})`/g;
  let bm;
  while ((bm = btRe.exec(joinedText)) !== null) {
    const inner = bm[1].trim();
    if (!inner || inner.includes('/') || inner.includes('\\') || inner.startsWith('-') || /\s/.test(inner)) {
      continue;
    }
    if (/\.[A-Za-z]{2,4}$/.test(inner) && knownFileBaseLower.has(inner.toLowerCase())) {
      continue;
    }
    const termIdent = extractTerminalIdentifierFromExpr(inner, { allowArgs: false });
    if (termIdent) {
      pushExtractedSym(termIdent);
    }
  }

  // Mask URLs, file paths, and backticked spans before scanning prose for fn(), camelCase, snake_case, PascalCase
  const proseForSyms = joinedText
    .replace(/https?:\/\/[^\s)`"'>]+/gi, ' ')
    .replace(GROUNDING_FILE_PATH_RE, ' ')
    .replace(/`[^`\r\n]*`/g, ' ');

  const fnCallRe = /\b([A-Za-z_$][A-Za-z0-9_$]{2,})(\s*)\(([^)\r\n]{0,40})/g;
  let cm;
  while ((cm = fnCallRe.exec(proseForSyms)) !== null) {
    const fnName = cm[1];
    const ws = cm[2] || '';
    const insidePreview = cm[3] || '';
    // When whitespace precedes '(', treat as prose parenthetical unless fnName is camelCase/snake_case
    if (ws.length > 0) {
      if (
        !/^(?:[a-z]+[A-Z][A-Za-z0-9_]*|[a-z]{2,}_[a-z0-9_]{2,})$/.test(fnName) ||
        /^\s*[А-Яа-яЁё]/.test(insidePreview)
      ) {
        continue;
      }
    }
    pushExtractedSym(fnName);
  }

  const camelRe = /\b([a-z]+[A-Z][A-Za-z0-9_]*)\b/g;
  let cam;
  while ((cam = camelRe.exec(proseForSyms)) !== null) {
    pushExtractedSym(cam[1]);
  }

  const pascalRe = /\b([A-Z][a-z0-9]+[A-Z][A-Za-z0-9_]*)\b/g;
  let pm;
  while ((pm = pascalRe.exec(proseForSyms)) !== null) {
    pushExtractedSym(pm[1]);
  }

  const snakeRe = /\b([a-z]{2,}_[a-z0-9_]{2,})\b/g;
  let snm;
  while ((snm = snakeRe.exec(proseForSyms)) !== null) {
    pushExtractedSym(snm[1]);
  }

  const verifiedSymbols = [];
  if (extractedSymbols.length > 0) {
    if (knownSymbols.size === 0) {
      return {
        valid: false,
        reason: 'unverified_cold_index',
        unverified: extractedSymbols,
        continuation: '',
        verifiedFiles,
        verifiedSymbols: [],
      };
    }
    const unverifiedSymbols = [];
    for (const sym of extractedSymbols) {
      if (knownSymbols.has(sym)) {
        verifiedSymbols.push(sym);
      } else {
        unverifiedSymbols.push(sym);
      }
    }
    if (unverifiedSymbols.length > 0) {
      return {
        valid: false,
        reason: 'hallucinated_symbol',
        unverified: unverifiedSymbols,
        continuation: '',
        verifiedFiles,
        verifiedSymbols: [],
      };
    }
  }

  // 6. Cross-file symbol affinity check (blocks chimera pairings like ui.html + unrelated safe-json symbol)
  if (verifiedSymbols.length > 0 && symbolsByFile) {
    const allMentionedFiles = extractCitedFilePathsFromText(`${draftStr} ${contStr}`, knownFilesNorm).filter((f) =>
      matchesKnownRepoFile(f, knownFilesNorm)
    );
    if (allMentionedFiles.length > 0) {
      const symMapEntries = Object.entries(symbolsByFile);
      if (symMapEntries.length > 0) {
        const scopedSymbolPool = new Set();
        let allFilesMapped = true;
        for (const mf of allMentionedFiles) {
          const mfNorm = normalizeGroundingPosixPath(mf).toLowerCase();
          const mfBase = getPosixBasename(mfNorm);
          let matchedList = null;
          for (const [k, list] of symMapEntries) {
            const kNorm = normalizeGroundingPosixPath(k).toLowerCase();
            if (
              kNorm === mfNorm ||
              (mfNorm.includes('/') && kNorm.endsWith(`/${mfNorm}`)) ||
              (!mfNorm.includes('/') && getPosixBasename(kNorm) === mfBase)
            ) {
              matchedList = Array.isArray(list) ? list : null;
              break;
            }
          }
          if (!matchedList || matchedList.length === 0) {
            allFilesMapped = false;
            break;
          }
          for (const s of matchedList) {
            for (const expanded of buildKnownSymbolSet([s])) {
              scopedSymbolPool.add(expanded);
            }
          }
        }
        if (allFilesMapped && scopedSymbolPool.size > 0) {
          const mismatched = verifiedSymbols.filter((sym) => !scopedSymbolPool.has(sym));
          if (mismatched.length > 0) {
            return {
              valid: false,
              reason: 'cross_file_symbol_mismatch',
              unverified: mismatched,
              continuation: '',
              verifiedFiles,
              verifiedSymbols: [],
            };
          }
        }
      }
    }
  }

  return {
    valid: true,
    continuation: contStr,
    verifiedFiles,
    verifiedSymbols,
  };
}

/**
 * Generates an inline Ghost Text continuation for the user's unfinished chat prompt
 * using the local Ollama chat model (zero cloud tokens) with strict VRAM-cap & AbortSignal guards.
 * @param {object} [options={}]
 */
export async function generatePromptContinuation({
  draft = '',
  recentGoals = [],
  recentMessages = [],
  touchedFiles = [],
  symbolHints = [],
  ragSnippets = [],
  repoFiles = [],
  allRepoSymbols = [],
  symbolsByFile = null,
  repoTechTerms = [],
  allowedSlashCommands = [],
  allowFollowUpSentence = false,
  maxOutputTokens = 44,
  timeoutMs = 2200,
  signal = null,
  lang = '',
  cfgOverride = null,
  httpJsonFn = null,
  hwProbeFn = null,
  _bypassCache = false,
} = {}) {
  const rawDraft = String(draft || '');
  if (rawDraft.trim().length < 3 || rawDraft.length > 1200) {
    return { ok: false, continuation: '', error: 'Draft out of range' };
  }
  if (signal?.aborted) {
    return { ok: false, aborted: true, continuation: '', error: 'Ollama request aborted' };
  }

  const followUpSentence = isCompletedSentenceDraft(rawDraft);
  if (followUpSentence && !allowFollowUpSentence) {
    return { ok: false, abstainedCompletedSentence: true, continuation: '', latencyMs: 0 };
  }

  const cfg = cfgOverride ? loadGpuConfig(cfgOverride) : loadGpuConfig();
  const contLang = normalizeLang(lang || cfg.uiLanguage || readActiveUiLanguage(), 'en');
  if (!cfg.gpuEnabled) {
    return { ok: false, skippedGpuDisabled: true, continuation: '', error: 'GPU engine disabled' };
  }

  const cleanFiles = Array.isArray(touchedFiles)
    ? touchedFiles.map((f) => String(f || '').trim()).filter(Boolean).slice(0, 6)
    : [];
  const cleanSymbols = Array.isArray(symbolHints)
    ? symbolHints.map((s) => String(s || '').trim()).filter(Boolean).slice(0, 8)
    : [];
  const cleanRepoFiles = Array.isArray(repoFiles)
    ? repoFiles.map((f) => String(f || '').trim()).filter(Boolean)
    : [];
  const cleanAllRepoSymbols = Array.isArray(allRepoSymbols)
    ? allRepoSymbols.map((s) => String(s || '').trim()).filter(Boolean)
    : [];
  const cleanAllowedSlash = Array.isArray(allowedSlashCommands)
    ? allowedSlashCommands.map((c) => String(c || '').trim()).filter(Boolean)
    : [];
  const cleanGoals = Array.isArray(recentGoals)
    ? recentGoals.map((g) => String(g || '').trim()).filter(Boolean).slice(0, 2)
    : [];
  const cleanRecentMessages = Array.isArray(recentMessages)
    ? recentMessages
        .slice(-4)
        .map((m) => {
          const role = m?.role === 'assistant' ? 'assistant' : 'user';
          const text = String(m?.content || '').replace(/\s+/g, ' ').trim().slice(0, 180);
          return text ? `${role}: ${text}` : '';
        })
        .filter(Boolean)
    : [];
  const ragSnippetFiles = [];
  const ragSnippetSymbols = [];
  const cleanRagSnippets = Array.isArray(ragSnippets)
    ? ragSnippets
        .slice(0, 3)
        .map((item) => {
          if (typeof item === 'string') return item.trim().slice(0, 120);
          if (!item || typeof item !== 'object') return '';
          const file = String(item.file || '').trim();
          if (!file) return '';
          ragSnippetFiles.push(file);
          const start = Number(item.startLine) || 0;
          const end = Number(item.endLine) || 0;
          const range = start > 0 ? `:L${start}${end >= start && end > 0 ? `-${end}` : ''}` : '';
          const symArr = Array.isArray(item.symbols)
            ? item.symbols.map((s) => String(s || '').trim()).filter(Boolean).slice(0, 4)
            : String(item.symbols || '').trim()
              ? [String(item.symbols || '').trim()]
              : [];
          for (const sym of symArr) ragSnippetSymbols.push(sym);
          const syms = symArr.join(', ');
          return `${file}${range}${syms ? ` (${syms})` : ''}`.slice(0, 120);
        })
        .filter(Boolean)
    : [];

  const groundingRepoFiles = cleanRepoFiles.length > 0
    ? [...new Set([...cleanRepoFiles, ...ragSnippetFiles])]
    : [...new Set([...cleanFiles, ...ragSnippetFiles])];
  const groundingSymbols = cleanAllRepoSymbols.length > 0
    ? [...new Set([...cleanAllRepoSymbols, ...cleanSymbols, ...ragSnippetSymbols])]
    : [...new Set([...cleanSymbols, ...ragSnippetSymbols])];

  const requestedModel = cfg.gpuChatModel;
  const requestedTag = normalizeOllamaTag(requestedModel);
  const predictTokens = clampInt(maxOutputTokens, 8, 96, followUpSentence ? 48 : 44);
  const ragHash = cleanRagSnippets.length > 0
    ? createHash('sha1').update(cleanRagSnippets.join('|')).digest('hex').slice(0, 10)
    : '';
  const chatCtxHash = cleanRecentMessages.length > 0
    ? createHash('sha1').update(cleanRecentMessages.join('|')).digest('hex').slice(0, 8)
    : '';
  const cacheKey = createHash('sha1')
    .update(
      `v3|${requestedTag}|${followUpSentence ? 'fu' : 'in'}|p${predictTokens}|${cleanFiles.slice(0, 5).join(',')}|${rawDraft}${ragHash ? `|rag:${ragHash}` : ''}${chatCtxHash ? `|chat:${chatCtxHash}` : ''}`
    )
    .digest('hex');

  if (!_bypassCache) {
    const cached = getFreshContinuationCacheEntry(cacheKey);
    if (cached && cached.continuation) {
      const cachedCheck = verifyGhostContinuationGrounding(rawDraft, cached.continuation, {
        repoFiles: groundingRepoFiles,
        touchedFiles: cleanFiles,
        symbols: groundingSymbols,
        symbolsByFile,
        repoTechTerms,
        allowedSlashCommands: cleanAllowedSlash,
      });
      if (cachedCheck.valid) {
        return {
          ok: true,
          continuation: cached.continuation,
          model: cached.model || requestedModel,
          fromRamCache: true,
          latencyMs: 0.2,
        };
      }
    }
  }

  const callHttp = httpJsonFn || ollamaHttpJson;

  if (!httpJsonFn) {
    const ready = await ensureOllamaRunning(cfg);
    if (!ready.ok) {
      return { ok: false, continuation: '', error: ready.error || 'Ollama not reachable' };
    }
    if (signal?.aborted) {
      return { ok: false, aborted: true, continuation: '', error: 'Ollama request aborted' };
    }
  }

  const hw = hwProbeFn ? hwProbeFn() : probeNvidiaGpu();
  const psRes = await callHttp('GET', '/api/ps', null, 600, cfg.gpuEndpoint, { signal });
  if (signal?.aborted || psRes?.aborted) {
    return { ok: false, aborted: true, continuation: '', error: 'Ollama request aborted' };
  }
  let loadedModels = Array.isArray(psRes?.data?.models) ? psRes.data.models : [];

  let tagSource = null;
  if (httpJsonFn) {
    const tagsRes = await callHttp('GET', '/api/tags', null, 600, cfg.gpuEndpoint, { signal });
    if (signal?.aborted || tagsRes?.aborted) {
      return { ok: false, aborted: true, continuation: '', error: 'Ollama request aborted' };
    }
    tagSource = tagsRes?.ok && Array.isArray(tagsRes.data?.models) ? tagsRes.data.models : null;
  } else {
    tagSource = await getCachedOrFetchOllamaTagMap(cfg);
  }
  if (signal?.aborted) {
    return { ok: false, aborted: true, continuation: '', error: 'Ollama request aborted' };
  }

  const fit = evaluateVramModelFit({
    cfg: { ...cfg, gpuChatModel: requestedModel },
    tagModels: tagSource,
    loadedModels,
    hw,
  });
  const tagInventoryKnown = Array.isArray(tagSource) || (tagSource instanceof Map && tagSource.size > 0);

  let targetModel = requestedModel;
  if (fit.selectedSizeFits && (!tagInventoryKnown || fit.selectedChatDownloaded)) {
    targetModel = requestedModel;
  } else if (fit.bestFallbackChatModel) {
    targetModel = fit.bestFallbackChatModel;
  } else {
    await unloadModelsExceedingBudget({ cfg, loadedModels, tagModels: tagSource, hw, callHttp });
    return {
      ok: false,
      skippedVramCap: true,
      continuation: '',
      error: (normalizeLang(lang || cfg.uiLanguage || readActiveUiLanguage(), 'en') === 'en')
        ? (fit.reasonEn || fit.reasonRu || `Model ${requestedModel} exceeds the ${fit.capGb} GB VRAM limit`)
        : (fit.reasonRu || fit.reasonEn || `Модель ${requestedModel} превышает лимит ${fit.capGb} ГБ VRAM`),
    };
  }

  // Live free-VRAM guard: if targetModel is cold and external apps reduced free GPU memory below its footprint,
  // switch to an already-warm chat model or a smaller downloaded chat model (e.g. qwen3:4b) to avoid 8s CPU-spill timeouts.
  let targetTag = normalizeOllamaTag(targetModel);
  let targetEstVramMb = estimateModelVramMb(targetModel, tagSource, [], cfg.gpuEmbedModel);
  const preWarmTarget = loadedModels.some((m) => normalizeOllamaTag(m?.name || m?.model || '') === targetTag);
  if (!preWarmTarget && hw?.available && hw?.vramReliable && Number(hw.freeMb) > 0 && targetEstVramMb > 0) {
    const recPre = reconcileLoadedModelsVram(loadedModels, tagSource, hw);
    const reclaimableChatMb = recPre.loadedModels
      .filter((m) => !isOllamaEmbedModel(m.name, cfg.gpuEmbedModel))
      .reduce((sum, m) => sum + (Number(m.vramMb) || 0), 0);
    const liveAvailMb = Number(hw.freeMb) + reclaimableChatMb + VRAM_CAP_TOLERANCE_MB;
    if (targetEstVramMb > liveAvailMb && Array.isArray(fit.compatibleChatModels) && fit.compatibleChatModels.length > 0) {
      const warmCompatible = fit.compatibleChatModels.find((cand) =>
        loadedModels.some((m) => normalizeOllamaTag(m?.name || m?.model || '') === normalizeOllamaTag(cand.name))
      );
      const fittingCold = fit.compatibleChatModels.find(
        (cand) => cand.estVramMb > 0 && cand.estVramMb <= liveAvailMb
      );
      const chosenLive = warmCompatible || fittingCold;
      if (chosenLive?.name) {
        targetModel = chosenLive.name;
        targetTag = normalizeOllamaTag(targetModel);
        targetEstVramMb = chosenLive.estVramMb || estimateModelVramMb(targetModel, tagSource, [], cfg.gpuEmbedModel);
      }
    }
  }

  const unloadRes = await unloadModelsExceedingBudget({
    cfg,
    loadedModels,
    tagModels: tagSource,
    hw,
    callHttp,
    reserveForModel: { name: targetModel, estVramMb: targetEstVramMb, isEmbed: false },
  });
  if (signal?.aborted) {
    return { ok: false, aborted: true, continuation: '', error: 'Ollama request aborted' };
  }
  loadedModels = unloadRes.remainingRaw;
  const isModelWarm = loadedModels.some((m) => normalizeOllamaTag(m?.name || m?.model || '') === targetTag);
  const effectiveTimeoutMs = isModelWarm
    ? clampInt(timeoutMs, 600, 8000, 2200)
    : clampInt(Math.max(timeoutMs, 5800), 1000, 10000, 5800);

  const endsWithTargetPrep = /(?:^|\s)(?:в|во|из|для|файл[аеуыов]*|модул[ьяюеией]*)\s*$/i.test(rawDraft);
  const explicitlyScopedCaller =
    Array.isArray(touchedFiles) &&
    touchedFiles.length > 0 &&
    touchedFiles.length <= 3 &&
    endsWithTargetPrep;
  const injectedFiles =
    cleanRagSnippets.length > 0 || explicitlyScopedCaller
      ? cleanFiles
      : cleanFiles.filter((f) => sharesDraftTokenOrStem(f, rawDraft));
  const injectedSymbols =
    cleanRagSnippets.length > 0 || (explicitlyScopedCaller && cleanSymbols.length <= 4)
      ? cleanSymbols
      : cleanSymbols.filter((s) => sharesDraftTokenOrStem(s, rawDraft));
  const relevantGoals = cleanGoals.filter((g) => sharesDraftTokenOrStem(g, rawDraft));

  const contextLines = [];
  if (injectedFiles.length > 0) contextLines.push(`FILES: ${injectedFiles.join(', ')}`);
  if (injectedSymbols.length > 0) contextLines.push(`SYMBOLS: ${injectedSymbols.join(', ')}`);
  if (relevantGoals.length > 0) contextLines.push(`RECENT: ${relevantGoals.join(' | ')}`);
  if (cleanRecentMessages.length > 0) contextLines.push(`CHAT_CONTEXT: ${cleanRecentMessages.join(' | ')}`);
  if (cleanRagSnippets.length > 0) contextLines.push(`RAG_CONTEXT: ${cleanRagSnippets.join(' ; ')}`);
  if (followUpSentence) {
    contextLines.push(`COMPLETED_FIRST_SENTENCE: ${rawDraft}`);
    contextLines.push(
      'TASK: Write ONE meaningful follow-up requirement, constraint, or concrete example FROM THE HUMAN DEVELOPER (5 to 20 words) that builds on the full COMPLETED_FIRST_SENTENCE and CHAT_CONTEXT if present (strictly user voice, NEVER answer the question, or output NONE if unsure):'
    );
  } else {
    contextLines.push(`UNFINISHED_USER_PROMPT: ${rawDraft}`);
    contextLines.push(
      'TASK: Output ONLY a natural, informative inline suffix (5 to 20 words) that completes UNFINISHED_USER_PROMPT using all context already typed (and CHAT_CONTEXT if present), as the human developer (stop at end of current sentence, NEVER answer the prompt, or output NONE if unsure):'
    );
  }

  const isEnCont = contLang === 'en';
  const systemPrompt = followUpSentence
    ? (isEnCont
        ? "You are an inline Ghost Text prompt-composer autocomplete writing strictly AS THE HUMAN DEVELOPER composing a multi-part request TO an AI coding assistant. The developer just finished a sentence/question and wants ONE rich, context-aware follow-up sentence FROM THEIR OWN PERSPECTIVE to specify scope, acceptance criteria, edge cases, target files, or a concrete example (e.g. 'For example, ...', 'Also make sure ...', 'Preferably without ...'). Use ALL context already typed in COMPLETED_FIRST_SENTENCE (and CHAT_CONTEXT if present) without stopping at just 2 generic words. CRITICAL: You are the HUMAN USER, NEVER the AI assistant! NEVER answer the question, NEVER confirm/deny or explain how to solve it. FORBIDDEN openings: 'Yes', 'No', 'Sure', 'You can', 'This can', 'Let us', 'Let\\'s', 'Here is', 'Да', 'Нет', 'Конечно'. STRICT GROUNDING: NEVER invent file paths, function/variable names, --cli-flags, or /slash commands that are not explicitly listed in FILES, SYMBOLS, or RAG_CONTEXT; if there is no high-confidence grounded continuation, output literally NONE. Output ONLY 1 user-side sentence (5 to 20 words), no quotes, no line breaks, without repeating COMPLETED_FIRST_SENTENCE. Same language as input (English by default)."
        : "You are an inline Ghost Text prompt-composer autocomplete writing strictly AS THE HUMAN DEVELOPER composing a multi-part request TO an AI coding assistant. The developer just finished a sentence/question and wants ONE rich, context-aware follow-up sentence FROM THEIR OWN PERSPECTIVE to specify scope, acceptance criteria, edge cases, target files, or a concrete example (e.g. 'Например, ...', 'При этом важно, чтобы ...', 'Желательно без ...', 'В частности для ...'). Use ALL context already typed in COMPLETED_FIRST_SENTENCE (and CHAT_CONTEXT if present) without stopping at just 2 generic words. CRITICAL: You are the HUMAN USER, NEVER the AI assistant! NEVER answer the question, NEVER confirm/deny or explain how to solve it. FORBIDDEN openings: 'Да', 'Нет', 'Конечно', 'Безусловно', 'Разумеется', 'Это можно', 'Для этого', 'Чтобы это реализовать', 'Я могу', 'Мы можем', 'Давайте', 'Дело в том', 'Yes', 'No', 'Sure', 'You can', 'This can'. STRICT GROUNDING: NEVER invent file paths, function/variable names, --cli-flags, or /slash commands that are not explicitly listed in FILES, SYMBOLS, or RAG_CONTEXT; if there is no high-confidence grounded continuation, output literally NONE. Output ONLY 1 user-side sentence (5 to 20 words), no quotes, no line breaks, without repeating COMPLETED_FIRST_SENTENCE. Same language as input (Russian by default).")
    : (isEnCont
        ? "You are an inline Ghost Text prompt-composer autocomplete writing strictly AS THE HUMAN DEVELOPER typing an unfinished prompt TO an AI coding assistant. Read the ENTIRE UNFINISHED_USER_PROMPT (and CHAT_CONTEXT if present) and output a natural, informative continuation suffix (5 to 20 words) that finishes the developer's thought completely rather than cutting off after 2 generic words. Stop at the end of the sentence; NEVER start a second sentence and NEVER answer the user's question. FORBIDDEN assistant replies: 'Yes,', 'No,', 'Sure', 'You can', 'Here is', 'Да,', 'Нет,', 'Конечно'. STRICT GROUNDING: NEVER invent file paths, function/variable names, --cli-flags, or /slash commands that are not explicitly listed in FILES, SYMBOLS, or RAG_CONTEXT; if there is no high-confidence grounded continuation, output literally NONE. NEVER repeat the user's words, NEVER wrap in quotes, NEVER add explanations or line breaks. Continue in the same language as the user's input (English by default)."
        : "You are an inline Ghost Text prompt-composer autocomplete writing strictly AS THE HUMAN DEVELOPER typing an unfinished prompt TO an AI coding assistant. Read the ENTIRE UNFINISHED_USER_PROMPT (and CHAT_CONTEXT if present) and output a natural, informative continuation suffix (5 to 20 words) that finishes the developer's thought completely rather than cutting off after 2 generic words. Stop at the end of the sentence; NEVER start a second sentence and NEVER answer the user's question. FORBIDDEN assistant replies: 'Да,', 'Нет,', 'Конечно', 'Безусловно', 'Это можно', 'Для этого', 'Я могу', 'Давайте', 'Yes,', 'No,', 'Sure', 'You can'. STRICT GROUNDING: NEVER invent file paths, function/variable names, --cli-flags, or /slash commands that are not explicitly listed in FILES, SYMBOLS, or RAG_CONTEXT; if there is no high-confidence grounded continuation, output literally NONE. NEVER repeat the user's words, NEVER wrap in quotes, NEVER add explanations or line breaks. Continue in the same language as the user's input (Russian by default).");

  const body = {
    model: targetModel,
    stream: false,
    keep_alive: cfg.gpuKeepAlive,
    messages: [
      {
        role: 'system',
        content: systemPrompt,
      },
      {
        role: 'user',
        content: contextLines.join('\n'),
      },
    ],
    options: {
      num_ctx: (rawDraft.length > 300 || cleanRecentMessages.length > 0) ? 2048 : (cleanRagSnippets.length > 0 ? 1536 : 1024),
      num_predict: predictTokens,
      temperature: 0.2,
      top_p: 0.85,
      stop: ['```', '\n\n'],
    },
  };
  if (/qwen3|gemma4|deepseek/i.test(targetModel)) {
    body.think = false;
  }

  const reqOpts = {
    signal,
    workInfoOverride: {
      op: 'autocomplete',
      model: targetModel,
      detail: isEnCont ? `Smart Composer (${targetModel})` : `Умный ввод (${targetModel})`,
    },
  };

  const t0 = Date.now();
  let chatRes = await callHttp('POST', '/api/chat', body, effectiveTimeoutMs, cfg.gpuEndpoint, reqOpts);
  if (signal?.aborted || chatRes?.aborted) {
    return { ok: false, aborted: true, continuation: '', error: 'Ollama request aborted' };
  }
  if (!chatRes.ok && Object.hasOwn(body, 'think') && /think/i.test(String(chatRes.error || ''))) {
    delete body.think;
    chatRes = await callHttp('POST', '/api/chat', body, effectiveTimeoutMs, cfg.gpuEndpoint, reqOpts);
    if (signal?.aborted || chatRes?.aborted) {
      return { ok: false, aborted: true, continuation: '', error: 'Ollama request aborted' };
    }
  }

  if (!chatRes.ok) {
    const latencyMs = Date.now() - t0;
    return { ok: false, continuation: '', error: chatRes.error || 'Ollama /api/chat failed', latencyMs };
  }

  let rawContent = String(chatRes.data?.message?.content || '');
  let continuation = sanitizeGhostContinuation(rawDraft, rawContent);

  // If the chat model slipped into assistant Q&A mode on a completed sentence/question, retry once with explicit negative steering
  if (
    !continuation &&
    followUpSentence &&
    rawContent.trim() &&
    isAssistantAnswerContinuation(rawDraft, rawContent) &&
    (Date.now() - t0) < 1200 &&
    !signal?.aborted
  ) {
    const retryBody = {
      ...body,
      messages: [
        ...body.messages,
        { role: 'assistant', content: rawContent.trim().slice(0, 120) },
        {
          role: 'user',
          content: isEnCont
            ? "REJECTED: You answered as the AI assistant instead of continuing as the human user. Output ONLY 1 short user-perspective requirement or example (e.g. starting with 'For example,' / 'So that' / 'Preferably') to append to the user's prompt:"
            : "REJECTED: You answered as the AI assistant instead of continuing as the human user. Output ONLY 1 short user-perspective requirement or example (e.g. starting with 'Например,' / 'Чтобы' / 'Желательно') to append to the user's prompt:",
        },
      ],
      options: {
        ...body.options,
        temperature: 0.35,
      },
    };
    const retryRes = await callHttp('POST', '/api/chat', retryBody, Math.min(effectiveTimeoutMs, 1800), cfg.gpuEndpoint, reqOpts);
    if (signal?.aborted || retryRes?.aborted) {
      return { ok: false, aborted: true, continuation: '', error: 'Ollama request aborted' };
    }
    if (retryRes?.ok) {
      rawContent = String(retryRes.data?.message?.content || '');
      continuation = sanitizeGhostContinuation(rawDraft, rawContent);
    }
  }

  const latencyMs = Date.now() - t0;
  const grounding = verifyGhostContinuationGrounding(rawDraft, continuation, {
    repoFiles: groundingRepoFiles,
    touchedFiles: cleanFiles,
    symbols: groundingSymbols,
    symbolsByFile,
    repoTechTerms,
    allowedSlashCommands: cleanAllowedSlash,
  });
  if (!grounding.valid) {
    return {
      ok: false,
      continuation: '',
      rejectedHallucination: grounding.reason,
      unverified: grounding.unverified || [],
      model: targetModel,
      latencyMs,
    };
  }

  if (continuation && !_bypassCache) {
    setContinuationCacheEntry(cacheKey, {
      ts: Date.now(),
      continuation,
      model: targetModel,
    });
  }

  return {
    ok: Boolean(continuation),
    continuation,
    model: targetModel,
    latencyMs,
  };
}

const MAX_LOCAL_VISION_IMAGE_BYTES = 4 * 1024 * 1024;

/**
 * Разбирает прикреплённый UI-скриншот (base64, <= 4 МБ) локальной мультимодальной моделью Gemma 4 без затрат облака.
 * @param {object} [opts={}]
 * @returns {Promise<object>}
 */
export async function analyzeUiScreenshotLocally(opts = {}) {
  const safeOpts = opts && typeof opts === 'object' && !Array.isArray(opts) ? opts : {};
  const lang = normalizeLang(safeOpts.lang || safeOpts.uiLanguage, 'ru');
  const isEn = lang === 'en';
  const rawImg = typeof safeOpts.imageBase64 === 'string' ? safeOpts.imageBase64.trim() : '';
  if (!rawImg) {
    return { ok: false, error: isEn ? 'Image (imageBase64) is missing' : 'Не передано изображение (imageBase64)' };
  }
  const cleanB64 = rawImg.replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/i, '').replace(/\s+/g, '');
  if (!cleanB64 || !/^[A-Za-z0-9+/=]+$/.test(cleanB64)) {
    return { ok: false, error: isEn ? 'Invalid base64 screenshot format' : 'Некорректный формат base64-скриншота' };
  }
  const approxBytes = Math.floor((cleanB64.length * 3) / 4);
  if (approxBytes > MAX_LOCAL_VISION_IMAGE_BYTES) {
    return { ok: false, error: isEn ? 'Screenshot exceeds 4 MB limit' : 'Скриншот превышает лимит 4 МБ' };
  }

  const httpJsonFn = typeof safeOpts.httpJsonFn === 'function' ? safeOpts.httpJsonFn : null;
  const cfg = safeOpts.cfgOverride ? loadGpuConfig(safeOpts.cfgOverride) : loadGpuConfig();
  if (!httpJsonFn && !cfg.gpuEnabled) {
    return { ok: false, skippedGpuDisabled: true, error: isEn ? 'Local GPU is disabled in settings' : 'Локальный GPU выключен в настройках' };
  }

  const userHint = typeof safeOpts.userHint === 'string' ? safeOpts.userHint.trim().slice(0, 600) : '';
  let targetModel = cfg.gpuChatModel || DEFAULT_GPU_CONFIG.gpuChatModel;
  if (!httpJsonFn) {
    const ready = await ensureOllamaRunning(cfg).catch(() => ({ ok: false }));
    if (!ready?.ok) {
      return { ok: false, error: ready?.error || (isEn ? 'Ollama not reachable' : 'Ollama недоступна') };
    }
    const hw = probeNvidiaGpu();
    const psRes = await ollamaHttpJson('GET', '/api/ps', null, 800, cfg.gpuEndpoint).catch(() => null);
    const loadedModels = Array.isArray(psRes?.data?.models) ? psRes.data.models : [];
    const tagSource = await getCachedOrFetchOllamaTagMap(cfg).catch(() => null);
    const fit = evaluateVramModelFit({ cfg: { ...cfg, gpuChatModel: targetModel }, tagModels: tagSource, loadedModels, hw });
    const tagKnown = Array.isArray(tagSource) || (tagSource instanceof Map && tagSource.size > 0);
    if (fit.selectedSizeFits && (!tagKnown || fit.selectedChatDownloaded)) {
      targetModel = fit.selectedChatModel || targetModel;
    } else if (fit.bestFallbackChatModel) {
      targetModel = fit.bestFallbackChatModel;
    } else {
      await unloadModelsExceedingBudget({ cfg, loadedModels, tagModels: tagSource, hw, callHttp: ollamaHttpJson }).catch(() => {});
      return { ok: false, skippedVramCap: true, error: fit.reasonEn || fit.reasonRu || 'VRAM limit exceeded' };
    }
  }
  const timeoutMs = clampInt(safeOpts.timeoutMs, 1500, 60_000, 18_000);
  const body = {
    model: targetModel,
    stream: false,
    think: false,
    format: 'json',
    keep_alive: cfg.gpuKeepAlive,
    messages: [
      {
        role: 'system',
        content: isEn
          ? 'You are a strict local UI/UX visual inspector. Analyze the attached UI screenshot for layout defects, contrast issues, spacing alignment, and visual style tokens. Output strict JSON in English: {"analysisRu":"...","defectsRu":["..."],"promptPatchRu":"Short concise UI fix prompt in English"}'
          : 'You are a strict local UI/UX visual inspector. Analyze the attached UI screenshot for layout defects, contrast issues, spacing alignment, and visual style tokens. Output strict JSON in Russian: {"analysisRu":"...","defectsRu":["..."],"promptPatchRu":"Короткий чёткий промпт на русском для исправления UI"}',
      },
      {
        role: 'user',
        content: isEn
          ? (userHint
              ? `Inspect the attached UI screenshot focusing on: ${userHint}`
              : 'Inspect the attached UI screenshot: identify layout, contrast, and spacing issues and form a short fix task.')
          : (userHint
              ? `Разбери прикреплённый UI-скриншот с учётом фокуса: ${userHint}`
              : 'Разбери прикреплённый UI-скриншот: найди проблемы вёрстки, контраста, отступов и сформируй короткую задачу на доработку.'),
        images: [cleanB64],
      },
    ],
    options: {
      temperature: 0.1,
      num_predict: 380,
      num_ctx: Math.min(8192, Math.max(4096, Number(cfg.gpuContextTokens) || 4096)),
    },
  };

  try {
    const callHttp = httpJsonFn || ollamaHttpJson;
    const res = await callHttp('POST', '/api/chat', body, timeoutMs, cfg.gpuEndpoint, {
      priority: 'foreground',
      workInfoOverride: { op: 'local_vision', model: targetModel, detail: isEn ? 'Inspect UI screenshot' : 'Разбор UI-скриншота' },
    });
    if (!res?.ok) {
      return { ok: false, error: res?.error || (isEn ? 'Local model failed to inspect screenshot' : 'Локальная модель не смогла разобрать скриншот') };
    }
    const rawReply =
      typeof res.data?.message?.content === 'string'
        ? res.data.message.content
        : typeof res.data?.response === 'string'
          ? res.data.response
          : res.data && typeof res.data === 'object'
            ? JSON.stringify(res.data)
            : '';
    const parsed = parseStrictBackgroundJson(rawReply);
    if (parsed && (parsed.analysisRu || parsed.analysisEn || parsed.promptPatchRu || parsed.promptPatchEn)) {
      const analysis = String(parsed.analysisEn || parsed.analysisRu || '').trim().slice(0, 800);
      const defects = Array.isArray(parsed.defectsRu) ? parsed.defectsRu.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 6) : [];
      const patch = String(parsed.promptPatchEn || parsed.promptPatchRu || analysis || '').trim().slice(0, 600);
      return {
        ok: true,
        analysisRu: String(parsed.analysisRu || analysis).trim().slice(0, 800),
        analysisEn: analysis,
        defectsRu: defects,
        promptPatchRu: String(parsed.promptPatchRu || patch).trim().slice(0, 600),
        promptPatchEn: patch,
        model: targetModel,
      };
    }
    const plain = String(rawReply || '').trim();
    if (!plain) return { ok: false, error: isEn ? 'Empty response from multimodal model' : 'Пустой ответ мультимодальной модели' };
    return {
      ok: true,
      analysisRu: plain.slice(0, 800),
      analysisEn: plain.slice(0, 800),
      defectsRu: [],
      promptPatchRu: plain.slice(0, 500),
      promptPatchEn: plain.slice(0, 500),
      model: targetModel,
    };
  } catch (err) {
    return { ok: false, error: err?.message || (isEn ? 'Screenshot inspection error' : 'Ошибка разбора скриншота') };
  }
}

function buildDeterministicCommitFallback({ diffText = '', changedFiles = [], issuesCount = 0, lang = 'ru' } = {}) {
  const files = Array.isArray(changedFiles) ? changedFiles.map((f) => String(f || '').trim()).filter(Boolean) : [];
  const lowerAll = `${files.join(' ')}\n${diffText.slice(0, 2000)}`.toLowerCase();
  const hasOnlyTests = files.length > 0 && files.every((f) => /(?:^|\/)tests?\/|\.test\.|\.spec\./i.test(f));
  const hasOnlyDocs = files.length > 0 && files.every((f) => /\.(?:md|txt|rst)$/i.test(f));
  const kind = issuesCount > 0 || /\b(?:fix|bug|guard|error|rollback|patch)\b/i.test(lowerAll)
    ? 'fix'
    : hasOnlyTests
      ? 'test'
      : hasOnlyDocs
        ? 'docs'
        : 'feat';
  const primaryName = files[0] ? path.basename(files[0]).replace(/\.[a-z0-9]+$/i, '') : 'core';
  const isEnCommit = normalizeLang(lang, 'ru') === 'en';
  const countSuffix = files.length > 1 ? (isEnCommit ? ` and ${files.length - 1} more` : ` и ещё ${files.length - 1} ф.`) : '';
  const commitMessage = isEnCommit
    ? `${kind}(${primaryName}): update ${files[0] ? path.basename(files[0]) : 'modules'}${countSuffix}`
    : `${kind}(${primaryName}): обновить ${files[0] ? path.basename(files[0]) : 'модули'}${countSuffix}`;
  const addLines = (diffText.match(/^\+[^+]/gm) || []).length;
  const delLines = (diffText.match(/^-[^-]/gm) || []).length;
  const summaryEn = `Files: ${files.length || 1} (+${addLines}/-${delLines} lines). ${files.slice(0, 4).join(', ')}`;
  const summaryRu = `Файлов: ${files.length || 1} (+${addLines}/-${delLines} стр.). ${files.slice(0, 4).join(', ')}`;
  return { ok: true, commitMessage, summaryRu, summaryEn, viaGpu: false };
}

/**
 * Генерирует Conventional Commit сообщение и краткую сводку (RU/EN) без расхода облачных токенов
 * (через локальный GPU с детерминированным оффлайн-фолбэком при выключенном GPU).
 * @param {object} [opts={}]
 * @returns {Promise<object>}
 */
export async function generateLocalCommitSummary(opts = {}) {
  const safeOpts = opts && typeof opts === 'object' && !Array.isArray(opts) ? opts : {};
  const lang = normalizeLang(safeOpts.lang, 'ru');
  const isEn = lang === 'en';
  const rawDiff = typeof safeOpts.diffText === 'string' ? safeOpts.diffText.trim() : '';
  const changedFiles = Array.isArray(safeOpts.changedFiles)
    ? safeOpts.changedFiles.map((f) => String(f || '').trim()).filter(Boolean).slice(0, 30)
    : [];
  const issuesCount = Math.max(0, Number(safeOpts.issuesCount || 0) || 0);
  if (!rawDiff && changedFiles.length === 0) {
    return { ok: false, error: isEn ? 'No changed files to generate commit message' : 'Нет изменённых файлов для генерации коммита' };
  }

  const safeDiff = redactSecretsInText(rawDiff.slice(0, 10_000));
  const fallback = buildDeterministicCommitFallback({ diffText: safeDiff, changedFiles, issuesCount, lang });
  const httpJsonFn = typeof safeOpts.httpJsonFn === 'function' ? safeOpts.httpJsonFn : null;
  const cfg = safeOpts.cfgOverride ? loadGpuConfig(safeOpts.cfgOverride) : loadGpuConfig();
  if (!httpJsonFn && !cfg.gpuEnabled) {
    return fallback;
  }

  let targetModel = cfg.gpuChatModel || DEFAULT_GPU_CONFIG.gpuChatModel;
  if (!httpJsonFn) {
    const ready = await ensureOllamaRunning(cfg).catch(() => ({ ok: false }));
    if (!ready?.ok) return fallback;
    const hw = probeNvidiaGpu();
    const psRes = await ollamaHttpJson('GET', '/api/ps', null, 800, cfg.gpuEndpoint).catch(() => null);
    const loadedModels = Array.isArray(psRes?.data?.models) ? psRes.data.models : [];
    const tagSource = await getCachedOrFetchOllamaTagMap(cfg).catch(() => null);
    const fit = evaluateVramModelFit({ cfg: { ...cfg, gpuChatModel: targetModel }, tagModels: tagSource, loadedModels, hw });
    const tagKnown = Array.isArray(tagSource) || (tagSource instanceof Map && tagSource.size > 0);
    if (fit.selectedSizeFits && (!tagKnown || fit.selectedChatDownloaded)) {
      targetModel = fit.selectedChatModel || targetModel;
    } else if (fit.bestFallbackChatModel) {
      targetModel = fit.bestFallbackChatModel;
    } else {
      return fallback;
    }
  }
  const timeoutMs = clampInt(safeOpts.timeoutMs, 1000, 30_000, 12_000);
  const body = {
    model: targetModel,
    stream: false,
    think: false,
    format: 'json',
    keep_alive: cfg.gpuKeepAlive,
    messages: [
      {
        role: 'system',
        content: isEn
          ? 'Generate a concise Conventional Commit message and short English bullet summary from the git diff. Output strict JSON: {"commitMessage":"feat(scope): ...","summaryEn":"...","summaryRu":"..."}'
          : 'Generate a concise Conventional Commit message and short Russian bullet summary from the git diff. Output strict JSON: {"commitMessage":"feat(scope): ...","summaryRu":"...","summaryEn":"..."}',
      },
      {
        role: 'user',
        content: `FILES: ${changedFiles.join(', ') || 'unknown'}\nISSUES_DETECTED: ${issuesCount}\nDIFF:\n${safeDiff}`,
      },
    ],
    options: { temperature: 0.1, num_predict: 220, num_ctx: 4096 },
  };

  try {
    const callHttp = httpJsonFn || ollamaHttpJson;
    const res = await callHttp('POST', '/api/chat', body, timeoutMs, cfg.gpuEndpoint, {
      priority: 'foreground',
      workInfoOverride: { op: 'local_commit', model: targetModel, detail: isEn ? 'Generate commit message' : 'Генерация сообщения коммита' },
    });
    if (!res?.ok) return fallback;
    const rawReply =
      typeof res.data?.message?.content === 'string'
        ? res.data.message.content
        : typeof res.data?.response === 'string'
          ? res.data.response
          : res.data && typeof res.data === 'object'
            ? JSON.stringify(res.data)
            : '';
    const parsed = parseStrictBackgroundJson(rawReply);
    if (parsed && typeof parsed.commitMessage === 'string' && parsed.commitMessage.trim()) {
      return {
        ok: true,
        commitMessage: parsed.commitMessage.trim().slice(0, 160),
        summaryRu: String(parsed.summaryRu || parsed.summaryEn || fallback.summaryRu).trim().slice(0, 400),
        summaryEn: String(parsed.summaryEn || fallback.summaryEn).trim().slice(0, 400),
        viaGpu: true,
        model: targetModel,
      };
    }
    return fallback;
  } catch {
    return fallback;
  }
}

/**
 * Структурирует сбивчивую голосовую диктовку в чёткий технический промпт с оффлайн-очисткой слов-паразитов.
 * @param {object} [opts={}]
 * @returns {Promise<object>}
 */
export async function structureVoiceTranscriptLocally(opts = {}) {
  const safeOpts = opts && typeof opts === 'object' && !Array.isArray(opts) ? opts : {};
  const lang = normalizeLang(safeOpts.lang, 'ru');
  const isEn = lang === 'en';
  const rawText = typeof safeOpts.rawTranscript === 'string' ? safeOpts.rawTranscript : '';
  const cleaned = rawText
    .replace(/\b(?:ээ+|мм+|аа+|ну типа|типа|короче|как бы|в общем|это самое|значит)\b/gi, ' ')
    .replace(/\s+([,.;!?])/g, '$1')
    .replace(/,{2,}/g, ',')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[,.\s]+/, '')
    .trim()
    .slice(0, 2000);
  if (!cleaned) {
    return { ok: false, error: isEn ? 'Empty voice dictation transcript' : 'Пустой текст голосовой диктовки' };
  }
  const capitalized = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  const fallback = { ok: true, structuredPrompt: capitalized, viaGpu: false };

  const httpJsonFn = typeof safeOpts.httpJsonFn === 'function' ? safeOpts.httpJsonFn : null;
  const cfg = safeOpts.cfgOverride ? loadGpuConfig(safeOpts.cfgOverride) : loadGpuConfig();
  if ((!httpJsonFn && !cfg.gpuEnabled) || cleaned.length < 8) {
    return fallback;
  }

  const workspaceFiles = Array.isArray(safeOpts.workspaceFiles)
    ? safeOpts.workspaceFiles.map((f) => String(f || '').trim()).filter(Boolean).slice(0, 20)
    : [];
  let targetModel = cfg.gpuChatModel || DEFAULT_GPU_CONFIG.gpuChatModel;
  if (!httpJsonFn) {
    const ready = await ensureOllamaRunning(cfg).catch(() => ({ ok: false }));
    if (!ready?.ok) return fallback;
    const hw = probeNvidiaGpu();
    const psRes = await ollamaHttpJson('GET', '/api/ps', null, 800, cfg.gpuEndpoint).catch(() => null);
    const loadedModels = Array.isArray(psRes?.data?.models) ? psRes.data.models : [];
    const tagSource = await getCachedOrFetchOllamaTagMap(cfg).catch(() => null);
    const fit = evaluateVramModelFit({ cfg: { ...cfg, gpuChatModel: targetModel }, tagModels: tagSource, loadedModels, hw });
    const tagKnown = Array.isArray(tagSource) || (tagSource instanceof Map && tagSource.size > 0);
    if (fit.selectedSizeFits && (!tagKnown || fit.selectedChatDownloaded)) {
      targetModel = fit.selectedChatModel || targetModel;
    } else if (fit.bestFallbackChatModel) {
      targetModel = fit.bestFallbackChatModel;
    } else {
      return fallback;
    }
  }
  const timeoutMs = clampInt(safeOpts.timeoutMs, 1000, 20_000, 8000);
  const body = {
    model: targetModel,
    stream: false,
    think: false,
    format: 'json',
    keep_alive: cfg.gpuKeepAlive,
    messages: [
      {
        role: 'system',
        content: isEn
          ? 'Convert spoken developer dictation into a clear, concise engineering prompt in English. Preserve or match exact workspace filenames only from WORKSPACE_FILES if clearly referenced. Output JSON: {"structuredPrompt":"..."}'
          : 'Convert spoken developer Russian dictation into a clear, concise engineering prompt. Preserve or match exact workspace filenames only from WORKSPACE_FILES if clearly referenced. Output JSON: {"structuredPrompt":"..."}',
      },
      {
        role: 'user',
        content: `WORKSPACE_FILES: ${workspaceFiles.join(', ') || 'none'}\nDICTATION: ${capitalized}`,
      },
    ],
    options: { temperature: 0.08, num_predict: 200, num_ctx: 4096 },
  };

  try {
    const callHttp = httpJsonFn || ollamaHttpJson;
    const res = await callHttp('POST', '/api/chat', body, timeoutMs, cfg.gpuEndpoint, {
      priority: 'foreground',
      workInfoOverride: { op: 'local_voice', model: targetModel, detail: isEn ? 'Structure voice prompt' : 'Структурирование голоса' },
    });
    if (!res?.ok) return fallback;
    const rawReply =
      typeof res.data?.message?.content === 'string'
        ? res.data.message.content
        : typeof res.data?.response === 'string'
          ? res.data.response
          : res.data && typeof res.data === 'object'
            ? JSON.stringify(res.data)
            : '';
    const parsed = parseStrictBackgroundJson(rawReply);
    if (parsed && typeof parsed.structuredPrompt === 'string' && parsed.structuredPrompt.trim()) {
      return {
        ok: true,
        structuredPrompt: parsed.structuredPrompt.trim().slice(0, 2000),
        viaGpu: true,
        model: targetModel,
      };
    }
    return fallback;
  } catch {
    return fallback;
  }
}

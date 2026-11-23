/**
 * @file circuit-breaker.mjs
 * @description Автомат защиты от зацикливания правок и повторяющихся сбоев (#3 Thrashing Circuit Breaker).
 * Отслеживает осцилляции файлов (A -> B -> A -> B -> A), 3-кратные повторы состояний файлов
 * и каскадные повторяющиеся ошибки терминала/линтера, предотвращая бесконечный расход токенов.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteJsonSync, safeReadJsonSync, updateJsonAtomicSync } from './safe-json.mjs';
import { ensureTunnelCacheDir, pruneObjectMapByTimestamp, resolveTunnelCacheDir } from './cache-dir.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, '..');
const COOLDOWN_MS = 5 * 60 * 1000; // 5 минут авто-восстановления
const BUCKET_TTL_MS = 30 * 60 * 1000; // 30 минут хранения неактивных бакетов
const MAX_BUCKETS = 64;

function getCacheDir() {
  return resolveTunnelCacheDir(PLUGIN_ROOT);
}

function getCircuitFile() {
  return join(getCacheDir(), 'circuit-breaker.json');
}

const DEFAULT_STATE = {
  status: 'CLOSED', // 'CLOSED' | 'WARNING' | 'TRIPPED'
  reason: '',
  trippedAt: null,
  targetFile: null,
  repeatCount: 0,
  updatedAt: null,
  editHashes: [], // [{ hash, filePath, ts }]
  errorFingerprints: [] // [{ fingerprint, source, filePath, preview, ts }]
};

/**
 * Resolves an isolated bucket key per workspace + conversation (or directory fallback).
 */
function resolveBucketKey({ filePath = '', workspaceRoot = '', conversationId = '' } = {}) {
  const wsSource = workspaceRoot
    ? resolve(workspaceRoot)
    : filePath
      ? dirname(resolve(filePath))
      : '';
  const wsPart = wsSource
    ? createHash('sha1').update(process.platform === 'win32' ? wsSource.toLowerCase() : wsSource).digest('hex').slice(0, 10)
    : 'global';
  const convPart = conversationId ? String(conversationId).trim().replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) : '';
  return convPart ? `${wsPart}::${convPart}` : wsPart;
}

/**
 * Обеспечивает существование директории кэша.
 */
function ensureCacheDir() {
  ensureTunnelCacheDir(getCacheDir());
}

/**
 * Создаёт начальное состояние одного бакета автомата защиты.
 * @returns {typeof DEFAULT_STATE}
 */
function createInitialState() {
  return {
    ...DEFAULT_STATE,
    editHashes: [],
    errorFingerprints: []
  };
}

function createInitialStore() {
  return {
    version: 2,
    buckets: {},
  };
}

function normalizeStore(raw) {
  if (!raw || typeof raw !== 'object') return createInitialStore();
  if (raw.buckets && typeof raw.buckets === 'object' && !Array.isArray(raw.buckets)) {
    const now = Date.now();
    const sanitizedMap = {};
    for (const [k, b] of Object.entries(raw.buckets)) {
      sanitizedMap[k] = sanitizeState(b);
    }
    const cleaned = pruneObjectMapByTimestamp(sanitizedMap, {
      maxEntries: MAX_BUCKETS,
      maxAgeMs: BUCKET_TTL_MS,
      now,
      getTs: (b) => {
        if (b?.updatedAt) {
          const parsed = Date.parse(b.updatedAt);
          if (Number.isFinite(parsed) && parsed > 0) return parsed;
        }
        return 0;
      },
      keepPredicate: (_k, b) => Boolean(b?.status && b.status !== 'CLOSED'),
    });
    return { version: 2, buckets: cleaned };
  }
  // Legacy single-bucket migration
  return {
    version: 2,
    buckets: {
      global: sanitizeState(raw),
    },
  };
}

let _cachedCircuitStore = { filePath: '', mtimeMs: -1, size: -1, checkedAt: 0, store: null };

/**
 * Сохраняет состояние автомата защиты в файл.
 * @param {typeof DEFAULT_STATE} state
 */
function saveState(state) {
  ensureCacheDir();
  atomicWriteJsonSync(getCircuitFile(), state, { spaces: 0 });
  _cachedCircuitStore.checkedAt = 0;
  _cachedCircuitStore.mtimeMs = -1;
}

/**
 * Валидирует и нормализует состояние автомата, проверяя кулдаун.
 * @param {any} raw
 * @returns {typeof DEFAULT_STATE}
 */
function sanitizeState(raw) {
  const state = {
    ...DEFAULT_STATE,
    ...(raw && typeof raw === 'object' ? raw : {}),
    editHashes: Array.isArray(raw?.editHashes) ? raw.editHashes : [],
    errorFingerprints: Array.isArray(raw?.errorFingerprints) ? raw.errorFingerprints : []
  };

  // Авто-восстановление (Auto-Cooldown & Self-Heal):
  // Если status === 'TRIPPED' или 'WARNING' и прошло более 5 минут — сбрасываем статус в 'CLOSED'
  if (state.status === 'TRIPPED' || state.status === 'WARNING') {
    let latestTs = 0;
    if (state.trippedAt) {
      const t = new Date(state.trippedAt).getTime();
      if (!isNaN(t)) latestTs = t;
    }
    for (const h of state.editHashes) {
      if (h?.ts) {
        const t = new Date(h.ts).getTime();
        if (!isNaN(t) && t > latestTs) latestTs = t;
      }
    }
    for (const ef of state.errorFingerprints) {
      if (ef?.ts) {
        const t = new Date(ef.ts).getTime();
        if (!isNaN(t) && t > latestTs) latestTs = t;
      }
    }

    const now = Date.now();
    if (latestTs > 0 && now - latestTs > COOLDOWN_MS) {
      state.status = 'CLOSED';
      state.reason = '';
      state.trippedAt = null;
      state.targetFile = null;
      state.repeatCount = 0;
    }
  }

  return state;
}

/**
 * Загружает текущее состояние автомата защиты в pure read-only режиме (без записи на диск).
 * @returns {typeof DEFAULT_STATE}
 */
function invalidateCircuitStoreCache() {
  _cachedCircuitStore = { filePath: '', mtimeMs: 0, size: -1, checkedAt: 0, store: null };
}

function loadStore() {
  const circuitFile = getCircuitFile();
  const now = Date.now();
  if (_cachedCircuitStore.store && _cachedCircuitStore.filePath === circuitFile && now - _cachedCircuitStore.checkedAt <= 250) {
    return _cachedCircuitStore.store;
  }
  let st = null;
  try {
    st = statSync(circuitFile);
  } catch {
    const empty = createInitialStore();
    _cachedCircuitStore = { filePath: circuitFile, mtimeMs: 0, size: 0, checkedAt: now, store: empty };
    return empty;
  }
  if (
    _cachedCircuitStore.store &&
    _cachedCircuitStore.filePath === circuitFile &&
    st.mtimeMs === _cachedCircuitStore.mtimeMs &&
    st.size === _cachedCircuitStore.size
  ) {
    _cachedCircuitStore.checkedAt = now;
    return _cachedCircuitStore.store;
  }
  const raw = safeReadJsonSync(circuitFile, createInitialStore, { selfHeal: false });
  const store = normalizeStore(raw);
  _cachedCircuitStore = { filePath: circuitFile, mtimeMs: st.mtimeMs, size: st.size, checkedAt: now, store };
  return store;
}

function loadState(scope = {}) {
  const store = loadStore();
  const rawWs = (scope && typeof scope.workspaceRoot === 'string') ? scope.workspaceRoot.trim() : '';
  const effectiveWs = rawWs === '__all__' ? '' : rawWs;
  const hasConv = Boolean(scope && scope.conversationId);
  const hasFile = Boolean(scope && scope.filePath);

  if (effectiveWs && !hasConv && !hasFile) {
    const wsPrefix = resolveBucketKey({ workspaceRoot: effectiveWs });
    const matching = Object.entries(store.buckets)
      .filter(([k]) => k === wsPrefix || k.startsWith(`${wsPrefix}::`))
      .map(([, v]) => v);
    const tripped = matching.find((b) => b.status === 'TRIPPED');
    if (tripped) return tripped;
    const warning = matching.find((b) => b.status === 'WARNING');
    if (warning) return warning;
    return matching[0] || createInitialState();
  }

  if (effectiveWs || hasConv || hasFile) {
    const key = resolveBucketKey({ ...scope, workspaceRoot: effectiveWs });
    return store.buckets[key] || createInitialState();
  }
  const list = Object.values(store.buckets);
  const tripped = list.find((b) => b.status === 'TRIPPED');
  if (tripped) return tripped;
  const warning = list.find((b) => b.status === 'WARNING');
  if (warning) return warning;
  return createInitialState();
}

/**
 * Нормализует текст ошибки для устойчивого вычисления отпечатка.
 * Удаляет ANSI-коды, даты, миллисекунды, шестнадцатеричные адреса и лишние пробелы.
 * @param {string} rawText
 * @returns {string}
 */
function normalizeError(rawText = '') {
  if (typeof rawText !== 'string') {
    rawText = String(rawText || '');
  }
  return rawText
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\d{4}[-/.]\d{1,2}[-/.]\d{1,2}[T\s]?\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?/gi, '')
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?\b/g, '')
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|s|m|min|seconds?|millis?)\b/gi, '')
    .replace(/0x[0-9a-fA-F]+/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Регистрирует хеш содержимого файла перед записью и проверяет зацикливание правок атомарно под файловым замком.
 * @param {object} params
 * @param {string} params.filePath Путь к файлу
 * @param {string} [params.content=''] Моделируемое или записываемое содержимое
 * @returns {{ tripped: boolean, status: string, repeatCount: number, reason: string }}
 */
export function recordEditStateHash(opts = {}) {
  const { filePath, content = '', workspaceRoot = '', conversationId = '' } = (opts && typeof opts === 'object') ? opts : {};
  if (!filePath) {
    return { tripped: false, status: 'CLOSED', repeatCount: 0, reason: '' };
  }

  const absPath = resolve(filePath);
  const normTarget = process.platform === 'win32' ? absPath.toLowerCase() : absPath;
  const bucketKey = resolveBucketKey({ filePath: absPath, workspaceRoot, conversationId });
  const hash = createHash('sha1')
    .update(`${normTarget}::${content}`)
    .digest('hex');

  ensureCacheDir();

  let count = 0;
  let bucketSnapshot = createInitialState();
  updateJsonAtomicSync(getCircuitFile(), createInitialStore, (rawStore) => {
    const store = normalizeStore(rawStore);
    const state = sanitizeState(store.buckets[bucketKey]);
    const now = new Date().toISOString();
    state.updatedAt = now;

    state.editHashes.push({
      hash,
      filePath: absPath,
      ts: now
    });

    if (state.editHashes.length > 24) {
      state.editHashes = state.editHashes.slice(-24);
    }

    const fileEdits = state.editHashes
      .filter((e) => {
        const ep = resolve(e.filePath);
        return (process.platform === 'win32' ? ep.toLowerCase() : ep) === normTarget;
      })
      .slice(-8);

    count = fileEdits.filter((e) => e.hash === hash).length;

    if (count >= 3) {
      state.status = 'TRIPPED';
      state.repeatCount = count;
      state.reason = `Edit loop detected (3x identical state in ${basename(absPath)})`;
      state.trippedAt = now;
      state.targetFile = absPath;
    } else if (count === 2 && state.status !== 'TRIPPED') {
      state.status = 'WARNING';
      state.repeatCount = 2;
      state.reason = `Warning: repeated file state (2x) in ${basename(absPath)}`;
      state.targetFile = absPath;
    }

    store.buckets[bucketKey] = state;
    bucketSnapshot = state;
    return normalizeStore(store);
  }, { spaces: 0 });
  invalidateCircuitStoreCache();

  const trippedThisFile =
    count >= 3 ||
    (bucketSnapshot.status === 'TRIPPED' &&
      Boolean(bucketSnapshot.targetFile) &&
      (process.platform === 'win32'
        ? resolve(bucketSnapshot.targetFile).toLowerCase() === normTarget
        : resolve(bucketSnapshot.targetFile) === normTarget));

  return {
    tripped: trippedThisFile,
    status: trippedThisFile ? 'TRIPPED' : count === 2 ? 'WARNING' : 'CLOSED',
    repeatCount: count,
    reason: trippedThisFile || count === 2 ? bucketSnapshot.reason : ''
  };
}

/**
 * Регистрирует отпечаток ошибки выполнения команды или синтаксической проверки атомарно под файловым замком.
 * @param {object} params
 * @param {string} [params.source='cmd'] Источник ошибки ('cmd', 'terminal', 'syntax', 'run_command')
 * @param {string} [params.errorText=''] Сырой текст ошибки
 * @param {string} [params.filePath=''] Целевой файл (если применимо)
 * @param {string} [params.workspaceRoot=''] Корень воркспейса
 * @param {string} [params.conversationId=''] ID диалога
 * @returns {{ tripped: boolean, status: string, repeatCount: number, reason: string }}
 */
export function recordErrorFingerprint(opts = {}) {
  const { source = 'cmd', errorText = '', filePath = '', workspaceRoot = '', conversationId = '' } = (opts && typeof opts === 'object') ? opts : {};
  const normalized = normalizeError(errorText);
  if (!normalized) {
    return { tripped: false, status: 'CLOSED', repeatCount: 0, reason: '' };
  }

  const cleanPreview = normalized.slice(0, 200);
  const fingerprint = createHash('sha1').update(normalized).digest('hex');
  const bucketKey = resolveBucketKey({ filePath, workspaceRoot, conversationId });

  ensureCacheDir();

  let bucketSnapshot = createInitialState();
  updateJsonAtomicSync(getCircuitFile(), createInitialStore, (rawStore) => {
    const store = normalizeStore(rawStore);
    const state = sanitizeState(store.buckets[bucketKey]);
    const now = new Date().toISOString();
    state.updatedAt = now;

    state.errorFingerprints.push({
      fingerprint,
      source,
      filePath: filePath ? resolve(filePath) : '',
      preview: cleanPreview,
      ts: now
    });

    if (state.errorFingerprints.length > 10) {
      state.errorFingerprints = state.errorFingerprints.slice(-10);
    }

    const recent5 = state.errorFingerprints.slice(-5);
    const countInLast5 = recent5.filter((e) => e.fingerprint === fingerprint).length;

    const last3 = state.errorFingerprints.slice(-3);
    const consecutive3 = last3.length === 3 && last3.every((e) => e.fingerprint === fingerprint);

    const last2 = state.errorFingerprints.slice(-2);
    const consecutive2 = last2.length === 2 && last2.every((e) => e.fingerprint === fingerprint);

    if (consecutive3 || countInLast5 >= 3) {
      state.status = 'TRIPPED';
      state.repeatCount = Math.max(3, countInLast5);
      state.reason = `Repeated error 3x (${source}): ${cleanPreview}`;
      state.trippedAt = now;
      state.targetFile = filePath ? resolve(filePath) : state.targetFile;
    } else if ((consecutive2 || countInLast5 === 2) && state.status !== 'TRIPPED') {
      state.status = 'WARNING';
      state.repeatCount = 2;
      state.reason = `Warning: repeated error 2x (${source}): ${cleanPreview}`;
      if (filePath) state.targetFile = resolve(filePath);
    }

    store.buckets[bucketKey] = state;
    bucketSnapshot = state;
    return normalizeStore(store);
  }, { spaces: 0 });
  invalidateCircuitStoreCache();

  return {
    tripped: bucketSnapshot.status === 'TRIPPED',
    status: bucketSnapshot.status,
    repeatCount: bucketSnapshot.repeatCount,
    reason: bucketSnapshot.reason
  };
}

/**
 * Возвращает текущее состояние автомата защиты.
 * @returns {{ status: string, reason: string, trippedAt: string|null, targetFile: string|null, repeatCount: number }}
 */
export function getCircuitState(scope = {}) {
  const state = loadState(scope);
  return {
    status: state.status,
    reason: state.reason,
    trippedAt: state.trippedAt,
    targetFile: state.targetFile,
    repeatCount: state.repeatCount
  };
}

/**
 * Регистрирует чистый успех модификации файла атомарно: очищает накопленные WARNING и старые
 * отпечатки ошибок по указанному файлу, возвращая автомат в зелёную зону.
 * @param {string|object} [filePathOrOpts=''] Путь к успешному файлу или объект опций
 * @returns {typeof DEFAULT_STATE}
 */
export function recordCleanSuccess(filePathOrOpts = '') {
  const opts = typeof filePathOrOpts === 'string'
    ? { filePath: filePathOrOpts }
    : (filePathOrOpts && typeof filePathOrOpts === 'object' ? filePathOrOpts : {});
  const filePath = opts.filePath || '';
  const workspaceRoot = opts.workspaceRoot || '';
  const conversationId = opts.conversationId || '';
  ensureCacheDir();
  const normTarget = filePath ? (process.platform === 'win32' ? resolve(filePath).toLowerCase() : resolve(filePath)) : '';
  const bucketKey = resolveBucketKey({ filePath, workspaceRoot, conversationId });

  let bucketSnapshot = createInitialState();
  updateJsonAtomicSync(getCircuitFile(), createInitialStore, (rawStore) => {
    const store = normalizeStore(rawStore);
    const state = sanitizeState(store.buckets[bucketKey]);
    state.updatedAt = new Date().toISOString();

    // Очищаем старые отпечатки ошибок и хеши повторов по данному файлу
    if (normTarget && state.errorFingerprints.length > 0) {
      state.errorFingerprints = state.errorFingerprints.filter(
        (ef) => !ef.filePath || (process.platform === 'win32' ? resolve(ef.filePath).toLowerCase() : resolve(ef.filePath)) !== normTarget
      );
    }
    if (normTarget && state.editHashes.length > 0) {
      state.editHashes = state.editHashes.filter(
        (eh) => !eh.filePath || (process.platform === 'win32' ? resolve(eh.filePath).toLowerCase() : resolve(eh.filePath)) !== normTarget
      );
    }

    // Если был статус WARNING или TRIPPED по этому файлу (или общий), сбрасываем в CLOSED
    if (state.status === 'WARNING' || state.status === 'TRIPPED') {
      const targetNorm = state.targetFile
        ? (process.platform === 'win32' ? resolve(state.targetFile).toLowerCase() : resolve(state.targetFile))
        : '';
      if (!targetNorm || !normTarget || targetNorm === normTarget) {
        state.status = 'CLOSED';
        state.reason = '';
        state.repeatCount = 0;
        state.targetFile = null;
        state.trippedAt = null;
      }
    }

    store.buckets[bucketKey] = state;
    bucketSnapshot = state;
    return normalizeStore(store);
  }, { spaces: 0 });
  invalidateCircuitStoreCache();
  return bucketSnapshot;
}

/**
 * Сбрасывает автомат защиты в исходное состояние CLOSED.
 * @returns {{ status: string, reason: string, trippedAt: null, targetFile: null, repeatCount: number }}
 */
export function resetCircuitBreaker(scope = null) {
  ensureCacheDir();
  const circuitFile = getCircuitFile();
  const rawWs = (scope && typeof scope === 'object' && typeof scope.workspaceRoot === 'string') ? scope.workspaceRoot.trim() : '';
  const effectiveWs = rawWs === '__all__' ? '' : rawWs;
  const hasConv = Boolean(scope && typeof scope === 'object' && scope.conversationId);
  if (effectiveWs && !hasConv) {
    const wsPrefix = resolveBucketKey({ workspaceRoot: effectiveWs });
    updateJsonAtomicSync(circuitFile, createInitialStore, (rawStore) => {
      const store = normalizeStore(rawStore);
      for (const k of Object.keys(store.buckets)) {
        if (k === wsPrefix || k.startsWith(`${wsPrefix}::`)) {
          delete store.buckets[k];
        }
      }
      store.buckets[wsPrefix] = { ...createInitialState(), updatedAt: new Date().toISOString() };
      return store;
    }, { spaces: 0 });
  } else if (effectiveWs || hasConv) {
    const key = resolveBucketKey({ ...(scope || {}), workspaceRoot: effectiveWs });
    updateJsonAtomicSync(circuitFile, createInitialStore, (rawStore) => {
      const store = normalizeStore(rawStore);
      store.buckets[key] = { ...createInitialState(), updatedAt: new Date().toISOString() };
      return store;
    }, { spaces: 0 });
  } else {
    updateJsonAtomicSync(circuitFile, createInitialStore, () => createInitialStore(), { spaces: 0 });
  }
  invalidateCircuitStoreCache();
  const fresh = createInitialState();
  return {
    status: fresh.status,
    reason: fresh.reason,
    trippedAt: fresh.trippedAt,
    targetFile: fresh.targetFile,
    repeatCount: fresh.repeatCount
  };
}

/**
 * FailFast-RestartSmart detector: flags semantic oscillation even when file SHA-1 changes on each edit,
 * whenever >=3 edits on the same targetFile occur alongside >=2 error fingerprints within 10 minutes.
 * @param {object} [bucketOrOpts={}]
 * @returns {{ oscillating: boolean, targetFile: string, editAttempts: number, errorCount: number, activeFault: string, ruledOutHashes: string[] }}
 */
export function detectSemanticOscillation(bucketOrOpts = {}) {
  if (!bucketOrOpts || typeof bucketOrOpts !== 'object' || Array.isArray(bucketOrOpts)) {
    return {
      oscillating: false,
      targetFile: '',
      editAttempts: 0,
      errorCount: 0,
      activeFault: '',
      ruledOutHashes: [],
    };
  }
  const isBucket = Array.isArray(bucketOrOpts.editHashes) || Array.isArray(bucketOrOpts.errorFingerprints);
  const hasScopeKey = Boolean(
    bucketOrOpts.workspaceRoot || bucketOrOpts.conversationId || bucketOrOpts.filePath
  );
  if (!isBucket && !hasScopeKey && Object.keys(bucketOrOpts).length > 0) {
    return {
      oscillating: false,
      targetFile: '',
      editAttempts: 0,
      errorCount: 0,
      activeFault: '',
      ruledOutHashes: [],
    };
  }
  const state = isBucket ? sanitizeState(bucketOrOpts) : loadState(bucketOrOpts);
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;

  const recentEdits = (state.editHashes || []).filter((e) => {
    const ts = e?.ts ? new Date(e.ts).getTime() : 0;
    return !ts || (now - ts <= windowMs);
  });
  const recentErrors = (state.errorFingerprints || []).filter((e) => {
    const ts = e?.ts ? new Date(e.ts).getTime() : 0;
    return !ts || (now - ts <= windowMs);
  });

  const countsByFile = new Map();
  for (const e of recentEdits) {
    if (!e?.filePath) continue;
    const norm = process.platform === 'win32' ? resolve(e.filePath).toLowerCase() : resolve(e.filePath);
    if (!countsByFile.has(norm)) countsByFile.set(norm, { raw: e.filePath, edits: [], hashes: new Set() });
    const rec = countsByFile.get(norm);
    rec.edits.push(e);
    if (e.hash) rec.hashes.add(String(e.hash).slice(0, 8));
  }

  let worst = null;
  for (const [, rec] of countsByFile.entries()) {
    if (rec.edits.length >= 3 && (!worst || rec.edits.length > worst.edits.length)) {
      worst = rec;
    }
  }

  const oscillating = Boolean(worst && recentErrors.length >= 2);
  const latestErr = recentErrors.length > 0 ? recentErrors[recentErrors.length - 1] : null;
  return {
    oscillating,
    targetFile: worst?.raw || state.targetFile || '',
    editAttempts: worst?.edits?.length || 0,
    errorCount: recentErrors.length,
    activeFault: latestErr?.preview || state.reason || '',
    ruledOutHashes: worst ? Array.from(worst.hashes).slice(-4) : [],
  };
}

/**
 * Formats a compact 5-line Elephant-Goldfish Clean State Overlay when semantic oscillation is detected.
 * @param {object} [bucketOrOpts={}]
 * @returns {string}
 */
export function buildCleanRestartOverlay(bucketOrOpts = {}) {
  const osc = detectSemanticOscillation(bucketOrOpts);
  if (!osc.oscillating) return '';
  const fileLabel = osc.targetFile ? basename(osc.targetFile) : 'target';
  const hashes = osc.ruledOutHashes.length > 0 ? osc.ruledOutHashes.join(', ') : 'none';
  return [
    `🛟 [Clean State Overlay (Elephant-Goldfish)]`,
    `- Target: ${fileLabel} (${osc.editAttempts} edit attempts / ${osc.errorCount} faults in 10m)`,
    `- Active Fault: ${osc.activeFault || 'Repeated verification failure'}`,
    `- Ruled-Out States: ${hashes}`,
    `- Action: Stop retrying local tweaks; inspect callers/contracts or bisect minimal failing input via ddmin.`,
  ].join('\n');
}

// --- OmniRoute Stalled Tool-Loop Guard (`agenticLoopGuard` pattern) ---
// Catches silent non-error loops where identical (tool, canonicalArgs) -> result pairs repeat across consecutive rounds.

function canonicalizeStableValue(val) {
  if (Array.isArray(val)) return `[${val.map(canonicalizeStableValue).join(',')}]`;
  if (val && typeof val === 'object') {
    const keys = Object.keys(val).filter((k) => k !== 'toolSummary' && k !== 'WaitMsBeforeAsync').sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalizeStableValue(val[k])}`).join(',')}}`;
  }
  return JSON.stringify(val) ?? 'null';
}

function getToolLoopFile(customCacheDir = '') {
  const dir = customCacheDir ? resolve(customCacheDir) : ensureTunnelCacheDir(getCacheDir());
  return join(dir, 'stalled-tool-loops.json');
}

export function resetToolRoundHistory(opts = {}) {
  const { conversationId = 'default', cacheDir = '' } = opts && typeof opts === 'object' ? opts : {};
  const convoKey = String(conversationId || 'default').trim().slice(0, 120) || 'default';
  const filePath = getToolLoopFile(cacheDir);
  try {
    updateJsonAtomicSync(filePath, () => ({ convos: {} }), (doc) => {
      const convos = doc?.convos && typeof doc.convos === 'object' ? { ...doc.convos } : {};
      delete convos[convoKey];
      return { convos };
    }, { spaces: 0 });
  } catch {}
  return { ok: true };
}

/**
 * Records a completed tool invocation and checks if two consecutive rounds produced identical call->result evidence
 * or consecutive round errors (OmniRoute `stalledToolLoopReason`).
 */
export function recordAndCheckStalledToolRound(opts = {}) {
  const {
    conversationId = 'default',
    toolName = '',
    args = {},
    resultText = '',
    isError = false,
    cacheDir = '',
    nowMs = Date.now(),
    lang = 'ru',
  } = opts && typeof opts === 'object' ? opts : {};
  const isEn = String(lang || '').trim().toLowerCase() === 'en';
  const cleanTool = String(toolName || '').trim();
  if (!cleanTool) {
    return { stalled: false, reason: '', formattedAlert: '' };
  }
  const convoKey = String(conversationId || 'default').trim().slice(0, 120) || 'default';
  const callSig = createHash('sha1')
    .update(`${cleanTool}|${canonicalizeStableValue(args)}`)
    .digest('hex')
    .slice(0, 16);
  const resHash = createHash('sha1')
    .update(String(resultText || '').slice(0, 16384))
    .digest('hex')
    .slice(0, 16);

  const filePath = getToolLoopFile(cacheDir);
  let stalled = false;
  let reason = '';
  let repeatRounds = 1;

  try {
    updateJsonAtomicSync(filePath, () => ({ convos: {} }), (doc) => {
      const rawConvos = doc?.convos && typeof doc.convos === 'object' ? doc.convos : {};
      const convos = pruneObjectMapByTimestamp(rawConvos, {
        maxEntries: 40,
        maxAgeMs: 30 * 60 * 1000,
        nowMs,
        getTs: (v) => Number(v?.updatedAt || 0),
      });
      const prevEntry = Object.hasOwn(convos, convoKey) ? convos[convoKey] : { history: [], updatedAt: nowMs };
      const history = Array.isArray(prevEntry.history) ? [...prevEntry.history].slice(-7) : [];
      const last = history.length > 0 ? history[history.length - 1] : null;
      const current = { tool: cleanTool, callSig, resHash, isError: Boolean(isError), ts: nowMs };

      if (last && last.callSig === current.callSig && last.resHash === current.resHash) {
        stalled = true;
        repeatRounds = Number(last.streak || 1) + 1;
        current.streak = repeatRounds;
        reason = 'identical_tool_evidence_consecutive_rounds';
      } else if (last && last.isError && current.isError && last.tool === current.tool && last.callSig === current.callSig) {
        stalled = true;
        repeatRounds = Number(last.streak || 1) + 1;
        current.streak = repeatRounds;
        reason = 'consecutive_identical_tool_failures';
      } else {
        current.streak = 1;
      }

      history.push(current);
      convos[convoKey] = { history, updatedAt: nowMs };
      return { convos };
    }, { spaces: 0 });
  } catch {}

  let formattedAlert = '';
  if (stalled) {
    if (reason === 'consecutive_identical_tool_failures') {
      formattedAlert = isEn
        ? `🛑 [Stalled Tool-Loop Guard] Calling \`${cleanTool}\` with identical arguments failed ${repeatRounds} times in a row (${reason}). Do not repeat the same failing call — fix the inputs or switch approach.`
        : `🛑 [Stalled Tool-Loop Guard] Вызов \`${cleanTool}\` с теми же аргументами упал с ошибкой ${repeatRounds} раза подряд (${reason}). Не повторяй тот же падающий вызов — исправь входные данные или смени подход.`;
    } else {
      formattedAlert = isEn
        ? `🛑 [Stalled Tool-Loop Guard] Calling \`${cleanTool}\` with identical arguments returned the same result ${repeatRounds} times in a row (${reason}). Do not repeat the same call — change approach or read a different slice.`
        : `🛑 [Stalled Tool-Loop Guard] Вызов \`${cleanTool}\` с теми же аргументами вернул идентичный результат ${repeatRounds} раза подряд (${reason}). Не повторяй тот же вызов — смени подход или прочитай другой срез.`;
    }
  }

  return {
    stalled,
    reason,
    repeatRounds,
    formattedAlert,
  };
}

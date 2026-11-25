/**
 * @file bayesian-router.mjs
 * @description Модуль адаптивной байесовской маршрутизации (Bayesian Confidence Router / RLM-Cascade, Модуль #4).
 * Отслеживает апостериорную надёжность моделей по доменам и директориям через распределение Beta(alpha, beta).
 * Автоматически эскалирует пограничные задачи на модель Pro при падении доверия ниже 68%.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteJsonSync, safeReadJsonSync, updateJsonAtomicSync } from './safe-json.mjs';
import { normalizeLang, pickLang } from './i18n.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, '..');
const CACHE_DIR = join(PLUGIN_ROOT, '.cache');
const PRIORS_FILE = join(CACHE_DIR, 'domain-priors.json');
const TIME_DECAY_MS = 12 * 60 * 60 * 1000; // 12 часов: минимальный шаг до старта непрерывного экспоненциального распада
const HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000; // 14-дневный период полураспада апостериорных весов Beta
const MAX_FRAGILITY_FILES = 200; // Максимум отслеживаемых файлов хрупкости

// Человекочитаемые подписи доменов для UI панели Диспетчера моделей
const DOMAIN_LABELS = {
  algo_refactor: 'Алгоритмы и рефакторинг',
  ui_browser: 'UI и веб-интерфейс',
  backend_db: 'Бэкенд и базы данных',
  security: 'Безопасность и аудит',
  docs: 'Документация и переводы',
  devops: 'DevOps и окружение',
  general: 'Общие задачи',
};

const DOMAIN_LABELS_EN = {
  algo_refactor: 'Algorithms & Refactoring',
  ui_browser: 'UI & Frontend',
  backend_db: 'Backend & Databases',
  security: 'Security & Audit',
  docs: 'Documentation & Localization',
  devops: 'DevOps & Environment',
  general: 'General Tasks',
};

// Базовый набор доменов
const DOMAIN_KEYS = ['algo_refactor', 'ui_browser', 'backend_db', 'security', 'docs', 'devops', 'general'];

// Базовые директории верхнего уровня
const DIR_KEYS = ['dir:core', 'dir:sidecars', 'dir:skills', 'dir:root'];

const SIGNAL_WEIGHTS = {
  syntax: { success: 0.65, failure: 0.75 },
  micro_test: { success: 1.0, failure: 1.1 },
  test: { success: 1.0, failure: 1.1 },
  contract_break: { success: 0.5, failure: 1.3 },
  rollback: { success: 0.5, failure: 1.6 },
  circuit_breaker: { success: 0.5, failure: 1.6 },
};

/**
 * Создаёт начальные параметры онлайн-контекстной байесовской логистической регрессии (Diagonal Laplace / EKF).
 * Признаки: [bias=1, isLXL, normDependents, normFragility, isHighRiskDomain, normRetries]
 * @returns {{ weights: number[], variances: number[], updates: number }}
 */
function createDefaultContextualModel() {
  return {
    weights: [1.386, -0.35, -0.25, -0.45, -0.25, -0.5],
    variances: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5],
    updates: 0,
  };
}

function normalizeModelTierBucket(rawTier = '') {
  const s = String(rawTier || '').trim().toLowerCase();
  if (!s) return 'light';
  if (/^heavy$|carbon|opus|ultra_arch/.test(s)) return 'heavy';
  if (/^mid$|neon|pro|sonnet|gpt-oss/.test(s)) return 'mid';
  return 'light';
}

function normalizeGradeBucket(grade = 'M') {
  const g = String(grade || 'M').trim().toUpperCase();
  return g === 'L' || g === 'XL' ? 'LXL' : 'SM';
}

function resolveSignalWeight(signalType = '', explicitWeight, success = true) {
  if (typeof explicitWeight === 'number' && Number.isFinite(explicitWeight) && explicitWeight > 0) {
    return explicitWeight;
  }
  const st = String(signalType || '').trim().toLowerCase();
  if (st && Object.hasOwn(SIGNAL_WEIGHTS, st)) {
    return success ? SIGNAL_WEIGHTS[st].success : SIGNAL_WEIGHTS[st].failure;
  }
  return 1;
}

function sigmoid(z) {
  const clamped = Math.max(-20, Math.min(20, Number(z) || 0));
  return 1 / (1 + Math.exp(-clamped));
}

function buildContextualFeatures({
  domainKey = 'general',
  grade = 'M',
  dependentsCount = 0,
  fragilityScore = 0,
  retries = 0,
} = {}) {
  const isLXL = normalizeGradeBucket(grade) === 'LXL' ? 1 : 0;
  const normDeps = Math.min(1, Math.max(0, Number(dependentsCount) || 0) / 8);
  const normFrag = Math.min(1, Math.max(0, Number(fragilityScore) || 0) / 100);
  const isHighRisk = domainKey === 'security' || domainKey === 'backend_db' ? 1 : 0;
  const normRetries = Math.min(1, Math.max(0, Number(retries) || 0) / 3);
  return [1, isLXL, normDeps, normFrag, isHighRisk, normRetries];
}

function sanitizeContextualModel(raw) {
  const def = createDefaultContextualModel();
  if (!raw || typeof raw !== 'object') return def;
  const weights = Array.isArray(raw.weights) && raw.weights.length === 6
    ? raw.weights.map((v, idx) => (Number.isFinite(Number(v)) ? Number(v) : def.weights[idx]))
    : def.weights;
  const variances = Array.isArray(raw.variances) && raw.variances.length === 6
    ? raw.variances.map((v, idx) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : def.variances[idx]))
    : def.variances;
  const updates = Math.max(0, Math.floor(Number(raw.updates) || 0));
  return { weights, variances, updates };
}

function predictContextualSuccess(ctxModel, features) {
  const safe = sanitizeContextualModel(ctxModel);
  let meanLogit = 0;
  let logitVar = 0;
  for (let i = 0; i < features.length; i++) {
    meanLogit += safe.weights[i] * features[i];
    logitVar += safe.variances[i] * features[i] * features[i];
  }
  const mean = sigmoid(meanLogit);
  // Probit / Mackay Bayesian logistic integral approximation
  const kappa = 1 / Math.sqrt(1 + (Math.PI / 8) * Math.max(0, logitVar));
  const calibrated = sigmoid(meanLogit * kappa);
  const epistemicStd = Math.sqrt(Math.max(0, logitVar));
  return {
    mean: Number(mean.toFixed(4)),
    calibrated: Number(calibrated.toFixed(4)),
    epistemicStd: Number(epistemicStd.toFixed(4)),
  };
}

function updateContextualModelInPlace(state, features, success, weight = 1) {
  const safe = sanitizeContextualModel(state.contextualModel);
  const y = success ? 1 : 0;
  const effW = Math.max(0.1, Math.min(2.5, Number(weight) || 1));
  let logit = 0;
  for (let i = 0; i < features.length; i++) {
    logit += safe.weights[i] * features[i];
  }
  const p = sigmoid(logit);
  const hess = Math.max(1e-4, p * (1 - p));
  const gradErr = y - p;
  const forget = 0.985;

  for (let i = 0; i < features.length; i++) {
    const x = features[i];
    const priorVar = Math.min(1.0, Math.max(0.02, safe.variances[i] / forget));
    const newPrec = (1 / priorVar) + effW * hess * x * x;
    const newVar = Math.min(1.0, Math.max(0.02, 1 / newPrec));
    const newW = safe.weights[i] + newVar * effW * gradErr * x;
    safe.weights[i] = Number(Math.max(-4, Math.min(4, newW)).toFixed(5));
    safe.variances[i] = Number(newVar.toFixed(5));
  }
  safe.updates += 1;
  state.contextualModel = safe;
}

function computeBetaStd(alpha, beta) {
  const a = Math.max(0.01, Number(alpha) || 4);
  const b = Math.max(0.01, Number(beta) || 1);
  const s = a + b;
  return Math.sqrt((a * b) / (s * s * (s + 1)));
}

function sampleStandardNormal(rng = Math.random) {
  let u1 = 0;
  let u2 = 0;
  while (u1 <= 1e-12) u1 = rng();
  u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function sampleGamma(shape, rng = Math.random) {
  const k = Number(shape);
  if (!Number.isFinite(k) || k <= 0) return 1;
  if (k < 1) {
    const u = Math.max(1e-12, rng());
    return sampleGamma(k + 1, rng) * Math.pow(u, 1 / k);
  }
  const d = k - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (let iter = 0; iter < 64; iter++) {
    let x = sampleStandardNormal(rng);
    let v = 1 + c * x;
    while (v <= 0) {
      x = sampleStandardNormal(rng);
      v = 1 + c * x;
    }
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(Math.max(1e-12, u)) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
  return k;
}

/**
 * Семплирует апостериорную вероятность успеха из Beta(alpha, beta) для Thompson Sampling.
 * @param {number} alpha
 * @param {number} beta
 * @param {() => number} [rng=Math.random]
 * @returns {number}
 */
export function sampleThompsonConfidence(alpha = 4, beta = 1, rng = Math.random) {
  const gA = sampleGamma(Math.max(0.05, Number(alpha) || 4), rng);
  const gB = sampleGamma(Math.max(0.05, Number(beta) || 1), rng);
  const denom = gA + gB;
  if (!Number.isFinite(denom) || denom <= 0) return 0.8;
  return Number(Math.max(0, Math.min(1, gA / denom)).toFixed(4));
}

/**
 * Обеспечивает наличие директории кэша.
 */
function ensureCacheDir() {
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true });
  }
}

/**
 * Создаёт слабоинформативный приор Beta(4, 1):
 * E[p] = 4 / (4 + 1) = 0.80 (80% априорная надёжность Flash).
 * @returns {{ alpha: number, beta: number, runs: number, successes: number, failures: number, updatedAt: string|null }}
 */
function createDefaultPrior() {
  return {
    alpha: 4,
    beta: 1,
    runs: 0,
    successes: 0,
    failures: 0,
    updatedAt: null,
  };
}

/**
 * Формирует начальное состояние файла domain-priors.json.
 * @returns {object} Начальный объект состояния.
 */
function createInitialState() {
  const priors = {};
  for (const k of DOMAIN_KEYS) {
    priors[k] = createDefaultPrior();
  }
  for (const k of DIR_KEYS) {
    priors[k] = createDefaultPrior();
  }
  return {
    version: '4.2',
    updatedAt: new Date().toISOString(),
    priors,
    tierPriors: {},
    gradePriors: {},
    contextualModel: createDefaultContextualModel(),
    fileFragility: {},
  };
}

/**
 * Извлекает ключ директории верхнего уровня из пути к файлу.
 * Например: core/auto-verifier.mjs -> dir:core
 * @param {string} filePath Путь к файлу
 * @returns {string|null} Ключ директории (например 'dir:core') или null
 */
const UNSAFE_PROTO_KEYS = new Set([
  '__proto__',
  'constructor',
  'prototype',
  'toString',
  'valueOf',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
]);

function sanitizeKey(key, fallback = 'general') {
  if (!key || typeof key !== 'string') return fallback;
  const trimmed = key.trim();
  if (!trimmed || UNSAFE_PROTO_KEYS.has(trimmed) || UNSAFE_PROTO_KEYS.has(trimmed.replace(/^dir:/i, ''))) {
    return fallback;
  }
  return trimmed;
}

export function extractDirKey(filePath = '', workspaceRoot = '') {
  if (!filePath || typeof filePath !== 'string') return null;
  let norm = filePath.replace(/\\/g, '/');
  if (workspaceRoot && typeof workspaceRoot === 'string') {
    const rel = normalizeFilePath(filePath, workspaceRoot);
    if (rel && !rel.startsWith('..')) {
      norm = rel;
    }
  } else {
    norm = norm.replace(/^.*?\/\.gemini\/antigravity(?:-ide|-cli)?\/scratch\/[^/]+\//i, '');
  }

  // Известные ключевые каталоги верхнего уровня
  const knownMatch = norm.match(/(?:^|\/)(core|sidecars|skills)(?:\/|$)/i);
  if (knownMatch) {
    return `dir:${knownMatch[1].toLowerCase()}`;
  }

  // Относительный или абсолютный путь: разбиваем на компоненты
  const parts = norm.split('/').filter(Boolean);
  if (parts.length <= 1) {
    return 'dir:root';
  }

  const folder = parts[parts.length - 2];
  if (/^[a-zA-Z]:$/.test(folder)) {
    return 'dir:root';
  }
  if (UNSAFE_PROTO_KEYS.has(folder)) {
    return 'dir:root';
  }
  if (['core', 'sidecars', 'skills'].includes(folder.toLowerCase())) {
    return `dir:${folder.toLowerCase()}`;
  }

  return `dir:${folder.toLowerCase()}`;
}

/**
 * Сохраняет состояние априорных распределений в кэш.
 * @param {object} state Объект состояния.
 */
function savePriorsState(state) {
  ensureCacheDir();
  state.updatedAt = new Date().toISOString();
  atomicWriteJsonSync(PRIORS_FILE, state);
}

function decayBucketInPlace(bucket, now, nowIso, persistTs) {
  if (!bucket || typeof bucket !== 'object') return false;
  let modified = false;
  for (const key of Object.keys(bucket)) {
    const rec = bucket[key];
    if (!rec || typeof rec.alpha !== 'number' || typeof rec.beta !== 'number') continue;
    const upTs = rec.updatedAt ? new Date(rec.updatedAt).getTime() : 0;
    const elapsed = upTs > 0 ? now - upTs : 0;
    if (elapsed > TIME_DECAY_MS) {
      const decay = Math.pow(0.5, elapsed / HALF_LIFE_MS);
      rec.alpha = Number((rec.alpha * decay + 4 * (1 - decay)).toFixed(3));
      rec.beta = Number((rec.beta * decay + 1 * (1 - decay)).toFixed(3));
      if (persistTs) {
        rec.updatedAt = nowIso;
      }
      modified = true;
    }
  }
  return modified;
}

function migrateV40AsymmetricPriorsInPlace(state) {
  if (!state || typeof state !== 'object' || state.version === '4.2') return false;
  const priors = state.priors && typeof state.priors === 'object' ? state.priors : {};
  const tierPriors = state.tierPriors && typeof state.tierPriors === 'object' ? state.tierPriors : {};

  for (const key of Object.keys(priors)) {
    const rec = priors[key];
    if (!rec || typeof rec !== 'object' || typeof rec.alpha !== 'number') continue;
    if (key.startsWith('dir:')) {
      const a = Number(rec.alpha || 4);
      const b = Number(rec.beta || 1);
      const succ = Number(rec.successes || 0);
      const fail = Number(rec.failures || 0);
      if (fail > succ * 2 && (a / Math.max(0.05, a + b)) < 0.35) {
        priors[key] = createDefaultPrior();
      }
      continue;
    }

    const lightRec = tierPriors[`${key}::light`];
    if (lightRec && typeof lightRec.alpha === 'number' && Number(lightRec.runs || 0) > 0) {
      priors[key] = { ...lightRec };
    } else {
      const midFails = Number(tierPriors[`${key}::mid`]?.failures || 0);
      const heavyFails = Number(tierPriors[`${key}::heavy`]?.failures || 0);
      if (Number(rec.failures || 0) > 0 && (midFails + heavyFails) > 0) {
        priors[key] = createDefaultPrior();
      }
    }
  }

  for (const bucket of [tierPriors, state.gradePriors && typeof state.gradePriors === 'object' ? state.gradePriors : {}]) {
    for (const rec of Object.values(bucket)) {
      if (!rec || typeof rec !== 'object' || typeof rec.alpha !== 'number' || typeof rec.beta !== 'number') continue;
      const runs = Number(rec.runs || 0);
      const succ = Number(rec.successes || 0);
      if (runs >= 10 && succ / runs >= 0.75 && (rec.alpha / Math.max(0.05, rec.alpha + rec.beta)) < 0.70) {
        const empRate = Math.min(0.96, Math.max(0.75, succ / runs));
        const n = Math.min(30, runs + 5);
        rec.alpha = Number((empRate * n).toFixed(3));
        rec.beta = Number(((1 - empRate) * n).toFixed(3));
      }
    }
  }

  state.contextualModel = createDefaultContextualModel();
  state.version = '4.2';
  return true;
}

function ensureV4StateCollections(state) {
  if (!state.tierPriors || typeof state.tierPriors !== 'object' || Array.isArray(state.tierPriors)) {
    state.tierPriors = {};
  }
  if (!state.gradePriors || typeof state.gradePriors !== 'object' || Array.isArray(state.gradePriors)) {
    state.gradePriors = {};
  }
  if (!state.fileFragility || typeof state.fileFragility !== 'object' || Array.isArray(state.fileFragility)) {
    state.fileFragility = {};
  }
  state.contextualModel = sanitizeContextualModel(state.contextualModel);
  migrateV40AsymmetricPriorsInPlace(state);
  return state;
}

/**
 * Applies time-decay in memory for read paths without disk writes.
 * @param {object} state
 * @returns {object}
 */
function applyTimeDecayReadOnly(state) {
  if (!state || typeof state !== 'object' || !state.priors) {
    return createInitialState();
  }
  ensureV4StateCollections(state);
  const now = Date.now();
  const nowIso = new Date().toISOString();
  decayBucketInPlace(state.priors, now, nowIso, false);
  decayBucketInPlace(state.tierPriors, now, nowIso, false);
  decayBucketInPlace(state.gradePriors, now, nowIso, false);
  decayBucketInPlace(state.fileFragility, now, nowIso, false);
  return state;
}

/**
 * Applies time-decay to priors and fileFragility inside atomic state writers.
 * @param {object} state
 * @returns {object}
 */
function applyTimeDecayMut(state) {
  if (!state || typeof state !== 'object' || !state.priors) {
    return createInitialState();
  }
  ensureV4StateCollections(state);
  const now = Date.now();
  const nowIso = new Date().toISOString();
  decayBucketInPlace(state.priors, now, nowIso, true);
  decayBucketInPlace(state.tierPriors, now, nowIso, true);
  decayBucketInPlace(state.gradePriors, now, nowIso, true);
  decayBucketInPlace(state.fileFragility, now, nowIso, true);
  return state;
}

/**
 * Загружает состояние априорных распределений из кэша в pure read-only режиме (без записи на диск).
 * @returns {object} Объект состояния с priors.
 */
function loadPriorsState() {
  if (!existsSync(PRIORS_FILE)) {
    return createInitialState();
  }
  const state = safeReadJsonSync(PRIORS_FILE, createInitialState, { selfHeal: false });
  return applyTimeDecayReadOnly(state);
}

function applyBetaOutcomeUpdate(prior, {
  success = true,
  effectiveWeight = 1,
  isFirstPassSuccess = false,
  retryCount = 0,
  nowIso = new Date().toISOString(),
} = {}) {
  prior.runs = (prior.runs || 0) + 1;
  if (retryCount > 0) {
    prior.totalRetries = (prior.totalRetries || 0) + retryCount;
  }
  if (success) {
    const currentConf = (prior.alpha + prior.beta > 0) ? (prior.alpha / (prior.alpha + prior.beta)) : 0.8;
    let alphaGain = currentConf < 0.68 ? (effectiveWeight * 1.25) : effectiveWeight;
    if (isFirstPassSuccess) {
      alphaGain *= 1.05;
      prior.firstPassSuccesses = (prior.firstPassSuccesses || 0) + 1;
    }
    prior.alpha = Number((prior.alpha + alphaGain).toFixed(3));
    prior.successes = (prior.successes || 0) + 1;
  } else {
    // Failure penalty is weighted heavier and scales with blast-radius risk
    prior.beta = Number((prior.beta + effectiveWeight * 1.5).toFixed(3));
    prior.failures = (prior.failures || 0) + 1;
  }
  prior.updatedAt = nowIso;

  // Smooth sliding-window decay so priors adapt quickly to recent codebase changes
  if (prior.alpha + prior.beta > 50) {
    prior.alpha = Number((prior.alpha * 0.9).toFixed(3));
    prior.beta = Number((prior.beta * 0.9).toFixed(3));
  }
}

/**
 * Фиксирует исход выполнения (успех/сбой) для домена, папки, тира модели и контекстного скорера атомарно.
 * Предотвращает смешивание тиров: успех Pro/Neon/Carbon не завышает надёжность лёгкого Hydrogen.
 * @param {object} params Параметры исхода
 * @param {string} [params.domain='general'] Домен задачи
 * @param {string} [params.filePath=''] Путь к целевому файлу
 * @param {boolean} [params.success=true] Успешность операции
 * @param {number} [params.weight] Явный вес обновления (если не задан, выводится из signalType)
 * @param {string} [params.modelTier=''] Тир модели-исполнителя ('light'|'mid'|'heavy' или имя модели)
 * @param {string} [params.grade='M'] Масштаб задачи (S/M/L/XL)
 * @param {string} [params.signalType=''] Источник сигнала ('syntax'|'micro_test'|'contract_break'|'rollback')
 * @param {number} [params.fragilityScore=0] Текущий индекс хрупкости файла (0..100)
 * @returns {{ confidence: number, alpha: number, beta: number, tierBucket: string, gradeBucket: string, contextualUpdates: number }}
 */
export function recordModelOutcome(opts = {}) {
  const {
    domain = 'general',
    filePath = '',
    workspaceRoot = '',
    success = true,
    weight,
    dependentsCount = 0,
    firstPass = true,
    retries = 0,
    modelTier = '',
    grade = 'M',
    signalType = '',
    fragilityScore = 0,
  } = (opts && typeof opts === 'object') ? opts : {};
  ensureCacheDir();
  const domainKey = sanitizeKey(domain, 'general');
  const dirKey = extractDirKey(filePath, workspaceRoot);
  const tierBucket = normalizeModelTierBucket(modelTier);
  const gradeBucket = normalizeGradeBucket(grade);
  const baseWeight = resolveSignalWeight(signalType, weight, success);
  const depNum = Math.max(0, Number(dependentsCount) || 0);
  const retryCount = Math.max(0, Number(retries) || 0);
  const isFirstPassSuccess = Boolean(success && firstPass !== false && retryCount === 0);
  const highRiskDomain = domainKey === 'security' || domainKey === 'backend_db';
  const riskMultiplier = !success && (depNum >= 3 || highRiskDomain)
    ? 1 + Math.min(0.5, (depNum >= 3 ? Math.min(0.35, depNum * 0.07) : 0) + (highRiskDomain ? 0.15 : 0))
    : 1;
  const effectiveWeight = Number((baseWeight * riskMultiplier).toFixed(4));

  const keysToUpdate = [domainKey];
  if (dirKey && dirKey !== domainKey) {
    keysToUpdate.push(dirKey);
  }
  const tierKey = `${domainKey}::${tierBucket}`;
  const gradeKey = `${domainKey}::${gradeBucket}`;
  // Symmetric anti-confounding: mid/heavy outcomes (both successes and failures) stay isolated in tierPriors/gradePriors/contextualModel
  // so strong-tier failures never poison light-tier domain/dir priors to ~0% while strong-tier successes are skipped.
  const isStrongTier = Boolean(modelTier && (tierBucket === 'mid' || tierBucket === 'heavy'));
  const ctxFeatures = buildContextualFeatures({
    domainKey,
    grade,
    dependentsCount: depNum,
    fragilityScore,
    retries: retryCount,
  });

  const updatedState = updateJsonAtomicSync(PRIORS_FILE, createInitialState, (rawState) => {
    const state = applyTimeDecayMut(
      (rawState && typeof rawState === 'object' && rawState.priors)
        ? rawState
        : createInitialState()
    );
    state.version = '4.2';

    const now = new Date().toISOString();
    const updatePayload = {
      success,
      effectiveWeight,
      isFirstPassSuccess,
      retryCount,
      nowIso: now,
    };

    if (!isStrongTier) {
      for (const key of keysToUpdate) {
        if (!Object.hasOwn(state.priors, key) || typeof state.priors[key]?.alpha !== 'number') {
          state.priors[key] = createDefaultPrior();
        }
        applyBetaOutcomeUpdate(state.priors[key], updatePayload);
      }
    }

    if (!Object.hasOwn(state.tierPriors, tierKey) || typeof state.tierPriors[tierKey]?.alpha !== 'number') {
      state.tierPriors[tierKey] = createDefaultPrior();
    }
    applyBetaOutcomeUpdate(state.tierPriors[tierKey], updatePayload);

    if (!Object.hasOwn(state.gradePriors, gradeKey) || typeof state.gradePriors[gradeKey]?.alpha !== 'number') {
      state.gradePriors[gradeKey] = createDefaultPrior();
    }
    applyBetaOutcomeUpdate(state.gradePriors[gradeKey], updatePayload);

    updateContextualModelInPlace(state, ctxFeatures, success, effectiveWeight);

    state.updatedAt = now;
    return state;
  });

  const targetPrior = (updatedState?.priors && Object.hasOwn(updatedState.priors, domainKey))
    ? updatedState.priors[domainKey]
    : createDefaultPrior();
  const confidence = targetPrior.alpha / (targetPrior.alpha + targetPrior.beta);

  return {
    confidence: Number(confidence.toFixed(4)),
    alpha: targetPrior.alpha,
    beta: targetPrior.beta,
    tierBucket,
    gradeBucket,
    contextualUpdates: Number(updatedState?.contextualModel?.updates || 0),
  };
}

/**
 * Оценивает байесовский маршрут задачи (v4):
 * Precision-Weighted Hierarchical Beta + Risk-Weighted LCB + Contextual Logistic Blend (<1 мс).
 * @param {object} params Параметры оценки
 * @param {string} [params.domain='general'] Домен задачи
 * @param {string} [params.grade='M'] Масштаб задачи (S/M/L/XL)
 * @param {string} [params.filePath=''] Путь к целевому файлу
 * @param {string} [params.workspaceRoot=''] Корень воркспейса
 * @param {number} [params.dependentsCount=0] Количество зависимых модулей (Blast Radius)
 * @param {string} [params.modelTier='light'] Целевой тир модели ('light'|'mid'|'heavy')
 * @param {number} [params.fragilityScore=0] Индекс хрупкости файла (0..100)
 * @param {number} [params.retries=0] Число недавних повторов
 * @param {boolean} [params.explore=false] Добавлять ли Thompson Sampling оценку
 * @returns {{ domain: string, confidence: number, effectiveConfidence: number, riskPenalty: number, confidencePercent: number, posteriorStd: number, lcbConfidence: number, contextualConfidence: number, modelTierBucket: string, gradeBucket: string, recommendedTier: 'flash'|'pro', recommendedGemini4: string, depthBoost: number, escalated: boolean, runs: number, formattedHint: string }}
 */
export function evaluateBayesianRoute(opts = {}) {
  const {
    domain = 'general',
    grade = 'M',
    filePath = '',
    workspaceRoot = '',
    dependentsCount = 0,
    modelTier = 'light',
    fragilityScore = 0,
    retries = 0,
    explore = false,
    lang = 'ru',
  } = (opts && typeof opts === 'object') ? opts : {};
  const isEn = normalizeLang(lang, 'ru') === 'en';
  const state = loadPriorsState();
  const domainKey = sanitizeKey(domain, 'general');
  const tierBucket = normalizeModelTierBucket(modelTier);
  const gradeBucket = normalizeGradeBucket(grade);
  const domainPrior = (state.priors && Object.hasOwn(state.priors, domainKey) && typeof state.priors[domainKey]?.alpha === 'number')
    ? state.priors[domainKey]
    : createDefaultPrior();

  const poolComponents = [];
  const pushPoolComponent = (prior, scale = 1.0, requireRuns = false) => {
    if (!prior || typeof prior.alpha !== 'number' || typeof prior.beta !== 'number') return;
    if (requireRuns && Number(prior.runs || 0) <= 0) return;
    const a = Math.max(0.05, prior.alpha);
    const b = Math.max(0.05, prior.beta);
    const mean = a / (a + b);
    const std = computeBetaStd(a, b);
    const variance = Math.max(0.0025, std * std);
    poolComponents.push({ mean, variance, precision: scale / variance, alpha: a, beta: b });
  };

  pushPoolComponent(domainPrior, 1.0, false);

  const dirKey = filePath ? extractDirKey(filePath, workspaceRoot) : null;
  if (dirKey && state.priors && Object.hasOwn(state.priors, dirKey)) {
    pushPoolComponent(state.priors[dirKey], 0.65, true);
  }
  const tierKey = `${domainKey}::${tierBucket}`;
  if (state.tierPriors && Object.hasOwn(state.tierPriors, tierKey)) {
    pushPoolComponent(state.tierPriors[tierKey], 0.85, true);
  }
  const gradeKey = `${domainKey}::${gradeBucket}`;
  if (state.gradePriors && Object.hasOwn(state.gradePriors, gradeKey)) {
    pushPoolComponent(state.gradePriors[gradeKey], 0.75, true);
  }

  let totalPrec = 0;
  let weightedMeanSum = 0;
  let minVar = poolComponents[0].variance;
  for (const comp of poolComponents) {
    totalPrec += comp.precision;
    weightedMeanSum += comp.precision * comp.mean;
    if (comp.variance < minVar) minVar = comp.variance;
  }
  const pooledMean = totalPrec > 0 ? weightedMeanSum / totalPrec : 0.8;
  // Anchor posterior uncertainty to avoid artificial collapse from overlapping hierarchy buckets
  const posteriorVar = Math.max(minVar * 0.65, totalPrec > 0 ? (1 / totalPrec) : minVar);
  const posteriorStd = Math.sqrt(posteriorVar);

  const depNum = Math.max(0, Number(dependentsCount) || 0);
  const ctxFeatures = buildContextualFeatures({
    domainKey,
    grade,
    dependentsCount: depNum,
    fragilityScore,
    retries,
  });
  const ctxPred = predictContextualSuccess(state.contextualModel, ctxFeatures);
  const ctxBasePred = predictContextualSuccess(state.contextualModel, [1, 0, 0, 0, 0, 0]);
  const ctxUpdates = Number(state.contextualModel?.updates || 0);
  const ctxScale = ctxUpdates >= 5 ? Math.min(0.65, (ctxUpdates - 4) / 25) : 0;
  const rawCtxDelta = ctxPred.calibrated - ctxBasePred.calibrated;
  // Never let global contextual optimism mask a locally failing domain (<0.72)
  const cappedCtxDelta = rawCtxDelta > 0
    ? (pooledMean >= 0.72 ? Math.min(0.03, rawCtxDelta * ctxScale) : 0)
    : Math.max(-0.18, rawCtxDelta * ctxScale);
  const confidence = Math.max(0, Math.min(1, pooledMean + cappedCtxDelta));

  const lcbZ = grade === 'XL'
    ? 0.55
    : grade === 'L'
      ? 0.35
      : (depNum >= 3 || domainKey === 'security')
        ? 0.45
        : 0.12;
  const lcbConfidence = Math.max(0, confidence - lcbZ * posteriorStd);

  const riskPenalty = Math.min(
    0.08,
    (grade === 'XL' ? 0.04 : grade === 'L' ? 0.02 : 0) +
      Math.min(0.04, depNum * 0.01) +
      (domainKey === 'security' ? 0.03 : 0)
  );
  const effectiveConfidence = Math.max(0, lcbConfidence - riskPenalty);

  const confidencePercent = Math.round(effectiveConfidence * 100);
  let recommendedTier = 'flash';
  let recommendedGemini4 = 'Hydrogen · Средний/Высокий';
  let recommendedGemini4En = 'Hydrogen · Medium/High';
  let depthBoost = 0;
  let escalated = false;
  let formattedHint = '';

  if (effectiveConfidence < 0.62) {
    recommendedTier = 'pro';
    recommendedGemini4 = 'Orchestrator (Carbon · Высокий) / Orchestrator (Neon · Высокий/XHigh) / Neon · XHigh';
    recommendedGemini4En = 'Orchestrator (Carbon · High) / Orchestrator (Neon · High/XHigh) / Neon · XHigh';
    depthBoost = 2;
    escalated = true;
    formattedHint = isEn
      ? `🎲 [Bayesian v4 | Gemini 4] Domain "${domainKey}" LCB reliability: ${confidencePercent}% (<62%) -> Escalate cognitive depth to ${recommendedGemini4En}!`
      : `🎲 [Bayesian v4 | Gemini 4] Domain "${domainKey}" LCB reliability: ${confidencePercent}% (<62%) -> Escalate cognitive depth to Orchestrator (Carbon · Высокий / Neon · Высокий/XHigh) / Neon · XHigh!`;
  } else if (effectiveConfidence < 0.72) {
    recommendedTier = 'pro';
    recommendedGemini4 = 'Orchestrator (Neon · Высокий) / Neon · Высокий или Hydrogen · XHigh';
    recommendedGemini4En = 'Orchestrator (Neon · High) / Neon · High or Hydrogen · XHigh';
    depthBoost = 1;
    escalated = effectiveConfidence < 0.68;
    if (effectiveConfidence < 0.68 || domainPrior.runs >= 2) {
      formattedHint = `🎲 [Bayesian v4 | Gemini 4] Domain "${domainKey}" LCB reliability: ${confidencePercent}% -> Prefer ${isEn ? recommendedGemini4En : recommendedGemini4}.`;
    }
  } else if (effectiveConfidence >= 0.84 && grade !== 'XL') {
    recommendedTier = 'flash';
    recommendedGemini4 = 'Hydrogen · Средний';
    recommendedGemini4En = 'Hydrogen · Medium';
    depthBoost = 0;
    escalated = false;
    formattedHint = `🎲 [Bayesian v4 | Gemini 4] Domain "${domainKey}" LCB reliability: ${confidencePercent}% -> Safe for fast Hydrogen execution.`;
  } else {
    recommendedTier = (grade === 'L' || grade === 'XL') ? 'pro' : 'flash';
    recommendedGemini4 = (grade === 'XL')
      ? 'Orchestrator (Neon · XHigh) / Orchestrator (Carbon · Высокий)'
      : (grade === 'L' ? 'Orchestrator (Neon · Высокий) или Hydrogen · Высокий/XHigh' : 'Hydrogen · Средний/Высокий');
    recommendedGemini4En = (grade === 'XL')
      ? 'Orchestrator (Neon · XHigh) / Orchestrator (Carbon · High)'
      : (grade === 'L' ? 'Orchestrator (Neon · High) or Hydrogen · High/XHigh' : 'Hydrogen · Medium/High');
    depthBoost = 0;
    escalated = false;
  }

  const successes = Number(domainPrior.successes || 0);
  const firstPassCount = typeof domainPrior.firstPassSuccesses === 'number'
    ? domainPrior.firstPassSuccesses
    : successes;
  const firstPassRate = successes > 0
    ? Number(Math.min(1, Math.max(0, firstPassCount / successes)).toFixed(4))
    : 1;
  const expectedTurnsEstimate = Number((1 + (Number(domainPrior.totalRetries || 0) / Math.max(1, Number(domainPrior.runs || 1)))).toFixed(2));
  const tierPriorRef = state.tierPriors?.[tierKey] || domainPrior;
  const thompsonSample = explore
    ? sampleThompsonConfidence(tierPriorRef.alpha, tierPriorRef.beta)
    : undefined;

  return {
    domain: domainKey,
    confidence: Number(confidence.toFixed(4)),
    effectiveConfidence: Number(effectiveConfidence.toFixed(4)),
    riskPenalty: Number(riskPenalty.toFixed(4)),
    confidencePercent,
    posteriorStd: Number(posteriorStd.toFixed(4)),
    lcbConfidence: Number(lcbConfidence.toFixed(4)),
    contextualConfidence: ctxPred.calibrated,
    modelTierBucket: tierBucket,
    gradeBucket,
    ...(thompsonSample !== undefined ? { thompsonSample } : {}),
    recommendedTier,
    recommendedGemini4,
    recommendedGemini4En,
    depthBoost,
    escalated,
    runs: domainPrior.runs,
    firstPassRate,
    expectedTurnsEstimate,
    formattedHint,
  };
}

/**
 * Формирует агрегированную байесовскую сводку для отрисовки в панели Glass 95.
 * @returns {{ overallConfidencePercent: number, totalRuns: number, domains: Array<{ key: string, label: string, confidencePercent: number, alpha: number, beta: number, runs: number, failures: number, recommendedTier: string, recommendedGemini4: string }> }}
 */
export function getBayesianSummary(workspaceRoot = '') {
  const state = loadPriorsState();
  const cleanWs = (workspaceRoot && typeof workspaceRoot === 'string') ? workspaceRoot.trim() : '';
  const isScopedWs = Boolean(cleanWs && cleanWs !== '__all__');
  let totalSuccesses = 0;
  let totalFirstPassSuccesses = 0;
  let totalRetries = 0;
  const domains = DOMAIN_KEYS.map((key) => {
    const prior = state.priors[key] || createDefaultPrior();
    const p = prior.alpha / (prior.alpha + prior.beta);
    const std = computeBetaStd(prior.alpha, prior.beta);
    const lcbPercent = Math.round(Math.max(0, p - 0.15 * std) * 100);
    const confidencePercent = Math.round(p * 100);
    const runs = Number(prior.runs || 0);
    const successes = Number(prior.successes || 0);
    const firstPassCount = typeof prior.firstPassSuccesses === 'number'
      ? prior.firstPassSuccesses
      : successes;
    const retries = Number(prior.totalRetries || 0);
    totalSuccesses += successes;
    totalFirstPassSuccesses += firstPassCount;
    totalRetries += retries;
    const firstPassPercent = successes > 0
      ? Math.round(Math.min(1, Math.max(0, firstPassCount / successes)) * 100)
      : 100;
    const expectedTurnsEstimate = runs > 0
      ? Number((1 + retries / runs).toFixed(2))
      : 1;
    const recommendedTier =
      confidencePercent < 68 ? 'pro' : confidencePercent >= 84 ? 'flash' : 'balanced';
    const recommendedGemini4 =
      confidencePercent < 62
        ? 'Orchestrator (Carbon / Neon) / Neon · XHigh'
        : confidencePercent < 72
          ? 'Orchestrator (Neon) / Neon · Высокий'
          : 'Hydrogen · Средний';
    const recommendedGemini4En =
      confidencePercent < 62
        ? 'Orchestrator (Carbon / Neon) / Neon · XHigh'
        : confidencePercent < 72
          ? 'Orchestrator (Neon) / Neon · High'
          : 'Hydrogen · Medium';

    const tierConfidence = {};
    for (const tb of ['light', 'mid', 'heavy']) {
      const tp = state.tierPriors?.[`${key}::${tb}`];
      if (tp && Number(tp.runs || 0) > 0 && (tp.alpha + tp.beta) > 0) {
        tierConfidence[tb] = Math.round((tp.alpha / (tp.alpha + tp.beta)) * 100);
      }
    }

    return {
      key,
      label: DOMAIN_LABELS[key] || key,
      labelEn: DOMAIN_LABELS_EN[key] || key,
      confidencePercent,
      lcbPercent,
      posteriorStd: Number(std.toFixed(4)),
      alpha: Number(prior.alpha.toFixed(2)),
      beta: Number(prior.beta.toFixed(2)),
      runs,
      failures: prior.failures || 0,
      firstPassPercent,
      expectedTurnsEstimate,
      tierConfidence,
      recommendedTier,
      recommendedGemini4,
      recommendedGemini4En,
    };
  });

  const totalRuns = domains.reduce((acc, d) => acc + d.runs, 0);
  const sumConfidence = domains.reduce((acc, d) => acc + d.confidencePercent, 0);
  const overallConfidencePercent =
    domains.length > 0 ? Math.round(sumConfidence / domains.length) : 80;
  const overallFirstPassRate = totalSuccesses > 0
    ? Number(Math.min(1, Math.max(0, totalFirstPassSuccesses / totalSuccesses)).toFixed(4))
    : 1;
  const overallFirstPassPercent = Math.round(overallFirstPassRate * 100);
  const overallExpectedTurns = totalRuns > 0
    ? Number((1 + totalRetries / totalRuns).toFixed(2))
    : 1;

  const wsHashPrefix = (wsRoot = '') => {
    if (!wsRoot || typeof wsRoot !== 'string') return '';
    const abs = resolve(wsRoot);
    const norm = process.platform === 'win32' ? abs.toLowerCase() : abs;
    return createHash('sha1').update(norm).digest('hex').slice(0, 8);
  };

  const targetWsHash = isScopedWs ? wsHashPrefix(cleanWs) : '';
  const fragEntries = Object.entries(state.fileFragility || {}).filter(([rawKey]) => {
    if (!isScopedWs) return true;
    if (String(rawKey).startsWith(`${targetWsHash}:`)) return true;
    if (!/^[0-9a-f]{8}:/i.test(String(rawKey))) {
      try {
        return existsSync(join(cleanWs, String(rawKey)));
      } catch {
        return false;
      }
    }
    return false;
  });
  const fragileFiles = fragEntries
    .map(([rawKey, entry]) => {
      const alpha = Number(entry?.alpha) || 1;
      const beta = Number(entry?.beta) || 1;
      const runs = Number(entry?.runs) || 0;
      const failures = Number(entry?.failures) || 0;
      const reliabilityPercent = Math.round((alpha / (alpha + beta)) * 100);
      const displayFile = String(rawKey).replace(/^[0-9a-f]{8}:/i, '');
      return {
        rawKey,
        file: displayFile,
        reliabilityPercent,
        runs,
        failures,
        dependentsCount: Number(entry?.dependentsCount) || 0,
      };
    })
    .filter((x) => x.runs > 0)
    .sort((a, b) => a.reliabilityPercent - b.reliabilityPercent || b.failures - a.failures)
    .slice(0, 6)
    .map(({ rawKey: _raw, ...rest }) => rest);

  return {
    overallConfidencePercent,
    overallFirstPassRate,
    overallFirstPassPercent,
    overallExpectedTurns,
    totalRuns,
    contextualUpdates: Number(state.contextualModel?.updates || 0),
    domains,
    fragileFiles,
  };
}

/**
 * Сбрасывает накопленные априорные веса к исходным значениям (или хрупкость файлов выбранного проекта).
 * @param {object} [options={}]
 * @returns {{ ok: boolean, summary: object }}
 */
export function resetBayesianPriors(options = {}) {
  ensureCacheDir();
  const cleanWs = (options && typeof options === 'object' && typeof options.workspaceRoot === 'string')
    ? options.workspaceRoot.trim()
    : '';
  const isScopedWs = Boolean(cleanWs && cleanWs !== '__all__');
  const onlyFragility = Boolean(options && typeof options === 'object' && options.onlyFragility);

  if (onlyFragility && isScopedWs) {
    const abs = resolve(cleanWs);
    const norm = process.platform === 'win32' ? abs.toLowerCase() : abs;
    const prefix = `${createHash('sha1').update(norm).digest('hex').slice(0, 8)}:`;
    updateJsonAtomicSync(PRIORS_FILE, createInitialState, (rawState) => {
      const state = (rawState && typeof rawState === 'object' && rawState.priors)
        ? { ...rawState, fileFragility: { ...(rawState.fileFragility || {}) } }
        : createInitialState();
      for (const k of Object.keys(state.fileFragility || {})) {
        if (k.startsWith(prefix)) {
          delete state.fileFragility[k];
        } else if (!/^[0-9a-f]{8}:/i.test(k)) {
          try {
            if (existsSync(join(cleanWs, k))) delete state.fileFragility[k];
          } catch {}
        }
      }
      state.updatedAt = new Date().toISOString();
      return state;
    });
    return {
      ok: true,
      summary: getBayesianSummary(cleanWs),
    };
  }

  updateJsonAtomicSync(PRIORS_FILE, createInitialState, () => createInitialState());
  return {
    ok: true,
    summary: getBayesianSummary(isScopedWs ? cleanWs : ''),
  };
}

/**
 * Normalizes file path to relative POSIX path.
 * @param {string} filePath
 * @param {string} [workspaceRoot='']
 * @returns {string}
 */
function normalizeFilePath(filePath = '', workspaceRoot = '') {
  if (!filePath || typeof filePath !== 'string') return '';
  const root = workspaceRoot || process.cwd();
  let rel = filePath.replace(/\\/g, '/');
  if (isAbsolute(filePath)) {
    try {
      const r = relative(root, filePath).replace(/\\/g, '/');
      if (!r.startsWith('..') && !isAbsolute(r)) {
        rel = r;
      }
    } catch {}
  }
  rel = rel.replace(/^\.\//, '');
  const base = basename(rel);
  if (UNSAFE_PROTO_KEYS.has(base) || UNSAFE_PROTO_KEYS.has(rel)) {
    return '';
  }
  return rel;
}

/**
 * Creates default file fragility record.
 * @param {number} [linesCount=0]
 * @param {number} [dependentsCount=0]
 * @returns {{ alpha: number, beta: number, runs: number, failures: number, dependentsCount: number, linesCount: number, updatedAt: string|null }}
 */
function createDefaultFileFragility(linesCount = 0, dependentsCount = 0) {
  return {
    alpha: 4,
    beta: 1,
    runs: 0,
    failures: 0,
    dependentsCount: Number(dependentsCount) || 0,
    linesCount: Number(linesCount) || 0,
    updatedAt: null,
  };
}

function estimateFileLines(filePath, workspaceRoot = '') {
  try {
    const fullPath = isAbsolute(filePath) ? filePath : join(workspaceRoot || process.cwd(), filePath);
    if (existsSync(fullPath)) {
      return Math.max(1, Math.round(statSync(fullPath).size / 38));
    }
  } catch {}
  return 0;
}

/**
 * Records outcome of editing or verifying a file for objective fragility telemetry.
 * @param {object} [params]
 * @param {string} [params.filePath=''] Target file path
 * @param {string} [params.workspaceRoot=''] Workspace root directory
 * @param {boolean} [params.success=true] True if edit/verify succeeded
 * @param {string} [params.eventType='edit'] Event type
 * @param {number} [params.dependentsCount=0] Known dependents count
 * @param {number} [params.linesCount=0] Line count of file
 * @returns {object|null}
 */
function buildFragilityStorageKey(filePath = '', workspaceRoot = '') {
  const normRelFile = normalizeFilePath(filePath, workspaceRoot);
  if (!normRelFile) return { normRelFile: '', storageKey: '' };
  if (workspaceRoot && typeof workspaceRoot === 'string') {
    const abs = resolve(workspaceRoot);
    const norm = process.platform === 'win32' ? abs.toLowerCase() : abs;
    const hash = createHash('sha1').update(norm).digest('hex').slice(0, 8);
    return { normRelFile, storageKey: `${hash}:${normRelFile}` };
  }
  return { normRelFile, storageKey: normRelFile };
}

export function recordFileFragility(opts = {}) {
  const {
    filePath = '',
    workspaceRoot = '',
    success = true,
    eventType = 'edit',
    dependentsCount = 0,
    linesCount = 0,
  } = (opts && typeof opts === 'object') ? opts : {};
  const { normRelFile, storageKey } = buildFragilityStorageKey(filePath, workspaceRoot);
  if (!normRelFile || !storageKey) return null;

  ensureCacheDir();

  const updatedState = updateJsonAtomicSync(PRIORS_FILE, createInitialState, (rawState) => {
    const state = applyTimeDecayMut(
      (rawState && typeof rawState === 'object' && rawState.priors)
        ? rawState
        : createInitialState()
    );

    if (!state.fileFragility || typeof state.fileFragility !== 'object') {
      state.fileFragility = {};
    }

    if (!Object.hasOwn(state.fileFragility, storageKey) || typeof state.fileFragility[storageKey]?.alpha !== 'number') {
      state.fileFragility[storageKey] = createDefaultFileFragility(linesCount, dependentsCount);
    }

    const item = state.fileFragility[storageKey];
    item.runs = (item.runs || 0) + 1;
    if (success) {
      item.alpha = Number((item.alpha + 1).toFixed(3));
    } else {
      item.beta = Number((item.beta + 1.5).toFixed(3));
      item.failures = (item.failures || 0) + 1;
    }

    if (item.alpha + item.beta > 50) {
      item.alpha = Number((item.alpha * 0.9).toFixed(3));
      item.beta = Number((item.beta * 0.9).toFixed(3));
    }

    if (dependentsCount > 0) {
      item.dependentsCount = Math.max(item.dependentsCount || 0, Number(dependentsCount));
    }

    if (linesCount > 0) {
      item.linesCount = Number(linesCount);
    } else if (!item.linesCount) {
      const est = estimateFileLines(filePath, workspaceRoot);
      if (est > 0) item.linesCount = est;
    }

    item.updatedAt = new Date().toISOString();
    state.updatedAt = item.updatedAt;

    const fragKeys = Object.keys(state.fileFragility);
    if (fragKeys.length > MAX_FRAGILITY_FILES) {
      fragKeys.sort((a, b) => {
        const ta = Date.parse(state.fileFragility[a]?.updatedAt || '') || 0;
        const tb = Date.parse(state.fileFragility[b]?.updatedAt || '') || 0;
        return tb - ta;
      });
      for (let i = MAX_FRAGILITY_FILES; i < fragKeys.length; i++) {
        delete state.fileFragility[fragKeys[i]];
      }
    }
    return state;
  });

  return updatedState?.fileFragility?.[storageKey] || null;
}

/**
 * Evaluates file fragility and blast-radius risk based on historical outcomes and structure.
 * @param {object} [params]
 * @param {string} [params.filePath=''] Target file path
 * @param {string} [params.workspaceRoot=''] Workspace root directory
 * @param {number} [params.dependentsCount=0] Known dependents count
 * @param {number} [params.linesCount=0] Line count of file
 * @returns {{ file: string, isFragile: boolean, fragilityScore: number, reliabilityPercent: number, dependentsCount: number, formattedHint: string }}
 */
export function evaluateFileFragility(opts = {}) {
  const {
    filePath = '',
    workspaceRoot = '',
    dependentsCount = 0,
    linesCount = 0,
  } = (opts && typeof opts === 'object') ? opts : {};
  const { normRelFile, storageKey } = buildFragilityStorageKey(filePath, workspaceRoot);
  if (!normRelFile || !storageKey) {
    return {
      file: '',
      isFragile: false,
      fragilityScore: 0,
      reliabilityPercent: 80,
      dependentsCount: 0,
      formattedHint: '',
    };
  }

  const state = loadPriorsState();
  const fragMap = state?.fileFragility && typeof state.fileFragility === 'object' ? state.fileFragility : {};
  const item = (Object.hasOwn(fragMap, storageKey) && typeof fragMap[storageKey]?.alpha === 'number')
    ? fragMap[storageKey]
    : (!workspaceRoot && Object.hasOwn(fragMap, normRelFile) && typeof fragMap[normRelFile]?.alpha === 'number')
      ? fragMap[normRelFile]
      : createDefaultFileFragility(linesCount, dependentsCount);

  const effectiveDeps = dependentsCount > 0 ? Number(dependentsCount) : (item.dependentsCount || 0);
  let effectiveLines = linesCount > 0 ? Number(linesCount) : (item.linesCount || 0);

  if (!effectiveLines) {
    effectiveLines = estimateFileLines(filePath, workspaceRoot);
  }

  const alpha = typeof item.alpha === 'number' ? item.alpha : 4;
  const beta = typeof item.beta === 'number' ? item.beta : 1;
  const total = alpha + beta;
  const failuresCount = Number(item.failures) || 0;
  const failureRate = total > 0 ? (beta / total) : 0.2;
  const reliability = total > 0 ? (alpha / total) : 0.8;
  const reliabilityPercent = Math.round(reliability * 100);

  // Zero-failure guard: prior beta=1 alone must never flag a clean hub file as fragile
  const failurePart = failuresCount === 0 ? 0 : failureRate * 60;
  // Dependents contribution (0..25 pts, 5 pts per dependent, max 25)
  const depPart = Math.min(25, effectiveDeps * 5);
  // Lines count contribution (0..15 pts, 1 pt per 30 lines, max 15)
  const linesPart = Math.min(15, effectiveLines / 30);

  const rawScore = failurePart + depPart + linesPart;
  const fragilityScore = Math.min(100, Math.max(0, Math.round(rawScore)));
  const isFragile = fragilityScore >= 52;

  let formattedHint = '';
  if (isFragile) {
    formattedHint = `📊 [File Telemetry] "${normRelFile}" is fragile (Score: ${fragilityScore}/100, Reliability: ${reliabilityPercent}%, Dependents: ${effectiveDeps}) -> Use edit_file and verify carefully!`;
  }

  return {
    file: normRelFile,
    isFragile,
    fragilityScore,
    reliabilityPercent,
    dependentsCount: effectiveDeps,
    formattedHint,
  };
}

/**
 * Агрегирует риск по набору целевых файлов и домену для 2D-маршрутизатора Gemini 4 (<1 мс).
 * Если на целевом файле были недавние откаты/ошибки (reliability < 75% или fragilityScore >= 58),
 * возвращает depthBoost (+1 или +2 ступени когнитивной глубины).
 */
export function evaluateTargetsFragility(opts = {}) {
  const {
    matchedFiles = [],
    domain = 'general',
    workspaceRoot = '',
    modelTier = 'light',
    grade = 'M',
  } = (opts && typeof opts === 'object') ? opts : {};
  const safeFiles = Array.isArray(matchedFiles) ? matchedFiles : [];
  const firstFile = typeof safeFiles[0] === 'string' ? safeFiles[0] : (safeFiles[0]?.file || '');
  const route = evaluateBayesianRoute({ domain, grade, filePath: firstFile, workspaceRoot, modelTier });
  let maxFragilityScore = 0;
  let minFileReliability = 100;
  const fragileFiles = [];

  for (const mf of safeFiles.slice(0, 4)) {
    const fPath = typeof mf === 'string' ? mf : (mf?.file || '');
    if (!fPath) continue;
    const fRes = evaluateFileFragility({
      filePath: fPath,
      workspaceRoot,
      dependentsCount: Number(mf?.dependentsCount || 0),
      linesCount: Number(mf?.lines || 0),
    });
    if (fRes.fragilityScore > maxFragilityScore) maxFragilityScore = fRes.fragilityScore;
    if (fRes.reliabilityPercent < minFileReliability) minFileReliability = fRes.reliabilityPercent;
    if (fRes.isFragile) fragileFiles.push(fRes);
  }

  let depthBoost = route.depthBoost || 0;
  if (minFileReliability < 65 || maxFragilityScore >= 72) {
    depthBoost = Math.max(depthBoost, 2);
  } else if (minFileReliability < 76 || maxFragilityScore >= 58) {
    depthBoost = Math.max(depthBoost, 1);
  }

  const hints = [];
  for (const ff of fragileFiles.slice(0, 2)) {
    if (ff.formattedHint) hints.push(ff.formattedHint);
  }
  if (route.formattedHint && (route.depthBoost > 0 || fragileFiles.length === 0)) {
    hints.push(route.formattedHint);
  }

  return {
    domain: route.domain,
    domainConfidence: route.confidence,
    recommendedGemini4: route.recommendedGemini4,
    maxFragilityScore,
    minFileReliability,
    fragileFiles,
    depthBoost,
    formattedHint: hints.join('\n'),
  };
}

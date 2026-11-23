/**
 * @file quota-pacer.mjs
 * @description Предиктор скорости расхода квоты (`Quota Burn-Rate Pacer`) и аудитор стабильности префикса Gemini 4.
 * Анализирует скользящее окно вызовов за 30 и 60 минут с учётом тарифа (`pro` / `ultra`) и весов моделей,
 * а также отслеживает дрейф статического префикса `>=4096` токенов (не дублируя метрику `% Implicit Cache`).
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteJsonSync, safeReadJsonSync, withFileLockSync } from './safe-json.mjs';
import { resolveTunnelCacheDir } from './cache-dir.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, '..');
const DEFAULT_CACHE_DIR = resolveTunnelCacheDir(PLUGIN_ROOT);
const getDefaultCacheDir = () => resolveTunnelCacheDir(PLUGIN_ROOT);
const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const TIER_WEIGHTS = {
  hydrogen: 1.0,
  flash: 0.7,
  orchestrator: 1.35,
  orchestrator_neon: 1.35,
  orchestrator_argon: 1.45,
  orchestrator_carbon: 1.75,
  argon: 2.0,
  neon: 2.2,
  carbon: 3.5,
  unknown: 1.4,
};

const THINKING_MULTIPLIERS = {
  low: 0.78,
  medium: 1.0,
  high: 1.15,
  xhigh: 1.32,
};

function asObj(val) {
  return val && typeof val === 'object' && !Array.isArray(val) ? val : {};
}

function asStr(val, maxLen = 1024) {
  if (typeof val !== 'string') return '';
  return val.replace(/\0/g, '').slice(0, maxLen);
}

function normalizeThinkingKey(rawThinking = '', fallbackStr = '') {
  const s = `${asStr(rawThinking, 32)} ${asStr(fallbackStr, 96)}`.toLowerCase();
  if (/(?:^|[^a-zа-яё])(xhigh|x-high|extra[\s_-]*high|extra|max|сверхвысокий)(?=$|[^a-zа-яё])/i.test(s)) return 'xhigh';
  if (/(?:^|[^a-zа-яё])(high|высокий)(?=$|[^a-zа-яё])/i.test(s)) return 'high';
  if (/(?:^|[^a-zа-яё])(low|minimal|низкий)(?=$|[^a-zа-яё])/i.test(s)) return 'low';
  if (/(?:^|[^a-zа-яё])(medium|средний)(?=$|[^a-zа-яё])/i.test(s)) return 'medium';
  return '';
}

function normalizeTierKey(rawTier = '') {
  const s = asStr(rawTier, 96).toLowerCase();
  if (!s) return 'unknown';
  if (s.includes('orchestrator') || s.includes('оркестратор')) {
    if (s.includes('carbon') || s.includes('карбон')) return 'orchestrator_carbon';
    if (s.includes('argon') || s.includes('аргон')) return 'orchestrator_argon';
    if (s.includes('neon') || s.includes('неон')) return 'orchestrator_neon';
    return 'orchestrator';
  }
  if (s.includes('carbon') || s.includes('карбон')) return 'carbon';
  if (s.includes('neon') || s.includes('неон')) return 'neon';
  if (s.includes('argon') || s.includes('аргон')) return 'argon';
  if (s.includes('hydrogen') || s.includes('водород')) return 'hydrogen';
  if (s.includes('flash')) return 'flash';
  return 'unknown';
}

function resolveCachePaths(cacheDir = '') {
  const baseCache = asStr(cacheDir, 1024).trim() ? resolve(asStr(cacheDir, 1024).trim()) : getDefaultCacheDir();
  if (!existsSync(baseCache)) mkdirSync(baseCache, { recursive: true });
  return {
    quotaFile: join(baseCache, 'quota-pacer.json'),
    prefixFile: join(baseCache, 'prefix-stability.json'),
    comboFile: join(baseCache, 'combo-cooldowns.json'),
  };
}

export const DEFAULT_COMBO_CHAINS = {
  deep_architect: ['orchestrator_carbon', 'orchestrator_neon', 'gemini-4-neon-high', 'claude-sonnet-5-5-thinking', 'gemini-4-hydrogen-high'],
  daily_coding: ['gemini-4-hydrogen-medium', 'orchestrator_neon', 'gemini-4-neon-medium', 'claude-sonnet-4-6', 'gpt-oss-120b-medium'],
  swarm_worker: ['gemini-4-hydrogen-medium', 'gemini-4-neon-medium', 'claude-sonnet-4-6', 'gpt-oss-120b-medium', 'gemini-3-8-flash'],
  budget_fast: ['gemini-4-hydrogen-medium', 'gemini-3-8-flash', 'gpt-oss-120b-medium', 'local_ollama'],
};

/**
 * Регистрирует вызов модели в скользящем буфере последних 2 часов.
 * @param {object} [opts={}]
 * @returns {{ ok: boolean, samplesCount: number }}
 */
export function recordQuotaTurnSample(opts = {}) {
  const safeOpts = asObj(opts);
  const { quotaFile } = resolveCachePaths(safeOpts.cacheDir);
  const nowMs = Number.isFinite(Number(safeOpts.ts)) ? Number(safeOpts.ts) : Date.now();
  const rawModelRef = safeOpts.tier || safeOpts.modelTier || safeOpts.modelName || 'hydrogen';
  const tier = normalizeTierKey(rawModelRef);
  const thinkingLevel = normalizeThinkingKey(safeOpts.thinkingLevel, safeOpts.modelName || '');
  const convoId = asStr(safeOpts.convoId, 96).trim() || 'default';
  const tokens = Math.max(0, Math.round(Number(safeOpts.tokens) || 0));

  let count = 0;
  withFileLockSync(quotaFile, () => {
    const doc = safeReadJsonSync(quotaFile, () => ({ samples: [] }), { selfHeal: false });
    const prev = Array.isArray(doc?.samples) ? doc.samples : [];
    const cutoff = nowMs - 2 * 60 * 60 * 1000;
    const kept = prev.filter((s) => s && typeof s.ts === 'number' && s.ts >= cutoff);
    const entry = thinkingLevel ? { ts: nowMs, tier, thinkingLevel, convoId, tokens } : { ts: nowMs, tier, convoId, tokens };
    kept.push(entry);
    const bounded = kept.slice(-240);
    count = bounded.length;
    atomicWriteJsonSync(quotaFile, { samples: bounded });
  });
  return { ok: true, samplesCount: count };
}

/**
 * Рассчитывает темп расхода квоты за последние 30 и 60 минут и формирует прогноз/совет на русском.
 * @param {Array<object>|null} [eventsOrSamples=null]
 * @param {object} [state={}]
 * @returns {object}
 */
export function computeQuotaBurnForecast(eventsOrSamples = null, state = {}) {
  const safeState = asObj(state);
  const nowMs = Number.isFinite(Number(safeState.nowMs)) ? Number(safeState.nowMs) : Date.now();
  let samples = [];

  if (Array.isArray(eventsOrSamples)) {
    samples = eventsOrSamples;
  } else {
    const baseCache = asStr(safeState.cacheDir, 1024).trim()
      ? resolve(asStr(safeState.cacheDir, 1024).trim())
      : DEFAULT_CACHE_DIR;
    const qFile = join(baseCache, 'quota-pacer.json');
    if (existsSync(qFile)) {
      const doc = safeReadJsonSync(qFile, () => ({ samples: [] }), { selfHeal: false });
      samples = Array.isArray(doc?.samples) ? doc.samples : [];
    }
  }

  const win30Start = nowMs - 30 * 60 * 1000;
  const win60Start = nowMs - 60 * 60 * 1000;
  let turnsLast30m = 0;
  let turnsLast60m = 0;
  let weight30m = 0;
  let weight60m = 0;
  const tierCounts = new Map();

  for (const raw of samples) {
    if (!raw || typeof raw !== 'object') continue;
    const ts = Number(raw.ts || 0);
    if (!Number.isFinite(ts) || ts < win60Start || ts > nowMs + 60_000) continue;
    const rawRef = raw.tier || raw.modelTier || raw.modelName || 'hydrogen';
    const tierKey = normalizeTierKey(rawRef);
    const thinkingKey = normalizeThinkingKey(raw.thinkingLevel, raw.modelName || '');
    const mult = thinkingKey && Object.hasOwn(THINKING_MULTIPLIERS, thinkingKey) ? THINKING_MULTIPLIERS[thinkingKey] : 1.0;
    const weight = (TIER_WEIGHTS[tierKey] || TIER_WEIGHTS.unknown) * mult;
    turnsLast60m += 1;
    weight60m += weight;
    tierCounts.set(tierKey, (tierCounts.get(tierKey) || 0) + 1);
    if (ts >= win30Start) {
      turnsLast30m += 1;
      weight30m += weight;
    }
  }

  let dominantTier = 'hydrogen';
  let topCnt = 0;
  for (const [k, cnt] of tierCounts.entries()) {
    if (cnt > topCnt) {
      topCnt = cnt;
      dominantTier = k;
    }
  }

  const isUltra = safeState.subscriptionTier === 'ultra';
  const hourlyCeiling = isUltra ? 95 : 38;
  const burnRatePerHour = Number(Math.max(weight60m, weight30m * 1.85).toFixed(1));
  const utilizationPct = Math.min(100, Math.round((burnRatePerHour / hourlyCeiling) * 100));

  let status = 'calm';
  if (utilizationPct >= 75 || weight30m >= hourlyCeiling * 0.52) {
    status = 'critical';
  } else if (utilizationPct >= 42 || weight30m >= hourlyCeiling * 0.28) {
    status = 'elevated';
  }

  const remainingBudget = Math.max(0, hourlyCeiling - weight60m);
  const estimatedMinutesLeft = burnRatePerHour > 0
    ? Math.max(5, Math.min(360, Math.round((remainingBudget / burnRatePerHour) * 60)))
    : 240;

  let recommendationRu = 'Темп квоты спокойный — можно работать в обычном режиме.';
  if (status === 'critical') {
    recommendationRu = isUltra
      ? 'Высокий темп расхода: перенесите рутинные S/M правки на Hydrogen или паузы между тяжёлыми прогонами.'
      : 'Критический темп расхода на Pro: переключите рутину S/M на Hydrogen / Orchestrator (Neon), чтобы сберечь лимит.';
  } else if (status === 'elevated') {
    recommendationRu = isUltra
      ? 'Повышенный темп: Orchestrator (Carbon) экономит квоту на правках за счёт авто-передачи на Hydrogen.'
      : 'Повышенный темп квоты: для мелких правок лучше использовать Hydrogen вместо ручного Neon/Carbon.';
  }

  return {
    ok: true,
    status,
    turnsLast30m,
    turnsLast60m,
    burnRatePerHour,
    utilizationPct,
    estimatedMinutesLeft,
    dominantTier,
    subscriptionTier: isUltra ? 'ultra' : 'pro',
    recommendationRu,
  };
}

/**
 * Проверяет неизменность статического префикса диалога (Gemini 4 `>=4096` Implicit Cache Floor)
 * и отсутствие динамических меток времени внутри статической головы.
 * @param {object} [opts={}]
 * @returns {object}
 */
export function auditPrefixStability(opts = {}) {
  if (!opts || typeof opts !== 'object' || Array.isArray(opts)) {
    return { ok: false, stable: false, error: 'Некорректные параметры auditPrefixStability' };
  }
  const safeOpts = asObj(opts);
  const rawConvo = asStr(safeOpts.convoId, 96).trim();
  const convoId = rawConvo || 'default';
  if (BLOCKED_KEYS.has(convoId)) {
    return { ok: false, stable: false, error: 'Некорректный convoId' };
  }
  const staticPrefix = asStr(safeOpts.staticPrefix, 24_000);
  const dynamicTail = asStr(safeOpts.dynamicTail, 24_000);
  const prefixHash = createHash('sha1').update(staticPrefix).digest('hex').slice(0, 16);
  const hasVolatileLeak = /\b\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}:\d{2}|\b(?:updated|timestamp)\s*:\s*\d{6,}/i.test(staticPrefix);

  const { prefixFile } = resolveCachePaths(safeOpts.cacheDir);
  let drifted = false;
  let streakTurns = 1;
  let driftCount = 0;

  withFileLockSync(prefixFile, () => {
    const doc = safeReadJsonSync(prefixFile, () => ({ convos: {} }), { selfHeal: false });
    const convos = doc?.convos && typeof doc.convos === 'object' ? { ...doc.convos } : {};
    const now = Date.now();
    for (const [k, v] of Object.entries(convos)) {
      if (!v || (v.ts && now - v.ts > 6 * 60 * 60 * 1000)) delete convos[k];
    }
    const prev = Object.hasOwn(convos, convoId) ? convos[convoId] : null;
    if (prev && prev.hash && prev.hash !== prefixHash) {
      drifted = true;
      streakTurns = 1;
      driftCount = Number(prev.driftCount || 0) + 1;
    } else if (prev) {
      streakTurns = Number(prev.streakTurns || 0) + 1;
      driftCount = Number(prev.driftCount || 0);
    }
    convos[convoId] = { hash: prefixHash, streakTurns, driftCount, ts: now };
    atomicWriteJsonSync(prefixFile, { convos });
  });

  const stable = !drifted && !hasVolatileLeak;
  let warningEn = '';
  if (hasVolatileLeak) {
    warningEn = 'Static prefix contains volatile timestamp/counter; move dynamic values to tail to preserve Implicit Cache.';
  } else if (drifted) {
    warningEn = `Static prefix hash drifted (drift #${driftCount}); keep head block immutable across turns.`;
  }

  return {
    ok: true,
    stable,
    drifted,
    hasVolatileLeak,
    prefixHash,
    prefixChars: staticPrefix.length,
    tailChars: dynamicTail.length,
    streakTurns,
    driftCount,
    warningEn,
  };
}

/**
 * Records a temporary cooldown for a model/provider that hit HTTP 429 or quota exhaustion (OmniRoute Combo pattern).
 */
export function recordComboProviderCooldown(opts = {}) {
  const {
    modelOrTier = '',
    reason = 'quota_429',
    cooldownMs = 15 * 60 * 1000,
    cacheDir = '',
    nowMs = Date.now(),
  } = asObj(opts);
  const modelKey = asStr(modelOrTier, 96).trim().toLowerCase();
  if (!modelKey || BLOCKED_KEYS.has(modelKey)) {
    return { ok: false, error: 'invalid_model_key' };
  }
  const safeNow = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  const safeCooldownMs = Math.max(1000, Math.min(24 * 60 * 60 * 1000, Number(cooldownMs) || 15 * 60 * 1000));
  const until = safeNow + safeCooldownMs;
  const cleanReason = asStr(reason, 64).trim() || 'quota_429';
  const { comboFile } = resolveCachePaths(cacheDir);

  withFileLockSync(comboFile, () => {
    const doc = safeReadJsonSync(comboFile, () => ({ cooldowns: {} }), { selfHeal: false });
    const next = {};
    for (const [k, v] of Object.entries(doc?.cooldowns && typeof doc.cooldowns === 'object' ? doc.cooldowns : {})) {
      if (!k || BLOCKED_KEYS.has(k) || !v || Number(v.until || 0) <= safeNow) continue;
      next[k] = v;
    }
    next[modelKey] = { model: modelKey, reason: cleanReason, hitAt: safeNow, until };
    atomicWriteJsonSync(comboFile, { cooldowns: next });
  });

  return { ok: true, model: modelKey, reason: cleanReason, hitAt: safeNow, until, cooldownMs: safeCooldownMs };
}

/**
 * Clears expired (or all, when resetAll=true) provider cooldown entries.
 */
export function clearExpiredComboCooldowns({ cacheDir = '', nowMs = Date.now(), resetAll = false } = {}) {
  const safeNow = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  const { comboFile } = resolveCachePaths(cacheDir);
  if (!existsSync(comboFile)) {
    return { ok: true, activeCooldowns: [], clearedCount: 0 };
  }

  let clearedCount = 0;
  let activeCooldowns = [];
  withFileLockSync(comboFile, () => {
    const doc = safeReadJsonSync(comboFile, () => ({ cooldowns: {} }), { selfHeal: false });
    const prev = doc?.cooldowns && typeof doc.cooldowns === 'object' ? doc.cooldowns : {};
    const next = {};
    for (const [k, v] of Object.entries(prev)) {
      if (!k || BLOCKED_KEYS.has(k) || !v) continue;
      if (resetAll || Number(v.until || 0) <= safeNow) {
        clearedCount += 1;
      } else {
        next[k] = v;
      }
    }
    activeCooldowns = Object.values(next);
    atomicWriteJsonSync(comboFile, { cooldowns: next });
  });

  return { ok: true, activeCooldowns, clearedCount };
}

/**
 * Resolves the highest-priority healthy model in an ordered failover combo chain.
 */
export function resolveComboFailoverTarget(opts = {}) {
  const {
    combo = 'daily_coding',
    customChain = null,
    cacheDir = '',
    nowMs = Date.now(),
    localGpuAvailable = false,
    subscriptionTier = '',
  } = asObj(opts);
  const safeNow = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  const comboName = asStr(combo, 48).trim() || 'daily_coding';
  const isProSub = asStr(subscriptionTier, 16).trim().toLowerCase() === 'pro';
  const rawChain = Array.isArray(customChain) && customChain.length > 0
    ? customChain.map((m) => asStr(m, 96).trim()).filter(Boolean)
    : (Object.hasOwn(DEFAULT_COMBO_CHAINS, comboName) ? [...DEFAULT_COMBO_CHAINS[comboName]] : [...DEFAULT_COMBO_CHAINS.daily_coding]);
  const filteredChain = isProSub ? rawChain.filter((c) => !c.toLowerCase().includes('carbon')) : rawChain;
  const chain = filteredChain.length > 0 ? filteredChain : ['gemini-4-neon-high', 'gemini-4-hydrogen-medium'];

  const baseCache = asStr(cacheDir, 1024).trim() ? resolve(asStr(cacheDir, 1024).trim()) : getDefaultCacheDir();
  const comboFile = join(baseCache, 'combo-cooldowns.json');
  const activeMap = new Map();

  if (existsSync(comboFile)) {
    const doc = safeReadJsonSync(comboFile, () => ({ cooldowns: {} }), { selfHeal: false });
    for (const [k, v] of Object.entries(doc?.cooldowns && typeof doc.cooldowns === 'object' ? doc.cooldowns : {})) {
      if (k && !BLOCKED_KEYS.has(k) && v && Number(v.until || 0) > safeNow) {
        activeMap.set(k.toLowerCase(), v);
      }
    }
  }

  const skippedOnCooldown = [];
  let selected = '';
  for (const candidate of chain) {
    const low = candidate.toLowerCase();
    if (low === 'local_ollama' && !localGpuAvailable) {
      continue;
    }
    const tierKey = normalizeTierKey(low);
    const hit = activeMap.get(low) || (tierKey !== 'unknown' ? activeMap.get(tierKey) : null);
    if (hit) {
      skippedOnCooldown.push({ model: candidate, reason: hit.reason || 'quota_429', until: hit.until });
      continue;
    }
    selected = candidate;
    break;
  }

  const allExhausted = !selected;
  const localOfflineFallback = allExhausted && localGpuAvailable ? 'local_ollama' : '';
  if (allExhausted) {
    const firstCloud = chain.find((c) => c.toLowerCase() !== 'local_ollama');
    selected = localOfflineFallback || firstCloud || chain[0] || 'gemini-4-hydrogen-medium';
  }

  return {
    ok: true,
    combo: comboName,
    selected,
    chain,
    skippedOnCooldown,
    activeCooldowns: Array.from(activeMap.values()),
    allExhausted,
    localOfflineFallback,
  };
}

/**
 * Stateless Per-Turn Effort Pinning (OmniRoute `adaptiveEffort.ts` / Hermes pattern).
 * Resolves `low | medium | high` strictly from turn-entry signals (before mid-turn tool results)
 * so reasoning depth never flips mid-loop and never invalidates prompt prefix caches.
 */
export function resolveStatelessTurnEffort(opts = {}) {
  const {
    userChars = 0,
    estimatedContextTokens = 0,
    priorToolResultsCount = 0,
    explicitEffort = '',
  } = asObj(opts);
  const explicitKey = normalizeThinkingKey(explicitEffort);
  if (explicitKey) {
    return { effort: explicitKey, pinnedStateless: true, source: 'explicit' };
  }
  const uChars = Math.max(0, Number(userChars) || 0);
  const ctxTok = Math.max(0, Number(estimatedContextTokens) || 0);
  const priorTools = Math.max(0, Number(priorToolResultsCount) || 0);

  if (uChars <= 160 && ctxTok <= 4000 && priorTools === 0) {
    return { effort: 'low', pinnedStateless: true, source: 'stateless_trivial_band' };
  }
  if (ctxTok >= 60000 || priorTools >= 6 || uChars >= 4000) {
    return { effort: 'high', pinnedStateless: true, source: 'stateless_heavy_band' };
  }
  return { effort: 'medium', pinnedStateless: true, source: 'stateless_balanced_band' };
}

/**
 * Evaluates Implicit Prompt Cache warmth & TTL countdown (Caveman v4 `Waste fixes` pattern).
 */
export function computeCacheWarmthStatus(opts = {}) {
  const safeOpts = asObj(opts);
  const convoId = asStr(safeOpts.convoId, 96).trim() || 'default';
  const safeNow = Number.isFinite(Number(safeOpts.nowMs)) ? Number(safeOpts.nowMs) : Date.now();
  const ttlMs = Math.max(30_000, Number(safeOpts.ttlMs) || 5 * 60 * 1000);
  const { prefixFile } = resolveCachePaths(safeOpts.cacheDir);

  if (!existsSync(prefixFile)) {
    return { ok: true, status: 'cold', remainingSeconds: 0, streakTurns: 0, driftCount: 0 };
  }
  const doc = safeReadJsonSync(prefixFile, () => ({ convos: {} }), { selfHeal: false });
  const convos = doc?.convos && typeof doc.convos === 'object' ? doc.convos : {};
  let entry = Object.hasOwn(convos, convoId) ? convos[convoId] : null;
  if (!entry && convoId === 'default') {
    const newest = Object.values(convos)
      .filter((v) => v && Number.isFinite(Number(v.ts)))
      .sort((a, b) => Number(b.ts) - Number(a.ts))[0];
    if (newest) entry = newest;
  }
  if (!entry || !entry.ts) {
    return { ok: true, status: 'cold', remainingSeconds: 0, streakTurns: 0, driftCount: 0 };
  }
  const elapsedMs = Math.max(0, safeNow - Number(entry.ts));
  const remainingMs = Math.max(0, ttlMs - elapsedMs);
  const remainingSeconds = Math.round(remainingMs / 1000);
  const status = remainingSeconds <= 0 ? 'cold' : remainingSeconds <= 60 ? 'cooling' : 'warm';

  return {
    ok: true,
    status,
    remainingSeconds,
    streakTurns: Number(entry.streakTurns || 0),
    driftCount: Number(entry.driftCount || 0),
    prefixHash: String(entry.hash || ''),
  };
}

/**
 * Composite Score-Driven Combo Router (OmniRoute auto-score + Quota Family + Cache-Warmth affinity).
 */
export function resolveScoreDrivenComboTarget(opts = {}) {
  const {
    combo = 'daily_coding',
    customChain = null,
    cacheDir = '',
    nowMs = Date.now(),
    localGpuAvailable = false,
    subscriptionTier = '',
    warmTier = '',
    domainScores = {},
  } = asObj(opts);
  const base = resolveComboFailoverTarget({
    combo,
    customChain,
    cacheDir,
    nowMs,
    localGpuAvailable,
    subscriptionTier,
  });
  const cooledSet = new Set(base.skippedOnCooldown.map((s) => s.model.toLowerCase()));
  const warmKey = normalizeTierKey(warmTier);
  const cooledFamilies = new Set(base.skippedOnCooldown.map((s) => normalizeTierKey(s.model)).filter((k) => k !== 'unknown'));

  const scored = base.chain
    .filter((m) => m.toLowerCase() !== 'local_ollama' || localGpuAvailable)
    .map((model, idx) => {
      const low = model.toLowerCase();
      const tier = normalizeTierKey(low);
      const onCooldown = cooledSet.has(low);
      const siblingFamilyCooled = !onCooldown && tier !== 'unknown' && cooledFamilies.has(tier);
      const priorityBase = Math.max(0.1, 1.0 - idx * 0.14);
      const cacheAffinityBonus = warmKey && warmKey !== 'unknown' && tier === warmKey ? 0.22 : 0;
      const domainRel = Number.isFinite(Number(domainScores?.[tier])) ? Number(domainScores[tier]) * 0.2 : 0;
      const familyPenalty = siblingFamilyCooled ? 0.35 : 0;
      const cooldownPenalty = onCooldown ? 2.0 : 0;
      const score = Number((priorityBase + cacheAffinityBonus + domainRel - familyPenalty - cooldownPenalty).toFixed(3));
      return { model, tier, score, onCooldown, siblingFamilyCooled };
    })
    .sort((a, b) => b.score - a.score);

  return {
    ...base,
    selected: scored[0]?.model || base.selected,
    scoredCandidates: scored,
  };
}

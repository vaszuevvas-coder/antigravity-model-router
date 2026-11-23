/**
 * @file model-profile.mjs
 * @description Детектор активной модели сессии Antigravity (Gemini 4 Carbon / Neon / Argon / Hydrogen,
 * режимы Orchestrator Carbon / Neon / Argon и Gemini 3.8 Flash) и адаптивных порогов контекстного окна 1M (Implicit Cache -95%).
 */

import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const LEGACY_DEFAULT_COMPACTION_THRESHOLD = 120_000;
export const GEMINI4_DEFAULT_COMPACTION_THRESHOLD = 250_000;
export const GEMINI4_IMPLICIT_CACHE_MIN_TOKENS = 4_096;
export const GEMINI4_MULTI_TURN_DELTA_TOKENS = 2_050;

export const LEGACY_REPOMAP_MAX_CHARS = 4_000;
export const GEMINI4_REPOMAP_MAX_CHARS = 12_000; // ~3k токенов -> вместе с правилами пробивает порог 4096 токенов Implicit Cache (-95% на Hydrogen/Neon/Carbon/Argon)
export const GEMINI4_MAX_ADAPTIVE_REPOMAP_CHARS = 18_000; // Потолок добора карты на старте, если handoff/pitfalls короткие

export const GEMINI4_PRICING_META = {
  promoEndIso: '2026-12-01T00:00:00Z',
  hydrogen: { inputPer1M: 1.5, outputPer1M: 7.5, batchInputPer1M: 0.75, batchOutputPer1M: 3.75, cachedInputPer1M: 0.075, indexHigh: 51, indexXHigh: 54 },
  neon: { inputPer1M: 3.0, outputPer1M: 15.0, batchInputPer1M: 1.5, batchOutputPer1M: 7.5, cachedInputPer1M: 0.15, indexXHigh: 61 },
  argon: { promoInputPer1M: 2.0, promoOutputPer1M: 10.0, postInputPer1M: 4.0, postOutputPer1M: 20.0, indexBaseline: 50 },
  carbon: { promoInputPer1M: 2.0, promoOutputPer1M: 10.0, postInputPer1M: 4.0, postOutputPer1M: 20.0, indexV5: 59 },
};

export const LEGACY_READ_DEDUP_WINDOW_MS = 3 * 60 * 1000;
export const GEMINI4_READ_DEDUP_WINDOW_MS = 25 * 60 * 1000; // 25 минут под окно 1M (Carbon / Argon / Hydrogen)
export const ORCHESTRATOR_READ_DEDUP_WINDOW_MS = 30 * 60 * 1000; // 30 минут под двусторонние переходы Планировщик <-> Hydrogen
export const LEGACY_READ_DEDUP_STEP_GAP = 18;
export const GEMINI4_READ_DEDUP_STEP_GAP = 45;
export const ORCHESTRATOR_READ_DEDUP_STEP_GAP = 55;

const THINKING_LEVEL_RU_MAP = {
  xhigh: 'XHigh',
  high: 'Высокий',
  medium: 'Средний',
  low: 'Низкий',
};

const THINKING_LEVEL_EN_MAP = {
  xhigh: 'XHigh',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

function formatThinkingSuffixEn(thinkingLevel) {
  if (!thinkingLevel) return '';
  if (thinkingLevel === 'xhigh') return ' (XHigh)';
  return ` (${thinkingLevel[0].toUpperCase()}${thinkingLevel.slice(1)})`;
}

/**
 * Распознаёт уровень мышления из английских/русских названий и внутренних slug-идентификаторов (включая XHigh).
 * @param {string} lower
 * @returns {'xhigh'|'high'|'medium'|'low'|null}
 */
function parseThinkingLevel(lower = '') {
  if (!lower) return null;
  if (
    /(?:^|[^a-zа-яё])(xhigh|x-high|extra[\s_-]*high|extra|max|сверхвысокий|максимальный)(?=$|[^a-zа-яё])/i.test(lower)
  ) {
    return 'xhigh';
  }
  if (/(?:^|[^a-zа-яё])(high|высокий)(?=$|[^a-zа-яё])/i.test(lower)) {
    return 'high';
  }
  if (/(?:^|[^a-zа-яё])(medium|средний)(?=$|[^a-zа-яё])/i.test(lower)) {
    return 'medium';
  }
  if (/(?:^|[^a-zа-яё])(low|minimal|низкий|минимальный)(?=$|[^a-zа-яё])/i.test(lower)) {
    return 'low';
  }
  return null;
}

/**
 * Нормализует сырое имя модели (например, "Gemini 4 Neon (High)", "Orchestrator (Neon)",
 * "Оркестратор Gemini 4 Neon Extra High", "Orchestrator Gemini 4 Carbon High", "gemini-pro-orchestrator-argon") в структурный профиль.
 * @param {string} [rawModelName='']
 */
export function normalizeModelProfile(rawModelName = '') {
  const raw = String(rawModelName || '').trim();
  const lower = raw.toLowerCase();

  const thinkingLevel = parseThinkingLevel(lower);
  const thinkingLevelRu = thinkingLevel ? THINKING_LEVEL_RU_MAP[thinkingLevel] || null : null;
  const thinkingLevelEn = thinkingLevel ? THINKING_LEVEL_EN_MAP[thinkingLevel] || null : null;
  const suffix = formatThinkingSuffixEn(thinkingLevel);
  const suffixRu = thinkingLevelRu ? ` · ${thinkingLevelRu}` : '';
  const suffixEn = thinkingLevelEn ? ` · ${thinkingLevelEn}` : '';

  // 1. Штатные мульти-модельные режимы Antigravity Orchestrator (Планировщик Neon/Carbon/Argon с выбором глубины <-> Исполнитель Hydrogen)
  if (lower.includes('orchestrator') || lower.includes('оркестратор')) {
    const isNeonOrch = lower.includes('neon') || lower.includes('неон');
    const isArgonOrch = !isNeonOrch && (lower.includes('argon') || lower.includes('аргон'));
    const plannerName = isNeonOrch ? 'Neon' : (isArgonOrch ? 'Argon' : 'Carbon');
    const orchLevelEn = thinkingLevel
      ? (thinkingLevel === 'xhigh' ? 'XHigh' : `${thinkingLevel[0].toUpperCase()}${thinkingLevel.slice(1)}`)
      : '';
    return {
      id: isNeonOrch ? 'gemini-orchestrator-neon' : (isArgonOrch ? 'gemini-orchestrator-argon' : 'gemini-orchestrator-carbon'),
      rawName: raw,
      label: orchLevelEn ? `Orchestrator (${plannerName} · ${orchLevelEn})` : `Orchestrator (${plannerName})`,
      shortLabel: orchLevelEn ? `Orch (${plannerName} · ${orchLevelEn})` : `Orch (${plannerName})`,
      displayRu: thinkingLevelRu ? `Оркестратор · ${plannerName} · ${thinkingLevelRu}` : `Оркестратор · ${plannerName}`,
      displayEn: thinkingLevelEn ? `Orchestrator · ${plannerName} · ${thinkingLevelEn}` : `Orchestrator · ${plannerName}`,
      tier: isNeonOrch ? 'orchestrator_neon' : (isArgonOrch ? 'orchestrator_argon' : 'orchestrator_carbon'),
      plannerTier: isNeonOrch ? 'neon' : (isArgonOrch ? 'argon' : 'carbon'),
      executorTier: 'hydrogen',
      thinkingLevel,
      thinkingLevelRu: thinkingLevelRu || 'Авто',
      thinkingLevelEn: thinkingLevelEn || 'Auto',
      isOrchestrator: true,
      isCarbon: false,
      isArgon: false,
      isHydrogen: false,
      isNeon: false,
      isGemini4: true,
      isFlash: false,
      contextWindowTokens: 1_000_000,
      defaultCompactionThreshold: GEMINI4_DEFAULT_COMPACTION_THRESHOLD,
    };
  }

  // 2. Gemini 4 Hydrogen — высокоскоростной исполнительный движок 1M (Low / Medium / High / XHigh)
  if (lower.includes('hydrogen') || lower.includes('водород')) {
    return {
      id: 'gemini-4-hydrogen',
      rawName: raw,
      label: `Gemini 4 Hydrogen${suffix}`,
      shortLabel: `Hydrogen${suffix}`,
      displayRu: `Hydrogen${suffixRu}`,
      displayEn: `Hydrogen${suffixEn}`,
      tier: 'hydrogen',
      plannerTier: null,
      executorTier: 'hydrogen',
      thinkingLevel,
      thinkingLevelRu,
      thinkingLevelEn,
      isOrchestrator: false,
      isCarbon: false,
      isArgon: false,
      isHydrogen: true,
      isNeon: false,
      isGemini4: true,
      isFlash: false,
      contextWindowTokens: 1_000_000,
      defaultCompactionThreshold: GEMINI4_DEFAULT_COMPACTION_THRESHOLD,
    };
  }

  // 3. Gemini 4 Neon — сбалансированная frontier-модель для кодинга и агентов 1M (Low / Medium / High / XHigh)
  if (lower.includes('neon') || lower.includes('неон')) {
    return {
      id: 'gemini-4-neon',
      rawName: raw,
      label: `Gemini 4 Neon${suffix}`,
      shortLabel: `Neon${suffix}`,
      displayRu: `Neon${suffixRu}`,
      displayEn: `Neon${suffixEn}`,
      tier: 'neon',
      plannerTier: 'neon',
      executorTier: 'neon',
      thinkingLevel,
      thinkingLevelRu,
      thinkingLevelEn,
      isOrchestrator: false,
      isCarbon: false,
      isArgon: false,
      isHydrogen: false,
      isNeon: true,
      isGemini4: true,
      isFlash: false,
      contextWindowTokens: 1_000_000,
      defaultCompactionThreshold: GEMINI4_DEFAULT_COMPACTION_THRESHOLD,
    };
  }

  // 4. Gemini 4 Carbon — флагманский глубокий архитектор и аудитор 1M
  if (lower.includes('carbon') || lower.includes('карбон')) {
    return {
      id: 'gemini-4-carbon',
      rawName: raw,
      label: `Gemini 4 Carbon${suffix}`,
      shortLabel: `Carbon${suffix}`,
      displayRu: `Carbon${suffixRu}`,
      displayEn: `Carbon${suffixEn}`,
      tier: 'carbon',
      plannerTier: 'carbon',
      executorTier: null,
      thinkingLevel,
      thinkingLevelRu,
      thinkingLevelEn,
      isOrchestrator: false,
      isCarbon: true,
      isArgon: false,
      isHydrogen: false,
      isNeon: false,
      isGemini4: true,
      isFlash: false,
      contextWindowTokens: 1_000_000,
      defaultCompactionThreshold: GEMINI4_DEFAULT_COMPACTION_THRESHOLD,
    };
  }

  // 5. Gemini 4 Argon — сбалансированная рассуждающая модель 1M
  if (lower.includes('argon') || lower.includes('аргон') || lower.includes('gemini 4 pro') || lower.includes('gemini-4-pro')) {
    return {
      id: 'gemini-4-argon',
      rawName: raw,
      label: `Gemini 4 Argon${suffix}`,
      shortLabel: `Argon${suffix}`,
      displayRu: `Argon${suffixRu}`,
      displayEn: `Argon${suffixEn}`,
      tier: 'argon',
      plannerTier: 'argon',
      executorTier: null,
      thinkingLevel,
      thinkingLevelRu,
      thinkingLevelEn,
      isOrchestrator: false,
      isCarbon: false,
      isArgon: true,
      isHydrogen: false,
      isNeon: false,
      isGemini4: true,
      isFlash: false,
      contextWindowTokens: 1_000_000,
      defaultCompactionThreshold: GEMINI4_DEFAULT_COMPACTION_THRESHOLD,
    };
  }

  // 6. Gemini Flash-Lite (разведка и быстрые чтения)
  if (lower.includes('flash_lite') || lower.includes('flash-lite') || lower.includes('flash lite')) {
    return {
      id: 'gemini-flash-lite',
      rawName: raw,
      label: 'Gemini Flash-Lite',
      shortLabel: 'Flash-Lite',
      displayRu: 'Flash-Lite',
      displayEn: 'Flash-Lite',
      tier: 'flash_lite',
      plannerTier: null,
      executorTier: 'flash_lite',
      thinkingLevel,
      thinkingLevelRu,
      thinkingLevelEn,
      isOrchestrator: false,
      isCarbon: false,
      isArgon: false,
      isHydrogen: false,
      isNeon: false,
      isGemini4: lower.includes('4'),
      isFlash: true,
      contextWindowTokens: 1_000_000,
      defaultCompactionThreshold: LEGACY_DEFAULT_COMPACTION_THRESHOLD,
    };
  }

  // 7. Gemini 3.8 Flash / Gemini Flash (с поддержкой версии 3.8 и уровней мышления)
  if (lower.includes('flash')) {
    const is38 = lower.includes('3.8') || lower.includes('3-8');
    const isG4 = !is38 && lower.includes('4');
    const baseLabel = is38 ? 'Gemini 3.8 Flash' : (isG4 ? 'Gemini 4 Flash' : 'Gemini Flash');
    const baseShort = is38 ? 'Flash 3.8' : 'Flash';
    return {
      id: is38 ? 'gemini-3.8-flash' : 'gemini-flash',
      rawName: raw,
      label: `${baseLabel}${suffix}`,
      shortLabel: `${baseShort}${suffix}`,
      displayRu: `${baseShort}${suffixRu}`,
      displayEn: `${baseShort}${suffixEn}`,
      tier: 'flash',
      plannerTier: null,
      executorTier: 'flash',
      thinkingLevel,
      thinkingLevelRu,
      thinkingLevelEn,
      isOrchestrator: false,
      isCarbon: false,
      isArgon: false,
      isHydrogen: false,
      isNeon: false,
      isGemini4: isG4,
      isFlash: true,
      contextWindowTokens: 1_000_000,
      defaultCompactionThreshold: LEGACY_DEFAULT_COMPACTION_THRESHOLD,
    };
  }

  if (raw && lower !== 'none' && lower !== 'inherit' && lower !== 'auto') {
    const isG4 = lower.includes('gemini 4') || lower.includes('gemini-4');
    const isGemini = isG4 || lower.includes('gemini');
    return {
      id: lower.replace(/[^a-z0-9._-]+/g, '-').replace(/^-|-$/g, '') || 'pro',
      rawName: raw,
      label: raw.slice(0, 40),
      shortLabel: raw.slice(0, 22),
      displayRu: raw.slice(0, 26),
      displayEn: raw.slice(0, 26),
      tier: 'pro',
      plannerTier: 'pro',
      executorTier: null,
      thinkingLevel,
      thinkingLevelRu,
      thinkingLevelEn,
      isOrchestrator: false,
      isCarbon: false,
      isArgon: false,
      isHydrogen: false,
      isNeon: false,
      isGemini4: isG4,
      isFlash: false,
      contextWindowTokens: isGemini ? 1_000_000 : 200_000,
      defaultCompactionThreshold: isG4 ? GEMINI4_DEFAULT_COMPACTION_THRESHOLD : LEGACY_DEFAULT_COMPACTION_THRESHOLD,
    };
  }

  return {
    id: 'unknown',
    rawName: '',
    label: '',
    shortLabel: '',
    displayRu: '',
    displayEn: '',
    tier: 'unknown',
    plannerTier: null,
    executorTier: null,
    thinkingLevel: null,
    thinkingLevelRu: null,
    thinkingLevelEn: null,
    isOrchestrator: false,
    isCarbon: false,
    isArgon: false,
    isHydrogen: false,
    isNeon: false,
    isGemini4: false,
    isFlash: false,
    contextWindowTokens: 1_000_000,
    defaultCompactionThreshold: LEGACY_DEFAULT_COMPACTION_THRESHOLD,
  };
}

/**
 * Извлекает последнее переключение `Model Selection` из блока `<USER_SETTINGS_CHANGE>` в тексте или JSONL.
 * Корректно сохраняет точки внутри версий моделей (например, `Gemini 3.8 Flash`, `Claude Opus 4.6`).
 * @param {string} [text='']
 * @returns {string} Найденное название модели или пустая строка.
 */
export function extractModelSelectionFromText(text = '') {
  if (!text || typeof text !== 'string') return '';
  if (!text.includes('Model Selection') && !text.includes('USER_SETTINGS_CHANGE')) return '';

  const pattern =
    /changed setting\s+`?Model Selection`?\s+from\s+.+?\s+to\s+([^\r\n<]+?)(?:\.\s+No need|\.\s*<\/USER_SETTINGS_CHANGE>|<\/USER_SETTINGS_CHANGE>|\r|\n|$)/gi;
  let lastModel = '';
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const candidate = String(match[1] || '')
      .replace(/\\n/g, '')
      .replace(/`/g, '')
      .replace(/\.\s*$/, '')
      .trim();
    if (candidate && candidate.toLowerCase() !== 'none') {
      lastModel = candidate;
    }
  }
  return lastModel;
}

/**
 * Сверхбыстро (< 0.3 мс) проверяет начало и хвост transcript.jsonl на наличие активной модели.
 * Не загружает большие транскрипты целиком в память.
 * @param {string} [transcriptPath='']
 * @param {string} [conversationId='']
 * @returns {ReturnType<typeof normalizeModelProfile>}
 */
const transcriptProfileCache = new Map();
const TRANSCRIPT_PROFILE_CACHE_MAX = 32;
const MAX_MODEL_TAIL_SCAN_BYTES = 512 * 1024;
const MAX_MODEL_HEAD_FALLBACK_BYTES = 64 * 1024;

function setTranscriptProfileCache(cacheKey, st, profile, annPlanExecute = null) {
  if (!cacheKey || !st) return profile;
  if (transcriptProfileCache.has(cacheKey)) {
    transcriptProfileCache.delete(cacheKey);
  } else if (transcriptProfileCache.size >= TRANSCRIPT_PROFILE_CACHE_MAX) {
    const oldestKey = transcriptProfileCache.keys().next().value;
    if (oldestKey !== undefined) transcriptProfileCache.delete(oldestKey);
  }
  transcriptProfileCache.set(cacheKey, {
    size: st.size,
    mtimeMs: st.mtimeMs,
    annPlanExecute,
    profile: { ...profile },
  });
  return profile;
}

const subagentMetaCache = new Map();
const SUBAGENT_META_CACHE_MAX = 128;
const MAX_SUBAGENT_HEAD_BYTES = 64 * 1024;

function setSubagentMetaCache(cacheKey, entry) {
  if (!cacheKey) return entry;
  if (subagentMetaCache.has(cacheKey)) {
    subagentMetaCache.delete(cacheKey);
  } else if (subagentMetaCache.size >= SUBAGENT_META_CACHE_MAX) {
    const oldestKey = subagentMetaCache.keys().next().value;
    if (oldestKey !== undefined) subagentMetaCache.delete(oldestKey);
  }
  subagentMetaCache.set(cacheKey, entry);
  return entry;
}

function extractShortHintFromSubagentMessage(content = '') {
  const msgIdx = content.indexOf('content=');
  const body = msgIdx >= 0 ? content.slice(msgIdx + 8) : content;
  const clean = body
    .replace(/<\/?[A-Z_]+>/g, ' ')
    .replace(/\[Message\][^\n]*?\bcontent=/i, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return '';
  const backtickFile = clean.match(/`([^`\n]{2,48}\.[a-z0-9]{1,6})`/i);
  if (backtickFile) {
    const base = backtickFile[1].split(/[\\/]/).pop();
    if (base) return base;
  }
  return '';
}

/**
 * Inspects up to 64 KB of a transcript header (skipping large SessionStart Repo Maps)
 * to determine whether the conversation is a subagent or Swarm worker and extract its parent conversationId.
 * @param {string} filePath
 * @returns {{ isSubagent: boolean, parentConversationId: string, agentKind: ''|'subagent'|'swarm_worker', agentHint: string }}
 */
export function inspectSubagentTranscriptMeta(filePath) {
  const empty = { isSubagent: false, parentConversationId: '', agentKind: '', agentHint: '' };
  if (!filePath || typeof filePath !== 'string' || !existsSync(filePath)) return empty;
  let fd = null;
  try {
    const st = statSync(filePath);
    if (!st.isFile() || st.size === 0) return empty;

    const stableKey = `${filePath}::${Math.round(st.birthtimeMs || 0)}::${st.size < 8192 ? Math.round(st.mtimeMs || 0) : 'head'}`;
    const cached = subagentMetaCache.get(stableKey);
    if (cached && cached.conclusive && st.size >= cached.size) {
      return cached.value;
    }

    fd = openSync(filePath, 'r');
    const len = Math.min(MAX_SUBAGENT_HEAD_BYTES, st.size);
    const buf = Buffer.allocUnsafe(len);
    const bytesRead = readSync(fd, buf, 0, len, 0);
    if (bytesRead <= 0) return empty;
    const head = buf.subarray(0, bytesRead).toString('utf8');

    const lines = head.split('\n');
    const maxLineIdx = st.size > len ? Math.max(1, lines.length - 1) : lines.length;
    let parsedCount = 0;

    let fallbackSubagent = null;
    let pendingSwarmParent = '';

    for (let i = 0; i < maxLineIdx && parsedCount < 10; i++) {
      const trimmed = lines[i].trim();
      if (!trimmed.startsWith('{')) continue;
      let obj = null;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        continue;
      }
      parsedCount += 1;
      const src = String(obj?.source || '');
      const typ = String(obj?.type || '');
      const text = typeof obj?.content === 'string' ? obj.content : '';

      if (src === 'USER_EXPLICIT') {
        const res = { ...empty };
        setSubagentMetaCache(stableKey, { size: st.size, conclusive: true, value: res });
        return res;
      }

      if (typ === 'USER_INPUT' && text.includes('<USER_REQUEST>')) {
        const res = { ...empty };
        setSubagentMetaCache(stableKey, { size: st.size, conclusive: true, value: res });
        return res;
      }

      const senderMatch = text.includes('[Message]')
        ? text.match(/\[Message\][\s\S]*?\bsender\s*=\s*["']?([a-zA-Z0-9_-]{1,128})["']?/)
        : null;
      const senderCid = senderMatch && senderMatch[1] && senderMatch[1].toLowerCase() !== 'system'
        ? senderMatch[1]
        : '';

      // 1. Native Swarm worker assignment brief ("recorded on the board as #N for @name")
      const boardBriefMatch = text.match(
        /Your assignment\s*\(recorded on the board as #\d+\s+for\s+@([a-zA-Z0-9_-]{1,48})\)/i
      );
      if (boardBriefMatch) {
        const res = {
          isSubagent: true,
          parentConversationId: senderCid || pendingSwarmParent,
          agentKind: 'swarm_worker',
          agentHint: boardBriefMatch[1],
        };
        setSubagentMetaCache(stableKey, { size: st.size, conclusive: true, value: res });
        return res;
      }

      // 2. Explicit <swarm_worker> tag or narrator/monitor prompt
      if (/<swarm_worker\b/.test(text) || /(?:^|\n)You are this swarm's (?:narrator|stall monitor)/m.test(text)) {
        const nameMatch = text.match(/<swarm_worker\b[^>]*?\bname=["']?([a-zA-Z0-9_-]{1,48})["']?/i)
          || text.match(/@([a-zA-Z0-9_-]{2,36})\b/);
        const workerHint = /(?:^|\n)You are this swarm's narrator/m.test(text)
          ? 'narrator'
          : (/(?:^|\n)You are this swarm's stall monitor/m.test(text) ? 'monitor' : (nameMatch ? nameMatch[1] : ''));
        const res = {
          isSubagent: true,
          parentConversationId: senderCid || pendingSwarmParent,
          agentKind: 'swarm_worker',
          agentHint: workerHint,
        };
        setSubagentMetaCache(stableKey, { size: st.size, conclusive: true, value: res });
        return res;
      }

      // 3. Initial Swarm board wakeup ("[swarm] new board message #N"): keep scanning next step for @name & coordinator sender
      if (/\bcontent=\[swarm\]\s+new board message\b/i.test(text) || /^\[board\]\s+the latest message is #\d+/m.test(text)) {
        if (!pendingSwarmParent && senderCid) {
          pendingSwarmParent = senderCid;
        }
        continue;
      }

      // 4. Standard subagent [Message] from parent conversation
      if (senderCid && !fallbackSubagent) {
        fallbackSubagent = {
          isSubagent: true,
          parentConversationId: senderCid,
          agentKind: 'subagent',
          agentHint: extractShortHintFromSubagentMessage(text),
        };
        if (!pendingSwarmParent) {
          setSubagentMetaCache(stableKey, { size: st.size, conclusive: true, value: fallbackSubagent });
          return fallbackSubagent;
        }
      }
    }

    if (pendingSwarmParent) {
      const res = {
        isSubagent: true,
        parentConversationId: pendingSwarmParent,
        agentKind: 'swarm_worker',
        agentHint: '',
      };
      setSubagentMetaCache(stableKey, { size: st.size, conclusive: parsedCount >= 4, value: res });
      return res;
    }

    if (fallbackSubagent) {
      setSubagentMetaCache(stableKey, { size: st.size, conclusive: true, value: fallbackSubagent });
      return fallbackSubagent;
    }

    // Raw head fallback when step 0 exceeded 64 KB without newline boundary
    if (!head.includes('"USER_EXPLICIT"') && !head.includes('<USER_REQUEST>')) {
      const rawSender = head.match(/\[Message\][\s\S]*?\bsender\s*=\s*["']?([a-zA-Z0-9_-]{1,128})["']?/);
      if (rawSender) {
        const res = {
          isSubagent: true,
          parentConversationId: rawSender[1],
          agentKind: 'subagent',
          agentHint: '',
        };
        setSubagentMetaCache(stableKey, { size: st.size, conclusive: true, value: res });
        return res;
      }
      if (/<swarm_worker\b/.test(head)) {
        const res = {
          isSubagent: true,
          parentConversationId: '',
          agentKind: 'swarm_worker',
          agentHint: '',
        };
        setSubagentMetaCache(stableKey, { size: st.size, conclusive: true, value: res });
        return res;
      }
    }

    return empty;
  } catch {
    return empty;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch {}
    }
  }
}

export function isSubagentTranscriptFile(filePath) {
  return inspectSubagentTranscriptMeta(filePath).isSubagent;
}

/**
 * Reads Antigravity's per-conversation annotation (.pbtxt) to check `plan_execute:true` (Orchestrator mode).
 * @param {string} [transcriptPath='']
 * @param {string} [conversationId='']
 * @returns {{ exists: boolean, planExecute: boolean|null }}
 */
export function peekOrchestratorAnnotationState(transcriptPath = '', conversationId = '') {
  const cleanTranscript = typeof transcriptPath === 'string' ? transcriptPath.trim() : '';
  const cleanConv = typeof conversationId === 'string' ? conversationId.trim() : '';
  const safeConvId = /^[a-zA-Z0-9_-]{8,128}$/.test(cleanConv) ? cleanConv : '';
  const brainMatch = cleanTranscript
    ? cleanTranscript.match(/^(.*?)[\\/]brain[\\/]([a-zA-Z0-9_-]{8,128})(?:[\\/]|$)/i)
    : null;
  const convId = safeConvId || (brainMatch ? brainMatch[2] : '');
  if (!convId) {
    return { exists: false, planExecute: null };
  }

  const candidates = [];
  if (brainMatch) {
    const baseRoot = brainMatch[1] || (cleanTranscript.startsWith('/') ? '/' : dirname('.'));
    candidates.push(join(baseRoot, 'annotations', `${convId}.pbtxt`));
  } else if (!cleanTranscript) {
    const geminiRoot = join(homedir(), '.gemini');
    for (const d of ['antigravity', 'antigravity-ide', 'antigravity-cli']) {
      candidates.push(join(geminiRoot, d, 'annotations', `${convId}.pbtxt`));
    }
  }

  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const raw = readFileSync(p, 'utf8').slice(0, 16_384);
      return { exists: true, planExecute: /\bplan_execute\s*:\s*true\b/i.test(raw) };
    } catch {
      return { exists: false, planExecute: null };
    }
  }

  return { exists: false, planExecute: null };
}

function scanTranscriptModelState(lines, scanState) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    if (
      /"name"\s*:\s*"exit_plan_mode"/.test(line) ||
      (line.includes('[plan review') &&
        (line.includes('"SYSTEM_MESSAGE"') || line.includes('"USER_INPUT"') || line.includes('"EPHEMERAL_MESSAGE"')))
    ) {
      scanState.sawPlanExecuteMarker = true;
    }
    if (line.includes('"PLANNER_RESPONSE"')) {
      try {
        const step = JSON.parse(line);
        if (step?.type === 'PLANNER_RESPONSE' && typeof step.model === 'string') {
          if (/gemini-4-hydrogen/i.test(step.model)) {
            scanState.pendingHydrogenStep = true;
          } else if (!scanState.latestPlannerModelRaw && step.model.trim()) {
            scanState.latestPlannerModelRaw = step.model.trim();
          }
        }
      } catch {}
      continue;
    }
    if (!line.includes('"USER_INPUT"') || !line.includes('USER_SETTINGS_CHANGE')) {
      continue;
    }
    try {
      const step = JSON.parse(line);
      if (
        step?.type !== 'USER_INPUT' ||
        typeof step.content !== 'string' ||
        !step.content.includes('USER_SETTINGS_CHANGE')
      ) {
        continue;
      }
      const found = extractModelSelectionFromText(step.content);
      if (found) {
        const parsed = normalizeModelProfile(found);
        if (!scanState.latestParsed) {
          scanState.latestSelectionRaw = found;
          scanState.latestParsed = parsed;
        }
        if (scanState.pendingHydrogenStep) {
          if (parsed.isNeon || parsed.isCarbon || parsed.isArgon || parsed.isOrchestrator) {
            scanState.sawHydrogenUnderPlanner = true;
          }
          scanState.pendingHydrogenStep = false;
        }
      }
    } catch {}
  }
}

export function peekActiveModelFromTranscript(transcriptPath = '', conversationId = '') {
  const hasExplicitTranscript = typeof transcriptPath === 'string' && transcriptPath.trim().length > 0;
  const hasExplicitConv = typeof conversationId === 'string' && conversationId.trim().length > 0;
  const explicitProvided = hasExplicitTranscript || hasExplicitConv;

  let targetPath = hasExplicitTranscript ? transcriptPath.trim() : '';

  const geminiRoot = join(homedir(), '.gemini');
  const brainRoots = ['antigravity', 'antigravity-ide', 'antigravity-cli'].map((d) => join(geminiRoot, d, 'brain'));

  if ((!targetPath || !existsSync(targetPath)) && hasExplicitConv) {
    const safeConvId = conversationId.trim();
    if (/^[a-zA-Z0-9_-]{1,128}$/.test(safeConvId)) {
      for (const bRoot of brainRoots) {
        const direct = join(bRoot, safeConvId, '.system_generated', 'logs', 'transcript.jsonl');
        if (existsSync(direct)) {
          targetPath = direct;
          break;
        }
      }
    }
  }

  // Never fall back to unrelated brain/* sessions when caller supplied explicit transcript/conversation id
  if (!explicitProvided && (!targetPath || !existsSync(targetPath))) {
    let latestMainMtime = 0;
    let latestMainPath = '';
    let latestAnyMtime = 0;
    let latestAnyPath = '';
    for (const brainDir of brainRoots) {
      if (!existsSync(brainDir)) continue;
      try {
        for (const d of readdirSync(brainDir, { withFileTypes: true })) {
          if (!d.isDirectory()) continue;
          const p = join(brainDir, d.name, '.system_generated', 'logs', 'transcript.jsonl');
          if (!existsSync(p)) continue;
          try {
            const st = statSync(p);
            if (st.mtimeMs > latestAnyMtime) {
              latestAnyMtime = st.mtimeMs;
              latestAnyPath = p;
            }
            if (!isSubagentTranscriptFile(p) && st.mtimeMs > latestMainMtime) {
              latestMainMtime = st.mtimeMs;
              latestMainPath = p;
            }
          } catch {}
        }
      } catch {}
    }
    targetPath = latestMainPath || latestAnyPath;
  }

  if (!targetPath || !existsSync(targetPath)) {
    return normalizeModelProfile('');
  }

  let fd = null;
  try {
    const st = statSync(targetPath);
    if (!st.isFile() || st.size === 0) return normalizeModelProfile('');

    const annState = peekOrchestratorAnnotationState(targetPath, conversationId);
    const cacheKey = process.platform === 'win32' ? targetPath.toLowerCase() : targetPath;
    const cached = transcriptProfileCache.get(cacheKey);
    if (
      cached &&
      cached.size === st.size &&
      cached.mtimeMs === st.mtimeMs &&
      cached.annPlanExecute === annState.planExecute
    ) {
      // Refresh LRU position
      transcriptProfileCache.delete(cacheKey);
      transcriptProfileCache.set(cacheKey, cached);
      return { ...cached.profile };
    }

    const chunkSize = 131_072;
    const floorPos = Math.max(0, st.size - MAX_MODEL_TAIL_SCAN_BYTES);
    fd = openSync(targetPath, 'r');

    let pos = st.size;
    let carryBuf = Buffer.alloc(0);
    const scanState = {
      latestSelectionRaw: '',
      latestParsed: null,
      latestPlannerModelRaw: '',
      sawPlanExecuteMarker: false,
      pendingHydrogenStep: false,
      sawHydrogenUnderPlanner: false,
    };
    const shouldStopEarly = () =>
      Boolean(
        scanState.latestParsed &&
          (annState.exists ||
            scanState.latestParsed.isOrchestrator ||
            !(scanState.latestParsed.isNeon || scanState.latestParsed.isCarbon || scanState.latestParsed.isArgon) ||
            scanState.sawPlanExecuteMarker ||
            scanState.sawHydrogenUnderPlanner)
      );

    // Bounded reverse tail scan (<= 512KB) + 64KB head fallback for very long sessions
    while (pos > floorPos) {
      const readLen = Math.min(chunkSize, pos - floorPos);
      pos -= readLen;

      const buf = Buffer.allocUnsafe(readLen + carryBuf.length);
      readSync(fd, buf, 0, readLen, pos);
      if (carryBuf.length > 0) {
        carryBuf.copy(buf, readLen);
      }

      let sliceStr = '';
      if (pos > floorPos) {
        const firstNl = buf.indexOf(0x0a);
        if (firstNl === -1) {
          carryBuf = buf.length <= MAX_MODEL_TAIL_SCAN_BYTES ? buf : Buffer.alloc(0);
          continue;
        }
        carryBuf = buf.subarray(0, firstNl);
        sliceStr = buf.subarray(firstNl + 1).toString('utf-8');
      } else {
        carryBuf = Buffer.alloc(0);
        sliceStr = buf.toString('utf-8');
      }

      scanTranscriptModelState(sliceStr.split('\n'), scanState);
      if (shouldStopEarly()) {
        break;
      }
    }

    if (floorPos > 0 && !shouldStopEarly()) {
      const headLen = Math.min(MAX_MODEL_HEAD_FALLBACK_BYTES, floorPos);
      const headBuf = Buffer.allocUnsafe(headLen);
      const bytesRead = readSync(fd, headBuf, 0, headLen, 0);
      if (bytesRead > 0) {
        const headLines = headBuf.subarray(0, bytesRead).toString('utf-8').split('\n');
        scanTranscriptModelState(headLines, scanState);
      }
    }

    const isOrchSession = annState.exists
      ? annState.planExecute === true
      : Boolean(scanState.sawPlanExecuteMarker || scanState.sawHydrogenUnderPlanner || scanState.pendingHydrogenStep);

    let resolvedProfile = normalizeModelProfile('');
    if (scanState.latestParsed) {
      if (
        isOrchSession &&
        !scanState.latestParsed.isOrchestrator &&
        (scanState.latestParsed.isNeon || scanState.latestParsed.isCarbon || scanState.latestParsed.isArgon)
      ) {
        resolvedProfile = normalizeModelProfile(`Orchestrator ${scanState.latestSelectionRaw}`);
      } else {
        resolvedProfile = scanState.latestParsed;
      }
    } else if (annState.exists && annState.planExecute === true && scanState.latestPlannerModelRaw) {
      const fallback = normalizeModelProfile(scanState.latestPlannerModelRaw);
      if (fallback.isNeon || fallback.isCarbon || fallback.isArgon) {
        resolvedProfile = normalizeModelProfile(`Orchestrator ${scanState.latestPlannerModelRaw}`);
      }
    }

    return setTranscriptProfileCache(cacheKey, st, resolvedProfile, annState.planExecute);
  } catch {
    // Отказоустойчивое молчание
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {}
    }
  }

  return normalizeModelProfile('');
}

/**
 * Единая точка определения активного профиля модели по payload хука и транскрипту.
 * @param {object} [params={}]
 * @param {string} [params.modelName='']
 * @param {string} [params.userInput='']
 * @param {string} [params.transcriptPath='']
 * @param {string} [params.conversationId='']
 * @returns {ReturnType<typeof normalizeModelProfile>}
 */
export function resolveActiveModelProfile({
  modelName = '',
  userInput = '',
  transcriptPath = '',
  conversationId = '',
} = {}) {
  const annState =
    transcriptPath || conversationId
      ? peekOrchestratorAnnotationState(transcriptPath, conversationId)
      : { exists: false, planExecute: null };
  let cachedTranscriptProfile = null;
  const getTranscriptProfile = () => {
    if (!cachedTranscriptProfile) {
      cachedTranscriptProfile = peekActiveModelFromTranscript(transcriptPath, conversationId);
    }
    return cachedTranscriptProfile;
  };
  const promoteIfOrchestratorActive = (profile, rawLabel = '') => {
    if (!profile || profile.isOrchestrator) return profile;
    if (profile.isNeon || profile.isCarbon || profile.isArgon) {
      if (annState.exists) {
        return annState.planExecute === true
          ? normalizeModelProfile(`Orchestrator ${rawLabel || profile.rawName}`)
          : profile;
      }
      if (transcriptPath || conversationId) {
        const fromTr = getTranscriptProfile();
        if (fromTr.isOrchestrator) {
          return normalizeModelProfile(`Orchestrator ${rawLabel || profile.rawName}`);
        }
      }
      return profile;
    }
    if (profile.isHydrogen && !(annState.exists && annState.planExecute === false) && (transcriptPath || conversationId)) {
      const fromTr = getTranscriptProfile();
      if (fromTr.isOrchestrator) return fromTr;
    }
    return profile;
  };

  if (modelName && String(modelName).trim()) {
    const direct = normalizeModelProfile(modelName);
    if (direct.tier !== 'unknown') {
      if (direct.thinkingLevel || direct.tier === 'flash_lite') {
        return promoteIfOrchestratorActive(direct, direct.rawName);
      }
      // Если modelName передан без суффикса уровня (например, "gemini-4-carbon", "gemini-4-hydrogen" или "gemini-pro-orchestrator-neon"),
      // дотягиваем точный уровень (Low / Medium / High / XHigh) из <USER_SETTINGS_CHANGE> или транскрипта той же модели/оркестратора
      if (userInput && typeof userInput === 'string') {
        const fromInput = extractModelSelectionFromText(userInput);
        if (fromInput) {
          const parsed = normalizeModelProfile(fromInput);
          if (parsed.id === direct.id && parsed.thinkingLevel) {
            return promoteIfOrchestratorActive(parsed, fromInput);
          }
        }
      }
      if (transcriptPath || conversationId) {
        const fromTranscript = getTranscriptProfile();
        if ((fromTranscript.id === direct.id || (fromTranscript.isOrchestrator && fromTranscript.plannerTier === direct.tier)) && fromTranscript.thinkingLevel) {
          return promoteIfOrchestratorActive(fromTranscript, fromTranscript.rawName || modelName);
        }
      }
      if (!process.env.NODE_TEST_CONTEXT) {
        const fromLatest = peekActiveModelFromTranscript('', '');
        if ((fromLatest.id === direct.id || (fromLatest.isOrchestrator && fromLatest.plannerTier === direct.tier)) && fromLatest.thinkingLevel) {
          return promoteIfOrchestratorActive(fromLatest, fromLatest.rawName || modelName);
        }
      }
      return promoteIfOrchestratorActive(direct, modelName);
    }
  }

  if (userInput && typeof userInput === 'string') {
    const fromInput = extractModelSelectionFromText(userInput);
    if (fromInput) {
      const parsed = normalizeModelProfile(fromInput);
      if (parsed.tier !== 'unknown') {
        return promoteIfOrchestratorActive(parsed, fromInput);
      }
    }
  }

  return getTranscriptProfile();
}

/**
 * Вычисляет адаптивный порог эпохи сжатия контекста.
 * Если в router-state.json стоит дефолт 120k, для моделей Gemini 4 (Carbon / Argon) с окном 1M
 * и 95% скидкой на кэш автоматически поднимает порог до 250k токенов, уважая ручные переопределения.
 * @param {number} [configuredThreshold=120000]
 * @param {ReturnType<typeof normalizeModelProfile>|null} [modelProfile=null]
 * @returns {number}
 */
export function resolveEffectiveCompactionThreshold(configuredThreshold = LEGACY_DEFAULT_COMPACTION_THRESHOLD, modelProfile = null) {
  const num = Number(configuredThreshold || 0);
  const isDefaultOrUnset = !num || num === LEGACY_DEFAULT_COMPACTION_THRESHOLD;
  if (isDefaultOrUnset && modelProfile?.isGemini4 && !modelProfile?.isFlash) {
    return GEMINI4_DEFAULT_COMPACTION_THRESHOLD;
  }
  return Math.max(20_000, num || LEGACY_DEFAULT_COMPACTION_THRESHOLD);
}

/**
 * Определяет оптимальный лимит символов статического RepoMap для SessionStart.
 * На моделях Gemini 4 (Carbon / Argon) расширяет карту с 4k до 12k символов (~3k токенов),
 * чтобы вместе с системными правилами преодолеть порог 4 096 токенов Implicit Caching (-95% скидка)
 * и дать модели полный граф сигнатур проекта с 1-го хода.
 * @param {ReturnType<typeof normalizeModelProfile>|null} [modelProfile=null]
 * @returns {number}
 */
export function resolveRepoMapMaxChars(modelProfile = null) {
  if (modelProfile?.isGemini4 && !modelProfile?.isFlash) {
    return GEMINI4_REPOMAP_MAX_CHARS;
  }
  return LEGACY_REPOMAP_MAX_CHARS;
}

/**
 * Адаптивно расширяет лимит RepoMap на старте сессии Gemini 4 (до 18k символов),
 * если handoff/pitfalls короткие, чтобы суммарный статический префикс гарантированно
 * превысил порог 4 096 токенов Implicit Caching (~16.5k символов с учётом системных правил).
 * @param {ReturnType<typeof normalizeModelProfile>|null} [modelProfile=null]
 * @param {number} [existingPrefixChars=0]
 * @returns {number}
 */
export function resolveAdaptiveRepoMapMaxChars(modelProfile = null, existingPrefixChars = 0) {
  if (!modelProfile?.isGemini4 || modelProfile?.isFlash) {
    return LEGACY_REPOMAP_MAX_CHARS;
  }
  const SYSTEM_RULES_ESTIMATE_CHARS = 4_000;
  const TARGET_PREFIX_CHARS = GEMINI4_IMPLICIT_CACHE_MIN_TOKENS * 4 + 600; // ~17k символов (>4096 токенов с запасом)
  const deficit = Math.max(0, TARGET_PREFIX_CHARS - (SYSTEM_RULES_ESTIMATE_CHARS + Math.max(0, Number(existingPrefixChars || 0))));
  if (deficit > GEMINI4_REPOMAP_MAX_CHARS) {
    return Math.min(GEMINI4_MAX_ADAPTIVE_REPOMAP_CHARS, deficit);
  }
  return GEMINI4_REPOMAP_MAX_CHARS;
}

/**
 * Проверяет, вступило ли удвоение тарифа Argon/Carbon ($2/$10 -> $4/$20 с 1 декабря 2026).
 * @param {Date} [now=new Date()]
 * @returns {boolean}
 */
export function isPostPromoRateActive(now = new Date()) {
  return now.getTime() >= Date.parse(GEMINI4_PRICING_META.promoEndIso);
}

/**
 * Возвращает текущий ценовой режим линейки Gemini 4 (промо до 1 декабря 2026 или стандартный тариф).
 * @param {Date|number|string} [now=new Date()]
 * @returns {{
 *   phase: 'promo'|'standard',
 *   isPostPromo: boolean,
 *   promoEndIso: string,
 *   daysRemaining: number,
 *   labelRu: string,
 *   ratesPer1M: {
 *     hydrogen: { input: number, output: number, cachedInput: number },
 *     neon: { input: number, output: number, cachedInput: number },
 *     argon: { input: number, output: number },
 *     carbon: { input: number, output: number },
 *   }
 * }}
 */
export function getPricingPhaseStatus(now = new Date()) {
  const curDate = now instanceof Date ? now : new Date(now);
  const nowMs = Number.isFinite(curDate.getTime()) ? curDate.getTime() : Date.now();
  const promoEndMs = Date.parse(GEMINI4_PRICING_META.promoEndIso);
  const postPromo = nowMs >= promoEndMs;
  const daysRemaining = postPromo ? 0 : Math.max(0, Math.ceil((promoEndMs - nowMs) / 86_400_000));
  const argonIn = postPromo ? GEMINI4_PRICING_META.argon.postInputPer1M : GEMINI4_PRICING_META.argon.promoInputPer1M;
  const argonOut = postPromo ? GEMINI4_PRICING_META.argon.postOutputPer1M : GEMINI4_PRICING_META.argon.promoOutputPer1M;
  const carbonIn = postPromo ? GEMINI4_PRICING_META.carbon.postInputPer1M : GEMINI4_PRICING_META.carbon.promoInputPer1M;
  const carbonOut = postPromo ? GEMINI4_PRICING_META.carbon.postOutputPer1M : GEMINI4_PRICING_META.carbon.promoOutputPer1M;
  return {
    phase: postPromo ? 'standard' : 'promo',
    isPostPromo: postPromo,
    promoEndIso: GEMINI4_PRICING_META.promoEndIso,
    daysRemaining,
    labelRu: postPromo
      ? `Стандартный тариф Argon/Carbon ($${carbonIn}/$${carbonOut} за 1M) · Neon ($3/$15)`
      : `Промо-тариф Gemini 4 ($${carbonIn}/$${carbonOut} за 1M, осталось ${daysRemaining} дн. до 01.12.2026) · Neon ($3/$15)`,
    labelEn: postPromo
      ? `Standard Argon/Carbon rate ($${carbonIn}/$${carbonOut} per 1M) · Neon ($3/$15)`
      : `Gemini 4 Promo rate ($${carbonIn}/$${carbonOut} per 1M, ${daysRemaining}d left until Dec 1, 2026) · Neon ($3/$15)`,
    ratesPer1M: {
      hydrogen: {
        input: GEMINI4_PRICING_META.hydrogen.inputPer1M,
        output: GEMINI4_PRICING_META.hydrogen.outputPer1M,
        cachedInput: GEMINI4_PRICING_META.hydrogen.cachedInputPer1M,
      },
      neon: {
        input: GEMINI4_PRICING_META.neon.inputPer1M,
        output: GEMINI4_PRICING_META.neon.outputPer1M,
        cachedInput: GEMINI4_PRICING_META.neon.cachedInputPer1M,
      },
      argon: { input: argonIn, output: argonOut },
      carbon: { input: carbonIn, output: carbonOut },
    },
  };
}

/**
 * Определяет политику удержания контекста Read-Once Guard (read-dedup.mjs).
 * Учитывает окно 1M моделей Gemini 4 (Carbon / Argon / Hydrogen — 25 мин и 45 шагов)
 * и двусторонние переходы Планировщик <-> Hydrogen в режимах Orchestrator (30 мин и 55 шагов).
 * @param {ReturnType<typeof normalizeModelProfile>|null} [modelProfile=null]
 * @returns {{ activeWindowMs: number, maxStepGap: number }}
 */
export function resolveReadDedupPolicy(modelProfile = null) {
  if (modelProfile?.isOrchestrator) {
    return {
      activeWindowMs: ORCHESTRATOR_READ_DEDUP_WINDOW_MS,
      maxStepGap: ORCHESTRATOR_READ_DEDUP_STEP_GAP,
    };
  }
  if (modelProfile?.isGemini4 && !modelProfile?.isFlash) {
    return {
      activeWindowMs: GEMINI4_READ_DEDUP_WINDOW_MS,
      maxStepGap: GEMINI4_READ_DEDUP_STEP_GAP,
    };
  }
  return {
    activeWindowMs: LEGACY_READ_DEDUP_WINDOW_MS,
    maxStepGap: LEGACY_READ_DEDUP_STEP_GAP,
  };
}

/**
 * Вычисляет эффективную политику предварительного опроса (Pre-Task Gate) с учётом режимов Orchestrator.
 * При активном Orchestrator и включённом `orchestratorSmartSynergy` (по умолчанию true) задачи S и M
 * не останавливаются опросами по выбору модели — штатный Orchestrator сам исполняет их через Hydrogen,
 * а подтверждение запрашивается только начиная с крупных задач L/XL (или для A/B/C превью UI-дизайна).
 * @param {object} [params={}]
 * @param {object} [params.state={}]
 * @param {ReturnType<typeof normalizeModelProfile>|null} [params.modelProfile=null]
 * @param {'S'|'M'|'L'|'XL'} [params.grade='M']
 */
export function resolveEffectivePreTaskGatePolicy({
  state = {},
  modelProfile = null,
  grade = 'M',
} = {}) {
  if (state.confirmBeforeRun === false) {
    return {
      shouldAskModelGate: false,
      effectiveThreshold: 'OFF',
      orchestratorBypassSM: false,
    };
  }

  const rawThr = String(state.confirmThreshold || 'M').toUpperCase();
  const gradeRank = { S: 1, M: 2, L: 3, XL: 4 };
  const thrRankMap = { ALL: 1, S: 1, M: 2, L: 3, XL: 4 };

  const isOrchSynergy = Boolean((modelProfile?.isOrchestrator || modelProfile?.isHydrogen) && state.orchestratorSmartSynergy !== false);
  const effectiveThreshold = isOrchSynergy && (rawThr === 'S' || rawThr === 'M')
    ? 'L'
    : rawThr;

  const curRank = gradeRank[grade] || 2;
  const reqRank = thrRankMap[effectiveThreshold] || 2;

  return {
    shouldAskModelGate: curRank >= reqRank,
    effectiveThreshold,
    orchestratorBypassSM: isOrchSynergy && rawThr !== 'ALL' && curRank < 3,
  };
}

/**
 * Анализирует расход выходных токенов (включая thinking) относительно профиля модели (FinOps-индикатор).
 * Учитывает специфику Carbon, Argon, Hydrogen (включая XHigh) и автоматических режимов Orchestrator.
 * @param {object} [params={}]
 * @param {ReturnType<typeof normalizeModelProfile>|null} [params.modelProfile=null]
 * @param {number} [params.steps=0]
 * @param {number} [params.outputTokens=0]
 * @param {{ pro?: number, flash?: number, total?: number }} [params.subagents={}]
 * @returns {{ status: 'optimal'|'overprovisioned_high'|'heavy_reasoning', outputPerStep: number, advisoryRu: string }}
 */
export function evaluateThinkingBurnAdvisory({
  modelProfile = null,
  steps = 0,
  outputTokens = 0,
  subagents = {},
} = {}) {
  const stepCount = Math.max(0, Number(steps || 0));
  const outTotal = Math.max(0, Number(outputTokens || 0));
  const outputPerStep = stepCount > 0 ? Math.round(outTotal / stepCount) : 0;

  if (!modelProfile || stepCount < 3) {
    return { status: 'optimal', outputPerStep, advisoryRu: '', advisoryEn: '' };
  }

  const flashSubs = Number(subagents?.flash || 0);
  const modelDisplay = modelProfile.displayRu || modelProfile.shortLabel || 'Gemini 4';
  const modelDisplayEn = modelProfile.displayEn || modelProfile.shortLabel || 'Gemini 4';

  // Режимы Orchestrator распределяют фазы Планировщик <-> Hydrogen (-24% квоты), но учитывают выбранную глубину планировщика
  if (modelProfile.isOrchestrator) {
    if (
      (modelProfile.thinkingLevel === 'xhigh' ||
        (modelProfile.plannerTier === 'carbon' && modelProfile.thinkingLevel === 'high')) &&
      stepCount >= 5 &&
      outputPerStep > 0 &&
      outputPerStep < 420 &&
      flashSubs === 0
    ) {
      return {
        status: 'overprovisioned_high',
        outputPerStep,
        advisoryRu: `Профиль ${modelDisplay} избыточен на коротких шагах — снизьте глубину планировщика Оркестратора до Средний/Высокий или включите Hydrogen · Средний`,
        advisoryEn: `${modelDisplayEn} is overkill for short steps — lower Orchestrator planner depth to Medium/High or switch to Hydrogen · Medium`,
      };
    }
    if (outputPerStep >= 2200) {
      return {
        status: 'heavy_reasoning',
        outputPerStep,
        advisoryRu: 'Плотная фаза планирования Оркестратора — для шумного чтения 20+ файлов подключайте субагента research (flash_lite)',
        advisoryEn: 'Heavy Orchestrator planning burn — offload noisy 20+ file scans to a research subagent (flash_lite)',
      };
    }
    return { status: 'optimal', outputPerStep, advisoryRu: '', advisoryEn: '' };
  }

  // Gemini 4 Hydrogen: контроль избыточного уровня XHigh на коротких шагах
  if (modelProfile.isHydrogen) {
    if (modelProfile.thinkingLevel === 'xhigh' && stepCount >= 5 && outputPerStep > 0 && outputPerStep < 420) {
      return {
        status: 'overprovisioned_high',
        outputPerStep,
        advisoryRu: 'Профиль Hydrogen · XHigh избыточен для коротких шагов — на рутине S/M быстрее и экономнее Hydrogen · Средний',
        advisoryEn: 'Hydrogen · XHigh is excessive for short steps — Hydrogen · Medium is faster and cheaper on S/M routine tasks',
      };
    }
    if (modelProfile.thinkingLevel === 'xhigh' && outputPerStep >= 1850) {
      return {
        status: 'heavy_reasoning',
        outputPerStep,
        advisoryRu: 'Высокий расход thinking-токенов на Hydrogen · XHigh — для тяжёлой архитектуры выгоднее Orchestrator (Neon · Высокий/XHigh) или Orchestrator (Carbon · Высокий)',
        advisoryEn: 'High thinking burn on Hydrogen · XHigh — for heavy architecture prefer Orchestrator (Neon · High/XHigh) or Orchestrator (Carbon · High)',
      };
    }
    return { status: 'optimal', outputPerStep, advisoryRu: '', advisoryEn: '' };
  }

  // Gemini 4 Neon: контроль высокой болтливости thinking ($15/1M output) и коротких шагов
  if (modelProfile.isNeon) {
    if (
      (modelProfile.thinkingLevel === 'high' || modelProfile.thinkingLevel === 'xhigh') &&
      stepCount >= 5 &&
      outputPerStep > 0 &&
      outputPerStep < 450 &&
      flashSubs === 0
    ) {
      return {
        status: 'overprovisioned_high',
        outputPerStep,
        advisoryRu: `Профиль ${modelDisplay} избыточен на коротких шагах — для рутины выгоднее Orchestrator (Neon · Средний) или Hydrogen · Средний`,
        advisoryEn: `${modelDisplayEn} is overkill for short steps — Orchestrator (Neon · Medium) or Hydrogen · Medium is cheaper for routine work`,
      };
    }
    if (outputPerStep >= 2000) {
      return {
        status: 'heavy_reasoning',
        outputPerStep,
        advisoryRu: `Высокий расход thinking-токенов ${modelDisplay} ($15/1M) — включите Orchestrator (Neon · Высокий) для авто-передачи правок на Hydrogen (-24% квоты) или делегируйте разведку на flash_lite`,
        advisoryEn: `High thinking spend on ${modelDisplayEn} ($15/1M) — switch to Orchestrator (Neon · High) for Hydrogen edits (-24% quota) or delegate research to flash_lite`,
      };
    }
    return { status: 'optimal', outputPerStep, advisoryRu: '', advisoryEn: '' };
  }

  if (!modelProfile.isCarbon && !modelProfile.isArgon) {
    return { status: 'optimal', outputPerStep, advisoryRu: '', advisoryEn: '' };
  }

  if (modelProfile.thinkingLevel === 'high' && stepCount >= 5 && outputPerStep > 0 && outputPerStep < 480 && flashSubs === 0) {
    return {
      status: 'overprovisioned_high',
      outputPerStep,
      advisoryRu: `Профиль ${modelDisplay} тратится на короткие шаги — для активной разработки выгоднее Orchestrator (${modelProfile.isCarbon ? 'Carbon · Средний' : 'Neon · Средний'}) или Hydrogen · Средний`,
      advisoryEn: `${modelDisplayEn} is spent on short steps — Orchestrator (${modelProfile.isCarbon ? 'Carbon · Medium' : 'Neon · Medium'}) or Hydrogen · Medium fits active iteration better`,
    };
  }

  if (modelProfile.isCarbon && outputPerStep >= 1900) {
    return {
      status: 'heavy_reasoning',
      outputPerStep,
      advisoryRu: 'Высокий расход thinking-токенов Carbon — включите Orchestrator (Carbon · Высокий) для авто-передачи правок на Hydrogen или делегируйте разведку на flash_lite',
      advisoryEn: 'High Carbon thinking spend — switch to Orchestrator (Carbon · High) to offload edits to Hydrogen or delegate scanning to flash_lite',
    };
  }

  return { status: 'optimal', outputPerStep, advisoryRu: '', advisoryEn: '' };
}

export const SUBSCRIPTION_TIER_CAPABILITIES = {
  pro: {
    tier: 'pro',
    supportsCarbon: false,
    allowedModels: ['hydrogen', 'neon', 'argon', 'flash'],
    allowedOrchestratorPlanners: ['neon', 'argon'],
    allowedSwarmWorkerTiers: ['hydrogen_auto', 'neon_auto', 'inherit'],
    allowedSwarmModes: ['auto_xl', 'aggressive_l', 'auto_all', 'always_ask', 'manual_only', 'off'],
    maxModelLabelRu: 'Orchestrator (Neon · Высокий/XHigh) / Neon · XHigh',
    maxModelLabelEn: 'Orchestrator (Neon · High/XHigh) / Neon · XHigh',
  },
  ultra: {
    tier: 'ultra',
    supportsCarbon: true,
    allowedModels: ['hydrogen', 'neon', 'argon', 'carbon', 'flash'],
    allowedOrchestratorPlanners: ['neon', 'argon', 'carbon'],
    allowedSwarmWorkerTiers: ['hydrogen_auto', 'neon_auto', 'argon_auto', 'carbon_auto', 'inherit'],
    allowedSwarmModes: ['auto_xl', 'aggressive_l', 'auto_all', 'always_ask', 'manual_only', 'off'],
    maxModelLabelRu: 'Orchestrator (Carbon · Высокий) / Carbon · Высокий',
    maxModelLabelEn: 'Orchestrator (Carbon · High) / Carbon · High',
  },
};

const VALID_SWARM_TIERS_SET = new Set(['hydrogen_auto', 'neon_auto', 'argon_auto', 'carbon_auto', 'inherit']);

export function normalizeSubscriptionTier(rawTier = 'pro') {
  return String(rawTier || '').trim().toLowerCase() === 'ultra' ? 'ultra' : 'pro';
}

export function getSubscriptionCapabilities(rawTier = 'pro') {
  const tier = normalizeSubscriptionTier(rawTier);
  return SUBSCRIPTION_TIER_CAPABILITIES[tier];
}

export function sanitizeSwarmWorkerTierForSubscription(rawTier = 'pro', workerTier = 'hydrogen_auto') {
  const cleanSub = normalizeSubscriptionTier(rawTier);
  const rawWorker = String(workerTier || '').trim().toLowerCase();
  const validWorker = VALID_SWARM_TIERS_SET.has(rawWorker) ? rawWorker : 'hydrogen_auto';
  if (cleanSub === 'pro') {
    if (validWorker === 'carbon_auto') return 'neon_auto';
    if (validWorker === 'argon_auto') return 'hydrogen_auto';
  }
  return validWorker;
}

/**
 * Оценивает соответствие выбранной в UI модели (Carbon / Neon / Argon / Hydrogen / Orchestrator / Flash 3.8
 * и уровней Низкий / Средний / Высокий / XHigh) реальному масштабу текущей задачи.
 * Выдаёт ненавязчивый совет ТОЛЬКО при явном перекосе.
 * @param {object} [params={}]
 * @param {ReturnType<typeof normalizeModelProfile>|null} [params.modelProfile=null]
 * @param {'S'|'M'|'L'|'XL'} [params.grade='M']
 * @param {boolean} [params.isDeepAuditOrArch=false]
 * @returns {{ match: 'optimal'|'underprovisioned'|'overprovisioned', currentDisplayRu: string, recommendedRu: string, tipRu: string }}
 */
export function evaluateSelectorMatchForTask({
  modelProfile = null,
  grade = 'M',
  isDeepAuditOrArch = false,
  matrix2D = null,
  state = {},
} = {}) {
  const subscriptionTier = state?.subscriptionTier || null;
  const isProSub = subscriptionTier === 'pro';
  const res = evaluateSelectorMatchBase({ modelProfile, grade, isDeepAuditOrArch, matrix2D, subscriptionTier });
  if (!modelProfile || modelProfile.tier === 'unknown') return res;

  const strategy = state?.strategy || 'balanced';
  const threshold = state?.heavyThreshold || 'XL';
  const cur = modelProfile.displayRu || modelProfile.shortLabel || modelProfile.label;
  const curEn = modelProfile.displayEn || modelProfile.shortLabel || modelProfile.label;
  const lvl = modelProfile.thinkingLevel;
  const depth = matrix2D?.depth || null;
  const riskMode = matrix2D?.riskMode || null;
  const isHighBlast = Boolean(matrix2D?.isHighBlast || riskMode === 'critical_blast');
  const GRADE_RANK = { S: 1, M: 2, L: 3, XL: 4 };
  const THRESH_RANK = { S: 1, M: 2, L: 3, XL: 4, OFF: 99 };
  const gradeRank = GRADE_RANK[grade] || 2;
  const threshRank = THRESH_RANK[threshold] ?? 4;
  const meetsHeavyThreshold = gradeRank >= threshRank;

  const isPerf = strategy === 'performance' || strategy === 'pro_architect';
  const isEcon = strategy === 'economy' || strategy === 'flash_dispatcher';

  if (isPerf) {
    if (res.match === 'overprovisioned' && grade !== 'S') {
      return { ...res, match: 'optimal', tipRu: '', tipEn: '' };
    }
    if ((meetsHeavyThreshold || (grade === 'M' && depth !== 'routine')) && modelProfile.isFlash) {
      const perfTarget = isProSub
        ? 'Orchestrator (Neon · Высокий) / Neon · Высокий'
        : 'Orchestrator (Neon · Высокий) / Neon · Высокий или Carbon · Высокий';
      const perfTargetEn = isProSub
        ? 'Orchestrator (Neon · High) / Neon · High'
        : 'Orchestrator (Neon · High) / Neon · High or Carbon · High';
      return {
        match: 'underprovisioned',
        currentDisplayRu: cur,
        currentDisplayEn: curEn,
        recommendedRu: `${perfTarget} (Performance)`,
        recommendedEn: `${perfTargetEn} (Performance)`,
        tipRu: `⚡ Стратегия ${strategy} (порог ${threshold}): выбран ${cur}, для максимального качества на ${grade} рекомендуется ${perfTarget}.`,
        tipEn: `⚡ Strategy ${strategy} (threshold ${threshold}): currently on ${curEn} — switch to ${perfTargetEn} for peak quality on ${grade}.`,
      };
    }
    return res;
  }

  if (isEcon) {
    if (grade === 'L' && !isDeepAuditOrArch && depth !== 'deep_arch' && modelProfile.isFlash && res.match === 'underprovisioned') {
      return { ...res, match: 'optimal', tipRu: '', tipEn: '' };
    }
    if (
      grade === 'M' &&
      !isDeepAuditOrArch &&
      depth !== 'deep_arch' &&
      riskMode !== 'exploratory' &&
      !isHighBlast &&
      (modelProfile.isCarbon || (modelProfile.isNeon && (lvl === 'high' || lvl === 'xhigh')) || (modelProfile.isArgon && lvl === 'high'))
    ) {
      return {
        match: 'overprovisioned',
        currentDisplayRu: cur,
        currentDisplayEn: curEn,
        recommendedRu: 'Hydrogen · Средний или Orchestrator (Neon · Средний) / Flash 3.8 · Средний (Economy)',
        recommendedEn: 'Hydrogen · Medium or Orchestrator (Neon · Medium) / Flash 3.8 · Medium (Economy)',
        tipRu: `💰 Стратегия ${strategy}: на рутинной задаче ${grade} одиночный ${cur} избыточен — выгоднее переключить на Orchestrator (Neon · Средний) (-24% квоты + правки на Hydrogen) или Hydrogen · Средний / Flash 3.8 · Средний.`,
        tipEn: `💰 Strategy ${strategy}: standalone ${curEn} is overkill for routine ${grade} — switch to Orchestrator (Neon · Medium) (-24% quota + Hydrogen edits) or Hydrogen · Medium / Flash 3.8 · Medium.`,
      };
    }
  }

  if (meetsHeavyThreshold && threshold !== 'XL' && threshold !== 'OFF' && res.match === 'optimal') {
    if (modelProfile.isFlash || (modelProfile.isHydrogen && lvl === 'low')) {
      const thrRec = isProSub
        ? 'Orchestrator (Neon · Высокий) / Neon · Высокий'
        : 'Orchestrator (Neon · Высокий) / Neon · Высокий или Orchestrator (Carbon · Средний/Высокий) / Carbon · Средний';
      const thrRecEn = isProSub
        ? 'Orchestrator (Neon · High) / Neon · High'
        : 'Orchestrator (Neon · High) / Neon · High or Orchestrator (Carbon · Medium/High) / Carbon · Medium';
      const thrTipTarget = isProSub
        ? 'Orchestrator (Neon · Высокий) / Neon · Высокий'
        : 'Neon · Высокий / Carbon · Средний';
      const thrTipTargetEn = isProSub
        ? 'Orchestrator (Neon · High) / Neon · High'
        : 'Neon · High / Carbon · Medium';
      return {
        match: 'underprovisioned',
        currentDisplayRu: cur,
        currentDisplayEn: curEn,
        recommendedRu: thrRec,
        recommendedEn: thrRecEn,
        tipRu: `⚠️ Порог тяжёлых задач ${threshold}: для ${grade} с текущим ${cur} лучше повысить модель до ${thrTipTarget}.`,
        tipEn: `⚠️ Heavy-task threshold ${threshold}: upgrade from ${curEn} to ${thrTipTargetEn} for grade ${grade}.`,
      };
    }
  }

  return res;
}

export function resolveOptimalModelTargetRu({ grade = 'M', isDeepAuditOrArch = false, matrix2D = null, subscriptionTier = null } = {}) {
  const breadth = matrix2D?.breadth || null;
  const depth = matrix2D?.depth || null;
  const isHighBlast = Boolean(matrix2D?.isHighBlast || matrix2D?.riskMode === 'critical_blast');
  const isProSub = subscriptionTier === 'pro';
  if (depth === 'deep_arch' && (breadth === 'narrow' || breadth === 'moderate')) {
    return isProSub
      ? 'Orchestrator (Neon · Высокий/XHigh) / Neon · Высокий/XHigh'
      : 'Orchestrator (Neon · Высокий/XHigh) / Neon · Высокий/XHigh или Carbon · Средний/Высокий';
  }
  if (isHighBlast && depth !== 'routine' && grade !== 'XL') {
    return isProSub
      ? 'Orchestrator (Neon · Высокий/XHigh) или Neon · Высокий/XHigh'
      : 'Orchestrator (Neon · Высокий/XHigh) / Orchestrator (Carbon · Средний/Высокий) или Carbon · Средний/Высокий';
  }
  if (breadth === 'wide' && depth === 'routine') {
    return 'Hydrogen · Высокий/XHigh или Orchestrator (Neon · Средний/Высокий)';
  }
  if (breadth === 'wide' && depth === 'integrated' && !isDeepAuditOrArch) {
    return isProSub
      ? 'Orchestrator (Neon · Высокий) или Hydrogen · XHigh'
      : 'Orchestrator (Neon · Высокий) / Orchestrator (Carbon · Средний/Высокий) или Hydrogen · XHigh';
  }
  if (grade === 'XL' || isDeepAuditOrArch || (breadth === 'wide' && depth === 'deep_arch')) {
    return isProSub
      ? 'Orchestrator (Neon · XHigh) / Neon · XHigh'
      : 'Orchestrator (Carbon · Высокий) / Orchestrator (Neon · XHigh) / Carbon · Высокий';
  }
  if (grade === 'L') {
    return isProSub
      ? 'Orchestrator (Neon · Высокий) или Hydrogen · Высокий/XHigh'
      : 'Orchestrator (Neon · Высокий) / Orchestrator (Carbon · Средний/Высокий) или Hydrogen · Высокий/XHigh';
  }
  if (grade === 'M') {
    return 'Hydrogen · Средний/Высокий или Orchestrator (Neon · Средний/Высокий)';
  }
  return 'Hydrogen · Средний / Flash 3.8 · Средний';
}

export function resolveOptimalModelTargetEn({ grade = 'M', isDeepAuditOrArch = false, matrix2D = null, subscriptionTier = null } = {}) {
  const breadth = matrix2D?.breadth || null;
  const depth = matrix2D?.depth || null;
  const isHighBlast = Boolean(matrix2D?.isHighBlast || matrix2D?.riskMode === 'critical_blast');
  const isProSub = subscriptionTier === 'pro';
  if (depth === 'deep_arch' && (breadth === 'narrow' || breadth === 'moderate')) {
    return isProSub
      ? 'Orchestrator (Neon · High/XHigh) / Neon · High/XHigh'
      : 'Orchestrator (Neon · High/XHigh) / Neon · High/XHigh or Carbon · Medium/High';
  }
  if (isHighBlast && depth !== 'routine' && grade !== 'XL') {
    return isProSub
      ? 'Orchestrator (Neon · High/XHigh) or Neon · High/XHigh'
      : 'Orchestrator (Neon · High/XHigh) / Orchestrator (Carbon · Medium/High) or Carbon · Medium/High';
  }
  if (breadth === 'wide' && depth === 'routine') {
    return 'Hydrogen · High/XHigh or Orchestrator (Neon · Medium/High)';
  }
  if (breadth === 'wide' && depth === 'integrated' && !isDeepAuditOrArch) {
    return isProSub
      ? 'Orchestrator (Neon · High) or Hydrogen · XHigh'
      : 'Orchestrator (Neon · High) / Orchestrator (Carbon · Medium/High) or Hydrogen · XHigh';
  }
  if (grade === 'XL' || isDeepAuditOrArch || (breadth === 'wide' && depth === 'deep_arch')) {
    return isProSub
      ? 'Orchestrator (Neon · XHigh) / Neon · XHigh'
      : 'Orchestrator (Carbon · High) / Orchestrator (Neon · XHigh) / Carbon · High';
  }
  if (grade === 'L') {
    return isProSub
      ? 'Orchestrator (Neon · High) or Hydrogen · High/XHigh'
      : 'Orchestrator (Neon · High) / Orchestrator (Carbon · Medium/High) or Hydrogen · High/XHigh';
  }
  if (grade === 'M') {
    return 'Hydrogen · Medium/High or Orchestrator (Neon · Medium/High)';
  }
  return 'Hydrogen · Medium / Flash 3.8 · Medium';
}

export function formatModelDisplay(profile = null, lang = 'en') {
  if (!profile) return '';
  const isRu = String(lang || '').trim().toLowerCase() === 'ru';
  return isRu
    ? (profile.displayRu || profile.shortLabel || profile.label || '')
    : (profile.displayEn || profile.shortLabel || profile.label || '');
}

export function getEvalTip(evalRes = null, lang = 'en') {
  if (!evalRes) return '';
  const isRu = String(lang || '').trim().toLowerCase() === 'ru';
  return isRu
    ? (evalRes.tipRu || evalRes.tipEn || '')
    : (evalRes.tipEn || evalRes.tipRu || '');
}

function evaluateSelectorMatchBase({
  modelProfile = null,
  grade = 'M',
  isDeepAuditOrArch = false,
  matrix2D = null,
  subscriptionTier = null,
} = {}) {
  const recTarget = resolveOptimalModelTargetRu({ grade, isDeepAuditOrArch, matrix2D, subscriptionTier });
  const recTargetEn = resolveOptimalModelTargetEn({ grade, isDeepAuditOrArch, matrix2D, subscriptionTier });
  if (!modelProfile || modelProfile.tier === 'unknown') {
    return {
      match: 'optimal',
      currentDisplayRu: '',
      currentDisplayEn: '',
      recommendedRu: recTarget,
      recommendedEn: recTargetEn,
      tipRu: '',
      tipEn: '',
    };
  }

  const cur = modelProfile.displayRu || modelProfile.shortLabel || modelProfile.label;
  const curEn = modelProfile.displayEn || modelProfile.shortLabel || modelProfile.label;
  const lvl = modelProfile.thinkingLevel; // 'low' | 'medium' | 'high' | 'xhigh' | null
  const breadth = matrix2D?.breadth || null; // 'narrow' | 'moderate' | 'wide' | null
  const depth = matrix2D?.depth || null;     // 'routine' | 'integrated' | 'deep_arch' | null
  const riskMode = matrix2D?.riskMode || null; // 'clear' | 'exploratory' | 'critical_blast' | null
  const isHighBlast = Boolean(matrix2D?.isHighBlast || riskMode === 'critical_blast');
  const isStrongOrchBase = modelProfile.isOrchestrator && (modelProfile.plannerTier === 'carbon' || modelProfile.plannerTier === 'neon');
  const isStrongOrch = isStrongOrchBase && lvl !== 'low';
  const isOrchLow = isStrongOrchBase && lvl === 'low';
  const isArgonOrch = modelProfile.isOrchestrator && modelProfile.plannerTier === 'argon';
  const orchDepthTargetRu = modelProfile.plannerTier === 'neon' ? 'Высокий / Сверхвысокий (XHigh)' : 'Высокий';
  const orchDepthTargetEn = modelProfile.plannerTier === 'neon' ? 'High / XHigh' : 'High';

  // 0. 2D-ветка A: Узкая или средняя по числу файлов, но ВЫСОКАЯ когнитивная глубина (хитрый баг, гонка, утечка, безопасность в 1–3 файлах)
  if (depth === 'deep_arch' && (breadth === 'narrow' || breadth === 'moderate')) {
    if (
      isStrongOrch ||
      (modelProfile.isCarbon && lvl !== 'low') ||
      (modelProfile.isNeon && lvl !== 'low')
    ) {
      const orchTip = !isStrongOrch && (breadth === 'moderate' || lvl === 'medium')
        ? `💡 Совет по режиму: в логе IDE указан ${cur} (если это одиночная модель, а не Оркестратор) — для связки планирования и правок выгоднее Orchestrator (${modelProfile.isCarbon ? 'Carbon · Высокий' : 'Neon · Высокий'}) (экономия -24% квоты за счёт правок на Hydrogen).`
        : '';
      const orchTipEn = !isStrongOrch && (breadth === 'moderate' || lvl === 'medium')
        ? `💡 Mode tip: IDE log shows ${curEn} (if standalone rather than Orchestrator) — Orchestrator (${modelProfile.isCarbon ? 'Carbon · High' : 'Neon · High'}) saves -24% quota by offloading edits to Hydrogen.`
        : '';
      return {
        match: 'optimal',
        currentDisplayRu: cur,
        currentDisplayEn: curEn,
        recommendedRu: recTarget,
        recommendedEn: recTargetEn,
        tipRu: orchTip,
        tipEn: orchTipEn,
      };
    }
    return {
      match: 'underprovisioned',
      currentDisplayRu: cur,
      currentDisplayEn: curEn,
      recommendedRu: recTarget,
      recommendedEn: recTargetEn,
      tipRu: `💡 Совет по режиму (2D: узкий охват × глубокая логика): сейчас выбран ${cur} — хотя файлов немного, задача требует глубокого анализа (гонки/баг/алгоритм), поэтому лучше переключить на ${recTarget}.`,
      tipEn: `💡 Mode tip (2D: Narrow × Deep logic): currently on ${curEn} — even with few files, this task requires deep reasoning (race/bug/algorithm); switch to ${recTargetEn}.`,
    };
  }

  // 0. 2D-ветка B: Широкая по числу файлов (4+), но ТИПОВАЯ / рутинная логика (Wide × Routine)
  if (breadth === 'wide' && depth === 'routine') {
    if (
      isStrongOrch ||
      (modelProfile.isHydrogen && (lvl === 'high' || lvl === 'xhigh' || lvl === 'medium'))
    ) {
      return {
        match: 'optimal',
        currentDisplayRu: cur,
        currentDisplayEn: curEn,
        recommendedRu: 'Hydrogen · Высокий/XHigh или Orchestrator (Neon · Средний/Высокий)',
        recommendedEn: 'Hydrogen · High/XHigh or Orchestrator (Neon · Medium/High)',
        tipRu: '',
        tipEn: '',
      };
    }
    if (modelProfile.isCarbon || modelProfile.isNeon || modelProfile.isArgon || isArgonOrch) {
      if (isHighBlast) {
        return {
          match: 'optimal',
          currentDisplayRu: cur,
          currentDisplayEn: curEn,
          recommendedRu: 'Hydrogen · Высокий/XHigh или Orchestrator (Neon · Средний/Высокий)',
          recommendedEn: 'Hydrogen · High/XHigh or Orchestrator (Neon · Medium/High)',
          tipRu: `💡 Совет по режиму: в логе IDE указан ${cur} (если это одиночная модель, а не Оркестратор) — для широкой правки с обратными зависимостями быстрее и выгоднее включить Orchestrator (Neon · Средний/Высокий) или Hydrogen · Высокий/XHigh.`,
          tipEn: `💡 Mode tip: IDE log shows ${curEn} — for wide edits with reverse dependencies, Orchestrator (Neon · Medium/High) or Hydrogen · High/XHigh is faster and more quota-efficient.`,
        };
      }
      return {
        match: 'overprovisioned',
        currentDisplayRu: cur,
        currentDisplayEn: curEn,
        recommendedRu: 'Hydrogen · Высокий/XHigh',
        recommendedEn: 'Hydrogen · High/XHigh',
        tipRu: `💡 Совет по квоте (2D: широкий охват × типовая логика): сейчас выбран ${cur} — правки затрагивают много файлов без сложной архитектуры, поэтому быстрее и в 2–2.5 раза экономнее прогнать их на Hydrogen · Высокий / XHigh.`,
        tipEn: `💡 Quota tip (2D: Wide × Routine): currently on ${curEn} — edits span many files without complex architecture, so Hydrogen · High / XHigh runs faster and uses 2–2.5x less quota.`,
      };
    }
    return {
      match: 'underprovisioned',
      currentDisplayRu: cur,
      currentDisplayEn: curEn,
      recommendedRu: 'Hydrogen · Высокий/XHigh',
      recommendedEn: 'Hydrogen · High/XHigh',
      tipRu: `💡 Совет по режиму: сейчас выбран ${cur} — для широкой мульти-файловой правки лучше переключить на Hydrogen · Высокий / XHigh.`,
      tipEn: `💡 Mode tip: currently on ${curEn} — switch to Hydrogen · High / XHigh for wide multi-file edits.`,
    };
  }

  // 0. 2D-ветка C: Широкая интеграция средней глубины без новой сложной архитектуры (Wide × Integrated)
  if (breadth === 'wide' && depth === 'integrated' && !isDeepAuditOrArch) {
    if (
      isStrongOrch ||
      (modelProfile.isHydrogen && lvl === 'xhigh') ||
      (modelProfile.isNeon && lvl !== 'low') ||
      (modelProfile.isCarbon && lvl !== 'low')
    ) {
      const orchTip = !isStrongOrch && (modelProfile.isCarbon || modelProfile.isNeon)
        ? `💡 Совет по режиму: в логе IDE указан ${cur} (если это одиночная модель, а не Оркестратор) — для широкой интеграции нескольких модулей выгоднее включить Orchestrator (${modelProfile.isCarbon ? 'Carbon · Средний/Высокий' : 'Neon · Высокий'}) (план + быстрые правки на Hydrogen со скидкой -24%).`
        : '';
      const orchTipEn = !isStrongOrch && (modelProfile.isCarbon || modelProfile.isNeon)
        ? `💡 Mode tip: IDE log shows ${curEn} — for wide cross-module integration, Orchestrator (${modelProfile.isCarbon ? 'Carbon · Medium/High' : 'Neon · High'}) saves -24% quota via Hydrogen edits.`
        : '';
      return {
        match: 'optimal',
        currentDisplayRu: cur,
        currentDisplayEn: curEn,
        recommendedRu: recTarget,
        recommendedEn: recTargetEn,
        tipRu: orchTip,
        tipEn: orchTipEn,
      };
    }
    return {
      match: 'underprovisioned',
      currentDisplayRu: cur,
      currentDisplayEn: curEn,
      recommendedRu: recTarget,
      recommendedEn: recTargetEn,
      tipRu: `💡 Совет по режиму (2D: широкая интеграция): сейчас выбран ${cur} — для надёжной связки нескольких модулей лучше включить ${recTarget}.`,
      tipEn: `💡 Mode tip (2D: Wide Integration): currently on ${curEn} — switch to ${recTargetEn} for reliable multi-module wiring.`,
    };
  }

  // 0. 3D-ветка D: Высокий радиус поражения / критическое ядро (Z = critical_blast) при связной интеграции
  if (isHighBlast && depth !== 'routine' && grade !== 'XL') {
    if (
      isStrongOrch ||
      (modelProfile.isNeon && (lvl === 'high' || lvl === 'xhigh')) ||
      (modelProfile.isCarbon && lvl !== 'low') ||
      (modelProfile.isHydrogen && (lvl === 'high' || lvl === 'xhigh'))
    ) {
      const orchTip = !isStrongOrch && (modelProfile.isCarbon || modelProfile.isNeon)
        ? `💡 Совет по режиму: в логе IDE указан ${cur} (если это одиночная модель, а не Оркестратор) — при правке связующего модуля (High-Blast) выгоднее Orchestrator (${modelProfile.isCarbon ? 'Carbon · Средний/Высокий' : 'Neon · Высокий/XHigh'}) (-24% квоты + правки на Hydrogen).`
        : '';
      const orchTipEn = !isStrongOrch && (modelProfile.isCarbon || modelProfile.isNeon)
        ? `💡 Mode tip: IDE log shows ${curEn} — for High-Blast core edits, Orchestrator (${modelProfile.isCarbon ? 'Carbon · Medium/High' : 'Neon · High/XHigh'}) saves -24% quota via Hydrogen.`
        : '';
      return {
        match: 'optimal',
        currentDisplayRu: cur,
        currentDisplayEn: curEn,
        recommendedRu: recTarget,
        recommendedEn: recTargetEn,
        tipRu: orchTip,
        tipEn: orchTipEn,
      };
    }
    return {
      match: 'underprovisioned',
      currentDisplayRu: cur,
      currentDisplayEn: curEn,
      recommendedRu: recTarget,
      recommendedEn: recTargetEn,
      tipRu: `💡 Совет по режиму (3D: высокий радиус поражения ядра): сейчас выбран ${cur} — правка затрагивает связующий модуль с обратными зависимостями, лучше включить ${recTarget}.`,
      tipEn: `💡 Mode tip (3D: High-Blast Core): currently on ${curEn} — edit touches core reverse-dependent modules; switch to ${recTargetEn}.`,
    };
  }

  // 1. Сверхсложная архитектура, широкие мульти-подсистемные перестройки, аудит безопасности (Wide × Deep / XL)
  if (grade === 'XL' || isDeepAuditOrArch || (breadth === 'wide' && depth === 'deep_arch')) {
    if (
      (isStrongOrch && lvl !== 'medium') ||
      (modelProfile.isCarbon && lvl === 'high') ||
      (modelProfile.isNeon && (lvl === 'xhigh' || (lvl === 'high' && subscriptionTier === 'pro')))
    ) {
      const orchTip = !isStrongOrch && (modelProfile.isCarbon || modelProfile.isNeon)
        ? `💡 Совет по режиму: в логе IDE указан ${cur} (если это одиночная модель, а не Оркестратор) — для масштабной архитектуры XL выгоднее Orchestrator (${modelProfile.isCarbon ? 'Carbon · Высокий' : 'Neon · XHigh'}) (план + быстрые правки кода на Hydrogen со скидкой -24%).`
        : '';
      const orchTipEn = !isStrongOrch && (modelProfile.isCarbon || modelProfile.isNeon)
        ? `💡 Mode tip: IDE log shows ${curEn} — for XL architecture work, Orchestrator (${modelProfile.isCarbon ? 'Carbon · High' : 'Neon · XHigh'}) pairs deep planning with Hydrogen edits (-24% quota).`
        : '';
      return {
        match: 'optimal',
        currentDisplayRu: cur,
        currentDisplayEn: curEn,
        recommendedRu: recTarget,
        recommendedEn: recTargetEn,
        tipRu: orchTip,
        tipEn: orchTipEn,
      };
    }
    if ((isStrongOrch && lvl === 'medium') || isOrchLow) {
      return {
        match: 'underprovisioned',
        currentDisplayRu: cur,
        currentDisplayEn: curEn,
        recommendedRu: recTarget,
        recommendedEn: recTargetEn,
        tipRu: `💡 Совет по глубине планировщика: сейчас выбран ${cur} — для масштабной архитектуры XL лучше поднять глубину планировщика в меню Оркестратора до ${orchDepthTargetRu}.`,
        tipEn: `💡 Planner depth tip: currently on ${curEn} — raise Orchestrator planner depth to ${orchDepthTargetEn} for XL architecture work.`,
      };
    }
    if (modelProfile.isCarbon && lvl === 'medium') {
      const medCarbonTip = subscriptionTier === 'pro'
        ? `💡 Совет по режиму: для масштабной архитектуры XL на Pro используйте ${recTarget}.`
        : `💡 Совет по режиму: в логе IDE указан ${cur} (если это одиночная модель, а не Оркестратор) — для масштабной архитектуры XL выгоднее Orchestrator (Neon · XHigh) / Orchestrator (Carbon · Высокий) (план + быстрые правки кода на Hydrogen со скидкой -24%) или Neon · XHigh / Carbon · Высокий.`;
      const medCarbonTipEn = subscriptionTier === 'pro'
        ? `💡 Mode tip: on Pro tier, use ${recTargetEn} for XL architecture work.`
        : `💡 Mode tip: currently on ${curEn} — for XL architecture, Orchestrator (Neon · XHigh) / Orchestrator (Carbon · High) saves -24% quota via Hydrogen or use Neon · XHigh / Carbon · High.`;
      return {
        match: 'underprovisioned',
        currentDisplayRu: cur,
        currentDisplayEn: curEn,
        recommendedRu: recTarget,
        recommendedEn: recTargetEn,
        tipRu: medCarbonTip,
        tipEn: medCarbonTipEn,
      };
    }
    return {
      match: 'underprovisioned',
      currentDisplayRu: cur,
      currentDisplayEn: curEn,
      recommendedRu: recTarget,
      recommendedEn: recTargetEn,
      tipRu: `💡 Совет по режиму: сейчас выбран ${cur} — для сложной архитектуры XL лучше переключить селектор на ${recTarget}.`,
      tipEn: `💡 Mode tip: currently on ${curEn} — switch selector to ${recTargetEn} for complex XL architecture.`,
    };
  }

  // 2. Крупная мульти-файловая задача (L)
  if (grade === 'L') {
    if (modelProfile.isArgon || isArgonOrch) {
      const rateSuffix = isPostPromoRateActive()
        ? ' (Argon $4/$20 уступает Neon $3/$15 и Hydrogen $1.50/$7.50)'
        : ' (Hydrogen High 51 и Neon 61 обходят Argon 50 и выгоднее)';
      const rateSuffixEn = isPostPromoRateActive()
        ? ' (Argon $4/$20 trails Neon $3/$15 and Hydrogen $1.50/$7.50)'
        : ' (Hydrogen High 51 and Neon 61 outperform Argon 50 at lower cost)';
      return {
        match: 'overprovisioned',
        currentDisplayRu: cur,
        currentDisplayEn: curEn,
        recommendedRu: 'Orchestrator (Neon · Высокий) или Hydrogen · Высокий/XHigh',
        recommendedEn: 'Orchestrator (Neon · High) or Hydrogen · High/XHigh',
        tipRu: `💡 Совет по режиму и цене: сейчас выбран ${cur}${rateSuffix} — для задачи L быстрее и выгоднее Orchestrator (Neon · Высокий) или Hydrogen · Высокий / XHigh.`,
        tipEn: `💡 Mode & price tip: currently on ${curEn}${rateSuffixEn} — Orchestrator (Neon · High) or Hydrogen · High / XHigh is faster and cheaper for grade L.`,
      };
    }
    if (
      isStrongOrch ||
      (modelProfile.isNeon && lvl !== 'low') ||
      (modelProfile.isCarbon && lvl !== 'low') ||
      (modelProfile.isHydrogen && (lvl === 'high' || lvl === 'xhigh'))
    ) {
      const orchTip = !isStrongOrch && (modelProfile.isCarbon || modelProfile.isNeon)
        ? `💡 Совет по режиму: в логе IDE указан ${cur} (если это одиночная модель, а не Оркестратор) — для мульти-файловой задачи L быстрее и на 24% экономнее по квоте включить Orchestrator (${modelProfile.isCarbon ? 'Carbon · Средний/Высокий' : 'Neon · Высокий'}).`
        : '';
      const orchTipEn = !isStrongOrch && (modelProfile.isCarbon || modelProfile.isNeon)
        ? `💡 Mode tip: IDE log shows ${curEn} — for multi-file grade L, Orchestrator (${modelProfile.isCarbon ? 'Carbon · Medium/High' : 'Neon · High'}) is faster and saves 24% quota.`
        : '';
      return {
        match: 'optimal',
        currentDisplayRu: cur,
        currentDisplayEn: curEn,
        recommendedRu: recTarget,
        recommendedEn: recTargetEn,
        tipRu: orchTip,
        tipEn: orchTipEn,
      };
    }
    return {
      match: 'underprovisioned',
      currentDisplayRu: cur,
      currentDisplayEn: curEn,
      recommendedRu: recTarget,
      recommendedEn: recTargetEn,
      tipRu: isOrchLow
        ? `💡 Совет по глубине планировщика: сейчас выбран ${cur} — для мульти-файловой задачи L повысьте глубину планировщика в меню Оркестратора до ${orchDepthTargetRu}.`
        : `💡 Совет по режиму: сейчас выбран ${cur} — для мульти-файловой задачи L надёжнее и выгоднее включить ${recTarget}.`,
      tipEn: isOrchLow
        ? `💡 Planner depth tip: currently on ${curEn} — raise Orchestrator planner depth to ${orchDepthTargetEn} for multi-file grade L.`
        : `💡 Mode tip: currently on ${curEn} — switch to ${recTargetEn} for reliable multi-file grade L execution.`,
    };
  }

  // 3. Средняя рабочая задача (M — 1–2 файла, стандартные фичи и UI)
  if (grade === 'M') {
    if (modelProfile.isArgon || isArgonOrch) {
      return {
        match: 'overprovisioned',
        currentDisplayRu: cur,
        currentDisplayEn: curEn,
        recommendedRu: 'Hydrogen · Средний/Высокий или Orchestrator (Neon · Средний/Высокий)',
        recommendedEn: 'Hydrogen · Medium/High or Orchestrator (Neon · Medium/High)',
        tipRu: `💡 Совет по квоте: сейчас выбран ${cur} — Hydrogen · Средний/Высокий быстрее, точнее базового Argon (51 vs 50) и обходится дешевле ($1.50/$7.50).`,
        tipEn: `💡 Quota tip: currently on ${curEn} — Hydrogen · Medium/High is faster, stronger than baseline Argon (51 vs 50), and cheaper ($1.50/$7.50).`,
      };
    }
    if (
      (modelProfile.isCarbon ||
        ((lvl === 'high' || lvl === 'xhigh') && modelProfile.isNeon) ||
        (lvl === 'xhigh' && modelProfile.isHydrogen)) &&
      riskMode !== 'exploratory' &&
      !isHighBlast
    ) {
      return {
        match: 'overprovisioned',
        currentDisplayRu: cur,
        currentDisplayEn: curEn,
        recommendedRu: 'Hydrogen · Средний/Высокий или Orchestrator (Neon · Средний/Высокий)',
        recommendedEn: 'Hydrogen · Medium/High or Orchestrator (Neon · Medium/High)',
        tipRu: `💡 Совет по квоте: сейчас включён ${cur} — для задачи M быстрее и экономнее штатный Orchestrator (Neon · Средний/Высокий) (-24% квоты + правки на Hydrogen) или Hydrogen · Средний/Высокий.`,
        tipEn: `💡 Quota tip: currently on ${curEn} — Orchestrator (Neon · Medium/High) (-24% quota + Hydrogen edits) or Hydrogen · Medium/High is faster and leaner for grade M.`,
      };
    }
    if (lvl === 'low') {
      return {
        match: 'underprovisioned',
        currentDisplayRu: cur,
        currentDisplayEn: curEn,
        recommendedRu: 'Hydrogen · Средний или Orchestrator (Neon · Средний)',
        recommendedEn: 'Hydrogen · Medium or Orchestrator (Neon · Medium)',
        tipRu: `💡 Совет по режиму: сейчас стоит ${cur} — для задачи M лучше поставить Hydrogen · Средний/Высокий или Orchestrator (Neon · Средний/Высокий).`,
        tipEn: `💡 Mode tip: currently on ${curEn} — use Hydrogen · Medium/High or Orchestrator (Neon · Medium/High) for grade M.`,
      };
    }
    return {
      match: 'optimal',
      currentDisplayRu: cur,
      currentDisplayEn: curEn,
      recommendedRu: 'Hydrogen · Средний/Высокий или Orchestrator (Neon · Средний/Высокий)',
      recommendedEn: 'Hydrogen · Medium/High or Orchestrator (Neon · Medium/High)',
      tipRu: '',
      tipEn: '',
    };
  }

  // 4. Мелкая быстрая правка (S)
  if (
    (lvl === 'high' && (modelProfile.isCarbon || modelProfile.isArgon)) ||
    ((lvl === 'high' || lvl === 'xhigh') && modelProfile.isNeon) ||
    (lvl === 'xhigh' && modelProfile.isHydrogen) ||
    (isStrongOrchBase && (lvl === 'xhigh' || (modelProfile.plannerTier === 'carbon' && lvl === 'high'))) ||
    modelProfile.isArgon ||
    isArgonOrch
  ) {
    return {
      match: 'overprovisioned',
      currentDisplayRu: cur,
      currentDisplayEn: curEn,
      recommendedRu: modelProfile.isOrchestrator && !isArgonOrch
        ? 'Hydrogen · Средний или Orchestrator (Neon · Средний)'
        : 'Hydrogen · Средний или Flash 3.8 · Низкий/Средний',
      recommendedEn: modelProfile.isOrchestrator && !isArgonOrch
        ? 'Hydrogen · Medium or Orchestrator (Neon · Medium)'
        : 'Hydrogen · Medium or Flash 3.8 · Low/Medium',
      tipRu: modelProfile.isOrchestrator && !isArgonOrch
        ? `💡 Совет по квоте: выбран ${cur} — на мелких правках S достаточно снизить глубину планировщика до Orchestrator (Neon · Средний) или включить Hydrogen · Средний.`
        : `💡 Совет по квоте: выбран ${cur} — на мелких правках S мгновенно и экономно работает Hydrogen · Средний (или Orchestrator (Neon · Средний) без лишних опросов).`,
      tipEn: modelProfile.isOrchestrator && !isArgonOrch
        ? `💡 Quota tip: currently on ${curEn} — for tiny S edits, drop planner depth to Orchestrator (Neon · Medium) or use Hydrogen · Medium.`
        : `💡 Quota tip: currently on ${curEn} — Hydrogen · Medium (or Orchestrator (Neon · Medium)) handles small S fixes rapidly with minimal quota.`,
    };
  }

  return {
    match: 'optimal',
    currentDisplayRu: cur,
    currentDisplayEn: curEn,
    recommendedRu: 'Hydrogen · Средний / Orchestrator (Neon · Средний) / Flash 3.8 · Средний',
    recommendedEn: 'Hydrogen · Medium / Orchestrator (Neon · Medium) / Flash 3.8 · Medium',
    tipRu: '',
    tipEn: '',
  };
}

/**
 * Формирует компактный паспорт текущей выбранной модели для промпт-инъекции PreInvocation,
 * чтобы ИИ-Автопилот точно знал текущий селектор окна и нюансы Hydrogen / Orchestrator.
 * @param {ReturnType<typeof normalizeModelProfile>|null} [modelProfile=null]
 * @param {'en'|'ru'} [lang='ru']
 * @returns {string}
 */
export function formatSelectorSnapshotForPrompt(modelProfile = null, lang = 'ru') {
  if (!modelProfile || modelProfile.tier === 'unknown') return '';
  const isEn = String(lang || '').trim().toLowerCase() === 'en';
  const disp = isEn
    ? (modelProfile.displayEn || modelProfile.shortLabel || modelProfile.label)
    : (modelProfile.displayRu || modelProfile.shortLabel || modelProfile.label);
  if (!modelProfile.isOrchestrator && modelProfile.tier !== 'flash_lite' && !modelProfile.thinkingLevel) {
    return isEn ? `[Active Selector: ${disp} · Auto]` : `[Active Selector: ${disp} · Авто]`;
  }
  return `[Active Selector: ${disp}]`;
}

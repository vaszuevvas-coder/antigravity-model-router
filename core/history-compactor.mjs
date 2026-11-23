/**
 * @file history-compactor.mjs
 * @description Модуль Cache-Aligned History Compaction (#4).
 * Контролирует размер контекста модели с учётом физики префиксного KV-кэша:
 * сжатие и уведомления активируются строго на дискретных границах эпох (thresholdTokens),
 * сохраняя 100% стабильность префикса между эпохами без мутирующих вставок.
 */

import { closeSync, existsSync, mkdirSync, openSync, readSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSubagentTranscriptFile, peekActiveModelFromTranscript, resolveEffectiveCompactionThreshold } from './model-profile.mjs';
import { invalidateReadCacheForConvo } from './read-dedup.mjs';
import { atomicWriteJsonSync, safeReadJsonSync, updateJsonAtomicSync } from './safe-json.mjs';
import { ensureTunnelCacheDir, resolveTunnelCacheDir } from './cache-dir.mjs';
import { extractDeterministicFactTable } from './cpu-sbfl-healer.mjs';
import { normalizeLang, pickLang } from './i18n.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, '..');
const MAX_COMPACTION_ENTRIES = 64;
const UNSAFE_PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty']);

function getCacheDir() {
  return resolveTunnelCacheDir(PLUGIN_ROOT);
}

function getStateFile() {
  return join(getCacheDir(), 'compaction-state.json');
}

function pruneCompactionRecords(
  epochs = {},
  resetTimestamps = {},
  maxEntries = MAX_COMPACTION_ENTRIES,
  strategicNotifiedEpochs = {}
) {
  const safeEpochs = epochs && typeof epochs === 'object' && !Array.isArray(epochs) ? epochs : {};
  const safeResets = resetTimestamps && typeof resetTimestamps === 'object' && !Array.isArray(resetTimestamps) ? resetTimestamps : {};
  const safeStrategic =
    strategicNotifiedEpochs && typeof strategicNotifiedEpochs === 'object' && !Array.isArray(strategicNotifiedEpochs)
      ? strategicNotifiedEpochs
      : {};
  const allKeys = Array.from(new Set([...Object.keys(safeEpochs), ...Object.keys(safeResets), ...Object.keys(safeStrategic)]))
    .filter((k) => k && !UNSAFE_PROTO_KEYS.has(k));
  if (allKeys.length > maxEntries) {
    allKeys.sort((a, b) => (Number(safeResets[b] || 0) || 0) - (Number(safeResets[a] || 0) || 0));
  }
  const kept = allKeys.slice(0, maxEntries);
  const nextEpochs = {};
  const nextResets = {};
  const nextStrategic = {};
  for (const k of kept) {
    if (Object.hasOwn(safeEpochs, k)) nextEpochs[k] = safeEpochs[k];
    if (Object.hasOwn(safeResets, k)) nextResets[k] = safeResets[k];
    if (Object.hasOwn(safeStrategic, k)) nextStrategic[k] = safeStrategic[k];
  }
  return { epochs: nextEpochs, resetTimestamps: nextResets, strategicNotifiedEpochs: nextStrategic };
}

/**
 * Normalizes conversation ID by stripping workspace suffix (`__<8-hex>`) and rejecting prototype keys.
 * @param {string} [rawCid='default']
 * @returns {string}
 */
export function normalizeCompactionConvoId(rawCid = 'default') {
  const clean = String(rawCid || 'default').trim().replace(/^["'\s]+|["'\s]+$/g, '') || 'default';
  const stripped = clean.replace(/__[0-9a-f]{8}$/i, '') || 'default';
  return UNSAFE_PROTO_KEYS.has(stripped) ? 'default' : stripped;
}

/**
 * Checks whether a transcript step represents a compaction boundary (IDE CHECKPOINT or CONTEXT_SUMMARY).
 * @param {object} step
 * @returns {boolean}
 */
export function isCompactionBoundaryStep(step) {
  if (!step || typeof step !== 'object') return false;
  if (step.type === 'CHECKPOINT') return true;
  const content = typeof step.content === 'string' ? step.content : '';
  return content.includes('<CONTEXT_SUMMARY>') || content.includes('# Resuming from a compaction');
}

/**
 * Обеспечивает существование директории кэша.
 */
function ensureCacheDir() {
  ensureTunnelCacheDir(getCacheDir());
}

/**
 * Оценивает количество токенов в тексте с учётом веса кириллицы (~2.2 симв/ток) и латиницы/кода (~4 симв/ток).
 * @param {string} text
 * @returns {number}
 */
function estimateTextTokens(text = '') {
  if (!text || typeof text !== 'string') return 0;
  let cyr = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0x0400 && code <= 0x04ff) cyr++;
  }
  const nonCyr = text.length - cyr;
  return Math.round(cyr / 2.2 + nonCyr / 4);
}

/**
 * Загружает состояние эпох сжатия без гонок через safe-json.
 * @returns {{ epochs: Record<string, number>, totalCompactions: number }}
 */
function loadCompactionState() {
  ensureCacheDir();
  const raw = safeReadJsonSync(
    getStateFile(),
    () => ({ epochs: {}, resetTimestamps: {}, strategicNotifiedEpochs: {}, totalCompactions: 0 }),
    { selfHeal: true }
  );
  return {
    epochs: raw && raw.epochs && typeof raw.epochs === 'object' ? raw.epochs : {},
    resetTimestamps: raw && raw.resetTimestamps && typeof raw.resetTimestamps === 'object' ? raw.resetTimestamps : {},
    strategicNotifiedEpochs:
      raw && raw.strategicNotifiedEpochs && typeof raw.strategicNotifiedEpochs === 'object'
        ? raw.strategicNotifiedEpochs
        : {},
    totalCompactions: Number(raw?.totalCompactions || 0),
  };
}

/**
 * Сохраняет состояние эпох сжатия (атомарно через safe-json).
 * @param {object} state
 */
function saveCompactionState(state) {
  ensureCacheDir();
  try {
    atomicWriteJsonSync(getStateFile(), state, { spaces: 0 });
  } catch {}
}

function pruneCompactionDigests(maxKeep = 10) {
  try {
    const cacheDir = getCacheDir();
    if (!existsSync(cacheDir)) return;
    const files = [];
    for (const ent of readdirSync(cacheDir, { withFileTypes: true })) {
      if (ent.isFile() && /^compaction-digest-.*\.md$/i.test(ent.name)) {
        const fullPath = join(cacheDir, ent.name);
        try {
          const st = statSync(fullPath);
          if (st.size === 0) {
            try { unlinkSync(fullPath); } catch {}
            continue;
          }
          files.push({ fullPath, mtimeMs: st.mtimeMs });
        } catch {}
      }
    }
    if (files.length <= maxKeep) return;
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (let i = maxKeep; i < files.length; i++) {
      try {
        unlinkSync(files[i].fullPath);
      } catch {}
    }
  } catch {}
}

/**
 * Быстро читает конец transcript.jsonl без загрузки многомегабайтного файла целиком (Tail-Read 256 КБ).
 * Распознаёт границы CHECKPOINT и <CONTEXT_SUMMARY> для сброса счётчика и учитывает вес кириллицы.
 * @param {string} transcriptPath Путь к transcript.jsonl
 * @param {number} [tailBytes=262144] Размер считываемого с конца буфера
 * @returns {{ lastStepPromptTokens: number, approxSteps: number, fileSize: number, contextSummaryReset: boolean, hasExplicitTokens: boolean }}
 */
export function fastPeekTranscriptTail(transcriptPath, tailBytes = 262144) {
  if (!transcriptPath || !existsSync(transcriptPath)) {
    return { lastStepPromptTokens: 0, approxSteps: 0, fileSize: 0, contextSummaryReset: false, hasExplicitTokens: false };
  }

  let stat;
  try {
    stat = statSync(transcriptPath);
  } catch {
    return { lastStepPromptTokens: 0, approxSteps: 0, fileSize: 0, contextSummaryReset: false, hasExplicitTokens: false };
  }

  const fileSize = stat.size;
  if (fileSize === 0) {
    return { lastStepPromptTokens: 0, approxSteps: 0, fileSize: 0, contextSummaryReset: false, hasExplicitTokens: false };
  }

  const bytesToRead = Math.min(fileSize, tailBytes);
  const buffer = Buffer.alloc(bytesToRead);
  const position = fileSize - bytesToRead;

  let fd = null;
  try {
    fd = openSync(transcriptPath, 'r');
    readSync(fd, buffer, 0, bytesToRead, position);
  } catch {
    return { lastStepPromptTokens: 0, approxSteps: 0, fileSize, contextSummaryReset: false, hasExplicitTokens: false };
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {}
    }
  }

  const tailText = buffer.toString('utf-8');
  const rawLines = tailText.split('\n');

  // Отбрасываем самую первую (потенциально неполную) строку, если файл больше считанного буфера
  const validLines = fileSize > tailBytes && rawLines.length > 1
    ? rawLines.slice(1)
    : rawLines;

  let lastStepPromptTokens = 0;
  let lastStepIndex = -1;
  let parsedStepsInTail = 0;
  let postResetTokens = 0;
  let totalTailTokens = 0;
  let contextSummaryReset = false;
  let hasExplicitTokens = false;

  for (let i = validLines.length - 1; i >= 0; i--) {
    const line = validLines[i].trim();
    if (!line) continue;
    if (
      lastStepPromptTokens > 0 &&
      lastStepIndex >= 0 &&
      !line.includes('CHECKPOINT') &&
      !line.includes('<CONTEXT_SUMMARY>') &&
      !line.includes('Resuming from a compaction')
    ) {
      continue;
    }
    try {
      const step = JSON.parse(line);
      parsedStepsInTail++;
      if (lastStepIndex === -1 && typeof step.step_index === 'number') {
        lastStepIndex = step.step_index;
      }
      const stepContent = typeof step.content === 'string' ? step.content : '';
      const stepTok = estimateTextTokens(stepContent) + (typeof step.thinking === 'string' ? estimateTextTokens(step.thinking) : 0);
      totalTailTokens += stepTok;

      // Check compaction boundary BEFORE reading tokens: IDE CHECKPOINT steps carry pre-compaction cache_read_tokens
      if (isCompactionBoundaryStep(step)) {
        contextSummaryReset = true;
        postResetTokens += stepTok;
        break;
      }

      postResetTokens += stepTok;

      if (lastStepPromptTokens === 0 && (step.input_tokens || step.cache_read_tokens)) {
        lastStepPromptTokens = Number(step.input_tokens || 0) + Number(step.cache_read_tokens || 0);
        hasExplicitTokens = true;
      }
    } catch {}
  }

  let approxSteps = 0;
  if (lastStepIndex >= 0) {
    approxSteps = lastStepIndex + 1;
  } else if (parsedStepsInTail > 0 && bytesToRead > 0) {
    approxSteps = Math.max(parsedStepsInTail, Math.round((parsedStepsInTail / bytesToRead) * fileSize));
  } else {
    approxSteps = Math.max(1, Math.round(fileSize / 1500));
  }

  if (lastStepPromptTokens === 0) {
    if (contextSummaryReset) {
      lastStepPromptTokens = postResetTokens;
    } else if (fileSize <= tailBytes && totalTailTokens > 0) {
      lastStepPromptTokens = totalTailTokens;
    } else if (bytesToRead > 0 && totalTailTokens > 0) {
      lastStepPromptTokens = Math.round((totalTailTokens / bytesToRead) * fileSize);
    } else {
      lastStepPromptTokens = Math.round(fileSize / 4);
    }
  }

  return { lastStepPromptTokens, approxSteps, fileSize, contextSummaryReset, hasExplicitTokens };
}

/**
 * Находит активный путь к transcript.jsonl без сканирования чужих диалогов, если conversationId задан явно.
 * @param {string} [preferredPath='']
 * @param {string} [conversationId='']
 * @returns {{ transcriptPath: string|null, conversationId: string|null }}
 */
function resolveTranscriptPath(preferredPath = '', conversationId = '') {
  const explicitProvided = Boolean(
    (preferredPath && String(preferredPath).trim()) ||
    (conversationId && String(conversationId).trim())
  );

  if (preferredPath && existsSync(preferredPath)) {
    return { transcriptPath: preferredPath, conversationId: conversationId || null };
  }

  const brainRoots = ['antigravity', 'antigravity-ide', 'antigravity-cli']
    .map((d) => join(homedir(), '.gemini', d, 'brain'))
    .filter((p) => existsSync(p));
  if (brainRoots.length === 0) {
    return { transcriptPath: null, conversationId: conversationId || null };
  }

  const baseCid = conversationId
    ? normalizeCompactionConvoId(conversationId).replace(/[^a-zA-Z0-9_-]/g, '')
    : '';

  // Если передан конкретный conversationId — проверяем строго его папку
  if (baseCid) {
    for (const bDir of brainRoots) {
      const directPath = join(bDir, baseCid, '.system_generated', 'logs', 'transcript.jsonl');
      if (existsSync(directPath)) {
        return { transcriptPath: directPath, conversationId: baseCid };
      }
    }
  }

  if (explicitProvided) {
    return { transcriptPath: null, conversationId: baseCid || null };
  }

  // Только если ни путь, ни conversationId не указаны — ищем самый свежий основной диалог (исключая субагентов)
  let latestMainPath = null;
  let latestMainMtime = 0;
  let latestMainConvo = null;
  let latestAnyPath = null;
  let latestAnyMtime = 0;
  let latestAnyConvo = null;

  for (const brainDir of brainRoots) {
    try {
      const entries = readdirSync(brainDir, { withFileTypes: true });
      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        const tPath = join(brainDir, ent.name, '.system_generated', 'logs', 'transcript.jsonl');
        if (existsSync(tPath)) {
          try {
            const st = statSync(tPath);
            if (st.mtimeMs > latestAnyMtime) {
              latestAnyMtime = st.mtimeMs;
              latestAnyPath = tPath;
              latestAnyConvo = ent.name;
            }
            if (!isSubagentTranscriptFile(tPath) && st.mtimeMs > latestMainMtime) {
              latestMainMtime = st.mtimeMs;
              latestMainPath = tPath;
              latestMainConvo = ent.name;
            }
          } catch {}
        }
      }
    } catch {}
  }

  return {
    transcriptPath: latestMainPath || latestAnyPath,
    conversationId: latestMainPath ? latestMainConvo : latestAnyConvo,
  };
}

/**
 * Извлекает шаги и информацию об использовании токенов из transcript.jsonl.
 * @param {string} transcriptPath
 * @returns {{ steps: Array<object>, lastStepPromptTokens: number, totalSteps: number }}
 */
function parseTranscript(transcriptPath) {
  if (!transcriptPath || typeof transcriptPath !== 'string' || !existsSync(transcriptPath)) {
    return { steps: [], lastStepPromptTokens: 0, totalSteps: 0 };
  }

  try {
    if (!statSync(transcriptPath).isFile()) {
      return { steps: [], lastStepPromptTokens: 0, totalSteps: 0 };
    }
    const content = readFileSync(transcriptPath, 'utf-8');
    const lines = content.split('\n');
    const steps = [];
    let lastStepPromptTokens = 0;

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const step = JSON.parse(line);
        steps.push(step);
        if (step.input_tokens || step.cache_read_tokens) {
          lastStepPromptTokens = Number(step.input_tokens || 0) + Number(step.cache_read_tokens || 0);
        }
      } catch {}
    }

    // Если токены не были явно указаны в объектах шагов, производим эвристическую оценку (chars / 4)
    if (lastStepPromptTokens === 0 && steps.length > 0) {
      const totalChars = steps.reduce((sum, s) => sum + (typeof s.content === 'string' ? s.content.length : 0), 0);
      lastStepPromptTokens = Math.round(totalChars / 4);
    }

    return { steps, lastStepPromptTokens, totalSteps: steps.length };
  } catch (err) {
    console.error('[compactor] Failed to parse transcript:', err);
    return { steps: [], lastStepPromptTokens: 0, totalSteps: 0 };
  }
}

function isDaemonPidAlive(pid) {
  const num = Number(pid);
  if (!Number.isInteger(num) || num <= 0) return false;
  try {
    process.kill(num, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/**
 * Best-effort non-blocking archive of pre-compaction digest to live RAM daemon for RepairKV recall.
 * @param {object} [params]
 * @returns {Promise<boolean>}
 */
export function postCompactionArchiveBestEffort(opts = {}) {
  const { convoId = 'default', wsPath = '', rawText = '', timeoutMs = 45 } = opts && typeof opts === 'object' ? opts : {};
  try {
    if (!rawText || typeof rawText !== 'string') return Promise.resolve(false);
    const daemonFile = join(getCacheDir(), 'ram-daemon.json');
    if (!existsSync(daemonFile)) return Promise.resolve(false);
    const info = safeReadJsonSync(daemonFile, null, { selfHeal: false });
    if (!info || typeof info !== 'object') return Promise.resolve(false);

    const candidates = [];
    if (info.instances && typeof info.instances === 'object') {
      for (const inst of Object.values(info.instances)) {
        if (inst && inst.port && inst.token && isDaemonPidAlive(inst.pid)) {
          candidates.push(inst);
        }
      }
    }
    if (candidates.length === 0 && info.port && info.token && isDaemonPidAlive(info.pid)) {
      candidates.push(info);
    }
    if (candidates.length === 0) return Promise.resolve(false);

    let chosen = null;
    if (wsPath) {
      const absTarget = resolve(wsPath);
      const normTarget = process.platform === 'win32' ? absTarget.toLowerCase() : absTarget;
      chosen = candidates.find(
        (c) =>
          Array.isArray(c.workspaces) &&
          c.workspaces.some((w) => {
            const nw = process.platform === 'win32' ? resolve(String(w)).toLowerCase() : resolve(String(w));
            return nw === normTarget;
          })
      );
    }
    if (!chosen) {
      candidates.sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
      chosen = candidates[0];
    }
    if (!chosen?.port || !chosen?.token) return Promise.resolve(false);

    const payload = JSON.stringify({
      convoId: String(convoId || 'default'),
      wsPath: String(wsPath || ''),
      rawText,
    });
    return new Promise((resolveArchive) => {
      let settled = false;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        resolveArchive(ok);
      };
      const timer = setTimeout(() => {
        try { req.destroy(); } catch {}
        done(false);
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();

      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: Number(chosen.port),
          path: '/hook/compaction-archive',
          method: 'POST',
          timeout: timeoutMs,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            'x-ram-token': String(chosen.token),
          },
        },
        (res) => {
          res.resume();
          res.on('end', () => {
            clearTimeout(timer);
            done(res.statusCode >= 200 && res.statusCode < 300);
          });
        }
      );
      req.on('socket', (sock) => {
        if (typeof sock?.unref === 'function') sock.unref();
      });
      req.on('timeout', () => {
        clearTimeout(timer);
        try { req.destroy(); } catch {}
        done(false);
      });
      req.on('error', () => {
        clearTimeout(timer);
        done(false);
      });
      req.end(payload);
    });
  } catch {
    return Promise.resolve(false);
  }
}

/**
 * Создаёт замороженный дайджест ранней истории диалога.
 * @param {string} transcriptPath Путь к transcript.jsonl
 * @param {string} conversationId ID диалога
 * @param {string} [workspaceRoot=''] Путь к корню workspace
 * @returns {{ digestPath: string, compressedSteps: number, digestMarkdown: string }}
 */
export function buildCompactionDigest(transcriptPath, conversationId = '', workspaceRoot = '') {
  ensureCacheDir();
  const shortId = (conversationId || 'latest').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 8);
  const digestPath = join(getCacheDir(), `compaction-digest-${shortId}.md`);

  const { steps } = parseTranscript(transcriptPath);
  const earlySteps = steps.slice(0, Math.max(0, steps.length - 12));

  const touchedFiles = new Set();
  const userQueries = [];
  const subagentRoles = [];
  const assistantHighlights = [];

  for (const step of earlySteps) {
    // Пользовательские запросы
    if (step.type === 'USER_INPUT' || step.source === 'USER_EXPLICIT') {
      let text = typeof step.content === 'string' ? step.content : '';
      const reqMatch = text.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i);
      if (reqMatch) {
        text = reqMatch[1];
      } else {
        text = text
          .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '')
          .replace(/<SYSTEM_MESSAGE>[\s\S]*?<\/SYSTEM_MESSAGE>/gi, '')
          .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, '');
      }
      text = text.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
      if (text && !text.startsWith('<') && !text.startsWith('Error:')) {
        userQueries.push(text.slice(0, 140));
      }
    }

    if ((step.type === 'PLANNER_RESPONSE' || step.source === 'MODEL') && typeof step.content === 'string') {
      const cleanAssistant = step.content
        .replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, ' ')
        .replace(/\r?\n/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (cleanAssistant && cleanAssistant.length >= 24) {
        assistantHighlights.push(cleanAssistant.slice(0, 220));
      }
    }

    // Инструменты и файлы
    if (Array.isArray(step.tool_calls)) {
      for (const tc of step.tool_calls) {
        const name = tc.name || '';
        const args = tc.args || {};
        if (['edit_file', 'write_file', 'read_file'].includes(name)) {
          const p = args.Path || args.path || args.filePath;
          if (p) {
            const cleanBase = basename(String(p)).replace(/["'`]+$/g, '').trim();
            if (cleanBase) touchedFiles.add(cleanBase);
          }
        }
        if (name === 'invoke_subagent') {
          const role = args.Role || args.TypeName || args.role || 'Subagent';
          if (!subagentRoles.includes(role)) {
            subagentRoles.push(role);
          }
        }
      }
    }
  }

  const filesList = Array.from(touchedFiles).slice(0, 20);
  const queriesList = userQueries.slice(0, 8);
  const rawParts = [];
  if (userQueries.length > 0) {
    rawParts.push(`USER GOALS:\n${userQueries.map((q) => `- ${q}`).join('\n')}`);
  }
  if (filesList.length > 0) {
    rawParts.push(`TOUCHED FILES:\n${filesList.join(', ')}`);
  }
  if (assistantHighlights.length > 0) {
    rawParts.push(`MODEL ACTIONS & OUTCOMES:\n${assistantHighlights.map((h, idx) => `${idx + 1}. ${h}`).join('\n')}`);
  }
  const rawEarlySummaryText = rawParts.join('\n\n').slice(0, 9000);

  const agentDiet = analyzeAgentDietTrajectoryWaste(earlySteps);
  const cpuFactBlock = extractDeterministicFactTable(earlySteps);

  const digestMarkdown = [
    `# History Digest`,
    `- Convo: \`${conversationId || 'current'}\``,
    `- Compressed steps: ${earlySteps.length} / ${steps.length}`,
    ...(agentDiet.supersededStepCount > 0
      ? [`- AgentDiet Waste: ${agentDiet.supersededStepCount} superseded steps (~${agentDiet.estimatedPrunedTokens} tok)`]
      : []),
    `- Timestamp: ${new Date().toISOString()}`,
    ``,
    `### Touched files:`,
    filesList.length > 0 ? filesList.map((f) => `- \`${f}\``).join('\n') : `- (none)`,
    ``,
    `### User goals:`,
    queriesList.length > 0 ? queriesList.map((q) => `- ${q}`).join('\n') : `- (none)`,
    ...(cpuFactBlock ? ['', cpuFactBlock] : []),
    ``,
    `### Subagents:`,
    subagentRoles.length > 0 ? subagentRoles.map((r) => `- ${r}`).join('\n') : `- Direct`
  ].join('\n');

  try {
    writeFileSync(digestPath, digestMarkdown, 'utf-8');
    pruneCompactionDigests(10);
  } catch (err) {
    console.error('[compactor] Failed to write compaction digest:', err);
  }

  void postCompactionArchiveBestEffort({
    convoId: conversationId || 'default',
    wsPath: workspaceRoot || '',
    rawText: digestMarkdown,
  });

  return {
    digestPath,
    compressedSteps: earlySteps.length,
    digestMarkdown,
    rawEarlySummaryText,
    agentDiet,
  };
}

/**
 * AgentDiet trajectory analyzer: detects superseded observations (stale file reads
 * overwritten by later edits/re-reads, and old test-failure logs cleared by later passing runs).
 * @param {Array<object>} [steps=[]]
 * @returns {{ supersededStepCount: number, estimatedPrunedTokens: number, uniqueActiveFiles: string[] }}
 */
export function analyzeAgentDietTrajectoryWaste(steps = []) {
  if (!Array.isArray(steps) || steps.length === 0) {
    return { supersededStepCount: 0, estimatedPrunedTokens: 0, uniqueActiveFiles: [] };
  }

  const readIndexesByFile = new Map();
  const supersededIndices = new Set();
  const activeFiles = new Set();
  const pendingTestFailureIndices = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step || typeof step !== 'object') continue;

    const toolCalls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
    for (const tc of toolCalls) {
      const name = String(tc?.name || '');
      const args = tc?.args || {};
      const rawPath = args.Path || args.path || args.filePath || '';
      const normFile = rawPath ? String(rawPath).replace(/\\/g, '/').toLowerCase() : '';
      if (normFile) {
        activeFiles.add(basename(normFile));
      }

      if ((name === 'read_file' || name === 'ram_slice' || name === 'mcp_antigravity-model-router_ram-memory_ram_slice') && normFile) {
        if (!readIndexesByFile.has(normFile)) readIndexesByFile.set(normFile, []);
        const prevReads = readIndexesByFile.get(normFile);
        for (const prevIdx of prevReads) supersededIndices.add(prevIdx);
        prevReads.length = 0;
        prevReads.push(i);
      } else if ((name === 'edit_file' || name === 'write_file') && normFile) {
        const prevReads = readIndexesByFile.get(normFile);
        if (prevReads && prevReads.length > 0) {
          for (const prevIdx of prevReads) supersededIndices.add(prevIdx);
          prevReads.length = 0;
        }
      }
    }

    const content = typeof step.content === 'string' ? step.content : '';
    if (content) {
      const hasFail = /(?:AssertionError|✖|not ok\b|\bfail\s+[1-9]\d*)/i.test(content) || /\bFAIL\b/.test(content);
      const hasPass = /(?:\bfail\s+0\b|\b0\s+failed\b|✔.*\bpassed\b)/i.test(content) && !hasFail;
      if (hasFail) {
        pendingTestFailureIndices.push(i);
      } else if (hasPass && pendingTestFailureIndices.length > 0) {
        for (const fIdx of pendingTestFailureIndices) supersededIndices.add(fIdx);
        pendingTestFailureIndices.length = 0;
      }
    }
  }

  let estimatedPrunedTokens = 0;
  for (const idx of supersededIndices) {
    const st = steps[idx];
    const txt = typeof st?.content === 'string' ? st.content : JSON.stringify(st || '');
    estimatedPrunedTokens += Math.max(12, estimateTextTokens(txt));
  }

  return {
    supersededStepCount: supersededIndices.size,
    estimatedPrunedTokens,
    uniqueActiveFiles: Array.from(activeFiles),
  };
}

/**
 * Обогащает дайджест эпохи технической выжимкой от локальной GPU-модели (gemma4:12b) при достаточном объёме текста.
 * @param {object} digestRes
 * @param {object} [opts={}]
 */
export async function enrichCompactionDigestWithGpu(digestRes, { timeoutMs = 4500 } = {}) {
  if (!digestRes || typeof digestRes !== 'object') return digestRes;
  if (process.env.TUNNEL_TEST_ISOLATE_INSTALLED === '1') return digestRes;
  if (!digestRes.rawEarlySummaryText || digestRes.rawEarlySummaryText.length < 900) {
    return digestRes;
  }
  try {
    const { distillText, loadGpuConfig } = await import('./local-gpu-engine.mjs');
    const cfg = loadGpuConfig();
    if (!cfg.gpuEnabled || !cfg.gpuAutoDistillLogs) {
      return digestRes;
    }
    const gpuRes = await distillText({
      text: digestRes.rawEarlySummaryText,
      query: 'Summarize completed code changes, architectural decisions, resolved errors, and pending items.',
      mode: 'general',
      maxOutputTokens: 260,
      timeoutMs,
      strictTimeout: true,
      minFreeVramMb: 5500,
    });
    if (gpuRes?.ok && gpuRes.summary) {
      const updatedMarkdown = `${digestRes.digestMarkdown}\n\n### 🎮 Local GPU Technical Summary (${gpuRes.model}):\n${gpuRes.summary}\n`;
      if (digestRes.digestPath) {
        try {
          writeFileSync(digestRes.digestPath, updatedMarkdown, 'utf-8');
        } catch {}
      }
      return {
        ...digestRes,
        digestMarkdown: updatedMarkdown,
        gpuSummary: gpuRes.summary,
      };
    }
  } catch {}
  return digestRes;
}

/**
 * Проверяет границы эпох KV-кэша и выставляет уведомление только при наступлении новой эпохи.
 * Между эпохами НЕ добавляет мутирующих инструкций, сохраняя 100% стабильность кэша.
 * @param {object} params
 * @param {string} [params.conversationId=''] ID диалога
 * @param {string} [params.transcriptPath=''] Путь к transcript.jsonl
 * @param {number} [params.thresholdTokens=120000] Порог токенов одной эпохи
 * @param {boolean} [params.readOnly=false] Режим чтения (без записи состояния и генерации дайджеста, например для UI-поллинга)
 * @returns {Promise<{ epoch: number, lastPromptTokens: number, tokensInEpoch: number, thresholdTokens: number, fillPercent: number, totalFillPercent: number, needsCompaction: boolean, digestPath: string|null, compactionNotice: string|null, activeModel: string|null }>}
 */
const VALID_PHASE_TRANSITIONS = new Set(['explore_to_edit', 'verify_passed', 'milestone_done']);

export async function checkHistoryCompaction({
  conversationId = '',
  transcriptPath = '',
  thresholdTokens = 120000,
  readOnly = false,
  workspaceRoot = '',
  phaseTransition = '',
  strategicMinFillRatio = 0.55,
  lang = 'ru',
} = {}) {
  const resolvedLang = normalizeLang(lang, 'ru');
  const isEn = resolvedLang === 'en';
  const resolved = resolveTranscriptPath(transcriptPath, conversationId);
  const rawConvoId = String(resolved.conversationId || conversationId || 'default').trim() || 'default';
  const safeRawConvoId = UNSAFE_PROTO_KEYS.has(rawConvoId) ? 'default' : rawConvoId;
  const convoId = normalizeCompactionConvoId(safeRawConvoId);
  const modelProfile = peekActiveModelFromTranscript(resolved.transcriptPath || '', convoId);
  const effectiveThreshold = resolveEffectiveCompactionThreshold(thresholdTokens, modelProfile);

  // Используем сверхбыстрый Tail-Read 256 КБ (<2 мс) с распознаванием сброса CHECKPOINT / <CONTEXT_SUMMARY>
  const tailInfo = fastPeekTranscriptTail(resolved.transcriptPath);
  const lastStepPromptTokens = tailInfo.lastStepPromptTokens;
  const currentEpoch = effectiveThreshold > 0 ? Math.floor(lastStepPromptTokens / effectiveThreshold) : 0;
  const tokensInEpoch = effectiveThreshold > 0 ? lastStepPromptTokens % effectiveThreshold : 0;
  const fillPercent = effectiveThreshold > 0
    ? Math.min(100, Math.round((tokensInEpoch / effectiveThreshold) * 100))
    : 0;
  const totalFillPercent = effectiveThreshold > 0
    ? Math.round((lastStepPromptTokens / effectiveThreshold) * 100)
    : 0;

  const state = loadCompactionState();
  const savedBase = Object.hasOwn(state.epochs, convoId) ? Number(state.epochs[convoId] || 0) : 0;
  const savedRaw = Object.hasOwn(state.epochs, safeRawConvoId) ? Number(state.epochs[safeRawConvoId] || 0) : 0;
  let savedEpoch = Math.max(savedBase, savedRaw);

  const explicitDropReset =
    tailInfo.hasExplicitTokens &&
    lastStepPromptTokens > 0 &&
    currentEpoch < savedEpoch &&
    lastStepPromptTokens < savedEpoch * effectiveThreshold * 0.85;

  if ((tailInfo.contextSummaryReset || explicitDropReset) && currentEpoch < savedEpoch) {
    if (!readOnly) {
      updateJsonAtomicSync(
        getStateFile(),
        () => ({ epochs: {}, resetTimestamps: {}, strategicNotifiedEpochs: {}, totalCompactions: 0 }),
        (st) => {
          const epochs = st?.epochs && typeof st.epochs === 'object' ? { ...st.epochs } : {};
          const resetTimestamps = st?.resetTimestamps && typeof st.resetTimestamps === 'object' ? { ...st.resetTimestamps } : {};
          const strategicNotifiedEpochs =
            st?.strategicNotifiedEpochs && typeof st.strategicNotifiedEpochs === 'object'
              ? { ...st.strategicNotifiedEpochs }
              : {};
          epochs[convoId] = currentEpoch;
          if (safeRawConvoId !== convoId) {
            delete epochs[safeRawConvoId];
            delete strategicNotifiedEpochs[safeRawConvoId];
          }
          delete strategicNotifiedEpochs[convoId];
          resetTimestamps[convoId] = Date.now();
          const pruned = pruneCompactionRecords(epochs, resetTimestamps, MAX_COMPACTION_ENTRIES, strategicNotifiedEpochs);
          return { ...pruned, totalCompactions: Number(st?.totalCompactions || 0) };
        },
        { spaces: 0 }
      );
      try { invalidateReadCacheForConvo(convoId); } catch {}
    }
    savedEpoch = currentEpoch;
  }

  let needsCompaction = false;
  let strategicCompactionSuggested = false;
  let digestPath = null;
  let compactionNotice = null;
  let earlyDigestRes = null;
  const cleanPhase = VALID_PHASE_TRANSITIONS.has(String(phaseTransition || '').trim())
    ? String(phaseTransition).trim()
    : '';

  // Тихое фоновое создание дайджеста при достижении промежуточного порога длинного диалога (approxSteps >= 40)
  const shortId = (convoId || 'latest').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 8);
  const expectedDigestFile = join(getCacheDir(), `compaction-digest-${shortId}.md`);
  if (!readOnly && tailInfo.approxSteps >= 40 && !existsSync(expectedDigestFile) && resolved.transcriptPath) {
    try {
      earlyDigestRes = buildCompactionDigest(resolved.transcriptPath, convoId, workspaceRoot);
      digestPath = earlyDigestRes.digestPath;
    } catch {}
  }

  // Ключевая логика: только при переходе на НОВУЮ эпоху (> savedEpoch и > 0)
  if (currentEpoch > savedEpoch && currentEpoch > 0) {
    if (readOnly) {
      needsCompaction = true;
      digestPath = existsSync(expectedDigestFile) ? expectedDigestFile : null;
    } else {
      let updatedNow = false;
      updateJsonAtomicSync(
        getStateFile(),
        () => ({ epochs: {}, resetTimestamps: {}, strategicNotifiedEpochs: {}, totalCompactions: 0 }),
        (st) => {
          const epochs = st?.epochs && typeof st.epochs === 'object' ? { ...st.epochs } : {};
          const resetTimestamps = st?.resetTimestamps && typeof st.resetTimestamps === 'object' ? { ...st.resetTimestamps } : {};
          const strategicNotifiedEpochs =
            st?.strategicNotifiedEpochs && typeof st.strategicNotifiedEpochs === 'object'
              ? { ...st.strategicNotifiedEpochs }
              : {};
          const prevBase = Object.hasOwn(epochs, convoId) ? Number(epochs[convoId] || 0) : 0;
          const prevRaw = Object.hasOwn(epochs, safeRawConvoId) ? Number(epochs[safeRawConvoId] || 0) : 0;
          const prevEp = Math.max(prevBase, prevRaw);
          if (currentEpoch > prevEp) {
            epochs[convoId] = currentEpoch;
            if (safeRawConvoId !== convoId) {
              delete epochs[safeRawConvoId];
              delete strategicNotifiedEpochs[safeRawConvoId];
            }
            resetTimestamps[convoId] = Date.now();
            updatedNow = true;
            const pruned = pruneCompactionRecords(epochs, resetTimestamps, MAX_COMPACTION_ENTRIES, strategicNotifiedEpochs);
            return { ...pruned, totalCompactions: Number(st?.totalCompactions || 0) + 1 };
          }
          return st;
        },
        { spaces: 0 }
      );

      if (updatedNow) {
        try { invalidateReadCacheForConvo(convoId); } catch {}
        let digestSummary = '';
        if (resolved.transcriptPath) {
          let digestRes = earlyDigestRes || buildCompactionDigest(resolved.transcriptPath, convoId, workspaceRoot);
          digestRes = await enrichCompactionDigestWithGpu(digestRes, { timeoutMs: 3800 });
          await postCompactionArchiveBestEffort({
            convoId,
            wsPath: workspaceRoot || '',
            rawText: digestRes.digestMarkdown,
          });
          digestPath = digestRes.digestPath;
          if (digestRes.digestMarkdown) {
            const touchedMatch = digestRes.digestMarkdown.match(/### Touched files:\s*([\s\S]*?)(?=###|$)/i);
            const queryMatch = digestRes.digestMarkdown.match(/### User goals:\s*([\s\S]*?)(?=###|$)/i);

            const files = touchedMatch
              ? touchedMatch[1].trim().split('\n').filter(Boolean).slice(0, 6).map((l) => l.replace(/^[-*]\s*/, '').trim()).join(', ')
              : '';
            const queries = queryMatch
              ? queryMatch[1].trim().split('\n').filter(Boolean).slice(-2).map((l) => l.replace(/^[-*]\s*/, '').trim()).join(' | ')
              : '';

            const lines = [];
            if (files) lines.push(`- Files: ${files}`);
            if (queries) lines.push(`- Goals: ${queries}`);
            if (digestRes.gpuSummary) {
              lines.push(`- GPU Summary: ${String(digestRes.gpuSummary).replace(/\r?\n/g, ' ').slice(0, 220)}`);
            }
            if (lines.length > 0) {
              digestSummary = lines.join('\n');
              if (digestSummary.length > 480) {
                digestSummary = digestSummary.slice(0, 480) + '...';
              }
            }
          }
        }

        needsCompaction = true;
        const summaryBlock = digestSummary ? `\nDigest:\n${digestSummary}\n` : ' ';
        compactionNotice =
          `📦 [Autonomous Context Overflow Guard] Epoch #${currentEpoch} (${totalFillPercent}%, ~${lastStepPromptTokens} tok). ` +
          `Background digest & Session Handoff saved to \`${digestPath || '.cache/compaction-digest'}\`.` +
          summaryBlock +
          pickLang(
            resolvedLang,
            `AUTONOMOUS ACTION: At the very end of your Russian reply, add 1 concise friendly line advising the user that this chat has grown large (~${Math.round(lastStepPromptTokens / 1000)}k tok) and they can open a fresh chat (Session Handoff will auto-restore goals & touched files) or run /compact.`,
            `AUTONOMOUS ACTION: At the very end of your English reply, add 1 concise friendly line advising the user that this chat has grown large (~${Math.round(lastStepPromptTokens / 1000)}k tok) and they can open a fresh chat (Session Handoff will auto-restore goals & touched files) or run /compact.`
          );
      }
    }
  }

  // Фазовая («стратегическая») компакция между естественными границами этапов до жёсткого переполнения эпохи
  if (!needsCompaction && cleanPhase && effectiveThreshold > 0) {
    const minRatio = Math.max(0.25, Math.min(0.95, Number(strategicMinFillRatio ?? 0.55) || 0.55));
    const alreadyStrategicEpoch = Object.hasOwn(state.strategicNotifiedEpochs, convoId)
      ? Number(state.strategicNotifiedEpochs[convoId])
      : -1;
    if (tokensInEpoch >= effectiveThreshold * minRatio && alreadyStrategicEpoch !== currentEpoch) {
      if (readOnly) {
        strategicCompactionSuggested = true;
        digestPath = existsSync(expectedDigestFile) ? expectedDigestFile : null;
      } else {
        let markedNow = false;
        updateJsonAtomicSync(
          getStateFile(),
          () => ({ epochs: {}, resetTimestamps: {}, strategicNotifiedEpochs: {}, totalCompactions: 0 }),
          (st) => {
            const epochs = st?.epochs && typeof st.epochs === 'object' ? { ...st.epochs } : {};
            const resetTimestamps = st?.resetTimestamps && typeof st.resetTimestamps === 'object' ? { ...st.resetTimestamps } : {};
            const strategicNotifiedEpochs =
              st?.strategicNotifiedEpochs && typeof st.strategicNotifiedEpochs === 'object'
                ? { ...st.strategicNotifiedEpochs }
                : {};
            const prevNotified = Object.hasOwn(strategicNotifiedEpochs, convoId)
              ? Number(strategicNotifiedEpochs[convoId])
              : -1;
            if (prevNotified !== currentEpoch) {
              strategicNotifiedEpochs[convoId] = currentEpoch;
              resetTimestamps[convoId] = resetTimestamps[convoId] || Date.now();
              markedNow = true;
              const pruned = pruneCompactionRecords(epochs, resetTimestamps, MAX_COMPACTION_ENTRIES, strategicNotifiedEpochs);
              return { ...pruned, totalCompactions: Number(st?.totalCompactions || 0) };
            }
            return st;
          },
          { spaces: 0 }
        );

        if (markedNow) {
          if (resolved.transcriptPath) {
            try {
              const digestRes = earlyDigestRes || buildCompactionDigest(resolved.transcriptPath, convoId, workspaceRoot);
              digestPath = digestRes?.digestPath || digestPath;
            } catch {}
          }
          strategicCompactionSuggested = true;
          const phaseLabelMap = isEn
            ? {
                explore_to_edit: 'exploration and planning complete before edits',
                verify_passed: 'tests and verification passed',
                milestone_done: 'task milestone completed',
              }
            : {
                explore_to_edit: 'разведка и план завершены перед правками',
                verify_passed: 'тесты и верификация пройдены',
                milestone_done: 'этап задачи завершён',
              };
          const phaseLabel = phaseLabelMap[cleanPhase] || cleanPhase;
          compactionNotice =
            `🧭 [Strategic Compact · ${cleanPhase}] Context is at ${fillPercent}% of Epoch #${currentEpoch} (~${lastStepPromptTokens} tok) right at a clean phase boundary (${phaseLabel}). ` +
            `Digest & Session Handoff saved to \`${digestPath || '.cache/compaction-digest'}\`. ` +
            `AUTONOMOUS ACTION: Suggest running /compact (or opening a fresh chat with Session Handoff) before starting the next phase so Gemini 4 Implicit Cache stays clean.`;
        }
      }
    }
  }

  return {
    epoch: currentEpoch,
    lastPromptTokens: lastStepPromptTokens,
    tokensInEpoch,
    thresholdTokens: effectiveThreshold,
    fillPercent,
    totalFillPercent,
    needsCompaction,
    strategicCompactionSuggested,
    phaseTransition: cleanPhase || null,
    digestPath,
    compactionNotice,
    activeModel: modelProfile.label || null,
  };
}

/**
 * Принудительно инициирует создание дайджеста ранних шагов диалога.
 * @param {string} [conversationId='']
 * @returns {Promise<{ ok: boolean, digestPath: string, compressedSteps: number, summaryPreview: string }>}
 */
export async function triggerManualCompactionDigest(conversationId = '') {
  const resolved = resolveTranscriptPath('', conversationId);
  const convoId = normalizeCompactionConvoId(resolved.conversationId || conversationId || 'manual');
  let res = buildCompactionDigest(resolved.transcriptPath, convoId);
  res = await enrichCompactionDigestWithGpu(res, { timeoutMs: 8000 });

  updateJsonAtomicSync(
    getStateFile(),
    () => ({ epochs: {}, resetTimestamps: {}, strategicNotifiedEpochs: {}, totalCompactions: 0 }),
    (st) => {
      const epochs = st?.epochs && typeof st.epochs === 'object' ? { ...st.epochs } : {};
      const resetTimestamps = st?.resetTimestamps && typeof st.resetTimestamps === 'object' ? { ...st.resetTimestamps } : {};
      const strategicNotifiedEpochs =
        st?.strategicNotifiedEpochs && typeof st.strategicNotifiedEpochs === 'object'
          ? { ...st.strategicNotifiedEpochs }
          : {};
      resetTimestamps[convoId] = Date.now();
      delete strategicNotifiedEpochs[convoId];
      const pruned = pruneCompactionRecords(epochs, resetTimestamps, MAX_COMPACTION_ENTRIES, strategicNotifiedEpochs);
      return {
        ...pruned,
        totalCompactions: Number(st?.totalCompactions || 0) + 1,
      };
    },
    { spaces: 0 }
  );
  try { invalidateReadCacheForConvo(convoId); } catch {}

  return {
    ok: true,
    digestPath: res.digestPath,
    compressedSteps: res.compressedSteps,
    summaryPreview: res.digestMarkdown.slice(0, 300)
  };
}

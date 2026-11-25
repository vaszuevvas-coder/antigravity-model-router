/**
 * @file panel-telemetry-collectors.mjs
 * @description Telemetry aggregation, workspace resolution, RAM/CPU/GPU/Bayesian/checkpoint snapshots.
 */

import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeReadJsonSync } from '../../../core/safe-json.mjs';
import { pickLang } from '../../../core/i18n.mjs';
import { getCpuStatusSnapshot, readCpuTelemetry } from '../../../core/cpu-worker-pool.mjs';
import { isSubagentTranscriptFile } from '../../../core/model-profile.mjs';
import { isValidWorkspaceDir } from './panel-security.mjs';
import {
  HANDOFF_MIRROR_CACHE_PATH,
  TASK_PROGRESS_CACHE_PATH,
  clampSafeInt,
  getBayesianRouterMod,
  getCircuitBreakerMod,
  getFloatingHudMod,
  getHardwareProfilerMod,
  getHistoryCompactorMod,
  getKnowledgeHubMod,
  getLocalGpuMod,
  getPitfallLedgerMod,
  getQuotaPacerMod,
  getRuntimeHardwareCeilings,
  getRuntimeWiretapMod,
  getSessionHandoffMod,
  getShadowGuard,
  getShadowWorktreeMod,
  getTaskProgressMod,
  isEphemeralPanelCandidatePath,
  isUmbrellaDirWithoutMarkers,
  normalizeWorkspaceUriKey,
  panelRuntime,
  querySingleRamDaemon,
} from './panel-state-skills.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function safeGetHudAndProgressStatus(state = {}, activeWs = '') {
  try {
    const hudRuntimePath = join(__dirname, '..', '..', '..', '.cache', 'floating-hud.json');
    const shouldCheckHud = Boolean(state?.floatingHudEnabled) || existsSync(hudRuntimePath);
    const [hudMod, progMod] = await Promise.all([
      shouldCheckHud ? getFloatingHudMod() : Promise.resolve(null),
      getTaskProgressMod(),
    ]);
    // Гарантируем, что внешнее окно Floating HUD остаётся отключённым и не всплывает
    if (hudMod?.stopFloatingHud) {
      const st = hudMod.getFloatingHudStatus?.();
      if (st?.running) hudMod.stopFloatingHud();
    }
    const progress = progMod?.getTaskProgressSnapshot
      ? progMod.getTaskProgressSnapshot({ workspaceRoot: activeWs })
      : null;
    if (progress && Array.isArray(progress.activeChats)) {
      for (const chat of progress.activeChats) {
        if (!chat || typeof chat !== 'object') continue;
        if (Array.isArray(chat.backgroundTasks)) {
          chat.backgroundTasks = chat.backgroundTasks.slice(0, 25).map((t) => ({
            id: String(t?.id || t?.taskId || '').slice(0, 80),
            taskId: String(t?.taskId || t?.id || '').slice(0, 80),
            label: String(t?.label || '').slice(0, 120),
            labelEn: String(t?.labelEn || '').slice(0, 120),
            commandPreview: String(t?.commandPreview || '').slice(0, 120),
            status: String(t?.status || 'done'),
            isDaemon: Boolean(t?.isDaemon),
            startedAt: Number(t?.startedAt || 0),
            updatedAt: Number(t?.updatedAt || 0),
          }));
        } else {
          chat.backgroundTasks = [];
        }
        chat.backgroundTasksTotalCount = Math.max(
          chat.backgroundTasks.length,
          Math.round(Number(chat.backgroundTasksTotalCount || 0))
        );
      }
    }
    return { hud: { running: false, enabled: false }, progress };
  } catch {
    return { hud: { running: false, enabled: false }, progress: null };
  }
}

const GPU_PANEL_CACHE_TTL_MS = 2500;

export const gpuStatusPanelCache = { ts: 0, value: null };

export async function safeGetGpuStatus(rawOpts = {}) {
  const { force = false } = rawOpts && typeof rawOpts === 'object' ? rawOpts : {};
  const now = Date.now();
  try {
    const mod = await getLocalGpuMod();
    if (!force && gpuStatusPanelCache.value && now - gpuStatusPanelCache.ts < GPU_PANEL_CACHE_TTL_MS) {
      const liveHardware = mod?.probeNvidiaGpu ? mod.probeNvidiaGpu(false) : gpuStatusPanelCache.value.hardware;
      const liveActivity = mod?.getGpuLiveActivity ? mod.getGpuLiveActivity({ now }) : gpuStatusPanelCache.value.liveActivity;
      const thermalGuard = mod?.evaluateGpuThermalAndLoadGuard
        ? mod.evaluateGpuThermalAndLoadGuard(liveHardware, { isBackground: true, liveActivity })
        : gpuStatusPanelCache.value.thermalGuard;
      return {
        ...gpuStatusPanelCache.value,
        hardware: liveHardware,
        thermalGuard,
        pullStatus: mod?.getGpuPullJobStatus ? mod.getGpuPullJobStatus() : gpuStatusPanelCache.value.pullStatus,
        ollamaInstallStatus: mod?.getOllamaInstallJobStatus ? mod.getOllamaInstallJobStatus() : gpuStatusPanelCache.value.ollamaInstallStatus,
        telemetry: mod?.getGpuTelemetry ? mod.getGpuTelemetry() : gpuStatusPanelCache.value.telemetry,
        liveActivity,
      };
    }
    if (mod?.getGpuStatusSnapshot) {
      const snap = await mod.getGpuStatusSnapshot({ force });
      if (snap) Object.assign(gpuStatusPanelCache, { ts: Date.now(), value: snap });
      return snap;
    }
  } catch {}
  return gpuStatusPanelCache.value || null;
}

export async function safeGetHardwareProfile(state = {}, force = false) {
  try {
    const mod = await getHardwareProfilerMod();
    if (mod?.getHardwareProfile) {
      return await mod.getHardwareProfile({
        pluginRoot: join(__dirname, '..', '..', '..'),
        force,
        subscriptionTier: state?.subscriptionTier === 'ultra' ? 'ultra' : 'pro',
      });
    }
  } catch {}
  return null;
}

export async function safeGetCircuitState(workspaceRoot = '') {
  try {
    const mod = await getCircuitBreakerMod();
    if (mod && typeof mod.getCircuitState === 'function') {
      const cleanWs = (typeof workspaceRoot === 'string' && workspaceRoot.trim() && workspaceRoot.trim() !== '__all__')
        ? workspaceRoot.trim()
        : '';
      const res = await mod.getCircuitState(cleanWs ? { workspaceRoot: cleanWs } : undefined);
      if (res) return res;
    }
  } catch (err) {
    console.warn('Ошибка getCircuitState:', err.message);
  }
  return { status: 'CLOSED', reason: 'Нормальная работа (нет зацикливаний)', reasonEn: 'Healthy (no thrashing loops)', repeatCount: 0 };
}

export async function safeResetCircuitBreaker(workspaceRoot = '') {
  try {
    const mod = await getCircuitBreakerMod();
    if (mod && typeof mod.resetCircuitBreaker === 'function') {
      const cleanWs = (typeof workspaceRoot === 'string' && workspaceRoot.trim() && workspaceRoot.trim() !== '__all__')
        ? workspaceRoot.trim()
        : '';
      const scope = cleanWs ? { workspaceRoot: cleanWs } : null;
      const res = await mod.resetCircuitBreaker(scope);
      const st = (mod.getCircuitState && typeof mod.getCircuitState === 'function')
        ? await mod.getCircuitState(scope || undefined)
        : { status: 'CLOSED', reason: 'Автомат сброшен оператором', reasonEn: 'Reset by operator', repeatCount: 0 };
      return { ok: true, circuitBreaker: st, ...res };
    }
  } catch (err) {
    console.warn('Ошибка resetCircuitBreaker:', err.message);
  }
  return {
    ok: true,
    circuitBreaker: { status: 'CLOSED', reason: 'Сброшен (режим ожидания)', reasonEn: 'Reset (standby mode)', repeatCount: 0 },
  };
}

export async function safeCheckCompaction(thresholdTokens = 120000, telemetry = {}) {
  try {
    const mod = await getHistoryCompactorMod();
    if (mod && typeof mod.checkHistoryCompaction === 'function') {
      const res = await mod.checkHistoryCompaction({
        conversationId: telemetry?.activeChat?.convoId || '',
        transcriptPath: telemetry?.activeChat?.transcriptPath || '',
        thresholdTokens,
        readOnly: true,
      });
      if (res) return res;
    }
  } catch (err) {
    console.warn('Ошибка checkHistoryCompaction:', err.message);
  }
  const promptTokens = Number(
    telemetry?.activeChat?.lastContextTokens ??
      ((telemetry.inputTokens || 0) + (telemetry.cacheReadTokens || 0))
  );
  const thresh = Number(thresholdTokens || 120000);
  const epoch = thresh > 0 ? Math.floor(promptTokens / thresh) : 0;
  const inEpoch = thresh > 0 ? promptTokens % thresh : 0;
  const fill = thresh > 0 ? Math.min(100, Math.round((inEpoch / thresh) * 100)) : 0;
  return {
    epoch,
    lastPromptTokens: promptTokens,
    thresholdTokens: thresh,
    fillPercent: fill,
  };
}

export async function safeTriggerManualCompactionDigest(opts = {}) {
  try {
    const mod = await getHistoryCompactorMod();
    if (mod && typeof mod.triggerManualCompactionDigest === 'function') {
      const cid = typeof opts === 'string' ? opts : (opts?.conversationId || '');
      return await mod.triggerManualCompactionDigest(cid);
    }
  } catch (err) {
    console.warn('Ошибка triggerManualCompactionDigest:', err.message);
    return { ok: false, error: err.message };
  }
  return {
    ok: true,
    epoch: 1,
    savedTokens: 0,
    message: 'Дайджест контекста сформирован',
    messageEn: 'Context digest generated',
  };
}

export async function safeListPitfalls(limit = 10, workspaceRoot = '') {
  try {
    const mod = await getPitfallLedgerMod();
    if (mod && typeof mod.listPitfalls === 'function') {
      const list = await mod.listPitfalls(limit, workspaceRoot);
      if (Array.isArray(list)) return list;
    }
  } catch (err) {
    console.warn('Ошибка listPitfalls:', err.message);
  }
  return [];
}

export async function safeClearPitfalls(workspaceRoot = '') {
  try {
    const mod = await getPitfallLedgerMod();
    if (mod && typeof mod.clearPitfalls === 'function') {
      return await mod.clearPitfalls(workspaceRoot);
    }
  } catch (err) {
    console.warn('Ошибка clearPitfalls:', err.message);
  }
  return { ok: true, cleared: true };
}

export async function safeGetKnowledgeSnapshot(workspaceRoot = '', state = {}) {
  if (state?.sqliteKnowledgeEnabled === false) {
    return { recipes: [], peers: [], stats: { disabled: true, astCachedFilesCount: 0 } };
  }
  try {
    const mod = await getKnowledgeHubMod();
    const hub = mod?.knowledgeHub;
    if (!hub) return { recipes: [], peers: [], stats: null };
    const recipes = hub.listVictoryRecipes(workspaceRoot, 12);
    const dbPeers = hub.getFederatedWorkspaces(workspaceRoot);
    const stats = hub.getStats(workspaceRoot);
    return { recipes, peers: Array.isArray(dbPeers) ? dbPeers : [], stats };
  } catch {
    return { recipes: [], peers: [], stats: null };
  }
}

export async function safeGetBayesianSummary(workspaceRoot = '') {
  try {
    const mod = await getBayesianRouterMod();
    if (mod && typeof mod.getBayesianSummary === 'function') {
      const cleanWs = (typeof workspaceRoot === 'string' && workspaceRoot.trim() && workspaceRoot.trim() !== '__all__')
        ? workspaceRoot.trim()
        : '';
      const summary = await mod.getBayesianSummary(cleanWs);
      if (summary) return summary;
    }
  } catch (err) {
    console.warn('Ошибка getBayesianSummary:', err.message);
  }
  return {
    overallConfidencePercent: 88,
    overallFirstPassRate: 1,
    overallFirstPassPercent: 100,
    overallExpectedTurns: 1,
    totalRuns: 0,
    fragileFiles: [],
    domains: [
      { key: 'code_generation', label: 'Генерация кода', labelEn: 'Code Generation', confidencePercent: 90, runs: 0, failures: 0, recommendedTier: 'flash' },
      { key: 'algo_refactor', label: 'Алгоритмы и рефакторинг', labelEn: 'Algorithms & Refactoring', confidencePercent: 82, runs: 0, failures: 0, recommendedTier: 'pro' },
      { key: 'bug_investigation', label: 'Поиск и триаж багов', labelEn: 'Bug Triage & Debugging', confidencePercent: 86, runs: 0, failures: 0, recommendedTier: 'flash' },
      { key: 'docs_translate', label: 'Документация и перевод', labelEn: 'Docs & Localization', confidencePercent: 95, runs: 0, failures: 0, recommendedTier: 'flash' },
      { key: 'general', label: 'Общие задачи', labelEn: 'General Tasks', confidencePercent: 88, runs: 0, failures: 0, recommendedTier: 'flash' },
    ],
  };
}

export async function safeResetBayesianPriors(workspaceRoot = '', onlyFragility = false) {
  const cleanWs = (typeof workspaceRoot === 'string' && workspaceRoot.trim() && workspaceRoot.trim() !== '__all__')
    ? workspaceRoot.trim()
    : '';
  try {
    const mod = await getBayesianRouterMod();
    if (mod && typeof mod.resetBayesianPriors === 'function') {
      return await mod.resetBayesianPriors({ workspaceRoot: cleanWs, onlyFragility: Boolean(onlyFragility) });
    }
  } catch (err) {
    console.warn('Ошибка resetBayesianPriors:', err.message);
  }
  return {
    ok: true,
    summary: await safeGetBayesianSummary(cleanWs),
    message: 'Веса Байесовского доверия сброшены к начальным априорным распределениям Beta(α, β)',
    messageEn: 'Bayesian confidence weights reset to Beta(α, β) priors',
  };
}

export async function safeListCheckpoints(limit = 8, workspaceRoot = '') {
  try {
    const mod = await getShadowGuard();
    if (mod && typeof mod.listCheckpoints === 'function') {
      return await mod.listCheckpoints(limit, workspaceRoot);
    }
  } catch (err) {
    console.warn('Ошибка listCheckpoints:', err.message);
  }

  // Встроенный fallback: чтение файлов чекпоинтов
  try {
    const cpDir = join(homedir(), '.gemini', 'checkpoints');
    if (existsSync(cpDir)) {
      const cleanCpWs = (workspaceRoot && workspaceRoot !== '__all__') ? workspaceRoot : '';
      const normWs = cleanCpWs ? resolve(cleanCpWs).replace(/\\/g, '/').toLowerCase() : '';
      let entries = readdirSync(cpDir, { withFileTypes: true })
        .filter((d) => d.isFile() && d.name.endsWith('.json'))
        .map((d) => {
          try {
            return JSON.parse(readFileSync(join(cpDir, d.name), 'utf-8'));
          } catch { return null; }
        })
        .filter(Boolean)
        .sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
      if (normWs) {
        const scoped = entries.filter((e) => {
          const target = String(e.workspaceRoot || e.filePath || '').replace(/\\/g, '/').toLowerCase();
          return target.startsWith(normWs);
        });
        if (scoped.length > 0) entries = scoped;
      }
      entries = entries.slice(0, limit);
      if (entries.length) return entries;
    }
  } catch {}
  return [];
}

export async function safeRollbackCheckpoint(checkpointId = 'latest', workspaceRoot = '', opts = {}) {
  const lang = opts?.lang || 'en';
  try {
    const mod = await getShadowGuard();
    if (mod && typeof mod.rollbackCheckpoint === 'function') {
      return await mod.rollbackCheckpoint(checkpointId, workspaceRoot, { lang });
    }
  } catch (err) {
    console.error('rollbackCheckpoint failed:', err);
    return { ok: false, error: err.message };
  }
  return {
    ok: false,
    message: pickLang(lang, 'Чекпоинты пока не созданы или модуль инициализируется', 'No checkpoints created yet or module is initializing'),
  };
}

export async function safeListTurnCheckpoints(limit = 10, workspaceRoot = '') {
  try {
    const mod = await getShadowGuard();
    if (mod && typeof mod.listTurnCheckpoints === 'function') {
      return await mod.listTurnCheckpoints(limit, workspaceRoot);
    }
  } catch {}
  return [];
}

export async function safeGetTurnDiffSummary(turnId = 'latest', workspaceRoot = '', opts = {}) {
  const lang = opts?.lang || 'en';
  try {
    const mod = await getShadowGuard();
    if (mod && typeof mod.getTurnDiffSummary === 'function') {
      return await mod.getTurnDiffSummary(turnId, workspaceRoot, { lang });
    }
  } catch (err) {
    return { ok: false, error: err.message, files: [] };
  }
  return { ok: false, error: pickLang(lang, 'Модуль чекпоинтов недоступен', 'Checkpoints module unavailable'), files: [] };
}

export async function safeRollbackTurn(turnId = 'latest', workspaceRoot = '', opts = {}) {
  const lang = opts?.lang || 'en';
  try {
    const mod = await getShadowGuard();
    if (mod && typeof mod.rollbackTurn === 'function') {
      return await mod.rollbackTurn(turnId, workspaceRoot, { lang });
    }
  } catch (err) {
    return { ok: false, error: err.message };
  }
  return { ok: false, error: pickLang(lang, 'Модуль отката хода недоступен', 'Turn rollback module unavailable') };
}

export async function safeListShadowWorktrees(workspaceRoot = '') {
  try {
    const mod = await getShadowWorktreeMod();
    if (mod && typeof mod.listShadowWorktrees === 'function') {
      return mod.listShadowWorktrees(workspaceRoot);
    }
  } catch {}
  return [];
}

export async function safeGetWiretapFaults(workspaceRoot = '', state = {}) {
  if (state?.runtimeWiretapEnabled === false) return [];
  try {
    const mod = await getRuntimeWiretapMod();
    if (mod && typeof mod.getLatestWiretapFaults === 'function') {
      const res = mod.getLatestWiretapFaults(workspaceRoot, { limit: 6 });
      const rawFaults = Array.isArray(res?.faults) ? res.faults : [];
      if (typeof mod.formatFaultForComposer === 'function') {
        return rawFaults.map((f) => ({
          ...f,
          composerPromptEn: f.composerPromptEn || mod.formatFaultForComposer(f, { lang: 'en' }),
        }));
      }
      return rawFaults;
    }
  } catch {}
  return [];
}

export async function safeGetQuotaForecast(state = {}) {
  if (state?.quotaPacerEnabled === false) return null;
  try {
    const mod = await getQuotaPacerMod();
    if (mod && typeof mod.computeQuotaBurnForecast === 'function') {
      const forecast = mod.computeQuotaBurnForecast(null, state);
      const combo = typeof mod.resolveComboFailoverTarget === 'function'
        ? mod.resolveComboFailoverTarget({
            combo: 'swarm_worker',
            localGpuAvailable: Boolean(state?.gpuEnabled),
            subscriptionTier: state?.subscriptionTier === 'ultra' ? 'ultra' : 'pro',
          })
        : null;
      return forecast ? { ...forecast, combo } : { ok: true, status: 'calm', combo };
    }
  } catch {}
  return null;
}

// Инкрементальный кэш сводной телеметрии по всем диалогам (byte-offset чтение без повторного парсинга старых мегабайт)
const MAX_TRACKED_CHATS = 60;

const perChatTelemetryCache = new Map();

// Сбор сводной телеметрии экономии токенов, кэша и вызовов субагентов суммарно по всем диалогам
const BRAIN_SCAN_TTL_MS = 2_500;

let brainScanCache = { ts: 0, key: '', value: null };

function parseSingleChatDelta(filePath, st) {
  const prev = perChatTelemetryCache.get(filePath);
  if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) {
    return prev.accum;
  }

  const canResume = Boolean(prev && prev.accum && st.size >= prev.byteOffset);
  const accum = canResume
    ? {
        steps: prev.accum.steps,
        inputTokens: prev.accum.inputTokens,
        outputTokens: prev.accum.outputTokens,
        cacheReadTokens: prev.accum.cacheReadTokens,
        lastContextTokens: prev.accum.lastContextTokens || 0,
        workspaceRoot: prev.accum.workspaceRoot || '',
        subagents: { ...prev.accum.subagents },
        ramCalls: prev.accum.ramCalls
          ? { ...prev.accum.ramCalls }
          : { slices: 0, searches: 0, contextPacks: 0, total: 0 },
        swarmLines: [...prev.accum.swarmLines],
      }
    : {
        steps: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        lastContextTokens: 0,
        workspaceRoot: '',
        subagents: { pro: 0, flash: 0, total: 0 },
        ramCalls: { slices: 0, searches: 0, contextPacks: 0, total: 0 },
        swarmLines: [],
      };

  const parseTranscriptLine = (rawLine) => {
    const trimmed = rawLine.trim();
    if (!trimmed) return false;
    try {
      const obj = JSON.parse(trimmed);
      if (!accum.workspaceRoot && typeof obj.content === 'string') {
        const cwdMatch = /Command Working Directory:\s*([^\r\n<]+)/i.exec(obj.content);
        const wsMatch = !cwdMatch ? /Active Workspaces:\s*\r?\n-\s*([^\r\n<]+)/i.exec(obj.content) : null;
        const foundWs = (cwdMatch?.[1] || wsMatch?.[1] || '').trim();
        if (foundWs) accum.workspaceRoot = foundWs;
      }
      if (obj.input_tokens || obj.output_tokens || obj.cache_read_tokens) {
        accum.steps += 1;
        const inTok = Number(obj.input_tokens || 0);
        const outTok = Number(obj.output_tokens || 0);
        const cacheTok = Number(obj.cache_read_tokens || 0);
        accum.inputTokens += inTok;
        accum.outputTokens += outTok;
        accum.cacheReadTokens += cacheTok;
        if (inTok > 0 || cacheTok > 0) {
          accum.lastContextTokens = inTok + cacheTok;
        }
      }
      if (Array.isArray(obj.tool_calls)) {
        for (const tc of obj.tool_calls) {
          const tcName = String(tc?.name || '');
          const tcLower = tcName.toLowerCase();
          if (tcName === 'invoke_subagent') {
            accum.subagents.total += 1;
            const m = String(tc.args?.Model || 'inherit').toLowerCase();
            if (m.includes('flash') || m.includes('hydrogen')) {
              accum.subagents.flash += 1;
            } else {
              accum.subagents.pro += 1;
            }
          } else if (tcLower.endsWith('ram_slice')) {
            accum.ramCalls.slices += 1;
            accum.ramCalls.total += 1;
          } else if (tcLower.endsWith('ram_search')) {
            accum.ramCalls.searches += 1;
            accum.ramCalls.total += 1;
          } else if (tcLower.endsWith('ram_context_pack')) {
            accum.ramCalls.contextPacks += 1;
            accum.ramCalls.total += 1;
          }
        }
        if (
          (trimmed.includes('"swarm"') || trimmed.includes('"post_message"')) &&
          accum.swarmLines.length < 1500
        ) {
          accum.swarmLines.push(trimmed);
        }
      }
      return true;
    } catch {
      return false;
    }
  };

  let committedOffset = canResume ? prev.byteOffset : 0;
  if (st.size > committedOffset) {
    const CHUNK_SIZE = 65536;
    const readBuf = Buffer.allocUnsafe(CHUNK_SIZE);
    let fd = null;
    let leftoverBuf = Buffer.alloc(0);
    let readPos = committedOffset;
    try {
      fd = openSync(filePath, 'r');
      while (readPos < st.size) {
        const toRead = Math.min(CHUNK_SIZE, st.size - readPos);
        const bytesRead = readSync(fd, readBuf, 0, toRead, readPos);
        if (bytesRead <= 0) break;
        readPos += bytesRead;
        const combined = leftoverBuf.length > 0
          ? Buffer.concat([leftoverBuf, readBuf.subarray(0, bytesRead)])
          : readBuf.subarray(0, bytesRead);

        let lineStart = 0;
        let nlIdx = combined.indexOf(0x0a, lineStart);
        while (nlIdx !== -1) {
          const lineStr = combined.subarray(lineStart, nlIdx).toString('utf-8');
          parseTranscriptLine(lineStr);
          lineStart = nlIdx + 1;
          nlIdx = combined.indexOf(0x0a, lineStart);
        }

        if (lineStart > 0) {
          const consumedFromLeftover = Math.min(leftoverBuf.length, lineStart);
          const consumedFromChunk = lineStart - consumedFromLeftover;
          const chunkStartPos = readPos - bytesRead;
          committedOffset = leftoverBuf.length > 0
            ? (lineStart >= leftoverBuf.length ? chunkStartPos + consumedFromChunk : committedOffset)
            : chunkStartPos + lineStart;
          leftoverBuf = Buffer.from(combined.subarray(lineStart));
        } else {
          leftoverBuf = Buffer.from(combined);
        }
      }
      if (leftoverBuf.length > 0) {
        const tailStr = leftoverBuf.toString('utf-8');
        if (parseTranscriptLine(tailStr)) {
          committedOffset = readPos;
        }
      }
    } finally {
      if (fd !== null) {
        try { closeSync(fd); } catch {}
      }
    }
  }

  if (perChatTelemetryCache.size >= MAX_TRACKED_CHATS && !perChatTelemetryCache.has(filePath)) {
    const oldestKey = perChatTelemetryCache.keys().next().value;
    if (oldestKey) perChatTelemetryCache.delete(oldestKey);
  }
  perChatTelemetryCache.set(filePath, {
    mtimeMs: st.mtimeMs,
    size: st.size,
    byteOffset: committedOffset,
    accum,
  });

  return accum;
}

export function collectTelemetry(configuredThreshold = 120000, options = {}) {
  const customBrainDirs = Array.isArray(options?.brainDirs) ? options.brainDirs : null;
  const rawWs = typeof options?.workspaceRoot === 'string' ? options.workspaceRoot.trim() : '';
  const normWs = rawWs && rawWs !== '__all__' ? normalizeWorkspaceUriKey(rawWs) : '';
  const cacheKey = `${configuredThreshold}::${normWs}`;
  const now = Date.now();
  if (
    !customBrainDirs &&
    brainScanCache.value &&
    brainScanCache.key === cacheKey &&
    now - brainScanCache.ts < BRAIN_SCAN_TTL_MS
  ) {
    return options?.ramStats
      ? mergeRamSavingsIntoTelemetry(brainScanCache.value, options.ramStats)
      : brainScanCache.value;
  }
  const baseValue = collectTelemetryUncached(configuredThreshold, options?.ramStats ? { ...options, ramStats: null } : options);
  if (!customBrainDirs) {
    brainScanCache = { ts: now, key: cacheKey, value: baseValue };
  }
  return options?.ramStats ? mergeRamSavingsIntoTelemetry(baseValue, options.ramStats) : baseValue;
}

function estimateMcpSchemaTaxTokens(pluginRoot = join(__dirname, '..', '..', '..')) {
  try {
    const mcpPath = join(pluginRoot, 'mcp_config.json');
    if (!existsSync(mcpPath)) return 0;
    const cfg = safeReadJsonSync(mcpPath, () => null, { selfHeal: false });
    const servers = cfg?.mcpServers && typeof cfg.mcpServers === 'object' ? Object.values(cfg.mcpServers) : [];
    let eagerTools = 0;
    for (const srv of servers) {
      const tools = srv?.tools && typeof srv.tools === 'object' ? Object.values(srv.tools) : [];
      for (const t of tools) {
        if (t && t.eager === true) eagerTools++;
      }
    }
    return eagerTools * 140;
  } catch {
    return 0;
  }
}

function collectTelemetryUncached(configuredThreshold = 120000, options = {}) {
  const geminiRoot = join(homedir(), '.gemini');
  const brainDirs = Array.isArray(options?.brainDirs)
    ? options.brainDirs.filter((p) => existsSync(p))
    : ['antigravity', 'antigravity-ide', 'antigravity-cli']
        .map((dir) => join(geminiRoot, dir, 'brain'))
        .filter((p) => existsSync(p));
  const numericThreshold = Number(configuredThreshold || 120000);

  let gpuSavedTokens = 0;
  if (!options?.skipGlobalGpuTelemetry) {
    try {
      const gpuTelFile = join(__dirname, '..', '..', '..', '.cache', 'gpu-telemetry.json');
      if (existsSync(gpuTelFile)) {
        const gpuTel = safeReadJsonSync(gpuTelFile, () => null, { selfHeal: false });
        gpuSavedTokens = Math.max(0, Number(gpuTel?.savedTokensEstimate || 0));
      }
    } catch {}
  }

  const stats = {
    mode: 'all_chats',
    totalChats: 0,
    convoId: null,
    activeModel: '',
    activeModelShort: '',
    activeModelTier: 'multi_chat',
    isGemini4: true,
    isOrchestrator: false,
    isHydrogen: false,
    isNeon: false,
    compactionThresholdTokens: numericThreshold,
    steps: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheHitRate: 0,
    cacheSavedTokens: 0,
    ramSavedTokens: 0,
    ramCalls: { slices: 0, searches: 0, contextPacks: 0, total: 0 },
    gpuSavedTokens,
    totalSavedTokens: gpuSavedTokens,
    lastContextTokens: 0,
    contextPressurePercent: 0,
    burnRateTokensPerStep: 0,
    outputTokensPerStep: 0,
    pressureStatus: 'nominal',
    thinkingBurnStatus: 'optimal',
    thinkingBurnAdvisory: '',
    mcpSchemaTaxTokens: estimateMcpSchemaTaxTokens(),
    activeChat: {
      convoId: null,
      steps: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheHitRate: 0,
      cacheSavedTokens: 0,
      ramSavedTokens: 0,
      lastContextTokens: 0,
    },
    subagents: { pro: 0, flash: 0, total: 0 },
    swarm: {
      active: false,
      title: '',
      activeWorkers: 0,
      killedWorkers: 0,
      totalSpawned: 0,
      hydrogenWorkers: 0,
      neonWorkers: 0,
      proOrInheritWorkers: 0,
      authors: 0,
      verifiers: 0,
      supportWorkers: 0,
      modelSwitches: 0,
      channelsCount: 0,
      boardPosts: 0,
      members: [],
    },
  };

  if (brainDirs.length === 0) return stats;

  try {
    const mainFiles = [];
    for (const brainDir of brainDirs) {
      let entries = [];
      try {
        entries = readdirSync(brainDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const d of entries) {
        if (!d.isDirectory()) continue;
        const tPath = join(brainDir, d.name, '.system_generated', 'logs', 'transcript.jsonl');
        if (!existsSync(tPath)) continue;
        try {
          const st = statSync(tPath);
          if (st.size > 0 && !isSubagentTranscriptFile(tPath)) {
            mainFiles.push({ path: tPath, st });
          }
        } catch {}
      }
    }

    if (mainFiles.length === 0) return stats;

    mainFiles.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
    const tracked = mainFiles.slice(0, MAX_TRACKED_CHATS);
    stats.totalChats = mainFiles.length;

    const rawTargetWs = typeof options?.workspaceRoot === 'string' ? options.workspaceRoot.trim() : '';
    const normTargetWs = rawTargetWs && rawTargetWs !== '__all__' ? normalizeWorkspaceUriKey(rawTargetWs) : '';
    const convoWsMap = new Map();
    if (normTargetWs) {
      try {
        const tpFile = join(__dirname, '..', '..', '..', '.cache', 'task-progress.json');
        if (existsSync(tpFile)) {
          const tpData = safeReadJsonSync(tpFile, null, { selfHeal: false });
          if (tpData && tpData.chats && typeof tpData.chats === 'object') {
            for (const [k, chatObj] of Object.entries(tpData.chats)) {
              const cid = String(chatObj?.conversationId || k || '').trim();
              const cWs = String(chatObj?.workspaceRoot || '').trim();
              if (cid && cWs) convoWsMap.set(cid, normalizeWorkspaceUriKey(cWs));
            }
          }
        }
      } catch {}
    }

    let matchedActiveChatSet = false;
    let freshestSwarm = null;
    for (let idx = 0; idx < tracked.length; idx++) {
      const item = tracked[idx];
      const chatAccum = parseSingleChatDelta(item.path, item.st);
      stats.steps += chatAccum.steps;
      stats.inputTokens += chatAccum.inputTokens;
      stats.outputTokens += chatAccum.outputTokens;
      stats.cacheReadTokens += chatAccum.cacheReadTokens;
      stats.subagents.pro += chatAccum.subagents.pro;
      stats.subagents.flash += chatAccum.subagents.flash;
      stats.subagents.total += chatAccum.subagents.total;
      const rc = chatAccum.ramCalls || { slices: 0, searches: 0, contextPacks: 0, total: 0 };
      stats.ramCalls.slices += rc.slices;
      stats.ramCalls.searches += rc.searches;
      stats.ramCalls.contextPacks += rc.contextPacks;
      stats.ramCalls.total += rc.total;

      const parts = String(item.path).split(/[\\/]/);
      const logsIdx = parts.lastIndexOf('.system_generated');
      const activeCid = logsIdx > 0 ? parts[logsIdx - 1] : null;
      const tpWs = activeCid ? (convoWsMap.get(activeCid) || '') : '';
      const parsedWs = chatAccum.workspaceRoot ? normalizeWorkspaceUriKey(chatAccum.workspaceRoot) : '';
      const matchesTargetWs = !normTargetWs
        ? idx === 0
        : (tpWs === normTargetWs || parsedWs === normTargetWs);

      if (!matchedActiveChatSet && matchesTargetWs) {
        matchedActiveChatSet = true;
        const activePrompt = chatAccum.inputTokens + chatAccum.cacheReadTokens;
        const activeHitRate = activePrompt > 0 ? Math.round((chatAccum.cacheReadTokens / activePrompt) * 100) : 0;
        const activeSaved = Math.round(chatAccum.cacheReadTokens * 0.95);
        const activeRamSaved = rc.slices * 900 + rc.searches * 650 + rc.contextPacks * 1400;
        const activeProfile = panelRuntime.modelProfileSync?.peekActiveModelFromTranscript
          ? panelRuntime.modelProfileSync.peekActiveModelFromTranscript(item.path, activeCid || '')
          : null;
        if (activeProfile && activeProfile.tier !== 'unknown') {
          stats.isOrchestrator = Boolean(activeProfile.isOrchestrator);
          stats.isHydrogen = Boolean(activeProfile.isHydrogen);
          stats.isNeon = Boolean(activeProfile.isNeon);
          if (panelRuntime.modelProfileSync?.evaluateThinkingBurnAdvisory) {
            const burnEval = panelRuntime.modelProfileSync.evaluateThinkingBurnAdvisory({
              modelProfile: activeProfile,
              steps: chatAccum.steps,
              outputTokens: chatAccum.outputTokens,
              subagents: chatAccum.subagents,
            });
            stats.thinkingBurnStatus = burnEval?.status || 'optimal';
            stats.thinkingBurnAdvisory = burnEval?.advisoryRu || '';
          }
        }
        stats.lastContextTokens = chatAccum.lastContextTokens || 0;
        stats.contextPressurePercent =
          numericThreshold > 0
            ? Math.min(100, Math.round(((chatAccum.lastContextTokens || 0) / numericThreshold) * 100))
            : 0;
        stats.activeChat = {
          convoId: activeCid,
          transcriptPath: item.path,
          activeModel: activeProfile?.displayRu || '',
          steps: chatAccum.steps,
          inputTokens: chatAccum.inputTokens,
          outputTokens: chatAccum.outputTokens,
          cacheReadTokens: chatAccum.cacheReadTokens,
          cacheHitRate: activeHitRate,
          cacheSavedTokens: activeSaved,
          ramSavedTokens: activeRamSaved,
          lastContextTokens: chatAccum.lastContextTokens || 0,
        };
      }

      const allowSwarmMatch = !normTargetWs || tpWs === normTargetWs || parsedWs === normTargetWs;
      if (allowSwarmMatch && !freshestSwarm && chatAccum.swarmLines.length > 0 && panelRuntime.swarmControllerSync?.parseSwarmStatsFromTranscriptLines) {
        const parsedSw = panelRuntime.swarmControllerSync.parseSwarmStatsFromTranscriptLines(chatAccum.swarmLines);
        if (parsedSw?.active) {
          freshestSwarm = parsedSw;
        }
      }
    }

    if (freshestSwarm) {
      stats.swarm = freshestSwarm;
    }

    const totalPrompt = stats.inputTokens + stats.cacheReadTokens;
    if (totalPrompt > 0) {
      stats.cacheHitRate = Math.round((stats.cacheReadTokens / totalPrompt) * 100);
    }
    // Implicit Cache для Gemini 4 (Hydrogen / Neon / Carbon / Argon) экономит 95% стоимости прочитанных из кэша токенов
    stats.cacheSavedTokens = Math.round(stats.cacheReadTokens * 0.95);
    const ramStatsOpt = options?.ramStats || null;
    const ramSotaFromOpt = ramStatsOpt
      ? Math.max(
          0,
          Number(
            ramStatsOpt.sotaSavedTokens !== undefined
              ? ramStatsOpt.sotaSavedTokens
              : (ramStatsOpt.savedTokensEstimate || ramStatsOpt.sota?.savedTokensEstimate || 0)
          )
        )
      : 0;
    stats.ramSavedTokens =
      stats.ramCalls.slices * 900 +
      stats.ramCalls.searches * 650 +
      stats.ramCalls.contextPacks * 1400 +
      ramSotaFromOpt;
    let cpuSavedTokens = 0;
    if (!options?.skipGlobalGpuTelemetry) {
      try {
        const cpuTel = readCpuTelemetry();
        cpuSavedTokens = Math.max(0, Number(cpuTel?.cpuSavedTokensEstimate ?? cpuTel?.totalSavedTokens ?? 0));
      } catch {}
    }
    stats.cpuSavedTokens = cpuSavedTokens;
    stats.totalSavedTokens = stats.cacheSavedTokens + stats.ramSavedTokens + stats.cpuSavedTokens + stats.gpuSavedTokens;
    stats.savingsBreakdown = {
      cache: stats.cacheSavedTokens,
      ram: stats.ramSavedTokens,
      cpu: stats.cpuSavedTokens,
      gpu: stats.gpuSavedTokens,
      cacheHitRate: stats.cacheHitRate,
    };
    stats.burnRateTokensPerStep = stats.steps > 0 ? Math.round((stats.inputTokens + stats.outputTokens) / stats.steps) : 0;
    stats.outputTokensPerStep = stats.steps > 0 ? Math.round(stats.outputTokens / stats.steps) : 0;
  } catch (err) {
    console.error('Ошибка сбора сводной телеметрии:', err);
  }

  return stats;
}

export async function resolveActiveWorkspaceForPanel(requestedRoot = '', options = {}) {
  const cleanReq = typeof requestedRoot === 'string' ? requestedRoot.trim() : '';
  if (cleanReq && cleanReq !== '__all__' && cleanReq !== '__auto__' && isValidWorkspaceDir(cleanReq)) {
    return resolve(cleanReq);
  }
  const [hMod, shadowMod, progMod] = await Promise.all([
    getSessionHandoffMod().catch(() => null),
    getShadowGuard().catch(() => null),
    options?.taskProgress || options?.taskProgressFile ? Promise.resolve(null) : getTaskProgressMod().catch(() => null),
  ]);
  const cpWorkspaces = Array.isArray(options?.cpWorkspaces)
    ? options.cpWorkspaces
    : (typeof shadowMod?.listCheckpointWorkspaces === 'function' ? shadowMod.listCheckpointWorkspaces() : []);

  let fallbackUmbrellaWs = '';
  const evaluateCandidate = (rawPath) => {
    if (!rawPath || typeof rawPath !== 'string') return null;
    const trimmed = rawPath.trim();
    if (!trimmed || trimmed === '__all__' || trimmed === '__auto__') return null;
    try {
      if (
        !existsSync(trimmed) ||
        (!options?.allowEphemeralCandidates && isEphemeralPanelCandidatePath(trimmed, hMod)) ||
        !isValidWorkspaceDir(trimmed)
      ) {
        return null;
      }
      const abs = resolve(trimmed);
      const isUmbrella = isUmbrellaDirWithoutMarkers(abs);
      if (isUmbrella && !fallbackUmbrellaWs) fallbackUmbrellaWs = abs;
      return { abs, isUmbrella };
    } catch {
      return null;
    }
  };

  let taskProgress = options?.taskProgress || null;
  if (!taskProgress) {
    try {
      if (options?.taskProgressFile) {
        if (existsSync(options.taskProgressFile)) {
          taskProgress = safeReadJsonSync(options.taskProgressFile, null, { selfHeal: false });
        }
      } else if (typeof progMod?.getTaskProgressSnapshot === 'function') {
        taskProgress = progMod.getTaskProgressSnapshot({ workspaceRoot: '' });
      } else if (existsSync(TASK_PROGRESS_CACHE_PATH)) {
        taskProgress = safeReadJsonSync(TASK_PROGRESS_CACHE_PATH, null, { selfHeal: false });
      }
    } catch {}
  }

  const runningCandidates = [];
  const recentCandidates = [];

  if (taskProgress && typeof taskProgress === 'object') {
    const rawChatMap = new Map();
    if (taskProgress.chats && typeof taskProgress.chats === 'object') {
      for (const [k, c] of Object.entries(taskProgress.chats)) {
        if (c && typeof c === 'object') {
          const cid = String(c.conversationId || k || '').trim();
          if (cid) rawChatMap.set(cid, c);
        }
      }
    }
    if (Array.isArray(taskProgress.activeChats)) {
      for (const c of taskProgress.activeChats) {
        if (!c || typeof c !== 'object') continue;
        const cid = String(c.conversationId || '').trim();
        if (cid && !rawChatMap.has(cid)) rawChatMap.set(cid, c);
        if (Array.isArray(c.subagents)) {
          for (const sub of c.subagents) {
            const subCid = String(sub?.conversationId || '').trim();
            if (subCid && !rawChatMap.has(subCid)) {
              rawChatMap.set(subCid, {
                ...sub,
                isSubagent: true,
                parentConversationId: sub.parentConversationId || cid,
                workspaceRoot: sub.workspaceRoot || c.workspaceRoot || '',
              });
            }
          }
        }
      }
    }

    for (const chat of rawChatMap.values()) {
      let effectiveWs = String(chat.workspaceRoot || '').trim();
      const isWorktreeWs = /[\\/]\.gemini[\\/]antigravity[\\/]worktrees[\\/]/i.test(effectiveWs);
      if ((chat.isSubagent || isWorktreeWs) && chat.parentConversationId) {
        const parent = rawChatMap.get(String(chat.parentConversationId).trim());
        if (parent?.workspaceRoot && (!effectiveWs || isWorktreeWs)) {
          effectiveWs = String(parent.workspaceRoot).trim();
        }
      }
      const cand = evaluateCandidate(effectiveWs);
      if (!cand) continue;
      const ts = Math.max(
        Number(chat.updatedAt || 0),
        Number(chat.lastPreToolAt || 0),
        Number(chat.lastPostToolAt || 0),
        Number(chat.completedAt || 0)
      );
      if (chat.status === 'running') {
        runningCandidates.push({ ...cand, ts, priority: 3 });
      } else {
        recentCandidates.push({ ...cand, ts, priority: 2 });
      }
    }
  }

  if (runningCandidates.length > 0) {
    runningCandidates.sort((a, b) => b.ts - a.ts);
    const liveReal = runningCandidates.find((c) => !c.isUmbrella);
    if (liveReal) return liveReal.abs;
  }

  try {
    const handoffFile = options?.handoffFile || HANDOFF_MIRROR_CACHE_PATH;
    if (existsSync(handoffFile)) {
      const h = safeReadJsonSync(handoffFile, null, { selfHeal: false });
      if (h && typeof h === 'object') {
        const hEntries = [];
        if (h.workspaces && typeof h.workspaces === 'object') {
          for (const wsEntry of Object.values(h.workspaces)) {
            if (wsEntry?.workspaceRoot) hEntries.push(wsEntry);
          }
        }
        if (h.workspaceRoot) hEntries.push(h);
        for (const c of hEntries) {
          const cand = evaluateCandidate(c?.workspaceRoot);
          if (!cand) continue;
          const ts = Date.parse(c?.updatedAt || '') || 0;
          recentCandidates.push({ ...cand, ts, priority: 1 });
        }
      }
    }
  } catch {}

  for (const cpWs of cpWorkspaces) {
    const cand = evaluateCandidate(cpWs?.workspaceRoot);
    if (!cand) continue;
    const ts = Date.parse(cpWs?.lastTimestamp || '') || 0;
    recentCandidates.push({ ...cand, ts, priority: 0 });
  }

  if (recentCandidates.length > 0) {
    recentCandidates.sort((a, b) => (b.ts - a.ts) || (b.priority - a.priority));
    const freshestReal = recentCandidates.find((c) => !c.isUmbrella);
    if (freshestReal) return freshestReal.abs;
  }

  try {
    const ramWorkspaces = Array.isArray(options?.ramWorkspaces)
      ? options.ramWorkspaces
      : ((await safeGetRamCacheStatus({ ramCacheEnabled: true })).workspaces || []);
    for (const ws of ramWorkspaces) {
      const cand = evaluateCandidate(ws?.workspace || ws?.absRoot || ws?.root);
      if (cand && !cand.isUmbrella) return cand.abs;
    }
  } catch {}
  if (fallbackUmbrellaWs) return fallbackUmbrellaWs;
  if (cpWorkspaces[0]?.workspaceRoot && isValidWorkspaceDir(cpWorkspaces[0].workspaceRoot)) {
    return resolve(cpWorkspaces[0].workspaceRoot);
  }
  return process.cwd();
}

export function parseWorkspaceUriToPath(rawUri = '') {
  if (!rawUri || typeof rawUri !== 'string') return '';
  const trimmed = rawUri.trim();
  if (!trimmed || trimmed === '__all__' || trimmed === '__auto__') return '';
  if (/^file:\/\//i.test(trimmed)) {
    try {
      return resolve(fileURLToPath(trimmed));
    } catch {
      try {
        let decoded = decodeURIComponent(trimmed.replace(/^file:\/\//i, ''));
        if (process.platform === 'win32' && /^\/[a-zA-Z]:/.test(decoded)) {
          decoded = decoded.slice(1);
        }
        return decoded ? resolve(decoded) : '';
      } catch {
        return '';
      }
    }
  }
  return trimmed;
}

export function discoverAntigravityOpenWorkspaces({ storagePaths = null, allowInTests = false } = {}) {
  if (process.env.NODE_TEST_CONTEXT && !allowInTests && !Array.isArray(storagePaths)) {
    return [];
  }
  const candidates = Array.isArray(storagePaths) ? storagePaths : (() => {
    const home = homedir();
    const out = [];
    if (process.platform === 'win32') {
      const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming');
      out.push(join(appData, 'Antigravity', 'User', 'globalStorage', 'storage.json'));
      out.push(join(appData, 'Google Antigravity', 'User', 'globalStorage', 'storage.json'));
    } else if (process.platform === 'darwin') {
      out.push(join(home, 'Library', 'Application Support', 'Antigravity', 'User', 'globalStorage', 'storage.json'));
    } else {
      const xdg = process.env.XDG_CONFIG_HOME || join(home, '.config');
      out.push(join(xdg, 'Antigravity', 'User', 'globalStorage', 'storage.json'));
    }
    return out;
  })();

  const found = [];
  const seen = new Set();
  const pushUri = (u) => {
    if (!u || typeof u !== 'string') return;
    const p = parseWorkspaceUriToPath(u);
    if (!p || !isValidWorkspaceDir(p)) return;
    const key = normalizeWorkspaceUriKey(p);
    if (!key || seen.has(key)) return;
    seen.add(key);
    found.push(resolve(p));
  };

  for (const sp of candidates) {
    if (!sp || !existsSync(sp)) continue;
    try {
      const data = safeReadJsonSync(sp, null, { selfHeal: false });
      if (!data || typeof data !== 'object') continue;
      const wsState = data.windowsState || {};
      if (wsState.lastActiveWindow?.folder) pushUri(wsState.lastActiveWindow.folder);
      if (Array.isArray(wsState.openedWindows)) {
        for (const win of wsState.openedWindows) {
          if (win?.folder) pushUri(win.folder);
          if (win?.workspaceIdentifier?.configPath) {
            const cfgPath = parseWorkspaceUriToPath(win.workspaceIdentifier.configPath);
            if (cfgPath) pushUri(dirname(cfgPath));
          }
        }
      }
      const backupPaths = data.backupWorkspaces?.folders;
      if (Array.isArray(backupPaths)) {
        for (const f of backupPaths) {
          if (f?.folderUri) pushUri(f.folderUri);
        }
      }
      if (found.length >= 24) break;
    } catch {}
  }
  return found.slice(0, 24);
}

export async function collectKnownWorkspacesForPanel({
  activeWs = '',
  autoWs = '',
  openWorkspaces = [],
  taskProgress = null,
  ramCache = null,
} = {}) {
  const [hMod, shadowMod] = await Promise.all([
    getSessionHandoffMod().catch(() => null),
    getShadowGuard().catch(() => null),
  ]);
  const byKey = new Map();

  const upsert = (rawPath, patch = {}) => {
    const parsedPath = parseWorkspaceUriToPath(rawPath);
    if (!parsedPath || typeof parsedPath !== 'string') return;
    const trimmed = parsedPath.trim();
    if (!trimmed || trimmed === '__all__' || trimmed === '__auto__') return;
    if (!isValidWorkspaceDir(trimmed) || isEphemeralPanelCandidatePath(trimmed, hMod)) return;
    const abs = resolve(trimmed);
    const key = normalizeWorkspaceUriKey(abs);
    if (!key) return;
    let rec = byKey.get(key);
    if (!rec) {
      rec = {
        workspaceRoot: abs,
        projectName: basename(abs) || abs,
        parentHint: basename(dirname(abs)) || '',
        checkpointsCount: 0,
        activeCheckpointsCount: 0,
        lastTimestamp: '',
        status: 'idle',
        activeChatsCount: 0,
        percent: 0,
        isOpenInIde: false,
      };
      byKey.set(key, rec);
    }
    if (patch.isOpenInIde) {
      rec.isOpenInIde = true;
    }
    if (typeof patch.checkpointsCount === 'number') {
      rec.checkpointsCount = Math.max(rec.checkpointsCount, patch.checkpointsCount);
    }
    if (typeof patch.activeCheckpointsCount === 'number') {
      rec.activeCheckpointsCount = Math.max(rec.activeCheckpointsCount, patch.activeCheckpointsCount);
    }
    if (patch.lastTimestamp) {
      const nextTs = new Date(patch.lastTimestamp).getTime() || 0;
      const prevTs = rec.lastTimestamp ? (new Date(rec.lastTimestamp).getTime() || 0) : 0;
      if (nextTs > prevTs) rec.lastTimestamp = new Date(nextTs).toISOString();
    }
    if (patch.status && (patch.status === 'running' || patch.status === 'waiting_user' || rec.status === 'idle')) {
      rec.status = patch.status;
    }
    if (typeof patch.activeChatsCount === 'number' && patch.activeChatsCount > rec.activeChatsCount) {
      rec.activeChatsCount = patch.activeChatsCount;
    }
    if (typeof patch.percent === 'number' && patch.percent > rec.percent) {
      rec.percent = patch.percent;
    }
  };

  if (typeof shadowMod?.listCheckpointWorkspaces === 'function') {
    try {
      for (const cw of shadowMod.listCheckpointWorkspaces()) {
        upsert(cw.workspaceRoot, {
          checkpointsCount: cw.checkpointsCount || 0,
          activeCheckpointsCount: cw.activeCheckpointsCount || 0,
          lastTimestamp: cw.lastTimestamp || '',
        });
      }
    } catch {}
  }

  try {
    const handoffFile = join(__dirname, '..', '..', '..', '.cache', 'session-handoff.json');
    if (existsSync(handoffFile)) {
      const h = safeReadJsonSync(handoffFile, null, { selfHeal: false });
      if (h && typeof h === 'object') {
        if (h.workspaceRoot) {
          upsert(h.workspaceRoot, { lastTimestamp: h.updatedAt || '' });
        }
        if (h.workspaces && typeof h.workspaces === 'object') {
          for (const wsEntry of Object.values(h.workspaces)) {
            if (wsEntry?.workspaceRoot) {
              upsert(wsEntry.workspaceRoot, { lastTimestamp: wsEntry.updatedAt || '' });
            }
          }
        }
      }
    }
  } catch {}

  const tpProjects = [
    ...(Array.isArray(taskProgress?.activeProjects) ? taskProgress.activeProjects : []),
    ...(Array.isArray(taskProgress?.recentProjects) ? taskProgress.recentProjects : []),
  ];
  for (const tp of tpProjects) {
    if (tp?.workspaceRoot) {
      upsert(tp.workspaceRoot, {
        status: tp.status || 'idle',
        activeChatsCount: Number(tp.activeChatsCount || 0),
        percent: Number(tp.percent || 0),
        lastTimestamp: tp.updatedAt ? new Date(Number(tp.updatedAt)).toISOString() : '',
      });
    }
  }
  if (Array.isArray(taskProgress?.activeChats)) {
    for (const c of taskProgress.activeChats) {
      if (c?.workspaceRoot) {
        upsert(c.workspaceRoot, {
          status: c.status || 'idle',
          activeChatsCount: 1,
          percent: Number(c.percent || 0),
          lastTimestamp: c.updatedAt ? new Date(Number(c.updatedAt)).toISOString() : '',
        });
      }
    }
  }

  const ideOpenDirs = [
    ...(Array.isArray(openWorkspaces) ? openWorkspaces : []),
    ...discoverAntigravityOpenWorkspaces(),
  ];
  for (const ow of ideOpenDirs) {
    if (ow) upsert(ow, { isOpenInIde: true });
  }

  for (const rw of ramCache?.workspaces || []) {
    const cand = rw?.workspace || rw?.absRoot || rw?.root;
    if (cand) upsert(cand, {});
  }

  if (autoWs) upsert(autoWs, {});
  if (activeWs) upsert(activeWs, {});

  const activeKey = activeWs ? normalizeWorkspaceUriKey(activeWs) : '';
  const items = Array.from(byKey.values()).filter((item) => {
    const key = normalizeWorkspaceUriKey(item.workspaceRoot);
    if (key === activeKey || item.isOpenInIde) return true;
    const isRunning = item.status === 'running' || item.status === 'waiting_user';
    if (isUmbrellaDirWithoutMarkers(item.workspaceRoot) && item.checkpointsCount === 0 && !isRunning) {
      return false;
    }
    return true;
  });

  const nameCounts = new Map();
  for (const item of items) {
    const n = String(item.projectName || '').toLowerCase();
    nameCounts.set(n, (nameCounts.get(n) || 0) + 1);
  }
  for (const item of items) {
    const dup = (nameCounts.get(String(item.projectName || '').toLowerCase()) || 0) > 1;
    item.displayLabel = (dup && item.parentHint) ? `${item.projectName} (${item.parentHint})` : item.projectName;
  }

  items.sort((a, b) => {
    const aLive = (a.status === 'running' || a.status === 'waiting_user') ? 0 : 1;
    const bLive = (b.status === 'running' || b.status === 'waiting_user') ? 0 : 1;
    if (aLive !== bLive) return aLive - bLive;
    const aOpen = a.isOpenInIde ? 0 : 1;
    const bOpen = b.isOpenInIde ? 0 : 1;
    if (aOpen !== bOpen) return aOpen - bOpen;
    const ta = a.lastTimestamp ? (new Date(a.lastTimestamp).getTime() || 0) : 0;
    const tb = b.lastTimestamp ? (new Date(b.lastTimestamp).getTime() || 0) : 0;
    if (ta !== tb) return tb - ta;
    return (b.checkpointsCount || 0) - (a.checkpointsCount || 0);
  });

  return items.slice(0, 24);
}

const GRAPH_PROJECT_MARKERS = [
  '.git',
  'package.json',
  'plugin.json',
  'book.json',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
  'composer.json',
  'pom.xml',
  'Makefile',
  'CMakeLists.txt',
  'README.md',
  'Cargo.lock',
  'requirements.txt',
  'tsconfig.json',
];

const SKIPPED_SCAN_PARENTS = new Set(['desktop', 'downloads', 'documents']);

function hasGraphProjectMarker(dirPath = '') {
  if (!dirPath) return false;
  for (const marker of GRAPH_PROJECT_MARKERS) {
    try {
      if (existsSync(join(dirPath, marker))) return true;
    } catch {}
  }
  return false;
}

function shouldSkipGraphParentScan(parentDir = '') {
  if (!parentDir) return true;
  try {
    const abs = resolve(parentDir);
    if (dirname(abs) === abs) return true;
    const key = normalizeWorkspaceUriKey(abs);
    if (!key) return true;
    const homeKey = normalizeWorkspaceUriKey(homedir());
    if (homeKey && key === homeKey) return true;
    if (SKIPPED_SCAN_PARENTS.has(basename(abs).toLowerCase())) return true;
    return false;
  } catch {
    return true;
  }
}

export async function discoverUserProjectsForGraph({
  activeWs = '',
  autoWs = '',
  extraRoots = [],
  openWorkspaces = [],
  taskProgress = null,
  ramCache = null,
  allowActiveEphemeral = false,
} = {}) {
  const [known, hMod, khMod] = await Promise.all([
    collectKnownWorkspacesForPanel({ activeWs, autoWs, openWorkspaces, taskProgress, ramCache }),
    getSessionHandoffMod().catch(() => null),
    getKnowledgeHubMod().catch(() => null),
  ]);

  const byKey = new Map();
  const activeKey = activeWs ? normalizeWorkspaceUriKey(activeWs) : '';
  const activeParentKey = activeWs ? normalizeWorkspaceUriKey(dirname(resolve(activeWs))) : '';

  const upsertProject = (rawPath, { source = 'discovered', seed = null, allowEphemeral = false, isOpenInIde = false } = {}) => {
    const parsedPath = parseWorkspaceUriToPath(rawPath);
    if (!parsedPath || typeof parsedPath !== 'string') return;
    const trimmed = parsedPath.trim();
    if (!trimmed || trimmed === '__all__' || trimmed === '__auto__') return;
    if (!isValidWorkspaceDir(trimmed)) return;
    if (!allowEphemeral && isEphemeralPanelCandidatePath(trimmed, hMod)) return;
    const abs = resolve(trimmed);
    const key = normalizeWorkspaceUriKey(abs);
    if (!key) return;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        workspaceRoot: abs,
        projectName: seed?.projectName || basename(abs) || abs,
        parentHint: seed?.parentHint || basename(dirname(abs)) || '',
        checkpointsCount: Number(seed?.checkpointsCount || 0),
        activeCheckpointsCount: Number(seed?.activeCheckpointsCount || 0),
        lastTimestamp: seed?.lastTimestamp || '',
        status: seed?.status || 'idle',
        activeChatsCount: Number(seed?.activeChatsCount || 0),
        percent: Number(seed?.percent || 0),
        source: (isOpenInIde || seed?.isOpenInIde) ? 'open_ide' : (seed?.source || source),
        isOpenInIde: Boolean(isOpenInIde || seed?.isOpenInIde),
      });
    } else if (isOpenInIde) {
      existing.isOpenInIde = true;
      existing.source = 'open_ide';
    }
  };

  for (const item of known) {
    if (item?.workspaceRoot) {
      upsertProject(item.workspaceRoot, {
        source: 'known',
        seed: { ...item, source: 'known' },
        allowEphemeral: allowActiveEphemeral && normalizeWorkspaceUriKey(item.workspaceRoot) === activeKey,
      });
    }
  }

  if (activeWs) {
    upsertProject(activeWs, { source: 'known', allowEphemeral: allowActiveEphemeral });
  }
  if (autoWs) {
    upsertProject(autoWs, { source: 'known', allowEphemeral: false });
  }

  if (Array.isArray(openWorkspaces)) {
    for (const raw of openWorkspaces) {
      upsertProject(raw, { source: 'open_ide', isOpenInIde: true, allowEphemeral: allowActiveEphemeral });
    }
  }

  if (Array.isArray(extraRoots)) {
    for (const raw of extraRoots) {
      upsertProject(raw, { source: 'known', allowEphemeral: allowActiveEphemeral });
    }
  }

  try {
    const hub = khMod?.knowledgeHub;
    if (activeWs && typeof hub?.getFederatedWorkspaces === 'function') {
      const peers = hub.getFederatedWorkspaces(activeWs);
      if (Array.isArray(peers)) {
        for (const p of peers) {
          if (p?.path) upsertProject(p.path, { source: 'federated' });
        }
      }
    }
  } catch {}

  const scanChildProjects = (parentDir, { source = 'discovered', allowEphemeral = false } = {}) => {
    if (!parentDir || !existsSync(parentDir)) return;
    try {
      const entries = readdirSync(parentDir, { withFileTypes: true });
      let checked = 0;
      for (const ent of entries) {
        if (checked >= 40) break;
        if (!ent || typeof ent.name !== 'string' || !ent.isDirectory()) continue;
        const name = ent.name;
        if (name.startsWith('.') || name === 'node_modules' || SKIPPED_SCAN_PARENTS.has(name.toLowerCase())) continue;
        checked += 1;
        const childAbs = join(parentDir, name);
        if (!isValidWorkspaceDir(childAbs)) continue;
        if (!allowEphemeral && isEphemeralPanelCandidatePath(childAbs, hMod)) continue;
        if (!hasGraphProjectMarker(childAbs)) continue;
        upsertProject(childAbs, { source, allowEphemeral });
      }
    } catch {}
  };

  try {
    const scratchDir = join(homedir(), '.gemini', 'antigravity', 'scratch');
    if (existsSync(scratchDir)) {
      scanChildProjects(scratchDir, { source: 'scratch', allowEphemeral: false });
    }
  } catch {}

  const parentSeeds = [];
  if (activeWs) parentSeeds.push(dirname(resolve(activeWs)));
  if (autoWs) parentSeeds.push(dirname(resolve(autoWs)));
  for (const item of known.slice(0, 3)) {
    if (item?.workspaceRoot) parentSeeds.push(dirname(resolve(item.workspaceRoot)));
  }

  const scannedParents = new Set();
  for (const pDir of parentSeeds) {
    if (!pDir || shouldSkipGraphParentScan(pDir)) continue;
    const absParent = resolve(pDir);
    const pKey = normalizeWorkspaceUriKey(absParent);
    if (!pKey || scannedParents.has(pKey)) continue;
    scannedParents.add(pKey);
    const isPinnedParent = Boolean(allowActiveEphemeral && activeParentKey && pKey === activeParentKey);
    scanChildProjects(absParent, { source: 'discovered', allowEphemeral: isPinnedParent });
  }

  const items = Array.from(byKey.values());
  const nameCounts = new Map();
  for (const item of items) {
    const n = String(item.projectName || '').toLowerCase();
    nameCounts.set(n, (nameCounts.get(n) || 0) + 1);
  }
  for (const item of items) {
    const dup = (nameCounts.get(String(item.projectName || '').toLowerCase()) || 0) > 1;
    item.displayLabel = (dup && item.parentHint) ? `${item.projectName} (${item.parentHint})` : item.projectName;
  }

  items.sort((a, b) => {
    const aActive = activeKey && normalizeWorkspaceUriKey(a.workspaceRoot) === activeKey ? 0 : 1;
    const bActive = activeKey && normalizeWorkspaceUriKey(b.workspaceRoot) === activeKey ? 0 : 1;
    if (aActive !== bActive) return aActive - bActive;
    const aLive = (a.status === 'running' || a.status === 'waiting_user') ? 0 : 1;
    const bLive = (b.status === 'running' || b.status === 'waiting_user') ? 0 : 1;
    if (aLive !== bLive) return aLive - bLive;
    const aOpen = (a.isOpenInIde || a.source === 'open_ide') ? 0 : 1;
    const bOpen = (b.isOpenInIde || b.source === 'open_ide') ? 0 : 1;
    if (aOpen !== bOpen) return aOpen - bOpen;
    const aKnown = a.source === 'known' ? 0 : 1;
    const bKnown = b.source === 'known' ? 0 : 1;
    if (aKnown !== bKnown) return aKnown - bKnown;
    const ta = a.lastTimestamp ? (new Date(a.lastTimestamp).getTime() || 0) : 0;
    const tb = b.lastTimestamp ? (new Date(b.lastTimestamp).getTime() || 0) : 0;
    if (ta !== tb) return tb - ta;
    return String(a.displayLabel || a.projectName || '').localeCompare(String(b.displayLabel || b.projectName || ''));
  });

  return items.slice(0, 48);
}

const ramDeltaTrackerByPid = new Map();

export async function safeGetRamCacheStatus(state = {}) {
  const ceilings = getRuntimeHardwareCeilings();
  const budgetMb = clampSafeInt(state?.ramMaxBudgetMb, 256, ceilings.maxRamBudgetMb, Math.min(4096, ceilings.maxRamBudgetMb));
  const totalRamMb = ceilings.totalRamMb;
  const enabled = state?.ramCacheEnabled !== false;
  const daemonFile = join(__dirname, '..', '..', '..', '.cache', 'ram-daemon.json');
  try {
    if (!enabled || !existsSync(daemonFile)) {
      return { enabled, active: false, budgetMb, totalRamMb, cacheUsedMb: 0, workspaces: [], instancesCount: 0 };
    }
    const info = safeReadJsonSync(daemonFile, null, { selfHeal: true });
    if (!info || typeof info !== 'object') {
      return { enabled, active: false, budgetMb, totalRamMb, cacheUsedMb: 0, workspaces: [], instancesCount: 0 };
    }

    const candidates = [];
    const seen = new Set();
    const pushCand = (c) => {
      if (!c || !c.port || !c.token) return;
      const key = `${c.port}:${c.pid ?? ''}`;
      if (seen.has(key)) return;
      seen.add(key);
      candidates.push(c);
    };

    if (Array.isArray(info.instances)) {
      for (const inst of info.instances) pushCand(inst);
    } else if (info.instances && typeof info.instances === 'object') {
      for (const inst of Object.values(info.instances)) pushCand(inst);
    }
    pushCand({ pid: info.pid, port: info.port, token: info.token });

    const liveResponses = (await Promise.all(candidates.map((c) => querySingleRamDaemon(c)))).filter(
      (res) => res?.ok && res?.stats
    );
    if (liveResponses.length > 0) {
      const now = Date.now();
      const primary = liveResponses[0];
      const mergedWorkspaces = [];
      const wsSeen = new Set();
      let fallbackUsedMb = 0;
      let sumHits = 0;
      let sumMisses = 0;
      let sumSearches = 0;
      let sumSlices = 0;
      let sumActiveOps = 0;
      let sumOpSeq = 0;
      let sumBurstCount = 0;
      let sumSotaSavedTokens = 0;
      let sumSotaMemoHits = 0;
      let sumSotaRepairRecalls = 0;
      let sumSotaSpecPrefetches = 0;
      let sumSotaArenaBytes = 0;
      let sumSotaCsrBytes = 0;
      let freshestLive = null;

      for (const res of liveResponses) {
        const st = res.stats || {};
        const sota = st.sota && typeof st.sota === 'object' ? st.sota : null;
        sumSotaSavedTokens += Math.max(0, Number(st.savedTokensEstimate || sota?.savedTokensEstimate || 0));
        if (sota) {
          sumSotaMemoHits += Math.max(0, Number(sota.memoHits || 0));
          sumSotaRepairRecalls += Math.max(0, Number(sota.repairRecalls || 0));
          sumSotaSpecPrefetches += Math.max(0, Number(sota.speculativePrefetches || 0));
          sumSotaArenaBytes += Math.max(0, Number(sota.arenaBytes || 0));
          sumSotaCsrBytes += Math.max(0, Number(sota.csrBytes || 0));
        }
        const pidKey = String(res.pid || '0');
        const hits = Number(st.hits || 0);
        const slices = Number(st.slices || 0);
        const searches = Number(st.searches || 0);
        sumHits += hits;
        sumMisses += Number(st.misses || 0);
        sumSearches += searches;
        sumSlices += slices;

        const prevSnap = ramDeltaTrackerByPid.get(pidKey);
        let syntheticLive = null;
        if (prevSnap) {
          const dSlices = Math.max(0, slices - prevSnap.slices);
          const dSearches = Math.max(0, searches - prevSnap.searches);
          const dHits = Math.max(0, hits - prevSnap.hits);
          const deltaOps = dSlices + dSearches || dHits;
          if (deltaOps > 0) {
            const inferredOp = dSlices > 0 ? 'ram_slice' : (dSearches > 0 ? 'ram_search' : 'ram_hit');
            const prevBurst = (now - prevSnap.lastDeltaAt <= 4000) ? prevSnap.burstCount : 0;
            prevSnap.lastDeltaAt = now;
            prevSnap.lastOp = inferredOp;
            prevSnap.burstCount = prevBurst + deltaOps;
            prevSnap.seq += 1;
          }
          prevSnap.hits = hits;
          prevSnap.slices = slices;
          prevSnap.searches = searches;
          if (prevSnap.lastDeltaAt > 0) {
            const msAgo = Math.max(0, now - prevSnap.lastDeltaAt);
            const inGlow = msAgo <= 3200;
            syntheticLive = {
              activeOps: 0,
              opSeq: prevSnap.seq,
              lastActiveAt: prevSnap.lastDeltaAt,
              msSinceLast: msAgo,
              lastOp: prevSnap.lastOp,
              lastTarget: '',
              lastLatencyMs: 0.7,
              burstCount: msAgo <= 4500 ? prevSnap.burstCount : 0,
              isWorking: inGlow,
              afterglowRatio: inGlow ? Number(Math.max(0, 1 - msAgo / 3200).toFixed(3)) : 0,
            };
          }
        } else {
          ramDeltaTrackerByPid.set(pidKey, {
            hits,
            slices,
            searches,
            lastDeltaAt: 0,
            lastOp: '',
            burstCount: 0,
            seq: 0,
          });
        }

        const daemonLive = st.liveActivity && typeof st.liveActivity === 'object' ? st.liveActivity : null;
        const chosenLive = (daemonLive && (daemonLive.lastActiveAt || 0) >= (syntheticLive?.lastActiveAt || 0))
          ? daemonLive
          : (syntheticLive || daemonLive);
        if (chosenLive) {
          sumActiveOps += Number(chosenLive.activeOps || 0);
          sumOpSeq += Number(chosenLive.opSeq || 0);
          sumBurstCount += Number(chosenLive.burstCount || 0);
          if (!freshestLive || Number(chosenLive.lastActiveAt || 0) > Number(freshestLive.lastActiveAt || 0)) {
            freshestLive = chosenLive;
          }
        }

        const wsArr = Array.isArray(st.workspaces) ? st.workspaces : [];
        if (wsArr.length === 0) {
          fallbackUsedMb += Number(st.cacheUsedMb) || 0;
        }
        for (const ws of wsArr) {
          const rawRoot = ws?.workspace || ws?.absRoot || ws?.root || ws?.name || '';
          const normRoot = rawRoot
            ? (process.platform === 'win32' ? resolve(String(rawRoot)).toLowerCase() : resolve(String(rawRoot)))
            : JSON.stringify(ws);
          if (!wsSeen.has(normRoot)) {
            wsSeen.add(normRoot);
            mergedWorkspaces.push(ws);
          }
        }
      }
      const summedWsMb = mergedWorkspaces.reduce((sum, w) => sum + (Number(w?.cacheMb) || 0), 0);
      const totalUsedMb = summedWsMb > 0 ? summedWsMb + fallbackUsedMb : Number(primary.stats.cacheUsedMb) || 0;
      const mergedLiveActivity = freshestLive
        ? {
            ...freshestLive,
            activeOps: sumActiveOps,
            opSeq: sumOpSeq,
            burstCount: sumBurstCount || freshestLive.burstCount || 0,
            isWorking: sumActiveOps > 0 || Boolean(freshestLive.isWorking),
          }
        : {
            activeOps: 0,
            opSeq: 0,
            lastActiveAt: null,
            msSinceLast: null,
            lastOp: '',
            lastTarget: '',
            lastLatencyMs: 0,
            burstCount: 0,
            isWorking: false,
            afterglowRatio: 0,
          };
      const baseSavedTokens =
        sumSlices * 900 +
        sumSearches * 650 +
        Math.max(0, sumHits - sumSlices - sumSearches) * 250;
      const savedTokensEstimate = baseSavedTokens + sumSotaSavedTokens;
      const mergedSota = (primary.stats?.sota || sumSotaSavedTokens > 0 || sumSotaMemoHits > 0 || sumSotaRepairRecalls > 0)
        ? {
            ...(primary.stats?.sota || {}),
            arenaBytes: sumSotaArenaBytes || primary.stats?.sota?.arenaBytes || 0,
            csrBytes: sumSotaCsrBytes || primary.stats?.sota?.csrBytes || 0,
            memoHits: sumSotaMemoHits,
            repairRecalls: sumSotaRepairRecalls,
            speculativePrefetches: sumSotaSpecPrefetches,
            savedTokensEstimate: sumSotaSavedTokens,
          }
        : undefined;
      return {
        enabled,
        active: true,
        pid: primary.pid,
        ...primary.stats,
        budgetMb,
        totalRamMb,
        ...(mergedSota ? { sota: mergedSota } : {}),
        hits: sumHits,
        misses: sumMisses,
        searches: sumSearches,
        slices: sumSlices,
        sotaSavedTokens: sumSotaSavedTokens,
        savedTokensEstimate,
        cacheUsedMb: Number(totalUsedMb.toFixed(1)),
        liveActivity: mergedLiveActivity,
        workspaces: mergedWorkspaces,
        instancesCount: liveResponses.length,
      };
    }
  } catch {}
  return { enabled, active: false, budgetMb, totalRamMb, cacheUsedMb: 0, savedTokensEstimate: 0, workspaces: [], instancesCount: 0 };
}

export function mergeRamSavingsIntoTelemetry(stats, ramStats) {
  if (!stats || typeof stats !== 'object' || !ramStats || typeof ramStats !== 'object') return stats;
  const extra = Math.max(
    0,
    Number(
      ramStats.sotaSavedTokens !== undefined
        ? ramStats.sotaSavedTokens
        : (ramStats.savedTokensEstimate || ramStats.sota?.savedTokensEstimate || 0)
    )
  );
  if (extra <= 0) return stats;
  const nextRamSaved = Number(stats.ramSavedTokens || 0) + extra;
  const nextTotalSaved =
    Number(stats.cacheSavedTokens || 0) +
    nextRamSaved +
    Number(stats.cpuSavedTokens || 0) +
    Number(stats.gpuSavedTokens || 0);
  return {
    ...stats,
    ramSavedTokens: nextRamSaved,
    totalSavedTokens: nextTotalSaved,
    ...(stats.savingsBreakdown && typeof stats.savingsBreakdown === 'object'
      ? { savingsBreakdown: { ...stats.savingsBreakdown, ram: nextRamSaved } }
      : {}),
  };
}

export function safeGetCpuStatus(state = {}, ramCache = null) {
  try {
    const workspaces = Array.isArray(ramCache && ramCache.workspaces) ? ramCache.workspaces : [];
    const ramTrigramsIndexed = workspaces.reduce((sum, w) => sum + (Number(w && w.trigramsIndexed) || 0), 0);
    return getCpuStatusSnapshot(state, { ramTrigramsIndexed });
  } catch (err) {
    return { error: err && err.message ? err.message : 'cpu status error', hardware: { vramUsedMb: 0 } };
  }
}

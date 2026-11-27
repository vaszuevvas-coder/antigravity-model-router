/**
 * @file panel-telemetry-collectors.mjs
 * @description Telemetry aggregation, workspace resolution, RAM/CPU/GPU/Bayesian/checkpoint snapshots.
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeReadJsonSync, updateJsonAtomicSync } from '../../../core/safe-json.mjs';
import { isPidAlive, resolveTunnelCacheDir } from '../../../core/cache-dir.mjs';
import { pickLang } from '../../../core/i18n.mjs';
import { getCpuStatusSnapshot, readCpuTelemetry } from '../../../core/cpu-worker-pool.mjs';
import { isSubagentTranscriptFile } from '../../../core/model-profile.mjs';
import { isValidWorkspaceDir } from './panel-security.mjs';
import {
  getHandoffMirrorCachePath,
  getPanelCacheDir,
  getRamDaemonCachePath,
  getTaskProgressCachePath,
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

const MAX_SAFE_DATE_MS = 8_640_000_000_000_000;

function toFiniteNonNeg(val, fallback = 0) {
  const n = Number(val);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function toValidMsOrZero(val) {
  if (val === null || val === undefined || val === '' || typeof val === 'boolean') return 0;
  if (typeof val === 'number') {
    return Number.isFinite(val) && val > 0 && val <= MAX_SAFE_DATE_MS ? val : 0;
  }
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (!trimmed) return 0;
    const asNum = Number(trimmed);
    if (Number.isFinite(asNum)) {
      return asNum > 0 && asNum <= MAX_SAFE_DATE_MS ? asNum : 0;
    }
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) && parsed > 0 && parsed <= MAX_SAFE_DATE_MS ? parsed : 0;
  }
  return 0;
}

function toValidIsoOrEmpty(val) {
  const ms = toValidMsOrZero(val);
  return ms > 0 ? new Date(ms).toISOString() : '';
}

export async function safeGetHudAndProgressStatus(state = {}, activeWs = '') {
  try {
    const hudRuntimePath = join(getPanelCacheDir(), 'floating-hud.json');
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
          const validProgModes = new Set(['determinate', 'estimated', 'indeterminate', 'done', 'error', 'cancelled']);
          chat.backgroundTasks = chat.backgroundTasks.slice(0, 25).map((t) => {
            const rawPct = t?.progressPct;
            const progressPct = (typeof rawPct === 'number' && Number.isFinite(rawPct))
              ? Math.max(0, Math.min(100, Math.round(rawPct)))
              : null;
            const rawMode = String(t?.progressMode || '').trim();
            const progressMode = validProgModes.has(rawMode) ? rawMode : (String(t?.status || 'done') === 'running' ? 'indeterminate' : String(t?.status || 'done'));
            const rawEta = t?.etaSec;
            const etaSec = (typeof rawEta === 'number' && Number.isFinite(rawEta) && rawEta > 0)
              ? Math.min(86400, Math.round(rawEta))
              : null;
            return {
              id: String(t?.id || t?.taskId || '').slice(0, 80),
              taskId: String(t?.taskId || t?.id || '').slice(0, 80),
              label: String(t?.label || '').slice(0, 120),
              labelEn: String(t?.labelEn || '').slice(0, 120),
              commandPreview: String(t?.commandPreview || '').slice(0, 120),
              status: String(t?.status || 'done'),
              isDaemon: Boolean(t?.isDaemon),
              startedAt: toValidMsOrZero(t?.startedAt),
              updatedAt: toValidMsOrZero(t?.updatedAt),
              progressPct,
              progressMode,
              etaSec,
              progressText: String(t?.progressText || '').slice(0, 80),
            };
          });
        } else {
          chat.backgroundTasks = [];
        }
        chat.backgroundTasksTotalCount = Math.max(
          chat.backgroundTasks.length,
          Math.round(toFiniteNonNeg(chat.backgroundTasksTotalCount, 0))
        );
      }
    }
    return { hud: { running: false, enabled: false }, progress };
  } catch {
    return { hud: { running: false, enabled: false }, progress: null };
  }
}

const GPU_PANEL_CACHE_TTL_MS = 2500;
const GPU_PANEL_ERROR_GRACE_MS = 10_000;

export const gpuStatusPanelCache = { ts: 0, value: null };
let gpuStatusInFlight = null;
let gpuStatusSeq = 0;
let gpuStatusAppliedSeq = 0;

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
      if (!force && gpuStatusInFlight) {
        return await gpuStatusInFlight;
      }
      const reqSeq = ++gpuStatusSeq;
      const runFetch = (async () => {
        const snap = await mod.getGpuStatusSnapshot({ force });
        if (snap && reqSeq >= gpuStatusAppliedSeq) {
          gpuStatusAppliedSeq = reqSeq;
          Object.assign(gpuStatusPanelCache, { ts: Date.now(), value: snap });
        }
        return snap;
      })();
      if (!force) {
        gpuStatusInFlight = runFetch;
      }
      try {
        return await runFetch;
      } finally {
        if (!force && gpuStatusInFlight === runFetch) {
          gpuStatusInFlight = null;
        }
      }
    }
  } catch {}
  return (!force && gpuStatusPanelCache.value && Date.now() - gpuStatusPanelCache.ts <= GPU_PANEL_ERROR_GRACE_MS)
    ? gpuStatusPanelCache.value
    : null;
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
      return { ok: true, circuitBreaker: st, ...(res && typeof res === 'object' ? res : {}) };
    }
    return { ok: false, error: 'Circuit breaker module unavailable' };
  } catch (err) {
    console.warn('Ошибка resetCircuitBreaker:', err?.message || err);
    return { ok: false, error: err?.message || 'Failed to reset circuit breaker' };
  }
}

export async function safeCheckCompaction(thresholdTokens = 120000, telemetry = {}) {
  const safeTel = telemetry && typeof telemetry === 'object' ? telemetry : {};
  const rawThresh = Number(thresholdTokens);
  const thresh = Number.isFinite(rawThresh) && rawThresh > 0 ? rawThresh : 120000;
  try {
    const mod = await getHistoryCompactorMod();
    if (mod && typeof mod.checkHistoryCompaction === 'function') {
      const res = await mod.checkHistoryCompaction({
        conversationId: safeTel.activeChat?.convoId || '',
        transcriptPath: safeTel.activeChat?.transcriptPath || '',
        thresholdTokens: thresh,
        readOnly: true,
      });
      if (res) return res;
    }
  } catch (err) {
    console.warn('Ошибка checkHistoryCompaction:', err?.message || err);
  }
  const hasLastCtx = safeTel.activeChat?.lastContextTokens !== undefined && safeTel.activeChat?.lastContextTokens !== null;
  const promptTokens = hasLastCtx
    ? toFiniteNonNeg(safeTel.activeChat.lastContextTokens, 0)
    : (toFiniteNonNeg(safeTel.inputTokens, 0) + toFiniteNonNeg(safeTel.cacheReadTokens, 0));
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
    return { ok: false, error: 'History compactor module unavailable' };
  } catch (err) {
    console.warn('Ошибка triggerManualCompactionDigest:', err?.message || err);
    return { ok: false, error: err?.message || 'Failed to generate compaction digest' };
  }
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
      const res = await mod.clearPitfalls(workspaceRoot);
      return res && typeof res === 'object' ? { ok: true, cleared: true, ...res } : { ok: true, cleared: true };
    }
    return { ok: false, error: 'Pitfall ledger module unavailable' };
  } catch (err) {
    console.warn('Ошибка clearPitfalls:', err?.message || err);
    return { ok: false, error: err?.message || 'Failed to clear pitfalls' };
  }
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
    return { ok: false, error: 'Bayesian router module unavailable' };
  } catch (err) {
    console.warn('Ошибка resetBayesianPriors:', err?.message || err);
    return { ok: false, error: err?.message || 'Failed to reset Bayesian priors' };
  }
}

export async function safeListCheckpoints(limit = 8, workspaceRoot = '') {
  const safeLimit = clampSafeInt(limit, 0, 500, 8);
  if (safeLimit === 0) return [];
  try {
    const mod = await getShadowGuard();
    if (mod && typeof mod.listCheckpoints === 'function') {
      return await mod.listCheckpoints(safeLimit, workspaceRoot);
    }
  } catch (err) {
    console.warn('Ошибка listCheckpoints:', err?.message || err);
  }

  // Встроенный fallback: чтение файлов чекпоинтов
  try {
    const cpDir = join(homedir(), '.gemini', 'checkpoints');
    if (existsSync(cpDir)) {
      const cleanCpWs = (typeof workspaceRoot === 'string' && workspaceRoot.trim() && workspaceRoot.trim() !== '__all__')
        ? parseWorkspaceUriToPath(workspaceRoot)
        : '';
      const normPathForMatch = (p) => {
        const s = resolve(p).replace(/\\/g, '/').replace(/\/+$/, '');
        return process.platform === 'win32' ? s.toLowerCase() : s;
      };
      const normWs = cleanCpWs ? normPathForMatch(cleanCpWs) : '';
      let entries = readdirSync(cpDir, { withFileTypes: true })
        .filter((d) => d.isFile() && d.name.endsWith('.json'))
        .map((d) => {
          try {
            return JSON.parse(readFileSync(join(cpDir, d.name), 'utf-8'));
          } catch { return null; }
        })
        .filter(Boolean)
        .sort((a, b) => toValidMsOrZero(b.timestamp) - toValidMsOrZero(a.timestamp));
      if (normWs) {
        const normWsPrefix = normWs.endsWith('/') ? normWs : `${normWs}/`;
        entries = entries.filter((e) => {
          const rawTarget = String(e?.workspaceRoot || e?.filePath || '').trim();
          if (!rawTarget) return false;
          let target = rawTarget.replace(/\\/g, '/').replace(/\/+$/, '');
          if (process.platform === 'win32') target = target.toLowerCase();
          return target === normWs || target.startsWith(normWsPrefix);
        });
      }
      entries = entries.slice(0, safeLimit);
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
const MAX_TRACKED_CHATS = 1000;

const perChatTelemetryCache = new Map();

// Сбор сводной телеметрии экономии токенов, кэша и вызовов субагентов суммарно по всем диалогам
const BRAIN_SCAN_TTL_MS = 2_500;

let brainScanCache = { ts: 0, key: '', value: null };

function parseSingleChatDelta(filePath, st) {
  const prev = perChatTelemetryCache.get(filePath);
  if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) {
    perChatTelemetryCache.delete(filePath);
    perChatTelemetryCache.set(filePath, prev);
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
      if (obj.input_tokens !== undefined || obj.output_tokens !== undefined || obj.cache_read_tokens !== undefined) {
        const inTok = toFiniteNonNeg(obj.input_tokens, 0);
        const outTok = toFiniteNonNeg(obj.output_tokens, 0);
        const cacheTok = toFiniteNonNeg(obj.cache_read_tokens, 0);
        if (inTok > 0 || outTok > 0 || cacheTok > 0) {
          accum.steps += 1;
          accum.inputTokens += inTok;
          accum.outputTokens += outTok;
          accum.cacheReadTokens += cacheTok;
          if (inTok > 0 || cacheTok > 0) {
            accum.lastContextTokens = inTok + cacheTok;
          }
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

  if (perChatTelemetryCache.has(filePath)) {
    perChatTelemetryCache.delete(filePath);
  } else if (perChatTelemetryCache.size >= MAX_TRACKED_CHATS) {
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
  const rawThresh = Number(configuredThreshold);
  const numericThreshold = Number.isFinite(rawThresh) && rawThresh > 0 ? rawThresh : 120000;
  const skipGlobalGpu = options?.skipGlobalGpuTelemetry ? '1' : '0';
  const cacheKey = `${numericThreshold}::${normWs}::${skipGlobalGpu}`;
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
  const baseValue = collectTelemetryUncached(numericThreshold, options?.ramStats ? { ...options, ramStats: null } : options);
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
  const rawThresh = Number(configuredThreshold);
  const numericThreshold = Number.isFinite(rawThresh) && rawThresh > 0 ? rawThresh : 120000;

  let gpuSavedTokens = 0;
  if (!options?.skipGlobalGpuTelemetry) {
    try {
      const gpuTelFile = join(getPanelCacheDir(), 'gpu-telemetry.json');
      if (existsSync(gpuTelFile)) {
        const gpuTel = safeReadJsonSync(gpuTelFile, () => null, { selfHeal: false });
        gpuSavedTokens = toFiniteNonNeg(gpuTel?.savedTokensEstimate, 0);
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
          if (st.isFile() && st.size > 0 && !isSubagentTranscriptFile(tPath)) {
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
        const tpFile = getTaskProgressCachePath();
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
      let chatAccum;
      try {
        chatAccum = parseSingleChatDelta(item.path, item.st);
      } catch {
        continue;
      }
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
          stats.activeModel = activeProfile.displayRu || '';
          stats.activeModelShort = activeProfile.shortRu || activeProfile.shortEn || '';
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
            stats.thinkingBurnAdvisoryEn = burnEval?.advisoryEn || '';
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
          activeModelEn: activeProfile?.displayEn || activeProfile?.displayRu || '',
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
    const ramSotaFromOpt = extractExtraRamSotaTokens(ramStatsOpt);
    stats.ramSavedTokens =
      stats.ramCalls.slices * 900 +
      stats.ramCalls.searches * 650 +
      stats.ramCalls.contextPacks * 1400 +
      ramSotaFromOpt;
    let cpuSavedTokens = 0;
    if (!options?.skipGlobalGpuTelemetry) {
      try {
        const cpuTel = readCpuTelemetry();
        cpuSavedTokens = toFiniteNonNeg(cpuTel?.cpuSavedTokensEstimate ?? cpuTel?.totalSavedTokens, 0);
      } catch {}
    }
    stats.cpuSavedTokens = cpuSavedTokens;
    // Count only extension-driven local savings (RAM + CPU + GPU); exclude Google built-in Implicit Cache
    stats.totalSavedTokens = stats.ramSavedTokens + stats.cpuSavedTokens + stats.gpuSavedTokens;
    stats.savingsBreakdown = {
      ram: stats.ramSavedTokens,
      cpu: stats.cpuSavedTokens,
      gpu: stats.gpuSavedTokens,
    };
    stats.burnRateTokensPerStep = stats.steps > 0 ? Math.round((stats.inputTokens + stats.outputTokens) / stats.steps) : 0;
    stats.outputTokensPerStep = stats.steps > 0 ? Math.round(stats.outputTokens / stats.steps) : 0;
  } catch (err) {
    console.error('Ошибка сбора сводной телеметрии:', err);
  }

  return stats;
}

function normPanelConversationId(rawCid = '') {
  const clean = String(rawCid || '').trim().replace(/^["'\s]+|["'\s]+$/g, '');
  if (!clean) return '';
  return clean.replace(/__[0-9a-f]{8}$/i, '') || clean;
}

export async function resolveActiveWorkspaceForPanel(requestedRoot = '', options = {}) {
  const cleanReq = parseWorkspaceUriToPath(requestedRoot);
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
    const parsedPath = parseWorkspaceUriToPath(rawPath);
    if (!parsedPath || typeof parsedPath !== 'string') return null;
    const trimmed = parsedPath.trim();
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
      return { abs, isUmbrella, key: normalizeWorkspaceUriKey(abs) };
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
      } else {
        const tpPath = getTaskProgressCachePath();
        if (existsSync(tpPath)) {
          taskProgress = safeReadJsonSync(tpPath, null, { selfHeal: false });
        }
      }
    } catch {}
  }

  const runningCandidates = [];
  const recentCandidates = [];
  const chatByNormId = new Map();

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

    for (const [rawCidKey, chat] of rawChatMap.entries()) {
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
        toValidMsOrZero(chat.updatedAt),
        toValidMsOrZero(chat.lastPreToolAt),
        toValidMsOrZero(chat.lastPostToolAt),
        toValidMsOrZero(chat.completedAt)
      );
      const normCid = normPanelConversationId(chat.conversationId || rawCidKey);
      if (normCid) {
        const prev = chatByNormId.get(normCid);
        if (!prev || ts >= prev.ts) {
          chatByNormId.set(normCid, { ...cand, ts });
        }
      }
      if (chat.status === 'running') {
        runningCandidates.push({ ...cand, ts, priority: 3 });
      } else {
        recentCandidates.push({ ...cand, ts, priority: 2 });
      }
    }
  }

  const activeCid = normPanelConversationId(options?.activeConversationId || '');
  const activeChatCand = activeCid ? (chatByNormId.get(activeCid) || null) : null;

  const rawOpenWorkspaces = Array.isArray(options?.openWorkspaces)
    ? options.openWorkspaces
    : (typeof options?.openWorkspaces === 'string' && options.openWorkspaces.trim()
      ? options.openWorkspaces.split('|')
      : []);
  const openRealCandidates = [];
  const seenOpenKeys = new Set();
  for (const rawItem of rawOpenWorkspaces) {
    const cand = evaluateCandidate(rawItem);
    if (!cand || !cand.key || seenOpenKeys.has(cand.key)) continue;
    seenOpenKeys.add(cand.key);
    if (!cand.isUmbrella) {
      openRealCandidates.push(cand);
    }
  }

  // Prefer the workspace currently open in the active IDE window over background running chats
  if (openRealCandidates.length > 0) {
    if (openRealCandidates.length === 1) {
      return openRealCandidates[0].abs;
    }
    if (activeChatCand && !activeChatCand.isUmbrella && seenOpenKeys.has(activeChatCand.key)) {
      return activeChatCand.abs;
    }
    if (runningCandidates.length > 0) {
      const sortedRun = [...runningCandidates].sort((a, b) => b.ts - a.ts);
      const liveOpen = sortedRun.find((c) => !c.isUmbrella && seenOpenKeys.has(c.key));
      if (liveOpen) return liveOpen.abs;
    }
    if (recentCandidates.length > 0) {
      const sortedRec = [...recentCandidates].sort((a, b) => (b.ts - a.ts) || (b.priority - a.priority));
      const recOpen = sortedRec.find((c) => !c.isUmbrella && seenOpenKeys.has(c.key));
      if (recOpen) return recOpen.abs;
    }
    return openRealCandidates[0].abs;
  }

  // Next, honor the conversation bound to this panel window if IDE workspace URIs are empty
  if (activeChatCand && !activeChatCand.isUmbrella) {
    return activeChatCand.abs;
  }

  if (runningCandidates.length > 0) {
    runningCandidates.sort((a, b) => b.ts - a.ts);
    const liveReal = runningCandidates.find((c) => !c.isUmbrella);
    if (liveReal) return liveReal.abs;
  }

  try {
    const handoffFile = options?.handoffFile || getHandoffMirrorCachePath();
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
          const ts = toValidMsOrZero(c?.updatedAt);
          recentCandidates.push({ ...cand, ts, priority: 1 });
        }
      }
    }
  } catch {}

  for (const cpWs of cpWorkspaces) {
    const cand = evaluateCandidate(cpWs?.workspaceRoot);
    if (!cand) continue;
    const ts = toValidMsOrZero(cpWs?.lastTimestamp);
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
  const fallbackCp = evaluateCandidate(cpWorkspaces[0]?.workspaceRoot);
  if (fallbackCp) {
    return fallbackCp.abs;
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
    if (typeof patch.checkpointsCount === 'number' && Number.isFinite(patch.checkpointsCount)) {
      rec.checkpointsCount = Math.max(rec.checkpointsCount, patch.checkpointsCount);
    }
    if (typeof patch.activeCheckpointsCount === 'number' && Number.isFinite(patch.activeCheckpointsCount)) {
      rec.activeCheckpointsCount = Math.max(rec.activeCheckpointsCount, patch.activeCheckpointsCount);
    }
    if (patch.lastTimestamp) {
      const nextTs = toValidMsOrZero(patch.lastTimestamp);
      const prevTs = rec.lastTimestamp ? toValidMsOrZero(rec.lastTimestamp) : 0;
      if (nextTs > prevTs) rec.lastTimestamp = new Date(nextTs).toISOString();
    }
    if (patch.status && (patch.status === 'running' || patch.status === 'waiting_user' || rec.status === 'idle')) {
      rec.status = patch.status;
    }
    if (typeof patch.activeChatsCount === 'number' && Number.isFinite(patch.activeChatsCount) && patch.activeChatsCount > rec.activeChatsCount) {
      rec.activeChatsCount = patch.activeChatsCount;
    }
    if (typeof patch.percent === 'number' && Number.isFinite(patch.percent) && patch.percent > rec.percent) {
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
    const handoffFile = getHandoffMirrorCachePath();
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
        activeChatsCount: toFiniteNonNeg(tp.activeChatsCount, 0),
        percent: toFiniteNonNeg(tp.percent, 0),
        lastTimestamp: toValidIsoOrEmpty(tp.updatedAt),
      });
    }
  }
  if (Array.isArray(taskProgress?.activeChats)) {
    for (const c of taskProgress.activeChats) {
      if (c?.workspaceRoot) {
        upsert(c.workspaceRoot, {
          status: c.status || 'idle',
          activeChatsCount: 1,
          percent: toFiniteNonNeg(c.percent, 0),
          lastTimestamp: toValidIsoOrEmpty(c.updatedAt),
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
  const cleanActiveWs = parseWorkspaceUriToPath(activeWs);
  const cleanAutoWs = parseWorkspaceUriToPath(autoWs);
  const [known, hMod, khMod] = await Promise.all([
    collectKnownWorkspacesForPanel({ activeWs: cleanActiveWs, autoWs: cleanAutoWs, openWorkspaces, taskProgress, ramCache }),
    getSessionHandoffMod().catch(() => null),
    getKnowledgeHubMod().catch(() => null),
  ]);

  const byKey = new Map();
  const activeKey = cleanActiveWs ? normalizeWorkspaceUriKey(cleanActiveWs) : '';
  let activeParentKey = '';
  if (cleanActiveWs) {
    try {
      activeParentKey = normalizeWorkspaceUriKey(dirname(resolve(cleanActiveWs)));
    } catch {}
  }

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
        checkpointsCount: toFiniteNonNeg(seed?.checkpointsCount, 0),
        activeCheckpointsCount: toFiniteNonNeg(seed?.activeCheckpointsCount, 0),
        lastTimestamp: seed?.lastTimestamp || '',
        status: seed?.status || 'idle',
        activeChatsCount: toFiniteNonNeg(seed?.activeChatsCount, 0),
        percent: toFiniteNonNeg(seed?.percent, 0),
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

  if (cleanActiveWs) {
    upsertProject(cleanActiveWs, { source: 'known', allowEphemeral: allowActiveEphemeral });
  }
  if (cleanAutoWs) {
    upsertProject(cleanAutoWs, { source: 'known', allowEphemeral: false });
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
    if (cleanActiveWs && typeof hub?.getFederatedWorkspaces === 'function') {
      const peers = hub.getFederatedWorkspaces(cleanActiveWs);
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
  if (cleanActiveWs) parentSeeds.push(dirname(resolve(cleanActiveWs)));
  if (cleanAutoWs) parentSeeds.push(dirname(resolve(cleanAutoWs)));
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
const MAX_TRACKED_RAM_PIDS = 32;
const RAM_STATUS_GRACE_MS = 12000;
let lastActiveRamCacheSnap = { ts: 0, pids: [], data: null };
let ramCacheInFlight = null;

export async function safeGetRamCacheStatus(state = {}) {
  let ceilings = { maxRamBudgetMb: 4096, totalRamMb: 16384 };
  try {
    ceilings = getRuntimeHardwareCeilings() || ceilings;
  } catch {}
  const budgetMb = clampSafeInt(state?.ramMaxBudgetMb, 256, ceilings.maxRamBudgetMb, Math.min(4096, ceilings.maxRamBudgetMb));
  const totalRamMb = ceilings.totalRamMb;
  const enabled = state?.ramCacheEnabled !== false;
  const daemonFile = getRamDaemonCachePath();
  if (!enabled) {
    return { enabled: false, active: false, budgetMb, totalRamMb, cacheUsedMb: 0, workspaces: [], instancesCount: 0 };
  }
  if (ramCacheInFlight) {
    const shared = await ramCacheInFlight;
    return { ...shared, enabled, budgetMb, totalRamMb };
  }

  const runProbe = (async () => {
    try {
      if (!existsSync(daemonFile)) {
        lastActiveRamCacheSnap = { ts: 0, pids: [], data: null };
        return { enabled, active: false, budgetMb, totalRamMb, cacheUsedMb: 0, workspaces: [], instancesCount: 0 };
      }
      const info = safeReadJsonSync(daemonFile, null, { selfHeal: true });
      if (!info || typeof info !== 'object') {
        lastActiveRamCacheSnap = { ts: 0, pids: [], data: null };
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
        const seenLiveTrackerKeys = new Set();
        let fallbackUsedMb = 0;
        let sumHits = 0;
        let sumMisses = 0;
        let sumSearches = 0;
        let sumSlices = 0;
        let sumActiveOps = 0;
        let sumOpSeq = 0;
        let sumBurstCount = 0;
        let sumSotaSavedTokens = 0;
        let sumSotaNonSliceSavedTokens = 0;
        let hasExplicitNonSlice = false;
        let sumSotaMemoHits = 0;
        let sumSotaRepairRecalls = 0;
        let sumSotaSpecPrefetches = 0;
        let sumSotaArenaBytes = 0;
        let sumSotaCsrBytes = 0;
        let freshestLive = null;

        for (const res of liveResponses) {
          const st = res.stats || {};
          const sota = st.sota && typeof st.sota === 'object' ? st.sota : null;
          sumSotaSavedTokens += toFiniteNonNeg(st.savedTokensEstimate ?? sota?.savedTokensEstimate, 0);
          if (st.sotaNonSliceSavedTokens !== undefined || sota?.nonSliceSavedTokens !== undefined) {
            hasExplicitNonSlice = true;
            sumSotaNonSliceSavedTokens += toFiniteNonNeg(
              st.sotaNonSliceSavedTokens ?? sota?.nonSliceSavedTokens,
              0
            );
          }
          if (sota) {
            sumSotaMemoHits += toFiniteNonNeg(sota.memoHits, 0);
            sumSotaRepairRecalls += toFiniteNonNeg(sota.repairRecalls, 0);
            sumSotaSpecPrefetches += toFiniteNonNeg(sota.speculativePrefetches, 0);
            sumSotaArenaBytes += toFiniteNonNeg(sota.arenaBytes, 0);
            sumSotaCsrBytes += toFiniteNonNeg(sota.csrBytes, 0);
          }
          const numPid = Number(res.pid);
          const pidKey = Number.isFinite(numPid) && numPid > 0 ? String(numPid) : `port:${res.port || 0}`;
          seenLiveTrackerKeys.add(pidKey);
          const hits = toFiniteNonNeg(st.hits, 0);
          const slices = toFiniteNonNeg(st.slices, 0);
          const searches = toFiniteNonNeg(st.searches, 0);
          sumHits += hits;
          sumMisses += toFiniteNonNeg(st.misses, 0);
          sumSearches += searches;
          sumSlices += slices;

          const prevSnap = ramDeltaTrackerByPid.get(pidKey);
          let syntheticLive = null;
          if (prevSnap) {
            ramDeltaTrackerByPid.delete(pidKey);
            ramDeltaTrackerByPid.set(pidKey, prevSnap);
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
            if (ramDeltaTrackerByPid.size >= MAX_TRACKED_RAM_PIDS) {
              const oldestPidKey = ramDeltaTrackerByPid.keys().next().value;
              if (oldestPidKey) ramDeltaTrackerByPid.delete(oldestPidKey);
            }
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
            sumActiveOps += toFiniteNonNeg(chosenLive.activeOps, 0);
            sumOpSeq += toFiniteNonNeg(chosenLive.opSeq, 0);
            sumBurstCount += toFiniteNonNeg(chosenLive.burstCount, 0);
            if (!freshestLive || toFiniteNonNeg(chosenLive.lastActiveAt, 0) > toFiniteNonNeg(freshestLive.lastActiveAt, 0)) {
              freshestLive = chosenLive;
            }
          }

          const wsArr = Array.isArray(st.workspaces) ? st.workspaces : [];
          if (wsArr.length === 0) {
            fallbackUsedMb += toFiniteNonNeg(st.cacheUsedMb, 0);
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
        for (const trackedKey of Array.from(ramDeltaTrackerByPid.keys())) {
          if (!seenLiveTrackerKeys.has(trackedKey)) {
            const trackedPid = Number(trackedKey);
            if (!Number.isFinite(trackedPid) || trackedPid <= 0 || !isPidAlive(trackedPid)) {
              ramDeltaTrackerByPid.delete(trackedKey);
            }
          }
        }
        const summedWsMb = mergedWorkspaces.reduce((sum, w) => sum + toFiniteNonNeg(w?.cacheMb, 0), 0);
        const totalUsedMb = summedWsMb > 0 ? summedWsMb + fallbackUsedMb : toFiniteNonNeg(primary.stats.cacheUsedMb, 0);
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
              ...(hasExplicitNonSlice ? { nonSliceSavedTokens: sumSotaNonSliceSavedTokens } : {}),
              savedTokensEstimate: sumSotaSavedTokens,
            }
          : undefined;
        const resultPayload = {
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
          ...(hasExplicitNonSlice ? { sotaNonSliceSavedTokens: sumSotaNonSliceSavedTokens } : {}),
          sotaSavedTokens: sumSotaSavedTokens,
          savedTokensEstimate,
          cacheUsedMb: Number(totalUsedMb.toFixed(1)),
          liveActivity: mergedLiveActivity,
          workspaces: mergedWorkspaces,
          instancesCount: liveResponses.length,
        };
        lastActiveRamCacheSnap = {
          ts: now,
          pids: liveResponses.map((r) => Number(r.pid || 0)).filter((p) => p > 0),
          data: resultPayload,
        };
        return resultPayload;
      }
      // Keep active RAM status across transient /health timeouts while daemon PID is still alive
      if (
        lastActiveRamCacheSnap.data &&
        Date.now() - lastActiveRamCacheSnap.ts <= RAM_STATUS_GRACE_MS &&
        (lastActiveRamCacheSnap.pids.some((p) => isPidAlive(p)) || candidates.some((c) => c?.pid != null && isPidAlive(c.pid)))
      ) {
        return {
          ...lastActiveRamCacheSnap.data,
          enabled,
          budgetMb,
          totalRamMb,
        };
      }
    } catch {}
    return { enabled, active: false, budgetMb, totalRamMb, cacheUsedMb: 0, savedTokensEstimate: 0, workspaces: [], instancesCount: 0 };
  })();

  ramCacheInFlight = runProbe;
  try {
    return await runProbe;
  } finally {
    if (ramCacheInFlight === runProbe) {
      ramCacheInFlight = null;
    }
  }
}

function extractExtraRamSotaTokens(ramStats) {
  if (!ramStats || typeof ramStats !== 'object') return 0;
  if (ramStats.sotaNonSliceSavedTokens !== undefined) {
    return Math.max(0, Number(ramStats.sotaNonSliceSavedTokens) || 0);
  }
  if (ramStats.sota?.nonSliceSavedTokens !== undefined) {
    return Math.max(0, Number(ramStats.sota.nonSliceSavedTokens) || 0);
  }
  return Math.max(
    0,
    Number(
      ramStats.sotaSavedTokens !== undefined
        ? ramStats.sotaSavedTokens
        : (ramStats.savedTokensEstimate || ramStats.sota?.savedTokensEstimate || 0)
    )
  );
}

export function mergeRamSavingsIntoTelemetry(stats, ramStats) {
  if (!stats || typeof stats !== 'object' || !ramStats || typeof ramStats !== 'object') return stats;
  const extra = extractExtraRamSotaTokens(ramStats);
  if (extra <= 0) return stats;
  const nextRamSaved = Number(stats.ramSavedTokens || 0) + extra;
  const nextTotalSaved =
    nextRamSaved +
    Number(stats.cpuSavedTokens || 0) +
    Number(stats.gpuSavedTokens || 0);
  return {
    ...stats,
    ramSavedTokens: nextRamSaved,
    totalSavedTokens: nextTotalSaved,
    ...(stats.savingsBreakdown && typeof stats.savingsBreakdown === 'object'
      ? {
          savingsBreakdown: {
            ram: nextRamSaved,
            cpu: Number(stats.savingsBreakdown.cpu ?? stats.cpuSavedTokens ?? 0),
            gpu: Number(stats.savingsBreakdown.gpu ?? stats.gpuSavedTokens ?? 0),
          },
        }
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

const roiTimelineSaveTsByFile = new Map();

function formatHourBucketKey(tsMs) {
  const d = new Date(tsMs);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  return `${y}-${m}-${day}T${h}`;
}

const RU_DAYS_SHORT = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const EN_DAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const RU_MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const EN_MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function pad2Num(n) {
  return String(n).padStart(2, '0');
}

function getBucketLabelRuEn(startDate, endDate, kind) {
  if (kind === 'day') {
    const hhStart = pad2Num(startDate.getHours());
    const hhEnd = pad2Num(endDate.getHours());
    return {
      ru: hhStart,
      en: hhStart,
      periodRu: `${hhStart}:00–${hhEnd}:00`,
      periodEn: `${hhStart}:00–${hhEnd}:00`,
    };
  }
  if (kind === 'week') {
    const idx = startDate.getDay();
    const dd = pad2Num(startDate.getDate());
    const mIdx = startDate.getMonth();
    return {
      ru: `${RU_DAYS_SHORT[idx]} ${dd}`,
      en: `${EN_DAYS_SHORT[idx]} ${dd}`,
      periodRu: `${RU_DAYS_SHORT[idx]}, ${startDate.getDate()} ${RU_MONTHS_SHORT[mIdx]}`,
      periodEn: `${EN_DAYS_SHORT[idx]}, ${EN_MONTHS_SHORT[mIdx]} ${startDate.getDate()}`,
    };
  }
  const incEnd = new Date(endDate.getTime() - 1);
  const rangeLabel = `${pad2Num(startDate.getDate())}.${pad2Num(startDate.getMonth() + 1)}–${pad2Num(incEnd.getDate())}.${pad2Num(incEnd.getMonth() + 1)}`;
  return {
    ru: rangeLabel,
    en: rangeLabel,
    periodRu: `${startDate.getDate()} ${RU_MONTHS_SHORT[startDate.getMonth()]} – ${incEnd.getDate()} ${RU_MONTHS_SHORT[incEnd.getMonth()]}`,
    periodEn: `${EN_MONTHS_SHORT[startDate.getMonth()]} ${startDate.getDate()} – ${EN_MONTHS_SHORT[incEnd.getMonth()]} ${incEnd.getDate()}`,
  };
}

const ROI_TIMELINE_SCHEMA_VERSION = 3;

/**
 * Aggregates and persists hourly ROI savings snapshots (RAM / CPU / GPU only) into rolling
 * Day / 7-day / 4-week buckets and exposes honest 5h Quota Pacer bullet telemetry.
 * @param {object} [options={}]
 */
export function collectRoiTimeline(options = {}) {
  const safeOpts = options && typeof options === 'object' ? options : {};
  const rawNow = (typeof safeOpts.nowMs === 'number' || (typeof safeOpts.nowMs === 'string' && safeOpts.nowMs.trim() !== ''))
    ? Number(safeOpts.nowMs)
    : NaN;
  const nowMs = Number.isFinite(rawNow) && rawNow > 0 && rawNow <= MAX_SAFE_DATE_MS ? rawNow : Date.now();
  const curTel = safeOpts.currentTelemetry && typeof safeOpts.currentTelemetry === 'object' ? safeOpts.currentTelemetry : {};
  const bk = curTel.savingsBreakdown && typeof curTel.savingsBreakdown === 'object' ? curTel.savingsBreakdown : {};
  const curRam = Math.round(toFiniteNonNeg(bk.ram ?? curTel.ramSavedTokens, 0));
  const curCpu = Math.round(toFiniteNonNeg(bk.cpu ?? curTel.cpuSavedTokens, 0));
  const curGpu = Math.round(toFiniteNonNeg(bk.gpu ?? curTel.gpuSavedTokens, 0));

  const cacheDir = typeof safeOpts.cacheDir === 'string' && safeOpts.cacheDir.trim()
    ? resolve(safeOpts.cacheDir.trim())
    : resolveTunnelCacheDir(join(__dirname, '..', '..', '..'));
  const timelineFile = join(cacheDir, 'roi-timeline.json');

  const rawDoc = safeReadJsonSync(timelineFile, () => ({
    schemaVersion: ROI_TIMELINE_SCHEMA_VERSION,
    lastTotals: { ram: 0, cpu: 0, gpu: 0 },
    slots: [],
  }), { selfHeal: true });

  // Migrate away from pre-v3 timeline files (which included pre-extension transcripts & inflated slice baselines)
  const needsMigration = rawDoc?.schemaVersion !== ROI_TIMELINE_SCHEMA_VERSION;
  const doc = needsMigration
    ? { schemaVersion: ROI_TIMELINE_SCHEMA_VERSION, lastTotals: { ram: 0, cpu: 0, gpu: 0 }, slots: [] }
    : rawDoc;

  const prevTotals = doc?.lastTotals && typeof doc.lastTotals === 'object' ? doc.lastTotals : { ram: 0, cpu: 0, gpu: 0 };
  const rawSlots = Array.isArray(doc?.slots) ? doc.slots : [];
  const slotMap = new Map();
  const maxAgeMs = 31 * 24 * 60 * 60 * 1000;
  for (const s of rawSlots) {
    if (!s || typeof s !== 'object' || !s.hourKey) continue;
    const ts = Number(s.ts || 0);
    if (!Number.isFinite(ts) || nowMs - ts > maxAgeMs) continue;
    slotMap.set(String(s.hourKey), {
      hourKey: String(s.hourKey),
      ts,
      ram: Math.max(0, Math.round(Number(s.ram) || 0)),
      cpu: Math.max(0, Math.round(Number(s.cpu) || 0)),
      gpu: Math.max(0, Math.round(Number(s.gpu) || 0)),
    });
  }

  // Seed historical slots strictly from transcripts where extension tools actually ran (never plain pre-install chats)
  let seededFromTranscripts = false;
  if (slotMap.size === 0 && safeOpts.seedFromTranscripts !== false) {
    const geminiRoot = join(homedir(), '.gemini');
    const brainDirs = Array.isArray(safeOpts.brainDirs)
      ? safeOpts.brainDirs.filter((p) => existsSync(p))
      : ['antigravity', 'antigravity-ide', 'antigravity-cli']
          .map((dir) => join(geminiRoot, dir, 'brain'))
          .filter((p) => existsSync(p));
    const activeChats = [];
    for (const bDir of brainDirs) {
      let ents = [];
      try { ents = readdirSync(bDir, { withFileTypes: true }); } catch { continue; }
      for (const d of ents) {
        if (!d.isDirectory()) continue;
        const tp = join(bDir, d.name, '.system_generated', 'logs', 'transcript.jsonl');
        if (!existsSync(tp) || isSubagentTranscriptFile(tp)) continue;
        try {
          const st = statSync(tp);
          if (st.isFile() && st.size > 0 && nowMs - st.mtimeMs <= maxAgeMs) {
            const chatAccum = parseSingleChatDelta(tp, st);
            const rc = chatAccum.ramCalls || { slices: 0, searches: 0, contextPacks: 0, total: 0 };
            if ((rc.total || 0) > 0) {
              const rawChatRam = (rc.slices || 0) * 900 + (rc.searches || 0) * 650 + (rc.contextPacks || 0) * 1400;
              activeChats.push({
                ts: st.mtimeMs,
                rawChatRam,
                weightSteps: Math.max(1, chatAccum.steps || 1),
              });
            }
          }
        } catch {}
      }
    }
    if (activeChats.length > 0 && (curRam + curCpu + curGpu) > 0) {
      seededFromTranscripts = true;
      activeChats.sort((a, b) => a.ts - b.ts);
      const totalRawRam = activeChats.reduce((acc, c) => acc + c.rawChatRam, 0);
      const totalSteps = activeChats.reduce((acc, c) => acc + c.weightSteps, 0);
      let remRam = curRam;
      let remCpu = curCpu;
      let remGpu = curGpu;
      for (let idx = 0; idx < activeChats.length; idx++) {
        const ac = activeChats[idx];
        const isLast = idx === activeChats.length - 1;
        const ramShare = totalRawRam > 0 ? (ac.rawChatRam / totalRawRam) : (ac.weightSteps / totalSteps);
        const stepShare = ac.weightSteps / totalSteps;
        const addRam = isLast ? remRam : Math.min(remRam, Math.round(curRam * ramShare));
        const addCpu = isLast ? remCpu : Math.min(remCpu, Math.round(curCpu * stepShare));
        const addGpu = isLast ? remGpu : Math.min(remGpu, Math.round(curGpu * stepShare));
        remRam -= addRam;
        remCpu -= addCpu;
        remGpu -= addGpu;
        const hk = formatHourBucketKey(ac.ts);
        const existing = slotMap.get(hk) || { hourKey: hk, ts: ac.ts, ram: 0, cpu: 0, gpu: 0 };
        existing.ts = Math.max(existing.ts, ac.ts);
        existing.ram += addRam;
        existing.cpu += addCpu;
        existing.gpu += addGpu;
        slotMap.set(hk, existing);
      }
    }
  }

  // High-water-mark deltas with self-healing against poisoned legacy baselines (>100k above live totals)
  let slotSumRam = 0;
  let slotSumCpu = 0;
  let slotSumGpu = 0;
  for (const sl of slotMap.values()) {
    slotSumRam += Number(sl?.ram || 0);
    slotSumCpu += Number(sl?.cpu || 0);
    slotSumGpu += Number(sl?.gpu || 0);
  }
  const rawPrevRam = toFiniteNonNeg(prevTotals.ram, 0);
  const rawPrevCpu = toFiniteNonNeg(prevTotals.cpu, 0);
  const rawPrevGpu = toFiniteNonNeg(prevTotals.gpu, 0);
  const prevRam = rawPrevRam > Math.max(curRam, slotSumRam) * 1.5 + 100_000 ? curRam : rawPrevRam;
  const prevCpu = rawPrevCpu > Math.max(curCpu, slotSumCpu) * 1.5 + 100_000 ? curCpu : rawPrevCpu;
  const prevGpu = rawPrevGpu > Math.max(curGpu, slotSumGpu) * 1.5 + 100_000 ? curGpu : rawPrevGpu;
  const dRam = curRam > prevRam ? (curRam - prevRam) : 0;
  const dCpu = curCpu > prevCpu ? (curCpu - prevCpu) : 0;
  const dGpu = curGpu > prevGpu ? (curGpu - prevGpu) : 0;
  const nextTotals = {
    ram: Math.max(prevRam, curRam),
    cpu: Math.max(prevCpu, curCpu),
    gpu: Math.max(prevGpu, curGpu),
  };

  const curHourKey = formatHourBucketKey(nowMs);
  const activeSlot = slotMap.get(curHourKey) || { hourKey: curHourKey, ts: nowMs, ram: 0, cpu: 0, gpu: 0 };
  if (!seededFromTranscripts) {
    if (slotMap.size === 0 && (curRam + curCpu + curGpu) > 0) {
      activeSlot.ram += curRam;
      activeSlot.cpu += curCpu;
      activeSlot.gpu += curGpu;
    } else if (dRam + dCpu + dGpu > 0) {
      activeSlot.ram += dRam;
      activeSlot.cpu += dCpu;
      activeSlot.gpu += dGpu;
    }
  }
  activeSlot.ts = nowMs;
  slotMap.set(curHourKey, activeSlot);

  const sortedSlots = Array.from(slotMap.values()).sort((a, b) => a.ts - b.ts).slice(-720);
  const prevSaveTs = roiTimelineSaveTsByFile.get(timelineFile) ?? -Infinity;
  if (safeOpts.persist !== false && (needsMigration || !existsSync(timelineFile) || Math.abs(nowMs - prevSaveTs) >= 60_000)) {
    try {
      if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
      updateJsonAtomicSync(
        timelineFile,
        () => ({
          schemaVersion: ROI_TIMELINE_SCHEMA_VERSION,
          lastTotals: { ram: 0, cpu: 0, gpu: 0 },
          slots: [],
        }),
        (diskDoc) => {
          if (needsMigration || diskDoc?.schemaVersion !== ROI_TIMELINE_SCHEMA_VERSION) {
            return {
              schemaVersion: ROI_TIMELINE_SCHEMA_VERSION,
              updatedAt: new Date(nowMs).toISOString(),
              lastTotals: nextTotals,
              slots: sortedSlots,
            };
          }
          const mergedMap = new Map();
          const diskSlots = Array.isArray(diskDoc?.slots) ? diskDoc.slots : [];
          for (const ds of diskSlots) {
            if (!ds || typeof ds !== 'object' || !ds.hourKey) continue;
            const dts = Number(ds.ts || 0);
            if (!Number.isFinite(dts) || nowMs - dts > maxAgeMs) continue;
            mergedMap.set(String(ds.hourKey), {
              hourKey: String(ds.hourKey),
              ts: dts,
              ram: Math.round(toFiniteNonNeg(ds.ram, 0)),
              cpu: Math.round(toFiniteNonNeg(ds.cpu, 0)),
              gpu: Math.round(toFiniteNonNeg(ds.gpu, 0)),
            });
          }
          for (const ms of sortedSlots) {
            const prev = mergedMap.get(ms.hourKey);
            if (!prev) {
              mergedMap.set(ms.hourKey, { ...ms });
            } else {
              mergedMap.set(ms.hourKey, {
                hourKey: ms.hourKey,
                ts: Math.max(prev.ts, ms.ts),
                ram: Math.max(prev.ram, ms.ram),
                cpu: Math.max(prev.cpu, ms.cpu),
                gpu: Math.max(prev.gpu, ms.gpu),
              });
            }
          }
          let mergedSumRam = 0;
          let mergedSumCpu = 0;
          let mergedSumGpu = 0;
          for (const ms of mergedMap.values()) {
            mergedSumRam += Number(ms?.ram || 0);
            mergedSumCpu += Number(ms?.cpu || 0);
            mergedSumGpu += Number(ms?.gpu || 0);
          }
          const diskTotals = diskDoc?.lastTotals && typeof diskDoc.lastTotals === 'object' ? diskDoc.lastTotals : {};
          const dPrevRam = toFiniteNonNeg(diskTotals.ram, 0);
          const dPrevCpu = toFiniteNonNeg(diskTotals.cpu, 0);
          const dPrevGpu = toFiniteNonNeg(diskTotals.gpu, 0);
          const safeDiskRam = dPrevRam > Math.max(curRam, mergedSumRam) * 1.5 + 100_000 ? curRam : dPrevRam;
          const safeDiskCpu = dPrevCpu > Math.max(curCpu, mergedSumCpu) * 1.5 + 100_000 ? curCpu : dPrevCpu;
          const safeDiskGpu = dPrevGpu > Math.max(curGpu, mergedSumGpu) * 1.5 + 100_000 ? curGpu : dPrevGpu;
          return {
            schemaVersion: ROI_TIMELINE_SCHEMA_VERSION,
            updatedAt: new Date(nowMs).toISOString(),
            lastTotals: {
              ram: Math.max(safeDiskRam, nextTotals.ram),
              cpu: Math.max(safeDiskCpu, nextTotals.cpu),
              gpu: Math.max(safeDiskGpu, nextTotals.gpu),
            },
            slots: Array.from(mergedMap.values()).sort((a, b) => a.ts - b.ts).slice(-720),
          };
        }
      );
      if (roiTimelineSaveTsByFile.size >= 32 && !roiTimelineSaveTsByFile.has(timelineFile)) {
        const oldest = roiTimelineSaveTsByFile.keys().next().value;
        if (oldest) roiTimelineSaveTsByFile.delete(oldest);
      }
      roiTimelineSaveTsByFile.set(timelineFile, nowMs);
    } catch {}
  }

  let firstActiveAtMs = null;
  for (const s of sortedSlots) {
    if ((s.ram + s.cpu + s.gpu) > 0 && (firstActiveAtMs === null || s.ts < firstActiveAtMs)) {
      firstActiveAtMs = s.ts;
    }
  }

  // Build 8 x 3h buckets (24h rolling Day)
  const dayBuckets = [];
  const threeHoursMs = 3 * 60 * 60 * 1000;
  const alignedEnd = Math.floor(nowMs / threeHoursMs) * threeHoursMs + threeHoursMs;
  for (let i = 7; i >= 0; i--) {
    const start = alignedEnd - (i + 1) * threeHoursMs;
    const end = alignedEnd - i * threeHoursMs;
    const lbl = getBucketLabelRuEn(new Date(start), new Date(end), 'day');
    dayBuckets.push({ labelRu: lbl.ru, labelEn: lbl.en, periodLabelRu: lbl.periodRu, periodLabelEn: lbl.periodEn, start, end, ram: 0, cpu: 0, gpu: 0 });
  }

  // Build 7 daily buckets (Week)
  const weekBuckets = [];
  const oneDayMs = 24 * 60 * 60 * 1000;
  const todayStart = new Date(nowMs);
  todayStart.setHours(0, 0, 0, 0);
  const todayMs = todayStart.getTime();
  for (let i = 6; i >= 0; i--) {
    const start = todayMs - i * oneDayMs;
    const end = start + oneDayMs;
    const lbl = getBucketLabelRuEn(new Date(start), new Date(end), 'week');
    weekBuckets.push({ labelRu: lbl.ru, labelEn: lbl.en, periodLabelRu: lbl.periodRu, periodLabelEn: lbl.periodEn, start, end, ram: 0, cpu: 0, gpu: 0 });
  }

  // Build 4 weekly buckets (28d rolling with calendar date ranges)
  const monthBuckets = [];
  const oneWeekMs = 7 * oneDayMs;
  const weekEnd = todayMs + oneDayMs;
  for (let i = 3; i >= 0; i--) {
    const start = weekEnd - (i + 1) * oneWeekMs;
    const end = weekEnd - i * oneWeekMs;
    const lbl = getBucketLabelRuEn(new Date(start), new Date(end), 'month');
    monthBuckets.push({ labelRu: lbl.ru, labelEn: lbl.en, periodLabelRu: lbl.periodRu, periodLabelEn: lbl.periodEn, start, end, ram: 0, cpu: 0, gpu: 0 });
  }

  const addIntoBuckets = (buckets, slot) => {
    for (const b of buckets) {
      if (slot.ts >= b.start && slot.ts < b.end) {
        b.ram += slot.ram;
        b.cpu += slot.cpu;
        b.gpu += slot.gpu;
        break;
      }
    }
  };
  for (const s of sortedSlots) {
    addIntoBuckets(dayBuckets, s);
    addIntoBuckets(weekBuckets, s);
    addIntoBuckets(monthBuckets, s);
  }

  const cleanBuckets = (arr) => arr.map((b) => {
    const total = b.ram + b.cpu + b.gpu;
    return {
      labelRu: b.labelRu,
      labelEn: b.labelEn,
      periodLabelRu: b.periodLabelRu,
      periodLabelEn: b.periodLabelEn,
      beforeInstall: Boolean(firstActiveAtMs && b.end <= firstActiveAtMs && total === 0),
      ram: b.ram,
      cpu: b.cpu,
      gpu: b.gpu,
      total,
    };
  });

  const qp = safeOpts.quotaPacer && typeof safeOpts.quotaPacer === 'object' ? safeOpts.quotaPacer : {};
  const utilizationPct = Math.min(100, Math.round(toFiniteNonNeg(qp.utilizationPct, 0)));
  const rawProj = qp.projectedPct !== null && qp.projectedPct !== undefined && qp.projectedPct !== ''
    ? Number(qp.projectedPct)
    : NaN;
  const projectedPct = Number.isFinite(rawProj)
    ? Math.max(utilizationPct, Math.min(100, Math.round(rawProj)))
    : utilizationPct;

  return {
    ok: true,
    schemaVersion: ROI_TIMELINE_SCHEMA_VERSION,
    generatedAt: new Date(nowMs).toISOString(),
    firstActiveAt: firstActiveAtMs ? new Date(firstActiveAtMs).toISOString() : null,
    totals: {
      ram: curRam,
      cpu: curCpu,
      gpu: curGpu,
      total: curRam + curCpu + curGpu,
    },
    scales: {
      day: cleanBuckets(dayBuckets),
      week: cleanBuckets(weekBuckets),
      month: cleanBuckets(monthBuckets),
    },
    quotaBullet: {
      utilizationPct,
      projectedPct,
      status: qp.status || 'calm',
      estimatedMinutesLeft: (qp.estimatedMinutesLeft !== null && qp.estimatedMinutesLeft !== undefined && qp.estimatedMinutesLeft !== '' && Number.isFinite(Number(qp.estimatedMinutesLeft))) ? Number(qp.estimatedMinutesLeft) : 300,
      turnsLast60m: toFiniteNonNeg(qp.turnsLast60m, 0),
      turnsLast5h: toFiniteNonNeg(qp.turnsLast5h ?? qp.turnsLast60m, 0),
      windowHours: toFiniteNonNeg(qp.windowHours, 5) || 5,
      window5hCeiling: toFiniteNonNeg(qp.window5hCeiling, 0),
      subscriptionTier: qp.subscriptionTier || '',
    },
  };
}

const GUARD_PULSE_FAST_TTL_MS = 6000;
const GUARD_PULSE_SHIELD_TTL_MS = 60000;
const GUARD_PULSE_ENV_TTL_MS = 45000;
const _guardPulseCache = new Map();
const _guardPulseEpochs = new Map();
const _guardPulseGlobalEpochs = { fast: 0, shield: 0, env: 0 };

function getGuardEpochsForKey(key) {
  const local = _guardPulseEpochs.get(key);
  return {
    fast: _guardPulseGlobalEpochs.fast + (local?.fast || 0),
    shield: _guardPulseGlobalEpochs.shield + (local?.shield || 0),
    env: _guardPulseGlobalEpochs.env + (local?.env || 0),
  };
}

function normGuardWsKey(wsRoot = '') {
  const clean = String(wsRoot || '').trim();
  if (!clean) return '__default__';
  return process.platform === 'win32' ? resolve(clean).toLowerCase() : resolve(clean);
}

export function invalidateGuardPulseCache(wsRoot = '', buckets = null) {
  const targetBuckets = Array.isArray(buckets) && buckets.length > 0 ? buckets : ['fast', 'shield', 'env'];
  if (!wsRoot) {
    for (const b of targetBuckets) {
      if (b === 'fast' || b === 'shield' || b === 'env') {
        _guardPulseGlobalEpochs[b] += 1;
      }
    }
    if (!Array.isArray(buckets) || buckets.length === 0) {
      _guardPulseCache.clear();
      return;
    }
    for (const entry of _guardPulseCache.values()) {
      for (const b of buckets) {
        if (b === 'shield') entry.shieldTs = 0;
        else if (b === 'env') entry.envTs = 0;
        else if (b === 'fast') entry.fastTs = 0;
      }
    }
    return;
  }
  const key = normGuardWsKey(wsRoot);
  if (_guardPulseEpochs.has(key)) {
    const existingEpoch = _guardPulseEpochs.get(key);
    _guardPulseEpochs.delete(key);
    _guardPulseEpochs.set(key, existingEpoch);
  } else if (_guardPulseEpochs.size >= 32) {
    const oldestKey = _guardPulseEpochs.keys().next().value;
    if (oldestKey) _guardPulseEpochs.delete(oldestKey);
  }
  const epochRec = _guardPulseEpochs.get(key) || { fast: 0, shield: 0, env: 0 };
  for (const b of targetBuckets) {
    if (b === 'fast' || b === 'shield' || b === 'env') {
      epochRec[b] += 1;
    }
  }
  _guardPulseEpochs.set(key, epochRec);

  const entry = _guardPulseCache.get(key);
  if (!entry) return;
  if (!Array.isArray(buckets) || buckets.length === 0) {
    _guardPulseCache.delete(key);
    return;
  }
  for (const b of buckets) {
    if (b === 'shield') entry.shieldTs = 0;
    else if (b === 'env') entry.envTs = 0;
    else if (b === 'fast') entry.fastTs = 0;
  }
}

export function primeGuardPulseShieldCache(wsRoot = '', shieldReport = null) {
  if (!shieldReport || typeof shieldReport !== 'object') return;
  const key = normGuardWsKey(wsRoot);
  const entry = _guardPulseCache.get(key) || { shieldTs: 0, shield: null, envTs: 0, env: null, fastTs: 0, fast: null };
  entry.shield = shieldReport;
  entry.shieldTs = Date.now();
  _guardPulseCache.delete(key);
  _guardPulseCache.set(key, entry);
}

/**
 * Lightweight cached summary for the Guard Dock (Lite Variant B + Full Variant C).
 * Keeps hot polling under ~2ms while surfacing Bugs, Shield, Instincts, Risks, and Env counts.
 */
export async function safeGetGuardPulse(workspaceRoot = '', state = {}, options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const parsedWs = parseWorkspaceUriToPath(workspaceRoot);
  const activeWs = parsedWs && isValidWorkspaceDir(parsedWs) ? resolve(parsedWs) : process.cwd();
  const key = normGuardWsKey(activeWs);
  const now = Date.now();
  const lang = state?.uiLanguage === 'en' ? 'en' : 'ru';
  const forceAll = Boolean(opts.force);
  const forceShield = forceAll || Boolean(opts.forceShield);
  const forceEnv = forceAll || Boolean(opts.forceEnv);
  const forceFast = forceAll || Boolean(opts.forceFast);
  const startEpochs = getGuardEpochsForKey(key);

  if (_guardPulseCache.size > 12 && !_guardPulseCache.has(key)) {
    const oldestKey = _guardPulseCache.keys().next().value;
    if (oldestKey) _guardPulseCache.delete(oldestKey);
  }
  const existingEntry = _guardPulseCache.get(key);
  const entry = existingEntry
    ? { ...existingEntry }
    : { shieldTs: 0, shield: null, envTs: 0, env: null, fastTs: 0, fast: null };

  // 1. Bugs (Sentinel + Wiretap — always computed live from already-fetched snapshots, 0ms)
  const sen = opts.sentinel && typeof opts.sentinel === 'object' ? opts.sentinel : {};
  const sg = sen.shadowGuard && typeof sen.shadowGuard === 'object' ? sen.shadowGuard : {};
  const bb = sen.bugBot && typeof sen.bugBot === 'object' ? sen.bugBot : {};
  const sgErrs = toFiniteNonNeg(sg.errorCount, 0);
  const sgWarns = Math.max(toFiniteNonNeg(sg.warnCount, 0), toFiniteNonNeg(sg.cloneCount, 0));
  const bbCount = Math.max(toFiniteNonNeg(bb.findingsCount, 0), Array.isArray(bb.findings) ? bb.findings.length : 0);
  const wiretapArr = Array.isArray(opts.wiretapFaults) ? opts.wiretapFaults : [];
  const wiretapCount = wiretapArr.length;
  const bugsTotal = sgErrs + sgWarns + bbCount + wiretapCount;
  const bugsSeverity = (sgErrs > 0 || bbCount > 0 || wiretapCount > 0)
    ? 'err'
    : (bugsTotal > 0 ? 'warn' : 'ok');

  // 2. Fast local state (Instincts + Circuit Breaker + Pitfalls + Fragile files)
  let fastData = entry.fast;
  let fastUpdated = false;
  const hasExplicitFastPreload = opts.circuitBreaker !== undefined || opts.pitfalls !== undefined || opts.bayesian !== undefined;
  if (!fastData || forceFast || hasExplicitFastPreload || (now - entry.fastTs > GUARD_PULSE_FAST_TTL_MS)) {
    const [cbRaw, pitfallsRaw, bayesianRaw, instinctsRaw] = await Promise.all([
      opts.circuitBreaker !== undefined ? Promise.resolve(opts.circuitBreaker) : safeGetCircuitState(activeWs),
      opts.pitfalls !== undefined ? Promise.resolve(opts.pitfalls) : safeListPitfalls(10, activeWs),
      opts.bayesian !== undefined ? Promise.resolve(opts.bayesian) : safeGetBayesianSummary(activeWs),
      (async () => {
        try {
          if (state?.sqliteKnowledgeEnabled === false) return [];
          const mod = await getKnowledgeHubMod();
          const hub = mod?.knowledgeHub;
          if (!hub || typeof hub.listInstincts !== 'function') return [];
          const listed = hub.listInstincts({ workspaceRoot: activeWs, includePromoted: false, minConfidence: 0.1, limit: 30 });
          return Array.isArray(listed?.items) ? listed.items : [];
        } catch {
          return [];
        }
      })(),
    ]);

    const cb = cbRaw && typeof cbRaw === 'object' ? cbRaw : { status: 'CLOSED', repeatCount: 0, reason: '' };
    const cbStatus = String(cb.status || 'CLOSED').toUpperCase();
    const pitfalls = Array.isArray(pitfallsRaw) ? pitfallsRaw : [];
    const fragileAll = Array.isArray(bayesianRaw?.fragileFiles) ? bayesianRaw.fragileFiles : [];
    const fragile = fragileAll.filter((f) => f && toFiniteNonNeg(f.reliabilityPercent, 100) < 80);
    const instincts = Array.isArray(instinctsRaw) ? instinctsRaw : [];
    const readyInstincts = instincts.filter((it) => it && !it.promotedSkill && it.readyForPromotion);

    fastData = {
      instincts: {
        total: instincts.length,
        readyCount: readyInstincts.length,
        count: readyInstincts.length,
        severity: readyInstincts.length > 0 ? 'info' : 'ok',
        items: instincts.slice(0, 8).map((it) => ({
          id: String(it.id || ''),
          pattern: String(it.pattern || ''),
          confidencePct: Math.round(toFiniteNonNeg(it.effectiveConfidence ?? it.confidence, 0) * 100),
          evidenceCount: toFiniteNonNeg(it.evidenceCount, 1) || 1,
          readyForPromotion: Boolean(it.readyForPromotion && !it.promotedSkill),
        })),
      },
      risks: {
        cbStatus,
        cbRepeats: toFiniteNonNeg(cb.repeatCount, 0),
        cbReason: String(cb.reason || ''),
        pitfallsCount: pitfalls.length,
        fragileCount: fragile.length,
        count: (cbStatus !== 'CLOSED' ? 1 : 0) + pitfalls.length + fragile.length,
        severity: (cbStatus === 'TRIPPED' || cbStatus === 'OPEN') ? 'err' : ((cbStatus === 'WARNING' || pitfalls.length > 0 || fragile.length > 0) ? 'warn' : 'ok'),
        pitfalls: pitfalls.slice(0, 5).map((p) => ({
          id: String(p?.id || ''),
          file: String(p?.file || p?.fileName || p?.target || ''),
          lesson: String(p?.lesson || p?.rule || p?.summary || p?.error || ''),
          category: String(p?.category || p?.type || p?.kind || 'pitfall'),
        })),
        fragileFiles: fragile.slice(0, 5).map((f) => ({
          file: String(f.file || f.path || ''),
          reliabilityPercent: toFiniteNonNeg(f.reliabilityPercent, 100),
          failures: toFiniteNonNeg(f.failures, 0),
          runs: toFiniteNonNeg(f.runs, 0),
        })),
      },
    };
    if (!hasExplicitFastPreload && getGuardEpochsForKey(key).fast === startEpochs.fast) {
      entry.fast = fastData;
      entry.fastTs = now;
      fastUpdated = true;
    }
  }

  // 3. AgentShield (offline config/secret/prompt-injection audit, cached 60s)
  let shieldRaw = entry.shield;
  let shieldUpdated = false;
  if (!shieldRaw || forceShield || (now - entry.shieldTs > GUARD_PULSE_SHIELD_TTL_MS)) {
    try {
      const { auditAgentEnvironment } = await import('../../../core/agent-shield.mjs');
      const includeGlobal = process.env.TUNNEL_TEST_ISOLATE_INSTALLED !== '1';
      shieldRaw = auditAgentEnvironment({ workspaceRoot: activeWs, includeGlobal, lang });
      if (getGuardEpochsForKey(key).shield === startEpochs.shield) {
        entry.shield = shieldRaw;
        entry.shieldTs = now;
        shieldUpdated = true;
      }
    } catch (err) {
      shieldRaw = entry.shield || {
        ok: false,
        error: err?.message || 'AgentShield audit failed',
        score: 0,
        grade: '?',
        findings: [],
      };
    }
  }
  const shieldFindings = Array.isArray(shieldRaw?.findings) ? shieldRaw.findings : [];
  const shieldCritHigh = shieldFindings.filter((f) => f && (f.severity === 'critical' || f.severity === 'high')).length;
  const shieldChecked = Boolean(shieldRaw && shieldRaw.ok !== false);
  const shieldBucket = {
    checked: shieldChecked,
    score: shieldChecked && Number.isFinite(Number(shieldRaw?.score)) ? Number(shieldRaw.score) : 0,
    grade: shieldChecked ? String(shieldRaw?.grade || 'A') : String(shieldRaw?.grade || '?'),
    count: shieldFindings.length,
    criticalHighCount: shieldCritHigh,
    severity: !shieldChecked ? 'warn' : (shieldCritHigh > 0 ? 'err' : (shieldFindings.length > 0 ? 'warn' : 'ok')),
    ...(shieldRaw?.error ? { error: String(shieldRaw.error) } : {}),
    findings: shieldFindings.slice(0, 8).map((f) => ({
      file: String(f.file || ''),
      severity: String(f.severity || 'low'),
      ruleId: String(f.ruleId || ''),
      message: String(f.message || ''),
    })),
  };

  // 4. Environment & Discipline (Health-Doctor + GATES.md + Shortcut Tech Debt, cached 45s + instant GATES.md mtime check)
  const gatesPath = join(activeWs, 'GATES.md');
  let gatesSig = 'missing';
  try {
    if (existsSync(gatesPath)) {
      const st = statSync(gatesPath);
      gatesSig = `${Number(st.size || 0)}:${Math.trunc(Number(st.mtimeMs || 0))}`;
    }
  } catch {
    gatesSig = 'missing';
  }
  const gatesChanged = entry.envGatesSig !== undefined && entry.envGatesSig !== gatesSig;

  let envBucket = entry.env;
  let envUpdated = false;
  if (!envBucket || forceEnv || gatesChanged || (now - entry.envTs > GUARD_PULSE_ENV_TTL_MS)) {
    try {
      const [{ diagnoseRuntimeHealth }, { parseAcceptanceGatesMarkdown }, { scanShortcutDebt }, resolvedRuntime] = await Promise.all([
        import('../../../core/health-doctor.mjs'),
        import('../../../core/completion-gates.mjs'),
        import('../../../core/shortcut-debt-ledger.mjs'),
        Promise.all([
          opts.gpu !== undefined ? Promise.resolve(opts.gpu) : safeGetGpuStatus(),
          opts.ramCache !== undefined ? Promise.resolve(opts.ramCache) : safeGetRamCacheStatus(state),
          opts.shadowWorktrees !== undefined
            ? Promise.resolve(Array.isArray(opts.shadowWorktrees) ? opts.shadowWorktrees : [])
            : (state?.shadowWorktreeEnabled !== false ? safeListShadowWorktrees(activeWs) : Promise.resolve([])),
        ]),
      ]);
      const [gpuStatus, ramStatus, worktrees] = resolvedRuntime;
      const docRes = diagnoseRuntimeHealth({
        workspaceRoot: activeWs,
        state,
        gpuStatus,
        ramStatus,
        worktrees,
      });
      const docIssues = Array.isArray(docRes?.issues) ? docRes.issues : [];

      let gatesExists = false;
      let gatesTotal = 0;
      let gatesUnmetCount = 0;
      let gatesItems = [];
      if (existsSync(gatesPath)) {
        gatesExists = true;
        try {
          const parsed = parseAcceptanceGatesMarkdown(readFileSync(gatesPath, 'utf8'));
          gatesTotal = toFiniteNonNeg(parsed?.total, 0);
          gatesUnmetCount = Array.isArray(parsed?.unmet) ? parsed.unmet.length : 0;
          gatesItems = (Array.isArray(parsed?.unmet) ? parsed.unmet : []).slice(0, 5).map((g) => ({
            text: String(g?.text || g?.title || g || ''),
          }));
        } catch {}
      }

      let debtTotal = 0;
      let debtNoTriggerCount = 0;
      let debtItems = [];
      try {
        const debtRes = scanShortcutDebt(activeWs, { maxFiles: 120, lang });
        debtTotal = toFiniteNonNeg(debtRes?.totalMarkers, 0);
        debtNoTriggerCount = toFiniteNonNeg(debtRes?.noTriggerCount, 0);
        const rawMarkers = Array.isArray(debtRes?.items)
          ? debtRes.items
          : (Array.isArray(debtRes?.markers) ? debtRes.markers : []);
        debtItems = rawMarkers.slice(0, 5).map((m) => ({
          file: String(m.file || ''),
          line: toFiniteNonNeg(m.line, 0),
          ceiling: String(m.ceiling || m.raw || ''),
          rotRisk: Boolean(m.rotRisk),
        }));
      } catch {}

      const envTotal = docIssues.length + gatesUnmetCount + debtNoTriggerCount;
      const hasHighDoc = docIssues.some((i) => i && i.severity === 'high');
      envBucket = {
        count: envTotal,
        severity: hasHighDoc ? 'err' : (envTotal > 0 ? 'warn' : 'ok'),
        doctorCount: docIssues.length,
        doctorScore: Number.isFinite(Number(docRes?.score)) ? Number(docRes.score) : 100,
        doctorIssues: docIssues.slice(0, 6).map((i) => ({
          id: String(i.id || ''),
          severity: String(i.severity || 'warn'),
          titleRu: String(i.titleRu || i.title || ''),
          titleEn: String(i.titleEn || i.title || ''),
          detailRu: String(i.detailRu || ''),
          detailEn: String(i.detailEn || ''),
          fixAction: String(i.fixAction || ''),
          canAutoFix: Boolean(i.canAutoFix),
        })),
        gatesExists,
        gatesTotal,
        gatesUnmetCount,
        gatesItems,
        debtTotal,
        debtNoTriggerCount,
        debtItems,
      };
      if (getGuardEpochsForKey(key).env === startEpochs.env) {
        entry.env = envBucket;
        entry.envTs = now;
        entry.envGatesSig = gatesSig;
        envUpdated = true;
      }
    } catch (err) {
      envBucket = entry.env || {
        count: 0,
        severity: 'warn',
        doctorCount: 0,
        doctorScore: 0,
        doctorError: true,
        error: String(err?.message || 'Health check failed'),
        doctorIssues: [],
        gatesExists: false,
        gatesTotal: 0,
        gatesUnmetCount: 0,
        gatesItems: [],
        debtTotal: 0,
        debtNoTriggerCount: 0,
        debtItems: [],
      };
    }
  }

  const latestCached = _guardPulseCache.get(key);
  const currentEpochs = getGuardEpochsForKey(key);
  const mergedEntry = {
    fast: (fastUpdated && currentEpochs.fast === startEpochs.fast) ? entry.fast : (latestCached?.fast ?? null),
    fastTs: (fastUpdated && currentEpochs.fast === startEpochs.fast) ? entry.fastTs : (latestCached?.fastTs ?? 0),
    shield: (shieldUpdated && currentEpochs.shield === startEpochs.shield) ? entry.shield : (latestCached?.shield ?? null),
    shieldTs: (shieldUpdated && currentEpochs.shield === startEpochs.shield) ? entry.shieldTs : (latestCached?.shieldTs ?? 0),
    env: (envUpdated && currentEpochs.env === startEpochs.env) ? entry.env : (latestCached?.env ?? null),
    envTs: (envUpdated && currentEpochs.env === startEpochs.env) ? entry.envTs : (latestCached?.envTs ?? 0),
    envGatesSig: (envUpdated && currentEpochs.env === startEpochs.env) ? entry.envGatesSig : latestCached?.envGatesSig,
  };
  if (mergedEntry.fast || mergedEntry.shield || mergedEntry.env) {
    _guardPulseCache.delete(key);
    _guardPulseCache.set(key, mergedEntry);
  }

  return {
    ok: true,
    workspaceRoot: activeWs,
    updatedAt: now,
    bugs: {
      count: bugsTotal,
      severity: bugsSeverity,
      sentinelErrors: sgErrs,
      sentinelWarnings: sgWarns,
      bugBotCount: bbCount,
      wiretapCount,
    },
    shield: shieldBucket,
    instincts: fastData.instincts,
    risks: fastData.risks,
    env: envBucket,
  };
}


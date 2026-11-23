/**
 * @file gpu-shared-state.mjs
 * @description Shared GPU config, runtime caches/state bag, preemption, live telemetry, and Ollama HTTP client.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path, { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeMaxVramCapMb, probeAnyGpu } from '../hardware-profiler.mjs';
import { safeReadJsonSync, updateJsonAtomicSync } from '../safe-json.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const PLUGIN_ROOT = join(__dirname, '..', '..');

export const CACHE_DIR = join(PLUGIN_ROOT, '.cache');

const STATE_FILE = join(PLUGIN_ROOT, 'router-state.json');

const GPU_TELEMETRY_FILE = join(CACHE_DIR, 'gpu-telemetry.json');

const GPU_LIVE_ACTIVITY_FILE = join(CACHE_DIR, 'gpu-live-activity.json');

export const GPU_PULL_STATUS_FILE = join(CACHE_DIR, 'gpu-pull-status.json');

export const GPU_DISTILL_CACHE_FILE = join(CACHE_DIR, 'gpu-distill-cache.json');

export const DEFAULT_GPU_CONFIG = {
  gpuEnabled: false,
  gpuEndpoint: 'http://127.0.0.1:11434',
  gpuMaxVramMb: 12288,
  gpuChatModel: 'gemma4:12b',
  gpuEmbedModel: 'qwen3-embedding:0.6b',
  gpuEmbedDim: 512,
  gpuKeepAlive: '15m',
  gpuEmbedKeepAlive: '90m',
  gpuContextTokens: 12288,
  gpuModelsDir: '',
  gpuAutoStart: true,
  gpuAutoDistillLogs: true,
  gpuSemanticSearch: true,
  gpuShowPreTaskAdvice: true,
  gpuUnloadOnExit: true,
  gpuPostEditCritic: true,
  gpuWarmHostRamCache: true,
};

export function resolveDefaultGpuModelsDir(configuredDir = '') {
  const configured = String(configuredDir || '').trim();
  const isAccessiblePath = (p) => {
    if (!p) return false;
    if (process.platform === 'win32') {
      const m = /^([A-Za-z]):[\\/]/.exec(p);
      if (m && !existsSync(`${m[1]}:\\`)) return false;
    }
    return true;
  };
  if (configured && isAccessiblePath(configured)) {
    return configured;
  }
  const envDir = String(process.env.OLLAMA_MODELS || '').trim();
  if (envDir && isAccessiblePath(envDir)) {
    return envDir;
  }
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const candidates = [];
  if (home) candidates.push(join(home, '.ollama', 'models'));
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    candidates.push(join(process.env.LOCALAPPDATA, 'Ollama', 'models'));
  }
  for (const cand of candidates) {
    try {
      if (existsSync(cand)) return cand;
    } catch {}
  }
  return '';
}

export const CODE_DOC_SKIP_EXT = new Set(['.lock', '.min.js', '.min.css', '.map', '.svg', '.png', '.jpg', '.webp']);

export const OLLAMA_BIN_TTL_MS = 5 * 60 * 1000;

const OLLAMA_OFFLINE_BACKOFF_MS = 15 * 1000;

export const keepAliveHttpAgent = new http.Agent({ keepAlive: true, maxSockets: 4 });

export const keepAliveHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 4 });

export const OLLAMA_TAGS_TTL_MS = 60 * 1000;

export const gpuRuntime = {
  nvidiaProbeCache: { ts: 0, data: null },
  ollamaBinCache: { ts: 0, path: null },
  ollamaTagsCache: { ts: 0, endpoint: '', map: new Map() },
  ollamaOfflineUntilTs: 0,
  ollamaOfflineEndpoint: '',
  ensureOllamaPromise: null,
  lastOllamaSpawnTs: 0,
  bgEmbedWarmInFlight: false,
  bgSkillIndexInFlight: false,
  ramDistillCacheLoaded: false,
  distillCacheSaveTimer: null,
  lastHostRamWarmTs: 0,
  activeLocalChatCount: 0,
  lastForegroundGpuTs: 0,
};

export const inFlightDistillMap = new Map();

export const OLLAMA_SPAWN_COOLDOWN_MS = 10 * 1000;

export const ramVectorCache = new Map(); // wsAbsRoot -> { model, files: Map<relPath, { sha1, chunks }>, totalChunks, metaPath, binPath, legacyJsonPath }

export const ramSkillVectorCache = new Map(); // storeKey -> { model, dim, metaMtimeMs, skillsCount, entries: Map<slug, { sha1, chunks }> }

export const RAM_DISTILL_CACHE_MAX = 256;

export const RAM_DISTILL_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

export const HOST_RAM_WARM_COOLDOWN_MS = 30 * 60 * 1000;

export const ramDistillCache = new Map();

const activeBackgroundGpuControllers = new Set();

export const CONTINUATION_CACHE_MAX = 96;

export const CONTINUATION_CACHE_TTL_MS = 120 * 1000;

export const continuationCache = new Map();

/**
 * Registers a background AbortController so P0 foreground GPU requests can preempt it immediately.
 * @param {AbortController} controller
 * @returns {() => void}
 */
export function registerBackgroundGpuController(controller) {
  if (controller && typeof controller.abort === 'function') {
    activeBackgroundGpuControllers.add(controller);
  }
  return () => {
    activeBackgroundGpuControllers.delete(controller);
  };
}

/**
 * Immediately aborts all active background GPU requests and records the foreground activity timestamp.
 * @param {string} [reason='foreground_p0']
 * @returns {{ preemptedCount: number, reason: string, ts: number }}
 */
export function preemptBackgroundGpuWork(reason = 'foreground_p0') {
  gpuRuntime.lastForegroundGpuTs = Date.now();
  let preemptedCount = 0;
  for (const ctrl of Array.from(activeBackgroundGpuControllers)) {
    activeBackgroundGpuControllers.delete(ctrl);
    try {
      if (!ctrl.signal?.aborted) {
        ctrl.abort(reason);
        preemptedCount += 1;
      }
    } catch {}
  }
  activeBackgroundGpuControllers.clear();
  return { preemptedCount, reason, ts: gpuRuntime.lastForegroundGpuTs };
}

/**
 * Returns elapsed milliseconds since the last foreground GPU request (Infinity if none yet).
 * @returns {number}
 */
export function getMsSinceLastForegroundGpu() {
  return gpuRuntime.lastForegroundGpuTs > 0 ? Math.max(0, Date.now() - gpuRuntime.lastForegroundGpuTs) : Infinity;
}

/**
 * Reports whether a local interactive RAG chat call is currently active on the GPU.
 * Used by background debounce indexers to avoid VRAM/compute contention.
 * @returns {boolean}
 */
export function isLocalChatActive() {
  return gpuRuntime.activeLocalChatCount > 0;
}

export function clampInt(val, min, max, fallback) {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

/**
 * Читает актуальную конфигурацию локального GPU из router-state.json (без лишнего дискового I/O, если full override уже передан).
 * @param {object} [override={}]
 */
/**
 * Зондирует видеокарту NVIDIA через nvidia-smi с кэшированием на 2 секунды.
 * @param {boolean} [force=false]
 */
export function probeNvidiaGpu(force = false) {
  const now = Date.now();
  if (!force && gpuRuntime.nvidiaProbeCache.data && (now - gpuRuntime.nvidiaProbeCache.ts) < 2000) {
    return gpuRuntime.nvidiaProbeCache.data;
  }
  try {
    const out = execFileSync(
      'nvidia-smi',
      [
        '--query-gpu=name,memory.total,memory.used,memory.free,temperature.gpu,utilization.gpu',
        '--format=csv,noheader,nounits',
      ],
      { encoding: 'utf8', timeout: 1000, windowsHide: true }
    ).trim();
    const firstLine = out.split(/\r?\n/)[0] || '';
    const parts = firstLine.split(',').map((s) => s.trim());
    if (parts.length >= 4) {
      const data = {
        available: true,
        vendor: 'nvidia',
        isDiscrete: true,
        backendHint: 'cuda',
        vramReliable: true,
        name: parts[0],
        totalMb: Number(parts[1]) || 0,
        usedMb: Number(parts[2]) || 0,
        freeMb: Number(parts[3]) || 0,
        tempC: Number(parts[4]) || 0,
        utilPct: Number(parts[5]) || 0,
      };
      gpuRuntime.nvidiaProbeCache = { ts: now, data };
      return data;
    }
  } catch {}
  const anyGpu = probeAnyGpu({ force: false });
  if (anyGpu && anyGpu.vendor && anyGpu.vendor !== 'none') {
    gpuRuntime.nvidiaProbeCache = { ts: now, data: anyGpu };
    return anyGpu;
  }
  const fallback = {
    available: false,
    vendor: 'none',
    isDiscrete: false,
    backendHint: 'cpu',
    vramReliable: false,
    name: 'No discrete GPU detected',
    totalMb: 0,
    usedMb: 0,
    freeMb: 0,
    tempC: 0,
    utilPct: 0,
  };
  gpuRuntime.nvidiaProbeCache = { ts: now, data: fallback };
  return fallback;
}

export function loadGpuConfig(override = {}) {
  const hasFullRouterState =
    override &&
    typeof override === 'object' &&
    Object.hasOwn(override, 'gpuEnabled') &&
    Object.hasOwn(override, 'gpuEndpoint') &&
    Object.hasOwn(override, 'gpuChatModel') &&
    Object.hasOwn(override, 'gpuEmbedModel');
  const activeStateFile =
    typeof process.env.TUNNEL_TEST_STATE_PATH === 'string' && process.env.TUNNEL_TEST_STATE_PATH.trim()
      ? path.resolve(process.env.TUNNEL_TEST_STATE_PATH.trim())
      : STATE_FILE;
  let st = hasFullRouterState ? {} : safeReadJsonSync(activeStateFile, () => ({}), { selfHeal: true });
  // Fallback to calibrated global plugin state when running CLI tools inside uncalibrated repo checkout
  if (
    !process.env.TUNNEL_TEST_STATE_PATH &&
    process.env.TUNNEL_TEST_ISOLATE_INSTALLED !== '1' &&
    !hasFullRouterState &&
    st &&
    st.hardwareProfiled === false &&
    st.onboardingCompleted === false
  ) {
    const globalStateFile = join(os.homedir(), '.gemini', 'config', 'plugins', 'antigravity-model-router', 'router-state.json');
    if (path.resolve(globalStateFile).toLowerCase() !== path.resolve(STATE_FILE).toLowerCase() && existsSync(globalStateFile)) {
      const globalSt = safeReadJsonSync(globalStateFile, () => null, { selfHeal: false });
      if (globalSt && typeof globalSt === 'object' && globalSt.hardwareProfiled === true) {
        st = globalSt;
      }
    }
  }
  const merged = { ...DEFAULT_GPU_CONFIG, ...st, ...override };
  const enforceHwVramCap = !hasFullRouterState && !(override && Object.hasOwn(override, 'gpuMaxVramMb'));
  let maxVramCapMb = 32768;
  if (enforceHwVramCap) {
    try {
      maxVramCapMb = computeMaxVramCapMb(probeNvidiaGpu(false));
    } catch {
      maxVramCapMb = 4096;
    }
  }
  return {
    gpuEnabled: Boolean(merged.gpuEnabled),
    gpuEndpoint: String(merged.gpuEndpoint || DEFAULT_GPU_CONFIG.gpuEndpoint).replace(/\/+$/, ''),
    gpuMaxVramMb: clampInt(
      merged.gpuMaxVramMb,
      2048,
      maxVramCapMb,
      Math.min(DEFAULT_GPU_CONFIG.gpuMaxVramMb, maxVramCapMb)
    ),
    gpuChatModel: String(merged.gpuChatModel || DEFAULT_GPU_CONFIG.gpuChatModel).trim(),
    gpuEmbedModel: String(merged.gpuEmbedModel || DEFAULT_GPU_CONFIG.gpuEmbedModel).trim(),
    gpuEmbedDim: clampInt(merged.gpuEmbedDim, 128, 2048, DEFAULT_GPU_CONFIG.gpuEmbedDim),
    gpuKeepAlive: String(merged.gpuKeepAlive || DEFAULT_GPU_CONFIG.gpuKeepAlive).trim(),
    gpuEmbedKeepAlive: String(merged.gpuEmbedKeepAlive || DEFAULT_GPU_CONFIG.gpuEmbedKeepAlive).trim(),
    gpuContextTokens: clampInt(merged.gpuContextTokens, 2048, 32768, DEFAULT_GPU_CONFIG.gpuContextTokens),
    gpuModelsDir: resolveDefaultGpuModelsDir(merged.gpuModelsDir || DEFAULT_GPU_CONFIG.gpuModelsDir),
    gpuAutoStart: merged.gpuAutoStart !== false,
    gpuAutoDistillLogs: merged.gpuAutoDistillLogs !== false,
    gpuSemanticSearch: merged.gpuSemanticSearch !== false,
    gpuShowPreTaskAdvice: merged.gpuShowPreTaskAdvice !== false,
    gpuUnloadOnExit: merged.gpuUnloadOnExit !== false,
    gpuPostEditCritic: merged.gpuPostEditCritic !== false,
    gpuWarmHostRamCache: merged.gpuWarmHostRamCache !== false,
  };
}

/**
 * Выполняет HTTP/HTTPS JSON-запрос к локальному API Ollama с HTTP Keep-Alive и circuit breaker на ECONNREFUSED.
 * @param {string} method
 * @param {string} urlPath
 * @param {object|null} bodyObj
 * @param {number} [timeoutMs=15000]
 * @param {string} [endpoint='http://127.0.0.1:11434']
 */
export function isProcessAliveSafe(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  if (n === process.pid) return true;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function defaultGpuLiveState() {
  return {
    opSeq: 0,
    inFlight: [],
    lastCompletedAt: 0,
    lastOp: '',
    lastModel: '',
    lastDetail: '',
    lastLatencyMs: 0,
  };
}

/**
 * Classifies whether an Ollama HTTP request is real GPU inference/embedding work
 * (excluding /api/ps, /api/tags, keep_alive=0 unloads, and silent 'warmup' pings).
 */
export function classifyOllamaWorkRequest(method, urlPath, bodyObj = null) {
  if (String(method || '').toUpperCase() !== 'POST') return null;
  const cleanPath = String(urlPath || '').split('?')[0].toLowerCase();
  if (!/^\/api\/(generate|chat|embed|embeddings)$/.test(cleanPath)) return null;
  if (!bodyObj || typeof bodyObj !== 'object') return null;

  const isUnload =
    bodyObj.keep_alive === 0 &&
    !bodyObj.prompt &&
    !bodyObj.input &&
    (!Array.isArray(bodyObj.messages) || bodyObj.messages.length === 0);
  if (isUnload) return null;

  if ((cleanPath === '/api/embed' || cleanPath === '/api/embeddings') && bodyObj.input === 'warmup') {
    return null;
  }

  const model = String(bodyObj.model || '').trim();
  if (cleanPath === '/api/generate' || cleanPath === '/api/chat') {
    return {
      op: 'distill',
      model,
      detail: model ? `Дистилляция на ${model}` : 'Генерация / сжатие на GPU',
    };
  }
  const batchLen = Array.isArray(bodyObj.input) ? bodyObj.input.length : 1;
  if (batchLen > 1) {
    return {
      op: 'vector_index',
      model,
      detail: `Индексация векторов (${batchLen} фрагм.)`,
    };
  }
  return {
    op: 'semantic_embed',
    model,
    detail: model ? `Семантический поиск (${model})` : 'Семантический поиск на GPU',
  };
}

export function beginGpuLiveWork({ op = 'inference', model = '', detail = '', activityFile = GPU_LIVE_ACTIVITY_FILE } = {}) {
  const now = Date.now();
  const jobId = `${process.pid}-${now}-${Math.random().toString(36).slice(2, 7)}`;
  const targetFile = activityFile || GPU_LIVE_ACTIVITY_FILE;
  const targetDir = dirname(targetFile);
  try {
    if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
    updateJsonAtomicSync(targetFile, defaultGpuLiveState, (cur) => {
      const base = cur && typeof cur === 'object' ? cur : defaultGpuLiveState();
      const freshJobs = (Array.isArray(base.inFlight) ? base.inFlight : []).filter(
        (j) => j && j.id && (now - Number(j.startedAt || 0) < 95_000) && isProcessAliveSafe(j.pid)
      );
      freshJobs.push({
        id: jobId,
        pid: process.pid,
        op: String(op || 'inference'),
        model: String(model || '').slice(0, 64),
        detail: String(detail || '').slice(0, 96),
        startedAt: now,
      });
      return {
        ...base,
        opSeq: Number(base.opSeq || 0) + 1,
        inFlight: freshJobs.slice(-12),
      };
    });
  } catch {}
  return { jobId, startedAt: now };
}

export function endGpuLiveWork(jobId, { op = '', model = '', detail = '', latencyMs = 0, activityFile = GPU_LIVE_ACTIVITY_FILE } = {}) {
  const now = Date.now();
  const targetFile = activityFile || GPU_LIVE_ACTIVITY_FILE;
  const targetDir = dirname(targetFile);
  try {
    if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
    updateJsonAtomicSync(targetFile, defaultGpuLiveState, (cur) => {
      const base = cur && typeof cur === 'object' ? cur : defaultGpuLiveState();
      const prevJobs = Array.isArray(base.inFlight) ? base.inFlight : [];
      const finishedJob = prevJobs.find((j) => j && j.id === jobId) || null;
      const remaining = prevJobs.filter(
        (j) => j && j.id !== jobId && (now - Number(j.startedAt || 0) < 95_000) && isProcessAliveSafe(j.pid)
      );
      const elapsed = latencyMs > 0
        ? Math.round(latencyMs)
        : (finishedJob?.startedAt ? Math.max(1, now - Number(finishedJob.startedAt)) : 0);
      return {
        ...base,
        opSeq: Number(base.opSeq || 0) + 1,
        inFlight: remaining,
        lastCompletedAt: now,
        lastOp: String(op || finishedJob?.op || base.lastOp || ''),
        lastModel: String(model || finishedJob?.model || base.lastModel || '').slice(0, 64),
        lastDetail: String(detail || finishedJob?.detail || base.lastDetail || '').slice(0, 96),
        lastLatencyMs: elapsed,
      };
    });
  } catch {}
}

export function getGpuLiveActivity({ now = Date.now(), afterglowMs = 2400, activityFile = GPU_LIVE_ACTIVITY_FILE } = {}) {
  const targetFile = activityFile || GPU_LIVE_ACTIVITY_FILE;
  try {
    if (!existsSync(targetFile)) {
      return {
        inFlightCount: 0,
        activeJobs: [],
        isWorking: false,
        isAfterglow: false,
        afterglowRatio: 0,
        opSeq: 0,
        currentOp: '',
        currentModel: '',
        currentDetail: '',
        lastCompletedAt: null,
        msSinceLast: null,
        lastLatencyMs: 0,
      };
    }
    const raw = safeReadJsonSync(targetFile, defaultGpuLiveState, { selfHeal: false }) || defaultGpuLiveState();
    const activeJobs = (Array.isArray(raw.inFlight) ? raw.inFlight : []).filter(
      (j) => j && j.id && (now - Number(j.startedAt || 0) < 95_000) && isProcessAliveSafe(j.pid)
    );
    const lastCompletedAt = Number(raw.lastCompletedAt || 0);
    const msSinceLast = lastCompletedAt > 0 ? Math.max(0, now - lastCompletedAt) : null;
    const isWorking = activeJobs.length > 0;
    const isAfterglow = !isWorking && msSinceLast !== null && msSinceLast <= afterglowMs;
    const afterglowRatio = isWorking
      ? 1
      : (isAfterglow ? Number(Math.max(0, 1 - msSinceLast / afterglowMs).toFixed(3)) : 0);
    const headJob = activeJobs[activeJobs.length - 1] || null;
    return {
      inFlightCount: activeJobs.length,
      activeJobs,
      isWorking,
      isAfterglow,
      afterglowRatio,
      opSeq: Number(raw.opSeq || 0),
      currentOp: headJob?.op || raw.lastOp || '',
      currentModel: headJob?.model || raw.lastModel || '',
      currentDetail: headJob?.detail || raw.lastDetail || '',
      lastCompletedAt: lastCompletedAt || null,
      msSinceLast,
      lastLatencyMs: Number(raw.lastLatencyMs || 0),
    };
  } catch {
    return {
      inFlightCount: 0,
      activeJobs: [],
      isWorking: false,
      isAfterglow: false,
      afterglowRatio: 0,
      opSeq: 0,
      currentOp: '',
      currentModel: '',
      currentDetail: '',
      lastCompletedAt: null,
      msSinceLast: null,
      lastLatencyMs: 0,
    };
  }
}

export function ollamaHttpJson(method, urlPath, bodyObj = null, timeoutMs = 15000, endpoint = 'http://127.0.0.1:11434', opts = {}) {
  return new Promise((resolve) => {
    const extSignal = opts?.signal && typeof opts.signal.addEventListener === 'function' ? opts.signal : null;
    if (extSignal?.aborted) {
      return resolve({ ok: false, aborted: true, error: 'Ollama request aborted' });
    }
    let url;
    try {
      url = new URL(urlPath, endpoint);
    } catch (err) {
      return resolve({ ok: false, error: err.message });
    }
    const isBackground = opts?.priority === 'background';
    const workInfo = opts?.workInfoOverride || classifyOllamaWorkRequest(method, urlPath, bodyObj);
    if (!isBackground && workInfo) {
      preemptBackgroundGpuWork('p0_ollama_foreground');
    }

    let bgController = null;
    let unregisterBg = null;
    let onExtAbort = null;
    if (isBackground && !opts?._skipBgRegister) {
      bgController = new AbortController();
      unregisterBg = registerBackgroundGpuController(bgController);
      if (extSignal) {
        onExtAbort = () => {
          try { bgController.abort(); } catch {}
        };
        extSignal.addEventListener('abort', onExtAbort, { once: true });
      }
    }
    const signal = bgController ? bgController.signal : extSignal;
    if (signal?.aborted) {
      if (unregisterBg) unregisterBg();
      if (extSignal && onExtAbort) {
        try { extSignal.removeEventListener('abort', onExtAbort); } catch {}
      }
      return resolve({ ok: false, aborted: true, error: 'Ollama request aborted' });
    }

    const liveTicket = workInfo ? beginGpuLiveWork(workInfo) : null;
    const isHttps = url.protocol === 'https:';
    const mod = isHttps ? https : http;
    const payloadStr = bodyObj !== null ? JSON.stringify(bodyObj) : '';
    const headers = bodyObj !== null
      ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payloadStr, 'utf8') }
      : {};

    let settled = false;
    let onAbort = null;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      if (unregisterBg) {
        try { unregisterBg(); } catch {}
        unregisterBg = null;
      }
      if (extSignal && onExtAbort && typeof extSignal.removeEventListener === 'function') {
        try { extSignal.removeEventListener('abort', onExtAbort); } catch {}
      }
      if (signal && onAbort && typeof signal.removeEventListener === 'function') {
        try { signal.removeEventListener('abort', onAbort); } catch {}
      }
      if (liveTicket) {
        endGpuLiveWork(liveTicket.jobId, {
          op: workInfo.op,
          model: workInfo.model,
          detail: workInfo.detail,
          latencyMs: Date.now() - liveTicket.startedAt,
        });
      }
      resolve(val);
    };

    const req = mod.request(
      {
        hostname: url.hostname,
        port: Number(url.port) || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method,
        agent: isHttps ? keepAliveHttpsAgent : keepAliveHttpAgent,
        headers,
        timeout: timeoutMs,
      },
      (res) => {
        gpuRuntime.ollamaOfflineUntilTs = 0;
        gpuRuntime.ollamaOfflineEndpoint = '';
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          try {
            const parsed = raw ? JSON.parse(raw) : {};
            if (res.statusCode >= 200 && res.statusCode < 300) {
              finish({ ok: true, status: res.statusCode, data: parsed });
            } else {
              finish({ ok: false, status: res.statusCode, error: parsed?.error || `HTTP ${res.statusCode}` });
            }
          } catch (err) {
            finish({ ok: false, status: res.statusCode, error: `Invalid JSON: ${err.message}` });
          }
        });
      }
    );

    if (signal) {
      onAbort = () => {
        try { req.destroy(); } catch {}
        finish({ ok: false, aborted: true, error: 'Ollama request aborted' });
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }

    req.on('timeout', () => {
      try { req.destroy(); } catch {}
      finish({ ok: false, error: `Ollama request timeout (${timeoutMs}ms)` });
    });
    req.on('error', (err) => {
      if (err?.code === 'ECONNREFUSED' || /ECONNREFUSED/i.test(String(err?.message || ''))) {
        gpuRuntime.ollamaOfflineUntilTs = Date.now() + OLLAMA_OFFLINE_BACKOFF_MS;
        gpuRuntime.ollamaOfflineEndpoint = url.origin;
      }
      finish({ ok: false, code: err?.code, error: err.message });
    });

    if (payloadStr) req.write(payloadStr);
    req.end();
  });
}

export function defaultGpuTelemetry() {
  return {
    distillCalls: 0,
    distillCacheHits: 0,
    distillCacheEntries: ramDistillCache.size,
    hostRamWarmedMb: 0,
    semanticSearches: 0,
    indexedFiles: 0,
    indexedChunks: 0,
    rawCharsProcessed: 0,
    distilledCharsReturned: 0,
    savedChars: 0,
    savedTokensEstimate: 0,
    lastLatencyMs: 0,
    lastModel: '',
    lastMode: '',
    lastAt: null,
  };
}

/**
 * Читает и обновляет накопительную статистику экономии токенов локальной GPU.
 */
export function getGpuTelemetry() {
  const base = defaultGpuTelemetry();
  const stored = safeReadJsonSync(
    GPU_TELEMETRY_FILE,
    () => base,
    { selfHeal: true }
  );
  return {
    ...base,
    ...(stored && typeof stored === 'object' ? stored : {}),
    distillCacheEntries: ramDistillCache.size,
  };
}

export function recordGpuTelemetryPatch(mutator) {
  try {
    if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
    updateJsonAtomicSync(GPU_TELEMETRY_FILE, () => getGpuTelemetry(), (cur) => mutator(cur));
  } catch {}
}

export function sameEmbedModel(a, b) {
  const norm = (x) => {
    const s = String(x || '').trim().toLowerCase();
    return s && !s.includes(':') ? `${s}:latest` : s;
  };
  return Boolean(a && b) && norm(a) === norm(b);
}

/**
 * Закрывает keep-alive HTTP/HTTPS-пулы подключений к Ollama перед завершением процесса.
 */
export function destroyOllamaKeepAliveAgents() {
  try { keepAliveHttpAgent.destroy(); } catch {}
  try { keepAliveHttpsAgent.destroy(); } catch {}
}

export function stripReasoningTags(text = '') {
  return String(text || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
    .replace(/<\|thought\|?>[\s\S]*?(?:<\|\/?thought\|>|<channel\|>|<\/thought>|$)/gi, '')
    .replace(/^[\s\S]*?<\/(?:think|thought)>/i, '')
    .replace(/<think>[\s\S]*$/gi, '')
    .replace(/<thought>[\s\S]*$/gi, '')
    .trim();
}

export function parseStrictBackgroundJson(rawText = '') {
  const cleaned = stripReasoningTags(String(rawText || ''))
    .replace(/```(?:json)?\s*/gi, '')
    .replace(/```/g, '')
    .trim();
  if (!cleaned) return null;
  try {
    const direct = JSON.parse(cleaned);
    if (direct && typeof direct === 'object') return direct;
  } catch {}
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      const sub = JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
      if (sub && typeof sub === 'object') return sub;
    } catch {}
  }
  return null;
}

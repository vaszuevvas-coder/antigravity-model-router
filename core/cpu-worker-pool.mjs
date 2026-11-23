/**
 * @file cpu-worker-pool.mjs
 * @description Shared multi-core CPU worker pool on node:worker_threads with automatic scaling,
 * zero-hang unref() idle lifecycle, and 0 MB VRAM telemetry (.cache/cpu-telemetry.json).
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import * as nodeModule from 'node:module';
import os from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { safeReadJsonSync, updateJsonAtomicSync } from './safe-json.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PLUGIN_ROOT = join(__dirname, '..');
const STATE_FILE = join(PLUGIN_ROOT, 'router-state.json');
const CACHE_DIR = join(PLUGIN_ROOT, '.cache');
const CPU_TELEMETRY_FILE = join(CACHE_DIR, 'cpu-telemetry.json');
const CPU_LIVE_ACTIVITY_FILE = join(CACHE_DIR, 'cpu-live-activity.json');

export const DEFAULT_CPU_CONFIG = {
  cpuMulticoreEnabled: true,
  cpuMaxThreads: 12,
  cpuTrigramIndex: true,
  cpuCrossRerank: true,
  cpuParallelVerify: true,
  cpuSotaEngines: true,
  ramSotaEngines: true,
};

const IDLE_TIMEOUT_MS = 15000;
const SWEEP_INTERVAL_MS = 5000;
const CONFIG_TTL_MS = 2000;

let configCache = { ts: 0, cfg: null };
let lazyExtractMeta = null;
let lazyChunkForVectors = null;
let lazyAuditFileItem = null;
let lazyCompressLogsMod = null;
let lazyFoldCodeMod = null;
let lazyGraphContractsMod = null;
let lazySbflHealerMod = null;

function clampInt(val, min, max, fallback) {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function defaultCpuTelemetry() {
  return {
    workerBatches: 0,
    workerItemsProcessed: 0,
    rerankCalls: 0,
    lastRerankMs: 0,
    lastBatchMs: 0,
    lastBatchType: '',
    peakWorkersUsed: 0,
    drainCompressedLogs: 0,
    jsonCrushedPayloads: 0,
    knapsackFoldedSlices: 0,
    deltaRereads: 0,
    mmrFilteredSlices: 0,
    pprBridgeQueries: 0,
    coChangeHints: 0,
    sbflLocalizations: 0,
    arityContractAlerts: 0,
    bitapHealedPatches: 0,
    astSkimmedBranches: 0,
    simhashClonesCaught: 0,
    zeroCopyTasks: 0,
    cpuSavedTokensEstimate: 0,
    lastAt: '',
  };
}

export function loadCpuConfig(override = {}) {
  const now = Date.now();
  let disk = {};
  if (configCache.cfg && now - configCache.ts < CONFIG_TTL_MS) {
    disk = configCache.cfg;
  } else {
    disk = safeReadJsonSync(STATE_FILE, () => ({}), { selfHeal: false }) || {};
    if (disk && disk.hardwareProfiled === false && disk.onboardingCompleted === false) {
      const globalStateFile = join(os.homedir(), '.gemini', 'config', 'plugins', 'antigravity-model-router', 'router-state.json');
      if (resolve(globalStateFile).toLowerCase() !== resolve(STATE_FILE).toLowerCase() && existsSync(globalStateFile)) {
        const globalSt = safeReadJsonSync(globalStateFile, () => null, { selfHeal: false });
        if (globalSt && typeof globalSt === 'object' && globalSt.hardwareProfiled === true) {
          disk = globalSt;
        }
      }
    }
    configCache = { ts: now, cfg: disk };
  }
  const merged = { ...DEFAULT_CPU_CONFIG, ...disk, ...override };
  return {
    cpuMulticoreEnabled: merged.cpuMulticoreEnabled !== false,
    cpuMaxThreads: clampInt(merged.cpuMaxThreads, 1, 64, DEFAULT_CPU_CONFIG.cpuMaxThreads),
    cpuTrigramIndex: merged.cpuTrigramIndex !== false,
    cpuCrossRerank: merged.cpuCrossRerank !== false,
    cpuParallelVerify: merged.cpuParallelVerify !== false,
    cpuSotaEngines: merged.cpuSotaEngines !== false,
    ramSotaEngines: merged.ramSotaEngines !== false,
  };
}

export function resolveCpuThreadBudget(override = {}) {
  const cfg = loadCpuConfig(override);
  const logicalCores = Math.max(1, os.cpus()?.length || 4);
  const hwSafeCap = Math.max(2, logicalCores - 4);
  if (!cfg.cpuMulticoreEnabled) return 1;
  return Math.max(1, Math.min(cfg.cpuMaxThreads, hwSafeCap));
}

export function recordCpuTelemetryPatch(mutatorFn) {
  try {
    if (!existsSync(CACHE_DIR)) {
      mkdirSync(CACHE_DIR, { recursive: true });
    }
    return updateJsonAtomicSync(CPU_TELEMETRY_FILE, defaultCpuTelemetry, (cur) => {
      const base = { ...defaultCpuTelemetry(), ...(cur && typeof cur === 'object' ? cur : {}) };
      const next = typeof mutatorFn === 'function' ? mutatorFn(base) : base;
      return { ...base, ...next };
    });
  } catch {
    return null;
  }
}

export function readCpuTelemetry() {
  return safeReadJsonSync(CPU_TELEMETRY_FILE, defaultCpuTelemetry, { selfHeal: false }) || defaultCpuTelemetry();
}

const CPU_SAVING_KIND_MAP = {
  drain: 'drainCompressedLogs',
  drain_logs: 'drainCompressedLogs',
  draincompressedlogs: 'drainCompressedLogs',
  log: 'drainCompressedLogs',
  logs: 'drainCompressedLogs',
  json: 'jsonCrushedPayloads',
  json_crush: 'jsonCrushedPayloads',
  crush: 'jsonCrushedPayloads',
  jsoncrushedpayloads: 'jsonCrushedPayloads',
  knapsack: 'knapsackFoldedSlices',
  ast_knapsack: 'knapsackFoldedSlices',
  fold: 'knapsackFoldedSlices',
  knapsackfoldedslices: 'knapsackFoldedSlices',
  delta: 'deltaRereads',
  delta_reread: 'deltaRereads',
  deltarereads: 'deltaRereads',
  mmr: 'mmrFilteredSlices',
  mmr_filter: 'mmrFilteredSlices',
  mmrfilteredslices: 'mmrFilteredSlices',
  ppr: 'pprBridgeQueries',
  ppr_bridge: 'pprBridgeQueries',
  cochange: 'coChangeHints',
  co_change: 'coChangeHints',
  sbfl: 'sbflLocalizations',
  ochiai: 'sbflLocalizations',
  arity: 'arityContractAlerts',
  arity_contract: 'arityContractAlerts',
  bitap: 'bitapHealedPatches',
  bitap_heal: 'bitapHealedPatches',
  ast_skim: 'astSkimmedBranches',
  skim: 'astSkimmedBranches',
  simhash: 'simhashClonesCaught',
  simhash_clone: 'simhashClonesCaught',
  zero_copy: 'zeroCopyTasks',
};

/**
 * Records a CPU-level context compression saving into .cache/cpu-telemetry.json.
 * @param {{ kind?: string, savedChars?: number, latencyMs?: number }} [params={}]
 */
export function recordCpuCompressionSaving({ kind = '', savedChars = 0, latencyMs = 0 } = {}) {
  const cleanChars = Math.max(0, Number(savedChars) || 0);
  const savedTokens = Math.max(0, Math.round(cleanChars / 3.8));
  const normKind = String(kind || '').trim().toLowerCase();
  const counterField = CPU_SAVING_KIND_MAP[normKind] || '';
  const cleanLatency = Math.max(0, Number(latencyMs) || 0);

  return recordCpuTelemetryPatch((cur) => {
    const patch = {
      cpuSavedTokensEstimate: (cur.cpuSavedTokensEstimate || 0) + savedTokens,
      lastAt: new Date().toISOString(),
    };
    if (counterField) {
      patch[counterField] = (cur[counterField] || 0) + 1;
    }
    if (cleanLatency > 0) {
      patch.lastRerankMs = Number(cleanLatency.toFixed(2));
    }
    return patch;
  });
}

const sharedUtf8Decoder = new TextDecoder('utf-8');

function resolveWorkerItemText(item, fallbackField = 'text') {
  if (
    item &&
    (item.sab instanceof SharedArrayBuffer || item.sab instanceof ArrayBuffer) &&
    Number.isInteger(item.byteOffset) &&
    Number.isInteger(item.byteLength) &&
    item.byteOffset >= 0 &&
    item.byteLength >= 0 &&
    item.byteOffset + item.byteLength <= item.sab.byteLength
  ) {
    return sharedUtf8Decoder.decode(new Uint8Array(item.sab, item.byteOffset, item.byteLength));
  }
  return String(item?.[fallbackField] ?? '');
}

async function runBatchTaskLocally(type, items = []) {
  if (!Array.isArray(items) || items.length === 0) return [];
  if (type === 'parseMetadataBatch') {
    if (!lazyExtractMeta) {
      const mod = await import('./repo-mapper.mjs');
      lazyExtractMeta = mod.extractFileAllMetadata;
    }
    return items.map((item) => {
      try {
        return {
          relPath: item?.relPath || '',
          meta: lazyExtractMeta(item?.ext || '', resolveWorkerItemText(item, 'text')),
        };
      } catch (err) {
        return { relPath: item?.relPath || '', meta: null, error: String(err?.message || err) };
      }
    });
  }
  if (type === 'chunkVectorsBatch') {
    if (!lazyChunkForVectors) {
      const mod = await import('./local-gpu-engine.mjs');
      lazyChunkForVectors = mod.chunkFileForVectors;
    }
    return items.map((item) => {
      try {
        const text = resolveWorkerItemText(item, 'text');
        return {
          relPath: item?.relPath || '',
          sha1: item?.sha1 || createHash('sha1').update(text, 'utf8').digest('hex').slice(0, 16),
          chunks: lazyChunkForVectors(item?.relPath || '', text, item?.opts || {}),
        };
      } catch (err) {
        return { relPath: item?.relPath || '', sha1: '', chunks: [], error: String(err?.message || err) };
      }
    });
  }
  if (type === 'syntaxCheckBatch') {
    const out = [];
    for (const item of items) {
      const file = String(item.file || '');
      const ext = extname(file).toLowerCase();
      const code = resolveWorkerItemText(item, 'code');
      try {
        const isEsmSyntax = ext === '.mjs' || /\b(?:import|export)\b|\bawait\b/.test(code);
        if (/\.d\.[cm]?ts$/i.test(file)) {
          out.push({ file, ok: true });
        } else if (!isEsmSyntax) {
          new Script(code, { filename: file });
          out.push({ file, ok: true });
        } else if (typeof nodeModule.stripTypeScriptTypes === 'function') {
          nodeModule.stripTypeScriptTypes(code, { mode: 'strip' });
          out.push({ file, ok: true });
        } else {
          out.push({ file, ok: null, needsSubprocessCheck: true });
        }
      } catch (err) {
        if (err?.code === 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX') {
          out.push({ file, ok: null, needsSubprocessCheck: true });
        } else {
          out.push({ file, ok: false, error: String(err?.message || err).slice(0, 160) });
        }
      }
    }
    return out;
  }
  if (type === 'auditFileBatch') {
    if (!lazyAuditFileItem) {
      const mod = await import('../skills/deep-stress-auditor/scripts/lib/file-worker-tasks.mjs');
      lazyAuditFileItem = mod.auditFileItem;
    }
    return items.map((item) => {
      try {
        return lazyAuditFileItem(item);
      } catch (err) {
        return {
          relPath: item?.relPath || '',
          ok: false,
          error: String(err?.message || err).slice(0, 180),
          findings: [],
        };
      }
    });
  }
  if (type === 'compressLogsBatch') {
    if (!lazyCompressLogsMod) {
      lazyCompressLogsMod = await import('./cpu-log-json-compressor.mjs');
    }
    return items.map((item) => {
      try {
        const text = String(item?.text || '');
        const mode = String(item?.mode || '').toLowerCase();
        if (mode === 'json' && lazyCompressLogsMod?.crushStructuredPayload) {
          return {
            id: item?.id ?? null,
            relPath: item?.relPath || '',
            ok: true,
            ...lazyCompressLogsMod.crushStructuredPayload(text, item?.opts || {}),
          };
        }
        return {
          id: item?.id ?? null,
          relPath: item?.relPath || '',
          ok: true,
          ...lazyCompressLogsMod.compressLogsDrain3(text, item?.opts || {}),
        };
      } catch (err) {
        return {
          id: item?.id ?? null,
          relPath: item?.relPath || '',
          ok: false,
          error: String(err?.message || err).slice(0, 180),
        };
      }
    });
  }
  if (type === 'foldCodeBatch') {
    if (!lazyFoldCodeMod) {
      lazyFoldCodeMod = await import('./cpu-ast-graph-compressor.mjs');
    }
    return items.map((item) => {
      try {
        const relPath = String(item?.relPath || '');
        const text = resolveWorkerItemText(item, item?.text !== undefined ? 'text' : 'sourceText');
        const ext = item?.ext || (relPath ? extname(relPath).toLowerCase() : '.mjs') || '.mjs';
        return {
          relPath,
          ...lazyFoldCodeMod.foldCodeWithKnapsack(text, {
            ext,
            ...(item?.opts || {}),
          }),
        };
      } catch (err) {
        return {
          relPath: item?.relPath || '',
          ok: false,
          error: String(err?.message || err).slice(0, 180),
        };
      }
    });
  }
  if (type === 'simhashIndexBatch') {
    if (!lazyGraphContractsMod) {
      lazyGraphContractsMod = await import('./cpu-graph-contracts.mjs');
    }
    return items.map((item) => {
      try {
        const relPath = String(item?.relPath || '');
        return {
          relPath,
          ok: true,
          hashes: lazyGraphContractsMod.computeFileSimHashes({
            relPath,
            ext: item?.ext || '',
            text: resolveWorkerItemText(item, 'text'),
            symbols: item?.symbols || null,
          }),
        };
      } catch (err) {
        return { relPath: item?.relPath || '', ok: false, hashes: [], error: String(err?.message || err).slice(0, 180) };
      }
    });
  }
  if (type === 'skimAstBatch') {
    if (!lazySbflHealerMod) {
      lazySbflHealerMod = await import('./cpu-sbfl-healer.mjs');
    }
    return items.map((item) => {
      try {
        return {
          relPath: String(item?.relPath || ''),
          ...lazySbflHealerMod.skimAstBranchesWithBraceBalance(
            String(item?.text || ''),
            String(item?.query || ''),
            item?.opts || {}
          ),
        };
      } catch (err) {
        return { relPath: item?.relPath || '', ok: false, error: String(err?.message || err).slice(0, 180) };
      }
    });
  }
  throw new Error(`Unknown CPU worker task type: ${type}`);
}

if (!isMainThread && parentPort) {
  parentPort.on('message', async (msg) => {
    const id = msg?.id;
    try {
      const result = await runBatchTaskLocally(msg?.type, msg?.payload?.items || []);
      parentPort.postMessage({ id, ok: true, result });
    } catch (err) {
      parentPort.postMessage({ id, ok: false, error: String(err?.message || err) });
    }
  });
}

const WORKER_UNSAFE_FLAGS_WITH_VALUE = new Set([
  '--input-type',
  '-e',
  '--eval',
  '-p',
  '--print',
  '--max-old-space-size',
  '--max-semi-space-size',
  '--v8-pool-size',
  '--inspect-port',
  '--debug-port',
  '--title',
  '--use-largepages',
  '--trace-event-file-pattern',
  '--secure-heap',
  '--secure-heap-min',
  '--stack-trace-limit',
  '--tls-cipher-list',
]);

const WORKER_UNSAFE_FLAG_PREFIXES = [
  '--input-type=',
  '--eval=',
  '--print=',
  '--max-old-space-size=',
  '--max-semi-space-size=',
  '--v8-pool-size=',
  '--inspect',
  '--debug-port=',
  '--prof',
  '--title=',
  '--zero-fill-buffers',
  '--use-largepages=',
  '--trace-event-file-pattern=',
  '--node-snapshot',
  '--secure-heap',
  '--stack-trace-limit=',
  '--tls-cipher-list=',
];

export function getSafeWorkerExecArgv(rawExecArgv = process.execArgv) {
  const out = [];
  const src = Array.isArray(rawExecArgv) ? rawExecArgv : [];
  for (let i = 0; i < src.length; i++) {
    const a = String(src[i] || '');
    if (!a) continue;
    if (WORKER_UNSAFE_FLAGS_WITH_VALUE.has(a)) {
      if (i + 1 < src.length && !String(src[i + 1] || '').startsWith('-')) {
        i += 1;
      }
      continue;
    }
    if (WORKER_UNSAFE_FLAG_PREFIXES.some((prefix) => a === prefix || a.startsWith(prefix))) {
      continue;
    }
    out.push(a);
  }
  if (!out.includes('--no-warnings')) {
    out.push('--no-warnings');
  }
  return out;
}

const DEFAULT_WORKER_TASK_TIMEOUT_MS = 25_000;

class CpuWorkerPool {
  constructor() {
    this.slots = [];
    this.pendingQueue = [];
    this.nextTaskId = 1;
    this.sweepTimer = null;
    this.stats = {
      spawnedTotal: 0,
      batchesRun: 0,
      inlineFallbacks: 0,
      workerErrors: 0,
      workerTimeouts: 0,
      peakBusyWorkers: 0,
    };
  }

  clearSlotTimer(slot) {
    if (slot && slot.jobTimer) {
      clearTimeout(slot.jobTimer);
      slot.jobTimer = null;
    }
  }

  startSweeper() {
    if (this.sweepTimer || !isMainThread) return;
    this.sweepTimer = setInterval(() => {
      const now = Date.now();
      for (let i = this.slots.length - 1; i >= 0; i--) {
        const slot = this.slots[i];
        if (!slot.busy && now - slot.lastUsedAt >= IDLE_TIMEOUT_MS) {
          this.removeSlot(slot);
        }
      }
      if (this.slots.length === 0 && this.sweepTimer) {
        clearInterval(this.sweepTimer);
        this.sweepTimer = null;
      }
    }, SWEEP_INTERVAL_MS);
    if (typeof this.sweepTimer.unref === 'function') {
      this.sweepTimer.unref();
    }
  }

  removeSlot(slot) {
    this.clearSlotTimer(slot);
    const idx = this.slots.indexOf(slot);
    if (idx !== -1) this.slots.splice(idx, 1);
    try {
      slot.worker.unref();
    } catch {}
    try {
      slot.worker.terminate();
    } catch {}
  }

  spawnSlot() {
    const worker = new Worker(__filename, { execArgv: getSafeWorkerExecArgv() });
    // Critical: never keep short-lived CLI/hook processes alive when idle
    worker.unref();
    const slot = {
      worker,
      busy: false,
      currentJob: null,
      jobTimer: null,
      lastUsedAt: Date.now(),
    };
    worker.on('message', (msg) => {
      this.clearSlotTimer(slot);
      const job = slot.currentJob;
      slot.currentJob = null;
      slot.busy = false;
      slot.lastUsedAt = Date.now();
      // Drop ref immediately so process exits cleanly if no further task starts
      try {
        worker.unref();
      } catch {}
      if (job) {
        if (msg?.ok) job.resolve(msg.result);
        else job.reject(new Error(msg?.error || 'CPU worker failure'));
      }
      this.drainQueue();
    });
    worker.on('error', (err) => {
      this.clearSlotTimer(slot);
      this.stats.workerErrors += 1;
      const job = slot.currentJob;
      slot.currentJob = null;
      slot.busy = false;
      this.removeSlot(slot);
      if (job) job.reject(err);
      this.drainQueue();
    });
    worker.on('exit', () => {
      this.clearSlotTimer(slot);
      const job = slot.currentJob;
      slot.currentJob = null;
      slot.busy = false;
      const idx = this.slots.indexOf(slot);
      if (idx !== -1) this.slots.splice(idx, 1);
      if (job) job.reject(new Error('CPU worker exited unexpectedly'));
      this.drainQueue();
    });
    this.slots.push(slot);
    this.stats.spawnedTotal += 1;
    this.startSweeper();
    return slot;
  }

  acquireSlot(budget) {
    for (const slot of this.slots) {
      if (!slot.busy) return slot;
    }
    if (this.slots.length < budget) {
      return this.spawnSlot();
    }
    return null;
  }

  dispatchToSlot(slot, job) {
    this.clearSlotTimer(slot);
    slot.busy = true;
    slot.currentJob = job;
    slot.lastUsedAt = Date.now();
    const busyCount = this.slots.filter((s) => s.busy).length;
    if (busyCount > this.stats.peakBusyWorkers) {
      this.stats.peakBusyWorkers = busyCount;
    }
    // Keep Node alive only while actively awaiting an in-flight worker batch
    try {
      slot.worker.ref();
    } catch {}
    const effectiveTimeoutMs = Math.max(25, Number(job.timeoutMs) || DEFAULT_WORKER_TASK_TIMEOUT_MS);
    slot.jobTimer = setTimeout(() => {
      slot.jobTimer = null;
      if (slot.currentJob !== job) return;
      slot.currentJob = null;
      slot.busy = false;
      this.stats.workerErrors += 1;
      this.stats.workerTimeouts += 1;
      this.removeSlot(slot);
      const timeoutErr = new Error(`CPU worker task timed out after ${effectiveTimeoutMs}ms (${job.type})`);
      timeoutErr.isWorkerTimeout = true;
      job.reject(timeoutErr);
      this.drainQueue();
    }, effectiveTimeoutMs);
    if (typeof slot.jobTimer.unref === 'function') {
      slot.jobTimer.unref();
    }
    slot.worker.postMessage({ id: job.id, type: job.type, payload: job.payload });
  }

  drainQueue() {
    while (this.pendingQueue.length > 0) {
      const nextJob = this.pendingQueue[0];
      const budget = nextJob?.budget > 0 ? nextJob.budget : resolveCpuThreadBudget();
      const slot = this.acquireSlot(budget);
      if (!slot) break;
      this.pendingQueue.shift();
      this.dispatchToSlot(slot, nextJob);
    }
  }

  submit(type, items, budget, timeoutMs = DEFAULT_WORKER_TASK_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const job = { id: this.nextTaskId++, type, payload: { items }, budget, timeoutMs, resolve, reject };
      const slot = this.acquireSlot(budget);
      if (slot) {
        this.dispatchToSlot(slot, job);
      } else {
        this.pendingQueue.push(job);
      }
    });
  }

  getStats() {
    const busyWorkers = this.slots.filter((s) => s.busy).length;
    return {
      activeWorkers: this.slots.length,
      busyWorkers,
      idleWorkers: this.slots.length - busyWorkers,
      queuedJobs: this.pendingQueue.length,
      ...this.stats,
    };
  }

  async shutdown() {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    while (this.pendingQueue.length > 0) {
      const job = this.pendingQueue.shift();
      job.reject(new Error('CPU worker pool shut down'));
    }
    const toClose = [...this.slots];
    this.slots = [];
    await Promise.all(
      toClose.map(async (slot) => {
        this.clearSlotTimer(slot);
        if (slot.currentJob) {
          slot.currentJob.reject(new Error('CPU worker pool shut down'));
          slot.currentJob = null;
        }
        try {
          await slot.worker.terminate();
        } catch {}
      })
    );
  }
}

const poolSingleton = isMainThread ? new CpuWorkerPool() : null;

export function getCpuPoolStats() {
  return poolSingleton ? poolSingleton.getStats() : { activeWorkers: 0, busyWorkers: 0, idleWorkers: 0, queuedJobs: 0 };
}

export async function shutdownCpuPool() {
  if (poolSingleton) {
    await poolSingleton.shutdown();
  }
}

function isProcessAliveSafe(pid) {
  const num = Number(pid);
  if (!Number.isInteger(num) || num <= 0) return false;
  if (num === process.pid) return true;
  try {
    process.kill(num, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

function defaultCpuLiveState() {
  return {
    opSeq: 0,
    inFlight: [],
    lastCompletedAt: 0,
    lastOp: '',
    lastDetail: '',
    lastWorkers: 0,
    lastItems: 0,
    lastLatencyMs: 0,
  };
}

function describeCpuBatchDetailRu(type, count = 0) {
  const n = Math.max(0, Number(count) || 0);
  const suffix = n > 0 ? ` (${n} ф.)` : '';
  if (type === 'parseMetadataBatch') return `Разбор AST и триграмм${suffix}`;
  if (type === 'chunkVectorsBatch') return `Нарезка чанков векторов${suffix}`;
  if (type === 'syntaxCheckBatch') return `Проверка синтаксиса${suffix}`;
  if (type === 'auditFilesBatch' || type === 'auditFileBatch') return `Стресс-аудит кода${suffix}`;
  if (type === 'compressLogsBatch') return `Сжатие логов и JSON (Drain3)${suffix}`;
  if (type === 'foldCodeBatch') return `AST-свертка кода (Knapsack)${suffix}`;
  if (type === 'simhashIndexBatch') return `Индексация SimHash дублей${suffix}`;
  if (type === 'skimAstBatch') return `Скимминг AST-ветвей${suffix}`;
  return `Пакетная задача CPU${suffix}`;
}

export function beginCpuLiveWork({
  op = 'worker_batch',
  workers = 1,
  items = 0,
  detail = '',
  activityFile = CPU_LIVE_ACTIVITY_FILE,
} = {}) {
  const now = Date.now();
  const jobId = `${process.pid}-${now}-${Math.random().toString(36).slice(2, 7)}`;
  const targetFile = activityFile || CPU_LIVE_ACTIVITY_FILE;
  const targetDir = dirname(targetFile);
  try {
    if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
    updateJsonAtomicSync(targetFile, defaultCpuLiveState, (cur) => {
      const base = cur && typeof cur === 'object' ? cur : defaultCpuLiveState();
      const freshJobs = (Array.isArray(base.inFlight) ? base.inFlight : []).filter(
        (j) => j && j.id && (now - Number(j.startedAt || 0) < 90_000) && isProcessAliveSafe(j.pid)
      );
      freshJobs.push({
        id: jobId,
        pid: process.pid,
        op: String(op || 'worker_batch'),
        workers: clampInt(workers, 1, 64, 1),
        items: Math.max(0, Number(items) || 0),
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

export function endCpuLiveWork(
  jobId,
  { op = '', workers = 0, items = 0, detail = '', latencyMs = 0, activityFile = CPU_LIVE_ACTIVITY_FILE } = {}
) {
  const now = Date.now();
  const targetFile = activityFile || CPU_LIVE_ACTIVITY_FILE;
  const targetDir = dirname(targetFile);
  try {
    if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
    updateJsonAtomicSync(targetFile, defaultCpuLiveState, (cur) => {
      const base = cur && typeof cur === 'object' ? cur : defaultCpuLiveState();
      const prevJobs = Array.isArray(base.inFlight) ? base.inFlight : [];
      const finishedJob = prevJobs.find((j) => j && j.id === jobId) || null;
      const remaining = prevJobs.filter(
        (j) => j && j.id !== jobId && (now - Number(j.startedAt || 0) < 90_000) && isProcessAliveSafe(j.pid)
      );
      const elapsed = latencyMs > 0
        ? Number(Number(latencyMs).toFixed(2))
        : (finishedJob?.startedAt ? Math.max(1, now - Number(finishedJob.startedAt)) : 0);
      return {
        ...base,
        opSeq: Number(base.opSeq || 0) + 1,
        inFlight: remaining,
        lastCompletedAt: now,
        lastOp: String(op || finishedJob?.op || base.lastOp || ''),
        lastDetail: String(detail || finishedJob?.detail || base.lastDetail || '').slice(0, 96),
        lastWorkers: clampInt(workers || finishedJob?.workers || base.lastWorkers || 1, 1, 64, 1),
        lastItems: Math.max(0, Number(items || finishedJob?.items || base.lastItems || 0)),
        lastLatencyMs: elapsed,
      };
    });
  } catch {}
}

export function recordCpuInstantWork({
  op = 'cross_rerank',
  workers = 1,
  items = 0,
  detail = '',
  latencyMs = 0,
  activityFile = CPU_LIVE_ACTIVITY_FILE,
} = {}) {
  const now = Date.now();
  const targetFile = activityFile || CPU_LIVE_ACTIVITY_FILE;
  const targetDir = dirname(targetFile);
  try {
    if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
    updateJsonAtomicSync(targetFile, defaultCpuLiveState, (cur) => {
      const base = cur && typeof cur === 'object' ? cur : defaultCpuLiveState();
      const freshJobs = (Array.isArray(base.inFlight) ? base.inFlight : []).filter(
        (j) => j && j.id && (now - Number(j.startedAt || 0) < 90_000) && isProcessAliveSafe(j.pid)
      );
      return {
        ...base,
        opSeq: Number(base.opSeq || 0) + 1,
        inFlight: freshJobs,
        lastCompletedAt: now,
        lastOp: String(op || 'cross_rerank'),
        lastDetail: String(detail || '').slice(0, 96),
        lastWorkers: clampInt(workers, 1, 64, 1),
        lastItems: Math.max(0, Number(items) || 0),
        lastLatencyMs: Math.max(0, Number(Number(latencyMs || 0).toFixed(2)) || 0),
      };
    });
  } catch {}
}

export function getCpuLiveActivity({
  now = Date.now(),
  afterglowMs = 2800,
  activityFile = CPU_LIVE_ACTIVITY_FILE,
} = {}) {
  const targetFile = activityFile || CPU_LIVE_ACTIVITY_FILE;
  const localBusy = poolSingleton ? Number(poolSingleton.getStats().busyWorkers || 0) : 0;
  try {
    if (!existsSync(targetFile)) {
      return {
        inFlightCount: localBusy > 0 ? 1 : 0,
        activeThreads: localBusy,
        recentThreads: localBusy,
        activeJobs: [],
        isWorking: localBusy > 0,
        isAfterglow: false,
        afterglowRatio: localBusy > 0 ? 1 : 0,
        opSeq: 0,
        currentOp: '',
        currentDetail: '',
        currentItems: 0,
        lastCompletedAt: null,
        msSinceLast: null,
        lastLatencyMs: 0,
      };
    }
    const raw = safeReadJsonSync(targetFile, defaultCpuLiveState, { selfHeal: false }) || defaultCpuLiveState();
    const activeJobs = (Array.isArray(raw.inFlight) ? raw.inFlight : []).filter(
      (j) => j && j.id && (now - Number(j.startedAt || 0) < 90_000) && isProcessAliveSafe(j.pid)
    );
    const jobThreads = activeJobs.reduce((acc, j) => acc + Math.max(1, Number(j.workers || 1)), 0);
    const activeThreads = Math.min(64, Math.max(localBusy, jobThreads));
    const lastCompletedAt = Number(raw.lastCompletedAt || 0);
    const msSinceLast = lastCompletedAt > 0 ? Math.max(0, now - lastCompletedAt) : null;
    const isWorking = activeJobs.length > 0 || localBusy > 0;
    const isAfterglow = !isWorking && msSinceLast !== null && msSinceLast <= afterglowMs;
    const afterglowRatio = isWorking
      ? 1
      : (isAfterglow ? Number(Math.max(0, 1 - msSinceLast / afterglowMs).toFixed(3)) : 0);
    const headJob = activeJobs[activeJobs.length - 1] || null;
    const recentThreads = isWorking
      ? Math.max(1, activeThreads)
      : (isAfterglow ? Math.max(1, Number(raw.lastWorkers || 1)) : 0);
    return {
      inFlightCount: activeJobs.length,
      activeThreads,
      recentThreads,
      activeJobs,
      isWorking,
      isAfterglow,
      afterglowRatio,
      opSeq: Number(raw.opSeq || 0),
      currentOp: headJob?.op || raw.lastOp || '',
      currentDetail: headJob?.detail || raw.lastDetail || '',
      currentItems: headJob ? Number(headJob.items || 0) : Number(raw.lastItems || 0),
      lastCompletedAt: lastCompletedAt || null,
      msSinceLast,
      lastLatencyMs: Number(raw.lastLatencyMs || 0),
    };
  } catch {
    return {
      inFlightCount: 0,
      activeThreads: localBusy,
      recentThreads: localBusy,
      activeJobs: [],
      isWorking: localBusy > 0,
      isAfterglow: false,
      afterglowRatio: localBusy > 0 ? 1 : 0,
      opSeq: 0,
      currentOp: '',
      currentDetail: '',
      currentItems: 0,
      lastCompletedAt: null,
      msSinceLast: null,
      lastLatencyMs: 0,
    };
  }
}

/**
 * Executes a batch across the shared node:worker_threads pool, falling back inline for small batches.
 * @param {'parseMetadataBatch'|'chunkVectorsBatch'|'syntaxCheckBatch'} type
 * @param {Array<object>} items
 * @param {{ minItemsForWorkers?: number, maxWorkers?: number, skipTelemetry?: boolean, timeoutMs?: number, fallbackInlineOnError?: boolean }} [options={}]
 */
export async function runCpuBatch(
  type,
  items = [],
  { minItemsForWorkers = 25, maxWorkers = 0, skipTelemetry = false, timeoutMs = DEFAULT_WORKER_TASK_TIMEOUT_MS, fallbackInlineOnError = true } = {}
) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const t0 = performance.now();
  const cfg = loadCpuConfig();
  const rawBudget = resolveCpuThreadBudget(cfg);
  const budget = maxWorkers > 0 ? Math.min(rawBudget, maxWorkers) : Math.min(rawBudget, 8);
  const detailRu = describeCpuBatchDetailRu(type, items.length);
  const zeroCopyCount = items.reduce(
    (acc, item) => acc + (item && (item.sab instanceof SharedArrayBuffer || item.sab instanceof ArrayBuffer) ? 1 : 0),
    0
  );

  if (!isMainThread || !poolSingleton || !cfg.cpuMulticoreEnabled || budget <= 1 || items.length < minItemsForWorkers) {
    if (poolSingleton) poolSingleton.stats.inlineFallbacks += 1;
    const res = await runBatchTaskLocally(type, items);
    if (!skipTelemetry && (items.length >= 10 || zeroCopyCount > 0)) {
      const elapsedInline = Number((performance.now() - t0).toFixed(2));
      recordCpuTelemetryPatch((cur) => ({
        ...cur,
        ...(zeroCopyCount > 0 ? { zeroCopyTasks: (cur.zeroCopyTasks || 0) + zeroCopyCount } : {}),
        ...(items.length >= 10
          ? {
              lastBatchMs: elapsedInline,
              lastBatchType: `${type}:inline`,
            }
          : {}),
        lastAt: new Date().toISOString(),
      }));
      if (items.length >= 10) {
        recordCpuInstantWork({
          op: `${type}:inline`,
          workers: 1,
          items: items.length,
          detail: detailRu,
          latencyMs: elapsedInline,
        });
      }
    }
    return res;
  }

  const workerCount = Math.max(2, Math.min(budget, Math.ceil(items.length / 4)));
  const slices = [];
  for (let i = 0; i < workerCount; i++) {
    const start = Math.floor((i * items.length) / workerCount);
    const end = Math.floor(((i + 1) * items.length) / workerCount);
    if (end > start) {
      slices.push(items.slice(start, end));
    }
  }

  const liveTicket = !skipTelemetry
    ? beginCpuLiveWork({ op: type, workers: workerCount, items: items.length, detail: detailRu })
    : null;
  let elapsedMs = 0;
  try {
    poolSingleton.stats.batchesRun += 1;
    const partResults = await Promise.all(slices.map((chunk) => poolSingleton.submit(type, chunk, budget, timeoutMs)));
    const flat = partResults.flat();
    elapsedMs = Number((performance.now() - t0).toFixed(2));
    if (!skipTelemetry) {
      recordCpuTelemetryPatch((cur) => ({
        ...cur,
        workerBatches: (cur.workerBatches || 0) + 1,
        workerItemsProcessed: (cur.workerItemsProcessed || 0) + items.length,
        zeroCopyTasks: (cur.zeroCopyTasks || 0) + zeroCopyCount,
        peakWorkersUsed: Math.max(cur.peakWorkersUsed || 0, workerCount),
        lastBatchMs: elapsedMs,
        lastBatchType: type,
        lastAt: new Date().toISOString(),
      }));
    }
    return flat;
  } catch (err) {
    if (err?.isWorkerTimeout || /timed out/i.test(err?.message || '') || fallbackInlineOnError === false) {
      throw err;
    }
    poolSingleton.stats.inlineFallbacks += 1;
    const fallbackRes = await runBatchTaskLocally(type, items);
    if (!skipTelemetry && zeroCopyCount > 0) {
      recordCpuTelemetryPatch((cur) => ({
        ...cur,
        zeroCopyTasks: (cur.zeroCopyTasks || 0) + zeroCopyCount,
        lastAt: new Date().toISOString(),
      }));
    }
    return fallbackRes;
  } finally {
    if (liveTicket) {
      const finalMs = elapsedMs > 0 ? elapsedMs : Number((performance.now() - t0).toFixed(2));
      endCpuLiveWork(liveTicket.jobId, {
        op: type,
        workers: workerCount,
        items: items.length,
        detail: detailRu,
        latencyMs: finalMs,
      });
    }
  }
}

export function getCpuStatusSnapshot(stateOverride = {}, extraStats = {}) {
  const cfg = loadCpuConfig(stateOverride);
  const cpus = os.cpus() || [];
  const logicalCores = Math.max(1, cpus.length);
  const effectiveMaxThreads = resolveCpuThreadBudget(cfg);
  return {
    config: cfg,
    hardware: {
      model: String(cpus[0]?.model || 'Unknown CPU').trim(),
      logicalCores,
      effectiveMaxThreads,
      vramUsedMb: 0,
    },
    pool: getCpuPoolStats(),
    telemetry: readCpuTelemetry(),
    liveActivity: getCpuLiveActivity(),
    ...extraStats,
  };
}

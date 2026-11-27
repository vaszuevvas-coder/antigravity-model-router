#!/usr/bin/env node
/**
 * @file ram-memory-mcp.mjs
 * @description Persistent Stdio MCP Server + Localhost Loopback IPC Daemon for In-RAM Project Memory (adaptive up to 32 GB).
 * Zero external dependencies; exposes ram_search, ram_slice, ram_context_pack, ram_warm_workspace, ram_stats
 * and serves sub-millisecond RAM queries to hook-runner.mjs via 127.0.0.1.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import http from 'node:http';
import * as nodeModule from 'node:module';
import os from 'node:os';
import path, { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeMaxRamBudgetMb } from './hardware-profiler.mjs';
import { enrichMultiTurnChatQuery, RamMemoryEngine } from './ram-memory-engine.mjs';
import {
  distillLocalFile,
  distillText,
  enforceVramCapInOllama,
  ensureEmbedModelWarm,
  ensureOllamaRunning,
  evaluateGpuThermalAndLoadGuard,
  getGpuStatusSnapshot,
  indexSingleFileVector,
  indexSkillVectors,
  indexWorkspaceVectors,
  isLocalChatActive,
  loadGpuConfig,
  matchSkillsAi,
  peekWarmSemanticBundle,
  peekWarmSemanticSkills,
  peekWarmSemanticTargets,
  probeNvidiaGpu,
  runLocalProjectChat,
  unloadAllModels,
  unloadModelsOnAppExit,
  warmGgufModelsInHostRam,
} from './local-gpu-engine.mjs';
import * as localGpuNs from './local-gpu-engine.mjs';
import { atomicWriteJsonSync, safeReadJsonSync, updateJsonAtomicSync } from './safe-json.mjs';
import { getCpuStatusSnapshot } from './cpu-worker-pool.mjs';
import { canonicalizeJson } from './toon-formatter.mjs';
import { lspBridge } from './lsp-bridge.mjs';
import { isEphemeralTestWorkspace } from './session-handoff.mjs';
import { buildProjectGraphPayload, buildFileSymbolGraphPayload, aggregateSemanticGraphHits } from './project-graph-builder.mjs';
import { knowledgeHub } from './sqlite-knowledge-hub.mjs';
import { runAutomatedGitBisect } from './runtime-wiretap.mjs';
import { runSemanticMutationGuard } from './cpu-mutation-guard.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, '..');
const CACHE_DIR = join(PLUGIN_ROOT, '.cache');
const STATE_FILE = join(PLUGIN_ROOT, 'router-state.json');
const DAEMON_INFO_FILE = join(CACHE_DIR, 'ram-daemon.json');
const SENTINEL_MODULE_PATH = join(__dirname, 'background-sentinel.mjs');
const MAX_HTTP_BODY_BYTES = 8 * 1024 * 1024;

try {
  if (typeof nodeModule.enableCompileCache === 'function') {
    nodeModule.enableCompileCache(join(CACHE_DIR, 'v8-compile-cache'));
  }
} catch {}

let loadedSentinel = null;
let sentinelImportPromise = null;
let lastSentinelFailAt = 0;

function ensureSentinelLoaded() {
  if (loadedSentinel) return Promise.resolve(loadedSentinel);
  if (sentinelImportPromise) return sentinelImportPromise;
  if (Date.now() - lastSentinelFailAt < 500) return Promise.resolve(null);
  if (!existsSync(SENTINEL_MODULE_PATH)) return Promise.resolve(null);
  sentinelImportPromise = import('./background-sentinel.mjs')
    .then((mod) => {
      loadedSentinel = mod?.sentinel || null;
      if (!loadedSentinel) lastSentinelFailAt = Date.now();
      return loadedSentinel;
    })
    .catch(() => {
      lastSentinelFailAt = Date.now();
      return null;
    })
    .finally(() => {
      sentinelImportPromise = null;
    });
  return sentinelImportPromise;
}

try {
  if (existsSync(SENTINEL_MODULE_PATH)) {
    ({ sentinel: loadedSentinel } = await import('./background-sentinel.mjs'));
  }
} catch {}

function isPidAlive(pid) {
  const num = Number(pid);
  if (!Number.isInteger(num) || num <= 0) return false;
  try {
    process.kill(num, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

export function loadRamSettings() {
  const activeStateFile =
    typeof process.env.TUNNEL_TEST_STATE_PATH === 'string' && process.env.TUNNEL_TEST_STATE_PATH.trim()
      ? path.resolve(process.env.TUNNEL_TEST_STATE_PATH.trim())
      : STATE_FILE;
  const rawSt = safeReadJsonSync(activeStateFile, () => ({}), { selfHeal: false });
  const st = rawSt && typeof rawSt === 'object' && !Array.isArray(rawSt) ? rawSt : {};
  const rawEnvProf = typeof process.env.TUNNEL_HOOK_PROFILE === 'string' ? process.env.TUNNEL_HOOK_PROFILE.trim().toLowerCase() : '';
  const rawStateProf = typeof st.hookProfile === 'string' ? st.hookProfile.trim().toLowerCase() : '';
  const effectiveProfile = (rawEnvProf === 'minimal' || rawEnvProf === 'standard' || rawEnvProf === 'strict')
    ? rawEnvProf
    : ((rawStateProf === 'minimal' || rawStateProf === 'standard' || rawStateProf === 'strict') ? rawStateProf : 'standard');
  const totalRamMb = Math.max(1024, Math.round(os.totalmem() / (1024 * 1024)));
  const maxRamMb = computeMaxRamBudgetMb(totalRamMb);
  const rawMb = Number(st.ramMaxBudgetMb) || Math.min(4096, maxRamMb);
  return {
    enabled: st.ramCacheEnabled !== false,
    budgetMb: Math.max(512, Math.min(maxRamMb, rawMb)),
    autoWarm: st.ramAutoWarmOnSessionStart !== false,
    ramSotaEngines: st.ramSotaEngines !== false,
    gpuWarmHostRamCache: st.gpuWarmHostRamCache !== false,
    lspBridgeEnabled: effectiveProfile === 'strict' ? true : st.lspBridgeEnabled !== false,
    sqliteKnowledgeEnabled: st.sqliteKnowledgeEnabled !== false,
    federatedWorkspaces: Array.isArray(st.federatedWorkspaces) ? st.federatedWorkspaces : [],
  };
}

const initialSettings = loadRamSettings();
const engine = new RamMemoryEngine({
  budgetMb: initialSettings.budgetMb,
  onFileUpsert: (wsAbsRoot, entry) => {
    try {
      const sentinel = loadedSentinel;
      if (sentinel) {
        sentinel?.notifyFileChanged?.(wsAbsRoot, entry?.relPath || '', engine);
      } else {
        void ensureSentinelLoaded().then((s) => {
          try { s?.notifyFileChanged?.(wsAbsRoot, entry?.relPath || '', engine); } catch {}
        });
      }
    } catch {}
    scheduleDebouncedFileReindex(wsAbsRoot, entry);
  },
});
const ipcToken = randomBytes(16).toString('hex');
const warmingWorkspaces = new Set();
const MAX_REGISTERED_WORKSPACES = 32;
const MAX_GPU_WARM_COOLDOWN = 64;
const registeredWorkspaces = new Map();
const gpuWarmCooldown = new Map();
const activeGpuWarmTimers = new Set();
const debouncedReindexTimers = new Map();
let daemonShuttingDown = false;
let activeChatIpcCount = 0;
let ipcPort = 0;
let ipcStartedAt = '';
let useContentLengthFraming = false;
let stdioClientWorkspace = '';
let latestActiveWorkspace = '';

function normWsKey(p) {
  try {
    const abs = path.resolve(String(p || '.'));
    return process.platform === 'win32' ? abs.toLowerCase() : abs;
  } catch {
    return String(p || '');
  }
}

function parseClientRootCandidate(raw) {
  if (!raw || typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  try {
    const resolved = trimmed.startsWith('file://')
      ? path.resolve(fileURLToPath(trimmed))
      : path.resolve(trimmed);
    return existsSync(resolved) ? resolved : '';
  } catch {
    return '';
  }
}

export function isEphemeralOrScratchWorkspace(wsPath = '') {
  if (!wsPath || typeof wsPath !== 'string') return false;
  const norm = wsPath.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  if (!norm) return false;
  return (
    norm.includes('/.gemini/antigravity/brain/') ||
    norm.endsWith('/.gemini/antigravity/brain') ||
    norm.includes('/.gemini/antigravity-ide/brain/') ||
    norm.endsWith('/.gemini/antigravity-ide/brain') ||
    norm.includes('/.gemini/antigravity-cli/brain/') ||
    norm.endsWith('/.gemini/antigravity-cli/brain') ||
    norm.includes('/browser_sandbox')
  );
}

export function extractClientRootFromInitialize(params = {}) {
  const opts = params && typeof params === 'object' ? params : {};
  const candidates = [
    opts.workspaceFolders?.[0]?.uri,
    opts.workspaceFolders?.[0]?.path,
    opts.roots?.[0]?.uri,
    opts.roots?.[0]?.path,
    opts.rootUri,
    opts.rootPath,
  ];
  for (const cand of candidates) {
    const resolved = parseClientRootCandidate(cand);
    if (resolved && !isEphemeralOrScratchWorkspace(resolved)) {
      stdioClientWorkspace = resolved;
      latestActiveWorkspace = resolved;
      registerDaemonWorkspace(resolved);
      return resolved;
    }
  }
  return '';
}

export function resetStdioClientWorkspaceForTest(ws = '') {
  const next = ws ? path.resolve(ws) : '';
  stdioClientWorkspace = next;
  latestActiveWorkspace = next;
}

export function resolveDefaultWorkspace(explicitWs, targetRelFile = '') {
  if (explicitWs && typeof explicitWs === 'string' && explicitWs.trim()) {
    return path.resolve(explicitWs.trim());
  }
  const cwd = process.cwd();
  let primary = cwd;
  if (latestActiveWorkspace && existsSync(latestActiveWorkspace) && !isEphemeralOrScratchWorkspace(latestActiveWorkspace)) {
    primary = latestActiveWorkspace;
  } else if (stdioClientWorkspace && existsSync(stdioClientWorkspace) && !isEphemeralOrScratchWorkspace(stdioClientWorkspace)) {
    primary = stdioClientWorkspace;
  } else if ((normWsKey(cwd) === normWsKey(PLUGIN_ROOT) || isEphemeralOrScratchWorkspace(cwd)) && registeredWorkspaces.size > 0) {
    const pluginNorm = normWsKey(PLUGIN_ROOT);
    let latestUserWs = '';
    let latestAnyWs = '';
    for (const [k, absPath] of registeredWorkspaces.entries()) {
      if (isEphemeralOrScratchWorkspace(absPath) || isEphemeralTestWorkspace(absPath)) continue;
      latestAnyWs = absPath;
      if (k !== pluginNorm) latestUserWs = absPath;
    }
    if (latestUserWs) primary = latestUserWs;
    else if (latestAnyWs) primary = latestAnyWs;
  }

  if (targetRelFile && typeof targetRelFile === 'string' && targetRelFile.trim() && !path.isAbsolute(targetRelFile)) {
    const cleanRel = targetRelFile.trim();
    const primaryTarget = path.resolve(primary, cleanRel);
    const primaryRel = path.relative(primary, primaryTarget);
    const existsInPrimary = !primaryRel.startsWith('..') && !path.isAbsolute(primaryRel) && existsSync(primaryTarget);
    if (!existsInPrimary && registeredWorkspaces.size > 0) {
      for (const candWs of Array.from(registeredWorkspaces.values()).reverse()) {
        if (isEphemeralOrScratchWorkspace(candWs)) continue;
        const candTarget = path.resolve(candWs, cleanRel);
        const candRel = path.relative(candWs, candTarget);
        if (!candRel.startsWith('..') && !path.isAbsolute(candRel) && existsSync(candTarget)) {
          return candWs;
        }
      }
    }
  }

  return primary;
}

function writeDaemonRegistration() {
  if (!ipcPort) return;
  try {
    if (!existsSync(CACHE_DIR)) {
      mkdirSync(CACHE_DIR, { recursive: true });
    }
    const entry = {
      pid: process.pid,
      port: ipcPort,
      token: ipcToken,
      budgetMb: engine.budgetMb,
      startedAt: ipcStartedAt,
      workspaces: Array.from(registeredWorkspaces.values()),
    };
    updateJsonAtomicSync(DAEMON_INFO_FILE, () => ({ instances: {} }), (cur) => {
      const prevInst = cur?.instances && typeof cur.instances === 'object' ? cur.instances : {};
      const nextInst = {};
      for (const [k, v] of Object.entries(prevInst)) {
        if (v && isPidAlive(v.pid)) {
          nextInst[k] = v;
        }
      }
      nextInst[String(process.pid)] = entry;
      return {
        ...entry,
        instances: nextInst,
      };
    });
    try {
      chmodSync(DAEMON_INFO_FILE, 0o600);
    } catch {}
  } catch {}
}

export function registerDaemonWorkspace(wsRoot, options = {}) {
  if (!wsRoot || typeof wsRoot !== 'string') return;
  try {
    const abs = path.resolve(wsRoot);
    if (isEphemeralOrScratchWorkspace(abs)) return;
    const makeActive = options?.makeActive !== false;
    const norm = normWsKey(abs);
    const prevLastKey = registeredWorkspaces.size > 0 ? Array.from(registeredWorkspaces.keys()).pop() : '';
    if (registeredWorkspaces.has(norm)) {
      if (makeActive) {
        // Refresh recency order in Map and persist if LRU tail changed
        registeredWorkspaces.delete(norm);
        registeredWorkspaces.set(norm, abs);
        if (prevLastKey !== norm) {
          writeDaemonRegistration();
        }
      }
    } else {
      if (makeActive) {
        registeredWorkspaces.set(norm, abs);
      } else {
        const prevEntries = Array.from(registeredWorkspaces.entries());
        registeredWorkspaces.clear();
        registeredWorkspaces.set(norm, abs);
        for (const [k, v] of prevEntries) {
          registeredWorkspaces.set(k, v);
        }
      }
      while (registeredWorkspaces.size > MAX_REGISTERED_WORKSPACES) {
        const oldestKey = registeredWorkspaces.keys().next().value;
        if (oldestKey === undefined) break;
        registeredWorkspaces.delete(oldestKey);
      }
      writeDaemonRegistration();
    }
    if (makeActive && !isEphemeralTestWorkspace(abs)) {
      latestActiveWorkspace = abs;
    }
  } catch {}
}

function refreshBudgetFromState() {
  const st = loadRamSettings();
  if (!st.enabled && engine.workspaces.size > 0) {
    engine.evict('all');
    if (ipcPort > 0) {
      writeDaemonRegistration();
    }
  }
  if (st.budgetMb !== engine.budgetMb) {
    engine.setBudgetMb(st.budgetMb);
    if (ipcPort > 0) {
      writeDaemonRegistration();
    }
  }
  return st;
}

const inFlightGpuWarm = new Map();

function warmWorkspaceVectorsOnce(absRoot, filesMap, { maxNewFiles = 300, includeSkills = false, ensureEmbed = false } = {}) {
  const key = normWsKey(absRoot);
  if (inFlightGpuWarm.has(key)) {
    return inFlightGpuWarm.get(key);
  }
  const p = (async () => {
    const vectorPromise = indexWorkspaceVectors(absRoot, filesMap, { maxNewFiles });
    if (includeSkills) {
      const [resWarm, skillIndex] = await Promise.all([
        vectorPromise,
        indexSkillVectors({ wsAbsRoot: absRoot }).catch((err) => ({ ok: false, error: err?.message || 'skill index error' })),
      ]);
      if (ensureEmbed && resWarm?.ok && resWarm.cached) {
        await ensureEmbedModelWarm({ minFreeVramMb: 1500 });
      }
      return { ...resWarm, skillIndex };
    }
    const resWarm = await vectorPromise;
    if (ensureEmbed && resWarm?.ok && resWarm.cached) {
      await ensureEmbedModelWarm({ minFreeVramMb: 1500 });
    }
    return resWarm;
  })().finally(() => {
    if (inFlightGpuWarm.get(key) === p) {
      inFlightGpuWarm.delete(key);
    }
  });
  inFlightGpuWarm.set(key, p);
  return p;
}

const fallbackMemoMap = new Map();
const FALLBACK_MEMO_MAX = 600;
const fallbackRepairMap = new Map();
const FALLBACK_REPAIR_MAX = 120;

function normalizeRelForMemo(wsPath = '', filePath = '') {
  const raw = String(filePath || '').trim();
  if (!raw) return '';
  let rel = raw;
  try {
    if (wsPath) {
      const absRoot = path.resolve(String(wsPath));
      const absFile = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(absRoot, raw);
      const r = path.relative(absRoot, absFile);
      if (r && !r.startsWith('..') && !path.isAbsolute(r)) rel = r;
    }
  } catch {}
  const posix = rel.replace(/\\/g, '/').replace(/^\.\//, '');
  return process.platform === 'win32' ? posix.toLowerCase() : posix;
}

function fallbackCheckMemo({ convoId = 'default', epoch = 0, toolName = '', targetKey = '', currentSha1 = '', stepIdx = -1 } = {}) {
  const key = `${String(convoId || 'default')}|${Number(epoch || 0)}|${String(toolName || '')}|${String(targetKey || '')}`;
  const entry = fallbackMemoMap.get(key);
  if (!entry || entry.contentSha1 !== String(currentSha1 || '')) {
    return { hit: false, retryBypass: false };
  }
  const sIdx = Number.isFinite(Number(stepIdx)) ? Number(stepIdx) : -1;
  if ((sIdx >= 0 && entry.lastBypassCheckStep === sIdx) || (sIdx < 0 && Date.now() - (entry.lastHitTs || 0) < 1800)) {
    fallbackMemoMap.delete(key);
    return { hit: false, retryBypass: true };
  }
  entry.lastHitTs = Date.now();
  entry.lastBypassCheckStep = sIdx;
  fallbackMemoMap.delete(key);
  fallbackMemoMap.set(key, entry);
  return {
    hit: true,
    savedChars: entry.charLen,
    memoNotice: `⚡ [RAM Context Memo] Unchanged ${toolName} (${targetKey}) already in active context (sha1:${String(currentSha1).slice(0, 8)}). Re-call immediately if full raw dump is required.`,
  };
}

function fallbackRecordMemo({ convoId = 'default', epoch = 0, toolName = '', targetKey = '', contentSha1 = '', charLen = 0, stepIdx = -1, fileDeps = [] } = {}) {
  const key = `${String(convoId || 'default')}|${Number(epoch || 0)}|${String(toolName || '')}|${String(targetKey || '')}`;
  const sIdx = Number.isFinite(Number(stepIdx)) ? Number(stepIdx) : -1;
  fallbackMemoMap.delete(key);
  fallbackMemoMap.set(key, {
    contentSha1: String(contentSha1 || ''),
    stepIdx: sIdx,
    lastHitTs: 0,
    lastBypassCheckStep: -1,
    charLen: Math.max(0, Number(charLen || 0)),
    fileDeps: Array.isArray(fileDeps) ? fileDeps : [],
  });
  while (fallbackMemoMap.size > FALLBACK_MEMO_MAX) {
    const oldest = fallbackMemoMap.keys().next().value;
    if (oldest === undefined) break;
    fallbackMemoMap.delete(oldest);
  }
}

function fallbackInvalidateObservationFile(wsPath = '', filePath = '') {
  const normRel = normalizeRelForMemo(wsPath, filePath);
  if (!normRel) return;
  const base = path.posix.basename(normRel);
  for (const [key, entry] of fallbackMemoMap.entries()) {
    const parts = key.split('|');
    const targetRaw = parts.slice(3).join('|').replace(/\\/g, '/');
    const targetCmp = process.platform === 'win32' ? targetRaw.toLowerCase() : targetRaw;
    const touchesTarget = targetCmp === normRel || targetCmp.endsWith(`/${base}`) || targetCmp === base;
    const touchesDep = Array.isArray(entry?.fileDeps) && entry.fileDeps.some((d) => {
      const dc = normalizeRelForMemo(wsPath, d);
      return dc === normRel || dc === base || dc.endsWith(`/${base}`);
    });
    if (touchesTarget || touchesDep) {
      fallbackMemoMap.delete(key);
    }
  }
}

function fallbackArchiveCompactionFacts({ convoId = 'default', wsPath = '', rawText = '', steps = [] } = {}) {
  const cid = String(convoId || 'default');
  const wsKey = wsPath ? normWsKey(wsPath) : '';
  const bucketKey = `${cid}|${wsKey}`;
  const prev = fallbackRepairMap.get(bucketKey) || [];
  const seen = new Set(prev.map((x) => x.text));
  const candidates = [];
  const textStr = typeof rawText === 'string' ? rawText : '';
  for (const line of textStr.split(/\r?\n/)) {
    const clean = line.replace(/^[-*#>\s]+/, '').trim();
    if (clean.length >= 6 && !/^```/.test(clean)) candidates.push(clean);
  }
  if (Array.isArray(steps)) {
    for (const st of steps) {
      const content = typeof st?.content === 'string' ? st.content.trim() : '';
      if (content.length >= 8) candidates.push(content.slice(0, 180));
    }
  }
  const now = Date.now();
  for (const itemText of candidates) {
    if (seen.has(itemText)) continue;
    seen.add(itemText);
    prev.push({ text: itemText.slice(0, 220), lower: itemText.toLowerCase(), ts: now });
  }
  if (prev.length > FALLBACK_REPAIR_MAX) {
    prev.splice(0, prev.length - FALLBACK_REPAIR_MAX);
  }
  fallbackRepairMap.set(bucketKey, prev);
}

function fallbackRecallCompactionFacts({ convoId = 'default', wsPath = '', query = '', topK = 3 } = {}) {
  const cid = String(convoId || 'default');
  const wsKey = wsPath ? normWsKey(wsPath) : '';
  const exactBucket = fallbackRepairMap.get(`${cid}|${wsKey}`) || [];
  const genericBucket = wsKey ? (fallbackRepairMap.get(`${cid}|`) || []) : [];
  const pool = exactBucket.length > 0 ? [...exactBucket, ...genericBucket] : genericBucket;
  if (pool.length === 0) return { recalled: [], formattedHint: '' };

  const tokens = String(query || '').toLowerCase().match(/[a-zа-яё0-9_./-]{2,}/gi) || [];
  if (tokens.length === 0) return { recalled: [], formattedHint: '' };
  const uniqTokens = Array.from(new Set(tokens));
  const scored = [];
  for (let i = 0; i < pool.length; i++) {
    const item = pool[i];
    let score = 0;
    for (const tok of uniqTokens) {
      if (item.lower.includes(tok)) score += 1;
    }
    if (score > 0) scored.push({ item, score, idx: i });
  }
  if (scored.length === 0) return { recalled: [], formattedHint: '' };
  scored.sort((a, b) => (b.score - a.score) || (b.idx - a.idx));
  const top = scored.slice(0, Math.max(1, Number(topK || 3))).map((s) => s.item.text);
  const body = top.join(' | ');
  const formattedHint = `🔧 [RAM RepairKV Recall] ${body}`.slice(0, 550);
  return { recalled: top, formattedHint };
}

function scheduleBackgroundGpuWarm(wsPath, delayMs = 200) {
  if (!wsPath || daemonShuttingDown) return;
  try {
    const st = loadRamSettings();
    const gpuCfg = loadGpuConfig();
    if (!gpuCfg.gpuEnabled) return;
    const absRoot = path.resolve(wsPath);
    const key = process.platform === 'win32' ? absRoot.toLowerCase() : absRoot;
    const now = Date.now();
    const lastTs = gpuWarmCooldown.get(key) || 0;
    if ((now - lastTs) < 120_000) return;
    if (gpuWarmCooldown.has(key)) gpuWarmCooldown.delete(key);
    gpuWarmCooldown.set(key, now);
    while (gpuWarmCooldown.size > MAX_GPU_WARM_COOLDOWN) {
      const oldestKey = gpuWarmCooldown.keys().next().value;
      if (oldestKey === undefined) break;
      gpuWarmCooldown.delete(oldestKey);
    }

    if (st.ramSotaEngines !== false && st.gpuWarmHostRamCache !== false && typeof localGpuNs?.warmGgufModelsInHostRam === 'function') {
      const hostTimer = setTimeout(() => {
        activeGpuWarmTimers.delete(hostTimer);
        if (daemonShuttingDown) return;
        localGpuNs.warmGgufModelsInHostRam().catch(() => {});
      }, 1800);
      if (typeof hostTimer?.unref === 'function') hostTimer.unref();
      activeGpuWarmTimers.add(hostTimer);
    }

    const timer = setTimeout(async () => {
      activeGpuWarmTimers.delete(timer);
      if (daemonShuttingDown || !registeredWorkspaces.has(key)) return;
      try {
        const hw = probeNvidiaGpu();
        const bgGuard = evaluateGpuThermalAndLoadGuard(hw, { isBackground: true });
        if (bgGuard.throttled) return;
        if (hw?.available && hw.freeMb < 1500) return;
        const ready = await ensureOllamaRunning(gpuCfg);
        if (!ready?.ok || daemonShuttingDown) return;
        await enforceVramCapInOllama({ cfgOverride: gpuCfg }).catch(() => {});
        if (!gpuCfg.gpuSemanticSearch || daemonShuttingDown) return;
        await indexSkillVectors({ cfgOverride: gpuCfg }).catch(() => {});
        if (daemonShuttingDown || !registeredWorkspaces.has(key)) return;
        const ws = await engine.warmWorkspaceAsync(absRoot);
        if (ws && ws.files.size > 0 && !daemonShuttingDown) {
          await warmWorkspaceVectorsOnce(ws.absRoot, ws.files, { maxNewFiles: 180, ensureEmbed: true });
        }
      } catch {}
    }, delayMs);
    if (typeof timer.unref === 'function') timer.unref();
    activeGpuWarmTimers.add(timer);
  } catch {}
}

function scheduleDebouncedFileReindex(wsAbsRoot, entry, targetEngine = engine, deferCount = 0) {
  if (!wsAbsRoot || !entry?.relPath || !entry?.buf) return;
  try {
    const wsKey = normWsKey(wsAbsRoot);
    const relPath = entry.relPath;
    const key = `${wsKey}::${relPath}`;
    const prev = debouncedReindexTimers.get(key);
    if (prev) clearTimeout(prev);

    if (debouncedReindexTimers.size >= 64) {
      for (const timerHandle of debouncedReindexTimers.values()) {
        try { clearTimeout(timerHandle); } catch {}
      }
      debouncedReindexTimers.clear();
      scheduleBackgroundGpuWarm(wsAbsRoot, 2500);
      return;
    }

    const scheduleTick = (delayMs, attempt) => {
      const timer = setTimeout(async () => {
        debouncedReindexTimers.delete(key);
        try {
          if ((isLocalChatActive() || activeChatIpcCount > 0) && attempt < 4) {
            scheduleTick(2000, attempt + 1);
            return;
          }
          const ws = targetEngine?.workspaces?.get(wsKey);
          const liveEntry = ws?.files?.get(relPath) || entry;
          if (!liveEntry?.buf) return;
          await indexSingleFileVector(wsAbsRoot, relPath, liveEntry.buf);
        } catch {}
      }, delayMs);
      if (typeof timer.unref === 'function') timer.unref();
      debouncedReindexTimers.set(key, timer);
    };

    scheduleTick(1500, deferCount);
  } catch {}
}

function scheduleWarm(wsPath) {
  if (!wsPath || typeof wsPath !== 'string') return;
  let absPath = '';
  try {
    absPath = path.resolve(wsPath);
  } catch {
    return;
  }
  const key = normWsKey(absPath);
  if (!key || warmingWorkspaces.has(key)) return;
  warmingWorkspaces.add(key);
  setImmediate(async () => {
    try {
      refreshBudgetFromState();
      await engine.warmWorkspaceAsync(absPath);
      scheduleBackgroundGpuWarm(absPath, 400);
    } catch (err) {
      process.stderr.write(`[ram-memory] warm error: ${err.message}\n`);
    } finally {
      warmingWorkspaces.delete(key);
    }
  });
}

// --- Localhost Loopback IPC Bridge for hook-runner.mjs & sidecar ---
function readHttpJson(req, res) {
  return new Promise((resolve) => {
    const chunks = [];
    let totalBytes = 0;
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };

    req.on('data', (chunk) => {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      totalBytes += buf.length;
      if (totalBytes > MAX_HTTP_BODY_BYTES) {
        if (res && !res.headersSent) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Payload too large (max 8MB)' }));
        }
        try { req.destroy(); } catch {}
        finish(null);
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => {
      if (settled) return;
      try {
        const raw = chunks.length > 0 ? Buffer.concat(chunks, totalBytes).toString('utf8') : '';
        finish(raw ? JSON.parse(raw) : {});
      } catch {
        finish({});
      }
    });
    req.on('error', () => finish({}));
  });
}

function isValidIpcToken(provided) {
  if (typeof provided !== 'string' || !provided) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(ipcToken, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function finalizePreInvocationHint(baseHint = '', repairKvHint = '', sentinelAlert = '') {
  let hint = String(baseHint || '');
  if (repairKvHint) {
    const maxHintLen = 2100;
    if (!hint) {
      hint = repairKvHint.slice(0, 1800);
    } else if (hint.length + 1 + repairKvHint.length <= maxHintLen) {
      hint = `${hint}\n${repairKvHint}`;
    } else {
      const availBase = Math.max(600, maxHintLen - repairKvHint.length - 1);
      hint = `${hint.slice(0, availBase)}\n${repairKvHint.slice(0, maxHintLen - availBase - 1)}`;
    }
  }
  if (sentinelAlert) {
    const cleanAlert = String(sentinelAlert).trim().slice(0, 450);
    if (cleanAlert) {
      const maxTotal = 2400;
      if (!hint) {
        hint = cleanAlert;
      } else if (hint.length + 1 + cleanAlert.length <= maxTotal) {
        hint = `${hint}\n${cleanAlert}`;
      } else {
        const availBeforeAlert = Math.max(400, maxTotal - cleanAlert.length - 1);
        hint = `${hint.slice(0, availBeforeAlert)}\n${cleanAlert}`;
      }
    }
  }
  return hint;
}

export async function dispatchIpcRoute(method, url, body = {}, opts = {}) {
  const targetEngine = opts.engine || engine;
  const st = opts.settings || refreshBudgetFromState();
  const sentinel = opts.sentinel !== undefined ? opts.sentinel : (loadedSentinel || await ensureSentinelLoaded());

  if (method === 'GET' && url === '/health') {
    let sentinelSnap = null;
    if (sentinel && typeof sentinel.getStatusSnapshot === 'function') {
      try {
        sentinelSnap = await sentinel.getStatusSnapshot(resolveDefaultWorkspace(''), targetEngine);
      } catch {
        sentinelSnap = null;
      }
    }
    return {
      status: 200,
      body: {
        ok: true,
        pid: process.pid,
        stats: targetEngine.getStats(),
        cpu: getCpuStatusSnapshot(),
        sentinel: sentinelSnap,
      },
    };
  }

  if ((method === 'GET' || method === 'POST') && (url === '/sentinel/status' || url.startsWith('/sentinel/status?'))) {
    let queryWs = '';
    if (url.includes('?')) {
      try {
        queryWs = new URL(url, 'http://127.0.0.1').searchParams.get('wsPath') || '';
      } catch {}
    }
    const wsPath = resolveDefaultWorkspace(body?.wsPath || queryWs);
    if (!sentinel || typeof sentinel.getStatusSnapshot !== 'function') {
      return { status: 200, body: { ok: false, error: 'Sentinel unavailable' } };
    }
    try {
      const snap = await sentinel.getStatusSnapshot(wsPath, targetEngine);
      return { status: 200, body: snap };
    } catch (err) {
      return { status: 200, body: { ok: false, error: err?.message || 'Sentinel status failed' } };
    }
  }

  if (method === 'POST' && url === '/sentinel/action') {
    const wsPath = resolveDefaultWorkspace(body?.wsPath);
    if (!sentinel || typeof sentinel.runAction !== 'function') {
      return { status: 200, body: { ok: false, error: 'Sentinel unavailable' } };
    }
    try {
      const res = await sentinel.runAction({ ...body, wsPath, ramEngine: targetEngine });
      return { status: 200, body: res };
    } catch (err) {
      return { status: 200, body: { ok: false, error: err?.message || 'Sentinel action failed' } };
    }
  }

  if (method === 'POST' && url === '/hook/session-start') {
    const wsPath = body.wsPath || '';
    const maxChars = Number(body.maxChars || 12000);
    if (!st.enabled || !wsPath) return { status: 200, body: { ok: false } };

    registerDaemonWorkspace(wsPath);
    const ws = targetEngine.getOrCreateWorkspace(wsPath);
    if (ws && ws.files.size > 0) {
      scheduleBackgroundGpuWarm(wsPath, 250);
      const tMap0 = performance.now();
      const map = targetEngine.getFastRepoMap(wsPath, maxChars);
      targetEngine.recordCompletedOp?.('session_repomap', {
        target: path.basename(wsPath),
        latencyMs: performance.now() - tMap0,
      });
      return { status: 200, body: { ok: true, warm: true, repoMapMarkdown: map?.markdown || '', files: ws.files.size } };
    }
    if (st.autoWarm) scheduleWarm(wsPath);
    return { status: 200, body: { ok: true, warm: false, warming: true } };
  }

  if (method === 'POST' && url === '/warm') {
    const wsPath = resolveDefaultWorkspace(body?.wsPath);
    if (!st.enabled || !wsPath) {
      return { status: 200, body: { ok: false, error: !st.enabled ? 'RAM cache disabled' : 'Invalid workspace' } };
    }
    registerDaemonWorkspace(wsPath);
    refreshBudgetFromState();
    const warmRes = await targetEngine.warmWorkspaceAsync(wsPath);
    if (!warmRes?.ok) {
      return { status: 200, body: { ok: false, error: 'Failed to warm workspace', filesLoaded: 0, filesCached: 0 } };
    }
    scheduleBackgroundGpuWarm(wsPath, 400);
    return {
      status: 200,
      body: {
        ok: true,
        workspace: warmRes.workspace || wsPath,
        filesLoaded: Number(warmRes.filesLoaded || 0),
        filesCached: Number(warmRes.filesLoaded || 0),
        symbolsCount: Number(warmRes.symbolsCount || 0),
        usedMb: Number(warmRes.usedMb || 0),
      },
    };
  }

  if (method === 'POST' && url === '/hook/memo-check') {
    if (!st.enabled || st.ramSotaEngines === false) {
      return { status: 200, body: { ok: true, hit: false, retryBypass: false, disabled: true } };
    }
    const res = typeof targetEngine.checkObservationMemo === 'function'
      ? await targetEngine.checkObservationMemo(body || {})
      : fallbackCheckMemo(body || {});
    return { status: 200, body: { ok: true, ...(res || { hit: false, retryBypass: false }) } };
  }

  if (method === 'POST' && url === '/hook/memo-record') {
    if (!st.enabled || st.ramSotaEngines === false) {
      return { status: 200, body: { ok: true, skipped: true } };
    }
    if (typeof targetEngine.recordObservationMemo === 'function') {
      await targetEngine.recordObservationMemo(body || {});
    } else {
      fallbackRecordMemo(body || {});
    }
    return { status: 200, body: { ok: true } };
  }

  if (method === 'POST' && url === '/hook/compaction-archive') {
    if (!st.enabled || st.ramSotaEngines === false) {
      return { status: 200, body: { ok: true, archived: false, skipped: true } };
    }
    const archiveArgs = {
      convoId: body.convoId,
      wsPath: body.wsPath,
      rawText: body.rawText,
      steps: body.steps,
    };
    if (typeof targetEngine.archiveCompactionFacts === 'function') {
      await targetEngine.archiveCompactionFacts(archiveArgs);
    } else {
      fallbackArchiveCompactionFacts(archiveArgs);
      if (st.sqliteKnowledgeEnabled !== false && archiveArgs.wsPath) {
        try {
          knowledgeHub.saveRepairKvBuckets(archiveArgs.wsPath, fallbackRepairMap);
        } catch {}
      }
    }
    return { status: 200, body: { ok: true, archived: true } };
  }

  if (method === 'POST' && url === '/graph/overview') {
    const wsPath = body.wsPath || latestActiveWorkspace || stdioClientWorkspace || process.cwd();
    if (!st.enabled || !wsPath) return { status: 200, body: { ok: false } };
    registerDaemonWorkspace(wsPath, { makeActive: false });
    const res = targetEngine.queryKnowledgeGraph(wsPath, {
      mode: 'report',
      maxClusters: Number(body.maxClusters) || 8,
      maxGodNodes: Number(body.maxGodNodes) || 6,
    });
    return { status: 200, body: res };
  }

  if (method === 'POST' && url === '/graph/project-map') {
    const wsPath = body.wsPath || latestActiveWorkspace || stdioClientWorkspace || process.cwd();
    if (!st.enabled || !wsPath) return { status: 200, body: { ok: false } };
    const isEphemeral = isEphemeralOrScratchWorkspace(wsPath) || isEphemeralTestWorkspace(wsPath);
    if (!isEphemeral) registerDaemonWorkspace(wsPath, { makeActive: false });
    const payload = buildProjectGraphPayload(targetEngine, wsPath, {
      focus: body.focus,
      depth: body.depth,
      maxNodes: body.maxNodes,
      includeTests: body.includeTests,
      includeDocs: body.includeDocs,
      startWatcher: !isEphemeral,
      source: 'ram_daemon',
    });
    return { status: 200, body: payload };
  }

  if (method === 'POST' && url === '/graph/path') {
    const wsPath = body.wsPath || latestActiveWorkspace || stdioClientWorkspace || process.cwd();
    if (!st.enabled || !wsPath) return { status: 200, body: { ok: false, found: false } };
    const isEphemeral = isEphemeralOrScratchWorkspace(wsPath) || isEphemeralTestWorkspace(wsPath);
    if (!isEphemeral) registerDaemonWorkspace(wsPath, { makeActive: false });
    const maxDepth = Math.max(1, Math.min(8, Math.floor(Number(body.maxDepth) || 6)));
    const direction = body.direction === 'directed' ? 'directed' : 'both';
    const res = targetEngine.findGraphPath(wsPath, body.from || '', body.to || '', {
      maxDepth,
      direction,
    });
    return { status: 200, body: res };
  }

  if (method === 'POST' && url === '/graph/symbols') {
    const wsPath = body.wsPath || latestActiveWorkspace || stdioClientWorkspace || process.cwd();
    if (!st.enabled || !wsPath || !body.file) {
      return { status: 200, body: { ok: false, isSymbolsView: true, nodes: [], edges: [] } };
    }
    const isEphemeral = isEphemeralOrScratchWorkspace(wsPath) || isEphemeralTestWorkspace(wsPath);
    if (!isEphemeral) registerDaemonWorkspace(wsPath, { makeActive: false });
    const payload = buildFileSymbolGraphPayload(targetEngine, wsPath, body.file, {
      startWatcher: !isEphemeral,
      maxExternal: body.maxExternal,
      source: 'ram_daemon',
    });
    return { status: 200, body: payload };
  }

  if (method === 'POST' && url === '/graph/semantic-search') {
    const wsPath = body.wsPath || latestActiveWorkspace || stdioClientWorkspace || process.cwd();
    const query = String(body.query || '').trim();
    if (!st.enabled || !wsPath || query.length < 2) {
      return { status: 200, body: { ok: false, query, scoresByFile: {}, matches: [] } };
    }
    const isEphemeral = isEphemeralOrScratchWorkspace(wsPath) || isEphemeralTestWorkspace(wsPath);
    if (!isEphemeral) registerDaemonWorkspace(wsPath, { makeActive: false });
    const maxResults = Math.max(4, Math.min(30, Math.floor(Number(body.maxResults) || 14)));
    const semRes = await targetEngine.searchSemantic(wsPath, query, {
      maxResults,
      contextLines: 0,
      reindexMissing: false,
    });
    return { status: 200, body: aggregateSemanticGraphHits(semRes, query, 'ram_daemon') };
  }

  if (method === 'POST' && url === '/hook/pre-invocation') {
    try {
      sentinel?.preempt?.('pre_invocation');
    } catch {}
    const wsPath = body.wsPath || '';
    const query = body.query || '';
    const convoId = typeof body.convoId === 'string' && body.convoId.trim() ? body.convoId.trim() : 'default';
    const epoch = Number.isFinite(Number(body.epoch)) ? Number(body.epoch) : 0;
    if (!st.enabled || !wsPath || !query) return { status: 200, body: { ok: false } };

    let repairKvHint = '';
    if (st.ramSotaEngines !== false) {
      try {
        const recallRes = typeof targetEngine.recallCompactionFacts === 'function'
          ? await targetEngine.recallCompactionFacts({ convoId, wsPath, query, topK: 3, epoch })
          : fallbackRecallCompactionFacts({ convoId, wsPath, query, topK: 3 });
        if (recallRes?.formattedHint) {
          repairKvHint = String(recallRes.formattedHint).trim();
        }
      } catch {}
    }
    if (st.sqliteKnowledgeEnabled !== false) {
      try {
        const activeHub = opts.knowledgeHub || knowledgeHub;
        const vr = activeHub.matchVictoryRecipes(wsPath, query, { topK: 2 });
        if (vr?.formattedHint) {
          repairKvHint = repairKvHint
            ? `${repairKvHint}\n${vr.formattedHint}`
            : vr.formattedHint;
        }
      } catch {}
    }

    registerDaemonWorkspace(wsPath);
    const ws = targetEngine.getOrCreateWorkspace(wsPath);

    let specHit = null;
    let sentinelAlert = '';
    let cardMatches = [];
    if (sentinel) {
      try {
        specHit = sentinel.consumeSpeculativeContext?.(wsPath, query) || null;
      } catch {}
      try {
        sentinelAlert = sentinel.formatSentinelAlertForPrompt?.(wsPath) || '';
      } catch {}
      try {
        cardMatches = sentinel.searchSymbolCardsLexical?.(wsPath, query, { topK: 4 }) || [];
      } catch {}
    }

    const mergeSymbolCards = (baseFiles = []) => {
      const merged = Array.isArray(baseFiles) ? [...baseFiles] : [];
      if (!Array.isArray(cardMatches) || cardMatches.length === 0) return merged;
      const absBase = ws?.absRoot || path.resolve(wsPath);
      const seen = new Set(
        merged.map((sf) => String(sf?.file || sf || '').replace(/\\/g, '/').trim()).filter(Boolean)
      );
      for (const cm of cardMatches) {
        const score = Number(cm?.score ?? 0);
        let rel = String(cm?.file || cm?.relPath || cm?.filePath || '').trim();
        if (rel && path.isAbsolute(rel)) {
          const r = path.relative(absBase, rel);
          if (r && !r.startsWith('..') && !path.isAbsolute(r)) rel = r;
        }
        rel = rel.replace(/\\/g, '/').replace(/^\.\//, '');
        if (!rel || !(score > 0) || seen.has(rel)) continue;
        seen.add(rel);
        merged.push({
          file: rel,
          score: Math.min(1, score),
          startLine: Number(cm?.startLine || cm?.line || 1) || 1,
          endLine: Number(cm?.endLine || (cm?.startLine ? Number(cm.startLine) + 35 : 45)) || 45,
        });
      }
      return merged;
    };

    if (specHit?.hit && specHit.goldContextHint) {
      const specSemanticFiles = mergeSymbolCards(Array.isArray(specHit.semanticFiles) ? specHit.semanticFiles : []);
      const specSemanticSkills = Array.isArray(specHit.semanticSkills) ? specHit.semanticSkills : [];
      const fastHint = finalizePreInvocationHint(specHit.goldContextHint, repairKvHint, sentinelAlert);
      return {
        status: 200,
        body: {
          ok: true,
          speculativeHit: true,
          goldContextHint: fastHint,
          repairKvHint,
          semanticFiles: specSemanticFiles,
          semanticSkills: specSemanticSkills,
          skillIndexWarm: Boolean(specHit.skillIndexWarm),
          usedSemantic: Boolean(specHit.usedSemantic ?? true),
        },
      };
    }

    if (!ws || ws.files.size === 0) {
      if (st.autoWarm) scheduleWarm(wsPath);
      let skillTimer = null;
      const skillRes = body.includeSemantic === false
        ? { semanticSkills: [], skillIndexWarm: false }
        : await Promise.race([
            peekWarmSemanticSkills(query, { topK: 3, timeoutMs: 180, wsAbsRoot: wsPath }).finally(() => {
              if (skillTimer) clearTimeout(skillTimer);
            }),
            new Promise((resolveRace) => {
              skillTimer = setTimeout(() => resolveRace({ semanticSkills: [], skillIndexWarm: false }), 195);
              if (typeof skillTimer.unref === 'function') skillTimer.unref();
            }),
          ]);
      return {
        status: 200,
        body: {
          ok: false,
          warming: true,
          speculativeHit: false,
          repairKvHint,
          semanticSkills: skillRes.semanticSkills || [],
          skillIndexWarm: Boolean(skillRes.skillIndexWarm),
        },
      };
    }
    let raceTimer = null;
    const bundle = body.includeSemantic === false
      ? { semanticFiles: [], semanticSkills: [], skillIndexWarm: false }
      : await Promise.race([
          peekWarmSemanticBundle(ws.absRoot, query, { topK: 6, minSim: 0.38, skillTopK: 3, timeoutMs: 220, recordTelemetry: true }).finally(() => {
            if (raceTimer) clearTimeout(raceTimer);
          }),
          new Promise((resolveRace) => {
            raceTimer = setTimeout(() => resolveRace({ semanticFiles: [], semanticSkills: [], skillIndexWarm: false }), 235);
            if (typeof raceTimer.unref === 'function') raceTimer.unref();
          }),
        ]);
    const semanticFiles = mergeSymbolCards(Array.isArray(bundle?.semanticFiles) ? bundle.semanticFiles : []);
    const semanticSkills = Array.isArray(bundle?.semanticSkills) ? bundle.semanticSkills : [];
    const skillIndexWarm = Boolean(bundle?.skillIndexWarm);

    const hybridRes = targetEngine.buildHybridGoldContext(wsPath, query, semanticFiles, { maxResults: 4, contextLines: 3 });
    if (!hybridRes.ok || hybridRes.results.length === 0) {
      const fallbackGold = finalizePreInvocationHint('', repairKvHint, sentinelAlert);
      return {
        status: 200,
        body: { ok: true, speculativeHit: false, goldContextHint: fallbackGold, repairKvHint, semanticFiles, semanticSkills, skillIndexWarm, usedSemantic: false },
      };
    }
    targetEngine.recordCompletedOp?.('gold_context', {
      target: hybridRes.results[0]?.file || path.basename(wsPath),
      latencyMs: hybridRes.rerankElapsedMs || 0.7,
    });
    const rerankTag = hybridRes.usedRerank ? ' + CPU-Rerank' : '';
    const label = hybridRes.usedSemantic
      ? `⚡ [RAM + GPU${rerankTag} Hybrid Gold Context (${ws.files.size} files | BM25F + Qwen3 RRF)]`
      : `⚡ [RAM Gold Context (${ws.files.size} files in RAM)]`;
    const egoHint = targetEngine.getEgoGraphHintForResults(wsPath, hybridRes.results, query);
    const repoGraphLine = egoHint?.edgesFound > 0 && egoHint.formattedHint ? `\n${egoHint.formattedHint}` : '';
    const baseHint = `${label}\n${hybridRes.formatted.slice(0, 1500)}${repoGraphLine}`;
    const hint = finalizePreInvocationHint(baseHint, repairKvHint, sentinelAlert);
    return {
      status: 200,
      body: { ok: true, speculativeHit: false, goldContextHint: hint, repairKvHint, semanticFiles, semanticSkills, skillIndexWarm, usedSemantic: hybridRes.usedSemantic },
    };
  }

  if (method === 'POST' && url === '/hook/post-edit') {
    const wsPath = body.wsPath || '';
    const filePath = body.filePath || '';
    if (!st.enabled || !wsPath || !filePath) return { status: 200, body: { ok: false } };

    if (st.ramSotaEngines !== false) {
      try {
        if (typeof targetEngine.invalidateObservationFile === 'function') {
          targetEngine.invalidateObservationFile(wsPath, filePath);
        } else {
          fallbackInvalidateObservationFile(wsPath, filePath);
        }
      } catch {}
    }

    registerDaemonWorkspace(wsPath);
    const ws = targetEngine.getOrCreateWorkspace(wsPath);
    if (ws && ws.files.size > 0) {
      const entry = targetEngine.upsertFile(wsPath, filePath, { rebuildDeps: true });
      if (entry) {
        scheduleDebouncedFileReindex(ws.absRoot, entry, targetEngine);
      }
      try {
        sentinel?.notifyFileChanged?.(ws.absRoot, entry?.relPath || filePath, targetEngine);
      } catch {}
      if (st.ramSotaEngines !== false && typeof targetEngine.scheduleSpeculativePrefetch === 'function') {
        try {
          targetEngine.scheduleSpeculativePrefetch(wsPath, filePath);
        } catch {}
      }
      const blast = targetEngine.getFastBlastRadius(wsPath, filePath);
      const contracts = targetEngine.verifyContractsInRam(wsPath, filePath);
      let lspRes = null;
      if (st.lspBridgeEnabled !== false) {
        try {
          const docText = entry?.buf ? entry.buf.toString('utf8') : undefined;
          lspRes = await lspBridge.checkFileDiagnostics(ws.absRoot, entry?.relPath || filePath, docText, {
            timeoutMs: 50,
            serverCmdOverride: opts.lspServerCmdOverride,
          });
        } catch {}
      }
      return {
        status: 200,
        body: {
          ok: true,
          updated: true,
          blastRadiusHint: blast?.formattedHint || '',
          dependents: blast?.dependents || [],
          contractValid: contracts.valid,
          contractAlert: contracts.alert || '',
          brokenImports: contracts.brokenImports || [],
          semanticIssues: contracts.semanticIssues || [],
          lspDiagnostics: Array.isArray(lspRes?.diagnostics) ? lspRes.diagnostics : [],
          lspAlert: lspRes?.formattedAlert || '',
        },
      };
    }
    try {
      sentinel?.notifyFileChanged?.(ws?.absRoot || path.resolve(wsPath), filePath, targetEngine);
    } catch {}
    return { status: 200, body: { ok: false } };
  }

  if (method === 'GET' && url === '/gpu/status') {
    const snap = await getGpuStatusSnapshot();
    return { status: 200, body: { ok: true, ...snap } };
  }

  if (method === 'POST' && url === '/gpu/warm') {
    const wsPath = resolveDefaultWorkspace(body.wsPath);
    registerDaemonWorkspace(wsPath);
    const ws = await targetEngine.warmWorkspaceAsync(wsPath);
    if (!ws || !ws.files) return { status: 200, body: { ok: false, error: 'Invalid workspace' } };
    const resWarm = await warmWorkspaceVectorsOnce(ws.absRoot, ws.files, {
      maxNewFiles: Number(body.maxNewFiles || 300),
      includeSkills: true,
    });
    return { status: 200, body: resWarm };
  }

  if (method === 'POST' && url === '/skills/match') {
    const matchRes = await matchSkillsAi(String(body.query || ''), {
      customRoot: typeof body.customRoot === 'string' ? body.customRoot : '',
      allowLlmFallback: body.allowLlmFallback !== false,
      topK: Math.max(1, Math.min(10, Number(body.topK) || 3)),
      llmTimeoutMs: Math.max(1000, Math.min(30000, Number(body.timeoutMs) || 10000)),
    });
    return { status: 200, body: matchRes };
  }

  if (method === 'POST' && url === '/gpu/unload') {
    const resUnload = await unloadAllModels();
    return { status: 200, body: resUnload };
  }

  if (method === 'POST' && url === '/gpu/distill') {
    const resDistill = body?.filePath
      ? await distillLocalFile(body)
      : await distillText(body || {});
    return { status: 200, body: resDistill };
  }

  if (method === 'POST' && url === '/gpu/semantic-search') {
    const wsPath = resolveDefaultWorkspace(body.wsPath);
    registerDaemonWorkspace(wsPath);
    const resSearch = await targetEngine.searchSemantic(wsPath, body.query || '', {
      maxResults: body.maxResults || 6,
      contextLines: body.contextLines ?? 2,
    });
    return { status: 200, body: resSearch };
  }

  if (method === 'POST' && url === '/ram/composer-rag') {
    try {
      sentinel?.preempt?.('composer_typing');
    } catch {}
    const wsPath = resolveDefaultWorkspace(body.wsPath);
    const query = String(body.query || '').trim().slice(0, 600);
    if (!query) {
      return {
        status: 200,
        body: {
          ok: true,
          mode: 'cpu_ram_fast',
          matchedFiles: [],
          matchedSymbols: [],
          ragSnippets: [],
          repoFiles: [],
          repoSymbols: [],
        },
      };
    }
    registerDaemonWorkspace(wsPath);
    const ws = targetEngine.ensureWarm(wsPath);
    if (!ws || !ws.files) {
      return {
        status: 200,
        body: {
          ok: true,
          mode: 'cpu_ram_fast',
          matchedFiles: [],
          matchedSymbols: [],
          ragSnippets: [],
          repoFiles: [],
          repoSymbols: [],
        },
      };
    }

    if (query.length >= 8 && sentinel?.scheduleSpeculativeWarm) {
      try {
        Promise.resolve(sentinel?.scheduleSpeculativeWarm?.(ws.absRoot, query, targetEngine)).catch(() => {});
      } catch {}
    }

    const hasFastFn = typeof targetEngine.searchComposerContextFast === 'function';
    const fastRes = hasFastFn
      ? targetEngine.searchComposerContextFast(ws.absRoot, query, {
          maxFiles: Number(body.maxFiles) || 5,
          maxSymbols: Number(body.maxSymbols) || 10,
        })
      : null;

    if (hasFastFn && body.allowSemantic !== true) {
      return {
        status: 200,
        body: {
          ok: true,
          mode: fastRes?.mode || 'cpu_ram_fast',
          matchedFiles: Array.isArray(fastRes?.matchedFiles) ? fastRes.matchedFiles : [],
          matchedSymbols: Array.isArray(fastRes?.matchedSymbols) ? fastRes.matchedSymbols : [],
          ragSnippets: Array.isArray(fastRes?.ragSnippets) ? fastRes.ragSnippets : [],
          repoFiles: Array.isArray(fastRes?.repoFiles) ? fastRes.repoFiles : [],
          repoSymbols: Array.isArray(fastRes?.repoSymbols) ? fastRes.repoSymbols : [],
          symbolsByFile: fastRes?.symbolsByFile && typeof fastRes.symbolsByFile === 'object' ? fastRes.symbolsByFile : {},
          repoTechTerms: Array.isArray(fastRes?.repoTechTerms) ? fastRes.repoTechTerms : [],
        },
      };
    }

    const semRes = await targetEngine.searchSemantic(ws.absRoot, query, {
      maxResults: 4,
      contextLines: 1,
      reindexMissing: false,
    });
    const hits = Array.isArray(semRes?.results) ? semRes.results : [];
    const matchedFiles = [...(Array.isArray(fastRes?.matchedFiles) ? fastRes.matchedFiles : [])];
    const matchedSymbols = [...(Array.isArray(fastRes?.matchedSymbols) ? fastRes.matchedSymbols : [])];
    const ragSnippets = [...(Array.isArray(fastRes?.ragSnippets) ? fastRes.ragSnippets : [])];
    const seenFiles = new Set(matchedFiles);
    const seenSyms = new Set(matchedSymbols);
    for (const h of hits) {
      const rel = String(h?.file || '').trim();
      if (!rel) continue;
      if (!seenFiles.has(rel) && matchedFiles.length < 6) {
        seenFiles.add(rel);
        matchedFiles.push(rel);
      }
      const fileEntry = ws.files.get(rel);
      const localSyms = [];
      const rawSyms = [
        ...(Array.isArray(fileEntry?.exportedSymbols) ? fileEntry.exportedSymbols : []),
        ...(Array.isArray(fileEntry?.symbols) ? fileEntry.symbols : []),
      ];
      for (const s of rawSyms) {
        const name = typeof s === 'string' ? s.trim() : String(s?.name || '').trim();
        if (!name || name.length < 3 || name === 'anonymous') continue;
        if (localSyms.length < 4 && !localSyms.includes(name)) localSyms.push(name);
        if (!seenSyms.has(name) && matchedSymbols.length < 10) {
          seenSyms.add(name);
          matchedSymbols.push(name);
        }
      }
      if (ragSnippets.length < 3 && !ragSnippets.some((sn) => sn.file === rel)) {
        ragSnippets.push({
          file: rel,
          startLine: Number(h?.startLine || h?.line || 0),
          endLine: Number(h?.endLine || h?.line || 0),
          symbols: localSyms,
        });
      }
    }

    let repoFiles = Array.isArray(fastRes?.repoFiles) ? fastRes.repoFiles : [];
    let repoSymbols = Array.isArray(fastRes?.repoSymbols) ? fastRes.repoSymbols : [];
    if (!hasFastFn) {
      repoFiles = Array.from(ws.files.keys()).slice(0, 500);
      const fallbackSyms = [];
      const seenFallback = new Set();
      for (const entry of ws.files.values()) {
        for (const s of [...(entry.exportedSymbols || []), ...(entry.symbols || [])]) {
          const n = typeof s === 'string' ? s.trim() : String(s?.name || '').trim();
          if (!n || n.length < 2 || n === 'anonymous' || seenFallback.has(n)) continue;
          seenFallback.add(n);
          fallbackSyms.push(n);
          if (fallbackSyms.length >= 2500) break;
        }
        if (fallbackSyms.length >= 2500) break;
      }
      repoSymbols = fallbackSyms;
    }

    return {
      status: 200,
      body: {
        ok: true,
        mode: semRes?.mode || fastRes?.mode || 'hybrid',
        matchedFiles,
        matchedSymbols,
        ragSnippets,
        repoFiles,
        repoSymbols,
        symbolsByFile: fastRes?.symbolsByFile && typeof fastRes.symbolsByFile === 'object' ? fastRes.symbolsByFile : {},
        repoTechTerms: Array.isArray(fastRes?.repoTechTerms) ? fastRes.repoTechTerms : [],
      },
    };
  }

  if (method === 'POST' && url === '/gpu/chat') {
    const signal = opts.signal || null;
    const abortedBody = () => ({ status: 200, body: { ok: false, aborted: true, answer: '', error: 'Request aborted' } });
    if (signal?.aborted) return abortedBody();

    const query = String(body.query || '').trim();
    if (!query) {
      return { status: 200, body: { ok: false, answer: '', error: 'Empty query' } };
    }
    const wsPath = resolveDefaultWorkspace(body.wsPath);
    registerDaemonWorkspace(wsPath);
    activeChatIpcCount += 1;
    try {
      if (signal?.aborted) return abortedBody();
      let ws = targetEngine.getOrCreateWorkspace(wsPath);
      if (!ws || !ws.files || ws.files.size === 0) {
        const warmRes = await targetEngine.warmWorkspaceAsync(wsPath);
        if (signal?.aborted) return abortedBody();
        if (warmRes?.ok) {
          ws = targetEngine.ensureWarm(wsPath);
        }
      }
      if (!ws || !ws.files) {
        return { status: 200, body: { ok: false, answer: '', error: 'Invalid workspace' } };
      }

      const cleanMessages = Array.isArray(body.messages) ? body.messages : [];
      const focusFile = typeof body.focusFile === 'string' ? body.focusFile.trim().slice(0, 512) : '';
      const queryWithFocus = focusFile && !query.toLowerCase().includes(focusFile.toLowerCase())
        ? `${query} ${focusFile}`
        : query;
      const effectiveQuery = enrichMultiTurnChatQuery(queryWithFocus, cleanMessages, { maxExtraTerms: 6 });

      if (!opts.runLocalProjectChatFn && !signal?.aborted && !isLocalChatActive()) {
        const gpuCfg = loadGpuConfig();
        if (gpuCfg.gpuEnabled && gpuCfg.gpuSemanticSearch) {
          await indexWorkspaceVectors(ws.absRoot, ws.files, { maxNewFiles: 20 }).catch(() => null);
        }
      }
      if (signal?.aborted) return abortedBody();

      const semRes = await targetEngine.searchSemantic(ws.absRoot, effectiveQuery, {
        maxResults: 6,
        contextLines: 3,
        reindexMissing: false,
      });
      if (signal?.aborted) return abortedBody();
      const hits = Array.isArray(semRes?.results) ? semRes.results : [];
      const maxContextChars = Math.max(1600, Math.min(16000, Number(body.maxContextChars) || 8400));
      const packRes = typeof targetEngine.buildGroundedChatPack === 'function'
        ? targetEngine.buildGroundedChatPack(ws.absRoot, queryWithFocus, {
            messages: cleanMessages,
            maxChars: maxContextChars,
            warmSemanticHits: hits,
            focusFile,
          })
        : targetEngine.getContextPack(ws.absRoot, effectiveQuery, {
            maxChars: maxContextChars,
            warmSemanticHits: hits,
            toon: true,
          });

      const ragSources = [];
      const seenSourceKeys = new Set();
      const rawSourcePool = [
        ...(Array.isArray(packRes?.sources) ? packRes.sources : []),
        ...hits,
      ];
      for (const h of rawSourcePool) {
        const rel = String(h?.file || h?.relPath || '').trim();
        if (!rel) continue;
        const startLine = Number(h?.startLine || h?.line || 1);
        const endLine = Number(h?.endLine || startLine);
        const sKey = `${rel}:${startLine}-${endLine}`;
        if (seenSourceKeys.has(sKey)) continue;
        seenSourceKeys.add(sKey);
        ragSources.push({
          file: rel,
          startLine,
          endLine,
          score: Number(h?.rerankScore ?? h?.hybridScore ?? h?.similarity ?? h?.score ?? 0),
        });
        if (ragSources.length >= 6) break;
      }

      const ragContext = packRes?.formatted || semRes?.formatted || '';
      const chatRunner = typeof opts.runLocalProjectChatFn === 'function'
        ? opts.runLocalProjectChatFn
        : (typeof localGpuNs.runLocalProjectChat === 'function' ? localGpuNs.runLocalProjectChat : runLocalProjectChat);
      if (signal?.aborted) return abortedBody();
      const chatOut = await chatRunner({
        query,
        messages: cleanMessages,
        ragContext,
        ragSources,
        verifiedManifest: packRes?.verifiedManifest || '',
        repoFiles: Array.isArray(packRes?.repoFiles) ? packRes.repoFiles : [],
        repoSymbols: Array.isArray(packRes?.repoSymbols) ? packRes.repoSymbols : [],
        symbolsByFile: packRes?.symbolsByFile && typeof packRes.symbolsByFile === 'object' ? packRes.symbolsByFile : {},
        fetchExtraSlicesFn: typeof targetEngine.findSymbolSlicesFast === 'function'
          ? (syms) => targetEngine.findSymbolSlicesFast(ws.absRoot, syms, { maxSlices: 3, maxLinesPerSlice: 38 })
          : null,
        workspaceName: path.basename(ws.absRoot),
        maxOutputTokens: body.maxOutputTokens,
        timeoutMs: body.timeoutMs,
        signal,
        lang: typeof body.lang === 'string' ? body.lang : '',
      });
      return { status: 200, body: chatOut };
    } finally {
      activeChatIpcCount = Math.max(0, activeChatIpcCount - 1);
    }
  }

  if (method === 'POST' && url === '/ipc/lsp-diagnostics') {
    if (st.lspBridgeEnabled === false) {
      return { status: 200, body: { ok: false, disabled: true, available: false, diagnostics: [] } };
    }
    const wsPath = resolveDefaultWorkspace(body?.wsPath);
    const fp = String(body?.filePath || '').trim();
    if (!fp) return { status: 200, body: { ok: false, available: false, diagnostics: [] } };
    const diagRes = await lspBridge.checkFileDiagnostics(wsPath, fp, body?.contentText, {
      timeoutMs: body?.timeoutMs || 150,
      waitFresh: body?.waitFresh !== false,
      serverCmdOverride: opts.lspServerCmdOverride,
    });
    return { status: 200, body: diagRes };
  }

  if (method === 'GET' && url === '/ipc/lsp-status') {
    const wsPath = body?.wsPath ? resolveDefaultWorkspace(body.wsPath) : '';
    return { status: 200, body: lspBridge.getStatusSnapshot(wsPath) };
  }

  return { status: 404, body: { ok: false, error: 'Not found' } };
}

export async function handleIpcHttpRequest(req, res, opts = {}) {
  if (!opts.skipAuth && !isValidIpcToken(req.headers['x-ram-token'])) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
    return;
  }

  const reqAbort = new AbortController();
  const onResClose = () => {
    if (!res.writableEnded && !reqAbort.signal.aborted) {
      reqAbort.abort('ipc_client_disconnected');
    }
  };
  if (typeof res.on === 'function') {
    res.on('close', onResClose);
  }
  const extSignal = opts.signal && typeof opts.signal.addEventListener === 'function' ? opts.signal : null;
  const onExtAbort = () => {
    if (!reqAbort.signal.aborted) reqAbort.abort(extSignal?.reason || 'external_abort');
  };
  if (extSignal) {
    if (extSignal.aborted) {
      onExtAbort();
    } else {
      extSignal.addEventListener('abort', onExtAbort, { once: true });
    }
  }

  const sendJson = (code, data) => {
    if (reqAbort.signal.aborted || res.destroyed || res.headersSent) return;
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  try {
    let body = {};
    if (req.method === 'POST') {
      body = await readHttpJson(req, res);
      if (body === null || reqAbort.signal.aborted) return;
    }

    const out = await dispatchIpcRoute(req.method, req.url, body, { ...opts, signal: reqAbort.signal });
    return sendJson(out.status, out.body);
  } finally {
    if (typeof res.off === 'function') {
      res.off('close', onResClose);
    } else if (typeof res.removeListener === 'function') {
      res.removeListener('close', onResClose);
    }
    if (extSignal) {
      try { extSignal.removeEventListener('abort', onExtAbort); } catch {}
    }
  }
}

const ipcServer = http.createServer((req, res) => handleIpcHttpRequest(req, res));

ipcServer.requestTimeout = 95000;

function startIpcServer() {
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true });
  }
  ipcServer.listen(0, '127.0.0.1', () => {
    const addr = ipcServer.address();
    if (addr && typeof addr === 'object') {
      ipcPort = addr.port;
      ipcStartedAt = new Date().toISOString();
      writeDaemonRegistration();
      try {
        const sentinel = loadedSentinel;
        if (sentinel) {
          sentinel?.startDaemonLoop?.(engine, { intervalMs: 5000 });
        } else {
          void ensureSentinelLoaded().then((s) => {
            try { s?.startDaemonLoop?.(engine, { intervalMs: 5000 }); } catch {}
          });
        }
      } catch {}
    }
  });
  ipcServer.unref();
}

function cleanupDaemonFile() {
  daemonShuttingDown = true;
  for (const t of activeGpuWarmTimers) {
    try { clearTimeout(t); } catch {}
  }
  activeGpuWarmTimers.clear();
  for (const t of debouncedReindexTimers.values()) {
    try { clearTimeout(t); } catch {}
  }
  debouncedReindexTimers.clear();
  try {
    loadedSentinel?.stopDaemonLoop?.();
  } catch {}
  let remainingLiveCount = 0;
  try {
    if (existsSync(DAEMON_INFO_FILE)) {
      let removeWholeFile = false;
      updateJsonAtomicSync(DAEMON_INFO_FILE, () => ({ instances: {} }), (cur) => {
        const prevInst = cur?.instances && typeof cur.instances === 'object' ? cur.instances : {};
        const nextInst = {};
        for (const [k, v] of Object.entries(prevInst)) {
          if (k === String(process.pid)) continue;
          if (v && Number(v.pid) !== process.pid && isPidAlive(v.pid)) {
            nextInst[k] = v;
          }
        }
        const liveList = Object.values(nextInst);
        remainingLiveCount = liveList.length;
        if (liveList.length === 0) {
          removeWholeFile = true;
          return { instances: {} };
        }
        const primary = liveList[0];
        return { ...primary, instances: nextInst };
      });
      if (removeWholeFile && existsSync(DAEMON_INFO_FILE)) {
        try { unlinkSync(DAEMON_INFO_FILE); } catch {}
      }
    }
  } catch {}
  try {
    engine.evict('all');
    ipcServer.close();
  } catch {}
  return { remainingLiveCount };
}

/**
 * Cleans up daemon registration and unloads Ollama VRAM when the last Antigravity MCP daemon exits.
 */
export async function handleMcpDaemonExit({
  cleanupFn = cleanupDaemonFile,
  unloadFn = unloadModelsOnAppExit,
  timeoutMs = 1800,
  closeAgents = true,
} = {}) {
  try {
    loadedSentinel?.stopDaemonLoop?.();
  } catch {}
  try {
    await lspBridge.shutdownAll();
  } catch {}
  try {
    knowledgeHub.close();
  } catch {}
  const cleanupRes = cleanupFn() || { remainingLiveCount: 0 };
  const remaining = Math.max(0, Number(cleanupRes.remainingLiveCount) || 0);
  if (remaining > 0) {
    return {
      ok: true,
      skipped: true,
      reason: 'other_instances_alive',
      remainingLiveCount: remaining,
      unloaded: [],
    };
  }
  return await unloadFn({ timeoutMs, closeAgents });
}

// --- MCP JSON-RPC 2.0 Tool Definitions ---
export const MCP_TOOLS = [
  {
    name: 'ram_search',
    description: 'Instant in-RAM code, symbol, and text search across the cached workspace. Returns compact file:L#-L# snippets directly from memory without reading whole files.',
    annotations: {
      title: 'RAM Search',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Symbol name, identifier, error text, or keywords to search for in RAM.' },
        workspaceRoot: { type: 'string', description: 'Workspace root directory (defaults to CWD).' },
        maxResults: { type: 'integer', description: 'Maximum matching files/snippets to return (default 10).' },
        contextLines: { type: 'integer', description: 'Lines of context around the match (default 2).' },
        includeFederated: { type: 'boolean', description: 'When true, also searches linked federated companion repositories.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'ram_slice',
    description: 'Reads an exact line range OR extracts a variable data-flow slice straight from the RAM file buffer (<1ms, zero disk I/O when warm).',
    annotations: {
      title: 'RAM Slice',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Absolute or workspace-relative file path.' },
        workspaceRoot: { type: 'string', description: 'Workspace root directory (defaults to CWD).' },
        symbol: { type: 'string', description: 'Optional variable/function name for Program Slicer data-flow distillation or AST Knapsack focus.' },
        section: { type: 'string', description: 'Optional Markdown heading title or slug to slice a single section directly from RAM without reading the whole .md file.' },
        startLine: { type: 'integer', description: 'Start line (1-indexed, default 1).' },
        endLine: { type: 'integer', description: 'End line (inclusive, default 120).' },
        skeleton: { type: 'boolean', description: 'Optional LongCodeZip AST Knapsack mode: folds non-relevant symbols to 1-line skeletons while keeping focus blocks verbatim.' },
        callGraph: { type: 'boolean', description: 'When true with symbol, extracts full AST symbol body (if matched) plus 1-hop callers & callees.' },
        query: { type: 'string', description: 'Optional query focus used when skeleton=true to rank and expand relevant symbol blocks.' },
        maxChars: { type: 'integer', description: 'Optional character budget when skeleton=true (default 3200).' },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'ram_context_pack',
    description: 'Builds a one-shot Zero-Turn context bundle straight from RAM: relevant slices, Blast Radius dependencies, Pitfall Ledger, Handoff, and RAM RepoMap.',
    annotations: {
      title: 'Zero-Turn Context Pack',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Task description or question.' },
        workspaceRoot: { type: 'string', description: 'Workspace root directory (defaults to CWD).' },
        maxChars: { type: 'integer', description: 'Maximum output character budget (default 4800).' },
        phase: { type: 'string', enum: ['auto', 'explore', 'edit', 'debug'], description: 'Dynamic SWE-Pruner phase budget mode (default auto).' },
        toon: { type: 'boolean', description: 'Use compact TOON notation for RepoMap (-35% tokens).' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'ram_warm_workspace',
    description: 'Preloads and indexes an entire repository into RAM (respecting ramMaxBudgetMb, adaptive 512 MB–32 GB, default 4 GB) and activates live fs.watch synchronization.',
    annotations: {
      title: 'Warm Workspace in RAM',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        workspaceRoot: { type: 'string', description: 'Workspace root directory to warm in RAM.' },
        maxFiles: { type: 'integer', description: 'Maximum files to load (default 30000).' },
      },
      required: ['workspaceRoot'],
    },
  },
  {
    name: 'ram_stats',
    description: 'Reports live RAM cache usage (usedMb vs configured adaptive budget up to 32 GB), hit rate, cached workspaces, or evicts a cached workspace.',
    annotations: {
      title: 'RAM Cache Stats & Evict',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        evictTarget: { type: 'string', description: 'Optional workspace path or "all" to evict from RAM.' },
      },
    },
  },
  {
    name: 'gpu_distill',
    description: 'Offloads raw large logs, stacktraces, raw web/docs dumps, or large local files (via filePath or @file:<path> at zero cloud tokens) to the local RTX GPU (Ollama, adaptive VRAM cap up to 32 GB) and returns a crisp token-saving digest.',
    annotations: {
      title: 'Local GPU Log/Doc Distiller',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Preferred: path to a local log, test output, JSON dump, or doc/source file to read and distill locally (0 cloud input/output tokens).' },
        workspaceRoot: { type: 'string', description: 'Optional workspace root directory for resolving relative filePath (defaults to CWD).' },
        startLine: { type: 'integer', description: 'Optional 1-indexed start line when distilling a file slice.' },
        endLine: { type: 'integer', description: 'Optional 1-indexed end line when distilling a file slice.' },
        text: { type: 'string', description: 'Raw text, build log, error trace, documentation dump, or "@file:<path>" to compress/analyze locally.' },
        query: { type: 'string', description: 'Optional specific question or focus to extract.' },
        mode: { type: 'string', enum: ['error_log', 'docs', 'code_digest', 'qa', 'general'], description: 'Distillation focus mode (default general / auto-detected by extension).' },
        maxOutputTokens: { type: 'integer', description: 'Maximum digest tokens to return (default 450).' },
      },
    },
  },
  {
    name: 'gpu_semantic_search',
    description: 'Hybrid GPU semantic embedding search + adaptive (up to 32 GB) In-RAM Buffer slicing. Finds relevant code by meaning (even Russian/conceptual queries) without exact symbol names.',
    annotations: {
      title: 'Hybrid GPU+RAM Semantic Search',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language or conceptual description of what to find in the repository.' },
        workspaceRoot: { type: 'string', description: 'Workspace root directory (defaults to CWD).' },
        maxResults: { type: 'integer', description: 'Maximum snippets to return (default 6).' },
        contextLines: { type: 'integer', description: 'Extra context lines around matched chunks (default 2).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'gpu_status',
    description: 'Reports live GPU telemetry (VRAM, tempC, utilPct, thermal guard, Ollama models, saved tokens) OR triggers workspace vector indexing ("warm_index"), VRAM cap enforcement ("enforce_cap"), DDR5 GGUF pre-warming ("warm_host_ram"), or VRAM unload ("unload").',
    annotations: {
      title: 'Local GPU Status & Vector Index',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'warm_index', 'unload', 'enforce_cap', 'warm_host_ram'], description: 'Action to perform (default status).' },
        workspaceRoot: { type: 'string', description: 'Workspace root for warm_index (defaults to CWD).' },
      },
    },
  },
  {
    name: 'lsp_diagnostics',
    description: 'Runs live Language Server Protocol (LSP) type/semantic diagnostics on a file via the persistent LSP bridge (TS/JS, Python, Go, Rust).',
    annotations: {
      title: 'LSP Live Diagnostics',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Absolute or workspace-relative file path.' },
        workspaceRoot: { type: 'string', description: 'Workspace root directory (defaults to CWD).' },
        timeoutMs: { type: 'integer', description: 'Optional timeout in milliseconds (default 350).' },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'lsp_references',
    description: 'Queries exact LSP symbol references, definition location, and hover type signature at a given 1-indexed line and 0-indexed character.',
    annotations: {
      title: 'LSP References & Hover',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Absolute or workspace-relative file path.' },
        line: { type: 'integer', description: '1-indexed line number (or 0-indexed when zeroIndexed=true).' },
        character: { type: 'integer', description: '0-indexed column offset (default 0).' },
        zeroIndexed: { type: 'boolean', description: 'Set true when line is already 0-indexed.' },
        includeDeclaration: { type: 'boolean', description: 'Include symbol declaration in references (default true).' },
        workspaceRoot: { type: 'string', description: 'Workspace root directory (defaults to CWD).' },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'lsp_code_actions',
    description: 'Fetches zero-token LSP quick-fixes and organize-imports code actions for a file (and optionally returns edited text when apply=true).',
    annotations: {
      title: 'LSP Quick-Fix Code Actions',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Absolute or workspace-relative file path.' },
        apply: { type: 'boolean', description: 'When true, computes updated file text by applying the first WorkspaceEdit action.' },
        workspaceRoot: { type: 'string', description: 'Workspace root directory (defaults to CWD).' },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'git_bisect_auto',
    description: 'Runs automated binary-search `git bisect` inside an isolated temporary detached worktree to pinpoint the exact commit that broke a test command without modifying the working tree.',
    annotations: {
      title: 'Automated Git Bisect Culprit Finder',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        workspaceRoot: { type: 'string', description: 'Repository workspace root directory (defaults to CWD).' },
        goodRef: { type: 'string', description: 'Known passing Git commit SHA, branch, or tag (e.g. HEAD~10).' },
        badRef: { type: 'string', description: 'Known failing Git commit SHA or ref (defaults to HEAD).' },
        testCommand: { type: 'string', description: 'Deterministic verification command returning 0 on pass and non-zero on failure.' },
        timeoutMs: { type: 'integer', description: 'Per-step timeout in ms (default 20000).' },
      },
      required: ['goodRef', 'testCommand'],
    },
  },
  {
    name: 'ram_graph_query',
    description: 'Queries the in-RAM Knowledge Graph: shortest k-hop paths (mode="path"), clusters & God Nodes ("clusters"|"god_nodes"|"summary"), cross-cluster bridges ("surprising_bridges"), architecture audit questions ("questions"), transitive reverse blast radius incl. dynamic_import & re_exports ("affected"), full report ("report"), doc/config links ("doc_refs"), or entity explanations ("explain").',
    annotations: {
      title: 'RAM Knowledge Graph Query',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['path', 'clusters', 'god_nodes', 'doc_refs', 'explain', 'summary', 'surprising_bridges', 'questions', 'affected', 'report'],
          description: 'Graph query mode (default summary).',
        },
        from: { type: 'string', description: 'Starting symbol or file path for mode="path".' },
        to: { type: 'string', description: 'Destination symbol or file path for mode="path".' },
        target: { type: 'string', description: 'Target symbol name or file path for mode="doc_refs" or mode="explain".' },
        maxDepth: { type: 'integer', description: 'Maximum BFS hops for mode="path" (1..8, default 5).' },
        direction: { type: 'string', enum: ['both', 'directed'], description: 'Traversal direction for mode="path" (default both).' },
        maxClusters: { type: 'integer', description: 'Maximum clusters to return (default 8).' },
        maxGodNodes: { type: 'integer', description: 'Maximum God Nodes to return (default 5).' },
        workspaceRoot: { type: 'string', description: 'Workspace root directory (defaults to CWD).' },
      },
    },
  },
  {
    name: 'mutation_guard_check',
    description: 'Evaluates test suite strength on an isolated temporary copy using 1-point boundary operator mutations (>=, <=, ===, +/-1) without modifying the working tree.',
    annotations: {
      title: 'Semantic Mutation Test Guard',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Source file path under workspaceRoot.' },
        testFilePath: { type: 'string', description: 'Optional test file path (*.test.mjs); auto-resolved if omitted.' },
        workspaceRoot: { type: 'string', description: 'Workspace root directory (defaults to CWD).' },
        maxMutants: { type: 'integer', description: 'Maximum mutants to execute (default 4, max 6).' },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'ram_ccr_retrieve',
    description: 'Headroom CCR (Compress-Cache-Retrieve): retrieves exact line slices or regex/substring matches from locally cached uncompressed command output by its SmartCrumb hash without re-running commands.',
    annotations: {
      title: 'Headroom CCR Original Output Retrieve',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        hash: { type: 'string', description: 'Hex hash from the [📦 CCR #<hash>] SmartCrumb marker.' },
        query: { type: 'string', description: 'Optional case-insensitive substring or regex pattern to filter matching lines (+/- 2 context lines).' },
        startLine: { type: 'integer', description: '1-indexed start line when reading sequentially without query (default 1).' },
        endLine: { type: 'integer', description: 'Optional 1-indexed end line (default startLine + 119).' },
        maxChars: { type: 'integer', description: 'Maximum output characters (default 6000).' },
      },
      required: ['hash'],
    },
  },
  {
    name: 'ram_memory_recall',
    description: '3-layer progressive episodic session memory recall (claude-mem style): search compact index ("index"), inspect chronological neighborhood ("timeline"), or hydrate full episode details/decisions ("details").',
    annotations: {
      title: 'Episodic Session Memory Recall',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['index', 'timeline', 'details'], description: 'Progressive recall layer (default index).' },
        query: { type: 'string', description: 'Search query (RU/EN keywords or filename) for mode="index".' },
        kind: { type: 'string', enum: ['session', 'decision', 'bugfix', 'feature', 'refactor', 'discovery'], description: 'Optional episode kind filter.' },
        anchorId: { type: 'string', description: 'Episode ID or short prefix for mode="timeline".' },
        before: { type: 'integer', description: 'Episodes before anchor in timeline (default 2).' },
        after: { type: 'integer', description: 'Episodes after anchor in timeline (default 2).' },
        ids: { type: 'array', items: { type: 'string' }, description: 'Episode IDs or prefixes to hydrate in mode="details".' },
        limit: { type: 'integer', description: 'Max index rows (default 8).' },
        workspaceRoot: { type: 'string', description: 'Workspace root directory (defaults to CWD).' },
      },
    },
  },
];

function sendRpcMessage(msg) {
  const json = JSON.stringify(msg);
  if (useContentLengthFraming) {
    const byteLen = Buffer.byteLength(json, 'utf8');
    process.stdout.write(`Content-Length: ${byteLen}\r\n\r\n${json}`);
  } else {
    process.stdout.write(`${json}\n`);
  }
}

export function formatSemanticSearchHeader(res = {}) {
  if (res?.mode === 'hybrid_gpu_cpu_rerank') {
    return `[🎮 Hybrid GPU+CPU+RAM Search | ${res.model} | ${res.elapsedMs}ms + ${res.rerankElapsedMs ?? 0}ms CPU | ${res.totalChunksSearched} chunks]\n`;
  }
  if (res?.mode === 'hybrid_gpu_ram') {
    return `[🎮 Hybrid GPU+RAM Search | ${res.model} | ${res.elapsedMs}ms | ${res.totalChunksSearched} chunks]\n`;
  }
  return `[⚡ RAM Lexical Fallback${res?.gpuError ? ` (${res.gpuError})` : ''}]\n`;
}

export async function executeMcpTool(name, args = {}, opts = {}) {
  const safeArgs = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  args = safeArgs;
  const safeOpts = opts && typeof opts === 'object' && !Array.isArray(opts) ? opts : {};
  const activeEngine = safeOpts.engine || engine;
  const registerWs = safeOpts.engine ? () => {} : registerDaemonWorkspace;
  refreshBudgetFromState();
  const wsRoot = resolveDefaultWorkspace(safeArgs.workspaceRoot, safeArgs.filePath || '');
  if (name === 'gpu_distill' || name === 'gpu_semantic_search' || name === 'ram_context_pack') {
    const sentinel = loadedSentinel || await ensureSentinelLoaded();
    try {
      sentinel?.preempt?.('mcp_tool');
    } catch {}
  }

  switch (name) {
    case 'ram_search': {
      registerWs(wsRoot);
      const queryText = String(args.query || '');
      const maxResults = args.maxResults || 10;
      const contextLines = args.contextLines ?? 2;
      const appendFederated = (textOut) => {
        if (!args.includeFederated) return textOut;
        try {
          const activeHub = safeOpts.knowledgeHub || knowledgeHub;
          const stCfg = loadRamSettings();
          const fedRes = activeHub.searchFederatedPeers(wsRoot, queryText, activeEngine, {
            maxResults: 4,
            contextLines,
            extraPeers: safeOpts.federatedWorkspaces || stCfg.federatedWorkspaces || [],
          });
          if (fedRes?.formatted) {
            return `${textOut}\n\n${fedRes.formatted}`;
          }
        } catch {}
        return textOut;
      };
      const gpuCfg = safeOpts.gpuCfgOverride ? loadGpuConfig(safeOpts.gpuCfgOverride) : loadGpuConfig();
      if (gpuCfg.gpuEnabled && gpuCfg.gpuSemanticSearch && queryText.trim().length >= 5) {
        const semHits = await peekWarmSemanticTargets(wsRoot, queryText, {
          topK: Math.min(8, maxResults),
          minSim: 0.39,
          timeoutMs: 140,
          recordTelemetry: true,
        });
        if (semHits.length > 0) {
          const hyb = activeEngine.buildHybridGoldContext(wsRoot, queryText, semHits, {
            maxResults,
            contextLines,
          });
          if (hyb.ok && hyb.results.length > 0) {
            return {
              text: appendFederated(`[🎮 Hybrid GPU+RAM Search | ${gpuCfg.gpuEmbedModel} | ${semHits.length} semantic hits + BM25F]\n${hyb.formatted}`),
              isError: false,
            };
          }
        }
      }
      const res = activeEngine.search(wsRoot, queryText, {
        maxResults,
        contextLines,
      });
      return { text: appendFederated(res.formatted), isError: !res.ok };
    }
    case 'ram_slice': {
      registerWs(wsRoot);
      const res = activeEngine.slice(wsRoot, args.filePath || '', {
        symbol: args.symbol || '',
        section: args.section || '',
        startLine: args.startLine || 1,
        endLine: args.endLine || 120,
        skeleton: Boolean(args.skeleton),
        callGraph: Boolean(args.callGraph),
        query: args.query || '',
        maxChars: args.maxChars || 3200,
      });
      return { text: res.formatted, isError: !res.ok };
    }
    case 'ram_context_pack': {
      registerWs(wsRoot);
      const promptText = String(args.prompt || '');
      const warmSemanticHits = await peekWarmSemanticTargets(wsRoot, promptText, {
        topK: 6,
        minSim: 0.38,
        timeoutMs: 150,
        recordTelemetry: true,
      });
      const res = activeEngine.getContextPack(wsRoot, promptText, {
        maxChars: args.maxChars || 4800,
        warmSemanticHits,
        phase: args.phase || 'auto',
        toon: Boolean(args.toon),
      });
      return { text: res.formatted, isError: !res.ok };
    }
    case 'ram_warm_workspace': {
      registerWs(wsRoot);
      const res = await activeEngine.warmWorkspaceAsync(wsRoot, { maxFiles: args.maxFiles || 30000 });
      return { text: JSON.stringify(res, null, 2), isError: !res.ok };
    }
    case 'ram_stats': {
      if (args.evictTarget) {
        const ev = activeEngine.evict(args.evictTarget);
        return { text: canonicalizeJson({ evicted: ev, stats: activeEngine.getStats() }, 2), isError: false };
      }
      return { text: canonicalizeJson(activeEngine.getStats(), 2), isError: false };
    }
    case 'gpu_distill': {
      let res;
      if (args.filePath) {
        res = await distillLocalFile({
          filePath: args.filePath,
          workspaceRoot: wsRoot,
          startLine: args.startLine,
          endLine: args.endLine,
          query: args.query || '',
          mode: args.mode || 'general',
          maxOutputTokens: args.maxOutputTokens || 450,
        });
      } else if (args.text) {
        res = await distillText({
          text: args.text,
          workspaceRoot: wsRoot,
          query: args.query || '',
          mode: args.mode || 'general',
          maxOutputTokens: args.maxOutputTokens || 450,
        });
      } else {
        return { text: 'GPU Distill error: provide filePath or text.', isError: true };
      }
      if (!res.ok) {
        return { text: `GPU Distill unavailable: ${res.error}`, isError: true };
      }
      const fileTag = res.sourceFile ? ` | file: ${path.basename(res.sourceFile)}` : '';
      const header = `[🎮 Local GPU Digest | ${res.model} | ${res.latencyMs}ms | saved ~${res.savedTokensEstimate} tok (${res.originalChars}->${res.distilledChars} chars)${fileTag}]`;
      return { text: `${header}\n${res.summary}`, isError: false };
    }
    case 'gpu_semantic_search': {
      registerWs(wsRoot);
      const res = await activeEngine.searchSemantic(wsRoot, args.query || '', {
        maxResults: args.maxResults || 6,
        contextLines: args.contextLines ?? 2,
      });
      const prefix = formatSemanticSearchHeader(res);
      return { text: prefix + res.formatted, isError: !res.ok };
    }
    case 'gpu_status': {
      const action = args.action || 'status';
      if (action === 'unload') {
        const u = await unloadAllModels();
        return { text: JSON.stringify(u, null, 2), isError: !u.ok };
      }
      if (action === 'enforce_cap') {
        const capRes = await enforceVramCapInOllama();
        return { text: canonicalizeJson(capRes, 2), isError: !capRes.ok };
      }
      if (action === 'warm_host_ram') {
        const warmRes = await warmGgufModelsInHostRam({ force: true });
        return { text: canonicalizeJson(warmRes, 2), isError: !warmRes.ok };
      }
      if (action === 'warm_index') {
        registerWs(wsRoot);
        const ws = await activeEngine.warmWorkspaceAsync(wsRoot);
        if (!ws || !ws.files) return { text: 'Invalid workspaceRoot', isError: true };
        const wRes = await warmWorkspaceVectorsOnce(ws.absRoot, ws.files, {
          maxNewFiles: 300,
          ensureEmbed: true,
        });
        return { text: JSON.stringify(wRes, null, 2), isError: !wRes.ok };
      }
      const snap = await getGpuStatusSnapshot();
      return { text: canonicalizeJson(snap, 2), isError: false };
    }
    case 'lsp_diagnostics': {
      const fileArg = String(safeArgs.filePath || '').trim();
      if (!fileArg) return { text: 'LSP error: filePath is required.', isError: true };
      const ws = activeEngine.getOrCreateWorkspace(wsRoot);
      const relCand = path.isAbsolute(fileArg) ? path.relative(wsRoot, fileArg).replace(/\\/g, '/') : fileArg.replace(/\\/g, '/');
      const ramBuf = ws?.files?.get?.(relCand)?.buf;
      const res = await lspBridge.checkFileDiagnostics(
        wsRoot,
        fileArg,
        ramBuf ? ramBuf.toString('utf8') : undefined,
        {
          timeoutMs: safeArgs.timeoutMs || 350,
          waitFresh: true,
          serverCmdOverride: safeOpts.lspServerCmdOverride,
        }
      );
      if (!res.available) {
        return { text: `LSP unavailable for ${relCand} (language server not installed).`, isError: false };
      }
      return { text: canonicalizeJson(res, 2), isError: false };
    }
    case 'lsp_references': {
      const fileArg = String(safeArgs.filePath || '').trim();
      if (!fileArg) return { text: 'LSP error: filePath is required.', isError: true };
      const res = await lspBridge.queryReferencesAndHover(
        wsRoot,
        fileArg,
        safeArgs.line ?? (safeArgs.zeroIndexed ? 0 : 1),
        safeArgs.character ?? 0,
        {
          oneBased: safeArgs.zeroIndexed !== true,
          includeDeclaration: safeArgs.includeDeclaration !== false,
          timeoutMs: safeArgs.timeoutMs || 550,
          serverCmdOverride: safeOpts.lspServerCmdOverride,
        }
      );
      if (!res.available) {
        return { text: `LSP references unavailable for ${fileArg} (language server not installed).`, isError: false };
      }
      return { text: canonicalizeJson(res, 2), isError: false };
    }
    case 'lsp_code_actions': {
      const fileArg = String(safeArgs.filePath || '').trim();
      if (!fileArg) return { text: 'LSP error: filePath is required.', isError: true };
      const res = await lspBridge.requestFastCodeActions(wsRoot, fileArg, {
        apply: Boolean(safeArgs.apply),
        timeoutMs: safeArgs.timeoutMs || 550,
        serverCmdOverride: safeOpts.lspServerCmdOverride,
      });
      if (!res.available) {
        return { text: `LSP code actions unavailable for ${fileArg} (language server not installed).`, isError: false };
      }
      return { text: canonicalizeJson(res, 2), isError: false };
    }
    case 'git_bisect_auto': {
      const res = runAutomatedGitBisect({
        workspaceRoot: wsRoot,
        goodRef: safeArgs.goodRef || '',
        badRef: safeArgs.badRef || 'HEAD',
        testCommand: safeArgs.testCommand || '',
        timeoutMs: safeArgs.timeoutMs || 20000,
      });
      return { text: canonicalizeJson(res, 2), isError: !res.ok };
    }
    case 'mutation_guard_check': {
      const res = runSemanticMutationGuard({
        workspaceRoot: wsRoot,
        filePath: safeArgs.filePath || '',
        testFilePath: safeArgs.testFilePath || '',
        maxMutants: safeArgs.maxMutants || 4,
      });
      return { text: canonicalizeJson(res, 2), isError: !res.ok };
    }
    case 'ram_graph_query': {
      registerWs(wsRoot);
      const res = activeEngine.queryKnowledgeGraph(wsRoot, {
        mode: safeArgs.mode || 'summary',
        from: safeArgs.from || '',
        to: safeArgs.to || '',
        target: safeArgs.target || '',
        maxDepth: safeArgs.maxDepth,
        direction: safeArgs.direction || 'both',
        maxClusters: safeArgs.maxClusters,
        maxGodNodes: safeArgs.maxGodNodes,
      });
      return { text: res.formatted, isError: !res.ok };
    }
    case 'ram_ccr_retrieve': {
      const hub = safeOpts.knowledgeHub || knowledgeHub;
      const res = hub.retrieveCcrBlob({
        hash: safeArgs.hash || '',
        query: safeArgs.query || '',
        startLine: safeArgs.startLine ?? 1,
        endLine: safeArgs.endLine ?? 0,
        maxChars: safeArgs.maxChars ?? 6000,
      });
      if (!res.ok) {
        return { text: `CCR retrieve failed (${res.error || 'unknown'}) for hash "${String(safeArgs.hash || '')}".`, isError: true };
      }
      const header = `[📦 CCR #${res.hash} | ${res.source}${res.commandHint ? ` | ${res.commandHint.slice(0, 60)}` : ''} | L${res.returnedStartLine}-${res.returnedEndLine}/${res.totalLines}${res.matchCount ? ` | matches:${res.matchCount}` : ''}${res.truncated ? ' | truncated' : ''}]`;
      return { text: res.text ? `${header}\n${res.text}` : `${header}\n(no matching lines)`, isError: false };
    }
    case 'ram_memory_recall': {
      const hub = safeOpts.knowledgeHub || knowledgeHub;
      const mode = String(safeArgs.mode || 'index').toLowerCase();
      if (mode === 'timeline') {
        const res = hub.getSessionEpisodeTimeline({
          workspaceRoot: wsRoot,
          anchorId: safeArgs.anchorId || (Array.isArray(safeArgs.ids) ? safeArgs.ids[0] : ''),
          before: safeArgs.before ?? 2,
          after: safeArgs.after ?? 2,
        });
        return { text: canonicalizeJson(res, 2), isError: !res.ok };
      }
      if (mode === 'details') {
        const ids = Array.isArray(safeArgs.ids)
          ? safeArgs.ids
          : (safeArgs.anchorId ? [safeArgs.anchorId] : []);
        const res = hub.getSessionEpisodesByIds({ workspaceRoot: wsRoot, ids });
        return { text: canonicalizeJson(res, 2), isError: !res.ok };
      }
      const res = hub.searchSessionEpisodes({
        workspaceRoot: wsRoot,
        query: safeArgs.query || '',
        kind: safeArgs.kind || '',
        limit: safeArgs.limit ?? 8,
      });
      return { text: canonicalizeJson(res, 2), isError: !res.ok };
    }
    default:
      return { text: `Unknown tool: ${name}`, isError: true };
  }
}

function dispatchRpcPayload(msg) {
  if (Array.isArray(msg)) {
    for (const item of msg) {
      handleJsonRpcRequest(item);
    }
    return;
  }
  handleJsonRpcRequest(msg);
}

function handleJsonRpcRequest(req) {
  if (!req || typeof req !== 'object') return;
  const { id, method, params } = req;

  if (method === 'notifications/roots/list_changed') {
    if (params && typeof params === 'object') {
      extractClientRootFromInitialize(params);
    }
    return;
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
    return;
  }

  if (id === undefined || id === null) return;

  if (method === 'initialize') {
    extractClientRootFromInitialize(params);
    const clientVer = params?.protocolVersion || '2024-11-05';
    return sendRpcMessage({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: clientVer,
        capabilities: { tools: {} },
        serverInfo: { name: 'antigravity-ram-memory', version: '1.0.0' },
      },
    });
  }

  if (method === 'ping') {
    return sendRpcMessage({ jsonrpc: '2.0', id, result: {} });
  }

  if (method === 'tools/list') {
    return sendRpcMessage({
      jsonrpc: '2.0',
      id,
      result: { tools: MCP_TOOLS },
    });
  }

  if (method === 'tools/call') {
    const toolName = params?.name || '';
    const toolArgs = params?.arguments || {};
    executeMcpTool(toolName, toolArgs)
      .then((out) => {
        sendRpcMessage({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: out.text }],
            isError: Boolean(out.isError),
          },
        });
      })
      .catch((err) => {
        sendRpcMessage({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: `Error executing ${toolName}: ${err.message}` }],
            isError: true,
          },
        });
      });
    return;
  }

  return sendRpcMessage({
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `Method not found: ${method}` },
  });
}

// --- Dual-mode Stdio Parser (supports newline-delimited JSON, JSON-RPC batches & Content-Length framing) ---
let inputBuf = Buffer.alloc(0);

function drainInputBuffer() {
  while (inputBuf.length > 0) {
    // Strip leading whitespace / tabs / newlines before checking framing
    let start = 0;
    while (
      start < inputBuf.length &&
      (inputBuf[start] === 9 || inputBuf[start] === 10 || inputBuf[start] === 13 || inputBuf[start] === 32)
    ) {
      start++;
    }
    if (start > 0) inputBuf = inputBuf.subarray(start);
    if (inputBuf.length === 0) break;

    if (inputBuf.subarray(0, 15).toString('ascii').toLowerCase() === 'content-length:') {
      useContentLengthFraming = true;
      const crlfEnd = inputBuf.indexOf('\r\n\r\n');
      const lfEnd = inputBuf.indexOf('\n\n');
      let headerEnd = -1;
      let sepLen = 4;
      if (crlfEnd !== -1 && (lfEnd === -1 || crlfEnd <= lfEnd)) {
        headerEnd = crlfEnd;
        sepLen = 4;
      } else if (lfEnd !== -1) {
        headerEnd = lfEnd;
        sepLen = 2;
      }
      if (headerEnd === -1) break;
      const headerStr = inputBuf.subarray(0, headerEnd).toString('ascii');
      const m = headerStr.match(/content-length:\s*(\d+)/i);
      if (!m) {
        inputBuf = inputBuf.subarray(headerEnd + sepLen);
        continue;
      }
      const len = Number(m[1]);
      const msgStart = headerEnd + sepLen;
      if (inputBuf.length < msgStart + len) break;
      const bodyStr = inputBuf.subarray(msgStart, msgStart + len).toString('utf8');
      inputBuf = inputBuf.subarray(msgStart + len);
      try {
        dispatchRpcPayload(JSON.parse(bodyStr));
      } catch {}
    } else {
      const nlIdx = inputBuf.indexOf(10);
      if (nlIdx === -1) break;
      const lineStr = inputBuf.subarray(0, nlIdx).toString('utf8').trim();
      inputBuf = inputBuf.subarray(nlIdx + 1);
      if (!lineStr) continue;
      try {
        dispatchRpcPayload(JSON.parse(lineStr));
      } catch {}
    }
  }
}

const isMainEntry = (() => {
  try {
    if (!process.argv[1]) return false;
    const selfPath = path.resolve(fileURLToPath(import.meta.url));
    const entryPath = path.resolve(process.argv[1]);
    return process.platform === 'win32'
      ? selfPath.toLowerCase() === entryPath.toLowerCase()
      : selfPath === entryPath;
  } catch {
    return false;
  }
})();

if (isMainEntry) {
  startIpcServer();

  let mcpShutdownPromise = null;
  const triggerMcpGracefulExit = () => {
    if (mcpShutdownPromise) return mcpShutdownPromise;
    mcpShutdownPromise = handleMcpDaemonExit()
      .catch(() => {})
      .finally(() => {
        process.exit(0);
      });
    return mcpShutdownPromise;
  };

  process.stdin.on('data', (chunk) => {
    inputBuf = Buffer.concat([inputBuf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    drainInputBuffer();
  });

  process.stdin.on('end', () => void triggerMcpGracefulExit());
  process.stdin.on('close', () => void triggerMcpGracefulExit());
  process.on('SIGINT', () => void triggerMcpGracefulExit());
  process.on('SIGTERM', () => void triggerMcpGracefulExit());
  process.on('SIGHUP', () => void triggerMcpGracefulExit());
  process.on('SIGBREAK', () => void triggerMcpGracefulExit());
  process.once('exit', () => {
    try {
      loadedSentinel?.stopDaemonLoop?.();
    } catch {}
  });
}

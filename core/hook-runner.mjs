/**
 * @file hook-runner.mjs
 * @description Единый отказоустойчивый раннер хуков жизненного цикла Antigravity.
 * Поддерживает события SessionStart, PreInvocation, PreToolUse, PostToolUse.
 * Гарантирует код выхода 0 и корректный JSON при любых сбоях.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import * as nodeModule from 'node:module';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { safeReadJsonSync, updateJsonAtomicSync } from './safe-json.mjs';
import { pruneObjectMapByTimestamp, resolveTunnelCacheDir } from './cache-dir.mjs';
import { appendDebugLog } from './debug-logger.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, '..');
const CACHE_DIR = resolveTunnelCacheDir(PLUGIN_ROOT);
const ROUTER_STATE_FILE = join(PLUGIN_ROOT, 'router-state.json');
const getCacheDir = () => resolveTunnelCacheDir(PLUGIN_ROOT);
const getRamDaemonFile = () => join(getCacheDir(), 'ram-daemon.json');
const getPostCmdHintsFile = () => join(getCacheDir(), 'post-cmd-hints.json');
const getPreEditSnapshotFile = () => join(getCacheDir(), 'pre-edit-last.json');
const MAX_PRE_EDIT_SNAPSHOT_BYTES = 256 * 1024;
const MAX_TURN_ENTRIES = 64;
const TURN_ENTRY_TTL_MS = 2 * 60 * 60 * 1000;
const HAS_EXPLICIT_CODE_ANCHOR_RE = /(?:[a-z0-9_.-]+\.(?:mjs|cjs|js|jsx|ts|tsx|json|html|css|md|py|go|rs|sh|bat)\b|[\\/][a-zA-Z0-9_.-]+|`[^`]+`|\b[a-z]+[A-Z][a-zA-Z0-9]*\b|\b[a-zA-Z0-9]+_[a-zA-Z0-9_]+\b|\b(?:Error|TypeError|ReferenceError|SyntaxError|EACCES|ENOENT|npm|vitest|pytest)\b)/;

try {
  if (typeof nodeModule.enableCompileCache === 'function') {
    nodeModule.enableCompileCache(join(getCacheDir(), 'v8-compile-cache'));
  }
} catch {}

export function resolveUserLanguage(state = {}) {
  const raw = typeof state?.uiLanguage === 'string' ? state.uiLanguage.trim().toLowerCase() : '';
  if (raw === 'en') return 'en';
  if (raw === 'ru') return 'ru';
  return 'ru';
}

function resolveTaskProgressWorkspace(payload = {}) {
  return payload.workspacePaths?.[0] || payload.workspacePath || payload.cwd || '';
}

function buildStaticSessionStartHeader(state = {}) {
  const isEn = resolveUserLanguage(state) === 'en';
  const lines = [
    isEn
      ? '# The Tunnel v4.0.8 (EN-Internal / EN-Chat)'
      : '# The Tunnel v4.0.8 (EN-Internal / RU-Chat)',
    isEn
      ? '- User replies/UI/Role/toolSummary: 100% English.'
      : '- User replies/UI/Role/toolSummary: 100% Russian.',
    '- Internal thinking (unthrottled compact EN), subagent prompts/replies (<=6L), code comments: compact English.',
    '- Edits: use edit_file / diff-patcher; never full-overwrite >50L files.',
  ];
  const lean = typeof state?.leanMode === 'string' ? state.leanMode.trim().toLowerCase() : 'full';
  if (lean && lean !== 'off') {
    if (lean === 'lite') {
      lines.push('- Lean Senior (lite): prefer existing repo helpers -> stdlib -> native platform before writing new helpers.');
    } else {
      const ultraExtra = lean === 'ultra' ? ' Push back on speculative scope before building.' : '';
      lines.push(
        `- Lean Senior (${lean}): Ladder of Laziness: (1) Need to exist? (2) Already in repo? (3) Stdlib/platform? (4) Installed dep? (5) One readable line? (6) Minimum complete diff + 1 test on new branch/loop/parser/security. Mark deliberate deferrals with \`// shortcut: <ceiling>, <when to upgrade>\`; NEVER cut trust-boundary validation, security, or a11y.${ultraExtra}`
      );
    }
  }
  const terse = typeof state?.terseMode === 'string' ? state.terseMode.trim().toLowerCase() : 'off';
  if (terse === 'caveman' || terse === 'ultracave') {
    const cap = terse === 'ultracave' ? 12 : 20;
    lines.push(
      `- Controlled Brevity (${terse} · ASD-STE100): answer-first (\`[target] [action] [reason]\`, <=${cap} words/sentence, zero filler); keep code, paths, negations, numbers, and security warnings 100% exact.`
    );
  }
  const autoSpec = typeof state?.autoSpecMode === 'string' ? state.autoSpecMode.trim().toLowerCase() : 'auto';
  const autoSpecOutput = state?.autoSpecOutput === 'chat' ? 'chat' : 'thinking';
  if (autoSpec === 'auto' || autoSpec === 'always') {
    const scopeLabel = autoSpec === 'always' ? 'all coding tasks' : 'M/L/XL & Deep tasks';
    if (autoSpecOutput === 'chat') {
      lines.push(
        `- Internal Spec-First (${autoSpec} · chat): on ${scopeLabel}, scout target slices first and output a compact detailed execution prompt in chat (FILES+LINES | SYMBOLS & CONTRACTS | BLAST RADIUS | EDGE CASES | VERIFY) before planning or editing.`
      );
    } else {
      lines.push(
        `- Internal Spec-First (${autoSpec}): on ${scopeLabel}, scout target slices first and silently compile an internal execution prompt in <thinking> (FILES+LINES | CONTRACTS | BLAST RADIUS | EDGE CASES | VERIFY) before planning or editing.`
      );
    }
  }
  return lines;
}

function enqueuePostCommandHint(convoKey = 'default', hintText = '') {
  const cleanHint = typeof hintText === 'string' ? hintText.trim() : '';
  if (!cleanHint) return;
  const key = String(convoKey || 'default');
  try {
    updateJsonAtomicSync(getPostCmdHintsFile(), () => ({ queues: {} }), (qState) => {
      const queues = qState && typeof qState.queues === 'object' && !Array.isArray(qState.queues)
        ? { ...qState.queues }
        : {};
      const now = Date.now();
      for (const [k, list] of Object.entries(queues)) {
        if (!Array.isArray(list)) {
          delete queues[k];
          continue;
        }
        const fresh = list.filter((it) => it && it.text && (!it.ts || now - it.ts <= 30 * 60 * 1000));
        if (fresh.length > 0) queues[k] = fresh;
        else delete queues[k];
      }
      const prev = Array.isArray(queues[key]) ? queues[key] : [];
      queues[key] = [...prev.slice(-2), { text: cleanHint, ts: now }];
      return { queues };
    });
  } catch {}
}

function consumePostCommandHints(convoKey = 'default') {
  if (!existsSync(getPostCmdHintsFile())) return [];
  const key = String(convoKey || 'default');
  let consumed = [];
  try {
    updateJsonAtomicSync(getPostCmdHintsFile(), () => ({ queues: {} }), (qState) => {
      const queues = qState && typeof qState.queues === 'object' && !Array.isArray(qState.queues)
        ? { ...qState.queues }
        : {};
      const now = Date.now();
      for (const [k, list] of Object.entries(queues)) {
        if (!Array.isArray(list)) {
          delete queues[k];
          continue;
        }
        const fresh = list.filter((it) => it && it.text && (!it.ts || now - it.ts <= 30 * 60 * 1000));
        if (k === key) {
          consumed = fresh.map((it) => it.text);
          delete queues[k];
        } else if (fresh.length > 0) {
          queues[k] = fresh;
        } else {
          delete queues[k];
        }
      }
      return { queues };
    });
  } catch {}
  return consumed;
}

/**
 * Checks whether an OS PID is currently alive (<0.05ms).
 * @param {number|string} pid
 * @returns {boolean}
 */
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

/**
 * Selects a live RAM daemon entry matching the workspace (or newest live daemon).
 * @param {object} info
 * @param {string} [wsPath='']
 * @returns {object|null}
 */
function pickLiveRamDaemon(info, wsPath = '') {
  if (!info || typeof info !== 'object') return null;
  const candidates = [];
  if (info.instances && typeof info.instances === 'object') {
    for (const inst of Object.values(info.instances)) {
      if (inst && inst.port && inst.token && isPidAlive(inst.pid)) {
        candidates.push(inst);
      }
    }
  }
  if (candidates.length === 0 && info.port && info.token && isPidAlive(info.pid)) {
    candidates.push(info);
  }
  if (candidates.length === 0) return null;

  if (wsPath) {
    const absTarget = resolve(wsPath);
    const normTarget = process.platform === 'win32' ? absTarget.toLowerCase() : absTarget;
    const wsMatch = candidates.find(
      (c) =>
        Array.isArray(c.workspaces) &&
        c.workspaces.some((w) => {
          const nw = process.platform === 'win32' ? resolve(String(w)).toLowerCase() : resolve(String(w));
          return nw === normTarget;
        })
    );
    if (wsMatch) return wsMatch;
  }

  candidates.sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
  return candidates[0];
}

/**
 * Queries the persistent in-RAM MCP daemon over localhost IPC with a strict millisecond timeout.
 * Returns null silently if the daemon is offline or slow, allowing seamless disk fallback.
 * @param {string} endpoint
 * @param {object} payload
 * @param {number} [timeoutMs=60]
 * @returns {Promise<object|null>}
 */
async function queryRamDaemon(endpoint, payload = {}, timeoutMs = 60) {
  try {
    if (!existsSync(getRamDaemonFile())) return null;
    const rawInfo = JSON.parse(readFileSync(getRamDaemonFile(), 'utf8'));
    const info = pickLiveRamDaemon(rawInfo, payload?.wsPath || '');
    if (!info?.port || !info?.token) return null;

    const bodyStr = JSON.stringify(payload || {});
    return await new Promise((resolveReq) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: Number(info.port),
          path: endpoint,
          method: 'POST',
          timeout: timeoutMs,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(bodyStr),
            'x-ram-token': info.token,
          },
        },
        (res) => {
          let raw = '';
          res.setEncoding('utf8');
          res.on('data', (c) => { raw += c; });
          res.on('end', () => {
            try {
              resolveReq(raw ? JSON.parse(raw) : null);
            } catch {
              resolveReq(null);
            }
          });
        }
      );
      req.on('timeout', () => {
        try { req.destroy(); } catch {}
        resolveReq(null);
      });
      req.on('error', () => resolveReq(null));
      req.end(bodyStr);
    });
  } catch {
    return null;
  }
}

// Ленивые кэши модулей: каждый обработчик хука подгружает только нужные модули параллельно
let shadowGuard = null;
let autoVerifierMod = null;
let circuitBreaker = null;
let historyCompactor = null;
let pitfallLedger = null;
let repoMapper = null;
let toolPruner = null;
let diffPatcher = null;
let bayesianRouter = null;
let readDedup = null;
let sessionHandoff = null;
let executionTracker = null;
let skillCrystallizer = null;
let securityGuard = null;
let modelProfileMod = null;
let swarmController = null;
let localGpuMod = null;
let obsMasker = null;
let taskProgress = null;
let knowledgeHubMod = null;
let quotaPacerMod = null;
let completionGates = null;
let frictionObserver = null;

const depPromises = new Map();
const DEP_LOADERS = {
  shadowGuard: () => import('./shadow-guard.mjs').then((m) => { shadowGuard = m; return m; }),
  autoVerifierMod: () => import('./auto-verifier.mjs').then((m) => { autoVerifierMod = m; return m; }),
  circuitBreaker: () => import('./circuit-breaker.mjs').then((m) => { circuitBreaker = m; return m; }),
  historyCompactor: () => import('./history-compactor.mjs').then((m) => { historyCompactor = m; return m; }),
  pitfallLedger: () => import('./pitfall-ledger.mjs').then((m) => { pitfallLedger = m; return m; }),
  repoMapper: () => import('./repo-mapper.mjs').then((m) => { repoMapper = m; return m; }),
  toolPruner: () => import('./tool-pruner.mjs').then((m) => { toolPruner = m; return m; }),
  diffPatcher: () => import('./diff-patcher.mjs').then((m) => { diffPatcher = m; return m; }),
  bayesianRouter: () => import('./bayesian-router.mjs').then((m) => { bayesianRouter = m; return m; }),
  readDedup: () => import('./read-dedup.mjs').then((m) => { readDedup = m; return m; }),
  sessionHandoff: () => import('./session-handoff.mjs').then((m) => { sessionHandoff = m; return m; }),
  executionTracker: () => import('./execution-tracker.mjs').then((m) => { executionTracker = m; return m; }),
  skillCrystallizer: () => import('./skill-crystallizer.mjs').then((m) => { skillCrystallizer = m; return m; }),
  securityGuard: () => import('./security-guard.mjs').then((m) => { securityGuard = m; return m; }),
  modelProfileMod: () => import('./model-profile.mjs').then((m) => { modelProfileMod = m; return m; }),
  swarmController: () => import('./swarm-controller.mjs').then((m) => { swarmController = m; return m; }),
  localGpuMod: () => import('./local-gpu-engine.mjs').then((m) => { localGpuMod = m; return m; }),
  obsMasker: () => import('./obs-masker.mjs').then((m) => { obsMasker = m; return m; }),
  taskProgress: () => import('./task-progress.mjs').then((m) => { taskProgress = m; return m; }),
  knowledgeHub: () => import('./sqlite-knowledge-hub.mjs').then((m) => { knowledgeHubMod = m; return m; }),
  quotaPacer: () => import('./quota-pacer.mjs').then((m) => { quotaPacerMod = m; return m; }),
  completionGates: () => import('./completion-gates.mjs').then((m) => { completionGates = m; return m; }),
  frictionObserver: () => import('./friction-observer.mjs').then((m) => { frictionObserver = m; return m; }),
  cpuWorkerPool: () => import('./cpu-worker-pool.mjs').then((m) => m),
  floatingHud: () => import('./floating-hud.mjs').then((m) => m),
  runtimeWiretap: () => import('./runtime-wiretap.mjs').then((m) => m),
  cpuMutationGuard: () => import('./cpu-mutation-guard.mjs').then((m) => m),
  shortcutDebt: () => import('./shortcut-debt-ledger.mjs').then((m) => m),
};

function loadDepsByNames(names = []) {
  return Promise.all(
    names.map((name) => {
      if (!depPromises.has(name)) {
        const loader = DEP_LOADERS[name];
        const p = loader ? loader().catch(() => null) : Promise.resolve(null);
        depPromises.set(name, p);
      }
      return depPromises.get(name);
    })
  );
}

async function ensureHookDeps(eventName, toolName = '') {
  switch (eventName) {
    case 'SessionStart':
      return loadDepsByNames(['pitfallLedger', 'sessionHandoff', 'executionTracker', 'modelProfileMod', 'swarmController', 'taskProgress']);
    case 'PreInvocation':
      return loadDepsByNames([
        'circuitBreaker',
        'autoVerifierMod',
        'historyCompactor',
        'toolPruner',
        'bayesianRouter',
        'executionTracker',
        'skillCrystallizer',
        'sessionHandoff',
        'modelProfileMod',
        'swarmController',
        'localGpuMod',
        'repoMapper',
        'taskProgress',
      ]);
    case 'PreToolUse':
      if (toolName === 'ask_question' || toolName === 'invoke_subagent' || toolName === 'swarm') {
        return loadDepsByNames(['swarmController', 'modelProfileMod', 'taskProgress']);
      }
      if (toolName === 'read_file') {
        return loadDepsByNames(['swarmController', 'securityGuard', 'readDedup', 'modelProfileMod', 'taskProgress']);
      }
      if (toolName === 'run_command') {
        return loadDepsByNames(['swarmController', 'securityGuard', 'taskProgress']);
      }
      return loadDepsByNames([
        'swarmController',
        'modelProfileMod',
        'securityGuard',
        'diffPatcher',
        'shadowGuard',
        'circuitBreaker',
        'autoVerifierMod',
        'pitfallLedger',
        'taskProgress',
      ]);
    case 'PostToolUse':
      if (toolName === 'ask_question') {
        return loadDepsByNames(['swarmController', 'sessionHandoff', 'taskProgress']);
      }
      if (toolName === 'run_command') {
        return loadDepsByNames(['swarmController', 'circuitBreaker', 'executionTracker', 'obsMasker', 'localGpuMod', 'securityGuard', 'taskProgress', 'sessionHandoff', 'knowledgeHub', 'completionGates', 'frictionObserver']);
      }
      return loadDepsByNames([
        'swarmController',
        'shadowGuard',
        'readDedup',
        'autoVerifierMod',
        'circuitBreaker',
        'bayesianRouter',
        'pitfallLedger',
        'modelProfileMod',
        'executionTracker',
        'sessionHandoff',
        'securityGuard',
        'taskProgress',
        'completionGates',
        'frictionObserver',
        'knowledgeHub',
      ]);
    case 'Stop':
      return loadDepsByNames(['swarmController', 'taskProgress', 'executionTracker', 'sessionHandoff', 'knowledgeHub', 'completionGates']);
    default:
      return [];
  }
}

function getRouterStateFile() {
  const envPath = typeof process.env.TUNNEL_TEST_STATE_PATH === 'string' ? process.env.TUNNEL_TEST_STATE_PATH.trim() : '';
  return envPath ? resolve(envPath) : ROUTER_STATE_FILE;
}

/**
 * Читает текущие настройки router-state.json.
 * @returns {object}
 */
export function loadRouterState() {
  try {
    const stateFile = getRouterStateFile();
    if (existsSync(stateFile)) {
      return applyHookProfileOverrides(JSON.parse(readFileSync(stateFile, 'utf-8')));
    }
  } catch (err) {
    console.error('[hook] Failed to read router-state.json:', err);
  }
  return applyHookProfileOverrides({});
}

const VALID_HOOK_PROFILES = new Set(['minimal', 'standard', 'strict']);

/**
 * Applies Hook Strictness Profile overrides (`minimal` | `standard` | `strict`)
 * with optional `TUNNEL_HOOK_PROFILE` environment override.
 * @param {object} [rawState={}]
 * @param {object} [env=process.env]
 * @returns {object}
 */
export function applyHookProfileOverrides(rawState = {}, env = process.env) {
  const base = rawState && typeof rawState === 'object' && !Array.isArray(rawState) ? { ...rawState } : {};
  const rawEnv = typeof env?.TUNNEL_HOOK_PROFILE === 'string' ? env.TUNNEL_HOOK_PROFILE.trim().toLowerCase() : '';
  const rawStateProfile = typeof base.hookProfile === 'string' ? base.hookProfile.trim().toLowerCase() : '';
  const profile = VALID_HOOK_PROFILES.has(rawEnv)
    ? rawEnv
    : (VALID_HOOK_PROFILES.has(rawStateProfile) ? rawStateProfile : 'standard');

  if (profile === 'minimal') {
    return {
      ...base,
      hookProfile: 'minimal',
      cascadeVerify: false,
      testImpactVerify: false,
      gpuPostEditCritic: false,
      mutationGuardEnabled: false,
      sentinelLocalBugBot: false,
      blastRadius: false,
      skillCrystallizer: false,
      configProtection: false,
      completionGates: false,
    };
  }
  if (profile === 'strict') {
    return {
      ...base,
      hookProfile: 'strict',
      securityGuard: true,
      configProtection: true,
      selfVerify: true,
      cascadeVerify: true,
      testImpactVerify: true,
      transactionalPatch: true,
      circuitBreaker: true,
      blastRadius: true,
      lspBridgeEnabled: true,
      completionGates: true,
    };
  }
  return { ...base, hookProfile: 'standard' };
}

/**
 * Безопасно считывает JSON-полезную нагрузку из stdin.
 * @returns {Promise<object>}
 */
export async function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      return resolve({});
    }
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      try {
        resolve(data.trim() ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
    process.stdin.on('error', () => {
      resolve({});
    });
    // Таймаут безопасности при зависании дескриптора stdin
    setTimeout(() => {
      try {
        resolve(data.trim() ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    }, 1500).unref();
  });
}

/**
 * Формирует cache-aligned инъекцию инструкций и метаданных.
 * @param {object} params Параметры сборки инъекции.
 * @param {boolean} [params.isSessionStart=false] Событие SessionStart или PreInvocation.
 * @param {string} [params.repoMapMarkdown] Markdown карта репозитория.
 * @param {string} [params.pitfallsMarkdown] Markdown реестр предостережений.
 * @param {object} [params.pruningResult] Результат прунинга инструментов.
 * @param {object} [params.cascadeAlert] Активный алерт синтаксиса для эскалации.
 * @param {string} [params.blastRadiusHint] Предостережение об импортах (Blast Radius).
 * @param {string} [params.circuitAlert] Сигнал аварийного отключения Circuit Breaker.
 * @param {string} [params.compactionNotice] Уведомление об эпохе сжатия контекста.
 * @param {string} [params.thinkingBudgetHint] Рекомендованный бюджет мышления.
 * @param {string} [params.goldContextHint] Нарезка релевантного кода (Zero-Turn Gold Context).
 * @param {string} [params.bayesianHint] Рекомендация Байесовского маршрутизатора доверия.
 * @param {object} [params.state] Текущее состояние роутера.
 * @returns {object} Структура { injectSteps: [...] } или {}.
 */
export function buildCacheAlignedInjection(opts = {}) {
  const {
    isSessionStart = false,
    repoMapMarkdown = '',
    repoMapMaxChars = 4000,
    pitfallsMarkdown = '',
    handoffMarkdown = '',
    pruningResult = null,
    cascadeAlert = null,
    blastRadiusHint = '',
    circuitAlert = '',
    compactionNotice = '',
    thinkingBudgetHint = '',
    goldContextHint = '',
    bayesianHint = '',
    modelProfile = null,
    state = {},
  } = opts && typeof opts === 'object' ? opts : {};
  // 1. Статический блок начала сессии: фиксируется один раз, формируя префикс KV-кэша модели (>4096 tok для Gemini 4 Implicit Cache -95%)
  if (isSessionStart) {
    const staticBlocks = buildStaticSessionStartHeader(state);

    if (state.pitfallLedger !== false && pitfallsMarkdown && typeof pitfallsMarkdown === 'string') {
      const cleanPf = pitfallsMarkdown.replace(/\r\n/g, '\n').trim();
      if (cleanPf) {
        staticBlocks.push('', cleanPf);
      }
    }

    if (state.sessionHandoff !== false && handoffMarkdown && typeof handoffMarkdown === 'string') {
      const cleanHandoff = handoffMarkdown.replace(/\r\n/g, '\n').trim();
      if (cleanHandoff) {
        staticBlocks.push('', cleanHandoff);
      }
    }

    if (state.repoMap !== false && repoMapMarkdown && typeof repoMapMarkdown === 'string') {
      const cleanMap = repoMapMarkdown.replace(/\r\n/g, '\n').trim();
      let capChars = Math.max(2000, Number(repoMapMaxChars) || 4000);
      const staticPrefixChars = staticBlocks.join('\n').length;
      if (
        modelProfile?.isGemini4 &&
        !modelProfile?.isFlash &&
        staticPrefixChars + Math.min(cleanMap.length, capChars) < 14500 &&
        cleanMap.length > capChars
      ) {
        capChars = Math.max(capChars, 15000);
      }
      if (cleanMap.length > 0) {
        const trimmedMap =
          cleanMap.length > capChars
            ? cleanMap.slice(0, capChars) + `\n\n*(RepoMap truncated to ${capChars} chars)*`
            : cleanMap;
        staticBlocks.push('', '## Repo Map:', trimmedMap);
      }
    }

    return {
      injectSteps: [
        {
          systemMessage: {
            systemMessage: staticBlocks.join('\n'),
          },
        },
      ],
    };
  }

  // 2. Динамический блок шага инвокации (PreInvocation): Inverted Evidence Pyramid для Gemini 4 Carbon.
  // Слой А (СВЕРХУ): Сырые факты, дайджест эпохи, срезы кода (Gold Context), граф связей (Blast Radius) и телеметрия.
  // Слой Б (ВНИЗУ, вплотную к точке входа в thinking): Аварийные сигналы, якорь верификации и целевая директива автопилота.
  const dynamicLines = [];

  // --- Слой А: Доказательная база и контекст кода (Evidence First) ---
  if (compactionNotice && typeof compactionNotice === 'string' && compactionNotice.trim()) {
    dynamicLines.push(compactionNotice.trim());
  }

  if (goldContextHint && typeof goldContextHint === 'string' && goldContextHint.trim()) {
    dynamicLines.push(goldContextHint.trim());
  }

  if (blastRadiusHint && typeof blastRadiusHint === 'string' && blastRadiusHint.trim()) {
    dynamicLines.push(blastRadiusHint.trim());
  }

  if (bayesianHint && typeof bayesianHint === 'string' && bayesianHint.trim()) {
    dynamicLines.push(bayesianHint.trim());
  }

  if (pruningResult && pruningResult.allowedHint) {
    dynamicLines.push(pruningResult.allowedHint);
  }

  // --- Слой Б: Критические стоп-сигналы, якорь верификации и целевая директива (Directive Last) ---
  if (circuitAlert && typeof circuitAlert === 'string' && circuitAlert.trim()) {
    dynamicLines.push(circuitAlert.trim());
  }

  if (cascadeAlert) {
    const escLabel = modelProfile?.isOrchestrator ? 'Cascade->Planner' : 'Cascade->Pro';
    const escAction = modelProfile?.isOrchestrator
      ? 'Fix directly on Hydrogen if trivial, or hand back to Orchestrator planner if contract/plan needs revision.'
      : 'Fix or escalate to Model:"pro".';
    if (typeof cascadeAlert === 'string' && cascadeAlert.trim()) {
      dynamicLines.push(`⚠️ [${escLabel}] ${cascadeAlert.trim()}`);
    } else if (typeof cascadeAlert === 'object' && cascadeAlert.filePath) {
      dynamicLines.push(
        `⚠️ [${escLabel}] Syntax/test error in \`${cascadeAlert.filePath}\` (${cascadeAlert.checker || 'syntax'}): ${cascadeAlert.error}. ${escAction}`
      );
    }
    if (state.diffOnly !== false) {
      dynamicLines.push('⚓ [Diff-Only] Use edit_file / diff-patcher (>50L); never full-overwrite.');
    }
  }

  // Целевая директива мышления и автопилота — строго последней строкой перед фазой thinking
  if (thinkingBudgetHint && typeof thinkingBudgetHint === 'string' && thinkingBudgetHint.trim()) {
    dynamicLines.push(thinkingBudgetHint.trim());
  }

  if (dynamicLines.length === 0) {
    return {};
  }

  return {
    injectSteps: [
      {
        ephemeralMessage: dynamicLines.join('\n'),
      },
    ],
  };
}

const DOMAIN_LABELS_RU = {
  algo_refactor: 'код и рефакторинг',
  ui_browser: 'UI и фронтенд',
  backend_db: 'бэкенд и БД',
  devops: 'инфра и CLI',
  docs: 'документация',
  general: 'общий профиль',
};

const DOMAIN_LABELS_EN = {
  algo_refactor: 'code & refactoring',
  ui_browser: 'UI & frontend',
  backend_db: 'backend & DB',
  devops: 'infra & CLI',
  docs: 'documentation',
  general: 'general profile',
};

/**
 * Собирает нуль-токенную карточку режима через metadata.user_markdown (Antigravity 2.0):
 * строка отображается пользователю в интерфейсе чата и не расходует контекст модели.
 * @param {object} [params]
 * @returns {object|null}
 */
export function buildZeroTokenUserBadgeStep(rawOpts = {}) {
  const {
    grade = 'M',
    modelProfile = null,
    pruningResult = null,
    state = {},
    isPreReadEstimate = false,
  } = rawOpts && typeof rawOpts === 'object' ? rawOpts : {};
  if (state?.showBadge === false) return null;
  const isEn = resolveUserLanguage(state) === 'en';
  const cleanGrade = String(grade || 'M').toUpperCase();
  const strat = state?.strategy || state?.routingMode || '';
  const subSuffix = state?.subscriptionTier === 'ultra' ? ' · Ultra' : '';
  const modeLabel = isEn
    ? (strat === 'pro_architect' || strat === 'performance'
        ? `Pro Architect${subSuffix}`
        : strat === 'flash_dispatcher' || strat === 'economy'
          ? `Flash Dispatcher${subSuffix}`
          : `Autopilot v4.0.8${subSuffix}`)
    : (strat === 'pro_architect' || strat === 'performance'
        ? `Pro-Архитектор${subSuffix}`
        : strat === 'flash_dispatcher' || strat === 'economy'
          ? `Flash-Диспетчер${subSuffix}`
          : `Автопилот v4.0.8${subSuffix}`);
  const executor = isEn
    ? (modelProfile?.displayEn || modelProfile?.shortLabel || modelProfile?.displayRu || modelProfile?.displayNameRu || 'Current executor')
    : (modelProfile?.displayRu || modelProfile?.displayNameRu || modelProfile?.shortLabel || 'Текущий исполнитель');
  const domainKey = String(pruningResult?.domain || 'general').trim();
  const domainLabel = isEn
    ? (DOMAIN_LABELS_EN[domainKey] || domainKey)
    : (DOMAIN_LABELS_RU[domainKey] || domainKey);
  const gradeSegment = isEn
    ? (isPreReadEstimate
        ? `**Est. Scope:** ~${cleanGrade} (AI refines from code)`
        : `**Scope:** ${cleanGrade}`)
    : (isPreReadEstimate
        ? `**Пред-оценка:** ~${cleanGrade} (уточнит ИИ по коду)`
        : `**Сложность:** ${cleanGrade}`);
  const md = isEn
    ? `> 🎯 **Mode:** ${modeLabel} | ${gradeSegment} | **Executor:** ${executor} | **Profile:** ${domainLabel} · [The Tunnel](sidecar://antigravity-model-router/panel/)`
    : `> 🎯 **Режим:** ${modeLabel} | ${gradeSegment} | **Исполнитель:** ${executor} | **Профиль:** ${domainLabel} · [The Tunnel](sidecar://antigravity-model-router/panel/)`;
  return {
    systemMessage: {
      systemMessage: '',
      metadata: {
        user_markdown: md,
      },
    },
  };
}

const DRIFT_CHECK_FILES = [
  'plugin.json',
  'hooks.json',
  'rules/AGENTS.md',
  'core/hook-runner.mjs',
  'core/tool-pruner.mjs',
  'core/auto-verifier.mjs',
  'core/task-progress.mjs',
  'sidecars/panel/server.mjs',
  'sidecars/panel/ui.html',
];

/**
 * Проверяет расхождение (drift) ключевых файлов между dev-репозиторием antigravity-model-router
 * и установленным плагином в ~/.gemini/config/plugins/antigravity-model-router.
 * @param {object} [params]
 * @param {string} [params.repoRoot]
 * @param {string} [params.installedRoot]
 * @returns {{ checked: boolean, hasDrift: boolean, driftedFiles: string[], repoRoot?: string, installedRoot?: string }}
 */
export function checkInstalledPluginDrift(rawOpts = {}) {
  const { repoRoot = '', installedRoot = '' } = rawOpts && typeof rawOpts === 'object' ? rawOpts : {};
  if (!repoRoot) {
    return { checked: false, hasDrift: false, driftedFiles: [] };
  }
  const resolvedRepo = resolve(String(repoRoot));
  const resolvedInstalled = installedRoot
    ? resolve(String(installedRoot))
    : join(homedir(), '.gemini', 'config', 'plugins', 'antigravity-model-router');

  const normRepo = process.platform === 'win32' ? resolvedRepo.toLowerCase() : resolvedRepo;
  const normInst = process.platform === 'win32' ? resolvedInstalled.toLowerCase() : resolvedInstalled;
  if (normRepo === normInst) {
    return { checked: false, hasDrift: false, driftedFiles: [] };
  }
  if (!existsSync(resolvedRepo) || !existsSync(resolvedInstalled)) {
    return { checked: false, hasDrift: false, driftedFiles: [] };
  }

  const looksLikeRouterRepo =
    basename(resolvedRepo).toLowerCase() === 'antigravity-model-router' ||
    (existsSync(join(resolvedRepo, 'hooks.json')) && existsSync(join(resolvedRepo, 'core', 'hook-runner.mjs')));
  if (!looksLikeRouterRepo) {
    return { checked: false, hasDrift: false, driftedFiles: [] };
  }

  const sha1File = (filePath) => {
    const normContent = readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
    return createHash('sha1').update(normContent, 'utf8').digest('hex');
  };
  const driftedFiles = [];
  for (const rel of DRIFT_CHECK_FILES) {
    const repoFile = join(resolvedRepo, rel);
    const instFile = join(resolvedInstalled, rel);
    const hasRepo = existsSync(repoFile);
    const hasInst = existsSync(instFile);
    if (!hasRepo && !hasInst) continue;
    try {
      if (hasRepo !== hasInst || sha1File(repoFile) !== sha1File(instFile)) {
        driftedFiles.push(rel);
      }
    } catch {
      driftedFiles.push(rel);
    }
  }

  return {
    checked: true,
    hasDrift: driftedFiles.length > 0,
    driftedFiles,
    repoRoot: resolvedRepo,
    installedRoot: resolvedInstalled,
  };
}

/**
 * Обработчик события SessionStart.
 * @param {object} payload Данные от хука.
 * @param {object} state Состояние маршрутизатора.
 * @returns {Promise<object>}
 */
export async function handleSessionStart(payload = {}, rawState = {}) {
  const state = applyHookProfileOverrides(rawState);
  const wsPath =
    payload.workspacePaths?.[0] || payload.workspacePath || payload.cwd || process.cwd();

  await ensureHookDeps('SessionStart');

  const swarmCtx = swarmController?.detectSwarmExecutionRole
    ? swarmController.detectSwarmExecutionRole(payload)
    : { role: 'standalone', workerKind: '', isolationKey: String(payload.conversationId || 'default') };

  let calibratedState = state;
  const isEphemeralWs = Boolean(sessionHandoff?.isEphemeralTestWorkspace?.(wsPath));
  const isTestIsolated =
    process.env.TUNNEL_TEST_ISOLATE_INSTALLED === '1' ||
    Boolean(process.env.TUNNEL_TEST_STATE_PATH) ||
    Boolean(process.env.TUNNEL_CACHE_DIR);
  const hasExplicitWsPayload = Boolean(payload && (payload.workspacePaths?.[0] || payload.workspacePath || payload.cwd));
  if (
    !isEphemeralWs &&
    !isTestIsolated &&
    hasExplicitWsPayload &&
    swarmCtx.role === 'standalone' &&
    calibratedState.onboardingCompleted === false &&
    calibratedState.hardwareProfiled !== true
  ) {
    try {
      const hwMod = await import('./hardware-profiler.mjs');
      const calRes = await hwMod.ensureHardwareCalibratedOnce({
        pluginRoot: PLUGIN_ROOT,
        statePath: getRouterStateFile(),
      });
      if (calRes?.calibrated && calRes.state) {
        calibratedState = calRes.state;
      }
    } catch {}
  } else if (!isEphemeralWs && !isTestIsolated && hasExplicitWsPayload && swarmCtx.role !== 'swarm_worker') {
    try {
      const hwMod = await import('./hardware-profiler.mjs');
      hwMod?.syncMcpRamBudget?.(PLUGIN_ROOT, Number(calibratedState.ramMaxBudgetMb) || 4096, {
        resolveAbsoluteEntry: true,
        gpuEnabled: Boolean(calibratedState.gpuEnabled),
      });
    } catch {}
  }

  const effectiveState = swarmController?.applySwarmWorkerStateOverrides
    ? swarmController.applySwarmWorkerStateOverrides(calibratedState, swarmCtx)
    : calibratedState;

  let repoMapMarkdown = '';
  let pitfallsMarkdown = '';
  let handoffMarkdown = '';

  // 0. Извлечение сессионной памяти (Session Handoff), индекса 3-слойной памяти (claude-mem) и Shared Task Blackboard
  if (effectiveState.sessionHandoff !== false && sessionHandoff?.formatHandoffForSessionStart) {
    try {
      handoffMarkdown = sessionHandoff.formatHandoffForSessionStart(wsPath, payload.conversationId || '');
    } catch (err) {
      console.error('[hook] sessionHandoff failed in SessionStart:', err);
    }
  }

  if (
    !isEphemeralWs &&
    effectiveState.sessionHandoff !== false &&
    effectiveState.sqliteKnowledgeEnabled !== false &&
    swarmCtx.role === 'standalone'
  ) {
    try {
      await loadDepsByNames(['knowledgeHub']);
      const epIndex = knowledgeHubMod?.knowledgeHub?.formatSessionMemoryIndexForStart?.(wsPath, { limit: 5, maxChars: 480 });
      if (epIndex && epIndex.trim()) {
        handoffMarkdown = handoffMarkdown ? `${handoffMarkdown}\n\n${epIndex.trim()}` : epIndex.trim();
      }
    } catch {}
  }

  if (effectiveState.sessionHandoff !== false && effectiveState.repoMap !== false && executionTracker?.formatBlackboardForSubagent) {
    try {
      const bb = executionTracker.formatBlackboardForSubagent({
        workspaceRoot: wsPath,
        conversationId: payload.conversationId || 'default',
      });
      if (bb && bb.trim()) {
        handoffMarkdown = handoffMarkdown ? `${handoffMarkdown}\n\n${bb.trim()}` : bb.trim();
      }
    } catch (err) {
      console.error('[hook] formatBlackboardForSubagent failed in SessionStart:', err);
    }
  }

  // 1. Извлечённые уроки и правила из Pitfall Ledger
  if (effectiveState.pitfallLedger !== false && pitfallLedger?.formatPitfallsForSessionStart) {
    try {
      pitfallsMarkdown = pitfallLedger.formatPitfallsForSessionStart(wsPath);
    } catch (err) {
      console.error('[hook] formatPitfallsForSessionStart failed in SessionStart:', err);
    }
  }

  // 2. Структура проекта (Repo Map с графовым PageRank-ранжированием при включённом pageRankGraph)
  const sessionModelProfile = modelProfileMod?.resolveActiveModelProfile
    ? modelProfileMod.resolveActiveModelProfile({
        modelName: payload.modelName || '',
        userInput: payload.lastUserInput || payload.prompt || '',
        transcriptPath: payload.transcriptPath || '',
        conversationId: payload.conversationId || '',
      })
    : null;
  const existingPrefixChars = (pitfallsMarkdown?.length || 0) + (handoffMarkdown?.length || 0);
  const repoMapMaxChars = modelProfileMod?.resolveAdaptiveRepoMapMaxChars
    ? modelProfileMod.resolveAdaptiveRepoMapMaxChars(sessionModelProfile, existingPrefixChars)
    : modelProfileMod?.resolveRepoMapMaxChars
      ? modelProfileMod.resolveRepoMapMaxChars(sessionModelProfile)
      : 4000;

  if (effectiveState.repoMap !== false) {
    let ramMapLoaded = false;
    if (effectiveState.ramCacheEnabled !== false && wsPath) {
      const ramRes = await queryRamDaemon('/hook/session-start', { wsPath, maxChars: repoMapMaxChars }, 75);
      if (ramRes?.ok && ramRes.warm && ramRes.repoMapMarkdown) {
        repoMapMarkdown = ramRes.repoMapMarkdown;
        ramMapLoaded = true;
      }
    }
    if (!ramMapLoaded && wsPath) {
      await loadDepsByNames(['repoMapper']);
    }
    if (!ramMapLoaded && repoMapper && wsPath) {
      try {
        const map =
          effectiveState.pageRankGraph !== false && typeof repoMapper.getCompactRankedRepoMap === 'function'
            ? await repoMapper.getCompactRankedRepoMap(wsPath, repoMapMaxChars)
            : typeof repoMapper.getCachedRepoMap === 'function'
              ? await repoMapper.getCachedRepoMap(wsPath)
              : null;
        if (map) {
          repoMapMarkdown = map.markdown || '';
        }
      } catch (err) {
        console.error('[hook] repoMapper failed in SessionStart:', err);
      }
    }
  }

  const injection = buildCacheAlignedInjection({
    isSessionStart: true,
    repoMapMarkdown,
    repoMapMaxChars,
    pitfallsMarkdown,
    handoffMarkdown,
    modelProfile: sessionModelProfile,
    state: effectiveState,
  });

  if (swarmCtx.role === 'standalone') {
    try {
      const driftRes = checkInstalledPluginDrift({
        repoRoot: wsPath,
        installedRoot: payload._installedRoot || PLUGIN_ROOT,
      });
      if (driftRes.hasDrift && injection?.injectSteps?.[0]?.systemMessage) {
        const curMsg = injection.injectSteps[0].systemMessage.systemMessage || '';
        const isEnDrift = resolveUserLanguage(effectiveState) === 'en';
        const notice = isEnDrift
          ? `\n\n> 🔄 **[Plugin Drift]** Installed plugin is behind dev repository (${driftRes.driftedFiles.join(', ')}). Run \`node install.js\` after finishing edits.`
          : `\n\n> 🔄 **[Plugin Drift]** Установленный плагин отстаёт от dev-репозитория (${driftRes.driftedFiles.join(', ')}). После завершения правок выполните \`node install.js\`.`;
        injection.injectSteps[0].systemMessage.systemMessage = `${curMsg}${notice}`;
      }
    } catch {}
  }

  if (effectiveState.floatingHudEnabled === true) {
    try {
      const [hudMod] = await loadDepsByNames(['floatingHud']);
      hudMod?.ensureFloatingHudRunning?.({ state: effectiveState });
    } catch {}
  }

  return injection;
}

/**
 * Обработчик события PreInvocation.
 * @param {object} payload Данные от хука.
 * @param {object} state Состояние маршрутизатора.
 * @returns {Promise<object>}
 */
export async function handlePreInvocation(payload = {}, rawState = {}) {
  const state = applyHookProfileOverrides(rawState);
  let pruningResult = null;
  let cascadeAlert = null;
  let circuitAlert = '';
  let thinkingBudgetHint = '';
  let blastRadiusHint = '';
  let compactionNotice = '';
  let goldContextHint = '';
  let bayesianHint = '';
  let budgetGrade = 'M';
  let outerReadOnlyQuestion = false;
  let isContinuationMetaTurn = false;
  let semanticSkills = [];
  let skillIndexWarm = false;

  const wsPath =
    payload.workspacePaths?.[0] || payload.workspacePath || payload.cwd || process.cwd();
  const userInput = payload.lastUserInput || payload.prompt || payload.userInput || '';

  await loadDepsByNames(['swarmController', 'modelProfileMod']);

  const swarmCtx = swarmController?.detectSwarmExecutionRole
    ? swarmController.detectSwarmExecutionRole(payload)
    : {
        role: 'standalone',
        workerKind: '',
        explicitSwarmRequest: false,
        hasQuotaSignal: false,
        isolationKey: String(payload.conversationId || 'default'),
      };
  const baseState = swarmController?.applySwarmWorkerStateOverrides
    ? swarmController.applySwarmWorkerStateOverrides(state, swarmCtx)
    : state;
  const convoId = swarmCtx.isolationKey || String(payload.conversationId || 'default');
  let activeModelProfile = modelProfileMod?.resolveActiveModelProfile
    ? modelProfileMod.resolveActiveModelProfile({
        modelName: payload.modelName || '',
        userInput,
        transcriptPath: payload.transcriptPath || '',
        conversationId: payload.conversationId || '',
      })
    : null;

  // Дедупликация шага внутри одного хода пользователя (lock-free чтение; запись ровно 1 раз ниже в конце блока first-step)
  let isFirstStepOfTurn = Boolean(payload._forceFullPreInvocation);
  let prevTurnSnapshot = null;
  let turnHash = '';
  const turnFile = join(getCacheDir(), 'pre-invocation-turn.json');
  const cachedTurns = safeReadJsonSync(turnFile, () => ({ turns: {} }), { selfHeal: false });
  const cachedPrev = (cachedTurns?.turns && Object.hasOwn(cachedTurns.turns, convoId)) ? cachedTurns.turns[convoId] : null;
  if (userInput.trim() && !payload._forceFullPreInvocation) {
    turnHash = createHash('sha1').update(`${convoId}::${userInput.trim()}`).digest('hex').slice(0, 16);
    const now = Date.now();
    const isApprovedActiveTurn = Boolean(cachedPrev?.askQuestionCalled || cachedPrev?.planHandedOff);
    const turnTtlMs = isApprovedActiveTurn ? 2 * 60 * 60 * 1000 : 10 * 60 * 1000;
    if (cachedPrev && cachedPrev.hash === turnHash && (now - (cachedPrev.ts || 0) < turnTtlMs)) {
      isFirstStepOfTurn = false;
      prevTurnSnapshot = cachedPrev;
    } else {
      isFirstStepOfTurn = true;
    }
  } else if (!payload._forceFullPreInvocation) {
    // Subagent continuation or tool-result step with empty userInput: read prior turn snapshot without re-injecting first-step banners
    if (cachedPrev) {
      prevTurnSnapshot = cachedPrev;
    }
  }

  if (
    activeModelProfile &&
    !activeModelProfile.isOrchestrator &&
    (activeModelProfile.isNeon || activeModelProfile.isCarbon || activeModelProfile.isArgon) &&
    (cachedPrev?.planHandedOff || cachedPrev?.isPlanReview || /^\[plan review/i.test(userInput.trim())) &&
    typeof modelProfileMod?.normalizeModelProfile === 'function'
  ) {
    activeModelProfile = modelProfileMod.normalizeModelProfile(`Orchestrator ${activeModelProfile.rawName}`);
  }

  await loadDepsByNames(
    isFirstStepOfTurn
      ? [
          'circuitBreaker',
          'autoVerifierMod',
          'historyCompactor',
          'toolPruner',
          'bayesianRouter',
          'executionTracker',
          'skillCrystallizer',
          'sessionHandoff',
          'localGpuMod',
          'repoMapper',
          'taskProgress',
        ]
      : [
          'circuitBreaker',
          'autoVerifierMod',
          'historyCompactor',
          'executionTracker',
          'skillCrystallizer',
          'taskProgress',
        ]
  );

  // 1. Проверка аварийного автомата защиты (Thrashing Circuit Breaker)
  if (baseState.circuitBreaker !== false && circuitBreaker?.getCircuitState) {
    try {
      const cb = circuitBreaker.getCircuitState({ workspaceRoot: wsPath, conversationId: convoId });
      if (cb && cb.status === 'TRIPPED') {
        circuitAlert = `🛑 [CIRCUIT BREAKER TRIPPED] ${cb.reason}. Stop blind retries; switch approach or escalate to Pro.`;
      }
    } catch (err) {
      console.error('[hook] Circuit Breaker check failed in PreInvocation:', err);
    }
  }

  let pendingTurnEntry = null;

  if (isFirstStepOfTurn) {
    const effectiveState = { ...baseState };
    let matchedRepoFilesCount = 0;
    let matchedRepoFiles = [];
    let subsystemHits = 0;
    let isReadOnlyQuestion = false;
    const isBoardWakeup = /^(?:\[board\]\s+the latest message is #\d+|\[Message\]\s+timestamp=.*\[swarm\])/i.test(userInput.trim());
    isContinuationMetaTurn = isBoardWakeup;
    let isPlanReviewTurn = /^\s*\[plan review(?:\s+due)?\]/i.test(userInput.trim());
    let ramGoldLoaded = false;
    let semanticFiles = [];
    const generatedTurnId = turnHash ? `turn_${Date.now()}_${turnHash.slice(0, 8)}` : '';
    const cleanTurnLabel = userInput.trim().replace(/\s+/g, ' ').slice(0, 90);
    pendingTurnEntry = turnHash
      ? {
          hash: turnHash,
          turnId: generatedTurnId,
          turnLabel: cleanTurnLabel,
          lastUserPrompt: userInput.slice(0, 500),
          ts: Date.now(),
          wasReadOnly: false,
          askQuestionCalled: false,
          modelSwitchPending: false,
          preTaskGateRequired: null,
          editGateWarned: false,
          planHandedOff: false,
          proposedGrade: null,
          selectorWarned: false,
          boilerplateWarned: false,
          carryOverSent: false,
        }
      : null;

    // 1.9. Единый ранний запрос к RAM + тёплому GPU-индексу (<190мс): получаем Hybrid Gold Context (BM25 + Qwen3 RRF), семантические цели и скиллы
    if (
      baseState.ramCacheEnabled !== false &&
      userInput.trim().length >= 8 &&
      wsPath &&
      !isBoardWakeup &&
      !/^(?:\[plan review(?:\s+due)?\]|A1\s*:)/i.test(userInput.trim())
    ) {
      try {
        const preConvoId = swarmCtx?.isolationKey || payload.conversationId || 'default';
        const ramPreRes = await queryRamDaemon('/hook/pre-invocation', { wsPath, query: userInput, convoId: preConvoId }, 260);
        if (Array.isArray(ramPreRes?.semanticFiles)) {
          semanticFiles = ramPreRes.semanticFiles;
        }
        if (Array.isArray(ramPreRes?.semanticSkills)) {
          semanticSkills = ramPreRes.semanticSkills;
        }
        if (typeof ramPreRes?.skillIndexWarm === 'boolean') {
          skillIndexWarm = ramPreRes.skillIndexWarm;
        }
        if (baseState.zeroTurnSlices !== false && userInput.trim().length >= 10 && ramPreRes?.ok && ramPreRes.goldContextHint) {
          goldContextHint = ramPreRes.goldContextHint;
          ramGoldLoaded = true;
        } else if (!ramGoldLoaded && baseState.ramSotaEngines !== false && ramPreRes?.repairKvHint) {
          goldContextHint = ramPreRes.repairKvHint;
        }
      } catch {}
    }

    if (
      !skillIndexWarm &&
      Boolean(baseState.gpuEnabled) &&
      baseState.gpuSemanticSearch !== false &&
      userInput.trim().length >= 8 &&
      !isBoardWakeup &&
      !/^(?:\[plan review(?:\s+due)?\]|A1\s*:)/i.test(userInput.trim()) &&
      typeof localGpuMod?.peekWarmSemanticSkills === 'function'
    ) {
      try {
        const directSkillRes = await localGpuMod.peekWarmSemanticSkills(userInput, { timeoutMs: 180, wsAbsRoot: wsPath });
        if (Array.isArray(directSkillRes?.semanticSkills)) {
          semanticSkills = directSkillRes.semanticSkills;
        }
        skillIndexWarm = Boolean(directSkillRes?.skillIndexWarm);
      } catch {}
    }

    // 1.95. Предварительная классификация домена и оценка хрупкости целевых файлов (Bayesian v2 + File Fragility -> 2D Depth Boost)
    if (toolPruner && typeof toolPruner.classifyTaskAndPruneTools === 'function') {
      try {
        pruningResult = toolPruner.classifyTaskAndPruneTools(userInput, effectiveState, {
          wsPath,
          repoMapper,
          semanticSkills,
          skillIndexWarm,
        });
      } catch (err) {
        console.error('[hook] classifyTaskAndPruneTools failed:', err);
      }
    }

    let preScope = null;
    if (toolPruner && typeof toolPruner.estimateCodebaseScope === 'function') {
      try {
        preScope = toolPruner.estimateCodebaseScope(userInput, { wsPath, repoMapper, semanticFiles });
      } catch {}
    }

    let fragilityDepthBoost = 0;
    if (
      baseState.bayesianRouter !== false &&
      bayesianRouter &&
      !preScope?.signals?.isReadOnlyQuestion &&
      Array.isArray(preScope?.matchedFiles) &&
      preScope.matchedFiles.length > 0 &&
      typeof bayesianRouter.evaluateTargetsFragility === 'function'
    ) {
      try {
        const fragSummary = bayesianRouter.evaluateTargetsFragility({
          matchedFiles: preScope.matchedFiles,
          domain: pruningResult?.domain || 'general',
          workspaceRoot: wsPath,
          modelTier: activeModelProfile?.plannerTier || activeModelProfile?.tier || '',
          grade: preScope?.grade || 'M',
        });
        fragilityDepthBoost = Number(fragSummary?.depthBoost || 0);
        if (fragSummary?.formattedHint) {
          bayesianHint = fragSummary.formattedHint;
        }
      } catch (err) {
        console.error('[hook] evaluateTargetsFragility failed in PreInvocation:', err);
      }
    }

    // 2. Когнитивный ИИ-Автопилот v4.0.8 (3D-матрица Breadth × Depth × Risk + безлимитное EN-мышление на Gemini 4)
    if (baseState.thinkingLimiter !== false && toolPruner && typeof toolPruner.estimateTaskGradeAndThinkingBudget === 'function') {
      try {
        const budgetRes = toolPruner.estimateTaskGradeAndThinkingBudget(userInput, effectiveState, {
          wsPath,
          repoMapper,
          modelProfile: activeModelProfile,
          semanticFiles,
          fragilityDepthBoost,
          precomputedScope: preScope,
          prevTurnGrade: cachedPrev?.grade || null,
          prevTurnMatrix: cachedPrev?.matrix2D || null,
          prevAskQuestionCalled: cachedPrev && typeof cachedPrev.askQuestionCalled === 'boolean' ? cachedPrev.askQuestionCalled : undefined,
          prevWasReadOnly: Boolean(cachedPrev?.wasReadOnly),
          prevProposedGrade: cachedPrev?.proposedGrade || null,
          prevModelSwitchPending: Boolean(cachedPrev?.modelSwitchPending),
        });
        thinkingBudgetHint = budgetRes?.budgetHint || budgetRes?.formattedHint || budgetRes?.hint || '';
        matchedRepoFiles = budgetRes?.scope?.matchedFiles || [];
        matchedRepoFilesCount = matchedRepoFiles.length;
        subsystemHits = Number(budgetRes?.subsystemHits || 0);
        isReadOnlyQuestion = Boolean(budgetRes?.isReadOnlyQuestion);
        outerReadOnlyQuestion = isReadOnlyQuestion;
        if (budgetRes?.isPlanReview) isPlanReviewTurn = true;
        isContinuationMetaTurn = Boolean(
          isBoardWakeup ||
          budgetRes?.isApprovalFollowUp ||
          budgetRes?.isPlanReview ||
          /^(?:\[plan review(?:\s+due)?\]|A\d+\s*:)/i.test(userInput.trim())
        );
        if (budgetRes?.grade) {
          budgetGrade = budgetRes.grade;
        }
        const selEval = budgetRes?.selectorEval || null;
        const matrix2D = budgetRes?.matrix2D || null;
        if (isReadOnlyQuestion && !isContinuationMetaTurn) {
          if (pendingTurnEntry) {
            const rawMatrixGrade = budgetRes?.matrix3D?.grade;
            const resolvedProposedGrade =
              (rawMatrixGrade && rawMatrixGrade !== 'S' ? rawMatrixGrade : null) ||
              (preScope?.grade && preScope.grade !== 'S' ? preScope.grade : null) ||
              (cachedPrev?.proposedGrade && cachedPrev.proposedGrade !== 'S' ? cachedPrev.proposedGrade : null) ||
              (cachedPrev?.grade && cachedPrev.grade !== 'S' ? cachedPrev.grade : null) ||
              'M';
            pendingTurnEntry = {
              ...pendingTurnEntry,
              grade: 'S',
              wasReadOnly: true,
              askQuestionCalled: false,
              modelSwitchPending: false,
              preTaskGateRequired: false,
              isPlanReview: Boolean(isPlanReviewTurn),
              editGateWarned: false,
              planHandedOff: false,
              proposedGrade: resolvedProposedGrade,
              matrix2D,
              isDeepAuditOrArch: false,
              selectorMatch: 'optimal',
              selectorTip: '',
            };
          }
        } else {
          const preTaskGateRequired = Boolean(
            effectiveState.confirmBeforeRun !== false &&
            !isContinuationMetaTurn &&
            (
              budgetRes?.requiresTwoPhaseGate ||
              /\[Pre-Task Gate: ON|\[Two-Phase Plan Gate/.test(thinkingBudgetHint) ||
              /\[UI\/UX Design Preview Gate\]/.test(pruningResult?.allowedHint || '')
            )
          );
          const answeredStructuredAsk = /^A\d+\s*:/i.test(userInput.trim());
          pendingTurnEntry = {
            ...(pendingTurnEntry || { hash: turnHash || '', ts: Date.now(), wasReadOnly: false, askQuestionCalled: false, preTaskGateRequired: false, isPlanReview: false, editGateWarned: false, planHandedOff: false, proposedGrade: null, selectorWarned: false, boilerplateWarned: false, carryOverSent: false }),
            grade: budgetGrade || cachedPrev?.grade || 'M',
            wasReadOnly: false,
            proposedGrade: budgetGrade || cachedPrev?.proposedGrade || 'M',
            matrix2D: matrix2D || cachedPrev?.matrix2D || null,
            isDeepAuditOrArch: Boolean(matrix2D?.isDeepAuditOrArch),
            isPlanReview: Boolean(isPlanReviewTurn),
            preTaskGateRequired: isPlanReviewTurn ? false : preTaskGateRequired,
            askQuestionCalled: isPlanReviewTurn
              ? true
              : (isContinuationMetaTurn ? Boolean(cachedPrev?.askQuestionCalled || budgetRes?.isApprovalFollowUp || answeredStructuredAsk) : false),
            modelSwitchPending: Boolean(!isContinuationMetaTurn && !isPlanReviewTurn && budgetRes?.modelSwitchSplitTurn),
            editGateWarned: isContinuationMetaTurn ? Boolean(cachedPrev?.editGateWarned) : false,
            planHandedOff: isContinuationMetaTurn ? Boolean(cachedPrev?.planHandedOff) : false,
            selectorWarned: isContinuationMetaTurn ? Boolean(cachedPrev?.selectorWarned) : false,
            boilerplateWarned: isContinuationMetaTurn ? Boolean(cachedPrev?.boilerplateWarned) : false,
            selectorMatch: selEval?.match || 'optimal',
            selectorCurrent: selEval?.currentDisplayRu || '',
            selectorCurrentEn: selEval?.currentDisplayEn || '',
            selectorRecommended: selEval?.recommendedRu || '',
            selectorTip: selEval?.tipRu || '',
          };
        }
      } catch (err) {
        console.error('[hook] estimateTaskGradeAndThinkingBudget failed in PreInvocation:', err);
      }
    }

    if (toolPruner?.resolveLeanMode && toolPruner?.resolveTerseMode) {
      try {
        const effLean = toolPruner.resolveLeanMode(userInput, effectiveState);
        const curLean = typeof effectiveState?.leanMode === 'string' ? effectiveState.leanMode.trim().toLowerCase() : 'full';
        if (effLean !== curLean) {
          const leanDir = effLean === 'off'
            ? '- Lean Senior (off): prompt override deactivated minimal-diff ladder for this turn.'
            : toolPruner.buildLeanModeDirective?.(effLean);
          if (leanDir) {
            thinkingBudgetHint = thinkingBudgetHint ? `${thinkingBudgetHint}\n${leanDir}` : leanDir;
          }
        }
        const effTerse = toolPruner.resolveTerseMode(userInput, effectiveState);
        const curTerse = typeof effectiveState?.terseMode === 'string' ? effectiveState.terseMode.trim().toLowerCase() : 'off';
        if (effTerse !== curTerse) {
          const terseDir = effTerse === 'off'
            ? '- Controlled Brevity (off): prompt override restored standard prose style.'
            : toolPruner.buildTerseModeDirective?.(effTerse);
          if (terseDir) {
            thinkingBudgetHint = thinkingBudgetHint ? `${thinkingBudgetHint}\n${terseDir}` : terseDir;
          }
        }
      } catch {}
    }

    const effAutoSpecMode = toolPruner?.resolveAutoSpecMode
      ? toolPruner.resolveAutoSpecMode(userInput, effectiveState)
      : (typeof effectiveState?.autoSpecMode === 'string' ? effectiveState.autoSpecMode.trim().toLowerCase() : 'auto');
    const hasExplicitSpecOverride = /(?:^|\s)\/(?:spec|autospec\s+always)\b/i.test(userInput);
    if (!isReadOnlyQuestion && (!isContinuationMetaTurn || hasExplicitSpecOverride) && toolPruner?.compileVoiceOrLongRuPromptPivot) {
      try {
        const pivot = toolPruner.compileVoiceOrLongRuPromptPivot(userInput, {
          wsPath,
          repoMapper,
          forceAlways: effAutoSpecMode === 'always',
        });
        if (pivot?.triggered && pivot.formattedPivot) {
          thinkingBudgetHint = thinkingBudgetHint
            ? `${thinkingBudgetHint}\n${pivot.formattedPivot}`
            : pivot.formattedPivot;
        }
      } catch {}
    }

    // 2.4. Автоматическая инициализация / продолжение этапов задачи для статус-бара внутри панели
    if (swarmCtx.role === 'standalone' || swarmCtx.role === 'coordinator') {
      try {
        if (taskProgress?.initTaskProgressFromPrompt) {
          taskProgress.initTaskProgressFromPrompt({
            conversationId: convoId,
            workspaceRoot: resolveTaskProgressWorkspace(payload),
            transcriptPath: payload.transcriptPath || '',
            userPrompt: userInput,
            grade: budgetGrade || 'M',
            matchedFilesCount: matchedRepoFilesCount,
            matchedFiles: Array.isArray(matchedRepoFiles) ? matchedRepoFiles.slice(0, 6) : [],
            domain: pruningResult?.domain || '',
            isReadOnlyQuestion: isPlanReviewTurn ? false : isReadOnlyQuestion,
            resumeIfWaiting: isContinuationMetaTurn,
            isPlanReview: isPlanReviewTurn,
            isOrchestratorMode: Boolean(activeModelProfile?.isOrchestrator),
          });
        }
      } catch {}
    }

    // 2.5. Адаптивный контроллер нативного Роя (Swarm Auto-Tiering, Worker Guard & Quota Failover)
    if (swarmController?.evaluateSwarmRoutingDirective) {
      try {
        const swRes = swarmController.evaluateSwarmRoutingDirective({
          state: effectiveState,
          modelProfile: activeModelProfile,
          grade: budgetGrade,
          matchedFilesCount: matchedRepoFilesCount,
          subsystemHits,
          isReadOnlyQuestion,
          swarmCtx,
        });
        if (swRes?.directiveEn) {
          thinkingBudgetHint = thinkingBudgetHint
            ? `${thinkingBudgetHint}\n${swRes.directiveEn}`
            : swRes.directiveEn;
        }
      } catch (err) {
        console.error('[hook] evaluateSwarmRoutingDirective failed in PreInvocation:', err);
      }
    }

    // 2.6. Советник локальной GPU (при сыром тексте >=1500 или отсутствии совпадений в RAM/GPU/RepoMap)
    const rawLen = userInput.length;
    const isLargePayload = rawLen >= 1500;
    const needsSemanticGpu = !isReadOnlyQuestion && !ramGoldLoaded && semanticFiles.length === 0 && matchedRepoFilesCount === 0 && userInput.trim().length >= 30;
    if (
      (isLargePayload || needsSemanticGpu) &&
      baseState.gpuEnabled !== false &&
      baseState.gpuShowPreTaskAdvice !== false &&
      swarmCtx.role !== 'swarm_worker' &&
      localGpuMod
    ) {
      try {
        const gpuCfg = localGpuMod.loadGpuConfig(baseState);
        const hasOllama = Boolean(localGpuMod.findOllamaBinary?.());
        if (hasOllama || gpuCfg.gpuEndpoint) {
          const fit = typeof localGpuMod.evaluateVramModelFit === 'function'
            ? localGpuMod.evaluateVramModelFit({ cfg: gpuCfg })
            : null;
          const chatBlockedByVramCap = Boolean(fit && !fit.selectedSizeFits && !fit.bestFallbackChatModel);
          const limitGb = Math.round((gpuCfg.gpuMaxVramMb || 12288) / 1024);
          const effectiveChatModel = (fit && !fit.selectedSizeFits && fit.bestFallbackChatModel)
            ? fit.bestFallbackChatModel
            : gpuCfg.gpuChatModel;
          const gpuDirective = isLargePayload
            ? (chatBlockedByVramCap
                ? ''
                : `🎮 [Local GPU Copilot (${effectiveChatModel} | ${limitGb}GB VRAM)] Large input (${rawLen} chars) — run gpu_distill first to compress noise.`)
            : `🎮 [Local GPU Copilot (${gpuCfg.gpuEmbedModel} | ${limitGb}GB VRAM)] No exact lexical target — try gpu_semantic_search if needed (keep code edits on Gemini 4).`;
          if (gpuDirective) {
            thinkingBudgetHint = thinkingBudgetHint ? `${thinkingBudgetHint}\n${gpuDirective}` : gpuDirective;
          }
        }
      } catch {}
    }

    // 3.1. Запись текущей цели в Session Handoff и на общую доску задачи (Shared Task Blackboard)
    if (
      baseState.sessionHandoff !== false &&
      !isContinuationMetaTurn &&
      swarmCtx.role !== 'swarm_worker' &&
      userInput.trim().length >= 10 &&
      sessionHandoff?.recordHandoffGoal
    ) {
      try {
        sessionHandoff.recordHandoffGoal({
          workspaceRoot: wsPath,
          conversationId: payload.conversationId || '',
          userPrompt: userInput,
          domain: pruningResult?.domain || 'general',
        });
      } catch (err) {
        console.error('[hook] recordHandoffGoal failed in PreInvocation:', err);
      }
    }

    if (
      !isContinuationMetaTurn &&
      swarmCtx.workerKind !== 'narrator' &&
      swarmCtx.workerKind !== 'monitor' &&
      userInput.trim().length >= 10 &&
      executionTracker?.updateTaskBlackboard
    ) {
      try {
        executionTracker.updateTaskBlackboard({
          workspaceRoot: wsPath,
          conversationId: convoId,
          goal: userInput,
          inspectedFiles: matchedRepoFiles.map((m) => m.file).filter(Boolean),
        });
      } catch {}
    }

    // 3.5. Отсечение нерелевантного Gold Context на чисто разговорных вопросах без кодовых якорей
    const hasExplicitCodeAnchor = HAS_EXPLICIT_CODE_ANCHOR_RE.test(userInput);
    if (isReadOnlyQuestion && !isContinuationMetaTurn && matchedRepoFilesCount === 0 && !hasExplicitCodeAnchor) {
      goldContextHint = '';
    }

    // 3.6. Нарезка «Золотого контекста» (disk fallback, если не пришёл из единого RAM/GPU запроса на шаге 1.9)
    if (
      !ramGoldLoaded &&
      baseState.zeroTurnSlices !== false &&
      userInput.trim().length >= 10 &&
      wsPath &&
      matchedRepoFilesCount > 0 &&
      repoMapper &&
      typeof repoMapper.extractGoldContextSlices === 'function'
    ) {
      try {
        const goldRes = await repoMapper.extractGoldContextSlices(wsPath, userInput);
        if (goldRes && Array.isArray(goldRes.slices) && goldRes.slices.length > 0 && goldRes.formattedHint) {
          goldContextHint = goldContextHint ? `${goldRes.formattedHint}\n${goldContextHint}` : goldRes.formattedHint;
        }
      } catch (err) {
        console.error('[hook] extractGoldContextSlices failed in PreInvocation:', err);
      }
    }
  } else {
    if (
      baseState.confirmBeforeRun !== false &&
      swarmCtx.role !== 'swarm_worker' &&
      !swarmCtx.hasQuotaSignal &&
      prevTurnSnapshot &&
      !prevTurnSnapshot.askQuestionCalled &&
      prevTurnSnapshot.wasReadOnly !== true &&
      prevTurnSnapshot.preTaskGateRequired !== false
    ) {
      const isEnLang = resolveUserLanguage(state) === 'en';
      const activeDisp = isEnLang
        ? (activeModelProfile?.displayEn || activeModelProfile?.displayRu || prevTurnSnapshot.selectorCurrentEn || prevTurnSnapshot.selectorCurrent || 'auto')
        : (activeModelProfile?.displayRu || prevTurnSnapshot.selectorCurrent || 'auto');
      const orchReminder = !activeModelProfile?.isOrchestrator
        ? (isEnLang
            ? ` On multi-file L/XL, Deep, or High-Blast tasks, prefer Orchestrator (Neon · High/XHigh) / Orchestrator (Carbon · Medium/High) over standalone Carbon/Neon (-24% quota + fast Hydrogen edits) and include "💡 Mode tip" when active selector differs (if <plan_execute_protocol> or exit_plan_mode is active in your system prompt, UI is already in Orchestrator · ${activeDisp} — treat active selector as Orchestrator · ${activeDisp} and skip redundant standalone switch advice)!`
            : ` On multi-file L/XL, Deep, or High-Blast tasks, prefer Orchestrator (Neon · Высокий/XHigh) / Orchestrator (Carbon · Средний/Высокий) over standalone Carbon/Neon (-24% quota + fast Hydrogen edits) and include "💡 Совет по режиму" when active selector differs (if <plan_execute_protocol> or exit_plan_mode is active in your system prompt, UI is already in Оркестратор · ${activeDisp} — treat active selector as Оркестратор · ${activeDisp} and skip redundant standalone switch advice)!`)
        : '';
      const splitTurnReminder = (prevTurnSnapshot.selectorMatch && prevTurnSnapshot.selectorMatch !== 'optimal')
        ? (isEnLang
            ? ` [AGY 2.35.2+ Split-Turn] If post-scout confirms switching to ${prevTurnSnapshot.selectorRecommended || 'the optimal model'} is needed, do NOT call ask_question — output the plan + 3 numbered options + "💡 Mode tip" in plain text and end the turn so the next message runs on the new model (or include "⏸ End turn to switch model" if ask_question is required for architectural forks).`
            : ` [AGY 2.35.2+ Split-Turn] Если после разведки смена модели на ${prevTurnSnapshot.selectorRecommended || 'оптимальную модель'} нужна, НЕ вызывай ask_question — выведи план + 3 пронумерованных варианта + "💡 Совет по режиму" обычным текстом и заверши ход, чтобы следующее сообщение пошло на новой модели (либо добавь вариант "⏸ Завершить ход, чтобы я переключил модель", если ask_question нужен для развилок).`)
        : '';
      const carryLine = isEnLang
        ? `🧭 [Post-Scout AI Triage | Active Selector: ${activeDisp}] Base final scope (S/M/L/XL) & optimal model strictly on the files you just inspected (override pre-read ~${prevTurnSnapshot.grade || 'M'} if code is simpler or deeper), and keep EN chat, ask_question ("Scope", "Recommended power", "💡 Mode tip" if optimal != ${activeDisp}), and option #1 100% synchronized; ALWAYS include explicit thinking/planner depth for BOTH standalone models AND Orchestrator (e.g. Hydrogen · Medium/High, Neon · High/XHigh, Carbon · High, Orchestrator (Neon · Medium/High/XHigh), Orchestrator (Carbon · Medium/High) — never bare model or bare Orchestrator names). If post-scout downgrades scope to S (or routine M), MUST also downgrade Recommended power to Hydrogen · Medium (for S) or Hydrogen · Medium/High (for routine M) — NEVER echo a heavy active selector (Neon · High/XHigh, Carbon, Orchestrator (Neon · High)) for an S task, and append "💡 Mode tip" when active selector is heavier.${orchReminder}${splitTurnReminder}`
        : `🧭 [Post-Scout AI Triage | Active Selector: ${activeDisp}] Base final scope (S/M/L/XL) & optimal model strictly on the files you just inspected (override pre-read ~${prevTurnSnapshot.grade || 'M'} if code is simpler or deeper), and keep RU chat, ask_question ("Объём", "Рекомендуемая мощность", "💡 Совет по режиму" if optimal != ${activeDisp}), and option #1 100% synchronized; ALWAYS include explicit thinking/planner depth for BOTH standalone models AND Orchestrator (e.g. Hydrogen · Средний/Высокий, Neon · Высокий/XHigh, Carbon · Высокий, Orchestrator (Neon · Средний/Высокий/XHigh), Orchestrator (Carbon · Средний/Высокий) — never bare model or bare Orchestrator names). Если после разведки объём понижен до S (или рутинного M), ОБЯЗАЛЬНО понизь и «Рекомендуемая мощность» до Hydrogen · Средний (для S) или Hydrogen · Средний/Высокий (для рутинного M) — НИКОГДА не копируй тяжёлый активный селектор (Neon · Высокий/XHigh, Carbon, Orchestrator (Neon · Высокий)) для задачи S, и добавь «💡 Совет по режиму» при избыточном селекторе.${orchReminder}${splitTurnReminder}`;
      thinkingBudgetHint = thinkingBudgetHint ? `${thinkingBudgetHint}\n${carryLine}` : carryLine;
      if (!prevTurnSnapshot.carryOverSent) {
        try {
          updateJsonAtomicSync(turnFile, () => ({ turns: {} }), (tState) => {
            const turns = (tState && typeof tState.turns === 'object') ? tState.turns : {};
            if (Object.hasOwn(turns, convoId) && turns[convoId]) {
              turns[convoId] = { ...turns[convoId], carryOverSent: true };
            }
            return { turns };
          });
        } catch {}
      }
    }
    if (swarmCtx.hasQuotaSignal && swarmController?.evaluateSwarmRoutingDirective) {
      // На промежуточных шагах перехватываем сигнал исчерпания квоты Роя [quota] мгновенно
      try {
        const swRes = swarmController.evaluateSwarmRoutingDirective({
          state: baseState,
          modelProfile: activeModelProfile,
          swarmCtx,
        });
        if (swRes?.directiveEn) {
          thinkingBudgetHint = thinkingBudgetHint ? `${thinkingBudgetHint}\n${swRes.directiveEn}` : swRes.directiveEn;
        }
      } catch {}
    }
  }

  // 4. Каскадная авто-эскалация синтаксиса
  if (baseState.selfVerify !== false && baseState.cascadeVerify !== false && autoVerifierMod?.popCascadeAlert) {
    try {
      cascadeAlert = autoVerifierMod.popCascadeAlert(convoId);
    } catch (err) {
      console.error('[hook] popCascadeAlert failed in PreInvocation:', err);
    }
  }

  // 4.5. Доставка сжатых итогов run_command (GPU Auto-Distill / ObsMasking) из очереди PostToolUse
  const queuedCmdHints = consumePostCommandHints(convoId);
  if (queuedCmdHints.length > 0) {
    const joinedCmdHints = queuedCmdHints.join('\n');
    goldContextHint = goldContextHint ? `${goldContextHint}\n${joinedCmdHints}` : joinedCmdHints;
  }

  // 5. Извлечение накопленного предостережения Blast Radius (изолированно по convoId / ветке Роя)
  const blastQueueFile = join(getCacheDir(), 'blast-radius-queue.json');
  try {
    if (existsSync(blastQueueFile)) {
      updateJsonAtomicSync(blastQueueFile, () => ({ queues: {} }), (qState) => {
        if (qState && typeof qState.queues === 'object' && !Array.isArray(qState.queues)) {
          const now = Date.now();
          for (const [k, item] of Object.entries(qState.queues)) {
            if (!item || (item.ts && now - item.ts > 10 * 60 * 1000)) {
              delete qState.queues[k];
            }
          }
          const mine = Object.hasOwn(qState.queues, convoId) ? qState.queues[convoId] : null;
          if (mine && mine.hint) {
            blastRadiusHint = mine.hint;
            delete qState.queues[convoId];
          }
          return qState;
        }
        // Обратная совместимость со старым одиночным форматом
        if (qState && qState.hint) {
          const isFresh = !qState.ts || (Date.now() - qState.ts <= 10 * 60 * 1000);
          const sameWs = !qState.workspaceRoot || !wsPath || resolve(qState.workspaceRoot).toLowerCase() === resolve(wsPath).toLowerCase();
          if (isFresh && sameWs) {
            blastRadiusHint = qState.hint;
          }
        }
        return { queues: {} };
      });
    }
  } catch (err) {
    console.error('[hook] blast-radius-queue extraction failed in PreInvocation:', err);
  }

  // 5.5. Живой трекер выполнения задачи, контроль контрактов и Fault Frame (Execution Tracker)
  if (executionTracker?.consumeTaskExecutionHint) {
    try {
      const execHint = executionTracker.consumeTaskExecutionHint({
        workspaceRoot: wsPath,
        conversationId: convoId,
      });
      if (execHint) {
        blastRadiusHint = blastRadiusHint ? `${blastRadiusHint}\n${execHint}` : execHint;
      }
    } catch (err) {
      console.error('[hook] consumeTaskExecutionHint failed in PreInvocation:', err);
    }
  }

  // 5.6. Проверка ворот кристаллизации скиллов (Auto-Skill Crystallizer: explicit на 1-м шаге или barrier_overcome после фикса)
  if (baseState.skillCrystallizer !== false && swarmCtx.role !== 'swarm_worker' && skillCrystallizer?.evaluateCrystallizationGate) {
    try {
      const crysSignals = executionTracker?.getTaskCrystallizationSignals
        ? executionTracker.getTaskCrystallizationSignals({
            workspaceRoot: wsPath,
            conversationId: convoId,
            consume: true,
          })
        : {};
      const gateFn = typeof skillCrystallizer?.evaluateCrystallizationGateAi === 'function'
        ? skillCrystallizer.evaluateCrystallizationGateAi
        : skillCrystallizer.evaluateCrystallizationGate;
      const crysRes = await gateFn({
        userPrompt: isFirstStepOfTurn ? userInput : '',
        conversationId: convoId,
        overcameBarrier: Boolean(crysSignals?.overcameBarrier),
        verifiedFilesCount: Number(crysSignals?.verifiedFilesCount || 0),
        recoveredFilesCount: Number(crysSignals?.recoveredFilesCount || 0),
        editedFiles: Array.isArray(crysSignals?.editedFiles) ? crysSignals.editedFiles : [],
        lastBarrierSummary: crysSignals?.lastBarrierSummary || '',
        semanticSkills,
        timeoutMs: 1800,
      });
      if (crysRes?.shouldCrystallize && crysRes.formattedHint) {
        blastRadiusHint = blastRadiusHint ? `${blastRadiusHint}\n${crysRes.formattedHint}` : crysRes.formattedHint;
      }
    } catch (err) {
      console.error('[hook] evaluateCrystallizationGate failed in PreInvocation:', err);
    }
  }

  // 5.7. Task-Observer Friction Detector: фиксация явных коррекций пользователя в project_instincts (без правки SKILL.md)
  const isEphemeralPreWs = Boolean(sessionHandoff?.isEphemeralTestWorkspace?.(wsPath));
  if (
    isFirstStepOfTurn &&
    !isContinuationMetaTurn &&
    !isEphemeralPreWs &&
    baseState.skillCrystallizer !== false &&
    baseState.sqliteKnowledgeEnabled !== false &&
    swarmCtx.role === 'standalone' &&
    userInput.trim().length >= 10
  ) {
    try {
      const [fricMod, hubMod] = await loadDepsByNames(['frictionObserver', 'knowledgeHub']);
      const fric = fricMod?.detectUserCorrectionFriction?.(userInput, {
        touchedFiles: matchedRepoFiles,
        semanticSkills,
      });
      if (fric?.detected && fric.candidatePattern && hubMod?.knowledgeHub) {
        const rec = fricMod.recordFrictionObservation({
          workspaceRoot: wsPath,
          signalType: fric.signalType,
          pattern: fric.candidatePattern,
          targetSkill: fric.targetSkillHint || '',
          hub: hubMod.knowledgeHub,
          lang: resolveUserLanguage(baseState),
        });
        if (rec?.readyForPromotion && rec.promotionHint) {
          blastRadiusHint = blastRadiusHint ? `${blastRadiusHint}\n${rec.promotionHint}` : rec.promotionHint;
        }
      }
    } catch {}
  }

  // 6. Проверка дискретных эпох истории диалога (Cache-Aligned & Strategic Compaction)
  if (baseState.historyCompaction !== false && historyCompactor?.checkHistoryCompaction) {
    try {
      const pendingPhaseTransition =
        typeof cachedPrev?.pendingPhaseTransition === 'string' ? cachedPrev.pendingPhaseTransition : '';
      if (pendingPhaseTransition && !isFirstStepOfTurn && existsSync(turnFile)) {
        try {
          updateJsonAtomicSync(turnFile, () => ({ turns: {} }), (tState) => {
            const turns = tState?.turns && typeof tState.turns === 'object' ? { ...tState.turns } : {};
            if (Object.hasOwn(turns, convoId) && turns[convoId]) {
              turns[convoId] = { ...turns[convoId], pendingPhaseTransition: '' };
            }
            return { turns };
          }, { spaces: 0 });
        } catch {}
      }
      const effectiveCompactionThreshold = modelProfileMod?.resolveEffectiveCompactionThreshold
        ? modelProfileMod.resolveEffectiveCompactionThreshold(
            baseState.compactionTokenThreshold || 120000,
            activeModelProfile
          )
        : baseState.compactionTokenThreshold || 120000;
      const compRes = await historyCompactor.checkHistoryCompaction({
        conversationId: convoId || payload.conversationId || '',
        transcriptPath: payload.transcriptPath || '',
        thresholdTokens: effectiveCompactionThreshold,
        workspaceRoot: wsPath,
        phaseTransition: pendingPhaseTransition,
        lang: resolveUserLanguage(baseState),
      });
      if (compRes?.compactionNotice) {
        compactionNotice = compRes.compactionNotice;
        if (baseState.sessionHandoff !== false && sessionHandoff?.recordHandoffGoal && userInput.trim()) {
          try {
            sessionHandoff.recordHandoffGoal({
              workspaceRoot: wsPath,
              conversationId: payload.conversationId || convoId || '',
              userPrompt: userInput,
              domain: pruningResult?.domain || 'general',
            });
          } catch {}
        }
      }
    } catch (err) {
      console.error('[hook] checkHistoryCompaction failed in PreInvocation:', err);
    }
  }

  // На промежуточных шагах инструментов не дублируем статическую подсказку Diff-Only
  const effectiveState = isFirstStepOfTurn ? baseState : { ...baseState, diffOnly: false, splitExecution: false };

  // Совет по пакетному чтению файлов (Gemini 4 multi-turn cache delta >= 2050 tokens)
  if (activeModelProfile?.isGemini4) {
    const batchNudge = consumeReadBatchAdvisory(convoId);
    if (batchNudge) {
      thinkingBudgetHint = thinkingBudgetHint ? `${thinkingBudgetHint}\n${batchNudge}` : batchNudge;
    }
  }

  const injection = buildCacheAlignedInjection({
    isSessionStart: false,
    pruningResult,
    cascadeAlert,
    blastRadiusHint,
    circuitAlert,
    compactionNotice,
    thinkingBudgetHint,
    goldContextHint,
    bayesianHint,
    modelProfile: activeModelProfile,
    state: effectiveState,
  });

  if (
    effectiveState?.experimentalUserMarkdownBadge === true &&
    payload.hookEventName === 'PreInvocation' &&
    isFirstStepOfTurn &&
    !pruningResult?.isReadOnlyQuestion &&
    !outerReadOnlyQuestion &&
    swarmCtx.role === 'standalone' &&
    Array.isArray(injection?.injectSteps) &&
    injection.injectSteps.length > 0
  ) {
    const badgeStep = buildZeroTokenUserBadgeStep({
      grade: budgetGrade,
      modelProfile: activeModelProfile,
      pruningResult,
      state: effectiveState,
      isPreReadEstimate: Boolean(effectiveState?.confirmBeforeRun !== false && !isContinuationMetaTurn),
    });
    if (badgeStep) {
      injection.injectSteps.push(badgeStep);
    }
  }

  if (baseState.quotaPacerEnabled !== false) {
    try {
      await loadDepsByNames(['quotaPacer']);
      if (isFirstStepOfTurn && quotaPacerMod?.recordQuotaTurnSample) {
        quotaPacerMod.recordQuotaTurnSample({
          tier: activeModelProfile?.tier || (activeModelProfile?.isOrchestrator ? 'orchestrator' : 'hydrogen'),
          thinkingLevel: activeModelProfile?.thinkingLevel || undefined,
          convoId,
          tokens: Math.round((userInput.length || 0) / 3),
        });
      }
      if (isFirstStepOfTurn && quotaPacerMod?.auditPrefixStability && Array.isArray(injection?.injectSteps) && injection.injectSteps[0]?.systemMessage?.systemMessage) {
        quotaPacerMod.auditPrefixStability({
          convoId,
          staticPrefix: String(injection.injectSteps[0].systemMessage.systemMessage).slice(0, 6000),
          dynamicTail: thinkingBudgetHint,
        });
      }
    } catch {}
  }

  if (isFirstStepOfTurn && pendingTurnEntry) {
    try {
      circuitBreaker?.resetToolRoundHistory?.({ conversationId: convoId });
    } catch {}
    try {
      updateJsonAtomicSync(turnFile, () => ({ turns: {} }), (tState) => {
        const rawTurns = (tState && typeof tState.turns === 'object') ? { ...tState.turns } : {};
        rawTurns[convoId] = pendingTurnEntry;
        const turns = pruneObjectMapByTimestamp(rawTurns, {
          maxEntries: MAX_TURN_ENTRIES,
          maxAgeMs: TURN_ENTRY_TTL_MS,
          getTs: (v) => Number(v?.ts || 0),
        });
        return { turns };
      }, { spaces: 0 });
    } catch {}
  }

  if (effectiveState.floatingHudEnabled === true) {
    try {
      const [hudMod] = await loadDepsByNames(['floatingHud']);
      hudMod?.ensureFloatingHudRunning?.({ state: effectiveState });
    } catch {}
  }

  return injection;
}

/**
 * Tracks read_file calls inside the current model turn (between PreInvocation boundaries).
 * Parallel reads within one turn increment readsInTurn without counting as sequential single-read turns.
 * @param {object} params
 */
function recordReadBatchActivity({ convoId = 'default', toolName = '' } = {}) {
  const telemetryFile = join(getCacheDir(), 'cache-telemetry.json');
  try {
    updateJsonAtomicSync(telemetryFile, () => ({ streams: {} }), (state) => {
      const streams = state && typeof state.streams === 'object' && !Array.isArray(state.streams) ? state.streams : {};
      const now = Date.now();
      for (const [k, v] of Object.entries(streams)) {
        if (!v || (v.ts && now - v.ts > 20 * 60 * 1000)) delete streams[k];
      }
      const prev = Object.hasOwn(streams, convoId) ? streams[convoId] : { singleReadTurns: 0, readsInTurn: 0, ts: now };
      if (toolName !== 'read_file') {
        streams[convoId] = { singleReadTurns: 0, readsInTurn: 0, ts: now };
        return { streams };
      }
      streams[convoId] = {
        singleReadTurns: Number(prev.singleReadTurns || 0),
        readsInTurn: Number(prev.readsInTurn || 0) + 1,
        ts: now,
      };
      return { streams };
    });
  } catch {}
}

/**
 * Evaluates the previous model turn at PreInvocation boundary and emits a batching advisory
 * only after 3+ separate turns each performed exactly 1 read_file.
 * @param {string} convoId
 * @returns {string}
 */
function consumeReadBatchAdvisory(convoId = 'default') {
  const telemetryFile = join(getCacheDir(), 'cache-telemetry.json');
  if (!existsSync(telemetryFile)) return '';
  let advisory = '';
  try {
    updateJsonAtomicSync(telemetryFile, () => ({ streams: {} }), (state) => {
      const streams = state && typeof state.streams === 'object' && !Array.isArray(state.streams) ? state.streams : {};
      const cur = Object.hasOwn(streams, convoId) ? streams[convoId] : null;
      if (!cur) return { streams };
      const reads = Number(cur.readsInTurn || 0);
      let streak = Number(cur.singleReadTurns || 0);
      if (reads === 1) streak += 1;
      else if (reads >= 2) streak = 0;

      if (streak >= 3) {
        advisory = '⚡ [Gemini 4 Cache Delta >=2050 tok] 3+ sequential single reads detected — batch read_file calls in one turn (or use ram_search/ram_slice) to clear the 2,050-token cache boundary.';
        streak = 0;
      }
      streams[convoId] = { singleReadTurns: streak, readsInTurn: 0, ts: Date.now() };
      return { streams };
    });
  } catch {}
  return advisory;
}

/**
 * Guards invoke_subagent against Flash edit downgrades on Hydrogen/Orchestrator and shared-workspace write races.
 * Uses a one-shot warn-then-allow cache key so legitimate retries never deadlock.
 * @param {object} params
 * @returns {{ decision: 'allow'|'deny', reason?: string }}
 */
function evaluateSubagentInvokeGuard({ args = {}, convoId = 'default', modelProfile = null, state = {} } = {}) {
  const isEn = resolveUserLanguage(state) === 'en';
  const typeName = String(args.TypeName || '').toLowerCase();
  const subModel = String(args.Model || 'inherit').toLowerCase();
  const ALLOWED_SUBAGENT_MODELS = new Set(['inherit', 'flash_lite', 'flash', 'pro']);
  if (args.Model !== undefined && args.Model !== null && String(args.Model).trim() !== '' && !ALLOWED_SUBAGENT_MODELS.has(subModel)) {
    return {
      decision: 'deny',
      reason: isEn
        ? `🛡️ [Subagent Schema Guard] Invalid invoke_subagent Model:"${String(args.Model)}". Allowed values are strictly: "inherit", "flash_lite", "flash", "pro" (NEVER "hydrogen", "neon", or "carbon").`
        : `🛡️ [Subagent Schema Guard] Недопустимое значение invoke_subagent Model:"${String(args.Model)}". Разрешены строго: "inherit", "flash_lite", "flash", "pro" (НИКОГДА "hydrogen", "neon" или "carbon").`,
    };
  }
  const workspace = String(args.Workspace || 'inherit').toLowerCase();
  const text = `${args.Role || ''} ${args.Prompt || ''}`;
  const isReadOnlyScout = typeName === 'research' || /\b(?:read-only|search|scout|grep|log|inspect|summary)\b/i.test(text);
  const isWriteWork = !isReadOnlyScout && /\b(?:edit|write|patch|fix|implement|refactor|create|update|add)\b/i.test(text);

  let warningKey = '';
  let reason = '';

  if ((modelProfile?.isOrchestrator || modelProfile?.isHydrogen || modelProfile?.isNeon) && subModel === 'flash' && isWriteWork) {
    warningKey = `flash_downgrade::${convoId}::${typeName}`;
    reason = isEn
      ? '🛡️ [Hydrogen/Neon/Orchestrator Subagent Guard] Do not downgrade code edits to Model:"flash" (3.8 Flash). Apply edits directly on Hydrogen/Neon or pass Model:"inherit" (a retry will be allowed automatically).'
      : '🛡️ [Hydrogen/Neon/Orchestrator Subagent Guard] Не понижайте правки кода до Model:"flash" (3.8 Flash). Выполняйте правки напрямую на Hydrogen/Neon или укажите Model:"inherit" (повторный вызов пропустит принудительно).';
  } else if (isWriteWork && workspace === 'inherit') {
    const guardFile = join(getCacheDir(), 'subagent-guard.json');
    let recentConcurrent = false;
    try {
      updateJsonAtomicSync(guardFile, () => ({ spawns: {}, warned: {} }), (st) => {
        const spawns = st?.spawns && typeof st.spawns === 'object' ? st.spawns : {};
        const now = Date.now();
        const prev = Object.hasOwn(spawns, convoId) ? spawns[convoId] : null;
        if (prev && now - prev.ts < 8000) recentConcurrent = true;
        spawns[convoId] = { ts: now };
        return { spawns, warned: st?.warned || {} };
      });
    } catch {}
    if (recentConcurrent) {
      warningKey = `parallel_inherit::${convoId}::${typeName}`;
      reason = isEn
        ? '🛡️ [Parallel Write Guard] Parallel write subagent spawn detected with Workspace:"inherit". Pass Workspace:"share" to isolate edits without conflicts (a retry will be allowed automatically).'
        : '🛡️ [Parallel Write Guard] Обнаружен параллельный запуск пишущего субагента с Workspace:"inherit". Передайте Workspace:"share" для изоляции правок без конфликтов (повторный вызов пропустит принудительно).';
    }
  }

  if (!warningKey) return { decision: 'allow' };

  const guardFile = join(getCacheDir(), 'subagent-guard.json');
  let shouldDeny = false;
  try {
    updateJsonAtomicSync(guardFile, () => ({ spawns: {}, warned: {} }), (st) => {
      const warned = st?.warned && typeof st.warned === 'object' ? st.warned : {};
      const now = Date.now();
      for (const [k, ts] of Object.entries(warned)) {
        if (now - Number(ts || 0) > 2 * 60 * 1000) delete warned[k];
      }
      if (!Object.hasOwn(warned, warningKey)) {
        warned[warningKey] = now;
        shouldDeny = true;
      }
      return { spawns: st?.spawns || {}, warned };
    });
  } catch {}

  return shouldDeny ? { decision: 'deny', reason } : { decision: 'allow' };
}

/**
 * Extracts question prompt text from ask_question tool arguments (supports array or JSON string).
 * @param {object} args
 * @returns {string}
 */
function extractAskQuestionText(args = {}) {
  let list = args?.questions;
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list);
    } catch {
      return list;
    }
  }
  if (!Array.isArray(list)) return '';
  return list.map((q) => (typeof q === 'string' ? q : String(q?.question || ''))).filter(Boolean).join('\n');
}

/**
 * Extracts string option labels from ask_question tool arguments.
 * @param {object} args
 * @returns {string[]}
 */
function extractAskQuestionOptions(args = {}) {
  let list = args?.questions;
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  const options = [];
  for (const q of list) {
    if (!q || typeof q !== 'object' || !Array.isArray(q.options)) continue;
    for (const opt of q.options) {
      const text = typeof opt === 'string' ? opt.trim() : String(opt?.label || opt?.text || '').trim();
      if (text) options.push(text);
    }
  }
  return options;
}

const STATIC_CLICHE_PATTERNS = [
  /запустить:\s*(?:архитектор\s*\+\s*быстрый\s+контур|быстрый\s+режим\s*\+\s*профильные\s+скиллы)/i,
  /запустить\s+в\s+связке\s+оркестратора\s*\(планировщик[^)]*\)\s*\+\s*профильные\s+скиллы\s*$/i,
  /^максимальная\s+мощность:\s*параллельн(?:ые\s+субагенты|ый\s+рой\s+воркеров)\s*\([^)]*\)\s*$/i,
  /^(?:быстрый\s+режим\s*\(одной\s+моделью\s+без\s+субагентов\)|точечный\s+пошаговый\s+режим\s*\(без\s+фоновых\s+субагентов\)|усиленный\s+режим:\s*глубокая\s+проверка\s+архитектором|запустить\s+параллельных\s+субагентов\s*\(teamwork\))\s*$/i,
];

/**
 * Detects legacy hardcoded boilerplate preset options in ask_question that lack task-specific files or trade-offs.
 * @param {string[]} [options=[]]
 * @param {string} [qText='']
 * @returns {boolean}
 */
export function isGenericBoilerplateAskOptions(options = [], qText = '') {
  if (!Array.isArray(options) || options.length < 2) return false;
  const combined = `${qText} ${options.join(' ')}`;
  if (/(?:витрин[аеыу]|референс|прототип[аы]\s+a\/b\/c|целевой\s+стиль|визуальн[а-яё]*\s+направлен|showroom|reference|a\/b\/c|target\s+style|visual\s+direction)/i.test(combined)) {
    return false;
  }

  let clicheHits = 0;
  for (const rawOpt of options) {
    const cleaned = String(rawOpt || '').replace(/^\(Recommended\)\s*/i, '').trim();
    if (!cleaned) continue;
    if (STATIC_CLICHE_PATTERNS.some((rx) => rx.test(cleaned))) {
      clicheHits += 1;
    }
  }
  if (clicheHits < 2) return false;

  const joinedOpts = options.join(' ');
  const hasConcreteContext =
    /\b[\w.-]+\.(?:m?js|cjs|tsx?|jsx?|html|css|json|py|md|sh|bat)\b/i.test(joinedOpts) ||
    /\b(?:ast-codemod|ddmin|stress-auditor|slicer|dry-run|read-only|sse|polling|cache|migration|compatibility|regression|contract)\b|(?:кэш|миграц|совместимост|регрессион|контракт)/i.test(joinedOpts) ||
    /`[^`]{2,}`/.test(joinedOpts);

  return !hasConcreteContext;
}

/**
 * Updates post-scout 3D turn calibration and clears the Pre-Task Gate when ask_question is called.
 * Non-blocking: never returns `deny` so the host UI does not surface "Error while running ask_question".
 * @param {object} params
 * @returns {{ decision: 'allow' }}
 */
function evaluateAskQuestionSelectorGuard({ args = {}, convoId = 'default', state = {} } = {}) {
  const turnFile = join(getCacheDir(), 'pre-invocation-turn.json');
  if (state.confirmBeforeRun === false) {
    return { decision: 'allow' };
  }
  if (state.pureCognitiveTriage === false) {
    try {
      updateJsonAtomicSync(turnFile, () => ({ turns: {} }), (tState) => {
        const turns = tState?.turns && typeof tState.turns === 'object' ? tState.turns : {};
        const prev = Object.hasOwn(turns, convoId) ? turns[convoId] : { hash: '', ts: Date.now() };
        turns[convoId] = { ...prev, askQuestionCalled: true, modelSwitchPending: false, preTaskGateRequired: false };
        return { turns };
      });
    } catch {}
    return { decision: 'allow' };
  }

  const qText = extractAskQuestionText(args);
  const gradeMatch = qText.match(/(?:объ[её]м|сложность|volume|scope)\s*:\s*(XL|L|M|S)\b/i);
  const declaredGrade = gradeMatch ? gradeMatch[1].toUpperCase() : '';
  const declaredXL = declaredGrade === 'XL';
  const declaredL = declaredGrade === 'L';
  const declaredSM = declaredGrade === 'S' || declaredGrade === 'M';
  const hasRoutineNote = /(?:механическ|однотипн|шаблонн|рутинн|переименован|mechanical|routine|boilerplate|rename)/i.test(qText);
  const hasPostScoutDeepNote = /(?:гонк[аи]|deadlock|утечк[аиу]|безопасност|критическ[а-яё]*\s+ядр|глубок[а-яё]*\s+(?:аудит|архитектур|логик)|high[- ]blast|critical[- ]blast|race\s+condition|memory\s+leak|security|deep\s+(?:audit|arch|logic))/i.test(qText);

  try {
    updateJsonAtomicSync(turnFile, () => ({ turns: {} }), (tState) => {
      const turns = tState?.turns && typeof tState.turns === 'object' ? tState.turns : {};
      const prev = Object.hasOwn(turns, convoId) ? turns[convoId] : { hash: '', ts: Date.now() };
      const effectiveGrade = declaredGrade || prev.grade || 'M';
      const prevMatrix = prev.matrix2D && typeof prev.matrix2D === 'object' ? prev.matrix2D : null;

      // AI-First Post-Scout Re-Calibration: вердикт модели после реального чтения файлов имеет приоритет над черновой пред-оценкой хука
      let effectiveIsDeep = false;
      let effectiveMatrix2D = prevMatrix;
      if (declaredSM) {
        effectiveIsDeep = hasPostScoutDeepNote;
        effectiveMatrix2D = {
          breadth: declaredGrade === 'S' ? 'narrow' : 'moderate',
          depth: hasPostScoutDeepNote ? 'deep_arch' : (declaredGrade === 'S' ? 'routine' : 'integrated'),
          riskMode: hasPostScoutDeepNote ? 'critical_blast' : 'clear',
          isHighBlast: hasPostScoutDeepNote,
          matrixId: declaredGrade === 'S' ? 'narrow_routine' : (hasPostScoutDeepNote ? 'moderate_deep' : 'moderate_integrated'),
        };
      } else if (declaredXL) {
        effectiveIsDeep = !hasRoutineNote;
        effectiveMatrix2D = hasRoutineNote
          ? { ...prevMatrix, breadth: 'wide', depth: 'routine', isHighBlast: false, matrixId: 'wide_routine' }
          : { ...prevMatrix, breadth: 'wide', depth: 'deep_arch', matrixId: 'wide_deep' };
      } else if (declaredL) {
        effectiveIsDeep = !hasRoutineNote && hasPostScoutDeepNote;
        effectiveMatrix2D = hasRoutineNote
          ? { ...prevMatrix, breadth: 'wide', depth: 'routine', isHighBlast: false, matrixId: 'wide_routine' }
          : {
              breadth: 'moderate',
              depth: effectiveIsDeep ? 'deep_arch' : 'integrated',
              riskMode: (prevMatrix?.isHighBlast || hasPostScoutDeepNote) ? 'critical_blast' : 'clear',
              isHighBlast: Boolean(prevMatrix?.isHighBlast || hasPostScoutDeepNote),
              matrixId: effectiveIsDeep ? 'moderate_deep' : 'moderate_integrated',
            };
      } else {
        effectiveIsDeep = Boolean(prev.isDeepAuditOrArch || prevMatrix?.depth === 'deep_arch');
      }

      let updatedRecommended = prev.selectorRecommended;
      if (declaredGrade && modelProfileMod) {
        const isEnLang = resolveUserLanguage(state) === 'en';
        const targetResolver = isEnLang
          ? modelProfileMod.resolveOptimalModelTargetEn
          : modelProfileMod.resolveOptimalModelTargetRu;
        if (typeof targetResolver === 'function') {
          updatedRecommended = targetResolver({
            grade: effectiveGrade,
            isDeepAuditOrArch: effectiveIsDeep,
            matrix2D: effectiveMatrix2D,
            subscriptionTier: state?.subscriptionTier || null,
          });
        }
      }

      turns[convoId] = {
        ...prev,
        grade: effectiveGrade,
        matrix2D: effectiveMatrix2D,
        isDeepAuditOrArch: effectiveIsDeep,
        ...(updatedRecommended !== undefined ? { selectorRecommended: updatedRecommended } : {}),
        askQuestionCalled: true,
        modelSwitchPending: false,
        preTaskGateRequired: false,
      };
      return { turns };
    });
  } catch {}

  return { decision: 'allow' };
}

/**
 * Checks whether an edit/write target is an artifact, cache, or scratch path exempt from the interactive Pre-Task Gate.
 * @param {string} [filePath='']
 * @param {string} [wsPath='']
 * @param {object} [args={}]
 * @returns {boolean}
 */
function isExemptPreTaskGateEditTarget(filePath = '', wsPath = '', args = {}) {
  if (args && args.ArtifactMetadata) return true;
  if (!filePath || typeof filePath !== 'string') return true;
  const normPath = filePath.replace(/\\/g, '/');
  if (/(?:^|\/)(?:\.cache|\.system_generated)(?:\/|$)/i.test(normPath)) return true;
  if (/(?:^|\/)(?:\.gemini\/)?antigravity(?:-ide|-cli)?\/brain\//i.test(normPath)) return true;
  if (/^(?:\.\/)?scratch(?:\/|$)/i.test(normPath)) return true;
  if (wsPath && typeof wsPath === 'string') {
    try {
      const rel = relative(resolve(wsPath), resolve(filePath)).replace(/\\/g, '/');
      if (rel === 'scratch' || rel.startsWith('scratch/')) return true;
    } catch {}
  }
  return false;
}

/**
 * One-shot warn-then-allow PreToolUse gate blocking unconfirmed workspace edits when Pre-Task Gate requires ask_question.
 * @param {object} [params={}]
 * @returns {{ decision: 'allow'|'deny', reason?: string }}
 */
function evaluateEditPreTaskGateGuard({
  toolName = '',
  args = {},
  filePath = '',
  wsPath = '',
  convoId = 'default',
  state = {},
  swarmCtx = null,
  modelProfile = null,
} = {}) {
  if (toolName !== 'edit_file' && toolName !== 'write_file') {
    return { decision: 'allow' };
  }
  if (state.confirmBeforeRun === false || swarmCtx?.role === 'swarm_worker') {
    return { decision: 'allow' };
  }
  if (isExemptPreTaskGateEditTarget(filePath, wsPath, args)) {
    return { decision: 'allow' };
  }

  const turnFile = join(getCacheDir(), 'pre-invocation-turn.json');
  if (!existsSync(turnFile)) {
    return { decision: 'allow' };
  }
  const cachedTurns = safeReadJsonSync(turnFile, () => ({ turns: {} }), { selfHeal: false });
  const prev = cachedTurns?.turns && Object.hasOwn(cachedTurns.turns, convoId)
    ? cachedTurns.turns[convoId]
    : null;
  if (!prev || typeof prev !== 'object') {
    return { decision: 'allow' };
  }
  if (prev.ts && Date.now() - prev.ts > 15 * 60 * 1000) {
    return { decision: 'allow' };
  }
  if (prev.askQuestionCalled === true || prev.planHandedOff === true) {
    return { decision: 'allow' };
  }
  if (prev.preTaskGateRequired === false) {
    return { decision: 'allow' };
  }

  const effGrade = prev.grade || prev.proposedGrade || 'M';
  const policy = modelProfileMod?.resolveEffectivePreTaskGatePolicy
    ? modelProfileMod.resolveEffectivePreTaskGatePolicy({ state, modelProfile, grade: effGrade })
    : { shouldAskModelGate: true, effectiveThreshold: state.confirmThreshold || 'M' };
  const mustBlock = prev.preTaskGateRequired === true || (prev.wasReadOnly === false && Boolean(policy?.shouldAskModelGate));
  if (!mustBlock) {
    return { decision: 'allow' };
  }

  try {
    updateJsonAtomicSync(turnFile, () => ({ turns: {} }), (tState) => {
      const turns = tState?.turns && typeof tState.turns === 'object' ? tState.turns : {};
      if (Object.hasOwn(turns, convoId) && turns[convoId]) {
        turns[convoId] = {
          ...turns[convoId],
          editGateWarned: true,
          editGateDenyCount: (Number(turns[convoId].editGateDenyCount) || 0) + 1,
        };
      }
      return { turns };
    });
  } catch {}

  const isEn = resolveUserLanguage(state) === 'en';
  if (prev.modelSwitchPending === true) {
    const targetRec = prev.selectorRecommended || (isEn ? 'the recommended model' : 'рекомендуемую модель');
    return {
      decision: 'deny',
      reason: isEn
        ? `⏸️ [Model-Switch Gate Guard (AGY 2.35+)] A model switch to ${targetRec} is pending. Do NOT edit files in this turn (selector changes apply on the next turn) — output the concise plan and prompt the user to switch the model, then END the turn (or call ask_question only if post-scout confirmed the current model is optimal).`
        : `⏸️ [Model-Switch Gate Guard (AGY 2.35+)] Ожидается переключение модели на ${targetRec}. Не вносите правки в этом ходе (смена модели вступит в силу со следующего хода) — выведите краткий план и попросите пользователя переключить модель, затем ЗАВЕРШИТЕ ход (либо вызовите ask_question, только если после разведки текущая модель оказалась оптимальной).`,
    };
  }
  return {
    decision: 'deny',
    reason: isEn
      ? `🚦 [Pre-Task Gate Guard] Pre-edit confirmation is enabled (confirmBeforeRun: true, threshold: ${policy?.effectiveThreshold || state.confirmThreshold || 'M'}, scope: ${effGrade}), but ask_question has not been called in this turn yet. Call ask_question first with 3 concrete plan options (listing real target files and the optimal model), and only apply edits after the user replies.`
      : `🚦 [Pre-Task Gate Guard] Включено подтверждение перед правками (confirmBeforeRun: true, порог: ${policy?.effectiveThreshold || state.confirmThreshold || 'M'}, объём: ${effGrade}), но интерактивное окно ask_question в этом ходе ещё не вызывалось. Сначала вызовите ask_question с 3 предметными вариантами плана (укажите реальные файлы и оптимальную модель), и только после ответа пользователя вносите правки в код.`,
  };
}

/**
 * Обработчик события PreToolUse (для edit_file / write_file / read_file / run_command / invoke_subagent).
 * @param {object} payload Данные от хука.
 * @param {object} state Состояние маршрутизатора.
 * @returns {Promise<{ decision: string, reason?: string }>}
 */
export async function handlePreToolUse(payload = {}, rawState = {}) {
  const state = applyHookProfileOverrides(rawState);
  const toolCall = payload.toolCall || {};
  const toolName = toolCall.name || payload.tool || payload.toolName || 'edit_file';
  const args = toolCall.args || payload.args || {};
  const filePath = args.Path || args.path || args.filePath || '';
  const absPath = filePath ? resolve(filePath) : '';
  const wsPath =
    payload.workspacePaths?.[0] || payload.workspacePath || payload.cwd || process.cwd();

  await ensureHookDeps('PreToolUse', toolName);

  const swarmCtx = swarmController?.detectSwarmExecutionRole
    ? swarmController.detectSwarmExecutionRole(payload)
    : { role: 'standalone', isolationKey: String(payload.conversationId || 'default') };
  const convoKey = swarmCtx?.isolationKey || String(payload.conversationId || 'default');

  if (taskProgress?.advanceTaskProgressOnPreTool) {
    try {
      taskProgress.advanceTaskProgressOnPreTool({
        conversationId: String(payload.conversationId || 'default'),
        workspaceRoot: resolveTaskProgressWorkspace(payload),
        transcriptPath: payload.transcriptPath || '',
        toolName,
        filePath,
        commandLine: args.CommandLine || args.command || args.cmd || '',
        role: args.Role || args.role || '',
        toolSummary: String(args.toolSummary || '').trim(),
        planText: toolName === 'exit_plan_mode' ? String(args.plan || '') : '',
        checklistSteps: toolName === 'update_steps' ? (args.steps || null) : null,
        questionHint: toolName === 'ask_question' ? extractAskQuestionText(args).split(/[\n?!]/)[0].trim().slice(0, 100) : '',
        symbolHint: (toolName === 'edit_file' || toolName === 'write_file') && taskProgress.extractPrimarySymbolFromSnippet
          ? taskProgress.extractPrimarySymbolFromSnippet(args.Replacement || args.Target || args.Content || '')
          : '',
        swarmRole: swarmCtx?.role || '',
        swarmWorkerKind: swarmCtx?.workerKind || '',
      });
    } catch {}
  }

  const resolvePreToolModelProfile = () =>
    modelProfileMod?.resolveActiveModelProfile
      ? modelProfileMod.resolveActiveModelProfile({
          modelName: payload.modelName || '',
          transcriptPath: payload.transcriptPath || '',
          conversationId: payload.conversationId || '',
        })
      : null;

  // 0s. Защита фоновых воркеров Роя и контроль согласованности XL/селектора на ask_question
  if (toolName === 'ask_question') {
    const isEnHook = resolveUserLanguage(state) === 'en';
    if (swarmCtx?.role === 'swarm_worker') {
      return {
        decision: 'deny',
        reason: isEnHook
          ? '🐝 [Swarm Worker Guard] Background Swarm workers must not message the user via ask_question (it causes an infinite wait). Send your question or blocker to the coordinator on the shared board: post_message{text:"@coordinator ..."}.'
          : '🐝 [Swarm Worker Guard] Фоновые воркеры Роя не общаются с пользователем через ask_question (это вызовет вечное ожидание). Отправьте вопрос или блокер координатору на общую доску: post_message{text:"@coordinator ..."}.',
      };
    }
    return evaluateAskQuestionSelectorGuard({
      args,
      convoId: convoKey,
      state,
      modelProfile: resolvePreToolModelProfile(),
    });
  }

  if (toolName === 'exit_plan_mode') {
    if (state.confirmBeforeRun !== false && swarmCtx?.role !== 'swarm_worker') {
      const promptText = String(payload.lastUserInput || payload.prompt || '').trim();
      const isPlanReviewPrompt = /^\[plan review(?:\s+due)?\]/i.test(promptText);
      const turnFile = join(getCacheDir(), 'pre-invocation-turn.json');
      if (!isPlanReviewPrompt && existsSync(turnFile)) {
        const cachedTurns = safeReadJsonSync(turnFile, () => ({ turns: {} }), { selfHeal: false });
        const prev = cachedTurns?.turns && Object.hasOwn(cachedTurns.turns, convoKey)
          ? cachedTurns.turns[convoKey]
          : null;
        if (
          prev &&
          typeof prev === 'object' &&
          (!prev.ts || Date.now() - prev.ts <= 15 * 60 * 1000) &&
          prev.isPlanReview !== true &&
          prev.askQuestionCalled !== true &&
          prev.planHandedOff !== true &&
          prev.preTaskGateRequired !== false
        ) {
          const effGrade = prev.grade || prev.proposedGrade || 'M';
          const activeProf = resolvePreToolModelProfile();
          const policy = modelProfileMod?.resolveEffectivePreTaskGatePolicy
            ? modelProfileMod.resolveEffectivePreTaskGatePolicy({ state, modelProfile: activeProf, grade: effGrade })
            : { shouldAskModelGate: true, effectiveThreshold: state.confirmThreshold || 'M' };
          const mustBlock = prev.preTaskGateRequired === true || (prev.wasReadOnly === false && Boolean(policy?.shouldAskModelGate));
          if (mustBlock) {
            const isEnHook = resolveUserLanguage(state) === 'en';
            return {
              decision: 'deny',
              reason: isEnHook
                ? `🚦 [Pre-Task Gate Guard (Orchestrator)] Pre-execution confirmation is enabled (confirmBeforeRun: true, threshold: ${policy?.effectiveThreshold || state.confirmThreshold || 'M'}, scope: ${effGrade}), but ask_question has not been called in this turn yet. Call ask_question first with 3 concrete plan options, wait for the user reply, and only then call exit_plan_mode.`
                : `🚦 [Pre-Task Gate Guard (Orchestrator)] Включено подтверждение перед выполнением плана (confirmBeforeRun: true, порог: ${policy?.effectiveThreshold || state.confirmThreshold || 'M'}, объём: ${effGrade}), но интерактивное окно ask_question в этом ходе ещё не вызывалось. Сначала вызовите ask_question с 3 предметными вариантами плана, дождитесь ответа пользователя, и только после этого вызывайте exit_plan_mode.`,
            };
          }
        }
      }
    }
    try {
      const turnFile = join(getCacheDir(), 'pre-invocation-turn.json');
      updateJsonAtomicSync(turnFile, () => ({ turns: {} }), (tState) => {
        const rawTurns = tState?.turns && typeof tState.turns === 'object' ? { ...tState.turns } : {};
        const prev = Object.hasOwn(rawTurns, convoKey) ? rawTurns[convoKey] : { hash: '', ts: Date.now() };
        rawTurns[convoKey] = {
          ...prev,
          planHandedOff: true,
          askQuestionCalled: true,
          preTaskGateRequired: false,
          pendingPhaseTransition: 'explore_to_edit',
          ts: Date.now(),
        };
        const turns = pruneObjectMapByTimestamp(rawTurns, {
          maxEntries: MAX_TURN_ENTRIES,
          maxAgeMs: TURN_ENTRY_TTL_MS,
          getTs: (v) => Number(v?.ts || 0),
        });
        return { turns };
      }, { spaces: 0 });
    } catch {}
    return { decision: 'allow' };
  }

  // 0s-sub. Страховка invoke_subagent (запрет даунгрейда правок на Flash и гонок Workspace:"inherit")
  if (toolName === 'invoke_subagent') {
    return evaluateSubagentInvokeGuard({ args, convoId: convoKey, modelProfile: resolvePreToolModelProfile(), state });
  }

  // 0s-swarm. Перехват управления Роем (фиксация координатора и защита title/статуса от фоновых воркеров)
  if (toolName === 'swarm') {
    try {
      const swCtx = swarmController?.detectSwarmExecutionRole
        ? swarmController.detectSwarmExecutionRole({ ...payload, toolName: 'swarm', toolCall: { ...toolCall, name: 'swarm' } })
        : { role: 'standalone', isolationKey: convoKey };
      if (swCtx.role === 'swarm_worker') {
        if (String(args.action || '').toLowerCase() === 'title') {
          const isEnHook = resolveUserLanguage(state) === 'en';
          return {
            decision: 'deny',
            reason: isEnHook
              ? '🐝 [Swarm Guard] Background Swarm worker cannot rename the swarm (swarm action:"title" is reserved for the coordinator).'
              : '🐝 [Swarm Guard] Фоновый воркер Роя не может менять заголовок (swarm action:"title" разрешён только координатору).',
          };
        }
        return { decision: 'allow' };
      }
      swarmController?.pinSwarmRole?.(swCtx.isolationKey || convoKey, 'coordinator', '');
    } catch (err) {
      console.error('[hook] swarm guard failed in PreToolUse:', err);
    }
    return { decision: 'allow' };
  }

  // 0a. Проверка безопасности команд терминала и RTK-фильтра (run_command)
  if (toolName === 'run_command') {
    recordReadBatchActivity({ convoId: convoKey, toolName });
    if (state.securityGuard !== false && securityGuard?.checkCommandSecurity) {
      try {
        const cmdLine = args.CommandLine || args.command || args.cmd || '';
        const secCmd = securityGuard.checkCommandSecurity({ commandLine: cmdLine, workspaceRoot: wsPath });
        if (secCmd && secCmd.allow === false) {
          return { decision: 'deny', reason: secCmd.reason };
        }
      } catch (err) {
        console.error('[hook] securityGuard.checkCommandSecurity failed in PreToolUse:', err);
      }
    }
    return { decision: 'allow' };
  }

  // 0b. Проверка безопасности доступа к секретным файлам (.env, ключи, .agentignore) и конфигам линтеров (Config Protection)
  if (state.securityGuard !== false && filePath && securityGuard?.checkFileSecurity) {
    try {
      let lastTurnPrompt = String(payload.userPrompt || payload.lastUserInput || payload.prompt || '');
      const isEditTool = toolName === 'edit_file' || toolName === 'write_file';
      if (!lastTurnPrompt && isEditTool && state.configProtection !== false) {
        try {
          const turnFile = join(getCacheDir(), 'pre-invocation-turn.json');
          if (existsSync(turnFile)) {
            const cachedTurns = safeReadJsonSync(turnFile, () => ({ turns: {} }), { selfHeal: false });
            const prev = cachedTurns?.turns && Object.hasOwn(cachedTurns.turns, convoKey)
              ? cachedTurns.turns[convoKey]
              : null;
            if (prev && typeof prev.lastUserPrompt === 'string') {
              lastTurnPrompt = prev.lastUserPrompt;
            }
          }
        } catch {}
      }
      const secFile = securityGuard.checkFileSecurity({
        filePath,
        workspaceRoot: wsPath,
        toolName,
        configProtection: state.configProtection !== false,
        userPrompt: lastTurnPrompt,
      });
      if (secFile && secFile.allow === false) {
        return { decision: 'deny', reason: secFile.reason };
      }
    } catch (err) {
      console.error('[hook] securityGuard.checkFileSecurity failed in PreToolUse:', err);
    }
  }

  // 0. Обработка read_file с защитой от повторного чтения (Read-Once Deduplication, изолированно по ветке Роя)
  if (toolName === 'read_file') {
    recordReadBatchActivity({ convoId: convoKey, toolName, stepIdx: Number(payload.stepIdx || 0) });
    if (state.readDedup !== false && filePath && readDedup?.checkAndRecordRead) {
      try {
        const activeProfile = resolvePreToolModelProfile();
        const rd = readDedup.checkAndRecordRead({
          filePath,
          startLine: Number(args.StartLine || 1),
          endLine: Number(args.EndLine || 999999),
          byteOffset: Number(args.ByteOffset || 0),
          conversationId: swarmCtx?.isolationKey || payload.conversationId || 'default',
          stepIdx: Number(payload.stepIdx || 0),
          modelProfile: activeProfile,
          transcriptPath: payload.transcriptPath || '',
        });
        if (rd && rd.allow === false) {
          return { decision: 'deny', reason: rd.reason };
        }
      } catch (err) {
        console.error('[hook] readDedup check failed in PreToolUse:', err);
      }
    }
    return { decision: 'allow' };
  }

  if (toolName === 'edit_file' || toolName === 'write_file') {
    const editGate = evaluateEditPreTaskGateGuard({
      toolName,
      args,
      filePath,
      wsPath,
      convoId: convoKey,
      state,
      swarmCtx,
      modelProfile: resolvePreToolModelProfile(),
    });
    if (editGate && editGate.decision === 'deny') {
      return editGate;
    }
  }

  recordReadBatchActivity({ convoId: convoKey, toolName });
  const effectiveFileWs = (filePath && shadowGuard?.resolveEffectiveProjectRoot)
    ? shadowGuard.resolveEffectiveProjectRoot(filePath, wsPath)
    : wsPath;

  // 1. Проверка размыкания автомата Circuit Breaker для данного файла
  if (state.circuitBreaker !== false && absPath && circuitBreaker?.getCircuitState) {
    try {
      const cb = circuitBreaker.getCircuitState({
        filePath: absPath,
        workspaceRoot: effectiveFileWs,
        conversationId: convoKey,
      });
      if (
        cb &&
        cb.status === 'TRIPPED' &&
        cb.targetFile &&
        resolve(cb.targetFile).toLowerCase() === absPath.toLowerCase()
      ) {
        return {
          decision: 'deny',
          reason: `🛑 [Thrashing Circuit Breaker] Circuit open (3 repeats): ${cb.reason}. Reset in Model Router panel or change approach.`,
        };
      }
    } catch (err) {
      console.error('[hook] Circuit Breaker check failed in PreToolUse:', err);
    }
  }

  // 2. Проверка транзакционного патча В ОЗУ до записи на диск (In-Memory Transactional Patch)
  if (state.transactionalPatch !== false && diffPatcher && typeof diffPatcher.simulateToolEditInMemory === 'function') {
    try {
      const sim = diffPatcher.simulateToolEditInMemory(toolName, args);
      if (sim && !sim.valid) {
        circuitBreaker?.recordErrorFingerprint?.({
          source: sim.checker || 'transactional-patch',
          errorText: sim.error || 'Patch simulation failed',
          filePath,
          workspaceRoot: effectiveFileWs,
          conversationId: convoKey,
        });
        const safeErrText = securityGuard?.redactSecretsInText
          ? securityGuard.redactSecretsInText(String(sim.error || ''))
          : String(sim.error || '');
        pitfallLedger?.recordPitfall?.({
          type: 'syntax_abort',
          fileName: basename(filePath),
          summary: `Transactional abort in ${basename(filePath)} (${sim.checker || 'syntax'}): ${safeErrText.slice(0, 90)}`,
          workspaceRoot: effectiveFileWs,
        });
        return {
          decision: 'deny',
          reason: `🛡️ [In-Memory Transactional Patch] Blocked before disk write (${sim.checker || 'syntax'}): ${String(sim.error || '').slice(0, 300)}`,
        };
      }

      if (sim && sim.valid && sim.simulatedContent !== null && state.circuitBreaker !== false && circuitBreaker?.recordEditStateHash) {
        const cbRes = circuitBreaker.recordEditStateHash({
          filePath,
          content: sim.simulatedContent,
          workspaceRoot: effectiveFileWs,
          conversationId: convoKey,
        });
        if (cbRes?.tripped) {
          return {
            decision: 'deny',
            reason: `🛑 [Thrashing Circuit Breaker] ${cbRes.reason}`,
          };
        }
      }
    } catch (err) {
      console.error('[hook] simulateToolEditInMemory failed in PreToolUse:', err);
    }
  } else if (state.circuitBreaker !== false && filePath && circuitBreaker?.recordEditStateHash) {
    // Резервная проверка хеша содержимого для write_file, если simulateToolEditInMemory ещё не загружен
    if (toolName === 'write_file' && typeof args.Content === 'string') {
      try {
        const cbRes = circuitBreaker.recordEditStateHash({
          filePath,
          content: args.Content,
          workspaceRoot: effectiveFileWs,
          conversationId: convoKey,
        });
        if (cbRes?.tripped) {
          return {
            decision: 'deny',
            reason: `🛑 [Thrashing Circuit Breaker] ${cbRes.reason}`,
          };
        }
      } catch (err) {
        console.error('[hook] Fallback hash check failed in PreToolUse:', err);
      }
    }
  }

  // 3. Защита от избыточной перезаписи (Overwrite Guard: warn-then-allow)
  if (diffPatcher && typeof diffPatcher.checkOverwriteGuard === 'function') {
    try {
      const ow = diffPatcher.checkOverwriteGuard(toolName, args, state);
      if (ow && ow.decision === 'deny' && ow.reason) {
        return { decision: 'deny', reason: ow.reason };
      }
    } catch {}
  }

  // 4. Создание теневого чекпоинта перед модификацией + сохранение пред-редакторного буфера для Post-Edit Critic
  if (filePath && (toolName === 'edit_file' || toolName === 'write_file') && absPath && existsSync(absPath)) {
    try {
      const preBuf = readFileSync(absPath);
      if (preBuf.length > 0 && preBuf.length <= MAX_PRE_EDIT_SNAPSHOT_BYTES && !preBuf.subarray(0, 512).includes(0)) {
        const snapKey = resolve(absPath).toLowerCase();
        const preText = preBuf.toString('utf8');
        updateJsonAtomicSync(getPreEditSnapshotFile(), () => ({ entries: {} }), (st) => {
          const prev = st?.entries && typeof st.entries === 'object' ? { ...st.entries } : {};
          prev[snapKey] = { text: preText, ts: Date.now() };
          const keys = Object.keys(prev);
          if (keys.length > 6) {
            keys.sort((a, b) => (prev[b]?.ts || 0) - (prev[a]?.ts || 0));
            for (let i = 6; i < keys.length; i++) delete prev[keys[i]];
          }
          return { entries: prev };
        });
      }
    } catch {}
  }

  if (state.shadowCheckpoints !== false && filePath && shadowGuard?.createShadowCheckpoint) {
    try {
      let activeTurnId = '';
      let activeTurnLabel = '';
      try {
        const turnFile = join(getCacheDir(), 'pre-invocation-turn.json');
        const tCache = safeReadJsonSync(turnFile, () => ({ turns: {} }), { selfHeal: false });
        const fallbackCid = String(payload.conversationId || 'default');
        const tRec = tCache?.turns && Object.hasOwn(tCache.turns, convoKey)
          ? tCache.turns[convoKey]
          : (tCache?.turns && Object.hasOwn(tCache.turns, fallbackCid) ? tCache.turns[fallbackCid] : null);
        if (tRec && tRec.turnId) {
          activeTurnId = String(tRec.turnId);
          activeTurnLabel = String(tRec.turnLabel || '');
        }
      } catch {}
      shadowGuard.createShadowCheckpoint({
        filePath,
        workspaceRoot: effectiveFileWs,
        conversationId: payload.conversationId || '',
        toolName,
        stepIdx: payload.stepIdx || 0,
        turnId: activeTurnId,
        turnLabel: activeTurnLabel,
      });
    } catch (err) {
      console.error('[hook] createShadowCheckpoint failed in PreToolUse:', err);
    }
  }

  return { decision: 'allow' };
}

const TEST_RUNNER_CMD_RE = /\b(?:node\s+--test\b|node\s+[^\s;|&]*\.(?:test|spec)\.[cm]?[jt]sx?|pytest|vitest|jest|npm\s+test|pnpm\s+test|yarn\s+test)\b/i;
const EXPLICIT_TEST_FILE_RE = /(?:^|[\s"'`\\/])([A-Za-z0-9_.-]+\.(?:test|spec)\.[cm]?[jt]sx?|test_[A-Za-z0-9_.-]+\.py|[A-Za-z0-9_.-]+_test\.py)(?=$|[\s"'`])/gi;
const TEST_OUTPUT_FAIL_RE = /^\s*[✖✗]\s|\bnot ok\b|\bfail\s+[1-9]\d*|\b[1-9]\d*\s+failed\b|(?:^|\n)\s*(?:AssertionError|ReferenceError|SyntaxError|TypeError)\b/im;
const TEST_OUTPUT_PASS_RE = /\bfail\s+0\b|\b0\s+failed\b|\b\d+\s+passed\b/i;

function extractFailedTestBasenames(filteredOut = '') {
  const failed = new Set();
  const patterns = [
    /(?:test at\s+|file:\/\/\/[^\r\n]*[\\/]|at\s+[^\r\n]*[\\/]|FAIL\s+[^\r\n]*[\\/])([A-Za-z0-9_.-]+\.(?:test|spec)\.[cm]?[jt]sx?)\b/gi,
    /(?:FAILED\s+[^\r\n]*[\\/])(test_[A-Za-z0-9_.-]+\.py|[A-Za-z0-9_.-]+_test\.py)\b/gi,
  ];
  for (const re of patterns) {
    for (const m of String(filteredOut || '').matchAll(re)) {
      if (m[1]) failed.add(m[1].toLowerCase());
    }
  }
  return failed;
}

/**
 * Resolves test_failure/test_fail pitfalls after a passing test runner command.
 * Supports diagnostic pipes/redirections and partial clearing on multi-file suites.
 * @param {object} [params={}]
 * @returns {{ resolved: number, targets: string[] }}
 */
export function resolveTestPitfallsFromCommand({
  commandLine = '',
  output = '',
  workspaceRoot = '',
  pitfallLedgerMod = null,
} = {}) {
  const cmd = String(commandLine || '').trim();
  if (!cmd || !TEST_RUNNER_CMD_RE.test(cmd) || !pitfallLedgerMod?.resolvePitfallsForFile) {
    return { resolved: 0, targets: [] };
  }
  const out = String(output || '');
  const filteredOut = out.replace(/^\s*(?:[✔✓ℹ]|>\s*[✔✓]).*$/gm, '');
  const hasFailures = Boolean(filteredOut && TEST_OUTPUT_FAIL_RE.test(filteredOut));
  const failedBasenames = hasFailures ? extractFailedTestBasenames(filteredOut) : new Set();

  const globMatch = cmd.match(/\*(\.(?:test|spec)\.[cm]?[jt]sx?)\b/i);
  const isFullSuite = /\b(?:npm|pnpm|yarn)\s+test\b|\bpytest\b(?!\s+\S+\.py)/i.test(cmd);
  const canPartialClear = hasFailures && (Boolean(globMatch) || isFullSuite) && failedBasenames.size > 0;

  if (hasFailures && !canPartialClear) {
    return { resolved: 0, targets: [] };
  }

  const cmdWithoutDiagRedir = cmd
    .replace(/\d*>&\d+/g, ' ')
    .replace(/\d*>>?\s*(?:"[^"]*"|'[^']*'|\S+)/g, ' ')
    .replace(/\|\s*(?:Out-Null|Select-Object\b[^|;]*|Measure-Object\b[^|;]*|Tee-Object\b[^|;]*|node\s+[^\n|;]*obs-masker\.mjs[^\n|;]*)/gi, ' ')
    .trim();
  const hasChaining = /[;|&]/.test(cmdWithoutDiagRedir);
  if (hasChaining && (!out || !TEST_OUTPUT_PASS_RE.test(out))) {
    return { resolved: 0, targets: [] };
  }

  const targets = new Set();
  for (const m of cmd.matchAll(EXPLICIT_TEST_FILE_RE)) {
    if (m[1] && !m[1].includes('*')) {
      if (!failedBasenames.has(m[1].toLowerCase())) {
        targets.add(m[1]);
      }
    }
  }

  // Handle wildcard globs (e.g. tests/*.test.mjs) or full suite commands (npm test / pytest)
  if (targets.size === 0 && typeof pitfallLedgerMod.listPitfalls === 'function') {
    if (globMatch || isFullSuite) {
      const suffix = globMatch ? globMatch[1].toLowerCase() : '';
      const existing = pitfallLedgerMod.listPitfalls(15, workspaceRoot);
      for (const item of Array.isArray(existing) ? existing : []) {
        if (item?.type !== 'test_failure' && item?.type !== 'test_fail') continue;
        const fn = String(item.fileName || '');
        const mRule = String(item.rule || '').match(/\(([^)]+)\)/);
        const ruleTest = mRule ? mRule[1] : '';
        if (failedBasenames.has(fn.toLowerCase()) || failedBasenames.has(ruleTest.toLowerCase())) {
          continue;
        }
        if (!suffix) {
          if (fn) targets.add(fn);
          if (ruleTest) targets.add(ruleTest);
        } else if (ruleTest.toLowerCase().endsWith(suffix)) {
          targets.add(ruleTest);
          if (fn) targets.add(fn);
        } else if (fn.toLowerCase().endsWith(suffix)) {
          targets.add(fn);
          if (ruleTest) targets.add(ruleTest);
        }
      }
    }
  }

  let resolved = 0;
  for (const fileName of targets) {
    const res = pitfallLedgerMod.resolvePitfallsForFile({
      fileName,
      workspaceRoot,
      types: ['test_failure', 'test_fail'],
    });
    resolved += Number(res?.removed || 0);
  }
  return { resolved, targets: Array.from(targets) };
}

/**
 * Обработчик события PostToolUse (для edit_file / write_file / run_command).
 * @param {object} payload Данные от хука.
 * @param {object} state Состояние маршрутизатора.
 * @returns {Promise<object>}
 */
export async function handlePostToolUse(payload = {}, rawState = {}) {
  const state = applyHookProfileOverrides(rawState);
  const toolCall = payload.toolCall || {};
  const toolName = toolCall.name || payload.tool || payload.toolName || '';
  const args = toolCall.args || payload.args || {};
  const filePath = args.Path || args.path || args.filePath || '';
  const wsPath =
    payload.workspacePaths?.[0] || payload.workspacePath || payload.cwd || process.cwd();

  await ensureHookDeps('PostToolUse', toolName);
  const isEphemeralPostWs = Boolean(sessionHandoff?.isEphemeralTestWorkspace?.(wsPath));

  const postConvoKey = swarmController?.resolveSwarmIsolationKey
    ? swarmController.resolveSwarmIsolationKey({
        conversationId: payload.conversationId || 'default',
        workspaceRoot: wsPath,
      })
    : String(payload.conversationId || 'default');

  // 0. Автоматическая фиксация выборов пользователя из опросов ask_question (Decision Pinning + Variant 1B Model-Switch Pause + Fallback при отмене IDE)
  if (payload.error && toolName === 'ask_question') {
    const errText = String(payload.error || '');
    if (/(?:user\s+cancelled\s+ask_question|cancel|abort)/i.test(errText)) {
      const isEnHook = resolveUserLanguage(state) === 'en';
      try {
        const turnFile = join(getCacheDir(), 'pre-invocation-turn.json');
        updateJsonAtomicSync(turnFile, () => ({ turns: {} }), (tState) => {
          const turns = tState?.turns && typeof tState.turns === 'object' ? tState.turns : {};
          const prev = Object.hasOwn(turns, postConvoKey) ? turns[postConvoKey] : { hash: '', ts: Date.now() };
          turns[postConvoKey] = {
            ...prev,
            askQuestionCalled: true,
            askQuestionCancelledFallback: true,
            preTaskGateRequired: false,
          };
          return { turns };
        });
      } catch {}
      return {
        systemMessage: isEnHook
          ? '⚠️ [ask_question Fallback] The IDE cancelled the popup (`user cancelled ask_question`). Do NOT claim edits were cancelled unless the user explicitly cancelled them; print the 3 numbered options directly in chat, ask the user to reply with `1`, `2`, or `3`, and end the turn.'
          : '⚠️ [ask_question Fallback] IDE сбросила всплывающее окно (`user cancelled ask_question`). НЕ пиши «Запуск правок отменён» — выведи 3 пронумерованных варианта прямо в чат, попроси пользователя ответить цифрой `1`, `2` или `3` и заверши ход.',
      };
    }
    return {};
  }

  if (!payload.error && toolName === 'ask_question') {
    const rawOutput = String(payload.output || payload.result || payload.response || '');
    const isModelSwitchPauseReply = /(?:пауз[аеыу].*модел|заверш(?:ить|и)\s+ход.*модел|смен[иыуть].*модел|переключ[иыуть].*модел|end\s+turn.*switch.*model|pause.*switch.*model)/i.test(rawOutput);
    if (isModelSwitchPauseReply) {
      try {
        const turnFile = join(getCacheDir(), 'pre-invocation-turn.json');
        updateJsonAtomicSync(turnFile, () => ({ turns: {} }), (tState) => {
          const turns = tState?.turns && typeof tState.turns === 'object' ? tState.turns : {};
          const prev = Object.hasOwn(turns, postConvoKey) ? turns[postConvoKey] : { hash: '', ts: Date.now() };
          turns[postConvoKey] = {
            ...prev,
            modelSwitchPending: true,
            askQuestionCalled: false,
            preTaskGateRequired: true,
          };
          return { turns };
        });
      } catch (err) {
        console.error('[hook] modelSwitchPending update failed in PostToolUse:', err);
      }
    }
    if (sessionHandoff?.recordUserDecision) {
      try {
        let parsedQuestions = args.questions;
        if (typeof parsedQuestions === 'string') {
          try { parsedQuestions = JSON.parse(parsedQuestions); } catch { parsedQuestions = []; }
        }
        const questions = Array.isArray(parsedQuestions) ? parsedQuestions : [];
        const answerLines = rawOutput
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => /^A\d+\s*:/i.test(l));

        for (let i = 0; i < questions.length; i++) {
          const qText = String(questions[i]?.question || '').trim();
          const ansLine = answerLines[i] ? answerLines[i].replace(/^A\d+\s*:\s*/i, '').trim() : '';
          const fallbackAns = !ansLine && answerLines.length === 1 ? answerLines[0].replace(/^A\d+\s*:\s*/i, '').trim() : '';
          const finalAns = ansLine || fallbackAns;
          if (qText && finalAns) {
            sessionHandoff.recordUserDecision({
              workspaceRoot: wsPath,
              conversationId: payload.conversationId || '',
              question: qText.slice(0, 120),
              answer: finalAns.slice(0, 140),
              category: /дизайн|стил|визуал|палитр|анимац|design|style|visual|palette|animat/i.test(qText) ? 'ui_style' : 'autopilot_plan',
            });
          }
        }
      } catch (err) {
        console.error('[hook] recordUserDecision failed in PostToolUse:', err);
      }
    }
    return {};
  }

  // 1. Обработка выводов/ошибок терминальных команд run_command (+ GPU Auto-Distill на gemma4:12b)
  if (toolName === 'run_command') {
    const errStr = payload.error ? String(payload.error) : '';
    const tr = payload.toolResponse && typeof payload.toolResponse === 'object' ? payload.toolResponse : null;
    const rawParts = [];
    const seenParts = new Set();
    for (const part of [
      errStr,
      payload.stdout,
      payload.stderr,
      payload.output,
      payload.result,
      payload.response,
      tr?.stdout,
      tr?.stderr,
      tr?.output,
      tr?.result,
      typeof payload.toolResponse === 'string' ? payload.toolResponse : '',
    ]) {
      const s = part === undefined || part === null ? '' : String(part).trim();
      if (s && !seenParts.has(s)) {
        seenParts.add(s);
        rawParts.push(s);
      }
    }
    const rawCmdOutput = rawParts.join('\n');
    const safeCmdOutput = securityGuard?.redactSecretsInText
      ? securityGuard.redactSecretsInText(rawCmdOutput)
      : rawCmdOutput;
    const safeErrStr = securityGuard?.redactSecretsInText
      ? securityGuard.redactSecretsInText(errStr)
      : errStr;

    if (payload.error) {
      if (state.circuitBreaker !== false && circuitBreaker?.recordErrorFingerprint) {
        try {
          circuitBreaker.recordErrorFingerprint({
            source: 'run_command',
            errorText: safeErrStr,
            workspaceRoot: wsPath,
            conversationId: postConvoKey,
          });
        } catch (err) {
          console.error('[hook] recordErrorFingerprint failed in PostToolUse:', err);
        }
      }
      try {
        executionTracker?.recordTaskStep?.({
          workspaceRoot: wsPath,
          conversationId: postConvoKey,
          verifyOk: false,
          errorText: safeErrStr,
        });
      } catch {}
      if (state.runtimeWiretapEnabled !== false) {
        try {
          const [wiretapMod] = await loadDepsByNames(['runtimeWiretap']);
          wiretapMod?.ingestRuntimeFault?.({
            workspaceRoot: wsPath,
            source: 'hook_run_command',
            command: String(args.CommandLine || args.command || args.cmd || ''),
            rawError: safeCmdOutput || safeErrStr,
            exitCode: Number.isFinite(Number(payload.exitCode)) ? Number(payload.exitCode) : 1,
            state,
          });
        } catch {}
      }
      if (state.quotaPacerEnabled !== false && /\b429\b|RESOURCE_EXHAUSTED|QUOTA_EXHAUSTED|rate[\s_-]*limit/i.test(`${safeCmdOutput}\n${safeErrStr}`)) {
        try {
          await loadDepsByNames(['quotaPacer']);
          quotaPacerMod?.recordComboProviderCooldown?.({
            modelOrTier: payload.modelName || 'hydrogen',
            reason: 'quota_429',
          });
        } catch {}
      }
    } else {
      const cmdLine = String(args.CommandLine || args.command || args.cmd || '');
      if (TEST_RUNNER_CMD_RE.test(cmdLine)) {
        try {
          const turnFile = join(getCacheDir(), 'pre-invocation-turn.json');
          updateJsonAtomicSync(turnFile, () => ({ turns: {} }), (tState) => {
            const rawTurns = tState?.turns && typeof tState.turns === 'object' ? { ...tState.turns } : {};
            const prev = Object.hasOwn(rawTurns, postConvoKey) ? rawTurns[postConvoKey] : { hash: '', ts: Date.now() };
            rawTurns[postConvoKey] = {
              ...prev,
              pendingPhaseTransition: 'verify_passed',
              ts: Date.now(),
            };
            const turns = pruneObjectMapByTimestamp(rawTurns, {
              maxEntries: MAX_TURN_ENTRIES,
              maxAgeMs: TURN_ENTRY_TTL_MS,
              getTs: (v) => Number(v?.ts || 0),
            });
            return { turns };
          }, { spaces: 0 });
        } catch {}
        if (state.pitfallLedger !== false) {
          try {
            await loadDepsByNames(['pitfallLedger']);
            const resolvedRes = resolveTestPitfallsFromCommand({
              commandLine: cmdLine,
              output: safeCmdOutput,
              workspaceRoot: wsPath,
              pitfallLedgerMod: pitfallLedger,
            });
            if (resolvedRes?.resolved > 0 && state.sqliteKnowledgeEnabled !== false) {
              try {
                await loadDepsByNames(['knowledgeHub', 'sessionHandoff']);
                const handoff = sessionHandoff?.getSessionHandoff?.(wsPath, { createDir: false });
                const touched = Array.isArray(handoff?.touchedFiles)
                  ? handoff.touchedFiles.slice(0, 6).map((tf) => (typeof tf === 'string' ? tf : tf?.file || tf?.path)).filter(Boolean)
                  : resolvedRes.targets;
                knowledgeHubMod?.knowledgeHub?.recordVictoryRecipe?.({
                  workspaceRoot: wsPath,
                  errorExcerpt: resolvedRes.targets.join(', '),
                  touchedFiles: touched,
                  fixSummary: `Passing verification (${cmdLine.slice(0, 72)}) cleared ${resolvedRes.resolved} pitfall(s)`,
                });
              } catch {}
            }
          } catch {}
        }
      }
    }

    if (taskProgress?.recordTaskProgressOnPostTool) {
      try {
        taskProgress.recordTaskProgressOnPostTool({
          conversationId: String(payload.conversationId || 'default'),
          workspaceRoot: resolveTaskProgressWorkspace(payload),
          transcriptPath: payload.transcriptPath || '',
          toolName: 'run_command',
          commandLine: args.CommandLine || args.command || args.cmd || '',
          toolSummary: String(args.toolSummary || '').trim(),
          hasError: Boolean(payload.error),
          verifyOk: !payload.error,
        });
      } catch {}
    }

    if (state.completionGates !== false && completionGates?.isVerificationTestCommand) {
      try {
        const cmdLineForGate = String(args.CommandLine || args.command || args.cmd || '');
        if (completionGates.isVerificationTestCommand(cmdLineForGate)) {
          completionGates.recordSessionTestExecution?.({
            conversationId: postConvoKey,
            workspaceRoot: wsPath,
            commandLine: cmdLineForGate,
            output: safeCmdOutput,
            exitCode: payload.error ? 1 : 0,
          });
        }
      } catch {}
    }

    if (state.circuitBreaker !== false && circuitBreaker?.recordAndCheckStalledToolRound) {
      try {
        const stallRes = circuitBreaker.recordAndCheckStalledToolRound({
          conversationId: postConvoKey,
          toolName: 'run_command',
          args: { CommandLine: String(args.CommandLine || args.command || args.cmd || '') },
          resultText: safeCmdOutput || safeErrStr,
          isError: Boolean(payload.error),
          lang: resolveUserLanguage(state),
        });
        if (stallRes?.stalled && stallRes.formattedAlert) {
          enqueuePostCommandHint(postConvoKey, stallRes.formattedAlert);
        }
      } catch {}
    }

    if (
      state.sqliteKnowledgeEnabled !== false &&
      frictionObserver?.detectCliFailRecoveryFriction &&
      wsPath
    ) {
      try {
        const cliCmdStr = String(args.CommandLine || args.command || args.cmd || '');
        const cliRec = frictionObserver.detectCliFailRecoveryFriction({
          conversationId: postConvoKey,
          commandLine: cliCmdStr,
          exitCode: payload.error ? 1 : 0,
          errorOutput: payload.error ? `${safeErrStr}\n${safeCmdOutput.slice(0, 600)}` : '',
        });
        if (cliRec?.detected && cliRec.candidatePattern && frictionObserver.recordFrictionObservation) {
          const obs = frictionObserver.recordFrictionObservation({
            workspaceRoot: wsPath,
            signalType: 'cli_correction',
            pattern: cliRec.candidatePattern,
            lang: resolveUserLanguage(state),
          });
          if (obs?.readyForPromotion && obs.promotionHint) {
            enqueuePostCommandHint(postConvoKey, obs.promotionHint);
          }
        }
      } catch {}
    }

    if (state.ramCacheEnabled !== false && state.ramSotaEngines !== false && !payload.error && safeCmdOutput.length >= 600) {
      try {
        const cmdStr = String(args.CommandLine || args.command || args.cmd || '');
        const cmdSha1 = createHash('sha1').update(`${cmdStr}|${safeCmdOutput}`).digest('hex');
        const stepIdx = (payload.stepIdx !== undefined && payload.stepIdx !== null && Number.isFinite(Number(payload.stepIdx)))
          ? Number(payload.stepIdx)
          : -1;
        const targetKey = cmdStr.slice(0, 120);
        const memoRes = await queryRamDaemon('/hook/memo-check', {
          convoId: postConvoKey,
          toolName: 'run_command',
          targetKey,
          currentSha1: cmdSha1,
          stepIdx,
        }, 35);
        if (memoRes?.hit && memoRes.memoNotice) {
          return { modifiedOutput: memoRes.memoNotice };
        }
        if (memoRes !== null) {
          await queryRamDaemon('/hook/memo-record', {
            convoId: postConvoKey,
            toolName: 'run_command',
            targetKey,
            contentSha1: cmdSha1,
            charLen: safeCmdOutput.length,
            stepIdx,
          }, 35);
        }
      } catch {}
    }

    if (state.obsMasking !== false && safeCmdOutput.length > 700 && obsMasker?.maskTerminalOutput) {
      try {
        const enableCcr = state.sqliteKnowledgeEnabled !== false && !isEphemeralPostWs;
        const masked = obsMasker.maskTerminalOutput(safeCmdOutput, payload.error ? 1 : 0, {
          enabled: true,
          commandLine: String(args.CommandLine || args.command || args.cmd || ''),
          enableCcr,
          workspaceRoot: wsPath,
        });
        if (
          masked?.cpuCompressed &&
          masked.maskedChars <= 1150 &&
          masked.savedChars >= safeCmdOutput.length * 0.45
        ) {
          const savedTok = Math.max(0, Math.round(masked.savedChars / 3.8));
          try {
            const poolMod = await loadDepsByNames(['cpuWorkerPool']).then((r) => r[0]);
            const cpuSavingKind = masked.compressionKind === 'json' || masked.wasCrushed ? 'json' : 'drain';
            poolMod?.recordCpuCompressionSaving?.({
              kind: cpuSavingKind,
              savedChars: masked.savedChars,
            });
          } catch {}
          enqueuePostCommandHint(
            postConvoKey,
            `⚡ [CPU Drain3/Crusher ${masked.originalLines}L -> ${masked.maskedChars} chars, ~-${savedTok} tok]\n${masked.masked}`
          );
          return {};
        }
      } catch {}
    }

    if ((safeCmdOutput.length > 1800 || (Boolean(payload.error) && safeCmdOutput.length > 1100)) && Boolean(state.gpuEnabled) && state.gpuAutoDistillLogs !== false) {
      try {
        let distillCcrHash = '';
        if (state.sqliteKnowledgeEnabled !== false && !isEphemeralPostWs) {
          try {
            const [hubMod] = await loadDepsByNames(['knowledgeHub']);
            const ccrRes = hubMod?.knowledgeHub?.storeCcrBlob?.({
              text: safeCmdOutput,
              workspaceRoot: wsPath,
              source: 'gpu_distill',
              commandHint: String(args.CommandLine || args.command || ''),
              compressedChars: 900,
            });
            if (ccrRes?.ok && ccrRes.hash) distillCcrHash = ccrRes.hash;
          } catch {}
        }
        const distillT0 = Date.now();
        const distillReq = {
          text: safeCmdOutput,
          workspaceRoot: wsPath,
          mode: payload.error ? 'error_log' : 'general',
          query: String(args.CommandLine || args.command || '').slice(0, 160),
          maxOutputTokens: 380,
          minFreeVramMb: 5500,
          strictTimeout: true,
          timeoutMs: 8500,
        };
        let distillRes = await queryRamDaemon('/gpu/distill', distillReq, 8500);
        const remMs = 13200 - (Date.now() - distillT0);
        if (!distillRes && localGpuMod?.distillText && remMs >= 2500) {
          distillRes = await localGpuMod.distillText({ ...distillReq, timeoutMs: Math.max(2500, remMs) });
        }
        if (distillRes?.ok && distillRes.summary) {
          const crumbLine = distillCcrHash
            ? `\n[📦 CCR #${distillCcrHash} | ${safeCmdOutput.length}->${distillRes.distilledChars} chars · Retrieve: ram_ccr_retrieve(hash="${distillCcrHash}", query="...")]`
            : '';
          enqueuePostCommandHint(
            postConvoKey,
            `🎮 [GPU Auto-Distill (${distillRes.model} | ${safeCmdOutput.length} -> ${distillRes.distilledChars} chars, ~-${distillRes.savedTokensEstimate} tok)]\n${distillRes.summary}${crumbLine}`
          );
          return {};
        }
      } catch {}
    }

    if (payload.error && state.obsMasking !== false && safeErrStr.length > 600 && obsMasker?.maskTerminalOutput) {
      try {
        const enableCcr = state.sqliteKnowledgeEnabled !== false && !isEphemeralPostWs;
        const masked = obsMasker.maskTerminalOutput(safeErrStr, 1, {
          enabled: true,
          commandLine: String(args.CommandLine || args.command || args.cmd || ''),
          enableCcr,
          workspaceRoot: wsPath,
        });
        if (masked?.masked && masked.maskedChars < errStr.length) {
          enqueuePostCommandHint(
            postConvoKey,
            `🧹 [ObsMasking ${masked.originalLines}L -> ${masked.maskedChars} chars] ${masked.masked}`
          );
          return {};
        }
      } catch {}
    }
    return {};
  }

  // 2. Обработка успешных модификаций файлов edit_file / write_file
  if (!payload.error && (toolName === 'edit_file' || toolName === 'write_file') && filePath) {
    const effectiveFileWs = shadowGuard?.resolveEffectiveProjectRoot
      ? shadowGuard.resolveEffectiveProjectRoot(filePath, wsPath)
      : wsPath;
    try {
      if (readDedup?.markFileEditedForDelta) {
        readDedup.markFileEditedForDelta(filePath);
      } else {
        readDedup?.invalidateReadCacheForFile?.(filePath);
      }
    } catch {}
    try {
      await loadDepsByNames(['repoMapper']);
      repoMapper?.invalidateRepoMapCache?.(effectiveFileWs, filePath);
    } catch {}

    let isSyntaxValid = true;
    let verifyErrorText = '';

    // Каскадная верификация синтаксиса и запись сбоев в Pitfall Ledger
    if (state.selfVerify !== false && state.cascadeVerify !== false && autoVerifierMod?.recordVerifyAndCheckCascade) {
      try {
        const vRes = autoVerifierMod.recordVerifyAndCheckCascade({
          filePath,
          conversationId: postConvoKey,
          workspaceRoot: effectiveFileWs,
          modelName: payload.modelName || '',
        });
        if (vRes) {
          isSyntaxValid = !!vRes.valid;
          if (!vRes.valid && vRes.error) {
            verifyErrorText = `${filePath}:1\n${String(vRes.error)}`;
          }
          if (vRes.valid) {
            try {
              circuitBreaker?.recordCleanSuccess?.({
                filePath,
                workspaceRoot: effectiveFileWs,
                conversationId: postConvoKey,
              });
            } catch {}
          }

          if (!vRes.valid) {
            if (state.pitfallLedger !== false && pitfallLedger?.recordPitfall) {
              pitfallLedger.recordPitfall({
                type: 'syntax_error',
                fileName: basename(filePath),
                summary: `Syntax error (${vRes.checker || 'syntax'}) in ${basename(filePath)}: ${String(vRes.error || '').slice(0, 90)}`,
                workspaceRoot: effectiveFileWs,
              });
            }
          }
        }
      } catch (err) {
        console.error('[hook] Auto-verify failed in PostToolUse:', err);
      }
    }

    let oldTextBeforeEdit = '';
    const snapKey = resolve(filePath).toLowerCase();
    try {
      const snapStore = safeReadJsonSync(getPreEditSnapshotFile(), () => ({ entries: {} }), { selfHeal: false });
      if (snapStore?.entries && Object.hasOwn(snapStore.entries, snapKey)) {
        const entry = snapStore.entries[snapKey];
        if (entry && typeof entry.text === 'string' && (Date.now() - (entry.ts || 0)) < 10 * 60 * 1000) {
          oldTextBeforeEdit = entry.text;
        }
      }
    } catch {}

    if (isSyntaxValid && state.selfVerify !== false && state.gpuPostEditCritic !== false && /\.[cm]?js$/i.test(filePath)) {
      try {
        const [gpuMod] = await loadDepsByNames(['localGpuMod']);
        if (gpuMod?.scanAddedIdentifiersForRefBugs && existsSync(filePath)) {
          const newCode = readFileSync(filePath, 'utf8');
          const oldReconstructed = oldTextBeforeEdit || (
            toolName === 'edit_file' && args.Target !== undefined && args.Replacement !== undefined && newCode.includes(String(args.Replacement))
              ? newCode.replace(String(args.Replacement), String(args.Target))
              : ''
          );
          const refRes = gpuMod.scanAddedIdentifiersForRefBugs(oldReconstructed, newCode, extname(filePath).toLowerCase());
          if (!refRes.ok && refRes.issues.length > 0) {
            enqueuePostCommandHint(
              postConvoKey,
              `🔎 [Post-Edit Critic (${basename(filePath)})] ${refRes.issues.join('; ')}`
            );
          }
        }
      } catch {}
    }

    // Проверка добавленных заглушек (Unlazy Stub Diff) и циклических перезаписей (Task-Observer Churn)
    if (existsSync(filePath)) {
      try {
        const newCodeForGate = readFileSync(filePath, 'utf8');
        let prevEditText = oldTextBeforeEdit;
        if (!prevEditText && toolName === 'edit_file' && args.Target !== undefined && args.Replacement !== undefined && newCodeForGate.includes(String(args.Replacement))) {
          prevEditText = newCodeForGate.replace(String(args.Replacement), String(args.Target));
        }

        if (state.completionGates !== false) {
          completionGates?.recordSessionCodeEdit?.({
            conversationId: postConvoKey,
            workspaceRoot: effectiveFileWs,
            filePath,
          });
          if (completionGates?.computeDiffReuseMetrics && prevEditText) {
            const cachedMap = repoMapper?.getCachedRepoMap?.(effectiveFileWs, { skipWrite: true });
            const knownSyms = [];
            if (cachedMap?.files && typeof cachedMap.files === 'object') {
              for (const fInfo of Object.values(cachedMap.files)) {
                if (Array.isArray(fInfo?.symbols)) {
                  for (const s of fInfo.symbols) {
                    if (s?.name) knownSyms.push(s.name);
                    else if (typeof s === 'string') knownSyms.push(s);
                  }
                }
              }
            }
            const reuseRes = completionGates.computeDiffReuseMetrics(prevEditText, newCodeForGate, filePath, knownSyms);
            if (!reuseRes?.skipped) {
              completionGates.recordSessionReuseMetrics?.({
                conversationId: postConvoKey,
                workspaceRoot: effectiveFileWs,
                reusedSymbols: reuseRes.reusedSymbols,
                newSymbols: reuseRes.newSymbols,
              });
            }
          }
        }

        if (state.leanMode !== 'off' && (newCodeForGate.includes('shortcut:') || newCodeForGate.includes('ponytail:'))) {
          try {
            const [debtMod] = await loadDepsByNames(['shortcutDebt']);
            const debtHits = debtMod?.extractFileShortcutMarkers?.(basename(filePath), newCodeForGate) || [];
            const rotHits = debtHits.filter((h) => h.rotRisk);
            if (rotHits.length > 0) {
              const isEnDebt = resolveUserLanguage(state) === 'en';
              enqueuePostCommandHint(
                postConvoKey,
                isEnDebt
                  ? `📌 [Shortcut Debt (${basename(filePath)})] ${rotHits.length} marker(s) missing upgrade trigger (L${rotHits[0].line}). Use \`// shortcut: <ceiling>, <when to upgrade>\`.`
                  : `📌 [Техдолг shortcut: (${basename(filePath)})] ${rotHits.length} мет. без триггера апгрейда (L${rotHits[0].line}). Укажите \`// shortcut: <лимит>, <когда обновить>\`.`
              );
            }
          } catch {}
        }

        if (state.completionGates !== false && (completionGates?.scanAddedStubsInDiff || completionGates?.scanAddedSkippedTestsInDiff || completionGates?.scanConstraintWeakeningInDiff)) {
          const stubRes = completionGates.scanAddedStubsInDiff
            ? completionGates.scanAddedStubsInDiff(prevEditText, newCodeForGate, filePath)
            : { ok: true, skipped: true, issues: [] };
          const skipRes = completionGates.scanAddedSkippedTestsInDiff
            ? completionGates.scanAddedSkippedTestsInDiff(prevEditText, newCodeForGate, filePath)
            : { ok: true, skipped: true, issues: [] };
          const constraintRes = completionGates.scanConstraintWeakeningInDiff
            ? completionGates.scanConstraintWeakeningInDiff(prevEditText, newCodeForGate, filePath)
            : { ok: true, skipped: true, issues: [] };
          const mergedIssues = [
            ...(!stubRes.skipped && !stubRes.ok ? stubRes.issues : []),
            ...(!skipRes.skipped && !skipRes.ok ? skipRes.issues : []),
            ...(!constraintRes.skipped && !constraintRes.ok ? constraintRes.issues : []),
          ].slice(0, 8);
          const anyScanned = !stubRes.skipped || !skipRes.skipped || !constraintRes.skipped;
          if (anyScanned) {
            if (mergedIssues.length > 0) {
              completionGates.recordSessionFileStubs?.({
                conversationId: postConvoKey,
                workspaceRoot: effectiveFileWs,
                filePath,
                issues: mergedIssues,
              });
              const locList = mergedIssues.slice(0, 3).map((it) => `L${it.line} (${it.kind})`).join(', ');
              const hasSkippedTest = mergedIssues.some((it) => it.kind === 'skipped_test');
              const hasConstraintDrop = mergedIssues.some((it) => it.kind === 'lint_suppression' || it.kind === 'focused_test_only' || it.kind === 'stripped_assertions');
              const isEnPost = resolveUserLanguage(state) === 'en';
              enqueuePostCommandHint(
                postConvoKey,
                hasConstraintDrop
                  ? (isEnPost
                      ? `🛡️ [Constraint Diff Guard (${basename(filePath)})] Quality bar weakened in diff: ${locList}. Fix the root issue instead of silencing checks or dropping assertions.`
                      : `🛡️ [Constraint Diff Guard (${basename(filePath)})] В диффе ослаблены проверки качества: ${locList}. Исправьте причину вместо подавления линтеров или удаления проверок.`)
                  : hasSkippedTest
                    ? (isEnPost
                        ? `🚧 [Unlazy Test Gate (${basename(filePath)})] Skipped tests or stubs added in diff: ${locList}. Remove skip/todo before final reply.`
                        : `🚧 [Unlazy Test Gate (${basename(filePath)})] В диффе добавлены отключённые тесты или заглушки: ${locList}. Уберите skip/todo до финального ответа.`)
                    : (isEnPost
                        ? `🚧 [Unlazy Stub Check (${basename(filePath)})] New stubs/TODOs detected: ${locList}. Finish the implementation before final reply.`
                        : `🚧 [Unlazy Stub Check (${basename(filePath)})] Обнаружены новые заглушки/TODO: ${locList}. Доведите реализацию до конца до финального ответа.`)
              );
            } else if (toolName === 'write_file') {
              completionGates.clearSessionFileStubs?.({ conversationId: postConvoKey, filePath });
            } else if (toolName === 'edit_file') {
              const prevStubSnap = completionGates.getSessionStubSummary?.({ conversationId: postConvoKey });
              const normTarget = String(filePath).replace(/\\/g, '/');
              const prevEntry = prevStubSnap?.files?.find((f) => f.filePath === normTarget);
              if (prevEntry && Array.isArray(prevEntry.issues)) {
                const stillPresent = prevEntry.issues.some((iss) => iss?.excerpt && newCodeForGate.includes(iss.excerpt));
                if (!stillPresent) {
                  completionGates.clearSessionFileStubs?.({ conversationId: postConvoKey, filePath });
                }
              }
            }
          }
        }

        if (
          toolName === 'edit_file' &&
          state.skillCrystallizer !== false &&
          state.sqliteKnowledgeEnabled !== false &&
          !isEphemeralPostWs &&
          frictionObserver?.detectEditChurnFriction
        ) {
          const churn = frictionObserver.detectEditChurnFriction({
            conversationId: postConvoKey,
            filePath,
            targetText: String(args.Target || ''),
            replacementText: String(args.Replacement || ''),
            workspaceRoot: effectiveFileWs,
          });
          if (churn?.detected && churn.candidatePattern && knowledgeHubMod?.knowledgeHub) {
            frictionObserver.recordFrictionObservation({
              workspaceRoot: effectiveFileWs,
              signalType: churn.signalType,
              pattern: churn.candidatePattern,
              hub: knowledgeHubMod.knowledgeHub,
              lang: resolveUserLanguage(state),
            });
          }
        }
      } catch {}
    }
    if (oldTextBeforeEdit) {
      try {
        updateJsonAtomicSync(getPreEditSnapshotFile(), () => ({ entries: {} }), (st) => {
          const entries = st?.entries && typeof st.entries === 'object' ? { ...st.entries } : {};
          delete entries[snapKey];
          return { entries };
        });
      } catch {}
    }

    let br = null;
    let ramContractHandled = false;
    let brokenContractAlert = '';
    let brokenDependents = [];

    // Синхронизация изменённого файла в RAM и мгновенная проверка Blast Radius + контрактов из оперативки
    if (state.ramCacheEnabled !== false && effectiveFileWs) {
      const ramPost = await queryRamDaemon('/hook/post-edit', { wsPath: effectiveFileWs, filePath }, 60);
      if (ramPost?.ok && ramPost.updated && Array.isArray(ramPost.dependents)) {
        br = { dependents: ramPost.dependents, formattedHint: ramPost.blastRadiusHint || '' };
      }
      if (ramPost?.ok && typeof ramPost.contractValid === 'boolean') {
        ramContractHandled = true;
        if (!ramPost.contractValid) {
          brokenContractAlert = ramPost.contractAlert || '';
          brokenDependents = [...(ramPost.brokenImports || [])];
          for (const issue of ramPost.semanticIssues || []) {
            if (issue?.file) {
              brokenDependents.push({ dependentFile: issue.file, missingSymbols: [issue.type] });
            }
          }
        }
      }
      if (state.lspBridgeEnabled !== false && ramPost?.lspAlert) {
        const lspHint = autoVerifierMod?.formatLspDiagnosticsHint
          ? autoVerifierMod.formatLspDiagnosticsHint(filePath, ramPost)
          : `🧬 [LSP Type Check] ${String(ramPost.lspAlert).replace(/^🧬\s*/, '').trim()}`;
        if (lspHint) {
          enqueuePostCommandHint(postConvoKey, lspHint);
        }
      }
    }

    // Fallback: подгружаем repoMapper на диск ТОЛЬКО если RAM-демон не покрыл Blast Radius или контракты
    if ((!br && state.blastRadius !== false) || (isSyntaxValid && !ramContractHandled)) {
      await loadDepsByNames(['repoMapper']);
    }

    // Анализ радиуса поражения правок (Blast Radius, изолированно по convoKey для параллельных веток Роя)
    if (state.blastRadius !== false && (br || (repoMapper && typeof repoMapper.findReverseImporters === 'function'))) {
      try {
        if (!br && repoMapper?.findReverseImporters) {
          br = repoMapper.findReverseImporters(effectiveFileWs, filePath);
        }

        if (br && (br.formattedHint || (Array.isArray(br.dependents) && br.dependents.length > 0))) {
          const hint =
            br.formattedHint ||
            `🎯 [Blast Radius] Edits in ${basename(filePath)} affect imports in: ${br.dependents.map((d) => d.file).join(', ')}. Keep exported signatures backward-compatible!`;
          updateJsonAtomicSync(
            join(getCacheDir(), 'blast-radius-queue.json'),
            () => ({ queues: {} }),
            (qState) => {
              const queues = qState && typeof qState.queues === 'object' && !Array.isArray(qState.queues) ? qState.queues : {};
              queues[postConvoKey] = { hint, workspaceRoot: effectiveFileWs, ts: Date.now() };
              return { queues };
            }
          );
        }
      } catch (err) {
        console.error('[hook] Blast Radius calculation failed in PostToolUse:', err);
      }
    }

    // Запись синтаксического исхода в Байесовский маршрутизатор с risk-weighted учётом Blast Radius и тира модели
    const fpLower = filePath.toLowerCase();
    const inferredDomain = /(?:security|auth|guard|secret|token|crypt|firewall)/i.test(fpLower)
      ? 'security'
      : /\.(?:css|scss|less|html|vue|svelte|jsx|tsx)$|(?:view|ui|component|style|theme|modal|panel|particle|anim)/i.test(fpLower)
        ? 'ui_browser'
        : /\.(?:md|txt|rst)$/i.test(fpLower)
          ? 'docs'
          : /\.(?:sql|prisma)$|(?:schema|migration|controller|route|db|database)/i.test(fpLower)
            ? 'backend_db'
            : /(?:dockerfile|\.ya?ml|\.sh|\.ps1|compose)/i.test(fpLower)
              ? 'devops'
              : 'algo_refactor';
    let postModelProfile = null;
    try {
      postModelProfile = modelProfileMod?.resolveActiveModelProfile
        ? modelProfileMod.resolveActiveModelProfile({
            modelName: payload.modelName || '',
            transcriptPath: payload.transcriptPath || '',
            conversationId: payload.conversationId || '',
          })
        : null;
    } catch {}
    const activeTier = postModelProfile?.plannerTier || postModelProfile?.tier || payload.modelName || '';
    try {
      if (bayesianRouter && typeof bayesianRouter.recordModelOutcome === 'function') {
        bayesianRouter.recordModelOutcome({
          domain: inferredDomain,
          filePath,
          workspaceRoot: effectiveFileWs,
          success: isSyntaxValid,
          signalType: 'syntax',
          modelTier: activeTier,
          dependentsCount: br?.dependents?.length || 0,
        });
      }
    } catch {}

    // Проверка целостности импортов и семантических контрактов (если ещё не проверено в RAM-демоне)
    if (isSyntaxValid && !ramContractHandled && repoMapper?.verifyImportContracts && effectiveFileWs) {
      try {
        const contractRes = repoMapper.verifyImportContracts(effectiveFileWs, filePath);
        if (contractRes && !contractRes.valid) {
          brokenContractAlert = contractRes.formattedAlert || '';
          brokenDependents = contractRes.brokenImports || [];
        }
      } catch (err) {
        console.error('[hook] verifyImportContracts failed in PostToolUse:', err);
      }
    }

    if (isSyntaxValid && !ramContractHandled && repoMapper?.verifySemanticContracts && effectiveFileWs) {
      try {
        const semRes = repoMapper.verifySemanticContracts(effectiveFileWs, filePath);
        if (semRes && !semRes.valid && semRes.formattedAlert) {
          brokenContractAlert = brokenContractAlert
            ? `${brokenContractAlert}\n${semRes.formattedAlert}`
            : semRes.formattedAlert;
          for (const issue of semRes.issues || []) {
            if (issue?.file) {
              brokenDependents.push({ dependentFile: issue.file, missingSymbols: [issue.type] });
            }
          }
        }
      } catch (err) {
        console.error('[hook] verifySemanticContracts failed in PostToolUse:', err);
      }
    }

    if (isSyntaxValid && brokenDependents.length > 0) {
      try {
        bayesianRouter?.recordModelOutcome?.({
          domain: inferredDomain || 'algo_refactor',
          filePath,
          workspaceRoot: effectiveFileWs,
          success: false,
          signalType: 'contract_break',
          modelTier: activeTier,
          dependentsCount: br?.dependents?.length || brokenDependents.length,
        });
      } catch {}
    }

    // Микро-тестирование затронутых тестов (Test-Impact Verification) выполняется ДО записи итоговой телеметрии
    let microTestsOk = true;
    let microTestsRan = false;
    let impactedTestFile = '';
    let impactedTestFiles = [];
    if (isSyntaxValid && state.selfVerify !== false && state.testImpactVerify !== false) {
      try {
        const runMicroTests = autoVerifierMod?.runImpactedMicroTests;
        if (typeof runMicroTests === 'function') {
          const tRes = await runMicroTests({
            rootDir: effectiveFileWs,
            filePath,
            reverseImporters: br?.dependents || [],
          });
          microTestsRan = Boolean(tRes?.ran);
          impactedTestFiles = Array.isArray(tRes?.testFiles)
            ? tRes.testFiles.map((f) => basename(f)).filter(Boolean)
            : [];
          if (impactedTestFiles[0]) impactedTestFile = impactedTestFiles[0];
          if (tRes?.ran && !tRes.valid) {
            microTestsOk = false;
            if (tRes.error) {
              verifyErrorText = String(tRes.error);
            }
            try {
              if (bayesianRouter && typeof bayesianRouter.recordModelOutcome === 'function') {
                bayesianRouter.recordModelOutcome({
                  domain: inferredDomain || 'algo_refactor',
                  filePath,
                  workspaceRoot: effectiveFileWs,
                  success: false,
                  signalType: 'micro_test',
                  modelTier: activeTier,
                  dependentsCount: br?.dependents?.length || 0,
                });
              }
            } catch {}
            if (state.pitfallLedger !== false && pitfallLedger?.recordPitfall) {
              const testName = tRes.testFiles?.[0] ? basename(tRes.testFiles[0]) : 'test';
              pitfallLedger.recordPitfall({
                type: 'test_failure',
                fileName: basename(filePath),
                summary: `Test-Impact fail (${testName}): ${String(tRes.error || '').slice(0, 90)}`,
                workspaceRoot: effectiveFileWs,
              });
            }
          } else if (tRes?.ran && tRes.valid) {
            try {
              if (bayesianRouter && typeof bayesianRouter.recordModelOutcome === 'function') {
                bayesianRouter.recordModelOutcome({
                  domain: inferredDomain || 'algo_refactor',
                  filePath,
                  workspaceRoot: effectiveFileWs,
                  success: true,
                  signalType: 'micro_test',
                  modelTier: activeTier,
                  dependentsCount: br?.dependents?.length || 0,
                });
              }
            } catch {}
          }
        }
      } catch (err) {
        console.error('[hook] Test-Impact failed in PostToolUse:', err);
      }
    }

    const verifyAllOk = isSyntaxValid && microTestsOk && brokenDependents.length === 0;

    if (
      verifyAllOk &&
      state.mutationGuardEnabled === true &&
      /\.[cm]?js$/i.test(filePath) &&
      !/\.(?:test|spec)\.[cm]?js$/i.test(filePath)
    ) {
      try {
        const [mutMod] = await loadDepsByNames(['cpuMutationGuard']);
        if (mutMod?.runSemanticMutationGuard) {
          const mutLang = resolveUserLanguage(state);
          const mutRes = mutMod.runSemanticMutationGuard({
            workspaceRoot: effectiveFileWs,
            filePath,
            maxMutants: 3,
            timeoutMs: 6000,
            lang: mutLang,
          });
          if (mutRes?.ok && mutRes.survived > 0) {
            const firstSurv = mutRes.survivors?.[0];
            enqueuePostCommandHint(
              postConvoKey,
              mutLang === 'en'
                ? `🧬 [Mutation Guard] ${mutRes.survived}/${mutRes.totalMutants} boundary mutants survived in ${mutRes.file} (L${firstSurv?.line || '?'}: ${firstSurv?.original || ''} -> ${firstSurv?.mutated || ''}). Check edge-case tests.`
                : `🧬 [Mutation Guard] Выжило ${mutRes.survived}/${mutRes.totalMutants} граничных мутантов в ${mutRes.file} (L${firstSurv?.line || '?'}: ${firstSurv?.original || ''} -> ${firstSurv?.mutated || ''}). Проверьте граничные тесты.`
            );
          }
        }
      } catch {}
    }

    if (verifyAllOk && state.pitfallLedger !== false && pitfallLedger?.resolvePitfallsForFile) {
      try {
        const typesToResolve = microTestsRan
          ? ['syntax_abort', 'syntax_error', 'test_failure', 'test_fail']
          : ['syntax_abort', 'syntax_error'];
        const editedBase = basename(filePath);
        const resolveTargets = new Set([editedBase]);
        if (microTestsRan) {
          for (const tf of impactedTestFiles) {
            resolveTargets.add(tf);
          }
        }
        for (const targetBase of resolveTargets) {
          const isEditedFile = targetBase.toLowerCase() === editedBase.toLowerCase();
          pitfallLedger.resolvePitfallsForFile({
            fileName: targetBase,
            workspaceRoot: effectiveFileWs,
            types: isEditedFile ? typesToResolve : ['test_failure', 'test_fail'],
          });
        }
      } catch {}
    }

    // Запись объективной телеметрии хрупкости файла (File Fragility Telemetry) с учётом результатов тестов
    if (bayesianRouter?.recordFileFragility) {
      try {
        bayesianRouter.recordFileFragility({
          filePath,
          workspaceRoot: effectiveFileWs,
          success: verifyAllOk,
          dependentsCount: br?.dependents?.length || 0,
        });
      } catch {}
    }

    // Обновление живого трекера выполнения задачи и Fault Frame (Execution Tracker)
    if (executionTracker?.recordTaskStep) {
      try {
        executionTracker.recordTaskStep({
          workspaceRoot: effectiveFileWs,
          conversationId: postConvoKey,
          filePath,
          dependents: br?.dependents || [],
          brokenDependents,
          verifyOk: verifyAllOk,
          brokenContractAlert,
          errorText: verifyErrorText,
        });
      } catch (err) {
        console.error('[hook] executionTracker.recordTaskStep failed in PostToolUse:', err);
      }
    }

    if (taskProgress?.recordTaskProgressOnPostTool) {
      try {
        const taskProgressWs = (filePath && shadowGuard?.resolveEffectiveProjectRoot)
          ? shadowGuard.resolveEffectiveProjectRoot(filePath, resolveTaskProgressWorkspace(payload))
          : resolveTaskProgressWorkspace(payload);
        taskProgress.recordTaskProgressOnPostTool({
          conversationId: String(payload.conversationId || 'default'),
          workspaceRoot: taskProgressWs,
          transcriptPath: payload.transcriptPath || '',
          toolName,
          filePath,
          verifyOk: verifyAllOk,
          microTestsRan,
          dependentsCount: br?.dependents?.length || 0,
          brokenContractsCount: brokenDependents.length,
          testFile: impactedTestFile,
          hasError: Boolean(payload.error),
        });
      } catch {}
    }

    // Фиксация действия и архитектурного обоснования (MemDev-Bench Rationale) в Session Handoff
    if (state.sessionHandoff !== false) {
      try {
        const rejectedMsg = !isSyntaxValid || !microTestsOk
          ? `Syntax/test failure: ${String(verifyErrorText || '').replace(/\r?\n/g, ' ').slice(0, 80)}`
          : brokenDependents.length > 0
            ? `Broken import contract in: ${brokenDependents.map((b) => b.dependentFile).join(', ').slice(0, 80)}`
            : '';
        const rationaleMsg = verifyAllOk && (br?.dependents?.length > 0)
          ? `Verified clean patch preserving ${br.dependents.length} reverse dependent(s)`
          : '';
        sessionHandoff?.recordHandoffAction?.({
          workspaceRoot: effectiveFileWs,
          conversationId: payload.conversationId || '',
          toolName,
          filePath,
          verifyOk: verifyAllOk,
          rationale: rationaleMsg,
          rejectedApproach: rejectedMsg,
        });
      } catch (err) {
        console.error('[hook] recordHandoffAction failed in PostToolUse:', err);
      }
    }
  }

  return {};
}

/**
 * Обработчик события Stop (Antigravity 2.0): финализирует прогресс чата, фиксирует эпизод памяти и проверяет Completion Gates.
 * @param {object} [payload={}]
 * @param {object} [rawState={}]
 * @returns {Promise<object>}
 */
export async function handleStop(payload = {}, rawState = {}) {
  const state = applyHookProfileOverrides(rawState);
  const wsPath =
    payload.workspacePaths?.[0] || payload.workspacePath || payload.cwd || process.cwd();
  await ensureHookDeps('Stop');

  const stopConvoKey = swarmController?.resolveSwarmIsolationKey
    ? swarmController.resolveSwarmIsolationKey({
        conversationId: payload.conversationId || 'default',
        workspaceRoot: wsPath,
      })
    : String(payload.conversationId || 'default');

  const termReason = String(payload.terminationReason || '').trim();
  const hasErr = Boolean(payload.error) || /^ERROR$/i.test(termReason);
  const isEphemeralWs = Boolean(sessionHandoff?.isEphemeralTestWorkspace?.(wsPath));
  const rawConvoId = String(payload.conversationId || 'default');
  const swarmCtx = swarmController?.detectSwarmExecutionRole
    ? swarmController.detectSwarmExecutionRole(payload)
    : { role: 'standalone' };

  try {
    if (taskProgress?.finalizeTaskProgressOnStop) {
      taskProgress.finalizeTaskProgressOnStop({
        conversationId: stopConvoKey,
        workspaceRoot: resolveTaskProgressWorkspace(payload),
        transcriptPath: payload.transcriptPath || '',
        terminationReason: termReason,
        hasError: hasErr,
        fullyIdle: payload.fullyIdle !== undefined ? Boolean(payload.fullyIdle) : true,
      });
    }
  } catch (err) {
    console.error('[hook] finalizeTaskProgressOnStop failed in Stop:', err);
  }

  let touchedFiles = [];
  if (swarmCtx.role === 'standalone' && state.sessionHandoff !== false && sessionHandoff?.getSessionHandoff) {
    try {
      const hState = sessionHandoff.getSessionHandoff(wsPath, { createDir: false });
      const goals = Array.isArray(hState?.recentGoals) ? hState.recentGoals : [];
      const files = Array.isArray(hState?.touchedFiles) ? hState.touchedFiles : [];
      const decisions = Array.isArray(hState?.pinnedDecisions) ? hState.pinnedDecisions : [];
      const rationales = Array.isArray(hState?.rationales) ? hState.rationales : [];
      touchedFiles = files.map((f) => (typeof f === 'string' ? f : f?.file || f?.path)).filter(Boolean);

      if (
        !isEphemeralWs &&
        state.sqliteKnowledgeEnabled !== false &&
        knowledgeHubMod?.knowledgeHub?.recordSessionEpisode &&
        (goals.length > 0 || touchedFiles.length > 0)
      ) {
        const TRIVIAL_GOAL_RE = /^\s*(?:продолж\S*|continue|дальше|ок|да|yes|go|запускай|A\d+\s*:.*)\s*[.!?]*$/iu;
        const meaningfulGoal = goals.find((g) => g && !TRIVIAL_GOAL_RE.test(String(g)));
        const title = String(meaningfulGoal || goals[0] || `Session ${touchedFiles.slice(0, 2).map((f) => basename(f)).join(', ')}`).slice(0, 140);
        const summaryParts = [];
        if (goals.length > 0) summaryParts.push(`Goals: ${goals.slice(0, 2).join('; ')}`);
        if (rationales.length > 0) {
          summaryParts.push(
            `Rationale: ${rationales.slice(0, 2).map((r) => `${r.file ? `${basename(r.file)}: ` : ''}${r.rationale || r.rejected || ''}`).join('; ')}`
          );
        }
        const decisionTexts = decisions.slice(0, 5).map((d) => `${d.question || ''} -> ${d.answer || ''}`.trim()).filter(Boolean);
        knowledgeHubMod.knowledgeHub.recordSessionEpisode({
          workspaceRoot: wsPath,
          conversationId: rawConvoId,
          title,
          kind: hasErr ? 'bugfix' : 'session',
          summary: summaryParts.join(' | '),
          decisions: decisionTexts,
          touchedFiles,
        });
      }
    } catch {}
  }

  if (
    swarmCtx.role === 'standalone' &&
    !isEphemeralWs &&
    state.completionGates !== false &&
    payload.fullyIdle !== false &&
    completionGates?.evaluateStopCompletionGates
  ) {
    try {
      const turnEdited = executionTracker?.getEditedFilesForConversation
        ? executionTracker.getEditedFilesForConversation({ conversationId: stopConvoKey, workspaceRoot: wsPath })
        : [];
      const stubSum = completionGates?.getSessionStubSummary
        ? completionGates.getSessionStubSummary({ conversationId: stopConvoKey })
        : { totalIssues: 0 };
      if (turnEdited.length > 0 || Number(stubSum?.totalIssues || 0) > 0) {
        const gateRes = completionGates.evaluateStopCompletionGates({
          workspaceRoot: wsPath,
          conversationId: stopConvoKey,
          touchedFiles: turnEdited.length > 0 ? turnEdited : touchedFiles,
          hasError: hasErr,
          terminationReason: termReason,
          maxBlocks: 2,
          lang: resolveUserLanguage(state),
        });
        if (gateRes?.shouldWarn && gateRes.formattedSystemMessage) {
          return { systemMessage: gateRes.formattedSystemMessage };
        }
      }
    } catch {}
  }

  return {};
}

// Запуск при прямом вызове через CLI (node ./core/hook-runner.mjs EventName)
const isMain =
  process.argv[1] &&
  (import.meta.url === pathToFileURL(process.argv[1]).href ||
    process.argv[1].replace(/\\/g, '/').endsWith('core/hook-runner.mjs'));

if (isMain) {
  const eventName = process.argv[2] || '';
  const hookStartMs = Date.now();
  try {
    const payload = await readStdin();
    const state = loadRouterState();
    let result = {};

    switch (eventName) {
      case 'SessionStart':
        result = await handleSessionStart(payload, state);
        try { nodeModule.flushCompileCache?.(); } catch {}
        break;
      case 'PreInvocation':
        result = await handlePreInvocation(payload, state);
        break;
      case 'PreToolUse':
        result = await handlePreToolUse(payload, state);
        break;
      case 'PostToolUse':
        result = await handlePostToolUse(payload, state);
        break;
      case 'Stop':
        result = await handleStop(payload, state);
        break;
      default:
        result = {};
        break;
    }

    appendDebugLog({
      level: 'info',
      source: 'hook-runner',
      event: eventName || 'unknown',
      message: 'Hook completed',
      durationMs: Date.now() - hookStartMs,
      meta: {
        resultKeys: Object.keys(result || {}),
        decision: result?.decision || '',
      },
    }, { state, pluginRoot: PLUGIN_ROOT });

    const flushAndExit = (jsonPayload) => {
      const safetyTimer = setTimeout(() => process.exit(0), 250);
      if (typeof safetyTimer.unref === 'function') safetyTimer.unref();
      process.stdout.write(`${jsonPayload}\n`, () => {
        clearTimeout(safetyTimer);
        process.exit(0);
      });
    };

    flushAndExit(JSON.stringify(result || {}));
  } catch (err) {
    appendDebugLog({
      level: 'error',
      source: 'hook-runner',
      event: eventName || 'unknown',
      message: err?.message || String(err),
      durationMs: Date.now() - hookStartMs,
      meta: {
        name: err?.name || 'Error',
        stack: String(err?.stack || '').slice(0, 1200),
      },
    }, { pluginRoot: PLUGIN_ROOT });
    console.error('[hook] Critical error in hook-runner:', err);
    const fallbackOut = eventName === 'PreToolUse'
      ? JSON.stringify({ decision: 'allow' })
      : JSON.stringify({});
    const safetyTimer = setTimeout(() => process.exit(0), 250);
    if (typeof safetyTimer.unref === 'function') safetyTimer.unref();
    process.stdout.write(`${fallbackOut}\n`, () => {
      clearTimeout(safetyTimer);
      process.exit(0);
    });
  }
}

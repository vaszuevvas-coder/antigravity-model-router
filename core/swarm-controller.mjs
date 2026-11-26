/**
 * @file swarm-controller.mjs
 * @description Адаптивный контроллер нативного Роя (Swarm) для The Tunnel (antigravity-model-router).
 * Обеспечивает:
 *  1) распознавание роли текущего процесса (Coordinator / фоновый Swarm Worker / Standalone),
 *  2) защиту фоновых воркеров Роя от зависаний на пользовательских опросах (ask_question) и гонок кэша между ветками workspace:"share",
 *  3) умное распределение моделей (Координатор Carbon/Argon/Orchestrator + авторы Gemini 4 Hydrogen + Ревизор),
 *  4) протокол бесшовного переключения моделей при исчерпании квоты (Quota Failover без потери контекста),
 *  5) сбор живой телеметрии Роя из транскрипта сессии для боковой панели управления.
 */

import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizeSwarmWorkerTierForSubscription } from './model-profile.mjs';
import { recordComboProviderCooldown, resolveComboFailoverTarget } from './quota-pacer.mjs';
import { safeReadJsonSync, updateJsonAtomicSync } from './safe-json.mjs';
import { resolveTunnelCacheDir } from './cache-dir.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, '..');
const getSwarmRolesCacheFile = () => join(resolveTunnelCacheDir(PLUGIN_ROOT), 'swarm-roles.json');
const ROLE_TTL_MS = 12 * 60 * 60 * 1000;

function readPinnedSwarmRole(isolationKey) {
  if (!isolationKey || isolationKey === 'default') return null;
  const data = safeReadJsonSync(getSwarmRolesCacheFile(), () => ({ roles: {} }), { selfHeal: false });
  const entry = data?.roles?.[isolationKey];
  if (!entry || Date.now() - (entry.ts || 0) > ROLE_TTL_MS) return null;
  return entry;
}

export function pinSwarmRole(isolationKey, role, workerKind = '') {
  if (!isolationKey || isolationKey === 'default') return;
  try {
    updateJsonAtomicSync(
      getSwarmRolesCacheFile(),
      () => ({ roles: {} }),
      (cur) => {
        const roles = cur && typeof cur.roles === 'object' ? { ...cur.roles } : {};
        const now = Date.now();
        for (const [k, v] of Object.entries(roles)) {
          if (now - (v?.ts || 0) > ROLE_TTL_MS) delete roles[k];
        }
        roles[isolationKey] = { role, workerKind, ts: now };
        return { roles };
      }
    );
  } catch {}
}

export const SWARM_MODES = new Set(['auto_xl', 'aggressive_l', 'manual_only', 'off', 'always_ask', 'auto_all']);
export const SWARM_WORKER_TIERS = new Set(['hydrogen_auto', 'neon_auto', 'inherit', 'argon_auto', 'carbon_auto']);

const EXPLICIT_SWARM_RE = /(?:^|\s)\/swarm\b|(?:запусти|включи|подними|собери|используй|через)\s+(?:рой|swarm)\b|\bswarm[-\s]?(?:режим|воркер|агент)/i;
const QUOTA_SIGNAL_RE = /\[quota\]|quota[\s_-]*exhausted|out of quota|resource_exhausted|quota limit|исчерпан[аы]?\s+квот/i;
const SWARM_WORKER_TAG_RE = /<swarm_worker\b|You are this swarm's (?:narrator|stall monitor)|Load the swarm_(?:narrator|monitor) skill/i;
const VERIFIER_NAME_RE = /^(?:verifier|review|auditor|qa|tester|check)(?:-\d+)?$/i;
const SUPPORT_NAME_RE = /^(?:narrator|monitor)(?:-\d+)?$/i;

/**
 * Создаёт изолированный ключ состояния для параллельных воркеров в разных workspace:"share" / "branch".
 * @param {object} params
 * @param {string} [params.conversationId='default']
 * @param {string} [params.workspaceRoot='']
 * @returns {string}
 */
export function resolveSwarmIsolationKey(opts = {}) {
  const { conversationId = 'default', workspaceRoot = '' } = opts && typeof opts === 'object' ? opts : {};
  const rawConvo = String(conversationId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48) || 'default';
  if (!workspaceRoot || typeof workspaceRoot !== 'string') {
    return rawConvo;
  }
  const normWs = workspaceRoot.replace(/\\/g, '/').toLowerCase().trim();
  const wsHash = createHash('sha1').update(normWs).digest('hex').slice(0, 8);
  return `${rawConvo}__${wsHash}`;
}

/**
 * Быстро сканирует начало и хвост файла транскрипта (< 0.4 мс), чтобы определить роль агента в Рое.
 * @param {string} transcriptPath
 * @returns {{ hasSwarmAdminCall: boolean, hasBoardWorkerTools: boolean, hasWorkerSystemTag: boolean, inferredWorkerKind: string }}
 */
function peekSwarmSignalsFromTranscript(transcriptPath = '') {
  const empty = {
    hasSwarmAdminCall: false,
    hasBoardWorkerTools: false,
    hasWorkerSystemTag: false,
    inferredWorkerKind: '',
  };
  if (!transcriptPath || typeof transcriptPath !== 'string' || !existsSync(transcriptPath)) {
    return empty;
  }

  let fd = null;
  try {
    const st = statSync(transcriptPath);
    if (!st.isFile() || st.size <= 0) return empty;

    fd = openSync(transcriptPath, 'r');
    const headLen = Math.min(49_152, st.size);
    const headBuf = Buffer.allocUnsafe(headLen);
    readSync(fd, headBuf, 0, headLen, 0);
    let headStr = headBuf.toString('utf-8');
    if (st.size > headLen) {
      const lastNl = headStr.lastIndexOf('\n');
      if (lastNl > 0) headStr = headStr.slice(0, lastNl);
    }
    let sample = headStr;

    if (st.size > headLen) {
      const tailLen = Math.min(49_152, st.size - headLen);
      const tailBuf = Buffer.allocUnsafe(tailLen);
      readSync(fd, tailBuf, 0, tailLen, st.size - tailLen);
      let tailStr = tailBuf.toString('utf-8');
      const firstNl = tailStr.indexOf('\n');
      if (firstNl >= 0) tailStr = tailStr.slice(firstNl + 1);
      sample += '\n' + tailStr;
    }

    let hasWorkerSystemTag = false;
    let hasSwarmAdminCall = false;
    let hasBoardWorkerTools = false;
    let firstUserPrompt = '';

    for (const rawLine of sample.split('\n')) {
      const trimmed = rawLine.trim();
      if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) continue;
      try {
        const obj = JSON.parse(trimmed);
        if ((obj.type === 'USER_INPUT' || obj.type === 'SYSTEM' || obj.type === 'SYSTEM_MESSAGE') && typeof obj.content === 'string') {
          if (!firstUserPrompt && obj.type === 'USER_INPUT') {
            firstUserPrompt = obj.content;
          }
          if (
            obj.source !== 'USER_EXPLICIT' &&
            (/<swarm_worker\b/.test(obj.content) ||
              /(?:^|\n)You are this swarm's (?:narrator|stall monitor)/m.test(obj.content) ||
              /Your assignment\s*\(recorded on the board as #\d+\s+for\s+@[a-zA-Z0-9_-]{1,48}\)/i.test(obj.content) ||
              /\bcontent=\[swarm\]\s+new board message\s+#\d+/i.test(obj.content))
          ) {
            hasWorkerSystemTag = true;
            if (!firstUserPrompt) {
              firstUserPrompt = obj.content;
            }
          }
        }
        if (Array.isArray(obj.tool_calls)) {
          for (const tc of obj.tool_calls) {
            if (tc.name === 'swarm') {
              const act = String(tc.args?.action || '').toLowerCase();
              if (act === 'add' || act === 'title' || act === 'kill') {
                hasSwarmAdminCall = true;
              }
            } else if (tc.name === 'post_message' || tc.name === 'read_board' || tc.name === 'swarm_wait') {
              hasBoardWorkerTools = true;
            }
          }
        }
      } catch {}
    }

    let inferredWorkerKind = '';
    if (/^You are this swarm's narrator/m.test(firstUserPrompt)) {
      inferredWorkerKind = 'narrator';
    } else if (/^You are this swarm's stall monitor/m.test(firstUserPrompt)) {
      inferredWorkerKind = 'monitor';
    } else if (hasWorkerSystemTag && /\b(?:verifier|only job is to check|verify diffs)\b/i.test(firstUserPrompt)) {
      inferredWorkerKind = 'verifier';
    }

    return {
      hasSwarmAdminCall,
      hasBoardWorkerTools,
      hasWorkerSystemTag,
      inferredWorkerKind,
    };
  } catch {
    return empty;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

/**
 * Определяет роль текущего запуска хука относительно нативного Роя (Swarm).
 * @param {object} [payload={}] Входные данные хука.
 * @returns {{
 *   role: 'standalone' | 'coordinator' | 'swarm_worker',
 *   workerKind: '' | 'author' | 'verifier' | 'narrator' | 'monitor',
 *   explicitSwarmRequest: boolean,
 *   hasQuotaSignal: boolean,
 *   isolationKey: string
 * }}
 */
export function detectSwarmExecutionRole(rawPayload = {}) {
  const payload = rawPayload && typeof rawPayload === 'object' ? rawPayload : {};
  const wsPath = payload.workspacePaths?.[0] || payload.workspacePath || payload.workspaceRoot || payload.cwd || '';
  const userInput = String(payload.lastUserInput || payload.prompt || payload.userInput || '');
  const systemText = String(payload.systemPrompt || payload.systemMessage || '');
  const errorText = String(payload.error || '');
  const toolName = String(payload.toolCall?.name || payload.tool || payload.toolName || '');
  const combinedText = `${userInput}\n${systemText}`;

  const isolationKey = resolveSwarmIsolationKey({
    conversationId: payload.conversationId || 'default',
    workspaceRoot: wsPath,
  });

  const explicitSwarmRequest = EXPLICIT_SWARM_RE.test(userInput);
  const hasQuotaSignal = QUOTA_SIGNAL_RE.test(userInput) || QUOTA_SIGNAL_RE.test(errorText);

  const txSignals = peekSwarmSignalsFromTranscript(payload.transcriptPath || '');
  const pinnedRole = readPinnedSwarmRole(isolationKey);

  // Прямые признаки фонового воркера Роя (подтверждённые системным тегом, транскриптом или закреплённой ролью нельзя переопределить вызовом swarm)
  const hasAuthoritativeWorkerSignal =
    pinnedRole?.role === 'swarm_worker' ||
    txSignals.hasWorkerSystemTag ||
    SWARM_WORKER_TAG_RE.test(systemText);
  const isDirectWorkerTag =
    hasAuthoritativeWorkerSignal ||
    SWARM_WORKER_TAG_RE.test(combinedText);
  const isCoordinatorPinned =
    !hasAuthoritativeWorkerSignal &&
    (pinnedRole?.role === 'coordinator' || txSignals.hasSwarmAdminCall || toolName === 'swarm');
  const isWorkerByTools =
    !isCoordinatorPinned &&
    (txSignals.hasBoardWorkerTools || toolName === 'swarm_wait' || toolName === 'post_message' || toolName === 'read_board') &&
    !explicitSwarmRequest;

  if (!isCoordinatorPinned && (isDirectWorkerTag || isWorkerByTools)) {
    let workerKind = txSignals.inferredWorkerKind || pinnedRole?.workerKind || 'author';
    if (/swarm_narrator|You are this swarm's narrator/i.test(combinedText)) {
      workerKind = 'narrator';
    } else if (/swarm_monitor|You are this swarm's stall monitor/i.test(combinedText)) {
      workerKind = 'monitor';
    } else if (workerKind === 'author' && /\b(?:verifier|read-only audit|do not edit files|check #\d+)\b/i.test(userInput)) {
      workerKind = 'verifier';
    }

    if (isDirectWorkerTag && pinnedRole?.role !== 'swarm_worker') {
      pinSwarmRole(isolationKey, 'swarm_worker', workerKind);
    }

    return {
      role: 'swarm_worker',
      workerKind,
      explicitSwarmRequest: false,
      hasQuotaSignal,
      isolationKey,
    };
  }

  if (isCoordinatorPinned || explicitSwarmRequest) {
    if ((txSignals.hasSwarmAdminCall || toolName === 'swarm') && pinnedRole?.role !== 'coordinator') {
      pinSwarmRole(isolationKey, 'coordinator', '');
    }
    return {
      role: 'coordinator',
      workerKind: '',
      explicitSwarmRequest,
      hasQuotaSignal,
      isolationKey,
    };
  }

  return {
    role: 'standalone',
    workerKind: '',
    explicitSwarmRequest: false,
    hasQuotaSignal,
    isolationKey,
  };
}

/**
 * Применяет защитные переопределения настроек для фоновых воркеров Роя:
 * отключает блокирующие опросы ask_question (воркер не общается с человеком напрямую)
 * и разгружает системных помощников narrator/monitor от лишнего анализа кода.
 * @param {object} [state={}]
 * @param {object} [swarmCtx={}]
 * @returns {object}
 */
export function applySwarmWorkerStateOverrides(state = {}, swarmCtx = {}) {
  if (!swarmCtx || swarmCtx.role !== 'swarm_worker') {
    return state;
  }

  const next = {
    ...state,
    confirmBeforeRun: false,
    uiDesignPreviewGate: false,
    showBadge: false,
  };

  if (swarmCtx.workerKind === 'narrator' || swarmCtx.workerKind === 'monitor') {
    next.repoMap = false;
    next.zeroTurnSlices = false;
    next.blastRadius = false;
    next.bayesianRouter = false;
    next.skillCrystallizer = false;
    next.historyCompaction = false;
  }

  return next;
}

/**
 * Формирует адаптивную директиву управления Роем для PreInvocation.
 * На мелких и средних задачах (S/M) возвращает пустую строку (0 лишних токенов).
 * @param {object} params
 * @returns {{ shouldActivateSwarm: boolean, swarmMode: string, directiveEn: string }}
 */
export function evaluateSwarmRoutingDirective(rawOpts = {}) {
  const {
    state: rawState = {},
    modelProfile = null,
    grade = 'M',
    matchedFilesCount = 0,
    subsystemHits = 0,
    isReadOnlyQuestion = false,
    swarmCtx = {},
    cacheDir = '',
  } = (rawOpts && typeof rawOpts === 'object' ? rawOpts : {});
  const state = rawState && typeof rawState === 'object' ? rawState : {};
  const rawMode = String(state.swarmMode || 'auto_xl').toLowerCase();
  const swarmMode = SWARM_MODES.has(rawMode) ? rawMode : 'auto_xl';
  const rawTier = String(state.swarmWorkerTier || 'hydrogen_auto').toLowerCase();
  const baseWorkerTier = SWARM_WORKER_TIERS.has(rawTier) ? rawTier : 'hydrogen_auto';
  const explicitSub = state?.subscriptionTier === 'pro' ? 'pro' : (state?.subscriptionTier === 'ultra' ? 'ultra' : null);
  const workerTier = explicitSub === 'pro' ? sanitizeSwarmWorkerTierForSubscription('pro', baseWorkerTier) : baseWorkerTier;
  const failoverSubTier = explicitSub || 'ultra';
  const autoVerifier = state.swarmAutoVerifier !== false;
  const quotaFailover = state.swarmQuotaFailover !== false;
  const primaryWorkerModelByTier = {
    hydrogen_auto: 'gemini-4-hydrogen-medium',
    neon_auto: 'gemini-4-neon-medium',
    argon_auto: 'gemini-4-argon-medium',
    carbon_auto: 'gemini-4-carbon-high',
    inherit: modelProfile?.rawName || 'gemini-4-hydrogen-medium',
  };
  const gpuEnabled = Boolean(state?.gpuEnabled);

  const directives = [];

  // 1. Контекст фонового воркера внутри запущенного Роя
  if (swarmCtx?.role === 'swarm_worker') {
    if (swarmCtx.workerKind === 'narrator' || swarmCtx.workerKind === 'monitor') {
      return { shouldActivateSwarm: false, swarmMode, directiveEn: '' };
    }
    if (swarmCtx.workerKind === 'verifier') {
      directives.push(
        '🐝 [Swarm Verifier Guard] Inspect diffs & run tests in read-only mode (workspace:"inherit"); NEVER edit files owned by authors or call ask_question. Cite board posts by #seq and @mention only the responsible @author (tag @coordinator only when verified clean or blocked).'
      );
    } else {
      directives.push(
        '🐝 [Swarm Author Guard] Edit ONLY files assigned in your brief via edit_file; never call ask_question. Verify syntax/tests before posting, cite earlier posts by #seq, and @mention @verifier next (or @coordinator if no verifier exists).'
      );
    }
    if (swarmCtx.hasQuotaSignal && quotaFailover) {
      const stalledModel = swarmCtx.failedModel || primaryWorkerModelByTier[workerTier] || 'gemini-4-hydrogen-medium';
      try {
        recordComboProviderCooldown({ modelOrTier: stalledModel, reason: 'quota_429', cacheDir });
      } catch {}
      const comboPick = resolveComboFailoverTarget({ combo: 'swarm_worker', localGpuAvailable: gpuEnabled, cacheDir, subscriptionTier: failoverSubTier });
      const nextTarget = comboPick?.selected || 'gemini-4-neon-medium';
      directives.push(
        `🛟 [Quota Recovery] Low/exhausted quota detected: call swarm{action:"models"} to check separate buckets; switch your own model via swarm{action:"model", model:"${nextTarget}"} (or "claude-sonnet-5-5-thinking" / "claude-sonnet-4-6" / "gpt-oss-120b-medium" if Gemini bucket is 0%) to continue without losing context. Active combo target: "${nextTarget}".`
      );
    }
    return {
      shouldActivateSwarm: true,
      swarmMode,
      directiveEn: directives.join('\n'),
    };
  }

  // 2. Автоматическое спасение Роя при исчерпании квоты (Quota Failover с учётом общих корзин квот)
  if (swarmCtx?.hasQuotaSignal && quotaFailover && (swarmCtx.role === 'coordinator' || swarmMode !== 'off')) {
    const stalledModel = swarmCtx.failedModel || primaryWorkerModelByTier[workerTier] || 'gemini-4-hydrogen-medium';
    try {
      recordComboProviderCooldown({ modelOrTier: stalledModel, reason: 'quota_429', cacheDir });
    } catch {}
    const comboPick = resolveComboFailoverTarget({ combo: 'swarm_worker', localGpuAvailable: gpuEnabled, cacheDir, subscriptionTier: failoverSubTier });
    const nextTarget = comboPick?.selected || 'gemini-4-neon-medium';
    directives.push(
      `🛟 [Swarm Quota Failover Active] Quota alert detected: call swarm{action:"models"} to check live quota_remaining/quota_resets across buckets, then hot-swap any stalled waiting worker via swarm{action:"model", name:"<worker>", model:"${nextTarget}"} (fallback: "claude-sonnet-4-6" or "gpt-oss-120b-medium" if shared Gemini bucket is 0%). NEVER kill+add on quota exhaustion so worker memory is preserved. Combo chain next: "${nextTarget}".`
    );
  }

  if (isReadOnlyQuestion) {
    return {
      shouldActivateSwarm: false,
      swarmMode,
      directiveEn: directives.join('\n'),
    };
  }

  // 3. Определяем, уместен ли Рой на текущей задаче
  const isActiveCoordinator = swarmCtx?.role === 'coordinator';
  const isExplicit = Boolean(swarmCtx?.explicitSwarmRequest);

  let shouldActivateSwarm = false;
  if (swarmMode === 'off') {
    shouldActivateSwarm = isExplicit;
  } else if (swarmMode === 'manual_only') {
    shouldActivateSwarm = isExplicit || isActiveCoordinator;
  } else if (swarmMode === 'auto_all') {
    shouldActivateSwarm = true;
  } else if (swarmMode === 'always_ask') {
    shouldActivateSwarm = isExplicit || isActiveCoordinator || grade === 'L' || grade === 'XL';
  } else if (swarmMode === 'aggressive_l') {
    shouldActivateSwarm =
      isExplicit ||
      isActiveCoordinator ||
      grade === 'XL' ||
      (grade === 'L' && (matchedFilesCount >= 3 || subsystemHits >= 2));
  } else {
    // 'auto_xl' (по умолчанию): только на реально параллельных XL / широких многомодульных задачах (4+ независимых файлов / 3+ подсистем)
    shouldActivateSwarm =
      isExplicit ||
      isActiveCoordinator ||
      (grade === 'XL' && (matchedFilesCount >= 4 || subsystemHits >= 3));
  }

  if (!shouldActivateSwarm) {
    return {
      shouldActivateSwarm: false,
      swarmMode,
      directiveEn: directives.join('\n'),
    };
  }

  // 4. Формируем профессиональный протокол Tiered Swarm с явной санкцией настроек пользователя
  let modelPinRule = 'Keep worker model unset (inherit active selector) unless a specific worker hits quota, using workspace:"share" for concurrent authors.';
  if (workerTier === 'hydrogen_auto') {
    modelPinRule = explicitSub === 'pro'
      ? 'User-configured Swarm Auto-Tiering is ON (router-state.json -> swarmWorkerTier:"hydrogen_auto"): pin parallel coding authors to model:"gemini-4-hydrogen-medium" (or "gemini-4-hydrogen-high" for intricate logic) with workspace:"share" so Pro/Neon quota is preserved!'
      : 'User-configured Swarm Auto-Tiering is ON (router-state.json -> swarmWorkerTier:"hydrogen_auto"): pin parallel coding authors to model:"gemini-4-hydrogen-medium" (or "gemini-4-hydrogen-high" for intricate logic) with workspace:"share" so Carbon/Pro quota is preserved!';
  } else if (workerTier === 'neon_auto') {
    modelPinRule = 'User-configured Swarm Auto-Tiering is ON (router-state.json -> swarmWorkerTier:"neon_auto"): pin parallel coding authors to model:"gemini-4-neon-medium" (or "gemini-4-neon-high" for complex modules) with workspace:"share".';
  } else if (workerTier === 'argon_auto') {
    modelPinRule = 'User-configured Swarm Auto-Tiering is ON (router-state.json -> swarmWorkerTier:"argon_auto"): pin parallel coding authors to model:"gemini-4-argon-medium" with workspace:"share".';
  } else if (workerTier === 'carbon_auto') {
    modelPinRule = 'User-configured Swarm Auto-Tiering is ON (router-state.json -> swarmWorkerTier:"carbon_auto"): pin parallel coding authors to model:"gemini-4-carbon-medium" with workspace:"share".';
  }

  const askConfirmTip = swarmMode === 'always_ask' && !isActiveCoordinator && !isExplicit
    ? ' Confirm Swarm activation via ask_question before spawning workers unless already confirmed.'
    : '';

  const verifierRule = autoVerifier
    ? 'Add 1 @verifier per 2–4 authors (workspace:"inherit", keep default coordinator model) for peer handoffs (@author -> @verifier -> @coordinator).'
    : 'Verify worker diffs/tests before landing shared workspaces.';

  const coordTip = modelProfile?.isOrchestrator
    ? 'Use native Swarm ONLY if >=4 disjoint files genuinely run in parallel; for 1–3 files let native Orchestrator Hydrogen execute directly.'
    : 'Size disjoint file ownership strictly (never 2 authors on 1 file), add monitor if swarm_monitor skill exists, cite board posts by #seq, and include open_board link in your reply.';

  directives.push(
    `🐝 [Adaptive Swarm Protocol (${swarmMode})] ${modelPinRule}${askConfirmTip} ${verifierRule} ${coordTip}`
  );

  return {
    shouldActivateSwarm: true,
    swarmMode,
    directiveEn: directives.join('\n'),
  };
}

/**
 * Извлекает живую статистику нативного Роя из массива JSONL-строк транскрипта сессии.
 * @param {string[]} [lines=[]]
 * @returns {object}
 */
export function parseSwarmStatsFromTranscriptLines(lines = []) {
  const swarm = {
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
  };

  if (!Array.isArray(lines) || lines.length === 0) {
    return swarm;
  }

  const memberMap = new Map();
  const channels = new Set();

  const registerMember = (name, modelRaw = '', workspace = 'inherit', brief = '') => {
    if (!name) return;
    const cleanName = String(name).trim().toLowerCase();
    if (!cleanName) return;
    const lowerModel = String(modelRaw || '').toLowerCase();
    const isHydrogen = lowerModel.includes('hydrogen') || lowerModel.includes('flash');
    const isNeon = lowerModel.includes('neon');
    let role = 'author';
    if (SUPPORT_NAME_RE.test(cleanName)) {
      role = 'support';
    } else if (VERIFIER_NAME_RE.test(cleanName) || /\b(?:verifier|only job is to check|verify diffs)\b/i.test(brief)) {
      role = 'verifier';
    }
    memberMap.set(cleanName, {
      name: cleanName,
      model: modelRaw || 'inherit',
      isHydrogen,
      isNeon,
      workspace: workspace || 'inherit',
      role,
      alive: true,
    });
  };

  for (const line of lines) {
    if (!line || (!line.includes('"swarm"') && !line.includes('"post_message"'))) continue;
    try {
      const obj = JSON.parse(line);
      if (!Array.isArray(obj.tool_calls)) continue;
      for (const tc of obj.tool_calls) {
        if (tc.name === 'post_message') {
          swarm.boardPosts += 1;
          continue;
        }
        if (tc.name !== 'swarm') continue;
        const args = tc.args || {};
        const action = String(args.action || '').toLowerCase();

        if (action === 'title' && args.title) {
          swarm.active = true;
          swarm.title = String(args.title).trim();
        } else if (action === 'add' && args.name) {
          swarm.active = true;
          const baseName = String(args.name).trim().toLowerCase();
          const tasksLen = Array.isArray(args.tasks) ? args.tasks.length : 0;
          const copies = tasksLen > 0 ? tasksLen : Math.max(1, Number(args.n || 1));
          if (copies > 1) {
            for (let i = 1; i <= copies; i++) {
              registerMember(`${baseName}-${i}`, args.model, args.workspace, args.brief);
            }
          } else {
            registerMember(baseName, args.model, args.workspace, args.brief);
          }
        } else if (action === 'kill' && args.name) {
          const target = String(args.name).trim().toLowerCase();
          const escapedTarget = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const killTargetRe = new RegExp(`^${escapedTarget}(?:-\\d+)?$`);
          for (const [mName, info] of memberMap.entries()) {
            if (killTargetRe.test(mName)) {
              info.alive = false;
            }
          }
        } else if (action === 'model') {
          swarm.modelSwitches += 1;
          const target = String(args.name || '').trim().toLowerCase();
          if (target && args.model) {
            const escapedTarget = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const modelTargetRe = new RegExp(`^${escapedTarget}(?:-\\d+)?$`);
            const nextModel = String(args.model);
            const nextLower = nextModel.toLowerCase();
            const nextIsHydrogen = nextLower.includes('hydrogen') || nextLower.includes('flash');
            const nextIsNeon = nextLower.includes('neon');
            for (const [mName, info] of memberMap.entries()) {
              if (mName === target || modelTargetRe.test(mName)) {
                info.model = nextModel;
                info.isHydrogen = nextIsHydrogen;
                info.isNeon = nextIsNeon;
              }
            }
          } else if (!target && args.model) {
            swarm.coordinatorModel = String(args.model);
          }
        } else if (action === 'channel' && String(args.op || '').toLowerCase() === 'create' && args.channel) {
          channels.add(String(args.channel).trim().toLowerCase());
        }
      }
    } catch {}
  }

  for (const info of memberMap.values()) {
    swarm.totalSpawned += 1;
    if (info.alive) {
      swarm.activeWorkers += 1;
      if (info.role === 'support') swarm.supportWorkers += 1;
      else if (info.role === 'verifier') swarm.verifiers += 1;
      else swarm.authors += 1;

      if (info.isHydrogen) swarm.hydrogenWorkers += 1;
      else swarm.proOrInheritWorkers += 1;
      if (info.isNeon) swarm.neonWorkers += 1;
    } else {
      swarm.killedWorkers += 1;
    }
    swarm.members.push(info);
  }

  swarm.channelsCount = channels.size;
  return swarm;
}

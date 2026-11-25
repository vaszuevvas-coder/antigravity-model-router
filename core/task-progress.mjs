/**
 * @file task-progress.mjs
 * @description Live Task Progress Tracker & Multi-Stage Synchronizer.
 * Connects agent lifecycle hooks (PreInvocation, PreToolUse, PostToolUse) and explicit plan steps
 * with the Floating Pill HUD and Sidecar Panel UI.
 */

import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectSubagentTranscriptMeta } from './model-profile.mjs';
import { atomicWriteJsonSync, safeReadJsonSync, updateJsonAtomicSync } from './safe-json.mjs';
import { ensureTunnelCacheDir, resolveTunnelCacheDir } from './cache-dir.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, '..');
const CACHE_DIR = join(PLUGIN_ROOT, '.cache');
export const TASK_PROGRESS_FILE = join(CACHE_DIR, 'task-progress.json');

const STALE_RUNNING_TTL_MS = 4 * 60 * 1000;
const STALE_IN_FLIGHT_TTL_MS = 8 * 60 * 1000;
const STALE_WAITING_USER_TTL_MS = 10 * 60 * 1000;
const STALE_NON_POST_TOOL_MS = 15 * 1000;
const POST_TOOL_HOOK_TOOLS = new Set(['edit_file', 'write_file', 'run_command']);
const AUTO_DISCOVER_RECENCY_MS = 3 * 60 * 1000;
const REGISTRY_TTL_MS = 2 * 60 * 60 * 1000;
export const DEFAULT_COMPLETED_HOLD_MS = 2800;
export const ORCHESTRATOR_HANDOFF_TTL_MS = 3 * 60 * 1000;
export const MAX_RUNNING_PERCENT = 92;
export const MAX_PRE_EDIT_PERCENT = 35;

function ensureCacheDir() {
  return ensureTunnelCacheDir(resolveTunnelCacheDir(PLUGIN_ROOT));
}

function getTaskProgressFile() {
  return join(ensureCacheDir(), 'task-progress.json');
}

function clampInt(val, min, max, fallback) {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

export function createDefaultProgressState() {
  const now = Date.now();
  return {
    version: '3.34.1',
    activeConversationId: 'default',
    projectName: 'antigravity-model-router',
    workspaceRoot: '',
    status: 'idle',
    grade: 'M',
    currentStep: 0,
    totalSteps: 0,
    percent: 0,
    highWaterStep: 0,
    highWaterPercent: 0,
    stepTitle: 'В ожидании задач',
    stepTitleEn: 'Waiting for tasks',
    stageLabel: 'В ожидании задач',
    stageLabelEn: 'Waiting for tasks',
    formattedText: 'В ожидании задач',
    formattedTextEn: 'Waiting for tasks',
    steps: [],
    activeChats: [],
    chats: {},
    chatRegistry: {},
    inFlightTool: false,
    inFlightToolName: '',
    lastPreToolAt: 0,
    lastPostToolAt: 0,
    toolOpsCount: 0,
    editedFilesCount: 0,
    activeProjects: [],
    recentProjects: [],
    hostBootAt: 0,
    startedAt: now,
    updatedAt: now,
  };
}

import {
  sanitizeWorkspaceRoot,
  parseAntigravityWorktreePath,
  sanitizeFileBasename,
  normalizeConversationId,
  UUID_PROJ_NAME_RE,
  extractProjectName,
  buildActiveProjectsSummary,
  buildFormattedProgressText,
  buildFormattedProgressTextEn,
  localizeProgressLabelToEn,
  localizeStepToEn,
  extractTopicLabelFromPrompt,
  assignChatNumber,
  resolveTranscriptPathForChat,
  truncateAtCleanBoundary,
  compactTechnicalStepLabel,
  formatTargetFilesCompact,
  classifyScopeTargets,
  formatCommandStepLabel,
  extractStepsFromPlanText,
  normalizeChecklistSteps,
  resolveTranscriptBirthMs,
  RAM_GPU_TOOL_RE,
  RAM_SAVED_TOKENS_PER_CALL,
  extractSkillSlugFromPath,
  inspectTranscriptTurnState,
  buildDefaultStepsForGrade,
  MAX_TIMELINE_STEPS,
  UNSCOPED_CHAT_PROJECT_RU,
  UNSCOPED_CHAT_PROJECT_EN,
  isBrainOrTempWorkspacePath,
  extractPrimarySymbolFromSnippet,
  extractTargetFilesFromText,
} from './progress/progress-parsers.mjs';

export {
  MAX_TIMELINE_STEPS,
  UNSCOPED_CHAT_PROJECT_RU,
  UNSCOPED_CHAT_PROJECT_EN,
  sanitizeWorkspaceRoot,
  normalizeConversationId,
  extractProjectName,
  buildFormattedProgressText,
  buildFormattedProgressTextEn,
  localizeProgressLabelToEn,
  localizeStepToEn,
  extractTopicLabelFromPrompt,
  compactTechnicalStepLabel,
  extractPrimarySymbolFromSnippet,
  extractTargetFilesFromText,
  formatTargetFilesCompact,
  extractStepsFromPlanText,
  normalizeChecklistSteps,
  inspectTranscriptTurnState,
};

function buildChecklistSignature(steps = []) {
  if (!Array.isArray(steps) || steps.length === 0) return '';
  return steps.map((s) => `${s?.status || 'pending'}:${s?.title || ''}`).join('|');
}

/**
 * Computes honest step index and completion percentage directly from an authoritative `update_steps` checklist.
 */
export function computeChecklistProgress(steps = [], intraStepOps = 0) {
  const list = Array.isArray(steps) ? steps : [];
  const totalSteps = Math.max(1, list.length);
  let doneCount = 0;
  let runningIdx = -1;
  let errorIdx = -1;
  let firstPendingIdx = -1;

  for (let i = 0; i < list.length; i++) {
    const st = list[i]?.status;
    if (st === 'completed') {
      doneCount += 1;
    } else if (st === 'running' && runningIdx === -1) {
      runningIdx = i;
    } else if (st === 'error' && errorIdx === -1) {
      errorIdx = i;
    } else if (st === 'pending' && firstPendingIdx === -1) {
      firstPendingIdx = i;
    }
  }

  let activeIdx;
  if (runningIdx !== -1) {
    activeIdx = runningIdx;
  } else if (errorIdx !== -1) {
    activeIdx = errorIdx;
  } else if (doneCount >= totalSteps) {
    activeIdx = totalSteps - 1;
  } else if (firstPendingIdx !== -1) {
    activeIdx = firstPendingIdx;
  } else {
    activeIdx = Math.min(totalSteps - 1, doneCount);
  }

  const currentStep = activeIdx + 1;
  if (doneCount >= totalSteps) {
    return { currentStep: totalSteps, totalSteps, doneCount, percent: MAX_RUNNING_PERCENT };
  }

  const slicePct = 100 / totalSteps;
  const basePct = (doneCount / totalSteps) * 100;
  const ops = Math.max(0, Number(intraStepOps || 0));
  const hasActiveWork = runningIdx !== -1 || ops > 0;
  const intraFraction = hasActiveWork
    ? Math.min(0.65, 0.12 + Math.min(8, ops) * 0.065)
    : 0;
  const rawPct = Math.round(basePct + slicePct * intraFraction);
  const minPct = doneCount > 0 ? Math.round(basePct) : (hasActiveWork ? 4 : 0);
  const percent = clampInt(rawPct, minPct, MAX_RUNNING_PERCENT, minPct);
  return { currentStep, totalSteps, doneCount, percent };
}

/**
 * Bounds heuristic progress percentage by actual step ratio so early steps never jump straight to 68–92%.
 */
function computeStepBoundPercent({
  currentStep = 1,
  totalSteps = 3,
  candidatePct = 16,
  prevHighPct = 16,
  hasEditedCode = false,
  isError = false,
} = {}) {
  const total = Math.max(1, Number(totalSteps) || 1);
  const cur = Math.max(1, Math.min(total, Number(currentStep) || 1));
  const stepFloor = cur > 1 ? Math.round(((cur - 1) / total) * 100) : 12;
  const stepCap = cur >= total
    ? MAX_RUNNING_PERCENT
    : Math.min(MAX_RUNNING_PERCENT, Math.max(16, Math.round((cur / total) * 100)));

  if (!hasEditedCode && !isError) {
    const preCap = Math.min(MAX_PRE_EDIT_PERCENT, stepCap);
    return clampInt(Math.max(12, Math.min(candidatePct, preCap)), 12, preCap, 16);
  }
  const boundedPrev = Math.min(prevHighPct, stepCap);
  const boundedCand = Math.min(stepCap, Math.max(stepFloor, candidatePct));
  return clampInt(Math.max(boundedPrev, boundedCand), Math.min(stepFloor, stepCap), stepCap, stepFloor);
}

function hasCodeEdits(chat, tInfo = null) {
  return (
    Number(chat?.editedFilesCount || 0) > 0 ||
    (Array.isArray(chat?.editedTargets) && chat.editedTargets.length > 0) ||
    (Array.isArray(tInfo?.editedFiles) && tInfo.editedFiles.length > 0) ||
    Boolean(chat?.isDemo)
  );
}

function buildQuestionStepMeta(questionHint = '') {
  const raw = String(questionHint || '')
    .replace(/^план\s+автопилота\s*:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  const title = raw ? compactTechnicalStepLabel(`Вопрос: ${raw}`, 30).title : 'Вопрос пользователю';
  const titleEn = raw ? compactTechnicalStepLabel(`Question: ${raw}`, 30).titleEn : 'Question for user';
  const fullTitle = raw
    ? `Вопрос пользователю: ${raw}`.slice(0, 140)
    : 'Согласование деталей с пользователем перед выполнением';
  const fullTitleEn = raw
    ? `Question for user: ${raw}`.slice(0, 140)
    : 'Clarifying task details before execution';
  return { title: title || 'Вопрос пользователю', fullTitle, titleEn: titleEn || 'Question for user', fullTitleEn };
}

function insertOrAppendStep(stepsArr = [], insertIdx = 0, newStep = {}) {
  const next = Array.isArray(stepsArr) ? stepsArr.map((s) => ({ ...s })) : [];
  const idx = Math.max(0, Math.min(next.length, Number(insertIdx) || 0));
  if (next.length >= MAX_TIMELINE_STEPS) {
    let dropIdx = -1;
    for (let i = next.length - 1; i >= idx; i--) {
      const s = next[i];
      if (s && s.source !== 'live' && s.source !== 'plan' && s.source !== 'explicit' && s.kind !== 'question') {
        dropIdx = i;
        break;
      }
    }
    if (dropIdx !== -1) {
      next.splice(dropIdx, 1);
    } else {
      const targetIdx = Math.min(MAX_TIMELINE_STEPS - 1, idx);
      const prev = next[targetIdx] || {};
      const keepKind = prev.kind === 'question' ? 'question' : (newStep.kind || prev.kind);
      next[targetIdx] = {
        ...prev,
        ...newStep,
        ...(keepKind ? { kind: keepKind } : {}),
        mergedCount: Number(prev.mergedCount || 1) + 1,
        title: prev.kind === 'question' ? prev.title : (newStep.title || prev.title),
        fullTitle: prev.kind === 'question'
          ? `${prev.fullTitle || prev.title}; ${newStep.fullTitle || newStep.title || ''}`.slice(0, 140)
          : (newStep.fullTitle || prev.fullTitle),
      };
      return {
        steps: next.slice(0, MAX_TIMELINE_STEPS).map((s, i) => ({ ...s, index: i + 1 })),
        stepNum: targetIdx + 1,
      };
    }
  }
  next.splice(idx, 0, {
    index: idx + 1,
    title: String(newStep.title || `Этап ${idx + 1}`).trim(),
    fullTitle: String(newStep.fullTitle || newStep.title || `Этап ${idx + 1}`).trim(),
    source: newStep.source || 'live',
    ...(newStep.kind ? { kind: newStep.kind } : {}),
    ...(newStep.mergedCount ? { mergedCount: newStep.mergedCount } : {}),
    ...(newStep.activeDetail ? { activeDetail: newStep.activeDetail } : {}),
    status: newStep.status || 'running',
  });
  const capped = next.slice(0, MAX_TIMELINE_STEPS).map((s, i) => ({ ...s, index: i + 1 }));
  return { steps: capped, stepNum: Math.min(capped.length, idx + 1) };
}

function ensurePendingTailAfter(stepsArr = [], afterIdx = 0, context = {}) {
  const next = Array.isArray(stepsArr) ? stepsArr.map((s) => ({ ...s })) : [];
  if (next.length >= MAX_TIMELINE_STEPS) {
    return next.slice(0, MAX_TIMELINE_STEPS).map((s, i) => ({ ...s, index: i + 1 }));
  }
  const tail = next.slice(afterIdx + 1);
  const isTestLike = (s) => s && (s.kind === 'test' || /тест|провер|ast/i.test(String(s.title || '')));
  const hasEditTail = tail.some((s) => s && s.kind !== 'question' && (s.kind === 'edit' || s.source === 'plan' || !isTestLike(s)));
  const hasTestTail = tail.some((s) => isTestLike(s));
  if (hasEditTail && hasTestTail) {
    return next.map((s, i) => ({ ...s, index: i + 1 }));
  }
  const defSteps = buildDefaultStepsForGrade(context.grade || 'M', false, {
    matchedFiles: context.matchedFiles || [],
    userPrompt: context.userPrompt || '',
  });
  const candidates = defSteps.slice(1);
  for (const cand of candidates) {
    if (next.length >= MAX_TIMELINE_STEPS) break;
    const candIsTest = isTestLike(cand);
    if (candIsTest && hasTestTail) continue;
    if (!candIsTest && hasEditTail) continue;
    next.push({ ...cand, index: next.length + 1, status: 'pending' });
  }
  return next.slice(0, MAX_TIMELINE_STEPS).map((s, i) => ({ ...s, index: i + 1 }));
}

function syncStepsArray(steps = [], currentStep = 1, status = 'running') {
  if (!Array.isArray(steps) || steps.length === 0) return [];
  return steps.slice(0, MAX_TIMELINE_STEPS).map((s, idx) => {
    const stepNum = idx + 1;
    let st = 'pending';
    if (status === 'completed') {
      st = 'completed';
    } else if (stepNum < currentStep) {
      st = 'completed';
    } else if (stepNum === currentStep) {
      st = status === 'error' ? 'error' : (status === 'waiting_user' ? 'waiting_user' : 'running');
    }
    const title = String(s?.title || s || `Этап ${stepNum}`).trim();
    const fullTitle = String(s?.fullTitle || s?.activeDetail || title).trim();
    return {
      index: stepNum,
      title,
      fullTitle,
      source: s?.source || 'default',
      ...(s?.kind ? { kind: s.kind } : {}),
      ...(s?.mergedCount ? { mergedCount: s.mergedCount } : {}),
      ...(s?.activeDetail ? { activeDetail: s.activeDetail } : {}),
      status: st,
    };
  });
}

const ACTIVE_STATUS_RANK = {
  running: 4,
  waiting_user: 4,
  error: 3,
  completed: 2,
  idle: 1,
};

function sanitizeStepText(text = '') {
  return String(text || '').trim().replace(/\\?"+$/g, '').trim();
}

function mergeChatRecords(a, b) {
  if (!a) return b;
  if (!b) return a;
  const rankA = ACTIVE_STATUS_RANK[a.status] || 0;
  const rankB = ACTIVE_STATUS_RANK[b.status] || 0;
  const primary = rankB > rankA || (rankB === rankA && Number(b.updatedAt || 0) >= Number(a.updatedAt || 0)) ? b : a;
  const secondary = primary === b ? a : b;
  const numA = Number.isInteger(a.chatNumber) && a.chatNumber > 0 ? a.chatNumber : 999;
  const numB = Number.isInteger(b.chatNumber) && b.chatNumber > 0 ? b.chatNumber : 999;
  const minChatNum = Math.min(numA, numB);

  return {
    ...secondary,
    ...primary,
    chatNumber: minChatNum < 999 ? minChatNum : (primary.chatNumber || 1),
    topicLabel: primary.topicLabel || secondary.topicLabel || '',
    roleLabel: primary.roleLabel || secondary.roleLabel || '',
    isSubagent: Boolean(primary.isSubagent || secondary.isSubagent),
    parentConversationId: primary.parentConversationId || secondary.parentConversationId || '',
    agentKind: primary.agentKind || secondary.agentKind || '',
    spawnedSubagentRoles: {
      ...(secondary.spawnedSubagentRoles || {}),
      ...(primary.spawnedSubagentRoles || {}),
    },
    highWaterStep: Math.max(Number(a.highWaterStep || 0), Number(b.highWaterStep || 0)),
    highWaterPercent: Math.max(Number(a.highWaterPercent || 0), Number(b.highWaterPercent || 0)),
    activeSkills: Array.from(new Set([
      ...(Array.isArray(secondary.activeSkills) ? secondary.activeSkills : []),
      ...(Array.isArray(primary.activeSkills) ? primary.activeSkills : []),
    ])).slice(0, 6),
    ramSavedTokens: Math.max(Number(a.ramSavedTokens || 0), Number(b.ramSavedTokens || 0)),
    backgroundTasks: Array.isArray(primary.backgroundTasks) && primary.backgroundTasks.length >= (Array.isArray(secondary.backgroundTasks) ? secondary.backgroundTasks.length : 0)
      ? primary.backgroundTasks
      : (Array.isArray(secondary.backgroundTasks) ? secondary.backgroundTasks : []),
    backgroundTasksTotalCount: Math.max(Number(a.backgroundTasksTotalCount || 0), Number(b.backgroundTasksTotalCount || 0)),
    startedAt: Math.min(Number(a.startedAt || Infinity), Number(b.startedAt || Infinity)) || Date.now(),
    updatedAt: Math.max(Number(a.updatedAt || 0), Number(b.updatedAt || 0)),
  };
}

function dedupeAndNormalizeChatsMap(chatsObj = {}, registryObj = {}, brainDirs = null, now = Date.now()) {
  let mutated = false;
  const nextChats = {};

  for (const [rawKey, rawVal] of Object.entries(chatsObj || {})) {
    if (!rawVal || typeof rawVal !== 'object') {
      mutated = true;
      continue;
    }
    const cid = normalizeConversationId(rawKey || rawVal.conversationId || 'default');
    if (cid !== rawKey || rawVal.conversationId !== cid) mutated = true;

    const cleanWs = sanitizeWorkspaceRoot(rawVal.workspaceRoot || '');
    const wtMeta = parseAntigravityWorktreePath(cleanWs);
    const tPath = resolveTranscriptPathForChat(cid, rawVal.transcriptPath || '', brainDirs);
    const subMeta = tPath
      ? inspectSubagentTranscriptMeta(tPath)
      : { isSubagent: false, parentConversationId: '', agentKind: '', agentHint: '' };
    const isSub = Boolean(rawVal.isSubagent || subMeta.isSubagent || wtMeta?.parentCid);
    let parentCid = normalizeConversationId(subMeta.parentConversationId || wtMeta?.parentCid || rawVal.parentConversationId || '');
    if (parentCid === 'default' || parentCid === cid) parentCid = '';
    const parentProjHint = parentCid && chatsObj?.[parentCid]?.projectName ? String(chatsObj[parentCid].projectName) : '';
    const rawStoredProj = rawVal.projectName ? String(rawVal.projectName).trim().replace(/^["']+|["']+$/g, '') : '';
    const isPoisonedProj =
      !rawStoredProj ||
      rawStoredProj === cid ||
      rawStoredProj === 'default' ||
      UUID_PROJ_NAME_RE.test(rawStoredProj);
    const cleanProj = wtMeta
      ? (parentProjHint || (!isPoisonedProj && rawStoredProj !== wtMeta.worktreeDir ? rawStoredProj : '') || extractProjectName('', 'antigravity-model-router'))
      : ((!isPoisonedProj ? rawStoredProj : '') || extractProjectName(cleanWs));
    if (cleanWs !== (rawVal.workspaceRoot || '') || cleanProj !== (rawVal.projectName || '')) {
      mutated = true;
    }
    const nextAgentKind = subMeta.agentKind || rawVal.agentKind || (wtMeta ? 'swarm_worker' : (isSub ? 'subagent' : ''));
    const rawRole = String(rawVal.roleLabel || '').trim();
    const nextRoleLabel = (subMeta.agentHint && (!rawRole || rawRole === 'author'))
      ? String(subMeta.agentHint).trim()
      : (rawRole || String(subMeta.agentHint || '').trim());
    if (
      Boolean(rawVal.isSubagent) !== isSub ||
      (rawVal.parentConversationId || '') !== parentCid ||
      (rawVal.agentKind || '') !== nextAgentKind ||
      rawRole !== nextRoleLabel
    ) {
      mutated = true;
    }

    const normalizedEntry = {
      ...rawVal,
      conversationId: cid,
      workspaceRoot: cleanWs,
      projectName: cleanProj,
      transcriptPath: tPath || rawVal.transcriptPath || '',
      stepTitle: sanitizeStepText(rawVal.stepTitle || ''),
      formattedText: sanitizeStepText(rawVal.formattedText || ''),
      isSubagent: isSub,
      parentConversationId: parentCid,
      agentKind: nextAgentKind,
      roleLabel: nextRoleLabel,
    };

    if (nextChats[cid]) {
      nextChats[cid] = mergeChatRecords(nextChats[cid], normalizedEntry);
      mutated = true;
    } else {
      nextChats[cid] = normalizedEntry;
    }
  }

  const nextReg = {};
  for (const [rawKey, regVal] of Object.entries(registryObj || {})) {
    if (!regVal || typeof regVal !== 'object') {
      mutated = true;
      continue;
    }
    if (now - Number(regVal.updatedAt || regVal.createdAt || 0) > REGISTRY_TTL_MS) {
      mutated = true;
      continue;
    }
    const cid = normalizeConversationId(rawKey);
    if (cid !== rawKey) mutated = true;
    if (nextChats[cid]?.isSubagent) {
      mutated = true;
      continue;
    }
    const rawRegProj = String(regVal.projectName || '').trim().replace(/^["']+|["']+$/g, '');
    const cleanProj = (UUID_PROJ_NAME_RE.test(rawRegProj) || rawRegProj === cid)
      ? (nextChats[cid]?.projectName || 'antigravity-model-router')
      : (rawRegProj || nextChats[cid]?.projectName || 'antigravity-model-router');
    if (cleanProj !== rawRegProj) mutated = true;
    if (nextReg[cid]) {
      const prevNum = Number.isInteger(nextReg[cid].chatNumber) ? nextReg[cid].chatNumber : 999;
      const curNum = Number.isInteger(regVal.chatNumber) ? regVal.chatNumber : 999;
      nextReg[cid] = {
        ...nextReg[cid],
        chatNumber: Math.min(prevNum, curNum) < 999 ? Math.min(prevNum, curNum) : 1,
        projectName: cleanProj || nextReg[cid].projectName,
        updatedAt: Math.max(Number(nextReg[cid].updatedAt || 0), Number(regVal.updatedAt || 0)),
      };
      mutated = true;
    } else {
      nextReg[cid] = {
        ...regVal,
        projectName: cleanProj,
      };
    }
    if (nextChats[cid] && !nextChats[cid].isSubagent && Number.isInteger(nextReg[cid].chatNumber)) {
      nextChats[cid].chatNumber = nextReg[cid].chatNumber;
    }
  }

  return { chatsMap: nextChats, registry: nextReg, mutated };
}

const VALID_BG_TASK_STATUSES = new Set(['running', 'done', 'error', 'cancelled']);
const MAX_PUBLIC_BG_TASKS = 25;

function normalizeBackgroundTasksList(rawList = [], { forceFinishRunning = false, forceCancelRunning = false } = {}) {
  if (!Array.isArray(rawList) || rawList.length === 0) return [];
  const out = [];
  for (const item of rawList.slice(0, MAX_PUBLIC_BG_TASKS)) {
    if (!item || typeof item !== 'object') continue;
    const taskId = String(item.taskId || item.id || '').trim();
    if (!taskId) continue;
    let status = VALID_BG_TASK_STATUSES.has(item.status) ? item.status : 'done';
    if (forceCancelRunning && status === 'running') status = 'cancelled';
    else if (forceFinishRunning && status === 'running') status = 'done';
    const stripQ = (s) => String(s || '').trim().replace(/^["']+/, '').replace(/["']+$/, '').trim();
    const label = stripQ(sanitizeStepText(item.label || item.description || 'Фоновая задача')).slice(0, 120) || 'Фоновая задача';
    const labelEn = stripQ(sanitizeStepText(item.labelEn || localizeProgressLabelToEn(label))).slice(0, 120) || 'Background task';
    const commandPreview = stripQ(String(item.commandPreview || '').replace(/\s+/g, ' ')).slice(0, 120);
    out.push({
      id: taskId,
      taskId,
      label,
      labelEn,
      commandPreview,
      status,
      isDaemon: Boolean(item.isDaemon),
      startedAt: Math.max(0, Math.round(Number(item.startedAt || 0))),
      updatedAt: Math.max(0, Math.round(Number(item.updatedAt || 0))),
    });
  }
  return out;
}

function filterVisibleBackgroundTasks(rawList = [], { now = Date.now(), completedHoldMs = DEFAULT_COMPLETED_HOLD_MS } = {}) {
  const list = normalizeBackgroundTasksList(rawList);
  if (list.length === 0) return [];
  const holdMs = Math.max(0, Number(completedHoldMs ?? DEFAULT_COMPLETED_HOLD_MS));
  return list.filter((t) => {
    if (t.status === 'running') return true;
    return t.updatedAt > 0 && (now - t.updatedAt) < holdMs;
  });
}

function buildBackgroundTasksSig(list = [], totalCount = 0) {
  const head = Array.isArray(list)
    ? list.map((t) => `${t.taskId}:${t.status}:${t.updatedAt}:${t.label}`).join('|')
    : '';
  return `${Math.max(0, Number(totalCount || 0))}::${head}`;
}

function syncChatBackgroundTasksFromTranscript(chat, tInfo, { forceFinishRunning = false } = {}) {
  if (!chat || !tInfo || !tInfo.exists || !Array.isArray(tInfo.backgroundTasks)) return false;
  const nextList = normalizeBackgroundTasksList(tInfo.backgroundTasks, { forceFinishRunning });
  const nextTotal = Math.max(nextList.length, Math.round(Number(tInfo.backgroundTasksTotalCount || 0)));
  const prevSig = buildBackgroundTasksSig(chat.backgroundTasks, chat.backgroundTasksTotalCount);
  const nextSig = buildBackgroundTasksSig(nextList, nextTotal);
  if (prevSig === nextSig) return false;
  chat.backgroundTasks = nextList;
  chat.backgroundTasksTotalCount = nextTotal;
  return true;
}

function buildPublicSubagentView(sub, idx) {
  const subNum = idx + 1;
  const isSwarm = sub.agentKind === 'swarm_worker';
  const subagentBadge = isSwarm ? `Рой #${subNum}` : `Агент #${subNum}`;
  const subagentBadgeEn = isSwarm ? `Swarm #${subNum}` : `Agent #${subNum}`;
  const roleLabel = String(sub.roleLabel || '').trim();
  const roleLabelEn = localizeProgressLabelToEn(sub.roleLabelEn || roleLabel);
  const stepTitle = sanitizeStepText(sub.stepTitle || '');
  const stepTitleEn = localizeProgressLabelToEn(sub.stepTitleEn || stepTitle);
  const stageLabel = sub.stageLabel || '';
  const stageLabelEn = localizeProgressLabelToEn(sub.stageLabelEn || stageLabel);
  const formattedText = sanitizeStepText(sub.formattedText || buildFormattedProgressText(sub));
  const formattedTextEn = sanitizeStepText(
    sub.formattedTextEn || buildFormattedProgressTextEn({ ...sub, stepTitle, stepTitleEn })
  );
  return {
    conversationId: sub.conversationId || `sub-${subNum}`,
    parentConversationId: sub.parentConversationId || '',
    subagentNumber: subNum,
    subagentBadge,
    subagentBadgeEn,
    roleLabel,
    roleLabelEn,
    displayHeader: roleLabel ? `${subagentBadge} · ${roleLabel}` : subagentBadge,
    displayHeaderEn: roleLabelEn ? `${subagentBadgeEn} · ${roleLabelEn}` : subagentBadgeEn,
    agentKind: sub.agentKind || 'subagent',
    projectName: sub.projectName || 'antigravity-model-router',
    status: sub.status || 'running',
    currentStep: clampInt(sub.currentStep, 0, 20, 0),
    totalSteps: clampInt(sub.totalSteps, 0, 20, 0),
    percent: clampInt(sub.percent, 0, 100, 0),
    stepTitle,
    stepTitleEn,
    stageLabel,
    stageLabelEn,
    formattedText,
    formattedTextEn,
    completedAt: sub.completedAt || 0,
    startedAt: sub.startedAt || 0,
    updatedAt: sub.updatedAt || 0,
  };
}

function buildPublicChatView(chat, subagents = [], { now = Date.now(), completedHoldMs = DEFAULT_COMPLETED_HOLD_MS } = {}) {
  const num = clampInt(chat.chatNumber, 1, 99, 1);
  const chatLabel = `Чат #${num}`;
  const chatLabelEn = `Chat #${num}`;
  const topic = String(chat.topicLabel || '').trim();
  const subs = Array.isArray(subagents) ? subagents : [];
  const runningSubagentsCount = subs.filter((s) => s && (s.status === 'running' || s.status === 'waiting_user')).length;
  const visibleBgTasks = filterVisibleBackgroundTasks(chat.backgroundTasks, { now, completedHoldMs });
  const runningBgCount = visibleBgTasks.filter((t) => t.status === 'running').length;
  const hasLegacyRunningBg = Boolean(chat.hasRunningBackgroundTask) && (!Array.isArray(chat.backgroundTasks) || chat.backgroundTasks.length === 0);
  const effectiveRunningBgCount = runningBgCount > 0
    ? runningBgCount
    : (hasLegacyRunningBg ? Math.max(0, Math.round(Number(chat.backgroundTasksCount || 0))) : 0);
  const stepTitle = sanitizeStepText(chat.stepTitle || '');
  const stepTitleEn = localizeProgressLabelToEn(chat.stepTitleEn || stepTitle);
  const stageLabel = chat.stageLabel || '';
  const stageLabelEn = localizeProgressLabelToEn(chat.stageLabelEn || stageLabel);
  const formattedText = sanitizeStepText(chat.formattedText || buildFormattedProgressText(chat));
  const formattedTextEn = sanitizeStepText(
    chat.formattedTextEn || buildFormattedProgressTextEn({ ...chat, stepTitle, stepTitleEn })
  );
  return {
    conversationId: chat.conversationId || 'default',
    chatNumber: num,
    chatLabel,
    chatLabelEn,
    displayHeader: topic ? `${chatLabel} · ${topic}` : chatLabel,
    displayHeaderEn: topic ? `${chatLabelEn} · ${topic}` : chatLabelEn,
    topicLabel: topic,
    projectName: chat.projectName || (chat.isUnscopedChat ? UNSCOPED_CHAT_PROJECT_RU : 'antigravity-model-router'),
    projectNameEn: chat.projectNameEn || (chat.isUnscopedChat ? UNSCOPED_CHAT_PROJECT_EN : (chat.projectName || 'antigravity-model-router')),
    ...(chat.isUnscopedChat || (!chat.workspaceRoot && chat.projectName === UNSCOPED_CHAT_PROJECT_RU) ? { isUnscopedChat: true } : {}),
    workspaceRoot: chat.workspaceRoot || '',
    status: chat.status || 'running',
    grade: chat.grade || 'M',
    currentStep: clampInt(chat.currentStep, 0, MAX_TIMELINE_STEPS, 0),
    totalSteps: clampInt(chat.totalSteps, 0, MAX_TIMELINE_STEPS, 0),
    percent: clampInt(chat.percent, 0, 100, 0),
    stepTitle,
    stepTitleEn,
    stageLabel,
    stageLabelEn,
    formattedText,
    formattedTextEn,
    steps: Array.isArray(chat.steps) ? chat.steps.map(localizeStepToEn) : [],
    activeSkills: Array.isArray(chat.activeSkills) ? chat.activeSkills.slice(0, 6) : [],
    ramSavedTokens: Math.max(0, Math.round(Number(chat.ramSavedTokens || 0))),
    subagents: subs,
    subagentsCount: subs.length,
    runningSubagentsCount,
    hasRunningBackgroundTask: effectiveRunningBgCount > 0,
    backgroundTasksCount: effectiveRunningBgCount,
    backgroundTasks: visibleBgTasks,
    backgroundTasksTotalCount: visibleBgTasks.length,
    completedAt: chat.completedAt || 0,
    updatedAt: chat.updatedAt || 0,
  };
}

function groupVisibleChatsWithSubagents({
  activeEntries = [],
  chatsMap = {},
  state = {},
  defaultProj = 'antigravity-model-router',
  workspaceRoot = '',
  brainDirs = null,
  now = Date.now(),
  completedHoldMs = DEFAULT_COMPLETED_HOLD_MS,
} = {}) {
  const mainById = new Map();
  const subEntries = [];
  const roleHintsBySubCid = {};

  for (const c of Object.values(chatsMap || {})) {
    if (c && !c.isSubagent && c.spawnedSubagentRoles && typeof c.spawnedSubagentRoles === 'object') {
      Object.assign(roleHintsBySubCid, c.spawnedSubagentRoles);
    }
  }

  for (const item of activeEntries) {
    if (!item) continue;
    if (item.isSubagent) {
      subEntries.push(item);
    } else {
      mainById.set(item.conversationId, item);
    }
  }

  if (subEntries.length === 0) {
    return Array.from(mainById.values()).map((c) => buildPublicChatView(c, [], { now, completedHoldMs }));
  }

  const resolveRootParentCid = (sub) => {
    let cur = normalizeConversationId(sub.parentConversationId || '');
    if (!cur || cur === 'default' || cur === sub.conversationId) return '';
    const visited = new Set([sub.conversationId]);
    let depth = 0;
    while (cur && depth < 16 && !visited.has(cur)) {
      visited.add(cur);
      const node = chatsMap[cur];
      if (node && node.isSubagent && node.parentConversationId) {
        const nextP = normalizeConversationId(node.parentConversationId);
        if (nextP && nextP !== 'default' && nextP !== cur) {
          cur = nextP;
          depth += 1;
          continue;
        }
      }
      break;
    }
    return cur;
  };

  const subsByParent = new Map();
  const attachSub = (parentId, sub) => {
    if (!subsByParent.has(parentId)) subsByParent.set(parentId, []);
    subsByParent.get(parentId).push(sub);
  };

  for (const rawSub of subEntries) {
    const sub = {
      ...rawSub,
      roleLabel: roleHintsBySubCid[rawSub.conversationId] || rawSub.roleLabel || '',
    };
    const rootPid = resolveRootParentCid(sub);

    if (rootPid && mainById.has(rootPid)) {
      attachSub(rootPid, sub);
      continue;
    }

    if (rootPid) {
      const storedParent = chatsMap[rootPid];
      const parentTPath = resolveTranscriptPathForChat(rootPid, storedParent?.transcriptPath || '', brainDirs);
      const parentSubMeta = parentTPath ? inspectSubagentTranscriptMeta(parentTPath) : { isSubagent: false };
      if ((storedParent && !storedParent.isSubagent) || (parentTPath && !parentSubMeta.isSubagent)) {
        const tInfo = parentTPath ? inspectTranscriptTurnState(parentTPath, now) : { exists: false };
        if (tInfo.spawnedSubagentRoles && typeof tInfo.spawnedSubagentRoles === 'object') {
          Object.assign(roleHintsBySubCid, tInfo.spawnedSubagentRoles);
          if (!sub.roleLabel && roleHintsBySubCid[sub.conversationId]) {
            sub.roleLabel = roleHintsBySubCid[sub.conversationId];
          }
        }
        const pWs = sanitizeWorkspaceRoot(storedParent?.workspaceRoot || tInfo.detectedWorkspace || sub.workspaceRoot || workspaceRoot || '');
        const pProj = storedParent?.projectName || extractProjectName(pWs, sub.projectName || defaultProj);
        const { chatNumber, registry } = assignChatNumber(state.chatRegistry, rootPid, pProj, now);
        state.chatRegistry = registry;
        const baseSteps = Array.isArray(storedParent?.steps) && storedParent.steps.length > 0
          ? storedParent.steps
          : buildDefaultStepsForGrade(storedParent?.grade || 'L', false);
        const curStep = Math.max(1, clampInt(storedParent?.currentStep || 2, 1, baseSteps.length, 2));
        const curPct = Math.min(MAX_RUNNING_PERCENT, Math.max(Number(storedParent?.percent || 0), 44));
        const pTitle = storedParent?.status === 'running' && storedParent?.stepTitle
          ? storedParent.stepTitle
          : 'Параллельная работа субагентов';
        const hydratedParent = {
          ...(storedParent || {}),
          conversationId: rootPid,
          chatNumber,
          topicLabel: storedParent?.topicLabel || extractTopicLabelFromPrompt(tInfo.lastUserPrompt || '') || '',
          projectName: pProj,
          workspaceRoot: pWs,
          transcriptPath: parentTPath || storedParent?.transcriptPath || '',
          isSubagent: false,
          status: storedParent?.status === 'waiting_user' ? 'waiting_user' : 'running',
          grade: storedParent?.grade || 'L',
          currentStep: curStep,
          totalSteps: baseSteps.length,
          percent: curPct,
          stepTitle: pTitle,
          stageLabel: `Этап ${curStep} из ${baseSteps.length}`,
          formattedText: buildFormattedProgressText({ status: 'running', currentStep: curStep, totalSteps: baseSteps.length, stepTitle: pTitle }),
          steps: syncStepsArray(baseSteps, curStep, 'running'),
          updatedAt: storedParent?.updatedAt || now,
        };
        if (!chatsMap[rootPid]) {
          chatsMap[rootPid] = { ...hydratedParent, status: 'idle', completedAt: 0 };
        }
        mainById.set(rootPid, hydratedParent);
        attachSub(rootPid, sub);
        continue;
      }
    }

    // Fallback for Swarm workers or synthetic subagents without explicit parent transcript on disk
    let matchedMain = null;
    for (const m of mainById.values()) {
      if (m.projectName === sub.projectName) {
        matchedMain = m;
        if (m.status === 'running' || m.status === 'waiting_user') break;
      }
    }
    if (!matchedMain && mainById.size === 1) {
      matchedMain = mainById.values().next().value;
    }
    if (!matchedMain) {
      const synthPid = rootPid || `main-${sub.projectName || defaultProj}`;
      const { chatNumber, registry } = assignChatNumber(state.chatRegistry, synthPid, sub.projectName || defaultProj, now);
      state.chatRegistry = registry;
      const baseSteps = buildDefaultStepsForGrade('L', false);
      matchedMain = {
        conversationId: synthPid,
        chatNumber,
        topicLabel: '',
        projectName: sub.projectName || defaultProj,
        workspaceRoot: sub.workspaceRoot || workspaceRoot || '',
        isSubagent: false,
        status: 'running',
        grade: 'L',
        currentStep: 2,
        totalSteps: baseSteps.length,
        percent: 48,
        stepTitle: 'Параллельная работа субагентов',
        stageLabel: `Этап 2 из ${baseSteps.length}`,
        formattedText: buildFormattedProgressText({ status: 'running', currentStep: 2, totalSteps: baseSteps.length, stepTitle: 'Параллельная работа субагентов' }),
        steps: syncStepsArray(baseSteps, 2, 'running'),
        updatedAt: now,
      };
      mainById.set(synthPid, matchedMain);
    }
    attachSub(matchedMain.conversationId, sub);
  }

  const out = [];
  for (const mainChat of mainById.values()) {
    const rawSubs = subsByParent.get(mainChat.conversationId) || [];
    rawSubs.sort((a, b) => {
      const diff = Number(a.startedAt || 0) - Number(b.startedAt || 0);
      if (diff !== 0) return diff;
      return String(a.conversationId || '').localeCompare(String(b.conversationId || ''));
    });
    const publicSubs = rawSubs.map((s, idx) => buildPublicSubagentView(s, idx));
    out.push(buildPublicChatView(mainChat, publicSubs, { now, completedHoldMs }));
  }
  return out;
}

function applyTranscriptLiveSignalsToChat(chat, tInfo) {
  if (!chat || !tInfo || !tInfo.exists) return false;
  let changed = false;

  if (Array.isArray(tInfo.activeSkills) && tInfo.activeSkills.length > 0) {
    const curSkills = Array.isArray(chat.activeSkills) ? chat.activeSkills : [];
    const mergedSkills = Array.from(new Set([...curSkills, ...tInfo.activeSkills])).slice(0, 6);
    if (mergedSkills.length !== curSkills.length) {
      chat.activeSkills = mergedSkills;
      changed = true;
    }
  }
  if (Number(tInfo.ramSavedTokens || 0) > Number(chat.ramSavedTokens || 0)) {
    chat.ramSavedTokens = Number(tInfo.ramSavedTokens);
    changed = true;
  }

  if (Array.isArray(tInfo.checklistSteps) && tInfo.checklistSteps.length > 0) {
    const nextSig = buildChecklistSignature(tInfo.checklistSteps);
    if (chat.checklistSignature !== nextSig || !chat.checklistStepsApplied) {
      const nextOps = chat.checklistSignature === nextSig ? Number(chat.checklistStepOps || 0) : 0;
      const calc = computeChecklistProgress(tInfo.checklistSteps, nextOps);
      chat.steps = tInfo.checklistSteps.map((s, i) => ({ ...s, index: i + 1 }));
      chat.totalSteps = calc.totalSteps;
      chat.currentStep = calc.currentStep;
      chat.highWaterStep = calc.currentStep;
      chat.percent = calc.percent;
      chat.highWaterPercent = calc.percent;
      chat.checklistStepsApplied = true;
      chat.checklistSignature = nextSig;
      chat.checklistStepOps = nextOps;
      chat.stageLabel = `Этап ${calc.currentStep} из ${calc.totalSteps}`;
      if (!chat.inFlightTool && chat.steps[calc.currentStep - 1]?.title) {
        chat.stepTitle = chat.steps[calc.currentStep - 1].title;
        chat.formattedText = buildFormattedProgressText(chat);
      }
      return true;
    }
    return changed;
  }

  if (chat.checklistStepsApplied) {
    return changed;
  }

  if (Array.isArray(tInfo.extractedPlanSteps) && tInfo.extractedPlanSteps.length >= 2 && !chat.planStepsApplied) {
    const prevHigh = clampInt(chat.highWaterStep || chat.currentStep || 1, 1, MAX_TIMELINE_STEPS, 1);
    const existingSteps = Array.isArray(chat.steps) ? chat.steps : [];
    const hasQuestionPrefix = existingSteps.slice(0, prevHigh).some((s) => s?.kind === 'question');
    const mergedPlan = hasQuestionPrefix
      ? [...existingSteps.slice(0, prevHigh), ...tInfo.extractedPlanSteps].slice(0, MAX_TIMELINE_STEPS)
      : tInfo.extractedPlanSteps.slice(0, MAX_TIMELINE_STEPS);
    const nextTotal = mergedPlan.length;
    const curStep = hasQuestionPrefix
      ? (chat.status === 'waiting_user' ? Math.min(nextTotal, prevHigh) : Math.min(nextTotal, prevHigh + 1))
      : clampInt(prevHigh, 1, nextTotal, 1);
    chat.steps = syncStepsArray(mergedPlan, curStep, chat.status || 'running');
    chat.totalSteps = nextTotal;
    chat.currentStep = curStep;
    chat.highWaterStep = curStep;
    chat.planStepsApplied = true;
    chat.stageLabel = `Этап ${curStep} из ${nextTotal}`;
    if (!chat.inFlightTool && chat.steps[curStep - 1]?.title) {
      chat.stepTitle = chat.steps[curStep - 1].title;
      chat.formattedText = buildFormattedProgressText(chat);
    }
    return true;
  }

  if (chat.planStepsApplied || !Array.isArray(chat.steps) || chat.steps.length === 0) {
    return false;
  }

  const nextSteps = chat.steps.map((s) => ({ ...s }));
  const isModifiable = (s) => s && s.source !== 'plan' && s.source !== 'explicit' && s.kind !== 'question';

  if (isModifiable(nextSteps[0])) {
    if (Array.isArray(tInfo.inspectedFiles) && tInfo.inspectedFiles.length > 0) {
      const merged = Array.from(new Set([...(Array.isArray(chat.inspectedTargets) ? chat.inspectedTargets : []), ...tInfo.inspectedFiles])).slice(0, 6);
      chat.inspectedTargets = merged;
      const nextTitle = compactTechnicalStepLabel(`RAM-срез ${formatTargetFilesCompact(merged, 18)}`, 30).title;
      const nextFull = `Чтение RAM-срезов: ${merged.join(', ')}`.slice(0, 140);
      if (nextTitle && nextSteps[0].title !== nextTitle) {
        nextSteps[0].title = nextTitle;
        nextSteps[0].fullTitle = nextFull;
        nextSteps[0].source = 'live';
        nextSteps[0].kind = nextSteps[0].kind || 'recon';
        changed = true;
      }
    } else if (Array.isArray(tInfo.searchQueries) && tInfo.searchQueries.length > 0 && nextSteps[0].source !== 'live') {
      const lastQ = truncateAtCleanBoundary(tInfo.searchQueries[tInfo.searchQueries.length - 1], 16);
      const nextTitle = compactTechnicalStepLabel(`RAM-поиск: ${lastQ}`, 30).title;
      const nextFull = `Поиск в RAM/GPU: ${tInfo.searchQueries.join('; ')}`.slice(0, 140);
      if (nextTitle && nextSteps[0].title !== nextTitle) {
        nextSteps[0].title = nextTitle;
        nextSteps[0].fullTitle = nextFull;
        nextSteps[0].source = 'live';
        nextSteps[0].kind = nextSteps[0].kind || 'recon';
        changed = true;
      }
    }
  }

  if (Array.isArray(tInfo.editedFiles) && tInfo.editedFiles.length > 0) {
    const editIdx = nextSteps.findIndex((s, i) => i >= 1 && (s.kind === 'edit' || (isModifiable(s) && s.source !== 'live' && i < nextSteps.length - 1)));
    const targetEditIdx = editIdx !== -1 ? editIdx : 1;
    if (nextSteps[targetEditIdx] && isModifiable(nextSteps[targetEditIdx])) {
      const mergedEdit = Array.from(new Set([...(Array.isArray(chat.editedTargets) ? chat.editedTargets : []), ...tInfo.editedFiles])).slice(0, 8);
      chat.editedTargets = mergedEdit;
      const nextTitle = compactTechnicalStepLabel(`Патч ${formatTargetFilesCompact(mergedEdit, 22)}`, 30).title;
      const nextFull = `Модификация модулей: ${mergedEdit.join(', ')}`.slice(0, 140);
      if (nextTitle && nextSteps[targetEditIdx].title !== nextTitle) {
        nextSteps[targetEditIdx].title = nextTitle;
        nextSteps[targetEditIdx].fullTitle = nextFull;
        nextSteps[targetEditIdx].source = 'live';
        nextSteps[targetEditIdx].kind = 'edit';
        changed = true;
      }
    }
  }

  const lastIdx = nextSteps.length - 1;
  if (lastIdx >= 1 && isModifiable(nextSteps[lastIdx]) && tInfo.ranTestLabel) {
    if (nextSteps[lastIdx].title !== tInfo.ranTestLabel) {
      nextSteps[lastIdx].title = tInfo.ranTestLabel;
      nextSteps[lastIdx].fullTitle = `Верификация: ${tInfo.ranTestLabel}`.slice(0, 140);
      nextSteps[lastIdx].source = 'live';
      nextSteps[lastIdx].kind = 'test';
      changed = true;
    }
  }

  if (changed) {
    chat.steps = nextSteps;
  }
  return changed;
}

function isPendingPlanHandoffActive(chat, now = Date.now()) {
  if (!chat || !chat.pendingPlanHandoff) return false;
  const handedAt = Number(chat.planHandedOffAt || chat.updatedAt || 0);
  return handedAt <= 0 || now - handedAt <= ORCHESTRATOR_HANDOFF_TTL_MS;
}

function isPostHookInFlight(chat) {
  if (!chat?.inFlightTool) return false;
  return Boolean(chat.inFlightToolName && POST_TOOL_HOOK_TOOLS.has(chat.inFlightToolName));
}

function isStaleChatEntry(chat, now = Date.now(), transcriptMtimeMs = 0) {
  if (!chat || (chat.status !== 'running' && chat.status !== 'waiting_user')) return false;
  const lastActivity = Math.max(Number(transcriptMtimeMs || 0), Number(chat.updatedAt || 0));
  if (lastActivity <= 0) return false;
  const idleMs = now - lastActivity;
  if (chat.status === 'waiting_user') {
    return idleMs > STALE_WAITING_USER_TTL_MS;
  }
  const ttlMs = isPostHookInFlight(chat) ? STALE_IN_FLIGHT_TTL_MS : STALE_RUNNING_TTL_MS;
  return idleMs > ttlMs;
}

function expireChatToIdle(chat, stepKey = '') {
  const next = {
    ...chat,
    status: 'idle',
    hasRunningBackgroundTask: false,
    backgroundTasksCount: 0,
    backgroundTasks: normalizeBackgroundTasksList(chat?.backgroundTasks, { forceCancelRunning: true }),
    bgInFlight: false,
    inFlightTool: false,
    inFlightToolName: '',
  };
  if (stepKey) next.lastHandledStepKey = stepKey;
  return next;
}

function sweepAndBuildVisibleChats(
  chatsMap,
  state,
  activeCid,
  now,
  completedHoldMs = DEFAULT_COMPLETED_HOLD_MS,
  brainDirs = null,
  defaultProj = 'antigravity-model-router',
  workspaceRoot = ''
) {
  const holdMs = Math.max(0, Number(completedHoldMs ?? DEFAULT_COMPLETED_HOLD_MS));
  for (const [id, c] of Object.entries(chatsMap || {})) {
    if (!c || typeof c !== 'object' || id === activeCid) continue;
    if (c.status === 'completed') {
      const doneAt = Number(c.completedAt || c.updatedAt || now);
      const effectiveHoldMs = (c.orchestratorSession && holdMs === DEFAULT_COMPLETED_HOLD_MS)
        ? Math.max(holdMs, 8000)
        : holdMs;
      if (now - doneAt >= effectiveHoldMs) {
        chatsMap[id] = {
          ...c,
          status: 'idle',
          percent: 0,
          currentStep: 0,
          stepTitle: 'Ожидание задачи',
          stageLabel: 'Ожидание задачи',
          formattedText: 'Ожидание задачи',
        };
      }
    } else if (c.status === 'error') {
      if (now - Number(c.updatedAt || now) >= 30000) {
        chatsMap[id] = { ...c, status: 'idle', inFlightTool: false, inFlightToolName: '' };
      }
    } else if (isStaleChatEntry(c, now)) {
      chatsMap[id] = expireChatToIdle(c);
    }
  }
  const activeEntries = Object.values(chatsMap).filter(
    (c) => c && ['running', 'waiting_user', 'completed', 'error'].includes(c.status)
  );
  return groupVisibleChatsWithSubagents({
    activeEntries,
    chatsMap,
    state,
    defaultProj,
    workspaceRoot,
    brainDirs,
    now,
    completedHoldMs: holdMs,
  });
}

function hydrateStateWithPrimary(state, activeChats = [], defaultProject = 'antigravity-model-router', workspaceRoot = '') {
  const sorted = [...activeChats].sort((a, b) => {
    const aRun = a.status === 'running' || a.status === 'waiting_user' ? 0 : 1;
    const bRun = b.status === 'running' || b.status === 'waiting_user' ? 0 : 1;
    if (aRun !== bRun) return aRun - bRun;
    if (a.projectName !== b.projectName) {
      return Number(b.updatedAt || 0) - Number(a.updatedAt || 0);
    }
    return (a.chatNumber || 1) - (b.chatNumber || 1);
  });

  // Group chats contiguously by project (ordered stably by earliest startedAt) so multi-project views never interleave or jump
  const projMinStart = new Map();
  for (const c of activeChats) {
    const proj = String(c?.projectName || defaultProject).trim() || defaultProject;
    const ts = Number(c?.startedAt || c?.updatedAt || 0) || Number.MAX_SAFE_INTEGER;
    const prevMin = projMinStart.get(proj);
    if (prevMin === undefined || ts < prevMin) {
      projMinStart.set(proj, ts);
    }
  }
  const orderedChats = [...activeChats].sort((a, b) => {
    const projA = String(a?.projectName || defaultProject).trim() || defaultProject;
    const projB = String(b?.projectName || defaultProject).trim() || defaultProject;
    if (projA !== projB) {
      const startDiff = (projMinStart.get(projA) ?? Number.MAX_SAFE_INTEGER) - (projMinStart.get(projB) ?? Number.MAX_SAFE_INTEGER);
      if (startDiff !== 0) return startDiff;
      return projA.localeCompare(projB);
    }
    const numDiff = (a.chatNumber || 1) - (b.chatNumber || 1);
    if (numDiff !== 0) return numDiff;
    return String(a.conversationId || '').localeCompare(String(b.conversationId || ''));
  });

  if (sorted.length === 0) {
    const idleWs = state.workspaceRoot || workspaceRoot || '';
    const idleProj = state.workspaceRoot && state.projectName
      ? state.projectName
      : (idleWs ? extractProjectName(idleWs) : defaultProject);
    return {
      ...state,
      projectName: idleProj,
      workspaceRoot: idleWs,
      status: 'idle',
      currentStep: 0,
      totalSteps: 0,
      percent: 0,
      highWaterStep: 0,
      highWaterPercent: 0,
      stepTitle: 'В ожидании задач',
      stepTitleEn: 'Waiting for tasks',
      stageLabel: 'В ожидании задач',
      stageLabelEn: 'Waiting for tasks',
      formattedText: 'В ожидании задач',
      formattedTextEn: 'Waiting for tasks',
      steps: [],
      activeChats: [],
      activeProjects: [],
      recentProjects: [],
    };
  }

  const primary = sorted[0];
  const activeProjects = buildActiveProjectsSummary(orderedChats);
  return {
    ...state,
    activeConversationId: primary.conversationId,
    projectName: primary.projectName || defaultProject,
    workspaceRoot: primary.workspaceRoot || workspaceRoot || state.workspaceRoot || '',
    status: primary.status,
    grade: primary.grade || state.grade || 'M',
    currentStep: primary.currentStep,
    totalSteps: primary.totalSteps,
    percent: primary.percent,
    stepTitle: primary.stepTitle,
    stepTitleEn: primary.stepTitleEn || localizeProgressLabelToEn(primary.stepTitle),
    stageLabel: primary.stageLabel,
    stageLabelEn: primary.stageLabelEn || localizeProgressLabelToEn(primary.stageLabel),
    formattedText: primary.formattedText,
    formattedTextEn: primary.formattedTextEn || localizeProgressLabelToEn(primary.formattedText),
    steps: Array.isArray(primary.steps) ? primary.steps.map(localizeStepToEn) : [],
    activeChats: orderedChats,
    activeProjects,
    recentProjects: activeProjects,
  };
}

/**
 * Reads and reconciles the current multi-chat task progress snapshot safely.
 * @returns {object}
 */
export function getTaskProgressSnapshot(opts = {}) {
  const {
    workspaceRoot = '',
    completedHoldMs = DEFAULT_COMPLETED_HOLD_MS,
    brainDirs = null,
    now = Date.now(),
  } = opts && typeof opts === 'object' ? opts : {};
  ensureCacheDir();
  const raw = safeReadJsonSync(getTaskProgressFile(), createDefaultProgressState);
  const state = raw && typeof raw === 'object' ? { ...createDefaultProgressState(), ...raw } : createDefaultProgressState();
  const cleanWs = sanitizeWorkspaceRoot(workspaceRoot || state.workspaceRoot || '');
  const defaultProj = extractProjectName(cleanWs || '');
  const deduped = dedupeAndNormalizeChatsMap(state.chats, state.chatRegistry, brainDirs, now);
  const chatsMap = deduped.chatsMap;
  state.chatRegistry = deduped.registry;
  let dirty = deduped.mutated;

  // Migrate legacy flat state if chats dictionary was empty
  if (Object.keys(chatsMap).length === 0 && (state.status === 'running' || state.status === 'completed') && state.totalSteps > 0) {
    const legacyCid = normalizeConversationId(state.activeConversationId || 'default');
    const { chatNumber, registry } = assignChatNumber(state.chatRegistry, legacyCid, state.projectName || defaultProj, now);
    state.chatRegistry = registry;
    chatsMap[legacyCid] = {
      conversationId: legacyCid,
      chatNumber,
      topicLabel: extractTopicLabelFromPrompt(state.promptPreview || ''),
      projectName: state.projectName || defaultProj,
      workspaceRoot: sanitizeWorkspaceRoot(state.workspaceRoot || cleanWs || ''),
      transcriptPath: state.transcriptPath || '',
      baselineDoneStepKey: state.baselineDoneStepKey || '',
      isSubagent: false,
      parentConversationId: '',
      status: state.status,
      grade: state.grade || 'M',
      currentStep: state.currentStep,
      totalSteps: state.totalSteps,
      percent: state.percent,
      highWaterStep: state.highWaterStep || state.currentStep || 1,
      highWaterPercent: state.highWaterPercent || state.percent || 15,
      stepTitle: sanitizeStepText(state.stepTitle || ''),
      stageLabel: state.stageLabel || '',
      formattedText: sanitizeStepText(state.formattedText || ''),
      steps: Array.isArray(state.steps) ? state.steps : [],
      inFlightTool: Boolean(state.inFlightTool),
      lastPostToolAt: Number(state.lastPostToolAt || 0),
      completedAt: state.status === 'completed' ? (state.completedAt || state.updatedAt || now) : 0,
      startedAt: state.startedAt || now,
      updatedAt: state.updatedAt || now,
    };
  }

  const hostBootAt = Math.max(0, Number(opts?.hostBootAt ?? state.hostBootAt ?? 0));
  const parentTurnCache = new Map();
  const getCachedParentTurn = (rawPid) => {
    const pid = normalizeConversationId(rawPid || '');
    if (!pid || pid === 'default') return null;
    if (parentTurnCache.has(pid)) return parentTurnCache.get(pid);
    const pPath = resolveTranscriptPathForChat(pid, chatsMap[pid]?.transcriptPath || '', brainDirs);
    const pInfo = pPath ? inspectTranscriptTurnState(pPath, now, { hostBootAt }) : { exists: false };
    parentTurnCache.set(pid, pInfo);
    return pInfo;
  };

  const resolveSubagentRootPid = (startParentId, selfCid = '') => {
    let cur = normalizeConversationId(startParentId || '');
    if (!cur || cur === 'default' || cur === selfCid) return '';
    const visited = new Set(selfCid ? [selfCid] : []);
    let depth = 0;
    while (cur && depth < 16 && !visited.has(cur)) {
      visited.add(cur);
      const node = chatsMap[cur];
      if (node && node.isSubagent && node.parentConversationId) {
        const nextP = normalizeConversationId(node.parentConversationId);
        if (nextP && nextP !== 'default' && nextP !== cur) {
          cur = nextP;
          depth += 1;
          continue;
        }
      }
      break;
    }
    return cur;
  };

  const evaluateParentSubagentTermination = ({ subCid, rootPid, agentKind = '', roleLabel = '' }) => {
    if (!rootPid) return null;
    const pInfo = getCachedParentTurn(rootPid);
    if (!pInfo?.exists) return null;
    const resolvedRole = String(roleLabel || pInfo.spawnedSubagentRoles?.[subCid] || '').trim();
    if (pInfo.allSubagentsStoppedByRestart) return { reason: 'restart', roleLabel: resolvedRole };
    if (pInfo.killedAllSubagents) return { reason: 'killed', roleLabel: resolvedRole };
    if (Array.isArray(pInfo.killedSubagentCids) && pInfo.killedSubagentCids.includes(subCid)) {
      return { reason: 'killed', roleLabel: resolvedRole };
    }
    if ((agentKind === 'swarm_worker' || pInfo.spawnedSubagentRoles?.[subCid]) && resolvedRole) {
      const rLower = resolvedRole.toLowerCase();
      if (
        Array.isArray(pInfo.killedSwarmNames) &&
        pInfo.killedSwarmNames.some((kn) => rLower === kn || rLower.startsWith(`${kn}-`))
      ) {
        return { reason: 'killed', roleLabel: resolvedRole };
      }
      if (rLower === 'monitor' && pInfo.coordinatorPostedDone) {
        return { reason: 'done', roleLabel: resolvedRole };
      }
    }
    return { reason: '', roleLabel: resolvedRole };
  };

  // Auto-discover any parallel open chats AND active subagents across Antigravity windows
  const shouldAutoDiscover = Array.isArray(brainDirs)
    ? brainDirs.length > 0
    : !process.env.NODE_TEST_CONTEXT;
  if (shouldAutoDiscover) {
    const scanRoots = Array.isArray(brainDirs) && brainDirs.length > 0
      ? brainDirs
      : ['antigravity', 'antigravity-ide', 'antigravity-cli'].map((d) => join(homedir(), '.gemini', d, 'brain'));
    for (const bRoot of scanRoots) {
      if (!existsSync(bRoot)) continue;
      let entries = [];
      try {
        entries = readdirSync(bRoot, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const d of entries) {
        if (!d.isDirectory()) continue;
        const cid = normalizeConversationId(d.name);
        const existing = chatsMap[cid];
        if (existing && (existing.status === 'running' || existing.status === 'waiting_user' || existing.status === 'completed')) {
          continue;
        }
        const tPath = join(bRoot, d.name, '.system_generated', 'logs', 'transcript.jsonl');
        if (!existsSync(tPath)) continue;
        let st;
        try {
          st = statSync(tPath);
        } catch {
          continue;
        }
        if (!st.size || now - st.mtimeMs > AUTO_DISCOVER_RECENCY_MS) continue;
        if (hostBootAt > 0 && st.mtimeMs < hostBootAt) continue;
        const subMeta = inspectSubagentTranscriptMeta(tPath);

        const tInfo = inspectTranscriptTurnState(tPath, now, { hostBootAt });
        if (!tInfo.exists || (tInfo.state !== 'running' && tInfo.state !== 'waiting_user')) continue;
        if (existing?.lastHandledStepKey && existing.lastHandledStepKey === tInfo.stepKey) continue;

        const wtFromTranscript = parseAntigravityWorktreePath(tInfo.detectedWorkspace || existing?.workspaceRoot || '');
        const parentCid = subMeta.isSubagent
          ? normalizeConversationId(subMeta.parentConversationId || wtFromTranscript?.parentCid || existing?.parentConversationId || '')
          : '';
        const cleanParentCid = parentCid && parentCid !== 'default' && parentCid !== cid ? parentCid : '';
        const rootPid = subMeta.isSubagent ? resolveSubagentRootPid(cleanParentCid, cid) : '';
        const parentEval = subMeta.isSubagent
          ? evaluateParentSubagentTermination({
              subCid: cid,
              rootPid,
              agentKind: subMeta.agentKind || '',
              roleLabel: subMeta.agentHint || existing?.roleLabel || '',
            })
          : null;
        if (parentEval?.reason) continue;

        const parentRecord = (rootPid && chatsMap[rootPid]) || (cleanParentCid ? chatsMap[cleanParentCid] : null);
        const hasTranscriptFileOps =
          (Array.isArray(tInfo.inspectedFiles) && tInfo.inspectedFiles.length > 0) ||
          (Array.isArray(tInfo.editedFiles) && tInfo.editedFiles.length > 0);
        const rawDetectedWs = sanitizeWorkspaceRoot(
          tInfo.detectedWorkspace ||
            existing?.workspaceRoot ||
            parentRecord?.workspaceRoot ||
            (hasTranscriptFileOps ? (cleanWs || state.workspaceRoot || '') : '')
        );
        const inferredWs = rawDetectedWs && !isBrainOrTempWorkspacePath(rawDetectedWs) ? rawDetectedWs : '';
        const isUnscopedChat = !inferredWs && !parentRecord?.workspaceRoot;
        const projName = inferredWs
          ? extractProjectName(inferredWs, parentRecord?.projectName || defaultProj || UNSCOPED_CHAT_PROJECT_RU)
          : (parentRecord?.projectName || UNSCOPED_CHAT_PROJECT_RU);

        let chatNumber = existing?.chatNumber || 1;
        if (!subMeta.isSubagent) {
          const assigned = assignChatNumber(state.chatRegistry, cid, projName, now);
          chatNumber = assigned.chatNumber;
          state.chatRegistry = assigned.registry;
        }

        const hasDiscoveredPlan = Array.isArray(tInfo.extractedPlanSteps) && tInfo.extractedPlanSteps.length >= 2;
        const hasEdits = hasCodeEdits(null, tInfo);
        const isWaiting = tInfo.state === 'waiting_user';
        let freshSteps = hasDiscoveredPlan
          ? tInfo.extractedPlanSteps
          : buildDefaultStepsForGrade(subMeta.isSubagent ? 'S' : 'M', false, {
              matchedFiles: [...(tInfo.inspectedFiles || []), ...(tInfo.editedFiles || [])],
              userPrompt: tInfo.lastUserPrompt || '',
            });
        let curStep = Math.min(freshSteps.length, tInfo.plannerToolSteps >= 2 ? 2 : 1);
        if (isWaiting && !hasDiscoveredPlan) {
          const qHint = Array.isArray(tInfo.askedQuestions) && tInfo.askedQuestions.length > 0
            ? tInfo.askedQuestions[tInfo.askedQuestions.length - 1]
            : '';
          const qMeta = buildQuestionStepMeta(qHint);
          if (tInfo.plannerToolSteps >= 2 && freshSteps.length >= 2) {
            const ins = insertOrAppendStep(freshSteps, 1, {
              title: qMeta.title,
              fullTitle: qMeta.fullTitle,
              source: 'live',
              kind: 'question',
              status: 'waiting_user',
            });
            freshSteps = ins.steps;
            curStep = ins.stepNum;
          } else if (freshSteps[0]) {
            freshSteps[0] = {
              ...freshSteps[0],
              title: qMeta.title,
              fullTitle: qMeta.fullTitle,
              source: 'live',
              kind: 'question',
            };
            curStep = 1;
          }
          if (!hasEdits) {
            freshSteps = ensurePendingTailAfter(freshSteps, curStep - 1, {
              grade: subMeta.isSubagent ? 'S' : 'M',
              matchedFiles: [...(tInfo.inspectedFiles || []), ...(tInfo.editedFiles || [])],
              userPrompt: tInfo.lastUserPrompt || '',
            });
          }
        }
        const curPct = hasEdits
          ? Math.min(86, Math.max(20, 16 + tInfo.plannerToolSteps * 9))
          : Math.min(MAX_PRE_EDIT_PERCENT, Math.max(18, 16 + tInfo.plannerToolSteps * 4));
        const hasDiscoveredBgTask = Boolean(!isWaiting && tInfo.hasRunningBackgroundTask);
        const curTitle = isWaiting
          ? 'Ожидание ответа пользователя'
          : (hasDiscoveredBgTask && tInfo.backgroundTaskLabel
              ? tInfo.backgroundTaskLabel
              : (tInfo.latestToolSubtitle || freshSteps[curStep - 1]?.title || (subMeta.isSubagent ? 'Работа субагента' : 'Выполнение задачи')));
        const chatStatus = isWaiting ? 'waiting_user' : 'running';

        const discoveredChat = {
          conversationId: cid,
          chatNumber,
          topicLabel: subMeta.isSubagent ? '' : (extractTopicLabelFromPrompt(tInfo.lastUserPrompt || '') || existing?.topicLabel || ''),
          roleLabel: subMeta.isSubagent ? (parentEval?.roleLabel || subMeta.agentHint || existing?.roleLabel || '') : '',
          isSubagent: Boolean(subMeta.isSubagent),
          parentConversationId: cleanParentCid,
          agentKind: subMeta.agentKind || '',
          spawnedSubagentRoles: tInfo.spawnedSubagentRoles || existing?.spawnedSubagentRoles || {},
          projectName: projName,
          projectNameEn: isUnscopedChat ? UNSCOPED_CHAT_PROJECT_EN : projName,
          ...(isUnscopedChat ? { isUnscopedChat: true } : {}),
          workspaceRoot: inferredWs,
          transcriptPath: tPath,
          baselineDoneStepKey: '',
          status: chatStatus,
          grade: subMeta.isSubagent ? 'S' : 'M',
          currentStep: curStep,
          totalSteps: freshSteps.length,
          percent: curPct,
          highWaterStep: curStep,
          highWaterPercent: curPct,
          planStepsApplied: hasDiscoveredPlan,
          inspectedTargets: Array.isArray(tInfo.inspectedFiles) ? tInfo.inspectedFiles.slice(0, 6) : [],
          editedTargets: Array.isArray(tInfo.editedFiles) ? tInfo.editedFiles.slice(0, 8) : [],
          stepTitle: curTitle,
          stageLabel: `Этап ${curStep} из ${freshSteps.length}`,
          formattedText: buildFormattedProgressText({ status: chatStatus, currentStep: curStep, totalSteps: freshSteps.length, stepTitle: curTitle }),
          steps: syncStepsArray(freshSteps, curStep, chatStatus),
          hasRunningBackgroundTask: hasDiscoveredBgTask,
          backgroundTasksCount: hasDiscoveredBgTask && Array.isArray(tInfo.runningBackgroundTasks) ? tInfo.runningBackgroundTasks.length : 0,
          backgroundTasks: normalizeBackgroundTasksList(tInfo.backgroundTasks),
          backgroundTasksTotalCount: Math.max(
            Array.isArray(tInfo.backgroundTasks) ? tInfo.backgroundTasks.length : 0,
            Math.round(Number(tInfo.backgroundTasksTotalCount || 0))
          ),
          inFlightTool: hasDiscoveredBgTask,
          inFlightToolName: hasDiscoveredBgTask ? 'run_command' : '',
          bgInFlight: hasDiscoveredBgTask,
          lastPostToolAt: 0,
          completedAt: 0,
          startedAt: Math.round(st.birthtimeMs || now),
          updatedAt: now,
        };
        applyTranscriptLiveSignalsToChat(discoveredChat, tInfo);
        chatsMap[cid] = discoveredChat;
        dirty = true;
      }
    }
  }

  const activeEntries = [];

  for (const [cid, rawChat] of Object.entries(chatsMap)) {
    if (!rawChat || typeof rawChat !== 'object') {
      delete chatsMap[cid];
      dirty = true;
      continue;
    }
    const chat = { ...rawChat, conversationId: cid };
    const total = Math.max(1, clampInt(chat.totalSteps, 1, MAX_TIMELINE_STEPS, 3));

    if (chat.status === 'running' || chat.status === 'waiting_user') {
      const tPath = resolveTranscriptPathForChat(cid, chat.transcriptPath, brainDirs);
      if (tPath && !chat.isSubagent) {
        const subMeta = inspectSubagentTranscriptMeta(tPath);
        if (subMeta.isSubagent) {
          chat.isSubagent = true;
          chat.parentConversationId = normalizeConversationId(subMeta.parentConversationId || chat.parentConversationId || '');
          if (chat.parentConversationId === 'default' || chat.parentConversationId === cid) chat.parentConversationId = '';
          chat.agentKind = subMeta.agentKind || 'subagent';
          chat.roleLabel = chat.roleLabel || subMeta.agentHint || '';
          if (state.chatRegistry?.[cid]) delete state.chatRegistry[cid];
          dirty = true;
        }
      }
      const tInfo = tPath ? inspectTranscriptTurnState(tPath, now, { hostBootAt }) : { exists: false };
      if (tPath && chat.transcriptPath === tPath) {
        parentTurnCache.set(cid, tInfo);
      }

      const freshestActivity = Math.max(Number(tInfo?.mtimeMs || 0), Number(chat.updatedAt || 0));
      if (hostBootAt > 0 && !chat.isDemo && freshestActivity > 0 && freshestActivity < hostBootAt) {
        Object.assign(chat, expireChatToIdle(chat, tInfo?.stepKey || chat.lastHandledStepKey || ''));
        dirty = true;
        chatsMap[cid] = chat;
        continue;
      }

      const rootPid = chat.isSubagent ? resolveSubagentRootPid(chat.parentConversationId, cid) : '';
      const parentEval = chat.isSubagent
        ? evaluateParentSubagentTermination({
            subCid: cid,
            rootPid,
            agentKind: chat.agentKind || '',
            roleLabel: chat.roleLabel || '',
          })
        : null;
      if (chat.isSubagent && parentEval?.roleLabel && (!chat.roleLabel || chat.roleLabel === 'author')) {
        chat.roleLabel = parentEval.roleLabel;
        dirty = true;
      }

      if (chat.isSubagent && parentEval?.reason === 'restart') {
        chat.status = 'idle';
        chat.inFlightTool = false;
        chat.lastHandledStepKey = tInfo.stepKey || 'restart';
        chat.updatedAt = now;
        dirty = true;
      } else if (chat.isSubagent && (parentEval?.reason === 'killed' || parentEval?.reason === 'done')) {
        chat.status = 'completed';
        chat.currentStep = total;
        chat.highWaterStep = total;
        chat.percent = 100;
        chat.highWaterPercent = 100;
        chat.stageLabel = `Этап ${total} из ${total}`;
        chat.stepTitle = 'Завершено ✓';
        chat.steps = syncStepsArray(chat.steps || [], total, 'completed');
        chat.formattedText = `Завершено ✓ · Этап ${total} из ${total}`;
        chat.inFlightTool = false;
        chat.lastHandledStepKey = tInfo.stepKey || parentEval.reason;
        chat.completedAt = rawChat.status === 'completed' && chat.completedAt ? chat.completedAt : now;
        chat.updatedAt = now;
        dirty = true;
      } else if (tInfo.exists) {
        if (chat.transcriptPath !== tPath) {
          chat.transcriptPath = tPath;
          dirty = true;
        }
        if (tInfo.spawnedSubagentRoles && Object.keys(tInfo.spawnedSubagentRoles).length > 0) {
          chat.spawnedSubagentRoles = { ...(chat.spawnedSubagentRoles || {}), ...tInfo.spawnedSubagentRoles };
        }
        if (!chat.isSubagent && !chat.topicLabel && tInfo.lastUserPrompt) {
          chat.topicLabel = extractTopicLabelFromPrompt(tInfo.lastUserPrompt);
        }
        if (syncChatBackgroundTasksFromTranscript(chat, tInfo)) {
          dirty = true;
        }
        if (
          tInfo.state === 'completed' &&
          tInfo.stepKey &&
          tInfo.stepKey !== chat.baselineDoneStepKey &&
          !isPendingPlanHandoffActive(chat, now) &&
          !tInfo.lastToolIsExitPlan
        ) {
          chat.status = 'completed';
          chat.currentStep = total;
          chat.highWaterStep = total;
          chat.percent = 100;
          chat.highWaterPercent = 100;
          chat.stageLabel = `Этап ${total} из ${total}`;
          chat.stepTitle = 'Завершено ✓';
          chat.steps = syncStepsArray(chat.steps || [], total, 'completed');
          chat.formattedText = `Завершено ✓ · Этап ${total} из ${total}`;
          chat.hasRunningBackgroundTask = false;
          chat.backgroundTasksCount = 0;
          if (Array.isArray(chat.backgroundTasks) && chat.backgroundTasks.some((t) => t?.status === 'running')) {
            chat.backgroundTasks = normalizeBackgroundTasksList(chat.backgroundTasks, { forceFinishRunning: true });
          }
          chat.bgInFlight = false;
          chat.inFlightTool = false;
          chat.inFlightToolName = '';
          chat.lastHandledStepKey = tInfo.stepKey;
          chat.completedAt = rawChat.status === 'completed' && chat.completedAt ? chat.completedAt : now;
          chat.updatedAt = now;
          dirty = true;
        } else if (tInfo.state === 'cancelled' && tInfo.stepKey && tInfo.stepKey !== chat.baselineDoneStepKey) {
          Object.assign(chat, expireChatToIdle(chat, tInfo.stepKey));
          chat.updatedAt = now;
          dirty = true;
        } else if (tInfo.state === 'waiting_user' && tInfo.stepKey && tInfo.stepKey !== chat.baselineDoneStepKey) {
          if (isStaleChatEntry({ ...chat, status: 'waiting_user' }, now, tInfo.mtimeMs)) {
            Object.assign(chat, expireChatToIdle(chat, tInfo.stepKey));
            dirty = true;
          } else {
            const hasEdits = hasCodeEdits(chat, tInfo);
            const nextPct = hasEdits
              ? Math.min(MAX_RUNNING_PERCENT, Math.max(chat.highWaterPercent || 25, 30))
              : Math.min(MAX_PRE_EDIT_PERCENT, Math.max(22, Math.min(chat.highWaterPercent || 28, 32)));
            let nextSteps = Array.isArray(chat.steps) ? chat.steps.map((s) => ({ ...s })) : [];
            const curStep = clampInt(chat.currentStep || 1, 1, Math.max(1, nextSteps.length || total), 1);
            const curIdx = curStep - 1;
            if (nextSteps[curIdx]) {
              nextSteps[curIdx].kind = 'question';
              if (nextSteps[curIdx].source !== 'plan' && nextSteps[curIdx].source !== 'explicit' && nextSteps[curIdx].source !== 'live') {
                const qHint = Array.isArray(tInfo.askedQuestions) && tInfo.askedQuestions.length > 0
                  ? tInfo.askedQuestions[tInfo.askedQuestions.length - 1]
                  : '';
                const qMeta = buildQuestionStepMeta(qHint);
                nextSteps[curIdx].title = qMeta.title;
                nextSteps[curIdx].fullTitle = qMeta.fullTitle;
                nextSteps[curIdx].source = 'live';
              }
            }
            if (!hasEdits && curStep >= nextSteps.length && nextSteps.length < MAX_TIMELINE_STEPS) {
              nextSteps = ensurePendingTailAfter(nextSteps, curIdx, {
                grade: chat.grade || 'M',
                userPrompt: tInfo.lastUserPrompt || chat.promptPreview || '',
              });
            }
            const nextTotal = Math.max(curStep, nextSteps.length || total);
            const needKindMark = Boolean(nextSteps[curIdx] && chat.steps?.[curIdx]?.kind !== 'question');
            if (chat.status !== 'waiting_user' || chat.percent !== nextPct || nextTotal !== chat.totalSteps || needKindMark) {
              chat.status = 'waiting_user';
              chat.percent = nextPct;
              chat.highWaterPercent = nextPct;
              chat.currentStep = curStep;
              chat.totalSteps = nextTotal;
              chat.stepTitle = 'Ожидание ответа пользователя';
              chat.stageLabel = `Этап ${curStep} из ${nextTotal}`;
              chat.formattedText = buildFormattedProgressText({ status: 'waiting_user', currentStep: curStep, totalSteps: nextTotal, stepTitle: chat.stepTitle });
              chat.steps = syncStepsArray(nextSteps, curStep, 'waiting_user');
              chat.inFlightTool = false;
              chat.inFlightToolName = '';
              chat.updatedAt = now;
              dirty = true;
            }
          }
        } else if (tInfo.state === 'running') {
          if (chat.status === 'waiting_user') {
            chat.status = 'running';
            dirty = true;
          }
          if (chat.inFlightTool && !isPostHookInFlight(chat)) {
            const toolAge = now - Number(chat.lastPreToolAt || chat.updatedAt || 0);
            if (toolAge > STALE_NON_POST_TOOL_MS) {
              chat.inFlightTool = false;
              chat.inFlightToolName = '';
              chat.bgInFlight = false;
              dirty = true;
            }
          }
          if (applyTranscriptLiveSignalsToChat(chat, tInfo)) {
            chat.updatedAt = now;
            dirty = true;
          }
          const hasBgTask = Boolean(tInfo.hasRunningBackgroundTask);
          const bgCount = hasBgTask && Array.isArray(tInfo.runningBackgroundTasks) ? tInfo.runningBackgroundTasks.length : 0;
          if (hasBgTask) {
            const canSwapBg = !chat.inFlightTool || chat.inFlightToolName === 'run_command' || chat.bgInFlight;
            if (!chat.hasRunningBackgroundTask || chat.backgroundTasksCount !== bgCount) {
              chat.hasRunningBackgroundTask = true;
              chat.backgroundTasksCount = bgCount;
              dirty = true;
            }
            if (canSwapBg) {
              if (!chat.inFlightTool || chat.inFlightToolName !== 'run_command' || !chat.bgInFlight) {
                chat.inFlightTool = true;
                chat.inFlightToolName = 'run_command';
                chat.bgInFlight = true;
                dirty = true;
              }
              if (tInfo.backgroundTaskLabel && chat.stepTitle !== tInfo.backgroundTaskLabel) {
                chat.stepTitle = tInfo.backgroundTaskLabel;
                chat.formattedText = buildFormattedProgressText(chat);
                chat.updatedAt = now;
                dirty = true;
              }
            }
          } else if (chat.hasRunningBackgroundTask || chat.bgInFlight) {
            chat.hasRunningBackgroundTask = false;
            chat.backgroundTasksCount = 0;
            if (chat.bgInFlight) {
              chat.bgInFlight = false;
              chat.inFlightTool = false;
              chat.inFlightToolName = '';
            }
            dirty = true;
          }
          if (tInfo.plannerToolSteps > 0 && !chat.checklistStepsApplied) {
            const hasEdits = hasCodeEdits(chat, tInfo);
            const rawMcpFloor = hasEdits
              ? Math.min(86, 14 + tInfo.plannerToolSteps * 8)
              : Math.min(MAX_PRE_EDIT_PERCENT, 14 + tInfo.plannerToolSteps * 4);
            const mcpFloor = computeStepBoundPercent({
              currentStep: chat.currentStep || 1,
              totalSteps: chat.totalSteps || (Array.isArray(chat.steps) ? chat.steps.length : 3) || 3,
              candidatePct: rawMcpFloor,
              prevHighPct: chat.highWaterPercent || chat.percent || 16,
              hasEditedCode: hasEdits,
            });
            if (mcpFloor > (chat.highWaterPercent || 0)) {
              chat.highWaterPercent = mcpFloor;
              chat.percent = mcpFloor;
              if (tInfo.latestToolSubtitle && !chat.inFlightTool) {
                chat.stepTitle = tInfo.latestToolSubtitle;
                chat.formattedText = buildFormattedProgressText(chat);
              }
              chat.updatedAt = now;
              dirty = true;
            }
          }
          if (isStaleChatEntry(chat, now, tInfo.mtimeMs)) {
            Object.assign(chat, expireChatToIdle(chat, tInfo.stepKey));
            dirty = true;
          }
        }
      } else {
        // Fallback when no transcript.jsonl exists on disk (e.g. demo or isolated synthetic session)
        if (!chat.isDemo && !chat.inFlightTool && chat.lastPostToolAt > 0 && now - chat.lastPostToolAt >= 25000) {
          chat.status = 'completed';
          chat.currentStep = total;
          chat.percent = 100;
          chat.highWaterPercent = 100;
          chat.stageLabel = `Этап ${total} из ${total}`;
          chat.stepTitle = 'Завершено ✓';
          chat.steps = syncStepsArray(chat.steps || [], total, 'completed');
          chat.formattedText = `Завершено ✓ · Этап ${total} из ${total}`;
          chat.completedAt = chat.completedAt || now;
          dirty = true;
        } else if (isStaleChatEntry(chat, now)) {
          Object.assign(chat, expireChatToIdle(chat));
          dirty = true;
        }
      }
    }

    if (chat.status === 'completed') {
      const doneAt = Number(chat.completedAt || chat.updatedAt || now);
      const rawHoldMs = Math.max(0, Number(completedHoldMs ?? DEFAULT_COMPLETED_HOLD_MS));
      const effectiveHoldMs = (chat.orchestratorSession && rawHoldMs === DEFAULT_COMPLETED_HOLD_MS)
        ? Math.max(rawHoldMs, 8000)
        : rawHoldMs;
      if (now - doneAt >= effectiveHoldMs) {
        chat.status = 'idle';
        chat.percent = 0;
        chat.currentStep = 0;
        chat.stepTitle = 'Ожидание задачи';
        chat.stageLabel = 'Ожидание задачи';
        chat.formattedText = 'Ожидание задачи';
        dirty = true;
      }
    }

    chatsMap[cid] = chat;
    if (chat.status === 'running' || chat.status === 'waiting_user' || chat.status === 'completed' || chat.status === 'error') {
      if (chat.status === 'error' && now - Number(chat.updatedAt || now) >= 30000) {
        chat.status = 'idle';
        dirty = true;
      } else {
        activeEntries.push(chat);
      }
    }
  }

  const visibleChats = groupVisibleChatsWithSubagents({
    activeEntries,
    chatsMap,
    state,
    defaultProj,
    workspaceRoot: cleanWs,
    brainDirs,
    now,
    completedHoldMs,
  });

  // Prune old idle chat records beyond 32 entries
  const allEntries = Object.entries(chatsMap);
  if (allEntries.length > 32) {
    allEntries
      .sort((a, b) => Number(b[1]?.updatedAt || 0) - Number(a[1]?.updatedAt || 0))
      .slice(32)
      .forEach(([oldId]) => {
        if (chatsMap[oldId]?.status === 'idle') {
          delete chatsMap[oldId];
          dirty = true;
        }
      });
  }

  state.chats = chatsMap;
  const hydrated = hydrateStateWithPrimary(state, visibleChats, defaultProj, cleanWs);
  const prevProjSig = Array.isArray(state.recentProjects)
    ? state.recentProjects.map((p) => `${p?.projectName || ''}:${p?.status || ''}`).join('|')
    : '';
  const nextProjSig = Array.isArray(hydrated.recentProjects)
    ? hydrated.recentProjects.map((p) => `${p?.projectName || ''}:${p?.status || ''}`).join('|')
    : '';
  if (prevProjSig !== nextProjSig) {
    dirty = true;
  }

  if (dirty) {
    try {
      atomicWriteJsonSync(getTaskProgressFile(), hydrated);
    } catch {}
  }

  return hydrated;
}

/**
 * Records a host/sidecar restart timestamp and expires all pre-restart active chats
 * and running background tasks back to idle (marking running tasks as cancelled).
 * @param {object} [opts]
 * @param {number} [opts.bootAt=Date.now()]
 * @param {string[]|null} [opts.brainDirs=null]
 * @returns {object}
 */
export function markHostRestartAndReapActiveTasks({ bootAt = Date.now(), brainDirs = null } = {}) {
  ensureCacheDir();
  const nextBootAt = Math.max(0, Math.round(Number(bootAt) || Date.now()));
  return updateJsonAtomicSync(getTaskProgressFile(), createDefaultProgressState, (prev) => {
    const state = prev && typeof prev === 'object' ? { ...createDefaultProgressState(), ...prev } : createDefaultProgressState();
    const effectiveBootAt = Math.max(Number(state.hostBootAt || 0), nextBootAt);
    state.hostBootAt = effectiveBootAt;

    const deduped = dedupeAndNormalizeChatsMap(state.chats, state.chatRegistry, brainDirs, effectiveBootAt);
    const chatsMap = deduped.chatsMap;
    state.chatRegistry = deduped.registry;

    for (const [cid, rawChat] of Object.entries(chatsMap)) {
      if (!rawChat || typeof rawChat !== 'object') continue;
      const chatLastTs = Math.max(
        Number(rawChat.updatedAt || 0),
        Number(rawChat.lastPreToolAt || 0),
        Number(rawChat.lastPostToolAt || 0)
      );
      if (chatLastTs < effectiveBootAt) {
        const tPath = resolveTranscriptPathForChat(cid, rawChat.transcriptPath || '', brainDirs);
        const tInfo = tPath ? inspectTranscriptTurnState(tPath, effectiveBootAt, { hostBootAt: effectiveBootAt }) : null;
        chatsMap[cid] = expireChatToIdle(rawChat, tInfo?.stepKey || rawChat.lastHandledStepKey || '');
      }
    }

    const cleanWs = sanitizeWorkspaceRoot(state.workspaceRoot || '');
    const defaultProj = extractProjectName(cleanWs || '');
    state.chats = chatsMap;
    const visible = sweepAndBuildVisibleChats(chatsMap, state, '', effectiveBootAt, DEFAULT_COMPLETED_HOLD_MS, brainDirs, defaultProj, cleanWs);
    return hydrateStateWithPrimary(state, visible, defaultProj, cleanWs);
  });
}

/**
 * Initializes task progress stages at the start of a user turn (PreInvocation).
 */
export function initTaskProgressFromPrompt({
  conversationId = 'default',
  workspaceRoot = '',
  transcriptPath = '',
  userPrompt = '',
  grade = 'M',
  matchedFilesCount = 0,
  matchedFiles = [],
  domain = '',
  isReadOnlyQuestion = false,
  resumeIfWaiting = false,
  isPlanReview = false,
  isOrchestratorMode = false,
  customSteps = null,
  brainDirs = null,
} = {}) {
  ensureCacheDir();
  const now = Date.now();
  const cid = normalizeConversationId(conversationId);
  const cleanWs = sanitizeWorkspaceRoot(workspaceRoot);

  return updateJsonAtomicSync(getTaskProgressFile(), createDefaultProgressState, (prev) => {
    const state = prev && typeof prev === 'object' ? { ...createDefaultProgressState(), ...prev } : createDefaultProgressState();
    const deduped = dedupeAndNormalizeChatsMap(state.chats, state.chatRegistry, brainDirs, now);
    const chatsMap = deduped.chatsMap;
    state.chatRegistry = deduped.registry;

    const existingChat = chatsMap[cid] || null;
    const resolvedTranscript = resolveTranscriptPathForChat(cid, transcriptPath || existingChat?.transcriptPath || '', brainDirs);
    const subMeta = resolvedTranscript
      ? inspectSubagentTranscriptMeta(resolvedTranscript)
      : { isSubagent: false, parentConversationId: '', agentKind: '', agentHint: '' };
    const isSub = Boolean(subMeta.isSubagent || existingChat?.isSubagent);
    let parentCid = normalizeConversationId(subMeta.parentConversationId || existingChat?.parentConversationId || '');
    if (parentCid === 'default' || parentCid === cid) parentCid = '';

    const tailSnapshot = resolvedTranscript
      ? inspectTranscriptTurnState(resolvedTranscript, now, { hostBootAt: Number(state.hostBootAt || 0) })
      : { exists: false };
    const effectiveInitWsRaw = sanitizeWorkspaceRoot(
      cleanWs || existingChat?.workspaceRoot || tailSnapshot?.detectedWorkspace || ''
    );
    const effectiveInitWs = effectiveInitWsRaw && !isBrainOrTempWorkspacePath(effectiveInitWsRaw) ? effectiveInitWsRaw : '';
    const isUnscopedInit = !effectiveInitWs && !isSub;
    const projName = effectiveInitWs
      ? extractProjectName(effectiveInitWs)
      : (isSub ? extractProjectName(state.workspaceRoot || '') : UNSCOPED_CHAT_PROJECT_RU);
    let chatNumber = existingChat?.chatNumber || 1;
    let registry = state.chatRegistry;
    if (!isSub) {
      const assigned = assignChatNumber(state.chatRegistry, cid, projName, now);
      chatNumber = assigned.chatNumber;
      registry = assigned.registry;
    }

    const baselineDoneStepKey =
      tailSnapshot.exists && (tailSnapshot.state === 'completed' || tailSnapshot.state === 'waiting_user' || tailSnapshot.state === 'cancelled')
        ? tailSnapshot.stepKey
        : '';

    // Seamless continuation right after ask_question approval or Orchestrator [plan review] handoff
    const resumeTtlMs = existingChat?.status === 'waiting_user' ? STALE_WAITING_USER_TTL_MS : STALE_RUNNING_TTL_MS;
    const isFreshExisting = now - Number(existingChat?.updatedAt || 0) <= resumeTtlMs;
    const shouldResumeWaiting =
      !isSub &&
      existingChat &&
      (existingChat.totalSteps > 0 || (Array.isArray(existingChat.steps) && existingChat.steps.length > 0)) &&
      ((resumeIfWaiting && (existingChat.status === 'waiting_user' || existingChat.status === 'running')) ||
        (!isReadOnlyQuestion && existingChat.status === 'waiting_user' && isFreshExisting) ||
        (isFreshExisting && (isPlanReview || (resumeIfWaiting && (existingChat.orchestratorSession || existingChat.pendingPlanHandoff)))));

    if (shouldResumeWaiting) {
      let nextSteps = Array.isArray(existingChat.steps) ? existingChat.steps.map((s) => ({ ...s })) : [];
      const prevStepIdx = Math.max(0, Math.min(Math.max(0, nextSteps.length - 1), (existingChat.highWaterStep || existingChat.currentStep || 1) - 1));
      const hasEdits = hasCodeEdits(existingChat);
      let resumedStep;
      let resumedPct;
      let resumedTitle;

      if (isPlanReview) {
        nextSteps = nextSteps.map((s, idx) => ({ ...s, index: idx + 1, status: 'completed' }));
        const lastStep = nextSteps[nextSteps.length - 1];
        if (!lastStep || !(lastStep.kind === 'verify' && lastStep.title === 'Ревью этапа архитектором')) {
          const ins = insertOrAppendStep(nextSteps, nextSteps.length, {
            title: 'Ревью этапа архитектором',
            fullTitle: 'Сверка правок исполнителя с планом и тестами',
            source: 'live',
            kind: 'verify',
            status: 'running',
          });
          nextSteps = ins.steps;
        }
        resumedStep = nextSteps.length;
        const rawPriorPct = Number(existingChat.preStopPercent || existingChat.highWaterPercent || existingChat.percent || 84);
        const basePriorPct = rawPriorPct >= 100 ? 90 : rawPriorPct;
        resumedPct = hasEdits
          ? clampInt(Math.max(basePriorPct, 82), 50, MAX_RUNNING_PERCENT, 86)
          : clampInt(Math.max(basePriorPct, 28), 16, MAX_PRE_EDIT_PERCENT, 30);
        resumedTitle = 'Ревью этапа архитектором';
      } else {
        if (existingChat.status === 'waiting_user' && nextSteps[prevStepIdx]) {
          nextSteps[prevStepIdx].kind = 'question';
          if (nextSteps[prevStepIdx].source !== 'plan' && nextSteps[prevStepIdx].source !== 'explicit') {
            nextSteps[prevStepIdx].source = 'live';
          }
        }
        if (!existingChat.planStepsApplied) {
          const scopeTargets = classifyScopeTargets(matchedFiles, userPrompt);
          if (scopeTargets.allFiles.length > 0) {
            const scopeSteps = buildDefaultStepsForGrade(existingChat.grade || grade || 'M', isReadOnlyQuestion, {
              matchedFiles,
              userPrompt,
              domain,
            });
            // Only enrich future placeholder slots after prevStepIdx; preserve question & recon prefix intact
            for (let sIdx = prevStepIdx + 1, k = 1; sIdx < nextSteps.length && k < scopeSteps.length; sIdx++) {
              const old = nextSteps[sIdx];
              if (!old || (old.source !== 'live' && old.source !== 'plan' && old.source !== 'explicit' && old.kind !== 'question')) {
                nextSteps[sIdx] = { ...scopeSteps[k], index: sIdx + 1, status: 'pending' };
                k += 1;
              }
            }
          }
        }
        if (!isReadOnlyQuestion) {
          nextSteps = ensurePendingTailAfter(nextSteps, prevStepIdx, {
            grade: existingChat.grade || grade || 'M',
            matchedFiles,
            userPrompt,
          });
        }
        resumedStep = Math.min(Math.max(1, nextSteps.length || existingChat.totalSteps), prevStepIdx + 2);
        resumedPct = hasEdits
          ? Math.min(MAX_RUNNING_PERCENT, Math.max(existingChat.highWaterPercent || 45, 45))
          : Math.min(38, Math.max(existingChat.percent || 28, 32));
        resumedTitle = nextSteps?.[resumedStep - 1]?.title || 'Выполнение согласованного плана';
      }

      const updatedChat = {
        ...existingChat,
        conversationId: cid,
        chatNumber,
        isSubagent: false,
        parentConversationId: '',
        projectName: projName,
        workspaceRoot: sanitizeWorkspaceRoot(cleanWs || existingChat.workspaceRoot || ''),
        transcriptPath: resolvedTranscript || existingChat.transcriptPath || '',
        baselineDoneStepKey,
        status: 'running',
        currentStep: resumedStep,
        totalSteps: nextSteps.length || existingChat.totalSteps,
        highWaterStep: resumedStep,
        percent: resumedPct,
        highWaterPercent: resumedPct,
        planStepsApplied: Boolean(existingChat.planStepsApplied),
        orchestratorSession: Boolean(existingChat.orchestratorSession || isOrchestratorMode || isPlanReview),
        pendingPlanHandoff: false,
        stepTitle: resumedTitle,
        stageLabel: `Этап ${resumedStep} из ${nextSteps.length || existingChat.totalSteps}`,
        formattedText: buildFormattedProgressText({ status: 'running', currentStep: resumedStep, totalSteps: nextSteps.length || existingChat.totalSteps, stepTitle: resumedTitle }),
        steps: syncStepsArray(nextSteps, resumedStep, 'running'),
        inFlightTool: false,
        inFlightToolName: '',
        completedAt: 0,
        updatedAt: now,
      };
      chatsMap[cid] = updatedChat;
      state.chatRegistry = registry;
      state.chats = chatsMap;
      const visible = sweepAndBuildVisibleChats(chatsMap, state, cid, now, DEFAULT_COMPLETED_HOLD_MS, brainDirs, projName, cleanWs);
      return hydrateStateWithPrimary(state, visible, projName, cleanWs);
    }

    let steps = [];
    let planStepsApplied = false;
    if (Array.isArray(customSteps) && customSteps.length > 0) {
      planStepsApplied = true;
      steps = customSteps
        .map((t, i) => {
          const rawTitle = String(t?.title || t || `Этап ${i + 1}`).trim();
          const compacted = compactTechnicalStepLabel(rawTitle, 30);
          return {
            index: i + 1,
            title: compacted.title || rawTitle,
            fullTitle: String(t?.fullTitle || compacted.fullTitle || rawTitle).trim(),
            source: 'explicit',
            ...(t?.kind ? { kind: t.kind } : {}),
            status: i === 0 ? 'running' : 'pending',
          };
        })
        .slice(0, MAX_TIMELINE_STEPS);
    } else {
      const effectiveGrade = matchedFilesCount >= 4 && (grade === 'S' || grade === 'M') ? 'L' : grade;
      steps = buildDefaultStepsForGrade(effectiveGrade, isReadOnlyQuestion, { matchedFiles, userPrompt, domain });
    }

    const totalSteps = steps.length;
    const currentStep = 1;
    const stepTitle = steps[0]?.title || 'Анализ задачи';
    const initialPercent = isReadOnlyQuestion ? 24 : totalSteps >= 4 ? 14 : 18;
    const topicLabel = isSub ? '' : (extractTopicLabelFromPrompt(userPrompt) || existingChat?.topicLabel || '');

    const chatEntry = {
      conversationId: cid,
      chatNumber,
      topicLabel,
      roleLabel: isSub ? (existingChat?.roleLabel || subMeta.agentHint || '') : '',
      isSubagent: isSub,
      parentConversationId: isSub ? parentCid : '',
      agentKind: isSub ? (subMeta.agentKind || existingChat?.agentKind || 'subagent') : '',
      spawnedSubagentRoles: existingChat?.spawnedSubagentRoles || {},
      projectName: projName,
      projectNameEn: isUnscopedInit ? UNSCOPED_CHAT_PROJECT_EN : projName,
      ...(isUnscopedInit ? { isUnscopedChat: true } : {}),
      workspaceRoot: effectiveInitWs,
      transcriptPath: resolvedTranscript,
      baselineDoneStepKey,
      status: 'running',
      grade: String(grade || 'M').toUpperCase(),
      currentStep,
      totalSteps,
      percent: initialPercent,
      highWaterStep: currentStep,
      highWaterPercent: initialPercent,
      planStepsApplied,
      orchestratorSession: Boolean(isOrchestratorMode),
      pendingPlanHandoff: false,
      planHandedOffAt: 0,
      preStopPercent: 0,
      preStopStep: 0,
      inspectedTargets: [],
      editedTargets: [],
      editedSymbols: [],
      activeSkills: [],
      ramSavedTokens: 0,
      backgroundTasks: tailSnapshot.exists ? normalizeBackgroundTasksList(tailSnapshot.backgroundTasks) : (Array.isArray(existingChat?.backgroundTasks) ? normalizeBackgroundTasksList(existingChat.backgroundTasks) : []),
      backgroundTasksTotalCount: tailSnapshot.exists
        ? Math.max(Array.isArray(tailSnapshot.backgroundTasks) ? tailSnapshot.backgroundTasks.length : 0, Math.round(Number(tailSnapshot.backgroundTasksTotalCount || 0)))
        : Math.max(0, Math.round(Number(existingChat?.backgroundTasksTotalCount || 0))),
      stepTitle,
      stageLabel: `Этап ${currentStep} из ${totalSteps}`,
      formattedText: buildFormattedProgressText({ status: 'running', currentStep, totalSteps, stepTitle }),
      steps: syncStepsArray(steps, currentStep, 'running'),
      inFlightTool: false,
      inFlightToolName: '',
      lastPreToolAt: now,
      lastPostToolAt: 0,
      toolOpsCount: 0,
      editedFilesCount: 0,
      completedAt: 0,
      promptPreview: String(userPrompt || '').trim().slice(0, 120),
      startedAt: existingChat?.startedAt || resolveTranscriptBirthMs(resolvedTranscript, now),
      updatedAt: now,
    };

    chatsMap[cid] = chatEntry;
    state.chatRegistry = registry;
    state.chats = chatsMap;
    const visible = sweepAndBuildVisibleChats(chatsMap, state, cid, now, DEFAULT_COMPLETED_HOLD_MS, brainDirs, projName, cleanWs);
    return hydrateStateWithPrimary(state, visible, projName, cleanWs);
  });
}

/**
 * Advances task progress monotonically when a tool is invoked (PreToolUse).
 * Never regresses currentStep or percent even if the AI revisits file reading mid-edit.
 */
export function advanceTaskProgressOnPreTool({
  conversationId = 'default',
  workspaceRoot = '',
  transcriptPath = '',
  toolName = '',
  filePath = '',
  commandLine = '',
  toolSummary = '',
  planText = '',
  checklistSteps = null,
  questionHint = '',
  symbolHint = '',
  role = '',
  swarmRole = '',
  swarmWorkerKind = '',
  parentConversationId = '',
  isSubagent = false,
  brainDirs = null,
} = {}) {
  ensureCacheDir();
  const now = Date.now();
  const cid = normalizeConversationId(conversationId);
  const cleanWs = sanitizeWorkspaceRoot(workspaceRoot);
  const shortFile = sanitizeFileBasename(filePath);
  const cleanSummary = String(toolSummary || '').trim();
  const cleanSym = String(symbolHint || '').trim();

  return updateJsonAtomicSync(getTaskProgressFile(), createDefaultProgressState, (prev) => {
    const state = prev && typeof prev === 'object' ? { ...createDefaultProgressState(), ...prev } : createDefaultProgressState();
    const deduped = dedupeAndNormalizeChatsMap(state.chats, state.chatRegistry, brainDirs, now);
    const chatsMap = deduped.chatsMap;
    state.chatRegistry = deduped.registry;

    const resolvedTranscript = resolveTranscriptPathForChat(cid, transcriptPath || chatsMap[cid]?.transcriptPath || '', brainDirs);
    const subMeta = resolvedTranscript
      ? inspectSubagentTranscriptMeta(resolvedTranscript)
      : { isSubagent: false, parentConversationId: '', agentKind: '', agentHint: '' };
    const wtPre = parseAntigravityWorktreePath(cleanWs || chatsMap[cid]?.workspaceRoot || '');
    const isSwarmWorker = swarmRole === 'swarm_worker' || subMeta.agentKind === 'swarm_worker' || Boolean(wtPre?.parentCid);
    const effectiveIsSub = Boolean(isSubagent || isSwarmWorker || subMeta.isSubagent || chatsMap[cid]?.isSubagent);
    let effectiveParentCid = normalizeConversationId(
      parentConversationId || subMeta.parentConversationId || wtPre?.parentCid || chatsMap[cid]?.parentConversationId || ''
    );
    if (effectiveParentCid === 'default' || effectiveParentCid === cid) effectiveParentCid = '';

    const parentProjHint = effectiveParentCid ? chatsMap[effectiveParentCid]?.projectName || '' : '';
    const projName = extractProjectName(
      cleanWs || chatsMap[cid]?.workspaceRoot || state.workspaceRoot || '',
      parentProjHint || chatsMap[cid]?.projectName || state.projectName || ''
    );
    const preferredSubRole = effectiveIsSub
      ? (subMeta.agentHint || (chatsMap[cid]?.roleLabel && chatsMap[cid]?.roleLabel !== 'author' ? chatsMap[cid].roleLabel : '') || (swarmWorkerKind && swarmWorkerKind !== 'author' ? swarmWorkerKind : '') || chatsMap[cid]?.roleLabel || '')
      : '';
    let chatNumber = chatsMap[cid]?.chatNumber || 1;
    let registry = state.chatRegistry;
    if (!effectiveIsSub) {
      const assigned = assignChatNumber(state.chatRegistry, cid, projName, now);
      chatNumber = assigned.chatNumber;
      registry = assigned.registry;
    }

    let chat = chatsMap[cid] ? { ...chatsMap[cid] } : null;
    const canReviveOrchestratorChat = Boolean(
      chat &&
      Array.isArray(chat.steps) &&
      chat.steps.length > 0 &&
      (isPendingPlanHandoffActive(chat, now) ||
        (chat.orchestratorSession && now - Number(chat.updatedAt || 0) <= ORCHESTRATOR_HANDOFF_TTL_MS))
    );
    if (chat && canReviveOrchestratorChat && (chat.status === 'idle' || chat.status === 'completed')) {
      const preStopPct = Number(chat.preStopPercent || 0);
      const prevHwPct = Number(chat.highWaterPercent || 0);
      const fallbackPct = prevHwPct > 0 && prevHwPct < 100 ? prevHwPct : (hasCodeEdits(chat) ? 86 : 32);
      const restoredPct = clampInt(preStopPct > 0 ? preStopPct : fallbackPct, 16, MAX_RUNNING_PERCENT, 32);
      const restoredStep = clampInt(chat.preStopStep || chat.highWaterStep || chat.currentStep || 1, 1, chat.steps.length, 1);
      chat = {
        ...chat,
        status: 'running',
        percent: restoredPct,
        highWaterPercent: restoredPct,
        currentStep: restoredStep,
        highWaterStep: restoredStep,
        completedAt: 0,
      };
    } else if (!chat || chat.totalSteps <= 0 || chat.status === 'idle' || chat.status === 'completed') {
      const tailSnapshot = resolvedTranscript
      ? inspectTranscriptTurnState(resolvedTranscript, now, { hostBootAt: Number(state.hostBootAt || 0) })
      : { exists: false };
      const baselineDoneStepKey =
        tailSnapshot.exists && (tailSnapshot.state === 'completed' || tailSnapshot.state === 'waiting_user' || tailSnapshot.state === 'cancelled')
          ? tailSnapshot.stepKey
          : '';
      const freshSteps = buildDefaultStepsForGrade(effectiveIsSub ? 'S' : (chat?.grade || state.grade || 'M'), false, {
        matchedFiles: shortFile ? [shortFile] : [],
      });
      chat = {
        conversationId: cid,
        chatNumber,
        topicLabel: effectiveIsSub ? '' : (chat?.topicLabel || ''),
        roleLabel: preferredSubRole,
        isSubagent: effectiveIsSub,
        parentConversationId: effectiveIsSub ? effectiveParentCid : '',
        agentKind: isSwarmWorker ? 'swarm_worker' : (effectiveIsSub ? 'subagent' : ''),
        spawnedSubagentRoles: chat?.spawnedSubagentRoles || {},
        projectName: projName,
        workspaceRoot: sanitizeWorkspaceRoot(cleanWs || chat?.workspaceRoot || state.workspaceRoot || ''),
        transcriptPath: resolvedTranscript,
        baselineDoneStepKey,
        status: 'running',
        grade: effectiveIsSub ? 'S' : (chat?.grade || state.grade || 'M'),
        currentStep: 1,
        totalSteps: freshSteps.length,
        percent: 16,
        highWaterStep: 1,
        highWaterPercent: 16,
        planStepsApplied: false,
        inspectedTargets: [],
        editedTargets: [],
        editedSymbols: [],
        activeSkills: [],
        ramSavedTokens: 0,
        stepTitle: effectiveIsSub ? 'Запуск субагента' : 'Анализ задачи',
        steps: freshSteps,
        editedFilesCount: 0,
        toolOpsCount: 0,
        completedAt: 0,
        startedAt: chat?.startedAt || resolveTranscriptBirthMs(resolvedTranscript, now),
      };
    }

    let effectiveSteps = Array.isArray(chat.steps) ? chat.steps.map((s) => ({ ...s })) : [];
    const frozenChecklistSteps = chat.checklistStepsApplied ? effectiveSteps.map((s) => ({ ...s })) : null;
    let planStepsApplied = Boolean(chat.planStepsApplied);
    let checklistStepsApplied = Boolean(chat.checklistStepsApplied);
    let checklistSignature = String(chat.checklistSignature || '');
    let checklistStepOps = Math.max(0, Number(chat.checklistStepOps || 0));
    let checklistOverride = false;
    const inspectedTargets = Array.isArray(chat.inspectedTargets) ? [...chat.inspectedTargets] : [];
    const editedTargets = Array.isArray(chat.editedTargets) ? [...chat.editedTargets] : [];
    const editedSymbols = Array.isArray(chat.editedSymbols) ? [...chat.editedSymbols] : [];
    const activeSkills = Array.isArray(chat.activeSkills) ? [...chat.activeSkills] : [];
    let ramSavedTokens = Math.max(0, Number(chat.ramSavedTokens || 0));

    let totalSteps = Math.max(1, clampInt(effectiveSteps.length || chat.totalSteps, 1, MAX_TIMELINE_STEPS, 3));
    const prevHighStep = clampInt(chat.highWaterStep || chat.currentStep || 1, 1, totalSteps, 1);
    const prevHighPct = clampInt(chat.highWaterPercent || chat.percent || 16, 10, MAX_RUNNING_PERCENT, 16);

    let hasEditedCode = hasCodeEdits(chat);
    let candidateStep = prevHighStep;
    let candidatePct = prevHighPct;
    let stepTitle = chat.stepTitle || 'Выполнение операции';
    const ops = Number(chat.toolOpsCount || 0) + 1;
    let cmdMeta = null;
    let pendingNewEditTarget = false;
    const isReadTool = toolName === 'read_file' || String(toolName).includes('ram_slice') || String(toolName).includes('ram_search') || String(toolName).includes('gpu_');
    const preSkillSlug = extractSkillSlugFromPath(filePath);
    if (preSkillSlug && isReadTool && !activeSkills.includes(preSkillSlug) && activeSkills.length < 6) {
      activeSkills.push(preSkillSlug);
    }
    if (RAM_GPU_TOOL_RE.test(String(toolName || ''))) {
      ramSavedTokens += RAM_SAVED_TOKENS_PER_CALL;
    }

    if (toolName === 'update_steps') {
      const normalizedChecklist = normalizeChecklistSteps(checklistSteps);
      if (normalizedChecklist.length > 0) {
        const nextSig = buildChecklistSignature(normalizedChecklist);
        checklistStepOps = nextSig === checklistSignature ? checklistStepOps : 0;
        checklistSignature = nextSig;
        checklistStepsApplied = true;
        checklistOverride = true;
        effectiveSteps = normalizedChecklist;
        const calc = computeChecklistProgress(effectiveSteps, checklistStepOps);
        totalSteps = calc.totalSteps;
        candidateStep = calc.currentStep;
        candidatePct = calc.percent;
        stepTitle = effectiveSteps[calc.currentStep - 1]?.title || 'Обновление чек-листа';
      } else {
        stepTitle = 'Обновление чек-листа';
      }
    } else if (toolName === 'exit_plan_mode') {
      const planSteps = planText ? extractStepsFromPlanText(planText, 24) : [];
      if (planSteps.length >= 2) {
        const isFollowUpWave = Boolean(chat.planStepsApplied || hasEditedCode);
        if (isFollowUpWave) {
          const completedPrefix = effectiveSteps
            .slice(0, prevHighStep)
            .map((s) => ({ ...s, status: 'completed' }));
          effectiveSteps = [
            ...completedPrefix,
            ...planSteps.map((s) => ({ ...s, status: 'pending' })),
          ]
            .slice(0, MAX_TIMELINE_STEPS)
            .map((s, i) => ({ ...s, index: i + 1 }));
          totalSteps = effectiveSteps.length;
          candidateStep = Math.min(totalSteps, completedPrefix.length + 1);
        } else {
          const prefix = effectiveSteps
            .slice(0, prevHighStep)
            .filter((s) => s && (s.kind === 'question' || s.source === 'live'));
          const hasQuestionPrefix = prefix.some((s) => s.kind === 'question');
          if (hasQuestionPrefix) {
            effectiveSteps = [
              ...prefix.map((s) => ({ ...s, status: 'completed' })),
              ...planSteps.map((s) => ({ ...s, status: 'pending' })),
            ]
              .slice(0, MAX_TIMELINE_STEPS)
              .map((s, i) => ({ ...s, index: i + 1 }));
            totalSteps = effectiveSteps.length;
            candidateStep = Math.min(totalSteps, prefix.length + 1);
          } else {
            effectiveSteps = planSteps.slice(0, MAX_TIMELINE_STEPS).map((s, i) => ({ ...s, index: i + 1 }));
            totalSteps = effectiveSteps.length;
            candidateStep = 1;
          }
        }
        planStepsApplied = true;
        candidatePct = hasEditedCode
          ? Math.min(MAX_RUNNING_PERCENT, Math.max(prevHighPct, 28))
          : Math.min(MAX_PRE_EDIT_PERCENT - 3, Math.max(24, prevHighPct));
        stepTitle = effectiveSteps[candidateStep - 1]?.title || effectiveSteps[0].title;
      } else {
        candidateStep = prevHighStep;
        stepTitle = 'Фиксация плана работ';
        candidatePct = hasEditedCode
          ? Math.min(MAX_RUNNING_PERCENT, Math.max(prevHighPct, 26))
          : Math.min(MAX_PRE_EDIT_PERCENT - 5, Math.max(22, prevHighPct));
      }
    } else if (isReadTool) {
      if (shortFile && !inspectedTargets.includes(shortFile) && inspectedTargets.length < 6) {
        inspectedTargets.push(shortFile);
      }
      if (hasEditedCode) {
        candidateStep = prevHighStep;
        stepTitle = shortFile ? `Уточнение ${shortFile}` : (cleanSummary ? compactTechnicalStepLabel(cleanSummary, 30).title : 'Дополнительная сверка кода');
        candidatePct = Math.min(MAX_RUNNING_PERCENT, prevHighPct + 2);
      } else {
        const prevIdx = Math.max(0, Math.min(effectiveSteps.length - 1, prevHighStep - 1));
        const curSlot = effectiveSteps[prevIdx];
        if (curSlot?.kind === 'recon' || (prevHighStep === 1 && curSlot?.kind !== 'question')) {
          candidateStep = prevHighStep;
          if (effectiveSteps[prevIdx]) effectiveSteps[prevIdx].kind = 'recon';
        } else if (curSlot?.kind === 'question' || chat.status === 'waiting_user' || curSlot?.source === 'live') {
          const nextIdx = prevIdx + 1;
          const nextSlot = effectiveSteps[nextIdx];
          if (
            nextSlot &&
            nextSlot.kind !== 'question' &&
            nextSlot.kind !== 'test' &&
            nextSlot.kind !== 'edit' &&
            nextSlot.source !== 'live' &&
            !/патч|правк|модифик/i.test(String(nextSlot.title || ''))
          ) {
            effectiveSteps[nextIdx] = { ...nextSlot, kind: 'recon', source: 'live', status: 'running' };
            candidateStep = nextIdx + 1;
          } else {
            const rLabel = shortFile ? `Чтение ${shortFile}` : (cleanSummary ? compactTechnicalStepLabel(cleanSummary, 30).title : 'Анализ контекста');
            const ins = insertOrAppendStep(effectiveSteps, nextIdx, {
              title: rLabel,
              fullTitle: shortFile ? `Дополнительное чтение ${shortFile}` : rLabel,
              source: 'live',
              kind: 'recon',
              status: 'running',
            });
            effectiveSteps = ins.steps;
            candidateStep = ins.stepNum;
            effectiveSteps = ensurePendingTailAfter(effectiveSteps, candidateStep - 1, { grade: chat.grade || 'M' });
          }
        } else {
          candidateStep = prevHighStep;
          if (effectiveSteps[prevIdx] && effectiveSteps[prevIdx].kind !== 'question') {
            effectiveSteps[prevIdx].kind = 'recon';
          }
        }
        totalSteps = Math.max(1, Math.min(MAX_TIMELINE_STEPS, effectiveSteps.length));
        stepTitle = shortFile ? `Чтение ${shortFile}` : (cleanSummary ? compactTechnicalStepLabel(cleanSummary, 30).title : 'Анализ контекста');
        candidatePct = Math.min(MAX_PRE_EDIT_PERCENT - 3, Math.max(18, Math.min(prevHighPct, MAX_PRE_EDIT_PERCENT - 5) + 3));
      }
    } else if (toolName === 'ask_question') {
      const qMeta = buildQuestionStepMeta(questionHint);
      const prevIdx = Math.max(0, Math.min(effectiveSteps.length - 1, prevHighStep - 1));
      const curSlot = effectiveSteps[prevIdx];
      let qIdx = prevIdx;
      if (curSlot && curSlot.kind === 'question') {
        effectiveSteps[prevIdx] = {
          ...curSlot,
          title: qMeta.title,
          fullTitle: qMeta.fullTitle,
          activeDetail: qMeta.fullTitle,
          source: 'live',
          kind: 'question',
        };
        candidateStep = prevHighStep;
      } else if (curSlot && curSlot.source === 'live') {
        const ins = insertOrAppendStep(effectiveSteps, prevHighStep, {
          title: qMeta.title,
          fullTitle: qMeta.fullTitle,
          activeDetail: qMeta.fullTitle,
          source: 'live',
          kind: 'question',
          status: 'waiting_user',
        });
        effectiveSteps = ins.steps;
        candidateStep = ins.stepNum;
        qIdx = ins.stepNum - 1;
      } else {
        effectiveSteps[prevIdx] = {
          ...(curSlot || {}),
          index: prevIdx + 1,
          title: qMeta.title,
          fullTitle: qMeta.fullTitle,
          activeDetail: qMeta.fullTitle,
          source: 'live',
          kind: 'question',
        };
        candidateStep = prevHighStep;
      }
      if (!hasEditedCode) {
        effectiveSteps = ensurePendingTailAfter(effectiveSteps, qIdx, { grade: chat.grade || 'M' });
      }
      totalSteps = Math.max(1, Math.min(MAX_TIMELINE_STEPS, effectiveSteps.length));
      stepTitle = 'Ожидание ответа пользователя';
      candidatePct = hasEditedCode
        ? Math.min(84, Math.max(prevHighPct, 54))
        : Math.min(MAX_PRE_EDIT_PERCENT - 5, Math.max(24, Math.min(prevHighPct, 28) + 2));
    } else if (toolName === 'invoke_subagent' || toolName === 'swarm') {
      const prevIdx = Math.max(0, Math.min(effectiveSteps.length - 1, prevHighStep - 1));
      const curSlot = effectiveSteps[prevIdx];
      const prefix = toolName === 'swarm' ? 'Рой' : 'Агент';
      const subLabel = compactTechnicalStepLabel(role ? `${prefix}: ${role}` : (cleanSummary || 'Параллельные агенты'), 30).title;
      const subFull = role ? `${prefix}: ${role}` : (cleanSummary || 'Параллельная работа субагентов');
      if (curSlot && curSlot.kind === 'subagent') {
        candidateStep = prevHighStep;
      } else if (prevHighStep >= 2 && curSlot && curSlot.source !== 'live' && curSlot.kind !== 'question' && curSlot.kind !== 'test' && curSlot.kind !== 'edit') {
        effectiveSteps[prevIdx] = { ...curSlot, kind: 'subagent' };
        candidateStep = prevHighStep;
      } else {
        const insIdx = prevHighStep;
        const nextSlot = effectiveSteps[insIdx];
        if (
          nextSlot &&
          nextSlot.source !== 'live' &&
          nextSlot.kind !== 'question' &&
          nextSlot.kind !== 'test' &&
          nextSlot.kind !== 'edit' &&
          !/патч|правк|модифик/i.test(String(nextSlot.title || ''))
        ) {
          effectiveSteps[insIdx] = { ...nextSlot, kind: 'subagent' };
          candidateStep = insIdx + 1;
        } else {
          const ins = insertOrAppendStep(effectiveSteps, insIdx, {
            title: subLabel,
            fullTitle: subFull,
            source: 'live',
            kind: 'subagent',
            status: 'running',
          });
          effectiveSteps = ins.steps;
          candidateStep = ins.stepNum;
          effectiveSteps = ensurePendingTailAfter(effectiveSteps, candidateStep - 1, { grade: chat.grade || 'M' });
        }
      }
      totalSteps = Math.max(1, Math.min(MAX_TIMELINE_STEPS, effectiveSteps.length));
      stepTitle = role ? `Субагент: ${String(role).slice(0, 32)}` : 'Параллельная работа агентов';
      candidatePct = hasEditedCode
        ? Math.min(76, Math.max(prevHighPct + 8, 44))
        : Math.min(MAX_PRE_EDIT_PERCENT, Math.max(24, Math.min(prevHighPct, 30) + 4));
    } else if (toolName === 'edit_file' || toolName === 'write_file') {
      hasEditedCode = true;
      const isNewEditTarget = Boolean(shortFile && !editedTargets.includes(shortFile));
      pendingNewEditTarget = isNewEditTarget;
      if (isNewEditTarget && editedTargets.length < 16) {
        editedTargets.push(shortFile);
      }
      if (cleanSym && !editedSymbols.includes(cleanSym) && editedSymbols.length < 5) {
        editedSymbols.push(cleanSym);
      }
      const prevIdx = Math.max(0, Math.min(effectiveSteps.length - 1, prevHighStep - 1));
      const curSlot = effectiveSteps[prevIdx];
      const nextSlot = effectiveSteps[prevIdx + 1];
      const canUseSlotForEdit = (s, idx) => Boolean(s) && s.kind !== 'question' && s.kind !== 'test' && (
        s.kind === 'edit' || (s.source !== 'live' && idx < effectiveSteps.length - 1)
      );

      if (planStepsApplied && totalSteps >= 5 && !isNewEditTarget && prevHighStep >= 2) {
        candidateStep = prevHighStep;
      } else if (curSlot && curSlot.kind === 'edit') {
        candidateStep = prevHighStep;
      } else if (prevHighStep >= 2 && canUseSlotForEdit(curSlot, prevIdx)) {
        effectiveSteps[prevIdx] = { ...curSlot, kind: 'edit' };
        candidateStep = prevHighStep;
      } else if (canUseSlotForEdit(nextSlot, prevIdx + 1)) {
        effectiveSteps[prevIdx + 1] = { ...nextSlot, kind: 'edit' };
        candidateStep = prevIdx + 2;
      } else {
        const eTitle = shortFile ? `Патч ${shortFile}` : 'Внесение патчей';
        const insIdx = prevHighStep === 1 && curSlot?.source !== 'live' && curSlot?.kind !== 'question' ? 1 : prevIdx + 1;
        const ins = insertOrAppendStep(effectiveSteps, Math.min(effectiveSteps.length, insIdx), {
          title: eTitle,
          fullTitle: shortFile ? `Модификация: ${shortFile}` : 'Модификация кода',
          source: 'live',
          kind: 'edit',
          status: 'running',
        });
        effectiveSteps = ins.steps;
        candidateStep = ins.stepNum;
        effectiveSteps = ensurePendingTailAfter(effectiveSteps, candidateStep - 1, { grade: chat.grade || 'M' });
      }
      totalSteps = Math.max(1, Math.min(MAX_TIMELINE_STEPS, effectiveSteps.length));
      stepTitle = shortFile ? `Правка ${shortFile}` : 'Модификация кода';
      const baseEditPct = totalSteps >= 4 ? 50 : 52;
      candidatePct = Math.min(86, Math.max(prevHighPct + 7, baseEditPct));
    } else if (toolName === 'run_command') {
      cmdMeta = formatCommandStepLabel(commandLine, cleanSummary, false);
      const prevIdx = Math.max(0, Math.min(effectiveSteps.length - 1, prevHighStep - 1));
      const curSlot = effectiveSteps[prevIdx];
      if (cmdMeta.isReconCmd && !hasEditedCode) {
        if (curSlot && curSlot.kind === 'cmd_recon') {
          candidateStep = prevHighStep;
        } else if (
          curSlot &&
          curSlot.source !== 'live' &&
          curSlot.kind !== 'question' &&
          curSlot.kind !== 'test' &&
          curSlot.kind !== 'edit' &&
          (prevHighStep === 1 || !/патч|правк|модифик/i.test(String(curSlot.title || '')))
        ) {
          effectiveSteps[prevIdx] = { ...curSlot, kind: 'cmd_recon' };
          candidateStep = prevHighStep;
        } else {
          const ins = insertOrAppendStep(effectiveSteps, prevIdx + 1, {
            title: cmdMeta.title,
            fullTitle: cmdMeta.fullTitle,
            activeDetail: cmdMeta.fullTitle,
            source: 'live',
            kind: 'cmd_recon',
            status: 'running',
          });
          effectiveSteps = ins.steps;
          candidateStep = ins.stepNum;
          effectiveSteps = ensurePendingTailAfter(effectiveSteps, candidateStep - 1, { grade: chat.grade || 'M' });
        }
        totalSteps = Math.max(1, Math.min(MAX_TIMELINE_STEPS, effectiveSteps.length));
        stepTitle = cmdMeta.title;
        candidatePct = Math.min(MAX_PRE_EDIT_PERCENT - 2, Math.max(20, Math.min(prevHighPct, MAX_PRE_EDIT_PERCENT - 5) + 4));
      } else if (cmdMeta.isTestCmd) {
        if (!hasEditedCode) {
          if (curSlot && curSlot.kind === 'test') {
            candidateStep = prevHighStep;
          } else {
            const ins = insertOrAppendStep(effectiveSteps, prevIdx + 1, {
              title: cmdMeta.title,
              fullTitle: cmdMeta.fullTitle,
              activeDetail: cmdMeta.fullTitle,
              source: 'live',
              kind: 'test',
              status: 'running',
            });
            effectiveSteps = ins.steps;
            candidateStep = ins.stepNum;
            effectiveSteps = ensurePendingTailAfter(effectiveSteps, candidateStep - 1, { grade: chat.grade || 'M' });
          }
          totalSteps = Math.max(1, Math.min(MAX_TIMELINE_STEPS, effectiveSteps.length));
          stepTitle = cmdMeta.title;
          candidatePct = Math.min(MAX_PRE_EDIT_PERCENT, Math.max(24, Math.min(prevHighPct, 31) + 4));
        } else {
          const lastIdx = effectiveSteps.length - 1;
          const lastSlot = effectiveSteps[lastIdx];
          if (lastSlot && (lastSlot.kind === 'question' || (lastSlot.source === 'live' && lastSlot.kind && lastSlot.kind !== 'test'))) {
            const ins = insertOrAppendStep(effectiveSteps, effectiveSteps.length, {
              title: cmdMeta.title,
              fullTitle: cmdMeta.fullTitle,
              activeDetail: cmdMeta.fullTitle,
              source: 'live',
              kind: 'test',
              status: 'running',
            });
            effectiveSteps = ins.steps;
            candidateStep = ins.stepNum;
          } else {
            if (lastSlot) effectiveSteps[lastIdx] = { ...lastSlot, kind: 'test' };
            candidateStep = effectiveSteps.length;
          }
          totalSteps = Math.max(1, Math.min(MAX_TIMELINE_STEPS, effectiveSteps.length));
          stepTitle = cmdMeta.title;
          candidatePct = Math.min(MAX_RUNNING_PERCENT, Math.max(prevHighPct + 4, 86));
        }
      } else {
        if (curSlot && curSlot.kind === 'cmd') {
          candidateStep = prevHighStep;
        } else {
          const nextSlot = effectiveSteps[prevIdx + 1];
          if (prevHighStep >= 2 && curSlot && curSlot.kind !== 'question' && curSlot.kind !== 'test' && curSlot.kind !== 'edit' && curSlot.source !== 'live') {
            effectiveSteps[prevIdx] = { ...curSlot, kind: 'cmd' };
            candidateStep = prevHighStep;
          } else if (nextSlot && nextSlot.kind !== 'question' && nextSlot.kind !== 'test' && nextSlot.kind !== 'edit' && nextSlot.source !== 'live') {
            effectiveSteps[prevIdx + 1] = { ...nextSlot, kind: 'cmd' };
            candidateStep = prevIdx + 2;
          } else {
            const ins = insertOrAppendStep(effectiveSteps, prevIdx + 1, {
              title: cmdMeta.title,
              fullTitle: cmdMeta.fullTitle,
              activeDetail: cmdMeta.fullTitle,
              source: 'live',
              kind: 'cmd',
              status: 'running',
            });
            effectiveSteps = ins.steps;
            candidateStep = ins.stepNum;
            effectiveSteps = ensurePendingTailAfter(effectiveSteps, candidateStep - 1, { grade: chat.grade || 'M' });
          }
        }
        totalSteps = Math.max(1, Math.min(MAX_TIMELINE_STEPS, effectiveSteps.length));
        stepTitle = cmdMeta.title;
        candidatePct = hasEditedCode
          ? Math.min(88, Math.max(prevHighPct + 5, 48))
          : Math.min(MAX_PRE_EDIT_PERCENT, Math.max(24, Math.min(prevHighPct, 31) + 4));
      }
    }

    const effectiveStatus = toolName === 'ask_question' ? 'waiting_user' : 'running';
    let currentStep;
    let percent;
    let updatedSteps;
    if (checklistStepsApplied && checklistOverride) {
      currentStep = Math.min(totalSteps, Math.max(1, candidateStep));
      percent = clampInt(candidatePct, 0, MAX_RUNNING_PERCENT, 4);
      updatedSteps = effectiveSteps.map((s, i) => ({ ...s, index: i + 1 }));
    } else if (checklistStepsApplied && Array.isArray(frozenChecklistSteps) && frozenChecklistSteps.length > 0) {
      checklistStepOps += 1;
      const calc = computeChecklistProgress(frozenChecklistSteps, checklistStepOps);
      totalSteps = calc.totalSteps;
      currentStep = calc.currentStep;
      percent = calc.percent;
      updatedSteps = frozenChecklistSteps.map((s, i) => ({ ...s, index: i + 1 }));
    } else {
      currentStep = toolName === 'exit_plan_mode' && planStepsApplied
        ? Math.min(totalSteps, Math.max(1, candidateStep))
        : Math.min(totalSteps, Math.max(prevHighStep, candidateStep));
      percent = computeStepBoundPercent({
        currentStep,
        totalSteps,
        candidatePct,
        prevHighPct,
        hasEditedCode,
        isError: false,
      });
      updatedSteps = syncStepsArray(effectiveSteps, currentStep, effectiveStatus);
    }
    const canMutateChip = (idx) => !checklistStepsApplied && updatedSteps[idx] && updatedSteps[idx].source !== 'plan' && updatedSteps[idx].source !== 'explicit' && updatedSteps[idx].kind !== 'question';

    if (isReadTool) {
      const reconIdx = updatedSteps[currentStep - 1]?.kind === 'recon' ? (currentStep - 1) : 0;
      if (canMutateChip(reconIdx)) {
        updatedSteps[reconIdx].kind = 'recon';
        if (inspectedTargets.length > 0 && reconIdx === 0) {
          updatedSteps[reconIdx].title = compactTechnicalStepLabel(`RAM-срез ${formatTargetFilesCompact(inspectedTargets, 18)}`, 30).title;
          updatedSteps[reconIdx].fullTitle = `Чтение срезов и зависимостей: ${inspectedTargets.join(', ')}`.slice(0, 140);
          updatedSteps[reconIdx].source = 'live';
        } else if (shortFile) {
          updatedSteps[reconIdx].title = compactTechnicalStepLabel(`Чтение ${shortFile}`, 30).title;
          updatedSteps[reconIdx].fullTitle = `Чтение и анализ ${shortFile}`.slice(0, 140);
          updatedSteps[reconIdx].source = 'live';
        } else if (cleanSummary) {
          const sumLbl = compactTechnicalStepLabel(cleanSummary, 30);
          if (sumLbl.title) {
            updatedSteps[reconIdx].title = sumLbl.title;
            updatedSteps[reconIdx].fullTitle = sumLbl.fullTitle;
            updatedSteps[reconIdx].source = 'live';
          }
        }
      }
    } else if (toolName === 'edit_file' || toolName === 'write_file') {
      const editIdx = Math.min(updatedSteps.length - 1, Math.max(0, currentStep - 1));
      const symText = editedSymbols.length > 0 ? ` (${editedSymbols.join(', ')})` : '';
      const fullEditDesc = `Модификация: ${editedTargets.join(', ') || 'файлы'}${symText}`.slice(0, 140);
      if (updatedSteps[editIdx] && updatedSteps[editIdx].kind !== 'question') {
        updatedSteps[editIdx].kind = 'edit';
        updatedSteps[editIdx].activeDetail = fullEditDesc;
        if (canMutateChip(editIdx)) {
          const chipRaw = editedTargets.length === 1 && cleanSym
            ? `Патч ${editedTargets[0]} · ${cleanSym}`
            : (editedTargets.length > 0 ? `Патч ${formatTargetFilesCompact(editedTargets, 22)}` : 'Модификация кода');
          updatedSteps[editIdx].title = compactTechnicalStepLabel(chipRaw, 30).title;
          updatedSteps[editIdx].fullTitle = fullEditDesc;
          updatedSteps[editIdx].source = 'live';
        }
      }
    } else if (toolName === 'invoke_subagent' || toolName === 'swarm') {
      const subIdx = Math.min(updatedSteps.length - 1, Math.max(0, currentStep - 1));
      if (canMutateChip(subIdx)) {
        const prefix = toolName === 'swarm' ? 'Рой' : 'Агент';
        const raw = role ? `${prefix}: ${role}` : (cleanSummary || 'Параллельные агенты');
        const lbl = compactTechnicalStepLabel(raw, 30);
        updatedSteps[subIdx].kind = 'subagent';
        if (lbl.title) {
          updatedSteps[subIdx].title = lbl.title;
          updatedSteps[subIdx].fullTitle = lbl.fullTitle;
          updatedSteps[subIdx].source = 'live';
        }
      }
    } else if (toolName === 'run_command' && cmdMeta) {
      const cmdIdx = Math.min(updatedSteps.length - 1, Math.max(0, currentStep - 1));
      if (updatedSteps[cmdIdx] && updatedSteps[cmdIdx].kind !== 'question') {
        updatedSteps[cmdIdx].kind = updatedSteps[cmdIdx].kind || (cmdMeta.isReconCmd ? 'cmd_recon' : (cmdMeta.isTestCmd ? 'test' : 'cmd'));
        updatedSteps[cmdIdx].activeDetail = cmdMeta.fullTitle;
        if (canMutateChip(cmdIdx)) {
          updatedSteps[cmdIdx].title = cmdMeta.title;
          updatedSteps[cmdIdx].fullTitle = cmdMeta.fullTitle;
          updatedSteps[cmdIdx].source = 'live';
        }
      }
    }

    if (updatedSteps[currentStep - 1] && stepTitle && !updatedSteps[currentStep - 1].activeDetail) {
      updatedSteps[currentStep - 1].activeDetail = stepTitle;
    }

    const stageLabel = `Этап ${currentStep} из ${totalSteps}`;
    const nextPendingHandoff = toolName === 'exit_plan_mode'
      ? true
      : (toolName === 'ask_question' ? Boolean(chat.pendingPlanHandoff) : false);
    const hasPostHook = POST_TOOL_HOOK_TOOLS.has(toolName);
    const updatedChat = {
      ...chat,
      conversationId: cid,
      chatNumber,
      isSubagent: effectiveIsSub,
      parentConversationId: effectiveIsSub ? effectiveParentCid : '',
      agentKind: isSwarmWorker ? 'swarm_worker' : (effectiveIsSub ? (chat.agentKind || 'subagent') : ''),
      roleLabel: preferredSubRole,
      projectName: projName,
      workspaceRoot: sanitizeWorkspaceRoot(cleanWs || chat.workspaceRoot || ''),
      transcriptPath: resolvedTranscript || chat.transcriptPath || '',
      status: effectiveStatus,
      currentStep,
      totalSteps,
      percent,
      highWaterStep: currentStep,
      highWaterPercent: percent,
      planStepsApplied,
      checklistStepsApplied,
      checklistSignature,
      checklistStepOps,
      orchestratorSession: Boolean(chat.orchestratorSession || toolName === 'exit_plan_mode'),
      pendingPlanHandoff: nextPendingHandoff,
      planHandedOffAt: toolName === 'exit_plan_mode' ? now : Number(chat.planHandedOffAt || 0),
      pendingNewEditTarget,
      inspectedTargets,
      editedTargets,
      editedSymbols,
      activeSkills,
      ramSavedTokens,
      stepTitle,
      stageLabel,
      formattedText: buildFormattedProgressText({ status: effectiveStatus, currentStep, totalSteps, stepTitle }),
      steps: updatedSteps,
      inFlightTool: hasPostHook,
      inFlightToolName: hasPostHook ? toolName : '',
      bgInFlight: false,
      lastPreToolAt: now,
      toolOpsCount: ops,
      completedAt: 0,
      updatedAt: now,
    };

    chatsMap[cid] = updatedChat;
    state.chatRegistry = registry;
    state.chats = chatsMap;
    const visible = sweepAndBuildVisibleChats(chatsMap, state, cid, now, DEFAULT_COMPLETED_HOLD_MS, brainDirs, projName, cleanWs);
    return hydrateStateWithPrimary(state, visible, projName, cleanWs);
  });
}

/**
 * Updates task progress monotonically when a tool finishes (PostToolUse).
 * Caps running progress at MAX_RUNNING_PERCENT (92%); final 100% is unlocked when transcript.jsonl records turn completion.
 */
export function recordTaskProgressOnPostTool({
  conversationId = 'default',
  workspaceRoot = '',
  transcriptPath = '',
  toolName = '',
  filePath = '',
  verifyOk = true,
  microTestsRan = false,
  dependentsCount = 0,
  brokenContractsCount = 0,
  testFile = '',
  commandLine = '',
  toolSummary = '',
  hasError = false,
  brainDirs = null,
} = {}) {
  ensureCacheDir();
  const now = Date.now();
  const cid = normalizeConversationId(conversationId);
  const cleanWs = sanitizeWorkspaceRoot(workspaceRoot);
  const shortFile = sanitizeFileBasename(filePath);
  const cleanTestFile = sanitizeFileBasename(testFile);
  const cleanSummary = String(toolSummary || '').trim();

  return updateJsonAtomicSync(getTaskProgressFile(), createDefaultProgressState, (prev) => {
    const state = prev && typeof prev === 'object' ? { ...createDefaultProgressState(), ...prev } : createDefaultProgressState();
    const deduped = dedupeAndNormalizeChatsMap(state.chats, state.chatRegistry, brainDirs, now);
    const chatsMap = deduped.chatsMap;
    state.chatRegistry = deduped.registry;

    const resolvedTranscript = resolveTranscriptPathForChat(cid, transcriptPath || chatsMap[cid]?.transcriptPath || '', brainDirs);
    const subMeta = resolvedTranscript
      ? inspectSubagentTranscriptMeta(resolvedTranscript)
      : { isSubagent: false, parentConversationId: '', agentKind: '', agentHint: '' };
    const effectiveIsSub = Boolean(subMeta.isSubagent || chatsMap[cid]?.isSubagent);
    let effectiveParentCid = normalizeConversationId(subMeta.parentConversationId || chatsMap[cid]?.parentConversationId || '');
    if (effectiveParentCid === 'default' || effectiveParentCid === cid) effectiveParentCid = '';

    const projName = extractProjectName(cleanWs || chatsMap[cid]?.workspaceRoot || state.workspaceRoot || '');
    let chatNumber = chatsMap[cid]?.chatNumber || 1;
    let registry = state.chatRegistry;
    if (!effectiveIsSub) {
      const assigned = assignChatNumber(state.chatRegistry, cid, projName, now);
      chatNumber = assigned.chatNumber;
      registry = assigned.registry;
    }

    const baseSteps = chatsMap[cid]?.steps?.length
      ? chatsMap[cid].steps
      : buildDefaultStepsForGrade(effectiveIsSub ? 'S' : (state.grade || 'M'), false, {
          matchedFiles: shortFile ? [shortFile] : [],
        });
    const chat = chatsMap[cid]
      ? { ...chatsMap[cid] }
      : {
          conversationId: cid,
          chatNumber,
          isSubagent: effectiveIsSub,
          parentConversationId: effectiveIsSub ? effectiveParentCid : '',
          agentKind: subMeta.agentKind || (effectiveIsSub ? 'subagent' : ''),
          roleLabel: effectiveIsSub ? (subMeta.agentHint || '') : '',
          projectName: projName,
          workspaceRoot: sanitizeWorkspaceRoot(cleanWs || state.workspaceRoot || ''),
          transcriptPath: resolvedTranscript,
          status: 'running',
          grade: effectiveIsSub ? 'S' : (state.grade || 'M'),
          currentStep: 1,
          totalSteps: baseSteps.length,
          percent: 20,
          highWaterStep: 1,
          highWaterPercent: 20,
          planStepsApplied: false,
          inspectedTargets: [],
          editedTargets: [],
          editedSymbols: [],
          steps: baseSteps,
          editedFilesCount: 0,
          startedAt: resolveTranscriptBirthMs(resolvedTranscript, now),
        };

    const editedTargets = Array.isArray(chat.editedTargets) ? [...chat.editedTargets] : [];
    const totalSteps = Math.max(1, clampInt(chat.totalSteps, 1, MAX_TIMELINE_STEPS, 3));
    const prevHighStep = clampInt(chat.highWaterStep || chat.currentStep || 1, 1, totalSteps, 1);
    const prevHighPct = clampInt(chat.highWaterPercent || chat.percent || 20, 10, MAX_RUNNING_PERCENT, 20);
    let hasEditedCode = hasCodeEdits(chat);
    let candidateStep = prevHighStep;
    let candidatePct = prevHighPct;
    let status = 'running';
    let stepTitle = chat.stepTitle || 'Выполнение операции';
    let editedFilesCount = Number(chat.editedFilesCount || 0);
    let cmdMeta = null;

    if (toolName === 'edit_file' || toolName === 'write_file') {
      hasEditedCode = true;
      editedFilesCount += 1;
      const isNewEditedTarget = Boolean(chat.pendingNewEditTarget || (shortFile && !editedTargets.includes(shortFile)));
      if (shortFile && !editedTargets.includes(shortFile) && editedTargets.length < 16) {
        editedTargets.push(shortFile);
      }
      if (!verifyOk || hasError) {
        status = 'error';
        stepTitle = brokenContractsCount > 0
          ? `Сбой контракта (${brokenContractsCount})`
          : (shortFile ? `Ошибка проверки ${shortFile}` : 'Ошибка проверки синтаксиса');
      } else {
        const editIdx = Math.max(0, Math.min(totalSteps - 1, prevHighStep - 1));
        const nextIdx = editIdx + 1;
        const shouldAdvanceStep = !(chat.planStepsApplied && totalSteps >= 5) || isNewEditedTarget || prevHighStep === 1;
        if (shouldAdvanceStep) {
          if (totalSteps >= 4 && nextIdx < totalSteps && chat.steps?.[nextIdx]?.kind !== 'question' && chat.steps?.[nextIdx]?.kind !== 'test') {
            candidateStep = Math.max(prevHighStep, nextIdx + 1);
          } else if (totalSteps >= 4 && nextIdx < totalSteps - 1 && chat.steps?.[nextIdx]?.kind !== 'question') {
            candidateStep = Math.max(prevHighStep, nextIdx + 1);
          } else if (totalSteps === 3) {
            candidateStep = microTestsRan ? 3 : Math.max(prevHighStep, 2);
          }
        }
        candidatePct = microTestsRan
          ? Math.max(prevHighPct + 4, 88)
          : Math.min(88, Math.max(prevHighPct + 8, 68));
        stepTitle = shortFile
          ? (microTestsRan ? `Проверено: ${shortFile}` : `Обновлён ${shortFile}`)
          : 'Изменения проверены';
      }
    } else if (toolName === 'run_command') {
      cmdMeta = formatCommandStepLabel(commandLine, cleanSummary, true);
      if (hasError || !verifyOk) {
        status = 'error';
        stepTitle = 'Ошибка выполнения команды';
      } else if (cmdMeta.isReconCmd && !hasEditedCode) {
        candidateStep = prevHighStep;
        stepTitle = cmdMeta.postTitle || cmdMeta.title || 'Разведка завершена';
        candidatePct = Math.min(MAX_PRE_EDIT_PERCENT, Math.max(24, Math.min(prevHighPct, 31) + 2));
      } else if (cmdMeta.isTestCmd) {
        if (!hasEditedCode) {
          candidateStep = prevHighStep;
          stepTitle = cmdMeta.postTitle || cmdMeta.title || 'Базовая проверка завершена';
          candidatePct = Math.min(MAX_PRE_EDIT_PERCENT, Math.max(26, Math.min(prevHighPct, 32) + 3));
        } else {
          candidateStep = totalSteps;
          candidatePct = Math.min(MAX_RUNNING_PERCENT, Math.max(prevHighPct + 5, 90));
          stepTitle = cmdMeta.postTitle || 'Проверки пройдены · финализация';
        }
      } else {
        candidateStep = Math.min(totalSteps, Math.max(prevHighStep, 2));
        stepTitle = cmdMeta.postTitle || 'Команда выполнена';
        candidatePct = hasEditedCode
          ? Math.min(89, Math.max(prevHighPct + 6, 74))
          : Math.min(MAX_PRE_EDIT_PERCENT, Math.max(25, Math.min(prevHighPct, 31) + 3));
      }
    }

    let currentStep;
    let percent;
    let updatedSteps;
    let nextChecklistStepOps = Math.max(0, Number(chat.checklistStepOps || 0));
    if (chat.checklistStepsApplied && Array.isArray(chat.steps) && chat.steps.length > 0) {
      nextChecklistStepOps += 1;
      const calc = computeChecklistProgress(chat.steps, nextChecklistStepOps);
      currentStep = calc.currentStep;
      percent = calc.percent;
      updatedSteps = chat.steps.map((s, i) => ({ ...s, index: i + 1 }));
    } else {
      currentStep = Math.min(totalSteps, Math.max(prevHighStep, candidateStep));
      percent = computeStepBoundPercent({
        currentStep,
        totalSteps,
        candidatePct,
        prevHighPct,
        hasEditedCode,
        isError: status === 'error',
      });
      updatedSteps = syncStepsArray(chat.steps || [], currentStep, status);
    }
    const canMutateChip = (idx) => !chat.checklistStepsApplied && updatedSteps[idx] && updatedSteps[idx].source !== 'plan' && updatedSteps[idx].source !== 'explicit' && updatedSteps[idx].kind !== 'question';

    if (toolName === 'edit_file' || toolName === 'write_file') {
      if (verifyOk && !hasError) {
        const astIdx = Math.max(0, Math.min(updatedSteps.length - 1, prevHighStep));
        if (totalSteps >= 4 && astIdx < updatedSteps.length - 1 && canMutateChip(astIdx)) {
          const contractTitle = dependentsCount > 0
            ? `Контракты AST (${dependentsCount} завис.)`
            : 'Контракты AST и синтаксис ✓';
          updatedSteps[astIdx].title = compactTechnicalStepLabel(contractTitle, 30).title;
          updatedSteps[astIdx].fullTitle = dependentsCount > 0
            ? `Сверка импортов и контрактов (${dependentsCount} обратных зависимостей)`
            : 'Синтаксис и контракты импорта проверены';
          updatedSteps[astIdx].kind = updatedSteps[astIdx].kind || 'verify';
          updatedSteps[astIdx].source = 'live';
        }
        if (microTestsRan && cleanTestFile) {
          const lastIdx = updatedSteps.length - 1;
          if (canMutateChip(lastIdx)) {
            updatedSteps[lastIdx].title = compactTechnicalStepLabel(`Микро-тест ${cleanTestFile}`, 30).title;
            updatedSteps[lastIdx].fullTitle = `Test-Impact верификация: ${cleanTestFile} ✓`;
            updatedSteps[lastIdx].kind = 'test';
            updatedSteps[lastIdx].source = 'live';
          }
        }
      } else {
        const errIdx = Math.min(updatedSteps.length - 1, Math.max(0, currentStep - 1));
        if (updatedSteps[errIdx]) {
          if (brokenContractsCount > 0 && canMutateChip(errIdx)) {
            updatedSteps[errIdx].title = `Сбой контракта (${brokenContractsCount})`;
            updatedSteps[errIdx].fullTitle = `Нарушены контракты импорта (${brokenContractsCount} модулей)`;
            updatedSteps[errIdx].source = 'live';
          } else if (shortFile) {
            updatedSteps[errIdx].fullTitle = `Ошибка проверки: ${shortFile}`;
          }
        }
      }
    } else if (toolName === 'run_command' && cmdMeta) {
      const cmdIdx = Math.min(updatedSteps.length - 1, Math.max(0, currentStep - 1));
      if (updatedSteps[cmdIdx] && canMutateChip(cmdIdx)) {
        updatedSteps[cmdIdx].title = cmdMeta.title;
        updatedSteps[cmdIdx].fullTitle = (!hasError && verifyOk)
          ? cmdMeta.fullTitle
          : `Сбой команды: ${cmdMeta.fullTitle}`.slice(0, 140);
        updatedSteps[cmdIdx].source = 'live';
      }
    }

    const stageLabel = `Этап ${currentStep} из ${totalSteps}`;

    const updatedChat = {
      ...chat,
      conversationId: cid,
      chatNumber,
      isSubagent: effectiveIsSub,
      parentConversationId: effectiveIsSub ? effectiveParentCid : '',
      agentKind: subMeta.agentKind || chat.agentKind || (effectiveIsSub ? 'subagent' : ''),
      roleLabel: effectiveIsSub ? (chat.roleLabel || subMeta.agentHint || '') : '',
      projectName: projName,
      workspaceRoot: sanitizeWorkspaceRoot(cleanWs || chat.workspaceRoot || ''),
      transcriptPath: resolvedTranscript || chat.transcriptPath || '',
      status,
      currentStep,
      totalSteps,
      percent,
      highWaterStep: currentStep,
      highWaterPercent: percent,
      checklistStepOps: nextChecklistStepOps,
      pendingPlanHandoff: toolName === 'exit_plan_mode' ? Boolean(chat.pendingPlanHandoff) : false,
      pendingNewEditTarget: false,
      editedTargets,
      stepTitle,
      stageLabel,
      formattedText: buildFormattedProgressText({ status, currentStep, totalSteps, stepTitle }),
      steps: updatedSteps,
      inFlightTool: false,
      inFlightToolName: '',
      bgInFlight: false,
      lastPostToolAt: now,
      editedFilesCount,
      updatedAt: now,
    };

    chatsMap[cid] = updatedChat;
    state.chatRegistry = registry;
    state.chats = chatsMap;
    const visible = sweepAndBuildVisibleChats(chatsMap, state, cid, now, DEFAULT_COMPLETED_HOLD_MS, brainDirs, projName, cleanWs);
    return hydrateStateWithPrimary(state, visible, projName, cleanWs);
  });
}

/**
 * Explicitly sets the task progress stages, active step, and percentage (used by API / MCP / Demo).
 */
export function setExplicitTaskProgress({
  conversationId = 'default',
  parentConversationId = '',
  isSubagent = false,
  roleLabel = '',
  agentKind = '',
  workspaceRoot = '',
  topicLabel = '',
  currentStep,
  totalSteps,
  percent,
  stepTitle = '',
  status = 'running',
  steps = null,
} = {}) {
  ensureCacheDir();
  const now = Date.now();
  const cid = normalizeConversationId(conversationId);
  const cleanWs = sanitizeWorkspaceRoot(workspaceRoot);

  return updateJsonAtomicSync(getTaskProgressFile(), createDefaultProgressState, (prev) => {
    const state = prev && typeof prev === 'object' ? { ...createDefaultProgressState(), ...prev } : createDefaultProgressState();
    const deduped = dedupeAndNormalizeChatsMap(state.chats, state.chatRegistry, null, now);
    const chatsMap = deduped.chatsMap;
    state.chatRegistry = deduped.registry;

    const existing = chatsMap[cid] || null;
    const effectiveIsSub = Boolean(isSubagent || existing?.isSubagent);
    let effectiveParentCid = normalizeConversationId(parentConversationId || existing?.parentConversationId || '');
    if (effectiveParentCid === 'default' || effectiveParentCid === cid) effectiveParentCid = '';

    const projName = extractProjectName(cleanWs || existing?.workspaceRoot || state.workspaceRoot || '');
    let chatNumber = existing?.chatNumber || 1;
    let registry = state.chatRegistry;
    if (!effectiveIsSub) {
      const assigned = assignChatNumber(state.chatRegistry, cid, projName, now);
      chatNumber = assigned.chatNumber;
      registry = assigned.registry;
    }

    const nextSteps = Array.isArray(steps) && steps.length > 0
      ? steps.map((s, idx) => {
          const title = String(s?.title || s || `Этап ${idx + 1}`).trim();
          return {
            index: idx + 1,
            title,
            fullTitle: String(s?.fullTitle || title).trim(),
            source: 'explicit',
            ...(s?.kind ? { kind: s.kind } : {}),
            status: 'pending',
          };
        })
      : (Array.isArray(existing?.steps) && existing.steps.length > 0 ? existing.steps : buildDefaultStepsForGrade(effectiveIsSub ? 'S' : 'L', false));

    const safeTotal = clampInt(totalSteps ?? nextSteps.length, 1, MAX_TIMELINE_STEPS, nextSteps.length || 4);
    const safeCurrent = clampInt(currentStep ?? existing?.currentStep ?? 1, 1, safeTotal, 1);
    const cleanStatus = ['idle', 'running', 'waiting_user', 'completed', 'error'].includes(String(status))
      ? String(status)
      : 'running';
    const computedPct = percent !== undefined && percent !== null
      ? clampInt(percent, 0, 100, 0)
      : cleanStatus === 'completed'
        ? 100
        : Math.round(((safeCurrent - 0.5) / safeTotal) * 100);
    const cleanTitle = sanitizeStepText(stepTitle || nextSteps[safeCurrent - 1]?.title || existing?.stepTitle || 'Выполнение задачи');

    const updatedChat = {
      ...(existing || {}),
      conversationId: cid,
      chatNumber,
      topicLabel: effectiveIsSub ? '' : (topicLabel || existing?.topicLabel || ''),
      roleLabel: effectiveIsSub ? (roleLabel || existing?.roleLabel || '') : '',
      isSubagent: effectiveIsSub,
      parentConversationId: effectiveIsSub ? effectiveParentCid : '',
      agentKind: effectiveIsSub ? (agentKind || existing?.agentKind || 'subagent') : '',
      projectName: projName,
      workspaceRoot: sanitizeWorkspaceRoot(cleanWs || existing?.workspaceRoot || state.workspaceRoot || ''),
      isDemo: cid === 'demo' || cid === 'default' || cid.startsWith('demo-'),
      status: cleanStatus,
      currentStep: cleanStatus === 'idle' ? 0 : safeCurrent,
      totalSteps: cleanStatus === 'idle' ? 0 : safeTotal,
      percent: cleanStatus === 'idle' ? 0 : computedPct,
      highWaterStep: cleanStatus === 'idle' ? 0 : safeCurrent,
      highWaterPercent: cleanStatus === 'idle' ? 0 : computedPct,
      stepTitle: cleanStatus === 'idle' ? 'В ожидании задач' : cleanTitle,
      stageLabel: cleanStatus === 'idle' ? 'В ожидании задач' : `Этап ${safeCurrent} из ${safeTotal}`,
      formattedText: buildFormattedProgressText({
        status: cleanStatus,
        currentStep: safeCurrent,
        totalSteps: safeTotal,
        stepTitle: cleanTitle,
      }),
      steps: syncStepsArray(nextSteps, safeCurrent, cleanStatus),
      completedAt: cleanStatus === 'completed' ? now : 0,
      startedAt: existing?.startedAt || now,
      updatedAt: now,
    };

    chatsMap[cid] = updatedChat;
    state.chatRegistry = registry;
    state.chats = chatsMap;
    const visible = sweepAndBuildVisibleChats(chatsMap, state, cid, now, DEFAULT_COMPLETED_HOLD_MS, null, projName, cleanWs);
    return hydrateStateWithPrimary(state, visible, projName, cleanWs);
  });
}

/**
 * Finalizes chat task progress immediately when the native Antigravity `Stop` lifecycle hook fires.
 * Preserves `waiting_user` pauses on unanswered `ask_question` prompts.
 */
export function finalizeTaskProgressOnStop({
  conversationId = 'default',
  workspaceRoot = '',
  transcriptPath = '',
  terminationReason = '',
  hasError = false,
  fullyIdle = true,
  isOrchestratorMode = false,
  brainDirs = null,
} = {}) {
  ensureCacheDir();
  const now = Date.now();
  const cid = normalizeConversationId(conversationId);
  const cleanWs = sanitizeWorkspaceRoot(workspaceRoot);

  return updateJsonAtomicSync(getTaskProgressFile(), createDefaultProgressState, (prev) => {
    const state = prev && typeof prev === 'object' ? { ...createDefaultProgressState(), ...prev } : createDefaultProgressState();
    const deduped = dedupeAndNormalizeChatsMap(state.chats, state.chatRegistry, brainDirs, now);
    const chatsMap = deduped.chatsMap;
    state.chatRegistry = deduped.registry;

    const existing = chatsMap[cid] || null;
    const projName = extractProjectName(cleanWs || existing?.workspaceRoot || state.workspaceRoot || '');
    if (!existing) {
      const visible = sweepAndBuildVisibleChats(chatsMap, state, cid, now, DEFAULT_COMPLETED_HOLD_MS, brainDirs, projName, cleanWs);
      return hydrateStateWithPrimary(state, visible, projName, cleanWs);
    }

    if (existing.status === 'waiting_user') {
      chatsMap[cid] = {
        ...existing,
        inFlightTool: false,
        inFlightToolName: '',
        updatedAt: now,
      };
      state.chats = chatsMap;
      const visible = sweepAndBuildVisibleChats(chatsMap, state, cid, now, DEFAULT_COMPLETED_HOLD_MS, brainDirs, projName, cleanWs);
      return hydrateStateWithPrimary(state, visible, projName, cleanWs);
    }

    const totalSteps = Math.max(1, clampInt(existing.totalSteps || existing.steps?.length, 1, MAX_TIMELINE_STEPS, 3));
    const termStr = String(terminationReason || '').trim();
    const isErr = Boolean(hasError) || /^ERROR$/i.test(termStr);
    const isCanceled = /^(?:USER_CANCELED|USER_CANCELLED|ABORTED)$/i.test(termStr);
    const stopTranscript = (!isErr && !isCanceled)
      ? resolveTranscriptPathForChat(cid, transcriptPath || existing.transcriptPath || '', brainDirs)
      : '';
    const stopTurnInfo = stopTranscript
      ? inspectTranscriptTurnState(stopTranscript, now, { hostBootAt: Number(state.hostBootAt || 0) })
      : { exists: false };
    const hasBgRunning = Boolean(!isErr && !isCanceled && stopTurnInfo?.hasRunningBackgroundTask);
    const isTerminalHandoff = !isErr && !isCanceled && !hasBgRunning && (
      isPendingPlanHandoffActive(existing, now) ||
      /^TERMINAL_STEP_TYPE$/i.test(termStr) ||
      fullyIdle === false
    );

    if (hasBgRunning) {
      const curStep = clampInt(existing.currentStep || 1, 1, totalSteps, 1);
      const bgTitle = stopTurnInfo.backgroundTaskLabel || existing.stepTitle || 'Фоновая задача';
      const bgCount = Array.isArray(stopTurnInfo.runningBackgroundTasks) ? stopTurnInfo.runningBackgroundTasks.length : 1;
      const baseSteps = Array.isArray(existing.steps) && existing.steps.length > 0
        ? existing.steps
        : buildDefaultStepsForGrade(existing.grade || 'M', false);
      const rawPrevPct = Number(existing.percent || 0) >= 100
        ? (Number(existing.preStopPercent || 0) || Number(existing.highWaterPercent || 0) || 65)
        : (Number(existing.percent || 0) || Number(existing.highWaterPercent || 0) || 25);
      const nextPct = clampInt(rawPrevPct, 15, MAX_RUNNING_PERCENT, 25);
      chatsMap[cid] = {
        ...existing,
        transcriptPath: stopTranscript || transcriptPath || existing.transcriptPath || '',
        workspaceRoot: sanitizeWorkspaceRoot(cleanWs || existing.workspaceRoot || state.workspaceRoot || ''),
        status: 'running',
        currentStep: curStep,
        totalSteps,
        percent: nextPct,
        hasRunningBackgroundTask: true,
        backgroundTasksCount: bgCount,
        backgroundTasks: normalizeBackgroundTasksList(stopTurnInfo.backgroundTasks),
        backgroundTasksTotalCount: Math.max(
          Array.isArray(stopTurnInfo.backgroundTasks) ? stopTurnInfo.backgroundTasks.length : 0,
          Math.round(Number(stopTurnInfo.backgroundTasksTotalCount || 0))
        ),
        stepTitle: bgTitle,
        stageLabel: `Этап ${curStep} из ${totalSteps}`,
        formattedText: buildFormattedProgressText({
          status: 'running',
          currentStep: curStep,
          totalSteps,
          stepTitle: bgTitle,
        }),
        steps: syncStepsArray(baseSteps, curStep, 'running'),
        inFlightTool: true,
        inFlightToolName: 'run_command',
        bgInFlight: true,
        lastStopReason: termStr,
        fullyIdle: false,
        updatedAt: now,
      };
      state.chats = chatsMap;
      const visible = sweepAndBuildVisibleChats(chatsMap, state, cid, now, DEFAULT_COMPLETED_HOLD_MS, brainDirs, projName, cleanWs);
      return hydrateStateWithPrimary(state, visible, projName, cleanWs);
    }

    if (isTerminalHandoff) {
      chatsMap[cid] = {
        ...existing,
        transcriptPath: transcriptPath || existing.transcriptPath || '',
        workspaceRoot: sanitizeWorkspaceRoot(cleanWs || existing.workspaceRoot || state.workspaceRoot || ''),
        status: existing.status === 'idle' || existing.status === 'completed' ? 'running' : (existing.status || 'running'),
        orchestratorSession: Boolean(existing.orchestratorSession || isOrchestratorMode || /^TERMINAL_STEP_TYPE$/i.test(termStr)),
        pendingPlanHandoff: Boolean(existing.pendingPlanHandoff || /^TERMINAL_STEP_TYPE$/i.test(termStr)),
        inFlightTool: false,
        inFlightToolName: '',
        lastStopReason: termStr,
        fullyIdle: Boolean(fullyIdle),
        updatedAt: now,
      };
      state.chats = chatsMap;
      const visible = sweepAndBuildVisibleChats(chatsMap, state, cid, now, DEFAULT_COMPLETED_HOLD_MS, brainDirs, projName, cleanWs);
      return hydrateStateWithPrimary(state, visible, projName, cleanWs);
    }

    const nextStatus = isErr ? 'error' : 'completed';
    const nextPercent = isErr ? clampInt(existing.percent, 10, 99, 50) : 100;
    const nextStep = isErr ? clampInt(existing.currentStep, 1, totalSteps, 1) : totalSteps;
    const doneTitle = isErr ? (existing.stepTitle || 'Ошибка выполнения') : 'Готово';
    const baseSteps = Array.isArray(existing.steps) && existing.steps.length > 0
      ? existing.steps
      : buildDefaultStepsForGrade(existing.grade || 'M', false);
    const finalizedSteps = isErr
      ? syncStepsArray(baseSteps, nextStep, 'error')
      : baseSteps.map((s, idx) => ({ ...s, index: idx + 1, status: 'done' }));
    const rawPrevPct = Number(existing.highWaterPercent || 0) < 100
      ? Number(existing.highWaterPercent || 0)
      : (Number(existing.preStopPercent || 0) || Number(existing.percent || 0));
    const savedPreStopPct = isErr
      ? Number(existing.preStopPercent || 0)
      : clampInt(rawPrevPct < 100 ? rawPrevPct : 88, 16, MAX_RUNNING_PERCENT, 86);
    const savedPreStopStep = isErr
      ? Number(existing.preStopStep || 0)
      : clampInt(existing.highWaterStep || existing.currentStep || totalSteps, 1, totalSteps, totalSteps);

    chatsMap[cid] = {
      ...existing,
      transcriptPath: transcriptPath || existing.transcriptPath || '',
      workspaceRoot: sanitizeWorkspaceRoot(cleanWs || existing.workspaceRoot || state.workspaceRoot || ''),
      status: nextStatus,
      currentStep: nextStep,
      totalSteps,
      percent: nextPercent,
      highWaterStep: Math.max(existing.highWaterStep || 0, nextStep),
      highWaterPercent: Math.max(existing.highWaterPercent || 0, nextPercent),
      preStopPercent: savedPreStopPct,
      preStopStep: savedPreStopStep,
      pendingPlanHandoff: false,
      orchestratorSession: Boolean(existing.orchestratorSession || isOrchestratorMode),
      stepTitle: doneTitle,
      stageLabel: isErr ? `Этап ${nextStep} из ${totalSteps}` : 'Завершено',
      formattedText: buildFormattedProgressText({
        status: nextStatus,
        currentStep: nextStep,
        totalSteps,
        stepTitle: doneTitle,
      }),
      steps: finalizedSteps,
      hasRunningBackgroundTask: false,
      backgroundTasksCount: 0,
      backgroundTasks: stopTurnInfo?.exists
        ? normalizeBackgroundTasksList(stopTurnInfo.backgroundTasks, { forceFinishRunning: !isErr && !isCanceled })
        : normalizeBackgroundTasksList(existing.backgroundTasks, { forceFinishRunning: !isErr && !isCanceled }),
      backgroundTasksTotalCount: stopTurnInfo?.exists
        ? Math.max(Array.isArray(stopTurnInfo.backgroundTasks) ? stopTurnInfo.backgroundTasks.length : 0, Math.round(Number(stopTurnInfo.backgroundTasksTotalCount || 0)))
        : Math.max(0, Math.round(Number(existing.backgroundTasksTotalCount || 0))),
      bgInFlight: false,
      inFlightTool: false,
      inFlightToolName: '',
      lastStopReason: termStr,
      fullyIdle: Boolean(fullyIdle),
      completedAt: isErr ? 0 : (existing.completedAt || now),
      updatedAt: now,
    };

    state.chats = chatsMap;
    const visible = sweepAndBuildVisibleChats(chatsMap, state, cid, now, DEFAULT_COMPLETED_HOLD_MS, brainDirs, projName, cleanWs);
    return hydrateStateWithPrimary(state, visible, projName, cleanWs);
  });
}

/**
 * Dismisses stale or finished chat progress cards back to idle while recording
 * their current transcript stepKey so auto-discovery does not immediately resurrect them.
 * @param {object} [opts]
 * @param {string} [opts.conversationId=''] Optional single chat ID to dismiss; empty = dismiss all active/stale chats.
 * @param {string} [opts.workspaceRoot='']
 * @param {number} [opts.now=Date.now()]
 * @returns {object}
 */
export function dismissStaleChats({
  conversationId = '',
  workspaceRoot = '',
  now = Date.now(),
} = {}) {
  ensureCacheDir();
  const targetCid = conversationId ? normalizeConversationId(conversationId) : '';
  const resetIdleFields = (c, stepKey = '') => ({
    ...expireChatToIdle(c, stepKey || c.lastHandledStepKey || ''),
    percent: 0,
    currentStep: 0,
    stepTitle: 'Ожидание задачи',
    stepTitleEn: 'Waiting for task',
    stageLabel: 'Ожидание задачи',
    stageLabelEn: 'Waiting for task',
    formattedText: 'Ожидание задачи',
    formattedTextEn: 'Waiting for task',
    completedAt: 0,
    updatedAt: now,
  });

  updateJsonAtomicSync(getTaskProgressFile(), createDefaultProgressState, (raw) => {
    const state = raw && typeof raw === 'object' ? { ...createDefaultProgressState(), ...raw } : createDefaultProgressState();
    const chats = state.chats && typeof state.chats === 'object' ? { ...state.chats } : {};

    for (const [cid, rawChat] of Object.entries(chats)) {
      if (!rawChat || typeof rawChat !== 'object') continue;
      if (targetCid && cid !== targetCid && rawChat.parentConversationId !== targetCid) continue;
      if (!targetCid && !['running', 'waiting_user', 'completed', 'error'].includes(rawChat.status)) continue;
      const tPath = resolveTranscriptPathForChat(cid, rawChat.transcriptPath || '');
      const tInfo = tPath ? inspectTranscriptTurnState(tPath, now) : { exists: false };
      chats[cid] = resetIdleFields(rawChat, tInfo.stepKey || '');
    }

    state.chats = chats;
    if (!targetCid || normalizeConversationId(state.activeConversationId || '') === targetCid) {
      state.status = 'idle';
      state.currentStep = 0;
      state.percent = 0;
      state.inFlightTool = false;
      state.inFlightToolName = '';
      state.stepTitle = 'Ожидание задачи';
      state.stepTitleEn = 'Waiting for task';
      state.stageLabel = 'Ожидание задачи';
      state.stageLabelEn = 'Waiting for task';
      state.formattedText = 'Ожидание задачи';
      state.formattedTextEn = 'Waiting for task';
      state.activeChats = [];
      state.updatedAt = now;
    }
    return state;
  });

  return getTaskProgressSnapshot({ workspaceRoot, now });
}

/**
 * Resets task progress back to idle state.
 */
export function resetTaskProgress() {
  ensureCacheDir();
  const initial = createDefaultProgressState();
  atomicWriteJsonSync(getTaskProgressFile(), initial);
  return initial;
}

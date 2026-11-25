/**
 * @file session-handoff.mjs
 * @description Cross-Chat Auto-Handoff Memory. Preserves key goals and touched files across sessions
 * to eliminate redundant repo exploration at session start.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteJsonSync, safeReadJsonSync, updateJsonAtomicSync } from './safe-json.mjs';
import { redactSecretsInText } from './security-guard.mjs';
import { formatActiveSpecsForHandoff } from './reusable-blocks-specs.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, '..');
const CACHE_DIR = join(PLUGIN_ROOT, '.cache');
const MIRROR_FILE = join(CACHE_DIR, 'session-handoff.json');

const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days retention TTL
const MAX_GOALS = 4;
const MAX_FILES = 8;
const UNSAFE_WORKSPACE_NAMES = new Set(['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty']);
const EPHEMERAL_WS_SEGMENT_RE = /^(?:amr-|ag-local-rag-|antigravity-test-)/i;
const SYNTHETIC_TEST_CONVO_RE = /^(?:test-|chat-pre-modal-)/i;
const SYNTHETIC_TEST_PROMPTS = new Set([
  'можем ли мы добавить новый модуль в нескольких файлах и устранить утечку памяти?',
  'что такое http 404?',
  'отрефактори core/hook-runner.mjs и проверь unit-тесты',
  'давай сделаем явный переключатель',
  'verify cross-workspace handoff mirror helpers without referenceerror',
]);

/**
 * Detects OS temporary directories and synthetic test fixture workspaces so unit tests
 * never pollute real project handoff memory or active workspace discovery.
 * @param {string} [workspaceRoot='']
 * @returns {boolean}
 */
export function isEphemeralTestWorkspace(workspaceRoot = '') {
  if (!workspaceRoot || typeof workspaceRoot !== 'string') return false;
  const norm = workspaceRoot.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  if (!norm) return false;
  const sysTmp = String(tmpdir() || '').trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  if (sysTmp && (norm === sysTmp || norm.startsWith(`${sysTmp}/`))) {
    return true;
  }
  if (
    norm.includes('/appdata/local/temp/') ||
    norm.endsWith('/appdata/local/temp') ||
    norm === '/tmp' ||
    norm.startsWith('/tmp/') ||
    norm.startsWith('/private/tmp/') ||
    norm.includes('/var/folders/')
  ) {
    return true;
  }
  const base = basename(norm);
  if (EPHEMERAL_WS_SEGMENT_RE.test(base)) return true;
  return norm.split('/').some((seg) => EPHEMERAL_WS_SEGMENT_RE.test(seg));
}

function isSyntheticTestConvoId(conversationId = '') {
  if (!conversationId || typeof conversationId !== 'string') return false;
  return SYNTHETIC_TEST_CONVO_RE.test(conversationId.trim());
}

function prioritizeVerifiedTouchedFiles(list = []) {
  if (!Array.isArray(list) || list.length === 0) return [];
  const verified = [];
  const failed = [];
  for (const item of list) {
    if (!item) continue;
    if (item.ok === false) failed.push(item);
    else verified.push(item);
  }
  return [...verified, ...failed];
}

export function resolveValidWorkspaceDir(workspaceRoot = '') {
  if (!workspaceRoot || typeof workspaceRoot !== 'string') return '';
  const trimmed = workspaceRoot.trim();
  if (
    !trimmed ||
    trimmed.startsWith('-') ||
    basename(trimmed).startsWith('-') ||
    trimmed.includes('\0') ||
    UNSAFE_WORKSPACE_NAMES.has(trimmed) ||
    UNSAFE_WORKSPACE_NAMES.has(basename(trimmed))
  ) {
    return '';
  }
  try {
    return existsSync(trimmed) ? trimmed : '';
  } catch {
    return '';
  }
}

/**
 * Ensures cache directory exists.
 */
function ensureCacheDir() {
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true });
  }
}

/**
 * Determines target persistence path for handoff state.
 * @param {string} [workspaceRoot='']
 * @returns {string}
 */
function getStoragePath(workspaceRoot = '', { createDir = true } = {}) {
  const validWs = resolveValidWorkspaceDir(workspaceRoot);
  if (validWs) {
    try {
      const agentsDir = join(validWs, '.agents');
      if (createDir && !existsSync(agentsDir)) {
        mkdirSync(agentsDir, { recursive: true });
      }
      return join(agentsDir, 'session-handoff.json');
    } catch {}
  }
  if (createDir) ensureCacheDir();
  return MIRROR_FILE;
}

/**
 * Creates default initial state.
 * @returns {{ version: number, lastConvoId: string, lastDomain: string, updatedAt: string|null, recentGoals: Array<string>, touchedFiles: Array<object>, rationales: Array<object> }}
 */
function createInitialState() {
  return {
    version: 1,
    workspaceRoot: '',
    lastConvoId: '',
    lastDomain: 'general',
    updatedAt: null,
    recentGoals: [],
    touchedFiles: [],
    rationales: [],
    pinnedDecisions: []
  };
}

/**
 * Normalizes file path to relative or base name with POSIX slashes.
 * @param {string} filePath
 * @param {string} [workspaceRoot='']
 * @returns {string}
 */
function normalizeDisplayPath(filePath, workspaceRoot = '') {
  if (!filePath) return '';
  if (workspaceRoot) {
    try {
      const rel = relative(workspaceRoot, filePath).replace(/\\/g, '/');
      if (!rel.startsWith('..') && !isAbsolute(rel)) {
        return rel;
      }
    } catch {}
  }
  return basename(filePath);
}

function isLiveNonEphemeralWorkspace(wsPath = '') {
  if (!wsPath || typeof wsPath !== 'string') return false;
  if (isEphemeralTestWorkspace(wsPath)) return false;
  return Boolean(resolveValidWorkspaceDir(wsPath));
}

function readWorkspaceMirrorFallback(normWs = '') {
  if (!existsSync(MIRROR_FILE)) return null;
  const mirror = safeReadJsonSync(MIRROR_FILE, createInitialState);
  if (!mirror || typeof mirror !== 'object') return null;
  const queryingEphemeral = Boolean(normWs && isEphemeralTestWorkspace(normWs));

  if (normWs && mirror.workspaces && typeof mirror.workspaces === 'object' && Object.hasOwn(mirror.workspaces, normWs)) {
    const entry = mirror.workspaces[normWs];
    if (!queryingEphemeral && isEphemeralTestWorkspace(entry?.workspaceRoot || normWs)) {
      return null;
    }
    return entry;
  }
  if (normWs) {
    if (mirror.workspaceRoot === normWs) {
      if (!queryingEphemeral && isEphemeralTestWorkspace(mirror.workspaceRoot)) return null;
      return mirror;
    }
    return null;
  }
  if (isLiveNonEphemeralWorkspace(mirror.workspaceRoot)) {
    return mirror;
  }
  if (mirror.workspaces && typeof mirror.workspaces === 'object') {
    const realCandidates = Object.values(mirror.workspaces)
      .filter((w) => w && typeof w === 'object' && isLiveNonEphemeralWorkspace(w.workspaceRoot))
      .sort((a, b) => Date.parse(b?.updatedAt || '') - Date.parse(a?.updatedAt || ''));
    if (realCandidates.length > 0) return realCandidates[0];
  }
  return null;
}

function syncWorkspaceToMirror(normWs = '', updatedState = {}) {
  const wsKey = normWs || 'default';
  const cleanEntry = { ...updatedState };
  delete cleanEntry.workspaces;
  const isTempOrTestRun =
    isEphemeralTestWorkspace(normWs) ||
    isEphemeralTestWorkspace(cleanEntry.workspaceRoot || '') ||
    isSyntheticTestConvoId(cleanEntry.lastConvoId) ||
    Boolean(process.env.NODE_TEST_CONTEXT && isEphemeralTestWorkspace(normWs));

  updateJsonAtomicSync(MIRROR_FILE, createInitialState, (cur) => {
    const prevMap = cur && cur.workspaces && typeof cur.workspaces === 'object' && !Array.isArray(cur.workspaces)
      ? { ...cur.workspaces }
      : {};

    // Prune dead ephemeral test workspaces from earlier runs while preserving active lookup key
    for (const k of Object.keys(prevMap)) {
      if (k !== wsKey && isEphemeralTestWorkspace(k) && !existsSync(k)) {
        delete prevMap[k];
      }
    }

    prevMap[wsKey] = cleanEntry;
    const keys = Object.keys(prevMap);
    if (keys.length > 16) {
      keys.sort((a, b) => {
        const aReal = isLiveNonEphemeralWorkspace(prevMap[a]?.workspaceRoot || a) ? 1 : 0;
        const bReal = isLiveNonEphemeralWorkspace(prevMap[b]?.workspaceRoot || b) ? 1 : 0;
        if (bReal !== aReal) return bReal - aReal;
        return Date.parse(prevMap[b]?.updatedAt || '') - Date.parse(prevMap[a]?.updatedAt || '');
      });
      for (let i = 16; i < keys.length; i++) {
        if (keys[i] !== wsKey) delete prevMap[keys[i]];
      }
    }

    if (!isTempOrTestRun) {
      return {
        ...cleanEntry,
        workspaces: prevMap,
      };
    }

    // Never overwrite top-level mirror fields with ephemeral/test entries
    if (cur && isLiveNonEphemeralWorkspace(cur.workspaceRoot) && !isSyntheticTestConvoId(cur.lastConvoId)) {
      const preservedTop = { ...cur };
      delete preservedTop.workspaces;
      return {
        ...preservedTop,
        workspaces: prevMap,
      };
    }

    const bestReal = Object.values(prevMap)
      .filter((w) => w && typeof w === 'object' && isLiveNonEphemeralWorkspace(w.workspaceRoot) && !isSyntheticTestConvoId(w.lastConvoId))
      .sort((a, b) => Date.parse(b?.updatedAt || '') - Date.parse(a?.updatedAt || ''))[0];

    if (bestReal) {
      return {
        ...bestReal,
        workspaces: prevMap,
      };
    }

    return {
      ...createInitialState(),
      workspaces: prevMap,
    };
  });
}

/**
 * Records user prompt goal in cross-chat handoff memory.
 *
 * @param {object} params
 * @param {string} [params.workspaceRoot=''] Workspace root directory
 * @param {string} [params.conversationId=''] Conversation ID
 * @param {string} [params.userPrompt=''] User prompt text
 * @param {string} [params.domain='general'] Target domain
 * @returns {object|undefined}
 */
export function recordHandoffGoal(opts = {}) {
  const {
    workspaceRoot = '',
    conversationId = '',
    userPrompt = '',
    domain = 'general'
  } = opts && typeof opts === 'object' ? opts : {};
  if (!userPrompt || typeof userPrompt !== 'string' || userPrompt.trim().length < 10) {
    return;
  }

  // Prevent unit test runner or synthetic test conversation IDs from polluting real workspaces
  if (
    !isEphemeralTestWorkspace(workspaceRoot) &&
    (Boolean(process.env.NODE_TEST_CONTEXT) || isSyntheticTestConvoId(conversationId))
  ) {
    return getSessionHandoff(workspaceRoot, { createDir: false });
  }

  let cleanPrompt = userPrompt
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (cleanPrompt.length > 140) {
    cleanPrompt = `${cleanPrompt.slice(0, 137)}...`;
  }

  const primaryPath = getStoragePath(workspaceRoot);
  const normWs = workspaceRoot ? workspaceRoot.replace(/\\/g, '/').toLowerCase() : '';
  ensureCacheDir();

  const updater = (current) => {
    let state = current && typeof current === 'object' ? current : createInitialState();
    if ((!state.recentGoals || state.recentGoals.length === 0) && primaryPath !== MIRROR_FILE) {
      const mirror = readWorkspaceMirrorFallback(normWs);
      if (mirror?.recentGoals?.length > 0) {
        state = { ...mirror, ...state };
      }
    }

    let goals = Array.isArray(state.recentGoals) ? state.recentGoals : [];
    // Deduplicate case-insensitively
    goals = goals.filter((g) => String(g).trim().toLowerCase() !== cleanPrompt.toLowerCase());
    goals.unshift(cleanPrompt);

    if (goals.length > MAX_GOALS) {
      goals = goals.slice(0, MAX_GOALS);
    }

    const now = new Date().toISOString();
    return {
      version: 1,
      workspaceRoot: normWs || state.workspaceRoot || '',
      lastConvoId: conversationId || state.lastConvoId || '',
      lastDomain: domain || state.lastDomain || 'general',
      updatedAt: now,
      recentGoals: goals,
      touchedFiles: Array.isArray(state.touchedFiles) ? state.touchedFiles : [],
      rationales: Array.isArray(state.rationales) ? state.rationales : [],
      pinnedDecisions: Array.isArray(state.pinnedDecisions) ? state.pinnedDecisions : []
    };
  };

  const updatedState = updateJsonAtomicSync(primaryPath, createInitialState, updater);

  if (primaryPath !== MIRROR_FILE) {
    syncWorkspaceToMirror(normWs, updatedState);
  }

  return updatedState;
}

/**
 * Records tool file modification action in cross-chat handoff memory.
 *
 * @param {object} params
 * @param {string} [params.workspaceRoot=''] Workspace root directory
 * @param {string} [params.conversationId=''] Conversation ID
 * @param {string} [params.toolName='edit_file'] Name of tool used
 * @param {string} [params.filePath=''] Modified file path
 * @param {boolean} [params.verifyOk=true] Verification status
 * @returns {object|undefined}
 */
export function recordHandoffAction(rawOpts = {}) {
  const {
    workspaceRoot = '',
    conversationId = '',
    toolName = 'edit_file',
    filePath = '',
    verifyOk = true,
    rationale = '',
    rejectedApproach = '',
    rationaleOnly = false
  } = rawOpts && typeof rawOpts === 'object' ? rawOpts : {};
  if (!filePath || typeof filePath !== 'string') return;
  if (
    !isEphemeralTestWorkspace(workspaceRoot) &&
    (Boolean(process.env.NODE_TEST_CONTEXT) || isSyntheticTestConvoId(conversationId))
  ) {
    return getSessionHandoff(workspaceRoot, { createDir: false });
  }
  const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype', 'toString', 'valueOf']);
  if (UNSAFE_KEYS.has(filePath.trim())) return;

  const normSlash = filePath.replace(/\\/g, '/').toLowerCase();
  if (
    normSlash.includes('/.cache/') ||
    normSlash.includes('/.system_generated/') ||
    /\/\.gemini\/antigravity(?:-ide|-cli)?\/brain\//i.test(normSlash)
  ) {
    return;
  }

  const relOrBasePath = normalizeDisplayPath(filePath, workspaceRoot);
  if (UNSAFE_KEYS.has(relOrBasePath.trim())) return;
  const primaryPath = getStoragePath(workspaceRoot);
  const normWs = workspaceRoot ? workspaceRoot.replace(/\\/g, '/').toLowerCase() : '';
  ensureCacheDir();

  const updater = (current) => {
    let state = current && typeof current === 'object' ? current : createInitialState();
    if ((!state.touchedFiles || state.touchedFiles.length === 0) && primaryPath !== MIRROR_FILE) {
      const mirror = readWorkspaceMirrorFallback(normWs);
      if (mirror?.touchedFiles?.length > 0 || mirror?.rationales?.length > 0) {
        state = { ...mirror, ...state };
      }
    }

    let touched = Array.isArray(state.touchedFiles) ? state.touchedFiles : [];
    const normKey = relOrBasePath.toLowerCase();
    const now = new Date().toISOString();

    if (!rationaleOnly) {
      touched = touched.filter((item) => item && String(item.file).toLowerCase() !== normKey);
      touched.unshift({
        file: relOrBasePath,
        tool: String(toolName || 'edit_file'),
        ok: Boolean(verifyOk),
        ts: now
      });

      if (touched.length > MAX_FILES) {
        touched = touched.slice(0, MAX_FILES);
      }
    }

    let rationales = Array.isArray(state.rationales) ? state.rationales : [];
    const cleanRationale = typeof rationale === 'string' ? rationale.trim().slice(0, 120) : String(rationale || '').trim().slice(0, 120);
    const cleanRejected = typeof rejectedApproach === 'string' ? rejectedApproach.trim().slice(0, 100) : String(rejectedApproach || '').trim().slice(0, 100);

    if (cleanRationale || cleanRejected) {
      rationales = rationales.filter((r) => r && String(r.file).toLowerCase() !== normKey);
      rationales.unshift({
        file: relOrBasePath,
        rationale: cleanRationale,
        rejected: cleanRejected,
        ts: now
      });
      if (rationales.length > 4) {
        rationales = rationales.slice(0, 4);
      }
    }

    return {
      version: 1,
      workspaceRoot: normWs || state.workspaceRoot || '',
      lastConvoId: conversationId || state.lastConvoId || '',
      lastDomain: state.lastDomain || 'general',
      updatedAt: now,
      recentGoals: Array.isArray(state.recentGoals) ? state.recentGoals : [],
      touchedFiles: touched,
      rationales,
      pinnedDecisions: Array.isArray(state.pinnedDecisions) ? state.pinnedDecisions : []
    };
  };

  const updatedState = updateJsonAtomicSync(primaryPath, createInitialState, updater);

  if (primaryPath !== MIRROR_FILE) {
    syncWorkspaceToMirror(normWs, updatedState);
  }

  return updatedState;
}

/**
 * Records architectural rationale or rejected dead-end approach for process memory.
 *
 * @param {object} params
 * @param {string} [params.workspaceRoot=''] Workspace root directory
 * @param {string} [params.filePath=''] Target file path or topic
 * @param {string} [params.rationale=''] Why this approach was chosen
 * @param {string} [params.rejectedApproach=''] Why previous approach was rejected
 * @returns {object|undefined}
 */
export function recordHandoffRationale(rawOpts = {}) {
  const {
    workspaceRoot = '',
    filePath = '',
    rationale = '',
    rejectedApproach = ''
  } = (rawOpts && typeof rawOpts === 'object' ? rawOpts : {});
  const targetPath = filePath || 'architecture';
  return recordHandoffAction({
    workspaceRoot,
    filePath: targetPath,
    rationale,
    rejectedApproach,
    rationaleOnly: !filePath
  });
}

/**
 * Records a user decision in cross-chat handoff memory and project passport.
 *
 * @param {object} params
 * @param {string} [params.workspaceRoot=''] Workspace root directory
 * @param {string} [params.conversationId=''] Conversation ID
 * @param {string} [params.question=''] Decision question / prompt
 * @param {string} [params.answer=''] User selected decision / answer
 * @param {string} [params.category='general'] Decision category
 * @returns {object|undefined}
 */
export function recordUserDecision(rawOpts = {}) {
  const {
    workspaceRoot = '',
    conversationId = '',
    question = '',
    answer = '',
    category = 'general'
  } = (rawOpts && typeof rawOpts === 'object' ? rawOpts : {});
  const cleanQ = redactSecretsInText(typeof question === 'string' ? question.trim() : '');
  const cleanA = redactSecretsInText(typeof answer === 'string' ? answer.trim() : '');
  if (!cleanQ || !cleanA) return undefined;

  const cleanCat = typeof category === 'string' && category.trim() ? category.trim() : 'general';
  const now = new Date().toISOString();
  const decisionItem = {
    category: cleanCat,
    question: cleanQ.length > 140 ? `${cleanQ.slice(0, 137)}...` : cleanQ,
    answer: cleanA.length > 140 ? `${cleanA.slice(0, 137)}...` : cleanA,
    ts: now
  };

  const normQ = cleanQ.toLowerCase();
  const primaryPath = getStoragePath(workspaceRoot);
  const normWs = workspaceRoot ? workspaceRoot.replace(/\\/g, '/').toLowerCase() : '';
  ensureCacheDir();

  const updater = (current) => {
    let state = current && typeof current === 'object' ? current : createInitialState();
    let decisions = Array.isArray(state.pinnedDecisions) ? state.pinnedDecisions : [];
    decisions = decisions.filter((d) => d && String(d.question || '').trim().toLowerCase() !== normQ);
    decisions.unshift(decisionItem);
    if (decisions.length > 6) {
      decisions = decisions.slice(0, 6);
    }

    return {
      version: 1,
      workspaceRoot: normWs || state.workspaceRoot || '',
      lastConvoId: conversationId || state.lastConvoId || '',
      lastDomain: state.lastDomain || 'general',
      updatedAt: now,
      recentGoals: Array.isArray(state.recentGoals) ? state.recentGoals : [],
      touchedFiles: Array.isArray(state.touchedFiles) ? state.touchedFiles : [],
      rationales: Array.isArray(state.rationales) ? state.rationales : [],
      pinnedDecisions: decisions
    };
  };

  const updatedState = updateJsonAtomicSync(primaryPath, createInitialState, updater);
  if (primaryPath !== MIRROR_FILE) {
    syncWorkspaceToMirror(normWs, updatedState);
  }

  // Also store in project-passport.json (decisions array so decisions persist across sessions)
  try {
    const passportPath = getPassportPath(workspaceRoot);
    const seedPassport = getOrBuildProjectPassport(workspaceRoot);
    updateJsonAtomicSync(
      passportPath,
      () => seedPassport || { version: 1, decisions: [], updatedAt: now },
      (curRaw) => {
        const passport = (curRaw && typeof curRaw === 'object') ? { ...curRaw } : { ...(seedPassport || { version: 1 }) };
        let passportDecisions = Array.isArray(passport.decisions) ? [...passport.decisions] : [];
        passportDecisions = passportDecisions.filter((d) => d && String(d.question || '').trim().toLowerCase() !== normQ);
        passportDecisions.unshift(decisionItem);
        if (passportDecisions.length > 6) {
          passportDecisions = passportDecisions.slice(0, 6);
        }
        passport.decisions = passportDecisions;
        passport.updatedAt = now;
        return passport;
      }
    );
  } catch {}

  return updatedState;
}

/**
 * Retrieves pinned user decisions from handoff state or project passport.
 * @param {string} [workspaceRoot='']
 * @returns {Array<object>}
 */
export function getPinnedDecisions(workspaceRoot = '') {
  const state = getSessionHandoff(workspaceRoot);
  if (Array.isArray(state?.pinnedDecisions) && state.pinnedDecisions.length > 0) {
    return state.pinnedDecisions;
  }
  const passport = getOrBuildProjectPassport(workspaceRoot);
  if (Array.isArray(passport?.decisions) && passport.decisions.length > 0) {
    return passport.decisions;
  }
  return [];
}

/**
 * Loads current handoff state with fallback to mirror and TTL check.
 * @param {string} [workspaceRoot='']
 * @returns {{ version: number, lastConvoId: string, lastDomain: string, updatedAt: string|null, recentGoals: Array<string>, touchedFiles: Array<object> }}
 */
export function getSessionHandoff(workspaceRoot = '', { createDir = true } = {}) {
  const isEphemeral = isEphemeralTestWorkspace(workspaceRoot);
  if (workspaceRoot && !isEphemeral && !resolveValidWorkspaceDir(workspaceRoot)) {
    return createInitialState();
  }

  const primaryPath = getStoragePath(workspaceRoot, { createDir });
  const normWs = workspaceRoot ? workspaceRoot.replace(/\\/g, '/').toLowerCase() : '';
  let state = safeReadJsonSync(primaryPath, createInitialState);

  if (
    !isEphemeral &&
    primaryPath === MIRROR_FILE &&
    state?.workspaceRoot &&
    (isEphemeralTestWorkspace(state.workspaceRoot) || !resolveValidWorkspaceDir(state.workspaceRoot))
  ) {
    state = readWorkspaceMirrorFallback(normWs) || createInitialState();
  }

  const hasContent = state && (
    (Array.isArray(state.recentGoals) && state.recentGoals.length > 0) ||
    (Array.isArray(state.touchedFiles) && state.touchedFiles.length > 0) ||
    (Array.isArray(state.rationales) && state.rationales.length > 0) ||
    (Array.isArray(state.pinnedDecisions) && state.pinnedDecisions.length > 0)
  );

  if (!hasContent && primaryPath !== MIRROR_FILE) {
    const mirrorState = readWorkspaceMirrorFallback(normWs);
    if (
      mirrorState &&
      ((Array.isArray(mirrorState.recentGoals) && mirrorState.recentGoals.length > 0) ||
        (Array.isArray(mirrorState.touchedFiles) && mirrorState.touchedFiles.length > 0) ||
        (Array.isArray(mirrorState.rationales) && mirrorState.rationales.length > 0) ||
        (Array.isArray(mirrorState.pinnedDecisions) && mirrorState.pinnedDecisions.length > 0))
    ) {
      state = mirrorState;
    }
  }

  if (
    !isEphemeral &&
    state?.workspaceRoot &&
    (isEphemeralTestWorkspace(state.workspaceRoot) || !resolveValidWorkspaceDir(state.workspaceRoot))
  ) {
    return createInitialState();
  }

  if (state?.updatedAt) {
    const age = Date.now() - new Date(state.updatedAt).getTime();
    if (age > TTL_MS) {
      return createInitialState();
    }
  }

  const syntheticConvo = !isEphemeral && isSyntheticTestConvoId(state?.lastConvoId);
  let recentGoals = Array.isArray(state?.recentGoals) ? state.recentGoals : [];
  if (!isEphemeral) {
    recentGoals = syntheticConvo
      ? []
      : recentGoals.filter((g) => {
          const normGoal = String(g || '').trim().toLowerCase();
          return normGoal && !SYNTHETIC_TEST_PROMPTS.has(normGoal);
        });
  }

  const touchedFiles = prioritizeVerifiedTouchedFiles(state?.touchedFiles);

  return {
    version: 1,
    lastConvoId: syntheticConvo ? '' : (state?.lastConvoId || ''),
    lastDomain: state?.lastDomain || 'general',
    updatedAt: state?.updatedAt || null,
    recentGoals,
    touchedFiles,
    rationales: Array.isArray(state?.rationales) ? state.rationales : [],
    pinnedDecisions: Array.isArray(state?.pinnedDecisions) ? state.pinnedDecisions : []
  };
}

/**
 * Determines target persistence path for project passport.
 * Path: <workspaceRoot>/.agents/project-passport.json (fallback .cache/project-passport.json).
 * @param {string} [workspaceRoot='']
 * @returns {string}
 */
function getPassportPath(workspaceRoot = '', { createDir = true } = {}) {
  const validWs = resolveValidWorkspaceDir(workspaceRoot);
  if (validWs) {
    try {
      const agentsDir = join(validWs, '.agents');
      if (createDir && !existsSync(agentsDir)) {
        mkdirSync(agentsDir, { recursive: true });
      }
      return join(agentsDir, 'project-passport.json');
    } catch {}
  }
  if (createDir) ensureCacheDir();
  return join(CACHE_DIR, 'project-passport.json');
}

/**
 * Auto-detects project stack and metadata from workspace root files.
 * @param {string} targetDir
 * @returns {{ detected: boolean, name: string, stack: string, entrypoints: string[], invariants: string[] }}
 */
function detectProjectPassport(targetDir) {
  let name = '';
  let stack = '';
  const entrypoints = [];
  const invariants = [];
  let detected = false;

  const pluginPath = join(targetDir, 'plugin.json');
  const pkgPath = join(targetDir, 'package.json');
  const pyPath = join(targetDir, 'pyproject.toml');
  const cargoPath = join(targetDir, 'Cargo.toml');
  const goPath = join(targetDir, 'go.mod');

  if (existsSync(pluginPath)) {
    detected = true;
    try {
      const raw = readFileSync(pluginPath, 'utf8');
      const parsed = JSON.parse(raw);
      name = parsed.name || basename(targetDir);
      stack = 'Node.js ESM / Antigravity Plugin';
    } catch {
      name = basename(targetDir);
      stack = 'Node.js ESM / Antigravity Plugin';
    }
    const candidates = ['core/hook-runner.mjs', 'sidecars/panel/server.mjs', 'install.js'];
    for (const c of candidates) {
      if (existsSync(join(targetDir, c))) {
        entrypoints.push(c);
      }
    }
    invariants.push(
      'Diff-Only: edit_file for >50L',
      'User-Facing: 100% Russian language',
      'Internal: compact English notation'
    );
  } else if (existsSync(pkgPath)) {
    detected = true;
    try {
      const parsed = JSON.parse(readFileSync(pkgPath, 'utf8'));
      name = parsed.name || basename(targetDir);
      const isEsm = parsed.type === 'module';
      const deps = { ...(parsed.dependencies || {}), ...(parsed.devDependencies || {}) };
      if (deps.next || deps.react) {
        stack = isEsm ? 'Next.js / React (ESM)' : 'Next.js / React';
      } else if (deps.vue) {
        stack = 'Vue.js';
      } else {
        stack = isEsm ? 'Node.js ESM' : 'Node.js CommonJS';
      }
      if (parsed.main && existsSync(join(targetDir, parsed.main))) entrypoints.push(parsed.main);
      if (parsed.module && existsSync(join(targetDir, parsed.module))) entrypoints.push(parsed.module);
      if (parsed.bin) {
        if (typeof parsed.bin === 'string') entrypoints.push(parsed.bin);
        else if (typeof parsed.bin === 'object') entrypoints.push(...Object.values(parsed.bin).slice(0, 2));
      }
    } catch {
      name = basename(targetDir);
      stack = 'Node.js';
    }
  } else if (existsSync(pyPath)) {
    detected = true;
    name = basename(targetDir);
    stack = 'Python / pyproject';
    if (existsSync(join(targetDir, 'main.py'))) entrypoints.push('main.py');
  } else if (existsSync(cargoPath)) {
    detected = true;
    name = basename(targetDir);
    stack = 'Rust / Cargo';
    if (existsSync(join(targetDir, 'src/main.rs'))) entrypoints.push('src/main.rs');
    else if (existsSync(join(targetDir, 'src/lib.rs'))) entrypoints.push('src/lib.rs');
  } else if (existsSync(goPath)) {
    detected = true;
    name = basename(targetDir);
    stack = 'Go Module';
    if (existsSync(join(targetDir, 'main.go'))) entrypoints.push('main.go');
  }

  return {
    detected,
    name,
    stack,
    entrypoints: entrypoints.slice(0, 5),
    invariants: invariants.slice(0, 5)
  };
}

/**
 * Loads or builds persistent project passport (Memory Bank Lite) that never expires by TTL.
 * @param {string} [workspaceRoot='']
 * @returns {{ version: number, name: string, stack: string, entrypoints: string[], invariants: string[], updatedAt: string|null }}
 */
export function getOrBuildProjectPassport(workspaceRoot = '', { createDir = true } = {}) {
  const passportPath = getPassportPath(workspaceRoot, { createDir });
  const existing = safeReadJsonSync(passportPath, null);
  if (existing && existing.stack) {
    if (!Array.isArray(existing.decisions)) {
      existing.decisions = [];
    }
    return existing;
  }

  const validWs = resolveValidWorkspaceDir(workspaceRoot);
  const targetDir = validWs || (!workspaceRoot ? process.cwd() : '');
  if (!targetDir) {
    return {
      version: 1,
      name: '',
      stack: '',
      entrypoints: [],
      invariants: [],
      decisions: [],
      updatedAt: new Date().toISOString()
    };
  }
  const detection = detectProjectPassport(targetDir);

  if (!detection.detected) {
    return {
      version: 1,
      name: '',
      stack: '',
      entrypoints: [],
      invariants: [],
      decisions: Array.isArray(existing?.decisions) ? existing.decisions : [],
      updatedAt: new Date().toISOString()
    };
  }

  if (!createDir) {
    return {
      version: 1,
      name: detection.name || basename(targetDir),
      stack: detection.stack || '',
      entrypoints: detection.entrypoints || [],
      invariants: detection.invariants || [],
      decisions: Array.isArray(existing?.decisions) ? existing.decisions : [],
      updatedAt: new Date().toISOString()
    };
  }

  ensureCacheDir();
  return updateJsonAtomicSync(passportPath, () => null, (cur) => {
    if (cur && cur.stack) {
      if (!Array.isArray(cur.decisions)) cur.decisions = [];
      return cur;
    }
    return {
      version: 1,
      name: detection.name || basename(targetDir),
      stack: detection.stack || '',
      entrypoints: detection.entrypoints || [],
      invariants: detection.invariants || [],
      decisions: Array.isArray(cur?.decisions) ? cur.decisions : [],
      updatedAt: new Date().toISOString()
    };
  });
}

/**
 * Updates project passport with merged stack, entrypoints and invariants.
 * @param {{ workspaceRoot?: string, stack?: string, entrypoints?: string[], invariants?: string[] }} [options={}]
 * @returns {object} Updated passport object
 */
export function updateProjectPassport({ workspaceRoot = '', stack = '', entrypoints = [], invariants = [] } = {}) {
  const passportPath = getPassportPath(workspaceRoot);
  const preRead = safeReadJsonSync(passportPath, null);
  const targetDir = workspaceRoot || process.cwd();
  const fallbackDetect = (!preRead || !preRead.stack) ? detectProjectPassport(targetDir) : null;

  ensureCacheDir();
  return updateJsonAtomicSync(passportPath, () => null, (curRaw) => {
    const current = (curRaw && typeof curRaw === 'object') ? curRaw : {
      version: 1,
      name: fallbackDetect?.name || (fallbackDetect?.detected ? basename(targetDir) : ''),
      stack: fallbackDetect?.stack || '',
      entrypoints: fallbackDetect?.entrypoints || [],
      invariants: fallbackDetect?.invariants || [],
      decisions: []
    };

    const mergedEntrypoints = Array.isArray(entrypoints) && entrypoints.length > 0
      ? Array.from(new Set([...(current.entrypoints || []), ...entrypoints])).slice(0, 5)
      : (current.entrypoints || []).slice(0, 5);

    const mergedInvariants = Array.isArray(invariants) && invariants.length > 0
      ? Array.from(new Set([...(current.invariants || []), ...invariants])).slice(0, 5)
      : (current.invariants || []).slice(0, 5);

    return {
      version: current.version || 1,
      name: current.name || '',
      stack: stack ? String(stack).trim() : (current.stack || ''),
      entrypoints: mergedEntrypoints,
      invariants: mergedInvariants,
      decisions: Array.isArray(current.decisions) ? current.decisions : [],
      updatedAt: new Date().toISOString()
    };
  });
}

function truncateCleanly(text = '', maxLen = 140) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  const cap = Math.max(16, Number(maxLen) || 140);
  if (raw.length <= cap) return raw;
  const slice = raw.slice(0, cap - 3);
  const lastBreak = Math.max(slice.lastIndexOf(' '), slice.lastIndexOf(','), slice.lastIndexOf(';'));
  let head = (lastBreak > Math.floor(cap * 0.5) ? slice.slice(0, lastBreak) : slice).trim();
  const openBrackets = (head.match(/\[/g) || []).length;
  const closeBrackets = (head.match(/\]/g) || []).length;
  if (openBrackets > closeBrackets) {
    head = `${head}...]`;
    return head;
  }
  return `${head}...`;
}

/**
 * Formats cross-chat handoff memory for SessionStart prompt injection.
 * Returns empty string if no relevant state exists or if expired.
 * Frozen Prefix Law: omits volatile millisecond timestamps so KV prefix stays immutable.
 *
 * @param {string} [workspaceRoot='']
 * @param {string} [currentConversationId='']
 * @returns {string} Compact markdown string (<=760 chars) or empty string
 */
export function formatHandoffForSessionStart(workspaceRoot = '', currentConversationId = '') {
  if (workspaceRoot) {
    const validWs = resolveValidWorkspaceDir(workspaceRoot);
    if (!validWs) return '';
    const wsHandoffPath = join(validWs, '.agents', 'session-handoff.json');
    const wsHasLocalState = existsSync(wsHandoffPath);
    const detection = detectProjectPassport(validWs);
    if (!wsHasLocalState && !detection.detected) {
      return '';
    }
  }

  const state = getSessionHandoff(workspaceRoot, { createDir: false });
  const passport = getOrBuildProjectPassport(workspaceRoot, { createDir: false });

  const goals = Array.isArray(state?.recentGoals) ? state.recentGoals : [];
  const files = Array.isArray(state?.touchedFiles) ? state.touchedFiles : [];
  const rationales = Array.isArray(state?.rationales) ? state.rationales : [];
  const decisions = Array.isArray(state?.pinnedDecisions) && state.pinnedDecisions.length > 0
    ? state.pinnedDecisions
    : (Array.isArray(passport?.decisions) ? passport.decisions : []);

  const hasHandoffState = (goals.length > 0 || files.length > 0 || rationales.length > 0 || decisions.length > 0);
  const hasPassport = Boolean(passport && (passport.stack || (Array.isArray(passport.invariants) && passport.invariants.length > 0)));

  if (!hasHandoffState && !hasPassport) {
    return '';
  }

  if (state?.updatedAt && !hasPassport) {
    const age = Date.now() - new Date(state.updatedAt).getTime();
    if (age > TTL_MS) {
      return '';
    }
  }

  const lines = [
    '## Auto-Handoff (Previous Chat State):'
  ];

  if (state?.lastDomain) {
    lines.push(`- Domain: ${state.lastDomain}`);
  }

  if (hasPassport) {
    lines.push(`- Project Passport: ${passport.stack}${passport.entrypoints?.length ? ' | Entry: ' + passport.entrypoints.slice(0, 2).map((p) => normalizeDisplayPath(p, workspaceRoot)).join(', ') : ''}${passport.invariants?.length ? ' | Invariants: ' + passport.invariants.slice(0, 2).join('; ') : ''}`);
  }

  if (goals.length > 0) {
    const goalsPreview = goals.slice(0, 2).map((g) => truncateCleanly(g, 110)).join('; ');
    lines.push(`- Recent tasks: ${goalsPreview}`);
  }

  if (decisions.length > 0) {
    const decPreview = decisions
      .slice(0, 3)
      .map((d) => `"${truncateCleanly(d.question, 60)}" -> ${truncateCleanly(d.answer, 60)}`)
      .join('; ');
    if (decPreview) {
      lines.push(`- Pinned Decisions: ${decPreview}`);
    }
  }

  if (files.length > 0) {
    const filesPreview = files
      .slice(0, 4)
      .map((f) => `\`${normalizeDisplayPath(f.file, workspaceRoot)}\` (${f.ok ? 'OK' : 'ERR'})`)
      .join(', ');
    lines.push(`- Touched files: ${filesPreview}`);
  }

  if (rationales.length > 0) {
    const ratPreview = rationales
      .slice(0, 2)
      .map((r) => {
        const filePart = r.file ? `\`${normalizeDisplayPath(r.file, workspaceRoot)}\`: ` : '';
        const rationalePart = r.rationale ? truncateCleanly(r.rationale, 80) : '';
        const rejectedPart = r.rejected ? ` [avoid: ${truncateCleanly(r.rejected, 60)}]` : '';
        return `${filePart}${rationalePart}${rejectedPart}`.trim();
      })
      .filter(Boolean)
      .join('; ');
    if (ratPreview) {
      lines.push(`- Process Rationale (Why / Dead-ends): ${ratPreview}`);
    }
  }

  try {
    const activeSpecsLine = formatActiveSpecsForHandoff(workspaceRoot);
    if (activeSpecsLine) {
      lines.push(activeSpecsLine);
    }
  } catch {}

  lines.push('Resume seamlessly from this state without redundant repo exploration.');

  let text = lines.join('\n');
  if (text.length > 760) {
    text = truncateCleanly(text, 760);
  }

  return text;
}

/**
 * Clears cross-chat handoff memory state.
 * @param {string} [workspaceRoot='']
 */
export function clearSessionHandoff(workspaceRoot = '') {
  const primaryPath = getStoragePath(workspaceRoot);
  const normWs = workspaceRoot ? workspaceRoot.replace(/\\/g, '/').toLowerCase() : '';
  ensureCacheDir();
  const emptyState = createInitialState();
  atomicWriteJsonSync(primaryPath, emptyState);
  if (primaryPath !== MIRROR_FILE && existsSync(MIRROR_FILE)) {
    updateJsonAtomicSync(MIRROR_FILE, createInitialState, (cur) => {
      const prevMap = cur && cur.workspaces && typeof cur.workspaces === 'object' && !Array.isArray(cur.workspaces)
        ? { ...cur.workspaces }
        : {};
      if (normWs) delete prevMap[normWs];
      for (const k of Object.keys(prevMap)) {
        if (isEphemeralTestWorkspace(k) && !existsSync(k)) {
          delete prevMap[k];
        }
      }
      if (
        cur &&
        cur.workspaceRoot &&
        cur.workspaceRoot !== normWs &&
        isLiveNonEphemeralWorkspace(cur.workspaceRoot)
      ) {
        const preservedTop = { ...cur };
        delete preservedTop.workspaces;
        return { ...preservedTop, workspaces: prevMap };
      }
      const bestReal = Object.values(prevMap)
        .filter((w) => w && typeof w === 'object' && isLiveNonEphemeralWorkspace(w.workspaceRoot))
        .sort((a, b) => Date.parse(b?.updatedAt || '') - Date.parse(a?.updatedAt || ''))[0];
      return bestReal ? { ...bestReal, workspaces: prevMap } : { ...emptyState, workspaces: prevMap };
    });
  }
}

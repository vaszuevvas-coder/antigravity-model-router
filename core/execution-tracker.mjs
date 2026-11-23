/**
 * @file execution-tracker.mjs
 * @description Active Task Scratchpad & Zero-Turn Fault Frame Extractor.
 * Tracks multi-file task progress, pending dependents, and extracts targeted code frames
 * around runtime and syntax faults for zero-turn recovery.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteJsonSync, safeReadJsonSync, updateJsonAtomicSync } from './safe-json.mjs';
import { ensureTunnelCacheDir, pruneObjectMapByTimestamp, resolveTunnelCacheDir } from './cache-dir.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, '..');
const MAX_TRACKER_TASKS = 64;

function getCacheDir() {
  return resolveTunnelCacheDir(PLUGIN_ROOT);
}

function getTrackerFile() {
  return join(getCacheDir(), 'execution-tracker.json');
}

export const TTL_MS = 15 * 60 * 1000; // 15 minutes active task window
export const UNSAFE_KEYS = new Set([
  '__proto__',
  'constructor',
  'prototype',
  'toString',
  'valueOf',
  'hasOwnProperty',
]);

/**
 * Ensures cache directory exists.
 */
function ensureCacheDir() {
  ensureTunnelCacheDir(getCacheDir());
}

function pruneTrackerTasks(tasks = {}, now = Date.now()) {
  return pruneObjectMapByTimestamp(tasks, {
    maxEntries: MAX_TRACKER_TASKS,
    maxAgeMs: TTL_MS,
    now,
    getTs: (t) => Number(t?.ts || 0),
  });
}

/**
 * Creates empty initial tracker state.
 */
function createInitialState() {
  return {
    version: '3.0.0',
    tasks: {},
  };
}

/**
 * Sanitizes scope key to avoid prototype pollution and path traversal.
 * @param {string} key
 * @param {string} [fallback='default']
 * @returns {string}
 */
function sanitizeKey(key, fallback = 'default') {
  if (!key || typeof key !== 'string') return fallback;
  const trimmed = key.trim();
  const replaced = trimmed.replace(/[^a-zA-Z0-9_\-]/g, '_');
  const needsHash = replaced !== trimmed || replaced.length > 80;
  const clean = needsHash
    ? `${replaced.slice(0, 71)}_${createHash('sha1').update(trimmed).digest('hex').slice(0, 8)}`
    : replaced;
  if (!clean || UNSAFE_KEYS.has(clean.toLowerCase())) return fallback;
  return clean;
}

/**
 * Extracts a targeted fault frame (±5 lines around error location) from stack traces or syntax errors.
 * @param {string} errorText
 * @param {string} [workspaceRoot='']
 * @returns {string} Formatted fault frame or empty string
 */
export function extractFaultFrame(errorText = '', workspaceRoot = '') {
  if (!errorText || typeof errorText !== 'string') return '';
  const root = workspaceRoot || process.cwd();

  const pyPattern = /File\s+"([^"]+)",\s+line\s+(\d+)/i;
  const jsPattern =
    /(?:(?:at\s+.*?\(?|in\s+|[\s(])|^)(?:file:\/\/\/)?([a-zA-Z]:[\\/][^\s():]+|\.?[\\/][^\s():]+|[a-zA-Z0-9_.\-\/\\]+\.(?:mjs|cjs|js|ts|tsx|py|go|rs|json)):(\d+)(?::\d+)?\)?/i;

  const lines = errorText.split(/\r?\n/);
  for (const line of lines) {
    let rawPath = '';
    let lineStr = '';

    const pyMatch = pyPattern.exec(line);
    if (pyMatch) {
      rawPath = pyMatch[1];
      lineStr = pyMatch[2];
    } else {
      const jsMatch = jsPattern.exec(line);
      if (jsMatch) {
        rawPath = jsMatch[1];
        lineStr = jsMatch[2];
      }
    }

    if (!rawPath || !lineStr) continue;

    let cleanPath = rawPath.replace(/^file:\/\//, '');
    if (/^\/[a-zA-Z]:/.test(cleanPath)) {
      cleanPath = cleanPath.slice(1);
    }

    if (
      cleanPath.includes('node:internal') ||
      cleanPath.includes('node_modules') ||
      cleanPath.includes('<anonymous>') ||
      cleanPath.includes('(eval')
    ) {
      continue;
    }

    const resolvedPath = isAbsolute(cleanPath) ? cleanPath : resolve(root, cleanPath);
    if (!existsSync(resolvedPath)) continue;

    try {
      const st = statSync(resolvedPath);
      if (!st.isFile() || st.size > 2 * 1024 * 1024) continue;

      const lineNum = parseInt(lineStr, 10);
      if (isNaN(lineNum) || lineNum < 1) continue;

      const content = readFileSync(resolvedPath, 'utf8');
      const fileLines = content.split(/\r?\n/);
      if (fileLines.length === 0) continue;

      const actualLine = Math.min(lineNum, fileLines.length);
      const start = Math.max(1, actualLine - 5);
      const end = Math.min(fileLines.length, actualLine + 5);

      const framedLines = [];
      for (let l = start; l <= end; l++) {
        const marker = l === lineNum ? '>' : ' ';
        const lineText = (fileLines[l - 1] || '').slice(0, 140);
        framedLines.push(`${marker}L${l}: ${lineText}`);
      }

      let relPath = relative(root, resolvedPath).replace(/\\/g, '/');
      if (relPath.startsWith('../') || relPath.startsWith('..\\')) {
        relPath = basename(resolvedPath);
      }

      const header = `🔬 [Fault Frame: ${relPath}:L${start}-L${end}]`;
      const codeBlock = `\`\`\`\n${framedLines.join('\n')}\n\`\`\``;
      const result = `${header}\n${codeBlock}`;
      return result.length > 650 ? result.slice(0, 647) + '...' : result;
    } catch {
      // Continue to next trace line
    }
  }

  return '';
}

/**
 * Extracts up to 4 exported function/const names or signatures from JS/TS/MJS files.
 * @param {string} fullPath
 * @returns {string[]}
 */
function extractExportedContracts(fullPath) {
  try {
    const st = statSync(fullPath);
    if (!st.isFile() || st.size > 2 * 1024 * 1024) return [];
    const content = readFileSync(fullPath, 'utf8');
    const contracts = [];

    // Match: export [async] function name, export const/let/var/class name
    const declRegex = /export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|const|class|let|var)\s+([a-zA-Z0-9_$]+)/g;
    let m;
    while ((m = declRegex.exec(content)) !== null) {
      const name = m[1];
      if (name && !contracts.includes(name) && !UNSAFE_KEYS.has(name.toLowerCase())) {
        contracts.push(name);
        if (contracts.length >= 4) return contracts;
      }
    }

    // Match: export { a, b as c }
    const namedExportRegex = /export\s*\{([^}]+)\}/g;
    while ((m = namedExportRegex.exec(content)) !== null) {
      const parts = m[1].split(',').map((p) => p.trim().split(/\s+as\s+/).pop().trim());
      for (const p of parts) {
        const clean = p.replace(/[^a-zA-Z0-9_$]/g, '');
        if (clean && !contracts.includes(clean) && !UNSAFE_KEYS.has(clean.toLowerCase())) {
          contracts.push(clean);
          if (contracts.length >= 4) return contracts;
        }
      }
    }

    return contracts.slice(0, 4);
  } catch {
    return [];
  }
}

/**
 * Records a task execution step into the active scratchpad.
 * @param {object} [options]
 * @param {string} [options.workspaceRoot='']
 * @param {string} [options.conversationId='default']
 * @param {string} [options.filePath='']
 * @param {Array<string|{file: string}>} [options.dependents=[]]
 * @param {boolean} [options.verifyOk=true]
 * @param {string} [options.brokenContractAlert='']
 * @param {string} [options.errorText='']
 */
export function recordTaskStep({
  workspaceRoot = '',
  conversationId = 'default',
  filePath = '',
  dependents = [],
  brokenDependents = [],
  verifyOk = true,
  brokenContractAlert = '',
  errorText = '',
} = {}) {
  const scopeKey = sanitizeKey(conversationId || workspaceRoot || 'default');
  const root = workspaceRoot || process.cwd();
  ensureCacheDir();

  return updateJsonAtomicSync(getTrackerFile(), createInitialState, (state) => {
    if (!state || typeof state !== 'object') state = createInitialState();
    const now = Date.now();
    state.tasks = pruneTrackerTasks(state.tasks || {}, now);

    const task = state.tasks[scopeKey] || {
      edited: {},
      pendingDependents: [],
      brokenContractAlert: '',
      faultFrame: '',
      dirty: false,
      ts: now,
      workspaceRoot: workspaceRoot || '',
      goal: '',
      inspectedFiles: [],
      activeContracts: [],
      invariants: [],
      hadBarrier: false,
      failedFiles: [],
      lastBarrierSummary: '',
      crysSignaled: false,
    };
    if (!Array.isArray(task.activeContracts)) task.activeContracts = [];
    if (!Array.isArray(task.inspectedFiles)) task.inspectedFiles = [];
    if (!Array.isArray(task.invariants)) task.invariants = [];
    if (!Array.isArray(task.failedFiles)) task.failedFiles = [];
    if (typeof task.goal !== 'string') task.goal = '';
    if (typeof task.lastBarrierSummary !== 'string') task.lastBarrierSummary = '';

    let currentRelFile = '';
    if (filePath) {
      const normSlash = String(filePath).replace(/\\/g, '/').toLowerCase();
      if (
        normSlash.includes('/.cache/') ||
        normSlash.includes('/.system_generated/') ||
        /\/\.gemini\/antigravity(?:-ide|-cli)?\/brain\//i.test(normSlash)
      ) {
        return state;
      }
      const relFile = isAbsolute(filePath)
        ? relative(root, filePath).replace(/\\/g, '/')
        : filePath.replace(/\\/g, '/');
      currentRelFile = relFile;

      task.edited[relFile] = {
        verifyOk: Boolean(verifyOk),
        ts: now,
      };

      task.pendingDependents = (task.pendingDependents || []).filter((d) => d !== relFile);

      // Only add dependents that actually have broken import contracts to pendingDependents
      const depsToQueue = Array.isArray(brokenDependents) && brokenDependents.length > 0 ? brokenDependents : [];
      for (const dep of depsToQueue) {
        const rawDep = typeof dep === 'string' ? dep : dep?.dependentFile || dep?.file;
        if (!rawDep || typeof rawDep !== 'string') continue;
        const depRel = isAbsolute(rawDep)
          ? relative(root, rawDep).replace(/\\/g, '/')
          : rawDep.replace(/\\/g, '/');
        if (depRel !== relFile && !task.pendingDependents.includes(depRel)) {
          task.pendingDependents.push(depRel);
        }
      }
      task.pendingDependents = task.pendingDependents.slice(0, 8);

      const fullPath = isAbsolute(filePath) ? filePath : resolve(root, filePath);
      if (/\.(?:mjs|cjs|js|ts|tsx)$/i.test(fullPath) && existsSync(fullPath)) {
        const extracted = extractExportedContracts(fullPath);
        for (const c of extracted) {
          if (!task.activeContracts.includes(c)) {
            task.activeContracts.push(c);
          }
        }
        if (task.activeContracts.length > 10) {
          task.activeContracts = task.activeContracts.slice(-10);
        }
      }
    }

    task.brokenContractAlert = brokenContractAlert || '';

    const hasBrokenDeps = Array.isArray(brokenDependents) && brokenDependents.length > 0;
    if (errorText || !verifyOk || hasBrokenDeps) {
      task.hadBarrier = true;
      task.crysSignaled = false;
      if (currentRelFile && !task.failedFiles.includes(currentRelFile)) {
        task.failedFiles.push(currentRelFile);
      }
      const rawErrLine = String(errorText || brokenContractAlert || 'Verification barrier')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l.length > 3);
      if (rawErrLine) {
        task.lastBarrierSummary = rawErrLine.slice(0, 90);
      }
    }

    if (errorText || !verifyOk) {
      task.faultFrame = extractFaultFrame(errorText, workspaceRoot) || '';
    } else {
      task.faultFrame = '';
    }

    task.dirty = true;
    task.ts = now;
    task.workspaceRoot = workspaceRoot || task.workspaceRoot || '';
    state.tasks[scopeKey] = task;

    return state;
  });
}

/**
 * Consumes pending execution progress, broken contract alert, and one-shot fault frame.
 * @param {object} [options]
 * @param {string} [options.workspaceRoot='']
 * @param {string} [options.conversationId='default']
 * @returns {string} Formatted hint string or empty string
 */
export function consumeTaskExecutionHint({ workspaceRoot = '', conversationId = 'default' } = {}) {
  const trackerFile = getTrackerFile();
  if (!existsSync(trackerFile)) return '';
  const scopeKey = sanitizeKey(conversationId || workspaceRoot || 'default');
  let hint = '';

  updateJsonAtomicSync(trackerFile, createInitialState, (state) => {
    if (!state || typeof state !== 'object') state = createInitialState();
    const now = Date.now();
    state.tasks = pruneTrackerTasks(state.tasks || {}, now);

    const task = state.tasks[scopeKey];
    if (!task || !task.dirty) return state;

    if (workspaceRoot && task.workspaceRoot && resolve(workspaceRoot).toLowerCase() !== resolve(task.workspaceRoot).toLowerCase()) {
      return state;
    }

    const lines = [];

    const editedEntries = Object.entries(task.edited || {});
    if (editedEntries.length > 0) {
      const verifiedList = editedEntries
        .slice(-5)
        .map(([f, st]) => `${f}(${st.verifyOk ? '✓' : '✗'})`)
        .join(', ');
      const pendingStr = task.pendingDependents?.length
        ? ` | Broken dependents to fix: ${task.pendingDependents.slice(0, 4).join(', ')}`
        : ' | Contracts intact ✓';
      lines.push(`📋 [Task Progress] Edited: ${verifiedList}${pendingStr}`);
    }

    if (task.brokenContractAlert) {
      lines.push(task.brokenContractAlert);
    }

    if (task.faultFrame) {
      lines.push(task.faultFrame);
      task.faultFrame = ''; // Cleared after single consumption
    }

    task.dirty = false; // Emit once per edit/error event, do not spam on read_file steps

    if (lines.length > 0) {
      hint = lines.join('\n');
    }

    return state;
  }, { spaces: 0 });

  return hint;
}

/**
 * Updates shared task blackboard for cross-agent or subagent orchestration.
 * @param {object} [options]
 * @param {string} [options.workspaceRoot='']
 * @param {string} [options.conversationId='default']
 * @param {string} [options.goal='']
 * @param {string[]} [options.inspectedFiles=[]]
 * @param {string[]} [options.activeContracts=[]]
 * @param {string[]} [options.invariants=[]]
 * @returns {object} Updated task state
 */
export function updateTaskBlackboard({
  workspaceRoot = '',
  conversationId = 'default',
  goal = '',
  inspectedFiles = [],
  activeContracts = [],
  invariants = [],
} = {}) {
  const scopeKey = sanitizeKey(conversationId || workspaceRoot || 'default');
  ensureCacheDir();

  let updatedTask = null;
  updateJsonAtomicSync(getTrackerFile(), createInitialState, (state) => {
    if (!state || typeof state !== 'object') state = createInitialState();
    const now = Date.now();
    state.tasks = pruneTrackerTasks(state.tasks || {}, now);

    const task = state.tasks[scopeKey] || {
      edited: {},
      pendingDependents: [],
      brokenContractAlert: '',
      faultFrame: '',
      dirty: false,
      ts: now,
      workspaceRoot: workspaceRoot || '',
      goal: '',
      inspectedFiles: [],
      activeContracts: [],
      invariants: [],
    };
    if (!Array.isArray(task.activeContracts)) task.activeContracts = [];
    if (!Array.isArray(task.inspectedFiles)) task.inspectedFiles = [];
    if (!Array.isArray(task.invariants)) task.invariants = [];

    if (goal && typeof goal === 'string') {
      task.goal = goal.trim().slice(0, 200);
    }

    if (Array.isArray(inspectedFiles) && inspectedFiles.length > 0) {
      for (const f of inspectedFiles) {
        const cleanF = typeof f === 'string' ? f.trim().replace(/\\/g, '/') : '';
        if (cleanF && !task.inspectedFiles.includes(cleanF)) {
          task.inspectedFiles.push(cleanF);
        }
      }
      if (task.inspectedFiles.length > 15) {
        task.inspectedFiles = task.inspectedFiles.slice(-15);
      }
    }

    if (Array.isArray(activeContracts) && activeContracts.length > 0) {
      for (const c of activeContracts) {
        const cleanC = typeof c === 'string' ? c.trim() : '';
        if (cleanC && !task.activeContracts.includes(cleanC)) {
          task.activeContracts.push(cleanC);
        }
      }
      if (task.activeContracts.length > 10) {
        task.activeContracts = task.activeContracts.slice(-10);
      }
    }

    if (Array.isArray(invariants) && invariants.length > 0) {
      for (const inv of invariants) {
        const cleanInv = typeof inv === 'string' ? inv.trim() : '';
        if (cleanInv && !task.invariants.includes(cleanInv)) {
          task.invariants.push(cleanInv);
        }
      }
      if (task.invariants.length > 8) {
        task.invariants = task.invariants.slice(-8);
      }
    }

    task.ts = now;
    task.workspaceRoot = workspaceRoot || task.workspaceRoot || '';
    state.tasks[scopeKey] = task;
    updatedTask = task;
    return state;
  }, { spaces: 0 });

  return updatedTask;
}

/**
 * Formats compact shared task blackboard for subagent context injection.
 * @param {object} [options]
 * @param {string} [options.workspaceRoot='']
 * @param {string} [options.conversationId='default']
 * @returns {string} Compact blackboard markdown string (<=450 chars) or empty string
 */
export function formatBlackboardForSubagent(opts = {}) {
  const { workspaceRoot = '', conversationId = 'default' } = opts && typeof opts === 'object' ? opts : {};
  const trackerFile = getTrackerFile();
  if (!existsSync(trackerFile)) return '';
  const scopeKey = sanitizeKey(conversationId || workspaceRoot || 'default');
  const state = safeReadJsonSync(trackerFile, createInitialState);
  if (!state?.tasks) return '';

  const now = Date.now();
  let task = state.tasks[scopeKey];
  if (!task && workspaceRoot) {
    const normWs = resolve(workspaceRoot).toLowerCase();
    let latestTs = 0;
    for (const candidate of Object.values(state.tasks)) {
      if (!candidate || now - (candidate.ts || 0) > TTL_MS) continue;
      if (candidate.workspaceRoot && resolve(candidate.workspaceRoot).toLowerCase() === normWs) {
        if ((candidate.ts || 0) > latestTs) {
          latestTs = candidate.ts || 0;
          task = candidate;
        }
      }
    }
  }
  if (!task) return '';

  if (now - (task.ts || 0) > TTL_MS) return '';
  if (workspaceRoot && task.workspaceRoot && resolve(workspaceRoot).toLowerCase() !== resolve(task.workspaceRoot).toLowerCase()) return '';

  const editedEntries = Object.entries(task.edited || {});
  const hasGoal = Boolean(task.goal);
  const hasEdited = editedEntries.length > 0;
  const hasContracts = Array.isArray(task.activeContracts) && task.activeContracts.length > 0;

  if (!hasGoal && !hasEdited && !hasContracts) {
    return '';
  }

  const lines = ['📋 [Shared Task Blackboard]'];

  if (hasGoal) {
    lines.push(`- Goal: ${task.goal}`);
  }

  if (hasEdited) {
    const verified = editedEntries
      .slice(-4)
      .map(([f, st]) => `${f}(${st.verifyOk ? '✓' : '✗'})`)
      .join(', ');
    lines.push(`- Edited: ${verified}`);
  }

  if (hasContracts) {
    lines.push(`- Contracts: ${task.activeContracts.slice(0, 6).join(', ')}`);
  }

  if (Array.isArray(task.invariants) && task.invariants.length > 0) {
    lines.push(`- Invariants: ${task.invariants.slice(0, 3).join('; ')}`);
  }

  let text = lines.join('\n');
  if (text.length > 450) {
    text = text.slice(0, 447) + '...';
  }
  return text;
}

/**
 * Retrieves crystallization telemetry for the active task (whether a barrier was overcome and how many files are verified).
 * @param {object} [options]
 * @param {string} [options.workspaceRoot='']
 * @param {string} [options.conversationId='default']
 * @param {boolean} [options.consume=false] If true, marks barrier crystallization signal as consumed so it emits once per overcome barrier.
 * @returns {{ overcameBarrier: boolean, verifiedFilesCount: number, recoveredFilesCount: number, editedFiles: string[], lastBarrierSummary: string }}
 */
export function getTaskCrystallizationSignals({
  workspaceRoot = '',
  conversationId = 'default',
  consume = false,
} = {}) {
  const empty = {
    overcameBarrier: false,
    verifiedFilesCount: 0,
    recoveredFilesCount: 0,
    editedFiles: [],
    lastBarrierSummary: '',
  };
  const trackerFile = getTrackerFile();
  if (!existsSync(trackerFile)) return empty;

  const scopeKey = sanitizeKey(conversationId || workspaceRoot || 'default');
  let result = empty;

  updateJsonAtomicSync(trackerFile, createInitialState, (state) => {
    if (!state || typeof state !== 'object' || !state.tasks) return state;
    const now = Date.now();
    const task = state.tasks[scopeKey];
    if (!task || now - (task.ts || 0) > TTL_MS) return state;

    const editedEntries = Object.entries(task.edited || {});
    const verifiedFiles = editedEntries.filter(([, st]) => st && st.verifyOk).map(([f]) => f);
    const allVerified =
      editedEntries.length > 0 &&
      verifiedFiles.length === editedEntries.length &&
      (!Array.isArray(task.pendingDependents) || task.pendingDependents.length === 0) &&
      !task.brokenContractAlert;

    const failedList = Array.isArray(task.failedFiles) ? task.failedFiles : [];
    const recoveredFilesCount = failedList.filter((f) => task.edited?.[f]?.verifyOk).length;

    const overcame = Boolean(
      task.hadBarrier &&
        !task.crysSignaled &&
        allVerified &&
        (verifiedFiles.length >= 2 || recoveredFilesCount >= 1)
    );

    result = {
      overcameBarrier: overcame,
      verifiedFilesCount: verifiedFiles.length,
      recoveredFilesCount,
      editedFiles: verifiedFiles,
      lastBarrierSummary: task.lastBarrierSummary || '',
    };

    if (consume && overcame) {
      task.crysSignaled = true;
      state.tasks[scopeKey] = task;
    }

    return state;
  }, { spaces: 0 });

  return result;
}

/**
 * Returns edited file paths recorded for a conversation (active non-expired task only).
 * @param {{ conversationId?: string, workspaceRoot?: string }} [options={}]
 * @returns {string[]}
 */
export function getEditedFilesForConversation(rawOpts = {}) {
  const { conversationId = 'default', workspaceRoot = '' } =
    rawOpts && typeof rawOpts === 'object' ? rawOpts : {};
  const trackerFile = getTrackerFile();
  if (!existsSync(trackerFile)) return [];
  const state = safeReadJsonSync(trackerFile, createInitialState, { selfHeal: false });
  const scopeKey = sanitizeKey(conversationId || workspaceRoot || 'default');
  const task = state?.tasks?.[scopeKey];
  if (!task || !task.edited || typeof task.edited !== 'object') return [];
  if (Date.now() - (task.ts || 0) > TTL_MS) return [];
  if (workspaceRoot && task.workspaceRoot && resolve(workspaceRoot).toLowerCase() !== resolve(task.workspaceRoot).toLowerCase()) {
    return [];
  }
  return Object.keys(task.edited);
}

/**
 * Resets active task execution tracker storage.
 * @returns {boolean}
 */
export function resetExecutionTracker() {
  ensureCacheDir();
  atomicWriteJsonSync(getTrackerFile(), createInitialState(), { spaces: 0 });
  return true;
}

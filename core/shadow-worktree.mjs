/**
 * @file shadow-worktree.mjs
 * @description Изолированная Git-песочница на базе одного `git worktree` (Shadow Git Worktree Sandbox).
 * Позволяет безопасно проверять правки и тесты в отдельной директории без изменения рабочей копии,
 * а затем перенести верифицированный дифф в основной проект (с теневым чекпоинтом) или удалить песочницу.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { maskTerminalOutput } from './obs-masker.mjs';
import { atomicWriteJsonSync, safeReadJsonSync, withFileLockSync } from './safe-json.mjs';
import { checkCommandSecurity } from './security-guard.mjs';
import { createShadowCheckpoint, rollbackTurn } from './shadow-guard.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, '..');
const DEFAULT_CACHE_DIR = join(PLUGIN_ROOT, '.cache');
const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_WORKTREES = 12;

function asObj(val) {
  return val && typeof val === 'object' && !Array.isArray(val) ? val : {};
}

function asStr(val, maxLen = 1024) {
  if (typeof val !== 'string') return '';
  return val.replace(/\0/g, '').slice(0, maxLen);
}

function normWsKey(wsPath = '') {
  const clean = asStr(wsPath).trim();
  if (!clean || BLOCKED_KEYS.has(clean)) return '';
  try {
    const abs = resolve(clean);
    return process.platform === 'win32' ? abs.toLowerCase() : abs;
  } catch {
    return '';
  }
}

function resolvePaths(cacheDir = '') {
  const baseCache = asStr(cacheDir).trim() ? resolve(asStr(cacheDir).trim()) : DEFAULT_CACHE_DIR;
  return {
    cacheDir: baseCache,
    worktreesDir: join(baseCache, 'worktrees'),
    indexFile: join(baseCache, 'shadow-worktrees.json'),
  };
}

function ensureStorageDirs(paths) {
  if (!existsSync(paths.cacheDir)) mkdirSync(paths.cacheDir, { recursive: true });
  if (!existsSync(paths.worktreesDir)) mkdirSync(paths.worktreesDir, { recursive: true });
}

function runGit(args = [], cwd = '', timeoutMs = 12000, { trimOutput = true } = {}) {
  try {
    const rawStdout = String(execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }) || '');
    return { ok: true, stdout: trimOutput ? rawStdout.trim() : rawStdout, stderr: '' };
  } catch (err) {
    return {
      ok: false,
      stdout: String(err?.stdout || '').trim(),
      stderr: String(err?.stderr || err?.message || 'git failed').trim(),
    };
  }
}

function resolveGitRepoRoot(wsPath = '') {
  const clean = asStr(wsPath).trim();
  if (!clean || clean.startsWith('-') || !existsSync(clean)) return '';
  const res = runGit(['rev-parse', '--show-toplevel'], resolve(clean), 4000);
  if (!res.ok || !res.stdout) return '';
  return resolve(res.stdout);
}

function validateSafeRelPath(relPath = '') {
  const clean = asStr(relPath, 512).replace(/\\/g, '/').replace(/^\/+/, '').trim();
  if (!clean || clean.startsWith('-') || clean.startsWith('..') || clean.includes('/../')) return '';
  return clean;
}

function validateSafeWorktreeId(id = '') {
  const clean = asStr(id, 80).trim();
  if (!clean || BLOCKED_KEYS.has(clean) || !/^wt_[a-zA-Z0-9_-]+$/.test(clean)) return '';
  return clean;
}

function loadIndex(indexFile) {
  const raw = safeReadJsonSync(indexFile, () => ({ entries: [] }), { selfHeal: false });
  return Array.isArray(raw?.entries) ? raw.entries : [];
}

function findEntry(opts = {}) {
  const safeOpts = asObj(opts);
  const paths = resolvePaths(safeOpts.cacheDir);
  const id = validateSafeWorktreeId(safeOpts.id);
  const wsFilter = normWsKey(safeOpts.workspaceRoot);
  const entries = loadIndex(paths.indexFile);
  let match = null;
  if (id) {
    match = entries.find((e) => e?.id === id) || null;
  } else if (wsFilter) {
    match = entries.find((e) => normWsKey(e?.workspaceRoot) === wsFilter || normWsKey(e?.repoRoot) === wsFilter) || null;
  }
  return { paths, entries, entry: match };
}

function parseArgvTokens(cmdLine = '') {
  const tokens = [];
  let cur = '';
  let quote = '';
  for (let i = 0; i < cmdLine.length; i++) {
    const ch = cmdLine[i];
    if (quote) {
      if (ch === quote) quote = '';
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (cur) {
        tokens.push(cur);
        cur = '';
      }
    } else {
      cur += ch;
    }
  }
  if (cur) tokens.push(cur);
  return tokens;
}

/**
 * Создаёт изолированную detached `git worktree` песочницу для текущего репозитория.
 * @param {object} [opts={}]
 * @returns {object}
 */
export function createShadowWorktree(opts = {}) {
  const safeOpts = asObj(opts);
  const isEn = String(safeOpts.lang || '').trim().toLowerCase() === 'en';
  if (safeOpts.state?.shadowWorktreeEnabled === false) {
    return { ok: false, disabled: true, error: isEn ? 'Shadow Worktree is disabled in settings' : 'Shadow Worktree отключён в настройках' };
  }
  const rawWs = asStr(safeOpts.workspaceRoot).trim();
  if (!rawWs || rawWs.startsWith('-') || !existsSync(rawWs)) {
    return { ok: false, error: isEn ? 'Workspace directory not found' : 'Рабочая папка не найдена' };
  }
  const repoRoot = resolveGitRepoRoot(rawWs);
  if (!repoRoot) {
    return { ok: false, error: isEn ? 'Directory is not a Git repository' : 'Папка не является Git-репозиторием' };
  }

  const headRes = runGit(['rev-parse', 'HEAD'], repoRoot, 4000);
  if (!headRes.ok || !headRes.stdout) {
    return { ok: false, error: isEn ? 'Repository has no commits yet (HEAD missing)' : 'В репозитории нет ни одного коммита (HEAD отсутствует)' };
  }

  const paths = resolvePaths(safeOpts.cacheDir);
  ensureStorageDirs(paths);

  const id = `wt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const wtDir = join(paths.worktreesDir, id);
  const label = asStr(safeOpts.label, 120).replace(/\s+/g, ' ').trim() || (isEn ? `Sandbox ${basename(repoRoot)}` : `Песочница ${basename(repoRoot)}`);

  const addRes = runGit(['worktree', 'add', '--detach', wtDir, headRes.stdout], repoRoot, 15000);
  if (!addRes.ok || !existsSync(wtDir)) {
    return { ok: false, error: addRes.stderr || (isEn ? 'Failed to create git worktree' : 'Не удалось создать git worktree') };
  }

  const entry = {
    id,
    label,
    repoRoot,
    workspaceRoot: resolve(rawWs),
    worktreePath: wtDir,
    baseHead: headRes.stdout,
    createdAt: new Date().toISOString(),
  };

  let evicted = [];
  withFileLockSync(paths.indexFile, () => {
    const entries = loadIndex(paths.indexFile).filter((e) => e && e.worktreePath && existsSync(e.worktreePath));
    entries.unshift(entry);
    if (entries.length > MAX_WORKTREES) {
      evicted = entries.splice(MAX_WORKTREES);
    }
    atomicWriteJsonSync(paths.indexFile, { entries });
  });

  for (const old of evicted) {
    try {
      runGit(['worktree', 'remove', '--force', old.worktreePath], old.repoRoot || repoRoot, 6000);
      if (existsSync(old.worktreePath)) {
        rmSync(old.worktreePath, { recursive: true, force: true, maxRetries: 6, retryDelay: 40 });
      }
    } catch {}
  }

  return { ok: true, ...entry };
}

/**
 * Возвращает список активных изолированных Git-песочниц.
 * @param {string} [workspaceRoot='']
 * @param {object} [opts={}]
 * @returns {Array<object>}
 */
export function listShadowWorktrees(workspaceRoot = '', opts = {}) {
  const safeOpts = asObj(opts);
  const paths = resolvePaths(safeOpts.cacheDir);
  if (!existsSync(paths.indexFile)) return [];
  const wsFilter = normWsKey(workspaceRoot);
  const raw = loadIndex(paths.indexFile);
  const alive = [];
  let dirty = false;
  for (const item of raw) {
    if (!item || !item.id || !item.worktreePath) {
      dirty = true;
      continue;
    }
    if (!existsSync(item.worktreePath)) {
      dirty = true;
      continue;
    }
    alive.push(item);
  }
  if (dirty) {
    try {
      withFileLockSync(paths.indexFile, () => {
        const latest = loadIndex(paths.indexFile).filter(
          (e) => e && e.id && e.worktreePath && existsSync(e.worktreePath)
        );
        atomicWriteJsonSync(paths.indexFile, { entries: latest });
      });
    } catch {}
  }
  if (!wsFilter) return alive;
  return alive.filter(
    (e) => normWsKey(e.workspaceRoot) === wsFilter || normWsKey(e.repoRoot) === wsFilter
  );
}

/**
 * Запускает команду (тесты/линтер/скрипт) внутри изолированной Git-песочницы без влияния на основной проект.
 * @param {object} [opts={}]
 * @returns {object}
 */
export function runInShadowWorktree(opts = {}) {
  const safeOpts = asObj(opts);
  const isEn = String(safeOpts.lang || '').trim().toLowerCase() === 'en';
  const { entry } = findEntry(safeOpts);
  if (!entry || !existsSync(entry.worktreePath)) {
    return { ok: false, exitCode: 1, stdout: '', stderr: '', error: isEn ? 'Git worktree sandbox not found' : 'Песочница git worktree не найдена' };
  }

  const rawCmd = asStr(safeOpts.command, 512).trim();
  const explicitArgs = Array.isArray(safeOpts.args)
    ? safeOpts.args.map((a) => asStr(a, 512)).filter(Boolean)
    : [];
  const tokens = explicitArgs.length > 0 ? [rawCmd, ...explicitArgs] : parseArgvTokens(rawCmd);
  if (tokens.length === 0 || !tokens[0]) {
    return { ok: false, exitCode: 1, stdout: '', stderr: '', error: isEn ? 'Command is not specified' : 'Команда не указана' };
  }

  const fullCmdStr = tokens.join(' ');
  const sec = checkCommandSecurity(fullCmdStr, entry.worktreePath);
  if (sec && sec.allowed === false) {
    return { ok: false, exitCode: 1, stdout: '', stderr: '', error: sec.reason || (isEn ? 'Command blocked by Security Guard' : 'Команда заблокирована Security Guard') };
  }

  let bin = tokens[0];
  const cmdArgs = tokens.slice(1);
  if (/^node(?:\.exe)?$/i.test(bin)) {
    bin = process.execPath;
  }

  const timeoutMs = Number.isFinite(Number(safeOpts.timeoutMs))
    ? Math.max(500, Math.min(120_000, Math.round(Number(safeOpts.timeoutMs))))
    : 30_000;

  const res = spawnSync(bin, cmdArgs, {
    cwd: entry.worktreePath,
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    shell: false,
  });

  const stdout = maskTerminalOutput(String(res.stdout || ''), 4000);
  const stderr = maskTerminalOutput(String(res.stderr || res.error?.message || ''), 4000);
  const exitCode = Number.isInteger(res.status) ? res.status : (res.error ? 1 : 0);
  return {
    ok: exitCode === 0 && !res.error,
    id: entry.id,
    exitCode,
    stdout,
    stderr,
  };
}

/**
 * Возвращает список изменённых файлов и diff внутри изолированной песочницы.
 * @param {object} [opts={}]
 * @returns {object}
 */
export function getShadowWorktreeDiff(opts = {}) {
  const safeOpts = asObj(opts);
  const isEn = String(safeOpts.lang || '').trim().toLowerCase() === 'en';
  const { entry } = findEntry(safeOpts);
  if (!entry || !existsSync(entry.worktreePath)) {
    return { ok: false, error: isEn ? 'Git worktree sandbox not found' : 'Песочница git worktree не найдена', changedFiles: [] };
  }

  const statusRes = runGit(['status', '--porcelain'], entry.worktreePath, 6000, { trimOutput: false });
  if (!statusRes.ok) {
    return { ok: false, error: statusRes.stderr || (isEn ? 'Failed to inspect sandbox status' : 'Не удалось получить статус песочницы'), changedFiles: [] };
  }

  const changedFiles = [];
  const lines = statusRes.stdout ? statusRes.stdout.split(/\r?\n/) : [];
  for (const rawLine of lines) {
    if (!rawLine || rawLine.length < 4) continue;
    const code = rawLine.slice(0, 2);
    let rel = rawLine.slice(3).trim();
    if (rel.includes(' -> ')) rel = rel.split(' -> ').pop().trim();
    rel = rel.replace(/^"|"$/g, '');
    const safeRel = validateSafeRelPath(rel);
    if (!safeRel) continue;
    const isDeleted = code.includes('D');
    const isAdded = code.includes('?') || code.includes('A');
    changedFiles.push({
      path: safeRel,
      status: isDeleted ? 'deleted' : (isAdded ? 'created' : 'modified'),
    });
  }

  const statRes = runGit(['diff', '--stat', 'HEAD'], entry.worktreePath, 6000);
  const diffRes = runGit(['diff', 'HEAD'], entry.worktreePath, 8000);

  return {
    ok: true,
    id: entry.id,
    label: entry.label,
    worktreePath: entry.worktreePath,
    changedFiles,
    diffStat: String(statRes.stdout || '').trim(),
    diffText: String(diffRes.stdout || '').slice(0, 24_000),
  };
}

/**
 * Переносит проверенные изменения из песочницы в основной проект с созданием теневого чекпоинта.
 * @param {object} [opts={}]
 * @returns {object}
 */
export function promoteShadowWorktree(opts = {}) {
  const safeOpts = asObj(opts);
  const isEn = String(safeOpts.lang || '').trim().toLowerCase() === 'en';
  const diff = getShadowWorktreeDiff(safeOpts);
  if (!diff.ok) return diff;
  const { entry } = findEntry(safeOpts);
  if (!entry) return { ok: false, error: isEn ? 'Sandbox not found' : 'Песочница не найдена' };

  const promotedFiles = [];
  const deletedFiles = [];
  const failedFiles = [];
  const promoteTurnId = `wt_promote_${entry.id}`;

  for (const item of diff.changedFiles) {
    const targetAbs = resolve(entry.repoRoot, item.path);
    const srcAbs = resolve(entry.worktreePath, item.path);
    const relToRepo = relative(entry.repoRoot, targetAbs);
    if (!relToRepo || relToRepo.startsWith('..') || isAbsolute(relToRepo)) continue;

    let targetIsDir = false;
    try {
      targetIsDir = existsSync(targetAbs) && statSync(targetAbs).isDirectory();
    } catch {}
    if (!targetIsDir) {
      try {
        createShadowCheckpoint({
          filePath: targetAbs,
          workspaceRoot: entry.repoRoot,
          toolName: 'worktree_promote',
          turnId: promoteTurnId,
          turnLabel: isEn ? `Apply sandbox: ${entry.label}` : `Применение песочницы: ${entry.label}`,
        });
      } catch {}
    }

    if (item.status === 'deleted') {
      try {
        if (existsSync(targetAbs)) {
          unlinkSync(targetAbs);
          deletedFiles.push(item.path);
        }
      } catch (err) {
        failedFiles.push({ path: item.path, error: String(err?.message || err) });
      }
    } else if (existsSync(srcAbs)) {
      try {
        const st = statSync(srcAbs);
        if (st.isFile()) {
          mkdirSync(dirname(targetAbs), { recursive: true });
          copyFileSync(srcAbs, targetAbs);
          promotedFiles.push(item.path);
        }
      } catch (err) {
        failedFiles.push({ path: item.path, error: String(err?.message || err) });
      }
    }
  }

  if (failedFiles.length > 0) {
    try {
      rollbackTurn(promoteTurnId, entry.repoRoot, { lang: safeOpts.lang });
    } catch {}
    return {
      ok: false,
      id: entry.id,
      turnId: promoteTurnId,
      promotedFiles: [],
      deletedFiles: [],
      failedFiles,
      count: 0,
      cleanedUp: false,
      error: isEn
        ? `Failed to promote ${failedFiles.length} file(s); changes rolled back`
        : `Не удалось перенести файлов: ${failedFiles.length}; изменения откачены`,
    };
  }

  const cleanup = safeOpts.cleanup !== false;
  if (cleanup) {
    discardShadowWorktree({ ...safeOpts, id: entry.id });
  }

  return {
    ok: true,
    id: entry.id,
    turnId: promoteTurnId,
    promotedFiles,
    deletedFiles,
    count: promotedFiles.length + deletedFiles.length,
    cleanedUp: cleanup,
  };
}

/**
 * Удаляет изолированную песочницу `git worktree` без внесения изменений в основной проект.
 * @param {object} [opts={}]
 * @returns {object}
 */
export function discardShadowWorktree(opts = {}) {
  const safeOpts = asObj(opts);
  const isEn = String(safeOpts.lang || '').trim().toLowerCase() === 'en';
  const { paths, entry } = findEntry(safeOpts);
  if (!entry) {
    return { ok: false, error: isEn ? 'Git worktree sandbox not found' : 'Песочница git worktree не найдена' };
  }

  if (entry.repoRoot && existsSync(entry.repoRoot)) {
    runGit(['worktree', 'remove', '--force', entry.worktreePath], entry.repoRoot, 8000);
    runGit(['worktree', 'prune'], entry.repoRoot, 4000);
  }
  if (entry.worktreePath && existsSync(entry.worktreePath)) {
    try {
      rmSync(entry.worktreePath, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
    } catch {}
  }

  withFileLockSync(paths.indexFile, () => {
    const next = loadIndex(paths.indexFile).filter((e) => e?.id !== entry.id);
    atomicWriteJsonSync(paths.indexFile, { entries: next });
  });

  return { ok: true, id: entry.id, removed: true };
}

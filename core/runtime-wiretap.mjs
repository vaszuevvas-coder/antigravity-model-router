/**
 * @file runtime-wiretap.mjs
 * @description Живой перехватчик ошибок выполнения (`ag watch` + Sidecar UI) и автоматический `git bisect`.
 * Фиксирует сбои рантайма с маскировкой логов и секретов, извлекает локальный кадр стека (±6 строк)
 * и локализует сломавший коммит бинарным поиском во временном detached `git worktree`.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { maskTerminalOutputSmart } from './obs-masker.mjs';
import { atomicWriteJsonSync, safeReadJsonSync, withFileLockSync } from './safe-json.mjs';
import { checkCommandSecurity, redactSecretsInText } from './security-guard.mjs';
import { normalizeLang, pickLang } from './i18n.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, '..');
const DEFAULT_CACHE_DIR = join(PLUGIN_ROOT, '.cache');
const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_FAULTS_PER_WS = 25;

function asObj(val) {
  return val && typeof val === 'object' && !Array.isArray(val) ? val : {};
}

function asStr(val, maxLen = 4096) {
  if (typeof val !== 'string') return '';
  return val.replace(/\0/g, '').slice(0, maxLen);
}

function normWsKey(wsPath = '') {
  const clean = asStr(wsPath, 1024).trim();
  if (!clean || BLOCKED_KEYS.has(clean)) return '';
  try {
    const abs = resolve(clean);
    return process.platform === 'win32' ? abs.toLowerCase() : abs;
  } catch {
    return '';
  }
}

function resolveWiretapFile(cacheDir = '') {
  const baseCache = asStr(cacheDir, 1024).trim() ? resolve(asStr(cacheDir, 1024).trim()) : DEFAULT_CACHE_DIR;
  if (!existsSync(baseCache)) mkdirSync(baseCache, { recursive: true });
  return {
    cacheDir: baseCache,
    file: join(baseCache, 'runtime-wiretap.json'),
  };
}

function popcnt32(v) {
  v = v - ((v >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

function computeSimHash32Pair(text = '') {
  const norm = asStr(text, 4000)
    .toLowerCase()
    .replace(/\b\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}:\d{2}(?:\.\d+)?z?\b/g, ' ')
    .replace(/\b0x[0-9a-f]+\b/g, ' ')
    .replace(/\b\d+\b/g, ' ');
  const tokens = norm.match(/[a-zа-яё0-9_]{2,}/gi) || [];
  if (tokens.length === 0) return { hi: 0, lo: 0 };
  const weights = new Int32Array(64);
  for (const tok of tokens) {
    let lo = 0x9e3779b9;
    let hi = 0x811c9dc5;
    for (let i = 0; i < tok.length; i++) {
      const c = tok.charCodeAt(i);
      lo = Math.imul(lo ^ c, 0x01000193) >>> 0;
      hi = Math.imul(hi ^ (c + (lo & 0xff)), 0x85ebca6b) >>> 0;
    }
    for (let b = 0; b < 32; b++) {
      weights[b] += ((lo >>> b) & 1) ? 1 : -1;
      weights[32 + b] += ((hi >>> b) & 1) ? 1 : -1;
    }
  }
  let loOut = 0;
  let hiOut = 0;
  for (let b = 0; b < 32; b++) {
    if (weights[b] > 0) loOut = (loOut | (1 << b)) >>> 0;
    if (weights[32 + b] > 0) hiOut = (hiOut | (1 << b)) >>> 0;
  }
  return { hi: hiOut >>> 0, lo: loOut >>> 0 };
}

function hamming64(a, b) {
  if (!a || !b) return 64;
  return popcnt32((a.hi ^ b.hi) >>> 0) + popcnt32((a.lo ^ b.lo) >>> 0);
}

function extractTopLocalFrame(wsRoot = '', cleanError = '') {
  const absRoot = wsRoot ? resolve(wsRoot) : process.cwd();
  const candidates = [];
  const lines = asStr(cleanError, 8000).split(/\r?\n/);
  const jsRe = /(?:file:\/\/\/|\(|\s)([A-Za-z]:[\\/][^():\r\n]+\.[a-zA-Z0-9]+|[^()\s:]+\.[cm]?[jt]sx?):(\d+)(?::(\d+))?/;
  const pyRe = /File\s+"([^"]+)",\s+line\s+(\d+)/;

  for (const line of lines) {
    let rawPath = '';
    let lineNum = 0;
    const mJs = jsRe.exec(line);
    if (mJs) {
      rawPath = mJs[1].trim();
      lineNum = Number(mJs[2] || 0);
    } else {
      const mPy = pyRe.exec(line);
      if (mPy) {
        rawPath = mPy[1].trim();
        lineNum = Number(mPy[2] || 0);
      }
    }
    if (!rawPath || lineNum <= 0) continue;
    if (/node:internal|node_modules/i.test(rawPath)) continue;

    try {
      const absCandidate = rawPath.startsWith('file:///')
        ? resolve(fileURLToPath(rawPath))
        : (isAbsolute(rawPath) ? resolve(rawPath) : resolve(absRoot, rawPath));
      const rel = relative(absRoot, absCandidate).replace(/\\/g, '/');
      if (rel.startsWith('..') || isAbsolute(rel)) continue;
      if (!existsSync(absCandidate)) continue;
      candidates.push({ absPath: absCandidate, relPath: rel, line: lineNum });
    } catch {}
  }

  if (candidates.length === 0) return null;
  const top = candidates[0];
  let codeFrame = '';
  try {
    const fileLines = readFileSync(top.absPath, 'utf8').split(/\r?\n/);
    const start = Math.max(1, top.line - 6);
    const end = Math.min(fileLines.length, top.line + 6);
    const out = [];
    for (let ln = start; ln <= end; ln++) {
      const mark = ln === top.line ? '>' : ' ';
      out.push(`${mark} ${String(ln).padStart(4, ' ')} | ${fileLines[ln - 1]}`);
    }
    codeFrame = out.join('\n');
  } catch {}
  return { file: top.relPath, line: top.line, codeFrame };
}

function extractHeadlineError(maskedText = '', lang = 'ru') {
  const lines = asStr(maskedText, 6000)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const errLine = lines.find((l) => /(?:Error|Exception|AssertionError|TypeError|ReferenceError|SyntaxError|FAIL|panic:)/i.test(l));
  const fallback = normalizeLang(lang, 'ru') === 'en' ? 'Unknown runtime error' : 'Неизвестная ошибка выполнения';
  return (errLine || lines[0] || fallback).slice(0, 220);
}

/**
 * Регистрирует ошибку выполнения, очищает шум и секреты, извлекает локальный код ±6 строк
 * и дедуплицирует повторяющиеся падения по SimHash64.
 * @param {object} [opts={}]
 * @returns {object}
 */
export function ingestRuntimeFault(opts = {}) {
  const safeOpts = asObj(opts);
  const resolvedLang = normalizeLang(safeOpts.lang || safeOpts.state?.uiLanguage, 'ru');
  const isEn = resolvedLang === 'en';
  if (safeOpts.state?.runtimeWiretapEnabled === false) {
    return {
      ok: false,
      disabled: true,
      error: isEn ? 'Runtime Wiretap is disabled in settings' : 'Runtime Wiretap отключён в настройках',
    };
  }
  const rawError = asStr(safeOpts.rawError, 24_000).trim();
  const wsKey = normWsKey(safeOpts.workspaceRoot || process.cwd());
  if (!rawError || !wsKey) {
    return {
      ok: false,
      error: isEn ? 'Missing error text or workspaceRoot' : 'Не передан текст ошибки или workspaceRoot',
    };
  }

  const wsRoot = resolve(asStr(safeOpts.workspaceRoot, 1024).trim() || process.cwd());
  const masked = maskTerminalOutputSmart(rawError, 3200);
  const cleanText = redactSecretsInText(typeof masked === 'string' ? masked : (masked?.output || rawError));
  const summary = extractHeadlineError(cleanText, resolvedLang);
  const frame = extractTopLocalFrame(wsRoot, cleanText);
  const sim = computeSimHash32Pair(`${summary}\n${frame?.file || ''}`);
  const normHash = createHash('sha1').update(`${summary.toLowerCase()}|${frame?.file || ''}:${frame?.line || 0}`).digest('hex').slice(0, 14);
  const nowIso = new Date().toISOString();

  const { file } = resolveWiretapFile(safeOpts.cacheDir);
  let savedFault = null;
  let deduplicated = false;

  withFileLockSync(file, () => {
    const db = safeReadJsonSync(file, () => ({ workspaces: {} }), { selfHeal: false });
    const workspaces = db?.workspaces && typeof db.workspaces === 'object' ? { ...db.workspaces } : {};
    const list = Array.isArray(workspaces[wsKey]) ? [...workspaces[wsKey]] : [];

    const existingIdx = list.findIndex((f) => {
      if (!f) return false;
      if (f.normHash === normHash) return true;
      return f.sim && hamming64(f.sim, sim) <= 4 && (f.file || '') === (frame?.file || '');
    });

    if (existingIdx >= 0) {
      deduplicated = true;
      const prev = list[existingIdx];
      savedFault = {
        ...prev,
        occurrences: Number(prev.occurrences || 1) + 1,
        lastSeenAt: nowIso,
        exitCode: Number.isFinite(Number(safeOpts.exitCode)) ? Number(safeOpts.exitCode) : prev.exitCode,
        codeFrame: frame?.codeFrame || prev.codeFrame || '',
      };
      list.splice(existingIdx, 1);
      list.unshift(savedFault);
    } else {
      savedFault = {
        id: `flt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        source: asStr(safeOpts.source, 48) || 'watch',
        command: redactSecretsInText(asStr(safeOpts.command, 240)),
        summary,
        file: frame?.file || '',
        line: frame?.line || 0,
        codeFrame: frame?.codeFrame || '',
        excerpt: cleanText.slice(0, 1200),
        exitCode: Number.isFinite(Number(safeOpts.exitCode)) ? Number(safeOpts.exitCode) : 1,
        normHash,
        sim,
        occurrences: 1,
        firstSeenAt: nowIso,
        lastSeenAt: nowIso,
      };
      list.unshift(savedFault);
    }

    workspaces[wsKey] = list.slice(0, MAX_FAULTS_PER_WS);
    atomicWriteJsonSync(file, { workspaces });
  });

  return { ok: true, fault: savedFault, deduplicated };
}

/**
 * Возвращает последние перехваченные ошибки рантайма для воркспейса.
 * @param {string} [workspaceRoot='']
 * @param {object} [opts={}]
 * @returns {{ ok: boolean, faults: Array<object> }}
 */
export function getLatestWiretapFaults(workspaceRoot = '', opts = {}) {
  const safeOpts = asObj(opts);
  const wsKey = normWsKey(workspaceRoot);
  if (typeof workspaceRoot === 'string' && workspaceRoot.trim() && !wsKey) {
    return { ok: true, faults: [] };
  }
  const baseCache = asStr(safeOpts.cacheDir, 1024).trim() ? resolve(asStr(safeOpts.cacheDir, 1024).trim()) : DEFAULT_CACHE_DIR;
  const file = join(baseCache, 'runtime-wiretap.json');
  if (!existsSync(file)) return { ok: true, faults: [] };
  const limit = Number.isFinite(Number(safeOpts.limit)) ? Math.max(1, Math.min(25, Math.round(Number(safeOpts.limit)))) : 10;
  const db = safeReadJsonSync(file, () => ({ workspaces: {} }), { selfHeal: false });
  const workspaces = db?.workspaces && typeof db.workspaces === 'object' ? db.workspaces : {};
  if (wsKey) {
    const arr = Array.isArray(workspaces[wsKey]) ? workspaces[wsKey] : [];
    return { ok: true, faults: arr.slice(0, limit) };
  }
  const all = Object.values(workspaces).flat().filter(Boolean);
  all.sort((a, b) => String(b.lastSeenAt || '').localeCompare(String(a.lastSeenAt || '')));
  return { ok: true, faults: all.slice(0, limit) };
}

/**
 * Очищает журнал перехваченных ошибок для указанного воркспейса.
 * @param {string} [workspaceRoot='']
 * @param {object} [opts={}]
 * @returns {{ ok: boolean, cleared: boolean }}
 */
export function clearWiretapFaults(workspaceRoot = '', opts = {}) {
  const safeOpts = asObj(opts);
  const wsKey = normWsKey(workspaceRoot);
  const { file } = resolveWiretapFile(safeOpts.cacheDir);
  if (!existsSync(file)) return { ok: true, cleared: true };
  withFileLockSync(file, () => {
    const db = safeReadJsonSync(file, () => ({ workspaces: {} }), { selfHeal: false });
    const workspaces = db?.workspaces && typeof db.workspaces === 'object' ? { ...db.workspaces } : {};
    if (wsKey) {
      delete workspaces[wsKey];
    } else {
      for (const k of Object.keys(workspaces)) delete workspaces[k];
    }
    atomicWriteJsonSync(file, { workspaces });
  });
  return { ok: true, cleared: true };
}

/**
 * Форматирует перехваченную ошибку в готовый русский промпт для Умного Композера.
 * @param {object} [fault={}]
 * @returns {string}
 */
export function formatFaultForComposer(fault = {}, { lang = 'ru' } = {}) {
  const f = asObj(fault);
  if (!f.summary && !f.excerpt) return '';
  const isEn = normalizeLang(lang, 'ru') === 'en';
  const loc = f.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : (isEn ? 'the project' : 'проекте');
  const parts = [
    isEn
      ? `Fix the runtime error in ${loc}: ${asStr(f.summary, 220)}`
      : `Исправь ошибку выполнения в ${loc}: ${asStr(f.summary, 220)}`,
  ];
  if (f.codeFrame) {
    parts.push(`${isEn ? 'Code frame' : 'Фрагмент кода'}:\n${asStr(f.codeFrame, 900)}`);
  } else if (f.excerpt) {
    parts.push(`${isEn ? 'Failure log' : 'Лог сбоя'}:\n${asStr(f.excerpt, 600)}`);
  }
  return parts.join('\n\n');
}

function parseCommandTokens(cmdStr = '') {
  const tokens = [];
  let cur = '';
  let quote = '';
  for (let i = 0; i < cmdStr.length; i++) {
    const ch = cmdStr[i];
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

function validateSafeGitRef(ref = '') {
  const s = asStr(ref, 128).trim();
  if (!s || s.startsWith('-') || BLOCKED_KEYS.has(s)) return '';
  if (s.includes('@{') || /[\s\0\\*?[\]:;|&$<>`"'{}]/.test(s)) return '';
  if (!/^[A-Za-z0-9_./~^-]+$/.test(s)) return '';
  return s;
}

/**
 * Автоматически находит первый коммит-регрессию методом `git bisect` во временном detached worktree
 * без модификации основной рабочей директории.
 * @param {object} [opts={}]
 * @returns {object}
 */
export function runAutomatedGitBisect(opts = {}) {
  const safeOpts = asObj(opts);
  const resolvedLang = normalizeLang(safeOpts.lang || safeOpts.state?.uiLanguage, 'ru');
  const isEn = resolvedLang === 'en';
  const rawWs = asStr(safeOpts.workspaceRoot, 1024).trim();
  const goodRef = validateSafeGitRef(safeOpts.goodRef);
  const badRef = validateSafeGitRef(safeOpts.badRef || 'HEAD');
  const testCommand = asStr(safeOpts.testCommand, 512).trim();

  if (!rawWs || rawWs.startsWith('-') || !existsSync(rawWs)) {
    return { ok: false, error: isEn ? 'Workspace directory not found' : 'Рабочая папка не найдена' };
  }
  if (!goodRef || !badRef) {
    return { ok: false, error: isEn ? 'Invalid Git refs goodRef/badRef' : 'Некорректные Git-ссылки goodRef/badRef' };
  }
  if (!testCommand) {
    return { ok: false, error: isEn ? 'Missing testCommand' : 'Не указана тестовая команда testCommand' };
  }

  let repoRoot = '';
  try {
    repoRoot = resolve(String(execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: resolve(rawWs),
      encoding: 'utf8',
      timeout: 4000,
      windowsHide: true,
    }) || '').trim());
  } catch {
    return { ok: false, error: isEn ? 'Specified directory is not a Git repository' : 'Указанная директория не является Git-репозиторием' };
  }

  const sec = checkCommandSecurity(testCommand, repoRoot);
  if (sec && (sec.allowed === false || sec.allow === false)) {
    return { ok: false, error: sec.reason || (isEn ? 'Command blocked by Security Guard' : 'Команда заблокирована Security Guard') };
  }

  const tokens = parseCommandTokens(testCommand);
  if (tokens.length === 0 || !tokens[0]) {
    return { ok: false, error: isEn ? 'Failed to parse test command' : 'Не удалось разобрать команду тестирования' };
  }
  const bin = /^node(?:\.exe)?$/i.test(tokens[0]) ? process.execPath : tokens[0];
  const cmdArgs = tokens.slice(1);
  const stepTimeout = Number.isFinite(Number(safeOpts.timeoutMs))
    ? Math.max(1000, Math.min(60_000, Math.round(Number(safeOpts.timeoutMs))))
    : 20_000;

  let goodSha = '';
  let badSha = '';
  try {
    goodSha = String(execFileSync('git', ['rev-parse', '--verify', `${goodRef}^{commit}`], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 4000,
      windowsHide: true,
    }) || '').trim();
    badSha = String(execFileSync('git', ['rev-parse', '--verify', `${badRef}^{commit}`], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 4000,
      windowsHide: true,
    }) || '').trim();
  } catch (err) {
    return { ok: false, error: isEn ? `Failed to resolve Git revisions: ${err?.message || err}` : `Не удалось разрешить ревизии Git: ${err?.message || err}` };
  }

  const baseCache = asStr(safeOpts.cacheDir, 1024).trim() ? resolve(asStr(safeOpts.cacheDir, 1024).trim()) : DEFAULT_CACHE_DIR;
  if (!existsSync(baseCache)) mkdirSync(baseCache, { recursive: true });
  const wtDir = join(baseCache, `bisect-wt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);

  try {
    execFileSync('git', ['worktree', 'add', '--detach', wtDir, badSha], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const startOut = String(execFileSync('git', ['bisect', 'start', badSha, goodSha], {
      cwd: wtDir,
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }) || '');

    let culpritCommit = '';
    let stepsRun = 0;
    let lastBisectMsg = startOut.trim();
    const foundRx = /\b([0-9a-f]{40})\s+is\s+the\s+first\s+['"]?(?:bad|new)['"]?\s+commit/i;
    const startMatch = startOut.match(foundRx);
    if (startMatch) {
      culpritCommit = startMatch[1];
    }

    for (let i = 0; i < 16 && !culpritCommit; i++) {
      stepsRun += 1;
      const checkRun = spawnSync(bin, cmdArgs, {
        cwd: wtDir,
        encoding: 'utf8',
        timeout: stepTimeout,
        windowsHide: true,
        shell: false,
      });
      const exitCode = Number.isInteger(checkRun.status) ? checkRun.status : 1;
      const mark = exitCode === 0 ? 'good' : (exitCode === 125 ? 'skip' : 'bad');

      const stepOut = String(execFileSync('git', ['bisect', mark], {
        cwd: wtDir,
        encoding: 'utf8',
        timeout: 10_000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      }) || '');
      lastBisectMsg = stepOut.trim();
      const foundMatch = stepOut.match(foundRx);
      if (foundMatch) {
        culpritCommit = foundMatch[1];
        break;
      }
      if (/no more revisions/i.test(stepOut) || /bisect/i.test(stepOut) === false && !stepOut.includes('roughly')) {
        break;
      }
    }

    if (!culpritCommit) {
      return {
        ok: false,
        error: isEn
          ? `Bisect could not isolate the offending commit (${lastBisectMsg.slice(0, 140)})`
          : `Bisect не смог изолировать проблемный коммит (${lastBisectMsg.slice(0, 140)})`,
      };
    }

    const metaRaw = String(execFileSync('git', ['show', '--no-patch', '--format=%H%n%s%n%an', culpritCommit], {
      cwd: wtDir,
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    }) || '').trim();
    const [fullSha = culpritCommit, subject = '', author = ''] = metaRaw.split(/\r?\n/);
    const filesRaw = String(execFileSync('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', culpritCommit], {
      cwd: wtDir,
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    }) || '').trim();
    const changedFiles = filesRaw ? filesRaw.split(/\r?\n/).filter(Boolean) : [];

    return {
      ok: true,
      culpritCommit: fullSha,
      subject,
      author,
      changedFiles,
      stepsRun,
      logSummary: isEn
        ? `Found commit ${fullSha.slice(0, 8)} (${subject}) in ${stepsRun} steps`
        : `Найден коммит ${fullSha.slice(0, 8)} (${subject}) за ${stepsRun} шагов`,
    };
  } catch (err) {
    return { ok: false, error: String(err?.stderr || err?.message || err) };
  } finally {
    try {
      if (existsSync(wtDir)) {
        execFileSync('git', ['bisect', 'reset'], { cwd: wtDir, windowsHide: true, stdio: 'ignore', timeout: 4000 });
      }
    } catch {}
    try {
      execFileSync('git', ['worktree', 'remove', '--force', wtDir], { cwd: repoRoot, windowsHide: true, stdio: 'ignore', timeout: 6000 });
    } catch {}
    try {
      if (existsSync(wtDir)) {
        rmSync(wtDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
      }
    } catch {}
    try {
      execFileSync('git', ['worktree', 'prune'], { cwd: repoRoot, windowsHide: true, stdio: 'ignore', timeout: 4000 });
    } catch {}
  }
}

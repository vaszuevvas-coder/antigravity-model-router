/**
 * @file auto-verifier.mjs
 * @description Модуль локальной нуль-токенной авто-проверки синтаксиса (Auto-Verifier) и эскалации.
 * Проверяет изменённые файлы без обращения к LLM (через node --check, JSON.parse, vm.Script, py_compile).
 * При синтаксической ошибке регистрирует алерт в cascade-state.json для автоматической эскалации на модель Pro.
 */

import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import * as nodeModule from 'node:module';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import vm from 'node:vm';
import { atomicWriteJsonSync, safeReadJsonSync, updateJsonAtomicSync } from './safe-json.mjs';
import { beginCpuLiveWork, endCpuLiveWork, loadCpuConfig, resolveCpuThreadBudget } from './cpu-worker-pool.mjs';
import { localizeFaultWithV8Sbfl } from './cpu-sbfl-healer.mjs';

const execFileAsync = promisify(execFile);
const fastLinterDetectCache = new Map();
const FAST_LINTER_CACHE_TTL_MS = 60_000;
const FAST_LINTER_EXTS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx']);

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, '..');
const CACHE_DIR = join(PLUGIN_ROOT, '.cache');
const CASCADE_STATE_FILE = join(CACHE_DIR, 'cascade-state.json');
const SYNTAX_CACHE_FILE = join(CACHE_DIR, 'syntax-verified.json');
const SYNTAX_CACHE_TTL_MS = 5 * 60 * 1000;
const SYNTAX_CACHE_MAX_ENTRIES = 32;

const memVerifiedHashes = new Map();

/**
 * Обеспечивает существование директории кэша.
 */
function ensureCacheDir() {
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true });
  }
}

/**
 * Вычисляет SHA-1 ключ содержимого для кэша синтаксических проверок.
 */
function computeSyntaxSha1(ext, content) {
  return createHash('sha1').update(`${ext}::${content}`).digest('hex');
}

/**
 * Проверяет наличие предварительно подтверждённого SHA-1 в ОЗУ или .cache/syntax-verified.json.
 */
function hasVerifiedSyntaxHash(sha1) {
  const now = Date.now();
  const memTs = memVerifiedHashes.get(sha1);
  if (memTs && (now - memTs) < SYNTAX_CACHE_TTL_MS) {
    return true;
  }
  const disk = safeReadJsonSync(SYNTAX_CACHE_FILE, () => ({ hashes: {} }), { selfHeal: false });
  const diskTs = disk?.hashes && Object.hasOwn(disk.hashes, sha1) ? Number(disk.hashes[sha1]) : 0;
  if (diskTs > 0 && (now - diskTs) < SYNTAX_CACHE_TTL_MS) {
    memVerifiedHashes.set(sha1, diskTs);
    return true;
  }
  return false;
}

/**
 * Сохраняет успешный SHA-1 хеш содержимого в ОЗУ и .cache/syntax-verified.json (до 32 записей).
 */
function recordVerifiedSyntaxHash(sha1) {
  const now = Date.now();
  memVerifiedHashes.set(sha1, now);
  if (memVerifiedHashes.size > SYNTAX_CACHE_MAX_ENTRIES) {
    const oldestKey = memVerifiedHashes.keys().next().value;
    if (oldestKey) memVerifiedHashes.delete(oldestKey);
  }
  try {
    ensureCacheDir();
    updateJsonAtomicSync(SYNTAX_CACHE_FILE, () => ({ hashes: {} }), (cur) => {
      const hashes = (cur?.hashes && typeof cur.hashes === 'object' && !Array.isArray(cur.hashes))
        ? { ...cur.hashes }
        : {};
      for (const [k, ts] of Object.entries(hashes)) {
        if (!Number.isFinite(Number(ts)) || (now - Number(ts)) >= SYNTAX_CACHE_TTL_MS) {
          delete hashes[k];
        }
      }
      hashes[sha1] = now;
      const sorted = Object.entries(hashes).sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, SYNTAX_CACHE_MAX_ENTRIES);
      return { hashes: Object.fromEntries(sorted) };
    });
  } catch {}
}

/**
 * Загружает состояние каскада из cascade-state.json с автовосстановлением битого JSON.
 * @returns {{ activeAlert: object|null, lastCheckedAt?: string }}
 */
function loadCascadeState() {
  ensureCacheDir();
  const raw = safeReadJsonSync(CASCADE_STATE_FILE, () => ({ activeAlert: null }), { selfHeal: true });
  return (raw && typeof raw === 'object') ? raw : { activeAlert: null };
}

/**
 * Сохраняет состояние каскада в cascade-state.json атомарно через safe-json.
 * @param {object} state Состояние для сохранения.
 */
function saveCascadeState(state) {
  ensureCacheDir();
  atomicWriteJsonSync(CASCADE_STATE_FILE, state);
}

/**
 * Быстрая проверка JS-кода строго в ОЗУ (<0.5мс), при наличии ESM/await — fallback на node --input-type=module --check.
 */
function checkJsSyntaxFast(content, filename, extLabel = 'node --input-type=module --check') {
  const mayUseEsmOrTla = /\b(?:import|export)\b|\bawait\b/.test(content);
  if (!mayUseEsmOrTla) {
    try {
      new vm.Script(content, { filename: filename || 'in-memory.js' });
      return { valid: true, checked: true, checker: 'vm.Script (<1ms)', error: null };
    } catch {
      // Фолбэк ниже перепроверит ошибку через ESM-парсер (или вернёт диагностику)
    }
  }

  try {
    execFileSync(process.execPath, ['--input-type=module', '--check'], {
      input: content,
      timeout: 4000,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { valid: true, checked: true, checker: extLabel, error: null };
  } catch (err) {
    if (!/\b(?:import\s+|export\s+|import\()/m.test(content)) {
      try {
        new vm.Script(content, { filename: filename || 'in-memory.cjs' });
        return { valid: true, checked: true, checker: 'vm.Script (cjs fallback)', error: null };
      } catch {}
    }
    const errMsg = (err.stderr?.toString() || err.stdout?.toString() || err.message || '').trim();
    return {
      valid: false,
      checked: true,
      checker: extLabel,
      error: errMsg || 'JS syntax error',
    };
  }
}

/**
 * Нуль-токенная проверка синтаксиса строки содержимого строго в ОЗУ (без записи на диск).
 * Не триггерит файловые вотчеры и dev-серверы проекта.
 * @param {string} content Текстовое содержимое файла
 * @param {string} [filePath=''] Путь к файлу для определения расширения и имени
 * @returns {{ valid: boolean, checked: boolean, checker: string, error: string|null }}
 */
export function verifyContentSyntax(content, filePath = '') {
  if (content === null || content === undefined || typeof content !== 'string') {
    return { valid: true, checked: false, checker: 'none', error: null };
  }

  const ext = filePath ? extname(filePath).toLowerCase() : '';
  const sha1 = ext ? computeSyntaxSha1(ext, content) : '';

  // 1. JavaScript / ESM (.js, .mjs)
  if (ext === '.js' || ext === '.mjs') {
    const res = checkJsSyntaxFast(content, filePath || 'in-memory.mjs', 'node --input-type=module --check');
    if (res.valid && res.checked && sha1) recordVerifiedSyntaxHash(sha1);
    return res;
  }

  // 1b. TypeScript (.ts, .mts, .cts) via Node built-in stripTypeScriptTypes (skip ambient .d.ts/.d.mts/.d.cts declarations)
  if (ext === '.ts' || ext === '.mts' || ext === '.cts') {
    if (/\.d\.[cm]?ts$/i.test(filePath)) {
      return { valid: true, checked: false, checker: 'ts-declaration (skipped)', error: null };
    }
    if (typeof nodeModule.stripTypeScriptTypes !== 'function') {
      return { valid: true, checked: false, checker: 'ts-strip (unavailable)', error: null };
    }
    let stripped = '';
    try {
      stripped = nodeModule.stripTypeScriptTypes(content, { mode: 'strip' });
    } catch (err) {
      if (err?.code === 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX') {
        return { valid: true, checked: false, checker: 'ts-strip (skipped enum/ns)', error: null };
      }
      return {
        valid: false,
        checked: true,
        checker: 'node:module stripTypeScriptTypes',
        error: String(err?.message || err),
      };
    }
    const jsRes = checkJsSyntaxFast(
      stripped,
      filePath || 'in-memory.ts',
      'stripTypeScriptTypes + js-check'
    );
    if (jsRes.valid && jsRes.checked && sha1) recordVerifiedSyntaxHash(sha1);
    return jsRes;
  }

  // 2. CommonJS (.cjs)
  if (ext === '.cjs') {
    try {
      new vm.Script(content, { filename: filePath || 'in-memory.cjs' });
      if (sha1) recordVerifiedSyntaxHash(sha1);
      return { valid: true, checked: true, checker: 'vm.Script (.cjs)', error: null };
    } catch (err) {
      return {
        valid: false,
        checked: true,
        checker: 'vm.Script (.cjs)',
        error: String(err?.message || err),
      };
    }
  }

  // 3. JSON (.json)
  if (ext === '.json') {
    try {
      JSON.parse(content);
      if (sha1) recordVerifiedSyntaxHash(sha1);
      return { valid: true, checked: true, checker: 'JSON.parse', error: null };
    } catch (err) {
      return {
        valid: false,
        checked: true,
        checker: 'JSON.parse',
        error: String(err?.message || err),
      };
    }
  }

  // 4. HTML / HTM (.html, .htm) — извлечение встроенных скриптов
  if (ext === '.html' || ext === '.htm') {
    try {
      const scriptRegex = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
      let match;
      let scriptIndex = 0;
      let moduleSubprocessCount = 0;

      while ((match = scriptRegex.exec(content)) !== null) {
        scriptIndex += 1;
        const attrs = match[1] || '';
        const code = match[2] || '';

        // Пропускаем внешние скрипты с src="..."
        if (/\bsrc\s*=/i.test(attrs)) {
          continue;
        }

        // Пропускаем нестандартные типы (json, template и т.д.)
        if (/\btype\s*=\s*["']?(?!module|text\/javascript|application\/javascript)[a-zA-Z0-9_\/-]+/i.test(attrs)) {
          continue;
        }

        if (!code.trim()) continue;

        try {
          if (/\btype\s*=\s*["']?module\b/i.test(attrs)) {
            if (!/\b(?:import|export)\b|\bawait\b/.test(code)) {
              new vm.Script(code, { filename: `${filePath || 'inline'}#inline_script_${scriptIndex}` });
            } else if (moduleSubprocessCount < 3) {
              moduleSubprocessCount += 1;
              execFileSync(process.execPath, ['--input-type=module', '--check'], {
                input: code,
                timeout: 4000,
                windowsHide: true,
                stdio: ['pipe', 'pipe', 'pipe'],
              });
            }
          } else {
            new vm.Script(code, { filename: `${filePath || 'inline'}#inline_script_${scriptIndex}` });
          }
        } catch (scriptErr) {
          const errMsg = scriptErr?.stderr?.toString() || scriptErr?.stdout?.toString() || scriptErr?.message || String(scriptErr);
          return {
            valid: false,
            checked: true,
            checker: /\btype\s*=\s*["']?module\b/i.test(attrs) ? `node --check (inline #${scriptIndex} module)` : `vm.Script (inline #${scriptIndex})`,
            error: errMsg.trim(),
          };
        }
      }

      if (scriptIndex > 0 && sha1) recordVerifiedSyntaxHash(sha1);
      return { valid: true, checked: scriptIndex > 0, checker: 'vm.Script (html in-memory)', error: null };
    } catch (err) {
      return {
        valid: false,
        checked: true,
        checker: 'html-parser',
        error: String(err?.message || err),
      };
    }
  }

  // 5. Python (.py)
  if (ext === '.py') {
    try {
      execFileSync('python', ['-c', 'import ast, sys; ast.parse(sys.stdin.read())'], {
        input: content,
        timeout: 4000,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      });
      return { valid: true, checked: true, checker: 'python-ast', error: null };
    } catch (err) {
      const errMsg = (err.stderr?.toString() || err.stdout?.toString() || err.message || '').trim();
      const isRealSyntaxErr = /(?:SyntaxError|IndentationError|TabError|Traceback|ValueError|File\s+")/i.test(errMsg);
      if (err.code === 'ENOENT' || err.code === 'EACCES' || err.status === 9009 || err.status === 49 || !isRealSyntaxErr) {
        return { valid: true, checked: false, checker: 'python-ast (missing)', error: null };
      }
      return {
        valid: false,
        checked: true,
        checker: 'python-ast',
        error: errMsg || 'Python syntax error',
      };
    }
  }

  return { valid: true, checked: false, checker: 'none', error: null };
}

/**
 * Нуль-токенная локальная проверка синтаксиса файла без вызова LLM.
 * Использует in-process кэш SHA-1 (избегает дублирующего запуска node --check в PostToolUse после PreToolUse).
 * @param {string} filePath Путь к проверяемому файлу.
 * @returns {{ valid: boolean, checked: boolean, checker: string, error: string|null }}
 */
export function verifyFileSyntax(filePath) {
  if (!filePath || typeof filePath !== 'string') {
    return { valid: true, checked: false, checker: 'none', error: null };
  }

  const absPath = resolve(filePath);
  if (!existsSync(absPath)) {
    return { valid: false, checked: true, checker: 'fs', error: `File not found: ${absPath}` };
  }

  const ext = extname(absPath).toLowerCase();
  const inProcExts = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.json', '.html', '.htm']);

  if (inProcExts.has(ext)) {
    try {
      const st = statSync(absPath);
      if (!st.isFile()) {
        return { valid: false, checked: true, checker: 'fs', error: `Not a file: ${absPath}` };
      }
      if (st.size > 4 * 1024 * 1024) {
        return { valid: true, checked: false, checker: 'skip (>4MB)', error: null };
      }
      const rawContent = readFileSync(absPath, 'utf-8');
      const sha1 = computeSyntaxSha1(ext, rawContent);
      if (hasVerifiedSyntaxHash(sha1)) {
        return { valid: true, checked: true, checker: 'sha1-cache (pre-verified)', error: null };
      }
      return verifyContentSyntax(rawContent, absPath);
    } catch (err) {
      return {
        valid: false,
        checked: true,
        checker: 'fs',
        error: String(err?.message || err),
      };
    }
  }

  // Python (.py)
  if (ext === '.py') {
    try {
      execFileSync('python', ['-m', 'py_compile', absPath], {
        timeout: 4000,
        windowsHide: true,
        stdio: 'pipe',
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      });
      return { valid: true, checked: true, checker: 'python -m py_compile', error: null };
    } catch (err) {
      const errMsg = (err.stderr?.toString() || err.stdout?.toString() || err.message || '').trim();
      const isRealSyntaxErr = /(?:SyntaxError|IndentationError|TabError|Traceback|ValueError|File\s+")/i.test(errMsg);
      if (err.code === 'ENOENT' || err.code === 'EACCES' || err.status === 9009 || err.status === 49 || !isRealSyntaxErr) {
        return { valid: true, checked: false, checker: 'python -m py_compile (missing)', error: null };
      }
      return {
        valid: false,
        checked: true,
        checker: 'python -m py_compile',
        error: errMsg || 'Python syntax error',
      };
    }
  }

  // Для остальных расширений (.css, .md, .txt и др.)
  return { valid: true, checked: false, checker: 'none', error: null };
}

/**
 * Проверяет синтаксис файла и обновляет состояние авто-эскалации в cascade-state.json.
 * @param {object} params Параметры проверки.
 * @param {string} params.filePath Путь к файлу.
 * @param {string} [params.conversationId=''] ID диалога.
 * @param {string} [params.modelName=''] Имя активной модели.
 * @returns {{ valid: boolean, checked: boolean, checker: string, error: string|null, escalated: boolean }}
 */
const CASCADE_TTL_MS = 30 * 60 * 1000;

function normalizeCascadeStore(raw) {
  const now = Date.now();
  const alerts = {};
  if (raw && typeof raw === 'object') {
    if (raw.alerts && typeof raw.alerts === 'object' && !Array.isArray(raw.alerts)) {
      for (const [k, v] of Object.entries(raw.alerts)) {
        if (!v || !v.filePath) continue;
        const ts = v.failedAt ? Date.parse(v.failedAt) : 0;
        if (!ts || now - ts <= CASCADE_TTL_MS) {
          alerts[k] = v;
        }
      }
    } else if (raw.activeAlert && raw.activeAlert.filePath) {
      const key = String(raw.activeAlert.conversationId || 'default').trim() || 'default';
      const ts = raw.activeAlert.failedAt ? Date.parse(raw.activeAlert.failedAt) : 0;
      if (!ts || now - ts <= CASCADE_TTL_MS) {
        alerts[key] = raw.activeAlert;
      }
    }
  }
  return { alerts, lastCheckedAt: raw?.lastCheckedAt || null };
}

export function recordVerifyAndCheckCascade({ filePath, conversationId = '', modelName = '' }) {
  const result = verifyFileSyntax(filePath);
  const absPath = resolve(filePath);
  const convKey = String(conversationId || 'default').trim() || 'default';

  if (!result.valid) {
    ensureCacheDir();
    // Atomic locked RMW prevents overwriting concurrent cascade updates across subagents
    updateJsonAtomicSync(CASCADE_STATE_FILE, () => ({ alerts: {} }), (raw) => {
      const state = normalizeCascadeStore(raw);
      const nowIso = new Date().toISOString();
      state.alerts[convKey] = {
        filePath: absPath,
        checker: result.checker,
        error: String(result.error || '').slice(0, 600),
        failedAt: nowIso,
        conversationId: String(conversationId || ''),
        modelName: String(modelName || ''),
        escalateTo: 'pro',
      };
      state.lastCheckedAt = nowIso;
      return state;
    });
  } else {
    const existing = normalizeCascadeStore(loadCascadeState());
    const norm = (p) => (process.platform === 'win32' ? String(p || '').toLowerCase() : String(p || ''));
    const curAlert = existing.alerts[convKey];
    if (curAlert && norm(curAlert.filePath) === norm(absPath)) {
      ensureCacheDir();
      updateJsonAtomicSync(CASCADE_STATE_FILE, () => ({ alerts: {} }), (raw) => {
        const state = normalizeCascadeStore(raw);
        if (state.alerts[convKey] && norm(state.alerts[convKey].filePath) === norm(absPath)) {
          delete state.alerts[convKey];
          state.lastCheckedAt = new Date().toISOString();
        }
        return state;
      });
    }
  }

  return {
    ...result,
    escalated: !result.valid,
  };
}

/**
 * Formats live LSP diagnostics returned by /hook/post-edit into a compact PostToolUse hint.
 * @param {string} [filePath='']
 * @param {object} [lspRes={}]
 * @returns {string}
 */
export function formatLspDiagnosticsHint(filePath = '', lspRes = {}) {
  const safeRes = lspRes && typeof lspRes === 'object' && !Array.isArray(lspRes) ? lspRes : {};
  const rawAlert = typeof safeRes.lspAlert === 'string' ? safeRes.lspAlert.trim() : '';
  const diags = Array.isArray(safeRes.lspDiagnostics)
    ? safeRes.lspDiagnostics
    : (Array.isArray(safeRes.diagnostics) ? safeRes.diagnostics : []);
  const errors = diags.filter((d) => d && Number(d.severity) === 1);
  if (rawAlert) {
    const clean = rawAlert.replace(/^🧬\s*/, '').trim();
    return /^\[LSP Type Check\]/i.test(clean) ? `🧬 ${clean}` : `🧬 [LSP Type Check] ${clean}`;
  }
  if (errors.length === 0) return '';
  const fileLabel = filePath ? basename(String(filePath)) : 'file';
  const summary = errors
    .slice(0, 3)
    .map((d) => `L${Number(d.line || 1)}:${Number(d.character || 1)} ${String(d.message || '').trim()}`)
    .join(' | ');
  return `🧬 [LSP Type Check] ${fileLabel}: ${summary}`.slice(0, 420);
}

/**
 * Просматривает текущий активный алерт каскада без удаления.
 * @param {string} [conversationId=''] Ключ диалога/воркера для изоляции
 * @returns {object|null} Активный алерт или null.
 */
export function peekCascadeAlert(conversationId = '') {
  const state = normalizeCascadeStore(loadCascadeState());
  if (conversationId) {
    return state.alerts[String(conversationId).trim()] || null;
  }
  return state.alerts.default || Object.values(state.alerts)[0] || null;
}

/**
 * Извлекает и очищает активный алерт каскада (для инъекции в следующий промпт).
 * @param {string} [conversationId=''] Ключ диалога/воркера для изоляции
 * @returns {object|null} Извлечённый алерт или null.
 */
export function popCascadeAlert(conversationId = '') {
  const key = String(conversationId || '').trim();
  const current = normalizeCascadeStore(loadCascadeState());
  const hasCandidate = key ? Boolean(current.alerts[key]) : Object.keys(current.alerts).length > 0;
  if (!hasCandidate) return null;
  let popped = null;
  ensureCacheDir();
  updateJsonAtomicSync(CASCADE_STATE_FILE, () => ({ alerts: {} }), (raw) => {
    const state = normalizeCascadeStore(raw);
    const targetKey = key || (state.alerts.default ? 'default' : Object.keys(state.alerts)[0]);
    if (targetKey && state.alerts[targetKey]) {
      popped = state.alerts[targetKey];
      delete state.alerts[targetKey];
      state.lastCheckedAt = new Date().toISOString();
    }
    return state;
  });
  return popped;
}

/**
 * Выявляет локальные микро-тесты, затронутые изменением целевого файла (Test-Impact Discovery, Модуль #5).
 * Ищет прямые парные тесты и тесты среди обратных импортёров (до 2 файлов).
 * @param {string} [rootDir=process.cwd()] Корневая папка проекта
 * @param {string} targetFilePath Путь к изменённому файлу
 * @param {Array<string|object>} [reverseImporters=[]] Массив обратных импортёров
 * @returns {string[]} До 2 абсолютных путей к существующим тестовым файлам
 */
export function discoverImpactedTests(rootDir = process.cwd(), targetFilePath = '', reverseImporters = [], maxTests = 6) {
  if (!targetFilePath || typeof targetFilePath !== 'string') {
    return [];
  }
  const limit = Math.max(1, Math.min(12, Number(maxTests) || 6));

  const absRoot = resolve(rootDir);
  const absTarget = resolve(absRoot, targetFilePath);
  const normKey = (p) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
  const targetKey = normKey(absTarget);
  const targetDir = dirname(absTarget);
  const targetExt = extname(absTarget);
  const targetBase = basename(absTarget);
  const stem = targetExt ? targetBase.slice(0, targetBase.length - targetExt.length) : targetBase;

  // Кандидаты парных тестов
  const candidateNames = [
    `${stem}.test.mjs`,
    `${stem}.test.js`,
    `${stem}.test.cjs`,
    `${stem}.spec.mjs`,
    `${stem}.spec.js`,
    `${stem}.spec.cjs`,
    `test_${stem}.py`,
    `${stem}_test.py`,
  ];

  const searchDirs = [
    targetDir,
    join(targetDir, 'tests'),
    join(targetDir, 'test'),
    join(targetDir, '__tests__'),
    join(absRoot, 'tests'),
    join(absRoot, 'test'),
    join(absRoot, '__tests__'),
  ];

  // Зеркальная структура в тестовых папках репозитория (корректно и для абсолютных путей на Windows)
  const relFromRoot = relative(absRoot, absTarget).replace(/\\/g, '/');
  if (relFromRoot && !relFromRoot.startsWith('..') && !isAbsolute(relFromRoot)) {
    const relDir = dirname(relFromRoot);
    if (relDir && relDir !== '.') {
      searchDirs.push(join(absRoot, 'tests', relDir));
      searchDirs.push(join(absRoot, 'test', relDir));
      searchDirs.push(join(absRoot, '__tests__', relDir));
    }
  }

  const foundTests = new Map();
  const addFoundTest = (candidatePath) => {
    const key = normKey(candidatePath);
    if (key === targetKey || foundTests.has(key)) return false;
    if (existsSync(candidatePath)) {
      try {
        if (statSync(candidatePath).isFile()) {
          foundTests.set(key, candidatePath);
          return true;
        }
      } catch {}
    }
    return false;
  };

  // Если сам targetFilePath уже является тестовым файлом и существует на диске — сразу включаем его первым элементом
  const isDirectTest = /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(targetBase) || /^(?:test_.*|.*_test)\.py$/i.test(targetBase);
  if (isDirectTest && existsSync(absTarget)) {
    try {
      if (statSync(absTarget).isFile()) {
        foundTests.set(targetKey, absTarget);
      }
    } catch {}
  }

  // а) Поиск прямых парных файлов рядом или в test-папках
  for (const dir of searchDirs) {
    for (const name of candidateNames) {
      if (addFoundTest(resolve(dir, name)) && foundTests.size >= limit) {
        break;
      }
    }
    if (foundTests.size >= limit) break;
  }

  // б) Поиск среди файлов массива reverseImporters
  if (foundTests.size < limit && Array.isArray(reverseImporters)) {
    for (const item of reverseImporters) {
      const itemPath = typeof item === 'string' ? item : item?.file;
      if (!itemPath || typeof item !== 'undefined' && typeof itemPath !== 'string') continue;

      const norm = itemPath.replace(/\\/g, '/');
      const normRel = isAbsolute(itemPath)
        ? relative(absRoot, resolve(itemPath)).replace(/\\/g, '/')
        : norm.replace(/^\.\//, '');
      const base = basename(norm).toLowerCase();

      // Защита: не запускаем сквозные e2e сценарии, если они не названы .test. / .spec.
      if (
        (/(?:^|\/)scratch\/e2e/i.test(normRel) || base.startsWith('e2e_') || base.startsWith('e2e.')) &&
        !base.includes('.test.') &&
        !base.includes('.spec.')
      ) {
        continue;
      }

      const isTestFile =
        base.includes('.test.') ||
        base.includes('.spec.') ||
        base.startsWith('test_') ||
        base.includes('_test.');

      if (isTestFile && addFoundTest(resolve(absRoot, itemPath)) && foundTests.size >= limit) {
        break;
      }
    }
  }

  return Array.from(foundTests.values()).slice(0, limit);
}

export function formatCompactProcessError(err, fallbackMsg = 'Process failed') {
  const rawMsg = (err?.stderr?.toString() || err?.stdout?.toString() || err?.message || '').trim();
  const lines = rawMsg.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const filteredLines = lines.filter(
    (l) =>
      !/^[ℹi]\s+(?:tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\b/i.test(l) &&
      !/^(?:[✔✓]|ok\s+\d+\b|TAP\s+version)/i.test(l)
  );
  const pool = filteredLines.length > 0 ? filteredLines : lines;
  const errHeader =
    pool.find((l) => /(?:AssertionError|TypeError|SyntaxError|ReferenceError|RangeError|\bError:|error\[)/i.test(l)) ||
    pool.find((l) => /(?:✖|not ok\b|\bFAIL\b)/i.test(l)) ||
    pool[0] ||
    '';
  const frameLine =
    pool.find((l) => /^at\s+/.test(l) && !l.includes('node:internal')) ||
    pool.find((l) => /^at\s+/.test(l)) ||
    '';
  const smartSummary = [errHeader, frameLine].filter(Boolean).join(' | ');
  if (smartSummary.length >= 12) return smartSummary.slice(0, 450);
  return (rawMsg.length > 450 ? rawMsg.slice(0, 450) : rawMsg) || fallbackMsg;
}

/**
 * Detects local multi-threaded oxlint or biome binary in workspace (cached 60s).
 * @param {string} rootDir
 * @returns {{ tool: 'oxlint'|'biome', bin: string } | null}
 */
export function detectWorkspaceFastLinter(rootDir = process.cwd()) {
  const absRoot = resolve(rootDir);
  const cacheKey = process.platform === 'win32' ? absRoot.toLowerCase() : absRoot;
  const cached = fastLinterDetectCache.get(cacheKey);
  const now = Date.now();
  if (cached && now - cached.ts < FAST_LINTER_CACHE_TTL_MS) {
    return cached.spec;
  }

  const isWin = process.platform === 'win32';
  const oxBin = join(absRoot, 'node_modules', '.bin', isWin ? 'oxlint.cmd' : 'oxlint');
  const biomeBin = join(absRoot, 'node_modules', '.bin', isWin ? 'biome.cmd' : 'biome');
  let spec = null;

  if (existsSync(oxBin)) {
    spec = { tool: 'oxlint', bin: oxBin };
  } else if (existsSync(join(absRoot, '.oxlintrc.json')) || existsSync(join(absRoot, '.oxlintrc.jsonc')) || existsSync(join(absRoot, 'oxlint.config.ts'))) {
    spec = { tool: 'oxlint', bin: isWin ? 'oxlint.cmd' : 'oxlint' };
  } else if (existsSync(biomeBin)) {
    spec = { tool: 'biome', bin: biomeBin };
  } else if (existsSync(join(absRoot, 'biome.json')) || existsSync(join(absRoot, 'biome.jsonc'))) {
    spec = { tool: 'biome', bin: isWin ? 'biome.cmd' : 'biome' };
  }

  fastLinterDetectCache.set(cacheKey, { ts: now, spec });
  return spec;
}

/**
 * Runs fast local multi-threaded oxlint/biome precheck on edited file (<= 1200ms).
 */
export async function runFastLinterPrecheck({
  rootDir = process.cwd(),
  filePath = '',
  timeoutMs = 1200,
  linterSpec = null,
  signal = undefined,
} = {}) {
  if (!filePath || typeof filePath !== 'string') {
    return { ran: false, valid: true, tool: null, durationMs: 0, error: null };
  }
  const targetAbs = resolve(rootDir, filePath);
  const ext = extname(targetAbs).toLowerCase();
  if (!FAST_LINTER_EXTS.has(ext) || !existsSync(targetAbs)) {
    return { ran: false, valid: true, tool: null, durationMs: 0, error: null };
  }

  const spec = linterSpec || detectWorkspaceFastLinter(rootDir);
  if (!spec) {
    return { ran: false, valid: true, tool: null, durationMs: 0, error: null };
  }

  const budget = Math.min(1200, Math.max(150, Number(timeoutMs) || 1200));
  const args = spec.tool === 'oxlint'
    ? ['--quiet', targetAbs]
    : ['check', '--diagnostic-level=error', targetAbs];
  const t0 = Date.now();
  try {
    const isWinCmd = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(spec.bin);
    const quoteCmdArg = (s) => `"${String(s).replace(/"/g, '""')}"`;
    const runBin = isWinCmd ? (process.env.ComSpec || 'cmd.exe') : spec.bin;
    const runArgs = isWinCmd
      ? ['/d', '/s', '/c', `"${[quoteCmdArg(spec.bin), ...args.map(quoteCmdArg)].join(' ')}"`]
      : args;
    await execFileAsync(runBin, runArgs, {
      cwd: rootDir,
      timeout: budget,
      signal,
      windowsHide: true,
      windowsVerbatimArguments: isWinCmd,
    });
    return { ran: true, valid: true, tool: spec.tool, durationMs: Date.now() - t0, error: null };
  } catch (err) {
    if (err?.name === 'AbortError' || signal?.aborted) {
      return { ran: false, valid: true, tool: spec.tool, durationMs: Date.now() - t0, aborted: true, error: null };
    }
    if (err?.code === 'ENOENT') {
      return { ran: false, valid: true, tool: null, durationMs: Date.now() - t0, error: null };
    }
    return {
      ran: true,
      valid: false,
      tool: spec.tool,
      durationMs: Date.now() - t0,
      error: formatCompactProcessError(err, `${spec.tool} failed`),
    };
  }
}

/**
 * Запускает выявленные локальные микро-тесты параллельно на пуле потоков с опциональным быстрым линтером.
 * При сбое немедленно прерывает соседние дочерние процессы и фиксирует алерт в cascade-state.json.
 * @returns {Promise<{ ran: boolean, valid: boolean, testFiles: string[], durationMs: number, parallelWorkersUsed?: number, linterResult?: object|null, error: string|null }>}
 */
export async function runImpactedMicroTests({
  rootDir = process.cwd(),
  filePath = '',
  reverseImporters = [],
  timeoutMs = 4500,
  runLinterPrecheck = true,
  linterSpec = null,
} = {}) {
  const cpuCfg = loadCpuConfig();
  const limit = cpuCfg.cpuParallelVerify ? 6 : 2;
  const testFiles = discoverImpactedTests(rootDir, filePath, reverseImporters, limit);
  const resolvedLinter = runLinterPrecheck ? (linterSpec || detectWorkspaceFastLinter(rootDir)) : null;

  if ((!testFiles || testFiles.length === 0) && !resolvedLinter) {
    return { ran: false, valid: true, timedOut: false, testFiles: [], durationMs: 0, error: null };
  }

  const startTime = Date.now();
  const totalBudgetMs = Math.min(6000, Math.max(800, Number(timeoutMs) || 4500));
  const tasks = [];

  for (const testPath of testFiles) {
    const ext = extname(testPath).toLowerCase();
    if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
      let src = '';
      try {
        src = readFileSync(testPath, 'utf8');
      } catch {}
      const usesNodeTest = /(?:from\s+['"]node:test['"]|require\s*\(\s*['"]node:test['"]\s*\))/.test(src);
      const usesVitestOrJest =
        !usesNodeTest &&
        (/(?:from\s+['"](?:vitest|@jest\/globals)['"]|require\s*\(\s*['"]@jest\/globals['"]\s*\))/.test(src) ||
          (/\b(?:describe|it)\s*\(/.test(src) && /\b(?:expect|beforeEach|afterEach)\b/.test(src)));
      if (usesVitestOrJest) continue;
      const nodeArgs = usesNodeTest ? ['--test', testPath] : [testPath];
      tasks.push({ kind: 'node', testPath, bin: process.execPath, args: nodeArgs });
    } else if (ext === '.py') {
      tasks.push({
        kind: 'python',
        testPath,
        bin: 'python',
        args: ['-m', 'pytest', '-q', testPath],
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      });
    }
  }

  const ac = new AbortController();
  const concurrency = cpuCfg.cpuParallelVerify ? Math.max(1, resolveCpuThreadBudget(cpuCfg)) : 1;
  let actuallyRanCount = 0;
  let firstFailure = null;
  let linterResult = null;
  let timedOut = false;
  const passedTestPaths = [];

  const linterPromise = (resolvedLinter && filePath)
    ? runFastLinterPrecheck({
        rootDir,
        filePath,
        timeoutMs: Math.min(1200, totalBudgetMs),
        linterSpec: resolvedLinter,
        signal: ac.signal,
      }).then((lr) => {
        linterResult = lr;
        if (lr.ran && !lr.valid && !firstFailure) {
          firstFailure = {
            checker: `fast-lint (${lr.tool})`,
            error: lr.error || `${lr.tool} error`,
          };
          ac.abort();
        }
      })
    : Promise.resolve();

  let cursor = 0;
  const workerCount = Math.min(concurrency, tasks.length);
  const runners = Array.from({ length: workerCount }, async () => {
    while (cursor < tasks.length && !ac.signal.aborted) {
      const idx = cursor++;
      const task = tasks[idx];
      const remainingMs = totalBudgetMs - (Date.now() - startTime);
      if (remainingMs < 150) break;
      actuallyRanCount += 1;
      try {
        const childEnv = { ...(task.env || process.env) };
        delete childEnv.NODE_TEST_CONTEXT;
        await execFileAsync(task.bin, task.args, {
          cwd: rootDir,
          timeout: Math.max(150, remainingMs),
          env: childEnv,
          signal: ac.signal,
          windowsHide: true,
        });
        if (task.kind === 'node') passedTestPaths.push(task.testPath);
      } catch (err) {
        if (err?.name === 'AbortError' || ac.signal.aborted) {
          break;
        }
        const rawErrOut = `${err?.stderr?.toString() || ''}\n${err?.stdout?.toString() || ''}`;
        const hasExplicitTestFail =
          /[✖✗×]|\bnot ok\b|\b(?:AssertionError|SyntaxError|TypeError|ReferenceError)\b|(?:^|\s)(?:fail(?:ed)?|ERROR):/im.test(
            rawErrOut
          );
        const isProcessTimeout =
          err?.killed === true ||
          err?.signal === 'SIGTERM' ||
          err?.code === 'ETIMEDOUT' ||
          /\btimed?\s*out\b/i.test(err?.message || '');
        if (isProcessTimeout && !hasExplicitTestFail) {
          timedOut = true;
          actuallyRanCount = Math.max(0, actuallyRanCount - 1);
          ac.abort();
          break;
        }
        if (task.kind === 'python') {
          const pyMsg = (err?.stderr?.toString() || err?.stdout?.toString() || err?.message || '').trim();
          const missingPyOrPytest =
            err?.code === 'ENOENT' ||
            err?.code === 'EACCES' ||
            err?.status === 9009 ||
            err?.status === 49 ||
            /No module named pytest/i.test(pyMsg);
          if (missingPyOrPytest) {
            actuallyRanCount -= 1;
            continue;
          }
        }
        if (!firstFailure) {
          firstFailure = {
            checker: `test-impact (${basename(task.testPath)})`,
            failedTestPath: task.testPath,
            error: formatCompactProcessError(err, 'Micro-test failed'),
          };
          ac.abort();
        }
        break;
      }
    }
  });

  const activeVerifyThreads = Math.max(1, workerCount + (resolvedLinter && filePath ? 1 : 0));
  const verifyDetailRu = tasks.length > 0
    ? `Параллельная проверка (${tasks.length} микро-тест.)`
    : 'Быстрый линтер-пречек';
  const liveCpuTicket = (tasks.length > 0 || (resolvedLinter && filePath))
    ? beginCpuLiveWork({
        op: 'parallel_verify',
        workers: activeVerifyThreads,
        items: tasks.length || 1,
        detail: verifyDetailRu,
      })
    : null;
  try {
    await Promise.all([linterPromise, ...runners]);
  } finally {
    if (liveCpuTicket) {
      endCpuLiveWork(liveCpuTicket.jobId, {
        op: 'parallel_verify',
        workers: activeVerifyThreads,
        items: tasks.length || 1,
        detail: verifyDetailRu,
        latencyMs: Date.now() - startTime,
      });
    }
  }

  let sbflSuspects = [];
  if (
    firstFailure &&
    firstFailure.failedTestPath &&
    cpuCfg.cpuParallelVerify &&
    cpuCfg.cpuSotaEngines !== false &&
    !timedOut &&
    extname(firstFailure.failedTestPath).toLowerCase() !== '.py'
  ) {
    const sbflRemain = (totalBudgetMs + 1500) - (Date.now() - startTime);
    if (sbflRemain >= 600) {
      try {
        const peerTests = passedTestPaths.length > 0
          ? passedTestPaths.slice(0, 2)
          : tasks
              .filter((t) => t.kind === 'node' && t.testPath !== firstFailure.failedTestPath)
              .map((t) => t.testPath)
              .slice(0, 2);
        const sbfl = await localizeFaultWithV8Sbfl({
          rootDir,
          failingTestPath: firstFailure.failedTestPath,
          passingTestPaths: peerTests,
          editedFile: filePath,
          timeoutMs: Math.min(2200, sbflRemain),
        });
        if (sbfl?.ok && sbfl.formattedPin) {
          sbflSuspects = sbfl.suspects || [];
          firstFailure.error = `${firstFailure.error} | ${sbfl.formattedPin}`;
        }
      } catch {}
    }
  }
  const durationMs = Date.now() - startTime;

  if (firstFailure) {
    const targetAbs = filePath ? resolve(rootDir, filePath) : (testFiles[0] || rootDir);
    ensureCacheDir();
    updateJsonAtomicSync(CASCADE_STATE_FILE, () => ({ activeAlert: null }), (raw) => {
      const state = raw && typeof raw === 'object' ? { ...raw } : { activeAlert: null };
      const nowIso = new Date().toISOString();
      state.activeAlert = {
        filePath: targetAbs,
        checker: firstFailure.checker,
        error: firstFailure.error,
        failedAt: nowIso,
        escalateTo: 'pro',
      };
      state.lastCheckedAt = nowIso;
      return state;
    });

    return {
      ran: true,
      valid: false,
      timedOut: false,
      testFiles,
      durationMs,
      parallelWorkersUsed: workerCount,
      linterResult,
      sbflSuspects,
      error: firstFailure.error,
    };
  }

  return {
    ran: actuallyRanCount > 0 || Boolean(linterResult?.ran),
    valid: true,
    timedOut,
    testFiles,
    durationMs,
    parallelWorkersUsed: workerCount,
    linterResult,
    error: null,
  };
}

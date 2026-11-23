/**
 * @file cpu-mutation-guard.mjs
 * @description Изолированный CPU Semantic Mutation Guard (проверка качества тестов на 1-точечных мутантах).
 * Всегда копирует файлы во временную директорию ОС и НИКОГДА не модифицирует исходный файл в рабочем проекте.
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';

const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const SKIP_DIRS = new Set(['.git', 'node_modules', '.cache', 'dist', 'build', '.next', 'coverage', '.venv', 'venv', 'target', 'scratch']);
const MUTABLE_EXTS = new Set(['.mjs', '.js', '.cjs']);
const BINARY_SKIP_EXTS = new Set(['.exe', '.dll', '.so', '.dylib', '.node', '.wasm', '.zip', '.tar', '.gz', '.7z', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico', '.mp4', '.mp3', '.wav', '.pdf', '.db', '.sqlite', '.sqlite3', '.bin', '.pack']);
const MAX_SUPPORT_FILE_BYTES = 2 * 1024 * 1024;

const MUTATION_RULES = [
  { rx: />=/, original: '>=', mutated: '>' },
  { rx: /<=/, original: '<=', mutated: '<' },
  { rx: /===/, original: '===', mutated: '!==' },
  { rx: /!==/, original: '!==', mutated: '===' },
  { rx: /\+\s*1\b/, original: '+ 1', mutated: '- 1' },
  { rx: /&&/, original: '&&', mutated: '||' },
];

function asObj(val) {
  return val && typeof val === 'object' && !Array.isArray(val) ? val : {};
}

function asStr(val, maxLen = 1024) {
  if (typeof val !== 'string') return '';
  return val.replace(/\0/g, '').slice(0, maxLen);
}

/**
 * Генерирует безопасные 1-точечные граничные мутации исходного кода в памяти.
 * @param {string} [sourceCode='']
 * @param {number} [maxMutants=4]
 * @returns {Array<object>}
 */
export function generateBoundaryMutants(sourceCode = '', maxMutants = 4) {
  if (typeof sourceCode !== 'string' || !sourceCode.trim()) return [];
  const cap = Number.isFinite(Number(maxMutants)) ? Math.max(1, Math.min(12, Math.round(Number(maxMutants)))) : 4;
  const lines = sourceCode.split(/\r?\n/);
  const mutants = [];
  let inBlockComment = false;

  for (let i = 0; i < lines.length && mutants.length < cap; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    if (inBlockComment) {
      if (trimmed.includes('*/')) inBlockComment = false;
      continue;
    }
    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/')) inBlockComment = true;
      continue;
    }
    if (trimmed.startsWith('//') || /^(?:import|export\s+\*|const\s+__|let\s+__|var\s+__)/.test(trimmed)) continue;
    // Skip lines containing regex literals or purely string quotes to avoid syntax errors
    if (/['"`]/.test(trimmed) || /\/[^\s/]+\/[gimuy]*/.test(trimmed)) continue;
    // Focus on conditional / return / arithmetic logic lines
    if (!/\b(?:if|return|while|for)\b|[<>!=]=|&&|\+\s*1\b/.test(trimmed)) continue;

    for (const rule of MUTATION_RULES) {
      if (!rule.rx.test(rawLine)) continue;
      const mutatedLine = rawLine.replace(rule.rx, rule.mutated);
      if (mutatedLine === rawLine) continue;
      const cloneLines = [...lines];
      cloneLines[i] = mutatedLine;
      mutants.push({
        id: `mut_${mutants.length + 1}_L${i + 1}`,
        line: i + 1,
        original: trimmed.slice(0, 120),
        mutated: mutatedLine.trim().slice(0, 120),
        operator: `${rule.original} -> ${rule.mutated}`,
        mutatedCode: cloneLines.join('\n'),
      });
      break;
    }
  }
  return mutants;
}

function copyWorkspaceSubsetToTemp(wsRoot, tempRoot) {
  let copiedCount = 0;
  const maxCopyFiles = 1500;
  const queue = [wsRoot];
  let qHead = 0;

  while (qHead < queue.length && copiedCount < maxCopyFiles) {
    const dir = queue[qHead++];
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (copiedCount >= maxCopyFiles) break;
      if (ent.isDirectory()) {
        if (!SKIP_DIRS.has(ent.name)) queue.push(join(dir, ent.name));
      } else if (ent.isFile()) {
        const ext = extname(ent.name).toLowerCase();
        if (BINARY_SKIP_EXTS.has(ext)) continue;
        const isCodeOrPkg = MUTABLE_EXTS.has(ext) || ent.name === 'package.json';
        const src = join(dir, ent.name);
        if (!isCodeOrPkg) {
          try {
            if (statSync(src).size > MAX_SUPPORT_FILE_BYTES) continue;
          } catch {
            continue;
          }
        }
        const rel = relative(wsRoot, src);
        const dst = join(tempRoot, rel);
        try {
          mkdirSync(dirname(dst), { recursive: true });
          copyFileSync(src, dst);
          copiedCount += 1;
        } catch {}
      }
    }
  }

  const nmSrc = join(wsRoot, 'node_modules');
  const nmDst = join(tempRoot, 'node_modules');
  if (existsSync(nmSrc) && !existsSync(nmDst)) {
    try {
      symlinkSync(nmSrc, nmDst, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {}
  }
}

function resolveMatchingTestRelPath(wsRoot, relSource, explicitTestPath = '') {
  if (explicitTestPath) {
    const absT = isAbsolute(explicitTestPath) ? resolve(explicitTestPath) : resolve(wsRoot, explicitTestPath);
    const relT = relative(wsRoot, absT);
    if (relT && !relT.startsWith('..') && !isAbsolute(relT) && existsSync(absT)) {
      return relT.replace(/\\/g, '/');
    }
  }
  const stem = basename(relSource, extname(relSource));
  const candidates = [
    join(wsRoot, 'tests', `${stem}.test.mjs`),
    join(dirname(resolve(wsRoot, relSource)), `${stem}.test.mjs`),
  ];
  for (const cand of candidates) {
    if (existsSync(cand)) {
      return relative(wsRoot, cand).replace(/\\/g, '/');
    }
  }
  return '';
}

/**
 * Прогоняет граничные мутанты на изолированной временной копии проекта (без изменения оригинала).
 * @param {object} [opts={}]
 * @returns {object}
 */
export function runSemanticMutationGuard(opts = {}) {
  const safeOpts = asObj(opts);
  const isEn = String(safeOpts.lang || '').trim().toLowerCase() === 'en';
  const rawWs = asStr(safeOpts.workspaceRoot, 1024).trim();
  const rawFile = asStr(safeOpts.filePath, 1024).trim();
  if (!rawWs || rawWs.startsWith('-') || !existsSync(rawWs) || !rawFile || BLOCKED_KEYS.has(rawFile)) {
    return { ok: false, error: isEn ? 'Valid workspaceRoot and filePath are required' : 'Не указаны корректные workspaceRoot и filePath' };
  }

  const wsRoot = resolve(rawWs);
  const absFile = isAbsolute(rawFile) ? resolve(rawFile) : resolve(wsRoot, rawFile);
  const relFile = relative(wsRoot, absFile);
  if (!relFile || relFile.startsWith('..') || isAbsolute(relFile) || !existsSync(absFile)) {
    return { ok: false, error: isEn ? 'Target file not found inside workspace root' : 'Целевой файл не найден в рабочей директории' };
  }

  const relTest = resolveMatchingTestRelPath(wsRoot, relFile, asStr(safeOpts.testFilePath, 1024).trim());
  if (!relTest) {
    return { ok: false, error: isEn ? 'No matching test (*.test.mjs) found for mutation guard' : 'Не найден связанный тест (*.test.mjs) для мутационной проверки' };
  }

  const origCode = readFileSync(absFile, 'utf8');
  const maxMutants = Number.isFinite(Number(safeOpts.maxMutants)) ? Math.max(1, Math.min(6, Math.round(Number(safeOpts.maxMutants)))) : 4;
  const mutants = generateBoundaryMutants(origCode, maxMutants);
  if (mutants.length === 0) {
    return { ok: true, file: relFile.replace(/\\/g, '/'), totalMutants: 0, killed: 0, survived: 0, scorePct: 100, survivors: [] };
  }

  const timeoutMs = Number.isFinite(Number(safeOpts.timeoutMs))
    ? Math.max(1000, Math.min(30_000, Math.round(Number(safeOpts.timeoutMs))))
    : 15000;
  const cleanEnv = { ...process.env, AMR_MUTATION_SANDBOX: '1' };
  delete cleanEnv.NODE_TEST_CONTEXT;

  const sandboxParent = mkdtempSync(join(os.tmpdir(), 'amr-mut-'));
  const tempRoot = join(sandboxParent, basename(wsRoot) || 'repo');
  mkdirSync(tempRoot, { recursive: true });
  try {
    copyWorkspaceSubsetToTemp(wsRoot, tempRoot);
    const tempTarget = join(tempRoot, relFile);
    if (!existsSync(tempTarget)) {
      return { ok: false, error: isEn ? 'Failed to prepare isolated copy of file' : 'Не удалось подготовить изолированную копию файла' };
    }

    // Ensure baseline test passes before testing mutants
    const baseRun = spawnSync(process.execPath, ['--test', relTest], {
      cwd: tempRoot,
      env: cleanEnv,
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      shell: false,
    });
    if (baseRun.status !== 0) {
      return {
        ok: false,
        error: isEn ? `Baseline test (${relTest}) already fails before mutations` : `Базовый тест (${relTest}) уже падает до внесения мутаций`,
      };
    }

    let killed = 0;
    let survived = 0;
    const survivors = [];

    for (const m of mutants) {
      writeFileSync(tempTarget, m.mutatedCode, 'utf8');
      const run = spawnSync(process.execPath, ['--test', relTest], {
        cwd: tempRoot,
        env: cleanEnv,
        encoding: 'utf8',
        timeout: timeoutMs,
        windowsHide: true,
        shell: false,
      });
      if (run.status === 0) {
        survived += 1;
        survivors.push({ line: m.line, operator: m.operator, original: m.original, mutated: m.mutated });
      } else {
        killed += 1;
      }
      writeFileSync(tempTarget, origCode, 'utf8');
    }

    const totalMutants = killed + survived;
    const scorePct = totalMutants > 0 ? Math.round((killed / totalMutants) * 100) : 100;
    return {
      ok: true,
      file: relFile.replace(/\\/g, '/'),
      testFile: relTest,
      totalMutants,
      killed,
      survived,
      scorePct,
      survivors,
    };
  } finally {
    try {
      rmSync(sandboxParent, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
    } catch {}
  }
}

/**
 * @file diff-patcher.mjs
 * @description Модуль точечного применения дифф-патчей (SEARCH/REPLACE блоки)
 * и защиты от избыточной перезаписи больших файлов (checkOverwriteGuard).
 * Существенно экономит выходные токены модели, позволяя генерировать только изменяемые фрагменты.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { verifyContentSyntax } from './auto-verifier.mjs';
import { extractFileSymbolsWithRanges } from './repo-mapper.mjs';
import { updateJsonAtomicSync, withFileLockSync } from './safe-json.mjs';
import { healSearchBlockBitapAst } from './cpu-sbfl-healer.mjs';
import { loadCpuConfig, recordCpuCompressionSaving } from './cpu-worker-pool.mjs';

const OVERWRITE_GUARD_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.cache', 'overwrite-guard.json');
const OVERWRITE_CONFIRM_TTL_MS = 3 * 60 * 1000;

/**
 * Парсит текст патча и извлекает блоки SEARCH / REPLACE
 * @param {string} patchText Текст патча, содержащий один или несколько блоков <<<<<<< SEARCH ... ======= ... >>>>>>> REPLACE
 * @returns {Array<{ search: string, replace: string }>} Список распарсенных блоков
 */
export function parseSearchReplaceBlocks(patchText) {
  if (!patchText || typeof patchText !== 'string') {
    return [];
  }

  const blocks = [];
  // Anchor markers to standalone lines so inline "=======" literals inside code cannot split blocks
  const blockPattern = /^<{7}[ \t]*SEARCH[ \t]*\r?\n([\s\S]*?)\r?\n>{7}[ \t]*REPLACE[ \t]*$/gm;
  const splitPattern = /^(?:([\s\S]*?)\r?\n)?={7}[ \t]*(?:\r?\n([\s\S]*))?$/;
  let match;

  while ((match = blockPattern.exec(patchText)) !== null) {
    const inner = match[1];
    const parts = splitPattern.exec(inner);
    if (!parts) continue;
    blocks.push({
      search: parts[1] ?? '',
      replace: parts[2] ?? ''
    });
  }

  return blocks;
}

/**
 * Применяет SEARCH/REPLACE патч к строковому содержимому в ОЗУ (без записи на диск).
 * @param {string} originalContent Исходное содержимое
 * @param {string} patchText Текст патча с блоками SEARCH/REPLACE
 * @returns {{ nextContent: string, appliedBlocks: number }}
 */
export function computePatchedContent(originalContent, patchText) {
  if (typeof originalContent !== 'string') {
    throw new Error('Original content must be a string');
  }

  const blocks = parseSearchReplaceBlocks(patchText);
  if (blocks.length === 0) {
    throw new Error('No valid SEARCH/REPLACE blocks found');
  }

  // Определяем стиль переносов строк целевого текста
  const isCrlf = originalContent.includes('\r\n');
  const targetEol = isCrlf ? '\r\n' : '\n';

  let currentContent = originalContent;
  let fuzzySnappedBlocks = 0;

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const blockIndex = i + 1;

    if (!block.search || !block.search.trim()) {
      throw new Error(`Block #${blockIndex} SEARCH cannot be empty or whitespace-only`);
    }

    // 1. Попытка точного совпадения с EOL целевого контента
    const searchTargetEol = block.search.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, targetEol);
    const replaceTargetEol = block.replace.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, targetEol);

    const firstIdx = currentContent.indexOf(searchTargetEol);
    if (firstIdx !== -1) {
      if (searchTargetEol.length > 0 && currentContent.indexOf(searchTargetEol, firstIdx + searchTargetEol.length) !== -1) {
        const preview = block.search.slice(0, 80).replace(/\r?\n/g, '↵ ');
        throw new Error(`Block #${blockIndex} SEARCH matches multiple locations (add more context): "${preview}..."`);
      }
      // Functional replacer prevents JS $& / $$ / $` / $' corruption
      currentContent = currentContent.replace(searchTargetEol, () => replaceTargetEol);
      continue;
    }

    // 2. Резервная попытка: сквозная нормализация к LF
    const normalizedContent = currentContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const normalizedSearch = block.search.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const normalizedReplace = block.replace.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    const normIdx = normalizedContent.indexOf(normalizedSearch);
    if (normIdx !== -1) {
      if (normalizedSearch.length > 0 && normalizedContent.indexOf(normalizedSearch, normIdx + normalizedSearch.length) !== -1) {
        const preview = block.search.slice(0, 80).replace(/\r?\n/g, '↵ ');
        throw new Error(`Block #${blockIndex} SEARCH matches multiple locations (add more context): "${preview}..."`);
      }
      const updatedNormalized = normalizedContent.replace(normalizedSearch, () => normalizedReplace);
      currentContent = isCrlf ? updatedNormalized.replace(/\r?\n/g, '\r\n') : updatedNormalized;
      continue;
    }

    // 3. Fuzzy Indentation & Trailing-Whitespace Snap (AST/Token-line alignment)
    const contentLines = normalizedContent.split('\n');
    let searchLines = normalizedSearch.split('\n');
    while (searchLines.length > 1 && !searchLines[0].trim()) searchLines.shift();
    while (searchLines.length > 1 && !searchLines[searchLines.length - 1].trim()) searchLines.pop();

    const searchTrimmed = searchLines.map((l) => l.trim());
    const fuzzyHits = [];
    const maxPos = contentLines.length - searchLines.length;
    for (let pos = 0; pos <= maxPos; pos++) {
      let allMatch = true;
      for (let j = 0; j < searchLines.length; j++) {
        if (contentLines[pos + j].trim() !== searchTrimmed[j]) {
          allMatch = false;
          break;
        }
      }
      if (allMatch) {
        fuzzyHits.push(pos);
        if (fuzzyHits.length > 1) break;
      }
    }

    if (fuzzyHits.length > 1) {
      const preview = block.search.slice(0, 80).replace(/\r?\n/g, '↵ ');
      throw new Error(`Block #${blockIndex} SEARCH matches multiple locations (ambiguous indentation match): "${preview}..."`);
    }

    if (fuzzyHits.length === 1) {
      const matchStartIdx = fuzzyHits[0];
      const anchorOffset = Math.max(0, searchLines.findIndex((l) => l.trim().length > 0));
      const targetAnchorLine = contentLines[matchStartIdx + anchorOffset] || '';
      const searchAnchorLine = searchLines[anchorOffset] || '';
      const targetLead = (targetAnchorLine.match(/^[ \t]*/) || [''])[0];
      const searchLead = (searchAnchorLine.match(/^[ \t]*/) || [''])[0];
      const usesTabs = targetLead.includes('\t');
      const targetIndentLen = targetLead.replace(/\t/g, '  ').length;
      const searchIndentLen = searchLead.replace(/\t/g, '  ').length;
      const indentDelta = targetIndentLen - searchIndentLen;

      // Detect indent step ratio (e.g. LLM writes 2-space indents for 4-space code)
      let indentScale = 1;
      for (let j = anchorOffset + 1; j < searchLines.length; j++) {
        if (!searchLines[j].trim() || !contentLines[matchStartIdx + j]?.trim()) continue;
        const tLen = ((contentLines[matchStartIdx + j].match(/^[ \t]*/) || [''])[0]).replace(/\t/g, '  ').length;
        const sLen = ((searchLines[j].match(/^[ \t]*/) || [''])[0]).replace(/\t/g, '  ').length;
        const tStep = tLen - targetIndentLen;
        const sStep = sLen - searchIndentLen;
        if (tStep > 0 && sStep > 0) {
          indentScale = tStep / sStep;
          break;
        }
      }

      let replaceLines = [];
      if (normalizedReplace !== '') {
        let rawRepLines = normalizedReplace.split('\n');
        while (rawRepLines.length > 1 && !rawRepLines[0].trim()) rawRepLines.shift();
        while (rawRepLines.length > 1 && !rawRepLines[rawRepLines.length - 1].trim()) rawRepLines.pop();
        replaceLines = rawRepLines.map((rLine) => {
          if (!rLine.trim()) return '';
          const rLead = (rLine.match(/^[ \t]*/) || [''])[0];
          const rBody = rLine.slice(rLead.length);
          const rLen = rLead.replace(/\t/g, '  ').length;
          const newLen = indentScale !== 1
            ? Math.max(0, Math.round(targetIndentLen + (rLen - searchIndentLen) * indentScale))
            : Math.max(0, rLen + indentDelta);
          const newLead = usesTabs
            ? '\t'.repeat(Math.floor(newLen / 2)) + ' '.repeat(newLen % 2)
            : ' '.repeat(newLen);
          return `${newLead}${rBody}`;
        });
      }

      contentLines.splice(matchStartIdx, searchLines.length, ...replaceLines);
      currentContent = contentLines.join(targetEol);
      fuzzySnappedBlocks++;
      continue;
    }

    // 4. Bitap + Blank-Line Elastic AST Heal (SOTA #5)
    try {
      if (loadCpuConfig().cpuSotaEngines !== false) {
        const healed = healSearchBlockBitapAst(normalizedContent, normalizedSearch, normalizedReplace);
        if (healed?.healed && typeof healed.nextContent === 'string') {
          currentContent = isCrlf ? healed.nextContent.replace(/\r?\n/g, '\r\n') : healed.nextContent;
          fuzzySnappedBlocks++;
          try {
            recordCpuCompressionSaving({
              kind: 'bitap_heal',
              savedChars: Math.min(4000, normalizedContent.length),
              latencyMs: 1.5,
            });
          } catch {}
          continue;
        }
      }
    } catch {}

    // Если блок не найден ни в исходном, ни в нормализованном, ни в нечётком виде
    const preview = block.search.slice(0, 120).replace(/\r?\n/g, '↵ ');
    throw new Error(
      `Block #${blockIndex} SEARCH not found: "${preview}..."`
    );
  }

  return {
    nextContent: currentContent,
    appliedBlocks: blocks.length,
    fuzzySnappedBlocks,
  };
}

/**
 * Применяет SEARCH/REPLACE патч к целевому файлу с поддержкой нормализации CRLF/LF
 * @param {string} filePath Путь к изменяемому файлу
 * @param {string} patchText Текст патча с блоками
 * @returns {{ ok: boolean, appliedBlocks: number, oldBytes: number, newBytes: number, savedOutputChars: number }}
 */
export function applySearchReplace(filePath, patchText) {
  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Target file not found: ${resolvedPath}`);
  }

  return withFileLockSync(resolvedPath, () => {
    const originalContent = fs.readFileSync(resolvedPath, 'utf8');
    const oldBytes = Buffer.byteLength(originalContent, 'utf8');

    const { nextContent: currentContent, appliedBlocks } = computePatchedContent(originalContent, patchText);

    // ПЕРЕД созданием tempPath и записью на диск вызываем проверку синтаксиса в ОЗУ
    const v = verifyContentSyntax(currentContent, resolvedPath);
    if (!v.valid) {
      throw new Error(`[Transactional Patch Aborted] Syntax error (${v.checker}) before disk write: ${v.error}`);
    }

    const newBytes = Buffer.byteLength(currentContent, 'utf8');
    const patchBytes = Buffer.byteLength(patchText, 'utf8');
    const savedOutputChars = Math.max(0, newBytes - patchBytes);

    // Атомарная запись через временный файл
    const tempPath = `${resolvedPath}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(tempPath, currentContent, 'utf8');
      try {
        fs.renameSync(tempPath, resolvedPath);
      } catch {
        // Резервный путь для Windows при блокировках антивирусом
        fs.copyFileSync(tempPath, resolvedPath);
        fs.unlinkSync(tempPath);
      }
    } catch (err) {
      if (fs.existsSync(tempPath)) {
        try { fs.unlinkSync(tempPath); } catch {}
      }
      throw new Error(`Failed to write ${resolvedPath}: ${err.message}`);
    }

    return {
      ok: true,
      appliedBlocks,
      oldBytes,
      newBytes,
      savedOutputChars
    };
  });
}

/**
 * Replaces an AST-delimited symbol body (function, method, or class) in memory.
 * Supports `fnName` or `ClassName.methodName` selectors.
 * @param {string} originalContent
 * @param {string} symbolName
 * @param {string} replacementCode
 * @param {string} [filePath='file.mjs']
 * @returns {{ nextContent: string, symbol: string, startLine: number, endLine: number }}
 */
export function computeSymbolReplacement(originalContent, symbolName, replacementCode, filePath = 'file.mjs') {
  if (typeof originalContent !== 'string') {
    throw new Error('Original content must be a string');
  }
  const needle = String(symbolName || '').trim();
  if (!needle) {
    throw new Error('Symbol name cannot be empty');
  }
  if (typeof replacementCode !== 'string' || !replacementCode.trim()) {
    throw new Error('Replacement code cannot be empty');
  }

  const ext = path.extname(String(filePath || 'file.mjs')).toLowerCase() || '.mjs';
  const syms = extractFileSymbolsWithRanges(ext, originalContent) || [];
  let candidates = [];

  if (needle.includes('.')) {
    const [clsName, methName] = needle.split('.', 2);
    const cls = syms.find((s) => s.kind === 'class' && s.name === clsName);
    if (cls) {
      candidates = syms.filter(
        (s) => s.name === methName && s.startLine > cls.startLine && s.endLine <= cls.endLine
      );
    }
    if (candidates.length === 0) {
      candidates = syms.filter((s) => s.name === methName);
    }
  } else {
    candidates = syms.filter((s) => s.name === needle);
  }

  if (candidates.length === 0) {
    throw new Error(`Symbol "${needle}" not found in ${path.basename(filePath || 'file')}`);
  }
  if (candidates.length > 1) {
    throw new Error(`Symbol "${needle}" is ambiguous (${candidates.length} matches); use ClassName.methodName`);
  }

  const targetSym = candidates[0];
  const targetEol = originalContent.includes('\r\n') ? '\r\n' : '\n';
  const lines = originalContent.split(/\r?\n/);
  const sIdx = Math.max(0, Number(targetSym.startLine) - 1);
  const eIdx = Math.min(lines.length - 1, Math.max(sIdx, Number(targetSym.endLine) - 1));
  const repLines = replacementCode.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n+$/, '').split('\n');
  const nextLines = [...lines.slice(0, sIdx), ...repLines, ...lines.slice(eIdx + 1)];
  return {
    nextContent: nextLines.join(targetEol),
    symbol: targetSym.name,
    startLine: targetSym.startLine,
    endLine: targetSym.endLine,
  };
}

/**
 * Atomically replaces a symbol body by AST boundaries after in-RAM syntax verification.
 * @param {string} targetPath
 * @param {string} symbolName
 * @param {string} replacementCode
 * @returns {{ ok: boolean, symbol: string, startLine: number, endLine: number, oldBytes: number, newBytes: number }}
 */
export function applySymbolReplacement(targetPath, symbolName, replacementCode) {
  const resolvedPath = path.resolve(targetPath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Target file not found: ${resolvedPath}`);
  }

  return withFileLockSync(resolvedPath, () => {
    const originalContent = fs.readFileSync(resolvedPath, 'utf8');
    const oldBytes = Buffer.byteLength(originalContent, 'utf8');
    const { nextContent, symbol, startLine, endLine } = computeSymbolReplacement(
      originalContent,
      symbolName,
      replacementCode,
      resolvedPath
    );

    const v = verifyContentSyntax(nextContent, resolvedPath);
    if (!v.valid) {
      throw new Error(`[Symbol Patch Aborted] Syntax error (${v.checker}) before disk write: ${v.error}`);
    }

    const newBytes = Buffer.byteLength(nextContent, 'utf8');
    const tempPath = `${resolvedPath}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(tempPath, nextContent, 'utf8');
      try {
        fs.renameSync(tempPath, resolvedPath);
      } catch {
        fs.copyFileSync(tempPath, resolvedPath);
        fs.unlinkSync(tempPath);
      }
    } catch (err) {
      if (fs.existsSync(tempPath)) {
        try { fs.unlinkSync(tempPath); } catch {}
      }
      throw new Error(`Failed to write ${resolvedPath}: ${err.message}`);
    }

    return { ok: true, symbol, startLine, endLine, oldBytes, newBytes };
  });
}

/**
 * Моделирует применение правок инструментов edit_file или write_file исключительно в ОЗУ
 * и проверяет валидность синтаксиса до фактической записи на диск.
 * @param {string} toolName Имя вызываемого инструмента ('edit_file' | 'write_file')
 * @param {object} [args={}] Аргументы инструмента
 * @returns {{ valid: boolean, checked: boolean, checker?: string, error?: string|null, simulatedContent: string|null }}
 */
function isSystemCacheOrBrainPath(filePath, { allowBrainScratchCheck = false } = {}) {
  const normPath = String(filePath || '').replace(/\\/g, '/');
  if (/(?:^|\/)(?:\.cache|\.system_generated)(?:\/|$)/i.test(normPath)) {
    return true;
  }
  const isBrainArtifact = /(?:^|\/)(?:\.gemini\/)?antigravity(?:-ide|-cli)?\/brain\//i.test(normPath);
  if (!isBrainArtifact) return false;
  if (allowBrainScratchCheck && /\/brain\/[^/]+\/scratch\//i.test(normPath)) {
    return false;
  }
  return true;
}

function isProjectScratchPath(filePath, workspaceRoot = '') {
  const normPath = String(filePath || '').replace(/\\/g, '/');
  if (/^(?:\.\/)?scratch(?:\/|$)/i.test(normPath)) {
    return true;
  }
  if (!workspaceRoot || typeof workspaceRoot !== 'string') return false;
  try {
    const rel = path.relative(path.resolve(workspaceRoot), path.resolve(String(filePath))).replace(/\\/g, '/');
    return rel === 'scratch' || rel.startsWith('scratch/');
  } catch {
    return false;
  }
}

export function simulateToolEditInMemory(toolName, args = {}) {
  if (!args || typeof args !== 'object') {
    return { valid: true, checked: false, checker: 'none', error: null, simulatedContent: null };
  }

  const filePath = args.Path || args.path || '';
  if (isSystemCacheOrBrainPath(filePath, { allowBrainScratchCheck: true })) {
    return { valid: true, checked: false, simulatedContent: null };
  }

  // Если edit_file и заданы Path, Target, Replacement
  if (toolName === 'edit_file' && filePath && args.Target !== undefined && args.Replacement !== undefined) {
    const targetStr = String(args.Target);
    if (!targetStr) {
      return { valid: true, checked: false, checker: 'none', error: null, simulatedContent: null };
    }
    const resolvedPath = path.resolve(filePath);
    if (fs.existsSync(resolvedPath)) {
      try {
        const current = fs.readFileSync(resolvedPath, 'utf8');
        if (current.includes(targetStr)) {
          const simulatedContent = current.split(targetStr).join(String(args.Replacement));
          const verdict = verifyContentSyntax(simulatedContent, resolvedPath);
          return {
            ...verdict,
            simulatedContent
          };
        }
      } catch (err) {
        return {
          valid: false,
          checked: true,
          checker: 'simulateToolEdit-fs',
          error: err.message,
          simulatedContent: null
        };
      }
    }
  }

  // Если write_file и заданы Path и Content (включая Append: true)
  if (toolName === 'write_file' && filePath && args.Content !== undefined) {
    const resolvedPath = path.resolve(filePath);
    let contentStr = String(args.Content);
    if (args.Append === true && fs.existsSync(resolvedPath)) {
      try {
        const existingContent = fs.readFileSync(resolvedPath, 'utf8');
        contentStr = existingContent + contentStr;
      } catch {}
    }
    const verdict = verifyContentSyntax(contentStr, resolvedPath);
    return {
      ...verdict,
      simulatedContent: contentStr
    };
  }

  return { valid: true, checked: false, checker: 'none', error: null, simulatedContent: null };
}

/**
 * Проверяет операцию перезаписи инструмента write_file на превышение лимита строк
 * @param {string} toolName Имя вызываемого инструмента
 * @param {object} [args={}] Аргументы инструмента
 * @param {object} [state={}] Состояние маршрутизатора
 * @returns {{ decision: string, warning?: string, overLimit?: boolean, lineCount?: number }}
 */
export function checkOverwriteGuard(toolName, args = {}, state = {}) {
  if (state.diffOnly === false) {
    return { decision: 'allow' };
  }

  if (toolName === 'write_file' && args && args.Overwrite === true && args.Path) {
    const normPath = String(args.Path).replace(/\\/g, '/');
    const wsRoot = state?.workspaceRoot || args.WorkspaceRoot || '';

    // Пропускаем системные артефакты brain, кэш и локальный scratch/ текущего воркспейса
    if (isSystemCacheOrBrainPath(normPath, { allowBrainScratchCheck: false }) || isProjectScratchPath(args.Path, wsRoot)) {
      return { decision: 'allow', overLimit: false };
    }

    const maxLines = Math.max(20, Number(state.diffOnlyMaxLines) || 50);

    try {
      if (fs.existsSync(args.Path)) {
        const content = fs.readFileSync(args.Path, 'utf8');
        const lineCount = content.split(/\r?\n/).length;

        if (lineCount > maxLines) {
          let resolvedKey = normPath.toLowerCase();
          try {
            resolvedKey = path.resolve(args.Path).toLowerCase();
          } catch {}
          const now = Date.now();
          let confirmedRetry = false;
          try {
            updateJsonAtomicSync(OVERWRITE_GUARD_FILE, () => ({ warned: {} }), (st) => {
              const warned = (st && typeof st.warned === 'object' && !Array.isArray(st.warned)) ? { ...st.warned } : {};
              for (const [k, ts] of Object.entries(warned)) {
                if (!Number.isFinite(ts) || now - ts > OVERWRITE_CONFIRM_TTL_MS) {
                  delete warned[k];
                }
              }
              const prevTs = Object.hasOwn(warned, resolvedKey) ? Number(warned[resolvedKey]) : 0;
              if (prevTs > 0 && now - prevTs <= OVERWRITE_CONFIRM_TTL_MS) {
                confirmedRetry = true;
                delete warned[resolvedKey];
              } else {
                warned[resolvedKey] = now;
              }
              return { warned };
            });
          } catch {
            confirmedRetry = true;
          }

          if (!confirmedRetry) {
            return {
              decision: 'deny',
              overLimit: true,
              lineCount,
              reason: `⚠️ [Diff-Only Guard] File ${path.basename(args.Path)} has ${lineCount}L (>${maxLines}L). Use edit_file / diff-patcher instead of full write_file(Overwrite:true), or retry write_file once within 3 min to confirm full replacement.`,
            };
          }

          return {
            decision: 'allow',
            warning: `File >${maxLines}L (${lineCount}L) full-overwritten after confirmation; use edit_file or diff-patcher.`,
            overLimit: true,
            lineCount,
          };
        }
      }
    } catch {
      // Игнорируем ошибки чтения отсутствующих файлов
    }
  }

  return { decision: 'allow', overLimit: false };
}

// Запуск напрямую из командной строки: node core/diff-patcher.mjs <targetFile> <patchFile>
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const targetFile = process.argv[2];
  const patchFile = process.argv[3];

  if (!targetFile || !patchFile) {
    console.error('Usage: node core/diff-patcher.mjs <targetFile> <patchFile>');
    process.exit(1);
  }

  try {
    const patchContent = fs.readFileSync(patchFile, 'utf8');
    const result = applySearchReplace(targetFile, patchContent);
    console.log(`[OK] Applied ${result.appliedBlocks} blocks to ${targetFile} (${result.oldBytes}->${result.newBytes}B)`);
  } catch (err) {
    console.error(`[ERR] Failed to apply patch: ${err.message}`);
    process.exit(1);
  }
}

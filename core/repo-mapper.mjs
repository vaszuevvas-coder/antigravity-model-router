/**
 * @file repo-mapper.mjs
 * @description Модуль облегчённого картирования репозитория (Repo Map) для экономии входных токенов.
 * Формирует компактную AST-подобную структуру символов (классы, интерфейсы, типы, функции без тел реализации),
 * исключая служебные каталоги, бинарные файлы и лок-файлы.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolveTunnelCacheDir } from './cache-dir.mjs';
import { atomicWriteJsonSync } from './safe-json.mjs';

// Директории, которые полностью исключаются из сканирования
const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.cache',
  'checkpoints',
  '.agents',
  '.turbo',
  '.vscode',
  '.idea',
  'vendor',
  '__pycache__',
  '.venv',
  'env',
  'scratch',
  'tmp',
  'temp',
  'coverage'
]);

// Лок-файлы и служебные файлы, которые не несут архитектурного смысла
const IGNORED_FILES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'Cargo.lock',
  'poetry.lock',
  'composer.lock'
]);

// Расширения бинарных файлов и медиа-ресурсов
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.webp',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.node',
  '.zip', '.tar', '.gz', '.7z', '.rar',
  '.pdf', '.woff', '.woff2', '.ttf', '.eot',
  '.mp3', '.mp4', '.wav', '.db', '.sqlite'
]);

// Поддерживаемые расширения исходного кода
const CODE_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs',
  '.ts', '.tsx', '.jsx', '.mts', '.cts',
  '.py',
  '.go',
  '.rs',
  '.json'
]);

const REPOMAP_SCHEMA_VERSION = 2;

function sanitizeCodeLineForBraces(line) {
  if (!line) return '';
  const noStringsOrComments = line.replace(
    /\/\/.*$|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g,
    (m) => (m.startsWith('//') ? '' : '""')
  );
  // Удаляем regex-литералы только после разделителей, не затрагивая оператор деления `a / b`
  return noStringsOrComments.replace(
    /(^|(?:return|throw|case)\b|=>|[=(,:!&|?+~^;{}\[\]\r\n])\s*\/(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\[\r\n])+\/[dgimsuvy]*/g,
    '$1""'
  );
}

function resetJsBraceIfColumnZeroExport(rawLine, state) {
  if (state.braceDepth > 0 && /^export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type)\b/.test(rawLine)) {
    state.braceDepth = 0;
    state.classBraceStack.length = 0;
    state.pendingClassOpen = false;
  }
}

function updateJsBraceState(rawLine, state) {
  const clean = sanitizeCodeLineForBraces(rawLine);
  let sawOpenBrace = false;
  for (let k = 0; k < clean.length; k++) {
    const ch = clean[k];
    if (ch === '{') {
      sawOpenBrace = true;
      state.braceDepth++;
      if (state.pendingClassOpen) {
        state.classBraceStack.push(state.braceDepth);
        state.pendingClassOpen = false;
      }
    } else if (ch === '}') {
      while (state.classBraceStack.length > 0 && state.classBraceStack[state.classBraceStack.length - 1] >= state.braceDepth) {
        state.classBraceStack.pop();
      }
      if (state.braceDepth > 0) state.braceDepth--;
    }
  }
  if (state.pendingClassOpen && !sawOpenBrace && clean.includes(';')) {
    state.pendingClassOpen = false;
  }
}

function readBalancedJsParams(lines, startIdx, openIdxInTrimmed, totalLines) {
  let parenDepth = 1;
  let paramBuf = '';
  let inQuote = null;
  let escaped = false;
  const maxIdx = Math.min(totalLines, startIdx + 9);

  for (let j = startIdx; j < maxIdx; j++) {
    const seg = lines[j].trim();
    const startK = j === startIdx ? openIdxInTrimmed + 1 : 0;
    for (let k = startK; k < seg.length; k++) {
      const ch = seg[k];
      if (inQuote) {
        paramBuf += ch;
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === inQuote) {
          inQuote = null;
        }
        continue;
      }
      if (ch === '/' && seg[k + 1] === '/') {
        break;
      }
      if (ch === '\'' || ch === '"' || ch === '`') {
        inQuote = ch;
        paramBuf += ch;
        continue;
      }
      if (ch === '(') {
        parenDepth++;
        paramBuf += ch;
      } else if (ch === ')') {
        parenDepth--;
        if (parenDepth === 0) {
          return {
            params: paramBuf.replace(/\s+/g, ' ').trim(),
            endLineIdx: j,
            afterClose: seg.slice(k + 1).replace(/\/\/.*$/, '').trim()
          };
        }
        paramBuf += ch;
      } else {
        paramBuf += ch;
      }
    }
    paramBuf += ' ';
  }
  return null;
}

function parseJsArrowDecl(lines, i, line, totalLines) {
  const singleArrow = line.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s+)?(?:<[^>\r\n]+>\s*)?([A-Za-z0-9_$]+)\s*=>/);
  if (singleArrow) {
    return { name: singleArrow[1], params: singleArrow[2] };
  }
  const openArrow = line.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?(?:<.*>)?\s*\(/);
  if (!openArrow) return null;

  const openIdx = line.indexOf('(', openArrow[0].length - 1);
  const bal = readBalancedJsParams(lines, i, openIdx, totalLines);
  if (!bal) return null;

  let isArrow = /^(?::\s*[^=>{]+)?=>/.test(bal.afterClose);
  if (!isArrow && bal.afterClose === '') {
    for (let j = bal.endLineIdx + 1; j < Math.min(totalLines, bal.endLineIdx + 3); j++) {
      const nxt = lines[j].trim();
      if (!nxt || nxt.startsWith('//')) continue;
      if (nxt.startsWith('=>')) isArrow = true;
      break;
    }
  }
  if (!isArrow) return null;
  return { name: openArrow[1], params: bal.params };
}

function scanJsTsSymbols(lines, { withRanges = false, imports = null } = {}) {
  const totalLines = lines.length;
  const items = [];
  const braceState = { braceDepth: 0, classBraceStack: [], pendingClassOpen: false };
  let pendingImportBuf = '';
  let pendingImportLines = 0;

  for (let i = 0; i < totalLines; i++) {
    const rawLine = lines[i];
    resetJsBraceIfColumnZeroExport(rawLine, braceState);
    const line = rawLine.trim();

    if (line && !line.startsWith('//')) {
      if (imports) {
        if (pendingImportBuf) {
          pendingImportBuf += ' ' + line;
          pendingImportLines += 1;
          const closedMatch = pendingImportBuf.match(/\bfrom\s+['"]([^'"]+)['"]/);
          if (closedMatch && closedMatch[1]) {
            imports.add(closedMatch[1]);
            pendingImportBuf = '';
            pendingImportLines = 0;
          } else if (pendingImportLines >= 25 || /;\s*$/.test(line)) {
            pendingImportBuf = '';
            pendingImportLines = 0;
          }
        } else {
          const importMatch = line.match(/(?:(?:import|export)\s+(?:type\s+)?(?:[\w*\s{},$]+from\s+)?['"]([^'"]+)['"])|(?:require\(['"]([^'"]+)['"]\))/);
          if (importMatch) {
            const mod = importMatch[1] || importMatch[2];
            if (mod) imports.add(mod);
          } else if (/^(?:import\b(?![(\.])|export\s+(?:type\s+)?(?:\*|\{))/.test(line) && !/;\s*$/.test(line)) {
            pendingImportBuf = line;
            pendingImportLines = 1;
          }
        }
      }

      const isTopLevel = braceState.braceDepth === 0;
      const isDirectClassBody =
        braceState.classBraceStack.length > 0 &&
        braceState.braceDepth === braceState.classBraceStack[braceState.classBraceStack.length - 1];

      let matched = false;
      if (isTopLevel) {
        const ifaceMatch = line.match(/^(?:export\s+)?interface\s+([A-Za-z0-9_$]+)/);
        if (ifaceMatch) {
          items.push({ name: ifaceMatch[1], kind: 'interface', signature: `interface ${ifaceMatch[1]}`, lineIdx: i });
          matched = true;
        }

        if (!matched) {
          const typeMatch = line.match(/^(?:export\s+)?type\s+([A-Za-z0-9_$]+)\s*=/);
          if (typeMatch) {
            items.push({ name: typeMatch[1], kind: 'type', signature: `type ${typeMatch[1]}`, lineIdx: i });
            matched = true;
          }
        }

        if (!matched) {
          const classMatch = line.match(/^(?:export\s+)?(?:default\s+)?class\s+([A-Za-z0-9_$]+)(?:\s+extends\s+([A-Za-z0-9_$.]+))?/);
          if (classMatch) {
            const extStr = classMatch[2] ? ` extends ${classMatch[2]}` : '';
            items.push({ name: classMatch[1], kind: 'class', signature: `class ${classMatch[1]}${extStr}`, lineIdx: i });
            braceState.pendingClassOpen = true;
            matched = true;
          }
        }

        if (!matched) {
          const funcMatch = line.match(/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function(?:\s+([A-Za-z0-9_$]+))?(?:\s*<.*>)?\s*\(/);
          if (funcMatch) {
            const name = funcMatch[1] || 'anonymous';
            const openIdx = line.indexOf('(', funcMatch[0].length - 1);
            const bal = readBalancedJsParams(lines, i, openIdx, totalLines);
            const params = bal ? bal.params : '';
            items.push({ name, kind: 'function', signature: `function ${name}(${params})`, lineIdx: i });
            matched = true;
          }
        }

        if (!matched) {
          const arrowDecl = parseJsArrowDecl(lines, i, line, totalLines);
          if (arrowDecl) {
            items.push({ name: arrowDecl.name, kind: 'function', signature: `const ${arrowDecl.name} = (${arrowDecl.params}) =>`, lineIdx: i });
            matched = true;
          }
        }
      }

      if (!matched && isDirectClassBody) {
        const methodMatch = withRanges
          ? line.match(/^(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z0-9_$]+)\s*\(([^)]*)\)\s*\{/)
          : line.match(/^(?:static\s+)?(?:async\s+)?([A-Za-z0-9_$]+)\s*\(([^)]*)\)\s*\{/);
        if (methodMatch) {
          const methodName = methodMatch[1];
          const skipWords = withRanges
            ? ['if', 'for', 'while', 'switch', 'catch', 'finally', 'with']
            : ['if', 'for', 'while', 'switch', 'catch'];
          if (!skipWords.includes(methodName)) {
            const params = methodMatch[2].replace(/\s+/g, ' ').trim();
            items.push({ name: methodName, kind: 'method', signature: `method ${methodName}(${params})`, lineIdx: i });
          }
        }
      }
    }

    updateJsBraceState(rawLine, braceState);
  }

  if (!withRanges) {
    return items.map((it) => it.signature);
  }
  return items.map((it) => ({
    name: it.name,
    kind: it.kind,
    signature: it.signature,
    startLine: it.lineIdx + 1,
    endLine: computeBraceEndLine(lines, it.lineIdx, totalLines)
  }));
}

/**
 * Извлекает компактную сводку символов и импортов из содержимого файла без тел реализации
 * @param {string} ext Расширение файла
 * @param {string} content Текстовое содержимое файла
 * @returns {{ imports: string[], symbols: string[] }}
 */
export function extractFileSymbols(ext, content) {
  const imports = new Set();
  const symbols = [];

  if (ext === '.json') {
    try {
      const parsed = JSON.parse(content);
      if (typeof parsed === 'object' && parsed !== null) {
        if (parsed.name) symbols.push(`package: "${parsed.name}"` + (parsed.version ? `@${parsed.version}` : ''));
        if (parsed.scripts && typeof parsed.scripts === 'object') {
          const scriptKeys = Object.keys(parsed.scripts);
          if (scriptKeys.length > 0) symbols.push(`scripts: [${scriptKeys.slice(0, 10).join(', ')}]`);
        }
        if (parsed.dependencies && typeof parsed.dependencies === 'object') {
          const deps = Object.keys(parsed.dependencies);
          if (deps.length > 0) symbols.push(`dependencies: [${deps.slice(0, 12).join(', ')}]`);
        }
        if (parsed.devDependencies && typeof parsed.devDependencies === 'object') {
          const devDeps = Object.keys(parsed.devDependencies);
          if (devDeps.length > 0) symbols.push(`devDependencies: [${devDeps.slice(0, 10).join(', ')}]`);
        }
        if (symbols.length === 0) {
          const keys = Object.keys(parsed).slice(0, 15);
          symbols.push(`keys: [${keys.join(', ')}]`);
        }
      }
    } catch {
      // Игнорируем ошибки парсинга невалидного JSON
    }
    return { imports: [], symbols };
  }

  // Маскируем блочные комментарии с сохранением номеров строк
  const cleanContent = maskBlockComments(content);
  const lines = cleanContent.split(/\r?\n/);

  if (ext === '.js' || ext === '.mjs' || ext === '.cjs' || ext === '.ts' || ext === '.tsx' || ext === '.jsx' || ext === '.mts' || ext === '.cts') {
    symbols.push(...scanJsTsSymbols(lines, { withRanges: false, imports }));
  } else if (ext === '.py') {
    for (let i = 0; i < lines.length; i++) {
      const rawLine = lines[i];
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;

      // Импорты Python
      const pyImport = line.match(/^(?:from\s+([A-Za-z0-9_.]+)\s+import|import\s+([A-Za-z0-9_.,\s]+?)(?:#.*)?$)/);
      if (pyImport) {
        if (pyImport[1]) {
          imports.add(pyImport[1].trim());
        } else if (pyImport[2]) {
          for (const part of pyImport[2].split(',')) {
            const cleaned = part.trim().split(/\s+as\s+/i)[0].trim();
            if (cleaned) imports.add(cleaned);
          }
        }
      }

      // Классы Python
      const classMatch = line.match(/^class\s+([A-Za-z0-9_]+)(?:\(([^)]*)\))?:/);
      if (classMatch) {
        symbols.push(`class ${classMatch[1]}${classMatch[2] ? `(${classMatch[2]})` : ''}`);
        continue;
      }

      // Функции/методы Python (с поддержкой многострочных сигнатур до 8 строк)
      const pyDefStart = line.match(/^(?:async\s+)?def\s+([A-Za-z0-9_]+)\s*\(/);
      if (pyDefStart) {
        const name = pyDefStart[1];
        let params = '';
        const openIdx = line.indexOf('(');
        const closeIdx = line.indexOf(')', openIdx + 1);
        if (closeIdx !== -1) {
          params = line.slice(openIdx + 1, closeIdx).replace(/\s+/g, ' ').trim();
        } else {
          let paramBuf = line.slice(openIdx + 1);
          for (let j = i + 1; j < Math.min(lines.length, i + 9); j++) {
            const nextLine = lines[j].trim();
            const nextClose = nextLine.indexOf(')');
            if (nextClose !== -1) {
              paramBuf += ' ' + nextLine.slice(0, nextClose);
              break;
            } else {
              paramBuf += ' ' + nextLine;
            }
          }
          params = paramBuf.replace(/\s+/g, ' ').trim();
        }
        symbols.push(`def ${name}(${params})`);
        continue;
      }
    }
  } else if (ext === '.go') {
    let inGoImportBlock = false;
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith('//')) continue;

      if (inGoImportBlock) {
        if (line.startsWith(')')) {
          inGoImportBlock = false;
          continue;
        }
        const blkImp = line.match(/(?:^(?:[A-Za-z0-9_.]+\s+)?)"([^"]+)"/);
        if (blkImp && blkImp[1]) imports.add(blkImp[1].trim());
        continue;
      }

      if (/^import\s*\(/.test(line)) {
        const inlineMatch = line.match(/^import\s*\(([^)]+)\)/);
        if (inlineMatch) {
          for (const m of inlineMatch[1].matchAll(/"([^"]+)"/g)) {
            if (m[1]) imports.add(m[1].trim());
          }
        } else {
          inGoImportBlock = true;
        }
        continue;
      }

      const singleImp = line.match(/^import\s+(?:[A-Za-z0-9_.]+\s+)?"([^"]+)"/);
      if (singleImp && singleImp[1]) {
        imports.add(singleImp[1].trim());
        continue;
      }

      const typeMatch = line.match(/^type\s+([A-Za-z0-9_]+)\s+(struct|interface)/);
      if (typeMatch) {
        symbols.push(`type ${typeMatch[1]} ${typeMatch[2]}`);
        continue;
      }

      const funcMatch = line.match(/^func\s*(?:\(([^)]+)\)\s*)?([A-Za-z0-9_]+)\s*\(([^)]*)\)/);
      if (funcMatch) {
        const receiver = funcMatch[1] ? `(${funcMatch[1].trim()}) ` : '';
        const name = funcMatch[2];
        const params = funcMatch[3].replace(/\s+/g, ' ').trim();
        symbols.push(`func ${receiver}${name}(${params})`);
      }
    }
  } else if (ext === '.rs') {
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith('//')) continue;

      const structMatch = line.match(/^(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z0-9_]+)/);
      if (structMatch) {
        symbols.push(`item ${structMatch[1]}`);
        continue;
      }

      const fnMatch = line.match(/^(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)/);
      if (fnMatch) {
        const params = fnMatch[2].replace(/\s+/g, ' ').trim();
        symbols.push(`fn ${fnMatch[1]}(${params})`);
      }
    }
  }

  return {
    imports: Array.from(imports),
    symbols
  };
}

/**
 * Маскирует блочные комментарии /* ... *\/ пробелами с сохранением символов \r и \n,
 * чтобы номера строк 1..N точно совпадали с исходным файлом.
 * @param {string} content Исходное текстовое содержимое файла
 * @returns {string} Содержимое с маскированными блочными комментариями
 */
function maskBlockComments(content) {
  if (!content || typeof content !== 'string') return '';
  return content.replace(/\/\*[\s\S]*?\*\//g, (match) => {
    return match.replace(/[^\r\n]/g, ' ');
  });
}

/**
 * Вычисляет строку окончания блока endLine подсчетом баланса фигурных скобок { и }
 * @param {string[]} rawLines Массив строк файла
 * @param {number} startLineIndex Индекс строки объявления (0-based)
 * @param {number} totalLines Общее количество строк в файле
 * @returns {number} 1-based номер строки окончания блока
 */
function computeBraceEndLine(rawLines, startLineIndex, totalLines) {
  let depth = 0;
  let parenDepth = 0;
  let started = false;
  const maxLine = Math.min(totalLines, startLineIndex + 120);

  for (let i = startLineIndex; i < maxLine; i++) {
    let line = rawLines[i];
    // Убираем однострочные комментарии //
    line = line.replace(/\/\/.*$/, '');
    // Убираем строковые литералы '', "", `` чтобы скобки внутри строк не ломали баланс
    line = line.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g, '""');

    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      if (!started) {
        if (ch === '(') parenDepth++;
        else if (ch === ')' && parenDepth > 0) parenDepth--;
        else if (ch === '{' && parenDepth === 0) {
          depth = 1;
          started = true;
        }
      } else {
        if (ch === '{') {
          depth++;
        } else if (ch === '}') {
          depth--;
          if (depth <= 0) {
            return i + 1; // 1-based номер строки
          }
        }
      }
    }

    // Если за 9 строк после начала открывающая скобка тела не появилась — это однострочное объявление
    if (!started && i >= startLineIndex + 9) {
      return startLineIndex + 1;
    }
  }

  return started ? Math.min(totalLines, startLineIndex + 120) : startLineIndex + 1;
}

/**
 * Вычисляет строку окончания блока в Python по возврату уровня отступа indent
 * @param {string[]} rawLines Массив строк файла
 * @param {number} startLineIndex Индекс строки объявления (0-based)
 * @param {number} totalLines Общее количество строк в файле
 * @returns {number} 1-based номер строки окончания блока
 */
function computePythonEndLine(rawLines, startLineIndex, totalLines, signatureEndIndex = startLineIndex) {
  const startLine = rawLines[startLineIndex];
  const startIndentMatch = startLine.match(/^(\s*)/);
  const startIndent = startIndentMatch ? startIndentMatch[1].length : 0;
  const searchStart = Math.max(startLineIndex + 1, signatureEndIndex + 1);
  const maxLine = Math.min(totalLines, startLineIndex + 120);

  let lastContentLine = searchStart;

  for (let i = searchStart; i < maxLine; i++) {
    const raw = rawLines[i];
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const indentMatch = raw.match(/^(\s*)/);
    const currentIndent = indentMatch ? indentMatch[1].length : 0;

    if (currentIndent <= startIndent) {
      return lastContentLine;
    }
    lastContentLine = i + 1;
  }

  return lastContentLine;
}

/**
 * Индексирует символы файла с точными диапазонами строк [startLine, endLine]
 * @param {string} ext Расширение файла
 * @param {string} content Текстовое содержимое файла
 * @returns {Array<{ name: string, kind: string, signature: string, startLine: number, endLine: number }>}
 */
export function extractFileSymbolsWithRanges(ext, content) {
  if (!content || typeof content !== 'string') return [];

  const cleanContent = maskBlockComments(content);
  const rawLines = cleanContent.split(/\r?\n/);
  const totalLines = rawLines.length;
  const results = [];

  const jsTsExts = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.mts', '.cts'];

  if (jsTsExts.includes(ext)) {
    results.push(...scanJsTsSymbols(rawLines, { withRanges: true }));
  } else if (ext === '.py') {
    for (let i = 0; i < totalLines; i++) {
      const line = rawLines[i].trim();
      if (!line || line.startsWith('#')) continue;

      // Классы Python
      const classMatch = line.match(/^class\s+([A-Za-z0-9_]+)(?:\(([^)]*)\))?:/);
      if (classMatch) {
        const name = classMatch[1];
        const baseStr = classMatch[2] ? `(${classMatch[2]})` : '';
        const startLine = i + 1;
        const endLine = computePythonEndLine(rawLines, i, totalLines);
        results.push({
          name,
          kind: 'class',
          signature: `class ${name}${baseStr}`,
          startLine,
          endLine
        });
        continue;
      }

      // Функции/методы Python (с поддержкой многострочных сигнатур до 8 строк)
      const pyDefStart = line.match(/^(?:async\s+)?def\s+([A-Za-z0-9_]+)\s*\(/);
      if (pyDefStart) {
        const name = pyDefStart[1];
        const startLine = i + 1;
        let params = '';
        let defEndIndex = i;
        const openIdx = line.indexOf('(');
        const closeIdx = line.indexOf(')', openIdx + 1);
        if (closeIdx !== -1) {
          params = line.slice(openIdx + 1, closeIdx).replace(/\s+/g, ' ').trim();
        } else {
          let paramBuf = line.slice(openIdx + 1);
          for (let j = i + 1; j < Math.min(totalLines, i + 9); j++) {
            const nextLine = rawLines[j].trim();
            const nextClose = nextLine.indexOf(')');
            if (nextClose !== -1) {
              paramBuf += ' ' + nextLine.slice(0, nextClose);
              defEndIndex = j;
              break;
            } else {
              paramBuf += ' ' + nextLine;
            }
          }
          params = paramBuf.replace(/\s+/g, ' ').trim();
        }
        const endLine = computePythonEndLine(rawLines, i, totalLines, defEndIndex);
        results.push({
          name,
          kind: 'function',
          signature: `def ${name}(${params})`,
          startLine,
          endLine
        });
        continue;
      }
    }
  } else if (ext === '.go') {
    for (let i = 0; i < totalLines; i++) {
      const line = rawLines[i].trim();
      if (!line || line.startsWith('//')) continue;

      const typeMatch = line.match(/^type\s+([A-Za-z0-9_]+)\s+(struct|interface)/);
      if (typeMatch) {
        const name = typeMatch[1];
        const kind = typeMatch[2];
        const startLine = i + 1;
        const endLine = computeBraceEndLine(rawLines, i, totalLines);
        results.push({
          name,
          kind: 'type',
          signature: `type ${name} ${kind}`,
          startLine,
          endLine
        });
        continue;
      }

      const funcMatch = line.match(/^func\s*(?:\(([^)]+)\)\s*)?([A-Za-z0-9_]+)\s*\(([^)]*)\)/);
      if (funcMatch) {
        const receiver = funcMatch[1] ? `(${funcMatch[1].trim()}) ` : '';
        const name = funcMatch[2];
        const params = funcMatch[3].replace(/\s+/g, ' ').trim();
        const startLine = i + 1;
        const endLine = computeBraceEndLine(rawLines, i, totalLines);
        results.push({
          name,
          kind: 'function',
          signature: `func ${receiver}${name}(${params})`,
          startLine,
          endLine
        });
      }
    }
  } else if (ext === '.rs') {
    for (let i = 0; i < totalLines; i++) {
      const line = rawLines[i].trim();
      if (!line || line.startsWith('//')) continue;

      const structMatch = line.match(/^(?:pub(?:\([^)]+\))?\s+)?(?:struct|enum|trait)\s+([A-Za-z0-9_]+)/);
      if (structMatch) {
        const name = structMatch[1];
        const startLine = i + 1;
        const endLine = computeBraceEndLine(rawLines, i, totalLines);
        results.push({
          name,
          kind: 'type',
          signature: `item ${name}`,
          startLine,
          endLine
        });
        continue;
      }

      const fnMatch = line.match(/^(?:pub(?:\([^)]+\))?\s+)?(?:async\s+)?(?:const\s+)?(?:unsafe\s+)?fn\s+([A-Za-z0-9_]+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)/);
      if (fnMatch) {
        const name = fnMatch[1];
        const params = fnMatch[2].replace(/\s+/g, ' ').trim();
        const startLine = i + 1;
        const endLine = computeBraceEndLine(rawLines, i, totalLines);
        results.push({
          name,
          kind: 'function',
          signature: `fn ${name}(${params})`,
          startLine,
          endLine
        });
      }
    }
  }

  return results;
}

const DEPRIORITIZED_SCAN_DIRS = /^(?:docs|docs_src|examples|tutorials|fixtures|tests|__tests__|test|spec|specs)$/i;

/**
 * Сбалансированное обхождение директорий по Round-Robin BFS между верхнеуровневыми ветками,
 * чтобы монорепозитории и полиглотные проекты не забивали лимит одной папкой (напр. docs_src).
 */
function scanDirectoryBalanced(rootDir, fileList, maxFiles) {
  if (fileList.length >= maxFiles) return;
  const visitedRealDirs = new Set();
  try {
    visitedRealDirs.add(fs.realpathSync(rootDir));
  } catch {
    return;
  }

  let rootEntries;
  try {
    rootEntries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return;
  }
  rootEntries.sort((a, b) => a.name.localeCompare(b.name));

  const primaryBranches = [];
  const lowPriBranches = [];

  for (const entry of rootEntries) {
    if (fileList.length >= maxFiles) break;
    const fullPath = path.join(rootDir, entry.name);
    const relPath = path.relative(rootDir, fullPath).replace(/\\/g, '/');

    const isSymlink = typeof entry.isSymbolicLink === 'function' && entry.isSymbolicLink();
    let isDirectory = entry.isDirectory();
    let isFile = entry.isFile();
    let realPath = '';

    if (isSymlink) {
      try {
        realPath = fs.realpathSync(fullPath);
        if (visitedRealDirs.has(realPath)) continue;
        const st = fs.statSync(fullPath);
        isDirectory = st.isDirectory();
        isFile = st.isFile();
      } catch {
        continue;
      }
    }

    if (isFile) {
      if (IGNORED_FILES.has(entry.name)) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (BINARY_EXTENSIONS.has(ext)) continue;
      if (CODE_EXTENSIONS.has(ext)) {
        fileList.push(relPath);
      }
    } else if (isDirectory) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      try {
        if (!realPath) realPath = fs.realpathSync(fullPath);
        if (visitedRealDirs.has(realPath)) continue;
      } catch {
        continue;
      }
      const branch = { primaryQueue: [fullPath], pHead: 0, lowQueue: [], lHead: 0 };
      if (DEPRIORITIZED_SCAN_DIRS.test(entry.name)) {
        lowPriBranches.push(branch);
      } else {
        primaryBranches.push(branch);
      }
    }
  }

  const visitDir = (currentDir, targetBranch) => {
    if (fileList.length >= maxFiles) return;
    try {
      const realCurrent = fs.realpathSync(currentDir);
      if (visitedRealDirs.has(realCurrent)) return;
      visitedRealDirs.add(realCurrent);
    } catch {
      return;
    }

    let entries;
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (fileList.length >= maxFiles) break;
      const fullPath = path.join(currentDir, entry.name);
      const relPath = path.relative(rootDir, fullPath).replace(/\\/g, '/');

      const isSymlink = typeof entry.isSymbolicLink === 'function' && entry.isSymbolicLink();
      let isDirectory = entry.isDirectory();
      let isFile = entry.isFile();

      if (isSymlink) {
        try {
          const real = fs.realpathSync(fullPath);
          if (visitedRealDirs.has(real)) continue;
          const st = fs.statSync(fullPath);
          isDirectory = st.isDirectory();
          isFile = st.isFile();
        } catch {
          continue;
        }
      }

      if (isDirectory) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        try {
          const realSub = fs.realpathSync(fullPath);
          if (visitedRealDirs.has(realSub)) continue;
        } catch {
          continue;
        }
        if (DEPRIORITIZED_SCAN_DIRS.test(entry.name)) {
          targetBranch.lowQueue.push(fullPath);
        } else {
          targetBranch.primaryQueue.push(fullPath);
        }
      } else if (isFile) {
        if (IGNORED_FILES.has(entry.name)) continue;
        const ext = path.extname(entry.name).toLowerCase();
        if (BINARY_EXTENSIONS.has(ext)) continue;
        if (CODE_EXTENSIONS.has(ext)) {
          fileList.push(relPath);
        }
      }
    }
  };

  const drainRoundRobin = (branches, queueKey, headKey) => {
    let progressed = true;
    while (fileList.length < maxFiles && progressed) {
      progressed = false;
      for (const branch of branches) {
        if (fileList.length >= maxFiles) break;
        const q = branch[queueKey];
        if (branch[headKey] < q.length) {
          progressed = true;
          const dir = q[branch[headKey]++];
          visitDir(dir, branch);
        }
      }
    }
  };

  drainRoundRobin(primaryBranches, 'primaryQueue', 'pHead');
  drainRoundRobin(primaryBranches, 'lowQueue', 'lHead');
  drainRoundRobin(lowPriBranches, 'primaryQueue', 'pHead');
  drainRoundRobin(lowPriBranches, 'lowQueue', 'lHead');

  fileList.sort((a, b) => a.localeCompare(b));
}

/**
 * Рекурсивно сканирует директорию с фильтрацией мусорных путей
 * @param {string} currentDir Текущая директория
 * @param {string} rootDir Корневая директория
 * @param {string[]} fileList Список собранных относительных путей
 * @param {number} maxFiles Максимальное число файлов
 */
function scanDirectory(currentDir, rootDir, fileList, maxFiles, visitedRealDirs = new Set()) {
  if (fileList.length >= maxFiles) return;

  // Защита от кольцевых симлинков на входе в директорию
  try {
    const realCurrent = fs.realpathSync(currentDir);
    if (visitedRealDirs.has(realCurrent)) {
      return;
    }
    visitedRealDirs.add(realCurrent);
  } catch {
    return;
  }

  let entries;
  try {
    entries = fs.readdirSync(currentDir, { withFileTypes: true });
  } catch {
    return;
  }

  // Сортируем для детерминированности карты
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    if (fileList.length >= maxFiles) break;

    const fullPath = path.join(currentDir, entry.name);
    const relPath = path.relative(rootDir, fullPath).replace(/\\/g, '/');

    const isSymlink = typeof entry.isSymbolicLink === 'function' && entry.isSymbolicLink();
    let isDirectory = entry.isDirectory();
    let isFile = entry.isFile();

    if (isSymlink) {
      try {
        const real = fs.realpathSync(fullPath);
        if (visitedRealDirs.has(real)) continue;
        const st = fs.statSync(fullPath);
        isDirectory = st.isDirectory();
        isFile = st.isFile();
      } catch {
        continue;
      }
    }

    if (isDirectory) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      try {
        const realPath = fs.realpathSync(fullPath);
        if (visitedRealDirs.has(realPath)) continue;
      } catch {
        continue;
      }
      scanDirectory(fullPath, rootDir, fileList, maxFiles, visitedRealDirs);
    } else if (isFile) {
      if (IGNORED_FILES.has(entry.name)) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (BINARY_EXTENSIONS.has(ext)) continue;
      if (CODE_EXTENSIONS.has(ext)) {
        fileList.push(relPath);
      }
    }
  }
}

const RU_TO_EN_CODE_TOKENS = [
  [/(?:интерфейс|модалк|панел[ьию]|кноп(?:к|ок)|карточ(?:к|ек))/i, ['ui', 'view', 'modal', 'panel', 'card']],
  [/(?:анимац|частиц|шейдер)/i, ['anim', 'animation', 'particle', 'shader']],
  [/(?:прогресси|уровен|престиж|прокачк)/i, ['progress', 'progression', 'level', 'prestige', 'upgrade']],
  [/(?:магазин|покупк|продаж|ордер|бирж|валют)/i, ['shop', 'store', 'market', 'buy', 'sell', 'order']],
  [/(?:грядк|ферм|урожа|теплиц)/i, ['farm', 'plot', 'crop', 'harvest', 'greenhouse']],
  [/(?:здан|постройк|фабрик|склад)/i, ['building', 'factory', 'storage', 'inventory']],
  [/(?:звук|музык|аудио|синтез)/i, ['audio', 'sound', 'music', 'sfx', 'synth']],
  [/(?:сохран|сейв|хэндофф)/i, ['save', 'storage', 'handoff']],
  [/(?:стресс[-\s]?аудит|верификатор|автомат\s+защит)/i, ['verifier', 'audit', 'stress', 'circuit']],
  [/(?:прунер|отсечени[ея]\s+инструмент)/i, ['prune', 'pruner']],
  [/(?:видеомонтаж|таймлайн|субтитр|шортс|давинчи)/i, ['video', 'montage', 'timeline', 'subtitle', 'shorts', 'davinci', 'fcpxml']],
  [/(?:русифи(?:ц|к)|локализац)/i, ['locale', 'localize', 'translate', 'i18n']]
];

/**
 * Выполняет стемминг слова (русский и английский языки)
 * @param {string} word Исходное слово
 * @returns {string} Стемминированная основа (длиной >= 4) или пустая строка
 */
export function stemWord(word) {
  if (!word || typeof word !== 'string') return '';
  const s = word.toLowerCase();
  if (s.length < 4) return '';

  if (/[а-яё]/.test(s)) {
    const stripped = s
      .replace(/(?:ировани[еяю]|ыровани[еяю]|овани[еяю]|евани[еяю]|ическ[а-я]{1,3}|еческ[а-я]{1,3}|тельн[а-я]{1,3}|енност[ьи]|тельност[ьи]|ност[ьи]|тель[а-я]?|оват[ь]?|иват[ь]?|ыват[ь]?|еват[ь]?|ирова[тл][а-я]?|ова[тл][а-я]?|[еаоя]ть|[еаоя]ти|[еаоя]т|[а-я]ться|[а-я]тся|ск[а-я]{1,3}|нн[а-я]{1,3}|[а-я]вш[а-я]{1,3}|[а-я]ем[а-я]{1,3}|[а-я]им[а-я]{1,3})$/i, '')
      .replace(/(?:[ыио]й|[ая]я|[ое]е|[ыи]е|[ыи]х|[ыи]м|[ая]ми|[ыи]ми|[ое]в|[ео]й|[ео]м|[ая]м|[ая]х|[аеиоуыэюя])$/i, '');
    if (stripped.length >= 4) return stripped;
    return s.length >= 4 ? s : '';
  }

  const strippedEn = s
    .replace(/(?:ization|isation|action|ation|ition|ction|ment|ness|able|ible|ized|ised|izes|ises|ating|ated|ates|ting|ling|ing|ies|ied|ely|ous|ive|ion|ers|er|est|ed|es|ly|s)$/i, '');
  if (strippedEn.length >= 4) return strippedEn;
  return s.length >= 4 ? s : '';
}

/**
 * Извлекает семантические метаданные файла: docSummary и docStems
 * @param {string} ext Расширение файла
 * @param {string} content Содержимое файла
 * @returns {{ docSummary: string, docStems: string[] }}
 */
export function extractFileSemanticMetadata(ext, content) {
  if (!content || typeof content !== 'string') {
    return { docSummary: '', docStems: [] };
  }

  let docSummary = '';

  // 1. Поиск @description или первого смыслового комментария/докстринга
  const descMatch = content.match(/@description\s+([^\r\n*]+)/i);
  if (descMatch && descMatch[1]) {
    docSummary = descMatch[1].trim();
  }

  if (!docSummary) {
    const headLines = content.split(/\r?\n/).slice(0, 50);
    const headText = headLines.join('\n');

    const blockMatch = headText.match(/^\s*\/\*+([\s\S]*?)\*\//m);
    if (blockMatch) {
      const lines = blockMatch[1].split(/\r?\n/);
      for (const line of lines) {
        const cleaned = line.replace(/^\s*\*+\s*/, '').replace(/^[@#\-]\w+\s*/, '').trim();
        if (cleaned && !cleaned.startsWith('eslint') && !cleaned.startsWith('prettier') && !cleaned.startsWith('@file') && !cleaned.startsWith('@author')) {
          docSummary = cleaned;
          break;
        }
      }
    }

    if (!docSummary) {
      const pyDocMatch = headText.match(/^\s*(?:"""([\s\S]*?)"""|'''([\s\S]*?)''')/m);
      if (pyDocMatch) {
        const raw = (pyDocMatch[1] || pyDocMatch[2] || '').trim();
        const firstLine = raw.split(/\r?\n/)[0].trim();
        if (firstLine) docSummary = firstLine;
      }
    }

    if (!docSummary) {
      for (const line of headLines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#!')) continue;
        if (trimmed.startsWith('//') || (trimmed.startsWith('#') && !trimmed.startsWith('#!'))) {
          const cleaned = trimmed.replace(/^[/#]+\s*/, '').trim();
          if (cleaned && !cleaned.startsWith('eslint') && !cleaned.startsWith('@file')) {
            docSummary = cleaned;
            break;
          }
        } else {
          break;
        }
      }
    }

    if (!docSummary && ext === '.html') {
      const titleMatch = content.match(/<title>([^<]+)<\/title>/i);
      const h1Match = content.match(/<h1[^>]*>([^<]+)<\/h1>/i);
      const htmlComment = content.match(/<!--([\s\S]*?)-->/);
      if (titleMatch) {
        docSummary = titleMatch[1].trim();
      } else if (h1Match) {
        docSummary = h1Match[1].trim();
      } else if (htmlComment) {
        const cClean = htmlComment[1].replace(/\r?\n/g, ' ').trim();
        if (cClean) docSummary = cClean;
      }
    }
  }

  if (docSummary) {
    docSummary = docSummary.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (docSummary.length > 100) {
      docSummary = docSummary.slice(0, 97) + '...';
    }
  }

  // 2. Сбор текстовых источников для двуязычных стемов (docStems)
  const textCorpus = [];
  if (docSummary) textCorpus.push(docSummary);

  const commentMatches = content.match(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|#[^\r\n]*|<!--[\s\S]*?-->/g) || [];
  for (const cm of commentMatches) {
    if (cm.length > 500) {
      textCorpus.push(cm.slice(0, 500));
    } else {
      textCorpus.push(cm);
    }
  }

  const uiMatches = content.match(/<(?:h[1-6]|label|button|span|p)[^>]*>([^<]{3,80})<\/(?:h[1-6]|label|button|span|p)>/gi) || [];
  for (const um of uiMatches) {
    const textOnly = um.replace(/<[^>]+>/g, ' ').trim();
    if (textOnly) textCorpus.push(textOnly);
  }
  const uiAttrs = content.match(/(?:title|placeholder|aria-label)\s*=\s*["']([^"']{3,80})["']/gi) || [];
  for (const ua of uiAttrs) {
    textCorpus.push(ua);
  }

  const idMatches = content.match(/(?:function|class|const|let|var|interface|type)\s+([A-Za-z0-9_$]+)/g) || [];
  for (const im of idMatches) {
    textCorpus.push(im);
  }

  // 3. Выделение слов, camelCase декомпозиция и стемминг
  const stemsSet = new Set();
  const rawText = textCorpus.join(' ');
  const unCamel = rawText.replace(/([a-zа-яё0-9])([A-ZА-ЯЁ])/g, '$1 $2');
  const words = unCamel.toLowerCase().match(/[a-zа-яё0-9]+/g) || [];

  for (const word of words) {
    if (word.length >= 4) {
      stemsSet.add(word);
      const stem = stemWord(word);
      if (stem && stem.length >= 4) {
        stemsSet.add(stem);
      }
    }
  }

  return {
    docSummary: docSummary || '',
    docStems: Array.from(stemsSet)
  };
}

/**
 * Разбивает поисковый запрос на токены (слова >= 3 символов на латинице/кириллице с декомпозицией camelCase и snake_case
 * и двуязычным RU->EN отображением в идентификаторы кода)
 * @param {string} text Текст запроса
 * @returns {string[]} Массив уникальных токенов в нижнем регистре
 */
function tokenizeQuery(text) {
  if (!text || typeof text !== 'string') return [];
  // 1. Разбиваем camelCase: fooBar -> foo Bar
  const unCamel = text.replace(/([a-zа-яё0-9])([A-ZА-ЯЁ])/g, '$1 $2');
  // 2. Преобразуем пунктуацию и спецсимволы в пробелы
  const separated = unCamel.replace(/[_\-./\\:;,!?()[\]{}'"`@#$%^&*+=<>~]/g, ' ');
  // 3. Выделяем слова (латиница и кириллица)
  const words = separated.toLowerCase().match(/[a-zа-яё0-9]+/g) || [];
  // 4. Фильтруем слова >= 3 символов и добавляем EN-синонимы для русских терминов
  const out = new Set(words.filter(w => w.length >= 3));
  for (const [rx, enTokens] of RU_TO_EN_CODE_TOKENS) {
    if (rx.test(text)) {
      for (const t of enTokens) out.add(t);
    }
  }
  return Array.from(out);
}

/**
 * Строит ориентированный граф зависимостей между файлами репозитория (u -> v, если u импортирует v)
 * @param {Array<object>} filesIndex Массив метаданных файлов
 * @param {string} absRootDir Абсолютный путь к корню репозитория
 * @returns {number[][]} Список смежности adj[u] = [v1, v2, ...]
 */
function buildDependencyGraph(filesIndex, absRootDir) {
  const N = filesIndex.length;
  const adj = Array.from({ length: N }, () => new Set());

  const fileToNode = new Map();
  const baseToNodes = new Map();
  const suffixToNodes = new Map();

  const addBucket = (map, key, idx) => {
    if (!key) return;
    let arr = map.get(key);
    if (!arr) {
      arr = [];
      map.set(key, arr);
    }
    arr.push(idx);
  };

  for (let i = 0; i < N; i++) {
    const relFile = filesIndex[i].file.replace(/\\/g, '/');
    fileToNode.set(relFile, i);

    const ext = path.extname(relFile).toLowerCase();
    const base = path.basename(relFile, ext);
    addBucket(baseToNodes, base, i);
    addBucket(baseToNodes, path.basename(relFile), i);

    // Pre-index path suffixes (both with and without extension) for O(1) non-relative lookup
    const parts = relFile.split('/');
    for (let k = 0; k < parts.length; k++) {
      const suf = parts.slice(k).join('/');
      addBucket(suffixToNodes, suf, i);
      const noExtSuf = suf.replace(/\.(js|mjs|cjs|ts|tsx)$/i, '');
      if (noExtSuf !== suf) {
        addBucket(suffixToNodes, noExtSuf, i);
      }
    }
  }

  for (let u = 0; u < N; u++) {
    const item = filesIndex[u];
    const uRelFile = item.file.replace(/\\/g, '/');
    const uDir = path.dirname(path.resolve(absRootDir, uRelFile));

    for (const imp of item.imports || []) {
      if (!imp || typeof imp !== 'string') continue;
      const cleanImp = imp.trim().replace(/\\/g, '/');
      if (!cleanImp || cleanImp.startsWith('node:')) continue;

      // 1. Относительный импорт (./ или ../)
      if (cleanImp.startsWith('.')) {
        const absImp = path.resolve(uDir, cleanImp).replace(/\\/g, '/');
        const relImp = path.relative(absRootDir, absImp).replace(/\\/g, '/');

        const candidates = [
          relImp,
          relImp + '.js',
          relImp + '.mjs',
          relImp + '.cjs',
          relImp + '.ts',
          relImp + '.tsx',
          relImp + '/index.js',
          relImp + '/index.ts',
          relImp + '/index.mjs'
        ];

        let matched = false;
        for (const cand of candidates) {
          if (fileToNode.has(cand)) {
            const v = fileToNode.get(cand);
            if (v !== u) {
              adj[u].add(v);
              matched = true;
              break;
            }
          }
        }
        if (matched) continue;
      }

      // 2. Неотносительный импорт: O(1) сопоставление по базовому имени или пути-суффиксу
      if (baseToNodes.has(cleanImp)) {
        for (const v of baseToNodes.get(cleanImp)) {
          if (v !== u) adj[u].add(v);
        }
      } else {
        const normImp = cleanImp.replace(/^\/+/, '');
        const matches = suffixToNodes.get(normImp);
        if (matches && matches.length > 0) {
          for (const v of matches) {
            if (v !== u) {
              adj[u].add(v);
              break;
            }
          }
        }
      }
    }
  }

  return adj.map(s => Array.from(s));
}

/**
 * Вычисляет Personalized PageRank на основе файлов в filesIndex
 * @param {Array<object>} filesIndex Список метаданных файлов
 * @param {string} absRootDir Абсолютный путь к корню репозитория
 * @param {string} [queryText=''] Текст поискового запроса для вектора персонализации
 * @param {object} [options={}] Дополнительные параметры
 * @returns {{ rankedFiles: Array<{ file: string, score: number, seedHits: number, matchedSymbols: Array<{ name: string, signature: string, startLine: number, endLine: number }>, exportedSymbols: string[] }>, totalNodes: number }}
 */
function computePageRankForFilesIndex(filesIndex, absRootDir, queryText = '', options = {}) {
  const N = filesIndex.length;
  if (N === 0) {
    return { rankedFiles: [], totalNodes: 0 };
  }

  const adj = buildDependencyGraph(filesIndex, absRootDir);
  const incoming = Array.from({ length: N }, () => []);
  for (let u = 0; u < N; u++) {
    for (const v of adj[u]) {
      incoming[v].push(u);
    }
  }

  const tokens = tokenizeQuery(queryText);
  const rawScores = new Array(N).fill(0);
  const seedHitsArr = new Array(N).fill(0);
  const matchedSymbolsArr = Array.from({ length: N }, () => []);

  // IDF-фильтрация: отсекаем слишком частые (шумные) токены, которые встречаются более чем в 28% файлов репозитория,
  // чтобы общие слова ("токен", "модель", "файл", "state") не вызывали ложных срабатываний Scope-Scout и Gold Context.
  const tokenDocFreq = new Map();
  if (tokens.length > 0 && N > 4) {
    for (const token of tokens) {
      let df = 0;
      const stemTok = token.length >= 4 ? stemWord(token) : '';
      for (let i = 0; i < N; i++) {
        const item = filesIndex[i];
        const matchFile = item.file.toLowerCase().includes(token);
        const matchSym = (item.symbolsWithRanges || []).some((s) => {
          const sn = s.name.toLowerCase();
          return sn === token || sn.startsWith(token) || (token.length >= 4 && sn.includes(token));
        });
        const matchDoc = token.length >= 4 && (
          (Array.isArray(item.docStems) && (item.docStems.includes(token) || (stemTok && item.docStems.includes(stemTok)))) ||
          (item.docSummary && (item.docSummary.toLowerCase().includes(token) || (stemTok && item.docSummary.toLowerCase().includes(stemTok))))
        );
        if (matchFile || matchSym || matchDoc) {
          df++;
        }
      }
      tokenDocFreq.set(token, df);
    }
  }
  const maxAllowedDf = Math.max(2, Math.floor(N * 0.28));

  for (let i = 0; i < N; i++) {
    const item = filesIndex[i];
    const filePathLower = item.file.toLowerCase();
    const fileBaseLower = path.basename(filePathLower, path.extname(filePathLower));
    const matchedSymNames = new Set();

    if (tokens.length > 0) {
      for (const token of tokens) {
        const df = tokenDocFreq.get(token) || 1;
        const isExactFileBase = fileBaseLower === token || filePathLower.endsWith('/' + token);
        if (df > maxAllowedDf && !isExactFileBase) continue;

        if (filePathLower.includes(token)) {
          rawScores[i] += isExactFileBase ? 6 : 3;
          seedHitsArr[i] += 1;
        }

        // Семантический поиск по docStems и docSummary
        if (token.length >= 4) {
          const stemTok = stemWord(token);
          const inStems = Array.isArray(item.docStems) && (item.docStems.includes(token) || (stemTok && item.docStems.includes(stemTok)));
          const inSummary = item.docSummary && (item.docSummary.toLowerCase().includes(token) || (stemTok && item.docSummary.toLowerCase().includes(stemTok)));
          if (inStems || inSummary) {
            rawScores[i] += 4;
            seedHitsArr[i] += 1;
          }
        }
      }

      for (const sym of item.symbolsWithRanges || []) {
        const symNameLower = sym.name.toLowerCase();
        for (const token of tokens) {
          const df = tokenDocFreq.get(token) || 1;
          const isExactSym = symNameLower === token;
          if (df > maxAllowedDf && !isExactSym) continue;

          const isMatch =
            isExactSym ||
            (token.length >= 5 && symNameLower.startsWith(token)) ||
            (token.length >= 6 && symNameLower.includes(token));
          if (isMatch) {
            rawScores[i] += isExactSym ? 8 : 5;
            seedHitsArr[i] += 1;
            if (!matchedSymNames.has(sym.name)) {
              matchedSymNames.add(sym.name);
              matchedSymbolsArr[i].push({
                name: sym.name,
                signature: sym.signature,
                startLine: sym.startLine,
                endLine: sym.endLine
              });
            }
          }
        }
      }
    }
  }

  // Recency boost: учет недавно измененных файлов из options.recentFiles или session-handoff.json
  let recentList = [];
  if (Array.isArray(options.recentFiles) && options.recentFiles.length > 0) {
    recentList = options.recentFiles;
  } else {
    try {
      const handoffFile = path.join(absRootDir, '.agents', 'session-handoff.json');
      if (fs.existsSync(handoffFile)) {
        const handoffRaw = fs.readFileSync(handoffFile, 'utf8');
        const parsed = JSON.parse(handoffRaw);
        if (Array.isArray(parsed?.touchedFiles)) {
          recentList = parsed.touchedFiles;
        }
      }
    } catch {}
  }

  if (recentList.length > 0) {
    const recentNormSet = new Set();
    for (const rf of recentList) {
      const rawPath = typeof rf === 'string' ? rf : (rf?.file || rf?.path || '');
      if (rawPath) {
        recentNormSet.add(rawPath.replace(/\\/g, '/').toLowerCase());
        recentNormSet.add(path.basename(rawPath).toLowerCase());
      }
    }

    for (let i = 0; i < N; i++) {
      const normFile = filesIndex[i].file.replace(/\\/g, '/').toLowerCase();
      const baseName = path.basename(normFile);
      if (recentNormSet.has(normFile) || recentNormSet.has(baseName)) {
        if (seedHitsArr[i] > 0) {
          rawScores[i] = (rawScores[i] + 2) * 1.25;
        } else if (rawScores[i] > 0) {
          rawScores[i] = rawScores[i] * 1.25;
        }
      }
    }
  }

  const totalScore = rawScores.reduce((acc, s) => acc + s, 0);
  const seed = new Array(N);

  if (tokens.length === 0 || totalScore === 0) {
    // Равномерный вектор для классического структурного PageRank
    for (let i = 0; i < N; i++) {
      seed[i] = 1 / N;
    }
  } else {
    // Нормированный вектор с базовой добавкой 0.05 / N всем узлам
    for (let i = 0; i < N; i++) {
      seed[i] = (0.05 / N) + 0.95 * (rawScores[i] / totalScore);
    }
  }

  const isUtilityHubArr = new Array(N).fill(false);
  for (let v = 0; v < N; v++) {
    if (
      incoming[v].length >= 4 &&
      adj[v].length <= 1 &&
      matchedSymbolsArr[v].length === 0 &&
      rawScores[v] <= 5
    ) {
      isUtilityHubArr[v] = true;
    }
  }

  const d = (tokens.length > 0 && totalScore > 0) ? 0.50 : 0.85;
  const iterations = 15;
  let p = [...seed];

  for (let it = 0; it < iterations; it++) {
    let danglingMass = 0;
    for (let u = 0; u < N; u++) {
      if (adj[u].length === 0) {
        danglingMass += p[u];
      }
    }

    const pNext = new Array(N);
    for (let v = 0; v < N; v++) {
      let sumIncoming = 0;
      for (const u of incoming[v]) {
        sumIncoming += p[u] / adj[u].length;
      }
      if (totalScore > 0 && isUtilityHubArr[v]) {
        sumIncoming = sumIncoming / Math.sqrt(incoming[v].length + 1);
      }
      pNext[v] = (1 - d) * seed[v] + d * (sumIncoming + danglingMass * seed[v]);
    }
    p = pNext;
  }

  const rankedFiles = filesIndex.map((item, idx) => ({
    file: item.file,
    score: Number(p[idx].toFixed(6)),
    seedHits: seedHitsArr[idx],
    directScore: rawScores[idx],
    inDegree: incoming[idx].length,
    outDegree: adj[idx].length,
    isUtilityHub: isUtilityHubArr[idx],
    matchedSymbols: matchedSymbolsArr[idx],
    exportedSymbols: item.exportedSymbols || []
  }));

  rankedFiles.sort((a, b) => {
    if (totalScore > 0 && (b.seedHits > 0) !== (a.seedHits > 0)) {
      return b.seedHits > 0 ? 1 : -1;
    }
    if (b.score !== a.score) return b.score - a.score;
    if (b.seedHits !== a.seedHits) return b.seedHits - a.seedHits;
    return a.file.localeCompare(b.file);
  });

  return {
    rankedFiles,
    totalNodes: N
  };
}

function extractExportedSymbolsFromLines(ext, cleanContent, lines) {
  const symbols = new Set();
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs' || ext === '.ts' || ext === '.tsx') {
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith('//')) continue;

      const fnMatch = line.match(/^export\s+(?:default\s+)?(?:async\s+)?function(?:\s+([A-Za-z0-9_$]+))?(?:\s*<.*>)?/);
      if (fnMatch && fnMatch[1]) {
        symbols.add(fnMatch[1]);
        continue;
      }
      const clsMatch = line.match(/^export\s+(?:default\s+)?class\s+([A-Za-z0-9_$]+)/);
      if (clsMatch && clsMatch[1]) {
        symbols.add(clsMatch[1]);
        continue;
      }
      const varMatch = line.match(/^export\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)/);
      if (varMatch && varMatch[1]) {
        symbols.add(varMatch[1]);
        continue;
      }
      const typeMatch = line.match(/^export\s+(?:type|interface)\s+([A-Za-z0-9_$]+)/);
      if (typeMatch && typeMatch[1]) {
        symbols.add(typeMatch[1]);
        continue;
      }
      const exportsMatch = line.match(/^(?:module\.)?exports\.([A-Za-z0-9_$]+)\s*=/);
      if (exportsMatch && exportsMatch[1]) {
        symbols.add(exportsMatch[1]);
      }
    }

    const exportBlockRegex = /export\s*\{([^}]+)\}/g;
    let blockMatch;
    while ((blockMatch = exportBlockRegex.exec(cleanContent)) !== null) {
      for (const item of blockMatch[1].split(',')) {
        const trimmed = item.trim();
        if (!trimmed) continue;
        const parts = trimmed.split(/\s+as\s+/);
        const exportedName = (parts[1] || parts[0]).trim();
        if (/^[A-Za-z0-9_$]+$/.test(exportedName)) symbols.add(exportedName);
      }
    }

    const cjsBlockRegex = /module\.exports\s*=\s*\{([^}]+)\}/g;
    let cjsMatch;
    while ((cjsMatch = cjsBlockRegex.exec(cleanContent)) !== null) {
      for (const item of cjsMatch[1].split(',')) {
        const trimmed = item.trim();
        if (!trimmed) continue;
        const key = trimmed.split(/[:=]/)[0].trim();
        if (/^[A-Za-z0-9_$]+$/.test(key)) symbols.add(key);
      }
    }
    return Array.from(symbols);
  }
  return extractExportedSymbols(ext, cleanContent);
}

/**
 * Extracts imports, symbols, ranges, exports, and semantic metadata in a single file pass.
 * @param {string} ext
 * @param {string} content
 */
export function extractFileAllMetadata(ext, content) {
  if (!content || typeof content !== 'string') {
    return {
      imports: [],
      symbols: [],
      symbolsWithRanges: [],
      exportedSymbols: [],
      semanticMeta: { docSummary: '', docStems: [] },
      linesCount: 0,
    };
  }

  const linesCount = content.split(/\r?\n/).length;
  const semanticMeta = extractFileSemanticMetadata(ext, content);

  if (ext === '.json') {
    const symRes = extractFileSymbols(ext, content);
    return {
      imports: symRes.imports || [],
      symbols: symRes.symbols || [],
      symbolsWithRanges: [],
      exportedSymbols: [],
      semanticMeta,
      linesCount,
    };
  }

  if (ext === '.js' || ext === '.mjs' || ext === '.cjs' || ext === '.ts' || ext === '.tsx') {
    const cleanContent = maskBlockComments(content);
    const lines = cleanContent.split(/\r?\n/);
    const importsSet = new Set();
    const symbolsWithRanges = scanJsTsSymbols(lines, { withRanges: true, imports: importsSet });
    const symbols = symbolsWithRanges.map((s) => s.signature);
    const exportedSymbols = extractExportedSymbolsFromLines(ext, cleanContent, lines);
    return {
      imports: Array.from(importsSet),
      symbols,
      symbolsWithRanges,
      exportedSymbols,
      semanticMeta,
      linesCount: lines.length,
    };
  }

  const { imports, symbols } = extractFileSymbols(ext, content);
  const symbolsWithRanges = extractFileSymbolsWithRanges(ext, content);
  const exportedSymbols = extractExportedSymbols(ext, content);
  return {
    imports,
    symbols,
    symbolsWithRanges,
    exportedSymbols,
    semanticMeta,
    linesCount,
  };
}

/**
 * Генерирует компактную карту репозитория (Repo Map)
 * @param {string} rootDir Корневая папка репозитория
 * @param {object} options Параметры генерации
 * @param {number} [options.maxFiles=120] Максимум файлов в выборке
 * @param {number} [options.maxBytesPerFile=65536] Максимальный размер файла для парсинга (байт)
 * @param {number} [options.maxChars=0] Максимальная длина карты в символах (при >0 включается PageRank ранжирование)
 * @returns {{ markdown: string, fileCount: number, symbolCount: number, fullBytes: number, mapBytes: number, savedBytes: number, generatedAt: string, filesIndex: Array<object> }}
 */
export function generateRepoMap(rootDir, options = {}) {
  const maxFiles = options.maxFiles || 1200;
  const maxBytesPerFile = options.maxBytesPerFile || 65536;
  const maxChars = options.maxChars || 0;

  const targetDir = path.resolve(rootDir);
  const relFiles = [];
  scanDirectoryBalanced(targetDir, relFiles, maxFiles);

  let fullBytes = 0;
  let totalSymbols = 0;
  const filesIndex = [];
  const fileEntries = [];

  for (const relPath of relFiles) {
    const fullPath = path.join(targetDir, relPath);
    let stat;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      continue;
    }

    fullBytes += stat.size;
    const ext = path.extname(relPath).toLowerCase();

    if (stat.size > maxBytesPerFile) {
      fileEntries.push({
        relPath,
        skipped: true,
        skipReason: `*(file > ${maxBytesPerFile}B — skipped)*`,
        symbolsCount: 0
      });
      continue;
    }

    let content = '';
    try {
      content = fs.readFileSync(fullPath, 'utf8');
    } catch {
      continue;
    }

    const {
      imports,
      symbols,
      symbolsWithRanges,
      exportedSymbols,
      semanticMeta,
      linesCount,
    } = extractFileAllMetadata(ext, content);

    filesIndex.push({
      file: relPath,
      size: stat.size,
      imports,
      exportedSymbols,
      symbolsWithRanges,
      docSummary: semanticMeta.docSummary,
      docStems: semanticMeta.docStems,
      linesCount
    });

    const lines = [`### \`${relPath}\``];
    if (imports.length > 0) {
      lines.push(`- **Imports**: ${imports.map(i => `\`${i}\``).join(', ')}`);
    }

    let fileSymbolsCount = 0;
    if (symbolsWithRanges.length > 0) {
      for (const sym of symbolsWithRanges) {
        lines.push(`- \`${sym.signature}\` [L${sym.startLine}-L${sym.endLine}]`);
      }
      fileSymbolsCount = symbolsWithRanges.length;
      totalSymbols += symbolsWithRanges.length;
    } else if (symbols.length > 0) {
      for (const sym of symbols) {
        lines.push(`- \`${sym}\``);
      }
      fileSymbolsCount = symbols.length;
      totalSymbols += symbols.length;
    } else if (imports.length === 0) {
      lines.push(`- *(no symbols)*`);
    }

    fileEntries.push({
      relPath,
      skipped: false,
      sectionText: lines.join('\n'),
      symbolsCount: fileSymbolsCount
    });
  }

  const generatedAt = new Date().toISOString();

  // При включенном ограничении maxChars сортируем секции по графовой центральности PageRank
  if (maxChars > 0 && filesIndex.length > 0) {
    const { rankedFiles } = computePageRankForFilesIndex(filesIndex, targetDir, '');
    const rankMap = new Map();
    rankedFiles.forEach((rf, idx) => rankMap.set(rf.file, idx));

    fileEntries.sort((a, b) => {
      const rA = rankMap.has(a.relPath) ? rankMap.get(a.relPath) : 999999;
      const rB = rankMap.has(b.relPath) ? rankMap.get(b.relPath) : 999999;
      return rA - rB;
    });

    const footer = `\n\n*(RepoMap capped at ${maxChars} chars)*`;
    const sections = [];
    let curLen = 140 + footer.length;
    let includedCount = 0;
    let includedSymbols = 0;

    for (const entry of fileEntries) {
      const text = entry.skipped ? `### \`${entry.relPath}\`\n${entry.skipReason}` : entry.sectionText;
      const secLen = text.length + 2;
      if (curLen + secLen > maxChars && sections.length > 0) {
        break;
      }
      sections.push(text);
      curLen += secLen;
      includedCount++;
      includedSymbols += entry.symbolsCount;
    }

    const needsFooter = includedCount < fileEntries.length;
    const header = [
      `# Repo Map`,
      `Files: ${includedCount} | Symbols: ${includedSymbols}`,
      ``
    ].join('\n');

    const markdown = `${header}\n${sections.join('\n\n')}${needsFooter ? footer : ''}\n`;
    const mapBytes = Buffer.byteLength(markdown, 'utf8');
    const savedBytes = Math.max(0, fullBytes - mapBytes);

    return {
      markdown,
      fileCount: includedCount,
      symbolCount: includedSymbols,
      fullBytes,
      mapBytes,
      savedBytes,
      generatedAt,
      filesIndex
    };
  }

  const sections = fileEntries.map(e => e.skipped ? `### \`${e.relPath}\`\n${e.skipReason}` : e.sectionText);
  const header = [
    `# Repo Map`,
    `Files: ${relFiles.length} | Symbols: ${totalSymbols}`,
    ``
  ].join('\n');

  const markdown = `${header}\n${sections.join('\n\n')}\n`;
  const mapBytes = Buffer.byteLength(markdown, 'utf8');
  const savedBytes = Math.max(0, fullBytes - mapBytes);

  return {
    markdown,
    fileCount: relFiles.length,
    symbolCount: totalSymbols,
    fullBytes,
    mapBytes,
    savedBytes,
    generatedAt,
    filesIndex
  };
}

const repoMapMemCache = new Map();
const REPO_MAP_MEM_MAX = 8;

function setRepoMapMemCache(normKey, entry) {
  if (repoMapMemCache.has(normKey)) {
    repoMapMemCache.delete(normKey);
  } else if (repoMapMemCache.size >= REPO_MAP_MEM_MAX) {
    const oldest = repoMapMemCache.keys().next().value;
    if (oldest !== undefined) repoMapMemCache.delete(oldest);
  }
  repoMapMemCache.set(normKey, entry);
}

function pruneRepoMapSnapshots(cacheDir, maxKeep = 6) {
  try {
    if (!fs.existsSync(cacheDir)) return;
    const files = [];
    for (const ent of fs.readdirSync(cacheDir, { withFileTypes: true })) {
      if (!ent.isFile() || !/^repomap-.*\.json$/i.test(ent.name)) continue;
      const fullPath = path.join(cacheDir, ent.name);
      try {
        const st = fs.statSync(fullPath);
        if (st.size === 0) {
          try { fs.unlinkSync(fullPath); } catch {}
          continue;
        }
        files.push({ fullPath, mtimeMs: st.mtimeMs });
      } catch {}
    }
    if (files.length <= maxKeep) return;
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (let i = maxKeep; i < files.length; i++) {
      try { fs.unlinkSync(files[i].fullPath); } catch {}
    }
  } catch {}
}

/**
 * Точечно инвалидирует кэш карты репозитория (в ОЗУ и .cache/repomap-*.json) после правок файлов.
 * @param {string} [rootDir=''] Корневая директория воркспейса
 */
export function invalidateRepoMapCache(rootDir = '') {
  try {
    const targetDir = path.resolve(rootDir || process.cwd());
    const normKey = process.platform === 'win32' ? targetDir.toLowerCase() : targetDir;
    repoMapMemCache.delete(normKey);
    const hash = crypto.createHash('sha1').update(normKey).digest('hex').slice(0, 10);
    const currentFilePath = fileURLToPath(import.meta.url);
    const pluginRoot = path.resolve(path.dirname(currentFilePath), '..');
    const cacheFile = path.join(resolveTunnelCacheDir(pluginRoot), `repomap-${hash}.json`);
    if (fs.existsSync(cacheFile)) {
      fs.unlinkSync(cacheFile);
    }
  } catch {}
}

/**
 * Получает кэшированную карту репозитория с TTL 5 минут
 * @param {string} rootDir Корневая директория репозитория
 * @param {boolean} [forceRefresh=false] Принудительно обновить кэш
 * @returns {{ markdown: string, fileCount: number, symbolCount: number, fullBytes: number, mapBytes: number, savedBytes: number, generatedAt: string }}
 */
export function getCachedRepoMap(rootDir, forceRefresh = false) {
  const targetDir = path.resolve(rootDir);
  const normKey = process.platform === 'win32' ? targetDir.toLowerCase() : targetDir;
  const hash = crypto.createHash('sha1').update(normKey).digest('hex').slice(0, 10);

  // Корень плагина находится на один уровень выше каталога core/
  const currentFilePath = fileURLToPath(import.meta.url);
  const pluginRoot = path.resolve(path.dirname(currentFilePath), '..');
  const cacheDir = resolveTunnelCacheDir(pluginRoot);
  const cacheFile = path.join(cacheDir, `repomap-${hash}.json`);

  const TTL_MS = 5 * 60 * 1000; // 5 минут

  if (!forceRefresh) {
    const mem = repoMapMemCache.get(normKey);
    if (mem && mem.schemaVersion === REPOMAP_SCHEMA_VERSION && Date.now() - mem.timestamp < TTL_MS) {
      try {
        if (fs.existsSync(cacheFile) && fs.statSync(cacheFile).mtimeMs === mem.fileMtimeMs) {
          return mem.data;
        }
      } catch {}
    }

    if (fs.existsSync(cacheFile)) {
      try {
        const st = fs.statSync(cacheFile);
        if (st.size > 0) {
          const raw = fs.readFileSync(cacheFile, 'utf8');
          const cached = JSON.parse(raw);
          if (cached && cached.schemaVersion === REPOMAP_SCHEMA_VERSION && cached.timestamp && (Date.now() - cached.timestamp < TTL_MS)) {
            setRepoMapMemCache(normKey, { schemaVersion: REPOMAP_SCHEMA_VERSION, timestamp: cached.timestamp, fileMtimeMs: st.mtimeMs, data: cached.data });
            return cached.data;
          }
        }
      } catch {
        // При ошибке чтения кэша перегенерируем заново
      }
    }
  }

  const data = generateRepoMap(targetDir);
  const nowTs = Date.now();

  try {
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }
    atomicWriteJsonSync(cacheFile, { schemaVersion: REPOMAP_SCHEMA_VERSION, timestamp: nowTs, data }, { spaces: 0 });
    pruneRepoMapSnapshots(cacheDir, 6);
    const st = fs.statSync(cacheFile);
    setRepoMapMemCache(normKey, { schemaVersion: REPOMAP_SCHEMA_VERSION, timestamp: nowTs, fileMtimeMs: st.mtimeMs, data });
  } catch {
    setRepoMapMemCache(normKey, { schemaVersion: REPOMAP_SCHEMA_VERSION, timestamp: nowTs, fileMtimeMs: 0, data });
  }

  return data;
}

/**
 * Извлекает имена экспортируемых сущностей (функции, классы, константы, типы, интерфейсы)
 * @param {string} ext Расширение файла
 * @param {string} content Текстовое содержимое файла
 * @returns {string[]} Список имён экспортируемых символов
 */
export function extractExportedSymbols(ext, content) {
  if (!content || typeof content !== 'string') return [];
  const symbols = new Set();
  const cleanContent = content.replace(/\/\*[\s\S]*?\*\//g, '');
  const lines = cleanContent.split(/\r?\n/);

  const jsTsExts = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.mts', '.cts'];
  if (jsTsExts.includes(ext)) {
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith('//')) continue;

      // export [default] [async] function name (с поддержкой TS дженериков)
      const fnMatch = line.match(/^export\s+(?:default\s+)?(?:async\s+)?function(?:\s+([A-Za-z0-9_$]+))?(?:\s*<.*>)?/);
      if (fnMatch && fnMatch[1]) {
        symbols.add(fnMatch[1]);
        continue;
      }

      // export [default] class Name
      const clsMatch = line.match(/^export\s+(?:default\s+)?class\s+([A-Za-z0-9_$]+)/);
      if (clsMatch && clsMatch[1]) {
        symbols.add(clsMatch[1]);
        continue;
      }

      // export const / let / var name
      const varMatch = line.match(/^export\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)/);
      if (varMatch && varMatch[1]) {
        symbols.add(varMatch[1]);
        continue;
      }

      // export type / interface Name
      const typeMatch = line.match(/^export\s+(?:type|interface)\s+([A-Za-z0-9_$]+)/);
      if (typeMatch && typeMatch[1]) {
        symbols.add(typeMatch[1]);
        continue;
      }

      // exports.name = ... or module.exports.name = ...
      const exportsMatch = line.match(/^(?:module\.)?exports\.([A-Za-z0-9_$]+)\s*=/);
      if (exportsMatch && exportsMatch[1]) {
        symbols.add(exportsMatch[1]);
        continue;
      }
    }

    // Блочный экспорт: export { a, b as c, ... }
    const exportBlockRegex = /export\s*\{([^}]+)\}/g;
    let blockMatch;
    while ((blockMatch = exportBlockRegex.exec(cleanContent)) !== null) {
      const items = blockMatch[1].split(',');
      for (const item of items) {
        const trimmed = item.trim();
        if (!trimmed) continue;
        const parts = trimmed.split(/\s+as\s+/);
        const exportedName = (parts[1] || parts[0]).trim();
        if (/^[A-Za-z0-9_$]+$/.test(exportedName)) {
          symbols.add(exportedName);
        }
      }
    }

    // module.exports = { a, b, c }
    const cjsBlockRegex = /module\.exports\s*=\s*\{([^}]+)\}/g;
    let cjsMatch;
    while ((cjsMatch = cjsBlockRegex.exec(cleanContent)) !== null) {
      const items = cjsMatch[1].split(',');
      for (const item of items) {
        const trimmed = item.trim();
        if (!trimmed) continue;
        const key = trimmed.split(/[:=]/)[0].trim();
        if (/^[A-Za-z0-9_$]+$/.test(key)) {
          symbols.add(key);
        }
      }
    }
  } else if (ext === '.py') {
    const allMatch = cleanContent.match(/__all__\s*=\s*\[([\s\S]*?)\]/);
    if (allMatch) {
      const items = allMatch[1].match(/['"]([A-Za-z0-9_]+)['"]/g);
      if (items) {
        for (const it of items) {
          symbols.add(it.replace(/['"]/g, ''));
        }
      }
    }
    if (symbols.size === 0) {
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const defMatch = line.match(/^(?:async\s+)?def\s+([A-Za-z0-9_]+)\s*\(/);
        if (defMatch && !defMatch[1].startsWith('_')) symbols.add(defMatch[1]);
        const clsMatch = line.match(/^class\s+([A-Za-z0-9_]+)/);
        if (clsMatch && !clsMatch[1].startsWith('_')) symbols.add(clsMatch[1]);
      }
    }
  }

  return Array.from(symbols);
}

function doesImportMatchTarget(
  cleanImpRaw,
  importerDir,
  absTarget,
  normTarget,
  targetExt,
  relativeTarget,
  relativeNoExt,
  targetBaseName,
  targetFileWithExt,
  samePath,
  endsWithPath
) {
  const cleanImp = String(cleanImpRaw || '').split('?')[0].split('#')[0].trim();
  if (!cleanImp) return false;

  // Python relative imports: `from .helpers import calc` or `from ..pkg import mod`
  if (targetExt === '.py' && cleanImp.startsWith('.') && !cleanImp.startsWith('./') && !cleanImp.startsWith('../')) {
    const dots = cleanImp.match(/^\.+/)?.[0].length || 1;
    let baseDir = importerDir;
    for (let i = 1; i < dots; i++) {
      baseDir = path.dirname(baseDir);
    }
    const modRel = cleanImp.slice(dots).replace(/\./g, '/');
    const pyCandidates = modRel
      ? [
          path.join(baseDir, `${modRel}.py`).replace(/\\/g, '/'),
          path.join(baseDir, modRel, '__init__.py').replace(/\\/g, '/'),
        ]
      : [path.join(baseDir, '__init__.py').replace(/\\/g, '/')];
    for (const cand of pyCandidates) {
      if (samePath(cand, normTarget)) return true;
    }
    return false;
  }

  // А) Проверка относительного пути (./..., ../...)
  if (cleanImp.startsWith('./') || cleanImp.startsWith('../') || cleanImp === '.' || cleanImp === '..') {
    const resolvedImp = path.resolve(importerDir, cleanImp).replace(/\\/g, '/');
    if (
      samePath(resolvedImp, normTarget) ||
      samePath(resolvedImp + targetExt, normTarget) ||
      samePath(resolvedImp + '.js', normTarget) ||
      samePath(resolvedImp + '.mjs', normTarget) ||
      samePath(resolvedImp + '.ts', normTarget) ||
      samePath(resolvedImp + '.tsx', normTarget) ||
      samePath(resolvedImp + '.mts', normTarget) ||
      samePath(resolvedImp + '.cts', normTarget) ||
      samePath(resolvedImp + '.d.ts', normTarget)
    ) {
      return true;
    }

    // TS NodeNext convention: `./foo.js` -> `./foo.ts` / `.tsx` / `.mts` / `.cts` / `.d.ts`
    if (/\.(?:[cm]?js|jsx)$/i.test(resolvedImp)) {
      const stem = resolvedImp.replace(/\.(?:[cm]?js|jsx)$/i, '');
      for (const tsExt of ['.ts', '.tsx', '.mts', '.cts', '.d.ts', '.d.mts', '.d.cts', '.jsx']) {
        if (samePath(stem + tsExt, normTarget)) return true;
      }
      if (endsWithPath(normTarget, '/index' + targetExt) && samePath(stem, normTarget.slice(0, -(targetExt.length + 6)))) {
        return true;
      }
    }

    // Сопоставление с index-файлами
    if (endsWithPath(normTarget, '/index' + targetExt) && samePath(resolvedImp, normTarget.slice(0, -(targetExt.length + 6)))) {
      return true;
    }
  }

  // Б) Проверка совпадения по относительному пути или базовому имени
  const cleanImpNoJsExt = cleanImp.replace(/\.(?:[cm]?js|jsx)$/i, '');
  if (
    samePath(cleanImp, targetBaseName) ||
    endsWithPath(cleanImp, '/' + targetBaseName) ||
    endsWithPath(cleanImp, '/' + targetFileWithExt) ||
    samePath(cleanImp, relativeTarget) ||
    samePath(cleanImp, relativeNoExt) ||
    (cleanImpNoJsExt !== cleanImp && samePath(cleanImpNoJsExt, relativeNoExt))
  ) {
    return true;
  }

  return false;
}

/**
 * Находит все исходные файлы в rootDir, которые импортируют targetFilePath (Blast Radius анализ).
 * @param {string} rootDir Корневая директория репозитория
 * @param {string} targetFilePath Путь к целевому файлу (абсолютный или относительный)
 * @param {number} [maxDependents=8] Максимальное количество зависимых модулей
 * @returns {{ targetFile: string, exportedSymbols: string[], dependents: Array<{ file: string, signatures: string[] }>, formattedHint: string }}
 */
export function findReverseImporters(rootDir, targetFilePath, maxDependents = 8) {
  const absRoot = path.resolve(rootDir);
  const absTarget = path.isAbsolute(targetFilePath)
    ? path.resolve(targetFilePath)
    : path.resolve(absRoot, targetFilePath);

  const relativeTarget = path.relative(absRoot, absTarget).replace(/\\/g, '/');
  const targetExt = path.extname(absTarget).toLowerCase();
  const targetBaseName = path.basename(absTarget, targetExt);
  const targetFileWithExt = path.basename(absTarget);

  // 1. Извлекаем экспорты целевого файла
  let exportedSymbols = [];
  if (fs.existsSync(absTarget)) {
    try {
      const targetContent = fs.readFileSync(absTarget, 'utf8');
      exportedSymbols = extractExportedSymbols(targetExt, targetContent);
    } catch {}
  }

  // 2. Сначала проверяем кэш репозитория (мгновенно из памяти без повторного чтения с диска)
  const dependents = [];
  let usedCache = false;
  const isWin = process.platform === 'win32';
  const samePath = (a, b) => (isWin ? String(a).toLowerCase() === String(b).toLowerCase() : a === b);
  const endsWithPath = (a, suffix) =>
    isWin ? String(a).toLowerCase().endsWith(String(suffix).toLowerCase()) : String(a).endsWith(suffix);
  const escapedExt = targetExt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const extStripRe = escapedExt ? new RegExp(`${escapedExt}$`, isWin ? 'i' : '') : null;
  const relativeNoExt = extStripRe ? relativeTarget.replace(extStripRe, '') : relativeTarget;
  const normTarget = absTarget.replace(/\\/g, '/');

  try {
    const cached = getCachedRepoMap(absRoot);
    if (cached && Array.isArray(cached.filesIndex) && cached.filesIndex.length > 0) {
      usedCache = true;
      for (const entry of cached.filesIndex) {
        if (dependents.length >= maxDependents) break;
        const relFile = String(entry.file || '').replace(/\\/g, '/');
        if (!relFile || relFile === relativeTarget) continue;

        const fullFilePath = path.join(absRoot, relFile);
        const importerDir = path.dirname(fullFilePath);
        let isDependent = false;

        const imports = Array.isArray(entry.imports) ? entry.imports : [];
        for (const imp of imports) {
          if (!imp || typeof imp !== 'string') continue;
          const cleanImp = imp.trim().replace(/\\/g, '/');
          if (
            doesImportMatchTarget(
              cleanImp,
              importerDir,
              absTarget,
              normTarget,
              targetExt,
              relativeTarget,
              relativeNoExt,
              targetBaseName,
              targetFileWithExt,
              samePath,
              endsWithPath
            )
          ) {
            isDependent = true;
            break;
          }
        }

        if (isDependent) {
          let signatures = [];
          if (Array.isArray(entry.symbolsWithRanges) && entry.symbolsWithRanges.length > 0) {
            signatures = entry.symbolsWithRanges.slice(0, 6).map((s) => s.signature || String(s));
          } else if (Array.isArray(entry.exportedSymbols) && entry.exportedSymbols.length > 0) {
            signatures = entry.exportedSymbols.slice(0, 6);
          }
          dependents.push({
            file: relFile,
            signatures
          });
        }
      }
    }
  } catch {}

  // Fallback: сканирование репозитория с диска, если кэш недоступен
  if (!usedCache) {
    const fileList = [];
    scanDirectory(absRoot, absRoot, fileList, 600);

    for (const relFile of fileList) {
      if (dependents.length >= maxDependents) break;
      if (relFile === relativeTarget) continue;

      const fullFilePath = path.join(absRoot, relFile);
      let content = '';
      try {
        content = fs.readFileSync(fullFilePath, 'utf8');
      } catch {
        continue;
      }

      const ext = path.extname(relFile).toLowerCase();
      const { imports, symbols } = extractFileSymbols(ext, content);

      const importerDir = path.dirname(fullFilePath);
      let isDependent = false;

      for (const imp of imports) {
        if (!imp || typeof imp !== 'string') continue;
        const cleanImp = imp.trim().replace(/\\/g, '/');
        if (
          doesImportMatchTarget(
            cleanImp,
            importerDir,
            absTarget,
            normTarget,
            targetExt,
            relativeTarget,
            relativeNoExt,
            targetBaseName,
            targetFileWithExt,
            samePath,
            endsWithPath
          )
        ) {
          isDependent = true;
          break;
        }
      }

      if (isDependent) {
        dependents.push({
          file: relFile,
          signatures: symbols.slice(0, 6)
        });
      }
    }
  }

  // 3. Формируем компактный formattedHint (<= 900 символов)
  let formattedHint = '';
  if (dependents.length > 0) {
    const depLines = dependents.map((d) => {
      const sigs = d.signatures.length > 0 ? ` [${d.signatures.slice(0, 3).join(', ')}]` : '';
      return `• \`${d.file}\`${sigs}`;
    });

    let hint = `⚠️ [Blast Radius] \`${relativeTarget}\` imported by ${dependents.length} files:\n${depLines.join('\n')}${exportedSymbols.length ? `\nExports: ${exportedSymbols.slice(0, 8).join(', ')}` : ''}\nKeep exported signatures backward-compatible!`;

    if (hint.length > 900) {
      formattedHint = hint.slice(0, 896) + '...';
    } else {
      formattedHint = hint;
    }
  }

  return {
    targetFile: relativeTarget,
    exportedSymbols,
    dependents,
    formattedHint
  };
}

/**
 * Модуль #1: Графовый PageRank символов и файлов репозитория
 * @param {string} rootDir Корневая директория репозитория
 * @param {string} [queryText=''] Поисковый запрос (при пустом или отсутствии совпадений возвращает классический структурный PageRank)
 * @param {object} [options={}] Дополнительные параметры
 * @returns {{ rankedFiles: Array<{ file: string, score: number, seedHits: number, matchedSymbols: Array<{ name: string, signature: string, startLine: number, endLine: number }>, exportedSymbols: string[] }>, totalNodes: number }}
 */
export function rankRepoByPageRank(rootDir, queryText = '', options = {}) {
  const absRoot = path.resolve(rootDir);
  const repoData = getCachedRepoMap(absRoot);
  const filesIndex = repoData.filesIndex || [];
  return computePageRankForFilesIndex(filesIndex, absRoot, queryText, options);
}

/**
 * Определяет тег подсветки синтаксиса для блоков кода в Markdown
 * @param {string} ext Расширение файла
 * @returns {string} Тег языка (js, ts, py, go, rs, json, text)
 */
function getCodeFenceLang(ext) {
  switch (ext) {
    case '.js':
    case '.mjs':
    case '.cjs':
      return 'js';
    case '.ts':
      return 'ts';
    case '.tsx':
      return 'tsx';
    case '.py':
      return 'py';
    case '.go':
      return 'go';
    case '.rs':
      return 'rs';
    case '.json':
      return 'json';
    default:
      return 'text';
  }
}

const XRAY_IGNORED_CALLS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return',
  'typeof', 'instanceof', 'await', 'async', 'import', 'export',
  'new', 'super', 'this', 'Number', 'String', 'Boolean', 'Array',
  'Object', 'Math', 'JSON', 'console', 'Promise', 'Set', 'Map',
  'Date', 'RegExp', 'Error', 'Buffer', 'parseInt', 'parseFloat',
  'isNaN', 'setTimeout', 'clearTimeout'
]);

/**
 * Extracts a lightweight semantic "X-Ray" profile of a function/class implementation.
 * Identifies up to 6 unique external calls and up to 6 state/input property reads.
 * @param {string} [codeText=''] Source code of the symbol implementation
 * @returns {{ calls: string[], props: string[], summary: string }}
 */
export function extractFunctionXRay(codeText = '') {
  if (!codeText || typeof codeText !== 'string') {
    return { calls: [], props: [], summary: '' };
  }

  const declMatch = codeText.match(/(?:function\s+|class\s+|def\s+|(?:const|let|var)\s+)([a-zA-Z_$][a-zA-Z0-9_$]*)/);
  const ownName = declMatch ? declMatch[1] : null;

  const calls = [];
  const props = [];
  const callSet = new Set();
  const propSet = new Set();

  const lines = codeText.split(/\r?\n/).slice(0, 200);
  for (const line of lines) {
    if (!line || line.length > 500) continue;

    if (calls.length < 6) {
      const callRegex = /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g;
      let m;
      while ((m = callRegex.exec(line)) !== null) {
        const fnName = m[1];
        if (
          !XRAY_IGNORED_CALLS.has(fnName) &&
          fnName !== ownName &&
          !callSet.has(fnName)
        ) {
          callSet.add(fnName);
          calls.push(fnName);
          if (calls.length >= 6) break;
        }
      }
    }

    if (props.length < 6) {
      const propRegex = /\b(state|payload|args|options|params)\.([a-zA-Z_$][a-zA-Z0-9_$]*)\b/g;
      let pm;
      while ((pm = propRegex.exec(line)) !== null) {
        const propStr = `${pm[1]}.${pm[2]}`;
        if (!propSet.has(propStr)) {
          propSet.add(propStr);
          props.push(propStr);
          if (props.length >= 6) break;
        }
      }
    }

    if (calls.length >= 6 && props.length >= 6) {
      break;
    }
  }

  const parts = [];
  if (calls.length > 0) parts.push(`calls: [${calls.join(', ')}]`);
  if (props.length > 0) parts.push(`reads: [${props.join(', ')}]`);
  const summary = parts.join(' | ');

  return { calls, props, summary };
}

/**
 * Модуль #2: Zero-Turn нарезка «Золотого контекста» репозитория на основе PageRank
 * @param {string} rootDir Корневая папка репозитория
 * @param {string} [queryText=''] Текст задачи пользователя
 * @param {object} [options={}] Параметры нарезки
 * @param {number} [options.maxSlices=3] Максимум срезов кода
 * @param {number} [options.maxLinesPerSlice=26] Максимум строк на один срез
 * @param {number} [options.maxTotalChars=1400] Максимальная длина подсказки в символах
 * @returns {{ slices: Array<{ file: string, symbolName: string, signature: string, startLine: number, endLine: number, linesCount: number, lang: string, code: string }>, formattedHint: string, savedBytes: number }}
 */
export function extractGoldContextSlices(rootDir, queryText = '', options = {}) {
  const maxSlices = options.maxSlices ?? 3;
  const maxLinesPerSlice = options.maxLinesPerSlice ?? 26;
  const maxTotalChars = options.maxTotalChars ?? 1400;

  if (!queryText || typeof queryText !== 'string' || queryText.trim().length < 8) {
    return { slices: [], formattedHint: '', savedBytes: 0 };
  }

  const absRoot = path.resolve(rootDir);
  const { rankedFiles } = rankRepoByPageRank(absRoot, queryText, options);

  // Выбираем только файлы с реальным лексическим/символьным попаданием
  const candidateFiles = rankedFiles.filter(rf => rf.seedHits > 0);
  if (candidateFiles.length === 0) {
    return { slices: [], formattedHint: '', savedBytes: 0 };
  }

  const cached = getCachedRepoMap(absRoot);
  const filesIndexMap = new Map((cached.filesIndex || []).map(f => [f.file, f]));

  const slices = [];
  const touchedFiles = new Set();
  let snippetBytes = 0;

  for (const fileItem of candidateFiles) {
    if (slices.length >= maxSlices) break;

    const fileMeta = filesIndexMap.get(fileItem.file);
    let targetSymbols = fileItem.matchedSymbols;

    if (!targetSymbols || targetSymbols.length === 0) {
      // Если совпал путь файла, но не имя символа — берем первый экспортируемый символ/функцию
      if (fileMeta && fileMeta.symbolsWithRanges && fileMeta.symbolsWithRanges.length > 0) {
        targetSymbols = [fileMeta.symbolsWithRanges[0]];
      } else {
        continue;
      }
    }

    const absPath = path.resolve(absRoot, fileItem.file);
    let content = '';
    try {
      content = fs.readFileSync(absPath, 'utf8');
    } catch {
      continue;
    }

    const lines = content.split(/\r?\n/);
    const ext = path.extname(fileItem.file).toLowerCase();
    const lang = getCodeFenceLang(ext);

    for (const sym of targetSymbols) {
      if (slices.length >= maxSlices) break;

      const startIdx = Math.max(0, sym.startLine - 1);
      const sliceEndLine = Math.min(sym.endLine, sym.startLine + maxLinesPerSlice - 1);
      const endIdx = Math.min(lines.length, sliceEndLine);

      const numberedLines = [];
      for (let l = startIdx + 1; l <= endIdx; l++) {
        numberedLines.push(`L${l}: ${lines[l - 1]}`);
      }

      const codeStr = numberedLines.join('\n');
      touchedFiles.add(absPath);
      snippetBytes += Buffer.byteLength(codeStr, 'utf8');

      const fullSymBody = lines.slice(Math.max(0, sym.startLine - 1), Math.min(lines.length, sym.endLine)).join('\n');
      const xray = extractFunctionXRay(fullSymBody);

      slices.push({
        file: fileItem.file,
        symbolName: sym.name,
        signature: sym.signature,
        startLine: sym.startLine,
        endLine: sliceEndLine,
        linesCount: endIdx - startIdx,
        lang,
        code: codeStr,
        xray: xray.summary
      });
    }
  }

  if (slices.length === 0) {
    return { slices: [], formattedHint: '', savedBytes: 0 };
  }

  // Считаем размер исходных файлов
  let totalFullBytes = 0;
  for (const absF of touchedFiles) {
    try {
      totalFullBytes += fs.statSync(absF).size;
    } catch {}
  }
  const savedBytes = Math.max(0, totalFullBytes - snippetBytes);

  // Формируем formattedHint в соответствии со спецификацией
  const header = `🎯 [Zero-Turn Gold Context | PageRank] Pre-localized slices (avoid reading full files unless needed):`;
  let formattedHint = header;

  for (const slice of slices) {
    const block = `\n• \`${slice.file}\` [L${slice.startLine}-L${slice.endLine}] (\`${slice.symbolName}\`)${slice.xray ? ` — 🩻 ${slice.xray}` : ''}:\n\`\`\`${slice.lang}\n${slice.code}\n\`\`\``;
    if ((formattedHint + block).length > maxTotalChars) {
      break;
    }
    formattedHint += block;
  }

  // Защитная обрезка, если даже первый блок превышает лимит
  if (formattedHint === header && slices.length > 0) {
    const first = slices[0];
    const prefix = `\n• \`${first.file}\` [L${first.startLine}-L${first.endLine}] (\`${first.symbolName}\`)${first.xray ? ` — 🩻 ${first.xray}` : ''}:\n\`\`\`${first.lang}\n`;
    const suffix = `\n...\n\`\`\``;
    const available = maxTotalChars - (header.length + prefix.length + suffix.length);
    if (available > 40) {
      formattedHint = header + prefix + first.code.slice(0, available) + suffix;
    }
  }

  return {
    slices,
    formattedHint,
    savedBytes
  };
}

/**
 * Возвращает компактную карту репозитория с сортировкой файлов по графовой центральности PageRank,
 * усечённую до maxChars символов.
 * @param {string} rootDir Корневая директория репозитория
 * @param {number} [maxChars=4000] Максимальный размер карты в символах
 * @returns {{ markdown: string, fileCount: number, symbolCount: number, fullBytes: number, mapBytes: number, savedBytes: number, generatedAt: string, filesIndex: Array<object> }}
 */
export function getCompactRankedRepoMap(rootDir, maxChars = 4000) {
  const absRoot = path.resolve(rootDir);
  const cachedData = getCachedRepoMap(absRoot);
  const filesIndex = cachedData.filesIndex || [];

  if (filesIndex.length === 0) {
    return cachedData;
  }

  const { rankedFiles } = computePageRankForFilesIndex(filesIndex, absRoot, '');
  const rankMap = new Map();
  rankedFiles.forEach((rf, idx) => rankMap.set(rf.file, idx));

  const sortedFiles = [...filesIndex].sort((a, b) => {
    const rA = rankMap.has(a.file) ? rankMap.get(a.file) : 999999;
    const rB = rankMap.has(b.file) ? rankMap.get(b.file) : 999999;
    return rA - rB;
  });

  const footer = `\n\n*(RepoMap capped at ${maxChars} chars)*`;
  const footerLen = footer.length;

  let totalSymbols = 0;
  let includedCount = 0;
  const sections = [];
  const generatedAt = cachedData.generatedAt || new Date().toISOString();
  let currentLength = 140 + footerLen;

  // Two-Tier Hierarchical Skeleton: reserve up to 75% of maxChars for full symbol sections when sortedFiles.length > 6
  const maxFullChars = sortedFiles.length > 6 ? Math.floor(maxChars * 0.75) : maxChars;

  for (const fileObj of sortedFiles) {
    const lines = [`### \`${fileObj.file}\``];
    if (fileObj.imports && fileObj.imports.length > 0) {
      lines.push(`- **Imports**: ${fileObj.imports.map(i => `\`${i}\``).join(', ')}`);
    }
    if (fileObj.symbolsWithRanges && fileObj.symbolsWithRanges.length > 0) {
      for (const sym of fileObj.symbolsWithRanges) {
        lines.push(`- \`${sym.signature}\` [L${sym.startLine}-L${sym.endLine}]`);
      }
    } else if (fileObj.imports && fileObj.imports.length === 0) {
      lines.push(`- *(no symbols)*`);
    }

    const secText = lines.join('\n');
    const secLen = secText.length + 2;

    if (currentLength + secLen > maxFullChars && sections.length > 0) {
      break;
    }

    sections.push(secText);
    currentLength += secLen;
    includedCount++;
    totalSymbols += (fileObj.symbolsWithRanges ? fileObj.symbolsWithRanges.length : 0);
  }

  // Two-Tier Hierarchical Skeleton: append compact Overview of Other Project Files section for remaining files
  let overviewCount = 0;
  if (includedCount < sortedFiles.length) {
    const overviewLines = ['### Overview of Other Project Files'];
    const remainingFiles = sortedFiles.slice(includedCount);

    for (const fileObj of remainingFiles) {
      const linesPart = fileObj.linesCount ? ` (~${fileObj.linesCount}L)` : '';
      let desc = '';
      if (fileObj.docSummary) {
        desc = fileObj.docSummary;
      } else if (Array.isArray(fileObj.exportedSymbols) && fileObj.exportedSymbols.length > 0) {
        desc = fileObj.exportedSymbols.slice(0, 3).join(', ');
      } else {
        desc = 'no exported symbols';
      }

      const itemLine = `- \`${fileObj.file}\`${linesPart} — ${desc}`;
      const neededExtra = (overviewLines.length === 1 ? overviewLines[0].length + 2 : 0) + itemLine.length + 1;
      if (currentLength + neededExtra > maxChars) {
        break;
      }
      overviewLines.push(itemLine);
      currentLength += itemLine.length + 1;
      overviewCount++;
    }

    if (overviewLines.length > 1) {
      sections.push(overviewLines.join('\n'));
    }
  }

  const totalVisibleFiles = includedCount + overviewCount;
  const header = [
    `# Repo Map`,
    `Files: ${totalVisibleFiles} | Symbols: ${totalSymbols}`,
    ``
  ].join('\n');

  const needsFooter = totalVisibleFiles < filesIndex.length;
  const markdown = `${header}\n${sections.join('\n\n')}${needsFooter ? footer : ''}\n`;
  const mapBytes = Buffer.byteLength(markdown, 'utf8');
  const savedBytes = Math.max(0, cachedData.fullBytes - mapBytes);

  return {
    markdown,
    fileCount: totalVisibleFiles,
    symbolCount: totalSymbols,
    fullBytes: cachedData.fullBytes,
    mapBytes,
    savedBytes,
    generatedAt,
    filesIndex: cachedData.filesIndex
  };
}

/**
 * Builds a compact Zero-Turn Plan Dossier for Architect / L-XL planning tasks.
 * Lists top PageRank-matched target modules, their key exported signatures, and reverse dependents
 * so the planner can design exact contracts and safe parallel Teamwork waves without blind guessing.
 * @param {string} rootDir Workspace root
 * @param {string} [userPrompt=''] User request
 * @param {number} [maxFiles=4] Maximum candidate modules to summarize
 * @returns {string} Compact markdown dossier or empty string
 */
export function buildArchitectPlanDossier(rootDir, userPrompt = '', maxFiles = 4) {
  if (!rootDir || !userPrompt || userPrompt.trim().length < 10) return '';
  try {
    const absRoot = path.resolve(rootDir);
    const cachedData = getCachedRepoMap(absRoot);
    const filesIndex = cachedData.filesIndex || [];
    if (filesIndex.length === 0) return '';

    const ranked = rankRepoByPageRank(absRoot, userPrompt, { topK: maxFiles });
    const topRanked = (ranked?.rankedFiles || []).slice(0, maxFiles);
    if (topRanked.length === 0) return '';

    const fileMap = new Map(filesIndex.map((f) => [f.file, f]));
    const lines = ['📐 [Architect Plan Dossier — Contracts & Coupling]:'];

    for (const item of topRanked) {
      const fObj = fileMap.get(item.file);
      if (!fObj) continue;
      const syms = (fObj.symbolsWithRanges || [])
        .slice(0, 4)
        .map((s) => `${s.name}[L${s.startLine}-${s.endLine}]`)
        .join(', ') || 'no-exports';
      const rev = findReverseImporters(absRoot, path.join(absRoot, item.file));
      const depList = (rev?.dependents || []).map((d) => (typeof d === 'string' ? d : d.file)).filter(Boolean);
      const deps = depList.length
        ? `dependents(${depList.length}): ${depList.slice(0, 3).join(', ')}`
        : 'dependents: 0 (isolated)';
      lines.push(`  • \`${item.file}\` -> exports: ${syms} | ${deps}`);
    }
    return lines.join('\n');
  } catch {
    return '';
  }
}

/**
 * Verifies import contracts between an edited file and its reverse-importers.
 * Detects if any dependent file imports a symbol that is missing from the edited file exports.
 * @param {string} rootDir Repository root
 * @param {string} editedFilePath Path to the edited file (relative or absolute)
 * @returns {{ valid: boolean, brokenImports: Array<{ dependentFile: string, missingSymbols: string[] }>, formattedAlert: string }}
 */
export function verifyImportContracts(rootDir, editedFilePath, options = {}) {
  const absRoot = path.resolve(rootDir);
  const absEdited = path.isAbsolute(editedFilePath)
    ? path.resolve(editedFilePath)
    : path.resolve(absRoot, editedFilePath);

  const ext = path.extname(absEdited).toLowerCase();
  const supported = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx']);
  if (!supported.has(ext)) {
    return { valid: true, brokenImports: [], formattedAlert: '' };
  }

  const readText = (targetAbs) => {
    if (typeof options?.getFileText === 'function') {
      try {
        const memTxt = options.getFileText(targetAbs);
        if (typeof memTxt === 'string') return memTxt;
      } catch {}
    }
    try {
      if (fs.existsSync(targetAbs)) return fs.readFileSync(targetAbs, 'utf8');
    } catch {}
    return null;
  };

  const editedContent = readText(absEdited);
  if (editedContent === null) {
    return { valid: true, brokenImports: [], formattedAlert: '' };
  }

  if (editedContent.includes('export *') || editedContent.includes('module.exports')) {
    return { valid: true, brokenImports: [], formattedAlert: '' };
  }

  const exportedNames = new Set();

  // a) extractFileSymbolsWithRanges
  try {
    const rangeSymbols = extractFileSymbolsWithRanges(ext, editedContent);
    for (const s of rangeSymbols) {
      if (s?.name) exportedNames.add(s.name);
    }
  } catch {}

  // b) export [async] (function|const|let|var|class|type|interface|enum) name
  const exportDeclRegex = /export\s+(?:async\s+)?(?:function|const|let|var|class|type|interface|enum)\s+([A-Za-z0-9_$]+)/g;
  let declMatch;
  while ((declMatch = exportDeclRegex.exec(editedContent)) !== null) {
    if (declMatch[1]) exportedNames.add(declMatch[1].trim());
  }

  // c) export { ... }
  const exportBraceRegex = /export\s*\{([^}]+)\}/g;
  let braceMatch;
  while ((braceMatch = exportBraceRegex.exec(editedContent)) !== null) {
    const inner = braceMatch[1];
    for (const item of inner.split(',')) {
      const trimmed = item.trim().replace(/^type\s+/, '').trim();
      if (!trimmed) continue;
      const parts = trimmed.split(/\s+as\s+/);
      const exportedName = (parts.length > 1 ? parts[1] : parts[0]).trim();
      if (exportedName) {
        exportedNames.add(exportedName);
      }
    }
  }

  const normEdited = absEdited.replace(/\\/g, '/');
  const targetBaseName = path.basename(absEdited, ext);
  const targetFileWithExt = path.basename(absEdited);

  const dependents = Array.isArray(options?.precomputedDependents)
    ? options.precomputedDependents
    : ((findReverseImporters(absRoot, absEdited, 50) || {}).dependents || []);
  const brokenImports = [];

  for (const dep of dependents) {
    const depRel = typeof dep === 'string' ? dep : dep.file;
    if (!depRel) continue;
    const depAbs = path.resolve(absRoot, depRel);
    const depContent = readText(depAbs);
    if (depContent === null) continue;

    const depDir = path.dirname(depAbs);
    const normCase = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
    const normEditedCmp = normCase(normEdited);
    const importRegex = /(?:import|export)\s+(?:type\s+)?(?:[A-Za-z0-9_$]+\s*,\s*)?\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g;
    let impMatch;
    const missingForDep = [];

    while ((impMatch = importRegex.exec(depContent)) !== null) {
      const importBody = impMatch[1];
      const specifier = impMatch[2].trim();
      const cleanSpec = specifier.replace(/\\/g, '/');

      let matchesTarget = false;
      if (cleanSpec.startsWith('.')) {
        const resolvedSpec = normCase(path.resolve(depDir, cleanSpec).replace(/\\/g, '/'));
        if (
          resolvedSpec === normEditedCmp ||
          resolvedSpec + ext === normEditedCmp ||
          resolvedSpec + '.js' === normEditedCmp ||
          resolvedSpec + '.mjs' === normEditedCmp ||
          resolvedSpec + '.ts' === normEditedCmp ||
          resolvedSpec + '.tsx' === normEditedCmp ||
          resolvedSpec + '/index.mjs' === normEditedCmp ||
          resolvedSpec + '/index.js' === normEditedCmp ||
          resolvedSpec + '/index.ts' === normEditedCmp ||
          resolvedSpec + '/index.tsx' === normEditedCmp
        ) {
          matchesTarget = true;
        }
      } else {
        const specBase = path.basename(cleanSpec, path.extname(cleanSpec));
        const specBaseWithExt = path.basename(cleanSpec);
        if (
          specBase === targetBaseName ||
          specBaseWithExt === targetFileWithExt ||
          cleanSpec.endsWith('/' + targetFileWithExt) ||
          cleanSpec.endsWith('/' + targetBaseName)
        ) {
          matchesTarget = true;
        }
      }

      if (!matchesTarget) continue;

      const items = importBody.split(',');
      for (const item of items) {
        const cleanItem = item.trim().replace(/^type\s+/, '').trim();
        if (!cleanItem) continue;
        const asParts = cleanItem.split(/\s+as\s+/);
        const importedName = asParts[0].trim();
        if (importedName && !exportedNames.has(importedName)) {
          missingForDep.push(importedName);
        }
      }
    }

    if (missingForDep.length > 0) {
      brokenImports.push({
        dependentFile: depRel.replace(/\\/g, '/'),
        missingSymbols: Array.from(new Set(missingForDep))
      });
    }
  }

  const formattedAlert = brokenImports.length > 0
    ? `🔗 [Broken Contract!] ${brokenImports.map(b => `${b.dependentFile} imports { ${b.missingSymbols.join(', ')} } missing in ${path.basename(absEdited)}`).join('; ')}`
    : '';

  return {
    valid: brokenImports.length === 0,
    brokenImports,
    formattedAlert
  };
}

/**
 * Scans project files up to 600 files, returning array of relative paths.
 * @param {string} currentDir
 * @param {string} rootDir
 * @returns {string[]}
 */
export function walkProjectFiles(currentDir, rootDir) {
  const fileList = [];
  scanDirectory(currentDir, rootDir, fileList, 600);
  return fileList;
}

/**
 * Finds symbol definition and usages across repository project files.
 * @param {string} rootDir
 * @param {string} symbolName
 * @param {number} [maxResults=25]
 * @returns {{ ok: boolean, symbol: string, definition: { file: string, line: number, snippet: string }|null, usages: Array<{ file: string, line: number, snippet: string }>, totalUsages: number, formatted: string }}
 */
export function findSymbolUsagesAcrossRepo(rootDir, symbolName, maxResults = 25) {
  if (!rootDir || typeof rootDir !== 'string' || !symbolName || typeof symbolName !== 'string' || !symbolName.trim()) {
    return { ok: false, symbol: '', definition: null, usages: [], totalUsages: 0, formatted: '' };
  }

  const cleanSymbol = symbolName.trim();
  const escaped = cleanSymbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const idRegex = new RegExp('(?<![A-Za-z0-9_$])' + escaped + '(?![A-Za-z0-9_$])');
  const defRegex = new RegExp(
    '(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:function\\*?|class)\\s+' + escaped + '\\b|' +
    '(?:export\\s+)?(?:const|let|var)\\s+' + escaped + '\\s*=|' +
    '(?:def|fn|func)\\s+' + escaped + '\\b'
  );

  const absRoot = path.resolve(rootDir);
  const relFiles = walkProjectFiles(absRoot, absRoot);

  let definition = null;
  const usages = [];

  for (const relPath of relFiles) {
    const fullPath = path.join(absRoot, relPath);
    try {
      const stat = fs.statSync(fullPath);
      if (stat.size > 300 * 1024) continue;
      const content = fs.readFileSync(fullPath, 'utf8');
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const rawLine = lines[i];
        const trimmed = rawLine.trim();
        if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) continue;
        if (!idRegex.test(rawLine)) continue;

        if (!definition && defRegex.test(trimmed)) {
          definition = { file: relPath, line: i + 1, snippet: trimmed };
        } else {
          usages.push({ file: relPath, line: i + 1, snippet: trimmed.slice(0, 120) });
        }
      }
    } catch {}
  }

  const defStr = definition ? `${definition.file}:L${definition.line}` : 'none';
  const previewUsages = usages.slice(0, 5).map(u => `  - ${u.file}:L${u.line} -> ${u.snippet}`).join('\n');
  const formatted = `🔎 [Cortex-AST Usages: ${cleanSymbol}] Def: ${defStr} | Usages (${usages.length}):${previewUsages ? '\n' + previewUsages : ' none'}`;

  return {
    ok: true,
    symbol: cleanSymbol,
    definition,
    usages: usages.slice(0, maxResults),
    totalUsages: usages.length,
    formatted
  };
}

/**
 * Tracks symbol and signature changes (Chronos drift) against baseline snapshot.
 * @param {string} rootDir
 * @param {{ resetBaseline?: boolean }} [options={}]
 * @returns {{ ok: boolean, addedSymbols: Array<object>, removedSymbols: Array<object>, modifiedSignatures: Array<object>, formatted: string }}
 */
export function diffRepoChronos(rootDir, { resetBaseline = false } = {}) {
  if (!rootDir || typeof rootDir !== 'string') {
    return {
      ok: false,
      addedSymbols: [],
      removedSymbols: [],
      modifiedSignatures: [],
      formatted: '⏱️ [Chronos] Invalid rootDir'
    };
  }

  const absRoot = path.resolve(rootDir);
  const cached = getCachedRepoMap(absRoot);
  const filesIndex = (cached && Array.isArray(cached.filesIndex)) ? cached.filesIndex : [];

  const currentSnapshot = {};
  for (const entry of filesIndex) {
    const relFile = entry.file;
    if (!relFile) continue;
    if (Array.isArray(entry.symbolsWithRanges) && entry.symbolsWithRanges.length > 0) {
      for (const sym of entry.symbolsWithRanges) {
        if (sym && sym.name) {
          const key = `${relFile}::${sym.name}`;
          currentSnapshot[key] = sym.signature || sym.name;
        }
      }
    } else if (Array.isArray(entry.symbols) && entry.symbols.length > 0) {
      for (const symStr of entry.symbols) {
        if (typeof symStr === 'string') {
          const key = `${relFile}::${symStr}`;
          currentSnapshot[key] = symStr;
        }
      }
    }
  }

  const currentFilePath = fileURLToPath(import.meta.url);
  const pluginRoot = path.resolve(path.dirname(currentFilePath), '..');
  const cacheDir = path.join(pluginRoot, '.cache');
  const baselineFile = path.join(cacheDir, 'chronos-baseline.json');
  const rootHash = crypto.createHash('sha256').update(absRoot).digest('hex').slice(0, 16);

  let baselineStore = {};
  try {
    if (fs.existsSync(baselineFile)) {
      baselineStore = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
    }
  } catch {}

  const baselineSnapshot = baselineStore[rootHash];

  if (!baselineSnapshot || resetBaseline === true) {
    baselineStore[rootHash] = currentSnapshot;
    try {
      atomicWriteJsonSync(baselineFile, baselineStore);
    } catch {}
    return {
      ok: true,
      addedSymbols: [],
      removedSymbols: [],
      modifiedSignatures: [],
      formatted: '⏱️ [Chronos] Baseline snapshot initialized.'
    };
  }

  const addedSymbols = [];
  const removedSymbols = [];
  const modifiedSignatures = [];

  for (const [key, signature] of Object.entries(currentSnapshot)) {
    if (!(key in baselineSnapshot)) {
      const [file, name] = key.split('::');
      addedSymbols.push({ key, file, symbol: name, signature });
    } else if (baselineSnapshot[key] !== signature) {
      const [file, name] = key.split('::');
      modifiedSignatures.push({
        key,
        file,
        symbol: name,
        oldSignature: baselineSnapshot[key],
        newSignature: signature
      });
    }
  }

  for (const [key, signature] of Object.entries(baselineSnapshot)) {
    if (!(key in currentSnapshot)) {
      const [file, name] = key.split('::');
      removedSymbols.push({ key, file, symbol: name, signature });
    }
  }

  const parts = [];
  if (addedSymbols.length > 0) parts.push(`+${addedSymbols.length} added`);
  if (removedSymbols.length > 0) parts.push(`-${removedSymbols.length} removed`);
  if (modifiedSignatures.length > 0) parts.push(`~${modifiedSignatures.length} modified`);

  const formatted = parts.length > 0
    ? `⏱️ [Chronos Drift] ${parts.join(', ')}`
    : '⏱️ [Chronos] No symbol drift detected.';

  return {
    ok: true,
    addedSymbols,
    removedSymbols,
    modifiedSignatures,
    formatted
  };
}

/**
 * Находит неиспользуемые экспорты символов по всему репозиторию (Dead Code Detection)
 * @param {string} rootDir Корневой каталог проекта
 * @returns {{ ok: boolean, deadExports: Array<{ file: string, symbol: string }>, totalExported: number, deadCount: number, formatted: string }}
 */
export function findDeadExports(rootDir) {
  if (!rootDir || typeof rootDir !== 'string') {
    return { ok: false, deadExports: [], totalExported: 0, deadCount: 0, formatted: '' };
  }

  const absRoot = path.resolve(rootDir);
  const map = getCachedRepoMap(absRoot);
  const relFiles = walkProjectFiles(absRoot, absRoot);

  const fileTokenSets = new Map();
  for (const relPath of relFiles) {
    const fullPath = path.join(absRoot, relPath);
    try {
      const content = fs.readFileSync(fullPath, 'utf8');
      const ids = new Set(content.match(/[A-Za-z0-9_$]+/g) || []);
      fileTokenSets.set(relPath.replace(/\\/g, '/'), ids);
    } catch {}
  }

  const SKIP_PATTERN = /(?:^|\/)(?:install\.js|server\.mjs|hook-runner\.mjs|router-cli\.mjs|.*test.*|.*audit.*|scripts\/.*)$/i;

  let totalExported = 0;
  const deadExports = [];

  for (const fEntry of map.filesIndex || []) {
    const normFile = (fEntry.file || '').replace(/\\/g, '/');
    if (SKIP_PATTERN.test(normFile)) continue;

    for (const sym of fEntry.exportedSymbols || []) {
      if (sym === 'default') continue;
      totalExported++;

      let referenced = false;
      for (const [otherPath, ids] of fileTokenSets.entries()) {
        if (otherPath === normFile) continue;
        if (ids.has(sym)) {
          referenced = true;
          break;
        }
      }

      if (!referenced) {
        deadExports.push({ file: fEntry.file, symbol: sym });
      }
    }
  }

  const formatted = deadExports.length > 0
    ? '🧹 [Dead Exports] ' + deadExports.map(d => `${d.file}::${d.symbol}`).join(', ')
    : '🧹 [Dead Exports] 0 unused exports found.';

  return {
    ok: true,
    deadExports,
    totalExported,
    deadCount: deadExports.length,
    formatted
  };
}

/**
 * Вспомогательный сплиттер строки по запятым верхнего уровня (учитывает скобки и кавычки)
 * @param {string} str
 * @returns {string[]}
 */
function splitTopLevelCommas(str) {
  const parts = [];
  let cur = '';
  let depth = 0;
  let inStr = false;
  let sChar = '';
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    const prev = str[i - 1];
    if (inStr) {
      if (ch === sChar && prev !== '\\') inStr = false;
      cur += ch;
    } else {
      if (ch === '"' || ch === "'" || ch === '`') {
        inStr = true;
        sChar = ch;
        cur += ch;
      } else if (ch === '{' || ch === '[' || ch === '(') {
        depth++;
        cur += ch;
      } else if (ch === '}' || ch === ']' || ch === ')') {
        depth--;
        cur += ch;
      } else if (ch === ',' && depth === 0) {
        parts.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

/**
 * Проверяет семантические межфайловые контракты (DOM ID Linker и Destructured Parameter Linker)
 * для отредактированного файла.
 * @param {string} rootDir Корневой каталог репозитория
 * @param {string} editedFilePath Путь к отредактированному файлу (относительный или абсолютный)
 * @returns {{ valid: boolean, issues: Array<{ type: string, file: string, detail: string }>, formattedAlert: string }}
 */
export function verifySemanticContracts(rootDir, editedFilePath, options = {}) {
  const absRoot = path.resolve(rootDir);
  const absEdited = path.isAbsolute(editedFilePath)
    ? path.resolve(editedFilePath)
    : path.resolve(absRoot, editedFilePath);

  const ext = path.extname(absEdited).toLowerCase();
  const supported = new Set(['.html', '.js', '.mjs', '.cjs', '.ts', '.tsx']);
  if (!supported.has(ext)) {
    return { valid: true, issues: [], formattedAlert: '' };
  }

  const readText = (targetAbs) => {
    if (typeof options?.getFileText === 'function') {
      try {
        const memTxt = options.getFileText(targetAbs);
        if (typeof memTxt === 'string') return memTxt;
      } catch {}
    }
    try {
      if (fs.existsSync(targetAbs)) return fs.readFileSync(targetAbs, 'utf8');
    } catch {}
    return null;
  };

  if (typeof options?.getFileText !== 'function' && !fs.existsSync(absEdited)) {
    return { valid: true, issues: [], formattedAlert: '' };
  }

  const issues = [];
  const editedDir = path.dirname(absEdited);

  // =========================================================================
  // CHECK (A): DOM ID Linker
  // =========================================================================
  let siblingNames = [];
  if (typeof options?.listSiblingFiles === 'function') {
    try {
      const listed = options.listSiblingFiles(editedDir);
      if (Array.isArray(listed)) siblingNames = listed;
    } catch {}
  }
  if (siblingNames.length === 0) {
    try {
      siblingNames = fs.readdirSync(editedDir, { withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => e.name);
    } catch {}
  }

  const htmlFiles = siblingNames.filter((n) => n.toLowerCase().endsWith('.html'));
  const jsFiles = siblingNames.filter((n) => /\.(m?js|cjs|tsx?)$/i.test(n));

  if (htmlFiles.length > 0 && jsFiles.length > 0) {
    const staticHtmlIds = new Set();
    for (const hf of htmlFiles) {
      const hContent = readText(path.join(editedDir, hf));
      if (typeof hContent !== 'string') continue;
      const idRegex = /\bid\s*=\s*["']([A-Za-z0-9_\-]+)["']/g;
      let m;
      while ((m = idRegex.exec(hContent)) !== null) {
        staticHtmlIds.add(m[1]);
      }
    }

    // Проверяем только если хотя бы один HTML-файл определяет статические id="..." (>= 2 IDs)
    if (staticHtmlIds.size >= 2) {
      const jsContentMap = new Map();
      for (const jf of jsFiles) {
        const txt = readText(path.join(editedDir, jf));
        if (typeof txt === 'string') jsContentMap.set(jf, txt);
      }

      for (const jf of jsFiles) {
        const jsContent = jsContentMap.get(jf);
        if (!jsContent) continue;
        const jsPath = path.join(editedDir, jf);

        const gebiRegex = /getElementById\s*\(\s*['"]([A-Za-z0-9_\-]+)['"]\s*\)/g;
        const qsRegex = /querySelector(?:All)?\s*\(\s*['"]#([A-Za-z0-9_\-]+)['"]\s*\)/g;

        const referencedIds = new Set();
        let m;
        while ((m = gebiRegex.exec(jsContent)) !== null) {
          referencedIds.add(m[1]);
        }
        while ((m = qsRegex.exec(jsContent)) !== null) {
          referencedIds.add(m[1]);
        }

        for (const refId of referencedIds) {
          if (!staticHtmlIds.has(refId)) {
            // Проверяем, не создается ли ID динамически в JS этого каталога
            let isDynamic = false;
            const dynPatterns = [
              new RegExp(`\\.id\\s*=\\s*['"\`]${refId}['"\`]`),
              new RegExp(`setAttribute\\s*\\(\\s*['"]id['"]\\s*,\\s*['"\`]${refId}['"\`]\\s*\\)`),
              new RegExp(`\\bid\\s*:\\s*['"\`]${refId}['"\`]`),
              new RegExp(`id=["'\`]${refId}["'\`]`)
            ];
            for (const otherContent of jsContentMap.values()) {
              if (!otherContent) continue;
              if (dynPatterns.some(p => p.test(otherContent))) {
                isDynamic = true;
                break;
              }
            }

            if (!isDynamic) {
              issues.push({
                type: 'dom_id_mismatch',
                file: path.relative(absRoot, jsPath).replace(/\\/g, '/'),
                detail: `Referenced DOM ID "${refId}" not found in sibling HTML template(s) in ${path.relative(absRoot, editedDir).replace(/\\/g, '/') || '.'}`
              });
            }
          }
        }
      }
    }
  }

  // =========================================================================
  // CHECK (B): Destructured Object Parameter Linker
  // =========================================================================
  const jsExts = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx']);
  if (jsExts.has(ext)) {
    const editedContent = readText(absEdited) || '';

    if (editedContent) {
      // Ищем export [async] function name({ k1, k2, ... } = {})
      const destructuredFunctions = new Map();
      const fnDeclRegex = /export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(\s*\{([^}]+)\}/g;
      let fnMatch;
      while ((fnMatch = fnDeclRegex.exec(editedContent)) !== null) {
        const fnName = fnMatch[1];
        const innerParams = fnMatch[2];

        // Игнорируем функции с rest параметрами (...)
        if (innerParams.includes('...')) {
          continue;
        }

        const pieces = splitTopLevelCommas(innerParams);
        const paramKeys = new Set();
        let hasRest = false;

        for (const piece of pieces) {
          const p = piece.trim();
          if (!p) continue;
          if (p.includes('...')) {
            hasRest = true;
            break;
          }
          let key = p;
          if (key.includes('=')) {
            key = key.split('=')[0].trim();
          }
          if (key.includes(':')) {
            key = key.split(':')[0].trim();
          }
          const cleanKey = key.replace(/[^A-Za-z0-9_$]/g, '');
          if (cleanKey) {
            paramKeys.add(cleanKey);
          }
        }

        if (!hasRest && paramKeys.size > 0) {
          destructuredFunctions.set(fnName, paramKeys);
        }
      }

      if (destructuredFunctions.size > 0) {
        const dependents = Array.isArray(options?.precomputedDependents)
          ? options.precomputedDependents
          : ((findReverseImporters(absRoot, absEdited, 50) || {}).dependents || []);

        for (const dep of dependents) {
          const depRel = typeof dep === 'string' ? dep : dep.file;
          if (!depRel) continue;
          const depAbs = path.resolve(absRoot, depRel);
          const depContent = readText(depAbs);
          if (depContent === null) continue;

          for (const [funcName, allowedKeys] of destructuredFunctions.entries()) {
            if (!depContent.includes(funcName)) continue;

            const escapedFn = funcName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const callRegex = new RegExp(`(?<![A-Za-z0-9_$])${escapedFn}\\s*\\(\\s*\\{`, 'g');
            let callMatch;
            while ((callMatch = callRegex.exec(depContent)) !== null) {
              const startIndex = callRegex.lastIndex;
              let depth = 1;
              let inString = false;
              let stringChar = '';
              let inComment = false;
              let endIndex = -1;

              for (let idx = startIndex; idx < depContent.length; idx++) {
                const ch = depContent[idx];
                const prev = depContent[idx - 1];
                if (inString) {
                  if (ch === stringChar && prev !== '\\') inString = false;
                } else if (inComment) {
                  if (inComment === 'line' && ch === '\n') inComment = false;
                  else if (inComment === 'block' && ch === '/' && prev === '*') inComment = false;
                } else {
                  if (ch === '"' || ch === "'" || ch === '`') {
                    inString = true;
                    stringChar = ch;
                  } else if (ch === '/' && depContent[idx + 1] === '/') {
                    inComment = 'line';
                  } else if (ch === '/' && depContent[idx + 1] === '*') {
                    inComment = 'block';
                  } else if (ch === '{') {
                    depth++;
                  } else if (ch === '}') {
                    depth--;
                    if (depth === 0) {
                      endIndex = idx;
                      break;
                    }
                  }
                }
              }

              if (endIndex === -1) continue;
              const objBody = depContent.slice(startIndex, endIndex);

              const props = splitTopLevelCommas(objBody);
              for (const prop of props) {
                const trimmed = prop.trim();
                if (!trimmed || trimmed.startsWith('...')) continue;

                // Извлекаем ключ свойства: key: ... или "key": ... или 'key': ...
                const keyMatch = trimmed.match(/^(?:([A-Za-z0-9_$]+)|['"]([A-Za-z0-9_$]+)['"])\s*:/);
                if (keyMatch) {
                  const passedKey = keyMatch[1] || keyMatch[2];
                  if (passedKey && !allowedKeys.has(passedKey)) {
                    issues.push({
                      type: 'param_key_mismatch',
                      file: depRel.replace(/\\/g, '/'),
                      detail: `Call to ${funcName}({ ${passedKey}: ... }) in ${path.basename(depRel)} passes unknown parameter key "${passedKey}" (expected: ${Array.from(allowedKeys).join(', ')})`
                    });
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  const formattedAlert = issues.length > 0
    ? `⚠️ [Semantic Contract Violation!] ${issues.map(i => `${i.file}: ${i.detail}`).join('; ')}`
    : '';

  return {
    valid: issues.length === 0,
    issues,
    formattedAlert
  };
}

// Запуск напрямую из командной строки
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = process.argv[2] || process.cwd();
  const result = getCachedRepoMap(target);
  console.log(result.markdown);
  console.log(`\n--- Repo Map Summary ---`);
  console.log(`Files: ${result.fileCount} | Symbols: ${result.symbolCount} | Saved: ${result.savedBytes}B`);
}

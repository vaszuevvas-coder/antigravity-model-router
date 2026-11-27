#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isCommentOnlyLine(trimmed) {
  return trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.startsWith('*/');
}

function findEnclosingScopeLine(lines, matchIdx) {
  const scopePattern = /^\s*(?:(?:export\s+)?(?:default\s+)?(?:async\s+)?function\b|(?:export\s+)?class\b|(?:const|let|var)\s+[A-Za-z0-9_$]+\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z0-9_$]+)\s*=>|(?!(?:if|for|while|switch|catch|else)\b)(?:async\s+)?[A-Za-z0-9_$]+\s*\([^)]*\)\s*\{)/;
  let depth = 0;
  let inBlockComment = false;
  let pendingScope = null;
  const scopeStack = [];

  for (let i = 0; i <= matchIdx && i < lines.length; i++) {
    const rawLine = lines[i];
    if (scopePattern.test(rawLine)) {
      pendingScope = { lineNum: i + 1, code: rawLine.trim() };
    }
    let scopeAtMatch = scopeStack.length > 0 ? scopeStack[scopeStack.length - 1] : null;
    let inQuote = null;
    let escaped = false;

    for (let j = 0; j < rawLine.length; j++) {
      const ch = rawLine[j];
      const next = rawLine[j + 1];
      if (inBlockComment) {
        if (ch === '*' && next === '/') {
          inBlockComment = false;
          j++;
        }
        continue;
      }
      if (inQuote) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === inQuote) {
          inQuote = null;
        }
        continue;
      }
      if (ch === '/' && next === '*') {
        inBlockComment = true;
        j++;
        continue;
      }
      if (ch === '/' && next === '/') {
        break;
      }
      if (ch === '/') {
        const before = rawLine.slice(0, j).replace(/[ \t]+$/, '');
        const prevCh = before.slice(-1);
        if (!prevCh || '=(,:!&|?+~^;{}['.includes(prevCh) || /\b(?:return|throw|case|in|of|typeof|delete|void|await|yield|else)\s*$/.test(before)) {
          j++;
          let inClass = false;
          while (j < rawLine.length) {
            const rc = rawLine[j];
            if (rc === '\\' && j + 1 < rawLine.length) {
              j += 2;
              continue;
            }
            if (rc === '[') inClass = true;
            else if (rc === ']') inClass = false;
            else if (rc === '/' && !inClass) break;
            j++;
          }
          continue;
        }
      }
      if (ch === '\'' || ch === '"' || ch === '`') {
        inQuote = ch;
        continue;
      }
      if (ch === '{') {
        depth++;
        if (pendingScope) {
          const entry = { openDepth: depth, lineNum: pendingScope.lineNum, code: pendingScope.code };
          scopeStack.push(entry);
          pendingScope = null;
          scopeAtMatch = entry;
        }
      } else if (ch === '}') {
        while (scopeStack.length > 0 && scopeStack[scopeStack.length - 1].openDepth >= depth) {
          scopeStack.pop();
        }
        depth = Math.max(0, depth - 1);
      }
    }

    if (i === matchIdx) {
      const top = scopeStack.length > 0 ? scopeStack[scopeStack.length - 1] : scopeAtMatch;
      return top ? { lineNum: top.lineNum, code: top.code } : null;
    }
    if (pendingScope && !/[,(\\]\s*$/.test(rawLine.trim()) && i > pendingScope.lineNum - 1) {
      pendingScope = null;
    }
  }
  return null;
}

function makeIdentRegex(escapedSym, flags = '') {
  return new RegExp(`(?<![A-Za-z0-9_$])${escapedSym}(?![A-Za-z0-9_$])`, flags);
}

function detectRole(line, symbolName) {
  const sym = escapeRegex(symbolName);
  const idPat = `(?<![A-Za-z0-9_$])${sym}(?![A-Za-z0-9_$])`;
  const declPattern = new RegExp(`(?:\\b(?:const|let|var)\\b[\\s\\S]*?${idPat}|\\bfunction\\s*\\w*\\s*\\([^)]*?${idPat})`, 'i');
  const returnPattern = new RegExp(`\\breturn\\b[\\s\\S]*?${idPat}`);
  const branchPattern = new RegExp(`\\b(?:if|else\\s+if|switch|while)\\s*\\([\\s\\S]*?${idPat}`);
  const mutatePattern = new RegExp(`${idPat}(?:\\.[A-Za-z0-9_$]+)?\\s*(?:(?<![!<>=])=(?![=>])|\\+=|-=|\\*=|\\/=|%=|\\+\\+|--|\\.(?:push|set|delete|splice|shift|unshift|add|clear)\\()`);

  if (declPattern.test(line)) return 'decl';
  if (mutatePattern.test(line)) return 'mutate';
  if (returnPattern.test(line)) return 'return';
  if (branchPattern.test(line)) return 'branch';
  return 'use';
}

const JS_RESERVED = new Set(['const', 'let', 'var', 'return', 'if', 'else', 'for', 'while', 'switch', 'case', 'break', 'continue', 'function', 'class', 'default', 'export', 'import', 'true', 'false', 'null', 'undefined']);

function findSimpleAlias(line, symbolName) {
  const sym = escapeRegex(symbolName);
  const idPat = `(?<![A-Za-z0-9_$.])${sym}(?![A-Za-z0-9_$.])`;
  const aliasPattern1 = new RegExp(`\\b(?:const|let|var)\\s+([A-Za-z_$][A-Za-z0-9_$]*)\\s*=(?!=)\\s*${idPat}(?!\\s*=>)`);
  const aliasPattern2 = new RegExp(`(?:^|;\\s*)([A-Za-z_$][A-Za-z0-9_$]*)\\s*=(?!=)\\s*${idPat}(?!\\s*=>)`);
  const m1 = line.match(aliasPattern1);
  if (m1 && m1[1] && m1[1] !== symbolName && !JS_RESERVED.has(m1[1])) return m1[1];
  const m2 = line.trim().match(aliasPattern2);
  if (m2 && m2[1] && m2[1] !== symbolName && !JS_RESERVED.has(m2[1])) return m2[1];
  return null;
}

export function sliceSourceCode(sourceText, symbolName, options = {}) {
  if (typeof sourceText !== 'string' || !symbolName || typeof symbolName !== 'string') {
    return {
      ok: false,
      symbol: typeof symbolName === 'string' ? symbolName : '',
      totalFileLines: 0,
      matchedCount: 0,
      sliceLines: [],
      formatted: '',
      summary: 'Invalid input parameters'
    };
  }

  const { focusLine = 0, maxLines = 60 } = options || {};
  const lines = sourceText.split(/\r?\n/);
  const totalFileLines = lines.length;

  const escapedSym = escapeRegex(symbolName);
  const baseRegex = makeIdentRegex(escapedSym);

  // Phase 1: Scan for symbol matches and discover aliases
  const matchedLineIndices = new Set();
  const aliases = new Set();

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();
    if (!trimmed || isCommentOnlyLine(trimmed)) continue;

    if (baseRegex.test(rawLine)) {
      matchedLineIndices.add(i);
      const alias = findSimpleAlias(rawLine, symbolName);
      if (alias) aliases.add(alias);
    }
  }

  // Phase 2: If aliases were found, match alias occurrences
  if (aliases.size > 0) {
    for (const alias of aliases) {
      const aliasRegex = makeIdentRegex(escapeRegex(alias));
      for (let i = 0; i < lines.length; i++) {
        const rawLine = lines[i];
        const trimmed = rawLine.trim();
        if (!trimmed || isCommentOnlyLine(trimmed)) continue;
        if (aliasRegex.test(rawLine)) {
          matchedLineIndices.add(i);
        }
      }
    }
  }

  const sortedMatches = Array.from(matchedLineIndices).sort((a, b) => a - b);
  const matchedCount = sortedMatches.length;

  // If focusLine is provided (> 0), rank by distance to focusLine
  let targetIndices = sortedMatches;
  if (focusLine > 0 && targetIndices.length > maxLines) {
    const focusIdx = focusLine - 1;
    targetIndices = [...targetIndices].sort((a, b) => Math.abs(a - focusIdx) - Math.abs(b - focusIdx)).slice(0, maxLines).sort((a, b) => a - b);
  }

  // Phase 3: Construct slice items with enclosing scope headers
  const sliceMap = new Map(); // lineNum -> { line, role, code }
  const includedScopes = new Set();

  for (const idx of targetIndices) {
    const scope = findEnclosingScopeLine(lines, idx);
    if (scope && !includedScopes.has(scope.lineNum) && scope.lineNum !== idx + 1) {
      includedScopes.add(scope.lineNum);
      if (!sliceMap.has(scope.lineNum)) {
        sliceMap.set(scope.lineNum, {
          line: scope.lineNum,
          role: 'scope',
          code: scope.code
        });
      }
    }

    const lineNum = idx + 1;
    let roleTarget = symbolName;
    if (!baseRegex.test(lines[idx])) {
      for (const a of aliases) {
        if (makeIdentRegex(escapeRegex(a)).test(lines[idx])) {
          roleTarget = a;
          break;
        }
      }
    }
    const role = detectRole(lines[idx], roleTarget);
    sliceMap.set(lineNum, {
      line: lineNum,
      role,
      code: lines[idx].trim()
    });
  }

  let sliceLines = Array.from(sliceMap.values()).sort((a, b) => a.line - b.line);
  if (sliceLines.length > maxLines) {
    if (focusLine > 0) {
      sliceLines = [...sliceLines]
        .sort((a, b) => Math.abs(a.line - focusLine) - Math.abs(b.line - focusLine))
        .slice(0, maxLines)
        .sort((a, b) => a.line - b.line);
    } else {
      sliceLines = sliceLines.slice(0, maxLines);
    }
  }

  // Phase 4: Format output
  const formattedRows = sliceLines.map((item) => {
    const lineStr = String(item.line).padStart(4, ' ');
    const roleStr = `[${item.role}]`.padEnd(9, ' ');
    return `L${lineStr} ${roleStr} ${item.code}`;
  });

  const header = `// Sliced data-flow for symbol '${symbolName}' (${sliceLines.length}/${totalFileLines} lines, ${matchedCount} hits, ${aliases.size} aliases)`;
  const formatted = [header, ...formattedRows].join('\n');

  return {
    ok: true,
    symbol: symbolName,
    totalFileLines,
    matchedCount,
    aliases: Array.from(aliases),
    sliceLines,
    formatted,
    summary: `Distilled ${sliceLines.length} lines from ${totalFileLines} total lines (${Math.round((1 - sliceLines.length / (totalFileLines || 1)) * 100)}% compression)`
  };
}

export function extractVariableSlice(filePath, symbolName, options = {}) {
  try {
    if (!filePath || typeof filePath !== 'string') {
      return { ok: false, error: 'File path required', sliceLines: [], formatted: '', summary: 'Missing file path' };
    }
    const fullPath = path.resolve(filePath);
    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
      return { ok: false, error: `File not found: ${fullPath}`, sliceLines: [], formatted: '', summary: 'File not found' };
    }
    const sourceText = fs.readFileSync(fullPath, 'utf8');
    return extractVariableSliceFromText(sourceText, symbolName, options);
  } catch (err) {
    return { ok: false, error: err.message, sliceLines: [], formatted: '', summary: err.message };
  }
}

export function extractVariableSliceFromText(sourceText, symbolName, options = {}) {
  return sliceSourceCode(sourceText, symbolName, options);
}

// CLI runner
const isMain = (() => {
  if (!process.argv[1]) return false;
  const self = path.resolve(fileURLToPath(import.meta.url));
  const arg = path.resolve(process.argv[1]);
  return process.platform === 'win32' ? self.toLowerCase() === arg.toLowerCase() : self === arg;
})();
if (isMain) {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.includes('--help') || rawArgs.includes('-h')) {
    console.log('Usage: node slice-variable.mjs <filePath> <symbolName> [focusLine] [--output <path>]');
    process.exit(0);
  }
  let outFile = '';
  const posArgs = [];
  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i];
    if (a.startsWith('--output=')) outFile = path.resolve(a.slice('--output='.length));
    else if ((a === '--output' || a === '-o') && i + 1 < rawArgs.length) outFile = path.resolve(rawArgs[++i]);
    else posArgs.push(a);
  }
  const filePath = posArgs[0];
  const symbolName = posArgs[1];
  const focusLine = parseInt(posArgs[2], 10) || 0;

  if (!filePath || !symbolName) {
    console.error('Usage: node slice-variable.mjs <filePath> <symbolName> [focusLine] [--output <path>]');
    process.exit(1);
  }

  const res = extractVariableSlice(filePath, symbolName, { focusLine });
  if (!res.ok) {
    console.error(res.error || res.summary);
    process.exit(1);
  }
  const outText = `${res.formatted}\n\n// ${res.summary}`;
  if (outFile) {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, outText + '\n', 'utf8');
  } else {
    console.log(outText);
  }
}

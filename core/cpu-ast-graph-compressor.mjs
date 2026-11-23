/**
 * @file cpu-ast-graph-compressor.mjs
 * @description Zero-VRAM CPU code compression & structural graph primitives:
 *   1. LongCodeZip-style 2-stage AST Skeletonizer + 0/1 Knapsack (`foldCodeWithKnapsack`)
 *   2. RepoGraph 1-hop symbol call graph (`buildSymbolCallGraph`, `querySymbolEgoGraph`) & k-hop BFS (`findShortestGraphPath`)
 *   3. Multimodal Doc/Config/Skill <-> Code reference graph (`buildDocConfigReferenceGraph`, `queryDocRefsForFile`)
 *   4. Weighted Label Propagation architecture clusters & God Nodes (`detectArchitectureClusters`)
 *   5. Submodular Maximal Marginal Relevance diversity filter (`selectDiverseSlicesMMR`)
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import { extractFileSymbolsWithRanges } from './repo-mapper.mjs';
import { expandQueryBilingualStems, splitIdentifierSubtokens } from './cpu-reranker.mjs';

const CODE_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.mts', '.cts', '.py', '.go', '.rs',
]);

const DOC_CONFIG_EXTENSIONS = new Set([
  '.md', '.mdx', '.json', '.jsonc', '.sql', '.graphql', '.proto',
  '.yaml', '.yml', '.toml', '.ini', '.html', '.htm', '.txt', '.ps1', '.sh',
]);

const DOC_IGNORED_BASENAMES = new Set([
  'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb',
  'cargo.lock', 'poetry.lock', 'composer.lock', 'tsconfig.tsbuildinfo',
]);

const GENERIC_CODE_BASENAMES = new Set([
  'index.js', 'index.mjs', 'index.cjs', 'index.ts', 'index.tsx', 'index.jsx',
  'main.js', 'main.mjs', 'main.ts', 'main.py', 'main.go', 'main.rs',
  'app.js', 'app.ts', 'app.tsx', 'utils.js', 'utils.ts', 'helpers.js', 'helpers.ts',
  'config.js', 'config.ts', 'types.ts', 'constants.js', 'constants.ts', 'mod.rs', 'lib.rs',
]);

const DOC_KIND_PRIORITY = { config: 0, schema: 1, skill: 2, doc: 3 };

const CONTROL_KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'catch', 'finally',
  'try', 'throw', 'return', 'new', 'typeof', 'instanceof', 'delete', 'void',
  'function', 'class', 'await', 'yield', 'import', 'export', 'from', 'as', 'async',
  'const', 'let', 'var', 'super', 'this', 'true', 'false', 'null', 'undefined',
  'def', 'elif', 'except', 'with', 'lambda', 'pass', 'raise', 'print',
  'len', 'range', 'str', 'int', 'float', 'bool', 'list', 'dict', 'set', 'tuple',
]);

const NOISE_BUILTIN_METHODS = new Set([
  'push', 'pop', 'shift', 'unshift', 'slice', 'splice', 'map', 'filter', 'reduce',
  'forEach', 'find', 'findIndex', 'some', 'every', 'includes', 'indexOf', 'lastIndexOf',
  'join', 'split', 'trim', 'trimStart', 'trimEnd', 'toLowerCase', 'toUpperCase',
  'startsWith', 'endsWith', 'replace', 'replaceAll', 'match', 'matchAll', 'search',
  'test', 'exec', 'toString', 'valueOf', 'hasOwnProperty', 'keys', 'values', 'entries',
  'assign', 'freeze', 'from', 'isArray', 'of', 'get', 'set', 'has', 'delete', 'add',
  'clear', 'size', 'concat', 'sort', 'reverse', 'flat', 'flatMap', 'fill',
  'stringify', 'parse', 'now', 'max', 'min', 'floor', 'ceil', 'round', 'abs', 'pow',
  'sqrt', 'log', 'warn', 'error', 'info', 'debug', 'resolve', 'dirname', 'basename',
  'extname', 'normalize', 'relative', 'isAbsolute', 'isFinite', 'isInteger', 'isNaN',
  'Number', 'String', 'Boolean', 'Object', 'Array', 'Map', 'Set', 'RegExp', 'Date',
  'Error', 'Promise', 'Buffer', 'Math', 'JSON', 'console', 'process', 'require',
  'toFixed', 'charAt', 'charCodeAt', 'codePointAt', 'subarray', 'alloc', 'fromCharCode',
  'append', 'extend', 'items', 'format', 'encode', 'decode',
]);

function escapeRegExp(str) {
  return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getCommentStyle(ext) {
  if (ext === '.py') {
    return { kind: 'py' };
  }
  return { kind: 'cstyle' };
}

/**
 * Resolves overlapping AST symbols into strictly non-overlapping blocks.
 * Container classes that wrap inner methods are unwrapped so each method
 * becomes an independent Knapsack item while preserving the `class ... {` line.
 * @param {Array<{ name: string, kind: string, signature: string, startLine: number, endLine: number }>} rawSymbols
 * @param {number} totalLines
 */
function buildNonOverlappingBlocks(rawSymbols, totalLines) {
  if (!Array.isArray(rawSymbols) || rawSymbols.length === 0) return [];

  const normalized = rawSymbols
    .map((s) => ({
      name: String(s.name || 'anonymous'),
      kind: String(s.kind || 'function'),
      signature: String(s.signature || s.name || ''),
      startLine: Math.max(1, Math.min(totalLines, Number(s.startLine) || 1)),
      endLine: Math.max(1, Math.min(totalLines, Number(s.endLine) || Number(s.startLine) || 1)),
      parentClass: '',
    }))
    .filter((s) => s.endLine >= s.startLine)
    .sort((a, b) => a.startLine - b.startLine || (a.endLine - a.startLine) - (b.endLine - b.startLine));

  // Detect class containers that wrap at least one inner method/function
  const dropIndices = new Set();
  for (let i = 0; i < normalized.length; i++) {
    const outer = normalized[i];
    if (outer.kind !== 'class') continue;
    let hasChild = false;
    for (let j = i + 1; j < normalized.length; j++) {
      const inner = normalized[j];
      if (inner.startLine > outer.endLine) break;
      if (inner.startLine > outer.startLine && inner.kind === 'method') {
        inner.parentClass = outer.name;
        hasChild = true;
      } else if (inner.startLine > outer.startLine && inner.endLine <= outer.endLine) {
        inner.parentClass = outer.name;
        hasChild = true;
      }
    }
    if (hasChild) {
      dropIndices.add(i);
    }
  }

  const filtered = normalized.filter((_, idx) => !dropIndices.has(idx));
  const nonOverlapping = [];
  let lastEnd = 0;
  for (const sym of filtered) {
    if (sym.startLine <= lastEnd) continue;
    nonOverlapping.push(sym);
    lastEnd = sym.endLine;
  }
  return nonOverlapping;
}

/**
 * Formats a 1-line syntax-safe AST skeleton for a folded symbol block.
 */
function formatSymbolSkeletonLine(block, lines, ext) {
  const start = block.startLine;
  const end = block.endLine;
  const span = end - start + 1;
  const rawFirst = lines[start - 1] || '';
  const indentMatch = rawFirst.match(/^(\s*)/);
  const indent = indentMatch ? indentMatch[1] : '';
  const commentStyle = getCommentStyle(ext);

  if (commentStyle.kind === 'py') {
    const sig = block.signature.trim();
    return `${indent}${sig}: pass  # ... ${span}L folded [L${start}-L${end}] ...`;
  }

  let sig = block.signature.trim();
  const hasExport = /^\s*export\b/.test(rawFirst);
  const hasDefault = /^\s*export\s+default\b/.test(rawFirst);
  const hasAsync = /\basync\b/.test(rawFirst.split('(')[0] || '');
  const hasStatic = /^\s*static\b/.test(rawFirst);

  if (block.kind === 'method' && sig.startsWith('method ')) {
    sig = sig.slice(7);
  }
  if (block.kind === 'type') {
    const exportPrefix = hasExport ? 'export ' : '';
    return `${indent}${exportPrefix}${sig} = unknown; /* ... ${span}L folded [L${start}-L${end}] ... */`;
  }

  let prefix = '';
  if (hasExport && !sig.startsWith('export ')) {
    prefix += hasDefault ? 'export default ' : 'export ';
  }
  if (hasStatic && block.kind === 'method' && !sig.startsWith('static ')) {
    prefix += 'static ';
  }
  if (hasAsync && !sig.includes('async ') && !sig.startsWith('const ')) {
    prefix += 'async ';
  }

  return `${indent}${prefix}${sig} { /* ... ${span}L folded [L${start}-L${end}] ... */ }`;
}

/**
 * Formats a non-symbol gap (imports header or module-level constants/comments between symbols).
 */
function formatGapSegment(lines, startLine, endLine, { isTopHeader = false, ext = '.mjs', compactGaps = false } = {}) {
  if (endLine < startLine) return '';
  const slice = lines.slice(startLine - 1, endLine);
  const span = slice.length;

  if (isTopHeader) {
    if (!compactGaps || span <= 40) {
      return slice.join('\n');
    }
    const kept = [];
    let skipped = 0;
    for (let i = 0; i < slice.length; i++) {
      const t = slice[i].trim();
      if (i < 6 || /^(?:import\b|from\b|export\b|\/\/|#|'use strict'|"use strict"|const\s+\w+\s*=\s*require)/.test(t)) {
        kept.push(slice[i]);
      } else {
        skipped++;
      }
    }
    if (skipped > 0) {
      const cmt = ext === '.py'
        ? `# ... ${skipped}L header constants folded ...`
        : `/* ... ${skipped}L header constants folded ... */`;
      kept.push(cmt);
    }
    return kept.join('\n');
  }

  // Between-symbol structural glue: preserve class headers, closing braces, short comments
  if (!compactGaps || span <= 6) {
    // Collapse multiple blank lines to at most 1
    const out = [];
    let prevBlank = false;
    for (const ln of slice) {
      const blank = ln.trim() === '';
      if (blank && prevBlank) continue;
      out.push(ln);
      prevBlank = blank;
    }
    return out.join('\n');
  }

  const keptHead = [];
  const keptTail = [];
  for (let i = 0; i < Math.min(2, span); i++) {
    keptHead.push(slice[i]);
  }
  for (let i = Math.max(2, span - 2); i < span; i++) {
    keptTail.push(slice[i]);
  }
  const omitted = Math.max(0, span - keptHead.length - keptTail.length);
  if (omitted <= 2) {
    return slice.join('\n');
  }
  const foldNote = ext === '.py'
    ? `# ... ${omitted}L non-symbol lines folded [L${startLine + 2}-L${endLine - 2}] ...`
    : `/* ... ${omitted}L non-symbol lines folded [L${startLine + 2}-L${endLine - 2}] ... */`;
  return [...keptHead, foldNote, ...keptTail].join('\n');
}

/**
 * LongCodeZip-style 2-stage AST Skeletonizer + 0/1 Knapsack compressor.
 * Extracts non-overlapping symbol ranges, folds every symbol to a 1-line syntax-safe skeleton,
 * scores blocks via bilingual query stems + focus + call-edges + exports, and runs 0/1 Knapsack DP
 * (32-char buckets) over remaining budget to expand highest-value blocks verbatim.
 *
 * @param {string} sourceText
 * @param {{ query?: string, focusSymbol?: string, focusLines?: number[], maxBudgetChars?: number, ext?: string }} [options={}]
 */
export function foldCodeWithKnapsack(
  sourceText,
  { query = '', focusSymbol = '', focusLines = [], maxBudgetChars = 3200, ext = '.mjs' } = {}
) {
  const t0 = performance.now();
  if (!sourceText || typeof sourceText !== 'string') {
    return {
      ok: false,
      formatted: '',
      expandedSymbols: [],
      foldedSymbols: [],
      originalChars: 0,
      compressedChars: 0,
      savedChars: 0,
      compressionRatio: 1,
      savedTokensEstimate: 0,
      elapsedMs: 0,
    };
  }

  const originalChars = sourceText.length;
  const budget = Math.max(256, Number(maxBudgetChars) || 3200);
  const normExt = ext ? (ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`) : '.mjs';
  const lines = sourceText.split(/\r?\n/);
  const totalLines = lines.length;

  const rawSymbols = extractFileSymbolsWithRanges(normExt, sourceText);
  const blocks = buildNonOverlappingBlocks(rawSymbols, totalLines);

  if (blocks.length === 0) {
    let formatted = sourceText;
    if (originalChars > budget) {
      const headChars = Math.floor(budget * 0.65);
      const tailChars = Math.max(80, budget - headChars - 48);
      const omitted = Math.max(0, originalChars - headChars - tailChars);
      const note = normExt === '.py'
        ? `\n# ... ${omitted} chars folded ...\n`
        : `\n/* ... ${omitted} chars folded ... */\n`;
      formatted = `${sourceText.slice(0, headChars)}${note}${sourceText.slice(originalChars - tailChars)}`;
    }
    const compressedChars = formatted.length;
    const savedChars = Math.max(0, originalChars - compressedChars);
    return {
      ok: true,
      formatted,
      expandedSymbols: [],
      foldedSymbols: [],
      originalChars,
      compressedChars,
      savedChars,
      compressionRatio: compressedChars > 0 ? Number((originalChars / compressedChars).toFixed(2)) : 1,
      savedTokensEstimate: Math.max(0, Math.round(savedChars / 3.8)),
      elapsedMs: Number((performance.now() - t0).toFixed(2)),
    };
  }

  // Stage 1: Build verbatim & 1-line skeleton representation per block
  const qInfo = expandQueryBilingualStems(query || '');
  const focusName = String(focusSymbol || '').trim();
  const focusLower = focusName.toLowerCase();
  const focusLineNums = Array.isArray(focusLines)
    ? focusLines.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0)
    : [];

  // Identify call-edge targets (explicit focusSymbol, or symbols named in query)
  const blockNameSet = new Set(blocks.map((b) => b.name));
  const edgeTargets = new Set();
  if (focusName) edgeTargets.add(focusName);
  for (const id of qInfo.rawIdentifiers) {
    for (const bn of blockNameSet) {
      if (bn.toLowerCase() === id) edgeTargets.add(bn);
    }
  }

  // Pre-extract bodies and check focus target bodies for outgoing calls
  const focusBodyLowerList = [];
  for (const b of blocks) {
    b.verbatimText = lines.slice(b.startLine - 1, b.endLine).join('\n');
    b.skeletonLine = formatSymbolSkeletonLine(b, lines, normExt);
    b.bodyLower = b.verbatimText.toLowerCase();
    b.isExported = normExt === '.py'
      ? !b.name.startsWith('_')
      : /^\s*export\b/.test(lines[b.startLine - 1] || '');
    if (edgeTargets.has(b.name) || (focusLower && b.name.toLowerCase() === focusLower)) {
      focusBodyLowerList.push({ name: b.name, bodyLower: b.bodyLower });
    }
  }

  // Precompile call regexes for edgeTargets
  const edgeRegexes = Array.from(edgeTargets)
    .filter((t) => t.length >= 2)
    .map((t) => ({ name: t, re: new RegExp(`\\b${escapeRegExp(t)}\\s*\\(`, 'i') }));

  // Score each block
  for (const b of blocks) {
    let score = 1;
    const nameLower = b.name.toLowerCase();
    const sigLower = b.signature.toLowerCase();
    const sigSubTokens = new Set(splitIdentifierSubtokens(`${b.name} ${b.signature}`));

    // +1000 for focusSymbol / focusLines overlap
    const matchesFocusName = focusLower && (
      nameLower === focusLower ||
      (b.parentClass && b.parentClass.toLowerCase() === focusLower)
    );
    const matchesFocusLine = focusLineNums.some((ln) => ln >= b.startLine && ln <= b.endLine);
    if (matchesFocusName || matchesFocusLine) {
      score += 1000;
    }

    // x8 signature / identifier match
    let sigHits = 0;
    for (const rawId of qInfo.rawIdentifiers) {
      if (nameLower === rawId) sigHits += 2;
      else if (sigLower.includes(rawId)) sigHits += 1;
    }
    for (const concept of qInfo.allConcepts) {
      if (sigSubTokens.has(concept)) sigHits += 1;
    }
    score += sigHits * 8;

    // x3 body stem density
    let uniqueBodyHits = 0;
    let totalBodyHits = 0;
    const lineSpan = Math.max(1, b.endLine - b.startLine + 1);
    for (const concept of qInfo.allConcepts) {
      if (b.bodyLower.includes(concept)) {
        uniqueBodyHits += 1;
        // Count up to 5 occurrences quickly without regex overhead
        let idx = b.bodyLower.indexOf(concept);
        let c = 0;
        while (idx !== -1 && c < 5) {
          c++;
          idx = b.bodyLower.indexOf(concept, idx + concept.length);
        }
        totalBodyHits += c;
      }
    }
    if (uniqueBodyHits > 0) {
      const densityBonus = Math.min(4, (totalBodyHits * 10) / lineSpan);
      score += (uniqueBodyHits + densityBonus) * 3;
    }

    // x5 call-edge to focusSymbol (caller or callee of focus)
    let hasCallEdge = false;
    for (const er of edgeRegexes) {
      if (er.name !== b.name && er.re.test(b.verbatimText)) {
        hasCallEdge = true;
        break;
      }
    }
    if (!hasCallEdge && focusBodyLowerList.length > 0 && b.name.length >= 2) {
      const callSelfRe = new RegExp(`\\b${escapeRegExp(b.name)}\\s*\\(`);
      for (const fb of focusBodyLowerList) {
        if (fb.name !== b.name && callSelfRe.test(fb.bodyLower)) {
          hasCallEdge = true;
          break;
        }
      }
    }
    if (hasCallEdge) {
      score += 5;
    }

    // x1.5 exported
    if (b.isExported) {
      score *= 1.5;
    }

    b.score = score;
    b.knapsackValue = Math.max(1, Math.round(score * 10));
    b.deltaChars = Math.max(0, b.verbatimText.length - b.skeletonLine.length);
  }

  // Build segments (gaps + symbol blocks) and compute skeleton baseline size
  const compactGaps = totalLines > 80 || originalChars > budget * 1.5;
  const segments = [];
  let cursorLine = 1;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.startLine > cursorLine) {
      const gapText = formatGapSegment(lines, cursorLine, b.startLine - 1, {
        isTopHeader: i === 0,
        ext: normExt,
        compactGaps,
      });
      if (gapText) {
        const rawGap = lines.slice(cursorLine - 1, b.startLine - 1).join('\n');
        const hasClassDecl = /^\s*(?:export\s+(?:default\s+)?)?class\s+/m.test(rawGap);
        segments.push({ type: 'gap', text: gapText, isTopHeader: i === 0, hasClassDecl });
      }
    }
    segments.push({ type: 'block', blockIndex: i, block: b });
    cursorLine = b.endLine + 1;
  }
  if (cursorLine <= totalLines) {
    const tailGap = formatGapSegment(lines, cursorLine, totalLines, {
      isTopHeader: false,
      ext: normExt,
      compactGaps,
    });
    if (tailGap) segments.push({ type: 'gap', text: tailGap, isTopHeader: false, hasClassDecl: false });
  }

  const computeSkeletonChars = (collapsedSet) => {
    let total = 0;
    let inRun = false;
    let count = 0;
    for (let si = 0; si < segments.length; si++) {
      const seg = segments[si];
      if (seg.type === 'block' && collapsedSet.has(seg.blockIndex)) {
        if (!inRun) {
          inRun = true;
          total += 58;
          count++;
        }
      } else if (seg.type === 'gap' && inRun && !seg.isTopHeader && !seg.hasClassDecl) {
        // Check if next block is also collapsed; if so, swallow this intermediate gap into the run
        const nextSeg = segments[si + 1];
        if (nextSeg && nextSeg.type === 'block' && collapsedSet.has(nextSeg.blockIndex)) {
          continue;
        }
        inRun = false;
        total += seg.text.length;
        count++;
      } else {
        inRun = false;
        total += seg.type === 'gap' ? seg.text.length : seg.block.skeletonLine.length;
        count++;
      }
    }
    return total + Math.max(0, count - 1);
  };

  let skeletonChars = computeSkeletonChars(new Set());

  // If pure skeleton exceeds 70% of budget (e.g. huge 1800L file with many symbols/gaps),
  // collapse lowest-ranked distant skeletons + intermediate gaps so focus symbol fits within budget.
  const collapsedSkeletonIndices = new Set();
  if (skeletonChars > Math.floor(budget * 0.7) && blocks.length > 6) {
    // Cap top header to import lines if it alone consumes >25% of budget
    if (segments[0]?.type === 'gap' && segments[0].isTopHeader && segments[0].text.length > Math.floor(budget * 0.25)) {
      const importLines = segments[0].text.split('\n').filter((ln) =>
        /^\s*(?:import\b|from\b|export\b|const\s+\w+\s*=\s*require)/.test(ln)
      );
      if (importLines.length > 0) {
        segments[0].text = importLines.join('\n');
        skeletonChars = computeSkeletonChars(collapsedSkeletonIndices);
      }
    }

    const focusBlock = blocks.reduce((best, b) => (!best || b.score > best.score ? b : best), null);
    const focusReserve = focusBlock && focusBlock.score >= 500
      ? Math.min(Math.floor(budget * 0.65), focusBlock.deltaChars)
      : 0;
    const targetSkeletonBudget = Math.max(350, Math.floor((budget - focusReserve) * 0.85));

    const orderLowToHigh = blocks
      .map((b, idx) => ({ idx, score: b.score, len: b.skeletonLine.length }))
      .sort((a, b) => a.score - b.score || b.len - a.len);

    for (const item of orderLowToHigh) {
      if (skeletonChars <= targetSkeletonBudget) break;
      if (item.score >= 500) break; // Never collapse focus blocks
      collapsedSkeletonIndices.add(item.idx);
      skeletonChars = computeSkeletonChars(collapsedSkeletonIndices);
    }
  }

  // Stage 2: 0/1 Knapsack DP (32-char buckets) over remaining budget
  const remainingBudget = Math.max(0, budget - skeletonChars);
  const expandedSet = new Set();

  // Free expansions (deltaChars === 0)
  const dpCandidates = [];
  for (let i = 0; i < blocks.length; i++) {
    if (collapsedSkeletonIndices.has(i)) continue;
    const b = blocks[i];
    if (b.deltaChars === 0) {
      expandedSet.add(i);
    } else if (b.deltaChars <= remainingBudget) {
      dpCandidates.push({ idx: i, delta: b.deltaChars, val: b.knapsackValue });
    }
  }

  if (dpCandidates.length > 0 && remainingBudget >= 32) {
    const bucketSize = Math.max(32, Math.ceil(remainingBudget / 2048));
    const capacity = Math.floor(remainingBudget / bucketSize);
    if (capacity > 0) {
      const n = dpCandidates.length;
      const stride = capacity + 1;
      const dp = new Int32Array(stride);
      const keep = new Uint8Array(n * stride);

      for (let i = 0; i < n; i++) {
        const w = Math.max(1, Math.ceil(dpCandidates[i].delta / bucketSize));
        const v = dpCandidates[i].val;
        if (w > capacity) continue;
        const rowOffset = i * stride;
        for (let c = capacity; c >= w; c--) {
          const withItem = dp[c - w] + v;
          if (withItem > dp[c]) {
            dp[c] = withItem;
            keep[rowOffset + c] = 1;
          }
        }
      }

      let c = capacity;
      for (let i = n - 1; i >= 0; i--) {
        if (keep[i * stride + c] === 1) {
          expandedSet.add(dpCandidates[i].idx);
          const w = Math.max(1, Math.ceil(dpCandidates[i].delta / bucketSize));
          c -= w;
        }
      }
    }
  }

  // Reconstruct formatted code
  const outParts = [];
  const expandedSymbols = [];
  const foldedSymbols = [];
  let collapsedRunCount = 0;
  let collapsedRunStart = 0;
  let collapsedRunEnd = 0;

  const flushCollapsedRun = () => {
    if (collapsedRunCount <= 0) return;
    const note = normExt === '.py'
      ? `# ... +${collapsedRunCount} low-relevance symbols folded [L${collapsedRunStart}-L${collapsedRunEnd}] ...`
      : `/* ... +${collapsedRunCount} low-relevance symbols folded [L${collapsedRunStart}-L${collapsedRunEnd}] ... */`;
    outParts.push(note);
    collapsedRunCount = 0;
  };

  for (let si = 0; si < segments.length; si++) {
    const seg = segments[si];
    if (seg.type === 'gap') {
      const nextSeg = segments[si + 1];
      if (
        collapsedRunCount > 0 &&
        !seg.isTopHeader &&
        !seg.hasClassDecl &&
        nextSeg &&
        nextSeg.type === 'block' &&
        collapsedSkeletonIndices.has(nextSeg.blockIndex)
      ) {
        continue;
      }
      flushCollapsedRun();
      outParts.push(seg.text);
      continue;
    }
    const { blockIndex, block } = seg;
    if (expandedSet.has(blockIndex)) {
      flushCollapsedRun();
      outParts.push(block.verbatimText);
      expandedSymbols.push(block.name);
    } else if (collapsedSkeletonIndices.has(blockIndex)) {
      if (collapsedRunCount === 0) collapsedRunStart = block.startLine;
      collapsedRunEnd = block.endLine;
      collapsedRunCount++;
      foldedSymbols.push(block.name);
    } else {
      flushCollapsedRun();
      outParts.push(block.skeletonLine);
      foldedSymbols.push(block.name);
    }
  }
  flushCollapsedRun();

  const formatted = outParts.join('\n');
  const compressedChars = formatted.length;
  const savedChars = Math.max(0, originalChars - compressedChars);

  return {
    ok: true,
    formatted,
    expandedSymbols,
    foldedSymbols,
    originalChars,
    compressedChars,
    savedChars,
    compressionRatio: compressedChars > 0 ? Number((originalChars / compressedChars).toFixed(2)) : 1,
    savedTokensEstimate: Math.max(0, Math.round(savedChars / 3.8)),
    elapsedMs: Number((performance.now() - t0).toFixed(2)),
  };
}

/**
 * Strips single-line comments and string literals on a single line for fast call-site scanning.
 */
function stripLineNoise(line, ext) {
  if (!line) return '';
  let out = line.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, '""');
  if (ext === '.py') {
    const hashIdx = out.indexOf('#');
    if (hashIdx !== -1) out = out.slice(0, hashIdx);
  } else {
    const slIdx = out.indexOf('//');
    if (slIdx !== -1) out = out.slice(0, slIdx);
    out = out.replace(
      /(^|(?:return|throw|case)\b|=>|[=(,:!&|?+~^;{}\[\]])\s*\/(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\[\r\n])+\/[dgimsuvy]*/g,
      '$1""'
    );
  }
  return out;
}

/**
 * Builds a RepoGraph 1-hop symbol call graph (caller <-> callee) across workspace files.
 * Accepts Map<relPath, entry|string> or plain Object { [relPath]: entry|string }.
 *
 * @param {Map<string, any>|Record<string, any>} filesMap
 */
export function buildSymbolCallGraph(filesMap) {
  const t0 = performance.now();
  const entries = filesMap instanceof Map
    ? Array.from(filesMap.entries())
    : (filesMap && typeof filesMap === 'object' ? Object.entries(filesMap) : []);

  const definedSymbols = new Map(); // name -> Array<{ name, file, kind, signature, startLine, endLine }>
  const symbolNamesLower = new Map(); // lowerName -> Set<name>
  const parsedFiles = [];

  for (const [relPath, val] of entries) {
    if (!relPath || typeof relPath !== 'string') continue;
    const ext = (val && typeof val === 'object' && val.ext)
      ? String(val.ext).toLowerCase()
      : path.extname(relPath).toLowerCase();
    if (!CODE_EXTENSIONS.has(ext) && !(val && typeof val === 'object' && Array.isArray(val.symbols))) {
      continue;
    }

    const text = typeof val === 'string'
      ? val
      : (val?.text ?? val?.content ?? (val?.buf ? val.buf.toString('utf8') : ''));
    if (!text) continue;

    const rawSyms = (val && typeof val === 'object' && Array.isArray(val.symbols) && val.symbols.length > 0)
      ? val.symbols
      : extractFileSymbolsWithRanges(ext, text);

    const fileSyms = (rawSyms || [])
      .filter((s) => s && s.name && s.name !== 'anonymous' && !CONTROL_KEYWORDS.has(s.name))
      .map((s) => ({
        name: String(s.name),
        file: relPath,
        kind: String(s.kind || 'function'),
        signature: String(s.signature || s.name),
        startLine: Number(s.startLine) || 1,
        endLine: Number(s.endLine) || Number(s.startLine) || 1,
      }))
      .sort((a, b) => a.startLine - b.startLine || (a.endLine - a.startLine) - (b.endLine - b.startLine));

    for (const s of fileSyms) {
      let arr = definedSymbols.get(s.name);
      if (!arr) {
        arr = [];
        definedSymbols.set(s.name, arr);
      }
      arr.push(s);

      const low = s.name.toLowerCase();
      let set = symbolNamesLower.get(low);
      if (!set) {
        set = new Set();
        symbolNamesLower.set(low, set);
      }
      set.add(s.name);
    }

    parsedFiles.push({ relPath, ext, text, fileSyms });
  }

  const callersOf = new Map(); // callee -> Map<edgeKey, edgeObj>
  const calleesOf = new Map(); // caller -> Map<edgeKey, edgeObj>
  const callRe = /(?:\.|^|[^A-Za-z0-9_$])([A-Za-z_$][A-Za-z0-9_$]{1,63})\s*\(/g;
  const declLineRe = /^(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:function|def|fn|func|class|interface)\b/;

  const addEdge = (map, key, edgeKey, edgeObj) => {
    let bucket = map.get(key);
    if (!bucket) {
      bucket = new Map();
      map.set(key, bucket);
    }
    if (!bucket.has(edgeKey)) {
      bucket.set(edgeKey, edgeObj);
    }
  };

  let edgeCount = 0;

  for (const pf of parsedFiles) {
    const lines = pf.text.split(/\r?\n/);
    const syms = pf.fileSyms;
    const importedIdents = new Set();
    for (const im of pf.text.matchAll(/(?:import\s+([\s\S]{1,220}?)\s+from\s+['"]|(?:const|let|var)\s+\{([^}]{1,200})\}\s*=\s*require\()/g)) {
      const clause = im[1] || im[2] || '';
      for (const idm of clause.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*)\b/g)) {
        if (idm[1] !== 'as' && idm[1] !== 'type') importedIdents.add(idm[1]);
      }
    }
    let inBlockComment = false;

    for (let i = 0; i < lines.length; i++) {
      const lineNo = i + 1;
      let raw = lines[i];

      if (pf.ext !== '.py') {
        if (inBlockComment) {
          const endIdx = raw.indexOf('*/');
          if (endIdx === -1) continue;
          raw = raw.slice(endIdx + 2);
          inBlockComment = false;
        }
        // Strip inline /* ... */ and detect opening /*
        raw = raw.replace(/\/\*[\s\S]*?\*\//g, ' ');
        const openIdx = raw.indexOf('/*');
        if (openIdx !== -1) {
          raw = raw.slice(0, openIdx);
          inBlockComment = true;
        }
      }

      const clean = stripLineNoise(raw, pf.ext);
      if (!clean || clean.trim().length < 3) continue;

      // Determine innermost enclosing symbol for lineNo (fallback: most recent non-class symbol before next symbol)
      let enclosing = null;
      for (const s of syms) {
        if (s.startLine > lineNo) break;
        if (lineNo >= s.startLine && lineNo <= s.endLine) {
          if (!enclosing || (s.endLine - s.startLine) <= (enclosing.endLine - enclosing.startLine)) {
            enclosing = s;
          }
        }
      }
      if (!enclosing && syms.length > 0) {
        // Handle functions >120L whose endLine was capped by brace scanner
        for (let k = syms.length - 1; k >= 0; k--) {
          if (syms[k].startLine <= lineNo && syms[k].kind !== 'class') {
            if (/^\s+/.test(lines[i])) {
              enclosing = syms[k];
            }
            break;
          }
        }
      }

      const callerName = enclosing ? enclosing.name : `module:${path.basename(pf.relPath)}`;
      const isDeclLine = enclosing && lineNo === enclosing.startLine && declLineRe.test(clean.trim());

      callRe.lastIndex = 0;
      let m;
      while ((m = callRe.exec(clean)) !== null) {
        const calleeName = m[1];
        if (!calleeName || CONTROL_KEYWORDS.has(calleeName)) continue;
        if (isDeclLine && calleeName === callerName) continue;
        if (calleeName === callerName) continue; // skip self-recursion noise

        const isRepoSymbol = definedSymbols.has(calleeName);
        if (NOISE_BUILTIN_METHODS.has(calleeName)) {
          if (!isRepoSymbol) continue;
          // If it's a dotted call like arr.slice(...) (not this.slice/self.slice), skip builtin noise
          const matchPrefix = m[0];
          if (matchPrefix.startsWith('.')) {
            const beforeDot = clean.slice(0, m.index).trimEnd();
            if (!/(?:this|self|engine|ram)$/i.test(beforeDot)) continue;
          }
        }

        const targetDefs = isRepoSymbol ? definedSymbols.get(calleeName) : null;
        const sameFileDef = targetDefs?.find((d) => d.file === pf.relPath) || null;
        const chosenDef = sameFileDef || targetDefs?.[0] || null;
        const calleeFile = chosenDef?.file || '';
        const calleeLine = chosenDef?.startLine || 0;
        const isDotted = m[0].startsWith('.');
        let confidence = 'AMBIGUOUS';
        if (isRepoSymbol && !isDotted) {
          if (sameFileDef || (targetDefs.length === 1 && importedIdents.has(calleeName))) {
            confidence = 'EXTRACTED';
          } else if (targetDefs.length === 1) {
            confidence = 'INFERRED';
          }
        }

        const callerKey = `${pf.relPath}#${callerName}`;
        const calleeKey = `${calleeFile}#${calleeName}`;

        const prevSize = calleesOf.get(callerName)?.size || 0;
        addEdge(calleesOf, callerName, calleeKey, {
          name: calleeName,
          file: calleeFile,
          line: calleeLine,
          callSiteLine: lineNo,
          isRepoSymbol,
          confidence,
        });
        addEdge(callersOf, calleeName, callerKey, {
          name: callerName,
          file: pf.relPath,
          line: lineNo,
          callSiteLine: lineNo,
          isRepoSymbol: Boolean(enclosing),
          confidence,
        });
        if ((calleesOf.get(callerName)?.size || 0) > prevSize) {
          edgeCount++;
        }
      }
    }
  }

  return {
    builtAt: Date.now(),
    elapsedMs: Number((performance.now() - t0).toFixed(2)),
    fileCount: parsedFiles.length,
    symbolCount: definedSymbols.size,
    edgeCount,
    definedSymbols,
    callersOf,
    calleesOf,
    symbolNamesLower,
  };
}

/**
 * Queries a built RepoGraph 1-hop symbol call graph for callers & callees of target symbols or a query.
 *
 * @param {object} graph
 * @param {string|string[]} targetSymbolsOrQuery
 * @param {{ maxCallers?: number, maxCallees?: number }} [options={}]
 */
export function querySymbolEgoGraph(
  graph,
  targetSymbolsOrQuery,
  { maxCallers = 5, maxCallees = 5 } = {}
) {
  if (!graph || (!graph.callersOf && !graph.calleesOf)) {
    return { edgesFound: 0, callers: [], callees: [], formattedHint: '' };
  }

  const targets = [];
  const seenTargets = new Set();
  const addTarget = (name) => {
    if (!name || seenTargets.has(name)) return;
    seenTargets.add(name);
    targets.push(name);
  };

  if (Array.isArray(targetSymbolsOrQuery)) {
    for (const raw of targetSymbolsOrQuery) {
      const s = String(raw || '').trim();
      if (!s) continue;
      if (graph.definedSymbols?.has(s) || graph.callersOf?.has(s) || graph.calleesOf?.has(s)) {
        addTarget(s);
      } else {
        const lowerMatches = graph.symbolNamesLower?.get(s.toLowerCase());
        if (lowerMatches) {
          for (const m of lowerMatches) addTarget(m);
        }
      }
    }
  } else if (typeof targetSymbolsOrQuery === 'string') {
    const raw = targetSymbolsOrQuery.trim();
    if (raw) {
      if (graph.definedSymbols?.has(raw) || graph.callersOf?.has(raw) || graph.calleesOf?.has(raw)) {
        addTarget(raw);
      }
      // Extract identifier tokens from query
      const idTokens = raw.match(/[A-Za-z_$][A-Za-z0-9_$]{1,63}/g) || [];
      for (const tok of idTokens) {
        if (CONTROL_KEYWORDS.has(tok.toLowerCase())) continue;
        if (graph.definedSymbols?.has(tok) || graph.callersOf?.has(tok) || graph.calleesOf?.has(tok)) {
          addTarget(tok);
        } else {
          const lowerMatches = graph.symbolNamesLower?.get(tok.toLowerCase());
          if (lowerMatches) {
            for (const m of lowerMatches) addTarget(m);
          }
        }
      }
      // Sub-token fallback if no direct symbol matched
      if (targets.length === 0 && graph.definedSymbols) {
        const qInfo = expandQueryBilingualStems(raw);
        const scoredSyms = [];
        for (const symName of graph.definedSymbols.keys()) {
          const hasEdges = (graph.callersOf?.get(symName)?.size || 0) + (graph.calleesOf?.get(symName)?.size || 0);
          if (hasEdges === 0) continue;
          const sub = new Set(splitIdentifierSubtokens(symName));
          let hits = 0;
          for (const c of qInfo.allConcepts) {
            if (sub.has(c)) hits++;
          }
          if (hits > 0) scoredSyms.push({ symName, hits, hasEdges });
        }
        scoredSyms.sort((a, b) => b.hits - a.hits || b.hasEdges - a.hasEdges);
        for (const s of scoredSyms.slice(0, 2)) {
          addTarget(s.symName);
        }
      }
    }
  }

  if (targets.length === 0) {
    return { edgesFound: 0, callers: [], callees: [], formattedHint: '' };
  }

  const activeTargets = targets.slice(0, 3);
  const callerMap = new Map();
  const calleeMap = new Map();

  for (const t of activeTargets) {
    const callers = graph.callersOf?.get(t);
    if (callers) {
      for (const [k, edge] of callers.entries()) {
        if (seenTargets.has(edge.name)) continue;
        if (!callerMap.has(k)) callerMap.set(k, edge);
      }
    }
    const callees = graph.calleesOf?.get(t);
    if (callees) {
      for (const [k, edge] of callees.entries()) {
        if (seenTargets.has(edge.name)) continue;
        if (!calleeMap.has(k)) calleeMap.set(k, edge);
      }
    }
  }

  const sortEdges = (arr) => arr.sort((a, b) =>
    (b.isRepoSymbol ? 1 : 0) - (a.isRepoSymbol ? 1 : 0)
    || a.name.localeCompare(b.name)
  );

  const callers = sortEdges(Array.from(callerMap.values())).slice(0, Math.max(0, maxCallers));
  const callees = sortEdges(Array.from(calleeMap.values())).slice(0, Math.max(0, maxCallees));
  const edgesFound = callers.length + callees.length;

  if (edgesFound === 0) {
    return { edgesFound: 0, callers: [], callees: [], formattedHint: '' };
  }

  const fmtEdge = (e) => e.file ? `${e.name} (${path.basename(e.file)}:${e.line || 1})` : e.name;
  const callerStr = callers.length > 0 ? callers.map(fmtEdge).join(', ') : 'none';
  const calleeStr = callees.length > 0 ? callees.map(fmtEdge).join(', ') : 'none';
  const targetLabel = activeTargets.join(', ');
  const formattedHint = `🕸️ [RepoGraph 1-Hop] ${targetLabel} <- called by: ${callerStr} | -> calls: ${calleeStr}`;

  return {
    edgesFound,
    callers,
    callees,
    formattedHint,
  };
}

function normalizePosixRel(p = '') {
  return String(p || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

function iterMapOrObjectEntries(src) {
  if (!src) return [];
  if (src instanceof Map) return Array.from(src.entries());
  if (typeof src === 'object') return Object.entries(src);
  return [];
}

function toArrayIter(val) {
  if (!val) return [];
  if (val instanceof Set || Array.isArray(val)) return Array.from(val);
  return [];
}

function looksLikeFileQuery(raw = '') {
  const s = normalizePosixRel(raw);
  if (!s) return false;
  if (s.includes('/')) return true;
  const ext = path.posix.extname(s).toLowerCase();
  return Boolean(ext && (CODE_EXTENSIONS.has(ext) || DOC_CONFIG_EXTENSIONS.has(ext)));
}

function resolveSymbolNamesInGraph(graph, rawQuery) {
  const q = String(rawQuery || '').trim();
  if (!q || !graph) return [];
  const out = [];
  const seen = new Set();
  const add = (name) => {
    if (!name || seen.has(name)) return;
    seen.add(name);
    out.push(name);
  };
  if (graph.definedSymbols?.has(q) || graph.callersOf?.has(q) || graph.calleesOf?.has(q)) {
    add(q);
  }
  const lower = graph.symbolNamesLower?.get(q.toLowerCase());
  if (lower) {
    for (const m of Array.from(lower).sort()) add(m);
  }
  return out;
}

function resolveFileMatches(allFiles, rawQuery) {
  const q = normalizePosixRel(rawQuery);
  if (!q || !allFiles || allFiles.size === 0) return [];
  const qLower = q.toLowerCase();
  const exact = [];
  const suffix = [];
  const base = [];
  for (const rel of Array.from(allFiles).sort()) {
    const rLower = rel.toLowerCase();
    if (rel === q || rLower === qLower) {
      exact.push(rel);
    } else if (rLower.endsWith(`/${qLower}`)) {
      suffix.push(rel);
    } else if (path.posix.basename(rLower) === qLower) {
      base.push(rel);
    }
  }
  if (exact.length > 0) return exact;
  if (suffix.length > 0) return suffix;
  return base;
}

function reconstructBfsPath(startId, targetId, parent, nodeMetaFn) {
  const nodeIds = [];
  const edges = [];
  let cur = targetId;
  while (cur !== undefined && cur !== null) {
    nodeIds.push(cur);
    if (cur === startId) break;
    const step = parent.get(cur);
    if (!step) break;
    edges.push({
      from: step.prevId,
      to: cur,
      relation: step.relation,
      provenance: step.provenance,
    });
    cur = step.prevId;
  }
  nodeIds.reverse();
  edges.reverse();
  const pathNodes = nodeIds.map((id) => nodeMetaFn(id));
  return { pathNodes, edges };
}

function formatGraphPathChain(pathNodes, edges) {
  if (pathNodes.length === 0) return '';
  const fmtNode = (n) => {
    if (n.kind === 'symbol') {
      return n.file ? `${n.label} (${path.posix.basename(n.file)}:${n.line || 1})` : n.label;
    }
    return n.file || n.label;
  };
  let chain = fmtNode(pathNodes[0]);
  for (let i = 0; i < edges.length && i + 1 < pathNodes.length; i++) {
    chain += ` -[${edges[i].relation}]-> ${fmtNode(pathNodes[i + 1])}`;
  }
  const provSet = [];
  for (const e of edges) {
    if (e.provenance && !provSet.includes(e.provenance)) provSet.push(e.provenance);
  }
  const provTag = provSet.length > 0 ? provSet.join('+') : 'EXTRACTED';
  return `🧭 [GraphPath ${edges.length}-hop | ${provTag}] ${chain}`;
}

/**
 * Finds the shortest deterministic path (k-hop BFS) between two symbols or files across
 * symbol call edges (`AST_CALL`), module imports (`IMPORT`), and doc/config links (`DOC_REF`).
 *
 * @param {object|null} graph Built symbol call graph from `buildSymbolCallGraph`
 * @param {string} sourceQuery Starting symbol name or file path
 * @param {string} targetQuery Destination symbol name or file path
 * @param {{ maxDepth?: number, direction?: 'both'|'directed', forwardDeps?: Map|object, reverseDeps?: Map|object, docRefGraph?: object }} [options={}]
 */
export function findShortestGraphPath(
  graph,
  sourceQuery,
  targetQuery,
  {
    maxDepth = 5,
    direction = 'both',
    forwardDeps = null,
    reverseDeps = null,
    docRefGraph = null,
  } = {}
) {
  const t0 = performance.now();
  const fromStr = String(sourceQuery || '').trim();
  const toStr = String(targetQuery || '').trim();
  const depthCap = Math.max(1, Math.min(8, Number(maxDepth) || 5));
  const dirMode = direction === 'directed' ? 'directed' : 'both';
  const maxVisited = 2500;

  const emptyResult = () => ({
    ok: true,
    found: false,
    from: fromStr,
    to: toStr,
    hops: 0,
    mode: 'none',
    path: [],
    edges: [],
    elapsedMs: Number((performance.now() - t0).toFixed(2)),
    formattedHint: `🧭 [GraphPath] No path found between "${fromStr}" and "${toStr}" within ${depthCap} hops.`,
  });

  if (!fromStr || !toStr) return emptyResult();

  const symNodeMeta = (symName) => {
    const def = graph?.definedSymbols?.get(symName)?.[0];
    return {
      id: `sym:${symName}`,
      kind: 'symbol',
      label: symName,
      file: def?.file || '',
      line: def?.startLine || 1,
    };
  };

  // Level 1: Fast pure Symbol-Call BFS when both endpoints resolve to symbol names
  const srcIsFileHint = looksLikeFileQuery(fromStr);
  const dstIsFileHint = looksLikeFileQuery(toStr);
  const srcSyms = !srcIsFileHint ? resolveSymbolNamesInGraph(graph, fromStr) : [];
  const dstSyms = !dstIsFileHint ? resolveSymbolNamesInGraph(graph, toStr) : [];

  if (srcSyms.length > 0 && dstSyms.length > 0 && graph) {
    const dstSet = new Set(dstSyms);
    for (const s of srcSyms) {
      if (dstSet.has(s)) {
        const node = symNodeMeta(s);
        return {
          ok: true,
          found: true,
          from: fromStr,
          to: toStr,
          hops: 0,
          mode: 'symbol',
          path: [node],
          edges: [],
          elapsedMs: Number((performance.now() - t0).toFixed(2)),
          formattedHint: `🧭 [GraphPath 0-hop | EXTRACTED] ${node.file ? `${node.label} (${path.posix.basename(node.file)}:${node.line})` : node.label}`,
        };
      }
    }

    const visited = new Set(srcSyms);
    const parent = new Map();
    const rootOf = new Map();
    const queue = [];
    for (const s of srcSyms) {
      queue.push({ name: s, depth: 0 });
      rootOf.set(s, s);
    }

    let head = 0;
    while (head < queue.length && visited.size < maxVisited) {
      const { name: cur, depth } = queue[head++];
      if (depth >= depthCap) continue;

      const neighbors = [];
      const callees = graph.calleesOf?.get(cur);
      if (callees) {
        const sorted = Array.from(callees.values()).sort((a, b) => a.name.localeCompare(b.name));
        for (const e of sorted) {
          neighbors.push({ next: e.name, relation: 'AST_CALL', provenance: 'EXTRACTED' });
        }
      }
      if (dirMode === 'both') {
        const callers = graph.callersOf?.get(cur);
        if (callers) {
          const sorted = Array.from(callers.values()).sort((a, b) => a.name.localeCompare(b.name));
          for (const e of sorted) {
            neighbors.push({ next: e.name, relation: 'AST_CALLED_BY', provenance: 'EXTRACTED' });
          }
        }
      }

      for (const nb of neighbors) {
        if (visited.has(nb.next)) continue;
        visited.add(nb.next);
        parent.set(nb.next, { prevId: cur, relation: nb.relation, provenance: nb.provenance });
        rootOf.set(nb.next, rootOf.get(cur));

        if (dstSet.has(nb.next)) {
          const startSym = rootOf.get(nb.next) || srcSyms[0];
          const { pathNodes, edges } = reconstructBfsPath(startSym, nb.next, parent, symNodeMeta);
          return {
            ok: true,
            found: true,
            from: fromStr,
            to: toStr,
            hops: edges.length,
            mode: 'symbol',
            path: pathNodes,
            edges,
            elapsedMs: Number((performance.now() - t0).toFixed(2)),
            formattedHint: formatGraphPathChain(pathNodes, edges),
          };
        }
        queue.push({ name: nb.next, depth: depth + 1 });
      }
    }
  }

  // Level 2: Unified Symbol + File + Doc/Config BFS
  const allFiles = new Set();
  const fileToSyms = new Map();
  if (graph?.definedSymbols) {
    for (const defs of graph.definedSymbols.values()) {
      for (const d of defs) {
        if (!d?.file) continue;
        const normF = normalizePosixRel(d.file);
        allFiles.add(normF);
        let list = fileToSyms.get(normF);
        if (!list) {
          list = [];
          fileToSyms.set(normF, list);
        }
        if (!list.includes(d.name)) list.push(d.name);
      }
    }
  }

  const fwdMap = new Map();
  for (const [k, vals] of iterMapOrObjectEntries(forwardDeps)) {
    const src = normalizePosixRel(k);
    if (!src) continue;
    allFiles.add(src);
    const set = fwdMap.get(src) || new Set();
    for (const v of toArrayIter(vals)) {
      const tgt = normalizePosixRel(v);
      if (tgt && tgt !== src) {
        set.add(tgt);
        allFiles.add(tgt);
      }
    }
    fwdMap.set(src, set);
  }

  const revMap = new Map();
  for (const [k, vals] of iterMapOrObjectEntries(reverseDeps)) {
    const tgt = normalizePosixRel(k);
    if (!tgt) continue;
    allFiles.add(tgt);
    const set = revMap.get(tgt) || new Set();
    for (const v of toArrayIter(vals)) {
      const src = normalizePosixRel(v);
      if (src && src !== tgt) {
        set.add(src);
        allFiles.add(src);
      }
    }
    revMap.set(tgt, set);
  }

  if (docRefGraph?.codeFromDoc) {
    for (const [docFile, refs] of docRefGraph.codeFromDoc.entries()) {
      allFiles.add(normalizePosixRel(docFile));
      for (const r of refs || []) {
        if (r?.codeFile) allFiles.add(normalizePosixRel(r.codeFile));
      }
    }
  }
  if (docRefGraph?.refsToCode) {
    for (const [codeFile, refs] of docRefGraph.refsToCode.entries()) {
      allFiles.add(normalizePosixRel(codeFile));
      for (const r of refs || []) {
        if (r?.docFile) allFiles.add(normalizePosixRel(r.docFile));
      }
    }
  }

  const resolveUnifiedStarts = (q, isFileHint) => {
    const fMatches = resolveFileMatches(allFiles, q).map((f) => `file:${f}`);
    const sMatches = resolveSymbolNamesInGraph(graph, q).map((s) => `sym:${s}`);
    if (isFileHint && fMatches.length > 0) return fMatches;
    return [...fMatches, ...sMatches];
  };

  const startIds = resolveUnifiedStarts(fromStr, srcIsFileHint);
  const endIds = new Set(resolveUnifiedStarts(toStr, dstIsFileHint));
  if (startIds.length === 0 || endIds.size === 0) return emptyResult();

  const unifiedMeta = (id) => {
    if (id.startsWith('sym:')) return symNodeMeta(id.slice(4));
    const rel = id.slice(5);
    return {
      id,
      kind: 'file',
      label: path.posix.basename(rel),
      file: rel,
      line: 1,
    };
  };

  for (const st of startIds) {
    if (endIds.has(st)) {
      const node = unifiedMeta(st);
      return {
        ok: true,
        found: true,
        from: fromStr,
        to: toStr,
        hops: 0,
        mode: 'unified',
        path: [node],
        edges: [],
        elapsedMs: Number((performance.now() - t0).toFixed(2)),
        formattedHint: `🧭 [GraphPath 0-hop | EXTRACTED] ${node.file || node.label}`,
      };
    }
  }

  const neighborCache = new Map();
  const getNeighbors = (id) => {
    if (neighborCache.has(id)) return neighborCache.get(id);
    const out = [];
    if (id.startsWith('sym:')) {
      const symName = id.slice(4);
      const callees = graph?.calleesOf?.get(symName);
      if (callees) {
        for (const e of Array.from(callees.values()).sort((a, b) => a.name.localeCompare(b.name))) {
          out.push({ nextId: `sym:${e.name}`, relation: 'AST_CALL', provenance: 'EXTRACTED' });
        }
      }
      if (dirMode === 'both') {
        const callers = graph?.callersOf?.get(symName);
        if (callers) {
          for (const e of Array.from(callers.values()).sort((a, b) => a.name.localeCompare(b.name))) {
            out.push({ nextId: `sym:${e.name}`, relation: 'AST_CALLED_BY', provenance: 'EXTRACTED' });
          }
        }
      }
      const defs = graph?.definedSymbols?.get(symName);
      if (defs) {
        const defFiles = Array.from(new Set(defs.map((d) => normalizePosixRel(d.file)).filter(Boolean))).sort();
        for (const df of defFiles) {
          out.push({ nextId: `file:${df}`, relation: 'DEFINED_IN', provenance: 'EXTRACTED' });
        }
      }
    } else if (id.startsWith('file:')) {
      const rel = id.slice(5);
      const docTargets = docRefGraph?.codeFromDoc?.get(rel);
      if (docTargets) {
        for (const r of [...docTargets].sort((a, b) => a.codeFile.localeCompare(b.codeFile))) {
          out.push({ nextId: `file:${r.codeFile}`, relation: 'DOC_REF', provenance: 'DOC_REF' });
        }
      }
      const fwd = fwdMap.get(rel);
      if (fwd) {
        for (const tgt of Array.from(fwd).sort()) {
          out.push({ nextId: `file:${tgt}`, relation: 'IMPORT', provenance: 'EXTRACTED' });
        }
      }
      if (dirMode === 'both') {
        const rev = revMap.get(rel);
        if (rev) {
          for (const imp of Array.from(rev).sort()) {
            out.push({ nextId: `file:${imp}`, relation: 'IMPORTED_BY', provenance: 'EXTRACTED' });
          }
        }
        const docRefs = docRefGraph?.refsToCode?.get(rel);
        if (docRefs) {
          for (const r of [...docRefs].sort((a, b) => a.docFile.localeCompare(b.docFile))) {
            out.push({ nextId: `file:${r.docFile}`, relation: 'REFERENCED_BY_DOC', provenance: 'DOC_REF' });
          }
        }
      }
      const symsInFile = fileToSyms.get(rel);
      if (symsInFile) {
        for (const sName of [...symsInFile].sort()) {
          out.push({ nextId: `sym:${sName}`, relation: 'CONTAINS', provenance: 'EXTRACTED' });
        }
      }
    }
    neighborCache.set(id, out);
    return out;
  };

  const visited = new Set(startIds);
  const parent = new Map();
  const rootOf = new Map();
  const queue = [];
  for (const st of startIds) {
    queue.push({ id: st, depth: 0 });
    rootOf.set(st, st);
  }

  let head = 0;
  while (head < queue.length && visited.size < maxVisited) {
    const { id: curId, depth } = queue[head++];
    if (depth >= depthCap) continue;

    for (const nb of getNeighbors(curId)) {
      if (visited.has(nb.nextId)) continue;
      visited.add(nb.nextId);
      parent.set(nb.nextId, { prevId: curId, relation: nb.relation, provenance: nb.provenance });
      rootOf.set(nb.nextId, rootOf.get(curId));

      if (endIds.has(nb.nextId)) {
        const startId = rootOf.get(nb.nextId) || startIds[0];
        const { pathNodes, edges } = reconstructBfsPath(startId, nb.nextId, parent, unifiedMeta);
        return {
          ok: true,
          found: true,
          from: fromStr,
          to: toStr,
          hops: edges.length,
          mode: 'unified',
          path: pathNodes,
          edges,
          elapsedMs: Number((performance.now() - t0).toFixed(2)),
          formattedHint: formatGraphPathChain(pathNodes, edges),
        };
      }
      queue.push({ id: nb.nextId, depth: depth + 1 });
    }
  }

  return emptyResult();
}

/**
 * Deterministically links docs, skills (`SKILL.md`), configs, and SQL schemas to code modules
 * using explicit path references and unique exported/defined symbol mentions (`DOC_REF`).
 *
 * @param {Map<string, any>|Record<string, any>} filesMap
 */
export function buildDocConfigReferenceGraph(filesMap) {
  const t0 = performance.now();
  const entries = iterMapOrObjectEntries(filesMap)
    .map(([rawRel, val]) => [normalizePosixRel(rawRel), val])
    .filter(([rel]) => Boolean(rel))
    .sort((a, b) => a[0].localeCompare(b[0]));

  const codePaths = new Set();
  const codeLowerMap = new Map();
  const basenameToFiles = new Map();
  const symFilesMap = new Map();
  const docEntries = [];

  for (const [relPath, val] of entries) {
    const ext = (val && typeof val === 'object' && val.ext)
      ? String(val.ext).toLowerCase()
      : path.posix.extname(relPath).toLowerCase();
    const baseLower = path.posix.basename(relPath).toLowerCase();
    if (DOC_IGNORED_BASENAMES.has(baseLower)) continue;

    const text = typeof val === 'string'
      ? val
      : (val?.text ?? val?.content ?? (val?.buf ? val.buf.toString('utf8') : ''));
    if (!text) continue;

    if (CODE_EXTENSIONS.has(ext)) {
      codePaths.add(relPath);
      codeLowerMap.set(relPath.toLowerCase(), relPath);
      let baseArr = basenameToFiles.get(baseLower);
      if (!baseArr) {
        baseArr = [];
        basenameToFiles.set(baseLower, baseArr);
      }
      baseArr.push(relPath);

      const rawSyms = (val && typeof val === 'object' && Array.isArray(val.symbols) && val.symbols.length > 0)
        ? val.symbols
        : extractFileSymbolsWithRanges(ext, text);
      for (const s of rawSyms || []) {
        const name = String(s?.name || '').trim();
        if (!name || name === 'anonymous' || name.length < 8 || CONTROL_KEYWORDS.has(name)) continue;
        if (!/[A-Z_]/.test(name)) continue;
        let fSet = symFilesMap.get(name);
        if (!fSet) {
          fSet = new Set();
          symFilesMap.set(name, fSet);
        }
        fSet.add(relPath);
      }
    } else if (DOC_CONFIG_EXTENSIONS.has(ext)) {
      docEntries.push({ relPath, ext, baseLower, text });
    }
  }

  const uniqueSymbolToFile = new Map();
  for (const [symName, fSet] of symFilesMap.entries()) {
    if (fSet.size === 1) {
      uniqueSymbolToFile.set(symName, Array.from(fSet)[0]);
    }
  }

  const refsToCode = new Map();
  const codeFromDoc = new Map();
  const pathRefRe = /(?:^|[\s`"'(\[=:,;])((?:\.{0,2}\/)?(?:[A-Za-z0-9_.-]+\/){0,6}[A-Za-z0-9_.-]+\.(?:mjs|cjs|js|ts|tsx|jsx|mts|cts|py|go|rs))\b/g;
  const symRefRe = /(?:`([A-Za-z_$][A-Za-z0-9_$]{7,63})`|["']([A-Za-z_$][A-Za-z0-9_$]{7,63})["'])/g;
  const basenameLowerToPaths = new Map();
  for (const codeLower of codeLowerMap.keys()) {
    const baseL = path.posix.basename(codeLower);
    let arr = basenameLowerToPaths.get(baseL);
    if (!arr) {
      arr = [];
      basenameLowerToPaths.set(baseL, arr);
    }
    arr.push(codeLower);
  }
  let codeRefEdgeCount = 0;

  const classifyDocKind = (relPath, ext, baseLower) => {
    const low = relPath.toLowerCase();
    if (baseLower === 'skill.md' || low.startsWith('skills/') || low.includes('/skills/')) return 'skill';
    if (ext === '.sql' || ext === '.graphql' || ext === '.proto') return 'schema';
    if (ext === '.json' || ext === '.jsonc' || ext === '.yaml' || ext === '.yml' || ext === '.toml' || ext === '.ini') return 'config';
    return 'doc';
  };

  for (const doc of docEntries) {
    const slice = doc.text.length > 65536 ? doc.text.slice(0, 65536) : doc.text;
    const docDir = path.posix.dirname(doc.relPath);
    const kind = classifyDocKind(doc.relPath, doc.ext, doc.baseLower);
    const isChangelog = /^changelog/i.test(doc.baseLower);
    const matchedCode = new Map(); // codeRel -> evidence

    pathRefRe.lastIndex = 0;
    let m;
    while ((m = pathRefRe.exec(slice)) !== null) {
      if (matchedCode.size >= 16) break;
      const rawCand = normalizePosixRel(m[1]);
      if (!rawCand) continue;
      let resolved = '';

      if (docDir && docDir !== '.' && (m[1].startsWith('./') || m[1].startsWith('../') || !rawCand.includes('/'))) {
        const joined = normalizePosixRel(path.posix.join(docDir, m[1]));
        if (codeLowerMap.has(joined.toLowerCase())) {
          resolved = codeLowerMap.get(joined.toLowerCase());
        }
      }
      const cleanCand = rawCand.replace(/^(?:\.\.?\/)+/, '');
      const cleanLower = cleanCand.toLowerCase();

      if (!resolved && codeLowerMap.has(cleanLower)) {
        resolved = codeLowerMap.get(cleanLower);
      }
      if (!resolved && cleanCand.includes('/')) {
        const baseCand = path.posix.basename(cleanLower);
        const bucket = basenameLowerToPaths.get(baseCand);
        if (bucket && bucket.length > 0) {
          const suffixMatches = bucket.filter((p) => p.endsWith(`/${cleanLower}`));
          if (suffixMatches.length === 1) {
            resolved = codeLowerMap.get(suffixMatches[0]);
          }
        }
      }
      if (!resolved && !cleanCand.includes('/') && !GENERIC_CODE_BASENAMES.has(cleanLower)) {
        const baseHits = basenameToFiles.get(cleanLower);
        if (baseHits && baseHits.length === 1) {
          resolved = baseHits[0];
        }
      }

      if (resolved && !matchedCode.has(resolved)) {
        matchedCode.set(resolved, cleanCand);
      }
    }

    if (matchedCode.size < 16) {
      symRefRe.lastIndex = 0;
      let sm;
      while ((sm = symRefRe.exec(slice)) !== null) {
        if (matchedCode.size >= 16) break;
        const symName = sm[1] || sm[2] || '';
        const targetCode = uniqueSymbolToFile.get(symName);
        if (targetCode && !matchedCode.has(targetCode)) {
          matchedCode.set(targetCode, `sym:${symName}`);
        }
      }
    }

    if (matchedCode.size > 0) {
      const outArr = [];
      for (const [codeFile, evidence] of matchedCode.entries()) {
        const edgeConfidence = isChangelog
          ? 'AMBIGUOUS'
          : evidence.startsWith('sym:')
            ? 'INFERRED'
            : evidence.includes('/') || doc.ext === '.json'
              ? 'EXTRACTED'
              : 'INFERRED';
        const outEdge = {
          codeFile,
          relation: 'DOC_REF',
          provenance: 'DOC_REF',
          confidence: edgeConfidence,
          kind,
          isChangelog,
          evidence,
        };
        outArr.push(outEdge);

        let revArr = refsToCode.get(codeFile);
        if (!revArr) {
          revArr = [];
          refsToCode.set(codeFile, revArr);
        }
        revArr.push({
          docFile: doc.relPath,
          relation: 'DOC_REF',
          provenance: 'DOC_REF',
          confidence: edgeConfidence,
          kind,
          isChangelog,
          evidence,
        });
        codeRefEdgeCount++;
      }
      codeFromDoc.set(doc.relPath, outArr);
    }
  }

  return {
    builtAt: Date.now(),
    elapsedMs: Number((performance.now() - t0).toFixed(2)),
    docCount: docEntries.length,
    codeRefEdgeCount,
    refsToCode,
    codeFromDoc,
  };
}

/**
 * Queries reverse documentation/config/skill references pointing to a target code module.
 * Filters out CHANGELOG noise by default unless `includeChangelog` is true.
 *
 * @param {object|null} docRefGraph
 * @param {string} targetRelPath
 * @param {{ maxRefs?: number, includeChangelog?: boolean }} [options={}]
 */
export function queryDocRefsForFile(
  docRefGraph,
  targetRelPath,
  { maxRefs = 6, includeChangelog = false } = {}
) {
  const targetFile = normalizePosixRel(targetRelPath);
  if (!docRefGraph?.refsToCode || !targetFile) {
    return { targetFile, refs: [], totalRefs: 0, formattedHint: '' };
  }

  let rawRefs = docRefGraph.refsToCode.get(targetFile);
  if (!rawRefs) {
    const low = targetFile.toLowerCase();
    for (const [k, v] of docRefGraph.refsToCode.entries()) {
      if (k.toLowerCase() === low) {
        rawRefs = v;
        break;
      }
    }
  }
  if (!rawRefs || rawRefs.length === 0) {
    return { targetFile, refs: [], totalRefs: 0, formattedHint: '' };
  }

  const filtered = rawRefs
    .filter((r) => includeChangelog || !r.isChangelog)
    .sort((a, b) =>
      (DOC_KIND_PRIORITY[a.kind] ?? 9) - (DOC_KIND_PRIORITY[b.kind] ?? 9)
      || a.docFile.localeCompare(b.docFile)
    );

  const totalRefs = filtered.length;
  if (totalRefs === 0) {
    return { targetFile, refs: [], totalRefs: 0, formattedHint: '' };
  }

  const cap = Math.max(1, Number(maxRefs) || 6);
  const refs = filtered.slice(0, cap);
  const preview = refs.slice(0, 4).map((r) => `${r.docFile} (${r.kind}: ${r.evidence})`).join(', ');
  const more = totalRefs > 4 ? ` +${totalRefs - 4} more` : '';
  const formattedHint = `📎 [Doc/Config Refs | DOC_REF] Referenced by ${totalRefs} doc/config file(s): ${preview}${more}`;

  return {
    targetFile,
    refs,
    totalRefs,
    formattedHint,
  };
}

/**
 * Partitions repository code modules into deterministic architectural communities via
 * weighted Label Propagation and detects high-coupling God Nodes with Newman-Girvan modularity Q.
 *
 * @param {Map<string, any>|Record<string, any>} filesMap
 * @param {Map<string, Set<string>>|object|null} [forwardDeps=null]
 * @param {Map<string, Set<string>>|object|null} [reverseDeps=null]
 * @param {{ symbolGraph?: object|null, docRefGraph?: object|null, maxClusters?: number, maxGodNodes?: number, maxIterations?: number }} [options={}]
 */
export function detectArchitectureClusters(
  filesMap,
  forwardDeps = null,
  reverseDeps = null,
  {
    symbolGraph = null,
    docRefGraph = null,
    maxClusters = 8,
    maxGodNodes = 5,
    maxIterations = 12,
    ambiguousScale = 0.25,
    excludeHubsPercentile = null,
  } = {}
) {
  const t0 = performance.now();
  const nodes = [];
  const nodeIndex = new Map();

  for (const [rawRel, val] of iterMapOrObjectEntries(filesMap).sort((a, b) => String(a[0]).localeCompare(String(b[0])))) {
    const relPath = normalizePosixRel(rawRel);
    if (!relPath) continue;
    const ext = (val && typeof val === 'object' && val.ext)
      ? String(val.ext).toLowerCase()
      : path.posix.extname(relPath).toLowerCase();
    if (!CODE_EXTENSIONS.has(ext)) continue;
    const idx = nodes.length;
    nodes.push({
      id: idx,
      relPath,
      dir: path.posix.dirname(relPath),
      symbolCount: Array.isArray(val?.symbols) ? val.symbols.length : 0,
    });
    nodeIndex.set(relPath, idx);
  }

  const N = nodes.length;
  if (N === 0) {
    return {
      ok: true,
      elapsedMs: Number((performance.now() - t0).toFixed(2)),
      fileCount: 0,
      clusterCount: 0,
      modularityQ: 0,
      clusters: [],
      godNodes: [],
      fileToCluster: new Map(),
      formattedDigest: '',
    };
  }

  const adj = Array.from({ length: N }, () => new Map());
  const outSet = Array.from({ length: N }, () => new Set());
  const inSet = Array.from({ length: N }, () => new Set());
  const directedImportPairs = new Set();

  const addUndirectedWeight = (u, v, w) => {
    if (u === v || w <= 0) return;
    adj[u].set(v, (adj[u].get(v) || 0) + w);
    adj[v].set(u, (adj[v].get(u) || 0) + w);
  };

  const addDirectedDependency = (u, v) => {
    if (u === v || u === undefined || v === undefined) return;
    const key = `${u}->${v}`;
    if (directedImportPairs.has(key)) return;
    directedImportPairs.add(key);
    outSet[u].add(v);
    inSet[v].add(u);
    addUndirectedWeight(u, v, 3.0);
  };

  for (const [rawSrc, targets] of iterMapOrObjectEntries(forwardDeps)) {
    const u = nodeIndex.get(normalizePosixRel(rawSrc));
    if (u === undefined) continue;
    for (const rawTgt of toArrayIter(targets)) {
      const v = nodeIndex.get(normalizePosixRel(rawTgt));
      if (v !== undefined) addDirectedDependency(u, v);
    }
  }

  for (const [rawTgt, importers] of iterMapOrObjectEntries(reverseDeps)) {
    const v = nodeIndex.get(normalizePosixRel(rawTgt));
    if (v === undefined) continue;
    for (const rawSrc of toArrayIter(importers)) {
      const u = nodeIndex.get(normalizePosixRel(rawSrc));
      if (u !== undefined) addDirectedDependency(u, v);
    }
  }

  // Inter-file AST symbol calls add weighted edges (capped at 4 calls per file pair)
  if (symbolGraph?.calleesOf && symbolGraph?.definedSymbols) {
    const pairCalls = new Map();
    for (const [callerName, edgeMap] of symbolGraph.calleesOf.entries()) {
      const callerDefs = symbolGraph.definedSymbols.get(callerName);
      if (!callerDefs || callerDefs.length !== 1) continue;
      const u = nodeIndex.get(normalizePosixRel(callerDefs[0].file));
      if (u === undefined) continue;
      for (const edge of edgeMap.values()) {
        if (!edge?.isRepoSymbol || !edge.file) continue;
        const v = nodeIndex.get(normalizePosixRel(edge.file));
        if (v === undefined || u === v) continue;
        const pairKey = u < v ? `${u}|${v}` : `${v}|${u}`;
        const confScale = edge.confidence === 'AMBIGUOUS'
          ? Math.max(0.05, Number(ambiguousScale) || 0.25)
          : edge.confidence === 'INFERRED'
            ? 0.75
            : 1.0;
        pairCalls.set(pairKey, (pairCalls.get(pairKey) || 0) + confScale);
      }
    }
    for (const [pairKey, cnt] of pairCalls.entries()) {
      const sep = pairKey.indexOf('|');
      const u = Number(pairKey.slice(0, sep));
      const v = Number(pairKey.slice(sep + 1));
      addUndirectedWeight(u, v, 1.2 * Math.min(4, cnt));
    }
  }

  // Weak folder cohesion prior keeps isolated helpers in same subdirectory grouped cleanly
  const dirGroups = new Map();
  for (const n of nodes) {
    if (!n.dir || n.dir === '.') continue;
    let grp = dirGroups.get(n.dir);
    if (!grp) {
      grp = [];
      dirGroups.set(n.dir, grp);
    }
    grp.push(n.id);
  }
  for (const ids of dirGroups.values()) {
    if (ids.length >= 2 && ids.length <= 25) {
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          addUndirectedWeight(ids[i], ids[j], 0.35);
        }
      }
    }
  }

  const weightedDeg = new Float64Array(N);
  let twoM = 0;
  for (let i = 0; i < N; i++) {
    let sum = 0;
    for (const w of adj[i].values()) sum += w;
    weightedDeg[i] = sum;
    twoM += sum;
  }

  const labels = Int32Array.from({ length: N }, (_, i) => i);
  const order = Array.from({ length: N }, (_, i) => i).sort(
    (a, b) => weightedDeg[b] - weightedDeg[a] || nodes[a].relPath.localeCompare(nodes[b].relPath)
  );
  const iterCap = Math.max(1, Math.min(32, Number(maxIterations) || 12));
  const labelScores = new Map();

  for (let iter = 0; iter < iterCap; iter++) {
    let changed = 0;
    for (const u of order) {
      if (adj[u].size === 0) continue;
      labelScores.clear();
      labelScores.set(labels[u], 0.001);
      for (const [v, w] of adj[u].entries()) {
        const lbl = labels[v];
        labelScores.set(lbl, (labelScores.get(lbl) || 0) + w);
      }
      let bestLabel = labels[u];
      let bestScore = -1;
      for (const [lbl, sc] of labelScores.entries()) {
        if (sc > bestScore || (sc === bestScore && lbl < bestLabel)) {
          bestScore = sc;
          bestLabel = lbl;
        }
      }
      if (bestLabel !== labels[u]) {
        labels[u] = bestLabel;
        changed++;
      }
    }
    if (changed === 0) break;
  }

  const commMembers = new Map();
  for (let i = 0; i < N; i++) {
    const lbl = labels[i];
    let arr = commMembers.get(lbl);
    if (!arr) {
      arr = [];
      commMembers.set(lbl, arr);
    }
    arr.push(i);
  }

  let modularityQ = 0;
  if (twoM > 0) {
    let q = 0;
    for (const [lbl, members] of commMembers.entries()) {
      let sumDeg = 0;
      let internalTwice = 0;
      for (const u of members) {
        sumDeg += weightedDeg[u];
        for (const [v, w] of adj[u].entries()) {
          if (labels[v] === lbl) internalTwice += w;
        }
      }
      q += (internalTwice / twoM) - Math.pow(sumDeg / twoM, 2);
    }
    modularityQ = Number(q.toFixed(3));
  }

  const nodeMetrics = nodes.map((n, i) => {
    const inDeg = inSet[i].size;
    const outDeg = outSet[i].size;
    const docRefCount = docRefGraph?.refsToCode
      ? queryDocRefsForFile(docRefGraph, n.relPath, { includeChangelog: false }).totalRefs
      : 0;
    const couplingScore = (inDeg * 2) + outDeg + docRefCount;
    return {
      id: i,
      file: n.relPath,
      dir: n.dir,
      inDegree: inDeg,
      outDegree: outDeg,
      docRefCount,
      symbolCount: n.symbolCount,
      couplingScore,
    };
  });

  const allClusters = [];
  for (const members of commMembers.values()) {
    const memberSet = new Set(members);
    const rankedMembers = members
      .map((id) => nodeMetrics[id])
      .sort((a, b) => b.couplingScore - a.couplingScore || b.inDegree - a.inDegree || a.file.localeCompare(b.file));
    const hubFile = rankedMembers[0].file;

    const dirCounts = new Map();
    for (const m of rankedMembers) {
      if (!m.dir || m.dir === '.') continue;
      dirCounts.set(m.dir, (dirCounts.get(m.dir) || 0) + 1);
    }
    let bestDir = '';
    let bestDirCount = 0;
    for (const [d, cnt] of dirCounts.entries()) {
      if (cnt > bestDirCount || (cnt === bestDirCount && d.localeCompare(bestDir) < 0)) {
        bestDir = d;
        bestDirCount = cnt;
      }
    }
    const label = bestDir && bestDirCount >= Math.ceil(rankedMembers.length * 0.6)
      ? bestDir
      : path.posix.basename(hubFile, path.posix.extname(hubFile));

    let internalEdges = 0;
    let externalEdges = 0;
    for (const u of members) {
      for (const v of outSet[u]) {
        if (memberSet.has(v)) internalEdges++;
        else externalEdges++;
      }
    }

    allClusters.push({
      id: `c${allClusters.length + 1}`,
      label,
      size: rankedMembers.length,
      hubFile,
      internalEdges,
      externalEdges,
      files: rankedMembers.map((m) => m.file),
    });
  }

  allClusters.sort(
    (a, b) => b.size - a.size || b.internalEdges - a.internalEdges || a.hubFile.localeCompare(b.hubFile)
  );

  const fileToCluster = new Map();
  allClusters.forEach((c, idx) => {
    c.id = `cluster_${idx + 1}`;
    for (const f of c.files) {
      fileToCluster.set(f, { id: c.id, label: c.label, size: c.size, hubFile: c.hubFile });
    }
  });

  let hubCutoffScore = Infinity;
  if (excludeHubsPercentile !== null && Number.isFinite(Number(excludeHubsPercentile))) {
    const pct = Math.max(1, Math.min(100, Number(excludeHubsPercentile)));
    const sortedScores = nodeMetrics.map((m) => m.couplingScore).sort((a, b) => a - b);
    if (sortedScores.length > 0) {
      const idx = Math.max(0, Math.floor((sortedScores.length * pct) / 100) - 1);
      hubCutoffScore = sortedScores[idx];
    }
  }

  const nonBarrelCandidates = nodeMetrics.filter((m) => {
    const base = path.posix.basename(m.file).toLowerCase();
    const isPureBarrel = /^index\.[a-z]+$/.test(base) && m.symbolCount === 0 && m.outDegree >= 2;
    return !isPureBarrel && m.couplingScore <= hubCutoffScore && (m.couplingScore >= 2 || m.inDegree >= 1);
  });
  const godPool = nonBarrelCandidates.length > 0
    ? nonBarrelCandidates
    : nodeMetrics.filter((m) => m.couplingScore <= hubCutoffScore && (m.couplingScore >= 2 || m.inDegree >= 1));

  const clusters = allClusters.slice(0, Math.max(1, Number(maxClusters) || 8));
  const godNodes = godPool
    .sort((a, b) => b.couplingScore - a.couplingScore || b.inDegree - a.inDegree || a.file.localeCompare(b.file))
    .slice(0, Math.max(1, Number(maxGodNodes) || 5))
    .map(({ file, inDegree, outDegree, docRefCount, symbolCount, couplingScore }) => ({
      file,
      inDegree,
      outDegree,
      docRefCount,
      symbolCount,
      couplingScore,
    }));

  const topologyHash = computeGraphTopologyHash(
    nodes.map((n) => n.relPath),
    directedImportPairs,
    { ambiguousScale, excludeHubsPercentile, maxIterations }
  );

  const digestLines = [`🧩 [Arch Graph | ${N} code files | ${allClusters.length} clusters | Q=${modularityQ}]`];
  if (godNodes.length > 0) {
    const godLine = godNodes
      .slice(0, 4)
      .map((g) => `${g.file} (in:${g.inDegree}, out:${g.outDegree}, docs:${g.docRefCount})`)
      .join(', ');
    digestLines.push(`• God Nodes: ${godLine}`);
  }
  if (clusters.length > 0) {
    const clLine = clusters
      .slice(0, 5)
      .map((c) => `${c.label} (${c.size}f, hub: ${path.posix.basename(c.hubFile)})`)
      .join(' | ');
    digestLines.push(`• Clusters: ${clLine}`);
  }
  let formattedDigest = digestLines.join('\n');
  if (formattedDigest.length > 720) {
    formattedDigest = `${formattedDigest.slice(0, 717)}...`;
  }

  return {
    ok: true,
    elapsedMs: Number((performance.now() - t0).toFixed(2)),
    topologyHash,
    fileCount: N,
    clusterCount: allClusters.length,
    modularityQ,
    clusters,
    godNodes,
    fileToCluster,
    formattedDigest,
  };
}

function buildTextFeatureSets(text) {
  const raw = String(text || '');
  const tokens = new Set(splitIdentifierSubtokens(raw).slice(0, 120));
  const ngrams4 = new Set();
  const norm = raw.toLowerCase().replace(/\s+/g, ' ').trim();
  if (norm.length >= 4) {
    const limit = Math.min(norm.length - 3, 280);
    for (let i = 0; i < limit; i++) {
      ngrams4.add(norm.slice(i, i + 4));
    }
  }
  return { tokens, ngrams4 };
}

function jaccardSimilarity(setA, setB) {
  if (!setA || !setB || setA.size === 0 || setB.size === 0) return 0;
  let inter = 0;
  const [small, large] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
  for (const v of small) {
    if (large.has(v)) inter++;
  }
  if (inter === 0) return 0;
  return inter / (setA.size + setB.size - inter);
}

function computeCandidateSimilarity(a, b) {
  const fileA = String(a.file || a.relPath || '').toLowerCase();
  const fileB = String(b.file || b.relPath || '').toLowerCase();
  let lineOverlapPenalty = 0;
  if (fileA && fileA === fileB) {
    const sA = Number(a.startLine) || 1;
    const eA = Math.max(sA, Number(a.endLine) || sA);
    const sB = Number(b.startLine) || 1;
    const eB = Math.max(sB, Number(b.endLine) || sB);
    const overlap = Math.max(0, Math.min(eA, eB) - Math.max(sA, sB) + 1);
    if (overlap > 0) {
      const minLen = Math.max(1, Math.min(eA - sA + 1, eB - sB + 1));
      lineOverlapPenalty = overlap / minLen;
    }
  }

  const tokSim = jaccardSimilarity(a._feats.tokens, b._feats.tokens);
  const gramSim = jaccardSimilarity(a._feats.ngrams4, b._feats.ngrams4);
  const textSim = 0.5 * tokSim + 0.5 * gramSim;
  return {
    sim: Math.min(1, Math.max(textSim, lineOverlapPenalty)),
    textSim,
    lineOverlapPenalty,
  };
}

/**
 * Submodular Maximal Marginal Relevance (MMR) selector over candidate slices.
 * Balances normalized relevance score against 4-gram/token Jaccard similarity
 * and same-file line-overlap penalty, filtering out near-duplicate slices.
 *
 * @param {Array<object>} [candidates=[]]
 * @param {{ topK?: number, lambda?: number }} [options={}]
 * @returns {{ selected: Array<object>, filteredDuplicates: Array<object> }}
 */
export function selectDiverseSlicesMMR(candidates = [], { topK = 6, lambda = 0.72 } = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { selected: [], filteredDuplicates: [] };
  }

  const k = Math.max(1, Number(topK) || 6);
  const lam = Math.max(0, Math.min(1, Number.isFinite(Number(lambda)) ? Number(lambda) : 0.72));

  const rawScores = candidates.map((c) => Number(
    c?.rerankScore ?? c?.hybridScore ?? c?.score ?? c?.similarity ?? c?.bm25fScore ?? 0
  ) || 0);
  let minScore = Infinity;
  let maxScore = -Infinity;
  for (const s of rawScores) {
    if (s < minScore) minScore = s;
    if (s > maxScore) maxScore = s;
  }
  const span = maxScore - minScore;

  const pool = candidates.map((c, idx) => ({
    orig: c,
    file: c?.relPath || c?.file || '',
    startLine: Number(c?.startLine) || 1,
    endLine: Number(c?.endLine) || Number(c?.startLine) || 1,
    normScore: span > 1e-9 ? (rawScores[idx] - minScore) / span : 1,
    maxSim: 0,
    _feats: buildTextFeatureSets(c?.snippetText ?? c?.text ?? c?.snippet ?? ''),
  }));

  // Pick highest-relevance item first
  let bestIdx = 0;
  for (let i = 1; i < pool.length; i++) {
    if (pool[i].normScore > pool[bestIdx].normScore) {
      bestIdx = i;
    }
  }

  const selected = [];
  const filteredDuplicates = [];
  const chosenWrapped = [];

  const first = pool.splice(bestIdx, 1)[0];
  selected.push(first.orig);
  chosenWrapped.push(first);

  let remaining = pool;
  while (selected.length < k && remaining.length > 0) {
    const lastChosen = chosenWrapped[chosenWrapped.length - 1];
    const nextRemaining = [];

    for (const cand of remaining) {
      const { sim, textSim, lineOverlapPenalty } = computeCandidateSimilarity(cand, lastChosen);
      if (sim > cand.maxSim) cand.maxSim = sim;

      // Hard duplicate gate: same-file >= 60% line overlap OR >= 82% text similarity
      if (lineOverlapPenalty >= 0.6 || textSim >= 0.82) {
        filteredDuplicates.push(cand.orig);
      } else {
        nextRemaining.push(cand);
      }
    }

    remaining = nextRemaining;
    if (remaining.length === 0) break;

    let pickIdx = 0;
    let bestMmr = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const c = remaining[i];
      const mmr = lam * c.normScore - (1 - lam) * c.maxSim;
      if (mmr > bestMmr) {
        bestMmr = mmr;
        pickIdx = i;
      }
    }

    const picked = remaining.splice(pickIdx, 1)[0];
    selected.push(picked.orig);
    chosenWrapped.push(picked);
  }

  return { selected, filteredDuplicates };
}

/**
 * Order-independent XOR SHA-256 fingerprint of graph topology & clustering parameters
 * (inspired by Graphify `_topology_hash`).
 */
export function computeGraphTopologyHash(nodeIds = [], edgeKeys = [], params = {}) {
  const safeNodes = nodeIds && typeof nodeIds[Symbol.iterator] === 'function' ? nodeIds : [];
  const safeEdges = edgeKeys && typeof edgeKeys[Symbol.iterator] === 'function' ? edgeKeys : [];
  const accNodes = Buffer.alloc(32, 0);
  for (const n of safeNodes) {
    const d = createHash('sha256').update(`n\0${String(n)}`).digest();
    for (let i = 0; i < 32; i++) accNodes[i] ^= d[i];
  }
  const accEdges = Buffer.alloc(32, 0);
  for (const e of safeEdges) {
    const d = createHash('sha256').update(`e\0${String(e)}`).digest();
    for (let i = 0; i < 32; i++) accEdges[i] ^= d[i];
  }
  const h = createHash('sha256');
  h.update(JSON.stringify({
    v: 'topo-v1',
    nodeCount: Array.isArray(nodeIds) ? nodeIds.length : (nodeIds?.size || 0),
    edgeCount: Array.isArray(edgeKeys) ? edgeKeys.length : (edgeKeys?.size || 0),
    ambiguousScale: params?.ambiguousScale ?? 0.25,
    excludeHubsPercentile: params?.excludeHubsPercentile ?? null,
    maxIterations: params?.maxIterations ?? 12,
  }));
  h.update(accNodes);
  h.update(accEdges);
  return `v1:${h.digest('hex').slice(0, 24)}`;
}

const CONFIDENCE_SURPRISE_RANK = { AMBIGUOUS: 0, INFERRED: 1, EXTRACTED: 2 };

/**
 * Finds surprising cross-cluster / cross-subsystem bridges (Graphify `surprising_connections`),
 * ranking AMBIGUOUS -> INFERRED -> EXTRACTED so fragile implicit couplings surface first.
 */
export function findSurprisingConnections(
  filesMap,
  archClusters,
  symbolGraph = null,
  forwardDeps = null,
  { topN = 6 } = {}
) {
  const fileToCluster = archClusters?.fileToCluster instanceof Map ? archClusters.fileToCluster : new Map();
  const bridges = [];
  const seen = new Set();

  if (symbolGraph?.calleesOf && symbolGraph?.definedSymbols) {
    for (const [callerName, edgeMap] of symbolGraph.calleesOf.entries()) {
      const callerDefs = symbolGraph.definedSymbols.get(callerName);
      if (!callerDefs || callerDefs.length === 0) continue;
      const srcFile = normalizePosixRel(callerDefs[0].file);
      const srcCluster = fileToCluster.get(srcFile);
      for (const edge of edgeMap.values()) {
        if (!edge?.file) continue;
        const dstFile = normalizePosixRel(edge.file);
        if (!dstFile || dstFile === srcFile) continue;
        const dstCluster = fileToCluster.get(dstFile);
        const crossCluster = Boolean(srcCluster && dstCluster && srcCluster.id !== dstCluster.id);
        const crossDir = path.posix.dirname(srcFile) !== path.posix.dirname(dstFile);
        if (!crossCluster && !crossDir) continue;
        const key = `${srcFile}#${callerName}->${dstFile}#${edge.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        bridges.push({
          fromFile: srcFile,
          fromSymbol: callerName,
          toFile: dstFile,
          toSymbol: edge.name,
          callSiteLine: edge.callSiteLine || edge.line || 1,
          relation: 'calls',
          confidence: edge.confidence || 'INFERRED',
          fromCluster: srcCluster?.label || path.posix.dirname(srcFile),
          toCluster: dstCluster?.label || path.posix.dirname(dstFile),
          crossCluster,
        });
      }
    }
  }

  if (forwardDeps) {
    for (const [rawSrc, targets] of iterMapOrObjectEntries(forwardDeps)) {
      const srcFile = normalizePosixRel(rawSrc);
      const srcCluster = fileToCluster.get(srcFile);
      for (const rawDst of toArrayIter(targets)) {
        const dstFile = normalizePosixRel(rawDst);
        if (!dstFile || dstFile === srcFile) continue;
        const dstCluster = fileToCluster.get(dstFile);
        if (!srcCluster || !dstCluster || srcCluster.id === dstCluster.id) continue;
        const key = `imp:${srcFile}->${dstFile}`;
        if (seen.has(key)) continue;
        seen.add(key);
        bridges.push({
          fromFile: srcFile,
          fromSymbol: '',
          toFile: dstFile,
          toSymbol: '',
          callSiteLine: 1,
          relation: 'imports',
          confidence: 'EXTRACTED',
          fromCluster: srcCluster.label,
          toCluster: dstCluster.label,
          crossCluster: true,
        });
      }
    }
  }

  bridges.sort((a, b) => {
    if (a.crossCluster !== b.crossCluster) return a.crossCluster ? -1 : 1;
    const rA = CONFIDENCE_SURPRISE_RANK[a.confidence] ?? 2;
    const rB = CONFIDENCE_SURPRISE_RANK[b.confidence] ?? 2;
    if (rA !== rB) return rA - rB;
    return a.fromFile.localeCompare(b.fromFile);
  });

  return bridges.slice(0, Math.max(1, Number(topN) || 6));
}

/**
 * Generates targeted architectural questions from AMBIGUOUS cross-cluster edges and undocumented God Nodes
 * (inspired by Graphify `suggest_questions`).
 */
export function suggestArchitectureQuestions(archClusters, surprisingBridges = [], { maxQuestions = 5 } = {}) {
  const questions = [];
  const ambigBridges = (surprisingBridges || []).filter((b) => b.confidence === 'AMBIGUOUS' || b.confidence === 'INFERRED');
  for (const b of ambigBridges.slice(0, 3)) {
    questions.push({
      kind: 'ambiguous_bridge',
      confidence: b.confidence,
      question: `Why does \`${b.fromFile}\` (${b.fromCluster}) couple to \`${b.toSymbol || b.toFile}\` in \`${b.toFile}\` (${b.toCluster}) via [${b.confidence}] ${b.relation} at L${b.callSiteLine}?`,
    });
  }
  for (const g of archClusters?.godNodes || []) {
    if (questions.length >= maxQuestions) break;
    if (g.inDegree >= 3 && g.docRefCount === 0) {
      questions.push({
        kind: 'undocumented_god_node',
        confidence: 'EXTRACTED',
        question: `God Node \`${g.file}\` has ${g.inDegree} reverse dependents (coupling:${g.couplingScore}) but 0 documentation/spec references — should its contract be pinned?`,
      });
    }
  }
  for (const c of archClusters?.clusters || []) {
    if (questions.length >= maxQuestions) break;
    if (c.externalEdges > c.internalEdges && c.size >= 2) {
      questions.push({
        kind: 'leaky_cluster',
        confidence: 'EXTRACTED',
        question: `Cluster **${c.label}** (${c.size} files) has more external edges (${c.externalEdges}) than internal cohesion (${c.internalEdges}) — should hub \`${c.hubFile}\` expose a narrower facade?`,
      });
    }
  }
  return questions.slice(0, Math.max(1, Number(maxQuestions) || 5));
}

function resolveRelativeModuleCandidate(fromFile, spec, codeLowerMap) {
  const rawSpec = String(spec || '').trim();
  if (!rawSpec) return '';
  const normFrom = normalizePosixRel(fromFile);
  if (normFrom.endsWith('.py') && !rawSpec.startsWith('./') && !rawSpec.startsWith('../')) {
    const baseDir = path.posix.dirname(normFrom);
    if (rawSpec.startsWith('.')) {
      const dots = rawSpec.match(/^\.+/)?.[0].length || 1;
      let pyBase = baseDir;
      for (let i = 1; i < dots; i++) pyBase = path.posix.dirname(pyBase);
      const modRel = rawSpec.slice(dots).replace(/\./g, '/');
      const pyCands = modRel ? [`${pyBase}/${modRel}.py`, `${pyBase}/${modRel}/__init__.py`] : [`${pyBase}/__init__.py`];
      for (const c of pyCands) {
        const hit = codeLowerMap.get(normalizePosixRel(c).toLowerCase());
        if (hit) return hit;
      }
    } else if (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(rawSpec)) {
      const modPath = rawSpec.replace(/\./g, '/');
      for (const c of [`${modPath}.py`, `${modPath}/__init__.py`, `src/${modPath}.py`, `src/${modPath}/__init__.py`]) {
        const hit = codeLowerMap.get(c.toLowerCase());
        if (hit) return hit;
      }
    }
    return '';
  }
  if (!rawSpec.startsWith('.')) return '';
  const baseDir = path.posix.dirname(normFrom);
  const joined = normalizePosixRel(path.posix.join(baseDir, rawSpec));
  const candidates = [
    joined,
    `${joined}.mjs`,
    `${joined}.js`,
    `${joined}.ts`,
    `${joined}.tsx`,
    `${joined}.cjs`,
    `${joined}/index.js`,
    `${joined}/index.ts`,
    `${joined}/index.mjs`,
  ];
  if (/\.[cm]?js$/i.test(joined)) {
    candidates.push(joined.replace(/\.[cm]?js$/i, '.ts'), joined.replace(/\.[cm]?js$/i, '.tsx'));
  }
  for (const c of candidates) {
    const hit = codeLowerMap.get(c.toLowerCase());
    if (hit) return hit;
  }
  return '';
}

/**
 * Transitive reverse blast-radius walker (Graphify `affected.py`) covering static `imports`,
 * `dynamic_import` (`import('...')`), `re_exports` (`export * from`), and symbol `calls`,
 * preserving exact call/import site `viaLocation` (`file:L#`).
 */
export function queryAffectedBlastGraph(
  filesMap,
  targetQuery,
  { forwardDeps = null, reverseDeps = null, symbolGraph = null, maxDepth = 4 } = {}
) {
  const entries = iterMapOrObjectEntries(filesMap)
    .map(([r, v]) => [normalizePosixRel(r), v])
    .filter(([r]) => Boolean(r));
  const codeLowerMap = new Map();
  const fileTexts = new Map();
  for (const [rel, val] of entries) {
    codeLowerMap.set(rel.toLowerCase(), rel);
    const txt = typeof val === 'string'
      ? val
      : (val?.text ?? val?.content ?? (val?.buf ? val.buf.toString('utf8') : ''));
    if (txt) fileTexts.set(rel, txt);
  }

  // Incoming consumer edges: targetFile -> Array<{ consumerFile, relation, viaLocation, confidence }>
  const incomingByFile = new Map();
  const pushIncoming = (targetFile, consumerFile, relation, lineNo = 1, confidence = 'EXTRACTED') => {
    if (!targetFile || !consumerFile || targetFile === consumerFile) return;
    let list = incomingByFile.get(targetFile);
    if (!list) {
      list = [];
      incomingByFile.set(targetFile, list);
    }
    if (!list.some((e) => e.consumerFile === consumerFile && e.relation === relation)) {
      list.push({
        consumerFile,
        relation,
        viaLocation: `${consumerFile}:L${Math.max(1, Number(lineNo) || 1)}`,
        confidence,
      });
    }
  };

  for (const [rel, txt] of fileTexts.entries()) {
    const lines = txt.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      if (!ln.includes('import') && !ln.includes('export') && !ln.includes('require')) continue;
      for (const dm of ln.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        const resolved = resolveRelativeModuleCandidate(rel, dm[1], codeLowerMap);
        if (resolved) pushIncoming(resolved, rel, 'dynamic_import', i + 1, 'EXTRACTED');
      }
      for (const rm of ln.matchAll(/^\s*export\s+(?:\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/g)) {
        const resolved = resolveRelativeModuleCandidate(rel, rm[1], codeLowerMap);
        if (resolved) pushIncoming(resolved, rel, 're_exports', i + 1, 'EXTRACTED');
      }
      for (const sm of ln.matchAll(/(?:^\s*import\s+[\s\S]*?\bfrom\s+['"]([^'"]+)['"]|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\))/g)) {
        const resolved = resolveRelativeModuleCandidate(rel, sm[1] || sm[2], codeLowerMap);
        if (resolved) pushIncoming(resolved, rel, 'imports', i + 1, 'EXTRACTED');
      }
    }
  }

  if (reverseDeps) {
    for (const [rawTarget, consumers] of iterMapOrObjectEntries(reverseDeps)) {
      const tRel = normalizePosixRel(rawTarget);
      for (const rawCons of toArrayIter(consumers)) {
        pushIncoming(tRel, normalizePosixRel(rawCons), 'imports', 1, 'EXTRACTED');
      }
    }
  }

  const rawQ = String(targetQuery || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  let seedFile = codeLowerMap.get(rawQ.toLowerCase()) || '';
  let seedSymbol = '';
  if (!seedFile) {
    for (const k of codeLowerMap.values()) {
      if (k.toLowerCase().endsWith(`/${rawQ.toLowerCase()}`) || path.posix.basename(k).toLowerCase() === rawQ.toLowerCase()) {
        seedFile = k;
        break;
      }
    }
  }
  if (!seedFile && symbolGraph?.definedSymbols) {
    const cleanSym = rawQ.replace(/\(\)$/, '');
    const defs = symbolGraph.definedSymbols.get(cleanSym);
    if (defs && defs.length > 0) {
      seedSymbol = cleanSym;
      seedFile = normalizePosixRel(defs[0].file);
    }
  }

  if (!seedFile) {
    return { ok: false, target: rawQ, seedFile: '', affected: [], formatted: `No file or symbol matching "${rawQ}" in graph.` };
  }

  const hits = [];
  const visited = new Set([seedFile]);
  const queue = [{ file: seedFile, depth: 0 }];
  const capDepth = Math.max(1, Math.min(8, Number(maxDepth) || 4));

  if (seedSymbol && symbolGraph?.callersOf?.has(seedSymbol)) {
    for (const edge of symbolGraph.callersOf.get(seedSymbol).values()) {
      const cf = normalizePosixRel(edge.file);
      if (cf && cf !== seedFile && !visited.has(cf)) {
        visited.add(cf);
        const hit = {
          file: cf,
          depth: 1,
          viaRelation: 'calls',
          viaLocation: `${cf}:L${edge.callSiteLine || edge.line || 1}`,
          confidence: edge.confidence || 'INFERRED',
        };
        hits.push(hit);
        queue.push({ file: cf, depth: 1 });
      }
    }
  }

  while (queue.length > 0) {
    const cur = queue.shift();
    if (cur.depth >= capDepth) continue;
    const consumers = incomingByFile.get(cur.file) || [];
    for (const c of consumers) {
      if (visited.has(c.consumerFile)) continue;
      visited.add(c.consumerFile);
      const nextDepth = cur.depth + 1;
      hits.push({
        file: c.consumerFile,
        depth: nextDepth,
        viaRelation: c.relation,
        viaLocation: c.viaLocation,
        confidence: c.confidence,
      });
      queue.push({ file: c.consumerFile, depth: nextDepth });
    }
  }

  const lines = [
    `💥 [Affected Blast Radius] Seed: \`${seedSymbol ? `${seedSymbol} (${seedFile})` : seedFile}\` -> ${hits.length} consumer(s) within ${capDepth} hop(s):`,
    ...hits.slice(0, 20).map((h) => `- [d=${h.depth} | ${h.viaRelation} | ${h.confidence}] \`${h.file}\` (site: \`${h.viaLocation}\`)`),
  ];

  return {
    ok: true,
    target: rawQ,
    seedFile,
    seedSymbol,
    affectedCount: hits.length,
    affected: hits,
    formatted: lines.join('\n'),
  };
}

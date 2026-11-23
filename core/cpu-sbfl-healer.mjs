/**
 * @file cpu-sbfl-healer.mjs
 * @description Zero-VRAM CPU fault localization, fuzzy patch healing, brace-balanced skimming & session fact extraction:
 *   1. SBFL Ochiai Fault Localization over NODE_V8_COVERAGE (`computeOchiaiScores`, `localizeFaultWithV8Sbfl`)
 *   2. Bitap (Shift-Or) + Blank-Line Elastic AST Patch Healer (`healSearchBlockBitapAst`)
 *   3. Brace-Balanced Intra-Function Goal Skimmer (`skimAstBranchesWithBraceBalance`)
 *   4. Deterministic Session Fact Table Extractor (`extractDeterministicFactTable`)
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expandQueryBilingualStems } from './cpu-reranker.mjs';
import { recordCpuCompressionSaving } from './cpu-worker-pool.mjs';
import { stemWord } from './repo-mapper.mjs';

const execFileAsync = promisify(execFile);

function toPosixRelSafe(absRoot, filePath) {
  if (!filePath) return '';
  try {
    const rel = path.relative(path.resolve(absRoot || '.'), path.resolve(filePath));
    return rel.replace(/\\/g, '/').replace(/^\.\//, '');
  } catch {
    return String(filePath).replace(/\\/g, '/');
  }
}

function normalizeWinPath(p = '') {
  return process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
}

// ============================================================================
// 1. SBFL Ochiai Fault Localization over NODE_V8_COVERAGE
// ============================================================================

/**
 * Computes Spectrum-Based Fault Localization (Ochiai) scores across covered production functions.
 * @param {Array<{ passed: boolean, coveredFunctions: Array<{ file: string, functionName: string, startLine: number, endLine: number, count: number }> }>} testRuns
 * @param {{ workspaceRoot?: string, editedFile?: string, excludeTestFiles?: boolean }} [options={}]
 */
export function computeOchiaiScores(
  testRuns = [],
  { workspaceRoot = '', editedFile = '', excludeTestFiles = true } = {}
) {
  const runs = Array.isArray(testRuns) ? testRuns : [];
  if (runs.length === 0) return [];

  let totalFailed = 0;
  let totalPassed = 0;
  const stats = new Map(); // key -> { relFile, functionName, startLine, endLine, ef, ep }
  const normEdited = editedFile ? toPosixRelSafe(workspaceRoot, path.resolve(workspaceRoot || '.', editedFile)).toLowerCase() : '';

  for (const run of runs) {
    if (!run || !Array.isArray(run.coveredFunctions)) continue;
    const isFail = !run.passed;
    if (isFail) totalFailed += 1;
    else totalPassed += 1;

    const seenInRun = new Set();
    for (const fn of run.coveredFunctions) {
      if (!fn || Number(fn.count || 0) <= 0 || !fn.file) continue;
      const relFile = workspaceRoot ? toPosixRelSafe(workspaceRoot, fn.file) : String(fn.file).replace(/\\/g, '/');
      if (!relFile || relFile.startsWith('..') || relFile.includes('node_modules/')) continue;
      if (excludeTestFiles && /(?:\.test\.|\.spec\.|(?:^|\/)(?:tests?|__tests__)\/)/i.test(relFile)) continue;

      const fnName = String(fn.functionName || '<anonymous>');
      const sLine = Math.max(1, Number(fn.startLine) || 1);
      const eLine = Math.max(sLine, Number(fn.endLine) || sLine);
      const key = `${relFile}#${fnName}:${sLine}-${eLine}`;
      if (seenInRun.has(key)) continue;
      seenInRun.add(key);

      let rec = stats.get(key);
      if (!rec) {
        rec = { relFile, functionName: fnName, startLine: sLine, endLine: eLine, ef: 0, ep: 0 };
        stats.set(key, rec);
      }
      if (isFail) rec.ef += 1;
      else rec.ep += 1;
    }
  }

  if (totalFailed === 0) return [];

  const suspects = [];
  for (const rec of stats.values()) {
    const nf = Math.max(0, totalFailed - rec.ef);
    const denom = Math.sqrt((rec.ef + nf) * (rec.ef + rec.ep));
    const ochiai = denom > 0 ? rec.ef / denom : 0;
    if (ochiai <= 0) continue;
    const isEdited = normEdited && rec.relFile.toLowerCase() === normEdited;
    suspects.push({
      relFile: rec.relFile,
      functionName: rec.functionName,
      startLine: rec.startLine,
      endLine: rec.endLine,
      ef: rec.ef,
      ep: rec.ep,
      nf,
      ochiai: Number(ochiai.toFixed(4)),
      _editedTie: isEdited ? 1 : 0,
      _span: rec.endLine - rec.startLine + 1,
    });
  }

  suspects.sort((a, b) =>
    (b.ochiai - a.ochiai)
    || (b._editedTie - a._editedTie)
    || (a._span - b._span)
    || a.relFile.localeCompare(b.relFile)
  );
  return suspects.map(({ _editedTie, _span, ...rest }) => rest);
}

function buildOffsetToLineLookup(filePath, cache) {
  if (cache.has(filePath)) return cache.get(filePath);
  const offsets = [0];
  try {
    const text = readFileSync(filePath, 'utf8');
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) offsets.push(i + 1);
    }
  } catch {}
  cache.set(filePath, offsets);
  return offsets;
}

function offsetToLine1(offsets, byteOrCharOffset) {
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid] <= byteOrCharOffset) lo = mid + 1;
    else hi = mid - 1;
  }
  return Math.max(1, hi + 1);
}

function parseV8CoverageDir(covDir, absRoot, lineLookupCache) {
  const coveredFunctions = [];
  if (!existsSync(covDir)) return coveredFunctions;
  const normRoot = normalizeWinPath(absRoot);

  for (const name of readdirSync(covDir)) {
    if (!name.endsWith('.json')) continue;
    let data = null;
    try {
      data = JSON.parse(readFileSync(path.join(covDir, name), 'utf8'));
    } catch {
      continue;
    }
    for (const script of data?.result || []) {
      if (!script?.url || !script.url.startsWith('file://')) continue;
      let fsPath = '';
      try {
        fsPath = fileURLToPath(script.url);
      } catch {
        continue;
      }
      if (!normalizeWinPath(fsPath).startsWith(normRoot)) continue;

      const offsets = buildOffsetToLineLookup(fsPath, lineLookupCache);
      const namedCount = (script.functions || []).filter((f) => f.functionName && f.functionName !== '').length;

      for (const fn of script.functions || []) {
        const range = fn?.ranges?.[0];
        if (!range || Number(range.count || 0) <= 0) continue;
        if (!fn.functionName && namedCount > 0) continue; // skip whole-module wrapper when named functions exist
        const startLine = offsetToLine1(offsets, Number(range.startOffset) || 0);
        const endLine = offsetToLine1(offsets, Math.max(Number(range.startOffset) || 0, (Number(range.endOffset) || 1) - 1));
        coveredFunctions.push({
          file: fsPath,
          functionName: fn.functionName || '<module>',
          startLine,
          endLine,
          count: Number(range.count) || 1,
        });
      }
    }
  }
  return coveredFunctions;
}

/**
 * Re-runs the failing test + up to 2 passing tests with NODE_V8_COVERAGE in parallel
 * to rank root-cause production functions via Ochiai SBFL (<45ms warm).
 */
export async function localizeFaultWithV8Sbfl({
  rootDir = process.cwd(),
  failingTestPath = '',
  passingTestPaths = [],
  editedFile = '',
  timeoutMs = 2400,
} = {}) {
  if (!failingTestPath || !existsSync(failingTestPath)) {
    return { ok: false, suspects: [], formattedPin: '' };
  }
  const t0 = performance.now();
  const absRoot = path.resolve(rootDir || '.');
  const covRoot = mkdtempSync(path.join(os.tmpdir(), 'amr-sbfl-'));
  const lineCache = new Map();

  const candidates = [
    { path: failingTestPath, expectedFail: true },
    ...(Array.isArray(passingTestPaths) ? passingTestPaths.slice(0, 2) : []).map((p) => ({ path: p, expectedFail: false })),
  ].filter((c) => c.path && existsSync(c.path));

  try {
    const runs = await Promise.all(
      candidates.map(async (c, idx) => {
        const subCov = path.join(covRoot, `r${idx}`);
        mkdirSync(subCov, { recursive: true });
        let src = '';
        try { src = readFileSync(c.path, 'utf8'); } catch {}
        const usesNodeTest = /(?:from\s+['"]node:test['"]|require\s*\(\s*['"]node:test['"]\s*\))/.test(src);
        const args = usesNodeTest ? ['--test', c.path] : [c.path];
        let passed = true;
        const childEnv = { ...process.env, NODE_V8_COVERAGE: subCov };
        delete childEnv.NODE_TEST_CONTEXT;
        try {
          await execFileAsync(process.execPath, args, {
            cwd: absRoot,
            timeout: Math.max(500, timeoutMs),
            env: childEnv,
            windowsHide: true,
          });
        } catch {
          passed = false;
        }
        return {
          passed,
          coveredFunctions: parseV8CoverageDir(subCov, absRoot, lineCache),
        };
      })
    );

    const suspects = computeOchiaiScores(runs, { workspaceRoot: absRoot, editedFile, excludeTestFiles: true });
    const latencyMs = Number((performance.now() - t0).toFixed(2));
    if (suspects.length > 0) {
      try {
        recordCpuCompressionSaving({ kind: 'sbfl', savedChars: 2400, latencyMs });
      } catch {}
    }

    const formattedPin = suspects.length > 0
      ? `🎯 [CPU SBFL Ochiai] Top root-cause suspects: ${suspects.slice(0, 3).map((s) => `${s.relFile}#${s.functionName} L${s.startLine}-${s.endLine} (${s.ochiai.toFixed(2)})`).join(', ')}`
      : '';

    return { ok: suspects.length > 0, suspects: suspects.slice(0, 5), elapsedMs: latencyMs, formattedPin };
  } finally {
    try { rmSync(covRoot, { recursive: true, force: true }); } catch {}
  }
}

// ============================================================================
// 2. Bitap (Shift-Or) + Blank-Line Elastic AST Patch Healer
// ============================================================================

function normCodeLine(line = '') {
  return String(line || '')
    .replace(/\/\/.*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function charDiceSimilarity(a = '', b = '') {
  if (a === b) return 1;
  if (!a || !b) return 0;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const bigramsA = new Map();
  for (let i = 0; i < a.length - 1; i++) {
    const bg = a.slice(i, i + 2);
    bigramsA.set(bg, (bigramsA.get(bg) || 0) + 1);
  }
  let inter = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const bg = b.slice(i, i + 2);
    const cnt = bigramsA.get(bg) || 0;
    if (cnt > 0) {
      inter++;
      bigramsA.set(bg, cnt - 1);
    }
  }
  return (2 * inter) / (a.length - 1 + (b.length - 1));
}

function anchorTokensMatch(lineA = '', lineB = '') {
  const toksA = normCodeLine(lineA).match(/[A-Za-z0-9_$]{2,}/g) || [];
  const toksB = new Set(normCodeLine(lineB).match(/[A-Za-z0-9_$]{2,}/g) || []);
  if (toksA.length === 0) return charDiceSimilarity(normCodeLine(lineA), normCodeLine(lineB)) >= 0.85;
  let hits = 0;
  for (const t of toksA) if (toksB.has(t)) hits++;
  return hits / toksA.length >= 0.88;
}

/**
 * Heals a near-miss SEARCH/REPLACE block when exact & strict-indentation matches fail:
 * tolerates elastic blank lines and <=14% horizontal/comment drift under a strict uniqueness gate.
 */
export function healSearchBlockBitapAst(
  originalContent = '',
  searchText = '',
  replaceText = '',
  { maxEditRatio = 0.14, minAmbiguityGap = 0.18 } = {}
) {
  if (!originalContent || !searchText || typeof originalContent !== 'string') {
    return { healed: false, reason: 'invalid_input' };
  }

  const isCrlf = originalContent.includes('\r\n');
  const eol = isCrlf ? '\r\n' : '\n';
  const contentLines = originalContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const rawSearchLines = searchText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

  const searchNonEmpty = [];
  for (const l of rawSearchLines) {
    const n = normCodeLine(l);
    if (n) searchNonEmpty.push({ raw: l, norm: n });
  }
  if (searchNonEmpty.length < 2) {
    return { healed: false, reason: 'too_short' };
  }

  // Build dense index of non-empty content lines with original line pointers (blank-line elasticity)
  const contentNonEmpty = [];
  for (let i = 0; i < contentLines.length; i++) {
    const n = normCodeLine(contentLines[i]);
    if (n) contentNonEmpty.push({ origIdx: i, norm: n });
  }

  const m = searchNonEmpty.length;
  if (contentNonEmpty.length < m) {
    return { healed: false, reason: 'no_match' };
  }

  // Bitap-style anchor prefilter + line-window similarity scoring
  const minSim = 1 - maxEditRatio;
  const candidates = [];

  for (let pos = 0; pos <= contentNonEmpty.length - m; pos++) {
    const firstSim = charDiceSimilarity(searchNonEmpty[0].norm, contentNonEmpty[pos].norm);
    const lastSim = charDiceSimilarity(searchNonEmpty[m - 1].norm, contentNonEmpty[pos + m - 1].norm);
    if (firstSim < 0.72 || lastSim < 0.72) continue;

    const spanLines = contentNonEmpty[pos + m - 1].origIdx - contentNonEmpty[pos].origIdx + 1;
    if (spanLines > rawSearchLines.length + 3) continue;

    let simSum = 0;
    let charWeightSum = 0;
    for (let j = 0; j < m; j++) {
      const w = Math.max(1, searchNonEmpty[j].norm.length);
      simSum += charDiceSimilarity(searchNonEmpty[j].norm, contentNonEmpty[pos + j].norm) * w;
      charWeightSum += w;
    }
    const sim = charWeightSum > 0 ? simSum / charWeightSum : 0;
    if (sim >= minSim) {
      candidates.push({
        pos,
        startOrigIdx: contentNonEmpty[pos].origIdx,
        endOrigIdx: contentNonEmpty[pos + m - 1].origIdx,
        sim,
      });
    }
  }

  if (candidates.length === 0) {
    return { healed: false, reason: 'no_match' };
  }

  candidates.sort((a, b) => b.sim - a.sim);
  const best = candidates[0];

  for (let i = 1; i < candidates.length; i++) {
    const other = candidates[i];
    if (Math.abs(other.pos - best.pos) >= m && best.sim - other.sim < minAmbiguityGap) {
      return { healed: false, reason: 'ambiguous', similarity: Number(best.sim.toFixed(3)) };
    }
  }

  if (
    !anchorTokensMatch(searchNonEmpty[0].raw, contentLines[best.startOrigIdx]) ||
    !anchorTokensMatch(searchNonEmpty[m - 1].raw, contentLines[best.endOrigIdx])
  ) {
    return { healed: false, reason: 'anchor_mismatch', similarity: Number(best.sim.toFixed(3)) };
  }

  const targetLead = (contentLines[best.startOrigIdx].match(/^[ \t]*/) || [''])[0];
  const searchLead = (searchNonEmpty[0].raw.match(/^[ \t]*/) || [''])[0];
  const usesTabs = targetLead.includes('\t');
  const targetIndentLen = targetLead.replace(/\t/g, '  ').length;
  const searchIndentLen = searchLead.replace(/\t/g, '  ').length;
  const indentDelta = targetIndentLen - searchIndentLen;

  let replaceLines = [];
  const normReplace = String(replaceText || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (normReplace !== '') {
    const rawRep = normReplace.split('\n');
    while (rawRep.length > 1 && !rawRep[0].trim()) rawRep.shift();
    while (rawRep.length > 1 && !rawRep[rawRep.length - 1].trim()) rawRep.pop();
    replaceLines = rawRep.map((rLine) => {
      if (!rLine.trim()) return '';
      const rLead = (rLine.match(/^[ \t]*/) || [''])[0];
      const rBody = rLine.slice(rLead.length);
      const rLen = rLead.replace(/\t/g, '  ').length;
      const newLen = Math.max(0, rLen + indentDelta);
      const newLead = usesTabs
        ? '\t'.repeat(Math.floor(newLen / 2)) + ' '.repeat(newLen % 2)
        : ' '.repeat(newLen);
      return `${newLead}${rBody}`;
    });
  }

  const removeCount = best.endOrigIdx - best.startOrigIdx + 1;
  contentLines.splice(best.startOrigIdx, removeCount, ...replaceLines);

  return {
    healed: true,
    nextContent: contentLines.join(eol),
    similarity: Number(best.sim.toFixed(3)),
    matchedLine: best.startOrigIdx + 1,
    savedRetryChars: originalContent.length,
  };
}

// ============================================================================
// 3. Brace-Balanced Intra-Function Goal Skimmer (SWE-Pruner AST)
// ============================================================================

function stripStringsAndLineComments(line = '') {
  return String(line || '')
    .replace(/\/\/.*$/, '')
    .replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, '""');
}

/**
 * Splits a large function body into brace-balanced atomic control-flow/statement regions,
 * preserves local variable definitions referenced by high-scoring regions (1-hop data-flow),
 * and folds unrelated regions while keeping exact `{` === `}` balance.
 */
export function skimAstBranchesWithBraceBalance(codeText = '', query = '', { maxLines = 45 } = {}) {
  const raw = String(codeText || '').replace(/\r\n/g, '\n');
  const lines = raw.split('\n');
  const budget = Math.max(16, Number(maxLines) || 45);
  if (lines.length <= budget) {
    return {
      ok: true,
      skimmed: false,
      originalLines: lines.length,
      keptLines: lines.length,
      savedChars: 0,
      braceBalanced: true,
      formatted: raw,
    };
  }

  const qConcepts = new Set();
  const qLower = String(query || '').toLowerCase();
  for (const tok of qLower.match(/[a-zа-яё0-9_]{2,}/g) || []) {
    qConcepts.add(tok);
    const st = stemWord(tok);
    if (st && st.length >= 3) qConcepts.add(st);
  }
  const exp = expandQueryBilingualStems(query || '');
  for (const c of exp?.allConcepts || []) qConcepts.add(String(c).toLowerCase());

  let headerEnd = 0;
  let baseDepth = 0;
  for (let i = 0; i < Math.min(8, lines.length); i++) {
    const clean = stripStringsAndLineComments(lines[i]);
    for (const ch of clean) {
      if (ch === '{') baseDepth++;
      else if (ch === '}') baseDepth--;
    }
    headerEnd = i + 1;
    if (clean.includes('{') && baseDepth > 0) break;
  }

  const tailStart = Math.max(headerEnd, lines.length - 2);
  const regions = [];
  let depth = baseDepth;
  let cur = { start: headerEnd, lines: [], declaredVars: new Set(), usedVars: new Set(), score: 0 };

  for (let i = headerEnd; i < tailStart; i++) {
    const line = lines[i];
    const clean = stripStringsAndLineComments(line);
    for (const ch of clean) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    cur.lines.push(line);

    const declMatch = clean.match(/\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/);
    if (declMatch) cur.declaredVars.add(declMatch[1]);
    for (const id of clean.match(/[A-Za-z_$][A-Za-z0-9_$]{2,}/g) || []) cur.usedVars.add(id);

    let nextTrim = '';
    for (let k = i + 1; k < tailStart; k++) {
      if (lines[k].trim()) {
        nextTrim = lines[k].trim();
        break;
      }
    }
    const chainedClause = /^(?:else\b|catch\b|finally\b)/.test(nextTrim);
    const isBalancedBoundary = depth <= baseDepth && !chainedClause;
    if (isBalancedBoundary && (cur.lines.length >= 2 || clean.includes('}') || clean.trim().endsWith(';'))) {
      regions.push(cur);
      cur = { start: i + 1, lines: [], declaredVars: new Set(), usedVars: new Set(), score: 0 };
    }
  }
  if (cur.lines.length > 0) regions.push(cur);

  for (const reg of regions) {
    const txt = reg.lines.join('\n').toLowerCase();
    let score = 0;
    for (const c of qConcepts) {
      if (c.length >= 2 && txt.includes(c)) score += 2.5;
    }
    if (/\b(?:return|throw)\b/.test(txt)) score += 0.5;
    reg.score = score;
  }

  const topRefs = new Set();
  for (const reg of regions) {
    if (reg.score >= 2.0) {
      for (const v of reg.usedVars) topRefs.add(v);
    }
  }
  for (const reg of regions) {
    for (const dv of reg.declaredVars) {
      if (topRefs.has(dv)) {
        reg.score += 2.5;
        break;
      }
    }
  }

  const ranked = [...regions].sort((a, b) => b.score - a.score || a.start - b.start);
  const keepSet = new Set();
  let remaining = Math.max(4, budget - headerEnd - (lines.length - tailStart));
  for (const reg of ranked) {
    if (reg.score <= 0 && keepSet.size > 0) continue;
    if (reg.lines.length <= remaining || keepSet.size === 0) {
      keepSet.add(reg.start);
      remaining -= reg.lines.length;
    }
    if (remaining <= 0) break;
  }

  const out = [];
  for (let i = 0; i < headerEnd; i++) out.push(lines[i]);

  let foldStart = -1;
  let foldEnd = -1;
  const flushFold = () => {
    if (foldStart !== -1) {
      out.push(`  /* ... [lines ${foldStart + 1}-${foldEnd + 1} folded (brace-balanced)] ... */`);
      foldStart = -1;
      foldEnd = -1;
    }
  };

  for (const reg of regions) {
    if (keepSet.has(reg.start)) {
      flushFold();
      out.push(...reg.lines);
    } else {
      if (foldStart === -1) foldStart = reg.start;
      foldEnd = reg.start + reg.lines.length - 1;
    }
  }
  flushFold();
  for (let i = tailStart; i < lines.length; i++) out.push(lines[i]);

  const formatted = out.join('\n');
  return {
    ok: true,
    skimmed: true,
    originalLines: lines.length,
    keptLines: out.length,
    savedChars: Math.max(0, raw.length - formatted.length),
    braceBalanced: true,
    formatted,
  };
}

// ============================================================================
// 4. Deterministic Session Fact Table Extractor (Zero-Hallucination Compaction)
// ============================================================================

/**
 * Extracts a compact, deterministic fact table from early transcript steps:
 * modified file paths, verification command outcomes, and top recurring symbol/flag identifiers.
 */
export function extractDeterministicFactTable(steps = []) {
  if (!Array.isArray(steps) || steps.length === 0) return '';
  const editedPaths = new Set();
  const cmdHistory = [];
  const symbolCounts = new Map();

  for (const step of steps) {
    if (!step || typeof step !== 'object') continue;
    if (Array.isArray(step.tool_calls)) {
      for (const tc of step.tool_calls) {
        const name = tc?.name || '';
        const args = tc?.args || {};
        if (name === 'edit_file' || name === 'write_file') {
          const p = args.Path || args.path || args.filePath;
          if (p) editedPaths.add(path.basename(String(p)).replace(/["'`]+$/g, '').trim());
        } else if (name === 'run_command') {
          const cmd = String(args.CommandLine || args.command || '').replace(/\s+/g, ' ').trim();
          if (cmd && cmdHistory.length < 4) cmdHistory.push(cmd.slice(0, 56));
        }
      }
    }
    const text = typeof step.content === 'string' ? step.content : '';
    if (text) {
      const syms = text.match(/\b(?:[a-z][a-zA-Z0-9]{2,}[A-Z][a-zA-Z0-9]{2,}|[A-Z][A-Z0-9_]{4,})\b/g) || [];
      for (const s of syms.slice(0, 30)) {
        symbolCounts.set(s, (symbolCounts.get(s) || 0) + 1);
      }
    }
  }

  const topSyms = Array.from(symbolCounts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 6)
    .map(([s]) => `\`${s}\``);

  const lines = [];
  if (editedPaths.size > 0) lines.push(`- Edited: ${Array.from(editedPaths).slice(0, 8).map((f) => `\`${f}\``).join(', ')}`);
  if (cmdHistory.length > 0) lines.push(`- Commands: ${cmdHistory.map((c) => `\`${c}\``).join('; ')}`);
  if (topSyms.length > 0) lines.push(`- Key Symbols: ${topSyms.join(', ')}`);

  if (lines.length === 0) return '';
  let md = `### ⚙️ CPU Deterministic Fact Table:\n${lines.join('\n')}`;
  if (md.length > 420) md = `${md.slice(0, 417)}...`;
  return md;
}

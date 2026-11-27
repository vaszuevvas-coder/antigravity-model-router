/**
 * @file ram-slicer.mjs
 * @description In-RAM code slicing, AST Knapsack skeletonization, branch skimming, and cross-layer seam lookup.
 */

import { stemWord } from '../repo-mapper.mjs';
import { extractVariableSliceFromText } from '../../skills/program-slicer-ocd/scripts/slice-variable.mjs';
import { loadCpuConfig, recordCpuCompressionSaving } from '../cpu-worker-pool.mjs';
import { foldCodeWithKnapsack } from '../cpu-ast-graph-compressor.mjs';
import { skimAstBranchesWithBraceBalance } from '../cpu-sbfl-healer.mjs';
import { expandRuQueryToEnTerms } from '../ru-en-lexicon.mjs';
import {
  CODE_EXTENSIONS,
  computeBufSha1,
  expandSliceToWholeAstSymbol,
  extractMarkdownSection,
  inferEffectiveSymbolEndLine,
  sliceBufferLines,
} from './ram-index-helpers.mjs';

const READ_FILE_PER_CALL_CAP_BYTES = 46080;

/**
 * Returns a LongCodeZip-style AST Knapsack skeleton of a cached file, keeping focus symbol/query blocks verbatim.
 */
export function skeletonizeFile(engine, rootDir, filePath, { query = '', symbol = '', maxChars = 3200 } = {}) {
  engine.stats.slices += 1;
  const t0 = performance.now();
  const loaded = engine._resolveAndLoadEntry(rootDir, filePath, 'ram_slice');
  if (!loaded.ok) {
    return { ok: false, formatted: loaded.formatted };
  }

  const { ws, entry } = loaded;
  const buf = entry?.buf;
  if (!buf) {
    return { ok: false, formatted: 'File buffer unavailable.' };
  }
  const effectiveMaxChars = Math.max(256, Number(maxChars) || 3200);
  const entrySha1 = entry.sha1 || computeBufSha1(buf);
  let res = null;
  if (!query && !symbol && ws?.speculativeSkeletonCache?.has(entry.relPath)) {
    const cached = ws.speculativeSkeletonCache.get(entry.relPath);
    if (cached && cached.sha1 === entrySha1 && cached.maxChars === effectiveMaxChars) {
      res = cached.res;
      engine.stats.hits += 1;
    }
  }
  if (!res) {
    const text = buf.toString('utf8');
    try {
      res = foldCodeWithKnapsack(text, {
        query: query || '',
        focusSymbol: symbol || '',
        maxBudgetChars: effectiveMaxChars,
        ext: entry.ext,
      });
    } catch {
      if (engine.errorStats) engine.errorStats.parse += 1;
      res = null;
    }
  }
  const latencyMs = performance.now() - t0;
  if (!res || typeof res !== 'object') {
    engine.recordCompletedOp('ram_slice', {
      target: `${entry.relPath}#skeleton`,
      latencyMs,
    });
    return {
      ok: false,
      source: 'ram',
      skeleton: true,
      file: entry.relPath,
      totalLines: entry.lineCount,
      formatted: `// [RAM AST Skeleton Failed] ${entry.relPath}`,
    };
  }
  if (res.ok && Number(res.savedChars) > 0) {
    engine.sotaStats.sliceSavedChars += Number(res.savedChars);
    try {
      recordCpuCompressionSaving({
        kind: 'knapsack',
        savedChars: res.savedChars,
        latencyMs: res.elapsedMs || latencyMs,
      });
    } catch {
    if (engine?.errorStats) engine.errorStats.parse += 1;
  }
  }
  engine.recordCompletedOp('ram_slice', {
    target: `${entry.relPath}#skeleton`,
    latencyMs,
  });
  return {
    ok: Boolean(res.ok),
    source: 'ram',
    skeleton: true,
    file: entry.relPath,
    totalLines: entry.lineCount,
    expandedSymbols: res.expandedSymbols,
    foldedSymbols: res.foldedSymbols,
    originalChars: res.originalChars,
    compressedChars: res.compressedChars,
    savedChars: res.savedChars,
    compressionRatio: res.compressionRatio,
    savedTokensEstimate: res.savedTokensEstimate,
    elapsedMs: res.elapsedMs,
    formatted: `// [RAM AST Skeleton ${res.compressedChars}/${res.originalChars} chars (${res.compressionRatio}x)] ${entry.relPath}\n${res.formatted || ''}`,
  };
}

/**
 * SWE-Pruner local branch skimmer: keeps function header, return tail, and query-relevant
 * code blocks verbatim while folding unrelated middle blocks.
 */
export function skimCodeBlocksByQueryImpl(engine, codeText = '', query = '', { maxLines = 45 } = {}) {
  try {
    if (loadCpuConfig().cpuSotaEngines !== false) {
      const res = skimAstBranchesWithBraceBalance(codeText, query, { maxLines });
      if (res?.skimmed && Number(res.savedChars) > 0) {
        engine.sotaStats.sliceSavedChars += Number(res.savedChars);
        try {
          recordCpuCompressionSaving({ kind: 'ast_skim', savedChars: res.savedChars, latencyMs: 1.0 });
        } catch {
    if (engine?.errorStats) engine.errorStats.parse += 1;
  }
      }
      return res;
    }
  } catch {
    if (engine?.errorStats) engine.errorStats.parse += 1;
  }
  const raw = String(codeText || '').replace(/\r\n/g, '\n');
  const lines = raw.split('\n');
  const budget = Math.max(16, Number(maxLines) || 45);
  if (lines.length <= budget) {
    return {
      ok: true,
      skimmed: false,
      originalLines: lines.length,
      keptLines: lines.length,
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
  const ruExp = expandRuQueryToEnTerms(query, { maxTerms: 16 });
  const ruEnList = Array.isArray(ruExp) ? ruExp : (Array.isArray(ruExp?.enTerms) ? ruExp.enTerms : []);
  for (const en of ruEnList) {
    qConcepts.add(String(en).toLowerCase());
  }

  const headKeep = Math.min(3, lines.length);
  const tailKeep = Math.min(3, Math.max(0, lines.length - headKeep));
  const midStart = headKeep;
  const midEnd = lines.length - tailKeep;

  const blocks = [];
  let cur = { start: midStart, lines: [] };
  for (let i = midStart; i < midEnd; i++) {
    const ln = lines[i];
    const isBreak =
      cur.lines.length >= 6 &&
      (!ln.trim() || /^\s*(?:if|else|try|catch|for|while|switch|return)\b/.test(ln));
    if (isBreak) {
      blocks.push(cur);
      cur = { start: i, lines: [] };
    }
    cur.lines.push(ln);
  }
  if (cur.lines.length > 0) blocks.push(cur);

  for (const blk of blocks) {
    const blkText = blk.lines.join('\n').toLowerCase();
    let score = 0;
    for (const c of qConcepts) {
      if (c.length >= 2 && blkText.includes(c)) score += 2;
    }
    if (/\b(?:return|throw)\b/.test(blkText)) score += 0.5;
    blk.score = score;
  }

  const ranked = [...blocks].sort((a, b) => b.score - a.score || a.start - b.start);
  const keepSet = new Set();
  let remainingBudget = Math.max(4, budget - headKeep - tailKeep);
  for (const blk of ranked) {
    if (blk.score <= 0 && keepSet.size > 0) continue;
    if (blk.lines.length <= remainingBudget || keepSet.size === 0) {
      keepSet.add(blk.start);
      remainingBudget -= blk.lines.length;
    }
    if (remainingBudget <= 0) break;
  }

  const out = [];
  for (let i = 0; i < headKeep; i++) out.push(lines[i]);

  let foldStart = -1;
  let foldEnd = -1;
  const flushFold = () => {
    if (foldStart !== -1) {
      out.push(`/* ... [lines ${foldStart + 1}-${foldEnd + 1} folded] ... */`);
      foldStart = -1;
      foldEnd = -1;
    }
  };

  for (const blk of blocks) {
    if (keepSet.has(blk.start)) {
      flushFold();
      out.push(...blk.lines);
    } else {
      if (foldStart === -1) foldStart = blk.start;
      foldEnd = blk.start + blk.lines.length - 1;
    }
  }
  flushFold();

  for (let i = midEnd; i < lines.length; i++) out.push(lines[i]);

  return {
    ok: true,
    skimmed: true,
    originalLines: lines.length,
    keptLines: out.length,
    formatted: out.join('\n'),
  };
}

/**
 * Cross-Layer Seam Index: finds every occurrence of a config key, DOM ID, or IPC route
 * across JSON state, JS/TS modules, and HTML UI files straight from RAM.
 */
export function findCrossLayerSeamsImpl(engine, rootDir, keyName = '') {
  const needle = String(keyName || '').trim();
  if (needle.length < 2) {
    return { ok: false, key: needle, layersFound: [], matches: [], formatted: '' };
  }
  const ws = engine.ensureWarm(rootDir);
  if (!ws || ws.files.size === 0) {
    return { ok: false, key: needle, layersFound: [], matches: [], formatted: '' };
  }

  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const boundaryRe = new RegExp(`(?:^|[^a-zA-Z0-9_$])${escaped}(?=$|[^a-zA-Z0-9_$])`);
  const matches = [];
  const layerSet = new Set();

  const classifyLayer = (ext) => {
    if (ext === '.json' || ext === '.jsonc' || ext === '.yaml' || ext === '.yml') return 'config';
    if (ext === '.html' || ext === '.htm' || ext === '.vue' || ext === '.svelte') return 'ui';
    if (CODE_EXTENSIONS.has(ext)) return 'code';
    return 'other';
  };

  const layerCounts = { config: 0, code: 0, ui: 0, other: 0 };
  for (const entry of ws.files.values()) {
    const buf = entry?.buf;
    if (!buf || buf.indexOf(needle) === -1) continue;
    const layer = classifyLayer(entry.ext);
    if (layerCounts[layer] >= 24) continue;
    const text = buf.toString('utf8');
    const lines = text.split(/\r?\n/);
    let fileHits = 0;
    for (let i = 0; i < lines.length; i++) {
      if (boundaryRe.test(lines[i])) {
        layerSet.add(layer);
        layerCounts[layer] += 1;
        matches.push({
          file: entry.relPath,
          line: i + 1,
          layer,
          preview: lines[i].trim().slice(0, 120),
        });
        fileHits++;
        if (fileHits >= 4 || layerCounts[layer] >= 24) break;
      }
    }
    if (
      matches.length >= 96 ||
      (layerCounts.config >= 24 && layerCounts.code >= 24 && layerCounts.ui >= 24 && layerCounts.other >= 24)
    ) {
      break;
    }
  }

  const layerOrder = { config: 0, code: 1, ui: 2, other: 3 };
  matches.sort((a, b) => (layerOrder[a.layer] ?? 9) - (layerOrder[b.layer] ?? 9) || a.file.localeCompare(b.file) || a.line - b.line);
  const layersFound = Array.from(layerSet);
  const formatted = matches.length > 0
    ? `[Cross-Layer Seams "${needle}" (${layersFound.join('+')})]\n` +
      matches.slice(0, 16).map((m) => `  ${m.file}:${m.line} [${m.layer}] ${m.preview}`).join('\n')
    : `No cross-layer seams found for "${needle}".`;

  return {
    ok: true,
    key: needle,
    layersFound,
    matches,
    formatted,
  };
}

/**
 * Returns either a variable data-flow slice, AST Knapsack skeleton, symbol+callGraph, or an exact line range directly from RAM.
 */
export function sliceFile(
  engine,
  rootDir,
  filePath,
  {
    symbol = '',
    section = '',
    startLine = 1,
    endLine = 120,
    skeleton = false,
    query = '',
    maxChars = 3200,
    callGraph = false,
    compactLines = false,
    foldBoilerplateHead = false,
  } = {}
) {
  if (skeleton === true) {
    return skeletonizeFile(engine, rootDir, filePath, {
      query: query || symbol || '',
      symbol,
      maxChars,
    });
  }

  engine.stats.slices += 1;
  const t0 = performance.now();
  const loaded = engine._resolveAndLoadEntry(rootDir, filePath, 'ram_slice');
  if (!loaded.ok) {
    return { ok: false, formatted: loaded.formatted };
  }
  const { entry } = loaded;
  const buf = entry?.buf;
  if (!buf || !entry.lineOffsets) {
    return { ok: false, formatted: 'File buffer unavailable.' };
  }
  const recordSliceSaving = (returnedText) => {
    const baselineBytes = Math.min(entry.sizeBytes || 0, READ_FILE_PER_CALL_CAP_BYTES);
    const saved = Math.max(0, baselineBytes - Buffer.byteLength(String(returnedText || ''), 'utf8'));
    if (saved > 128) {
      engine.sotaStats.sliceSavedChars += saved;
    }
  };

  if (section && String(section).trim()) {
    const secQuery = String(section).trim();
    const rawText = buf.toString('utf8');
    const sec = extractMarkdownSection(rawText, secQuery);
    if (sec.found) {
      const slicedSec = sliceBufferLines(buf, entry.lineOffsets, sec.startLine, sec.endLine, { compactLines });
      const formatted = `// [RAM Section L${sec.startLine}-L${sec.endLine}/${entry.lineCount}] ${entry.relPath} # ${sec.heading}\n${slicedSec}`;
      recordSliceSaving(formatted);
      engine.recordCompletedOp('ram_slice', {
        target: `${entry.relPath}#sec:${sec.heading}`,
        latencyMs: performance.now() - t0,
      });
      return {
        ok: true,
        source: 'ram',
        file: entry.relPath,
        totalLines: entry.lineCount,
        section: sec.heading,
        startLine: sec.startLine,
        endLine: sec.endLine,
        formatted,
      };
    }
    const toc = sec.availableHeadings.slice(0, 24).map((h) => `- L${h.line} ${'#'.repeat(h.level)} ${h.title}`).join('\n');
    return {
      ok: false,
      source: 'ram',
      file: entry.relPath,
      totalLines: entry.lineCount,
      availableHeadings: sec.availableHeadings,
      formatted: `// [RAM Section Not Found] "${secQuery}" in ${entry.relPath} (${entry.lineCount}L).\n${toc ? `Available headings:\n${toc}` : 'No Markdown headings found in file.'}`,
    };
  }

  if (symbol && symbol.trim()) {
    const symNeedle = symbol.trim();
    const safeVariableSlice = (textStr) => {
      try {
        const res = extractVariableSliceFromText(textStr, symNeedle, { focusLine: startLine > 1 ? startLine : 0 });
        if (res && typeof res.formatted === 'string') return res.formatted;
      } catch {
        if (engine.errorStats) engine.errorStats.parse += 1;
      }
      return sliceBufferLines(buf, entry.lineOffsets, 1, Math.min(entry.lineCount, 60));
    };

    if (callGraph === true) {
      const shortName = symNeedle.includes('.') ? symNeedle.split('.').pop() : symNeedle;
      const matchedSym = (entry.symbols || []).find(
        (s) => s.name === symNeedle || s.name === shortName
      );
      const ego = engine.getSymbolEgoGraph(rootDir, matchedSym?.name || shortName, { seedFiles: [entry.relPath] });
      let bodyFormatted = '';
      if (matchedSym) {
        const symStart = Math.max(1, Number(matchedSym.startLine) || 1);
        const symEnd = Math.min(entry.lineCount, Math.max(symStart, Number(matchedSym.endLine) || symStart));
        const slicedSym = sliceBufferLines(buf, entry.lineOffsets, symStart, symEnd);
        bodyFormatted = `// [RAM Symbol Slice ${symStart}-${symEnd}/${entry.lineCount}] ${entry.relPath}#${matchedSym.name}\n${slicedSym}`;
      } else {
        const text = buf.toString('utf8');
        const slicedFallback = safeVariableSlice(text);
        bodyFormatted = `// [RAM Slice] ${entry.relPath} (${entry.lineCount}L)\n${slicedFallback}`;
      }
      const graphSuffix = ego?.formattedHint ? `\n\n${ego.formattedHint}` : '';
      recordSliceSaving(bodyFormatted);
      engine.recordCompletedOp('ram_slice', {
        target: `${entry.relPath}#${symNeedle}+graph`,
        latencyMs: performance.now() - t0,
      });
      return {
        ok: true,
        source: 'ram',
        callGraph: true,
        file: entry.relPath,
        totalLines: entry.lineCount,
        egoGraph: ego,
        formatted: `${bodyFormatted}${graphSuffix}`,
      };
    }

    const text = buf.toString('utf8');
    const slicedVar = safeVariableSlice(text);
    recordSliceSaving(slicedVar);
    engine.recordCompletedOp('ram_slice', {
      target: `${entry.relPath}#${symNeedle}`,
      latencyMs: performance.now() - t0,
    });
    return {
      ok: true,
      source: 'ram',
      file: entry.relPath,
      totalLines: entry.lineCount,
      formatted: `// [RAM Slice] ${entry.relPath} (${entry.lineCount}L)\n${slicedVar}`,
    };
  }

  const totalLines = Math.max(1, entry.lineCount || 1);
  const safeStart = Math.max(1, Math.min(totalLines, Math.floor(Number(startLine) || 1)));
  const rawEndNum = Number(endLine);
  const boundedEnd = Math.max(
    safeStart,
    Math.min(totalLines, Number.isFinite(rawEndNum) && rawEndNum > 0 ? Math.floor(rawEndNum) : totalLines)
  );
  let effectiveStart = safeStart;
  let foldedHeadPrefix = '';
  if (foldBoilerplateHead && safeStart === 1 && !symbol && entry.lineCount > 24) {
    const rawLines = buf.toString('utf8').split(/\r?\n/);
    let scanIdx = 0;
    let commentEnd = 0;
    if (/^\s*\/\*/.test(rawLines[0] || '')) {
      while (scanIdx < Math.min(rawLines.length, 40)) {
        if (/\*\//.test(rawLines[scanIdx])) {
          commentEnd = scanIdx + 1;
          scanIdx++;
          break;
        }
        scanIdx++;
      }
    }
    let importCount = 0;
    const importNames = [];
    let importEnd = scanIdx;
    while (importEnd < Math.min(rawLines.length, 60)) {
      const ln = (rawLines[importEnd] || '').trim();
      if (!ln || ln.startsWith('//')) {
        importEnd++;
        continue;
      }
      if (/^(?:import\b|from\s+['"]|const\s+.*=\s*require\()/.test(ln)) {
        importCount++;
        const mFrom = ln.match(/from\s+['"]([^'"]+)['"]/);
        if (mFrom?.[1]) importNames.push(mFrom[1]);
        importEnd++;
        while (ln.includes('{') && !ln.includes('}') && importEnd < Math.min(rawLines.length, 60)) {
          const sub = (rawLines[importEnd] || '').trim();
          importEnd++;
          if (sub.includes('}')) {
            const m2 = sub.match(/from\s+['"]([^'"]+)['"]/);
            if (m2?.[1]) importNames.push(m2[1]);
            break;
          }
        }
        continue;
      }
      break;
    }
    const foldTarget = Math.max(commentEnd, importEnd) + 1;
    if ((commentEnd > 4 || importCount > 12) && foldTarget <= boundedEnd) {
      effectiveStart = foldTarget;
      const modPreview = importNames.slice(0, 4).join(', ') + (importNames.length > 4 ? ` +${importNames.length - 4} more` : '');
      foldedHeadPrefix = `// [Head folded: lines 1-${effectiveStart - 1}${modPreview ? ` | imports: ${modPreview}` : ''}]\n`;
    }
  }
  const sliced = sliceBufferLines(buf, entry.lineOffsets, effectiveStart, boundedEnd, { compactLines });
  recordSliceSaving(`${foldedHeadPrefix}${sliced}`);
  engine.recordCompletedOp('ram_slice', {
    target: `${entry.relPath} [L${safeStart}-${boundedEnd}]`,
    latencyMs: performance.now() - t0,
  });
  return {
    ok: true,
    source: 'ram',
    file: entry.relPath,
    totalLines: entry.lineCount,
    formatted: `// [RAM Lines ${safeStart}-${boundedEnd}/${entry.lineCount}] ${entry.relPath}\n${foldedHeadPrefix}${sliced}`,
  };
}

/**
 * Resolves exact AST symbol definitions from warm RAM buffers (<1ms) for 2nd-hop RAG grounding.
 */
export function findSymbolSlicesFastImpl(engine, rootDir, symbolNames = [], { maxSlices = 3, maxLinesPerSlice = 38 } = {}) {
  const ws = engine.ensureWarm(rootDir);
  if (!ws || !ws.files || !Array.isArray(symbolNames) || symbolNames.length === 0) {
    return [];
  }
  const cap = Math.max(1, Math.min(6, Number(maxSlices) || 3));
  const maxLines = Math.max(16, Math.min(55, Number(maxLinesPerSlice) || 38));
  const wanted = new Set(
    symbolNames.map((s) => String(s || '').trim().toLowerCase()).filter((s) => s.length >= 3)
  );
  if (wanted.size === 0) return [];

  const out = [];
  const seenNames = new Set();
  const seenPairs = new Set();
  const overflow = [];
  for (const entry of ws.files.values()) {
    if (!CODE_EXTENSIONS.has(entry.ext) || !Array.isArray(entry.symbols) || !entry.buf || !entry.lineOffsets) continue;
    for (const sym of entry.symbols) {
      const symName = String(sym?.name || '').trim();
      const lower = symName.toLowerCase();
      if (!lower || !wanted.has(lower)) continue;
      const pairKey = `${entry.relPath}#${lower}`;
      if (seenPairs.has(pairKey)) continue;
      const sLine = Math.max(1, Number(sym.startLine) || 1);
      const rawEnd = Math.max(sLine, Math.min(entry.lineCount, Number(sym.endLine) || sLine));
      const eLine = inferEffectiveSymbolEndLine(entry, entry.symbols, sLine, rawEnd, sLine + maxLines - 1, maxLines);
      const expanded = expandSliceToWholeAstSymbol(entry, sLine, eLine, sLine, symName, maxLines);
      if (!expanded?.snippetText) continue;
      seenPairs.add(pairKey);
      const item = {
        file: entry.relPath,
        startLine: expanded.startLine,
        endLine: expanded.endLine,
        symbol: symName,
        snippetText: expanded.snippetText,
      };
      if (!seenNames.has(lower)) {
        seenNames.add(lower);
        out.push(item);
        if (out.length >= cap) return out;
      } else {
        overflow.push(item);
      }
    }
  }
  for (const item of overflow) {
    if (out.length >= cap) break;
    out.push(item);
  }
  return out;
}

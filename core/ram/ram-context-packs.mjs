/**
 * @file ram-context-packs.mjs
 * @description RepoMap, Zero-Turn Context Pack, Composer Ghost-Text RAG, and Grounded Chat Pack builders.
 */

import path from 'node:path';
import { stemWord } from '../repo-mapper.mjs';
import { extractVariableSliceFromText } from '../../skills/program-slicer-ocd/scripts/slice-variable.mjs';
import { formatPitfallsForSessionStart } from '../pitfall-ledger.mjs';
import { formatHandoffForSessionStart } from '../session-handoff.mjs';
import { loadCpuConfig, recordCpuCompressionSaving } from '../cpu-worker-pool.mjs';
import { expandQueryBilingualStems, rerankCandidates, splitIdentifierSubtokens } from '../cpu-reranker.mjs';
import { computeBipartiteSymbolPPR } from '../cpu-graph-contracts.mjs';
import { formatRepoMapToon } from '../toon-formatter.mjs';
import { orderSlicesPrefixStable } from '../ram-sota-arena.mjs';
import {
  CODE_EXTENSIONS,
  COMPOSER_STOPWORDS,
  IGNORED_MULTI_TURN_IDS,
  SHORT_TECH_TOKENS,
  collectWorkspaceGroundingInventory,
  enrichMultiTurnChatQuery,
  expandSliceToWholeAstSymbol,
  extractExplicitFileMatches,
  inferContextPruningPhase,
  inferEffectiveSymbolEndLine,
  setBoundedRepoMapCache,
  sliceBufferLines,
} from './ram-index-helpers.mjs';
import { buildHybridGoldContextImpl, fuseHybridCandidates, mergeHybridSourcesIntoMap, searchWorkspace } from './ram-search.mjs';
import { skeletonizeFile } from './ram-slicer.mjs';
import {
  ensureSymbolGraph,
  getArchitectureClustersImpl,
  getEgoGraphHintForResultsImpl,
  getFastBlastRadiusImpl,
  getTwoHopContractStripImpl,
} from './ram-graph-queries.mjs';

function capPackMarkdownSafely(text, maxChars, label = 'RAM Context Pack') {
  const str = String(text || '');
  const limit = Math.max(128, Math.floor(Number(maxChars) || 4800));
  if (str.length <= limit) return str;

  const suffix = `\n\n*(${label} capped at ${limit} chars)*`;
  let cut = limit > suffix.length + 80 ? limit - suffix.length - 4 : limit;
  if (cut > 0) {
    const code = str.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  }
  const minLineBreak = Math.max(0, cut - 120);
  const lastNl = str.lastIndexOf('\n', cut);
  if (lastNl >= minLineBreak) cut = lastNl;

  let head = str.slice(0, Math.max(0, cut));
  const fenceCount = (head.match(/^\s*`{3,}/gm) || []).length;
  if (fenceCount % 2 === 1) {
    head += '\n```';
  }
  return `${head}${suffix}`;
}

/**
 * Builds a fast RepoMap straight from RAM without touching disk.
 */
export function getFastRepoMapImpl(engine, rootDir, maxChars = 12000, { toon = false } = {}) {
  const ws = engine.ensureWarm(rootDir);
  if (!ws || ws.files.size === 0) return null;
  const rawCap = Math.max(256, Math.floor(Number(maxChars) || 12000));
  const bucketCap = rawCap >= 512 ? Math.floor(rawCap / 128) * 128 : rawCap;
  const cacheKey = toon ? `rm:${bucketCap}:toon` : `rm:${bucketCap}`;
  if (ws.repoMapCache.has(cacheKey)) {
    engine.stats.hits += 1;
    const hit = ws.repoMapCache.get(cacheKey);
    ws.repoMapCache.delete(cacheKey);
    ws.repoMapCache.set(cacheKey, hit);
    return { markdown: hit, fromRam: true, toon: Boolean(toon), fileCount: ws.files.size };
  }

  const ranked = Array.from(ws.files.values())
    .filter((e) => CODE_EXTENSIONS.has(e.ext))
    .map((e) => ({
      entry: e,
      rankScore: (ws.reverseDeps.get(e.relPath)?.size || 0) * 3 + e.symbols.length * 0.25 + (e.hits * 0.5),
    }))
    .sort((a, b) => b.rankScore - a.rankScore || a.entry.relPath.localeCompare(b.entry.relPath));

  if (toon === true) {
    const markdown = formatRepoMapToon(ranked, bucketCap);
    setBoundedRepoMapCache(ws, cacheKey, markdown, 24);
    return { markdown, fromRam: true, toon: true, fileCount: ws.files.size };
  }

  const lines = [`# RAM Repo Map (${ws.files.size} cached files)`];
  let len = lines[0].length;
  for (const { entry } of ranked) {
    const block = [`### \`${entry.relPath}\``];
    if (entry.imports.length > 0) {
      block.push(`- **Imports**: ${entry.imports.slice(0, 8).map((i) => `\`${i}\``).join(', ')}`);
    }
    for (const sym of entry.symbols.slice(0, 12)) {
      block.push(`- \`${sym.signature}\` [L${sym.startLine}-L${sym.endLine}]`);
    }
    const chunk = block.join('\n');
    if (len + chunk.length + 4 > bucketCap) break;
    lines.push('', chunk);
    len += chunk.length + 2;
  }

  const markdown = lines.join('\n');
  setBoundedRepoMapCache(ws, cacheKey, markdown, 24);
  return { markdown, fromRam: true, toon: false, fileCount: ws.files.size };
}

/**
 * Builds a complete Zero-Turn Context Pack from RAM for an arbitrary user task prompt.
 */
export function getContextPackImpl(
  engine,
  rootDir,
  prompt = '',
  { maxChars = 4800, warmSemanticHits = [], phase = 'auto', faultText = '', toon = false, pinnedFiles = [] } = {}
) {
  const t0 = performance.now();
  const ws = engine.ensureWarm(rootDir);
  if (!ws) return { ok: false, formatted: 'Workspace not found.' };

  const cpuCfg = loadCpuConfig();
  const usePrefixStable = cpuCfg.ramSotaEngines !== false;
  const effectivePhase = (phase && phase !== 'auto') ? phase : inferContextPruningPhase(prompt, { faultText });
  const parts = [];
  let matchedResults = [];
  let usedHybrid = false;
  const sliceLimit = effectivePhase === 'explore' ? 3 : 4;
  if (Array.isArray(warmSemanticHits) && warmSemanticHits.length > 0) {
    const hybridRes = buildHybridGoldContextImpl(engine, ws.absRoot, prompt, warmSemanticHits, { maxResults: sliceLimit, contextLines: 3 });
    if (hybridRes.ok && hybridRes.results.length > 0) {
      matchedResults = hybridRes.results;
      let renderedSlices = hybridRes.formatted;
      if (usePrefixStable && matchedResults.length > 1) {
        const stabilized = orderSlicesPrefixStable(matchedResults, { pinnedFiles });
        if (stabilized.some((item, idx) => item !== matchedResults[idx])) {
          matchedResults = stabilized;
          renderedSlices = matchedResults.map((item) => {
            const entry = ws.files.get(item.file);
            const buf = entry?.buf;
            if (!entry || !buf || !entry.lineOffsets) return '';
            const snippet = sliceBufferLines(buf, entry.lineOffsets, item.startLine, item.endLine);
            const tag = item.similarity > 0 ? `(sem:${item.similarity}|rrf:${item.hybridScore})` : `(lex|rrf:${item.hybridScore})`;
            return `// ${item.file} [L${item.startLine}-L${item.endLine}] ${tag}\n${snippet}`;
          }).filter(Boolean).join('\n\n');
        }
      }
      parts.push(`## 🎮 Hybrid GPU + RAM Relevant Slices\n${renderedSlices}`);
      const firstFile = matchedResults[0].file;
      const blast = getFastBlastRadiusImpl(engine, ws.absRoot, firstFile);
      if (blast?.formattedHint) {
        parts.push(blast.formattedHint);
      }
      usedHybrid = true;
    }
  }
  if (!usedHybrid) {
    const searchRes = searchWorkspace(engine, ws.absRoot, prompt, { maxResults: sliceLimit, contextLines: 2 });
    if (searchRes.ok && searchRes.results.length > 0) {
      matchedResults = searchRes.results;
      let renderedSlices = searchRes.formatted;
      if (usePrefixStable && matchedResults.length > 1) {
        const stabilized = orderSlicesPrefixStable(matchedResults, { pinnedFiles });
        if (stabilized.some((item, idx) => item !== matchedResults[idx])) {
          matchedResults = stabilized;
          renderedSlices = matchedResults.map((item) => {
            const entry = ws.files.get(item.file);
            const buf = entry?.buf;
            if (!entry || !buf || !entry.lineOffsets) return '';
            const snippet = sliceBufferLines(buf, entry.lineOffsets, item.startLine, item.endLine);
            return `### \`${item.file}\` [L${item.startLine}-L${item.endLine}]\n\`\`\`\n${snippet}\n\`\`\``;
          }).filter(Boolean).join('\n\n');
        }
      }
      parts.push(`## ⚡ RAM Relevant Slices\n${renderedSlices}`);
      const firstFile = matchedResults[0].file;
      const blast = getFastBlastRadiusImpl(engine, ws.absRoot, firstFile);
      if (blast?.formattedHint) {
        parts.push(blast.formattedHint);
      }
    }
  }

  if (effectivePhase === 'explore' && matchedResults.length > 0) {
    const topEntry = ws.files.get(matchedResults[0].file);
    if (topEntry && topEntry.lineCount > 140) {
      const skel = skeletonizeFile(engine, ws.absRoot, topEntry.relPath, {
        query: prompt,
        maxChars: Math.min(1400, Math.floor(maxChars * 0.3)),
      });
      if (skel?.ok && skel.formatted) {
        parts.push(`## 🩻 AST Skeleton Focus (${effectivePhase})\n${skel.formatted}`);
      }
    }
  } else if (effectivePhase === 'debug' && matchedResults.length > 0) {
    const topFile = matchedResults[0].file;
    const topEntry = ws.files.get(topFile);
    const topBuf = topEntry?.buf;
    const idMatch = String(faultText || prompt).match(/\b([a-zA-Z_][a-zA-Z0-9_]{3,})\b/);
    const focusSym = (topEntry?.symbols?.[0]?.name) || (idMatch ? idMatch[1] : '');
    if (focusSym && topBuf) {
      const dfSlice = extractVariableSliceFromText(topBuf.toString('utf8'), focusSym, {
        focusLine: matchedResults[0].line || 0,
        maxLines: 30,
      });
      if (dfSlice?.formatted) {
        parts.push(`## 🔬 Debug Data-Flow Slice (${topFile}#${focusSym})\n${dfSlice.formatted.slice(0, 900)}`);
      }
    }
  }

  const egoHint = getEgoGraphHintForResultsImpl(engine, ws.absRoot, matchedResults, prompt);
  if (egoHint?.edgesFound > 0 && egoHint.formattedHint) {
    parts.push(egoHint.formattedHint);
  }

  const twoHop = getTwoHopContractStripImpl(engine, ws.absRoot, matchedResults);
  if (twoHop?.formattedHint) {
    parts.push(twoHop.formattedHint);
  }

  try {
    if (cpuCfg.cpuSotaEngines !== false && ws.files.size >= 3) {
      const seedFiles = matchedResults.map((r) => r.file).filter(Boolean);
      const pprFiles = ws.files.size > 1500
        ? engine._buildLocalNeighborhoodFiles(ws, seedFiles, 220)
        : ws.files;
      const pprGraph = ensureSymbolGraph(ws, { seedFiles, maxFullFiles: 1500, localCap: 220 });
      const faultFiles = faultText && matchedResults[0]?.file ? [matchedResults[0].file] : [];
      const pprRes = computeBipartiteSymbolPPR(pprFiles, pprGraph, { query: prompt, faultFiles });
      if (pprRes?.bridgeNodes?.length > 0 && pprRes.formattedHint) {
        parts.push(pprRes.formattedHint);
        try {
          recordCpuCompressionSaving({ kind: 'ppr', savedChars: 1400, latencyMs: pprRes.elapsedMs || 1.0 });
        } catch {}
      }
    }
  } catch {
    if (engine?.errorStats) engine.errorStats.parse += 1;
  }

  try {
    if (cpuCfg.cpuSotaEngines !== false && (effectivePhase === 'explore' || ws.files.size >= 6) && (ws.archClusters || ws.files.size <= 3000)) {
      const arch = getArchitectureClustersImpl(engine, ws.absRoot, { maxClusters: 5, maxGodNodes: 4 });
      const usedBudget = parts.join('\n\n').length;
      if (
        arch?.formattedDigest
        && (arch.clusters.length >= 2 || arch.godNodes.length >= 1)
        && usedBudget + arch.formattedDigest.length <= Math.floor(maxChars * 0.78)
        && maxChars - (usedBudget + arch.formattedDigest.length) >= 1000
      ) {
        parts.push(arch.formattedDigest);
      }
    }
  } catch {
    if (engine?.errorStats) engine.errorStats.parse += 1;
  }

  const pitfalls = formatPitfallsForSessionStart(ws.absRoot);
  if (pitfalls) parts.push(pitfalls);

  const handoff = formatHandoffForSessionStart(ws.absRoot);
  if (handoff) parts.push(handoff);

  const repoMapBudget = effectivePhase === 'explore' ? Math.floor(maxChars * 0.45) : Math.floor(maxChars * 0.32);
  const repoMap = getFastRepoMapImpl(engine, ws.absRoot, Math.max(1000, repoMapBudget), { toon });
  if (repoMap?.markdown) parts.push(repoMap.markdown);

  let combined = capPackMarkdownSafely(parts.join('\n\n'), maxChars, 'RAM Context Pack');
  engine.recordCompletedOp('ram_context_pack', {
    target: path.basename(ws.absRoot),
    latencyMs: Number((performance.now() - t0).toFixed(2)),
  });
  return {
    ok: true,
    phase: effectivePhase,
    filesInRam: ws.files.size,
    usedMb: Number((ws.totalBytes / (1024 * 1024)).toFixed(2)),
    formatted: combined,
  };
}

/**
 * Pure in-RAM + CPU (<5ms, 0 VRAM, 0 Ollama calls) composer context lookup for Ghost Text autocomplete.
 */
export function searchComposerContextFastImpl(engine, rootDir, draft = '', { maxFiles = 5, maxSymbols = 10 } = {}) {
  const t0 = performance.now();
  const ws = engine.ensureWarm(rootDir);
  if (!ws || !ws.files) {
    return {
      ok: false,
      mode: 'cpu_ram_fast',
      matchedFiles: [],
      matchedSymbols: [],
      ragSnippets: [],
      repoFiles: [],
      repoSymbols: [],
    };
  }

  const { repoFiles, repoSymbols, symbolsByFile, repoTechTerms } = collectWorkspaceGroundingInventory(ws, {
    maxRepoFiles: 500,
    maxRepoSymbols: 2500,
  });

  const cleanDraft = String(draft || '').trim();
  if (!cleanDraft) {
    return {
      ok: true,
      mode: 'cpu_ram_fast',
      matchedFiles: [],
      matchedSymbols: [],
      ragSnippets: [],
      repoFiles,
      repoSymbols,
      symbolsByFile,
      repoTechTerms,
    };
  }

  const capFiles = Math.max(1, Math.min(12, Number(maxFiles) || 5));
  const capSymbols = Math.max(1, Math.min(30, Number(maxSymbols) || 10));
  const draftLower = cleanDraft.toLowerCase();
  const explicitFiles = extractExplicitFileMatches(cleanDraft, ws.files);
  const qInfo = expandQueryBilingualStems(cleanDraft);

  const rawCodeIds = (cleanDraft.match(/[A-Za-z_$][A-Za-z0-9_$]{2,}/g) || [])
    .map((id) => id.toLowerCase())
    .filter((id) => !COMPOSER_STOPWORDS.has(id) && (id.length >= 3 || SHORT_TECH_TOKENS.has(id)));
  const hasTechSignal = rawCodeIds.length > 0 || explicitFiles.size > 0 || qInfo.synonymTerms.length > 0;

  const meaningfulRawTokens = qInfo.subTokens.filter((t) => {
    if (COMPOSER_STOPWORDS.has(t)) return false;
    const st = stemWord(t);
    if (st && COMPOSER_STOPWORDS.has(st)) return false;
    if (!hasTechSignal && /[а-яё]/i.test(t) && t.length < 5) return false;
    return t.length >= 3 || SHORT_TECH_TOKENS.has(t);
  });
  const meaningfulStems = hasTechSignal
    ? qInfo.stems.filter((s) => !COMPOSER_STOPWORDS.has(s) && s.length >= 3)
    : [];
  const meaningfulTerms = Array.from(
    new Set([...meaningfulRawTokens, ...meaningfulStems, ...qInfo.synonymTerms])
  );

  if (meaningfulTerms.length === 0 && explicitFiles.size === 0 && rawCodeIds.length === 0) {
    return {
      ok: true,
      mode: 'cpu_ram_fast',
      matchedFiles: [],
      matchedSymbols: [],
      ragSnippets: [],
      repoFiles,
      repoSymbols,
      symbolsByFile,
      repoTechTerms,
    };
  }

  const searchQuery = meaningfulRawTokens.length > 0 ? cleanDraft : meaningfulTerms.join(' ');
  const searchRes = searchWorkspace(engine, ws.absRoot, searchQuery || cleanDraft, {
    maxResults: 12,
    contextLines: 1,
    fastMode: true,
    _skipStats: true,
  });

  const candidateByRel = new Map();
  for (const r of searchRes?.results || []) {
    const entry = ws.files.get(r.file);
    const buf = entry?.buf;
    if (!entry || !buf || !entry.lineOffsets) continue;
    candidateByRel.set(r.file, {
      entry,
      file: r.file,
      relPath: r.file,
      line: r.line || r.startLine || 1,
      startLine: r.startLine || 1,
      endLine: r.endLine || 1,
      score: Number(r.score) || 0,
      bm25fScore: Number(r.bm25fScore) || 0,
      hybridScore: Number(r.score) || 0,
      reverseDepsCount: ws.reverseDeps.get(r.file)?.size || 0,
      symbols: entry.symbols || [],
      exportedSymbols: entry.exportedSymbols || [],
      snippetText: sliceBufferLines(buf, entry.lineOffsets, r.startLine || 1, r.endLine || 1),
    });
  }

  if (explicitFiles.size > 0 || (candidateByRel.size < capFiles && (rawCodeIds.length > 0 || meaningfulRawTokens.length > 0))) {
    const needleTokens = Array.from(new Set([...rawCodeIds, ...meaningfulRawTokens])).filter((t) => t.length >= 3);
    for (const [rel, entry] of ws.files.entries()) {
      if (candidateByRel.has(rel)) continue;
      const relLower = rel.toLowerCase();
      const isExplicit = explicitFiles.has(rel);
      let matchedSymObj = null;
      let hasDirectHit = isExplicit;

      if (!hasDirectHit && needleTokens.length > 0) {
        if (needleTokens.some((tok) => relLower.includes(tok))) {
          hasDirectHit = true;
        } else {
          for (const sym of entry.symbols || []) {
            const sName = String(sym?.name || '').toLowerCase();
            if (sName.length >= 3 && (draftLower.includes(sName) || needleTokens.some((tok) => sName.includes(tok)))) {
              hasDirectHit = true;
              matchedSymObj = sym;
              break;
            }
          }
          if (!hasDirectHit) {
            for (const exp of entry.exportedSymbols || []) {
              const eLower = String(exp || '').toLowerCase();
              if (eLower.length >= 3 && (draftLower.includes(eLower) || needleTokens.some((tok) => eLower.includes(tok)))) {
                hasDirectHit = true;
                break;
              }
            }
          }
        }
      }

      if (hasDirectHit) {
        const buf = entry?.buf;
        if (!buf || !entry.lineOffsets) continue;
        const sLine = matchedSymObj?.startLine || 1;
        const eLine = Math.min(entry.lineCount, matchedSymObj?.endLine ? Math.min(matchedSymObj.endLine, sLine + 8) : Math.min(entry.lineCount, 10));
        candidateByRel.set(rel, {
          entry,
          file: rel,
          relPath: rel,
          line: sLine,
          startLine: sLine,
          endLine: eLine,
          score: isExplicit ? 12 : 6,
          bm25fScore: isExplicit ? 8 : 3.5,
          hybridScore: isExplicit ? 12 : 6,
          reverseDepsCount: ws.reverseDeps.get(rel)?.size || 0,
          symbols: entry.symbols || [],
          exportedSymbols: entry.exportedSymbols || [],
          snippetText: sliceBufferLines(buf, entry.lineOffsets, sLine, eLine),
        });
        if (candidateByRel.size >= 15) break;
      }
    }
  }

  const candidates = Array.from(candidateByRel.values()).slice(0, 15);
  if (candidates.length === 0) {
    return {
      ok: true,
      mode: 'cpu_ram_fast',
      matchedFiles: [],
      matchedSymbols: [],
      ragSnippets: [],
      repoFiles,
      repoSymbols,
      symbolsByFile,
      repoTechTerms,
    };
  }

  const reranked = rerankCandidates(cleanDraft, candidates, {
    topK: Math.min(15, Math.max(capFiles, 8)),
    maxCandidates: 15,
    skipTelemetry: true,
  });
  const rankedPool = Array.isArray(reranked?.results) && reranked.results.length > 0
    ? reranked.results
    : candidates;

  const passed = rankedPool.filter((c) => {
    const entry = c.entry || ws.files.get(c.file);
    if (!entry) return false;
    if (explicitFiles.has(c.file)) return true;

    const relLower = c.file.toLowerCase();
    const baseNoExt = path.posix.basename(relLower, entry.ext || path.posix.extname(relLower));
    if (baseNoExt.length >= 3 && draftLower.includes(baseNoExt)) return true;
    if (meaningfulRawTokens.some((tok) => tok.length >= 3 && relLower.includes(tok))) return true;

    const allFileSymNames = [
      ...(entry.exportedSymbols || []),
      ...(entry.symbols || []).map((s) => s?.name || ''),
    ].filter((n) => n && n.length >= 3);
    if (
      allFileSymNames.some((n) => {
        const nl = n.toLowerCase();
        return draftLower.includes(nl) || rawCodeIds.some((id) => id.length >= 4 && nl.includes(id));
      })
    ) {
      return true;
    }

    const snippetLower = String(c.snippetText || '').toLowerCase();
    const symLowerJoined = allFileSymNames.join(' ').toLowerCase();
    const hasConceptOverlap = meaningfulTerms.some(
      (term) =>
        term.length >= 2 &&
        (entry.tokens?.has(term) ||
          snippetLower.includes(term) ||
          relLower.includes(term) ||
          symLowerJoined.includes(term))
    );
    if (!hasConceptOverlap) return false;
    if (!hasTechSignal) {
      return (Number(c.bm25fScore) || 0) >= 4.5;
    }
    return (Number(c.bm25fScore) || 0) >= 0.25 || (Number(c.rerankScore) || 0) >= 0.18;
  });

  passed.sort((a, b) => {
    const aExp = explicitFiles.has(a.file) ? 1 : 0;
    const bExp = explicitFiles.has(b.file) ? 1 : 0;
    if (aExp !== bExp) return bExp - aExp;
    return (b.rerankScore || 0) - (a.rerankScore || 0) || (b.bm25fScore || 0) - (a.bm25fScore || 0);
  });

  const topCandidates = passed.slice(0, capFiles);
  const matchedFiles = [];
  const matchedSymbols = [];
  const ragSnippets = [];
  const seenFiles = new Set();
  const seenSyms = new Set();
  const meaningfulSet = new Set(meaningfulTerms);

  const genericSymSubtokens = new Set([
    'file', 'files', 'check', 'verify', 'test', 'get', 'set', 'run', 'load', 'save',
    'read', 'write', 'init', 'start', 'stop', 'handle', 'parse', 'build', 'format',
    'update', 'create', 'delete', 'data', 'info', 'list', 'item', 'res', 'req',
  ]);

  const scoreSymbolRelevance = (symName, symStart = 0, symEnd = 0, hitStart = 0, hitEnd = 0) => {
    const nl = symName.toLowerCase();
    let s = 0;
    if (draftLower.includes(nl)) s += 16;
    if (rawCodeIds.some((id) => id.length >= 4 && nl.includes(id))) s += 10;
    const subToks = splitIdentifierSubtokens(symName);
    for (const st of subToks) {
      const isGeneric = genericSymSubtokens.has(st);
      if (meaningfulSet.has(st)) s += isGeneric ? 0.5 : 4;
      const stemmed = stemWord(st);
      if (stemmed && meaningfulSet.has(stemmed)) s += isGeneric ? 0.25 : 2;
    }
    if (symStart > 0 && hitStart > 0 && (hasTechSignal || s > 0)) {
      const endS = symEnd || symStart;
      if (symStart <= hitEnd + 5 && endS >= hitStart - 5) s += 8;
    }
    return s;
  };

  for (const c of topCandidates) {
    const rel = c.file;
    if (!rel || seenFiles.has(rel)) continue;
    seenFiles.add(rel);
    matchedFiles.push(rel);

    const entry = c.entry || ws.files.get(rel);
    if (!entry) continue;

    const hitStart = Number(c.startLine || c.line || 1);
    const hitEnd = Number(c.endLine || hitStart);
    const exportSet = new Set(entry.exportedSymbols || []);

    const fileSymPool = [];
    const seenInFile = new Set();
    for (const sym of entry.symbols || []) {
      const name = String(sym?.name || '').trim();
      if (!name || name.length < 3 || name === 'anonymous' || seenInFile.has(name)) continue;
      seenInFile.add(name);
      const relScore =
        scoreSymbolRelevance(name, sym.startLine, sym.endLine, hitStart, hitEnd) +
        (exportSet.has(name) ? 0.5 : 0);
      fileSymPool.push({ name, symStart: sym.startLine || hitStart, symEnd: sym.endLine || hitEnd, relScore });
    }
    for (const exp of entry.exportedSymbols || []) {
      const name = String(exp || '').trim();
      if (!name || name.length < 3 || name === 'anonymous' || seenInFile.has(name)) continue;
      seenInFile.add(name);
      const relScore = scoreSymbolRelevance(name, 0, 0, hitStart, hitEnd) + 0.5;
      fileSymPool.push({ name, symStart: hitStart, symEnd: hitEnd, relScore });
    }

    fileSymPool.sort((a, b) => b.relScore - a.relScore);

    const localSyms = [];
    let enclosingSym = null;
    const allowSmallFileFallback = fileSymPool.length <= 3 && explicitFiles.has(rel);
    for (const item of fileSymPool) {
      if (item.relScore < 4 && !allowSmallFileFallback) break;
      if (localSyms.length < 4) {
        localSyms.push(item.name);
        if (!enclosingSym && item.symStart <= hitEnd + 4 && item.symEnd >= hitStart - 4) {
          enclosingSym = item;
        }
      }
      if (!seenSyms.has(item.name) && matchedSymbols.length < capSymbols) {
        seenSyms.add(item.name);
        matchedSymbols.push(item.name);
      }
    }

    if (ragSnippets.length < 3) {
      const snipStart = enclosingSym ? enclosingSym.symStart : hitStart;
      const snipEnd = enclosingSym ? enclosingSym.symEnd : hitEnd;
      ragSnippets.push({
        file: rel,
        startLine: Number(snipStart || 1),
        endLine: Number(snipEnd || snipStart || 1),
        symbols: localSyms,
      });
    }
  }

  engine.recordCompletedOp('composer_rag_fast', {
    target: matchedFiles[0] || cleanDraft.slice(0, 40),
    latencyMs: performance.now() - t0,
  });

  return {
    ok: true,
    mode: 'cpu_ram_fast',
    matchedFiles,
    matchedSymbols,
    ragSnippets,
    repoFiles,
    repoSymbols,
    symbolsByFile,
    repoTechTerms,
  };
}

/**
 * Builds a grounded, zero-pollution AST-RAG chat context pack for local GPU project chat.
 */
export function buildGroundedChatPackImpl(
  engine,
  rootDir,
  query = '',
  { messages = [], maxChars = 8400, warmSemanticHits = [], maxFiles = 5, focusFile = '' } = {}
) {
  const t0 = performance.now();
  const ws = engine.ensureWarm(rootDir);
  if (!ws || !ws.files) {
    return {
      ok: false,
      formatted: 'Workspace not found.',
      verifiedManifest: '',
      sources: [],
      repoFiles: [],
      repoSymbols: [],
      symbolsByFile: {},
    };
  }

  const capFiles = Math.max(1, Math.min(10, Number(maxFiles) || 5));
  const budgetChars = Math.max(1600, Math.min(24000, Number(maxChars) || 8400));
  const { repoFiles, repoSymbols, symbolsByFile } = collectWorkspaceGroundingInventory(ws, {
    maxRepoFiles: Math.max(500, ws.files.size),
    maxRepoSymbols: 2500,
  });

  let resolvedFocusRel = '';
  const rawFocus = String(focusFile || '').replace(/\\/g, '/').replace(/^\/+/, '').trim();
  if (rawFocus && !rawFocus.includes('..') && !rawFocus.includes('\0')) {
    if (ws.files.has(rawFocus)) {
      resolvedFocusRel = rawFocus;
    } else {
      const lowerFocus = rawFocus.toLowerCase();
      for (const k of ws.files.keys()) {
        if (k.toLowerCase() === lowerFocus) {
          resolvedFocusRel = k;
          break;
        }
      }
    }
  }

  const cleanQuery = String(query || '').trim();
  const effectiveQuery = enrichMultiTurnChatQuery(cleanQuery, messages, { maxExtraTerms: 6 });
  const explicitQueryFiles = extractExplicitFileMatches(cleanQuery, ws.files);
  if (resolvedFocusRel) explicitQueryFiles.add(resolvedFocusRel);
  const contextFiles = extractExplicitFileMatches(effectiveQuery, ws.files);
  if (resolvedFocusRel) contextFiles.add(resolvedFocusRel);

  const decomposeCompoundQuery = (qStr = '') => {
    const s = String(qStr || '').trim();
    if (s.length < 18) return [];
    const parts = s
      .split(/\?\s+|(?:\s+(?:и\s+почему|и\s+как|а\s+также|а\s+в\s+частности|в\s+частности|and\s+how|and\s+why|as\s+well\s+as)\b)\s*/i)
      .map((p) => p.trim())
      .filter((p) => p.length >= 10 && p.toLowerCase() !== s.toLowerCase());
    return Array.from(new Set(parts)).slice(0, 3);
  };

  const lexRes = effectiveQuery
    ? searchWorkspace(engine, ws.absRoot, effectiveQuery, { maxResults: 12, contextLines: 2, _skipStats: true })
    : { ok: false, results: [] };
  const subQueries = decomposeCompoundQuery(cleanQuery);
  const subLexLists = subQueries.map((sq) => ({
    results: searchWorkspace(engine, ws.absRoot, sq, { maxResults: 6, contextLines: 2, _skipStats: true })?.results || [],
    weightScale: 0.85,
  }));
  const semList = Array.isArray(warmSemanticHits) ? warmSemanticHits : [];

  const { mergedMap, bucketToKey, lexScoreByFile } = mergeHybridSourcesIntoMap(ws, {
    semList,
    lexLists: [{ results: lexRes.results || [], weightScale: 1.0 }, ...subLexLists],
    bucketMode: 'bucket40',
    maxSemPerFile: 1,
  });

  const extractExplicitSymIds = (txt) => {
    const ids = new Set();
    for (const m of String(txt || '').matchAll(/[A-Za-z_$][A-Za-z0-9_$]{3,}/g)) {
      const lower = m[0].toLowerCase();
      if (!COMPOSER_STOPWORDS.has(lower) && !IGNORED_MULTI_TURN_IDS.has(lower)) {
        ids.add(lower);
      }
    }
    return ids;
  };
  const explicitQuerySymIds = extractExplicitSymIds(cleanQuery);
  const effectiveQuerySymIds = extractExplicitSymIds(effectiveQuery);
  const explicitSymSliceKeys = new Set();
  const contextSymSliceKeys = new Set();
  const turnConceptInfo = expandQueryBilingualStems(cleanQuery);
  const extraTurnEn = [];
  if (/токен/i.test(cleanQuery)) extraTurnEn.push('token', 'tokens', 'ctx');
  if (/(?:лимит|бюджет|огранич|размер)/i.test(cleanQuery)) extraTurnEn.push('limit', 'budget', 'cap', 'max');
  if (/(?:таймаут|завис|ожидан|прерыв)/i.test(cleanQuery)) extraTurnEn.push('timeout', 'abort', 'signal', 'wait');
  const turnConcepts = Array.from(
    new Set([
      ...turnConceptInfo.allConcepts.filter((c) => c.length >= 3 && !COMPOSER_STOPWORDS.has(c)),
      ...extraTurnEn,
    ])
  );

  if (effectiveQuerySymIds.size > 0) {
    const updatedNearbyKeys = new Set();
    for (const entry of ws.files.values()) {
      const syms = entry.symbols || [];
      if (syms.length === 0) continue;
      const entryBuf = entry.buf;
      for (const sym of syms) {
        const symNameLower = String(sym?.name || '').toLowerCase();
        if (!symNameLower || symNameLower === 'anonymous' || !effectiveQuerySymIds.has(symNameLower)) continue;
        const isDirectQuerySym = explicitQuerySymIds.has(symNameLower);
        const symStart = Math.max(1, Number(sym.startLine) || 1);
        const rawSymEnd = Math.max(symStart, Math.min(entry.lineCount, Number(sym.endLine) || symStart));
        const symEnd = inferEffectiveSymbolEndLine(entry, syms, symStart, rawSymEnd, symStart + 45, 55);

        let targetStart = symStart;
        let targetEnd = Math.min(symEnd, symStart + 24);
        let targetFocus = symStart;

        if (symEnd - symStart + 1 > 55 && turnConcepts.length > 0 && entryBuf && entry.lineOffsets) {
          const sByte = entry.lineOffsets[symStart - 1] || 0;
          const eByte = symEnd < entry.lineCount ? entry.lineOffsets[symEnd] - 1 : entryBuf.length;
          const fnLines = entryBuf.toString('utf8', sByte, Math.max(sByte, eByte)).split(/\r?\n/);
          let bestSubScore = 0;
          let bestSubIdx = -1;
          for (let li = Math.min(14, fnLines.length - 1); li < fnLines.length; li++) {
            const lnLower = fnLines[li].toLowerCase();
            let sc = 0;
            for (const tc of turnConcepts) {
              if (lnLower.includes(tc)) sc += 1;
            }
            if (sc > bestSubScore) {
              bestSubScore = sc;
              bestSubIdx = li;
            }
          }
          if (bestSubScore > 0 && bestSubIdx >= 0) {
            targetFocus = symStart + bestSubIdx;
            targetStart = Math.max(symStart, targetFocus - 4);
            targetEnd = Math.min(symEnd, targetFocus + 10);
          }
        }

        let nearbyEntryKey = '';
        for (const [mKey, mVal] of mergedMap.entries()) {
          if (mVal.file === entry.relPath && Math.abs((mVal.startLine || 1) - symStart) <= 35) {
            nearbyEntryKey = mKey;
            break;
          }
        }

        if (nearbyEntryKey) {
          if (targetStart > symStart + 15 && !updatedNearbyKeys.has(nearbyEntryKey)) {
            const existingVal = mergedMap.get(nearbyEntryKey);
            if (existingVal) {
              updatedNearbyKeys.add(nearbyEntryKey);
              existingVal.startLine = targetStart;
              existingVal.endLine = targetEnd;
              existingVal.line = targetFocus;
            }
          }
          if (isDirectQuerySym) explicitSymSliceKeys.add(nearbyEntryKey);
          else contextSymSliceKeys.add(nearbyEntryKey);
        } else {
          const symSliceKey = `${entry.relPath}:${targetStart}-${targetEnd}#sym:${sym.name}`;
          mergedMap.set(symSliceKey, {
            sliceKey: symSliceKey,
            entry,
            file: entry.relPath,
            relPath: entry.relPath,
            line: targetFocus,
            startLine: targetStart,
            endLine: targetEnd,
            similarity: 0,
            rrfScore: isDirectQuerySym ? 0.42 : 0.25,
          });
          if (isDirectQuerySym) explicitSymSliceKeys.add(symSliceKey);
          else contextSymSliceKeys.add(symSliceKey);
        }
      }
    }
  }

  const qTermsLower = splitIdentifierSubtokens(effectiveQuery).filter((t) => t.length >= 3 && !COMPOSER_STOPWORDS.has(t));
  for (const expRel of new Set([...explicitQueryFiles, ...contextFiles])) {
    const alreadyHasFile = Array.from(mergedMap.values()).some((m) => m.file === expRel);
    if (alreadyHasFile) continue;
    const entry = ws.files.get(expRel);
    if (!entry) continue;
    let focusLine = 1;
    for (const sym of entry.symbols || []) {
      const sLower = `${sym.name || ''} ${sym.signature || ''}`.toLowerCase();
      if (qTermsLower.some((t) => sLower.includes(t))) {
        focusLine = sym.startLine || 1;
        break;
      }
    }
    const sLine = Math.max(1, focusLine);
    const eLine = Math.min(entry.lineCount, sLine + 18);
    const fKey = `${expRel}:${sLine}-${eLine}`;
    mergedMap.set(fKey, {
      sliceKey: fKey,
      entry,
      file: expRel,
      relPath: expRel,
      line: sLine,
      startLine: sLine,
      endLine: eLine,
      similarity: 0,
      rrfScore: explicitQueryFiles.has(expRel) ? 0.35 : 0.12,
    });
  }

  let { top: selected, pool } = fuseHybridCandidates(ws, {
    rerankQuery: effectiveQuery,
    preMergedMap: mergedMap,
    preBucketToKey: bucketToKey,
    preLexScoreByFile: lexScoreByFile,
    codeBias: 0.003,
    maxDepBoost: 0.01,
    simWeight: 0.008,
    extraEndPad: 6,
    explicitFiles: explicitQueryFiles,
    contextFiles,
    explicitSymSliceKeys,
    contextSymSliceKeys,
    maxResults: capFiles,
    poolCap: Math.max(capFiles * 3, 15),
    lambda: 0.74,
    useRerank: Boolean(effectiveQuery),
  });

  const pinnedSliceKeys = [
    ...Array.from(explicitSymSliceKeys),
    ...Array.from(contextSymSliceKeys),
  ].slice(0, Math.min(2, capFiles));
  for (const sKey of pinnedSliceKeys.reverse()) {
    if (!selected.some((s) => s.sliceKey === sKey)) {
      const found = pool.find((p) => p.sliceKey === sKey);
      if (found) {
        selected = [found, ...selected.slice(0, Math.max(0, capFiles - 1))];
      }
    }
  }
  if (explicitQueryFiles.size > 0) {
    for (const expRel of Array.from(explicitQueryFiles).slice(0, capFiles)) {
      if (!selected.some((s) => s.file === expRel)) {
        const found = pool.find((p) => p.file === expRel);
        if (found) {
          selected = [found, ...selected.slice(0, Math.max(0, capFiles - 1))];
        }
      }
    }
  }

  let orderedSlices = [...selected, ...pool.filter((p) => !selected.includes(p))];
  if (resolvedFocusRel) {
    const focusSlices = orderedSlices.filter((s) => (s.file || s.relPath) === resolvedFocusRel);
    const otherSlices = orderedSlices.filter((s) => (s.file || s.relPath) !== resolvedFocusRel);
    if (focusSlices.length > 0) {
      orderedSlices = [...focusSlices, ...otherSlices];
    }
  }
  const expandedSlices = [];
  const seenSliceRange = new Set();
  for (const item of orderedSlices) {
    if (expandedSlices.length >= capFiles) break;
    const entry = item.entry || ws.files.get(item.file);
    if (!entry) continue;
    const expanded = expandSliceToWholeAstSymbol(
      entry,
      item.startLine,
      item.endLine,
      item.line || item.startLine,
      effectiveQuery,
      55
    );
    const rangeKey = `${entry.relPath}:${expanded.startLine}-${expanded.endLine}`;
    if (seenSliceRange.has(rangeKey)) continue;
    seenSliceRange.add(rangeKey);
    engine._touchEntry(ws, entry);
    entry.hits += 1;
    expandedSlices.push({
      file: entry.relPath,
      startLine: expanded.startLine,
      endLine: expanded.endLine,
      symbol: expanded.symbol,
      signature: expanded.signature,
      snippetText: expanded.snippetText,
      similarity: item.similarity || 0,
      score: Number((item.rerankScore ?? item.hybridScore ?? item.bm25fScore ?? 0).toFixed(4)),
    });
  }

  const manifestFiles = [];
  const seenManifest = new Set();
  const pushManifestFile = (rel) => {
    if (!rel || seenManifest.has(rel) || !ws.files.has(rel)) return;
    seenManifest.add(rel);
    manifestFiles.push(rel);
  };
  for (const s of expandedSlices) pushManifestFile(s.file);
  for (const s of expandedSlices.slice(0, 3)) {
    for (const fwd of ws.forwardDeps.get(s.file) || []) {
      pushManifestFile(fwd);
      if (manifestFiles.length >= 9) break;
    }
    for (const rev of ws.reverseDeps.get(s.file) || []) {
      pushManifestFile(rev);
      if (manifestFiles.length >= 10) break;
    }
  }
  if (manifestFiles.length < 6 && ws.files.size > manifestFiles.length) {
    const topRankedByDeps = Array.from(ws.files.values())
      .filter((e) => CODE_EXTENSIONS.has(e.ext) && !seenManifest.has(e.relPath))
      .sort((a, b) => (ws.reverseDeps.get(b.relPath)?.size || 0) - (ws.reverseDeps.get(a.relPath)?.size || 0))
      .slice(0, 6 - manifestFiles.length);
    for (const e of topRankedByDeps) pushManifestFile(e.relPath);
  }

  const manifestLines = [];
  let manifestLen = 0;
  const MANIFEST_MAX_CHARS = 1400;
  for (const rel of manifestFiles) {
    const entry = ws.files.get(rel);
    if (!entry) continue;
    const imps = (entry.imports || []).slice(0, 4).join(', ');
    const exps = (entry.exportedSymbols || []).slice(0, 6).join(', ');
    const sortedSyms = [...(entry.symbols || [])].sort((a, b) => {
      const aHit = qTermsLower.some((t) => `${a.name || ''} ${a.signature || ''}`.toLowerCase().includes(t)) ? 1 : 0;
      const bHit = qTermsLower.some((t) => `${b.name || ''} ${b.signature || ''}`.toLowerCase().includes(t)) ? 1 : 0;
      return bHit - aHit || (a.startLine || 0) - (b.startLine || 0);
    });
    const sigList = sortedSyms
      .slice(0, 4)
      .map((s) => `${String(s.signature || s.name || '').replace(/\s+/g, ' ').trim().slice(0, 64)} [L${s.startLine}-${s.endLine || s.startLine}]`)
      .filter(Boolean)
      .join('; ');
    const details = [
      imps ? `imports: ${imps}` : '',
      exps ? `exports: ${exps}` : '',
      sigList ? `symbols: ${sigList}` : '',
    ].filter(Boolean).join(' | ');
    const bullet = `- \`${entry.relPath}\` (${entry.lineCount}L)${details ? ` — ${details}` : ''}`;
    if (manifestLines.length > 0 && manifestLen + bullet.length + 1 > MANIFEST_MAX_CHARS) {
      break;
    }
    const safeBullet = bullet.length > MANIFEST_MAX_CHARS ? `${bullet.slice(0, MANIFEST_MAX_CHARS - 3)}...` : bullet;
    manifestLines.push(safeBullet);
    manifestLen += safeBullet.length + 1;
  }
  const verifiedManifest = manifestLines.join('\n');

  const parts = [];
  if (expandedSlices.length > 0) {
    const renderedSlices = expandedSlices
      .map((s) => {
        const symTag = s.symbol ? ` (\`${s.symbol}\`)` : '';
        return `### \`${s.file}\` [L${s.startLine}-L${s.endLine}]${symTag}\n\`\`\`\n${s.snippetText}\n\`\`\``;
      })
      .join('\n\n');
    parts.push(`## ⚡ Grounded AST-RAG Code Slices\n${renderedSlices}`);

    const blast = getFastBlastRadiusImpl(engine, ws.absRoot, expandedSlices[0].file);
    if (blast?.formattedHint) {
      parts.push(blast.formattedHint);
    }
    const egoHint = getEgoGraphHintForResultsImpl(engine, ws.absRoot, expandedSlices, effectiveQuery);
    if (egoHint?.edgesFound > 0 && egoHint.formattedHint) {
      parts.push(egoHint.formattedHint);
    }
    const twoHop = getTwoHopContractStripImpl(engine, ws.absRoot, expandedSlices);
    if (twoHop?.formattedHint) {
      parts.push(twoHop.formattedHint);
    }
  }

  let combined = parts.join('\n\n');
  const remainingForMap = budgetChars - combined.length;
  if (remainingForMap >= 900) {
    const repoMap = getFastRepoMapImpl(engine, ws.absRoot, Math.min(2200, remainingForMap - 60), { toon: true });
    if (repoMap?.markdown) {
      combined = combined ? `${combined}\n\n${repoMap.markdown}` : repoMap.markdown;
    }
  }
  combined = capPackMarkdownSafely(combined, budgetChars, 'Grounded AST-RAG Pack');

  const sources = expandedSlices.map((s) => ({
    file: s.file,
    startLine: s.startLine,
    endLine: s.endLine,
    ...(s.symbol ? { symbol: s.symbol } : {}),
    score: s.score,
  }));

  engine.recordCompletedOp('grounded_chat_pack', {
    target: expandedSlices[0]?.file || path.basename(ws.absRoot),
    latencyMs: Number((performance.now() - t0).toFixed(2)),
  });

  return {
    ok: true,
    formatted: combined,
    verifiedManifest,
    sources,
    repoFiles,
    repoSymbols,
    symbolsByFile,
  };
}

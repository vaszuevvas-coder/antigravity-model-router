/**
 * @file ram-search.mjs
 * @description In-RAM lexical (BM25F + Trigram + CSR), semantic (GPU + RRF), and hybrid search helpers for RamMemoryEngine.
 */

import { expandQueryBilingualStems, rerankCandidates } from '../cpu-reranker.mjs';
import { loadCpuConfig } from '../cpu-worker-pool.mjs';
import { indexWorkspaceVectors, loadGpuConfig, semanticSearchWorkspace } from '../local-gpu-engine.mjs';
import { offsetToLine1 } from '../cpu-sbfl-healer.mjs';
import { expandRuQueryToEnTerms } from '../ru-en-lexicon.mjs';
import {
  BM25F_B,
  BM25F_K1,
  BM25F_WEIGHTS,
  CODE_EXTENSIONS,
  extractSearchTokens,
  extractTrigrams,
  selectDiverseSlicesWithTelemetry,
  sliceBufferLines,
} from './ram-index-helpers.mjs';

export function toBucketKey40(rel, startLine) {
  return `${rel}#b${Math.floor(Math.max(0, Number(startLine) || 0) / 40)}`;
}

function buildReSlicedLexFallback(engine, ws, lexRes, maxResults, contextLines) {
  const slicedResults = [];
  const formattedBlocks = [];
  for (const r of (lexRes.results || []).slice(0, maxResults)) {
    const entry = ws.files.get(r.file);
    const buf = entry?.buf;
    if (!entry || !buf || !entry.lineOffsets) continue;
    engine._touchEntry(ws, entry);
    entry.hits += 1;
    const matchLine = Math.max(1, Math.min(entry.lineCount, Number(r.line || r.startLine || 1) || 1));
    const startL = Math.max(1, Math.min(entry.lineCount, matchLine - contextLines));
    const endL = Math.max(startL, Math.min(entry.lineCount, matchLine + contextLines + 4));
    const snippet = sliceBufferLines(buf, entry.lineOffsets, startL, endL);
    slicedResults.push({
      file: r.file,
      line: matchLine,
      startLine: startL,
      endLine: endL,
      score: r.score,
      bm25fScore: r.bm25fScore,
      snippet,
    });
    formattedBlocks.push(`### \`${r.file}\` [L${startL}-L${endL}]\n\`\`\`\n${snippet}\n\`\`\``);
  }
  return {
    ...lexRes,
    results: slicedResults,
    formatted: formattedBlocks.length > 0 ? formattedBlocks.join('\n\n') : lexRes.formatted,
  };
}

/**
 * Merges semantic and lexical result lists into bucketed RRF maps.
 */
export function mergeHybridSourcesIntoMap(
  ws,
  {
    semList = [],
    lexLists = [],
    bucketMode = 'bucket40',
    maxSemPerFile = 2,
    mergedMap = new Map(),
    bucketToKey = new Map(),
  } = {}
) {
  const RRF_K = 60;
  const semCountByFile = new Map();

  semList.forEach((h, idx) => {
    const rel = String(h?.relPath || h?.file || '').trim();
    const entry = rel ? ws.files.get(rel) : null;
    if (!entry) return;
    if (bucketMode === 'file') {
      if (mergedMap.has(rel)) return;
      const fLine = Math.max(1, Math.min(entry.lineCount, Number(h.startLine || h.line) || 1));
      const fEnd = Math.max(fLine, Math.min(entry.lineCount, Number(h.endLine) || Math.min(entry.lineCount, 45)));
      mergedMap.set(rel, {
        entry,
        relPath: rel,
        file: rel,
        line: fLine,
        startLine: fLine,
        endLine: fEnd,
        similarity: Number(h.similarity ?? h.score ?? 0),
        rrfScore: 1 / (RRF_K + idx + 1),
      });
      return;
    }

    const seenCount = semCountByFile.get(rel) || 0;
    if (seenCount >= maxSemPerFile) return;
    const sLine = Math.max(1, Math.min(entry.lineCount, Number(h.startLine || h.line) || 1));
    const eLine = Math.max(sLine, Math.min(entry.lineCount, Number(h.endLine) || sLine + 12));
    const key = `${rel}:${sLine}-${eLine}`;
    if (mergedMap.has(key)) return;
    const bKey = toBucketKey40(rel, sLine);
    if (maxSemPerFile === 1 && bucketToKey.has(bKey)) return;
    semCountByFile.set(rel, seenCount + 1);
    if (!bucketToKey.has(bKey)) bucketToKey.set(bKey, key);
    mergedMap.set(key, {
      entry,
      file: rel,
      relPath: rel,
      line: sLine,
      startLine: sLine,
      endLine: eLine,
      similarity: Number(h.similarity ?? h.score ?? 0),
      rrfScore: 1 / (RRF_K + idx + 1),
    });
  });

  const lexScoreByFile = new Map();
  const mergeLexList = (resultsList = [], weightScale = 1.0) => {
    (resultsList || []).forEach((r, idx) => {
      const entry = ws.files.get(r.file);
      if (!entry) return;
      const bm = Number(r.bm25fScore || r.score || 0);
      if (bm > (lexScoreByFile.get(r.file) || 0)) {
        lexScoreByFile.set(r.file, bm);
      }
      const rStart = Math.max(1, Math.min(entry.lineCount, Number(r.startLine || r.line) || 1));
      const rEnd = Math.max(rStart, Math.min(entry.lineCount, Number(r.endLine) || rStart));
      const rLine = Math.max(1, Math.min(entry.lineCount, Number(r.line || rStart) || 1));
      const lexRrf = (1 / (RRF_K + idx + 1)) * weightScale;
      if (bucketMode === 'file') {
        const existing = mergedMap.get(r.file);
        if (existing) {
          existing.rrfScore += lexRrf;
        } else {
          mergedMap.set(r.file, {
            entry,
            file: r.file,
            relPath: r.file,
            line: rLine,
            startLine: rStart,
            endLine: rEnd,
            similarity: 0,
            rrfScore: lexRrf,
          });
        }
        return;
      }

      const bKey = toBucketKey40(r.file, rStart);
      const existingKey = bucketToKey.get(bKey);
      const existing = existingKey ? mergedMap.get(existingKey) : null;
      if (existing) {
        existing.rrfScore += lexRrf;
        if (r.line) existing.line = rLine;
      } else {
        const key = `${r.file}:${rStart}-${rEnd}`;
        bucketToKey.set(bKey, key);
        mergedMap.set(key, {
          entry,
          file: r.file,
          relPath: r.file,
          line: rLine,
          startLine: rStart,
          endLine: rEnd,
          similarity: 0,
          rrfScore: lexRrf,
        });
      }
    });
  };

  for (const listSpec of lexLists) {
    if (Array.isArray(listSpec)) {
      mergeLexList(listSpec, 1.0);
    } else if (listSpec && Array.isArray(listSpec.results)) {
      mergeLexList(listSpec.results, listSpec.weightScale ?? 1.0);
    }
  }

  return { mergedMap, bucketToKey, lexScoreByFile };
}

/**
 * Shared RRF fusion + structural boosting + optional CPU cross-rerank + MMR diversification.
 * Used by searchSemantic, buildHybridGoldContext, and buildGroundedChatPack.
 */
export function fuseHybridCandidates(
  ws,
  {
    query = '',
    rerankQuery = '',
    semList = [],
    lexLists = [],
    preMergedMap = null,
    preBucketToKey = null,
    preLexScoreByFile = null,
    bucketMode = 'bucket40',
    maxSemPerFile = 2,
    codeBias = 0.002,
    maxDepBoost = 0.008,
    simWeight = 0.005,
    extraEndPad = 4,
    explicitFiles = null,
    contextFiles = null,
    explicitSymSliceKeys = null,
    contextSymSliceKeys = null,
    maxResults = 6,
    poolCap = Math.max(maxResults * 2, 12),
    lambda = 0.72,
    useRerank = true,
    skipRerankTelemetry = false,
    applyMmr = true,
  } = {}
) {
  let mergedMap;
  let lexScoreByFile;
  if (preMergedMap) {
    mergedMap = preMergedMap;
    lexScoreByFile = preLexScoreByFile || new Map();
  } else {
    const merged = mergeHybridSourcesIntoMap(ws, {
      semList,
      lexLists,
      bucketMode,
      maxSemPerFile,
      bucketToKey: preBucketToKey || new Map(),
    });
    mergedMap = merged.mergedMap;
    lexScoreByFile = merged.lexScoreByFile;
  }

  const chosen = Array.from(mergedMap.entries())
    .filter(([, item]) => Boolean(item?.entry?.buf && item.entry.lineOffsets))
    .map(([mKey, item]) => {
      const buf = item.entry.buf;
      const sliceKey = item.sliceKey || mKey;
      const cBias = CODE_EXTENSIONS.has(item.entry.ext) ? codeBias : 0;
      const revDeps = ws.reverseDeps.get(item.relPath)?.size || 0;
      const depBoost = Math.min(maxDepBoost, revDeps * 0.0012);
      const simTie = (item.similarity || 0) * simWeight;
      const expBoost = explicitFiles?.has(item.relPath)
        ? 0.45
        : (contextFiles?.has(item.relPath) ? 0.12 : 0);
      const symBoost = explicitSymSliceKeys?.has(sliceKey)
        ? 0.50
        : (contextSymSliceKeys?.has(sliceKey) ? 0.28 : 0);
      const startP = Math.max(1, Math.min(item.entry.lineCount, item.startLine - 4));
      const endP = Math.max(startP, Math.min(item.entry.lineCount, item.endLine + extraEndPad));
      return {
        ...item,
        sliceKey,
        bm25fScore: lexScoreByFile.get(item.relPath) || 0,
        reverseDepsCount: revDeps,
        symbols: item.entry.symbols || [],
        exportedSymbols: item.entry.exportedSymbols || [],
        snippetText: sliceBufferLines(buf, item.entry.lineOffsets, startP, endP),
        hybridScore: Number((item.rrfScore + cBias + depBoost + simTie + expBoost + symBoost).toFixed(5)),
      };
    });

  chosen.sort((a, b) => b.hybridScore - a.hybridScore || a.relPath.localeCompare(b.relPath));

  let pool = chosen.slice(0, poolCap);
  let rerankElapsedMs = 0;
  let usedRerank = false;
  const activeRerankQuery = rerankQuery || query;
  if (useRerank && activeRerankQuery && chosen.length > 1) {
    const reranked = rerankCandidates(activeRerankQuery, chosen.slice(0, 25), {
      topK: poolCap,
      maxCandidates: 25,
      ...(skipRerankTelemetry ? { skipTelemetry: true } : {}),
    });
    if (Array.isArray(reranked?.results) && reranked.results.length > 0) {
      if (explicitFiles || contextFiles || explicitSymSliceKeys || contextSymSliceKeys) {
        pool = reranked.results.map((c) => {
          const fileBoost = explicitFiles?.has(c.file)
            ? 0.50
            : (contextFiles?.has(c.file) ? 0.12 : 0);
          const symBoost = explicitSymSliceKeys?.has(c.sliceKey)
            ? 0.55
            : (contextSymSliceKeys?.has(c.sliceKey) ? 0.30 : 0);
          const boost = fileBoost + symBoost;
          return boost > 0
            ? { ...c, rerankScore: Number(((c.rerankScore || 0) + boost).toFixed(5)) }
            : c;
        });
        pool.sort(
          (a, b) =>
            (b.rerankScore || 0) - (a.rerankScore || 0) ||
            (b.hybridScore || 0) - (a.hybridScore || 0) ||
            a.relPath.localeCompare(b.relPath)
        );
      } else {
        pool = reranked.results;
      }
      rerankElapsedMs = reranked.elapsedMs || 0;
      usedRerank = true;
    }
  }

  const top = applyMmr
    ? selectDiverseSlicesWithTelemetry(pool, { topK: maxResults, lambda })
    : pool.slice(0, maxResults);

  return {
    top,
    pool,
    chosen,
    usedRerank,
    rerankElapsedMs,
    lexScoreByFile,
  };
}

/**
 * Searches project code & symbols strictly in RAM, returning compact line-numbered snippets.
 */
export function searchWorkspace(
  engine,
  rootDir,
  query = '',
  { maxResults = 12, contextLines = 2, fastMode = false, _skipStats = false } = {}
) {
  if (!_skipStats) engine.stats.searches += 1;
  const t0 = performance.now();
  const ws = engine.ensureWarm(rootDir);
  if (!ws || typeof query !== 'string' || !query.trim()) {
    return { ok: false, results: [], formatted: 'Empty query or invalid workspace.' };
  }
  maxResults = Math.max(1, Math.min(50, Math.floor(Number(maxResults) || 12)));
  contextLines = Math.max(0, Math.min(20, Math.floor(Number(contextLines ?? 2) || 0)));

  const cpuCfg = fastMode
    ? { cpuTrigramIndex: Boolean(ws.trigramIndex?.size > 0), ramSotaEngines: true }
    : loadCpuConfig();
  const qInfo = expandQueryBilingualStems(query);
  const rawQueryTokens = new Set(extractSearchTokens(query));
  const ruLex = /[а-яё]/i.test(query) ? expandRuQueryToEnTerms(query, { maxTerms: 16 }) : { enTerms: [] };
  const qTokens = Array.from(new Set([...rawQueryTokens, ...qInfo.synonymTerms, ...ruLex.enTerms]));

  let csrConjSet = null;
  if (cpuCfg.ramSotaEngines !== false && ws.files.size > 0 && rawQueryTokens.size >= 2 && (!fastMode || ws.csrIndex)) {
    const csr = engine.ensureCsrIndex(ws);
    if (csr) {
      const rawArr = Array.from(rawQueryTokens).slice(0, 4);
      const csrFiles = rawArr.length >= 2
        ? csr.intersectTerms(rawArr)
        : csr.lookupTermFiles(rawArr[0]);
      if (csrFiles.length > 0) {
        csrConjSet = new Set(csrFiles);
      }
      engine.sotaStats.csrLookups += 1;
    }
  }

  const scoreMap = new Map();
  const tokIdfMap = new Map();
  const totalDocs = Math.max(1, ws.files.size);
  const avgLen = {
    pe: Math.max(1, (ws.fieldLenSums?.pe || 0) / totalDocs),
    sig: Math.max(1, (ws.fieldLenSums?.sig || 0) / totalDocs),
    body: Math.max(1, (ws.fieldLenSums?.body || 0) / totalDocs),
    doc: Math.max(1, (ws.fieldLenSums?.doc || 0) / totalDocs),
  };

  for (const tok of qTokens) {
    const postingMap = ws.fieldPostings?.get(tok);
    if (!postingMap || postingMap.size === 0) continue;
    const df = postingMap.size;
    const idf = Math.log(1 + (totalDocs - df + 0.5) / (df + 0.5));
    const tokWeight = rawQueryTokens.has(tok) ? 1.0 : 0.72;
    tokIdfMap.set(tok, idf * tokWeight);

    for (const [rel, tfRec] of postingMap.entries()) {
      const entry = ws.files.get(rel);
      if (!entry) continue;
      const fLen = entry.fieldLengths || { pe: 1, sig: 1, body: 1, doc: 1 };
      const isPacked = typeof tfRec === 'number';
      const peTf = isPacked ? (tfRec & 0x7f) : (tfRec?.pe || 0);
      const sigTf = isPacked ? ((tfRec >>> 7) & 0x7f) : (tfRec?.sig || 0);
      const bodyTf = isPacked ? ((tfRec >>> 14) & 0x7f) : (tfRec?.body || 0);
      const docTf = isPacked ? ((tfRec >>> 21) & 0x7f) : (tfRec?.doc || 0);
      let pseudoTf = 0;
      if (peTf > 0) {
        pseudoTf += BM25F_WEIGHTS.pe * (peTf / (1 - BM25F_B.pe + BM25F_B.pe * (fLen.pe / avgLen.pe)));
      }
      if (sigTf > 0) {
        pseudoTf += BM25F_WEIGHTS.sig * (sigTf / (1 - BM25F_B.sig + BM25F_B.sig * (fLen.sig / avgLen.sig)));
      }
      if (bodyTf > 0) {
        pseudoTf += BM25F_WEIGHTS.body * (bodyTf / (1 - BM25F_B.body + BM25F_B.body * (fLen.body / avgLen.body)));
      }
      if (docTf > 0) {
        pseudoTf += BM25F_WEIGHTS.doc * (docTf / (1 - BM25F_B.doc + BM25F_B.doc * (fLen.doc / avgLen.doc)));
      }
      if (pseudoTf > 0) {
        const bm25Tok = idf * tokWeight * ((pseudoTf * (BM25F_K1 + 1)) / (pseudoTf + BM25F_K1));
        scoreMap.set(rel, (scoreMap.get(rel) || 0) + bm25Tok);
      }
    }
  }

  // Trigram inverted index candidate narrowing & exact substring boost
  const rawNeedle = query.trim();
  const needleLower = rawNeedle.toLowerCase();
  const trigramNeedles = [];
  if (needleLower.length >= 3 && needleLower.length <= 64) {
    trigramNeedles.push(needleLower);
  }
  for (const part of needleLower.split(/\s+/)) {
    if (part.length >= 3 && part !== needleLower && trigramNeedles.length < 4) {
      trigramNeedles.push(part);
    }
  }

  if (cpuCfg.cpuTrigramIndex && ws.trigramIndex?.size > 0 && trigramNeedles.length > 0) {
    for (const subNeedle of trigramNeedles) {
      const qTris = Array.from(extractTrigrams(subNeedle, 24));
      if (qTris.length === 0) continue;
      const sets = [];
      let missingTri = false;
      for (const tri of qTris) {
        const s = ws.trigramIndex.get(tri);
        if (!s || s.size === 0) {
          missingTri = true;
          break;
        }
        sets.push(s);
      }
      if (missingTri) continue;
      sets.sort((a, b) => a.size - b.size);
      let candidates = Array.from(sets[0]);
      for (let si = 1; si < sets.length && candidates.length > 0; si++) {
        const nextSet = sets[si];
        candidates = candidates.filter((rel) => nextSet.has(rel));
      }
      candidates.sort((a, b) => {
        const aPath = a.toLowerCase().includes(subNeedle) ? 1 : 0;
        const bPath = b.toLowerCase().includes(subNeedle) ? 1 : 0;
        if (aPath !== bPath) return bPath - aPath;
        return (scoreMap.get(b) || 0) - (scoreMap.get(a) || 0);
      });
      const checkLimit = candidates.slice(0, fastMode ? 32 : 120);
      for (const rel of checkLimit) {
        const entry = ws.files.get(rel);
        const buf = entry?.buf;
        if (!entry || !buf) continue;
        const inPath = entry.relPath.toLowerCase().includes(subNeedle);
        let inBody = false;
        if (!inPath) {
          if (fastMode) {
            inBody =
              buf.indexOf(rawNeedle) !== -1 ||
              buf.indexOf(subNeedle) !== -1 ||
              (buf.byteLength <= 512 * 1024 && buf.toString('utf8').toLowerCase().includes(subNeedle));
          } else {
            inBody = buf.toString('utf8').toLowerCase().includes(subNeedle);
          }
        }
        if (inPath || inBody) {
          const boost = (subNeedle === needleLower ? 6.0 : 2.5) + (inPath ? 4.0 : 0);
          scoreMap.set(rel, (scoreMap.get(rel) || 0) + boost);
        }
      }
    }
  } else if (scoreMap.size === 0 && (!cpuCfg.cpuTrigramIndex || !ws.trigramIndex || ws.trigramIndex.size === 0 || trigramNeedles.length === 0)) {
    for (const entry of ws.files.values()) {
      const buf = entry?.buf;
      if (!buf) continue;
      const inPath = entry.relPath.toLowerCase().includes(needleLower);
      const inBody = !inPath && (
        fastMode
          ? (buf.indexOf(rawNeedle) !== -1 || buf.indexOf(needleLower) !== -1 || (buf.byteLength <= 256 * 1024 && buf.toString('utf8').toLowerCase().includes(needleLower)))
          : buf.toString('utf8').toLowerCase().includes(needleLower)
      );
      if (inPath || inBody) {
        scoreMap.set(entry.relPath, 1);
      }
    }
  }

  const isDocsQuery = /\b(?:docs?|readme|tutorial|guide|changelog|markdown|перевод|документац)\b/i.test(query);
  const hasNonAsciiQuery = /[^\x00-\x7f]/.test(query);
  const useCsrConjBoost = rawQueryTokens.size >= 2 && csrConjSet && csrConjSet.size > 0;
  const ranked = Array.from(scoreMap.entries())
    .map(([rel, bmScore]) => {
      const entry = ws.files.get(rel);
      const symBoost = (entry?.symbols || []).some((s) => s.signature?.toLowerCase().includes(needleLower)) ? 2.5 : 0;
      const revCount = ws.reverseDeps.get(rel)?.size || 0;
      const csrBoost = (useCsrConjBoost && csrConjSet.has(rel)) ? 1.25 : 0;
      let rawScore = bmScore + symBoost + csrBoost + Math.min(2, revCount * 0.2);
      if (!isDocsQuery && entry) {
        const lowRel = rel.toLowerCase();
        if ((entry.ext === '.md' || entry.ext === '.mdx' || entry.ext === '.rst') && /(?:^|\/)(?:docs|i18n|locales)\/([a-z]{2}(?:-[a-z]{2})?)\//i.test(lowRel)) {
          const locMatch = /(?:^|\/)(?:docs|i18n|locales)\/([a-z]{2}(?:-[a-z]{2})?)\//i.exec(lowRel);
          const loc = locMatch ? locMatch[1] : '';
          rawScore *= (!hasNonAsciiQuery && loc && loc !== 'en') ? 0.25 : 0.4;
        } else if ((entry.ext === '.md' || entry.ext === '.rst' || entry.ext === '.txt') && /(?:^|\/)docs\//i.test(lowRel)) {
          rawScore *= 0.65;
        } else if (CODE_EXTENSIONS.has(entry.ext) && !/(?:^|\/)(?:tests?|__tests__|docs_src)\//i.test(lowRel)) {
          rawScore *= 1.12;
        }
      }
      return { rel, entry, bm25fScore: bmScore, score: rawScore };
    })
    .filter((r) => r.entry)
    .sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel))
    .slice(0, fastMode ? maxResults : Math.max(maxResults * 2, 16));

  if (!_skipStats) {
    if (ranked.length > 0) engine.stats.hits += 1;
    else engine.stats.misses += 1;
  }

  const termsLower = qTokens.length > 0 ? qTokens : [needleLower];
  const topFastTokens = fastMode
    ? Array.from(tokIdfMap.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([tok]) => tok)
    : [];
  const mmrCandidates = [];

  for (const item of ranked) {
    const entry = item.entry;
    const buf = entry?.buf;
    if (!buf || !entry.lineOffsets) continue;
    let matchLine = 1;

    if (fastMode) {
      let bestSymScore = 0;
      for (const sym of entry.symbols || []) {
        const sigLower = `${sym.name || ''} ${sym.signature || ''}`.toLowerCase();
        let sScore = 0;
        if (needleLower.length >= 3 && sigLower.includes(needleLower)) sScore += 50;
        for (const tok of topFastTokens) {
          if (tok.length >= 3 && sigLower.includes(tok)) {
            sScore += (tokIdfMap.get(tok) || 1) + 2;
          }
        }
        if (sScore > bestSymScore) {
          bestSymScore = sScore;
          matchLine = sym.startLine || 1;
        }
      }
      if (bestSymScore === 0) {
        const rawProbes = [];
        if (rawNeedle.length >= 3 && rawNeedle.length <= 64) rawProbes.push(rawNeedle);
        for (const w of rawNeedle.match(/[A-Za-z_$][A-Za-z0-9_$]{2,}/g) || []) {
          if (rawProbes.length < 5 && !rawProbes.includes(w)) rawProbes.push(w);
        }
        for (const tok of topFastTokens) {
          if (tok.length >= 3 && rawProbes.length < 7 && !rawProbes.includes(tok)) rawProbes.push(tok);
        }
        let foundByte = -1;
        for (const probe of rawProbes) {
          const idx = buf.indexOf(probe);
          if (idx !== -1) {
            foundByte = idx;
            break;
          }
        }
        if (foundByte !== -1) {
          matchLine = offsetToLine1(entry.lineOffsets, foundByte);
        } else if (buf.byteLength <= 192 * 1024 && topFastTokens.length > 0) {
          const lowerTxt = buf.toString('utf8').toLowerCase();
          for (const tok of topFastTokens) {
            const cIdx = lowerTxt.indexOf(tok);
            if (cIdx !== -1) {
              let nl = 1;
              for (let k = 0; k < cIdx; k++) {
                if (lowerTxt.charCodeAt(k) === 10) nl++;
              }
              matchLine = nl;
              break;
            }
          }
        }
      }
    } else {
      const text = buf.toString('utf8');
      const lines = text.split(/\r?\n/);
      let bestLineScore = 0;
      const symLineSet = new Set((entry.symbols || []).map((s) => s.startLine));
      for (let i = 0; i < lines.length; i++) {
        const lowerLine = lines[i].toLowerCase();
        let lineScore = 0;
        if (needleLower.length >= 2 && lowerLine.includes(needleLower)) {
          lineScore += 100;
        }
        if (tokIdfMap.size > 0) {
          for (const [tok, idf] of tokIdfMap.entries()) {
            if (lowerLine.includes(tok)) {
              lineScore += idf;
            }
          }
        } else if (lineScore === 0 && termsLower.some((t) => lowerLine.includes(t))) {
          lineScore += 1;
        }
        if (lineScore > 0 && symLineSet.has(i + 1)) {
          lineScore += 1.5;
        }
        if (lineScore > bestLineScore) {
          bestLineScore = lineScore;
          matchLine = i + 1;
        }
      }
    }

    const startL = Math.max(1, Math.min(entry.lineCount, matchLine - contextLines));
    const endL = Math.max(startL, Math.min(entry.lineCount, matchLine + contextLines + 4));
    const snippet = sliceBufferLines(buf, entry.lineOffsets, startL, endL);

    mmrCandidates.push({
      entry,
      file: entry.relPath,
      relPath: entry.relPath,
      line: matchLine,
      startLine: startL,
      endLine: endL,
      score: Number(item.score.toFixed(2)),
      bm25fScore: Number(item.bm25fScore.toFixed(3)),
      snippetText: snippet,
    });
  }

  const selectedItems = fastMode
    ? mmrCandidates.slice(0, maxResults)
    : selectDiverseSlicesWithTelemetry(mmrCandidates, { topK: maxResults, lambda: 0.78 });

  const results = [];
  const formattedBlocks = [];
  for (const c of selectedItems) {
    engine._touchEntry(ws, c.entry);
    c.entry.hits += 1;
    results.push({
      file: c.file,
      line: c.line,
      startLine: c.startLine,
      endLine: c.endLine,
      score: c.score,
      bm25fScore: c.bm25fScore,
      snippet: c.snippetText,
    });
    formattedBlocks.push(`### \`${c.file}\` [L${c.startLine}-L${c.endLine}]\n\`\`\`\n${c.snippetText}\n\`\`\``);
  }

  const elapsedMs = Number((performance.now() - t0).toFixed(2));
  if (!_skipStats) {
    engine.recordCompletedOp('ram_search', {
      target: String(query || '').trim().slice(0, 48),
      latencyMs: elapsedMs,
    });
  }
  return {
    ok: true,
    mode: cpuCfg.cpuTrigramIndex ? 'trigram_bm25f' : 'bm25f',
    elapsedMs,
    totalMatches: scoreMap.size,
    results,
    formatted: formattedBlocks.length > 0 ? formattedBlocks.join('\n\n') : `No matches for "${query}" in RAM index (${ws.files.size} files).`,
  };
}

/**
 * Hybrid semantic + lexical search: uses GPU embeddings + in-RAM Buffer slicing.
 */
export async function searchWorkspaceSemantic(
  engine,
  rootDir,
  query = '',
  {
    maxResults = 6,
    contextLines = 2,
    reindexMissing = true,
    maxForegroundIndexFiles = 8,
    blockingFullIndex = false,
  } = {}
) {
  engine.stats.searches += 1;
  const ws = engine.ensureWarm(rootDir);
  if (!ws || typeof query !== 'string' || !query.trim()) {
    return { ok: false, results: [], formatted: 'Empty query or invalid workspace.' };
  }
  maxResults = Math.max(1, Math.min(50, Math.floor(Number(maxResults) || 6)));
  contextLines = Math.max(0, Math.min(20, Math.floor(Number(contextLines ?? 2) || 0)));

  const startEpoch = ws.epoch;
  const gpuCfg = loadGpuConfig();
  if (!gpuCfg.gpuEnabled || !gpuCfg.gpuSemanticSearch) {
    const lexOnly = searchWorkspace(engine, ws.absRoot, query, { maxResults, contextLines, _skipStats: true });
    if (lexOnly.results?.length > 0) engine.stats.hits += 1;
    else engine.stats.misses += 1;
    return { ...lexOnly, mode: 'lexical_fallback' };
  }

  let indexMeta = null;
  let semRes = null;
  try {
    if (reindexMissing) {
      const fgCap = blockingFullIndex ? 220 : Math.max(1, Math.min(32, Number(maxForegroundIndexFiles) || 8));
      indexMeta = await indexWorkspaceVectors(ws.absRoot, ws.files, { maxNewFiles: fgCap });
      if (
        !blockingFullIndex &&
        engine.workspaces.get(ws.wsKey) === ws &&
        ws.epoch === startEpoch &&
        indexMeta?.ok &&
        Number(indexMeta.indexedNow) >= fgCap &&
        ws.files.size > fgCap &&
        !ws.bgVectorWarmInFlight
      ) {
        ws.bgVectorWarmInFlight = true;
        Promise.resolve()
          .then(() => indexWorkspaceVectors(ws.absRoot, ws.files, { maxNewFiles: 220 }))
          .catch(() => {
            if (engine.errorStats) engine.errorStats.prefetch += 1;
          })
          .finally(() => {
            ws.bgVectorWarmInFlight = false;
          });
      }
    }

    semRes = await semanticSearchWorkspace(ws.absRoot, query, Math.max(maxResults * 3, 18));
  } catch (err) {
    if (engine.errorStats) engine.errorStats.gpu = (engine.errorStats.gpu || 0) + 1;
    const liveWs = engine.workspaces.get(ws.wsKey);
    if (!liveWs || liveWs !== ws || liveWs.epoch !== startEpoch || liveWs.files.size === 0) {
      engine.stats.misses += 1;
      return { ok: false, mode: 'lexical_fallback', results: [], formatted: 'Workspace unavailable during semantic search.', gpuError: err?.message || 'GPU semantic search error' };
    }
    const fb = searchWorkspace(engine, ws.absRoot, query, { maxResults, contextLines, _skipStats: true });
    if (fb.results?.length > 0) engine.stats.hits += 1;
    else engine.stats.misses += 1;
    engine.recordCompletedOp('ram_search', {
      target: String(query || '').trim().slice(0, 48),
      latencyMs: fb.elapsedMs || 0,
    });
    return { ...fb, mode: 'lexical_fallback', gpuError: err?.message || 'GPU semantic search error' };
  }

  const liveWs = engine.workspaces.get(ws.wsKey);
  if (!liveWs || liveWs !== ws || liveWs.epoch !== startEpoch || liveWs.files.size === 0) {
    engine.stats.misses += 1;
    return { ok: false, mode: 'evicted', results: [], formatted: 'Workspace cache was evicted during semantic search.' };
  }

  const lexRes = searchWorkspace(engine, ws.absRoot, query, {
    maxResults: Math.max(maxResults * 2, 12),
    contextLines: 0,
    _skipStats: true,
  });

  if (!semRes.ok || !Array.isArray(semRes.hits) || semRes.hits.length === 0) {
    const fullLex = contextLines === 0
      ? lexRes
      : buildReSlicedLexFallback(engine, ws, lexRes, maxResults, contextLines);
    if (fullLex.results?.length > 0) engine.stats.hits += 1;
    else engine.stats.misses += 1;
    return {
      ...fullLex,
      mode: 'lexical_fallback',
      gpuError: semRes.error || (semRes.empty ? 'Vector index empty' : undefined),
    };
  }

  const cpuCfg = loadCpuConfig();
  const { top, usedRerank, rerankElapsedMs } = fuseHybridCandidates(ws, {
    query,
    semList: semRes.hits,
    lexLists: [lexRes.results || []],
    bucketMode: 'bucket40',
    maxSemPerFile: 2,
    codeBias: 0.002,
    maxDepBoost: 0.008,
    simWeight: 0.005,
    maxResults,
    poolCap: Math.max(maxResults * 2, 12),
    lambda: 0.72,
    useRerank: Boolean(cpuCfg.cpuCrossRerank),
  });

  const results = [];
  const formattedBlocks = [];
  for (const item of top) {
    const buf = item.entry?.buf;
    if (!buf || !item.entry.lineOffsets) continue;
    engine._touchEntry(ws, item.entry);
    item.entry.hits += 1;
    const startL = Math.max(1, Math.min(item.entry.lineCount, item.startLine - contextLines));
    const endL = Math.max(startL, Math.min(item.entry.lineCount, item.endLine + contextLines));
    const snippet = sliceBufferLines(buf, item.entry.lineOffsets, startL, endL);
    results.push({
      file: item.relPath,
      startLine: startL,
      endLine: endL,
      similarity: item.similarity,
      hybridScore: item.hybridScore,
      rerankScore: item.rerankScore ?? item.hybridScore,
    });
    const cpuTag = usedRerank ? ` | cpu: ${item.rerankScore}` : '';
    const scoreTag = item.similarity > 0
      ? `*(sem: ${item.similarity} | rrf: ${item.hybridScore}${cpuTag})*`
      : `*(lex | rrf: ${item.hybridScore}${cpuTag})*`;
    formattedBlocks.push(
      `### \`${item.relPath}\` [L${startL}-L${endL}] ${scoreTag}\n\`\`\`\n${snippet}\n\`\`\``
    );
  }

  if (results.length > 0) engine.stats.hits += 1;
  else engine.stats.misses += 1;

  engine.recordCompletedOp('hybrid_search', {
    target: results[0]?.file || String(query || '').trim().slice(0, 48),
    latencyMs: Number(semRes.elapsedMs || 0) + Number(rerankElapsedMs || 0),
  });
  return {
    ok: true,
    mode: usedRerank ? 'hybrid_gpu_cpu_rerank' : 'hybrid_gpu_ram',
    model: semRes.model,
    elapsedMs: semRes.elapsedMs,
    rerankElapsedMs,
    usedRerank,
    indexedFiles: indexMeta?.totalFiles,
    totalChunksSearched: semRes.totalChunksSearched,
    results,
    formatted: formattedBlocks.join('\n\n'),
  };
}

/**
 * Fast synchronous-in-RAM Hybrid RRF Gold Context builder combining BM25-IDF lexical hits
 * with already-computed warm Qwen3 vector hits.
 */
export function buildHybridGoldContextImpl(
  engine,
  rootDir,
  query = '',
  warmSemanticHits = [],
  { maxResults = 4, contextLines = 3 } = {}
) {
  const ws = engine.getOrCreateWorkspace(rootDir);
  if (!ws || ws.files.size === 0 || !query || !query.trim()) {
    return { ok: false, results: [], formatted: '', usedSemantic: false };
  }

  engine.stats.searches += 1;
  const semList = Array.isArray(warmSemanticHits) ? warmSemanticHits : [];

  if (semList.length === 0) {
    const fullLex = searchWorkspace(engine, ws.absRoot, query, { maxResults, contextLines, _skipStats: true });
    if (!fullLex.ok || fullLex.results.length === 0) {
      engine.stats.misses += 1;
      return { ok: false, results: [], formatted: '', usedSemantic: false };
    }
    engine.stats.hits += 1;
    return { ...fullLex, usedSemantic: false };
  }

  const lexRes = searchWorkspace(engine, ws.absRoot, query, {
    maxResults: Math.max(maxResults * 2, 10),
    contextLines: 0,
    _skipStats: true,
  });

  const cpuCfg = loadCpuConfig();
  const { top, usedRerank, rerankElapsedMs } = fuseHybridCandidates(ws, {
    query,
    semList,
    lexLists: [lexRes.results || []],
    bucketMode: 'file',
    codeBias: 0.002,
    maxDepBoost: 0.008,
    simWeight: 0.005,
    maxResults,
    poolCap: Math.max(maxResults * 2, 10),
    lambda: 0.72,
    useRerank: Boolean(cpuCfg.cpuCrossRerank),
  });

  const results = [];
  const formattedBlocks = [];
  for (const item of top) {
    const buf = item.entry?.buf;
    if (!buf || !item.entry.lineOffsets) continue;
    engine._touchEntry(ws, item.entry);
    item.entry.hits += 1;
    const startL = Math.max(1, Math.min(item.entry.lineCount, item.startLine - contextLines));
    const endL = Math.max(startL, Math.min(item.entry.lineCount, item.endLine + contextLines));
    const snippet = sliceBufferLines(buf, item.entry.lineOffsets, startL, endL);
    results.push({
      file: item.relPath,
      startLine: startL,
      endLine: endL,
      similarity: item.similarity,
      hybridScore: item.hybridScore,
      rerankScore: item.rerankScore ?? item.hybridScore,
    });
    const cpuTag = usedRerank ? `|cpu:${item.rerankScore}` : '';
    const tag = item.similarity > 0 ? `(sem:${item.similarity}|rrf:${item.hybridScore}${cpuTag})` : `(lex|rrf:${item.hybridScore}${cpuTag})`;
    formattedBlocks.push(`// ${item.relPath} [L${startL}-L${endL}] ${tag}\n${snippet}`);
  }

  if (results.length > 0) engine.stats.hits += 1;
  else engine.stats.misses += 1;

  return {
    ok: results.length > 0,
    results,
    formatted: formattedBlocks.join('\n\n'),
    usedSemantic: true,
    usedRerank,
    rerankElapsedMs,
  };
}

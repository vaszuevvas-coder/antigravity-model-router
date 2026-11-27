/**
 * @file cpu-reranker.mjs
 * @description Zero-VRAM multi-signal CPU Cross-Reranker (< 15 ms over top-25 candidates).
 * Scores span proximity, camelCase/snake_case AST identifier match, RU/EN morphological roots,
 * export status, and reverse-dependency authority without calling external LLMs or using GPU VRAM.
 */

import { stemWord } from './repo-mapper.mjs';
import { loadCpuConfig, recordCpuInstantWork, recordCpuTelemetryPatch } from './cpu-worker-pool.mjs';
import { expandRuQueryToEnTerms } from './ru-en-lexicon.mjs';

const RU_EN_CONCEPTS = [
  [/(?:безопас|защит|фаервол|секрет|утеч|токен|env)/i, ['security', 'guard', 'firewall', 'secret', 'redact', 'env']],
  [/(?:кэш|памят|буфер|рам|ram|озу)/i, ['cache', 'memory', 'ram', 'buffer', 'evict', 'slice']],
  [/(?:поток|воркер|ядр|пул|параллел|многопоточ)/i, ['worker', 'thread', 'pool', 'cpu', 'parallel', 'batch']],
  [/(?:вектор|семант|смысл|эмбед|чанк)/i, ['vector', 'embed', 'semantic', 'chunk', 'int8', 'qwen']],
  [/(?:тест|проверк|синтакс|линтер|фазз|аудит)/i, ['test', 'verify', 'syntax', 'lint', 'fuzz', 'audit']],
  [/(?:состояни|настрой|конфиг|сохран|перезап)/i, ['state', 'config', 'save', 'patch', 'diff', 'overwrite']],
  [/(?:маршрут|модел|байес|довери|откат|хрупк)/i, ['route', 'model', 'bayesian', 'confidence', 'decay', 'fragility']],
  [/(?:ошибк|сбо[йя]|откат|чекпоинт|снимок|трасс)/i, ['error', 'rollback', 'checkpoint', 'shadow', 'pitfall', 'trace']],
  [/(?:панел|интерфейс|тем|кнопк|окн)/i, ['panel', 'ui', 'theme', 'server', 'sidecar']],
  [/(?:поиск|индекс|триграмм|ранжир|реранк|релевант)/i, ['search', 'index', 'trigram', 'bm25', 'rerank', 'rrf']],
  [/(?:сжати|компакц|дистилл|саммар)/i, ['compact', 'distill', 'summary', 'digest', 'compress']],
  [/(?:галлюцинац|заземлен|верификац|цитат|выдум)/i, ['hallucination', 'grounding', 'verify', 'audit', 'citation', 'unverified']],
  [/(?:чат|диалог|ответ|промпт|контекст|манифест)/i, ['chat', 'answer', 'prompt', 'context', 'rag', 'manifest']],
  [/(?:вероятност|калибровк|бандит|квантил|интервал|дисперс)/i, ['probability', 'calibration', 'bandit', 'quantile', 'lcb', 'posterior', 'variance']],
  [/(?:схем|формат|json|парс|грамматик)/i, ['schema', 'format', 'json', 'parse', 'grammar']],
  [/(?:таймер|таймаут|ретрай|повтор|отмен|фоллбэк)/i, ['timeout', 'retry', 'abort', 'signal', 'fallback']],
];

const NON_TEST_QUERY_GUARD = /\b(?:test|spec|fuzz|audit|e2e|benchmark|ddmin|verify)\b|тест|аудит|бенчмарк/i;

/**
 * Splits camelCase, PascalCase, snake_case, kebab-case, and paths into lowercase sub-tokens.
 * @param {string} input
 * @returns {string[]}
 */
export function splitIdentifierSubtokens(input = '') {
  if (!input || typeof input !== 'string') return [];
  const normalized = input
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase();
  return normalized.match(/[a-zа-яё0-9]{2,}/g) || [];
}

/**
 * Builds normalized query terms, sub-tokens, RU/EN morphological roots, and concept synonyms.
 * @param {string} query
 */
export function expandQueryBilingualStems(query = '') {
  const raw = String(query || '').trim();
  const rawLower = raw.toLowerCase();
  const subTokens = [];
  const seenSub = new Set();
  const stems = [];
  const seenStem = new Set();

  for (const tok of splitIdentifierSubtokens(raw)) {
    if (tok.length > 48) continue;
    if (!seenSub.has(tok)) {
      seenSub.add(tok);
      subTokens.push(tok);
    }
    const st = stemWord(tok);
    if (st && st.length >= 3 && !seenStem.has(st)) {
      seenStem.add(st);
      stems.push(st);
    }
  }

  const synonymTerms = [];
  const seenSyn = new Set();
  for (const [re, enWords] of RU_EN_CONCEPTS) {
    if (re.test(rawLower)) {
      for (const w of enWords) {
        if (!seenSub.has(w) && !seenSyn.has(w)) {
          seenSyn.add(w);
          synonymTerms.push(w);
        }
      }
    }
  }
  const lexExp = expandRuQueryToEnTerms(rawLower, { maxTerms: 24 });
  for (const w of lexExp.enTerms) {
    if (!seenSub.has(w) && !seenSyn.has(w)) {
      seenSyn.add(w);
      synonymTerms.push(w);
    }
  }

  const allConcepts = [];
  const seenConcept = new Set();
  for (const group of [subTokens, stems, synonymTerms]) {
    for (const c of group) {
      if (!seenConcept.has(c)) {
        seenConcept.add(c);
        allConcepts.push(c);
      }
    }
  }

  // Exact identifier-like terms (>= 3 chars) from the raw query for exact signature match bonus
  const rawIdentifiers = (rawLower.match(/[a-zа-яё0-9_]{3,}/g) || []).slice(0, 12);
  return {
    rawLower,
    rawIdentifiers,
    subTokens: subTokens.slice(0, 24),
    stems: stems.slice(0, 24),
    synonymTerms: synonymTerms.slice(0, 28),
    allConcepts: allConcepts.slice(0, 40),
  };
}

function normalizeSymbolLabel(sym) {
  if (!sym) return '';
  if (typeof sym === 'string') return sym;
  return `${sym.name || ''} ${sym.signature || ''}`.trim();
}

/**
 * Re-ranks top hybrid search candidates purely on CPU using AST, proximity, and structural signals.
 * @param {string} query
 * @param {Array<object>} candidates
 * @param {{ topK?: number, maxCandidates?: number, skipTelemetry?: boolean }} [options={}]
 */
export function rerankCandidates(query = '', candidates = [], options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const topK = Math.max(1, Math.min(100, Math.floor(Number(opts.topK) || 6)));
  const maxCandidates = opts.maxCandidates ?? 25;
  const skipTelemetry = Boolean(opts.skipTelemetry);
  const t0 = performance.now();
  const validCandidates = Array.isArray(candidates) ? candidates.filter((c) => c && typeof c === 'object') : [];
  if (validCandidates.length === 0) {
    return { ok: true, results: [], elapsedMs: 0, rerankedCount: 0, vramUsedMb: 0 };
  }

  const slice = validCandidates.slice(0, Math.max(1, Math.min(40, Number(maxCandidates) || 25)));
  const qInfo = expandQueryBilingualStems(query);
  const queryWantsTests = NON_TEST_QUERY_GUARD.test(query);

  let maxRrf = 0;
  let maxBm25 = 0;
  for (const c of slice) {
    if ((c.rrfScore || c.hybridScore || 0) > maxRrf) maxRrf = c.rrfScore || c.hybridScore || 0;
    if ((c.bm25fScore || 0) > maxBm25) maxBm25 = c.bm25fScore || 0;
  }

  const scored = slice.map((c) => {
    const relPath = String(c.relPath || c.file || '');
    const normalizedForPenalty = relPath
      .replace(/\\/g, '/')
      .replace(/^.*?\/\.gemini\/antigravity(?:-ide|-cli)?\/scratch\/[^/]+\//i, '');
    const pathLower = relPath.toLowerCase();
    const relLower = normalizedForPenalty.toLowerCase();
    const snippet = String(c.snippetText || '');
    const snippetLines = snippet ? snippet.split(/\r?\n/).slice(0, 90) : [];
    const snippetLower = snippetLines.join('\n').toLowerCase();

    // 1. First-stage fused base score (0 .. 0.35)
    const rrfNorm = maxRrf > 0 ? ((c.rrfScore || c.hybridScore || 0) / maxRrf) : 0;
    const simNorm = Math.max(0, Math.min(1, Number(c.similarity) || 0));
    const bmNorm = maxBm25 > 0 ? ((c.bm25fScore || 0) / maxBm25) : 0;
    const baseSignal = (rrfNorm * 0.16) + (simNorm * 0.11) + (bmNorm * 0.08);

    // 2. Span proximity & exact phrase density across candidate snippet lines (0 .. 0.28)
    const conceptPositions = new Map();
    const matchedConcepts = new Set();
    for (let li = 0; li < snippetLines.length; li++) {
      const lineLower = snippetLines[li].toLowerCase();
      for (let ci = 0; ci < qInfo.allConcepts.length; ci++) {
        const concept = qInfo.allConcepts[ci];
        let matched = false;
        if (concept.length <= 3) {
          let idx = lineLower.indexOf(concept);
          while (idx !== -1) {
            const beforeOk = idx === 0 || !/[a-zа-яё0-9_]/i.test(lineLower[idx - 1]);
            const afterPos = idx + concept.length;
            const afterOk = afterPos >= lineLower.length || !/[a-zа-яё0-9_]/i.test(lineLower[afterPos]);
            if (beforeOk && afterOk) {
              matched = true;
              break;
            }
            idx = lineLower.indexOf(concept, idx + 1);
          }
        } else {
          matched = lineLower.includes(concept);
        }
        if (matched) {
          matchedConcepts.add(concept);
          if (!conceptPositions.has(ci)) conceptPositions.set(ci, []);
          conceptPositions.get(ci).push(li);
        }
      }
    }

    let minSpan = 999;
    const activeArrays = Array.from(conceptPositions.values());
    if (activeArrays.length >= 2) {
      for (let a = 0; a < Math.min(activeArrays.length, 6); a++) {
        for (const posA of activeArrays[a]) {
          for (let b = a + 1; b < Math.min(activeArrays.length, 6); b++) {
            for (const posB of activeArrays[b]) {
              const span = Math.abs(posA - posB);
              if (span < minSpan) minSpan = span;
              if (minSpan === 0) break;
            }
            if (minSpan === 0) break;
          }
        }
      }
    }
    const proximityRatio = activeArrays.length >= 2
      ? (1 / (1 + Math.max(0, minSpan)))
      : (activeArrays.length === 1 ? 0.25 : 0);
    const exactPhraseBonus = (qInfo.rawLower.length >= 4 && snippetLower.includes(qInfo.rawLower)) ? 0.10 : 0;
    const proximitySignal = Math.min(0.28, (proximityRatio * 0.18) + exactPhraseBonus);

    // 3. AST Signature & Path Match (0 .. 0.25)
    const startLine = Number(c.startLine) || 1;
    const endLine = Number(c.endLine) || 999999;
    const syms = Array.isArray(c.symbols) ? c.symbols : [];
    const localSyms = syms.filter((s) => {
      if (typeof s === 'object' && s && Number.isFinite(s.startLine)) {
        return (s.endLine || s.startLine) >= startLine - 5 && s.startLine <= endLine + 5;
      }
      return true;
    });
    const symLabels = localSyms.map(normalizeSymbolLabel).join(' ').toLowerCase();
    const symSubTokens = new Set(splitIdentifierSubtokens(symLabels));
    const pathSubTokens = new Set(splitIdentifierSubtokens(pathLower));

    let astScore = 0;
    let exactIdMatched = false;
    for (const rawId of qInfo.rawIdentifiers) {
      if (symLabels.includes(rawId) || pathLower.includes(rawId)) {
        exactIdMatched = true;
        break;
      }
    }
    if (exactIdMatched) astScore += 0.14;

    let symPathHits = 0;
    for (const sub of qInfo.allConcepts) {
      if (symSubTokens.has(sub) || pathSubTokens.has(sub)) symPathHits += 1;
    }
    if (qInfo.allConcepts.length > 0 && symPathHits > 0) {
      astScore += Math.min(0.11, (symPathHits / Math.min(qInfo.allConcepts.length, 4)) * 0.11);
    }
    astScore = Math.min(0.25, astScore);

    // 4. Morphological root & bilingual concept coverage (0 .. 0.18)
    const coveragePool = qInfo.allConcepts.length > 0 ? qInfo.allConcepts : [];
    for (const sub of coveragePool) {
      if (!matchedConcepts.has(sub) && (pathLower.includes(sub) || symLabels.includes(sub))) {
        matchedConcepts.add(sub);
      }
    }
    const coverageRatio = coveragePool.length > 0
      ? Math.min(1, matchedConcepts.size / Math.min(coveragePool.length, 6))
      : 0;
    const morphSignal = coverageRatio * 0.18;

    // 5. Export & Reverse-Deps Graph Authority (-0.04 .. +0.14)
    const exportedList = Array.isArray(c.exportedSymbols) ? c.exportedSymbols : [];
    const exportedLower = exportedList.map((e) => String(e || '').toLowerCase());
    const hasExportMatch = exportedLower.some((ex) =>
      qInfo.rawIdentifiers.some((id) => ex.includes(id)) ||
      qInfo.subTokens.some((sub) => ex.includes(sub))
    );
    const revCount = Number(c.reverseDepsCount) || 0;
    const graphBonus = (hasExportMatch ? 0.06 : 0) + Math.min(0.08, Math.log1p(revCount) * 0.025);
    const isTestOrScratch = /(?:^|\/)(?:scratch|test|tests|__tests__|fixtures)\/|\.(?:test|spec)\./i.test(relLower);
    const testPenalty = (!queryWantsTests && isTestOrScratch) ? -0.04 : 0;

    const totalScore = Math.max(0, baseSignal + proximitySignal + astScore + morphSignal + graphBonus + testPenalty);

    return {
      ...c,
      rerankScore: Number(totalScore.toFixed(5)),
    };
  });

  scored.sort((a, b) =>
    b.rerankScore - a.rerankScore
    || (b.hybridScore || 0) - (a.hybridScore || 0)
    || String(a.relPath || a.file || '').localeCompare(String(b.relPath || b.file || ''))
  );

  const elapsedMs = Number((performance.now() - t0).toFixed(2));
  if (!skipTelemetry && loadCpuConfig().cpuCrossRerank) {
    recordCpuTelemetryPatch((cur) => ({
      ...cur,
      rerankCalls: (cur.rerankCalls || 0) + 1,
      lastRerankMs: elapsedMs,
      lastAt: new Date().toISOString(),
    }));
    recordCpuInstantWork({
      op: 'cross_rerank',
      workers: 1,
      items: slice.length,
      detail: `Cross-Reranker · ${slice.length} канд.`,
      latencyMs: elapsedMs,
    });
  }

  return {
    ok: true,
    results: scored.slice(0, topK),
    elapsedMs,
    rerankedCount: slice.length,
    vramUsedMb: 0,
  };
}

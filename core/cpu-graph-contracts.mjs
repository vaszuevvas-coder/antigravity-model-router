/**
 * @file cpu-graph-contracts.mjs
 * @description Zero-VRAM CPU graph, co-change, contract arity, and SimHash clone engines:
 *   1. Multi-Signal Bipartite Symbol Personalized PageRank (`computeBipartiteSymbolPPR`)
 *   2. Git Evolutionary Co-Change Coupling (`mineGitCoChangeGraph`, `queryCoChangePartners`)
 *   3. Cross-File Function Arity & Destructured-Key Contract Guard (`verifyExportArityAndKeyContracts`)
 *   4. 64-Bit AST-Normalized Shingle SimHash Clone Radar (`computeFileSimHashes`, `buildWorkspaceSimHashIndex`, `findNearDuplicateFunctions`)
 */

import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { extractFileSymbolsWithRanges } from './repo-mapper.mjs';
import { buildSymbolCallGraph } from './cpu-ast-graph-compressor.mjs';
import { expandQueryBilingualStems } from './cpu-reranker.mjs';

const COCHANGE_CACHE = new Map(); // absRootKey -> { ts, headMtimeMs, totalCommits, fileWeight, pairs }
const COCHANGE_TTL_MS = 5 * 60 * 1000;

const SIMHASH_KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue',
  'try', 'catch', 'finally', 'throw', 'return', 'new', 'typeof', 'instanceof', 'delete',
  'void', 'await', 'yield', 'async', 'function', 'class', 'const', 'let', 'var', 'import',
  'export', 'from', 'as', 'in', 'of', 'true', 'false', 'null', 'undefined', 'this', 'super',
  'def', 'elif', 'except', 'with', 'lambda', 'pass', 'raise', 'None', 'True', 'False',
]);

function normRootKey(rootDir = '') {
  const abs = path.resolve(rootDir || '.');
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

function toPosixRel(p = '', absRoot = '') {
  if (!p || typeof p !== 'string') return '';
  let rel = p;
  if (path.isAbsolute(p) && absRoot) {
    rel = path.relative(absRoot, p);
  }
  return rel.replace(/\\/g, '/').replace(/^\.\//, '');
}

// ============================================================================
// 1. Multi-Signal Bipartite Symbol Personalized PageRank (PPR)
// ============================================================================

/**
 * Computes Personalized PageRank over the repository symbol call graph + co-change edges
 * using a Float64Array power iteration seeded by query concepts, dirty files, and fault files.
 * Surfaces 2..3-hop structural bridge symbols not directly matched by lexical search.
 */
export function computeBipartiteSymbolPPR(
  filesMap,
  symbolGraph = null,
  {
    query = '',
    dirtyFiles = [],
    faultFiles = [],
    coChangeGraph = null,
    damping = 0.72,
    iterations = 12,
    topK = 6,
  } = {}
) {
  const t0 = performance.now();
  const graph = symbolGraph && symbolGraph.definedSymbols ? symbolGraph : buildSymbolCallGraph(filesMap);
  const defined = graph?.definedSymbols;
  if (!defined || defined.size === 0) {
    return { ok: true, rankedSymbols: [], bridgeNodes: [], elapsedMs: 0, formattedHint: '' };
  }

  const nodes = [];
  const keyToId = new Map();
  const nameToIds = new Map();
  const fileToIds = new Map();

  for (const [, list] of defined.entries()) {
    for (const s of list) {
      if (!s || !s.file || !s.name || s.kind === 'class') continue;
      const key = `${s.file}#${s.name}:${s.startLine || 1}`;
      if (keyToId.has(key)) continue;
      const id = nodes.length;
      nodes.push({
        id,
        name: s.name,
        file: s.file,
        kind: s.kind || 'function',
        signature: s.signature || s.name,
        startLine: Number(s.startLine) || 1,
        endLine: Number(s.endLine) || Number(s.startLine) || 1,
      });
      keyToId.set(key, id);

      let nIds = nameToIds.get(s.name);
      if (!nIds) {
        nIds = [];
        nameToIds.set(s.name, nIds);
      }
      nIds.push(id);

      let fIds = fileToIds.get(s.file);
      if (!fIds) {
        fIds = [];
        fileToIds.set(s.file, fIds);
      }
      fIds.push(id);
    }
  }

  const V = nodes.length;
  if (V === 0) {
    return { ok: true, rankedSymbols: [], bridgeNodes: [], elapsedMs: 0, formattedHint: '' };
  }

  const adj = Array.from({ length: V }, () => new Map());
  const addWeightedEdge = (u, v, w) => {
    if (u === v || u < 0 || v < 0 || u >= V || v >= V || w <= 0) return;
    adj[u].set(v, (adj[u].get(v) || 0) + w);
  };

  // Call graph edges (forward 1.0, backward 0.68 to trace 2..3-hop caller/callee bridges)
  if (graph.callersOf) {
    for (const [calleeName, callersBucket] of graph.callersOf.entries()) {
      const calleeIds = nameToIds.get(calleeName);
      if (!calleeIds || calleeIds.length === 0) continue;
      for (const callerEdge of callersBucket.values()) {
        if (!callerEdge?.name || !callerEdge?.file) continue;
        const callerCandidates = (nameToIds.get(callerEdge.name) || []).filter((cid) => nodes[cid].file === callerEdge.file);
        const targetIds = callerCandidates.length > 0 ? callerCandidates : (fileToIds.get(callerEdge.file) || []).slice(0, 1);
        for (const u of targetIds) {
          for (const v of calleeIds) {
            addWeightedEdge(u, v, 1.0);
            addWeightedEdge(v, u, 0.68);
          }
        }
      }
    }
  }

  // Light intra-file structural linkage so multi-symbol files propagate across boundaries
  for (const fIds of fileToIds.values()) {
    if (fIds.length < 2 || fIds.length > 16) continue;
    for (let i = 0; i < fIds.length - 1; i++) {
      addWeightedEdge(fIds[i], fIds[i + 1], 0.28);
      addWeightedEdge(fIds[i + 1], fIds[i], 0.28);
    }
  }

  // Optional Git Co-Change cross-layer bridge edges
  if (coChangeGraph?.pairs instanceof Map) {
    for (const [fileA, partners] of coChangeGraph.pairs.entries()) {
      const idsA = fileToIds.get(fileA);
      if (!idsA || idsA.length === 0) continue;
      for (const p of partners) {
        if ((p.confidence || 0) < 0.45) continue;
        const idsB = fileToIds.get(p.file);
        if (!idsB || idsB.length === 0) continue;
        addWeightedEdge(idsA[0], idsB[0], p.confidence * 0.55);
      }
    }
  }

  const dirtySet = new Set((Array.isArray(dirtyFiles) ? dirtyFiles : []).map((f) => toPosixRel(f)));
  const faultSet = new Set((Array.isArray(faultFiles) ? faultFiles : []).map((f) => toPosixRel(f)));
  const qInfo = expandQueryBilingualStems(query || '');
  const qConcepts = (qInfo?.allConcepts || []).filter((c) => c && c.length >= 2);

  const p = new Float64Array(V);
  let pSum = 0;
  const seedFiles = new Set();

  for (let i = 0; i < V; i++) {
    const n = nodes[i];
    const nameLow = n.name.toLowerCase();
    const fileLow = n.file.toLowerCase();
    const baseLow = path.posix.basename(fileLow, path.posix.extname(fileLow));
    let w = 0;

    for (const tok of qConcepts) {
      if (nameLow === tok || baseLow === tok) {
        w += 5.0;
      } else if (tok.length >= 3 && (nameLow.includes(tok) || fileLow.includes(tok))) {
        w += 2.0;
      }
    }
    if (dirtySet.has(n.file)) w += 2.5;
    if (faultSet.has(n.file)) w += 3.5;

    if (w > 0) {
      p[i] = w;
      pSum += w;
      seedFiles.add(n.file);
    }
  }

  if (pSum <= 0) {
    return {
      ok: true,
      rankedSymbols: [],
      bridgeNodes: [],
      elapsedMs: Number((performance.now() - t0).toFixed(2)),
      formattedHint: '',
    };
  }

  for (let i = 0; i < V; i++) p[i] /= pSum;

  const outList = Array.from({ length: V }, (_, u) => {
    const m = adj[u];
    const targets = [];
    const weights = [];
    let total = 0;
    for (const [v, w] of m.entries()) {
      targets.push(v);
      weights.push(w);
      total += w;
    }
    return { targets, weights, total };
  });

  let r = new Float64Array(p);
  let next = new Float64Array(V);
  const alpha = Math.max(0.1, Math.min(0.95, Number(damping) || 0.72));
  const steps = Math.max(2, Math.min(30, Number(iterations) || 12));

  for (let it = 0; it < steps; it++) {
    next.fill(0);
    let dangling = 0;
    for (let u = 0; u < V; u++) {
      const ru = r[u];
      if (ru <= 0) continue;
      const out = outList[u];
      if (out.total <= 0) {
        dangling += ru;
        continue;
      }
      const scale = (alpha * ru) / out.total;
      for (let k = 0; k < out.targets.length; k++) {
        next[out.targets[k]] += scale * out.weights[k];
      }
    }
    const teleScale = 1 - alpha + alpha * dangling;
    for (let v = 0; v < V; v++) {
      if (p[v] > 0) next[v] += teleScale * p[v];
    }
    const tmp = r;
    r = next;
    next = tmp;
  }

  const rankedSymbols = [];
  const bridgeNodes = [];
  const order = Array.from({ length: V }, (_, i) => i).sort((a, b) => r[b] - r[a]);

  for (const idx of order) {
    const score = r[idx];
    if (score <= 1e-6) break;
    const node = nodes[idx];
    const entry = {
      name: node.name,
      file: node.file,
      kind: node.kind,
      signature: node.signature,
      startLine: node.startLine,
      endLine: node.endLine,
      pprScore: Number(score.toFixed(6)),
      isSeed: p[idx] > 0,
    };
    if (rankedSymbols.length < topK) rankedSymbols.push(entry);
    if (!entry.isSeed && !seedFiles.has(node.file) && bridgeNodes.length < topK) {
      bridgeNodes.push(entry);
    }
  }

  const formattedHint = bridgeNodes.length > 0
    ? `🌉 [CPU PPR Bridges] ${bridgeNodes.slice(0, 4).map((b) => `${b.name} (${b.file}:${b.startLine})`).join(' -> ')}`
    : '';

  return {
    ok: true,
    rankedSymbols,
    bridgeNodes,
    elapsedMs: Number((performance.now() - t0).toFixed(2)),
    formattedHint,
  };
}

// ============================================================================
// 2. Git Evolutionary Co-Change Coupling
// ============================================================================

function getGitHeadMtimeMs(absRoot) {
  let maxMt = 0;
  for (const rel of ['.git/HEAD', '.git/index', '.git/logs/HEAD']) {
    try {
      const st = statSync(path.join(absRoot, rel));
      if (st.mtimeMs > maxMt) maxMt = st.mtimeMs;
    } catch {}
  }
  return maxMt;
}

/**
 * Mines recent git commits with exponential commit-age decay to discover implicitly coupled files
 * (e.g. HTML templates <-> backend handlers, config schemas <-> docs) invisible to static AST imports.
 */
export function mineGitCoChangeGraph(rootDir, { maxCommits = 200, halfLifeCommits = 60, maxFilesPerCommit = 25 } = {}) {
  const absRoot = path.resolve(rootDir || '.');
  const cacheKey = normRootKey(absRoot);
  const now = Date.now();
  const headMtimeMs = getGitHeadMtimeMs(absRoot);

  const cached = COCHANGE_CACHE.get(cacheKey);
  if (cached && now - cached.ts < COCHANGE_TTL_MS && cached.headMtimeMs === headMtimeMs) {
    return cached;
  }

  if (!existsSync(path.join(absRoot, '.git'))) {
    const empty = { ok: false, ts: now, headMtimeMs, totalCommits: 0, fileWeight: new Map(), rawCoCount: new Map(), pairs: new Map() };
    COCHANGE_CACHE.set(cacheKey, empty);
    return empty;
  }

  let rawLog = '';
  try {
    rawLog = execFileSync(
      'git',
      ['--no-pager', 'log', `-n${Math.max(10, Math.min(500, maxCommits))}`, '--name-only', '--pretty=format:__AMR_C__'],
      { cwd: absRoot, encoding: 'utf8', timeout: 1500, maxBuffer: 4 * 1024 * 1024, windowsHide: true }
    );
  } catch {
    const empty = { ok: false, ts: now, headMtimeMs, totalCommits: 0, fileWeight: new Map(), rawCoCount: new Map(), pairs: new Map() };
    COCHANGE_CACHE.set(cacheKey, empty);
    return empty;
  }

  const fileWeight = new Map();
  const pairWeight = new Map(); // "A\0B" -> decayed weight
  const rawCoCount = new Map(); // "A\0B" -> integer count
  const commits = rawLog.split('__AMR_C__').map((blk) =>
    Array.from(new Set(blk.split(/\r?\n/).map((l) => l.trim().replace(/\\/g, '/')).filter(Boolean)))
  ).filter((files) => files.length >= 2 && files.length <= maxFilesPerCommit);

  commits.forEach((files, commitIdx) => {
    const w = Math.pow(0.5, commitIdx / Math.max(10, halfLifeCommits));
    for (const f of files) {
      fileWeight.set(f, (fileWeight.get(f) || 0) + w);
    }
    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        const a = files[i] < files[j] ? files[i] : files[j];
        const b = files[i] < files[j] ? files[j] : files[i];
        const key = `${a}\0${b}`;
        pairWeight.set(key, (pairWeight.get(key) || 0) + w);
        rawCoCount.set(key, (rawCoCount.get(key) || 0) + 1);
      }
    }
  });

  const pairs = new Map();
  const pushPartner = (src, dst, conf, count, decayedWeight) => {
    let arr = pairs.get(src);
    if (!arr) {
      arr = [];
      pairs.set(src, arr);
    }
    arr.push({ file: dst, confidence: Number(conf.toFixed(3)), coCommits: count, weight: Number(decayedWeight.toFixed(3)) });
  };

  for (const [key, wAB] of pairWeight.entries()) {
    const sep = key.indexOf('\0');
    const a = key.slice(0, sep);
    const b = key.slice(sep + 1);
    const count = rawCoCount.get(key) || 0;
    const wA = fileWeight.get(a) || 1;
    const wB = fileWeight.get(b) || 1;
    pushPartner(a, b, wAB / wA, count, wAB);
    pushPartner(b, a, wAB / wB, count, wAB);
  }

  for (const arr of pairs.values()) {
    arr.sort((x, y) => y.confidence - x.confidence || y.coCommits - x.coCommits || x.file.localeCompare(y.file));
  }

  const result = { ok: true, ts: now, headMtimeMs, totalCommits: commits.length, fileWeight, rawCoCount, pairs };
  if (COCHANGE_CACHE.size > 16) COCHANGE_CACHE.clear();
  COCHANGE_CACHE.set(cacheKey, result);
  return result;
}

/**
 * Queries implicitly co-changed partners for a target file, excluding static importers when requested.
 */
export function queryCoChangePartners(
  rootDir,
  targetRelPath = '',
  { topK = 4, excludeStaticImporters = new Set(), maxCommits = 200, minSupport = 2, minConfidence = 0.42 } = {}
) {
  const absRoot = path.resolve(rootDir || '.');
  const normTarget = toPosixRel(targetRelPath, absRoot);
  if (!normTarget) {
    return { ok: false, partners: [], implicitPartners: [], formattedHint: '' };
  }

  const graph = mineGitCoChangeGraph(absRoot, { maxCommits });
  if (!graph.ok) {
    return { ok: false, partners: [], implicitPartners: [], formattedHint: '' };
  }

  const excludeSet = new Set(
    Array.from(excludeStaticImporters || []).map((f) => toPosixRel(f, absRoot).toLowerCase())
  );
  const raw = graph.pairs.get(normTarget) || [];
  const partners = raw.filter((p) => p.coCommits >= minSupport && p.confidence >= minConfidence).slice(0, topK * 2);
  const implicitPartners = partners.filter((p) => !excludeSet.has(p.file.toLowerCase())).slice(0, topK);

  const formattedHint = implicitPartners.length > 0
    ? `🔗 [Git Co-Change] Implicitly coupled with ${path.posix.basename(normTarget)}: ${implicitPartners.map((p) => `${p.file} (${Math.round(p.confidence * 100)}%)`).join(', ')}`
    : '';

  return { ok: true, partners: partners.slice(0, topK), implicitPartners, formattedHint };
}

// ============================================================================
// 3. Cross-File Function Arity & Destructured-Key Contract Guard
// ============================================================================

function splitTopLevel(str = '', sep = ',') {
  const parts = [];
  let cur = '';
  let paren = 0;
  let brace = 0;
  let bracket = 0;
  let quote = '';

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (quote) {
      cur += ch;
      if (ch === '\\' && i + 1 < str.length) {
        cur += str[++i];
      } else if (ch === quote) {
        quote = '';
      }
      continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === '(') paren++;
    else if (ch === ')') paren = Math.max(0, paren - 1);
    else if (ch === '{') brace++;
    else if (ch === '}') brace = Math.max(0, brace - 1);
    else if (ch === '[') bracket++;
    else if (ch === ']') bracket = Math.max(0, bracket - 1);
    else if (ch === sep && paren === 0 && brace === 0 && bracket === 0) {
      parts.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

function findMatchingDelimiter(text, openIdx, openCh, closeCh) {
  let depth = 0;
  let quote = '';
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      if (nl === -1) return -1;
      i = nl;
      continue;
    }
    if (ch === openCh) depth++;
    else if (ch === closeCh) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function stripParamDefaultAndType(param = '') {
  let depthParen = 0;
  let depthBrace = 0;
  let depthBracket = 0;
  let quote = '';
  let eqIdx = -1;
  let colonIdx = -1;
  for (let i = 0; i < param.length; i++) {
    const ch = param[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '(') depthParen++;
    else if (ch === ')') depthParen--;
    else if (ch === '{') depthBrace++;
    else if (ch === '}') depthBrace--;
    else if (ch === '[') depthBracket++;
    else if (ch === ']') depthBracket--;
    else if (depthParen === 0 && depthBrace === 0 && depthBracket === 0) {
      if (ch === '=' && eqIdx === -1) eqIdx = i;
      if (ch === ':' && colonIdx === -1 && eqIdx === -1) colonIdx = i;
    }
  }
  const hasDefault = eqIdx !== -1;
  const beforeDefault = (hasDefault ? param.slice(0, eqIdx) : param).trim();
  const basePattern = (colonIdx !== -1 ? beforeDefault.slice(0, colonIdx) : beforeDefault).trim();
  return { basePattern, hasDefault };
}

function parseExportedFunctionContracts(editedText = '') {
  const contracts = new Map();
  const declRe = /export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/g;
  const arrowRe = /export\s+(?:const|let)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s+)?\(/g;

  const parseOne = (fnName, openParenIdx) => {
    const closeIdx = findMatchingDelimiter(editedText, openParenIdx, '(', ')');
    if (closeIdx === -1) return;
    const rawParams = editedText.slice(openParenIdx + 1, closeIdx).trim();
    const bodyStart = editedText.indexOf('{', closeIdx);
    const bodyEnd = bodyStart !== -1 ? findMatchingDelimiter(editedText, bodyStart, '{', '}') : -1;
    const bodySnippet = bodyStart !== -1 && bodyEnd !== -1 ? editedText.slice(bodyStart, bodyEnd + 1) : '';
    const usesArguments = /\barguments\b/.test(bodySnippet);

    if (!rawParams) {
      contracts.set(fnName, { name: fnName, minArgs: 0, maxArgs: usesArguments ? Infinity : 0, requiredKeys: [] });
      return;
    }

    const params = splitTopLevel(rawParams, ',').filter((p) => p && !/^this\b/.test(p));
    let minArgs = 0;
    let maxArgs = usesArguments ? Infinity : params.length;
    let sawOptional = false;
    const requiredKeys = [];

    params.forEach((rawP, idx) => {
      const { basePattern, hasDefault } = stripParamDefaultAndType(rawP);
      const isRest = basePattern.startsWith('...');
      const isOptTs = basePattern.endsWith('?');
      if (isRest) {
        maxArgs = Infinity;
        sawOptional = true;
        return;
      }
      if (!sawOptional && !hasDefault && !isOptTs) {
        minArgs++;
      } else {
        sawOptional = true;
      }
      if (idx === 0 && !hasDefault && basePattern.startsWith('{') && basePattern.endsWith('}')) {
        const inner = basePattern.slice(1, -1).trim();
        for (const prop of splitTopLevel(inner, ',')) {
          if (!prop || prop.startsWith('...')) continue;
          const propRes = stripParamDefaultAndType(prop);
          if (propRes.hasDefault) continue;
          const keyMatch = propRes.basePattern.match(/^([A-Za-z0-9_$]+)/);
          if (keyMatch) requiredKeys.push(keyMatch[1]);
        }
      }
    });

    contracts.set(fnName, { name: fnName, minArgs, maxArgs, requiredKeys });
  };

  let m;
  while ((m = declRe.exec(editedText)) !== null) parseOne(m[1], m.index + m[0].length - 1);
  while ((m = arrowRe.exec(editedText)) !== null) parseOne(m[1], m.index + m[0].length - 1);
  return contracts;
}

function maskCommentsAndStringsPreservingLines(rawCode = '') {
  const code = String(rawCode || '');
  const out = [];
  const tplStack = [];
  const len = code.length;
  let i = 0;
  let lastSig = '';
  const pushBlank = (ch) => out.push(ch === '\n' ? '\n' : ' ');

  if (code.startsWith('#!')) {
    while (i < len && code[i] !== '\n') {
      out.push(' ');
      i++;
    }
  }

  while (i < len) {
    const ch = code[i];
    const next = i + 1 < len ? code[i + 1] : '';

    if (tplStack.length > 0 && tplStack[tplStack.length - 1] === 0 && ch === '}') {
      tplStack.pop();
      out.push(' ');
      i++;
      while (i < len) {
        const tc = code[i];
        if (tc === '\\' && i + 1 < len) {
          pushBlank(tc);
          pushBlank(code[i + 1]);
          i += 2;
          continue;
        }
        if (tc === '`') {
          out.push(' ');
          lastSig = '`';
          i++;
          break;
        }
        if (tc === '$' && i + 1 < len && code[i + 1] === '{') {
          out.push(' ', ' ');
          tplStack.push(0);
          lastSig = '{';
          i += 2;
          break;
        }
        pushBlank(tc);
        i++;
      }
      continue;
    }

    if (ch === '/' && next === '/') {
      out.push(' ', ' ');
      i += 2;
      while (i < len && code[i] !== '\n') {
        out.push(' ');
        i++;
      }
      continue;
    }

    if (ch === '/' && next === '*') {
      out.push(' ', ' ');
      i += 2;
      while (i < len && !(code[i] === '*' && i + 1 < len && code[i + 1] === '/')) {
        pushBlank(code[i]);
        i++;
      }
      if (i < len) {
        out.push(' ', ' ');
        i += 2;
      }
      continue;
    }

    if (ch === '\'' || ch === '"') {
      const q = ch;
      out.push(' ');
      i++;
      while (i < len) {
        if (code[i] === '\\' && i + 1 < len) {
          pushBlank(code[i]);
          pushBlank(code[i + 1]);
          i += 2;
          continue;
        }
        if (code[i] === q) {
          out.push(' ');
          i++;
          break;
        }
        pushBlank(code[i]);
        i++;
      }
      lastSig = q;
      continue;
    }

    if (ch === '`') {
      out.push(' ');
      i++;
      while (i < len) {
        if (code[i] === '\\' && i + 1 < len) {
          pushBlank(code[i]);
          pushBlank(code[i + 1]);
          i += 2;
          continue;
        }
        if (code[i] === '`') {
          out.push(' ');
          lastSig = '`';
          i++;
          break;
        }
        if (code[i] === '$' && i + 1 < len && code[i + 1] === '{') {
          out.push(' ', ' ');
          tplStack.push(0);
          lastSig = '{';
          i += 2;
          break;
        }
        pushBlank(code[i]);
        i++;
      }
      continue;
    }

    if (ch === '/') {
      const prevTail = out.slice(-16).join('');
      const isRegexAfterKeyword = /(?:^|[^a-zA-Z0-9_$])(?:return|throw|case|typeof|delete|void|yield|await|in|of|else)\s*$/.test(prevTail);
      const isRegexStart = !lastSig || '=(,:!&|?+~^;{}\n[<>*-'.includes(lastSig) || isRegexAfterKeyword;
      if (isRegexStart) {
        out.push(' ');
        i++;
        let inClass = false;
        while (i < len) {
          if (code[i] === '\\' && i + 1 < len) {
            pushBlank(code[i]);
            pushBlank(code[i + 1]);
            i += 2;
            continue;
          }
          if (code[i] === '\n') break;
          if (code[i] === '[') inClass = true;
          else if (code[i] === ']') inClass = false;
          else if (code[i] === '/' && !inClass) {
            out.push(' ');
            i++;
            while (i < len && /[a-z]/i.test(code[i])) {
              out.push(' ');
              i++;
            }
            break;
          }
          pushBlank(code[i]);
          i++;
        }
        lastSig = '/';
        continue;
      }
    }

    if (tplStack.length > 0) {
      if (ch === '{') tplStack[tplStack.length - 1] += 1;
      else if (ch === '}') tplStack[tplStack.length - 1] -= 1;
    }
    out.push(ch);
    if (!/\s/.test(ch)) lastSig = ch;
    i++;
  }
  return out.join('');
}

/**
 * Verifies call-site argument arity and required first-arg destructured object keys
 * across all dependents importing exported functions from the edited file.
 */
export function verifyExportArityAndKeyContracts(editedRelPath = '', editedText = '', dependentEntries = []) {
  const contracts = parseExportedFunctionContracts(editedText);
  if (contracts.size === 0 || !Array.isArray(dependentEntries) || dependentEntries.length === 0) {
    return { valid: true, issues: [], formattedAlert: '' };
  }

  const ext = path.posix.extname(editedRelPath.replace(/\\/g, '/'));
  const baseNoExt = path.posix.basename(editedRelPath.replace(/\\/g, '/'), ext);
  const baseWithExt = path.posix.basename(editedRelPath.replace(/\\/g, '/'));
  const issues = [];
  const importRe = /import\s+(?:type\s+)?(?:[A-Za-z0-9_$]+\s*,\s*)?\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g;

  for (const dep of dependentEntries) {
    const depFile = dep?.file || '';
    const depText = dep?.text || '';
    if (!depFile || !depText) continue;

    const aliasMap = new Map(); // localName -> exportedName
    importRe.lastIndex = 0;
    let im;
    while ((im = importRe.exec(depText)) !== null) {
      const spec = im[2].replace(/\\/g, '/');
      const specBase = path.posix.basename(spec);
      const specNoExt = path.posix.basename(spec, path.posix.extname(spec));
      if (specBase !== baseWithExt && specNoExt !== baseNoExt) continue;

      for (const item of im[1].split(',')) {
        const clean = item.trim().replace(/^type\s+/, '').trim();
        if (!clean) continue;
        const asParts = clean.split(/\s+as\s+/);
        const expName = asParts[0].trim();
        const locName = (asParts[1] || asParts[0]).trim();
        if (contracts.has(expName)) aliasMap.set(locName, expName);
      }
    }

    if (aliasMap.size === 0) continue;

    const maskedCode = maskCommentsAndStringsPreservingLines(depText);
    for (const [localName, exportName] of aliasMap.entries()) {
      const sig = contracts.get(exportName);
      const callRe = new RegExp(`(?<![A-Za-z0-9_$.])(${localName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\s*\\(`, 'g');
      let cm;
      while ((cm = callRe.exec(maskedCode)) !== null) {
        const prefix = maskedCode.slice(Math.max(0, cm.index - 24), cm.index);
        if (/(?:function|import|export)\s+$/.test(prefix)) continue;

        const openIdx = cm.index + cm[0].length - 1;
        const closeIdx = findMatchingDelimiter(maskedCode, openIdx, '(', ')');
        if (closeIdx === -1) continue;

        const rawCallArgs = depText.slice(openIdx + 1, closeIdx).trim();
        const args = rawCallArgs ? splitTopLevel(rawCallArgs, ',') : [];
        if (args.some((a) => a.startsWith('...'))) continue;

        const line = depText.slice(0, cm.index).split('\n').length;
        if (args.length < sig.minArgs || args.length > sig.maxArgs) {
          issues.push({
            type: 'arity_mismatch',
            file: depFile,
            symbol: exportName,
            line,
            detail: `${exportName}() expects ${sig.minArgs}..${sig.maxArgs === Infinity ? '∞' : sig.maxArgs} args, called with ${args.length} at ${depFile}:${line}`,
          });
          continue;
        }

        if (sig.requiredKeys.length > 0 && args.length >= 1) {
          const firstArg = args[0].trim();
          if (firstArg.startsWith('{') && firstArg.endsWith('}') && !firstArg.includes('...')) {
            const innerObj = firstArg.slice(1, -1).trim();
            const presentKeys = new Set();
            for (const entry of splitTopLevel(innerObj, ',')) {
              const km = entry.match(/^['"]?([A-Za-z0-9_$]+)['"]?\s*(?::|$)/);
              if (km) presentKeys.add(km[1]);
            }
            const missingKeys = sig.requiredKeys.filter((k) => !presentKeys.has(k));
            if (missingKeys.length > 0) {
              issues.push({
                type: 'destructured_key_mismatch',
                file: depFile,
                symbol: exportName,
                line,
                detail: `${exportName}({ ... }) missing required key(s) [${missingKeys.join(', ')}] at ${depFile}:${line}`,
              });
            }
          }
        }
      }
    }
  }

  const formattedAlert = issues.length > 0
    ? `⛔ [CPU Arity/Contract Guard] ${issues.slice(0, 3).map((i) => i.detail).join(' | ')}`
    : '';
  return { valid: issues.length === 0, issues, formattedAlert };
}

// ============================================================================
// 4. 64-Bit AST-Normalized Shingle SimHash Clone Radar
// ============================================================================

function normalizeFunctionTokens(bodyText = '') {
  const cleaned = bodyText
    .replace(/\/\*[\s\S]*?\*\/|\/\/.*$|#.*$/gm, ' ')
    .replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, ' $str ')
    .replace(/\b\d+(?:\.\d+)?\b/g, ' $num ');

  const rawTokens = cleaned.match(/[A-Za-z_$][A-Za-z0-9_$]*|===|!==|=>|&&|\|\||\?\?|\?\.|[{}()[\];:+*/<>=-]/g) || [];
  const varSlots = new Map();
  let slotCounter = 0;

  return rawTokens.map((tok) => {
    if (!/^[A-Za-z_$]/.test(tok) || SIMHASH_KEYWORDS.has(tok) || tok === '$str' || tok === '$num') {
      return tok;
    }
    let slot = varSlots.get(tok);
    if (!slot) {
      slot = `$v${slotCounter % 12}`;
      slotCounter++;
      varSlots.set(tok, slot);
    }
    return slot;
  });
}

export function hashShingle64(str) {
  let hi = 0x811c9dc5;
  let lo = 0x9e3779b9;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    lo = Math.imul(lo ^ c, 0x01000193) >>> 0;
    hi = Math.imul(hi ^ (c + (lo & 0xff)), 0x85ebca6b) >>> 0;
  }
  lo ^= lo >>> 15;
  hi ^= hi >>> 13;
  return [hi >>> 0, lo >>> 0];
}

function computeTokenSimHash64(tokens = []) {
  if (tokens.length < 10) return null;
  const weights = new Int32Array(64);
  for (let i = 0; i <= tokens.length - 3; i++) {
    const shingle = `${tokens[i]}|${tokens[i + 1]}|${tokens[i + 2]}`;
    const [hi, lo] = hashShingle64(shingle);
    for (let b = 0; b < 32; b++) {
      weights[b] += ((lo >>> b) & 1) ? 1 : -1;
      weights[32 + b] += ((hi >>> b) & 1) ? 1 : -1;
    }
  }
  let lo = 0;
  let hi = 0;
  for (let b = 0; b < 32; b++) {
    if (weights[b] > 0) lo = (lo | (1 << b)) >>> 0;
    if (weights[32 + b] > 0) hi = (hi | (1 << b)) >>> 0;
  }
  return { hi: hi >>> 0, lo: lo >>> 0 };
}

function popcnt32(v) {
  v = v - ((v >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

export function hammingDistance64(aHi, aLo, bHi, bLo) {
  return popcnt32((aHi ^ bHi) >>> 0) + popcnt32((aLo ^ bLo) >>> 0);
}

/**
 * Extracts 64-bit structural SimHash fingerprints for all non-trivial functions in a file.
 */
export function computeFileSimHashes({ relPath = '', ext = '', text = '', symbols = null, minLines = 10 } = {}) {
  if (!text || typeof text !== 'string') return [];
  const fileExt = ext || path.extname(relPath).toLowerCase();
  const syms = Array.isArray(symbols) && symbols.length > 0
    ? symbols
    : extractFileSymbolsWithRanges(fileExt, text);
  const lines = text.split(/\r?\n/);
  const hashes = [];

  for (const s of syms) {
    if (!s || !s.name || s.name === 'anonymous' || s.kind === 'class') continue;
    const startLine = Math.max(1, Number(s.startLine) || 1);
    const endLine = Math.min(lines.length, Math.max(startLine, Number(s.endLine) || startLine));
    const lineCount = endLine - startLine + 1;
    if (lineCount < minLines) continue;

    const bodyLines = lines.slice(startLine, endLine); // skip signature line so renamed fn matches
    const tokens = normalizeFunctionTokens(bodyLines.join('\n'));
    const fp = computeTokenSimHash64(tokens);
    if (!fp) continue;
    hashes.push({
      file: relPath,
      symbol: s.name,
      startLine,
      endLine,
      lineCount,
      hi: fp.hi,
      lo: fp.lo,
    });
  }
  return hashes;
}

/**
 * Builds a workspace-wide SimHash fingerprint index from RAM file entries.
 */
export function buildWorkspaceSimHashIndex(filesMap) {
  const byFile = new Map();
  if (!filesMap) return byFile;
  const entries = filesMap instanceof Map ? filesMap.entries() : Object.entries(filesMap);
  for (const [relPath, entry] of entries) {
    if (/(?:^|\/)(?:tests?|__tests__|scratch)\/|(?:\.test\.|\.spec\.)/i.test(relPath)) continue;
    const text = typeof entry === 'string' ? entry : (entry?.text ?? (entry?.buf ? entry.buf.toString('utf8') : ''));
    const ext = entry?.ext || path.extname(relPath).toLowerCase();
    const hashes = computeFileSimHashes({ relPath, ext, text, symbols: entry?.symbols });
    if (hashes.length > 0) byFile.set(relPath, hashes);
  }
  return byFile;
}

/**
 * Detects near-duplicate functions in an edited file against other workspace files (>=87.5% structural match).
 */
export function findNearDuplicateFunctions(simHashIndex, editedRelPath = '', editedText = '', { maxHammingDist = 8, minLines = 10 } = {}) {
  if (!(simHashIndex instanceof Map) || !editedText) {
    return { clones: [], formattedHint: '' };
  }
  const normEdited = toPosixRel(editedRelPath);
  const ext = path.extname(normEdited).toLowerCase() || '.mjs';
  const editedHashes = computeFileSimHashes({ relPath: normEdited, ext, text: editedText, minLines });
  if (editedHashes.length === 0) return { clones: [], formattedHint: '' };

  const clones = [];
  for (const cand of editedHashes) {
    let best = null;
    for (const [otherFile, otherList] of simHashIndex.entries()) {
      if (otherFile === normEdited) continue;
      for (const target of otherList) {
        if (target.lineCount < cand.lineCount * 0.65 || target.lineCount > cand.lineCount * 1.5) continue;
        const dist = hammingDistance64(cand.hi, cand.lo, target.hi, target.lo);
        if (dist <= maxHammingDist && (!best || dist < best.dist)) {
          best = { dist, target };
        }
      }
    }
    if (best) {
      const similarityPct = Math.round(((64 - best.dist) / 64) * 100);
      clones.push({
        symbol: cand.symbol,
        line: cand.startLine,
        targetFile: best.target.file,
        targetSymbol: best.target.symbol,
        targetLine: best.target.startLine,
        hammingDist: best.dist,
        similarityPct,
      });
    }
  }

  clones.sort((a, b) => b.similarityPct - a.similarityPct);
  const formattedHint = clones.length > 0
    ? `🧬 [CPU SimHash Reuse Radar] ${clones[0].symbol} is ${clones[0].similarityPct}% structurally identical to ${clones[0].targetFile}#${clones[0].targetSymbol} (L${clones[0].targetLine})`
    : '';
  return { clones, formattedHint };
}

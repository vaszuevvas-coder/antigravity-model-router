/**
 * @file project-graph-builder.mjs
 * @description Shared project dependency graph builder with Tarjan SCC cycle detection,
 *              orphan detection, test-impact mapping, and token budget estimation.
 */

import { basename, dirname } from 'node:path';
import { buildSymbolCallGraph } from './cpu-ast-graph-compressor.mjs';

const TEST_FILE_RE = /(?:^|\/)(?:tests?|__tests__|fixtures|scratch)\/|\.(?:test|spec)\./i;
const ENTRYPOINT_FILE_RE = /(?:^|\/)(?:index|main|cli|server|install|hook-runner|app)\.[^/]+$/i;
const ENTRYPOINT_DIR_RE = /^(?:scripts|bin|tests?|__tests__|fixtures|scratch)\//i;
const NON_CODE_EXTS = new Set([
  '.md', '.markdown', '.txt', '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.env',
  '.css', '.scss', '.less', '.html', '.htm', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.lock',
]);

/**
 * Checks whether a workspace-relative path is a test or fixture file.
 * @param {string} rel
 * @returns {boolean}
 */
export function isGraphTestFile(rel = '') {
  return TEST_FILE_RE.test(String(rel || ''));
}

/**
 * Estimates LLM token count for a cached file entry.
 * @param {object} entry
 * @returns {number}
 */
export function estimateNodeTokens(entry) {
  const byteLen = Number(entry?.sizeBytes || entry?.buf?.byteLength || entry?.content?.length || 0);
  const fallbackBytes = Number(entry?.lineCount || 0) * 42;
  const effectiveBytes = byteLen > 0 ? byteLen : fallbackBytes;
  return Math.max(10, Math.round(effectiveBytes / 3.8));
}

/**
 * Iterative Tarjan Strongly Connected Components detector over directed import edges.
 * Returns canonical readable cycle chains plus node/edge sets belonging to cycles.
 * @param {Map<string, Iterable<string>>} adjMap
 * @param {{ maxCycles?: number }} [options={}]
 * @returns {{ cycles: string[][], cycleNodeIds: string[], cycleEdgeKeys: string[] }}
 */
export function detectImportCyclesTarjan(adjMap, { maxCycles = 40 } = {}) {
  if (!(adjMap instanceof Map) || adjMap.size === 0) {
    return { cycles: [], cycleNodeIds: [], cycleEdgeKeys: [] };
  }

  let index = 0;
  const indices = new Map();
  const lowlink = new Map();
  const sccStack = [];
  const onStack = new Set();
  const sccs = [];

  for (const startNode of adjMap.keys()) {
    if (indices.has(startNode)) continue;

    indices.set(startNode, index);
    lowlink.set(startNode, index);
    index += 1;
    sccStack.push(startNode);
    onStack.add(startNode);

    const callStack = [{
      node: startNode,
      neighbors: Array.from(adjMap.get(startNode) || []),
      idx: 0,
    }];

    while (callStack.length > 0) {
      const frame = callStack[callStack.length - 1];
      const v = frame.node;

      if (frame.idx < frame.neighbors.length) {
        const w = frame.neighbors[frame.idx++];
        if (!indices.has(w)) {
          indices.set(w, index);
          lowlink.set(w, index);
          index += 1;
          sccStack.push(w);
          onStack.add(w);
          callStack.push({
            node: w,
            neighbors: Array.from(adjMap.get(w) || []),
            idx: 0,
          });
        } else if (onStack.has(w)) {
          lowlink.set(v, Math.min(lowlink.get(v), indices.get(w)));
        }
        continue;
      }

      if (lowlink.get(v) === indices.get(v)) {
        const comp = [];
        while (sccStack.length > 0) {
          const w = sccStack.pop();
          onStack.delete(w);
          comp.push(w);
          if (w === v) break;
        }
        if (comp.length >= 2) {
          sccs.push(comp);
        } else if (comp.length === 1) {
          const vNeighbors = adjMap.get(v);
          const hasSelf = Array.isArray(vNeighbors)
            ? vNeighbors.includes(v)
            : Boolean(vNeighbors && typeof vNeighbors.has === 'function' && vNeighbors.has(v));
          if (hasSelf) sccs.push([v]);
        }
      }

      callStack.pop();
      if (callStack.length > 0) {
        const parent = callStack[callStack.length - 1].node;
        lowlink.set(parent, Math.min(lowlink.get(parent), lowlink.get(v)));
      }
    }
  }

  const cycleNodeSet = new Set();
  const cycleEdgeSet = new Set();
  const cycles = [];

  sccs.sort((a, b) => b.length - a.length || String(a[0]).localeCompare(String(b[0])));

  for (const comp of sccs) {
    const compSet = new Set(comp);
    for (const id of comp) cycleNodeSet.add(id);

    for (const src of comp) {
      for (const tgt of adjMap.get(src) || []) {
        if (compSet.has(tgt)) {
          cycleEdgeSet.add(`${src}->${tgt}`);
        }
      }
    }

    if (cycles.length >= maxCycles) continue;

    // Extract shortest readable closed chain from lexically smallest member
    const start = comp.slice().sort()[0];
    const queue = [[start]];
    const visited = new Set([start]);
    let foundChain = null;

    while (queue.length > 0 && !foundChain) {
      const pathArr = queue.shift();
      const tail = pathArr[pathArr.length - 1];
      const outs = Array.from(adjMap.get(tail) || []).filter((n) => compSet.has(n)).sort();
      for (const nxt of outs) {
        if (nxt === start && pathArr.length >= 2) {
          foundChain = [...pathArr, start];
          break;
        }
        if (nxt === start && pathArr.length === 1) {
          foundChain = [start, start];
          break;
        }
        if (!visited.has(nxt)) {
          visited.add(nxt);
          queue.push([...pathArr, nxt]);
        }
      }
    }

    cycles.push(foundChain || [...comp.slice().sort(), start]);
  }

  return {
    cycles,
    cycleNodeIds: Array.from(cycleNodeSet).sort(),
    cycleEdgeKeys: Array.from(cycleEdgeSet).sort(),
  };
}

/**
 * Detects isolated code files with zero incoming references (excluding standard entrypoints).
 * @param {Array<object>} nodes
 * @param {Map<string, Set<string>>} [forwardDeps]
 * @param {Map<string, Set<string>>} [reverseDeps]
 * @param {Map<string, Set<string>>} [docSourcesByCode]
 * @returns {string[]}
 */
export function detectOrphanFiles(nodes = [], forwardDeps = null, reverseDeps = null, docSourcesByCode = null) {
  if (!Array.isArray(nodes) || nodes.length === 0) return [];
  const orphans = [];
  for (const n of nodes) {
    if (!n || !n.id || n.isTest) continue;
    const rel = String(n.id);
    const ext = String(n.ext || '').toLowerCase();
    if (NON_CODE_EXTS.has(ext)) continue;
    if (ENTRYPOINT_FILE_RE.test(rel) || ENTRYPOINT_DIR_RE.test(rel) || /\.config\.[^/]+$/i.test(rel)) {
      continue;
    }
    const revCount = reverseDeps?.get(rel)?.size || 0;
    const docCount = docSourcesByCode?.get(rel)?.size || 0;
    const effectiveIn = Math.max(Number(n.inDeg || 0), revCount + docCount);
    if (effectiveIn === 0) {
      orphans.push(rel);
    }
  }
  orphans.sort();
  return orphans.slice(0, 60);
}

/**
 * Builds the complete `/api/project-graph` payload from a RamMemoryEngine instance.
 * @param {object} engine
 * @param {string} workspaceRoot
 * @param {object} [options={}]
 * @returns {object}
 */
export function buildProjectGraphPayload(engine, workspaceRoot, options = {}) {
  const focusRaw = typeof options.focus === 'string'
    ? options.focus.trim().replace(/\\/g, '/').replace(/^\.\//, '')
    : '';
  const depth = Math.max(1, Math.min(3, Math.floor(Number(options.depth) || 2)));
  const maxNodes = Math.max(30, Math.min(25000, Math.floor(Number(options.maxNodes) || 220)));
  const includeTests = options.includeTests === true || options.includeTests === '1' || options.includeTests === 'true';
  const includeDocs = options.includeDocs !== false && options.includeDocs !== '0' && options.includeDocs !== 'false';
  const startWatcher = options.startWatcher === true;
  const fragileMap = options.fragileMap instanceof Map ? options.fragileMap : new Map();
  const source = typeof options.source === 'string' && options.source ? options.source : 'local_cache';

  const ws = engine.ensureWarm(workspaceRoot, { startWatcher });
  if (!ws || !ws.files || ws.files.size === 0) {
    return {
      ok: true,
      workspaceRoot,
      workspaceName: basename(workspaceRoot) || workspaceRoot,
      totalFiles: 0,
      shownNodes: 0,
      shownEdges: 0,
      modularityQ: 0,
      focus: '',
      depth,
      clusters: [],
      nodes: [],
      edges: [],
      cycles: [],
      cycleNodeIds: [],
      cycleEdgeKeys: [],
      orphanIds: [],
      testFilesByTarget: {},
      source,
    };
  }

  const arch = engine.getArchitectureClusters(workspaceRoot, { maxClusters: 16, maxGodNodes: 10 });
  const docRefGraph = includeDocs ? (ws.docRefGraph || engine.getDocRefGraph(workspaceRoot)) : null;

  const godMap = new Map();
  for (const g of arch?.godNodes || []) {
    if (g?.file) godMap.set(g.file, Number(g.couplingScore || 0));
  }

  const clusterMetaList = [];
  const fileToClusterId = new Map();
  const fileToClusterLabel = new Map();
  for (const cl of arch?.clusters || []) {
    clusterMetaList.push({
      id: cl.id,
      label: cl.label || cl.id,
      size: Number(cl.size || 0),
      hubFile: cl.hubFile || '',
    });
  }
  if (arch?.fileToCluster instanceof Map) {
    for (const [rel, meta] of arch.fileToCluster.entries()) {
      if (meta?.id) {
        fileToClusterId.set(rel, meta.id);
        fileToClusterLabel.set(rel, meta.label || meta.id);
      }
    }
  }

  const docTargetsByDoc = new Map();
  const docSourcesByCode = new Map();
  if (includeDocs && docRefGraph?.codeFromDoc instanceof Map) {
    for (const [docRel, edgeArr] of docRefGraph.codeFromDoc.entries()) {
      if (!ws.files.has(docRel)) continue;
      for (const edge of edgeArr || []) {
        const codeRel = edge?.codeFile;
        if (!codeRel || codeRel === docRel || !ws.files.has(codeRel)) continue;
        let tSet = docTargetsByDoc.get(docRel);
        if (!tSet) {
          tSet = new Set();
          docTargetsByDoc.set(docRel, tSet);
        }
        tSet.add(codeRel);
        let sSet = docSourcesByCode.get(codeRel);
        if (!sSet) {
          sSet = new Set();
          docSourcesByCode.set(codeRel, sSet);
        }
        sSet.add(docRel);
      }
    }
  }

  const resolvedFocus = focusRaw && ws.files.has(focusRaw) ? focusRaw : '';
  const selectedHopMap = new Map();

  if (resolvedFocus) {
    const queue = [{ id: resolvedFocus, hop: 0 }];
    selectedHopMap.set(resolvedFocus, 0);
    let head = 0;
    while (head < queue.length && selectedHopMap.size < maxNodes) {
      const cur = queue[head++];
      if (cur.hop >= depth) continue;
      const neighbors = new Set();
      const fwd = ws.forwardDeps?.get(cur.id);
      const rev = ws.reverseDeps?.get(cur.id);
      const docOut = docTargetsByDoc.get(cur.id);
      const docIn = docSourcesByCode.get(cur.id);
      if (fwd) for (const n of fwd) neighbors.add(n);
      if (rev) for (const n of rev) neighbors.add(n);
      if (docOut) for (const n of docOut) neighbors.add(n);
      if (docIn) for (const n of docIn) neighbors.add(n);

      const sortedNeighbors = Array.from(neighbors).sort((a, b) => {
        const scoreA = (ws.reverseDeps?.get(a)?.size || 0) * 3 + (ws.forwardDeps?.get(a)?.size || 0);
        const scoreB = (ws.reverseDeps?.get(b)?.size || 0) * 3 + (ws.forwardDeps?.get(b)?.size || 0);
        return scoreB - scoreA || a.localeCompare(b);
      });
      for (const nb of sortedNeighbors) {
        if (selectedHopMap.size >= maxNodes) break;
        if (!ws.files.has(nb) || selectedHopMap.has(nb)) continue;
        if (!includeTests && nb !== resolvedFocus && isGraphTestFile(nb)) continue;
        selectedHopMap.set(nb, cur.hop + 1);
        queue.push({ id: nb, hop: cur.hop + 1 });
      }
    }
  } else {
    const ranked = [];
    for (const [rel, entry] of ws.files.entries()) {
      const testFlag = isGraphTestFile(rel);
      if (!includeTests && testFlag) continue;
      const inDeg = (ws.reverseDeps?.get(rel)?.size || 0) + (docSourcesByCode.get(rel)?.size || 0);
      const outDeg = (ws.forwardDeps?.get(rel)?.size || 0) + (docTargetsByDoc.get(rel)?.size || 0);
      const isGod = godMap.has(rel);
      const frag = fragileMap.get(rel);
      const isFragile = Boolean(frag && frag.runs > 0 && frag.reliabilityPercent < 80);
      const score = (inDeg * 3) + outDeg + (isGod ? 25 : 0) + (isFragile ? 14 : 0) + Math.min(4, Math.floor((entry.symbols?.length || 0) / 4));
      ranked.push({ rel, score });
    }
    ranked.sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel));
    for (const item of ranked.slice(0, maxNodes)) {
      selectedHopMap.set(item.rel, -1);
    }
  }

  const selectedSet = new Set(selectedHopMap.keys());
  const seenEdges = new Set();
  const edges = [];
  const importAdj = new Map();

  for (const id of selectedSet) {
    importAdj.set(id, new Set());
  }

  const pushEdge = (src, tgt, kind) => {
    if (!selectedSet.has(src) || !selectedSet.has(tgt) || src === tgt) return;
    const k = `${src}->${tgt}::${kind}`;
    if (seenEdges.has(k)) return;
    seenEdges.add(k);
    edges.push({ source: src, target: tgt, kind });
    if (kind === 'import') {
      importAdj.get(src)?.add(tgt);
    }
  };

  for (const src of selectedSet) {
    const fwd = ws.forwardDeps?.get(src);
    if (fwd) {
      for (const tgt of fwd) pushEdge(src, tgt, 'import');
    }
    if (includeDocs) {
      const docOut = docTargetsByDoc.get(src);
      if (docOut) {
        for (const tgt of docOut) pushEdge(src, tgt, 'doc');
      }
    }
  }

  const cycleRes = detectImportCyclesTarjan(importAdj, { maxCycles: 40 });
  const cycleNodeSet = new Set(cycleRes.cycleNodeIds);

  const fallbackClusterDir = (rel) => {
    const idx = rel.indexOf('/');
    return idx > 0 ? rel.slice(0, idx) : 'root';
  };

  const nodes = [];
  const presentClusterIds = new Map();
  for (const rel of selectedSet) {
    const entry = ws.files.get(rel);
    if (!entry) continue;
    const inDeg = (ws.reverseDeps?.get(rel)?.size || 0) + (docSourcesByCode.get(rel)?.size || 0);
    const outDeg = (ws.forwardDeps?.get(rel)?.size || 0) + (docTargetsByDoc.get(rel)?.size || 0);
    const frag = fragileMap.get(rel);
    const isFragile = Boolean(frag && frag.runs > 0 && frag.reliabilityPercent < 80);
    const fallbackDir = fallbackClusterDir(rel);
    const clusterId = fileToClusterId.get(rel) || `dir:${fallbackDir}`;
    const clusterLabel = fileToClusterLabel.get(rel) || fallbackDir;
    if (!presentClusterIds.has(clusterId)) {
      presentClusterIds.set(clusterId, { id: clusterId, label: clusterLabel, size: 0, hubFile: '' });
    }
    presentClusterIds.get(clusterId).size += 1;

    const bytes = Number(entry.sizeBytes || entry.buf?.byteLength || 0) || (Number(entry.lineCount || 0) * 42);
    nodes.push({
      id: rel,
      label: basename(rel),
      dir: rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '.',
      ext: entry.ext || '',
      lines: Number(entry.lineCount || 0),
      bytes,
      estTokens: estimateNodeTokens(entry),
      symbolsCount: Array.isArray(entry.symbols) ? entry.symbols.length : 0,
      clusterId,
      clusterLabel,
      inDeg,
      outDeg,
      isGod: godMap.has(rel),
      isTest: isGraphTestFile(rel),
      isFragile,
      reliabilityPercent: frag ? frag.reliabilityPercent : 100,
      inCycle: cycleNodeSet.has(rel),
      isOrphan: false,
      hop: selectedHopMap.get(rel) ?? -1,
    });
  }

  const orphanIds = detectOrphanFiles(nodes, ws.forwardDeps, ws.reverseDeps, docSourcesByCode);
  const orphanSet = new Set(orphanIds);
  for (const n of nodes) {
    if (orphanSet.has(n.id)) n.isOrphan = true;
  }

  // Map test files targeting any selected node (works even when includeTests=false)
  const testFilesByTarget = {};
  for (const [rel] of ws.files.entries()) {
    if (!isGraphTestFile(rel)) continue;
    const fwd = ws.forwardDeps?.get(rel);
    if (!fwd) continue;
    for (const tgt of fwd) {
      if (!selectedSet.has(tgt)) continue;
      if (!testFilesByTarget[tgt]) testFilesByTarget[tgt] = [];
      testFilesByTarget[tgt].push(rel);
    }
  }
  for (const tgt of Object.keys(testFilesByTarget)) {
    testFilesByTarget[tgt].sort();
  }

  const mergedClusters = [];
  const seenClusterIds = new Set();
  for (const cl of clusterMetaList) {
    const activeCount = presentClusterIds.get(cl.id)?.size || 0;
    if (activeCount > 0) {
      seenClusterIds.add(cl.id);
      mergedClusters.push({ ...cl, shownSize: activeCount });
    }
  }
  for (const [cid, meta] of presentClusterIds.entries()) {
    if (!seenClusterIds.has(cid)) {
      mergedClusters.push({ ...meta, shownSize: meta.size });
    }
  }

  return {
    ok: true,
    workspaceRoot,
    workspaceName: basename(workspaceRoot) || workspaceRoot,
    totalFiles: ws.files.size,
    shownNodes: nodes.length,
    shownEdges: edges.length,
    modularityQ: Number(arch?.modularityQ || 0),
    focus: resolvedFocus,
    depth,
    clusters: mergedClusters,
    nodes,
    edges,
    cycles: cycleRes.cycles,
    cycleNodeIds: cycleRes.cycleNodeIds,
    cycleEdgeKeys: cycleRes.cycleEdgeKeys,
    orphanIds,
    testFilesByTarget,
    source,
  };
}

/**
 * Parses `git log --name-only --pretty=format:` stdout into per-file commit touch counts.
 * @param {string} [stdout='']
 * @returns {{ totalTouches: number, maxChurn: number, churnByFile: Record<string, number> }}
 */
export function parseGitChurnOutput(stdout = '') {
  const churnByFile = {};
  let totalTouches = 0;
  let maxChurn = 0;
  const lines = String(stdout || '').split(/\r?\n/);
  for (const raw of lines) {
    const rel = raw.trim().replace(/\\/g, '/').replace(/^\.\//, '');
    if (!rel) continue;
    const next = (churnByFile[rel] || 0) + 1;
    churnByFile[rel] = next;
    totalTouches += 1;
    if (next > maxChurn) maxChurn = next;
  }
  return { totalTouches, maxChurn, churnByFile };
}

/**
 * Aggregates RamMemoryEngine.searchSemantic() results into normalized 0..1 per-file scores.
 * @param {object} semRes
 * @param {string} [query='']
 * @param {string} [source='local_cache']
 * @returns {object}
 */
export function aggregateSemanticGraphHits(semRes, query = '', source = 'local_cache') {
  const rawResults = Array.isArray(semRes?.results) ? semRes.results : [];
  const byFile = new Map();
  let maxRaw = 0;
  for (const r of rawResults) {
    const rel = String(r?.file || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
    if (!rel) continue;
    const rawScore = Math.max(0.001, Number(r?.rrfScore || r?.score || r?.similarity || 0.5));
    if (rawScore > maxRaw) maxRaw = rawScore;
    const prev = byFile.get(rel);
    if (!prev || rawScore > prev.rawScore) {
      byFile.set(rel, {
        file: rel,
        rawScore,
        line: Number(r?.startLine || r?.line || 1),
        snippet: String(r?.snippet || r?.preview || '').slice(0, 120),
      });
    }
  }
  const denom = maxRaw > 0 ? maxRaw : 1;
  const scoresByFile = {};
  const matches = Array.from(byFile.values())
    .map((item) => {
      const norm = Math.max(0.15, Math.min(1, Number((item.rawScore / denom).toFixed(3))));
      scoresByFile[item.file] = norm;
      return { file: item.file, score: norm, line: item.line, snippet: item.snippet };
    })
    .sort((a, b) => b.score - a.score);

  return {
    ok: true,
    query,
    mode: semRes?.mode || 'hybrid_gpu',
    gpuError: semRes?.gpuError || '',
    scoresByFile,
    matches,
    source,
  };
}

/**
 * Builds a 3rd-level AST Symbol & Call Graph payload for a specific workspace file
 * using `ws.symbolGraph` (internal symbols + 1-hop cross-file callers/callees).
 * @param {import('./ram-memory-engine.mjs').RamMemoryEngine} engine
 * @param {string} workspaceRoot
 * @param {string} fileRel
 * @param {object} [options={}]
 * @returns {object}
 */
export function buildFileSymbolGraphPayload(engine, workspaceRoot, fileRel, options = {}) {
  const normReq = String(fileRel || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  const source = typeof options.source === 'string' && options.source ? options.source : 'local_cache';
  const maxExternal = Math.max(8, Math.min(60, Math.floor(Number(options.maxExternal) || 36)));

  const ws = engine.ensureWarm(workspaceRoot, { startWatcher: Boolean(options.startWatcher) });
  if (!ws || !ws.files || ws.files.size === 0 || !normReq) {
    return {
      ok: false,
      isSymbolsView: true,
      error: 'File not found in workspace',
      targetFile: normReq,
      nodes: [],
      edges: [],
      clusters: [],
      source,
    };
  }

  let targetFile = ws.files.has(normReq) ? normReq : '';
  if (!targetFile) {
    const suffixMatches = [];
    for (const rel of ws.files.keys()) {
      if (rel === normReq || rel.endsWith(`/${normReq}`)) {
        suffixMatches.push(rel);
      }
    }
    if (suffixMatches.length === 1) {
      targetFile = suffixMatches[0];
    }
  }
  if (!targetFile) {
    return {
      ok: false,
      isSymbolsView: true,
      error: 'File not found in workspace',
      targetFile: normReq,
      nodes: [],
      edges: [],
      clusters: [],
      source,
    };
  }

  if (!ws.symbolGraph) {
    ws.symbolGraph = buildSymbolCallGraph(ws.files);
  }
  const symGraph = ws.symbolGraph;
  const definedSymbols = symGraph?.definedSymbols instanceof Map ? symGraph.definedSymbols : new Map();
  const calleesOf = symGraph?.calleesOf instanceof Map ? symGraph.calleesOf : new Map();
  const callersOf = symGraph?.callersOf instanceof Map ? symGraph.callersOf : new Map();

  // Collect deduplicated symbol definitions belonging to targetFile
  const rawDefs = [];
  const seenDefKeys = new Set();
  for (const defs of definedSymbols.values()) {
    for (const d of defs || []) {
      if (!d || d.file !== targetFile || !d.name) continue;
      const startLine = Math.max(1, Number(d.startLine) || 1);
      const endLine = Math.max(startLine, Number(d.endLine) || startLine);
      const key = `${d.name}:${startLine}`;
      if (seenDefKeys.has(key)) continue;
      seenDefKeys.add(key);
      rawDefs.push({
        name: String(d.name),
        kind: String(d.kind || 'function'),
        signature: String(d.signature || d.name),
        startLine,
        endLine,
      });
    }
  }
  rawDefs.sort((a, b) => a.startLine - b.startLine || a.name.localeCompare(b.name));

  const internalClusterId = `internal:${targetFile}`;
  const internalClusterLabel = basename(targetFile) || targetFile;
  const targetDir = dirname(targetFile);
  const internalNodes = [];
  const localByName = new Map();
  const nodeMap = new Map();

  for (const d of rawDefs) {
    const id = `sym:${targetFile}#${d.name}:${d.startLine}`;
    const lines = Math.max(1, d.endLine - d.startLine + 1);
    const node = {
      id,
      label: d.name,
      symbolName: d.name,
      kind: d.kind,
      signature: d.signature,
      file: targetFile,
      dir: targetDir === '.' ? '.' : targetDir,
      startLine: d.startLine,
      endLine: d.endLine,
      lines,
      estTokens: Math.max(10, Math.round(lines * 11)),
      isSymbol: true,
      isExternal: false,
      clusterId: internalClusterId,
      clusterLabel: internalClusterLabel,
      inDeg: 0,
      outDeg: 0,
      isGod: false,
      hop: 0,
    };
    internalNodes.push(node);
    nodeMap.set(id, node);
    if (!localByName.has(d.name)) {
      localByName.set(d.name, id);
    }
  }

  const externalNodes = [];
  const edgeMap = new Map();
  const forwardDepsSet = ws.forwardDeps?.get(targetFile) || new Set();
  const reverseDepsSet = ws.reverseDeps?.get(targetFile) || new Set();

  const ensureExternalNode = (extFile, extName, extLine) => {
    const cleanFile = String(extFile || '').trim();
    const safeLine = Math.max(1, Number(extLine) || 1);
    const id = `sym:${cleanFile}#${extName}:${safeLine}`;
    if (nodeMap.has(id)) return id;
    if (externalNodes.length >= maxExternal) return '';
    const extDir = cleanFile ? dirname(cleanFile) : 'external';
    const clusterId = `ext:${extFile || 'external'}`;
    const node = {
      id,
      label: extName,
      symbolName: extName,
      kind: 'external',
      signature: `${extName} (${basename(cleanFile) || 'ext'})`,
      file: cleanFile,
      dir: extDir === '.' ? '.' : extDir,
      startLine: safeLine,
      endLine: safeLine,
      lines: 1,
      estTokens: 40,
      isSymbol: true,
      isExternal: true,
      clusterId,
      clusterLabel: cleanFile || 'external',
      inDeg: 0,
      outDeg: 0,
      isGod: false,
      hop: 1,
    };
    externalNodes.push(node);
    nodeMap.set(id, node);
    return id;
  };

  const addCallEdge = (sourceId, targetId, confidence = 'EXTRACTED') => {
    if (!sourceId || !targetId || sourceId === targetId) return;
    const key = `${sourceId}->${targetId}`;
    const existing = edgeMap.get(key);
    if (existing) {
      existing.weight += 1;
      return;
    }
    edgeMap.set(key, {
      source: sourceId,
      target: targetId,
      kind: 'call',
      weight: 1,
      confidence,
    });
  };

  for (const srcNode of internalNodes) {
    const symName = srcNode.symbolName;
    const isUniqueDefName = (definedSymbols.get(symName)?.length || 0) <= 1;

    // Outgoing calls from symName
    const outBucket = calleesOf.get(symName);
    if (outBucket instanceof Map) {
      for (const e of outBucket.values()) {
        if (!e || !e.name) continue;
        if (localByName.has(e.name) && (!e.file || e.file === targetFile)) {
          addCallEdge(srcNode.id, localByName.get(e.name), e.confidence || 'EXTRACTED');
          continue;
        }
        if (e.isRepoSymbol && e.file && e.file !== targetFile) {
          if (!isUniqueDefName && !forwardDepsSet.has(e.file)) continue;
          const extId = ensureExternalNode(e.file, e.name, e.line || 1);
          if (extId) addCallEdge(srcNode.id, extId, e.confidence || 'INFERRED');
        }
      }
    }

    // Incoming callers to symName
    const inBucket = callersOf.get(symName);
    if (inBucket instanceof Map) {
      for (const e of inBucket.values()) {
        if (!e || !e.name || !e.file) continue;
        if (e.file === targetFile) {
          const callerLocalId = localByName.get(e.name);
          if (callerLocalId) {
            addCallEdge(callerLocalId, srcNode.id, e.confidence || 'EXTRACTED');
          }
          continue;
        }
        if (!isUniqueDefName && !reverseDepsSet.has(e.file)) continue;
        const callerDefs = definedSymbols.get(e.name);
        const matchedDef = callerDefs?.find((d) => d.file === e.file);
        const callerLine = matchedDef?.startLine || e.line || 1;
        const extId = ensureExternalNode(e.file, e.name, callerLine);
        if (extId) addCallEdge(extId, srcNode.id, e.confidence || 'INFERRED');
      }
    }
  }

  const allNodes = [...internalNodes, ...externalNodes];
  const edges = Array.from(edgeMap.values());
  for (const edge of edges) {
    const s = nodeMap.get(edge.source);
    const t = nodeMap.get(edge.target);
    if (s) s.outDeg += 1;
    if (t) t.inDeg += 1;
  }

  let topInternalHub = null;
  for (const n of internalNodes) {
    if (n.inDeg >= 3) n.isGod = true;
    if (!topInternalHub || n.inDeg > topInternalHub.inDeg) {
      topInternalHub = n;
    }
  }
  if (topInternalHub && topInternalHub.inDeg >= 2) {
    topInternalHub.isGod = true;
  }

  const clusterAcc = new Map();
  for (const n of allNodes) {
    let cl = clusterAcc.get(n.clusterId);
    if (!cl) {
      cl = { id: n.clusterId, label: n.clusterLabel, size: 0, shownSize: 0 };
      clusterAcc.set(n.clusterId, cl);
    }
    cl.size += 1;
    cl.shownSize += 1;
  }
  const clusters = Array.from(clusterAcc.values()).sort((a, b) => {
    if (a.id === internalClusterId) return -1;
    if (b.id === internalClusterId) return 1;
    return b.size - a.size || a.label.localeCompare(b.label);
  });

  return {
    ok: true,
    isSymbolsView: true,
    workspaceRoot,
    workspaceName: basename(workspaceRoot) || workspaceRoot,
    targetFile,
    totalSymbols: internalNodes.length,
    shownNodes: allNodes.length,
    shownEdges: edges.length,
    clusters,
    nodes: allNodes,
    edges,
    source,
  };
}

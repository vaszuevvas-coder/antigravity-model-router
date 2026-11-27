/**
 * @file ram-graph-queries.mjs
 * @description In-RAM knowledge graph queries, architectural clusters, blast radius, and contract verification.
 */

import path from 'node:path';
import { verifyImportContracts, verifySemanticContracts } from '../repo-mapper.mjs';
import { loadCpuConfig, recordCpuCompressionSaving } from '../cpu-worker-pool.mjs';
import {
  buildDocConfigReferenceGraph,
  buildSymbolCallGraph,
  detectArchitectureClusters,
  findShortestGraphPath,
  findSurprisingConnections,
  queryAffectedBlastGraph,
  queryDocRefsForFile,
  querySymbolEgoGraph,
  suggestArchitectureQuestions,
} from '../cpu-ast-graph-compressor.mjs';
import {
  buildWorkspaceSimHashIndex,
  computeFileSimHashes,
  findNearDuplicateFunctions,
  queryCoChangePartners,
  verifyExportArityAndKeyContracts,
} from '../cpu-graph-contracts.mjs';
import { buildGraphUncertaintyNote, toRelPath } from './ram-index-helpers.mjs';

/**
 * Collects a bounded local import/reverse-dep neighborhood around seed files.
 */
export function buildLocalNeighborhoodFiles(ws, seedRelFiles = [], maxFiles = 120) {
  const sub = new Map();
  const queue = [];
  for (const rel of seedRelFiles) {
    if (rel && ws.files.has(rel) && !sub.has(rel)) {
      sub.set(rel, ws.files.get(rel));
      queue.push(rel);
    }
  }
  if (sub.size === 0) {
    for (const [k, v] of ws.files.entries()) {
      sub.set(k, v);
      if (sub.size >= maxFiles) break;
    }
    return sub;
  }
  for (const rel of queue) {
    if (sub.size >= maxFiles) break;
    const deps = ws.forwardDeps?.get(rel);
    if (deps) {
      for (const d of deps) {
        if (sub.size >= maxFiles) break;
        if (ws.files.has(d) && !sub.has(d)) sub.set(d, ws.files.get(d));
      }
    }
    const rev = ws.reverseDeps?.get(rel);
    if (rev) {
      for (const r of rev) {
        if (sub.size >= maxFiles) break;
        if (ws.files.has(r) && !sub.has(r)) sub.set(r, ws.files.get(r));
      }
    }
  }
  return sub;
}

/**
 * Lazily ensures a fresh symbol call graph, invalidating when `ws.symbolGraphDirty` is non-empty.
 */
export function ensureSymbolGraph(ws, { seedFiles = [], maxFullFiles = 2500, localCap = 120 } = {}) {
  if (!ws || ws.files.size === 0) return null;
  if (ws.symbolGraph && ws.symbolGraphDirty?.size > 0) {
    ws.symbolGraph = null;
    ws.symbolGraphDirty.clear();
  }
  if (ws.symbolGraph) return ws.symbolGraph;
  if (ws.files.size <= maxFullFiles) {
    ws.symbolGraph = buildSymbolCallGraph(ws.files);
    ws.symbolGraphDirty?.clear();
    return ws.symbolGraph;
  }
  if (Array.isArray(seedFiles) && seedFiles.length > 0) {
    const cacheKey = `${seedFiles.filter(Boolean).sort().join('|')}@${localCap}`;
    if (!ws.localSymbolGraphCache) ws.localSymbolGraphCache = new Map();
    if (ws.localSymbolGraphCache.has(cacheKey)) {
      const hit = ws.localSymbolGraphCache.get(cacheKey);
      ws.localSymbolGraphCache.delete(cacheKey);
      ws.localSymbolGraphCache.set(cacheKey, hit);
      return hit;
    }
    const built = buildSymbolCallGraph(buildLocalNeighborhoodFiles(ws, seedFiles, localCap));
    ws.localSymbolGraphCache.set(cacheKey, built);
    while (ws.localSymbolGraphCache.size > 16) {
      const oldest = ws.localSymbolGraphCache.keys().next().value;
      if (oldest === undefined) break;
      ws.localSymbolGraphCache.delete(oldest);
    }
    return built;
  }
  return null;
}

export function getDocRefGraphImpl(engine, rootDir) {
  const ws = engine.ensureWarm(rootDir);
  if (!ws || ws.files.size === 0) {
    return { ok: false, docCount: 0, codeRefEdgeCount: 0, refsToCode: new Map(), codeFromDoc: new Map() };
  }
  if (!ws.docRefGraph) {
    ws.docRefGraph = buildDocConfigReferenceGraph(ws.files);
  }
  return { ok: true, ...ws.docRefGraph };
}

export function getArchitectureClustersImpl(engine, rootDir, { maxClusters = 8, maxGodNodes = 5 } = {}) {
  const ws = engine.ensureWarm(rootDir);
  if (!ws || ws.files.size === 0) {
    return {
      ok: false,
      fileCount: 0,
      clusterCount: 0,
      modularityQ: 0,
      clusters: [],
      godNodes: [],
      fileToCluster: new Map(),
      formattedDigest: '',
    };
  }
  const symbolGraph = ensureSymbolGraph(ws, { maxFullFiles: 2500 });
  if (!ws.docRefGraph) {
    ws.docRefGraph = buildDocConfigReferenceGraph(ws.files);
  }
  const capClusters = Math.max(1, Number(maxClusters) || 8);
  const capGodNodes = Math.max(1, Number(maxGodNodes) || 5);
  if (!ws.archClusters || ws.archClusters._capClusters < capClusters || ws.archClusters._capGodNodes < capGodNodes) {
    const fetchClusters = Math.max(32, capClusters);
    const fetchGodNodes = Math.max(16, capGodNodes);
    const computed = detectArchitectureClusters(ws.files, ws.forwardDeps, ws.reverseDeps, {
      symbolGraph,
      docRefGraph: ws.docRefGraph,
      maxClusters: fetchClusters,
      maxGodNodes: fetchGodNodes,
    });
    ws.archClusters = {
      ...computed,
      _capClusters: fetchClusters,
      _capGodNodes: fetchGodNodes,
    };
  }
  const { _capClusters, _capGodNodes, ...baseArch } = ws.archClusters;
  return {
    ...baseArch,
    clusters: baseArch.clusters.slice(0, capClusters),
    godNodes: baseArch.godNodes.slice(0, capGodNodes),
  };
}

export function findGraphPathImpl(engine, rootDir, from, to, { maxDepth = 5, direction = 'both' } = {}) {
  const t0 = performance.now();
  const ws = engine.ensureWarm(rootDir);
  if (!ws || ws.files.size === 0) {
    return {
      ok: false,
      found: false,
      from: String(from || ''),
      to: String(to || ''),
      hops: 0,
      mode: 'none',
      path: [],
      edges: [],
      formattedHint: 'RAM Knowledge Graph error: workspace is empty or invalid.',
    };
  }
  const symbolGraph = ensureSymbolGraph(ws, { maxFullFiles: 2500 });
  if (!ws.docRefGraph) {
    ws.docRefGraph = buildDocConfigReferenceGraph(ws.files);
  }
  const res = findShortestGraphPath(symbolGraph, from, to, {
    maxDepth,
    direction,
    forwardDeps: ws.forwardDeps,
    reverseDeps: ws.reverseDeps,
    docRefGraph: ws.docRefGraph,
  });
  const latencyMs = Number((performance.now() - t0).toFixed(2));
  engine.recordCompletedOp('ram_graph_query', {
    target: `${String(from || '')} -> ${String(to || '')}`,
    latencyMs: res.elapsedMs || latencyMs,
  });
  return res;
}

export function queryKnowledgeGraphImpl(
  engine,
  rootDir,
  {
    mode = 'summary',
    from = '',
    to = '',
    target = '',
    maxDepth = 5,
    direction = 'both',
    maxClusters = 8,
    maxGodNodes = 5,
    startWatcher = true,
  } = {}
) {
  const t0 = performance.now();
  const ws = engine.ensureWarm(rootDir, { startWatcher });
  const qMode = String(mode || 'summary').trim().toLowerCase();
  if (!ws || ws.files.size === 0) {
    return { ok: false, mode: qMode, formatted: 'RAM Knowledge Graph error: workspace is empty or invalid.' };
  }

  const symbolGraph = ensureSymbolGraph(ws, { maxFullFiles: 2500 });
  if (!ws.docRefGraph) {
    ws.docRefGraph = buildDocConfigReferenceGraph(ws.files);
  }
  const elapsedNow = () => Number((performance.now() - t0).toFixed(2));

  const resolveTargetRel = (raw) => {
    const clean = String(raw || '').trim();
    if (!clean) return '';
    if (ws.files.has(clean)) return clean;
    const posix = clean.replace(/\\/g, '/').replace(/^\.\//, '');
    if (ws.files.has(posix)) return posix;
    if (path.isAbsolute(clean)) {
      const relAbs = toRelPath(ws.absRoot, path.resolve(clean));
      if (ws.files.has(relAbs)) return relAbs;
    }
    const low = posix.toLowerCase();
    for (const k of ws.files.keys()) {
      if (k.toLowerCase() === low) return k;
    }
    const suffixHits = [];
    const baseHits = [];
    for (const k of ws.files.keys()) {
      const kLow = k.toLowerCase();
      if (kLow.endsWith(`/${low}`)) suffixHits.push(k);
      else if (path.posix.basename(kLow) === low) baseHits.push(k);
    }
    if (suffixHits.length === 1) return suffixHits[0];
    if (suffixHits.length === 0 && baseHits.length === 1) return baseHits[0];
    return '';
  };

  if (qMode === 'path') {
    const srcStr = String(from || '').trim();
    const dstStr = String(to || '').trim();
    if (!srcStr || !dstStr) {
      return { ok: false, mode: 'path', formatted: 'ram_graph_query(mode="path") requires both "from" and "to".' };
    }
    const pathRes = findGraphPathImpl(engine, ws.absRoot, srcStr, dstStr, { maxDepth, direction });
    if (!pathRes.found) {
      const uNote = buildGraphUncertaintyNote({ mode: 'path', target: resolveTargetRel(srcStr) || srcStr, ws, resultCount: 0 });
      return {
        ...pathRes,
        mode: 'path',
        uncertaintyNote: uNote,
        formatted: uNote ? `${pathRes.formattedHint}\n${uNote}` : pathRes.formattedHint,
      };
    }
    const stepLines = [pathRes.formattedHint];
    for (let i = 0; i < pathRes.edges.length; i++) {
      const nA = pathRes.path[i];
      const nB = pathRes.path[i + 1];
      const edge = pathRes.edges[i];
      const labelA = nA?.kind === 'symbol' && nA.file ? `${nA.label} (${nA.file}:${nA.line})` : (nA?.file || nA?.label || edge.from);
      const labelB = nB?.kind === 'symbol' && nB.file ? `${nB.label} (${nB.file}:${nB.line})` : (nB?.file || nB?.label || edge.to);
      stepLines.push(`${i + 1}. ${labelA} --[${edge.relation} | ${edge.provenance}]--> ${labelB}`);
    }
    return { ...pathRes, mode: 'path', formatted: stepLines.join('\n') };
  }

  if (qMode === 'surprising_bridges' || qMode === 'bridges') {
    const arch = getArchitectureClustersImpl(engine, ws.absRoot, { maxClusters, maxGodNodes });
    const bridges = findSurprisingConnections(ws.files, arch, symbolGraph, ws.forwardDeps, { topN: 8 });
    engine.recordCompletedOp('ram_graph_query', { target: 'surprising_bridges', latencyMs: elapsedNow() });
    const lines = [
      `🌉 [Surprising Cross-Cluster Bridges | ${bridges.length} found | topo:${arch.topologyHash || 'v1'}]`,
      ...(bridges.length > 0
        ? bridges.map((b) => `- [${b.confidence} | ${b.relation}] \`${b.fromFile}:L${b.callSiteLine}\` (${b.fromCluster}) -> \`${b.toFile}\`${b.toSymbol ? `#${b.toSymbol}` : ''} (${b.toCluster})`)
        : ['- (no surprising cross-cluster bridges detected)']),
    ];
    return { ok: true, mode: 'surprising_bridges', topologyHash: arch.topologyHash, bridges, formatted: lines.join('\n') };
  }

  if (qMode === 'questions') {
    const arch = getArchitectureClustersImpl(engine, ws.absRoot, { maxClusters, maxGodNodes });
    const bridges = findSurprisingConnections(ws.files, arch, symbolGraph, ws.forwardDeps, { topN: 8 });
    const questions = suggestArchitectureQuestions(arch, bridges, { maxQuestions: 6 });
    engine.recordCompletedOp('ram_graph_query', { target: 'questions', latencyMs: elapsedNow() });
    const lines = [
      `❓ [Architecture Questions | ${questions.length}]`,
      ...(questions.length > 0
        ? questions.map((q, idx) => `${idx + 1}. [${q.confidence}] ${q.question}`)
        : ['- Architecture clusters are cohesive with no ambiguous cross-cluster bridges.']),
    ];
    return { ok: true, mode: 'questions', questions, formatted: lines.join('\n') };
  }

  if (qMode === 'affected') {
    const tgt = String(target || from || '').trim();
    if (!tgt) {
      return { ok: false, mode: 'affected', formatted: 'ram_graph_query(mode="affected") requires "target".' };
    }
    const aff = queryAffectedBlastGraph(ws.files, tgt, {
      forwardDeps: ws.forwardDeps,
      reverseDeps: ws.reverseDeps,
      symbolGraph,
      maxDepth,
    });
    engine.recordCompletedOp('ram_graph_query', { target: `affected:${tgt}`, latencyMs: elapsedNow() });
    const affectedCount = Array.isArray(aff?.affected) ? aff.affected.length : 0;
    const uNote = buildGraphUncertaintyNote({
      mode: 'affected',
      target: resolveTargetRel(tgt) || tgt,
      ws,
      resultCount: affectedCount,
    });
    return {
      ...aff,
      mode: 'affected',
      ...(uNote ? { uncertaintyNote: uNote, formatted: `${aff.formatted || ''}\n${uNote}`.trim() } : {}),
    };
  }

  if (qMode === 'report') {
    const arch = getArchitectureClustersImpl(engine, ws.absRoot, { maxClusters, maxGodNodes });
    const bridges = findSurprisingConnections(ws.files, arch, symbolGraph, ws.forwardDeps, { topN: 6 });
    const questions = suggestArchitectureQuestions(arch, bridges, { maxQuestions: 5 });
    engine.recordCompletedOp('ram_graph_query', { target: 'report', latencyMs: elapsedNow() });
    const reportLines = [
      `# Architecture Graph Report (\`${arch.topologyHash || 'v1'}\`)`,
      `- **Files**: ${arch.fileCount} | **Clusters**: ${arch.clusterCount} | **Modularity Q**: ${arch.modularityQ}`,
      '',
      '## God Nodes (Core Hubs)',
      ...(arch.godNodes.length > 0
        ? arch.godNodes.map((g) => `- \`${g.file}\` (in:${g.inDegree}, out:${g.outDegree}, docs:${g.docRefCount}, coupling:${g.couplingScore})`)
        : ['- None']),
      '',
      '## Architectural Clusters',
      ...(arch.clusters.length > 0
        ? arch.clusters.map((c) => `- **${c.label}** (\`${c.id}\`, ${c.size}f, hub: \`${c.hubFile}\`, int:${c.internalEdges}, ext:${c.externalEdges})`)
        : ['- None']),
      '',
      '## Surprising Cross-Cluster Bridges',
      ...(bridges.length > 0
        ? bridges.map((b) => `- [${b.confidence}] \`${b.fromFile}:L${b.callSiteLine}\` (${b.fromCluster}) -> \`${b.toFile}\` (${b.toCluster})`)
        : ['- None']),
      '',
      '## Suggested Questions',
      ...(questions.length > 0
        ? questions.map((q, i) => `${i + 1}. ${q.question}`)
        : ['- None']),
    ];
    return {
      ok: true,
      mode: 'report',
      topologyHash: arch.topologyHash,
      clusters: arch.clusters,
      godNodes: arch.godNodes,
      modularityQ: arch.modularityQ,
      fileCount: arch.fileCount,
      bridges,
      questions,
      formatted: reportLines.join('\n'),
    };
  }

  if (qMode === 'clusters' || qMode === 'god_nodes' || qMode === 'summary') {
    const arch = getArchitectureClustersImpl(engine, ws.absRoot, { maxClusters, maxGodNodes });
    engine.recordCompletedOp('ram_graph_query', { target: qMode, latencyMs: elapsedNow() });
    const lines = [
      `🧩 [Arch Graph | ${arch.fileCount} code files | ${arch.clusterCount} clusters | Q=${arch.modularityQ} | ${arch.elapsedMs}ms]`,
    ];
    if (qMode !== 'clusters') {
      lines.push('## God Nodes (High Coupling)');
      if (arch.godNodes.length === 0) {
        lines.push('- (none detected)');
      } else {
        for (const g of arch.godNodes) {
          lines.push(`- \`${g.file}\` — in:${g.inDegree}, out:${g.outDegree}, docs:${g.docRefCount}, symbols:${g.symbolCount}, coupling:${g.couplingScore}`);
        }
      }
    }
    if (qMode !== 'god_nodes') {
      lines.push('## Architectural Clusters');
      if (arch.clusters.length === 0) {
        lines.push('- (none detected)');
      } else {
        for (const c of arch.clusters) {
          const preview = c.files.slice(0, 6).join(', ') + (c.files.length > 6 ? ` +${c.files.length - 6} more` : '');
          lines.push(`- **${c.label}** (\`${c.id}\`, ${c.size} files, hub: \`${c.hubFile}\`, internal:${c.internalEdges}, external:${c.externalEdges}): ${preview}`);
        }
      }
    }
    return { ok: true, mode: qMode, ...arch, formatted: lines.join('\n') };
  }

  if (qMode === 'doc_refs') {
    const tgt = String(target || '').trim();
    if (!tgt) {
      return { ok: false, mode: 'doc_refs', formatted: 'ram_graph_query(mode="doc_refs") requires "target".' };
    }
    const rel = resolveTargetRel(tgt) || tgt.replace(/\\/g, '/').replace(/^\.\//, '');
    engine.recordCompletedOp('ram_graph_query', { target: rel, latencyMs: elapsedNow() });
    if (ws.docRefGraph.codeFromDoc?.has(rel)) {
      const outRefs = ws.docRefGraph.codeFromDoc.get(rel) || [];
      const lines = [
        `📎 [Doc/Config Outgoing Refs | DOC_REF] \`${rel}\` references ${outRefs.length} code module(s):`,
        ...outRefs.map((r) => `- \`${r.codeFile}\` [${r.kind}] (${r.evidence})`),
      ];
      return { ok: true, mode: 'doc_refs', target: rel, outgoing: outRefs, formatted: lines.join('\n') };
    }
    const docRes = queryDocRefsForFile(ws.docRefGraph, rel, { maxRefs: 16, includeChangelog: true });
    if (docRes.refs.length === 0) {
      const uNote = buildGraphUncertaintyNote({ mode: 'doc_refs', target: rel, ws, resultCount: 0 });
      return {
        ok: true,
        mode: 'doc_refs',
        target: rel,
        refs: [],
        uncertaintyNote: uNote,
        formatted: `📎 [Doc/Config Refs] No doc/config references found for "${rel}".${uNote ? `\n${uNote}` : ''}`,
      };
    }
    const lines = [
      `📎 [Doc/Config Refs | DOC_REF] \`${docRes.targetFile}\` referenced by ${docRes.totalRefs} file(s):`,
      ...docRes.refs.map((r) => `- \`${r.docFile}\` [${r.kind}${r.isChangelog ? ', changelog' : ''}] (${r.evidence})`),
    ];
    return { ok: true, mode: 'doc_refs', target: docRes.targetFile, refs: docRes.refs, formatted: lines.join('\n') };
  }

  if (qMode === 'explain') {
    const tgt = String(target || '').trim();
    if (!tgt) {
      return { ok: false, mode: 'explain', formatted: 'ram_graph_query(mode="explain") requires "target".' };
    }
    const arch = getArchitectureClustersImpl(engine, ws.absRoot, { maxClusters, maxGodNodes });
    const rel = resolveTargetRel(tgt);
    const activeSymGraph = ensureSymbolGraph(ws, { seedFiles: rel ? [rel] : [], maxFullFiles: 2500 });
    engine.recordCompletedOp('ram_graph_query', { target: rel || tgt, latencyMs: elapsedNow() });

    if (rel && ws.files.has(rel)) {
      const entry = ws.files.get(rel);
      const imports = Array.from(ws.forwardDeps.get(rel) || []).sort();
      const importedBy = Array.from(ws.reverseDeps.get(rel) || []).sort();
      const cluster = arch.fileToCluster?.get(rel) || null;
      const godInfo = arch.godNodes?.find((g) => g.file === rel) || null;
      const lines = [`🧭 [GraphExplain | File] \`${rel}\``];
      if (cluster) {
        lines.push(`- Cluster: **${cluster.label}** (\`${cluster.id}\`, ${cluster.size} files, hub: \`${cluster.hubFile}\`)${godInfo ? ` | 🌟 God Node (coupling:${godInfo.couplingScore})` : ''}`);
      }
      lines.push(`- Imports [EXTRACTED | IMPORT] (${imports.length}): ${imports.length > 0 ? imports.slice(0, 8).join(', ') : 'none'}`);
      lines.push(`- Imported By [EXTRACTED | IMPORTED_BY] (${importedBy.length}): ${importedBy.length > 0 ? importedBy.slice(0, 8).join(', ') : 'none'}`);
      if (ws.docRefGraph.codeFromDoc?.has(rel)) {
        const outRefs = ws.docRefGraph.codeFromDoc.get(rel) || [];
        lines.push(`- References Code [DOC_REF] (${outRefs.length}): ${outRefs.slice(0, 8).map((r) => `${r.codeFile} (${r.evidence})`).join(', ')}`);
      } else {
        const docRes = queryDocRefsForFile(ws.docRefGraph, rel, { maxRefs: 8, includeChangelog: true });
        if (docRes.refs.length > 0) {
          lines.push(`- Referenced By Docs/Configs [DOC_REF] (${docRes.totalRefs}): ${docRes.refs.slice(0, 6).map((r) => `${r.docFile} (${r.kind}: ${r.evidence})`).join(', ')}`);
        }
      }
      try {
        const co = queryCoChangePartners(ws.absRoot, rel, { excludeStaticImporters: ws.reverseDeps.get(rel) || new Set() });
        if (co?.implicitPartners?.length > 0) {
          lines.push(`- Git Co-Change [GIT_COCHANGE]: ${co.implicitPartners.slice(0, 4).map((p) => `${p.file} (${p.score})`).join(', ')}`);
        }
      } catch {
        if (engine?.errorStats) engine.errorStats.parse += 1;
      }
      const syms = (entry?.symbols || [])
        .filter((s) => s?.name && s.name !== 'anonymous' && s.kind !== 'class')
        .slice(0, 2)
        .map((s) => s.name);
      if (syms.length > 0 && activeSymGraph) {
        const ego = querySymbolEgoGraph(activeSymGraph, syms, { maxCallers: 4, maxCallees: 4 });
        if (ego?.edgesFound > 0 && ego.formattedHint) {
          lines.push(`- ${ego.formattedHint}`);
        }
      }
      return { ok: true, mode: 'explain', target: rel, found: true, formatted: lines.join('\n') };
    }

    const symClean = tgt.includes('#') ? tgt.split('#').pop() : tgt;
    let symMatches = [];
    if (activeSymGraph?.definedSymbols?.has(symClean) || activeSymGraph?.callersOf?.has(symClean) || activeSymGraph?.calleesOf?.has(symClean)) {
      symMatches = [symClean];
    } else {
      const lower = activeSymGraph?.symbolNamesLower?.get(symClean.toLowerCase());
      if (lower) symMatches = Array.from(lower).sort();
    }
    if (symMatches.length > 0 && activeSymGraph) {
      const primary = symMatches[0];
      const defs = activeSymGraph.definedSymbols?.get(primary) || [];
      const ego = querySymbolEgoGraph(activeSymGraph, primary, { maxCallers: 5, maxCallees: 5 });
      const lines = [`🧭 [GraphExplain | Symbol] \`${primary}\``];
      if (defs.length > 0) {
        lines.push(`- Defined In [EXTRACTED]: ${defs.map((d) => `${d.file}:${d.startLine}`).join(', ')}`);
        const defCluster = arch.fileToCluster?.get(defs[0].file);
        if (defCluster) {
          lines.push(`- Cluster: **${defCluster.label}** (\`${defCluster.id}\`, hub: \`${defCluster.hubFile}\`)`);
        }
        const docRes = queryDocRefsForFile(ws.docRefGraph, defs[0].file, { maxRefs: 5, includeChangelog: true });
        if (docRes.refs.length > 0) {
          lines.push(`- ${docRes.formattedHint}`);
        }
      }
      if (ego?.formattedHint) {
        lines.push(`- ${ego.formattedHint}`);
      }
      return { ok: true, mode: 'explain', target: primary, found: true, formatted: lines.join('\n') };
    }

    return {
      ok: true,
      mode: 'explain',
      target: tgt,
      found: false,
      formatted: `🧭 [GraphExplain] Target "${tgt}" not found in cached RAM workspace.`,
    };
  }

  return {
    ok: false,
    mode: qMode,
    formatted: `Unsupported ram_graph_query mode "${qMode}". Expected one of: path, clusters, god_nodes, doc_refs, explain, summary, surprising_bridges, bridges, questions, affected, report.`,
  };
}

export function getSymbolEgoGraphImpl(engine, rootDir, symbolOrQuery, { maxCallers = 5, maxCallees = 5, seedFiles = [] } = {}) {
  const ws = engine.ensureWarm(rootDir);
  if (!ws || ws.files.size === 0) {
    return { ok: false, edgesFound: 0, callers: [], callees: [], formattedHint: '' };
  }
  const graph = ensureSymbolGraph(ws, { seedFiles, maxFullFiles: 1500, localCap: 120 });
  const res = querySymbolEgoGraph(graph, symbolOrQuery, { maxCallers, maxCallees });
  return { ok: true, ...res };
}

export function getEgoGraphHintForResultsImpl(engine, rootDir, results = [], query = '') {
  const ws = engine.getOrCreateWorkspace(rootDir);
  if (!ws || ws.files.size === 0) {
    return { ok: false, edgesFound: 0, callers: [], callees: [], formattedHint: '' };
  }
  const targetSyms = [];
  const seen = new Set();
  const seedFiles = [];
  for (const r of (Array.isArray(results) ? results.slice(0, 3) : [])) {
    if (r?.file) seedFiles.push(r.file);
    const entry = ws.files.get(r?.file);
    if (!entry || !Array.isArray(entry.symbols)) continue;
    const sLine = Number(r.startLine) || 1;
    const eLine = Number(r.endLine) || sLine + 40;
    for (const sym of entry.symbols) {
      if (!sym?.name || sym.name === 'anonymous' || sym.kind === 'class') continue;
      if ((sym.endLine || sym.startLine) >= sLine && sym.startLine <= eLine) {
        if (!seen.has(sym.name)) {
          seen.add(sym.name);
          targetSyms.push(sym.name);
        }
        if (targetSyms.length >= 3) break;
      }
    }
    if (targetSyms.length >= 3) break;
  }
  const targetInput = targetSyms.length > 0 ? targetSyms : String(query || '');
  return getSymbolEgoGraphImpl(engine, ws.absRoot, targetInput, { seedFiles });
}

export function getTwoHopContractStripImpl(engine, rootDir, matchedResults = []) {
  const ws = engine.getOrCreateWorkspace(rootDir);
  if (!ws || ws.files.size === 0 || !Array.isArray(matchedResults) || matchedResults.length === 0) {
    return { ok: false, callers: [], callees: [], formattedHint: '' };
  }
  const primary = matchedResults[0];
  const primaryEntry = ws.files.get(primary?.file);
  if (!primaryEntry) {
    return { ok: false, callers: [], callees: [], formattedHint: '' };
  }
  const graph = ensureSymbolGraph(ws, { seedFiles: [primary?.file], maxFullFiles: 1500, localCap: 150 });

  const sLine = Number(primary.startLine) || 1;
  const eLine = Number(primary.endLine) || sLine + 40;
  const focusSyms = [];
  for (const sym of primaryEntry.symbols || []) {
    if (!sym?.name || sym.name === 'anonymous' || sym.kind === 'class') continue;
    if ((sym.endLine || sym.startLine) >= sLine && sym.startLine <= eLine) {
      focusSyms.push(sym.name);
      if (focusSyms.length >= 2) break;
    }
  }
  if (focusSyms.length === 0 && Array.isArray(primaryEntry.symbols) && primaryEntry.symbols.length > 0) {
    for (const sym of primaryEntry.symbols) {
      if (sym?.name && sym.name !== 'anonymous') {
        focusSyms.push(sym.name);
        if (focusSyms.length >= 2) break;
      }
    }
  }
  if (focusSyms.length === 0) {
    return { ok: false, callers: [], callees: [], formattedHint: '' };
  }

  const ego = querySymbolEgoGraph(graph, focusSyms, { maxCallers: 4, maxCallees: 4 });
  if (!ego || ego.edgesFound === 0) {
    return { ok: true, callers: [], callees: [], formattedHint: '' };
  }

  const calleeSignatures = [];
  for (const c of ego.callees || []) {
    const targetRel = c.file || '';
    let sig = `${c.name}()`;
    if (targetRel && ws.files.has(targetRel)) {
      const tEntry = ws.files.get(targetRel);
      const foundSym = (tEntry?.symbols || []).find((s) => s.name === c.name);
      if (foundSym?.signature) {
        sig = String(foundSym.signature).replace(/\s+/g, ' ').trim();
      }
      calleeSignatures.push(`${targetRel}#${sig}`);
    } else if (c.isRepoSymbol) {
      calleeSignatures.push(sig);
    }
  }

  const callerPins = (ego.callers || [])
    .filter((c) => c.file)
    .map((c) => `${c.file}:${c.line || 1}`);

  if (calleeSignatures.length === 0 && callerPins.length === 0) {
    return { ok: true, callers: [], callees: [], formattedHint: '' };
  }

  const parts = [];
  if (calleeSignatures.length > 0) parts.push(`callees: ${calleeSignatures.slice(0, 3).join('; ')}`);
  if (callerPins.length > 0) parts.push(`callers: ${callerPins.slice(0, 4).join(', ')}`);
  let formattedHint = `🧬 [2-Hop Contracts] ${focusSyms[0]} -> ${parts.join(' | ')}`;
  if (formattedHint.length > 420) {
    formattedHint = `${formattedHint.slice(0, 417)}...`;
  }

  return {
    ok: true,
    callers: callerPins,
    callees: calleeSignatures,
    formattedHint,
  };
}

export function getFastBlastRadiusImpl(engine, rootDir, targetFilePath) {
  const ws = engine.ensureWarm(rootDir);
  if (!ws || !targetFilePath) return null;
  const absTarget = path.isAbsolute(targetFilePath) ? path.resolve(targetFilePath) : path.resolve(ws.absRoot, targetFilePath);
  const rawRel = toRelPath(ws.absRoot, absTarget);
  if (!rawRel || rawRel === '..' || rawRel.startsWith('../') || path.isAbsolute(rawRel)) {
    return { dependents: [], coChangePartners: [], docRefs: [], formattedHint: '' };
  }
  const rel = typeof engine._resolveCanonicalRel === 'function' ? engine._resolveCanonicalRel(ws, rawRel) : rawRel;
  const deps = Array.from(ws.reverseDeps.get(rel) || []);
  const topDeps = deps.slice(0, 8);
  let formattedHint = deps.length > 0
    ? `🎯 [RAM Blast Radius] Edits in ${path.basename(rel)} affect ${deps.length} module(s): ${topDeps.join(', ')}. Keep exported signatures compatible!`
    : '';
  let coChangePartners = [];
  try {
    if (loadCpuConfig().cpuSotaEngines !== false) {
      const coChange = queryCoChangePartners(ws.absRoot, rel, { excludeStaticImporters: new Set(deps) });
      if (coChange?.implicitPartners?.length > 0) {
        coChangePartners = coChange.implicitPartners;
        formattedHint = formattedHint ? `${formattedHint}\n${coChange.formattedHint}` : coChange.formattedHint;
        try {
          recordCpuCompressionSaving({ kind: 'cochange', savedChars: 1200, latencyMs: 0.5 });
        } catch {}
      }
    }
  } catch {
    if (engine?.errorStats) engine.errorStats.parse += 1;
  }
  let docRefs = [];
  try {
    if (!ws.docRefGraph) {
      ws.docRefGraph = buildDocConfigReferenceGraph(ws.files);
    }
    const docRes = queryDocRefsForFile(ws.docRefGraph, rel, { maxRefs: 5, includeChangelog: false });
    if (docRes?.refs?.length > 0) {
      docRefs = docRes.refs;
      formattedHint = formattedHint ? `${formattedHint}\n${docRes.formattedHint}` : docRes.formattedHint;
    }
  } catch {
    if (engine?.errorStats) engine.errorStats.parse += 1;
  }
  if (!formattedHint && topDeps.length === 0 && docRefs.length === 0) {
    return { dependents: [], coChangePartners: [], docRefs: [], formattedHint: '' };
  }
  return {
    dependents: topDeps.map((f) => ({ file: f })),
    docRefs,
    coChangePartners,
    formattedHint,
  };
}

export function verifyContractsInRamImpl(engine, rootDir, editedFilePath) {
  const ws = engine.getOrCreateWorkspace(rootDir);
  if (!ws || ws.files.size === 0 || !editedFilePath) {
    return { ok: false, valid: true, alert: '', brokenImports: [], semanticIssues: [], cloneWarning: '' };
  }
  const absEdited = path.isAbsolute(editedFilePath) ? path.resolve(editedFilePath) : path.resolve(ws.absRoot, editedFilePath);
  const rawRelEdited = toRelPath(ws.absRoot, absEdited);
  if (!rawRelEdited || rawRelEdited === '..' || rawRelEdited.startsWith('../') || path.isAbsolute(rawRelEdited)) {
    return { ok: false, valid: true, alert: '', brokenImports: [], semanticIssues: [], cloneWarning: '' };
  }
  const relEdited = typeof engine._resolveCanonicalRel === 'function' ? engine._resolveCanonicalRel(ws, rawRelEdited) : rawRelEdited;
  const textCache = new Map();

  const getFileText = (targetPath) => {
    const absP = path.isAbsolute(targetPath) ? path.resolve(targetPath) : path.resolve(ws.absRoot, targetPath);
    const rawRel = toRelPath(ws.absRoot, absP);
    const rel = typeof engine._resolveCanonicalRel === 'function' ? engine._resolveCanonicalRel(ws, rawRel) : rawRel;
    if (textCache.has(rel)) return textCache.get(rel);
    const entry = ws.files.get(rel);
    const buf = entry?.buf;
    if (entry && buf) {
      const txt = buf.toString('utf8');
      textCache.set(rel, txt);
      return txt;
    }
    return null;
  };

  const listSiblingFiles = (dirAbsPath) => {
    const relDir = toRelPath(ws.absRoot, path.resolve(dirAbsPath));
    const prefix = relDir && relDir !== '.' ? `${relDir}/` : '';
    const out = [];
    for (const fRel of ws.files.keys()) {
      if (prefix === '') {
        if (!fRel.includes('/')) out.push(fRel);
      } else if (fRel.startsWith(prefix)) {
        const rest = fRel.slice(prefix.length);
        if (rest && !rest.includes('/')) out.push(rest);
      }
    }
    return out;
  };

  const precomputedDependents = Array.from(ws.reverseDeps.get(relEdited) || []);
  const opts = { getFileText, listSiblingFiles, precomputedDependents };

  const impCheck = verifyImportContracts(ws.absRoot, absEdited, opts) || { valid: true, brokenImports: [], formattedAlert: '' };
  const semCheck = verifySemanticContracts(ws.absRoot, absEdited, opts) || { valid: true, issues: [], formattedAlert: '' };
  const alerts = [impCheck.formattedAlert, semCheck.formattedAlert].filter(Boolean);
  const semanticIssues = [...(semCheck.issues || [])];
  let arityValid = true;
  let cloneWarning = '';

  try {
    if (loadCpuConfig().cpuSotaEngines !== false) {
      const editedText = getFileText(absEdited);
      if (editedText) {
        const depEntries = precomputedDependents
          .map((dRel) => ({ file: dRel, text: getFileText(path.resolve(ws.absRoot, dRel)) || '' }))
          .filter((d) => d.text);
        if (depEntries.length > 0) {
          const arityCheck = verifyExportArityAndKeyContracts(relEdited, editedText, depEntries);
          if (arityCheck && !arityCheck.valid) {
            arityValid = false;
            semanticIssues.push(...(arityCheck.issues || []));
            if (arityCheck.formattedAlert) alerts.push(arityCheck.formattedAlert);
            try {
              recordCpuCompressionSaving({ kind: 'arity', savedChars: 1800, latencyMs: 0.8 });
            } catch {}
          }
        }
        if (!ws.simHashIndex) {
          ws.simHashIndex = buildWorkspaceSimHashIndex(ws.files);
        }
        const curHashes = computeFileSimHashes({
          relPath: relEdited,
          ext: path.extname(relEdited).toLowerCase(),
          text: editedText,
        });
        if (curHashes.length > 0) {
          ws.simHashIndex.set(relEdited, curHashes);
          const cloneRes = findNearDuplicateFunctions(ws.simHashIndex, relEdited, editedText);
          if (cloneRes?.formattedHint) {
            cloneWarning = cloneRes.formattedHint;
            try {
              recordCpuCompressionSaving({ kind: 'simhash', savedChars: 900, latencyMs: 0.6 });
            } catch {}
          }
        } else {
          ws.simHashIndex.delete(relEdited);
        }
      } else {
        ws.simHashIndex?.delete(relEdited);
      }
    }
  } catch {
    if (engine?.errorStats) engine.errorStats.parse += 1;
  }

  return {
    ok: true,
    valid: impCheck.valid !== false && semCheck.valid !== false && arityValid,
    alert: alerts.join(' '),
    brokenImports: impCheck.brokenImports || [],
    semanticIssues,
    cloneWarning,
  };
}

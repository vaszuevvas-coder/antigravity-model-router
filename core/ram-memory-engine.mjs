/**
 * @file ram-memory-engine.mjs
 * @description Persistent In-RAM Project Memory Engine (up to configurable GB budget, default 12 GB).
 * Stores raw UTF-8 file Buffers + Int32Array line offsets + AST symbols + inverted token index + reverse deps
 * in memory with incremental fs.watch invalidation and strict LRU eviction.
 */

import fs from 'node:fs';
import path from 'node:path';
import { extractFileAllMetadata } from './repo-mapper.mjs';
import { loadCpuConfig } from './cpu-worker-pool.mjs';
import { buildSymbolCallGraph, foldCodeWithKnapsack } from './cpu-ast-graph-compressor.mjs';
import { buildWorkspaceSimHashIndex, computeFileSimHashes } from './cpu-graph-contracts.mjs';
import { checkFileSecurity } from './security-guard.mjs';
import {
  CsrInvertedIndex,
  EpisodicRepairIndex,
  ObservationWindowMemoizer,
  SharedRamArena,
} from './ram-sota-arena.mjs';
import { knowledgeHub } from './sqlite-knowledge-hub.mjs';

import {
  computeBufSha1,
  DEFAULT_BUDGET_MB,
  MAX_SINGLE_FILE_BYTES,
  DEFAULT_MAX_FILES_PER_WS,
  IGNORED_DIRS,
  IGNORED_FILES,
  TEXT_EXTENSIONS,
  CODE_EXTENSIONS,
  buildLineOffsets,
  resolveMaxTrigramsForExt,
  extractTrigrams,
  buildFileSearchStructures,
  toRelPath,
  resolveImportRel,
  loadJsAliasRules,
  augmentJsMethodSymbols,
} from './ram/ram-index-helpers.mjs';
import {
  buildHybridGoldContextImpl,
  searchWorkspace,
  searchWorkspaceSemantic,
} from './ram/ram-search.mjs';
import {
  findCrossLayerSeamsImpl,
  findSymbolSlicesFastImpl,
  skeletonizeFile,
  skimCodeBlocksByQueryImpl,
  sliceFile,
} from './ram/ram-slicer.mjs';
import {
  buildLocalNeighborhoodFiles,
  findGraphPathImpl,
  getArchitectureClustersImpl,
  getDocRefGraphImpl,
  getEgoGraphHintForResultsImpl,
  getFastBlastRadiusImpl,
  getSymbolEgoGraphImpl,
  getTwoHopContractStripImpl,
  queryKnowledgeGraphImpl,
  verifyContractsInRamImpl,
} from './ram/ram-graph-queries.mjs';
import {
  buildGroundedChatPackImpl,
  getContextPackImpl,
  getFastRepoMapImpl,
  searchComposerContextFastImpl,
} from './ram/ram-context-packs.mjs';

export { inferContextPruningPhase, enrichMultiTurnChatQuery } from './ram/ram-index-helpers.mjs';

export class RamMemoryEngine {
  /**
   * @param {object} [options={}]
   * @param {number} [options.budgetMb=4096] Maximum RAM cache budget in MB (default 4 GB, up to 32 GB)
   * @param {(absRoot: string, entry: object) => void} [options.onFileUpsert] Optional file upsert callback
   */
  constructor(options = {}) {
    const safeOpts = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
    const {
      budgetMb = DEFAULT_BUDGET_MB,
      budgetBytes = 0,
      onFileUpsert = null,
      knowledgeHub: customHub = null,
      sqliteKnowledgeEnabled = true,
    } = safeOpts;
    this.setBudgetMb(budgetMb);
    if (Number.isFinite(Number(budgetBytes)) && Number(budgetBytes) >= 16 * 1024) {
      this.budgetBytes = Math.round(Number(budgetBytes));
      this.budgetMb = Number((this.budgetBytes / (1024 * 1024)).toFixed(3));
    }
    this.onFileUpsert = typeof onFileUpsert === 'function' ? onFileUpsert : null;
    this.knowledgeHub = customHub || knowledgeHub;
    this.sqliteKnowledgeEnabled = sqliteKnowledgeEnabled !== false;
    /** @type {Map<string, object>} absRoot -> workspace cache entry */
    this.workspaces = new Map();
    this.totalCacheBytes = 0;
    this.stats = {
      hits: 0,
      misses: 0,
      evictions: 0,
      searches: 0,
      slices: 0,
      watcherUpdates: 0,
    };
    this.errorStats = {
      sqlite: 0,
      watcher: 0,
      parse: 0,
      prefetch: 0,
      gpu: 0,
    };
    this.memoizer = new ObservationWindowMemoizer();
    this.repairIndex = new EpisodicRepairIndex();
    this.sotaStats = {
      speculativePrefetches: 0,
      csrLookups: 0,
      zeroCopyBatches: 0,
      sliceSavedChars: 0,
    };
    this.activity = {
      activeOps: 0,
      opSeq: 0,
      lastActiveAt: 0,
      lastOp: '',
      lastTarget: '',
      lastLatencyMs: 0,
      burstCount: 0,
      burstWindowStartAt: 0,
    };
  }

  /**
   * Marks the start of an asynchronous in-RAM operation.
   * @param {string} op
   * @param {string} [target='']
   */
  beginActivityOp(op, target = '') {
    const now = Date.now();
    this.activity.activeOps += 1;
    this.activity.opSeq += 1;
    this.activity.lastActiveAt = now;
    this.activity.lastOp = String(op || 'ram_op');
    if (target) this.activity.lastTarget = String(target).slice(0, 80);
  }

  /**
   * Records a completed in-RAM query/slice operation for real-time UI telemetry & afterglow.
   * @param {string} op
   * @param {{ target?: string, latencyMs?: number, decrementActive?: boolean }} [opts={}]
   */
  recordCompletedOp(op, { target = '', latencyMs = 0, decrementActive = false } = {}) {
    const now = Date.now();
    if (decrementActive) {
      this.activity.activeOps = Math.max(0, this.activity.activeOps - 1);
    }
    if (now - this.activity.burstWindowStartAt > 4000) {
      this.activity.burstWindowStartAt = now;
      this.activity.burstCount = 1;
    } else {
      this.activity.burstCount += 1;
    }
    this.activity.opSeq += 1;
    this.activity.lastActiveAt = now;
    this.activity.lastOp = String(op || 'ram_op');
    if (target) this.activity.lastTarget = String(target).slice(0, 80);
    this.activity.lastLatencyMs = Math.max(0, Number(Number(latencyMs || 0).toFixed(2)) || 0);
  }

  /**
   * Computes current RAM activity state (idle standby vs active question solving + afterglow).
   * @param {{ now?: number, afterglowMs?: number }} [opts={}]
   */
  getLiveActivitySnapshot({ now = Date.now(), afterglowMs = 3200 } = {}) {
    const lastAt = this.activity.lastActiveAt || 0;
    const msSinceLast = lastAt > 0 ? Math.max(0, now - lastAt) : null;
    const inAfterglow = msSinceLast !== null && msSinceLast <= afterglowMs;
    const isWorking = this.activity.activeOps > 0 || inAfterglow;
    const afterglowRatio = this.activity.activeOps > 0
      ? 1
      : (inAfterglow ? Number(Math.max(0, 1 - msSinceLast / afterglowMs).toFixed(3)) : 0);
    return {
      activeOps: this.activity.activeOps,
      opSeq: this.activity.opSeq,
      lastActiveAt: lastAt || null,
      msSinceLast,
      lastOp: this.activity.lastOp || '',
      lastTarget: this.activity.lastTarget || '',
      lastLatencyMs: this.activity.lastLatencyMs || 0,
      burstCount: (msSinceLast !== null && msSinceLast <= 4500) ? this.activity.burstCount : 0,
      isWorking,
      afterglowRatio,
    };
  }

  /**
   * Updates the RAM budget cap dynamically (clamped between 512 MB and 32768 MB).
   * @param {number} budgetMb
   */
  setBudgetMb(budgetMb) {
    const mb = Math.max(512, Math.min(32768, Number(budgetMb) || DEFAULT_BUDGET_MB));
    this.budgetMb = mb;
    this.budgetBytes = mb * 1024 * 1024;
    if (this.totalCacheBytes > this.budgetBytes) {
      this.evictToTarget(Math.floor(this.budgetBytes * 0.9));
    }
  }

  /**
   * Gets or creates workspace slot in RAM.
   * @param {string} rootDir
   * @returns {object|null}
   */
  getOrCreateWorkspace(rootDir) {
    if (!rootDir || typeof rootDir !== 'string') return null;
    const absRoot = path.resolve(rootDir);
    const wsKey = process.platform === 'win32' ? absRoot.toLowerCase() : absRoot;
    let existsDir = false;
    try {
      existsDir = fs.existsSync(absRoot) && fs.statSync(absRoot).isDirectory();
    } catch {
      existsDir = false;
    }
    if (!existsDir) {
      if (this.workspaces.has(wsKey)) {
        this.evict(absRoot);
      }
      return null;
    }

    let ws = this.workspaces.get(wsKey);
    if (!ws) {
      ws = {
        wsKey,
        absRoot,
        files: new Map(), // relPath -> entry
        filesLower: new Map(), // lower(relPath) -> canonical relPath
        tokenIndex: new Map(), // token -> Set<relPath>
        trigramIndex: new Map(), // 3-gram -> Set<relPath>
        fieldPostings: new Map(), // token -> Map<relPath, { pe, sig, body, doc }>
        fieldLenSums: { pe: 0, sig: 0, body: 0, doc: 0 },
        forwardDeps: new Map(), // importerRel -> Set<targetRel>
        reverseDeps: new Map(), // targetRel -> Set<importerRel>
        repoMapCache: new Map(), // maxChars -> markdown
        symbolGraph: null, // lazy RepoGraph 1-hop symbol call graph
        localSymbolGraphCache: new Map(), // bounded LRU local neighborhood graphs (>maxFullFiles)
        docRefGraph: null, // lazy doc/config/skill <-> code reference graph
        archClusters: null, // lazy community clusters & God Nodes
        simHashIndex: null,
        arena: new SharedRamArena(),
        csrIndex: null,
        speculativeSkeletonCache: new Map(),
        prefetchTimer: null,
        watcher: null,
        watchTimers: new Map(),
        warmedAt: 0,
        lastAccessTs: Date.now(),
        totalBytes: 0,
        epoch: 0,
        _warmAsyncPromise: null,
      };
      this.workspaces.set(wsKey, ws);
    }
    ws.lastAccessTs = Date.now();
    return ws;
  }

  _resolveCanonicalRel(ws, relPath) {
    if (!ws || !relPath) return relPath;
    if (ws.files.has(relPath)) return relPath;
    if (process.platform === 'win32' && ws.filesLower) {
      return ws.filesLower.get(relPath.toLowerCase()) || relPath;
    }
    return relPath;
  }

  /**
   * Moves an accessed entry to the tail of `ws.files` Map for O(1) LRU tracking.
   * @param {object} ws
   * @param {object} entry
   */
  _touchEntry(ws, entry) {
    if (!ws || !entry) return;
    entry.lastAccessTs = Date.now();
    if (ws.files.get(entry.relPath) === entry) {
      ws.files.delete(entry.relPath);
      ws.files.set(entry.relPath, entry);
    }
  }

  /**
   * Bounded LRU insertion into `ws.speculativeSkeletonCache`.
   * @param {object} ws
   * @param {string} relPath
   * @param {object} record
   * @param {number} [maxEntries=96]
   */
  _setSpeculativeSkeleton(ws, relPath, record, maxEntries = 96) {
    if (!ws?.speculativeSkeletonCache || !relPath) return;
    if (ws.speculativeSkeletonCache.has(relPath)) {
      ws.speculativeSkeletonCache.delete(relPath);
    }
    ws.speculativeSkeletonCache.set(relPath, record);
    while (ws.speculativeSkeletonCache.size > maxEntries) {
      const oldestKey = ws.speculativeSkeletonCache.keys().next().value;
      if (oldestKey === undefined) break;
      ws.speculativeSkeletonCache.delete(oldestKey);
    }
  }

  /**
   * Unlinks outgoing dependency edges for a single importer in O(imports).
   * @param {object} ws
   * @param {string} importerRel
   */
  unlinkFileDeps(ws, importerRel) {
    const prevTargets = ws.forwardDeps?.get(importerRel);
    if (!prevTargets) return;
    for (const targetRel of prevTargets) {
      const revSet = ws.reverseDeps.get(targetRel);
      if (revSet) {
        revSet.delete(importerRel);
        if (revSet.size === 0) ws.reverseDeps.delete(targetRel);
      }
    }
    ws.forwardDeps.delete(importerRel);
  }

  _ensureGoDepMeta(ws) {
    if (!ws) return { goModulePrefix: '', goPkgMainFile: null };
    if (ws.goModulePrefix === undefined || ws.goModulePrefix === null) {
      let modPrefix = '';
      try {
        const goModPath = path.join(ws.absRoot, 'go.mod');
        if (fs.existsSync(goModPath)) {
          const rawMod = fs.readFileSync(goModPath, 'utf8').slice(0, 8192);
          const m = /^\s*module\s+([^\s#]+)/m.exec(rawMod);
          if (m && m[1]) modPrefix = m[1].trim();
        }
      } catch {}
      ws.goModulePrefix = modPrefix;
    }
    if (!ws.goModulePrefix) {
      return { goModulePrefix: '', goPkgMainFile: null };
    }
    if (!(ws.goPkgMainFile instanceof Map)) {
      const pkgMap = new Map();
      const scoreGoEntry = (dir, rel) => {
        const base = path.posix.basename(rel).toLowerCase();
        if (base === 'app.go' || base === 'main.go') return 1;
        if (dir && base === `${path.posix.basename(dir).toLowerCase()}.go`) return 2;
        if (base === 'doc.go') return 4;
        return 3;
      };
      const bestScores = new Map();
      for (const rel of ws.files.keys()) {
        if (!rel.endsWith('.go') || rel.endsWith('_test.go')) continue;
        const dirRaw = path.posix.dirname(rel);
        const dir = dirRaw === '.' ? '' : dirRaw;
        const sc = scoreGoEntry(dir, rel);
        const prevSc = bestScores.get(dir) ?? 99;
        if (sc < prevSc || (sc === prevSc && rel < (pkgMap.get(dir) || '~'))) {
          bestScores.set(dir, sc);
          pkgMap.set(dir, rel);
        }
      }
      ws.goPkgMainFile = pkgMap;
    }
    return { goModulePrefix: ws.goModulePrefix, goPkgMainFile: ws.goPkgMainFile };
  }

  _ensureJsAliasMeta(ws) {
    if (!ws) return null;
    if (ws.jsAliasMeta === undefined) {
      ws.jsAliasMeta = loadJsAliasRules(ws.absRoot);
    }
    return ws.jsAliasMeta;
  }

  _getResolveOptsForFile(ws, relPath) {
    const isJsTs = /\.(?:[cm]?[jt]sx?)$/i.test(relPath);
    const goMeta = relPath.endsWith('.go') ? this._ensureGoDepMeta(ws) : null;
    const jsAliases = isJsTs ? this._ensureJsAliasMeta(ws) : null;
    const filesLower = process.platform === 'win32' && ws?.filesLower ? ws.filesLower : null;
    return (goMeta || jsAliases || filesLower)
      ? { ...(goMeta || {}), ...(jsAliases ? { jsAliases } : {}), ...(filesLower ? { filesLower } : {}) }
      : undefined;
  }

  /**
   * Links outgoing dependency edges for a single file entry in O(imports).
   * @param {object} ws
   * @param {object} entry
   */
  linkFileDeps(ws, entry) {
    this.unlinkFileDeps(ws, entry.relPath);
    const isGoTest = entry.relPath.endsWith('_test.go');
    if ((!entry.imports || entry.imports.length === 0) && !isGoTest) return;
    const resolveOpts = this._getResolveOptsForFile(ws, entry.relPath);
    const targets = new Set();
    for (const spec of entry.imports || []) {
      const targetRel = resolveImportRel(entry.relPath, spec, ws.files, resolveOpts);
      if (!targetRel || targetRel === entry.relPath) continue;
      targets.add(targetRel);
      let depSet = ws.reverseDeps.get(targetRel);
      if (!depSet) {
        depSet = new Set();
        ws.reverseDeps.set(targetRel, depSet);
      }
      depSet.add(entry.relPath);
    }
    // Pair Go *_test.go with sibling *.go implementation file
    if (isGoTest) {
      const implCand = `${entry.relPath.slice(0, -8)}.go`;
      if (ws.files.has(implCand)) {
        targets.add(implCand);
        let depSet = ws.reverseDeps.get(implCand);
        if (!depSet) {
          depSet = new Set();
          ws.reverseDeps.set(implCand, depSet);
        }
        depSet.add(entry.relPath);
      }
    }
    if (targets.size > 0) {
      ws.forwardDeps.set(entry.relPath, targets);
    }
  }

  _invalidateDepConfigCaches(ws, relPath) {
    if (!ws || !relPath) return;
    const baseLower = path.posix.basename(relPath).toLowerCase();
    if (baseLower === 'go.mod') {
      ws.goModulePrefix = null;
      ws.goPkgMainFile = null;
    } else if (relPath.endsWith('.go') && !relPath.endsWith('_test.go')) {
      ws.goPkgMainFile = null;
    } else if (baseLower === 'tsconfig.json' || baseLower === 'jsconfig.json' || baseLower === 'package.json') {
      ws.jsAliasMeta = undefined;
    }
  }

  /**
   * Removes a file entry cleanly from workspace RAM maps and updates accounting.
   * @param {object} ws
   * @param {string} relPath
   * @param {{ purgeIncoming?: boolean, keepArenaSlice?: boolean }} [options]
   */
  removeEntry(ws, relPath, { purgeIncoming = true, keepArenaSlice = false } = {}) {
    relPath = this._resolveCanonicalRel(ws, relPath);
    this._invalidateDepConfigCaches(ws, relPath);
    const existing = ws.files.get(relPath);
    if (!existing) return;

    for (const tok of existing.tokens) {
      const bucket = ws.tokenIndex.get(tok);
      if (bucket) {
        bucket.delete(relPath);
        if (bucket.size === 0) ws.tokenIndex.delete(tok);
      }
      const fpBucket = ws.fieldPostings.get(tok);
      if (fpBucket) {
        fpBucket.delete(relPath);
        if (fpBucket.size === 0) ws.fieldPostings.delete(tok);
      }
    }

    // Read existing.buf BEFORE freeing arena slice so trigram purge sees live bytes
    const bufForPurge = (!existing.trigrams && existing.trigramCount > 0) ? existing.buf : null;
    const trigramsToPurge =
      existing.trigrams ||
      (bufForPurge
        ? extractTrigrams(`${relPath}\n${bufForPurge.toString('utf8')}`, resolveMaxTrigramsForExt(existing.ext))
        : null);
    if (trigramsToPurge) {
      for (const tri of trigramsToPurge) {
        const triBucket = ws.trigramIndex.get(tri);
        if (triBucket) {
          triBucket.delete(relPath);
          if (triBucket.size === 0) ws.trigramIndex.delete(tri);
        }
      }
    }

    if (existing.fieldLengths && ws.fieldLenSums) {
      ws.fieldLenSums.pe = Math.max(0, ws.fieldLenSums.pe - existing.fieldLengths.pe);
      ws.fieldLenSums.sig = Math.max(0, ws.fieldLenSums.sig - existing.fieldLengths.sig);
      ws.fieldLenSums.body = Math.max(0, ws.fieldLenSums.body - existing.fieldLengths.body);
      ws.fieldLenSums.doc = Math.max(0, ws.fieldLenSums.doc - existing.fieldLengths.doc);
    }

    this.unlinkFileDeps(ws, relPath);
    if (purgeIncoming) {
      ws.reverseDeps.delete(relPath);
    }

    ws.files.delete(relPath);
    ws.filesLower?.delete(relPath.toLowerCase());
    ws.totalBytes = Math.max(0, ws.totalBytes - existing.approxRamBytes);
    this.totalCacheBytes = Math.max(0, this.totalCacheBytes - existing.approxRamBytes);
    ws.repoMapCache.clear();
    if (ws.symbolGraph && ws.files.size > 800) {
      if (!ws.symbolGraphDirty) ws.symbolGraphDirty = new Set();
      ws.symbolGraphDirty.add(relPath);
    } else {
      ws.symbolGraph = null;
      ws.symbolGraphDirty?.clear();
    }
    ws.localSymbolGraphCache?.clear();
    ws.docRefGraph = null;
    ws.archClusters = null;
    ws.simHashIndex?.delete(relPath);
    if (!keepArenaSlice) {
      ws.arena?.freeFile(relPath);
    }
    existing.arenaSlice = null;
    existing._fallbackBuf = null;
    ws.csrIndex = null;
    ws.speculativeSkeletonCache?.delete(relPath);
    this.memoizer.invalidateFile(relPath);
  }

  /**
   * Evicts least-recently-used file entries in O(k) via Map insertion order until under targetBytes.
   * @param {number} targetBytes
   * @param {{ skipWs?: object|null, skipRelPath?: string }} [opts={}]
   */
  evictToTarget(targetBytes, { skipWs = null, skipRelPath = '' } = {}) {
    if (this.totalCacheBytes <= targetBytes) return;
    if (this.workspaces.size === 1) {
      const ws = this.workspaces.values().next().value;
      if (!ws) return;
      for (const relPath of Array.from(ws.files.keys())) {
        if (this.totalCacheBytes <= targetBytes) break;
        if (skipWs === ws && skipRelPath && relPath === skipRelPath) continue;
        this.removeEntry(ws, relPath);
        this.stats.evictions += 1;
      }
      return;
    }

    while (this.totalCacheBytes > targetBytes) {
      let oldestWs = null;
      let oldestEntry = null;
      for (const ws of this.workspaces.values()) {
        for (const entry of ws.files.values()) {
          if (skipWs === ws && skipRelPath && entry.relPath === skipRelPath) continue;
          if (!oldestEntry || entry.lastAccessTs < oldestEntry.lastAccessTs) {
            oldestWs = ws;
            oldestEntry = entry;
          }
          break;
        }
      }
      if (!oldestWs || !oldestEntry) break;
      this.removeEntry(oldestWs, oldestEntry.relPath);
      this.stats.evictions += 1;
    }
  }

  /**
   * Checks whether a relative path / file should be cached in RAM.
   * @param {string} relPath
   * @param {number} sizeBytes
   * @returns {boolean}
   */
  shouldIndexFile(relPath, sizeBytes) {
    if (!relPath || sizeBytes <= 0 || sizeBytes > MAX_SINGLE_FILE_BYTES) return false;
    const parts = relPath.split('/');
    for (let i = 0; i < parts.length - 1; i++) {
      if (IGNORED_DIRS.has(parts[i])) return false;
    }
    const base = parts[parts.length - 1];
    if (IGNORED_FILES.has(base)) return false;
    const lowerBase = base.toLowerCase();
    if (
      lowerBase.endsWith('.min.js') ||
      lowerBase.endsWith('.min.css') ||
      lowerBase.endsWith('.bundle.js') ||
      lowerBase.endsWith('-backup.json')
    ) {
      return false;
    }
    const ext = path.extname(base).toLowerCase();
    return TEXT_EXTENSIONS.has(ext) || base === 'Dockerfile' || base === 'Makefile';
  }

  /**
   * Loads or refreshes a single file into the workspace RAM cache.
   * @param {string} rootDir
   * @param {string} filePath
   * @param {{ rebuildDeps?: boolean, precomputedMeta?: object|null, preloadedBuf?: Buffer|null, preloadedStat?: object|null, preloadedArenaSlice?: object|null, cpuCfg?: object|null }} [opts={}]
   * @returns {object|null}
   */
  upsertFile(rootDir, filePath, { rebuildDeps = true, precomputedMeta = null, preloadedBuf = null, preloadedStat = null, preloadedArenaSlice = null, cpuCfg = null } = {}) {
    const ws = this.getOrCreateWorkspace(rootDir);
    if (!ws) return null;

    const absPath = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(ws.absRoot, filePath);
    const relPath = toRelPath(ws.absRoot, absPath);
    if (!relPath || relPath.startsWith('..') || path.isAbsolute(relPath)) return null;

    const secCheck = checkFileSecurity({ filePath: absPath, workspaceRoot: ws.absRoot, toolName: 'ram_memory' });
    if (!secCheck.allow) {
      return null;
    }

    this._invalidateDepConfigCaches(ws, relPath);

    let stat = preloadedStat;
    if (!stat) {
      try {
        stat = fs.statSync(absPath);
        if (!stat.isFile()) return null;
      } catch {
        this.removeEntry(ws, relPath);
        return null;
      }
    }

    if (!this.shouldIndexFile(relPath, stat.size)) return null;

    const prevKey = this._resolveCanonicalRel(ws, relPath);
    const prev = ws.files.get(prevKey);
    if (prev && prev.mtimeMs === stat.mtimeMs && prev.sizeBytes === stat.size) {
      this._touchEntry(ws, prev);
      return prev;
    }

    let buf = preloadedBuf;
    if (!buf) {
      try {
        buf = fs.readFileSync(absPath);
      } catch {
        return null;
      }
    }

    const sha1 = computeBufSha1(buf);
    const ext = path.extname(relPath).toLowerCase();
    const text = buf.toString('utf8');
    const lineOffsets = buildLineOffsets(buf);

    let symbols = [];
    let imports = [];
    let exportedSymbols = [];
    let semanticMeta = { docSummary: '', docStems: [] };
    if (CODE_EXTENSIONS.has(ext)) {
      try {
        const meta = precomputedMeta || extractFileAllMetadata(ext, text);
        symbols = augmentJsMethodSymbols(
          ext,
          text,
          Array.isArray(meta?.symbolsWithRanges) ? meta.symbolsWithRanges : []
        );
        imports = Array.isArray(meta?.imports) ? meta.imports : [];
        exportedSymbols = Array.isArray(meta?.exportedSymbols) ? meta.exportedSymbols : [];
        semanticMeta = meta?.semanticMeta || semanticMeta;
      } catch {
        this.errorStats.parse += 1;
      }
    }

    const resolvedCpuCfg = cpuCfg || loadCpuConfig();
    let searchBuilt;
    try {
      searchBuilt = buildFileSearchStructures(
        relPath,
        ext,
        text,
        symbols,
        exportedSymbols,
        semanticMeta,
        resolvedCpuCfg.cpuTrigramIndex
      );
    } catch {
      this.errorStats.parse += 1;
      return null;
    }
    const {
      tokens,
      fieldPostings,
      fieldLengths,
      trigrams,
    } = searchBuilt;

    if (prev) {
      this.removeEntry(ws, prev.relPath, {
        purgeIncoming: false,
        keepArenaSlice: Boolean(preloadedArenaSlice && prev.relPath === relPath),
      });
    }

    if (this.totalCacheBytes + buf.byteLength > this.budgetBytes * 1.05) {
      this.evictToTarget(Math.max(0, Math.floor(this.budgetBytes * 0.85) - buf.byteLength));
    }

    const arenaSlice = preloadedArenaSlice || (ws.arena ? ws.arena.writeBuffer(relPath, buf) : null);
    const fallbackBuf = arenaSlice?.sab ? null : buf;
    const trigramCount = trigrams ? trigrams.size : 0;
    const approxRamBytes =
      buf.byteLength
      + lineOffsets.byteLength
      + (tokens.size * 64)
      + (trigramCount * 8)
      + (symbols.length * 96)
      + 256;

    const entry = {
      absPath,
      relPath,
      ext,
      mtimeMs: stat.mtimeMs,
      sizeBytes: stat.size,
      sha1,
      arenaSlice,
      _fallbackBuf: fallbackBuf,
      get buf() {
        if (this.arenaSlice && this.arenaSlice.sab) {
          return Buffer.from(this.arenaSlice.sab, this.arenaSlice.byteOffset, this.arenaSlice.byteLength);
        }
        return this._fallbackBuf;
      },
      lineCount: lineOffsets.length,
      lineOffsets,
      symbols,
      imports,
      exportedSymbols,
      tokens,
      fieldLengths,
      trigramCount,
      approxRamBytes,
      lastAccessTs: Date.now(),
      hits: 0,
    };

    ws.files.set(relPath, entry);
    ws.filesLower?.set(relPath.toLowerCase(), relPath);
    ws.fieldLenSums.pe += fieldLengths.pe;
    ws.fieldLenSums.sig += fieldLengths.sig;
    ws.fieldLenSums.body += fieldLengths.body;
    ws.fieldLenSums.doc += fieldLengths.doc;

    for (const [tok, tfRec] of fieldPostings.entries()) {
      let bucket = ws.tokenIndex.get(tok);
      if (!bucket) {
        bucket = new Set();
        ws.tokenIndex.set(tok, bucket);
      }
      bucket.add(relPath);

      let fpBucket = ws.fieldPostings.get(tok);
      if (!fpBucket) {
        fpBucket = new Map();
        ws.fieldPostings.set(tok, fpBucket);
      }
      fpBucket.set(relPath, tfRec);
    }

    if (trigrams) {
      for (const tri of trigrams) {
        let triBucket = ws.trigramIndex.get(tri);
        if (!triBucket) {
          triBucket = new Set();
          ws.trigramIndex.set(tri, triBucket);
        }
        triBucket.add(relPath);
      }
    }

    ws.totalBytes += approxRamBytes;
    this.totalCacheBytes += approxRamBytes;
    if (this.totalCacheBytes > this.budgetBytes) {
      this.evictToTarget(Math.floor(this.budgetBytes * 0.85), { skipWs: ws, skipRelPath: relPath });
    }
    ws.repoMapCache.clear();
    if (ws.symbolGraph && ws.files.size > 800) {
      if (!ws.symbolGraphDirty) ws.symbolGraphDirty = new Set();
      ws.symbolGraphDirty.add(relPath);
    } else {
      ws.symbolGraph = null;
      ws.symbolGraphDirty?.clear();
    }
    ws.localSymbolGraphCache?.clear();
    ws.docRefGraph = null;
    ws.archClusters = null;
    ws.simHashIndex?.delete(relPath);
    ws.csrIndex = null;
    ws.speculativeSkeletonCache?.delete(relPath);
    this.memoizer.invalidateFile(relPath);

    if (rebuildDeps) {
      this.linkFileDeps(ws, entry);
      if (!prev) {
        for (const other of ws.files.values()) {
          if (other.relPath === relPath || !other.imports || other.imports.length === 0) continue;
          const otherOpts = this._getResolveOptsForFile(ws, other.relPath);
          for (const spec of other.imports) {
            const targetRel = resolveImportRel(other.relPath, spec, ws.files, otherOpts);
            if (targetRel === relPath) {
              let outSet = ws.forwardDeps.get(other.relPath);
              if (!outSet) {
                outSet = new Set();
                ws.forwardDeps.set(other.relPath, outSet);
              }
              outSet.add(relPath);
              let depSet = ws.reverseDeps.get(relPath);
              if (!depSet) {
                depSet = new Set();
                ws.reverseDeps.set(relPath, depSet);
              }
              depSet.add(other.relPath);
              break;
            }
          }
        }
      }
    }
    return entry;
  }

  /**
   * Rebuilds in-memory reverse dependency adjacency map for O(1) Blast Radius queries.
   * @param {object} ws
   */
  rebuildReverseDeps(ws) {
    ws.reverseDeps.clear();
    ws.forwardDeps.clear();
    ws.repoMapCache.clear();
    ws.symbolGraph = null;
    ws.symbolGraphDirty?.clear();
    ws.localSymbolGraphCache?.clear();
    ws.docRefGraph = null;
    ws.archClusters = null;
    ws.goPkgMainFile = null;
    for (const entry of ws.files.values()) {
      this.linkFileDeps(ws, entry);
    }
  }

  /**
   * Starts incremental fs.watch on workspace so RAM stays synchronized with disk edits.
   * @param {object} ws
   */
  ensureWatcher(ws) {
    if (ws.watcher) return;
    const upsertDirectorySubset = (dirFull, maxFiles = 256) => {
      const queue = [dirFull];
      let processed = 0;
      while (queue.length > 0 && processed < maxFiles) {
        const cur = queue.pop();
        let ents;
        try {
          ents = fs.readdirSync(cur, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const ent of ents) {
          if (processed >= maxFiles) break;
          if (ent.isDirectory()) {
            if (!IGNORED_DIRS.has(ent.name)) queue.push(path.join(cur, ent.name));
          } else if (ent.isFile()) {
            const fullPath = path.join(cur, ent.name);
            const entry = this.upsertFile(ws.absRoot, fullPath, { rebuildDeps: true });
            if (entry) {
              processed += 1;
              if (this.onFileUpsert) {
                try {
                  this.onFileUpsert(ws.absRoot, entry);
                } catch {}
              }
            }
          }
        }
      }
    };
    const onWatchEvent = (_eventType, filename) => {
      if (!filename) return;
      const rel = String(filename).replace(/\\/g, '/').replace(/^\.\//, '');
      if (!rel || rel.split('/').some((seg) => IGNORED_DIRS.has(seg))) return;

      const existingTimer = ws.watchTimers.get(rel);
      if (existingTimer) {
        clearTimeout(existingTimer);
        ws.watchTimers.delete(rel);
      } else if (ws.watchTimers.size >= 2048) {
        const oldestKey = ws.watchTimers.keys().next().value;
        if (oldestKey !== undefined) {
          clearTimeout(ws.watchTimers.get(oldestKey));
          ws.watchTimers.delete(oldestKey);
        }
      }
      const timer = setTimeout(() => {
        ws.watchTimers.delete(rel);
        if (this.workspaces.get(ws.wsKey) !== ws) return;
        const full = path.resolve(ws.absRoot, rel);
        if (fs.existsSync(full)) {
          let st = null;
          try {
            st = fs.statSync(full);
          } catch {}
          if (st?.isFile()) {
            const entry = this.upsertFile(ws.absRoot, full, { rebuildDeps: true });
            if (entry && this.onFileUpsert) {
              try {
                this.onFileUpsert(ws.absRoot, entry);
              } catch {}
            }
          } else if (st?.isDirectory()) {
            upsertDirectorySubset(full, 256);
          }
        } else {
          this.removeEntry(ws, rel);
          const dirPrefix = `${rel.replace(/\/+$/, '')}/`;
          const dirPrefixLow = dirPrefix.toLowerCase();
          for (const k of Array.from(ws.files.keys())) {
            if (k.startsWith(dirPrefix) || (process.platform === 'win32' && k.toLowerCase().startsWith(dirPrefixLow))) {
              this.removeEntry(ws, k);
            }
          }
        }
        this.stats.watcherUpdates += 1;
      }, 120);
      if (typeof timer.unref === 'function') timer.unref();
      ws.watchTimers.set(rel, timer);
    };
    try {
      try {
        ws.watcher = fs.watch(ws.absRoot, { recursive: true }, onWatchEvent);
      } catch {
        ws.watcher = fs.watch(ws.absRoot, { recursive: false }, onWatchEvent);
      }
      ws.watcher.on('error', () => {
        this.errorStats.watcher += 1;
        try {
          ws.watcher?.close();
        } catch {}
        ws.watcher = null;
      });
      if (typeof ws.watcher.unref === 'function') ws.watcher.unref();
    } catch {
      this.errorStats.watcher += 1;
    }
  }

  /**
   * Discovers matching indexable files in workspace without loading contents.
   * @param {object} ws
   * @param {number} [maxFiles=DEFAULT_MAX_FILES_PER_WS]
   * @returns {Map<string, { fullPath: string, ext: string }>}
   */
  _discoverWorkspaceFiles(ws, maxFiles = DEFAULT_MAX_FILES_PER_WS) {
    const queue = [ws.absRoot];
    const discovered = new Map();
    while (queue.length > 0 && discovered.size < maxFiles) {
      const dir = queue.pop();
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const ent of entries) {
        if (ent.isDirectory()) {
          if (!IGNORED_DIRS.has(ent.name)) {
            queue.push(path.join(dir, ent.name));
          }
        } else if (ent.isFile()) {
          const fullPath = path.join(dir, ent.name);
          const relPath = toRelPath(ws.absRoot, fullPath);
          if (IGNORED_FILES.has(ent.name)) continue;
          const ext = path.extname(ent.name).toLowerCase();
          if (TEXT_EXTENSIONS.has(ext) || ent.name === 'Dockerfile' || ent.name === 'Makefile') {
            discovered.set(relPath, { fullPath, ext });
          }
          if (discovered.size >= maxFiles) break;
        }
      }
    }
    return discovered;
  }

  /**
   * Hydrates RepairKV and loads persisted SQLite AST metadata map for a workspace.
   * @param {object} ws
   * @returns {Map<string, object>}
   */
  _loadCachedAstMap(ws) {
    if (!this.sqliteKnowledgeEnabled || !this.knowledgeHub) return new Map();
    try {
      this.knowledgeHub.hydrateRepairIndex(this.repairIndex, ws.absRoot);
      return this.knowledgeHub.loadAstMetaMap(ws.absRoot) || new Map();
    } catch {
      this.errorStats.sqlite += 1;
      return new Map();
    }
  }

  /**
   * Preloads all matching project files into RAM and optionally activates incremental watcher.
   * @param {string} rootDir
   * @param {{ maxFiles?: number, startWatcher?: boolean }} [options={}]
   * @returns {{ ok: boolean, workspace: string, filesLoaded: number, symbolsCount: number, usedMb: number, budgetMb: number, elapsedMs: number }}
   */
  warmWorkspace(rootDir, { maxFiles = DEFAULT_MAX_FILES_PER_WS, startWatcher = true } = {}) {
    const startMs = Date.now();
    const ws = this.getOrCreateWorkspace(rootDir);
    if (!ws) {
      return { ok: false, workspace: rootDir, filesLoaded: 0, symbolsCount: 0, usedMb: 0, budgetMb: this.budgetMb, elapsedMs: 0 };
    }

    const discovered = this._discoverWorkspaceFiles(ws, maxFiles);
    const cachedAstMap = this._loadCachedAstMap(ws);
    const cpuCfg = loadCpuConfig();
    const newAstEntries = [];

    for (const [relPath, { fullPath, ext }] of discovered.entries()) {
      let stat = null;
      try {
        stat = fs.statSync(fullPath);
        if (!stat.isFile()) continue;
      } catch {
        continue;
      }
      if (!this.shouldIndexFile(relPath, stat.size)) continue;
      const prev = ws.files.get(relPath);
      if (prev && prev.mtimeMs === stat.mtimeMs && prev.sizeBytes === stat.size) {
        this._touchEntry(ws, prev);
        continue;
      }
      let buf = null;
      try {
        buf = fs.readFileSync(fullPath);
      } catch {
        continue;
      }
      let precomputedMeta = null;
      if (CODE_EXTENSIONS.has(ext)) {
        const sha1 = computeBufSha1(buf);
        const cached = cachedAstMap.get(relPath);
        const isStaleGoCache = ext === '.go' && cached && (!Array.isArray(cached.meta?.imports) || cached.meta.imports.length === 0) && buf.includes('import');
        if (cached && cached.sha1 === sha1 && cached.meta && !isStaleGoCache) {
          precomputedMeta = cached.meta;
        } else {
          try {
            precomputedMeta = extractFileAllMetadata(ext, buf.toString('utf8'));
            if (this.sqliteKnowledgeEnabled && this.knowledgeHub && precomputedMeta) {
              newAstEntries.push({
                relPath,
                sha1,
                symbolsWithRanges: precomputedMeta.symbolsWithRanges || [],
                imports: precomputedMeta.imports || [],
                exportedSymbols: precomputedMeta.exportedSymbols || [],
                semanticMeta: precomputedMeta.semanticMeta || {},
              });
            }
          } catch {
            this.errorStats.parse += 1;
          }
        }
      }
      this.upsertFile(ws.absRoot, fullPath, {
        rebuildDeps: false,
        precomputedMeta,
        preloadedBuf: buf,
        preloadedStat: stat,
        cpuCfg,
      });
    }

    if (newAstEntries.length > 0 && this.sqliteKnowledgeEnabled && this.knowledgeHub) {
      try {
        this.knowledgeHub.saveAstMetaBatch(ws.absRoot, newAstEntries);
      } catch {
        this.errorStats.sqlite += 1;
      }
    }

    // Prune files deleted from disk since last warm
    for (const existingRel of Array.from(ws.files.keys())) {
      if (!discovered.has(existingRel)) {
        this.removeEntry(ws, existingRel);
      }
    }

    this.rebuildReverseDeps(ws);
    this.ensureCsrIndex(ws);
    if (startWatcher) {
      this.ensureWatcher(ws);
    }
    ws.warmedAt = Date.now();

    let symbolsCount = 0;
    for (const e of ws.files.values()) symbolsCount += e.symbols.length;

    return {
      ok: true,
      workspace: ws.absRoot,
      filesLoaded: ws.files.size,
      symbolsCount,
      trigramsIndexed: ws.trigramIndex.size,
      usedMb: Number((ws.totalBytes / (1024 * 1024)).toFixed(2)),
      budgetMb: this.budgetMb,
      elapsedMs: Date.now() - startMs,
    };
  }

  /**
   * Multi-core worker_threads warmWorkspace variant for cold / bulk file ingestion (25+ changed code files).
   */
  async warmWorkspaceAsync(rootDir, { maxFiles = DEFAULT_MAX_FILES_PER_WS, startWatcher = true } = {}) {
    const startMs = Date.now();
    const ws = this.getOrCreateWorkspace(rootDir);
    if (!ws) {
      return { ok: false, workspace: rootDir, filesLoaded: 0, symbolsCount: 0, usedMb: 0, budgetMb: this.budgetMb, elapsedMs: 0 };
    }
    if (ws._warmAsyncPromise) {
      return ws._warmAsyncPromise;
    }

    const startEpoch = ws.epoch;
    const batchId = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const runPromise = (async () => {
      const discovered = this._discoverWorkspaceFiles(ws, maxFiles);
      const cachedAstMap = this._loadCachedAstMap(ws);
      const cpuCfg = loadCpuConfig();

      const changedFiles = [];
      for (const [relPath, { fullPath, ext }] of discovered.entries()) {
        let stat;
        try {
          stat = fs.statSync(fullPath);
          if (!stat.isFile()) continue;
        } catch {
          this.removeEntry(ws, relPath);
          continue;
        }
        if (!this.shouldIndexFile(relPath, stat.size)) continue;
        const prevKey = this._resolveCanonicalRel(ws, relPath);
        const prev = ws.files.get(prevKey);
        if (prev && prev.mtimeMs === stat.mtimeMs && prev.sizeBytes === stat.size) {
          this._touchEntry(ws, prev);
          continue;
        }
        let buf;
        try {
          buf = fs.readFileSync(fullPath);
        } catch {
          continue;
        }
        changedFiles.push({ relPath, fullPath, ext, stat, buf });
      }

      const metaByRel = new Map();
      const changedByRel = new Map();
      for (const cf of changedFiles) {
        if (cf?.relPath) changedByRel.set(cf.relPath, cf);
      }

      const filteredBatch = [];
      const stageKeys = [];
      for (const f of changedFiles) {
        if (!CODE_EXTENSIONS.has(f.ext) || f.stat.size > 1024 * 1024) continue;
        const sha1 = computeBufSha1(f.buf);
        f.sha1 = sha1;
        const cached = cachedAstMap.get(f.relPath);
        const isStaleGoCache = f.ext === '.go' && cached && (!Array.isArray(cached.meta?.imports) || cached.meta.imports.length === 0) && f.buf.includes('import');
        if (cached && cached.sha1 === sha1 && cached.meta && !isStaleGoCache) {
          metaByRel.set(f.relPath, cached.meta);
          continue;
        }
        const stageKey = `\0stage:${batchId}:${f.relPath}`;
        const stageSlice = ws.arena ? ws.arena.writeBuffer(stageKey, f.buf) : null;
        if (stageSlice) {
          stageKeys.push(stageKey);
          const item = {
            relPath: f.relPath,
            ext: f.ext,
            sab: stageSlice.sab,
            byteOffset: stageSlice.byteOffset,
            byteLength: stageSlice.byteLength,
          };
          if (!stageSlice.isShared) {
            item.text = f.buf.toString('utf8');
          }
          filteredBatch.push(item);
        } else {
          filteredBatch.push({ relPath: f.relPath, ext: f.ext, text: f.buf.toString('utf8') });
        }
      }

      if (filteredBatch.length > 0) {
        if (filteredBatch.some((p) => p.sab)) {
          this.sotaStats.zeroCopyBatches += 1;
        }
        let parsed = [];
        try {
          const { runCpuBatch } = await import('./cpu-worker-pool.mjs');
          parsed = await runCpuBatch('parseMetadataBatch', filteredBatch, { minItemsForWorkers: 25 });
        } finally {
          for (const sk of stageKeys) {
            ws.arena?.freeFile(sk);
          }
        }
        if (this.workspaces.get(ws.wsKey) !== ws || ws.epoch !== startEpoch) {
          return {
            ok: false,
            evicted: true,
            workspace: ws.absRoot,
            filesLoaded: 0,
            symbolsCount: 0,
            usedMb: 0,
            budgetMb: this.budgetMb,
            elapsedMs: Date.now() - startMs,
          };
        }
        const newAstEntries = [];
        for (const item of parsed || []) {
          if (item?.relPath && item?.meta) {
            metaByRel.set(item.relPath, item.meta);
            const fRec = changedByRel.get(item.relPath);
            if (fRec?.sha1) {
              newAstEntries.push({
                relPath: item.relPath,
                sha1: fRec.sha1,
                symbolsWithRanges: item.meta.symbolsWithRanges || [],
                imports: item.meta.imports || [],
                exportedSymbols: item.meta.exportedSymbols || [],
                semanticMeta: item.meta.semanticMeta || {},
              });
            }
          }
        }
        if (newAstEntries.length > 0 && this.sqliteKnowledgeEnabled && this.knowledgeHub) {
          try {
            this.knowledgeHub.saveAstMetaBatch(ws.absRoot, newAstEntries);
          } catch {
            this.errorStats.sqlite += 1;
          }
        }
      }

      if (this.workspaces.get(ws.wsKey) !== ws || ws.epoch !== startEpoch) {
        return {
          ok: false,
          evicted: true,
          workspace: ws.absRoot,
          filesLoaded: 0,
          symbolsCount: 0,
          usedMb: 0,
          budgetMb: this.budgetMb,
          elapsedMs: Date.now() - startMs,
        };
      }

      for (const f of changedFiles) {
        const curKey = this._resolveCanonicalRel(ws, f.relPath);
        const cur = ws.files.get(curKey);
        if (cur && cur.mtimeMs > f.stat.mtimeMs) continue;
        this.upsertFile(ws.absRoot, f.fullPath, {
          rebuildDeps: false,
          precomputedMeta: metaByRel.get(f.relPath) || null,
          preloadedBuf: f.buf,
          preloadedStat: f.stat,
          cpuCfg,
        });
      }

      for (const existingRel of Array.from(ws.files.keys())) {
        if (!discovered.has(existingRel) && !fs.existsSync(path.join(ws.absRoot, existingRel))) {
          this.removeEntry(ws, existingRel);
        }
      }

      this.rebuildReverseDeps(ws);
      this.ensureCsrIndex(ws);
      if (startWatcher) {
        this.ensureWatcher(ws);
      }
      ws.warmedAt = Date.now();

      let symbolsCount = 0;
      for (const e of ws.files.values()) symbolsCount += e.symbols.length;

      return {
        ok: true,
        workspace: ws.absRoot,
        filesLoaded: ws.files.size,
        symbolsCount,
        trigramsIndexed: ws.trigramIndex.size,
        parallelParsedCount: filteredBatch.length,
        usedMb: Number((ws.totalBytes / (1024 * 1024)).toFixed(2)),
        budgetMb: this.budgetMb,
        elapsedMs: Date.now() - startMs,
      };
    })();

    ws._warmAsyncPromise = runPromise;
    try {
      return await runPromise;
    } finally {
      if (ws._warmAsyncPromise === runPromise) {
        ws._warmAsyncPromise = null;
      }
    }
  }

  /**
   * Lazily builds the compact Uint32Array CSR inverted index for a workspace.
   * @param {object} ws
   * @returns {CsrInvertedIndex|null}
   */
  ensureCsrIndex(ws) {
    if (!ws) return null;
    if (!ws.csrIndex) {
      const csr = new CsrInvertedIndex();
      csr.buildFromTokenMap(ws.files, ws.tokenIndex);
      ws.csrIndex = csr;
    }
    return ws.csrIndex;
  }

  /**
   * Ensures workspace is loaded in RAM (auto-warms once if cold).
   * @param {string} rootDir
   * @param {object} [options={}]
   * @returns {object|null}
   */
  ensureWarm(rootDir, options = {}) {
    const ws = this.getOrCreateWorkspace(rootDir);
    if (!ws) return null;
    if (ws.files.size === 0 && ws.warmedAt === 0) {
      this.warmWorkspace(ws.absRoot, options);
    }
    return ws;
  }

  /**
   * Searches project code & symbols strictly in RAM, returning compact line-numbered snippets.
   * @param {string} rootDir
   * @param {string} query
   * @param {{ maxResults?: number, contextLines?: number, fastMode?: boolean }} [options={}]
   */
  search(rootDir, query = '', options = {}) {
    return searchWorkspace(this, rootDir, query, options);
  }

  /**
   * Hybrid semantic + lexical search: uses GPU embeddings (qwen3-embedding:0.6b) + in-RAM Buffer slicing.
   * Falls back seamlessly to lexical RAM search when GPU/Ollama is disabled or unavailable.
   * @param {string} rootDir
   * @param {string} query
   * @param {{ maxResults?: number, contextLines?: number, reindexMissing?: boolean, maxForegroundIndexFiles?: number, blockingFullIndex?: boolean }} [options={}]
   */
  searchSemantic(rootDir, query = '', options = {}) {
    return searchWorkspaceSemantic(this, rootDir, query, options);
  }

  /**
   * Fast synchronous-in-RAM Hybrid RRF Gold Context builder combining BM25-IDF lexical hits
   * with already-computed warm Qwen3 vector hits (0ms extra Ollama roundtrip).
   * @param {string} rootDir
   * @param {string} query
   * @param {Array<{ file: string, score: number, startLine: number, endLine: number }>} warmSemanticHits
   * @param {{ maxResults?: number, contextLines?: number }} [options={}]
   */
  buildHybridGoldContext(rootDir, query = '', warmSemanticHits = [], options = {}) {
    return buildHybridGoldContextImpl(this, rootDir, query, warmSemanticHits, options);
  }

  /**
   * Resolves workspace containment, security check, and loads file entry from RAM (or disk on miss).
   * @param {string} rootDir
   * @param {string} filePath
   * @param {string} [toolName='ram_slice']
   * @returns {{ ok: boolean, ws?: object, entry?: object, formatted?: string }}
   */
  _resolveAndLoadEntry(rootDir, filePath, toolName = 'ram_slice') {
    const ws = this.getOrCreateWorkspace(rootDir);
    if (!ws || !filePath) {
      return { ok: false, formatted: 'Invalid workspace or filePath.' };
    }

    const absTarget = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(ws.absRoot, filePath);
    const relPath = toRelPath(ws.absRoot, absTarget);
    if (!relPath || relPath.startsWith('..') || path.isAbsolute(relPath)) {
      return { ok: false, formatted: 'Access denied: filePath is outside the workspace boundary.' };
    }
    const secCheck = checkFileSecurity({ filePath: absTarget, workspaceRoot: ws.absRoot, toolName });
    if (!secCheck.allow) {
      return { ok: false, formatted: secCheck.reason || 'Access denied by Security Guard.' };
    }
    const canonicalRel = this._resolveCanonicalRel(ws, relPath);
    let entry = ws.files.get(canonicalRel);
    if (!entry) {
      this.stats.misses += 1;
      entry = this.upsertFile(ws.absRoot, absTarget, { rebuildDeps: false });
    } else {
      this.stats.hits += 1;
    }

    if (!entry) {
      return { ok: false, formatted: `File not found or excluded: ${filePath}` };
    }

    this._touchEntry(ws, entry);
    entry.hits += 1;
    return { ok: true, ws, entry };
  }

  /**
   * Returns a LongCodeZip-style AST Knapsack skeleton of a cached file, keeping focus symbol/query blocks verbatim.
   * @param {string} rootDir
   * @param {string} filePath
   * @param {{ query?: string, symbol?: string, maxChars?: number }} [options={}]
   */
  skeletonize(rootDir, filePath, options = {}) {
    return skeletonizeFile(this, rootDir, filePath, options);
  }

  /**
   * Lazily builds and caches the doc/config/skill <-> code reference graph for a workspace.
   * @param {string} rootDir
   */
  getDocRefGraph(rootDir) {
    return getDocRefGraphImpl(this, rootDir);
  }

  /**
   * Computes deterministic architectural clusters (Weighted Label Propagation) and God Nodes in RAM.
   * @param {string} rootDir
   * @param {{ maxClusters?: number, maxGodNodes?: number }} [options={}]
   */
  getArchitectureClusters(rootDir, options = {}) {
    return getArchitectureClustersImpl(this, rootDir, options);
  }

  /**
   * Finds the shortest k-hop path between two symbols or files across AST calls, imports, and doc refs.
   * @param {string} rootDir
   * @param {string} from
   * @param {string} to
   * @param {{ maxDepth?: number, direction?: 'both'|'directed' }} [options={}]
   */
  findGraphPath(rootDir, from, to, options = {}) {
    return findGraphPathImpl(this, rootDir, from, to, options);
  }

  /**
   * Unified knowledge graph query endpoint backing the lazy `ram_graph_query` MCP tool.
   * @param {string} rootDir
   * @param {object} [options={}]
   */
  queryKnowledgeGraph(rootDir, options = {}) {
    return queryKnowledgeGraphImpl(this, rootDir, options);
  }

  _buildLocalNeighborhoodFiles(ws, seedRelFiles = [], maxFiles = 120) {
    return buildLocalNeighborhoodFiles(ws, seedRelFiles, maxFiles);
  }

  getSymbolEgoGraph(rootDir, symbolOrQuery, options = {}) {
    return getSymbolEgoGraphImpl(this, rootDir, symbolOrQuery, options);
  }

  /**
   * Resolves a RepoGraph 1-hop hint for matched search/context results + query.
   * @param {string} rootDir
   * @param {Array<{ file: string, startLine?: number, endLine?: number }>} results
   * @param {string} [query='']
   */
  getEgoGraphHintForResults(rootDir, results = [], query = '') {
    return getEgoGraphHintForResultsImpl(this, rootDir, results, query);
  }

  /**
   * Builds a compact 2-Hop contract strip (`callees` signatures without bodies + exact `callers` lines)
   * for the primary matched file/symbol in RAM.
   * @param {string} rootDir
   * @param {Array<{ file: string, startLine?: number, endLine?: number }>} [matchedResults=[]]
   */
  getTwoHopContractStrip(rootDir, matchedResults = []) {
    return getTwoHopContractStripImpl(this, rootDir, matchedResults);
  }

  /**
   * SWE-Pruner local branch skimmer: keeps function header, return tail, and query-relevant
   * code blocks verbatim while folding unrelated middle blocks.
   * @param {string} [codeText='']
   * @param {string} [query='']
   * @param {{ maxLines?: number }} [options={}]
   */
  skimCodeBlocksByQuery(codeText = '', query = '', options = {}) {
    return skimCodeBlocksByQueryImpl(this, codeText, query, options);
  }

  /**
   * Cross-Layer Seam Index: finds every occurrence of a config key, DOM ID, or IPC route
   * across JSON state, JS/TS modules, and HTML UI files straight from RAM.
   * @param {string} rootDir
   * @param {string} keyName
   */
  findCrossLayerSeams(rootDir, keyName = '') {
    return findCrossLayerSeamsImpl(this, rootDir, keyName);
  }

  /**
   * Returns either a variable data-flow slice, AST Knapsack skeleton, symbol+callGraph, or an exact line range directly from RAM.
   * @param {string} rootDir
   * @param {string} filePath
   * @param {{ symbol?: string, startLine?: number, endLine?: number, skeleton?: boolean, query?: string, maxChars?: number, callGraph?: boolean }} [options={}]
   */
  slice(rootDir, filePath, options = {}) {
    return sliceFile(this, rootDir, filePath, options);
  }

  /**
   * Builds a fast RepoMap straight from RAM without touching disk.
   * @param {string} rootDir
   * @param {number} [maxChars=12000]
   * @param {{ toon?: boolean }} [options={}]
   */
  getFastRepoMap(rootDir, maxChars = 12000, options = {}) {
    return getFastRepoMapImpl(this, rootDir, maxChars, options);
  }

  /**
   * Computes Blast Radius reverse dependents strictly from RAM.
   * @param {string} rootDir
   * @param {string} targetFilePath
   */
  getFastBlastRadius(rootDir, targetFilePath) {
    return getFastBlastRadiusImpl(this, rootDir, targetFilePath);
  }

  /**
   * Verifies import and semantic contracts in RAM without directory walks or cold disk reads.
   * @param {string} rootDir
   * @param {string} editedFilePath
   */
  verifyContractsInRam(rootDir, editedFilePath) {
    return verifyContractsInRamImpl(this, rootDir, editedFilePath);
  }

  /**
   * Checks ACON observation window memoization for an unchanged tool output.
   */
  checkObservationMemo(params) {
    return this.memoizer.checkMemo(params);
  }

  /**
   * Records a tool output observation in the ACON memoization LRU table.
   */
  recordObservationMemo(params) {
    return this.memoizer.recordMemo(params);
  }

  /**
   * Invalidates memoized observations touching a modified file path.
   */
  invalidateObservationFile(rootDir, filePath) {
    if (!filePath) return 0;
    const ws = this.getOrCreateWorkspace(rootDir);
    const relPath = ws
      ? toRelPath(ws.absRoot, path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(ws.absRoot, filePath))
      : String(filePath).replace(/\\/g, '/');
    return this.memoizer.invalidateFile(relPath);
  }

  /**
   * Archives deterministic pre-compaction facts for RepairKV post-compaction recall.
   */
  archiveCompactionFacts(params) {
    const res = this.repairIndex.archiveFacts(params);
    if (this.sqliteKnowledgeEnabled && this.knowledgeHub && params?.wsPath) {
      try {
        this.knowledgeHub.saveRepairKvBuckets(params.wsPath, this.repairIndex.buckets);
      } catch {
        this.errorStats.sqlite += 1;
      }
    }
    return res;
  }

  /**
   * Recalls relevant archived episodic facts after context compaction.
   */
  recallCompactionFacts(params) {
    if (this.sqliteKnowledgeEnabled && this.knowledgeHub && params?.wsPath) {
      try {
        this.knowledgeHub.hydrateRepairIndex(this.repairIndex, params.wsPath);
      } catch {
        this.errorStats.sqlite += 1;
      }
    }
    return this.repairIndex.recallFacts(params);
  }

  /**
   * Schedules a debounced 25ms speculative prefetch warming symbolGraph, simHashIndex,
   * and skeleton caches for up to 3 reverse dependents of an edited file.
   */
  scheduleSpeculativePrefetch(rootDir, editedFilePath) {
    const ws = this.getOrCreateWorkspace(rootDir);
    if (!ws || !editedFilePath) {
      return { ok: false, scheduled: false };
    }

    const absEdited = path.isAbsolute(editedFilePath)
      ? path.resolve(editedFilePath)
      : path.resolve(ws.absRoot, editedFilePath);
    const relEdited = toRelPath(ws.absRoot, absEdited);

    if (ws.prefetchTimer) {
      clearTimeout(ws.prefetchTimer);
      ws.prefetchTimer = null;
    }

    ws.prefetchTimer = setTimeout(() => {
      ws.prefetchTimer = null;
      if (!this.workspaces.has(ws.wsKey)) return;
      const t0 = performance.now();

      try {
        // Guard against main-thread stalls on huge repos (>1500 files)
        if (!ws.symbolGraph && ws.files.size > 0 && ws.files.size <= 1500) {
          ws.symbolGraph = buildSymbolCallGraph(ws.files);
          ws.symbolGraphDirty?.clear();
        }

        const editedEntry = ws.files.get(relEdited);
        if (editedEntry) {
          if (!ws.simHashIndex && ws.files.size <= 1500) {
            ws.simHashIndex = buildWorkspaceSimHashIndex(ws.files);
          }
          if (ws.simHashIndex) {
            const hashes = computeFileSimHashes({
              relPath: relEdited,
              ext: editedEntry.ext || path.extname(relEdited).toLowerCase(),
              text: editedEntry.buf.toString('utf8'),
              symbols: editedEntry.symbols || null,
            });
            if (hashes.length > 0) {
              ws.simHashIndex.set(relEdited, hashes);
            }
          }
        }

        const revDeps = Array.from(ws.reverseDeps.get(relEdited) || []).slice(0, 3);
        for (const depRel of revDeps) {
          const depEntry = ws.files.get(depRel);
          if (!depEntry) continue;
          const skelRes = foldCodeWithKnapsack(depEntry.buf.toString('utf8'), {
            query: '',
            focusSymbol: '',
            maxBudgetChars: 3200,
            ext: depEntry.ext,
          });
          if (skelRes?.ok) {
            this._setSpeculativeSkeleton(ws, depRel, {
              sha1: depEntry.sha1 || computeBufSha1(depEntry.buf),
              maxChars: 3200,
              res: skelRes,
              ts: Date.now(),
            });
          }
        }

        this.sotaStats.speculativePrefetches += 1;
        this.recordCompletedOp('speculative_prefetch', {
          target: relEdited,
          latencyMs: performance.now() - t0,
        });
      } catch {
        this.errorStats.prefetch += 1;
      }
    }, 25);

    if (typeof ws.prefetchTimer.unref === 'function') {
      ws.prefetchTimer.unref();
    }

    return { ok: true, scheduled: true, target: relEdited };
  }

  /**
   * Builds a complete Zero-Turn Context Pack from RAM for an arbitrary user task prompt.
   * Adapts snippet density dynamically using SWE-Pruner phase detection (`explore | edit | debug`).
   * @param {string} rootDir
   * @param {string} prompt
   * @param {{ maxChars?: number, warmSemanticHits?: Array, phase?: string, faultText?: string, toon?: boolean, pinnedFiles?: string[] }} [options={}]
   */
  getContextPack(rootDir, prompt = '', options = {}) {
    return getContextPackImpl(this, rootDir, prompt, options);
  }

  /**
   * Pure in-RAM + CPU (<5ms, 0 VRAM, 0 Ollama calls) composer context lookup for Ghost Text autocomplete.
   * @param {string} rootDir
   * @param {string} [draft='']
   * @param {{ maxFiles?: number, maxSymbols?: number }} [options={}]
   */
  searchComposerContextFast(rootDir, draft = '', options = {}) {
    return searchComposerContextFastImpl(this, rootDir, draft, options);
  }

  /**
   * Builds a grounded, zero-pollution AST-RAG chat context pack for local GPU project chat.
   * @param {string} rootDir
   * @param {string} [query='']
   * @param {{ messages?: Array, maxChars?: number, warmSemanticHits?: Array, maxFiles?: number, focusFile?: string }} [options={}]
   */
  buildGroundedChatPack(rootDir, query = '', options = {}) {
    return buildGroundedChatPackImpl(this, rootDir, query, options);
  }

  /**
   * Resolves exact AST symbol definitions from warm RAM buffers (<1ms) for 2nd-hop RAG grounding.
   * @param {string} rootDir
   * @param {string[]} [symbolNames=[]]
   * @param {{ maxSlices?: number, maxLinesPerSlice?: number }} [options={}]
   * @returns {Array<{ file: string, startLine: number, endLine: number, symbol: string, snippetText: string }>}
   */
  findSymbolSlicesFast(rootDir, symbolNames = [], options = {}) {
    return findSymbolSlicesFastImpl(this, rootDir, symbolNames, options);
  }

  /**
   * Returns full live memory telemetry across all cached workspaces.
   */
  getStats() {
    const procMem = process.memoryUsage();
    const workspaces = [];
    let arenaBytes = 0;
    let csrBytes = 0;
    for (const ws of Array.from(this.workspaces.values())) {
      if (!fs.existsSync(ws.absRoot)) {
        this.evict(ws.absRoot);
        continue;
      }
      let symbols = 0;
      for (const e of ws.files.values()) symbols += e.symbols.length;
      const wsArenaStats = ws.arena ? ws.arena.getStats() : null;
      const wsCsrStats = ws.csrIndex ? ws.csrIndex.getStats() : null;
      arenaBytes += wsArenaStats?.usedBytes || 0;
      csrBytes += wsCsrStats?.byteLength || 0;
      workspaces.push({
        workspace: ws.absRoot,
        files: ws.files.size,
        symbols,
        tokensIndexed: ws.tokenIndex.size,
        trigramsIndexed: ws.trigramIndex?.size || 0,
        cacheMb: Number((ws.totalBytes / (1024 * 1024)).toFixed(2)),
        watching: Boolean(ws.watcher),
        lastAccessIso: new Date(ws.lastAccessTs).toISOString(),
      });
    }
    const memoStats = this.memoizer.getStats();
    const repairStats = this.repairIndex.getStats();
    const sliceSavedTokens = Math.round((this.sotaStats.sliceSavedChars || 0) / 3.8);
    const nonSliceSavedTokens = memoStats.savedTokensEstimate + repairStats.savedTokensEstimate;
    const savedTokensEstimate = nonSliceSavedTokens + sliceSavedTokens;
    return {
      budgetMb: this.budgetMb,
      cacheUsedMb: Number((this.totalCacheBytes / (1024 * 1024)).toFixed(2)),
      processRssMb: Number((procMem.rss / (1024 * 1024)).toFixed(2)),
      processHeapUsedMb: Number((procMem.heapUsed / (1024 * 1024)).toFixed(2)),
      hitRatePercent: (this.stats.hits + this.stats.misses) > 0
        ? Math.round((this.stats.hits / (this.stats.hits + this.stats.misses)) * 100)
        : 100,
      ...this.stats,
      savedTokensEstimate,
      sotaNonSliceSavedTokens: nonSliceSavedTokens,
      sota: {
        arenaBytes,
        csrBytes,
        memoHits: memoStats.hits,
        repairRecalls: repairStats.recallsCount,
        speculativePrefetches: this.sotaStats.speculativePrefetches,
        zeroCopyBatches: this.sotaStats.zeroCopyBatches,
        nonSliceSavedTokens,
        savedTokensEstimate,
      },
      liveActivity: this.getLiveActivitySnapshot(),
      workspaces,
    };
  }

  /**
   * Releases all watchers and memory associated with cached workspaces.
   */
  close() {
    return this.evict('all');
  }

  /**
   * Releases timers, watchers, derived graphs, and large map buffers for a workspace
   * so pending libuv/watcher callbacks cannot retain file data in V8 heap.
   * @param {object} ws
   */
  _releaseWorkspaceResources(ws) {
    if (!ws) return;
    ws.epoch = (ws.epoch || 0) + 1;
    ws._warmAsyncPromise = null;
    try { ws.watcher?.close(); } catch {}
    ws.watcher = null;
    if (ws.prefetchTimer) {
      clearTimeout(ws.prefetchTimer);
      ws.prefetchTimer = null;
    }
    if (ws.watchTimers) {
      for (const t of ws.watchTimers.values()) clearTimeout(t);
      ws.watchTimers.clear();
    }
    ws.symbolGraph = null;
    ws.symbolGraphDirty = null;
    ws.localSymbolGraphCache?.clear();
    ws.docRefGraph = null;
    ws.archClusters = null;
    ws.simHashIndex = null;
    ws.csrIndex = null;
    ws.goModulePrefix = null;
    ws.goPkgMainFile = null;
    ws.jsAliasMeta = undefined;
    if (ws.files) {
      for (const entry of ws.files.values()) {
        entry.arenaSlice = null;
        entry._fallbackBuf = null;
      }
      ws.files.clear();
    }
    ws.filesLower?.clear();
    ws.tokenIndex?.clear();
    ws.trigramIndex?.clear();
    ws.fieldPostings?.clear();
    ws.forwardDeps?.clear();
    ws.reverseDeps?.clear();
    ws.repoMapCache?.clear();
    ws.speculativeSkeletonCache?.clear();
    ws.arena?.clear();
    ws.totalBytes = 0;
  }

  /**
   * Evicts one workspace or all cached workspaces and stops watchers.
   * @param {string} [target='all']
   */
  evict(target = 'all') {
    if (!target || target === 'all') {
      for (const ws of this.workspaces.values()) {
        this._releaseWorkspaceResources(ws);
      }
      this.workspaces.clear();
      this.memoizer?.entries?.clear();
      this.totalCacheBytes = 0;
      return { ok: true, evicted: 'all' };
    }
    const abs = path.resolve(target);
    const wsKey = process.platform === 'win32' ? abs.toLowerCase() : abs;
    const ws = this.workspaces.get(wsKey);
    if (!ws) return { ok: false, evicted: abs, message: 'Workspace not in RAM' };
    const prevBytes = ws.totalBytes || 0;
    this._releaseWorkspaceResources(ws);
    this.totalCacheBytes = Math.max(0, this.totalCacheBytes - prevBytes);
    this.workspaces.delete(wsKey);
    return { ok: true, evicted: abs };
  }
}

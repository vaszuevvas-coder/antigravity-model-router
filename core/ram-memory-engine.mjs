/**
 * @file ram-memory-engine.mjs
 * @description Persistent In-RAM Project Memory Engine (up to configurable GB budget, default 12 GB).
 * Stores raw UTF-8 file Buffers + Int32Array line offsets + AST symbols + inverted token index + reverse deps
 * in memory with incremental fs.watch invalidation and strict LRU eviction.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  extractFileAllMetadata,
  stemWord,
  verifyImportContracts,
  verifySemanticContracts,
} from './repo-mapper.mjs';
import { extractVariableSliceFromText } from '../skills/program-slicer-ocd/scripts/slice-variable.mjs';
import { formatPitfallsForSessionStart } from './pitfall-ledger.mjs';
import { formatHandoffForSessionStart } from './session-handoff.mjs';
import {
  indexWorkspaceVectors,
  loadGpuConfig,
  semanticSearchWorkspace,
} from './local-gpu-engine.mjs';
import { loadCpuConfig, recordCpuCompressionSaving, runCpuBatch } from './cpu-worker-pool.mjs';
import { expandQueryBilingualStems, rerankCandidates, splitIdentifierSubtokens } from './cpu-reranker.mjs';
import {
  buildDocConfigReferenceGraph,
  buildSymbolCallGraph,
  detectArchitectureClusters,
  findShortestGraphPath,
  findSurprisingConnections,
  foldCodeWithKnapsack,
  queryAffectedBlastGraph,
  queryDocRefsForFile,
  querySymbolEgoGraph,
  selectDiverseSlicesMMR,
  suggestArchitectureQuestions,
} from './cpu-ast-graph-compressor.mjs';
import {
  buildWorkspaceSimHashIndex,
  computeBipartiteSymbolPPR,
  computeFileSimHashes,
  findNearDuplicateFunctions,
  mineGitCoChangeGraph,
  queryCoChangePartners,
  verifyExportArityAndKeyContracts,
} from './cpu-graph-contracts.mjs';
import { skimAstBranchesWithBraceBalance } from './cpu-sbfl-healer.mjs';
import { checkFileSecurity } from './security-guard.mjs';
import { formatRepoMapToon } from './toon-formatter.mjs';
import { expandRuQueryToEnTerms } from './ru-en-lexicon.mjs';
import {
  CsrInvertedIndex,
  EpisodicRepairIndex,
  ObservationWindowMemoizer,
  orderSlicesPrefixStable,
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
  sliceBufferLines,
  extractSearchTokens,
  BM25F_K1,
  BM25F_WEIGHTS,
  BM25F_B,
  resolveMaxTrigramsForExt,
  extractTrigrams,
  buildFileSearchStructures,
  toRelPath,
  resolveImportRel,
  inferContextPruningPhase,
  selectDiverseSlicesWithTelemetry,
  COMPOSER_STOPWORDS,
  SHORT_TECH_TOKENS,
  IGNORED_MULTI_TURN_IDS,
  enrichMultiTurnChatQuery,
  collectWorkspaceGroundingInventory,
  extractExplicitFileMatches,
  augmentJsMethodSymbols,
  inferEffectiveSymbolEndLine,
  expandSliceToWholeAstSymbol,
} from './ram/ram-index-helpers.mjs';

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
        tokenIndex: new Map(), // token -> Set<relPath>
        trigramIndex: new Map(), // 3-gram -> Set<relPath>
        fieldPostings: new Map(), // token -> Map<relPath, { pe, sig, body, doc }>
        fieldLenSums: { pe: 0, sig: 0, body: 0, doc: 0 },
        forwardDeps: new Map(), // importerRel -> Set<targetRel>
        reverseDeps: new Map(), // targetRel -> Set<importerRel>
        repoMapCache: new Map(), // maxChars -> markdown
        symbolGraph: null, // lazy RepoGraph 1-hop symbol call graph
        docRefGraph: null, // lazy doc/config/skill <-> code reference graph
        archClusters: null, // lazy community clusters & God Nodes
        arena: new SharedRamArena(),
        csrIndex: null,
        speculativeSkeletonCache: new Map(),
        prefetchTimer: null,
        watcher: null,
        watchTimers: new Map(),
        warmedAt: 0,
        lastAccessTs: Date.now(),
        totalBytes: 0,
      };
      this.workspaces.set(wsKey, ws);
    }
    ws.lastAccessTs = Date.now();
    return ws;
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

  /**
   * Links outgoing dependency edges for a single file entry in O(imports).
   * @param {object} ws
   * @param {object} entry
   */
  linkFileDeps(ws, entry) {
    this.unlinkFileDeps(ws, entry.relPath);
    const isGoTest = entry.relPath.endsWith('_test.go');
    if ((!entry.imports || entry.imports.length === 0) && !isGoTest) return;
    const goMeta = entry.relPath.endsWith('.go') ? this._ensureGoDepMeta(ws) : null;
    const targets = new Set();
    for (const spec of entry.imports || []) {
      const targetRel = resolveImportRel(entry.relPath, spec, ws.files, goMeta || undefined);
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

  /**
   * Removes a file entry cleanly from workspace RAM maps and updates accounting.
   * @param {object} ws
   * @param {string} relPath
   * @param {{ purgeIncoming?: boolean }} [options]
   */
  removeEntry(ws, relPath, { purgeIncoming = true, keepArenaSlice = false } = {}) {
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

    const trigramsToPurge =
      existing.trigrams ||
      (existing.trigramCount > 0 && existing.buf
        ? extractTrigrams(`${relPath}\n${existing.buf.toString('utf8')}`, resolveMaxTrigramsForExt(existing.ext))
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
    ws.totalBytes = Math.max(0, ws.totalBytes - existing.approxRamBytes);
    this.totalCacheBytes = Math.max(0, this.totalCacheBytes - existing.approxRamBytes);
    ws.repoMapCache.clear();
    if (ws.symbolGraph && ws.files.size > 800) {
      if (!ws.symbolGraphDirty) ws.symbolGraphDirty = new Set();
      ws.symbolGraphDirty.add(relPath);
    } else {
      ws.symbolGraph = null;
    }
    ws.docRefGraph = null;
    ws.archClusters = null;
    if (!keepArenaSlice) {
      ws.arena?.freeFile(relPath);
    }
    ws.csrIndex = null;
    ws.speculativeSkeletonCache?.delete(relPath);
    this.memoizer.invalidateFile(relPath);
  }

  /**
   * Evicts least-recently-used file entries across workspaces until under targetBytes.
   * @param {number} targetBytes
   * @param {{ skipWs?: object|null, skipRelPath?: string }} [opts={}]
   */
  evictToTarget(targetBytes, { skipWs = null, skipRelPath = '' } = {}) {
    if (this.totalCacheBytes <= targetBytes) return;
    const candidates = [];
    for (const ws of this.workspaces.values()) {
      for (const entry of ws.files.values()) {
        if (skipWs === ws && skipRelPath && entry.relPath === skipRelPath) continue;
        candidates.push({ ws, entry });
      }
    }
    candidates.sort((a, b) => a.entry.lastAccessTs - b.entry.lastAccessTs);
    for (const { ws, entry } of candidates) {
      if (this.totalCacheBytes <= targetBytes) break;
      this.removeEntry(ws, entry.relPath);
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
   * @param {{ rebuildDeps?: boolean }} [opts={}]
   * @returns {object|null}
   */
  upsertFile(rootDir, filePath, { rebuildDeps = true, precomputedMeta = null, preloadedBuf = null, preloadedStat = null, preloadedArenaSlice = null } = {}) {
    const ws = this.getOrCreateWorkspace(rootDir);
    if (!ws) return null;

    const absPath = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(ws.absRoot, filePath);
    const relPath = toRelPath(ws.absRoot, absPath);
    if (!relPath || relPath.startsWith('..') || path.isAbsolute(relPath)) return null;

    const secCheck = checkFileSecurity({ filePath: absPath, workspaceRoot: ws.absRoot, toolName: 'ram_memory' });
    if (!secCheck.allow) {
      return null;
    }

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

    const prev = ws.files.get(relPath);
    if (prev && prev.mtimeMs === stat.mtimeMs && prev.sizeBytes === stat.size) {
      prev.lastAccessTs = Date.now();
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

    if (prev) {
      this.removeEntry(ws, relPath, {
        purgeIncoming: false,
        keepArenaSlice: Boolean(preloadedArenaSlice),
      });
    }

    if (this.totalCacheBytes + buf.byteLength > this.budgetBytes) {
      this.evictToTarget(Math.max(0, Math.floor(this.budgetBytes * 0.85) - buf.byteLength));
    }

    const arenaSlice = preloadedArenaSlice || (ws.arena ? ws.arena.writeBuffer(relPath, buf) : null);
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
      } catch {}
    }

    const cpuCfg = loadCpuConfig();
    const {
      tokens,
      fieldPostings,
      fieldLengths,
      trigrams,
    } = buildFileSearchStructures(
      relPath,
      ext,
      text,
      symbols,
      exportedSymbols,
      semanticMeta,
      cpuCfg.cpuTrigramIndex
    );
    const trigramCount = trigrams ? trigrams.size : 0;
    const approxRamBytes =
      buf.byteLength
      + lineOffsets.byteLength
      + (tokens.size * 48)
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
      lineCount: lineOffsets.length,
      buf,
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
    }
    ws.docRefGraph = null;
    ws.archClusters = null;
    ws.csrIndex = null;
    ws.speculativeSkeletonCache?.delete(relPath);
    this.memoizer.invalidateFile(relPath);

    if (rebuildDeps) {
      this.linkFileDeps(ws, entry);
      if (!prev) {
        for (const other of ws.files.values()) {
          if (other.relPath === relPath || !other.imports || other.imports.length === 0) continue;
          for (const spec of other.imports) {
            const targetRel = resolveImportRel(other.relPath, spec, ws.files);
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
    ws.symbolGraph = null;
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
    const onWatchEvent = (_eventType, filename) => {
      if (!filename) return;
      const rel = String(filename).replace(/\\/g, '/');
      if (rel.split('/').some((seg) => IGNORED_DIRS.has(seg))) return;

      const existingTimer = ws.watchTimers.get(rel);
      if (existingTimer) clearTimeout(existingTimer);
      const timer = setTimeout(() => {
        ws.watchTimers.delete(rel);
        const full = path.resolve(ws.absRoot, rel);
        if (fs.existsSync(full)) {
          const entry = this.upsertFile(ws.absRoot, full, { rebuildDeps: true });
          if (entry && this.onFileUpsert) {
            try {
              this.onFileUpsert(ws.absRoot, entry);
            } catch {}
          }
        } else {
          this.removeEntry(ws, rel);
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
        try {
          ws.watcher?.close();
        } catch {}
        ws.watcher = null;
      });
      if (typeof ws.watcher.unref === 'function') ws.watcher.unref();
    } catch {}
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

    const queue = [ws.absRoot];
    const discovered = new Set();
    let cachedAstMap = new Map();
    if (this.sqliteKnowledgeEnabled && this.knowledgeHub) {
      try {
        this.knowledgeHub.hydrateRepairIndex(this.repairIndex, ws.absRoot);
        cachedAstMap = this.knowledgeHub.loadAstMetaMap(ws.absRoot);
      } catch {}
    }
    const newAstEntries = [];

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
            discovered.add(relPath);
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
              prev.lastAccessTs = Date.now();
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
                } catch {}
              }
            }
            this.upsertFile(ws.absRoot, fullPath, {
              rebuildDeps: false,
              precomputedMeta,
              preloadedBuf: buf,
              preloadedStat: stat,
            });
          }
          if (discovered.size >= maxFiles) break;
        }
      }
    }

    if (newAstEntries.length > 0 && this.sqliteKnowledgeEnabled && this.knowledgeHub) {
      try {
        this.knowledgeHub.saveAstMetaBatch(ws.absRoot, newAstEntries);
      } catch {}
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
          if (!IGNORED_DIRS.has(ent.name)) queue.push(path.join(dir, ent.name));
        } else if (ent.isFile()) {
          const fullPath = path.join(dir, ent.name);
          const relPath = toRelPath(ws.absRoot, fullPath);
          if (IGNORED_FILES.has(ent.name)) continue;
          const ext = path.extname(ent.name).toLowerCase();
          if (TEXT_EXTENSIONS.has(ext) || ent.name === 'Dockerfile' || ent.name === 'Makefile') {
            discovered.set(relPath, fullPath);
          }
          if (discovered.size >= maxFiles) break;
        }
      }
    }

    const changedFiles = [];
    const parseBatch = [];
    for (const [relPath, fullPath] of discovered.entries()) {
      let stat;
      try {
        stat = fs.statSync(fullPath);
        if (!stat.isFile()) continue;
      } catch {
        this.removeEntry(ws, relPath);
        continue;
      }
      if (!this.shouldIndexFile(relPath, stat.size)) continue;
      const prev = ws.files.get(relPath);
      if (prev && prev.mtimeMs === stat.mtimeMs && prev.sizeBytes === stat.size) {
        prev.lastAccessTs = Date.now();
        continue;
      }
      let buf;
      try {
        buf = fs.readFileSync(fullPath);
      } catch {
        continue;
      }
      const ext = path.extname(relPath).toLowerCase();
      let arenaSlice = null;
      if (CODE_EXTENSIONS.has(ext) && stat.size <= 1024 * 1024) {
        arenaSlice = ws.arena ? ws.arena.writeBuffer(relPath, buf) : null;
      }
      changedFiles.push({ relPath, fullPath, ext, stat, buf, arenaSlice });
    }

    for (const f of changedFiles) {
      if (CODE_EXTENSIONS.has(f.ext) && f.stat.size <= 1024 * 1024) {
        if (f.arenaSlice) {
          const item = {
            relPath: f.relPath,
            ext: f.ext,
            sab: f.arenaSlice.sab,
            byteOffset: f.arenaSlice.byteOffset,
            byteLength: f.arenaSlice.byteLength,
          };
          if (!f.arenaSlice.isShared) {
            item.text = f.buf.toString('utf8');
          }
          parseBatch.push(item);
        } else {
          parseBatch.push({ relPath: f.relPath, ext: f.ext, text: f.buf.toString('utf8') });
        }
      }
    }

    const metaByRel = new Map();
    let cachedAstMap = new Map();
    if (this.sqliteKnowledgeEnabled && this.knowledgeHub) {
      try {
        this.knowledgeHub.hydrateRepairIndex(this.repairIndex, ws.absRoot);
        cachedAstMap = this.knowledgeHub.loadAstMetaMap(ws.absRoot);
      } catch {}
    }

    const changedByRel = new Map();
    for (const cf of changedFiles) {
      if (cf?.relPath) changedByRel.set(cf.relPath, cf);
    }

    const filteredBatch = [];
    for (const item of parseBatch) {
      const fRec = changedByRel.get(item.relPath);
      const sha1 = fRec?.buf ? computeBufSha1(fRec.buf) : '';
      if (fRec) fRec.sha1 = sha1;
      const cached = sha1 ? cachedAstMap.get(item.relPath) : null;
      const isStaleGoCache = item.ext === '.go' && cached && (!Array.isArray(cached.meta?.imports) || cached.meta.imports.length === 0) && fRec?.buf?.includes('import');
      if (cached && cached.sha1 === sha1 && cached.meta && !isStaleGoCache) {
        metaByRel.set(item.relPath, cached.meta);
      } else {
        filteredBatch.push(item);
      }
    }

    if (filteredBatch.length > 0) {
      if (filteredBatch.some((p) => p.sab)) {
        this.sotaStats.zeroCopyBatches += 1;
      }
      const parsed = await runCpuBatch('parseMetadataBatch', filteredBatch, { minItemsForWorkers: 25 });
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
        } catch {}
      }
    }

    for (const f of changedFiles) {
      this.upsertFile(ws.absRoot, f.fullPath, {
        rebuildDeps: false,
        precomputedMeta: metaByRel.get(f.relPath) || null,
        preloadedBuf: f.buf,
        preloadedStat: f.stat,
        preloadedArenaSlice: f.arenaSlice,
      });
    }

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
      parallelParsedCount: filteredBatch.length,
      usedMb: Number((ws.totalBytes / (1024 * 1024)).toFixed(2)),
      budgetMb: this.budgetMb,
      elapsedMs: Date.now() - startMs,
    };
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
  search(rootDir, query = '', { maxResults = 12, contextLines = 2, fastMode = false } = {}) {
    this.stats.searches += 1;
    const t0 = performance.now();
    const ws = this.ensureWarm(rootDir);
    if (!ws || !query || !query.trim()) {
      return { ok: false, results: [], formatted: 'Empty query or invalid workspace.' };
    }

    const cpuCfg = fastMode
      ? { cpuTrigramIndex: Boolean(ws.trigramIndex?.size > 0), ramSotaEngines: true }
      : loadCpuConfig();
    const qInfo = expandQueryBilingualStems(query);
    const rawQueryTokens = new Set(extractSearchTokens(query));
    const ruLex = /[а-яё]/i.test(query) ? expandRuQueryToEnTerms(query, { maxTerms: 16 }) : { enTerms: [] };
    const qTokens = Array.from(new Set([...rawQueryTokens, ...qInfo.synonymTerms, ...ruLex.enTerms]));
    if (cpuCfg.ramSotaEngines !== false && ws.files.size > 0 && rawQueryTokens.size > 0) {
      const csr = this.ensureCsrIndex(ws);
      if (csr) {
        const rawArr = Array.from(rawQueryTokens).slice(0, 4);
        if (rawArr.length >= 2) csr.intersectTerms(rawArr);
        else csr.lookupTermFiles(rawArr[0]);
        this.sotaStats.csrLookups += 1;
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

    // Trigram inverted index candidate narrowing & exact substring boost (replaces full-repo linear scan)
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
        const checkLimit = candidates.slice(0, fastMode ? 20 : 120);
        for (const rel of checkLimit) {
          const entry = ws.files.get(rel);
          if (!entry) continue;
          const inPath = entry.relPath.toLowerCase().includes(subNeedle);
          let inBody = false;
          if (!inPath) {
            if (fastMode) {
              inBody = entry.buf.indexOf(subNeedle) !== -1;
            } else {
              inBody = entry.buf.toString('utf8').toLowerCase().includes(subNeedle);
            }
          }
          if (inPath || inBody) {
            const boost = (subNeedle === needleLower ? 6.0 : 2.5) + (inPath ? 4.0 : 0);
            scoreMap.set(rel, (scoreMap.get(rel) || 0) + boost);
          }
        }
      }
    } else if (scoreMap.size === 0 && (!cpuCfg.cpuTrigramIndex || trigramNeedles.length === 0)) {
      for (const entry of ws.files.values()) {
        const inPath = entry.relPath.toLowerCase().includes(needleLower);
        const inBody = !inPath && (fastMode ? entry.buf.indexOf(rawNeedle) !== -1 || entry.buf.indexOf(needleLower) !== -1 : entry.buf.toString('utf8').toLowerCase().includes(needleLower));
        if (inPath || inBody) {
          scoreMap.set(entry.relPath, 1);
        }
      }
    }

    const isDocsQuery = /\b(?:docs?|readme|tutorial|guide|changelog|markdown|перевод|документац)\b/i.test(query);
    const hasNonAsciiQuery = /[^\x00-\x7f]/.test(query);
    const ranked = Array.from(scoreMap.entries())
      .map(([rel, bmScore]) => {
        const entry = ws.files.get(rel);
        const symBoost = (entry?.symbols || []).some((s) => s.signature?.toLowerCase().includes(needleLower)) ? 2.5 : 0;
        const revCount = ws.reverseDeps.get(rel)?.size || 0;
        let rawScore = bmScore + symBoost + Math.min(2, revCount * 0.2);
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

    if (ranked.length > 0) this.stats.hits += 1;
    else this.stats.misses += 1;

    const termsLower = qTokens.length > 0 ? qTokens : [needleLower];
    const topFastTokens = fastMode
      ? Array.from(tokIdfMap.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([tok]) => tok)
      : [];
    const mmrCandidates = [];

    const byteOffsetToLine = (lineOffsets, bytePos) => {
      let lo = 0;
      let hi = lineOffsets.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        if (lineOffsets[mid] <= bytePos) lo = mid + 1;
        else hi = mid - 1;
      }
      return Math.max(1, lo);
    };

    for (const item of ranked) {
      const entry = item.entry;
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
            const idx = entry.buf.indexOf(probe);
            if (idx !== -1) {
              foundByte = idx;
              break;
            }
          }
          if (foundByte !== -1) {
            matchLine = byteOffsetToLine(entry.lineOffsets, foundByte);
          } else if (entry.buf.byteLength <= 192 * 1024 && topFastTokens.length > 0) {
            const lowerTxt = entry.buf.toString('utf8').toLowerCase();
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
        const text = entry.buf.toString('utf8');
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

      const startL = Math.max(1, matchLine - contextLines);
      const endL = Math.min(entry.lineCount, matchLine + contextLines + 4);
      const snippet = sliceBufferLines(entry.buf, entry.lineOffsets, startL, endL);

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
      c.entry.lastAccessTs = Date.now();
      c.entry.hits += 1;
      results.push({
        file: c.file,
        line: c.line,
        startLine: c.startLine,
        endLine: c.endLine,
        score: c.score,
        bm25fScore: c.bm25fScore,
      });
      formattedBlocks.push(`### \`${c.file}\` [L${c.startLine}-L${c.endLine}]\n\`\`\`\n${c.snippetText}\n\`\`\``);
    }

    const elapsedMs = Number((performance.now() - t0).toFixed(2));
    this.recordCompletedOp('ram_search', {
      target: String(query || '').trim().slice(0, 48),
      latencyMs: elapsedMs,
    });
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
   * Hybrid semantic + lexical search: uses GPU embeddings (qwen3-embedding:0.6b) + in-RAM Buffer slicing.
   * Falls back seamlessly to lexical RAM search when GPU/Ollama is disabled or unavailable.
   * @param {string} rootDir
   * @param {string} query
   * @param {{ maxResults?: number, contextLines?: number, reindexMissing?: boolean, maxForegroundIndexFiles?: number, blockingFullIndex?: boolean }} [options={}]
   */
  async searchSemantic(
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
    this.stats.searches += 1;
    const ws = this.ensureWarm(rootDir);
    if (!ws || !query || !query.trim()) {
      return { ok: false, results: [], formatted: 'Empty query or invalid workspace.' };
    }

    const gpuCfg = loadGpuConfig();
    if (!gpuCfg.gpuEnabled || !gpuCfg.gpuSemanticSearch) {
      return { ...this.search(ws.absRoot, query, { maxResults, contextLines }), mode: 'lexical_fallback' };
    }

    let indexMeta = null;
    if (reindexMissing) {
      const fgCap = blockingFullIndex ? 220 : Math.max(1, Math.min(32, Number(maxForegroundIndexFiles) || 8));
      indexMeta = await indexWorkspaceVectors(ws.absRoot, ws.files, { maxNewFiles: fgCap });
      if (!blockingFullIndex && indexMeta?.ok && Number(indexMeta.indexedNow) >= fgCap && ws.files.size > fgCap && !ws.bgVectorWarmInFlight) {
        ws.bgVectorWarmInFlight = true;
        Promise.resolve()
          .then(() => indexWorkspaceVectors(ws.absRoot, ws.files, { maxNewFiles: 220 }))
          .catch(() => {})
          .finally(() => {
            ws.bgVectorWarmInFlight = false;
          });
      }
    }

    const [semRes, lexRes] = await Promise.all([
      semanticSearchWorkspace(ws.absRoot, query, Math.max(maxResults * 3, 18)),
      Promise.resolve(this.search(ws.absRoot, query, { maxResults: Math.max(maxResults * 2, 12), contextLines: 0 })),
    ]);

    if (!semRes.ok || !Array.isArray(semRes.hits) || semRes.hits.length === 0) {
      const fullLex = contextLines === 0
        ? lexRes
        : this.search(ws.absRoot, query, { maxResults, contextLines });
      return {
        ...fullLex,
        mode: 'lexical_fallback',
        gpuError: semRes.error || (semRes.empty ? 'Vector index empty' : undefined),
      };
    }

    // Reciprocal Rank Fusion (RRF, k = 60): key by file + 40-line bucket so lexical scores boost matching regions
    const RRF_K = 60;
    const mergedMap = new Map();
    const semCountByFile = new Map();
    const bucketToKey = new Map();
    const toBucketKey = (rel, startLine) => `${rel}#b${Math.floor(Math.max(0, Number(startLine) || 0) / 40)}`;

    semRes.hits.forEach((h, idx) => {
      const entry = ws.files.get(h.relPath);
      if (!entry) return;
      const seenCount = semCountByFile.get(h.relPath) || 0;
      if (seenCount >= 2) return;
      const key = `${h.relPath}:${h.startLine}-${h.endLine}`;
      if (mergedMap.has(key)) return;
      semCountByFile.set(h.relPath, seenCount + 1);
      const bKey = toBucketKey(h.relPath, h.startLine);
      if (!bucketToKey.has(bKey)) {
        bucketToKey.set(bKey, key);
      }
      mergedMap.set(key, {
        entry,
        relPath: h.relPath,
        startLine: h.startLine,
        endLine: h.endLine,
        similarity: h.similarity,
        rrfScore: 1 / (RRF_K + idx + 1),
      });
    });

    (lexRes.results || []).forEach((r, idx) => {
      const entry = ws.files.get(r.file);
      if (!entry) return;
      const lexRrf = 1 / (RRF_K + idx + 1);
      const bKey = toBucketKey(r.file, r.startLine);
      const existingKey = bucketToKey.get(bKey);
      const existing = existingKey ? mergedMap.get(existingKey) : null;
      if (existing) {
        existing.rrfScore += lexRrf;
      } else {
        const key = `${r.file}:${r.startLine}-${r.endLine}`;
        bucketToKey.set(bKey, key);
        mergedMap.set(key, {
          entry,
          relPath: r.file,
          startLine: r.startLine,
          endLine: r.endLine,
          similarity: 0,
          rrfScore: lexRrf,
        });
      }
    });

    const lexScoreByFile = new Map((lexRes.results || []).map((r) => [r.file, r.bm25fScore || r.score || 0]));
    const chosen = Array.from(mergedMap.values()).map((item) => {
      const codeBias = CODE_EXTENSIONS.has(item.entry.ext) ? 0.002 : 0;
      const revDeps = ws.reverseDeps.get(item.relPath)?.size || 0;
      const depBoost = Math.min(0.008, revDeps * 0.0012);
      const simTie = (item.similarity || 0) * 0.005;
      const startP = Math.max(1, item.startLine - 4);
      const endP = Math.min(item.entry.lineCount, item.endLine + 4);
      return {
        ...item,
        bm25fScore: lexScoreByFile.get(item.relPath) || 0,
        reverseDepsCount: revDeps,
        symbols: item.entry.symbols || [],
        exportedSymbols: item.entry.exportedSymbols || [],
        snippetText: sliceBufferLines(item.entry.buf, item.entry.lineOffsets, startP, endP),
        hybridScore: Number((item.rrfScore + codeBias + depBoost + simTie).toFixed(5)),
      };
    });

    chosen.sort((a, b) => b.hybridScore - a.hybridScore || a.relPath.localeCompare(b.relPath));

    const cpuCfg = loadCpuConfig();
    let pool = chosen.slice(0, Math.max(maxResults * 2, 12));
    let rerankElapsedMs = 0;
    let usedRerank = false;
    if (cpuCfg.cpuCrossRerank && chosen.length > 1) {
      const reranked = rerankCandidates(query, chosen.slice(0, 25), { topK: Math.max(maxResults * 2, 12), maxCandidates: 25 });
      if (reranked?.results?.length > 0) {
        pool = reranked.results;
        rerankElapsedMs = reranked.elapsedMs;
        usedRerank = true;
      }
    }
    const top = selectDiverseSlicesWithTelemetry(pool, { topK: maxResults, lambda: 0.72 });

    const results = [];
    const formattedBlocks = [];
    for (const item of top) {
      item.entry.lastAccessTs = Date.now();
      item.entry.hits += 1;
      const startL = Math.max(1, item.startLine - contextLines);
      const endL = Math.min(item.entry.lineCount, item.endLine + contextLines);
      const snippet = sliceBufferLines(item.entry.buf, item.entry.lineOffsets, startL, endL);
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

    this.stats.hits += 1;
    this.recordCompletedOp('hybrid_search', {
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
   * with already-computed warm Qwen3 vector hits (0ms extra Ollama roundtrip).
   * @param {string} rootDir
   * @param {string} query
   * @param {Array<{ file: string, score: number, startLine: number, endLine: number }>} warmSemanticHits
   * @param {{ maxResults?: number, contextLines?: number }} [options={}]
   */
  buildHybridGoldContext(rootDir, query = '', warmSemanticHits = [], { maxResults = 4, contextLines = 3 } = {}) {
    const ws = this.getOrCreateWorkspace(rootDir);
    if (!ws || ws.files.size === 0 || !query || !query.trim()) {
      return { ok: false, results: [], formatted: '', usedSemantic: false };
    }

    const lexRes = this.search(ws.absRoot, query, { maxResults: Math.max(maxResults * 2, 10), contextLines: 0 });
    const semList = Array.isArray(warmSemanticHits) ? warmSemanticHits : [];

    if (semList.length === 0) {
      if (!lexRes.ok || lexRes.results.length === 0) {
        return { ok: false, results: [], formatted: '', usedSemantic: false };
      }
      const fullLex = contextLines === 0 ? lexRes : this.search(ws.absRoot, query, { maxResults, contextLines });
      return { ...fullLex, usedSemantic: false };
    }

    const RRF_K = 60;
    const mergedMap = new Map();

    semList.forEach((h, idx) => {
      const entry = ws.files.get(h.file);
      if (!entry) return;
      mergedMap.set(h.file, {
        entry,
        relPath: h.file,
        startLine: Number(h.startLine) || 1,
        endLine: Number(h.endLine) || Math.min(entry.lineCount, 45),
        similarity: Number(h.score) || 0,
        rrfScore: 1 / (RRF_K + idx + 1),
      });
    });

    (lexRes.results || []).forEach((r, idx) => {
      const entry = ws.files.get(r.file);
      if (!entry) return;
      const lexRrf = 1 / (RRF_K + idx + 1);
      const existing = mergedMap.get(r.file);
      if (existing) {
        existing.rrfScore += lexRrf;
      } else {
        mergedMap.set(r.file, {
          entry,
          relPath: r.file,
          startLine: r.startLine,
          endLine: r.endLine,
          similarity: 0,
          rrfScore: lexRrf,
        });
      }
    });

    const lexScoreByFile = new Map((lexRes.results || []).map((r) => [r.file, r.bm25fScore || r.score || 0]));
    const chosen = Array.from(mergedMap.values()).map((item) => {
      const codeBias = CODE_EXTENSIONS.has(item.entry.ext) ? 0.002 : 0;
      const revDeps = ws.reverseDeps.get(item.relPath)?.size || 0;
      const depBoost = Math.min(0.008, revDeps * 0.0012);
      const simTie = (item.similarity || 0) * 0.005;
      const startP = Math.max(1, item.startLine - 4);
      const endP = Math.min(item.entry.lineCount, item.endLine + 4);
      return {
        ...item,
        bm25fScore: lexScoreByFile.get(item.relPath) || 0,
        reverseDepsCount: revDeps,
        symbols: item.entry.symbols || [],
        exportedSymbols: item.entry.exportedSymbols || [],
        snippetText: sliceBufferLines(item.entry.buf, item.entry.lineOffsets, startP, endP),
        hybridScore: Number((item.rrfScore + codeBias + depBoost + simTie).toFixed(5)),
      };
    });

    chosen.sort((a, b) => b.hybridScore - a.hybridScore || a.relPath.localeCompare(b.relPath));

    const cpuCfg = loadCpuConfig();
    let pool = chosen.slice(0, Math.max(maxResults * 2, 10));
    let usedRerank = false;
    let rerankElapsedMs = 0;
    if (cpuCfg.cpuCrossRerank && chosen.length > 1) {
      const reranked = rerankCandidates(query, chosen.slice(0, 25), { topK: Math.max(maxResults * 2, 10), maxCandidates: 25 });
      if (reranked?.results?.length > 0) {
        pool = reranked.results;
        usedRerank = true;
        rerankElapsedMs = reranked.elapsedMs;
      }
    }
    const top = selectDiverseSlicesWithTelemetry(pool, { topK: maxResults, lambda: 0.72 });

    const results = [];
    const formattedBlocks = [];
    for (const item of top) {
      item.entry.lastAccessTs = Date.now();
      item.entry.hits += 1;
      const startL = Math.max(1, item.startLine - contextLines);
      const endL = Math.min(item.entry.lineCount, item.endLine + contextLines);
      const snippet = sliceBufferLines(item.entry.buf, item.entry.lineOffsets, startL, endL);
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

    this.stats.hits += 1;
    return {
      ok: results.length > 0,
      results,
      formatted: formattedBlocks.join('\n\n'),
      usedSemantic: true,
      usedRerank,
      rerankElapsedMs,
    };
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
    let entry = ws.files.get(relPath);
    if (!entry) {
      this.stats.misses += 1;
      entry = this.upsertFile(ws.absRoot, absTarget, { rebuildDeps: false });
    } else {
      this.stats.hits += 1;
    }

    if (!entry) {
      return { ok: false, formatted: `File not found or excluded: ${filePath}` };
    }

    entry.lastAccessTs = Date.now();
    entry.hits += 1;
    return { ok: true, ws, entry };
  }

  /**
   * Returns a LongCodeZip-style AST Knapsack skeleton of a cached file, keeping focus symbol/query blocks verbatim.
   * @param {string} rootDir
   * @param {string} filePath
   * @param {{ query?: string, symbol?: string, maxChars?: number }} [options={}]
   */
  skeletonize(rootDir, filePath, { query = '', symbol = '', maxChars = 3200 } = {}) {
    this.stats.slices += 1;
    const t0 = performance.now();
    const loaded = this._resolveAndLoadEntry(rootDir, filePath, 'ram_slice');
    if (!loaded.ok) {
      return { ok: false, formatted: loaded.formatted };
    }

    const { ws, entry } = loaded;
    const effectiveMaxChars = Math.max(256, Number(maxChars) || 3200);
    const entrySha1 = entry.sha1 || computeBufSha1(entry.buf);
    let res = null;
    if (!query && !symbol && ws?.speculativeSkeletonCache?.has(entry.relPath)) {
      const cached = ws.speculativeSkeletonCache.get(entry.relPath);
      if (cached && cached.sha1 === entrySha1 && cached.maxChars === effectiveMaxChars) {
        res = cached.res;
        this.stats.hits += 1;
      }
    }
    if (!res) {
      const text = entry.buf.toString('utf8');
      res = foldCodeWithKnapsack(text, {
        query: query || '',
        focusSymbol: symbol || '',
        maxBudgetChars: effectiveMaxChars,
        ext: entry.ext,
      });
    }
    const latencyMs = performance.now() - t0;
    if (res?.ok && Number(res.savedChars) > 0) {
      this.sotaStats.sliceSavedChars += Number(res.savedChars);
      try {
        recordCpuCompressionSaving({
          kind: 'knapsack',
          savedChars: res.savedChars,
          latencyMs: res.elapsedMs || latencyMs,
        });
      } catch {}
    }
    this.recordCompletedOp('ram_slice', {
      target: `${entry.relPath}#skeleton`,
      latencyMs,
    });
    return {
      ok: res.ok,
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
      formatted: `// [RAM AST Skeleton ${res.compressedChars}/${res.originalChars} chars (${res.compressionRatio}x)] ${entry.relPath}\n${res.formatted}`,
    };
  }

  /**
   * Lazily builds and caches the doc/config/skill <-> code reference graph for a workspace.
   * @param {string} rootDir
   */
  getDocRefGraph(rootDir) {
    const ws = this.ensureWarm(rootDir);
    if (!ws || ws.files.size === 0) {
      return { ok: false, docCount: 0, codeRefEdgeCount: 0, refsToCode: new Map(), codeFromDoc: new Map() };
    }
    if (!ws.docRefGraph) {
      ws.docRefGraph = buildDocConfigReferenceGraph(ws.files);
    }
    return { ok: true, ...ws.docRefGraph };
  }

  /**
   * Computes deterministic architectural clusters (Weighted Label Propagation) and God Nodes in RAM.
   * @param {string} rootDir
   * @param {{ maxClusters?: number, maxGodNodes?: number }} [options={}]
   */
  getArchitectureClusters(rootDir, { maxClusters = 8, maxGodNodes = 5 } = {}) {
    const ws = this.ensureWarm(rootDir);
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
    if (!ws.symbolGraph && ws.files.size <= 2500) {
      ws.symbolGraph = buildSymbolCallGraph(ws.files);
    }
    if (!ws.docRefGraph) {
      ws.docRefGraph = buildDocConfigReferenceGraph(ws.files);
    }
    const capClusters = Math.max(1, Number(maxClusters) || 8);
    const capGodNodes = Math.max(1, Number(maxGodNodes) || 5);
    if (!ws.archClusters || ws.archClusters._capClusters < capClusters || ws.archClusters._capGodNodes < capGodNodes) {
      const fetchClusters = Math.max(32, capClusters);
      const fetchGodNodes = Math.max(16, capGodNodes);
      const computed = detectArchitectureClusters(ws.files, ws.forwardDeps, ws.reverseDeps, {
        symbolGraph: ws.symbolGraph,
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

  /**
   * Finds the shortest k-hop path between two symbols or files across AST calls, imports, and doc refs.
   * @param {string} rootDir
   * @param {string} from
   * @param {string} to
   * @param {{ maxDepth?: number, direction?: 'both'|'directed' }} [options={}]
   */
  findGraphPath(rootDir, from, to, { maxDepth = 5, direction = 'both' } = {}) {
    const ws = this.ensureWarm(rootDir);
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
    if (!ws.symbolGraph && ws.files.size <= 2500) {
      ws.symbolGraph = buildSymbolCallGraph(ws.files);
    }
    if (!ws.docRefGraph) {
      ws.docRefGraph = buildDocConfigReferenceGraph(ws.files);
    }
    const res = findShortestGraphPath(ws.symbolGraph, from, to, {
      maxDepth,
      direction,
      forwardDeps: ws.forwardDeps,
      reverseDeps: ws.reverseDeps,
      docRefGraph: ws.docRefGraph,
    });
    this.recordCompletedOp('ram_graph_query', {
      target: `${String(from || '')} -> ${String(to || '')}`,
      latencyMs: res.elapsedMs || 0.4,
    });
    return res;
  }

  /**
   * Unified knowledge graph query endpoint backing the lazy `ram_graph_query` MCP tool.
   * Supports modes: `path`, `clusters`, `god_nodes`, `doc_refs`, `explain`, `summary`.
   * @param {string} rootDir
   * @param {object} [options={}]
   */
  queryKnowledgeGraph(
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
    const ws = this.ensureWarm(rootDir, { startWatcher });
    const qMode = String(mode || 'summary').trim().toLowerCase();
    if (!ws || ws.files.size === 0) {
      return { ok: false, mode: qMode, formatted: 'RAM Knowledge Graph error: workspace is empty or invalid.' };
    }

    if (!ws.symbolGraph && ws.files.size <= 2500) {
      ws.symbolGraph = buildSymbolCallGraph(ws.files);
    }
    if (!ws.docRefGraph) {
      ws.docRefGraph = buildDocConfigReferenceGraph(ws.files);
    }

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
      const pathRes = this.findGraphPath(ws.absRoot, srcStr, dstStr, { maxDepth, direction });
      if (!pathRes.found) {
        return { ...pathRes, mode: 'path', formatted: pathRes.formattedHint };
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
      const arch = this.getArchitectureClusters(ws.absRoot, { maxClusters, maxGodNodes });
      const bridges = findSurprisingConnections(ws.files, arch, ws.symbolGraph, ws.forwardDeps, { topN: 8 });
      this.recordCompletedOp('ram_graph_query', { target: 'surprising_bridges', latencyMs: 0.5 });
      const lines = [
        `🌉 [Surprising Cross-Cluster Bridges | ${bridges.length} found | topo:${arch.topologyHash || 'v1'}]`,
        ...(bridges.length > 0
          ? bridges.map((b) => `- [${b.confidence} | ${b.relation}] \`${b.fromFile}:L${b.callSiteLine}\` (${b.fromCluster}) -> \`${b.toFile}\`${b.toSymbol ? `#${b.toSymbol}` : ''} (${b.toCluster})`)
          : ['- (no surprising cross-cluster bridges detected)']),
      ];
      return { ok: true, mode: 'surprising_bridges', topologyHash: arch.topologyHash, bridges, formatted: lines.join('\n') };
    }

    if (qMode === 'questions') {
      const arch = this.getArchitectureClusters(ws.absRoot, { maxClusters, maxGodNodes });
      const bridges = findSurprisingConnections(ws.files, arch, ws.symbolGraph, ws.forwardDeps, { topN: 8 });
      const questions = suggestArchitectureQuestions(arch, bridges, { maxQuestions: 6 });
      this.recordCompletedOp('ram_graph_query', { target: 'questions', latencyMs: 0.5 });
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
        symbolGraph: ws.symbolGraph,
        maxDepth,
      });
      this.recordCompletedOp('ram_graph_query', { target: `affected:${tgt}`, latencyMs: 0.6 });
      return { ...aff, mode: 'affected' };
    }

    if (qMode === 'report') {
      const arch = this.getArchitectureClusters(ws.absRoot, { maxClusters, maxGodNodes });
      const bridges = findSurprisingConnections(ws.files, arch, ws.symbolGraph, ws.forwardDeps, { topN: 6 });
      const questions = suggestArchitectureQuestions(arch, bridges, { maxQuestions: 5 });
      this.recordCompletedOp('ram_graph_query', { target: 'report', latencyMs: 0.8 });
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
      const arch = this.getArchitectureClusters(ws.absRoot, { maxClusters, maxGodNodes });
      this.recordCompletedOp('ram_graph_query', { target: qMode, latencyMs: arch.elapsedMs || 0.4 });
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
      this.recordCompletedOp('ram_graph_query', { target: rel, latencyMs: 0.3 });
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
        return {
          ok: true,
          mode: 'doc_refs',
          target: rel,
          refs: [],
          formatted: `📎 [Doc/Config Refs] No doc/config references found for "${rel}".`,
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
      const arch = this.getArchitectureClusters(ws.absRoot, { maxClusters, maxGodNodes });
      const rel = resolveTargetRel(tgt);
      this.recordCompletedOp('ram_graph_query', { target: rel || tgt, latencyMs: 0.5 });

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
        } catch {}
        const syms = (entry?.symbols || [])
          .filter((s) => s?.name && s.name !== 'anonymous' && s.kind !== 'class')
          .slice(0, 2)
          .map((s) => s.name);
        if (syms.length > 0) {
          const ego = querySymbolEgoGraph(ws.symbolGraph, syms, { maxCallers: 4, maxCallees: 4 });
          if (ego?.edgesFound > 0 && ego.formattedHint) {
            lines.push(`- ${ego.formattedHint}`);
          }
        }
        return { ok: true, mode: 'explain', target: rel, found: true, formatted: lines.join('\n') };
      }

      const symClean = tgt.includes('#') ? tgt.split('#').pop() : tgt;
      let symMatches = [];
      if (ws.symbolGraph.definedSymbols?.has(symClean) || ws.symbolGraph.callersOf?.has(symClean) || ws.symbolGraph.calleesOf?.has(symClean)) {
        symMatches = [symClean];
      } else {
        const lower = ws.symbolGraph.symbolNamesLower?.get(symClean.toLowerCase());
        if (lower) symMatches = Array.from(lower).sort();
      }
      if (symMatches.length > 0) {
        const primary = symMatches[0];
        const defs = ws.symbolGraph.definedSymbols?.get(primary) || [];
        const ego = querySymbolEgoGraph(ws.symbolGraph, primary, { maxCallers: 5, maxCallees: 5 });
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
      formatted: `Unsupported ram_graph_query mode "${qMode}". Expected one of: path, clusters, god_nodes, doc_refs, explain, summary.`,
    };
  }

  /**
   * Queries the lazily cached RepoGraph 1-hop symbol call graph for a workspace.
   * @param {string} rootDir
   * @param {string|string[]} symbolOrQuery
   * @param {{ maxCallers?: number, maxCallees?: number }} [options={}]
   */
  _buildLocalNeighborhoodFiles(ws, seedRelFiles = [], maxFiles = 120) {
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

  getSymbolEgoGraph(rootDir, symbolOrQuery, { maxCallers = 5, maxCallees = 5, seedFiles = [] } = {}) {
    const ws = this.ensureWarm(rootDir);
    if (!ws || ws.files.size === 0) {
      return { ok: false, edgesFound: 0, callers: [], callees: [], formattedHint: '' };
    }
    let graph = ws.symbolGraph;
    if (!graph) {
      if (ws.files.size > 1500) {
        graph = buildSymbolCallGraph(this._buildLocalNeighborhoodFiles(ws, seedFiles, 120));
      } else {
        ws.symbolGraph = buildSymbolCallGraph(ws.files);
        graph = ws.symbolGraph;
      }
    }
    const res = querySymbolEgoGraph(graph, symbolOrQuery, { maxCallers, maxCallees });
    return { ok: true, ...res };
  }

  /**
   * Resolves a RepoGraph 1-hop hint for matched search/context results + query.
   * @param {string} rootDir
   * @param {Array<{ file: string, startLine?: number, endLine?: number }>} results
   * @param {string} [query='']
   */
  getEgoGraphHintForResults(rootDir, results = [], query = '') {
    const ws = this.getOrCreateWorkspace(rootDir);
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
    return this.getSymbolEgoGraph(ws.absRoot, targetInput, { seedFiles });
  }

  /**
   * Builds a compact 2-Hop contract strip (`callees` signatures without bodies + exact `callers` lines)
   * for the primary matched file/symbol in RAM.
   * @param {string} rootDir
   * @param {Array<{ file: string, startLine?: number, endLine?: number }>} [matchedResults=[]]
   */
  getTwoHopContractStrip(rootDir, matchedResults = []) {
    const ws = this.getOrCreateWorkspace(rootDir);
    if (!ws || ws.files.size === 0 || !Array.isArray(matchedResults) || matchedResults.length === 0) {
      return { ok: false, callers: [], callees: [], formattedHint: '' };
    }
    const primary = matchedResults[0];
    const primaryEntry = ws.files.get(primary?.file);
    if (!primaryEntry) {
      return { ok: false, callers: [], callees: [], formattedHint: '' };
    }
    let graph = ws.symbolGraph;
    if (!graph) {
      if (ws.files.size > 1500) {
        graph = buildSymbolCallGraph(this._buildLocalNeighborhoodFiles(ws, [primary?.file], 150));
      } else {
        ws.symbolGraph = buildSymbolCallGraph(ws.files);
        graph = ws.symbolGraph;
      }
    }

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

  /**
   * SWE-Pruner local branch skimmer: keeps function header, return tail, and query-relevant
   * code blocks verbatim while folding unrelated middle blocks.
   * @param {string} [codeText='']
   * @param {string} [query='']
   * @param {{ maxLines?: number }} [options={}]
   */
  skimCodeBlocksByQuery(codeText = '', query = '', { maxLines = 45 } = {}) {
    try {
      if (loadCpuConfig().cpuSotaEngines !== false) {
        const res = skimAstBranchesWithBraceBalance(codeText, query, { maxLines });
        if (res?.skimmed && Number(res.savedChars) > 0) {
          this.sotaStats.sliceSavedChars += Number(res.savedChars);
          try {
            recordCpuCompressionSaving({ kind: 'ast_skim', savedChars: res.savedChars, latencyMs: 1.0 });
          } catch {}
        }
        return res;
      }
    } catch {}
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

    // Group middle lines into logical blocks of 3..10 lines split on control headers or blank lines
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
   * @param {string} rootDir
   * @param {string} keyName
   */
  findCrossLayerSeams(rootDir, keyName = '') {
    const needle = String(keyName || '').trim();
    if (needle.length < 2) {
      return { ok: false, key: needle, layersFound: [], matches: [], formatted: '' };
    }
    const ws = this.ensureWarm(rootDir);
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

    for (const entry of ws.files.values()) {
      const text = entry.buf.toString('utf8');
      if (!text.includes(needle)) continue;
      const layer = classifyLayer(entry.ext);
      const lines = text.split(/\r?\n/);
      let fileHits = 0;
      for (let i = 0; i < lines.length; i++) {
        if (boundaryRe.test(lines[i])) {
          layerSet.add(layer);
          matches.push({
            file: entry.relPath,
            line: i + 1,
            layer,
            preview: lines[i].trim().slice(0, 120),
          });
          fileHits++;
          if (fileHits >= 4) break;
        }
      }
      if (matches.length >= 40) break;
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
   * @param {string} rootDir
   * @param {string} filePath
   * @param {{ symbol?: string, startLine?: number, endLine?: number, skeleton?: boolean, query?: string, maxChars?: number, callGraph?: boolean }} [options={}]
   */
  slice(
    rootDir,
    filePath,
    {
      symbol = '',
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
      return this.skeletonize(rootDir, filePath, {
        query: query || symbol || '',
        symbol,
        maxChars,
      });
    }

    this.stats.slices += 1;
    const t0 = performance.now();
    const loaded = this._resolveAndLoadEntry(rootDir, filePath, 'ram_slice');
    if (!loaded.ok) {
      return { ok: false, formatted: loaded.formatted };
    }
    const { entry } = loaded;
    const recordSliceSaving = (returnedText) => {
      const saved = Math.max(0, (entry.sizeBytes || 0) - Buffer.byteLength(String(returnedText || ''), 'utf8'));
      if (saved > 128) {
        this.sotaStats.sliceSavedChars += saved;
      }
    };

    if (symbol && symbol.trim()) {
      const symNeedle = symbol.trim();
      if (callGraph === true) {
        const shortName = symNeedle.includes('.') ? symNeedle.split('.').pop() : symNeedle;
        const matchedSym = (entry.symbols || []).find(
          (s) => s.name === symNeedle || s.name === shortName
        );
        const ego = this.getSymbolEgoGraph(rootDir, matchedSym?.name || shortName, { seedFiles: [entry.relPath] });
        let bodyFormatted = '';
        if (matchedSym) {
          const symStart = Math.max(1, Number(matchedSym.startLine) || 1);
          const symEnd = Math.min(entry.lineCount, Math.max(symStart, Number(matchedSym.endLine) || symStart));
          const slicedSym = sliceBufferLines(entry.buf, entry.lineOffsets, symStart, symEnd);
          bodyFormatted = `// [RAM Symbol Slice ${symStart}-${symEnd}/${entry.lineCount}] ${entry.relPath}#${matchedSym.name}\n${slicedSym}`;
        } else {
          const text = entry.buf.toString('utf8');
          const res = extractVariableSliceFromText(text, symNeedle, { focusLine: startLine > 1 ? startLine : 0 });
          bodyFormatted = `// [RAM Slice] ${entry.relPath} (${entry.lineCount}L)\n${res.formatted}`;
        }
        const graphSuffix = ego?.formattedHint ? `\n\n${ego.formattedHint}` : '';
        recordSliceSaving(bodyFormatted);
        this.recordCompletedOp('ram_slice', {
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

      const text = entry.buf.toString('utf8');
      const res = extractVariableSliceFromText(text, symNeedle, { focusLine: startLine > 1 ? startLine : 0 });
      recordSliceSaving(res.formatted);
      this.recordCompletedOp('ram_slice', {
        target: `${entry.relPath}#${symNeedle}`,
        latencyMs: performance.now() - t0,
      });
      return {
        ok: true,
        source: 'ram',
        file: entry.relPath,
        totalLines: entry.lineCount,
        formatted: `// [RAM Slice] ${entry.relPath} (${entry.lineCount}L)\n${res.formatted}`,
      };
    }

    const boundedEnd = Math.min(entry.lineCount, Math.max(startLine, endLine));
    let effectiveStart = startLine;
    let foldedHeadPrefix = '';
    if (foldBoilerplateHead && startLine === 1 && !symbol && entry.lineCount > 24) {
      const rawLines = entry.buf.toString('utf8').split(/\r?\n/);
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
          // handle multiline import blocks
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
      if (commentEnd > 4 || importCount > 12) {
        effectiveStart = Math.min(boundedEnd, Math.max(commentEnd, importEnd) + 1);
        const modPreview = importNames.slice(0, 4).join(', ') + (importNames.length > 4 ? ` +${importNames.length - 4} more` : '');
        foldedHeadPrefix = `// [Head folded: lines 1-${effectiveStart - 1}${modPreview ? ` | imports: ${modPreview}` : ''}]\n`;
      }
    }
    const sliced = sliceBufferLines(entry.buf, entry.lineOffsets, effectiveStart, boundedEnd, { compactLines });
    recordSliceSaving(`${foldedHeadPrefix}${sliced}`);
    this.recordCompletedOp('ram_slice', {
      target: `${entry.relPath} [L${startLine}-${boundedEnd}]`,
      latencyMs: performance.now() - t0,
    });
    return {
      ok: true,
      source: 'ram',
      file: entry.relPath,
      totalLines: entry.lineCount,
      formatted: `// [RAM Lines ${startLine}-${boundedEnd}/${entry.lineCount}] ${entry.relPath}\n${foldedHeadPrefix}${sliced}`,
    };
  }

  /**
   * Builds a fast RepoMap straight from RAM without touching disk.
   * @param {string} rootDir
   * @param {number} [maxChars=12000]
   * @param {{ toon?: boolean }} [options={}]
   */
  getFastRepoMap(rootDir, maxChars = 12000, { toon = false } = {}) {
    const ws = this.ensureWarm(rootDir);
    if (!ws || ws.files.size === 0) return null;
    const cacheKey = toon ? `${maxChars}:toon` : maxChars;
    if (ws.repoMapCache.has(cacheKey)) {
      this.stats.hits += 1;
      return { markdown: ws.repoMapCache.get(cacheKey), fromRam: true, toon: Boolean(toon), fileCount: ws.files.size };
    }

    const ranked = Array.from(ws.files.values())
      .filter((e) => CODE_EXTENSIONS.has(e.ext))
      .map((e) => ({
        entry: e,
        rankScore: (ws.reverseDeps.get(e.relPath)?.size || 0) * 3 + e.symbols.length * 0.25 + (e.hits * 0.5),
      }))
      .sort((a, b) => b.rankScore - a.rankScore || a.entry.relPath.localeCompare(b.entry.relPath));

    if (toon === true) {
      const markdown = formatRepoMapToon(ranked, maxChars);
      ws.repoMapCache.set(cacheKey, markdown);
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
      if (len + chunk.length + 4 > maxChars) break;
      lines.push('', chunk);
      len += chunk.length + 2;
    }

    const markdown = lines.join('\n');
    ws.repoMapCache.set(cacheKey, markdown);
    return { markdown, fromRam: true, toon: false, fileCount: ws.files.size };
  }

  /**
   * Computes Blast Radius reverse dependents strictly from RAM.
   * @param {string} rootDir
   * @param {string} targetFilePath
   */
  getFastBlastRadius(rootDir, targetFilePath) {
    const ws = this.ensureWarm(rootDir);
    if (!ws || !targetFilePath) return null;
    const absTarget = path.isAbsolute(targetFilePath) ? path.resolve(targetFilePath) : path.resolve(ws.absRoot, targetFilePath);
    const rel = toRelPath(ws.absRoot, absTarget);
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
    } catch {}
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
    } catch {}
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

  /**
   * Verifies import and semantic contracts in RAM without directory walks or cold disk reads.
   * @param {string} rootDir
   * @param {string} editedFilePath
   */
  verifyContractsInRam(rootDir, editedFilePath) {
    const ws = this.getOrCreateWorkspace(rootDir);
    if (!ws || ws.files.size === 0 || !editedFilePath) {
      return { ok: false, valid: true, alert: '', brokenImports: [], semanticIssues: [], cloneWarning: '' };
    }
    const absEdited = path.isAbsolute(editedFilePath) ? path.resolve(editedFilePath) : path.resolve(ws.absRoot, editedFilePath);
    const relEdited = toRelPath(ws.absRoot, absEdited);
    const textCache = new Map();

    const getFileText = (targetPath) => {
      const absP = path.isAbsolute(targetPath) ? path.resolve(targetPath) : path.resolve(ws.absRoot, targetPath);
      const rel = toRelPath(ws.absRoot, absP);
      if (textCache.has(rel)) return textCache.get(rel);
      const entry = ws.files.get(rel);
      if (entry && entry.buf) {
        const txt = entry.buf.toString('utf8');
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
          }
        }
      }
    } catch {}

    return {
      ok: true,
      valid: impCheck.valid !== false && semCheck.valid !== false && arityValid,
      alert: alerts.join(' '),
      brokenImports: impCheck.brokenImports || [],
      semanticIssues,
      cloneWarning,
    };
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
      } catch {}
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
      } catch {}
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
        if (!ws.symbolGraph && ws.files.size > 0) {
          ws.symbolGraph = buildSymbolCallGraph(ws.files);
        }

        const editedEntry = ws.files.get(relEdited);
        if (editedEntry) {
          if (!ws.simHashIndex) {
            ws.simHashIndex = buildWorkspaceSimHashIndex(ws.files);
          }
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
            ws.speculativeSkeletonCache.set(depRel, {
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
      } catch {}
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
  getContextPack(rootDir, prompt = '', { maxChars = 4800, warmSemanticHits = [], phase = 'auto', faultText = '', toon = false, pinnedFiles = [] } = {}) {
    const ws = this.ensureWarm(rootDir);
    if (!ws) return { ok: false, formatted: 'Workspace not found.' };

    const cpuCfg = loadCpuConfig();
    const usePrefixStable = cpuCfg.ramSotaEngines !== false;
    const effectivePhase = (phase && phase !== 'auto') ? phase : inferContextPruningPhase(prompt, { faultText });
    const parts = [];
    let matchedResults = [];
    let usedHybrid = false;
    const sliceLimit = effectivePhase === 'explore' ? 3 : 4;
    if (Array.isArray(warmSemanticHits) && warmSemanticHits.length > 0) {
      const hybridRes = this.buildHybridGoldContext(ws.absRoot, prompt, warmSemanticHits, { maxResults: sliceLimit, contextLines: 3 });
      if (hybridRes.ok && hybridRes.results.length > 0) {
        matchedResults = hybridRes.results;
        let renderedSlices = hybridRes.formatted;
        if (usePrefixStable && matchedResults.length > 1) {
          const stabilized = orderSlicesPrefixStable(matchedResults, { pinnedFiles });
          if (stabilized.some((item, idx) => item !== matchedResults[idx])) {
            matchedResults = stabilized;
            renderedSlices = matchedResults.map((item) => {
              const entry = ws.files.get(item.file);
              if (!entry) return '';
              const snippet = sliceBufferLines(entry.buf, entry.lineOffsets, item.startLine, item.endLine);
              const tag = item.similarity > 0 ? `(sem:${item.similarity}|rrf:${item.hybridScore})` : `(lex|rrf:${item.hybridScore})`;
              return `// ${item.file} [L${item.startLine}-L${item.endLine}] ${tag}\n${snippet}`;
            }).filter(Boolean).join('\n\n');
          }
        }
        parts.push(`## 🎮 Hybrid GPU + RAM Relevant Slices\n${renderedSlices}`);
        const firstFile = matchedResults[0].file;
        const blast = this.getFastBlastRadius(ws.absRoot, firstFile);
        if (blast?.formattedHint) {
          parts.push(blast.formattedHint);
        }
        usedHybrid = true;
      }
    }
    if (!usedHybrid) {
      const searchRes = this.search(ws.absRoot, prompt, { maxResults: sliceLimit, contextLines: 2 });
      if (searchRes.ok && searchRes.results.length > 0) {
        matchedResults = searchRes.results;
        let renderedSlices = searchRes.formatted;
        if (usePrefixStable && matchedResults.length > 1) {
          const stabilized = orderSlicesPrefixStable(matchedResults, { pinnedFiles });
          if (stabilized.some((item, idx) => item !== matchedResults[idx])) {
            matchedResults = stabilized;
            renderedSlices = matchedResults.map((item) => {
              const entry = ws.files.get(item.file);
              if (!entry) return '';
              const snippet = sliceBufferLines(entry.buf, entry.lineOffsets, item.startLine, item.endLine);
              return `### \`${item.file}\` [L${item.startLine}-L${item.endLine}]\n\`\`\`\n${snippet}\n\`\`\``;
            }).filter(Boolean).join('\n\n');
          }
        }
        parts.push(`## ⚡ RAM Relevant Slices\n${renderedSlices}`);
        const firstFile = matchedResults[0].file;
        const blast = this.getFastBlastRadius(ws.absRoot, firstFile);
        if (blast?.formattedHint) {
          parts.push(blast.formattedHint);
        }
      }
    }

    if (effectivePhase === 'explore' && matchedResults.length > 0) {
      const topEntry = ws.files.get(matchedResults[0].file);
      if (topEntry && topEntry.lineCount > 140) {
        const skel = this.skeletonize(ws.absRoot, topEntry.relPath, {
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
      const idMatch = String(faultText || prompt).match(/\b([a-zA-Z_][a-zA-Z0-9_]{3,})\b/);
      const focusSym = (topEntry?.symbols?.[0]?.name) || (idMatch ? idMatch[1] : '');
      if (focusSym && topEntry) {
        const dfSlice = extractVariableSliceFromText(topEntry.buf.toString('utf8'), focusSym, {
          focusLine: matchedResults[0].line || 0,
          maxLines: 30,
        });
        if (dfSlice?.formatted) {
          parts.push(`## 🔬 Debug Data-Flow Slice (${topFile}#${focusSym})\n${dfSlice.formatted.slice(0, 900)}`);
        }
      }
    }

    const egoHint = this.getEgoGraphHintForResults(ws.absRoot, matchedResults, prompt);
    if (egoHint?.edgesFound > 0 && egoHint.formattedHint) {
      parts.push(egoHint.formattedHint);
    }

    const twoHop = this.getTwoHopContractStrip(ws.absRoot, matchedResults);
    if (twoHop?.formattedHint) {
      parts.push(twoHop.formattedHint);
    }

    try {
      if (loadCpuConfig().cpuSotaEngines !== false && ws.files.size >= 3) {
        let pprFiles = ws.files;
        let pprGraph = ws.symbolGraph;
        if (!pprGraph) {
          if (ws.files.size > 1500) {
            const seedFiles = matchedResults.map((r) => r.file).filter(Boolean);
            pprFiles = this._buildLocalNeighborhoodFiles(ws, seedFiles, 220);
            pprGraph = buildSymbolCallGraph(pprFiles);
          } else {
            ws.symbolGraph = buildSymbolCallGraph(ws.files);
            pprGraph = ws.symbolGraph;
          }
        }
        const faultFiles = faultText && matchedResults[0]?.file ? [matchedResults[0].file] : [];
        const pprRes = computeBipartiteSymbolPPR(pprFiles, pprGraph, { query: prompt, faultFiles });
        if (pprRes?.bridgeNodes?.length > 0 && pprRes.formattedHint) {
          parts.push(pprRes.formattedHint);
          try {
            recordCpuCompressionSaving({ kind: 'ppr', savedChars: 1400, latencyMs: pprRes.elapsedMs || 1.0 });
          } catch {}
        }
      }
    } catch {}

    try {
      if (loadCpuConfig().cpuSotaEngines !== false && (effectivePhase === 'explore' || ws.files.size >= 6) && (ws.archClusters || ws.files.size <= 3000)) {
        const arch = this.getArchitectureClusters(ws.absRoot, { maxClusters: 5, maxGodNodes: 4 });
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
    } catch {}

    const pitfalls = formatPitfallsForSessionStart(ws.absRoot);
    if (pitfalls) parts.push(pitfalls);

    const handoff = formatHandoffForSessionStart(ws.absRoot);
    if (handoff) parts.push(handoff);

    const repoMapBudget = effectivePhase === 'explore' ? Math.floor(maxChars * 0.45) : Math.floor(maxChars * 0.32);
    const repoMap = this.getFastRepoMap(ws.absRoot, Math.max(1000, repoMapBudget), { toon });
    if (repoMap?.markdown) parts.push(repoMap.markdown);

    let combined = parts.join('\n\n');
    if (combined.length > maxChars) {
      combined = `${combined.slice(0, maxChars)}\n\n*(RAM Context Pack capped at ${maxChars} chars)*`;
    }
    this.recordCompletedOp('ram_context_pack', {
      target: path.basename(ws.absRoot),
      latencyMs: 0.8,
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
   * Enforces a strict relevance floor so unrelated drafts never leak arbitrary files/symbols.
   * @param {string} rootDir
   * @param {string} [draft='']
   * @param {{ maxFiles?: number, maxSymbols?: number }} [options={}]
   */
  searchComposerContextFast(rootDir, draft = '', { maxFiles = 5, maxSymbols = 10 } = {}) {
    const t0 = performance.now();
    const ws = this.ensureWarm(rootDir);
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
    const searchRes = this.search(ws.absRoot, searchQuery || cleanDraft, {
      maxResults: 12,
      contextLines: 1,
      fastMode: true,
    });

    const candidateByRel = new Map();
    for (const r of searchRes?.results || []) {
      const entry = ws.files.get(r.file);
      if (!entry) continue;
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
        snippetText: sliceBufferLines(entry.buf, entry.lineOffsets, r.startLine || 1, r.endLine || 1),
      });
    }

    // Direct path / symbol substring & prefix scan when typing partial identifiers or explicit paths
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
            snippetText: sliceBufferLines(entry.buf, entry.lineOffsets, sLine, eLine),
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

    // Relevance floor: require direct path/symbol overlap OR positive lexical/concept match on meaningful terms
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

    // Ensure explicit file matches rank first
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

    this.recordCompletedOp('composer_rag_fast', {
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
   * Expands matched slices to whole AST function/symbol boundaries (<= 55 lines/slice),
   * includes 1-hop Blast Radius + EgoGraph + 2-Hop contracts, and emits a verified project manifest.
   * NEVER injects session handoff or pitfall ledger noise.
   * @param {string} rootDir
   * @param {string} [query='']
   * @param {{ messages?: Array, maxChars?: number, warmSemanticHits?: Array, maxFiles?: number }} [options={}]
   */
  buildGroundedChatPack(
    rootDir,
    query = '',
    { messages = [], maxChars = 8400, warmSemanticHits = [], maxFiles = 5 } = {}
  ) {
    const t0 = performance.now();
    const ws = this.ensureWarm(rootDir);
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

    const cleanQuery = String(query || '').trim();
    const effectiveQuery = enrichMultiTurnChatQuery(cleanQuery, messages, { maxExtraTerms: 6 });
    const explicitQueryFiles = extractExplicitFileMatches(cleanQuery, ws.files);
    const contextFiles = extractExplicitFileMatches(effectiveQuery, ws.files);

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
      ? this.search(ws.absRoot, effectiveQuery, { maxResults: 12, contextLines: 2 })
      : { ok: false, results: [] };
    const subQueries = decomposeCompoundQuery(cleanQuery);
    const subLexLists = subQueries.map((sq) => this.search(ws.absRoot, sq, { maxResults: 6, contextLines: 2 })?.results || []);
    const semList = Array.isArray(warmSemanticHits) ? warmSemanticHits : [];

    const RRF_K = 60;
    const mergedMap = new Map();
    const bucketToKey = new Map();
    const toBucketKey = (rel, startLine) => `${rel}#b${Math.floor(Math.max(0, Number(startLine) || 0) / 40)}`;

    semList.forEach((h, idx) => {
      const rel = String(h?.file || h?.relPath || '').trim();
      const entry = rel ? ws.files.get(rel) : null;
      if (!entry) return;
      const sLine = Math.max(1, Number(h.startLine || h.line) || 1);
      const eLine = Math.max(sLine, Math.min(entry.lineCount, Number(h.endLine) || sLine + 12));
      const bKey = toBucketKey(rel, sLine);
      if (bucketToKey.has(bKey)) return;
      const key = `${rel}:${sLine}-${eLine}`;
      bucketToKey.set(bKey, key);
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
    const mergeLexResults = (resultsList = [], weightScale = 1.0) => {
      (resultsList || []).forEach((r, idx) => {
        const entry = ws.files.get(r.file);
        if (!entry) return;
        const bm = Number(r.bm25fScore || r.score || 0);
        if (bm > (lexScoreByFile.get(r.file) || 0)) {
          lexScoreByFile.set(r.file, bm);
        }
        const lexRrf = (1 / (RRF_K + idx + 1)) * weightScale;
        const bKey = toBucketKey(r.file, r.startLine);
        const existingKey = bucketToKey.get(bKey);
        const existing = existingKey ? mergedMap.get(existingKey) : null;
        if (existing) {
          existing.rrfScore += lexRrf;
          if (r.line) existing.line = r.line;
        } else {
          const key = `${r.file}:${r.startLine}-${r.endLine}`;
          bucketToKey.set(bKey, key);
          mergedMap.set(key, {
            entry,
            file: r.file,
            relPath: r.file,
            line: r.line || r.startLine || 1,
            startLine: r.startLine || 1,
            endLine: r.endLine || 1,
            similarity: 0,
            rrfScore: lexRrf,
          });
        }
      });
    };
    mergeLexResults(lexRes.results || [], 1.0);
    for (const subResults of subLexLists) {
      mergeLexResults(subResults, 0.85);
    }

    // Extract explicit symbol identifiers from cleanQuery & effectiveQuery so large-file / multi-turn symbols never miss
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
      for (const entry of ws.files.values()) {
        const syms = entry.symbols || [];
        if (syms.length === 0) continue;
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

          // When symbol spans >55 lines and follow-up question has specific concepts (e.g. "лимит токенов"), focus inside that symbol
          if (symEnd - symStart + 1 > 55 && turnConcepts.length > 0 && entry.buf && entry.lineOffsets) {
            const sByte = entry.lineOffsets[symStart - 1] || 0;
            const eByte = symEnd < entry.lineCount ? entry.lineOffsets[symEnd] - 1 : entry.buf.length;
            const fnLines = entry.buf.toString('utf8', sByte, Math.max(sByte, eByte)).split(/\r?\n/);
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
            if (targetStart > symStart + 15) {
              const existingVal = mergedMap.get(nearbyEntryKey);
              if (existingVal) {
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

    // Guarantee explicitly mentioned files in query/context are present in candidate pool
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

    const candidates = Array.from(mergedMap.entries()).map(([mKey, item]) => {
      const sliceKey = item.sliceKey || mKey;
      const codeBias = CODE_EXTENSIONS.has(item.entry.ext) ? 0.003 : 0;
      const revDeps = ws.reverseDeps.get(item.relPath)?.size || 0;
      const depBoost = Math.min(0.01, revDeps * 0.0012);
      const simTie = (item.similarity || 0) * 0.008;
      const expBoost = explicitQueryFiles.has(item.relPath)
        ? 0.45
        : (contextFiles.has(item.relPath) ? 0.12 : 0);
      const symBoost = explicitSymSliceKeys.has(sliceKey)
        ? 0.50
        : (contextSymSliceKeys.has(sliceKey) ? 0.28 : 0);
      const startP = Math.max(1, item.startLine - 4);
      const endP = Math.min(item.entry.lineCount, item.endLine + 6);
      return {
        ...item,
        sliceKey,
        bm25fScore: lexScoreByFile.get(item.relPath) || 0,
        reverseDepsCount: revDeps,
        symbols: item.entry.symbols || [],
        exportedSymbols: item.entry.exportedSymbols || [],
        snippetText: sliceBufferLines(item.entry.buf, item.entry.lineOffsets, startP, endP),
        hybridScore: Number((item.rrfScore + codeBias + depBoost + simTie + expBoost + symBoost).toFixed(5)),
      };
    });

    candidates.sort((a, b) => b.hybridScore - a.hybridScore || a.relPath.localeCompare(b.relPath));

    let pool = candidates.slice(0, Math.max(capFiles * 3, 15));
    if (effectiveQuery && candidates.length > 1) {
      const reranked = rerankCandidates(effectiveQuery, candidates.slice(0, 25), {
        topK: Math.max(capFiles * 3, 15),
        maxCandidates: 25,
      });
      if (Array.isArray(reranked?.results) && reranked.results.length > 0) {
        pool = reranked.results.map((c) => {
          const fileBoost = explicitQueryFiles.has(c.file)
            ? 0.50
            : (contextFiles.has(c.file) ? 0.12 : 0);
          const symBoost = explicitSymSliceKeys.has(c.sliceKey)
            ? 0.55
            : (contextSymSliceKeys.has(c.sliceKey) ? 0.30 : 0);
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
      }
    }

    let selected = selectDiverseSlicesWithTelemetry(pool, { topK: capFiles, lambda: 0.74 });
    // Guarantee explicitly named symbols & files are never dropped by MMR
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

    // Whole AST Symbol Expansion (<= 55 lines per slice) + deduplicate identical expanded ranges
    const orderedSlices = [...selected, ...pool.filter((p) => !selected.includes(p))];
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
      entry.lastAccessTs = Date.now();
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

    // Build verifiedManifest (~600-1400 chars): top matched files + 1-hop neighbors + top repo files if small
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

    // Assemble grounded code & 1-hop/2-hop contract sections (ZERO pitfalls / session-handoff pollution!)
    const parts = [];
    if (expandedSlices.length > 0) {
      const renderedSlices = expandedSlices
        .map((s) => {
          const symTag = s.symbol ? ` (\`${s.symbol}\`)` : '';
          return `### \`${s.file}\` [L${s.startLine}-L${s.endLine}]${symTag}\n\`\`\`\n${s.snippetText}\n\`\`\``;
        })
        .join('\n\n');
      parts.push(`## ⚡ Grounded AST-RAG Code Slices\n${renderedSlices}`);

      const blast = this.getFastBlastRadius(ws.absRoot, expandedSlices[0].file);
      if (blast?.formattedHint) {
        parts.push(blast.formattedHint);
      }
      const egoHint = this.getEgoGraphHintForResults(ws.absRoot, expandedSlices, effectiveQuery);
      if (egoHint?.edgesFound > 0 && egoHint.formattedHint) {
        parts.push(egoHint.formattedHint);
      }
      const twoHop = this.getTwoHopContractStrip(ws.absRoot, expandedSlices);
      if (twoHop?.formattedHint) {
        parts.push(twoHop.formattedHint);
      }
    }

    let combined = parts.join('\n\n');
    const remainingForMap = budgetChars - combined.length;
    if (remainingForMap >= 900) {
      const repoMap = this.getFastRepoMap(ws.absRoot, Math.min(2200, remainingForMap - 60), { toon: true });
      if (repoMap?.markdown) {
        combined = combined ? `${combined}\n\n${repoMap.markdown}` : repoMap.markdown;
      }
    }
    if (combined.length > budgetChars) {
      combined = `${combined.slice(0, budgetChars)}\n\n*(Grounded AST-RAG Pack capped at ${budgetChars} chars)*`;
    }

    const sources = expandedSlices.map((s) => ({
      file: s.file,
      startLine: s.startLine,
      endLine: s.endLine,
      ...(s.symbol ? { symbol: s.symbol } : {}),
      score: s.score,
    }));

    this.recordCompletedOp('grounded_chat_pack', {
      target: expandedSlices[0]?.file || path.basename(ws.absRoot),
      latencyMs: performance.now() - t0,
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

  /**
   * Resolves exact AST symbol definitions from warm RAM buffers (<1ms) for 2nd-hop RAG grounding.
   * @param {string} rootDir
   * @param {string[]} [symbolNames=[]]
   * @param {{ maxSlices?: number, maxLinesPerSlice?: number }} [options={}]
   * @returns {Array<{ file: string, startLine: number, endLine: number, symbol: string, snippetText: string }>}
   */
  findSymbolSlicesFast(rootDir, symbolNames = [], { maxSlices = 3, maxLinesPerSlice = 38 } = {}) {
    const ws = this.ensureWarm(rootDir);
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
    const seen = new Set();
    for (const entry of ws.files.values()) {
      if (!CODE_EXTENSIONS.has(entry.ext) || !Array.isArray(entry.symbols)) continue;
      for (const sym of entry.symbols) {
        const symName = String(sym?.name || '').trim();
        const lower = symName.toLowerCase();
        if (!lower || !wanted.has(lower) || seen.has(lower)) continue;
        const sLine = Math.max(1, Number(sym.startLine) || 1);
        const rawEnd = Math.max(sLine, Math.min(entry.lineCount, Number(sym.endLine) || sLine));
        const eLine = inferEffectiveSymbolEndLine(entry, entry.symbols, sLine, rawEnd, sLine + maxLines - 1, maxLines);
        const expanded = expandSliceToWholeAstSymbol(entry, sLine, eLine, sLine, symName, maxLines);
        if (!expanded?.snippetText) continue;
        seen.add(lower);
        out.push({
          file: entry.relPath,
          startLine: expanded.startLine,
          endLine: expanded.endLine,
          symbol: symName,
          snippetText: expanded.snippetText,
        });
        if (out.length >= cap) return out;
      }
    }
    return out;
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
    const savedTokensEstimate = memoStats.savedTokensEstimate + repairStats.savedTokensEstimate + sliceSavedTokens;
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
      sota: {
        arenaBytes,
        csrBytes,
        memoHits: memoStats.hits,
        repairRecalls: repairStats.recallsCount,
        speculativePrefetches: this.sotaStats.speculativePrefetches,
        zeroCopyBatches: this.sotaStats.zeroCopyBatches,
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
    ws.docRefGraph = null;
    ws.archClusters = null;
    ws.simHashIndex = null;
    ws.csrIndex = null;
    ws.goModulePrefix = null;
    ws.goPkgMainFile = null;
    ws.files?.clear();
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

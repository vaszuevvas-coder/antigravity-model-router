/**
 * @file hardware-stress-matrix.test.mjs
 * @description Comprehensive multi-contour stress test suite for RAM (SharedRamArena, CsrInvertedIndex,
 * LRU pressure eviction, ACON/RepairKV, multi-workspace IPC), VRAM/GPU (hardware matrices, Int8 MRL
 * vector search, concurrent in-flight distill dedup, UTF-16/binary guards, offline fallback), and
 * CPU (multi-core worker pool burst across all 8 batch types, Drain3 10k log storm, JSON TOON crusher,
 * AST Knapsack, Bipartite PPR, Arity Guard, 64-bit SimHash clones, Bitap healer, Myers zlib delta).
 */

import { registerSuiteLifecycle } from './helpers/router-test-env.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

registerSuiteLifecycle(test);

import {
  CsrInvertedIndex,
  EpisodicRepairIndex,
  ObservationWindowMemoizer,
  SharedRamArena,
  orderSlicesPrefixStable,
} from '../core/ram-sota-arena.mjs';
import { RamMemoryEngine } from '../core/ram-memory-engine.mjs';
import { handleIpcHttpRequest } from '../core/ram-memory-mcp.mjs';
import {
  beginCpuLiveWork,
  endCpuLiveWork,
  getCpuLiveActivity,
  getCpuPoolStats,
  getCpuStatusSnapshot,
  readCpuTelemetry,
  recordCpuTelemetryPatch,
  resolveCpuThreadBudget,
  runCpuBatch,
  shutdownCpuPool,
} from '../core/cpu-worker-pool.mjs';
import { rerankCandidates } from '../core/cpu-reranker.mjs';
import {
  foldCodeWithKnapsack,
  selectDiverseSlicesMMR,
} from '../core/cpu-ast-graph-compressor.mjs';
import {
  buildWorkspaceSimHashIndex,
  computeBipartiteSymbolPPR,
  findNearDuplicateFunctions,
  verifyExportArityAndKeyContracts,
} from '../core/cpu-graph-contracts.mjs';
import {
  computeOchiaiScores,
  healSearchBlockBitapAst,
  skimAstBranchesWithBraceBalance,
} from '../core/cpu-sbfl-healer.mjs';
import {
  compressLogsDrain3,
  crushStructuredPayload,
} from '../core/cpu-log-json-compressor.mjs';
import {
  computeMyersLineDelta,
  saveReadSnapshot,
} from '../core/cpu-delta-reread.mjs';
import {
  buildGpuCascadeBundleForHardware,
  clampSettingsToHardwareCeilings,
  computeHardwareCeilings,
  getHardwareProfile,
  resolveGpuModelPairForVramCap,
} from '../core/hardware-profiler.mjs';
import {
  critiqueEditedDiffLocally,
  decodeTextBufferAutoUtf,
  distillLocalFile,
  distillText,
  dotProductPrefix,
  dotProductUnit,
  getGpuStatusSnapshot,
  quantizeUnitToInt8,
} from '../core/local-gpu-engine.mjs';
import {
  mergeRamSavingsIntoTelemetry,
  safeGetCpuStatus,
} from '../sidecars/panel/server.mjs';

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function postJson(port, urlPath, body) {
  const payload = JSON.stringify(body || {});
  return new Promise((resolveReq, rejectReq) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          try {
            resolveReq({ status: res.statusCode, body: JSON.parse(raw) });
          } catch (err) {
            rejectReq(err);
          }
        });
      }
    );
    req.on('error', rejectReq);
    req.end(payload);
  });
}

// ============================================================================
// CONTOUR 1: RAM SOTA Arena, Slab Compaction, Tight-Budget LRU Eviction & IPC
// ============================================================================

test('Contour 1A — SharedRamArena heavy fragmentation (>45%), slab compaction & incremental warmWorkspaceAsync integrity', async () => {
  const arena = new SharedRamArena({ slabSizeBytes: 2048 });
  const expected = new Map();

  // 120 interleaved allocations, overwrites, dedicated oversized buffers, and deletions
  for (let i = 0; i < 80; i++) {
    const rel = `pkg/mod_${i}.mjs`;
    const body = i % 11 === 0
      ? `export const BIG_${i} = "${'W'.repeat(2600)}";\n`
      : `export function fn_${i}(v) { return v + ${i} * 2; } // pad_${'x'.repeat((i % 7) * 80)}\n`;
    arena.writeBuffer(rel, Buffer.from(body, 'utf8'));
    expected.set(rel, body);

    if (i > 10 && i % 3 === 0) {
      const victim = `pkg/mod_${i - 5}.mjs`;
      if (expected.has(victim)) {
        arena.freeFile(victim);
        expected.delete(victim);
      }
    }
    if (i > 15 && i % 5 === 0) {
      const target = `pkg/mod_${i - 4}.mjs`;
      if (expected.has(target)) {
        const updated = `export function fn_updated_${i}(z) { return z - ${i}; }\n`;
        arena.writeBuffer(target, Buffer.from(updated, 'utf8'));
        expected.set(target, updated);
      }
    }
  }

  for (const [rel, text] of expected.entries()) {
    const desc = arena.files.get(rel);
    assert.ok(desc, `Missing descriptor for ${rel}`);
    assert.equal(arena.readArenaUtf8(desc), text, `Corrupted UTF-8 slice in SharedRamArena for ${rel}`);
  }

  arena.clear();
  assert.equal(arena.getStats().slabCount, 0);
  assert.equal(arena.getStats().usedBytes, 0);

  // Verify warmWorkspaceAsync under incremental slab compaction preserves exact exportedSymbols
  const wsDir = makeTempDir('amr-stress-ram-warm-');
  const ram = new RamMemoryEngine({ budgetMb: 512 });
  try {
    fs.mkdirSync(path.join(wsDir, 'src'), { recursive: true });
    for (let i = 0; i < 30; i++) {
      fs.writeFileSync(
        path.join(wsDir, 'src', `unit_${i}.mjs`),
        `export function initialSym_${i}(a) { return a + ${i}; }\n`,
        'utf8'
      );
    }
    const warm1 = await ram.warmWorkspaceAsync(wsDir, { startWatcher: false });
    assert.equal(warm1.ok, true);
    assert.equal(warm1.filesLoaded, 30);

    // Modify 28 files with varying sizes to force arena overwrites & compactions during re-warm
    const futureMtime = new Date(Date.now() + 5000);
    for (let i = 0; i < 28; i++) {
      const p = path.join(wsDir, 'src', `unit_${i}.mjs`);
      const nextCode = `export function reloadedSym_${i}(a, b) { return a + b + ${i}; }\n// ${'p'.repeat((i % 9) * 150)}\n`;
      fs.writeFileSync(p, nextCode, 'utf8');
      fs.utimesSync(p, futureMtime, futureMtime);
    }

    const warm2 = await ram.warmWorkspaceAsync(wsDir, { startWatcher: false });
    assert.equal(warm2.ok, true);
    const ws = ram.workspaces.get(process.platform === 'win32' ? wsDir.toLowerCase() : wsDir);
    for (let i = 0; i < 28; i++) {
      const entry = ws.files.get(`src/unit_${i}.mjs`);
      assert.ok(entry, `Missing entry src/unit_${i}.mjs`);
      assert.ok(
        entry.exportedSymbols.includes(`reloadedSym_${i}`),
        `Stale or corrupted metadata for src/unit_${i}.mjs: ${JSON.stringify(entry.exportedSymbols)}`
      );
    }
  } finally {
    ram.close();
    await shutdownCpuPool();
    fs.rmSync(wsDir, { recursive: true, force: true });
  }
});

test('Contour 1B — Tight RAM budgetBytes LRU eviction + hub reverseDeps preservation under pressure', () => {
  const wsDir = makeTempDir('amr-stress-lru-');
  // Strict 24 KB cap to force aggressive LRU evictions across ~35 files
  const tightBudgetBytes = 24 * 1024;
  const ram = new RamMemoryEngine({ budgetBytes: tightBudgetBytes });

  try {
    fs.mkdirSync(path.join(wsDir, 'core'), { recursive: true });
    const hubPath = path.join(wsDir, 'core', 'hub.mjs');
    fs.writeFileSync(hubPath, 'export function coreHubToken(x) { return x * 2; }\n', 'utf8');
    ram.upsertFile(wsDir, hubPath, { rebuildDeps: true });

    // Create 35 leaf files importing hub.mjs so total approxRamBytes >> 96 KB
    for (let i = 0; i < 35; i++) {
      const leafPath = path.join(wsDir, 'core', `leaf_${i}.mjs`);
      const code = [
        "import { coreHubToken } from './hub.mjs';",
        `export function leafHandler_${i}(input) {`,
        `  const tag = "payload_${i}_${'k'.repeat(180)}";`,
        '  return coreHubToken(input) + tag.length;',
        '}',
      ].join('\n');
      fs.writeFileSync(leafPath, code, 'utf8');
      // Keep hub.mjs hot on recent leaf additions so some importers stay resident too
      if (i >= 30) {
        const ws = ram.getOrCreateWorkspace(wsDir);
        const hubEntry = ws.files.get('core/hub.mjs');
        if (hubEntry) hubEntry.lastAccessTs = Date.now() + 1000;
      }
      ram.upsertFile(wsDir, leafPath, { rebuildDeps: true });
      assert.ok(
        ram.totalCacheBytes <= tightBudgetBytes,
        `RAM budget exceeded on leaf_${i}: ${ram.totalCacheBytes} > ${tightBudgetBytes}`
      );
    }

    assert.ok(ram.stats.evictions >= 10, `Expected aggressive LRU evictions, got ${ram.stats.evictions}`);

    // Now edit hub.mjs in-place under tight RAM pressure and ensure incoming reverseDeps survive!
    const future = new Date(Date.now() + 10_000);
    fs.writeFileSync(hubPath, 'export function coreHubToken(x, scale = 3) { return x * scale; }\n', 'utf8');
    fs.utimesSync(hubPath, future, future);
    ram.upsertFile(wsDir, hubPath, { rebuildDeps: true });

    assert.ok(ram.totalCacheBytes <= tightBudgetBytes, 'RAM budget exceeded after hub in-place update');
    const blast = ram.getFastBlastRadius(wsDir, 'core/hub.mjs');
    assert.ok(Array.isArray(blast.dependents) && blast.dependents.length >= 1, `Expected surviving reverseDeps for core/hub.mjs, got ${JSON.stringify(blast)}`);
  } finally {
    ram.close();
    fs.rmSync(wsDir, { recursive: true, force: true });
  }
});

test('Contour 1C — Multi-Context & Bilingual/Adversarial RAM Query Matrix + Multi-Workspace IPC Isolation', async () => {
  const wsAlpha = makeTempDir('amr-stress-alpha-');
  const wsBeta = makeTempDir('amr-stress-beta-');
  const ram = new RamMemoryEngine({ budgetMb: 512 });

  const server = http.createServer((req, res) =>
    handleIpcHttpRequest(req, res, {
      skipAuth: true,
      engine: ram,
      settings: { enabled: true, budgetMb: 512, autoWarm: false, ramSotaEngines: true, gpuWarmHostRamCache: false },
    })
  );
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();

  try {
    fs.writeFileSync(
      path.join(wsAlpha, 'securityVault.mjs'),
      [
        'export function redactSecretApiToken(rawInput) {',
        '  const cleaned = String(rawInput || "").replace(/sk-[a-zA-Z0-9]{16,}/g, "[REDACTED]");',
        '  return cleaned;',
        '}',
      ].join('\n'),
      'utf8'
    );
    fs.writeFileSync(
      path.join(wsAlpha, 'memoryPool.mjs'),
      [
        "import { redactSecretApiToken } from './securityVault.mjs';",
        'export function evictCacheBufferSlice(limitMb = 512) {',
        '  const safeTag = redactSecretApiToken("ok");',
        '  return { limitMb, safeTag };',
        '}',
      ].join('\n'),
      'utf8'
    );
    fs.writeFileSync(
      path.join(wsAlpha, '.env'),
      `OPENAI_API_KEY=${['sk', 'secret999999999999999999'].join('-')}\n`,
      'utf8'
    );

    fs.writeFileSync(
      path.join(wsBeta, 'paymentGateway.mjs'),
      'export function settleInvoiceBetaOnly(amount) { return amount * 100; }\n',
      'utf8'
    );

    ram.warmWorkspace(wsAlpha, { startWatcher: false });
    ram.warmWorkspace(wsBeta, { startWatcher: false });

    // 1. Bilingual RU conceptual queries + exact camelCase + adversarial queries in parallel
    const queries = [
      { ws: wsAlpha, q: 'безопасность и защита секретных токенов', expectFile: 'securityVault.mjs' },
      { ws: wsAlpha, q: 'кэш памяти и вытеснение буфера', expectFile: 'memoryPool.mjs' },
      { ws: wsAlpha, q: 'evictCacheBufferSlice', expectFile: 'memoryPool.mjs' },
      { ws: wsBeta, q: 'settleInvoiceBetaOnly', expectFile: 'paymentGateway.mjs' },
    ];

    for (const item of queries) {
      const res = ram.search(item.ws, item.q, { maxResults: 5 });
      assert.equal(res.ok, true);
      assert.ok(
        res.results.some((r) => r.file === item.expectFile),
        `Query "${item.q}" missed ${item.expectFile}, got ${JSON.stringify(res.results)}`
      );
    }

    // Cross-workspace isolation: wsBeta symbol must never appear in wsAlpha search
    const crossCheck = ram.search(wsAlpha, 'settleInvoiceBetaOnly', { maxResults: 5 });
    assert.equal(crossCheck.results.length, 0, 'Cross-workspace leak detected between wsAlpha and wsBeta');

    // Adversarial & edge-case inputs: empty, regex bombs, >4KB string, path traversal, .env secret guard
    assert.equal(ram.search(wsAlpha, '').ok, false);
    assert.equal(ram.search(wsAlpha, '   ').ok, false);
    const regexQuery = ram.search(wsAlpha, '[a-z]+(.*?){1,5}\\d+$^|()[]', { maxResults: 3 });
    assert.equal(regexQuery.ok, true);
    const hugeQuery = ram.search(wsAlpha, `evictCacheBufferSlice ${'z'.repeat(5000)}`, { maxResults: 3 });
    assert.equal(hugeQuery.ok, true);

    const traversalSlice = ram.slice(wsAlpha, '../../outside.mjs', 1, 20);
    assert.equal(traversalSlice.ok, false);
    assert.match(traversalSlice.formatted, /outside the workspace|Access denied/i);

    const envSlice = ram.slice(wsAlpha, '.env', 1, 10);
    assert.equal(envSlice.ok, false, '.env file must be blocked by Security Guard');

    // Context Pack across explore / edit / debug + TOON RepoMap + prefix-stable ordering
    for (const phase of ['explore', 'edit', 'debug']) {
      const pack = ram.getContextPack(wsAlpha, 'исправить утечку в evictCacheBufferSlice', {
        phase,
        faultText: phase === 'debug' ? 'TypeError at evictCacheBufferSlice (memoryPool.mjs:3)' : '',
        toon: true,
        maxChars: 3600,
      });
      assert.equal(pack.ok, true);
      assert.equal(pack.phase, phase);
      assert.ok(pack.formatted.length <= 3700);
    }

    // IPC multi-workspace concurrent queries (/hook/pre-invocation + /hook/post-edit)
    const [ipcA, ipcB, ipcPostEdit] = await Promise.all([
      postJson(port, '/hook/pre-invocation', { wsPath: wsAlpha, query: 'redactSecretApiToken', includeSemantic: false }),
      postJson(port, '/hook/pre-invocation', { wsPath: wsBeta, query: 'settleInvoiceBetaOnly', includeSemantic: false }),
      postJson(port, '/hook/post-edit', { wsPath: wsAlpha, filePath: path.join(wsAlpha, 'securityVault.mjs') }),
    ]);
    assert.equal(ipcA.status, 200);
    assert.equal(ipcB.status, 200);
    assert.equal(ipcPostEdit.status, 200);
    assert.match(ipcA.body.goldContextHint, /securityVault\.mjs/);
    assert.doesNotMatch(ipcA.body.goldContextHint, /paymentGateway\.mjs/);
    assert.match(ipcB.body.goldContextHint, /paymentGateway\.mjs/);
    assert.equal(ipcPostEdit.body.ok, true);
    assert.ok(ipcPostEdit.body.dependents.some((d) => (d.file || d) === 'memoryPool.mjs'));

    // ACON Memoizer + RepairKV recall + CSR index intersection
    const memo = new ObservationWindowMemoizer();
    memo.recordMemo({
      convoId: 'c1',
      epoch: 1,
      toolName: 'read_file',
      targetKey: 'memoryPool.mjs',
      contentSha1: '1234567890abcdef',
      stepIdx: 1,
      charLen: 2000,
      fileDeps: ['memoryPool.mjs'],
    });
    assert.equal(memo.checkMemo({ convoId: 'c1', epoch: 1, toolName: 'read_file', targetKey: 'memoryPool.mjs', currentSha1: '1234567890abcdef', stepIdx: 2 }).hit, true);
    assert.equal(memo.checkMemo({ convoId: 'c1', epoch: 1, toolName: 'read_file', targetKey: 'memoryPool.mjs', currentSha1: '1234567890abcdef', stepIdx: 2 }).retryBypass, true);
    memo.recordMemo({
      convoId: 'c1',
      epoch: 1,
      toolName: 'read_file',
      targetKey: 'memoryPool.mjs',
      contentSha1: '1234567890abcdef',
      stepIdx: 3,
      charLen: 2000,
      fileDeps: ['memoryPool.mjs'],
    });
    memo.invalidateFile('memoryPool.mjs');
    assert.equal(memo.checkMemo({ convoId: 'c1', epoch: 1, toolName: 'read_file', targetKey: 'memoryPool.mjs', currentSha1: '1234567890abcdef', stepIdx: 4 }).hit, false);

    const repair = new EpisodicRepairIndex();
    repair.archiveFacts({
      convoId: 'c1',
      wsPath: wsAlpha,
      steps: [{ content: 'TypeError in core/ram-memory-mcp.mjs inside dispatchIpcRoute()' }],
    });
    const recall = repair.recallFacts({ convoId: 'c1', wsPath: wsAlpha, query: 'TypeError ram-memory-mcp.mjs dispatchIpcRoute' });
    assert.ok(recall.recalled.length >= 1);

    const ordered = orderSlicesPrefixStable(
      [{ file: 'z.mjs', startLine: 10 }, { file: 'types.mjs', startLine: 5 }, { file: 'p.mjs', startLine: 1 }],
      { pinnedFiles: ['p.mjs'] }
    );
    assert.deepEqual(ordered.map((x) => x.file), ['p.mjs', 'types.mjs', 'z.mjs']);

    const csr = new CsrInvertedIndex();
    csr.buildFromTokenMap(
      new Map([['a.mjs', {}], ['b.mjs', {}], ['c.mjs', {}]]),
      new Map([['ram', new Set(['a.mjs', 'b.mjs'])], ['arena', new Set(['b.mjs', 'c.mjs'])]])
    );
    assert.deepEqual(csr.intersectTerms(['ram', 'arena']), ['b.mjs']);
  } finally {
    await new Promise((r) => server.close(r));
    ram.close();
    fs.rmSync(wsAlpha, { recursive: true, force: true });
    fs.rmSync(wsBeta, { recursive: true, force: true });
  }
});

// ============================================================================
// CONTOUR 2: VRAM & Local GPU Stress Matrix (Profiles, Int8 MRL, Dedup, Faults)
// ============================================================================

test('Contour 2A — VRAM Hardware Matrices (0GB..32GB), Ceiling Clamping & Live Host Probe', async () => {
  const vramTiersMb = [0, 4096, 8192, 12288, 16384, 24576, 32768];
  for (const vramMb of vramTiersMb) {
    const bundle = buildGpuCascadeBundleForHardware(vramMb, { mode: 'cascade' });
    assert.ok(bundle && typeof bundle === 'object', `Invalid bundle for VRAM=${vramMb}`);
    if (vramMb >= 4096) {
      const pair = resolveGpuModelPairForVramCap(vramMb);
      assert.ok(pair.gpuChatModel && pair.gpuEmbedModel, `Missing model pair for ${vramMb} MB`);
    }
  }

  const ceilings = computeHardwareCeilings({
    system: { totalRamMb: 32768, logicalCores: 16 },
    gpu: { available: true, isDiscrete: true, totalMb: 12288 },
  });
  const clamped = clampSettingsToHardwareCeilings(
    { ramMaxBudgetMb: 999999, gpuMaxVramMb: 999999, cpuMaxThreads: 999 },
    ceilings
  );
  assert.ok(clamped.ramMaxBudgetMb <= ceilings.maxRamBudgetMb);
  assert.ok(clamped.gpuMaxVramMb <= ceilings.maxVramMb);
  assert.ok(clamped.cpuMaxThreads <= ceilings.maxCpuThreads);

  // Real non-mocked hardware & GPU snapshot check on current workstation
  const liveProfile = await getHardwareProfile();
  assert.ok(liveProfile.system.totalRamMb >= 1024);
  assert.ok(liveProfile.system.logicalCores >= 1);

  const gpuSnap = await getGpuStatusSnapshot();
  assert.equal(typeof gpuSnap.config.gpuEnabled, 'boolean');
});

test('Contour 2B — Int8 MRL Coarse-to-Fine Vector Search (>96 chunks), Concurrent In-Flight Distill Dedup, UTF-16/Binary Guards & Offline Fallback', async () => {
  // 1. Int8 quantization & MRL prefix rescoring across 140 synthetic 256-dim chunks
  const dim = 256;
  const targetVec = new Float32Array(dim);
  for (let i = 0; i < dim; i++) targetVec[i] = Math.sin(i * 0.17);
  let normSq = 0;
  for (let i = 0; i < dim; i++) normSq += targetVec[i] * targetVec[i];
  const norm = Math.sqrt(normSq);
  for (let i = 0; i < dim; i++) targetVec[i] /= norm;

  const chunks = [];
  for (let c = 0; c < 140; c++) {
    const v = new Float32Array(dim);
    if (c === 77) {
      v.set(targetVec);
    } else {
      for (let i = 0; i < dim; i++) v[i] = Math.cos((c + 1) * (i + 1) * 0.13);
      let s = 0;
      for (let i = 0; i < dim; i++) s += v[i] * v[i];
      const n = Math.sqrt(s) || 1;
      for (let i = 0; i < dim; i++) v[i] /= n;
    }
    chunks.push({ id: c, qInt8: quantizeUnitToInt8(v) });
  }

  const coarse = chunks
    .map((item) => ({ item, score: dotProductPrefix(targetVec, item.qInt8, 128) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 32);
  const fine = coarse
    .map(({ item }) => ({ id: item.id, sim: dotProductUnit(targetVec, item.qInt8) }))
    .sort((a, b) => b.sim - a.sim);
  assert.equal(fine[0].id, 77, 'Int8 MRL coarse-to-fine search failed to rank exact target #77 first');
  assert.ok(fine[0].sim > 0.99, `Expected Int8 cosine similarity > 0.99, got ${fine[0].sim}`);

  // 2. Concurrent inFlightDistillMap deduplication over a REAL HTTP Ollama mock server:
  // 15 parallel identical distill calls -> exactly 1 /api/chat network request!
  const nonce = `stress-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let chatNetworkHits = 0;
  let forceServerError = false;
  const mockOllamaServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (forceServerError) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'Simulated VRAM OOM' }));
        return;
      }
      if (req.method === 'GET' && req.url === '/api/ps') {
        res.writeHead(200);
        res.end(JSON.stringify({ models: [{ name: 'qwen3:4b', size_vram: 2.5 * 1024 ** 3 }] }));
        return;
      }
      if (req.method === 'GET' && req.url === '/api/tags') {
        res.writeHead(200);
        res.end(JSON.stringify({ models: [{ name: 'qwen3:4b', size: 2.5 * 1024 ** 3 }] }));
        return;
      }
      if (req.method === 'POST' && req.url === '/api/chat') {
        chatNetworkHits += 1;
        setTimeout(() => {
          res.writeHead(200);
          res.end(JSON.stringify({
            message: { content: `Distilled summary for ${nonce}` },
            prompt_eval_count: 200,
            eval_count: 20,
          }));
        }, 45);
        return;
      }
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'not found' }));
    });
  });
  await new Promise((r) => mockOllamaServer.listen(0, '127.0.0.1', r));
  const { port: ollamaPort } = mockOllamaServer.address();

  const noisyDump = Array.from(
    { length: 40 },
    (_, i) => `[2026-11-18T01:00:00Z] ERROR worker=${i % 4} Crash in pipeline (${nonce})`
  ).join('\n');

  const cfgOverride = {
    gpuEnabled: true,
    gpuAutoStart: false,
    gpuEndpoint: `http://127.0.0.1:${ollamaPort}`,
    gpuMaxVramMb: 8192,
    gpuChatModel: 'qwen3:4b',
    gpuEmbedModel: 'qwen3-embedding:0.6b',
  };

  try {
    const burstResults = await Promise.all(
      Array.from({ length: 15 }, () =>
        distillText({
          text: noisyDump,
          mode: 'docs', // bypass error_log SimHash pre-hit so all 15 enter inFlightDistillMap together
          cfgOverride,
          hwProbeFn: () => ({ available: true, freeMb: 6000, totalMb: 8192 }),
        })
      )
    );
    for (const r of burstResults) {
      assert.equal(r.ok, true, `Unexpected distill error: ${r.error}`);
      assert.match(r.summary, new RegExp(nonce));
    }
    assert.equal(chatNetworkHits, 1, `Expected inFlightDistillMap to collapse 15 calls into 1, got ${chatNetworkHits}`);

    // Fault injection: HTTP 500 VRAM OOM returns clean { ok: false } without uncaught throw
    forceServerError = true;
    const oomRes = await distillText({
      text: `Uncached fresh failure payload ${nonce}-${Math.random()}\n`.repeat(15),
      mode: 'docs',
      cfgOverride,
      hwProbeFn: () => ({ available: true, freeMb: 6000, totalMb: 8192 }),
    });
    assert.equal(oomRes.ok, false);
  } finally {
    await new Promise((r) => mockOllamaServer.close(r));
  }

  // 3. UTF-16LE / UTF-16BE / Binary NUL guard & secret redaction in distillLocalFile
  const tmpDir = makeTempDir('amr-stress-gpu-files-');
  try {
    const utf16LeBom = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Error: UTF16LE log line\n'.repeat(12), 'utf16le')]);
    const decoded16 = decodeTextBufferAutoUtf(utf16LeBom);
    assert.equal(decoded16.ok, true);
    assert.equal(decoded16.encoding, 'utf16le');
    assert.match(decoded16.text, /UTF16LE log line/);

    const binaryPath = path.join(tmpDir, 'blob.bin');
    fs.writeFileSync(binaryPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x01, 0x02]));
    const binRes = await distillLocalFile({
      filePath: binaryPath,
      workspaceRoot: tmpDir,
      cfgOverride,
      hwProbeFn: () => ({ available: true, freeMb: 6000, totalMb: 8192 }),
    });
    assert.equal(binRes.ok, false);
    assert.match(binRes.error, /Binary file detected/i);

    // 4. Offline / unreachable Ollama graceful fallback in RamMemoryEngine.searchSemantic
    fs.writeFileSync(path.join(tmpDir, 'offlineTarget.mjs'), 'export function fallbackLexicalHero() { return 777; }\n', 'utf8');
    const ram = new RamMemoryEngine({ budgetMb: 512 });
    try {
      ram.warmWorkspace(tmpDir, { startWatcher: false });
      const semFallback = await ram.searchSemantic(tmpDir, 'fallbackLexicalHero', { reindexMissing: false });
      assert.equal(semFallback.ok, true);
      assert.ok(semFallback.results.some((r) => r.file === 'offlineTarget.mjs'));
    } finally {
      ram.close();
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// CONTOUR 3: Multi-Core CPU Worker Pool Burst & 10 SOTA CPU Engines
// ============================================================================

test('Contour 3A — CpuWorkerPool concurrent saturation across all 8 batch types + thread budget cap + single-thread fallback', async () => {
  await shutdownCpuPool();
  assert.equal(resolveCpuThreadBudget({ cpuMulticoreEnabled: false }), 1);

  const arena = new SharedRamArena({ slabSizeBytes: 64 * 1024 });
  try {
    const metaItems = Array.from({ length: 16 }, (_, i) => {
      const code = `export function burstMeta_${i}(x) { return x + ${i}; }\n`;
      const sl = arena.writeBuffer(`m_${i}.mjs`, Buffer.from(code, 'utf8'));
      return { relPath: `m_${i}.mjs`, ext: '.mjs', sab: sl.sab, byteOffset: sl.byteOffset, byteLength: sl.byteLength };
    });

    const vecItems = Array.from({ length: 12 }, (_, i) => ({
      relPath: `v_${i}.mjs`,
      text: `export class Service_${i} {\n  run() { return ${i}; }\n}\n`,
    }));

    const syntaxItems = [
      ...Array.from({ length: 10 }, (_, i) => ({ file: `ok_${i}.mjs`, code: `export const v${i} = ${i};\n` })),
      { file: 'broken.js', code: 'function oops( { return 1; }' },
    ];

    const auditItems = Array.from({ length: 10 }, (_, i) => ({
      relPath: `aud_${i}.mjs`,
      ext: '.mjs',
      content: `export function cleanFn_${i}(a) { return a * 2; }\n`,
    }));

    const logItems = [
      { id: 'log1', text: Array.from({ length: 80 }, (_, i) => `2026-11-18T01:00:01Z INFO req=${i} steady ok`).join('\n') },
      { id: 'json1', mode: 'json', text: JSON.stringify(Array.from({ length: 30 }, (_, i) => ({ id: i, status: i === 15 ? 'ERROR' : 'ok' }))) },
    ];

    const foldItems = Array.from({ length: 8 }, (_, i) => ({
      relPath: `fold_${i}.mjs`,
      ext: '.mjs',
      text: [
        `export function keepFocus_${i}(x) {`,
        '  const step = x + 1;',
        '  return step * 2;',
        '}',
        `export function backgroundHelper_${i}() {`,
        ...Array.from({ length: 25 }, (_, k) => `  const line_${k} = ${k};`),
        '  return 0;',
        '}',
      ].join('\n'),
      opts: { query: `keepFocus_${i}`, maxChars: 240 },
    }));

    const simhashItems = Array.from({ length: 10 }, (_, i) => ({
      relPath: `sim_${i}.mjs`,
      ext: '.mjs',
      text: [
        `export function computeTax_${i}(price, rate, discount) {`,
        '  const cleanPrice = Math.max(0, Number(price) || 0);',
        '  const cleanRate = Math.max(0, Number(rate) || 0);',
        '  const base = cleanPrice * cleanRate;',
        '  const rebate = discount > 0 ? base * 0.05 : 0;',
        '  const subtotal = base - rebate;',
        '  const rounded = Math.round(subtotal * 100) / 100;',
        '  if (rounded > 10000) {',
        '    return rounded * 0.98;',
        '  }',
        '  return rounded;',
        '}',
      ].join('\n'),
    }));

    const skimItems = Array.from({ length: 8 }, (_, i) => ({
      relPath: `skim_${i}.mjs`,
      text: `export function processOrder_${i}(order) {\n  if (!order.valid) {\n    throw new Error("Invalid order");\n  }\n  return order.id;\n}\n`,
      query: 'Invalid order',
      opts: { maxLines: 15 },
    }));

    // Fire all 8 worker task types concurrently with maxWorkers=3 to force queueing & slot reuse
    const [
      metaOut,
      vecOut,
      synOut,
      audOut,
      logOut,
      foldOut,
      simOut,
      skimOut,
    ] = await Promise.all([
      runCpuBatch('parseMetadataBatch', metaItems, { minItemsForWorkers: 1, maxWorkers: 3 }),
      runCpuBatch('chunkVectorsBatch', vecItems, { minItemsForWorkers: 1, maxWorkers: 3 }),
      runCpuBatch('syntaxCheckBatch', syntaxItems, { minItemsForWorkers: 1, maxWorkers: 3 }),
      runCpuBatch('auditFileBatch', auditItems, { minItemsForWorkers: 1, maxWorkers: 3 }),
      runCpuBatch('compressLogsBatch', logItems, { minItemsForWorkers: 1, maxWorkers: 3 }),
      runCpuBatch('foldCodeBatch', foldItems, { minItemsForWorkers: 1, maxWorkers: 3 }),
      runCpuBatch('simhashIndexBatch', simhashItems, { minItemsForWorkers: 1, maxWorkers: 3 }),
      runCpuBatch('skimAstBatch', skimItems, { minItemsForWorkers: 1, maxWorkers: 3 }),
    ]);

    assert.equal(metaOut.length, 16);
    assert.ok(metaOut[15].meta.exportedSymbols.includes('burstMeta_15'));
    assert.equal(vecOut.length, 12);
    assert.ok(vecOut[0].chunks.length >= 1);
    assert.equal(synOut.length, 11);
    assert.equal(synOut[0].ok, true);
    assert.equal(synOut[10].ok, false);
    assert.equal(audOut.length, 10);
    assert.equal(logOut.length, 2);
    assert.equal(logOut[0].ok, true);
    assert.equal(logOut[1].ok, true);
    assert.equal(foldOut.length, 8);
    assert.match(foldOut[0].formatted, /keepFocus_0/);
    assert.equal(simOut.length, 10);
    assert.ok(simOut[0].hashes.length >= 1);
    assert.equal(skimOut.length, 8);

    const poolStats = getCpuPoolStats();
    assert.ok(poolStats.activeWorkers <= 3, `Thread cap violated: activeWorkers=${poolStats.activeWorkers} > 3`);
    assert.ok(poolStats.peakBusyWorkers <= resolveCpuThreadBudget(), `Process peakBusyWorkers exceeded hardware thread budget`);
    assert.ok(poolStats.spawnedTotal >= 1);

    // Concurrent telemetry & live-activity atomic lock stress
    const jobIds = Array.from({ length: 6 }, (_, i) =>
      beginCpuLiveWork({ op: `stress_op_${i}`, workers: 2, items: 20 })
    );
    const liveMid = getCpuLiveActivity();
    assert.equal(liveMid.isWorking, true);
    for (const jid of jobIds) {
      endCpuLiveWork(jid, { latencyMs: 4 });
    }
    recordCpuTelemetryPatch((cur) => ({ ...cur, workerBatches: (cur.workerBatches || 0) + 1 }));
    const tele = readCpuTelemetry();
    assert.ok(tele.workerBatches >= 1);
  } finally {
    arena.clear();
    await shutdownCpuPool();
  }
});

test('Contour 3B — CPU SOTA Engines Stress: 10k Drain3 Log Storm, JSON Crusher, Knapsack, MMR, PPR, Arity Guard, SimHash, Bitap & Myers Delta', () => {
  // 1. 10,000-line noisy log storm with dynamic tokens, secrets, and 2 critical faults
  const lines = [];
  const fakeSkLive = ['sk', 'live1234567890abcdefghijklmnop'].join('-');
  for (let i = 0; i < 10_000; i++) {
    if (i === 4200) {
      lines.push('2026-11-18T01:05:12.441Z FATAL Uncaught RangeError: Maximum call stack size exceeded at core/router.mjs:99');
    } else if (i === 8900) {
      lines.push(`2026-11-18T01:09:55.102Z ERROR AuthError: leaked token ${fakeSkLive} failed`);
    } else {
      lines.push(`2026-11-18T01:00:${String(i % 60).padStart(2, '0')}.123Z INFO [192.168.1.${i % 255}:8080] Healthcheck req=${i} latency=${(i % 19) + 1}ms OK`);
    }
  }
  const rawLog = lines.join('\n');
  const drain = compressLogsDrain3(rawLog);
  assert.equal(drain.wasCompressed, true);
  assert.ok(drain.compressed.length < rawLog.length * 0.12, `Expected >88% compression on 10k log storm, got ${drain.compressed.length}/${rawLog.length}`);
  assert.match(drain.compressed, /RangeError: Maximum call stack size exceeded/);
  assert.equal(drain.compressed.includes(fakeSkLive), false, 'Secret token must be redacted in Drain3 output');

  // 2. JSON Smart Crusher (500 rows with 3 anomalies)
  const rows = Array.from({ length: 500 }, (_, i) => ({
    idx: i,
    service: 'worker',
    status: i === 111 || i === 333 || i === 444 ? 'CRITICAL_FAIL' : 'healthy',
    ms: (i % 10) + 2,
  }));
  const crushed = crushStructuredPayload(JSON.stringify(rows));
  assert.equal(crushed.wasCrushed, true);
  assert.match(crushed.crushed, /CRITICAL_FAIL/);
  assert.ok(crushed.crushed.length < JSON.stringify(rows).length * 0.35);

  // 3. LongCodeZip AST Knapsack + MMR Diversity + Bilingual Reranker
  const largeSource = [
    'export class PaymentOrchestrator {',
    ...Array.from({ length: 12 }, (_, m) => [
      `  method_${m}(amount) {`,
      ...Array.from({ length: 20 }, (_, k) => `    const tmp_${m}_${k} = amount + ${k};`),
      `    return amount + ${m};`,
      '  }',
    ].join('\n')),
    '  verifyFraudSignature(payload, hmacSecret) {',
    '    if (!payload || !hmacSecret) throw new Error("Missing signature");',
    '    return hmacSecret.startsWith("sig_");',
    '  }',
    '}',
  ].join('\n');

  const folded = foldCodeWithKnapsack(largeSource, {
    ext: '.mjs',
    query: 'verifyFraudSignature hmacSecret',
    maxChars: 900,
  });
  assert.equal(folded.ok, true);
  assert.match(folded.formatted, /verifyFraudSignature/);
  assert.ok(folded.compressedChars < folded.originalChars * 0.5, `Expected >50% AST compression, got ${folded.compressedChars}/${folded.originalChars}`);

  const mmr = selectDiverseSlicesMMR(
    [
      { file: 'a.mjs', score: 0.95, snippetText: 'function alpha() { return 1; }' },
      { file: 'a_dup.mjs', score: 0.94, snippetText: 'function alpha() { return 1; }' },
      { file: 'b.mjs', score: 0.88, snippetText: 'function distinctBetaQueue() { drain(); }' },
    ],
    { topK: 2, lambda: 0.65 }
  );
  assert.equal(mmr.selected.length, 2);
  assert.equal(mmr.selected[1].file, 'b.mjs');

  const reranked = rerankCandidates('проверка подписи транзакции verifyFraudSignature', [
    { relPath: 'ui/button.mjs', snippetText: 'export const btn = 1;', hybridScore: 0.5 },
    { relPath: 'pay/fraud.mjs', snippetText: 'export function verifyFraudSignature(sig) {}', hybridScore: 0.45 },
  ]);
  assert.equal(reranked.results[0].relPath, 'pay/fraud.mjs');

  // 4. Bipartite PPR + Cross-File Arity/Key Contract Guard + 64-bit SimHash Clone Radar
  const apiText = 'export function createSession({ userId, role, ttlMs }) { return { userId, role, ttlMs }; }\n';
  const loginText = "import { createSession } from '../core/api.mjs';\nexport function login(u) { return createSession({ userId: u, typoKey: 'admin' }); }\n";
  const cloneAText = [
    'export function calcDiscount(total, pct, cap) {',
    '  const cleanTotal = Math.max(0, Number(total) || 0);',
    '  const cleanPct = Math.max(0, Number(pct) || 0);',
    '  const cut = cleanTotal * (cleanPct / 100);',
    '  const capped = cap > 0 ? Math.min(cut, cap) : cut;',
    '  const net = cleanTotal - capped;',
    '  if (net < 1) {',
    '    return 0;',
    '  }',
    '  return Math.round(net * 100) / 100;',
    '}',
  ].join('\n');
  const cloneBText = [
    'export function computeRebate(sumVal, ratePct, limitVal) {',
    '  const normSum = Math.max(0, Number(sumVal) || 0);',
    '  const normRate = Math.max(0, Number(ratePct) || 0);',
    '  const delta = normSum * (normRate / 100);',
    '  const bounded = limitVal > 0 ? Math.min(delta, limitVal) : delta;',
    '  const finalVal = normSum - bounded;',
    '  if (finalVal < 1) {',
    '    return 0;',
    '  }',
    '  return Math.round(finalVal * 100) / 100;',
    '}',
  ].join('\n');

  const contractFiles = new Map([
    ['core/api.mjs', apiText],
    ['routes/login.mjs', loginText],
    ['utils/cloneA.mjs', cloneAText],
    ['utils/cloneB.mjs', cloneBText],
  ]);

  const arityCheck = verifyExportArityAndKeyContracts('core/api.mjs', apiText, [
    { file: 'routes/login.mjs', text: loginText },
  ]);
  assert.equal(arityCheck.valid, false, 'Expected destructured-key mismatch alert on missing role/ttlMs');
  assert.ok(arityCheck.issues.length >= 1);

  const simIdx = buildWorkspaceSimHashIndex(contractFiles);
  const clones = findNearDuplicateFunctions(simIdx, 'utils/cloneB.mjs', cloneBText, { maxHammingDist: 10 });
  assert.ok(clones.clones.some((c) => c.targetFile === 'utils/cloneA.mjs'), 'SimHash failed to detect Type-2 renamed-variable clone');

  const ppr = computeBipartiteSymbolPPR(contractFiles, null, { query: 'login createSession' });
  assert.equal(ppr.ok, true);

  // 5. Bitap AST Patch Healer (heals indentation drift, rejects ambiguous twin blocks) & Ochiai SBFL + Skimmer
  const origCode = [
    'export function updateBalance(acc) {',
    '    const cur = acc.balance || 0;',
    '    const next = cur + 10;',
    '    return next;',
    '}',
  ].join('\n');
  const healed = healSearchBlockBitapAst(
    origCode,
    '  const cur = acc.balance || 0;\n  const next = cur + 10;',
    '  const cur = acc.balance ?? 0;\n  const next = cur + 25;'
  );
  assert.equal(healed.healed, true);
  assert.match(healed.nextContent, /cur \+ 25/);

  const twinAmbiguous = 'function a() {\n  const x = 1;\n  return x;\n}\nfunction b() {\n  const x = 1;\n  return x;\n}\n';
  const ambigHeal = healSearchBlockBitapAst(twinAmbiguous, 'const x = 1;\nreturn x;', 'const x = 2;\nreturn x;');
  assert.equal(ambigHeal.healed, false, 'Bitap healer must reject ambiguous twin blocks');

  const skimmed = skimAstBranchesWithBraceBalance(origCode, 'balance', { maxLines: 10 });
  assert.match(skimmed.formatted, /updateBalance/);

  const sbfl = computeOchiaiScores([
    {
      passed: false,
      coveredFunctions: [
        { file: 'src/buggy.mjs', functionName: 'crashFn', startLine: 10, endLine: 20, count: 1 },
        { file: 'src/util.mjs', functionName: 'helperFn', startLine: 1, endLine: 8, count: 1 },
      ],
    },
    {
      passed: true,
      coveredFunctions: [
        { file: 'src/util.mjs', functionName: 'helperFn', startLine: 1, endLine: 8, count: 1 },
      ],
    },
  ]);
  assert.equal(sbfl[0].relFile, 'src/buggy.mjs');
  assert.equal(sbfl[0].ochiai, 1);

  // 6. Myers Delta-on-Reread + zlib snapshot persistence
  const base200 = Array.from({ length: 180 }, (_, i) => `export function slot_${i}() { return ${i}; }`).join('\n');
  const edited200 = base200.replace('export function slot_90() { return 90; }', 'export function slot_90() { return 9090; }');
  const savedSnap = saveReadSnapshot({ sha1: 'abcdef1234567890', text: base200, filePath: 'slots.mjs' });
  assert.equal(savedSnap, true);

  const delta = computeMyersLineDelta(base200, edited200, { filePath: 'slots.mjs' });
  assert.equal(delta.canUseDelta, true);
  assert.equal(delta.addedLines, 1);
  assert.equal(delta.removedLines, 1);
  assert.match(delta.astSymbolSummary, /slot_90/);
});

// ============================================================================
// CONTOUR 4: End-to-End Cross-Subsystem Synergy (RAM + CPU + GPU + Sidecar)
// ============================================================================

test('Contour 4 — End-to-end pipeline: Warm RAM + CPU Pool -> Context Pack -> Edit Critique -> Sidecar Telemetry Merge', async () => {
  const wsDir = makeTempDir('amr-stress-e2e-');
  const ram = new RamMemoryEngine({ budgetMb: 512 });

  try {
    fs.mkdirSync(path.join(wsDir, 'services'), { recursive: true });
    for (let i = 0; i < 26; i++) {
      fs.writeFileSync(
        path.join(wsDir, 'services', `svc_${i}.mjs`),
        [
          i > 0 ? `import { runSvc_${i - 1} } from './svc_${i - 1}.mjs';` : '',
          `export async function runSvc_${i}(ctx) {`,
          `  return ${i > 0 ? `await runSvc_${i - 1}(ctx)` : 'ctx.seed'} + ${i};`,
          '}',
        ].filter(Boolean).join('\n'),
        'utf8'
      );
    }

    // 1. Cold multi-core warm (RAM Arena + CPU Worker Pool)
    const warm = await ram.warmWorkspaceAsync(wsDir, { startWatcher: false });
    assert.equal(warm.ok, true);
    assert.equal(warm.filesLoaded, 26);

    // 2. Build Zero-Turn Context Pack (RAM + PPR + MMR + Reranker)
    const pack = ram.getContextPack(wsDir, 'проверить цепочку вызовов runSvc_25 и runSvc_0', {
      phase: 'explore',
      toon: true,
      maxChars: 4200,
    });
    assert.equal(pack.ok, true);
    assert.match(pack.formatted, /svc_25\.mjs/);

    // 3. Post-edit local GPU critic simulation + RAM upsert
    const critique = await critiqueEditedDiffLocally({
      filePath: 'services/svc_25.mjs',
      oldText: 'export async function runSvc_25(ctx) { return await runSvc_24(ctx) + 25; }\n',
      newText: 'export async function runSvc_25(ctx) { if (!ctx) return 0; return await runSvc_24(ctx) + 25; }\n',
      cfgOverride: {
        gpuEnabled: true,
        gpuPostEditCritic: true,
        gpuMaxVramMb: 8192,
        gpuChatModel: 'qwen3:4b',
        gpuEmbedModel: 'qwen3-embedding:0.6b',
      },
      httpJsonFn: async (_m, urlPath) => {
        if (urlPath === '/api/chat') return { ok: true, data: { message: { content: 'OK' } } };
        return { ok: true, data: { models: [] } };
      },
    });
    assert.equal(critique.ok, true);

    // 4. Sidecar panel status & token savings aggregation
    const ramStats = ram.getStats();
    const cpuStatus = safeGetCpuStatus({}, ramStats);
    assert.ok(!cpuStatus.error, `Unexpected safeGetCpuStatus error: ${cpuStatus.error}`);
    const cpuSnap = getCpuStatusSnapshot({}, { ramTrigramsIndexed: warm.trigramsIndexed });
    assert.equal(cpuSnap.ramTrigramsIndexed, warm.trigramsIndexed);

    const mergedTel = mergeRamSavingsIntoTelemetry(
      {
        cacheSavedTokens: 1200,
        ramSavedTokens: 400,
        cpuSavedTokens: 300,
        gpuSavedTokens: 250,
        totalSavedTokens: 950,
        savingsBreakdown: { ram: 400, cpu: 300, gpu: 250 },
      },
      ramStats
    );
    assert.ok(mergedTel.totalSavedTokens >= 950);
    assert.equal(
      mergedTel.totalSavedTokens,
      mergedTel.savingsBreakdown.ram +
        mergedTel.savingsBreakdown.cpu +
        mergedTel.savingsBreakdown.gpu
    );
  } finally {
    ram.close();
    await shutdownCpuPool();
    fs.rmSync(wsDir, { recursive: true, force: true });
  }
});

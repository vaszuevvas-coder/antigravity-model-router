import { registerSuiteLifecycle } from './helpers/router-test-env.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

registerSuiteLifecycle(test);

import {
  CsrInvertedIndex,
  EpisodicRepairIndex,
  ObservationWindowMemoizer,
  orderSlicesPrefixStable,
  SharedRamArena,
} from '../core/ram-sota-arena.mjs';
import {
  getCpuPoolStats,
  loadCpuConfig,
  readCpuTelemetry,
  runCpuBatch,
  shutdownCpuPool,
} from '../core/cpu-worker-pool.mjs';
import { RamMemoryEngine } from '../core/ram-memory-engine.mjs';

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('1. SharedRamArena: slab allocation, compaction (>45% frag / overwrite), dedicated large buffers & zero-copy parseMetadataBatch', async () => {
  const cfg = loadCpuConfig();
  assert.equal(cfg.ramSotaEngines, true);

  const arena = new SharedRamArena({ slabSizeBytes: 2048 });
  const bufA = Buffer.from('export function alphaWorker() { return 1; }\n', 'utf8');
  const bufB = Buffer.from('export function betaWorker() { return 2; }\n', 'utf8');
  const bufC = Buffer.from('export function gammaWorker() { return 3; }\n', 'utf8');

  const dA = arena.writeBuffer('src/a.mjs', bufA);
  const dB = arena.writeBuffer('src/b.mjs', bufB);
  const dC = arena.writeBuffer('src/c.mjs', bufC);

  assert.equal(arena.readArenaUtf8(dA), bufA.toString('utf8'));
  assert.equal(arena.readArenaUtf8(dB), bufB.toString('utf8'));
  assert.equal(arena.readArenaUtf8(dC), bufC.toString('utf8'));
  assert.equal(dA.isShared, typeof SharedArrayBuffer === 'function');

  // Overwrite existing file & trigger compaction when fragmentation > 45%
  const bigChunk = Buffer.from('x'.repeat(1200), 'utf8');
  const dBig = arena.writeBuffer('src/big.mjs', bigChunk);
  assert.equal(arena.readArenaUtf8(dBig).length, 1200);
  arena.freeFile('src/big.mjs');

  // Re-read surviving files after compaction to ensure offsets updated cleanly
  assert.equal(arena.readArenaUtf8(arena.files.get('src/a.mjs')), bufA.toString('utf8'));
  assert.equal(arena.readArenaUtf8(arena.files.get('src/b.mjs')), bufB.toString('utf8'));
  assert.equal(arena.readArenaUtf8(arena.files.get('src/c.mjs')), bufC.toString('utf8'));

  // Overwrite existing relPath in-place
  const bufA2 = Buffer.from('export function alphaWorkerV2() { return 42; }\n', 'utf8');
  const dA2 = arena.writeBuffer('src/a.mjs', bufA2);
  assert.equal(arena.readArenaUtf8(dA2), bufA2.toString('utf8'));

  // Oversized file > slabSizeBytes gets dedicated buffer
  const hugeBuf = Buffer.from('export const HUGE = "' + 'z'.repeat(2500) + '";\n', 'utf8');
  const dHuge = arena.writeBuffer('src/huge.mjs', hugeBuf);
  assert.equal(dHuge.byteLength, hugeBuf.byteLength);
  assert.equal(arena.readArenaUtf8(dHuge), hugeBuf.toString('utf8'));

  const beforeTele = readCpuTelemetry();
  // Zero-copy worker batch using sab + byteOffset + byteLength (no text string field)
  const batchItems = [];
  for (let i = 0; i < 26; i++) {
    const relPath = `src/mod_${i}.mjs`;
    const content = `export function handler_${i}(x) { return x + ${i}; }\n`;
    const slice = arena.writeBuffer(relPath, Buffer.from(content, 'utf8'));
    batchItems.push({
      relPath,
      ext: '.mjs',
      sab: slice.sab,
      byteOffset: slice.byteOffset,
      byteLength: slice.byteLength,
    });
  }

  const parsed = await runCpuBatch('parseMetadataBatch', batchItems, { minItemsForWorkers: 25 });
  assert.equal(parsed.length, 26);
  assert.ok(parsed[0].meta.exportedSymbols.includes('handler_0'));
  assert.ok(parsed[25].meta.exportedSymbols.includes('handler_25'));

  const afterTele = readCpuTelemetry();
  const poolStats = getCpuPoolStats();
  assert.equal(poolStats.inlineFallbacks, 0, `expected worker_threads execution, got ${JSON.stringify(poolStats)}`);
  assert.ok(poolStats.spawnedTotal >= 1, 'expected at least 1 worker thread spawned');
  assert.ok(
    (afterTele.zeroCopyTasks || 0) >= (beforeTele.zeroCopyTasks || 0) + 26,
    `zeroCopyTasks telemetry must increment (before=${beforeTele.zeroCopyTasks}, after=${afterTele.zeroCopyTasks}, pool=${JSON.stringify(poolStats)}, execArgv=${JSON.stringify(process.execArgv)})`
  );

  // Freeing all files releases all slabs
  for (const key of Array.from(arena.files.keys())) {
    arena.freeFile(key);
  }
  const emptyStats = arena.getStats();
  assert.equal(emptyStats.slabCount, 0);
  assert.equal(emptyStats.usedBytes, 0);
  assert.equal(emptyStats.allocatedBytes, 0);

  arena.clear();
  await shutdownCpuPool();
});

test('2. CsrInvertedIndex: Uint32Array CSR lookup & two-pointer intersection', () => {
  const filesMap = new Map([
    ['src/auth.mjs', {}],
    ['src/session.mjs', {}],
    ['src/router.mjs', {}],
    ['tests/auth.test.mjs', {}],
  ]);
  const tokenIndexMap = new Map([
    ['token', new Set(['src/auth.mjs', 'src/session.mjs', 'tests/auth.test.mjs'])],
    ['verify', new Set(['src/auth.mjs', 'tests/auth.test.mjs'])],
    ['route', new Set(['src/router.mjs', 'src/session.mjs'])],
    ['jwt', new Set(['src/auth.mjs'])],
  ]);

  const csr = new CsrInvertedIndex();
  csr.buildFromTokenMap(filesMap, tokenIndexMap);

  const stats = csr.getStats();
  assert.equal(stats.docCount, 4);
  assert.equal(stats.termCount, 4);
  assert.equal(stats.postingsCount, 8);
  assert.ok(stats.byteLength > 0);

  assert.deepEqual(csr.lookupTermFiles('route'), ['src/router.mjs', 'src/session.mjs']);
  assert.deepEqual(csr.intersectTerms(['token', 'verify']), ['src/auth.mjs', 'tests/auth.test.mjs']);
  assert.deepEqual(csr.intersectTerms(['token', 'verify', 'jwt']), ['src/auth.mjs']);
  assert.deepEqual(csr.intersectTerms(['jwt', 'route']), []);
  assert.deepEqual(csr.intersectTerms(['nonexistent']), []);
});

test('3. ObservationWindowMemoizer (ACON): hit notice, immediate retry-bypass & file/convo invalidation', () => {
  const memo = new ObservationWindowMemoizer({ maxEntries: 600 });

  memo.recordMemo({
    convoId: 'c1',
    epoch: 1,
    toolName: 'ram_slice',
    targetKey: 'core/Engine.mjs:1-80',
    contentSha1: 'abcdef1234567890',
    charLen: 2400,
    stepIdx: 2,
    fileDeps: ['core/Helper.mjs'],
  });

  // First check in step 3 -> hit
  const hit1 = memo.checkMemo({
    convoId: 'c1',
    epoch: 1,
    toolName: 'ram_slice',
    targetKey: 'core/Engine.mjs:1-80',
    currentSha1: 'abcdef1234567890',
    stepIdx: 3,
  });
  assert.equal(hit1.hit, true);
  assert.equal(hit1.savedChars, 2400);
  assert.ok(hit1.memoNotice.startsWith('⚡ [RAM Context Memo]'));

  // Immediate retry in same step 3 -> zero-deadlock retry bypass deletes entry
  const bypass = memo.checkMemo({
    convoId: 'c1',
    epoch: 1,
    toolName: 'ram_slice',
    targetKey: 'core/Engine.mjs:1-80',
    currentSha1: 'abcdef1234567890',
    stepIdx: 3,
  });
  assert.equal(bypass.hit, false);
  assert.equal(bypass.retryBypass, true);

  // Subsequent check after bypass -> miss (was deleted)
  const afterBypass = memo.checkMemo({
    convoId: 'c1',
    epoch: 1,
    toolName: 'ram_slice',
    targetKey: 'core/Engine.mjs:1-80',
    currentSha1: 'abcdef1234567890',
    stepIdx: 4,
  });
  assert.equal(afterBypass.hit, false);
  assert.equal(afterBypass.retryBypass, false);

  // Time-based retry bypass (stepIdx < 0)
  memo.recordMemo({
    convoId: 'c1',
    epoch: 1,
    toolName: 'read_file',
    targetKey: 'src\\dep.mjs',
    contentSha1: '1122334455667788',
    charLen: 950,
    stepIdx: -1,
    fileDeps: ['src/shared/contract.mjs'],
  });
  const timeHit = memo.checkMemo({
    convoId: 'c1',
    epoch: 1,
    toolName: 'read_file',
    targetKey: 'src\\dep.mjs',
    currentSha1: '1122334455667788',
    stepIdx: -1,
  });
  assert.equal(timeHit.hit, true);
  const timeBypass = memo.checkMemo({
    convoId: 'c1',
    epoch: 1,
    toolName: 'read_file',
    targetKey: 'src\\dep.mjs',
    currentSha1: '1122334455667788',
    stepIdx: -1,
  });
  assert.equal(timeBypass.hit, false);
  assert.equal(timeBypass.retryBypass, true);

  // File invalidation via fileDeps & path normalization
  memo.recordMemo({
    convoId: 'c2',
    epoch: 0,
    toolName: 'ram_slice',
    targetKey: 'src/consumer.mjs',
    contentSha1: 'deadbeef00112233',
    charLen: 1500,
    stepIdx: 1,
    fileDeps: ['src\\Shared\\Contract.mjs'],
  });
  const invCount = memo.invalidateFile('src/shared/contract.mjs');
  if (process.platform === 'win32') {
    assert.equal(invCount, 1);
  } else {
    assert.equal(memo.invalidateFile('src/Shared/Contract.mjs'), 1);
  }

  // Convo invalidation & stats
  memo.recordMemo({
    convoId: 'c3',
    epoch: 0,
    toolName: 'ram_search',
    targetKey: 'q:foo',
    contentSha1: '99887766',
    charLen: 500,
    stepIdx: 1,
  });
  assert.equal(memo.invalidateConvo('c3'), 1);

  const stats = memo.getStats();
  assert.equal(stats.hits, 2);
  assert.equal(stats.savedCharsTotal, 3350);
  assert.ok(stats.savedTokensEstimate > 0);
});

test('4. EpisodicRepairIndex (RepairKV): archives pre-compaction facts and recalls post-compaction', () => {
  const repair = new EpisodicRepairIndex();
  const archiveRes = repair.archiveFacts({
    convoId: 'conv-42',
    wsPath: 'C:\\repo\\app',
    rawText: [
      'TypeError in verifySessionToken at core/authGuard.mjs:44 because tokenExpiryMs was undefined.',
      'Decision: switched normalizeTokenHeader to always return lowercase header keys.',
    ].join('\n'),
    steps: [
      {
        tool_calls: [
          { name: 'edit_file', args: { Path: 'core/authGuard.mjs' } },
          { name: 'run_command', args: { CommandLine: 'node --test tests/auth.test.mjs' } },
        ],
        content: 'Updated verifySessionToken in core/authGuard.mjs to guard tokenExpiryMs.',
      },
    ],
  });

  assert.ok(archiveRes.archivedCount >= 2);
  assert.ok(archiveRes.totalItems >= 2);

  const recall = repair.recallFacts({
    convoId: 'conv-42',
    wsPath: 'c:/repo/app',
    query: 'Why did verifySessionToken fail with TypeError in authGuard.mjs?',
    topK: 3,
  });

  assert.ok(recall.recalled.length >= 1);
  assert.ok(recall.formattedHint.startsWith('🔧 [RAM RepairKV Recall]'));
  assert.ok(recall.formattedHint.length <= 550);
  assert.ok(recall.formattedHint.includes('verifySessionToken') || recall.formattedHint.includes('authGuard.mjs'));
});

test('5. RamMemoryEngine integration: warmWorkspaceAsync zero-copy, speculative prefetch, prefix-stable slices & sota telemetry', async () => {
  const tmpWs = makeTempDir('ram-sota-arena-');
  try {
    fs.mkdirSync(path.join(tmpWs, 'core'), { recursive: true });
    fs.mkdirSync(path.join(tmpWs, 'ui'), { recursive: true });

    fs.writeFileSync(
      path.join(tmpWs, 'core/baseContract.mjs'),
      [
        'export function computeOrderTotal(items = []) {',
        '  let total = 0;',
        '  for (const item of items) {',
        '    const price = Number(item?.price || 0);',
        '    const qty = Number(item?.qty ?? 1);',
        '    if (Number.isFinite(price) && Number.isFinite(qty)) {',
        '      total += price * qty;',
        '    }',
        '  }',
        '  return total;',
        '}',
        '',
        'export function formatCurrency(amount) {',
        '  return `$${Number(amount || 0).toFixed(2)}`;',
        '}',
      ].join('\n'),
      'utf8'
    );

    const bigHelperLines = [
      "import { computeOrderTotal } from '../core/baseContract.mjs';",
      'export function renderCheckoutSummary(cart) {',
      '  const total = computeOrderTotal(cart.items);',
      '  return `Total: ${total}`;',
      '}',
    ];
    for (let i = 0; i < 40; i++) {
      bigHelperLines.push(`export function helperPad_${i}(v) { return v + ${i}; }`);
    }
    fs.writeFileSync(path.join(tmpWs, 'ui/checkoutView.mjs'), bigHelperLines.join('\n'), 'utf8');

    // Add 24 more code files so warmWorkspaceAsync triggers worker batch (>= 25 items)
    for (let i = 0; i < 24; i++) {
      fs.writeFileSync(
        path.join(tmpWs, `core/extra_${i}.mjs`),
        `export function extraWorker_${i}(n) { return n * ${i + 1}; }\n`,
        'utf8'
      );
    }

    // Unit test orderSlicesPrefixStable directly
    const unordered = [
      { file: 'ui/volatileTurn.mjs', startLine: 10, score: 9.9 },
      { file: 'core/zSchema.mjs', startLine: 5, isContract: true },
      { file: 'core/aContract.mjs', startLine: 20, pinned: true },
      { file: 'core/aContract.mjs', startLine: 4, pinned: true },
    ];
    const ordered = orderSlicesPrefixStable(unordered, { pinnedFiles: ['core/aContract.mjs'] });
    assert.deepEqual(
      ordered.map((s) => `${s.file}:${s.startLine}`),
      [
        'core/aContract.mjs:4',
        'core/aContract.mjs:20',
        'core/zSchema.mjs:5',
        'ui/volatileTurn.mjs:10',
      ]
    );

    const ram = new RamMemoryEngine({ budgetMb: 512 });
    const warmRes = await ram.warmWorkspaceAsync(tmpWs, { startWatcher: false });
    assert.equal(warmRes.ok, true);
    assert.ok(warmRes.filesLoaded >= 26);

    // Trigger speculative prefetch on core/baseContract.mjs -> precomputes skeleton for ui/checkoutView.mjs
    const schedRes = ram.scheduleSpeculativePrefetch(tmpWs, 'core/baseContract.mjs');
    assert.equal(schedRes.ok, true);
    assert.equal(schedRes.scheduled, true);

    await new Promise((r) => setTimeout(r, 90));

    const ws = ram.getOrCreateWorkspace(tmpWs);
    assert.ok(ws.symbolGraph, 'speculative prefetch must warm symbolGraph');
    assert.ok(ws.simHashIndex?.has('core/baseContract.mjs'), 'speculative prefetch must update simHashIndex');
    assert.ok(ws.speculativeSkeletonCache.has('ui/checkoutView.mjs'), 'speculative prefetch must cache reverseDep skeleton');

    // Fast hit in skeletonize when query === ''
    const skelHit = ram.skeletonize(tmpWs, 'ui/checkoutView.mjs', { query: '' });
    assert.equal(skelHit.ok, true);

    // Observation memo & repair recall through RamMemoryEngine interface
    ram.recordObservationMemo({
      convoId: 'eng-1',
      epoch: 0,
      toolName: 'ram_slice',
      targetKey: 'core/baseContract.mjs',
      contentSha1: 'sha1demo001',
      charLen: 800,
      stepIdx: 1,
    });
    const memoHit = ram.checkObservationMemo({
      convoId: 'eng-1',
      epoch: 0,
      toolName: 'ram_slice',
      targetKey: 'core/baseContract.mjs',
      currentSha1: 'sha1demo001',
      stepIdx: 2,
    });
    assert.equal(memoHit.hit, true);
    assert.equal(ram.invalidateObservationFile(tmpWs, path.join(tmpWs, 'core/baseContract.mjs')), 1);

    ram.archiveCompactionFacts({
      convoId: 'eng-1',
      wsPath: tmpWs,
      rawText: 'Bug in computeOrderTotal inside core/baseContract.mjs fixed via Number coercion.',
    });
    const recallRes = ram.recallCompactionFacts({
      convoId: 'eng-1',
      wsPath: tmpWs,
      query: 'computeOrderTotal baseContract',
    });
    assert.ok(recallRes.formattedHint.startsWith('🔧 [RAM RepairKV Recall]'));

    // Search & getContextPack with prefix-stable ordering
    const pack = ram.getContextPack(tmpWs, 'computeOrderTotal renderCheckoutSummary', {
      maxChars: 4800,
      pinnedFiles: ['core/baseContract.mjs'],
    });
    assert.equal(pack.ok, true);

    const stats = ram.getStats();
    assert.ok(stats.savedTokensEstimate > 0);
    assert.ok(stats.sota.arenaBytes > 0);
    assert.ok(stats.sota.csrBytes > 0);
    assert.equal(stats.sota.memoHits, 1);
    assert.equal(stats.sota.repairRecalls, 1);
    assert.ok(stats.sota.speculativePrefetches >= 1);
    assert.ok(stats.sota.zeroCopyBatches >= 1);
    assert.equal(stats.sota.savedTokensEstimate, stats.savedTokensEstimate);

    ram.close();
    const afterEvictStats = ram.getStats();
    assert.equal(afterEvictStats.sota.arenaBytes, 0);
    assert.equal(afterEvictStats.sota.csrBytes, 0);
  } finally {
    await shutdownCpuPool();
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
});

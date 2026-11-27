import { ROOT_DIR, registerSuiteLifecycle } from './helpers/router-test-env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

registerSuiteLifecycle(test);

import {
  clearReadSnapshots,
  computeMyersLineDelta,
  loadReadSnapshot,
  saveReadSnapshot,
} from '../core/cpu-delta-reread.mjs';
import {
  checkAndRecordRead,
  invalidateReadCacheForFile,
  markFileEditedForDelta,
  resetReadDedupState,
} from '../core/read-dedup.mjs';
import {
  readCpuTelemetry,
  recordCpuCompressionSaving,
} from '../core/cpu-worker-pool.mjs';
import { handlePostToolUse } from '../core/hook-runner.mjs';

function make200LineFile(tag = 'v1') {
  const lines = [];
  for (let i = 1; i <= 200; i++) {
    lines.push(`export function handler_${i}(ctx) { const value = "${tag}_step_${i}"; return ctx.run(value, ${i}); }`);
  }
  return lines.join('\n');
}

function editFourLines(text) {
  const lines = text.split('\n');
  lines[24] = 'export function handler_25(ctx) { const value = "PATCHED_25"; return ctx.run(value, 2500); }';
  lines[79] = 'export function handler_80(ctx) { const value = "PATCHED_80"; return ctx.run(value, 8000); }';
  lines[139] = 'export function handler_140(ctx) { const value = "PATCHED_140"; return ctx.run(value, 14000); }';
  lines[189] = 'export function handler_190(ctx) { const value = "PATCHED_190"; return ctx.run(value, 19000); }';
  return lines.join('\n');
}

test('computeMyersLineDelta computes compact bounded Myers diff (>75% saved) and rejects >35% edits', () => {
  const prev = make200LineFile('v1');
  const next = editFourLines(prev);
  const delta = computeMyersLineDelta(prev, next, { startLine: 1, endLine: 200 });

  assert.equal(delta.canUseDelta, true);
  assert.equal(delta.addedLines, 4);
  assert.equal(delta.removedLines, 4);
  assert.equal(delta.unchangedLines, 196);
  assert.ok(delta.diffText.includes('-export function handler_25'));
  assert.ok(delta.diffText.includes('+export function handler_25(ctx) { const value = "PATCHED_25"'));
  const origBytes = Buffer.byteLength(next, 'utf8');
  assert.ok(delta.savedBytes / origBytes > 0.75, `Expected >75% saved, got ${(delta.savedBytes / origBytes * 100).toFixed(1)}%`);
  assert.ok(delta.elapsedMs < 200, `Expected <200ms, got ${delta.elapsedMs}ms`);

  // Massive rewrite (>35% changed) must disable delta
  const rewritten = make200LineFile('COMPLETELY_REWRITTEN');
  const bigDelta = computeMyersLineDelta(prev, rewritten, { startLine: 1, endLine: 200 });
  assert.equal(bigDelta.canUseDelta, false);
});

test('snapshot cache enforces >=60L threshold, zlib roundtrip, and LRU cap 40', () => {
  clearReadSnapshots();
  try {
    const tooShort = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n');
    assert.equal(saveReadSnapshot({ sha1: 'aaaa1111bbbb2222cccc3333dddd4444eeee5555', text: tooShort }), false);

    // Save 45 snapshots -> LRU cap 40 must evict the earliest 5
    const hashes = [];
    for (let k = 0; k < 45; k++) {
      const sha1 = k.toString(16).padStart(40, 'a');
      hashes.push(sha1);
      const body = Array.from({ length: 65 }, (_, i) => `row ${k}:${i} payload`).join('\n');
      assert.equal(saveReadSnapshot({ sha1, text: body, filePath: `f_${k}.mjs` }), true);
    }

    assert.equal(loadReadSnapshot(hashes[0]), null);
    assert.ok(loadReadSnapshot(hashes[44])?.includes('row 44:0 payload'));
  } finally {
    clearReadSnapshots();
  }
});

test('read-dedup Myers Delta-on-Reread: read -> edit 4 lines -> markFileEditedForDelta -> delta (>75% saved) -> retry allows full read', () => {
  resetReadDedupState();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-delta-'));
  const targetFile = path.join(tmpDir, 'sample-200l.mjs');
  const convoId = `delta-test-${Date.now()}`;

  try {
    const v1 = make200LineFile('v1');
    fs.writeFileSync(targetFile, v1, 'utf8');

    // 1) Initial full read
    const r1 = checkAndRecordRead({
      filePath: targetFile,
      startLine: 1,
      endLine: 200,
      conversationId: convoId,
      stepIdx: 1,
    });
    assert.equal(r1.allow, true);
    assert.equal(r1.duplicate, false);

    // 2) Edit 4 lines & markFileEditedForDelta
    const v2 = editFourLines(v1);
    fs.writeFileSync(targetFile, v2, 'utf8');
    markFileEditedForDelta(targetFile);

    // 3) Re-read -> must serve Myers Delta-on-Reread
    const r2 = checkAndRecordRead({
      filePath: targetFile,
      startLine: 1,
      endLine: 200,
      conversationId: convoId,
      stepIdx: 2,
    });
    assert.equal(r2.allow, false);
    assert.equal(r2.duplicate, false);
    assert.equal(r2.deltaCompressed, true);
    assert.ok(r2.reason.startsWith('⚡ [CPU Delta-on-Reread]'));
    assert.ok(r2.reason.includes('PATCHED_80'));
    const v2Bytes = Buffer.byteLength(v2, 'utf8');
    assert.ok(r2.savedBytes / v2Bytes > 0.75, `Expected >75% saved, got ${(r2.savedBytes / v2Bytes * 100).toFixed(1)}%`);

    // 4) Immediate retry on same SHA-1 -> zero-deadlock allows full read
    const r3 = checkAndRecordRead({
      filePath: targetFile,
      startLine: 1,
      endLine: 200,
      conversationId: convoId,
      stepIdx: 2,
    });
    assert.equal(r3.allow, true);
    assert.equal(r3.duplicate, false);

    // 5) Same-length / same-mtimeMs edit with markFileEditedForDelta must NOT be skipped by meta fast-path
    const origStat = fs.statSync(targetFile);
    const v3 = v2.replace('PATCHED_25', 'PATCHED_XX'); // exact same byte length
    fs.writeFileSync(targetFile, v3, 'utf8');
    fs.utimesSync(targetFile, origStat.atime, origStat.mtime);
    markFileEditedForDelta(targetFile);

    const r4 = checkAndRecordRead({
      filePath: targetFile,
      startLine: 1,
      endLine: 200,
      conversationId: convoId,
      stepIdx: 3,
    });
    assert.equal(r4.allow, false);
    assert.equal(r4.deltaCompressed, true);
    assert.ok(r4.reason.includes('PATCHED_XX'));
  } finally {
    resetReadDedupState();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('CHECKPOINT compaction reset disables Myers Delta-on-Reread', () => {
  resetReadDedupState();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-delta-cp-'));
  const targetFile = path.join(tmpDir, 'sample-cp.mjs');
  const transcriptPath = path.join(tmpDir, 'transcript.jsonl');
  const convoId = `delta-cp-${Date.now()}`;

  try {
    const v1 = make200LineFile('cp1');
    fs.writeFileSync(targetFile, v1, 'utf8');
    fs.writeFileSync(
      transcriptPath,
      JSON.stringify({ type: 'USER_INPUT', content: 'start' }) + '\n',
      'utf8'
    );

    const r1 = checkAndRecordRead({
      filePath: targetFile,
      startLine: 1,
      endLine: 200,
      conversationId: convoId,
      stepIdx: 1,
      transcriptPath,
    });
    assert.equal(r1.allow, true);

    // Edit 4 lines + mark edited
    const v2 = editFourLines(v1);
    fs.writeFileSync(targetFile, v2, 'utf8');
    markFileEditedForDelta(targetFile);

    // Append CHECKPOINT compaction boundary AFTER r1
    const cpTs = new Date(Date.now() + 2000).toISOString();
    fs.appendFileSync(
      transcriptPath,
      JSON.stringify({
        type: 'CHECKPOINT',
        created_at: cpTs,
        content: '# Resuming from a compaction\nSummary...',
      }) + '\n',
      'utf8'
    );

    // Post-compaction re-read MUST allow full read and NEVER serve delta
    const r2 = checkAndRecordRead({
      filePath: targetFile,
      startLine: 1,
      endLine: 200,
      conversationId: convoId,
      stepIdx: 2,
      transcriptPath,
    });
    assert.equal(r2.allow, true);
    assert.equal(r2.duplicate, false);
    assert.notEqual(r2.deltaCompressed, true);
  } finally {
    resetReadDedupState();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('PostToolUse edit_file preserves snapshot via markFileEditedForDelta & invalidateReadCacheForFile clears it', async () => {
  resetReadDedupState();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-hook-delta-'));
  const targetFile = path.join(tmpDir, 'hooked.mjs');
  const convoId = `hook-delta-${Date.now()}`;

  try {
    const v1 = make200LineFile('hk1');
    fs.writeFileSync(targetFile, v1, 'utf8');

    const r1 = checkAndRecordRead({
      filePath: targetFile,
      startLine: 1,
      endLine: 200,
      conversationId: convoId,
      stepIdx: 1,
    });
    assert.equal(r1.allow, true);

    const v2 = editFourLines(v1);
    fs.writeFileSync(targetFile, v2, 'utf8');

    await handlePostToolUse(
      {
        toolName: 'edit_file',
        toolArgs: { TargetFile: targetFile },
        conversationId: convoId,
        workspaceRoot: tmpDir,
      },
      { readDedup: true, selfVerify: false, testImpact: false, blastRadius: false, skillCrystallize: false }
    );

    const r2 = checkAndRecordRead({
      filePath: targetFile,
      startLine: 1,
      endLine: 200,
      conversationId: convoId,
      stepIdx: 2,
    });
    assert.equal(r2.allow, false);
    assert.equal(r2.deltaCompressed, true);

    // Explicit invalidation must remove snapshot & cache
    invalidateReadCacheForFile(targetFile);
    const r3 = checkAndRecordRead({
      filePath: targetFile,
      startLine: 1,
      endLine: 200,
      conversationId: convoId,
      stepIdx: 3,
    });
    assert.equal(r3.allow, true);
  } finally {
    resetReadDedupState();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('recordCpuCompressionSaving updates all CPU compression telemetry counters cleanly', () => {
  const before = readCpuTelemetry();
  const afterDrain = recordCpuCompressionSaving({ kind: 'drain', savedChars: 3800, latencyMs: 1.2 });
  assert.equal(afterDrain.drainCompressedLogs, (before.drainCompressedLogs || 0) + 1);
  assert.equal(afterDrain.cpuSavedTokensEstimate, (before.cpuSavedTokensEstimate || 0) + 1000);

  const afterJson = recordCpuCompressionSaving({ kind: 'json_crush', savedChars: 1900, latencyMs: 0.8 });
  assert.equal(afterJson.jsonCrushedPayloads, (before.jsonCrushedPayloads || 0) + 1);

  const afterKnapsack = recordCpuCompressionSaving({ kind: 'knapsack', savedChars: 760, latencyMs: 1.1 });
  assert.equal(afterKnapsack.knapsackFoldedSlices, (before.knapsackFoldedSlices || 0) + 1);

  const afterDelta = recordCpuCompressionSaving({ kind: 'delta_reread', savedChars: 7600, latencyMs: 0.5 });
  assert.equal(afterDelta.deltaRereads, (before.deltaRereads || 0) + 1);

  const afterMmr = recordCpuCompressionSaving({ kind: 'mmr', savedChars: 380, latencyMs: 0.4 });
  assert.equal(afterMmr.mmrFilteredSlices, (before.mmrFilteredSlices || 0) + 1);
});

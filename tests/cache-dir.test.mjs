import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createBaseLiveActivityState,
  ensureTunnelCacheDir,
  isPidAlive,
  pruneObjectMapByTimestamp,
  resolveTunnelCacheDir,
} from '../core/cache-dir.mjs';

test('resolveTunnelCacheDir handles null/empty and TUNNEL_CACHE_DIR override safely', () => {
  const prev = process.env.TUNNEL_CACHE_DIR;
  try {
    delete process.env.TUNNEL_CACHE_DIR;
    assert.equal(resolveTunnelCacheDir(null), path.join(process.cwd(), '.cache'));
    assert.equal(resolveTunnelCacheDir('   '), path.join(process.cwd(), '.cache'));
    assert.equal(resolveTunnelCacheDir('/tmp/plugin-root'), path.join('/tmp/plugin-root', '.cache'));

    process.env.TUNNEL_CACHE_DIR = '  /tmp/custom-cache  ';
    assert.equal(resolveTunnelCacheDir('/tmp/plugin-root'), path.resolve('/tmp/custom-cache'));
  } finally {
    if (prev === undefined) delete process.env.TUNNEL_CACHE_DIR;
    else process.env.TUNNEL_CACHE_DIR = prev;
  }
});

test('ensureTunnelCacheDir creates directory and fails fast on file collision', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-dir-test-'));
  try {
    assert.equal(ensureTunnelCacheDir(null), '');
    assert.equal(ensureTunnelCacheDir('   '), '');

    const nested = path.join(tmpRoot, 'a', 'b');
    assert.equal(ensureTunnelCacheDir(nested), nested);
    assert.equal(fs.existsSync(nested), true);

    const filePath = path.join(tmpRoot, 'blocker-file');
    fs.writeFileSync(filePath, 'x', 'utf8');
    assert.throws(() => ensureTunnelCacheDir(filePath));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('pruneObjectMapByTimestamp enforces maxEntries on pinned, sanitizes Infinity/nulls, and isolates callback throws', () => {
  const now = 1_000_000;
  const input = {
    a: { ts: now - 100, pinned: true },
    b: { ts: now - 50, pinned: true },
    c: { ts: now - 10, pinned: true },
    d: { ts: now - 5 },
    inf: { ts: Infinity },
    arr: [1, 2, 3],
    isPrototypeOf: { ts: now },
  };

  // Pinned entries > maxEntries should be bounded by maxEntries (newest pinned kept)
  const boundedPinned = pruneObjectMapByTimestamp(input, {
    maxEntries: 2,
    maxAgeMs: 1000,
    now,
    keepPredicate: (_k, v) => Boolean(v.pinned),
  });
  assert.deepEqual(Object.keys(boundedPinned), ['c', 'b']);

  // Infinity ts is treated as 0 (expired when maxAgeMs > 0), arrays & unsafe keys skipped
  const regularPruned = pruneObjectMapByTimestamp(input, {
    maxEntries: null, // must fallback to 64, not 1
    maxAgeMs: 1000,
    now,
    getTs: null,
  });
  assert.equal(Object.hasOwn(regularPruned, 'inf'), false);
  assert.equal(Object.hasOwn(regularPruned, 'arr'), false);
  assert.equal(Object.hasOwn(regularPruned, 'isPrototypeOf'), false);
  assert.equal(Object.hasOwn(regularPruned, 'd'), true);
  assert.equal(Object.hasOwn(regularPruned, 'a'), true);

  // Null options & throwing callbacks do not crash
  const fixedOk = { ok: { ts: Date.now() + 5000 } };
  assert.deepEqual(pruneObjectMapByTimestamp(fixedOk, null), fixedOk);

  const withThrowingCb = pruneObjectMapByTimestamp(
    {
      bad: { ts: now, throwMe: true },
      good: { ts: now },
    },
    {
      now,
      getTs: (v) => {
        if (v.throwMe) throw new Error('boom');
        return v.ts;
      },
    }
  );
  assert.deepEqual(Object.keys(withThrowingCb), ['good']);
});

test('isPidAlive rejects booleans/arrays/null options and checks current process', () => {
  assert.equal(isPidAlive(true), false);
  assert.equal(isPidAlive(false), false);
  assert.equal(isPidAlive([1]), false);
  assert.equal(isPidAlive('   '), false);
  assert.equal(isPidAlive(0), false);
  assert.equal(isPidAlive(-5), false);
  assert.equal(isPidAlive(process.pid, null), true);
  assert.equal(isPidAlive(String(process.pid), { treatSelfAsAlive: true }), true);
});

test('createBaseLiveActivityState ignores arrays and null extra', () => {
  const fromArr = createBaseLiveActivityState(['bad']);
  assert.equal(Object.hasOwn(fromArr, '0'), false);
  assert.equal(fromArr.opSeq, 0);

  const fromNull = createBaseLiveActivityState(null);
  assert.equal(fromNull.opSeq, 0);

  const fromObj = createBaseLiveActivityState({ lastModel: 'qwen3' });
  assert.equal(fromObj.lastModel, 'qwen3');

  const fromBuf = createBaseLiveActivityState(Buffer.from('abc'));
  assert.equal(Object.hasOwn(fromBuf, '0'), false);
  assert.equal(fromBuf.opSeq, 0);

  const fromTyped = createBaseLiveActivityState(new Uint8Array([1, 2]));
  assert.equal(Object.hasOwn(fromTyped, '0'), false);
});

test('resolveTunnelCacheDir and ensureTunnelCacheDir trim paths and guard Windows drive-only roots', () => {
  const prev = process.env.TUNNEL_CACHE_DIR;
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-dir-trim-'));
  try {
    delete process.env.TUNNEL_CACHE_DIR;
    assert.equal(resolveTunnelCacheDir('  /tmp/plugin-root  '), path.join('/tmp/plugin-root', '.cache'));
    if (process.platform === 'win32') {
      assert.equal(resolveTunnelCacheDir('C:'), 'C:\\.cache');
    }

    const nested = path.join(tmpRoot, 'trimmed-dir');
    assert.equal(ensureTunnelCacheDir(`  ${nested}  `), nested);
    assert.equal(fs.existsSync(nested), true);
  } finally {
    if (prev === undefined) delete process.env.TUNNEL_CACHE_DIR;
    else process.env.TUNNEL_CACHE_DIR = prev;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('pruneObjectMapByTimestamp rejects whitespace/array/non-positive limits, prioritizes valid pinned ts, falls back to updatedAtMs, and ignores non-plain maps', () => {
  const now = 2_000_000;

  // 1. Whitespace, empty array, 0, and negative maxEntries/maxAgeMs fallback to defaults (no truncation to 1, no disabled TTL)
  const many = {
    a: { ts: now - 10 },
    b: { ts: now - 20 },
    c: { ts: now - 30 },
    expired: { ts: now - 48 * 60 * 60 * 1000 },
    missingTs: { ts: 0 },
  };
  for (const badLimit of ['   ', [], 0, -5]) {
    const res = pruneObjectMapByTimestamp(many, { maxEntries: badLimit, maxAgeMs: 1000, now });
    assert.deepEqual(Object.keys(res), ['a', 'b', 'c']);
  }
  for (const badAge of ['   ', [], 0, -100]) {
    const res = pruneObjectMapByTimestamp(many, { maxEntries: 10, maxAgeMs: badAge, now });
    assert.equal(Object.hasOwn(res, 'expired'), false);
    assert.equal(Object.hasOwn(res, 'missingTs'), false);
    assert.deepEqual(Object.keys(res), ['a', 'b', 'c']);
  }

  // 2. Pinned entries without ts (ts === 0) must not evict valid pinned entries with ts < now
  const pinnedMap = {
    corruptPinned: { pinned: true },
    validOldPinned: { ts: now - 5000, pinned: true },
    validNewPinned: { ts: now - 1000, pinned: true },
  };
  const keptPinned = pruneObjectMapByTimestamp(pinnedMap, {
    maxEntries: 2,
    maxAgeMs: 1000,
    now,
    keepPredicate: (_k, v) => Boolean(v.pinned),
  });
  assert.deepEqual(Object.keys(keptPinned), ['validNewPinned', 'validOldPinned']);

  // 3. defaultGetTs falls back to updatedAtMs when ts is invalid or non-positive
  const fallbackRes = pruneObjectMapByTimestamp(
    {
      badStrTs: { ts: 'not-a-ts', updatedAtMs: now - 50 },
      negTs: { ts: -1, updatedAtMs: now - 20 },
      bothBad: { ts: 'nope', updatedAtMs: -5 },
    },
    { maxEntries: 10, maxAgeMs: 1000, now }
  );
  assert.deepEqual(Object.keys(fallbackRes), ['badStrTs', 'negTs']);

  // 4. Non-plain objects (Map, Set, Buffer) return {} while Object.create(null) is supported
  assert.deepEqual(pruneObjectMapByTimestamp(new Map([['a', { ts: now }]]), { now }), {});
  assert.deepEqual(pruneObjectMapByTimestamp(Buffer.from('abc'), { now }), {});
  const nullProto = Object.assign(Object.create(null), { ok: { ts: now } });
  assert.deepEqual(Object.keys(pruneObjectMapByTimestamp(nullProto, { now })), ['ok']);
});

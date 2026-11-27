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
});

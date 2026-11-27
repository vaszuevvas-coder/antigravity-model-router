import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  safeReadJsonSync,
  sleepSync,
  updateJsonAtomicSync,
  withFileLockSync,
} from '../core/safe-json.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const SAFE_JSON_URL = pathToFileURL(path.join(ROOT_DIR, 'core', 'safe-json.mjs')).href;

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runNodeChild(script, args = []) {
  return new Promise((resolveChild, rejectChild) => {
    const child = spawn(process.execPath, ['-e', script, ...args], {
      cwd: ROOT_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', rejectChild);
    child.on('close', (code) => resolveChild({ code, stdout, stderr }));
  });
}

test('1. Multi-process Windows lock contention stress (8 workers x 15 atomic updates = 120)', async () => {
  const tmpDir = makeTempDir('amr-ipc-lock-stress-');
  try {
    const targetFile = path.join(tmpDir, 'shared-counter.json');
    const workerScript = `
      import { updateJsonAtomicSync } from ${JSON.stringify(SAFE_JSON_URL)};
      const filePath = process.argv[1];
      const workerId = Number(process.argv[2]);
      for (let i = 0; i < 15; i++) {
        updateJsonAtomicSync(
          filePath,
          () => ({ count: 0, workers: [] }),
          (state) => {
            const prevCount = Number(state?.count || 0);
            const prevWorkers = Array.isArray(state?.workers) ? state.workers : [];
            return {
              count: prevCount + 1,
              workers: [...prevWorkers, workerId],
            };
          }
        );
      }
    `;

    const workerCount = 8;
    const results = await Promise.all(
      Array.from({ length: workerCount }, (_, workerId) =>
        runNodeChild(workerScript, [targetFile, String(workerId)])
      )
    );

    for (let i = 0; i < results.length; i++) {
      assert.equal(results[i].code, 0, `Worker ${i} failed with stderr: ${results[i].stderr}`);
    }

    const finalState = JSON.parse(fs.readFileSync(targetFile, 'utf8'));
    assert.equal(finalState.count, 120);
    assert.equal(finalState.workers.length, 120);

    for (let w = 0; w < workerCount; w++) {
      const hits = finalState.workers.filter((id) => id === w).length;
      assert.equal(hits, 15, `Worker ${w} expected 15 updates, got ${hits}`);
    }

    const leftoverEntries = fs.readdirSync(tmpDir);
    assert.deepEqual(
      leftoverEntries,
      ['shared-counter.json'],
      `Unexpected .lock/.tmp leftovers found: ${leftoverEntries.join(', ')}`
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('2. Stale lock eviction removes backdated .lock directory and runs callback cleanly', () => {
  const tmpDir = makeTempDir('amr-stale-lock-');
  try {
    const targetFile = path.join(tmpDir, 'state.json');
    const lockDir = `${targetFile}.lock`;
    fs.mkdirSync(lockDir, { recursive: true });
    // Also place a dead-PID owner file to verify stale PID eviction path
    fs.writeFileSync(path.join(lockDir, 'owner'), '999999:1:dead', 'utf8');

    const backdated = new Date(Date.now() - 15_000);
    fs.utimesSync(lockDir, backdated, backdated);

    let callbackExecuted = false;
    const out = withFileLockSync(
      targetFile,
      () => {
        callbackExecuted = true;
        return { evicted: true };
      },
      { staleLockMs: 1000, maxWaitMs: 3000 }
    );

    assert.equal(callbackExecuted, true);
    assert.deepEqual(out, { evicted: true });
    assert.equal(fs.existsSync(lockDir), false, 'Stale lock directory should be released');
    assert.deepEqual(fs.readdirSync(tmpDir), []);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('3. Corrupted JSON self-healing returns default and rewrites valid JSON to disk', () => {
  const tmpDir = makeTempDir('amr-corrupt-heal-');
  try {
    const targetFile = path.join(tmpDir, 'corrupted.json');
    fs.writeFileSync(targetFile, '{"broken": [1, 2', 'utf8');

    const res = safeReadJsonSync(targetFile, () => ({ healed: true }), { selfHeal: true });
    assert.deepEqual(res, { healed: true });

    const onDisk = JSON.parse(fs.readFileSync(targetFile, 'utf8'));
    assert.deepEqual(onDisk, { healed: true });

    const entries = fs.readdirSync(tmpDir);
    assert.deepEqual(entries, ['corrupted.json']);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('4. Abrupt daemon socket drop resilience handles ECONNRESET without unhandled rejections', async () => {
  const tmpCache = makeTempDir('amr-drop-cache-');
  const tmpWs = makeTempDir('amr-drop-ws-');
  const prevCacheEnv = process.env.TUNNEL_CACHE_DIR;
  let serverHits = 0;

  const server = http.createServer((req) => {
    serverHits++;
    req.socket.destroy();
  });

  const unhandled = [];
  const onUnhandled = (reason) => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', onUnhandled);

  try {
    await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    const { port } = server.address();

    // 4a. Isolated client HTTP drop check mirroring queryRamDaemon ECONNRESET/timeout semantics
    const isolatedDropResult = await new Promise((resolveReq) => {
      const bodyStr = JSON.stringify({ wsPath: tmpWs, query: 'ping' });
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/hook/pre-invocation',
          method: 'POST',
          timeout: 300,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(bodyStr),
            'x-ram-token': 'drop-token',
          },
        },
        (res) => {
          let raw = '';
          res.setEncoding('utf8');
          res.on('data', (c) => { raw += c; });
          res.on('end', () => {
            try {
              resolveReq(raw ? JSON.parse(raw) : null);
            } catch {
              resolveReq(null);
            }
          });
        }
      );
      req.on('timeout', () => {
        try { req.destroy(); } catch {}
        resolveReq(null);
      });
      req.on('error', () => resolveReq(null));
      req.end(bodyStr);
    });
    assert.equal(isolatedDropResult, null);
    assert.equal(serverHits, 1);

    // 4b. End-to-end hook-runner.mjs queryRamDaemon fallback via handlePreInvocation
    fs.writeFileSync(
      path.join(tmpCache, 'ram-daemon.json'),
      JSON.stringify({
        pid: process.pid,
        port,
        token: 'drop-token',
        startedAt: new Date().toISOString(),
        workspaces: [tmpWs],
      }),
      'utf8'
    );

    process.env.TUNNEL_CACHE_DIR = tmpCache;
    const hookRunnerUrl = `${pathToFileURL(path.join(ROOT_DIR, 'core', 'hook-runner.mjs')).href}?dropTest=${Date.now()}`;
    const { handlePreInvocation } = await import(hookRunnerUrl);

    const startedAt = Date.now();
    const hookRes = await handlePreInvocation(
      {
        conversationId: `drop-conv-${process.pid}`,
        workspacePaths: [tmpWs],
        userInput: 'Inspect core/safe-json.mjs for lock contention edge cases',
      },
      {
        ramCacheEnabled: true,
        zeroTurnSlices: true,
        thinkingLimiter: true,
        repoMap: false,
        pitfallLedger: false,
        sessionHandoff: false,
        circuitBreaker: false,
        executionTracker: false,
        skillCrystallizer: false,
        taskProgress: false,
        bayesianRouter: false,
        gpuEnabled: false,
      }
    );
    const elapsedMs = Date.now() - startedAt;

    assert.ok(serverHits >= 2, `Expected handlePreInvocation to query dropping daemon, hits=${serverHits}`);
    assert.equal(typeof hookRes, 'object');
    assert.notEqual(hookRes, null);
    assert.ok(Array.isArray(hookRes.injectSteps));
    assert.ok(elapsedMs < 5000, `Fallback took too long: ${elapsedMs}ms`);

    // Allow microtasks to settle before verifying zero unhandled rejections
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(unhandled.length, 0, `Unexpected unhandled rejections: ${unhandled.join('; ')}`);
  } finally {
    process.off('unhandledRejection', onUnhandled);
    if (prevCacheEnv === undefined) delete process.env.TUNNEL_CACHE_DIR;
    else process.env.TUNNEL_CACHE_DIR = prevCacheEnv;
    await new Promise((resolveClose) => server.close(resolveClose));
    fs.rmSync(tmpCache, { recursive: true, force: true });
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
});

test('5. safeReadJsonSync handles UTF-8 BOM, invalid args, EISDIR fast-fail, and JSON null contract safely', () => {
  const tmpDir = makeTempDir('amr-safe-read-hardening-');
  try {
    // 5a. UTF-8 BOM file must parse cleanly and NOT be overwritten by selfHeal
    const bomFile = path.join(tmpDir, 'bom.json');
    const bomPayload = '\uFEFF{"subscriptionTier":"ultra","count":42}';
    fs.writeFileSync(bomFile, bomPayload, 'utf8');
    let factoryCalls = 0;
    const bomParsed = safeReadJsonSync(bomFile, () => {
      factoryCalls++;
      return { wiped: true };
    }, { selfHeal: true });
    assert.deepEqual(bomParsed, { subscriptionTier: 'ultra', count: 42 });
    assert.equal(factoryCalls, 0, 'Default factory must not run on valid UTF-8 BOM JSON');
    assert.equal(fs.readFileSync(bomFile, 'utf8'), bomPayload, 'UTF-8 BOM file must remain untouched');

    // 5b. Directory path (EISDIR) must fail fast without sleeping 84ms or self-healing
    const dirTarget = path.join(tmpDir, 'subdir');
    fs.mkdirSync(dirTarget);
    const tDir = performance.now();
    const dirRes = safeReadJsonSync(dirTarget, () => ({ fallback: true }), { selfHeal: true });
    const dirElapsedMs = performance.now() - tDir;
    assert.deepEqual(dirRes, { fallback: true });
    assert.ok(dirElapsedMs < 200, `EISDIR should fail fast (<200ms), took ${Math.round(dirElapsedMs)}ms`);
    assert.equal(fs.statSync(dirTarget).isDirectory(), true);

    // 5c. Null options, bad paths, and circular non-cloneable object defaults must never throw
    assert.deepEqual(safeReadJsonSync(bomFile, () => ({}), null), { subscriptionTier: 'ultra', count: 42 });
    assert.deepEqual(safeReadJsonSync('', () => ({ empty: true }), null), { empty: true });
    assert.deepEqual(safeReadJsonSync(null, { nullPath: true }, null), { nullPath: true });
    assert.deepEqual(safeReadJsonSync('bad\0path.json', { bad: true }, null), { bad: true });
    const circularDef = { ok: true, fn: () => 1 };
    circularDef.self = circularDef;
    const circOut = safeReadJsonSync(path.join(tmpDir, 'missing.json'), circularDef, { selfHeal: false });
    assert.equal(circOut.ok, true);
    assert.notEqual(circOut, circularDef);

    // 5d. JSON literal `null` returns object/array default in-memory without wiping disk, but preserves null when default is null
    const nullFile = path.join(tmpDir, 'null.json');
    fs.writeFileSync(nullFile, 'null', 'utf8');
    assert.deepEqual(safeReadJsonSync(nullFile, () => ({ safe: true }), { selfHeal: true }), { safe: true });
    assert.deepEqual(safeReadJsonSync(nullFile, () => [1, 2], { selfHeal: true }), [1, 2]);
    assert.equal(safeReadJsonSync(nullFile, null, { selfHeal: true }), null);
    assert.equal(safeReadJsonSync(nullFile, () => null, { selfHeal: true }), null);
    assert.equal(fs.readFileSync(nullFile, 'utf8'), 'null', 'Valid JSON null file must not be overwritten');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('6. safeReadJsonSync retries torn writes, never resurrects deleted files, respects lockWaitMs, and sweeps old orphans', async () => {
  const tmpDir = makeTempDir('amr-safe-read-races-');
  try {
    // 6a. Torn write recovery: partial JSON completed by concurrent process within retry window
    const tornFile = path.join(tmpDir, 'torn.json');
    const writer = runNodeChild(
      `
        import fs from 'node:fs';
        const target = process.argv[1];
        fs.writeFileSync(target, '{"ok":', 'utf8');
        setTimeout(() => {
          fs.writeFileSync(target, '{"ok":true,"recovered":7}', 'utf8');
        }, 12);
      `,
      [tornFile]
    );
    const tornReadyDeadline = Date.now() + 3000;
    while (!fs.existsSync(tornFile) && Date.now() < tornReadyDeadline) {
      sleepSync(2);
    }
    assert.equal(fs.existsSync(tornFile), true, 'Child should create torn file');
    const tornRes = safeReadJsonSync(tornFile, () => ({ healed: true }), { selfHeal: true });
    const writerOut = await writer;
    assert.equal(writerOut.code, 0, writerOut.stderr);
    assert.deepEqual(tornRes, { ok: true, recovered: 7 });
    assert.deepEqual(JSON.parse(fs.readFileSync(tornFile, 'utf8')), { ok: true, recovered: 7 });

    // 6b. Concurrent deletion while lock is held must NOT resurrect the deleted file
    const delFile = path.join(tmpDir, 'deleted.json');
    const delLock = `${delFile}.lock`;
    const delReady = path.join(tmpDir, 'del.ready');
    const deleter = runNodeChild(
      `
        import fs from 'node:fs';
        import path from 'node:path';
        const target = process.argv[1];
        const lockDir = process.argv[2];
        const readyFile = process.argv[3];
        fs.writeFileSync(target, '{"broken":', 'utf8');
        fs.mkdirSync(lockDir);
        fs.writeFileSync(path.join(lockDir, 'owner'), \`\${process.pid}:\${Date.now()}:holder\`, 'utf8');
        fs.writeFileSync(readyFile, '1', 'utf8');
        setTimeout(() => {
          try { fs.unlinkSync(target); } catch {}
          try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch {}
        }, 70);
      `,
      [delFile, delLock, delReady]
    );
    const delReadyDeadline = Date.now() + 3000;
    while (!fs.existsSync(delReady) && Date.now() < delReadyDeadline) {
      sleepSync(2);
    }
    assert.equal(fs.existsSync(delReady), true, 'Child should arm lock and file');
    const delRes = safeReadJsonSync(delFile, () => ({ recreated: true }), { selfHeal: true, lockWaitMs: 500 });
    const deleterOut = await deleter;
    assert.equal(deleterOut.code, 0, deleterOut.stderr);
    assert.deepEqual(delRes, { recreated: true });
    assert.equal(fs.existsSync(delFile), false, 'Deleted file must NOT be resurrected by selfHeal');

    // 6c. Bounded lockWaitMs avoids 5s freeze when another live holder keeps the lock
    const busyFile = path.join(tmpDir, 'busy.json');
    const busyLock = `${busyFile}.lock`;
    fs.writeFileSync(busyFile, '{"broken":', 'utf8');
    fs.mkdirSync(busyLock);
    fs.writeFileSync(path.join(busyLock, 'owner'), `${process.pid}:${Date.now()}:alive`, 'utf8');
    const tBusy = performance.now();
    const busyRes = safeReadJsonSync(busyFile, () => ({ timedOut: true }), { selfHeal: true, lockWaitMs: 60 });
    const busyElapsedMs = performance.now() - tBusy;
    assert.deepEqual(busyRes, { timedOut: true });
    assert.ok(busyElapsedMs < 500, `Bounded lockWaitMs=60 should finish quickly, took ${Math.round(busyElapsedMs)}ms`);
    assert.equal(fs.readFileSync(busyFile, 'utf8'), '{"broken":', 'Busy lock timeout must not overwrite file');
    fs.rmSync(busyLock, { recursive: true, force: true });

    // 6d. Stale lock eviction sweeps old (>30s) .lock.stale.* and .tmp orphans while sparing fresh .tmp files
    const orphanTarget = path.join(tmpDir, 'orphan.json');
    const staleLockDir = `${orphanTarget}.lock`;
    const oldStaleDir = `${orphanTarget}.lock.stale.99999.1.abcd`;
    const oldTmpFile = `${orphanTarget}.99999.abcde.tmp`;
    const freshTmpFile = `${orphanTarget}.${process.pid}.fresh1.tmp`;
    fs.mkdirSync(staleLockDir);
    fs.writeFileSync(path.join(staleLockDir, 'owner'), '999999:1:dead', 'utf8');
    fs.mkdirSync(oldStaleDir);
    fs.writeFileSync(oldTmpFile, '{}', 'utf8');
    fs.writeFileSync(freshTmpFile, '{}', 'utf8');
    const backdated = new Date(Date.now() - 60_000);
    fs.utimesSync(staleLockDir, backdated, backdated);
    fs.utimesSync(oldStaleDir, backdated, backdated);
    fs.utimesSync(oldTmpFile, backdated, backdated);

    const swept = withFileLockSync(orphanTarget, () => 'ok', { staleLockMs: 1000, maxWaitMs: 3000 });
    assert.equal(swept, 'ok');
    assert.equal(fs.existsSync(oldStaleDir), false, 'Old .lock.stale.* orphan should be swept');
    assert.equal(fs.existsSync(oldTmpFile), false, 'Old .tmp orphan should be swept');
    assert.equal(fs.existsSync(freshTmpFile), true, 'Fresh .tmp file must NOT be deleted');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

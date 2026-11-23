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

import { ROOT_DIR, registerSuiteLifecycle } from './helpers/router-test-env.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

registerSuiteLifecycle(test);

import { dispatchIpcRoute, handleIpcHttpRequest } from '../core/ram-memory-mcp.mjs';
import { postCompactionArchiveBestEffort } from '../core/history-compactor.mjs';
import { RamMemoryEngine } from '../core/ram-memory-engine.mjs';
import {
  ALLOWED_STATE_KEYS,
  DEFAULT_STATE,
  collectTelemetry,
  mergeRamSavingsIntoTelemetry,
  parseLoopbackHostPort,
  probeLoopbackTcpPort,
  sanitizeStatePatch,
  startSidecarHostWatchdog,
} from '../sidecars/panel/server.mjs';
import { postRamDaemonJson } from '../sidecars/panel/lib/panel-state-skills.mjs';

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

test('1. IPC /hook/memo-check + /hook/memo-record + retry-bypass + /hook/post-edit invalidation', async () => {
  const wsDir = makeTempDir('amr-broker-memo-');
  const targetFile = path.join(wsDir, 'sample.mjs');
  fs.writeFileSync(targetFile, 'export const alpha = 1;\nexport const beta = 2;\n', 'utf8');

  const testEngine = new RamMemoryEngine({ budgetMb: 512 });
  await testEngine.warmWorkspaceAsync(wsDir);

  const server = http.createServer((req, res) =>
    handleIpcHttpRequest(req, res, {
      skipAuth: true,
      engine: testEngine,
      settings: { enabled: true, budgetMb: 512, autoWarm: false, ramSotaEngines: true, gpuWarmHostRamCache: true },
    })
  );

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();

  try {
    const baseReq = {
      convoId: 'convo-memo-1',
      epoch: 0,
      toolName: 'run_command',
      targetKey: 'node --test sample.mjs',
      stepIdx: 4,
    };

    // Initial check -> miss
    const check1 = await postJson(port, '/hook/memo-check', { ...baseReq, currentSha1: 'sha1abc123' });
    assert.equal(check1.status, 200);
    assert.equal(check1.body.ok, true);
    assert.equal(check1.body.hit, false);

    // Record observation
    const rec = await postJson(port, '/hook/memo-record', {
      ...baseReq,
      contentSha1: 'sha1abc123',
      charLen: 1400,
      fileDeps: ['sample.mjs'],
    });
    assert.equal(rec.status, 200);
    assert.equal(rec.body.ok, true);

    // Next check (different stepIdx) -> hit with memoNotice
    const check2 = await postJson(port, '/hook/memo-check', { ...baseReq, stepIdx: 5, currentSha1: 'sha1abc123' });
    assert.equal(check2.body.ok, true);
    assert.equal(check2.body.hit, true);
    assert.match(check2.body.memoNotice, /RAM Context Memo/);
    assert.match(check2.body.memoNotice, /sha1abc1/);

    // Immediate re-call in same stepIdx -> zero-deadlock retryBypass
    const check3 = await postJson(port, '/hook/memo-check', { ...baseReq, stepIdx: 5, currentSha1: 'sha1abc123' });
    assert.equal(check3.body.ok, true);
    assert.equal(check3.body.hit, false);
    assert.equal(check3.body.retryBypass, true);

    // Re-record and verify /hook/post-edit invalidates memoized observation touching sample.mjs
    await postJson(port, '/hook/memo-record', {
      ...baseReq,
      contentSha1: 'sha1abc123',
      charLen: 1400,
      fileDeps: ['sample.mjs'],
    });
    const postEdit = await postJson(port, '/hook/post-edit', {
      wsPath: wsDir,
      filePath: targetFile,
    });
    assert.equal(postEdit.body.ok, true);

    const checkAfterEdit = await postJson(port, '/hook/memo-check', { ...baseReq, stepIdx: 7, currentSha1: 'sha1abc123' });
    assert.equal(checkAfterEdit.body.hit, false);
    assert.equal(checkAfterEdit.body.retryBypass, false);
  } finally {
    try { testEngine.close(); } catch {}
    await new Promise((res) => server.close(() => res()));
    fs.rmSync(wsDir, { recursive: true, force: true });
  }
});

test('2. IPC /hook/compaction-archive + /hook/pre-invocation RepairKV recall (fallback and engine hook)', async () => {
  const wsDir = makeTempDir('amr-broker-repair-');
  const codeFile = path.join(wsDir, 'auth-service.mjs');
  fs.writeFileSync(
    codeFile,
    'export function verifyJwtToken(token) {\n  if (!token) throw new Error("Missing token");\n  return token.split(".");\n}\n',
    'utf8'
  );

  const testEngine = new RamMemoryEngine({ budgetMb: 512 });
  await testEngine.warmWorkspaceAsync(wsDir);
  const settings = { enabled: true, budgetMb: 512, autoWarm: false, ramSotaEngines: true, gpuWarmHostRamCache: true };

  try {
    // Archive compaction facts via fallback Map
    const archiveRes = await dispatchIpcRoute(
      'POST',
      '/hook/compaction-archive',
      {
        convoId: 'convo-repair-1',
        wsPath: wsDir,
        rawText: '- Fixed verifyJwtToken crash when authorization header lacks Bearer prefix\n- Root cause: null token split in auth-service.mjs',
      },
      { engine: testEngine, settings }
    );
    assert.equal(archiveRes.status, 200);
    assert.equal(archiveRes.body.ok, true);
    assert.equal(archiveRes.body.archived, true);

    // Pre-invocation recalls RepairKV hint and appends to goldContextHint
    const preRes = await dispatchIpcRoute(
      'POST',
      '/hook/pre-invocation',
      {
        convoId: 'convo-repair-1',
        epoch: 1,
        wsPath: wsDir,
        query: 'verifyJwtToken authorization header error',
        includeSemantic: false,
      },
      { engine: testEngine, settings }
    );
    assert.equal(preRes.status, 200);
    assert.equal(preRes.body.ok, true);
    assert.match(preRes.body.repairKvHint, /RAM RepairKV Recall/);
    assert.match(preRes.body.repairKvHint, /verifyJwtToken/);
    assert.ok(preRes.body.goldContextHint.includes(preRes.body.repairKvHint));

    // Also verify loose-coupled engine method delegation when methods exist on engine
    let customPrefetchCalled = false;
    let customInvalidated = false;
    const mockSotaEngine = Object.assign(Object.create(Object.getPrototypeOf(testEngine)), testEngine, {
      recallCompactionFacts: async () => ({ recalled: ['custom'], formattedHint: '🔧 [RAM RepairKV Recall] Custom engine recall' }),
      invalidateObservationFile: () => { customInvalidated = true; },
      scheduleSpeculativePrefetch: () => { customPrefetchCalled = true; },
    });

    const preCustom = await dispatchIpcRoute(
      'POST',
      '/hook/pre-invocation',
      { convoId: 'c2', wsPath: wsDir, query: 'verifyJwtToken', includeSemantic: false },
      { engine: mockSotaEngine, settings }
    );
    assert.equal(preCustom.body.repairKvHint, '🔧 [RAM RepairKV Recall] Custom engine recall');

    await dispatchIpcRoute(
      'POST',
      '/hook/post-edit',
      { wsPath: wsDir, filePath: codeFile },
      { engine: mockSotaEngine, settings }
    );
    assert.equal(customInvalidated, true);
    assert.equal(customPrefetchCalled, true);

    // Best-effort compaction archive never throws when daemon offline or text empty
    const noOpArchive = await postCompactionArchiveBestEffort({ convoId: 'none', rawText: '' });
    assert.equal(noOpArchive, false);
  } finally {
    testEngine.evict('all');
    fs.rmSync(wsDir, { recursive: true, force: true });
  }
});

test('3. Server state sanitization, token savings aggregation, router-state.json & UI toggles', () => {
  assert.equal(DEFAULT_STATE.ramSotaEngines, true);
  assert.equal(DEFAULT_STATE.gpuWarmHostRamCache, true);
  assert.equal(ALLOWED_STATE_KEYS.has('ramSotaEngines'), true);
  assert.equal(ALLOWED_STATE_KEYS.has('gpuWarmHostRamCache'), true);

  const sanitized = sanitizeStatePatch({ ramSotaEngines: false, gpuWarmHostRamCache: true });
  assert.deepEqual(sanitized, { ramSotaEngines: false, gpuWarmHostRamCache: true });

  // Token-savings aggregation includes ramStats.savedTokensEstimate / ramStats.sota.savedTokensEstimate
  const baseTel = collectTelemetry(120000, { skipGlobalGpuTelemetry: true });
  const withSotaTel = collectTelemetry(120000, {
    skipGlobalGpuTelemetry: true,
    ramStats: { savedTokensEstimate: 4200, sota: { savedTokensEstimate: 4200 } },
  });
  assert.equal(withSotaTel.ramSavedTokens, baseTel.ramSavedTokens + 4200);
  assert.equal(withSotaTel.totalSavedTokens, baseTel.totalSavedTokens + 4200);
  assert.equal(withSotaTel.savingsBreakdown.ram, withSotaTel.ramSavedTokens);

  const merged = mergeRamSavingsIntoTelemetry(
    {
      cacheSavedTokens: 100,
      ramSavedTokens: 500,
      cpuSavedTokens: 50,
      gpuSavedTokens: 25,
      totalSavedTokens: 575,
      savingsBreakdown: { ram: 500, cpu: 50, gpu: 25 },
    },
    { sota: { savedTokensEstimate: 300 } }
  );
  assert.equal(merged.ramSavedTokens, 800);
  assert.equal(merged.totalSavedTokens, 875);
  assert.equal(merged.savingsBreakdown.ram, 800);

  // router-state.json defaults
  const routerState = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'router-state.json'), 'utf8'));
  assert.equal(routerState.ramMaxBudgetMb, DEFAULT_STATE.ramMaxBudgetMb);
  assert.equal(routerState.ramSotaEngines, true);
  assert.equal(routerState.gpuWarmHostRamCache, true);

  // UI HTML preserves CPU SOTA toggle and adds both RAM/GPU toggles & live op labels
  const uiHtml = fs.readFileSync(path.join(ROOT_DIR, 'sidecars', 'panel', 'ui.html'), 'utf8');
  assert.match(uiHtml, /id="chk-cpuSotaEngines"[^>]*data-key="cpuSotaEngines"/);
  assert.match(uiHtml, /id="chk-ramSotaEngines"[^>]*data-key="ramSotaEngines"/);
  assert.match(uiHtml, /id="chk-gpuWarmHostRamCache"[^>]*data-key="gpuWarmHostRamCache"/);
  assert.match(uiHtml, /speculative_prefetch:\s*'Спекулятивный префетч'/);
  assert.match(uiHtml, /repair_kv:\s*'Память RepairKV'/);
  assert.match(uiHtml, /memo_hit:\s*'Мемоизация ACON'/);
  assert.match(uiHtml, /Мемо\/RepairKV: \+/);
});

test('4. Sidecar host watchdog: parses loopback LS endpoints, probes TCP, and exits cleanly when host or parent dies', async () => {
  // 1) Endpoint parsing & loopback SSRF guard
  assert.deepEqual(parseLoopbackHostPort('127.0.0.1:49394'), { host: '127.0.0.1', port: 49394 });
  assert.deepEqual(parseLoopbackHostPort('http://localhost:54756/'), { host: 'localhost', port: 54756 });
  assert.deepEqual(parseLoopbackHostPort('https://[::1]:8443'), { host: '::1', port: 8443 });
  assert.equal(parseLoopbackHostPort('0.0.0.0:8080'), null);
  assert.equal(parseLoopbackHostPort('example.com:443'), null);
  assert.equal(parseLoopbackHostPort('/var/run/ls.sock'), null);
  assert.equal(parseLoopbackHostPort(''), null);

  // 2) Real ephemeral loopback TCP probe (open -> true, closed -> false)
  const srv = net.createServer();
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  const { port } = srv.address();
  try {
    assert.equal(await probeLoopbackTcpPort('127.0.0.1', port, 800), true);
  } finally {
    await new Promise((res) => srv.close(res));
  }
  assert.equal(await probeLoopbackTcpPort('127.0.0.1', port, 800), false);

  // 3) Parent PID death triggers immediate host-lost callback
  let parentLostReason = '';
  let parentAlive = true;
  const parentWatchdog = startSidecarHostWatchdog({
    lsAddress: '',
    initialPpid: 4242,
    getCurrentPpidFn: () => 4242,
    isPidAliveFn: () => parentAlive,
    intervalMs: 60000,
    warmupDelayMs: -1,
    onHostLost: (reason) => { parentLostReason = reason; },
  });
  try {
    assert.equal((await parentWatchdog.checkOnce()).alive, true);
    parentAlive = false;
    const deadParentRes = await parentWatchdog.checkOnce();
    assert.equal(deadParentRes.alive, false);
    assert.equal(deadParentRes.reason, 'parent_dead');
    assert.equal(parentLostReason, 'parent_dead');
    assert.equal(parentWatchdog.getState().stopped, true);
  } finally {
    parentWatchdog.stop();
  }

  // 4) Windows cmd.exe wrapper stays alive, but LS TCP dies -> triggers after maxConsecutiveFailures
  let lsUp = true;
  let lsLostReason = '';
  const lsWatchdog = startSidecarHostWatchdog({
    lsAddress: '127.0.0.1:49394',
    initialPpid: 9999,
    getCurrentPpidFn: () => 9999,
    isPidAliveFn: () => true,
    probeTcpFn: async () => lsUp,
    intervalMs: 60000,
    warmupDelayMs: -1,
    maxConsecutiveFailures: 2,
    onHostLost: (reason) => { lsLostReason = reason; },
  });
  try {
    assert.equal((await lsWatchdog.checkOnce()).reason, 'ls_tcp_ok');
    assert.equal(lsWatchdog.getState().lsEverReachable, true);
    lsUp = false;
    const retry1 = await lsWatchdog.checkOnce();
    assert.equal(retry1.alive, true);
    assert.equal(retry1.reason, 'ls_probe_retry');
    assert.equal(lsLostReason, '');
    const retry2 = await lsWatchdog.checkOnce();
    assert.equal(retry2.alive, false);
    assert.equal(retry2.reason, 'ls_unreachable');
    assert.equal(lsLostReason, 'ls_unreachable');
  } finally {
    lsWatchdog.stop();
  }

  // 5) Never-seen-reachable LS tolerates 2 misses and triggers on 3rd
  let neverLostReason = '';
  const neverWatchdog = startSidecarHostWatchdog({
    lsAddress: '127.0.0.1:49395',
    initialPpid: 9998,
    getCurrentPpidFn: () => 9998,
    isPidAliveFn: () => true,
    probeTcpFn: async () => false,
    intervalMs: 60000,
    warmupDelayMs: -1,
    maxConsecutiveFailures: 2,
    onHostLost: (reason) => { neverLostReason = reason; },
  });
  try {
    assert.equal((await neverWatchdog.checkOnce()).alive, true);
    assert.equal((await neverWatchdog.checkOnce()).alive, true);
    assert.equal(neverLostReason, '');
    const fail3 = await neverWatchdog.checkOnce();
    assert.equal(fail3.alive, false);
    assert.equal(neverLostReason, 'ls_unreachable');
  } finally {
    neverWatchdog.stop();
  }
});

test('6. IPC /gpu/chat client disconnect abort & postRamDaemonJson signal/stopOnResponse', async () => {
  const tmpWs = makeTempDir('tunnel-gpu-abort-');
  fs.writeFileSync(path.join(tmpWs, 'index.mjs'), 'export const ping = () => 1;\n', 'utf8');

  let observedSignal = null;
  let chatFinished = false;
  const engine = new RamMemoryEngine({ budgetMb: 64 });
  await engine.warmWorkspaceAsync(tmpWs, { startWatcher: false });

  const server = http.createServer((req, res) =>
    handleIpcHttpRequest(req, res, {
      skipAuth: true,
      engine,
      runLocalProjectChatFn: ({ signal }) =>
        new Promise((resolve) => {
          observedSignal = signal;
          const finish = (val) => {
            chatFinished = true;
            resolve(val);
          };
          if (signal?.aborted) return finish({ ok: false, aborted: true, answer: '' });
          signal?.addEventListener('abort', () => finish({ ok: false, aborted: true, answer: '' }), { once: true });
          const t = setTimeout(() => finish({ ok: true, answer: 'too-late' }), 2000);
          if (typeof t.unref === 'function') t.unref();
        }),
    })
  );

  let d1Hits = 0;
  let d2Hits = 0;
  let d1ClosedEarly = false;
  const daemon1 = http.createServer((req, res) => {
    d1Hits += 1;
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (d1Hits === 1) {
        res.on('close', () => {
          if (!res.writableEnded) d1ClosedEarly = true;
        });
        const t = setTimeout(() => {
          if (!res.destroyed && !res.writableEnded) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, answer: 'late' }));
          }
        }, 1500);
        if (typeof t.unref === 'function') t.unref();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, answer: '', error: 'Ollama down' }));
    });
  });
  const daemon2 = http.createServer((req, res) => {
    d2Hits += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, answer: 'should-not-run' }));
  });

  try {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    await new Promise((r) => daemon1.listen(0, '127.0.0.1', r));
    await new Promise((r) => daemon2.listen(0, '127.0.0.1', r));

    // 6a) Disconnecting HTTP client on /gpu/chat must abort signal inside runLocalProjectChatFn
    const payload = JSON.stringify({ wsPath: tmpWs, query: 'ping' });
    await new Promise((resolveDone) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: server.address().port,
        path: '/gpu/chat',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      });
      req.on('error', () => {});
      req.write(payload);
      req.end(() => {
        setTimeout(() => {
          try { req.destroy(); } catch {}
          resolveDone();
        }, 35);
      });
    });

    for (let i = 0; i < 40 && !chatFinished; i++) {
      await new Promise((r) => setTimeout(r, 15));
    }
    assert.ok(observedSignal, 'runLocalProjectChatFn must receive AbortSignal');
    assert.equal(observedSignal.aborted, true, 'Disconnecting client must abort /gpu/chat signal');

    // 6b) postRamDaemonJson with AbortSignal stops immediately and never falls through to daemon2
    const candidates = [
      { pid: process.pid, port: daemon1.address().port, token: 't1' },
      { pid: process.pid, port: daemon2.address().port, token: 't2' },
    ];
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 35);
    const abortRes = await postRamDaemonJson('/gpu/chat', { query: 'test' }, 5000, {
      signal: ac.signal,
      stopOnResponse: true,
      candidates,
    });
    clearTimeout(timer);
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(abortRes?.aborted, true);
    assert.equal(d1Hits, 1);
    assert.equal(d2Hits, 0, 'Aborted postRamDaemonJson must not query second daemon');
    assert.equal(d1ClosedEarly, true, 'Aborted postRamDaemonJson must destroy daemon socket');

    // 6c) stopOnResponse:true prevents retrying second daemon when first daemon returns structured error
    const errRes = await postRamDaemonJson('/gpu/chat', { query: 'test' }, 5000, {
      stopOnResponse: true,
      candidates,
    });
    assert.equal(errRes?.ok, false);
    assert.equal(errRes?.error, 'Ollama down');
    assert.equal(d2Hits, 0, 'stopOnResponse must not retry second daemon on structured ok:false');
  } finally {
    try { engine.evict('all'); } catch {}
    try { server.closeAllConnections?.(); server.close(); } catch {}
    try { daemon1.closeAllConnections?.(); daemon1.close(); } catch {}
    try { daemon2.closeAllConnections?.(); daemon2.close(); } catch {}
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
});

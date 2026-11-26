import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.TUNNEL_TEST_ISOLATE_INSTALLED = '1';
delete process.env.ANTIGRAVITY_LS_ADDRESS;
delete process.env.ANTIGRAVITY_CSRF_TOKEN;
delete process.env.ANTIGRAVITY_AGENTAPI_EXE;

import {
  DEFAULT_STATE,
  loadState,
  startSidecarPanel,
} from '../sidecars/panel/server.mjs';
import {
  STALE_BG_TASK_TTL_MS,
  STALE_DAEMON_BG_TASK_TTL_MS,
  filterVisibleBackgroundTasks,
} from '../core/task-progress.mjs';
import { inspectTranscriptTurnState } from '../core/progress/progress-parsers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');

function findBrowserExecutable() {
  const candidates = [
    process.env.CDP_BROWSER_PATH,
    process.env.CHROME_PATH,
    process.env.EDGE_PATH,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function createTestSidecarAppClass() {
  return class TestSidecarApp {
    constructor() {
      this._pages = new Map();
      this._apis = new Map();
      this._server = null;
      this.apiLogs = [];
    }

    page(p, handler) {
      this._pages.set(p, handler);
    }

    api(p, handler, method = 'POST') {
      if (!this._apis.has(p)) this._apis.set(p, new Map());
      this._apis.get(p).set(method.toUpperCase(), handler);
    }

    get server() {
      return this._server;
    }

    get port() {
      return this._server?.address()?.port || 0;
    }

    run() {
      const server = http.createServer(async (req, res) => {
        const t0 = performance.now();
        const u = new URL(req.url || '/', 'http://127.0.0.1');
        if (req.method === 'GET' && u.pathname === '/preload.js') {
          res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
          res.end('/* test preload stub */');
          return;
        }
        if (req.method === 'GET' && this._pages.has(u.pathname)) {
          const r = await this._pages.get(u.pathname)();
          res.writeHead(r?.status || 200, {
            'Content-Type': r?.contentType || 'text/html; charset=utf-8',
            ...(r?.headers || {}),
          });
          res.end(r?.body ?? String(r || ''));
          return;
        }
        if (this._apis.has(u.pathname)) {
          const handler = this._apis.get(u.pathname).get(req.method);
          if (!handler) {
            res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: 'Method Not Allowed' }));
            return;
          }
          let body = '';
          req.on('data', (chunk) => { body += chunk; });
          req.on('end', async () => {
            try {
              const data = {};
              for (const [k, v] of u.searchParams.entries()) {
                if (k.toLowerCase() !== 'token') data[k] = v;
              }
              if (body) Object.assign(data, JSON.parse(body));
              const result = await handler(data, req);
              const payloadStr = result && typeof result === 'object' && result.contentType && result.body !== undefined
                ? String(result.body)
                : JSON.stringify(result);
              this.apiLogs.push({
                method: req.method,
                path: u.pathname,
                fastHeader: req.headers['x-panel-fast-update'] || '',
                ms: +(performance.now() - t0).toFixed(1),
                bytes: Buffer.byteLength(payloadStr, 'utf8'),
              });
              if (result && typeof result === 'object' && result.contentType && result.body !== undefined) {
                res.writeHead(result.status || 200, {
                  'Content-Type': result.contentType,
                  ...(result.headers || {}),
                });
                res.end(result.body);
                return;
              }
              const httpCode = typeof result?.status === 'number' ? result.status : 200;
              res.writeHead(httpCode, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(payloadStr);
            } catch (err) {
              res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ ok: false, error: err?.message || 'Internal Error' }));
            }
          });
          return;
        }
        res.writeHead(404);
        res.end('Not found');
      });
      this._server = server;
      return new Promise((resolveListen) => {
        server.listen(0, '127.0.0.1', () => resolveListen(server));
      });
    }

    close() {
      const srv = this._server;
      this._server = null;
      if (!srv) return Promise.resolve();
      if (typeof srv.closeAllConnections === 'function') {
        try { srv.closeAllConnections(); } catch {}
      }
      return new Promise((resolveClose) => {
        srv.close(() => resolveClose());
      });
    }
  };
}

function killBrowserProcess(proc) {
  if (!proc) return;
  try {
    if (!proc.killed) proc.kill('SIGKILL');
  } catch {}
  if (process.platform === 'win32' && proc.pid) {
    try {
      execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], {
        stdio: 'ignore',
        timeout: 5000,
      });
    } catch {}
  }
}

async function launchHeadlessBrowser(browserExe, userDataDir) {
  const proc = spawn(browserExe, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=0',
    '--window-size=340,780',
    `--user-data-dir=${userDataDir}`,
    'about:blank',
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const cdpPort = await new Promise((resolvePort, rejectPort) => {
    let logs = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      rejectPort(new Error(`Timed out waiting for DevTools URL:\n${logs}`));
    }, 15000);
    const onData = (chunk) => {
      if (settled) return;
      logs += chunk.toString('utf8');
      const m = logs.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//i);
      if (m) {
        settled = true;
        clearTimeout(timer);
        resolvePort(Number(m[1]));
      }
    };
    proc.stderr?.on('data', onData);
    proc.stdout?.on('data', onData);
    proc.once('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPort(new Error(`Browser exited early (${code}):\n${logs}`));
    });
  });

  let pageWsUrl = null;
  for (let i = 0; i < 50 && !pageWsUrl; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
      if (res.ok) {
        const targets = await res.json();
        const page = Array.isArray(targets) ? targets.find((item) => item?.type === 'page' && item?.webSocketDebuggerUrl) : null;
        if (page) {
          pageWsUrl = page.webSocketDebuggerUrl;
          break;
        }
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 80));
  }
  if (!pageWsUrl) {
    killBrowserProcess(proc);
    throw new Error('Could not discover CDP page webSocketDebuggerUrl');
  }
  return { proc, pageWsUrl };
}

async function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolveOpen, rejectOpen) => {
    const timer = setTimeout(() => rejectOpen(new Error('CDP connect timeout')), 10000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolveOpen(); }, { once: true });
    ws.addEventListener('error', (err) => { clearTimeout(timer); rejectOpen(err?.error || new Error('CDP ws error')); }, { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  const consoleErrors = [];
  const pageErrors = [];

  ws.addEventListener('message', (event) => {
    let msg;
    try { msg = JSON.parse(String(event.data)); } catch { return; }
    if (typeof msg.id === 'number' && pending.has(msg.id)) {
      const entry = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) entry.reject(new Error(`CDP ${entry.method}: ${msg.error.message}`));
      else entry.resolve(msg.result || {});
      return;
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
      consoleErrors.push((msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const ex = msg.params?.exceptionDetails;
      pageErrors.push(ex?.exception?.description || ex?.text || 'Uncaught exception');
    }
  });

  function send(method, params = {}, timeoutMs = 15000) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP ${method} timed out`));
      }, timeoutMs);
      pending.set(id, { method, resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async function evaluate(fn, ...args) {
    const expression = typeof fn === 'function'
      ? `(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(',')})`
      : String(fn);
    const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'evaluate failed');
    }
    return res.result?.value;
  }

  return { send, evaluate, consoleErrors, pageErrors, close: () => { try { ws.close(); } catch {} } };
}

test('1. Stale background tasks TTL auto-cancels hanging non-daemon & expired daemon tasks', () => {
  const now = Date.now();
  const visible = filterVisibleBackgroundTasks([
    {
      taskId: 'stale-non-daemon',
      label: 'Hanging command',
      status: 'running',
      isDaemon: false,
      startedAt: now - (STALE_BG_TASK_TTL_MS + 120_000),
      updatedAt: now - (STALE_BG_TASK_TTL_MS + 60_000),
    },
    {
      taskId: 'fresh-non-daemon',
      label: 'Active build',
      status: 'running',
      isDaemon: false,
      startedAt: now - 30_000,
      updatedAt: now - 15_000,
    },
    {
      taskId: 'active-daemon',
      label: 'Dev server',
      status: 'running',
      isDaemon: true,
      startedAt: now - 30 * 60 * 1000,
      updatedAt: now - 30 * 60 * 1000,
    },
    {
      taskId: 'expired-daemon',
      label: 'Forgotten server',
      status: 'running',
      isDaemon: true,
      startedAt: now - (STALE_DAEMON_BG_TASK_TTL_MS + 3600_000),
      updatedAt: now - (STALE_DAEMON_BG_TASK_TTL_MS + 600_000),
    },
  ], { now, chatUpdatedAt: now - (STALE_DAEMON_BG_TASK_TTL_MS + 600_000) });

  assert.deepEqual(
    visible.map((t) => t.taskId),
    ['fresh-non-daemon', 'active-daemon'],
    'Stale non-daemon (>10m) and expired daemon (>6h) must be auto-cancelled and filtered out'
  );

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-stale-bg-'));
  try {
    const staleLog = path.join(tmpDir, 'transcript.jsonl');
    const oldIso = new Date(now - (STALE_BG_TASK_TTL_MS + 300_000)).toISOString();
    const freshIso = new Date(now - 20_000).toISOString();
    fs.writeFileSync(
      staleLog,
      [
        JSON.stringify({ step_index: 1, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: oldIso, content: 'Run check' }),
        JSON.stringify({
          step_index: 2,
          type: 'GENERIC',
          status: 'RUNNING',
          created_at: oldIso,
          content: 'Tool is running as a background task with task id: bg-hang-1\nTask Description: node hang.mjs',
        }),
        JSON.stringify({
          step_index: 3,
          type: 'GENERIC',
          status: 'RUNNING',
          created_at: freshIso,
          content: 'Tool is running as a background task with task id: bg-fresh-1\nTask Description: node fresh.mjs',
        }),
      ].join('\n') + '\n',
      'utf8'
    );

    const parsed = inspectTranscriptTurnState(staleLog, now);
    const hangTask = parsed.backgroundTasks.find((t) => t.taskId === 'bg-hang-1');
    const freshTask = parsed.backgroundTasks.find((t) => t.taskId === 'bg-fresh-1');
    assert.equal(hangTask?.status, 'cancelled', 'Old hanging non-daemon task must expire to cancelled even in active chat');
    assert.equal(freshTask?.status, 'running', 'Fresh running task must remain running');

    // Also test stale daemon when both transcript mtime and task timestamps are >6h old
    const staleDaemonLog = path.join(tmpDir, 'daemon-transcript.jsonl');
    const ancientIso = new Date(now - (STALE_DAEMON_BG_TASK_TTL_MS + 600_000)).toISOString();
    fs.writeFileSync(
      staleDaemonLog,
      [
        JSON.stringify({
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          created_at: ancientIso,
          tool_calls: [{ name: 'run_command', args: { CommandLine: 'npm run dev', IsDaemon: true } }],
        }),
        JSON.stringify({
          step_index: 2,
          type: 'GENERIC',
          status: 'RUNNING',
          created_at: ancientIso,
          content: 'Tool is running as a background task with task id: bg-daemon-old\nTask Description: npm run dev',
        }),
      ].join('\n') + '\n',
      'utf8'
    );
    const oldTime = new Date(now - (STALE_DAEMON_BG_TASK_TTL_MS + 600_000));
    fs.utimesSync(staleDaemonLog, oldTime, oldTime);

    const parsedDaemon = inspectTranscriptTurnState(staleDaemonLog, now);
    assert.equal(parsedDaemon.hasRunningBackgroundTask, false);
    assert.equal(parsedDaemon.backgroundTasks[0]?.status, 'cancelled');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 }); } catch {}
  }
});

test('2. POST /api/update fast path returns compact state quickly while preserving full fallback', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-fast-update-'));
  const prevStateEnv = process.env.TUNNEL_TEST_STATE_PATH;
  const statePath = path.join(tmpDir, 'router-state.json');
  fs.writeFileSync(statePath, JSON.stringify({ ...DEFAULT_STATE, onboardingCompleted: true, hardwareProfiled: true }, null, 2));
  process.env.TUNNEL_TEST_STATE_PATH = statePath;

  const TestSidecarApp = createTestSidecarAppClass();
  const app = await startSidecarPanel({ port: 0, SidecarAppClass: TestSidecarApp });
  try {
    const baseUrl = `http://127.0.0.1:${app.port}`;
    const headersBase = {
      'Content-Type': 'application/json',
      'X-Router-Panel': 'antigravity-v38',
    };

    const tFast0 = performance.now();
    const fastRes = await fetch(`${baseUrl}/api/update`, {
      method: 'POST',
      headers: { ...headersBase, 'x-panel-fast-update': '1' },
      body: JSON.stringify({ showBadge: false }),
    });
    const fastText = await fastRes.text();
    const fastMs = performance.now() - tFast0;
    const fastJson = JSON.parse(fastText);

    assert.equal(fastRes.status, 200);
    assert.equal(fastJson.ok, true);
    assert.equal(fastJson.fast, true);
    assert.equal(fastJson.state.showBadge, false);
    assert.equal(loadState().showBadge, false);
    assert.equal(fastJson.telemetry, undefined, 'Fast path must skip heavy telemetry collectors');
    assert.equal(fastJson.skills, undefined, 'Fast path must skip skills discovery');
    assert.equal(fastJson.checkpoints, undefined, 'Fast path must skip checkpoints scan');
    assert.ok(Buffer.byteLength(fastText, 'utf8') < 15 * 1024, `Fast payload too large: ${Buffer.byteLength(fastText, 'utf8')} bytes`);
    assert.ok(fastMs < 250, `Fast update took ${fastMs.toFixed(1)}ms, expected < 250ms`);

    const queryFastRes = await fetch(`${baseUrl}/api/update?fast=1`, {
      method: 'POST',
      headers: headersBase,
      body: JSON.stringify({ showBadge: true }),
    });
    const queryFastJson = await queryFastRes.json();
    assert.equal(queryFastJson.fast, true);
    assert.equal(loadState().showBadge, true);

    const fullRes = await fetch(`${baseUrl}/api/update`, {
      method: 'POST',
      headers: headersBase,
      body: JSON.stringify({ confirmThreshold: 'L' }),
    });
    const fullJson = await fullRes.json();
    assert.equal(fullRes.status, 200);
    assert.equal(fullJson.fast, undefined);
    assert.equal(fullJson.state.confirmThreshold, 'L');
    assert.ok(fullJson.telemetry && Array.isArray(fullJson.skills) && Array.isArray(fullJson.checkpoints), 'Full update must retain all legacy fields');
  } finally {
    await app.close();
    if (prevStateEnv === undefined) delete process.env.TUNNEL_TEST_STATE_PATH;
    else process.env.TUNNEL_TEST_STATE_PATH = prevStateEnv;
    try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 }); } catch {}
  }
});

test('3. Real Headless CDP: HUD swarm badge, 4-item bg preview cap, EN statusPill i18n, fast checkbox click & churn', { timeout: 60000 }, async (t) => {
  const browserExe = findBrowserExecutable();
  if (!browserExe) {
    t.skip('No Chromium/Edge executable found on this host');
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-cdp-audit-'));
  const prevStateEnv = process.env.TUNNEL_TEST_STATE_PATH;
  const statePath = path.join(tmpDir, 'router-state.json');
  fs.writeFileSync(statePath, JSON.stringify({
    ...DEFAULT_STATE,
    onboardingCompleted: true,
    hardwareProfiled: true,
    subscriptionTier: 'ultra',
    panelViewMode: 'full',
    uiLanguage: 'ru',
    panelCollapsedCards: {},
    panelOpenSpoilers: {},
  }, null, 2));
  process.env.TUNNEL_TEST_STATE_PATH = statePath;

  const TestSidecarApp = createTestSidecarAppClass();
  let app = null;
  let browserProc = null;
  let cdp = null;

  try {
    app = await startSidecarPanel({ port: 0, SidecarAppClass: TestSidecarApp });
    const originUrl = `http://127.0.0.1:${app.port}`;
    const launched = await launchHeadlessBrowser(browserExe, path.join(tmpDir, 'profile'));
    browserProc = launched.proc;
    cdp = await connectCdp(launched.pageWsUrl);

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 340, height: 780, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.navigate', { url: `${originUrl}/` });

    await cdp.evaluate(async () => {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const ver = document.getElementById('footerPluginVersion')?.textContent || '';
        const bodyTheme = document.body?.getAttribute('data-panel-theme') || '';
        if (typeof currentState !== 'undefined' && currentState && /\bv\d+\./.test(ver) && bodyTheme) return true;
        await new Promise((r) => setTimeout(r, 40));
      }
      throw new Error('Timed out waiting for hydration');
    });

    // Click checkbox and confirm fast update header was sent & persisted
    const beforeShowBadge = Boolean(loadState().showBadge);
    await cdp.evaluate(() => {
      document.getElementById('chk-showBadge')?.click();
    });
    for (let i = 0; i < 30; i++) {
      if (Boolean(loadState().showBadge) === !beforeShowBadge) break;
      await new Promise((r) => setTimeout(r, 40));
    }
    assert.equal(Boolean(loadState().showBadge), !beforeShowBadge, 'Checkbox click must persist via fast /api/update');
    assert.ok(app.apiLogs.some((l) => l.path === '/api/update' && l.fastHeader === '1'), 'UI updateState must send x-panel-fast-update: 1');

    // Switch RU -> EN and assert #statusPill has zero Cyrillic leaks immediately
    const enStatusPill = await cdp.evaluate(async () => {
      document.querySelector('[data-action="setUiLanguage"][data-arg="en"]')?.click();
      await new Promise((r) => setTimeout(r, 80));
      return document.getElementById('statusPill')?.textContent || '';
    });
    assert.equal(/[А-Яа-яЁё]/.test(enStatusPill), false, `EN #statusPill leaked Cyrillic: "${enStatusPill}"`);

    // Switch back to RU and verify HUD Swarm badge, 4-item preview cap, churn & overflow
    const hudRes = await cdp.evaluate(async () => {
      document.querySelector('[data-action="setUiLanguage"][data-arg="ru"]')?.click();
      await new Promise((r) => setTimeout(r, 120));

      const now = Date.now();
      const payload = {
        status: 'running',
        activeChats: [{
          conversationId: 'cdp-chat-1',
          chatNumber: 1,
          projectName: 'antigravity-model-router',
          workspaceRoot: 'C:\\repo\\antigravity-model-router',
          status: 'running',
          percent: 60,
          stepTitle: 'Аудит',
          subagents: [
            { conversationId: 'sub-a', subagentNumber: 1, agentKind: 'subagent', roleLabel: 'Scout', status: 'running', percent: 40 },
            { conversationId: 'sub-b', subagentNumber: 2, agentKind: 'swarm_worker', roleLabel: 'Coder', status: 'running', percent: 70 },
          ],
          backgroundTasksTotalCount: 10,
          backgroundTasksCount: 2,
          backgroundTasks: Array.from({ length: 10 }, (_, idx) => ({
            id: `t-${idx}`,
            taskId: `t-${idx}`,
            label: `Task ${idx + 1}`,
            status: idx < 2 ? 'running' : 'done',
            isDaemon: idx === 0,
            startedAt: now - 10000,
            updatedAt: now - 1000,
          })),
        }],
      };

      renderTaskProgressAndHud(payload, { running: false, enabled: false });
      await new Promise((r) => setTimeout(r, 60));

      const chatEl = document.querySelector('.ag-chat-task-item[data-cid="cdp-chat-1"]');
      chatEl.querySelector('.ag-subagent-toggle-btn').click();
      chatEl.querySelector('.ag-bgtask-toggle-btn').click();
      await new Promise((r) => setTimeout(r, 80));

      const subBadges = Array.from(chatEl.querySelectorAll('.ag-subagent-badge')).map((e) => e.textContent);
      const rowsBefore = Array.from(chatEl.querySelectorAll('.ag-bgtask-item'));
      const visibleBefore = rowsBefore.filter((r) => r.offsetParent !== null && r.getAttribute('aria-hidden') === 'false').length;
      const hiddenBefore = rowsBefore.filter((r) => r.classList.contains('is-overflow-hidden') && r.getAttribute('aria-hidden') === 'true').length;

      chatEl.querySelector('[data-action="toggleBgTasksShowAll"]').click();
      await new Promise((r) => setTimeout(r, 60));
      const rowsAfter = Array.from(chatEl.querySelectorAll('.ag-bgtask-item'));
      const visibleAfter = rowsAfter.filter((r) => r.offsetParent !== null && r.getAttribute('aria-hidden') === 'false').length;

      // Rapid churn & idle teardown
      for (let i = 0; i < 30; i++) {
        renderTaskProgressAndHud({ status: 'running', activeChats: i % 2 === 0 ? payload.activeChats : [] }, { running: false, enabled: false });
      }
      renderTaskProgressAndHud({ status: 'idle', activeChats: [] }, { running: false, enabled: false });
      await new Promise((r) => setTimeout(r, 360));

      const idCounts = {};
      for (const el of document.querySelectorAll('[id]')) {
        idCounts[el.id] = (idCounts[el.id] || 0) + 1;
      }
      const dupIds = Object.entries(idCounts).filter(([, c]) => c > 1);

      return {
        subBadges,
        visibleBefore,
        hiddenBefore,
        visibleAfter,
        closingZombies: document.querySelectorAll('.ag-chat-task-item.closing').length,
        docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        dupIds,
      };
    });

    assert.deepEqual(hudRes.subBadges, ['Агент #1', 'Рой #2'], 'Swarm worker fallback badge must use Рой #2');
    assert.equal(hudRes.visibleBefore, 4, 'Background tasks drawer must cap initial visible preview at 4 rows');
    assert.equal(hudRes.hiddenBefore, 6, 'Remaining 6 rows must be overflow-hidden & aria-hidden=true');
    assert.equal(hudRes.visibleAfter, 10, 'Clicking See all must reveal all 10 rows');
    assert.equal(hudRes.closingZombies, 0, 'No closing zombie nodes after rapid churn');
    assert.equal(hudRes.docOverflow, 0, 'Zero horizontal overflow at 340px');
    assert.deepEqual(hudRes.dupIds, [], 'Zero duplicate DOM IDs');
    assert.deepEqual(cdp.consoleErrors, [], 'Zero browser console errors');
    assert.deepEqual(cdp.pageErrors, [], 'Zero uncaught page errors');
  } finally {
    if (cdp) cdp.close();
    killBrowserProcess(browserProc);
    if (app) await app.close();
    if (prevStateEnv === undefined) delete process.env.TUNNEL_TEST_STATE_PATH;
    else process.env.TUNNEL_TEST_STATE_PATH = prevStateEnv;
    try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 }); } catch {}
  }
});

test('4. Panel UI Craft 20/20, A11y controls, Composer thumb, Wizard orb SVG, and CLI --help/--version', async () => {
  const { auditUiPath } = await import('../skills/ui-ux-design-system/scripts/audit-ui.mjs');
  const uiPath = path.join(ROOT_DIR, 'sidecars', 'panel', 'ui.html');
  const craftReport = auditUiPath(uiPath);
  assert.equal(craftReport.averageScore, 20, `Expected 20/20 UI craft score, got ${craftReport.averageScore}: ${JSON.stringify(craftReport.findings)}`);
  assert.deepEqual(craftReport.findings, [], 'Expected zero UI craft findings');

  const dogfoodOut = execFileSync(
    process.execPath,
    [path.join(ROOT_DIR, 'skills', 'deep-stress-auditor', 'scripts', 'run-webapp-dogfood.mjs'), uiPath, '--json'],
    { cwd: ROOT_DIR, encoding: 'utf8', timeout: 15000 }
  );
  const dogfood = JSON.parse(dogfoodOut);
  assert.equal(dogfood.ok, true);
  assert.deepEqual(dogfood.issues || [], [], `Expected zero dogfood A11y issues, got ${JSON.stringify(dogfood.issues)}`);

  const uiHtml = fs.readFileSync(uiPath, 'utf8');
  assert.match(uiHtml, /<img\s+id="composerImageThumb"\s+src="data:image\/gif;base64,[^"]+"/);
  assert.match(uiHtml, /id="onboardingWizardModal"[\s\S]{0,300}<span class="lg-brand-orb"[^>]*><svg\b/);

  const cliHelp = execFileSync(process.execPath, [path.join(ROOT_DIR, 'core', 'router-cli.mjs'), '--help'], {
    cwd: ROOT_DIR,
    encoding: 'utf8',
    timeout: 8000,
  });
  assert.match(cliHelp, /The Tunnel v\d+\.\d+\.\d+/);
  assert.match(cliHelp, /audit-ui/);

  const cliVer = execFileSync(process.execPath, [path.join(ROOT_DIR, 'core', 'router-cli.mjs'), '--version'], {
    cwd: ROOT_DIR,
    encoding: 'utf8',
    timeout: 8000,
  });
  assert.match(cliVer.trim(), /^v\d+\.\d+\.\d+/);
});

test('5. Panel UI polish regressions: Grill-Me active/hover CSS, in-place bg task reconciliation, RAM partial-payload preservation', () => {
  const uiPath = path.join(ROOT_DIR, 'sidecars', 'panel', 'ui.html');
  const uiHtml = fs.readFileSync(uiPath, 'utf8');
  assert.match(uiHtml, /button\.win-btn:not\(\.win-btn-group > button\.win-btn\):hover:not\(:disabled\)/);
  assert.match(uiHtml, /button\.win-btn\.active,\s*button\.win-btn\[aria-pressed="true"\]/);
  assert.equal(/studio_titanium/.test(uiHtml), false, 'ui.html must not contain removed studio_titanium light theme CSS');

  const hudSrc = fs.readFileSync(path.join(ROOT_DIR, 'sidecars', 'panel', 'ui-src', 'js', '05-progress-hud.js'), 'utf8');
  assert.ok(hudSrc.includes('existingByTaskId'), 'syncBgTasksDrawerForChat must reconcile .ag-bgtask-item in-place by data-task-id');

  const cardsSrc = fs.readFileSync(path.join(ROOT_DIR, 'sidecars', 'panel', 'ui-src', 'js', '02-telemetry-cards.js'), 'utf8');
  assert.ok(cardsSrc.includes('resolvedRamForRender'), 'renderPayload must preserve last known ramCache on partial/fast updates');

  const skillsSrc = fs.readFileSync(path.join(ROOT_DIR, 'sidecars', 'panel', 'lib', 'panel-state-skills.mjs'), 'utf8');
  assert.match(skillsSrc, /timeout:\s*900\b/);

  const collectorsSrc = fs.readFileSync(path.join(ROOT_DIR, 'sidecars', 'panel', 'lib', 'panel-telemetry-collectors.mjs'), 'utf8');
  assert.ok(collectorsSrc.includes('RAM_STATUS_GRACE_MS'), 'safeGetRamCacheStatus must guard against transient /health timeouts');
});

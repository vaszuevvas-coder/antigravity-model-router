import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { knowledgeHub } from '../core/sqlite-knowledge-hub.mjs';
import { updateJsonAtomicSync, withFileLockSync } from '../core/safe-json.mjs';
import { detectWorkspaceFastLinter, runFastLinterPrecheck } from '../core/auto-verifier.mjs';
import { getActiveSidecarRequest, validateRequestOrigin } from '../sidecars/panel/lib/panel-security.mjs';
import { loadState, sanitizeStatePatch, startSidecarPanel } from '../sidecars/panel/server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createMiniSidecarAppClass() {
  return class MiniSidecarApp {
    constructor() {
      this._routes = new Map();
      this._server = null;
    }
    page() {}
    api(p, handler, method = 'POST') {
      if (!this._routes.has(p)) this._routes.set(p, new Map());
      this._routes.get(p).set(method.toUpperCase(), handler);
    }
    run() {
      this._server = http.createServer();
      return this._server;
    }
    close() {
      const srv = this._server;
      this._server = null;
      if (!srv) return Promise.resolve();
      return new Promise((resolve) => srv.close(() => resolve()));
    }
  };
}

test('1. [P0] safe-json.mjs re-entrant lock does not self-deadlock on corrupted or empty JSON', () => {
  const tmpDir = makeTempDir('amr-reentrant-lock-');
  try {
    for (const [name, seed] of [
      ['corrupt.json', '{"broken":'],
      ['empty.json', ''],
    ]) {
      const filePath = path.join(tmpDir, name);
      fs.writeFileSync(filePath, seed, 'utf8');

      const t0 = performance.now();
      const updated = updateJsonAtomicSync(
        filePath,
        () => ({ healed: true, count: 0 }),
        (cur) => ({ ...cur, count: Number(cur?.count || 0) + 1 })
      );
      const elapsedMs = performance.now() - t0;

      assert.ok(elapsedMs < 1000, `Expected <1000ms for ${name}, took ${Math.round(elapsedMs)}ms (self-deadlock!)`);
      assert.deepEqual(updated, { healed: true, count: 1 });
      assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), { healed: true, count: 1 });
    }

    const nestedFile = path.join(tmpDir, 'nested.json');
    const lockDir = `${nestedFile}.lock`;
    const tNested = performance.now();
    const nestedRes = withFileLockSync(nestedFile, () => {
      assert.equal(fs.existsSync(lockDir), true, 'Outer lock must exist during outer callback');
      const innerVal = withFileLockSync(nestedFile, () => 42);
      assert.equal(fs.existsSync(lockDir), true, 'Outer lock must remain until outermost callback exits');
      return innerVal;
    });
    assert.ok(performance.now() - tNested < 500, 'Nested withFileLockSync must not wait');
    assert.equal(nestedRes, 42);
    assert.equal(fs.existsSync(lockDir), false, 'Outer lock must be released after exit');
    assert.deepEqual(fs.readdirSync(tmpDir).sort(), ['corrupt.json', 'empty.json']);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('2. [P0] panel-security.mjs validateRequestOrigin verifies sidecar tokens and closes Origin/Referer bypasses', () => {
  // Unverified token string without expectedToken or x-router-panel must be rejected
  assert.equal(
    validateRequestOrigin({
      method: 'POST',
      headers: { origin: 'http://127.0.0.1:4321', 'x-sidecar-token': 'dummy-1' },
    }),
    false
  );

  // Wrong token against expectedToken must be rejected even with x-router-panel
  assert.equal(
    validateRequestOrigin(
      {
        method: 'POST',
        headers: { origin: 'http://127.0.0.1:4321', 'x-sidecar-token': 'wrong' },
      },
      { expectedToken: 'secret-abc' }
    ),
    false
  );
  assert.equal(
    validateRequestOrigin(
      {
        method: 'POST',
        headers: {
          origin: 'http://127.0.0.1:4321',
          'x-router-panel': 'antigravity-v38',
          'x-sidecar-token': 'wrong',
        },
      },
      { expectedToken: 'secret-abc' }
    ),
    false
  );

  // Exact matching token passes
  assert.equal(
    validateRequestOrigin(
      {
        method: 'POST',
        headers: { origin: 'http://127.0.0.1:4321', 'x-sidecar-token': 'secret-abc' },
      },
      { expectedToken: 'secret-abc' }
    ),
    true
  );

  // Missing Origin and Referer on POST without auth/panel header must fail
  assert.equal(validateRequestOrigin({ method: 'POST', headers: {} }), false);

  // Sandboxed iframe (Origin: null) must not read API routes when enforceGetOrigin is true
  assert.equal(
    validateRequestOrigin(
      { method: 'GET', headers: { origin: 'null' } },
      { enforceGetOrigin: true }
    ),
    false
  );

  // Preserve existing tested contracts
  assert.equal(
    validateRequestOrigin({
      method: 'POST',
      headers: { origin: 'http://127.0.0.1:4321', 'x-router-panel': 'antigravity-v38' },
    }),
    true
  );
  assert.equal(
    validateRequestOrigin({
      method: 'POST',
      headers: { origin: 'null', 'x-router-panel': 'antigravity-v37' },
    }),
    true
  );
  assert.equal(
    validateRequestOrigin(
      { method: 'GET', headers: { host: '127.0.0.1:41234' } },
      { enforceGetOrigin: true }
    ),
    true
  );
});

test('3. [P1] /api/project-graph/open-window uses one-time authCode instead of URL token and avoids cmd /c start', async () => {
  const tmpParent = makeTempDir('amr-open-win-');
  const tmpWs = path.join(tmpParent, 'ws');
  const tmpPanel = path.join(tmpParent, 'panel');
  fs.mkdirSync(path.join(tmpWs, 'core'), { recursive: true });
  fs.mkdirSync(tmpPanel, { recursive: true });
  fs.writeFileSync(path.join(tmpWs, 'package.json'), '{"name":"ws"}\n', 'utf8');
  fs.writeFileSync(path.join(tmpWs, 'core', 'safe-json.mjs'), 'export const x = 1;\n', 'utf8');

  const prevIsolate = process.env.TUNNEL_TEST_ISOLATE_INSTALLED;
  const prevStatePath = process.env.TUNNEL_TEST_STATE_PATH;
  const prevCacheDir = process.env.TUNNEL_CACHE_DIR;
  process.env.TUNNEL_TEST_ISOLATE_INSTALLED = '1';
  process.env.TUNNEL_TEST_STATE_PATH = path.join(tmpPanel, 'router-state.json');
  process.env.TUNNEL_CACHE_DIR = path.join(tmpPanel, '.cache');

  let app = null;
  try {
    app = await startSidecarPanel({ SidecarAppClass: createMiniSidecarAppClass() });
    const openWindowHandler = app._routes.get('/api/project-graph/open-window')?.get('POST');
    const exchangeHandler = app._routes.get('/api/project-graph/exchange-auth')?.get('POST');
    assert.equal(typeof openWindowHandler, 'function', '/api/project-graph/open-window route must exist');
    assert.equal(typeof exchangeHandler, 'function', '/api/project-graph/exchange-auth route must exist');

    const authReq = {
      method: 'POST',
      headers: {
        host: '127.0.0.1:41234',
        origin: 'http://127.0.0.1:41234',
        'x-router-panel': 'antigravity-v38',
      },
    };
    const res = await openWindowHandler(
      { rootDir: tmpWs, focus: 'core/safe-json.mjs', token: 'super-secret-xyz', dryRun: true },
      authReq
    );
    assert.equal(res.ok, true);
    assert.equal(res.url.includes('super-secret-xyz'), false, 'Token must never appear in launched URL');
    const parsedUrl = new URL(res.url);
    assert.equal(parsedUrl.searchParams.get('token'), null);
    const authCode = parsedUrl.searchParams.get('authCode');
    assert.ok(authCode && /^[0-9a-f]{16,}$/i.test(authCode), `Expected hex authCode, got: ${authCode}`);

    const ex1 = await exchangeHandler({ authCode }, authReq);
    assert.equal(ex1.ok, true);
    assert.equal(ex1.token, 'super-secret-xyz');

    const ex2 = await exchangeHandler({ authCode }, authReq);
    assert.equal(ex2.ok, false, 'authCode must be single-use');

    const serverSrc = fs.readFileSync(path.join(ROOT_DIR, 'sidecars', 'panel', 'server.mjs'), 'utf8');
    const launchMatch = serverSrc.match(/const launchStandaloneGraphWindow = [\s\S]*?\n  \};/);
    assert.ok(launchMatch, 'launchStandaloneGraphWindow must exist');
    assert.equal(launchMatch[0].includes("spawn('cmd', ['/c', 'start'"), false, 'Must not launch URL via cmd /c start');
  } finally {
    await app?.close?.().catch(() => {});
    if (prevIsolate === undefined) delete process.env.TUNNEL_TEST_ISOLATE_INSTALLED;
    else process.env.TUNNEL_TEST_ISOLATE_INSTALLED = prevIsolate;
    if (prevStatePath === undefined) delete process.env.TUNNEL_TEST_STATE_PATH;
    else process.env.TUNNEL_TEST_STATE_PATH = prevStatePath;
    if (prevCacheDir === undefined) delete process.env.TUNNEL_CACHE_DIR;
    else process.env.TUNNEL_CACHE_DIR = prevCacheDir;
    fs.rmSync(tmpParent, { recursive: true, force: true });
  }
});

test('4. [P2] UNC/traversal path rejection in creatable folders & state patch + dead #resetBlockOrderBtn removal', async () => {
  const tmpPanel = makeTempDir('amr-p2-paths-');
  const prevIsolate = process.env.TUNNEL_TEST_ISOLATE_INSTALLED;
  const prevStatePath = process.env.TUNNEL_TEST_STATE_PATH;
  const prevCacheDir = process.env.TUNNEL_CACHE_DIR;
  process.env.TUNNEL_TEST_ISOLATE_INSTALLED = '1';
  process.env.TUNNEL_TEST_STATE_PATH = path.join(tmpPanel, 'router-state.json');
  process.env.TUNNEL_CACHE_DIR = path.join(tmpPanel, '.cache');

  let app = null;
  try {
    app = await startSidecarPanel({ SidecarAppClass: createMiniSidecarAppClass() });
    const gpuPickHandler = app._routes.get('/api/gpu/pick-folder')?.get('POST');
    assert.equal(typeof gpuPickHandler, 'function');
    const authReq = {
      method: 'POST',
      headers: {
        host: '127.0.0.1:41234',
        origin: 'http://127.0.0.1:41234',
        'x-router-panel': 'antigravity-v38',
      },
    };

    const uncRes = await gpuPickHandler({ path: '\\\\evil-server\\share\\models', mode: 'models' }, authReq);
    assert.equal(uncRes.ok, false, 'UNC path must be rejected');

    const travRes = await gpuPickHandler({ path: 'C:\\models\\..\\Windows', mode: 'models' }, authReq);
    assert.equal(travRes.ok, false, 'Parent traversal (..) path must be rejected');

    const patchBad = sanitizeStatePatch({
      gpuModelsDir: '\\\\evil\\share',
      gpuOllamaDir: 'C:\\ok\\..\\bad',
    });
    assert.equal(Object.hasOwn(patchBad, 'gpuModelsDir'), false);
    assert.equal(Object.hasOwn(patchBad, 'gpuOllamaDir'), false);

    const patchGood = sanitizeStatePatch({ gpuModelsDir: 'D:\\OllamaModels', gpuOllamaDir: '' });
    assert.equal(patchGood.gpuModelsDir, 'D:\\OllamaModels');
    assert.equal(patchGood.gpuOllamaDir, '');

    const sentinelJs = fs.readFileSync(path.join(ROOT_DIR, 'sidecars', 'panel', 'ui-src', 'js', '04-sentinel-layout.js'), 'utf8');
    const uiHtml = fs.readFileSync(path.join(ROOT_DIR, 'sidecars', 'panel', 'ui.html'), 'utf8');
    assert.equal(sentinelJs.includes('resetBlockOrderBtn'), false, '04-sentinel-layout.js must not query removed #resetBlockOrderBtn');
    assert.equal(uiHtml.includes('resetBlockOrderBtn'), false, 'ui.html must not contain #resetBlockOrderBtn');
  } finally {
    await app?.close?.().catch(() => {});
    if (prevIsolate === undefined) delete process.env.TUNNEL_TEST_ISOLATE_INSTALLED;
    else process.env.TUNNEL_TEST_ISOLATE_INSTALLED = prevIsolate;
    if (prevStatePath === undefined) delete process.env.TUNNEL_TEST_STATE_PATH;
    else process.env.TUNNEL_TEST_STATE_PATH = prevStatePath;
    if (prevCacheDir === undefined) delete process.env.TUNNEL_CACHE_DIR;
    else process.env.TUNNEL_CACHE_DIR = prevCacheDir;
    fs.rmSync(tmpPanel, { recursive: true, force: true });
  }
});

function createOneArgSidecarAppClass() {
  return class OneArgSidecarApp {
    constructor() {
      this._pages = new Map();
      this._apis = new Map();
      this._server = null;
    }
    page(p, handler) { this._pages.set(p, handler); }
    api(p, handler, method = 'POST') {
      if (!this._apis.has(p)) this._apis.set(p, new Map());
      this._apis.get(p).set(String(method || 'POST').toUpperCase(), handler);
    }
    get port() { return this._server?.address()?.port || 0; }
    run() {
      const server = http.createServer(async (req, res) => {
        const u = new URL(req.url || '/', 'http://127.0.0.1');
        if (req.method === 'GET' && this._pages.has(u.pathname)) {
          const out = await this._pages.get(u.pathname)();
          res.writeHead(out?.status || 200, { 'Content-Type': out?.contentType || 'text/html; charset=utf-8' });
          res.end(out?.body ?? '');
          return;
        }
        if (this._apis.has(u.pathname)) {
          const handler = this._apis.get(u.pathname).get(req.method);
          if (!handler) {
            res.writeHead(405, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Method Not Allowed' }));
            return;
          }
          let body = '';
          req.on('data', (c) => { body += c; });
          req.on('end', async () => {
            try {
              const data = {};
              for (const [k, v] of u.searchParams.entries()) data[k] = v;
              if (body) Object.assign(data, JSON.parse(body));
              // Simulate real sidecar_sdk: pass ONLY data (req is undefined)
              const result = await handler(data);
              res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify(result));
            } catch (err) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: err?.message || 'Internal Error' }));
            }
          });
          return;
        }
        res.writeHead(404);
        res.end('Not found');
      });
      this._server = server;
      return new Promise((resolveListen) => server.listen(0, '127.0.0.1', () => resolveListen(server)));
    }
    close() {
      const srv = this._server;
      this._server = null;
      if (!srv) return Promise.resolve();
      if (typeof srv.closeAllConnections === 'function') {
        try { srv.closeAllConnections(); } catch {}
      }
      return new Promise((resolveClose) => srv.close(() => resolveClose()));
    }
  };
}

test('5. AsyncLocalStorage forwards req under 1-arg sidecar_sdk for headers and /api/local-chat', async () => {
  const tmpParent = makeTempDir('amr-als-sdk-');
  const tmpWs = path.join(tmpParent, 'ws-als');
  const tmpPanel = path.join(tmpParent, 'panel');
  fs.mkdirSync(path.join(tmpWs, 'src'), { recursive: true });
  fs.mkdirSync(tmpPanel, { recursive: true });
  fs.writeFileSync(path.join(tmpWs, 'package.json'), '{"name":"ws-als"}\n', 'utf8');
  fs.writeFileSync(path.join(tmpPanel, 'router-state.json'), JSON.stringify({ onboardingCompleted: true, gpuEnabled: false }, null, 2), 'utf8');

  const prevIsolate = process.env.TUNNEL_TEST_ISOLATE_INSTALLED;
  const prevStatePath = process.env.TUNNEL_TEST_STATE_PATH;
  const prevCacheDir = process.env.TUNNEL_CACHE_DIR;
  process.env.TUNNEL_TEST_ISOLATE_INSTALLED = '1';
  process.env.TUNNEL_TEST_STATE_PATH = path.join(tmpPanel, 'router-state.json');
  process.env.TUNNEL_CACHE_DIR = path.join(tmpPanel, '.cache');

  let app = null;
  try {
    app = await startSidecarPanel({ SidecarAppClass: createOneArgSidecarAppClass() });
    assert.ok(app && app.port > 0);
    const baseUrl = `http://127.0.0.1:${app.port}`;
    assert.equal(getActiveSidecarRequest(), null);

    // GET /api/state must read x-open-workspaces header via AsyncLocalStorage even when handler receives only (data)
    const stateRes = await fetch(`${baseUrl}/api/state`, {
      method: 'GET',
      headers: {
        Origin: baseUrl,
        'x-router-panel': 'antigravity-v38',
        'x-open-workspaces': encodeURIComponent(ROOT_DIR),
      },
    });
    const stateJson = await stateRes.json();
    assert.equal(stateRes.status, 200);
    assert.equal(path.resolve(stateJson.activeWorkspace).toLowerCase(), path.resolve(ROOT_DIR).toLowerCase());

    // POST /api/state must read x-panel-fast-update header via AsyncLocalStorage
    const fastRes = await fetch(`${baseUrl}/api/state`, {
      method: 'POST',
      headers: {
        Origin: baseUrl,
        'Content-Type': 'application/json',
        'x-router-panel': 'antigravity-v38',
        'x-panel-fast-update': '1',
      },
      body: JSON.stringify({ showBadge: true }),
    });
    const fastJson = await fastRes.json();
    assert.equal(fastRes.status, 200);
    assert.equal(fastJson.ok, true);
    assert.equal(fastJson.fast, true);

    // POST /api/local-chat under 1-arg SDK must authorize via ALS and handle disabled GPU cleanly
    const chatRes = await fetch(`${baseUrl}/api/local-chat`, {
      method: 'POST',
      headers: {
        Origin: baseUrl,
        'Content-Type': 'application/json',
        'x-router-panel': 'antigravity-v38',
      },
      body: JSON.stringify({ message: 'ping', requestId: 'als-test-1' }),
    });
    const chatJson = await chatRes.json();
    assert.equal(chatRes.status, 200);
    assert.equal(chatJson.ok, false);
    assert.equal(chatJson.skippedGpuDisabled, true);
  } finally {
    await app?.close?.().catch(() => {});
    try { knowledgeHub.close(); } catch {}
    if (prevIsolate === undefined) delete process.env.TUNNEL_TEST_ISOLATE_INSTALLED;
    else process.env.TUNNEL_TEST_ISOLATE_INSTALLED = prevIsolate;
    if (prevStatePath === undefined) delete process.env.TUNNEL_TEST_STATE_PATH;
    else process.env.TUNNEL_TEST_STATE_PATH = prevStatePath;
    if (prevCacheDir === undefined) delete process.env.TUNNEL_CACHE_DIR;
    else process.env.TUNNEL_CACHE_DIR = prevCacheDir;
    try { fs.rmSync(tmpParent, { recursive: true, force: true, maxRetries: 4, retryDelay: 60 }); } catch {}
  }
});

test('6. /api/debug/mode avoids RMW overwrite, .agentignore reports alreadyExists, federation validates peers & limits clamp', async () => {
  const tmpParent = makeTempDir('amr-hardening-6-');
  const tmpWs = path.join(tmpParent, 'ws');
  const peerWs = path.join(tmpParent, 'peer-ws');
  const tmpPanel = path.join(tmpParent, 'panel');
  fs.mkdirSync(tmpWs, { recursive: true });
  fs.mkdirSync(peerWs, { recursive: true });
  fs.mkdirSync(tmpPanel, { recursive: true });
  fs.writeFileSync(path.join(tmpWs, 'package.json'), '{"name":"ws"}\n', 'utf8');
  fs.writeFileSync(path.join(peerWs, 'package.json'), '{"name":"peer"}\n', 'utf8');

  const prevIsolate = process.env.TUNNEL_TEST_ISOLATE_INSTALLED;
  const prevStatePath = process.env.TUNNEL_TEST_STATE_PATH;
  const prevCacheDir = process.env.TUNNEL_CACHE_DIR;
  process.env.TUNNEL_TEST_ISOLATE_INSTALLED = '1';
  process.env.TUNNEL_TEST_STATE_PATH = path.join(tmpPanel, 'router-state.json');
  process.env.TUNNEL_CACHE_DIR = path.join(tmpPanel, '.cache');
  fs.writeFileSync(process.env.TUNNEL_TEST_STATE_PATH, JSON.stringify({ showBadge: false, debugLogMode: 'errors' }, null, 2), 'utf8');

  let app = null;
  try {
    app = await startSidecarPanel({ SidecarAppClass: createMiniSidecarAppClass(), pluginRoot: tmpPanel });
    const authReq = {
      method: 'POST',
      headers: {
        host: '127.0.0.1:41234',
        origin: 'http://127.0.0.1:41234',
        'x-router-panel': 'antigravity-v38',
      },
    };

    // 1. /api/debug/mode must patch only debugLogMode
    const modeHandler = app._routes.get('/api/debug/mode')?.get('POST');
    const modeRes = await modeHandler({ mode: 'verbose' }, authReq);
    assert.equal(modeRes.ok, true);
    assert.equal(modeRes.mode, 'verbose');
    assert.equal(loadState().showBadge, false);

    // 2. .agentignore second apply must report alreadyExists=true and keep custom content
    const applyHandler = app._routes.get('/api/setup-recommendations/apply')?.get('POST');
    const firstIg = await applyHandler({ rootDir: tmpWs, kind: 'agentignore' }, authReq);
    assert.equal(firstIg.ok, true);
    assert.equal(firstIg.alreadyExists, false);
    const igPath = path.join(tmpWs, '.agentignore');
    fs.writeFileSync(igPath, '# custom ignore\nsecret.txt\n', 'utf8');
    const secondIg = await applyHandler({ rootDir: tmpWs, kind: 'agentignore' }, authReq);
    assert.equal(secondIg.ok, true);
    assert.equal(secondIg.exists, true);
    assert.equal(secondIg.alreadyExists, true);
    assert.match(secondIg.detail, /уже существует|already exists/i);
    assert.equal(fs.readFileSync(igPath, 'utf8'), '# custom ignore\nsecret.txt\n');

    // 3. /api/knowledge/federation must filter invalid peers and deduplicate addPeer
    const fedHandler = app._routes.get('/api/knowledge/federation')?.get('POST');
    const fedRes = await fedHandler({
      rootDir: tmpWs,
      peers: [peerWs, 'Z:\\nonexistent-dir-99999', 42, tmpWs, peerWs],
    }, authReq);
    assert.equal(fedRes.ok, true);
    assert.equal(fedRes.peers.length, 1);
    assert.equal(path.resolve(fedRes.peers[0].path).toLowerCase(), path.resolve(peerWs).toLowerCase());
    const fedDup = await fedHandler({ rootDir: tmpWs, addPeer: peerWs }, authReq);
    assert.equal(fedDup.ok, true);
    assert.equal(fedDup.peers.length, 1);

    // 4. Limit clamping does not throw or produce NaN
    const atHandler = app._routes.get('/api/composer/at-suggest')?.get('POST');
    const atRes = await atHandler({ rootDir: tmpWs, query: 'pack', limit: 'abc' }, authReq);
    assert.equal(atRes.ok, true);
    assert.ok(Array.isArray(atRes.items));
  } finally {
    await app?.close?.().catch(() => {});
    try { knowledgeHub.close(); } catch {}
    if (prevIsolate === undefined) delete process.env.TUNNEL_TEST_ISOLATE_INSTALLED;
    else process.env.TUNNEL_TEST_ISOLATE_INSTALLED = prevIsolate;
    if (prevStatePath === undefined) delete process.env.TUNNEL_TEST_STATE_PATH;
    else process.env.TUNNEL_TEST_STATE_PATH = prevStatePath;
    if (prevCacheDir === undefined) delete process.env.TUNNEL_CACHE_DIR;
    else process.env.TUNNEL_CACHE_DIR = prevCacheDir;
    try { fs.rmSync(tmpParent, { recursive: true, force: true, maxRetries: 4, retryDelay: 60 }); } catch {}
  }
});

test('7. open-window reads ANTIGRAVITY_SIDECAR_* env vars & launchStandaloneGraphWindow handles spawn error', async () => {
  const tmpParent = makeTempDir('amr-hardening-7-');
  const tmpWs = path.join(tmpParent, 'ws');
  const tmpPanel = path.join(tmpParent, 'panel');
  fs.mkdirSync(tmpWs, { recursive: true });
  fs.mkdirSync(tmpPanel, { recursive: true });
  fs.writeFileSync(path.join(tmpWs, 'package.json'), '{"name":"ws"}\n', 'utf8');

  const prevIsolate = process.env.TUNNEL_TEST_ISOLATE_INSTALLED;
  const prevStatePath = process.env.TUNNEL_TEST_STATE_PATH;
  const prevCacheDir = process.env.TUNNEL_CACHE_DIR;
  const prevSidecarPort = process.env.SIDECAR_PORT;
  const prevSidecarToken = process.env.SIDECAR_TOKEN;
  const prevAgWebPort = process.env.ANTIGRAVITY_SIDECAR_WEB_PORT;
  const prevAgUiToken = process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN;

  process.env.TUNNEL_TEST_ISOLATE_INSTALLED = '1';
  process.env.TUNNEL_TEST_STATE_PATH = path.join(tmpPanel, 'router-state.json');
  process.env.TUNNEL_CACHE_DIR = path.join(tmpPanel, '.cache');
  delete process.env.SIDECAR_PORT;
  delete process.env.SIDECAR_TOKEN;
  process.env.ANTIGRAVITY_SIDECAR_WEB_PORT = '43210';
  process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN = 'ag-ui-secret-999';

  let app = null;
  try {
    app = await startSidecarPanel({ SidecarAppClass: createMiniSidecarAppClass() });
    const openWindowHandler = app._routes.get('/api/project-graph/open-window')?.get('POST');
    const exchangeHandler = app._routes.get('/api/project-graph/exchange-auth')?.get('POST');
    const authReq = {
      method: 'POST',
      headers: {
        origin: 'http://127.0.0.1:43210',
        'x-router-panel': 'antigravity-v38',
      },
    };
    const res = await openWindowHandler({ rootDir: tmpWs, dryRun: true }, authReq);
    assert.equal(res.ok, true);
    const parsedUrl = new URL(res.url);
    assert.equal(parsedUrl.port, '43210');
    const authCode = parsedUrl.searchParams.get('authCode');
    assert.ok(authCode && /^[0-9a-f]{16,}$/i.test(authCode));

    const exRes = await exchangeHandler({ authCode }, authReq);
    assert.equal(exRes.ok, true);
    assert.equal(exRes.token, 'ag-ui-secret-999');

    const serverSrc = fs.readFileSync(path.join(ROOT_DIR, 'sidecars', 'panel', 'server.mjs'), 'utf8');
    const launchMatch = serverSrc.match(/const launchStandaloneGraphWindow = [\s\S]*?\n  \};/);
    assert.ok(launchMatch, 'launchStandaloneGraphWindow must exist');
    const spawnCount = (launchMatch[0].match(/\bspawn\(/g) || []).length;
    const errHandlerCount = (launchMatch[0].match(/child\.on\('error'/g) || []).length;
    assert.ok(spawnCount >= 3 && errHandlerCount === spawnCount, 'Every spawn() in launchStandaloneGraphWindow must attach child.on("error")');
  } finally {
    await app?.close?.().catch(() => {});
    if (prevIsolate === undefined) delete process.env.TUNNEL_TEST_ISOLATE_INSTALLED;
    else process.env.TUNNEL_TEST_ISOLATE_INSTALLED = prevIsolate;
    if (prevStatePath === undefined) delete process.env.TUNNEL_TEST_STATE_PATH;
    else process.env.TUNNEL_TEST_STATE_PATH = prevStatePath;
    if (prevCacheDir === undefined) delete process.env.TUNNEL_CACHE_DIR;
    else process.env.TUNNEL_CACHE_DIR = prevCacheDir;
    if (prevSidecarPort === undefined) delete process.env.SIDECAR_PORT;
    else process.env.SIDECAR_PORT = prevSidecarPort;
    if (prevSidecarToken === undefined) delete process.env.SIDECAR_TOKEN;
    else process.env.SIDECAR_TOKEN = prevSidecarToken;
    if (prevAgWebPort === undefined) delete process.env.ANTIGRAVITY_SIDECAR_WEB_PORT;
    else process.env.ANTIGRAVITY_SIDECAR_WEB_PORT = prevAgWebPort;
    if (prevAgUiToken === undefined) delete process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN;
    else process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN = prevAgUiToken;
    fs.rmSync(tmpParent, { recursive: true, force: true });
  }
});

test('8. Hardening wave: router-cli decoupling, 1-arg ALS origin enforcement, headless app queue survival & JSON 400 errors', async () => {
  const routerCliSrc = fs.readFileSync(path.join(ROOT_DIR, 'core', 'router-cli.mjs'), 'utf8');
  assert.equal(
    routerCliSrc.includes('../sidecars/panel/server.mjs'),
    false,
    'core/router-cli.mjs must import panel-state-skills.mjs directly instead of server.mjs'
  );
  assert.equal(
    routerCliSrc.includes('../sidecars/panel/lib/panel-state-skills.mjs'),
    true,
    'core/router-cli.mjs must import sanitizeStatePatch from panel-state-skills.mjs'
  );
  assert.equal(typeof sanitizeStatePatch, 'function', 'server.mjs must keep sanitizeStatePatch barrel re-export');

  const tmpParent = makeTempDir('amr-hardening-8-');
  const tmpWs = path.join(tmpParent, 'ws');
  const tmpPanel = path.join(tmpParent, 'panel');
  fs.mkdirSync(path.join(tmpWs, 'src'), { recursive: true });
  fs.mkdirSync(tmpPanel, { recursive: true });
  fs.writeFileSync(path.join(tmpWs, 'package.json'), '{"name":"ws-8"}\n', 'utf8');
  fs.writeFileSync(path.join(tmpWs, 'src', 'index.mjs'), 'export const ok = true;\n', 'utf8');
  fs.writeFileSync(
    path.join(tmpPanel, 'router-state.json'),
    JSON.stringify({ onboardingCompleted: true, gpuEnabled: false }, null, 2),
    'utf8'
  );

  const prevIsolate = process.env.TUNNEL_TEST_ISOLATE_INSTALLED;
  const prevStatePath = process.env.TUNNEL_TEST_STATE_PATH;
  const prevCacheDir = process.env.TUNNEL_CACHE_DIR;
  process.env.TUNNEL_TEST_ISOLATE_INSTALLED = '1';
  process.env.TUNNEL_TEST_STATE_PATH = path.join(tmpPanel, 'router-state.json');
  process.env.TUNNEL_CACHE_DIR = path.join(tmpPanel, '.cache');

  let oneArgApp = null;
  let headlessApp = null;
  try {
    // 1. 1-arg sidecar_sdk ALS origin enforcement on GET /api/state and POST /api/debug/mode
    oneArgApp = await startSidecarPanel({ SidecarAppClass: createOneArgSidecarAppClass(), pluginRoot: tmpPanel });
    const baseUrl = `http://127.0.0.1:${oneArgApp.port}`;
    const evilPost = await fetch(`${baseUrl}/api/debug/mode`, {
      method: 'POST',
      headers: {
        Origin: 'https://evil.example',
        'Content-Type': 'application/json',
        'x-router-panel': '',
      },
      body: JSON.stringify({ mode: 'verbose' }),
    });
    assert.equal(evilPost.status, 403, 'Cross-origin POST /api/debug/mode must be rejected with 403');

    const evilGet = await fetch(`${baseUrl}/api/state`, {
      method: 'GET',
      headers: {
        Origin: 'https://evil.example',
        'x-router-panel': '',
      },
    });
    assert.equal(evilGet.status, 403, 'Cross-origin GET /api/state must be rejected with 403');

    await oneArgApp.close();
    oneArgApp = null;

    // 2. Headless SidecarApp (run() returns undefined) keeps queues alive until app.close()
    class HeadlessSidecarApp {
      constructor() {
        this._routes = new Map();
        this.closed = false;
      }
      page() {}
      api(p, handler, method = 'POST') {
        if (!this._routes.has(p)) this._routes.set(p, new Map());
        this._routes.get(p).set(String(method || 'POST').toUpperCase(), handler);
      }
      run() {
        return undefined;
      }
      close() {
        this.closed = true;
        return Promise.resolve();
      }
    }

    headlessApp = await startSidecarPanel({ SidecarAppClass: HeadlessSidecarApp, pluginRoot: tmpPanel });
    const acHandler = headlessApp._routes.get('/api/autocomplete')?.get('POST');
    const queueHandler = headlessApp._routes.get('/api/chat-queue')?.get('GET');
    const repomapHandler = headlessApp._routes.get('/api/repomap')?.get('POST');
    const chatSendHandler = headlessApp._routes.get('/api/chat-send')?.get('POST');
    const authReq = {
      method: 'POST',
      headers: {
        host: '127.0.0.1:41234',
        origin: 'http://127.0.0.1:41234',
        'x-router-panel': 'antigravity-v38',
      },
    };
    const authGetReq = {
      method: 'GET',
      headers: {
        host: '127.0.0.1:41234',
        origin: 'http://127.0.0.1:41234',
      },
    };

    const acCtx = await acHandler({ mode: 'context', rootDir: tmpWs }, authReq);
    assert.equal(acCtx.ok, true, 'Headless app must not dispose autocompleteGpuQueue on startup');
    assert.equal(acCtx.queue.disposed, false);

    // 3. /api/repomap invalid workspace returns plain JSON error object (not FallbackResponse wrapper)
    const badRepoRes = await repomapHandler({ rootDir: 'Z:\\nonexistent-999999' }, authReq);
    assert.deepEqual(badRepoRes, { ok: false, status: 400, error: 'Invalid workspace directory' });

    await headlessApp.close();
    assert.equal(headlessApp.closed, true);
    const queueAfterClose = await queueHandler({}, authGetReq);
    assert.equal(queueAfterClose.chatQueue.disposed, true, 'app.close() must dispose chatMessageQueue');
    assert.equal(queueAfterClose.autocompleteQueue.disposed, true, 'app.close() must dispose autocompleteGpuQueue');

    const sendAfterClose = await chatSendHandler({ message: 'hello' }, authReq);
    assert.equal(sendAfterClose.ok, false);
    assert.equal(sendAfterClose.code, 'QUEUE_DISPOSED');
  } finally {
    await oneArgApp?.close?.().catch(() => {});
    await headlessApp?.close?.().catch(() => {});
    try { knowledgeHub.close(); } catch {}
    if (prevIsolate === undefined) delete process.env.TUNNEL_TEST_ISOLATE_INSTALLED;
    else process.env.TUNNEL_TEST_ISOLATE_INSTALLED = prevIsolate;
    if (prevStatePath === undefined) delete process.env.TUNNEL_TEST_STATE_PATH;
    else process.env.TUNNEL_TEST_STATE_PATH = prevStatePath;
    if (prevCacheDir === undefined) delete process.env.TUNNEL_CACHE_DIR;
    else process.env.TUNNEL_CACHE_DIR = prevCacheDir;
    try { fs.rmSync(tmpParent, { recursive: true, force: true, maxRetries: 4, retryDelay: 60 }); } catch {}
  }
});

test('9. Security audit hardening: SIDECAR_TOKEN non-bypass, same-port loopback, update-apply repo check, MCP hint, no PS Bypass, safe linter precheck', async () => {
  // 1) SIDECAR_TOKEN cannot be bypassed via static x-router-panel header or same-origin alone
  assert.equal(
    validateRequestOrigin(
      {
        method: 'POST',
        headers: {
          host: '127.0.0.1:41234',
          origin: 'http://127.0.0.1:41234',
          'x-router-panel': 'antigravity-v38',
          'sec-fetch-site': 'same-origin',
        },
      },
      { expectedToken: 'secret-token-123', enforceGetOrigin: true }
    ),
    false
  );
  assert.equal(
    validateRequestOrigin(
      {
        method: 'POST',
        headers: {
          host: '127.0.0.1:41234',
          origin: 'http://127.0.0.1:41234',
          'x-router-panel': 'antigravity-v38',
          'x-sidecar-token': 'secret-token-123',
        },
      },
      { expectedToken: 'secret-token-123', enforceGetOrigin: true }
    ),
    true
  );
  assert.equal(
    validateRequestOrigin(
      {
        method: 'GET',
        url: '/api/state?token=secret-token-123',
        headers: {
          host: '127.0.0.1:41234',
          origin: 'http://127.0.0.1:41234',
        },
      },
      { expectedToken: 'secret-token-123', enforceGetOrigin: true }
    ),
    true
  );
  // Exchange-auth route keeps working for single-use authCode exchange
  assert.equal(
    validateRequestOrigin(
      {
        method: 'POST',
        headers: {
          host: '127.0.0.1:41234',
          origin: 'http://127.0.0.1:41234',
          'x-router-panel': 'antigravity-v38',
        },
      },
      { expectedToken: 'secret-token-123', enforceGetOrigin: true, allowAuthCodeExchange: true }
    ),
    true
  );

  // 2) Cross-port loopback Origin must be rejected when Host port differs
  assert.equal(
    validateRequestOrigin(
      {
        method: 'POST',
        headers: {
          host: '127.0.0.1:41234',
          origin: 'http://localhost:3000',
          'x-router-panel': 'antigravity-v38',
        },
      },
      { expectedToken: '' }
    ),
    false
  );
  assert.equal(
    validateRequestOrigin(
      {
        method: 'POST',
        headers: {
          host: '127.0.0.1:41234',
          origin: 'http://localhost:41234',
          'x-router-panel': 'antigravity-v38',
        },
      },
      { expectedToken: '' }
    ),
    true
  );

  // 3) /api/plugin/update-apply rejects foreign GitHub repository URLs
  const tmpPanel = makeTempDir('amr-sec-panel-');
  const prevIsolate = process.env.TUNNEL_TEST_ISOLATE_INSTALLED;
  const prevStatePath = process.env.TUNNEL_TEST_STATE_PATH;
  const prevCacheDir = process.env.TUNNEL_CACHE_DIR;
  process.env.TUNNEL_TEST_ISOLATE_INSTALLED = '1';
  process.env.TUNNEL_TEST_STATE_PATH = path.join(tmpPanel, 'router-state.json');
  process.env.TUNNEL_CACHE_DIR = path.join(tmpPanel, '.cache');
  let app = null;
  try {
    app = await startSidecarPanel({ SidecarAppClass: createMiniSidecarAppClass(), pluginRoot: ROOT_DIR });
    const updateApplyHandler = app._routes.get('/api/plugin/update-apply')?.get('POST');
    assert.equal(typeof updateApplyHandler, 'function');
    const authReq = {
      method: 'POST',
      headers: {
        host: '127.0.0.1:41234',
        origin: 'http://127.0.0.1:41234',
        'x-router-panel': 'antigravity-v38',
      },
    };
    const foreignUpdateRes = await updateApplyHandler(
      { downloadUrl: 'https://github.com/attacker/rogue-router/releases/download/v9.9.9/payload.zip', targetVersion: '9.9.9' },
      authReq
    );
    assert.equal(foreignUpdateRes.ok, false);
    assert.equal(foreignUpdateRes.status, 400);
  } finally {
    await app?.close?.().catch(() => {});
    if (prevIsolate === undefined) delete process.env.TUNNEL_TEST_ISOLATE_INSTALLED;
    else process.env.TUNNEL_TEST_ISOLATE_INSTALLED = prevIsolate;
    if (prevStatePath === undefined) delete process.env.TUNNEL_TEST_STATE_PATH;
    else process.env.TUNNEL_TEST_STATE_PATH = prevStatePath;
    if (prevCacheDir === undefined) delete process.env.TUNNEL_CACHE_DIR;
    else process.env.TUNNEL_CACHE_DIR = prevCacheDir;
    fs.rmSync(tmpPanel, { recursive: true, force: true });
  }

  // 4) git_bisect_auto MCP annotation must declare readOnlyHint: false & zero -ExecutionPolicy Bypass in runtime modules
  const mcpSrc = fs.readFileSync(path.join(ROOT_DIR, 'core', 'ram-memory-mcp.mjs'), 'utf8');
  const bisectBlockMatch = mcpSrc.match(/name:\s*'git_bisect_auto'[\s\S]{0,450}/);
  assert.ok(bisectBlockMatch, 'git_bisect_auto tool definition must exist');
  assert.match(bisectBlockMatch[0], /readOnlyHint:\s*false/);

  const hwSrc = fs.readFileSync(path.join(ROOT_DIR, 'core', 'hardware-profiler.mjs'), 'utf8');
  const hudSrc = fs.readFileSync(path.join(ROOT_DIR, 'core', 'floating-hud.mjs'), 'utf8');
  assert.equal(/-ExecutionPolicy\s*['"]?,?\s*['"]?Bypass/i.test(hwSrc), false);
  assert.equal(/-ExecutionPolicy\s*['"]?,?\s*['"]?Bypass/i.test(hudSrc), false);

  // 5) Fast linter precheck refuses unconfirmed node_modules/.bin and Win32 shell metacharacters
  const tmpLinterWs = makeTempDir('amr-sec-lint-');
  try {
    const binDir = path.join(tmpLinterWs, 'node_modules', '.bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, process.platform === 'win32' ? 'oxlint.cmd' : 'oxlint'), 'echo evil\n', 'utf8');
    fs.writeFileSync(path.join(tmpLinterWs, 'app.js'), 'export const x = 1;\n', 'utf8');
    // No .oxlintrc and no package.json dependency -> must NOT pick unconfirmed binary
    assert.equal(detectWorkspaceFastLinter(tmpLinterWs), null);

    // Unsafe path with shell metacharacter '&' must be skipped safely when invoked via Windows .cmd wrapper
    const unsafeFile = path.join(tmpLinterWs, 'a&calc.js');
    fs.writeFileSync(unsafeFile, 'export const y = 2;\n', 'utf8');
    const precheckRes = await runFastLinterPrecheck({
      rootDir: tmpLinterWs,
      filePath: unsafeFile,
      linterSpec: { tool: 'oxlint', bin: path.join(binDir, 'oxlint.cmd') },
    });
    assert.equal(precheckRes.ran, false);
    if (process.platform === 'win32') {
      assert.equal(precheckRes.skippedUnsafePath, true);
    }
  } finally {
    fs.rmSync(tmpLinterWs, { recursive: true, force: true });
  }
});

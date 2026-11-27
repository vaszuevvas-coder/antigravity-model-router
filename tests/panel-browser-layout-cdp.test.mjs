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
  COLLAPSIBLE_PANEL_CARD_IDS,
  PANEL_SPOILER_IDS,
  loadState,
  startSidecarPanel,
} from '../sidecars/panel/server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const STATE_PATH = path.join(ROOT_DIR, 'router-state.json');

function findBrowserExecutable() {
  const envOverride = process.env.CDP_BROWSER_PATH || process.env.CHROME_PATH || process.env.EDGE_PATH;
  if (envOverride && fs.existsSync(envOverride)) {
    return envOverride;
  }

  const candidates = [];
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || '';
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    candidates.push(
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(localAppData, 'Chromium', 'Application', 'chrome.exe'),
    );
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    );
  } else {
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge',
      '/snap/bin/chromium',
    );
  }

  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }

  const whichCmd = process.platform === 'win32' ? 'where' : 'which';
  const binNames = process.platform === 'win32'
    ? ['msedge.exe', 'chrome.exe', 'chromium.exe']
    : ['google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge'];
  for (const bin of binNames) {
    try {
      const out = execFileSync(whichCmd, [bin], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const first = out.split(/\r?\n/).map((s) => s.trim()).find((s) => s && fs.existsSync(s));
      if (first) return first;
    } catch {}
  }
  return null;
}

function createTestSidecarAppClass() {
  return class TestSidecarApp {
    constructor() {
      this._pages = new Map();
      this._apis = new Map();
      this._server = null;
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
          const methodMap = this._apis.get(u.pathname);
          const handler = methodMap.get(req.method);
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
              res.end(JSON.stringify(result));
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
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=0',
    '--window-size=340,720',
    `--user-data-dir=${userDataDir}`,
    'about:blank',
  ];

  const proc = spawn(browserExe, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const devToolsUrl = await new Promise((resolveUrl, rejectUrl) => {
    let logs = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      rejectUrl(new Error(`Timed out waiting for DevTools listening URL. Output:\n${logs}`));
    }, 15000);

    const onData = (chunk) => {
      if (settled) return;
      logs += chunk.toString('utf8');
      const m = logs.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:(\d+)\/[^\s\r\n]+)/i);
      if (m) {
        settled = true;
        clearTimeout(timer);
        resolveUrl({ wsBrowserUrl: m[1], cdpPort: Number(m[2]) });
      }
    };

    proc.stderr?.on('data', onData);
    proc.stdout?.on('data', onData);
    proc.once('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectUrl(err);
    });
    proc.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectUrl(new Error(`Browser exited early (code=${code}, signal=${signal}). Output:\n${logs}`));
    });
  });

  const listUrl = `http://127.0.0.1:${devToolsUrl.cdpPort}/json/list`;
  let pageWsUrl = null;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && !pageWsUrl) {
    try {
      const res = await fetch(listUrl);
      if (res.ok) {
        const targets = await res.json();
        const pageTarget = Array.isArray(targets)
          ? targets.find((item) => item?.type === 'page' && item?.webSocketDebuggerUrl)
          : null;
        if (pageTarget) {
          pageWsUrl = pageTarget.webSocketDebuggerUrl;
          break;
        }
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 80));
  }

  if (!pageWsUrl) {
    const newRes = await fetch(`http://127.0.0.1:${devToolsUrl.cdpPort}/json/new?about:blank`, { method: 'PUT' })
      .catch(() => fetch(`http://127.0.0.1:${devToolsUrl.cdpPort}/json/new?about:blank`));
    if (newRes?.ok) {
      const target = await newRes.json();
      pageWsUrl = target?.webSocketDebuggerUrl || null;
    }
  }

  if (!pageWsUrl) {
    killBrowserProcess(proc);
    throw new Error('Could not discover CDP page webSocketDebuggerUrl');
  }

  return { proc, cdpPort: devToolsUrl.cdpPort, pageWsUrl };
}

async function connectCdpClient(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolveOpen, rejectOpen) => {
    const timer = setTimeout(() => rejectOpen(new Error('WebSocket CDP connect timeout')), 10000);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolveOpen();
    }, { once: true });
    ws.addEventListener('error', (err) => {
      clearTimeout(timer);
      rejectOpen(err?.error || new Error('WebSocket CDP error'));
    }, { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  const eventWaiters = new Set();

  ws.addEventListener('message', (event) => {
    let msg;
    try {
      msg = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (typeof msg.id === 'number' && pending.has(msg.id)) {
      const entry = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) {
        entry.reject(new Error(`CDP ${entry.method} error (${msg.error.code}): ${msg.error.message}`));
      } else {
        entry.resolve(msg.result || {});
      }
      return;
    }
    if (msg.method) {
      for (const waiter of Array.from(eventWaiters)) {
        if (waiter.method === msg.method && (!waiter.predicate || waiter.predicate(msg.params || {}))) {
          eventWaiters.delete(waiter);
          clearTimeout(waiter.timer);
          waiter.resolve(msg.params || {});
        }
      }
    }
  });

  ws.addEventListener('close', () => {
    for (const [id, entry] of pending.entries()) {
      pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(new Error(`CDP socket closed while waiting for ${entry.method}`));
    }
    for (const waiter of Array.from(eventWaiters)) {
      eventWaiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`CDP socket closed while waiting for event ${waiter.method}`));
    }
  });

  function send(method, params = {}, timeoutMs = 15000) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, { method, resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  function waitForEvent(method, predicate = null, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const waiter = {
        method,
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          eventWaiters.delete(waiter);
          reject(new Error(`CDP event ${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs),
      };
      eventWaiters.add(waiter);
    });
  }

  async function evaluate(fnOrExpr, ...args) {
    const expression = typeof fnOrExpr === 'function'
      ? `(${fnOrExpr.toString()})(${args.map((a) => JSON.stringify(a)).join(',')})`
      : String(fnOrExpr);
    const res = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      const desc = res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'Runtime evaluation error';
      throw new Error(`Browser Runtime.evaluate failed: ${desc}`);
    }
    return res.result?.value;
  }

  function close() {
    try { ws.close(); } catch {}
  }

  return { send, waitForEvent, evaluate, close };
}

test('Real Headless Chromium/Edge CDP: narrow 320x700 panel layout, scroll, collapse hygiene & themes', { timeout: 60000 }, async (t) => {
  const browserExe = findBrowserExecutable();
  if (!browserExe) {
    t.skip('No Chromium/Edge executable found on this host');
    return;
  }

  const stateSnapshotExists = fs.existsSync(STATE_PATH);
  const stateSnapshotBuf = stateSnapshotExists ? fs.readFileSync(STATE_PATH) : null;
  const tmpUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-cdp-layout-'));

  let app = null;
  let browserProc = null;
  let cdp = null;

  const prevIsolate = process.env.TUNNEL_TEST_ISOLATE_INSTALLED;
  const prevStatePath = process.env.TUNNEL_TEST_STATE_PATH;
  const prevCacheDir = process.env.TUNNEL_CACHE_DIR;
  try {
    const isolatedStatePath = path.join(tmpUserDataDir, 'router-state.json');
    if (stateSnapshotBuf !== null) {
      fs.writeFileSync(isolatedStatePath, stateSnapshotBuf);
    }
    fs.writeFileSync(path.join(tmpUserDataDir, 'plugin.json'), JSON.stringify({ name: 'antigravity-model-router', version: '4.0.9' }), 'utf8');
    process.env.TUNNEL_TEST_STATE_PATH = isolatedStatePath;
    process.env.TUNNEL_CACHE_DIR = path.join(tmpUserDataDir, 'cache');
    process.env.TUNNEL_TEST_ISOLATE_INSTALLED = '1';
    const TestSidecarApp = createTestSidecarAppClass();
    app = await startSidecarPanel({ port: 0, SidecarAppClass: TestSidecarApp, pluginRoot: tmpUserDataDir });
    assert.ok(app && app.port > 0, 'Sidecar panel server must bind an ephemeral port');
    const originUrl = `http://127.0.0.1:${app.port}`;

    const launched = await launchHeadlessBrowser(browserExe, tmpUserDataDir);
    browserProc = launched.proc;
    cdp = await connectCdpClient(launched.pageWsUrl);

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 320,
      height: 700,
      deviceScaleFactor: 1,
      mobile: false,
    });

    const loadFired = cdp.waitForEvent('Page.loadEventFired', null, 15000);
    await cdp.send('Page.navigate', { url: `${originUrl}/` });
    await loadFired;

    // Wait for initial UI hydration (/api/state render)
    await cdp.evaluate(async () => {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const ver = document.getElementById('footerPluginVersion')?.textContent || '';
        const bodyTheme = document.body.getAttribute('data-panel-theme');
        if (/\bv\d+\./.test(ver) && bodyTheme) return true;
        await new Promise((r) => setTimeout(r, 40));
      }
      throw new Error('Timed out waiting for initial panel UI hydration');
    });

    // Dismiss onboarding wizard modal if router-state had onboardingCompleted: false
    await cdp.evaluate(async () => {
      const modal = document.getElementById('onboardingWizardModal');
      if (modal && getComputedStyle(modal).display !== 'none') {
        const closeBtn = modal.querySelector('[data-action="closeOnboardingWizard"]');
        if (closeBtn) closeBtn.click();
        else if (typeof closeOnboardingWizard === 'function') closeOnboardingWizard();
      }
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    });

    // -----------------------------------------------------------------------
    // 2A. Zero Horizontal Overflow (Collapsed baseline at 320x700)
    // -----------------------------------------------------------------------
    const collapsedOverflow = await cdp.evaluate(async (spoilerIds) => {
      for (const id of spoilerIds) {
        const el = document.getElementById(id);
        if (el && el.open) el.open = false;
      }
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return {
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        innerWidth: window.innerWidth,
      };
    }, [...PANEL_SPOILER_IDS]);

    assert.equal(collapsedOverflow.innerWidth, 320, 'Viewport innerWidth must match 320px');
    assert.ok(
      collapsedOverflow.clientWidth >= 295 && collapsedOverflow.clientWidth <= 320,
      `Expected clientWidth in [295, 320] (accounting for optional desktop scrollbar), got ${collapsedOverflow.clientWidth}`,
    );
    assert.ok(
      collapsedOverflow.scrollWidth <= collapsedOverflow.clientWidth + 2,
      `Horizontal overflow when collapsed: scrollWidth=${collapsedOverflow.scrollWidth} > clientWidth+2 (${collapsedOverflow.clientWidth + 2})`,
    );

    // -----------------------------------------------------------------------
    // 1 & 2B. Full Bottom Scroll Reachability + Zero Horizontal Overflow (Expanded)
    // -----------------------------------------------------------------------
    const expandedScrollMetrics = await cdp.evaluate(async () => {
      const hwTabBtn = document.getElementById('fullTabBtn-hardware');
      if (hwTabBtn) {
        hwTabBtn.click();
        await new Promise((r) => setTimeout(r, 80));
      }
      document.querySelectorAll('#gpuRamCard .is-inline-accordion:not(.is-open) [data-action="toggleInlineSection"], #expertRamGpuFieldset.is-inline-accordion:not(.is-open) [data-action="toggleInlineSection"]').forEach((btn) => btn.click());
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

      if (typeof flushVisibleBlockRenders === 'function') {
        flushVisibleBlockRenders();
      }

      const candidates = [
        document.scrollingElement,
        document.documentElement,
        document.body,
        document.querySelector('.lg-shell'),
        document.querySelector('.window-body'),
      ].filter(Boolean);
      const pickScroller = () => candidates.find((el) => el.scrollHeight > el.clientHeight + 4) || document.scrollingElement;

      // Wait until async /api/panel-sections & /api/update renders stabilize scrollHeight
      let stableTicks = 0;
      let prevH = -1;
      const settleDeadline = Date.now() + 4000;
      while (Date.now() < settleDeadline && stableTicks < 4) {
        await new Promise((r) => setTimeout(r, 120));
        const curH = pickScroller().scrollHeight;
        if (curH === prevH && curH > window.innerHeight) stableTicks += 1;
        else {
          stableTicks = 0;
          prevH = curH;
        }
      }

      const scroller = pickScroller();
      for (let pass = 0; pass < 3; pass++) {
        scroller.scrollTop = scroller.scrollHeight;
        if (scroller === document.scrollingElement || scroller === document.documentElement || scroller === document.body) {
          window.scrollTo(0, scroller.scrollHeight);
        }
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      }

      const shellChildren = Array.from(document.querySelectorAll('.lg-shell > *')).filter((el) => {
        const st = getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden') return false;
        const rect = el.getBoundingClientRect();
        return rect.height > 0 && rect.width > 0;
      });
      const lastFooterOrCard = shellChildren[shellChildren.length - 1] || document.querySelector('.status-bar');
      const lastRect = lastFooterOrCard.getBoundingClientRect();
      const statusBarRect = document.querySelector('.status-bar')?.getBoundingClientRect() || null;
      const clientW = document.documentElement.clientWidth;
      const offendingBoxes = Array.from(document.querySelectorAll('.lg-card, .expert-spoiler'))
        .map((el) => {
          const st = getComputedStyle(el);
          if (st.display === 'none' || st.visibility === 'hidden') return null;
          const r = el.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) return null;
          return r.right > clientW + 2
            ? { id: el.id || el.className, right: Math.round(r.right), clientWidth: clientW }
            : null;
        })
        .filter(Boolean);

      return {
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: clientW,
        scrollerTag: scroller.tagName,
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
        scrollTop: scroller.scrollTop,
        innerHeight: window.innerHeight,
        lastRectBottom: lastRect.bottom,
        lastRectHeight: lastRect.height,
        statusBarBottom: statusBarRect ? statusBarRect.bottom : null,
        offendingBoxes,
      };
    });

    assert.ok(
      expandedScrollMetrics.scrollWidth <= expandedScrollMetrics.clientWidth + 2,
      `Horizontal overflow when all spoilers/cards expanded: scrollWidth=${expandedScrollMetrics.scrollWidth} > clientWidth+2 (${expandedScrollMetrics.clientWidth + 2})`,
    );
    assert.deepEqual(
      expandedScrollMetrics.offendingBoxes,
      [],
      `Expanded cards/spoilers overflow viewport width: ${JSON.stringify(expandedScrollMetrics.offendingBoxes)}`,
    );
    assert.ok(
      expandedScrollMetrics.scrollHeight > expandedScrollMetrics.clientHeight,
      `Expected scrollable height when all spoilers are expanded (${expandedScrollMetrics.scrollHeight} <= ${expandedScrollMetrics.clientHeight})`,
    );
    assert.ok(
      expandedScrollMetrics.scrollTop > 0,
      `Expected scrollTop > 0 after scrolling to bottom, got ${expandedScrollMetrics.scrollTop}`,
    );
    assert.ok(
      expandedScrollMetrics.lastRectBottom <= expandedScrollMetrics.innerHeight + 4,
      `Bottom footer/card unreachable: bottom=${expandedScrollMetrics.lastRectBottom} > innerHeight+4 (${expandedScrollMetrics.innerHeight + 4})`,
    );
    if (expandedScrollMetrics.statusBarBottom !== null) {
      assert.ok(
        expandedScrollMetrics.statusBarBottom <= expandedScrollMetrics.innerHeight + 4,
        `Status bar unreachable at bottom: bottom=${expandedScrollMetrics.statusBarBottom}`,
      );
    }

    // -----------------------------------------------------------------------
    // 2C. Zero Right-Edge Overflow on Narrow Controls & Fixed Wizard Bounds
    // -----------------------------------------------------------------------
    const narrowControlsAudit = await cdp.evaluate(async () => {
      const cw = document.documentElement.clientWidth;
      const measureIds = (ids) => ids.map((id) => {
        const el = document.getElementById(id);
        if (!el) return { id, missing: true };
        const rect = el.getBoundingClientRect();
        return {
          id,
          missing: false,
          width: rect.width,
          right: rect.right,
          clientWidth: cw,
        };
      });
      document.getElementById('fullTabBtn-cockpit')?.click();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const items = measureIds(['btnSendSmartComposer']);
      document.getElementById('fullTabBtn-hardware')?.click();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const ollamaCard = document.getElementById('expertRamGpuFieldset');
      if (ollamaCard && !ollamaCard.classList.contains('is-open')) {
        ollamaCard.querySelector('[data-action="toggleInlineSection"]')?.click();
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      }
      items.push(...measureIds([
        'inp-gpuEndpoint',
        'inp-gpuKeepAlive',
        'inp-gpuEmbedKeepAlive',
        'inp-gpuContextTokens',
        'inp-gpuModelsDir',
      ]));
      return { clientWidth: cw, items };
    });

    for (const item of narrowControlsAudit.items) {
      assert.equal(item.missing, false, `Expected control #${item.id} to exist in DOM`);
      assert.ok(item.width > 0, `Expected visible control #${item.id} to have width > 0`);
      assert.ok(
        item.right <= item.clientWidth + 1,
        `Control #${item.id} overflows narrow viewport right edge: right=${item.right} > clientWidth+1 (${item.clientWidth + 1})`,
      );
    }

    // Guard Dock in sticky HUD must handle long BugBot finding paths without horizontal overflow
    const guardDockOverflowAudit = await cdp.evaluate(async () => {
      renderSentinelStatus({
        enabled: true,
        state: 'idle',
        shadowGuard: { errorCount: 0, warnCount: 25, issues: [], coChangeAlerts: [] },
        bugBot: {
          findingsCount: 1,
          findings: [{
            file: '.agents/workflows/video-prep.md',
            lineHint: 'AutoStudio/GoogleFlow_Bot/config/settings.mjs',
            issueRu: 'Длинное описание потенциальной ошибки конфигурации в файле',
          }],
        },
      }, currentState);
      const bugsBtn = document.getElementById('gdFullBtn-bugs');
      if (bugsBtn) bugsBtn.click();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const cw = document.documentElement.clientWidth;
      const sw = document.documentElement.scrollWidth;
      const drawerRect = document.getElementById('fullGuardDrawer')?.getBoundingClientRect();
      renderSentinelStatus({ enabled: true, state: 'idle', shadowGuard: { errorCount: 0, warnCount: 0, issues: [], coChangeAlerts: [] }, bugBot: { findingsCount: 0, findings: [] } }, currentState);
      if (typeof closeGuardDrawer === 'function') closeGuardDrawer('full');
      await new Promise((r) => setTimeout(r, 40));
      return {
        clientWidth: cw,
        scrollWidth: sw,
        drawerRight: drawerRect ? drawerRect.right : 0,
      };
    });

    assert.ok(
      guardDockOverflowAudit.scrollWidth <= guardDockOverflowAudit.clientWidth + 2,
      `Guard Dock long path caused horizontal overflow: scrollWidth=${guardDockOverflowAudit.scrollWidth} > clientWidth+2 (${guardDockOverflowAudit.clientWidth + 2})`,
    );
    assert.ok(
      guardDockOverflowAudit.drawerRight <= guardDockOverflowAudit.clientWidth + 2,
      `#fullGuardDrawer overflowed viewport: drawerRight=${guardDockOverflowAudit.drawerRight} > clientWidth+2 (${guardDockOverflowAudit.clientWidth + 2})`,
    );

    // Verify removed onboarding wizard modal & Setup header button are absent
    const wizardRemovedAudit = await cdp.evaluate(() => ({
      hasModal: Boolean(document.getElementById('onboardingWizardModal')),
      hasSetupBtn: Boolean(document.getElementById('smartBannerSetupBtn')),
    }));
    assert.equal(wizardRemovedAudit.hasModal, false, '#onboardingWizardModal must be removed');
    assert.equal(wizardRemovedAudit.hasSetupBtn, false, '#smartBannerSetupBtn must be removed');

    // -----------------------------------------------------------------------
    // 3. Zero Orphaned Elements Across Category Tab Isolation
    // -----------------------------------------------------------------------
    const orphanAudit = await cdp.evaluate(async () => {
      const inspectElements = (selectors) => selectors.map((sel) => {
        const el = document.querySelector(sel);
        if (!el) return { sel, missing: true };
        return {
          sel,
          missing: false,
          isHtml: el instanceof HTMLElement,
          clientRects: el.getClientRects().length,
          offsetParentNull: el instanceof HTMLElement ? el.offsetParent === null : el.offsetParent == null,
        };
      });

      document.getElementById('fullTabBtn-cockpit')?.click();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

      const hiddenWhileCockpit = inspectElements([
        '#swarmStatusBadge',
        '#metricTotalSaved',
        '#gpuModelsPicker',
        '#sentinelStatusBox',
        '#skillsContainer',
      ]);

      const readOnTab = async (tabId, selectors) => {
        document.getElementById('fullTabBtn-' + tabId)?.click();
        await new Promise((r) => setTimeout(r, 60));
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        return inspectElements(selectors);
      };

      const behaviorInner = await readOnTab('behavior', ['#swarmStatusBadge']);
      const telemetryInner = await readOnTab('economy', ['#metricTotalSaved', '#metricSavedBreakdownGrid']);
      const hwInner = await readOnTab('hardware', ['#hwCardHeaderSummaryBadge', '#ramUnitStateBadge', '#gpuModelsPicker', '#btn-gpuChatModel']);
      const sentinelInner = await readOnTab('bugs', ['#sentinelLiveBadge', '#sentinelStatusBox', '#btnRunSentinelNow']);
      const skillsBody = await readOnTab('settings', ['#skillsSectionCard .skill-search-bar', '#skillsContainer']);

      return {
        hasLegacyTelemetrySpoiler: Boolean(document.getElementById('telemetrySwarmSpoiler')),
        hasLegacyHwSpoiler: Boolean(document.getElementById('hardwareResourcesSpoiler')),
        hiddenWhileCockpit,
        behaviorInner,
        telemetryInner,
        hwInner,
        sentinelInner,
        skillsBody,
      };
    });

    assert.equal(orphanAudit.hasLegacyTelemetrySpoiler, false, 'telemetrySwarmSpoiler wrapper must be removed');
    assert.equal(orphanAudit.hasLegacyHwSpoiler, false, 'hardwareResourcesSpoiler wrapper must be removed');

    for (const item of orphanAudit.hiddenWhileCockpit) {
      assert.equal(item.missing, false, `Expected selector to exist in DOM: ${item.sel}`);
      assert.equal(item.clientRects, 0, `Expected non-active tab element to have 0 clientRects on cockpit: ${item.sel}`);
      assert.equal(item.offsetParentNull, true, `Expected non-active tab element offsetParent === null on cockpit: ${item.sel}`);
    }

    for (const item of [
      ...orphanAudit.behaviorInner,
      ...orphanAudit.telemetryInner,
      ...orphanAudit.hwInner,
      ...orphanAudit.sentinelInner,
      ...orphanAudit.skillsBody,
    ]) {
      assert.equal(item.missing, false, `Expected selector to exist in DOM: ${item.sel}`);
      assert.ok(item.clientRects > 0, `Expected active tab element to be visible: ${item.sel}`);
    }

    // -----------------------------------------------------------------------
    // 4. Single Dark Theme Enforcement & Legacy Theme Normalization (glass_teal)
    // -----------------------------------------------------------------------
    const readThemeStyles = async () => cdp.evaluate(async () => {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const cs = getComputedStyle(document.body);
      return {
        hasThemeGroup: Boolean(document.getElementById('panelThemeGroup')),
        attr: document.body.getAttribute('data-panel-theme'),
        backgroundColor: cs.backgroundColor,
        color: cs.color,
      };
    });

    const initialStyle = await readThemeStyles();
    assert.equal(initialStyle.hasThemeGroup, false, 'Theme switcher group must be removed from header');
    assert.equal(initialStyle.attr, 'glass_teal');

    for (const legacyTheme of ['studio_titanium', 'conductor_paper']) {
      await cdp.evaluate(async (id) => {
        await panelFetch('/api/state', {
          method: 'POST',
          body: JSON.stringify({ panelTheme: id }),
        });
        if (typeof refreshAll === 'function') {
          await refreshAll();
        }
      }, legacyTheme);
      const afterLegacy = await readThemeStyles();
      assert.equal(afterLegacy.attr, 'glass_teal', `Legacy ${legacyTheme} must normalize to glass_teal`);
      assert.equal(loadState().panelTheme, 'glass_teal', `Server router-state should normalize ${legacyTheme} to glass_teal`);
      assert.equal(afterLegacy.backgroundColor, initialStyle.backgroundColor);
      assert.equal(afterLegacy.color, initialStyle.color);
    }

    // -----------------------------------------------------------------------
    // 5. Realistic Desktop User Width (880x1000): Real Mouse Clicks on Nested Spoilers,
    //    Stale-Server Resilience & Zero RAM/GPU/CPU Counter Resets
    // -----------------------------------------------------------------------
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 880,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.evaluate(async (spoilerIds) => {
      try { localStorage.removeItem('ag_tunnel_open_spoilers_v1'); } catch {}
      for (const id of spoilerIds) {
        const el = document.getElementById(id);
        if (el && el.open) el.open = false;
      }
      if (typeof _locallyToggledSpoilers === 'object' && _locallyToggledSpoilers) {
        for (const k of Object.keys(_locallyToggledSpoilers)) delete _locallyToggledSpoilers[k];
      }
      if (typeof _lastAppliedSpoilersMap === 'object' && _lastAppliedSpoilersMap) {
        for (const k of Object.keys(_lastAppliedSpoilersMap)) delete _lastAppliedSpoilersMap[k];
      }
      if (typeof updateState === 'function') {
        await updateState({
          panelCollapsedCards: {},
          panelOpenSpoilers: {},
        });
      }
      if (typeof refreshAll === 'function') {
        await refreshAll();
      }
      await new Promise((r) => setTimeout(r, 200));
    }, [...PANEL_SPOILER_IDS]);

    const noSpoilers = await cdp.evaluate(() => ({
      legacySpoilersCount: document.querySelectorAll('details.expert-spoiler, details.tune-spoiler').length,
    }));
    assert.equal(noSpoilers.legacySpoilersCount, 0, 'All <details> spoilers must be removed in 7-category layout');

    const wideOverflow = await cdp.evaluate(async () => {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return {
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        innerWidth: window.innerWidth,
      };
    });
    assert.equal(wideOverflow.innerWidth, 880, 'Wide viewport innerWidth must match 880px');
    assert.ok(
      wideOverflow.scrollWidth <= wideOverflow.clientWidth + 2,
      `Horizontal overflow at 880x1000: scrollWidth=${wideOverflow.scrollWidth} > clientWidth+2 (${wideOverflow.clientWidth + 2})`,
    );

    const realClickSelector = async (selector) => {
      const pt = await cdp.evaluate(async (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        el.scrollIntoView({ block: 'center' });
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const rc = el.getBoundingClientRect();
        const x = Math.round(rc.left + rc.width / 2);
        const y = Math.round(rc.top + rc.height / 2);
        const hit = document.elementFromPoint(x, y);
        return {
          x,
          y,
          width: Math.round(rc.width),
          height: Math.round(rc.height),
          containsHit: Boolean(hit && (el === hit || el.contains(hit))),
          hitTag: hit?.tagName || '',
        };
      }, selector);
      assert.ok(pt && pt.width > 0 && pt.height > 0, `Clickable target missing or collapsed: ${selector}`);
      assert.equal(pt.containsHit, true, `Click target occluded for ${selector}: ${JSON.stringify(pt)}`);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
      await new Promise((r) => setTimeout(r, 320));
    };

    const hwInitial = await cdp.evaluate(async () => {
      document.getElementById('fullTabBtn-hardware')?.click();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const ollamaCard = document.getElementById('expertRamGpuFieldset');
      if (ollamaCard && !ollamaCard.classList.contains('is-open')) {
        ollamaCard.querySelector('[data-action="toggleInlineSection"]')?.click();
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      }
      if (typeof ensurePanelSectionsLoaded === 'function') {
        await ensurePanelSectionsLoaded(['hw']);
      }
      if (typeof flushVisibleBlockRenders === 'function') {
        flushVisibleBlockRenders();
      }
      if (typeof refreshAll === 'function') {
        await refreshAll();
      }
      if (typeof ensurePanelSectionsLoaded === 'function') {
        await ensurePanelSectionsLoaded(['hw']);
      }
      // Wait for async lazy sections so layout height settles before clicking.
      let stable = 0;
      let prevH = -1;
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline && stable < 3) {
        await new Promise((r) => setTimeout(r, 80));
        const inFlight = typeof _inFlightPanelSections !== 'undefined' ? _inFlightPanelSections.size : 0;
        const h = document.documentElement.scrollHeight;
        if (inFlight === 0 && h === prevH) stable += 1;
        else {
          stable = 0;
          prevH = h;
        }
      }

      window.__hwCounterMutations = [];
      const ids = ['ramUnitMetricVal', 'gpuUnitMetricVal', 'cpuUnitMetricVal', 'ramUnitSavedPill', 'gpuUnitSavedPill', 'cpuUnitSavedPill'];
      const obs = new MutationObserver((muts) => {
        for (const m of muts) {
          const el = m.target.nodeType === 1 ? m.target : m.target.parentElement;
          const id = el?.id || el?.closest?.('[id]')?.id || '?';
          window.__hwCounterMutations.push({
            id,
            type: m.type,
            val: m.type === 'characterData' ? m.target.data : (el?.textContent || ''),
          });
        }
      });
      for (const id of ids) {
        const el = document.getElementById(id);
        if (el) obs.observe(el, { characterData: true, childList: true, subtree: true });
      }
      window.__hwCounterObserver = obs;

      return {
        ram: document.getElementById('ramUnitMetricVal')?.textContent || '',
        gpu: document.getElementById('gpuUnitMetricVal')?.textContent || '',
        cpu: document.getElementById('cpuUnitMetricVal')?.textContent || '',
        ramSaved: document.getElementById('ramUnitSavedPill')?.textContent || '',
        gpuSaved: document.getElementById('gpuUnitSavedPill')?.textContent || '',
        cpuSaved: document.getElementById('cpuUnitSavedPill')?.textContent || '',
      };
    });

    await realClickSelector('#btn-gpuChatModel');

    const afterClicks = await cdp.evaluate(async () => {
      await new Promise((r) => setTimeout(r, 250));
      const openBeforeStale = {
        selectHidden: Boolean(document.getElementById('lgCustomSelectMenu')?.hidden),
        wizVisible: Boolean(document.getElementById('onboardingWizardModal')?.classList.contains('visible')),
        scrollY: window.scrollY,
      };
      if (window.__hwCounterObserver) {
        window.__hwCounterObserver.disconnect();
      }
      return {
        openBeforeStale,
        hwAfter: {
          ram: document.getElementById('ramUnitMetricVal')?.textContent || '',
          gpu: document.getElementById('gpuUnitMetricVal')?.textContent || '',
          cpu: document.getElementById('cpuUnitMetricVal')?.textContent || '',
          ramSaved: document.getElementById('ramUnitSavedPill')?.textContent || '',
          gpuSaved: document.getElementById('gpuUnitSavedPill')?.textContent || '',
          cpuSaved: document.getElementById('cpuUnitSavedPill')?.textContent || '',
        },
        mutations: window.__hwCounterMutations || [],
      };
    });

    assert.equal(afterClicks.openBeforeStale.selectHidden, false, '#lgCustomSelectMenu must open on real mouse click');
    assert.equal(
      afterClicks.mutations.length,
      0,
      `RAM/GPU/CPU counters must NOT reset/mutate on dropdown click, saw: ${JSON.stringify(afterClicks.mutations)}`,
    );
    assert.equal(afterClicks.hwAfter.ram, hwInitial.ram);
    assert.equal(afterClicks.hwAfter.gpu, hwInitial.gpu);
    assert.equal(afterClicks.hwAfter.cpu, hwInitial.cpu);
    assert.equal(afterClicks.hwAfter.ramSaved, hwInitial.ramSaved);
    assert.equal(afterClicks.hwAfter.gpuSaved, hwInitial.gpuSaved);
    assert.equal(afterClicks.hwAfter.cpuSaved, hwInitial.cpuSaved);

    // Regression: transient ramCache.active=false miss must NOT wipe RAM/CPU metrics or trigrams
    const ramMissAudit = await cdp.evaluate(() => {
      const baseState = Object.assign({}, currentState || {}, { ramCacheEnabled: true });
      const baseGpu = (lastPayloadCache && lastPayloadCache.gpu) || null;
      const baseCpu = (lastPayloadCache && lastPayloadCache.cpu) || { hardware: { effectiveMaxThreads: 28, logicalCores: 32 }, telemetry: { workerBatches: 64 }, pool: {}, liveActivity: {} };
      renderGpuAndRam(
        baseGpu,
        {
          enabled: true,
          active: true,
          budgetMb: 32768,
          cacheUsedMb: 42,
          savedTokensEstimate: 12510000,
          workspaces: [{ workspace: 'test-ws', files: 10, cacheMb: 42, trigramsIndexed: 164300 }],
        },
        baseState,
        baseCpu
      );
      const activeSnap = {
        ram: document.getElementById('ramUnitMetricVal')?.textContent || '',
        ramPct: document.getElementById('ramUnitCapPct')?.textContent || '',
      };
      renderGpuAndRam(
        baseGpu,
        { enabled: true, active: false, budgetMb: 32768, cacheUsedMb: 0, savedTokensEstimate: 0, workspaces: [] },
        baseState,
        Object.assign({}, baseCpu, { ramTrigramsIndexed: 0 })
      );
      const afterMissSnap = {
        ram: document.getElementById('ramUnitMetricVal')?.textContent || '',
        ramPct: document.getElementById('ramUnitCapPct')?.textContent || '',
      };
      return { activeSnap, afterMissSnap };
    });
    assert.ok(!ramMissAudit.activeSnap.ram.startsWith('0 /'), `Expected active RAM > 0, got ${ramMissAudit.activeSnap.ram}`);
    assert.ok(ramMissAudit.activeSnap.ramPct && ramMissAudit.activeSnap.ramPct !== '0%', `Expected active RAM pct > 0%, got ${ramMissAudit.activeSnap.ramPct}`);
    assert.equal(ramMissAudit.afterMissSnap.ram, ramMissAudit.activeSnap.ram, 'Transient active:false must preserve RAM metric');
    assert.equal(ramMissAudit.afterMissSnap.ramPct, ramMissAudit.activeSnap.ramPct, 'Transient active:false must preserve RAM pct');

    // Phase 2 Variant C: verify left mini-rail 4 Full tabs + All, embedded progress & draggable Guard Dock/Preset bar fit 320px viewport
    const phase2LayoutAudit = await cdp.evaluate(async () => {
      const cw = document.documentElement.clientWidth;
      const tabs = ['cockpit', 'behavior', 'economy', 'hardware', 'bugs', 'memory', 'settings'];
      const tabMetrics = [];
      for (const t of tabs) {
        const btn = document.getElementById('fullTabBtn-' + t);
        if (btn) btn.click();
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        tabMetrics.push({
          tab: t,
          bodyTab: document.body.getAttribute('data-full-tab'),
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        });
      }
      const railRect = document.getElementById('fullTabsBar')?.getBoundingClientRect() || null;
      const progressParentId = document.getElementById('agLiveProgressWrap')?.parentElement?.id || '';
      const guardParentId = document.getElementById('fullGuardRailWrap')?.parentElement?.id || '';
      const presetParentId = document.getElementById('unifiedPresetBar')?.parentElement?.id || '';
      const guardDragHandle = Boolean(document.querySelector('#fullGuardRailWrap [data-role="drag-handle"]'));
      const presetDragHandle = Boolean(document.querySelector('#unifiedPresetBar [data-role="drag-handle"]'));
      return { cw, tabMetrics, railRight: railRect ? railRect.right : 0, progressParentId, guardParentId, presetParentId, guardDragHandle, presetDragHandle };
    });
    assert.equal(phase2LayoutAudit.progressParentId, 'lgStickyHud', '#agLiveProgressWrap must be embedded in #lgStickyHud');
    assert.equal(phase2LayoutAudit.guardParentId, 'lgStickyHud', '#fullGuardRailWrap must be pinned in #lgStickyHud');
    assert.equal(phase2LayoutAudit.presetParentId, 'fullTabsBar', '#unifiedPresetBar must be pinned in #fullTabsBar');
    assert.equal(phase2LayoutAudit.guardDragHandle, false, '#fullGuardRailWrap must NOT have drag handle when pinned');
    assert.equal(phase2LayoutAudit.presetDragHandle, false, '#unifiedPresetBar must NOT have drag handle when pinned');
    assert.ok(phase2LayoutAudit.railRight <= phase2LayoutAudit.cw + 2, `Left rail overflowed 320px: ${phase2LayoutAudit.railRight}`);
    for (const m of phase2LayoutAudit.tabMetrics) {
      assert.equal(m.bodyTab, m.tab, `Tab button must switch data-full-tab to ${m.tab}`);
      assert.ok(
        m.scrollWidth <= m.clientWidth + 2,
        `Tab ${m.tab} caused horizontal overflow at 320px: scrollWidth=${m.scrollWidth} > clientWidth+2 (${m.clientWidth + 2})`,
      );
    }

    // Regression: Fixed App-Shell keeps #lgStickyHud & #fullTabsBar fixed while .window-body scrolls at 100% and 130% scale
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 760,
      height: 860,
      deviceScaleFactor: 1,
      mobile: false,
    });

    const stickyRailScrollAudit = await cdp.evaluate(async () => {
      if (typeof renderTaskProgressAndHud === 'function') {
        renderTaskProgressAndHud({
          status: 'running',
          activeChats: [
            { conversationId: 'c1', chatNumber: 1, projectName: 'ProjA', workspaceRoot: '/tmp/a', status: 'running', currentStep: 2, totalSteps: 7, percent: 25, stepTitle: 'Step 2' },
            { conversationId: 'c2', chatNumber: 2, projectName: 'ProjB', workspaceRoot: '/tmp/b', status: 'running', currentStep: 1, totalSteps: 4, percent: 15, stepTitle: 'Step 1' },
          ],
        });
      }
      const results = [];
      for (const scaleVal of ['100', '130']) {
        if (typeof applyPanelUiScaleDom === 'function') applyPanelUiScaleDom(scaleVal, false);
        const settingsBtn = document.getElementById('fullTabBtn-settings');
        if (settingsBtn) settingsBtn.click();
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const safetyAcc = document.getElementById('safetyContoursSection');
        if (safetyAcc && !safetyAcc.classList.contains('is-open')) {
          safetyAcc.querySelector('[data-action="toggleInlineSection"]')?.click();
        }
        await new Promise((r) => setTimeout(r, 60));

        const scroller = document.querySelector('.full-workspace-shell > .window-body') || document.scrollingElement;
        const guardCard = document.getElementById('expertGuardrailsCard');
        const guardCardBorderTop = guardCard ? getComputedStyle(guardCard).borderTopWidth : '';
        const hudBefore = document.getElementById('lgStickyHud').getBoundingClientRect();
        const railBefore = document.getElementById('fullTabsBar').getBoundingClientRect();

        scroller.scrollTop = 280;
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

        const hudRect = document.getElementById('lgStickyHud').getBoundingClientRect();
        const railRect = document.getElementById('fullTabsBar').getBoundingClientRect();
        const cockpitRect = document.getElementById('fullTabBtn-cockpit').getBoundingClientRect();
        const shellRect = document.querySelector('.lg-shell').getBoundingClientRect();
        results.push({
          scaleVal,
          windowScrollY: window.scrollY,
          bodyScrollTop: Math.round(scroller.scrollTop),
          hudHeight: Math.round(hudRect.height),
          hudTopBefore: Math.round(hudBefore.top),
          hudTopAfter: Math.round(hudRect.top),
          hudBottom: Math.round(hudRect.bottom),
          railTopBefore: Math.round(railBefore.top),
          railTop: Math.round(railRect.top),
          cockpitTop: Math.round(cockpitRect.top),
          shellBottom: Math.round(shellRect.bottom),
          innerHeight: window.innerHeight,
          guardCardBorderTop,
        });
        scroller.scrollTop = 0;
      }
      return results;
    });

    for (const r of stickyRailScrollAudit) {
      assert.equal(r.guardCardBorderTop, '0px', `Embedded category rubrics must have 0px border at scale=${r.scaleVal}`);
      assert.equal(r.windowScrollY, 0, `Outer window must stay fixed (scrollY=0) at scale=${r.scaleVal}, got ${r.windowScrollY}`);
      assert.ok(r.bodyScrollTop > 100, `Expected .window-body to scroll at scale=${r.scaleVal}, got scrollTop=${r.bodyScrollTop}`);
      assert.ok(r.hudHeight > 160, `Expected tall sticky HUD (>160px) with 2 active chats at scale=${r.scaleVal}, got ${r.hudHeight}`);
      assert.equal(r.hudTopAfter, r.hudTopBefore, `HUD must not shift vertically on scroll at scale=${r.scaleVal}`);
      assert.equal(r.railTop, r.railTopBefore, `Left rail must not shift vertically on scroll at scale=${r.scaleVal}`);
      assert.ok(r.shellBottom <= r.innerHeight + 2, `Fixed .lg-shell overflowed viewport bottom at scale=${r.scaleVal}: ${r.shellBottom} > ${r.innerHeight}`);
      assert.ok(
        r.railTop >= r.hudBottom - 1,
        `Left rail overlapped fixed HUD at scale=${r.scaleVal}: railTop=${r.railTop} < hudBottom=${r.hudBottom}`,
      );
      assert.ok(
        r.cockpitTop >= r.hudBottom - 1,
        `Cockpit button ('Пульт') covered by fixed HUD at scale=${r.scaleVal}: cockpitTop=${r.cockpitTop} < hudBottom=${r.hudBottom}`,
      );
    }

    // Regression audit: stale-tab snapback protection, advisor/autopilot box mutual exclusion, scroll reset & opacity, narrow 380px/460px rail
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
    const regressionAudit = await cdp.evaluate(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const wb = document.querySelector('.full-workspace-shell > .window-body');
      if (typeof applyPanelUiScaleDom === 'function') applyPanelUiScaleDom('100', false);

      // 1. Stale renderPayload must not snap user back from selected tab
      document.getElementById('fullTabBtn-behavior')?.click();
      await sleep(180);
      if (typeof renderPayload === 'function' && typeof currentState === 'object') {
        renderPayload({ state: Object.assign({}, currentState, { panelFullTab: 'cockpit' }) });
      }
      const tabAfterStale = document.body.getAttribute('data-full-tab');

      // 2. Advisor vs Autopilot sub-settings mutual exclusion
      const advCard = document.getElementById('mode-advisor');
      const autoCard = document.getElementById('mode-autopilot');
      const advBox = document.getElementById('advisorBox');
      const autoBox = document.getElementById('autopilotBox');
      autoCard?.click();
      await sleep(280);
      const onAuto = {
        advDisp: advBox ? getComputedStyle(advBox).display : '',
        advH: advBox ? Math.round(advBox.getBoundingClientRect().height) : -1,
        autoDisp: autoBox ? getComputedStyle(autoBox).display : '',
        autoH: autoBox ? Math.round(autoBox.getBoundingClientRect().height) : -1,
      };
      advCard?.click();
      await sleep(280);
      const onAdv = {
        advDisp: advBox ? getComputedStyle(advBox).display : '',
        advH: advBox ? Math.round(advBox.getBoundingClientRect().height) : -1,
        autoDisp: autoBox ? getComputedStyle(autoBox).display : '',
        autoH: autoBox ? Math.round(autoBox.getBoundingClientRect().height) : -1,
      };

      // 3. Scroll reset & zero stuck opacity:0 on visible tabs
      if (wb) wb.scrollTop = 220;
      document.getElementById('fullTabBtn-bugs')?.click();
      await sleep(320);
      const scrollAfterSwitch = wb ? Math.round(wb.scrollTop) : -1;

      const stuckZeroOpacity = [];
      for (const tab of ['behavior', 'bugs', 'settings']) {
        document.getElementById('fullTabBtn-' + tab)?.click();
        await sleep(320);
        const cards = Array.from(document.querySelectorAll(`.window-body > [data-tab-panel="${tab}"]`));
        for (const c of cards) {
          for (const el of [c, ...Array.from(c.querySelectorAll('.settings-group-list, .sunken-box'))]) {
            const cs = getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden') continue;
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0 && parseFloat(cs.opacity) < 0.99) {
              stuckZeroOpacity.push({ tab, id: el.id || el.className, op: cs.opacity });
            }
          }
        }
      }
      return { tabAfterStale, onAuto, onAdv, scrollAfterSwitch, stuckZeroOpacity };
    });

    assert.equal(regressionAudit.tabAfterStale, 'behavior', 'Stale renderPayload must not snap user back from behavior tab');
    assert.equal(regressionAudit.onAuto.advDisp, 'none', 'Advisor sub-settings must hide when Autopilot is active');
    assert.equal(regressionAudit.onAuto.advH, 0, 'Advisor sub-settings height must be 0 when hidden');
    assert.ok(regressionAudit.onAuto.autoH > 20, 'Autopilot sub-settings must be visible when active');
    assert.equal(regressionAudit.onAdv.autoDisp, 'none', 'Autopilot sub-settings must hide when Advisor is active');
    assert.equal(regressionAudit.onAdv.autoH, 0, 'Autopilot sub-settings height must be 0 when hidden');
    assert.ok(regressionAudit.onAdv.advH > 100, 'Advisor sub-settings must be visible when active');
    assert.equal(regressionAudit.scrollAfterSwitch, 0, 'Tab switch must reset .window-body scrollTop to 0');
    assert.deepEqual(regressionAudit.stuckZeroOpacity, [], 'No visible card/container may remain stuck at opacity < 1');

    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 460, height: 760, deviceScaleFactor: 1, mobile: false });
    const guard460 = await cdp.evaluate(async () => {
      await new Promise((r) => setTimeout(r, 120));
      const gr = document.getElementById('fullGuardButtons');
      return gr ? { scrollW: gr.scrollWidth, clientW: gr.clientWidth } : null;
    });
    assert.ok(guard460 && guard460.scrollW <= guard460.clientW + 2, `Guard rail overflowed at 460px: ${JSON.stringify(guard460)}`);

    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 380, height: 740, deviceScaleFactor: 1, mobile: false });
    const rail380 = await cdp.evaluate(async () => {
      await new Promise((r) => setTimeout(r, 120));
      return Array.from(document.querySelectorAll('#fullTabsBar .full-rail-btn')).map((b) => ({
        id: b.id,
        w: Math.round(b.getBoundingClientRect().width),
      }));
    });
    for (const btn of rail380) {
      const minW = btn.id === 'fullTabBtn-hardware' ? 36 : 48;
      assert.ok(btn.w >= minW, `Rail button ${btn.id} crushed at 380px: width=${btn.w} < ${minW}`);
    }
  } finally {
    if (prevStatePath === undefined) delete process.env.TUNNEL_TEST_STATE_PATH;
    else process.env.TUNNEL_TEST_STATE_PATH = prevStatePath;
    if (prevCacheDir === undefined) delete process.env.TUNNEL_CACHE_DIR;
    else process.env.TUNNEL_CACHE_DIR = prevCacheDir;
    if (prevIsolate === undefined) delete process.env.TUNNEL_TEST_ISOLATE_INSTALLED;
    else process.env.TUNNEL_TEST_ISOLATE_INSTALLED = prevIsolate;
    if (cdp) cdp.close();
    if (browserProc) killBrowserProcess(browserProc);
    if (app) {
      try {
        await app.close();
      } catch {
        try { app.server?.close?.(); } catch {}
      }
    }

    try {
      fs.rmSync(tmpUserDataDir, { recursive: true, force: true });
    } catch {}
  }
});

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

  try {
    const isolatedStatePath = path.join(tmpUserDataDir, 'router-state.json');
    if (stateSnapshotBuf !== null) {
      fs.writeFileSync(isolatedStatePath, stateSnapshotBuf);
    }
    process.env.TUNNEL_TEST_STATE_PATH = isolatedStatePath;
    process.env.TUNNEL_CACHE_DIR = path.join(tmpUserDataDir, 'cache');
    const TestSidecarApp = createTestSidecarAppClass();
    app = await startSidecarPanel({ port: 0, SidecarAppClass: TestSidecarApp });
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
        if (ver.includes('3.') && bodyTheme) return true;
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
    const expandedScrollMetrics = await cdp.evaluate(async (spoilerIds, cardIds) => {
      for (const id of spoilerIds) {
        const el = document.getElementById(id);
        if (el && !el.open) {
          const summary = el.querySelector('summary');
          if (summary) summary.click();
          if (!el.open) el.open = true;
          await new Promise((r) => setTimeout(r, 25));
        }
      }

      for (const cardId of cardIds) {
        const card = document.getElementById(cardId);
        if (card && card.classList.contains('is-collapsed')) {
          const btn = card.querySelector('.lg-card-collapse-btn');
          if (btn) btn.click();
          else card.classList.remove('is-collapsed');
          await new Promise((r) => setTimeout(r, 25));
        }
      }

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

      return {
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        scrollerTag: scroller.tagName,
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
        scrollTop: scroller.scrollTop,
        innerHeight: window.innerHeight,
        lastRectBottom: lastRect.bottom,
        lastRectHeight: lastRect.height,
        statusBarBottom: statusBarRect ? statusBarRect.bottom : null,
      };
    }, [...PANEL_SPOILER_IDS], [...COLLAPSIBLE_PANEL_CARD_IDS]);

    assert.ok(
      expandedScrollMetrics.scrollWidth <= expandedScrollMetrics.clientWidth + 2,
      `Horizontal overflow when all spoilers/cards expanded: scrollWidth=${expandedScrollMetrics.scrollWidth} > clientWidth+2 (${expandedScrollMetrics.clientWidth + 2})`,
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
    const narrowControlsAudit = await cdp.evaluate(() => {
      const ids = [
        'btnSendSmartComposer',
        'inp-gpuEndpoint',
        'inp-gpuChatModel',
        'inp-gpuEmbedModel',
        'inp-gpuKeepAlive',
        'inp-gpuEmbedKeepAlive',
        'inp-gpuContextTokens',
        'inp-gpuModelsDir',
      ];
      const cw = document.documentElement.clientWidth;
      const items = ids.map((id) => {
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

    const wizardLayoutAudit = await cdp.evaluate(async () => {
      const setupBtn = document.getElementById('smartBannerSetupBtn');
      if (!setupBtn) throw new Error('smartBannerSetupBtn not found');
      setupBtn.click();
      const modal = document.getElementById('onboardingWizardModal');
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        if (modal && modal.classList.contains('visible') && getComputedStyle(modal).display !== 'none') break;
        await new Promise((r) => setTimeout(r, 20));
      }
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const modalRect = modal.getBoundingClientRect();
      const footerEl = modal.querySelector('.wiz-footer');
      const nextBtn = document.getElementById('wizNextBtn');
      const footerRect = footerEl ? footerEl.getBoundingClientRect() : null;
      const nextRect = nextBtn ? nextBtn.getBoundingClientRect() : null;
      const result = {
        visible: modal.classList.contains('visible'),
        parentTag: modal.parentElement ? modal.parentElement.tagName : null,
        innerHeight: window.innerHeight,
        modalHeight: modalRect.height,
        modalBottom: modalRect.bottom,
        footerTop: footerRect ? footerRect.top : null,
        footerBottom: footerRect ? footerRect.bottom : null,
        nextBottom: nextRect ? nextRect.bottom : null,
      };
      const closeBtn = modal.querySelector('[data-action="closeOnboardingWizard"]');
      if (closeBtn) closeBtn.click();
      else if (typeof closeOnboardingWizard === 'function') closeOnboardingWizard();
      const closeDeadline = Date.now() + 2000;
      while (Date.now() < closeDeadline) {
        if (!modal.classList.contains('visible') && getComputedStyle(modal).display === 'none') break;
        await new Promise((r) => setTimeout(r, 20));
      }
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return result;
    });

    assert.equal(wizardLayoutAudit.visible, true, 'Onboarding wizard modal must open');
    assert.equal(wizardLayoutAudit.parentTag, 'BODY', '#onboardingWizardModal must be a direct child of <body>, outside .lg-shell');
    assert.ok(
      wizardLayoutAudit.modalHeight <= wizardLayoutAudit.innerHeight + 1,
      `Wizard modal stretched past viewport height: height=${wizardLayoutAudit.modalHeight} > innerHeight (${wizardLayoutAudit.innerHeight})`,
    );
    assert.ok(
      wizardLayoutAudit.modalBottom <= wizardLayoutAudit.innerHeight + 1,
      `Wizard modal bottom overflows viewport: bottom=${wizardLayoutAudit.modalBottom} > innerHeight (${wizardLayoutAudit.innerHeight})`,
    );
    assert.ok(
      wizardLayoutAudit.footerTop !== null && wizardLayoutAudit.footerTop >= 0,
      `Wizard footer top out of viewport: top=${wizardLayoutAudit.footerTop}`,
    );
    assert.ok(
      wizardLayoutAudit.footerBottom !== null && wizardLayoutAudit.footerBottom <= wizardLayoutAudit.innerHeight + 1,
      `Wizard footer pushed below viewport fold: bottom=${wizardLayoutAudit.footerBottom} > innerHeight (${wizardLayoutAudit.innerHeight})`,
    );
    assert.ok(
      wizardLayoutAudit.nextBottom !== null && wizardLayoutAudit.nextBottom <= wizardLayoutAudit.innerHeight + 1,
      `Wizard Next button pushed below viewport fold: bottom=${wizardLayoutAudit.nextBottom} > innerHeight (${wizardLayoutAudit.innerHeight})`,
    );

    // -----------------------------------------------------------------------
    // 3. Zero Orphaned Child Badges on Collapse (Flat Cards + Remaining Spoilers)
    // -----------------------------------------------------------------------
    const orphanAudit = await cdp.evaluate(async () => {
      const swarmCard = document.getElementById('swarmTelemetryCard');
      const hwCard = document.getElementById('gpuRamCard');
      const sentinelCard = document.getElementById('sentinelSectionCard');
      const skillsCard = document.getElementById('skillsSectionCard');
      if (typeof updateState === 'function') {
        await updateState({
          panelOpenSpoilers: {},
          panelCollapsedCards: {
            ...(typeof currentState === 'object' && currentState ? currentState.panelCollapsedCards : {}),
            skillsSectionCard: true,
            swarmTelemetryCard: true,
            gpuRamCard: true,
            sentinelSectionCard: true,
          },
        });
      }
      let closedStable = 0;
      const closeDeadline = Date.now() + 3000;
      while (Date.now() < closeDeadline && closedStable < 3) {
        for (const c of [swarmCard, hwCard, sentinelCard, skillsCard]) {
          if (c && !c.classList.contains('is-collapsed')) c.classList.add('is-collapsed');
        }
        await new Promise((r) => setTimeout(r, 80));
        if (
          [swarmCard, hwCard, sentinelCard, skillsCard].every((c) => !c || c.classList.contains('is-collapsed'))
        ) {
          closedStable += 1;
        } else {
          closedStable = 0;
        }
      }
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

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

      const headerPills = inspectElements([
        '#metricCacheHitBadge',
        '#swarmStatusBadge',
        '#hwCardHeaderSummaryBadge',
        '#sentinelLiveBadge',
      ]);

      const telemetryInner = inspectElements([
        '#metricTotalSaved',
        '#metricSavedBreakdownGrid',
        '#quotaPacerBadge',
      ]);

      const hwInner = inspectElements([
        '#ramUnitStateBadge',
        '#gpuUnitStateBadge',
        '#cpuUnitStateBadge',
        '#gpuUnitSavedPill',
        '#gpuModelsPicker',
        '#btn-gpuChatModel',
        '#btn-gpuChatModel .lg-select-chevron',
      ]);

      const sentinelInner = inspectElements([
        '#sentinelStatusBox',
        '#btnRunSentinelNow',
        '#sentinelHealthVal',
      ]);

      const skillsBody = inspectElements([
        '#skillsSectionCard .skill-search-bar',
        '#skillsContainer',
      ]);

      return {
        hasLegacyTelemetrySpoiler: Boolean(document.getElementById('telemetrySwarmSpoiler')),
        hasLegacyHwSpoiler: Boolean(document.getElementById('hardwareResourcesSpoiler')),
        swarmCollapsed: swarmCard?.classList.contains('is-collapsed') ?? false,
        hwCollapsed: hwCard?.classList.contains('is-collapsed') ?? false,
        sentinelCollapsed: sentinelCard?.classList.contains('is-collapsed') ?? false,
        skillsCollapsed: skillsCard?.classList.contains('is-collapsed') ?? false,
        headerPills,
        telemetryInner,
        hwInner,
        sentinelInner,
        skillsBody,
      };
    });

    assert.equal(orphanAudit.hasLegacyTelemetrySpoiler, false, 'telemetrySwarmSpoiler wrapper must be removed');
    assert.equal(orphanAudit.hasLegacyHwSpoiler, false, 'hardwareResourcesSpoiler wrapper must be removed');
    assert.equal(orphanAudit.swarmCollapsed, true, 'swarmTelemetryCard should be collapsed');
    assert.equal(orphanAudit.hwCollapsed, true, 'gpuRamCard should be collapsed');
    assert.equal(orphanAudit.sentinelCollapsed, true, 'sentinelSectionCard should be collapsed');
    assert.equal(orphanAudit.skillsCollapsed, true, 'skillsSectionCard should be collapsed');

    for (const pill of orphanAudit.headerPills) {
      assert.equal(pill.missing, false, `Expected header pill to exist in DOM: ${pill.sel}`);
      assert.ok(pill.clientRects > 0, `Expected collapsed card header pill to remain visible: ${pill.sel}`);
    }

    for (const item of [
      ...orphanAudit.telemetryInner,
      ...orphanAudit.hwInner,
      ...orphanAudit.sentinelInner,
      ...orphanAudit.skillsBody,
    ]) {
      assert.equal(item.missing, false, `Expected selector to exist in DOM: ${item.sel}`);
      assert.equal(item.clientRects, 0, `Orphaned visible rect inside collapsed card for ${item.sel}`);
      assert.equal(item.offsetParentNull, true, `Expected offsetParent === null inside collapsed card for ${item.sel}`);
    }

    // -----------------------------------------------------------------------
    // 4. Real Theme CSS Application (glass_teal, studio_titanium, conductor_paper)
    // -----------------------------------------------------------------------
    const applyThemeAndReadStyles = async (themeId, mode) => cdp.evaluate(async (id, applyMode) => {
      if (applyMode === 'click') {
        const btn = document.querySelector(`#panelThemeGroup button[data-theme="${id}"]`);
        if (!btn) throw new Error(`Theme button not found for ${id}`);
        btn.click();
      } else {
        await panelFetch('/api/state', {
          method: 'POST',
          body: JSON.stringify({ panelTheme: id }),
        });
        if (typeof refreshAll === 'function') {
          await refreshAll();
        }
      }

      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        const attr = document.body.getAttribute('data-panel-theme');
        if (applyMode === 'click' ? attr === id : Boolean(attr)) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const cs = getComputedStyle(document.body);
      return {
        attr: document.body.getAttribute('data-panel-theme'),
        backgroundColor: cs.backgroundColor,
        color: cs.color,
      };
    }, themeId, mode);

    const glassStyle = await applyThemeAndReadStyles('glass_teal', 'click');
    const studioStyle = await applyThemeAndReadStyles('studio_titanium', 'click');
    // Reset back to dark glass_teal before testing legacy conductor_paper API normalization
    await applyThemeAndReadStyles('glass_teal', 'click');
    const conductorStyle = await applyThemeAndReadStyles('conductor_paper', 'api');

    assert.equal(glassStyle.attr, 'glass_teal');
    assert.equal(studioStyle.attr, 'studio_titanium');
    assert.equal(conductorStyle.attr, 'studio_titanium', 'Legacy conductor_paper must map to studio_titanium via /api/state');
    assert.equal(loadState().panelTheme, 'studio_titanium', 'Server router-state should persist canonical studio_titanium');

    assert.notEqual(
      glassStyle.backgroundColor,
      studioStyle.backgroundColor,
      `Expected distinct body backgroundColor between glass_teal (${glassStyle.backgroundColor}) and studio_titanium (${studioStyle.backgroundColor})`,
    );
    assert.notEqual(
      glassStyle.color,
      studioStyle.color,
      `Expected distinct body text color between glass_teal (${glassStyle.color}) and studio_titanium (${studioStyle.color})`,
    );
    assert.notEqual(
      glassStyle.backgroundColor,
      conductorStyle.backgroundColor,
      `Expected conductor_paper to switch body backgroundColor away from glass_teal (${glassStyle.backgroundColor})`,
    );
    assert.equal(
      conductorStyle.backgroundColor,
      studioStyle.backgroundColor,
      'conductor_paper light palette should match canonical studio_titanium background',
    );
  } finally {
    delete process.env.TUNNEL_TEST_STATE_PATH;
    delete process.env.TUNNEL_CACHE_DIR;
    if (cdp) cdp.close();
    if (browserProc) killBrowserProcess(browserProc);
    if (app) {
      try {
        await app.close();
      } catch {
        try { app.server?.close?.(); } catch {}
      }
    }

    if (stateSnapshotBuf === null) {
      if (fs.existsSync(STATE_PATH)) fs.unlinkSync(STATE_PATH);
    } else if (!fs.existsSync(STATE_PATH) || !fs.readFileSync(STATE_PATH).equals(stateSnapshotBuf)) {
      fs.writeFileSync(STATE_PATH, stateSnapshotBuf);
    }

    try {
      fs.rmSync(tmpUserDataDir, { recursive: true, force: true });
    } catch {}
  }
});

#!/usr/bin/env node
/**
 * @file capture-shorts-ru-media.mjs
 * @description Non-destructive live Russian UI & WebGL2 Project Map frame capture
 *              for the 25s vertical Shorts/Reels promo video (`.cache/shorts-ru-frames/`).
 */

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const OUT_ROOT = path.join(ROOT_DIR, '.cache', 'shorts-ru-frames');

function findBrowserExecutable() {
  const envOverride = process.env.CDP_BROWSER_PATH || process.env.CHROME_PATH || process.env.EDGE_PATH;
  if (envOverride && fs.existsSync(envOverride)) return envOverride;
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || '';
  const candidates = process.platform === 'win32'
    ? [
        path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ]
    : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

function createIsolatedSidecarAppClass() {
  return class IsolatedSidecarApp {
    constructor() {
      this._pages = new Map();
      this._apis = new Map();
      this._server = null;
    }
    page(p, handler) { this._pages.set(p, handler); }
    api(p, handler, method = 'POST') {
      if (!this._apis.has(p)) this._apis.set(p, new Map());
      this._apis.get(p).set(method.toUpperCase(), handler);
    }
    get port() { return this._server?.address()?.port || 0; }
    run() {
      const server = http.createServer(async (req, res) => {
        const u = new URL(req.url || '/', 'http://127.0.0.1');
        if (req.method === 'GET' && u.pathname === '/preload.js') {
          res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
          res.end('/* shorts ru capture preload */');
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
              if (result && typeof result === 'object' && result.contentType && result.body !== undefined) {
                res.writeHead(result.status || 200, {
                  'Content-Type': result.contentType,
                  ...(result.headers || {}),
                });
                res.end(result.body);
                return;
              }
              res.writeHead(typeof result?.status === 'number' ? result.status : 200, {
                'Content-Type': 'application/json; charset=utf-8',
              });
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
      return new Promise((resolveListen) => server.listen(0, '127.0.0.1', () => resolveListen(server)));
    }
    close() {
      const srv = this._server;
      this._server = null;
      if (!srv) return Promise.resolve();
      try { srv.closeAllConnections?.(); } catch {}
      return new Promise((resolveClose) => srv.close(() => resolveClose()));
    }
  };
}

function killBrowser(proc) {
  if (!proc) return;
  try { if (!proc.killed) proc.kill('SIGKILL'); } catch {}
  if (process.platform === 'win32' && proc.pid) {
    try { execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', timeout: 5000 }); } catch {}
  }
}

async function launchBrowserCdp(browserExe, userDataDir) {
  const proc = spawn(browserExe, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=0',
    '--window-size=1080,960',
    '--force-color-profile=srgb',
    `--user-data-dir=${userDataDir}`,
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

  const { cdpPort } = await new Promise((resolveUrl, rejectUrl) => {
    let logs = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; rejectUrl(new Error(`CDP timeout:\n${logs}`)); }
    }, 15000);
    proc.once('error', (err) => {
      if (!settled) { settled = true; clearTimeout(timer); rejectUrl(err); }
    });
    const onData = (chunk) => {
      if (settled) return;
      logs += chunk.toString('utf8');
      const m = logs.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:(\d+)\/[^\s\r\n]+)/i);
      if (m) { settled = true; clearTimeout(timer); resolveUrl({ cdpPort: Number(m[2]) }); }
    };
    proc.stderr?.on('data', onData);
    proc.stdout?.on('data', onData);
  });

  let pageWsUrl = null;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && !pageWsUrl) {
    try {
      const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
      if (res.ok) {
        const list = await res.json();
        const t = Array.isArray(list) ? list.find((x) => x?.type === 'page' && x?.webSocketDebuggerUrl) : null;
        if (t) pageWsUrl = t.webSocketDebuggerUrl;
      }
    } catch {}
    if (!pageWsUrl) await new Promise((r) => setTimeout(r, 80));
  }
  if (!pageWsUrl) { killBrowser(proc); throw new Error('No CDP page target found'); }

  const ws = new WebSocket(pageWsUrl);
  await new Promise((resolveOpen, rejectOpen) => {
    const timer = setTimeout(() => rejectOpen(new Error('CDP WS open timeout')), 10000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolveOpen(); }, { once: true });
    ws.addEventListener('error', (e) => { clearTimeout(timer); rejectOpen(e?.error || new Error('CDP WS error')); }, { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  const waiters = new Set();

  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(String(ev.data)); } catch { return; }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject, timer } = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(timer);
      if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else resolve(msg.result);
    } else if (msg.method) {
      for (const w of [...waiters]) {
        if (w.method === msg.method) {
          waiters.delete(w);
          clearTimeout(w.timer);
          w.resolve(msg.params);
        }
      }
    }
  });

  const send = (method, params = {}, timeoutMs = 20000) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });

  const waitForEvent = (method, timeoutMs = 15000) => new Promise((resolve, reject) => {
    const w = { method, resolve, timer: null };
    w.timer = setTimeout(() => { waiters.delete(w); reject(new Error(`CDP event timeout: ${method}`)); }, timeoutMs);
    waiters.add(w);
  });

  const evaluate = async (fn, ...args) => {
    const expression = `(${fn.toString()})(...${JSON.stringify(args)})`;
    const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, 25000);
    if (res?.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'CDP eval error');
    }
    return res?.result?.value;
  };

  return {
    send,
    waitForEvent,
    evaluate,
    close() {
      try { ws.close(); } catch {}
      killBrowser(proc);
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function captureFrameBurst(cdp, framesDir, startIdx, count, intervalMs = 50) {
  let idx = startIdx;
  for (let i = 0; i < count; i++) {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    if (shot?.data) {
      fs.writeFileSync(path.join(framesDir, `frame-${String(idx).padStart(4, '0')}.png`), Buffer.from(shot.data, 'base64'));
      idx++;
    }
    if (intervalMs > 0 && i < count - 1) await sleep(intervalMs);
  }
  return idx;
}

async function moveCursorSmooth(cdp, toX, toY, framesDir, startIdx, steps = 5) {
  let idx = startIdx;
  for (let s = 1; s <= steps; s++) {
    const p = s / steps;
    const ease = 1 - Math.pow(1 - p, 3);
    await cdp.evaluate((x, y, t) => {
      if (window.__demoCursor) window.__demoCursor.moveInterp(x, y, t);
    }, toX, toY, ease);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    if (shot?.data) {
      fs.writeFileSync(path.join(framesDir, `frame-${String(idx).padStart(4, '0')}.png`), Buffer.from(shot.data, 'base64'));
      idx++;
    }
  }
  return idx;
}

async function animateMapCamera(cdp, framesDir, startIdx, {
  fromX, fromY, fromScale, toX, toY, toScale, steps = 14,
  cursorScreenX = null, cursorScreenY = null,
} = {}) {
  let idx = startIdx;
  for (let s = 1; s <= steps; s++) {
    const u = s / steps;
    const ease = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
    const cx = fromX + (toX - fromX) * ease;
    const cy = fromY + (toY - fromY) * ease;
    const cs = fromScale + (toScale - fromScale) * ease;
    await cdp.evaluate((x, y, sc, curX, curY) => {
      if (typeof pgState === 'object' && pgState) {
        pgState.camX = x;
        pgState.camY = y;
        pgState.camScale = sc;
        if (typeof pgDrawGraph === 'function') pgDrawGraph();
      }
      if (curX !== null && curY !== null && window.__demoCursor) {
        window.__demoCursor.move(curX, curY);
      }
    }, cx, cy, cs, cursorScreenX, cursorScreenY);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    if (shot?.data) {
      fs.writeFileSync(path.join(framesDir, `frame-${String(idx).padStart(4, '0')}.png`), Buffer.from(shot.data, 'base64'));
      idx++;
    }
  }
  return idx;
}

async function main() {
  const browserExe = findBrowserExecutable();
  if (!browserExe) throw new Error('Headless Chromium/Edge binary not found');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-shorts-ru-cap-'));
  const isoStatePath = path.join(tmpDir, 'router-state.json');
  const isoCacheDir = path.join(tmpDir, 'cache');
  const cockpitFramesDir = path.join(OUT_ROOT, 'cockpit');
  const graphFramesDir = path.join(OUT_ROOT, 'map');

  fs.rmSync(OUT_ROOT, { recursive: true, force: true });
  fs.mkdirSync(isoCacheDir, { recursive: true });
  fs.mkdirSync(cockpitFramesDir, { recursive: true });
  fs.mkdirSync(graphFramesDir, { recursive: true });

  const baseState = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'router-state.json'), 'utf8'));
  const demoState = {
    ...baseState,
    uiLanguage: 'ru',
    panelTheme: 'glass_teal',
    panelViewMode: 'full',
    panelFullTab: 'cockpit',
    hardwareProfiled: true,
    onboardingCompleted: true,
    subscriptionTier: 'ultra',
    ramCacheEnabled: true,
    ramMaxBudgetMb: 16384,
    cpuMulticoreEnabled: true,
    cpuMaxThreads: 16,
    gpuEnabled: true,
    gpuMaxVramMb: 12288,
    sentinelEnabled: true,
    quotaPacerEnabled: true,
    autoSpecMode: 'auto',
    autoSpecOutput: 'thinking',
    debugLogMode: 'errors',
  };
  fs.writeFileSync(isoStatePath, JSON.stringify(demoState, null, 2), 'utf8');

  const prevEnv = {
    TUNNEL_TEST_STATE_PATH: process.env.TUNNEL_TEST_STATE_PATH,
    TUNNEL_CACHE_DIR: process.env.TUNNEL_CACHE_DIR,
    TUNNEL_TEST_ISOLATE_INSTALLED: process.env.TUNNEL_TEST_ISOLATE_INSTALLED,
  };
  process.env.TUNNEL_TEST_STATE_PATH = isoStatePath;
  process.env.TUNNEL_CACHE_DIR = isoCacheDir;
  process.env.TUNNEL_TEST_ISOLATE_INSTALLED = '1';

  const { startSidecarPanel } = await import('../sidecars/panel/server.mjs');
  const { destroyOllamaKeepAliveAgents } = await import('../core/gpu/gpu-shared-state.mjs');
  const { shutdownCpuPool } = await import('../core/cpu-worker-pool.mjs');

  let app = null;
  let cdp = null;

  try {
    console.log('[1/3] Запуск изолированной панели в русском интерфейсе (RU) и Edge CDP...');
    const SidecarAppCls = createIsolatedSidecarAppClass();
    app = await startSidecarPanel({ port: 0, SidecarAppClass: SidecarAppCls });
    const originUrl = `http://127.0.0.1:${app.port}`;
    cdp = await launchBrowserCdp(browserExe, path.join(tmpDir, 'profile'));

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 880, height: 740, deviceScaleFactor: 1, mobile: false });

    const load1 = cdp.waitForEvent('Page.loadEventFired', 15000);
    await cdp.send('Page.navigate', { url: `${originUrl}/` });
    await load1;

    await cdp.evaluate(async () => {
      const deadline = Date.now() + 12000;
      while (Date.now() < deadline) {
        const ver = document.getElementById('footerPluginVersion')?.textContent || '';
        const theme = document.body.getAttribute('data-panel-theme');
        if (/\bv\d+\./.test(ver) && theme) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      if (typeof setUiLanguage === 'function') await setUiLanguage('ru');
      if (typeof setPanelFullTab === 'function') setPanelFullTab('cockpit', { silent: true });
      await new Promise((r) => setTimeout(r, 400));

      const SHOWCASE_CHAT_HTML =
        '<div class="ag-chat-task-item" style="padding:7px 10px;border:1px solid rgba(255,255,255,0.09);border-radius:5px;background:#0c0d10;margin-top:4px;">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:11.5px;">' +
        '<span style="display:inline-flex;align-items:center;gap:6px;min-width:0;overflow:hidden;"><span style="width:7px;height:7px;border-radius:50%;background:#f04848;flex:none;"></span><span style="background:#2a1417;color:#f04848;border:1px solid rgba(240,72,72,0.5);padding:1px 6px;border-radius:3px;font-weight:700;font-size:10px;flex:none;">Чат #1</span><strong style="color:#f3f4f6;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">@file:core/ram-memory-engine.mjs · 3D-анализ влияния</strong></span>' +
        '<span style="font-family:ui-monospace,monospace;color:#f04848;font-weight:700;flex:none;">74%</span></div>' +
        '<div style="height:4px;background:#1a1c22;border-radius:2px;margin-top:6px;overflow:hidden;"><div style="width:74%;height:100%;background:#f04848;"></div></div>' +
        '</div>';

      const cleanLivePanelForShowcase = () => {
        const convoPill = document.getElementById('agProgressProjectBadge') || document.getElementById('convoShortId');
        if (convoPill) convoPill.textContent = 'Все чаты · Автопилот';
        const heading = document.getElementById('agProgressHeadingText');
        if (heading) heading.textContent = 'ПРОГРЕСС ЗАДАЧ (1)';
        const progressList = document.getElementById('agActiveChatsStack');
        if (progressList && progressList.getAttribute('data-showcase-clean') !== '1') {
          progressList.innerHTML = SHOWCASE_CHAT_HTML;
          progressList.setAttribute('data-showcase-clean', '1');
        }
        const hwCard = document.getElementById('gpuRamCard');
        if (hwCard) {
          const walker = document.createTreeWalker(hwCard, NodeFilter.SHOW_TEXT);
          let tNode;
          while ((tNode = walker.nextNode())) {
            if (/RTX\s*40\d\d|GeForce|Radeon/i.test(tNode.nodeValue || '')) {
              tNode.nodeValue = tNode.nodeValue.replace(/(?:NVIDIA\s+)?(?:GeForce\s+)?RTX\s*\d{4}(?:\s*Ti)?(?:\s*SUPER)?/gi, 'Локальный Ollama GPU');
            }
          }
        }
        const ramPill = document.getElementById('topRamLivePill');
        const ramTxt = document.getElementById('topRamLiveText');
        if (ramPill && ramTxt) {
          ramPill.classList.remove('is-off');
          ramPill.classList.add('is-on');
          ramTxt.textContent = 'ОЗУ · Прогрето (239ф)';
        }
        const cpuPill = document.getElementById('topCpuLivePill');
        const cpuTxt = document.getElementById('topCpuLiveText');
        if (cpuPill && cpuTxt) {
          cpuPill.classList.remove('is-off');
          cpuPill.classList.add('is-on');
          cpuTxt.textContent = 'ЦП · 16 потоков';
        }
        const gpuPill = document.getElementById('topGpuLivePill');
        const gpuTxt = document.getElementById('topGpuLiveText');
        if (gpuPill && gpuTxt) {
          gpuPill.classList.remove('is-off');
          gpuPill.classList.add('is-on');
          gpuTxt.textContent = 'GPU · gemma4:12b';
        }
      };

      const origFetch = window.fetch.bind(window);
      window.fetch = async function (input, init) {
        const u = typeof input === 'string' ? input : (input?.url || '');
        if (/\/api\/progress\b/.test(u)) {
          return new Response(JSON.stringify({ ok: true, chats: [], activeCount: 0, recentCompleted: [] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return origFetch(input, init);
      };
      const stackEl = document.getElementById('agActiveChatsStack');
      if (stackEl) {
        new MutationObserver(() => {
          if (stackEl.innerHTML !== SHOWCASE_CHAT_HTML) {
            stackEl.innerHTML = SHOWCASE_CHAT_HTML;
          }
        }).observe(stackEl, { childList: true, subtree: true });
      }
      window.__cleanShowcase = () => {
        const s = document.getElementById('agActiveChatsStack');
        if (s) s.removeAttribute('data-showcase-clean');
        cleanLivePanelForShowcase();
      };
      for (let tid = 1; tid < 5000; tid++) { try { clearInterval(tid); } catch {} }
      cleanLivePanelForShowcase();

      if (!document.getElementById('demoCursorStyle')) {
        const st = document.createElement('style');
        st.id = 'demoCursorStyle';
        st.textContent =
          '#demoCursor{position:fixed;z-index:999999;pointer-events:none;width:24px;height:24px;transform:translate(-2px,-2px);display:none;}' +
          '#demoRipple{position:fixed;z-index:999998;pointer-events:none;width:44px;height:44px;border-radius:50%;border:2.5px solid #f04848;background:rgba(240,72,72,0.22);transform:translate(-50%,-50%) scale(0.3);opacity:0;}';
        document.head.appendChild(st);
        const cur = document.createElement('div');
        cur.id = 'demoCursor';
        cur.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M4 3l14 7.5-6.2 1.9L9.4 19 4 3z" fill="#f3f4f6" stroke="#f04848" stroke-width="1.8" stroke-linejoin="round"/></svg>';
        const rip = document.createElement('div');
        rip.id = 'demoRipple';
        document.body.appendChild(cur);
        document.body.appendChild(rip);
        let curX = 360, curY = 280, startX = 360, startY = 280;
        window.__demoCursor = {
          beginMove: () => { startX = curX; startY = curY; },
          move(x, y) {
            curX = x; curY = y;
            cur.style.display = 'block';
            cur.style.left = Math.round(x) + 'px';
            cur.style.top = Math.round(y) + 'px';
          },
          moveInterp(toX, toY, t) { this.move(startX + (toX - startX) * t, startY + (toY - startY) * t); },
          ripple(x, y, phase) {
            rip.style.left = Math.round(x) + 'px';
            rip.style.top = Math.round(y) + 'px';
            rip.style.opacity = String(Math.max(0, 1 - phase));
            rip.style.transform = 'translate(-50%,-50%) scale(' + (0.35 + phase * 1.05).toFixed(2) + ')';
          },
          hideRipple() { rip.style.opacity = '0'; },
          hide() { cur.style.display = 'none'; rip.style.opacity = '0'; },
          centerOf(sel) {
            const el = document.querySelector(sel);
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
          },
        };
      }
      const ta = document.getElementById('smartComposerInput');
      if (ta) { ta.value = ''; ta.dispatchEvent(new Event('input', { bubbles: true })); }
      if (window.__demoCursor) window.__demoCursor.move(380, 260);
      if (typeof flushVisibleBlockRenders === 'function') flushVisibleBlockRenders();
      cleanLivePanelForShowcase();
    });

    const cockpitClicks = [];
    const cockpitTypeFrames = [];
    let cIdx = 1;

    const moveAndClick = async (selector, framesDir, idxRef, clickList, label, clickActionFn) => {
      const pt = await cdp.evaluate((sel) => {
        if (!window.__demoCursor) return null;
        window.__demoCursor.beginMove();
        return window.__demoCursor.centerOf(sel);
      }, selector);
      let idx = idxRef;
      if (pt) {
        idx = await moveCursorSmooth(cdp, pt.x, pt.y, framesDir, idx, 5);
        await cdp.evaluate((x, y) => window.__demoCursor?.ripple(x, y, 0.15), pt.x, pt.y);
        clickList.push({ frame: idx, label });
      }
      if (clickActionFn) await clickActionFn();
      if (pt) {
        idx = await captureFrameBurst(cdp, framesDir, idx, 2, 40);
        await cdp.evaluate(() => window.__demoCursor?.hideRipple());
      }
      return idx;
    };

    console.log('[2/3] Запись живой русской панели управления (880x740)...');
    cIdx = await captureFrameBurst(cdp, cockpitFramesDir, cIdx, 5, 45);
    cIdx = await moveAndClick('#smartComposerInput', cockpitFramesDir, cIdx, cockpitClicks, 'click_composer', async () => {
      await cdp.evaluate(() => document.getElementById('smartComposerInput')?.focus());
    });

    const draftSteps = [
      'Рефакторинг @file:core/ram-memory-engine.mjs',
      'Рефакторинг @file:core/ram-memory-engine.mjs @file:core/project-graph-builder.mjs',
      'Рефакторинг @file:core/ram-memory-engine.mjs @file:core/project-graph-builder.mjs — 3D-радиус влияния',
    ];
    for (const d of draftSteps) {
      cockpitTypeFrames.push(cIdx);
      await cdp.evaluate(async (txt) => {
        const ta = document.getElementById('smartComposerInput');
        if (ta) { ta.value = txt; ta.dispatchEvent(new Event('input', { bubbles: true })); }
        await new Promise((r) => setTimeout(r, 110));
      }, d);
      cIdx = await captureFrameBurst(cdp, cockpitFramesDir, cIdx, 5, 45);
    }

    const cockpitMilestones = { composerEndFrame: cIdx - 1, behaviorStartFrame: cIdx };
    cIdx = await moveAndClick('#fullTabBtn-behavior', cockpitFramesDir, cIdx, cockpitClicks, 'tab_behavior', async () => {
      await cdp.evaluate(async () => {
        if (typeof setPanelFullTab === 'function') setPanelFullTab('behavior', { silent: true });
        await new Promise((r) => setTimeout(r, 240));
        if (typeof window.__cleanShowcase === 'function') window.__cleanShowcase();
      });
    });
    cIdx = await captureFrameBurst(cdp, cockpitFramesDir, cIdx, 10, 45);

    cockpitMilestones.hardwareStartFrame = cIdx;
    cIdx = await moveAndClick('#fullTabBtn-hardware', cockpitFramesDir, cIdx, cockpitClicks, 'tab_hardware', async () => {
      await cdp.evaluate(async () => {
        if (typeof setPanelFullTab === 'function') setPanelFullTab('hardware', { silent: true });
        await new Promise((r) => setTimeout(r, 240));
        if (typeof window.__cleanShowcase === 'function') window.__cleanShowcase();
      });
    });
    cIdx = await captureFrameBurst(cdp, cockpitFramesDir, cIdx, 10, 45);

    cockpitMilestones.guardStartFrame = cIdx;
    cIdx = await moveAndClick('#fullTabBtn-bugs', cockpitFramesDir, cIdx, cockpitClicks, 'tab_bugs', async () => {
      await cdp.evaluate(async () => {
        if (typeof setPanelFullTab === 'function') setPanelFullTab('bugs', { silent: true });
        await new Promise((r) => setTimeout(r, 240));
        if (typeof window.__cleanShowcase === 'function') window.__cleanShowcase();
      });
    });
    cIdx = await captureFrameBurst(cdp, cockpitFramesDir, cIdx, 9, 45);

    // === CAPTURE B: LIVE RUSSIAN WEBGL2 PROJECT MAP (980x900 portrait-friendly) ===
    console.log('[3/3] Запись живой русской WebGL2-карты проекта (980x900)...');
    await cdp.evaluate(() => window.__demoCursor?.hide());
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 980, height: 900, deviceScaleFactor: 1, mobile: false });

    const graphMeta = await cdp.evaluate(async () => {
      if (typeof openProjectGraphModal === 'function') await openProjectGraphModal({ inlineOnly: true });
      const deadline = Date.now() + 14000;
      while (Date.now() < deadline) {
        if (typeof pgState !== 'undefined' && Array.isArray(pgState.nodes) && pgState.nodes.length > 0 && !pgState.loading) break;
        await new Promise((r) => setTimeout(r, 80));
      }
      await new Promise((r) => setTimeout(r, 650));
      return {
        folderNodes: pgState?.nodes?.length || 0,
        folderEdges: pgState?.edges?.length || 0,
        stats: document.getElementById('pgStatsPill')?.textContent?.trim() || '',
      };
    });

    const mapClicks = [];
    let gIdx = 1;
    gIdx = await captureFrameBurst(cdp, graphFramesDir, gIdx, 6, 45);

    // Click Files level
    gIdx = await moveAndClick('#pgLevelFilesBtn', graphFramesDir, gIdx, mapClicks, 'map_files', async () => {
      await cdp.evaluate(async () => {
        if (typeof pgSetViewLevel === 'function') await pgSetViewLevel('files');
        await new Promise((r) => setTimeout(r, 700));
      });
    });

    const filesMeta = await cdp.evaluate(() => {
      const candidates = (pgState.nodes || []).filter((n) => !n.isFolder);
      const preferred =
        candidates.find((n) => n.id === 'core/ram-memory-engine.mjs') ||
        candidates.find((n) => n.id === 'core/safe-json.mjs') ||
        candidates.sort((a, b) => ((b.inDeg || 0) + (b.outDeg || 0)) - ((a.inDeg || 0) + (a.outDeg || 0)))[0];
      return {
        fileNodes: pgState?.nodes?.length || 0,
        fileEdges: pgState?.edges?.length || 0,
        hubId: preferred?.id || '',
        hubX: preferred?.x || 0,
        hubY: preferred?.y || 0,
        baseCamX: pgState?.camX || 0,
        baseCamY: pgState?.camY || 0,
        baseCamScale: pgState?.camScale || 1,
      };
    });
    gIdx = await captureFrameBurst(cdp, graphFramesDir, gIdx, 5, 45);

    // Zoom in onto Hub node + hover tooltip
    gIdx = await animateMapCamera(cdp, graphFramesDir, gIdx, {
      fromX: filesMeta.baseCamX,
      fromY: filesMeta.baseCamY,
      fromScale: filesMeta.baseCamScale,
      toX: filesMeta.hubX - 30,
      toY: filesMeta.hubY,
      toScale: Math.min(2.6, filesMeta.baseCamScale * 2.2),
      steps: 14,
      cursorScreenX: 340,
      cursorScreenY: 420,
    });

    const nodeScreenPt = await cdp.evaluate((hubId) => {
      const node = pgState.nodeById?.get(hubId) || pgState.nodes?.[0];
      if (!node) return null;
      if (typeof pgSelectNode === 'function') pgSelectNode(node.id);
      const sx = (node.x - pgState.camX) * pgState.camScale + pgState.width / 2;
      const sy = (node.y - pgState.camY) * pgState.camScale + pgState.height / 2;
      if (typeof pgUpdateHoverTooltip === 'function') pgUpdateHoverTooltip(node, sx, sy);
      if (typeof pgDrawGraph === 'function') pgDrawGraph();
      const canvasRect = document.getElementById('projectGraphCanvas')?.getBoundingClientRect();
      return { x: (canvasRect?.left || 0) + sx, y: (canvasRect?.top || 0) + sy };
    }, filesMeta.hubId);
    if (nodeScreenPt) {
      gIdx = await moveCursorSmooth(cdp, nodeScreenPt.x, nodeScreenPt.y, graphFramesDir, gIdx, 4);
      mapClicks.push({ frame: gIdx, label: 'map_select_hub' });
    }
    gIdx = await captureFrameBurst(cdp, graphFramesDir, gIdx, 8, 45);

    const mapMilestones = { blastStartFrame: gIdx };
    // Blast & Diff lens + Add wave to cart
    gIdx = await moveAndClick('#pgLensBlastBtn', graphFramesDir, gIdx, mapClicks, 'map_lens_blast', async () => {
      await cdp.evaluate(async (hubId) => {
        if (typeof pgUpdateHoverTooltip === 'function') pgUpdateHoverTooltip(null, 0, 0);
        if (typeof pgSetLens === 'function') await pgSetLens('blast');
        await new Promise((r) => setTimeout(r, 300));
        if (hubId && typeof pgSelectNode === 'function') pgSelectNode(hubId);
        await new Promise((r) => setTimeout(r, 200));
      }, filesMeta.hubId);
    });
    const blastCam = await cdp.evaluate(() => ({ x: pgState?.camX || 0, y: pgState?.camY || 0, scale: pgState?.camScale || 1 }));
    gIdx = await animateMapCamera(cdp, graphFramesDir, gIdx, {
      fromX: blastCam.x,
      fromY: blastCam.y,
      fromScale: blastCam.scale,
      toX: filesMeta.hubX - 70,
      toY: filesMeta.hubY,
      toScale: Math.min(2.1, filesMeta.baseCamScale * 1.55),
      steps: 12,
    });
    gIdx = await moveAndClick('[data-action="pgAddBlastWaveToCart"]', graphFramesDir, gIdx, mapClicks, 'map_add_wave_cart', async () => {
      await cdp.evaluate(async () => {
        if (typeof pgAddBlastWaveToCart === 'function') pgAddBlastWaveToCart();
        await new Promise((r) => setTimeout(r, 220));
      });
    });
    gIdx = await captureFrameBurst(cdp, graphFramesDir, gIdx, 8, 45);

    mapMilestones.hotspotsStartFrame = gIdx;
    // Hotspots lens
    gIdx = await moveAndClick('#pgLensHotspotsBtn', graphFramesDir, gIdx, mapClicks, 'map_lens_hotspots', async () => {
      await cdp.evaluate(async () => {
        pgState.mode = 'global';
        pgState.focusFile = '';
        if (typeof pgSetLens === 'function') await pgSetLens('hotspots');
        await new Promise((r) => setTimeout(r, 550));
      });
    });
    const hotCam = await cdp.evaluate(() => ({ x: pgState?.camX || 0, y: pgState?.camY || 0, scale: pgState?.camScale || 1 }));
    gIdx = await animateMapCamera(cdp, graphFramesDir, gIdx, {
      fromX: hotCam.x,
      fromY: hotCam.y,
      fromScale: hotCam.scale,
      toX: filesMeta.hubX - 50,
      toY: filesMeta.hubY,
      toScale: Math.min(2.1, filesMeta.baseCamScale * 1.55),
      steps: 9,
    });
    gIdx = await captureFrameBurst(cdp, graphFramesDir, gIdx, 7, 45);

    mapMilestones.symbolsStartFrame = gIdx;
    // AST Symbols Call Graph
    gIdx = await moveAndClick('#pgLevelSymbolsBtn', graphFramesDir, gIdx, mapClicks, 'map_symbols', async () => {
      await cdp.evaluate(async (hubId) => {
        if (typeof pgSetLens === 'function') await pgSetLens('arch');
        await new Promise((r) => setTimeout(r, 140));
        if (typeof pgOpenFileSymbols === 'function') {
          await pgOpenFileSymbols(hubId || 'core/ram-memory-engine.mjs');
        } else if (typeof pgOpenSymbolsForSelected === 'function') {
          pgOpenSymbolsForSelected();
        }
        await new Promise((r) => setTimeout(r, 800));
      }, filesMeta.hubId);
    });
    gIdx = await captureFrameBurst(cdp, graphFramesDir, gIdx, 5, 45);

    const symTarget = await cdp.evaluate(() => {
      const nodes = pgState?.nodes || [];
      const hub = nodes.find((n) => /RamMemoryEngine/i.test(n.label || n.id || '')) ||
        nodes.sort((a, b) => ((b.inDeg || 0) + (b.outDeg || 0)) - ((a.inDeg || 0) + (a.outDeg || 0)))[0];
      return {
        fromX: pgState?.camX || 0,
        fromY: pgState?.camY || 0,
        fromScale: pgState?.camScale || 1,
        toX: hub ? hub.x - 80 : 0,
        toY: hub ? hub.y : 0,
      };
    });
    gIdx = await animateMapCamera(cdp, graphFramesDir, gIdx, {
      fromX: symTarget.fromX,
      fromY: symTarget.fromY,
      fromScale: symTarget.fromScale,
      toX: symTarget.toX,
      toY: symTarget.toY,
      toScale: Math.min(2.4, symTarget.fromScale * 2.05),
      steps: 14,
    });
    await cdp.evaluate(() => window.__demoCursor?.hide());
    gIdx = await captureFrameBurst(cdp, graphFramesDir, gIdx, 9, 45);

    const manifest = {
      generatedAt: new Date().toISOString(),
      cockpit: {
        width: 880,
        height: 740,
        frameCount: cIdx - 1,
        milestones: cockpitMilestones,
        clicks: cockpitClicks,
        typeFrames: cockpitTypeFrames,
      },
      map: {
        width: 980,
        height: 900,
        frameCount: gIdx - 1,
        milestones: mapMilestones,
        clicks: mapClicks,
        graphMeta,
        filesMeta,
      },
    };
    fs.writeFileSync(path.join(OUT_ROOT, 'shorts-ru-metrics.json'), JSON.stringify(manifest, null, 2), 'utf8');
    console.log('✓ Захват русского UI завершён:', JSON.stringify({
      cockpitFrames: manifest.cockpit.frameCount,
      mapFrames: manifest.map.frameCount,
      fileNodes: filesMeta.fileNodes,
      fileEdges: filesMeta.fileEdges,
    }));
  } finally {
    try { cdp?.close?.(); } catch {}
    try { await app?.close?.(); } catch {}
    try { await shutdownCpuPool(); } catch {}
    try { destroyOllamaKeepAliveAgents(); } catch {}
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  const self = path.resolve(__filename);
  const arg = path.resolve(process.argv[1]);
  return process.platform === 'win32' ? self.toLowerCase() === arg.toLowerCase() : self === arg;
})();
if (isMain) {
  main().catch((err) => {
    console.error('[capture-shorts-ru-media] FAILED:', err);
    process.exit(1);
  });
}

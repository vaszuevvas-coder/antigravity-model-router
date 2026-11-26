#!/usr/bin/env node
/**
 * @file run-mega-diagnostic.mjs
 * @description Unified 6-contour 360-degree Mega-Diagnostic CLI for The Tunnel v4.0.2:
 *   1. Hygiene & Manifests (UI build check, version sync, Skill-Architect, GitHub Guard)
 *   2. Static, Security, Contracts & Sandboxed Fuzzing (Deep Stress Auditor --fuzz)
 *   3. 8 Practical Cross-System Missions (tests/mega-cross-system-e2e.test.mjs)
 *   4. Full Regression Suite (all tests/*.test.mjs unless --quick)
 *   5. Live Local RTX GPU + Ollama + CPU Worker Pool Probe (--live-gpu)
 *   6. Live Headless Chromium/Edge CDP Full Panel & Project Graph Walkthrough (--live-cdp)
 */

import { execFile, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

export function parseMegaDiagnosticArgs(argv = []) {
  const list = Array.isArray(argv) ? argv : [];
  let liveGpu = false;
  let liveCdp = false;
  let quick = false;
  let json = false;
  let screenshotsDir = '';
  for (const rawArg of list) {
    const a = String(rawArg || '').trim();
    if (a === '--live-gpu') liveGpu = true;
    else if (a === '--live-cdp') liveCdp = true;
    else if (a === '--quick') quick = true;
    else if (a === '--json') json = true;
    else if (a.startsWith('--screenshots-dir=')) {
      screenshotsDir = a.slice('--screenshots-dir='.length).trim().replace(/^["']|["']$/g, '');
    }
  }
  return { liveGpu, liveCdp, quick, json, screenshotsDir };
}

async function runNodeStep(label, args, { envExtra = {}, timeoutMs = 180000 } = {}) {
  const t0 = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, args, {
      cwd: ROOT_DIR,
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, ...envExtra },
    });
    return {
      ok: true,
      label,
      elapsedMs: Date.now() - t0,
      stdout: String(stdout || ''),
      stderr: String(stderr || ''),
    };
  } catch (err) {
    return {
      ok: false,
      label,
      elapsedMs: Date.now() - t0,
      exitCode: err?.code ?? 1,
      stdout: String(err?.stdout || ''),
      stderr: String(err?.stderr || ''),
      error: err?.message || 'Command failed',
    };
  }
}

function findBrowserExecutable() {
  const envOverride = process.env.CDP_BROWSER_PATH || process.env.CHROME_PATH || process.env.EDGE_PATH;
  if (envOverride && fs.existsSync(envOverride)) return envOverride;
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
    );
  } else {
    candidates.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge');
  }
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

function createIsolatedSidecarAppClass() {
  return class DiagnosticSidecarApp {
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
          res.end('/* diagnostic preload stub */');
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

function killBrowserProc(proc) {
  if (!proc) return;
  try {
    if (!proc.killed) proc.kill('SIGKILL');
  } catch {}
  if (process.platform === 'win32' && proc.pid) {
    try {
      execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', timeout: 5000 });
    } catch {}
  }
}

async function launchBrowserCdp(browserExe, userDataDir) {
  const proc = spawn(
    browserExe,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--remote-debugging-port=0',
      '--window-size=420,860',
      `--user-data-dir=${userDataDir}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
  );

  const cdpPort = await new Promise((resolvePort, rejectPort) => {
    let logs = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      rejectPort(new Error(`CDP launch timeout:\n${logs}`));
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
    proc.once('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPort(err);
    });
  });

  let pageWsUrl = '';
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && !pageWsUrl) {
    try {
      const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
      if (res.ok) {
        const list = await res.json();
        const page = Array.isArray(list) ? list.find((it) => it?.type === 'page' && it?.webSocketDebuggerUrl) : null;
        if (page) pageWsUrl = page.webSocketDebuggerUrl;
      }
    } catch {}
    if (!pageWsUrl) await new Promise((r) => setTimeout(r, 80));
  }
  if (!pageWsUrl) {
    killBrowserProc(proc);
    throw new Error('Could not discover CDP page WebSocket URL');
  }

  const ws = new WebSocket(pageWsUrl);
  await new Promise((resolveOpen, rejectOpen) => {
    const timer = setTimeout(() => rejectOpen(new Error('WebSocket CDP connect timeout')), 10000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolveOpen(); }, { once: true });
    ws.addEventListener('error', (err) => { clearTimeout(timer); rejectOpen(err?.error || new Error('WS error')); }, { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  const eventWaiters = new Set();
  const runtimeErrors = [];
  const httpErrors = [];

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
    if (msg.method === 'Runtime.exceptionThrown') {
      const desc = msg.params?.exceptionDetails?.exception?.description || msg.params?.exceptionDetails?.text || 'Runtime exception';
      runtimeErrors.push(desc);
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
      const txt = (msg.params?.args || []).map((a) => a?.value || a?.description || '').join(' ').trim();
      if (txt) runtimeErrors.push(`console.error: ${txt}`);
    } else if (msg.method === 'Network.responseReceived') {
      const status = Number(msg.params?.response?.status || 0);
      const url = String(msg.params?.response?.url || '');
      if (status >= 400 && !url.includes('favicon.ico')) {
        httpErrors.push(`${status} ${url}`);
      }
    }
    if (msg.method) {
      for (const w of Array.from(eventWaiters)) {
        if (w.method === msg.method && (!w.predicate || w.predicate(msg.params || {}))) {
          eventWaiters.delete(w);
          clearTimeout(w.timer);
          w.resolve(msg.params || {});
        }
      }
    }
  });

  const send = (method, params = {}, timeoutMs = 15000) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP ${method} timed out`));
      }, timeoutMs);
      pending.set(id, { method, resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  };

  const waitForEvent = (method, predicate = null, timeoutMs = 15000) =>
    new Promise((resolve, reject) => {
      const w = {
        method,
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          eventWaiters.delete(w);
          reject(new Error(`CDP event ${method} timed out`));
        }, timeoutMs),
      };
      eventWaiters.add(w);
    });

  const evaluate = async (fn, ...args) => {
    const expression = `(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(',')})`;
    const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'Runtime.evaluate error');
    }
    return res.result?.value;
  };

  return {
    proc,
    send,
    waitForEvent,
    evaluate,
    runtimeErrors,
    httpErrors,
    close: () => {
      try { ws.close(); } catch {}
      killBrowserProc(proc);
    },
  };
}

async function runContour5LiveGpu() {
  const t0 = Date.now();
  const [
    {
      getGpuStatusSnapshot,
      embedTexts,
      peekWarmSemanticSkills,
      distillText,
      destroyOllamaKeepAliveAgents,
    },
    { runCpuBatch, shutdownCpuPool },
  ] = await Promise.all([
    import('../core/local-gpu-engine.mjs'),
    import('../core/cpu-worker-pool.mjs'),
  ]);

  try {
    const status = await getGpuStatusSnapshot({ force: true });
    const ollamaRunning = Boolean(status?.ollama?.running);
    const gpuName = status?.hardware?.name || 'unknown';
    if (!ollamaRunning) {
      return {
        ok: false,
        elapsedMs: Date.now() - t0,
        error: 'Ollama server is not reachable on configured loopback endpoint',
        gpuName,
      };
    }

    const embedT0 = Date.now();
    const embedRes = await embedTexts(['Проверка семантического поиска и маршрутизации моделей'], 'query', { timeoutMs: 12000 });
    const embedMs = Date.now() - embedT0;
    if (!embedRes.ok || !Array.isArray(embedRes.embeddings) || embedRes.embeddings.length !== 1) {
      return { ok: false, elapsedMs: Date.now() - t0, error: embedRes.error || 'embedTexts failed', gpuName };
    }

    const skillT0 = Date.now();
    const skillRes = await peekWarmSemanticSkills('Проведи глубокий стресс-аудит безопасности и гонок', {
      topK: 3,
      timeoutMs: 4000,
      wsAbsRoot: ROOT_DIR,
    });
    const skillMs = Date.now() - skillT0;

    const sampleTrace = Array.from({ length: 45 }, (_, i) =>
      `[INFO] worker_${i} health check 200 OK latency=${10 + i}ms`
    )
      .concat([
        'TypeError: Cannot read properties of undefined (reading "workspaceRoot")',
        '    at handlePreToolUse (core/hook-runner.mjs:2530:18)',
        '    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)',
      ])
      .join('\n');

    const distillT0 = Date.now();
    const distillRes = await distillText({
      text: sampleTrace,
      mode: 'error_log',
      query: 'Find the root exception and failing file',
      maxOutputTokens: 180,
      timeoutMs: 25000,
      skipThermalGuard: true,
    });
    const distillMs = Date.now() - distillT0;
    if (!distillRes.ok || !distillRes.summary) {
      return { ok: false, elapsedMs: Date.now() - t0, error: distillRes.error || 'distillText failed', gpuName };
    }

    const cpuItems = Array.from({ length: 26 }, (_, i) => ({
      relPath: `mod${i}.mjs`,
      ext: '.mjs',
      text: `export function checkNode${i}(val) { return Boolean(val); }\n`,
    }));
    const cpuOut = await runCpuBatch('parseMetadataBatch', cpuItems, { minItemsForWorkers: 25, skipTelemetry: true });

    return {
      ok: cpuOut.length === 26,
      elapsedMs: Date.now() - t0,
      gpuName,
      vramUsedMb: status?.hardware?.usedMb ?? 0,
      vramTotalMb: status?.hardware?.totalMb ?? 0,
      chatModel: status?.config?.gpuChatModel || '',
      embedModel: status?.config?.gpuEmbedModel || '',
      embedMs,
      embedDim: embedRes.embeddings[0]?.length || 0,
      skillMs,
      semanticSkillsMatched: (skillRes?.semanticSkills || []).map((s) => `${s.slug}:${s.score}`),
      distillMs,
      distillChars: `${sampleTrace.length}->${distillRes.summary.length}`,
      cpuBatchItems: cpuOut.length,
    };
  } finally {
    try { await shutdownCpuPool(); } catch {}
    try { destroyOllamaKeepAliveAgents(); } catch {}
  }
}

async function runContour6LiveCdp(screenshotsDir = '') {
  const t0 = Date.now();
  const browserExe = findBrowserExecutable();
  if (!browserExe) {
    return { ok: false, elapsedMs: Date.now() - t0, error: 'No Chromium/Edge binary found for CDP walkthrough' };
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-mega-cdp-'));
  const isoStatePath = path.join(tmpDir, 'router-state.json');
  const isoCacheDir = path.join(tmpDir, 'cache');
  fs.mkdirSync(isoCacheDir, { recursive: true });

  const baseState = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'router-state.json'), 'utf8'));
  fs.writeFileSync(
    isoStatePath,
    JSON.stringify({ ...baseState, uiLanguage: 'ru', panelViewMode: 'full', panelTheme: 'glass_teal', onboardingCompleted: true }, null, 2),
    'utf8'
  );

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
  const capturedScreenshots = [];

  try {
    const SidecarAppCls = createIsolatedSidecarAppClass();
    app = await startSidecarPanel({ port: 0, SidecarAppClass: SidecarAppCls });
    const originUrl = `http://127.0.0.1:${app.port}`;
    cdp = await launchBrowserCdp(browserExe, path.join(tmpDir, 'browser-profile'));

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');

    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 420, height: 860, deviceScaleFactor: 1, mobile: false });
    const loadDone = cdp.waitForEvent('Page.loadEventFired', null, 15000);
    await cdp.send('Page.navigate', { url: `${originUrl}/` });
    await loadDone;

    await cdp.evaluate(async () => {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const ver = document.getElementById('footerPluginVersion')?.textContent || '';
        const theme = document.body.getAttribute('data-panel-theme');
        if (/\bv\d+\./.test(ver) && theme) return true;
        await new Promise((r) => setTimeout(r, 40));
      }
      throw new Error('Panel UI hydration timeout');
    });

    const savePng = async (name) => {
      if (!screenshotsDir) return;
      fs.mkdirSync(screenshotsDir, { recursive: true });
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      if (shot?.data) {
        const outFile = path.join(screenshotsDir, name);
        fs.writeFileSync(outFile, Buffer.from(shot.data, 'base64'));
        capturedScreenshots.push(outFile);
      }
    };

    await cdp.evaluate(async () => {
      if (typeof flushVisibleBlockRenders === 'function') flushVisibleBlockRenders();
      await new Promise((r) => setTimeout(r, 250));
    });
    await savePng('cdp-panel-full-ru.png');

    // Check narrow 360px + EN/RU + Lite/Full + scale cycling
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 380, height: 780, deviceScaleFactor: 1, mobile: false });
    const layoutMetrics = await cdp.evaluate(async () => {
      const checks = [];
      const measure = (tag) => {
        checks.push({
          tag,
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        });
      };
      measure('full_ru_380');
      document.querySelector('[data-action="setUiLanguage"][data-arg="en"]')?.click();
      await new Promise((r) => setTimeout(r, 150));
      const enTitle = document.querySelector('#smartComposerCard .lg-card-title')?.textContent?.trim() || '';
      measure('full_en_380');

      document.querySelector('[data-action="setUiLanguage"][data-arg="ru"]')?.click();
      await new Promise((r) => setTimeout(r, 150));

      document.querySelector('[data-action="setPanelViewMode"][data-arg="lite"]')?.click();
      await new Promise((r) => setTimeout(r, 220));
      measure('lite_ru_380');
      return { checks, enTitle, view: document.body.getAttribute('data-panel-view'), theme: document.body.getAttribute('data-panel-theme') };
    });
    await savePng('cdp-panel-lite-ru.png');

    // Restore Full + test Onboarding Wizard 4 steps
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 720, deviceScaleFactor: 1, mobile: false });
    const wizRes = await cdp.evaluate(async () => {
      document.querySelector('[data-action="setPanelViewMode"][data-arg="full"]')?.click();
      await new Promise((r) => setTimeout(r, 150));
      if (typeof openOnboardingWizard === 'function') openOnboardingWizard(1);
      await new Promise((r) => setTimeout(r, 150));
      for (const step of [2, 3, 4]) {
        if (typeof wizGoStep === 'function') wizGoStep(step);
        await new Promise((r) => setTimeout(r, 80));
      }
      const modalOpen = getComputedStyle(document.getElementById('onboardingWizardModal')).display !== 'none';
      return { modalOpen, hint: document.getElementById('wizStepHint')?.textContent?.trim() || '' };
    });
    await savePng('cdp-onboarding-wizard.png');

    await cdp.evaluate(async () => {
      if (typeof closeOnboardingWizard === 'function') closeOnboardingWizard();
      await new Promise((r) => setTimeout(r, 120));
    });

    // Open Project Graph modal at 1280x860 & exercise levels + lenses + inspector + context cart
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
    const graphRes = await cdp.evaluate(async () => {
      if (typeof openProjectGraphModal === 'function') await openProjectGraphModal({ inlineOnly: true });
      const deadline = Date.now() + 9000;
      while (Date.now() < deadline) {
        if (typeof pgState !== 'undefined' && Array.isArray(pgState.nodes) && pgState.nodes.length > 0) break;
        await new Promise((r) => setTimeout(r, 80));
      }
      if (typeof pgSetViewLevel === 'function') await pgSetViewLevel('files');
      await new Promise((r) => setTimeout(r, 250));
      if (typeof pgSetLens === 'function') await pgSetLens('cycles');
      await new Promise((r) => setTimeout(r, 150));
      if (typeof pgSetLens === 'function') await pgSetLens('hotspots');
      await new Promise((r) => setTimeout(r, 150));
      if (typeof pgSetLens === 'function') await pgSetLens('blast');
      await new Promise((r) => setTimeout(r, 250));
      const firstNode = Array.isArray(pgState?.nodes) ? pgState.nodes.find((n) => !n.isFolder) || pgState.nodes[0] : null;
      if (firstNode && typeof pgSelectNode === 'function') {
        pgSelectNode(firstNode.id);
        await new Promise((r) => setTimeout(r, 150));
      }
      return {
        nodeCount: pgState?.nodes?.length || 0,
        edgeCount: pgState?.edges?.length || 0,
        selectedId: pgState?.selectedNodeId || '',
        statsText: document.getElementById('pgStatsPill')?.textContent?.trim() || '',
      };
    });
    await savePng('cdp-project-graph-blast.png');

    const overflowFailures = layoutMetrics.checks.filter((c) => c.scrollWidth > c.clientWidth + 2);
    const ok =
      cdp.runtimeErrors.length === 0 &&
      cdp.httpErrors.length === 0 &&
      overflowFailures.length === 0 &&
      wizRes.modalOpen === true &&
      graphRes.nodeCount > 0;

    return {
      ok,
      elapsedMs: Date.now() - t0,
      runtimeErrors: cdp.runtimeErrors,
      httpErrors: cdp.httpErrors,
      overflowFailures,
      enTitle: layoutMetrics.enTitle,
      wizHint: wizRes.hint,
      graph: graphRes,
      screenshots: capturedScreenshots,
    };
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

export async function runMegaDiagnostic(rawOpts = {}) {
  const opts = rawOpts && typeof rawOpts === 'object' ? rawOpts : {};
  const tStart = Date.now();
  const contours = [];

  // Contour 1: Hygiene, Manifests & UI/A11y Gate
  const { buildPanelUi } = await import('../core/panel-ui-builder.mjs');
  const c1Ui = buildPanelUi({ repoRoot: ROOT_DIR, checkOnly: true });
  const c1Ver = await runNodeStep('version:check', ['scripts/bump-version.mjs', '--check']);
  const c1Skills = await runNodeStep('lint:skills', ['skills/skill-architect/scripts/audit-skill.mjs', '--all', '--strict']);
  const c1Gh = await runNodeStep('audit:github', ['skills/github-publish-guard/scripts/audit-github-publish.mjs']);
  const c1UiCraft = await runNodeStep('audit-ui', [
    'skills/ui-ux-design-system/scripts/audit-ui.mjs',
    'sidecars/panel/ui.html',
    '--json',
    ...(opts.liveCdp ? ['--viewports'] : []),
  ]);
  const c1Dogfood = await runNodeStep('webapp-dogfood', [
    'skills/deep-stress-auditor/scripts/run-webapp-dogfood.mjs',
    'sidecars/panel/ui.html',
    '--json',
  ]);
  let uiCraftParsed = null;
  let dogfoodParsed = null;
  try { uiCraftParsed = JSON.parse(c1UiCraft.stdout); } catch {}
  try { dogfoodParsed = JSON.parse(c1Dogfood.stdout); } catch {}
  const uiCraftOk = Boolean(
    c1UiCraft.ok &&
    uiCraftParsed?.ok &&
    Number(uiCraftParsed?.averageScore || 0) >= 19 &&
    (!uiCraftParsed?.viewports || uiCraftParsed.viewports.skipped || uiCraftParsed.viewports.ok)
  );
  const dogfoodOk = Boolean(
    c1Dogfood.ok &&
    dogfoodParsed?.ok &&
    Array.isArray(dogfoodParsed?.issues) &&
    dogfoodParsed.issues.length === 0
  );
  contours.push({
    id: 'contour_1_hygiene',
    name: 'Hygiene, Manifests & UI/A11y Gate (UI Sync, SemVer, 15 Skills, GitHub, Craft 20/20, A11y)',
    ok: Boolean(c1Ui?.ok) && c1Ver.ok && c1Skills.ok && c1Gh.ok && uiCraftOk && dogfoodOk,
    elapsedMs: c1Ver.elapsedMs + c1Skills.elapsedMs + c1Gh.elapsedMs + c1UiCraft.elapsedMs + c1Dogfood.elapsedMs,
    details: {
      uiSync: Boolean(c1Ui?.ok),
      version: c1Ver.ok,
      skills: c1Skills.ok,
      githubGuard: c1Gh.ok,
      uiCraft: uiCraftOk,
      uiCraftScore: Number(uiCraftParsed?.averageScore || 0),
      a11yDogfood: dogfoodOk,
    },
  });

  // Contour 2: Static, Security, Contracts & Sandboxed Fuzzing
  const c2Audit = await runNodeStep('deep-stress-auditor', ['skills/deep-stress-auditor/scripts/run-stress-audit.mjs', '.', '--fuzz', '--json'], { timeoutMs: 90000 });
  let auditParsed = null;
  try {
    auditParsed = JSON.parse(c2Audit.stdout);
  } catch {}
  const c2Clean = Boolean(
    c2Audit.ok &&
    auditParsed?.status === 'PASSED' &&
    Number(auditParsed?.summary?.CRITICAL || 0) === 0 &&
    Number(auditParsed?.summary?.HIGH || 0) === 0 &&
    Number(auditParsed?.summary?.MEDIUM || 0) === 0
  );
  contours.push({
    id: 'contour_2_stress_fuzz',
    name: 'Static, Security, Contracts & Sandboxed Fuzzing (T1-T6)',
    ok: c2Clean,
    elapsedMs: c2Audit.elapsedMs,
    summary: auditParsed?.summary || null,
    findingsCount: Array.isArray(auditParsed?.findings) ? auditParsed.findings.length : -1,
  });

  // Contour 3: 8 Practical Cross-System Missions
  const c3Missions = await runNodeStep('mega-cross-system-e2e', ['--test', 'tests/mega-cross-system-e2e.test.mjs'], {
    envExtra: { TUNNEL_TEST_ISOLATE_INSTALLED: '1' },
    timeoutMs: 90000,
  });
  contours.push({
    id: 'contour_3_missions_m1_m8',
    name: '8 Practical Cross-System Missions (M1-M8)',
    ok: c3Missions.ok,
    elapsedMs: c3Missions.elapsedMs,
    error: c3Missions.ok ? '' : (c3Missions.stderr || c3Missions.stdout || c3Missions.error).slice(-800),
  });

  // Contour 4: Full Regression Suite (all tests/*.test.mjs)
  if (!opts.quick) {
    const testFiles = fs
      .readdirSync(path.join(ROOT_DIR, 'tests'))
      .filter((f) => f.endsWith('.test.mjs'))
      .sort()
      .map((f) => path.join('tests', f));
    const c4All = await runNodeStep('full-test-suite', ['--test', '--test-concurrency=6', ...testFiles], {
      envExtra: { TUNNEL_TEST_ISOLATE_INSTALLED: '1' },
      timeoutMs: 240000,
    });
    const combinedOut = `${c4All.stdout}\n${c4All.stderr}`;
    const mPass = combinedOut.match(/# pass\s+(\d+)/);
    const mFail = combinedOut.match(/# fail\s+(\d+)/);
    contours.push({
      id: 'contour_4_regression',
      name: `Full Regression Suite (${testFiles.length} suites)`,
      ok: c4All.ok,
      elapsedMs: c4All.elapsedMs,
      suitesCount: testFiles.length,
      passedTests: mPass ? Number(mPass[1]) : null,
      failedTests: mFail ? Number(mFail[1]) : null,
      error: c4All.ok ? '' : combinedOut.slice(-1200),
    });
  }

  // Contour 5: Live RTX GPU + Ollama + CPU Pool
  if (opts.liveGpu) {
    const c5 = await runContour5LiveGpu();
    contours.push({
      id: 'contour_5_live_gpu',
      name: 'Live RTX GPU + Ollama + CPU Worker Pool',
      ...c5,
    });
  }

  // Contour 6: Live Headless Chromium/Edge CDP
  if (opts.liveCdp) {
    const c6 = await runContour6LiveCdp(opts.screenshotsDir || '');
    contours.push({
      id: 'contour_6_live_cdp',
      name: 'Live Headless Browser CDP UI & Project Graph Walkthrough',
      ...c6,
    });
  }

  const allOk = contours.every((c) => c.ok);
  return {
    ok: allOk,
    totalElapsedMs: Date.now() - tStart,
    contours,
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);
if (isMain) {
  const args = parseMegaDiagnosticArgs(process.argv.slice(2));
  const report = await runMegaDiagnostic(args);
  let pkgVersion = '4.0.0';
  try {
    const pkgMeta = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
    if (pkgMeta?.version) pkgVersion = String(pkgMeta.version);
  } catch {}
  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    console.log(`\n=== The Tunnel v${pkgVersion} · Mega-Diagnostic (${report.ok ? 'PASSED' : 'FAILED'}, ${report.totalElapsedMs}ms) ===`);
    for (const c of report.contours) {
      const badge = c.ok ? '✅ PASS' : '❌ FAIL';
      console.log(`${badge} [${c.id}] ${c.name} (${c.elapsedMs}ms)`);
      if (c.error) console.log(`   Error: ${c.error}`);
      if (c.gpuName) console.log(`   GPU: ${c.gpuName} | Embed: ${c.embedMs}ms (${c.embedDim}d) | Distill: ${c.distillMs}ms (${c.distillChars}) | CPU batch: ${c.cpuBatchItems}`);
      if (c.graph) console.log(`   CDP: nodes=${c.graph.nodeCount}, edges=${c.graph.edgeCount}, runtimeErr=${c.runtimeErrors.length}, httpErr=${c.httpErrors.length}, screenshots=${c.screenshots.length}`);
      if (c.suitesCount) console.log(`   Suites: ${c.suitesCount} | Tests pass=${c.passedTests} fail=${c.failedTests}`);
    }
  }
  process.exit(report.ok ? 0 : 1);
}

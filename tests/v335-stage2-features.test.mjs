import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.TUNNEL_TEST_ISOLATE_INSTALLED = '1';

import { diagnoseRuntimeHealth, applyHealthDoctorFix } from '../core/health-doctor.mjs';
import { RamMemoryEngine } from '../core/ram-memory-engine.mjs';
import { dispatchIpcRoute } from '../core/ram-memory-mcp.mjs';
import { collectRoiTimeline } from '../sidecars/panel/lib/panel-telemetry-collectors.mjs';
import { startSidecarPanel, DEFAULT_STATE } from '../sidecars/panel/server.mjs';
import { buildPanelUi } from '../core/panel-ui-builder.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');

function makeTmpDir(prefix = 'amr-s2-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createTestSidecarAppClass() {
  return class TestSidecarApp {
    constructor() {
      this._pages = new Map();
      this._apis = new Map();
      this._server = null;
    }
    page(p, h) { this._pages.set(p, h); }
    api(p, h, m = 'POST') {
      if (!this._apis.has(p)) this._apis.set(p, new Map());
      this._apis.get(p).set(m.toUpperCase(), h);
    }
    get port() { return this._server?.address()?.port || 0; }
    run() {
      const server = http.createServer(async (req, res) => {
        const u = new URL(req.url || '/', 'http://127.0.0.1');
        if (this._apis.has(u.pathname)) {
          const handler = this._apis.get(u.pathname).get(req.method);
          if (!handler) { res.writeHead(405); res.end('{}'); return; }
          let body = '';
          req.on('data', (c) => { body += c; });
          req.on('end', async () => {
            const data = {};
            for (const [k, v] of u.searchParams.entries()) data[k] = v;
            if (body) Object.assign(data, JSON.parse(body));
            const out = await handler(data, req);
            res.writeHead(out?.status || 200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(out));
          });
          return;
        }
        res.writeHead(404);
        res.end('Not found');
      });
      this._server = server;
      return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
    }
    close() {
      const srv = this._server;
      this._server = null;
      if (!srv) return Promise.resolve();
      if (typeof srv.closeAllConnections === 'function') try { srv.closeAllConnections(); } catch {}
      return new Promise((r) => srv.close(() => r()));
    }
  };
}

test('1. Health-Doctor detects stale locks, orphan worktrees, offline Ollama, VRAM mismatch & auto-fixes cleanly', async () => {
  const tmpDir = makeTmpDir('amr-hd-');
  try {
    const cacheDir = path.join(tmpDir, 'cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    const lockFile = path.join(cacheDir, 'stale-test.lock');
    fs.writeFileSync(lockFile, '99999', 'utf8');
    const oldTime = new Date(Date.now() - 15 * 60 * 1000);
    fs.utimesSync(lockFile, oldTime, oldTime);

    const diag = diagnoseRuntimeHealth({
      workspaceRoot: tmpDir,
      cacheDir,
      state: { gpuEnabled: true, ramCacheEnabled: true },
      gpuStatus: {
        ollama: { installed: true, running: false },
        vramFit: { selectedChatFits: false, bestFallbackChatModel: 'qwen3:4b' },
      },
      ramStatus: { running: false, cachedFiles: 0 },
      worktrees: [{ id: 'wt-ghost', path: path.join(tmpDir, 'missing-wt'), exists: false }],
    });

    assert.equal(diag.ok, true);
    assert.equal(diag.healthy, false);
    assert.ok(diag.score < 100);
    const ids = diag.issues.map((i) => i.id);
    assert.deepEqual(ids.sort(), ['ollama_offline', 'orphan_worktrees', 'ram_daemon_cold', 'stale_locks', 'vram_mismatch']);

    const badRes = await applyHealthDoctorFix({ fixAction: 'drop_database' });
    assert.equal(badRes.ok, false);

    let savedPatch = null;
    const fixRes = await applyHealthDoctorFix({
      fixAction: 'fix_all',
      workspaceRoot: tmpDir,
      cacheDir,
      state: { gpuEnabled: true, ramCacheEnabled: true },
      gpuStatus: {
        ollama: { installed: true, running: false },
        vramFit: { selectedChatFits: false, bestFallbackChatModel: 'qwen3:4b' },
      },
      ramStatus: { running: false, cachedFiles: 0 },
      worktrees: [{ id: 'wt-ghost', path: path.join(tmpDir, 'missing-wt'), exists: false }],
      saveStateFn: (p) => { savedPatch = p; },
      startOllamaFn: async () => ({ ok: true }),
      warmRamFn: async () => ({ ok: true, filesCached: 12 }),
      pruneWorktreesFn: async (orphans) => ({ pruned: orphans.length }),
    });

    assert.equal(fixRes.ok, true);
    assert.equal(fixRes.applied, 5);
    assert.equal(fs.existsSync(lockFile), false, 'Stale .lock file must be removed');
    assert.deepEqual(savedPatch, { gpuChatModel: 'qwen3:4b' });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('2. collectRoiTimeline aggregates Day/Week/Month buckets and Quota Pacer bullet telemetry', () => {
  const tmpDir = makeTmpDir('amr-roi-');
  try {
    const nowMs = Date.now();
    const res = collectRoiTimeline({
      cacheDir: tmpDir,
      nowMs,
      seedFromTranscripts: false,
      currentTelemetry: {
        cacheSavedTokens: 45000,
        ramSavedTokens: 18000,
        cpuSavedTokens: 7000,
        gpuSavedTokens: 4000,
        savingsBreakdown: { ram: 18000, cpu: 7000, gpu: 4000 },
      },
      quotaPacer: { utilizationPct: 40, projectedPct: 52, status: 'calm', estimatedMinutesLeft: 195, turnsLast60m: 14, turnsLast5h: 22 },
    });

    assert.equal(res.ok, true);
    assert.equal(res.scales.day.length, 8);
    assert.equal(res.scales.week.length, 7);
    assert.equal(res.scales.month.length, 4);
    // Extension-only layers: RAM (18000) + CPU (7000) + GPU (4000) = 29000 (Google Implicit Cache excluded)
    assert.equal(res.totals.total, 29000);
    assert.equal(res.totals.cache, undefined);
    assert.equal(res.quotaBullet.utilizationPct, 40);
    assert.equal(res.quotaBullet.projectedPct, 52);
    assert.equal(res.quotaBullet.estimatedMinutesLeft, 195);
    assert.equal(res.quotaBullet.turnsLast5h, 22);
    assert.equal(fs.existsSync(path.join(tmpDir, 'roi-timeline.json')), true);

    // Regression: temporary counter dip (e.g. workspace switch) must NEVER re-add lifetime totals as a delta spike
    const afterDip = collectRoiTimeline({
      cacheDir: tmpDir,
      nowMs: nowMs + 120_000,
      seedFromTranscripts: false,
      currentTelemetry: {
        ramSavedTokens: 5000,
        cpuSavedTokens: 7000,
        gpuSavedTokens: 4000,
        savingsBreakdown: { ram: 5000, cpu: 7000, gpu: 4000 },
      },
      quotaPacer: { utilizationPct: 40, projectedPct: 52, status: 'calm', estimatedMinutesLeft: 195, turnsLast60m: 14, turnsLast5h: 22 },
    });
    const daySumAfterDip = afterDip.scales.day.reduce((acc, b) => acc + b.ram, 0);
    assert.equal(daySumAfterDip, 18000, 'Counter dip must add 0 delta instead of re-adding lifetime RAM savings');

    // Verify v3 calendar range labels (DD.MM-DD.MM) replace legacy H1..H4 / W1..W4 codes
    assert.match(afterDip.scales.month[0].labelRu, /^\d{2}\.\d{2}–\d{2}\.\d{2}$/);
    assert.ok(afterDip.scales.month[0].periodLabelRu && afterDip.scales.month[0].periodLabelEn);
    assert.equal(afterDip.schemaVersion, 3);

    // Regression: legacy schemaVersion:2 poisoned cache (35.7M baseline & old slots) migrates cleanly to v3 and seeds ONLY extension-active chats
    const migCache = path.join(tmpDir, 'mig-cache');
    const migBrain = path.join(tmpDir, 'mig-brain');
    fs.mkdirSync(migCache, { recursive: true });
    const oldChatDir = path.join(migBrain, 'old-plain-chat', '.system_generated', 'logs');
    const extChatDir = path.join(migBrain, 'ext-active-chat', '.system_generated', 'logs');
    fs.mkdirSync(oldChatDir, { recursive: true });
    fs.mkdirSync(extChatDir, { recursive: true });
    const oldTp = path.join(oldChatDir, 'transcript.jsonl');
    const extTp = path.join(extChatDir, 'transcript.jsonl');
    fs.writeFileSync(oldTp, JSON.stringify({ type: 'PLANNER_RESPONSE', input_tokens: 1000, output_tokens: 200 }) + '\n');
    const oldTsSec = Math.floor((nowMs - 20 * 24 * 60 * 60 * 1000) / 1000);
    fs.utimesSync(oldTp, oldTsSec, oldTsSec);
    fs.writeFileSync(extTp, [
      JSON.stringify({ type: 'PLANNER_RESPONSE', input_tokens: 500, output_tokens: 100 }),
      JSON.stringify({ tool_calls: [{ name: 'mcp_antigravity-model-router_ram-memory_ram_slice', args: {} }] }),
    ].join('\n') + '\n');
    const extTsSec = Math.floor((nowMs - 2 * 60 * 60 * 1000) / 1000);
    fs.utimesSync(extTp, extTsSec, extTsSec);

    fs.writeFileSync(path.join(migCache, 'roi-timeline.json'), JSON.stringify({
      schemaVersion: 2,
      lastTotals: { ram: 35705104, cpu: 1446894, gpu: 153049 },
      slots: [{ hourKey: '2026-11-04T12', ts: nowMs - 22 * 24 * 60 * 60 * 1000, ram: 999999, cpu: 50000, gpu: 5000 }],
    }));

    const migrated = collectRoiTimeline({
      cacheDir: migCache,
      nowMs,
      brainDirs: [migBrain],
      currentTelemetry: {
        ramSavedTokens: 900,
        cpuSavedTokens: 300,
        gpuSavedTokens: 100,
        savingsBreakdown: { ram: 900, cpu: 300, gpu: 100 },
      },
    });
    assert.equal(migrated.schemaVersion, 3);
    assert.equal(migrated.scales.month[0].total, 0, 'Pre-extension week must stay 0 after v3 migration');
    assert.equal(migrated.scales.month[0].beforeInstall, true, 'Pre-extension week must carry beforeInstall flag');
    assert.equal(migrated.scales.month[3].ram, 900, 'Extension-active chat savings must land in current period');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('3. Sidecar /api/state (roiTimeline), /api/health-doctor, /api/health-doctor/fix & Mega-Diagnostic Contour 1 gate', async () => {
  const buildCheck = buildPanelUi({ repoRoot: ROOT_DIR, checkOnly: true });
  assert.equal(buildCheck.ok, true, 'ui.html must be in sync with ui-src');

  const uiHtml = fs.readFileSync(path.join(ROOT_DIR, 'sidecars', 'panel', 'ui.html'), 'utf8');
  assert.ok(uiHtml.includes('id="roiTimelineBox"'));
  assert.ok(uiHtml.includes('id="roiTimelineCanvas"'));
  assert.ok(uiHtml.includes('id="roiQuotaBullet"'));

  const megaSrc = fs.readFileSync(path.join(ROOT_DIR, 'scripts', 'run-mega-diagnostic.mjs'), 'utf8');
  assert.ok(megaSrc.includes('audit-ui.mjs'), 'Mega-Diagnostic Contour 1 must run audit-ui gate');
  assert.ok(megaSrc.includes('run-webapp-dogfood.mjs'), 'Mega-Diagnostic Contour 1 must run dogfood A11y gate');

  const tmpDir = makeTmpDir('amr-srv-s2-');
  const prevState = process.env.TUNNEL_TEST_STATE_PATH;
  const statePath = path.join(tmpDir, 'router-state.json');
  fs.writeFileSync(statePath, JSON.stringify({ ...DEFAULT_STATE, onboardingCompleted: true }, null, 2));
  process.env.TUNNEL_TEST_STATE_PATH = statePath;

  const app = await startSidecarPanel({ port: 0, SidecarAppClass: createTestSidecarAppClass() });
  try {
    const baseUrl = `http://127.0.0.1:${app.port}`;
    const headers = { 'Content-Type': 'application/json', 'X-Router-Panel': 'antigravity-v38' };

    const stRes = await fetch(`${baseUrl}/api/state`, { headers });
    const stJson = await stRes.json();
    assert.equal(stRes.status, 200);
    assert.ok(stJson.roiTimeline && stJson.roiTimeline.scales && Array.isArray(stJson.roiTimeline.scales.day));

    const telCoreRes = await fetch(`${baseUrl}/api/telemetry?sections=core`, { headers });
    const telCoreJson = await telCoreRes.json();
    assert.equal(telCoreRes.status, 200);
    assert.equal(telCoreJson.ramCache, undefined, 'sec.hw=false must still omit top-level ramCache');
    assert.ok(telCoreJson.roiTimeline && telCoreJson.roiTimeline.scales, '/api/telemetry must include roiTimeline');
    assert.equal(telCoreJson.telemetry.ramSavedTokens, stJson.telemetry.ramSavedTokens, 'RAM savings must stay consistent when sec.hw=false');

    const hdRes = await fetch(`${baseUrl}/api/health-doctor`, { headers });
    const hdJson = await hdRes.json();
    assert.equal(hdRes.status, 200);
    assert.equal(hdJson.ok, true);
    assert.equal(typeof hdJson.score, 'number');

    const fixRes = await fetch(`${baseUrl}/api/health-doctor/fix`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ fixAction: 'clean_stale_locks' }),
    });
    const fixJson = await fixRes.json();
    assert.equal(fixRes.status, 200);
    assert.equal(fixJson.ok, true);
    assert.ok(Array.isArray(fixJson.log));
  } finally {
    await app.close();
    if (prevState === undefined) delete process.env.TUNNEL_TEST_STATE_PATH;
    else process.env.TUNNEL_TEST_STATE_PATH = prevState;
    try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 60 }); } catch {}
  }
});

test('4. Health-Doctor cleans stale .tmp files & build-showroom strips UTF-8 BOM from --spec JSON', async () => {
  const { execFileSync } = await import('node:child_process');
  const tmpDir = makeTmpDir('amr-s2-bom-');
  try {
    const cacheDir = path.join(tmpDir, 'cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    const staleTmp = path.join(cacheDir, 'task-progress.json.99999.abcd1.tmp');
    fs.writeFileSync(staleTmp, '{}', 'utf8');
    const oldTime = new Date(Date.now() - 15 * 60 * 1000);
    fs.utimesSync(staleTmp, oldTime, oldTime);

    const diag = diagnoseRuntimeHealth({ workspaceRoot: tmpDir, cacheDir, state: {} });
    assert.equal(diag.checks.staleTmpCount, 1);
    assert.ok(diag.issues.some((i) => i.id === 'stale_locks'));

    const fix = await applyHealthDoctorFix({ fixAction: 'clean_stale_locks', cacheDir, state: {} });
    assert.equal(fix.ok, true);
    assert.equal(fix.applied, 1);
    assert.equal(fs.existsSync(staleTmp), false, 'Stale .tmp file must be removed');

    const specPath = path.join(tmpDir, 'bom-spec.json');
    const outPath = path.join(tmpDir, 'showroom.html');
    const bomJson = '\uFEFF' + JSON.stringify({
      title: 'BOM Showroom',
      variants: [{ id: 'A', name: 'Alpha', html: '<div>OK</div>', css: 'div{color:#111}' }],
    });
    fs.writeFileSync(specPath, bomJson, 'utf8');
    const out = execFileSync(
      process.execPath,
      [path.join(ROOT_DIR, 'skills', 'ui-ux-design-system', 'scripts', 'build-showroom.mjs'), specPath, outPath, '--fast-png'],
      { encoding: 'utf8', windowsHide: true }
    );
    const parsed = JSON.parse(out.trim());
    assert.equal(parsed.ok, true);
    assert.equal(fs.existsSync(outPath), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 60 });
  }
});

test('5. Health-Doctor recognizes active RAM workspaces shape and IPC POST /warm warms daemon', async () => {
  const tmpDir = makeTmpDir('amr-s2-ram-warm-');
  const ram = new RamMemoryEngine({ budgetMb: 512 });
  try {
    fs.writeFileSync(path.join(tmpDir, 'sample.mjs'), 'export const hello = (x) => x + 1;\n', 'utf8');

    const warmDiag = diagnoseRuntimeHealth({
      workspaceRoot: tmpDir,
      cacheDir: tmpDir,
      state: { ramCacheEnabled: true, gpuEnabled: false },
      ramStatus: { enabled: true, active: true, workspaces: [{ workspace: tmpDir, files: 120 }] },
    });
    assert.equal(warmDiag.checks.ramWarmOk, true);
    assert.equal(warmDiag.issues.some((i) => i.id === 'ram_daemon_cold'), false);

    const coldDiag = diagnoseRuntimeHealth({
      workspaceRoot: tmpDir,
      cacheDir: tmpDir,
      state: { ramCacheEnabled: true, gpuEnabled: false },
      ramStatus: { enabled: true, active: true, workspaces: [] },
    });
    assert.equal(coldDiag.checks.ramWarmOk, false);
    assert.equal(coldDiag.issues.some((i) => i.id === 'ram_daemon_cold'), true);

    const fixRes = await applyHealthDoctorFix({
      fixAction: 'warm_ram_cache',
      workspaceRoot: tmpDir,
      cacheDir: tmpDir,
      state: { ramCacheEnabled: true, gpuEnabled: false },
      warmRamFn: async () => ({ ok: true, filesLoaded: 42 }),
    });
    assert.equal(fixRes.ok, true);
    assert.equal(fixRes.applied, 1);
    assert.ok(fixRes.log.some((entry) => entry.ok && /42/.test(entry.messageEn)));

    const ipcRes = await dispatchIpcRoute(
      'POST',
      '/warm',
      { wsPath: tmpDir },
      { engine: ram, settings: { enabled: true, autoWarm: true, ramSotaEngines: true }, sentinel: null }
    );
    assert.equal(ipcRes.status, 200);
    assert.equal(ipcRes.body.ok, true);
    assert.ok(ipcRes.body.filesLoaded >= 1);
    assert.ok(ipcRes.body.filesCached >= 1);
  } finally {
    try { ram.close(); } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 60 });
  }
});


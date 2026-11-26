import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

import { parseChangelogMarkdown, loadPluginChangelog } from '../core/changelog-parser.mjs';
import {
  appendDebugLog,
  buildDiagnosticBundle,
  clearDebugLog,
  formatDiagnosticBundleSummary,
  getDebugLogPaths,
  getDebugLogStatus,
  readDebugLogEntries,
  resolveDebugLogMode,
  sanitizeDebugText,
} from '../core/debug-logger.mjs';
import { startSidecarPanel } from '../sidecars/panel/server.mjs';
import { buildPanelUi } from '../core/panel-ui-builder.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

function createMiniSidecarAppClass() {
  return class MiniSidecarApp {
    constructor() {
      this._routes = new Map();
      this._pages = new Map();
      this._server = null;
      this.port = 0;
    }
    page(p, handler) {
      this._pages.set(p, handler);
    }
    api(p, handler, method = 'POST') {
      if (!this._routes.has(p)) this._routes.set(p, new Map());
      this._routes.get(p).set(String(method || 'POST').toUpperCase(), handler);
    }
    async run() {
      this._server = http.createServer((req, res) => {
        res.statusCode = 200;
        res.end('ok');
      });
      await new Promise((resolve) => this._server.listen(0, '127.0.0.1', resolve));
      this.port = this._server.address().port;
      return this._server;
    }
    async close() {
      if (this._server) {
        await new Promise((resolve) => this._server.close(resolve));
        this._server = null;
      }
    }
  };
}

test('1. changelog-parser parses real CHANGELOG.md and prepends pending remote release', () => {
  const sample = [
    '# История изменений — Test',
    '',
    '## [4.0.4] — 2026-11-26',
    '### Добавлено',
    '- **Внутреннее ТЗ**: поддержка `autoSpecMode` в [core/tool-pruner.mjs](core/tool-pruner.mjs)',
    '  - Вложенный подпункт про `ram_slice`',
    '## [4.0.3] — 2026-11-25',
    '### Исправлено',
    '- Сброс модалки перезагрузки',
  ].join('\n');

  const parsed = parseChangelogMarkdown(sample);
  assert.equal(parsed.versions.length, 2);
  assert.equal(parsed.versions[0].version, '4.0.4');
  assert.equal(parsed.versions[0].date, '2026-11-26');
  assert.equal(parsed.versions[0].sections[0].items[0].lead, 'Внутреннее ТЗ');
  assert.equal(parsed.versions[0].sections[0].items[0].subitems[0], 'Вложенный подпункт про `ram_slice`');

  const loaded = loadPluginChangelog({
    pluginRoot: REPO_ROOT,
    remoteRelease: {
      latestVersion: '9.99.0',
      releaseNotes: '### Added\n- **In-app Changelog**: full version history',
      releaseUrl: 'https://github.com/vaszuevvas-coder/antigravity-model-router/releases/tag/v9.99.0',
      publishedAt: '2026-11-27T10:00:00Z',
    },
  });
  assert.equal(loaded.ok, true);
  assert.ok(loaded.versions.length >= 3);
  assert.equal(loaded.versions[0].version, '9.99.0');
  assert.equal(loaded.versions[0].isRemotePending, true);
  assert.equal(loaded.versions.some((v) => v.isCurrent === true), true);
});

test('2. debug-logger respects modes, rotates files, and redacts secrets & user paths', () => {
  const tmpPlugin = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-dbg-log-'));
  const prevCacheEnv = process.env.TUNNEL_CACHE_DIR;
  const prevDbgEnv = process.env.TUNNEL_DEBUG_LOG;
  process.env.TUNNEL_CACHE_DIR = path.join(tmpPlugin, '.cache');
  delete process.env.TUNNEL_DEBUG_LOG;

  try {
    fs.writeFileSync(path.join(tmpPlugin, 'plugin.json'), JSON.stringify({ name: 'antigravity-model-router', version: '4.0.4' }), 'utf8');

    // Mode 'off' records nothing
    assert.equal(appendDebugLog({ level: 'error', source: 'test', event: 'e1', message: 'fail' }, {
      pluginRoot: tmpPlugin,
      state: { debugLogMode: 'off' },
    }), false);

    // Mode 'errors' records error/warn, skips info
    assert.equal(appendDebugLog({ level: 'info', source: 'test', event: 'i1', message: 'trace' }, {
      pluginRoot: tmpPlugin,
      state: { debugLogMode: 'errors' },
    }), false);
    const fakeOpenAiKey = 'sk-' + 'proj-1234567890abcdefghij';
    const fakeGhToken = 'ghp_' + '123456789012345678901234567890';
    assert.equal(appendDebugLog({
      level: 'error',
      source: 'test',
      event: 'e2',
      message: `Failed for ${os.homedir()}\\secret.txt with ${fakeOpenAiKey} and ${fakeGhToken}`,
      meta: { apiKey: 'should-redact', nestedPath: path.join(os.homedir(), 'work', 'repo') },
    }, {
      pluginRoot: tmpPlugin,
      state: { debugLogMode: 'errors' },
    }), true);

    // Mode 'verbose' records info as well
    assert.equal(appendDebugLog({ level: 'info', source: 'hook-runner', event: 'PreInvocation', message: 'Hook completed', durationMs: 12 }, {
      pluginRoot: tmpPlugin,
      state: { debugLogMode: 'verbose' },
    }), true);

    const status = getDebugLogStatus({ pluginRoot: tmpPlugin, state: { debugLogMode: 'verbose' } });
    assert.equal(status.totalEntries, 2);
    assert.equal(status.errorCount, 1);
    assert.equal(resolveDebugLogMode({ debugLogMode: 'verbose' }, tmpPlugin), 'verbose');

    const bundle = buildDiagnosticBundle({
      pluginRoot: tmpPlugin,
      state: { debugLogMode: 'verbose', federatedWorkspaces: ['D:\\SecretProject'] },
    });
    const serialized = JSON.stringify(bundle);
    assert.equal(serialized.includes('sk-' + 'proj-'), false);
    assert.equal(serialized.includes('ghp_' + '123456'), false);
    assert.equal(serialized.includes('should-redact'), false);
    assert.equal(serialized.includes(os.homedir()), false);
    assert.ok(serialized.includes('<HOME>'));
    assert.ok(serialized.includes('[REDACTED]'));

    const summary = formatDiagnosticBundleSummary(bundle, 'ru');
    assert.ok(summary.includes('Отчёт диагностики The Tunnel'));

    // File rotation when exceeding maxBytes
    for (let i = 0; i < 12; i++) {
      appendDebugLog({ level: 'info', source: 'rot', event: 'tick', message: 'X'.repeat(220) }, {
        pluginRoot: tmpPlugin,
        state: { debugLogMode: 'verbose' },
        maxBytes: 1024,
      });
    }
    const paths = getDebugLogPaths(tmpPlugin);
    assert.equal(fs.existsSync(paths.prevPath), true, 'Rotation must create debug-log.prev.ndjson');
    assert.equal(fs.existsSync(paths.activePath), true, 'Active debug-log.ndjson must exist after rotation');
    const allRead = readDebugLogEntries({ pluginRoot: tmpPlugin, limit: 50 });
    assert.ok(allRead.totalEntries >= 5 && allRead.totalEntries <= 10, `Expected bounded rotated entries (5..10), got ${allRead.totalEntries}`);

    // Redaction of synthetic POSIX/Windows user paths & basic auth URL
    const san = sanitizeDebugText('https://alice:topSecretPass@example.com/hook /Users/alice/app', {
      homedir: '/Users/alice',
      username: 'alice',
      hostname: 'workstation-99',
    });
    assert.equal(san.includes('topSecretPass'), false);
    assert.equal(san.includes('/Users/alice'), false);

    clearDebugLog({ pluginRoot: tmpPlugin });
    assert.equal(getDebugLogStatus({ pluginRoot: tmpPlugin, state: { debugLogMode: 'errors' } }).totalEntries, 0);
  } finally {
    if (prevCacheEnv === undefined) delete process.env.TUNNEL_CACHE_DIR;
    else process.env.TUNNEL_CACHE_DIR = prevCacheEnv;
    if (prevDbgEnv === undefined) delete process.env.TUNNEL_DEBUG_LOG;
    else process.env.TUNNEL_DEBUG_LOG = prevDbgEnv;
    fs.rmSync(tmpPlugin, { recursive: true, force: true });
  }
});

test('3. Panel API routes (/api/plugin/changelog, /api/debug/*) and UI parity', async () => {
  const buildCheck = buildPanelUi({ repoRoot: REPO_ROOT, checkOnly: true });
  assert.equal(buildCheck.ok, true, 'sidecars/panel/ui.html must be in sync with ui-src');

  const uiHtml = fs.readFileSync(path.join(REPO_ROOT, 'sidecars', 'panel', 'ui.html'), 'utf8');
  for (const marker of [
    'id="openChangelogBtn"',
    'id="openDebugLogBtn"',
    'id="headerDebugRecDot"',
    'id="changelogModalOverlay"',
    'id="debugLogModalOverlay"',
    'id="debugExportDownloadBtn"',
  ]) {
    assert.ok(uiHtml.includes(marker), `ui.html must include ${marker}`);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-panel-dbg-'));
  const prevIso = process.env.TUNNEL_TEST_ISOLATE_INSTALLED;
  const prevStatePath = process.env.TUNNEL_TEST_STATE_PATH;
  const prevCacheDir = process.env.TUNNEL_CACHE_DIR;
  process.env.TUNNEL_TEST_ISOLATE_INSTALLED = '1';
  process.env.TUNNEL_TEST_STATE_PATH = path.join(tmpDir, 'router-state.json');
  process.env.TUNNEL_CACHE_DIR = path.join(tmpDir, '.cache');

  const MiniApp = createMiniSidecarAppClass();
  let app = null;
  try {
    app = await startSidecarPanel({ SidecarAppClass: MiniApp, rootDir: REPO_ROOT, pluginRoot: REPO_ROOT });
    const reqGet = { method: 'GET', headers: { host: `127.0.0.1:${app.port}` } };
    const reqPost = {
      method: 'POST',
      headers: {
        host: `127.0.0.1:${app.port}`,
        origin: `http://127.0.0.1:${app.port}`,
        'x-router-panel': 'antigravity-v38',
      },
    };

    const changelogRes = await app._routes.get('/api/plugin/changelog').get('GET')({}, reqGet);
    assert.equal(changelogRes.ok, true);
    assert.ok(Array.isArray(changelogRes.versions) && changelogRes.versions.length > 0);

    const badMode = await app._routes.get('/api/debug/mode').get('POST')({ mode: 'invalid_mode' }, reqPost);
    assert.equal(badMode.ok, false);
    assert.equal(badMode.status, 400);

    const setVerbose = await app._routes.get('/api/debug/mode').get('POST')({ mode: 'verbose' }, reqPost);
    assert.equal(setVerbose.ok, true);
    assert.equal(setVerbose.mode, 'verbose');

    const clientLogRes = await app._routes.get('/api/debug/client-log').get('POST')({
      level: 'error',
      event: 'ui_boom',
      message: `Client crash in ${os.homedir()}\\panel.js with Bearer abcdefghijklmnopqrstuvwxyz123456`,
    }, reqPost);
    assert.equal(clientLogRes.ok, true);
    assert.equal(clientLogRes.logged, true);

    const dbgStatus = await app._routes.get('/api/debug/status').get('GET')({ limit: '20', level: 'error' }, reqGet);
    assert.equal(dbgStatus.ok, true);
    assert.equal(dbgStatus.mode, 'verbose');
    assert.ok(dbgStatus.entries.some((e) => e.event === 'ui_boom'));

    const exportRes = await app._routes.get('/api/debug/export').get('GET')({}, reqGet);
    assert.equal(exportRes.ok, true);
    assert.match(exportRes.filename, /^the-tunnel-debug-v.+\.json$/);
    const exportText = JSON.stringify(exportRes.bundle);
    assert.equal(exportText.includes('abcdefghijklmnopqrstuvwxyz123456'), false);
    assert.equal(exportText.includes(os.homedir()), false);

    const clearRes = await app._routes.get('/api/debug/clear').get('POST')({}, reqPost);
    assert.equal(clearRes.ok, true);
    assert.equal(clearRes.status.totalEntries, 0);
  } finally {
    if (app) await app.close();
    if (prevIso === undefined) delete process.env.TUNNEL_TEST_ISOLATE_INSTALLED;
    else process.env.TUNNEL_TEST_ISOLATE_INSTALLED = prevIso;
    if (prevStatePath === undefined) delete process.env.TUNNEL_TEST_STATE_PATH;
    else process.env.TUNNEL_TEST_STATE_PATH = prevStatePath;
    if (prevCacheDir === undefined) delete process.env.TUNNEL_CACHE_DIR;
    else process.env.TUNNEL_CACHE_DIR = prevCacheDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

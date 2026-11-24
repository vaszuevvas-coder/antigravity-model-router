import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { buildPanelUi } from '../core/panel-ui-builder.mjs';
import { buildFileSymbolGraphPayload, buildProjectGraphPayload, parseGitChurnOutput } from '../core/project-graph-builder.mjs';
import { RamMemoryEngine } from '../core/ram-memory-engine.mjs';
import { dispatchIpcRoute } from '../core/ram-memory-mcp.mjs';
import { knowledgeHub } from '../core/sqlite-knowledge-hub.mjs';
import { startSidecarPanel } from '../sidecars/panel/server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');

function makeTmpDir(prefix = 'tunnel-pg-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('1. Panel UI build check, CSP cleanliness, and #projectGraphModal DOM placement', () => {
  const checkRes = buildPanelUi({ repoRoot: ROOT_DIR, checkOnly: true });
  assert.equal(checkRes.ok, true, 'sidecars/panel/ui.html must stay in sync with ui-src');
  assert.ok(checkRes.jsFiles.includes('07-project-graph.js'), '07-project-graph.js must be bundled');
  assert.ok(checkRes.jsFiles.includes('07b-project-graph-lenses.js'), '07b-project-graph-lenses.js must be bundled');
  assert.ok(checkRes.jsFiles.includes('07c-project-graph-visuals.js'), '07c-project-graph-visuals.js must be bundled');
  assert.ok(checkRes.jsFiles.includes('07d-project-graph-spatial.js'), '07d-project-graph-spatial.js must be bundled');

  const uiHtml = fs.readFileSync(path.join(ROOT_DIR, 'sidecars', 'panel', 'ui.html'), 'utf8');
  assert.equal(/\bon(?:click|change|input|keydown|keyup)\s*=/i.test(uiHtml), false, 'ui.html must stay 100% CSP clean');

  for (const marker of [
    'id="openProjectGraphBtn"',
    'data-action="openProjectGraphModal"',
    'id="projectGraphModal"',
    'id="projectGraphWebglCanvas"',
    'id="projectGraphCanvas"',
    'id="pgInspector"',
    'id="pgLevelFoldersBtn"',
    'id="pgLevelFilesBtn"',
    'id="pgLevelSymbolsBtn"',
    'id="pgLayoutLayeredBtn"',
    'id="pgLayoutForceBtn"',
    'id="pgToggleHullsBtn"',
    'id="pgToggleBundlingBtn"',
    'id="pgToggleMinimapBtn"',
    'id="pgToggleWebglBtn"',
    'id="pgLimitSelect"',
    'id="pgSemanticSearchBtn"',
    'id="pgExportMermaidBtn"',
    'id="pgExportPngBtn"',
    'id="pgLensArchBtn"',
    'id="pgLensBlastBtn"',
    'id="pgLensCyclesBtn"',
    'id="pgLensHotspotsBtn"',
    'id="pgLensPathBtn"',
    'id="pgContextCart"',
    'id="pgInspLensPanel"',
    'data-action="pgSetLens"',
    'data-action="pgSendCartToComposer"',
    'data-input-action="onProjectGraphSearch"',
    'data-change-action="pgChangeDepth"',
    'data-change-action="pgChangeNodeLimit"',
    'data-action="pgSendToComposer"',
    'function pgGetNodeScreenRadius(',
    'function pgBuildMacroGraph(',
    'function pgComputeLayeredLayout(',
    'function pgComputeConvexHull(',
    'function pgEvalEdgePoint(',
    'function pgComputeTransitiveBlast(',
    'function pgQueryGraphPath(',
    'function pgComputeBundledEdgeGeom(',
    'function pgDrawMinimap(',
    'function pgOpenFileSymbols(',
    'function pgBuildMermaidDiagram(',
    'function pgBuildQuadtree(',
    'function pgApplyBarnesHutRepulsion(',
    'function pgFindNodeQuadtree(',
    'function pgRenderWebgl2Scene(',
    'pg-standalone',
    'pgInitStandaloneIfNeeded',
  ]) {
    assert.ok(uiHtml.includes(marker), `ui.html missing ${marker}`);
  }

  // Verify #projectGraphModal sits outside .lg-shell (after #onboardingWizardModal, direct child of <body>)
  const wizIdx = uiHtml.indexOf('id="onboardingWizardModal"');
  const pgIdx = uiHtml.indexOf('id="projectGraphModal"');
  const scriptIdx = uiHtml.indexOf('<script>\n    // =========================================================================');
  assert.ok(wizIdx > 0 && pgIdx > wizIdx, '#projectGraphModal must appear after #onboardingWizardModal (outside .lg-shell)');
  assert.ok(scriptIdx > pgIdx, '#projectGraphModal must appear before inline panel script');
});

test('2. GET /api/project-graph returns global graph, filters tests, and traverses local BFS hops', async () => {
  const tmpWs = makeTmpDir('tunnel-pg-ws-');
  const tmpPanelDir = makeTmpDir('tunnel-pg-panel-');
  const prevIsolate = process.env.TUNNEL_TEST_ISOLATE_INSTALLED;
  const prevStatePath = process.env.TUNNEL_TEST_STATE_PATH;
  const prevCacheDir = process.env.TUNNEL_CACHE_DIR;

  fs.mkdirSync(path.join(tmpWs, 'core'), { recursive: true });
  fs.mkdirSync(path.join(tmpWs, 'ui'), { recursive: true });
  fs.mkdirSync(path.join(tmpWs, 'tests'), { recursive: true });

  fs.writeFileSync(
    path.join(tmpWs, 'core', 'hub.mjs'),
    'export function sharedHub(v) { return v + 1; }\n',
    'utf8'
  );
  fs.writeFileSync(
    path.join(tmpWs, 'core', 'service.mjs'),
    "import { sharedHub } from './hub.mjs';\nexport function runService(x) { return sharedHub(x); }\n",
    'utf8'
  );
  fs.writeFileSync(
    path.join(tmpWs, 'ui', 'view.mjs'),
    "import { runService } from '../core/service.mjs';\nexport function renderView() { return runService(1); }\n",
    'utf8'
  );
  fs.writeFileSync(
    path.join(tmpWs, 'core', 'isolated.mjs'),
    'export const loneConst = 42;\n',
    'utf8'
  );
  fs.writeFileSync(
    path.join(tmpWs, 'tests', 'service.test.mjs'),
    "import { runService } from '../core/service.mjs';\nconsole.log(runService(2));\n",
    'utf8'
  );
  fs.writeFileSync(
    path.join(tmpWs, 'README.md'),
    'Architecture hub lives in `core/hub.mjs`.\n',
    'utf8'
  );

  class MiniSidecarApp {
    constructor() {
      this._routes = new Map();
    }
    page() {}
    api(p, handler, method = 'POST') {
      if (!this._routes.has(p)) this._routes.set(p, new Map());
      this._routes.get(p).set(method.toUpperCase(), handler);
    }
    run() {
      return http.createServer();
    }
  }

  process.env.TUNNEL_TEST_ISOLATE_INSTALLED = '1';
  process.env.TUNNEL_TEST_STATE_PATH = path.join(tmpPanelDir, 'router-state.json');
  process.env.TUNNEL_CACHE_DIR = path.join(tmpPanelDir, '.cache');
  const app = await startSidecarPanel({ SidecarAppClass: MiniSidecarApp });

  try {
    const graphHandler = app._routes.get('/api/project-graph')?.get('GET');
    assert.equal(typeof graphHandler, 'function', '/api/project-graph GET route must be registered');

    // Global mode (tests hidden by default)
    const globalRes = await graphHandler({ rootDir: tmpWs, includeTests: '0', includeDocs: '1' });
    assert.equal(globalRes.ok, true);
    assert.ok(globalRes.nodes.length >= 4);
    assert.equal(
      globalRes.nodes.some((n) => n.id === 'tests/service.test.mjs'),
      false,
      'Test files must be excluded when includeTests=0'
    );
    assert.ok(
      globalRes.edges.some((e) => e.source === 'core/service.mjs' && e.target === 'core/hub.mjs' && e.kind === 'import'),
      'Import edge core/service.mjs -> core/hub.mjs must be present'
    );
    assert.ok(
      globalRes.edges.some((e) => e.source === 'README.md' && e.target === 'core/hub.mjs' && e.kind === 'doc'),
      'Doc edge README.md -> core/hub.mjs must be present'
    );

    // Global mode with includeTests=1
    const withTestsRes = await graphHandler({ rootDir: tmpWs, includeTests: '1', includeDocs: '1' });
    assert.equal(withTestsRes.ok, true);
    assert.equal(
      withTestsRes.nodes.some((n) => n.id === 'tests/service.test.mjs' && n.isTest === true),
      true,
      'Test file must appear when includeTests=1'
    );

    // Local 1-hop BFS around ui/view.mjs (should include core/service.mjs at hop 1, omit core/isolated.mjs & core/hub.mjs)
    const localRes = await graphHandler({
      rootDir: tmpWs,
      focus: 'ui/view.mjs',
      depth: '1',
      includeTests: '0',
      includeDocs: '0',
    });
    assert.equal(localRes.ok, true);
    assert.equal(localRes.focus, 'ui/view.mjs');
    const localIds = new Set(localRes.nodes.map((n) => n.id));
    assert.equal(localIds.has('ui/view.mjs'), true);
    assert.equal(localIds.has('core/service.mjs'), true);
    assert.equal(localIds.has('core/hub.mjs'), false, 'depth=1 from ui/view.mjs must not reach 2-hop core/hub.mjs');
    assert.equal(localIds.has('core/isolated.mjs'), false, 'isolated file must not appear in local BFS');
    const focusNode = localRes.nodes.find((n) => n.id === 'ui/view.mjs');
    const hop1Node = localRes.nodes.find((n) => n.id === 'core/service.mjs');
    assert.equal(focusNode?.hop, 0);
    assert.equal(hop1Node?.hop, 1);

    const openWindowHandler = app._routes.get('/api/project-graph/open-window')?.get('POST');
    assert.equal(typeof openWindowHandler, 'function', '/api/project-graph/open-window POST route must be registered');
    const openWinRes = await openWindowHandler({
      rootDir: tmpWs,
      dryRun: true,
      token: 'test-tok',
    }, {
      method: 'POST',
      headers: { host: '127.0.0.1:41234', origin: 'http://127.0.0.1:41234', 'x-router-panel': 'antigravity-v38', 'x-sidecar-token': 'test-tok' },
    });
    assert.equal(openWinRes.ok, true);
    assert.equal(openWinRes.dryRun, true);
    assert.ok(openWinRes.url.startsWith('http://127.0.0.1:41234/?'), `Unexpected standalone URL: ${openWinRes.url}`);
    assert.ok(openWinRes.url.includes('view=graph'), 'Standalone URL must include view=graph');
    assert.ok(openWinRes.url.includes('rootDir='), 'Standalone URL must include rootDir');
  } finally {
    try {
      knowledgeHub.close();
    } catch {}
    if (prevIsolate === undefined) delete process.env.TUNNEL_TEST_ISOLATE_INSTALLED;
    else process.env.TUNNEL_TEST_ISOLATE_INSTALLED = prevIsolate;
    if (prevStatePath === undefined) delete process.env.TUNNEL_TEST_STATE_PATH;
    else process.env.TUNNEL_TEST_STATE_PATH = prevStatePath;
    if (prevCacheDir === undefined) delete process.env.TUNNEL_CACHE_DIR;
    else process.env.TUNNEL_CACHE_DIR = prevCacheDir;
    fs.rmSync(tmpWs, { recursive: true, force: true });
    fs.rmSync(tmpPanelDir, { recursive: true, force: true });
  }
});

test('3. Standalone ?view=graph boots compiled ui.html script without TDZ ReferenceError and loads graph', async () => {
  const uiHtml = fs.readFileSync(path.join(ROOT_DIR, 'sidecars', 'panel', 'ui.html'), 'utf8');
  const scriptMatches = [...uiHtml.matchAll(/<script>([\s\S]*?)<\/script>/gi)];
  const mainScriptMatch = scriptMatches.find((m) => m[1].includes('pgInitStandaloneIfNeeded'));
  assert.ok(mainScriptMatch, 'Main compiled panel script containing pgInitStandaloneIfNeeded must exist in ui.html');

  const makeClassList = () => {
    const set = new Set();
    return {
      add: (...cls) => cls.filter(Boolean).forEach((c) => set.add(c)),
      remove: (...cls) => cls.forEach((c) => set.delete(c)),
      toggle: (c, force) => {
        if (force === true) { set.add(c); return true; }
        if (force === false) { set.delete(c); return false; }
        if (set.has(c)) { set.delete(c); return false; }
        set.add(c);
        return true;
      },
      contains: (c) => set.has(c),
    };
  };

  const makeMockEl = (tag = 'div', id = '') => {
    const attrs = new Map();
    return {
      id,
      tagName: tag.toUpperCase(),
      className: '',
      classList: makeClassList(),
      style: { setProperty() {}, removeProperty() {} },
      dataset: {},
      value: '',
      textContent: '',
      innerHTML: '',
      disabled: false,
      title: '',
      clientWidth: 1200,
      clientHeight: 800,
      setAttribute: (k, v) => attrs.set(String(k), String(v)),
      getAttribute: (k) => (attrs.has(String(k)) ? attrs.get(String(k)) : null),
      removeAttribute: (k) => attrs.delete(String(k)),
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() { return true; },
      querySelector: () => null,
      querySelectorAll: () => [],
      appendChild: (c) => c,
      getBoundingClientRect: () => ({ width: 1200, height: 800, left: 0, top: 0 }),
      focus() {},
      blur() {},
    };
  };

  const fakeCtx2d = {
    save() {},
    restore() {},
    setTransform() {},
    clearRect() {},
    fillRect() {},
    strokeRect() {},
    beginPath() {},
    closePath() {},
    moveTo() {},
    lineTo() {},
    quadraticCurveTo() {},
    bezierCurveTo() {},
    arc() {},
    roundRect() {},
    fill() {},
    stroke() {},
    fillText() {},
    setLineDash() {},
    measureText: (t) => ({ width: String(t || '').length * 7 }),
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    globalAlpha: 1,
  };

  const elements = new Map();
  for (const id of [
    'projectGraphModal',
    'projectGraphCanvas',
    'pgInspector',
    'pgStatsBadge',
    'pgTitleWorkspace',
    'pgClusterPills',
    'pgEmptyHint',
    'pgZoomIndicator',
    'pgSearchClearBtn',
    'pgSearchInput',
    'pgDepthSelect',
    'pgLegendBar',
    'pgLevelFoldersBtn',
    'pgLevelFilesBtn',
    'pgLayoutLayeredBtn',
    'pgLayoutForceBtn',
    'pgModeGlobalBtn',
    'pgModeLocalBtn',
    'pgToggleHullsBtn',
    'pgToggleLabelsBtn',
    'pgToggleTestsBtn',
    'pgToggleDocsBtn',
  ]) {
    elements.set(id, makeMockEl(id === 'projectGraphCanvas' ? 'canvas' : 'div', id));
  }
  const canvasEl = elements.get('projectGraphCanvas');
  canvasEl.parentElement = makeMockEl('div', 'pgCanvasStage');
  canvasEl.getContext = () => fakeCtx2d;

  const bodyEl = makeMockEl('body');
  const htmlEl = makeMockEl('html');
  const doc = {
    visibilityState: 'visible',
    activeElement: null,
    title: 'The Tunnel',
    body: bodyEl,
    documentElement: htmlEl,
    getElementById: (id) => elements.get(id) || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag) => makeMockEl(tag),
    addEventListener() {},
    removeEventListener() {},
  };

  const storageMap = new Map();
  const localStorageMock = {
    getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
    setItem: (k, v) => storageMap.set(String(k), String(v)),
    removeItem: (k) => storageMap.delete(String(k)),
  };

  const fetchedUrls = [];
  const fetchMock = async (url) => {
    const u = String(url || '');
    fetchedUrls.push(u);
    if (u.startsWith('/api/state')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          state: { panelTheme: 'glass_teal', uiLanguage: 'ru' },
        }),
      };
    }
    if (u.startsWith('/api/project-graph')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          rootDir: 'C:/repo',
          mode: 'global',
          totalFiles: 2,
          shownNodes: 2,
          clusters: [{ id: 'core', label: 'core', count: 2 }],
          nodes: [
            { id: 'core/hub.mjs', label: 'hub.mjs', cluster: 'core', inDegree: 1, outDegree: 0, degree: 1, isGod: true, lines: 100 },
            { id: 'core/leaf.mjs', label: 'leaf.mjs', cluster: 'core', inDegree: 0, outDegree: 1, degree: 1, isGod: false, lines: 40 },
          ],
          edges: [
            { source: 'core/leaf.mjs', target: 'core/hub.mjs', kind: 'import' },
          ],
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };

  const windowObj = {
    innerWidth: 1440,
    innerHeight: 900,
    devicePixelRatio: 1,
    location: { search: '?view=graph&token=tok123&rootDir=C%3A%2Frepo', reload() {} },
    fetch: fetchMock,
    localStorage: localStorageMock,
    navigator: { clipboard: { writeText: async () => {} } },
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame: () => 0,
    cancelAnimationFrame() {},
    ResizeObserver: class { observe() {} disconnect() {} },
    IntersectionObserver: class { observe() {} disconnect() {} },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  };

  const unhandledRejections = [];
  const onUnhandled = (reason) => unhandledRejections.push(reason);
  process.on('unhandledRejection', onUnhandled);

  try {
    const ctx = vm.createContext({
      window: windowObj,
      document: doc,
      localStorage: localStorageMock,
      navigator: windowObj.navigator,
      location: windowObj.location,
      CSS: { escape: (s) => String(s) },
      URL,
      URLSearchParams,
      AbortController,
      performance,
      ResizeObserver: windowObj.ResizeObserver,
      IntersectionObserver: windowObj.IntersectionObserver,
      Event: class { constructor(type) { this.type = type; } },
      CustomEvent: class { constructor(type, opts = {}) { this.type = type; this.detail = opts.detail; } },
      requestAnimationFrame: windowObj.requestAnimationFrame,
      cancelAnimationFrame: windowObj.cancelAnimationFrame,
      setTimeout: () => 0,
      clearTimeout() {},
      setInterval: () => 0,
      clearInterval() {},
      fetch: fetchMock,
      console,
      Promise,
      Set,
      Map,
      WeakMap,
      Array,
      Object,
      String,
      Number,
      Boolean,
      Math,
      Date,
      JSON,
      RegExp,
      Error,
      encodeURIComponent,
      decodeURIComponent,
    });

    vm.runInContext(mainScriptMatch[1], ctx, { filename: 'sidecars/panel/ui.html' });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    assert.equal(
      unhandledRejections.length,
      0,
      `Standalone boot must not emit unhandled rejections (e.g. TDZ): ${unhandledRejections.map((r) => String(r?.stack || r)).join('; ')}`
    );
    assert.equal(bodyEl.classList.contains('pg-standalone'), true, 'body must receive pg-standalone class');
    assert.equal(elements.get('projectGraphModal').classList.contains('visible'), true, '#projectGraphModal must receive .visible class');
    assert.equal(fetchedUrls.some((u) => u.startsWith('/api/project-graph')), true, 'Must fetch /api/project-graph on standalone boot');
    assert.equal(fetchedUrls.some((u) => u.startsWith('/api/state')), true, 'Must fetch /api/state to sync theme/lang');
    assert.equal(doc.title, 'Карта проекта · The Tunnel', 'Standalone document title must be localized');
    assert.equal(fetchedUrls.some((u) => u.startsWith('/api/panel-sections')), false, 'Normal panel polling/init must be skipped in standalone view');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('4. Project Graph Phase 1 API & IPC: Tarjan SCC cycles, orphans, testFilesByTarget, path finder & git-diff fallback', async () => {
  const tmpWs = makeTmpDir('tunnel-pg-p1-ws-');
  const tmpPanelDir = makeTmpDir('tunnel-pg-p1-panel-');
  const prevIsolate = process.env.TUNNEL_TEST_ISOLATE_INSTALLED;
  const prevStatePath = process.env.TUNNEL_TEST_STATE_PATH;
  const prevCacheDir = process.env.TUNNEL_CACHE_DIR;

  fs.mkdirSync(path.join(tmpWs, 'core'), { recursive: true });
  fs.mkdirSync(path.join(tmpWs, 'ui'), { recursive: true });
  fs.mkdirSync(path.join(tmpWs, 'tests'), { recursive: true });

  fs.writeFileSync(
    path.join(tmpWs, 'core', 'hub.mjs'),
    'export function sharedHub(v) { return v + 1; }\n',
    'utf8'
  );
  fs.writeFileSync(
    path.join(tmpWs, 'core', 'service.mjs'),
    "import { sharedHub } from './hub.mjs';\nexport function runService(x) { return sharedHub(x); }\n",
    'utf8'
  );
  fs.writeFileSync(
    path.join(tmpWs, 'ui', 'view.mjs'),
    "import { runService } from '../core/service.mjs';\nexport function renderView() { return runService(1); }\n",
    'utf8'
  );
  fs.writeFileSync(
    path.join(tmpWs, 'core', 'cycA.mjs'),
    "import { cycB } from './cycB.mjs';\nexport function cycA(n) { return n > 0 ? cycB(n - 1) : 0; }\n",
    'utf8'
  );
  fs.writeFileSync(
    path.join(tmpWs, 'core', 'cycB.mjs'),
    "import { cycA } from './cycA.mjs';\nexport function cycB(n) { return n > 0 ? cycA(n - 1) : 1; }\n",
    'utf8'
  );
  fs.writeFileSync(
    path.join(tmpWs, 'core', 'isolated.mjs'),
    'export const loneConst = 42;\n',
    'utf8'
  );
  fs.writeFileSync(
    path.join(tmpWs, 'tests', 'service.test.mjs'),
    "import { runService } from '../core/service.mjs';\nconsole.log(runService(2));\n",
    'utf8'
  );

  class MiniSidecarApp {
    constructor() {
      this._routes = new Map();
    }
    page() {}
    api(p, handler, method = 'POST') {
      if (!this._routes.has(p)) this._routes.set(p, new Map());
      this._routes.get(p).set(method.toUpperCase(), handler);
    }
    run() {
      return http.createServer();
    }
  }

  process.env.TUNNEL_TEST_ISOLATE_INSTALLED = '1';
  process.env.TUNNEL_TEST_STATE_PATH = path.join(tmpPanelDir, 'router-state.json');
  process.env.TUNNEL_CACHE_DIR = path.join(tmpPanelDir, '.cache');
  const app = await startSidecarPanel({ SidecarAppClass: MiniSidecarApp });
  const ipcEngine = new RamMemoryEngine({ budgetMb: 64, sqliteKnowledgeEnabled: false });

  try {
    const graphHandler = app._routes.get('/api/project-graph')?.get('GET');
    const pathHandler = app._routes.get('/api/project-graph/path')?.get('GET');
    const gitDiffHandler = app._routes.get('/api/project-graph/git-diff')?.get('GET');
    assert.equal(typeof graphHandler, 'function');
    assert.equal(typeof pathHandler, 'function');
    assert.equal(typeof gitDiffHandler, 'function');

    const res = await graphHandler({ rootDir: tmpWs, includeTests: '0', includeDocs: '0' });
    assert.equal(res.ok, true);
    assert.ok(Array.isArray(res.cycles) && res.cycles.length >= 1, 'Tarjan SCC must detect cycA <-> cycB cycle');
    assert.ok(res.cycleEdgeKeys.includes('core/cycA.mjs->core/cycB.mjs'));
    assert.ok(res.cycleEdgeKeys.includes('core/cycB.mjs->core/cycA.mjs'));
    assert.ok(res.orphanIds.includes('core/isolated.mjs'), 'Orphan detection must catch core/isolated.mjs');
    assert.ok(
      Array.isArray(res.testFilesByTarget?.['core/service.mjs']) &&
        res.testFilesByTarget['core/service.mjs'].includes('tests/service.test.mjs'),
      'testFilesByTarget must map test coverage even when includeTests=0'
    );
    const hubNode = res.nodes.find((n) => n.id === 'core/hub.mjs');
    assert.ok(hubNode && hubNode.estTokens > 0, 'Nodes must include positive estTokens');

    const pathRes = await pathHandler({ rootDir: tmpWs, from: 'ui/view.mjs', to: 'core/hub.mjs', direction: 'both', maxDepth: '6' });
    assert.equal(pathRes.ok, true);
    assert.equal(pathRes.found, true);
    assert.ok(pathRes.hops >= 2, `Expected >=2 hops, got ${pathRes.hops}`);
    const pathFiles = new Set((pathRes.path || []).map((p) => p.file).filter(Boolean));
    assert.equal(pathFiles.has('ui/view.mjs'), true);
    assert.equal(pathFiles.has('core/hub.mjs'), true);

    const diffRes = await gitDiffHandler({ rootDir: tmpWs });
    assert.equal(diffRes.ok, true);
    assert.equal(diffRes.available, false);
    assert.deepEqual(diffRes.changedFiles, []);

    const ipcGraphRes = await dispatchIpcRoute(
      'POST',
      '/graph/project-map',
      { wsPath: tmpWs, includeTests: false, includeDocs: false },
      { engine: ipcEngine, settings: { enabled: true }, sentinel: null }
    );
    assert.equal(ipcGraphRes.status, 200);
    assert.equal(ipcGraphRes.body?.ok, true);
    assert.equal(ipcGraphRes.body?.source, 'ram_daemon');
    assert.ok(Array.isArray(ipcGraphRes.body?.cycles) && ipcGraphRes.body.cycles.length >= 1);

    const ipcPathRes = await dispatchIpcRoute(
      'POST',
      '/graph/path',
      { wsPath: tmpWs, from: 'ui/view.mjs', to: 'core/hub.mjs', maxDepth: 6, direction: 'both' },
      { engine: ipcEngine, settings: { enabled: true }, sentinel: null }
    );
    assert.equal(ipcPathRes.status, 200);
    assert.equal(ipcPathRes.body?.found, true);
  } finally {
    try { ipcEngine.evict('all'); } catch {}
    try { knowledgeHub.close(); } catch {}
    if (prevIsolate === undefined) delete process.env.TUNNEL_TEST_ISOLATE_INSTALLED;
    else process.env.TUNNEL_TEST_ISOLATE_INSTALLED = prevIsolate;
    if (prevStatePath === undefined) delete process.env.TUNNEL_TEST_STATE_PATH;
    else process.env.TUNNEL_TEST_STATE_PATH = prevStatePath;
    if (prevCacheDir === undefined) delete process.env.TUNNEL_CACHE_DIR;
    else process.env.TUNNEL_CACHE_DIR = prevCacheDir;
    fs.rmSync(tmpWs, { recursive: true, force: true });
    fs.rmSync(tmpPanelDir, { recursive: true, force: true });
  }
});

test('5. Frontend VM lenses: pgComputeTransitiveBlast, pgSetLens(cycles), pgAddBlastWaveToCart & pgSendCartToComposer', async () => {
  const uiHtml = fs.readFileSync(path.join(ROOT_DIR, 'sidecars', 'panel', 'ui.html'), 'utf8');
  const scriptMatches = [...uiHtml.matchAll(/<script>([\s\S]*?)<\/script>/gi)];
  const mainScriptMatch = scriptMatches.find((m) => m[1].includes('pgComputeTransitiveBlast'));
  assert.ok(mainScriptMatch, 'Compiled panel script containing pgComputeTransitiveBlast must exist');

  const makeClassList = () => {
    const set = new Set();
    return {
      add: (...cls) => cls.filter(Boolean).forEach((c) => set.add(c)),
      remove: (...cls) => cls.forEach((c) => set.delete(c)),
      toggle: (c, force) => {
        if (force === true) { set.add(c); return true; }
        if (force === false) { set.delete(c); return false; }
        if (set.has(c)) { set.delete(c); return false; }
        set.add(c);
        return true;
      },
      contains: (c) => set.has(c),
    };
  };

  const makeMockEl = (tag = 'div', id = '') => {
    const attrs = new Map();
    return {
      id,
      tagName: tag.toUpperCase(),
      className: '',
      classList: makeClassList(),
      style: { setProperty() {}, removeProperty() {} },
      dataset: {},
      value: '',
      textContent: '',
      innerHTML: '',
      disabled: false,
      title: '',
      clientWidth: 1200,
      clientHeight: 800,
      setAttribute: (k, v) => attrs.set(String(k), String(v)),
      getAttribute: (k) => (attrs.has(String(k)) ? attrs.get(String(k)) : null),
      removeAttribute: (k) => attrs.delete(String(k)),
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() { return true; },
      querySelector: () => null,
      querySelectorAll: () => [],
      appendChild: (c) => c,
      getBoundingClientRect: () => ({ width: 1200, height: 800, left: 0, top: 0 }),
      focus() {},
      blur() {},
    };
  };

  const fakeCtx2d = {
    save() {}, restore() {}, setTransform() {}, clearRect() {}, fillRect() {}, strokeRect() {},
    beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, quadraticCurveTo() {}, bezierCurveTo() {},
    arc() {}, roundRect() {}, fill() {}, stroke() {}, fillText() {}, strokeText() {}, setLineDash() {}, clip() {},
    measureText: (t) => ({ width: String(t || '').length * 7 }),
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: 'left', textBaseline: 'alphabetic', globalAlpha: 1,
  };

  const elements = new Map();
  for (const id of [
    'projectGraphModal', 'projectGraphCanvas', 'pgInspector', 'pgInspFilename', 'pgInspPath',
    'pgInspBadges', 'pgInspMetrics', 'pgInspTabs', 'pgInspLensPanel', 'pgInspList', 'pgInspActions',
    'pgContextCart', 'pgCartSummary', 'pgStatsPill', 'pgProjectBadge', 'pgClusterPills',
    'pgLegendExtra', 'pgLensArchBtn', 'pgLensBlastBtn', 'pgLensCyclesBtn', 'pgLensPathBtn',
    'pgActionFocusBtn', 'pgActionPathBtn', 'pgActionCopyBtn', 'pgActionCartToggleBtn', 'pgActionComposerBtn',
    'smartComposerInput',
  ]) {
    elements.set(id, makeMockEl(id === 'projectGraphCanvas' ? 'canvas' : 'div', id));
  }
  const canvasEl = elements.get('projectGraphCanvas');
  canvasEl.parentElement = makeMockEl('div', 'pgCanvasStage');
  canvasEl.getContext = () => fakeCtx2d;

  const doc = {
    visibilityState: 'visible',
    activeElement: null,
    title: 'The Tunnel',
    body: makeMockEl('body'),
    documentElement: makeMockEl('html'),
    getElementById: (id) => elements.get(id) || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag) => makeMockEl(tag),
    addEventListener() {},
    removeEventListener() {},
  };

  const localStorageMock = { getItem: () => null, setItem() {}, removeItem() {} };
  const windowObj = {
    innerWidth: 1440,
    innerHeight: 900,
    devicePixelRatio: 1,
    location: { search: '', reload() {} },
    fetch: async (url) => {
      const u = String(url || '');
      if (u.startsWith('/api/project-graph/path')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            found: true,
            from: 'ui/view.mjs',
            to: 'core/hub.mjs',
            hops: 2,
            path: [
              { kind: 'file', file: 'ui/view.mjs', label: 'view.mjs' },
              { kind: 'file', file: 'core/service.mjs', label: 'service.mjs' },
              { kind: 'file', file: 'core/hub.mjs', label: 'hub.mjs' },
            ],
            edges: [
              { from: 'file:ui/view.mjs', to: 'file:core/service.mjs', relation: 'IMPORT' },
              { from: 'file:core/service.mjs', to: 'file:core/hub.mjs', relation: 'IMPORT' },
            ],
          }),
        };
      }
      return { ok: false, status: 200, json: async () => ({ ok: false }) };
    },
    localStorage: localStorageMock,
    navigator: { clipboard: { writeText: async () => {} } },
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame: () => 0,
    cancelAnimationFrame() {},
    ResizeObserver: class { observe() {} disconnect() {} },
    IntersectionObserver: class { observe() {} disconnect() {} },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  };

  const ctx = vm.createContext({
    window: windowObj,
    document: doc,
    localStorage: localStorageMock,
    navigator: windowObj.navigator,
    location: windowObj.location,
    CSS: { escape: (s) => String(s) },
    URL,
    URLSearchParams,
    AbortController,
    performance,
    ResizeObserver: windowObj.ResizeObserver,
    IntersectionObserver: windowObj.IntersectionObserver,
    Event: class { constructor(type) { this.type = type; } },
    CustomEvent: class { constructor(type, opts = {}) { this.type = type; this.detail = opts.detail; } },
    requestAnimationFrame: windowObj.requestAnimationFrame,
    cancelAnimationFrame: windowObj.cancelAnimationFrame,
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    fetch: windowObj.fetch,
    console,
    Promise, Set, Map, WeakMap, Array, Object, String, Number, Boolean, Math, Date, JSON, RegExp, Error,
    encodeURIComponent, decodeURIComponent,
  });

  vm.runInContext(mainScriptMatch[1], ctx, { filename: 'sidecars/panel/ui.html' });

  const sampleRaw = {
    ok: true,
    workspaceName: 'sample',
    totalFiles: 5,
    shownNodes: 5,
    shownEdges: 4,
    modularityQ: 0.42,
    clusters: [{ id: 'core', label: 'core', size: 4 }, { id: 'ui', label: 'ui', size: 1 }],
    nodes: [
      { id: 'core/hub.mjs', label: 'hub.mjs', dir: 'core', lines: 50, estTokens: 400, inDeg: 1, outDeg: 0, isGod: true },
      { id: 'core/service.mjs', label: 'service.mjs', dir: 'core', lines: 30, estTokens: 250, inDeg: 1, outDeg: 1 },
      { id: 'ui/view.mjs', label: 'view.mjs', dir: 'ui', lines: 20, estTokens: 180, inDeg: 0, outDeg: 1 },
      { id: 'core/cycA.mjs', label: 'cycA.mjs', dir: 'core', lines: 15, estTokens: 120, inDeg: 1, outDeg: 1, inCycle: true },
      { id: 'core/cycB.mjs', label: 'cycB.mjs', dir: 'core', lines: 15, estTokens: 120, inDeg: 1, outDeg: 1, inCycle: true },
    ],
    edges: [
      { source: 'core/service.mjs', target: 'core/hub.mjs', kind: 'import' },
      { source: 'ui/view.mjs', target: 'core/service.mjs', kind: 'import' },
      { source: 'core/cycA.mjs', target: 'core/cycB.mjs', kind: 'import' },
      { source: 'core/cycB.mjs', target: 'core/cycA.mjs', kind: 'import' },
    ],
    cycles: [['core/cycA.mjs', 'core/cycB.mjs', 'core/cycA.mjs']],
    cycleNodeIds: ['core/cycA.mjs', 'core/cycB.mjs'],
    cycleEdgeKeys: ['core/cycA.mjs->core/cycB.mjs', 'core/cycB.mjs->core/cycA.mjs'],
    orphanIds: [],
    testFilesByTarget: { 'core/service.mjs': ['tests/service.test.mjs'] },
  };

  ctx.__testRaw = sampleRaw;
  const vmResult = await vm.runInContext(`(async () => {
    pgState.rawGraphData = __testRaw;
    pgState.viewLevel = 'files';
    pgState.gitDiffLoaded = true;
    pgHydrateSimulation(__testRaw);
    const blast = pgComputeTransitiveBlast(['core/hub.mjs'], 3);
    pgSetLens('cycles');
    const cyclesHtml = document.getElementById('pgInspLensPanel').innerHTML;
    const lensAfterCycles = pgState.lens;
    const viewAfterCycles = pgState.viewLevel;
    pgSetLens('blast');
    pgSelectNodeById('core/hub.mjs');
    pgAddBlastWaveToCart();
    pgSendCartToComposer();
    const composerFirst = document.getElementById('smartComposerInput').value;
    pgSendCartToComposer();
    const composerSecond = document.getElementById('smartComposerInput').value;
    await pgQueryGraphPath('ui/view.mjs', 'core/hub.mjs');
    const pathLen = pgState.pathFileSequence.length;
    const pathHtml = document.getElementById('pgInspLensPanel').innerHTML;
    return {
      byHop0: blast.byHop[0],
      byHop1: blast.byHop[1],
      byHop2: blast.byHop[2],
      affectedTests: blast.affectedTests,
      lensAfterCycles,
      viewAfterCycles,
      cyclesHtml,
      composerFirst,
      composerSecond,
      pathLen,
      pathHtml,
    };
  })()`, ctx);

  assert.deepEqual(Array.from(vmResult.byHop0), ['core/hub.mjs']);
  assert.deepEqual(Array.from(vmResult.byHop1), ['core/service.mjs']);
  assert.deepEqual(Array.from(vmResult.byHop2), ['ui/view.mjs']);
  assert.deepEqual(Array.from(vmResult.affectedTests), ['tests/service.test.mjs']);
  assert.equal(vmResult.lensAfterCycles, 'cycles');
  assert.equal(vmResult.viewAfterCycles, 'files');
  assert.ok(vmResult.cyclesHtml.includes('cycA.mjs') && vmResult.cyclesHtml.includes('cycB.mjs'));
  assert.ok(vmResult.composerFirst.includes('@file:core/hub.mjs'));
  assert.ok(vmResult.composerFirst.includes('@file:core/service.mjs'));
  assert.ok(vmResult.composerFirst.includes('@file:ui/view.mjs'));
  assert.equal(vmResult.composerFirst, vmResult.composerSecond, 'Duplicate @file tokens must not be appended');
  assert.equal(vmResult.pathLen, 3);
  assert.ok(vmResult.pathHtml.includes('core/service.mjs'));
});

test('6. Phase 2 Backend API & IPC: symbols graph, git-churn parser & fallback, semantic-search', async () => {
  const churnParsed = parseGitChurnOutput('\ncore/alpha.mjs\ncore\\alpha.mjs\n./ui/view.mjs\n');
  assert.equal(churnParsed.totalTouches, 3);
  assert.equal(churnParsed.maxChurn, 2);
  assert.equal(churnParsed.churnByFile['core/alpha.mjs'], 2);
  assert.equal(churnParsed.churnByFile['ui/view.mjs'], 1);

  const tmpWs = makeTmpDir('tunnel-pg-p2-ws-');
  const tmpPanelDir = makeTmpDir('tunnel-pg-p2-panel-');
  const prevIsolate = process.env.TUNNEL_TEST_ISOLATE_INSTALLED;
  const prevStatePath = process.env.TUNNEL_TEST_STATE_PATH;
  const prevCacheDir = process.env.TUNNEL_CACHE_DIR;

  fs.mkdirSync(path.join(tmpWs, 'core'), { recursive: true });
  fs.mkdirSync(path.join(tmpWs, 'ui'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpWs, 'core', 'math.mjs'),
    'export function computeWeight(x) { return x * 2; }\nexport function normalizeScore(v) { return computeWeight(v) + 1; }\n',
    'utf8'
  );
  fs.writeFileSync(
    path.join(tmpWs, 'core', 'pipeline.mjs'),
    'import { normalizeScore } from "./math.mjs";\nexport function runPipeline(input) {\n  return helperStep(input) + normalizeScore(input);\n}\nfunction helperStep(n) { return n + 3; }\n',
    'utf8'
  );
  fs.writeFileSync(
    path.join(tmpWs, 'ui', 'widget.mjs'),
    'import { runPipeline } from "../core/pipeline.mjs";\nexport function renderWidget() { return runPipeline(5); }\n',
    'utf8'
  );

  class MiniSidecarApp {
    constructor() {
      this._routes = new Map();
    }
    page() {}
    api(p, handler, method = 'POST') {
      if (!this._routes.has(p)) this._routes.set(p, new Map());
      this._routes.get(p).set(method.toUpperCase(), handler);
    }
    run() {
      return http.createServer();
    }
  }

  const ipcEngine = new RamMemoryEngine({ budgetMb: 64, sqliteKnowledgeEnabled: false });
  try {
    const unitSym = buildFileSymbolGraphPayload(ipcEngine, tmpWs, 'core/pipeline.mjs');
    assert.equal(unitSym.ok, true);
    assert.equal(unitSym.isSymbolsView, true);
    assert.ok(unitSym.nodes.some((n) => n.symbolName === 'runPipeline' && !n.isExternal));
    assert.ok(unitSym.nodes.some((n) => n.symbolName === 'helperStep' && !n.isExternal));
    assert.ok(unitSym.nodes.some((n) => n.symbolName === 'normalizeScore' && n.isExternal && n.file === 'core/math.mjs'));
    assert.ok(unitSym.edges.some((e) => e.kind === 'call'));

    const ipcSym = await dispatchIpcRoute(
      'POST',
      '/graph/symbols',
      { wsPath: tmpWs, file: 'core/pipeline.mjs' },
      { engine: ipcEngine, settings: { enabled: true }, sentinel: null }
    );
    assert.equal(ipcSym.status, 200);
    assert.equal(ipcSym.body.ok, true);
    assert.equal(ipcSym.body.source, 'ram_daemon');
    assert.equal(ipcSym.body.targetFile, 'core/pipeline.mjs');

    const ipcSem = await dispatchIpcRoute(
      'POST',
      '/graph/semantic-search',
      { wsPath: tmpWs, query: 'runPipeline' },
      { engine: ipcEngine, settings: { enabled: true }, sentinel: null }
    );
    assert.equal(ipcSem.status, 200);
    assert.equal(ipcSem.body.ok, true);
    assert.ok(ipcSem.body.scoresByFile['core/pipeline.mjs'] > 0);

    const panelStatePath = path.join(tmpPanelDir, 'router-state.json');
    fs.writeFileSync(panelStatePath, JSON.stringify({ uiLanguage: 'ru', panelTheme: 'glass_teal' }), 'utf8');
    process.env.TUNNEL_TEST_ISOLATE_INSTALLED = '1';
    process.env.TUNNEL_TEST_STATE_PATH = panelStatePath;
    process.env.TUNNEL_CACHE_DIR = path.join(tmpPanelDir, 'cache');

    const app = await startSidecarPanel({ SidecarAppClass: MiniSidecarApp });
    const symHandler = app._routes.get('/api/project-graph/symbols')?.get('GET');
    const churnHandler = app._routes.get('/api/project-graph/git-churn')?.get('GET');
    const semHandler = app._routes.get('/api/project-graph/semantic-search')?.get('GET');
    assert.equal(typeof symHandler, 'function');
    assert.equal(typeof churnHandler, 'function');
    assert.equal(typeof semHandler, 'function');

    const symRes = await symHandler({ rootDir: tmpWs, file: 'core/pipeline.mjs' });
    assert.equal(symRes.ok, true);
    assert.equal(symRes.isSymbolsView, true);
    assert.ok(symRes.nodes.some((n) => n.symbolName === 'runPipeline'));

    const churnRes = await churnHandler({ rootDir: tmpWs, days: '30' });
    assert.equal(churnRes.ok, true);
    assert.equal(churnRes.available, false);
    assert.equal(churnRes.days, 30);

    const semRes = await semHandler({ rootDir: tmpWs, q: 'normalizeScore' });
    assert.equal(semRes.ok, true);
    assert.ok(semRes.scoresByFile['core/math.mjs'] > 0 || semRes.scoresByFile['core/pipeline.mjs'] > 0);
  } finally {
    try { ipcEngine.evict('all'); } catch {}
    try { knowledgeHub.close(); } catch {}
    if (prevIsolate === undefined) delete process.env.TUNNEL_TEST_ISOLATE_INSTALLED;
    else process.env.TUNNEL_TEST_ISOLATE_INSTALLED = prevIsolate;
    if (prevStatePath === undefined) delete process.env.TUNNEL_TEST_STATE_PATH;
    else process.env.TUNNEL_TEST_STATE_PATH = prevStatePath;
    if (prevCacheDir === undefined) delete process.env.TUNNEL_CACHE_DIR;
    else process.env.TUNNEL_CACHE_DIR = prevCacheDir;
    fs.rmSync(tmpWs, { recursive: true, force: true });
    fs.rmSync(tmpPanelDir, { recursive: true, force: true });
  }
});

test('7. Phase 2 Frontend VM: Sugiyama bypass arcs, Edge Bundling, Minimap, Hotspots, AST Symbols, GPU Search & Exports', async () => {
  const uiHtml = fs.readFileSync(path.join(ROOT_DIR, 'sidecars', 'panel', 'ui.html'), 'utf8');
  const scriptMatches = [...uiHtml.matchAll(/<script>([\s\S]*?)<\/script>/gi)];
  const mainScriptMatch = scriptMatches.find((m) => m[1].includes('pgComputeBundledEdgeGeom'));
  assert.ok(mainScriptMatch, 'Compiled panel script containing Phase 2 helpers must exist');

  const makeClassList = () => {
    const set = new Set();
    return {
      add: (...cls) => cls.filter(Boolean).forEach((c) => set.add(c)),
      remove: (...cls) => cls.forEach((c) => set.delete(c)),
      toggle: (c, force) => {
        if (force === true) { set.add(c); return true; }
        if (force === false) { set.delete(c); return false; }
        if (set.has(c)) { set.delete(c); return false; }
        set.add(c);
        return true;
      },
      contains: (c) => set.has(c),
    };
  };

  const makeMockEl = (tag = 'div', id = '') => {
    const attrs = new Map();
    return {
      id,
      tagName: tag.toUpperCase(),
      className: '',
      classList: makeClassList(),
      style: { setProperty() {}, removeProperty() {} },
      dataset: {},
      value: '',
      href: '',
      download: '',
      textContent: '',
      innerHTML: '',
      disabled: false,
      title: '',
      clientWidth: 1200,
      clientHeight: 800,
      setAttribute: (k, v) => attrs.set(String(k), String(v)),
      getAttribute: (k) => (attrs.has(String(k)) ? attrs.get(String(k)) : null),
      removeAttribute: (k) => attrs.delete(String(k)),
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() { return true; },
      querySelector: () => null,
      querySelectorAll: () => [],
      appendChild: (c) => c,
      click() {},
      getBoundingClientRect: () => ({ width: 1200, height: 800, left: 0, top: 0 }),
      focus() {},
      blur() {},
    };
  };

  const fakeCtx2d = {
    save() {}, restore() {}, setTransform() {}, clearRect() {}, fillRect() {}, strokeRect() {},
    beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, quadraticCurveTo() {}, bezierCurveTo() {},
    arc() {}, roundRect() {}, fill() {}, stroke() {}, fillText() {}, strokeText() {}, setLineDash() {}, clip() {},
    measureText: (t) => ({ width: String(t || '').length * 7 }),
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: 'left', textBaseline: 'alphabetic', globalAlpha: 1,
  };

  const elements = new Map();
  for (const id of [
    'projectGraphModal', 'projectGraphCanvas', 'pgInspector', 'pgInspFilename', 'pgInspPath',
    'pgInspBadges', 'pgInspMetrics', 'pgInspTabs', 'pgInspLensPanel', 'pgInspList', 'pgInspActions',
    'pgContextCart', 'pgCartSummary', 'pgStatsPill', 'pgProjectBadge', 'pgClusterPills',
    'pgLegendExtra', 'pgLensArchBtn', 'pgLensBlastBtn', 'pgLensCyclesBtn', 'pgLensHotspotsBtn', 'pgLensPathBtn',
    'pgLevelFoldersBtn', 'pgLevelFilesBtn', 'pgLevelSymbolsBtn',
    'pgToggleBundlingBtn', 'pgToggleMinimapBtn', 'pgSemanticSearchBtn', 'pgEmptyState', 'pgEmptyTitle', 'pgEmptySub',
    'pgActionFocusBtn', 'pgActionSymbolsBtn', 'pgActionPathBtn', 'pgActionCopyBtn', 'pgActionCartToggleBtn', 'pgActionComposerBtn',
    'smartComposerInput',
  ]) {
    elements.set(id, makeMockEl(id === 'projectGraphCanvas' ? 'canvas' : 'div', id));
  }
  const canvasEl = elements.get('projectGraphCanvas');
  canvasEl.parentElement = makeMockEl('div', 'pgCanvasStage');
  canvasEl.getContext = () => fakeCtx2d;
  canvasEl.toDataURL = () => 'data:image/png;base64,MOCK_PNG';

  const doc = {
    visibilityState: 'visible',
    activeElement: null,
    title: 'The Tunnel',
    body: makeMockEl('body'),
    documentElement: makeMockEl('html'),
    getElementById: (id) => elements.get(id) || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag) => makeMockEl(tag),
    addEventListener() {},
    removeEventListener() {},
  };

  const localStorageMock = { getItem: () => null, setItem() {}, removeItem() {} };
  const windowObj = {
    innerWidth: 1440,
    innerHeight: 900,
    devicePixelRatio: 1,
    location: { search: '', reload() {} },
    fetch: async (url) => {
      const u = String(url || '');
      if (u.startsWith('/api/project-graph/git-churn')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            available: true,
            days: 90,
            totalTouches: 14,
            maxChurn: 9,
            churnByFile: { 'core/hub.mjs': 9, 'core/service.mjs': 4, 'ui/view.mjs': 1 },
          }),
        };
      }
      if (u.startsWith('/api/project-graph/symbols')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            isSymbolsView: true,
            workspaceName: 'sample',
            targetFile: 'core/service.mjs',
            totalSymbols: 2,
            shownNodes: 3,
            shownEdges: 2,
            clusters: [{ id: 'internal:core/service.mjs', label: 'service.mjs', size: 2 }],
            nodes: [
              { id: 'sym:core/service.mjs#runSvc:1', label: 'runSvc', symbolName: 'runSvc', kind: 'function', file: 'core/service.mjs', startLine: 1, endLine: 10, lines: 10, isSymbol: true, isExternal: false, clusterId: 'internal:core/service.mjs', clusterLabel: 'service.mjs', inDeg: 0, outDeg: 2 },
              { id: 'sym:core/service.mjs#helperFn:12', label: 'helperFn', symbolName: 'helperFn', kind: 'function', file: 'core/service.mjs', startLine: 12, endLine: 18, lines: 7, isSymbol: true, isExternal: false, clusterId: 'internal:core/service.mjs', clusterLabel: 'service.mjs', inDeg: 1, outDeg: 0 },
              { id: 'sym:core/hub.mjs#saveData:1', label: 'saveData', symbolName: 'saveData', kind: 'external', file: 'core/hub.mjs', startLine: 1, endLine: 1, lines: 1, isSymbol: true, isExternal: true, clusterId: 'ext:core/hub.mjs', clusterLabel: 'core/hub.mjs', inDeg: 1, outDeg: 0 },
            ],
            edges: [
              { source: 'sym:core/service.mjs#runSvc:1', target: 'sym:core/service.mjs#helperFn:12', kind: 'call', weight: 1 },
              { source: 'sym:core/service.mjs#runSvc:1', target: 'sym:core/hub.mjs#saveData:1', kind: 'call', weight: 1 },
            ],
          }),
        };
      }
      if (u.startsWith('/api/project-graph/semantic-search')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            query: 'hub cache',
            mode: 'hybrid_gpu',
            scoresByFile: { 'core/hub.mjs': 1.0, 'core/service.mjs': 0.62 },
            matches: [{ file: 'core/hub.mjs', score: 1.0, line: 1 }],
          }),
        };
      }
      return { ok: false, status: 200, json: async () => ({ ok: false }) };
    },
    localStorage: localStorageMock,
    navigator: { clipboard: { writeText: async () => {} } },
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame: () => 0,
    cancelAnimationFrame() {},
    ResizeObserver: class { observe() {} disconnect() {} },
    IntersectionObserver: class { observe() {} disconnect() {} },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  };

  const ctx = vm.createContext({
    window: windowObj,
    document: doc,
    localStorage: localStorageMock,
    navigator: windowObj.navigator,
    location: windowObj.location,
    CSS: { escape: (s) => String(s) },
    URL,
    URLSearchParams,
    AbortController,
    performance,
    ResizeObserver: windowObj.ResizeObserver,
    IntersectionObserver: windowObj.IntersectionObserver,
    Event: class { constructor(type) { this.type = type; } },
    CustomEvent: class { constructor(type, opts = {}) { this.type = type; this.detail = opts.detail; } },
    requestAnimationFrame: windowObj.requestAnimationFrame,
    cancelAnimationFrame: windowObj.cancelAnimationFrame,
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    fetch: windowObj.fetch,
    console,
    Promise, Set, Map, WeakMap, Array, Object, String, Number, Boolean, Math, Date, JSON, RegExp, Error,
    encodeURIComponent, decodeURIComponent,
  });

  vm.runInContext(mainScriptMatch[1], ctx, { filename: 'sidecars/panel/ui.html' });

  ctx.__phase2Raw = {
    ok: true,
    workspaceName: 'sample-p2',
    totalFiles: 3,
    shownNodes: 3,
    shownEdges: 3,
    modularityQ: 0.35,
    clusters: [{ id: 'core', label: 'core', size: 2 }, { id: 'ui', label: 'ui', size: 1 }],
    nodes: [
      { id: 'ui/view.mjs', label: 'view.mjs', dir: 'ui', lines: 25, estTokens: 200, inDeg: 0, outDeg: 2 },
      { id: 'core/service.mjs', label: 'service.mjs', dir: 'core', lines: 40, estTokens: 320, inDeg: 1, outDeg: 1 },
      { id: 'core/hub.mjs', label: 'hub.mjs', dir: 'core', lines: 65, estTokens: 520, inDeg: 2, outDeg: 0, isGod: true },
    ],
    edges: [
      { source: 'ui/view.mjs', target: 'core/service.mjs', kind: 'import' },
      { source: 'core/service.mjs', target: 'core/hub.mjs', kind: 'import' },
      { source: 'ui/view.mjs', target: 'core/hub.mjs', kind: 'import' },
    ],
  };

  const res = await vm.runInContext(`(async () => {
    pgState.width = 1200;
    pgState.height = 800;
    pgState.rawGraphData = __phase2Raw;
    pgState.viewLevel = 'files';
    pgState.layoutMode = 'layered';
    pgHydrateSimulation(__phase2Raw);

    const longEdge = pgState.edges.find((e) => e.source.id === 'ui/view.mjs' && e.target.id === 'core/hub.mjs');
    const longSpan = longEdge ? longEdge._span : 0;
    const bypassArc = longEdge ? longEdge._bypassArc : 0;

    pgDrawGraph();
    const minimapRect = pgState.minimapRect ? { ...pgState.minimapRect } : null;
    const minimapHit = minimapRect ? pgHitTestMinimap(minimapRect.mx + 12, minimapRect.my + 12) : false;
    const prevCamX = pgState.camX;
    if (minimapRect) {
      pgPanCameraFromMinimap(minimapRect.mx + minimapRect.mw - 10, minimapRect.my + 12);
    }
    const camMovedOnMinimap = pgState.camX !== prevCamX;

    const bundled = longEdge
      ? pgComputeBundledEdgeGeom(longEdge, 100, 100, 500, 200, true, false, pgComputeBundleCentroids(pgState.nodes, true), false)
      : null;

    pgSetLens('hotspots');
    await pgLoadGitChurn(true);
    const hotspotCount = pgState.hotspotScoreMap.size;
    const hotspotsHtml = document.getElementById('pgInspLensPanel').innerHTML;

    pgToggleSemanticSearch();
    await pgRunSemanticSearch('hub cache');
    const semCount = pgState.semanticScores.size;
    const mmd = pgBuildMermaidDiagram();
    const png = pgExportPng();

    await pgOpenFileSymbols('core/service.mjs');
    const symLevel = pgState.viewLevel;
    const symNodesCount = pgState.nodes.length;
    const breadcrumbs = document.getElementById('pgClusterPills').innerHTML;
    pgExitSymbolsLevel('files');
    const restoredLevel = pgState.viewLevel;

    return {
      longSpan,
      bypassArc,
      hasMinimapRect: Boolean(minimapRect),
      minimapHit,
      camMovedOnMinimap,
      bundledIsCubic: Boolean(bundled && bundled.isCubic),
      hotspotCount,
      hotspotsHtml,
      semCount,
      mmd,
      png,
      symLevel,
      symNodesCount,
      breadcrumbs,
      restoredLevel,
    };
  })()`, ctx);

  assert.equal(res.longSpan, 2);
  assert.ok(Math.abs(res.bypassArc) > 0, 'Multi-tier edge must receive non-zero bypass arc');
  assert.equal(res.hasMinimapRect, true);
  assert.equal(res.minimapHit, true);
  assert.equal(res.camMovedOnMinimap, true);
  assert.equal(res.bundledIsCubic, true);
  assert.equal(res.hotspotCount, 3);
  assert.ok(res.hotspotsHtml.includes('hub.mjs'));
  assert.equal(res.semCount, 2);
  assert.ok(res.mmd.startsWith('flowchart LR') && res.mmd.includes('-->'));
  assert.equal(res.png, 'data:image/png;base64,MOCK_PNG');
  assert.equal(res.symLevel, 'symbols');
  assert.equal(res.symNodesCount, 3);
  assert.ok(res.breadcrumbs.includes('core/service.mjs'));
  assert.equal(res.restoredLevel, 'files');
});

test('8. Phase 3 Mega-Scale: maxNodes > 400 scaling, Barnes-Hut Quadtree O(N log N) 5k stress & WebGL2 Instanced Renderer', async () => {
  // 1) Verify backend buildProjectGraphPayload honors maxNodes > 400 (up to 25000)
  const fakeEngine = {
    ensureWarm() {
      const files = new Map();
      const forwardDeps = new Map();
      const reverseDeps = new Map();
      for (let i = 0; i < 650; i++) {
        const rel = `mod/f${i}.mjs`;
        files.set(rel, { ext: '.mjs', lineCount: 12, sizeBytes: 420, symbols: [] });
        forwardDeps.set(rel, new Set(i > 0 ? [`mod/f${i - 1}.mjs`] : []));
        reverseDeps.set(rel, new Set(i < 649 ? [`mod/f${i + 1}.mjs`] : []));
      }
      return { files, forwardDeps, reverseDeps };
    },
    getArchitectureClusters() {
      return { modularityQ: 0.4, clusters: [], godNodes: [], fileToCluster: new Map() };
    },
    getDocRefGraph() {
      return { codeFromDoc: new Map() };
    },
  };
  const scaled = buildProjectGraphPayload(fakeEngine, 'C:\\mega-repo', { maxNodes: 600, includeDocs: false });
  assert.equal(scaled.shownNodes, 600, 'buildProjectGraphPayload must no longer clamp maxNodes at 400');

  // 2) Verify Barnes-Hut Quadtree + WebGL2 Instanced Renderer + 5,000-node stress benchmark in VM
  const uiHtml = fs.readFileSync(path.join(ROOT_DIR, 'sidecars', 'panel', 'ui.html'), 'utf8');
  const scriptMatches = [...uiHtml.matchAll(/<script>([\s\S]*?)<\/script>/gi)];
  const mainScriptMatch = scriptMatches.find((m) => m[1].includes('pgRenderWebgl2Scene'));
  assert.ok(mainScriptMatch, 'Compiled panel script containing Phase 3 spatial/WebGL2 engine must exist');

  const makeClassList = () => {
    const set = new Set();
    return {
      add: (...cls) => cls.filter(Boolean).forEach((c) => set.add(c)),
      remove: (...cls) => cls.forEach((c) => set.delete(c)),
      toggle: (c, force) => {
        if (force === true) { set.add(c); return true; }
        if (force === false) { set.delete(c); return false; }
        if (set.has(c)) { set.delete(c); return false; }
        set.add(c);
        return true;
      },
      contains: (c) => set.has(c),
    };
  };

  let drawnImages = 0;
  const fakeCtx2d = {
    save() {}, restore() {}, setTransform() {}, clearRect() {}, fillRect() {}, strokeRect() {},
    beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, quadraticCurveTo() {}, bezierCurveTo() {},
    arc() {}, roundRect() {}, fill() {}, stroke() {}, fillText() {}, strokeText() {}, setLineDash() {}, clip() {},
    drawImage() { drawnImages += 1; },
    measureText: (t) => ({ width: String(t || '').length * 7 }),
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: 'left', textBaseline: 'alphabetic', globalAlpha: 1,
  };

  let glEdgesVertCount = 0;
  let glInstancedNodes = 0;
  const fakeGl = {
    VERTEX_SHADER: 0x8B31,
    FRAGMENT_SHADER: 0x8B30,
    COMPILE_STATUS: 0x8B81,
    LINK_STATUS: 0x8B82,
    ARRAY_BUFFER: 0x8892,
    STATIC_DRAW: 0x88E4,
    DYNAMIC_DRAW: 0x88E8,
    FLOAT: 0x1406,
    LINES: 0x0001,
    TRIANGLE_STRIP: 0x0005,
    COLOR_BUFFER_BIT: 0x4000,
    BLEND: 0x0BE2,
    ONE: 1,
    ONE_MINUS_SRC_ALPHA: 0x0303,
    createShader: () => ({}),
    shaderSource() {},
    compileShader() {},
    getShaderParameter: () => true,
    deleteShader() {},
    createProgram: () => ({}),
    attachShader() {},
    linkProgram() {},
    getProgramParameter: () => true,
    deleteProgram() {},
    createBuffer: () => ({}),
    bindBuffer() {},
    bufferData() {},
    viewport() {},
    clearColor() {},
    clear() {},
    enable() {},
    blendFunc() {},
    useProgram() {},
    getUniformLocation: () => ({}),
    getAttribLocation: (_p, name) => (name ? name.length % 7 : 0),
    uniform2f() {},
    uniform1f() {},
    enableVertexAttribArray() {},
    vertexAttribPointer() {},
    vertexAttribDivisor() {},
    drawArrays(mode, _first, count) {
      if (mode === 0x0001) glEdgesVertCount = count;
    },
    drawArraysInstanced(_mode, _first, _vcount, instanceCount) {
      glInstancedNodes = instanceCount;
    },
  };

  const makeMockEl = (tag = 'div', id = '') => {
    const attrs = new Map();
    return {
      id,
      tagName: tag.toUpperCase(),
      className: '',
      classList: makeClassList(),
      style: { setProperty() {}, removeProperty() {} },
      dataset: {},
      value: '',
      href: '',
      download: '',
      width: 1200,
      height: 800,
      textContent: '',
      innerHTML: '',
      disabled: false,
      title: '',
      clientWidth: 1200,
      clientHeight: 800,
      setAttribute: (k, v) => attrs.set(String(k), String(v)),
      getAttribute: (k) => (attrs.has(String(k)) ? attrs.get(String(k)) : null),
      removeAttribute: (k) => attrs.delete(String(k)),
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() { return true; },
      querySelector: () => null,
      querySelectorAll: () => [],
      appendChild: (c) => c,
      click() {},
      getBoundingClientRect: () => ({ width: 1200, height: 800, left: 0, top: 0 }),
      focus() {},
      blur() {},
    };
  };

  const elements = new Map();
  for (const id of [
    'projectGraphModal', 'projectGraphCanvas', 'projectGraphWebglCanvas', 'pgInspector', 'pgInspFilename', 'pgInspPath',
    'pgInspBadges', 'pgInspMetrics', 'pgInspTabs', 'pgInspLensPanel', 'pgInspList', 'pgInspActions',
    'pgContextCart', 'pgCartSummary', 'pgStatsPill', 'pgProjectBadge', 'pgClusterPills',
    'pgLegendExtra', 'pgToggleWebglBtn', 'pgLimitSelect', 'smartComposerInput',
  ]) {
    elements.set(id, makeMockEl(id.toLowerCase().includes('canvas') ? 'canvas' : 'div', id));
  }
  const canvasEl = elements.get('projectGraphCanvas');
  canvasEl.parentElement = makeMockEl('div', 'pgCanvasStage');
  canvasEl.getContext = () => fakeCtx2d;
  canvasEl.toDataURL = () => 'data:image/png;base64,BASE_2D';

  const glCanvasEl = elements.get('projectGraphWebglCanvas');
  glCanvasEl.getContext = (kind) => (kind === 'webgl2' ? fakeGl : null);

  const doc = {
    visibilityState: 'visible',
    activeElement: null,
    title: 'The Tunnel',
    body: makeMockEl('body'),
    documentElement: makeMockEl('html'),
    getElementById: (id) => elements.get(id) || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag) => {
      const el = makeMockEl(tag);
      if (String(tag).toLowerCase() === 'canvas') {
        el.getContext = () => fakeCtx2d;
        el.toDataURL = () => 'data:image/png;base64,COMPOSITE_WEBGL2_PNG';
      }
      return el;
    },
    addEventListener() {},
    removeEventListener() {},
  };

  const localStorageMock = { getItem: () => null, setItem() {}, removeItem() {} };
  const windowObj = {
    innerWidth: 1440,
    innerHeight: 900,
    devicePixelRatio: 1,
    location: { search: '', reload() {} },
    fetch: async () => ({ ok: false, status: 200, json: async () => ({ ok: false }) }),
    localStorage: localStorageMock,
    navigator: { clipboard: { writeText: async () => {} } },
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame: () => 0,
    cancelAnimationFrame() {},
    ResizeObserver: class { observe() {} disconnect() {} },
    IntersectionObserver: class { observe() {} disconnect() {} },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  };

  const ctx = vm.createContext({
    window: windowObj,
    document: doc,
    localStorage: localStorageMock,
    navigator: windowObj.navigator,
    location: windowObj.location,
    CSS: { escape: (s) => String(s) },
    URL,
    URLSearchParams,
    AbortController,
    performance,
    Float32Array,
    ResizeObserver: windowObj.ResizeObserver,
    IntersectionObserver: windowObj.IntersectionObserver,
    Event: class { constructor(type) { this.type = type; } },
    CustomEvent: class { constructor(type, opts = {}) { this.type = type; this.detail = opts.detail; } },
    requestAnimationFrame: windowObj.requestAnimationFrame,
    cancelAnimationFrame: windowObj.cancelAnimationFrame,
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    fetch: windowObj.fetch,
    console,
    Promise, Set, Map, WeakMap, Array, Object, String, Number, Boolean, Math, Date, JSON, RegExp, Error,
    encodeURIComponent, decodeURIComponent,
  });

  vm.runInContext(mainScriptMatch[1], ctx, { filename: 'sidecars/panel/ui.html' });

  const stressRes = vm.runInContext(`(() => {
    const N = 5000;
    const E = 12000;
    const nodes = [];
    const edges = [];
    for (let i = 0; i < N; i++) {
      const ang = (i / N) * Math.PI * 16;
      const rad = 40 + (i % 900) * 0.5;
      nodes.push({
        id: 'pkg/m_' + i + '.mjs',
        label: 'm_' + i + '.mjs',
        clusterId: 'c' + (i % 10),
        clusterLabel: 'c' + (i % 10),
        subsystemKey: 'c' + (i % 10),
        radius: 4,
        x: Math.cos(ang) * rad,
        y: Math.sin(ang) * rad,
        vx: 0,
        vy: 0,
        anchorX: 0,
        anchorY: 0,
        fx: null,
        fy: null,
        inDeg: i % 8,
        outDeg: 2,
        hop: -1,
        isGod: i < 5
      });
    }
    for (let i = 0; i < E; i++) {
      const s = nodes[i % N];
      const t = nodes[(i * 7 + 13) % N];
      edges.push({ source: s, target: t, kind: 'import', weight: 1, _phase: 0.2 });
    }

    pgState.width = 1200;
    pgState.height = 800;
    pgState.camX = 0;
    pgState.camY = 0;
    pgState.camScale = 1;
    pgState.nodes = nodes;
    pgState.edges = edges;
    pgState.nodeById = new Map(nodes.map((n) => [n.id, n]));
    pgState.inNeighbors = new Map();
    pgState.outNeighbors = new Map();
    pgState.layoutMode = 'force';
    pgState.renderMode = 'auto';

    // Stress Barnes-Hut physics tick on 5,000 nodes + 12,000 edges
    const t0 = performance.now();
    pgStepPhysics(0.25);
    const physicsMs = performance.now() - t0;

    let hasNaN = false;
    for (let i = 0; i < N; i++) {
      if (!Number.isFinite(nodes[i].x) || !Number.isFinite(nodes[i].y)) {
        hasNaN = true;
        break;
      }
    }

    // Spatial Quadtree hit-test lookup on target node
    const pickTarget = nodes[42];
    const spPt = pgWorldToScreen(pickTarget.x, pickTarget.y);
    const tHit0 = performance.now();
    const hitNode = pgFindNodeAtScreen(spPt.x, spPt.y);
    const hitMs = performance.now() - tHit0;

    // WebGL2 auto-activation & batched draw + composite PNG export
    const tGl0 = performance.now();
    pgDrawGraph();
    const drawMs = performance.now() - tGl0;
    const png = pgExportPng();

    return {
      nCount: nodes.length,
      physicsMs,
      hasNaN,
      hitId: hitNode ? hitNode.id : '',
      hitMs,
      drawMs,
      webglActive: pgState.webglActive,
      png
    };
  })()`, ctx);

  assert.equal(stressRes.nCount, 5000);
  assert.equal(stressRes.hasNaN, false, 'Barnes-Hut simulation must never produce NaN coordinates');
  assert.ok(stressRes.physicsMs < 1500, `5k Barnes-Hut step took too long (${stressRes.physicsMs.toFixed(1)} ms)`);
  assert.ok(stressRes.hitId.startsWith('pkg/m_'), `Expected quadtree hit near target node, got ${stressRes.hitId}`);
  assert.ok(stressRes.hitMs < 40, `Quadtree hit-test took too long (${stressRes.hitMs.toFixed(2)} ms)`);
  assert.equal(stressRes.webglActive, true, 'WebGL2 renderer must auto-activate at >= 1,200 nodes');
  assert.ok(glInstancedNodes > 0 && glInstancedNodes <= 5000, `Expected instanced WebGL2 nodes drawn, got ${glInstancedNodes}`);
  assert.ok(glEdgesVertCount > 0, `Expected batched WebGL2 edge vertices drawn, got ${glEdgesVertCount}`);
  assert.equal(drawnImages, 2, 'Composite PNG export must draw both WebGL2 canvas and 2D overlay canvas');
  assert.equal(stressRes.png, 'data:image/png;base64,COMPOSITE_WEBGL2_PNG');
  assert.ok(stressRes.drawMs < 800, `5k WebGL2 render took too long (${stressRes.drawMs.toFixed(1)} ms)`);
});

test('9. E2E UX polish: tooltip edge-flip, cluster-bar wrap, hull label dedup, hotspot disambiguation & symbols limit hide', async () => {
  const uiHtml = fs.readFileSync(path.join(ROOT_DIR, 'sidecars', 'panel', 'ui.html'), 'utf8');
  assert.ok(uiHtml.includes('flex-wrap: wrap;') && uiHtml.includes('max-height: 54px;'), '.pg-cluster-bar must wrap pills without horizontal overflow');
  assert.ok(uiHtml.includes('max-width: min(360px, calc(100% - 20px));'), '.pg-hover-tooltip must wrap cleanly without 260px truncation');

  const scriptMatches = [...uiHtml.matchAll(/<script>([\s\S]*?)<\/script>/gi)];
  const mainScriptMatch = scriptMatches.find((m) => m[1].includes('pgUpdateHoverTooltip'));
  assert.ok(mainScriptMatch, 'Main script must contain pgUpdateHoverTooltip');

  const makeMockEl = (tag = 'div', id = '') => ({
    tagName: tag.toUpperCase(),
    id,
    style: {},
    dataset: {},
    innerHTML: '',
    textContent: '',
    value: '',
    disabled: false,
    offsetWidth: id === 'pgHoverTooltip' ? 300 : 120,
    offsetHeight: id === 'pgHoverTooltip' ? 32 : 24,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {},
    getAttribute() { return ''; },
    appendChild() {},
    addEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 700 }),
  });

  const elements = new Map();
  for (const id of [
    'pgHoverTooltip', 'pgLimitSelect', 'pgDepthSelect', 'pgStatsPill', 'pgProjectBadge',
    'pgLevelFoldersBtn', 'pgLevelFilesBtn', 'pgLevelSymbolsBtn', 'pgInspLensPanel',
    'pgInspFilename', 'pgInspPath', 'pgInspBadges', 'pgInspMetrics', 'pgInspTabs', 'pgInspList', 'pgInspActions',
    'pgContextCart', 'pgCartSummary', 'pgClusterPills', 'pgLegendExtra', 'pgEmptyState', 'pgEmptyTitle', 'pgEmptySub',
  ]) {
    elements.set(id, makeMockEl('div', id));
  }

  const doc = {
    visibilityState: 'visible',
    body: makeMockEl('body'),
    documentElement: makeMockEl('html'),
    getElementById: (id) => elements.get(id) || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag) => makeMockEl(tag),
    addEventListener() {},
    removeEventListener() {},
  };

  const fetchMock = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) });
  const windowObj = {
    innerWidth: 1440,
    innerHeight: 900,
    devicePixelRatio: 1,
    location: { search: '' },
    fetch: fetchMock,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { clipboard: { writeText: async () => {} } },
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame: () => 0,
    cancelAnimationFrame() {},
    ResizeObserver: class { observe() {} disconnect() {} },
    IntersectionObserver: class { observe() {} disconnect() {} },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  };

  const ctx = vm.createContext({
    window: windowObj,
    document: doc,
    localStorage: windowObj.localStorage,
    navigator: windowObj.navigator,
    location: windowObj.location,
    CSS: { escape: (s) => String(s) },
    URL,
    URLSearchParams,
    AbortController,
    performance,
    ResizeObserver: windowObj.ResizeObserver,
    IntersectionObserver: windowObj.IntersectionObserver,
    Event: class { constructor(type) { this.type = type; } },
    CustomEvent: class { constructor(type, opts = {}) { this.type = type; this.detail = opts.detail; } },
    requestAnimationFrame: () => 0,
    cancelAnimationFrame() {},
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    fetch: fetchMock,
    console,
    Promise, Set, Map, WeakMap, Array, Object, String, Number, Boolean, Math, Date, JSON, RegExp, Error,
    encodeURIComponent, decodeURIComponent,
  });

  vm.runInContext(mainScriptMatch[1], ctx, { filename: 'sidecars/panel/ui.html' });

  const uxRes = vm.runInContext(`(() => {
    pgState.width = 1000;
    pgState.height = 700;
    pgUpdateHoverTooltip({ id: 'packages/vite/src/node/server/hmr.ts', inDeg: 10, outDeg: 3 }, 950, 400);
    const tipLeft = parseInt(document.getElementById('pgHoverTooltip').style.left, 10);

    pgState.rawGraphData = {
      ok: true,
      nodes: [
        { id: 'packages/vite/src/node/index.ts', label: 'index.ts', inDeg: 40, outDeg: 5 },
        { id: 'packages/vite/src/node/plugins/index.ts', label: 'index.ts', inDeg: 5, outDeg: 2 },
        { id: 'packages/vite/src/node/config.ts', label: 'config.ts', inDeg: 66, outDeg: 34 },
      ],
      edges: [],
    };
    pgState.churnByFile = {
      'packages/vite/src/node/index.ts': 3,
      'packages/vite/src/node/plugins/index.ts': 3,
      'packages/vite/src/node/config.ts': 4,
    };
    pgState.churnLoaded = true;
    pgState.churnAvailable = true;
    pgState.lens = 'hotspots';
    pgComputeHotspotScores();
    const hotspotLabels = pgState.hotspotRankList.map((h) => h.displayLabel);

    pgState.viewLevel = 'symbols';
    pgState.graphData = { ok: true, isSymbolsView: true, shownNodes: 10, shownEdges: 8 };
    pgRenderToolbarAndStats();
    const limitDispSym = document.getElementById('pgLimitSelect').style.display;

    pgState.viewLevel = 'files';
    pgState.graphData = { ok: true, isSymbolsView: false, shownNodes: 3, shownEdges: 0 };
    pgRenderToolbarAndStats();
    const limitDispFiles = document.getElementById('pgLimitSelect').style.display;

    return { tipLeft, hotspotLabels, limitDispSym, limitDispFiles };
  })()`, ctx);

  assert.ok(uxRes.tipLeft <= 1000 - 300 - 10, `Tooltip near right edge must flip left so tipLeft (${uxRes.tipLeft}) + 300 <= 990`);
  assert.ok(uxRes.hotspotLabels.includes('node/index.ts') && uxRes.hotspotLabels.includes('plugins/index.ts'), 'Duplicate hotspot basenames must disambiguate parent directory');
  assert.ok(uxRes.hotspotLabels.includes('config.ts'), 'Unique hotspot basenames must stay compact');
  assert.equal(uxRes.limitDispSym, 'none', '#pgLimitSelect must hide in Symbols mode');
  assert.equal(uxRes.limitDispFiles, '', '#pgLimitSelect must be visible in Files mode');
});

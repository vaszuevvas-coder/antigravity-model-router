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
    'id="pgWorkspaceSelect"',
    'id="pgBrowseWorkspaceBtn"',
    'data-change-action="pgSelectWorkspace"',
    'data-action="pgBrowseWorkspaceFolder"',
    'function pgSelectWorkspace(',
    'function pgBrowseWorkspaceFolder(',
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

test('10. Project switcher: /api/project-graph/workspaces, /api/project-graph/pick-folder, and pgSelectWorkspace state isolation', async () => {
  const tmpParent = makeTmpDir('tunnel-pg-multi-');
  const tmpPanelDir = makeTmpDir('tunnel-pg-multi-panel-');
  const projAlpha = path.join(tmpParent, 'proj-alpha');
  const projBeta = path.join(tmpParent, 'proj-beta');
  const emptyDir = path.join(tmpParent, 'empty-scratch');
  const prevIsolate = process.env.TUNNEL_TEST_ISOLATE_INSTALLED;
  const prevStatePath = process.env.TUNNEL_TEST_STATE_PATH;
  const prevCacheDir = process.env.TUNNEL_CACHE_DIR;

  fs.mkdirSync(path.join(projAlpha, 'src'), { recursive: true });
  fs.mkdirSync(path.join(projBeta, 'lib'), { recursive: true });
  fs.mkdirSync(emptyDir, { recursive: true });
  fs.writeFileSync(path.join(projAlpha, 'package.json'), '{"name":"proj-alpha"}\n', 'utf8');
  fs.writeFileSync(path.join(projAlpha, 'src', 'index.mjs'), 'export const alpha = 1;\n', 'utf8');
  fs.writeFileSync(path.join(projBeta, 'README.md'), '# Proj Beta\n', 'utf8');
  fs.writeFileSync(path.join(projBeta, 'lib', 'main.mjs'), 'export const beta = 2;\n', 'utf8');

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

  try {
    const app = await startSidecarPanel({ SidecarAppClass: MiniSidecarApp });
    const workspacesHandler = app._routes.get('/api/project-graph/workspaces')?.get('GET');
    const pickFolderHandler = app._routes.get('/api/project-graph/pick-folder')?.get('POST');
    assert.equal(typeof workspacesHandler, 'function', '/api/project-graph/workspaces GET route must be registered');
    assert.equal(typeof pickFolderHandler, 'function', '/api/project-graph/pick-folder POST route must be registered');

    const wsRes = await workspacesHandler(
      { rootDir: projAlpha },
      { method: 'GET', headers: { host: '127.0.0.1:41234' } }
    );
    assert.equal(wsRes.ok, true);
    assert.ok(Array.isArray(wsRes.workspaces), 'workspaces must be an array');
    const norm = (p) => path.resolve(String(p || '')).toLowerCase();
    assert.equal(
      wsRes.workspaces.some((w) => norm(w.workspaceRoot) === norm(projAlpha)),
      true,
      'Pinned project proj-alpha must be included in workspaces list'
    );
    assert.equal(
      wsRes.workspaces.some((w) => norm(w.workspaceRoot) === norm(projBeta)),
      true,
      'Sibling project proj-beta with marker must be discovered'
    );
    assert.equal(
      wsRes.workspaces.some((w) => norm(w.workspaceRoot) === norm(emptyDir)),
      false,
      'Sibling folder without project markers must be skipped'
    );

    const authHeaders = {
      method: 'POST',
      headers: {
        host: '127.0.0.1:41234',
        origin: 'http://127.0.0.1:41234',
        'x-router-panel': 'antigravity-v38',
        'x-sidecar-token': 'test-tok',
      },
    };
    const badOriginRes = await pickFolderHandler(
      { path: projBeta },
      { method: 'POST', headers: { host: '127.0.0.1:41234', origin: 'https://evil.example' } }
    );
    assert.equal(badOriginRes.ok, false);
    assert.equal(badOriginRes.status, 403);

    const validPickRes = await pickFolderHandler({ path: projBeta }, authHeaders);
    assert.equal(validPickRes.ok, true);
    assert.equal(validPickRes.cancelled, false);
    assert.equal(norm(validPickRes.workspaceRoot), norm(projBeta));

    const badPickRes = await pickFolderHandler({ path: path.join(tmpParent, 'missing-dir-xyz') }, authHeaders);
    assert.equal(badPickRes.ok, false);

    const dryPickRes = await pickFolderHandler({ dryRun: true }, authHeaders);
    assert.equal(dryPickRes.ok, true);
    assert.equal(dryPickRes.cancelled, true);
    assert.equal(dryPickRes.dryRun, true);

    // Frontend VM check: pgSelectWorkspace resets transient state, isolates sidebar, syncs standalone URL, and pgBrowseWorkspaceFolder switches project
    const uiHtml = fs.readFileSync(path.join(ROOT_DIR, 'sidecars', 'panel', 'ui.html'), 'utf8');
    const scriptMatches = [...uiHtml.matchAll(/<script>([\s\S]*?)<\/script>/gi)];
    const mainScriptMatch = scriptMatches.find((m) => m[1].includes('pgSelectWorkspace'));
    assert.ok(mainScriptMatch, 'Compiled ui.html script containing pgSelectWorkspace must exist');

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
      const children = [];
      const el = {
        id,
        tagName: tag.toUpperCase(),
        className: '',
        classList: makeClassList(),
        style: { setProperty() {}, removeProperty() {} },
        dataset: {},
        value: '',
        textContent: '',
        _innerHTML: '',
        disabled: false,
        title: '',
        clientWidth: 1200,
        clientHeight: 800,
        children,
        options: children,
        setAttribute: (k, v) => attrs.set(String(k), String(v)),
        getAttribute: (k) => (attrs.has(String(k)) ? attrs.get(String(k)) : null),
        removeAttribute: (k) => attrs.delete(String(k)),
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent() { return true; },
        querySelector: () => null,
        querySelectorAll: () => [],
        appendChild: (c) => { children.push(c); return c; },
        getBoundingClientRect: () => ({ width: 1200, height: 800, left: 0, top: 0 }),
        focus() {},
        blur() {},
      };
      Object.defineProperty(el, 'innerHTML', {
        get: () => el._innerHTML,
        set: (v) => {
          el._innerHTML = String(v || '');
          if (el._innerHTML === '') children.length = 0;
        },
      });
      return el;
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
      'pgContextCart', 'pgCartSummary', 'pgStatsPill', 'pgProjectBadge', 'pgWorkspaceSelect',
      'pgBrowseWorkspaceBtn', 'pgSearchInput', 'pgSearchClearBtn', 'pgClusterPills', 'pgLegendExtra',
      'pgLensArchBtn', 'pgLensBlastBtn', 'pgLensCyclesBtn', 'pgLensHotspotsBtn', 'pgLensPathBtn',
      'pgLevelFoldersBtn', 'pgLevelFilesBtn', 'pgLevelSymbolsBtn', 'pgEmptyState', 'pgEmptyTitle', 'pgEmptySub',
    ]) {
      elements.set(id, makeMockEl(id === 'projectGraphCanvas' ? 'canvas' : (id === 'pgWorkspaceSelect' ? 'select' : 'div'), id));
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

    const storageMap = new Map();
    const localStorageMock = {
      getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
      setItem: (k, v) => storageMap.set(String(k), String(v)),
      removeItem: (k) => storageMap.delete(String(k)),
    };

    const fetchedUrls = [];
    const historyUrls = [];
    const fetchMock = async (url) => {
      const u = String(url || '');
      fetchedUrls.push(u);
      if (u.startsWith('/api/project-graph/workspaces')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            activeWorkspace: projAlpha,
            autoWorkspace: projAlpha,
            workspaces: [
              { workspaceRoot: projAlpha, projectName: 'proj-alpha', displayLabel: 'proj-alpha', status: 'idle', source: 'known' },
              { workspaceRoot: projBeta, projectName: 'proj-beta', displayLabel: 'proj-beta', status: 'idle', source: 'discovered' },
            ],
          }),
        };
      }
      if (u.startsWith('/api/project-graph/pick-folder')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            cancelled: false,
            workspaceRoot: projAlpha,
            projectName: 'proj-alpha',
          }),
        };
      }
      if (u.startsWith('/api/project-graph?')) {
        const qPart = u.split('?')[1] || '';
        const qs = new URLSearchParams(qPart);
        const r = qs.get('rootDir') || projAlpha;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            workspaceRoot: r,
            workspaceName: path.basename(r),
            totalFiles: 1,
            shownNodes: 1,
            shownEdges: 0,
            clusters: [{ id: 'src', label: 'src', size: 1 }],
            nodes: [{ id: 'src/index.mjs', label: 'index.mjs', clusterId: 'src', clusterLabel: 'src', inDeg: 0, outDeg: 0 }],
            edges: [],
            cycles: [],
            cycleNodeIds: [],
            cycleEdgeKeys: [],
            orphanIds: ['src/index.mjs'],
            testFilesByTarget: {},
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };

    const windowObj = {
      innerWidth: 1440,
      innerHeight: 900,
      devicePixelRatio: 1,
      location: { search: '', pathname: '/', hash: '', reload() {} },
      history: {
        replaceState(_st, _t, nextUrl) {
          historyUrls.push(String(nextUrl));
          const qIdx = String(nextUrl).indexOf('?');
          windowObj.location.search = qIdx >= 0 ? String(nextUrl).slice(qIdx) : '';
        },
      },
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

    const ctx = vm.createContext({
      window: windowObj,
      document: doc,
      localStorage: localStorageMock,
      navigator: windowObj.navigator,
      location: windowObj.location,
      CSS: { escape: (s) => String(s) },
      URL, URLSearchParams, AbortController, performance,
      ResizeObserver: windowObj.ResizeObserver,
      IntersectionObserver: windowObj.IntersectionObserver,
      Event: class { constructor(type) { this.type = type; } },
      CustomEvent: class { constructor(type, opts = {}) { this.type = type; this.detail = opts.detail; } },
      requestAnimationFrame: windowObj.requestAnimationFrame,
      cancelAnimationFrame: windowObj.cancelAnimationFrame,
      setTimeout: () => 0, clearTimeout() {},
      setInterval: () => 0, clearInterval() {},
      fetch: fetchMock,
      console,
      Promise, Set, Map, WeakMap, Array, Object, String, Number, Boolean, Math, Date, JSON, RegExp, Error,
      encodeURIComponent, decodeURIComponent,
    });

    vm.runInContext(mainScriptMatch[1], ctx, { filename: 'sidecars/panel/ui.html' });

    const vmRes = await vm.runInContext(`(async () => {
      _selectedWorkspaceMode = 'C:/sidebar-pinned-project';
      pgState.open = true;
      pgState.mode = 'local';
      pgState.viewLevel = 'files';
      pgState.drillFolder = 'src';
      pgState.focusFile = 'src/old.mjs';
      pgState.selectedNodeId = 'src/old.mjs';
      pgState.gitDiffLoaded = true;
      pgState.churnLoaded = true;
      pgState.pathFrom = 'src/old.mjs';
      pgState.searchQuery = 'old';
      pgState.contextCart.add('src/old.mjs');

      pgResetProjectTransientState();
      const resetSelectedNodeId = pgState.selectedNodeId;

      pgState.mode = 'local';
      pgState.viewLevel = 'files';
      pgState.drillFolder = 'src';
      pgState.focusFile = 'src/old.mjs';
      pgState.selectedNodeId = 'src/old.mjs';
      pgState.gitDiffLoaded = true;
      pgState.churnLoaded = true;
      pgState.pathFrom = 'src/old.mjs';
      pgState.searchQuery = 'old';
      pgState.contextCart.add('src/old.mjs');

      await pgSelectWorkspace(${JSON.stringify(projBeta)});

      const afterSwitch = {
        resetSelectedNodeId,
        pgWs: pgState.workspaceRoot,
        sidebarWs: _selectedWorkspaceMode,
        mode: pgState.mode,
        viewLevel: pgState.viewLevel,
        drillFolder: pgState.drillFolder,
        focusFile: pgState.focusFile,
        selectedNodeId: pgState.selectedNodeId,
        gitDiffLoaded: pgState.gitDiffLoaded,
        churnLoaded: pgState.churnLoaded,
        pathFrom: pgState.pathFrom,
        searchQuery: pgState.searchQuery,
        cartSize: pgState.contextCart.size,
        selectVal: document.getElementById('pgWorkspaceSelect').value,
        optionValues: document.getElementById('pgWorkspaceSelect').options.map((o) => o.value),
      };

      await pgBrowseWorkspaceFolder();
      const afterBrowseWs = pgState.workspaceRoot;

      window.location.search = '?view=graph&rootDir=' + encodeURIComponent(${JSON.stringify(projAlpha)});
      await pgSelectWorkspace(${JSON.stringify(projBeta)});
      await pgSelectWorkspace('');

      return {
        afterSwitch,
        afterBrowseWs,
        finalStandaloneWs: pgState.workspaceRoot,
        recentStored: localStorage.getItem('ag_tunnel_pg_recent_workspaces_v1'),
      };
    })()`, ctx);

    assert.equal(vmRes.afterSwitch.pgWs, projBeta);
    assert.equal(vmRes.afterSwitch.sidebarWs, 'C:/sidebar-pinned-project', 'Sidebar workspace must stay isolated from graph project switch');
    assert.equal(vmRes.afterSwitch.mode, 'global');
    assert.equal(vmRes.afterSwitch.viewLevel, 'folders');
    assert.equal(vmRes.afterSwitch.resetSelectedNodeId, '', 'pgResetProjectTransientState must clear selectedNodeId');
    assert.equal(vmRes.afterSwitch.drillFolder, '');
    assert.equal(vmRes.afterSwitch.focusFile, '');
    assert.notEqual(vmRes.afterSwitch.selectedNodeId, 'src/old.mjs', 'Old selected node must not survive workspace switch');
    assert.equal(vmRes.afterSwitch.selectedNodeId, 'folder:src', 'New graph must auto-select its own initial folder node');
    assert.equal(vmRes.afterSwitch.gitDiffLoaded, false);
    assert.equal(vmRes.afterSwitch.churnLoaded, false);
    assert.equal(vmRes.afterSwitch.pathFrom, '');
    assert.equal(vmRes.afterSwitch.searchQuery, '');
    assert.equal(vmRes.afterSwitch.cartSize, 0);
    assert.equal(vmRes.afterSwitch.selectVal, projBeta);
    assert.ok(vmRes.afterSwitch.optionValues.includes(''), 'Select must include Auto option');
    assert.ok(vmRes.afterSwitch.optionValues.includes(projBeta), 'Select must include selected projBeta option');
    assert.ok(
      fetchedUrls.some((u) => u.startsWith('/api/project-graph?') && u.includes('rootDir=' + encodeURIComponent(projBeta))),
      'pgSelectWorkspace must fetch /api/project-graph with selected rootDir'
    );
    assert.equal(vmRes.afterBrowseWs, projAlpha, 'pgBrowseWorkspaceFolder must switch graph to picked folder');
    assert.equal(vmRes.finalStandaloneWs, '');
    assert.ok(
      historyUrls.some((h) => h.includes('rootDir=' + encodeURIComponent(projBeta))),
      'Standalone URL must update rootDir via history.replaceState'
    );
    assert.ok(
      historyUrls.some((h) => h.includes('view=graph') && !h.includes('rootDir=')),
      'Switching back to Auto in standalone must remove rootDir from URL'
    );
    assert.ok(vmRes.recentStored && vmRes.recentStored.includes('proj-beta'), 'Recent workspace list must persist in localStorage');
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
    fs.rmSync(tmpParent, { recursive: true, force: true });
    fs.rmSync(tmpPanelDir, { recursive: true, force: true });
  }
});

test('15. Standalone graph window launch avoids windowsHide cold-start bug and suppresses browser Translate popup', () => {
  const serverSrc = fs.readFileSync(path.join(ROOT_DIR, 'sidecars', 'panel', 'server.mjs'), 'utf8');
  const launchMatch = serverSrc.match(/const launchStandaloneGraphWindow = [\s\S]*?\n  \};/);
  assert.ok(launchMatch, 'launchStandaloneGraphWindow must exist in sidecars/panel/server.mjs');
  const exeBranchMatch = launchMatch[0].match(/if \(exe\) \{[\s\S]*?return \{ ok: true, mode: 'app_window' \};/);
  assert.ok(exeBranchMatch, 'exe launch branch must exist in launchStandaloneGraphWindow');
  const exeBranchNoComments = exeBranchMatch[0].replace(/\/\/.*$/gm, '');
  assert.ok(!/windowsHide\s*:\s*true/.test(exeBranchNoComments), 'GUI browser launch must not set windowsHide: true');
  assert.ok(exeBranchMatch[0].includes('--disable-features=Translate'), 'GUI browser launch must pass --disable-features=Translate');

  const uiHtml = fs.readFileSync(path.join(ROOT_DIR, 'sidecars', 'panel', 'ui.html'), 'utf8');
  assert.ok(/<html\b[^>]*\btranslate="no"/.test(uiHtml), 'ui.html <html> must carry translate="no"');
  assert.ok(/<meta\s+name="google"\s+content="notranslate"/i.test(uiHtml), 'ui.html must include google notranslate meta tag');
});

test('16. Project Graph minimap releases pointer cleanly and Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y undo/redo node drags', async () => {
  const uiHtml = fs.readFileSync(path.join(ROOT_DIR, 'sidecars', 'panel', 'ui.html'), 'utf8');
  const scriptMatches = [...uiHtml.matchAll(/<script>([\s\S]*?)<\/script>/gi)];
  const mainScriptMatch = scriptMatches.find((m) => m[1].includes('pgBindCanvasEvents'));
  assert.ok(mainScriptMatch, 'Main compiled panel script containing pgBindCanvasEvents must exist in ui.html');

  const attachBus = (obj) => {
    const map = new Map();
    obj.addEventListener = (type, fn) => {
      if (!map.has(type)) map.set(type, []);
      map.get(type).push(fn);
    };
    obj.removeEventListener = (type, fn) => {
      const arr = map.get(type);
      if (!arr) return;
      const idx = arr.indexOf(fn);
      if (idx >= 0) arr.splice(idx, 1);
    };
    obj.dispatchEvent = (ev) => {
      const e = Object.assign({
        preventDefault() {},
        stopPropagation() {},
      }, ev);
      const arr = map.get(e.type) || [];
      for (const fn of arr.slice()) fn.call(obj, e);
      return true;
    };
    return obj;
  };

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

  const makeEl = (tag = 'div', id = '') => {
    const attrs = new Map();
    const el = {
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
      clientWidth: 1200,
      clientHeight: 800,
      setAttribute: (k, v) => attrs.set(String(k), String(v)),
      getAttribute: (k) => (attrs.has(String(k)) ? attrs.get(String(k)) : null),
      removeAttribute: (k) => attrs.delete(String(k)),
      querySelector: () => null,
      querySelectorAll: () => [],
      appendChild: (c) => c,
      getBoundingClientRect: () => ({ width: 1200, height: 800, left: 0, top: 0 }),
      focus() {},
      blur() {},
    };
    return attachBus(el);
  };

  const fakeCtx2d = {
    save() {}, restore() {}, setTransform() {}, clearRect() {}, fillRect() {}, strokeRect() {},
    beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, quadraticCurveTo() {}, bezierCurveTo() {},
    arc() {}, roundRect() {}, rect() {}, clip() {}, fill() {}, stroke() {}, fillText() {}, strokeText() {}, setLineDash() {},
    measureText: (t) => ({ width: String(t || '').length * 7 }),
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: 'left', textBaseline: 'alphabetic', globalAlpha: 1,
  };

  const elements = new Map();
  for (const id of [
    'projectGraphModal', 'projectGraphCanvas', 'pgCanvasStage', 'pgInspector', 'pgStatsPill',
    'pgClusterPills', 'pgEmptyHint', 'pgHoverTooltip', 'pgZoomIndicator', 'pgSearchInput',
  ]) {
    elements.set(id, makeEl(id === 'projectGraphCanvas' ? 'canvas' : (id === 'pgSearchInput' ? 'input' : 'div'), id));
  }
  const canvasEl = elements.get('projectGraphCanvas');
  canvasEl.parentElement = elements.get('pgCanvasStage');
  canvasEl.getContext = () => fakeCtx2d;
  let releaseCalls = 0;
  canvasEl.setPointerCapture = () => {};
  canvasEl.releasePointerCapture = () => { releaseCalls += 1; };

  const doc = attachBus({
    visibilityState: 'visible',
    activeElement: null,
    title: 'The Tunnel',
    body: makeEl('body'),
    documentElement: makeEl('html'),
    getElementById: (id) => elements.get(id) || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag) => makeEl(tag),
  });

  const windowObj = attachBus({
    innerWidth: 1280,
    innerHeight: 820,
    devicePixelRatio: 1,
    location: { search: '?view=graph&token=tok123', reload() {} },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { clipboard: { writeText: async () => {} } },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
  });
  windowObj.document = doc;
  windowObj.window = windowObj;

  const ctx = vm.createContext({
    window: windowObj,
    document: doc,
    localStorage: windowObj.localStorage,
    navigator: windowObj.navigator,
    fetch: windowObj.fetch,
    location: windowObj.location,
    requestAnimationFrame: windowObj.requestAnimationFrame,
    cancelAnimationFrame: windowObj.cancelAnimationFrame,
    URLSearchParams,
    ResizeObserver: undefined,
    console,
    setTimeout,
    clearTimeout,
    Math,
    Number,
    String,
    Array,
    Object,
    Set,
    Map,
    JSON,
    Date,
    RegExp,
    Promise,
  });

  vm.runInContext(mainScriptMatch[1], ctx);

  const rawGraph = {
    ok: true,
    workspaceName: 'undo-test',
    totalFiles: 2,
    shownNodes: 2,
    shownEdges: 1,
    clusters: [{ id: 'core', label: 'core', size: 2 }],
    nodes: [
      { id: 'core/a.mjs', label: 'a.mjs', dir: 'core', lines: 30, estTokens: 240, inDeg: 0, outDeg: 1 },
      { id: 'core/b.mjs', label: 'b.mjs', dir: 'core', lines: 50, estTokens: 400, inDeg: 1, outDeg: 0, isGod: true },
    ],
    edges: [{ source: 'core/a.mjs', target: 'core/b.mjs', kind: 'import' }],
  };

  const res = vm.runInContext(`(() => {
    const raw = ${JSON.stringify(rawGraph)};
    const canvas = document.getElementById('projectGraphCanvas');
    pgState.open = true;
    pgState.width = 1200;
    pgState.height = 800;
    pgState.rawGraphData = raw;
    pgState.viewLevel = 'files';
    pgState.layoutMode = 'layered';
    pgState.showMinimap = true;
    pgBindCanvasEvents();
    pgHydrateSimulation(raw);
    pgDrawGraph();

    const mr = pgState.minimapRect;
    if (!mr) throw new Error('Expected minimapRect');
    canvas.dispatchEvent({
      type: 'pointerdown',
      button: 0,
      pointerType: 'mouse',
      pointerId: 11,
      clientX: mr.mx + 12,
      clientY: mr.my + 12,
    });
    const modeDuringMinimap = pgState.dragMode;
    window.dispatchEvent({
      type: 'pointerup',
      pointerId: 11,
      clientX: mr.mx + 24,
      clientY: mr.my + 18,
    });
    const modeAfterWindowUp = pgState.dragMode;

    // Also test stale mouse move with buttons === 0 resets stuck minimap drag
    canvas.dispatchEvent({
      type: 'pointerdown',
      button: 0,
      pointerType: 'mouse',
      pointerId: 12,
      clientX: mr.mx + 14,
      clientY: mr.my + 14,
    });
    const modeBeforeStaleMove = pgState.dragMode;
    canvas.dispatchEvent({
      type: 'pointermove',
      pointerType: 'mouse',
      buttons: 0,
      pointerId: 12,
      clientX: mr.mx + 16,
      clientY: mr.my + 16,
    });
    const modeAfterStaleMove = pgState.dragMode;

    // Node drag -> Ctrl+Z (Russian layout 'я' with code KeyZ) -> Ctrl+Shift+Z -> Ctrl+Y
    const targetNode = pgState.nodeById.get('core/a.mjs');
    const origX = targetNode.x;
    const origY = targetNode.y;
    const sp = pgWorldToScreen(origX, origY);

    canvas.dispatchEvent({
      type: 'pointerdown',
      button: 0,
      pointerType: 'mouse',
      pointerId: 13,
      clientX: sp.x,
      clientY: sp.y,
    });
    canvas.dispatchEvent({
      type: 'pointermove',
      pointerType: 'mouse',
      buttons: 1,
      pointerId: 13,
      clientX: sp.x + 90,
      clientY: sp.y + 55,
    });
    canvas.dispatchEvent({
      type: 'pointerup',
      pointerType: 'mouse',
      pointerId: 13,
      clientX: sp.x + 90,
      clientY: sp.y + 55,
    });
    const movedX = targetNode.x;
    const movedY = targetNode.y;

    // Focus inside search input must NOT trigger node undo
    document.activeElement = document.getElementById('pgSearchInput');
    document.dispatchEvent({ type: 'keydown', ctrlKey: true, code: 'KeyZ', key: 'z' });
    const xAfterInputUndo = targetNode.x;

    // Undo with Russian key 'я' + code 'KeyZ'
    document.activeElement = null;
    document.dispatchEvent({ type: 'keydown', ctrlKey: true, code: 'KeyZ', key: 'я' });
    const undoX = targetNode.x;
    const undoY = targetNode.y;

    // Redo with Ctrl+Shift+Z
    document.dispatchEvent({ type: 'keydown', ctrlKey: true, shiftKey: true, code: 'KeyZ', key: 'Я' });
    const redoX = targetNode.x;
    const redoY = targetNode.y;

    // Undo again then redo with Ctrl+Y
    document.dispatchEvent({ type: 'keydown', ctrlKey: true, code: 'KeyZ', key: 'z' });
    const undo2X = targetNode.x;
    document.dispatchEvent({ type: 'keydown', ctrlKey: true, code: 'KeyY', key: 'н' });
    const redoYX = targetNode.x;

    return {
      modeDuringMinimap,
      modeAfterWindowUp,
      modeBeforeStaleMove,
      modeAfterStaleMove,
      origX,
      origY,
      movedX,
      movedY,
      xAfterInputUndo,
      undoX,
      undoY,
      redoX,
      redoY,
      undo2X,
      redoYX,
    };
  })()`, ctx);

  assert.equal(res.modeDuringMinimap, 'minimap');
  assert.equal(res.modeAfterWindowUp, '', 'Minimap dragMode must reset on pointerup');
  assert.equal(res.modeBeforeStaleMove, 'minimap');
  assert.equal(res.modeAfterStaleMove, '', 'Minimap dragMode must reset on pointermove with buttons === 0');
  assert.ok(releaseCalls >= 2, 'releasePointerCapture must be called when minimap drag ends');
  assert.ok(Math.hypot(res.movedX - res.origX, res.movedY - res.origY) > 10, 'Node drag must move node coordinates');
  assert.equal(res.xAfterInputUndo, res.movedX, 'Ctrl+Z inside <input> must not undo graph node moves');
  assert.equal(res.undoX, res.origX, 'Ctrl+Z must restore node original X');
  assert.equal(res.undoY, res.origY, 'Ctrl+Z must restore node original Y');
  assert.equal(res.redoX, res.movedX, 'Ctrl+Shift+Z must restore moved X');
  assert.equal(res.redoY, res.movedY, 'Ctrl+Shift+Z must restore moved Y');
  assert.equal(res.undo2X, res.origX);
  assert.equal(res.redoYX, res.movedX, 'Ctrl+Y must redo node move');
});

test('17. Wave 3 Project Map AI menu, Escape/outside close & hybrid inline Q&A / Composer handoff', async () => {
  const vm = await import('node:vm');
  const html = fs.readFileSync(path.join(ROOT_DIR, 'sidecars', 'panel', 'ui.html'), 'utf8');
  for (const marker of [
    'id="pgAiChatBox"',
    'id="pgActionAskAiBtn"',
    'id="pgAskAiMenu"',
    'id="pgAiQuestionInput"',
    'data-action="pgToggleAskAiMenu"',
    'data-action="pgRunAiPreset"',
    'data-action="pgSendAiToComposer"',
    'function pgToggleAskAiMenu(',
    'function pgExecuteFileAiQuestion(',
  ]) {
    assert.ok(html.includes(marker), `Expected Wave 3 Project Map marker ${marker} in ui.html`);
  }

  const mainScriptMatch = html.match(/<script>\s*([\s\S]*?)\s*<\/script>\s*<\/body>/i);
  assert.ok(mainScriptMatch, 'Main script block must exist in ui.html');

  const attachBus = (obj) => {
    const map = new Map();
    obj.addEventListener = (type, fn) => {
      if (!map.has(type)) map.set(type, new Set());
      map.get(type).add(fn);
    };
    obj.removeEventListener = (type, fn) => {
      if (map.has(type)) map.get(type).delete(fn);
    };
    obj.dispatchEvent = (ev) => {
      const listeners = map.get(ev.type);
      if (!listeners) return;
      for (const fn of Array.from(listeners)) fn(ev);
    };
    return obj;
  };

  const makeClassList = () => {
    const set = new Set();
    return {
      add: (c) => set.add(c),
      remove: (c) => set.delete(c),
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

  const makeEl = (tag = 'div', id = '') => {
    const attrs = new Map();
    const el = {
      id,
      tagName: tag.toUpperCase(),
      className: '',
      hidden: id === 'pgAskAiMenu',
      classList: makeClassList(),
      style: { display: '', setProperty() {}, removeProperty() {} },
      dataset: {},
      value: '',
      textContent: '',
      innerHTML: '',
      disabled: false,
      clientWidth: 1200,
      clientHeight: 800,
      scrollTop: 0,
      scrollHeight: 100,
      setAttribute: (k, v) => attrs.set(String(k), String(v)),
      getAttribute: (k) => (attrs.has(String(k)) ? attrs.get(String(k)) : null),
      removeAttribute: (k) => attrs.delete(String(k)),
      querySelector: () => null,
      querySelectorAll: () => [],
      appendChild: (c) => c,
      closest: (sel) => (sel === '#' + id ? el : null),
      getBoundingClientRect: () => ({ width: 1200, height: 800, left: 0, top: 0 }),
      focus() { el._focused = true; },
      blur() {},
    };
    return attachBus(el);
  };

  const elements = new Map();
  for (const id of [
    'projectGraphModal', 'projectGraphCanvas', 'pgCanvasStage', 'pgInspector', 'pgStatsPill',
    'pgClusterPills', 'pgEmptyHint', 'pgHoverTooltip', 'pgZoomIndicator', 'pgSearchInput',
    'pgActionAskAiBtn', 'pgAskAiMenu', 'pgAiChatBox', 'pgAiChatMessages', 'pgAiEngineBadge',
    'pgAiChatTitle', 'pgAiAskSubmitBtn', 'pgAiQuestionInput', 'smartComposerInput',
    'pgInspActions', 'pgMetricIn', 'pgMetricOut', 'pgMetricLines', 'pgMetricRel', 'pgInspFilename',
    'pgInspPath', 'pgInspBadges', 'pgInspMetrics', 'pgInspTabs', 'pgInspList',
  ]) {
    elements.set(id, makeEl(id === 'projectGraphCanvas' ? 'canvas' : (id.includes('Input') ? 'input' : 'div'), id));
  }
  const fakeCtx2d = {
    save() {}, restore() {}, setTransform() {}, clearRect() {}, fillRect() {}, strokeRect() {},
    beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, quadraticCurveTo() {}, bezierCurveTo() {},
    arc() {}, roundRect() {}, rect() {}, clip() {}, fill() {}, stroke() {}, fillText() {}, strokeText() {}, setLineDash() {},
    measureText: (t) => ({ width: String(t || '').length * 7 }),
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: 'left', textBaseline: 'alphabetic', globalAlpha: 1,
  };
  const canvasEl = elements.get('projectGraphCanvas');
  canvasEl.parentElement = elements.get('pgCanvasStage');
  canvasEl.getContext = () => fakeCtx2d;
  canvasEl.setPointerCapture = () => {};
  canvasEl.releasePointerCapture = () => {};

  const doc = attachBus({
    visibilityState: 'visible',
    activeElement: null,
    title: 'The Tunnel',
    body: makeEl('body'),
    documentElement: makeEl('html'),
    getElementById: (id) => elements.get(id) || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag) => makeEl(tag),
  });

  const fetchCalls = [];
  const windowObj = attachBus({
    innerWidth: 1280,
    innerHeight: 820,
    devicePixelRatio: 1,
    location: { search: '', reload() {} },
    fetch: async (url, init) => {
      fetchCalls.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : null });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          answer: 'Файл core/a.mjs экспортирует runHelper и зависит от core/b.mjs.',
          sources: [{ file: 'core/a.mjs', startLine: 1, endLine: 12 }],
        }),
      };
    },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { clipboard: { writeText: async () => {} } },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
  });
  windowObj.document = doc;
  windowObj.window = windowObj;

  const activeTimers = new Set();
  const safeSetTimeout = (fn, ms, ...args) => {
    const id = setTimeout(() => {
      activeTimers.delete(id);
      if (typeof fn === 'function') fn(...args);
    }, ms);
    if (typeof id?.unref === 'function') id.unref();
    activeTimers.add(id);
    return id;
  };
  const safeClearTimeout = (id) => {
    if (id !== undefined && id !== null) {
      activeTimers.delete(id);
      clearTimeout(id);
    }
  };

  const ctx = vm.createContext({
    window: windowObj,
    document: doc,
    localStorage: windowObj.localStorage,
    navigator: windowObj.navigator,
    fetch: windowObj.fetch,
    location: windowObj.location,
    requestAnimationFrame: windowObj.requestAnimationFrame,
    cancelAnimationFrame: windowObj.cancelAnimationFrame,
    URLSearchParams,
    ResizeObserver: undefined,
    console,
    setTimeout: safeSetTimeout,
    clearTimeout: safeClearTimeout,
    Math,
    Number,
    String,
    Array,
    Object,
    Set,
    Map,
    JSON,
    Date,
    RegExp,
    Promise,
  });

  try {
    vm.runInContext(mainScriptMatch[1], ctx);

    const rawGraph = {
      ok: true,
      workspaceName: 'ai-menu-test',
      totalFiles: 2,
      shownNodes: 2,
      shownEdges: 1,
      clusters: [{ id: 'core', label: 'core', size: 2 }],
      nodes: [
        { id: 'core/a.mjs', label: 'a.mjs', dir: 'core', lines: 30, estTokens: 240, inDeg: 0, outDeg: 1, isFragile: false },
        { id: 'core/b.mjs', label: 'b.mjs', dir: 'core', lines: 50, estTokens: 400, inDeg: 1, outDeg: 0, isGod: true },
      ],
      edges: [{ source: 'core/a.mjs', target: 'core/b.mjs', kind: 'import' }],
    };

    const out = await vm.runInContext(`(async () => {
      currentState = { ...(currentState || {}), gpuEnabled: false, uiLanguage: 'ru' };
      pgState.open = true;
      pgState.viewLevel = 'files';
      pgHydrateSimulation(${JSON.stringify(rawGraph)});
      pgSelectNodeById('core/a.mjs');

      // 1) Toggle menu open -> Escape closes -> reopen -> outside click closes
      pgToggleAskAiMenu();
      const openAfterToggle = pgState.aiMenuOpen && document.getElementById('pgAskAiMenu').hidden === false;
      const escEv = {
        type: 'keydown',
        key: 'Escape',
        defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; },
        stopPropagation() {},
        stopImmediatePropagation() {},
      };
      document.dispatchEvent(escEv);
      const closedAfterEsc = !pgState.aiMenuOpen && document.getElementById('pgAskAiMenu').hidden === true;

      pgToggleAskAiMenu(true);
      document.dispatchEvent({ type: 'click', target: { closest: () => null } });
      const closedAfterOutsideClick = !pgState.aiMenuOpen;

      // 2) Preset 'risks' with GPU OFF -> renders static dependency summary & sends @file to Composer
      await pgRunAiPreset('risks');
      const offModeBadge = document.getElementById('pgAiEngineBadge').textContent;
      const offBoxOpen = document.getElementById('pgAiChatBox').style.display === 'flex';
      const offHtml = document.getElementById('pgAiChatMessages').innerHTML;
      pgSendAiToComposer();
      const composerValAfterOff = document.getElementById('smartComposerInput').value;

      // 3) GPU ON -> custom question via Enter calls /api/local-chat with focusFile
      currentState.gpuEnabled = true;
      const qInp = document.getElementById('pgAiQuestionInput');
      qInp.value = 'Как устроена обработка ошибок?';
      let prevented = false;
      document.dispatchEvent({
        type: 'keydown',
        key: 'Enter',
        shiftKey: false,
        target: qInp,
        preventDefault() { prevented = true; },
      });
      await new Promise((r) => setTimeout(r, 30));
      const onModeHtml = document.getElementById('pgAiChatMessages').innerHTML;

      return {
        openAfterToggle,
        closedAfterEsc,
        closedAfterOutsideClick,
        offModeBadge,
        offBoxOpen,
        offHtml,
        composerValAfterOff,
        prevented,
        onModeHtml,
      };
    })()`, ctx);

    assert.equal(out.openAfterToggle, true, 'pgToggleAskAiMenu must open #pgAskAiMenu');
    assert.equal(out.closedAfterEsc, true, 'Escape must close #pgAskAiMenu');
    assert.equal(out.closedAfterOutsideClick, true, 'Outside click must close #pgAskAiMenu');
    assert.equal(out.offBoxOpen, true, '#pgAiChatBox must open on preset');
    assert.ok(out.offHtml.includes('core/b.mjs'), 'Static GPU-OFF summary must include imports from graph');
    assert.ok(out.composerValAfterOff.includes('@file:core/a.mjs'), 'pgSendAiToComposer must insert @file:core/a.mjs into Smart Composer');
    assert.equal(out.prevented, true);
    assert.ok(out.onModeHtml.includes('runHelper'), 'GPU-ON inline Q&A must render /api/local-chat answer');
    const localChatCall = fetchCalls.find((c) => c.url.includes('/api/local-chat'));
    assert.ok(localChatCall, 'Must POST /api/local-chat');
    assert.equal(localChatCall.body.focusFile, 'core/a.mjs', '/api/local-chat payload must include focusFile');
  } finally {
    try {
      vm.runInContext(`if (typeof telemetryPollTimer !== 'undefined' && telemetryPollTimer) { clearTimeout(telemetryPollTimer); telemetryPollTimer = null; }`, ctx);
    } catch {}
    for (const id of Array.from(activeTimers)) {
      safeClearTimeout(id);
    }
  }
});

test('18. Project Map right-click contextmenu opens custom node menu instead of native canvas menu', async () => {
  const vm = await import('node:vm');
  const html = fs.readFileSync(path.join(ROOT_DIR, 'sidecars', 'panel', 'ui.html'), 'utf8');
  for (const marker of [
    'id="pgNodeContextMenu"',
    'function pgOpenNodeContextMenu(',
    'function pgCloseNodeContextMenu(',
    'function pgRunNodeContextAction(',
    "case 'pgCtxAction':",
    "canvas.addEventListener('contextmenu'",
  ]) {
    assert.ok(html.includes(marker), `Expected RMB context menu marker ${marker} in ui.html`);
  }

  const mainScriptMatch = html.match(/<script>\s*([\s\S]*?)\s*<\/script>\s*<\/body>/i);
  assert.ok(mainScriptMatch, 'Main script block must exist in ui.html');

  const attachBus = (obj) => {
    const map = new Map();
    obj.addEventListener = (type, fn) => {
      if (!map.has(type)) map.set(type, new Set());
      map.get(type).add(fn);
    };
    obj.removeEventListener = (type, fn) => {
      if (map.has(type)) map.get(type).delete(fn);
    };
    obj.dispatchEvent = (ev) => {
      const listeners = map.get(ev.type);
      if (!listeners) return;
      for (const fn of Array.from(listeners)) fn(ev);
    };
    return obj;
  };

  const makeClassList = () => {
    const set = new Set();
    return {
      add: (c) => set.add(c),
      remove: (c) => set.delete(c),
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

  const makeEl = (tag = 'div', id = '') => {
    const attrs = new Map();
    const el = {
      id,
      tagName: tag.toUpperCase(),
      className: '',
      hidden: id === 'pgAskAiMenu' || id === 'pgNodeContextMenu',
      classList: makeClassList(),
      style: { display: '', left: '', top: '', setProperty() {}, removeProperty() {} },
      dataset: {},
      value: '',
      textContent: '',
      innerHTML: '',
      disabled: false,
      clientWidth: 1200,
      clientHeight: 800,
      offsetWidth: 250,
      offsetHeight: 320,
      scrollTop: 0,
      scrollHeight: 100,
      setAttribute: (k, v) => attrs.set(String(k), String(v)),
      getAttribute: (k) => (attrs.has(String(k)) ? attrs.get(String(k)) : null),
      removeAttribute: (k) => attrs.delete(String(k)),
      getBoundingClientRect: () => ({ left: 10, top: 20, width: 1200, height: 800 }),
      getContext: () => ({
        save() {}, restore() {}, clearRect() {}, fillRect() {}, strokeRect() {}, beginPath() {}, closePath() {},
        arc() {}, rect() {}, clip() {}, fill() {}, stroke() {}, moveTo() {}, lineTo() {}, quadraticCurveTo() {},
        bezierCurveTo() {}, roundRect() {}, drawImage() {},
        setLineDash() {}, setTransform() {}, scale() {}, translate() {}, fillText() {}, strokeText() {},
        createLinearGradient: () => ({ addColorStop() {} }),
        createRadialGradient: () => ({ addColorStop() {} }),
        measureText: (s) => ({ width: String(s || '').length * 7 }),
      }),
      focus() {},
      closest: (sel) => (sel === '#' + id ? el : null),
      querySelectorAll: () => [],
      querySelector: () => null,
    };
    return attachBus(el);
  };

  const els = new Map();
  for (const [id, tag] of [
    ['projectGraphModal', 'div'],
    ['pgCanvasStage', 'div'],
    ['projectGraphCanvas', 'canvas'],
    ['pgNodeContextMenu', 'div'],
    ['pgAskAiMenu', 'div'],
    ['pgActionAskAiBtn', 'button'],
    ['pgAiChatBox', 'div'],
    ['pgAiChatTitle', 'span'],
    ['pgAiEngineBadge', 'span'],
    ['pgAiChatMessages', 'div'],
    ['pgAiQuestionInput', 'input'],
    ['pgAiAskSubmitBtn', 'button'],
    ['pgInspFilename', 'div'],
    ['pgInspPath', 'div'],
    ['pgInspBadges', 'div'],
    ['pgInspMetrics', 'div'],
    ['pgInspTabs', 'div'],
    ['pgInspActions', 'div'],
    ['pgInspList', 'div'],
    ['pgHoverTooltip', 'div'],
    ['smartComposerInput', 'textarea'],
  ]) {
    els.set(id, makeEl(tag, id));
  }

  const doc = attachBus({
    body: makeEl('body', 'body'),
    documentElement: makeEl('html', 'html'),
    activeElement: null,
    getElementById: (id) => els.get(id) || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag) => makeEl(tag, ''),
  });

  const activeTimers = new Set();
  const safeSetTimeout = (fn, ms) => {
    const id = setTimeout(() => { activeTimers.delete(id); fn(); }, Math.min(Number(ms) || 0, 50));
    if (id && typeof id.unref === 'function') id.unref();
    activeTimers.add(id);
    return id;
  };
  const safeClearTimeout = (id) => { activeTimers.delete(id); clearTimeout(id); };

  const win = attachBus({
    location: { search: '', href: 'http://127.0.0.1:4242/' },
    innerWidth: 1400,
    innerHeight: 900,
    devicePixelRatio: 1,
    document: doc,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { clipboard: { writeText: async () => {} } },
    setTimeout: safeSetTimeout,
    clearTimeout: safeClearTimeout,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }),
    URLSearchParams,
    AbortController,
  });

  const ctx = vm.createContext({
    window: win,
    document: doc,
    navigator: win.navigator,
    localStorage: win.localStorage,
    location: win.location,
    fetch: win.fetch,
    setTimeout: safeSetTimeout,
    clearTimeout: safeClearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: win.requestAnimationFrame,
    cancelAnimationFrame: win.cancelAnimationFrame,
    URLSearchParams,
    AbortController,
    console,
    Math,
    Date,
    JSON,
    Map,
    Set,
    Array,
    Object,
    String,
    Number,
    Boolean,
    RegExp,
    Promise,
  });

  try {
    vm.runInContext(mainScriptMatch[1], ctx);
    const out = await vm.runInContext(`(async () => {
      pgState.open = true;
      pgState.width = 1200;
      pgState.height = 800;
      pgState.camX = 0;
      pgState.camY = 0;
      pgState.camScale = 1;
      pgState.viewLevel = 'files';
      const fileNode = {
        id: 'core/a.mjs',
        label: 'a.mjs',
        x: 0,
        y: 0,
        r: 16,
        isFolder: false,
        isSymbol: false,
        lines: 90,
        inDeg: 1,
        outDeg: 1,
        reliabilityPercent: 100,
      };
      pgState.nodes = [fileNode];
      pgState.nodeById = new Map([['core/a.mjs', fileNode]]);
      pgState.inNeighbors = new Map([['core/a.mjs', []]]);
      pgState.outNeighbors = new Map([['core/a.mjs', [{ id: 'core/b.mjs', kind: 'import' }]]]);
      pgBindCanvasEvents();

      const canvas = document.getElementById('projectGraphCanvas');
      const menu = document.getElementById('pgNodeContextMenu');

      // 1) Right-click on fileNode at canvas center (clientX = rect.left + 600, clientY = rect.top + 400)
      let preventedOnNode = false;
      canvas.dispatchEvent({
        type: 'contextmenu',
        clientX: 610,
        clientY: 420,
        preventDefault() { preventedOnNode = true; },
      });
      const openedOnNode = !menu.hidden && pgState.ctxMenuOpen === true;
      const selectedOnRmb = pgState.selectedNodeId;
      const menuHtml = menu.innerHTML;

      // 2) Run action 'cart' from context menu -> toggles node in cart & closes menu
      pgRunNodeContextAction('cart');
      const closedAfterAction = menu.hidden === true && pgState.ctxMenuOpen === false;
      const inCartAfterAction = pgState.contextCart.has('core/a.mjs');

      // 3) Re-open and press Escape -> closes menu without closing modal
      canvas.dispatchEvent({
        type: 'contextmenu',
        clientX: 610,
        clientY: 420,
        preventDefault() {},
      });
      const escEv = {
        type: 'keydown',
        key: 'Escape',
        defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; },
        stopPropagation() {},
        stopImmediatePropagation() {},
      };
      document.dispatchEvent(escEv);
      const closedAfterEsc = menu.hidden === true && pgState.ctxMenuOpen === false;
      const modalStillOpen = pgState.open === true;

      // 4) Right-click on empty space -> suppresses native menu and keeps custom menu hidden
      let preventedOnEmpty = false;
      canvas.dispatchEvent({
        type: 'contextmenu',
        clientX: 30,
        clientY: 30,
        preventDefault() { preventedOnEmpty = true; },
      });
      const hiddenOnEmpty = menu.hidden === true;

      return {
        preventedOnNode,
        openedOnNode,
        selectedOnRmb,
        menuHtml,
        closedAfterAction,
        inCartAfterAction,
        closedAfterEsc,
        modalStillOpen,
        preventedOnEmpty,
        hiddenOnEmpty,
      };
    })()`, ctx);

    assert.equal(out.preventedOnNode, true, 'contextmenu on node must call preventDefault()');
    assert.equal(out.openedOnNode, true, 'RMB on node must open #pgNodeContextMenu');
    assert.equal(out.selectedOnRmb, 'core/a.mjs', 'RMB on node must select that node');
    assert.ok(out.menuHtml.includes('data-arg="focus"'), 'Context menu must include Focus action');
    assert.ok(out.menuHtml.includes('data-arg="symbols"'), 'Context menu must include Symbols action for file');
    assert.ok(out.menuHtml.includes('data-ctx-submenu="llm"'), 'Context menu must include Ask local LLM flyout submenu');
    assert.ok(out.menuHtml.includes('data-ctx-submenu="chat"'), 'Context menu must include Ask in new chat flyout submenu');
    assert.ok(out.menuHtml.includes('data-arg="ai:explain"'), 'Context menu must include AI Explain preset');
    assert.ok(out.menuHtml.includes('data-arg="ai:risks"'), 'Context menu must include AI Blast Radius preset');
    assert.ok(out.menuHtml.includes('data-arg="chat:explain"'), 'Context menu must include Chat Explain preset');
    assert.ok(out.menuHtml.includes('data-arg="chat:risks"'), 'Context menu must include Chat Blast Radius preset');
    assert.ok(out.menuHtml.includes('data-arg="ai:composer"'), 'Context menu must include Composer preset in Chat submenu');
    assert.equal(out.closedAfterAction, true, 'Running a context menu action must close the menu');
    assert.equal(out.inCartAfterAction, true, 'Cart action must add node to contextCart');
    assert.equal(out.closedAfterEsc, true, 'Escape must close #pgNodeContextMenu');
    assert.equal(out.modalStillOpen, true, 'Escape while context menu is open must not close the whole modal');
    assert.equal(out.preventedOnEmpty, true, 'contextmenu on empty canvas must still call preventDefault()');
    assert.equal(out.hiddenOnEmpty, true, 'RMB on empty canvas must keep #pgNodeContextMenu hidden');
  } finally {
    try {
      vm.runInContext(`if (typeof telemetryPollTimer !== 'undefined' && telemetryPollTimer) { clearTimeout(telemetryPollTimer); telemetryPollTimer = null; }`, ctx);
    } catch {}
    for (const id of Array.from(activeTimers)) {
      safeClearTimeout(id);
    }
  }
});

test('19. Project Map AI thinking bubble, Stop button & /api/local-chat/abort on Stop and Modal Close', async () => {
  const vm = await import('node:vm');
  buildPanelUi({ repoRoot: ROOT_DIR });
  const html = fs.readFileSync(path.join(ROOT_DIR, 'sidecars', 'panel', 'ui.html'), 'utf8');
  for (const marker of [
    'function pgAbortActiveAiRequest(',
    'function pgStopAiRequest(',
    "case 'pgStopAiRequest':",
    'id="pgAiThinkingBubble"',
    '/api/local-chat/abort',
  ]) {
    assert.ok(html.includes(marker), `Expected marker ${marker} in compiled ui.html`);
  }

  const mainScriptMatch = html.match(/<script>\s*([\s\S]*?)\s*<\/script>\s*<\/body>/i);
  assert.ok(mainScriptMatch, 'Main script block must exist in ui.html');

  const attachBus = (obj) => {
    const map = new Map();
    obj.addEventListener = (type, fn) => {
      if (!map.has(type)) map.set(type, new Set());
      map.get(type).add(fn);
    };
    obj.removeEventListener = (type, fn) => {
      if (map.has(type)) map.get(type).delete(fn);
    };
    obj.dispatchEvent = (ev) => {
      const listeners = map.get(ev.type);
      if (!listeners) return;
      for (const fn of Array.from(listeners)) fn(ev);
    };
    return obj;
  };

  const makeClassList = () => {
    const set = new Set();
    return {
      add: (c) => set.add(c),
      remove: (c) => set.delete(c),
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

  const makeEl = (tag = 'div', id = '') => {
    const attrs = new Map();
    const el = {
      id,
      tagName: tag.toUpperCase(),
      className: '',
      hidden: id === 'pgAskAiMenu',
      classList: makeClassList(),
      style: { display: '', setProperty() {}, removeProperty() {} },
      dataset: {},
      value: '',
      textContent: '',
      innerHTML: '',
      disabled: false,
      clientWidth: 1200,
      clientHeight: 800,
      scrollTop: 0,
      scrollHeight: 100,
      setAttribute: (k, v) => attrs.set(String(k), String(v)),
      getAttribute: (k) => (attrs.has(String(k)) ? attrs.get(String(k)) : null),
      removeAttribute: (k) => attrs.delete(String(k)),
      querySelector: () => null,
      querySelectorAll: () => [],
      appendChild: (c) => c,
      closest: (sel) => (sel === '#' + id ? el : null),
      getBoundingClientRect: () => ({ width: 1200, height: 800, left: 0, top: 0 }),
      focus() {},
      blur() {},
    };
    return attachBus(el);
  };

  const elements = new Map();
  for (const id of [
    'projectGraphModal', 'projectGraphCanvas', 'pgCanvasStage', 'pgInspector', 'pgStatsPill',
    'pgClusterPills', 'pgEmptyHint', 'pgHoverTooltip', 'pgZoomIndicator', 'pgSearchInput',
    'pgActionAskAiBtn', 'pgAskAiMenu', 'pgAiChatBox', 'pgAiChatMessages', 'pgAiEngineBadge',
    'pgAiChatTitle', 'pgAiAskSubmitBtn', 'pgAiQuestionInput', 'smartComposerInput',
    'pgInspActions', 'pgMetricIn', 'pgMetricOut', 'pgMetricLines', 'pgMetricRel', 'pgInspFilename',
    'pgInspPath', 'pgInspBadges', 'pgInspMetrics', 'pgInspTabs', 'pgInspList',
  ]) {
    elements.set(id, makeEl(id === 'projectGraphCanvas' ? 'canvas' : (id.includes('Input') ? 'input' : 'div'), id));
  }
  const fakeCtx2d = {
    save() {}, restore() {}, setTransform() {}, clearRect() {}, fillRect() {}, strokeRect() {},
    beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, quadraticCurveTo() {}, bezierCurveTo() {},
    arc() {}, roundRect() {}, rect() {}, clip() {}, fill() {}, stroke() {}, fillText() {}, strokeText() {}, setLineDash() {},
    measureText: (t) => ({ width: String(t || '').length * 7 }),
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: 'left', textBaseline: 'alphabetic', globalAlpha: 1,
  };
  const canvasEl = elements.get('projectGraphCanvas');
  canvasEl.parentElement = elements.get('pgCanvasStage');
  canvasEl.getContext = () => fakeCtx2d;
  canvasEl.setPointerCapture = () => {};
  canvasEl.releasePointerCapture = () => {};

  const doc = attachBus({
    visibilityState: 'visible',
    activeElement: null,
    title: 'The Tunnel',
    body: makeEl('body'),
    documentElement: makeEl('html'),
    getElementById: (id) => elements.get(id) || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag) => makeEl(tag),
  });

  const localChatCalls = [];
  const abortCalls = [];
  const windowObj = attachBus({
    innerWidth: 1280,
    innerHeight: 820,
    devicePixelRatio: 1,
    location: { search: '', reload() {} },
    fetch: (url, init) => {
      const u = String(url);
      const body = init && init.body ? JSON.parse(init.body) : null;
      if (u.includes('/api/local-chat/abort')) {
        abortCalls.push(body);
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ ok: true, abortedCount: 1, requestId: body?.requestId || '' }),
        });
      }
      if (u.includes('/api/local-chat')) {
        const rec = {
          url: u,
          body,
          aborted: Boolean(init?.signal?.aborted),
        };
        localChatCalls.push(rec);
        return new Promise((resolve, reject) => {
          const onAbort = () => {
            rec.aborted = true;
            const err = new Error('The operation was aborted.');
            err.name = 'AbortError';
            reject(err);
          };
          if (init?.signal) {
            if (init.signal.aborted) return onAbort();
            init.signal.addEventListener('abort', onAbort, { once: true });
          }
          const t = setTimeout(() => {
            resolve({
              ok: true,
              status: 200,
              json: async () => ({ ok: true, answer: 'Delayed answer' }),
            });
          }, 5000);
          if (typeof t.unref === 'function') t.unref();
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
    },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { clipboard: { writeText: async () => {} } },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
  });
  windowObj.document = doc;
  windowObj.window = windowObj;

  const activeTimeouts = new Set();
  const activeIntervals = new Set();
  const safeSetTimeout = (fn, ms, ...args) => {
    const id = setTimeout(() => {
      activeTimeouts.delete(id);
      if (typeof fn === 'function') fn(...args);
    }, ms);
    if (typeof id?.unref === 'function') id.unref();
    activeTimeouts.add(id);
    return id;
  };
  const safeClearTimeout = (id) => {
    if (id !== undefined && id !== null) {
      activeTimeouts.delete(id);
      clearTimeout(id);
    }
  };
  const safeSetInterval = (fn, ms, ...args) => {
    const id = setInterval(() => {
      if (typeof fn === 'function') fn(...args);
    }, ms);
    if (typeof id?.unref === 'function') id.unref();
    activeIntervals.add(id);
    return id;
  };
  const safeClearInterval = (id) => {
    if (id !== undefined && id !== null) {
      activeIntervals.delete(id);
      clearInterval(id);
    }
  };

  const ctx = vm.createContext({
    window: windowObj,
    document: doc,
    localStorage: windowObj.localStorage,
    navigator: windowObj.navigator,
    fetch: windowObj.fetch,
    location: windowObj.location,
    requestAnimationFrame: windowObj.requestAnimationFrame,
    cancelAnimationFrame: windowObj.cancelAnimationFrame,
    AbortController,
    URLSearchParams,
    ResizeObserver: undefined,
    console,
    setTimeout: safeSetTimeout,
    clearTimeout: safeClearTimeout,
    setInterval: safeSetInterval,
    clearInterval: safeClearInterval,
    Math, Number, String, Array, Object, Set, Map, JSON, Date, RegExp, Promise, Error,
  });

  try {
    vm.runInContext(mainScriptMatch[1], ctx);

    const rawGraph = {
      ok: true,
      workspaceName: 'ai-abort-test',
      totalFiles: 1,
      shownNodes: 1,
      shownEdges: 0,
      clusters: [{ id: 'core', label: 'core', size: 1 }],
      nodes: [{ id: 'core/a.mjs', label: 'a.mjs', dir: 'core', lines: 30, estTokens: 240, inDeg: 0, outDeg: 0 }],
      edges: [],
    };

    const out = await vm.runInContext(`(async () => {
      currentUiLanguage = 'ru';
      currentState = { ...(currentState || {}), gpuEnabled: true, uiLanguage: 'ru' };
      pgState.open = true;
      pgState.viewLevel = 'files';
      pgHydrateSimulation(${JSON.stringify(rawGraph)});
      pgSelectNodeById('core/a.mjs');

      // 1) Start async request -> verify thinking bubble & stop button state
      const p1 = pgExecuteFileAiQuestion('Зачем нужен этот файл?', 'Зачем нужен этот файл?');
      const busyWhileRunning = pgState.aiBusy;
      const htmlWhileRunning = document.getElementById('pgAiChatMessages').innerHTML;
      const submitBtn = document.getElementById('pgAiAskSubmitBtn');
      const stopBtnText = submitBtn.textContent;
      const stopBtnAction = submitBtn.getAttribute('data-action');
      const stopBtnClass = submitBtn.classList.contains('is-stop');

      // 2) Stop button aborts signal + posts /api/local-chat/abort with matching requestId
      pgStopAiRequest();
      await p1;
      const busyAfterStop = pgState.aiBusy;
      const timerAfterStop = pgState.aiElapsedTimer;
      const htmlAfterStop = document.getElementById('pgAiChatMessages').innerHTML;
      const submitActionAfterStop = submitBtn.getAttribute('data-action');

      // 3) Second request + closing modal aborts signal + posts /api/local-chat/abort
      const p2 = pgExecuteFileAiQuestion('Проверь зависимости', 'Проверь зависимости');
      const busyBeforeClose = pgState.aiBusy;
      closeProjectGraphModal();
      await p2;
      const busyAfterClose = pgState.aiBusy;
      const timerAfterClose = pgState.aiElapsedTimer;

      return {
        busyWhileRunning,
        htmlWhileRunning,
        stopBtnText,
        stopBtnAction,
        stopBtnClass,
        busyAfterStop,
        timerAfterStop,
        htmlAfterStop,
        submitActionAfterStop,
        busyBeforeClose,
        busyAfterClose,
        timerAfterClose,
      };
    })()`, ctx);

    assert.equal(out.busyWhileRunning, true);
    assert.ok(out.htmlWhileRunning.includes('id="pgAiThinkingBubble"'), 'Thinking bubble must appear while GPU is running');
    assert.ok(out.htmlWhileRunning.includes('data-action="pgStopAiRequest"'), 'Inline stop button must be rendered');
    assert.equal(out.stopBtnText, '■');
    assert.equal(out.stopBtnAction, 'pgStopAiRequest');
    assert.equal(out.stopBtnClass, true);
    assert.equal(out.busyAfterStop, false);
    assert.equal(out.timerAfterStop, 0);
    assert.ok(out.htmlAfterStop.includes('остановлена'), 'Stop action must append stopped message');
    assert.equal(out.submitActionAfterStop, 'pgSubmitCustomAiQuestion');

    assert.equal(out.busyBeforeClose, true);
    assert.equal(out.busyAfterClose, false);
    assert.equal(out.timerAfterClose, 0);

    assert.equal(localChatCalls.length, 2);
    assert.equal(localChatCalls[0].aborted, true, 'pgStopAiRequest must abort fetch signal');
    assert.equal(localChatCalls[1].aborted, true, 'closeProjectGraphModal must abort fetch signal');
    assert.equal(abortCalls.length, 2, 'Both Stop and Modal Close must notify /api/local-chat/abort');
    assert.equal(abortCalls[0].requestId, localChatCalls[0].body.requestId);
    assert.equal(abortCalls[1].requestId, localChatCalls[1].body.requestId);
    assert.equal(activeIntervals.size, 0, 'All elapsed intervals must be cleared');
  } finally {
    try {
      vm.runInContext(`if (typeof telemetryPollTimer !== 'undefined' && telemetryPollTimer) { clearTimeout(telemetryPollTimer); telemetryPollTimer = null; }`, ctx);
    } catch {}
    for (const id of Array.from(activeTimeouts)) safeClearTimeout(id);
    for (const id of Array.from(activeIntervals)) safeClearInterval(id);
  }
});

test('20. Combo AI visualization: structured card without raw sym:, Markdown GPU reply, map spotlight & callout', async () => {
  const vm = await import('node:vm');
  buildPanelUi({ repoRoot: ROOT_DIR });
  const html = fs.readFileSync(path.join(ROOT_DIR, 'sidecars', 'panel', 'ui.html'), 'utf8');
  for (const marker of [
    'id="pgAiMapCallout"',
    'function pgBuildStaticSummaryCard(',
    'function pgSyncAiMapOverlay(',
    'function pgFocusAiMention(',
    "case 'pgFocusAiMention':",
    "case 'pgDismissAiMapCallout':",
  ]) {
    assert.ok(html.includes(marker), `Expected Combo marker ${marker} in ui.html`);
  }

  const mainScriptMatch = html.match(/<script>\s*([\s\S]*?)\s*<\/script>\s*<\/body>/i);
  assert.ok(mainScriptMatch, 'Main script block must exist in ui.html');

  const attachBus = (obj) => {
    const map = new Map();
    obj.addEventListener = (type, fn) => {
      if (!map.has(type)) map.set(type, new Set());
      map.get(type).add(fn);
    };
    obj.removeEventListener = (type, fn) => {
      if (map.has(type)) map.get(type).delete(fn);
    };
    obj.dispatchEvent = (ev) => {
      const listeners = map.get(ev.type);
      if (!listeners) return;
      for (const fn of Array.from(listeners)) fn(ev);
    };
    return obj;
  };

  const makeClassList = () => {
    const set = new Set();
    return {
      add: (c) => set.add(c),
      remove: (c) => set.delete(c),
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

  const makeEl = (tag = 'div', id = '') => {
    const attrs = new Map();
    const el = {
      id,
      tagName: tag.toUpperCase(),
      className: '',
      hidden: id === 'pgAskAiMenu' || id === 'pgAiMapCallout',
      classList: makeClassList(),
      style: { display: '', left: '', top: '', setProperty() {}, removeProperty() {} },
      dataset: {},
      value: '',
      textContent: '',
      innerHTML: '',
      disabled: false,
      offsetHeight: 110,
      clientWidth: 1200,
      clientHeight: 800,
      scrollTop: 0,
      scrollHeight: 100,
      setAttribute: (k, v) => attrs.set(String(k), String(v)),
      getAttribute: (k) => (attrs.has(String(k)) ? attrs.get(String(k)) : null),
      removeAttribute: (k) => attrs.delete(String(k)),
      querySelector: () => null,
      querySelectorAll: () => [],
      appendChild: (c) => c,
      closest: (sel) => (sel === '#' + id ? el : null),
      getBoundingClientRect: () => ({ width: 1200, height: 800, left: 0, top: 0 }),
      focus() {},
      blur() {},
    };
    return attachBus(el);
  };

  const elements = new Map();
  for (const id of [
    'projectGraphModal', 'projectGraphCanvas', 'pgCanvasStage', 'pgInspector', 'pgStatsPill',
    'pgClusterPills', 'pgEmptyHint', 'pgHoverTooltip', 'pgZoomIndicator', 'pgSearchInput',
    'pgActionAskAiBtn', 'pgAskAiMenu', 'pgAiChatBox', 'pgAiChatMessages', 'pgAiEngineBadge',
    'pgAiChatTitle', 'pgAiAskSubmitBtn', 'pgAiQuestionInput', 'pgAiMapCallout', 'smartComposerInput',
    'pgInspActions', 'pgMetricIn', 'pgMetricOut', 'pgMetricLines', 'pgMetricRel', 'pgInspFilename',
    'pgInspPath', 'pgInspBadges', 'pgInspMetrics', 'pgInspTabs', 'pgInspList',
  ]) {
    elements.set(id, makeEl(id === 'projectGraphCanvas' ? 'canvas' : (id.includes('Input') ? 'input' : 'div'), id));
  }
  const fakeCtx2d = {
    save() {}, restore() {}, setTransform() {}, clearRect() {}, fillRect() {}, strokeRect() {},
    beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, quadraticCurveTo() {}, bezierCurveTo() {},
    arc() {}, roundRect() {}, rect() {}, clip() {}, fill() {}, stroke() {}, fillText() {}, strokeText() {}, setLineDash() {},
    measureText: (t) => ({ width: String(t || '').length * 7 }),
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: 'left', textBaseline: 'alphabetic', globalAlpha: 1,
  };
  const canvasEl = elements.get('projectGraphCanvas');
  canvasEl.parentElement = elements.get('pgCanvasStage');
  canvasEl.getContext = () => fakeCtx2d;
  canvasEl.setPointerCapture = () => {};
  canvasEl.releasePointerCapture = () => {};

  const doc = attachBus({
    visibilityState: 'visible',
    activeElement: null,
    title: 'The Tunnel',
    body: makeEl('body'),
    documentElement: makeEl('html'),
    getElementById: (id) => elements.get(id) || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag) => makeEl(tag),
  });

  const windowObj = attachBus({
    innerWidth: 1280,
    innerHeight: 820,
    devicePixelRatio: 1,
    location: { search: '', reload() {} },
    fetch: async (url) => {
      if (String(url).includes('/api/local-chat')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            answer: '### Разбор `toRelPath`\n- Используется в **upsertFile** и `core/b.mjs`.',
            sources: [{ file: 'core/b.mjs', startLine: 12, endLine: 25 }],
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { clipboard: { writeText: async () => {} } },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
  });
  windowObj.document = doc;
  windowObj.window = windowObj;

  const activeTimeouts = new Set();
  const safeSetTimeout = (fn, ms, ...args) => {
    const id = setTimeout(() => {
      activeTimeouts.delete(id);
      if (typeof fn === 'function') fn(...args);
    }, ms);
    if (typeof id?.unref === 'function') id.unref();
    activeTimeouts.add(id);
    return id;
  };
  const safeClearTimeout = (id) => {
    if (id !== undefined && id !== null) {
      activeTimeouts.delete(id);
      clearTimeout(id);
    }
  };

  const ctx = vm.createContext({
    window: windowObj,
    document: doc,
    localStorage: windowObj.localStorage,
    navigator: windowObj.navigator,
    fetch: windowObj.fetch,
    location: windowObj.location,
    requestAnimationFrame: windowObj.requestAnimationFrame,
    cancelAnimationFrame: windowObj.cancelAnimationFrame,
    AbortController,
    URLSearchParams,
    ResizeObserver: undefined,
    console,
    setTimeout: safeSetTimeout,
    clearTimeout: safeClearTimeout,
    Math, Number, String, Array, Object, Set, Map, JSON, Date, RegExp, Promise, Error,
  });

  try {
    vm.runInContext(mainScriptMatch[1], ctx);

    const rawGraph = {
      ok: true,
      workspaceName: 'combo-ai-test',
      totalFiles: 3,
      shownNodes: 3,
      shownEdges: 2,
      clusters: [{ id: 'core', label: 'core', size: 3 }],
      nodes: [
        {
          id: 'sym:core/ram/ram-index-helpers.mjs#toRelPath:10',
          label: 'toRelPath',
          file: 'core/ram/ram-index-helpers.mjs',
          isSymbol: true,
          dir: 'core',
          lines: 3,
          inDeg: 1,
          outDeg: 1,
          isGod: true,
        },
        {
          id: 'sym:core/ram-memory-engine.mjs#upsertFile:508',
          label: 'upsertFile',
          file: 'core/ram-memory-engine.mjs',
          isSymbol: true,
          dir: 'core',
          lines: 40,
          inDeg: 0,
          outDeg: 1,
        },
        {
          id: 'core/b.mjs',
          label: 'b.mjs',
          dir: 'core',
          lines: 20,
          inDeg: 1,
          outDeg: 0,
        },
      ],
      edges: [
        { source: 'sym:core/ram-memory-engine.mjs#upsertFile:508', target: 'sym:core/ram/ram-index-helpers.mjs#toRelPath:10', kind: 'call' },
        { source: 'sym:core/ram/ram-index-helpers.mjs#toRelPath:10', target: 'core/b.mjs', kind: 'import' },
      ],
    };

    const out = await vm.runInContext(`(async () => {
      currentUiLanguage = 'ru';
      currentState = { ...(currentState || {}), gpuEnabled: false, uiLanguage: 'ru' };
      pgState.open = true;
      pgState.width = 900;
      pgState.height = 600;
      pgState.viewLevel = 'files';
      pgHydrateSimulation(${JSON.stringify(rawGraph)});
      pgSelectNodeById('sym:core/ram/ram-index-helpers.mjs#toRelPath:10');

      // 1) Static card mode (GPU OFF) -> clean chip labels, no raw sym: in visible chip spans, callout shown & spotlight populated
      await pgRunAiPreset('explain');
      const cardHtml = document.getElementById('pgAiChatMessages').innerHTML;
      const spotlightAfterCard = pgState.aiSpotlightMap.size;
      const calloutEl = document.getElementById('pgAiMapCallout');
      const calloutVisibleAfterCard = calloutEl.hidden === false;
      const calloutHtmlAfterCard = calloutEl.innerHTML;

      // 2) GPU ON -> Markdown rendering + spotlight + click focus preserves spotlight
      currentState.gpuEnabled = true;
      await pgRunAiPreset('explain');
      const mdHtml = document.getElementById('pgAiChatMessages').innerHTML;
      const spotlightAfterGpu = pgState.aiSpotlightMap.size;
      const targetNode = pgState.nodeById.get('core/b.mjs');
      targetNode.x = 240;
      targetNode.y = -120;
      pgFocusAiMention('core/b.mjs');
      const camMovedToB = pgState.camX === 240 && pgState.camY === -120 && pgState.hoveredNodeId === 'core/b.mjs';
      const spotlightPreserved = pgState.aiSpotlightMap.size === spotlightAfterGpu;

      // 3) Dismiss callout clears spotlight & hides callout
      pgDismissAiMapCallout();
      const calloutHiddenAfterDismiss = calloutEl.hidden === true;
      const spotlightAfterDismiss = pgState.aiSpotlightMap.size;

      return {
        cardHtml,
        spotlightAfterCard,
        calloutVisibleAfterCard,
        calloutHtmlAfterCard,
        mdHtml,
        spotlightAfterGpu,
        camMovedToB,
        spotlightPreserved,
        calloutHiddenAfterDismiss,
        spotlightAfterDismiss,
      };
    })()`, ctx);

    assert.ok(out.cardHtml.includes('pg-ai-card'), 'Static fallback must render .pg-ai-card');
    assert.ok(out.cardHtml.includes('<span class="pg-ai-ref-primary">upsertFile</span>'), 'Chip must render clean symbol name');
    assert.ok(out.cardHtml.includes('ram-memory-engine.mjs:508'), 'Chip sub-label must format file:line cleanly');
    assert.ok(!out.cardHtml.includes('>sym:'), 'Visible chip text must not start with raw sym:');
    assert.ok(out.spotlightAfterCard >= 2, 'AI spotlight must highlight anchor and dependent nodes');
    assert.equal(out.calloutVisibleAfterCard, true, '#pgAiMapCallout must be visible after AI reply');
    assert.ok(out.calloutHtmlAfterCard.includes('toRelPath'), 'Callout must show anchor title');

    assert.ok(out.mdHtml.includes('rag-md-heading'), 'GPU reply must render Markdown headings');
    assert.ok(out.mdHtml.includes('<strong>upsertFile</strong>'), 'GPU reply must render bold Markdown');
    assert.ok(out.mdHtml.includes('rag-inline-code'), 'GPU reply must render inline code');
    assert.ok(out.spotlightAfterGpu >= 2, 'GPU reply must spotlight mentioned/source nodes');
    assert.equal(out.camMovedToB, true, 'pgFocusAiMention must pan camera to mentioned node');
    assert.equal(out.spotlightPreserved, true, 'pgFocusAiMention must keep AI spotlight active');
    assert.equal(out.calloutHiddenAfterDismiss, true, 'pgDismissAiMapCallout must hide map callout');
    assert.equal(out.spotlightAfterDismiss, 0, 'pgDismissAiMapCallout must clear AI spotlight');
  } finally {
    try {
      vm.runInContext(`if (typeof telemetryPollTimer !== 'undefined' && telemetryPollTimer) { clearTimeout(telemetryPollTimer); telemetryPollTimer = null; }`, ctx);
    } catch {}
    for (const id of Array.from(activeTimeouts)) safeClearTimeout(id);
  }
});

test('21. Far node drag invalidates quadtree spatialTree for hover, select, and re-drag (>=100 nodes layered)', async () => {
  const vm = await import('node:vm');
  const html = fs.readFileSync(path.join(ROOT_DIR, 'sidecars', 'panel', 'ui.html'), 'utf8');
  const mainScriptMatch = html.match(/<script>\s*([\s\S]*?)\s*<\/script>\s*<\/body>/i);
  assert.ok(mainScriptMatch, 'Main script block must exist in ui.html');

  const attachBus = (obj) => {
    const map = new Map();
    obj.addEventListener = (type, fn) => {
      if (!map.has(type)) map.set(type, new Set());
      map.get(type).add(fn);
    };
    obj.removeEventListener = (type, fn) => {
      if (map.has(type)) map.get(type).delete(fn);
    };
    obj.dispatchEvent = (ev) => {
      const listeners = map.get(ev.type);
      if (!listeners) return;
      for (const fn of Array.from(listeners)) fn(ev);
    };
    return obj;
  };

  const makeClassList = () => {
    const set = new Set();
    return {
      add: (c) => set.add(c),
      remove: (c) => set.delete(c),
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

  const makeEl = (tag = 'div', id = '') => {
    const attrs = new Map();
    const el = {
      id,
      tagName: tag.toUpperCase(),
      className: '',
      hidden: false,
      classList: makeClassList(),
      style: { display: '', cursor: '', setProperty() {}, removeProperty() {} },
      dataset: {},
      value: '',
      textContent: '',
      innerHTML: '',
      disabled: false,
      clientWidth: 1200,
      clientHeight: 800,
      scrollTop: 0,
      scrollHeight: 100,
      setAttribute: (k, v) => attrs.set(String(k), String(v)),
      getAttribute: (k) => (attrs.has(String(k)) ? attrs.get(String(k)) : null),
      removeAttribute: (k) => attrs.delete(String(k)),
      querySelector: () => null,
      querySelectorAll: () => [],
      appendChild: (c) => c,
      closest: (sel) => (sel === '#' + id ? el : null),
      getBoundingClientRect: () => ({ width: 1200, height: 800, left: 0, top: 0 }),
      focus() {},
      blur() {},
    };
    return attachBus(el);
  };

  const elements = new Map();
  for (const id of [
    'projectGraphModal', 'projectGraphCanvas', 'pgCanvasStage', 'pgInspector', 'pgStatsPill',
    'pgClusterPills', 'pgEmptyHint', 'pgHoverTooltip', 'pgZoomIndicator', 'pgSearchInput',
    'pgInspActions', 'pgMetricIn', 'pgMetricOut', 'pgMetricLines', 'pgMetricRel', 'pgInspFilename',
    'pgInspPath', 'pgInspBadges', 'pgInspMetrics', 'pgInspTabs', 'pgInspList',
  ]) {
    elements.set(id, makeEl(id === 'projectGraphCanvas' ? 'canvas' : (id === 'pgSearchInput' ? 'input' : 'div'), id));
  }
  const fakeCtx2d = {
    save() {}, restore() {}, setTransform() {}, clearRect() {}, fillRect() {}, strokeRect() {},
    beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, quadraticCurveTo() {}, bezierCurveTo() {},
    arc() {}, roundRect() {}, rect() {}, clip() {}, fill() {}, stroke() {}, fillText() {}, strokeText() {}, setLineDash() {},
    measureText: (t) => ({ width: String(t || '').length * 7 }),
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: 'left', textBaseline: 'alphabetic', globalAlpha: 1,
  };
  const canvasEl = elements.get('projectGraphCanvas');
  canvasEl.parentElement = elements.get('pgCanvasStage');
  canvasEl.getContext = () => fakeCtx2d;
  canvasEl.setPointerCapture = () => {};
  canvasEl.releasePointerCapture = () => {};

  const doc = attachBus({
    visibilityState: 'visible',
    activeElement: null,
    title: 'The Tunnel',
    body: makeEl('body'),
    documentElement: makeEl('html'),
    getElementById: (id) => elements.get(id) || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag) => makeEl(tag),
  });

  const windowObj = attachBus({
    innerWidth: 1280,
    innerHeight: 820,
    devicePixelRatio: 1,
    location: { search: '', reload() {} },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { clipboard: { writeText: async () => {} } },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
  });
  windowObj.document = doc;
  windowObj.window = windowObj;

  const activeTimeouts = new Set();
  const safeSetTimeout = (fn, ms, ...args) => {
    const id = setTimeout(() => {
      activeTimeouts.delete(id);
      if (typeof fn === 'function') fn(...args);
    }, ms);
    if (typeof id?.unref === 'function') id.unref();
    activeTimeouts.add(id);
    return id;
  };
  const safeClearTimeout = (id) => {
    if (id !== undefined && id !== null) {
      activeTimeouts.delete(id);
      clearTimeout(id);
    }
  };

  const ctx = vm.createContext({
    window: windowObj,
    document: doc,
    localStorage: windowObj.localStorage,
    navigator: windowObj.navigator,
    fetch: windowObj.fetch,
    location: windowObj.location,
    requestAnimationFrame: windowObj.requestAnimationFrame,
    cancelAnimationFrame: windowObj.cancelAnimationFrame,
    AbortController,
    URLSearchParams,
    ResizeObserver: undefined,
    console,
    setTimeout: safeSetTimeout,
    clearTimeout: safeClearTimeout,
    Math, Number, String, Array, Object, Set, Map, JSON, Date, RegExp, Promise, Error,
  });

  try {
    vm.runInContext(mainScriptMatch[1], ctx);

    const nodes = [];
    const edges = [];
    for (let i = 0; i < 120; i++) {
      nodes.push({
        id: 'core/f' + i + '.mjs',
        label: 'f' + i + '.mjs',
        dir: 'core',
        lines: 30 + i,
        estTokens: 200,
        inDeg: i > 0 ? 1 : 0,
        outDeg: i < 119 ? 1 : 0,
      });
      if (i > 0) {
        edges.push({ source: 'core/f' + (i - 1) + '.mjs', target: 'core/f' + i + '.mjs', kind: 'import' });
      }
    }
    const rawGraph = {
      ok: true,
      workspaceName: 'far-drag-test',
      totalFiles: 120,
      shownNodes: 120,
      shownEdges: 119,
      clusters: [{ id: 'core', label: 'core', size: 120 }],
      nodes,
      edges,
    };

    const res = vm.runInContext(`(() => {
      const canvas = document.getElementById('projectGraphCanvas');
      pgState.open = true;
      pgState.width = 1200;
      pgState.height = 800;
      pgState.rawGraphData = ${JSON.stringify(rawGraph)};
      pgState.viewLevel = 'files';
      pgState.layoutMode = 'layered';
      pgBindCanvasEvents();
      updateState = async (patch) => {
        Object.assign(currentState, patch || {});
        return { ok: true, state: currentState };
      };
      pgHydrateSimulation(pgState.rawGraphData);
      pgDrawGraph();

      const target = pgState.nodeById.get('core/f0.mjs');
      const sp1 = pgWorldToScreen(target.x, target.y);
      const treeBeforeDrag = Boolean(pgState.spatialTree);

      // Drag far outside initial quadtree bounds (+2500, +1800)
      canvas.dispatchEvent({
        type: 'pointerdown',
        button: 0,
        pointerType: 'mouse',
        pointerId: 31,
        clientX: sp1.x,
        clientY: sp1.y,
      });
      canvas.dispatchEvent({
        type: 'pointermove',
        pointerType: 'mouse',
        buttons: 1,
        pointerId: 31,
        clientX: sp1.x + 2500,
        clientY: sp1.y + 1800,
      });
      const treeClearedDuringDrag = pgState.spatialTree === null;
      canvas.dispatchEvent({
        type: 'pointerup',
        pointerType: 'mouse',
        pointerId: 31,
        clientX: sp1.x + 2500,
        clientY: sp1.y + 1800,
      });
      const treeClearedAfterDrag = pgState.spatialTree === null;
      const farX = target.x;
      const farY = target.y;

      // Pan camera to the moved node and hover over it
      pgState.camX = farX;
      pgState.camY = farY;
      const sp2 = pgWorldToScreen(farX, farY);
      canvas.dispatchEvent({
        type: 'pointermove',
        pointerType: 'mouse',
        buttons: 0,
        pointerId: 32,
        clientX: sp2.x,
        clientY: sp2.y,
      });
      const hoveredAfterMove = pgState.hoveredNodeId;
      const cursorAfterMove = canvas.style.cursor;
      const hitAfterMove = pgFindNodeAtScreen(sp2.x, sp2.y)?.id || '';

      // Click to select the moved node
      canvas.dispatchEvent({
        type: 'pointerdown',
        button: 0,
        pointerType: 'mouse',
        pointerId: 33,
        clientX: sp2.x,
        clientY: sp2.y,
      });
      canvas.dispatchEvent({
        type: 'pointerup',
        pointerType: 'mouse',
        pointerId: 33,
        clientX: sp2.x,
        clientY: sp2.y,
      });
      const selectedAfterClick = pgState.selectedNodeId;

      // Drag the moved node again to verify re-dragging works
      canvas.dispatchEvent({
        type: 'pointerdown',
        button: 0,
        pointerType: 'mouse',
        pointerId: 34,
        clientX: sp2.x,
        clientY: sp2.y,
      });
      canvas.dispatchEvent({
        type: 'pointermove',
        pointerType: 'mouse',
        buttons: 1,
        pointerId: 34,
        clientX: sp2.x + 120,
        clientY: sp2.y - 80,
      });
      canvas.dispatchEvent({
        type: 'pointerup',
        pointerType: 'mouse',
        pointerId: 34,
        clientX: sp2.x + 120,
        clientY: sp2.y - 80,
      });

      return {
        treeBeforeDrag,
        treeClearedDuringDrag,
        treeClearedAfterDrag,
        farX,
        farY,
        hoveredAfterMove,
        cursorAfterMove,
        hitAfterMove,
        selectedAfterClick,
        reDraggedDist: Math.hypot(target.x - farX, target.y - farY),
      };
    })()`, ctx);

    assert.equal(res.treeBeforeDrag, true, 'Quadtree must be built for >= 100 nodes');
    assert.equal(res.treeClearedDuringDrag, true, 'spatialTree must be invalidated while dragging a node');
    assert.equal(res.treeClearedAfterDrag, true, 'spatialTree must be invalidated after dropping a dragged node');
    assert.equal(res.hitAfterMove, 'core/f0.mjs', 'Moved node far away must still be hit-tested via quadtree');
    assert.equal(res.hoveredAfterMove, 'core/f0.mjs', 'Moved node far away must highlight on hover');
    assert.equal(res.cursorAfterMove, 'pointer', 'Cursor must switch to pointer when hovering moved node');
    assert.equal(res.selectedAfterClick, 'core/f0.mjs', 'Moved node far away must be selectable on click');
    assert.ok(res.reDraggedDist > 50, 'Moved node far away must be draggable again');
  } finally {
    try {
      vm.runInContext(`if (typeof telemetryPollTimer !== 'undefined' && telemetryPollTimer) { clearTimeout(telemetryPollTimer); telemetryPollTimer = null; }`, ctx);
    } catch {}
    for (const id of Array.from(activeTimeouts)) safeClearTimeout(id);
  }
});

test('20. Project Map combo layers (swimlanes + frames + clickable headers) and synchronized UI scale', async () => {
  const vm = await import('node:vm');
  const html = fs.readFileSync(path.join(ROOT_DIR, 'sidecars', 'panel', 'ui.html'), 'utf8');
  for (const marker of [
    'id="pgUiScaleBtn"',
    'function pgGetUiScale(',
    'function pgGetLayerRolePalette(',
    'function pgFindLayerHeaderAtScreen(',
    'function pgToggleLayerFilter(',
    "case 'pgClearLayerFilter':",
    'pg-layer-filter-chip',
  ]) {
    assert.ok(html.includes(marker), `Expected layer combo / scale marker ${marker} in ui.html`);
  }

  const mainScriptMatch = html.match(/<script>\s*([\s\S]*?)\s*<\/script>\s*<\/body>/i);
  assert.ok(mainScriptMatch, 'Main script block must exist in ui.html');

  const attachBus = (obj) => {
    const map = new Map();
    obj.addEventListener = (type, fn) => {
      if (!map.has(type)) map.set(type, new Set());
      map.get(type).add(fn);
    };
    obj.removeEventListener = (type, fn) => {
      if (map.has(type)) map.get(type).delete(fn);
    };
    obj.dispatchEvent = (ev) => {
      const listeners = map.get(ev.type);
      if (!listeners) return;
      for (const fn of Array.from(listeners)) fn(ev);
    };
    return obj;
  };

  const makeClassList = () => {
    const set = new Set();
    return {
      add: (c) => set.add(c),
      remove: (c) => set.delete(c),
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

  const makeEl = (tag = 'div', id = '') => {
    const attrs = new Map();
    const cssProps = {};
    const el = {
      id,
      tagName: tag.toUpperCase(),
      className: '',
      hidden: false,
      classList: makeClassList(),
      style: {
        display: '',
        setProperty(k, v) { cssProps[String(k)] = String(v); },
        removeProperty(k) { delete cssProps[String(k)]; },
        _props: cssProps,
      },
      dataset: {},
      value: '',
      textContent: '',
      innerHTML: '',
      disabled: false,
      clientWidth: 1200,
      clientHeight: 800,
      setAttribute: (k, v) => attrs.set(String(k), String(v)),
      getAttribute: (k) => (attrs.has(String(k)) ? attrs.get(String(k)) : null),
      removeAttribute: (k) => attrs.delete(String(k)),
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 800 }),
      getContext: () => ({
        save() {}, restore() {}, clearRect() {}, fillRect() {}, strokeRect() {}, beginPath() {}, closePath() {},
        arc() {}, rect() {}, clip() {}, fill() {}, stroke() {}, moveTo() {}, lineTo() {}, quadraticCurveTo() {},
        bezierCurveTo() {}, roundRect() {}, drawImage() {},
        setLineDash() {}, setTransform() {}, scale() {}, translate() {}, fillText() {}, strokeText() {},
        createLinearGradient: () => ({ addColorStop() {} }),
        createRadialGradient: () => ({ addColorStop() {} }),
        measureText: (s) => ({ width: String(s || '').length * 7 }),
      }),
      focus() {},
      closest: (sel) => (sel === '#' + id ? el : null),
      querySelectorAll: () => [],
      querySelector: () => null,
    };
    return attachBus(el);
  };

  const els = new Map();
  for (const [id, tag] of [
    ['projectGraphModal', 'div'],
    ['pgCanvasStage', 'div'],
    ['projectGraphCanvas', 'canvas'],
    ['pgClusterPills', 'div'],
    ['panelUiScaleBtn', 'button'],
    ['pgUiScaleBtn', 'button'],
    ['pgInspFilename', 'div'],
    ['pgInspPath', 'div'],
    ['pgInspBadges', 'div'],
    ['pgInspMetrics', 'div'],
    ['pgInspTabs', 'div'],
    ['pgInspActions', 'div'],
    ['pgInspList', 'div'],
    ['pgHoverTooltip', 'div'],
    ['smartComposerInput', 'textarea'],
  ]) {
    els.set(id, makeEl(tag, id));
  }

  const doc = attachBus({
    body: makeEl('body', 'body'),
    documentElement: makeEl('html', 'html'),
    activeElement: null,
    getElementById: (id) => els.get(id) || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag) => makeEl(tag, ''),
  });

  const activeTimeouts = new Set();
  const safeSetTimeout = (fn, ms) => {
    const id = setTimeout(() => { activeTimeouts.delete(id); fn(); }, Math.min(Number(ms) || 0, 50));
    if (id && typeof id.unref === 'function') id.unref();
    activeTimeouts.add(id);
    return id;
  };
  const safeClearTimeout = (id) => { activeTimeouts.delete(id); clearTimeout(id); };

  const win = attachBus({
    location: { search: '', href: 'http://127.0.0.1:4242/' },
    innerWidth: 1400,
    innerHeight: 900,
    screen: { width: 3840, height: 2160 },
    devicePixelRatio: 1,
    document: doc,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { clipboard: { writeText: async () => {} } },
    setTimeout: safeSetTimeout,
    clearTimeout: safeClearTimeout,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }),
    URLSearchParams,
    AbortController,
  });

  const ctx = vm.createContext({
    window: win,
    document: doc,
    navigator: win.navigator,
    localStorage: win.localStorage,
    location: win.location,
    fetch: win.fetch,
    setTimeout: safeSetTimeout,
    clearTimeout: safeClearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: win.requestAnimationFrame,
    cancelAnimationFrame: win.cancelAnimationFrame,
    URLSearchParams,
    AbortController,
    console,
    Math,
    Date,
    JSON,
    Map,
    Set,
    Array,
    Object,
    String,
    Number,
    Boolean,
    RegExp,
    Promise,
  });

  try {
    vm.runInContext(mainScriptMatch[1], ctx);
    const out = await vm.runInContext(`(async () => {
      currentState.uiLanguage = 'ru';
      currentState.panelUiScale = 'auto';
      pgState.open = true;
      pgState.width = 1200;
      pgState.height = 800;
      pgState.layoutMode = 'layered';
      pgBindCanvasEvents();
      updateState = async (patch) => {
        Object.assign(currentState, patch || {});
        return { ok: true, state: currentState };
      };

      // 1) Sync auto & manual UI scale between #panelUiScaleBtn and #pgUiScaleBtn
      applyPanelUiScaleDom('auto', false);
      const autoMainTxt = document.getElementById('panelUiScaleBtn').textContent;
      const autoPgTxt = document.getElementById('pgUiScaleBtn').textContent;
      const autoScaleVal = pgGetUiScale();

      setPanelUiScale('130');
      const manMainTxt = document.getElementById('panelUiScaleBtn').textContent;
      const manPgTxt = document.getElementById('pgUiScaleBtn').textContent;
      const manScaleVal = pgGetUiScale();

      // 2) Symbol-mode layer roles & names
      const symRaw = {
        ok: true,
        isSymbolsView: true,
        isMacro: false,
        nodes: [
          { id: 'sym:app.mjs#main', label: 'main', isSymbol: true, clusterId: 'c1', inDeg: 0, outDeg: 1 },
          { id: 'sym:app.mjs#service', label: 'service', isSymbol: true, clusterId: 'c1', inDeg: 1, outDeg: 1 },
          { id: 'sym:app.mjs#helper', label: 'helper', isSymbol: true, clusterId: 'c1', inDeg: 1, outDeg: 0 },
        ],
        edges: [
          { source: 'sym:app.mjs#main', target: 'sym:app.mjs#service', kind: 'import', weight: 1 },
          { source: 'sym:app.mjs#service', target: 'sym:app.mjs#helper', kind: 'import', weight: 1 },
        ],
        clusters: [{ id: 'c1', label: 'app.mjs', size: 3 }],
      };
      pgState.rawGraphData = symRaw;
      pgState.viewLevel = 'symbols';
      pgHydrateSimulation(symRaw);

      const colsInfo = pgState.layeredColumns.map((c) => ({
        tier: c.tier,
        role: c.role,
        labelRu: c.labelRu,
        hasBounds: Number.isFinite(c.minY) && Number.isFinite(c.maxY),
      }));
      const headerCount = pgState.layerHeaderRects.length;
      const firstHdr = pgState.layerHeaderRects[0];
      const hitHdr = pgFindLayerHeaderAtScreen(firstHdr.x + firstHdr.w * 0.5, firstHdr.y + firstHdr.h * 0.5);

      // 3) Click layer header to filter & render chip, then click again to clear
      const canvas = document.getElementById('projectGraphCanvas');
      canvas.dispatchEvent({
        type: 'pointerdown',
        button: 0,
        pointerType: 'mouse',
        pointerId: 41,
        clientX: firstHdr.x + firstHdr.w * 0.5,
        clientY: firstHdr.y + firstHdr.h * 0.5,
      });
      canvas.dispatchEvent({
        type: 'pointerup',
        pointerType: 'mouse',
        pointerId: 41,
        clientX: firstHdr.x + firstHdr.w * 0.5,
        clientY: firstHdr.y + firstHdr.h * 0.5,
      });
      const activeTierAfterClick = pgState.activeLayerTier;
      const chipPresent = document.getElementById('pgClusterPills').innerHTML.includes('pg-layer-filter-chip');
      const entryNode = pgState.nodeById.get('sym:app.mjs#main');
      const coreNode = pgState.nodeById.get('sym:app.mjs#helper');
      const entryMatches = pgNodeMatchesFilters(entryNode);
      const coreMatches = pgNodeMatchesFilters(coreNode);

      pgToggleLayerFilter(null);
      const activeTierAfterClear = pgState.activeLayerTier;
      const chipPresentAfterClear = document.getElementById('pgClusterPills').innerHTML.includes('pg-layer-filter-chip');

      return {
        autoMainTxt,
        autoPgTxt,
        autoScaleVal,
        manMainTxt,
        manPgTxt,
        manScaleVal,
        colsInfo,
        headerCount,
        hitTier: hitHdr ? hitHdr.tier : -1,
        activeTierAfterClick,
        chipPresent,
        entryMatches,
        coreMatches,
        activeTierAfterClear,
        chipPresentAfterClear,
      };
    })()`, ctx);

    assert.equal(out.autoPgTxt, out.autoMainTxt, '#pgUiScaleBtn must match #panelUiScaleBtn in auto mode');
    assert.equal(out.autoScaleVal, 1.25, '3840x2160 screen must compute 1.25 auto scale for graph');
    assert.equal(out.manMainTxt, '130%', 'Manual 130% scale label must update main button');
    assert.equal(out.manPgTxt, '130%', 'Manual 130% scale label must sync to map button');
    assert.equal(out.manScaleVal, 1.3, 'Manual 130% scale must propagate to pgGetUiScale');

    assert.equal(out.colsInfo.length, 3, 'Three layered columns expected');
    assert.equal(out.colsInfo[0].role, 'entry');
    assert.equal(out.colsInfo[0].labelRu, 'Точки входа');
    assert.equal(out.colsInfo[2].role, 'core');
    assert.equal(out.colsInfo[2].labelRu, 'База / Утилиты');
    assert.equal(out.colsInfo.every((c) => c.hasBounds), true, 'Columns must store minY/maxY bounds');
    assert.equal(out.headerCount, 3, 'pgDrawGraph must emit clickable rects for all 3 layer headers');
    assert.equal(out.hitTier, out.colsInfo[0].tier, 'pgFindLayerHeaderAtScreen must resolve clicked header tier');
    assert.equal(out.activeTierAfterClick, out.colsInfo[0].tier, 'Clicking layer header must filter to that tier');
    assert.equal(out.chipPresent, true, 'Active layer filter chip must render in #pgClusterPills');
    assert.equal(out.entryMatches, true, 'Entry node must match active entry layer filter');
    assert.equal(out.coreMatches, false, 'Core node must be filtered out when entry layer is active');
    assert.equal(out.activeTierAfterClear, null, 'pgToggleLayerFilter(null) must clear activeLayerTier');
    assert.equal(out.chipPresentAfterClear, false, 'Layer filter chip must disappear after clearing filter');
  } finally {
    try {
      vm.runInContext(`if (typeof telemetryPollTimer !== 'undefined' && telemetryPollTimer) { clearTimeout(telemetryPollTimer); telemetryPollTimer = null; }`, ctx);
    } catch {}
    for (const id of Array.from(activeTimeouts)) safeClearTimeout(id);
  }
});

test('22. Hybrid layer column drag by header, smart node detach/reattach, align reset & batch undo/redo', async () => {
  const vm = await import('node:vm');
  const html = fs.readFileSync(path.join(ROOT_DIR, 'sidecars', 'panel', 'ui.html'), 'utf8');
  for (const marker of [
    'id="pgAlignLayersBtn"',
    "case 'pgResetLayeredPositions':",
    'function pgSyncNodeLayerDetachment(',
    'function pgResetLayeredPositions(',
  ]) {
    assert.ok(html.includes(marker), `Expected hybrid layer marker ${marker} in ui.html`);
  }

  const mainScriptMatch = html.match(/<script>\s*([\s\S]*?)\s*<\/script>\s*<\/body>/i);
  assert.ok(mainScriptMatch, 'Main script block must exist in ui.html');

  const attachBus = (obj) => {
    const map = new Map();
    obj.addEventListener = (type, fn) => {
      if (!map.has(type)) map.set(type, new Set());
      map.get(type).add(fn);
    };
    obj.removeEventListener = (type, fn) => {
      if (map.has(type)) map.get(type).delete(fn);
    };
    obj.dispatchEvent = (ev) => {
      const listeners = map.get(ev.type);
      if (!listeners) return;
      for (const fn of Array.from(listeners)) fn(ev);
    };
    return obj;
  };

  const makeClassList = () => {
    const set = new Set();
    return {
      add: (c) => set.add(c),
      remove: (c) => set.delete(c),
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

  const makeEl = (tag = 'div', id = '') => {
    const attrs = new Map();
    const el = {
      id,
      tagName: tag.toUpperCase(),
      className: '',
      hidden: false,
      classList: makeClassList(),
      style: { display: '', setProperty() {}, removeProperty() {} },
      dataset: {},
      value: '',
      textContent: '',
      innerHTML: '',
      disabled: false,
      clientWidth: 1200,
      clientHeight: 800,
      setAttribute: (k, v) => attrs.set(String(k), String(v)),
      getAttribute: (k) => (attrs.has(String(k)) ? attrs.get(String(k)) : null),
      removeAttribute: (k) => attrs.delete(String(k)),
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 800 }),
      getContext: () => ({
        save() {}, restore() {}, clearRect() {}, fillRect() {}, strokeRect() {}, beginPath() {}, closePath() {},
        arc() {}, rect() {}, clip() {}, fill() {}, stroke() {}, moveTo() {}, lineTo() {}, quadraticCurveTo() {},
        bezierCurveTo() {}, roundRect() {}, drawImage() {},
        setLineDash() {}, setTransform() {}, scale() {}, translate() {}, fillText() {}, strokeText() {},
        createLinearGradient: () => ({ addColorStop() {} }),
        createRadialGradient: () => ({ addColorStop() {} }),
        measureText: (s) => ({ width: String(s || '').length * 7 }),
      }),
      focus() {},
      closest: (sel) => (sel === '#' + id ? el : null),
      querySelectorAll: () => [],
      querySelector: () => null,
    };
    return attachBus(el);
  };

  const els = new Map();
  for (const [id, tag] of [
    ['projectGraphModal', 'div'],
    ['pgCanvasStage', 'div'],
    ['projectGraphCanvas', 'canvas'],
    ['pgClusterPills', 'div'],
    ['pgAlignLayersBtn', 'button'],
    ['pgInspFilename', 'div'],
    ['pgInspPath', 'div'],
    ['pgInspBadges', 'div'],
    ['pgInspMetrics', 'div'],
    ['pgInspTabs', 'div'],
    ['pgInspActions', 'div'],
    ['pgInspList', 'div'],
    ['pgHoverTooltip', 'div'],
    ['smartComposerInput', 'textarea'],
  ]) {
    els.set(id, makeEl(tag, id));
  }

  const doc = attachBus({
    body: makeEl('body', 'body'),
    documentElement: makeEl('html', 'html'),
    activeElement: null,
    getElementById: (id) => els.get(id) || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag) => makeEl(tag, ''),
  });

  const activeTimeouts = new Set();
  const safeSetTimeout = (fn, ms) => {
    const id = setTimeout(() => { activeTimeouts.delete(id); fn(); }, Math.min(Number(ms) || 0, 50));
    if (id && typeof id.unref === 'function') id.unref();
    activeTimeouts.add(id);
    return id;
  };
  const safeClearTimeout = (id) => { activeTimeouts.delete(id); clearTimeout(id); };

  const win = attachBus({
    location: { search: '', href: 'http://127.0.0.1:4242/' },
    innerWidth: 1400,
    innerHeight: 900,
    devicePixelRatio: 1,
    document: doc,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { clipboard: { writeText: async () => {} } },
    setTimeout: safeSetTimeout,
    clearTimeout: safeClearTimeout,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }),
    URLSearchParams,
    AbortController,
  });

  const ctx = vm.createContext({
    window: win,
    document: doc,
    navigator: win.navigator,
    localStorage: win.localStorage,
    location: win.location,
    fetch: win.fetch,
    setTimeout: safeSetTimeout,
    clearTimeout: safeClearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: win.requestAnimationFrame,
    cancelAnimationFrame: win.cancelAnimationFrame,
    URLSearchParams,
    AbortController,
    console,
    Math,
    Date,
    JSON,
    Map,
    Set,
    Array,
    Object,
    String,
    Number,
    Boolean,
    RegExp,
    Promise,
  });

  try {
    vm.runInContext(mainScriptMatch[1], ctx);
    const out = await vm.runInContext(`(async () => {
      pgState.open = true;
      pgState.width = 1200;
      pgState.height = 800;
      pgState.layoutMode = 'layered';
      pgBindCanvasEvents();

      const macroRaw = {
        ok: true,
        nodes: [
          { id: 'ui/view.mjs', label: 'view.mjs', clusterId: 'ui', inDeg: 0, outDeg: 1 },
          { id: 'core/progress/track.mjs', label: 'track.mjs', clusterId: 'core', inDeg: 1, outDeg: 1 },
          { id: 'core/hub.mjs', label: 'hub.mjs', clusterId: 'core', inDeg: 1, outDeg: 0 },
        ],
        edges: [
          { source: 'ui/view.mjs', target: 'core/progress/track.mjs', kind: 'import', weight: 2 },
          { source: 'core/progress/track.mjs', target: 'core/hub.mjs', kind: 'import', weight: 3 },
        ],
        clusters: [
          { id: 'ui', label: 'ui', size: 1 },
          { id: 'core', label: 'core', size: 2 },
        ],
      };
      pgState.rawGraphData = macroRaw;
      pgState.viewLevel = 'folders';
      pgHydrateSimulation(macroRaw);

      const entryCol = pgState.layeredColumns[0];
      const origColX = entryCol.x;
      const uiNode = pgState.nodeById.get('folder:ui');
      const origNodeX = uiNode.x;
      const firstHdr = pgState.layerHeaderRects.find((h) => h.tier === entryCol.tier);
      const canvas = document.getElementById('projectGraphCanvas');

      // 1) Drag layer header horizontally -> moves column and its node without toggling filter
      const startX = firstHdr.x + firstHdr.w * 0.5;
      const startY = firstHdr.y + firstHdr.h * 0.5;
      canvas.dispatchEvent({ type: 'pointerdown', button: 0, pointerType: 'mouse', pointerId: 51, clientX: startX, clientY: startY });
      canvas.dispatchEvent({ type: 'pointermove', pointerType: 'mouse', buttons: 1, pointerId: 51, clientX: startX - 150, clientY: startY });
      canvas.dispatchEvent({ type: 'pointerup', pointerType: 'mouse', pointerId: 51, clientX: startX - 150, clientY: startY });

      const colMovedDelta = entryCol.x - origColX;
      const nodeMovedWithCol = uiNode.x - origNodeX;
      const filterAfterHeaderDrag = pgState.activeLayerTier;

      // Undo & Redo column move
      pgUndoNodeMove();
      const colAfterUndo = entryCol.x;
      pgRedoNodeMove();
      const colAfterRedo = entryCol.x;

      // 2) Drag a single node far out of its column -> detaches; drag back -> reattaches
      const midNode = pgState.nodeById.get('folder:core/progress');
      const midOrigX = midNode._origX;
      const midOrigY = midNode._origY;
      const midSp = pgWorldToScreen(midNode.x, midNode.y);
      canvas.dispatchEvent({ type: 'pointerdown', button: 0, pointerType: 'mouse', pointerId: 52, clientX: midSp.x, clientY: midSp.y });
      canvas.dispatchEvent({ type: 'pointermove', pointerType: 'mouse', buttons: 1, pointerId: 52, clientX: midSp.x + 420, clientY: midSp.y + 80 });
      canvas.dispatchEvent({ type: 'pointerup', pointerType: 'mouse', pointerId: 52, clientX: midSp.x + 420, clientY: midSp.y + 80 });
      const detachedFar = Boolean(midNode._detachedFromLayer);

      const farSp = pgWorldToScreen(midNode.x, midNode.y);
      const backSp = pgWorldToScreen(pgState.layeredColumns[1].x, midOrigY);
      canvas.dispatchEvent({ type: 'pointerdown', button: 0, pointerType: 'mouse', pointerId: 53, clientX: farSp.x, clientY: farSp.y });
      canvas.dispatchEvent({ type: 'pointermove', pointerType: 'mouse', buttons: 1, pointerId: 53, clientX: backSp.x, clientY: backSp.y });
      canvas.dispatchEvent({ type: 'pointerup', pointerType: 'mouse', pointerId: 53, clientX: backSp.x, clientY: backSp.y });
      const reattachedNear = Boolean(midNode._detachedFromLayer);

      // Detach again, then test pgResetLayeredPositions + Undo
      midNode.x = midOrigX + 500;
      pgSyncNodeLayerDetachment(midNode);
      const detachedBeforeReset = Boolean(midNode._detachedFromLayer);
      const didReset = pgResetLayeredPositions();
      const colAfterReset = entryCol.x;
      const midAfterResetX = midNode.x;
      const detachedAfterReset = Boolean(midNode._detachedFromLayer);

      pgUndoNodeMove();
      const colAfterResetUndo = entryCol.x;
      const detachedAfterResetUndo = Boolean(midNode._detachedFromLayer);

      return {
        colMovedDelta,
        nodeMovedWithCol,
        filterAfterHeaderDrag,
        colAfterUndo,
        colAfterRedo,
        origColX,
        detachedFar,
        reattachedNear,
        detachedBeforeReset,
        didReset,
        colAfterReset,
        midAfterResetX,
        midOrigX,
        detachedAfterReset,
        colAfterResetUndo,
        detachedAfterResetUndo,
      };
    })()`, ctx);

    assert.ok(out.colMovedDelta < -50, 'Dragging layer header left must move column world X');
    assert.ok(Math.abs(out.colMovedDelta - out.nodeMovedWithCol) < 1e-6, 'Attached node must move identically with its column');
    assert.equal(out.filterAfterHeaderDrag, null, 'Dragging layer header must not toggle layer filter');
    assert.ok(Math.abs(out.colAfterUndo - out.origColX) < 1e-6, 'pgUndoNodeMove must revert dragged column');
    assert.ok(Math.abs(out.colAfterRedo - (out.origColX + out.colMovedDelta)) < 1e-6, 'pgRedoNodeMove must redo dragged column');
    assert.equal(out.detachedFar, true, 'Dragging node far outside column must detach it from layer frame');
    assert.equal(out.reattachedNear, false, 'Dragging node back into column must reattach it');
    assert.equal(out.detachedBeforeReset, true);
    assert.equal(out.didReset, true, 'pgResetLayeredPositions must align moved columns and nodes');
    assert.ok(Math.abs(out.colAfterReset - out.origColX) < 1e-6, 'Column must snap back to origX');
    assert.ok(Math.abs(out.midAfterResetX - out.midOrigX) < 1e-6, 'Node must snap back to _origX');
    assert.equal(out.detachedAfterReset, false, 'Reset must clear _detachedFromLayer');
    assert.ok(out.colAfterResetUndo < out.origColX - 50, 'Undo after reset must restore custom column position');
    assert.equal(out.detachedAfterResetUndo, true, 'Undo after reset must restore detached state');
  } finally {
    try {
      vm.runInContext(`if (typeof telemetryPollTimer !== 'undefined' && telemetryPollTimer) { clearTimeout(telemetryPollTimer); telemetryPollTimer = null; }`, ctx);
    } catch {}
    for (const id of Array.from(activeTimeouts)) safeClearTimeout(id);
  }
});

test('30. Fragile file "Карта" deep-link: open-window focus param, path sanitization, auto includeTests & standalone focus selection', async () => {
  const tmpWs = makeTmpDir('tunnel-pg-focus-ws-');
  const tmpPanelDir = makeTmpDir('tunnel-pg-focus-panel-');
  const prevIsolate = process.env.TUNNEL_TEST_ISOLATE_INSTALLED;
  const prevStatePath = process.env.TUNNEL_TEST_STATE_PATH;
  const prevCacheDir = process.env.TUNNEL_CACHE_DIR;

  fs.mkdirSync(path.join(tmpWs, 'core'), { recursive: true });
  fs.mkdirSync(path.join(tmpWs, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(tmpWs, 'core', 'auto-verifier.mjs'), 'export function verifyAll() { return true; }\n', 'utf8');
  fs.writeFileSync(
    path.join(tmpWs, 'tests', 'router-core.test.mjs'),
    "import { verifyAll } from '../core/auto-verifier.mjs';\nverifyAll();\n",
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
  process.env.TUNNEL_CACHE_DIR = path.join(tmpPanelDir, 'cache');

  const panelApp = await startSidecarPanel({ SidecarAppClass: MiniSidecarApp });
  try {
    const openWindowHandler = panelApp._routes.get('/api/project-graph/open-window')?.get('POST');
    assert.equal(typeof openWindowHandler, 'function', '/api/project-graph/open-window POST route must exist');
    const mockReq = { headers: { host: '127.0.0.1:41234', origin: 'http://127.0.0.1:41234', 'x-router-panel': 'antigravity-v38', 'x-sidecar-token': 'tok123' } };

    // 1. /api/project-graph/open-window forwards sanitized focus param
    const okJson = await openWindowHandler({ rootDir: tmpWs, focus: '.\\core\\auto-verifier.mjs', dryRun: true }, mockReq);
    assert.equal(okJson.ok, true);
    const okUrl = new URL(okJson.url);
    assert.equal(okUrl.searchParams.get('view'), 'graph');
    assert.equal(okUrl.searchParams.get('focus'), 'core/auto-verifier.mjs');

    // 2. /api/project-graph/open-window strips path traversal & schemes
    const badJson = await openWindowHandler({ rootDir: tmpWs, focus: '../secrets.env', dryRun: true }, mockReq);
    assert.equal(badJson.ok, true);
    assert.equal(new URL(badJson.url).searchParams.get('focus'), null, 'Path traversal focus must be stripped');

    const schemeJson = await openWindowHandler({ rootDir: tmpWs, focus: 'javascript:alert(1)', dryRun: true }, mockReq);
    assert.equal(schemeJson.ok, true);
    assert.equal(new URL(schemeJson.url).searchParams.get('focus'), null, 'Scheme focus must be stripped');
  } finally {
    if (prevIsolate === undefined) delete process.env.TUNNEL_TEST_ISOLATE_INSTALLED;
    else process.env.TUNNEL_TEST_ISOLATE_INSTALLED = prevIsolate;
    if (prevStatePath === undefined) delete process.env.TUNNEL_TEST_STATE_PATH;
    else process.env.TUNNEL_TEST_STATE_PATH = prevStatePath;
    if (prevCacheDir === undefined) delete process.env.TUNNEL_CACHE_DIR;
    else process.env.TUNNEL_CACHE_DIR = prevCacheDir;
  }

  // 3. Standalone boot with ?view=graph&focus=tests/router-core.test.mjs auto-enables tests, focuses & selects the file
  const uiHtml = fs.readFileSync(path.join(ROOT_DIR, 'sidecars', 'panel', 'ui.html'), 'utf8');
  const scriptMatches = [...uiHtml.matchAll(/<script>([\s\S]*?)<\/script>/gi)];
  const mainScriptMatch = scriptMatches.find((m) => m[1].includes('pgInitStandaloneIfNeeded'));
  assert.ok(mainScriptMatch);

  const makeClassList = () => {
    const set = new Set();
    return {
      add: (...cls) => cls.filter(Boolean).forEach((c) => set.add(c)),
      remove: (...cls) => cls.forEach((c) => set.delete(c)),
      toggle: (c, force) => {
        if (force === true) { set.add(c); return true; }
        if (force === false) { set.delete(c); return false; }
        if (set.has(c)) { set.delete(c); return false; }
        set.add(c); return true;
      },
      contains: (c) => set.has(c),
    };
  };
  const makeEl = (tag = 'div', id = '') => {
    const attrs = new Map();
    const el = {
      tagName: String(tag).toUpperCase(),
      id,
      className: '',
      classList: makeClassList(),
      style: {},
      dataset: {},
      children: [],
      textContent: '',
      innerHTML: '',
      value: '',
      checked: false,
      disabled: false,
      width: 960,
      height: 640,
      clientWidth: 960,
      clientHeight: 640,
      scrollHeight: 640,
      scrollTop: 0,
      title: '',
      parentElement: null,
      addEventListener() {},
      removeEventListener() {},
      setAttribute(k, v) { attrs.set(k, String(v)); },
      getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
      removeAttribute(k) { attrs.delete(k); },
      appendChild(c) { if (c) { c.parentElement = el; el.children.push(c); } return c; },
      removeChild(c) { return c; },
      focus() {},
      blur() {},
      click() {},
      closest() { return null; },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      getBoundingClientRect() { return { left: 0, top: 0, width: 960, height: 640, right: 960, bottom: 640 }; },
      getContext() {
        return {
          setTransform() {}, clearRect() {}, save() {}, restore() {}, translate() {}, scale() {},
          beginPath() {}, moveTo() {}, lineTo() {}, quadraticCurveTo() {}, bezierCurveTo() {}, arc() {}, rect() {},
          roundRect() {}, closePath() {}, clip() {}, fill() {}, stroke() {}, fillRect() {}, strokeRect() {},
          fillText() {}, measureText(t) { return { width: String(t || '').length * 6 }; }, setLineDash() {},
          createLinearGradient: () => ({ addColorStop() {} }),
          createRadialGradient: () => ({ addColorStop() {} }),
        };
      },
    };
    return el;
  };

  const elements = new Map();
  const getOrCreateEl = (id, tag = 'div') => {
    if (!elements.has(id)) elements.set(id, makeEl(tag, id));
    return elements.get(id);
  };
  const bodyEl = makeEl('body');
  const doc = {
    body: bodyEl,
    documentElement: makeEl('html'),
    title: '',
    hidden: false,
    activeElement: null,
    getElementById: (id) => getOrCreateEl(id, (id === 'projectGraphCanvas' || id === 'pgCanvas') ? 'canvas' : 'div'),
    createElement: (tag) => makeEl(tag),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
  };

  const fetchedUrls = [];
  const openWindowPayloads = [];
  const fetchMock = async (url, init = {}) => {
    const u = String(url);
    fetchedUrls.push(u);
    if (u.startsWith('/api/project-graph/open-window')) {
      try { openWindowPayloads.push(JSON.parse(init?.body || '{}')); } catch {}
      return { ok: true, status: 200, json: async () => ({ ok: true, url: 'http://127.0.0.1:1234/?view=graph&focus=core%2Fauto-verifier.mjs' }) };
    }
    if (u.startsWith('/api/project-graph/workspaces')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, workspaces: [{ workspaceRoot: tmpWs, projectName: 'focus-test' }] }) };
    }
    if (u.startsWith('/api/project-graph')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          workspaceRoot: tmpWs,
          workspaceName: 'focus-test',
          focus: 'tests/router-core.test.mjs',
          totalFiles: 2,
          shownNodes: 2,
          shownEdges: 1,
          clusters: [
            { id: 'tests', label: 'tests', size: 1 },
            { id: 'core', label: 'core', size: 1 },
          ],
          nodes: [
            { id: 'tests/router-core.test.mjs', label: 'router-core.test.mjs', clusterId: 'tests', clusterLabel: 'tests', inDeg: 0, outDeg: 1, hop: 0, isTest: true, isFragile: true, reliabilityPercent: 30 },
            { id: 'core/auto-verifier.mjs', label: 'auto-verifier.mjs', clusterId: 'core', clusterLabel: 'core', inDeg: 1, outDeg: 0, hop: 1, isFragile: true, reliabilityPercent: 29 },
          ],
          edges: [{ source: 'tests/router-core.test.mjs', target: 'core/auto-verifier.mjs', kind: 'import' }],
          cycles: [],
          cycleNodeIds: [],
          cycleEdgeKeys: [],
          orphanIds: [],
          testFilesByTarget: { 'core/auto-verifier.mjs': ['tests/router-core.test.mjs'] },
        }),
      };
    }
    if (u.startsWith('/api/state')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, state: { uiLanguage: 'ru', panelTheme: 'glass_teal' } }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };

  const windowObj = {
    location: {
      search: `?view=graph&rootDir=${encodeURIComponent(tmpWs)}&focus=${encodeURIComponent('tests/router-core.test.mjs')}&token=tok123`,
      origin: 'http://127.0.0.1:41234',
      href: `http://127.0.0.1:41234/?view=graph&rootDir=${encodeURIComponent(tmpWs)}&focus=${encodeURIComponent('tests/router-core.test.mjs')}&token=tok123`,
    },
    history: { replaceState() {} },
    sidecar: { token: 'tok123', rpc() { return Promise.resolve({}); } },
    devicePixelRatio: 1,
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame: () => 0,
    cancelAnimationFrame() {},
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    ResizeObserver: class { observe() {} disconnect() {} },
    IntersectionObserver: class { observe() {} disconnect() {} },
    localStorage: { _m: new Map(), getItem(k) { return this._m.get(k) ?? null; }, setItem(k, v) { this._m.set(k, String(v)); }, removeItem(k) { this._m.delete(k); } },
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: fetchMock,
    URLSearchParams,
    URL,
  };
  windowObj.window = windowObj;
  windowObj.self = windowObj;
  windowObj.document = doc;

  const ctx = vm.createContext({
    window: windowObj,
    self: windowObj,
    globalThis: windowObj,
    document: doc,
    navigator: windowObj.navigator,
    localStorage: windowObj.localStorage,
    URLSearchParams,
    URL,
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
    Promise, Set, Map, WeakMap, Array, Object, String, Number, Boolean, Math, Date, JSON, RegExp, Error,
    encodeURIComponent, decodeURIComponent,
  });

  vm.runInContext(mainScriptMatch[1], ctx, { filename: 'sidecars/panel/ui.html' });
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setImmediate(r));
    if (vm.runInContext('pgState.nodes.length', ctx) > 0) break;
  }

  const graphFetch = fetchedUrls.find((u) => u.startsWith('/api/project-graph?'));
  assert.ok(graphFetch, 'Standalone focus boot must fetch /api/project-graph');
  const graphQs = new URLSearchParams(graphFetch.split('?')[1] || '');
  assert.equal(graphQs.get('focus'), 'tests/router-core.test.mjs', 'Must request focused file from API');
  assert.equal(graphQs.get('includeTests'), '1', 'Must auto-enable includeTests when focus file is a test');

  const focusCheck = vm.runInContext(`(() => {
    const fn = pgState.nodeById.get('tests/router-core.test.mjs');
    return {
      mode: pgState.mode,
      viewLevel: pgState.viewLevel,
      focusFile: pgState.focusFile,
      selectedNodeId: pgState.selectedNodeId,
      includeTests: pgState.includeTests,
      nodesCount: pgState.nodes.length,
      camX: pgState.camX,
      camY: pgState.camY,
      nodeX: fn ? fn.x : null,
      nodeY: fn ? fn.y : null,
      emptySub: document.getElementById('pgEmptySub').textContent,
    };
  })()`, ctx);
  assert.equal(focusCheck.mode, 'local');
  assert.equal(focusCheck.viewLevel, 'files');
  assert.equal(focusCheck.focusFile, 'tests/router-core.test.mjs');
  assert.equal(focusCheck.selectedNodeId, 'tests/router-core.test.mjs');
  assert.equal(focusCheck.includeTests, true);
  assert.equal(focusCheck.nodesCount, 2, `Expected 2 hydrated nodes (emptySub=${focusCheck.emptySub})`);
  assert.equal(focusCheck.camX, focusCheck.nodeX, `Camera X must center on focused fragile file (emptySub=${focusCheck.emptySub})`);
  assert.equal(focusCheck.camY, focusCheck.nodeY, 'Camera Y must center on focused fragile file');

  // 4. openFragileInGraph in non-standalone panel opens inline extension map (no external browser),
  //    while explicit externalWindow:true still forwards focus to /api/project-graph/open-window
  windowObj.location.search = '?token=tok123';
  await vm.runInContext(`openFragileInGraph('core/auto-verifier.mjs')`, ctx);
  await new Promise((r) => setImmediate(r));
  assert.equal(openWindowPayloads.length, 0, 'openFragileInGraph must open inside extension without spawning external browser');
  assert.equal(vm.runInContext('pgState.focusFile', ctx), 'core/auto-verifier.mjs');
  await vm.runInContext(`openProjectGraphModal({ focusFile: 'core/auto-verifier.mjs', externalWindow: true })`, ctx);
  await new Promise((r) => setImmediate(r));
  assert.equal(openWindowPayloads.length, 1, 'Explicit externalWindow:true must still invoke /api/project-graph/open-window');
  assert.equal(openWindowPayloads[0].focus, 'core/auto-verifier.mjs');
});

test('30. Project Map "Open question in Smart Composer" works in standalone (server handoff + #pgStatusToast) and inline modal (auto-expand card)', async () => {
  const vm = await import('node:vm');
  const html = fs.readFileSync(path.join(ROOT_DIR, 'sidecars', 'panel', 'ui.html'), 'utf8');
  for (const marker of [
    'id="pgStatusToast"',
    'function pgDispatchToComposer(',
    'function applyExternalComposerHandoff(',
    'function insertIntoLocalSmartComposer(',
    '/api/composer/handoff',
  ]) {
    assert.ok(html.includes(marker), `Expected marker ${marker} in compiled ui.html`);
  }

  // 1) Server endpoint test: POST /api/composer/handoff -> exposed in GET /api/telemetry
  const tmpDir = makeTmpDir('amr-pg-handoff-');
  const prevState = process.env.TUNNEL_TEST_STATE_PATH;
  const prevIsolate = process.env.TUNNEL_TEST_ISOLATE_INSTALLED;
  process.env.TUNNEL_TEST_STATE_PATH = path.join(tmpDir, 'router-state.json');
  process.env.TUNNEL_TEST_ISOLATE_INSTALLED = '1';
  fs.writeFileSync(process.env.TUNNEL_TEST_STATE_PATH, JSON.stringify({ onboardingCompleted: true, uiLanguage: 'ru' }, null, 2));
  class MiniSidecarApp {
    constructor() { this._routes = new Map(); }
    page() {}
    api(p, handler, method = 'POST') {
      if (!this._routes.has(p)) this._routes.set(p, new Map());
      this._routes.get(p).set(method.toUpperCase(), handler);
    }
    run() { return http.createServer(); }
  }
  try {
    const app = await startSidecarPanel({ SidecarAppClass: MiniSidecarApp });
    const handoffHandler = app._routes.get('/api/composer/handoff')?.get('POST');
    const telemetryHandler = app._routes.get('/api/telemetry')?.get('GET');
    assert.equal(typeof handoffHandler, 'function', 'POST /api/composer/handoff must be registered');
    assert.equal(typeof telemetryHandler, 'function', 'GET /api/telemetry must be registered');

    const postReq = { method: 'POST', headers: { host: '127.0.0.1:4555', origin: 'http://127.0.0.1:4555', 'x-router-panel': 'antigravity-v38' } };
    const postRes = await handoffHandler({
      tokens: ['@file:core/tool-pruner.mjs'],
      prompt: 'Проанализируй core/tool-pruner.mjs',
      text: '@file:core/tool-pruner.mjs Проанализируй core/tool-pruner.mjs',
    }, postReq);
    assert.equal(postRes.ok, true);
    assert.ok(postRes.seq >= 1);

    const telRes = await telemetryHandler({ rootDir: tmpDir }, { method: 'GET', headers: { host: '127.0.0.1:4555' } });
    assert.ok(telRes.composerHandoff, '/api/telemetry must expose active composerHandoff');
    assert.equal(telRes.composerHandoff.seq, postRes.seq);
    assert.deepEqual(telRes.composerHandoff.tokens, ['@file:core/tool-pruner.mjs']);
  } finally {
    if (prevState === undefined) delete process.env.TUNNEL_TEST_STATE_PATH;
    else process.env.TUNNEL_TEST_STATE_PATH = prevState;
    if (prevIsolate === undefined) delete process.env.TUNNEL_TEST_ISOLATE_INSTALLED;
    else process.env.TUNNEL_TEST_ISOLATE_INSTALLED = prevIsolate;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // 2) UI VM test: standalone click -> POST /api/composer/handoff + #pgStatusToast visible; main panel consumes handoff & expands collapsed card
  const mainScriptMatch = html.match(/<script>\s*([\s\S]*?)\s*<\/script>\s*<\/body>/i);
  assert.ok(mainScriptMatch);

  const elements = new Map();
  const makeClassList = () => {
    const set = new Set();
    return {
      add: (c) => set.add(c),
      remove: (c) => set.delete(c),
      toggle: (c, force) => (force === true ? (set.add(c), true) : force === false ? (set.delete(c), false) : (set.has(c) ? (set.delete(c), false) : (set.add(c), true))),
      contains: (c) => set.has(c),
    };
  };
  const makeEl = (id = '') => ({
    id,
    value: '',
    textContent: '',
    innerHTML: '',
    hidden: false,
    children: [],
    style: {},
    classList: makeClassList(),
    focused: false,
    scrolled: false,
    focus() { this.focused = true; },
    scrollIntoView() { this.scrolled = true; },
    setAttribute() {},
    getAttribute() { return null; },
    addEventListener() {},
    removeEventListener() {},
    appendChild() {},
    insertBefore() {},
    remove() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
  });
  const getEl = (id) => {
    if (!elements.has(id)) elements.set(id, makeEl(id));
    return elements.get(id);
  };
  getEl('pgStatusToast').hidden = true;
  const smartCard = getEl('smartComposerCard');
  smartCard.classList.add('is-collapsed');

  const handoffPosts = [];
  const copiedTexts = [];
  const fetchMock = async (url, opts = {}) => {
    const u = String(url);
    if (u.startsWith('/api/composer/handoff')) {
      const body = JSON.parse(opts.body || '{}');
      handoffPosts.push(body);
      return { ok: true, status: 200, json: async () => ({ ok: true, seq: handoffPosts.length }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };

  const doc = {
    body: { classList: makeClassList(), getAttribute: () => 'full', setAttribute() {} },
    documentElement: { style: { setProperty() {} } },
    visibilityState: 'visible',
    getElementById: (id) => getEl(id),
    createElement: (tag) => makeEl(tag),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
  };
  doc.body.classList.add('pg-standalone');

  const windowObj = {
    innerWidth: 1280,
    innerHeight: 800,
    location: { search: '?view=graph&token=tok1' },
    fetch: fetchMock,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { clipboard: { writeText: async (t) => { copiedTexts.push(t); } } },
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame: () => 0,
    cancelAnimationFrame() {},
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

  // Standalone: trigger context menu 'ai:composer'
  await vm.runInContext(`(async () => {
    const node = { id: 'core/tool-pruner.mjs', label: 'tool-pruner.mjs', isFolder: false, isSymbol: false };
    pgState.nodeById.set(node.id, node);
    pgState.selectedNodeId = node.id;
    pgState.ctxMenuNodeId = node.id;
    pgRunNodeContextAction('ai:composer');
  })()`, ctx);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  assert.equal(handoffPosts.length, 1, 'Standalone ai:composer must POST to /api/composer/handoff');
  assert.deepEqual(handoffPosts[0].tokens, ['@file:core/tool-pruner.mjs']);
  assert.ok(handoffPosts[0].prompt.includes('core/tool-pruner.mjs'));
  assert.equal(copiedTexts.length, 1, 'Standalone ai:composer must also copy fallback text to clipboard');
  assert.equal(getEl('pgStatusToast').hidden, false, 'Standalone ai:composer must show visible #pgStatusToast');
  assert.ok(getEl('pgStatusToast').textContent.length > 0);

  // Main panel: switch out of standalone and consume handoff -> expands card & populates #smartComposerInput
  windowObj.location.search = '?token=tok1';
  doc.body.classList.remove('pg-standalone');
  const consumed1 = vm.runInContext(`applyExternalComposerHandoff({ seq: 1, tokens: ['@file:core/tool-pruner.mjs'], prompt: 'Проанализируй core/tool-pruner.mjs' })`, ctx);
  const consumedDup = vm.runInContext(`applyExternalComposerHandoff({ seq: 1, tokens: ['@file:core/tool-pruner.mjs'], prompt: 'Проанализируй core/tool-pruner.mjs' })`, ctx);
  assert.equal(consumed1, true, 'Main panel must consume new composerHandoff');
  assert.equal(consumedDup, false, 'Main panel must ignore already-consumed seq');
  assert.equal(smartCard.classList.contains('is-collapsed'), false, 'Collapsed Smart Composer card must auto-expand');
  assert.ok(getEl('smartComposerInput').value.includes('@file:core/tool-pruner.mjs'));
  assert.ok(getEl('smartComposerInput').value.includes('Проанализируй core/tool-pruner.mjs'));
  assert.equal(getEl('smartComposerInput').focused, true);
});

test('31. Project Map RMB Ask AI flyout submenus: edge flip-left & chat:* dispatches new temporary chat', async () => {
  const vm = await import('node:vm');
  buildPanelUi({ repoRoot: ROOT_DIR });
  const html = fs.readFileSync(path.join(ROOT_DIR, 'sidecars', 'panel', 'ui.html'), 'utf8');
  for (const marker of [
    'data-ctx-submenu="',
    "renderSubmenu('llm'",
    "renderSubmenu('chat'",
    'pg-ctx-flip-left',
    'async function pgAskInNewProjectChat(',
  ]) {
    assert.ok(html.includes(marker), `Expected marker ${marker} in compiled ui.html`);
  }

  const mainScriptMatch = html.match(/<script>\s*([\s\S]*?)\s*<\/script>\s*<\/body>/i);
  assert.ok(mainScriptMatch, 'Main script block must exist in ui.html');

  const chatPosts = [];
  const fetchMock = async (url, opts = {}) => {
    const u = String(url || '');
    if (u.includes('/api/chat-send')) {
      const body = opts.body ? JSON.parse(opts.body) : {};
      chatPosts.push(body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, mode: 'new_conversation', conversationId: 'temp-chat-42' }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };

  const makeClassList = () => {
    const set = new Set();
    return {
      add: (...cs) => cs.forEach((c) => set.add(c)),
      remove: (...cs) => cs.forEach((c) => set.delete(c)),
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

  const attachBus = (obj) => {
    const map = new Map();
    obj.addEventListener = (type, fn) => {
      if (!map.has(type)) map.set(type, new Set());
      map.get(type).add(fn);
    };
    obj.removeEventListener = (type, fn) => {
      if (map.has(type)) map.get(type).delete(fn);
    };
    obj.dispatchEvent = (ev) => {
      const listeners = map.get(ev.type);
      if (!listeners) return;
      for (const fn of Array.from(listeners)) fn(ev);
    };
    return obj;
  };

  const els = new Map();
  const getEl = (id) => {
    if (!els.has(id)) {
      const attrs = new Map();
      const el = attachBus({
        id,
        tagName: id === 'projectGraphCanvas' ? 'CANVAS' : 'DIV',
        hidden: id === 'pgNodeContextMenu' || id === 'pgAskAiMenu',
        classList: makeClassList(),
        style: { display: '', left: '', top: '', setProperty() {}, removeProperty() {} },
        dataset: {},
        value: '',
        textContent: '',
        innerHTML: '',
        clientWidth: 1000,
        clientHeight: 700,
        offsetWidth: 256,
        offsetHeight: 340,
        setAttribute: (k, v) => attrs.set(String(k), String(v)),
        getAttribute: (k) => (attrs.has(String(k)) ? attrs.get(String(k)) : null),
        removeAttribute: (k) => attrs.delete(String(k)),
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 700 }),
        getContext: () => ({
          save() {}, restore() {}, clearRect() {}, fillRect() {}, strokeRect() {}, beginPath() {}, closePath() {},
          arc() {}, rect() {}, clip() {}, fill() {}, stroke() {}, moveTo() {}, lineTo() {}, quadraticCurveTo() {},
          bezierCurveTo() {}, roundRect() {}, drawImage() {}, setLineDash() {}, setTransform() {}, scale() {},
          translate() {}, fillText() {}, strokeText() {}, measureText: () => ({ width: 20 }),
          createLinearGradient: () => ({ addColorStop() {} }),
          createRadialGradient: () => ({ addColorStop() {} }),
        }),
        focus() {},
        closest: (sel) => (sel === '#' + id ? el : null),
        querySelectorAll: () => [],
        querySelector: () => null,
      });
      els.set(id, el);
    }
    return els.get(id);
  };

  for (const id of [
    'projectGraphModal', 'pgCanvasStage', 'projectGraphCanvas', 'pgNodeContextMenu',
    'pgAskAiMenu', 'pgActionAskAiBtn', 'pgAiChatBox', 'pgStatusToast',
  ]) {
    getEl(id);
  }

  const doc = attachBus({
    body: getEl('body'),
    documentElement: getEl('html'),
    activeElement: null,
    getElementById: (id) => (els.has(id) ? els.get(id) : getEl(id)),
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag) => getEl('tmp_' + tag),
  });

  const activeTimers = new Set();
  const safeSetTimeout = (fn, ms) => {
    const id = setTimeout(() => { activeTimers.delete(id); fn(); }, Math.min(Number(ms) || 0, 50));
    if (id && typeof id.unref === 'function') id.unref();
    activeTimers.add(id);
    return id;
  };
  const safeClearTimeout = (id) => { activeTimers.delete(id); clearTimeout(id); };

  const win = attachBus({
    location: { search: '?token=tok1', href: 'http://127.0.0.1:4242/?token=tok1' },
    innerWidth: 1200,
    innerHeight: 800,
    devicePixelRatio: 1,
    document: doc,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { clipboard: { writeText: async () => {} } },
    sidecar: {
      conversationId: 'existing-active-chat',
      agent: {
        getWorkspaceUris: async () => ['file:///D:/MyOpenProject'],
        sendMessage: async () => {},
        startConversation: async () => ({ conversationId: 'temp-chat-42' }),
      },
    },
    setTimeout: safeSetTimeout,
    clearTimeout: safeClearTimeout,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    fetch: fetchMock,
    URLSearchParams,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });

  const ctx = vm.createContext({
    window: win,
    document: doc,
    localStorage: win.localStorage,
    navigator: win.navigator,
    location: win.location,
    CSS: { escape: (s) => String(s) },
    URL,
    URLSearchParams,
    AbortController,
    performance,
    Event: class { constructor(type) { this.type = type; } },
    CustomEvent: class { constructor(type, opts = {}) { this.type = type; this.detail = opts.detail; } },
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    setTimeout: safeSetTimeout,
    clearTimeout: safeClearTimeout,
    setInterval: () => 0,
    clearInterval() {},
    fetch: fetchMock,
    console,
    Promise, Set, Map, WeakMap, Array, Object, String, Number, Boolean, Math, Date, JSON, RegExp, Error,
    encodeURIComponent, decodeURIComponent,
  });

  try {
    vm.runInContext(mainScriptMatch[1], ctx, { filename: 'sidecars/panel/ui.html' });

    const out = await vm.runInContext(`(async () => {
      const node = { id: 'core/a.mjs', label: 'a.mjs', isFolder: false, isSymbol: false, lines: 50, inDeg: 1, outDeg: 1 };
      pgState.open = true;
      pgState.autoWorkspace = 'D:/MyOpenProject';
      pgState.nodes = [node];
      pgState.nodeById = new Map([['core/a.mjs', node]]);
      pgState.inNeighbors = new Map([['core/a.mjs', []]]);
      pgState.outNeighbors = new Map([['core/a.mjs', []]]);

      pgOpenNodeContextMenu(node, 920, 620);
      const menu = document.getElementById('pgNodeContextMenu');
      const flipLeft = menu.classList.contains('pg-ctx-flip-left');
      const flipUp = menu.classList.contains('pg-ctx-flip-up');
      const menuHtml = menu.innerHTML;

      await pgRunNodeContextAction('chat:explain');
      return { flipLeft, flipUp, menuHtml };
    })()`, ctx);

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    assert.equal(out.flipLeft, true, 'Menu near right edge must activate pg-ctx-flip-left');
    assert.equal(out.flipUp, true, 'Menu near bottom edge must activate pg-ctx-flip-up');
    assert.ok(out.menuHtml.includes('data-ctx-submenu="llm"'));
    assert.ok(out.menuHtml.includes('data-ctx-submenu="chat"'));

    assert.equal(chatPosts.length, 1, 'chat:explain must POST once to /api/chat-send');
    assert.equal(chatPosts[0].conversationId, '', 'Temporary project chat must NOT reuse active conversationId');
    assert.equal(chatPosts[0].allowNewConversation, true, 'Temporary project chat must allow new conversation creation');
    assert.equal(chatPosts[0].rootDir, 'D:/MyOpenProject', 'Temporary project chat must pass effective project rootDir');
    assert.ok(chatPosts[0].message.includes('@file:core/a.mjs'), 'Prompt must attach @file:<targetFile>');
    assert.ok(chatPosts[0].message.includes('core/a.mjs'), 'Prompt must reference target file');
  } finally {
    try {
      vm.runInContext(`if (typeof telemetryPollTimer !== 'undefined' && telemetryPollTimer) { clearTimeout(telemetryPollTimer); telemetryPollTimer = null; }`, ctx);
    } catch {}
    for (const id of Array.from(activeTimers)) {
      safeClearTimeout(id);
    }
  }
});

test('32. Project Map preserves Russian language via open-window ?lang=, GET /api/state?sections=core, focus sync & setUiLanguage', async () => {
  const uiHtml = fs.readFileSync(path.join(ROOT_DIR, 'sidecars', 'panel', 'ui.html'), 'utf8');
  const scriptMatches = [...uiHtml.matchAll(/<script>([\s\S]*?)<\/script>/gi)];
  const mainScriptMatch = scriptMatches.find((m) => m[1].includes('pgSyncStandaloneThemeAndLang'));
  assert.ok(mainScriptMatch, 'Compiled ui.html script containing pgSyncStandaloneThemeAndLang must exist');

  // Verify server open-window embeds lang= in standalone URL
  const tmpWs = makeTmpDir('tunnel-pg-lang-ws-');
  const statePath = path.join(tmpWs, 'router-state.json');
  fs.writeFileSync(statePath, JSON.stringify({ uiLanguage: 'ru', onboardingCompleted: true }, null, 2), 'utf8');
  const prevIso = process.env.TUNNEL_TEST_ISOLATE_INSTALLED;
  const prevStatePath = process.env.TUNNEL_TEST_STATE_PATH;
  process.env.TUNNEL_TEST_ISOLATE_INSTALLED = '1';
  process.env.TUNNEL_TEST_STATE_PATH = statePath;
  try {
    class MiniApp {
      constructor() { this._routes = new Map(); }
      page() {}
      api(p, fn, m = 'GET') {
        if (!this._routes.has(p)) this._routes.set(p, new Map());
        this._routes.get(p).set(m.toUpperCase(), fn);
      }
      run() { return Promise.resolve(); }
      close() {}
    }
    const app = await startSidecarPanel({ SidecarAppClass: MiniApp });
    try {
      const openWin = app._routes.get('/api/project-graph/open-window')?.get('POST');
      const winRes = await openWin(
        { rootDir: tmpWs, dryRun: true },
        { method: 'POST', headers: { host: '127.0.0.1:41234', origin: 'http://127.0.0.1:41234', 'x-router-panel': 'antigravity-v38' } }
      );
      assert.equal(winRes.ok, true);
      const u = new URL(winRes.url);
      assert.equal(u.searchParams.get('lang'), 'ru', 'open-window URL must include lang=ru');
    } finally {
      app.close();
    }
  } finally {
    if (prevIso === undefined) delete process.env.TUNNEL_TEST_ISOLATE_INSTALLED;
    else process.env.TUNNEL_TEST_ISOLATE_INSTALLED = prevIso;
    if (prevStatePath === undefined) delete process.env.TUNNEL_TEST_STATE_PATH;
    else process.env.TUNNEL_TEST_STATE_PATH = prevStatePath;
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }

  // Verify standalone sync uses GET /api/state?sections=core and re-renders inspector & title in Russian
  let serverLang = 'en';
  const fetched = [];
  const makeClassList = () => {
    const set = new Set();
    return {
      add: (...c) => c.filter(Boolean).forEach((x) => set.add(x)),
      remove: (...c) => c.forEach((x) => set.delete(x)),
      toggle: (c, f) => (f === true ? (set.add(c), true) : f === false ? (set.delete(c), false) : (set.has(c) ? (set.delete(c), false) : (set.add(c), true))),
      contains: (c) => set.has(c),
    };
  };
  const els = new Map();
  const makeEl = (id, text = '') => {
    const attrs = new Map();
    const el = {
      id,
      tagName: 'DIV',
      nodeType: 1,
      classList: makeClassList(),
      style: { setProperty() {}, removeProperty() {} },
      dataset: {},
      textContent: text,
      innerHTML: '',
      childNodes: [],
      children: [],
      setAttribute: (k, v) => attrs.set(k, String(v)),
      getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
      removeAttribute: (k) => attrs.delete(k),
      getBoundingClientRect: () => ({ width: 900, height: 600, left: 0, top: 0 }),
      getContext: () => null,
      closest: () => null,
      querySelectorAll: () => [],
      querySelector: () => null,
      appendChild: (c) => c,
      addEventListener() {},
    };
    els.set(id, el);
    return el;
  };
  for (const id of [
    'projectGraphModal', 'projectGraphCanvas', 'pgCanvasStage', 'pgStatsPill', 'pgProjectBadge',
    'pgWorkspaceSelect', 'pgInspFilename', 'pgInspPath', 'pgInspBadges', 'pgInspMetrics',
    'pgInspTabs', 'pgInspLensPanel', 'pgInspList', 'pgInspActions', 'pgContextCart', 'pgCartSummary',
    'pgClusterPills', 'pgLegendExtra', 'pgModalTitle',
  ]) {
    makeEl(id);
  }
  const bodyEl = makeEl('body');
  const docEl = { setAttribute: (k, v) => bodyEl.setAttribute('doc-' + k, v) };
  const docListeners = new Map();
  const winListeners = new Map();
  const doc = {
    body: bodyEl,
    documentElement: docEl,
    title: '',
    visibilityState: 'visible',
    getElementById: (id) => els.get(id) || null,
    querySelectorAll: () => [],
    querySelector: () => null,
    createElement: (tag) => makeEl('dyn-' + tag + '-' + els.size),
    addEventListener: (ev, fn) => {
      if (!docListeners.has(ev)) docListeners.set(ev, []);
      docListeners.get(ev).push(fn);
    },
  };
  const ctx = vm.createContext({
    window: {
      location: { search: '?view=graph&lang=ru&rootDir=C%3A%2Frepo', pathname: '/', hash: '' },
      history: { replaceState() {} },
      addEventListener: (ev, fn) => {
        if (!winListeners.has(ev)) winListeners.set(ev, []);
        winListeners.get(ev).push(fn);
      },
      removeEventListener() {},
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
      requestAnimationFrame: () => 0,
      cancelAnimationFrame() {},
      fetch: async (url, opts) => {
        const u = String(url || '');
        fetched.push({ url: u, method: (opts && opts.method) || 'GET' });
        if (u.startsWith('/api/state')) {
          return { ok: true, status: 200, json: async () => ({ ok: true, state: { uiLanguage: serverLang, panelUiScale: 'auto' } }) };
        }
        return { ok: true, status: 200, json: async () => ({ ok: true, clusters: [], nodes: [], edges: [] }) };
      },
    },
    document: doc,
    location: { search: '?view=graph&lang=ru&rootDir=C%3A%2Frepo' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { clipboard: { writeText: async () => {} } },
    CSS: { escape: (s) => String(s) },
    URL, URLSearchParams, AbortController, performance,
    ResizeObserver: class { observe() {} disconnect() {} },
    IntersectionObserver: class { observe() {} disconnect() {} },
    Event: class { constructor(t) { this.type = t; } },
    CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o?.detail; } },
    requestAnimationFrame: () => 0,
    cancelAnimationFrame() {},
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    console, Promise, Set, Map, WeakMap, Array, Object, String, Number, Boolean, Math, Date, JSON, RegExp, Error,
    encodeURIComponent, decodeURIComponent,
  });
  ctx.window.document = doc;
  ctx.fetch = ctx.window.fetch;
  vm.runInContext(mainScriptMatch[1], ctx, { filename: 'sidecars/panel/ui.html' });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  assert.ok(fetched.some((f) => f.url.startsWith('/api/state?sections=core') && f.method === 'GET'), 'Standalone sync must use GET /api/state?sections=core');
  // Simulate user switching language to Russian in panel settings and focusing standalone window
  serverLang = 'ru';
  for (const fn of (winListeners.get('focus') || [])) fn();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(doc.title, 'Карта проекта · The Tunnel', 'Focused standalone window must sync Russian title');
  assert.equal(vm.runInContext('getUiLanguage()', ctx), 'ru', 'currentUiLanguage must sync to ru on focus');
  assert.equal(els.get('pgInspFilename').textContent, 'Выберите узел на карте', 'Inspector must re-render in Russian after focus sync');
});

test('33. Native Antigravity /graph extension views in sidecar.json, server.mjs route & pathname standalone detection', async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'sidecars', 'panel', 'sidecar.json'), 'utf8'));
  const views = manifest?.ui_config?.views || [];
  assert.equal(
    views.some((v) => v.path === '/graph'),
    false,
    'sidecar.json must not expose separate /graph sidebar/aux-pane entries (opened via The Tunnel button)'
  );

  const pages = new Map();
  class MockApp {
    page(p, fn) { pages.set(p, fn); }
    api() {}
    async run() { return null; }
  }
  await startSidecarPanel({ SidecarAppClass: MockApp });
  assert.equal(typeof pages.get('/graph'), 'function', 'server.mjs must register /graph page route');
  const graphResp = pages.get('/graph')();
  assert.ok(String(graphResp?.body || '').includes('projectGraphModal'), '/graph must serve compiled panel ui.html');
  assert.equal(typeof pages.get('/graph-icon.svg'), 'function', 'server.mjs must register /graph-icon.svg route');
  const iconResp = pages.get('/graph-icon.svg')();
  assert.ok(String(iconResp?.contentType || '').includes('image/svg+xml'), '/graph-icon.svg must serve image/svg+xml');
  assert.ok(String(iconResp?.body || '').includes('#f04848'), '/graph-icon.svg must contain crimson button graph icon');

  buildPanelUi({ repoRoot: ROOT_DIR });
  const html = fs.readFileSync(path.join(ROOT_DIR, 'sidecars', 'panel', 'ui.html'), 'utf8');
  assert.ok(html.includes("if (pathname === '/graph') return true;"), 'Compiled ui.html must detect /graph pathname as standalone graph view');
  assert.ok(html.includes('opts && opts.externalWindow === true'), 'openProjectGraphModal must open inside extension by default without spawning external browser');
  assert.ok(html.includes("fav.href = '/graph-icon.svg';"), 'Standalone /graph view must set /graph-icon.svg favicon');
  assert.ok(html.includes("const errDetail = lastErr ? (' (' + lastErr.slice(0, 120) + ')') : '';"), 'Clipboard fallback toast must include diagnostic lastErr detail');
});

test('34. Inline .pg-overlay fills viewport with 12px inset without 1040x680 size caps', () => {
  buildPanelUi({ repoRoot: ROOT_DIR });
  const css = fs.readFileSync(path.join(ROOT_DIR, 'sidecars', 'panel', 'ui-src', 'styles.css'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT_DIR, 'sidecars', 'panel', 'ui.html'), 'utf8');
  const overlayMatch = css.match(/\.pg-overlay\s*\{[\s\S]*?\}/);
  assert.ok(overlayMatch, '.pg-overlay rule must exist in styles.css');
  const rule = overlayMatch[0];
  assert.ok(rule.includes('width: calc(100vw - 24px);'), '.pg-overlay must set width: calc(100vw - 24px)');
  assert.ok(rule.includes('height: calc(100dvh - 24px);'), '.pg-overlay must set height: calc(100dvh - 24px)');
  assert.ok(rule.includes('max-width: calc(100vw - 24px);'), '.pg-overlay must set max-width: calc(100vw - 24px)');
  assert.ok(!rule.includes('1040px') && !rule.includes('680px'), '.pg-overlay must not cap size to 1040x680');
  assert.ok(html.includes('width: calc(100vw - 24px);') && !html.includes('min(1040px, calc(100vw - 24px))'), 'Compiled ui.html must reflect full-viewport .pg-overlay');
});

test('35. Project Map chat & composer handoff attaches connected modules, folder files and risk flags', async () => {
  buildPanelUi({ repoRoot: ROOT_DIR });
  const html = fs.readFileSync(path.join(ROOT_DIR, 'sidecars', 'panel', 'ui.html'), 'utf8');
  assert.ok(html.includes('function pgBuildNodeRelationsContextBlock('), 'Compiled ui.html must include pgBuildNodeRelationsContextBlock');

  const mainScriptMatch = html.match(/<script>\s*([\s\S]*?)\s*<\/script>\s*<\/body>/i);
  assert.ok(mainScriptMatch, 'Main script block must exist in ui.html');

  const chatPosts = [];
  const composerCalls = [];
  const fetchMock = async (url, opts = {}) => {
    const u = String(url || '');
    if (u.includes('/api/chat-send')) {
      chatPosts.push(opts.body ? JSON.parse(opts.body) : {});
      return { ok: true, status: 200, json: async () => ({ ok: true, mode: 'new_conversation', conversationId: 'chat-rel-1' }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };

  const makeClassList = () => {
    const set = new Set();
    return {
      add: (...cs) => cs.forEach((c) => set.add(c)),
      remove: (...cs) => cs.forEach((c) => set.delete(c)),
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
  const attachBus = (obj) => {
    obj.addEventListener = () => {};
    obj.removeEventListener = () => {};
    obj.dispatchEvent = () => {};
    return obj;
  };
  const els = new Map();
  const getEl = (id) => {
    if (!els.has(id)) {
      const attrs = new Map();
      const el = attachBus({
        id,
        tagName: 'DIV',
        hidden: false,
        classList: makeClassList(),
        style: { display: '', setProperty() {}, removeProperty() {} },
        dataset: {},
        value: '',
        textContent: '',
        innerHTML: '',
        setAttribute: (k, v) => attrs.set(String(k), String(v)),
        getAttribute: (k) => (attrs.has(String(k)) ? attrs.get(String(k)) : null),
        removeAttribute: (k) => attrs.delete(String(k)),
        focus() {},
        closest: () => null,
        querySelectorAll: () => [],
        querySelector: () => null,
      });
      els.set(id, el);
    }
    return els.get(id);
  };
  const doc = attachBus({
    body: getEl('body'),
    documentElement: getEl('html'),
    activeElement: null,
    getElementById: (id) => getEl(id),
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag) => getEl('tmp_' + tag),
  });
  const activeTimers = new Set();
  const safeSetTimeout = (fn, ms) => {
    const id = setTimeout(() => { activeTimers.delete(id); fn(); }, Math.min(Number(ms) || 0, 50));
    if (id && typeof id.unref === 'function') id.unref();
    activeTimers.add(id);
    return id;
  };
  const safeClearTimeout = (id) => { activeTimers.delete(id); clearTimeout(id); };
  const win = attachBus({
    location: { search: '?token=tok1&lang=ru', href: 'http://127.0.0.1:4242/?token=tok1&lang=ru' },
    innerWidth: 1200,
    innerHeight: 800,
    devicePixelRatio: 1,
    document: doc,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { clipboard: { writeText: async () => {} } },
    sidecar: {
      conversationId: 'active-chat-1',
      agent: {
        getWorkspaceUris: async () => ['file:///D:/MyOpenProject'],
        sendMessage: async () => {},
        startConversation: async () => ({ conversationId: 'chat-rel-1' }),
      },
    },
    setTimeout: safeSetTimeout,
    clearTimeout: safeClearTimeout,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    fetch: fetchMock,
    URLSearchParams,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });

  const ctx = vm.createContext({
    window: win,
    document: doc,
    localStorage: win.localStorage,
    navigator: win.navigator,
    location: win.location,
    CSS: { escape: (s) => String(s) },
    URL,
    URLSearchParams,
    AbortController,
    performance,
    Event: class { constructor(type) { this.type = type; } },
    CustomEvent: class { constructor(type, opts = {}) { this.type = type; this.detail = opts.detail; } },
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    setTimeout: safeSetTimeout,
    clearTimeout: safeClearTimeout,
    setInterval: () => 0,
    clearInterval() {},
    fetch: fetchMock,
    console,
    Promise, Set, Map, WeakMap, Array, Object, String, Number, Boolean, Math, Date, JSON, RegExp, Error,
    encodeURIComponent, decodeURIComponent,
    __composerCalls: composerCalls,
  });

  try {
    vm.runInContext(mainScriptMatch[1], ctx, { filename: 'sidecars/panel/ui.html' });
    const res = await vm.runInContext(`(async () => {
      const fileNode = {
        id: 'core/ram-memory-engine.mjs',
        label: 'ram-memory-engine.mjs',
        isFolder: false,
        isSymbol: false,
        lines: 1200,
        inDeg: 8,
        outDeg: 2,
        isGod: true,
        isFragile: true,
        reliabilityPercent: 78,
        clusterLabel: 'core',
      };
      const folderNode = {
        id: 'folder:core/gpu',
        label: 'core/gpu',
        isFolder: true,
        isSymbol: false,
        topHubFile: 'core/gpu/gpu-vram-runtime.mjs',
        fileIds: ['core/gpu/gpu-vram-runtime.mjs', 'core/gpu/gpu-embedder.mjs', 'core/gpu/gpu-distiller.mjs'],
        inDeg: 2,
        outDeg: 1,
      };
      const isolatedNode = { id: 'docs/notes.md', label: 'notes.md', isFolder: false, isSymbol: false, inDeg: 0, outDeg: 0 };

      pgState.open = true;
      pgState.autoWorkspace = 'D:/MyOpenProject';
      pgState.nodes = [fileNode, folderNode, isolatedNode];
      pgState.nodeById = new Map([
        [fileNode.id, fileNode],
        [folderNode.id, folderNode],
        [isolatedNode.id, isolatedNode],
      ]);
      pgState.inNeighbors = new Map([
        [fileNode.id, [
          { id: 'core/ram-memory-mcp.mjs' },
          { id: 'core/hook-runner.mjs' },
          { id: 'sidecars/panel/server.mjs' },
          { id: 'core/a.mjs' },
          { id: 'core/b.mjs' },
          { id: 'core/c.mjs' },
          { id: 'core/d.mjs' },
          { id: 'core/e.mjs' },
        ]],
        [folderNode.id, [{ id: 'folder:core' }, { id: 'sidecars/panel/server.mjs' }]],
        [isolatedNode.id, []],
      ]);
      pgState.outNeighbors = new Map([
        [fileNode.id, [{ id: 'core/repo-mapper.mjs' }, { id: 'core/security-guard.mjs' }]],
        [folderNode.id, [{ id: 'core/i18n.mjs' }]],
        [isolatedNode.id, []],
      ]);

      await pgAskInNewProjectChat('risks', fileNode);
      await pgAskInNewProjectChat('explain', folderNode);

      const origDispatch = pgDispatchToComposer;
      pgDispatchToComposer = function (opts) { __composerCalls.push(opts); };
      pgState.selectedNodeId = fileNode.id;
      pgSendAiToComposer('Проверь контракты');
      const firstComposerPrompt = __composerCalls[0] && __composerCalls[0].prompt ? __composerCalls[0].prompt : '';
      pgSendAiToComposer(firstComposerPrompt);
      pgDispatchToComposer = origDispatch;

      const isolatedBlock = pgBuildNodeRelationsContextBlock(pgBuildNodeAiContext(isolatedNode));
      return { isolatedBlock };
    })()`, ctx);

    assert.equal(chatPosts.length, 2, 'Expected 2 chat-send calls (file + folder)');
    const fileMsg = chatPosts[0].message;
    assert.ok(fileMsg.includes('@file:core/ram-memory-engine.mjs'), 'File chat prompt must include @file token');
    assert.ok(fileMsg.includes('core/ram-memory-mcp.mjs'), 'File chat prompt must list incoming dependent modules');
    assert.ok(fileMsg.includes('core/repo-mapper.mjs'), 'File chat prompt must list outgoing imports');
    assert.ok(fileMsg.includes('+2'), 'File chat prompt must report remaining dependent count beyond cap');
    assert.ok(fileMsg.includes('God-module') && fileMsg.includes('78%'), 'File chat prompt must include risk flags');

    const folderMsg = chatPosts[1].message;
    assert.ok(folderMsg.includes('@file:core/gpu/gpu-vram-runtime.mjs'), 'Folder chat prompt must attach hub @file token');
    assert.ok(folderMsg.includes('core/gpu/gpu-embedder.mjs'), 'Folder chat prompt must list folder member files');
    assert.ok(folderMsg.includes('core/'), 'Folder chat prompt must format folder: neighbor cleanly');
    assert.ok(folderMsg.includes('core/i18n.mjs'), 'Folder chat prompt must list outgoing folder imports');

    assert.equal(composerCalls.length, 2, 'Expected 2 composer dispatches');
    assert.deepEqual(Array.from(composerCalls[0].tokens), ['@file:core/ram-memory-engine.mjs']);
    assert.ok(composerCalls[0].prompt.includes('Проверь контракты'));
    assert.ok(composerCalls[0].prompt.includes('core/ram-memory-mcp.mjs'));
    assert.equal(composerCalls[1].prompt, composerCalls[0].prompt, 'Composer handoff must not duplicate relations block');

    assert.equal(res.isolatedBlock, '', 'Isolated node with no relations or risks must produce empty context block');
  } finally {
    try {
      vm.runInContext(`if (typeof telemetryPollTimer !== 'undefined' && telemetryPollTimer) { clearTimeout(telemetryPollTimer); telemetryPollTimer = null; }`, ctx);
    } catch {}
    for (const id of Array.from(activeTimers)) {
      safeClearTimeout(id);
    }
  }
});






import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildDocConfigReferenceGraph } from '../core/cpu-ast-graph-compressor.mjs';
import { RamMemoryEngine } from '../core/ram-memory-engine.mjs';
import { recommendProjectSetup } from '../core/project-setup-recommender.mjs';
import { runStressAudit } from '../skills/deep-stress-auditor/scripts/run-stress-audit.mjs';
import { extractCompactInteractiveRefTree } from '../skills/deep-stress-auditor/scripts/run-webapp-dogfood.mjs';
import { extractDesignTokensFromWorkspace } from '../skills/ui-ux-design-system/scripts/extract-design-md.mjs';

function makeTempDir(prefix = 'tunnel-mega-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('1. buildDocConfigReferenceGraph & RamMemoryEngine.getContextPack stay fast on large synthetic workspaces', () => {
  const filesMap = new Map();
  for (let i = 0; i < 3000; i++) {
    const rel = `packages/pkg-${i % 20}/src/mod_${i}.ts`;
    filesMap.set(rel, {
      ext: '.ts',
      text: `export function handleItem_${i}(val: number) { return val + ${i}; }\n`,
      symbols: [{ name: `handleItem_${i}`, kind: 'function', signature: `function handleItem_${i}(val: number)`, startLine: 1, endLine: 1 }],
    });
  }
  for (let d = 0; d < 400; d++) {
    filesMap.set(`docs/guide_${d}.md`, {
      ext: '.md',
      text: `See \`src/mod_${d}.ts\` and \`packages/pkg-${d % 20}/src/mod_${d}.ts\` for details.\n`,
    });
  }

  const t0 = performance.now();
  const docGraph = buildDocConfigReferenceGraph(filesMap);
  const elapsedMs = performance.now() - t0;
  assert.ok(docGraph.codeRefEdgeCount >= 300, `Expected >=300 doc->code edges, got ${docGraph.codeRefEdgeCount}`);
  assert.ok(elapsedMs < 350, `Expected O(1)-bucketed docGraph <350ms on 3400 files, took ${elapsedMs.toFixed(1)}ms`);

  const tmpWs = makeTempDir('tunnel-mega-ctx-');
  const engine = new RamMemoryEngine({ budgetMb: 256, sqliteKnowledgeEnabled: false });
  try {
    for (let i = 0; i < 1600; i++) {
      const subDir = path.join(tmpWs, `m${i % 16}`);
      if (!fs.existsSync(subDir)) fs.mkdirSync(subDir, { recursive: true });
      fs.writeFileSync(
        path.join(subDir, `item_${i}.mjs`),
        i === 42
          ? "import { helperCore } from '../m0/item_0.mjs';\nexport function searchTargetAlpha(x) { return helperCore(x); }\n"
          : (i === 0 ? 'export function helperCore(x) { return x * 2; }\n' : `export function fn_${i}(v) { return v + ${i}; }\n`),
        'utf8'
      );
    }
    engine.warmWorkspace(tmpWs, { startWatcher: false });
    const tCtx0 = performance.now();
    const pack = engine.getContextPack(tmpWs, 'searchTargetAlpha helperCore', { phase: 'explore', maxChars: 4000, toon: true });
    const ctxMs = performance.now() - tCtx0;
    assert.equal(pack.ok, true);
    assert.ok(pack.formatted.includes('searchTargetAlpha'), 'Context pack must include matched target');
    assert.ok(ctxMs < 600, `Expected bounded getContextPack <600ms on 1600 files, took ${ctxMs.toFixed(1)}ms`);
  } finally {
    engine.close();
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
});

test('2. Polyglot auditor eliminates false positives on Rust lifetimes/raw strings, Go backticks, JSX-in-.js, ===, grid[0][0], and Vite ?raw', async () => {
  const tmpWs = makeTempDir('tunnel-mega-audit-');
  try {
    fs.mkdirSync(path.join(tmpWs, 'src'), { recursive: true });
    fs.mkdirSync(path.join(tmpWs, 'rs'), { recursive: true });
    fs.mkdirSync(path.join(tmpWs, 'goapp'), { recursive: true });

    fs.writeFileSync(
      path.join(tmpWs, 'package.json'),
      JSON.stringify({ name: 'poly-fp-check', type: 'module', main: './dist/index.js', scripts: { 'build:esm': 'tsc' } }, null, 2),
      'utf8'
    );

    // Rust lifetimes ('a, '_) + raw strings (r#"..."#) + division operators
    fs.writeFileSync(
      path.join(tmpWs, 'rs', 'parser.rs'),
      [
        'pub fn parse_ref<\'a>(input: &\'a str, _any: &\'_ str) -> &\'a str {',
        '    let raw = r#"contains (unbalanced [quotes \' and " inside"#;',
        '    let ratio = 10 / 2 / 1;',
        '    if ratio > 0 { raw } else { input }',
        '}',
      ].join('\n'),
      'utf8'
    );

    // Go raw backtick string with backslash + factory return os.Open
    fs.writeFileSync(
      path.join(tmpWs, 'goapp', 'files.go'),
      [
        'package goapp',
        'import (',
        '  "os"',
        '  "strings"',
        ')',
        'func hasSlash(s string) bool {',
        '  if !strings.Contains(s, `\\`) { return false }',
        '  const ratio = 8 / 2 / 2',
        '  return ratio > 0',
        '}',
        'func openFactory(p string) (*os.File, error) {',
        '  return os.Open(p)',
        '}',
      ].join('\n'),
      'utf8'
    );

    // JSX inside .js + CJS top-level return + Vite ?raw import + === + numeric [0][0]
    fs.writeFileSync(
      path.join(tmpWs, 'src', 'Comp.js'),
      [
        "import rawData from './data.txt?raw';",
        'export function Card({ title }) {',
        '  return <div className="card"><span>{title}{rawData}</span></div>;',
        '}',
      ].join('\n'),
      'utf8'
    );
    fs.writeFileSync(path.join(tmpWs, 'src', 'data.txt'), 'hello', 'utf8');
    fs.writeFileSync(
      path.join(tmpWs, 'src', 'wrapper.cjs'),
      'const mod = require("node:path");\nif (!mod) return;\nmodule.exports = { ok: true };\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmpWs, 'src', 'grid.mjs'),
      [
        'export function updateGrid(grid, groups, start, bounds) {',
        '  grid[0][0] = 1;',
        '  const hit = groups.findIndex((g) => g[1][start] === bounds[start]);',
        '  return hit >= 0;',
        '}',
      ].join('\n'),
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmpWs, '.env.dev'),
      "API_CERT='-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A\n-----END PUBLIC KEY-----'\nPORT=3000\n",
      'utf8'
    );

    const report = await runStressAudit(tmpWs, { fuzz: false, shutdownPool: false });
    const ruleIds = new Set(report.findings.map((f) => f.ruleId));
    assert.equal(ruleIds.has('UNBALANCED_DELIMITER'), false, `Unexpected UNBALANCED_DELIMITER: ${JSON.stringify(report.findings)}`);
    assert.equal(ruleIds.has('SYNTAX_ERROR'), false, `Unexpected SYNTAX_ERROR: ${JSON.stringify(report.findings)}`);
    assert.equal(ruleIds.has('PROTOTYPE_POLLUTION_RISK'), false, `Unexpected PROTOTYPE_POLLUTION_RISK: ${JSON.stringify(report.findings)}`);
    assert.equal(ruleIds.has('GO_MISSING_DEFER_CLOSE'), false, `Unexpected GO_MISSING_DEFER_CLOSE: ${JSON.stringify(report.findings)}`);
    assert.equal(ruleIds.has('MISSING_DEFAULT_EXPORT'), false, `Unexpected MISSING_DEFAULT_EXPORT: ${JSON.stringify(report.findings)}`);
    assert.equal(ruleIds.has('BROKEN_MANIFEST_TARGET'), false, `Unexpected BROKEN_MANIFEST_TARGET: ${JSON.stringify(report.findings)}`);
    assert.equal(ruleIds.has('MALFORMED_ENV_LINE'), false, `Unexpected MALFORMED_ENV_LINE: ${JSON.stringify(report.findings)}`);
  } finally {
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
});

test('3. Dogfood DOM extractor ignores data-*-id attributes & resolves wrapping/for labels', () => {
  const html = `
    <section id="skillsSectionCard">
      <span data-block-id="skillsSectionCard">Drag</span>
      <label class="toggle-row"><input type="checkbox" id="chk-1" /><span>Enable Fast Mode</span></label>
      <label for="inp-2">Project Path</label>
      <input type="text" id="inp-2" />
    </section>
  `;
  const res = extractCompactInteractiveRefTree(html);
  assert.equal(res.issues.some((i) => i.ruleId === 'duplicate-dom-id'), false, `Unexpected duplicate-dom-id: ${JSON.stringify(res.issues)}`);
  assert.equal(res.issues.some((i) => i.ruleId === 'unlabeled-interactive-control'), false, `Unexpected unlabeled control: ${JSON.stringify(res.issues)}`);
  assert.equal(res.refs.length, 2);
  assert.equal(res.refs[0].label, 'Enable Fast Mode');
  assert.equal(res.refs[1].label, 'Project Path');
});

test('4. Setup Doctor avoids Python express false positive & detects monorepo packages; Design extractor reads theme tokens', () => {
  const tmpPy = makeTempDir('tunnel-mega-py-');
  const tmpMono = makeTempDir('tunnel-mega-mono-');
  try {
    fs.writeFileSync(
      path.join(tmpPy, 'pyproject.toml'),
      '[project]\nname = "demo-schema"\ndescription = "Validation and regular expressions in Python"\ndependencies = ["typing-extensions>=4.0"]\n',
      'utf8'
    );
    fs.writeFileSync(path.join(tmpPy, 'app.py'), 'def validate(): return True\n', 'utf8');
    const pyRec = recommendProjectSetup({ workspaceRoot: tmpPy });
    assert.equal(pyRec.ok, true);
    assert.equal(pyRec.stack.frameworks.includes('express'), false, 'Python project must never detect express');

    // Monorepo with docs first alphabetically and real app/packages under packages/web
    fs.mkdirSync(path.join(tmpMono, 'dev-docs', 'src'), { recursive: true });
    fs.mkdirSync(path.join(tmpMono, 'packages', 'web', 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpMono, 'package.json'), JSON.stringify({ name: 'mono-root', private: true }), 'utf8');
    fs.writeFileSync(
      path.join(tmpMono, 'packages', 'web', 'package.json'),
      JSON.stringify({ name: '@mono/web', dependencies: { react: '^19.0.0', vite: '^6.0.0' } }),
      'utf8'
    );
    fs.writeFileSync(path.join(tmpMono, 'packages', 'web', 'src', 'App.tsx'), 'export const App = () => <main />;\n', 'utf8');
    fs.writeFileSync(
      path.join(tmpMono, 'dev-docs', 'src', 'custom.css'),
      ':root { --ifm-color-primary: #6965db; }\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmpMono, 'packages', 'web', 'src', 'theme.css'),
      '.app-shell { --bg-canvas: #f8fafc; --text-main: #0f172a; --accent-primary: #2563eb; }\n',
      'utf8'
    );

    const monoRec = recommendProjectSetup({ workspaceRoot: tmpMono });
    assert.ok(monoRec.stack.frameworks.includes('react'), `Expected react from monorepo pkg, got ${JSON.stringify(monoRec.stack.frameworks)}`);
    assert.ok(monoRec.recommendedLocalSkills.some((s) => s.slug === 'ui-ux-design-system'));

    const design = extractDesignTokensFromWorkspace(tmpMono, { maxFiles: 2 });
    assert.equal(design.ok, true);
    assert.equal(design.summary.textPrimary, '#0f172a', 'Must prioritize packages/web over dev-docs and recognize --text-main');
  } finally {
    fs.rmSync(tmpPy, { recursive: true, force: true });
    fs.rmSync(tmpMono, { recursive: true, force: true });
  }
});

test('5. Audit v3.32.1 fixes: RamMemoryEngine.evict() clears maps/watchers, Python/Go import edges, and translated docs ranking', () => {
  const tmpPy = makeTempDir('tunnel-mega-py-imp-');
  const tmpGo = makeTempDir('tunnel-mega-go-imp-');
  const engine = new RamMemoryEngine({ budgetMb: 128 });
  try {
    // Python workspace: absolute import `from myapp.routing import Router` + localized docs noise
    fs.mkdirSync(path.join(tmpPy, 'myapp'), { recursive: true });
    fs.mkdirSync(path.join(tmpPy, 'docs', 'ja', 'docs'), { recursive: true });
    fs.writeFileSync(path.join(tmpPy, 'myapp', '__init__.py'), '', 'utf8');
    fs.writeFileSync(path.join(tmpPy, 'myapp', 'routing.py'), 'class APIRouter:\n    def route_depends(self):\n        return True\n', 'utf8');
    fs.writeFileSync(path.join(tmpPy, 'myapp', 'app.py'), 'from myapp.routing import APIRouter\n\ndef create_app():\n    return APIRouter()\n', 'utf8');
    fs.writeFileSync(
      path.join(tmpPy, 'docs', 'ja', 'docs', 'routing.md'),
      '# APIRouter Depends\nAPIRouter APIRouter APIRouter route_depends route_depends\n',
      'utf8'
    );

    engine.warmWorkspace(tmpPy, { startWatcher: true });
    const pyWs = engine.getOrCreateWorkspace(tmpPy);
    assert.ok(pyWs.forwardDeps.get('myapp/app.py')?.has('myapp/routing.py'), 'Python absolute workspace import must resolve');
    assert.ok(pyWs.reverseDeps.get('myapp/routing.py')?.has('myapp/app.py'), 'Python reverseDeps must track importer');
    const pySearch = engine.search(tmpPy, 'APIRouter route_depends', { maxResults: 3 });
    assert.equal(pySearch.results[0].file, 'myapp/routing.py', 'Source .py must outrank docs/ja/ translated docs');

    engine.evict(tmpPy);
    assert.equal(pyWs.watcher, null, 'evict() must null fs.watch handle');
    assert.equal(pyWs.files.size, 0, 'evict() must clear files Map to prevent watcher closure retention');
    assert.equal(pyWs.tokenIndex.size, 0, 'evict() must clear tokenIndex');
    assert.equal(engine.totalCacheBytes, 0);

    // Go workspace: go.mod module prefix + multi-line import (...) + _test.go pairing
    fs.mkdirSync(path.join(tmpGo, 'middleware', 'cors'), { recursive: true });
    fs.writeFileSync(path.join(tmpGo, 'go.mod'), 'module example.com/fiber\n\ngo 1.22\n', 'utf8');
    fs.writeFileSync(path.join(tmpGo, 'app.go'), 'package fiber\n\ntype App struct{}\nfunc New() *App { return &App{} }\n', 'utf8');
    fs.writeFileSync(
      path.join(tmpGo, 'middleware', 'cors', 'cors.go'),
      'package cors\n\nimport (\n\t"strings"\n\t"example.com/fiber"\n)\n\nfunc NewCors(a *fiber.App) string { return strings.TrimSpace("ok") }\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmpGo, 'middleware', 'cors', 'cors_test.go'),
      'package cors\n\nimport "testing"\n\nfunc TestCors(t *testing.T) {}\n',
      'utf8'
    );

    engine.warmWorkspace(tmpGo, { startWatcher: false });
    const goWs = engine.getOrCreateWorkspace(tmpGo);
    assert.ok(goWs.forwardDeps.get('middleware/cors/cors.go')?.has('app.go'), 'Go multi-line go.mod import must resolve to app.go');
    assert.ok(goWs.forwardDeps.get('middleware/cors/cors_test.go')?.has('middleware/cors/cors.go'), 'Go _test.go must link to sibling .go');
  } finally {
    engine.evict('all');
    fs.rmSync(tmpPy, { recursive: true, force: true });
    fs.rmSync(tmpGo, { recursive: true, force: true });
  }
});

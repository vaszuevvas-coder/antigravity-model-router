import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { RamMemoryEngine } from '../core/ram-memory-engine.mjs';
import { dispatchIpcRoute, executeMcpTool } from '../core/ram-memory-mcp.mjs';
import { BackgroundSentinel } from '../core/background-sentinel.mjs';
import { buildFileSymbolGraphPayload, buildProjectGraphPayload } from '../core/project-graph-builder.mjs';
import { SqliteKnowledgeHub } from '../core/sqlite-knowledge-hub.mjs';
import {
  augmentJsMethodSymbols,
  buildFileSearchStructures,
  collectWorkspaceGroundingInventory,
  expandSliceToWholeAstSymbol,
  extractMarkdownSection,
  inferEffectiveSymbolEndLine,
  loadJsAliasRules,
  resolveImportRel,
  sliceBufferLines,
} from '../core/ram/ram-index-helpers.mjs';
import { indexWorkspaceVectors } from '../core/gpu/gpu-vector-skills.mjs';

function makeTempDir(prefix = 'ram-refactor-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('1. Zero-copy entry.buf getter survives SharedRamArena compaction & frees cleanly on evict', () => {
  const tmpWs = makeTempDir('ram-zerocopy-');
  const engine = new RamMemoryEngine({ budgetMb: 512, sqliteKnowledgeEnabled: false });
  try {
    const fA = path.join(tmpWs, 'a.mjs');
    const fB = path.join(tmpWs, 'b.mjs');
    const fC = path.join(tmpWs, 'c.mjs');
    fs.writeFileSync(fA, 'export const alpha = "first-file";\n', 'utf8');
    fs.writeFileSync(fB, 'export const beta = "second-file";\n', 'utf8');
    fs.writeFileSync(fC, 'export const gamma = "third-file";\n', 'utf8');

    engine.warmWorkspace(tmpWs, { startWatcher: false });
    const ws = engine.getOrCreateWorkspace(tmpWs);
    const entryA = ws.files.get('a.mjs');
    const entryC = ws.files.get('c.mjs');
    assert.ok(entryA && entryC);
    assert.equal(Buffer.isBuffer(entryA.buf), true);
    assert.equal(entryA._fallbackBuf, null);

    // Trigger slab compaction by removing middle file and rewriting A
    engine.removeEntry(ws, 'b.mjs');
    fs.writeFileSync(fA, 'export const alpha = "updated-first-file";\n', 'utf8');
    engine.upsertFile(tmpWs, fA);

    assert.equal(ws.files.get('c.mjs').buf.toString('utf8'), 'export const gamma = "third-file";\n');
    assert.equal(ws.files.get('a.mjs').buf.toString('utf8'), 'export const alpha = "updated-first-file";\n');

    engine.evict(tmpWs);
    assert.equal(ws.files.size, 0);
    assert.equal(entryC.buf, null);
  } finally {
    engine.close();
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
});

test('2. symbolGraphDirty (>800 files) invalidates stale symbolGraph on next graph query', () => {
  const tmpWs = makeTempDir('ram-dirty-graph-');
  const engine = new RamMemoryEngine({ budgetMb: 512, sqliteKnowledgeEnabled: false });
  try {
    for (let i = 0; i < 810; i++) {
      const dir = path.join(tmpWs, `d${i % 8}`);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `m_${i}.mjs`), `export function fn_${i}() { return ${i}; }\n`, 'utf8');
    }
    engine.warmWorkspace(tmpWs, { startWatcher: false });
    const ws = engine.getOrCreateWorkspace(tmpWs);

    // Warm full symbolGraph
    const firstEgo = engine.getSymbolEgoGraph(tmpWs, 'fn_1');
    assert.equal(firstEgo.ok, true);
    assert.ok(ws.symbolGraph);

    // Edit file -> marks symbolGraphDirty instead of rebuilding immediately
    const targetFile = path.join(tmpWs, 'd1', 'm_1.mjs');
    fs.writeFileSync(
      targetFile,
      'export function brandNewSymbolAfterEdit() { return 999; }\nexport function fn_1() { return brandNewSymbolAfterEdit(); }\n',
      'utf8'
    );
    engine.upsertFile(tmpWs, targetFile);
    assert.ok(ws.symbolGraphDirty?.has('d1/m_1.mjs'));

    // Next graph query must rebuild and expose brandNewSymbolAfterEdit
    const explain = engine.queryKnowledgeGraph(tmpWs, { mode: 'explain', target: 'brandNewSymbolAfterEdit' });
    assert.equal(explain.found, true);
    assert.ok(explain.formatted.includes('d1/m_1.mjs'));
    assert.equal(ws.symbolGraphDirty?.size || 0, 0);
  } finally {
    engine.close();
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
});

test('3. scheduleSpeculativePrefetch skips full graph build on >1500 files & caps speculativeSkeletonCache at 96', async () => {
  const tmpWs = makeTempDir('ram-prefetch-guard-');
  const engine = new RamMemoryEngine({ budgetMb: 512, sqliteKnowledgeEnabled: false });
  try {
    for (let i = 0; i < 1510; i++) {
      const dir = path.join(tmpWs, `p${i % 10}`);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `f_${i}.mjs`), `export function item_${i}() { return ${i}; }\n`, 'utf8');
    }
    engine.warmWorkspace(tmpWs, { startWatcher: false });
    const ws = engine.getOrCreateWorkspace(tmpWs);

    engine.scheduleSpeculativePrefetch(tmpWs, 'p0/f_0.mjs');
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(ws.symbolGraph ?? null, null, 'Should not build full symbolGraph synchronously on >1500 files');
    assert.equal(ws.simHashIndex ?? null, null, 'Should not build full simHashIndex synchronously on >1500 files');

    // Verify LRU cap on speculativeSkeletonCache
    for (let k = 0; k < 110; k++) {
      engine._setSpeculativeSkeleton(ws, `k_${k}.mjs`, { sha1: 'abc', maxChars: 3200, res: { ok: true }, ts: k });
    }
    assert.equal(ws.speculativeSkeletonCache.size, 96);
    assert.equal(ws.speculativeSkeletonCache.has('k_0.mjs'), false);
    assert.equal(ws.speculativeSkeletonCache.has('k_109.mjs'), true);
  } finally {
    engine.close();
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
});

test('4. upsertFile incoming deps resolve JS/TS aliases & invalidate config caches on tsconfig/go.mod edit', () => {
  const tmpWs = makeTempDir('ram-aliases-');
  const engine = new RamMemoryEngine({ budgetMb: 512, sqliteKnowledgeEnabled: false });
  try {
    fs.mkdirSync(path.join(tmpWs, 'src', 'utils'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpWs, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@utils/*': ['src/utils/*'] } } }),
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmpWs, 'src', 'consumer.ts'),
      "import { calc } from '@utils/math.js';\nexport const out = calc(1);\n",
      'utf8'
    );
    engine.warmWorkspace(tmpWs, { startWatcher: false });
    const ws = engine.getOrCreateWorkspace(tmpWs);

    // Add alias target later via upsertFile -> incoming edge from consumer.ts must link via jsAliases
    const mathPath = path.join(tmpWs, 'src', 'utils', 'math.ts');
    fs.writeFileSync(mathPath, 'export function calc(x: number) { return x + 1; }\n', 'utf8');
    engine.upsertFile(tmpWs, mathPath, { rebuildDeps: true });

    assert.ok(ws.reverseDeps.get('src/utils/math.ts')?.has('src/consumer.ts'));

    // Updating tsconfig.json invalidates ws.jsAliasMeta; go.mod invalidates ws.goModulePrefix
    ws.goModulePrefix = 'example.com/old';
    fs.writeFileSync(path.join(tmpWs, 'tsconfig.json'), JSON.stringify({ compilerOptions: { paths: {} } }), 'utf8');
    engine.upsertFile(tmpWs, path.join(tmpWs, 'tsconfig.json'));
    assert.equal(ws.jsAliasMeta, undefined);

    fs.writeFileSync(path.join(tmpWs, 'go.mod'), 'module example.com/new\n', 'utf8');
    engine.upsertFile(tmpWs, path.join(tmpWs, 'go.mod'));
    assert.equal(ws.goModulePrefix, null);
  } finally {
    engine.close();
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
});

test('5. Telemetry accuracy (no double search count), O(k) LRU eviction, cross-layer seams & CSR conjunctive boost', async () => {
  const tmpWs = makeTempDir('ram-telemetry-lru-');
  const engine = new RamMemoryEngine({ budgetMb: 512, sqliteKnowledgeEnabled: false });
  try {
    fs.mkdirSync(path.join(tmpWs, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpWs, 'config.json'), '{ "tunnelFlagKey": true }\n', 'utf8');
    fs.writeFileSync(path.join(tmpWs, 'src', 'alpha.mjs'), 'export function processOrder(tunnelFlagKey) { return tunnelFlagKey; }\n', 'utf8');
    fs.writeFileSync(path.join(tmpWs, 'src', 'beta.mjs'), 'export function processItem() { return 1; }\n', 'utf8');
    fs.writeFileSync(path.join(tmpWs, 'src', 'gamma.mjs'), 'export function orderOnly() { return 2; }\n', 'utf8');
    fs.writeFileSync(path.join(tmpWs, 'panel.html'), '<div id="tunnelFlagKey"></div>\n', 'utf8');

    engine.warmWorkspace(tmpWs, { startWatcher: false });

    const beforeSearches = engine.stats.searches;
    const goldRes = engine.buildHybridGoldContext(tmpWs, 'processOrder', []);
    assert.equal(goldRes.ok, true);
    assert.equal(engine.stats.searches, beforeSearches + 1, 'buildHybridGoldContext must count 1 search');

    const semRes = await engine.searchSemantic(tmpWs, 'processOrder', { maxResults: 3 });
    assert.equal(semRes.ok, true);
    assert.equal(engine.stats.searches, beforeSearches + 2, 'searchSemantic fallback must count 1 search');

    // CSR conjunctive boost
    const beforeCsr = engine.sotaStats.csrLookups;
    const csrSearch = engine.search(tmpWs, 'processOrder tunnelFlagKey', { maxResults: 3 });
    assert.equal(csrSearch.ok, true);
    assert.equal(engine.sotaStats.csrLookups, beforeCsr + 1);
    assert.equal(csrSearch.results[0].file, 'src/alpha.mjs');

    // Cross-layer seams prefilter
    const seams = engine.findCrossLayerSeams(tmpWs, 'tunnelFlagKey');
    assert.equal(seams.ok, true);
    assert.deepEqual(seams.layersFound.sort(), ['code', 'config', 'ui']);

    // Unsupported graph mode message lists all modes
    const badGraph = engine.queryKnowledgeGraph(tmpWs, { mode: 'unknown_mode_xyz' });
    assert.equal(badGraph.ok, false);
    assert.ok(badGraph.formatted.includes('affected'));
    assert.ok(badGraph.formatted.includes('report'));
    assert.ok(badGraph.formatted.includes('surprising_bridges'));

    // O(k) LRU eviction respects _touchEntry order
    const ws = engine.getOrCreateWorkspace(tmpWs);
    engine._touchEntry(ws, ws.files.get('config.json'));
    const firstKeyBefore = ws.files.keys().next().value;
    engine.evictToTarget(engine.totalCacheBytes - 1);
    assert.equal(ws.files.has(firstKeyBefore), false, 'Oldest entry by Map order should be evicted first');
    assert.equal(ws.files.has('config.json'), true, 'Recently touched entry should stay in cache');
  } finally {
    engine.close();
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
});

test('6. Aliases (>64KB config, exact vs *, root ./..), Python relative bounds & Markdown #/C# section fixes', () => {
  const tmpWs = makeTempDir('ram-aliases-edge-');
  try {
    fs.mkdirSync(path.join(tmpWs, 'src/utils'), { recursive: true });
    fs.mkdirSync(path.join(tmpWs, 'pkg'), { recursive: true });

    // >64KB tsconfig.json with exact alias, catch-all "*", and large comment padding
    const bigPad = `// ${'x'.repeat(70 * 1024)}\n`;
    fs.writeFileSync(
      path.join(tmpWs, 'tsconfig.json'),
      bigPad + JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: {
            '@utils': ['src/utils/exact.ts'],
            '*': ['src/*'],
          },
        },
      }),
      'utf8'
    );

    const rules = loadJsAliasRules(tmpWs);
    const filesMap = new Map([
      ['index.js', {}],
      ['src/utils/exact.ts', {}],
      ['src/utils-extra/foo.ts', {}],
      ['src/shared/helper.ts', {}],
      ['pkg/a.py', {}],
      ['top.py', {}],
    ]);

    // Exact alias matches only exact specifier, NOT prefix "@utils-extra/foo"
    assert.equal(resolveImportRel('index.js', '@utils', filesMap, { jsAliases: rules }), 'src/utils/exact.ts');
    assert.equal(resolveImportRel('index.js', '@utils-extra/foo', filesMap, { jsAliases: rules }), null);
    // Catch-all "*" rule resolves into src/*
    assert.equal(resolveImportRel('index.js', 'shared/helper', filesMap, { jsAliases: rules }), 'src/shared/helper.ts');
    // Root '.' / '..' resolves to root index.js
    assert.equal(resolveImportRel('src/utils/exact.ts', '../..', filesMap), 'index.js');
    assert.equal(resolveImportRel('index.js', './', filesMap), 'index.js');
    // Python relative import escaping root returns null instead of resolving inside root
    assert.equal(resolveImportRel('pkg/a.py', '...top', filesMap), null);

    // Markdown section '#' must not match first heading, and '## C#' must preserve '#'
    const md = '# Intro\nFirst.\n## C#\nDotnet section.\n';
    const hashMiss = extractMarkdownSection(md, '#');
    assert.equal(hashMiss.found, false);
    const csharpHit = extractMarkdownSection(md, 'C#');
    assert.equal(csharpHit.found, true);
    assert.equal(csharpHit.heading, 'C#');
  } finally {
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
});

test('7. Search structures (#private in body), augmentJsMethodSymbols TS return obj, Python indent & fastMode CamelCase', () => {
  const jsCode = [
    'class Demo {',
    '  #secretToken = 42;',
    '  async buildItem(',
    '    label = "(paren-in-str)",',
    '  ): {',
    '    ok: boolean',
    '  } {',
    '    return { ok: Boolean(label) && this.#secretToken > 0 };',
    '  }',
    '}',
  ].join('\n');
  const st = buildFileSearchStructures('demo.ts', '.ts', jsCode, [], [], {}, false);
  const packedSecret = st.fieldPostings.get('secret') || 0;
  const bodyTf = (packedSecret >>> 14) & 0x7f;
  assert.ok(bodyTf >= 1, 'JS #privateField should be indexed in body zone, not doc comment zone');

  const syms = augmentJsMethodSymbols('.ts', jsCode, []);
  assert.ok(syms.some((s) => s.name === 'buildItem'), 'augmentJsMethodSymbols must handle parens in strings and TS object return types');

  const pyCode = [
    'def alpha_worker(x):',
    '    if x > 0:',
    '        return x + 1',
    '    return 0',
    '',
    'def beta_worker():',
    '    return 2',
  ].join('\n');
  const pyBuf = Buffer.from(pyCode, 'utf8');
  const pyOffsets = Int32Array.from([0, 21, 35, 52, 65, 66, 85]);
  const pyEntry = { ext: '.py', buf: pyBuf, lineOffsets: pyOffsets, lineCount: 7 };
  const pyEnd = inferEffectiveSymbolEndLine(
    pyEntry,
    [{ name: 'alpha_worker', startLine: 1, endLine: 1 }, { name: 'beta_worker', startLine: 6, endLine: 6 }],
    1,
    1,
    7,
    55
  );
  assert.equal(pyEnd, 4, 'Python symbol end line should stop at body end before beta_worker');

  // fastMode trigram check with CamelCase identifier & substring fallback when trigramIndex is empty
  const tmpWs = makeTempDir('ram-fastmode-');
  const engine = new RamMemoryEngine({ budgetMb: 64, sqliteKnowledgeEnabled: false });
  try {
    fs.writeFileSync(path.join(tmpWs, 'camel.mjs'), 'export function CamelCaseHandlerXyz() { return 1; }\n', 'utf8');
    engine.warmWorkspace(tmpWs, { startWatcher: false });
    const fastHit = engine.search(tmpWs, 'CamelCaseHandlerXyz', { fastMode: true, maxResults: 3 });
    assert.equal(fastHit.ok, true);
    assert.equal(fastHit.results[0].file, 'camel.mjs');

    const ws = engine.getOrCreateWorkspace(tmpWs);
    ws.trigramIndex.clear();
    const fallbackHit = engine.search(tmpWs, 'CamelCaseHandlerXyz', { fastMode: true, maxResults: 3 });
    assert.equal(fallbackHit.ok, true);
    assert.equal(fallbackHit.results[0].file, 'camel.mjs');
  } finally {
    engine.close();
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
});

test('8. Null-safety on evicted buffers, bounded repoMapCache, simHashIndex cleanup, safe fence cap & async evict race', async () => {
  assert.equal(sliceBufferLines(null, null, 1, 5), '');
  const emptySlice = expandSliceToWholeAstSymbol({ buf: null, lineOffsets: null, lineCount: 10 }, 1, 5);
  assert.equal(emptySlice.snippetText, '');

  const tmpWs = makeTempDir('ram-safety-races-');
  const engine = new RamMemoryEngine({ budgetMb: 128, sqliteKnowledgeEnabled: false });
  try {
    for (let i = 0; i < 6; i++) {
      fs.writeFileSync(
        path.join(tmpWs, `mod_${i}.mjs`),
        `export function fnMod_${i}(arg) {\n  const val = arg + ${i};\n  return val * 2;\n}\n`,
        'utf8'
      );
    }
    engine.warmWorkspace(tmpWs, { startWatcher: false });
    const ws = engine.getOrCreateWorkspace(tmpWs);

    // Defensive clone + bounded repoMapCache <= 24
    const inv1 = collectWorkspaceGroundingInventory(ws);
    inv1.repoFiles.push('MUTATED_SHOULD_NOT_STICK.mjs');
    const inv2 = collectWorkspaceGroundingInventory(ws);
    assert.equal(inv2.repoFiles.includes('MUTATED_SHOULD_NOT_STICK.mjs'), false);

    for (let cap = 600; cap <= 4800; cap += 128) {
      engine.getFastRepoMap(tmpWs, cap, { toon: true });
    }
    assert.ok(ws.repoMapCache.size <= 24, `repoMapCache must stay bounded <= 24, got ${ws.repoMapCache.size}`);

    // simHashIndex cleanup on removeEntry
    engine.verifyContractsInRam(tmpWs, 'mod_0.mjs');
    if (ws.simHashIndex) {
      ws.simHashIndex.set('mod_0.mjs', [{ name: 'fnMod_0', hash: 1n }]);
      engine.removeEntry(ws, 'mod_0.mjs');
      assert.equal(ws.simHashIndex.has('mod_0.mjs'), false);
    }

    // getContextPack closes any cut markdown fence
    const pack = engine.getContextPack(tmpWs, 'fnMod_1 fnMod_2', { maxChars: 220, toon: true });
    assert.equal(pack.ok, true);
    const fenceCount = (pack.formatted.match(/^\s*`{3,}/gm) || []).length;
    assert.equal(fenceCount % 2, 0, 'Capped context pack must not leave unclosed markdown code fence');

    // Concurrent indexWorkspaceVectors on evicted entry does not throw regardless of host GPU state
    const evictedMap = new Map([['ghost.mjs', { ext: '.mjs', sizeBytes: 20, buf: null }]]);
    const vecRes = await indexWorkspaceVectors(tmpWs, evictedMap, { maxNewFiles: 5 });
    assert.equal(typeof vecRes.ok, 'boolean');

    // warmWorkspaceAsync mid-flight evict race leaves no zombie workspace
    const tmpRace = makeTempDir('ram-async-evict-');
    try {
      for (let i = 0; i < 30; i++) {
        fs.writeFileSync(path.join(tmpRace, `r_${i}.mjs`), `export function race_${i}() { return ${i}; }\n`, 'utf8');
      }
      const pWarm = engine.warmWorkspaceAsync(tmpRace, { startWatcher: false });
      engine.evict(tmpRace);
      const warmOut = await pWarm;
      const raceKey = process.platform === 'win32' ? path.resolve(tmpRace).toLowerCase() : path.resolve(tmpRace);
      assert.equal(warmOut.ok, false);
      assert.equal(warmOut.evicted, true);
      assert.equal(engine.workspaces.has(raceKey), false);
    } finally {
      fs.rmSync(tmpRace, { recursive: true, force: true });
    }
  } finally {
    engine.close();
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
});

test('9. Cross-subsystem contracts: maxBudgetMb/startWatcher, resolveWorkspaceEntry, symbolGraphDirty in project-graph-builder & speculative prefetch', async () => {
  const tmpWs = makeTempDir('ram-cross-graph-');
  const engine = new RamMemoryEngine({
    maxBudgetMb: 512,
    startWatcher: false,
    sqliteKnowledgeEnabled: false,
  });
  try {
    assert.equal(engine.budgetMb, 512, 'maxBudgetMb constructor alias must set budgetMb');
    assert.equal(engine.defaultStartWatcher, false);
    assert.equal(engine.hasWarmWorkspace(tmpWs), false);

    fs.mkdirSync(path.join(tmpWs, 'src'), { recursive: true });
    const alphaFile = path.join(tmpWs, 'src', 'AlphaItem.mjs');
    const betaFile = path.join(tmpWs, 'src', 'BetaConsumer.mjs');
    fs.writeFileSync(alphaFile, 'export function initialSym() { return 1; }\n', 'utf8');
    fs.writeFileSync(
      betaFile,
      "import { initialSym } from './AlphaItem.mjs';\nexport function runBeta() { return initialSym(); }\n",
      'utf8'
    );

    // getOrCreateWorkspace before warming must still report hasWarmWorkspace=false
    const coldWs = engine.getOrCreateWorkspace(tmpWs);
    assert.ok(coldWs);
    assert.equal(engine.hasWarmWorkspace(tmpWs), false);

    engine.warmWorkspace(tmpWs);
    assert.equal(engine.hasWarmWorkspace(tmpWs), true);
    assert.equal(coldWs.watcher, null, 'defaultStartWatcher=false must skip fs.watch');

    // Slash & ./ normalization in resolveWorkspaceEntry (+ Win32 case insensitivity)
    const resolvedDotSlash = engine.resolveWorkspaceEntry(coldWs, './src\\AlphaItem.mjs');
    assert.ok(resolvedDotSlash);
    assert.equal(resolvedDotSlash.relPath, 'src/AlphaItem.mjs');
    if (process.platform === 'win32') {
      const resolvedCase = engine.resolveWorkspaceEntry(tmpWs, 'SRC/alphaitem.mjs');
      assert.ok(resolvedCase);
      assert.equal(resolvedCase.relPath, 'src/AlphaItem.mjs');
    }

    // Build initial symbol graph via buildFileSymbolGraphPayload
    const symGraph1 = buildFileSymbolGraphPayload(engine, tmpWs, 'src/AlphaItem.mjs');
    assert.equal(symGraph1.ok, true);
    assert.ok(symGraph1.nodes.some((n) => n.label === 'initialSym'));

    // Simulate >800-file dirty tracking: mutate file in RAM, keep stale ws.symbolGraph, mark symbolGraphDirty
    const staleGraphSnapshot = coldWs.symbolGraph;
    assert.ok(staleGraphSnapshot);
    const futureMtime = new Date(Date.now() + 5000);
    fs.writeFileSync(
      alphaFile,
      'export function initialSym() { return freshGraphSym(); }\nexport function freshGraphSym() { return 42; }\n',
      'utf8'
    );
    fs.utimesSync(alphaFile, futureMtime, futureMtime);
    engine.upsertFile(tmpWs, alphaFile);
    coldWs.symbolGraph = staleGraphSnapshot;
    coldWs.symbolGraphDirty = new Set(['src/AlphaItem.mjs']);

    // project-graph-builder must honor symbolGraphDirty and rebuild symbolGraph so freshGraphSym appears
    const symGraph2 = buildFileSymbolGraphPayload(engine, tmpWs, './src\\AlphaItem.mjs');
    assert.equal(symGraph2.ok, true);
    assert.ok(symGraph2.nodes.some((n) => n.label === 'freshGraphSym'), 'buildFileSymbolGraphPayload must refresh dirty symbolGraph');
    assert.equal(coldWs.symbolGraphDirty.size, 0);

    // project-graph focus path canonicalization
    const projGraph = buildProjectGraphPayload(engine, tmpWs, {
      focus: process.platform === 'win32' ? 'SRC\\alphaitem.mjs' : './src/AlphaItem.mjs',
      depth: 1,
    });
    assert.equal(projGraph.ok, true);
    assert.equal(projGraph.focus, 'src/AlphaItem.mjs');

    // scheduleSpeculativePrefetch must also refresh dirty symbolGraph when <=1500 files
    coldWs.symbolGraph = staleGraphSnapshot;
    coldWs.symbolGraphDirty = new Set(['src/AlphaItem.mjs']);
    engine.scheduleSpeculativePrefetch(tmpWs, './src\\AlphaItem.mjs');
    await new Promise((r) => setTimeout(r, 70));
    assert.equal(coldWs.symbolGraphDirty.size, 0);
    assert.ok(coldWs.symbolGraph?.definedSymbols?.has('freshGraphSym'));
  } finally {
    engine.close();
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
});

test('10. Cross-subsystem contracts: warmWorkspaceAsync in MCP (/gpu/warm, gpu_status), BackgroundSentinel & SQLite federated peer cache hit', async () => {
  const tmpRoot = makeTempDir('ram-cross-mcp-');
  const mainWs = path.join(tmpRoot, 'main-app');
  const peerWs = path.join(tmpRoot, 'peer-lib');
  const cacheDir = path.join(tmpRoot, 'cache');
  const prevTestState = process.env.TUNNEL_TEST_STATE_PATH;

  fs.mkdirSync(mainWs, { recursive: true });
  fs.mkdirSync(peerWs, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(mainWs, 'app.mjs'), 'export function runMainApp() { return "ok"; }\n', 'utf8');
  fs.writeFileSync(path.join(peerWs, 'shared.mjs'), 'export function federatedSharedHelperToken() { return 777; }\n', 'utf8');

  const testStatePath = path.join(cacheDir, 'state.json');
  fs.writeFileSync(
    testStatePath,
    JSON.stringify({ ramCacheEnabled: true, gpuEnabled: false, gpuSemanticSearch: false, sqliteKnowledgeEnabled: false }),
    'utf8'
  );
  process.env.TUNNEL_TEST_STATE_PATH = testStatePath;

  const engine = new RamMemoryEngine({ budgetMb: 128, startWatcher: false, sqliteKnowledgeEnabled: false });
  const sentinel = new BackgroundSentinel({
    cacheDir,
    stateOverride: { sentinelEnabled: true, sentinelShadowGuard: true },
  });
  const hub = new SqliteKnowledgeHub({ dbPath: path.join(cacheDir, 'hub.sqlite') });

  try {
    // 1) BackgroundSentinel._resolveWorkspaceFiles on cold RamMemoryEngine must resolve live ws.files after warmWorkspaceAsync
    const resolvedBySentinel = await sentinel._resolveWorkspaceFiles(mainWs, engine);
    assert.ok(resolvedBySentinel.ws, 'Sentinel must receive live workspace object, not null fallback');
    assert.ok(resolvedBySentinel.filesMap instanceof Map && resolvedBySentinel.filesMap.has('app.mjs'));

    // 2) MCP IPC POST /gpu/warm & MCP tool gpu_status(warm_index) must resolve ws.files from warmWorkspaceAsync (never 'Invalid workspace' / 'Invalid workspaceRoot')
    engine.evict('all');
    const ipcWarm = await dispatchIpcRoute(
      'POST',
      '/gpu/warm',
      { wsPath: mainWs, maxNewFiles: 10 },
      { engine, sentinel, settings: { enabled: true, budgetMb: 128 } }
    );
    assert.equal(ipcWarm.status, 200);
    assert.notEqual(ipcWarm.body?.error, 'Invalid workspace', '/gpu/warm must resolve ws.files after warmWorkspaceAsync');
    assert.equal(engine.hasWarmWorkspace(mainWs), true);

    engine.evict('all');
    const mcpWarmIdx = await executeMcpTool(
      'gpu_status',
      { action: 'warm_index', workspaceRoot: mainWs },
      { engine }
    );
    assert.notEqual(mcpWarmIdx.text, 'Invalid workspaceRoot', 'gpu_status(warm_index) must resolve ws.files after warmWorkspaceAsync');
    assert.equal(engine.hasWarmWorkspace(mainWs), true);

    // 3) SQLiteKnowledgeHub.searchFederatedPeers must hit warm RAM on Win32 without re-running warmWorkspace on every query
    engine.warmWorkspace(peerWs, { startWatcher: false });
    let extraWarmCalls = 0;
    const origWarm = engine.warmWorkspace.bind(engine);
    engine.warmWorkspace = (...args) => {
      extraWarmCalls += 1;
      return origWarm(...args);
    };

    const fedRes = hub.searchFederatedPeers(mainWs, 'federatedSharedHelperToken', engine, {
      extraPeers: [peerWs],
      maxResults: 3,
    });
    assert.equal(fedRes.ok, true);
    assert.equal(fedRes.results.length, 1);
    assert.equal(fedRes.results[0].file, 'shared.mjs');
    assert.equal(extraWarmCalls, 0, 'Warm federated peer workspace must be hit in RAM with 0 extra warmWorkspace calls');
  } finally {
    if (prevTestState === undefined) delete process.env.TUNNEL_TEST_STATE_PATH;
    else process.env.TUNNEL_TEST_STATE_PATH = prevTestState;
    sentinel.stopDaemonLoop();
    hub.close();
    engine.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Batch 2 audit regressions: partialLazyLoad, blocked-file eviction, slice endLine window, search snippet & Windows memo colon', async () => {
  const tmpWs = makeTempDir('ram-b2-reg-');
  const engine = new RamMemoryEngine({ budgetMb: 128, startWatcher: false, sqliteKnowledgeEnabled: false });
  try {
    const bigLines = Array.from({ length: 260 }, (_, i) => `export const row_${i + 1} = "MCPServer_${i + 1}";`).join('\n');
    const aPath = path.join(tmpWs, 'alpha.mjs');
    const bPath = path.join(tmpWs, 'beta.mjs');
    fs.writeFileSync(aPath, bigLines, 'utf8');
    fs.writeFileSync(bPath, 'export function runCheck() { return 1; }\n', 'utf8');

    // 1. ram_slice on cold workspace marks partialLazyLoad so ensureWarm & hasWarmWorkspace still warm the full repo
    const sliceRes = await executeMcpTool('ram_slice', { workspaceRoot: tmpWs, filePath: 'alpha.mjs', startLine: 150 }, { engine });
    assert.equal(sliceRes.isError, false);
    assert.ok(sliceRes.text.includes('row_260'), 'ram_slice without endLine must slice a 120-line window past line 150');
    assert.equal(engine.hasWarmWorkspace(tmpWs), false);

    const ws = engine.ensureWarm(tmpWs);
    assert.equal(ws.files.has('beta.mjs'), true);
    assert.equal(engine.hasWarmWorkspace(tmpWs), true);

    // 2. Truncating file to 0 bytes evicts stale entry from RAM
    fs.writeFileSync(bPath, '', 'utf8');
    assert.equal(engine.upsertFile(tmpWs, bPath), null);
    assert.equal(ws.files.has('beta.mjs'), false);

    // 3. searchWorkspace populates snippet and splits acronym MCPServer
    const searchRes = engine.search(tmpWs, 'MCPServer', { maxResults: 3 });
    assert.equal(searchRes.ok, true);
    assert.ok(typeof searchRes.results[0]?.snippet === 'string' && searchRes.results[0].snippet.length > 0);

    // 4. Memoizer invalidates Windows absolute paths with :line suffixes
    engine.recordObservationMemo({
      toolName: 'run_command',
      targetKey: `${aPath}:10-20`,
      contentSha1: 'a1b2c3d4',
      charLen: 200,
    });
    assert.ok(engine.invalidateObservationFile(tmpWs, aPath) >= 1);

    // 5. /ipc/lsp-status accepts GET|POST + ?wsPath=
    const lspRes = await dispatchIpcRoute('POST', `/ipc/lsp-status?wsPath=${encodeURIComponent(tmpWs)}`, {}, { engine });
    assert.equal(lspRes.status, 200);
    assert.equal(lspRes.body.ok, true);
  } finally {
    engine.close();
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
});

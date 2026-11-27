import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildDocConfigReferenceGraph,
  buildSymbolCallGraph,
  detectArchitectureClusters,
  findShortestGraphPath,
  findSurprisingConnections,
  foldCodeWithKnapsack,
  normalizePosixRel,
  pickBestCallTargetDef,
  queryDocRefsForFile,
  querySymbolEgoGraph,
  selectDiverseSlicesMMR,
} from '../core/cpu-ast-graph-compressor.mjs';
import { RamMemoryEngine } from '../core/ram-memory-engine.mjs';
import { executeMcpTool, MCP_TOOLS } from '../core/ram-memory-mcp.mjs';

function makeBig400LineModule() {
  const lines = [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "import { computeHash } from './hash-utils.mjs';",
    '',
  ];

  for (let i = 1; i <= 11; i++) {
    const isFocus = i === 6;
    const fnName = isFocus ? 'reconcileSessionBudget' : `helperRoutine${i}`;
    const exportKw = isFocus || i % 3 === 0 ? 'export ' : '';
    lines.push(`${exportKw}function ${fnName}(inputPayload, options = {}) {`);
    if (isFocus) {
      lines.push("  const marker = 'FOCUS_VERBATIM_SIGNATURE_TOKEN';");
      lines.push('  const base = computeHash(inputPayload);');
      lines.push('  const adj = helperRoutine5(base, options);');
    } else {
      lines.push(`  const stepName = 'step_${i}';`);
    }
    for (let k = 0; k < 31; k++) {
      lines.push(`  const v_${i}_${k} = (Number(options?.limit) || ${k + 1}) * ${i + 2};`);
    }
    if (isFocus) {
      lines.push('  return { marker, base, adj, ok: true };');
    } else {
      lines.push(`  return { stepName, sum: v_${i}_0 + v_${i}_1 };`);
    }
    lines.push('}');
    lines.push('');
  }
  return lines.join('\n');
}

test('1. LongCodeZip foldCodeWithKnapsack achieves >=3x compression on 400L+ file and keeps focus symbol verbatim', () => {
  const source = makeBig400LineModule();
  const totalLines = source.split('\n').length;
  assert.ok(totalLines >= 400, `Expected >=400 lines, got ${totalLines}`);

  const res = foldCodeWithKnapsack(source, {
    query: 'reconcile session budget token',
    focusSymbol: 'reconcileSessionBudget',
    maxBudgetChars: 3200,
    ext: '.mjs',
  });

  assert.equal(res.ok, true);
  assert.ok(res.compressionRatio >= 3, `Expected >=3x compression, got ${res.compressionRatio}x (${res.originalChars} -> ${res.compressedChars})`);
  assert.ok(res.compressedChars <= 3200, `Compressed chars ${res.compressedChars} exceeded 3200 budget`);
  assert.ok(res.savedChars > 0 && res.savedTokensEstimate > 0);
  assert.ok(res.elapsedMs < 200, `Expected <200ms latency, got ${res.elapsedMs}ms`);
  assert.ok(res.expandedSymbols.includes('reconcileSessionBudget'), 'Focus symbol must be expanded');
  assert.ok(res.foldedSymbols.length >= 6, `Expected folded neighbors, got ${res.foldedSymbols.length}`);
  assert.ok(res.formatted.includes("import { computeHash } from './hash-utils.mjs';"), 'Top imports must be preserved');
  assert.ok(res.formatted.includes('FOCUS_VERBATIM_SIGNATURE_TOKEN'), 'Focus symbol body must be kept verbatim');
  assert.match(res.formatted, /\/\* \.\.\. \d+L folded \[L\d+-L\d+\] \.\.\. \*\//);

  // Python # comment skeleton check
  const pyCode = [
    'import os',
    '',
    'def alpha_worker(x, y):',
    ...Array.from({ length: 20 }, (_, idx) => `    tmp_${idx} = x + y + ${idx}`),
    '    return tmp_0',
    '',
    'def target_solver(data):',
    "    tag = 'PY_FOCUS_KEEP'",
    '    return tag',
    '',
  ].join('\n');
  const pyRes = foldCodeWithKnapsack(pyCode, {
    focusSymbol: 'target_solver',
    maxBudgetChars: 350,
    ext: '.py',
  });
  assert.equal(pyRes.ok, true);
  assert.ok(pyRes.expandedSymbols.includes('target_solver'));
  assert.ok(pyRes.foldedSymbols.includes('alpha_worker'));
  assert.match(pyRes.formatted, /# \.\.\. \d+L folded \[L\d+-L\d+\] \.\.\./);
});

test('2. RepoGraph buildSymbolCallGraph & querySymbolEgoGraph resolve 1-hop callers/callees and ignore control keywords', () => {
  const filesMap = new Map([
    ['core/auth.mjs', [
      'export function validateSession(token) {',
      '  if (!token) { return false; }',
      '  for (let i = 0; i < 2; i++) { continue; }',
      '  return decodeJwtPayload(token);',
      '}',
      'export function decodeJwtPayload(raw) {',
      '  try { return JSON.parse(raw); } catch (e) { throw new Error("bad"); }',
      '}',
    ].join('\n')],
    ['core/api.mjs', [
      "import { validateSession } from './auth.mjs';",
      'export async function handleLoginRequest(req) {',
      '  const ok = await validateSession(req.token);',
      '  switch (ok) { case true: return renderDashboard(req); default: return null; }',
      '}',
      'export function renderDashboard(req) { return req.user; }',
    ].join('\n')],
  ]);

  const graph = buildSymbolCallGraph(filesMap);
  assert.ok(graph.edgeCount >= 3);
  assert.ok(!graph.callersOf.has('if') && !graph.callersOf.has('for') && !graph.callersOf.has('switch'));
  assert.ok(!graph.calleesOf.has('catch') && !graph.callersOf.has('throw'));

  const ego = querySymbolEgoGraph(graph, 'validateSession');
  assert.ok(ego.edgesFound >= 2, `Expected >=2 edges, got ${ego.edgesFound}`);
  assert.ok(ego.callers.some((c) => c.name === 'handleLoginRequest'), 'handleLoginRequest must be a caller');
  assert.ok(ego.callees.some((c) => c.name === 'decodeJwtPayload'), 'decodeJwtPayload must be a callee');
  assert.match(ego.formattedHint, /^🕸️ \[RepoGraph 1-Hop\]/);
  assert.ok(ego.formattedHint.includes('handleLoginRequest'));
  assert.ok(ego.formattedHint.includes('decodeJwtPayload'));
});

test('3. selectDiverseSlicesMMR filters overlapping and near-duplicate slices while keeping diverse hits', () => {
  const candidates = [
    {
      file: 'core/router.mjs',
      startLine: 10,
      endLine: 30,
      rerankScore: 0.96,
      snippetText: 'export function routePrompt(prompt, state) {\n  const score = computeBayesianScore(prompt);\n  return selectModelTier(score, state);\n}',
    },
    {
      file: 'core/router.mjs',
      startLine: 12,
      endLine: 32,
      rerankScore: 0.94,
      snippetText: 'export function routePrompt(prompt, state) {\n  const score = computeBayesianScore(prompt);\n  return selectModelTier(score, state);\n}',
    },
    {
      file: 'core/router-copy.mjs',
      startLine: 1,
      endLine: 20,
      rerankScore: 0.91,
      snippetText: 'export function routePrompt(prompt, state) {\n  const score = computeBayesianScore(prompt);\n  return selectModelTier(score, state);\n}',
    },
    {
      file: 'core/gpu-engine.mjs',
      startLine: 50,
      endLine: 75,
      rerankScore: 0.85,
      snippetText: 'export async function warmOllamaVram(cfg) {\n  const gpu = probeNvidiaGpu();\n  return ensureEmbedModelWarm(gpu);\n}',
    },
    {
      file: 'core/obs-masker.mjs',
      startLine: 80,
      endLine: 105,
      rerankScore: 0.78,
      snippetText: 'export function maskSecretsAndLogs(output) {\n  return redactBearerTokens(output);\n}',
    },
  ];

  const { selected, filteredDuplicates } = selectDiverseSlicesMMR(candidates, { topK: 3, lambda: 0.72 });
  assert.equal(selected.length, 3);
  assert.equal(filteredDuplicates.length, 2, 'Both same-file overlap and cross-file near-duplicate must be filtered');
  assert.deepEqual(
    selected.map((s) => s.file),
    ['core/router.mjs', 'core/gpu-engine.mjs', 'core/obs-masker.mjs']
  );
});

test('4. RamMemoryEngine lazy symbolGraph invalidation, getContextPack RepoGraph hint & ram_slice({ skeleton: true })', async () => {
  const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-ast-graph-'));
  const ram = new RamMemoryEngine({ budgetMb: 128 });
  try {
    const bigFile = makeBig400LineModule();
    fs.writeFileSync(path.join(tmpWs, 'budget.mjs'), bigFile, 'utf8');
    fs.writeFileSync(
      path.join(tmpWs, 'hash-utils.mjs'),
      'export function computeHash(val) {\n  return String(val || "").length * 17;\n}\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmpWs, 'caller.mjs'),
      "import { reconcileSessionBudget } from './budget.mjs';\nexport function runAudit(p) {\n  return reconcileSessionBudget(p, { limit: 10 });\n}\n",
      'utf8'
    );

    ram.warmWorkspace(tmpWs, { startWatcher: false });
    const ws = ram.getOrCreateWorkspace(tmpWs);
    assert.equal(ws.symbolGraph, null, 'symbolGraph must be lazy-initialized');

    const ego1 = ram.getSymbolEgoGraph(tmpWs, 'reconcileSessionBudget');
    assert.equal(ego1.ok, true);
    assert.ok(ego1.callers.some((c) => c.name === 'runAudit'));
    assert.ok(ego1.callees.some((c) => c.name === 'computeHash'));
    assert.ok(ws.symbolGraph !== null, 'symbolGraph must be cached after first query');

    // Upsert invalidates ws.symbolGraph
    fs.writeFileSync(
      path.join(tmpWs, 'caller.mjs'),
      "import { reconcileSessionBudget } from './budget.mjs';\nexport function runNewAudit(p) {\n  return reconcileSessionBudget(p, { limit: 20 });\n}\n",
      'utf8'
    );
    ram.upsertFile(tmpWs, path.join(tmpWs, 'caller.mjs'));
    assert.equal(ws.symbolGraph, null, 'upsertFile must invalidate ws.symbolGraph');

    const ego2 = ram.getSymbolEgoGraph(tmpWs, 'reconcileSessionBudget');
    assert.ok(ego2.callers.some((c) => c.name === 'runNewAudit'));
    assert.ok(!ego2.callers.some((c) => c.name === 'runAudit'));

    // Context pack includes RepoGraph 1-hop hint
    const pack = ram.getContextPack(tmpWs, 'reconcileSessionBudget', { maxChars: 4800 });
    assert.equal(pack.ok, true);
    assert.ok(pack.formatted.includes('🕸️ [RepoGraph 1-Hop]'), 'getContextPack must include RepoGraph 1-hop hint');

    // Default engine.slice behavior stays identical
    const normalSlice = ram.slice(tmpWs, 'budget.mjs', { startLine: 1, endLine: 12 });
    assert.equal(normalSlice.ok, true);
    assert.match(normalSlice.formatted, /^\/\/ \[RAM Lines 1-12\/\d+\] budget\.mjs/);
    assert.equal(normalSlice.skeleton, undefined);

    // engine.slice({ skeleton: true })
    const skelSlice = ram.slice(tmpWs, 'budget.mjs', {
      skeleton: true,
      symbol: 'reconcileSessionBudget',
      query: 'reconcile session budget',
      maxChars: 3200,
    });
    assert.equal(skelSlice.ok, true);
    assert.equal(skelSlice.skeleton, true);
    assert.ok(skelSlice.compressionRatio >= 3, `Expected >=3x in ram.slice skeleton, got ${skelSlice.compressionRatio}x`);
    assert.ok(skelSlice.formatted.includes('FOCUS_VERBATIM_SIGNATURE_TOKEN'));

    // MCP schema & executeMcpTool ram_slice({ skeleton: true })
    const ramSliceTool = MCP_TOOLS.find((t) => t.name === 'ram_slice');
    assert.ok(ramSliceTool?.inputSchema?.properties?.skeleton, 'ram_slice MCP schema must declare skeleton');
    assert.ok(ramSliceTool?.inputSchema?.properties?.query, 'ram_slice MCP schema must declare query');
    assert.ok(ramSliceTool?.inputSchema?.properties?.maxChars, 'ram_slice MCP schema must declare maxChars');

    const mcpRes = await executeMcpTool('ram_slice', {
      workspaceRoot: tmpWs,
      filePath: 'budget.mjs',
      skeleton: true,
      symbol: 'reconcileSessionBudget',
      query: 'reconcile session budget',
      maxChars: 3200,
    }, { engine: ram });
    assert.equal(mcpRes.isError, false);
    assert.ok(mcpRes.text.includes('[RAM AST Skeleton'));
    assert.ok(mcpRes.text.includes('FOCUS_VERBATIM_SIGNATURE_TOKEN'));
  } finally {
    ram.close();
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
});

test('5. findShortestGraphPath traces k-hop symbol calls, directed vs both, unified doc->import chains, and unreachable pairs', () => {
  const filesMap = new Map([
    ['core/entry.mjs', [
      "import { middleLayer } from './mid.mjs';",
      'export function entryAction(req) { return middleLayer(req); }',
    ].join('\n')],
    ['core/mid.mjs', [
      "import { leafCodec } from './leaf.mjs';",
      'export function middleLayer(v) { return leafCodec(v); }',
    ].join('\n')],
    ['core/leaf.mjs', 'export function leafCodec(x) { return String(x || ""); }\n'],
    ['core/isolated.mjs', 'export function isolatedHelper() { return 42; }\n'],
    ['docs/architecture.md', 'Entry pipeline starts in `core/entry.mjs` before hitting storage.\n'],
  ]);

  const symGraph = buildSymbolCallGraph(filesMap);
  const docGraph = buildDocConfigReferenceGraph(filesMap);
  const forwardDeps = new Map([
    ['core/entry.mjs', new Set(['core/mid.mjs'])],
    ['core/mid.mjs', new Set(['core/leaf.mjs'])],
  ]);
  const reverseDeps = new Map([
    ['core/mid.mjs', new Set(['core/entry.mjs'])],
    ['core/leaf.mjs', new Set(['core/mid.mjs'])],
  ]);

  // 2-hop symbol call path
  const pSym = findShortestGraphPath(symGraph, 'entryAction', 'leafCodec', { maxDepth: 5 });
  assert.equal(pSym.found, true);
  assert.equal(pSym.mode, 'symbol');
  assert.equal(pSym.hops, 2);
  assert.deepEqual(pSym.path.map((n) => n.label), ['entryAction', 'middleLayer', 'leafCodec']);
  assert.ok(pSym.edges.every((e) => e.relation === 'AST_CALL' && e.provenance === 'EXTRACTED'));
  assert.match(pSym.formattedHint, /^🧭 \[GraphPath 2-hop \| EXTRACTED\]/);

  // Directed vs bidirectional reverse traversal
  const revDirected = findShortestGraphPath(symGraph, 'leafCodec', 'entryAction', {
    maxDepth: 5,
    direction: 'directed',
    forwardDeps,
    reverseDeps,
    docRefGraph: docGraph,
  });
  assert.equal(revDirected.found, false);

  const revBoth = findShortestGraphPath(symGraph, 'leafCodec', 'entryAction', {
    maxDepth: 5,
    direction: 'both',
    forwardDeps,
    reverseDeps,
    docRefGraph: docGraph,
  });
  assert.equal(revBoth.found, true);
  assert.equal(revBoth.hops, 2);
  assert.ok(revBoth.edges.some((e) => e.relation === 'AST_CALLED_BY'));

  // Unified doc -> import -> import path
  const pUnified = findShortestGraphPath(symGraph, 'docs/architecture.md', 'core/leaf.mjs', {
    maxDepth: 5,
    direction: 'directed',
    forwardDeps,
    reverseDeps,
    docRefGraph: docGraph,
  });
  assert.equal(pUnified.found, true);
  assert.equal(pUnified.mode, 'unified');
  assert.equal(pUnified.hops, 3);
  assert.deepEqual(
    pUnified.edges.map((e) => e.relation),
    ['DOC_REF', 'IMPORT', 'IMPORT']
  );
  assert.match(pUnified.formattedHint, /DOC_REF\+EXTRACTED/);

  // Unreachable target
  const pMissing = findShortestGraphPath(symGraph, 'entryAction', 'isolatedHelper', {
    maxDepth: 5,
    forwardDeps,
    reverseDeps,
    docRefGraph: docGraph,
  });
  assert.equal(pMissing.found, false);
  assert.equal(pMissing.hops, 0);
});

test('6. buildDocConfigReferenceGraph & queryDocRefsForFile link docs/skills/configs/SQL while filtering generic names and CHANGELOG by default', () => {
  const filesMap = new Map([
    ['core/sessionEngine.mjs', 'export function reconcileSessionBudgetToken(v) { return v; }\n'],
    ['core/index.js', 'export const rootEntry = true;\n'],
    ['other/index.js', 'export const altEntry = true;\n'],
    ['README.md', 'Main engine lives in `core/sessionEngine.mjs`. Avoid bare index.js ambiguity.\n'],
    ['skills/audit/SKILL.md', 'Invoke `reconcileSessionBudgetToken` and inspect index.js manually.\n'],
    ['mcp_config.json', JSON.stringify({ entry: './core/sessionEngine.mjs' })],
    ['db/schema.sql', '-- Reference: core/sessionEngine.mjs\nCREATE TABLE sessions (id TEXT PRIMARY KEY);\n'],
    ['CHANGELOG.md', '## 1.0.0\nUpdated `core/sessionEngine.mjs`.\n'],
  ]);

  const docGraph = buildDocConfigReferenceGraph(filesMap);
  assert.ok(docGraph.codeRefEdgeCount >= 4);

  const defaultRefs = queryDocRefsForFile(docGraph, 'core/sessionEngine.mjs', { includeChangelog: false });
  const docFiles = defaultRefs.refs.map((r) => r.docFile);
  assert.ok(docFiles.includes('mcp_config.json'));
  assert.ok(docFiles.includes('db/schema.sql'));
  assert.ok(docFiles.includes('skills/audit/SKILL.md'));
  assert.ok(docFiles.includes('README.md'));
  assert.equal(docFiles.includes('CHANGELOG.md'), false, 'CHANGELOG.md must be filtered out by default');
  assert.match(defaultRefs.formattedHint, /^📎 \[Doc\/Config Refs \| DOC_REF\]/);

  const withChangelog = queryDocRefsForFile(docGraph, 'core/sessionEngine.mjs', { includeChangelog: true });
  assert.ok(withChangelog.refs.some((r) => r.docFile === 'CHANGELOG.md'));

  const genericRefs = queryDocRefsForFile(docGraph, 'core/index.js');
  assert.equal(genericRefs.totalRefs, 0, 'Bare generic basename index.js must not link ambiguously');
});

test('7. detectArchitectureClusters partitions modules deterministically, computes modularityQ > 0, and surfaces God Nodes', () => {
  const filesMap = new Map([
    ['core/shared.mjs', 'export function sharedLog(x) { return x; }\nexport function sharedCheck(x) { return Boolean(x); }\n'],
    ['auth/login.mjs', "import { sharedLog } from '../core/shared.mjs';\nimport { verifyJwt } from './jwt.mjs';\nexport function doLogin(u) { sharedLog(u); return verifyJwt(u); }\n"],
    ['auth/jwt.mjs', "import { sharedCheck } from '../core/shared.mjs';\nexport function verifyJwt(t) { return sharedCheck(t); }\n"],
    ['auth/session.mjs', "import { verifyJwt } from './jwt.mjs';\nimport { doLogin } from './login.mjs';\nexport function refresh(t) { return verifyJwt(t) && doLogin(t); }\n"],
    ['billing/invoice.mjs', "import { sharedLog } from '../core/shared.mjs';\nimport { calcTax } from './tax.mjs';\nexport function makeInvoice(a) { sharedLog(a); return calcTax(a); }\n"],
    ['billing/tax.mjs', "import { sharedCheck } from '../core/shared.mjs';\nexport function calcTax(a) { return sharedCheck(a) ? a * 1.2 : 0; }\n"],
    ['billing/ledger.mjs', "import { makeInvoice } from './invoice.mjs';\nimport { calcTax } from './tax.mjs';\nexport function closeBook(a) { return makeInvoice(a) + calcTax(a); }\n"],
    ['README.md', 'Core telemetry hub: `core/shared.mjs`.\n'],
    ['config.json', '{"hub":"core/shared.mjs"}\n'],
  ]);

  const forwardDeps = new Map([
    ['auth/login.mjs', new Set(['core/shared.mjs', 'auth/jwt.mjs'])],
    ['auth/jwt.mjs', new Set(['core/shared.mjs'])],
    ['auth/session.mjs', new Set(['auth/jwt.mjs', 'auth/login.mjs'])],
    ['billing/invoice.mjs', new Set(['core/shared.mjs', 'billing/tax.mjs'])],
    ['billing/tax.mjs', new Set(['core/shared.mjs'])],
    ['billing/ledger.mjs', new Set(['billing/invoice.mjs', 'billing/tax.mjs'])],
  ]);
  const reverseDeps = new Map([
    ['core/shared.mjs', new Set(['auth/login.mjs', 'auth/jwt.mjs', 'billing/invoice.mjs', 'billing/tax.mjs'])],
    ['auth/jwt.mjs', new Set(['auth/login.mjs', 'auth/session.mjs'])],
    ['auth/login.mjs', new Set(['auth/session.mjs'])],
    ['billing/tax.mjs', new Set(['billing/invoice.mjs', 'billing/ledger.mjs'])],
    ['billing/invoice.mjs', new Set(['billing/ledger.mjs'])],
  ]);

  const symGraph = buildSymbolCallGraph(filesMap);
  const docGraph = buildDocConfigReferenceGraph(filesMap);

  const run1 = detectArchitectureClusters(filesMap, forwardDeps, reverseDeps, {
    symbolGraph: symGraph,
    docRefGraph: docGraph,
  });
  const run2 = detectArchitectureClusters(filesMap, forwardDeps, reverseDeps, {
    symbolGraph: symGraph,
    docRefGraph: docGraph,
  });

  assert.equal(run1.ok, true);
  assert.equal(run1.fileCount, 7);
  assert.ok(run1.clusterCount >= 2, `Expected >=2 clusters, got ${run1.clusterCount}`);
  assert.ok(run1.modularityQ > 0, `Expected modularityQ > 0, got ${run1.modularityQ}`);
  assert.deepEqual(run1.clusters, run2.clusters, 'Clustering must be strictly deterministic');
  assert.ok(run1.godNodes.length >= 1);
  assert.equal(run1.godNodes[0].file, 'core/shared.mjs');
  assert.equal(run1.godNodes[0].inDegree, 4);
  assert.equal(run1.godNodes[0].docRefCount, 2);
  assert.match(run1.formattedDigest, /^🧩 \[Arch Graph \| 7 code files \|/);
});

test('8. RamMemoryEngine E2E: Blast Radius docRefs, Arch Graph in ContextPack, cache invalidation, and lazy ram_graph_query MCP', async () => {
  const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-graphify-e2e-'));
  const ram = new RamMemoryEngine({ budgetMb: 128 });
  try {
    fs.mkdirSync(path.join(tmpWs, 'core'), { recursive: true });
    fs.mkdirSync(path.join(tmpWs, 'auth'), { recursive: true });
    fs.mkdirSync(path.join(tmpWs, 'billing'), { recursive: true });
    fs.mkdirSync(path.join(tmpWs, 'skills', 'ops'), { recursive: true });

    fs.writeFileSync(
      path.join(tmpWs, 'core', 'shared.mjs'),
      'export function auditSharedAction(x) { return String(x || ""); }\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmpWs, 'auth', 'gate.mjs'),
      "import { auditSharedAction } from '../core/shared.mjs';\nexport function verifyGate(u) { return auditSharedAction(u); }\n",
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmpWs, 'auth', 'route.mjs'),
      "import { verifyGate } from './gate.mjs';\nexport function authRoute(req) { return verifyGate(req.user); }\n",
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmpWs, 'billing', 'pay.mjs'),
      "import { auditSharedAction } from '../core/shared.mjs';\nexport function chargeUser(u) { return auditSharedAction(u); }\n",
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmpWs, 'billing', 'receipt.mjs'),
      "import { chargeUser } from './pay.mjs';\nexport function sendReceipt(u) { return chargeUser(u); }\n",
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmpWs, 'core', 'runner.mjs'),
      "import { authRoute } from '../auth/route.mjs';\nimport { sendReceipt } from '../billing/receipt.mjs';\nexport function runPipeline(req) { return authRoute(req) + sendReceipt(req.user); }\n",
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmpWs, 'skills', 'ops', 'SKILL.md'),
      '# Ops\nUses `core/shared.mjs` (`auditSharedAction`) for audit trails.\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmpWs, 'CHANGELOG.md'),
      '# Changelog\nTouched `core/shared.mjs`.\n',
      'utf8'
    );

    ram.warmWorkspace(tmpWs, { startWatcher: false });
    const ws = ram.getOrCreateWorkspace(tmpWs);
    assert.equal(ws.docRefGraph, null, 'docRefGraph must be lazily built');
    assert.equal(ws.archClusters, null, 'archClusters must be lazily built');

    // Blast Radius includes DOC_REF (without CHANGELOG)
    const blast = ram.getFastBlastRadius(tmpWs, 'core/shared.mjs');
    assert.ok(blast.dependents.length >= 2);
    assert.ok(Array.isArray(blast.docRefs) && blast.docRefs.length === 1);
    assert.equal(blast.docRefs[0].docFile, 'skills/ops/SKILL.md');
    assert.match(blast.formattedHint, /📎 \[Doc\/Config Refs \| DOC_REF\]/);
    assert.equal(blast.formattedHint.includes('CHANGELOG.md'), false);

    // ContextPack (explore) includes Arch Graph digest
    const pack = ram.getContextPack(tmpWs, 'auth billing auditSharedAction architecture', {
      phase: 'explore',
      maxChars: 6000,
    });
    assert.equal(pack.ok, true);
    assert.match(pack.formatted, /🧩 \[Arch Graph/);
    assert.ok(ws.docRefGraph !== null);
    assert.ok(ws.archClusters !== null);

    // Upsert invalidates docRefGraph and archClusters
    fs.writeFileSync(
      path.join(tmpWs, 'skills', 'ops', 'SKILL.md'),
      '# Ops\nUpdated docs referencing `core/shared.mjs` and `auth/gate.mjs`.\n',
      'utf8'
    );
    ram.upsertFile(tmpWs, path.join(tmpWs, 'skills', 'ops', 'SKILL.md'));
    assert.equal(ws.docRefGraph, null, 'upsertFile must invalidate ws.docRefGraph');
    assert.equal(ws.archClusters, null, 'upsertFile must invalidate ws.archClusters');

    // Remove entry invalidates caches too
    ram.getArchitectureClusters(tmpWs);
    assert.ok(ws.archClusters !== null);
    ram.removeEntry(ws, 'CHANGELOG.md');
    assert.equal(ws.docRefGraph, null, 'removeEntry must invalidate ws.docRefGraph');
    assert.equal(ws.archClusters, null, 'removeEntry must invalidate ws.archClusters');

    // MCP schema & mcp_config.json lazy flag
    const graphTool = MCP_TOOLS.find((t) => t.name === 'ram_graph_query');
    assert.ok(graphTool, 'MCP_TOOLS must register ram_graph_query');
    for (const key of ['title', 'readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
      assert.ok(key in (graphTool.annotations || {}), `Missing annotation ${key}`);
    }
    const repoMcpCfg = JSON.parse(fs.readFileSync(path.resolve('mcp_config.json'), 'utf8'));
    assert.equal(repoMcpCfg?.mcpServers?.['ram-memory']?.tools?.ram_graph_query?.eager, false);

    // executeMcpTool modes: path, clusters, god_nodes, doc_refs, explain
    const resPath = await executeMcpTool('ram_graph_query', {
      workspaceRoot: tmpWs,
      mode: 'path',
      from: 'runPipeline',
      to: 'auditSharedAction',
    }, { engine: ram });
    assert.equal(resPath.isError, false);
    assert.match(resPath.text, /🧭 \[GraphPath/);
    assert.ok(resPath.text.includes('auditSharedAction'));

    const resClusters = await executeMcpTool('ram_graph_query', {
      workspaceRoot: tmpWs,
      mode: 'clusters',
    }, { engine: ram });
    assert.equal(resClusters.isError, false);
    assert.match(resClusters.text, /## Architectural Clusters/);

    const resGod = await executeMcpTool('ram_graph_query', {
      workspaceRoot: tmpWs,
      mode: 'god_nodes',
    }, { engine: ram });
    assert.equal(resGod.isError, false);
    assert.match(resGod.text, /## God Nodes/);
    assert.ok(resGod.text.includes('core/shared.mjs'));

    const resDoc = await executeMcpTool('ram_graph_query', {
      workspaceRoot: tmpWs,
      mode: 'doc_refs',
      target: 'core/shared.mjs',
    }, { engine: ram });
    assert.equal(resDoc.isError, false);
    assert.ok(resDoc.text.includes('skills/ops/SKILL.md'));

    const resExplainFile = await executeMcpTool('ram_graph_query', {
      workspaceRoot: tmpWs,
      mode: 'explain',
      target: 'core/shared.mjs',
    }, { engine: ram });
    assert.equal(resExplainFile.isError, false);
    assert.match(resExplainFile.text, /🧭 \[GraphExplain \| File\]/);
    assert.ok(resExplainFile.text.includes('DOC_REF'));

    const resExplainSym = await executeMcpTool('ram_graph_query', {
      workspaceRoot: tmpWs,
      mode: 'explain',
      target: 'verifyGate',
    }, { engine: ram });
    assert.equal(resExplainSym.isError, false);
    assert.match(resExplainSym.text, /🧭 \[GraphExplain \| Symbol\]/);
    assert.ok(resExplainSym.text.includes('auth/gate.mjs'));
  } finally {
    ram.close();
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
});

test('9. Graphify v2 avoids utility-hub mega-clusters and resolves dynamic/realm call targets accurately', () => {
  const filesMap = new Map([
    ['core/safe-json.mjs', 'export function safeReadJsonSync(p) { return p; }\n'],
    ['core/circuit-breaker.mjs', 'export function resetCircuitBreaker(s) { return s; }\n'],
    ['sidecars/panel/ui-src/js/02-telemetry-cards.js', 'function resetCircuitBreaker() { return false; }\n'],
    [
      'sidecars/panel/lib/panel-telemetry-collectors.mjs',
      [
        "import { safeReadJsonSync } from '../../../core/safe-json.mjs';",
        'export async function runReset(scope) {',
        "  const mod = await import('../../../core/circuit-breaker.mjs');",
        '  safeReadJsonSync(scope);',
        '  return mod.resetCircuitBreaker(scope);',
        '}',
      ].join('\n'),
    ],
  ]);

  const forwardDeps = new Map([
    ['sidecars/panel/lib/panel-telemetry-collectors.mjs', new Set(['core/safe-json.mjs', 'core/circuit-breaker.mjs'])],
  ]);
  const reverseDeps = new Map([
    ['core/safe-json.mjs', new Set(['sidecars/panel/lib/panel-telemetry-collectors.mjs'])],
    ['core/circuit-breaker.mjs', new Set(['sidecars/panel/lib/panel-telemetry-collectors.mjs'])],
  ]);

  const domains = [
    ['auth', ['login.mjs', 'jwt.mjs', 'session.mjs', 'guard.mjs']],
    ['billing', ['invoice.mjs', 'tax.mjs', 'ledger.mjs', 'payout.mjs']],
    ['telemetry', ['metrics.mjs', 'trace.mjs', 'export.mjs', 'sink.mjs']],
  ];
  for (const [dir, names] of domains) {
    for (let i = 0; i < names.length; i++) {
      const f = `${dir}/${names[i]}`;
      const nextF = `${dir}/${names[(i + 1) % names.length]}`;
      filesMap.set(f, `import { safeReadJsonSync } from '../core/safe-json.mjs';\nexport function run_${dir}_${i}() { return safeReadJsonSync('${f}'); }\n`);
      forwardDeps.set(f, new Set(['core/safe-json.mjs', nextF]));
      reverseDeps.get('core/safe-json.mjs').add(f);
      if (!reverseDeps.has(nextF)) reverseDeps.set(nextF, new Set());
      reverseDeps.get(nextF).add(f);
    }
  }

  const symGraph = buildSymbolCallGraph(filesMap);
  const runResetEdges = Array.from((symGraph.calleesOf.get('runReset') || new Map()).values());
  const cbEdge = runResetEdges.find((e) => e.name === 'resetCircuitBreaker');
  assert.ok(cbEdge, 'Expected resetCircuitBreaker call edge');
  assert.equal(cbEdge.file, 'core/circuit-breaker.mjs', 'Dynamic import must resolve to core/circuit-breaker.mjs rather than ui-src');
  assert.equal(cbEdge.confidence, 'INFERRED');

  const arch = detectArchitectureClusters(filesMap, forwardDeps, reverseDeps, {
    symbolGraph: symGraph,
    maxClusters: 8,
    maxGodNodes: 5,
  });
  assert.equal(arch.godNodes[0]?.file, 'core/safe-json.mjs');
  assert.ok(arch.clusterCount >= 3, `Expected >=3 domain clusters, got ${arch.clusterCount}`);
  assert.ok(arch.modularityQ > 0.2, `Expected modularityQ > 0.2, got ${arch.modularityQ}`);
  assert.ok(arch.clusters[0].size < Math.ceil(arch.fileCount * 0.7), 'Utility hub must not swallow >=70% of files');
});

test('10. detectArchitectureClusters & findSurprisingConnections validate srcRel and warn on callerDefs count mismatch', () => {
  const filesMap = new Map([
    ['a/modA.mjs', 'export function dupFn() { return 1; }\n'],
    ['b/modB.mjs', 'export function dupFn() { return 2; }\n'],
    ['c/target.mjs', 'export function targetFn() { return 3; }\n'],
  ]);
  const symbolGraph = {
    definedSymbols: new Map([
      ['dupFn', [{ file: 'a/modA.mjs', startLine: 1 }, { file: 'b/modB.mjs', startLine: 1 }]],
      ['targetFn', [{ file: 'c/target.mjs', startLine: 1 }]],
    ]),
    calleesOf: new Map([
      ['dupFn', new Map([['e1', { name: 'targetFn', file: 'c/target.mjs', isRepoSymbol: true }]])],
      ['ghostFn', new Map([['e2', { name: 'targetFn', file: 'c/target.mjs', isRepoSymbol: true }]])],
      ['badPathFn', new Map([['e3', { name: 'targetFn', callerFile: '../outside.mjs', file: 'c/target.mjs', isRepoSymbol: true }]])],
    ]),
  };

  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const arch = detectArchitectureClusters(filesMap, null, null, { symbolGraph });
    assert.equal(arch.ok, true);
    assert.ok(warnings.some((w) => w.includes('dupFn') && w.includes('expected 1, got 2')));
    assert.ok(warnings.some((w) => w.includes('ghostFn') && w.includes('expected 1, got 0')));

    const beforeBridgesWarnCount = warnings.length;
    const bridges = findSurprisingConnections(filesMap, arch, symbolGraph, null, { topN: 6 });
    assert.ok(Array.isArray(bridges));
    assert.ok(warnings.length > beforeBridgesWarnCount, 'findSurprisingConnections must also log callerDefs mismatch');
  } finally {
    console.warn = origWarn;
  }
});

test('10. pickBestCallTargetDef guards empty/invalid pools and normalizePosixRel rejects invalid paths before split', () => {
  assert.equal(normalizePosixRel(''), '');
  assert.equal(normalizePosixRel('   '), '');
  assert.equal(normalizePosixRel('.'), '');
  assert.equal(normalizePosixRel('./'), '');
  assert.equal(normalizePosixRel('/'), '');
  assert.equal(normalizePosixRel('///'), '');
  assert.equal(normalizePosixRel(null), '');
  assert.equal(normalizePosixRel(undefined), '');
  assert.equal(normalizePosixRel({}), '');
  assert.equal(normalizePosixRel('././core\\\\utils//a.mjs'), 'core/utils/a.mjs');

  assert.equal(pickBestCallTargetDef('core/a.mjs', [], new Set()), null);
  assert.equal(pickBestCallTargetDef('core/a.mjs', null, new Set()), null);
  assert.equal(pickBestCallTargetDef('core/a.mjs', [null, {}, { file: '' }, { file: '   ' }], new Set()), null);

  const picked = pickBestCallTargetDef(
    './',
    [{ file: 'core/b.mjs', startLine: 1 }, { file: 'utils/b.mjs', startLine: 1 }],
    new Set()
  );
  assert.equal(picked?.file, 'core/b.mjs');

  const closest = pickBestCallTargetDef(
    'core/sub/caller.mjs',
    [{ file: 'other/target.mjs', startLine: 1 }, { file: 'core/sub/target.mjs', startLine: 1 }],
    new Set()
  );
  assert.equal(closest?.file, 'core/sub/target.mjs');
});

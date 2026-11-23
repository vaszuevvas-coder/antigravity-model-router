import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  computeBipartiteSymbolPPR,
  findNearDuplicateFunctions,
  buildWorkspaceSimHashIndex,
  queryCoChangePartners,
  verifyExportArityAndKeyContracts,
} from '../core/cpu-graph-contracts.mjs';
import {
  computeOchiaiScores,
  extractDeterministicFactTable,
  healSearchBlockBitapAst,
  localizeFaultWithV8Sbfl,
  skimAstBranchesWithBraceBalance,
} from '../core/cpu-sbfl-healer.mjs';
import { computePatchedContent } from '../core/diff-patcher.mjs';
import { runImpactedMicroTests } from '../core/auto-verifier.mjs';
import { RamMemoryEngine } from '../core/ram-memory-engine.mjs';

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('1. Multi-Signal Bipartite Symbol PPR surfaces 2..3-hop bridge nodes absent from query', () => {
  const filesMap = new Map([
    ['ui/view.mjs', [
      "import { dispatchAction } from '../ctrl/controller.mjs';",
      'export function renderUiButton(ctx) {',
      '  return dispatchAction(ctx);',
      '}',
    ].join('\n')],
    ['ctrl/controller.mjs', [
      "import { resolveBridgeRoute } from '../core/bridgeService.mjs';",
      'export function dispatchAction(ctx) {',
      '  return resolveBridgeRoute(ctx);',
      '}',
    ].join('\n')],
    ['core/bridgeService.mjs', [
      "import { fetchSecretKey } from '../vault/tokenVault.mjs';",
      'export function resolveBridgeRoute(ctx) {',
      '  return fetchSecretKey(ctx.id);',
      '}',
    ].join('\n')],
    ['vault/tokenVault.mjs', [
      'export function fetchSecretKey(id) {',
      '  return `tok_${id}`;',
      '}',
    ].join('\n')],
  ]);

  const ppr = computeBipartiteSymbolPPR(filesMap, null, {
    query: 'renderUiButton fetchSecretKey',
    topK: 6,
  });
  assert.equal(ppr.ok, true);
  assert.ok(ppr.bridgeNodes.length >= 1, 'Expected 2..3-hop bridge nodes');
  assert.ok(
    ppr.bridgeNodes.some((b) => b.name === 'resolveBridgeRoute' || b.name === 'dispatchAction'),
    `Expected resolveBridgeRoute/dispatchAction in bridgeNodes, got ${JSON.stringify(ppr.bridgeNodes)}`
  );
  assert.match(ppr.formattedHint, /\[CPU PPR Bridges\]/);
});

test('2. Git Co-Change Coupling uncovers implicit HTML<->Server pairing in Blast Radius', () => {
  const tmpGit = makeTempDir('amr-sota-git-');
  try {
    fs.mkdirSync(path.join(tmpGit, 'api'), { recursive: true });
    fs.mkdirSync(path.join(tmpGit, 'ui'), { recursive: true });
    execFileSync('git', ['init'], { cwd: tmpGit, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmpGit, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmpGit, stdio: 'ignore' });

    for (let i = 1; i <= 3; i++) {
      fs.writeFileSync(path.join(tmpGit, 'api', 'server.mjs'), `export const PORT = ${3000 + i};\n`, 'utf8');
      fs.writeFileSync(path.join(tmpGit, 'ui', 'panel.html'), `<div id="p">${i}</div>\n`, 'utf8');
      execFileSync('git', ['add', '.'], { cwd: tmpGit, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', `sync ${i}`], { cwd: tmpGit, stdio: 'ignore' });
    }
    fs.writeFileSync(path.join(tmpGit, 'README.md'), '# Notes\n', 'utf8');
    execFileSync('git', ['add', 'README.md'], { cwd: tmpGit, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'docs only'], { cwd: tmpGit, stdio: 'ignore' });

    const res = queryCoChangePartners(tmpGit, 'api/server.mjs', { minSupport: 2, minConfidence: 0.5 });
    assert.equal(res.ok, true);
    assert.ok(res.implicitPartners.some((p) => p.file === 'ui/panel.html' && p.confidence >= 0.8));

    const ram = new RamMemoryEngine({ budgetMb: 64 });
    try {
      ram.ensureWarm(tmpGit);
      const blast = ram.getFastBlastRadius(tmpGit, 'api/server.mjs');
      assert.match(blast.formattedHint, /\[Git Co-Change\]/);
      assert.match(blast.formattedHint, /ui\/panel\.html/);
    } finally {
      ram.close();
    }
  } finally {
    fs.rmSync(tmpGit, { recursive: true, force: true });
  }
});

test('3. SBFL Ochiai via NODE_V8_COVERAGE localizes buggy function in unit & runImpactedMicroTests', async () => {
  const pureScores = computeOchiaiScores([
    {
      passed: true,
      coveredFunctions: [
        { file: 'src/calc.mjs', functionName: 'addOk', startLine: 1, endLine: 3, count: 1 },
      ],
    },
    {
      passed: false,
      coveredFunctions: [
        { file: 'src/calc.mjs', functionName: 'addOk', startLine: 1, endLine: 3, count: 1 },
        { file: 'src/calc.mjs', functionName: 'buggyDiscount', startLine: 5, endLine: 8, count: 1 },
      ],
    },
  ], { excludeTestFiles: false });
  assert.equal(pureScores[0].functionName, 'buggyDiscount');
  assert.equal(pureScores[0].ochiai, 1);
  assert.ok(pureScores[1].ochiai < 0.75);

  const tmpSbfl = makeTempDir('amr-sota-sbfl-');
  try {
    fs.writeFileSync(path.join(tmpSbfl, 'math-engine.mjs'), [
      'export function addOk(a, b) {',
      '  return a + b;',
      '}',
      '',
      'export function buggyDiscount(price, pct) {',
      '  const broken = price + pct;',
      '  return broken;',
      '}',
    ].join('\n'), 'utf8');

    const passingTest = path.join(tmpSbfl, 'math-ok.test.mjs');
    fs.writeFileSync(passingTest, [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { addOk } from './math-engine.mjs';",
      "test('addOk works', () => { assert.equal(addOk(2, 3), 5); });",
    ].join('\n'), 'utf8');

    const failingTest = path.join(tmpSbfl, 'math-engine.test.mjs');
    fs.writeFileSync(failingTest, [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { addOk, buggyDiscount } from './math-engine.mjs';",
      "test('discount fails', () => {",
      '  assert.equal(addOk(1, 2), 3);',
      '  assert.equal(buggyDiscount(100, 10), 90);',
      '});',
    ].join('\n'), 'utf8');

    const sbfl = await localizeFaultWithV8Sbfl({
      rootDir: tmpSbfl,
      failingTestPath: failingTest,
      passingTestPaths: [passingTest],
      editedFile: 'math-engine.mjs',
      timeoutMs: 3000,
    });
    assert.equal(sbfl.ok, true);
    assert.equal(sbfl.suspects[0].functionName, 'buggyDiscount');
    assert.ok(sbfl.suspects[0].ochiai >= 0.99);
    assert.match(sbfl.formattedPin, /\[CPU SBFL Ochiai\].*buggyDiscount/);

    const micro = await runImpactedMicroTests({
      rootDir: tmpSbfl,
      filePath: 'math-engine.mjs',
      reverseImporters: [passingTest],
      timeoutMs: 3500,
      runLinterPrecheck: false,
    });
    assert.equal(micro.valid, false);
    assert.match(micro.error, /\[CPU SBFL Ochiai\]/);
    assert.ok(Array.isArray(micro.sbflSuspects) && micro.sbflSuspects[0].functionName === 'buggyDiscount');
  } finally {
    fs.rmSync(tmpSbfl, { recursive: true, force: true });
  }
});

test('4. Cross-File Arity & Destructured-Key Guard catches broken signatures in RAM', () => {
  const libText = [
    'export function calcPrice(base, taxRate, currency) {',
    '  return `${base * (1 + taxRate)} ${currency}`;',
    '}',
    'export function initPool({ maxThreads, timeoutMs }) {',
    '  return maxThreads + timeoutMs;',
    '}',
  ].join('\n');

  const badCaller = [
    "import { calcPrice, initPool } from './lib.mjs';",
    'const x = calcPrice(100);',
    'const y = initPool({ maxThreads: 4 });',
  ].join('\n');

  const res = verifyExportArityAndKeyContracts('lib.mjs', libText, [{ file: 'caller.mjs', text: badCaller }]);
  assert.equal(res.valid, false);
  assert.ok(res.issues.some((i) => i.type === 'arity_mismatch' && i.symbol === 'calcPrice'));
  assert.ok(res.issues.some((i) => i.type === 'destructured_key_mismatch' && i.symbol === 'initPool'));
  assert.match(res.formattedAlert, /\[CPU Arity\/Contract Guard\]/);

  const tmpWs = makeTempDir('amr-sota-arity-');
  const ram = new RamMemoryEngine({ budgetMb: 64 });
  try {
    fs.writeFileSync(path.join(tmpWs, 'lib.mjs'), libText, 'utf8');
    fs.writeFileSync(path.join(tmpWs, 'caller.mjs'), badCaller, 'utf8');
    ram.ensureWarm(tmpWs);
    const ramCheck = ram.verifyContractsInRam(tmpWs, 'lib.mjs');
    assert.equal(ramCheck.valid, false);
    assert.ok(ramCheck.semanticIssues.some((i) => i.type === 'arity_mismatch'));

    fs.writeFileSync(
      path.join(tmpWs, 'caller.mjs'),
      "import { calcPrice, initPool } from './lib.mjs';\ncalcPrice(100, 0.2, 'RUB');\ninitPool({ maxThreads: 4, timeoutMs: 500 });\n",
      'utf8'
    );
    ram.upsertFile(tmpWs, path.join(tmpWs, 'caller.mjs'), { rebuildDeps: true });
    const cleanCheck = ram.verifyContractsInRam(tmpWs, 'lib.mjs');
    assert.equal(cleanCheck.valid, true);
  } finally {
    ram.close();
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
});

test('5. Bitap Elastic AST Patch Healer snaps drifted blank lines/comments and rejects ambiguity', () => {
  const original = [
    'export function processTask(cfg) {',
    '    const limit = cfg.maxItems || 10; // old comment',
    '',
    '    const ratio = limit * 2;',
    '    return ratio + 1;',
    '}',
  ].join('\n');

  const patch = [
    '<<<<<<< SEARCH',
    '  const limit = cfg.maxItems || 10;',
    '  const ratio = limit * 2;',
    '  return ratio + 1;',
    '=======',
    '  const limit = cfg.maxItems || 20;',
    '  const ratio = limit * 3;',
    '  return ratio + 1;',
    '>>>>>>> REPLACE',
  ].join('\n');

  const patched = computePatchedContent(original, patch);
  assert.equal(patched.appliedBlocks, 1);
  assert.equal(patched.fuzzySnappedBlocks, 1);
  assert.match(patched.nextContent, /    const limit = cfg\.maxItems \|\| 20;\n    const ratio = limit \* 3;/);

  const dupOriginal = [
    'function a() {\n  const x = 1;\n  return x + 2;\n}',
    'function b() {\n  const x = 1;\n  return x + 2;\n}',
  ].join('\n\n');
  const amb = healSearchBlockBitapAst(dupOriginal, 'const x = 1;\nreturn x + 3;', 'const x = 2;\nreturn x + 3;');
  assert.equal(amb.healed, false);
  assert.equal(amb.reason, 'ambiguous');
});

test('6. Brace-Balanced Intra-Function Goal Skimmer preserves data-flow decls & brace balance', () => {
  const bodyLines = [
    'export function processPipeline(mode, cfg) {',
    '  const cacheBudget = cfg.budget || 512;',
    '  const alphaFlag = Boolean(cfg.alpha);',
  ];
  for (let i = 0; i < 4; i++) {
    bodyLines.push(`  if (mode === 'noise_${i}') {`);
    bodyLines.push(`    const stepA_${i} = alphaFlag ? ${i} : 0;`);
    bodyLines.push(`    if (stepA_${i} > 0) { console.log('noop'); }`);
    bodyLines.push('    return stepA_' + i + ';');
    bodyLines.push('  }');
  }
  bodyLines.push("  if (mode === 'billing') {");
  bodyLines.push('    return chargeUser(cacheBudget);');
  bodyLines.push('  }');
  bodyLines.push('  return null;');
  bodyLines.push('}');

  const res = skimAstBranchesWithBraceBalance(bodyLines.join('\n'), 'billing chargeUser', { maxLines: 14 });
  assert.equal(res.skimmed, true);
  assert.match(res.formatted, /chargeUser\(cacheBudget\)/);
  assert.match(res.formatted, /const cacheBudget = cfg\.budget \|\| 512/);
  assert.match(res.formatted, /folded \(brace-balanced\)/);

  const openCount = (res.formatted.match(/\{/g) || []).length;
  const closeCount = (res.formatted.match(/\}/g) || []).length;
  assert.equal(openCount, closeCount, 'Skimmed output must maintain exact curly-brace balance');
});

test('7. 64-Bit SimHash Clone Radar & Deterministic Session Fact Table', () => {
  const fnA = [
    'export function acquireLockSafe(targetPath, maxWait) {',
    '  const startTs = Date.now();',
    '  let retries = 0;',
    '  while (Date.now() - startTs < maxWait) {',
    '    if (!targetPath) {',
    '      return { ok: false, reason: "empty" };',
    '    }',
    '    retries += 1;',
    '    if (retries > 3) {',
    '      break;',
    '    }',
    '  }',
    '  return { ok: true, retries };',
    '}',
  ].join('\n');

  const fnB = [
    'export function grabMutexWrapper(lockFile, timeoutLimit) {',
    '  const startedAt = Date.now();',
    '  let attempts = 0;',
    '  while (Date.now() - startedAt < timeoutLimit) {',
    '    if (!lockFile) {',
    '      return { ok: false, reason: "missing" };',
    '    }',
    '    attempts += 1;',
    '    if (attempts > 3) {',
    '      break;',
    '    }',
    '  }',
    '  return { ok: true, retries: attempts };',
    '}',
  ].join('\n');

  const idx = buildWorkspaceSimHashIndex(new Map([['core/lock-a.mjs', fnA]]));
  const dup = findNearDuplicateFunctions(idx, 'core/lock-b.mjs', fnB);
  assert.ok(dup.clones.length >= 1, 'Expected SimHash to detect renamed-variable structural clone');
  assert.ok(dup.clones[0].similarityPct >= 88);
  assert.match(dup.formattedHint, /\[CPU SimHash Reuse Radar\]/);

  const tmpWs = makeTempDir('amr-sota-simhash-');
  const ram = new RamMemoryEngine({ budgetMb: 64 });
  try {
    fs.writeFileSync(path.join(tmpWs, 'lock-a.mjs'), fnA, 'utf8');
    fs.writeFileSync(path.join(tmpWs, 'lock-b.mjs'), fnB, 'utf8');
    ram.ensureWarm(tmpWs);
    const check = ram.verifyContractsInRam(tmpWs, 'lock-b.mjs');
    assert.equal(check.valid, true, 'SimHash clone radar must remain non-blocking advisory');
    assert.match(check.cloneWarning, /\[CPU SimHash Reuse Radar\]/);
  } finally {
    ram.close();
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }

  const factMd = extractDeterministicFactTable([
    {
      tool_calls: [
        { name: 'edit_file', args: { Path: 'core/cpu-sbfl-healer.mjs' } },
        { name: 'run_command', args: { CommandLine: 'node --test tests/cpu-sota-suite.test.mjs' } },
      ],
      content: 'Verified computeBipartiteSymbolPPR and CPU_SOTA_FLAG twice: computeBipartiteSymbolPPR ok.',
    },
  ]);
  assert.match(factMd, /CPU Deterministic Fact Table/);
  assert.match(factMd, /cpu-sbfl-healer\.mjs/);
  assert.match(factMd, /computeBipartiteSymbolPPR/);
});

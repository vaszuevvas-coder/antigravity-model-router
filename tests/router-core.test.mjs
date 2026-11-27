import { ROOT_DIR, SUITE_CACHE_DIR, makeTempDir, registerSuiteLifecycle } from './helpers/router-test-env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import {
  attachSidecarSecurityMiddleware,
  collectTelemetry,
  isAllowedLoopbackHost,
  loadState,
  sanitizeStatePatch,
} from '../sidecars/panel/server.mjs';
import { checkCommandSecurity, checkFileSecurity } from '../core/security-guard.mjs';
import { RamMemoryEngine } from '../core/ram-memory-engine.mjs';
import { atomicWriteJsonSync, withFileLockSync } from '../core/safe-json.mjs';
import { evaluateSelectorMatchForTask, isSubagentTranscriptFile, resolveEffectivePreTaskGatePolicy } from '../core/model-profile.mjs';
import { detectSwarmExecutionRole, parseSwarmStatsFromTranscriptLines } from '../core/swarm-controller.mjs';
import {
  evaluateBayesianRoute,
  extractDirKey,
  getBayesianSummary,
  recordModelOutcome,
  sampleThompsonConfidence,
} from '../core/bayesian-router.mjs';
import { extractFileAllMetadata, verifyImportContracts, verifySemanticContracts } from '../core/repo-mapper.mjs';
import { checkOverwriteGuard, computePatchedContent, simulateToolEditInMemory } from '../core/diff-patcher.mjs';
import { maskTerminalOutput } from '../core/obs-masker.mjs';
import {
  buildAdaptive3DOptionsBlueprint,
  computeTask3DMatrix,
  detectPromptIntentSignals,
  estimateTaskGradeAndThinkingBudget,
  stripUiTitlesForIntentClassification,
} from '../core/tool-pruner.mjs';
import { handlePreInvocation, handlePreToolUse, isGenericBoilerplateAskOptions } from '../core/hook-runner.mjs';
import { restoreRouterProfile } from '../core/router-cli.mjs';
import { shutdownCpuPool } from '../core/cpu-worker-pool.mjs';
import { formatSemanticSearchHeader } from '../core/ram-memory-mcp.mjs';
import { formatCompactProcessError, popCascadeAlert, recordVerifyAndCheckCascade } from '../core/auto-verifier.mjs';
import { recordEditStateHash, resetCircuitBreaker } from '../core/circuit-breaker.mjs';
import { createShadowCheckpoint, listCheckpoints } from '../core/shadow-guard.mjs';
import { sliceSourceCode } from '../skills/program-slicer-ocd/scripts/slice-variable.mjs';
import { minimizeChunksParallel } from '../skills/delta-bug-minimizer/scripts/ddmin-runner.mjs';
import {
  clearPitfalls,
  listPitfalls,
  recordPitfall,
  resolvePitfallsForFile,
} from '../core/pitfall-ledger.mjs';
import { pruneRootOrphans, sanitizeMergedState } from '../install.js';
import { syncMcpRamBudget } from '../core/hardware-profiler.mjs';

registerSuiteLifecycle(test, { cleanupFns: [shutdownCpuPool] });

test('2. Security Guard Win32 prefix / token parser & RamMemoryEngine containment', async () => {
  const ws = makeTempDir('amr-sec-');
  try {
    assert.equal(checkFileSecurity({ filePath: '\\\\?\\C:\\project\\.env', workspaceRoot: 'C:\\project' }).allow, false);
    assert.equal(checkFileSecurity({ filePath: '\\\\.\\C:\\project\\.env', workspaceRoot: 'C:\\project' }).allow, false);
    assert.equal(checkCommandSecurity({ commandLine: 'cmd /c type .env', workspaceRoot: ws }).allow, false);
    assert.equal(checkCommandSecurity({ commandLine: 'rm -rf /', workspaceRoot: ws }).allow, false);
    assert.equal(checkCommandSecurity({ commandLine: 'rd C:\\ /s /q', workspaceRoot: ws }).allow, false);
    assert.equal(checkCommandSecurity({ commandLine: 'rm -rf dist/', workspaceRoot: ws }).allow, true);
    assert.equal(checkCommandSecurity({ commandLine: 'rm -rf ./build/', workspaceRoot: ws }).allow, true);
    assert.equal(checkCommandSecurity({ commandLine: 'rm -rf C:/project/dist/', workspaceRoot: ws }).allow, true);

    fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'src', 'ok.mjs'), 'export const ok = 42;\n', 'utf8');
    fs.writeFileSync(path.join(ws, '.env'), 'SECRET=topsecret123456\n', 'utf8');

    const ramEngine = new RamMemoryEngine({ budgetMb: 128 });
    try {
      await ramEngine.warmWorkspaceAsync(ws, { startWatcher: false });
      assert.equal(ramEngine.slice(ws, '../../.env').ok, false);
      assert.equal(ramEngine.slice(ws, '.env').ok, false);
      assert.equal(ramEngine.upsertFile(ws, '.env'), null);
      assert.equal(ramEngine.slice(ws, 'src/ok.mjs').ok, true);
    } finally {
      ramEngine.close();
    }
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('3. Safe JSON lock ownership preservation and undefined coercion', () => {
  const dir = makeTempDir('amr-safe-');
  try {
    const targetFile = path.join(dir, 'state.json');
    const lockDir = `${targetFile}.lock`;
    withFileLockSync(targetFile, () => {
      // Simulate another worker claiming the lock directory after stale expiry
      fs.writeFileSync(path.join(lockDir, 'owner'), 'other-pid-token', 'utf8');
    });
    assert.equal(fs.existsSync(lockDir), true);

    const undefFile = path.join(dir, 'undef.json');
    atomicWriteJsonSync(undefFile, undefined);
    assert.equal(fs.readFileSync(undefFile, 'utf8'), 'null');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('4. Model Profile: subagent transcript detection & Hydrogen Smart-Synergy', () => {
  const dir = makeTempDir('amr-mp-');
  try {
    const subPath = path.join(dir, 'sub.jsonl');
    fs.writeFileSync(
      subPath,
      JSON.stringify({ type: 'USER_INPUT', source: 'SYSTEM', content: '[Message] sender="parent" Do work' }) + '\n',
      'utf8'
    );
    const mainPath = path.join(dir, 'main.jsonl');
    fs.writeFileSync(
      mainPath,
      JSON.stringify({ type: 'USER_INPUT', source: 'USER_EXPLICIT', content: 'Fix bug please' }) + '\n',
      'utf8'
    );

    assert.equal(isSubagentTranscriptFile(subPath), true);
    assert.equal(isSubagentTranscriptFile(mainPath), false);

    const gate = resolveEffectivePreTaskGatePolicy({
      state: { confirmBeforeRun: true, confirmThreshold: 'M', orchestratorSmartSynergy: true },
      modelProfile: { isHydrogen: true, isOrchestrator: false },
      grade: 'M',
    });
    assert.equal(gate.shouldAskModelGate, false);
    assert.equal(gate.orchestratorBypassSM, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('5. Swarm Controller: coordinator guard & sharded model switch telemetry', () => {
  const roleRes = detectSwarmExecutionRole({
    conversationId: `conv-test-${process.pid}`,
    toolCall: { name: 'swarm' },
    lastUserInput: 'Analyze literal text mentioning <swarm_worker> inside coordinator prompt',
  });
  assert.equal(roleRes.role, 'coordinator');

  const lines = [
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [
        { name: 'swarm', args: { action: 'add', name: 'author', n: 2, model: 'gemini-4-hydrogen-medium', workspace: 'share' } },
      ],
    }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [
        { name: 'swarm', args: { action: 'model', name: 'author', model: 'gemini-4-carbon-high' } },
      ],
    }),
  ];
  const stats = parseSwarmStatsFromTranscriptLines(lines);
  assert.equal(stats.active, true);
  assert.equal(stats.members.length, 2);
  assert.equal(stats.members[0].model, 'gemini-4-carbon-high');
  assert.equal(stats.members[1].model, 'gemini-4-carbon-high');
});

test('6. Bayesian Router: extractDirKey ignores Windows drive letters', () => {
  assert.equal(extractDirKey('C:/foo.mjs'), 'dir:root');
  assert.equal(extractDirKey('D:\\main.js'), 'dir:root');
  assert.equal(extractDirKey('src/core/hook-runner.mjs'), 'dir:core');
});

test('7. Repo Mapper: multi-line imports, strict relative contracts, escaped $ callRegex', () => {
  const repo = makeTempDir('amr-repo-');
  try {
    fs.mkdirSync(path.join(repo, 'src', 'other'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src', 'lib.mjs'), 'export const alpha = 1;\nexport const gamma = 2;\n', 'utf8');
    fs.writeFileSync(path.join(repo, 'src', 'other', 'lib.mjs'), 'export const beta = 9;\n', 'utf8');

    const consumerCode = `import {\n  alpha,\n  beta\n} from './lib.mjs';\nconsole.log(alpha, beta);\n`;
    fs.writeFileSync(path.join(repo, 'src', 'consumer.mjs'), consumerCode, 'utf8');
    fs.writeFileSync(
      path.join(repo, 'src', 'unrelated.mjs'),
      `import {\n  beta\n} from './other/lib.mjs';\nconsole.log(beta);\n`,
      'utf8'
    );

    const dollarLib = 'export function $configure({ okKey = 1 }) {\n  return okKey;\n}\n';
    fs.writeFileSync(path.join(repo, 'src', 'dollar.mjs'), dollarLib, 'utf8');
    fs.writeFileSync(
      path.join(repo, 'src', 'caller.mjs'),
      "import { $configure } from './dollar.mjs';\n$configure({ badKey: 2 });\n",
      'utf8'
    );

    const meta = extractFileAllMetadata('.mjs', consumerCode);
    assert.ok(meta.imports.includes('./lib.mjs'));

    const impRes = verifyImportContracts(repo, 'src/lib.mjs');
    assert.equal(impRes.valid, false);
    assert.equal(impRes.brokenImports.length, 1);
    assert.equal(impRes.brokenImports[0].dependentFile, 'src/consumer.mjs');
    assert.deepEqual(impRes.brokenImports[0].missingSymbols, ['beta']);

    const semRes = verifySemanticContracts(repo, 'src/dollar.mjs');
    assert.equal(semRes.valid, false);
    assert.ok(semRes.issues.some((iss) => (
      iss.type === 'param_key_mismatch' &&
      String(iss.detail || '').includes('$configure') &&
      String(iss.detail || '').includes('badKey')
    )));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('9. Diff Patcher empty SEARCH guard & Obs Masker redaction + CLI flag order', () => {
  const dir = makeTempDir('amr-diff-');
  try {
    assert.throws(
      () => computePatchedContent('const a = 1;', '<<<<<<< SEARCH\n   \n=======\nconst b = 2;\n>>>>>>> REPLACE'),
      /empty|whitespace/i
    );

    const sampleFile = path.join(dir, 'sample.mjs');
    fs.writeFileSync(sampleFile, 'export const a = 1;\n', 'utf8');
    const sim = simulateToolEditInMemory('edit_file', { Path: sampleFile, Target: '', Replacement: 'x' });
    assert.equal(sim.checked, false);

    const fakeSk = ['sk', '1234567890abcdefghijklmnop'].join('-');
    const fakeSkProj = ['sk', 'proj', '1234567890abcdefghijklmnop'].join('-');
    const maskedRes = maskTerminalOutput(`AUTH ${fakeSk} done`, 0);
    assert.equal(maskedRes.masked.includes(fakeSk), false);

    const cliRes = spawnSync(
      process.execPath,
      [path.join(ROOT_DIR, 'core', 'obs-masker.mjs'), '--gpu', `hello\ntoken=${fakeSkProj}`],
      { cwd: ROOT_DIR, encoding: 'utf8' }
    );
    assert.equal(cliRes.status, 0);
    assert.match(cliRes.stdout, /hello/);
    assert.equal(cliRes.stdout.includes('--gpu'), false);
    assert.equal(cliRes.stdout.includes(fakeSkProj.slice(0, 18)), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('10. Tool Pruner, Router CLI restore traversal guard, and ESM Installer hygiene', () => {
  const budgetRes = estimateTaskGradeAndThinkingBudget(
    'Исправь дизайн модалки, кнопка не работает',
    { thinkingLimiter: true, strategy: 'flash_dispatcher' },
    {}
  );
  assert.equal('codEnabled' in budgetRes, false);
  assert.ok(Array.isArray(budgetRes.compiledSpec?.matchedIds));
  assert.ok(budgetRes.compiledSpec.matchedIds.includes('UI_DESIGN'));

  const blockedRestore = restoreRouterProfile(path.join(os.tmpdir(), 'outside-backup.json'));
  assert.equal(blockedRestore.ok, false);

  const sanitized = sanitizeMergedState({
    chainOfDraft: true,
    splitExecution: true,
    gpuModelsDir: '',
  });
  assert.equal('chainOfDraft' in sanitized, false);
  assert.equal('splitExecution' in sanitized, false);
  assert.equal(sanitized.gpuModelsDir, '');

  const dir = makeTempDir('amr-inst-');
  try {
    const mockSrc = path.join(dir, 'src');
    const mockDest = path.join(dir, 'dest');
    fs.mkdirSync(mockSrc, { recursive: true });
    fs.mkdirSync(path.join(mockDest, 'constructor'), { recursive: true });
    fs.mkdirSync(path.join(mockDest, '.git'), { recursive: true });
    fs.mkdirSync(path.join(mockDest, '.cache'), { recursive: true });
    fs.writeFileSync(path.join(mockSrc, 'plugin.json'), '{}', 'utf8');
    fs.writeFileSync(path.join(mockDest, 'plugin.json'), '{}', 'utf8');
    fs.writeFileSync(path.join(mockDest, 'install.js'), '// old', 'utf8');
    fs.writeFileSync(path.join(mockDest, 'router-state.json'), '{}', 'utf8');
    fs.writeFileSync(path.join(mockDest, 'mcp_config.json'), '{}', 'utf8');
    fs.writeFileSync(path.join(mockDest, '.cache', 'keep.json'), '{}', 'utf8');

    const removed = pruneRootOrphans(mockSrc, mockDest);
    assert.equal(removed, 3);
    assert.equal(fs.existsSync(path.join(mockDest, 'constructor')), false);
    assert.equal(fs.existsSync(path.join(mockDest, 'install.js')), false);
    assert.equal(fs.existsSync(path.join(mockDest, '.git')), false);
    assert.equal(fs.existsSync(path.join(mockDest, '.cache', 'keep.json')), true);
    assert.equal(fs.existsSync(path.join(mockDest, 'router-state.json')), true);
    assert.equal(fs.existsSync(path.join(mockDest, 'mcp_config.json')), true);
    assert.equal(fs.existsSync(path.join(mockDest, 'plugin.json')), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('11. v3.8 Polish: Hybrid GPU+CPU MCP header, RepoMap string-literal guard, Pitfall isolation & auto-heal', () => {
  const cpuHeader = formatSemanticSearchHeader({
    mode: 'hybrid_gpu_cpu_rerank',
    model: 'qwen3-embedding:0.6b',
    elapsedMs: 18,
    rerankElapsedMs: 1,
    totalChunksSearched: 1146,
  });
  assert.match(cpuHeader, /^\[🎮 Hybrid GPU\+CPU\+RAM Search \| qwen3-embedding:0\.6b \| 18ms \+ 1ms CPU \| 1146 chunks\]/);
  assert.equal(cpuHeader.includes('RAM Lexical Fallback'), false);

  const gpuHeader = formatSemanticSearchHeader({
    mode: 'hybrid_gpu_ram',
    model: 'qwen3-embedding:0.6b',
    elapsedMs: 22,
    totalChunksSearched: 500,
  });
  assert.match(gpuHeader, /^\[🎮 Hybrid GPU\+RAM Search \| qwen3-embedding:0\.6b \| 22ms \| 500 chunks\]/);

  const slicerCode = fs.readFileSync(
    path.join(ROOT_DIR, 'skills', 'program-slicer-ocd', 'scripts', 'slice-variable.mjs'),
    'utf8'
  );
  const slicerMeta = extractFileAllMetadata('.mjs', slicerCode);
  assert.equal(slicerMeta.semanticMeta.docSummary, '');
  assert.equal(slicerMeta.semanticMeta.docSummary.includes('trimmed.startsWith'), false);

  const errSummary = formatCompactProcessError({
    stdout: '✖ test failed\nAssertionError [ERR_ASSERTION]: expected 1 to equal 2\n    at TestContext.<anonymous> (file:///app/x.test.mjs:10:12)\nℹ tests 1\nℹ fail 1',
  });
  assert.match(errSummary, /AssertionError/);
  assert.equal(errSummary.includes('ℹ fail 1'), false);

  const ws1 = makeTempDir('amr-pf-a-');
  const ws2 = makeTempDir('amr-pf-b-');
  try {
    recordPitfall({
      type: 'test_failure',
      fileName: 'mod.mjs',
      summary: 'Test-Impact fail (mod.test.mjs): fail 1',
      workspaceRoot: ws1,
    });
    recordPitfall({
      type: 'test_failure',
      fileName: 'mod.mjs',
      summary: 'Test-Impact fail (mod.test.mjs): fail 2',
      workspaceRoot: ws1,
    });
    recordPitfall({
      type: 'syntax_error',
      fileName: 'mod.mjs',
      summary: 'Syntax error (node) in mod.mjs: Unexpected token',
      workspaceRoot: ws1,
    });
    recordPitfall({
      type: 'rollback',
      fileName: 'mod.mjs',
      summary: 'Rollback (edit_file): keep important lesson',
      workspaceRoot: ws1,
    });
    recordPitfall({
      type: 'test_failure',
      fileName: 'other.mjs',
      summary: 'Test-Impact fail (other.test.mjs): other ws error',
      workspaceRoot: ws2,
    });

    const list1Before = listPitfalls(15, ws1);
    assert.equal(list1Before.length, 3);
    assert.equal(list1Before.some((x) => x.fileName === 'other.mjs'), false);

    const list2 = listPitfalls(15, ws2);
    assert.equal(list2.length, 1);
    assert.equal(list2[0].fileName, 'other.mjs');

    const resHeal = resolvePitfallsForFile({
      fileName: 'mod.mjs',
      workspaceRoot: ws1,
    });
    assert.ok(resHeal.removed >= 2);

    const list1After = listPitfalls(15, ws1);
    assert.equal(list1After.length, 1);
    assert.equal(list1After[0].type, 'rollback');
  } finally {
    clearPitfalls(ws1);
    clearPitfalls(ws2);
    fs.rmSync(ws1, { recursive: true, force: true });
    fs.rmSync(ws2, { recursive: true, force: true });
  }
});

test('13. v3.8 Deep Audit Regressions: Sidecar HTTP Guard, POSIX/ADS Security, Scoped Isolation, Slicer & Installer', async () => {
  // 1) Sidecar HTTP security middleware (Host, GET /api Origin, POST Origin + x-router-panel, 413 cap)
  assert.equal(isAllowedLoopbackHost('127.0.0.1:4321'), true);
  assert.equal(isAllowedLoopbackHost('[::1]:4321'), true);
  assert.equal(isAllowedLoopbackHost('localhost:4321'), true);
  assert.equal(isAllowedLoopbackHost('evil.example:4321'), false);

  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, bytes: Buffer.concat(chunks).length }));
    });
  });
  attachSidecarSecurityMiddleware(srv, { maxBodyBytes: 1024 });
  await new Promise((resolveListen) => srv.listen(0, '127.0.0.1', resolveListen));

  const sendRawHttp = ({ method = 'GET', pathName = '/api/state', headers = {}, body = '' }) =>
    new Promise((resolveReq, rejectReq) => {
      const addr = srv.address();
      const req = http.request(
        { host: '127.0.0.1', port: addr.port, method, path: pathName, headers },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolveReq({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        }
      );
      req.on('error', rejectReq);
      if (body) req.write(body);
      req.end();
    });

  try {
    const badHost = await sendRawHttp({ headers: { host: 'evil.com' } });
    assert.equal(badHost.status, 403);

    const badGetOrigin = await sendRawHttp({ headers: { origin: 'https://evil.example' } });
    assert.equal(badGetOrigin.status, 403);

    const goodPost = await sendRawHttp({
      method: 'POST',
      headers: {
        origin: 'vscode-webview://host',
        'x-router-panel': 'antigravity-v38',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ok: true }),
    });
    assert.equal(goodPost.status, 200);

    const tooLarge = await sendRawHttp({
      method: 'POST',
      headers: {
        origin: 'vscode-webview://host',
        'x-router-panel': 'antigravity-v38',
        'content-type': 'text/plain',
      },
      body: 'x'.repeat(1500),
    });
    assert.equal(tooLarge.status, 413);
  } finally {
    await new Promise((resolveClose) => srv.close(resolveClose));
  }

  // 2) Security Guard: POSIX wipe targets, redirection, backslash/colon secrets, ForEach-Object, workspace-relative scratch
  const tmpBase = makeTempDir('amr-audit13-');
  const wsScratchApp = path.join(tmpBase, '.gemini', 'antigravity', 'scratch', 'demo-app');
  const wsOther = path.join(tmpBase, 'other-repo');
  const createdShadowIds = [];
  const cbScopes = [
    { workspaceRoot: wsScratchApp, conversationId: 'conv-cb-13a' },
    { workspaceRoot: wsOther, conversationId: 'conv-cb-13b' },
  ];
  const convCascadeA = `conv-cas-A-${Date.now()}`;
  const convCascadeB = `conv-cas-B-${Date.now()}`;

  try {
    fs.mkdirSync(path.join(wsScratchApp, 'src'), { recursive: true });
    fs.mkdirSync(path.join(wsScratchApp, 'scratch'), { recursive: true });
    fs.mkdirSync(path.join(wsOther, 'src'), { recursive: true });

    for (const cmd of ['rm -rf /etc', 'rm -rf /home', 'cat<.env', 'type<.env']) {
      assert.equal(checkCommandSecurity({ commandLine: cmd, workspaceRoot: wsScratchApp }).allow, false, `Must block: ${cmd}`);
    }
    assert.equal(
      checkCommandSecurity({
        commandLine: 'Get-ChildItem -Recurse | ForEach-Object { $_.FullName }',
        workspaceRoot: wsScratchApp,
      }).allow,
      true
    );
    assert.equal(checkFileSecurity({ filePath: 'config\\.env', workspaceRoot: wsScratchApp }).allow, false);
    assert.equal(checkFileSecurity({ filePath: '/tmp/backup-10:00/.env', workspaceRoot: wsScratchApp }).allow, false);

    const appFile = path.join(wsScratchApp, 'src', 'index.mjs');
    const otherFile = path.join(wsOther, 'src', 'other.mjs');
    const localScratchFile = path.join(wsScratchApp, 'scratch', 'temp.mjs');
    fs.writeFileSync(appFile, 'export const app = 1;\n', 'utf8');
    fs.writeFileSync(otherFile, 'export const other = 2;\n', 'utf8');
    const bigLines = Array.from({ length: 60 }, (_, i) => `export const v${i} = ${i};`).join('\n');
    fs.writeFileSync(localScratchFile, bigLines, 'utf8');
    assert.equal(checkFileSecurity({ filePath: appFile, workspaceRoot: wsScratchApp }).allow, true);
    assert.equal(
      checkOverwriteGuard('write_file', { Path: localScratchFile, Overwrite: true }, { diffOnly: true, workspaceRoot: wsScratchApp }).overLimit,
      false
    );

    // 3) Workspace & session isolation: Circuit Breaker, Cascade Alert, Shadow Guard, RamMemoryEngine.evict
    for (let i = 0; i < 3; i++) {
      const r = recordEditStateHash({
        filePath: appFile,
        content: 'export const loop = 1;\n',
        workspaceRoot: wsScratchApp,
        conversationId: 'conv-cb-13a',
      });
      if (i === 2) assert.equal(r.tripped, true);
    }
    const cbOtherFile = recordEditStateHash({
      filePath: path.join(wsScratchApp, 'src', 'second.mjs'),
      content: 'export const ok = 1;\n',
      workspaceRoot: wsScratchApp,
      conversationId: 'conv-cb-13a',
    });
    assert.equal(cbOtherFile.tripped, false);
    const cbOtherWs = recordEditStateHash({
      filePath: otherFile,
      content: 'export const loop = 1;\n',
      workspaceRoot: wsOther,
      conversationId: 'conv-cb-13b',
    });
    assert.equal(cbOtherWs.tripped, false);

    const badFile = path.join(wsScratchApp, 'src', 'broken.mjs');
    fs.writeFileSync(badFile, 'export function broken( {\n', 'utf8');
    const casRes = recordVerifyAndCheckCascade({ filePath: badFile, conversationId: convCascadeA });
    assert.equal(casRes.valid, false);
    assert.equal(popCascadeAlert(convCascadeB), null);
    const poppedA = popCascadeAlert(convCascadeA);
    assert.ok(poppedA && poppedA.filePath.endsWith('broken.mjs'));

    const cpA = createShadowCheckpoint({ filePath: appFile, workspaceRoot: wsScratchApp, conversationId: 'conv-13' });
    const cpB = createShadowCheckpoint({ filePath: otherFile, workspaceRoot: wsOther, conversationId: 'conv-13' });
    if (cpA?.id) createdShadowIds.push(cpA.id);
    if (cpB?.id) createdShadowIds.push(cpB.id);
    const listedA = listCheckpoints(20, wsScratchApp);
    assert.ok(listedA.some((c) => c.id === cpA.id));
    assert.ok(!listedA.some((c) => c.id === cpB.id));

    const ramEng = new RamMemoryEngine({ budgetMb: 256 });
    await ramEng.warmWorkspaceAsync(wsScratchApp, { startWatcher: false });
    const evRes = ramEng.evict(wsScratchApp);
    assert.equal(evRes.ok, true);
    ramEng.close();

    // 4) Program Slicer brace balance, Parallel ddmin determinism, Diff Patcher EOL/marker, syncMcpRamBudget
    const slicerSrc = [
      'function closedSibling(a) {',
      '  return a + 1;',
      '}',
      'const targetX = 10;',
      'const out = targetX + 2;',
      'function outerScope(flag) {',
      '  if (flag) { return 0; }',
      '  return targetX + 5;',
      '}',
    ].join('\n');
    const sliced = sliceSourceCode(slicerSrc, 'targetX');
    assert.equal(sliced.ok, true);
    assert.ok(!sliced.sliceLines.some((l) => l.role === 'scope' && l.code.includes('closedSibling')));
    assert.ok(sliced.sliceLines.some((l) => l.role === 'scope' && l.code.includes('outerScope')));

    const ddminRes = await minimizeChunksParallel(
      ['a', 'b', 'c', 'd'],
      async (sub) => {
        await new Promise((r) => setTimeout(r, sub.includes('a') ? 25 : 2));
        return sub.includes('a') || sub.includes('c');
      },
      { concurrency: 4 }
    );
    assert.deepEqual(ddminRes, ['a']);

    const crlfSrc = 'const x = 1;\r\nconst sep = "=======";\r\nconst y = 2;\r\n';
    const crlfPatch = [
      '<<<<<<< SEARCH',
      'const sep = "=======";\r',
      'const y = 2;',
      '=======',
      'const sep = "=======";\r',
      'const y = 3;',
      '>>>>>>> REPLACE',
    ].join('\n');
    const patched = computePatchedContent(crlfSrc, crlfPatch);
    assert.ok(!patched.nextContent.includes('\r\r\n'));
    assert.ok(patched.nextContent.includes('const y = 3;\r\n'));

    const tmpMcpPlugin = path.join(tmpBase, 'mcp-plugin');
    fs.mkdirSync(tmpMcpPlugin, { recursive: true });
    const tmpMcpFile = path.join(tmpMcpPlugin, 'mcp_config.json');
    fs.writeFileSync(
      tmpMcpFile,
      JSON.stringify({
        mcpServers: {
          'ram-memory': { command: 'node', args: ['--max-old-space-size=4096', './core/ram-memory-mcp.mjs'] },
        },
      }),
      'utf8'
    );
    assert.equal(syncMcpRamBudget(tmpMcpPlugin, 6144, { resolveAbsoluteEntry: true }), true);
    const updatedMcp = JSON.parse(fs.readFileSync(tmpMcpFile, 'utf8'));
    assert.deepEqual(updatedMcp.mcpServers['ram-memory'].args, [
      '--max-old-space-size=6144',
      path.join(tmpMcpPlugin, 'core', 'ram-memory-mcp.mjs'),
    ]);

    // Direct git clone inside ~/.gemini/config/plugins/<name> must still calibrate mcp_config.json, while dev git repos stay untouched
    const tmpDevGitRepo = path.join(tmpBase, 'dev-repo');
    fs.mkdirSync(path.join(tmpDevGitRepo, '.git'), { recursive: true });
    const devMcpFile = path.join(tmpDevGitRepo, 'mcp_config.json');
    fs.writeFileSync(
      devMcpFile,
      JSON.stringify({
        mcpServers: {
          'ram-memory': { command: 'node', args: ['--max-old-space-size=4096', './core/ram-memory-mcp.mjs'] },
        },
      }),
      'utf8'
    );
    assert.equal(syncMcpRamBudget(tmpDevGitRepo, 8192, { resolveAbsoluteEntry: true }), true);
    assert.equal(
      JSON.parse(fs.readFileSync(devMcpFile, 'utf8')).mcpServers['ram-memory'].args[1],
      './core/ram-memory-mcp.mjs'
    );

    const tmpClonedPlugin = path.join(tmpBase, '.gemini', 'config', 'plugins', 'antigravity-model-router');
    fs.mkdirSync(path.join(tmpClonedPlugin, '.git'), { recursive: true });
    const clonedMcpFile = path.join(tmpClonedPlugin, 'mcp_config.json');
    fs.writeFileSync(
      clonedMcpFile,
      JSON.stringify({
        mcpServers: {
          'ram-memory': { command: 'node', args: ['--max-old-space-size=4096', './core/ram-memory-mcp.mjs'] },
        },
      }),
      'utf8'
    );
    assert.equal(syncMcpRamBudget(tmpClonedPlugin, 8192), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(clonedMcpFile, 'utf8')).mcpServers['ram-memory'].args, [
      '--max-old-space-size=8192',
      path.join(tmpClonedPlugin, 'core', 'ram-memory-mcp.mjs'),
    ]);
  } finally {
    for (const sc of cbScopes) {
      try { resetCircuitBreaker(sc); } catch {}
    }
    try { popCascadeAlert(convCascadeA); } catch {}
    try { popCascadeAlert(convCascadeB); } catch {}
    if (createdShadowIds.length > 0) {
      try {
        const idxPath = path.join(ROOT_DIR, '.cache', 'shadow-checkpoints', 'index.json');
        if (fs.existsSync(idxPath)) {
          const idSet = new Set(createdShadowIds);
          const list = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
          if (Array.isArray(list)) {
            fs.writeFileSync(idxPath, JSON.stringify(list.filter((c) => !idSet.has(c.id)), null, 2), 'utf8');
          }
          for (const cid of createdShadowIds) {
            const bak = path.join(ROOT_DIR, '.cache', 'shadow-checkpoints', `${cid}.bak`);
            if (fs.existsSync(bak)) fs.unlinkSync(bak);
          }
        }
      } catch {}
    }
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('19. 3D Task Tensor (Breadth × Depth × Risk), Adaptive Options Blueprint, Follow-Up Continuity & Anti-Boilerplate Guard', async () => {
  // 1) Exploratory bug in single file -> narrow_deep_exploratory (no Swarm pushed in options)
  const expRes = estimateTaskGradeAndThinkingBudget(
    'В файле worker.mjs плавающий баг race condition: то работает то нет',
    { confirmBeforeRun: true, confirmThreshold: 'M', swarmMode: 'auto_xl' },
    {
      precomputedScope: {
        scopeTier: 'ISOLATED',
        matchedFiles: [{ file: 'core/worker.mjs', lines: 180, symbols: ['runTask'], dependentsCount: 1 }],
        totalLines: 180,
        maxFileLines: 180,
        totalReverseDependents: 1,
        needsScoutFirst: false,
        signals: {
          isReadOnlyQuestion: false,
          hasMutationVerb: true,
          isExtendExisting: false,
          isAnalogyOrClone: false,
          isFollowUpMultiTarget: false,
          isApprovalFollowUp: false,
        },
        scopeHint: '',
      },
      modelProfile: {
        tier: 'orchestrator_carbon',
        isOrchestrator: true,
        plannerTier: 'carbon',
        isGemini4: true,
        displayRu: 'Оркестратор · Carbon',
      },
    }
  );
  assert.equal(expRes.matrix3D.breadth, 'narrow');
  assert.equal(expRes.matrix3D.depth, 'deep_arch');
  assert.equal(expRes.matrix3D.riskMode, 'exploratory');
  assert.equal(expRes.matrix3D.isExploratory, true);
  assert.equal(expRes.matrix3D.tensorId, 'narrow_deep_exploratory');
  assert.equal(expRes.grade, 'L');
  assert.match(expRes.budgetHint, /\[3D Triage:/);
  assert.match(expRes.budgetHint, /\[3D Adaptive Options Blueprint \(narrow_deep_exploratory\)\]/);
  assert.match(expRes.optionsBlueprint.formattedBlueprint, /core\/worker\.mjs/);
  assert.match(expRes.optionsBlueprint.formattedBlueprint, /Локализовать|диагностика/i);
  assert.doesNotMatch(expRes.optionsBlueprint.formattedBlueprint, /\/swarm/i);

  // 2) Critical-Blast Hub -> moderate_integrated_critical + 3D selector escalation for Hydrogen Medium
  const critRes = estimateTaskGradeAndThinkingBudget(
    'Доработай запись состояния в safe-json.mjs и panel-store.mjs',
    { confirmBeforeRun: true, confirmThreshold: 'M', strategy: 'auto_balance' },
    {
      precomputedScope: {
        scopeTier: 'COUPLED',
        matchedFiles: [
          { file: 'core/safe-json.mjs', lines: 300, symbols: ['atomicWriteJsonSync'], dependentsCount: 6 },
          { file: 'core/panel-store.mjs', lines: 140, symbols: ['savePanel'], dependentsCount: 0 },
        ],
        totalLines: 440,
        maxFileLines: 300,
        totalReverseDependents: 6,
        needsScoutFirst: false,
        signals: {
          isReadOnlyQuestion: false,
          hasMutationVerb: true,
          isExtendExisting: true,
          isAnalogyOrClone: false,
          isFollowUpMultiTarget: false,
          isApprovalFollowUp: false,
        },
        scopeHint: '',
      },
      modelProfile: {
        tier: 'hydrogen',
        isHydrogen: true,
        thinkingLevel: 'medium',
        isGemini4: true,
        displayRu: 'Hydrogen · Средний',
      },
    }
  );
  assert.equal(critRes.matrix3D.breadth, 'moderate');
  assert.equal(critRes.matrix3D.depth, 'integrated');
  assert.equal(critRes.matrix3D.riskMode, 'critical_blast');
  assert.equal(critRes.matrix3D.isHighBlast, true);
  assert.equal(critRes.matrix3D.tensorId, 'moderate_integrated_critical');
  assert.equal(critRes.grade, 'L');

  const critSel = evaluateSelectorMatchForTask({
    modelProfile: {
      tier: 'hydrogen',
      isHydrogen: true,
      thinkingLevel: 'medium',
      isGemini4: true,
      displayRu: 'Hydrogen · Средний',
    },
    grade: critRes.grade,
    isDeepAuditOrArch: critRes.matrix3D.isDeepAuditOrArch,
    matrix2D: critRes.matrix3D,
    state: { strategy: 'auto_balance' },
  });
  assert.equal(critSel.match, 'underprovisioned');
  assert.match(critSel.recommendedRu, /Orchestrator \(Carbon\)|Carbon/);

  // 2b) M -> L grade escalation via 3D High-Blast axis on single narrow file with compatibility risk
  const blastScalar = computeTask3DMatrix({
    promptText: 'Добавь проверку обратной совместимости состояния',
    scope: {
      matchedFiles: [{ file: 'core/state.mjs', lines: 90, symbols: ['loadState'], dependentsCount: 0 }],
      totalReverseDependents: 0,
      maxFileLines: 90,
      signals: { isReadOnlyQuestion: false, hasMutationVerb: true },
    },
    subsystemHits: 0,
    signals: { isReadOnlyQuestion: false, hasMutationVerb: true },
  });
  assert.equal(blastScalar.isHighBlast, true);
  assert.equal(blastScalar.grade, 'L');

  // 3) Wide Routine -> wide_routine_clear (ast-codemod-refactor + dry-run blueprint)
  const wideRoutine = estimateTaskGradeAndThinkingBudget(
    'Переименуй функцию parseMetric во всех файлах проекта',
    { confirmBeforeRun: true, confirmThreshold: 'M', swarmMode: 'auto_xl' },
    {
      precomputedScope: {
        scopeTier: 'ARCHITECTURAL',
        matchedFiles: [
          { file: 'a.mjs', lines: 60, symbols: ['parseMetric'], dependentsCount: 1 },
          { file: 'b.mjs', lines: 60, symbols: ['parseMetric'], dependentsCount: 1 },
          { file: 'c.mjs', lines: 60, symbols: ['parseMetric'], dependentsCount: 0 },
          { file: 'd.mjs', lines: 60, symbols: ['parseMetric'], dependentsCount: 0 },
          { file: 'e.mjs', lines: 60, symbols: ['parseMetric'], dependentsCount: 0 },
        ],
        totalLines: 300,
        maxFileLines: 60,
        totalReverseDependents: 2,
        needsScoutFirst: false,
        signals: {
          isReadOnlyQuestion: false,
          hasMutationVerb: true,
          isExtendExisting: false,
          isAnalogyOrClone: false,
          isFollowUpMultiTarget: false,
          isApprovalFollowUp: false,
        },
        scopeHint: '',
      },
    }
  );
  assert.equal(wideRoutine.matrix3D.breadth, 'wide');
  assert.equal(wideRoutine.matrix3D.depth, 'routine');
  assert.equal(wideRoutine.matrix3D.riskMode, 'clear');
  assert.equal(wideRoutine.matrix3D.tensorId, 'wide_routine_clear');
  const wideBlueprint = buildAdaptive3DOptionsBlueprint({
    matrix3D: wideRoutine.matrix3D,
    scope: wideRoutine.scope,
    state: { swarmMode: 'auto_xl' },
    recModelRu: 'Hydrogen · Высокий/XHigh',
  });
  assert.match(wideBlueprint.formattedBlueprint, /ast-codemod-refactor/);
  assert.match(wideBlueprint.formattedBlueprint, /dry-run/);

  // 4) Plan Approved Follow-Up continuity ("Делаем")
  const followRes = estimateTaskGradeAndThinkingBudget(
    'Делаем',
    { confirmBeforeRun: true, confirmThreshold: 'M' },
    {
      prevTurnGrade: 'XL',
      prevTurnMatrix: { breadth: 'wide', depth: 'deep_arch', riskMode: 'critical_blast', tensorId: 'wide_deep_critical' },
    }
  );
  assert.equal(followRes.isApprovalFollowUp, true);
  assert.equal(followRes.grade, 'XL');
  assert.match(followRes.budgetHint, /\[Plan Approved Follow-Up \(XL\)\]/);
  assert.doesNotMatch(followRes.budgetHint, /\[Pre-Task Gate: ON/);

  // 5) Anti-Boilerplate Guard in handlePreToolUse (ask_question)
  const genericOpts = [
    '(Recommended) Запустить: Архитектор + быстрый контур + профильные скиллы',
    'Максимальная мощность: параллельные субагенты (Teamwork / Swarm)',
    'Быстрый режим (одной моделью без субагентов)',
  ];
  assert.equal(isGenericBoilerplateAskOptions(genericOpts, 'План автопилота: обновление. Объём: M. Запускаем?'), true);

  const concreteOpts = [
    '(Recommended) Перевести sidecars/panel/server.mjs и ui.html на in-memory кэш + SSE-стрим',
    'Минимальный патч: кэшировать JSON по mtime только в server.mjs (0 риска для соседей)',
    'Только диагностика (read-only): проверить узкие места без правки файлов',
  ];
  assert.equal(isGenericBoilerplateAskOptions(concreteOpts, 'План автопилота: обновление. Объём: M. Запускаем?'), false);

  const convBad = `conv-3d-bad-${process.pid}-${Date.now()}`;
  const convGood = `conv-3d-good-${process.pid}-${Date.now()}`;
  const convUi = `conv-3d-ui-${process.pid}-${Date.now()}`;
  const turnCachePath = path.join(SUITE_CACHE_DIR, 'pre-invocation-turn.json');

  try {
    const allowRes = await handlePreToolUse(
      {
        conversationId: convBad,
        toolName: 'ask_question',
        args: {
          questions: [{ question: 'План автопилота: фикс. Объём: M. Запускаем?', options: genericOpts }],
        },
      },
      { confirmBeforeRun: true, pureCognitiveTriage: true }
    );
    assert.equal(allowRes.decision, 'allow', 'ask_question should never be blocked by UI-breaking hook deny');

    const allowConcrete = await handlePreToolUse(
      {
        conversationId: convGood,
        toolName: 'ask_question',
        args: {
          questions: [{ question: 'План автопилота: телеметрия. Объём: L. Запускаем?', options: concreteOpts }],
        },
      },
      { confirmBeforeRun: true, pureCognitiveTriage: true }
    );
    assert.equal(allowConcrete.decision, 'allow');

    const allowUiGate = await handlePreToolUse(
      {
        conversationId: convUi,
        toolName: 'ask_question',
        args: {
          questions: [
            {
              question: 'Выберите способ подготовки дизайна:',
              options: [
                '(Recommended) Сгенерировать 3 авторских варианта (A/B/C) в интерактивной витрине',
                'Поискать референсы в интернете (укажите стиль в следующем шаге)',
                'Без превью — сразу внедрять в код',
              ],
            },
          ],
        },
      },
      { confirmBeforeRun: true, pureCognitiveTriage: true }
    );
    assert.equal(allowUiGate.decision, 'allow');
  } finally {
    try {
      if (fs.existsSync(turnCachePath)) {
        const cur = JSON.parse(fs.readFileSync(turnCachePath, 'utf8'));
        if (cur?.turns && typeof cur.turns === 'object') {
          delete cur.turns[convBad];
          delete cur.turns[convGood];
          delete cur.turns[convUi];
          fs.writeFileSync(turnCachePath, JSON.stringify(cur, null, 2), 'utf8');
        }
      }
    } catch {}
  }
});

test('20. v3.8 Audit Hardening: Orchestrator [plan review], A1 Approval Continuity & RAM Panel Workspace Sync', async () => {
  const reviewRes = estimateTaskGradeAndThinkingBudget(
    '[plan review] Executor finished steps 1-3 in core/hook-runner.mjs',
    { confirmBeforeRun: true, confirmThreshold: 'ALL' },
    { prevTurnGrade: 'L' }
  );
  assert.equal(reviewRes.isPlanReview, true);
  assert.equal(reviewRes.isReadOnlyQuestion, true);
  assert.match(reviewRes.budgetHint, /\[Orchestrator Plan Review/);
  assert.doesNotMatch(reviewRes.budgetHint, /\[Pre-Task Gate: ON/);

  const a1Res = estimateTaskGradeAndThinkingBudget(
    'A1: (Recommended) Комплексный патч всех 4 узлов (install.js, hook-runner.mjs, tool-pruner.mjs, server.mjs) + регрессионные тесты',
    { confirmBeforeRun: true, confirmThreshold: 'ALL' },
    { prevTurnGrade: 'L' }
  );
  assert.equal(a1Res.isApprovalFollowUp, true);
  assert.match(a1Res.budgetHint, /\[Plan Approved Follow-Up/);
  assert.doesNotMatch(a1Res.budgetHint, /\[Pre-Task Gate: ON/);

  const a1DiagRes = estimateTaskGradeAndThinkingBudget(
    'A1: Только read-only диагностика — оставить отчёт без изменений на диске',
    { confirmBeforeRun: true, confirmThreshold: 'ALL' },
    { prevTurnGrade: 'L' }
  );
  assert.equal(a1DiagRes.isApprovalFollowUp, false);

  const convExit = `conv-exit-plan-test-${process.pid}-${Date.now()}`;
  const turnCachePath = path.join(SUITE_CACHE_DIR, 'pre-invocation-turn.json');
  try {
    const exitRes = await handlePreToolUse(
      { conversationId: convExit, toolName: 'exit_plan_mode', args: { plan: 'Step 1' } },
      { confirmBeforeRun: true }
    );
    assert.equal(exitRes.decision, 'allow');
    const saved = JSON.parse(fs.readFileSync(turnCachePath, 'utf8'));
    assert.equal(saved?.turns?.[convExit]?.planHandedOff, true);
    assert.equal(saved?.turns?.[convExit]?.askQuestionCalled, true);
    assert.equal(saved?.turns?.[convExit]?.preTaskGateRequired, false);

    // Fix #9: approved L/XL turn >10 min old with same userInput stays in-turn and preserves askQuestionCalled
    const longPrompt = 'Сделай полный аудит архитектуры и обнови все тесты в проекте';
    await handlePreInvocation(
      { conversationId: convExit, workspacePath: ROOT_DIR, lastUserInput: longPrompt },
      { confirmBeforeRun: true, confirmThreshold: 'ALL', ramCacheEnabled: false }
    );
    await handlePreToolUse(
      { conversationId: convExit, toolName: 'exit_plan_mode', args: { plan: 'Step 1' } },
      { confirmBeforeRun: true }
    );
    const agedTurns = JSON.parse(fs.readFileSync(turnCachePath, 'utf8'));
    agedTurns.turns[convExit].ts = Date.now() - 25 * 60 * 1000;
    fs.writeFileSync(turnCachePath, JSON.stringify(agedTurns, null, 2), 'utf8');
    const midTurnPre = await handlePreInvocation(
      { conversationId: convExit, workspacePath: ROOT_DIR, lastUserInput: longPrompt },
      { confirmBeforeRun: true, confirmThreshold: 'ALL', ramCacheEnabled: false }
    );
    const midMsg = (midTurnPre?.injectSteps || []).map((s) => s.ephemeralMessage || '').join('\n');
    assert.doesNotMatch(midMsg, /\[Pre-Task Gate: ON/);
    const afterAged = JSON.parse(fs.readFileSync(turnCachePath, 'utf8'));
    assert.equal(afterAged?.turns?.[convExit]?.askQuestionCalled, true);
  } finally {
    try {
      if (fs.existsSync(turnCachePath)) {
        const cur = JSON.parse(fs.readFileSync(turnCachePath, 'utf8'));
        if (cur?.turns && typeof cur.turns === 'object') {
          delete cur.turns[convExit];
          fs.writeFileSync(turnCachePath, JSON.stringify(cur, null, 2), 'utf8');
        }
      }
    } catch {}
  }
});

test('28. Skill-Architect & Skill-Crystallizer v2: targetDir isolation, references/ overflow, Negative Transfer linter & EvoSkill pitfall distillation', async () => {
  const {
    GLOBAL_SKILLS_DIR,
    LEGACY_GLOBAL_SKILLS_DIR,
    crystallizeSkill,
    distillPitfallsIntoSkills,
    mergeIntoRichSkillMd,
    synthesizeTriggerDescription,
  } = await import('../core/skill-crystallizer.mjs');
  const {
    clearPitfalls,
    recordPitfall,
  } = await import('../core/pitfall-ledger.mjs');
  const {
    auditAllSkills,
    auditSkill,
    parseYamlFrontmatter,
  } = await import('../skills/skill-architect/scripts/audit-skill.mjs');
  const { discoverSkills } = await import('../sidecars/panel/server.mjs');

  assert.ok(
    GLOBAL_SKILLS_DIR.endsWith(path.join('.gemini', 'config', 'skills')),
    `GLOBAL_SKILLS_DIR must use ~/.gemini/config/skills, got ${GLOBAL_SKILLS_DIR}`
  );

  const tmpSkillsRoot = makeTempDir('amr-skill-v2-');
  const tmpWs = makeTempDir('amr-skill-ws-');
  const isoSlug = `iso-overflow-${Date.now()}`;
  const leakedNewGlobal = path.join(GLOBAL_SKILLS_DIR, isoSlug);
  const leakedLegacyGlobal = path.join(LEGACY_GLOBAL_SKILLS_DIR, isoSlug);

  try {
    // 1. Target isolation + non-destructive references/ overflow (>80 lines) + synthesized trigger description
    const manySteps = Array.from({ length: 75 }, (_, i) => `Verify deterministic pipeline step ${i + 1}`);
    const crysRes = crystallizeSkill({
      slug: isoSlug,
      triggers: ['pipeline verification', 'schema migration'],
      invariants: ['Validate JSON schema before disk write because malformed state breaks sidecar reload'],
      recipeSteps: manySteps,
      verifyCmd: 'node --test tests/router-core.test.mjs',
      targetDir: tmpSkillsRoot,
    });

    assert.equal(crysRes.ok, true);
    assert.equal(crysRes.hasOverflowReferences, true);
    assert.ok(crysRes.linesCount <= 80, `SKILL.md must stay <= 80 lines, got ${crysRes.linesCount}`);
    assert.equal(fs.existsSync(leakedNewGlobal), false, 'targetDir isolation must not leak to GLOBAL_SKILLS_DIR');
    assert.equal(fs.existsSync(leakedLegacyGlobal), false, 'targetDir isolation must not leak to LEGACY_GLOBAL_SKILLS_DIR');

    const overflowRefPath = path.join(tmpSkillsRoot, isoSlug, 'references', 'extended-recipes.md');
    assert.equal(fs.existsSync(overflowRefPath), true, 'Overflow must write references/extended-recipes.md');
    const overflowText = fs.readFileSync(overflowRefPath, 'utf8');
    assert.ok(overflowText.includes('Verify deterministic pipeline step 75'), 'All 75 steps must be preserved in references/');

    const createdMd = fs.readFileSync(crysRes.skillPath, 'utf8');
    const parsedFm = parseYamlFrontmatter(createdMd);
    assert.equal(/^skill capsule for\b/i.test(parsedFm.description), false);
    assert.ok(parsedFm.description.includes('Use when'), `Synthesized description must include trigger clause: ${parsedFm.description}`);

    // 2. Multiline YAML frontmatter + synthesizeTriggerDescription helper
    const multiFm = parseYamlFrontmatter(
      '---\nname: sample-multi\ndescription: >-\n  First line of intent.\n  Use when auditing skills.\n---\n# Body\n'
    );
    assert.equal(multiFm.name, 'sample-multi');
    assert.equal(multiFm.description, 'First line of intent. Use when auditing skills.');
    const fallbackSynth = synthesizeTriggerDescription({ slug: 'cache-warmer', triggers: ['warm cache'] });
    assert.ok(fallbackSynth.includes('Use when tasks involve: warm cache'));

    // 3. Negative Transfer & broken script detector on malformed skill
    const badSkillDir = path.join(tmpSkillsRoot, 'bad-nt-skill');
    fs.mkdirSync(badSkillDir, { recursive: true });
    fs.writeFileSync(
      path.join(badSkillDir, 'SKILL.md'),
      [
        '---',
        'name: bad-nt-skill',
        'description: Skill capsule for bad-nt-skill',
        '---',
        '# Bad Skill',
        '- ALWAYS format code neatly.',
        '- NEVER forget variables.',
        '- STRICTLY avoid messy blocks.',
        '- Run [missing](./scripts/non-existent.mjs)',
      ].join('\n'),
      'utf8'
    );
    const badAudit = auditSkill(badSkillDir, { skillsRoot: tmpSkillsRoot });
    assert.equal(badAudit.ok, false);
    const badIds = new Set(badAudit.findings.map((f) => f.id));
    assert.ok(badIds.has('FM_GENERIC_DESC'));
    assert.ok(badIds.has('NT_UNEXPLAINED_RIGID_CAPS'));
    assert.ok(badIds.has('PD_BROKEN_SCRIPT_REF'));

    // 4. Semantic near-duplicate consolidation in mergeIntoRichSkillMd & EvoSkill pitfall distillation
    const richBase = '# Rich Skill\n\n## Learned Patterns & Verified Recipes\n- **[Invariant]** Validate JSON schema before writing state files to avoid corruption\n';
    const mergedRich = mergeIntoRichSkillMd(richBase, {
      invariants: [
        'Always validate JSON schema before writing state files to avoid corruption',
        'Run atomic lock helper before writing concurrent cache snapshots — prevents race truncation',
      ],
    });
    assert.equal(
      (mergedRich.match(/validate json schema before/gi) || []).length,
      1,
      'Near-duplicate learned invariant must be consolidated'
    );

    clearPitfalls(tmpWs);
    recordPitfall({
      type: 'test_failure',
      fileName: 'ui-component.css',
      summary: 'Ensure modal focus trap restores opener button focus on Escape',
      workspaceRoot: tmpWs,
    });
    const distilled = distillPitfallsIntoSkills({
      workspaceRoot: tmpWs,
      targetDir: tmpSkillsRoot,
      limit: 10,
      dryRun: false,
    });
    assert.equal(distilled.ok, true);
    assert.ok(distilled.evolvedSkills.length >= 1);
    const evolvedTarget = distilled.evolvedSkills[0];
    const evolvedContent = fs.readFileSync(evolvedTarget.skillPath, 'utf8');
    assert.ok(evolvedContent.includes('prevents repeat test_failure regression'), 'Distilled pitfall must include causal rationale');

    // 5. Self-audit of skill-architect & full catalog audit + panel RU catalog registration
    const selfAudit = auditSkill('skill-architect');
    assert.equal(selfAudit.ok, true);
    assert.equal(selfAudit.grade, 'A');
    assert.ok(selfAudit.score >= 90, `skill-architect must score >= 90, got ${selfAudit.score}`);

    const catalogAudit = auditAllSkills();
    assert.equal(catalogAudit.ok, true, 'All bundled plugin skills must pass auditAllSkills() without errors');
    assert.ok(catalogAudit.total >= 11, `Expected >= 11 skills, got ${catalogAudit.total}`);

    const panelSkills = discoverSkills(ROOT_DIR);
    const archSkill = panelSkills.find((s) => s.id === 'skill-architect');
    assert.ok(archSkill, 'discoverSkills must expose skill-architect');
    assert.notEqual(archSkill.title, 'skill-architect', 'skill-architect must have a translated RU title');
  } finally {
    clearPitfalls(tmpWs);
    fs.rmSync(tmpSkillsRoot, { recursive: true, force: true });
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
});

test('33. The Tunnel Rebrand, Version Sync, Manifest & CHANGELOG Contracts', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
  const plugin = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'plugin.json'), 'utf8'));
  const sidecar = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'sidecars', 'panel', 'sidecar.json'), 'utf8'));
  const changelog = fs.readFileSync(path.join(ROOT_DIR, 'CHANGELOG.md'), 'utf8');

  assert.match(pkg.version, /^\d+\.\d+\.\d+/);
  assert.equal(plugin.version, pkg.version);
  assert.equal(plugin.name, 'antigravity-model-router');
  assert.ok(plugin.displayName.includes('The Tunnel'));
  assert.equal(sidecar.display_name, 'The Tunnel');
  assert.equal(sidecar.ui_config.display_name, 'The Tunnel');
  assert.ok(changelog.includes(`## [${pkg.version}]`));
  assert.ok(changelog.includes('## [3.17.0]'));
  assert.ok(changelog.includes('## [3.8.0]'));
  assert.ok(changelog.includes('The Tunnel'));
});

test('34. Pitfall Ledger auto-resolves test_failure on impacted test files and passing test commands', async () => {
  const { handlePostToolUse, resolveTestPitfallsFromCommand } = await import('../core/hook-runner.mjs');
  const pitfallMod = await import('../core/pitfall-ledger.mjs');
  const tmpWs = makeTempDir('amr-pf-resolve-');

  try {
    // 1. resolveTestPitfallsFromCommand resolves test_failure recorded under test filename and implementation filename
    pitfallMod.recordPitfall({
      type: 'test_failure',
      fileName: 'sample.test.mjs',
      summary: 'Test-Impact fail (sample.test.mjs): AssertionError expected 1 to equal 2',
      workspaceRoot: tmpWs,
    });
    pitfallMod.recordPitfall({
      type: 'rollback',
      fileName: 'sample.test.mjs',
      summary: 'Rollback: keep non-test lesson',
      workspaceRoot: tmpWs,
    });

    // Must NOT resolve when output indicates failure or chained command has no pass confirmation
    const blockedFail = resolveTestPitfallsFromCommand({
      commandLine: 'node --test tests/sample.test.mjs',
      output: '✖ failing test\nfail 1',
      workspaceRoot: tmpWs,
      pitfallLedgerMod: pitfallMod,
    });
    assert.equal(blockedFail.resolved, 0);

    const blockedChain = resolveTestPitfallsFromCommand({
      commandLine: 'node --test tests/sample.test.mjs; git status -sb',
      output: '',
      workspaceRoot: tmpWs,
      pitfallLedgerMod: pitfallMod,
    });
    assert.equal(blockedChain.resolved, 0);

    const okDirect = resolveTestPitfallsFromCommand({
      commandLine: 'node --test tests/sample.test.mjs',
      output: '✔ passing test\npass 1\nfail 0',
      workspaceRoot: tmpWs,
      pitfallLedgerMod: pitfallMod,
    });
    assert.equal(okDirect.resolved, 1);
    assert.deepEqual(pitfallMod.listPitfalls(10, tmpWs).map((x) => x.type), ['rollback']);

    // 2. Wildcard glob resolves test_failure recorded under implementation file whose rule mentions the test
    pitfallMod.recordPitfall({
      type: 'test_failure',
      fileName: 'ui.html',
      summary: 'Test-Impact fail (widget.test.mjs): AssertionError mismatch',
      workspaceRoot: tmpWs,
    });
    const okGlob = resolveTestPitfallsFromCommand({
      commandLine: 'node --test tests/*.test.mjs',
      output: 'pass 2\nfail 0',
      workspaceRoot: tmpWs,
      pitfallLedgerMod: pitfallMod,
    });
    assert.equal(okGlob.resolved, 1);

    // 3. handlePostToolUse on implementation edit resolves test_failure recorded under paired test filename
    fs.mkdirSync(path.join(tmpWs, 'tests'), { recursive: true });
    const modPath = path.join(tmpWs, 'calc.mjs');
    const testPath = path.join(tmpWs, 'tests', 'calc.test.mjs');
    fs.writeFileSync(modPath, 'export function add(a, b) { return a + b; }\n', 'utf8');
    fs.writeFileSync(
      testPath,
      "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../calc.mjs';\ntest('add', () => assert.equal(add(1, 2), 3));\n",
      'utf8'
    );

    pitfallMod.recordPitfall({
      type: 'test_failure',
      fileName: 'calc.test.mjs',
      summary: 'Test-Impact fail (calc.test.mjs): AssertionError 2 !== 3',
      workspaceRoot: tmpWs,
    });
    assert.equal(pitfallMod.listPitfalls(10, tmpWs).some((p) => p.fileName === 'calc.test.mjs' && p.type === 'test_failure'), true);

    await handlePostToolUse(
      {
        toolName: 'edit_file',
        args: { Path: modPath },
        workspacePath: tmpWs,
        conversationId: 'pf-e2e-test',
      },
      {
        selfVerify: true,
        cascadeVerify: true,
        testImpactVerify: true,
        pitfallLedger: true,
        ramCacheEnabled: false,
        blastRadius: false,
        sessionHandoff: false,
        bayesianRouter: false,
      }
    );

    assert.equal(
      pitfallMod.listPitfalls(10, tmpWs).some((p) => p.fileName === 'calc.test.mjs' && p.type === 'test_failure'),
      false,
      'Passing Test-Impact on calc.mjs must clear test_failure recorded under calc.test.mjs'
    );
  } finally {
    pitfallMod.clearPitfalls(tmpWs);
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
});

test('36. AI-First Post-Scout Triage: UI label de-noising, XL->M post-read downgrade authority, over/under-provision checks & pre-read badge', async () => {
  // 1. UI block titles ("Дизайн витрины и превью UI") do not trigger exploratory redesign flags
  const rawUiPrompt =
    'У меня сейчас в расширении есть три окна, у которых нет кнопки Скрыть, как у остальных. Это Навыки пилота, Режим работы агента и Дизайн витрины и превью UI. Надо туда добавить кнопку Скрыть, как у остальных.';
  const cleanedIntent = stripUiTitlesForIntentClassification(rawUiPrompt);
  assert.doesNotMatch(cleanedIntent, /дизайн\s+витрин/i);

  const uiTriage = estimateTaskGradeAndThinkingBudget(
    rawUiPrompt,
    { confirmBeforeRun: true, confirmThreshold: 'ALL' },
    {
      precomputedScope: {
        scopeTier: 'COUPLED',
        matchedFiles: [{ file: 'sidecars/panel/ui.html', lines: 320, symbols: ['skillsSectionCard'], dependentsCount: 0 }],
        totalLines: 320,
        maxFileLines: 320,
        totalReverseDependents: 0,
        needsScoutFirst: true,
        signals: {
          isReadOnlyQuestion: false,
          hasMutationVerb: true,
          isExtendExisting: false,
          isAnalogyOrClone: true,
          isFollowUpMultiTarget: false,
          isApprovalFollowUp: false,
        },
        scopeHint: '',
      },
      modelProfile: {
        tier: 'hydrogen',
        isHydrogen: true,
        thinkingLevel: 'high',
        isGemini4: true,
        displayRu: 'Hydrogen · Высокий',
      },
    }
  );
  assert.equal(uiTriage.grade, 'M');
  assert.equal(uiTriage.matrix3D.isExploratory, false);
  assert.equal(uiTriage.selectorEval.match, 'optimal');

  // 2. Post-Scout AI Downgrade (pre-hook guessed XL, AI inspected code and declared M on Hydrogen High -> allowed immediately & updates turn grade)
  const convDowngrade = `conv-ai-downgrade-${process.pid}-${Date.now()}`;
  const convOver = `conv-ai-over-${process.pid}-${Date.now()}`;
  const convUnder = `conv-ai-under-${process.pid}-${Date.now()}`;
  const turnCachePath = path.join(SUITE_CACHE_DIR, 'pre-invocation-turn.json');

  const concreteUiOpts = [
    '(Recommended) Обернуть skillsSectionCard, agentModeCard и skillProfilesFieldset в сворачиваемые блоки в sidecars/panel/ui.html + тесты в router-core.test.mjs (на Hydrogen · Высокий)',
    'Сделать кнопку скрытия через CSS-класс collapsed + сохранение в localStorage в ui.html',
    'Точечный патч только верстки ui.html без сохранения состояния между перезапусками',
  ];

  try {
    const existing = fs.existsSync(turnCachePath) ? JSON.parse(fs.readFileSync(turnCachePath, 'utf8')) : { turns: {} };
    existing.turns = existing.turns || {};
    existing.turns[convDowngrade] = {
      hash: 'h1',
      ts: Date.now(),
      grade: 'XL',
      matrix2D: { breadth: 'wide', depth: 'deep_arch', matrixId: 'wide_deep' },
      isDeepAuditOrArch: true,
      askQuestionCalled: false,
      selectorWarned: false,
      boilerplateWarned: false,
    };
    fs.mkdirSync(path.dirname(turnCachePath), { recursive: true });
    fs.writeFileSync(turnCachePath, JSON.stringify(existing, null, 2), 'utf8');

    const allowDowngraded = await handlePreToolUse(
      {
        conversationId: convDowngrade,
        toolName: 'ask_question',
        modelName: 'gemini-4-hydrogen-high',
        args: {
          questions: [
            {
              question:
                'План автопилота: добавить сворачивание карточек в sidecars/panel/ui.html. Объём: M. Рекомендуемая мощность: Hydrogen · Высокий. Запускаем?',
              options: concreteUiOpts,
            },
          ],
        },
      },
      { confirmBeforeRun: true, pureCognitiveTriage: true }
    );
    assert.equal(allowDowngraded.decision, 'allow', 'Post-scout M must override blind XL without forcing Carbon');
    const updatedTurns = JSON.parse(fs.readFileSync(turnCachePath, 'utf8'));
    assert.equal(updatedTurns.turns[convDowngrade].grade, 'M');
    assert.equal(updatedTurns.turns[convDowngrade].isDeepAuditOrArch, false);

    // 3. Overprovisioned check: ask_question remains non-blocking (allow) even when selector differs from grade
    const allowOver = await handlePreToolUse(
      {
        conversationId: convOver,
        toolName: 'ask_question',
        modelName: 'gemini-4-carbon-high',
        args: {
          questions: [
            {
              question:
                'План автопилота: поправить отступ кнопки в sidecars/panel/ui.html. Объём: S. Рекомендуемая мощность: Carbon · Высокий. Запускаем?',
              options: concreteUiOpts,
            },
          ],
        },
      },
      { confirmBeforeRun: true, pureCognitiveTriage: true }
    );
    assert.equal(allowOver.decision, 'allow');

    // 4. Genuine post-scout XL on weak Hydrogen Medium also remains non-blocking (allow)
    const allowUnder = await handlePreToolUse(
      {
        conversationId: convUnder,
        toolName: 'ask_question',
        modelName: 'gemini-4-hydrogen-medium',
        args: {
          questions: [
            {
              question:
                'План автопилота: перестроить архитектуру 6 модулей ядра. Объём: XL. Рекомендуемая мощность: Hydrogen · Средний. Запускаем?',
              options: concreteUiOpts,
            },
          ],
        },
      },
      { confirmBeforeRun: true, pureCognitiveTriage: true }
    );
    assert.equal(allowUnder.decision, 'allow');

    // 5. Pre-read zero-token badge labels preliminary estimate clearly before code inspection
    const hookMod = await import('../core/hook-runner.mjs');
    const preBadge = hookMod.buildZeroTokenUserBadgeStep({
      grade: 'XL',
      modelProfile: { displayNameRu: 'Hydrogen · Высокий' },
      pruningResult: { domain: 'ui_browser' },
      state: { showBadge: true },
      isPreReadEstimate: true,
    });
    assert.match(preBadge.systemMessage.metadata.user_markdown, /\*\*Пред-оценка:\*\* ~XL/);
  } finally {
    try {
      if (fs.existsSync(turnCachePath)) {
        const cur = JSON.parse(fs.readFileSync(turnCachePath, 'utf8'));
        if (cur?.turns && typeof cur.turns === 'object') {
          delete cur.turns[convDowngrade];
          delete cur.turns[convOver];
          delete cur.turns[convUnder];
          fs.writeFileSync(turnCachePath, JSON.stringify(cur, null, 2), 'utf8');
        }
      }
    } catch {}
  }
});

test('43. Read-Only advisory rule & Modal Analytical Question complexity/selector triage', async () => {
  const simpleSig = detectPromptIntentSignals('Почему не сработал анализ в прошлом чате?');
  assert.equal(simpleSig.isReadOnlyQuestion, true);
  assert.equal(simpleSig.isModalAnalyticalQuestion, false);

  const simpleRo = estimateTaskGradeAndThinkingBudget(
    'Почему не сработал анализ в прошлом чате?',
    { confirmBeforeRun: true, confirmThreshold: 'ALL' },
    { modelProfile: { tier: 'hydrogen', isHydrogen: true, isGemini4: true, thinkingLevel: 'medium', displayRu: 'Hydrogen · Средний' } }
  );
  assert.equal(simpleRo.isReadOnlyQuestion, true);
  assert.equal(simpleRo.isModalAnalyticalQuestion, false);
  assert.match(simpleRo.budgetHint, /\[Read-Only\]/);
  assert.match(simpleRo.budgetHint, /preliminary scope \(S\/M\/L\/XL\), affected files, and recommended model/);
  assert.doesNotMatch(simpleRo.budgetHint, /\[Pre-Task Gate: ON/);

  const modalSig = detectPromptIntentSignals('Можем ли мы добавить кэширование и исправить гонку состояний во всех модулях?');
  assert.equal(modalSig.isReadOnlyQuestion, true);
  assert.equal(modalSig.isModalAnalyticalQuestion, true);
  assert.equal(modalSig.hasModalImplIntent, true);

  const modalCanDoSig = detectPromptIntentSignals('Можно ли реализовать это через diff-patcher.mjs?');
  assert.equal(modalCanDoSig.isReadOnlyQuestion, true);
  assert.equal(modalCanDoSig.isModalAnalyticalQuestion, true);
  assert.equal(modalCanDoSig.hasModalImplIntent, true);

  const modalRes = estimateTaskGradeAndThinkingBudget(
    'Можем ли мы добавить кэширование и исправить гонку состояний во всех модулях?',
    { confirmBeforeRun: true, confirmThreshold: 'M' },
    { modelProfile: { tier: 'hydrogen', isHydrogen: true, isGemini4: true, thinkingLevel: 'medium', displayRu: 'Hydrogen · Средний' } }
  );
  assert.equal(modalRes.isReadOnlyQuestion, true);
  assert.equal(modalRes.isModalAnalyticalQuestion, true);
  assert.ok(modalRes.grade === 'L' || modalRes.grade === 'XL', `Expected L/XL for deep multi-module modal question, got ${modalRes.grade}`);
  assert.equal(modalRes.selectorEval.match, 'underprovisioned');
  assert.match(modalRes.selectorEval.recommendedRu, /Carbon|Orchestrator/i);
  assert.match(modalRes.budgetHint, /\[Read-Only \/ Modal Triage:/);
  assert.match(modalRes.budgetHint, /Optimal:/);
  assert.match(modalRes.budgetHint, /\[Pre-Read Selector Hint/);
  assert.match(modalRes.budgetHint, /preliminary scope \(S\/M\/L\/XL\), affected files, and recommended model/);
  assert.doesNotMatch(modalRes.budgetHint, /\[Pre-Task Gate: ON/);

  const { handlePreInvocation } = await import('../core/hook-runner.mjs');
  const preModal = await handlePreInvocation(
    {
      hookEventName: 'PreInvocation',
      conversationId: 'chat-pre-modal-ro',
      workspacePaths: [ROOT_DIR],
      prompt: 'Можем ли мы добавить новый модуль в нескольких файлах и устранить утечку памяти?',
      _forceFullPreInvocation: true,
    },
    { showBadge: true, confirmBeforeRun: true, confirmThreshold: 'M', ramCacheEnabled: false }
  );
  const modalHasBadge = (preModal.injectSteps || []).some(
    (s) => s?.systemMessage?.systemMessage === '' && typeof s?.systemMessage?.metadata?.user_markdown === 'string'
  );
  assert.equal(modalHasBadge, false, 'Modal read-only question must not emit coding badge');

  const agentsMd = fs.readFileSync(path.join(ROOT_DIR, 'rules', 'AGENTS.md'), 'utf8');
  assert.match(agentsMd, /Direct Q \/ Read-Only.*S\/M\/L\/XL.*affected files.*recommended model/i);
});

test('54. Audit Regressions: getSafeWorkerExecArgv strips V8 heap/inspect flags, session-handoff mirror helpers top-level & badge uses displayRu/strategy', async () => {
  const { getSafeWorkerExecArgv } = await import('../core/cpu-worker-pool.mjs');
  const { recordHandoffGoal, recordHandoffAction, getSessionHandoff } = await import('../core/session-handoff.mjs');
  const { buildZeroTokenUserBadgeStep } = await import('../core/hook-runner.mjs');

  const safeArgv = getSafeWorkerExecArgv([
    '--max-old-space-size=8192',
    '--max-old-space-size',
    '4096',
    '--inspect=9229',
    '--inspect-port',
    '9230',
    '--experimental-vm-modules',
  ]);
  assert.equal(safeArgv.some((a) => a.includes('max-old-space-size') || a.includes('inspect')), false);
  assert.ok(safeArgv.includes('--experimental-vm-modules'));
  assert.ok(safeArgv.includes('--no-warnings'));

  const tmpWs = makeTempDir('amr-handoff-mirror-');
  try {
    recordHandoffGoal({ workspaceRoot: tmpWs, conversationId: 'conv-54', userPrompt: 'Verify cross-workspace handoff mirror helpers without ReferenceError' });
    const actState = recordHandoffAction({ workspaceRoot: tmpWs, conversationId: 'conv-54', toolName: 'edit_file', filePath: path.join(tmpWs, 'demo.mjs'), verifyOk: true });
    assert.ok(actState && Array.isArray(actState.touchedFiles));
    const snap = getSessionHandoff(tmpWs);
    assert.ok(snap && Array.isArray(snap.touchedFiles) && snap.touchedFiles.length >= 1);
  } finally {
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }

  const badge = buildZeroTokenUserBadgeStep({
    grade: 'L',
    modelProfile: { displayRu: 'Carbon · Средний' },
    pruningResult: { domain: 'arch_design' },
    state: { showBadge: true, strategy: 'pro_architect' },
  });
  const md = badge?.systemMessage?.metadata?.user_markdown || '';
  assert.match(md, /Pro-Архитектор/);
  assert.match(md, /Carbon · Средний/);
});

test('55. Gemini 4 Neon & Orchestrator (Neon) full routing, FinOps, Guard, Bayesian & Swarm suite', async () => {
  const {
    normalizeModelProfile,
    getPricingPhaseStatus,
    evaluateThinkingBurnAdvisory,
    resolveEffectiveCompactionThreshold,
    resolveRepoMapMaxChars,
    resolveReadDedupPolicy,
  } = await import('../core/model-profile.mjs');
  const { handlePreToolUse } = await import('../core/hook-runner.mjs');
  const { evaluateBayesianRoute, getBayesianSummary, recordModelOutcome } = await import('../core/bayesian-router.mjs');
  const { evaluateSwarmRoutingDirective } = await import('../core/swarm-controller.mjs');

  // 1) normalizeModelProfile across all 5 Neon slugs/display names + bare Neon
  const orchNeon = normalizeModelProfile('Orchestrator (Neon)');
  assert.equal(orchNeon.tier, 'orchestrator_neon');
  assert.equal(orchNeon.plannerTier, 'neon');
  assert.equal(orchNeon.executorTier, 'hydrogen');
  assert.equal(orchNeon.isOrchestrator, true);
  assert.equal(orchNeon.isNeon, false);
  assert.equal(orchNeon.isGemini4, true);
  assert.equal(orchNeon.displayRu, 'Оркестратор · Neon');
  assert.deepEqual(resolveReadDedupPolicy(orchNeon), { activeWindowMs: 30 * 60 * 1000, maxStepGap: 55 });

  const orchNeonSlug = normalizeModelProfile('gemini-pro-orchestrator-neon');
  assert.equal(orchNeonSlug.tier, 'orchestrator_neon');
  assert.equal(orchNeonSlug.plannerTier, 'neon');

  for (const [raw, lvl] of [
    ['Gemini 4 Neon (Low)', 'low'],
    ['gemini-4-neon-medium', 'medium'],
    ['Gemini 4 Neon (High)', 'high'],
    ['gemini-4-neon-xhigh', 'xhigh'],
    ['Neon (High)', 'high'],
  ]) {
    const p = normalizeModelProfile(raw);
    assert.equal(p.tier, 'neon', `Expected neon tier for ${raw}`);
    assert.equal(p.isNeon, true, `Expected isNeon=true for ${raw}`);
    assert.equal(p.isGemini4, true, `Expected isGemini4=true for ${raw}`);
    assert.equal(p.thinkingLevel, lvl, `Expected thinkingLevel=${lvl} for ${raw}`);
    assert.equal(resolveEffectiveCompactionThreshold(120000, p), 250000);
    assert.equal(resolveRepoMapMaxChars(p), 12000);
    assert.deepEqual(resolveReadDedupPolicy(p), { activeWindowMs: 25 * 60 * 1000, maxStepGap: 45 });
  }

  // 2) Pricing metadata exposes Neon ($3/$15, $0.15 cached)
  const pricing = getPricingPhaseStatus(new Date('2026-11-19T12:00:00Z'));
  assert.deepEqual(pricing.ratesPer1M.neon, { input: 3, output: 15, cachedInput: 0.15 });

  // 3) FinOps evaluateThinkingBurnAdvisory + collectTelemetry integration
  const neonHighProf = normalizeModelProfile('Gemini 4 Neon (High)');
  const neonXHighProf = normalizeModelProfile('gemini-4-neon-xhigh');
  const shortBurn = evaluateThinkingBurnAdvisory({ modelProfile: neonHighProf, steps: 6, outputTokens: 1800, subagents: { flash: 0 } });
  assert.equal(shortBurn.status, 'overprovisioned_high');
  assert.match(shortBurn.advisoryRu, /Orchestrator \(Neon · Средний\)|Hydrogen/);

  const heavyBurn = evaluateThinkingBurnAdvisory({ modelProfile: neonXHighProf, steps: 5, outputTokens: 12000, subagents: { flash: 0 } });
  assert.equal(heavyBurn.status, 'heavy_reasoning');
  assert.match(heavyBurn.advisoryRu, /Orchestrator \(Neon · Высокий\)/);

  const tmpBrain = makeTempDir('amr-neon-brain-');
  const tmpPriorsPath = path.join(SUITE_CACHE_DIR, 'domain-priors.json');
  const prevDomainPriors = fs.existsSync(tmpPriorsPath) ? fs.readFileSync(tmpPriorsPath, 'utf8') : null;
  const turnCachePath = path.join(SUITE_CACHE_DIR, 'pre-invocation-turn.json');
  const prevTurnCache = fs.existsSync(turnCachePath) ? fs.readFileSync(turnCachePath, 'utf8') : null;

  try {
    const chatId = `conv-neon-${Date.now()}`;
    const logPath = path.join(tmpBrain, chatId, '.system_generated', 'logs', 'transcript.jsonl');
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(
      logPath,
      [
        JSON.stringify({
          type: 'USER_INPUT',
          source: 'USER_EXPLICIT',
          content: '<USER_SETTINGS_CHANGE>The user changed setting `Model Selection` from None to Gemini 4 Neon (XHigh).</USER_SETTINGS_CHANGE>\nRefactor router core',
        }),
        ...Array.from({ length: 5 }, () =>
          JSON.stringify({ type: 'PLANNER_RESPONSE', input_tokens: 1000, cache_read_tokens: 9000, output_tokens: 2400 })
        ),
      ].join('\n') + '\n',
      'utf8'
    );

    const tel = collectTelemetry(120000, { brainDirs: [tmpBrain], skipGlobalGpuTelemetry: true });
    assert.equal(tel.activeModel, '');
    assert.equal(tel.isNeon, true);
    assert.equal(tel.activeChat.activeModel, 'Neon · XHigh');
    assert.equal(tel.thinkingBurnStatus, 'heavy_reasoning');
    assert.match(tel.thinkingBurnAdvisory, /Orchestrator \(Neon · Высокий\)/);

    // 4) 3-tier selector ladder (Hydrogen -> Neon -> Carbon) + Pro vs Ultra + Argon deprecation
    const xlOrchNeon = evaluateSelectorMatchForTask({
      modelProfile: orchNeon,
      grade: 'XL',
      isDeepAuditOrArch: true,
      matrix2D: { breadth: 'wide', depth: 'deep_arch', riskMode: 'critical_blast', isHighBlast: true },
    });
    assert.equal(xlOrchNeon.match, 'optimal');

    const xlNeonXHigh = evaluateSelectorMatchForTask({
      modelProfile: neonXHighProf,
      grade: 'XL',
      isDeepAuditOrArch: true,
      matrix2D: { breadth: 'wide', depth: 'deep_arch', riskMode: 'clear' },
    });
    assert.equal(xlNeonXHigh.match, 'optimal');

    const deepNeonHigh = evaluateSelectorMatchForTask({
      modelProfile: neonHighProf,
      grade: 'L',
      isDeepAuditOrArch: true,
      matrix2D: { breadth: 'narrow', depth: 'deep_arch', riskMode: 'exploratory' },
    });
    assert.equal(deepNeonHigh.match, 'optimal');

    const critNeonHigh = evaluateSelectorMatchForTask({
      modelProfile: neonHighProf,
      grade: 'L',
      matrix2D: { breadth: 'moderate', depth: 'integrated', riskMode: 'critical_blast', isHighBlast: true },
    });
    assert.equal(critNeonHigh.match, 'optimal');

    const smallOverNeon = evaluateSelectorMatchForTask({
      modelProfile: neonXHighProf,
      grade: 'S',
      matrix2D: { breadth: 'narrow', depth: 'routine', riskMode: 'clear' },
    });
    assert.equal(smallOverNeon.match, 'overprovisioned');
    assert.match(smallOverNeon.recommendedRu, /Hydrogen/i);

    const medOverNeon = evaluateSelectorMatchForTask({
      modelProfile: neonHighProf,
      grade: 'M',
      matrix2D: { breadth: 'narrow', depth: 'routine', riskMode: 'clear' },
    });
    assert.equal(medOverNeon.match, 'overprovisioned');

    const wideRoutineNeon = evaluateSelectorMatchForTask({
      modelProfile: neonHighProf,
      grade: 'L',
      matrix2D: { breadth: 'wide', depth: 'routine', riskMode: 'clear' },
    });
    assert.equal(wideRoutineNeon.match, 'overprovisioned');
    assert.match(wideRoutineNeon.recommendedRu, /Hydrogen/i);

    const argonL = evaluateSelectorMatchForTask({
      modelProfile: normalizeModelProfile('Gemini 4 Argon (High)'),
      grade: 'L',
      matrix2D: { breadth: 'moderate', depth: 'integrated', riskMode: 'clear' },
    });
    assert.equal(argonL.match, 'overprovisioned');
    assert.match(argonL.recommendedRu, /Orchestrator \(Neon · Высокий\)/);

    const orchArgonL = evaluateSelectorMatchForTask({
      modelProfile: normalizeModelProfile('Orchestrator (Argon)'),
      grade: 'L',
      matrix2D: { breadth: 'moderate', depth: 'integrated', riskMode: 'clear' },
    });
    assert.equal(orchArgonL.match, 'overprovisioned');

    const proCritHydrogen = evaluateSelectorMatchForTask({
      modelProfile: normalizeModelProfile('Gemini 4 Hydrogen (Medium)'),
      grade: 'L',
      matrix2D: { breadth: 'moderate', depth: 'integrated', riskMode: 'critical_blast', isHighBlast: true },
      state: { subscriptionTier: 'pro' },
    });
    assert.equal(proCritHydrogen.match, 'underprovisioned');
    assert.ok(proCritHydrogen.recommendedRu.startsWith('Orchestrator (Neon · Высокий/XHigh)'));
    assert.doesNotMatch(proCritHydrogen.recommendedRu, /\bCarbon\b/i);
    const ultraCritHydrogen = evaluateSelectorMatchForTask({
      modelProfile: normalizeModelProfile('Gemini 4 Hydrogen (Medium)'),
      grade: 'L',
      matrix2D: { breadth: 'moderate', depth: 'integrated', riskMode: 'critical_blast', isHighBlast: true },
      state: { subscriptionTier: 'ultra' },
    });
    assert.equal(ultraCritHydrogen.match, 'underprovisioned');
    assert.match(ultraCritHydrogen.recommendedRu, /Carbon/);

    // 5) ask_question Selector Guard allows Neon recommendations on L/XL/Deep and catches Neon XHigh on S
    const concreteNeonOpts = [
      '(Recommended) Обновить маршрутизацию в core/model-profile.mjs и core/hook-runner.mjs (на Orchestrator (Neon · Высокий))',
      'Оставить прежний порог без Neon',
      'Только read-only проверка зависимостей',
    ];
    const convNeonAllow = `conv-neon-allow-${process.pid}-${Date.now()}`;
    const allowNeonXl = await handlePreToolUse(
      {
        conversationId: convNeonAllow,
        toolName: 'ask_question',
        modelName: 'gemini-4-hydrogen-medium',
        args: {
          questions: [
            {
              question:
                'План автопилота: перестроить архитектуру 5 модулей. Объём: XL. Рекомендуемая мощность: Neon · XHigh. 💡 Совет по режиму: сейчас выбран Hydrogen · Средний — лучше переключить на Neon · XHigh. Запускаем?',
              options: concreteNeonOpts,
            },
          ],
        },
      },
      { confirmBeforeRun: true, pureCognitiveTriage: true }
    );
    assert.equal(allowNeonXl.decision, 'allow');

    const convNeonAllowS = `conv-neon-allows-${process.pid}-${Date.now()}`;
    const allowNeonS = await handlePreToolUse(
      {
        conversationId: convNeonAllowS,
        toolName: 'ask_question',
        modelName: 'gemini-4-neon-xhigh',
        args: {
          questions: [
            {
              question: 'План автопилота: поправить цвет кнопки в sidecars/panel/ui.html. Объём: S. Рекомендуемая мощность: Neon · XHigh. Запускаем?',
              options: concreteNeonOpts,
            },
          ],
        },
      },
      { confirmBeforeRun: true, pureCognitiveTriage: true }
    );
    assert.equal(allowNeonS.decision, 'allow');

    // 6) Bayesian 3-tier cascade (Hydrogen -> Orchestrator (Neon · Высокий)/Neon -> Orchestrator (Carbon · Высокий))
    const domMed = `neon_bay_med_${Date.now()}`;
    recordModelOutcome({ domain: domMed, success: false, weight: 0.7 });
    const bayMed = evaluateBayesianRoute({ domain: domMed, grade: 'M' });
    assert.equal(bayMed.depthBoost, 1);
    assert.match(bayMed.recommendedGemini4, /Orchestrator \(Neon · Высокий\)/);

    const domLow = `neon_bay_low_${Date.now()}`;
    recordModelOutcome({ domain: domLow, success: false });
    recordModelOutcome({ domain: domLow, success: false });
    const bayLow = evaluateBayesianRoute({ domain: domLow, grade: 'M' });
    assert.equal(bayLow.depthBoost, 2);
    assert.match(bayLow.recommendedGemini4, /Orchestrator \(Carbon · Высокий\).*Orchestrator \(Neon · Высокий\/XHigh\)/);

    const baySum = getBayesianSummary();
    assert.ok(Array.isArray(baySum.domains) && baySum.domains.length > 0);

    // 7) Swarm neon_auto, stats tracking, sanitizeStatePatch & cross-bucket Quota Failover
    const swNeonDir = evaluateSwarmRoutingDirective({
      state: { swarmMode: 'auto_xl', swarmWorkerTier: 'neon_auto', swarmAutoVerifier: true },
      modelProfile: orchNeon,
      grade: 'XL',
      matchedFilesCount: 5,
      subsystemHits: 3,
      swarmCtx: { role: 'coordinator', explicitSwarmRequest: true },
    });
    assert.equal(swNeonDir.shouldActivateSwarm, true);
    assert.match(swNeonDir.directiveEn, /gemini-4-neon-medium/);

    const swQuotaDir = evaluateSwarmRoutingDirective({
      state: { swarmMode: 'auto_xl', swarmQuotaFailover: true },
      modelProfile: orchNeon,
      grade: 'XL',
      matchedFilesCount: 5,
      swarmCtx: { role: 'coordinator', hasQuotaSignal: true },
    });
    assert.match(swQuotaDir.directiveEn, /gemini-4-neon-medium/);
    assert.match(swQuotaDir.directiveEn, /claude-sonnet-4-6/);

    const swStats = parseSwarmStatsFromTranscriptLines([
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        tool_calls: [
          { name: 'swarm', args: { action: 'add', name: 'core-author', model: 'gemini-4-neon-medium', workspace: 'share' } },
          { name: 'swarm', args: { action: 'add', name: 'ui-author', model: 'gemini-4-hydrogen-medium', workspace: 'share' } },
        ],
      }),
    ]);
    assert.equal(swStats.neonWorkers, 1);
    assert.equal(swStats.hydrogenWorkers, 1);
    assert.equal(swStats.members.find((m) => m.name === 'core-author')?.isNeon, true);

    const patchedTier = sanitizeStatePatch({ swarmWorkerTier: 'neon_auto' });
    assert.equal(patchedTier.swarmWorkerTier, 'neon_auto');
  } finally {
    fs.rmSync(tmpBrain, { recursive: true, force: true });
    if (prevDomainPriors === null) {
      try { fs.rmSync(tmpPriorsPath, { force: true }); } catch {}
    } else {
      fs.writeFileSync(tmpPriorsPath, prevDomainPriors, 'utf8');
    }
    if (prevTurnCache === null) {
      try { fs.rmSync(turnCachePath, { force: true }); } catch {}
    } else {
      fs.writeFileSync(turnCachePath, prevTurnCache, 'utf8');
    }
  }
});

test('Bayesian Router v4: security domain, anti-confounding tier isolation, precision pooling, signal weights, LCB, Thompson Sampling & residual contextual scorer', async () => {
  const priorsPath = path.join(SUITE_CACHE_DIR, 'domain-priors.json');
  const prevPriors = fs.existsSync(priorsPath) ? fs.readFileSync(priorsPath, 'utf8') : null;
  try {
    try { fs.rmSync(priorsPath, { force: true }); } catch {}

    // 1) security domain is included in summary
    const initSummary = getBayesianSummary();
    assert.ok(initSummary.domains.some((d) => d.key === 'security'), 'security domain must be surfaced in getBayesianSummary()');

    // 2) Anti-confounding (v4.1 symmetric): mid/heavy outcomes must NOT distort light-tier domain/dir priors
    const dIso = `v4_iso_${Date.now()}`;
    const afterLightFail = recordModelOutcome({ domain: dIso, modelTier: 'light', success: false, signalType: 'micro_test' });
    const afterMidSuccess = recordModelOutcome({ domain: dIso, modelTier: 'neon', success: true, signalType: 'micro_test' });
    assert.equal(afterMidSuccess.alpha, afterLightFail.alpha, 'Strong-tier success must NOT artificially inflate light-tier domain alpha');
    assert.equal(afterMidSuccess.confidence, afterLightFail.confidence);

    const routeMid = evaluateBayesianRoute({ domain: dIso, modelTier: 'mid' });
    const routeLight = evaluateBayesianRoute({ domain: dIso, modelTier: 'light' });
    assert.ok(routeMid.confidence > routeLight.confidence, `Expected mid tier confidence (${routeMid.confidence}) > light tier (${routeLight.confidence})`);

    const afterMidFail = recordModelOutcome({ domain: dIso, modelTier: 'neon', success: false, signalType: 'micro_test' });
    assert.equal(afterMidFail.beta, afterMidSuccess.beta, 'Strong-tier failure must NOT poison light-tier domain beta');
    const routeMidAfterFail = evaluateBayesianRoute({ domain: dIso, modelTier: 'mid' });
    assert.ok(
      routeMidAfterFail.confidence < routeMid.confidence,
      `Expected mid tier confidence after mid failure (${routeMidAfterFail.confidence}) < prior mid (${routeMid.confidence})`
    );

    // 3) Precision-weighted pooling: empty dir: prior with 0 runs must not dilute domain prior
    const dPool = `v4_pool_${Date.now()}`;
    for (let i = 0; i < 4; i++) {
      recordModelOutcome({ domain: dPool, modelTier: 'light', success: false, signalType: 'micro_test' });
    }
    const basePoolRoute = evaluateBayesianRoute({ domain: dPool });
    const emptyDirPoolRoute = evaluateBayesianRoute({ domain: dPool, filePath: 'brandnew_empty_dir/mod.mjs' });
    assert.equal(emptyDirPoolRoute.confidence, basePoolRoute.confidence, 'Empty dir prior (runs=0) must not dilute domain prior');

    // 4) Differentiated signal weights: syntax < micro_test on success, rollback > syntax on failure
    const dSyn = `v4_syn_${Date.now()}`;
    const dTst = `v4_tst_${Date.now()}`;
    const synSucc = recordModelOutcome({ domain: dSyn, success: true, signalType: 'syntax', firstPass: false });
    const tstSucc = recordModelOutcome({ domain: dTst, success: true, signalType: 'micro_test', firstPass: false });
    assert.ok(tstSucc.alpha > synSucc.alpha, `Expected micro_test alpha (${tstSucc.alpha}) > syntax alpha (${synSucc.alpha})`);

    const synFail = recordModelOutcome({ domain: `${dSyn}_f`, success: false, signalType: 'syntax' });
    const rbFail = recordModelOutcome({ domain: `${dSyn}_r`, success: false, signalType: 'rollback' });
    assert.ok(rbFail.beta > synFail.beta, `Expected rollback beta (${rbFail.beta}) > syntax fail beta (${synFail.beta})`);

    // 5) Thompson Sampling & LCB fields
    const tsSample = sampleThompsonConfidence(4, 1);
    assert.ok(tsSample >= 0 && tsSample <= 1);
    const exploreRoute = evaluateBayesianRoute({ domain: dIso, explore: true });
    assert.ok(exploreRoute.thompsonSample >= 0 && exploreRoute.thompsonSample <= 1);
    assert.ok(typeof exploreRoute.posteriorStd === 'number' && exploreRoute.posteriorStd > 0);
    assert.ok(exploreRoute.lcbConfidence <= exploreRoute.confidence);

    // 6) Residual contextual Bayesian logistic scorer learns high-risk feature penalties
    const dTrain = `v4_ctx_train_${Date.now()}`;
    for (let i = 0; i < 4; i++) {
      recordModelOutcome({
        domain: dTrain,
        grade: 'XL',
        dependentsCount: 8,
        fragilityScore: 85,
        retries: 2,
        success: false,
        signalType: 'micro_test',
      });
      recordModelOutcome({
        domain: dTrain,
        grade: 'S',
        dependentsCount: 0,
        fragilityScore: 0,
        retries: 0,
        success: true,
        signalType: 'micro_test',
      });
    }
    const cleanDom = `v4_ctx_eval_${Date.now()}`;
    const safeCtxRoute = evaluateBayesianRoute({ domain: cleanDom, grade: 'M', dependentsCount: 0, fragilityScore: 0, retries: 0 });
    const riskyCtxRoute = evaluateBayesianRoute({ domain: cleanDom, grade: 'XL', dependentsCount: 8, fragilityScore: 85, retries: 2 });
    assert.ok(
      riskyCtxRoute.effectiveConfidence < safeCtxRoute.effectiveConfidence,
      `Expected risky XL contextual confidence (${riskyCtxRoute.effectiveConfidence}) < safe M (${safeCtxRoute.effectiveConfidence})`
    );
    assert.ok(getBayesianSummary().contextualUpdates >= 8);

    // 7) High-success mid-tier workload must NOT accumulate negative domain/dir drift
    const dMidHealthy = `v41_mid_healthy_${Date.now()}`;
    for (let i = 0; i < 26; i++) {
      recordModelOutcome({ domain: dMidHealthy, filePath: 'core/sample.mjs', modelTier: 'neon', success: true, signalType: 'micro_test' });
    }
    for (let i = 0; i < 4; i++) {
      recordModelOutcome({ domain: dMidHealthy, filePath: 'core/sample.mjs', modelTier: 'neon', success: false, signalType: 'micro_test' });
    }
    const healthyMidRoute = evaluateBayesianRoute({ domain: dMidHealthy, filePath: 'core/sample.mjs', modelTier: 'mid' });
    assert.ok(healthyMidRoute.confidence >= 0.72, `Expected healthy mid-tier confidence >= 0.72, got ${healthyMidRoute.confidence}`);
    assert.equal(healthyMidRoute.depthBoost, 0);
    const generalCoreRoute = evaluateBayesianRoute({ domain: 'general', filePath: 'core/sample.mjs', modelTier: 'mid' });
    assert.equal(generalCoreRoute.depthBoost, 0);

    // 8) v4.0 -> v4.1 auto-heal restores poisoned domain/dir priors from light tier / default
    fs.writeFileSync(
      priorsPath,
      JSON.stringify({
        version: '4.0',
        priors: {
          backend_db: { alpha: 0.25, beta: 45.7, runs: 227, successes: 12, failures: 215, updatedAt: new Date().toISOString() },
          'dir:core': { alpha: 0.32, beta: 47.0, runs: 154, successes: 4, failures: 150, updatedAt: new Date().toISOString() },
        },
        tierPriors: {
          'backend_db::light': { alpha: 10, beta: 3.4, runs: 13, successes: 12, failures: 1, updatedAt: new Date().toISOString() },
          'backend_db::mid': { alpha: 27.3, beta: 22.0, runs: 846, successes: 675, failures: 171, updatedAt: new Date().toISOString() },
        },
        gradePriors: {},
        fileFragility: {},
      }),
      'utf8'
    );
    const healedRoute = evaluateBayesianRoute({ domain: 'backend_db', filePath: 'core/foo.mjs', modelTier: 'mid' });
    assert.ok(healedRoute.confidence >= 0.72, `Expected auto-healed v4.0->v4.1 confidence >= 0.72, got ${healedRoute.confidence}`);
    assert.equal(healedRoute.depthBoost, 0);
  } finally {
    if (prevPriors === null) {
      try { fs.rmSync(priorsPath, { force: true }); } catch {}
    } else {
      fs.mkdirSync(path.dirname(priorsPath), { recursive: true });
      fs.writeFileSync(priorsPath, prevPriors, 'utf8');
    }
  }
});

test('estimateTaskGradeAndThinkingBudget exposes active subscriptionTier (Sub: Ultra / Sub: Pro) in Read-Only and 3D Triage hints', () => {
  const roUltra = estimateTaskGradeAndThinkingBudget('Почему здесь используется именно эта архитектура?', {
    thinkingLimiter: true,
    subscriptionTier: 'ultra',
  });
  assert.match(roUltra.budgetHint, /Sub: Ultra/);

  const roPro = estimateTaskGradeAndThinkingBudget('Почему здесь используется именно эта архитектура?', {
    thinkingLimiter: true,
    subscriptionTier: 'pro',
  });
  assert.match(roPro.budgetHint, /Sub: Pro/);

  const taskUltra = estimateTaskGradeAndThinkingBudget('Добавь новый эндпоинт и обнови тесты в core/tool-pruner.mjs', {
    thinkingLimiter: true,
    subscriptionTier: 'ultra',
  });
  assert.match(taskUltra.budgetHint, /Sub: Ultra/);
});

test('Stage 1B: PreInvocation suppresses spurious Gold Context on conversational read-only questions without code anchors', async () => {
  const prevCacheEnv = process.env.TUNNEL_CACHE_DIR;
  const tmpCache = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-conv-noise-cache-'));
  const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-conv-noise-ws-'));
  process.env.TUNNEL_CACHE_DIR = tmpCache;
  try {
    const convA = `conv-noise-${process.pid}-${Date.now()}`;
    const res = await handlePreInvocation(
      {
        conversationId: convA,
        workspacePaths: [tmpWs],
        userInput: 'Как думаешь у нас сейчас расширение не перегружено? Есть что можно оптимизировать?',
      },
      {
        ramCacheEnabled: true,
        zeroTurnSlices: true,
        thinkingLimiter: true,
        repoMap: false,
        pitfallLedger: false,
        sessionHandoff: false,
      }
    );
    const joined = (res?.injectSteps || [])
      .map((s) => s?.ephemeralMessage || s?.systemMessage?.systemMessage || '')
      .join('\n');
    assert.doesNotMatch(joined, /Zero-Turn Gold Context/);
  } finally {
    if (prevCacheEnv === undefined) delete process.env.TUNNEL_CACHE_DIR;
    else process.env.TUNNEL_CACHE_DIR = prevCacheEnv;
    fs.rmSync(tmpCache, { recursive: true, force: true });
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
});

test('v3.35.0 Regression Suite: dynamic TUNNEL_CACHE_DIR, linear friction prefix, Grill-Me arch question fork', async () => {
  const { recordCpuTelemetryPatch, readCpuTelemetry } = await import('../core/cpu-worker-pool.mjs');
  const { pinSwarmRole } = await import('../core/swarm-controller.mjs');
  const { detectCliFailRecoveryFriction } = await import('../core/friction-observer.mjs');

  const isoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-dyn-cache-'));
  const prevCache = process.env.TUNNEL_CACHE_DIR;
  process.env.TUNNEL_CACHE_DIR = isoDir;
  try {
    // 1. Dynamic TUNNEL_CACHE_DIR respected after module load
    recordModelOutcome({ domain: 'dyn_iso_dom', success: true, firstPass: true, retries: 0 });
    assert.equal(fs.existsSync(path.join(isoDir, 'domain-priors.json')), true, 'bayesian-router must write to dynamic TUNNEL_CACHE_DIR');

    recordCpuTelemetryPatch((cur) => ({ ...cur, workerBatches: (cur.workerBatches || 0) + 1 }));
    assert.equal(fs.existsSync(path.join(isoDir, 'cpu-telemetry.json')), true, 'cpu-worker-pool must write to dynamic TUNNEL_CACHE_DIR');
    assert.ok(readCpuTelemetry().workerBatches >= 1);

    pinSwarmRole('iso-conv-1', 'coordinator', '');
    assert.equal(fs.existsSync(path.join(isoDir, 'swarm-roles.json')), true, 'swarm-controller must write to dynamic TUNNEL_CACHE_DIR');

    // 2. Linear prefix stripping in friction-observer (POSIX + PowerShell $env:) without ReDoS
    const f1 = detectCliFailRecoveryFriction({
      conversationId: 'fric-lin-1',
      commandLine: 'FOO=1 BAR=2 node app.mjs --unknown-flag',
      exitCode: 1,
      errorOutput: 'unknown option --unknown-flag',
      stateFile: path.join(isoDir, 'fric.json'),
      nowMs: 1000,
    });
    assert.equal(f1.detected, false);
    const f2 = detectCliFailRecoveryFriction({
      conversationId: 'fric-lin-1',
      commandLine: '$env:FOO=1; $env:BAR=2; node app.mjs',
      exitCode: 0,
      errorOutput: '',
      stateFile: path.join(isoDir, 'fric.json'),
      nowMs: 2000,
    });
    assert.equal(f2.detected, true);
    assert.equal(f2.baseCommand, 'node app.mjs');

    // 3. Grill-Me activates on architectural design fork prompt containing '?'
    const archPrompt = 'Нужно спроектировать новую архитектуру синхронизации кэша между воркерами и панелью: выбрать Redis, SQLite WAL или shared memory ring buffer? Какие компромиссы по отказоустойчивости и обратной совместимости';
    const sig = detectPromptIntentSignals(archPrompt);
    assert.equal(sig.isReadOnlyQuestion, false);

    const est = estimateTaskGradeAndThinkingBudget(
      archPrompt,
      { grillMode: 'auto', confirmBeforeRun: true, confirmThreshold: 'M', uiLanguage: 'ru' },
      { wsPath: ROOT_DIR }
    );
    assert.match(est.optionsBlueprint?.formattedBlueprint || '', /Grill-Me/);
  } finally {
    if (prevCache === undefined) delete process.env.TUNNEL_CACHE_DIR;
    else process.env.TUNNEL_CACHE_DIR = prevCache;
    fs.rmSync(isoDir, { recursive: true, force: true });
  }
});

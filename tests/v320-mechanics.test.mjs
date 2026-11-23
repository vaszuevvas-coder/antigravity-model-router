import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveTestPitfallsFromCommand } from '../core/hook-runner.mjs';
import { compressRtkCommandOutput, maskTerminalOutput } from '../core/obs-masker.mjs';
import { checkCommandSecurity } from '../core/security-guard.mjs';
import { crushStructuredPayload } from '../core/cpu-log-json-compressor.mjs';
import { encodeToonTable, crushJsonArrayToToon } from '../core/toon-formatter.mjs';
import { LEXICON_ENTRY_COUNT, expandRuQueryToEnTerms } from '../core/ru-en-lexicon.mjs';
import { compileVoiceOrLongRuPromptPivot } from '../core/tool-pruner.mjs';
import { RamMemoryEngine, inferContextPruningPhase } from '../core/ram-memory-engine.mjs';
import { MCP_TOOLS, executeMcpTool } from '../core/ram-memory-mcp.mjs';
import { computeSymbolReplacement, applySymbolReplacement } from '../core/diff-patcher.mjs';
import { scanAddedIdentifiersForRefBugs, critiqueEditedDiffLocally } from '../core/local-gpu-engine.mjs';
import { collectTelemetry } from '../sidecars/panel/server.mjs';
import { verifySemanticContracts } from '../core/repo-mapper.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('Step 0: resolveTestPitfallsFromCommand ignores passing TAP lines with AssertionError/× and clears implementation pitfalls', async () => {
  const pitfallMod = await import('../core/pitfall-ledger.mjs');
  const tmpWs = makeTempDir('amr-v320-step0-real-');
  try {
    pitfallMod.recordPitfall({
      type: 'test_failure',
      fileName: 'server.mjs',
      summary: '[server.mjs] Test-Impact fail (router-core.test.mjs): AssertionError mismatch',
      workspaceRoot: tmpWs,
    });
    pitfallMod.recordPitfall({
      type: 'test_failure',
      fileName: 'local-gpu-engine.mjs',
      summary: '[local-gpu-engine.mjs] Test-Impact fail (router-core.test.mjs): ReferenceError GPU_PULL_PID',
      workspaceRoot: tmpWs,
    });

    const tapPassOutput = [
      '✔ 12. Checks AssertionError handling × multiplication guard (5.2ms)',
      '✔ 34. Pitfall Ledger auto-resolves test_failure (12.1ms)',
      'ℹ tests 2',
      'ℹ pass 2',
      'ℹ fail 0',
    ].join('\n');

    const res = resolveTestPitfallsFromCommand({
      commandLine: 'node --test tests/*.test.mjs',
      output: tapPassOutput,
      workspaceRoot: tmpWs,
      pitfallLedgerMod: pitfallMod,
    });
    assert.equal(res.resolved, 2);
    assert.equal(pitfallMod.listPitfalls(10, tmpWs).length, 0);
  } finally {
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
});

test('Module 1 (RTK-Shield): TAP/git diff compression & security-guard unbounded command checks', () => {
  const tapLines = Array.from({ length: 30 }, (_, i) => `✔ test case #${i + 1} passed (${i}.1ms)`);
  tapLines.push('ℹ tests 30', 'ℹ pass 30', 'ℹ fail 0');
  const rawTap = tapLines.join('\n');
  const rtkTap = compressRtkCommandOutput(rawTap, 0, 'npm test');
  assert.equal(rtkTap.matched, true);
  assert.equal(rtkTap.profile, 'tap_tests');
  assert.match(rtkTap.compressed, /\[✓ RTK-Test Summary: 30 passed, 0 failed/);
  assert.ok(rtkTap.savedChars > rawTap.length * 0.6);

  const maskedTap = maskTerminalOutput(rawTap, 0, { commandLine: 'npm test' });
  assert.equal(maskedTap.cpuCompressed, true);
  assert.equal(maskedTap.rtkProfile, 'tap_tests');

  const diffChunks = [];
  for (let i = 0; i < 12; i++) {
    diffChunks.push(`diff --git a/src/mod${i}.mjs b/src/mod${i}.mjs`);
    diffChunks.push(`@@ -1,4 +1,5 @@`);
    diffChunks.push(`+const added${i} = ${i};`);
    diffChunks.push(`-const old${i} = ${i};`);
    diffChunks.push(` context line ${i}`);
  }
  const rawDiff = diffChunks.join('\n');
  const rtkDiff = compressRtkCommandOutput(rawDiff, 0, 'git diff');
  assert.equal(rtkDiff.matched, true);
  assert.equal(rtkDiff.profile, 'git_diff');
  assert.match(rtkDiff.compressed, /\[⚡ RTK-GitDiff: 12 files/);

  assert.equal(checkCommandSecurity({ commandLine: 'git log --oneline -p' }).allow, false);
  assert.equal(checkCommandSecurity({ commandLine: 'git log -n 3 -p' }).allow, true);
  assert.equal(checkCommandSecurity({ commandLine: 'Get-Content package-lock.json' }).allow, false);
  assert.equal(checkCommandSecurity({ commandLine: 'Get-Content package-lock.json | Select-String express' }).allow, true);
});

test('Module 2 (Serena-Lite AST Ops): ram_slice callGraph + applySymbolReplacement atomic patch & syntax rollback', async () => {
  assert.ok(MCP_TOOLS.length >= 8);
  for (const baseName of ['ram_search', 'ram_slice', 'ram_context_pack', 'ram_warm_workspace', 'ram_stats', 'gpu_distill', 'gpu_semantic_search', 'gpu_status']) {
    assert.ok(MCP_TOOLS.some((t) => t.name === baseName), `Missing baseline MCP tool: ${baseName}`);
  }
  const sliceSchema = MCP_TOOLS.find((t) => t.name === 'ram_slice');
  assert.ok(sliceSchema?.inputSchema?.properties?.callGraph);

  const tmpWs = makeTempDir('amr-v320-serena-');
  const ram = new RamMemoryEngine({ budgetMb: 128 });
  try {
    const modA = path.join(tmpWs, 'mathCore.mjs');
    const modB = path.join(tmpWs, 'caller.mjs');
    fs.writeFileSync(
      modA,
      [
        'export function helperMul(x, y) {',
        '  return x * y;',
        '}',
        '',
        'export function computeOrderTotal(price, qty) {',
        '  return helperMul(price, qty) + 10;',
        '}',
      ].join('\n'),
      'utf8'
    );
    fs.writeFileSync(
      modB,
      [
        "import { computeOrderTotal } from './mathCore.mjs';",
        'export function runCheckout() {',
        '  return computeOrderTotal(100, 2);',
        '}',
      ].join('\n'),
      'utf8'
    );

    ram.ensureWarm(tmpWs);
    const cgSlice = ram.slice(tmpWs, 'mathCore.mjs', { symbol: 'computeOrderTotal', callGraph: true });
    assert.equal(cgSlice.ok, true);
    assert.equal(cgSlice.callGraph, true);
    assert.match(cgSlice.formatted, /return helperMul\(price, qty\) \+ 10;/);
    assert.match(cgSlice.formatted, /RepoGraph|callers|runCheckout|helperMul/i);

    const mcpCg = await executeMcpTool('ram_slice', {
      workspaceRoot: tmpWs,
      filePath: 'mathCore.mjs',
      symbol: 'computeOrderTotal',
      callGraph: true,
    });
    assert.equal(mcpCg.isError, false);
    assert.match(mcpCg.text, /RAM Symbol Slice/);

    const patchedMem = computeSymbolReplacement(
      fs.readFileSync(modA, 'utf8'),
      'computeOrderTotal',
      'export function computeOrderTotal(price, qty) {\n  return helperMul(price, qty) + 25;\n}',
      modA
    );
    assert.match(patchedMem.nextContent, /\+ 25;/);

    const patchRes = applySymbolReplacement(
      modA,
      'computeOrderTotal',
      'export function computeOrderTotal(price, qty) {\n  return helperMul(price, qty) + 42;\n}'
    );
    assert.equal(patchRes.ok, true);
    assert.match(fs.readFileSync(modA, 'utf8'), /\+ 42;/);

    assert.throws(
      () => applySymbolReplacement(modA, 'computeOrderTotal', 'export function computeOrderTotal( { broken syntax'),
      /Symbol Patch Aborted/
    );
    assert.match(fs.readFileSync(modA, 'utf8'), /\+ 42;/);
  } finally {
    ram.close();
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
});

test('Module 3 (SWE-Pruner): inferContextPruningPhase & getContextPack dynamic phase budgeting', () => {
  assert.equal(inferContextPruningPhase('Где находится логика авторизации?'), 'explore');
  assert.equal(inferContextPruningPhase('Переименуй функцию foo в файле bar.mjs'), 'edit');
  assert.equal(inferContextPruningPhase('Падает ReferenceError: x is not defined at app.mjs:12'), 'debug');

  const tmpWs = makeTempDir('amr-v320-swe-');
  const ram = new RamMemoryEngine({ budgetMb: 128 });
  try {
    const bigLines = ['export function targetBuggyWorker(token) {', '  const result = token.trim();', '  return result;', '}'];
    for (let i = 0; i < 160; i++) {
      bigLines.push(`export function fillerFn${i}(v) { return v + ${i}; }`);
    }
    fs.writeFileSync(path.join(tmpWs, 'worker.mjs'), bigLines.join('\n'), 'utf8');
    ram.ensureWarm(tmpWs);

    const explorePack = ram.getContextPack(tmpWs, 'Обзор worker token', { phase: 'explore', maxChars: 4200 });
    assert.equal(explorePack.ok, true);
    assert.equal(explorePack.phase, 'explore');
    assert.match(explorePack.formatted, /## ⚡ RAM Relevant Slices/);
    assert.match(explorePack.formatted, /## 🩻 AST Skeleton Focus \(explore\)/);

    const debugPack = ram.getContextPack(tmpWs, 'ReferenceError targetBuggyWorker at worker.mjs:2', { phase: 'debug', maxChars: 4200 });
    assert.equal(debugPack.ok, true);
    assert.equal(debugPack.phase, 'debug');
    assert.match(debugPack.formatted, /## 🔬 Debug Data-Flow Slice/);
  } finally {
    ram.close();
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
});

test('Module 4 (TOON): encodeToonTable, crushJsonArrayToToon >35% savings, and getFastRepoMap TOON mode', () => {
  const rows = Array.from({ length: 24 }, (_, i) => ({
    id: i + 1,
    service: `svc-${i % 4}`,
    status: i === 11 ? 502 : 200,
    ok: i !== 11,
    error: i === 11 ? 'Bad Gateway upstream' : '',
  }));
  const tbl = encodeToonTable('checks', rows);
  assert.equal(tbl.ok, true);
  assert.match(tbl.toon, /^checks\[24\]\{id,service,status,ok,error\}:/);
  assert.ok(tbl.savedChars / tbl.originalChars > 0.35, `Expected >35% savings, got ${tbl.savedChars}/${tbl.originalChars}`);

  const crushed = crushStructuredPayload(JSON.stringify(rows, null, 2), { format: 'toon', sampleKeep: 2 });
  assert.equal(crushed.wasCrushed, true);
  assert.equal(crushed.format, 'toon');
  assert.equal(crushed.anomaliesKept, 1);
  assert.match(crushed.crushed, /Bad Gateway upstream/);

  const tmpWs = makeTempDir('amr-v320-toon-');
  const ram = new RamMemoryEngine({ budgetMb: 128 });
  try {
    fs.writeFileSync(
      path.join(tmpWs, 'demo.mjs'),
      'export function alpha(a) { return a; }\nexport function beta(b) { return b; }\n',
      'utf8'
    );
    ram.ensureWarm(tmpWs);
    const mdMap = ram.getFastRepoMap(tmpWs, 4000, { toon: false });
    const toonMap = ram.getFastRepoMap(tmpWs, 4000, { toon: true });
    assert.equal(mdMap.toon, false);
    assert.equal(toonMap.toon, true);
    assert.match(toonMap.markdown, /^# RAM Repo Map TOON/);
    assert.match(toonMap.markdown, /symbols\[2\]\{kind,name,lines\}:/);
  } finally {
    ram.close();
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
});

test('Module 5 (RU-EN Lexicon >=250 & Voice Pivot): CPU-only Russian search finds English symbols + prompt pivot', () => {
  assert.ok(LEXICON_ENTRY_COUNT >= 250, `Expected >=250 RU-EN stems, got ${LEXICON_ENTRY_COUNT}`);
  const exp = expandRuQueryToEnTerms('утечка слушателей и троттлинг куки миграции');
  assert.ok(exp.enTerms.includes('leak'));
  assert.ok(exp.enTerms.includes('listener'));
  assert.ok(exp.enTerms.includes('throttle'));
  assert.ok(exp.enTerms.includes('cookie'));
  assert.ok(exp.enTerms.includes('migration'));

  const tmpWs = makeTempDir('amr-v320-lex-');
  const ram = new RamMemoryEngine({ budgetMb: 128 });
  try {
    fs.writeFileSync(
      path.join(tmpWs, 'eventBus.mjs'),
      'export function attachEventListenerThrottle(emitter, delayMs) {\n  return { listener: emitter, throttleMs: delayMs };\n}\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmpWs, 'dummy.mjs'),
      'export const placeholderValue = 123;\n',
      'utf8'
    );
    ram.ensureWarm(tmpWs);
    const res = ram.search(tmpWs, 'проверь слушателей событий и троттлинг');
    assert.equal(res.ok, true);
    assert.equal(res.results[0]?.file, 'eventBus.mjs');
  } finally {
    ram.close();
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }

  const shortRo = compileVoiceOrLongRuPromptPivot('Почему тормозит троттлинг?');
  assert.equal(shortRo.triggered, false);

  const voicePrompt =
    'Короче, смотри, в общем нужно переделать модуль маршрутизации, ' +
    'потому что слушатели событий утекают, куки не проверяются, кэш протухает, и вообще как-то так всё тормозит. ' +
    'Давай сделаем так, чтобы при редактировании файлов сразу проверялись контракты и ошибки синтаксиса, и по сути всё откатывалось чекпоинтом.';
  const pivot = compileVoiceOrLongRuPromptPivot(voicePrompt);
  assert.equal(pivot.triggered, true);
  assert.match(pivot.formattedPivot, /\[RU->EN Execution Pivot\]/);
  assert.ok(pivot.enTerms.length >= 3);
});

test('Module 6 (Post-Edit Diff Critic): zero false positives across core/*.mjs, catches GPU_PULL_PID, and mocks GPU check', async () => {
  const coreFiles = fs.readdirSync(path.join(ROOT_DIR, 'core')).filter((f) => f.endsWith('.mjs'));
  for (const f of coreFiles) {
    const content = fs.readFileSync(path.join(ROOT_DIR, 'core', f), 'utf8');
    const res = scanAddedIdentifiersForRefBugs('', content, '.mjs');
    assert.equal(res.ok, true, `Unexpected false positive in core/${f}: ${res.issues.join('; ')}`);
  }

  const caught = scanAddedIdentifiersForRefBugs(
    'export function start() {\n  return 1;\n}\n',
    'export function start() {\n  if (GPU_PULL_PID > 0) return GPU_PULL_PID;\n  return 1;\n}\n',
    '.mjs'
  );
  assert.equal(caught.ok, false);
  assert.match(caught.issues[0], /GPU_PULL_PID/);

  const cpuCritic = await critiqueEditedDiffLocally({
    filePath: 'demo.mjs',
    oldText: 'const a = 1;\n',
    newText: 'const a = 1;\nconst b = MISSING_GLOBAL_VAR + a;\n',
  });
  assert.equal(cpuCritic.hasBug, true);
  assert.equal(cpuCritic.source, 'cpu_ref_guard');

  const gpuCritic = await critiqueEditedDiffLocally({
    filePath: 'demo.mjs',
    oldText: 'export function run(x) { return x; }\n',
    newText: 'export function run(x) { return x; }\nexport function addedFn(y) { const z = y * 2; return z; }\n',
    cfgOverride: { gpuEnabled: true, gpuPostEditCritic: true, gpuMaxVramMb: 12288, gpuChatModel: 'gemma4:12b', gpuEmbedModel: 'qwen3-embedding:0.6b' },
    httpJsonFn: async () => ({ ok: true, data: { message: { content: 'BUG: addedFn does not validate NaN input' } } }),
  });
  assert.equal(gpuCritic.hasBug, true);
  assert.match(gpuCritic.alert, /GPU Diff Critic/);

  // Cascade fallback when qwen3-embedding:4b leaves tight chat VRAM budget (8192 MB)
  let capturedPrompt = '';
  const cascadeCritic = await critiqueEditedDiffLocally({
    filePath: 'demo.mjs',
    oldText: 'export function processUser(uid) {\n  return uid;\n}\n',
    newText: 'export function processUser(uid) {\n  const normalized = String(uid || "").trim();\n  return normalized;\n}\n',
    cfgOverride: { gpuEnabled: true, gpuPostEditCritic: true, gpuMaxVramMb: 8192, gpuChatModel: 'gemma4:12b', gpuEmbedModel: 'qwen3-embedding:4b' },
    httpJsonFn: async (_m, _p, body) => {
      capturedPrompt = body?.messages?.[0]?.content || '';
      return { ok: true, data: { message: { content: 'OK' } } };
    },
  });
  assert.equal(cascadeCritic.ok, true);
  assert.equal(cascadeCritic.hasBug, false);
  assert.match(capturedPrompt, /Enclosing scope: export function processUser\(uid\)/);
});

test('Module 7 (4-Pillar Token & Cache Meter): server telemetry savingsBreakdown + ui.html DOM ID integrity', () => {
  const tmpBrain = makeTempDir('amr-v320-tel-');
  try {
    const chatLog = path.join(tmpBrain, 'chat-v320', '.system_generated', 'logs', 'transcript.jsonl');
    fs.mkdirSync(path.dirname(chatLog), { recursive: true });
    fs.writeFileSync(
      chatLog,
      [
        JSON.stringify({ type: 'USER_INPUT', source: 'USER_EXPLICIT', content: 'Тест метрик' }),
        JSON.stringify({ type: 'PLANNER_RESPONSE', input_tokens: 1000, cache_read_tokens: 4000, output_tokens: 200 }),
      ].join('\n') + '\n',
      'utf8'
    );

    const tel = collectTelemetry(120000, { brainDirs: [tmpBrain], skipGlobalGpuTelemetry: true });
    assert.equal(tel.cacheHitRate, 80);
    assert.equal(tel.cpuSavedTokens, 0);
    assert.ok(tel.savingsBreakdown && typeof tel.savingsBreakdown === 'object');
    assert.equal(tel.savingsBreakdown.cache, Math.round(4000 * 0.95));
    assert.equal(tel.savingsBreakdown.cacheHitRate, 80);

    const uiHtml = fs.readFileSync(path.join(ROOT_DIR, 'sidecars', 'panel', 'ui.html'), 'utf8');
    for (const id of [
      'metricCacheHitBadge',
      'metricSavedBreakdownGrid',
      'metricSavedCacheVal',
      'metricSavedRamVal',
      'metricSavedCpuVal',
      'metricSavedGpuVal',
      'chk-gpuPostEditCritic',
    ]) {
      assert.ok(uiHtml.includes(`id="${id}"`), `Missing DOM id="${id}" in ui.html`);
    }

    const semCheck = verifySemanticContracts(ROOT_DIR, path.join(ROOT_DIR, 'sidecars', 'panel', 'ui.html'));
    assert.equal(semCheck.valid, true, `Semantic DOM check failed: ${semCheck.formattedAlert}`);
  } finally {
    fs.rmSync(tmpBrain, { recursive: true, force: true });
  }
});

test('CPU Telemetry Fixes: server reads cpuSavedTokensEstimate, obs-masker tags json vs drain, RamMemoryEngine records knapsack/mmr', async () => {
  const telemetryFile = path.join(ROOT_DIR, '.cache', 'cpu-telemetry.json');
  const prevRaw = fs.existsSync(telemetryFile) ? fs.readFileSync(telemetryFile, 'utf8') : null;
  const tmpBrain = makeTempDir('amr-v320-cputel-');
  const tmpWs = makeTempDir('amr-v320-cpuws-');

  try {
    const { readCpuTelemetry, recordCpuCompressionSaving } = await import('../core/cpu-worker-pool.mjs');
    fs.mkdirSync(path.dirname(telemetryFile), { recursive: true });
    recordCpuCompressionSaving({ kind: 'json', savedChars: 1900, latencyMs: 1.0 });
    const telAfterJson = readCpuTelemetry();
    assert.ok(telAfterJson.cpuSavedTokensEstimate >= 500, 'Expected cpuSavedTokensEstimate >= 500');

    const chatLog = path.join(tmpBrain, 'chat-cpu', '.system_generated', 'logs', 'transcript.jsonl');
    fs.mkdirSync(path.dirname(chatLog), { recursive: true });
    fs.writeFileSync(
      chatLog,
      JSON.stringify({ type: 'PLANNER_RESPONSE', input_tokens: 100, cache_read_tokens: 100, output_tokens: 50 }) + '\n',
      'utf8'
    );
    const serverTel = collectTelemetry(120000, { brainDirs: [tmpBrain], skipGlobalGpuTelemetry: false });
    assert.ok(serverTel.cpuSavedTokens >= 500, `Expected serverTel.cpuSavedTokens >= 500, got ${serverTel.cpuSavedTokens}`);
    assert.equal(serverTel.savingsBreakdown.cpu, serverTel.cpuSavedTokens);

    const jsonItems = Array.from({ length: 18 }, (_, i) => ({ id: i, status: 'ok', message: 'repeated item payload' }));
    const jsonMasked = maskTerminalOutput(JSON.stringify(jsonItems, null, 2), 0);
    assert.equal(jsonMasked.wasCrushed, true);
    assert.equal(jsonMasked.compressionKind, 'json');

    const logLines = Array.from({ length: 30 }, (_, i) => `2026-11-17T10:00:${String(i).padStart(2, '0')}Z INFO worker-${i % 2} synced batch ok`).join('\n');
    const drainMasked = maskTerminalOutput(logLines, 0);
    assert.equal(drainMasked.wasCrushed, false);
    assert.equal(drainMasked.compressionKind, 'drain');

    const bigCode = Array.from({ length: 45 }, (_, i) =>
      `export function helper_${i}(val) {\n  const x = val + ${i};\n  return x * 2;\n}`
    ).join('\n\n');
    fs.writeFileSync(path.join(tmpWs, 'sample.mjs'), bigCode, 'utf8');
    const engine = new RamMemoryEngine({ budgetMb: 128 });
    const beforeKnapsack = readCpuTelemetry().knapsackFoldedSlices || 0;
    const skel = engine.skeletonize(tmpWs, 'sample.mjs', { query: 'helper_10', maxChars: 600 });
    assert.equal(skel.ok, true);
    assert.ok(skel.savedChars > 0);
    const afterKnapsack = readCpuTelemetry().knapsackFoldedSlices || 0;
    assert.equal(afterKnapsack, beforeKnapsack + 1);
  } finally {
    fs.rmSync(tmpBrain, { recursive: true, force: true });
    fs.rmSync(tmpWs, { recursive: true, force: true });
    if (prevRaw !== null) {
      fs.writeFileSync(telemetryFile, prevRaw, 'utf8');
    } else if (fs.existsSync(telemetryFile)) {
      fs.rmSync(telemetryFile, { force: true });
    }
  }
});

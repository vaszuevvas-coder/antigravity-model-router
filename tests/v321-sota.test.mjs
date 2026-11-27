import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { critiqueEditedDiffLocally, decodeTextBufferAutoUtf } from '../core/local-gpu-engine.mjs';
import { buildCacheAlignedInjection, resolveTestPitfallsFromCommand } from '../core/hook-runner.mjs';
import { listPitfalls, recordContrastiveLesson, recordPitfall, clearPitfalls } from '../core/pitfall-ledger.mjs';
import { formatHandoffForSessionStart, recordHandoffAction, recordHandoffGoal, clearSessionHandoff } from '../core/session-handoff.mjs';
import { canonicalizeJson, flattenNestedConfigToDotPaths, toPosixRelPath } from '../core/toon-formatter.mjs';
import { RamMemoryEngine } from '../core/ram-memory-engine.mjs';
import { computeMyersLineDelta } from '../core/cpu-delta-reread.mjs';
import { extractTopFaultCodePin, maskTerminalOutput } from '../core/obs-masker.mjs';
import { computePatchedContent } from '../core/diff-patcher.mjs';
import { analyzeAgentDietTrajectoryWaste } from '../core/history-compactor.mjs';
import {
  buildAdaptiveReasoningDirective,
  compileVoiceOrLongRuPromptPivot,
  detectPromptIntentSignals,
  estimateTaskGradeAndThinkingBudget,
} from '../core/tool-pruner.mjs';
import { buildCleanRestartOverlay, detectSemanticOscillation } from '../core/circuit-breaker.mjs';
import { evaluateBayesianRoute, recordModelOutcome } from '../core/bayesian-router.mjs';
import { parseAuditCliArgs } from '../skills/deep-stress-auditor/scripts/run-stress-audit.mjs';
import { runTokenRoiBenchmark } from '../scripts/benchmark-token-roi.mjs';
import { collectTelemetry } from '../sidecars/panel/server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('1. decodeTextBufferAutoUtf decodes UTF-16LE (BOM & BOM-less), UTF-16BE, UTF-8 BOM and rejects true binary', () => {
  const sample = 'PASS: all 74 tests succeeded\nEXIT_CODE=0\n';

  const utf16LeBom = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(sample, 'utf16le')]);
  const rLeBom = decodeTextBufferAutoUtf(utf16LeBom);
  assert.equal(rLeBom.ok, true);
  assert.equal(rLeBom.encoding, 'utf16le');
  assert.equal(rLeBom.text, sample);

  const utf16LeNoBom = Buffer.from(sample, 'utf16le');
  const rLeNoBom = decodeTextBufferAutoUtf(utf16LeNoBom);
  assert.equal(rLeNoBom.ok, true);
  assert.equal(rLeNoBom.encoding, 'utf16le');
  assert.equal(rLeNoBom.text, sample);

  const leBody = Buffer.from(sample, 'utf16le');
  const beBody = Buffer.from(leBody);
  for (let i = 0; i + 1 < beBody.length; i += 2) {
    const t = beBody[i];
    beBody[i] = beBody[i + 1];
    beBody[i + 1] = t;
  }
  const utf16BeBom = Buffer.concat([Buffer.from([0xfe, 0xff]), beBody]);
  const rBeBom = decodeTextBufferAutoUtf(utf16BeBom);
  assert.equal(rBeBom.ok, true);
  assert.equal(rBeBom.encoding, 'utf16be');
  assert.equal(rBeBom.text, sample);

  const utf8Bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(sample, 'utf8')]);
  const rU8 = decodeTextBufferAutoUtf(utf8Bom);
  assert.equal(rU8.ok, true);
  assert.equal(rU8.encoding, 'utf8-bom');
  assert.equal(rU8.text, sample);

  const realBinary = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00]);
  const rBin = decodeTextBufferAutoUtf(realBinary);
  assert.equal(rBin.ok, false);
  assert.match(rBin.error, /Binary file detected/);
});

test('2. critiqueEditedDiffLocally cascades on tight VRAM and injects enclosing function header', async () => {
  let sentBody = null;
  const res = await critiqueEditedDiffLocally({
    filePath: 'sample.mjs',
    oldText: 'export async function fetchUser(userId, opts = {}) {\n  return userId;\n}\n',
    newText: 'export async function fetchUser(userId, opts = {}) {\n  const normalized = String(userId || "").trim();\n  return { id: normalized, opts };\n}\n',
    cfgOverride: { gpuEnabled: true, gpuPostEditCritic: true, gpuMaxVramMb: 8192, gpuChatModel: 'gemma4:12b', gpuEmbedModel: 'qwen3-embedding:4b' },
    httpJsonFn: async (_m, _p, body) => {
      sentBody = body;
      return { ok: true, data: { message: { content: 'OK' } } };
    },
  });
  assert.equal(res.ok, true);
  assert.equal(res.hasBug, false);
  assert.ok(sentBody?.messages?.[0]?.content.includes('Enclosing scope: export async function fetchUser(userId, opts = {})'));
});

test('3. resolveTestPitfallsFromCommand partially clears passing test files while keeping failing test file + ReasoningBank', async () => {
  const { resolvePitfallsForFile } = await import('../core/pitfall-ledger.mjs');
  const tmpWs = makeTempDir('amr-v321-pf2-');
  try {
    recordPitfall({
      type: 'test_failure',
      fileName: 'obs-masker.mjs',
      summary: '[obs-masker.mjs] Test-Impact fail (cpu-log-json.test.mjs): AssertionError',
      workspaceRoot: tmpWs,
    });
    recordPitfall({
      type: 'test_failure',
      fileName: 'local-gpu-engine.mjs',
      summary: '[local-gpu-engine.mjs] Test-Impact fail (v320-mechanics.test.mjs): AssertionError',
      workspaceRoot: tmpWs,
    });

    const partialOut = [
      '✔ 1. Drain3 Log Clustering (2ms)',
      '✖ Module 6 (Post-Edit Diff Critic)',
      'test at tests\\v320-mechanics.test.mjs:294:1',
      'AssertionError: false !== true',
      'ℹ tests 10',
      'ℹ pass 9',
      'ℹ fail 1',
    ].join('\n');

    const res = resolveTestPitfallsFromCommand({
      commandLine: 'node --test tests/*.test.mjs > scratch/run.log 2>&1',
      output: partialOut,
      workspaceRoot: tmpWs,
      pitfallLedgerMod: { listPitfalls, resolvePitfallsForFile },
    });
    assert.ok(res.resolved >= 1, 'Expected green test pitfall to be cleared');
    const remaining = listPitfalls(10, tmpWs);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].fileName, 'local-gpu-engine.mjs');

    const lesson = recordContrastiveLesson({
      fileName: 'core/local-gpu-engine.mjs',
      antiPattern: 'Probe raw NUL before UTF-16 BOM check',
      rootCause: 'PowerShell > emits UTF-16LE with 0x00 bytes',
      verifiedFix: 'Use decodeTextBufferAutoUtf before NUL check',
      workspaceRoot: tmpWs,
    });
    assert.match(lesson.rule, /^\[local-gpu-engine\.mjs\] Avoid: .* -> Why: .* -> Fix: /);
    assert.ok(lesson.rule.length <= 220);
  } finally {
    clearPitfalls(tmpWs);
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
});

test('4. Frozen Prefix: formatHandoffForSessionStart omits volatile Updated timestamp, closes truncated brackets, and buildCacheAlignedInjection snaps Gemini 4 prefix floor', () => {
  const tmpWs = makeTempDir('amr-v321-handoff-');
  try {
    recordHandoffGoal({ workspaceRoot: tmpWs, userPrompt: 'Refactor memory indexer and cache prefix stability', domain: 'algo_refactor' });
    recordHandoffAction({
      workspaceRoot: tmpWs,
      filePath: path.join(tmpWs, 'core', 'engine.mjs'),
      verifyOk: false,
      rationale: 'Updated indexer pipeline cleanly',
      rejectedApproach: 'SyntaxError occurred when modifying the legacy parser block without checking token stream bounds first',
    });

    const formatted = formatHandoffForSessionStart(tmpWs);
    assert.equal(formatted.includes('Updated:'), false, 'Volatile Updated timestamp must not mutate Frozen Prefix');
    assert.match(formatted, /Domain: algo_refactor/);
    const openB = (formatted.match(/\[/g) || []).length;
    const closeB = (formatted.match(/\]/g) || []).length;
    assert.equal(openB, closeB, 'Brackets must remain balanced after truncation');

    const longMap = '### `core/a.mjs`\n' + '- `fn()` [L1-L20]\n'.repeat(900);
    const inj = buildCacheAlignedInjection({
      isSessionStart: true,
      repoMapMarkdown: longMap,
      repoMapMaxChars: 4000,
      modelProfile: { isGemini4: true, isFlash: false },
      state: { repoMap: true },
    });
    const sysMsg = inj.injectSteps?.[0]?.systemMessage?.systemMessage || '';
    assert.ok(sysMsg.length >= 14500, `Expected Gemini 4 4096-token floor snap (>=14500 chars), got ${sysMsg.length}`);
  } finally {
    clearSessionHandoff(tmpWs);
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
});

test('5. canonicalizeJson, toPosixRelPath & flattenNestedConfigToDotPaths reduce tokens >35%', () => {
  const a = { z: 1, a: { c: 3, b: 2 } };
  const b = { a: { b: 2, c: 3 }, z: 1 };
  assert.equal(canonicalizeJson(a), canonicalizeJson(b));

  const rel = toPosixRelPath('C:\\Users\\dev\\repo\\core\\hook-runner.mjs', 'c:/users/dev/repo');
  assert.equal(rel, 'core/hook-runner.mjs');

  const cfg = {
    app: {
      auth: { oauth2: { pkce: { enabled: true, ttlSec: 3600 } } },
      storage: { postgres: { pool: { minIdle: 2, maxConn: 16 } } },
      telemetry: { otel: { exporter: { endpoint: 'http://127.0.0.1:4318' } } },
      cache: { redis: { cluster: { retryMs: 250 } } },
    },
  };
  const flat = flattenNestedConfigToDotPaths(cfg);
  assert.equal(flat.ok, true);
  assert.match(flat.text, /app\.auth\.oauth2\.pkce\.enabled=true/);
  const ratio = flat.savedChars / flat.originalChars;
  assert.ok(ratio > 0.35, `Expected >35% savings from dot-path flattening, got ${(ratio * 100).toFixed(1)}%`);
});

test('6. RamMemoryEngine: getTwoHopContractStrip, skimCodeBlocksByQuery, findCrossLayerSeams, compactLines slice & AST-Delta', () => {
  const tmpWs = makeTempDir('amr-v321-ram-');
  const ram = new RamMemoryEngine({ budgetMb: 128 });
  try {
    fs.mkdirSync(path.join(tmpWs, 'core'), { recursive: true });
    fs.mkdirSync(path.join(tmpWs, 'ui'), { recursive: true });

    fs.writeFileSync(
      path.join(tmpWs, 'core', 'helper.mjs'),
      'export function validateSessionToken(tokenStr, ttlSec = 60) {\n  return Boolean(tokenStr && ttlSec > 0);\n}\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmpWs, 'core', 'auth.mjs'),
      [
        "import { validateSessionToken } from './helper.mjs';",
        'export const FLAG_KEY = "gpuPostEditCritic";',
        'export function authorizeClient(rawToken) {',
        '  const ok = validateSessionToken(rawToken, 120);',
        '  return ok;',
        '}',
      ].join('\n'),
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmpWs, 'core', 'controller.mjs'),
      [
        "import { authorizeClient } from './auth.mjs';",
        'export function handleApiAuth(req) {',
        '  return authorizeClient(req?.token || "");',
        '}',
      ].join('\n'),
      'utf8'
    );
    fs.writeFileSync(path.join(tmpWs, 'router-state.json'), '{"gpuPostEditCritic": true}\n', 'utf8');
    fs.writeFileSync(path.join(tmpWs, 'ui', 'panel.html'), '<input id="chk-gpuPostEditCritic" data-key="gpuPostEditCritic" />\n', 'utf8');

    ram.ensureWarm(tmpWs);

    const twoHop = ram.getTwoHopContractStrip(tmpWs, [{ file: 'core/auth.mjs', startLine: 3, endLine: 6 }]);
    assert.equal(twoHop.ok, true);
    assert.match(twoHop.formattedHint, /2-Hop Contracts/);
    assert.match(twoHop.formattedHint, /validateSessionToken/);
    assert.match(twoHop.formattedHint, /controller\.mjs/);

    const seams = ram.findCrossLayerSeams(tmpWs, 'gpuPostEditCritic');
    assert.equal(seams.ok, true);
    assert.ok(seams.layersFound.includes('config'));
    assert.ok(seams.layersFound.includes('code'));
    assert.ok(seams.layersFound.includes('ui'));

    const bigFn = [
      'export function bigProcessor(input, mode) {',
      '  if (!input) return null;',
      ...Array.from({ length: 24 }, (_, i) => `  const unrelatedStep${i} = ${i} * 2;`),
      '  if (mode === "cacheTokenCheck") {',
      '    const cacheValid = verifyCacheToken(input);',
      '    return cacheValid;',
      '  }',
      ...Array.from({ length: 24 }, (_, i) => `  const trailingStep${i} = ${i} + 1;`),
      '  return false;',
      '}',
    ].join('\n');
    const skimmed = ram.skimCodeBlocksByQuery(bigFn, 'cacheTokenCheck', { maxLines: 24 });
    assert.equal(skimmed.ok, true);
    assert.equal(skimmed.skimmed, true);
    assert.ok(skimmed.keptLines < skimmed.originalLines);
    assert.match(skimmed.formatted, /verifyCacheToken/);
    assert.match(skimmed.formatted, /folded/);

    const compact = ram.slice(tmpWs, 'core/auth.mjs', { startLine: 1, endLine: 4, compactLines: true });
    assert.equal(compact.ok, true);
    assert.match(compact.formatted, /\n1\|import /);

    const baseMod = [
      'export function alphaFn(x) {',
      '  const base = x + 1;',
      '  const adj = base * 2;',
      '  return adj;',
      '}',
      'export function betaFn(y) {',
      '  const step1 = y + 10;',
      '  const step2 = step1 * 2;',
      '  return step2;',
      '}',
      'export function gammaFn(z) {',
      '  const g1 = z - 3;',
      '  const g2 = g1 + 5;',
      '  return g2;',
      '}',
      'export function deltaFn(w) {',
      '  const d1 = w + 4;',
      '  const d2 = d1 * 3;',
      '  return d2;',
      '}',
    ].join('\n');
    const modChanged = baseMod.replace('  const step2 = step1 * 2;', '  const step2 = step1 * 10;');
    const delta = computeMyersLineDelta(baseMod, modChanged, { filePath: 'demo.mjs', maxChangedRatio: 0.6 });
    assert.equal(delta.canUseDelta, true);
    assert.match(delta.astSymbolSummary, /AST-Delta: 3 unchanged symbols \| Modified: betaFn/);
  } finally {
    ram.close();
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
});

test('7. maskTerminalOutput cleans spinners, folds internal frames, pins top fault line, and stays linear O(N) on 50KB unspaced line', () => {
  const tmpWs = makeTempDir('amr-v321-obs-');
  try {
    const srcFile = path.join(tmpWs, 'app.mjs');
    fs.writeFileSync(srcFile, 'const ok = 1;\nthrow new Error("BOOM");\nconst done = 2;\n', 'utf8');

    const logText = [
      'Progress 10%\rProgress 50%\rProgress 100%',
      'Error: BOOM',
      `    at runApp (${srcFile}:2:7)`,
      '    at node:internal/process/task_queues:95:5',
      '    at node:internal/modules/esm/loader:220:10',
      '    at Object.<anonymous> (node_modules/pkg/index.js:4:1)',
    ].join('\n');

    const res = maskTerminalOutput(logText, 1, { workspaceRoot: tmpWs });
    assert.ok(res.masked.includes('Progress 100%'));
    assert.equal(res.masked.includes('Progress 10%'), false);
    assert.match(res.masked, /\[\.\.\. 3 internal frames folded\]/);
    assert.match(res.masked, /📌 \[Fault Pin app\.mjs:2\] -> throw new Error\("BOOM"\);/);

    const t0 = performance.now();
    const pinReDoS = extractTopFaultCodePin('a'.repeat(50000), tmpWs);
    const elapsedMs = performance.now() - t0;
    assert.equal(pinReDoS, '');
    assert.ok(elapsedMs < 25, `Expected O(N) <25ms on 50KB unspaced input, got ${elapsedMs.toFixed(2)}ms`);
  } finally {
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
});

test('8. computePatchedContent applies Fuzzy Indentation Snap uniquely and rejects ambiguous indentation matches', () => {
  const original = [
    'export function outer() {',
    '    if (ready) {',
    '        const value = computeValue(42);',
    '        return value;',
    '    }',
    '}',
  ].join('\n');

  const patchShifted = [
    '<<<<<<< SEARCH',
    'if (ready) {',
    '  const value = computeValue(42);',
    '  return value;',
    '}',
    '=======',
    'if (ready) {',
    '  const value = computeValue(99);',
    '  return value;',
    '}',
    '>>>>>>> REPLACE',
  ].join('\n');

  const applied = computePatchedContent(original, patchShifted);
  assert.equal(applied.appliedBlocks, 1);
  assert.equal(applied.fuzzySnappedBlocks, 1);
  assert.ok(applied.nextContent.includes('        const value = computeValue(99);'));

  const dupOriginal = [
    'function a(flag) {',
    '    if (flag) {',
    '        return 1;',
    '    }',
    '}',
    'function b(flag) {',
    '      if (flag) {',
    '        return 1;',
    '      }',
    '}',
  ].join('\n');
  const patchAmb = '<<<<<<< SEARCH\n  if (flag) {\n    return 1;\n  }\n=======\n  if (flag) {\n    return 2;\n  }\n>>>>>>> REPLACE';
  assert.throws(() => computePatchedContent(dupOriginal, patchAmb), /ambiguous indentation match/i);
});

test('9. AgentDiet, artifact approval detection, Chain-of-Draft directives, FailFast overlay & Bayesian firstPassRate', () => {
  const diet = analyzeAgentDietTrajectoryWaste([
    { tool_calls: [{ name: 'read_file', args: { Path: 'a.mjs' } }], content: 'line '.repeat(100) },
    { content: '✖ FAIL test.mjs\nAssertionError: bad' },
    { tool_calls: [{ name: 'edit_file', args: { Path: 'a.mjs' } }], content: 'ok' },
    { content: '✔ passed\nℹ fail 0' },
  ]);
  assert.equal(diet.supersededStepCount, 2);
  assert.ok(diet.estimatedPrunedTokens > 50);

  const sig = detectPromptIntentSignals('Comments on artifact URI: file:///a.md\n\nThe user has approved this document.\n');
  assert.equal(sig.isApprovalFollowUp, true);
  assert.equal(sig.isArtifactDocApproval, true);

  const budgetApproval = estimateTaskGradeAndThinkingBudget('The user has approved this document.', { confirmBeforeRun: true }, {});
  assert.equal(budgetApproval.isApprovalFollowUp, true);

  assert.match(buildAdaptiveReasoningDirective({ grade: 'S', depth: 'routine', riskMode: 'clear' }), /AdaptThink \/ CoD/);
  assert.match(buildAdaptiveReasoningDirective({ grade: 'L', depth: 'deep_arch', riskMode: 'critical_blast' }), /Counterfactual Gate/);

  const longRu = 'Короче, смотри, в общем нужно поправить плашку кэша и ревизора диффов в панели, потому что там всё тормозит и вообще чекпоинт не срабатывает при правке.'.repeat(2);
  const pivot = compileVoiceOrLongRuPromptPivot(longRu);
  assert.equal(pivot.triggered, true);
  assert.ok(pivot.anchoredEntities.includes('metricCacheHitBadge'));
  assert.ok(pivot.anchoredEntities.includes('gpuPostEditCritic'));

  const mockMapper = {
    rankRepoByPageRank: () => ({
      rankedFiles: [
        { file: 'core/tool-pruner.mjs', seedHits: 2, matchedSymbols: [{ name: 'compileVoiceOrLongRuPromptPivot' }] },
        { file: 'tests/auto-spec-mode.test.mjs', seedHits: 1, matchedSymbols: [{ name: 'resolveAutoSpecOutput' }] },
      ],
    }),
  };
  const forcedShortRu = compileVoiceOrLongRuPromptPivot('Поправь кэш в панели', {
    wsPath: ROOT_DIR,
    repoMapper: mockMapper,
    forceAlways: true,
  });
  assert.equal(forcedShortRu.triggered, true);
  assert.match(forcedShortRu.formattedPivot, /TARGETS:/);
  assert.match(forcedShortRu.formattedPivot, /CONTRACTS:/);
  assert.match(forcedShortRu.formattedPivot, /VERIFY:/);

  const forcedShortEn = compileVoiceOrLongRuPromptPivot('Fix cache badge', {
    wsPath: ROOT_DIR,
    repoMapper: mockMapper,
    forceAlways: true,
  });
  assert.equal(forcedShortEn.triggered, true);
  assert.match(forcedShortEn.formattedPivot, /TARGETS:/);

  const forcedEmpty = compileVoiceOrLongRuPromptPivot('   ', { wsPath: ROOT_DIR, repoMapper: mockMapper, forceAlways: true });
  assert.equal(forcedEmpty.triggered, false);

  const forcedReadOnly = compileVoiceOrLongRuPromptPivot('Почему тормозит троттлинг?', {
    wsPath: ROOT_DIR,
    repoMapper: mockMapper,
    forceAlways: true,
  });
  assert.equal(forcedReadOnly.triggered, false);

  const nowIso = new Date().toISOString();
  const bucket = {
    targetFile: 'core/hook-runner.mjs',
    editHashes: [
      { hash: '1111aaaa', filePath: 'core/hook-runner.mjs', ts: nowIso },
      { hash: '2222bbbb', filePath: 'core/hook-runner.mjs', ts: nowIso },
      { hash: '3333cccc', filePath: 'core/hook-runner.mjs', ts: nowIso },
    ],
    errorFingerprints: [
      { fingerprint: 'err1', filePath: 'core/hook-runner.mjs', preview: 'AssertionError: step 1', ts: nowIso },
      { fingerprint: 'err2', filePath: 'core/hook-runner.mjs', preview: 'AssertionError: step 2', ts: nowIso },
    ],
  };
  const osc = detectSemanticOscillation(bucket);
  assert.equal(osc.oscillating, true);
  assert.equal(osc.editAttempts, 3);
  const overlay = buildCleanRestartOverlay(bucket);
  assert.match(overlay, /Clean State Overlay/);
  assert.match(overlay, /hook-runner\.mjs/);

  const priorsFile = path.join(ROOT_DIR, '.cache', 'bayesian-priors.json');
  const prevPriors = fs.existsSync(priorsFile) ? fs.readFileSync(priorsFile, 'utf8') : null;
  try {
    recordModelOutcome({ domain: 'v321_test_dom', success: true, firstPass: true, retries: 0 });
    recordModelOutcome({ domain: 'v321_test_dom', success: true, firstPass: false, retries: 2 });
    const route = evaluateBayesianRoute({ domain: 'v321_test_dom', grade: 'M' });
    assert.ok(route.firstPassRate >= 0 && route.firstPassRate <= 1);
    assert.ok(route.expectedTurnsEstimate >= 1);
  } finally {
    if (prevPriors === null) {
      try { fs.rmSync(priorsFile, { force: true }); } catch {}
    } else {
      fs.writeFileSync(priorsFile, prevPriors, 'utf8');
    }
  }
});

test('10. CLI --output flag, MCP Schema Tax telemetry, and Token ROI Benchmark runner', () => {
  const parsed = parseAuditCliArgs(['.', '--deep', '--json', '--output', 'scratch/out.json']);
  assert.equal(parsed.deep, true);
  assert.equal(parsed.json, true);
  assert.ok(parsed.output.endsWith(path.join('scratch', 'out.json')));

  const parsedEq = parseAuditCliArgs(['--output=scratch/out2.json']);
  assert.ok(parsedEq.output.endsWith(path.join('scratch', 'out2.json')));

  const roi = runTokenRoiBenchmark({ maxSessions: 0, brainDirs: [] });
  assert.equal(roi.ok, true);
  assert.equal(roi.pillars.length, 5);
  assert.ok(roi.overall.reductionPct > 40, `Expected >40% composite ROI compression, got ${roi.overall.reductionPct}%`);

  const tel = collectTelemetry(120000, { brainDirs: [], skipGlobalGpuTelemetry: true });
  assert.equal(typeof tel.mcpSchemaTaxTokens, 'number');
  assert.ok(tel.mcpSchemaTaxTokens >= 560, `Expected >=560 eager MCP schema tax tokens, got ${tel.mcpSchemaTaxTokens}`);
});

test('11. UI & Server v3.21.0 sync: footer version, 32GB/64-thread controls, Swarm modes/tiers, and CoDyn Bayesian summary', async () => {
  const pkgMeta = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
  const ver = String(pkgMeta.version || '');
  const uiHtml = fs.readFileSync(path.join(ROOT_DIR, 'sidecars', 'panel', 'ui.html'), 'utf8');
  const serverSrc = fs.readFileSync(path.join(ROOT_DIR, 'sidecars', 'panel', 'server.mjs'), 'utf8');

  assert.ok(uiHtml.includes(`id="footerPluginVersion">The Tunnel v${ver}</div>`), 'ui.html footer must match package.json version');
  assert.ok(serverSrc.includes('pluginVersion: getPluginVersion()'), 'server.mjs must expose pluginVersion to panel API');

  assert.ok(uiHtml.includes('data-change-action="setGpuVramCap"'), 'VRAM control select must bind setGpuVramCap');
  assert.ok(uiHtml.includes('data-change-action="setRamBudget"'), 'RAM control select must bind setRamBudget');
  assert.ok(uiHtml.includes('data-change-action="setCpuMaxThreads"'), 'CPU threads select must bind setCpuMaxThreads');
  const vramPresets = uiHtml.match(/const VRAM_LIMIT_PRESETS\s*=\s*\[([^\]]+)\]/)?.[1] || '';
  const ramPresets = uiHtml.match(/const RAM_LIMIT_PRESETS\s*=\s*\[([^\]]+)\]/)?.[1] || '';
  const cpuPresets = uiHtml.match(/const CPU_THREAD_PRESETS\s*=\s*\[([^\]]+)\]/)?.[1] || '';
  for (const capVal of ['16384', '24576', '32768']) {
    assert.ok(vramPresets.includes(capVal), `VRAM_LIMIT_PRESETS must include ${capVal}`);
    assert.ok(ramPresets.includes(capVal), `RAM_LIMIT_PRESETS must include ${capVal}`);
  }
  assert.ok(ramPresets.includes('6144'), 'RAM_LIMIT_PRESETS must include 6 GB step');
  for (const thVal of ['32', '48', '64']) {
    assert.ok(cpuPresets.includes(thVal), `CPU_THREAD_PRESETS must include ${thVal}`);
  }
  for (const swMode of ['auto_all', 'always_ask']) {
    assert.ok(uiHtml.includes(`data-action="setSwarmMode" data-arg="${swMode}"`), `Swarm modes must include ${swMode}`);
  }
  for (const swTier of ['neon_auto', 'argon_auto', 'carbon_auto']) {
    assert.ok(uiHtml.includes(`data-action="setSwarmWorkerTier" data-arg="${swTier}"`), `Swarm worker tiers must include ${swTier}`);
  }
  assert.ok(uiHtml.includes('overallFirstPassPercent'), 'ui.html renderBayesian must surface CoDyn first-pass metrics');

  const { getBayesianSummary } = await import('../core/bayesian-router.mjs');
  const baySummary = getBayesianSummary();
  assert.equal(typeof baySummary.overallFirstPassPercent, 'number');
  assert.equal(typeof baySummary.overallExpectedTurns, 'number');
});

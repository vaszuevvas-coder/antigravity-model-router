import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  computeDiffReuseMetrics,
  evaluateStopCompletionGates,
  getSessionReuseSummary,
  getSessionVerificationFreshness,
  isVerificationTestCommand,
  recordSessionCodeEdit,
  recordSessionReuseMetrics,
  recordSessionTestExecution,
} from '../core/completion-gates.mjs';
import {
  extractFileShortcutMarkers,
  parseShortcutCommentBody,
  scanShortcutDebt,
} from '../core/shortcut-debt-ledger.mjs';
import {
  buildLeanModeDirective,
  buildTerseModeDirective,
  resolveLeanMode,
  resolveTerseMode,
} from '../core/tool-pruner.mjs';
import {
  buildSymbolCallGraph,
  computeGraphTopologyHash,
  detectArchitectureClusters,
  findSurprisingConnections,
  queryAffectedBlastGraph,
  suggestArchitectureQuestions,
} from '../core/cpu-ast-graph-compressor.mjs';
import { RamMemoryEngine } from '../core/ram-memory-engine.mjs';
import {
  recordAndCheckStalledToolRound,
  resetToolRoundHistory,
} from '../core/circuit-breaker.mjs';
import {
  auditPrefixStability,
  computeCacheWarmthStatus,
  recordComboProviderCooldown,
  resolveScoreDrivenComboTarget,
  resolveStatelessTurnEffort,
} from '../core/quota-pacer.mjs';
import { compressRtkCommandOutput } from '../core/obs-masker.mjs';
import {
  formatActiveSpecsForHandoff,
  listOpenSpecDeltas,
  listReusableBlocks,
  MAX_OPENSPEC_BYTES,
  readOpenSpecDelta,
  saveReusableBlock,
  upsertOpenSpecDelta,
} from '../core/reusable-blocks-specs.mjs';
import { analyzeNegativeTransfer, parseYamlFrontmatter } from '../skills/skill-architect/scripts/audit-skill.mjs';
import {
  aggregateEvalIteration,
  gradeOutputsAgainstAssertions,
  initSkillEvalsTemplate,
  validateEvalsSchema,
} from '../skills/skill-architect/scripts/eval-skill-benchmark.mjs';
import { ALLOWED_STATE_KEYS, DEFAULT_STATE, sanitizeStatePatch } from '../sidecars/panel/lib/panel-state-skills.mjs';

function makeTmpDir(prefix = 'amr-sota4w-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('Wave 1: Ponytail Shortcut Debt Ledger, Reuse % metrics, Stale-Test Gate & Lean/Terse state modes', () => {
  const tmpDir = makeTmpDir('amr-w1-');
  try {
    assert.equal(DEFAULT_STATE.leanMode, 'full');
    assert.equal(DEFAULT_STATE.terseMode, 'off');
    assert.equal(ALLOWED_STATE_KEYS.has('leanMode'), true);
    assert.equal(ALLOWED_STATE_KEYS.has('terseMode'), true);
    assert.equal(sanitizeStatePatch({ leanMode: 'ultra', terseMode: 'caveman' }).leanMode, 'ultra');
    assert.equal(sanitizeStatePatch({ leanMode: 'ultra', terseMode: 'caveman' }).terseMode, 'caveman');
    assert.equal(Object.hasOwn(sanitizeStatePatch({ leanMode: 'invalid' }), 'leanMode'), false);

    assert.equal(resolveLeanMode('/ponytail ultra fix auth', { leanMode: 'lite' }), 'ultra');
    assert.equal(resolveLeanMode('stop ponytail please', { leanMode: 'full' }), 'off');
    assert.match(buildLeanModeDirective('full'), /Ladder of Laziness/);
    assert.equal(resolveTerseMode('/ultracave explain', { terseMode: 'off' }), 'ultracave');
    assert.match(buildTerseModeDirective('caveman'), /ASD-STE100/);

    // Shortcut debt parser & scanner
    const parsedWithTrigger = parseShortcutCommentBody('in-memory map cap 10k items, switch to SQLite when workspace > 10000 files');
    assert.equal(parsedWithTrigger.hasTrigger, true);
    const parsedNoTrigger = parseShortcutCommentBody('regex only for speed');
    assert.equal(parsedNoTrigger.hasTrigger, false);
    const nonDeferral = parseShortcutCommentBody('Ctrl+K opens command palette');
    assert.equal(nonDeferral.isNonDeferralNote, true);

    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'cache.mjs'),
      [
        '// shortcut: linear scan up to 500 items, upgrade to Map index when > 500',
        '// ponytail: skips nested dynamic defs',
        'const note = "shortcut: inside string literal must be ignored";',
        'export function lookupCache(k) { return k; }',
      ].join('\n'),
      'utf8'
    );
    const singleHits = extractFileShortcutMarkers('src/cache.mjs', fs.readFileSync(path.join(tmpDir, 'src', 'cache.mjs'), 'utf8'));
    assert.equal(singleHits.length, 2);
    assert.equal(singleHits[0].rotRisk, false);
    assert.equal(singleHits[1].rotRisk, true);

    const debtScan = scanShortcutDebt(tmpDir);
    assert.equal(debtScan.ok, true);
    assert.equal(debtScan.totalMarkers, 2);
    assert.equal(debtScan.noTriggerCount, 1);
    assert.match(debtScan.formatted, /no-trigger/);

    // Reuse % calculation
    const oldCode = 'export function existingHelper(x) { return x + 1; }\n';
    const newCode = [
      'export function existingHelper(x) { return x + 1; }',
      'export function brandNewFeature(a) {',
      '  return formatSafeOutput(existingHelper(a));',
      '}',
    ].join('\n');
    const reuseRes = computeDiffReuseMetrics(oldCode, newCode, 'src/feature.mjs', ['existingHelper', 'formatSafeOutput']);
    assert.equal(reuseRes.skipped, false);
    assert.deepEqual(reuseRes.reusedSymbols.sort(), ['existingHelper', 'formatSafeOutput']);
    assert.deepEqual(reuseRes.newSymbols, ['brandNewFeature']);
    assert.equal(reuseRes.reusePct, 67);

    const stateFile = path.join(tmpDir, 'gates-state.json');
    recordSessionReuseMetrics({
      conversationId: 'c1',
      reusedSymbols: reuseRes.reusedSymbols,
      newSymbols: reuseRes.newSymbols,
      stateFile,
    });
    const reuseSum = getSessionReuseSummary({ conversationId: 'c1', stateFile });
    assert.equal(reuseSum.reusePct, 67);

    // Superpowers + Ponytail Fresh Verification / Stale-Test Gate
    assert.equal(isVerificationTestCommand('npm test'), true);
    assert.equal(isVerificationTestCommand('node --test tests/foo.test.mjs'), true);
    assert.equal(isVerificationTestCommand('git status -sb'), false);

    recordSessionTestExecution({
      conversationId: 'c1',
      commandLine: 'npm test',
      output: 'ℹ pass 12\nℹ fail 0',
      exitCode: 0,
      stateFile,
      nowMs: 1000,
    });
    assert.equal(getSessionVerificationFreshness({ conversationId: 'c1', stateFile, nowMs: 1100 }).state, 'pass');

    recordSessionCodeEdit({
      conversationId: 'c1',
      filePath: 'src/cache.mjs',
      stateFile,
      nowMs: 2000,
    });
    assert.equal(getSessionVerificationFreshness({ conversationId: 'c1', stateFile, nowMs: 2100 }).state, 'stale');

    const stopEval = evaluateStopCompletionGates({
      workspaceRoot: tmpDir,
      conversationId: 'c1',
      touchedFiles: ['src/cache.mjs'],
      stateFile,
      nowMs: 2200,
    });
    assert.equal(stopEval.shouldWarn, true);
    assert.ok(stopEval.warnings.some((w) => w.kind === 'stale_tests'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Wave 2: Graphify v2 EXTRACTED/INFERRED/AMBIGUOUS confidence, topologyHash, Surprising Bridges & dynamic_import affected walk', () => {
  const tmpWs = makeTmpDir('amr-w2-');
  try {
    fs.mkdirSync(path.join(tmpWs, 'auth'), { recursive: true });
    fs.mkdirSync(path.join(tmpWs, 'billing'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpWs, 'auth', 'token.mjs'),
      'export function verifyJwtToken(tok) { return Boolean(tok); }\nexport function sharedValidate(x) { return x; }\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmpWs, 'billing', 'ledger.mjs'),
      'export function sharedValidate(x) { return x; }\nexport function chargeInvoice(tok) { return sharedValidate(tok); }\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmpWs, 'billing', 'checkout.mjs'),
      [
        "import { verifyJwtToken } from '../auth/token.mjs';",
        'export async function runCheckout(tok) {',
        '  const ok = verifyJwtToken(tok);',
        '  const ambig = sharedValidate(tok);',
        "  const dyn = await import('../auth/token.mjs');",
        '  return ok && Boolean(ambig) && Boolean(dyn);',
        '}',
      ].join('\n'),
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmpWs, 'billing', 'index.mjs'),
      "export * from './checkout.mjs';\n",
      'utf8'
    );

    const h1 = computeGraphTopologyHash(['a', 'b'], ['0->1'], { ambiguousScale: 0.25 });
    const h2 = computeGraphTopologyHash(['b', 'a'], ['0->1'], { ambiguousScale: 0.25 });
    assert.equal(h1, h2);

    const ram = new RamMemoryEngine({ budgetMb: 128 });
    const report = ram.queryKnowledgeGraph(tmpWs, { mode: 'report' });
    assert.equal(report.ok, true);
    assert.match(report.topologyHash, /^v1:[0-9a-f]{24}$/);

    const symGraph = buildSymbolCallGraph(ram.ensureWarm(tmpWs).files);
    const checkoutEdges = symGraph.calleesOf.get('runCheckout');
    assert.ok(checkoutEdges);
    const edgeList = Array.from(checkoutEdges.values());
    const jwtEdge = edgeList.find((e) => e.name === 'verifyJwtToken');
    const ambigEdge = edgeList.find((e) => e.name === 'sharedValidate');
    assert.equal(jwtEdge?.confidence, 'EXTRACTED');
    assert.equal(ambigEdge?.confidence, 'AMBIGUOUS');

    const arch = detectArchitectureClusters(ram.ensureWarm(tmpWs).files, ram.ensureWarm(tmpWs).forwardDeps, ram.ensureWarm(tmpWs).reverseDeps, {
      symbolGraph: symGraph,
    });
    const bridges = findSurprisingConnections(ram.ensureWarm(tmpWs).files, arch, symGraph, ram.ensureWarm(tmpWs).forwardDeps);
    assert.ok(bridges.length >= 1);
    const qs = suggestArchitectureQuestions(arch, bridges);
    assert.ok(Array.isArray(qs));

    const affected = queryAffectedBlastGraph(ram.ensureWarm(tmpWs).files, 'auth/token.mjs', {
      symbolGraph: symGraph,
      maxDepth: 4,
    });
    assert.equal(affected.ok, true);
    assert.ok(affected.affected.some((h) => h.file === 'billing/checkout.mjs'));
    assert.ok(affected.affected.some((h) => h.file === 'billing/index.mjs' && h.viaRelation === 're_exports'));
    ram.shutdownAll?.();
  } finally {
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
});

test('Wave 3: OmniRoute Stalled Tool-Loop Guard, Stateless Effort Pinning, Cache Warmth, Score-Driven Combo & RTK profiles', () => {
  const tmpDir = makeTmpDir('amr-w3-');
  try {
    resetToolRoundHistory({ conversationId: 'loop-1', cacheDir: tmpDir });
    const r1 = recordAndCheckStalledToolRound({
      conversationId: 'loop-1',
      toolName: 'run_command',
      args: { CommandLine: 'git status -sb', toolSummary: 'Check 1' },
      resultText: '## main',
      isError: false,
      cacheDir: tmpDir,
    });
    assert.equal(r1.stalled, false);

    // Different toolSummary must NOT mask identical underlying arguments!
    const r2 = recordAndCheckStalledToolRound({
      conversationId: 'loop-1',
      toolName: 'run_command',
      args: { CommandLine: 'git status -sb', toolSummary: 'Check 2' },
      resultText: '## main',
      isError: false,
      cacheDir: tmpDir,
    });
    assert.equal(r2.stalled, true);
    assert.equal(r2.reason, 'identical_tool_evidence_consecutive_rounds');
    assert.match(r2.formattedAlert, /Stalled Tool-Loop Guard/);

    assert.equal(resolveStatelessTurnEffort({ userChars: 40, estimatedContextTokens: 1200, priorToolResultsCount: 0 }).effort, 'low');
    assert.equal(resolveStatelessTurnEffort({ userChars: 500, estimatedContextTokens: 75000, priorToolResultsCount: 2 }).effort, 'high');
    assert.equal(resolveStatelessTurnEffort({ userChars: 500, estimatedContextTokens: 12000, priorToolResultsCount: 2 }).effort, 'medium');

    auditPrefixStability({ convoId: 'warm-c', staticPrefix: 'Static Header Prefix', dynamicTail: 'tail', cacheDir: tmpDir });
    const warmSnap = computeCacheWarmthStatus({ convoId: 'warm-c', cacheDir: tmpDir });
    assert.equal(warmSnap.status, 'warm');
    assert.ok(warmSnap.remainingSeconds > 200);

    recordComboProviderCooldown({ modelOrTier: 'gemini-4-neon-xhigh', cacheDir: tmpDir });
    const scored = resolveScoreDrivenComboTarget({
      customChain: ['gemini-4-neon-xhigh', 'gemini-4-neon-high', 'gemini-4-hydrogen-medium'],
      warmTier: 'hydrogen',
      cacheDir: tmpDir,
    });
    // Sibling neon family gets penalized while warm hydrogen gets cache-affinity bonus
    assert.equal(scored.selected, 'gemini-4-hydrogen-medium');

    const noisyStatus = Array.from({ length: 24 }, (_, i) => ` M src/components/Widget${i}.tsx`).join('\n');
    const rtkStatus = compressRtkCommandOutput(noisyStatus, 0, 'git status -s');
    assert.equal(rtkStatus.matched, true);
    assert.equal(rtkStatus.profile, 'git_status');
    assert.ok(rtkStatus.savedChars > 50);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Wave 4: agentskills.io Spec Validator, A/B Eval Benchmark Harness, Caveman Blocks & OpenSpec 50KB Ledger', () => {
  const tmpDir = makeTmpDir('amr-w4-');
  try {
    const badSkillDir = path.join(tmpDir, 'my-clean-skill');
    fs.mkdirSync(badSkillDir, { recursive: true });
    const badFm = [
      '---',
      'name: Bad--UpperName',
      'description: Helps with tests when needed across files and modules.',
      `compatibility: ${'x'.repeat(510)}`,
      '---',
      'Run `npm test` to verify.',
    ].join('\n');
    const parsedFm = parseYamlFrontmatter(badFm);
    assert.equal(parsedFm.compatibility.length, 510);
    const nt = analyzeNegativeTransfer(badFm, badSkillDir);
    assert.ok(nt.findings.some((f) => f.id === 'FM_SPEC_NAME_INVALID'));
    assert.ok(nt.findings.some((f) => f.id === 'FM_SPEC_COMPAT_OVERFLOW'));

    // A/B Evals harness
    const initEv = initSkillEvalsTemplate(badSkillDir);
    assert.equal(initEv.ok, true);
    assert.equal(validateEvalsSchema(initEv.template).ok, true);

    const iterDir = path.join(tmpDir, 'iter-1');
    const withOut = path.join(iterDir, 'case-1', 'with_skill', 'outputs');
    const baseOut = path.join(iterDir, 'case-1', 'without_skill', 'outputs');
    fs.mkdirSync(withOut, { recursive: true });
    fs.mkdirSync(baseOut, { recursive: true });
    fs.writeFileSync(path.join(withOut, 'result.json'), '{"status":"clean"}', 'utf8');
    fs.writeFileSync(path.join(baseOut, 'result.json'), '{"status":"TODO broken"', 'utf8');

    const assertions = ['valid_json:result.json', 'not_contains:TODO'];
    const gWith = gradeOutputsAgainstAssertions(withOut, assertions);
    const gBase = gradeOutputsAgainstAssertions(baseOut, assertions);
    assert.equal(gWith.pass_rate, 1);
    assert.equal(gBase.pass_rate, 0);

    fs.writeFileSync(path.join(iterDir, 'case-1', 'with_skill', 'grading.json'), JSON.stringify(gWith), 'utf8');
    fs.writeFileSync(path.join(iterDir, 'case-1', 'without_skill', 'grading.json'), JSON.stringify(gBase), 'utf8');
    fs.writeFileSync(path.join(iterDir, 'case-1', 'with_skill', 'timing.json'), JSON.stringify({ total_tokens: 1200, duration_ms: 4000 }), 'utf8');
    fs.writeFileSync(path.join(iterDir, 'case-1', 'without_skill', 'timing.json'), JSON.stringify({ total_tokens: 2000, duration_ms: 6000 }), 'utf8');

    const bench = aggregateEvalIteration(iterDir);
    assert.equal(bench.ok, true);
    assert.equal(bench.pass_rate_delta, 1);
    assert.equal(bench.token_delta_pct, -40);

    // Caveman Blocks & OpenSpec 50KB Ledger
    const blk = saveReusableBlock({
      workspaceRoot: tmpDir,
      name: 'Check-Dead-Exports',
      command: 'node core/router-cli.mjs dead-exports',
      tags: ['audit', 'exports'],
      cacheDir: tmpDir,
    });
    assert.equal(blk.ok, true);
    assert.equal(listReusableBlocks({ workspaceRoot: tmpDir, query: 'exports', cacheDir: tmpDir }).length, 1);

    const specOk = upsertOpenSpecDelta({
      workspaceRoot: tmpDir,
      slug: 'graphify-v2',
      phase: 'apply',
      content: '## Delta\n- Added EXTRACTED/INFERRED/AMBIGUOUS edge provenance.',
      cacheDir: tmpDir,
    });
    assert.equal(specOk.ok, true);
    assert.equal(listOpenSpecDeltas({ workspaceRoot: tmpDir, cacheDir: tmpDir }).length, 1);
    assert.match(readOpenSpecDelta({ workspaceRoot: tmpDir, slug: 'graphify-v2', cacheDir: tmpDir }).content, /EXTRACTED/);
    assert.match(formatActiveSpecsForHandoff(tmpDir, { cacheDir: tmpDir }), /graphify-v2/);

    const specTooBig = upsertOpenSpecDelta({
      workspaceRoot: tmpDir,
      slug: 'huge-spec',
      content: 'a'.repeat(MAX_OPENSPEC_BYTES + 100),
      cacheDir: tmpDir,
    });
    assert.equal(specTooBig.ok, false);
    assert.match(specTooBig.error, /spec_exceeds_50kb_cap/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

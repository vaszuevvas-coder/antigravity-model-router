import { registerSuiteLifecycle } from './helpers/router-test-env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

registerSuiteLifecycle(test);

import { SqliteKnowledgeHub } from '../core/sqlite-knowledge-hub.mjs';
import { maskTerminalOutput } from '../core/obs-masker.mjs';
import { executeMcpTool, MCP_TOOLS } from '../core/ram-memory-mcp.mjs';
import {
  checkProjectCompletionInvariants,
  evaluateStopCompletionGates,
  parseAcceptanceGatesMarkdown,
  scanAddedStubsInDiff,
} from '../core/completion-gates.mjs';
import {
  detectEditChurnFriction,
  detectUserCorrectionFriction,
  recordFrictionObservation,
} from '../core/friction-observer.mjs';
import { handleSessionStart, handleStop } from '../core/hook-runner.mjs';
import { formatUxBrief, initDesignMd, queryUxMatrix } from '../skills/ui-ux-design-system/scripts/query-ux-matrix.mjs';
import { auditUiContent } from '../skills/ui-ux-design-system/scripts/audit-ui.mjs';

function makeTmpDir(prefix = 'tunnel-v328-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('1. Headroom CCR: reversible compression, secret redaction, SmartCrumb, MCP retrieve & JSON fallback', async () => {
  const tmpDir = makeTmpDir('tunnel-ccr-');
  const hub = new SqliteKnowledgeHub({ dbPath: path.join(tmpDir, 'knowledge.sqlite') });

  try {
    assert.ok(MCP_TOOLS.some((t) => t.name === 'ram_ccr_retrieve'));
    assert.ok(MCP_TOOLS.some((t) => t.name === 'ram_memory_recall'));

    const fakeSkSecret = ['sk', 'secret1234567890abcdefghijklmnop'].join('-');
    const logLines = [];
    for (let i = 1; i <= 140; i++) {
      if (i === 72) {
        logLines.push(`Line 72 CRITICAL_ROOT_CAUSE: socket hung up with token ${fakeSkSecret}`);
      } else {
        logLines.push(`2026-11-22T10:00:${String(i % 60).padStart(2, '0')}.000Z INFO Worker step ${i} processed payload chunk ${i}`);
      }
    }
    const bigOutput = logLines.join('\n');

    const masked = maskTerminalOutput(bigOutput, 0, {
      enableCcr: true,
      ccrHub: hub,
      workspaceRoot: tmpDir,
      commandLine: 'npm run verify',
    });
    assert.ok(masked.ccrHash, 'SmartCrumb ccrHash must be returned');
    assert.ok(masked.masked.includes(`[📦 CCR #${masked.ccrHash}`), 'SmartCrumb footer must be appended');
    assert.ok(masked.maskedChars < bigOutput.length * 0.5);

    const mcpByQuery = await executeMcpTool(
      'ram_ccr_retrieve',
      { hash: masked.ccrHash, query: 'CRITICAL_ROOT_CAUSE' },
      { knowledgeHub: hub }
    );
    assert.equal(mcpByQuery.isError, false);
    assert.ok(mcpByQuery.text.includes('CRITICAL_ROOT_CAUSE'));
    assert.ok(!mcpByQuery.text.includes(fakeSkSecret), 'Secrets must be redacted before CCR storage');

    const mcpBySlice = await executeMcpTool(
      'ram_ccr_retrieve',
      { hash: masked.ccrHash, startLine: 70, endLine: 74 },
      { knowledgeHub: hub }
    );
    assert.equal(mcpBySlice.isError, false);
    assert.ok(mcpBySlice.text.includes('L72:'));

    const badHash = await executeMcpTool('ram_ccr_retrieve', { hash: 'bad!' }, { knowledgeHub: hub });
    assert.equal(badHash.isError, true);

    const now = Date.now();
    const expStore = hub.storeCcrBlob({ text: 'ephemeral short-lived blob', workspaceRoot: tmpDir, ttlMs: 1000, nowMs: now });
    assert.equal(expStore.ok, true);
    const expiredRead = hub.retrieveCcrBlob({ hash: expStore.hash, nowMs: now + 5000 });
    assert.equal(expiredRead.ok, false);
    assert.equal(expiredRead.error, 'not_found_or_expired');

    // Verify JSON fallback mode works identically when SQLite db handle is disabled
    const fbHub = new SqliteKnowledgeHub({ dbPath: path.join(tmpDir, 'fb.sqlite') });
    fbHub._ensureDb = () => { fbHub.backend = 'json_fallback'; return null; };
    const fbStore = fbHub.storeCcrBlob({ text: 'line1\nline2 TARGET_FB\nline3', workspaceRoot: tmpDir });
    assert.equal(fbStore.ok, true);
    const fbRead = fbHub.retrieveCcrBlob({ hash: fbStore.hash, query: 'TARGET_FB' });
    assert.equal(fbRead.ok, true);
    assert.ok(fbRead.text.includes('L2: line2 TARGET_FB'));
    fbHub.close();
  } finally {
    hub.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('2. 3-Layer Episodic Memory (claude-mem + RooFlow): dedup, index/timeline/details & MCP recall', async () => {
  const tmpDir = makeTmpDir('tunnel-mem-');
  const wsDir = path.join(tmpDir, 'project');
  fs.mkdirSync(wsDir, { recursive: true });
  const hub = new SqliteKnowledgeHub({ dbPath: path.join(tmpDir, 'knowledge.sqlite') });

  try {
    const t0 = Date.now() - 120_000;
    const ep1 = hub.recordSessionEpisode({
      workspaceRoot: wsDir,
      conversationId: 'chat-auth-1',
      title: 'Fix JWT refresh race condition',
      kind: 'bugfix',
      summary: 'Serialized refresh lock in auth/refresh-token.mjs',
      decisions: ['Use single-flight promise lock instead of mutex file'],
      touchedFiles: ['src/auth/refresh-token.mjs'],
      nowMs: t0,
    });
    assert.equal(ep1.ok, true);
    assert.equal(ep1.updated, false);

    // Same conversationId session updates in place instead of creating duplicate row
    const epSession1 = hub.recordSessionEpisode({
      workspaceRoot: wsDir,
      conversationId: 'chat-ui-2',
      title: 'Panel header draft',
      kind: 'session',
      summary: 'Initial layout',
      touchedFiles: ['sidecars/panel/ui-src/head-body.html'],
      nowMs: t0 + 10_000,
    });
    const epSession2 = hub.recordSessionEpisode({
      workspaceRoot: wsDir,
      conversationId: 'chat-ui-2',
      title: 'Panel header finalized with crimson rail dark tokens',
      kind: 'session',
      summary: 'Completed crimson rail dark theme and rebuilt ui.html',
      decisions: ['Chose glass_teal crimson rail tokens'],
      touchedFiles: ['sidecars/panel/ui-src/head-body.html', 'sidecars/panel/ui.html'],
      nowMs: t0 + 20_000,
    });
    assert.equal(epSession2.ok, true);
    assert.equal(epSession2.updated, true);
    assert.equal(epSession2.id, epSession1.id);

    // Layer 1: lightweight index search (bilingual RU query -> EN episode)
    const idxRes = hub.searchSessionEpisodes({ workspaceRoot: wsDir, query: 'авторизац refresh', limit: 5 });
    assert.equal(idxRes.ok, true);
    assert.ok(idxRes.items.length >= 1);
    assert.equal(idxRes.items[0].id, ep1.id);
    assert.equal(idxRes.items[0].summary, undefined, 'Layer 1 index must stay compact without full summary');

    // Layer 2: chronological timeline
    const tlRes = hub.getSessionEpisodeTimeline({ workspaceRoot: wsDir, anchorId: ep1.id, before: 1, after: 2 });
    assert.equal(tlRes.ok, true);
    assert.ok(tlRes.items.some((x) => x.isAnchor && x.id === ep1.id));
    assert.ok(tlRes.items.some((x) => x.id === epSession2.id));

    // Layer 3: full episode hydration via MCP
    const mcpDetails = await executeMcpTool(
      'ram_memory_recall',
      { mode: 'details', ids: [ep1.id, epSession2.id], workspaceRoot: wsDir },
      { knowledgeHub: hub }
    );
    assert.equal(mcpDetails.isError, false);
    const parsedDetails = JSON.parse(mcpDetails.text);
    assert.equal(parsedDetails.items.length, 2);
    assert.ok(parsedDetails.items[0].decisions.length >= 1);

    // SessionStart compact index capped strictly at <= 480 chars
    const startIdx = hub.formatSessionMemoryIndexForStart(wsDir, { limit: 5, maxChars: 480 });
    assert.ok(startIdx.includes('Episodic Memory Index'));
    assert.ok(startIdx.length <= 480);

    // Verify Stop + SessionStart hooks remain fast and non-throwing with custom non-ephemeral workspace
    const stopRes = await handleStop({ workspacePath: wsDir, conversationId: 'chat-ui-2', fullyIdle: true }, {});
    assert.equal(typeof stopRes, 'object');
    const startRes = await handleSessionStart({ workspacePath: wsDir, conversationId: 'chat-next' }, {});
    assert.ok(startRes);
  } finally {
    hub.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('3. Unlazy Completion Gates: read-only GATES.md, stub diff guard & Stop anti-loop cap', () => {
  const tmpDir = makeTmpDir('tunnel-gates-');
  const prevCache = process.env.TUNNEL_CACHE_DIR;
  process.env.TUNNEL_CACHE_DIR = path.join(tmpDir, '.cache');

  try {
    // A) Strictly read-only GATES.md parsing (marker file proves CHECK: never executes)
    const canaryFile = path.join(tmpDir, 'SHOULD_NOT_EXIST.txt');
    const gatesMd = [
      '# Acceptance Gates',
      '- [x] g1: Core parser implemented',
      `  CHECK: node -e "require('fs').writeFileSync('${canaryFile.replace(/\\/g, '\\\\')}', 'pwn')"`,
      '  EXPECT: PASS',
      '- [ ] g2: Add edge-case unit test',
      'ABANDON: g3 Deferred until Wave 3 per user decision',
    ].join('\n');
    const parsed = parseAcceptanceGatesMarkdown(gatesMd);
    assert.equal(parsed.total, 2);
    assert.equal(parsed.met.length, 1);
    assert.equal(parsed.unmet.length, 1);
    assert.equal(parsed.abandoned.length, 1);
    assert.equal(fs.existsSync(canaryFile), false, 'CHECK: commands in GATES.md must NEVER execute automatically');

    // B) Diff stub scanner ignores pre-existing TODOs and HTML placeholder="" attributes
    const oldCode = [
      'export function legacy() {',
      '  // TODO: old legacy note that existed before',
      '  return "<input placeholder=\\"Enter name\\" />";',
      '}',
    ].join('\n');
    const cleanNewCode = `${oldCode}\nexport const ok = 1;\n`;
    const cleanDiff = scanAddedStubsInDiff(oldCode, cleanNewCode, 'src/widget.jsx');
    assert.equal(cleanDiff.ok, true);
    assert.equal(cleanDiff.issues.length, 0);

    const stubNewCode = `${oldCode}\nexport function nextFn() {\n  // TODO: wire real API\n  throw new Error('Not implemented');\n}\n`;
    const badDiff = scanAddedStubsInDiff(oldCode, stubNewCode, 'src/widget.js');
    assert.equal(badDiff.ok, false);
    assert.equal(badDiff.issues.length, 2);

    // C) Stop anti-loop guard warns up to maxBlocks (2), then allows clean stop
    const wsDir = path.join(tmpDir, 'repo');
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'GATES.md'), '- [ ] g1: Unfinished task\n', 'utf8');
    const stateFile = path.join(tmpDir, 'gates-state.json');

    const w1 = evaluateStopCompletionGates({ workspaceRoot: wsDir, conversationId: 'conv-gate-1', maxBlocks: 2, stateFile });
    assert.equal(w1.shouldWarn, true);
    assert.ok(w1.formattedSystemMessage.includes('Completion Gate 1/2'));

    const w2 = evaluateStopCompletionGates({ workspaceRoot: wsDir, conversationId: 'conv-gate-1', maxBlocks: 2, stateFile });
    assert.equal(w2.shouldWarn, true);
    assert.ok(w2.formattedSystemMessage.includes('Completion Gate 2/2'));

    const w3 = evaluateStopCompletionGates({ workspaceRoot: wsDir, conversationId: 'conv-gate-1', maxBlocks: 2, stateFile });
    assert.equal(w3.shouldWarn, false, 'Must stop warning after maxBlocks to avoid infinite Stop loop');

    const inv = checkProjectCompletionInvariants(wsDir, []);
    assert.equal(inv.ok, false);
    assert.ok(inv.warnings.some((w) => w.kind === 'gates_unmet'));
  } finally {
    if (prevCache === undefined) delete process.env.TUNNEL_CACHE_DIR;
    else process.env.TUNNEL_CACHE_DIR = prevCache;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('4. Task-Observer Friction Detector: RU/EN cues, churn detection & safe instinct accumulation', () => {
  const tmpDir = makeTmpDir('tunnel-friction-');
  const wsDir = path.join(tmpDir, 'app');
  fs.mkdirSync(wsDir, { recursive: true });
  const hub = new SqliteKnowledgeHub({ dbPath: path.join(tmpDir, 'knowledge.sqlite') });

  try {
    const ruBad = detectUserCorrectionFriction('Нет, не так, ты снова забыл пересобрать ui.html после правки шаблона!', {
      touchedFiles: ['sidecars/panel/ui-src/head-body.html'],
      semanticSkills: [{ slug: 'model-router' }],
    });
    assert.equal(ruBad.detected, true);
    assert.equal(ruBad.signalType, 'user_correction');
    assert.equal(ruBad.targetSkillHint, 'model-router');

    const enBad = detectUserCorrectionFriction('No, not like that, why did you again drop the focus-visible ring?');
    assert.equal(enBad.detected, true);

    const normalQ = detectUserCorrectionFriction('Как устроен кэш префикса в core/hook-runner.mjs?');
    assert.equal(normalQ.detected, false);
    const approvalQ = detectUserCorrectionFriction('A1: (Recommended) Запустить полную реализацию');
    assert.equal(approvalQ.detected, false);

    // Edit churn (undo-redo oscillation)
    const churnState = path.join(tmpDir, 'friction-window.json');
    const c1 = detectEditChurnFriction({
      conversationId: 'conv-churn',
      filePath: 'src/panel.js',
      targetText: 'const a = 1;',
      replacementText: 'const a = 2;',
      stateFile: churnState,
      nowMs: 1000,
    });
    assert.equal(c1.detected, false);
    const c2 = detectEditChurnFriction({
      conversationId: 'conv-churn',
      filePath: 'src/panel.js',
      targetText: 'const a = 2;',
      replacementText: 'const a = 1;',
      stateFile: churnState,
      nowMs: 5000,
    });
    assert.equal(c2.detected, true);
    assert.equal(c2.signalType, 'revert_churn');

    // Accumulate friction 3 times -> reaches promotion readiness in SQLite without writing SKILL.md
    let obs = null;
    for (let i = 0; i < 3; i++) {
      obs = recordFrictionObservation({
        workspaceRoot: wsDir,
        signalType: 'revert_churn',
        pattern: c2.candidatePattern,
        targetSkill: 'model-router',
        hub,
        nowMs: 10_000 + i * 1000,
      });
    }
    assert.equal(obs.recorded, true);
    assert.equal(obs.readyForPromotion, true);
    assert.ok(obs.promotionHint.includes('router-cli.mjs evolve'));
  } finally {
    hub.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('5. UI/UX Design System v2.0: Pro Max matrix query, DESIGN.md init & Impeccable audit-ui.mjs', () => {
  const tmpDir = makeTmpDir('tunnel-ui2-');
  try {
    const q = queryUxMatrix({ domain: 'fintech analytics dashboard', mode: 'operate', includeCharts: true });
    assert.equal(q.ok, true);
    assert.equal(q.surfaceModeKey, 'operate');
    assert.ok(q.tasteDials.VISUAL_DENSITY >= 7);
    assert.ok(q.palettes.length >= 1);
    assert.ok(q.typography.length >= 1);
    assert.ok(q.charts.length >= 1);
    assert.ok(formatUxBrief(q).includes('Taste Dials'));

    const dRes = initDesignMd(tmpDir, { domain: 'Fintech Console', mode: 'operate' });
    assert.equal(dRes.ok, true);
    const dContent = fs.readFileSync(dRes.outPath, 'utf8');
    assert.ok(dContent.includes('Surface Mode:'));
    assert.ok(dContent.includes('DESIGN_VARIANCE='));

    const sloppyHtml = `
      <style>
        .hero { height: 100vh; background: linear-gradient(135deg, #6366f1, #a855f7); transition: all 0.2s; }
        .btn:focus { outline: none; }
        .lbl { text-overflow: ellipsis; }
      </style>
      <div class="hero" onclick="go()"><img src="pic.png" /></div>
    `;
    const badAudit = auditUiContent(sloppyHtml, 'sloppy.html');
    assert.equal(badAudit.ok, false);
    assert.ok(badAudit.findings.some((f) => f.ruleId === 'cliche-ai-gradient'));
    assert.ok(badAudit.findings.some((f) => f.ruleId === 'missing-focus-visible'));
    assert.ok(badAudit.findings.some((f) => f.ruleId === 'clickable-non-semantic'));
    assert.ok(badAudit.findings.some((f) => f.ruleId === 'transition-all'));
    assert.ok(badAudit.score <= 12);

    const cleanHtml = `
      <style>
        :root { --bg: #faf7f2; --fg: #1f2328; --accent: #b45309; }
        .shell { min-height: 100dvh; background: var(--bg); color: var(--fg); }
        .btn { transition: transform 180ms ease, opacity 180ms ease; }
        .btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
        .lbl { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
      </style>
      <main class="shell"><button type="button" class="btn"><span class="lbl">Save</span></button></main>
    `;
    const goodAudit = auditUiContent(cleanHtml, 'clean.html');
    assert.equal(goodAudit.ok, true);
    assert.equal(goodAudit.score, 20);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

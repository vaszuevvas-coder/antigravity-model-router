import { ROOT_DIR, SUITE_CACHE_DIR, makeTempDir, registerSuiteLifecycle } from './helpers/router-test-env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { sanitizeStatePatch } from '../sidecars/panel/server.mjs';
import { checkHistoryCompaction } from '../core/history-compactor.mjs';
import { atomicWriteJsonSync } from '../core/safe-json.mjs';
import { evaluateBayesianRoute } from '../core/bayesian-router.mjs';
import { handlePreInvocation } from '../core/hook-runner.mjs';
import { shutdownCpuPool } from '../core/cpu-worker-pool.mjs';
import { formatCompactProcessError } from '../core/auto-verifier.mjs';
import { recordEditStateHash } from '../core/circuit-breaker.mjs';
import { clearPitfalls, listPitfalls, recordPitfall } from '../core/pitfall-ledger.mjs';
import { syncMcpRamBudget } from '../core/hardware-profiler.mjs';

registerSuiteLifecycle(test, { cleanupFns: [shutdownCpuPool] });

const TASK_PROGRESS_FILE = path.join(SUITE_CACHE_DIR, 'task-progress.json');

test('22. Full Audit Hardening: MCP multi-window workspace isolation, nullish fuzz guards, UI DOM/theme contracts & stale completed sweep', async () => {
  const { pathToFileURL } = await import('node:url');
  const {
    extractClientRootFromInitialize,
    registerDaemonWorkspace,
    resetStdioClientWorkspaceForTest,
    resolveDefaultWorkspace,
  } = await import('../core/ram-memory-mcp.mjs');
  const { evaluateBayesianRoute, evaluateTargetsFragility } = await import('../core/bayesian-router.mjs');
  const { recordErrorFingerprint } = await import('../core/circuit-breaker.mjs');
  const {
    advanceTaskProgressOnPreTool,
    initTaskProgressFromPrompt,
    resetTaskProgress,
    setExplicitTaskProgress,
  } = await import('../core/task-progress.mjs');

  // 1) MCP initialize root isolation + relative-path disambiguation across concurrent windows
  const wsA = makeTempDir('amr-ws-a-');
  const wsB = makeTempDir('amr-ws-b-');
  try {
    fs.writeFileSync(path.join(wsA, 'onlyA.mjs'), 'export const a = 1;\n', 'utf8');
    fs.writeFileSync(path.join(wsB, 'onlyB.mjs'), 'export const b = 2;\n', 'utf8');

    const extracted = extractClientRootFromInitialize({ rootUri: pathToFileURL(wsA).href });
    assert.equal(path.resolve(extracted), path.resolve(wsA));

    registerDaemonWorkspace(wsB);
    assert.equal(path.resolve(resolveDefaultWorkspace('')), path.resolve(wsA));
    assert.equal(path.resolve(resolveDefaultWorkspace('', 'onlyA.mjs')), path.resolve(wsA));
    assert.equal(path.resolve(resolveDefaultWorkspace('', 'onlyB.mjs')), path.resolve(wsB));
  } finally {
    resetStdioClientWorkspaceForTest('');
    fs.rmSync(wsA, { recursive: true, force: true });
    fs.rmSync(wsB, { recursive: true, force: true });
  }

  // 2) Nullish fuzz guards in bayesian-router.mjs and circuit-breaker.mjs
  const bRoute = evaluateBayesianRoute(null);
  assert.equal(bRoute.domain, 'general');
  const tFrag = evaluateTargetsFragility(null);
  assert.equal(tFrag.domain, 'general');
  const cbHash = recordEditStateHash(null);
  assert.equal(cbHash.tripped, false);
  assert.equal(cbHash.status, 'CLOSED');
  const cbErr = recordErrorFingerprint(null);
  assert.equal(cbErr.tripped, false);
  assert.equal(cbErr.status, 'CLOSED');

  // 3) Sidecar UI contracts: compaction meter DOM IDs, gemma4:12b fallback, wizard callouts
  const uiHtml = fs.readFileSync(path.join(ROOT_DIR, 'sidecars', 'panel', 'ui.html'), 'utf8');
  assert.ok(uiHtml.includes('id="compactionLabel"'), 'Missing #compactionLabel in ui.html');
  assert.ok(uiHtml.includes('id="compactionBar"'), 'Missing #compactionBar in ui.html');
  assert.ok(uiHtml.includes("wizDraft.gpuChatModel || 'gemma4:12b'"), 'Wizard must fall back to gemma4:12b');
  assert.ok(uiHtml.includes('.wiz-summary-strip'));
  assert.ok(uiHtml.includes('.wiz-compact-card'));

  // 4) Stale completed chat sweep on ask_question continuation (resumeIfWaiting: true)
  resetTaskProgress();
  try {
    initTaskProgressFromPrompt({
      conversationId: 'chat-waiting',
      workspaceRoot: ROOT_DIR,
      userPrompt: 'Правка компонента',
      grade: 'M',
      brainDirs: [],
    });
    advanceTaskProgressOnPreTool({
      conversationId: 'chat-waiting',
      workspaceRoot: ROOT_DIR,
      toolName: 'ask_question',
      brainDirs: [],
    });
    setExplicitTaskProgress({
      conversationId: 'chat-stale-done',
      workspaceRoot: ROOT_DIR,
      currentStep: 3,
      totalSteps: 3,
      percent: 100,
      stepTitle: 'Завершено',
      status: 'completed',
    });
    const rawProg = JSON.parse(fs.readFileSync(TASK_PROGRESS_FILE, 'utf8'));
    rawProg.chats['chat-stale-done'].completedAt = Date.now() - 15000;
    rawProg.chats['chat-stale-done'].updatedAt = Date.now() - 15000;
    atomicWriteJsonSync(TASK_PROGRESS_FILE, rawProg);

    const resumed = initTaskProgressFromPrompt({
      conversationId: 'chat-waiting',
      workspaceRoot: ROOT_DIR,
      userPrompt: 'Подтверждаю',
      resumeIfWaiting: true,
      brainDirs: [],
    });
    assert.equal(resumed.activeChats.length, 1);
    assert.equal(resumed.activeChats[0].conversationId, 'chat-waiting');
  } finally {
    resetTaskProgress();
  }
});

test('23. Subagent Dropdown Hierarchy: >4KB SessionStart header, parent->subagents grouping, cid__wsHash dedup & UI contracts', async () => {
  const { inspectSubagentTranscriptMeta } = await import('../core/model-profile.mjs');
  const {
    advanceTaskProgressOnPreTool,
    extractProjectName,
    getTaskProgressSnapshot,
    initTaskProgressFromPrompt,
    resetTaskProgress,
  } = await import('../core/task-progress.mjs');

  assert.equal(extractProjectName('"c:\\\\Users\\\\dev\\\\scratch\\\\sample-game"'), 'sample-game');

  const tmpBrain = makeTempDir('amr-sub-tree-');
  resetTaskProgress();
  try {
    const writeTranscript = (cid, lines) => {
      const p = path.join(tmpBrain, cid, '.system_generated', 'logs', 'transcript.jsonl');
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, lines.map((obj) => JSON.stringify(obj)).join('\n') + '\n', 'utf8');
      return p;
    };

    const bigSessionStart = '# SessionStart Repo Map\n' + 'x'.repeat(12000);
    const chat1Path = writeTranscript('chat-main-1', [
      { step_index: 0, source: 'SYSTEM_SDK', type: 'SYSTEM_MESSAGE', content: bigSessionStart },
      { step_index: 1, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: '<USER_REQUEST>Почини звук кнопки</USER_REQUEST>' },
      { step_index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'read_file', args: { Path: 'src/audio.ts' } }] },
    ]);
    const chat2Path = writeTranscript('chat-main-2', [
      { step_index: 0, source: 'SYSTEM_SDK', type: 'SYSTEM_MESSAGE', content: bigSessionStart },
      { step_index: 1, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: '<USER_REQUEST>Полный аудит игры с субагентами</USER_REQUEST>' },
      { step_index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'invoke_subagent', args: { Role: 'Аудитор движка Prestige' } }] },
      { step_index: 3, source: 'SYSTEM', type: 'GENERIC', content: 'Launched subagent conversationId="sub-agent-1"' },
    ]);

    const subIds = ['sub-agent-1', 'sub-agent-2', 'sub-agent-3', 'sub-agent-4'];
    const subFiles = ['PrestigeEngine.ts', 'WinStockEngine.ts', 'audio.ts', 'App.tsx'];
    for (let i = 0; i < subIds.length; i++) {
      const sPath = writeTranscript(subIds[i], [
        { step_index: 0, source: 'SYSTEM_SDK', type: 'SYSTEM_MESSAGE', content: bigSessionStart },
        {
          step_index: 1,
          source: 'SYSTEM',
          type: 'SYSTEM_MESSAGE',
          content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-14T17:24:18Z sender=chat-main-2 priority=MESSAGE_PRIORITY_HIGH content=Inspect \`src/${subFiles[i]}\` for bugs\n</SYSTEM_MESSAGE>`,
        },
        { step_index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'read_file', args: { Path: `"src/${subFiles[i]}"` } }] },
      ]);
      const meta = inspectSubagentTranscriptMeta(sPath);
      assert.equal(meta.isSubagent, true, `Subagent ${subIds[i]} must be detected past 12KB SessionStart`);
      assert.equal(meta.parentConversationId, 'chat-main-2');
    }

    // Nested subagent spawned by sub-agent-4 -> must also roll up under chat-main-2
    writeTranscript('sub-nested-5', [
      { step_index: 0, source: 'SYSTEM_SDK', type: 'SYSTEM_MESSAGE', content: bigSessionStart },
      { step_index: 1, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', content: '[Message] sender=sub-agent-4 content=Deep slice `src/save.ts`' },
      { step_index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'read_file', args: { Path: 'src/save.ts' } }] },
    ]);

    initTaskProgressFromPrompt({
      conversationId: 'chat-main-1',
      workspaceRoot: ROOT_DIR,
      transcriptPath: chat1Path,
      userPrompt: 'Почини звук кнопки',
      grade: 'S',
      brainDirs: [tmpBrain],
    });
    initTaskProgressFromPrompt({
      conversationId: 'chat-main-2',
      workspaceRoot: ROOT_DIR,
      transcriptPath: chat2Path,
      userPrompt: 'Полный аудит игры с субагентами',
      grade: 'L',
      brainDirs: [tmpBrain],
    });

    // Legacy isolation suffix (__deadbeef) must merge into chat-main-2 instead of creating a duplicate bar
    advanceTaskProgressOnPreTool({
      conversationId: 'chat-main-2__deadbeef',
      workspaceRoot: ROOT_DIR,
      transcriptPath: chat2Path,
      toolName: 'invoke_subagent',
      role: 'Аудитор движка Prestige',
      brainDirs: [tmpBrain],
    });

    // Subagent PreToolUse must nest under chat-main-2 rather than becoming Chat #3
    advanceTaskProgressOnPreTool({
      conversationId: 'sub-agent-1__deadbeef',
      workspaceRoot: ROOT_DIR,
      toolName: 'read_file',
      filePath: '"src/PrestigeEngine.ts"',
      brainDirs: [tmpBrain],
    });

    const snap = getTaskProgressSnapshot({
      workspaceRoot: ROOT_DIR,
      brainDirs: [tmpBrain],
      now: Date.now() + 500,
    });

    assert.equal(snap.activeChats.length, 2, 'Only 2 top-level user chats must be shown');
    const c1 = snap.activeChats.find((c) => c.conversationId === 'chat-main-1');
    const c2 = snap.activeChats.find((c) => c.conversationId === 'chat-main-2');
    assert.ok(c1 && c2);
    assert.equal(c1.chatLabel, 'Чат #1');
    assert.equal(c2.chatLabel, 'Чат #2');
    assert.equal(c1.subagents.length, 0);
    assert.equal(c2.subagents.length, 5, 'All 4 direct + 1 nested subagent must group under Chat #2');
    assert.equal(c2.runningSubagentsCount, 5);
    assert.equal(c2.subagents[0].conversationId, 'sub-agent-1');
    assert.equal(c2.subagents[0].subagentBadge, 'Агент #1');
    assert.equal(c2.subagents[0].roleLabel, 'Аудитор движка Prestige');
    assert.equal(c2.subagents[0].stepTitle, 'Чтение PrestigeEngine.ts');

    const uiHtml = fs.readFileSync(path.join(ROOT_DIR, 'sidecars', 'panel', 'ui.html'), 'utf8');
    assert.ok(uiHtml.includes("case 'toggleSubagentsList':"), 'Missing toggleSubagentsList dispatcher case');
    assert.ok(uiHtml.includes('ag-subagent-toggle-btn'), 'Missing left chevron toggle button class');
    assert.ok(uiHtml.includes('ag-subagents-drawer'), 'Missing collapsible subagent drawer');
    assert.ok(uiHtml.includes('ag-subagent-capsule'), 'Missing miniature subagent capsule');
  } finally {
    resetTaskProgress();
    fs.rmSync(tmpBrain, { recursive: true, force: true });
  }
});

test('24. Auto-Digest & Handoff: intra-epoch fillPercent, CHECKPOINT compaction reset, cid__wsHash dedup & readOnly panel poll', async () => {
  const { checkAndRecordRead, resetReadDedupState } = await import('../core/read-dedup.mjs');
  const tmpBrain = makeTempDir('amr-compact-');
  const cid = `conv-epoch-reset-${Date.now()}`;
  const transcriptPath = path.join(tmpBrain, cid, '.system_generated', 'logs', 'transcript.jsonl');
  const sampleFile = path.join(tmpBrain, 'sample-check.txt');
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
  fs.writeFileSync(sampleFile, 'hello world\nline two\n', 'utf8');

  const lines = [
    JSON.stringify({ type: 'USER_INPUT', source: 'USER_EXPLICIT', content: 'Refactor compaction meter' }),
    JSON.stringify({ type: 'PLANNER_RESPONSE', input_tokens: 30000, cache_read_tokens: 230000, output_tokens: 900 }),
  ];
  fs.writeFileSync(transcriptPath, lines.join('\n') + '\n', 'utf8');

  const stateFile = path.join(SUITE_CACHE_DIR, 'compaction-state.json');
  const prevStateRaw = fs.existsSync(stateFile) ? fs.readFileSync(stateFile, 'utf8') : null;
  const shortId = cid.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 8);
  const digestFile = path.join(SUITE_CACHE_DIR, `compaction-digest-${shortId}.md`);
  resetReadDedupState();

  try {
    // 1) Read-only poll reports intra-epoch fillPercent (4% of 250k, total 104%) without mutating state or emitting notice
    const ro1 = await checkHistoryCompaction({
      conversationId: cid,
      transcriptPath,
      thresholdTokens: 250000,
      readOnly: true,
    });
    assert.equal(ro1.epoch, 1);
    assert.equal(ro1.fillPercent, 4);
    assert.equal(ro1.totalFillPercent, 104);
    assert.equal(ro1.needsCompaction, true);
    assert.equal(ro1.compactionNotice, null);

    // 2) PreInvocation with __wsHash triggers Epoch #1 once
    const hook1 = await checkHistoryCompaction({
      conversationId: `${cid}__395fdc0f`,
      transcriptPath,
      thresholdTokens: 250000,
    });
    assert.equal(hook1.needsCompaction, true);
    assert.match(hook1.compactionNotice || '', /Epoch #1 \(104%/);

    // 3) Subsequent call with bare cid (without __wsHash) must NOT re-trigger Epoch #1
    const dupCheck = await checkHistoryCompaction({
      conversationId: cid,
      transcriptPath,
      thresholdTokens: 250000,
    });
    assert.equal(dupCheck.needsCompaction, false);
    assert.equal(dupCheck.compactionNotice, null);

    // Record a read BEFORE compaction checkpoint (backdated slightly before CHECKPOINT)
    const preRead = checkAndRecordRead({
      filePath: sampleFile,
      conversationId: `${cid}__395fdc0f`,
      stepIdx: 1,
      transcriptPath,
      nowMs: Date.now() - 5000,
    });
    assert.equal(preRead.allow, true);

    // 4) IDE compaction emits CHECKPOINT with pre-compaction cache_read_tokens -> must reset to Epoch #0
    const cpTs = new Date(Date.now() - 1000).toISOString();
    fs.appendFileSync(
      transcriptPath,
      JSON.stringify({
        type: 'CHECKPOINT',
        created_at: cpTs,
        content: '# Resuming from a compaction\n\nSummary of prior turns...',
        input_tokens: 4000,
        cache_read_tokens: 256000,
      }) + '\n',
      'utf8'
    );

    const afterCheckpoint = await checkHistoryCompaction({
      conversationId: `${cid}__395fdc0f`,
      transcriptPath,
      thresholdTokens: 250000,
    });
    assert.equal(afterCheckpoint.epoch, 0);
    assert.equal(afterCheckpoint.needsCompaction, false);

    // 5) Post-compaction turn at 35k tokens -> Epoch #0, 14% fill, and Read-Once Guard cache invalidated
    fs.appendFileSync(
      transcriptPath,
      JSON.stringify({ type: 'PLANNER_RESPONSE', input_tokens: 35000, cache_read_tokens: 0, output_tokens: 400 }) + '\n',
      'utf8'
    );
    const postComp = await checkHistoryCompaction({
      conversationId: `${cid}__395fdc0f`,
      transcriptPath,
      thresholdTokens: 250000,
    });
    assert.equal(postComp.epoch, 0);
    assert.equal(postComp.fillPercent, 14);

    const postRead = checkAndRecordRead({
      filePath: sampleFile,
      conversationId: `${cid}__395fdc0f`,
      stepIdx: 2,
      transcriptPath,
      nowMs: Date.now(),
    });
    assert.equal(postRead.allow, true);
    assert.equal(postRead.duplicate, false);

    // 6) Growing back past 250k after CHECKPOINT must cleanly fire Epoch #1 again
    fs.appendFileSync(
      transcriptPath,
      JSON.stringify({ type: 'PLANNER_RESPONSE', input_tokens: 30000, cache_read_tokens: 235000, output_tokens: 600 }) + '\n',
      'utf8'
    );
    const secondEpoch1 = await checkHistoryCompaction({
      conversationId: `${cid}__395fdc0f`,
      transcriptPath,
      thresholdTokens: 250000,
    });
    assert.equal(secondEpoch1.epoch, 1);
    assert.equal(secondEpoch1.fillPercent, 6);
    assert.equal(secondEpoch1.needsCompaction, true);
    assert.match(secondEpoch1.compactionNotice || '', /Epoch #1 \(106%/);
  } finally {
    resetReadDedupState();
    if (prevStateRaw !== null) {
      fs.writeFileSync(stateFile, prevStateRaw, 'utf8');
    } else if (fs.existsSync(stateFile)) {
      fs.rmSync(stateFile, { force: true });
    }
    if (fs.existsSync(digestFile)) {
      fs.rmSync(digestFile, { force: true });
    }
    fs.rmSync(tmpBrain, { recursive: true, force: true });
  }
});

test('24. Active Projects Filter: header pills show strictly live running/waiting_user projects and purge stale entries', async () => {
  const {
    advanceTaskProgressOnPreTool,
    getTaskProgressSnapshot,
    initTaskProgressFromPrompt,
    resetTaskProgress,
  } = await import('../core/task-progress.mjs');

  const tmpBrain = makeTempDir('amr-active-proj-');
  const gameWs = path.join(os.tmpdir(), 'sample-game');
  resetTaskProgress();
  try {
    const routerLog = path.join(tmpBrain, 'chat-router-live', '.system_generated', 'logs', 'transcript.jsonl');
    const gameLog = path.join(tmpBrain, 'chat-game-live', '.system_generated', 'logs', 'transcript.jsonl');
    fs.mkdirSync(path.dirname(routerLog), { recursive: true });
    fs.mkdirSync(path.dirname(gameLog), { recursive: true });

    fs.writeFileSync(
      routerLog,
      JSON.stringify({ step_index: 1, type: 'USER_INPUT', created_at: '2026-11-14T18:00:00Z', content: 'Обнови панель роутера' }) + '\n',
      'utf8'
    );
    fs.writeFileSync(
      gameLog,
      JSON.stringify({ step_index: 1, type: 'USER_INPUT', created_at: '2026-11-14T18:00:01Z', content: 'Проверь баланс игры' }) + '\n',
      'utf8'
    );

    initTaskProgressFromPrompt({
      conversationId: 'chat-router-live',
      workspaceRoot: ROOT_DIR,
      transcriptPath: routerLog,
      userPrompt: 'Обнови панель роутера',
      grade: 'M',
      brainDirs: [tmpBrain],
    });
    initTaskProgressFromPrompt({
      conversationId: 'chat-game-live',
      workspaceRoot: gameWs,
      transcriptPath: gameLog,
      userPrompt: 'Проверь баланс игры',
      grade: 'M',
      brainDirs: [tmpBrain],
    });
    const bothSnap = advanceTaskProgressOnPreTool({
      conversationId: 'chat-game-live',
      workspaceRoot: gameWs,
      transcriptPath: gameLog,
      toolName: 'ask_question',
      brainDirs: [tmpBrain],
    });

    const rootProjName = path.basename(ROOT_DIR);
    const activeNamesBoth = (bothSnap.activeProjects || []).map((p) => p.projectName).sort();
    assert.deepEqual(activeNamesBoth, ['sample-game', rootProjName].sort());
    assert.deepEqual(
      (bothSnap.recentProjects || []).map((p) => p.projectName).sort(),
      ['sample-game', rootProjName].sort()
    );

    // Finish the sample-game chat -> must immediately vanish from activeProjects & recentProjects
    fs.appendFileSync(
      gameLog,
      JSON.stringify({ step_index: 2, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-14T18:00:10Z', content: 'Готово!' }) + '\n',
      'utf8'
    );
    const afterGameDone = getTaskProgressSnapshot({
      workspaceRoot: ROOT_DIR,
      brainDirs: [tmpBrain],
      now: Date.now() + 500,
    });
    assert.deepEqual((afterGameDone.activeProjects || []).map((p) => p.projectName), [rootProjName]);
    assert.deepEqual((afterGameDone.recentProjects || []).map((p) => p.projectName), [rootProjName]);

    // Legacy stale entry injected on disk must be purged automatically by getTaskProgressSnapshot()
    const rawOnDisk = JSON.parse(fs.readFileSync(TASK_PROGRESS_FILE, 'utf8'));
    rawOnDisk.recentProjects = [
      { projectName: rootProjName, status: 'running', percent: 45, updatedAt: Date.now() },
      { projectName: 'sample-game', status: 'running', percent: 79, updatedAt: Date.now() - 60000 },
    ];
    atomicWriteJsonSync(TASK_PROGRESS_FILE, rawOnDisk);

    const purgedSnap = getTaskProgressSnapshot({
      workspaceRoot: ROOT_DIR,
      brainDirs: [tmpBrain],
      now: Date.now() + 1000,
    });
    assert.deepEqual((purgedSnap.activeProjects || []).map((p) => p.projectName), [rootProjName]);
    assert.deepEqual((purgedSnap.recentProjects || []).map((p) => p.projectName), [rootProjName]);

    const rewrittenOnDisk = JSON.parse(fs.readFileSync(TASK_PROGRESS_FILE, 'utf8'));
    assert.equal(rewrittenOnDisk.recentProjects.some((p) => p.projectName === 'sample-game'), false);

    // UI contract: #agRecentProjectsBar reads p.activeProjects and filters strictly running/waiting_user
    const uiHtml = fs.readFileSync(path.join(ROOT_DIR, 'sidecars', 'panel', 'ui.html'), 'utf8');
    assert.ok(uiHtml.includes('Array.isArray(p.activeProjects)'), 'ui.html must read p.activeProjects');
    assert.ok(
      uiHtml.includes("(rp.status === 'running' || rp.status === 'waiting_user')"),
      'ui.html must filter active parallel project chips strictly by running/waiting_user'
    );
  } finally {
    resetTaskProgress();
    fs.rmSync(tmpBrain, { recursive: true, force: true });
  }
});

test('25. Live Technical Task Stages: compact labels, plan extraction, live AST/test chips & UI tooltip contracts', async () => {
  const {
    compactTechnicalStepLabel,
    extractPrimarySymbolFromSnippet,
    extractStepsFromPlanText,
    initTaskProgressFromPrompt,
    advanceTaskProgressOnPreTool,
    recordTaskProgressOnPostTool,
    getTaskProgressSnapshot,
    resetTaskProgress,
  } = await import('../core/task-progress.mjs');

  // 1. Pure helpers
  const lbl = compactTechnicalStepLabel(
    'Update C:/proj/src/core/hook-runner.mjs: sanitizeStatePatch & validate pipeline cleanly',
    30
  );
  assert.ok(lbl.title.length <= 32, `Expected compact title <= 32 chars, got: ${lbl.title} (${lbl.title.length})`);
  assert.ok(lbl.title.includes('hook-runner.mjs'));
  assert.equal(lbl.title.includes('C:/proj'), false);
  assert.ok(lbl.fullTitle.includes('sanitizeStatePatch'));

  assert.equal(
    extractPrimarySymbolFromSnippet('export function sanitizeStatePatch(patch = {}) { return patch; }'),
    'sanitizeStatePatch'
  );

  const planSteps = extractStepsFromPlanText(
    '## Plan\n1. Inspect `core/task-progress.mjs` state machine\n2. Patch `sidecars/panel/ui.html` chip layout\n3. Run `node --test tests/router-core.test.mjs`\n\n## Re-plan if:\n- Unexpected test regressions'
  );
  assert.equal(planSteps.length, 3);
  assert.ok(planSteps.every((s) => s.source === 'plan' && s.title.length <= 32 && !/re-plan/i.test(s.fullTitle)));
  assert.ok(planSteps[0].title.includes('task-progress.mjs'));
  assert.ok(planSteps[1].title.includes('ui.html'));

  const tmpBrain = makeTempDir('amr-live-stages-');
  resetTaskProgress();
  try {
    // 2. Scope-aware + live hooks chat
    const initSnap = initTaskProgressFromPrompt({
      conversationId: 'chat-live-hooks',
      workspaceRoot: ROOT_DIR,
      userPrompt: 'Обнови server.mjs и router-core.test.mjs',
      grade: 'L',
      matchedFiles: ['sidecars/panel/server.mjs', 'tests/router-core.test.mjs'],
      brainDirs: [tmpBrain],
    });
    assert.equal(initSnap.steps.length, 4);
    assert.ok(initSnap.steps[0].title.includes('server.mjs'));
    assert.ok(initSnap.steps[1].title.includes('server.mjs'));
    assert.ok(initSnap.steps[3].title.includes('router-core.test.mjs'));

    const edit1 = advanceTaskProgressOnPreTool({
      conversationId: 'chat-live-hooks',
      workspaceRoot: ROOT_DIR,
      toolName: 'edit_file',
      filePath: 'sidecars/panel/server.mjs',
      symbolHint: 'sanitizeStatePatch',
      brainDirs: [tmpBrain],
    });
    assert.equal(edit1.formattedText, 'Этап 2 из 4 · Правка server.mjs');
    assert.ok(edit1.steps[1].title.includes('server.mjs'));
    assert.ok(edit1.steps[1].fullTitle.includes('sanitizeStatePatch'));

    const edit2 = advanceTaskProgressOnPreTool({
      conversationId: 'chat-live-hooks',
      workspaceRoot: ROOT_DIR,
      toolName: 'edit_file',
      filePath: 'sidecars/panel/ui.html',
      symbolHint: 'renderTaskProgressAndHud',
      brainDirs: [tmpBrain],
    });
    assert.ok(edit2.steps[1].fullTitle.includes('ui.html'));
    assert.ok(edit2.steps[1].fullTitle.includes('renderTaskProgressAndHud'));

    const postEdit = recordTaskProgressOnPostTool({
      conversationId: 'chat-live-hooks',
      workspaceRoot: ROOT_DIR,
      toolName: 'edit_file',
      filePath: 'sidecars/panel/server.mjs',
      verifyOk: true,
      microTestsRan: true,
      dependentsCount: 3,
      testFile: 'tests/router-core.test.mjs',
      brainDirs: [tmpBrain],
    });
    assert.equal(postEdit.steps[2].title, 'Контракты AST (3 завис.)');
    assert.ok(postEdit.steps[3].title.includes('router-core.test'));
    assert.ok(postEdit.steps[3].title.length <= 32);
    assert.ok(postEdit.steps[3].fullTitle.includes('router-core.test.mjs'));

    const postCmd = recordTaskProgressOnPostTool({
      conversationId: 'chat-live-hooks',
      workspaceRoot: ROOT_DIR,
      toolName: 'run_command',
      commandLine: 'node --test tests/router-core.test.mjs',
      verifyOk: true,
      hasError: false,
      brainDirs: [tmpBrain],
    });
    assert.equal(postCmd.currentStep, 4);
    assert.equal(postCmd.steps[3].title, 'Тест router-core.test.mjs');
    assert.ok(postCmd.steps[3].fullTitle.includes('router-core.test.mjs'));

    // 3. Auto-discovered transcript.jsonl plan & MCP ram_slice chat
    resetTaskProgress();
    const planLog = path.join(tmpBrain, 'chat-plan-transcript', '.system_generated', 'logs', 'transcript.jsonl');
    fs.mkdirSync(path.dirname(planLog), { recursive: true });
    fs.writeFileSync(
      planLog,
      [
        JSON.stringify({
          step_index: 1,
          type: 'USER_INPUT',
          created_at: '2026-11-14T19:00:00Z',
          content: 'Сделай рефакторинг task-progress',
        }),
        JSON.stringify({
          step_index: 2,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: '2026-11-14T19:00:05Z',
          tool_calls: [
            {
              name: 'mcp_antigravity-model-router_ram-memory_ram_slice',
              args: { filePath: 'core/task-progress.mjs', workspaceRoot: ROOT_DIR },
            },
            {
              name: 'exit_plan_mode',
              args: {
                plan: '1. Slice `core/task-progress.mjs`\n2. Update `core/hook-runner.mjs`\n3. Verify `tests/router-core.test.mjs`\n\nRe-plan if:\n- Syntax fails',
              },
            },
          ],
        }),
      ].join('\n') + '\n',
      'utf8'
    );

    const discSnap = getTaskProgressSnapshot({ workspaceRoot: ROOT_DIR, brainDirs: [tmpBrain] });
    assert.equal(discSnap.steps.length, 3);
    assert.equal(discSnap.steps[0].source, 'plan');
    assert.ok(discSnap.steps[0].title.includes('task-progress.mjs'));
    assert.ok(discSnap.steps[1].title.includes('hook-runner.mjs'));

    // 4. UI contracts in sidecars/panel/ui.html
    const uiHtml = fs.readFileSync(path.join(ROOT_DIR, 'sidecars', 'panel', 'ui.html'), 'utf8');
    assert.ok(uiHtml.includes('.ag-step-chip.error'), 'ui.html must define .ag-step-chip.error');
    assert.ok(uiHtml.includes('text-overflow: ellipsis'), 'ui.html must truncate overflowing chips with ellipsis');
    assert.ok(uiHtml.includes('max-width: 225px'), 'ui.html must constrain chip max-width to 225px');
    assert.ok(uiHtml.includes('st.fullTitle'), 'ui.html must render st.fullTitle in chip tooltip');
  } finally {
    resetTaskProgress();
    fs.rmSync(tmpBrain, { recursive: true, force: true });
  }
});

test('26. Multi-project parallel chats: contiguous project grouping & per-project UI container contracts', async () => {
  const {
    initTaskProgressFromPrompt,
    advanceTaskProgressOnPreTool,
    getTaskProgressSnapshot,
    resetTaskProgress,
  } = await import('../core/task-progress.mjs');

  const tmpBrain = makeTempDir('amr-multi-proj-group-');
  const dmWs = path.join(os.tmpdir(), 'dmstagemix');
  resetTaskProgress();
  try {
    const amrLog1 = path.join(tmpBrain, 'chat-amr-1', '.system_generated', 'logs', 'transcript.jsonl');
    const dmLog1 = path.join(tmpBrain, 'chat-dm-1', '.system_generated', 'logs', 'transcript.jsonl');
    const amrLog2 = path.join(tmpBrain, 'chat-amr-2', '.system_generated', 'logs', 'transcript.jsonl');
    fs.mkdirSync(path.dirname(amrLog1), { recursive: true });
    fs.mkdirSync(path.dirname(dmLog1), { recursive: true });
    fs.mkdirSync(path.dirname(amrLog2), { recursive: true });

    fs.writeFileSync(
      amrLog1,
      JSON.stringify({ step_index: 1, type: 'USER_INPUT', created_at: '2026-11-14T20:00:00Z', content: 'Обнови панель' }) + '\n',
      'utf8'
    );
    fs.writeFileSync(
      dmLog1,
      JSON.stringify({ step_index: 1, type: 'USER_INPUT', created_at: '2026-11-14T20:00:01Z', content: 'Давай обновим также на планшете' }) + '\n',
      'utf8'
    );
    fs.writeFileSync(
      amrLog2,
      JSON.stringify({ step_index: 1, type: 'USER_INPUT', created_at: '2026-11-14T20:00:02Z', content: 'Давай чтобы было понятно' }) + '\n',
      'utf8'
    );

    // Interleave initialization across projects: amr #1 -> dm #1 -> amr #2
    initTaskProgressFromPrompt({
      conversationId: 'chat-amr-1',
      workspaceRoot: ROOT_DIR,
      transcriptPath: amrLog1,
      userPrompt: 'Обнови панель',
      grade: 'M',
      brainDirs: [tmpBrain],
    });
    await new Promise((r) => setTimeout(r, 15));
    initTaskProgressFromPrompt({
      conversationId: 'chat-dm-1',
      workspaceRoot: dmWs,
      transcriptPath: dmLog1,
      userPrompt: 'Давай обновим также на планшете',
      grade: 'M',
      brainDirs: [tmpBrain],
    });
    await new Promise((r) => setTimeout(r, 15));
    initTaskProgressFromPrompt({
      conversationId: 'chat-amr-2',
      workspaceRoot: ROOT_DIR,
      transcriptPath: amrLog2,
      userPrompt: 'Давай чтобы было понятно',
      grade: 'M',
      brainDirs: [tmpBrain],
    });

    const rootProjName = path.basename(ROOT_DIR);
    const snapBefore = getTaskProgressSnapshot({ workspaceRoot: ROOT_DIR, brainDirs: [tmpBrain] });
    assert.equal(snapBefore.activeChats.length, 3);
    const projSequenceBefore = snapBefore.activeChats.map((c) => c.projectName);
    assert.deepEqual(projSequenceBefore, [
      rootProjName,
      rootProjName,
      'dmstagemix',
    ]);
    const amrChatsBefore = snapBefore.activeChats.filter((c) => c.projectName === rootProjName);
    assert.equal(amrChatsBefore[0].conversationId, 'chat-amr-1');
    assert.equal(amrChatsBefore[1].conversationId, 'chat-amr-2');
    assert.ok(amrChatsBefore[0].chatNumber < amrChatsBefore[1].chatNumber);

    // Advancing a tool in the second project must NOT flip the group order
    await new Promise((r) => setTimeout(r, 15));
    const snapAfterTool = advanceTaskProgressOnPreTool({
      conversationId: 'chat-dm-1',
      workspaceRoot: dmWs,
      transcriptPath: dmLog1,
      toolName: 'edit_file',
      filePath: path.join(dmWs, 'public', 'index.html'),
      brainDirs: [tmpBrain],
    });
    assert.deepEqual(
      snapAfterTool.activeChats.map((c) => c.projectName),
      projSequenceBefore,
      'Project group ordering must remain stable when second project updates'
    );

    const uiHtml = fs.readFileSync(path.join(ROOT_DIR, 'sidecars', 'panel', 'ui.html'), 'utf8');
    assert.ok(uiHtml.includes('.ag-project-group'), 'ui.html must define .ag-project-group');
    assert.ok(uiHtml.includes('.ag-project-group-head'), 'ui.html must define .ag-project-group-head');
    assert.ok(uiHtml.includes('.ag-project-group-chats'), 'ui.html must define .ag-project-group-chats');
    assert.ok(uiHtml.includes('formatProjectsWordRu'), 'ui.html must format multi-project summary pill');
    assert.ok(uiHtml.includes('createProjectGroupElement'), 'ui.html must create per-project containers');
    assert.equal(
      uiHtml.includes('c.projectName !== projName'),
      false,
      'ui.html must not hide primary project identity via asymmetric c.projectName !== projName badge logic'
    );
  } finally {
    resetTaskProgress();
    fs.rmSync(tmpBrain, { recursive: true, force: true });
  }
});

test('29. Dynamic Timeline Steps (max 30), Pre-Edit <=35% Guard, Orange Question Step & Expandable Capsules UI', async () => {
  const {
    MAX_PRE_EDIT_PERCENT,
    MAX_TIMELINE_STEPS,
    advanceTaskProgressOnPreTool,
    getTaskProgressSnapshot,
    initTaskProgressFromPrompt,
    recordTaskProgressOnPostTool,
    resetTaskProgress,
  } = await import('../core/task-progress.mjs');

  assert.equal(MAX_TIMELINE_STEPS, 30);
  assert.equal(MAX_PRE_EDIT_PERCENT, 35);

  const tmpBrain = makeTempDir('amr-dyn-steps-');
  resetTaskProgress();
  try {
    // 1) Pre-edit reads + recon Get-ChildItem tests/ + ask_question must NEVER jump to 92%
    const qLog = path.join(tmpBrain, 'chat-q-flow', '.system_generated', 'logs', 'transcript.jsonl');
    fs.mkdirSync(path.dirname(qLog), { recursive: true });
    fs.writeFileSync(
      qLog,
      JSON.stringify({ step_index: 1, type: 'USER_INPUT', created_at: '2026-11-14T22:00:00Z', content: 'Сделай компактные шаги' }) + '\n',
      'utf8'
    );

    initTaskProgressFromPrompt({
      conversationId: 'chat-q-flow',
      workspaceRoot: ROOT_DIR,
      transcriptPath: qLog,
      userPrompt: 'Сделай компактные шаги',
      grade: 'M',
      brainDirs: [tmpBrain],
    });

    // Consecutive reads coalesce onto Step 1 (recon)
    let snap = advanceTaskProgressOnPreTool({
      conversationId: 'chat-q-flow',
      workspaceRoot: ROOT_DIR,
      transcriptPath: qLog,
      toolName: 'read_file',
      filePath: 'core/task-progress.mjs',
      brainDirs: [tmpBrain],
    });
    snap = advanceTaskProgressOnPreTool({
      conversationId: 'chat-q-flow',
      workspaceRoot: ROOT_DIR,
      transcriptPath: qLog,
      toolName: 'read_file',
      filePath: 'sidecars/panel/ui.html',
      brainDirs: [tmpBrain],
    });
    let chat = snap.activeChats.find((c) => c.conversationId === 'chat-q-flow');
    assert.equal(chat.currentStep, 1);
    assert.equal(chat.steps[0].kind, 'recon');
    assert.ok(chat.percent <= MAX_PRE_EDIT_PERCENT, `Pre-edit reads percent ${chat.percent} must stay <= ${MAX_PRE_EDIT_PERCENT}`);

    // Listing tests/ directory via run_command is recon (NOT test runner!) and becomes Step 2
    snap = advanceTaskProgressOnPreTool({
      conversationId: 'chat-q-flow',
      workspaceRoot: ROOT_DIR,
      transcriptPath: qLog,
      toolName: 'run_command',
      commandLine: 'Get-ChildItem -Name tests/',
      brainDirs: [tmpBrain],
    });
    snap = recordTaskProgressOnPostTool({
      conversationId: 'chat-q-flow',
      workspaceRoot: ROOT_DIR,
      transcriptPath: qLog,
      toolName: 'run_command',
      commandLine: 'Get-ChildItem -Name tests/',
      verifyOk: true,
      brainDirs: [tmpBrain],
    });
    chat = snap.activeChats.find((c) => c.conversationId === 'chat-q-flow');
    assert.equal(chat.currentStep, 2);
    assert.equal(chat.steps[1].kind, 'cmd_recon');
    assert.ok(chat.percent <= MAX_PRE_EDIT_PERCENT, `Recon command percent ${chat.percent} must stay <= ${MAX_PRE_EDIT_PERCENT}`);

    // ask_question lands on Step 3 (kind: 'question') and keeps percent <= 35%
    snap = advanceTaskProgressOnPreTool({
      conversationId: 'chat-q-flow',
      workspaceRoot: ROOT_DIR,
      transcriptPath: qLog,
      toolName: 'ask_question',
      questionHint: 'Визуальный стиль шагов',
      brainDirs: [tmpBrain],
    });
    chat = snap.activeChats.find((c) => c.conversationId === 'chat-q-flow');
    assert.equal(chat.status, 'waiting_user');
    assert.equal(chat.currentStep, 3);
    assert.ok(chat.totalSteps >= 5, `Expected >= 5 steps with pending tail, got ${chat.totalSteps}`);
    assert.equal(chat.steps[2].kind, 'question');
    assert.equal(chat.steps[2].status, 'waiting_user');
    assert.ok(chat.percent <= MAX_PRE_EDIT_PERCENT, `ask_question percent ${chat.percent} must stay <= ${MAX_PRE_EDIT_PERCENT}`);

    // 2) User answers -> advances to Step 4 while Step 3 retains permanent kind: 'question'
    snap = initTaskProgressFromPrompt({
      conversationId: 'chat-q-flow',
      workspaceRoot: ROOT_DIR,
      transcriptPath: qLog,
      userPrompt: 'Круглые капсулы',
      resumeIfWaiting: true,
      brainDirs: [tmpBrain],
    });
    chat = snap.activeChats.find((c) => c.conversationId === 'chat-q-flow');
    assert.equal(chat.status, 'running');
    assert.equal(chat.currentStep, 4);
    assert.ok(chat.percent <= 38, `Resumed pre-edit percent ${chat.percent} should be <= 38`);
    assert.equal(chat.steps[2].kind, 'question');
    assert.equal(chat.steps[2].status, 'completed');

    // Now edit_file proceeds on Step 4 -> AST contracts & final test preserve Step 3 question mark
    snap = advanceTaskProgressOnPreTool({
      conversationId: 'chat-q-flow',
      workspaceRoot: ROOT_DIR,
      transcriptPath: qLog,
      toolName: 'edit_file',
      filePath: 'core/task-progress.mjs',
      brainDirs: [tmpBrain],
    });
    chat = snap.activeChats.find((c) => c.conversationId === 'chat-q-flow');
    assert.equal(chat.currentStep, 4);
    assert.ok(chat.percent >= 50);
    assert.equal(chat.steps[2].kind, 'question');

    // 3) Dynamic expansion across alternating phases with hard cap = 30 + coalescing
    initTaskProgressFromPrompt({
      conversationId: 'chat-cap-30',
      workspaceRoot: ROOT_DIR,
      userPrompt: 'Большой мультифазный рефакторинг',
      grade: 'L',
      brainDirs: [],
    });
    advanceTaskProgressOnPreTool({
      conversationId: 'chat-cap-30',
      workspaceRoot: ROOT_DIR,
      toolName: 'edit_file',
      filePath: 'src/a.mjs',
      brainDirs: [],
    });
    const beforeCoalesce = getTaskProgressSnapshot({ workspaceRoot: ROOT_DIR, brainDirs: [] })
      .activeChats.find((c) => c.conversationId === 'chat-cap-30');
    const stepCountBeforeCoalesce = beforeCoalesce.totalSteps;
    advanceTaskProgressOnPreTool({
      conversationId: 'chat-cap-30',
      workspaceRoot: ROOT_DIR,
      toolName: 'edit_file',
      filePath: 'src/b.mjs',
      brainDirs: [],
    });
    const afterCoalesce = getTaskProgressSnapshot({ workspaceRoot: ROOT_DIR, brainDirs: [] })
      .activeChats.find((c) => c.conversationId === 'chat-cap-30');
    assert.equal(afterCoalesce.totalSteps, stepCountBeforeCoalesce, 'Consecutive edits must coalesce');

    for (let i = 0; i < 35; i++) {
      advanceTaskProgressOnPreTool({
        conversationId: 'chat-cap-30',
        workspaceRoot: ROOT_DIR,
        toolName: 'run_command',
        commandLine: `node --check src/mod_${i}.mjs`,
        brainDirs: [],
      });
      advanceTaskProgressOnPreTool({
        conversationId: 'chat-cap-30',
        workspaceRoot: ROOT_DIR,
        toolName: 'edit_file',
        filePath: `src/mod_${i}.mjs`,
        brainDirs: [],
      });
    }
    const cappedChat = getTaskProgressSnapshot({ workspaceRoot: ROOT_DIR, brainDirs: [] })
      .activeChats.find((c) => c.conversationId === 'chat-cap-30');
    assert.equal(cappedChat.totalSteps, 30, 'Total timeline steps must cap at MAX_TIMELINE_STEPS (30)');
    assert.equal(cappedChat.steps.length, 30);

    // 4) Unhooked transcript auto-discovery pre-edit mcpFloor must stay <= 35%
    const tLog = path.join(tmpBrain, 'chat-transcript-pre', '.system_generated', 'logs', 'transcript.jsonl');
    fs.mkdirSync(path.dirname(tLog), { recursive: true });
    fs.writeFileSync(
      tLog,
      [
        JSON.stringify({ step_index: 1, type: 'USER_INPUT', created_at: '2026-11-14T22:10:00Z', content: 'Проверь модули и уточни' }),
        JSON.stringify({ step_index: 2, type: 'PLANNER_RESPONSE', created_at: '2026-11-14T22:10:01Z', tool_calls: [{ name: 'read_file', args: { Path: 'a.mjs' } }, { name: 'read_file', args: { Path: 'b.mjs' } }] }),
        JSON.stringify({ step_index: 3, type: 'PLANNER_RESPONSE', created_at: '2026-11-14T22:10:02Z', tool_calls: [{ name: 'run_command', args: { CommandLine: 'Get-ChildItem tests/' } }] }),
        JSON.stringify({ step_index: 4, type: 'PLANNER_RESPONSE', created_at: '2026-11-14T22:10:03Z', tool_calls: [{ name: 'ask_question', args: { questions: [{ question: 'Какой вариант?', options: ['A', 'B'] }] } }] }),
      ].join('\n') + '\n',
      'utf8'
    );
    const snapTranscript = getTaskProgressSnapshot({ workspaceRoot: ROOT_DIR, brainDirs: [tmpBrain] });
    const tChat = snapTranscript.activeChats.find((c) => c.conversationId === 'chat-transcript-pre');
    assert.ok(tChat, 'Expected auto-discovered transcript chat');
    assert.equal(tChat.status, 'waiting_user');
    assert.ok(tChat.percent <= MAX_PRE_EDIT_PERCENT, `Transcript pre-edit percent ${tChat.percent} must be <= ${MAX_PRE_EDIT_PERCENT}`);
    assert.ok(tChat.steps.some((s) => s.kind === 'question'), 'Transcript steps must mark ask_question step');

    // 5) UI capsule-transformer & orange question underline CSS/JS contracts
    const uiHtml = fs.readFileSync(path.join(ROOT_DIR, 'sidecars', 'panel', 'ui.html'), 'utf8');
    assert.ok(uiHtml.includes('.ag-step-chip.question'), 'ui.html must style .ag-step-chip.question');
    assert.ok(uiHtml.includes('.ag-step-num'), 'ui.html must include numbered capsule .ag-step-num');
    assert.ok(uiHtml.includes('.ag-step-label'), 'ui.html must include expandable .ag-step-label');
    assert.ok(uiHtml.includes('.ag-step-chip.is-expanded .ag-step-label'), 'ui.html must expand .ag-step-label on click (.is-expanded)');
    assert.ok(!uiHtml.includes('.ag-step-chip:hover .ag-step-label'), 'ui.html must not auto-expand .ag-step-label on hover');
    assert.ok(uiHtml.includes("case 'toggleStepChip':"), 'ui.html must dispatch toggleStepChip on click');
    assert.ok(uiHtml.includes('_agExpandedStepsByChat'), 'ui.html must persist expanded step state per chat across telemetry ticks');
    assert.ok(uiHtml.includes('c.steps.slice(0, 30)'), 'ui.html must enforce max 30 step capsules');
    assert.ok(uiHtml.includes('#f97316'), 'ui.html must style amber-orange underline for question step');
  } finally {
    resetTaskProgress();
    fs.rmSync(tmpBrain, { recursive: true, force: true });
  }
});

test('31. Stage 1-4 Polish Regressions: TAP/Stop/Badge/MCP/GPU/Drift/Pricing/Agents/ContextPills/HUD', async () => {
  const { formatCompactProcessError } = await import('../core/auto-verifier.mjs');
  const { recordPitfall, listPitfalls, clearPitfalls } = await import('../core/pitfall-ledger.mjs');
  const {
    initTaskProgressFromPrompt,
    advanceTaskProgressOnPreTool,
    finalizeTaskProgressOnStop,
    getTaskProgressSnapshot,
    resetTaskProgress,
  } = await import('../core/task-progress.mjs');
  const {
    handlePreInvocation,
    handleStop,
    buildZeroTokenUserBadgeStep,
    checkInstalledPluginDrift,
  } = await import('../core/hook-runner.mjs');
  const { MCP_TOOLS } = await import('../core/ram-memory-mcp.mjs');
  const { syncMcpRamBudget } = await import('../core/hardware-profiler.mjs');
  const { getPricingPhaseStatus } = await import('../core/model-profile.mjs');
  const { buildWpfFloatingHudScript } = await import('../core/floating-hud.mjs');

  const tmpWs = makeTempDir('amr-stage14-ws-');
  const tmpDriftRepo = makeTempDir('amr-drift-repo-');
  const tmpDriftInst = makeTempDir('amr-drift-inst-');
  const tmpBrain = makeTempDir('amr-stage14-brain-');

  try {
    // 1. formatCompactProcessError & recordPitfall ignore TAP/node:test pass lines
    assert.equal(formatCompactProcessError(new Error('')), 'Process failed');
    const withRealErr = formatCompactProcessError({
      stderr: 'TAP version 13\n✔ 1. good\n✓ 2. fine\nok 3 - pass\nAssertionError: broken invariant\n  at fn (x.mjs:5:2)',
    });
    assert.equal(withRealErr.includes('✔'), false);
    assert.equal(withRealErr.includes('TAP version'), false);
    assert.ok(withRealErr.includes('AssertionError: broken invariant'));

    const ignoredPf = recordPitfall({
      type: 'test_failure',
      fileName: 'x.mjs',
      summary: '✔ 29. Dynamic Timeline Steps (100.28ms)',
      workspaceRoot: tmpWs,
    });
    assert.equal(ignoredPf.ignoredFalsePositive, true);
    assert.equal(ignoredPf.id, null);
    assert.equal(listPitfalls(15, tmpWs).length, 0);

    const validPf = recordPitfall({
      type: 'test_failure',
      fileName: 'x.mjs',
      summary: '✖ 1. real failure AssertionError',
      workspaceRoot: tmpWs,
    });
    assert.ok(typeof validPf.id === 'string' && validPf.id.startsWith('pf_'));
    assert.equal(listPitfalls(15, tmpWs).length, 1);

    // 2. Stop hook + finalizeTaskProgressOnStop
    const hooksJson = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'hooks.json'), 'utf8'));
    const stopHooks = hooksJson['model-router-engine']?.Stop || hooksJson.hooks?.Stop;
    assert.ok(Array.isArray(stopHooks) && stopHooks.length > 0, 'hooks.json must register Stop hook');
    assert.ok(
      JSON.stringify(stopHooks).includes('hook-runner.mjs Stop'),
      'Stop hook must invoke hook-runner.mjs Stop'
    );

    resetTaskProgress();
    initTaskProgressFromPrompt({
      conversationId: 'chat-stop-ok',
      workspaceRoot: ROOT_DIR,
      userPrompt: 'Обнови test module и проверь',
      grade: 'S',
      brainDirs: [],
    });
    const stopOkSnap = finalizeTaskProgressOnStop({
      conversationId: 'chat-stop-ok',
      workspaceRoot: ROOT_DIR,
      hasError: false,
      brainDirs: [],
    });
    const stopOkChat = stopOkSnap.activeChats.find((c) => c.conversationId === 'chat-stop-ok');
    assert.equal(stopOkChat.status, 'completed');
    assert.equal(stopOkChat.percent, 100);

    initTaskProgressFromPrompt({
      conversationId: 'chat-stop-wait',
      workspaceRoot: ROOT_DIR,
      userPrompt: 'Уточни архитектуру',
      grade: 'M',
      brainDirs: [],
    });
    advanceTaskProgressOnPreTool({
      conversationId: 'chat-stop-wait',
      workspaceRoot: ROOT_DIR,
      toolName: 'ask_question',
      questionHint: 'Выбор варианта?',
      brainDirs: [],
    });
    const waitAfterStop = finalizeTaskProgressOnStop({
      conversationId: 'chat-stop-wait',
      workspaceRoot: ROOT_DIR,
      brainDirs: [],
    });
    assert.equal(
      waitAfterStop.activeChats.find((c) => c.conversationId === 'chat-stop-wait').status,
      'waiting_user',
      'Stop must preserve waiting_user pause'
    );

    const stopHookOut = await handleStop({
      conversationId: 'chat-stop-ok',
      workspaceRoot: ROOT_DIR,
      status: 'completed',
    });
    assert.deepEqual(stopHookOut, {});

    // 3. Zero-token user_markdown badge on PreInvocation (standalone vs read-only)
    const badgeStep = buildZeroTokenUserBadgeStep({
      grade: 'L',
      modelProfile: { displayNameRu: 'Hydrogen · Высокий' },
      pruningResult: { domain: 'algo_refactor' },
      state: { showBadge: true, routingMode: 'auto_balance' },
    });
    assert.equal(badgeStep.systemMessage.systemMessage, '');
    assert.ok(badgeStep.systemMessage.metadata.user_markdown.includes('**Сложность:** L'));
    assert.equal(badgeStep.systemMessage.metadata.user_markdown.includes('Ultra'), false);
    const pkgVersion = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8')).version;
    const ultraBadgeStep = buildZeroTokenUserBadgeStep({
      grade: 'L',
      modelProfile: { displayNameRu: 'Carbon · Высокий' },
      pruningResult: { domain: 'algo_refactor' },
      state: { showBadge: true, subscriptionTier: 'ultra' },
    });
    assert.ok(ultraBadgeStep.systemMessage.metadata.user_markdown.includes(`Автопилот v${pkgVersion} · Ultra`));
    assert.equal(buildZeroTokenUserBadgeStep({ state: { showBadge: false } }), null);

    const preCode = await handlePreInvocation(
      {
        hookEventName: 'PreInvocation',
        conversationId: 'chat-pre-badge-code',
        workspacePaths: [ROOT_DIR],
        prompt: 'Отрефактори core/hook-runner.mjs и проверь unit-тесты',
        _forceFullPreInvocation: true,
      },
      { showBadge: true, confirmBeforeRun: false, ramCacheEnabled: false }
    );
    const hasBadgeStep = (preCode.injectSteps || []).some(
      (s) => s?.systemMessage?.systemMessage === '' && typeof s?.systemMessage?.metadata?.user_markdown === 'string'
    );
    assert.equal(hasBadgeStep, false, 'Default PreInvocation must NOT append user_markdown step that drops hook payload');
    assert.equal(
      (preCode.injectSteps || []).some((s) => typeof s?.ephemeralMessage === 'string' && s.ephemeralMessage.length > 0),
      true,
      'PreInvocation coding turn must preserve ephemeralMessage'
    );

    const preCodeOptIn = await handlePreInvocation(
      {
        hookEventName: 'PreInvocation',
        conversationId: 'chat-pre-badge-code-optin',
        workspacePaths: [ROOT_DIR],
        prompt: 'Отрефактори core/hook-runner.mjs и проверь unit-тесты',
        _forceFullPreInvocation: true,
      },
      { showBadge: true, experimentalUserMarkdownBadge: true, confirmBeforeRun: false, ramCacheEnabled: false }
    );
    const hasOptInBadgeStep = (preCodeOptIn.injectSteps || []).some(
      (s) => s?.systemMessage?.systemMessage === '' && typeof s?.systemMessage?.metadata?.user_markdown === 'string'
    );
    assert.equal(hasOptInBadgeStep, true, 'Opt-in experimentalUserMarkdownBadge must emit user_markdown badge');

    const preRo = await handlePreInvocation(
      {
        hookEventName: 'PreInvocation',
        conversationId: 'chat-pre-badge-ro',
        workspacePaths: [ROOT_DIR],
        prompt: 'Что такое HTTP 404?',
        _forceFullPreInvocation: true,
      },
      { showBadge: true, experimentalUserMarkdownBadge: true, confirmBeforeRun: false, ramCacheEnabled: false }
    );
    const roHasBadge = (preRo.injectSteps || []).some(
      (s) => s?.systemMessage?.systemMessage === '' && typeof s?.systemMessage?.metadata?.user_markdown === 'string'
    );
    assert.equal(roHasBadge, false, 'Simple read-only question must not emit badge');

    // 4. MCP annotations & syncMcpRamBudget gpuEnabled toggling
    assert.ok(MCP_TOOLS.length >= 8);
    const baseToolNames = [
      'ram_search', 'ram_slice', 'ram_context_pack', 'ram_warm_workspace',
      'ram_stats', 'gpu_distill', 'gpu_semantic_search', 'gpu_status',
    ];
    for (const baseName of baseToolNames) {
      assert.ok(MCP_TOOLS.some((t) => t.name === baseName), `Missing baseline MCP tool: ${baseName}`);
    }
    for (const toolDef of MCP_TOOLS) {
      assert.ok(toolDef.annotations, `MCP tool ${toolDef.name} must define annotations`);
      assert.equal(typeof toolDef.annotations.title, 'string');
      assert.equal(typeof toolDef.annotations.readOnlyHint, 'boolean');
      assert.equal(typeof toolDef.annotations.destructiveHint, 'boolean');
      assert.equal(typeof toolDef.annotations.idempotentHint, 'boolean');
      assert.equal(typeof toolDef.annotations.openWorldHint, 'boolean');
    }

    const mockPlugin = path.join(tmpWs, 'mock-plugin');
    fs.mkdirSync(mockPlugin, { recursive: true });
    fs.writeFileSync(
      path.join(mockPlugin, 'mcp_config.json'),
      JSON.stringify({
        mcpServers: {
          'ram-memory': {
            command: 'node',
            args: ['--max-old-space-size=4096', 'core/ram-memory-mcp.mjs'],
            tools: {
              gpu_distill: { eager: true },
              gpu_semantic_search: { eager: true },
            },
          },
        },
      }),
      'utf8'
    );
    assert.equal(syncMcpRamBudget(mockPlugin, 8192, { gpuEnabled: false }), true);
    const mcpOff = JSON.parse(fs.readFileSync(path.join(mockPlugin, 'mcp_config.json'), 'utf8'));
    assert.equal(mcpOff.mcpServers['ram-memory'].tools.gpu_distill.eager, false);
    assert.equal(mcpOff.mcpServers['ram-memory'].tools.gpu_semantic_search.eager, false);
    assert.ok(mcpOff.mcpServers['ram-memory'].args.includes('--max-old-space-size=8192'));

    assert.equal(syncMcpRamBudget(mockPlugin, 8192, { gpuEnabled: true }), true);
    const mcpOn = JSON.parse(fs.readFileSync(path.join(mockPlugin, 'mcp_config.json'), 'utf8'));
    assert.equal(mcpOn.mcpServers['ram-memory'].tools.gpu_distill.eager, true);
    assert.equal(mcpOn.mcpServers['ram-memory'].tools.gpu_semantic_search.eager, true);

    // 5. checkInstalledPluginDrift
    const repoSub = path.join(tmpDriftRepo, 'antigravity-model-router');
    const instSub = path.join(tmpDriftInst, 'antigravity-model-router');
    for (const rel of ['hooks.json', 'rules/AGENTS.md', 'core/hook-runner.mjs', 'core/auto-verifier.mjs', 'core/task-progress.mjs']) {
      fs.mkdirSync(path.dirname(path.join(repoSub, rel)), { recursive: true });
      fs.mkdirSync(path.dirname(path.join(instSub, rel)), { recursive: true });
      fs.writeFileSync(path.join(repoSub, rel), `same:${rel}`, 'utf8');
      fs.writeFileSync(path.join(instSub, rel), `same:${rel}`, 'utf8');
    }
    const noDrift = checkInstalledPluginDrift({ repoRoot: repoSub, installedRoot: instSub });
    assert.equal(noDrift.checked, true);
    assert.equal(noDrift.hasDrift, false);

    fs.writeFileSync(path.join(repoSub, 'hooks.json'), 'changed:hooks.json', 'utf8');
    const withDrift = checkInstalledPluginDrift({ repoRoot: repoSub, installedRoot: instSub });
    assert.equal(withDrift.checked, true);
    assert.equal(withDrift.hasDrift, true);
    assert.deepEqual(withDrift.driftedFiles, ['hooks.json']);

    // 6. getPricingPhaseStatus + server.mjs wiring
    const promo = getPricingPhaseStatus(new Date('2026-11-15T12:00:00Z'));
    assert.equal(promo.phase, 'promo');
    assert.equal(promo.isPostPromo, false);
    assert.equal(promo.ratesPer1M.carbon.input, 2);
    assert.ok(promo.daysRemaining >= 15);

    const std = getPricingPhaseStatus(new Date('2026-12-05T12:00:00Z'));
    assert.equal(std.phase, 'standard');
    assert.equal(std.isPostPromo, true);
    assert.equal(std.ratesPer1M.carbon.input, 4);
    assert.equal(std.daysRemaining, 0);

    const serverSrc = fs.readFileSync(path.join(ROOT_DIR, 'sidecars', 'panel', 'server.mjs'), 'utf8');
    assert.ok(serverSrc.includes('pricingPhase: getPricingPhaseStatus()'), 'server.mjs must expose pricingPhase');

    // 7. agents/router-verifier.md & packaging inclusion
    const agentPath = path.join(ROOT_DIR, 'agents', 'router-verifier.md');
    assert.equal(fs.existsSync(agentPath), true, 'agents/router-verifier.md must exist');
    const agentSrc = fs.readFileSync(agentPath, 'utf8');
    assert.ok(agentSrc.includes('name: router-verifier'));
    assert.ok(agentSrc.includes('subagent: true'));
    assert.ok(agentSrc.includes('mainAgent: false'));
    assert.ok(fs.readFileSync(path.join(ROOT_DIR, 'scripts', 'pack-release.mjs'), 'utf8').includes("'agents'"));
    assert.ok(fs.readFileSync(path.join(ROOT_DIR, 'install.js'), 'utf8').includes("'agents'"));

    // 8. activeSkills & ramSavedTokens tracking (hook + transcript + fresh reset)
    resetTaskProgress();
    initTaskProgressFromPrompt({
      conversationId: 'chat-ctx-pills',
      workspaceRoot: ROOT_DIR,
      userPrompt: 'Проектируем интерфейс',
      grade: 'M',
      brainDirs: [],
    });
    advanceTaskProgressOnPreTool({
      conversationId: 'chat-ctx-pills',
      workspaceRoot: ROOT_DIR,
      toolName: 'read_file',
      filePath: path.join(ROOT_DIR, 'skills', 'ui-ux-design-system', 'SKILL.md'),
      brainDirs: [],
    });
    advanceTaskProgressOnPreTool({
      conversationId: 'chat-ctx-pills',
      workspaceRoot: ROOT_DIR,
      toolName: 'mcp_antigravity-model-router_ram-memory_ram_slice',
      filePath: 'core/task-progress.mjs',
      brainDirs: [],
    });
    const ctxSnap = advanceTaskProgressOnPreTool({
      conversationId: 'chat-ctx-pills',
      workspaceRoot: ROOT_DIR,
      toolName: 'mcp_antigravity-model-router_ram-memory_gpu_distill',
      filePath: 'logs/build.log',
      brainDirs: [],
    });
    const ctxChat = ctxSnap.activeChats.find((c) => c.conversationId === 'chat-ctx-pills');
    assert.deepEqual(ctxChat.activeSkills, ['ui-ux-design-system']);
    assert.equal(ctxChat.ramSavedTokens, 1300);

    const resetCtxSnap = initTaskProgressFromPrompt({
      conversationId: 'chat-ctx-pills',
      workspaceRoot: ROOT_DIR,
      userPrompt: 'Совершенно новая задача без продолжения',
      grade: 'S',
      brainDirs: [],
    });
    const resetCtxChat = resetCtxSnap.activeChats.find((c) => c.conversationId === 'chat-ctx-pills');
    assert.deepEqual(resetCtxChat.activeSkills, []);
    assert.equal(resetCtxChat.ramSavedTokens, 0);

    const tCtxLog = path.join(tmpBrain, 'chat-unhooked-ctx', '.system_generated', 'logs', 'transcript.jsonl');
    fs.mkdirSync(path.dirname(tCtxLog), { recursive: true });
    fs.writeFileSync(
      tCtxLog,
      [
        JSON.stringify({ step_index: 1, type: 'USER_INPUT', created_at: '2026-11-15T00:05:00Z', content: 'Аудит модулей' }),
        JSON.stringify({
          step_index: 2,
          type: 'PLANNER_RESPONSE',
          created_at: '2026-11-15T00:05:02Z',
          tool_calls: [
            { name: 'read_file', args: { Path: path.join(ROOT_DIR, 'skills', 'deep-stress-auditor', 'SKILL.md') } },
            { name: 'ram_search', args: { query: 'checkInstalledPluginDrift' } },
          ],
        }),
      ].join('\n') + '\n',
      'utf8'
    );
    const tCtxSnap = getTaskProgressSnapshot({ workspaceRoot: ROOT_DIR, brainDirs: [tmpBrain] });
    const tCtxChat = tCtxSnap.activeChats.find((c) => c.conversationId === 'chat-unhooked-ctx');
    assert.deepEqual(tCtxChat.activeSkills, ['deep-stress-auditor']);
    assert.equal(tCtxChat.ramSavedTokens, 650);

    // 9. ui.html context pills & visibility animation pause contracts
    const uiHtml = fs.readFileSync(path.join(ROOT_DIR, 'sidecars', 'panel', 'ui.html'), 'utf8');
    assert.ok(uiHtml.includes('.ag-context-pills-row'), 'ui.html must define .ag-context-pills-row');
    assert.ok(uiHtml.includes('.ag-ctx-pill.is-ram'), 'ui.html must define .ag-ctx-pill.is-ram');
    assert.ok(uiHtml.includes('body.is-tab-hidden'), 'ui.html must define body.is-tab-hidden animation pause');
    assert.ok(uiHtml.includes('animation-play-state: paused'), 'ui.html must pause animations when tab hidden');
    assert.ok(uiHtml.includes('c.activeSkills'), 'ui.html must render activeSkills');
    assert.equal(/\bc\.ramSavedTokens\b/.test(uiHtml), false, 'ui.html must not render ramSavedTokens HUD pill');
    assert.ok(uiHtml.includes("document.body.classList.toggle('is-tab-hidden'"), 'ui.html must toggle is-tab-hidden');
    assert.equal(uiHtml.includes('toggleBlockEditBtn'), false, 'toggleBlockEditBtn must be removed for direct drag handles');
    assert.equal(uiHtml.includes('is-layout-editing'), false, 'is-layout-editing mode must be removed');
    const headHtmlSrc = fs.readFileSync(path.join(ROOT_DIR, 'sidecars', 'panel', 'ui-src', 'head-body.html'), 'utf8');
    assert.equal(headHtmlSrc.includes('data-role="drag-handle"'), false, 'drag handles must be removed in 7-category layout');
    assert.equal(uiHtml.includes('<details class="expert-spoiler"'), false, 'expert-spoiler containers must be removed in 7-category layout');
    assert.equal(/iosBlockJiggleA|iosBlockJiggleB/.test(uiHtml), false, 'jiggle wobble animation must be removed');

    // 10. Floating HUD dark theme (legacy studio_titanium falls back to dark) & compact mini-mode
    const hudFallback = buildWpfFloatingHudScript({ panelTheme: 'studio_titanium' });
    assert.ok(hudFallback.includes('#E81E202B'), 'HUD must stay dark even when legacy studio_titanium is passed');
    assert.ok(hudFallback.includes('Toggle-CompactHud'), 'HUD must include Toggle-CompactHud helper');
    assert.ok(hudFallback.includes('$window.Width = 156'), 'HUD mini-mode must toggle down to 156px');
    assert.ok(hudFallback.includes('compact = [bool]$script:isCompact'), 'HUD must persist compact flag');

    const hudDark = buildWpfFloatingHudScript({ panelTheme: 'glass_teal' });
    assert.ok(hudDark.includes('#E81E202B'), 'HUD dark theme must preserve dark capsule background');
  } finally {
    resetTaskProgress();
    clearPitfalls(tmpWs);
    fs.rmSync(tmpWs, { recursive: true, force: true });
    fs.rmSync(tmpDriftRepo, { recursive: true, force: true });
    fs.rmSync(tmpDriftInst, { recursive: true, force: true });
    fs.rmSync(tmpBrain, { recursive: true, force: true });
  }
});

test('32. Orchestrator Multi-Phase Continuity: exit_plan_mode, Stop handoff, Executor revival, Same-File Edit Coalescing & [plan review] Stage 2', async () => {
  const {
    MAX_PRE_EDIT_PERCENT,
    MAX_RUNNING_PERCENT,
    advanceTaskProgressOnPreTool,
    finalizeTaskProgressOnStop,
    getTaskProgressSnapshot,
    initTaskProgressFromPrompt,
    recordTaskProgressOnPostTool,
    resetTaskProgress,
  } = await import('../core/task-progress.mjs');

  resetTaskProgress();
  try {
    const cid = 'chat-orch-multi';
    // 1) Stage 1 Planner starts in Orchestrator mode -> ram_slice -> exit_plan_mode (6 steps)
    initTaskProgressFromPrompt({
      conversationId: cid,
      workspaceRoot: ROOT_DIR,
      userPrompt: 'Рефакторинг оркестратора в несколько этапов',
      grade: 'L',
      isOrchestratorMode: true,
      brainDirs: [],
    });
    advanceTaskProgressOnPreTool({
      conversationId: cid,
      workspaceRoot: ROOT_DIR,
      toolName: 'ram_slice',
      filePath: 'core/task-progress.mjs',
      brainDirs: [],
    });
    let snap = advanceTaskProgressOnPreTool({
      conversationId: cid,
      workspaceRoot: ROOT_DIR,
      toolName: 'exit_plan_mode',
      planText: [
        '1. Update constants',
        '2. Guard Stop hook',
        '3. Preserve plan review',
        '4. Update hook-runner',
        '5. Update ui.html',
        '6. Run test suite',
      ].join('\n'),
      brainDirs: [],
    });
    let chat = snap.activeChats.find((c) => c.conversationId === cid);
    assert.equal(chat.totalSteps, 6);
    assert.equal(chat.status, 'running');
    assert.ok(chat.percent <= MAX_PRE_EDIT_PERCENT, `Pre-edit exit_plan_mode % (${chat.percent}) must be <= ${MAX_PRE_EDIT_PERCENT}`);

    // 2) Planner Stop (TERMINAL_STEP_TYPE) must NOT prematurely mark 100% or sweep to idle after 4s
    snap = finalizeTaskProgressOnStop({
      conversationId: cid,
      workspaceRoot: ROOT_DIR,
      terminationReason: 'TERMINAL_STEP_TYPE',
      fullyIdle: true,
      brainDirs: [],
    });
    chat = snap.activeChats.find((c) => c.conversationId === cid);
    assert.equal(chat.status, 'running');
    assert.ok(chat.percent < 100, 'Planner handoff Stop must not jump to 100%');
    assert.equal(chat.totalSteps, 6);

    const holdSnap = getTaskProgressSnapshot({
      workspaceRoot: ROOT_DIR,
      brainDirs: [],
      now: Date.now() + 4000,
    });
    const holdChat = holdSnap.activeChats.find((c) => c.conversationId === cid);
    assert.ok(holdChat, 'Chat must remain visible during Planner->Executor handoff');
    assert.equal(holdChat.status, 'running');
    assert.equal(holdChat.totalSteps, 6);

    // 3) Stage 1 Executor runs edits (same file twice -> coalesced) -> another file -> test command
    snap = advanceTaskProgressOnPreTool({
      conversationId: cid,
      workspaceRoot: ROOT_DIR,
      toolName: 'edit_file',
      filePath: 'core/task-progress.mjs',
      brainDirs: [],
    });
    snap = recordTaskProgressOnPostTool({
      conversationId: cid,
      workspaceRoot: ROOT_DIR,
      toolName: 'edit_file',
      filePath: 'core/task-progress.mjs',
      verifyOk: true,
      brainDirs: [],
    });
    chat = snap.activeChats.find((c) => c.conversationId === cid);
    assert.equal(chat.totalSteps, 6, 'Executor must keep 6 plan steps instead of resetting to 3');
    const stepAfterFirstEdit = chat.currentStep;
    const pctAfterFirstEdit = chat.percent;

    snap = advanceTaskProgressOnPreTool({
      conversationId: cid,
      workspaceRoot: ROOT_DIR,
      toolName: 'edit_file',
      filePath: 'core/task-progress.mjs',
      brainDirs: [],
    });
    snap = recordTaskProgressOnPostTool({
      conversationId: cid,
      workspaceRoot: ROOT_DIR,
      toolName: 'edit_file',
      filePath: 'core/task-progress.mjs',
      verifyOk: true,
      brainDirs: [],
    });
    chat = snap.activeChats.find((c) => c.conversationId === cid);
    assert.equal(chat.currentStep, stepAfterFirstEdit, 'Repeated edits to same file must coalesce on plan step');

    snap = advanceTaskProgressOnPreTool({
      conversationId: cid,
      workspaceRoot: ROOT_DIR,
      toolName: 'edit_file',
      filePath: 'core/hook-runner.mjs',
      brainDirs: [],
    });
    snap = recordTaskProgressOnPostTool({
      conversationId: cid,
      workspaceRoot: ROOT_DIR,
      toolName: 'edit_file',
      filePath: 'core/hook-runner.mjs',
      verifyOk: true,
      brainDirs: [],
    });
    chat = snap.activeChats.find((c) => c.conversationId === cid);
    assert.ok(chat.percent >= pctAfterFirstEdit && chat.percent <= MAX_RUNNING_PERCENT);

    snap = advanceTaskProgressOnPreTool({
      conversationId: cid,
      workspaceRoot: ROOT_DIR,
      toolName: 'run_command',
      commandLine: 'node --test tests/router-core.test.mjs',
      brainDirs: [],
    });
    snap = recordTaskProgressOnPostTool({
      conversationId: cid,
      workspaceRoot: ROOT_DIR,
      toolName: 'run_command',
      commandLine: 'node --test tests/router-core.test.mjs',
      verifyOk: true,
      brainDirs: [],
    });
    chat = snap.activeChats.find((c) => c.conversationId === cid);
    assert.ok(chat.percent >= 90 && chat.percent <= MAX_RUNNING_PERCENT);

    // 4) Executor Stop -> Stage 2 [plan review] must resume seamlessly with 7 steps and 85..92%
    finalizeTaskProgressOnStop({
      conversationId: cid,
      workspaceRoot: ROOT_DIR,
      terminationReason: 'NO_TOOL_CALL',
      fullyIdle: true,
      brainDirs: [],
    });
    snap = initTaskProgressFromPrompt({
      conversationId: cid,
      workspaceRoot: ROOT_DIR,
      userPrompt: '[plan review] Executor finished Stage 1',
      isPlanReview: true,
      resumeIfWaiting: true,
      isReadOnlyQuestion: false,
      isOrchestratorMode: true,
      brainDirs: [],
    });
    chat = snap.activeChats.find((c) => c.conversationId === cid);
    assert.equal(chat.status, 'running');
    assert.equal(chat.totalSteps, 7, '[plan review] must append architect review step without collapsing timeline');
    assert.equal(chat.steps[6].title, 'Ревью этапа архитектором');
    assert.ok(chat.percent >= 85 && chat.percent <= MAX_RUNNING_PERCENT, `Plan review % (${chat.percent}) must remain 85..${MAX_RUNNING_PERCENT}`);

    // 5) Stage 2 exit_plan_mode appends 2 new steps (total 9, active step 8), Stop(TERMINAL_STEP_TYPE) preserves, final Stop marks 100%
    snap = advanceTaskProgressOnPreTool({
      conversationId: cid,
      workspaceRoot: ROOT_DIR,
      toolName: 'exit_plan_mode',
      planText: '1. Polish edge case\n2. Re-run suite',
      brainDirs: [],
    });
    chat = snap.activeChats.find((c) => c.conversationId === cid);
    assert.equal(chat.totalSteps, 9);
    assert.equal(chat.currentStep, 8);
    assert.equal(chat.steps[6].status, 'completed');

    snap = finalizeTaskProgressOnStop({
      conversationId: cid,
      workspaceRoot: ROOT_DIR,
      terminationReason: 'TERMINAL_STEP_TYPE',
      fullyIdle: true,
      brainDirs: [],
    });
    assert.equal(snap.activeChats.find((c) => c.conversationId === cid).status, 'running');

    // Stage 2 Executor runs verification command (clears pendingPlanHandoff)
    snap = advanceTaskProgressOnPreTool({
      conversationId: cid,
      workspaceRoot: ROOT_DIR,
      toolName: 'run_command',
      commandLine: 'node --test tests/router-core.test.mjs',
      brainDirs: [],
    });
    snap = recordTaskProgressOnPostTool({
      conversationId: cid,
      workspaceRoot: ROOT_DIR,
      toolName: 'run_command',
      commandLine: 'node --test tests/router-core.test.mjs',
      verifyOk: true,
      brainDirs: [],
    });

    snap = finalizeTaskProgressOnStop({
      conversationId: cid,
      workspaceRoot: ROOT_DIR,
      terminationReason: 'NO_TOOL_CALL',
      fullyIdle: true,
      brainDirs: [],
    });
    chat = snap.activeChats.find((c) => c.conversationId === cid);
    assert.equal(chat.status, 'completed');
    assert.equal(chat.percent, 100);
    assert.equal(chat.totalSteps, 9);
    assert.ok(chat.steps.every((s) => s.status === 'done'), 'All 9 steps must be marked done on final Stop');
  } finally {
    resetTaskProgress();
  }
});

test('32b. Background Task (task running) keeps progress running across Stop and resolves on finish/kill/restart', async () => {
  const {
    finalizeTaskProgressOnStop,
    getTaskProgressSnapshot,
    initTaskProgressFromPrompt,
    advanceTaskProgressOnPreTool,
    recordTaskProgressOnPostTool,
    inspectTranscriptTurnState,
    localizeProgressLabelToEn,
    markHostRestartAndReapActiveTasks,
    resetTaskProgress,
  } = await import('../core/task-progress.mjs');

  const prevTaskCacheEnv = process.env.TUNNEL_CACHE_DIR;
  const tmpTaskCache = makeTempDir('amr-t32b-cache-');
  const tmpBrain = makeTempDir('amr-t32b-brain-');
  process.env.TUNNEL_CACHE_DIR = tmpTaskCache;
  try {
    resetTaskProgress();
    const cid = 'chat-bg-1';
    const tPath = path.join(tmpBrain, cid, '.system_generated', 'logs', 'transcript.jsonl');
    fs.mkdirSync(path.dirname(tPath), { recursive: true });

    const lines = [
      JSON.stringify({ step_index: 1, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2026-11-24T17:00:00Z', content: '<USER_REQUEST>Запусти все тесты</USER_REQUEST>' }),
      JSON.stringify({
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        tool_calls: [{ name: 'run_command', args: { CommandLine: 'node --test tests/router-core.test.mjs' } }],
      }),
      JSON.stringify({
        step_index: 3,
        type: 'GENERIC',
        status: 'RUNNING',
        content: 'Tool is running as a background task with task id: chat-bg/task-1\nTask Description: node --test tests/router-core.test.mjs\nTask logs are available at: file:///tmp/task-1.log',
      }),
      JSON.stringify({
        step_index: 4,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        tool_calls: [],
        content: 'Запустил тесты в фоне, ожидаю завершения.',
      }),
    ];
    fs.writeFileSync(tPath, lines.join('\n') + '\n', 'utf8');

    const turnActive = inspectTranscriptTurnState(tPath);
    assert.equal(turnActive.state, 'running');
    assert.equal(turnActive.hasRunningBackgroundTask, true);
    assert.equal(turnActive.runningBackgroundTasks.length, 1);
    assert.ok(turnActive.backgroundTaskLabel.startsWith('Фон:'), `Expected Фон: label, got ${turnActive.backgroundTaskLabel}`);
    assert.ok(localizeProgressLabelToEn(turnActive.backgroundTaskLabel).startsWith('Background:'));

    initTaskProgressFromPrompt({
      conversationId: cid,
      workspaceRoot: ROOT_DIR,
      transcriptPath: tPath,
      userPrompt: 'Запусти все тесты',
      grade: 'M',
      isReadOnlyQuestion: false,
      brainDirs: [tmpBrain],
    });
    advanceTaskProgressOnPreTool({
      conversationId: cid,
      workspaceRoot: ROOT_DIR,
      transcriptPath: tPath,
      toolName: 'run_command',
      commandLine: 'node --test tests/router-core.test.mjs',
      brainDirs: [tmpBrain],
    });
    recordTaskProgressOnPostTool({
      conversationId: cid,
      workspaceRoot: ROOT_DIR,
      transcriptPath: tPath,
      toolName: 'run_command',
      commandLine: 'node --test tests/router-core.test.mjs',
      verifyOk: true,
      brainDirs: [tmpBrain],
    });

    let snap = finalizeTaskProgressOnStop({
      conversationId: cid,
      workspaceRoot: ROOT_DIR,
      transcriptPath: tPath,
      terminationReason: 'NO_TOOL_CALL',
      fullyIdle: true,
      brainDirs: [tmpBrain],
    });
    let chat = snap.activeChats.find((c) => c.conversationId === cid);
    assert.ok(chat, 'Chat with active background task must stay visible in activeChats');
    assert.equal(chat.status, 'running');
    assert.ok(chat.percent < 100, `Running background task must stay < 100%, got ${chat.percent}`);
    assert.equal(chat.hasRunningBackgroundTask, true);
    assert.equal(chat.backgroundTasksCount, 1);
    assert.ok(chat.stepTitle.startsWith('Фон:'));

    const holdSnap = getTaskProgressSnapshot({
      workspaceRoot: ROOT_DIR,
      brainDirs: [tmpBrain],
      now: Date.now() + 25000,
    });
    const holdChat = holdSnap.activeChats.find((c) => c.conversationId === cid);
    assert.ok(holdChat, 'Chat must not expire to idle after 25s while background task is running');
    assert.equal(holdChat.status, 'running');

    // Finish background task via SYSTEM notification + final planner reply
    fs.appendFileSync(
      tPath,
      [
        JSON.stringify({
          step_index: 5,
          source: 'SYSTEM',
          type: 'SYSTEM_MESSAGE',
          status: 'DONE',
          content: '[Message] sender=chat-bg/task-1 content=Task id "chat-bg/task-1" finished with result:\nCommand exited with code 0.',
        }),
        JSON.stringify({
          step_index: 6,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          tool_calls: [],
          content: 'Все тесты успешно прошли.',
        }),
      ].join('\n') + '\n',
      'utf8'
    );

    const turnDone = inspectTranscriptTurnState(tPath);
    assert.equal(turnDone.state, 'completed');
    assert.equal(turnDone.hasRunningBackgroundTask, false);
    assert.equal(turnDone.runningBackgroundTasks.length, 0);

    snap = finalizeTaskProgressOnStop({
      conversationId: cid,
      workspaceRoot: ROOT_DIR,
      transcriptPath: tPath,
      terminationReason: 'NO_TOOL_CALL',
      fullyIdle: true,
      brainDirs: [tmpBrain],
    });
    chat = snap.activeChats.find((c) => c.conversationId === cid);
    assert.equal(chat.status, 'completed');
    assert.equal(chat.percent, 100);
    assert.equal(chat.hasRunningBackgroundTask, false);

    // Verify cleanup via manage_task kill and server-restart system notice
    const killLog = path.join(tmpBrain, 'chat-bg-kill', '.system_generated', 'logs', 'transcript.jsonl');
    fs.mkdirSync(path.dirname(killLog), { recursive: true });
    fs.writeFileSync(
      killLog,
      [
        JSON.stringify({ step_index: 1, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: '<USER_REQUEST>Запусти сервер</USER_REQUEST>' }),
        JSON.stringify({
          step_index: 2,
          type: 'GENERIC',
          status: 'RUNNING',
          content: 'Tool is running as a background task with task id: chat-bg/task-2\nTask Description: npm start',
        }),
        JSON.stringify({
          step_index: 3,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          tool_calls: [{ name: 'manage_task', args: { Action: 'kill', TaskId: 'chat-bg/task-2' } }],
        }),
        JSON.stringify({
          step_index: 4,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          tool_calls: [],
          content: 'Остановил.',
        }),
      ].join('\n') + '\n',
      'utf8'
    );
    const killTurn = inspectTranscriptTurnState(killLog);
    assert.equal(killTurn.hasRunningBackgroundTask, false);
    assert.equal(killTurn.state, 'completed');

    const restartLog = path.join(tmpBrain, 'chat-bg-restart', '.system_generated', 'logs', 'transcript.jsonl');
    fs.mkdirSync(path.dirname(restartLog), { recursive: true });
    fs.writeFileSync(
      restartLog,
      [
        JSON.stringify({ step_index: 1, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: '<USER_REQUEST>Запусти сборку</USER_REQUEST>' }),
        JSON.stringify({
          step_index: 2,
          type: 'GENERIC',
          status: 'RUNNING',
          content: 'Tool is running as a background task with task id: chat-bg/task-3\nTask Description: npm run build',
        }),
        JSON.stringify({
          step_index: 3,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          tool_calls: [],
          content: 'Ожидаю сборки.',
        }),
        JSON.stringify({
          step_index: 4,
          source: 'SYSTEM',
          type: 'SYSTEM_MESSAGE',
          status: 'DONE',
          content: 'All your subagents and background tasks have been stopped because the language server restarted.',
        }),
      ].join('\n') + '\n',
      'utf8'
    );
    const restartTurn = inspectTranscriptTurnState(restartLog);
    assert.equal(restartTurn.hasRunningBackgroundTask, false);
    assert.equal(restartTurn.state, 'cancelled');
    assert.equal(restartTurn.backgroundTasks.length, 1);
    assert.equal(restartTurn.backgroundTasks[0].status, 'cancelled');

    // Verify full backgroundTasks history: running/done/error/cancelled, toolSummary pairing, task-*.log merge, redaction & UI markers
    const histCid = 'chat-bg-history';
    const histLog = path.join(tmpBrain, histCid, '.system_generated', 'logs', 'transcript.jsonl');
    const histTasksDir = path.join(tmpBrain, histCid, '.system_generated', 'tasks');
    fs.mkdirSync(path.dirname(histLog), { recursive: true });
    fs.mkdirSync(histTasksDir, { recursive: true });
    fs.writeFileSync(
      path.join(histTasksDir, 'task-orphan-log.log'),
      'Command: npm run lint\nAll checks passed.\nCommand exited with code 0.\n',
      'utf8'
    );
    const fakeOpenAiKey = ['sk', 'proj', 'abcdefghijklmnopqrstuvwxyz12345'].join('-');
    const histLines = [
      JSON.stringify({ step_index: 1, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2026-11-24T18:00:00Z', content: 'Запусти несколько фоновых задач' }),
      JSON.stringify({
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-24T18:00:01Z',
        tool_calls: [{ name: 'run_command', args: { CommandLine: `curl -H "Authorization: Bearer ${fakeOpenAiKey}" http://localhost:8765`, toolSummary: 'Проверка сервера мониторинга', IsDaemon: true } }],
      }),
      JSON.stringify({
        step_index: 3,
        type: 'GENERIC',
        created_at: '2026-11-24T18:00:02Z',
        content: `Tool is running as a background task with task id: bg-run-1\nTask Description: curl -H "Authorization: Bearer ${fakeOpenAiKey}" http://localhost:8765`,
      }),
      JSON.stringify({
        step_index: 4,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-24T18:00:03Z',
        tool_calls: [{ name: 'run_command', args: { CommandLine: 'node broken.mjs', toolSummary: 'Упавший скрипт' } }],
      }),
      JSON.stringify({
        step_index: 5,
        type: 'GENERIC',
        created_at: '2026-11-24T18:00:04Z',
        content: 'Tool is running as a background task with task id: bg-err-1\nTask Description: node broken.mjs',
      }),
      JSON.stringify({
        step_index: 6,
        source: 'SYSTEM',
        type: 'SYSTEM_MESSAGE',
        created_at: '2026-11-24T18:00:05Z',
        content: '[Message] sender=bg-err-1 content=Task id "bg-err-1" failed with error: exit code 1',
      }),
      JSON.stringify({
        step_index: 7,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-24T18:00:06Z',
        tool_calls: [{ name: 'manage_task', args: { Action: 'kill', TaskId: 'bg-cancel-1' } }],
      }),
    ];
    for (let k = 1; k <= 26; k++) {
      histLines.push(JSON.stringify({
        step_index: 10 + k,
        type: 'GENERIC',
        created_at: `2026-11-24T17:58:${String(k).padStart(2, '0')}Z`,
        content: `Tool is running as a background task with task id: bg-done-${k}\nTask Description: echo job-${k}\nTask: bg-done-${k} Status: COMPLETED`,
      }));
    }
    histLines.push(JSON.stringify({
      step_index: 40,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      tool_calls: [],
      content: 'Монитор работает в фоне.',
    }));
    fs.writeFileSync(histLog, histLines.join('\n') + '\n', 'utf8');

    const histTurn = inspectTranscriptTurnState(histLog);
    assert.equal(histTurn.hasRunningBackgroundTask, true);
    assert.equal(histTurn.backgroundTasksTotalCount, 30);
    assert.equal(histTurn.backgroundTasks.length, 25, 'backgroundTasks must cap at 25 entries');
    assert.equal(histTurn.backgroundTasks[0].taskId, 'bg-run-1', 'Running task must sort first');
    assert.equal(histTurn.backgroundTasks[0].label, 'Проверка сервера мониторинга');
    assert.equal(histTurn.backgroundTasks[0].isDaemon, true);
    assert.ok(!histTurn.backgroundTasks[0].commandPreview.includes(['sk', 'proj', ''].join('-')), 'Secret token must be redacted');
    assert.equal(Object.hasOwn(histTurn.backgroundTasks[0], 'logPath'), false, 'Raw logPath must not be exposed');
    assert.ok(histTurn.backgroundTasks.some((t) => t.taskId === 'bg-err-1' && t.status === 'error'));
    assert.ok(histTurn.backgroundTasks.some((t) => t.taskId === 'bg-cancel-1' && t.status === 'cancelled'));
    assert.ok(histTurn.backgroundTasks.some((t) => t.taskId === 'orphan-log' && t.status === 'done'));

    const histSnap = getTaskProgressSnapshot({
      workspaceRoot: ROOT_DIR,
      brainDirs: [tmpBrain],
      now: Date.now() + 500,
    });
    const histChat = histSnap.activeChats.find((c) => c.conversationId === histCid);
    assert.ok(histChat, 'History chat with running background task must appear in activeChats');
    assert.ok(histChat.backgroundTasks.some((t) => t.taskId === 'bg-run-1' && t.status === 'running'));
    assert.ok(histChat.backgroundTasks.some((t) => t.taskId === 'orphan-log' && t.status === 'done'), 'Just-finished task stays visible inside completedHoldMs');
    assert.equal(histChat.backgroundTasks.some((t) => t.taskId === 'bg-done-1'), false, 'Old finished tasks must auto-hide');
    assert.equal(histChat.backgroundTasks.some((t) => t.taskId === 'bg-err-1'), false, 'Old error tasks must auto-hide');
    assert.equal(histChat.backgroundTasks.some((t) => t.taskId === 'bg-cancel-1'), false, 'Old cancelled tasks must auto-hide');

    // After completedHoldMs (2.8s) elapses, finished task disappears leaving only running task
    const histFadeSnap = getTaskProgressSnapshot({
      workspaceRoot: ROOT_DIR,
      brainDirs: [tmpBrain],
      now: Date.now() + 5000,
    });
    const histFadeChat = histFadeSnap.activeChats.find((c) => c.conversationId === histCid);
    assert.ok(histFadeChat);
    assert.equal(histFadeChat.backgroundTasks.length, 1);
    assert.equal(histFadeChat.backgroundTasksTotalCount, 1);
    assert.equal(histFadeChat.backgroundTasks[0].taskId, 'bg-run-1');

    const uiHtml = fs.readFileSync(path.join(ROOT_DIR, 'sidecars', 'panel', 'ui.html'), 'utf8');
    assert.ok(uiHtml.includes("case 'toggleBgTasksList':"), 'Missing toggleBgTasksList dispatcher case');
    assert.ok(uiHtml.includes("case 'toggleBgTasksShowAll':"), 'Missing toggleBgTasksShowAll dispatcher case');
    assert.ok(uiHtml.includes('ag-bgtask-toggle-btn'), 'Missing cyan background tasks toggle button class');
    assert.ok(uiHtml.includes('ag-bgtasks-drawer'), 'Missing collapsible background tasks drawer');

    // Regression 1: False-positive code slice / ram_slice output must NOT spawn background tasks
    const fpLog = path.join(tmpBrain, 'chat-bg-fp', '.system_generated', 'logs', 'transcript.jsonl');
    fs.mkdirSync(path.dirname(fpLog), { recursive: true });
    fs.writeFileSync(
      fpLog,
      [
        JSON.stringify({ step_index: 1, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'Проверь тесты' }),
        JSON.stringify({
          step_index: 2,
          type: 'GENERIC',
          status: 'DONE',
          content: "Created At: 2026-11-25T03:00:00+03:00\nCompleted At: 2026-11-25T03:00:01+03:00\n// [RAM Lines 4620-4670/8917] tests/router-core.test.mjs\nL4635: content: 'Tool is running as a background task with task id: chat-bg/task-3\\nTask Description: npm run build',",
        }),
        JSON.stringify({
          step_index: 3,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          tool_calls: [],
          content: 'Готово.',
        }),
      ].join('\n') + '\n',
      'utf8'
    );
    const fpTurn = inspectTranscriptTurnState(fpLog);
    assert.equal(fpTurn.hasRunningBackgroundTask, false, 'ram_slice snippet must not create running background task');
    assert.equal(fpTurn.backgroundTasks.length, 0);
    assert.equal(fpTurn.state, 'completed');

    // Regression 2: Quoted toolSummary unwrapping & sync run_command isolation
    const quoteLog = path.join(tmpBrain, 'chat-bg-quotes', '.system_generated', 'logs', 'transcript.jsonl');
    fs.mkdirSync(path.dirname(quoteLog), { recursive: true });
    fs.writeFileSync(
      quoteLog,
      [
        JSON.stringify({ step_index: 1, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'Собери и проверь' }),
        JSON.stringify({
          step_index: 2,
          type: 'PLANNER_RESPONSE',
          tool_calls: [{ name: 'run_command', args: { CommandLine: '"node scripts/build-panel-ui.mjs"', toolSummary: '"Сборка UI"' } }],
        }),
        JSON.stringify({
          step_index: 3,
          type: 'GENERIC',
          status: 'DONE',
          content: 'Created At: 2026-11-25T03:01:00+03:00\nCompleted At: 2026-11-25T03:01:01+03:00\nCommand exited with code 0.\n\nCommand output:\n[✓] ui.html собран',
        }),
        JSON.stringify({
          step_index: 4,
          type: 'PLANNER_RESPONSE',
          tool_calls: [{ name: 'run_command', args: { CommandLine: '"node --test tests/router-core.test.mjs"', toolSummary: '"Прогон тестов"' } }],
        }),
        JSON.stringify({
          step_index: 5,
          type: 'GENERIC',
          status: 'RUNNING',
          content: 'Created At: 2026-11-25T03:01:05+03:00\nTool is running as a background task with task id: real-bg-1\nTask Description: node --test tests/router-core.test.mjs',
        }),
      ].join('\n') + '\n',
      'utf8'
    );
    const quoteTurn = inspectTranscriptTurnState(quoteLog);
    assert.equal(quoteTurn.hasRunningBackgroundTask, true);
    assert.equal(quoteTurn.backgroundTasks.length, 1);
    assert.equal(quoteTurn.backgroundTasks[0].label, 'Прогон тестов');

    // Regression 3: Host restart reaping closes pre-restart chat & marks running tasks cancelled on resume
    const reapCid = 'chat-bg-reap';
    const reapLog = path.join(tmpBrain, reapCid, '.system_generated', 'logs', 'transcript.jsonl');
    fs.mkdirSync(path.dirname(reapLog), { recursive: true });
    const preBootIso = new Date(Date.now() - 20000).toISOString();
    fs.writeFileSync(
      reapLog,
      [
        JSON.stringify({ step_index: 1, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: preBootIso, content: 'Запусти сервер' }),
        JSON.stringify({
          step_index: 2,
          type: 'PLANNER_RESPONSE',
          created_at: preBootIso,
          tool_calls: [{ name: 'run_command', args: { CommandLine: '"node server.mjs"', toolSummary: '"Старт сервера"' } }],
        }),
        JSON.stringify({
          step_index: 3,
          type: 'GENERIC',
          status: 'RUNNING',
          created_at: preBootIso,
          content: 'Tool is running as a background task with task id: reap-task-1\nTask Description: node server.mjs',
        }),
      ].join('\n') + '\n',
      'utf8'
    );
    const preBootMtime = new Date(Date.now() - 15000);
    fs.utimesSync(reapLog, preBootMtime, preBootMtime);

    initTaskProgressFromPrompt({
      conversationId: reapCid,
      workspaceRoot: ROOT_DIR,
      transcriptPath: reapLog,
      userPrompt: 'Запусти сервер',
      grade: 'M',
      brainDirs: [tmpBrain],
    });
    await new Promise((r) => setTimeout(r, 25));
    const bootAt = Date.now();
    markHostRestartAndReapActiveTasks({ bootAt, brainDirs: [tmpBrain] });

    const reapedSnap = getTaskProgressSnapshot({
      workspaceRoot: ROOT_DIR,
      brainDirs: [tmpBrain],
      now: Date.now(),
    });
    assert.equal(reapedSnap.activeChats.some((c) => c.conversationId === reapCid), false, 'Pre-restart chat must stay closed after restart');

    // Resuming chat after restart shows pre-restart background task as cancelled
    await new Promise((r) => setTimeout(r, 25));
    const postBootIso = new Date(Date.now()).toISOString();
    fs.appendFileSync(
      reapLog,
      [
        JSON.stringify({ step_index: 4, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: postBootIso, content: 'Продолжи' }),
        JSON.stringify({ step_index: 5, type: 'PLANNER_RESPONSE', created_at: postBootIso, tool_calls: [{ name: 'read_file', args: { Path: 'package.json' } }] }),
      ].join('\n') + '\n',
      'utf8'
    );
    const resumedSnap = getTaskProgressSnapshot({
      workspaceRoot: ROOT_DIR,
      brainDirs: [tmpBrain],
      now: Date.now() + 100,
    });
    const resumedChat = resumedSnap.activeChats.find((c) => c.conversationId === reapCid);
    assert.ok(resumedChat, 'Resumed chat must reappear in activeChats');
    assert.equal(resumedChat.hasRunningBackgroundTask, false);
    assert.equal(resumedChat.backgroundTasks.length, 0, 'Expired pre-restart cancelled tasks must stay hidden from live capsule');
    assert.equal(resumedChat.backgroundTasksTotalCount, 0);
    const reapTurn = inspectTranscriptTurnState(reapLog, Date.now(), { hostBootAt: bootAt });
    assert.ok(reapTurn.backgroundTasks.some((t) => t.taskId === 'reap-task-1' && t.status === 'cancelled'));
  } finally {
    resetTaskProgress();
    if (prevTaskCacheEnv === undefined) delete process.env.TUNNEL_CACHE_DIR;
    else process.env.TUNNEL_CACHE_DIR = prevTaskCacheEnv;
    fs.rmSync(tmpTaskCache, { recursive: true, force: true });
    fs.rmSync(tmpBrain, { recursive: true, force: true });
  }
});

test('32b. Hybrid background task progress parser & duration history ETA estimator', async () => {
  const { extractBgProgressFromLogTail, inspectTranscriptTurnState } = await import('../core/progress/progress-parsers.mjs');
  const {
    normalizeBgCommandSignature,
    recordBgTaskDurationSample,
    estimateBgTaskProgressFromHistory,
    filterVisibleBackgroundTasks,
  } = await import('../core/task-progress.mjs');

  // 1. Log tail percentage, fractions, ANSI/CR stripping, secret redaction, and date exclusion
  const pctRes = extractBgProgressFromLogTail('\u001b[32mDownloading\u001b[0m 12%\r\u001b[32mDownloading\u001b[0m 68.4% sk-proj-supersecret1234567890'); // synthetic fixture
  assert.equal(pctRes.progressPct, 68);
  assert.ok(!pctRes.progressText.includes('sk-proj-supersecret'), 'Secrets in progressText must be redacted');

  const fracBracket = extractBgProgressFromLogTail('[12/40] Compiling modules');
  assert.equal(fracBracket.progressPct, 30);
  assert.equal(fracBracket.progressText, '[12/40] Compiling modules');

  const fracStep = extractBgProgressFromLogTail('Step 3 of 10: verifying');
  assert.equal(fracStep.progressPct, 30);

  const dateOnly = extractBgProgressFromLogTail('[11/26/2026] Server started cleanly');
  assert.equal(dateOnly.progressPct, null, 'Calendar dates must not be misparsed as progress fractions');
  assert.equal(dateOnly.progressText, '[11/26/2026] Server started cleanly');

  // 2. Transcript + task-*.log integration for determinate running task + ETA
  const tmpDir = makeTempDir('amr-bg-prog-');
  const prevCacheEnv = process.env.TUNNEL_CACHE_DIR;
  process.env.TUNNEL_CACHE_DIR = path.join(tmpDir, 'cache');
  try {
    const cid = 'chat-bg-det';
    const chatDir = path.join(tmpDir, cid);
    const logPath = path.join(chatDir, '.system_generated', 'logs', 'transcript.jsonl');
    const tasksDir = path.join(chatDir, '.system_generated', 'tasks');
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.mkdirSync(tasksDir, { recursive: true });

    const now = Date.now();
    const startedIso = new Date(now - 20_000).toISOString();
    fs.writeFileSync(
      logPath,
      [
        JSON.stringify({ step_index: 1, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: startedIso, content: 'Run tests' }),
        JSON.stringify({
          step_index: 2,
          type: 'PLANNER_RESPONSE',
          created_at: startedIso,
          tool_calls: [{ name: 'run_command', args: { CommandLine: 'node --test tests/sample.test.mjs', toolSummary: 'Прогон тестов' } }],
        }),
        JSON.stringify({
          step_index: 3,
          type: 'GENERIC',
          status: 'RUNNING',
          created_at: startedIso,
          content: 'Tool is running as a background task with task id: det-task-1\nTask Description: node --test tests/sample.test.mjs',
        }),
      ].join('\n') + '\n',
      'utf8'
    );
    fs.writeFileSync(path.join(tasksDir, 'task-det-task-1.log'), 'Running suite...\n[8/20] Running unit case\n', 'utf8');

    const turn = inspectTranscriptTurnState(logPath, now);
    const detTask = turn.backgroundTasks.find((t) => t.taskId === 'det-task-1');
    assert.ok(detTask, 'Determinate task must be present');
    assert.equal(detTask.progressMode, 'determinate');
    assert.equal(detTask.progressPct, 40);
    assert.ok(detTask.etaSec > 0 && detTask.etaSec < 120, `Expected positive ETA, got ${detTask.etaSec}`);
    assert.equal(detTask.progressText, '[8/20] Running unit case');

    // 3. History duration cache & estimated mode (daemon stays indeterminate)
    assert.equal(normalizeBgCommandSignature('"node --test tests/unit.test.mjs"', ''), 'node --test tests/unit.test.mjs');
    const cacheFile = path.join(tmpDir, 'cache', 'bg-task-durations.json');
    const recorded = recordBgTaskDurationSample(
      {
        taskId: 'hist-done-1',
        commandPreview: 'npm run build',
        label: 'Сборка',
        status: 'done',
        isDaemon: false,
        startedAt: now - 30_000,
        updatedAt: now - 10_000,
      },
      { cacheFile, now }
    );
    assert.equal(recorded, true);
    // Duplicate taskId must not rewrite/double-count
    assert.equal(
      recordBgTaskDurationSample(
        {
          taskId: 'hist-done-1',
          commandPreview: 'npm run build',
          label: 'Сборка',
          status: 'done',
          isDaemon: false,
          startedAt: now - 30_000,
          updatedAt: now - 10_000,
        },
        { cacheFile, now }
      ),
      false
    );

    const est = estimateBgTaskProgressFromHistory(
      {
        taskId: 'hist-run-2',
        commandPreview: 'npm run build',
        label: 'Сборка',
        status: 'running',
        isDaemon: false,
        startedAt: now - 10_000,
      },
      now,
      { cacheFile }
    );
    assert.ok(est);
    assert.equal(est.progressMode, 'estimated');
    assert.ok(est.progressPct >= 4 && est.progressPct <= 92);
    assert.equal(est.etaSec, 10);

    // Overrun caps below 98% with null etaSec
    const estOver = estimateBgTaskProgressFromHistory(
      {
        taskId: 'hist-run-3',
        commandPreview: 'npm run build',
        label: 'Сборка',
        status: 'running',
        isDaemon: false,
        startedAt: now - 25_000,
      },
      now,
      { cacheFile }
    );
    assert.ok(estOver && estOver.progressPct >= 92 && estOver.progressPct <= 97);
    assert.equal(estOver.etaSec, null);

    // filterVisibleBackgroundTasks applies history estimate automatically and keeps daemon indeterminate
    const vis = filterVisibleBackgroundTasks(
      [
        {
          taskId: 'hist-live-1',
          commandPreview: 'npm run build',
          label: 'Сборка',
          status: 'running',
          isDaemon: false,
          startedAt: now - 10_000,
          updatedAt: now - 1_000,
        },
        {
          taskId: 'daemon-live-1',
          commandPreview: 'npm run build',
          label: 'Сервер',
          status: 'running',
          isDaemon: true,
          startedAt: now - 10_000,
          updatedAt: now - 1_000,
        },
      ],
      { now }
    );
    assert.equal(vis[0].progressMode, 'estimated');
    assert.ok(vis[0].progressPct >= 4 && vis[0].progressPct <= 92);
    assert.equal(vis[1].progressMode, 'indeterminate');
    assert.equal(vis[1].progressPct, null);
  } finally {
    if (prevCacheEnv === undefined) delete process.env.TUNNEL_CACHE_DIR;
    else process.env.TUNNEL_CACHE_DIR = prevCacheEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('55. Native Swarm Worker Lifecycle: board brief @name detection, swarm_wait completion, kill & object matchedFiles', async () => {
  const { inspectSubagentTranscriptMeta } = await import('../core/model-profile.mjs');
  const {
    advanceTaskProgressOnPreTool,
    getTaskProgressSnapshot,
    initTaskProgressFromPrompt,
    resetTaskProgress,
  } = await import('../core/task-progress.mjs');

  const tmpBrain = makeTempDir('amr-swarm-lifecycle-');
  resetTaskProgress();
  try {
    const writeTranscript = (cid, lines) => {
      const p = path.join(tmpBrain, cid, '.system_generated', 'logs', 'transcript.jsonl');
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, lines.map((obj) => JSON.stringify(obj)).join('\n') + '\n', 'utf8');
      return p;
    };

    const coordCid = '08632007-38fd-4fbb-ad41-6e151cad6567';
    const wSkillsCid = '0db3c722-0c99-46cd-9339-dc81af69400f';
    const wPanelCid = 'd97cf607-4f6d-46d7-9f73-4fcf01d0972d';
    const wVerifierCid = 'dafb8fb4-768c-4cc3-8dd9-41b959dbcf66';

    const coordPath = writeTranscript(coordCid, [
      { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: '<USER_REQUEST>Проведи сквозную ревизию</USER_REQUEST>' },
      {
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        tool_calls: [
          { name: 'swarm', args: { action: 'add', name: 'skills-scripts', workspace: 'share' } },
          { name: 'swarm', args: { action: 'add', name: 'panel-ui', workspace: 'share' } },
          { name: 'swarm', args: { action: 'add', name: 'verifier', workspace: 'inherit' } },
        ],
      },
      {
        step_index: 2,
        source: 'MODEL',
        type: 'GENERIC',
        status: 'DONE',
        content: `{"status":"added","name":"skills-scripts","conversation_id":"${wSkillsCid}"}`,
      },
      {
        step_index: 3,
        source: 'MODEL',
        type: 'GENERIC',
        status: 'DONE',
        content: `{"status":"added","name":"panel-ui","conversation_id":"${wPanelCid}"}`,
      },
      {
        step_index: 4,
        source: 'MODEL',
        type: 'GENERIC',
        status: 'DONE',
        content: `{"status":"added","name":"verifier","conversation_id":"${wVerifierCid}"}`,
      },
    ]);

    // Worker 1: step 0 board notification came from another worker, step 1 brief carries true coordinator sender & @panel-ui
    const wPanelPath = writeTranscript(wPanelCid, [
      {
        step_index: 0,
        source: 'SYSTEM',
        type: 'SYSTEM_MESSAGE',
        content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-17T14:11:08Z sender=${wSkillsCid} priority=MESSAGE_PRIORITY_HIGH content=[swarm] new board message #2\n</SYSTEM_MESSAGE>`,
      },
      {
        step_index: 1,
        source: 'SYSTEM',
        type: 'SYSTEM_MESSAGE',
        content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-17T14:11:08Z sender=${coordCid} priority=MESSAGE_PRIORITY_HIGH content=You have just started. Your assignment (recorded on the board as #2 for @panel-ui):\nAudit UI.\n</SYSTEM_MESSAGE>`,
      },
      {
        step_index: 2,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        tool_calls: [{ name: 'read_file', args: { Path: 'sidecars/panel/ui.html' } }],
      },
    ]);

    const panelMeta = inspectSubagentTranscriptMeta(wPanelPath);
    assert.equal(panelMeta.isSubagent, true);
    assert.equal(panelMeta.agentKind, 'swarm_worker');
    assert.equal(panelMeta.agentHint, 'panel-ui');
    assert.equal(panelMeta.parentConversationId, coordCid);

    // Worker 2: starts with read_file, then finishes its round and parks via post_message + swarm_wait
    const wSkillsPath = writeTranscript(wSkillsCid, [
      {
        step_index: 0,
        source: 'SYSTEM',
        type: 'SYSTEM_MESSAGE',
        content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-17T14:11:06Z sender=${coordCid} content=[swarm] new board message #1\n</SYSTEM_MESSAGE>`,
      },
      {
        step_index: 1,
        source: 'SYSTEM',
        type: 'SYSTEM_MESSAGE',
        content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-17T14:11:06Z sender=${coordCid} content=You have just started. Your assignment (recorded on the board as #1 for @skills-scripts):\nAudit skills.\n</SYSTEM_MESSAGE>`,
      },
      {
        step_index: 2,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        tool_calls: [{ name: 'read_file', args: { Path: 'install.js' } }],
      },
    ]);

    // Worker 3: verifier still actively reading files
    writeTranscript(wVerifierCid, [
      {
        step_index: 0,
        source: 'SYSTEM',
        type: 'SYSTEM_MESSAGE',
        content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-17T14:11:14Z sender=${coordCid} content=You have just started. Your assignment (recorded on the board as #5 for @verifier):\nVerify all contours.\n</SYSTEM_MESSAGE>`,
      },
      {
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        tool_calls: [{ name: 'read_file', args: { Path: 'core/ram-memory-engine.mjs' } }],
      },
    ]);

    // Pass object entries in matchedFiles to ensure "[object Object]" never leaks into step titles
    const initRes = initTaskProgressFromPrompt({
      conversationId: coordCid,
      workspaceRoot: ROOT_DIR,
      transcriptPath: coordPath,
      userPrompt: 'Проведи сквозную ревизию',
      grade: 'XL',
      matchedFiles: [{ relPath: 'core/task-progress.mjs', lines: 3600 }, { filePath: 'core/model-profile.mjs' }],
      brainDirs: [tmpBrain],
    });
    assert.equal(
      initRes.steps.some((s) => String(s.title || '').includes('[object') || String(s.fullTitle || '').includes('[object')),
      false,
      'Object items in matchedFiles must never serialize to [object Object]'
    );

    const t0 = Date.now();
    // Simulate PreToolUse inside a worktree path while wSkillsCid is actively reading install.js
    advanceTaskProgressOnPreTool({
      conversationId: wSkillsCid,
      workspaceRoot: `C:\\Users\\dev\\.gemini\\antigravity\\worktrees\\${coordCid}\\swarm-skills-scripts-b1e5f999`,
      toolName: 'read_file',
      filePath: 'install.js',
      swarmRole: 'swarm_worker',
      swarmWorkerKind: 'author',
      brainDirs: [tmpBrain],
    });

    // Now wSkillsCid posts its audit report and parks on swarm_wait
    fs.appendFileSync(
      wSkillsPath,
      [
        {
          step_index: 3,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          tool_calls: [
            { name: 'post_message', args: { text: '@verifier Contour 1 report' } },
            { name: 'swarm_wait', args: { since: '6', mentions_only: 'true' } },
          ],
        },
        { step_index: 4, source: 'MODEL', type: 'GENERIC', status: 'DONE', content: '{"status":"posted","seq":7}' },
        {
          step_index: 5,
          source: 'MODEL',
          type: 'GENERIC',
          status: 'DONE',
          content: 'Waiting for a message that calls on you by name, or on @all posted after #7.',
        },
      ]
        .map((obj) => JSON.stringify(obj))
        .join('\n') + '\n',
      'utf8'
    );

    // First snapshot: wSkillsCid parked on swarm_wait -> transitions to completed (100%), while wPanelCid & wVerifierCid run
    const snap1 = getTaskProgressSnapshot({
      workspaceRoot: ROOT_DIR,
      brainDirs: [tmpBrain],
      now: t0 + 500,
    });
    const mainChat1 = snap1.activeChats.find((c) => c.conversationId === coordCid);
    assert.ok(mainChat1);
    const subSkills1 = mainChat1.subagents.find((s) => s.conversationId === wSkillsCid);
    const subPanel1 = mainChat1.subagents.find((s) => s.conversationId === wPanelCid);
    const subVerif1 = mainChat1.subagents.find((s) => s.conversationId === wVerifierCid);
    assert.ok(subSkills1 && subPanel1 && subVerif1);
    assert.equal(subSkills1.status, 'completed', 'Worker parked on swarm_wait must transition to completed');
    assert.equal(subSkills1.percent, 100);
    assert.equal(subSkills1.projectName, path.basename(ROOT_DIR), 'Worktree path must inherit parent project name');
    assert.match(subSkills1.displayHeader, /^Рой #\d+ · skills-scripts$/);
    assert.match(subPanel1.displayHeader, /^Рой #\d+ · panel-ui$/);
    assert.equal(subPanel1.status, 'running');
    assert.equal(subVerif1.status, 'running');
    assert.equal(mainChat1.runningSubagentsCount, 2);

    // Coordinator kills panel-ui explicitly; after hold window, both skills-scripts and panel-ui clear out
    fs.appendFileSync(
      coordPath,
      JSON.stringify({
        step_index: 5,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        tool_calls: [{ name: 'swarm', args: { action: 'kill', name: 'panel-ui' } }],
      }) + '\n',
      'utf8'
    );

    const snap2 = getTaskProgressSnapshot({
      workspaceRoot: ROOT_DIR,
      brainDirs: [tmpBrain],
      now: t0 + 4000,
    });
    const mainChat2 = snap2.activeChats.find((c) => c.conversationId === coordCid);
    assert.ok(mainChat2);
    assert.equal(mainChat2.subagents.some((s) => s.conversationId === wSkillsCid), false, 'Parked worker must hide after hold');
    const subPanel2 = mainChat2.subagents.find((s) => s.conversationId === wPanelCid);
    assert.equal(subPanel2?.status, 'completed', 'Killed worker must transition to completed');

    const snap3 = getTaskProgressSnapshot({
      workspaceRoot: ROOT_DIR,
      brainDirs: [tmpBrain],
      now: t0 + 8000,
    });
    const mainChat3 = snap3.activeChats.find((c) => c.conversationId === coordCid);
    assert.ok(mainChat3);
    assert.equal(mainChat3.subagents.length, 1, 'Only actively working verifier should remain visible');
    assert.equal(mainChat3.subagents[0].conversationId, wVerifierCid);
    assert.equal(mainChat3.runningSubagentsCount, 1);
  } finally {
    resetTaskProgress();
    fs.rmSync(tmpBrain, { recursive: true, force: true });
  }
});

test('43. Stale Zombie Chat Cleanup: non-post-hook read_file clears inFlightTool and stale inFlight chats reap cleanly', async () => {
  const {
    advanceTaskProgressOnPreTool,
    getTaskProgressSnapshot,
    initTaskProgressFromPrompt,
    resetTaskProgress,
  } = await import('../core/task-progress.mjs');

  const tmpBrain = makeTempDir('amr-stale-zombie-');
  resetTaskProgress();
  try {
    // 1) read_file does not trigger PostToolUse in hooks.json, so it must NOT hold inFlightTool=true
    const readCid = 'chat-zombie-read';
    const readLog = path.join(tmpBrain, readCid, '.system_generated', 'logs', 'transcript.jsonl');
    fs.mkdirSync(path.dirname(readLog), { recursive: true });
    fs.writeFileSync(
      readLog,
      [
        JSON.stringify({ step_index: 1, type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-17T19:57:39Z', content: 'Проверь тест' }),
        JSON.stringify({ step_index: 2, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-17T19:57:40Z', tool_calls: [{ name: 'read_file', args: { Path: 'tests/v320-mechanics.test.mjs' } }] }),
        JSON.stringify({ step_index: 3, type: 'GENERIC', status: 'DONE', created_at: '2026-11-17T19:57:45Z', content: 'Read completed' }),
      ].join('\n') + '\n',
      'utf8'
    );

    initTaskProgressFromPrompt({
      conversationId: readCid,
      workspaceRoot: ROOT_DIR,
      transcriptPath: readLog,
      userPrompt: 'Проверь тест',
      grade: 'S',
      brainDirs: [tmpBrain],
    });
    const afterRead = advanceTaskProgressOnPreTool({
      conversationId: readCid,
      workspaceRoot: ROOT_DIR,
      transcriptPath: readLog,
      toolName: 'read_file',
      filePath: 'tests/v320-mechanics.test.mjs',
      brainDirs: [tmpBrain],
    });
    assert.equal(afterRead.chats[readCid].inFlightTool, false, 'read_file has no PostToolUse hook and must not stick inFlightTool=true');

    // 2) Simulate a legacy zombie entry stuck with inFlightTool=true (no inFlightToolName) + a genuinely running run_command
    const cmdCid = 'chat-live-cmd';
    initTaskProgressFromPrompt({
      conversationId: cmdCid,
      workspaceRoot: ROOT_DIR,
      userPrompt: 'Прогони тесты',
      grade: 'M',
      brainDirs: [tmpBrain],
    });
    advanceTaskProgressOnPreTool({
      conversationId: cmdCid,
      workspaceRoot: ROOT_DIR,
      toolName: 'run_command',
      commandLine: 'node --test',
      brainDirs: [tmpBrain],
    });

    const now = Date.now();
    const rawOnDisk = JSON.parse(fs.readFileSync(TASK_PROGRESS_FILE, 'utf8'));
    rawOnDisk.chats[readCid].inFlightTool = true;
    rawOnDisk.chats[readCid].inFlightToolName = '';
    rawOnDisk.chats[readCid].updatedAt = now - 5 * 60 * 1000; // 5m silent > 4m STALE_RUNNING_TTL_MS
    rawOnDisk.chats[cmdCid].updatedAt = now - 5 * 60 * 1000; // 5m < 8m STALE_IN_FLIGHT_TTL_MS for run_command
    const staleMtime = new Date(now - 5 * 60 * 1000);
    fs.utimesSync(readLog, staleMtime, staleMtime);
    atomicWriteJsonSync(TASK_PROGRESS_FILE, rawOnDisk);

    const snap = getTaskProgressSnapshot({
      workspaceRoot: ROOT_DIR,
      brainDirs: [tmpBrain],
      now,
    });
    assert.equal(
      snap.activeChats.some((c) => c.conversationId === readCid),
      false,
      'Legacy/read_file zombie chat must be reaped to idle after STALE_RUNNING_TTL_MS'
    );
    assert.equal(snap.chats[readCid].status, 'idle');
    assert.equal(snap.chats[readCid].inFlightTool, false);
    assert.equal(
      snap.activeChats.some((c) => c.conversationId === cmdCid),
      true,
      'Legitimate in-flight run_command must stay visible under STALE_IN_FLIGHT_TTL_MS (8m)'
    );

    // 3) If run_command itself goes silent beyond 8m STALE_IN_FLIGHT_TTL_MS, it must also reap to idle
    const snapLater = getTaskProgressSnapshot({
      workspaceRoot: ROOT_DIR,
      brainDirs: [tmpBrain],
      now: now + 4 * 60 * 1000, // total 9m silent
    });
    assert.equal(snapLater.activeChats.length, 0, 'Aborted run_command past STALE_IN_FLIGHT_TTL_MS must reap to idle');
    assert.equal(snapLater.chats[cmdCid].status, 'idle');
  } finally {
    resetTaskProgress();
    fs.rmSync(tmpBrain, { recursive: true, force: true });
  }
});

test('Task Progress: update_steps checklist sync & step-bounded honest percentage calculation', async () => {
  const {
    initTaskProgressFromPrompt,
    advanceTaskProgressOnPreTool,
    recordTaskProgressOnPostTool,
    getTaskProgressSnapshot,
    resetTaskProgress,
  } = await import('../core/task-progress.mjs');

  const prevCacheEnv = process.env.TUNNEL_CACHE_DIR;
  const tmpCache = makeTempDir('amr-progress-checklist-cache-');
  const tmpBrain = makeTempDir('amr-progress-checklist-brain-');
  process.env.TUNNEL_CACHE_DIR = tmpCache;
  resetTaskProgress();

  try {
    const cid = 'chat-checklist-honest';
    const tPath = path.join(tmpBrain, cid, '.system_generated', 'logs', 'transcript.jsonl');
    fs.mkdirSync(path.dirname(tPath), { recursive: true });
    fs.writeFileSync(
      tPath,
      JSON.stringify({ step_index: 1, type: 'USER_INPUT', created_at: '2026-11-23T01:00:00Z', content: 'Обнови версию и тесты' }) + '\n',
      'utf8'
    );

    initTaskProgressFromPrompt({
      conversationId: cid,
      workspaceRoot: ROOT_DIR,
      transcriptPath: tPath,
      userPrompt: 'Обнови версию и тесты',
      grade: 'L',
      brainDirs: [tmpBrain],
    });

    // 1. Authoritative update_steps with 0/4 done, step 1 in_progress
    const checklist1 = [
      { title: 'Доработать bump-version.mjs и hook-runner.mjs', status: 'in_progress' },
      { title: 'Убрать хардкод 3.27.0 в тестах', status: 'pending' },
      { title: 'Обновить CHANGELOG.md за 3.28–3.30', status: 'pending' },
      { title: 'Проверить тесты и установить плагин', status: 'pending' },
    ];
    const snap1 = advanceTaskProgressOnPreTool({
      conversationId: cid,
      workspaceRoot: ROOT_DIR,
      transcriptPath: tPath,
      toolName: 'update_steps',
      checklistSteps: checklist1,
      brainDirs: [tmpBrain],
    });
    const c1 = snap1.activeChats.find((c) => c.conversationId === cid);
    assert.equal(c1.totalSteps, 4);
    assert.equal(c1.currentStep, 1);
    assert.ok(c1.percent >= 3 && c1.percent <= 12, `Expected 0/4 in_progress pct in 3..12%, got ${c1.percent}%`);

    // 2. Editing + micro-tests + reading inside step 1 must NOT jump to 68-92% or inflate step count!
    advanceTaskProgressOnPreTool({
      conversationId: cid,
      workspaceRoot: ROOT_DIR,
      transcriptPath: tPath,
      toolName: 'edit_file',
      filePath: 'scripts/bump-version.mjs',
      brainDirs: [tmpBrain],
    });
    recordTaskProgressOnPostTool({
      conversationId: cid,
      workspaceRoot: ROOT_DIR,
      transcriptPath: tPath,
      toolName: 'edit_file',
      filePath: 'scripts/bump-version.mjs',
      verifyOk: true,
      microTestsRan: true,
      brainDirs: [tmpBrain],
    });
    const snapAfterWork = advanceTaskProgressOnPreTool({
      conversationId: cid,
      workspaceRoot: ROOT_DIR,
      transcriptPath: tPath,
      toolName: 'read_file',
      filePath: 'tests/router-core.test.mjs',
      brainDirs: [tmpBrain],
    });
    const cWork = snapAfterWork.activeChats.find((c) => c.conversationId === cid);
    assert.equal(cWork.totalSteps, 4, 'Checklist step count must not inflate on tool calls');
    assert.equal(cWork.currentStep, 1);
    assert.ok(cWork.percent <= 20, `Step 1 of 4 must stay <= 20% even after edit+microtest, got ${cWork.percent}%`);

    // 3. Transcript reconciliation picks up updated update_steps (2/4 done, 3rd in_progress)
    fs.appendFileSync(
      tPath,
      JSON.stringify({
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-23T01:01:00Z',
        tool_calls: [
          {
            name: 'update_steps',
            args: {
              steps: [
                { title: 'Доработать bump-version.mjs и hook-runner.mjs', status: 'done' },
                { title: 'Убрать хардкод 3.27.0 в тестах', status: 'done' },
                { title: 'Обновить CHANGELOG.md за 3.28–3.30', status: 'in_progress' },
                { title: 'Проверить тесты и установить плагин', status: 'pending' },
              ],
            },
          },
        ],
      }) + '\n',
      'utf8'
    );
    const snap2 = getTaskProgressSnapshot({
      workspaceRoot: ROOT_DIR,
      brainDirs: [tmpBrain],
      now: Date.now() + 2000,
    });
    const c2 = snap2.activeChats.find((c) => c.conversationId === cid);
    assert.equal(c2.totalSteps, 4);
    assert.equal(c2.currentStep, 3);
    assert.ok(c2.percent >= 50 && c2.percent <= 66, `Expected 2/4 done + 3rd running in 50..66%, got ${c2.percent}%`);

    // 4. Re-planning with a fresh checklist recalibrates percentage downward instead of sticking at highWaterPercent
    const snapReplan = advanceTaskProgressOnPreTool({
      conversationId: cid,
      workspaceRoot: ROOT_DIR,
      transcriptPath: tPath,
      toolName: 'update_steps',
      checklistSteps: [
        { title: 'Новый шаг 1', status: 'in_progress' },
        { title: 'Новый шаг 2', status: 'pending' },
        { title: 'Новый шаг 3', status: 'pending' },
        { title: 'Новый шаг 4', status: 'pending' },
        { title: 'Новый шаг 5', status: 'pending' },
      ],
      brainDirs: [tmpBrain],
    });
    const cReplan = snapReplan.activeChats.find((c) => c.conversationId === cid);
    assert.equal(cReplan.totalSteps, 5);
    assert.equal(cReplan.currentStep, 1);
    assert.ok(cReplan.percent <= 12, `Re-planned 0/5 checklist must recalibrate downward, got ${cReplan.percent}%`);

    // 5. Heuristic mode (without update_steps) with 12-step plan bounds percent by step ratio
    const cidPlan = 'chat-plan-12-bounded';
    const tPathPlan = path.join(tmpBrain, cidPlan, '.system_generated', 'logs', 'transcript.jsonl');
    fs.mkdirSync(path.dirname(tPathPlan), { recursive: true });
    fs.writeFileSync(
      tPathPlan,
      JSON.stringify({ step_index: 1, type: 'USER_INPUT', created_at: '2026-11-23T01:02:00Z', content: 'Большой план из 12 шагов' }) + '\n',
      'utf8'
    );
    initTaskProgressFromPrompt({
      conversationId: cidPlan,
      workspaceRoot: ROOT_DIR,
      transcriptPath: tPathPlan,
      userPrompt: 'Большой план из 12 шагов',
      grade: 'XL',
      brainDirs: [tmpBrain],
    });
    const plan12 = Array.from({ length: 12 }, (_, idx) => `${idx + 1}. Этап номер ${idx + 1} реализации`).join('\n');
    advanceTaskProgressOnPreTool({
      conversationId: cidPlan,
      workspaceRoot: ROOT_DIR,
      transcriptPath: tPathPlan,
      toolName: 'exit_plan_mode',
      planText: plan12,
      brainDirs: [tmpBrain],
    });
    advanceTaskProgressOnPreTool({
      conversationId: cidPlan,
      workspaceRoot: ROOT_DIR,
      transcriptPath: tPathPlan,
      toolName: 'edit_file',
      filePath: 'core/task-progress.mjs',
      brainDirs: [tmpBrain],
    });
    const snap12Edit = recordTaskProgressOnPostTool({
      conversationId: cidPlan,
      workspaceRoot: ROOT_DIR,
      transcriptPath: tPathPlan,
      toolName: 'edit_file',
      filePath: 'core/task-progress.mjs',
      verifyOk: true,
      microTestsRan: true,
      brainDirs: [tmpBrain],
    });
    const c12 = snap12Edit.activeChats.find((c) => c.conversationId === cidPlan);
    assert.equal(c12.totalSteps, 12);
    assert.ok(c12.percent <= 25, `Early step of 12-step plan must stay <= 25% (not 68-92%), got ${c12.percent}%`);
  } finally {
    if (prevCacheEnv === undefined) delete process.env.TUNNEL_CACHE_DIR;
    else process.env.TUNNEL_CACHE_DIR = prevCacheEnv;
    fs.rmSync(tmpCache, { recursive: true, force: true });
    fs.rmSync(tmpBrain, { recursive: true, force: true });
  }
});

test('Task Progress UI: #agActiveChatsStack defines scroll-fade CSS masks & dynamic fade sync', () => {
  const uiHtml = fs.readFileSync(path.join(ROOT_DIR, 'sidecars', 'panel', 'ui.html'), 'utf8');
  assert.ok(uiHtml.includes('.ag-chats-stack.has-fade-bottom'), 'ui.html must define .ag-chats-stack.has-fade-bottom');
  assert.ok(uiHtml.includes('.ag-chats-stack.has-fade-top'), 'ui.html must define .ag-chats-stack.has-fade-top');
  assert.ok(uiHtml.includes('mask-image:'), 'ui.html must define CSS mask-image for scroll-fade');
  assert.ok(uiHtml.includes('syncActiveChatsStackFade'), 'ui.html must include syncActiveChatsStackFade helper');
  assert.ok(uiHtml.includes('.full-workspace-shell > .window-body.has-fade-bottom'), 'ui.html must define category body bottom scroll-fade');
  assert.ok(uiHtml.includes('.full-workspace-shell > .window-body.has-fade-top'), 'ui.html must define category body top scroll-fade');
  assert.ok(uiHtml.includes('.full-left-rail.has-fade-bottom'), 'ui.html must define left rail bottom scroll-fade');
  assert.ok(uiHtml.includes('.full-left-rail.has-fade-top'), 'ui.html must define left rail top scroll-fade');
  assert.ok(uiHtml.includes('syncCategoryScrollFades'), 'ui.html must include syncCategoryScrollFades helper');
});

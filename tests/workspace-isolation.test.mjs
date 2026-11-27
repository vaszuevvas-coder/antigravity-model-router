import { ROOT_DIR, SUITE_CACHE_DIR, makeTempDir, registerSuiteLifecycle } from './helpers/router-test-env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

registerSuiteLifecycle(test);

import {
  createShadowCheckpoint,
  listCheckpoints,
  listCheckpointWorkspaces,
  listTurnCheckpoints,
  resolveEffectiveProjectRoot,
  rollbackTurn,
} from '../core/shadow-guard.mjs';
import {
  getBayesianSummary,
  recordFileFragility,
  resetBayesianPriors,
} from '../core/bayesian-router.mjs';
import {
  getCircuitState,
  recordEditStateHash,
  resetCircuitBreaker,
} from '../core/circuit-breaker.mjs';
import { verifySemanticContracts } from '../core/repo-mapper.mjs';
import { collectTelemetry, resolveActiveWorkspaceForPanel } from '../sidecars/panel/server.mjs';
import {
  TASK_PROGRESS_FILE,
  extractProjectName,
  getTaskProgressSnapshot,
} from '../core/task-progress.mjs';
import { atomicWriteJsonSync, safeReadJsonSync, updateJsonAtomicSync, withFileLockSync } from '../core/safe-json.mjs';

test('1. resolveEffectiveProjectRoot isolates external & nested projects from umbrella folders while keeping monorepos and temp dirs intact', () => {
  const tmpRoot = makeTempDir('amr-iso-root-');
  try {
    const downloadsDir = path.join(tmpRoot, 'Downloads');
    const nestedBookDir = path.join(downloadsDir, 'Books', 'asteroid-novel');
    const extPluginDir = path.join(tmpRoot, 'plugins', 'book-architector');
    const monoRepoDir = path.join(tmpRoot, 'my-monorepo');
    const monoSubPkg = path.join(monoRepoDir, 'packages', 'ui');
    const plainTempWs = path.join(tmpRoot, 'plain-ws');

    fs.mkdirSync(nestedBookDir, { recursive: true });
    fs.mkdirSync(path.join(extPluginDir, 'core'), { recursive: true });
    fs.mkdirSync(monoSubPkg, { recursive: true });
    fs.mkdirSync(plainTempWs, { recursive: true });

    fs.writeFileSync(path.join(nestedBookDir, 'book.json'), '{"title":"Test"}\n', 'utf8');
    fs.writeFileSync(path.join(extPluginDir, 'plugin.json'), '{"name":"book-architector"}\n', 'utf8');
    fs.writeFileSync(path.join(monoRepoDir, 'package.json'), '{"name":"mono"}\n', 'utf8');
    fs.writeFileSync(path.join(monoSubPkg, 'package.json'), '{"name":"ui"}\n', 'utf8');

    // External project edited while active session CWD is Downloads -> resolves to extPluginDir
    const extResolved = resolveEffectiveProjectRoot(path.join(extPluginDir, 'core', 'exporter.mjs'), downloadsDir);
    assert.equal(path.resolve(extResolved), path.resolve(extPluginDir));

    // Nested book project inside umbrella Downloads -> resolves to nestedBookDir
    const bookResolved = resolveEffectiveProjectRoot(path.join(nestedBookDir, 'ch1.md'), downloadsDir);
    assert.equal(path.resolve(bookResolved), path.resolve(nestedBookDir));

    // Monorepo with its own package.json keeps monoRepoDir even when nested package.json exists
    const monoResolved = resolveEffectiveProjectRoot(path.join(monoSubPkg, 'Button.tsx'), monoRepoDir);
    assert.equal(path.resolve(monoResolved), path.resolve(monoRepoDir));

    // Plain temp test workspace without markers preserves plainTempWs
    const plainResolved = resolveEffectiveProjectRoot(path.join(plainTempWs, 'alpha.mjs'), plainTempWs);
    assert.equal(path.resolve(plainResolved), path.resolve(plainTempWs));
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); } catch {}
  }
});

test('2. Shadow Guard isolates per-workspace retention quota (60/ws), turn grouping in __all__, and scoped rollback', () => {
  const cpDir = path.join(SUITE_CACHE_DIR, 'shadow-checkpoints');
  const createdIds = [];

  const tmpRoot = makeTempDir('amr-iso-cp-');
  const wsA = path.join(tmpRoot, 'proj-alpha');
  const wsB = path.join(tmpRoot, 'proj-beta');
  const fileA = path.join(wsA, 'alpha.mjs');
  const fileB = path.join(wsB, 'beta.mjs');

  try {
    fs.mkdirSync(wsA, { recursive: true });
    fs.mkdirSync(wsB, { recursive: true });
    fs.writeFileSync(path.join(wsA, 'package.json'), '{"name":"proj-alpha"}\n', 'utf8');
    fs.writeFileSync(path.join(wsB, 'plugin.json'), '{"name":"proj-beta"}\n', 'utf8');
    fs.writeFileSync(fileA, 'export const alpha = 1;\n', 'utf8');
    fs.writeFileSync(fileB, 'export const beta = 0;\n', 'utf8');

    const sharedTurnId = `turn_shared_${Date.now()}`;
    const cpA = createShadowCheckpoint({
      filePath: fileA,
      workspaceRoot: tmpRoot, // deliberately pass umbrella parent to test effective root healing
      turnId: sharedTurnId,
      turnLabel: 'Правка обоих проектов',
    });
    assert.ok(cpA && cpA.id);
    createdIds.push(cpA.id);
    assert.equal(path.resolve(cpA.workspaceRoot), path.resolve(wsA));
    fs.writeFileSync(fileA, 'export const alpha = 99;\n', 'utf8');

    // Create 64 edits in wsB (exceeds per-workspace quota 60, must NOT evict wsA's checkpoint!)
    for (let i = 1; i <= 64; i++) {
      const cpB = createShadowCheckpoint({
        filePath: fileB,
        workspaceRoot: wsB,
        turnId: i === 64 ? sharedTurnId : `turn_b_${i}_${Date.now()}`,
        turnLabel: `Beta edit #${i}`,
      });
      if (cpB?.id) createdIds.push(cpB.id);
      fs.writeFileSync(fileB, `export const beta = ${i};\n`, 'utf8');
    }

    const listA = listCheckpoints(20, wsA);
    assert.ok(listA.some((c) => c.id === cpA.id), 'wsA checkpoint must survive 64 edits in wsB');
    assert.ok(listA.every((c) => path.resolve(c.workspaceRoot) === path.resolve(wsA)));

    const listB = listCheckpoints(100, wsB);
    assert.equal(listB.length, 60, 'wsB checkpoints must be capped at 60 per workspace');

    // In __all__ mode, shared turnId must be split cleanly into distinct project entries
    const allTurns = listTurnCheckpoints(80, '__all__');
    const sharedEntries = allTurns.filter((t) => t.turnId === sharedTurnId);
    assert.equal(sharedEntries.length, 2, 'Cross-project turn must split by workspace in __all__ mode');

    // Scoped rollback on wsA must restore alpha.mjs without modifying beta.mjs
    const rbA = rollbackTurn(sharedTurnId, wsA);
    assert.equal(rbA.ok, true);
    assert.equal(rbA.count, 1);
    assert.equal(fs.readFileSync(fileA, 'utf8'), 'export const alpha = 1;\n');
    assert.equal(fs.readFileSync(fileB, 'utf8'), 'export const beta = 64;\n');

    // Temp dirs should not leak into user-facing listCheckpointWorkspaces()
    const discovered = listCheckpointWorkspaces();
    assert.equal(discovered.some((d) => path.resolve(d.workspaceRoot) === path.resolve(wsA)), false);
  } finally {
    const createdSet = new Set(createdIds);
    for (const id of createdIds) {
      const bak = path.join(cpDir, `${id}.bak`);
      try { if (fs.existsSync(bak)) fs.unlinkSync(bak); } catch {}
    }
    try {
      const idxPath = path.join(cpDir, 'index.json');
      if (fs.existsSync(idxPath)) {
        withFileLockSync(idxPath, () => {
          const cur = safeReadJsonSync(idxPath, () => []);
          if (Array.isArray(cur)) {
            const pruned = cur.filter((item) => !createdSet.has(item?.id));
            atomicWriteJsonSync(idxPath, pruned);
          }
        }, { maxWaitMs: 12000 });
      }
    } catch {}
    try { fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); } catch {}
  }
});

test('3. Bayesian fragility & Circuit Breaker isolate per workspace and reset cleanly', () => {
  const tmpRoot = makeTempDir('amr-iso-bc-');
  const wsA = path.join(tmpRoot, 'ws-a');
  const wsB = path.join(tmpRoot, 'ws-b');

  try {
    fs.mkdirSync(wsA, { recursive: true });
    fs.mkdirSync(wsB, { recursive: true });
    const fileA = path.join(wsA, 'fragileA.mjs');
    const fileB = path.join(wsB, 'fragileB.mjs');
    fs.writeFileSync(fileA, 'export const a = 1;\n', 'utf8');
    fs.writeFileSync(fileB, 'export const b = 2;\n', 'utf8');

    // Bayesian file fragility isolation
    recordFileFragility({ filePath: fileA, workspaceRoot: wsA, success: false });
    recordFileFragility({ filePath: fileB, workspaceRoot: wsB, success: false });

    const sumA = getBayesianSummary(wsA);
    const sumB = getBayesianSummary(wsB);
    assert.equal(sumA.fragileFiles.some((f) => f.file === 'fragileA.mjs'), true);
    assert.equal(sumA.fragileFiles.some((f) => f.file === 'fragileB.mjs'), false);
    assert.equal(sumB.fragileFiles.some((f) => f.file === 'fragileB.mjs'), true);
    assert.equal(sumB.fragileFiles.some((f) => f.file === 'fragileA.mjs'), false);

    // Partial fragility reset for wsA must keep wsB untouched
    resetBayesianPriors({ workspaceRoot: wsA, onlyFragility: true });
    assert.equal(getBayesianSummary(wsA).fragileFiles.length, 0);
    assert.equal(getBayesianSummary(wsB).fragileFiles.some((f) => f.file === 'fragileB.mjs'), true);

    // Circuit Breaker compound bucket lookup & reset by workspaceRoot
    for (let i = 0; i < 3; i++) {
      recordEditStateHash({
        filePath: fileA,
        content: 'export const loop = true;\n',
        workspaceRoot: wsA,
        conversationId: 'conv-a-1',
      });
    }
    assert.equal(getCircuitState({ workspaceRoot: wsA }).status, 'TRIPPED');
    assert.equal(getCircuitState({ workspaceRoot: wsB }).status, 'CLOSED');

    resetCircuitBreaker({ workspaceRoot: wsA });
    assert.equal(getCircuitState({ workspaceRoot: wsA }).status, 'CLOSED');
    assert.equal(getCircuitState({ workspaceRoot: wsA, conversationId: 'conv-a-1' }).status, 'CLOSED');
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); } catch {}
  }
});

test('4. Scoped collectTelemetry isolates activeChat/swarm and UI passes semantic contracts', () => {
  const tmpRoot = makeTempDir('amr-iso-tel-');
  const tmpBrain = path.join(tmpRoot, 'brain');
  const wsA = path.join(tmpRoot, 'proj-a');
  const wsB = path.join(tmpRoot, 'proj-b');

  try {
    fs.mkdirSync(wsA, { recursive: true });
    fs.mkdirSync(wsB, { recursive: true });

    const chatADir = path.join(tmpBrain, '11111111-1111-4111-8111-111111111111', '.system_generated', 'logs');
    const chatBDir = path.join(tmpBrain, '22222222-2222-4222-8222-222222222222', '.system_generated', 'logs');
    fs.mkdirSync(chatADir, { recursive: true });
    fs.mkdirSync(chatBDir, { recursive: true });

    const logA = path.join(chatADir, 'transcript.jsonl');
    const logB = path.join(chatBDir, 'transcript.jsonl');

    fs.writeFileSync(logA, [
      JSON.stringify({ type: 'SYSTEM', content: `Command Working Directory: ${wsA}` }),
      JSON.stringify({ input_tokens: 1200, output_tokens: 100, cache_read_tokens: 4000 }),
    ].join('\n') + '\n', 'utf8');

    // Make chatB newer than chatA
    const nowSec = Date.now() / 1000;
    fs.utimesSync(logA, nowSec - 10, nowSec - 10);

    fs.writeFileSync(logB, [
      JSON.stringify({ type: 'SYSTEM', content: `Command Working Directory: ${wsB}` }),
      JSON.stringify({ input_tokens: 2400, output_tokens: 200, cache_read_tokens: 8000 }),
    ].join('\n') + '\n', 'utf8');

    const telA = collectTelemetry(120000, {
      brainDirs: [tmpBrain],
      workspaceRoot: wsA,
      skipGlobalGpuTelemetry: true,
    });
    assert.equal(telA.activeChat.convoId, '11111111-1111-4111-8111-111111111111');
    assert.equal(telA.lastContextTokens, 5200);
    // Global token totals stay aggregated across chats
    assert.equal(telA.inputTokens, 3600);

    const uiPath = path.join(ROOT_DIR, 'sidecars', 'panel', 'ui.html');
    const uiHtml = fs.readFileSync(uiPath, 'utf8');
    const semCheck = verifySemanticContracts(ROOT_DIR, uiPath);
    assert.equal(semCheck.valid, true, `UI semantic contracts failed: ${semCheck.formattedAlert}`);
    assert.equal(/\bon(?:click|change|input|keydown|keyup)\s*=/i.test(uiHtml), false, 'ui.html must stay 100% CSP-clean');

    for (const reqId of [
      'sel-panelWorkspace',
      'btn-panelWorkspace',
      'btnResetWorkspaceAuto',
      'checkpointsScopeBadge',
      'agProgressProjectBadge',
    ]) {
      assert.ok(uiHtml.includes(`id="${reqId}"`), `ui.html missing #${reqId}`);
    }
    assert.ok(uiHtml.includes('resetWorkspaceFragility'));
    assert.ok(uiHtml.includes('selectPanelWorkspace'));
    assert.ok(uiHtml.includes('Array.isArray(p.activeProjects)'));
    assert.ok(uiHtml.includes("(rp.status === 'running' || rp.status === 'waiting_user')"));
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); } catch {}
  }
});

test('5. Auto-workspace resolution prefers live/freshest task-progress chat over stale session-handoff & repairs UUID projectName', async () => {
  const tmpRoot = makeTempDir('amr-auto-ws-');
  const poisonedCid = `d95fc574-4350-47e2-8730-${String(process.pid).padStart(12, '0').slice(0, 12)}`;
  try {
    const wsRouter = path.join(tmpRoot, 'antigravity-model-router');
    const wsBook = path.join(tmpRoot, 'book-editor');
    fs.mkdirSync(wsRouter, { recursive: true });
    fs.mkdirSync(wsBook, { recursive: true });
    fs.writeFileSync(path.join(wsRouter, 'plugin.json'), '{"name":"antigravity-model-router"}\n', 'utf8');
    fs.writeFileSync(path.join(wsBook, 'plugin.json'), '{"name":"book-editor"}\n', 'utf8');

    const handoffFile = path.join(tmpRoot, 'session-handoff.json');
    const now = Date.now();
    // Simulate book-editor having the newest edit_file handoff timestamp while router chat is running read-only commands
    fs.writeFileSync(
      handoffFile,
      JSON.stringify({
        workspaceRoot: wsBook,
        updatedAt: new Date(now - 60_000).toISOString(),
        workspaces: {
          [wsBook]: { workspaceRoot: wsBook, updatedAt: new Date(now - 60_000).toISOString() },
          [wsRouter]: { workspaceRoot: wsRouter, updatedAt: new Date(now - 600_000).toISOString() },
        },
      }),
      'utf8'
    );

    // Case A: Live running chat in wsRouter beats newer handoff in wsBook
    const resolvedRunning = await resolveActiveWorkspaceForPanel('', {
      allowEphemeralCandidates: true,
      handoffFile,
      cpWorkspaces: [],
      ramWorkspaces: [],
      taskProgress: {
        chats: {
          'chat-book': { conversationId: 'chat-book', workspaceRoot: wsBook, status: 'idle', updatedAt: now - 60_000 },
          'chat-router': { conversationId: 'chat-router', workspaceRoot: wsRouter, status: 'running', updatedAt: now - 5_000 },
        },
      },
    });
    assert.equal(path.resolve(resolvedRunning), path.resolve(wsRouter));

    // Case B: Fresher idle/completed chat in wsRouter beats older waiting_user in wsBook & older handoff
    const resolvedFreshestIdle = await resolveActiveWorkspaceForPanel('', {
      allowEphemeralCandidates: true,
      handoffFile,
      cpWorkspaces: [],
      ramWorkspaces: [],
      taskProgress: {
        chats: {
          'chat-book': { conversationId: 'chat-book', workspaceRoot: wsBook, status: 'waiting_user', updatedAt: now - 60_000 },
          'chat-router': { conversationId: 'chat-router', workspaceRoot: wsRouter, status: 'idle', updatedAt: now - 5_000 },
        },
      },
    });
    assert.equal(path.resolve(resolvedFreshestIdle), path.resolve(wsRouter));

    // Case C: Subagent in worktree resolves to parent chat's workspaceRoot
    const wtDir = path.join(tmpRoot, '.gemini', 'antigravity', 'worktrees', 'chat-router', 'worker-1');
    fs.mkdirSync(wtDir, { recursive: true });
    const resolvedFromSub = await resolveActiveWorkspaceForPanel('', {
      allowEphemeralCandidates: true,
      handoffFile,
      cpWorkspaces: [],
      ramWorkspaces: [],
      taskProgress: {
        chats: {
          'chat-router': { conversationId: 'chat-router', workspaceRoot: wsRouter, status: 'idle', updatedAt: now - 20_000 },
          'sub-1': { conversationId: 'sub-1', isSubagent: true, parentConversationId: 'chat-router', workspaceRoot: wtDir, status: 'running', updatedAt: now - 1_000 },
        },
      },
    });
    assert.equal(path.resolve(resolvedFromSub), path.resolve(wsRouter));

    // Case D: UUID-poisoned projectName in task-progress.json is repaired to real project basename
    assert.equal(extractProjectName(path.join(tmpRoot, '.gemini', 'antigravity', 'brain', 'd95fc574-4350-47e2-8730-efb427a95662'), 'fallback-proj'), 'fallback-proj');
    updateJsonAtomicSync(
      TASK_PROGRESS_FILE,
      () => ({ version: '3.27.0', chats: {}, chatRegistry: {} }),
      (cur) => {
        const chats = cur?.chats && typeof cur.chats === 'object' ? { ...cur.chats } : {};
        const chatRegistry = cur?.chatRegistry && typeof cur.chatRegistry === 'object' ? { ...cur.chatRegistry } : {};
        chats[poisonedCid] = {
          conversationId: poisonedCid,
          chatNumber: 99,
          projectName: poisonedCid,
          workspaceRoot: wsRouter,
          status: 'running',
          currentStep: 1,
          totalSteps: 3,
          percent: 30,
          steps: [],
          updatedAt: now,
        };
        chatRegistry[poisonedCid] = { chatNumber: 99, projectName: poisonedCid, createdAt: now, updatedAt: now };
        return { version: cur?.version || '3.27.0', ...cur, chats, chatRegistry };
      }
    );
    const repairedSnap = getTaskProgressSnapshot({ workspaceRoot: '', brainDirs: [] });
    assert.equal(repairedSnap.chats[poisonedCid].projectName, 'antigravity-model-router');
    assert.equal(repairedSnap.chatRegistry[poisonedCid].projectName, 'antigravity-model-router');
  } finally {
    try {
      updateJsonAtomicSync(
        TASK_PROGRESS_FILE,
        () => ({ version: '3.27.0', chats: {}, chatRegistry: {} }),
        (cur) => {
          const chats = cur?.chats && typeof cur.chats === 'object' ? { ...cur.chats } : {};
          const chatRegistry = cur?.chatRegistry && typeof cur.chatRegistry === 'object' ? { ...cur.chatRegistry } : {};
          delete chats[poisonedCid];
          delete chatRegistry[poisonedCid];
          return { ...cur, chats, chatRegistry };
        }
      );
    } catch {}
    try { fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); } catch {}
  }
});

test('6. Fix #1: registerDaemonWorkspace updates latest active workspace & resolves back-and-forth switches', async () => {
  const { pathToFileURL } = await import('node:url');
  const {
    extractClientRootFromInitialize,
    registerDaemonWorkspace,
    resetStdioClientWorkspaceForTest,
    resolveDefaultWorkspace,
  } = await import('../core/ram-memory-mcp.mjs');
  const wsOne = path.join(ROOT_DIR, 'skills');
  const wsTwo = path.join(ROOT_DIR, 'scripts');
  try {
    extractClientRootFromInitialize({ rootUri: pathToFileURL(wsOne).href });
    assert.equal(path.resolve(resolveDefaultWorkspace('')), path.resolve(wsOne));

    registerDaemonWorkspace(wsTwo);
    assert.equal(path.resolve(resolveDefaultWorkspace('')), path.resolve(wsTwo));

    // Re-activating previously registered wsOne must move it back to the active default
    registerDaemonWorkspace(wsOne);
    assert.equal(path.resolve(resolveDefaultWorkspace('')), path.resolve(wsOne));
  } finally {
    resetStdioClientWorkspaceForTest('');
  }
});

test('7. Installed plugin dirs are never treated as user workspaces and unscoped chats auto-heal to "Без проекта"', async () => {
  const {
    isBrainOrTempWorkspacePath,
    isInstalledPluginWorkspacePath,
  } = await import('../core/progress/progress-parsers.mjs');
  const {
    UNSCOPED_CHAT_PROJECT_RU,
    initTaskProgressFromPrompt,
    advanceTaskProgressOnPreTool,
    recordTaskProgressOnPostTool,
    resetTaskProgress,
  } = await import('../core/task-progress.mjs');
  const { isEphemeralPanelCandidatePath } = await import('../sidecars/panel/lib/panel-state-skills.mjs');

  const pluginInstallDir = 'C:\\Users\\Test\\.gemini\\config\\plugins\\antigravity-model-router';
  const scratchDevRepoDir = 'C:\\Users\\Test\\.gemini\\antigravity\\scratch\\antigravity-model-router';

  assert.equal(isInstalledPluginWorkspacePath(pluginInstallDir), true);
  assert.equal(isInstalledPluginWorkspacePath(scratchDevRepoDir), false);
  assert.equal(isBrainOrTempWorkspacePath(pluginInstallDir), true);
  assert.equal(isBrainOrTempWorkspacePath(scratchDevRepoDir), false);
  assert.equal(isEphemeralPanelCandidatePath(pluginInstallDir), true);
  assert.equal(isEphemeralPanelCandidatePath(scratchDevRepoDir), false);

  const prevCacheDir = process.env.TUNNEL_CACHE_DIR;
  const tmpCache = makeTempDir('amr-plugin-ws-isolation-');
  const tmpRepo = makeTempDir('amr-real-proj-');
  process.env.TUNNEL_CACHE_DIR = tmpCache;

  try {
    fs.writeFileSync(path.join(tmpRepo, 'package.json'), '{"name":"real-proj"}\n', 'utf8');
    resetTaskProgress();

    // Another active chat sets state.workspaceRoot to tmpRepo
    initTaskProgressFromPrompt({
      conversationId: 'real-proj-chat',
      workspaceRoot: tmpRepo,
      userPrompt: 'Fix real project bug',
      grade: 'S',
    });

    // Unscoped chat receives installed plugin dir (or empty workspaceRoot) -> must stay "Без проекта"
    const cidUnscoped = 'unscoped-plugin-chat';
    initTaskProgressFromPrompt({
      conversationId: cidUnscoped,
      workspaceRoot: pluginInstallDir,
      userPrompt: 'Просто вопрос без проекта',
      grade: 'S',
    });
    advanceTaskProgressOnPreTool({
      conversationId: cidUnscoped,
      workspaceRoot: '',
      toolName: 'run_command',
      commandLine: 'echo hi',
    });
    const afterPost = recordTaskProgressOnPostTool({
      conversationId: cidUnscoped,
      workspaceRoot: pluginInstallDir,
      toolName: 'run_command',
      commandLine: 'echo hi',
      verifyOk: true,
    });
    const unscopedEntry = (afterPost.activeChats || []).find((c) => c.conversationId === cidUnscoped);
    assert.ok(unscopedEntry, 'Unscoped chat must be present in activeChats');
    assert.equal(unscopedEntry.isUnscopedChat, true);
    assert.equal(unscopedEntry.projectName, UNSCOPED_CHAT_PROJECT_RU);
    assert.equal(unscopedEntry.workspaceRoot, '');

    // Poisoned legacy record in task-progress.json must auto-heal on getTaskProgressSnapshot
    const poisonedCid = 'legacy-poisoned-plugin-chat';
    const tpPath = path.join(tmpCache, 'task-progress.json');
    updateJsonAtomicSync(
      tpPath,
      () => ({ version: '4.0.5', chats: {}, chatRegistry: {} }),
      (cur) => {
        const chats = cur?.chats && typeof cur.chats === 'object' ? { ...cur.chats } : {};
        chats[poisonedCid] = {
          conversationId: poisonedCid,
          chatNumber: 9,
          projectName: 'antigravity-model-router',
          workspaceRoot: pluginInstallDir,
          status: 'running',
          currentStep: 1,
          totalSteps: 2,
          percent: 40,
          steps: [],
          updatedAt: Date.now(),
        };
        return { ...cur, chats };
      }
    );

    const repairedSnap = getTaskProgressSnapshot({ workspaceRoot: '', brainDirs: [] });
    const repairedChat = repairedSnap.chats[poisonedCid];
    assert.ok(repairedChat, 'Poisoned chat must still exist after auto-heal');
    assert.equal(repairedChat.workspaceRoot, '');
    assert.equal(repairedChat.projectName, UNSCOPED_CHAT_PROJECT_RU);
    assert.equal(repairedChat.isUnscopedChat, true);
  } finally {
    if (prevCacheDir === undefined) delete process.env.TUNNEL_CACHE_DIR;
    else process.env.TUNNEL_CACHE_DIR = prevCacheDir;
    try { fs.rmSync(tmpCache, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); } catch {}
    try { fs.rmSync(tmpRepo, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); } catch {}
  }
});

test('8. Auto-workspace prioritizes active IDE openWorkspaces & conversationId over fresher background chats (even without req headers)', async () => {
  const { pathToFileURL } = await import('node:url');
  const http = await import('node:http');
  const { startSidecarPanel } = await import('../sidecars/panel/server.mjs');
  const { initTaskProgressFromPrompt, resetTaskProgress } = await import('../core/task-progress.mjs');

  const tmpRoot = makeTempDir('amr-ws-priority-');
  const prevCacheDir = process.env.TUNNEL_CACHE_DIR;
  const prevIsolate = process.env.TUNNEL_TEST_ISOLATE_INSTALLED;
  const prevStatePath = process.env.TUNNEL_TEST_STATE_PATH;
  const tmpCache = path.join(tmpRoot, 'cache');
  const wsGame = path.join(tmpRoot, 'BitFergo-game');
  const wsRouter = path.join(tmpRoot, 'antigravity-model-router');
  const wsExtra = path.join(tmpRoot, 'extra-lib');
  const isolatedStatePath = path.join(tmpRoot, 'router-state.json');

  fs.mkdirSync(tmpCache, { recursive: true });
  fs.mkdirSync(wsGame, { recursive: true });
  fs.mkdirSync(wsRouter, { recursive: true });
  fs.mkdirSync(wsExtra, { recursive: true });
  fs.writeFileSync(path.join(tmpRoot, 'plugin.json'), '{"name":"antigravity-model-router","version":"4.0.9"}\n', 'utf8');
  fs.writeFileSync(isolatedStatePath, JSON.stringify({ onboardingCompleted: true, hardwareProfiled: true, ramMaxBudgetMb: 4096 }, null, 2), 'utf8');
  fs.writeFileSync(path.join(wsGame, 'package.json'), '{"name":"bitfergo-game"}\n', 'utf8');
  fs.writeFileSync(path.join(wsRouter, 'plugin.json'), '{"name":"antigravity-model-router"}\n', 'utf8');
  fs.writeFileSync(path.join(wsExtra, 'package.json'), '{"name":"extra-lib"}\n', 'utf8');

  process.env.TUNNEL_CACHE_DIR = tmpCache;
  process.env.TUNNEL_TEST_ISOLATE_INSTALLED = '1';
  process.env.TUNNEL_TEST_STATE_PATH = isolatedStatePath;

  const now = Date.now();
  const gameUri = pathToFileURL(wsGame).href;
  const extraUri = pathToFileURL(wsExtra).href;

  try {
    // 1. Direct resolver: single open IDE workspace beats fresher running chat in another repo
    const tp = {
      chats: {
        'conv-game-1': { conversationId: 'conv-game-1', workspaceRoot: wsGame, status: 'running', updatedAt: now - 60_000 },
        'conv-router-9': { conversationId: 'conv-router-9', workspaceRoot: wsRouter, status: 'running', updatedAt: now - 1_000 },
      },
    };
    const resolvedSingleOpen = await resolveActiveWorkspaceForPanel('', {
      allowEphemeralCandidates: true,
      openWorkspaces: [gameUri],
      taskProgress: tp,
      cpWorkspaces: [],
      ramWorkspaces: [],
    });
    assert.equal(path.resolve(resolvedSingleOpen), path.resolve(wsGame));

    // 2. Multi-root openWorkspaces breaks tie via activeConversationId
    const tpMulti = {
      chats: {
        'conv-game-1': { conversationId: 'conv-game-1', workspaceRoot: wsGame, status: 'idle', updatedAt: now - 120_000 },
        'conv-extra-2': { conversationId: 'conv-extra-2', workspaceRoot: wsExtra, status: 'running', updatedAt: now - 5_000 },
        'conv-router-9': { conversationId: 'conv-router-9', workspaceRoot: wsRouter, status: 'running', updatedAt: now - 1_000 },
      },
    };
    const resolvedMultiByCid = await resolveActiveWorkspaceForPanel('', {
      allowEphemeralCandidates: true,
      openWorkspaces: [extraUri, gameUri],
      activeConversationId: 'conv-game-1',
      taskProgress: tpMulti,
      cpWorkspaces: [],
      ramWorkspaces: [],
    });
    assert.equal(path.resolve(resolvedMultiByCid), path.resolve(wsGame));

    // 3. Empty openWorkspaces still honors activeConversationId over fresher background chat
    const resolvedByCidOnly = await resolveActiveWorkspaceForPanel('', {
      allowEphemeralCandidates: true,
      openWorkspaces: [],
      activeConversationId: 'conv-game-1',
      taskProgress: tp,
      cpWorkspaces: [],
      ramWorkspaces: [],
    });
    assert.equal(path.resolve(resolvedByCidOnly), path.resolve(wsGame));

    // 4. SidecarApp contract (handler(data) with NO req argument, matching sidecar_sdk/index.mjs)
    // Put non-ephemeral folder names outside os.tmpdir() filter? No, use direct non-amr path via symlink?
    // Even simpler: test via query params on /api/state when activeConversationId & openWorkspaces are passed without req.
    resetTaskProgress();
    initTaskProgressFromPrompt({
      conversationId: 'conv-game-live',
      workspaceRoot: wsGame,
      userPrompt: 'Update game UI',
      grade: 'M',
    });
    initTaskProgressFromPrompt({
      conversationId: 'conv-router-live',
      workspaceRoot: wsRouter,
      userPrompt: 'Background router task',
      grade: 'M',
    });

    class DataOnlySidecarApp {
      constructor() {
        this._pages = new Map();
        this._apis = new Map();
        this._server = null;
      }
      page(p, h) { this._pages.set(p, h); }
      api(p, h, m = 'POST') {
        if (!this._apis.has(p)) this._apis.set(p, new Map());
        this._apis.get(p).set(m.toUpperCase(), h);
      }
      run() {
        const srv = http.createServer((req, res) => {
          const u = new URL(req.url || '/', 'http://127.0.0.1');
          const handler = this._apis.get(u.pathname)?.get(req.method);
          if (!handler) { res.writeHead(404); res.end(); return; }
          const data = {};
          for (const [k, v] of u.searchParams.entries()) data[k] = v;
          Promise.resolve(handler(data)) // intentionally omit req like real sidecar_sdk!
            .then((out) => {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(out));
            })
            .catch((err) => {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: err?.message }));
            });
        });
        this._server = srv;
        return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
      }
      get port() { return this._server?.address()?.port || 0; }
      close() {
        if (!this._server) return Promise.resolve();
        const s = this._server;
        this._server = null;
        return new Promise((r) => s.close(() => r()));
      }
    }

    // Create two non-ephemeral workspace paths? Wait: os.tmpdir() is ephemeral, so verify query param parsing on /api/state
    // with a real non-ephemeral project (ROOT_DIR and ROOT_DIR/sidecars/panel/ui-src) vs data.openWorkspaces!
    const app = await startSidecarPanel({ SidecarAppClass: DataOnlySidecarApp, pluginRoot: tmpRoot });
    try {
      const origin = `http://127.0.0.1:${app.port}`;
      const targetSubProj = path.join(ROOT_DIR, 'skills', 'ui-ux-design-system');
      const targetUri = pathToFileURL(targetSubProj).href;
      // Note: ROOT_DIR is active in taskProgress or fallback; passing openWorkspaces=targetUri in query string without headers/req
      // must resolve activeWorkspace to targetSubProj when targetSubProj has a valid dir and isn't ephemeral.
      const res = await fetch(`${origin}/api/state?adaptive=1&openWorkspaces=${encodeURIComponent(targetUri)}`);
      const json = await res.json();
      assert.equal(path.resolve(json.activeWorkspace), path.resolve(targetSubProj));
      assert.equal(path.resolve(json.autoWorkspace), path.resolve(targetSubProj));
    } finally {
      await app.close();
    }
  } finally {
    if (prevCacheDir === undefined) delete process.env.TUNNEL_CACHE_DIR;
    else process.env.TUNNEL_CACHE_DIR = prevCacheDir;
    if (prevIsolate === undefined) delete process.env.TUNNEL_TEST_ISOLATE_INSTALLED;
    else process.env.TUNNEL_TEST_ISOLATE_INSTALLED = prevIsolate;
    if (prevStatePath === undefined) delete process.env.TUNNEL_TEST_STATE_PATH;
    else process.env.TUNNEL_TEST_STATE_PATH = prevStatePath;
    try { fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); } catch {}
  }
});

test('9. Read-only /graph/* IPC routes and makeActive:false never hijack active default workspace', async () => {
  const { pathToFileURL } = await import('node:url');
  const { RamMemoryEngine } = await import('../core/ram-memory-engine.mjs');
  const {
    dispatchIpcRoute,
    extractClientRootFromInitialize,
    registerDaemonWorkspace,
    resetStdioClientWorkspaceForTest,
    resolveDefaultWorkspace,
  } = await import('../core/ram-memory-mcp.mjs');
  const wsOne = path.join(ROOT_DIR, 'skills');
  const wsTwo = path.join(ROOT_DIR, 'scripts');
  const ipcEngine = new RamMemoryEngine({ budgetMb: 64 });
  try {
    extractClientRootFromInitialize({ rootUri: pathToFileURL(wsOne).href });
    assert.equal(path.resolve(resolveDefaultWorkspace('')), path.resolve(wsOne));

    registerDaemonWorkspace(wsTwo, { makeActive: false });
    assert.equal(path.resolve(resolveDefaultWorkspace('')), path.resolve(wsOne));

    const graphRes = await dispatchIpcRoute(
      'POST',
      '/graph/project-map',
      { wsPath: wsTwo, includeTests: false, includeDocs: false },
      { engine: ipcEngine, settings: { enabled: true }, sentinel: null }
    );
    assert.equal(graphRes.status, 200);
    assert.equal(graphRes.body?.ok, true);
    assert.equal(path.resolve(resolveDefaultWorkspace('')), path.resolve(wsOne));

    // Explicit active switch (default makeActive: true) must still update default workspace
    registerDaemonWorkspace(wsTwo);
    assert.equal(path.resolve(resolveDefaultWorkspace('')), path.resolve(wsTwo));
  } finally {
    try { ipcEngine.close(); } catch {}
    resetStdioClientWorkspaceForTest('');
  }
});


import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { estimateTaskGradeAndThinkingBudget, detectPromptIntentSignals } from '../core/tool-pruner.mjs';
import { handlePreInvocation, handlePreToolUse } from '../core/hook-runner.mjs';
import {
  generateIdleModuleSymbolCard,
  getMsSinceLastForegroundGpu,
  ollamaHttpJson,
  preemptBackgroundGpuWork,
  registerBackgroundGpuController,
  reviewGitDiffHunkLocally,
} from '../core/local-gpu-engine.mjs';
import {
  BackgroundSentinel,
  extractRelativeImportSpecs,
  readCachedSentinelSnapshot,
} from '../core/background-sentinel.mjs';
import { RamMemoryEngine } from '../core/ram-memory-engine.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, '..');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('1. Two-Phase ask_question Gate: prevAskQuestionCalled false vs true vs undefined + E2E PreInvocation', async () => {
  // 1a) Legacy undefined prevAskQuestionCalled preserves immediate Plan Approved Follow-Up (backward compatibility)
  const legacyFollow = estimateTaskGradeAndThinkingBudget(
    'Погнали!',
    { confirmBeforeRun: true, confirmThreshold: 'M' },
    {
      prevTurnGrade: 'XL',
      prevTurnMatrix: { breadth: 'wide', depth: 'deep_arch', riskMode: 'critical_blast', tensorId: 'wide_deep_critical' },
    }
  );
  assert.equal(legacyFollow.isApprovalFollowUp, true);
  assert.equal(legacyFollow.grade, 'XL');
  assert.match(legacyFollow.budgetHint, /\[Plan Approved Follow-Up \(XL\)\]/);

  // 1b) Explicit prevAskQuestionCalled: false after text-only Read-Only turn triggers [Two-Phase Plan Gate]
  const sigMenu = detectPromptIntentSignals('Давай перейдем к меню и запускаем');
  assert.equal(sigMenu.isApprovalFollowUp, true);

  const twoPhase = estimateTaskGradeAndThinkingBudget(
    'Давай перейдем к меню и запускаем',
    { confirmBeforeRun: true, confirmThreshold: 'M' },
    {
      prevTurnGrade: 'S',
      prevWasReadOnly: true,
      prevProposedGrade: 'L',
      prevAskQuestionCalled: false,
    }
  );
  assert.equal(twoPhase.requiresTwoPhaseGate, true);
  assert.equal(twoPhase.isApprovalFollowUp, false);
  assert.equal(twoPhase.grade, 'L');
  assert.match(twoPhase.budgetHint, /\[Two-Phase Plan Gate \(L\)\]/);
  assert.match(twoPhase.budgetHint, /MUST call ask_question NOW/);

  // 1c) Explicit prevAskQuestionCalled: true proceeds immediately with [Plan Approved Follow-Up]
  const approvedAfterPopup = estimateTaskGradeAndThinkingBudget(
    'Запускаем',
    { confirmBeforeRun: true, confirmThreshold: 'M' },
    {
      prevTurnGrade: 'L',
      prevAskQuestionCalled: true,
    }
  );
  assert.equal(approvedAfterPopup.isApprovalFollowUp, true);
  assert.equal(approvedAfterPopup.grade, 'L');
  assert.match(approvedAfterPopup.budgetHint, /\[Plan Approved Follow-Up \(L\)\]/);

  // 1d) Full E2E hook-runner flow: Read-Only -> Short Approval (Two-Phase Gate) -> ask_question -> Short Approval (Execute)
  const convoId = `conv-two-phase-${process.pid}-${Date.now()}`;
  const turnCachePath = path.join(ROOT_DIR, '.cache', 'pre-invocation-turn.json');
  const tmpWs = makeTempDir('amr-twophase-ws-');
  fs.writeFileSync(path.join(tmpWs, 'app.mjs'), 'export const x = 1;\n', 'utf8');
  const getInjectedMsg = (res) =>
    (res?.injectSteps || [])
      .map((s) => s?.ephemeralMessage || s?.systemMessage?.systemMessage || '')
      .join('\n');

  try {
    // Turn 1: Read-only analytical question
    const turn1 = await handlePreInvocation(
      {
        conversationId: convoId,
        workspacePath: tmpWs,
        userInput: 'А если мы например добавим всё? От этого станет хуже?',
      },
      { confirmBeforeRun: true, confirmThreshold: 'M', ramCacheEnabled: false, thinkingLimiter: true }
    );
    assert.match(getInjectedMsg(turn1), /\[Read-Only/);

    // Turn 2: User says "Давай запускаем" without an ask_question popup having occurred in Turn 1
    const turn2 = await handlePreInvocation(
      {
        conversationId: convoId,
        workspacePath: tmpWs,
        userInput: 'Давай запускаем',
      },
      { confirmBeforeRun: true, confirmThreshold: 'M', ramCacheEnabled: false, thinkingLimiter: true }
    );
    assert.match(getInjectedMsg(turn2), /\[Two-Phase Plan Gate/);

    // Agent calls ask_question in Turn 2
    const askRes = await handlePreToolUse(
      {
        conversationId: convoId,
        workspacePath: tmpWs,
        toolName: 'ask_question',
        args: {
          questions: [
            {
              question: 'План автопилота: модули фонового стража. Объём: M. Запускаем?',
              options: [
                '(Recommended) Внедрить фоновый координатор в app.mjs с автотестами (на Hydrogen · Средний)',
                'Минимальный контур: добавить только проверку контрактов в app.mjs без фонового цикла',
                'Только read-only диагностика app.mjs без записи на диск',
              ],
            },
          ],
        },
      },
      { confirmBeforeRun: true, pureCognitiveTriage: true }
    );
    assert.equal(askRes.decision, 'allow');

    // Turn 3: User approves -> now proceeds directly without re-asking!
    const turn3 = await handlePreInvocation(
      {
        conversationId: convoId,
        workspacePath: tmpWs,
        userInput: 'Погнали!',
      },
      { confirmBeforeRun: true, confirmThreshold: 'M', ramCacheEnabled: false, thinkingLimiter: true }
    );
    assert.match(getInjectedMsg(turn3), /\[Plan Approved Follow-Up/);
  } finally {
    fs.rmSync(tmpWs, { recursive: true, force: true, maxRetries: 6, retryDelay: 50 });
    try {
      if (fs.existsSync(turnCachePath)) {
        const cur = JSON.parse(fs.readFileSync(turnCachePath, 'utf8'));
        if (cur?.turns && typeof cur.turns === 'object') {
          for (const k of Object.keys(cur.turns)) {
            if (k.includes(convoId)) delete cur.turns[k];
          }
          fs.writeFileSync(turnCachePath, JSON.stringify(cur, null, 2), 'utf8');
        }
      }
    } catch {}
  }
});

test('1b. Short Russian approvals ("Да", "Да!", "Исправляем") + PreToolUse Pre-Task Gate Guard (warn-then-allow & artifact exempt)', async () => {
  for (const phrase of ['Да', 'Да!', 'Исправляем']) {
    const sig = detectPromptIntentSignals(phrase);
    assert.equal(sig.isApprovalFollowUp, true, `"${phrase}" must be recognized as short approval`);
  }

  const twoPhaseBareYes = estimateTaskGradeAndThinkingBudget(
    'Да',
    { confirmBeforeRun: true, confirmThreshold: 'ALL', orchestratorSmartSynergy: false },
    {
      prevTurnGrade: 'S',
      prevWasReadOnly: true,
      prevProposedGrade: 'M',
      prevAskQuestionCalled: false,
    }
  );
  assert.equal(twoPhaseBareYes.requiresTwoPhaseGate, true);
  assert.match(twoPhaseBareYes.budgetHint, /\[Two-Phase Plan Gate/);

  const baseId = `conv-edit-gate-${process.pid}-${Date.now()}`;
  const convo1 = `${baseId}-main`;
  const convo2 = `${baseId}-retry`;
  const convo3 = `${baseId}-worker`;
  const turnCachePath = path.join(ROOT_DIR, '.cache', 'pre-invocation-turn.json');
  const swarmRolesPath = path.join(ROOT_DIR, '.cache', 'swarm-roles.json');
  const tmpWs = makeTempDir('amr-editgate-ws-');
  const appPath = path.join(tmpWs, 'app.mjs');
  fs.writeFileSync(appPath, 'export const x = 1;\n', 'utf8');

  try {
    const pre = await handlePreInvocation(
      {
        hookEventName: 'PreInvocation',
        conversationId: convo1,
        workspacePaths: [tmpWs],
        lastUserInput: 'Исправь функцию x в app.mjs',
        modelName: 'gemini-4-carbon-medium',
      },
      {
        showBadge: true,
        confirmBeforeRun: true,
        confirmThreshold: 'ALL',
        orchestratorSmartSynergy: false,
        ramCacheEnabled: false,
        thinkingLimiter: true,
      }
    );
    const hasGateHint = (pre?.injectSteps || []).some(
      (s) => typeof s?.ephemeralMessage === 'string' && s.ephemeralMessage.includes('[Pre-Task Gate: ON')
    );
    const hasCrashBadge = (pre?.injectSteps || []).some(
      (s) => s?.systemMessage && s.systemMessage.metadata && Object.hasOwn(s.systemMessage.metadata, 'user_markdown')
    );
    assert.equal(hasGateHint, true, 'PreInvocation must emit Pre-Task Gate: ON');
    assert.equal(hasCrashBadge, false, 'PreInvocation must not append metadata.user_markdown by default');

    const deniedEdit = await handlePreToolUse(
      {
        conversationId: convo1,
        workspacePaths: [tmpWs],
        toolName: 'edit_file',
        args: { Path: appPath, Target: 'export const x = 1;', Replacement: 'export const x = 2;' },
      },
      { confirmBeforeRun: true, confirmThreshold: 'ALL', orchestratorSmartSynergy: false }
    );
    assert.equal(deniedEdit.decision, 'deny');
    assert.match(deniedEdit.reason, /\[Pre-Task Gate Guard\]/);

    const artifactAllowed = await handlePreToolUse(
      {
        conversationId: convo1,
        workspacePaths: [tmpWs],
        toolName: 'write_file',
        args: {
          Path: path.join(tmpWs, '.gemini', 'antigravity', 'brain', 't1', 'plan.md'),
          Content: '# Plan\n',
          ArtifactMetadata: { Summary: 'Plan', UserFacing: true, RequestFeedback: true },
        },
      },
      { confirmBeforeRun: true, confirmThreshold: 'ALL', orchestratorSmartSynergy: false }
    );
    assert.equal(artifactAllowed.decision, 'allow', 'Artifact writes must bypass Pre-Task Gate Guard');

    const askAllowed = await handlePreToolUse(
      {
        conversationId: convo1,
        workspacePaths: [tmpWs],
        toolName: 'ask_question',
        args: {
          questions: [
            {
              question: 'План автопилота: обновление app.mjs. Объём: S. Рекомендуемая мощность: Hydrogen · Средний. Запускаем?',
              options: [
                '(Recommended) Обновить app.mjs точечно на Hydrogen · Средний с проверкой синтаксиса',
                'Расширенный патч app.mjs с дополнительным модульным тестом',
                'Только read-only проверка app.mjs без записи на диск',
              ],
            },
          ],
        },
      },
      { confirmBeforeRun: true, pureCognitiveTriage: true }
    );
    assert.equal(askAllowed.decision, 'allow');

    const editAfterAsk = await handlePreToolUse(
      {
        conversationId: convo1,
        workspacePaths: [tmpWs],
        toolName: 'edit_file',
        args: { Path: appPath, Target: 'export const x = 1;', Replacement: 'export const x = 2;' },
      },
      { confirmBeforeRun: true, confirmThreshold: 'ALL', orchestratorSmartSynergy: false }
    );
    assert.equal(editAfterAsk.decision, 'allow', 'Edit after ask_question must be allowed');

    // Separate convos verify one-shot warn-then-allow & swarm_worker bypass
    await handlePreInvocation(
      {
        hookEventName: 'PreInvocation',
        conversationId: convo3,
        workspacePaths: [tmpWs],
        lastUserInput: '<swarm_worker> edit app.mjs',
      },
      { confirmBeforeRun: true, confirmThreshold: 'ALL', orchestratorSmartSynergy: false, ramCacheEnabled: false, thinkingLimiter: true }
    );
    const workerBypass = await handlePreToolUse(
      {
        conversationId: convo3,
        workspacePaths: [tmpWs],
        prompt: '<swarm_worker> edit app.mjs',
        toolName: 'edit_file',
        args: { Path: appPath, Target: 'export const x = 1;', Replacement: 'export const x = 2;' },
      },
      { confirmBeforeRun: true, confirmThreshold: 'ALL', orchestratorSmartSynergy: false }
    );
    assert.equal(workerBypass.decision, 'allow', 'swarm_worker must bypass interactive Pre-Task Gate Guard');

    await handlePreInvocation(
      {
        hookEventName: 'PreInvocation',
        conversationId: convo2,
        workspacePaths: [tmpWs],
        lastUserInput: 'Исправь функцию x в app.mjs',
      },
      { confirmBeforeRun: true, confirmThreshold: 'ALL', orchestratorSmartSynergy: false, ramCacheEnabled: false, thinkingLimiter: true }
    );
    const firstDeny = await handlePreToolUse(
      {
        conversationId: convo2,
        workspacePaths: [tmpWs],
        toolName: 'edit_file',
        args: { Path: appPath, Target: 'export const x = 1;', Replacement: 'export const x = 2;' },
      },
      { confirmBeforeRun: true, confirmThreshold: 'ALL', orchestratorSmartSynergy: false }
    );
    assert.equal(firstDeny.decision, 'deny');

    const secondDeny = await handlePreToolUse(
      {
        conversationId: convo2,
        workspacePaths: [tmpWs],
        toolName: 'edit_file',
        args: { Path: appPath, Target: 'export const x = 1;', Replacement: 'export const x = 2;' },
      },
      { confirmBeforeRun: true, confirmThreshold: 'ALL', orchestratorSmartSynergy: false }
    );
    assert.equal(secondDeny.decision, 'deny', 'Second edit attempt without ask_question must remain denied');

    await handlePreToolUse(
      {
        conversationId: convo2,
        workspacePaths: [tmpWs],
        toolName: 'ask_question',
        args: { questions: [{ question: 'Подтвердить правку?', options: ['Да'] }] },
      },
      { confirmBeforeRun: true, confirmThreshold: 'ALL', orchestratorSmartSynergy: false }
    );

    const afterAskAllow = await handlePreToolUse(
      {
        conversationId: convo2,
        workspacePaths: [tmpWs],
        toolName: 'edit_file',
        args: { Path: appPath, Target: 'export const x = 1;', Replacement: 'export const x = 2;' },
      },
      { confirmBeforeRun: true, confirmThreshold: 'ALL', orchestratorSmartSynergy: false }
    );
    assert.equal(afterAskAllow.decision, 'allow', 'Edit after ask_question must be allowed');

    const convoOrch = `${baseId}-orch`;
    await handlePreInvocation(
      {
        hookEventName: 'PreInvocation',
        conversationId: convoOrch,
        workspacePaths: [tmpWs],
        lastUserInput: 'Выполни рефакторинг маршрутизатора в нескольких файлах',
        modelName: 'Orchestrator (Neon)',
      },
      { confirmBeforeRun: true, confirmThreshold: 'M', orchestratorSmartSynergy: false, ramCacheEnabled: false }
    );
    const exitPlanDeny = await handlePreToolUse(
      {
        conversationId: convoOrch,
        workspacePaths: [tmpWs],
        toolName: 'exit_plan_mode',
        args: { plan: 'Рефакторинг' },
      },
      { confirmBeforeRun: true, confirmThreshold: 'M', orchestratorSmartSynergy: false }
    );
    assert.equal(exitPlanDeny.decision, 'deny', 'Orchestrator exit_plan_mode before ask_question must be denied');

    await handlePreToolUse(
      {
        conversationId: convoOrch,
        workspacePaths: [tmpWs],
        toolName: 'ask_question',
        args: { questions: [{ question: 'Утвердить план?', options: ['Да'] }] },
      },
      { confirmBeforeRun: true, confirmThreshold: 'M', orchestratorSmartSynergy: false }
    );
    const exitPlanAllow = await handlePreToolUse(
      {
        conversationId: convoOrch,
        workspacePaths: [tmpWs],
        toolName: 'exit_plan_mode',
        args: { plan: 'Рефакторинг' },
      },
      { confirmBeforeRun: true, confirmThreshold: 'M', orchestratorSmartSynergy: false }
    );
    assert.equal(exitPlanAllow.decision, 'allow', 'Orchestrator exit_plan_mode after ask_question must be allowed');
  } finally {
    fs.rmSync(tmpWs, { recursive: true, force: true, maxRetries: 6, retryDelay: 50 });
    try {
      if (fs.existsSync(turnCachePath)) {
        const cur = JSON.parse(fs.readFileSync(turnCachePath, 'utf8'));
        if (cur?.turns && typeof cur.turns === 'object') {
          for (const k of Object.keys(cur.turns)) {
            if (k.includes(baseId)) delete cur.turns[k];
          }
          fs.writeFileSync(turnCachePath, JSON.stringify(cur, null, 2), 'utf8');
        }
      }
    } catch {}
    try {
      if (fs.existsSync(swarmRolesPath)) {
        const curRoles = JSON.parse(fs.readFileSync(swarmRolesPath, 'utf8'));
        if (curRoles?.roles && typeof curRoles.roles === 'object') {
          for (const k of Object.keys(curRoles.roles)) {
            if (k.includes(baseId)) delete curRoles.roles[k];
          }
          fs.writeFileSync(swarmRolesPath, JSON.stringify(curRoles, null, 2), 'utf8');
        }
      }
    } catch {}
  }
});

test('2. P0 AbortController Preemption in local-gpu-engine.mjs (background vs foreground Ollama work)', async () => {
  // Manual controller registration & preemption
  const manualCtrl = new AbortController();
  const unreg = registerBackgroundGpuController(manualCtrl);
  assert.equal(manualCtrl.signal.aborted, false);
  const pRes = preemptBackgroundGpuWork('test_manual_p0');
  assert.equal(pRes.preemptedCount, 1);
  assert.equal(manualCtrl.signal.aborted, true);
  assert.ok(getMsSinceLastForegroundGpu() < 1000);
  unreg();

  // Live HTTP server: slow background /api/chat preempted automatically by fast foreground /api/embed
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : {};
      if (parsed.model === 'bg-slow-model') {
        const timer = setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
          res.end(JSON.stringify({ message: { content: '{"ok":true}' } }));
        }, 2500);
        req.on('close', () => clearTimeout(timer));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
      res.end(JSON.stringify({ embeddings: [[0.1, 0.2, 0.3]] }));
    });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const endpoint = `http://127.0.0.1:${port}`;

  try {
    const t0 = Date.now();
    const bgPromise = ollamaHttpJson(
      'POST',
      '/api/chat',
      { model: 'bg-slow-model', messages: [{ role: 'user', content: 'idle work' }] },
      5000,
      endpoint,
      { priority: 'background' }
    );

    // Wait 40ms for background request to be in-flight, then fire foreground P0 GPU embed
    await new Promise((r) => setTimeout(r, 40));
    const fgRes = await ollamaHttpJson(
      'POST',
      '/api/embed',
      { model: 'qwen3-embedding:0.6b', input: 'foreground query' },
      3000,
      endpoint
    );
    const bgRes = await bgPromise;
    const elapsed = Date.now() - t0;

    assert.equal(fgRes.ok, true);
    assert.equal(bgRes.ok, false);
    assert.equal(bgRes.aborted, true);
    assert.ok(elapsed < 1200, `Background request must abort immediately on P0 foreground work (took ${elapsed}ms)`);

    // Direct helper tests with mock httpJsonFn
    const cardRes = await generateIdleModuleSymbolCard({
      relPath: 'core/auth.mjs',
      codeText: 'export function verifyToken(tok) { return Boolean(tok); }',
      exportedSymbols: ['verifyToken'],
      httpJsonFn: async () => ({
        ok: true,
        data: {
          message: {
            content: '```json\n{"purposeRu":"Проверка JWT токенов.","purposeEn":"Verifies JWT tokens.","keyContracts":"verifyToken(tok)"}\n```',
          },
        },
      }),
    });
    assert.equal(cardRes.ok, true);
    assert.equal(cardRes.card.purposeRu, 'Проверка JWT токенов.');
    assert.equal(cardRes.card.keyContracts, 'verifyToken(tok)');

    const diffRes = await reviewGitDiffHunkLocally({
      relPath: 'core/math.mjs',
      diffText: '@@ -1,2 +1,2 @@\n-return a + b;\n+return a.foo.bar;',
      httpJsonFn: async () => ({
        ok: true,
        data: {
          message: {
            content: JSON.stringify({
              findings: [
                {
                  severity: 'high',
                  lineHint: 'L2',
                  issueRu: 'Возможен TypeError при a.foo === undefined',
                  fixPromptRu: 'Добавь опциональную цепочку a?.foo?.bar в core/math.mjs',
                },
              ],
            }),
          },
        },
      }),
    });
    assert.equal(diffRes.ok, true);
    assert.equal(diffRes.findings.length, 1);
    assert.equal(diffRes.findings[0].severity, 'high');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('3. Engine A: Shadow Guard broken arity & syntax detection + zero-token clean output', async () => {
  const tmpWs = makeTempDir('amr-sentinel-guard-');
  const tmpCache = makeTempDir('amr-sentinel-cacheA-');

  try {
    const providerFile = path.join(tmpWs, 'provider.mjs');
    const consumerFile = path.join(tmpWs, 'consumer.mjs');

    // Start with broken arity (provider expects 2 required args, consumer passes 1) + broken syntax file
    fs.writeFileSync(
      providerFile,
      'export function computeTotal(price, taxRate) {\n  return price * (1 + taxRate);\n}\n',
      'utf8'
    );
    fs.writeFileSync(
      consumerFile,
      'import { computeTotal } from "./provider.mjs";\nexport const res = computeTotal(100);\n',
      'utf8'
    );
    fs.writeFileSync(path.join(tmpWs, 'broken.json'), '{ "unclosed": true ', 'utf8');

    const ramEng = new RamMemoryEngine({ budgetMb: 32 });
    await ramEng.warmWorkspaceAsync(tmpWs, { startWatcher: false });

    const guardSentinel = new BackgroundSentinel({ cacheDir: tmpCache });
    const badRes = await guardSentinel.runShadowGuardPass(tmpWs, ramEng);

    assert.equal(badRes.status, 'error');
    assert.ok(badRes.errorCount >= 2);
    assert.ok(badRes.issues.some((i) => i.type === 'arity_mismatch' && i.symbol === 'computeTotal'));
    assert.ok(badRes.issues.some((i) => i.type === 'syntax_error' && i.file === 'broken.json'));

    const promptAlert = guardSentinel.formatSentinelAlertForPrompt(tmpWs);
    assert.match(promptAlert, /^🛡️ \[Shadow Guard\]/);
    assert.ok(promptAlert.split('\n').length <= 3, 'Alert must be <= 3 lines');

    // Fix both issues -> Shadow Guard becomes clean and formatSentinelAlertForPrompt returns '' (zero tokens!)
    fs.writeFileSync(
      consumerFile,
      'import { computeTotal } from "./provider.mjs";\nexport const res = computeTotal(100, 0.2);\n',
      'utf8'
    );
    fs.writeFileSync(path.join(tmpWs, 'broken.json'), '{ "unclosed": false }\n', 'utf8');
    const ramEngClean = new RamMemoryEngine({ budgetMb: 32 });
    await ramEngClean.warmWorkspaceAsync(tmpWs, { startWatcher: false });

    const cleanSentinel = new BackgroundSentinel({ cacheDir: tmpCache });
    const cleanRes = await cleanSentinel.runShadowGuardPass(tmpWs, ramEngClean);
    assert.equal(cleanRes.status, 'clean');
    assert.equal(cleanRes.errorCount, 0);
    assert.equal(cleanSentinel.formatSentinelAlertForPrompt(tmpWs), '');
  } finally {
    try { fs.rmSync(tmpWs, { recursive: true, force: true, maxRetries: 10, retryDelay: 60 }); } catch {}
    try { fs.rmSync(tmpCache, { recursive: true, force: true, maxRetries: 10, retryDelay: 60 }); } catch {}
  }
});

test('3b. Engine A: extractRelativeImportSpecs ignores strings, templates, comments, regexes and captures real imports', async () => {
  const sample = [
    '// import { ghost1 } from "./commented.mjs";',
    '/* export * from "./block-commented.mjs"; */',
    'const re = /import\\s+x\\s+from\\s+["\']\\.\\/regex-fake\\.mjs["\']/g;',
    'const strFixture = \'import { computeTotal } from "./provider.mjs";\\nexport const x = 1;\';',
    'const tplFixture = `',
    'import { a } from "./tpl-fake.mjs";',
    'export { b } from "../tpl-reexport.mjs";',
    '`;',
    'const obj = { import: "./obj-key.mjs", export: "./obj-export.mjs" };',
    'obj.import("./method-call.mjs");',
    'const u = import.meta.url;',
    'export const label = "from \'./after-export-const.mjs\'";',
    'import "./side-effect.mjs";',
    'import { alpha, beta as b } from "./real-a.mjs";',
    'import type { MyType } from "../types/shared.js";',
    'import from from "./from-ident.mjs";',
    'export * as ns from "./reexport-ns.mjs";',
    'export type { PublicApi } from "./reexport-type.mjs";',
    'const lazy = import("./dyn.mjs", { with: { type: "json" } });',
    'const tplExpr = `${await import("./tpl-expr-dyn.mjs")}`;',
  ].join('\n');

  const specs = extractRelativeImportSpecs(sample);
  assert.deepEqual(specs, [
    './side-effect.mjs',
    './real-a.mjs',
    '../types/shared.js',
    './from-ident.mjs',
    './reexport-ns.mjs',
    './reexport-type.mjs',
    './dyn.mjs',
    './tpl-expr-dyn.mjs',
  ]);

  const tmpWs = makeTempDir('amr-sentinel-str-imports-');
  const tmpCache = makeTempDir('amr-sentinel-cache3b-');
  try {
    fs.writeFileSync(
      path.join(tmpWs, 'fixture-holder.test.mjs'),
      'const code = \'import { computeTotal } from "./provider.mjs";\\n\';\nexport const len = code.length;\n',
      'utf8'
    );
    const s = new BackgroundSentinel({ cacheDir: tmpCache });
    const res = await s.runShadowGuardPass(tmpWs);
    assert.equal(res.status, 'clean');
    assert.equal(res.errorCount, 0);

    // String/template literals mentioning an imported helper call must NOT trigger arity_mismatch
    fs.writeFileSync(
      path.join(tmpWs, 'safe-json.mjs'),
      'export function withFileLockSync(targetPath, fn, opts = {}) {\n  return fn(targetPath, opts);\n}\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmpWs, 'contract-string-fixture.test.mjs'),
      [
        'import { withFileLockSync } from "./safe-json.mjs";',
        'const hint = "вызов withFileLockSync()";',
        'const tpl = `пример ${hint} и withFileLockSync()`;',
        'export const out = withFileLockSync("a.json", () => tpl);',
      ].join('\n') + '\n',
      'utf8'
    );
    const cleanStringRes = await s.runShadowGuardPass(tmpWs);
    assert.equal(cleanStringRes.status, 'clean', `String literal caused false contract error: ${JSON.stringify(cleanStringRes.issues)}`);

    // Real arity mismatch in code MUST still be caught
    fs.writeFileSync(
      path.join(tmpWs, 'contract-real-bug.mjs'),
      'import { withFileLockSync } from "./safe-json.mjs";\nexport const broken = withFileLockSync();\n',
      'utf8'
    );
    const bugRes = await s.runShadowGuardPass(tmpWs);
    assert.equal(bugRes.status, 'error');
    assert.ok(bugRes.issues.some((i) => i.type === 'arity_mismatch' && i.symbol === 'withFileLockSync' && i.file === 'contract-real-bug.mjs'));
  } finally {
    try { fs.rmSync(tmpWs, { recursive: true, force: true, maxRetries: 10, retryDelay: 60 }); } catch {}
    try { fs.rmSync(tmpCache, { recursive: true, force: true, maxRetries: 10, retryDelay: 60 }); } catch {}
  }
});

test('4. Engine B: Idle Local BugBot git diff audit + SHA-256 deduplication + clear_findings', async () => {
  const tmpWs = makeTempDir('amr-sentinel-bugbot-');
  const tmpCache = makeTempDir('amr-sentinel-cacheB-');

  try {
    execFileSync('git', ['init'], { cwd: tmpWs, windowsHide: true });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmpWs, windowsHide: true });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmpWs, windowsHide: true });

    const targetFile = path.join(tmpWs, 'wallet.mjs');
    fs.writeFileSync(targetFile, 'export function debit(balance, amount) {\n  return balance - amount;\n}\n', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: tmpWs, windowsHide: true });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: tmpWs, windowsHide: true });

    // Introduce uncommitted diff + lockfile noise (lockfile should be ignored)
    fs.writeFileSync(
      targetFile,
      'export function debit(balance, amount) {\n  return balance.amount.missing - amount;\n}\n',
      'utf8'
    );
    fs.writeFileSync(path.join(tmpWs, 'package-lock.json'), '{"lockfileVersion":3}\n', 'utf8');

    let gpuCalls = 0;
    const mockHttpJson = async (_method, _url, body) => {
      gpuCalls += 1;
      assert.doesNotMatch(JSON.stringify(body), /lockfileVersion/);
      return {
        ok: true,
        data: {
          message: {
            content: JSON.stringify({
              findings: [
                {
                  severity: 'high',
                  lineHint: 'wallet.mjs:2',
                  issueRu: 'Обращение к balance.amount.missing у числового аргумента balance',
                  fixPromptRu: 'Исправь вычитание balance - amount в wallet.mjs',
                },
              ],
            }),
          },
        },
      };
    };

    const s = new BackgroundSentinel({ cacheDir: tmpCache });
    const firstPass = await s.runIdleLocalBugBotPass(tmpWs, null, { httpJsonFn: mockHttpJson });
    assert.equal(firstPass.ok, true);
    assert.equal(gpuCalls, 1);
    assert.equal(firstPass.findingsCount, 1);
    assert.ok(firstPass.reviewedDiffHash.length === 64);

    // Second pass with identical git diff MUST skip GPU via SHA-256 deduplication
    const secondPass = await s.runIdleLocalBugBotPass(tmpWs, null, { httpJsonFn: mockHttpJson });
    assert.equal(secondPass.ok, true);
    assert.equal(secondPass.dedupSkipped, true);
    assert.equal(gpuCalls, 1);

    // Verify cached snapshot reader & clear_findings action
    const cachedSnap = readCachedSentinelSnapshot(tmpWs, null, { cacheDir: tmpCache });
    assert.equal(cachedSnap.bugBot.findingsCount, 1);

    const afterClear = await s.runAction({ action: 'clear_findings', wsPath: tmpWs });
    assert.equal(afterClear.bugBot.findingsCount, 0);
    assert.deepEqual(afterClear.bugBot.findings, []);
  } finally {
    try { fs.rmSync(tmpWs, { recursive: true, force: true, maxRetries: 10, retryDelay: 60 }); } catch {}
    try { fs.rmSync(tmpCache, { recursive: true, force: true, maxRetries: 10, retryDelay: 60 }); } catch {}
  }
});

test('5. Engine C & D: Symbol Cards SHA-256 persistence + bilingual search + Speculative Context hit', async () => {
  const tmpWs = makeTempDir('amr-sentinel-cards-');
  const tmpCache = makeTempDir('amr-sentinel-cacheCD-');

  try {
    fs.writeFileSync(
      path.join(tmpWs, 'sessionVault.mjs'),
      'export function rotateAuthSessionToken(userId) {\n  return `tok_${userId}`;\n}\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmpWs, 'billingCalc.mjs'),
      'export function calculateInvoiceVat(amount) {\n  return amount * 0.2;\n}\n',
      'utf8'
    );

    const ramEng = new RamMemoryEngine({ budgetMb: 32 });
    await ramEng.warmWorkspaceAsync(tmpWs, { startWatcher: false });

    let cardGpuCalls = 0;
    const mockCardHttp = async (_m, _u, body) => {
      cardGpuCalls += 1;
      const content = body?.messages?.[1]?.content || '';
      if (content.includes('sessionVault.mjs')) {
        return {
          ok: true,
          data: {
            message: {
              content: JSON.stringify({
                purposeRu: 'Ротация токенов авторизации и защита сессий пользователя.',
                purposeEn: 'Rotates authentication session tokens and guards user sessions.',
                keyContracts: 'rotateAuthSessionToken(userId)',
              }),
            },
          },
        };
      }
      return {
        ok: true,
        data: {
          message: {
            content: JSON.stringify({
              purposeRu: 'Расчёт НДС и итоговой суммы счёта.',
              purposeEn: 'Calculates VAT tax for billing invoices.',
              keyContracts: 'calculateInvoiceVat(amount)',
            }),
          },
        },
      };
    };

    const s = new BackgroundSentinel({ cacheDir: tmpCache });
    const pass1 = await s.runIdleSymbolCardsPass(tmpWs, ramEng, { maxFiles: 5, httpJsonFn: mockCardHttp });
    assert.equal(pass1.ok, true);
    assert.equal(pass1.indexedNow, 2);
    assert.equal(cardGpuCalls, 2);

    // Re-running without file mutations skips all LLM calls via SHA-256 match
    const pass2 = await s.runIdleSymbolCardsPass(tmpWs, ramEng, { maxFiles: 5, httpJsonFn: mockCardHttp });
    assert.equal(pass2.ok, true);
    assert.equal(pass2.indexedNow, 0);
    assert.equal(cardGpuCalls, 2);

    // Bilingual RU search hits sessionVault.mjs via Russian description & lexicon stems
    const ruHits = s.searchSymbolCardsLexical(tmpWs, 'ротация токенов авторизации сессий', { topK: 3 });
    assert.ok(ruHits.length >= 1);
    assert.equal(ruHits[0].file, 'sessionVault.mjs');

    // Engine D: Speculative Warm (debounced) + Jaccard >= 0.65 consumption
    await s.scheduleSpeculativeWarm(tmpWs, 'обнови rotateAuthSessionToken в sessionVault.mjs', ramEng, { delayMs: 30 });

    const specHit = s.consumeSpeculativeContext(tmpWs, 'обнови rotateAuthSessionToken в sessionVault.mjs сейчас');
    assert.equal(specHit.hit, true);
    assert.match(specHit.goldContextHint, /sessionVault\.mjs/);

    const snap = s.getStatusSnapshot(tmpWs, ramEng);
    assert.equal(snap.speculativeHits, 1);
    assert.equal(snap.symbolCards.indexedFiles, 2);
    assert.equal(snap.symbolCards.coveragePct, 100);
  } finally {
    try { fs.rmSync(tmpWs, { recursive: true, force: true, maxRetries: 10, retryDelay: 60 }); } catch {}
    try { fs.rmSync(tmpCache, { recursive: true, force: true, maxRetries: 10, retryDelay: 60 }); } catch {}
  }
});

test('6. Engine E: Opt-in Shadow Micro-Tests default-off guard + instant P0 child preemption', async () => {
  const tmpWs = makeTempDir('amr-sentinel-tests-');
  const tmpCache = makeTempDir('amr-sentinel-cacheE-');

  try {
    const testsDir = path.join(tmpWs, 'tests');
    fs.mkdirSync(testsDir, { recursive: true });
    const slowTestFile = path.join(testsDir, 'slow-worker.test.mjs');
    fs.writeFileSync(
      slowTestFile,
      'import test from "node:test";\ntest("slow", async () => { await new Promise((r) => setTimeout(r, 4000)); });\n',
      'utf8'
    );

    // 1) Default sentinelShadowTests: false MUST NOT run tests
    const defaultSentinel = new BackgroundSentinel({
      cacheDir: tmpCache,
      stateOverride: { sentinelEnabled: true, sentinelShadowTests: false },
    });
    const skipped = await defaultSentinel.runIdleShadowMicroTests(tmpWs);
    assert.equal(skipped.skipped, true);
    assert.equal(skipped.enabled, false);

    // 2) Opt-in sentinelShadowTests: true spawns child runner and preempt() kills it immediately
    const optInSentinel = new BackgroundSentinel({
      cacheDir: tmpCache,
      stateOverride: { sentinelEnabled: true, sentinelShadowTests: true },
    });

    const t0 = Date.now();
    const runPromise = optInSentinel.runIdleShadowMicroTests(tmpWs, {
      testFiles: [slowTestFile],
      timeoutMs: 6000,
    });

    await new Promise((r) => setTimeout(r, 120));
    const preemptRes = optInSentinel.preempt('user_prompt_p0');
    const finalRun = await runPromise;
    const elapsed = Date.now() - t0;

    assert.equal(preemptRes.preempted, true);
    assert.equal(finalRun.aborted, true);
    assert.equal(finalRun.lastStatus, 'preempted');
    assert.ok(elapsed < 1800, `Preempted test child must terminate quickly (took ${elapsed}ms)`);

    const snap = optInSentinel.getStatusSnapshot(tmpWs);
    assert.equal(snap.state, 'preempted');
    assert.ok(snap.preemptedCount >= 1);
  } finally {
    try { fs.rmSync(tmpWs, { recursive: true, force: true, maxRetries: 10, retryDelay: 60 }); } catch {}
    try { fs.rmSync(tmpCache, { recursive: true, force: true, maxRetries: 10, retryDelay: 60 }); } catch {}
  }
});

test('7. Cross-module UI/Server/Sentinel contracts: force re-run after clear_findings & UI finding normalizer fields', async () => {
  const tmpWs = makeTempDir('amr-sentinel-contracts-');
  const tmpCache = makeTempDir('amr-sentinel-cache7-');

  try {
    execFileSync('git', ['init'], { cwd: tmpWs, windowsHide: true });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmpWs, windowsHide: true });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmpWs, windowsHide: true });

    const targetFile = path.join(tmpWs, 'calc.mjs');
    fs.writeFileSync(targetFile, 'export const add = (a, b) => a + b;\n', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: tmpWs, windowsHide: true });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: tmpWs, windowsHide: true });
    fs.writeFileSync(targetFile, 'export const add = (a, b) => a.missing + b;\n', 'utf8');

    let bugBotCalls = 0;
    const mockHttpJson = async () => {
      bugBotCalls += 1;
      return {
        ok: true,
        data: {
          message: {
            content: JSON.stringify({
              findings: [
                {
                  severity: 'high',
                  lineHint: 'L1',
                  issueRu: 'Разыменование a.missing в функции add',
                  fixPromptRu: 'Исправь a.missing на числовой аргумент a в calc.mjs',
                },
              ],
            }),
          },
        },
      };
    };

    const s = new BackgroundSentinel({ cacheDir: tmpCache });
    const first = await s.runAction({
      action: 'run_now',
      mode: 'all',
      force: true,
      wsPath: tmpWs,
      httpJsonFn: mockHttpJson,
      cfgOverride: { gpuEnabled: true, sentinelLocalBugBot: true, sentinelSymbolCards: false, sentinelShadowTests: false },
    });
    assert.equal(first.bugBot.findingsCount, 1);
    assert.equal(bugBotCalls, 1);

    const cleared = await s.runAction({ action: 'clear_findings', wsPath: tmpWs });
    assert.equal(cleared.bugBot.findingsCount, 0);
    assert.equal(cleared.bugBot.reviewedDiffHash, '');

    const rerunAfterClear = await s.runAction({
      action: 'run_now',
      mode: 'all',
      force: true,
      wsPath: tmpWs,
      httpJsonFn: mockHttpJson,
      cfgOverride: { gpuEnabled: true, sentinelLocalBugBot: true, sentinelSymbolCards: false, sentinelShadowTests: false },
    });
    assert.equal(rerunAfterClear.bugBot.findingsCount, 1);
    assert.equal(bugBotCalls, 2);

    const uiHtml = fs.readFileSync(path.join(process.cwd(), 'sidecars', 'panel', 'ui.html'), 'utf8');
    assert.match(uiHtml, /rawItem\.issueRu/);
    assert.match(uiHtml, /rawItem\.detailRu/);
    assert.match(uiHtml, /rawItem\.fixPromptRu/);
    assert.match(uiHtml, /rawItem\.partnerFile/);
    assert.match(uiHtml, /rawItem\.lineHint/);

    const serverJs = fs.readFileSync(path.join(process.cwd(), 'sidecars', 'panel', 'server.mjs'), 'utf8');
    assert.match(serverJs, /ALLOWED_SENTINEL_ACTIONS/);
    assert.match(serverJs, /sentinelMod\.sentinel\.runAction\(actionPayload\)/);
  } finally {
    try { fs.rmSync(tmpWs, { recursive: true, force: true, maxRetries: 10, retryDelay: 60 }); } catch {}
    try { fs.rmSync(tmpCache, { recursive: true, force: true, maxRetries: 10, retryDelay: 60 }); } catch {}
  }
});

test('10. Orchestrator Synergy Persistence: Carbon Medium M/L/XL selector tips & multi-step Post-Scout retention until ask_question', async () => {
  const { evaluateSelectorMatchForTask, normalizeModelProfile } = await import('../core/model-profile.mjs');

  const carbonMed = normalizeModelProfile('Gemini 4 Carbon (Medium)');
  const orchNeon = normalizeModelProfile('Orchestrator (Neon)');
  const orchCarbon = normalizeModelProfile('Orchestrator (Carbon)');

  // 1) Standalone Carbon Medium surfaces Orchestrator recommendation across M (auto_balance & flash_dispatcher), L, and XL
  const mAuto = evaluateSelectorMatchForTask({
    modelProfile: carbonMed,
    grade: 'M',
    matrix2D: { breadth: 'moderate', depth: 'integrated', riskMode: 'clear' },
    state: { strategy: 'auto_balance' },
  });
  assert.equal(mAuto.match, 'overprovisioned');
  assert.match(mAuto.tipRu, /Orchestrator \(Neon · Средний\/Высокий\)/);

  const mEcon = evaluateSelectorMatchForTask({
    modelProfile: carbonMed,
    grade: 'M',
    matrix2D: { breadth: 'moderate', depth: 'routine', riskMode: 'clear' },
    state: { strategy: 'flash_dispatcher' },
  });
  assert.equal(mEcon.match, 'overprovisioned');
  assert.match(mEcon.recommendedRu, /Orchestrator \(Neon · Средний\)/);
  assert.match(mEcon.tipRu, /Orchestrator \(Neon · Средний\)/);

  for (const matrix2D of [
    { breadth: 'moderate', depth: 'integrated', riskMode: 'clear' },
    { breadth: 'wide', depth: 'integrated', riskMode: 'clear' },
    { breadth: 'moderate', depth: 'integrated', riskMode: 'critical_blast', isHighBlast: true },
    { breadth: 'moderate', depth: 'deep_arch', riskMode: 'clear' },
  ]) {
    const lCarbon = evaluateSelectorMatchForTask({
      modelProfile: carbonMed,
      grade: 'L',
      matrix2D,
      state: { strategy: 'auto_balance', subscriptionTier: 'ultra' },
    });
    assert.match(lCarbon.tipRu, /Orchestrator \((?:Carbon|Neon) · /, `Expected Orchestrator tip with depth on L for ${JSON.stringify(matrix2D)}`);

    const lOrch = evaluateSelectorMatchForTask({
      modelProfile: orchNeon,
      grade: 'L',
      matrix2D,
      state: { strategy: 'auto_balance', subscriptionTier: 'ultra' },
    });
    assert.equal(lOrch.match, 'optimal');
    assert.equal(lOrch.tipRu, '');
  }

  const xlOrchCarbon = evaluateSelectorMatchForTask({
    modelProfile: orchCarbon,
    grade: 'XL',
    isDeepAuditOrArch: true,
    matrix2D: { breadth: 'wide', depth: 'deep_arch', riskMode: 'critical_blast', isHighBlast: true },
    state: { strategy: 'auto_balance', subscriptionTier: 'ultra' },
  });
  assert.equal(xlOrchCarbon.match, 'optimal');
  assert.equal(xlOrchCarbon.tipRu, '');

  // 2) Multi-step PreInvocation retains Post-Scout Orchestrator reminder across 3+ scout steps until ask_question is called
  const tmpWs = makeTempDir('amr-orch-carry-');
  const convoId = `conv-orch-carry-${process.pid}-${Date.now()}`;
  const turnCachePath = path.join(ROOT_DIR, '.cache', 'pre-invocation-turn.json');
  fs.writeFileSync(path.join(tmpWs, 'modA.mjs'), 'export const a = 1;\n', 'utf8');
  fs.writeFileSync(path.join(tmpWs, 'modB.mjs'), 'export const b = 2;\n', 'utf8');

  const routerCfg = {
    strategy: 'auto_balance',
    confirmBeforeRun: true,
    confirmThreshold: 'ALL',
    orchestratorSmartSynergy: false,
    ramCacheEnabled: false,
    thinkingLimiter: true,
  };
  const prompt = 'Перестрой взаимодействие modA.mjs и modB.mjs с сохранением контрактов';

  try {
    // Step 1: initial user prompt
    await handlePreInvocation(
      { hookEventName: 'PreInvocation', conversationId: convoId, workspacePaths: [tmpWs], lastUserInput: prompt, modelName: 'gemini-4-carbon-medium' },
      routerCfg
    );

    // Step 2 & Step 4: intermediate scout turns with same lastUserInput BEFORE ask_question
    const step2 = await handlePreInvocation(
      { hookEventName: 'PreInvocation', conversationId: convoId, workspacePaths: [tmpWs], lastUserInput: prompt, modelName: 'gemini-4-carbon-medium' },
      routerCfg
    );
    const step4 = await handlePreInvocation(
      { hookEventName: 'PreInvocation', conversationId: convoId, workspacePaths: [tmpWs], lastUserInput: prompt, modelName: 'gemini-4-carbon-medium' },
      routerCfg
    );

    const step2Eph = (step2?.injectSteps || []).map((s) => s.ephemeralMessage || '').join('\n');
    const step4Eph = (step4?.injectSteps || []).map((s) => s.ephemeralMessage || '').join('\n');
    assert.match(step2Eph, /\[Post-Scout AI Triage \| Active Selector: Carbon · Средний\]/);
    assert.match(step4Eph, /\[Post-Scout AI Triage \| Active Selector: Carbon · Средний\]/, 'Post-Scout reminder must survive past step 2');
    assert.match(step4Eph, /Orchestrator \(Neon · Высокий\/XHigh\) \/ Orchestrator \(Carbon · Средний\/Высокий\)/);

    // Call ask_question -> clears Post-Scout reminder on subsequent execution steps
    await handlePreToolUse(
      {
        conversationId: convoId,
        workspacePaths: [tmpWs],
        toolName: 'ask_question',
        modelName: 'gemini-4-carbon-medium',
        args: {
          questions: [
            {
              question: 'План автопилота: обновить modA.mjs и modB.mjs. Объём: M. Рекомендуемая мощность: Orchestrator (Neon · Средний/Высокий). Запускаем?',
              options: [
                '(Recommended) Обновить modA.mjs и modB.mjs + тесты (Orchestrator (Neon · Средний/Высокий))',
                'Обновить только modA.mjs без modB.mjs',
                'Только read-only аудит импортов',
              ],
            },
          ],
        },
      },
      routerCfg
    );

    const postAskStep = await handlePreInvocation(
      { hookEventName: 'PreInvocation', conversationId: convoId, workspacePaths: [tmpWs], lastUserInput: prompt, modelName: 'gemini-4-carbon-medium' },
      routerCfg
    );
    const postAskEph = (postAskStep?.injectSteps || []).map((s) => s.ephemeralMessage || '').join('\n');
    assert.doesNotMatch(postAskEph, /\[Post-Scout AI Triage/);
  } finally {
    try { fs.rmSync(tmpWs, { recursive: true, force: true, maxRetries: 10, retryDelay: 60 }); } catch {}
    try {
      if (fs.existsSync(turnCachePath)) {
        const cur = JSON.parse(fs.readFileSync(turnCachePath, 'utf8'));
        if (cur?.turns && typeof cur.turns === 'object') {
          for (const k of Object.keys(cur.turns)) {
            if (k.startsWith(convoId)) delete cur.turns[k];
          }
          fs.writeFileSync(turnCachePath, JSON.stringify(cur, null, 2), 'utf8');
        }
      }
    } catch {}
  }
});

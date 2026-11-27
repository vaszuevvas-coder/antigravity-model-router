import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  detectPromptIntentSignals,
  estimateTaskGradeAndThinkingBudget,
} from '../core/tool-pruner.mjs';
import { normalizeModelProfile } from '../core/model-profile.mjs';
import {
  handlePreInvocation,
  handlePreToolUse,
  handlePostToolUse,
} from '../core/hook-runner.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const TURN_CACHE_FILE = path.join(ROOT_DIR, '.cache', 'pre-invocation-turn.json');

function cleanupConvoEntry(convoId) {
  try {
    if (!fs.existsSync(TURN_CACHE_FILE)) return;
    const parsed = JSON.parse(fs.readFileSync(TURN_CACHE_FILE, 'utf8'));
    if (parsed?.turns && Object.hasOwn(parsed.turns, convoId)) {
      delete parsed.turns[convoId];
      fs.writeFileSync(TURN_CACHE_FILE, JSON.stringify(parsed, null, 2), 'utf8');
    }
  } catch {}
}

test('1. detectPromptIntentSignals recognizes switch-resume phrases and excludes Variant 1B pause option from approval', () => {
  for (const phrase of ['пуск', '1', '2', 'переключил, пуск', 'модель сменил, 1', 'готово, давай', 'switched, go', 'ready, proceed']) {
    const sig = detectPromptIntentSignals(phrase);
    assert.equal(sig.isApprovalFollowUp, true, `Expected isApprovalFollowUp=true for "${phrase}"`);
  }

  const pauseOption = detectPromptIntentSignals(
    'A1: ⏸ Завершить ход, чтобы я переключил модель на Orchestrator (Neon · Высокий)'
  );
  assert.equal(pauseOption.isApprovalFollowUp, false);

  const pauseOptionEn = detectPromptIntentSignals(
    'A1: ⏸ End turn so I can switch model to Orchestrator (Neon · High)'
  );
  assert.equal(pauseOptionEn.isApprovalFollowUp, false);
});

test('2. estimateTaskGradeAndThinkingBudget emits Split-Turn (1A + 1B) only on selector mismatch and resumes cleanly on prevModelSwitchPending', () => {
  // Mismatch: Hydrogen Medium on XL deep architecture task
  const mismatch = estimateTaskGradeAndThinkingBudget(
    'Переделай архитектуру всего роутера, кэширования и контрактов модулей с миграцией схемы',
    { confirmBeforeRun: true, confirmThreshold: 'ALL', uiLanguage: 'ru' },
    { modelProfile: normalizeModelProfile('Gemini 4 Hydrogen (Medium)') }
  );
  assert.equal(mismatch.modelSwitchSplitTurn, true);
  assert.match(mismatch.budgetHint, /\[Model-Switch Split-Turn \(AGY 2\.35\+\)\]/);
  assert.match(mismatch.optionsBlueprint?.formattedBlueprint || '', /Завершить ход, чтобы я переключил модель/);

  // Optimal match: Hydrogen Medium on simple S task -> no split-turn needed
  const optimal = estimateTaskGradeAndThinkingBudget(
    'Поправь опечатку в заголовке кнопки',
    { confirmBeforeRun: true, confirmThreshold: 'ALL', uiLanguage: 'ru' },
    { modelProfile: normalizeModelProfile('Gemini 4 Hydrogen (Medium)') }
  );
  assert.equal(optimal.modelSwitchSplitTurn, false);
  assert.doesNotMatch(optimal.budgetHint, /\[Model-Switch Split-Turn/);
  assert.doesNotMatch(optimal.optionsBlueprint?.formattedBlueprint || '', /Завершить ход, чтобы я переключил модель/);

  // Resuming after Model-Switch Pause must bypass Two-Phase Plan Gate
  const resumed = estimateTaskGradeAndThinkingBudget(
    'переключил, пуск',
    { confirmBeforeRun: true, confirmThreshold: 'ALL', uiLanguage: 'ru' },
    {
      prevTurnGrade: 'L',
      prevAskQuestionCalled: false,
      prevModelSwitchPending: true,
    }
  );
  assert.equal(resumed.isApprovalFollowUp, true);
  assert.equal(Boolean(resumed.requiresTwoPhaseGate), false);
  assert.match(resumed.budgetHint, /\[Plan Approved Follow-Up \(L\) \| Model-Switch Resumed\]/);
});

test('3. E2E Variant 1A: mismatch arms modelSwitchPending, blocks same-turn edit, and resumes after user switches model', async () => {
  const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-split1a-'));
  const convoId = `split-1a-${Date.now()}`;
  try {
    const targetFile = path.join(tmpWs, 'router.mjs');
    fs.writeFileSync(targetFile, 'export const v = 1;\n', 'utf8');

    const state = {
      confirmBeforeRun: true,
      confirmThreshold: 'ALL',
      orchestratorSmartSynergy: false,
      ramCacheEnabled: false,
      uiLanguage: 'ru',
    };

    // Turn 1: Hydrogen Medium on deep architecture task -> mismatch
    const t1 = await handlePreInvocation(
      {
        hookEventName: 'PreInvocation',
        conversationId: convoId,
        workspacePaths: [tmpWs],
        lastUserInput: 'Переделай архитектуру всего роутера, кэширования и контрактов модулей с миграцией схемы',
        modelName: 'Gemini 4 Hydrogen (Medium)',
      },
      state
    );
    const t1Text = (t1?.injectSteps || []).map((s) => s?.ephemeralMessage || s?.systemMessage?.systemMessage || '').join('\n');
    assert.match(t1Text, /\[Model-Switch Split-Turn \(AGY 2\.35\+\)\]/);

    // Same-turn edit attempt is blocked with Model-Switch Gate Guard
    const denyEdit = await handlePreToolUse(
      {
        conversationId: convoId,
        workspacePaths: [tmpWs],
        toolCall: {
          name: 'edit_file',
          args: { Path: targetFile, Target: 'v = 1', Replacement: 'v = 2' },
        },
      },
      state
    );
    assert.equal(denyEdit.decision, 'deny');
    assert.match(denyEdit.reason, /Model-Switch Gate Guard/);

    // Turn 2: User switched model in unlocked selector and sends "переключил, пуск"
    const t2 = await handlePreInvocation(
      {
        hookEventName: 'PreInvocation',
        conversationId: convoId,
        workspacePaths: [tmpWs],
        lastUserInput: 'переключил, пуск',
        modelName: 'Orchestrator (Gemini 4 Neon High)',
      },
      state
    );
    const t2Text = (t2?.injectSteps || []).map((s) => s?.ephemeralMessage || s?.systemMessage?.systemMessage || '').join('\n');
    assert.match(t2Text, /Model-Switch Resumed/);

    const allowEdit = await handlePreToolUse(
      {
        conversationId: convoId,
        workspacePaths: [tmpWs],
        toolCall: {
          name: 'edit_file',
          args: { Path: targetFile, Target: 'v = 1', Replacement: 'v = 2' },
        },
      },
      state
    );
    assert.equal(allowEdit.decision, 'allow');
  } finally {
    cleanupConvoEntry(convoId);
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
});

test('4. E2E Variant 1B: ask_question pause option arms modelSwitchPending in PostToolUse, blocks same-turn edit, and resumes next turn', async () => {
  const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-split1b-'));
  const convoId = `split-1b-${Date.now()}`;
  try {
    const targetFile = path.join(tmpWs, 'app.mjs');
    fs.writeFileSync(targetFile, 'export const a = 1;\n', 'utf8');

    const state = {
      confirmBeforeRun: true,
      confirmThreshold: 'ALL',
      orchestratorSmartSynergy: false,
      ramCacheEnabled: false,
      uiLanguage: 'ru',
    };

    await handlePreInvocation(
      {
        hookEventName: 'PreInvocation',
        conversationId: convoId,
        workspacePaths: [tmpWs],
        lastUserInput: 'Отредактируй app.mjs и добавь новую функцию',
        modelName: 'Gemini 4 Hydrogen (Medium)',
      },
      state
    );

    const askArgs = {
      questions: [
        {
          question: 'План автопилота: обновить app.mjs. Объём: M. Рекомендуемая мощность: Hydrogen · Средний. Запускаем?',
          options: [
            '(Recommended) Вариант 1',
            'Вариант 2',
            '⏸ Завершить ход, чтобы я переключил модель на Orchestrator (Neon · Высокий)',
          ],
        },
      ],
    };

    const preAsk = await handlePreToolUse(
      {
        conversationId: convoId,
        workspacePaths: [tmpWs],
        toolCall: { name: 'ask_question', args: askArgs },
      },
      state
    );
    assert.equal(preAsk.decision, 'allow');

    await handlePostToolUse(
      {
        conversationId: convoId,
        workspacePaths: [tmpWs],
        toolCall: { name: 'ask_question', args: askArgs },
        output: 'A1: ⏸ Завершить ход, чтобы я переключил модель на Orchestrator (Neon · Высокий)',
      },
      state
    );

    // Same-turn edit after choosing Pause must be blocked
    const denySameTurn = await handlePreToolUse(
      {
        conversationId: convoId,
        workspacePaths: [tmpWs],
        toolCall: {
          name: 'edit_file',
          args: { Path: targetFile, Target: 'a = 1', Replacement: 'a = 2' },
        },
      },
      state
    );
    assert.equal(denySameTurn.decision, 'deny');
    assert.match(denySameTurn.reason, /Model-Switch Gate Guard/);

    // Next turn after switching model: "пуск" -> allowed immediately
    const t2 = await handlePreInvocation(
      {
        hookEventName: 'PreInvocation',
        conversationId: convoId,
        workspacePaths: [tmpWs],
        lastUserInput: 'пуск',
        modelName: 'Orchestrator (Gemini 4 Neon High)',
      },
      state
    );
    const t2Text = (t2?.injectSteps || []).map((s) => s?.ephemeralMessage || s?.systemMessage?.systemMessage || '').join('\n');
    assert.match(t2Text, /Model-Switch Resumed/);

    const allowNextTurn = await handlePreToolUse(
      {
        conversationId: convoId,
        workspacePaths: [tmpWs],
        toolCall: {
          name: 'edit_file',
          args: { Path: targetFile, Target: 'a = 1', Replacement: 'a = 2' },
        },
      },
      state
    );
    assert.equal(allowNextTurn.decision, 'allow');
  } finally {
    cleanupConvoEntry(convoId);
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
});

test('5. PostToolUse ask_question fallback on IDE "user cancelled ask_question" emits chat fallback directive and preserves askQuestionCalled', async () => {
  const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-ask-cancel-'));
  const convoId = `ask-cancel-${Date.now()}`;
  try {
    const state = {
      confirmBeforeRun: true,
      confirmThreshold: 'ALL',
      orchestratorSmartSynergy: false,
      ramCacheEnabled: false,
      uiLanguage: 'ru',
    };

    await handlePreInvocation(
      {
        hookEventName: 'PreInvocation',
        conversationId: convoId,
        workspacePaths: [tmpWs],
        lastUserInput: 'Исправь баг в server.mjs',
        modelName: 'Gemini 4 Hydrogen (Medium)',
      },
      state
    );

    const postRes = await handlePostToolUse(
      {
        conversationId: convoId,
        workspacePaths: [tmpWs],
        toolCall: { name: 'ask_question', args: { questions: [{ question: 'План?', options: ['1', '2', '3'] }] } },
        error: 'user cancelled ask_question',
      },
      state
    );
    assert.match(String(postRes?.systemMessage || ''), /ask_question Fallback/);
    assert.match(String(postRes?.systemMessage || ''), /НЕ пиши «Запуск правок отменён»/);

    const t2 = await handlePreInvocation(
      {
        hookEventName: 'PreInvocation',
        conversationId: convoId,
        workspacePaths: [tmpWs],
        lastUserInput: '1',
        modelName: 'Gemini 4 Hydrogen (Medium)',
      },
      state
    );
    const t2Text = (t2?.injectSteps || []).map((s) => s?.ephemeralMessage || s?.systemMessage?.systemMessage || '').join('\n');
    assert.doesNotMatch(t2Text, /Two-Phase Plan Gate/);

    const targetFile = path.join(tmpWs, 'app.mjs');
    fs.writeFileSync(targetFile, 'export const a = 1;\n', 'utf8');
    const allowEdit = await handlePreToolUse(
      {
        conversationId: convoId,
        workspacePaths: [tmpWs],
        toolCall: {
          name: 'edit_file',
          args: { Path: targetFile, Target: 'a = 1', Replacement: 'a = 2' },
        },
      },
      state
    );
    assert.equal(allowEdit.decision, 'allow');
  } finally {
    cleanupConvoEntry(convoId);
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
});

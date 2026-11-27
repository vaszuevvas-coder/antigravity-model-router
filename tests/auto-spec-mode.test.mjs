import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  resolveAutoSpecMode,
  resolveAutoSpecOutput,
  buildAutoSpecDirective,
  estimateTaskGradeAndThinkingBudget,
} from '../core/tool-pruner.mjs';
import {
  DEFAULT_STATE,
  ALLOWED_STATE_KEYS,
  sanitizeStatePatch,
} from '../sidecars/panel/lib/panel-state-skills.mjs';

test('autoSpecMode: state schema, prompt overrides, directive gating & Panel UI sync', () => {
  assert.equal(DEFAULT_STATE.autoSpecMode, 'auto');
  assert.equal(DEFAULT_STATE.autoSpecOutput, 'thinking');
  assert.equal(ALLOWED_STATE_KEYS.has('autoSpecMode'), true);
  assert.equal(ALLOWED_STATE_KEYS.has('autoSpecOutput'), true);
  assert.equal(sanitizeStatePatch({ autoSpecMode: 'always' }).autoSpecMode, 'always');
  assert.equal(sanitizeStatePatch({ autoSpecMode: 'off' }).autoSpecMode, 'off');
  assert.equal(Object.hasOwn(sanitizeStatePatch({ autoSpecMode: 'invalid_mode' }), 'autoSpecMode'), false);
  assert.equal(sanitizeStatePatch({ autoSpecOutput: 'chat' }).autoSpecOutput, 'chat');
  assert.equal(sanitizeStatePatch({ autoSpecOutput: 'thinking' }).autoSpecOutput, 'thinking');
  assert.equal(Object.hasOwn(sanitizeStatePatch({ autoSpecOutput: 'invalid_output' }), 'autoSpecOutput'), false);

  assert.equal(resolveAutoSpecMode('Обычная задача', { autoSpecMode: 'auto' }), 'auto');
  assert.equal(resolveAutoSpecMode('/spec переделай роутер', { autoSpecMode: 'off' }), 'always');
  assert.equal(resolveAutoSpecMode('/autospec off почини отступ', { autoSpecMode: 'always' }), 'off');
  assert.equal(resolveAutoSpecMode('сделай быстро без авто-тз', { autoSpecMode: 'always' }), 'off');
  assert.equal(resolveAutoSpecMode('/autospec chat почини кэш', { autoSpecMode: 'off' }), 'always');

  assert.equal(resolveAutoSpecOutput('Обычная задача', {}), 'thinking');
  assert.equal(resolveAutoSpecOutput('Обычная задача', { autoSpecOutput: 'chat' }), 'chat');
  assert.equal(resolveAutoSpecOutput('/autospec chat почини кэш', { autoSpecOutput: 'thinking' }), 'chat');
  assert.equal(resolveAutoSpecOutput('/autospec thinking почини кэш', { autoSpecOutput: 'chat' }), 'thinking');

  assert.equal(buildAutoSpecDirective({ mode: 'off', grade: 'L' }), '');
  assert.equal(buildAutoSpecDirective({ mode: 'auto', grade: 'S', isDeepAuditOrArch: false }), '');
  assert.equal(buildAutoSpecDirective({ mode: 'always', grade: 'L', isReadOnlyQuestion: true }), '');
  assert.match(buildAutoSpecDirective({ mode: 'auto', grade: 'M' }), /\[Internal Spec-First \(auto · M\)\]/);
  assert.match(buildAutoSpecDirective({ mode: 'always', grade: 'S' }), /\[Internal Spec-First \(always · S\)\]/);
  assert.match(buildAutoSpecDirective({ mode: 'always', output: 'chat', grade: 'S' }), /\[Internal Spec-First \(always · S · chat\)\]/);
  assert.match(buildAutoSpecDirective({ mode: 'always', output: 'chat', grade: 'S' }), /output a compact detailed execution prompt in chat/);

  const triageM = estimateTaskGradeAndThinkingBudget(
    'Добавь кеширование и валидацию в core/tool-pruner.mjs и core/hook-runner.mjs',
    { confirmBeforeRun: true, confirmThreshold: 'M', autoSpecMode: 'auto' },
    {}
  );
  assert.equal(triageM.autoSpecMode, 'auto');
  assert.equal(triageM.autoSpecOutput, 'thinking');
  assert.match(triageM.budgetHint, /\[Internal Spec-First \(auto · /);

  const triageChat = estimateTaskGradeAndThinkingBudget(
    'Поправь кэш в панели',
    { confirmBeforeRun: true, confirmThreshold: 'M', autoSpecMode: 'always', autoSpecOutput: 'chat' },
    {}
  );
  assert.equal(triageChat.autoSpecMode, 'always');
  assert.equal(triageChat.autoSpecOutput, 'chat');
  assert.match(triageChat.budgetHint, /\[Internal Spec-First \(always · .* · chat\)\]/);

  const triageOff = estimateTaskGradeAndThinkingBudget(
    'Добавь кеширование и валидацию в core/tool-pruner.mjs и core/hook-runner.mjs',
    { confirmBeforeRun: true, confirmThreshold: 'M', autoSpecMode: 'off' },
    {}
  );
  assert.equal(triageOff.autoSpecMode, 'off');
  assert.doesNotMatch(triageOff.budgetHint, /\[Internal Spec-First/);

  const uiHtml = fs.readFileSync(path.resolve('sidecars/panel/ui.html'), 'utf8');
  assert.ok(uiHtml.includes('id="autoSpecModeGroup"'));
  assert.ok(uiHtml.includes('id="autoSpecModeHint"'));
  assert.ok(uiHtml.includes('data-action="setAutoSpecMode"'));
  assert.ok(uiHtml.includes('id="autoSpecOutputGroup"'));
  assert.ok(uiHtml.includes('data-action="setAutoSpecOutput"'));
});

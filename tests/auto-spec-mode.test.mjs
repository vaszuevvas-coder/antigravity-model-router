import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  resolveAutoSpecMode,
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
  assert.equal(ALLOWED_STATE_KEYS.has('autoSpecMode'), true);
  assert.equal(sanitizeStatePatch({ autoSpecMode: 'always' }).autoSpecMode, 'always');
  assert.equal(sanitizeStatePatch({ autoSpecMode: 'off' }).autoSpecMode, 'off');
  assert.equal(Object.hasOwn(sanitizeStatePatch({ autoSpecMode: 'invalid_mode' }), 'autoSpecMode'), false);

  assert.equal(resolveAutoSpecMode('Обычная задача', { autoSpecMode: 'auto' }), 'auto');
  assert.equal(resolveAutoSpecMode('/spec переделай роутер', { autoSpecMode: 'off' }), 'always');
  assert.equal(resolveAutoSpecMode('/autospec off почини отступ', { autoSpecMode: 'always' }), 'off');
  assert.equal(resolveAutoSpecMode('сделай быстро без авто-тз', { autoSpecMode: 'always' }), 'off');

  assert.equal(buildAutoSpecDirective({ mode: 'off', grade: 'L' }), '');
  assert.equal(buildAutoSpecDirective({ mode: 'auto', grade: 'S', isDeepAuditOrArch: false }), '');
  assert.equal(buildAutoSpecDirective({ mode: 'always', grade: 'L', isReadOnlyQuestion: true }), '');
  assert.match(buildAutoSpecDirective({ mode: 'auto', grade: 'M' }), /\[Internal Spec-First \(auto · M\)\]/);
  assert.match(buildAutoSpecDirective({ mode: 'always', grade: 'S' }), /\[Internal Spec-First \(always · S\)\]/);

  const triageM = estimateTaskGradeAndThinkingBudget(
    'Добавь кеширование и валидацию в core/tool-pruner.mjs и core/hook-runner.mjs',
    { confirmBeforeRun: true, confirmThreshold: 'M', autoSpecMode: 'auto' },
    {}
  );
  assert.equal(triageM.autoSpecMode, 'auto');
  assert.match(triageM.budgetHint, /\[Internal Spec-First \(auto · /);

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
});

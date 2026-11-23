import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_STATE,
  ALLOWED_STATE_KEYS,
  sanitizeStatePatch,
  normalizeUiLanguageValue,
} from '../sidecars/panel/lib/panel-state-skills.mjs';
import { resolveUserLanguage, handleSessionStart } from '../core/hook-runner.mjs';
import { estimateTaskGradeAndThinkingBudget } from '../core/tool-pruner.mjs';
import { buildPanelUi } from '../core/panel-ui-builder.mjs';
import { sanitizeMergedState } from '../install.js';
import { createSanitizedDefaultState } from '../scripts/pack-release.mjs';

test('1. State schema & defaults: fresh installs default to EN, sanitize accepts en/ru only', () => {
  assert.equal(DEFAULT_STATE.uiLanguage, 'en');
  assert.equal(ALLOWED_STATE_KEYS.has('uiLanguage'), true);
  assert.equal(normalizeUiLanguageValue('EN'), 'en');
  assert.equal(normalizeUiLanguageValue('ru'), 'ru');
  assert.equal(normalizeUiLanguageValue('de'), null);

  assert.deepEqual(sanitizeStatePatch({ uiLanguage: 'en' }), { uiLanguage: 'en' });
  assert.deepEqual(sanitizeStatePatch({ uiLanguage: 'ru' }), { uiLanguage: 'ru' });
  assert.deepEqual(sanitizeStatePatch({ uiLanguage: 'fr' }), {});

  const releaseState = createSanitizedDefaultState({});
  assert.equal(releaseState.uiLanguage, 'en');

  assert.equal(sanitizeMergedState({ uiLanguage: 'ru' }).uiLanguage, 'ru');
  assert.equal(sanitizeMergedState({ uiLanguage: 'en' }).uiLanguage, 'en');
});

test('2. Hook-runner & tool-pruner: dynamic EN vs RU SessionStart banner & Pre-Task Gate', async () => {
  assert.equal(resolveUserLanguage({ uiLanguage: 'en' }), 'en');
  assert.equal(resolveUserLanguage({ uiLanguage: 'ru' }), 'ru');
  assert.equal(resolveUserLanguage({}), 'ru');

  const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-i18n-'));
  try {
    const enSession = await handleSessionStart(
      { workspacePath: tmpWs, conversationId: 'i18n-en-sess' },
      { uiLanguage: 'en', repoMap: false, pitfallLedger: false, sessionHandoff: false }
    );
    const enMsg = String(enSession?.systemMessage || enSession?.additionalContext || JSON.stringify(enSession));
    assert.match(enMsg, /EN-Internal \/ EN-Chat/);
    assert.match(enMsg, /100% English/);

    const ruSession = await handleSessionStart(
      { workspacePath: tmpWs, conversationId: 'i18n-ru-sess' },
      { uiLanguage: 'ru', repoMap: false, pitfallLedger: false, sessionHandoff: false }
    );
    const ruMsg = String(ruSession?.systemMessage || ruSession?.additionalContext || JSON.stringify(ruSession));
    assert.match(ruMsg, /EN-Internal \/ RU-Chat/);
    assert.match(ruMsg, /100% Russian/);
  } finally {
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }

  const enBudget = estimateTaskGradeAndThinkingBudget(
    'Refactor authentication middleware and update session routes across server.mjs and auth.mjs',
    { uiLanguage: 'en', confirmBeforeRun: true, confirmThreshold: 'M', orchestratorSmartSynergy: false },
    { modelProfile: { family: 'neon', displayRu: 'Neon · Средний' } }
  );
  assert.match(enBudget.budgetHint || '', /EN chat/);
  assert.match(enBudget.budgetHint || '', /"Scope"/);
  assert.match(enBudget.budgetHint || '', /"💡 Mode tip"/);

  const ruBudget = estimateTaskGradeAndThinkingBudget(
    'Refactor authentication middleware and update session routes across server.mjs and auth.mjs',
    { uiLanguage: 'ru', confirmBeforeRun: true, confirmThreshold: 'M', orchestratorSmartSynergy: false },
    { modelProfile: { family: 'neon', displayRu: 'Neon · Средний' } }
  );
  assert.match(ruBudget.budgetHint || '', /RU chat/);
  assert.match(ruBudget.budgetHint || '', /"Объём"/);
});

test('3. Panel UI build includes 00-i18n.js and stays in sync', () => {
  const res = buildPanelUi({ checkOnly: true });
  assert.equal(res.ok, true);
  assert.equal(res.inSync, true);
  assert.ok(Array.isArray(res.jsFiles) && res.jsFiles[0] === '00-i18n.js');
});

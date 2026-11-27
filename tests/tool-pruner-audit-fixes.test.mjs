import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAdaptive3DOptionsBlueprint,
  buildAutoSpecDirective,
  buildGrillMeDirective,
  classifyTaskAndPruneTools,
  compileUserIntentToTechSpec,
  compileVoiceOrLongRuPromptPivot,
  computeStructuralComplexity,
  computeTask3DMatrix,
  detectGrillMeSignals,
  detectPromptIntentSignals,
  estimateCodebaseScope,
  estimateTaskGradeAndThinkingBudget,
} from '../core/tool-pruner.mjs';

test('1. Null/invalid state, options, signals, and array skillModes never throw TypeError and preserve contract', () => {
  assert.doesNotThrow(() => classifyTaskAndPruneTools('Обнови css кнопки', null, null));
  const prunedNull = classifyTaskAndPruneTools('Обнови css кнопки', { skillModes: ['off'] }, null);
  assert.equal(typeof prunedNull.domain, 'string');
  assert.ok(Array.isArray(prunedNull.matchedSkills));

  assert.doesNotThrow(() => estimateCodebaseScope('Почини core/tool-pruner.mjs', null));
  assert.doesNotThrow(() => compileUserIntentToTechSpec('Почини core/tool-pruner.mjs', null));
  assert.doesNotThrow(() => compileVoiceOrLongRuPromptPivot('Почини core/tool-pruner.mjs', null));
  assert.doesNotThrow(() => computeStructuralComplexity({ signals: null, subsystemHits: Number.NaN }));
  assert.doesNotThrow(() => computeTask3DMatrix({ promptText: 'Почини баг', signals: null, fragilityDepthBoost: Number.NaN }));
  assert.doesNotThrow(() => buildAdaptive3DOptionsBlueprint(null));
  assert.doesNotThrow(() => buildAdaptive3DOptionsBlueprint({ state: null }));
  assert.doesNotThrow(() => detectGrillMeSignals('Сделай фичу', null, null));
  assert.doesNotThrow(() => buildGrillMeDirective(null));
  assert.doesNotThrow(() => buildAutoSpecDirective(null));

  const emptySig = detectPromptIntentSignals('');
  assert.equal(Object.hasOwn(emptySig, 'isArtifactDocApproval'), true);
  assert.equal(emptySig.isArtifactDocApproval, false);

  const disabledBudget = estimateTaskGradeAndThinkingBudget('Исправь баг', null, null);
  assert.equal(disabledBudget.grade, 'M');

  const offBudget = estimateTaskGradeAndThinkingBudget('Исправь баг', { thinkingLimiter: false }, null);
  assert.equal(offBudget.grade, 'M');
  assert.equal(offBudget.isApprovalFollowUp, false);
  assert.equal(offBudget.isReadOnlyQuestion, false);
  assert.ok(offBudget.scope && Array.isArray(offBudget.scope.matchedFiles));
  assert.ok(offBudget.selectorEval && offBudget.selectorEval.match === 'optimal');
});

test('2. estimateCodebaseScope isolates malformed repoMapper items, NaN endLine, cold cache semanticFiles & Windows deps', () => {
  const mockMapper = {
    getCachedRepoMap: () => ({
      filesIndex: [
        null,
        { file: null },
        { file: 'core\\alpha.mjs', symbolsWithRanges: [null, { endLine: 'bad-line' }, { endLine: 260 }] },
        { file: 'core/beta.mjs', symbolsWithRanges: [{ endLine: 120 }] },
      ],
    }),
    rankRepoByPageRank: () => ({
      rankedFiles: [
        { file: null, seedHits: 3, directScore: 10 },
        { file: 'core\\alpha.mjs', seedHits: 2, directScore: 9, matchedSymbols: [{ name: 'runAlpha' }] },
        { file: 'core/beta.mjs', seedHits: 2, directScore: 8, matchedSymbols: [{ name: 'runBeta' }] },
      ],
    }),
    findReverseImporters: () => ({
      dependents: [
        { file: 'core\\shared-caller.mjs' },
        { file: './core/shared-caller.mjs' },
        { file: 'core/other-caller.mjs' },
      ],
    }),
  };

  const scopeRes = estimateCodebaseScope('Доработай runAlpha и runBeta', {
    wsPath: 'C:\\repo',
    repoMapper: mockMapper,
  });
  assert.equal(scopeRes.matchedFiles.length, 2);
  assert.equal(scopeRes.matchedFiles[0].lines, 260);
  assert.equal(scopeRes.totalReverseDependents, 2);

  // Cold cache (getCachedRepoMap -> null) still sorts & accepts semanticFiles
  const coldMapper = {
    getCachedRepoMap: () => null,
    rankRepoByPageRank: () => ({ rankedFiles: [] }),
  };
  const semRes = estimateCodebaseScope('Оптимизируй обработку состояния роутера', {
    wsPath: 'C:\\repo',
    repoMapper: coldMapper,
    semanticFiles: [
      { file: 'core\\low.mjs', score: 0.62 },
      { file: 'core\\high.mjs', score: 0.91 },
      { file: 'core\\mid.mjs', score: 0.88 },
    ],
  });
  assert.equal(semRes.matchedFiles[0].file, 'core/high.mjs');
  assert.equal(semRes.matchedFiles[1].file, 'core/mid.mjs');
});

test('3. compileUserIntentToTechSpec supports Windows backslash paths, root files & deduplication', () => {
  const res = compileUserIntentToTechSpec(
    'Исправь обработку путей в core\\tool-pruner.mjs, package.json и тестах tests\\tool-pruner-audit-fixes.test.mjs',
    { forceAlways: true }
  );
  assert.ok(res.targetFiles.includes('core/tool-pruner.mjs'));
  assert.ok(res.targetFiles.includes('package.json'));
  assert.ok(res.targetFiles.includes('tests/tool-pruner-audit-fixes.test.mjs'));
  assert.ok(res.verifyHints.includes('tests/tool-pruner-audit-fixes.test.mjs'));

  const winTestDirRes = compileUserIntentToTechSpec(
    'Добавь регрессионный хелпер в tests\\helpers.mjs и core\\tool-pruner.mjs',
    { forceAlways: true }
  );
  assert.ok(winTestDirRes.verifyHints.includes('tests/helpers.mjs'));
});

test('4. Multi-question A1+A2 (>450 chars), Grill-Me opt-in in A2, artifact ? & follow-up state machine', () => {
  const longA1DeclineA2 = [
    `A1: (Recommended) Целевая реализация исправлений в ${'core/tool-pruner.mjs '.repeat(22)}с автотестами и проверкой контрактов`,
    'A2: (Recommended) Нет, ТЗ понятное — сразу выполнять выбранный план',
  ].join('\n');
  assert.ok(longA1DeclineA2.length > 450);
  const sigDecline = detectPromptIntentSignals(longA1DeclineA2);
  assert.equal(sigDecline.isApprovalFollowUp, true);

  const a1WithGrillOptIn = [
    'A1: (Recommended) Целевая реализация в core/tool-pruner.mjs',
    'A2: Да, полный Grill-Me (дерево решений + фиксация в SPEC.md)',
  ].join('\n');
  const sigGrill = detectPromptIntentSignals(a1WithGrillOptIn);
  assert.equal(sigGrill.isApprovalFollowUp, false);
  const grillRes = estimateTaskGradeAndThinkingBudget(
    a1WithGrillOptIn,
    { confirmBeforeRun: true, confirmThreshold: 'M', grillMode: 'auto' },
    { prevTurnGrade: 'L', prevAskQuestionCalled: true }
  );
  assert.equal(grillRes.isApprovalFollowUp, false);
  assert.equal(grillRes.grillMe?.mode, 'explicit');

  const docWithQuestions = 'Comments on artifact URI: file:///plan.md\nIs retry backoff safe?\n\nThe user has approved this document.\n';
  assert.equal(detectPromptIntentSignals(docWithQuestions).isArtifactDocApproval, true);
  assert.equal(detectPromptIntentSignals(docWithQuestions).isApprovalFollowUp, true);

  // Smart-Synergy S/M bypass or confirmBeforeRun: false must still honor approval follow-up
  const silentFollow = estimateTaskGradeAndThinkingBudget(
    'ок, делаем',
    { confirmBeforeRun: false },
    { prevTurnGrade: 'M', prevProposedGrade: 'L', prevAskQuestionCalled: false }
  );
  assert.equal(silentFollow.isApprovalFollowUp, true);
  assert.equal(silentFollow.grade, 'L');
});

test('5. Weak/unconfident semanticSkills do not mask LEXICAL_SKILL_RULES and undefined score does not break UI gate', () => {
  const res = classifyTaskAndPruneTools(
    'Перед git push проверь репозиторий на утечки секретов и теги',
    { skillModes: {} },
    {
      skillIndexWarm: true,
      semanticSkills: [{ slug: 'ru-docs', score: 0.19, confident: false }],
    }
  );
  assert.equal(res.matchedSkills[0], 'github-publish-guard');
  assert.doesNotMatch(res.allowedHint, /ru-docs/);
  assert.match(res.allowedHint, /\[Skill Match: github-publish-guard\]/);

  const uiRes = classifyTaskAndPruneTools(
    'Сделай редизайн карточки и палитры',
    { uiDesignPreviewGate: true, skillModes: {} },
    {
      skillIndexWarm: true,
      semanticSkills: [
        { slug: 'custom-helper', confident: true },
        { slug: 'ui-ux-design-system', score: 0.62, deltaVsNone: 0.15, confident: true },
      ],
    }
  );
  assert.equal(uiRes.needsDesignPreviewGate, true);
});

test('6. subscriptionTier consistency in blueprint and fast bounded scanning on 40KB adversarial prompt', () => {
  const bpEmpty = buildAdaptive3DOptionsBlueprint({ state: {} });
  const bpUltraUpper = buildAdaptive3DOptionsBlueprint({ state: { subscriptionTier: 'Ultra' } });
  const bpPro = buildAdaptive3DOptionsBlueprint({ state: { subscriptionTier: 'pro' } });
  assert.match(bpEmpty.slots[0], /Carbon/);
  assert.match(bpUltraUpper.slots[0], /Carbon/);
  assert.doesNotMatch(bpPro.slots[0], /Carbon/);

  const adversarial = `${'напиши '.repeat(4000)}${'a.b.'.repeat(2500)}${'x/y/'.repeat(2500)} конец`;
  const t0 = performance.now();
  classifyTaskAndPruneTools(adversarial, {}, {});
  estimateCodebaseScope(adversarial, {});
  compileUserIntentToTechSpec(adversarial, { forceAlways: true });
  const elapsedMs = performance.now() - t0;
  assert.ok(elapsedMs < 250, `Expected <250ms on 40KB adversarial input, got ${Math.round(elapsedMs)}ms`);
});

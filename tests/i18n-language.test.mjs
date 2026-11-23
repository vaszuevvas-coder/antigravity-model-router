import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_STATE,
  ALLOWED_STATE_KEYS,
  sanitizeStatePatch,
  normalizeUiLanguageValue,
} from '../sidecars/panel/lib/panel-state-skills.mjs';
import {
  normalizeLang,
  detectOsLocale,
  resolveStateLanguage,
  pickLang,
  detectTextLanguage,
} from '../core/i18n.mjs';
import { resolveUserLanguage, handleSessionStart, handlePreInvocation } from '../core/hook-runner.mjs';
import { estimateTaskGradeAndThinkingBudget } from '../core/tool-pruner.mjs';
import { resolveActiveModelProfile } from '../core/model-profile.mjs';
import { buildPanelUi } from '../core/panel-ui-builder.mjs';
import { recommendProjectSetup, formatProjectSetupReport } from '../core/project-setup-recommender.mjs';
import { buildWpfFloatingHudScript } from '../core/floating-hud.mjs';
import {
  analyzeUiScreenshotLocally,
  generateLocalCommitSummary,
  structureVoiceTranscriptLocally,
} from '../core/gpu/gpu-composer-copilot.mjs';
import { auditAgentEnvironment } from '../core/agent-shield.mjs';
import { checkProjectCompletionInvariants } from '../core/completion-gates.mjs';
import { sanitizeMergedState } from '../install.js';
import { createSanitizedDefaultState } from '../scripts/pack-release.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const CYRILLIC_RE = /[а-яА-ЯёЁ]/;

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

test('4. Shared i18n helpers: normalizeLang, pickLang, detectTextLanguage, resolveStateLanguage, detectOsLocale', () => {
  assert.equal(normalizeLang('EN-US'), 'en');
  assert.equal(normalizeLang('ru-RU'), 'ru');
  assert.equal(normalizeLang('de', 'en'), 'en');
  assert.equal(pickLang('en', 'RU', 'EN'), 'EN');
  assert.equal(pickLang('ru', 'RU', 'EN'), 'RU');
  assert.equal(detectTextLanguage('Refactor authentication routes'), 'en');
  assert.equal(detectTextLanguage('Исправь маршруты авторизации'), 'ru');
  assert.equal(resolveStateLanguage({}, 'ru'), 'ru');
  assert.equal(resolveStateLanguage({ uiLanguage: 'en' }, 'ru'), 'en');
  assert.equal(detectOsLocale({ LANG: 'en_US.UTF-8' }, ['node', 'install.js']), 'en');
  assert.equal(detectOsLocale({ LANG: 'ru_RU.UTF-8' }, ['node', 'install.js']), 'ru');
  assert.equal(detectOsLocale({ LANG: 'ru_RU.UTF-8' }, ['node', 'install.js', '--lang=en']), 'en');
  assert.equal(detectOsLocale({ LANG: 'en_US.UTF-8', TUNNEL_LANG: 'ru' }, ['node', 'install.js']), 'ru');
});

test('5. Manifests default to pure English without Cyrillic leaks', () => {
  const pluginJson = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'plugin.json'), 'utf8'));
  const sidecarJson = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'sidecars', 'panel', 'sidecar.json'), 'utf8'));
  const pkgJson = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));

  assert.doesNotMatch(pluginJson.displayName, CYRILLIC_RE);
  assert.doesNotMatch(pluginJson.description, CYRILLIC_RE);
  for (const p of pluginJson.suggestedPrompts || []) {
    assert.doesNotMatch(String(p), CYRILLIC_RE);
  }
  assert.doesNotMatch(sidecarJson.description, CYRILLIC_RE);
  assert.doesNotMatch(pkgJson.description, CYRILLIC_RE);
});

test('6. Core modules emit zero Cyrillic in EN mode (hooks, model-profile, setup, HUD, copilot, shield, gates)', async () => {
  const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-i18n-core-'));
  try {
    fs.writeFileSync(path.join(tmpWs, 'package.json'), JSON.stringify({ name: 'sample-app', dependencies: {} }), 'utf8');

    const pre = await handlePreInvocation(
      { workspacePath: tmpWs, conversationId: 'i18n-pre-en', userPrompt: 'Explain how router works in one file' },
      { uiLanguage: 'en', showBadge: true, confirmBeforeRun: false }
    );
    const preCtx = String(pre?.additionalContext || pre?.systemMessage || '');
    assert.doesNotMatch(preCtx, CYRILLIC_RE);

    const profile = resolveActiveModelProfile({ modelName: 'Gemini 3.1 Pro (High)', lang: 'en' });
    assert.ok(profile?.displayEn);
    assert.doesNotMatch(String(profile.displayEn), CYRILLIC_RE);

    const setup = recommendProjectSetup({ workspaceRoot: tmpWs, currentState: { uiLanguage: 'en' }, lang: 'en' });
    const setupText = formatProjectSetupReport(setup, 'en');
    assert.doesNotMatch(setupText, CYRILLIC_RE);

    const hudScript = buildWpfFloatingHudScript({ lang: 'en' });
    assert.doesNotMatch(hudScript, CYRILLIC_RE);

    const commitRes = await generateLocalCommitSummary({
      diffText: '+const a = 1;\n',
      changedFiles: ['core/a.mjs'],
      cfgOverride: { gpuEnabled: false },
      lang: 'en',
    });
    assert.equal(commitRes.ok, true);
    assert.doesNotMatch(commitRes.commitMessage, CYRILLIC_RE);
    assert.doesNotMatch(commitRes.summaryEn || '', CYRILLIC_RE);

    const voiceEmpty = await structureVoiceTranscriptLocally({ rawTranscript: '', lang: 'en' });
    assert.equal(voiceEmpty.ok, false);
    assert.doesNotMatch(String(voiceEmpty.error || ''), CYRILLIC_RE);

    const visionEmpty = await analyzeUiScreenshotLocally({ imageBase64: '', lang: 'en' });
    assert.equal(visionEmpty.ok, false);
    assert.doesNotMatch(String(visionEmpty.error || ''), CYRILLIC_RE);

    const shieldRes = auditAgentEnvironment({ workspaceRoot: tmpWs, includeGlobal: false, lang: 'en' });
    assert.doesNotMatch(String(shieldRes.summaryEn || ''), CYRILLIC_RE);

    const gateRes = checkProjectCompletionInvariants(tmpWs, [], { lang: 'en' });
    for (const w of gateRes.warnings || []) {
      assert.doesNotMatch(String(w.message || ''), CYRILLIC_RE);
    }
  } finally {
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
});

test('7. Installer CLI dry-run respects --lang=en and --lang=ru', () => {
  const tmpDest = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-inst-lang-'));
  try {
    const outEn = execFileSync(
      process.execPath,
      [path.join(ROOT_DIR, 'install.js'), '--dry-run', '--target', tmpDest, '--lang=en'],
      { cwd: ROOT_DIR, encoding: 'utf8' }
    );
    assert.match(outEn, /\[DRY-RUN\] Version:/);
    assert.doesNotMatch(outEn, CYRILLIC_RE);

    const outRu = execFileSync(
      process.execPath,
      [path.join(ROOT_DIR, 'install.js'), '--dry-run', '--target', tmpDest, '--lang=ru'],
      { cwd: ROOT_DIR, encoding: 'utf8' }
    );
    assert.match(outRu, /\[DRY-RUN\] Версия:/);
  } finally {
    fs.rmSync(tmpDest, { recursive: true, force: true });
  }
});

test('8. Panel UI 00-i18n engine translates all static DOM strings & attributes in ui.html into EN with zero Cyrillic leaks', () => {
  const uiHtml = fs.readFileSync(path.join(ROOT_DIR, 'sidecars', 'panel', 'ui.html'), 'utf8');
  const i18nSrc = fs.readFileSync(path.join(ROOT_DIR, 'sidecars', 'panel', 'ui-src', 'js', '00-i18n.js'), 'utf8');

  const sandbox = { WeakMap, RegExp, Object, String, Number, Array };
  vm.createContext(sandbox);
  vm.runInContext(
    `${i18nSrc}\nglobalThis.__i18nApi = { UI_RU_TO_EN_TEXT, UI_RU_TO_EN_ATTR, translateUiString };`,
    sandbox
  );
  const { UI_RU_TO_EN_TEXT, UI_RU_TO_EN_ATTR, translateUiString } = sandbox.__i18nApi;

  const bodyOnly = uiHtml
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '');

  const decodeEntities = (s) => s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

  const missingTexts = [];
  const textSegments = bodyOnly.split(/<[^>]+>/g);
  for (const rawSeg of textSegments) {
    const seg = decodeEntities(rawSeg).trim();
    if (!seg || !CYRILLIC_RE.test(seg)) continue;
    const translated = translateUiString(seg, UI_RU_TO_EN_TEXT);
    if (CYRILLIC_RE.test(translated)) {
      missingTexts.push(seg);
    }
  }

  const missingAttrs = [];
  const attrRe = /\b(?:title|placeholder|data-prompt|alt)="([^"]*)"/g;
  let m;
  while ((m = attrRe.exec(bodyOnly)) !== null) {
    const val = decodeEntities(m[1]);
    if (!val || !CYRILLIC_RE.test(val)) continue;
    const translated = translateUiString(val, UI_RU_TO_EN_ATTR);
    if (CYRILLIC_RE.test(translated)) {
      missingAttrs.push(val);
    }
  }

  assert.deepEqual(missingTexts, [], `Untranslated static DOM text segments in ui.html: ${missingTexts.slice(0, 5).join(' | ')}`);
  assert.deepEqual(missingAttrs, [], `Untranslated static DOM attributes in ui.html: ${missingAttrs.slice(0, 5).join(' | ')}`);
});

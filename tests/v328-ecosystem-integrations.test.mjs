import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ALLOWED_STATE_KEYS,
  CURATED_EXTERNAL_SKILL_PRESETS,
  DEFAULT_STATE,
  sanitizeStatePatch,
} from '../sidecars/panel/lib/panel-state-skills.mjs';
import {
  buildAdaptive3DOptionsBlueprint,
  buildGrillMeDirective,
  detectGrillMeSignals,
  estimateTaskGradeAndThinkingBudget,
} from '../core/tool-pruner.mjs';
import { validateRepoSlug, validateSkillSlug } from '../core/skill-registry-bridge.mjs';
import { auditUiContent } from '../skills/ui-ux-design-system/scripts/audit-ui.mjs';
import { queryUxMatrix } from '../skills/ui-ux-design-system/scripts/query-ux-matrix.mjs';
import { auditSkill } from '../skills/skill-architect/scripts/audit-skill.mjs';
import {
  buildOpenverseSearchUrl,
  formatCreditsFooterLine,
  normalizeOpenverseResults,
  searchOpenMedia,
} from '../skills/ui-ux-design-system/scripts/fetch-open-media.mjs';
import {
  analyzeWavBufferAcousticMetrics,
  buildFfmpegMixArgs,
  extractTimelineAudioCues,
  resolveCueAudioAsset,
  synthesizeProceduralWavBuffer,
} from '../skills/programmatic-video-studio/scripts/compose-video-sfx.mjs';
import {
  diffInteractiveSnapshots,
  extractCompactInteractiveRefTree,
  runWebappDogfoodAudit,
} from '../skills/deep-stress-auditor/scripts/run-webapp-dogfood.mjs';
import { detectShallowPassThroughModule } from '../skills/deep-stress-auditor/scripts/lib/graph-and-contracts.mjs';
import { assessDiffSurgicalDiscipline } from '../core/completion-gates.mjs';

test('Wave 1: Grill-Me state schema, directives, curated skill presets & rebuilt Panel UI controls', () => {
  assert.equal(DEFAULT_STATE.grillMode, 'auto');
  assert.equal(ALLOWED_STATE_KEYS.has('grillMode'), true);
  assert.equal(sanitizeStatePatch({ grillMode: 'always' }).grillMode, 'always');
  assert.equal(sanitizeStatePatch({ grillMode: 'off' }).grillMode, 'off');
  assert.equal(Object.hasOwn(sanitizeStatePatch({ grillMode: 'bogus_mode' }), 'grillMode'), false);

  const explicitSig = detectGrillMeSignals('[Grill-Me: опрос] сделай систему квот', { grade: 'M', isExploratory: false }, { grillMode: 'off' });
  assert.equal(explicitSig.active, true);
  assert.equal(explicitSig.mode, 'explicit');
  const activeDir = buildGrillMeDirective({ grillSignal: explicitSig, grade: 'XL' });
  assert.match(activeDir, /\[Grill-Me Design-Tree Frontier: ACTIVE \(explicit\)\]/);
  assert.match(activeDir, /SPEC\.md/);

  const autoOfferSig = detectGrillMeSignals('Спроектируй новую страницу оплаты', { grade: 'L', isExploratory: true }, { grillMode: 'auto' });
  assert.equal(autoOfferSig.mode, 'offer_in_gate');

  const offSig = detectGrillMeSignals('Поправь цвет кнопки', { grade: 'L', isExploratory: true }, { grillMode: 'off' });
  assert.equal(offSig.active, false);
  assert.equal(offSig.mode, 'off');

  const bp = buildAdaptive3DOptionsBlueprint({
    matrix3D: { tensorId: 'moderate_integrated_exploratory', breadth: 'moderate', depth: 'integrated', riskMode: 'exploratory' },
    grillSignal: autoOfferSig,
  });
  assert.match(bp.formattedBlueprint, /Нужен ли детальный опрос \(Grill-Me\)/);

  const triageRes = estimateTaskGradeAndThinkingBudget(
    '[Grill-Me: проведи детальный опрос по развилкам перед кодом] Сделай дашборд аналитики',
    { confirmBeforeRun: true, confirmThreshold: 'M', grillMode: 'auto' },
    {}
  );
  assert.equal(triageRes.grillMe?.mode, 'explicit');
  assert.match(triageRes.budgetHint, /\[Grill-Me Design-Tree Frontier: ACTIVE/);

  assert.ok(Array.isArray(CURATED_EXTERNAL_SKILL_PRESETS) && CURATED_EXTERNAL_SKILL_PRESETS.length >= 5);
  for (const p of CURATED_EXTERNAL_SKILL_PRESETS) {
    assert.ok(validateRepoSlug(p.repo), `Invalid preset repo: ${p.repo}`);
    assert.ok(validateSkillSlug(p.slug), `Invalid preset slug: ${p.slug}`);
  }

  const uiHtml = fs.readFileSync(path.resolve('sidecars/panel/ui.html'), 'utf8');
  assert.ok(uiHtml.includes('id="btnToggleComposerGrill"'));
  assert.ok(uiHtml.includes('id="grillModeGroup"'));
  assert.ok(uiHtml.includes('id="grillModeHint"'));
  assert.ok(uiHtml.includes('data-action="selectCuratedSkillPreset"'));
  // Ensure first applyComposerChip remains a prompt chip rather than the Grill-Me toggle
  const firstApplyIdx = uiHtml.indexOf('data-action="applyComposerChip"');
  assert.ok(firstApplyIdx > 0 && uiHtml.slice(firstApplyIdx - 80, firstApplyIdx + 120).includes('data-prompt='));
});

test('Wave 2: UI second-gen anti-slop checks & Openverse zero-LLM media fetcher', async () => {
  const dirtyHtml = `
    <style>
      :root { --bg-canvas: #f4f1ea; --text-primary: #1c1917; --accent-primary: #d97757; }
      .eyebrow { text-transform: uppercase; }
    </style>
    <div class="eyebrow">Tag 1</div><div class="eyebrow">Tag 2</div><div class="eyebrow">Tag 3</div><div class="eyebrow">Tag 4</div>
    <div>01</div><div>02</div><div>03</div>
    <p>Lorem ipsum dolor sit amet</p>
    <a href="/a">A →</a><a href="/b">B →</a><a href="/c">C →</a><button>D →</button>
  `;
  const dirtyAudit = auditUiContent(dirtyHtml, 'dirty.html');
  const ruleIds = new Set(dirtyAudit.findings.map((f) => f.ruleId));
  assert.equal(ruleIds.has('cliche-claude-terracotta'), true);
  assert.equal(ruleIds.has('template-arrow-buttons'), true);
  assert.equal(ruleIds.has('placeholder-lorem-copy'), true);
  assert.equal(ruleIds.has('eyebrow-caps-spam'), true);
  assert.equal(ruleIds.has('decorative-fake-numbering'), true);

  const cleanHtml = `
    <style>:root { --bg-canvas: #ffffff; --text-primary: #111827; --accent-primary: #0f766e; }</style>
    <main><h1>Workshop Analytics</h1><button type="button">Publish report</button></main>
  `;
  const cleanAudit = auditUiContent(cleanHtml, 'clean.html');
  assert.equal(cleanAudit.score, 20);
  assert.equal(cleanAudit.ok, true);

  const searchUrl = buildOpenverseSearchUrl({ query: 'espresso bar', mediaType: 'audio', license: 'cc0,pdm', pageSize: 5 });
  assert.match(searchUrl, /^https:\/\/api\.openverse\.org\/v1\/audio\/\?/);
  assert.match(searchUrl, /q=espresso\+bar/);

  const normalized = normalizeOpenverseResults(
    {
      results: [
        { id: '1', title: 'Roaster', creator: 'Ana', license: 'cc0', url: 'https://upload.wikimedia.org/a.jpg' },
        { id: '2', title: 'LocalSSRF', creator: 'Bad', license: 'cc0', url: 'http://127.0.0.1/secret.jpg' },
      ],
    },
    'images'
  );
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].id, '1');

  const credits = formatCreditsFooterLine(normalized);
  assert.match(credits.footerLine, /^Media credits: Roaster by Ana \(CC0/);

  const mockRes = await searchOpenMedia({
    query: 'forest wind',
    mediaType: 'audio',
    limit: 2,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        results: [{ id: 'a1', title: 'Wind Gust', creator: 'FoleyLab', license: 'cc0', url: 'https://cdn.freesound.org/wind.mp3' }],
      }),
    }),
  });
  assert.equal(mockRes.ok, true);
  assert.equal(mockRes.items.length, 1);
});

test('Wave 3: Video & game SFX extraction, pure-Node PCM WAV synthesis & acoustic critique', () => {
  const hfSource = `
    <div id="hero" data-start="0.5" data-sfx="whoosh"></div>
    <script>
      const tl = gsap.timeline({ paused: true });
      tl.fromTo('#card', { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: 0.4 }, 1.25);
    </script>
  `;
  const hfParsed = extractTimelineAudioCues(hfSource, 'promo.html');
  assert.equal(hfParsed.cues.length >= 2, true);
  assert.equal(hfParsed.cues[0].kind, 'whoosh');
  assert.equal(hfParsed.cues[0].timeSec, 0.5);

  const remotionSource = `
    const fps = 60;
    <Sequence from={90} name="success badge" />
  `;
  const remParsed = extractTimelineAudioCues(remotionSource, 'Demo.tsx');
  assert.equal(remParsed.fps, 60);
  assert.equal(remParsed.cues[0].timeSec, 1.5);
  assert.equal(remParsed.cues[0].kind, 'success');

  for (const kind of ['click', 'whoosh', 'chime', 'success']) {
    const wav = synthesizeProceduralWavBuffer(kind);
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
    const metrics = analyzeWavBufferAcousticMetrics(wav);
    assert.equal(metrics.ok, true, `${kind} WAV critique failed: ${JSON.stringify(metrics)}`);
    assert.equal(metrics.clippingSamples, 0);
    assert.ok(metrics.peakDb <= -2.5 && metrics.peakDb >= -4.0);
  }

  // Silent WAV buffer should fail acoustic critique
  const silentWav = Buffer.alloc(44 + 4800 * 2);
  silentWav.write('RIFF', 0, 'ascii');
  silentWav.writeUInt32LE(36 + 4800 * 2, 4);
  silentWav.write('WAVEfmt ', 8, 'ascii');
  silentWav.writeUInt32LE(16, 16);
  silentWav.writeUInt16LE(1, 20);
  silentWav.writeUInt16LE(1, 22);
  silentWav.writeUInt32LE(48000, 24);
  silentWav.writeUInt32LE(96000, 28);
  silentWav.writeUInt16LE(2, 32);
  silentWav.writeUInt16LE(16, 34);
  silentWav.write('data', 36, 'ascii');
  silentWav.writeUInt32LE(4800 * 2, 40);
  const silentCritique = analyzeWavBufferAcousticMetrics(silentWav);
  assert.equal(silentCritique.ok, false);
  assert.ok(silentCritique.issues.includes('too_quiet_or_silent'));

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfx-test-'));
  try {
    const resolved = resolveCueAudioAsset({ timeSec: 0.4, kind: 'pop', label: 'pop_card' }, { outDir: tmpDir, preferEarshot: false });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.engine, 'builtin_pcm_synth');
    assert.equal(fs.existsSync(resolved.filePath), true);

    const mix = buildFfmpegMixArgs({ videoPath: 'demo.mp4', cueFiles: [resolved], outputVideoPath: 'out.mp4', targetLufs: -16 });
    assert.equal(mix.ok, true);
    assert.ok(mix.args.join(' ').includes('adelay=400|400'));
    assert.ok(mix.args.join(' ').includes('loudnorm=I=-16'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Wave 4: Dogfood QA @eN refs & delta, Ousterhout shallow detector & Karpathy surgical guard', async () => {
  const htmlBefore = `
    <button id="saveBtn">Save</button>
    <button id="iconBtn"></button>
    <a href="#">Dead Link</a>
  `;
  const snapBefore = extractCompactInteractiveRefTree(htmlBefore);
  assert.equal(snapBefore.interactiveCount, 3);
  assert.equal(snapBefore.refs[0].ref, '@e1');
  assert.equal(snapBefore.refs[1].missingAccessibleName, true);
  assert.ok(snapBefore.issues.some((i) => i.ruleId === 'unlabeled-interactive-control'));
  assert.ok(snapBefore.issues.some((i) => i.ruleId === 'dead-anchor-href'));

  const htmlAfter = `
    <button id="saveBtn" disabled>Saved</button>
    <button id="iconBtn" aria-label="Settings"></button>
    <a href="/docs">Docs</a>
    <input id="searchBox" placeholder="Search" />
  `;
  const snapAfter = extractCompactInteractiveRefTree(htmlAfter);
  const delta = diffInteractiveSnapshots(snapBefore.refs, snapAfter.refs);
  assert.equal(delta.added.length, 1);
  assert.equal(delta.added[0].id, 'searchBox');
  assert.equal(delta.changed.length >= 2, true);
  assert.equal(delta.changed.some((c) => c.after.id === 'saveBtn'), true);

  const tmpHtml = path.join(os.tmpdir(), `dogfood-probe-${Date.now()}.html`);
  fs.writeFileSync(tmpHtml, htmlAfter, 'utf8');
  try {
    const qaRes = await runWebappDogfoodAudit({ target: tmpHtml, useAgentBrowser: false });
    assert.equal(qaRes.ok, true);
    assert.equal(qaRes.engine, 'builtin-static-dom');
    assert.equal(qaRes.interactiveCount, 4);
  } finally {
    fs.rmSync(tmpHtml, { force: true });
  }

  // Ousterhout shallow wrapper vs barrel re-export vs real logic
  const shallowCode = [
    "import * as svc from './svc.mjs';",
    '',
    '// thin boilerplate file',
    'export function createItem(a, b) {',
    '  return svc.createItem(a, b);',
    '}',
    'export function deleteItem(id) {',
    '  return svc.deleteItem(id);',
    '}',
    'export const getItem = (id) => svc.getItem(id);',
    'const metaA = 1;',
    'const metaB = 2;',
    'const metaC = 3;',
    'const metaD = 4;',
  ].join('\n');
  const shallowHit = detectShallowPassThroughModule(shallowCode, 'src/wrapper.mjs');
  assert.equal(shallowHit.isShallow, true);
  assert.equal(shallowHit.wrapperCount, 3);

  const barrelCode = [
    "export { createItem, deleteItem } from './svc.mjs';",
    "export * from './other.mjs';",
    ...Array.from({ length: 14 }, (_, i) => `// comment ${i}`),
  ].join('\n');
  assert.equal(detectShallowPassThroughModule(barrelCode, 'src/facade.mjs').isShallow, false);

  // Karpathy Surgical Diff Guard
  const oldLines = Array.from({ length: 50 }, (_, i) => `const x${i} = ${i};`).join('\n');
  const bloatedLines = [
    oldLines,
    ...Array.from({ length: 200 }, (_, i) => `const extra${i} = ${i};`),
  ].join('\n');
  const bloatCheck = assessDiffSurgicalDiscipline(oldLines, bloatedLines, 'core/feature.mjs');
  assert.equal(bloatCheck.ok, false);
  assert.ok(bloatCheck.warnings.some((w) => /Karpathy Surgical Guard/.test(w)));

  const normalEdit = assessDiffSurgicalDiscipline(oldLines, `${oldLines}\nconst oneFix = true;`, 'core/feature.mjs');
  assert.equal(normalEdit.ok, true);
});

test('Wave 5: Emil craft & Taste rules in audit-ui, query-ux-matrix history rotation & playwright-cli 100/100 skill', () => {
  const craftDirty = `
    <style>
      .menu { transition: transform 200ms ease-in; transform: scale(0); }
    </style>
    <footer>Contact hello@acme.com or +1 (555) 123-4567</footer>
  `;
  const res = auditUiContent(craftDirty, 'craft.html');
  const ids = new Set(res.findings.map((f) => f.ruleId));
  assert.equal(ids.has('motion-ease-in-ui'), true);
  assert.equal(ids.has('motion-scale-zero'), true);
  assert.equal(ids.has('invented-contact-data'), true);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ux-hist-'));
  try {
    const histFile = path.join(tmpDir, 'history.json');
    const first = queryUxMatrix({ domain: 'fintech dashboard', mode: 'operate', historyPath: histFile });
    const second = queryUxMatrix({ domain: 'fintech dashboard', mode: 'operate', historyPath: histFile });
    assert.equal(fs.existsSync(histFile), true);
    assert.notEqual(
      first.palettes[0]?.productType || first.palettes[0]?.primary,
      second.palettes[0]?.productType || second.palettes[0]?.primary
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  const pwAudit = auditSkill(path.resolve('skills/playwright-cli'));
  assert.equal(pwAudit.ok, true);
  assert.equal(pwAudit.score, 100);
});

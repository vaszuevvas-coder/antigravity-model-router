import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  discoverSkillSemanticEntries,
  hasSkillIndexDrift,
  indexSkillVectors,
  peekWarmSemanticBundle,
  scoreSkillVectorsWithQueryVec,
} from '../core/gpu/gpu-vector-skills.mjs';
import { gpuRuntime, ramSkillVectorCache } from '../core/gpu/gpu-shared-state.mjs';
import { classifyTaskAndPruneTools } from '../core/tool-pruner.mjs';

function makeTempDir(prefix = 'amr-autoskills-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeSkill(baseDir, folderName, fmName, description, body = '## Workflow\nRun deterministic workflow checks.') {
  const skillDir = path.join(baseDir, folderName);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${fmName}\ndescription: ${description}\n---\n\n${body}\n`,
    'utf8'
  );
  return path.join(skillDir, 'SKILL.md').replace(/\\/g, '/');
}

test('auto-skills: multi-source discovery respects disabled plugins, excludes swarm internals, preserves underscores, and isolates customRoot', () => {
  const tmpHome = makeTempDir('amr-skill-home-');
  const tmpWs = makeTempDir('amr-skill-ws-');
  const tmpCustom = makeTempDir('amr-skill-custom-');

  try {
    const pluginsDir = path.join(tmpHome, '.gemini', 'config', 'plugins');
    const configPath = path.join(tmpHome, '.gemini', 'config', 'config.json');
    const builtinSkillsDir = path.join(tmpHome, '.gemini', 'antigravity', 'builtin', 'skills');
    const builtinPluginsDir = path.join(tmpHome, '.gemini', 'antigravity', 'builtin', 'plugins');
    const personalSkillsDir = path.join(tmpHome, '.gemini', 'config', 'skills');

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        plugins: {
          'enabled-plugin': { enabled: true },
          'disabled-plugin': { enabled: false },
        },
      }),
      'utf8'
    );

    // Enabled plugin + unregistered local plugin (must be included) + disabled plugin (must be skipped)
    fs.mkdirSync(path.join(pluginsDir, 'enabled-plugin'), { recursive: true });
    fs.writeFileSync(path.join(pluginsDir, 'enabled-plugin', 'plugin.json'), '{}', 'utf8');
    const chromeSkillFile = writeSkill(
      path.join(pluginsDir, 'enabled-plugin', 'skills'),
      'chrome-devtools',
      'chrome-devtools',
      'Inspect live browser pages, DOM, and heap snapshots.'
    );

    fs.mkdirSync(path.join(pluginsDir, 'book-architector'), { recursive: true });
    fs.writeFileSync(path.join(pluginsDir, 'book-architector', 'plugin.json'), '{}', 'utf8');
    const bookSkillFile = writeSkill(
      path.join(pluginsDir, 'book-architector', 'skills'),
      'book-wizard',
      'book-wizard',
      'Initialize a new fiction book project and worldbuilding.'
    );

    fs.mkdirSync(path.join(pluginsDir, 'disabled-plugin'), { recursive: true });
    fs.writeFileSync(path.join(pluginsDir, 'disabled-plugin', 'plugin.json'), '{}', 'utf8');
    writeSkill(
      path.join(pluginsDir, 'disabled-plugin', 'skills'),
      'disabled-skill',
      'disabled-skill',
      'Should never be indexed.'
    );

    // Workspace skill
    const wsSkillFile = writeSkill(
      path.join(tmpWs, '.agents', 'skills'),
      'ws-local-tool',
      'ws-local-tool',
      'Project-specific deployment helper.'
    );

    // Personal skill
    const personalSkillFile = writeSkill(
      personalSkillsDir,
      'personal-helper',
      'personal-helper',
      'Personal workflow helper.'
    );

    // Builtin skills: underscore preservation + swarm internal exclusion
    const genUiFile = writeSkill(
      builtinSkillsDir,
      'generative_ui',
      'generative_ui',
      'Render rich interactive HTML widgets inline in chat.'
    );
    writeSkill(builtinSkillsDir, 'swarm_monitor', 'swarm_monitor', 'Internal swarm stall monitor.');
    writeSkill(builtinSkillsDir, 'swarm_narrator', 'swarm_narrator', 'Internal swarm narrator.');
    writeSkill(builtinSkillsDir, 'swarm_pane', 'swarm_pane', 'Internal swarm pane.');
    writeSkill(builtinSkillsDir, 'native_swarm', 'native_swarm', 'Internal swarm protocol.');

    fs.mkdirSync(path.join(builtinPluginsDir, 'builtin-pack'), { recursive: true });
    const builtinPackFile = writeSkill(
      path.join(builtinPluginsDir, 'builtin-pack', 'skills'),
      'builtin-pack-skill',
      'builtin-pack-skill',
      'Builtin plugin skill.'
    );

    const entries = discoverSkillSemanticEntries('', {
      homeDir: tmpHome,
      pluginsDir,
      configPath,
      builtinSkillsDir,
      builtinPluginsDir,
      wsAbsRoot: tmpWs,
    });
    const bySlug = new Map(entries.map((e) => [e.slug, e]));

    assert.equal(bySlug.get('chrome-devtools')?.skillFile, chromeSkillFile);
    assert.equal(bySlug.get('book-wizard')?.skillFile, bookSkillFile);
    assert.equal(bySlug.get('ws-local-tool')?.skillFile, wsSkillFile);
    assert.equal(bySlug.get('personal-helper')?.skillFile, personalSkillFile);
    assert.equal(bySlug.get('generative_ui')?.skillFile, genUiFile);
    assert.equal(bySlug.get('builtin-pack-skill')?.skillFile, builtinPackFile);

    assert.equal(bySlug.has('disabled-skill'), false);
    assert.equal(bySlug.has('swarm_monitor'), false);
    assert.equal(bySlug.has('swarm_narrator'), false);
    assert.equal(bySlug.has('swarm_pane'), false);
    assert.equal(bySlug.has('native_swarm'), false);

    // customRoot must isolate strictly
    writeSkill(tmpCustom, 'only-custom', 'only-custom', 'Isolated custom skill.');
    const customEntries = discoverSkillSemanticEntries(tmpCustom);
    assert.equal(customEntries.length, 1);
    assert.equal(customEntries[0].slug, 'only-custom');
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpWs, { recursive: true, force: true });
    fs.rmSync(tmpCustom, { recursive: true, force: true });
  }
});

test('auto-skills: indexSkillVectors & scoreSkillVectorsWithQueryVec propagate skillFile and hasSkillIndexDrift detects changes', async () => {
  const tmpCustom = makeTempDir('amr-skill-drift-');
  try {
    const fileA = writeSkill(tmpCustom, 'alpha-audit', 'alpha-audit', 'Audit API contracts and schemas.');
    const mockEmbed = async (texts) =>
      texts.map((t) => {
        if (t.includes('alpha-audit')) return [0.95, 0.25, 0, 0, 0, 0, 0, 0];
        if (t.includes('beta-video')) return [0, 0, 0.95, 0.25, 0, 0, 0, 0];
        return [0, 0, 0, 0, 0.95, 0.25, 0, 0];
      });

    const idxRes = await indexSkillVectors({ customRoot: tmpCustom, embedBatchFn: mockEmbed });
    assert.equal(idxRes.ok, true);
    assert.equal(idxRes.skillsCount, 1);

    const scored = scoreSkillVectorsWithQueryVec(Float32Array.from([0.96, 0.27, 0, 0, 0, 0, 0, 0]), idxRes.store);
    assert.equal(scored.candidates[0]?.slug, 'alpha-audit');
    assert.equal(scored.candidates[0]?.skillFile, fileA);

    // Drift checks against synthetic store
    const tmpHome = makeTempDir('amr-drift-home-');
    try {
      const pluginsDir = path.join(tmpHome, '.gemini', 'config', 'plugins');
      const builtinSkillsDir = path.join(tmpHome, '.gemini', 'antigravity', 'builtin', 'skills');
      const configPath = path.join(tmpHome, '.gemini', 'config', 'config.json');
      fs.mkdirSync(path.join(pluginsDir, 'p1', 'skills'), { recursive: true });
      const p1File = writeSkill(path.join(pluginsDir, 'p1', 'skills'), 'p1-skill', 'p1-skill', 'First plugin skill.');

      // Drift checks against synthetic store (include plugin.json so p1 is discovered)
      fs.writeFileSync(path.join(pluginsDir, 'p1', 'plugin.json'), '{}', 'utf8');
      const discOpts = { homeDir: tmpHome, pluginsDir, configPath, builtinSkillsDir };
      const initialEntries = discoverSkillSemanticEntries('', discOpts);
      assert.ok(initialEntries.some((e) => e.slug === 'p1-skill'), 'p1-skill must be discovered');
      const fakeStore = {
        skillsCount: initialEntries.length,
        entries: new Map(initialEntries.map((e) => [e.slug, { sha1: e.sha1, skillFile: e.skillFile, chunks: [{ kind: 'desc', vec: new Int8Array([1]) }] }])),
      };
      assert.equal(hasSkillIndexDrift(fakeStore, { discoveryOptions: discOpts }), false);

      // Missing skillFile triggers drift
      fakeStore.entries.get('p1-skill').skillFile = '';
      assert.equal(hasSkillIndexDrift(fakeStore, { discoveryOptions: discOpts }), true);
      fakeStore.entries.get('p1-skill').skillFile = p1File;
      assert.equal(hasSkillIndexDrift(fakeStore, { discoveryOptions: discOpts }), false);

      // Modified SKILL.md triggers drift
      writeSkill(path.join(pluginsDir, 'p1', 'skills'), 'p1-skill', 'p1-skill', 'Updated description triggers reindex.');
      assert.equal(hasSkillIndexDrift(fakeStore, { discoveryOptions: discOpts }), true);

      // Added skill triggers drift
      fakeStore.entries.get('p1-skill').sha1 = discoverSkillSemanticEntries('', discOpts).find((e) => e.slug === 'p1-skill').sha1;
      writeSkill(path.join(pluginsDir, 'p1', 'skills'), 'p2-skill', 'p2-skill', 'Second plugin skill.');
      assert.equal(hasSkillIndexDrift(fakeStore, { discoveryOptions: discOpts }), true);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(tmpCustom, { recursive: true, force: true });
  }
});

test('auto-skills: peekWarmSemanticBundle returns skillIndexWarm=false when embed times out or Ollama is offline', async () => {
  const prevOfflineUntil = gpuRuntime.ollamaOfflineUntilTs;
  const prevOfflineEndpoint = gpuRuntime.ollamaOfflineEndpoint;
  const cacheSnapshot = new Map(ramSkillVectorCache);

  try {
    // Seed a warm-looking store in memory so hasSkills=true, then force offline/unreachable embed
    ramSkillVectorCache.clear();
    gpuRuntime.ollamaOfflineUntilTs = Date.now() + 60_000;
    const offlineBundle = await peekWarmSemanticBundle('', 'Обнови дизайн карточки', {
      includeCode: false,
      includeSkills: true,
      timeoutMs: 50,
    });
    assert.equal(offlineBundle.skillIndexWarm, false);
    assert.deepEqual(offlineBundle.semanticSkills, []);
  } finally {
    gpuRuntime.ollamaOfflineUntilTs = prevOfflineUntil;
    gpuRuntime.ollamaOfflineEndpoint = prevOfflineEndpoint;
    ramSkillVectorCache.clear();
    for (const [k, v] of cacheSnapshot.entries()) {
      ramSkillVectorCache.set(k, v);
    }
  }
});

test('auto-skills: tool-pruner lexical fallback covers github-publish-guard & programmatic-video-studio and emits valid SKILL.md refs', () => {
  // 1. GPU timeout fallback preserves UI Preview Gate
  const uiRes = classifyTaskAndPruneTools(
    'Обнови дизайн карточки задач в боковой панели, сделай её контрастнее',
    { uiDesignPreviewGate: true, uiInspirationMode: 'ask', skillModes: {} },
    { skillIndexWarm: false, semanticSkills: [] }
  );
  assert.equal(uiRes.needsDesignPreviewGate, true);
  assert.match(uiRes.allowedHint, /\[UI\/UX Design Preview Gate\]/);

  // 2. GitHub push / version sync matches github-publish-guard lexically (without relative skills/ path)
  const ghRes = classifyTaskAndPruneTools(
    'Обнови актуальность нумерации версии с учётом внесённых правок и выгрузи на GitHub.',
    { skillModes: {} },
    { skillIndexWarm: false, semanticSkills: [] }
  );
  assert.equal(ghRes.matchedSkills[0], 'github-publish-guard');
  assert.match(ghRes.allowedHint, /\[Skill Match: github-publish-guard\] Read the "github-publish-guard" SKILL\.md/);
  assert.doesNotMatch(ghRes.allowedHint, /Read skills\/github-publish-guard\/SKILL\.md/);

  // 3. Remotion promo video with "анимацией" matches programmatic-video-studio (not ui-ux-design-system)
  const videoRes = classifyTaskAndPruneTools(
    'Сделай красивый промо-ролик с анимацией на Remotion для нашего приложения',
    { uiDesignPreviewGate: true, skillModes: {} },
    { skillIndexWarm: false, semanticSkills: [] }
  );
  assert.equal(videoRes.matchedSkills[0], 'programmatic-video-studio');
  assert.equal(videoRes.needsDesignPreviewGate, false);
  assert.doesNotMatch(videoRes.allowedHint, /ui-ux-design-system/);

  // 4. Semantic skill with absolute skillFile embeds exact path in directive
  const semRes = classifyTaskAndPruneTools(
    'Открой страницу и сними heap snapshot',
    { skillModes: {} },
    {
      skillIndexWarm: true,
      semanticSkills: [
        {
          slug: 'memory-leak-debugging',
          skillFile: 'C:/Users/Test/.gemini/config/plugins/chrome-devtools-plugin/skills/memory-leak-debugging/SKILL.md',
          score: 0.78,
          deltaVsNone: 0.25,
          margin: 0.14,
          confident: true,
          source: 'vector',
        },
      ],
    }
  );
  assert.match(
    semRes.allowedHint,
    /\[Semantic Skill Match: memory-leak-debugging \(78%\)\] Read C:\/Users\/Test\/\.gemini\/config\/plugins\/chrome-devtools-plugin\/skills\/memory-leak-debugging\/SKILL\.md if its workflow applies\./
  );
});

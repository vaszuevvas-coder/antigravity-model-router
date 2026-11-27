import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  computeNextVersion,
  parseSemver,
  parseVersionCliArgs,
  syncVersionFiles,
} from '../scripts/bump-version.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');

function makeTempRepo(pkgVersion, pluginVersion) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-ver-'));
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'antigravity-model-router', version: pkgVersion }, null, 2) + '\n',
    'utf8'
  );
  fs.writeFileSync(
    path.join(dir, 'plugin.json'),
    JSON.stringify({ name: 'antigravity-model-router', version: pluginVersion }, null, 2) + '\n',
    'utf8'
  );
  return dir;
}

test('bump-version: SemVer parsing, computation, check and sync', () => {
  assert.deepEqual(parseSemver('v3.8.0'), {
    major: 3,
    minor: 8,
    patch: 0,
    prerelease: '',
    version: '3.8.0',
  });
  assert.equal(parseSemver('3.8.1-rc.1').version, '3.8.1-rc.1');
  assert.throws(() => parseSemver('3.8'), /SemVer/);
  assert.throws(() => parseSemver('3.18.0-a..b'), /SemVer/);

  assert.equal(computeNextVersion('3.8.0', 'patch'), '3.8.1');
  assert.equal(computeNextVersion('3.8.4', 'minor'), '3.9.0');
  assert.equal(computeNextVersion('3.8.4', 'major'), '4.0.0');
  assert.equal(computeNextVersion('3.8.0', 'v3.8.9'), '3.8.9');

  assert.deepEqual(parseVersionCliArgs(['patch', '--dry-run', '--json']), {
    target: 'patch',
    check: false,
    dryRun: true,
    json: true,
    help: false,
  });
  assert.throws(() => parseVersionCliArgs(['--check', 'patch']), /одновременно/);
  assert.throws(() => parseVersionCliArgs(['--unknown']), /Неизвестный флаг/);

  const repo = makeTempRepo('3.8.0', '3.8.0');
  try {
    const checkOk = syncVersionFiles({ repoRoot: repo, target: 'check' });
    assert.equal(checkOk.ok, true);
    assert.equal(checkOk.inSync, true);
    assert.equal(checkOk.version, '3.8.0');

    const dry = syncVersionFiles({ repoRoot: repo, target: 'patch', dryRun: true });
    assert.equal(dry.version, '3.8.1');
    assert.equal(dry.dryRun, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version, '3.8.0');

    const bumped = syncVersionFiles({ repoRoot: repo, target: 'patch' });
    assert.equal(bumped.ok, true);
    assert.equal(bumped.version, '3.8.1');
    assert.equal(JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version, '3.8.1');
    assert.equal(JSON.parse(fs.readFileSync(path.join(repo, 'plugin.json'), 'utf8')).version, '3.8.1');

    // Out-of-sync rejects relative bump, allows explicit target to re-sync
    fs.writeFileSync(
      path.join(repo, 'plugin.json'),
      JSON.stringify({ name: 'antigravity-model-router', version: '3.7.9' }, null, 2) + '\n',
      'utf8'
    );
    const checkBad = syncVersionFiles({ repoRoot: repo, target: 'check' });
    assert.equal(checkBad.ok, false);
    assert.equal(checkBad.inSync, false);
    assert.throws(() => syncVersionFiles({ repoRoot: repo, target: 'patch' }), /Рассинхрон версий/);

    const resynced = syncVersionFiles({ repoRoot: repo, target: '3.8.2' });
    assert.equal(resynced.version, '3.8.2');
    assert.equal(JSON.parse(fs.readFileSync(path.join(repo, 'plugin.json'), 'utf8')).version, '3.8.2');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('bump-version: companion files version sync works when present', () => {
  const repo = makeTempRepo('3.17.0', '3.17.0');
  try {
    fs.mkdirSync(path.join(repo, 'sidecars', 'panel'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, 'sidecars', 'panel', 'ui.html'),
      '<title>The Tunnel — Liquid Glass v3.17.0</title>\n<span class="lg-brand-title">The Tunnel · Мастер v3.17.0</span>\n<div class="status-pane">The Tunnel · Liquid Glass v3.17.0</div>\n<div class="status-pane" id="footerPluginVersion">The Tunnel v3.17.0</div>\n',
      'utf8'
    );
    fs.mkdirSync(path.join(repo, 'agents'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, 'agents', 'router-verifier.md'),
      'description: Independent read-only verifier for code diffs in The Tunnel v3.17.0.\n',
      'utf8'
    );
    fs.mkdirSync(path.join(repo, 'skills', 'model-router'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, 'skills', 'model-router', 'SKILL.md'),
      'description: Control protocol for The Tunnel v3.17.0 3D Task Tensor.\n# The Tunnel v3.17.0 Control Protocol\n## 2. Guardrails & Coprocessors (v2.0 -> v3.17.0)\n',
      'utf8'
    );
    fs.mkdirSync(path.join(repo, 'skills', 'context-fork'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, 'skills', 'context-fork', 'SKILL.md'),
      'description: Token-economy protocol for The Tunnel v3.17.0: cache alignment.\n# Context Fork & Token Economy (v3.17.0)\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(repo, 'Установить плагин.bat'),
      '@echo off\ntitle Установка The Tunnel v3.17.0\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(repo, 'README.md'),
      '# The Tunnel `v3.17.0` — Диспетчер моделей ИИ\nПульт The Tunnel v3.17.0\ndist/The-Tunnel-v3.17.0-Setup.exe\ndist/The-Tunnel-v3.17.0.zip\n',
      'utf8'
    );
    fs.mkdirSync(path.join(repo, 'assets'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, 'assets', 'banner.svg'),
      '<svg><text>The Tunnel — Диспетчер моделей ИИ (Liquid Glass v3.17.0)</text><!-- панели The Tunnel (Liquid Glass v3.17.0) --></svg>\n',
      'utf8'
    );

    const bumped = syncVersionFiles({ repoRoot: repo, target: 'minor' });
    assert.equal(bumped.version, '3.18.0');
    assert.equal(bumped.updatedFiles.includes('sidecars/panel/ui.html'), true);
    assert.equal(bumped.updatedFiles.includes('agents/router-verifier.md'), true);
    assert.equal(bumped.updatedFiles.includes('skills/model-router/SKILL.md'), true);
    assert.equal(bumped.updatedFiles.includes('skills/context-fork/SKILL.md'), true);
    assert.equal(bumped.updatedFiles.includes('Установить плагин.bat'), true);
    assert.equal(bumped.updatedFiles.includes('README.md'), true);
    assert.equal(bumped.updatedFiles.includes('assets/banner.svg'), true);

    const uiAfter = fs.readFileSync(path.join(repo, 'sidecars', 'panel', 'ui.html'), 'utf8');
    assert.match(uiAfter, /<title>The Tunnel — Liquid Glass v3\.18\.0<\/title>/);
    assert.match(uiAfter, /Мастер v3\.18\.0/);
    assert.match(uiAfter, /Liquid Glass v3\.18\.0/);
    assert.match(uiAfter, /id="footerPluginVersion">The Tunnel v3\.18\.0<\/div>/);
    const verifierAfter = fs.readFileSync(path.join(repo, 'agents', 'router-verifier.md'), 'utf8');
    assert.match(verifierAfter, /in The Tunnel v3\.18\.0\./);
    const mrSkillAfter = fs.readFileSync(path.join(repo, 'skills', 'model-router', 'SKILL.md'), 'utf8');
    assert.match(mrSkillAfter, /Control protocol for The Tunnel v3\.18\.0/);
    assert.match(mrSkillAfter, /# The Tunnel v3\.18\.0 Control Protocol/);
    assert.match(mrSkillAfter, /Guardrails & Coprocessors \(v2\.0 -> v3\.18\.0\)/);
    const cfSkillAfter = fs.readFileSync(path.join(repo, 'skills', 'context-fork', 'SKILL.md'), 'utf8');
    assert.match(cfSkillAfter, /protocol for The Tunnel v3\.18\.0:/);
    assert.match(cfSkillAfter, /# Context Fork & Token Economy \(v3\.18\.0\)/);
    const batAfter = fs.readFileSync(path.join(repo, 'Установить плагин.bat'), 'utf8');
    assert.match(batAfter, /^title Установка The Tunnel v3\.18\.0/m);
    const readmeAfter = fs.readFileSync(path.join(repo, 'README.md'), 'utf8');
    assert.match(readmeAfter, /# The Tunnel `v3\.18\.0`/);
    assert.match(readmeAfter, /Пульт The Tunnel v3\.18\.0/);
    assert.match(readmeAfter, /dist\/The-Tunnel-v3\.18\.0-Setup\.exe/);
    assert.match(readmeAfter, /dist\/The-Tunnel-v3\.18\.0\.zip/);
    const bannerAfter = fs.readFileSync(path.join(repo, 'assets', 'banner.svg'), 'utf8');
    assert.match(bannerAfter, /Диспетчер моделей ИИ \(Liquid Glass v3\.18\.0\)/);
    assert.match(bannerAfter, /панели The Tunnel \(Liquid Glass v3\.18\.0\)/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('bump-version: current repo package.json and plugin.json are in sync', () => {
  const expectedVersion = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8')).version;
  assert.match(expectedVersion, /^\d+\.\d+\.\d+/);
  const out = execFileSync(process.execPath, [path.join(ROOT_DIR, 'scripts', 'bump-version.mjs'), '--check', '--json'], {
    cwd: ROOT_DIR,
    encoding: 'utf8',
  });
    const parsed = JSON.parse(out);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.inSync, true);
    assert.equal(parsed.version, expectedVersion);
});

test('parseVersionCliArgs handles null argv without throwing', async () => {
  const { parseVersionCliArgs } = await import('../scripts/bump-version.mjs');
  const parsedNull = parseVersionCliArgs(null);
  assert.equal(parsedNull.help, false);
  assert.equal(parsedNull.check, false);
});

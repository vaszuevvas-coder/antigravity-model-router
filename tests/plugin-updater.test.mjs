import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  applyPluginUpdate,
  checkForPluginUpdate,
  clearPluginUpdateStatus,
  compareSemver,
  getPluginUpdateStatus,
  isAllowedGitHubUrl,
  isUpdateCheckDisabledByEnv,
  parseGitHubRepoSlug,
  parseSemver,
  readPluginMeta,
  resolveSafeInstallTarget,
  validateExtractedTreeSafe,
} from '../core/plugin-updater.mjs';

function makeTmpDir(prefix = 'amr-updater-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeFakePluginRoot(version = '3.33.1', opts = {}) {
  const dir = makeTmpDir('amr-upd-root-');
  fs.writeFileSync(
    path.join(dir, 'plugin.json'),
    JSON.stringify({
      name: 'antigravity-model-router',
      version,
      repository: { type: 'git', url: 'https://github.com/vaszuevvas-coder/antigravity-model-router.git' },
    }, null, 2),
    'utf8'
  );
  if (opts.withGit) {
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  }
  if (opts.state) {
    fs.writeFileSync(path.join(dir, 'router-state.json'), JSON.stringify(opts.state, null, 2), 'utf8');
  }
  return dir;
}

test('1. SemVer parser, comparator, repo slug & GitHub HTTPS allowlist', () => {
  assert.deepEqual(parseSemver('v3.34.0'), {
    major: 3,
    minor: 34,
    patch: 0,
    prerelease: [],
    version: '3.34.0',
  });
  assert.equal(parseSemver('3.34.0-rc.2').version, '3.34.0-rc.2');
  assert.equal(parseSemver('3.34'), null);

  assert.equal(compareSemver('3.34.0', '3.33.1'), 1);
  assert.equal(compareSemver('v3.33.1', '3.33.1'), 0);
  assert.equal(compareSemver('3.33.0', '3.33.1'), -1);
  assert.equal(compareSemver('3.34.0-rc.1', '3.34.0'), -1);
  assert.equal(compareSemver('3.34.0-rc.2', '3.34.0-rc.1'), 1);
  assert.equal(compareSemver('3.34.0-1', '3.34.0-alpha'), -1);
  assert.equal(compareSemver('bad', '3.33.1'), 0);

  assert.equal(parseGitHubRepoSlug('https://github.com/vaszuevvas-coder/antigravity-model-router.git'), 'vaszuevvas-coder/antigravity-model-router');
  assert.equal(parseGitHubRepoSlug('vaszuevvas-coder/antigravity-model-router'), 'vaszuevvas-coder/antigravity-model-router');
  assert.equal(parseGitHubRepoSlug('https://gitlab.com/owner/repo'), '');

  assert.equal(isAllowedGitHubUrl('https://github.com/vaszuevvas-coder/antigravity-model-router/releases/download/v3.34.0/app.zip'), true);
  assert.equal(isAllowedGitHubUrl('https://codeload.github.com/vaszuevvas-coder/antigravity-model-router/zip/refs/tags/v3.34.0'), true);
  assert.equal(isAllowedGitHubUrl('https://raw.githubusercontent.com/vaszuevvas-coder/antigravity-model-router/main/plugin.json'), true);
  assert.equal(isAllowedGitHubUrl('http://github.com/vaszuevvas-coder/antigravity-model-router'), false);
  assert.equal(isAllowedGitHubUrl('https://user:pass@github.com/owner/repo'), false);
  assert.equal(isAllowedGitHubUrl('https://evil.example.com/update.zip'), false);
  assert.equal(isUpdateCheckDisabledByEnv(), true);
});

test('2. checkForPluginUpdate handles releases, 6h cache, 404 branch fallback, errors & test skip', async () => {
  const root = makeFakePluginRoot('3.33.1');
  try {
    const meta = readPluginMeta(root);
    assert.equal(meta.version, '3.33.1');
    assert.equal(meta.repo, 'vaszuevvas-coder/antigravity-model-router');

    // Without fetchFn in test env -> instant safe skip
    const skippedRes = await checkForPluginUpdate({ pluginRoot: root });
    assert.equal(skippedRes.ok, true);
    assert.equal(skippedRes.skipped, true);
    assert.equal(skippedRes.updateAvailable, false);

    // Release response with newer zip asset
    let calls = 0;
    const relFetch = async (url) => {
      calls++;
      assert.match(String(url), /\/releases\/latest$/);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          tag_name: 'v3.35.0',
          html_url: 'https://github.com/vaszuevvas-coder/antigravity-model-router/releases/tag/v3.35.0',
          body: 'Added Wave 4 auto-updater.',
          published_at: '2026-11-24T12:00:00Z',
          assets: [
            {
              name: 'antigravity-model-router-v3.35.0.zip',
              browser_download_url: 'https://github.com/vaszuevvas-coder/antigravity-model-router/releases/download/v3.35.0/antigravity-model-router-v3.35.0.zip',
            },
          ],
        }),
      };
    };

    const r1 = await checkForPluginUpdate({ pluginRoot: root, fetchFn: relFetch });
    assert.equal(r1.ok, true);
    assert.equal(r1.updateAvailable, true);
    assert.equal(r1.latestVersion, '3.35.0');
    assert.equal(r1.source, 'release');
    assert.equal(calls, 1);

    // Subsequent non-forced check hits disk cache
    const r2 = await checkForPluginUpdate({ pluginRoot: root, fetchFn: relFetch });
    assert.equal(r2.ok, true);
    assert.equal(r2.cached, true);
    assert.equal(r2.updateAvailable, true);
    assert.equal(calls, 1);

    // 404 on releases -> falls back to main plugin.json
    const branchFetch = async (url) => {
      if (String(url).includes('/releases/latest')) {
        return { ok: false, status: 404, json: async () => ({}) };
      }
      assert.match(String(url), /raw\.githubusercontent\.com\/.*\/main\/plugin\.json$/);
      return {
        ok: true,
        status: 200,
        json: async () => ({ name: 'antigravity-model-router', version: '3.36.0' }),
      };
    };
    const rBranch = await checkForPluginUpdate({ pluginRoot: root, force: true, fetchFn: branchFetch });
    assert.equal(rBranch.ok, true);
    assert.equal(rBranch.source, 'branch');
    assert.equal(rBranch.latestVersion, '3.36.0');
    assert.equal(rBranch.updateAvailable, true);
    assert.match(rBranch.downloadUrl, /codeload\.github\.com\/.*\/zip\/refs\/heads\/main$/);

    // Network error never crashes
    const errRes = await checkForPluginUpdate({
      pluginRoot: root,
      force: true,
      fetchFn: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    assert.equal(errRes.ok, false);
    assert.equal(errRes.updateAvailable, false);
    assert.match(errRes.error, /ECONNREFUSED/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('3. resolveSafeInstallTarget protects dev .git repos and validateExtractedTreeSafe catches symlinks', () => {
  const devRepo = makeFakePluginRoot('3.33.1', { withGit: true });
  const installedRoot = makeFakePluginRoot('3.33.1', { withGit: false });
  const extractDir = makeTmpDir('amr-extract-safe-');
  try {
    const devTarget = resolveSafeInstallTarget(devRepo);
    assert.notEqual(path.resolve(devTarget), path.resolve(devRepo));
    assert.match(devTarget.replace(/\\/g, '/'), /\.gemini\/config\/plugins\/antigravity-model-router$/);

    assert.equal(path.resolve(resolveSafeInstallTarget(installedRoot)), path.resolve(installedRoot));
    assert.equal(path.resolve(resolveSafeInstallTarget(devRepo, installedRoot)), path.resolve(installedRoot));

    fs.writeFileSync(path.join(extractDir, 'plugin.json'), '{"version":"3.34.0"}', 'utf8');
    const okTree = validateExtractedTreeSafe(extractDir);
    assert.equal(okTree.ok, true);
    assert.equal(okTree.fileCount, 1);

    // Reject symlink traversal inside extracted tree when OS permits symlink creation
    const targetOutside = path.join(os.tmpdir(), 'outside-target.txt');
    const symPath = path.join(extractDir, 'escape-link');
    let symlinkCreated = false;
    try {
      fs.symlinkSync(targetOutside, symPath);
      symlinkCreated = true;
    } catch {}
    if (symlinkCreated) {
      assert.throws(() => validateExtractedTreeSafe(extractDir), /symlink/i);
    }
  } finally {
    fs.rmSync(devRepo, { recursive: true, force: true });
    fs.rmSync(installedRoot, { recursive: true, force: true });
    fs.rmSync(extractDir, { recursive: true, force: true });
  }
});

test('4. applyPluginUpdate downloads, extracts, installs, preserves router-state.json & updates status', async () => {
  const installedRoot = makeFakePluginRoot('3.33.1', {
    withGit: false,
    state: { uiLanguage: 'ru', gpuEnabled: true, customKeep: 'keep-me-intact' },
  });
  try {
    fs.mkdirSync(path.join(installedRoot, '.cache'), { recursive: true });
    fs.writeFileSync(
      path.join(installedRoot, '.cache', 'plugin-update-check.json'),
      JSON.stringify({ ok: true, latestVersion: '3.38.0' }),
      'utf8'
    );

    // Reject untrusted download URL safely
    const badRes = await applyPluginUpdate({
      pluginRoot: installedRoot,
      downloadUrl: 'https://evil.example.com/payload.zip',
      targetVersion: '3.38.0',
      lang: 'ru',
    });
    assert.equal(badRes.ok, false);
    assert.equal(badRes.phase, 'error');
    assert.equal(badRes.needsRestart, false);

    // Successful update using mocked fetch + mock zip extractor
    const fakeZipBytes = Buffer.from('PK\x03\x04fake-archive');
    const applyRes = await applyPluginUpdate({
      pluginRoot: installedRoot,
      downloadUrl: 'https://codeload.github.com/vaszuevvas-coder/antigravity-model-router/zip/refs/tags/v3.38.0',
      targetVersion: '3.38.0',
      lang: 'ru',
      fetchFn: async () => ({
        ok: true,
        status: 200,
        url: 'https://codeload.github.com/vaszuevvas-coder/antigravity-model-router/zip/refs/tags/v3.38.0',
        headers: { get: (k) => (k.toLowerCase() === 'content-length' ? String(fakeZipBytes.length) : null) },
        arrayBuffer: async () => fakeZipBytes.buffer.slice(fakeZipBytes.byteOffset, fakeZipBytes.byteOffset + fakeZipBytes.byteLength),
      }),
      extractZipFn: async (_zipPath, destDir) => {
        const inner = path.join(destDir, 'antigravity-model-router-3.38.0');
        fs.mkdirSync(path.join(inner, 'core'), { recursive: true });
        fs.writeFileSync(
          path.join(inner, 'plugin.json'),
          JSON.stringify({ name: 'antigravity-model-router', version: '3.38.0' }, null, 2),
          'utf8'
        );
        fs.writeFileSync(
          path.join(inner, 'router-state.json'),
          JSON.stringify({ uiLanguage: 'en', gpuEnabled: false }, null, 2),
          'utf8'
        );
        fs.writeFileSync(path.join(inner, 'core', 'new-feature.mjs'), 'export const wave4 = true;\n', 'utf8');
      },
    });

    assert.equal(applyRes.ok, true);
    assert.equal(applyRes.phase, 'done');
    assert.equal(applyRes.needsRestart, true);
    assert.equal(applyRes.targetVersion, '3.38.0');
    assert.equal(fs.existsSync(path.join(installedRoot, 'core', 'new-feature.mjs')), true);

    const updatedManifest = JSON.parse(fs.readFileSync(path.join(installedRoot, 'plugin.json'), 'utf8'));
    assert.equal(updatedManifest.version, '3.38.0');

    // Existing router-state.json must be preserved cleanly
    const preservedState = JSON.parse(fs.readFileSync(path.join(installedRoot, 'router-state.json'), 'utf8'));
    assert.equal(preservedState.uiLanguage, 'ru');
    assert.equal(preservedState.gpuEnabled, true);
    assert.equal(preservedState.customKeep, 'keep-me-intact');

    // Old update-check cache must be cleared after upgrade
    assert.equal(fs.existsSync(path.join(installedRoot, '.cache', 'plugin-update-check.json')), false);

    // Persisted status readable & clearable
    const st = getPluginUpdateStatus(installedRoot);
    assert.equal(st.phase, 'done');
    assert.equal(st.needsRestart, true);

    const cleared = clearPluginUpdateStatus(installedRoot);
    assert.equal(cleared.dismissed, true);
    assert.equal(cleared.phase, 'idle');
  } finally {
    fs.rmSync(installedRoot, { recursive: true, force: true });
  }
});

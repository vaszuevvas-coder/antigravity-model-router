import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
  isAllowedPluginDownloadUrl,
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

test('5. applyPluginUpdate streams body.getReader() chunks and tracks downloadedBytes/totalBytes progress', async () => {
  const installedRoot = makeFakePluginRoot('3.33.1', { withGit: false });
  const statusFile = path.join(installedRoot, '.cache', 'plugin-update-status.json');
  try {
    const chunkA = Buffer.from('PK\x03\x04chunk-one-');
    const chunkB = Buffer.from('chunk-two-end');
    const totalLen = chunkA.length + chunkB.length;
    let idx = 0;
    const chunks = [chunkA, chunkB];

    const res = await applyPluginUpdate({
      pluginRoot: installedRoot,
      downloadUrl: 'https://codeload.github.com/vaszuevvas-coder/antigravity-model-router/zip/refs/tags/v3.39.0',
      targetVersion: '3.39.0',
      lang: 'ru',
      fetchFn: async () => ({
        ok: true,
        status: 200,
        url: 'https://codeload.github.com/vaszuevvas-coder/antigravity-model-router/zip/refs/tags/v3.39.0',
        headers: { get: (k) => (k.toLowerCase() === 'content-length' ? String(totalLen) : null) },
        body: {
          getReader: () => ({
            read: async () => {
              if (idx < chunks.length) {
                const value = chunks[idx++];
                return { done: false, value };
              }
              return { done: true, value: undefined };
            },
            releaseLock: () => {},
          }),
        },
      }),
      extractZipFn: async (zipPath, destDir) => {
        // By the time extraction starts, downloadedBytes/totalBytes & percent=60 must have been persisted
        const midStatus = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
        assert.equal(midStatus.downloadedBytes, totalLen);
        assert.equal(midStatus.totalBytes, totalLen);
        assert.equal(fs.readFileSync(zipPath).length, totalLen);

        const inner = path.join(destDir, 'antigravity-model-router-3.39.0');
        fs.mkdirSync(inner, { recursive: true });
        fs.writeFileSync(
          path.join(inner, 'plugin.json'),
          JSON.stringify({ name: 'antigravity-model-router', version: '3.39.0' }, null, 2),
          'utf8'
        );
      },
    });

    assert.equal(res.ok, true);
    assert.equal(res.phase, 'done');
    assert.equal(res.downloadedBytes, totalLen);
    assert.equal(res.totalBytes, totalLen);
  } finally {
    fs.rmSync(installedRoot, { recursive: true, force: true });
  }
});

test('6. checkForPluginUpdate falls back on api.github.com timeout/error to release redirect and main branch', async () => {
  const root = makeFakePluginRoot('4.0.0');
  try {
    // Case A: api.github.com times out -> falls back to github.com/.../releases/latest 302 redirect
    const redirFetch = async (url) => {
      const s = String(url);
      if (s.includes('api.github.com')) {
        const err = new Error('The operation was aborted due to timeout');
        err.name = 'TimeoutError';
        throw err;
      }
      if (s.endsWith('/releases/latest')) {
        return {
          ok: false,
          status: 302,
          url: s,
          headers: {
            get: (k) => (k.toLowerCase() === 'location'
              ? 'https://github.com/vaszuevvas-coder/antigravity-model-router/releases/tag/v4.0.1'
              : ''),
          },
        };
      }
      throw new Error(`Unexpected URL: ${s}`);
    };
    const rRedir = await checkForPluginUpdate({ pluginRoot: root, force: true, fetchFn: redirFetch });
    assert.equal(rRedir.ok, true);
    assert.equal(rRedir.source, 'release_redirect');
    assert.equal(rRedir.latestVersion, '4.0.1');
    assert.equal(rRedir.updateAvailable, true);
    assert.equal(
      rRedir.downloadUrl,
      'https://codeload.github.com/vaszuevvas-coder/antigravity-model-router/zip/refs/tags/v4.0.1'
    );

    // Case B: api.github.com and github.com redirect both fail -> falls back to raw.githubusercontent.com plugin.json
    const branchFallbackFetch = async (url) => {
      const s = String(url);
      if (s.includes('api.github.com') || s.includes('github.com/vaszuevvas-coder/antigravity-model-router/releases/latest')) {
        throw new Error('fetch failed');
      }
      assert.match(s, /raw\.githubusercontent\.com\/.*\/main\/plugin\.json$/);
      return {
        ok: true,
        status: 200,
        json: async () => ({ name: 'antigravity-model-router', version: '4.0.2' }),
      };
    };
    const rBranch = await checkForPluginUpdate({ pluginRoot: root, force: true, fetchFn: branchFallbackFetch });
    assert.equal(rBranch.ok, true);
    assert.equal(rBranch.source, 'branch');
    assert.equal(rBranch.latestVersion, '4.0.2');
    assert.equal(rBranch.updateAvailable, true);

    // Case C: all sources time out -> localized RU timeout message preserving original detail
    const timeoutRes = await checkForPluginUpdate({
      pluginRoot: root,
      force: true,
      lang: 'ru',
      fetchFn: async () => {
        const err = new Error('The operation was aborted due to timeout');
        err.name = 'TimeoutError';
        throw err;
      },
    });
    assert.equal(timeoutRes.ok, false);
    assert.match(timeoutRes.error, /Превышено время ожидания сети/);
    assert.match(timeoutRes.error, /The operation was aborted due to timeout/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('7. Transport fallback hooks (fallbackHttpFn & fallbackDownloadFn) recover from fetch timeout/failure', async () => {
  const installedRoot = makeFakePluginRoot('4.0.0', { withGit: false });
  try {
    let httpFallbackCalls = 0;
    const checkRes = await checkForPluginUpdate({
      pluginRoot: installedRoot,
      force: true,
      fetchFn: async () => {
        throw new Error('fetch failed');
      },
      fallbackHttpFn: async (url) => {
        httpFallbackCalls++;
        assert.match(String(url), /\/releases\/latest$/);
        return {
          ok: true,
          status: 200,
          url,
          headers: { get: () => '' },
          json: async () => ({
            tag_name: 'v4.0.1',
            html_url: 'https://github.com/vaszuevvas-coder/antigravity-model-router/releases/tag/v4.0.1',
            assets: [],
          }),
        };
      },
    });
    assert.equal(checkRes.ok, true);
    assert.equal(checkRes.latestVersion, '4.0.1');
    assert.equal(checkRes.source, 'release');
    assert.equal(httpFallbackCalls, 1);

    let downloadFallbackCalls = 0;
    const fakeBytes = Buffer.from('PK\x03\x04fallback-zip');
    const applyRes = await applyPluginUpdate({
      pluginRoot: installedRoot,
      downloadUrl: 'https://codeload.github.com/vaszuevvas-coder/antigravity-model-router/zip/refs/tags/v4.0.1',
      targetVersion: '4.0.1',
      lang: 'ru',
      fetchFn: async () => {
        const err = new Error('The operation was aborted due to timeout');
        err.name = 'TimeoutError';
        throw err;
      },
      fallbackDownloadFn: async (_url, destZipPath, _curVer, { onProgress }) => {
        downloadFallbackCalls++;
        fs.writeFileSync(destZipPath, fakeBytes);
        onProgress?.(fakeBytes.length, fakeBytes.length);
        return fakeBytes.length;
      },
      extractZipFn: async (zipPath, destDir) => {
        assert.equal(fs.readFileSync(zipPath).equals(fakeBytes), true);
        const inner = path.join(destDir, 'antigravity-model-router-4.0.1');
        fs.mkdirSync(inner, { recursive: true });
        fs.writeFileSync(
          path.join(inner, 'plugin.json'),
          JSON.stringify({ name: 'antigravity-model-router', version: '4.0.1' }, null, 2),
          'utf8'
        );
      },
    });
    assert.equal(applyRes.ok, true);
    assert.equal(applyRes.phase, 'done');
    assert.equal(applyRes.targetVersion, '4.0.1');
    assert.equal(downloadFallbackCalls, 1);
  } finally {
    fs.rmSync(installedRoot, { recursive: true, force: true });
  }
});

test('8. getPluginUpdateStatus auto-clears stale needsRestart after Antigravity restart (PID + boot time + version)', () => {
  const installedRoot = makeTmpDir('tunnel-upd-restart-');
  const cacheDir = path.join(installedRoot, '.cache');
  const statusPath = path.join(cacheDir, 'plugin-update-status.json');
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(
    path.join(installedRoot, 'plugin.json'),
    JSON.stringify({ name: 'antigravity-model-router', version: '4.0.3' }, null, 2),
    'utf8'
  );

  try {
    const finishedAt = 1_700_000_000_000;

    // Scenario A: Same process before restart -> must keep phase='done', needsRestart=true
    fs.writeFileSync(
      statusPath,
      JSON.stringify({
        ok: true,
        active: false,
        phase: 'done',
        percent: 100,
        targetVersion: '4.0.3',
        needsRestart: true,
        appliedByPid: 4242,
        finishedAt,
        dismissed: false,
      }),
      'utf8'
    );
    const beforeRestart = getPluginUpdateStatus(installedRoot, {
      pid: 4242,
      serverStartedAt: finishedAt - 60_000,
      runningVersion: '4.0.2',
    });
    assert.equal(beforeRestart.phase, 'done');
    assert.equal(beforeRestart.needsRestart, true);
    assert.equal(beforeRestart.dismissed, false);

    // Scenario B: Restarted process (new PID + newer boot + runningVersion >= targetVersion) -> auto-clear & persist
    const afterRestart = getPluginUpdateStatus(installedRoot, {
      pid: 9999,
      serverStartedAt: finishedAt + 5_000,
      runningVersion: '4.0.3',
    });
    assert.equal(afterRestart.phase, 'idle');
    assert.equal(afterRestart.needsRestart, false);
    assert.equal(afterRestart.dismissed, true);
    const persisted = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    assert.equal(persisted.phase, 'idle');
    assert.equal(persisted.needsRestart, false);
    assert.equal(persisted.dismissed, true);

    // Scenario C: Legacy status file without appliedByPid
    fs.writeFileSync(
      statusPath,
      JSON.stringify({
        ok: true,
        active: false,
        phase: 'done',
        percent: 100,
        targetVersion: '4.0.3',
        needsRestart: true,
        finishedAt,
        dismissed: false,
      }),
      'utf8'
    );
    // If runningVersion is still older than targetVersion, do NOT clear yet
    const legacyStillOld = getPluginUpdateStatus(installedRoot, {
      pid: 9999,
      serverStartedAt: finishedAt + 5_000,
      runningVersion: '4.0.2',
    });
    assert.equal(legacyStillOld.phase, 'done');
    assert.equal(legacyStillOld.needsRestart, true);

    // Once runningVersion matches targetVersion after boot > finishedAt -> auto-clear
    const legacyCleared = getPluginUpdateStatus(installedRoot, {
      pid: 9999,
      serverStartedAt: finishedAt + 5_000,
      runningVersion: '4.0.3',
    });
    assert.equal(legacyCleared.phase, 'idle');
    assert.equal(legacyCleared.needsRestart, false);
    assert.equal(legacyCleared.dismissed, true);
  } finally {
    fs.rmSync(installedRoot, { recursive: true, force: true });
  }
});

test('9. Security hardening: repo-pinned download URL, SHA-256 verification & manifest guard before install.js', async () => {
  // Repo pinning rejects foreign GitHub repos and direct CDN hosts as initial downloadUrl
  assert.equal(
    isAllowedPluginDownloadUrl('https://github.com/vaszuevvas-coder/antigravity-model-router/releases/download/v4.0.6/app.zip'),
    true
  );
  assert.equal(
    isAllowedPluginDownloadUrl('https://codeload.github.com/vaszuevvas-coder/antigravity-model-router/zip/refs/heads/main'),
    true
  );
  assert.equal(
    isAllowedPluginDownloadUrl('https://github.com/attacker/evil-plugin/releases/download/v1.0.0/evil.zip'),
    false
  );
  assert.equal(
    isAllowedPluginDownloadUrl('https://codeload.github.com/attacker/evil-plugin/zip/refs/heads/main'),
    false
  );
  assert.equal(
    isAllowedPluginDownloadUrl('https://objects.githubusercontent.com/github-production-release-asset/123/app.zip'),
    false
  );

  const installedRoot = makeFakePluginRoot('4.0.5', { withGit: false });
  try {
    // 1) Foreign GitHub repo rejected by applyPluginUpdate
    const foreignRes = await applyPluginUpdate({
      pluginRoot: installedRoot,
      downloadUrl: 'https://github.com/attacker/evil-plugin/releases/download/v9.9.9/evil.zip',
      targetVersion: '9.9.9',
      lang: 'en',
    });
    assert.equal(foreignRes.ok, false);
    assert.equal(foreignRes.phase, 'error');

    // 2) SHA-256 mismatch aborts before extraction and before install.js
    const payloadBytes = Buffer.from('PK\x03\x04valid-zip-bytes');
    const actualSha = createHash('sha256').update(payloadBytes).digest('hex');
    const badSha = '0'.repeat(64);
    let extractCalled = false;
    const mismatchRes = await applyPluginUpdate({
      pluginRoot: installedRoot,
      downloadUrl: 'https://codeload.github.com/vaszuevvas-coder/antigravity-model-router/zip/refs/tags/v4.0.6',
      targetVersion: '4.0.6',
      expectedSha256: badSha,
      lang: 'en',
      fetchFn: async () => ({
        ok: true,
        status: 200,
        url: 'https://codeload.github.com/vaszuevvas-coder/antigravity-model-router/zip/refs/tags/v4.0.6',
        headers: { get: () => String(payloadBytes.length) },
        arrayBuffer: async () => payloadBytes.buffer.slice(payloadBytes.byteOffset, payloadBytes.byteOffset + payloadBytes.byteLength),
      }),
      extractZipFn: async () => {
        extractCalled = true;
      },
    });
    assert.equal(mismatchRes.ok, false);
    assert.equal(mismatchRes.phase, 'error');
    assert.match(mismatchRes.error, /SHA-256 mismatch/i);
    assert.equal(extractCalled, false, 'Must abort before extracting archive on SHA-256 mismatch');

    // 3) Matching SHA-256 + mismatched archive plugin.json name aborts before install.js
    let installRan = false;
    const badManifestRes = await applyPluginUpdate({
      pluginRoot: installedRoot,
      downloadUrl: 'https://codeload.github.com/vaszuevvas-coder/antigravity-model-router/zip/refs/tags/v4.0.6',
      targetVersion: '4.0.6',
      expectedSha256: `sha256:${actualSha}`,
      lang: 'en',
      fetchFn: async () => ({
        ok: true,
        status: 200,
        url: 'https://codeload.github.com/vaszuevvas-coder/antigravity-model-router/zip/refs/tags/v4.0.6',
        headers: { get: () => String(payloadBytes.length) },
        arrayBuffer: async () => payloadBytes.buffer.slice(payloadBytes.byteOffset, payloadBytes.byteOffset + payloadBytes.byteLength),
      }),
      extractZipFn: async (_zipPath, destDir) => {
        const inner = path.join(destDir, 'spoof-4.0.6');
        fs.mkdirSync(inner, { recursive: true });
        fs.writeFileSync(
          path.join(inner, 'plugin.json'),
          JSON.stringify({ name: 'rogue-plugin', version: '4.0.6' }),
          'utf8'
        );
      },
      runInstallFn: async () => {
        installRan = true;
      },
    });
    assert.equal(badManifestRes.ok, false);
    assert.match(badManifestRes.error, /Unexpected plugin name/i);
    assert.equal(installRan, false, 'Must never execute installer for mismatched plugin.json');

    // 4) Valid SHA-256 + valid manifest succeeds and records checksumVerified=true
    const okRes = await applyPluginUpdate({
      pluginRoot: installedRoot,
      downloadUrl: 'https://codeload.github.com/vaszuevvas-coder/antigravity-model-router/zip/refs/tags/v4.0.6',
      targetVersion: '4.0.6',
      expectedSha256: actualSha,
      lang: 'en',
      fetchFn: async () => ({
        ok: true,
        status: 200,
        url: 'https://codeload.github.com/vaszuevvas-coder/antigravity-model-router/zip/refs/tags/v4.0.6',
        headers: { get: () => String(payloadBytes.length) },
        arrayBuffer: async () => payloadBytes.buffer.slice(payloadBytes.byteOffset, payloadBytes.byteOffset + payloadBytes.byteLength),
      }),
      extractZipFn: async (_zipPath, destDir) => {
        const inner = path.join(destDir, 'antigravity-model-router-4.0.6');
        fs.mkdirSync(inner, { recursive: true });
        fs.writeFileSync(
          path.join(inner, 'plugin.json'),
          JSON.stringify({
            name: 'antigravity-model-router',
            version: '4.0.6',
            repository: { type: 'git', url: 'https://github.com/vaszuevvas-coder/antigravity-model-router.git' },
          }),
          'utf8'
        );
      },
    });
    assert.equal(okRes.ok, true);
    assert.equal(okRes.phase, 'done');
    assert.equal(okRes.checksumVerified, true);
  } finally {
    fs.rmSync(installedRoot, { recursive: true, force: true });
  }
});


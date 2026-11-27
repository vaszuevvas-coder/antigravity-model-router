import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  getInstallStatus,
  maintainCacheDir,
  parseInstallCliArgs,
  runInstall,
  runUninstall,
} from '../install.js';
import { buildReleasePackages } from '../scripts/pack-release.mjs';
import { buildPanelUi } from '../core/panel-ui-builder.mjs';
import { checkInstalledPluginDrift } from '../core/hook-runner.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const REPO_ROUTER_STATE_PATH = path.join(ROOT_DIR, 'router-state.json');

function snapshotFile(filePath) {
  const existed = fs.existsSync(filePath);
  return {
    filePath,
    existed,
    raw: existed ? fs.readFileSync(filePath) : null,
  };
}

function restoreFile(snap) {
  if (!snap) return;
  if (snap.existed) {
    if (fs.existsSync(snap.filePath) && fs.readFileSync(snap.filePath).equals(snap.raw)) return;
    fs.mkdirSync(path.dirname(snap.filePath), { recursive: true });
    fs.writeFileSync(snap.filePath, snap.raw);
  } else if (fs.existsSync(snap.filePath)) {
    fs.unlinkSync(snap.filePath);
  }
}

function parseZipCentralDirectory(zipBuf) {
  let eocdOffset = -1;
  const minOffset = Math.max(0, zipBuf.length - 65557);
  for (let i = zipBuf.length - 22; i >= minOffset; i--) {
    if (zipBuf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  assert.ok(eocdOffset >= 0, 'ZIP EOCD signature not found');

  const totalEntries = zipBuf.readUInt16LE(eocdOffset + 10);
  const centralDirSize = zipBuf.readUInt32LE(eocdOffset + 12);
  const centralDirOffset = zipBuf.readUInt32LE(eocdOffset + 16);
  assert.ok(centralDirOffset + centralDirSize <= eocdOffset, 'Central directory bounds invalid');

  const entries = [];
  let cursor = centralDirOffset;
  for (let i = 0; i < totalEntries; i++) {
    const sig = zipBuf.readUInt32LE(cursor);
    assert.equal(sig, 0x02014b50, `Invalid central directory header signature at ${cursor}`);

    const method = zipBuf.readUInt16LE(cursor + 10);
    const crc32 = zipBuf.readUInt32LE(cursor + 16);
    const compressedSize = zipBuf.readUInt32LE(cursor + 20);
    const uncompressedSize = zipBuf.readUInt32LE(cursor + 24);
    const nameLen = zipBuf.readUInt16LE(cursor + 28);
    const extraLen = zipBuf.readUInt16LE(cursor + 30);
    const commentLen = zipBuf.readUInt16LE(cursor + 32);
    const localHeaderOffset = zipBuf.readUInt32LE(cursor + 42);
    const name = zipBuf.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8');

    entries.push({
      name,
      method,
      crc32,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });

    cursor += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}

function readZipEntryBuffer(zipBuf, entry) {
  const off = entry.localHeaderOffset;
  assert.equal(zipBuf.readUInt32LE(off), 0x04034b50, `Invalid local header signature for ${entry.name}`);
  const nameLen = zipBuf.readUInt16LE(off + 26);
  const extraLen = zipBuf.readUInt16LE(off + 28);
  const dataStart = off + 30 + nameLen + extraLen;
  const payload = zipBuf.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.method === 0) return payload;
  if (entry.method === 8) return zlib.inflateRawSync(payload);
  throw new Error(`Unsupported ZIP compression method ${entry.method} for ${entry.name}`);
}

test('install.js clean install, status/CLI, dryRun, drift check, state upgrade, and purge uninstall', () => {
  const routerStateSnap = snapshotFile(REPO_ROUTER_STATE_PATH);
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-install-life-'));
  const tmpTarget = path.join(tmpRoot, 'antigravity-model-router');

  try {
    // 1. Clean install into isolated os.tmpdir() target
    const installRes = runInstall({ targetDir: tmpTarget, silent: true });
    assert.equal(installRes.ok, true);
    assert.equal(installRes.dryRun, false);
    assert.equal(path.resolve(installRes.targetDir), path.resolve(tmpTarget));

    // Included files
    for (const rel of [
      'core/hook-runner.mjs',
      'sidecars/panel/ui.html',
      'skills/deep-stress-auditor/scripts/run-stress-audit.mjs',
      'rules/AGENTS.md',
      'hooks.json',
      'plugin.json',
      'router-state.json',
    ]) {
      assert.equal(
        fs.existsSync(path.join(tmpTarget, rel)),
        true,
        `Expected installed file to exist: ${rel}`
      );
    }

    // Excluded paths
    for (const excludedRel of [
      'tests',
      'sidecars/panel/ui-src',
      'scripts',
      '.git',
    ]) {
      assert.equal(
        fs.existsSync(path.join(tmpTarget, excludedRel)),
        false,
        `Expected excluded path to be absent: ${excludedRel}`
      );
    }

    // 2. Programmatic getInstallStatus & CLI --status --json
    const statusRes = getInstallStatus({ targetDir: tmpTarget });
    assert.equal(statusRes.installed, true);
    assert.equal(statusRes.hasState, true);
    assert.ok(statusRes.version.length > 0);
    assert.equal(path.resolve(statusRes.targetDir), path.resolve(tmpTarget));

    const cliRaw = execFileSync(
      process.execPath,
      [path.join(ROOT_DIR, 'install.js'), '--status', '--target', tmpTarget, '--json'],
      { cwd: ROOT_DIR, encoding: 'utf8', timeout: 10000 }
    );
    const cliStatus = JSON.parse(cliRaw);
    assert.equal(cliStatus.installed, true);
    assert.equal(cliStatus.hasState, true);
    assert.equal(cliStatus.version, statusRes.version);
    assert.equal(path.resolve(cliStatus.targetDir), path.resolve(tmpTarget));

    // 3. Dry-run install
    const dryRes = runInstall({ targetDir: tmpTarget, dryRun: true, silent: true });
    assert.equal(dryRes.ok, true);
    assert.equal(dryRes.dryRun, true);
    assert.ok(dryRes.state && typeof dryRes.state === 'object');

    // 4. Drift check before and after modifying tmpTarget/rules/AGENTS.md
    const noDrift = checkInstalledPluginDrift({
      repoRoot: ROOT_DIR,
      installedRoot: tmpTarget,
    });
    assert.equal(noDrift.checked, true);
    assert.equal(noDrift.hasDrift, false);
    assert.deepEqual(noDrift.driftedFiles, []);

    const installedAgentsPath = path.join(tmpTarget, 'rules', 'AGENTS.md');
    fs.appendFileSync(installedAgentsPath, '\n<!-- synthetic drift marker -->\n', 'utf8');
    const withDrift = checkInstalledPluginDrift({
      repoRoot: ROOT_DIR,
      installedRoot: tmpTarget,
    });
    assert.equal(withDrift.checked, true);
    assert.equal(withDrift.hasDrift, true);
    assert.ok(
      withDrift.driftedFiles.includes('rules/AGENTS.md'),
      `Expected driftedFiles to contain rules/AGENTS.md, got ${JSON.stringify(withDrift.driftedFiles)}`
    );

    // 5. Upgrade install over customized router-state.json
    const destStatePath = path.join(tmpTarget, 'router-state.json');
    const existingState = JSON.parse(fs.readFileSync(destStatePath, 'utf8'));
    const customizedState = {
      ...existingState,
      onboardingCompleted: true,
      hardwareProfiled: true,
      subscriptionTier: 'ultra',
      panelCollapsedCards: {
        telemetrySwarmSpoiler: true,
        customCollapsedCard: true,
      },
      gpuChatModel: 'gemma3:12b',
      workerModel: 'flash',
    };
    fs.writeFileSync(destStatePath, JSON.stringify(customizedState, null, 2) + '\n', 'utf8');

    const upgradeRes = runInstall({ targetDir: tmpTarget, silent: true });
    assert.equal(upgradeRes.ok, true);

    const upgradedState = JSON.parse(fs.readFileSync(destStatePath, 'utf8'));
    assert.equal(upgradedState.subscriptionTier, 'ultra');
    assert.deepEqual(upgradedState.panelCollapsedCards, {
      telemetrySwarmSpoiler: true,
      customCollapsedCard: true,
    });
    assert.equal(upgradedState.gpuChatModel, 'gemma4:12b');
    assert.equal(Object.hasOwn(upgradedState, 'workerModel'), false);

    // 6. Uninstall with purge: true
    const uninstallRes = runUninstall({ targetDir: tmpTarget, purge: true, silent: true });
    assert.equal(uninstallRes.ok, true);
    assert.equal(uninstallRes.removed, true);
    assert.equal(fs.existsSync(tmpTarget), false);
    assert.equal(getInstallStatus({ targetDir: tmpTarget }).installed, false);
  } finally {
    restoreFile(routerStateSnap);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('maintainCacheDir migrates legacy priors/ledgers and purges 0-byte and legacy vector caches', () => {
  const routerStateSnap = snapshotFile(REPO_ROUTER_STATE_PATH);
  const tmpCache = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-cache-maint-'));

  try {
    const priorsPayload = JSON.stringify({ general: { wins: 3 } });
    const pitfallsPayload = JSON.stringify([{ id: 'p1', note: 'avoid' }]);
    fs.writeFileSync(path.join(tmpCache, 'bayesian-priors.json'), priorsPayload, 'utf8');
    fs.writeFileSync(path.join(tmpCache, 'pitfall-ledger.json'), pitfallsPayload, 'utf8');
    fs.writeFileSync(path.join(tmpCache, 'repomap-deadbeef.json'), '', 'utf8');
    fs.writeFileSync(path.join(tmpCache, 'compaction-digest-deadbeef.md'), '', 'utf8');
    fs.writeFileSync(path.join(tmpCache, 'gpu-vectors-deadbeef.json'), '{"vectors":[]}', 'utf8');

    const stats = maintainCacheDir(tmpCache);

    assert.equal(fs.existsSync(path.join(tmpCache, 'bayesian-priors.json')), false);
    assert.equal(fs.existsSync(path.join(tmpCache, 'pitfall-ledger.json')), false);
    assert.equal(fs.readFileSync(path.join(tmpCache, 'domain-priors.json'), 'utf8'), priorsPayload);
    assert.equal(fs.readFileSync(path.join(tmpCache, 'pitfalls-ledger.json'), 'utf8'), pitfallsPayload);

    assert.equal(fs.existsSync(path.join(tmpCache, 'repomap-deadbeef.json')), false);
    assert.equal(fs.existsSync(path.join(tmpCache, 'compaction-digest-deadbeef.md')), false);
    assert.equal(fs.existsSync(path.join(tmpCache, 'gpu-vectors-deadbeef.json')), false);

    assert.ok(stats.legacyRemoved >= 2);
    assert.ok(stats.repomapsRemoved >= 1);
    assert.ok(stats.digestsPruned >= 1);
    assert.ok(stats.vectorsPurged >= 1);
  } finally {
    restoreFile(routerStateSnap);
    fs.rmSync(tmpCache, { recursive: true, force: true });
  }
});

test('buildPanelUi({ checkOnly: true }) reports ui.html in sync with ok: true', () => {
  const res = buildPanelUi({ repoRoot: ROOT_DIR, checkOnly: true });
  assert.equal(res.ok, true);
  assert.equal(res.skipped, false);
  assert.equal(res.inSync, true);
});

test('buildReleasePackages({ zipOnly: true }) emits verified ZIP, SHA256SUMS.txt, release-manifest.json, and sanitized state', () => {
  const routerStateSnap = snapshotFile(REPO_ROUTER_STATE_PATH);
  const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-pack-life-'));

  try {
    const packRes = buildReleasePackages({
      repoRoot: ROOT_DIR,
      outDir: tmpOut,
      zipOnly: true,
      silent: true,
    });

    assert.equal(packRes.ok, true);
    assert.equal(fs.existsSync(packRes.zipPath), true);
    assert.equal(fs.existsSync(packRes.sumsPath), true);
    assert.equal(fs.existsSync(packRes.manifestPath), true);

    const zipBuf = fs.readFileSync(packRes.zipPath);
    const actualSha256 = crypto.createHash('sha256').update(zipBuf).digest('hex');

    const sumsText = fs.readFileSync(packRes.sumsPath, 'utf8');
    const zipFileName = path.basename(packRes.zipPath);
    const sumLines = sumsText.trim().split(/\r?\n/);
    const matchingSumLine = sumLines.find((line) => line.endsWith(`  ${zipFileName}`));
    assert.ok(matchingSumLine, `SHA256SUMS.txt missing entry for ${zipFileName}`);
    assert.equal(matchingSumLine.split(/\s+/)[0], actualSha256);

    const manifest = JSON.parse(fs.readFileSync(packRes.manifestPath, 'utf8'));
    const zipArtifact = manifest.artifacts?.find((a) => a.fileName === zipFileName);
    assert.ok(zipArtifact, 'release-manifest.json missing zip artifact entry');
    assert.equal(path.isAbsolute(String(zipArtifact.path || '')), false, 'release-manifest.json must not leak local absolute paths');
    assert.equal(zipArtifact.sha256, actualSha256);
    assert.equal(zipArtifact.bytes, zipBuf.length);

    // Parse ZIP central directory and validate contents
    const entries = parseZipCentralDirectory(zipBuf);
    assert.ok(entries.length > 10, 'Expected release ZIP to contain plugin files');

    for (const entry of entries) {
      const normalized = entry.name.replace(/\\/g, '/');
      assert.equal(
        /(?:^|\/)tests\//.test(normalized),
        false,
        `Archive must not contain tests/ entry: ${normalized}`
      );
      assert.equal(
        /(?:^|\/)\.cache\//.test(normalized),
        false,
        `Archive must not contain .cache/ entry: ${normalized}`
      );
      assert.equal(
        /(?:^|\/)ui-src\//.test(normalized),
        false,
        `Archive must not contain ui-src/ entry: ${normalized}`
      );
    }

    const stateEntry = entries.find((e) => e.name === 'antigravity-model-router/router-state.json');
    assert.ok(stateEntry, 'Expected antigravity-model-router/router-state.json inside release ZIP');

    const packagedState = JSON.parse(readZipEntryBuffer(zipBuf, stateEntry).toString('utf8'));
    assert.equal(packagedState.onboardingCompleted, false);
    assert.equal(packagedState.gpuEnabled, false);
    assert.equal(packagedState.gpuModelsDir, '');
  } finally {
    restoreFile(routerStateSnap);
    fs.rmSync(tmpOut, { recursive: true, force: true });
  }
});

test('install.js safety guards: uninstall refuses unmarked dir, install blocks subpath target, nested exclusions pruned, CLI args validated, corrupted cache healed', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-install-guards-'));
  try {
    // 1. runUninstall refuses to delete an unmarked directory
    const unrelatedDir = path.join(tmpRoot, 'important-user-folder');
    fs.mkdirSync(unrelatedDir, { recursive: true });
    fs.writeFileSync(path.join(unrelatedDir, 'notes.txt'), 'keep me', 'utf8');
    const badUninstall = runUninstall({ targetDir: unrelatedDir, silent: true, lang: 'en' });
    assert.equal(badUninstall.ok, false);
    assert.equal(badUninstall.removed, false);
    assert.equal(fs.existsSync(path.join(unrelatedDir, 'notes.txt')), true);

    // 2. runInstall refuses when targetDir is inside srcRoot
    const srcRoot = path.join(tmpRoot, 'src-repo');
    fs.mkdirSync(path.join(srcRoot, 'sidecars', 'panel'), { recursive: true });
    fs.mkdirSync(path.join(srcRoot, 'skills', 'bundled'), { recursive: true });
    fs.writeFileSync(path.join(srcRoot, 'plugin.json'), JSON.stringify({ name: 'antigravity-model-router', version: '4.0.5' }), 'utf8');
    fs.writeFileSync(path.join(srcRoot, 'router-state.json'), JSON.stringify({ uiLanguage: 'en' }), 'utf8');
    fs.writeFileSync(path.join(srcRoot, 'sidecars', 'panel', 'ui.html'), '<html></html>', 'utf8');
    fs.writeFileSync(path.join(srcRoot, 'skills', 'bundled', 'SKILL.md'), '---\nname: bundled\ndescription: bundled\n---\n', 'utf8');

    const subpathRes = runInstall({
      srcRoot,
      targetDir: path.join(srcRoot, 'nested-out'),
      silent: true,
      lang: 'en',
    });
    assert.equal(subpathRes.ok, false);
    assert.equal(fs.existsSync(path.join(srcRoot, 'nested-out')), false);

    // 3. Stale NESTED_EXCLUDE directories (e.g. ui-src) are pruned on upgrade while preserving project-* skills
    const destRoot = path.join(tmpRoot, 'dest-plugin');
    fs.mkdirSync(path.join(destRoot, 'sidecars', 'panel', 'ui-src'), { recursive: true });
    fs.writeFileSync(path.join(destRoot, 'sidecars', 'panel', 'ui-src', 'stale.js'), '// stale', 'utf8');
    fs.mkdirSync(path.join(destRoot, 'skills', 'project-local'), { recursive: true });
    fs.writeFileSync(path.join(destRoot, 'skills', 'project-local', 'SKILL.md'), '---\nname: project-local\ndescription: local\n---\n', 'utf8');

    const installRes = runInstall({ srcRoot, targetDir: destRoot, silent: true, lang: 'en' });
    assert.equal(installRes.ok, true);
    assert.equal(fs.existsSync(path.join(destRoot, 'sidecars', 'panel', 'ui-src')), false);
    assert.equal(fs.existsSync(path.join(destRoot, 'skills', 'project-local', 'SKILL.md')), true);

    // 4. parseInstallCliArgs catches missing flag values and unknown arguments, and CLI exits non-zero
    const missingTarget = parseInstallCliArgs(['--target', '--silent']);
    assert.equal(missingTarget.targetDir, '');
    assert.equal(missingTarget.silent, true);
    assert.ok(missingTarget.errors.length > 0);

    const missingLang = parseInstallCliArgs(['--lang', '--dry-run']);
    assert.equal(missingLang.lang, '');
    assert.ok(missingLang.errors.length > 0);

    const unknownArg = parseInstallCliArgs(['--taget', path.join(tmpRoot, 'x')]);
    assert.deepEqual(unknownArg.unknownArgs, ['--taget', path.join(tmpRoot, 'x')]);
    assert.ok(unknownArg.errors.length > 0);

    assert.throws(() => {
      execFileSync(process.execPath, [path.join(ROOT_DIR, 'install.js'), '--taget', destRoot], {
        cwd: ROOT_DIR,
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 10000,
      });
    });

    // 5. maintainCacheDir self-heals corrupted JSON caches
    const cacheDir = path.join(tmpRoot, 'corrupt-cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'circuit-breaker.json'), '{broken json', 'utf8');
    fs.writeFileSync(path.join(cacheDir, 'compaction-state.json'), '{broken json', 'utf8');
    const maintRes = maintainCacheDir(cacheDir);
    assert.equal(fs.existsSync(path.join(cacheDir, 'circuit-breaker.json')), false);
    assert.equal(fs.existsSync(path.join(cacheDir, 'compaction-state.json')), false);
    assert.ok(maintRes.legacyRemoved >= 2);

    // 6. install.sh avoids double 'v$(node -v)'
    const installSh = fs.readFileSync(path.join(ROOT_DIR, 'install.sh'), 'utf8');
    assert.equal(installSh.includes('v$(node -v)'), false);
    assert.match(installSh, /\[\[ "\$NODE_MAJOR" =~ \^\[0-9\]\+\$ \]\]/);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

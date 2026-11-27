import { ROOT_DIR, makeTempDir, registerSuiteLifecycle } from './helpers/router-test-env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import zlib from 'node:zlib';
import {
  getInstallStatus,
  parseInstallCliArgs,
  runInstall,
  runUninstall,
} from '../install.js';
import { buildReleasePackages, createSanitizedDefaultState, createSanitizedMcpConfig } from '../scripts/pack-release.mjs';

registerSuiteLifecycle(test);

function readZipEntriesForTest(zipBuffer) {
  const entries = new Map();
  let eocdOffset = -1;
  for (let i = zipBuffer.length - 22; i >= Math.max(0, zipBuffer.length - 65557); i--) {
    if (zipBuffer.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  assert.ok(eocdOffset >= 0, 'ZIP End of Central Directory signature not found');
  const totalEntries = zipBuffer.readUInt16LE(eocdOffset + 10);
  let cdOffset = zipBuffer.readUInt32LE(eocdOffset + 16);

  for (let i = 0; i < totalEntries; i++) {
    assert.equal(zipBuffer.readUInt32LE(cdOffset), 0x02014b50);
    const method = zipBuffer.readUInt16LE(cdOffset + 10);
    const compSize = zipBuffer.readUInt32LE(cdOffset + 20);
    const nameLen = zipBuffer.readUInt16LE(cdOffset + 28);
    const extraLen = zipBuffer.readUInt16LE(cdOffset + 30);
    const commentLen = zipBuffer.readUInt16LE(cdOffset + 32);
    const localOffset = zipBuffer.readUInt32LE(cdOffset + 42);
    const name = zipBuffer.subarray(cdOffset + 46, cdOffset + 46 + nameLen).toString('utf8');

    const localNameLen = zipBuffer.readUInt16LE(localOffset + 26);
    const localExtraLen = zipBuffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const rawSlice = zipBuffer.subarray(dataStart, dataStart + compSize);
    const content = method === 8 ? zlib.inflateRawSync(rawSlice) : Buffer.from(rawSlice);
    entries.set(name, content);
    cdOffset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

test('15. Release Packaging & Auto-Installer Lifecycle (install, backup, uninstall, ZIP + Setup.exe)', () => {
  const parsed = parseInstallCliArgs(['--uninstall', '--purge', '--silent', '--target', 'C:\\tmp\\plugin']);
  assert.equal(parsed.action, 'uninstall');
  assert.equal(parsed.purge, true);
  assert.equal(parsed.silent, true);
  assert.equal(parsed.targetDir, 'C:\\tmp\\plugin');

  const cleanState = createSanitizedDefaultState({
    strategy: 'pro_architect',
    hardwareProfiled: true,
    onboardingCompleted: true,
    gpuEnabled: true,
    gpuModelsDir: 'C:\\Models\\Custom',
    ramMaxBudgetMb: 24576,
    skillModes: { 'model-router': 'always' },
    chainOfDraft: true,
  });
  assert.equal(cleanState.hardwareProfiled, false);
  assert.equal(cleanState.onboardingCompleted, false);
  assert.equal(cleanState.gpuEnabled, false);
  assert.equal(cleanState.gpuModelsDir, '');
  assert.equal(cleanState.ramMaxBudgetMb, 4096);
  assert.deepEqual(cleanState.skillModes, {});
  assert.equal('chainOfDraft' in cleanState, false);

  const cleanMcp = createSanitizedMcpConfig({
    mcpServers: {
      'ram-memory': {
        command: 'node',
        args: ['--max-old-space-size=16384', 'C:\\secret\\core\\ram-memory-mcp.mjs'],
      },
    },
  });
  assert.deepEqual(cleanMcp.mcpServers['ram-memory'].args, [
    '--max-old-space-size=4096',
    './core/ram-memory-mcp.mjs',
  ]);

  const tmpRoot = makeTempDir('amr-release-');
  try {
    const tmpTarget = path.join(tmpRoot, 'plugins', 'antigravity-model-router');

    // 1. Чистая установка в изолированную папку
    const res1 = runInstall({ srcRoot: ROOT_DIR, targetDir: tmpTarget, silent: true });
    assert.equal(res1.ok, true);
    assert.equal(fs.existsSync(path.join(tmpTarget, 'plugin.json')), true);
    assert.equal(fs.existsSync(path.join(tmpTarget, 'install.js')), false);
    assert.equal(fs.existsSync(path.join(tmpTarget, 'scripts')), false);
    assert.equal(fs.existsSync(path.join(tmpTarget, 'dist')), false);
    for (const relScript of [
      'skills/ast-codemod-refactor/scripts/run-codemod.mjs',
      'skills/deep-stress-auditor/scripts/run-stress-audit.mjs',
      'skills/delta-bug-minimizer/scripts/ddmin-runner.mjs',
      'skills/program-slicer-ocd/scripts/slice-variable.mjs',
      'skills/ui-ux-design-system/scripts/build-showroom.mjs',
    ]) {
      assert.equal(fs.existsSync(path.join(tmpTarget, relScript)), true, `Missing skill script: ${relScript}`);
    }
    const mcpAfter1 = JSON.parse(fs.readFileSync(path.join(tmpTarget, 'mcp_config.json'), 'utf8'));
    assert.equal(
      mcpAfter1.mcpServers['ram-memory'].args[1],
      path.join(tmpTarget, 'core', 'ram-memory-mcp.mjs')
    );

    // 2. Повторная установка (обновление) с сохранением пользовательского профиля и бэкапом
    const statePath = path.join(tmpTarget, 'router-state.json');
    const customState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    customState.strategy = 'pro_architect';
    customState.onboardingCompleted = true;
    customState.ramMaxBudgetMb = 8192;
    fs.writeFileSync(statePath, JSON.stringify(customState, null, 2), 'utf8');

    const res2 = runInstall({ srcRoot: ROOT_DIR, targetDir: tmpTarget, silent: true });
    assert.equal(res2.ok, true);
    assert.equal(fs.existsSync(path.join(tmpTarget, '.cache', 'router-state.backup.json')), true);
    const stateAfter2 = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(stateAfter2.strategy, 'pro_architect');
    assert.equal(stateAfter2.onboardingCompleted, true);
    const mcpAfter2 = JSON.parse(fs.readFileSync(path.join(tmpTarget, 'mcp_config.json'), 'utf8'));
    assert.equal(mcpAfter2.mcpServers['ram-memory'].args[0], '--max-old-space-size=8192');

    // 3. Проверка статуса, удаления с внешним бэкапом и восстановления при переустановке
    const stInstalled = getInstallStatus({ targetDir: tmpTarget });
    assert.equal(stInstalled.installed, true);
    assert.equal(stInstalled.hasState, true);
    assert.ok(stInstalled.stateBackupPath.endsWith('router-state.backup.json'));

    const uninst = runUninstall({ targetDir: tmpTarget, silent: true });
    assert.equal(uninst.ok, true);
    assert.equal(uninst.removed, true);
    assert.equal(fs.existsSync(tmpTarget), false);
    assert.equal(fs.existsSync(uninst.backupPath), true);

    const dry = runInstall({ srcRoot: ROOT_DIR, targetDir: tmpTarget, dryRun: true, silent: true });
    assert.equal(dry.dryRun, true);
    assert.equal(dry.restoredFromBackup, true);
    assert.equal(fs.existsSync(tmpTarget), false);

    const res3 = runInstall({ srcRoot: ROOT_DIR, targetDir: tmpTarget, silent: true });
    assert.equal(res3.restoredFromBackup, true);
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).strategy, 'pro_architect');

    // 4. Полная сборка релиза (ZIP + SHA256SUMS.txt + Setup.exe на Windows)
    const isMutationSandbox = process.env.AMR_MUTATION_SANDBOX === '1';
    const tmpDist = fs.mkdtempSync(path.join(tmpRoot, 'amr-release-dist-'));
    try {
    const packRes = buildReleasePackages({ repoRoot: ROOT_DIR, outDir: tmpDist, silent: true, zipOnly: isMutationSandbox });
    assert.equal(packRes.ok, true);
    assert.equal(fs.existsSync(packRes.zipPath), true);
    assert.equal(fs.existsSync(packRes.sumsPath), true);
    assert.equal(fs.existsSync(packRes.manifestPath), true);

    const zipEntries = readZipEntriesForTest(fs.readFileSync(packRes.zipPath));
    assert.equal(zipEntries.has('antigravity-model-router/Установить плагин.bat'), true);
    assert.equal(zipEntries.has('antigravity-model-router/Удалить плагин.bat'), true);
    assert.equal(zipEntries.has('antigravity-model-router/install.sh'), true);
    assert.equal(zipEntries.has('antigravity-model-router/install.js'), true);
    for (const entryName of zipEntries.keys()) {
      assert.equal(/(?:^|\/)(?:\.cache|tests|scratch|dist|\.git)\//i.test(entryName), false);
    }

    const zippedState = JSON.parse(zipEntries.get('antigravity-model-router/router-state.json').toString('utf8'));
    assert.equal(zippedState.hardwareProfiled, false);
    assert.equal(zippedState.onboardingCompleted, false);
    assert.equal(zippedState.gpuEnabled, false);
    assert.equal(zippedState.gpuModelsDir, '');
    const zippedMcp = JSON.parse(zipEntries.get('antigravity-model-router/mcp_config.json').toString('utf8'));
    assert.deepEqual(zippedMcp.mcpServers['ram-memory'].args, [
      '--max-old-space-size=4096',
      './core/ram-memory-mcp.mjs',
    ]);

    if (process.platform === 'win32' && !isMutationSandbox) {
      assert.ok(packRes.exePath && fs.existsSync(packRes.exePath), 'Setup.exe must be compiled on Windows');
      const tmpExeTarget = path.join(tmpRoot, 'exe-install', 'antigravity-model-router');

      execFileSync(packRes.exePath, ['--silent', '--target', tmpExeTarget], {
        encoding: 'utf8',
        timeout: 30000,
      });
      assert.equal(fs.existsSync(path.join(tmpExeTarget, 'plugin.json')), true);
      assert.equal(fs.existsSync(path.join(tmpExeTarget, 'router-state.json')), true);
      assert.equal(fs.existsSync(path.join(tmpExeTarget, 'mcp_config.json')), true);
      const exeMcp = JSON.parse(fs.readFileSync(path.join(tmpExeTarget, 'mcp_config.json'), 'utf8'));
      assert.equal(
        exeMcp.mcpServers['ram-memory'].args[1],
        path.join(tmpExeTarget, 'core', 'ram-memory-mcp.mjs')
      );

      execFileSync(packRes.exePath, ['--uninstall', '--silent', '--target', tmpExeTarget], {
        encoding: 'utf8',
        timeout: 30000,
      });
      assert.equal(fs.existsSync(tmpExeTarget), false);
      const exeBackupPath = path.join(path.dirname(tmpExeTarget), 'antigravity-model-router-state.backup.json');
      assert.equal(fs.existsSync(exeBackupPath), true);
      runUninstall({ targetDir: tmpExeTarget, purge: true, silent: true });
      assert.equal(fs.existsSync(exeBackupPath), false);
    }
    } finally {
      try { fs.rmSync(tmpDist, { recursive: true, force: true }); } catch {}
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

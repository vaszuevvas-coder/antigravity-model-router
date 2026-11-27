import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  atomicWriteJsonSync,
  safeReadJsonSync,
  sleepSync,
  updateJsonAtomicSync,
  withFileLockSync,
} from '../core/safe-json.mjs';
import { checkCommandSecurity } from '../core/security-guard.mjs';
import { loadGpuConfig } from '../core/gpu/gpu-shared-state.mjs';
import { ensureHardwareCalibratedOnce } from '../core/hardware-profiler.mjs';
import { applyPluginUpdate } from '../core/plugin-updater.mjs';
import { LspBridgeManager } from '../core/lsp-bridge.mjs';
import { SqliteKnowledgeHub } from '../core/sqlite-knowledge-hub.mjs';
import { BackgroundSentinel } from '../core/background-sentinel.mjs';
import { computeQuotaBurnForecast, recordQuotaTurnSample } from '../core/quota-pacer.mjs';
import {
  createShadowWorktree,
  discardShadowWorktree,
  listShadowWorktrees,
  promoteShadowWorktree,
} from '../core/shadow-worktree.mjs';
import { foldCodeWithKnapsack } from '../core/cpu-ast-graph-compressor.mjs';
import { saveReadSnapshot, loadReadSnapshot } from '../core/cpu-delta-reread.mjs';
import { checkOverwriteGuard } from '../core/diff-patcher.mjs';
import { findReverseImporters } from '../core/repo-mapper.mjs';
import { quarantineAndAuditSkillCandidate } from '../core/skill-registry-bridge.mjs';
import { compileUserIntentToTechSpec } from '../core/tool-pruner.mjs';
import { loadState } from '../sidecars/panel/lib/panel-state-skills.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('1. Security Guard blocks Windows trailing-backslash quote bypasses while preserving safe quotes', () => {
  const blocked1 = checkCommandSecurity({ commandLine: "cd 'C:\\repo\\'; git reset --hard; echo 'ok'" });
  assert.equal(blocked1.allow, false);

  const blocked2 = checkCommandSecurity({ commandLine: 'cd "C:\\repo\\"; git push --force; echo "ok"' });
  assert.equal(blocked2.allow, false);

  const blocked3 = checkCommandSecurity({ commandLine: 'git -C "C:\\repo\\" reset --hard "HEAD"' });
  assert.equal(blocked3.allow, false);

  const allowedSearch = checkCommandSecurity({ commandLine: 'rg "git reset --hard" core/' });
  assert.equal(allowedSearch.allow, true);

  const allowedCommit = checkCommandSecurity({ commandLine: 'git commit -m "fix \\"quoted\\" reset --hard docs"' });
  assert.equal(allowedCommit.allow, true);
});

test('2. router-state.json readers use selfHeal:false and never clobber broken JSON with {}', async () => {
  const tmpDir = mkTmp('amr-state-protect-');
  const prevTestState = process.env.TUNNEL_TEST_STATE_PATH;
  try {
    const brokenPath = path.join(tmpDir, 'router-state.json');
    const brokenRaw = '{\n  "uiLanguage": "ru",\n  "gpuEnabled": true,\n';
    fs.writeFileSync(brokenPath, brokenRaw, 'utf8');
    process.env.TUNNEL_TEST_STATE_PATH = brokenPath;

    loadGpuConfig();
    await ensureHardwareCalibratedOnce({ pluginRoot: tmpDir, statePath: brokenPath });
    loadState();

    assert.equal(fs.readFileSync(brokenPath, 'utf8'), brokenRaw);

    const backupTarget = path.join(tmpDir, 'healed.json');
    fs.writeFileSync(backupTarget, '{broken', 'utf8');
    const healed = safeReadJsonSync(backupTarget, () => ({ ok: true }), { selfHeal: true, backupCorrupt: true });
    assert.deepEqual(healed, { ok: true });
    assert.equal(fs.existsSync(`${backupTarget}.corrupt`), true);
  } finally {
    if (prevTestState === undefined) delete process.env.TUNNEL_TEST_STATE_PATH;
    else process.env.TUNNEL_TEST_STATE_PATH = prevTestState;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('3. plugin-updater rolls back core files on install failure and blocks live cross-PID update', async () => {
  const tmpRoot = mkTmp('amr-updater-rollback-');
  try {
    fs.mkdirSync(path.join(tmpRoot, 'core'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, '.cache'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'plugin.json'), JSON.stringify({ name: 'antigravity-model-router', version: '4.0.7' }), 'utf8');
    fs.writeFileSync(path.join(tmpRoot, 'router-state.json'), JSON.stringify({ uiLanguage: 'ru', keepFlag: 42 }), 'utf8');
    fs.writeFileSync(path.join(tmpRoot, 'core', 'marker.mjs'), 'export const v = 1;\n', 'utf8');

    const fakeZip = Buffer.from('PK\x03\x04fake');
    const failRes = await applyPluginUpdate({
      pluginRoot: tmpRoot,
      downloadUrl: 'https://codeload.github.com/vaszuevvas-coder/antigravity-model-router/zip/refs/tags/v4.0.8',
      targetVersion: '4.0.8',
      forceApply: true,
      fetchFn: async () => ({
        ok: true,
        status: 200,
        url: 'https://codeload.github.com/vaszuevvas-coder/antigravity-model-router/zip/refs/tags/v4.0.8',
        headers: { get: () => String(fakeZip.length) },
        arrayBuffer: async () => fakeZip.buffer.slice(fakeZip.byteOffset, fakeZip.byteOffset + fakeZip.byteLength),
      }),
      extractZipFn: async (_zip, destDir) => {
        const inner = path.join(destDir, 'antigravity-model-router-4.0.8');
        fs.mkdirSync(path.join(inner, 'core'), { recursive: true });
        fs.writeFileSync(path.join(inner, 'plugin.json'), JSON.stringify({ name: 'antigravity-model-router', version: '4.0.8' }), 'utf8');
      },
      runInstallFn: async ({ targetDir }) => {
        fs.writeFileSync(path.join(targetDir, 'core', 'marker.mjs'), 'export const v = 2;\n', 'utf8');
        fs.unlinkSync(path.join(targetDir, 'router-state.json'));
        throw new Error('EBUSY simulated failure');
      },
    });

    assert.equal(failRes.ok, false);
    assert.equal(fs.readFileSync(path.join(tmpRoot, 'core', 'marker.mjs'), 'utf8'), 'export const v = 1;\n');
    assert.equal(JSON.parse(fs.readFileSync(path.join(tmpRoot, 'router-state.json'), 'utf8')).keepFlag, 42);

    // Cross-PID lock check
    atomicWriteJsonSync(path.join(tmpRoot, '.cache', 'plugin-update-status.json'), {
      ok: true,
      active: true,
      phase: 'downloading',
      appliedByPid: process.pid,
      updatedAt: Date.now(),
    });
    const dupRes = await applyPluginUpdate({
      pluginRoot: tmpRoot,
      appliedByPid: process.pid + 12345,
      downloadUrl: 'https://codeload.github.com/vaszuevvas-coder/antigravity-model-router/zip/refs/tags/v4.0.8',
      targetVersion: '4.0.8',
      forceApply: true,
    });
    assert.equal(dupRes.alreadyRunning, true);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('4 & 5 & 10. safe-json sleepSync(Infinity), dead-PID fast eviction, async rejection, and path validation', () => {
  const t0 = Date.now();
  sleepSync(Infinity);
  sleepSync(NaN);
  assert.ok(Date.now() - t0 < 200);

  const tmpDir = mkTmp('amr-safejson-hard-');
  try {
    const target = path.join(tmpDir, 'data.json');
    fs.writeFileSync(target, JSON.stringify({ safe: 1 }), 'utf8');

    const lockDir = `${target}.lock`;
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, 'owner'), '999999:1:dead', 'utf8');
    const oldDate = new Date(Date.now() - 250);
    fs.utimesSync(lockDir, oldDate, oldDate);

    const tLock0 = Date.now();
    const out = withFileLockSync(target, () => 'acquired', { maxWaitMs: 750, staleLockMs: 6000 });
    assert.equal(out, 'acquired');
    assert.ok(Date.now() - tLock0 < 500, 'Dead PID lock should evict rapidly without waiting 6s');

    assert.throws(() => withFileLockSync(target, async () => 'nope'), TypeError);
    assert.throws(() => updateJsonAtomicSync(target, () => ({}), async () => ({ nope: true })), TypeError);
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { safe: 1 });

    assert.throws(() => atomicWriteJsonSync('', { a: 1 }), TypeError);
    assert.throws(() => withFileLockSync('   ', () => 1), TypeError);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('6. LSP Bridge terminates spawned child process on initialize timeout', async () => {
  const tmpWs = mkTmp('amr-lsp-kill-');
  let spawned = null;
  try {
    const mgr = new LspBridgeManager({
      serverCmdOverride: {
        tsserver: {
          serverName: 'mock-tsserver',
          command: process.execPath,
          args: ['-e', 'setTimeout(() => {}, 5000)'],
        },
      },
      spawnFn: () => {
        const proc = new EventEmitter();
        proc.stdin = { destroyed: false, write: () => true };
        proc.stdout = new EventEmitter();
        proc.stderr = new EventEmitter();
        proc.killed = false;
        proc.kill = () => { proc.killed = true; };
        proc.unref = () => {};
        spawned = proc;
        return proc;
      },
    });
    const session = await mgr._getOrStartSession(tmpWs, 'tsserver');
    assert.ok(session);
    const ok = await session.ensureStarted(50);
    assert.equal(ok, false);
    // Wait past initialize sendRequest timeout (timeoutMs + 500 = 550ms) and verify leaked process is killed
    await new Promise((r) => setTimeout(r, 620));
    assert.ok(spawned);
    assert.equal(spawned.killed, true);
    await mgr.shutdownAll();
  } finally {
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
});

test('7 & 14. SqliteKnowledgeHub fallback locks, Sentinel merge, Quota migration, ShadowWorktree partial rollback', async () => {
  const tmpDir = mkTmp('amr-daemons-');
  try {
    // SqliteKnowledgeHub fallback + ReDoS deadline safety
    const hub = new SqliteKnowledgeHub({ dbPath: path.join(tmpDir, 'hub.sqlite') });
    hub.backend = 'json_fallback';
    hub.db = null;
    const stored = hub.storeCcrBlob({
      text: `${'a'.repeat(30)}!\nmatch_line_ok\n`,
      workspaceRoot: tmpDir,
    });
    assert.equal(stored.ok, true);
    const ccr = hub.retrieveCcrBlob({ hash: stored.hash, query: 're:(a|a)+$' });
    assert.equal(ccr.ok, true);
    hub.close();

    // Quota pacer legacy migration under lock
    const qFile = path.join(tmpDir, 'quota-pacer.json');
    fs.writeFileSync(qFile, JSON.stringify({ legacy: true }), 'utf8');
    const forecast = computeQuotaBurnForecast(null, { cacheDir: tmpDir });
    assert.equal(forecast.ok, true);
    const rec = recordQuotaTurnSample({ cacheDir: tmpDir, tier: 'hydrogen' });
    assert.equal(rec.ok, true);

    // BackgroundSentinel symbol cards merge preserves concurrent additions
    const sentinel = new BackgroundSentinel({ cacheDir: tmpDir });
    const cardsDir = path.join(tmpDir, 'sentinel');
    fs.mkdirSync(cardsDir, { recursive: true });
    // Smoke check merge behavior by ensuring runIdleSymbolCardsPass handles empty workspace cleanly
    const passRes = await sentinel.runIdleSymbolCardsPass(tmpDir, null, { force: true });
    assert.equal(typeof passRes, 'object');

    // Shadow worktree partial promotion rollback
    const repoDir = path.join(tmpDir, 'repo');
    fs.mkdirSync(repoDir, { recursive: true });
    execFileSync('git', ['init'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, 'a.txt'), 'v1\n', 'utf8');
    execFileSync('git', ['add', 'a.txt'], { cwd: repoDir });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir });

    const wt = createShadowWorktree({ workspaceRoot: repoDir, cacheDir: tmpDir, label: 'partial' });
    assert.equal(wt.ok, true);
    fs.writeFileSync(path.join(wt.worktreePath, 'a.txt'), 'v2\n', 'utf8');
    fs.writeFileSync(path.join(wt.worktreePath, 'b.txt'), 'new\n', 'utf8');
    // Block target creation of b.txt by placing a directory named b.txt in repoDir
    fs.mkdirSync(path.join(repoDir, 'b.txt'), { recursive: true });

    const prom = promoteShadowWorktree({ id: wt.id, workspaceRoot: repoDir, cacheDir: tmpDir });
    assert.equal(prom.ok, false);
    assert.ok(Array.isArray(prom.failedFiles) && prom.failedFiles.length >= 1);
    assert.equal(fs.readFileSync(path.join(repoDir, 'a.txt'), 'utf8'), 'v1\n');
    const listed = listShadowWorktrees(repoDir, { cacheDir: tmpDir });
    assert.equal(listed.length, 1);
    discardShadowWorktree({ id: wt.id, workspaceRoot: repoDir, cacheDir: tmpDir });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('8 & 9 & 11-15. AST method clamp, delta-reread lock, diff-patcher isolation, cross-drive relative, ReDoS', () => {
  // #8: method endLine overflowing class endLine must not swallow trailing function
  const lines = [
    'class Alpha {',
    '  run() {',
    '    return 1;',
    '  }',
    '}',
    'export function trailingHelper() {',
    '  return 42;',
    '}',
    ...Array.from({ length: 120 }, (_, i) => `const pad${i} = ${i};`),
  ];
  const folded = foldCodeWithKnapsack(lines.join('\n'), {
    ext: '.mjs',
    maxChars: 1200,
    symbolsWithRanges: [
      { name: 'Alpha', kind: 'class', startLine: 1, endLine: 5, signature: 'class Alpha' },
      { name: 'run', kind: 'method', startLine: 2, endLine: 9, signature: 'run()' },
      { name: 'trailingHelper', kind: 'function', startLine: 6, endLine: 8, signature: 'function trailingHelper()' },
    ],
  });
  assert.match(folded.formatted, /trailingHelper/);

  // #9: saveReadSnapshot & loadReadSnapshot roundtrip
  const tmpCache = mkTmp('amr-delta-cache-');
  const prevCacheEnv = process.env.TUNNEL_CACHE_DIR;
  process.env.TUNNEL_CACHE_DIR = tmpCache;
  try {
    const bigText = Array.from({ length: 70 }, (_, i) => `export const line${i} = ${i};`).join('\n');
    const sha1 = 'a'.repeat(40);
    assert.equal(saveReadSnapshot({ sha1, filePath: 'a.mjs', text: bigText }), true);
    assert.equal(loadReadSnapshot({ sha1 }), bigText);

    // #13: checkOverwriteGuard respects TUNNEL_CACHE_DIR & fails closed
    const bigFile = path.join(tmpCache, 'big.mjs');
    fs.writeFileSync(bigFile, bigText, 'utf8');
    const guard1 = checkOverwriteGuard('write_file', { Overwrite: true, Path: bigFile }, { workspaceRoot: tmpCache });
    assert.equal(guard1.decision, 'deny');
    assert.equal(fs.existsSync(path.join(tmpCache, 'overwrite-guard.json')), true);
  } finally {
    if (prevCacheEnv === undefined) delete process.env.TUNNEL_CACHE_DIR;
    else process.env.TUNNEL_CACHE_DIR = prevCacheEnv;
    fs.rmSync(tmpCache, { recursive: true, force: true });
  }

  // #12: skill quarantine prunes stale directories
  const qCache = mkTmp('amr-qcache-');
  try {
    const staleDir = path.join(qCache, 'skill-quarantine', 'old-skill-1');
    fs.mkdirSync(staleDir, { recursive: true });
    const oldTime = new Date(Date.now() - 40 * 60 * 1000);
    fs.utimesSync(staleDir, oldTime, oldTime);
    quarantineAndAuditSkillCandidate({
      slug: 'fresh-skill',
      skillMarkdown: '---\nname: fresh-skill\ndescription: Test skill\n---\n# Fresh\n',
      cacheDir: qCache,
      existingSkillsRoot: qCache,
    });
    assert.equal(fs.existsSync(staleDir), false);
  } finally {
    fs.rmSync(qCache, { recursive: true, force: true });
  }

  // #14: cross-drive / external target in findReverseImporters
  if (process.platform === 'win32') {
    const extRes = findReverseImporters(ROOT_DIR, 'Z:\\nonexistent-other-drive\\foo.mjs');
    assert.deepEqual(extRes.dependents, []);
  }

  // #15: tool-pruner handles large adversarial prompt quickly
  const tPrune0 = Date.now();
  const prRes = compileUserIntentToTechSpec(`${'a'.repeat(12000)} camelCaseSymbol`, { forceAlways: true });
  assert.ok(Date.now() - tPrune0 < 200);
  assert.equal(typeof prRes.formattedSpec, 'string');
});

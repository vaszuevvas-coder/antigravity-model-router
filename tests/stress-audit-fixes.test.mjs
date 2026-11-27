import { ROOT_DIR, makeTempDir, registerSuiteLifecycle } from './helpers/router-test-env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

registerSuiteLifecycle(test);

import { RamMemoryEngine } from '../core/ram-memory-engine.mjs';
import { SqliteKnowledgeHub } from '../core/sqlite-knowledge-hub.mjs';
import { findReverseImporters, generateRepoMap, invalidateRepoMapCache } from '../core/repo-mapper.mjs';
import { getCpuPoolStats, runCpuBatch, shutdownCpuPool } from '../core/cpu-worker-pool.mjs';
import {
  extractClientRootFromInitialize,
  isEphemeralOrScratchWorkspace,
  registerDaemonWorkspace,
  resetStdioClientWorkspaceForTest,
  resolveDefaultWorkspace,
} from '../core/ram-memory-mcp.mjs';
import { runStressAudit } from '../skills/deep-stress-auditor/scripts/run-stress-audit.mjs';

test('1. Fix #3: RAM Engine & RepoMapper resolve TS NodeNext (.js/.mjs -> .ts/.d.ts), Vite ?query, and Python relative imports', () => {
  const tmpWs = makeTempDir('amr-fix-imports-');
  const ram = new RamMemoryEngine({ budgetMb: 256, sqliteKnowledgeEnabled: false });
  try {
    fs.mkdirSync(path.join(tmpWs, 'core'), { recursive: true });
    fs.mkdirSync(path.join(tmpWs, 'src'), { recursive: true });
    fs.mkdirSync(path.join(tmpWs, 'pypkg'), { recursive: true });

    fs.writeFileSync(
      path.join(tmpWs, 'core', 'types.ts'),
      'export interface User { id: string; }\nexport function parseUser(s: string): User { return { id: s }; }\n',
      'utf8'
    );
    fs.writeFileSync(path.join(tmpWs, 'core', 'helper.d.ts'), 'export declare const MAGIC: number;\n', 'utf8');
    fs.writeFileSync(
      path.join(tmpWs, 'src', 'service.ts'),
      [
        "import { parseUser } from '../core/types.js';",
        "import { MAGIC } from '../core/helper.js?raw';",
        'export function runService(raw: string) { return `${parseUser(raw).id}:${MAGIC}`; }',
      ].join('\n'),
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmpWs, 'src', 'app.mts'),
      "import { runService } from './service.mjs?worker';\nexport const out = runService('ok');\n",
      'utf8'
    );
    fs.writeFileSync(path.join(tmpWs, 'pypkg', '__init__.py'), 'from .helpers import calc_total\n', 'utf8');
    fs.writeFileSync(path.join(tmpWs, 'pypkg', 'helpers.py'), 'def calc_total(vals):\n    return sum(vals)\n', 'utf8');
    fs.writeFileSync(
      path.join(tmpWs, 'pypkg', 'views.py'),
      'from .helpers import calc_total\n\ndef render():\n    return calc_total([1, 2])\n',
      'utf8'
    );

    ram.warmWorkspace(tmpWs, { startWatcher: false });
    const ws = ram.getOrCreateWorkspace(tmpWs);

    const svcFwd = Array.from(ws.forwardDeps.get('src/service.ts') || []);
    assert.ok(svcFwd.includes('core/types.ts'), `Expected core/types.ts in forwardDeps, got ${JSON.stringify(svcFwd)}`);
    assert.ok(svcFwd.includes('core/helper.d.ts'), `Expected core/helper.d.ts in forwardDeps, got ${JSON.stringify(svcFwd)}`);

    const appFwd = Array.from(ws.forwardDeps.get('src/app.mts') || []);
    assert.ok(appFwd.includes('src/service.ts'), `Expected src/service.ts in app.mts forwardDeps, got ${JSON.stringify(appFwd)}`);

    const pyFwd = Array.from(ws.forwardDeps.get('pypkg/views.py') || []);
    assert.ok(pyFwd.includes('pypkg/helpers.py'), `Expected pypkg/helpers.py in views.py forwardDeps, got ${JSON.stringify(pyFwd)}`);

    const coreRev = Array.from(ws.reverseDeps.get('core/types.ts') || []);
    assert.ok(coreRev.includes('src/service.ts'));

    // Test RepoMapper cached & disk-fallback reverse importers
    generateRepoMap(tmpWs, { maxChars: 2500 });
    const tsRevCached = findReverseImporters(tmpWs, path.join(tmpWs, 'core', 'types.ts'), 10);
    assert.ok(tsRevCached.dependents.some((d) => d.file === 'src/service.ts'));

    const pyRevCached = findReverseImporters(tmpWs, path.join(tmpWs, 'pypkg', 'helpers.py'), 10);
    assert.ok(pyRevCached.dependents.some((d) => d.file === 'pypkg/views.py'));

    invalidateRepoMapCache(tmpWs);
    const tsRevDisk = findReverseImporters(tmpWs, path.join(tmpWs, 'core', 'types.ts'), 10);
    assert.ok(tsRevDisk.dependents.some((d) => d.file === 'src/service.ts'));
  } finally {
    ram.close();
    invalidateRepoMapCache(tmpWs);
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
});

test('2. Fix #1: searchSemantic accepts non-blocking foreground cap options cleanly', async () => {
  const tmpWs = makeTempDir('amr-fix-sem-');
  const ram = new RamMemoryEngine({ budgetMb: 128, sqliteKnowledgeEnabled: false });
  try {
    for (let i = 0; i < 12; i++) {
      fs.writeFileSync(path.join(tmpWs, `mod_${i}.mjs`), `export function computeOrder_${i}(x) { return x + ${i}; }\n`, 'utf8');
    }
    const res = await ram.searchSemantic(tmpWs, 'computeOrder_5', {
      maxResults: 4,
      maxForegroundIndexFiles: 4,
      blockingFullIndex: false,
    });
    assert.equal(res.ok, true);
    assert.ok(Array.isArray(res.results) && res.results.length > 0);
  } finally {
    ram.close();
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
});

test('3. Fix #2: ram-memory-mcp blocks Antigravity brain/scratch/browser_sandbox from hijacking default workspace', () => {
  assert.equal(isEphemeralOrScratchWorkspace('C:\\Users\\dev\\.gemini\\antigravity\\brain\\abc-123\\scratch'), true);
  assert.equal(isEphemeralOrScratchWorkspace('C:\\Users\\dev\\.gemini\\antigravity\\brain\\abc-123\\scratch\\browser_sandbox'), true);
  assert.equal(isEphemeralOrScratchWorkspace('C:\\Users\\dev\\.gemini\\antigravity\\scratch\\antigravity-model-router'), false);

  const tmpRoot = makeTempDir('amr-fix-mcp-');
  try {
    const realWs = path.join(tmpRoot, 'real-project');
    const fakeBrainScratch = path.join(tmpRoot, '.gemini', 'antigravity', 'brain', 'convo-999', 'scratch');
    fs.mkdirSync(realWs, { recursive: true });
    fs.mkdirSync(fakeBrainScratch, { recursive: true });
    fs.writeFileSync(path.join(realWs, 'app.mjs'), 'export const app = 1;\n', 'utf8');
    fs.writeFileSync(path.join(fakeBrainScratch, 'temp.mjs'), 'export const temp = 1;\n', 'utf8');

    const realInit = extractClientRootFromInitialize({ rootUri: pathToFileURL(realWs).href });
    assert.equal(path.resolve(realInit), path.resolve(realWs));

    const brainInit = extractClientRootFromInitialize({ rootUri: pathToFileURL(fakeBrainScratch).href });
    assert.equal(brainInit, '', 'Brain scratch root must be rejected on initialize');

    registerDaemonWorkspace(fakeBrainScratch);
    assert.equal(path.resolve(resolveDefaultWorkspace('')), path.resolve(realWs));
    assert.equal(path.resolve(resolveDefaultWorkspace('', 'temp.mjs')), path.resolve(realWs));
  } finally {
    resetStdioClientWorkspaceForTest('');
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('4. Fix #9: Ghost deleted workspace auto-evicts from RAM & ram.slice updates savedTokensEstimate', () => {
  const tmpWs = makeTempDir('amr-fix-ghost-');
  const ram = new RamMemoryEngine({ budgetMb: 128, sqliteKnowledgeEnabled: false });
  try {
    const bigLines = Array.from({ length: 240 }, (_, i) => `export const line_${i} = ${i}; // padded comment for realistic file size`).join('\n');
    fs.writeFileSync(path.join(tmpWs, 'big.mjs'), bigLines + '\n', 'utf8');

    ram.warmWorkspace(tmpWs, { startWatcher: true });
    const sl = ram.slice(tmpWs, 'big.mjs', { startLine: 1, endLine: 10 });
    assert.equal(sl.ok, true);

    const statsBeforeDelete = ram.getStats();
    assert.ok(statsBeforeDelete.savedTokensEstimate > 0, `Expected savedTokensEstimate > 0, got ${statsBeforeDelete.savedTokensEstimate}`);
    assert.equal(statsBeforeDelete.workspaces.length, 1);

    // Delete directory from disk and ensure getStats() + search() auto-evict the dead workspace cleanly
    ram.evict(tmpWs);
    ram.warmWorkspace(tmpWs, { startWatcher: false });
    fs.rmSync(tmpWs, { recursive: true, force: true });

    const searchDeleted = ram.search(tmpWs, 'line_1');
    assert.equal(searchDeleted.ok, false);
    const statsAfterDelete = ram.getStats();
    assert.equal(statsAfterDelete.workspaces.length, 0, 'Deleted workspace must be auto-evicted from RamMemoryEngine');
  } finally {
    ram.close();
    try { fs.rmSync(tmpWs, { recursive: true, force: true }); } catch {}
  }
});

test('5. Fix #7: Sync warmWorkspace builds CSR + populates SQLite AST cache so warmWorkspaceAsync skips re-parsing', async () => {
  const tmpWs = makeTempDir('amr-fix-sql-');
  const tmpDb = makeTempDir('amr-fix-sql-db-');
  const hub = new SqliteKnowledgeHub({ dbPath: path.join(tmpDb, 'cache.sqlite') });
  const ramSync = new RamMemoryEngine({ budgetMb: 128, knowledgeHub: hub, sqliteKnowledgeEnabled: true });
  const ramAsync = new RamMemoryEngine({ budgetMb: 128, knowledgeHub: hub, sqliteKnowledgeEnabled: true });
  try {
    for (let i = 0; i < 12; i++) {
      fs.writeFileSync(path.join(tmpWs, `svc_${i}.mjs`), `export function svcFn_${i}(v) { return v + ${i}; }\n`, 'utf8');
    }
    const syncRes = ramSync.warmWorkspace(tmpWs, { startWatcher: false });
    assert.equal(syncRes.ok, true);
    assert.equal(syncRes.filesLoaded, 12);
    assert.ok(ramSync.getOrCreateWorkspace(tmpWs).csrIndex !== null, 'Sync warmWorkspace must build CSR index');
    assert.equal(hub.getStats(tmpWs).astCachedFilesCount, 12);

    const asyncRes = await ramAsync.warmWorkspaceAsync(tmpWs, { startWatcher: false });
    assert.equal(asyncRes.ok, true);
    assert.equal(asyncRes.parallelParsedCount, 0, `Expected 0 files re-parsed on 100% SQLite AST hit, got ${asyncRes.parallelParsedCount}`);
  } finally {
    ramSync.close();
    ramAsync.close();
    hub.close?.();
    fs.rmSync(tmpWs, { recursive: true, force: true });
    fs.rmSync(tmpDb, { recursive: true, force: true });
  }
});

test('6. Fix #8: CpuWorkerPool worker watchdog timeout terminates hung/slow batches and recovers cleanly', async () => {
  // Large varied log burst takes >100ms in JS, guaranteeing deterministic trigger at timeoutMs=25 without sleeping
  const heavyLogs = Array.from({ length: 12 }, (_, idx) => ({
    id: `heavy_${idx}`,
    text: Array.from({ length: 15000 }, (__, j) => `2026-11-20T03:00:${String(j % 60).padStart(2, '0')}Z INFO worker=${idx} seq=${j} status=${j % 7}`).join('\n'),
  }));

  await assert.rejects(
    () => runCpuBatch('compressLogsBatch', heavyLogs, { minItemsForWorkers: 1, maxWorkers: 2, timeoutMs: 25, skipTelemetry: true }),
    /timed out/i
  );

  const statsAfterTimeout = getCpuPoolStats();
  assert.ok(statsAfterTimeout.workerTimeouts >= 1, `Expected workerTimeouts >= 1, got ${JSON.stringify(statsAfterTimeout)}`);

  // Pool must recover cleanly and drain subsequent normal jobs
  const normalBatch = Array.from({ length: 6 }, (_, i) => ({
    relPath: `ok_${i}.mjs`,
    ext: '.mjs',
    text: `export function ok_${i}(n) { return n + ${i}; }\n`,
  }));
  const recovered = await runCpuBatch('parseMetadataBatch', normalBatch, {
    minItemsForWorkers: 1,
    maxWorkers: 2,
    timeoutMs: 15000,
    skipTelemetry: true,
  });
  assert.equal(recovered.length, 6);
  await shutdownCpuPool();
});

test('7. Fix #4: ddmin-runner CLI supports lowercase {file} and rejects missing placeholder or broken always-fail oracle', () => {
  const tmpDir = makeTempDir('amr-fix-ddmin-');
  const runnerPath = path.join(ROOT_DIR, 'skills', 'delta-bug-minimizer', 'scripts', 'ddmin-runner.mjs');
  try {
    const inputPath = path.join(tmpDir, 'input.txt');
    const oraclePath = path.join(tmpDir, 'oracle.mjs');
    const lines = Array.from({ length: 16 }, (_, i) => (i === 11 ? 'CRASH_TOKEN_X line 11' : `harmless line ${i}`));
    fs.writeFileSync(inputPath, lines.join('\n') + '\n', 'utf8');
    fs.writeFileSync(
      oraclePath,
      "import fs from 'node:fs'; const s = fs.readFileSync(process.argv[2], 'utf8'); process.exit(s.includes('CRASH_TOKEN_X') ? 1 : 0);\n",
      'utf8'
    );

    // 1) Lowercase {file} reduces precisely to line 11
    const stdout = execFileSync(
      process.execPath,
      [runnerPath, '--input', inputPath, '--cmd', `node "${oraclePath}" {file}`],
      { encoding: 'utf8', timeout: 10000, windowsHide: true }
    );
    const res = JSON.parse(stdout);
    assert.equal(res.ok, true);
    assert.deepEqual(res.minimized, ['CRASH_TOKEN_X line 11']);

    // 2) Missing placeholder must fail loudly
    assert.throws(
      () => execFileSync(process.execPath, [runnerPath, '--input', inputPath, '--cmd', `node "${oraclePath}"`], {
        encoding: 'utf8',
        stdio: 'pipe',
        windowsHide: true,
      }),
      (err) => /placeholder/i.test(`${err?.stderr || ''}\n${err?.stdout || ''}\n${err?.message || ''}`)
    );

    // 3) Oracle failing even on empty input must fail loudly instead of returning line 0
    const badOracle = path.join(tmpDir, 'always-fail.mjs');
    fs.writeFileSync(badOracle, 'process.exit(1);\n', 'utf8');
    assert.throws(
      () => execFileSync(process.execPath, [runnerPath, '--input', inputPath, '--cmd', `node "${badOracle}" {file}`], {
        encoding: 'utf8',
        stdio: 'pipe',
        windowsHide: true,
      }),
      (err) => /empty input/i.test(`${err?.stderr || ''}\n${err?.stdout || ''}\n${err?.message || ''}`)
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('8. Fixes #5 & #6: deep-stress-auditor eliminates false positives on RegExp.exec, Python dicts, Jinja2 scripts, JSONC, TS exports, and unbuilt dist/', async () => {
  const tmpDir = makeTempDir('amr-fix-auditor-');
  try {
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'py'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'templates'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.vscode'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'packages', 'sub', 'src'), { recursive: true });

    // Root package has a genuinely broken ./src/ entry (must STILL be flagged)
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'root-app', version: '1.0.0', type: 'module', exports: { '.': './src/real-missing.mjs' } }, null, 2),
      'utf8'
    );

    // Subpackage points to unbuilt ./dist/index.js while src/ & build script exist (must NOT be flagged)
    fs.writeFileSync(
      path.join(tmpDir, 'packages', 'sub', 'package.json'),
      JSON.stringify({ name: 'sub-pkg', version: '1.0.0', main: './dist/index.js', scripts: { build: 'tsc' } }, null, 2),
      'utf8'
    );
    fs.writeFileSync(path.join(tmpDir, 'packages', 'sub', 'src', 'index.ts'), 'export const subOk = true;\n', 'utf8');

    // RegExp.prototype.exec on req.headers must NOT trigger COMMAND_INJECTION
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'auth.ts'),
      [
        'const AUTH_RE = /^Basic\\s+([A-Za-z0-9+/=]+)$/;',
        'export function parseAuth(req: Request) {',
        "  return AUTH_RE.exec(req.headers.get('Authorization') || '');",
        '}',
      ].join('\n'),
      'utf8'
    );

    // TS type/interface/namespace/enum exports & NodeNext .js import must NOT trigger BROKEN_NAMED_EXPORT or BROKEN_RELATIVE_IMPORT
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'types.ts'),
      [
        'export type UserId = string;',
        'export interface ConfigBox { enabled: boolean; }',
        'export namespace Util { export const ver = 1; }',
        'export enum Mode { Fast = 1 }',
        'type InternalAlias = number;',
        'export type { InternalAlias };',
      ].join('\n'),
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'consumer.ts'),
      [
        "import { UserId, ConfigBox, Util, Mode, InternalAlias } from './types.js';",
        'export const cfg: ConfigBox = { enabled: true };',
        'export const idVal: UserId = `${Util.ver}:${Mode.Fast}`;',
        'export type MyAlias = InternalAlias;',
      ].join('\n'),
      'utf8'
    );

    // Python nested dictionary assignment must NOT trigger JS PROTOTYPE_POLLUTION_RISK
    fs.writeFileSync(
      path.join(tmpDir, 'py', 'store.py'),
      'def set_nested(cache, k1, k2, val):\n    cache[k1][k2] = val\n    return cache\n',
      'utf8'
    );

    // Jinja2 inline script must NOT trigger HTML_INLINE_SCRIPT_SYNTAX_ERROR
    fs.writeFileSync(
      path.join(tmpDir, 'templates', 'fetch.html'),
      '<html><body><script>fetch({{ url_for("add")|tojson }}).then(r => r.json());</script></body></html>\n',
      'utf8'
    );

    // .vscode JSONC with comments and trailing commas must NOT trigger INVALID_JSON
    fs.writeFileSync(
      path.join(tmpDir, '.vscode', 'launch.json'),
      '{\n  // VS Code launch config\n  "version": "0.2.0",\n  "configurations": [],\n}\n',
      'utf8'
    );

    const report = await runStressAudit(tmpDir, { fuzz: false, shutdownPool: true });
    const ruleSet = new Set(report.findings.map((f) => f.ruleId));

    assert.equal(ruleSet.has('COMMAND_INJECTION'), false, `Unexpected COMMAND_INJECTION: ${JSON.stringify(report.findings)}`);
    assert.equal(ruleSet.has('PROTOTYPE_POLLUTION_RISK'), false, `Unexpected PROTOTYPE_POLLUTION_RISK: ${JSON.stringify(report.findings)}`);
    assert.equal(ruleSet.has('HTML_INLINE_SCRIPT_SYNTAX_ERROR'), false, `Unexpected HTML_INLINE_SCRIPT_SYNTAX_ERROR: ${JSON.stringify(report.findings)}`);
    assert.equal(ruleSet.has('INVALID_JSON'), false, `Unexpected INVALID_JSON: ${JSON.stringify(report.findings)}`);
    assert.equal(ruleSet.has('BROKEN_NAMED_EXPORT'), false, `Unexpected BROKEN_NAMED_EXPORT: ${JSON.stringify(report.findings)}`);
    assert.equal(ruleSet.has('BROKEN_RELATIVE_IMPORT'), false, `Unexpected BROKEN_RELATIVE_IMPORT: ${JSON.stringify(report.findings)}`);

    const manifestFindings = report.findings.filter((f) => f.ruleId === 'BROKEN_MANIFEST_TARGET');
    assert.equal(manifestFindings.length, 1, `Expected only root missing ./src/ entry, got: ${JSON.stringify(manifestFindings)}`);
    assert.equal(manifestFindings[0].file, 'package.json');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

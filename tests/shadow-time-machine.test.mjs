import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createShadowCheckpoint,
  getTurnDiffSummary,
  listCheckpoints,
  listTurnCheckpoints,
  rollbackTurn,
} from '../core/shadow-guard.mjs';
import {
  createShadowWorktree,
  discardShadowWorktree,
  getShadowWorktreeDiff,
  listShadowWorktrees,
  promoteShadowWorktree,
  runInShadowWorktree,
} from '../core/shadow-worktree.mjs';

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('1. Turn-Level Time-Machine aggregates multi-file + newly created files and rolls back whole turn cleanly', () => {
  const tmpWs = makeTempDir('amr-tm-ws-');
  const fileA = path.join(tmpWs, 'alpha.mjs');
  const fileB = path.join(tmpWs, 'beta.mjs');
  const fileC = path.join(tmpWs, 'gamma-new.mjs');
  const turnId = `turn_test_${Date.now()}`;

  try {
    fs.writeFileSync(fileA, 'export const a = 1;\nexport const a2 = 2;\n', 'utf8');
    fs.writeFileSync(fileB, 'export const b = 10;\n', 'utf8');

    // Step 1 in turn: edit fileA first time
    const cpA1 = createShadowCheckpoint({
      filePath: fileA,
      workspaceRoot: tmpWs,
      toolName: 'edit_file',
      turnId,
      turnLabel: 'Обновить alpha/beta и создать gamma',
    });
    assert.ok(cpA1 && cpA1.id);
    fs.writeFileSync(fileA, 'export const a = 100;\nexport const a2 = 2;\n', 'utf8');

    // Step 2 in SAME turn: edit fileA second time -> must keep pre-turn baseline a = 1
    const cpA2 = createShadowCheckpoint({
      filePath: fileA,
      workspaceRoot: tmpWs,
      toolName: 'edit_file',
      turnId,
      turnLabel: 'Обновить alpha/beta и создать gamma',
    });
    assert.ok(cpA2 && cpA2.id);
    assert.notEqual(cpA2.id, cpA1.id);
    fs.writeFileSync(fileA, 'export const a = 999;\nexport const a2 = 2;\nexport const extra = 3;\n', 'utf8');

    // Step 3 in SAME turn: edit fileB
    createShadowCheckpoint({
      filePath: fileB,
      workspaceRoot: tmpWs,
      toolName: 'edit_file',
      turnId,
      turnLabel: 'Обновить alpha/beta и создать gamma',
    });
    fs.writeFileSync(fileB, 'export const b = 20;\n', 'utf8');

    // Step 4 in SAME turn: create brand-new fileC (did not exist before turn)
    const cpC = createShadowCheckpoint({
      filePath: fileC,
      workspaceRoot: tmpWs,
      toolName: 'write_file',
      turnId,
      turnLabel: 'Обновить alpha/beta и создать gamma',
    });
    assert.equal(cpC.existed, false);
    fs.writeFileSync(fileC, 'export const gamma = true;\n', 'utf8');

    // Verify Turn grouping and diff summary
    const turns = listTurnCheckpoints(10, tmpWs);
    const myTurn = turns.find((t) => t.turnId === turnId);
    assert.ok(myTurn, 'Turn entry must appear in listTurnCheckpoints');
    assert.equal(myTurn.filesCount, 3);
    assert.equal(myTurn.allRestored, false);

    const diffSummary = getTurnDiffSummary(turnId, tmpWs);
    assert.equal(diffSummary.ok, true);
    assert.equal(diffSummary.files.length, 3);
    const gammaDiff = diffSummary.files.find((f) => f.fileName === 'gamma-new.mjs');
    assert.equal(gammaDiff?.status, 'created');
    assert.ok(diffSummary.totalAdded >= 3);

    // Roll back entire turn atomically
    const rb = rollbackTurn(turnId, tmpWs);
    assert.equal(rb.ok, true);
    assert.equal(rb.count, 3);
    assert.equal(fs.readFileSync(fileA, 'utf8'), 'export const a = 1;\nexport const a2 = 2;\n');
    assert.equal(fs.readFileSync(fileB, 'utf8'), 'export const b = 10;\n');
    assert.equal(fs.existsSync(fileC), false, 'Newly created file in turn must be deleted on turn rollback');

    const perFileList = listCheckpoints(10, tmpWs);
    assert.ok(perFileList.every((c) => c.restored === true));

    // Null / fuzz safety checks
    assert.equal(createShadowCheckpoint(null), null);
    assert.equal(rollbackTurn(null, null).ok, false);
    assert.equal(rollbackTurn('__proto__', tmpWs).ok, false);
    assert.equal(getTurnDiffSummary(null, null).ok, false);
    assert.ok(Array.isArray(listTurnCheckpoints(null, null)));
  } finally {
    try { fs.rmSync(tmpWs, { recursive: true, force: true, maxRetries: 10, retryDelay: 60 }); } catch {}
  }
});

test('2. Shadow Git Worktree creates isolated sandbox, runs tests, promotes verified diff & discards cleanly', () => {
  const tmpRepo = makeTempDir('amr-wt-repo-');
  const tmpCache = makeTempDir('amr-wt-cache-');

  try {
    execFileSync('git', ['init'], { cwd: tmpRepo, windowsHide: true });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmpRepo, windowsHide: true });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: tmpRepo, windowsHide: true });

    const calcFile = path.join(tmpRepo, 'calc.mjs');
    fs.writeFileSync(calcFile, 'export function sum(a, b) { return a + b; }\n', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: tmpRepo, windowsHide: true });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: tmpRepo, windowsHide: true });

    // Create sandbox #1
    const wt1 = createShadowWorktree({ workspaceRoot: tmpRepo, cacheDir: tmpCache, label: 'Тест фикс' });
    assert.equal(wt1.ok, true);
    assert.ok(fs.existsSync(wt1.worktreePath));

    // Modify existing file & create new helper inside sandbox ONLY
    const wtCalc = path.join(wt1.worktreePath, 'calc.mjs');
    const wtExtra = path.join(wt1.worktreePath, 'helper.mjs');
    fs.writeFileSync(wtCalc, 'export function sum(a, b) { return Number(a) + Number(b); }\n', 'utf8');
    fs.writeFileSync(wtExtra, 'export const version = 2;\n', 'utf8');

    // Main repo MUST remain untouched before promote
    assert.equal(fs.readFileSync(calcFile, 'utf8'), 'export function sum(a, b) { return a + b; }\n');
    assert.equal(fs.existsSync(path.join(tmpRepo, 'helper.mjs')), false);

    // Run command in sandbox
    const runRes = runInShadowWorktree({
      id: wt1.id,
      workspaceRoot: tmpRepo,
      cacheDir: tmpCache,
      command: 'node',
      args: ['--input-type=module', '-e', `import { sum } from "./${'calc'}.mjs"; if (sum("2", 3) !== 5) process.exit(1);`],
    });
    assert.equal(runRes.ok, true);
    assert.equal(runRes.exitCode, 0);

    // Inspect worktree diff
    const diffRes = getShadowWorktreeDiff({ id: wt1.id, workspaceRoot: tmpRepo, cacheDir: tmpCache });
    assert.equal(diffRes.ok, true);
    assert.ok(diffRes.changedFiles.some((f) => f.path === 'calc.mjs' && f.status === 'modified'));
    assert.ok(diffRes.changedFiles.some((f) => f.path === 'helper.mjs' && f.status === 'created'));

    // Promote verified diff to main repo + auto-cleanup
    const prom = promoteShadowWorktree({ id: wt1.id, workspaceRoot: tmpRepo, cacheDir: tmpCache });
    assert.equal(prom.ok, true);
    assert.equal(prom.count, 2);
    assert.equal(fs.readFileSync(calcFile, 'utf8'), 'export function sum(a, b) { return Number(a) + Number(b); }\n');
    assert.equal(fs.existsSync(path.join(tmpRepo, 'helper.mjs')), true);
    assert.equal(listShadowWorktrees(tmpRepo, { cacheDir: tmpCache }).length, 0);

    // Create sandbox #2 and discard without touching main repo
    const wt2 = createShadowWorktree({ workspaceRoot: tmpRepo, cacheDir: tmpCache, label: 'Отменяемый эксперимент' });
    assert.equal(wt2.ok, true);
    fs.writeFileSync(path.join(wt2.worktreePath, 'calc.mjs'), 'BROKEN', 'utf8');
    const disc = discardShadowWorktree({ id: wt2.id, workspaceRoot: tmpRepo, cacheDir: tmpCache });
    assert.equal(disc.ok, true);
    assert.equal(fs.readFileSync(calcFile, 'utf8'), 'export function sum(a, b) { return Number(a) + Number(b); }\n');

    // Fuzz safety on null/malicious inputs
    assert.equal(createShadowWorktree(null).ok, false);
    assert.equal(promoteShadowWorktree('__proto__').ok, false);
    assert.equal(runInShadowWorktree({ id: wt1.id, cacheDir: tmpCache, command: 'rm -rf /' }).ok, false);
  } finally {
    try { fs.rmSync(tmpRepo, { recursive: true, force: true, maxRetries: 10, retryDelay: 60 }); } catch {}
    try { fs.rmSync(tmpCache, { recursive: true, force: true, maxRetries: 10, retryDelay: 60 }); } catch {}
  }
});

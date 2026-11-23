import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  analyzeUiScreenshotLocally,
  generateLocalCommitSummary,
  structureVoiceTranscriptLocally,
} from '../core/local-gpu-engine.mjs';
import { BackgroundSentinel } from '../core/background-sentinel.mjs';
import { generateBoundaryMutants, runSemanticMutationGuard } from '../core/cpu-mutation-guard.mjs';
import { buildComposerAtSuggestions } from '../sidecars/panel/server.mjs';
import { executeMcpTool } from '../core/ram-memory-mcp.mjs';

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('1. Local Vision screenshot analysis, Commit Summary fallback & Voice structuring', async () => {
  // Valid 1x1 PNG base64 sample
  const tinyPngB64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  let capturedImages = [];
  const visRes = await analyzeUiScreenshotLocally({
    imageBase64: tinyPngB64,
    userHint: 'Проверь контраст кнопок',
    cfgOverride: { gpuEnabled: true, gpuChatModel: 'gemma4:12b' },
    httpJsonFn: async (_method, _ep, body) => {
      capturedImages = body?.messages?.[1]?.images || [];
      return {
        ok: true,
        data: {
          message: {
            content: JSON.stringify({
              analysisRu: 'Кнопка имеет низкий контраст на светлом фоне',
              defectsRu: ['Увеличить контраст границы кнопки до 4.5:1'],
              promptPatchRu: 'Подними контраст кнопки в styles.css до #1d4ed8',
            }),
          },
        },
      };
    },
  });
  assert.equal(visRes.ok, true);
  assert.equal(capturedImages.length, 1);
  assert.equal(capturedImages[0].startsWith('data:'), false, 'Base64 prefix must be stripped for Ollama');
  assert.match(visRes.promptPatchRu, /styles\.css/);

  // >4 MB screenshot limit guard
  const hugeB64 = Buffer.alloc(4 * 1024 * 1024 + 50, 'A').toString('base64');
  const overCap = await analyzeUiScreenshotLocally({ imageBase64: hugeB64 });
  assert.equal(overCap.ok, false);
  assert.match(overCap.error, /4 МБ/);

  // Offline deterministic Commit Summary fallback when GPU disabled
  const commitOffline = await generateLocalCommitSummary({
    diffText: '+export function fixAuthGuard() {}\n',
    changedFiles: ['core/auth-guard.mjs'],
    issuesCount: 0,
    cfgOverride: { gpuEnabled: false },
  });
  assert.equal(commitOffline.ok, true);
  assert.equal(commitOffline.viaGpu, false);
  assert.match(commitOffline.commitMessage, /^fix\(auth-guard\):/);

  // Voice dictation cleanup offline
  const voiceOffline = await structureVoiceTranscriptLocally({
    rawTranscript: 'ээ ну типа короче проверь авторизацию в server.mjs , и почини кэш',
    cfgOverride: { gpuEnabled: false },
  });
  assert.equal(voiceOffline.ok, true);
  assert.equal(voiceOffline.viaGpu, false);
  assert.doesNotMatch(voiceOffline.structuredPrompt, /\b(?:короче|типа|ээ)\b/i);
  assert.match(voiceOffline.structuredPrompt, /server\.mjs/);

  // Null fuzz safety
  assert.equal((await analyzeUiScreenshotLocally(null)).ok, false);
  assert.equal((await generateLocalCommitSummary(null)).ok, false);
  assert.equal((await structureVoiceTranscriptLocally(null)).ok, false);
});

test('2. Sentinel prepare_commit detects leaked secrets & builds zero-cloud commit package when clean', async () => {
  const tmpRepo = makeTempDir('amr-precommit-');
  const tmpCache = makeTempDir('amr-precommit-cache-');

  try {
    execFileSync('git', ['init'], { cwd: tmpRepo, windowsHide: true });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmpRepo, windowsHide: true });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmpRepo, windowsHide: true });

    const appFile = path.join(tmpRepo, 'app.mjs');
    fs.writeFileSync(appFile, 'export function greet(name) { return "Hi " + name; }\n', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: tmpRepo, windowsHide: true });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: tmpRepo, windowsHide: true });

    const sentinel = new BackgroundSentinel({
      cacheDir: tmpCache,
      stateOverride: { sentinelEnabled: true, sentinelShadowGuard: true, sentinelLocalBugBot: false, gpuEnabled: false },
    });

    // Clean diff -> readyToCommit: true
    fs.writeFileSync(appFile, 'export function greet(name) {\n  return `Hello, ${name || "world"}`;\n}\n', 'utf8');
    const cleanRes = await sentinel.runAction({ action: 'prepare_commit', wsPath: tmpRepo, cfgOverride: { gpuEnabled: false, sentinelLocalBugBot: false } });
    assert.equal(cleanRes.preCommit.ok, true);
    assert.equal(cleanRes.preCommit.readyToCommit, true);
    assert.ok(cleanRes.preCommit.changedFiles.includes('app.mjs'));
    assert.match(cleanRes.preCommit.commitMessage, /app\.mjs/);

    // Plant accidental token in diff -> readyToCommit: false with secret blocker
    const fakeGhToken = ['ghp', 'LeakedSecretToken1234567890abcdef'].join('_');
    fs.writeFileSync(appFile, `const API_KEY = "${fakeGhToken}";\nexport function greet() { return API_KEY; }\n`, 'utf8');
    const leakRes = await sentinel.runAction({ action: 'prepare_commit', wsPath: tmpRepo, cfgOverride: { gpuEnabled: false, sentinelLocalBugBot: false } });
    assert.equal(leakRes.preCommit.readyToCommit, false);
    assert.ok(leakRes.preCommit.blockers.some((b) => /секретный ключ/i.test(b)));
  } finally {
    try { fs.rmSync(tmpRepo, { recursive: true, force: true, maxRetries: 10, retryDelay: 60 }); } catch {}
    try { fs.rmSync(tmpCache, { recursive: true, force: true, maxRetries: 10, retryDelay: 60 }); } catch {}
  }
});

test('3. CPU Semantic Mutation Guard isolates temp sandbox without touching source file & mutation_guard_check MCP', async () => {
  const tmpWs = makeTempDir('amr-mutguard-');

  try {
    const srcFile = path.join(tmpWs, 'quotaCheck.mjs');
    const testFile = path.join(tmpWs, 'quotaCheck.test.mjs');
    const origCode = [
      'export function isAdult(age) {',
      '  if (age >= 18) return true;',
      '  return false;',
      '}',
      'export function unusedBonus(x) {',
      '  if (x === 999) return 42;',
      '  return 0;',
      '}',
    ].join('\n');
    fs.writeFileSync(srcFile, origCode, 'utf8');
    fs.writeFileSync(
      testFile,
      [
        'import test from "node:test";',
        'import assert from "node:assert/strict";',
        `import { isAdult } from "./${'quotaCheck'}.mjs";`,
        'test("age boundary 18", () => {',
        '  assert.equal(isAdult(18), true);',
        '  assert.equal(isAdult(17), false);',
        '});',
      ].join('\n'),
      'utf8'
    );

    const mutants = generateBoundaryMutants(origCode, 4);
    assert.equal(mutants.length, 2);

    const mutRes = runSemanticMutationGuard({
      workspaceRoot: tmpWs,
      filePath: srcFile,
      testFilePath: testFile,
      maxMutants: 4,
    });
    assert.equal(mutRes.ok, true, mutRes.error || 'mutation guard failed');
    assert.equal(mutRes.totalMutants, 2);
    assert.equal(mutRes.killed, 1, 'age >= 18 -> > 18 mutant must be killed');
    assert.equal(mutRes.survived, 1, 'untested unusedBonus === 999 mutant must survive');
    assert.equal(fs.readFileSync(srcFile, 'utf8'), origCode, 'Original file MUST remain untouched');

    // Execute via MCP tool dispatch
    const mcpRes = await executeMcpTool('mutation_guard_check', {
      workspaceRoot: tmpWs,
      filePath: 'quotaCheck.mjs',
      testFilePath: 'quotaCheck.test.mjs',
      maxMutants: 2,
    });
    assert.equal(mcpRes.isError, false);
    const parsedMcp = JSON.parse(mcpRes.text);
    assert.equal(parsedMcp.ok, true);

    // Null fuzz safety
    assert.deepEqual(generateBoundaryMutants(null, null), []);
    assert.equal(runSemanticMutationGuard(null).ok, false);
  } finally {
    try { fs.rmSync(tmpWs, { recursive: true, force: true, maxRetries: 10, retryDelay: 60 }); } catch {}
  }
});

test('4. Smart Composer @-chip autocomplete builds grounded @file/@symbol/@git/@error/@repo items', () => {
  const all = buildComposerAtSuggestions({
    query: '@',
    files: ['core/lsp-bridge.mjs', 'sidecars/panel/ui.html'],
    symbols: [{ name: 'calculateTax', file: 'core/billing.mjs', line: 12 }],
    wiretapFaults: [{ file: 'app.mjs', summary: 'TypeError in auth' }],
    federatedPeers: [{ label: 'backend-api', path: '/tmp/backend-api' }],
  });
  assert.equal(all.ok, true);
  assert.ok(all.items.some((i) => i.token === '@git:diff'));
  assert.ok(all.items.some((i) => i.token === '@error:last'));
  assert.ok(all.items.some((i) => i.token === '@repo:backend-api'));
  assert.ok(all.items.some((i) => i.token === '@file:core/lsp-bridge.mjs'));
  assert.ok(all.items.some((i) => i.token === '@symbol:calculateTax'));

  const filtered = buildComposerAtSuggestions({
    query: '@lsp',
    files: ['core/lsp-bridge.mjs', 'sidecars/panel/ui.html'],
  });
  assert.equal(filtered.items.length, 1);
  assert.equal(filtered.items[0].token, '@file:core/lsp-bridge.mjs');
  assert.equal(buildComposerAtSuggestions(null).ok, true);
});

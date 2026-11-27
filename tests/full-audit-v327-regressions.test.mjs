import { ROOT_DIR, SUITE_CACHE_DIR, registerSuiteLifecycle } from './helpers/router-test-env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

registerSuiteLifecycle(test);

import { normalizeModelProfile, resolveEffectivePreTaskGatePolicy } from '../core/model-profile.mjs';
import { handlePreInvocation, handlePreToolUse } from '../core/hook-runner.mjs';
import { classifyTaskAndPruneTools } from '../core/tool-pruner.mjs';
import {
  isAssistantAnswerContinuation,
  runLocalProjectChat,
  sanitizeGhostContinuation,
} from '../core/local-gpu-engine.mjs';
import { attachSidecarSecurityMiddleware, buildComposerAtSuggestions } from '../sidecars/panel/server.mjs';
import { checkCommandSecurity } from '../core/security-guard.mjs';
import { ingestRuntimeFault } from '../core/runtime-wiretap.mjs';
import { createShadowWorktree } from '../core/shadow-worktree.mjs';
import { ensureFloatingHudRunning } from '../core/floating-hud.mjs';
import { runSemanticMutationGuard } from '../core/cpu-mutation-guard.mjs';
import { generateRepoMap } from '../core/repo-mapper.mjs';
import { RamMemoryEngine } from '../core/ram-memory-engine.mjs';
import { collectAndDetectStack } from '../skills/deep-stress-auditor/scripts/lib/stack-detector.mjs';
import { runStressAudit } from '../skills/deep-stress-auditor/scripts/run-stress-audit.mjs';

const TURN_CACHE_FILE = path.join(SUITE_CACHE_DIR, 'turn-context.json');
const SWARM_ROLES_FILE = path.join(ROOT_DIR, '.cache', 'swarm-roles.json');

function cleanupConvoCache(prefix) {
  for (const cacheFile of [TURN_CACHE_FILE, SWARM_ROLES_FILE]) {
    try {
      if (!fs.existsSync(cacheFile)) continue;
      const parsed = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      const bucketKey = parsed?.turns ? 'turns' : parsed?.roles ? 'roles' : '';
      if (!bucketKey) continue;
      for (const k of Object.keys(parsed[bucketKey])) {
        if (k.includes(prefix)) delete parsed[bucketKey][k];
      }
      fs.writeFileSync(cacheFile, JSON.stringify(parsed, null, 2), 'utf8');
    } catch {}
  }
}

test('1. Pre-Task Gates: confirmThreshold=ALL overrides synergy, 2nd edit stays denied, Orchestrator exit_plan_mode gated', async () => {
  const orchProfile = normalizeModelProfile('Orchestrator (Neon)');
  const gateAll = resolveEffectivePreTaskGatePolicy({
    modelProfile: orchProfile,
    grade: 'S',
    state: { confirmBeforeRun: true, confirmThreshold: 'ALL', orchestratorSmartSynergy: true },
  });
  assert.equal(gateAll.effectiveThreshold, 'ALL');
  assert.equal(gateAll.shouldAskModelGate, true);
  assert.equal(gateAll.orchestratorBypassSM, false);

  const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-reg-gate-'));
  const tag = `reg-gate-${Date.now()}`;
  try {
    const targetFile = path.join(tmpWs, 'demo.mjs');
    fs.writeFileSync(targetFile, 'export const a = 1;\n', 'utf8');

    const cAll = `${tag}-all`;
    await handlePreInvocation(
      {
        hookEventName: 'PreInvocation',
        conversationId: cAll,
        workspacePaths: [tmpWs],
        lastUserInput: 'Отредактируй файл demo.mjs',
        modelName: 'Orchestrator (Neon)',
      },
      { confirmBeforeRun: true, confirmThreshold: 'ALL', orchestratorSmartSynergy: true, ramCacheEnabled: false }
    );

    const deny1 = await handlePreToolUse(
      {
        conversationId: cAll,
        workspacePaths: [tmpWs],
        toolName: 'edit_file',
        args: { Path: targetFile, Target: 'a = 1', Replacement: 'a = 2' },
      },
      { confirmBeforeRun: true, confirmThreshold: 'ALL', orchestratorSmartSynergy: true }
    );
    const deny2 = await handlePreToolUse(
      {
        conversationId: cAll,
        workspacePaths: [tmpWs],
        toolName: 'edit_file',
        args: { Path: targetFile, Target: 'a = 1', Replacement: 'a = 2' },
      },
      { confirmBeforeRun: true, confirmThreshold: 'ALL', orchestratorSmartSynergy: true }
    );
    assert.equal(deny1.decision, 'deny');
    assert.equal(deny2.decision, 'deny');

    await handlePreToolUse(
      {
        conversationId: cAll,
        workspacePaths: [tmpWs],
        toolName: 'ask_question',
        args: { questions: [{ question: 'Подтвердить?', options: ['Да'] }] },
      },
      { confirmBeforeRun: true, confirmThreshold: 'ALL', orchestratorSmartSynergy: true }
    );
    const allowAfter = await handlePreToolUse(
      {
        conversationId: cAll,
        workspacePaths: [tmpWs],
        toolName: 'edit_file',
        args: { Path: targetFile, Target: 'a = 1', Replacement: 'a = 2' },
      },
      { confirmBeforeRun: true, confirmThreshold: 'ALL', orchestratorSmartSynergy: true }
    );
    assert.equal(allowAfter.decision, 'allow');

    // Orchestrator [plan review due] allows exit_plan_mode without extra gate
    const cReview = `${tag}-review`;
    await handlePreInvocation(
      {
        hookEventName: 'PreInvocation',
        conversationId: cReview,
        workspacePaths: [tmpWs],
        lastUserInput: '[plan review due] Продолжай этап 2',
        modelName: 'Orchestrator (Neon)',
      },
      { confirmBeforeRun: true, confirmThreshold: 'ALL', orchestratorSmartSynergy: false, ramCacheEnabled: false }
    );
    const allowReviewExit = await handlePreToolUse(
      {
        conversationId: cReview,
        workspacePaths: [tmpWs],
        toolName: 'exit_plan_mode',
        args: { plan: 'Stage 2' },
      },
      { confirmBeforeRun: true, confirmThreshold: 'ALL', orchestratorSmartSynergy: false }
    );
    assert.equal(allowReviewExit.decision, 'allow');
  } finally {
    fs.rmSync(tmpWs, { recursive: true, force: true, maxRetries: 6, retryDelay: 50 });
    cleanupConvoCache(tag);
  }
});

test('2. GPU-off lexical fallback triggers UI/UX Design Preview Gate and matchedSkills', () => {
  const uiTask = classifyTaskAndPruneTools(
    'Перекрась карточки и обнови дизайн интерфейса в sidecars/panel/ui.html',
    { confirmBeforeRun: true, uiDesignPreviewGate: true, uiInspirationMode: 'ask' },
    { skillIndexWarm: false, semanticSkills: [] }
  );
  assert.equal(uiTask.needsDesignPreviewGate, true);
  assert.ok(Array.isArray(uiTask.matchedSkills));
  assert.equal(uiTask.matchedSkills.includes('ui-ux-design-system'), true);
  assert.equal(uiTask.semanticSkills.some((s) => s.slug === 'ui-ux-design-system'), true);

  const roQuestion = classifyTaskAndPruneTools(
    'Как устроен дизайн карточек и CSS палитра в ui.html?',
    { confirmBeforeRun: true, uiDesignPreviewGate: true },
    { skillIndexWarm: false, semanticSkills: [] }
  );
  assert.equal(roQuestion.needsDesignPreviewGate, false);
});

test('3. Ghost Text rejects leaked English meta-commentary on Russian drafts', () => {
  assert.equal(
    isAssistantAnswerContinuation('Напиши тесты для модуля ', 'Okay, the user is asking for unit tests...'),
    true
  );
  assert.equal(
    sanitizeGhostContinuation('Добавь обработку ошибок для ', 'Okay, the user wants error handling in server'),
    ''
  );
  assert.equal(
    sanitizeGhostContinuation('Исправь гонку условий в ', 'Alright, let me inspect the concurrency bug carefully'),
    ''
  );
  const cleanRu = sanitizeGhostContinuation('Добавь валидацию схемы для ', 'входящих JSON-запросов маршрутизатора.');
  assert.match(cleanRu, /входящих JSON-запросов/);
});

test('4. Local RAG Chat suppresses fallback source pills on explicit no-context refusal', async () => {
  const res = await runLocalProjectChat({
    query: 'Где в проекте хранится секретный ключ несуществующего сервиса?',
    ragContext: '// [file] core/router-cli.mjs\nexport const GUARDRAIL_KEYS = [];',
    ragSources: ['core/router-cli.mjs'],
    cfgOverride: { gpuEnabled: true, gpuChatModel: 'gemma4:12b', gpuMaxVramMb: 14336 },
    hwProbeFn: () => ({ supported: true, freeVramMb: 12000, totalVramMb: 16384 }),
    httpJsonFn: async (_method, apiPath) => {
      if (apiPath === '/api/ps') return { ok: true, data: { models: [] } };
      if (apiPath === '/api/tags') return { ok: true, data: { models: [{ name: 'gemma4:12b', size: 8e9 }] } };
      if (apiPath === '/api/chat') {
        return {
          ok: true,
          data: { message: { content: 'В предоставленных срезах кода этого нет.' } },
        };
      }
      return { ok: false, error: 'unexpected route' };
    },
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.sources, []);
});

test('5 & 6. Composer @symbol: beyond first 80 symbols + HTTP 400 on malformed JSON', async () => {
  const manySymbols = Array.from({ length: 105 }, (_, idx) => ({
    name: `helperSymbol_${idx}`,
    file: `src/mod_${idx}.mjs`,
    line: idx + 1,
  }));
  const atRes = buildComposerAtSuggestions({
    query: '@symbol:helperSymbol_99',
    files: ['src/mod_99.mjs'],
    symbols: manySymbols,
    limit: 5,
  });
  assert.equal(atRes.ok, true);
  assert.equal(atRes.items.some((it) => it.token === '@symbol:helperSymbol_99'), true);

  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  attachSidecarSecurityMiddleware(srv, { maxBodyBytes: 4096 });

  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  try {
    const port = srv.address().port;
    const badRes = await fetch(`http://127.0.0.1:${port}/api/update`, {
      method: 'POST',
      headers: {
        Origin: 'vscode-webview://host',
        'x-router-panel': 'antigravity-v38',
        'Content-Type': 'application/json',
      },
      body: '{invalid_json',
    });
    assert.equal(badRes.status, 400);
    const badJson = await badRes.json();
    assert.equal(badJson.ok, false);
    assert.equal(badJson.error, 'Invalid JSON payload');
  } finally {
    await new Promise((resolve) => srv.close(resolve));
  }
});

test('7. Security Guard decodes and blocks dangerous PowerShell -EncodedCommand payloads', () => {
  const dangerous = 'Remove-Item -Recurse -Force C:\\Windows';
  const b64Utf16 = Buffer.from(dangerous, 'utf16le').toString('base64');

  for (const cmd of [
    `powershell -NoProfile -EncodedCommand ${b64Utf16}`,
    `pwsh -enc ${b64Utf16}`,
    `powershell.exe -e ${b64Utf16}`,
    'powershell -EncodedCommand !!!not_base64!!!',
  ]) {
    const check = checkCommandSecurity(cmd, ROOT_DIR);
    assert.equal(check.allowed, false, `Command should be blocked: ${cmd}`);
  }
});

test('8. Feature toggles wired & runSemanticMutationGuard passes baseline on core/security-guard.mjs', () => {
  assert.equal(
    ingestRuntimeFault({ workspaceRoot: ROOT_DIR, rawError: 'Error: boom', state: { runtimeWiretapEnabled: false } }).disabled,
    true
  );
  assert.equal(
    createShadowWorktree({ workspaceRoot: ROOT_DIR, state: { shadowWorktreeEnabled: false } }).disabled,
    true
  );
  const hudDisabled = ensureFloatingHudRunning({ state: { floatingHudEnabled: false } });
  assert.equal(hudDisabled.disabledByState, true);
  assert.equal(hudDisabled.running, false);

  const mutRes = runSemanticMutationGuard({
    workspaceRoot: ROOT_DIR,
    filePath: 'core/security-guard.mjs',
    testFilePath: 'tests/router-core.test.mjs',
    maxMutants: 1,
    timeoutMs: 25000,
  });
  assert.equal(mutRes.ok, true, `Mutation guard should pass baseline: ${mutRes.error || ''}`);
  assert.ok(mutRes.totalMutants >= 1);
});

test('9. Mega-repo scaling: Round-Robin RepoMap, packed RamMemoryEngine + HMR lexicon, Deep Stress Auditor', async () => {
  const tmpPoly = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-reg-poly-'));
  const engine = new RamMemoryEngine({ budgetMb: 128 });
  try {
    // Polyglot monorepo: flood alpha_py/docs_src first alphabetically + mix app/, beta_go/, gamma_ts/
    fs.mkdirSync(path.join(tmpPoly, 'alpha_py', 'docs_src'), { recursive: true });
    fs.mkdirSync(path.join(tmpPoly, 'alpha_py', 'app'), { recursive: true });
    fs.mkdirSync(path.join(tmpPoly, 'beta_go'), { recursive: true });
    fs.mkdirSync(path.join(tmpPoly, 'gamma_ts'), { recursive: true });
    fs.mkdirSync(path.join(tmpPoly, 'svelte_app'), { recursive: true });

    for (let i = 0; i < 30; i++) {
      fs.writeFileSync(path.join(tmpPoly, 'alpha_py', 'docs_src', `tut_${String(i).padStart(2, '0')}.py`), `def doc_fn_${i}():\n    return ${i}\n`);
    }
    for (let i = 0; i < 6; i++) {
      fs.writeFileSync(path.join(tmpPoly, 'alpha_py', 'app', `core_${i}.py`), `def handle_req_${i}(ctx):\n    return ctx\n`);
      fs.writeFileSync(path.join(tmpPoly, 'beta_go', `router_${i}.go`), `package beta\nfunc Route${i}() int { return ${i} }\n`);
    }
    fs.writeFileSync(
      path.join(tmpPoly, 'gamma_ts', 'hmr_engine.ts'),
      'export function applyHmrUpdate(modId: string) { return `hot reload ${modId}`; }\n'
    );
    fs.writeFileSync(path.join(tmpPoly, 'svelte_app', 'App.svelte'), '<script>export let name = "ui";</script>\n<h1>{name}</h1>\n');
    fs.writeFileSync(path.join(tmpPoly, 'svelte_app', 'main.ts'), "import App from './App.svelte';\nexport default App;\n");

    const map = generateRepoMap(tmpPoly, { maxFiles: 20 });
    const mappedPaths = map.filesIndex.map((f) => f.file);
    assert.ok(mappedPaths.some((p) => p.endsWith('.py')), 'RepoMap must include Python files');
    assert.ok(mappedPaths.some((p) => p.endsWith('.go')), 'RepoMap must sample Go files');
    assert.ok(mappedPaths.some((p) => p.endsWith('.ts')), 'RepoMap must sample TS files');
    assert.ok(
      mappedPaths.some((p) => p.startsWith('alpha_py/app/')),
      'RepoMap must prioritize core app/ files over docs_src/'
    );

    const warm = await engine.warmWorkspaceAsync(tmpPoly, { startWatcher: false });
    assert.equal(warm.ok, true);
    const hmrSearch = engine.search(tmpPoly, 'горячая перезагрузка модулей', 5);
    assert.equal(hmrSearch.ok, true);
    assert.ok(
      hmrSearch.results.some((r) => r.file.endsWith('hmr_engine.ts')),
      'RU query "горячая перезагрузка модулей" should match hmr_engine.ts via RU-EN lexicon'
    );

    // Trigram purge check via removeEntry (packed fieldPostings + recomputed trigrams)
    const ws = engine.getOrCreateWorkspace(tmpPoly);
    assert.equal(ws.files.get('gamma_ts/hmr_engine.ts')?.trigrams, undefined);
    assert.ok((ws.files.get('gamma_ts/hmr_engine.ts')?.trigramCount || 0) > 0);
    engine.removeEntry(ws, 'gamma_ts/hmr_engine.ts');
    for (const bucket of ws.trigramIndex.values()) {
      assert.equal(bucket.has('gamma_ts/hmr_engine.ts'), false, 'Deleted file must leave zero stale trigram entries');
    }

    const capped = collectAndDetectStack(tmpPoly, { maxFiles: 4 });
    assert.equal(capped.truncated, true);
    assert.equal(capped.maxFiles, 4);

    const auditRes = await runStressAudit(path.join(tmpPoly, 'svelte_app'), {
      fuzz: false,
      deep: false,
      shutdownPool: true,
    });
    assert.equal(
      auditRes.findings.some((f) => f.ruleId === 'MISSING_DEFAULT_EXPORT'),
      false,
      'Svelte SFC default import must not trigger MISSING_DEFAULT_EXPORT'
    );
  } finally {
    engine.close();
    fs.rmSync(tmpPoly, { recursive: true, force: true, maxRetries: 6, retryDelay: 50 });
  }
});

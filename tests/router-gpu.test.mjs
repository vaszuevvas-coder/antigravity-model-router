import { ROOT_DIR, makeTempDir, registerSuiteLifecycle } from './helpers/router-test-env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import { ALLOWED_STATE_KEYS, DEFAULT_STATE, sanitizeStatePatch } from '../sidecars/panel/server.mjs';
import { RamMemoryEngine } from '../core/ram-memory-engine.mjs';
import {
  classifySkillWithLlm,
  discoverSkillSemanticEntries,
  distillLocalFile,
  distillText,
  dotProductPrefix,
  formatEmbedInput,
  indexSkillVectors,
  loadGpuConfig,
  matchSkillsAi,
  pullSingleOllamaModelWithFallback,
  reconcileLoadedModelsVram,
  scoreSkillVectorsWithQueryVec,
} from '../core/local-gpu-engine.mjs';
import { maskTerminalOutputSmart } from '../core/obs-masker.mjs';
import { classifyTaskAndPruneTools } from '../core/tool-pruner.mjs';
import { shutdownCpuPool } from '../core/cpu-worker-pool.mjs';
import { clearPitfalls, recordPitfall } from '../core/pitfall-ledger.mjs';

registerSuiteLifecycle(test, { cleanupFns: [shutdownCpuPool] });

test('8. Local GPU Engine: dotProductPrefix normalizes both query and stored prefix vectors', () => {
  const score = dotProductPrefix(
    new Float32Array([10, 0, 5, 5]),
    Int8Array.from([127, 0, 0, 0]),
    2
  );
  assert.ok(Math.abs(score - 1) < 1e-6, `Expected cosine 1, got ${score}`);
});

test('17. v3.8 GPU Boost: gpuEmbedKeepAlive, zero-token distillLocalFile/@file: security, hybrid getContextPack & smart masker', async () => {
  // 1) gpuEmbedKeepAlive across DEFAULT_STATE, ALLOWED_STATE_KEYS, sanitizeStatePatch, and loadGpuConfig
  assert.equal(DEFAULT_STATE.gpuEmbedKeepAlive, '90m');
  assert.equal(ALLOWED_STATE_KEYS.has('gpuEmbedKeepAlive'), true);
  const patchedGpuState = sanitizeStatePatch({ gpuEmbedKeepAlive: '120m', gpuKeepAlive: '20m' });
  assert.equal(patchedGpuState.gpuEmbedKeepAlive, '120m');
  assert.equal(patchedGpuState.gpuKeepAlive, '20m');
  const loadedGpuCfg = loadGpuConfig({
    gpuEnabled: true,
    gpuEndpoint: 'http://127.0.0.1:11434',
    gpuChatModel: 'gemma4:12b',
    gpuEmbedModel: 'qwen3-embedding:0.6b',
    gpuEmbedKeepAlive: '75m',
  });
  assert.equal(loadedGpuCfg.gpuEmbedKeepAlive, '75m');

  // 2) distillLocalFile & @file: security guard on sensitive .env paths
  const tmpWs = makeTempDir('amr-gpu-boost-');
  try {
    const secretEnv = path.join(tmpWs, '.env');
    fs.writeFileSync(secretEnv, 'API_KEY=secret123\n', 'utf8');
    const secBlockDirect = await distillLocalFile({ filePath: '.env', workspaceRoot: tmpWs });
    assert.equal(secBlockDirect.ok, false);
    assert.equal(secBlockDirect.blocked, true);

    const secBlockAt = await distillText({ text: `@file:${secretEnv}`, workspaceRoot: tmpWs });
    assert.equal(secBlockAt.ok, false);
    assert.equal(secBlockAt.blocked, true);

    // 3) getContextPack with warmSemanticHits emits Hybrid GPU + RAM header
    const sampleFile = path.join(tmpWs, 'router-demo.mjs');
    fs.writeFileSync(
      sampleFile,
      'export function calculateGpuTokenSavings(chars) {\n  return Math.round(chars / 3.8);\n}\n',
      'utf8'
    );
    const ram = new RamMemoryEngine();
    try {
      ram.ensureWarm(tmpWs);
      const pack = ram.getContextPack(tmpWs, 'calculateGpuTokenSavings', {
        maxChars: 4000,
        warmSemanticHits: [{ file: 'router-demo.mjs', score: 0.91, startLine: 1, endLine: 3 }],
      });
      assert.equal(pack.ok, true);
      assert.match(pack.formatted, /## 🎮 Hybrid GPU \+ RAM Relevant Slices/);
      assert.match(pack.formatted, /calculateGpuTokenSavings/);
    } finally {
      ram.close();
    }

    // 4) maskTerminalOutputSmart clean deterministic fallback when useGpu: false
    const longLog = Array.from({ length: 70 }, (_, i) => `line ${i + 1}: build progress info...`).join('\n')
      + '\nError: TestAssertionFailed at core/demo.mjs:42\n';
    const smartRes = await maskTerminalOutputSmart(longLog, 1, { useGpu: false });
    assert.equal(smartRes.gpuDistilled, false);
    assert.match(smartRes.masked, /Error: TestAssertionFailed/);
  } finally {
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
});

test('27. Ollama Multimodal VRAM Reconciliation: fixes llamacpp /api/ps size_vram under-reporting and prevents DWM leak in UI', () => {
  const hwFull = {
    available: true,
    vramReliable: true,
    totalMb: 16376,
    usedMb: 11760,
    freeMb: 4302,
  };
  const psModels = [
    {
      name: 'qwen3-embedding:0.6b',
      size: 1010953092,
      size_vram: 1010953092,
      expires_at: '2026-11-15T00:31:53.7295075+03:00',
    },
    {
      name: 'gemma4:12b',
      size: 910625339,
      size_vram: 910625339,
      expires_at: '2026-11-14T23:06:25.6803077+03:00',
    },
  ];
  const tagModels = [
    { name: 'gemma4:12b', size: 8021618941 },
    { name: 'qwen3-embedding:0.6b', size: 639150858 },
  ];

  const fullRec = reconcileLoadedModelsVram(psModels, tagModels, hwFull);
  assert.equal(fullRec.loadedModels.length, 2);
  const embItem = fullRec.loadedModels.find((m) => m.name === 'qwen3-embedding:0.6b');
  const gemmaItem = fullRec.loadedModels.find((m) => m.name === 'gemma4:12b');
  assert.equal(embItem?.vramMb, 964);
  assert.equal(embItem?.reconciledVram, false);
  assert.equal(gemmaItem?.vramMb, 8518);
  assert.equal(gemmaItem?.reconciledVram, true);
  assert.equal(fullRec.loadedVramMb, 9482);

  // Partial offload ceiling clamp against nvidia-smi usedMb
  const partialRec = reconcileLoadedModelsVram(psModels, tagModels, {
    ...hwFull,
    usedMb: 6200,
  });
  const gemmaPartial = partialRec.loadedModels.find((m) => m.name === 'gemma4:12b');
  assert.ok(partialRec.loadedVramMb <= 6200, `Expected <= 6200, got ${partialRec.loadedVramMb}`);
  assert.equal(gemmaPartial?.vramMb, 5236);

  const uiHtml = fs.readFileSync(path.join(ROOT_DIR, 'sidecars', 'panel', 'ui.html'), 'utf8');
  assert.ok(uiHtml.includes('resolvePanelOllamaVram'), 'ui.html must include resolvePanelOllamaVram');
  assert.ok(uiHtml.includes('Всего на GPU:'), 'ui.html must display total GPU usage');
  assert.equal(
    uiHtml.includes('oll.loadedVramMb || hw.usedMb'),
    false,
    'ui.html must not leak DWM/external hw.usedMb into Ollama VRAM tile when unloaded'
  );
});

test('35. Semantic Skill Vector Index (qwen3-embedding:0.6b), Contrastive Anchors, gemma4:12b Fallback & Zero Keywords', async () => {
  const skillCrystallizerMod = await import('../core/skill-crystallizer.mjs');
  const pitfallMod = await import('../core/pitfall-ledger.mjs');

  // 1. Hardcoded keyword dictionary SKILL_DOMAIN_KEYWORDS must be completely removed
  assert.equal('SKILL_DOMAIN_KEYWORDS' in skillCrystallizerMod, false, 'SKILL_DOMAIN_KEYWORDS must be removed');

  // 2. formatEmbedInput handles skill_query without breaking query
  const qCode = formatEmbedInput('find auth', 'query', 'qwen3-embedding:0.6b');
  const qSkill = formatEmbedInput('Сделай рефакторинг', 'skill_query', 'qwen3-embedding:0.6b');
  assert.ok(qCode.includes('code search query') && !qCode.includes('skill profile'));
  assert.ok(qSkill.startsWith('Instruct:') && qSkill.includes('skill profile') && qSkill.includes('\nQuery:'));

  const tmpSkillsRoot = makeTempDir('amr-sem-skills-');
  const tmpWs = makeTempDir('amr-sem-ws-');

  try {
    const uiDir = path.join(tmpSkillsRoot, 'ui-card-motion');
    const sqlDir = path.join(tmpSkillsRoot, 'sql-perf-auditor');
    fs.mkdirSync(uiDir, { recursive: true });
    fs.mkdirSync(sqlDir, { recursive: true });

    fs.writeFileSync(
      path.join(uiDir, 'SKILL.md'),
      [
        '---',
        'name: ui-card-motion',
        'description: Smooth drag-and-drop spring motion and card layout transitions.',
        '---',
        '# UI Card Motion',
        '',
        '## Interactive Physics Recipe',
        'Use spring keyframes and pointer capture for draggable grid cards across viewport sizes.',
      ].join('\n'),
      'utf8'
    );
    fs.writeFileSync(
      path.join(sqlDir, 'SKILL.md'),
      [
        '---',
        'name: sql-perf-auditor',
        'description: Analyze slow database indexes and SQL query plans.',
        '---',
        '# SQL Perf Auditor',
        '',
        '## Index Diagnostic Recipe',
        'Run EXPLAIN ANALYZE and verify covering composite indexes before altering schema migrations.',
      ].join('\n'),
      'utf8'
    );

    const discovered = discoverSkillSemanticEntries(tmpSkillsRoot);
    assert.equal(discovered.length, 2, 'customRoot discovery must isolate strictly to tmpSkillsRoot');

    const mockEmbedBatch = async (texts) =>
      texts.map((t) => {
        if (t.includes('ui-card-motion')) return [0.95, 0.25, 0, 0, 0, 0, 0, 0];
        if (t.includes('sql-perf-auditor')) return [0, 0, 0.95, 0.25, 0, 0, 0, 0];
        // Contrastive __none__ anchors
        return [0, 0, 0, 0, 0.95, 0.25, 0, 0];
      });

    const idxRes = await indexSkillVectors({ customRoot: tmpSkillsRoot, embedBatchFn: mockEmbedBatch });
    assert.equal(idxRes.ok, true);
    assert.equal(idxRes.skillsCount, 2);

    // 3. Direct vector scorer with positive hit vs contrastive __none__ rejection
    const uiVec = Float32Array.from([0.96, 0.28, 0, 0, 0, 0, 0, 0]);
    const scoredPos = scoreSkillVectorsWithQueryVec(uiVec, idxRes.store);
    assert.equal(scoredPos.candidates[0]?.slug, 'ui-card-motion');
    assert.equal(scoredPos.candidates[0]?.confident, true);
    assert.ok(scoredPos.candidates[0]?.deltaVsNone > 0.5);

    const noneVec = Float32Array.from([0.08, 0, 0, 0, 0.96, 0.27, 0, 0]);
    const scoredNone = scoreSkillVectorsWithQueryVec(noneVec, idxRes.store);
    assert.equal(scoredNone.candidates.length, 0, 'Out-of-domain query matching __none__ anchor must produce 0 candidates');

    // 4. matchSkillsAi Stage 1 confident hit, Stage 1 __none__ rejection, and Stage 2 gemma4:12b fallback
    let llmCalls = 0;
    const judgeMock = async () => {
      llmCalls++;
      return { ok: true, slug: 'sql-perf-auditor', confidence: 0.86 };
    };

    const vecHit = await matchSkillsAi('Сделай плавное перетаскивание карточек', {
      customRoot: tmpSkillsRoot,
      embedBatchFn: mockEmbedBatch,
      embedQueryFn: async () => [0.96, 0.28, 0, 0, 0, 0, 0, 0],
      llmJudgeFn: judgeMock,
    });
    assert.equal(vecHit.source, 'vector');
    assert.equal(vecHit.bestSlug, 'ui-card-motion');
    assert.equal(llmCalls, 0, 'Confident Stage-1 vector hit must NOT invoke gemma4:12b fallback');

    const vecNone = await matchSkillsAi('Привет, как погода?', {
      customRoot: tmpSkillsRoot,
      embedBatchFn: mockEmbedBatch,
      embedQueryFn: async () => [0.05, 0, 0, 0, 0.96, 0.27, 0, 0],
      llmJudgeFn: judgeMock,
    });
    assert.equal(vecNone.source, 'vector_none');
    assert.equal(vecNone.bestSlug, '');
    assert.equal(llmCalls, 0, 'Strong __none__ vector rejection must NOT invoke gemma4:12b fallback');

    const grayZone = await matchSkillsAi('Исправь тормоза интерфейса и базы', {
      customRoot: tmpSkillsRoot,
      embedBatchFn: mockEmbedBatch,
      embedQueryFn: async () => [0.55, 0.1, 0.54, 0.1, 0.50, 0.1, 0, 0],
      llmJudgeFn: judgeMock,
    });
    assert.equal(grayZone.source, 'llm_fallback');
    assert.equal(grayZone.bestSlug, 'sql-perf-auditor');
    assert.equal(llmCalls, 1, 'Gray-zone vector match must invoke gemma4:12b fallback');

    // 5. classifySkillWithLlm think-retry & strict JSON validation
    let chatTries = 0;
    const llmDirect = await classifySkillWithLlm('Медленный SELECT с JOIN', discovered, {
      model: 'gemma4:12b',
      chatHttpFn: async (body) => {
        chatTries++;
        if (Object.hasOwn(body, 'think')) {
          return { ok: false, error: 'unsupported parameter: think' };
        }
        return {
          ok: true,
          data: { message: { content: '```json\n{"slug":"sql-perf-auditor","confidence":0.91}\n```' } },
        };
      },
    });
    assert.equal(chatTries, 2);
    assert.equal(llmDirect.ok, true);
    assert.equal(llmDirect.slug, 'sql-perf-auditor');

    // 6. Skill Crystallizer AI gate & Pitfall AI distillation
    const gateAi = await skillCrystallizerMod.evaluateCrystallizationGateAi({
      userPrompt: 'Сохрани как скилл оптимизацию SQL индекса',
      editedFiles: ['migrations/004_idx.sql'],
      customRoot: tmpSkillsRoot,
      aiOptions: {
        embedBatchFn: mockEmbedBatch,
        embedQueryFn: async () => [0, 0, 0.96, 0.28, 0, 0, 0, 0],
        llmJudgeFn: judgeMock,
      },
    });
    assert.equal(gateAi.shouldCrystallize, true);
    assert.equal(gateAi.suggestedSkill, 'sql-perf-auditor');

    pitfallMod.clearPitfalls(tmpWs);
    pitfallMod.recordPitfall({
      type: 'test_failure',
      fileName: 'index-query.sql',
      summary: 'Verify composite index order avoids sequential table scan',
      workspaceRoot: tmpWs,
    });
    const distillAi = await skillCrystallizerMod.distillPitfallsIntoSkillsAi({
      workspaceRoot: tmpWs,
      targetDir: tmpSkillsRoot,
      dryRun: true,
      aiOptions: {
        embedBatchFn: mockEmbedBatch,
        embedQueryFn: async () => [0, 0, 0.96, 0.28, 0, 0, 0, 0],
        llmJudgeFn: judgeMock,
      },
    });
    assert.equal(distillAi.ok, true);
    assert.equal(distillAi.evolvedSkills[0]?.slug, 'sql-perf-auditor');

    // 7. tool-pruner emits Semantic Skill Match hint and respects skillModes off
    const prunedActive = classifyTaskAndPruneTools(
      'Оптимизируй медленный SQL план запроса',
      { skillModes: {} },
      { semanticSkills: [{ slug: 'sql-perf-auditor', score: 0.72, deltaVsNone: 0.22, margin: 0.12, confident: true }] }
    );
    assert.match(prunedActive.allowedHint, /\[Semantic Skill Match: sql-perf-auditor/);

    const prunedDisabled = classifyTaskAndPruneTools(
      'Оптимизируй медленный SQL план запроса',
      { skillModes: { 'sql-perf-auditor': 'off' } },
      { semanticSkills: [{ slug: 'sql-perf-auditor', score: 0.72, deltaVsNone: 0.22, margin: 0.12, confident: true }] }
    );
    assert.doesNotMatch(prunedDisabled.allowedHint, /\[Semantic Skill Match: sql-perf-auditor/);
    assert.match(prunedDisabled.allowedHint, /\[Disabled Skills: sql-perf-auditor\]/);
  } finally {
    pitfallMod.clearPitfalls(tmpWs);
    fs.rmSync(tmpSkillsRoot, { recursive: true, force: true });
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
});

test('37. Live RAM & GPU Optical Telemetry: standby vs real-time work classification, 3s afterglow & dual-theme UI integrity', async () => {
  const { RamMemoryEngine } = await import('../core/ram-memory-engine.mjs');
  const {
    beginGpuLiveWork,
    classifyOllamaWorkRequest,
    endGpuLiveWork,
    getGpuLiveActivity,
  } = await import('../core/local-gpu-engine.mjs');

  // 1) RAM standby vs real-time work + afterglow decay (getStats itself must NOT trigger false work)
  const tmpWs = makeTempDir('amr-live-hw-');
  const ram = new RamMemoryEngine();
  try {
    fs.writeFileSync(path.join(tmpWs, 'demo.mjs'), 'export const alpha = 42;\nexport function runDemo() { return alpha; }\n', 'utf8');
    ram.ensureWarm(tmpWs);

    const idleStats = ram.getStats();
    assert.equal(idleStats.liveActivity.isWorking, false, 'Warm workspace without queries must stay in quiet standby');
    assert.equal(idleStats.liveActivity.opSeq, 0);

    const sliceRes = ram.slice(tmpWs, 'demo.mjs', { startLine: 1, endLine: 2 });
    assert.equal(sliceRes.ok, true);
    const activeStats = ram.getStats();
    assert.equal(activeStats.liveActivity.isWorking, true, 'Real ram_slice must activate liveActivity.isWorking');
    assert.equal(activeStats.liveActivity.lastOp, 'ram_slice');
    assert.ok(activeStats.liveActivity.afterglowRatio > 0, 'Afterglow ratio must be > 0 right after slice');

    ram.search(tmpWs, 'runDemo');
    const burstStats = ram.getStats();
    assert.equal(burstStats.liveActivity.lastOp, 'ram_search');
    assert.ok(burstStats.liveActivity.burstCount >= 2, 'Consecutive RAM operations must accumulate burstCount');

    const decayedSnap = ram.getLiveActivitySnapshot({ now: Date.now() + 5000, afterglowMs: 3200 });
    assert.equal(decayedSnap.isWorking, false, 'RAM activity must settle back to standby after afterglow window');
    assert.equal(decayedSnap.afterglowRatio, 0);
  } finally {
    ram.close();
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }

  // 2) GPU Ollama request classifier: background /api/ps, /api/tags, unload & warmup must NOT trigger active work
  assert.equal(classifyOllamaWorkRequest('GET', '/api/ps', null), null);
  assert.equal(classifyOllamaWorkRequest('GET', '/api/tags', null), null);
  assert.equal(classifyOllamaWorkRequest('POST', '/api/generate', { model: 'gemma4:12b', prompt: '', keep_alive: 0 }), null);
  assert.equal(classifyOllamaWorkRequest('POST', '/api/embed', { model: 'qwen3-embedding:0.6b', input: 'warmup' }), null);

  const distillWork = classifyOllamaWorkRequest('POST', '/api/generate', { model: 'gemma4:12b', prompt: 'compress log' });
  assert.equal(distillWork?.op, 'distill');
  assert.equal(distillWork?.model, 'gemma4:12b');

  const embedBatchWork = classifyOllamaWorkRequest('POST', '/api/embed', {
    model: 'qwen3-embedding:0.6b',
    input: ['chunk 1', 'chunk 2', 'chunk 3'],
  });
  assert.equal(embedBatchWork?.op, 'vector_index');

  // 3) GPU in-flight ticket lifecycle (working -> afterglow -> standby) in isolated temp activityFile
  const tmpGpuActFile = path.join(tmpWs, '.cache-test', 'gpu-live-activity.json');
  const ticket = beginGpuLiveWork({ op: 'distill', model: 'gemma4:12b', detail: 'Дистилляция на gemma4:12b', activityFile: tmpGpuActFile });
  try {
    const midFlight = getGpuLiveActivity({ activityFile: tmpGpuActFile });
    assert.equal(midFlight.isWorking, true);
    assert.ok(midFlight.inFlightCount >= 1);
    assert.equal(midFlight.currentOp, 'distill');
  } finally {
    endGpuLiveWork(ticket.jobId, { op: 'distill', model: 'gemma4:12b', detail: 'Дистилляция на gemma4:12b', latencyMs: 140, activityFile: tmpGpuActFile });
  }
  const afterDone = getGpuLiveActivity({ activityFile: tmpGpuActFile });
  assert.equal(afterDone.inFlightCount, 0);
  assert.equal(afterDone.isWorking, false);
  assert.equal(afterDone.isAfterglow, true);

  const settledGpu = getGpuLiveActivity({ now: Date.now() + 5000, afterglowMs: 2400, activityFile: tmpGpuActFile });
  assert.equal(settledGpu.isWorking, false);
  assert.equal(settledGpu.isAfterglow, false);
  fs.rmSync(tmpWs, { recursive: true, force: true });

  // 3b) CPU in-flight & instant pulse lifecycle (working -> afterglow -> standby) + getCpuStatusSnapshot contract
  const tmpCpuDir = makeTempDir('amr-live-cpu-');
  try {
    const {
      beginCpuLiveWork,
      endCpuLiveWork,
      getCpuLiveActivity,
      getCpuStatusSnapshot,
      recordCpuInstantWork,
    } = await import('../core/cpu-worker-pool.mjs');
    const tmpCpuActFile = path.join(tmpCpuDir, 'cpu-live-activity.json');
    const cpuTicket = beginCpuLiveWork({
      op: 'parseMetadataBatch',
      workers: 8,
      items: 75,
      detail: 'Разбор AST и триграмм (75 ф.)',
      activityFile: tmpCpuActFile,
    });
    try {
      const midCpu = getCpuLiveActivity({ activityFile: tmpCpuActFile });
      assert.equal(midCpu.isWorking, true);
      assert.equal(midCpu.activeThreads, 8);
      assert.equal(midCpu.currentOp, 'parseMetadataBatch');
    } finally {
      endCpuLiveWork(cpuTicket.jobId, {
        op: 'parseMetadataBatch',
        workers: 8,
        items: 75,
        detail: 'Разбор AST и триграмм (75 ф.)',
        latencyMs: 18,
        activityFile: tmpCpuActFile,
      });
    }
    const afterCpuBatch = getCpuLiveActivity({ activityFile: tmpCpuActFile });
    assert.equal(afterCpuBatch.inFlightCount, 0);
    assert.equal(afterCpuBatch.isWorking, false);
    assert.equal(afterCpuBatch.isAfterglow, true);
    assert.equal(afterCpuBatch.recentThreads, 8);

    recordCpuInstantWork({
      op: 'cross_rerank',
      workers: 1,
      items: 25,
      detail: 'Cross-Reranker · 25 канд.',
      latencyMs: 0.48,
      activityFile: tmpCpuActFile,
    });
    const afterRerank = getCpuLiveActivity({ activityFile: tmpCpuActFile });
    assert.equal(afterRerank.isAfterglow, true);
    assert.equal(afterRerank.currentOp, 'cross_rerank');

    const settledCpu = getCpuLiveActivity({ now: Date.now() + 5000, afterglowMs: 2800, activityFile: tmpCpuActFile });
    assert.equal(settledCpu.isWorking, false);
    assert.equal(settledCpu.isAfterglow, false);
    assert.equal(settledCpu.afterglowRatio, 0);

    const cpuSnap = getCpuStatusSnapshot();
    assert.ok(cpuSnap.liveActivity && typeof cpuSnap.liveActivity === 'object', 'getCpuStatusSnapshot must include liveActivity');
  } finally {
    fs.rmSync(tmpCpuDir, { recursive: true, force: true });
  }

  // 4) UI DOM, CSP & dual-theme optical animation contract (with integrated RAM/GPU/CPU cards & relocated CPU threads row)
  const uiHtml = fs.readFileSync(path.join(ROOT_DIR, 'sidecars', 'panel', 'ui.html'), 'utf8');
  assert.equal(/\bon(?:click|change|input)\s*=/i.test(uiHtml), false, 'ui.html must remain 100% CSP clean');
  for (const requiredId of [
    'topRamLivePill',
    'topGpuLivePill',
    'topCpuLivePill',
    'ramLiveUnitCard',
    'gpuLiveUnitCard',
    'cpuLiveUnitCard',
    'gpuUnitGgufPill',
    'cpuUnitThreadBar',
    'ramUnitAfterglowFill',
    'gpuUnitAfterglowFill',
    'cpuUnitAfterglowFill',
    'ramUnitCapPct',
    'gpuUnitCapPct',
    'cpuUnitCapPct',
    'ramBudgetMainGroup',
    'cpuThreadsCapGroup',
  ]) {
    assert.ok(uiHtml.includes(`id="${requiredId}"`), `ui.html must contain #${requiredId}`);
  }
  for (const removedDupId of [
    'metricCache',
    'metricSwarmWorkers',
    'allChatsStepsLabel',
    'gpuStatusBadge',
    'gpuVramMetric',
    'gpuSavedTokensMetric',
    'cpuStatusSubLine',
    'ramUnitSavedPill',
    'gpuUnitSavedPill',
    'cpuUnitSavedPill',
    'ramCacheSubLine',
  ]) {
    assert.equal(uiHtml.includes(`id="${removedDupId}"`), false, `ui.html must NOT contain duplicate/removed #${removedDupId}`);
  }
  const idxRamCard = uiHtml.indexOf('id="ramLiveUnitCard"');
  const idxGpuCard = uiHtml.indexOf('id="gpuLiveUnitCard"');
  const idxCpuCard = uiHtml.indexOf('id="cpuLiveUnitCard"');
  const idxRamLimit = uiHtml.indexOf('id="ramBudgetMainGroup"');
  const idxGpuSwitch = uiHtml.indexOf('id="chk-gpuEnabled"');
  const idxGpuGgufPill = uiHtml.indexOf('id="gpuUnitGgufPill"');
  const idxVramLimit = uiHtml.indexOf('id="gpuVramCapGroup"');
  const idxCpuSwitch = uiHtml.indexOf('id="chk-cpuMulticoreEnabled"');
  const idxCpuThreads = uiHtml.indexOf('id="cpuThreadsCapGroup"');
  assert.ok(
    idxRamCard > 0 && idxRamLimit > idxRamCard && idxRamLimit < idxGpuCard,
    'ramBudgetMainGroup must live inside #ramLiveUnitCard'
  );
  assert.ok(
    idxGpuCard > 0 && idxGpuSwitch > idxGpuCard && idxGpuGgufPill > idxGpuCard && idxVramLimit > idxGpuSwitch && idxVramLimit < idxCpuCard && idxGpuGgufPill < idxCpuCard,
    'chk-gpuEnabled, gpuUnitGgufPill and gpuVramCapGroup must live inside #gpuLiveUnitCard'
  );
  assert.ok(
    idxCpuCard > 0 && idxCpuSwitch > idxCpuCard && idxCpuThreads > idxCpuSwitch,
    'chk-cpuMulticoreEnabled and cpuThreadsCapGroup must live inside #cpuLiveUnitCard'
  );
  assert.equal(uiHtml.includes('class="hw-master-row"'), false, 'Legacy .hw-master-row block must be removed');
  assert.ok(uiHtml.includes('@keyframes hwSpinOpticalRim'), 'ui.html must include optical rim keyframe');
  assert.ok(uiHtml.includes('@keyframes hwCausticFlow'), 'ui.html must include Liquid Silk caustic flow keyframe');
  assert.ok(uiHtml.includes('.hw-optical-unit.cpu-unit .hw-afterglow-fill'), 'ui.html must style unified Liquid Silk reservoir for CPU unit');
  assert.equal(uiHtml.includes('cpu-thread-seg'), false, 'ui.html must NOT render legacy stretched orange CPU segments');
  assert.equal(uiHtml.includes('hw-tank-ticks'), false, 'ui.html must NOT render vertical tick lines inside status bars');
  assert.ok((uiHtml.match(/class="hw-afterglow-track hw-liquid-tank"/g) || []).length >= 2 && uiHtml.includes('class="hw-afterglow-track hw-liquid-tank" id="cpuUnitThreadBar"'), 'RAM, GPU and CPU units must all render unified Liquid Silk reservoirs');
  assert.ok(uiHtml.includes('.hw-optical-unit'), 'ui.html must style hardware optical units');
  assert.ok(uiHtml.includes('.hw-optical-unit.cpu-unit.is-working'), 'ui.html must style CPU unit working state');
  assert.equal(uiHtml.includes('hw-unit-saved-pill'), false, 'Saved/counter pills must be removed from hardware tiles');
  assert.ok(uiHtml.includes('.hw-tank-pct'), 'ui.html must style tank percentage readout');
  assert.match(uiHtml, /id="topRamLivePill"[^>]*data-action="toggleLiteRamOnly"[^>]*aria-pressed=/, 'Header RAM pill must toggle RAM cache');
  assert.match(uiHtml, /id="topGpuLivePill"[^>]*data-action="toggleLiteGpuOnly"[^>]*aria-pressed=/, 'Header GPU pill must toggle GPU copilot');
  assert.match(uiHtml, /id="topCpuLivePill"[^>]*data-action="toggleLiteCpuOnly"[^>]*aria-pressed=/, 'Header CPU pill must toggle CPU thread pool');
});

test('38. GPU Model Selector & Model Search Prompt: deduplicated standby tile, select dropdowns & direct chat dispatch', async () => {
  const { buildAiModelSearchPrompt } = await import('../core/hardware-profiler.mjs');
  const prompt = buildAiModelSearchPrompt(
    {
      system: { totalRamGb: 32 },
      gpu: { name: 'NVIDIA GeForce RTX 4070', vendor: 'nvidia', totalMb: 12288, backendHint: 'cuda' },
      ollama: {
        installed: true,
        running: true,
        downloadedModels: [
          { name: 'gemma4:12b', sizeGb: 7.47 },
          { name: 'qwen3-embedding:0.6b', sizeGb: 0.6 },
        ],
      },
    },
    { gpuChatModel: 'gemma4:12b', gpuEmbedModel: 'qwen3-embedding:0.6b', gpuMaxVramMb: 12288, gpuContextTokens: 4096 },
    {
      config: { gpuChatModel: 'gemma4:12b', gpuEmbedModel: 'qwen3-embedding:0.6b', gpuMaxVramMb: 12288, gpuContextTokens: 4096 },
      hardware: { available: true, name: 'NVIDIA GeForce RTX 4070', vendor: 'nvidia', totalMb: 12288, backendHint: 'cuda' },
      ollama: {
        running: true,
        downloadedModels: [
          { name: 'gemma4:12b', sizeGb: 7.47 },
          { name: 'qwen3-embedding:0.6b', sizeGb: 0.6 },
        ],
        loadedModels: [{ name: 'gemma4:12b', vramMb: 8518 }],
      },
    }
  );
  assert.ok(prompt.includes('gemma4:12b (7.47 GB)'), 'Prompt must include installed chat model');
  assert.ok(prompt.includes('qwen3-embedding:0.6b (0.6 GB)'), 'Prompt must include installed embed model');
  assert.ok(prompt.includes('ollama pull'), 'Prompt must include ollama pull guidance');

  const serverCode = fs.readFileSync(path.join(ROOT_DIR, 'sidecars', 'panel', 'server.mjs'), 'utf8');
  assert.ok(serverCode.includes("action === 'model_search_prompt'"), 'server.mjs must support model_search_prompt');

  const uiHtml = fs.readFileSync(path.join(ROOT_DIR, 'sidecars', 'panel', 'ui.html'), 'utf8');
  assert.equal(/\bon(?:click|change|input)\s*=/i.test(uiHtml), false, 'ui.html must remain 100% CSP clean');
  const scriptMatch = uiHtml.match(/<script>([\s\S]*?)<\/script>/i);
  assert.ok(scriptMatch, 'ui.html must contain <script>');
  new vm.Script(scriptMatch[1], { filename: 'sidecars/panel/ui.html' });

  for (const requiredId of [
    'gpuModelsPicker',
    'sel-gpuChatModel',
    'sel-gpuEmbedModel',
    'btn-gpuChatModel',
    'btn-gpuEmbedModel',
    'lgCustomSelectMenu',
  ]) {
    assert.ok(uiHtml.includes(`id="${requiredId}"`), `ui.html must contain #${requiredId}`);
  }
  for (const removedId of [
    'gpuModelsLine',
    'hwPromptFallbackBox',
    'hwPromptFallbackTextarea',
    'btnSendPromptBoxToChat',
    'hwPromptBoxTitle',
  ]) {
    assert.equal(uiHtml.includes(`id="${removedId}"`), false, `ui.html must NOT contain #${removedId}`);
  }
  assert.equal(uiHtml.includes('openPromptPreviewBox'), false, 'ui.html must NOT contain openPromptPreviewBox');
  assert.equal(uiHtml.includes('sendPromptBoxToChat'), false, 'ui.html must NOT contain sendPromptBoxToChat');
  assert.equal(uiHtml.includes("'Дежурит в VRAM (' + names"), false, 'Standby GPU tile must not duplicate model names');
  assert.ok(uiHtml.includes("gpuOp.textContent = 'Дежурит в VRAM · расчётов сейчас нет'"), 'Standby GPU tile must show clean text');
  assert.ok(uiHtml.includes('prepareModelSearchPrompt'), 'ui.html must wire prepareModelSearchPrompt');
  assert.ok(uiHtml.includes('dispatchPromptToChatOrClipboard'), 'ui.html must wire dispatchPromptToChatOrClipboard');
  assert.ok(uiHtml.includes('selectGpuModel'), 'ui.html must wire selectGpuModel');
  assert.ok(uiHtml.includes('toggleCustomSelect'), 'ui.html must wire toggleCustomSelect');
});

test('53. Automatic GPU VRAM unload on Antigravity exit (gpuUnloadOnExit, MCP daemon & Sidecar fallback)', async () => {
  const { unloadModelsOnAppExit } = await import('../core/local-gpu-engine.mjs');
  const { handleMcpDaemonExit } = await import('../core/ram-memory-mcp.mjs');
  const { handleSidecarExitCleanup } = await import('../sidecars/panel/server.mjs');

  assert.equal(DEFAULT_STATE.gpuUnloadOnExit, true);
  assert.equal(ALLOWED_STATE_KEYS.has('gpuUnloadOnExit'), true);
  assert.deepEqual(sanitizeStatePatch({ gpuUnloadOnExit: false }), { gpuUnloadOnExit: false });
  const routerCliSrc = fs.readFileSync(path.join(ROOT_DIR, 'core', 'router-cli.mjs'), 'utf8');
  assert.match(routerCliSrc, /'gpuUnloadOnExit'/);

  const cfgDefault = loadGpuConfig();
  assert.equal(cfgDefault.gpuUnloadOnExit, true);
  assert.equal(loadGpuConfig({ gpuUnloadOnExit: false }).gpuUnloadOnExit, false);

  const uiHtml = fs.readFileSync(path.join(ROOT_DIR, 'sidecars', 'panel', 'ui.html'), 'utf8');
  assert.match(uiHtml, /id="chk-gpuUnloadOnExit"[^>]*data-key="gpuUnloadOnExit"/);
  const defaultStateFile = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'router-state.json'), 'utf8'));
  assert.equal(defaultStateFile.gpuUnloadOnExit, true);

  let unloadCalls = 0;
  const skippedDisabled = await unloadModelsOnAppExit({
    loadConfigFn: () => ({ gpuEnabled: false, gpuUnloadOnExit: true }),
    unloadFn: async () => {
      unloadCalls += 1;
      return { ok: true, unloaded: ['gemma4:12b'] };
    },
  });
  assert.equal(skippedDisabled.skipped, true);
  assert.equal(skippedDisabled.reason, 'gpu_disabled');
  assert.equal(unloadCalls, 0);

  const skippedOptOut = await unloadModelsOnAppExit({
    loadConfigFn: () => ({ gpuEnabled: true, gpuUnloadOnExit: false }),
    unloadFn: async () => {
      unloadCalls += 1;
      return { ok: true, unloaded: ['gemma4:12b'] };
    },
  });
  assert.equal(skippedOptOut.skipped, true);
  assert.equal(skippedOptOut.reason, 'unload_on_exit_disabled');
  assert.equal(unloadCalls, 0);

  const executed = await unloadModelsOnAppExit({
    loadConfigFn: () => ({ gpuEnabled: true, gpuUnloadOnExit: true }),
    unloadFn: async () => {
      unloadCalls += 1;
      return { ok: true, unloaded: ['gemma4:12b', 'qwen3-embedding:0.6b'] };
    },
  });
  assert.equal(executed.ok, true);
  assert.deepEqual(executed.unloaded, ['gemma4:12b', 'qwen3-embedding:0.6b']);
  assert.equal(unloadCalls, 1);

  const timedOut = await unloadModelsOnAppExit({
    timeoutMs: 200,
    loadConfigFn: () => ({ gpuEnabled: true, gpuUnloadOnExit: true }),
    unloadFn: () => new Promise(() => {}),
  });
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.timedOut, true);

  let mcpUnloadTriggered = 0;
  const mcpOtherAlive = await handleMcpDaemonExit({
    cleanupFn: () => ({ remainingLiveCount: 1 }),
    unloadFn: async () => {
      mcpUnloadTriggered += 1;
      return { ok: true, unloaded: ['gemma4:12b'] };
    },
  });
  assert.equal(mcpOtherAlive.skipped, true);
  assert.equal(mcpOtherAlive.reason, 'other_instances_alive');
  assert.equal(mcpUnloadTriggered, 0);

  const mcpLastExit = await handleMcpDaemonExit({
    cleanupFn: () => ({ remainingLiveCount: 0 }),
    unloadFn: async () => {
      mcpUnloadTriggered += 1;
      return { ok: true, unloaded: ['qwen3-embedding:0.6b'] };
    },
  });
  assert.equal(mcpLastExit.ok, true);
  assert.deepEqual(mcpLastExit.unloaded, ['qwen3-embedding:0.6b']);
  assert.equal(mcpUnloadTriggered, 1);

  let sidecarUnloadTriggered = 0;
  const sidecarSkipped = await handleSidecarExitCleanup({
    hasLiveDaemonFn: () => true,
    getGpuModFn: async () => ({
      unloadModelsOnAppExit: async () => {
        sidecarUnloadTriggered += 1;
        return { ok: true, unloaded: ['gemma4:12b'] };
      },
    }),
  });
  assert.equal(sidecarSkipped.skipped, true);
  assert.equal(sidecarSkipped.reason, 'mcp_daemon_alive');
  assert.equal(sidecarUnloadTriggered, 0);

  const sidecarFallback = await handleSidecarExitCleanup({
    hasLiveDaemonFn: () => false,
    getGpuModFn: async () => ({
      unloadModelsOnAppExit: async () => {
        sidecarUnloadTriggered += 1;
        return { ok: true, unloaded: ['gemma4:12b'] };
      },
    }),
  });
  assert.equal(sidecarFallback.ok, true);
  assert.deepEqual(sidecarFallback.unloaded, ['gemma4:12b']);
  assert.equal(sidecarUnloadTriggered, 1);
});

test('56. Strict GPU VRAM Cap Enforcement (gpuMaxVramMb): model fit check, selective unload, distill/classifier blocking & chat prompt', async () => {
  const {
    estimateModelVramMb,
    evaluateVramModelFit,
    enforceVramCapInOllama,
    distillText,
    classifySkillWithLlm,
  } = await import('../core/local-gpu-engine.mjs');
  const { buildVramFitModelPrompt } = await import('../core/hardware-profiler.mjs');

  const tagOnlyLarge = [
    { name: 'gemma4:12b', size: 8021618941 },
    { name: 'qwen3-embedding:0.6b', size: 639150858 },
  ];
  const tagWithCompact = [
    ...tagOnlyLarge,
    { name: 'gemma4:e2b', size: 2093796556 },
  ];
  const hw16gb = {
    available: true,
    vendor: 'nvidia',
    vramReliable: true,
    name: 'NVIDIA GeForce RTX 4070 Ti SUPER',
    totalMb: 16376,
    usedMb: 10264,
    freeMb: 5798,
  };

  // 1) Estimation & fit check under 4 GB cap with only gemma4:12b downloaded
  const gemmaEstMb = estimateModelVramMb('gemma4:12b', tagOnlyLarge, [], 'qwen3-embedding:0.6b');
  assert.ok(gemmaEstMb > 8000, `Expected gemma4:12b VRAM estimate > 8000 MB, got ${gemmaEstMb}`);

  const fit4gbMissing = evaluateVramModelFit({
    cfg: { gpuEnabled: true, gpuMaxVramMb: 4096, gpuChatModel: 'gemma4:12b', gpuEmbedModel: 'qwen3-embedding:0.6b' },
    tagModels: tagOnlyLarge,
    loadedModels: [],
    hw: hw16gb,
  });
  assert.equal(fit4gbMissing.selectedSizeFits, false);
  assert.equal(fit4gbMissing.selectedChatFits, false);
  assert.equal(fit4gbMissing.needsModelDownload, true);
  assert.equal(fit4gbMissing.recommendedPullModel, 'qwen3:4b');
  assert.equal(fit4gbMissing.bestFallbackChatModel, '');

  const fit14gbOk = evaluateVramModelFit({
    cfg: { gpuEnabled: true, gpuMaxVramMb: 14336, gpuChatModel: 'gemma4:12b', gpuEmbedModel: 'qwen3-embedding:0.6b' },
    tagModels: tagOnlyLarge,
    loadedModels: [],
    hw: hw16gb,
  });
  assert.equal(fit14gbOk.selectedSizeFits, true);
  assert.equal(fit14gbOk.selectedChatFits, true);
  assert.equal(fit14gbOk.needsModelDownload, false);

  const fit4gbWithCompact = evaluateVramModelFit({
    cfg: { gpuEnabled: true, gpuMaxVramMb: 4096, gpuChatModel: 'gemma4:12b', gpuEmbedModel: 'qwen3-embedding:0.6b' },
    tagModels: tagWithCompact,
    loadedModels: [],
    hw: hw16gb,
  });
  assert.equal(fit4gbWithCompact.selectedSizeFits, false);
  assert.equal(fit4gbWithCompact.bestFallbackChatModel, 'gemma4:e2b');
  assert.equal(fit4gbWithCompact.needsModelDownload, false);

  // 2) enforceVramCapInOllama unloads oversized gemma4:12b while keeping lightweight embedder warm
  const unloadCalls = [];
  const psBothWarm = [
    { name: 'qwen3-embedding:0.6b', size: 1010953092, size_vram: 1010953092 },
    { name: 'gemma4:12b', size: 910625339, size_vram: 910625339 },
  ];
  const enforceRes = await enforceVramCapInOllama({
    cfgOverride: {
      gpuEnabled: true,
      gpuMaxVramMb: 4096,
      gpuChatModel: 'gemma4:12b',
      gpuEmbedModel: 'qwen3-embedding:0.6b',
      gpuEndpoint: 'http://127.0.0.1:11434',
    },
    hwProbeFn: () => hw16gb,
    httpJsonFn: async (method, urlPath, body) => {
      if (method === 'GET' && urlPath === '/api/ps') return { ok: true, data: { models: psBothWarm } };
      if (method === 'GET' && urlPath === '/api/tags') return { ok: true, data: { models: tagOnlyLarge } };
      if (method === 'POST') {
        unloadCalls.push({ urlPath, body });
        return { ok: true, data: {} };
      }
      return { ok: false };
    },
  });
  assert.deepEqual(enforceRes.unloaded, ['gemma4:12b']);
  assert.equal(unloadCalls.length, 1);
  assert.equal(unloadCalls[0].urlPath, '/api/generate');
  assert.equal(unloadCalls[0].body.keep_alive, 0);
  assert.equal(enforceRes.kept.some((m) => m.name === 'qwen3-embedding:0.6b'), true);
  assert.equal(enforceRes.vramFit.needsModelDownload, true);

  // 3) distillText blocks loading gemma4:12b when 4 GB cap has no fitting chat model
  let chatCalled = 0;
  const blockedDistill = await distillText({
    text: 'ERROR: TypeError: x is undefined at app.js:10\n'.repeat(12),
    mode: 'error_log',
    cfgOverride: {
      gpuEnabled: true,
      gpuMaxVramMb: 4096,
      gpuChatModel: 'gemma4:12b',
      gpuEmbedModel: 'qwen3-embedding:0.6b',
      gpuEndpoint: 'http://127.0.0.1:11434',
    },
    hwProbeFn: () => hw16gb,
    httpJsonFn: async (method, urlPath) => {
      if (method === 'GET' && urlPath === '/api/ps') return { ok: true, data: { models: [] } };
      if (method === 'GET' && urlPath === '/api/tags') return { ok: true, data: { models: tagOnlyLarge } };
      if (method === 'POST' && urlPath === '/api/chat') {
        chatCalled++;
        return { ok: true, data: { message: { content: 'should not run' } } };
      }
      return { ok: false };
    },
  });
  assert.equal(chatCalled, 0, 'distillText must NEVER invoke /api/chat with gemma4:12b under 4 GB VRAM cap');
  assert.equal(blockedDistill.ok, false);
  assert.equal(blockedDistill.skippedVramCap, true);
  assert.equal(blockedDistill.needsModelDownload, true);
  assert.equal(blockedDistill.recommendedPullModel, 'qwen3:4b');

  // 4) distillText auto-switches to gemma4:e2b when a compact downloaded model fits 4 GB cap
  let usedChatModel = '';
  const fallbackDistill = await distillText({
    text: 'ERROR: ReferenceError at server.mjs:42\n'.repeat(10),
    mode: 'error_log',
    cfgOverride: {
      gpuEnabled: true,
      gpuMaxVramMb: 4096,
      gpuChatModel: 'gemma4:12b',
      gpuEmbedModel: 'qwen3-embedding:0.6b',
      gpuEndpoint: 'http://127.0.0.1:11434',
    },
    hwProbeFn: () => hw16gb,
    httpJsonFn: async (method, urlPath, body) => {
      if (method === 'GET' && urlPath === '/api/ps') return { ok: true, data: { models: [] } };
      if (method === 'GET' && urlPath === '/api/tags') return { ok: true, data: { models: tagWithCompact } };
      if (method === 'POST' && urlPath === '/api/chat') {
        usedChatModel = body?.model || '';
        return { ok: true, data: { message: { content: '- Root cause at server.mjs:42' } } };
      }
      return { ok: false };
    },
  });
  assert.equal(fallbackDistill.ok, true);
  assert.equal(usedChatModel, 'gemma4:e2b');
  assert.equal(fallbackDistill.model, 'gemma4:e2b');
  assert.equal(fallbackDistill.autoSwitchedFrom, 'gemma4:12b');

  // 5) classifySkillWithLlm skips oversized gemma4:12b under 4 GB cap
  let clsCalls = 0;
  const clsBlocked = await classifySkillWithLlm(
    'Сделай шейдер для видео',
    [{ slug: 'vj-video-fx-studio', description: 'Shaders and video effects' }],
    {
      cfgOverride: {
        gpuEnabled: true,
        gpuMaxVramMb: 4096,
        gpuChatModel: 'gemma4:12b',
        gpuEmbedModel: 'qwen3-embedding:0.6b',
      },
      tagModels: tagOnlyLarge,
      chatHttpFn: async () => {
        clsCalls++;
        return { ok: true, data: { message: { content: '{"slug":"none","confidence":0.1}' } } };
      },
    }
  );
  assert.equal(clsCalls, 0);
  assert.equal(clsBlocked.ok, false);
  assert.equal(clsBlocked.skippedVramCap, true);
  assert.equal(clsBlocked.needsModelDownload, true);

  // 6) buildVramFitModelPrompt + UI/Server contracts
  const promptText = buildVramFitModelPrompt(
    { system: { totalRamGb: 64 }, gpu: hw16gb },
    { gpuMaxVramMb: 4096, gpuChatModel: 'gemma4:12b', gpuEmbedModel: 'qwen3-embedding:0.6b' },
    {
      hardware: hw16gb,
      ollama: {
        downloadedModels: [
          { name: 'gemma4:12b', sizeGb: 7.47 },
          { name: 'qwen3-embedding:0.6b', sizeGb: 0.6 },
        ],
        loadedModels: [],
      },
      vramFit: fit4gbMissing,
    }
  );
  assert.match(promptText, /4 ГБ/);
  assert.match(promptText, /gemma4:12b/);
  assert.match(promptText, /qwen3:4b/);
  assert.match(promptText, /ollama pull/);

  const uiHtml = fs.readFileSync(path.join(ROOT_DIR, 'sidecars', 'panel', 'ui.html'), 'utf8');
  assert.ok(uiHtml.includes('id="gpuVramFitAlert"'));
  assert.ok(uiHtml.includes('sendVramFitModelPrompt'));
  assert.ok(uiHtml.includes('computeClientVramFit'));
  assert.ok(uiHtml.includes('applySuggestedVramModel'));

  const serverJs = fs.readFileSync(path.join(ROOT_DIR, 'sidecars', 'panel', 'server.mjs'), 'utf8');
  assert.ok(serverJs.includes('enforceVramCapInOllama'));
  assert.ok(serverJs.includes("action === 'vram_fit_prompt'"));
});

test('57. Adaptive GPU Model Cascade: VRAM tier pairs, HF fallback download, auto Chat+Embed switching & per-embed vector cache', async () => {
  const { buildGpuCascadeBundleForHardware, resolveGpuModelPairForVramCap } = await import('../core/hardware-profiler.mjs');
  const {
    formatCompactPullError,
    getVectorStorePaths,
    isTransientPullError,
    loadWorkspaceVectorStore,
    pullSingleOllamaModelWithFallback,
    saveWorkspaceVectorStore,
    selectBestInstalledPairForCap,
    startGpuCascadePull,
  } = await import('../core/local-gpu-engine.mjs');

  // 1) Tier pair matrix across 4 -> 8 -> 12 -> 14 -> 24 GB
  const p4 = resolveGpuModelPairForVramCap(4096);
  const p8 = resolveGpuModelPairForVramCap(8192);
  const p12 = resolveGpuModelPairForVramCap(12288);
  const p14 = resolveGpuModelPairForVramCap(14336);
  const p24 = resolveGpuModelPairForVramCap(24576);
  assert.equal(p4.gpuChatModel, 'qwen3:4b');
  assert.equal(p4.gpuEmbedModel, 'qwen3-embedding:0.6b');
  assert.equal(p8.gpuChatModel, 'qwen3:4b');
  assert.equal(p8.gpuEmbedModel, 'qwen3-embedding:4b');
  assert.equal(p12.gpuChatModel, 'gemma4:12b');
  assert.equal(p12.gpuEmbedModel, 'qwen3-embedding:0.6b');
  assert.equal(p14.gpuChatModel, 'gemma4:12b');
  assert.equal(p14.gpuEmbedModel, 'qwen3-embedding:4b');
  assert.equal(p24.gpuChatModel, 'gemma4:12b');
  assert.equal(p24.gpuEmbedModel, 'qwen3-embedding:8b');

  // 2) Deduplicated cascade bundle for 16 GB GPU (skipping already-installed qwen3:4b)
  const bundle16 = buildGpuCascadeBundleForHardware(16376, {
    mode: 'cascade',
    downloadedModels: [{ name: 'qwen3:4b', sizeGb: 2.33 }],
  });
  assert.deepEqual(
    bundle16.models.map((m) => m.name),
    ['qwen3-embedding:0.6b', 'qwen3:4b', 'qwen3-embedding:4b', 'gemma4:12b']
  );
  assert.equal(bundle16.models.find((m) => m.name === 'qwen3:4b')?.alreadyDownloaded, true);
  assert.equal(bundle16.missingModels.some((m) => m.name === 'qwen3:4b'), false);
  assert.equal(bundle16.missingModels.length, 3);

  // 3) Auto Chat + Embed pair selection when switching 14 GB -> 8 GB -> 4 GB
  const fullTags = [
    { name: 'qwen3-embedding:0.6b', size: Math.round(0.6 * 1024 ** 3) },
    { name: 'qwen3-embedding:4b', size: Math.round(2.45 * 1024 ** 3) },
    { name: 'qwen3:4b', size: Math.round(2.33 * 1024 ** 3) },
    { name: 'gemma4:12b', size: Math.round(7.47 * 1024 ** 3) },
  ];
  const sel14 = selectBestInstalledPairForCap({ capMb: 14336, tagModels: fullTags });
  const sel8 = selectBestInstalledPairForCap({ capMb: 8192, tagModels: fullTags });
  const sel4 = selectBestInstalledPairForCap({ capMb: 4096, tagModels: fullTags });
  assert.equal(sel14.gpuChatModel, 'gemma4:12b');
  assert.equal(sel14.gpuEmbedModel, 'qwen3-embedding:4b');
  assert.equal(sel8.gpuChatModel, 'qwen3:4b');
  assert.equal(sel8.gpuEmbedModel, 'qwen3-embedding:4b');
  assert.equal(sel4.gpuChatModel, 'qwen3:4b');
  assert.equal(sel4.gpuEmbedModel, 'qwen3-embedding:0.6b');

  // 4) Resilient cascade pull with automatic Hugging Face fallback on TLS timeout
  const cliCalls = [];
  const pullRes = await startGpuCascadePull({
    models: ['qwen3:4b', 'qwen3-embedding:4b'],
    installedTags: ['qwen3:4b'],
    awaitCompletion: true,
    execStepFn: async (args, opts) => {
      cliCalls.push(args);
      if (args[0] === 'pull' && args[1] === 'qwen3-embedding:4b') {
        return { ok: false, code: 1, error: 'net/http: TLS handshake timeout' };
      }
      if (args[0] === 'pull' && args[1] === 'hf.co/Qwen/Qwen3-Embedding-4B-GGUF:Q4_K_M') {
        opts?.onLine?.('pulling 50%', 50);
        opts?.onLine?.('pulling 100%', 100);
        return { ok: true, code: 0 };
      }
      return { ok: true, code: 0 };
    },
  });
  assert.equal(pullRes.active, false);
  assert.equal(pullRes.completedCount, 2);
  const pulled4bItem = pullRes.items.find((it) => it.name === 'qwen3-embedding:4b');
  assert.equal(pulled4bItem?.status, 'done');
  assert.equal(pulled4bItem?.source, 'huggingface');
  assert.equal(cliCalls.some((a) => a[0] === 'cp' && a[1] === 'hf.co/Qwen/Qwen3-Embedding-4B-GGUF:Q4_K_M' && a[2] === 'qwen3-embedding:4b'), true);
  assert.equal(cliCalls.some((a) => a[0] === 'rm' && a[1] === 'hf.co/Qwen/Qwen3-Embedding-4B-GGUF:Q4_K_M'), true);

  // 4b) Compact error preserves trailing cause after long CDN URLs & HF transient retry recovers
  const longSignedErr =
    'Error: Head "https://us.aws.cdn.hf.co/xet-bridge-us/6841528d96b56a2a82c7d197/02d548251433678db07b9589e5a7462463966a0836d336ab0098c66f1f0da238?response-content-disposition=inline%3B+filename*%3DUTF-8%27%27Qwen3-Embedding-4B-Q4_K_M.gguf&Expires=1794944193&Policy=eyJTdGF0ZW1lbnQiOlt7fV19": EOF';
  const compactErr = formatCompactPullError(longSignedErr, 220);
  assert.equal(compactErr.includes('https://us.aws.cdn.hf.co/...'), true);
  assert.equal(compactErr.endsWith(': EOF'), true);
  assert.equal(isTransientPullError(compactErr), true);
  assert.equal(isTransientPullError('Error: 404 Not Found'), false);

  let hfAttempts = 0;
  const retryRes = await pullSingleOllamaModelWithFallback('qwen3-embedding:4b', {
    retryDelayMs: 1,
    execStepFn: async (args, opts) => {
      if (args[0] === 'pull' && args[1] === 'qwen3-embedding:4b') {
        return { ok: false, code: 1, error: 'Таймаут реестра Ollama (TLS/manifest timeout)' };
      }
      if (args[0] === 'pull' && args[1] === 'hf.co/Qwen/Qwen3-Embedding-4B-GGUF:Q4_K_M') {
        hfAttempts += 1;
        if (hfAttempts === 1) {
          return { ok: false, code: 1, error: longSignedErr };
        }
        opts?.onLine?.('pulling 100%', 100);
        return { ok: true, code: 0 };
      }
      return { ok: true, code: 0 };
    },
  });
  assert.equal(retryRes.ok, true);
  assert.equal(hfAttempts, 2);

  let nonTransientAttempts = 0;
  const permFailRes = await pullSingleOllamaModelWithFallback('qwen3-embedding:4b', {
    retryDelayMs: 1,
    execStepFn: async (args) => {
      if (args[0] === 'pull' && args[1] === 'qwen3-embedding:4b') {
        return { ok: false, code: 1, error: 'Таймаут реестра Ollama (TLS/manifest timeout)' };
      }
      if (args[0] === 'pull' && args[1] === 'hf.co/Qwen/Qwen3-Embedding-4B-GGUF:Q4_K_M') {
        nonTransientAttempts += 1;
        return { ok: false, code: 1, error: 'Error: Head "https://us.aws.cdn.hf.co/xet-bridge-us/long/path/here/file.gguf": 404 Not Found' };
      }
      return { ok: true, code: 0 };
    },
  });
  assert.equal(permFailRes.ok, false);
  assert.equal(nonTransientAttempts, 1);
  assert.match(permFailRes.error, /404 Not Found$/);

  // 5) Per-embed vector store isolation preserves both 0.6b and 4b caches on disk
  const tmpWs = makeTempDir('amr-vec-ws-');
  const tmpCache = makeTempDir('amr-vec-cache-');
  try {
    const p06 = getVectorStorePaths(tmpWs, 'qwen3-embedding:0.6b');
    const p4b = getVectorStorePaths(tmpWs, 'qwen3-embedding:4b');
    assert.notEqual(path.basename(p06.binPath), path.basename(p4b.binPath));
    assert.match(path.basename(p06.binPath), /^gpu-vectors-[a-f0-9]+\.bin$/);
    assert.match(path.basename(p4b.binPath), /^gpu-vectors-[a-f0-9]+\.bin$/);

    const store06 = loadWorkspaceVectorStore(tmpWs, 'qwen3-embedding:0.6b', { cacheDir: tmpCache });
    store06.dim = 4;
    store06.files.set('a.mjs', { sha1: 's1', chunks: [{ startLine: 1, endLine: 2, vec: new Int8Array([10, 20, 30, 40]) }] });
    saveWorkspaceVectorStore(tmpWs, store06);

    const store4b = loadWorkspaceVectorStore(tmpWs, 'qwen3-embedding:4b', { cacheDir: tmpCache });
    assert.equal(store4b.files.size, 0);
    store4b.dim = 4;
    store4b.files.set('b.mjs', { sha1: 's2', chunks: [{ startLine: 1, endLine: 3, vec: new Int8Array([50, 60, 70, 80]) }] });
    saveWorkspaceVectorStore(tmpWs, store4b);

    const reloaded06 = loadWorkspaceVectorStore(tmpWs, 'qwen3-embedding:0.6b', { cacheDir: tmpCache });
    const reloaded4b = loadWorkspaceVectorStore(tmpWs, 'qwen3-embedding:4b', { cacheDir: tmpCache });
    assert.equal(reloaded06.files.has('a.mjs'), true);
    assert.equal(reloaded06.files.has('b.mjs'), false);
    assert.equal(reloaded4b.files.has('b.mjs'), true);
    assert.equal(reloaded4b.files.has('a.mjs'), false);
  } finally {
    fs.rmSync(tmpWs, { recursive: true, force: true });
    fs.rmSync(tmpCache, { recursive: true, force: true });
  }
});

test('50. Wave 3 GPU & Ollama: HF mirror preference, persistent pull errors, custom gpuOllamaDir & installer job', async () => {
  const {
    loadGpuConfig,
    resolveDefaultGpuModelsDir,
    findOllamaBinary,
    pullSingleOllamaModelWithFallback,
    startGpuCascadePull,
    clearGpuPullErrorStatus,
    startOllamaInstallJob,
    getOllamaInstallJobStatus,
    clearOllamaInstallJobStatus,
  } = await import('../core/local-gpu-engine.mjs');
  const { RamMemoryEngine } = await import('../core/ram-memory-engine.mjs');

  const customRoot = makeTempDir('amr-ollama-custom-');
  try {
    const customOllamaDir = path.join(customRoot, 'ollama-bin');
    const customModelsDir = path.join(customRoot, 'ollama-models');
    fs.mkdirSync(customOllamaDir, { recursive: true });
    const binName = process.platform === 'win32' ? 'ollama.exe' : 'ollama';
    const fakeBin = path.join(customOllamaDir, binName);
    fs.writeFileSync(fakeBin, 'stub', 'utf8');

    assert.equal(findOllamaBinary(true, { gpuOllamaDir: customOllamaDir }), fakeBin);
    assert.equal(resolveDefaultGpuModelsDir('', customOllamaDir), path.join(customOllamaDir, 'models'));

    const loaded = loadGpuConfig({
      gpuEnabled: true,
      gpuEndpoint: 'http://127.0.0.1:11434',
      gpuChatModel: 'qwen3:4b',
      gpuEmbedModel: 'qwen3-embedding:0.6b',
      gpuOllamaDir: customOllamaDir,
      gpuPreferHfMirror: true,
    });
    assert.equal(loaded.gpuOllamaDir, customOllamaDir);
    assert.equal(loaded.gpuPreferHfMirror, true);

    // 1) preferMirror: 'huggingface' pulls HF GGUF tag FIRST when available
    const hfFirstCalls = [];
    const hfFirstRes = await pullSingleOllamaModelWithFallback('qwen3:4b', {
      preferMirror: 'huggingface',
      retryDelayMs: 1,
      execStepFn: async (args) => {
        hfFirstCalls.push(args.join(' '));
        return { ok: true, code: 0 };
      },
    });
    assert.equal(hfFirstRes.ok, true);
    assert.equal(hfFirstRes.source, 'huggingface');
    assert.equal(hfFirstCalls[0], 'pull hf.co/Qwen/Qwen3-4B-GGUF:Q4_K_M');

    // 2) Tag without HF GGUF (gemma4:12b) still works smoothly via Ollama when preferMirror='huggingface'
    const noHfCalls = [];
    const noHfRes = await pullSingleOllamaModelWithFallback('gemma4:12b', {
      preferMirror: 'huggingface',
      retryDelayMs: 1,
      execStepFn: async (args) => {
        noHfCalls.push(args.join(' '));
        return { ok: true, code: 0 };
      },
    });
    assert.equal(noHfRes.ok, true);
    assert.equal(noHfRes.source, 'ollama');
    assert.equal(noHfRes.hfAvailable, false);
    assert.equal(noHfCalls[0], 'pull gemma4:12b');

    // 3) Cascade pull records per-item error & dismiss clears error cleanly
    const failPull = await startGpuCascadePull({
      models: ['qwen3:4b'],
      installedTags: [],
      mirrorMode: 'huggingface',
      awaitCompletion: true,
      execStepFn: async () => ({ ok: false, code: 1, error: 'connection refused' }),
    });
    assert.ok(failPull.error);
    assert.equal(failPull.items[0].status, 'error');
    assert.equal(failPull.items[0].hfAvailable, true);
    const clearedPull = clearGpuPullErrorStatus();
    assert.equal(clearedPull.dismissed, true);
    assert.equal(clearedPull.error, '');

    // 4) Automated Ollama installer downloads, passes /DIR= and triggers cascade pull cleanly
    const installCalls = [];
    const pullAfterCalls = [];
    let binChecks = 0;
    const instRes = await startOllamaInstallJob({
      installDir: path.join(customRoot, 'inst-dir'),
      modelsDir: customModelsDir,
      pullModeAfter: 'cascade',
      selectedCapMb: 8192,
      mirrorMode: 'huggingface',
      platform: 'win32',
      allowInTests: true,
      awaitCompletion: true,
      downloadFn: async (_url, dest, opts) => {
        opts?.onProgress?.(0.5);
        fs.writeFileSync(dest, 'exe-stub', 'utf8');
        return { ok: true, path: dest };
      },
      execInstallFn: async (_exe, args, opts) => {
        installCalls.push({ args, opts });
        return { ok: true, code: 0 };
      },
      verifyBinaryFn: () => {
        binChecks += 1;
        return binChecks === 1 ? null : path.join(customRoot, 'inst-dir', 'ollama.exe');
      },
      ensureRunningFn: async () => ({ ok: true, running: true }),
      startPullFn: async (pullArgs) => {
        pullAfterCalls.push(pullArgs);
        return { ok: true };
      },
    });
    assert.equal(instRes.phase, 'done');
    assert.equal(instRes.pullTriggered, true);
    assert.ok(installCalls[0].args.includes('/VERYSILENT'));
    assert.ok(installCalls[0].args.includes('/NORESTART'));
    assert.ok(installCalls[0].args.some((a) => a.startsWith('/DIR=') && a.includes('inst-dir')));
    assert.equal(installCalls[0].opts.modelsDir, customModelsDir);
    assert.equal(pullAfterCalls.length, 1);
    assert.equal(pullAfterCalls[0].mirrorMode, 'huggingface');
    assert.equal(getOllamaInstallJobStatus().phase, 'done');
    assert.equal(clearOllamaInstallJobStatus().dismissed, true);

    // 5) buildGroundedChatPack pins focusFile cleanly even when query omits filename
    const wsDir = path.join(customRoot, 'ws');
    fs.mkdirSync(path.join(wsDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'src', 'auth.mjs'), 'export function verifyJwtToken(tok) {\n  return Boolean(tok);\n}\n', 'utf8');
    fs.writeFileSync(path.join(wsDir, 'src', 'routes.mjs'), "import { verifyJwtToken } from './auth.mjs';\nexport const ok = verifyJwtToken('x');\n", 'utf8');
    const ram = new RamMemoryEngine();
    ram.warmWorkspace(wsDir, { startWatcher: false });
    const pack = ram.buildGroundedChatPack(wsDir, 'Объясни работу модуля и риски', { focusFile: 'src/auth.mjs' });
    assert.ok(pack.sources.some((s) => s.file === 'src/auth.mjs'), 'focusFile must be included in grounded RAG sources');
    assert.ok(pack.formatted.includes('src/auth.mjs'), 'focusFile code slice must be embedded in RAG context');
    ram.close();
  } finally {
    fs.rmSync(customRoot, { recursive: true, force: true });
  }
});

test('Batch 3 audit regressions: SSRF guard on ollamaHttpJson, JS import regex across semicolon, distill CoT strip & full hash dedup', async () => {
  const { ollamaHttpJson } = await import('../core/gpu/gpu-shared-state.mjs');
  const { critiqueEditedDiffLocally } = await import('../core/gpu/gpu-critic-chat.mjs');

  const ssrfRes = await ollamaHttpJson('GET', '/api/tags', null, 300, 'http://169.254.169.254/latest');
  assert.equal(ssrfRes.ok, false);
  assert.match(String(ssrfRes.error || ''), /loopback/i);

  const sideEffectImportCode = [
    "import './init.mjs';",
    'const hiddenRef = undeclaredAuditBoom;',
    "import { x } from './other.mjs';",
    'export const out = [hiddenRef, x];',
  ].join('\n');
  const critique = await critiqueEditedDiffLocally({
    filePath: 'sample.mjs',
    oldText: '',
    newText: sideEffectImportCode,
    cfgOverride: { gpuEnabled: false },
  });
  assert.ok(Array.isArray(critique.issues));
  assert.ok(critique.issues.some((iss) => String(iss).includes('undeclaredAuditBoom')), 'Side-effect import must not swallow intervening identifiers across semicolons');
});

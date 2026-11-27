import { registerSuiteLifecycle } from './helpers/router-test-env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

registerSuiteLifecycle(test);

import {
  computeRecommendedCpuThreads,
  computeRecommendedRamBudgetMb,
  detectCpuAndRam,
} from '../core/hardware-profiler.mjs';
import {
  buildOllamaSpawnEnv,
  computeSafeNumCtx,
  critiqueEditedDiffLocally,
  defaultGpuTelemetry,
  distillText,
  evaluateGpuThermalAndLoadGuard,
  getGpuStatusSnapshot,
  getGpuTelemetry,
  loadGpuConfig,
  unloadModelsExceedingBudget,
  warmGgufModelsInHostRam,
} from '../core/local-gpu-engine.mjs';

test('1. Hardware Profiler: 64GB/32-core DDR5 workstation scaling + backward-compatible 8GB/16GB tiers', () => {
  // Backward-compatible 8GB / 4-core and 16GB / 12-core tiers
  const sys8 = detectCpuAndRam({
    cpusOverride: Array.from({ length: 4 }, () => ({ model: 'Intel Core i5' })),
    totalMemBytesOverride: 8 * 1024 ** 3,
  });
  assert.equal(sys8.recommendedRamBudgetMb, 1024);
  assert.equal(sys8.recommendedCpuThreads, 2);

  const sys16 = detectCpuAndRam({
    cpusOverride: Array.from({ length: 12 }, () => ({ model: 'AMD Ryzen 5 7600X' })),
    totalMemBytesOverride: 16 * 1024 ** 3,
  });
  assert.equal(sys16.recommendedRamBudgetMb, 4096);
  assert.equal(sys16.recommendedCpuThreads, 6);

  // High-RAM DDR5 workstations: 48GB, 64GB/32-thread (Ryzen 9 7950X), 128GB
  assert.equal(computeRecommendedRamBudgetMb(48 * 1024), 12288);
  assert.equal(computeRecommendedRamBudgetMb(128 * 1024), 24576);
  assert.equal(computeRecommendedCpuThreads(24), 16);

  const sys64 = detectCpuAndRam({
    cpusOverride: Array.from({ length: 32 }, () => ({ model: 'AMD Ryzen 9 7950X 16-Core Processor' })),
    totalMemBytesOverride: 64 * 1024 ** 3,
  });
  assert.equal(sys64.recommendedRamBudgetMb, 16384);
  assert.equal(sys64.recommendedCpuThreads, 24);
});

test('2. Ollama spawnEnv sets OLLAMA_NUM_PARALLEL=1 and defaultGpuTelemetry exposes synergy fields', () => {
  const cfg = loadGpuConfig({
    gpuEnabled: true,
    gpuEndpoint: 'http://127.0.0.1:11434',
    gpuChatModel: 'qwen3:4b',
    gpuEmbedModel: 'qwen3-embedding:0.6b',
  });
  assert.equal(cfg.gpuWarmHostRamCache, true);

  const env = buildOllamaSpawnEnv(cfg, '127.0.0.1:11434', {});
  assert.equal(env.OLLAMA_NUM_PARALLEL, '1');
  assert.equal(env.OLLAMA_FLASH_ATTENTION, '1');
  assert.equal(env.OLLAMA_KV_CACHE_TYPE, 'q8_0');

  const baseTel = defaultGpuTelemetry();
  assert.equal(baseTel.distillCacheHits, 0);
  assert.equal(typeof baseTel.distillCacheEntries, 'number');
  assert.equal(baseTel.hostRamWarmedMb, 0);
});

test('3. distillText exact SHA-256 and error_log SimHash RAM cache hits + critiqueEditedDiffLocally memoization', async () => {
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let chatCalls = 0;
  const mockTags = [
    { name: 'qwen3:4b', size: 2.5 * 1024 ** 3 },
    { name: 'qwen3-embedding:0.6b', size: 0.64 * 1024 ** 3 },
  ];
  const mockHttp = async (method, urlPath) => {
    if (method === 'GET' && urlPath === '/api/ps') return { ok: true, data: { models: [] } };
    if (method === 'GET' && urlPath === '/api/tags') return { ok: true, data: { models: mockTags } };
    if (method === 'POST' && urlPath === '/api/chat') {
      chatCalls++;
      return {
        ok: true,
        data: {
          message: { content: `- Root error at worker.mjs:88 (${nonce})` },
          prompt_eval_count: 120,
          eval_count: 24,
        },
      };
    }
    return { ok: false };
  };

  const baseStack = [
    `TypeError: Cannot read properties of undefined (reading 'payload') [${nonce}]`,
    '    at processQueueBatch (core/worker-pool.mjs:88:19)',
    '    at async runDispatcherLoop (core/dispatcher.mjs:214:7)',
    '    at async main (core/cli-entry.mjs:42:5)',
  ].join('\n');
  const repeatedTrace = Array.from({ length: 8 }, () => baseStack).join('\n');
  const log1 = `[2026-11-18T00:10:01.120Z] pid=4120 req=0xdeadbeef\n${repeatedTrace}\nnode_exit_code=1\n`;
  const logNearDup = `[2026-11-18T00:15:44.991Z] pid=8842 req=0xcafebabe\n${repeatedTrace}\nnode_exit_code=1\n`;
  const logDifferent = `SyntaxError: Unexpected token '}' in JSON at position 19 [${nonce}]\n`.repeat(12);

  const cfgOverride = {
    gpuEnabled: true,
    gpuEndpoint: 'http://127.0.0.1:11434',
    gpuMaxVramMb: 8192,
    gpuChatModel: 'qwen3:4b',
    gpuEmbedModel: 'qwen3-embedding:0.6b',
  };

  const telBefore = getGpuTelemetry();

  // First call: cache miss -> calls Ollama /api/chat once
  const r1 = await distillText({
    text: log1,
    mode: 'error_log',
    query: `root cause ${nonce}`,
    useDistillCache: true,
    cfgOverride,
    httpJsonFn: mockHttp,
    hwProbeFn: () => ({ available: true, vendor: 'nvidia', totalMb: 12288, freeMb: 10000 }),
  });
  assert.equal(r1.ok, true);
  assert.ok(!r1.fromRamCache);
  assert.equal(chatCalls, 1);

  // Second call (exact): RAM cache hit
  const r2 = await distillText({
    text: log1,
    mode: 'error_log',
    query: `root cause ${nonce}`,
    useDistillCache: true,
    cfgOverride,
    httpJsonFn: mockHttp,
    hwProbeFn: () => ({ available: true, vendor: 'nvidia', totalMb: 12288, freeMb: 10000 }),
  });
  assert.equal(r2.ok, true);
  assert.equal(r2.fromRamCache, true);
  assert.equal(r2.latencyMs, 0.2);
  assert.equal(chatCalls, 1);

  // Third call (near-duplicate error_log): SimHash RAM cache hit
  const r3 = await distillText({
    text: logNearDup,
    mode: 'error_log',
    query: `root cause ${nonce}`,
    useDistillCache: true,
    cfgOverride,
    httpJsonFn: mockHttp,
    hwProbeFn: () => ({ available: true, vendor: 'nvidia', totalMb: 12288, freeMb: 10000 }),
  });
  assert.equal(r3.ok, true);
  assert.equal(r3.fromRamCache, true);
  assert.equal(r3.latencyMs, 0.2);
  assert.equal(chatCalls, 1);

  // Fourth call (completely different error_log): must miss SimHash and hit Ollama
  const r4 = await distillText({
    text: logDifferent,
    mode: 'error_log',
    query: `root cause ${nonce}`,
    useDistillCache: true,
    cfgOverride,
    httpJsonFn: mockHttp,
    hwProbeFn: () => ({ available: true, vendor: 'nvidia', totalMb: 12288, freeMb: 10000 }),
  });
  assert.equal(r4.ok, true);
  assert.ok(!r4.fromRamCache);
  assert.equal(chatCalls, 2);

  // Telemetry updated on cache hits
  const telAfter = getGpuTelemetry();
  assert.ok(telAfter.distillCacheHits >= (telBefore.distillCacheHits || 0) + 2);
  assert.ok(telAfter.savedTokensEstimate > (telBefore.savedTokensEstimate || 0));
  assert.ok(telAfter.distillCacheEntries >= 2);

  // Critic cache memoization check
  let criticCalls = 0;
  const criticHttp = async () => {
    criticCalls++;
    return { ok: true, data: { message: { content: 'OK' } } };
  };
  const oldCode = `export function f_${nonce.replace(/[^a-z0-9]/gi, '')}() { return 1; }\n`;
  const newCode = `export function f_${nonce.replace(/[^a-z0-9]/gi, '')}(x) {\n  const val = String(x || '').trim();\n  return val.length;\n}\n`;
  const c1 = await critiqueEditedDiffLocally({
    filePath: `sample-${nonce}.mjs`,
    oldText: oldCode,
    newText: newCode,
    useDistillCache: true,
    cfgOverride,
    httpJsonFn: criticHttp,
  });
  assert.equal(c1.ok, true);
  assert.equal(criticCalls, 1);

  const c2 = await critiqueEditedDiffLocally({
    filePath: `sample-${nonce}.mjs`,
    oldText: oldCode,
    newText: newCode,
    useDistillCache: true,
    cfgOverride,
    httpJsonFn: criticHttp,
  });
  assert.equal(c2.ok, true);
  assert.equal(c2.fromRamCache, true);
  assert.equal(criticCalls, 1);
});

test('4. warmGgufModelsInHostRam skips under 20GB free RAM and warms blobs when >= 24GB free RAM', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-gguf-warm-'));
  try {
    const blobsDir = path.join(tmpDir, 'blobs');
    fs.mkdirSync(blobsDir, { recursive: true });
    // Create 2 GGUF-like blobs (>= 1024 bytes) and 1 small manifest blob (< 1024 bytes)
    fs.writeFileSync(path.join(blobsDir, 'sha256-model-a'), Buffer.alloc(64 * 1024, 0x41));
    fs.writeFileSync(path.join(blobsDir, 'sha256-model-b'), Buffer.alloc(128 * 1024, 0x42));
    fs.writeFileSync(path.join(blobsDir, 'sha256-tiny-config'), Buffer.alloc(256, 0x7b));

    const cfgOverride = {
      gpuEnabled: true,
      gpuWarmHostRamCache: true,
      gpuEndpoint: 'http://127.0.0.1:11434',
      gpuChatModel: 'qwen3:4b',
      gpuEmbedModel: 'qwen3-embedding:0.6b',
    };

    // Low free RAM (< 20480 MB) must skip safely
    const lowRamRes = await warmGgufModelsInHostRam({
      cfgOverride,
      freeRamMbOverride: 16384,
      modelsDirOverride: tmpDir,
      minBlobBytes: 1024,
      force: true,
    });
    assert.equal(lowRamRes.ok, false);
    assert.equal(lowRamRes.skippedReason, 'low_free_ram');
    assert.equal(lowRamRes.freeRamMb, 16384);

    // High free RAM (>= 24 GB) must stream both >=1KB blobs and update hostRamWarmedMb
    const warmRes = await warmGgufModelsInHostRam({
      cfgOverride,
      freeRamMbOverride: 24576,
      modelsDirOverride: tmpDir,
      minBlobBytes: 1024,
      chunkBytes: 16 * 1024,
      force: true,
    });
    assert.equal(warmRes.ok, true);
    assert.equal(warmRes.blobsWarmed, 2);
    assert.ok(warmRes.warmedMb > 0);
    assert.equal(typeof warmRes.elapsedMs, 'number');

    // Immediate second call without force must respect 30m cooldown
    const cooldownRes = await warmGgufModelsInHostRam({
      cfgOverride,
      freeRamMbOverride: 24576,
      modelsDirOverride: tmpDir,
      minBlobBytes: 1024,
    });
    assert.equal(cooldownRes.ok, false);
    assert.equal(cooldownRes.skippedReason, 'cooldown');

    const tel = getGpuTelemetry();
    assert.equal(tel.hostRamWarmedMb, warmRes.warmedMb);

    // Manifest-first prioritization: active chat/embed models (even older mtime) must warm before newer unrelated blobs
    const prioDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-gguf-prio-'));
    try {
      const pBlobs = path.join(prioDir, 'blobs');
      const pManV2 = path.join(prioDir, 'manifests-v2', 'ollama.com', 'library');
      const pManV1 = path.join(prioDir, 'manifests', 'registry.ollama.ai', 'library');
      fs.mkdirSync(pBlobs, { recursive: true });
      fs.mkdirSync(path.join(pManV2, 'gemma4'), { recursive: true });
      fs.mkdirSync(path.join(pManV1, 'qwen3-embedding'), { recursive: true });

      const chatBlob = path.join(pBlobs, 'sha256-chat-main');
      const chatListBlob = path.join(pBlobs, 'sha256-chat-list');
      const embedBlob = path.join(pBlobs, 'sha256-embed-main');
      const otherNewerBlob = path.join(pBlobs, 'sha256-other-newer');

      fs.writeFileSync(chatBlob, Buffer.alloc(64 * 1024, 0x11));
      fs.writeFileSync(embedBlob, Buffer.alloc(64 * 1024, 0x22));
      fs.writeFileSync(otherNewerBlob, Buffer.alloc(64 * 1024, 0x33));
      fs.writeFileSync(
        chatListBlob,
        JSON.stringify({ layers: [{ digest: 'sha256:chat-main', mediaType: 'application/vnd.ollama.image.model' }] })
      );
      fs.writeFileSync(
        path.join(pManV2, 'gemma4', '12b'),
        JSON.stringify({
          mediaType: 'application/vnd.ollama.manifest.list.v2+json',
          manifests: [{ digest: 'sha256:chat-list', format: 'gguf', runner: 'llamacpp' }],
        })
      );
      fs.writeFileSync(
        path.join(pManV1, 'qwen3-embedding', '4b'),
        JSON.stringify({ layers: [{ digest: 'sha256:embed-main', mediaType: 'application/vnd.ollama.image.model' }] })
      );

      // Make unrelated blob significantly newer than chat & embed blobs
      const oldTime = new Date(Date.now() - 86_400_000);
      const newTime = new Date(Date.now());
      fs.utimesSync(chatBlob, oldTime, oldTime);
      fs.utimesSync(embedBlob, oldTime, oldTime);
      fs.utimesSync(otherNewerBlob, newTime, newTime);

      const prioRes = await warmGgufModelsInHostRam({
        cfgOverride: {
          gpuEnabled: true,
          gpuWarmHostRamCache: true,
          gpuEndpoint: 'http://127.0.0.1:11434',
          gpuChatModel: 'gemma4:12b',
          gpuEmbedModel: 'qwen3-embedding:4b',
        },
        freeRamMbOverride: 24576,
        modelsDirOverride: prioDir,
        minBlobBytes: 1024,
        maxBytesToWarm: 128 * 1024,
        chunkBytes: 16 * 1024,
        force: true,
      });
      assert.equal(prioRes.ok, true);
      assert.deepEqual(prioRes.warmedFiles, ['sha256-chat-main', 'sha256-embed-main']);
    } finally {
      fs.rmSync(prioDir, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('5. getGpuStatusSnapshot exposes distillCacheHits, distillCacheEntries, and hostRamWarmedMb in telemetry + UI contract', async () => {
  const snap = await getGpuStatusSnapshot();
  assert.ok(snap && snap.telemetry);
  assert.equal(typeof snap.telemetry.distillCacheHits, 'number');
  assert.equal(typeof snap.telemetry.distillCacheEntries, 'number');
  assert.equal(typeof snap.telemetry.hostRamWarmedMb, 'number');

  const uiHtml = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'sidecars', 'panel', 'ui.html'), 'utf8');
  assert.match(uiHtml, /function formatHostRamWarmedLabel/);
  assert.match(uiHtml, /DDR5 GGUF:/);
  assert.match(uiHtml, /в DDR5 ОЗУ:/);
});

test('6. Live GPU thermal/external-load guard, exported VRAM helpers, MCP actions & UI live sensors', async () => {
  // 1) Normal state passes guard
  const okGuard = evaluateGpuThermalAndLoadGuard(
    { available: true, tempC: 62, utilPct: 35 },
    { isBackground: true, liveActivity: { inFlightCount: 0 } }
  );
  assert.equal(okGuard.ok, true);
  assert.equal(okGuard.throttled, false);

  // 2) Thermal throttle triggers at >= 84C even for foreground work
  const hotGuard = evaluateGpuThermalAndLoadGuard(
    { available: true, tempC: 86, utilPct: 40 },
    { isBackground: false, liveActivity: { inFlightCount: 0 } }
  );
  assert.equal(hotGuard.ok, false);
  assert.equal(hotGuard.throttled, true);
  assert.equal(hotGuard.reason, 'thermal_throttle');

  // 3) External GPU load >= 90% defers background indexing only when our own GPU is idle
  const extBusyBg = evaluateGpuThermalAndLoadGuard(
    { available: true, tempC: 70, utilPct: 95 },
    { isBackground: true, liveActivity: { inFlightCount: 0 } }
  );
  assert.equal(extBusyBg.ok, false);
  assert.equal(extBusyBg.throttled, true);
  assert.equal(extBusyBg.reason, 'external_gpu_busy');

  const ourOwnBusyBg = evaluateGpuThermalAndLoadGuard(
    { available: true, tempC: 70, utilPct: 95 },
    { isBackground: true, liveActivity: { inFlightCount: 1 } }
  );
  assert.equal(ourOwnBusyBg.ok, true);
  assert.equal(ourOwnBusyBg.throttled, false);

  // 4) distillText pauses on thermal throttle with 0 Ollama HTTP calls
  let httpCalls = 0;
  const hotDistill = await distillText({
    text: `unique thermal test log ${Date.now()}`,
    mode: 'error_log',
    cfgOverride: {
      gpuEnabled: true,
      gpuEndpoint: 'http://127.0.0.1:11434',
      gpuChatModel: 'qwen3:4b',
      gpuEmbedModel: 'qwen3-embedding:0.6b',
      gpuMaxVramMb: 8192,
    },
    httpJsonFn: async () => {
      httpCalls++;
      return { ok: true, data: {} };
    },
    hwProbeFn: () => ({ available: true, vendor: 'nvidia', totalMb: 12288, freeMb: 9000, tempC: 88, utilPct: 50 }),
    _bypassCache: true,
  });
  assert.equal(hotDistill.ok, false);
  assert.equal(hotDistill.skippedThermalGuard, true);
  assert.equal(hotDistill.thermalReason, 'thermal_throttle');
  assert.equal(httpCalls, 0);

  // 5) Exported computeSafeNumCtx & unloadModelsExceedingBudget work directly
  const numCtx = computeSafeNumCtx(
    { gpuMaxVramMb: 12288, gpuContextTokens: 12288 },
    { available: true, vendor: 'nvidia', freeMb: 10500, totalMb: 12288 },
    [],
    4000
  );
  assert.equal(numCtx, 8192);
  assert.equal(typeof unloadModelsExceedingBudget, 'function');

  // 6) Snapshot exposes thermalGuard, MCP gpu_status exposes enforce_cap & warm_host_ram, UI shows utilPct/tempC
  const snap = await getGpuStatusSnapshot();
  assert.ok(snap && snap.thermalGuard && typeof snap.thermalGuard.throttled === 'boolean');

  const rootDir = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
  const mcpCode = fs.readFileSync(path.join(rootDir, 'core', 'ram-memory-mcp.mjs'), 'utf8');
  assert.match(mcpCode, /'enforce_cap'/);
  assert.match(mcpCode, /'warm_host_ram'/);

  const uiHtml = fs.readFileSync(path.join(rootDir, 'sidecars', 'panel', 'ui.html'), 'utf8');
  assert.match(uiHtml, /gpu\.hardware\.utilPct/);
  assert.match(uiHtml, /gpu\.thermalGuard/);
  assert.match(uiHtml, /Ядро: ' \+ liveUtilPct/);
});

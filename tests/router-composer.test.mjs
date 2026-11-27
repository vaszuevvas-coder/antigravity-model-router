import { ROOT_DIR, makeTempDir, registerSuiteLifecycle } from './helpers/router-test-env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {
  COLLAPSIBLE_PANEL_CARD_IDS,
  DEFAULT_CHAT_QUEUE_MAX_SIZE,
  DEFAULT_PANEL_BLOCK_ORDER,
  Queue,
  buildSmartContinuationChips,
  computeFastRamAutocomplete,
  dispatchChatMessageFromSidecar,
  extractConversationIdFromAgentApiOutput,
  invalidateAutocompleteContextCache,
  normalizeWorkspaceUriKey,
  prioritizeContextForDraft,
  resolveProjectIdForWorkspace,
  sanitizeStatePatch,
} from '../sidecars/panel/server.mjs';
import { RamMemoryEngine } from '../core/ram-memory-engine.mjs';
import { atomicWriteJsonSync, withFileLockSync } from '../core/safe-json.mjs';
import {
  auditLocalChatAnswerGrounding,
  buildOllamaSpawnOpts,
  classifySkillWithLlm,
  critiqueEditedDiffLocally,
  distillText,
  generatePromptContinuation,
  isAssistantAnswerContinuation,
  isCompletedSentenceDraft,
  isLocalChatActive,
  pullSingleOllamaModelWithFallback,
  runLocalProjectChat,
  sanitizeGhostContinuation,
  verifyChatClaimsLocally,
  verifyGhostContinuationGrounding,
} from '../core/local-gpu-engine.mjs';
import { isEphemeralTestWorkspace } from '../core/session-handoff.mjs';
import { handlePreInvocation } from '../core/hook-runner.mjs';
import { shutdownCpuPool } from '../core/cpu-worker-pool.mjs';
import { dispatchIpcRoute } from '../core/ram-memory-mcp.mjs';

registerSuiteLifecycle(test, { cleanupFns: [shutdownCpuPool] });

test('Smart Composer (Ghost Text): two-stage RAM+GPU continuation, overlap sanitizer, abort guard & UI invariants', async () => {
  // 1) sanitizeGhostContinuation edge cases
  assert.equal(
    sanitizeGhostContinuation('Проверь изменения в ', 'Проверь изменения в server.mjs'),
    'server.mjs'
  );
  assert.equal(
    sanitizeGhostContinuation('проверь файл ', 'файл server.mjs на ошибки'),
    'server.mjs на ошибки'
  );
  assert.equal(
    sanitizeGhostContinuation('открой sidecars/panel/ui.', 'ui.html'),
    'html'
  );
  assert.equal(
    sanitizeGhostContinuation('найди', 'диффы'),
    ' диффы'
  );
  assert.equal(
    sanitizeGhostContinuation('Оптимизируй ', '<think>internal reasoning</think>\n"работу кэша в RAM..."'),
    'работу кэша в RAM'
  );
  assert.equal(sanitizeGhostContinuation('Проверь файл', 'Проверь файл'), '');

  // 1b) Anti-self-answer guard & single-sentence cap (prevents Smart Composer answering user's question)
  const userQuestion = 'А мы можем как-то улучшить умный чат и добавить поддержку контекста?';
  assert.equal(isCompletedSentenceDraft(userQuestion), true);
  assert.equal(isCompletedSentenceDraft('Проверь работу в чате.'), true);
  assert.equal(isCompletedSentenceDraft('Проверь изменения в server.mjs.'), true);
  assert.equal(isCompletedSentenceDraft('открой sidecars/panel/ui.'), false);
  assert.equal(isCompletedSentenceDraft('версия v3.22.'), false);
  assert.equal(isCompletedSentenceDraft('например т.е.'), false);

  assert.equal(
    isAssistantAnswerContinuation(userQuestion, 'Да, это можно реализовать через систему кэширования сессий.'),
    true
  );
  assert.equal(
    sanitizeGhostContinuation(userQuestion, 'Да, это можно реализовать через систему кэширования сессий.'),
    ''
  );
  assert.equal(
    sanitizeGhostContinuation(userQuestion, 'Конечно, для этого достаточно передавать историю диалога.'),
    ''
  );
  assert.equal(
    sanitizeGhostContinuation(userQuestion, 'Это можно реализовать через хранение истории в RAM.'),
    ''
  );
  assert.equal(
    sanitizeGhostContinuation(userQuestion, 'Для этого нужно обновить generatePromptContinuation.'),
    ''
  );
  assert.equal(
    sanitizeGhostContinuation(userQuestion, 'Мы можем подключить передачу истории из session-handoff.'),
    ''
  );
  assert.equal(
    sanitizeGhostContinuation(userQuestion, 'Я могу добавить поддержку контекста в server.mjs.'),
    ''
  );
  // Valid user-voice second sentence after '?' / '.' MUST still be allowed!
  assert.equal(
    sanitizeGhostContinuation(userQuestion, 'Например, учитывать открытые файлы и последние сообщения.'),
    ' Например, учитывать открытые файлы и последние сообщения.'
  );
  assert.equal(
    sanitizeGhostContinuation('Проверь работу умного чата.', 'Желательно без лишнего расхода видеопамяти.'),
    ' Желательно без лишнего расхода видеопамяти.'
  );
  // Single-pass 2-sentence output: keeps question ending, drops assistant answer in sentence #2
  assert.equal(
    sanitizeGhostContinuation(
      'А мы можем как-то улучшить умный чат',
      'и добавить поддержку контекста? Да, это можно реализовать через систему кэширования сессий.'
    ),
    ' и добавить поддержку контекста?'
  );
  // Legitimate word/conjunction continuations with 'да' must NOT be false-positived
  assert.equal(sanitizeGhostContinuation('Проверь да', 'данные в кэше'), 'нные в кэше');
  assert.equal(sanitizeGhostContinuation('Проверь кэш ', 'да и прогони тесты'), 'да и прогони тесты');
  assert.equal(sanitizeGhostContinuation('открой sidecars/panel/ui.', 'html'), 'html');

  // 2) generatePromptContinuation with mock HTTP Ollama server + LRU cache + AbortController
  const mockTags = [{ name: 'gemma4:12b', size: 8.5 * 1024 ** 3 }];
  const hw16gb = { available: true, totalMb: 16384, freeMb: 14000, name: 'RTX 4070 Ti SUPER' };
  let chatCalls = 0;
  let sawThinkFalse = false;
  const nonceDraft = `Проверь кэш ${Date.now()} в `;

  const res1 = await generatePromptContinuation({
    draft: nonceDraft,
    touchedFiles: ['core/local-gpu-engine.mjs'],
    symbolHints: ['distillText'],
    recentGoals: ['Ускорить кэш'],
    cfgOverride: {
      gpuEnabled: true,
      gpuMaxVramMb: 16384,
      gpuChatModel: 'gemma4:12b',
      gpuEmbedModel: 'qwen3-embedding:0.6b',
      gpuEndpoint: 'http://127.0.0.1:11434',
    },
    hwProbeFn: () => hw16gb,
    httpJsonFn: async (method, urlPath, body) => {
      if (method === 'GET' && urlPath === '/api/ps') return { ok: true, data: { models: [] } };
      if (method === 'GET' && urlPath === '/api/tags') return { ok: true, data: { models: mockTags } };
      if (method === 'POST' && urlPath === '/api/chat') {
        chatCalls += 1;
        sawThinkFalse = body?.think === false;
        return {
          ok: true,
          data: { message: { content: 'local-gpu-engine.mjs на утечки памяти' } },
        };
      }
      return { ok: false };
    },
  });
  assert.equal(res1.ok, true);
  assert.equal(sawThinkFalse, true);
  assert.equal(res1.continuation, 'local-gpu-engine.mjs на утечки памяти');
  assert.equal(chatCalls, 1);

  const res2 = await generatePromptContinuation({
    draft: nonceDraft,
    touchedFiles: ['core/local-gpu-engine.mjs'],
    cfgOverride: {
      gpuEnabled: true,
      gpuMaxVramMb: 16384,
      gpuChatModel: 'gemma4:12b',
      gpuEmbedModel: 'qwen3-embedding:0.6b',
      gpuEndpoint: 'http://127.0.0.1:11434',
    },
    hwProbeFn: () => hw16gb,
    httpJsonFn: async () => {
      chatCalls += 1;
      return { ok: true, data: { message: { content: 'should come from cache' } } };
    },
  });
  assert.equal(res2.ok, true);
  assert.equal(res2.fromRamCache, true);
  assert.equal(res2.continuation, 'local-gpu-engine.mjs на утечки памяти');
  assert.equal(chatCalls, 1);

  const ac = new AbortController();
  ac.abort();
  const abortedRes = await generatePromptContinuation({
    draft: 'Проверь другой текст',
    signal: ac.signal,
    cfgOverride: { gpuEnabled: true, gpuMaxVramMb: 16384, gpuChatModel: 'gemma4:12b' },
    httpJsonFn: async () => ({ ok: true, data: {} }),
  });
  assert.equal(abortedRes.ok, false);
  assert.equal(abortedRes.aborted, true);

  // 2b) Closed-World Silence on completed sentence by default + opt-in post-question corrective retry
  let defaultCompletedChatCalls = 0;
  const silentCompletedRes = await generatePromptContinuation({
    draft: `А мы можем улучшить умный чат ${Date.now()}?`,
    touchedFiles: ['sidecars/panel/server.mjs'],
    cfgOverride: { gpuEnabled: true, gpuMaxVramMb: 16384, gpuChatModel: 'gemma4:12b' },
    hwProbeFn: () => hw16gb,
    httpJsonFn: async () => {
      defaultCompletedChatCalls += 1;
      return { ok: true, data: {} };
    },
  });
  assert.equal(silentCompletedRes.ok, false);
  assert.equal(silentCompletedRes.abstainedCompletedSentence, true);
  assert.equal(silentCompletedRes.continuation, '');
  assert.equal(defaultCompletedChatCalls, 0, 'Must NOT call Ollama when sentence is already completed');

  let retryAttempt = 0;
  let sawCompletedSentencePrompt = false;
  const retryRes = await generatePromptContinuation({
    draft: `А мы можем улучшить умный чат ${Date.now()}?`,
    touchedFiles: ['sidecars/panel/server.mjs'],
    allowFollowUpSentence: true,
    cfgOverride: {
      gpuEnabled: true,
      gpuMaxVramMb: 16384,
      gpuChatModel: 'gemma4:12b',
      gpuEmbedModel: 'qwen3-embedding:0.6b',
      gpuEndpoint: 'http://127.0.0.1:11434',
    },
    hwProbeFn: () => hw16gb,
    httpJsonFn: async (method, urlPath, body) => {
      if (method === 'GET' && urlPath === '/api/ps') return { ok: true, data: { models: [{ name: 'gemma4:12b' }] } };
      if (method === 'GET' && urlPath === '/api/tags') return { ok: true, data: { models: mockTags } };
      if (method === 'POST' && urlPath === '/api/chat') {
        retryAttempt += 1;
        const firstUserMsg = body?.messages?.[1]?.content || '';
        if (firstUserMsg.includes('COMPLETED_FIRST_SENTENCE:')) {
          sawCompletedSentencePrompt = true;
        }
        if (retryAttempt === 1) {
          return {
            ok: true,
            data: { message: { content: 'Да, это можно реализовать через систему кэширования сессий.' } },
          };
        }
        return {
          ok: true,
          data: { message: { content: 'Например, учитывать открытые файлы и историю запросов.' } },
        };
      }
      return { ok: false };
    },
  });
  assert.equal(sawCompletedSentencePrompt, true);
  assert.equal(retryAttempt, 2);
  assert.equal(retryRes.ok, true);
  assert.equal(retryRes.continuation, ' Например, учитывать открытые файлы и историю запросов.');

  // 2c) Richer continuations (>96 chars up to 200 chars) + CHAT_CONTEXT injection + maxOutputTokens
  const richContinuation =
    ' с сохранением обратной совместимости контрактов, валидацией входных параметров и отдельными тестами для всех граничных случаев';
  assert.ok(richContinuation.length > 100 && richContinuation.length < 180);
  assert.equal(sanitizeGhostContinuation('Обнови обработчик', richContinuation), richContinuation);
  const longText = `${richContinuation}, а также дополнительным логированием ошибок, кэшированием результатов, строгой проверкой типов и подробной документацией для всех публичных методов модуля`;
  const cappedLong = sanitizeGhostContinuation('Обнови обработчик', longText);
  assert.ok(cappedLong.length <= 200 && cappedLong.length > 96);

  let sawChatContextLine = false;
  let sawLargerPredict = false;
  const ctxRes = await generatePromptContinuation({
    draft: `Продолжи логику в ${Date.now()}`,
    recentMessages: [
      { role: 'user', content: 'Разбери автокомплит в 06-smart-composer.js' },
      { role: 'assistant', content: 'Нужно увеличить бюджет токенов и убрать лишний пробел после Tab.' },
    ],
    allowFollowUpSentence: true,
    maxOutputTokens: 56,
    cfgOverride: {
      gpuEnabled: true,
      gpuMaxVramMb: 16384,
      gpuChatModel: 'gemma4:12b',
      gpuEmbedModel: 'qwen3-embedding:0.6b',
      gpuEndpoint: 'http://127.0.0.1:11434',
    },
    hwProbeFn: () => hw16gb,
    httpJsonFn: async (method, urlPath, body) => {
      if (method === 'GET' && urlPath === '/api/ps') return { ok: true, data: { models: [{ name: 'gemma4:12b' }] } };
      if (method === 'GET' && urlPath === '/api/tags') return { ok: true, data: { models: mockTags } };
      if (method === 'POST' && urlPath === '/api/chat') {
        const userMsg = body?.messages?.[1]?.content || '';
        if (userMsg.includes('CHAT_CONTEXT:')) sawChatContextLine = true;
        if (Number(body?.options?.num_predict) === 56) sawLargerPredict = true;
        return {
          ok: true,
          data: { message: { content: 'с учётом уже обсуждённых правок и проверкой всех контрактов.' } },
        };
      }
      return { ok: false };
    },
  });
  assert.equal(sawChatContextLine, true);
  assert.equal(sawLargerPredict, true);
  assert.equal(ctxRes.ok, true);

  // 3) computeFastRamAutocomplete & buildSmartContinuationChips (Pure Factual Closed-World Stage-1)
  const slashRes = computeFastRamAutocomplete('/pl', {});
  assert.equal(slashRes.source, 'ram');
  assert.ok(slashRes.continuation.startsWith('an — '), `Expected /plan continuation, got: ${slashRes.continuation}`);

  const fileMatchRes = computeFastRamAutocomplete('Проверь ui.ht', {
    touchedFiles: ['sidecars/panel/ui.html'],
    repoFiles: ['core/hook-runner.mjs'],
    symbols: ['generatePromptContinuation'],
  });
  assert.equal(fileMatchRes.source, 'ram');
  assert.equal(fileMatchRes.continuation, 'ml');

  const noClicheStemRes = computeFastRamAutocomplete('Проверь ', {
    touchedFiles: ['sidecars/panel/server.mjs'],
  });
  assert.equal(noClicheStemRes.source, 'none');
  assert.equal(noClicheStemRes.continuation, '');

  const prepTargetRes = computeFastRamAutocomplete('Проверь изменения в ', {
    touchedFiles: ['sidecars/panel/server.mjs'],
  });
  assert.equal(prepTargetRes.source, 'ram');
  assert.equal(prepTargetRes.continuation, 'sidecars/panel/server.mjs');

  const chips = buildSmartContinuationChips({
    workspaceName: 'antigravity-model-router',
    touchedFiles: ['sidecars/panel/ui.html'],
    recentGoals: ['Добавить Smart Composer'],
  });
  assert.equal(chips.length, 3);
  assert.match(chips[0].label, /ui\.html/);
  assert.match(chips[0].prompt, /sidecars\/panel\/ui\.html/);

  // 4) Server block order migration & UI HTML invariants
  const idxWrap = DEFAULT_PANEL_BLOCK_ORDER.indexOf('agLiveProgressWrap');
  const idxComposer = DEFAULT_PANEL_BLOCK_ORDER.indexOf('smartComposerCard');
  assert.ok(idxWrap >= 0 && idxComposer === idxWrap + 1, 'smartComposerCard must immediately follow agLiveProgressWrap');
  assert.equal(COLLAPSIBLE_PANEL_CARD_IDS.size, 0);

  const migratedPatch = sanitizeStatePatch({
    panelBlockOrder: ['smartProjectBanner', 'agLiveProgressWrap', 'skillsSectionCard'],
  });
  assert.equal(migratedPatch.panelBlockOrder.includes('smartProjectBanner'), false);
  assert.equal(migratedPatch.panelBlockOrder[0], 'agLiveProgressWrap');
  assert.equal(migratedPatch.panelBlockOrder[1], 'smartComposerCard');
  assert.equal(migratedPatch.panelBlockOrder[2], 'skillsSectionCard');

  const uiHtml = fs.readFileSync(path.join(ROOT_DIR, 'sidecars', 'panel', 'ui.html'), 'utf8');
  assert.ok(uiHtml.includes('id="smartComposerCard"'), 'ui.html must render #smartComposerCard');
  assert.ok(uiHtml.includes('id="smartComposerInput"'), 'ui.html must render #smartComposerInput');
  assert.ok(uiHtml.includes('id="composerMirrorGhost"'), 'ui.html must render #composerMirrorGhost');
  assert.match(uiHtml, /\.composer-textarea\s*\{[\s\S]*?user-select:\s*text;/);
  assert.match(uiHtml, /\.composer-well\s*\{/);
  assert.equal(/\bon(?:click|change|input|keydown|keyup)\s*=/i.test(uiHtml), false, 'ui.html must stay 100% CSP clean');

  const serverSrc = fs.readFileSync(path.join(ROOT_DIR, 'sidecars', 'panel', 'server.mjs'), 'utf8');
  assert.match(serverSrc, /app\.api\('\/api\/autocomplete'/);
  assert.match(serverSrc, /app\.api\('\/api\/chat-send'/);

  const scriptMatch = /<script>([\s\S]*?)<\/script>/i.exec(uiHtml);
  assert.ok(scriptMatch && scriptMatch[1]);
  assert.doesNotThrow(() => new vm.Script(scriptMatch[1], { filename: 'sidecars/panel/ui.html' }));

  // 5) Regression: Windows headless spawn flags (`detached: false, windowsHide: true`), Gemma 4 <|thought|> strip,
  //    live free-VRAM fallback (7.6 GB free -> qwen3:4b instead of cold gemma4:12b), HTTP /api/pull & AbortSignal IPC guard
  const winSpawnOpts = buildOllamaSpawnOpts({ OLLAMA_HOST: '127.0.0.1:11434' }, 'win32');
  assert.equal(winSpawnOpts.detached, false, 'win32 must NOT set detached:true (DETACHED_PROCESS overrides CREATE_NO_WINDOW)');
  assert.equal(winSpawnOpts.windowsHide, true);
  assert.equal(winSpawnOpts.stdio, 'ignore');

  const linuxSpawnOpts = buildOllamaSpawnOpts({ OLLAMA_HOST: '127.0.0.1:11434' }, 'linux');
  assert.equal(linuxSpawnOpts.detached, true);
  assert.equal(linuxSpawnOpts.windowsHide, true);

  assert.equal(
    sanitizeGhostContinuation('Умный чат перестал ', '<|thought|>\nUser is describing an autocomplete bug.\n<|thought|>\nпредлагать продолжение текста'),
    'предлагать продолжение текста'
  );

  let selectedLiveModel = '';
  let sawNewlineStop = false;
  const liveFitRes = await generatePromptContinuation({
    draft: `Умный чат перестал ${Date.now()} `,
    touchedFiles: ['sidecars/panel/ui.html'],
    cfgOverride: {
      gpuEnabled: true,
      gpuMaxVramMb: 16384,
      gpuChatModel: 'gemma4:12b',
      gpuEmbedModel: 'qwen3-embedding:4b',
      gpuEndpoint: 'http://127.0.0.1:11434',
    },
    hwProbeFn: () => ({
      available: true,
      vendor: 'nvidia',
      vramReliable: true,
      totalMb: 16376,
      usedMb: 8449,
      freeMb: 7613,
      name: 'NVIDIA GeForce RTX 4070 Ti SUPER',
    }),
    httpJsonFn: async (method, urlPath, body) => {
      if (method === 'GET' && urlPath === '/api/ps') {
        return {
          ok: true,
          data: { models: [{ name: 'qwen3-embedding:4b', size: 3154368265, size_vram: 3154368265 }] },
        };
      }
      if (method === 'GET' && urlPath === '/api/tags') {
        return {
          ok: true,
          data: {
            models: [
              { name: 'gemma4:12b', size: 8021618941 },
              { name: 'qwen3:4b', size: 2497294275 },
              { name: 'qwen3-embedding:4b', size: 2496705826 },
            ],
          },
        };
      }
      if (method === 'POST' && urlPath === '/api/chat') {
        selectedLiveModel = body?.model || '';
        sawNewlineStop = Array.isArray(body?.options?.stop) && body.options.stop.includes('\n');
        return {
          ok: true,
          data: { message: { content: '\nпредлагать продолжение текста при вводе' } },
        };
      }
      return { ok: false };
    },
  });
  assert.equal(liveFitRes.ok, true);
  assert.equal(selectedLiveModel, 'qwen3:4b', 'Must pick fitting installed qwen3:4b when cold gemma4:12b exceeds live freeMb');
  assert.equal(sawNewlineStop, false, 'Must not include single \\n in stop tokens (prevents empty generation on leading newline)');
  assert.equal(liveFitRes.continuation, 'предлагать продолжение текста при вводе');

  // Verify ui.html panelFetch strips non-cloneable AbortSignal before window.sidecar.fetch
  assert.match(uiHtml, /delete\s+opts\.signal/);

  // Verify HTTP /api/pull streaming downloads without spawning CLI subprocesses
  const pullEvents = [];
  const mockPullServer = http.createServer((req, res) => {
    let reqBody = '';
    req.on('data', (c) => { reqBody += c; });
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/api/tags') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ models: [] }));
        return;
      }
      if (req.method === 'POST' && req.url === '/api/pull') {
        const parsed = JSON.parse(reqBody || '{}');
        pullEvents.push(`pull:${parsed.model}`);
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.write(JSON.stringify({ status: 'pulling manifest' }) + '\n');
        res.write(JSON.stringify({ status: 'downloading', completed: 50, total: 100 }) + '\n');
        res.write(JSON.stringify({ status: 'success', completed: 100, total: 100 }) + '\n');
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise((r) => mockPullServer.listen(0, '127.0.0.1', r));
  try {
    const port = mockPullServer.address().port;
    const progressPcts = [];
    const httpPullRes = await pullSingleOllamaModelWithFallback('qwen3:4b', {
      cfg: {
        gpuEnabled: true,
        gpuAutoStart: false,
        gpuEndpoint: `http://127.0.0.1:${port}`,
      },
      onProgress: ({ percent }) => { progressPcts.push(percent); },
    });
    assert.equal(httpPullRes.ok, true);
    assert.equal(httpPullRes.source, 'ollama');
    assert.deepEqual(pullEvents, ['pull:qwen3:4b']);
    assert.ok(progressPcts.includes(50) && progressPcts.includes(100));
  } finally {
    await new Promise((r) => mockPullServer.close(r));
  }

  // 6) Directory-scoped context (`sidecars/*`), `peekCascadeAlert` chip/RAM sync, Cyrillic-after-dot spacing & AV-clean launch
  assert.equal(
    isCompletedSentenceDraft('Добавь поддержку контекста из файлов sidecars.'),
    true,
    'Russian sentence ending with English folder noun + dot must be treated as completed sentence'
  );
  assert.equal(
    sanitizeGhostContinuation(
      'Добавь поддержку контекста из файлов sidecars.',
      'используя функции из sidecars/panel/server.mjs'
    ),
    ' используя функции из sidecars/panel/server.mjs',
    'Must insert space after dot before Cyrillic continuation (never glue "sidecars.используя")'
  );

  const scoped = prioritizeContextForDraft('Добавь поддержку контекста из файлов sidecars', {
    touchedFiles: ['core/hook-runner.mjs'],
    repoFiles: ['core/local-gpu-engine.mjs', 'sidecars/panel/server.mjs', 'sidecars/panel/ui.html'],
    symbols: ['handlePreInvocation', 'distillText'],
    symbolsByFile: {
      'sidecars/panel/server.mjs': ['Queue', 'computeFastRamAutocomplete', 'prioritizeContextForDraft'],
      'core/local-gpu-engine.mjs': ['distillText'],
    },
  });
  assert.equal(scoped.touchedFiles[0], 'sidecars/panel/server.mjs');
  assert.equal(scoped.symbols[0], 'Queue');
  assert.ok(scoped.matchedDirs.includes('sidecars'));

  const dirPathSuggest = computeFastRamAutocomplete('Добавь поддержку контекста из файлов sidecars', {
    touchedFiles: ['core/hook-runner.mjs'],
    repoFiles: ['sidecars/panel/server.mjs'],
    symbols: ['distillText'],
    symbolsByFile: {
      'sidecars/panel/server.mjs': ['Queue'],
    },
  });
  assert.equal(dirPathSuggest.source, 'ram');
  assert.match(dirPathSuggest.continuation, /^\/panel\/server\.mjs/);

  const completedDirSilent = computeFastRamAutocomplete('Добавь поддержку контекста из файлов sidecars. ', {
    touchedFiles: ['core/hook-runner.mjs'],
    repoFiles: ['sidecars/panel/server.mjs'],
    symbols: ['distillText'],
    symbolsByFile: {
      'sidecars/panel/server.mjs': ['Queue'],
    },
  });
  assert.equal(completedDirSilent.source, 'none');
  assert.equal(completedDirSilent.continuation, '');

  const dirClauseSuggest = computeFastRamAutocomplete('Добавь поддержку контекста из файлов sidecars через ', {
    touchedFiles: ['core/hook-runner.mjs'],
    repoFiles: ['sidecars/panel/server.mjs'],
    symbols: ['distillText'],
    symbolsByFile: {
      'sidecars/panel/server.mjs': ['Queue'],
    },
  });
  assert.equal(dirClauseSuggest.source, 'ram');
  assert.match(dirClauseSuggest.continuation, /sidecars\/panel\/server\.mjs.*Queue/);

  const alertChips = buildSmartContinuationChips({
    workspaceName: 'antigravity-model-router',
    touchedFiles: ['sidecars/panel/ui.html'],
    cascadeAlert: {
      file: 'sidecars/panel/server.mjs',
      checker: 'node --check',
      error: 'Unexpected token',
    },
  });
  assert.equal(alertChips.length, 3);
  assert.match(alertChips[0].label, /Исправить server\.mjs/);
  assert.match(alertChips[0].prompt, /sidecars\/panel\/server\.mjs/);

  const alertRamSuggest = computeFastRamAutocomplete('Исправь ', {
    touchedFiles: ['sidecars/panel/ui.html'],
    cascadeAlert: { file: 'sidecars/panel/server.mjs', checker: 'node --check' },
  });
  assert.equal(alertRamSuggest.source, 'ram');
  assert.match(alertRamSuggest.continuation, /sidecars\/panel\/server\.mjs/);
  invalidateAutocompleteContextCache();

  // Ensure zero WMI Win32_Process / -EncodedCommand patterns exist in runtime modules (Kaspersky PDM safety)
  const hudSrc = fs.readFileSync(path.join(ROOT_DIR, 'core', 'floating-hud.mjs'), 'utf8');
  const gpuSrc = fs.readFileSync(path.join(ROOT_DIR, 'core', 'local-gpu-engine.mjs'), 'utf8');
  assert.equal(/Win32_Process|-EncodedCommand/i.test(hudSrc), false);
  assert.equal(/Win32_Process|-EncodedCommand/i.test(gpuSrc), false);
});

test('Smart Composer Chat Dispatch (/api/chat-send): active chat, new-conversation fallback, projectId resolution & iframe clipboard', async () => {
  // 1) Workspace URI normalization & multi-project event resolution
  assert.equal(
    normalizeWorkspaceUriKey('file:///c%3A/Users/dev/workspace/antigravity-model-router/'),
    'c:/users/dev/workspace/antigravity-model-router'
  );
  assert.equal(
    normalizeWorkspaceUriKey('C:\\Users\\dev\\workspace\\antigravity-model-router'),
    'c:/users/dev/workspace/antigravity-model-router'
  );

  const tmpEventsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-sidecar-events-'));
  try {
    fs.writeFileSync(
      path.join(tmpEventsDir, '20261119_160000.100_alpha.json'),
      JSON.stringify({
        payload: {
          conversationMetadata: {
            metadata: {
              projectId: 'proj-alpha-11111111',
              workspaceUris: ['file:///c%3A/Work/project-alpha'],
            },
          },
        },
      }),
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmpEventsDir, '20261119_161000.200_beta.json'),
      JSON.stringify({
        payload: {
          conversationMetadata: {
            metadata: {
              projectId: 'proj-beta-22222222',
              workspaceUris: ['file:///c%3A/Work/project-beta'],
            },
          },
        },
      }),
      'utf8'
    );

    assert.equal(
      resolveProjectIdForWorkspace({
        workspaceUris: ['file:///C:/Work/project-alpha'],
        eventsDir: tmpEventsDir,
        env: { ANTIGRAVITY_PROJECT_ID: 'proj-env-default-999' },
      }),
      'proj-alpha-11111111'
    );
    assert.equal(
      resolveProjectIdForWorkspace({
        workspaceUris: ['file:///C:/Work/unknown-repo'],
        eventsDir: tmpEventsDir,
        env: { ANTIGRAVITY_PROJECT_ID: 'proj-env-default-999' },
      }),
      'proj-env-default-999'
    );

    // 2) Conversation ID extraction from nested agentapi responses
    assert.equal(
      extractConversationIdFromAgentApiOutput({
        response: {
          newConversation: {
            projectId: 'proj-alpha-11111111',
            parentConversationId: '',
            conversationId: '13b465f2-5ce8-40a8-aca3-b20b3f6c124c',
          },
        },
      }),
      '13b465f2-5ce8-40a8-aca3-b20b3f6c124c'
    );

    // 3) Direct send-message when conversationId is active + leading hyphen safety
    const capturedCalls = [];
    const resExisting = await dispatchChatMessageFromSidecar({
      message: '- проверь целостность данных в цикле',
      conversationId: '742a8848-57ad-450f-865a-47cbeebfec25',
      workspaceUris: ['file:///C:/Work/project-alpha'],
      eventsDir: tmpEventsDir,
      env: { ANTIGRAVITY_LS_ADDRESS: 'localhost:55555', ANTIGRAVITY_CSRF_TOKEN: 'csrf-tok' },
      execAgentApiFn: async (args, callEnv) => {
        capturedCalls.push({ args, projectId: callEnv.ANTIGRAVITY_PROJECT_ID });
        return { ok: true, parsed: { response: {} } };
      },
    });
    assert.equal(resExisting.ok, true);
    assert.equal(resExisting.mode, 'existing_conversation');
    assert.equal(resExisting.conversationId, '742a8848-57ad-450f-865a-47cbeebfec25');
    assert.equal(capturedCalls.length, 1);
    assert.deepEqual(capturedCalls[0].args, [
      'send-message',
      '742a8848-57ad-450f-865a-47cbeebfec25',
      ' - проверь целостность данных в цикле',
    ]);
    assert.equal(capturedCalls[0].projectId, 'proj-alpha-11111111');

    // 4) Sidebar / New Conversation screen (conversationId empty) -> new-conversation without forcing --model flash
    const capturedNew = [];
    const resNew = await dispatchChatMessageFromSidecar({
      message: 'Есть какие-то функции которые стоит добавить в основной цикл?',
      conversationId: '',
      workspaceUris: ['file:///C:/Work/project-beta'],
      eventsDir: tmpEventsDir,
      env: { ANTIGRAVITY_LS_ADDRESS: 'localhost:55555', ANTIGRAVITY_CSRF_TOKEN: 'csrf-tok' },
      execAgentApiFn: async (args, callEnv) => {
        capturedNew.push({ args, projectId: callEnv.ANTIGRAVITY_PROJECT_ID });
        return {
          ok: true,
          parsed: { response: { new_conversation: { conversation_id: '99aabbcc-1122-4334-8556-77889900aabb' } } },
        };
      },
    });
    assert.equal(resNew.ok, true);
    assert.equal(resNew.mode, 'new_conversation');
    assert.equal(resNew.conversationId, '99aabbcc-1122-4334-8556-77889900aabb');
    assert.deepEqual(capturedNew[0].args, [
      'new-conversation',
      'Есть какие-то функции которые стоит добавить в основной цикл?',
    ]);
    assert.equal(capturedNew[0].projectId, 'proj-beta-22222222');

    // 5) Stale conversationId (trajectory not found) -> seamless fallback to new-conversation
    const staleSteps = [];
    const resFallback = await dispatchChatMessageFromSidecar({
      message: 'Запусти проверку',
      conversationId: 'deadbeef-0000-4000-8000-000000000000',
      eventsDir: tmpEventsDir,
      env: { ANTIGRAVITY_LS_ADDRESS: 'localhost:55555', ANTIGRAVITY_CSRF_TOKEN: 'csrf-tok' },
      execAgentApiFn: async (args) => {
        staleSteps.push(args[0]);
        if (args[0] === 'send-message') {
          return { ok: false, error: 'rpc error: code = NotFound desc = trajectory not found' };
        }
        return { ok: true, parsed: { conversationId: 'abcdef12-3456-4789-8abc-def012345678' } };
      },
    });
    assert.equal(resFallback.ok, true);
    assert.equal(resFallback.mode, 'new_conversation');
    assert.equal(resFallback.conversationId, 'abcdef12-3456-4789-8abc-def012345678');
    assert.deepEqual(staleSteps, ['send-message', 'new-conversation']);

    // 6) Standalone browser without Antigravity env -> explicit NO_AGENTAPI_ENV
    const resNoEnv = await dispatchChatMessageFromSidecar({
      message: 'Тест',
      env: {},
    });
    assert.equal(resNoEnv.ok, false);
    assert.equal(resNoEnv.code, 'NO_AGENTAPI_ENV');

    // 7) UI HTML composer dispatch & iframe clipboard invariants
    const uiHtml = fs.readFileSync(path.join(ROOT_DIR, 'sidecars', 'panel', 'ui.html'), 'utf8');
    assert.ok(uiHtml.includes("panelFetch('/api/chat-send'"), 'ui.html must call /api/chat-send');
    assert.ok(uiHtml.includes("document.execCommand('copy')"), 'ui.html must include execCommand copy fallback for iframes');
    assert.ok(uiHtml.includes('function flashComposerStatus('), 'ui.html must render inline composer status feedback');
    assert.ok(uiHtml.includes('window.sidecar.ui.toggleConversation('), 'ui.html must focus newly created conversation');
  } finally {
    fs.rmSync(tmpEventsDir, { recursive: true, force: true });
  }
});

test('Smart Chat Queue (Queue class, limit 100, TTL expiry, processNext, Promise.all, error isolation & UI invariants)', async () => {
  // 1) Constructor defaults, hard limit 100 and adversarial options safety
  assert.equal(DEFAULT_CHAT_QUEUE_MAX_SIZE, 100);
  const defaultQueue = new Queue();
  assert.equal(defaultQueue.maxSize, 100);
  defaultQueue.dispose();

  const clampedMaxQueue = new Queue({ maxSize: 500 });
  assert.equal(clampedMaxQueue.maxSize, 100);
  clampedMaxQueue.dispose();

  const badOptsQueue = new Queue({ maxSize: Number.NaN, maxAgeMs: -50, taskTimeoutMs: Infinity, parallelBatchSize: 999, nowFn: 'bad' });
  assert.equal(badOptsQueue.maxSize, 100);
  assert.equal(badOptsQueue.maxAgeMs, 30000);
  assert.equal(badOptsQueue.taskTimeoutMs, 20000);
  assert.equal(badOptsQueue.parallelBatchSize, 16);
  badOptsQueue.dispose();

  // 2) Overflow eviction above 100 messages + sequential non-blocking processNext()
  let virtualNow = 1000;
  const overflowDrops = [];
  const q100 = new Queue({
    maxSize: 100,
    maxAgeMs: 10000,
    autoProcess: false,
    nowFn: () => virtualNow,
    onDrop: (info) => overflowDrops.push(info),
  });
  const settled115 = [];
  for (let i = 0; i < 115; i += 1) {
    const p = q100.enqueue(async () => `ok-${i}`, { label: `msg-${i}` })
      .then((val) => ({ ok: true, val }))
      .catch((err) => ({ ok: false, code: err.code }));
    settled115.push(p);
  }
  assert.equal(q100.size, 100, 'Queue size must never exceed 100');
  const first15 = await Promise.all(settled115.slice(0, 15));
  assert.equal(first15.every((r) => !r.ok && r.code === 'QUEUE_OVERFLOW'), true);
  assert.equal(overflowDrops.length, 15);
  assert.equal(q100.getStats().droppedOverflow, 15);

  // Drain remaining 100 items strictly sequentially via processNext()
  const drainResults = [];
  for (let i = 0; i < 100; i += 1) {
    const step = await q100.processNext();
    assert.equal(step.processed, true);
    assert.equal(step.ok, true);
    drainResults.push(step.result);
  }
  assert.equal(drainResults[0], 'ok-15');
  assert.equal(drainResults[99], 'ok-114');
  assert.equal(q100.size, 0);
  const all115 = await Promise.all(settled115);
  assert.equal(all115.slice(15).every((r) => r.ok), true);
  q100.dispose();

  // 3) Automatic expiration of old tasks (TTL eviction)
  let ttlClock = 5000;
  const qTtl = new Queue({ maxSize: 100, maxAgeMs: 100, autoProcess: false, nowFn: () => ttlClock });
  const pOld1 = qTtl.enqueue(async () => 'stale-1').catch((err) => ({ errCode: err.code }));
  const pOld2 = qTtl.enqueue(async () => 'stale-2').catch((err) => ({ errCode: err.code }));
  ttlClock += 150;
  const pFresh = qTtl.enqueue(async () => 'fresh-3');
  const prunedCount = qTtl.pruneExpired();
  assert.equal(prunedCount, 0, 'enqueue already auto-pruned expired tasks');
  assert.equal(qTtl.size, 1);
  assert.deepEqual(await pOld1, { errCode: 'QUEUE_TASK_EXPIRED' });
  assert.deepEqual(await pOld2, { errCode: 'QUEUE_TASK_EXPIRED' });
  const freshStep = await qTtl.processNext();
  assert.equal(freshStep.ok, true);
  assert.equal(await pFresh, 'fresh-3');
  assert.equal(qTtl.getStats().droppedExpired, 2);
  qTtl.dispose();

  // 4) Non-blocking event loop yield + per-step error isolation (sync throw, async reject, timeout)
  const stepErrors = [];
  const qSeq = new Queue({
    maxSize: 100,
    maxAgeMs: 5000,
    taskTimeoutMs: 45,
    autoProcess: true,
    onError: (err) => stepErrors.push(err.code || err.message),
  });
  const traceOrder = [];
  let immediateRanBetweenSteps = false;
  const pSyncFail = qSeq.enqueue(() => {
    traceOrder.push('step-1-sync-throw');
    throw new Error('sync boom');
  }).catch((e) => ({ caught: e.message }));
  const pAsyncFail = qSeq.enqueue(async () => {
    traceOrder.push('step-2-async-reject');
    throw new Error('async boom');
  }).catch((e) => ({ caught: e.message }));
  const pTimeout = qSeq.enqueue(
    ({ signal }) =>
      new Promise((resolve) => {
        const t = setTimeout(() => resolve('too-late'), 250);
        t.unref?.();
        signal?.addEventListener('abort', () => {
          clearTimeout(t);
          traceOrder.push('step-3-aborted');
        }, { once: true });
      })
  ).catch((e) => ({ caughtCode: e.code }));
  const pFinalOk = qSeq.enqueue(async () => {
    traceOrder.push('step-4-ok');
    return 'recovered';
  });
  setImmediate(() => {
    immediateRanBetweenSteps = true;
  });

  const [r1, r2, r3, r4] = await Promise.all([pSyncFail, pAsyncFail, pTimeout, pFinalOk]);
  assert.deepEqual(r1, { caught: 'sync boom' });
  assert.deepEqual(r2, { caught: 'async boom' });
  assert.deepEqual(r3, { caughtCode: 'QUEUE_TASK_TIMEOUT' });
  assert.equal(r4, 'recovered');
  assert.equal(immediateRanBetweenSteps, true, 'Queue processing must yield and never block the event loop');
  assert.deepEqual(traceOrder, ['step-1-sync-throw', 'step-2-async-reject', 'step-3-aborted', 'step-4-ok']);
  assert.equal(qSeq.getStats().failed, 3);
  assert.equal(qSeq.getStats().timedOut, 1);
  assert.equal(qSeq.getStats().completed, 1);
  assert.equal(stepErrors.length, 3);
  qSeq.dispose();

  // 5) Parallel batch processing via Promise.all while preserving per-groupKey order
  const qPar = new Queue({ maxSize: 100, maxAgeMs: 5000, parallelBatchSize: 3, autoProcess: false });
  let activeParallel = 0;
  let maxConcurrent = 0;
  const parTrace = [];
  const makeParTask = (id, groupKey, shouldFail = false) =>
    qPar.enqueue(
      async () => {
        activeParallel += 1;
        if (activeParallel > maxConcurrent) maxConcurrent = activeParallel;
        await new Promise((r) => setTimeout(r, 15));
        parTrace.push(id);
        activeParallel -= 1;
        if (shouldFail) throw new Error(`fail-${id}`);
        return id;
      },
      { groupKey }
    ).then((v) => ({ ok: true, v })).catch((e) => ({ ok: false, msg: e.message }));

  const parPromises = [
    makeParTask('A1', 'conv-A', false),
    makeParTask('A2', 'conv-A', false),
    makeParTask('B1', 'conv-B', true),
    makeParTask('C1', 'conv-C', false),
  ];
  const allParSummary = await qPar.processAllParallel(3);
  assert.equal(allParSummary.processed, 4);
  assert.equal(allParSummary.succeeded, 3);
  assert.equal(allParSummary.failed, 1);
  assert.ok(maxConcurrent >= 2, `Expected concurrent Promise.all execution, got maxConcurrent=${maxConcurrent}`);
  assert.ok(parTrace.indexOf('A1') < parTrace.indexOf('A2'), 'Same groupKey items must preserve FIFO order');
  const settledPar = await Promise.all(parPromises);
  assert.equal(settledPar[0].ok, true);
  assert.equal(settledPar[1].ok, true);
  assert.equal(settledPar[2].ok, false);
  assert.equal(settledPar[3].ok, true);
  qPar.dispose();

  // 6) Server routes & UI HTML queue contract invariants
  const serverSrc = fs.readFileSync(path.join(ROOT_DIR, 'sidecars', 'panel', 'server.mjs'), 'utf8');
  const composerEngineSrc = fs.readFileSync(path.join(ROOT_DIR, 'sidecars', 'panel', 'lib', 'panel-composer-engine.mjs'), 'utf8');
  assert.match(composerEngineSrc, /export class Queue\b/);
  assert.match(serverSrc, /\bQueue,/);
  assert.match(serverSrc, /app\.api\('\/api\/chat-queue'/);
  assert.match(composerEngineSrc, /Promise\.all\(/);
  assert.match(composerEngineSrc, /processNext\(/);

  const uiHtml = fs.readFileSync(path.join(ROOT_DIR, 'sidecars', 'panel', 'ui.html'), 'utf8');
  assert.match(uiHtml, /_SMART_SEND_QUEUE_LIMIT\s*=\s*100/);
  assert.match(uiHtml, /function processNextSmartSend\(/);
  assert.match(uiHtml, /function pruneSmartSendQueue\(/);
  assert.equal(/\bon(?:click|change|input|keydown|keyup)\s*=/i.test(uiHtml), false, 'ui.html must stay 100% CSP clean');
  const scriptMatch = /<script>([\s\S]*?)<\/script>/i.exec(uiHtml);
  assert.ok(scriptMatch && scriptMatch[1]);
  assert.doesNotThrow(() => new vm.Script(scriptMatch[1], { filename: 'sidecars/panel/ui.html' }));
});

test('Local RAG Project Chat (0% cloud quota): runLocalProjectChat budgeting, VRAM guard, IPC /ram/composer-rag & /gpu/chat, server & UI contracts', async () => {
  const hw16gb = { available: true, freeMb: 13000, totalMb: 16384, vramReliable: true, vendor: 'nvidia' };
  const tagMixed = [
    { name: 'gemma4:12b', size: 8.1 * 1024 ** 3 },
    { name: 'qwen3-embedding:0.6b', size: 0.65 * 1024 ** 3 },
  ];
  const tagOnlyLarge = [
    { name: 'gemma4:12b', size: 8.1 * 1024 ** 3 },
    { name: 'qwen3-embedding:0.6b', size: 0.65 * 1024 ** 3 },
  ];

  // 1) runLocalProjectChat uses strictly local endpoint, trims long history to gpuContextTokens, and strips <think>
  let capturedChatBody = null;
  let capturedEndpoint = '';
  let activeDuringCall = false;
  const longHistory = [];
  for (let i = 0; i < 8; i += 1) {
    longHistory.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `Turn ${i}: ` + 'x'.repeat(900) });
  }
  const chatRes = await runLocalProjectChat({
    query: 'Как работает дебаунс индексации?',
    messages: longHistory,
    ragContext: '### `core/ram-memory-mcp.mjs` [L451-L488]\n' + 'const x = 1;\n'.repeat(220),
    ragSources: [{ file: 'core/ram-memory-mcp.mjs', startLine: 451, endLine: 488, score: 0.91 }],
    workspaceName: 'demo-repo',
    cfgOverride: {
      gpuEnabled: true,
      gpuMaxVramMb: 12288,
      gpuContextTokens: 2048,
      gpuChatModel: 'gemma4:12b',
      gpuEmbedModel: 'qwen3-embedding:0.6b',
      gpuEndpoint: 'http://127.0.0.1:11434',
    },
    hwProbeFn: () => hw16gb,
    httpJsonFn: async (method, urlPath, body, _timeout, endpoint) => {
      if (method === 'GET' && urlPath === '/api/ps') return { ok: true, data: { models: [] } };
      if (method === 'GET' && urlPath === '/api/tags') return { ok: true, data: { models: tagMixed } };
      if (method === 'POST' && urlPath === '/api/chat') {
        activeDuringCall = isLocalChatActive();
        capturedChatBody = body;
        capturedEndpoint = endpoint;
        return {
          ok: true,
          data: { message: { content: '<think>internal reasoning</think>\nДебаунс в `core/ram-memory-mcp.mjs` ждёт 1500 мс.' } },
        };
      }
      return { ok: false };
    },
  });
  assert.equal(chatRes.ok, true);
  assert.equal(chatRes.zeroCloudQuota, true);
  assert.equal(chatRes.model, 'gemma4:12b');
  assert.equal(activeDuringCall, true, 'isLocalChatActive() must be true during /api/chat');
  assert.equal(isLocalChatActive(), false, 'isLocalChatActive() must reset after /api/chat completes');
  assert.equal(capturedEndpoint, 'http://127.0.0.1:11434');
  assert.equal(capturedChatBody.stream, false);
  assert.ok(capturedChatBody.options.num_ctx <= 2048, `Expected num_ctx <= 2048, got ${capturedChatBody.options.num_ctx}`);
  assert.ok(capturedChatBody.messages.length < 10, 'Older turns must be trimmed when gpuContextTokens budget is tight');
  assert.equal(chatRes.answer, 'Дебаунс в `core/ram-memory-mcp.mjs` ждёт 1500 мс.');
  assert.equal(chatRes.sources[0]?.file, 'core/ram-memory-mcp.mjs');

  // 2) VRAM cap guard blocks oversized chat model cleanly
  let vramBlockedChatCalls = 0;
  const blockedChat = await runLocalProjectChat({
    query: 'Объясни архитектуру',
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
        vramBlockedChatCalls += 1;
        return { ok: true, data: { message: { content: 'must not execute' } } };
      }
      return { ok: false };
    },
  });
  assert.equal(vramBlockedChatCalls, 0);
  assert.equal(blockedChat.ok, false);
  assert.equal(blockedChat.skippedVramCap, true);

  // 3) generatePromptContinuation accepts optional ragSnippets and injects RAG_CONTEXT
  let ragAutoBody = null;
  const autoRes = await generatePromptContinuation({
    draft: 'Проверь логику debounce ',
    ragSnippets: [{ file: 'core/ram-memory-mcp.mjs', startLine: 451, endLine: 488, symbols: ['scheduleDebouncedFileReindex'] }],
    _bypassCache: true,
    cfgOverride: {
      gpuEnabled: true,
      gpuMaxVramMb: 12288,
      gpuChatModel: 'gemma4:12b',
      gpuEmbedModel: 'qwen3-embedding:0.6b',
      gpuEndpoint: 'http://127.0.0.1:11434',
    },
    hwProbeFn: () => hw16gb,
    httpJsonFn: async (method, urlPath, body) => {
      if (method === 'GET' && urlPath === '/api/ps') return { ok: true, data: { models: [] } };
      if (method === 'GET' && urlPath === '/api/tags') return { ok: true, data: { models: tagMixed } };
      if (method === 'POST' && urlPath === '/api/chat') {
        ragAutoBody = body;
        return { ok: true, data: { message: { content: 'в core/ram-memory-mcp.mjs' } } };
      }
      return { ok: false };
    },
  });
  assert.equal(autoRes.ok, true);
  assert.equal(ragAutoBody.options.num_ctx, 1536);
  assert.match(ragAutoBody.messages[1].content, /RAG_CONTEXT:\s*core\/ram-memory-mcp\.mjs:L451-488 \(scheduleDebouncedFileReindex\)/);

  // 4) dispatchIpcRoute handles /ram/composer-rag & /gpu/chat using RamMemoryEngine
  const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-local-rag-'));
  const tmpRam = new RamMemoryEngine({ budgetMb: 64 });
  try {
    fs.writeFileSync(
      path.join(tmpWs, 'localVectorIndexer.mjs'),
      'export function rebuildLocalVectorIndex(entries) {\n  return entries.length;\n}\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmpWs, 'helper.mjs'),
      "import { rebuildLocalVectorIndex } from './localVectorIndexer.mjs';\nexport function runSync() { return rebuildLocalVectorIndex([1, 2]); }\n",
      'utf8'
    );
    await tmpRam.warmWorkspaceAsync(tmpWs, { startWatcher: false });

    const ragRouteRes = await dispatchIpcRoute(
      'POST',
      '/ram/composer-rag',
      { wsPath: tmpWs, query: 'rebuildLocalVectorIndex' },
      { engine: tmpRam }
    );
    assert.equal(ragRouteRes.status, 200);
    assert.equal(ragRouteRes.body.ok, true);
    assert.ok(ragRouteRes.body.matchedFiles.includes('localVectorIndexer.mjs'));
    assert.ok(ragRouteRes.body.matchedSymbols.includes('rebuildLocalVectorIndex'));

    let capturedIpcRag = null;
    const chatRouteRes = await dispatchIpcRoute(
      'POST',
      '/gpu/chat',
      { wsPath: tmpWs, query: 'Как работает rebuildLocalVectorIndex?' },
      {
        engine: tmpRam,
        runLocalProjectChatFn: async (opts) => {
          capturedIpcRag = opts;
          return {
            ok: true,
            answer: 'Использует rebuildLocalVectorIndex из localVectorIndexer.mjs.',
            model: 'gemma4:12b',
            sources: opts.ragSources,
            zeroCloudQuota: true,
          };
        },
      }
    );
    assert.equal(chatRouteRes.status, 200);
    assert.equal(chatRouteRes.body.ok, true);
    assert.equal(chatRouteRes.body.zeroCloudQuota, true);
    assert.match(capturedIpcRag.ragContext, /localVectorIndexer\.mjs/);
  } finally {
    tmpRam.close();
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }

  // 5) Server, CLI & CSP-safe UI contracts
  const serverSrc = fs.readFileSync(path.join(ROOT_DIR, 'sidecars', 'panel', 'server.mjs'), 'utf8');
  assert.match(serverSrc, /app\.api\('\/api\/local-chat'/);
  assert.match(serverSrc, /\/ram\/composer-rag/);
  assert.match(serverSrc, /\/gpu\/chat/);

  const cliSrc = fs.readFileSync(path.join(ROOT_DIR, 'core', 'ag-cli.mjs'), 'utf8');
  assert.match(cliSrc, /if\s*\(\s*sub\s*===\s*'chat'\s*\)/);
  assert.match(cliSrc, /runLocalProjectChat/);

  const uiHtml = fs.readFileSync(path.join(ROOT_DIR, 'sidecars', 'panel', 'ui.html'), 'utf8');
  assert.ok(uiHtml.includes('id="btnAskLocalRag"'));
  assert.ok(uiHtml.includes('id="localRagChatBox"'));
  assert.ok(uiHtml.includes('id="localRagMessages"'));
  assert.match(uiHtml, /function askLocalRagChat\(/);
  assert.match(uiHtml, /function clearLocalRagChat\(/);
  assert.match(uiHtml, /function insertRagSourceRef\(/);
  assert.equal(/\bon(?:click|change|input|keydown|keyup)\s*=/i.test(uiHtml), false, 'ui.html must stay 100% CSP clean');
  const scriptMatch2 = /<script>([\s\S]*?)<\/script>/i.exec(uiHtml);
  assert.ok(scriptMatch2 && scriptMatch2[1]);
  assert.doesNotThrow(() => new vm.Script(scriptMatch2[1], { filename: 'sidecars/panel/ui.html' }));
});

test('Smart Chat Anti-Hallucination & RAM+CPU+GPU Grounding Suite', async () => {
  const groundingCtx = {
    repoFiles: ['core/local-gpu-engine.mjs', 'core/ram-memory-engine.mjs', 'sidecars/panel/ui.html'],
    touchedFiles: ['sidecars/panel/server.mjs'],
    symbols: ['runLocalProjectChat', 'verifyGhostContinuationGrounding', 'buildGroundedChatPack'],
    allowedSlashCommands: ['/plan', '/boost', '/swarm'],
  };

  // 1) verifyGhostContinuationGrounding: rejects abstention, hallucinated files, symbols, slash commands, CLI flags
  const abstained = verifyGhostContinuationGrounding('Проверь ', 'NONE', groundingCtx);
  assert.equal(abstained.valid, false);
  assert.equal(abstained.reason, 'model_abstained');

  const badFile = verifyGhostContinuationGrounding('Проверь ', 'в core/nonexistent-magic.mjs', groundingCtx);
  assert.equal(badFile.valid, false);
  assert.equal(badFile.reason, 'hallucinated_file');
  assert.ok(badFile.unverified.includes('core/nonexistent-magic.mjs'));

  const badSym = verifyGhostContinuationGrounding('Проверь ', 'вызов inventedMagicHelper() в модуле', groundingCtx);
  assert.equal(badSym.valid, false);
  assert.equal(badSym.reason, 'hallucinated_symbol');
  assert.ok(badSym.unverified.includes('inventedMagicHelper'));

  const badSlash = verifyGhostContinuationGrounding('', '/nonexistent — сделай магию', groundingCtx);
  assert.equal(badSlash.valid, false);
  assert.equal(badSlash.reason, 'hallucinated_slash_command');
  assert.ok(badSlash.unverified.includes('/nonexistent'));

  const badFlag = verifyGhostContinuationGrounding('Запусти проверку ', 'с ключом --fake-flag', groundingCtx);
  assert.equal(badFlag.valid, false);
  assert.equal(badFlag.reason, 'hallucinated_cli_flag');

  // Allows valid repo files/symbols, mid-token .html, prose parentheticals, and tech acronyms
  const validGrounded = verifyGhostContinuationGrounding(
    'Проверь ',
    'логику runLocalProjectChat() в core/local-gpu-engine.mjs',
    groundingCtx
  );
  assert.equal(validGrounded.valid, true);
  assert.ok(validGrounded.verifiedFiles.includes('core/local-gpu-engine.mjs'));
  assert.ok(validGrounded.verifiedSymbols.includes('runLocalProjectChat'));

  const validMidToken = verifyGhostContinuationGrounding('Открой sidecars/panel/ui.', 'html', groundingCtx);
  assert.equal(validMidToken.valid, true);

  const validProseAndAcronyms = verifyGhostContinuationGrounding(
    'Улучши ',
    'Smart Composer (Ghost Text) с использованием `ram`, `gpu`, `vram` и `ast`',
    groundingCtx
  );
  assert.equal(validProseAndAcronyms.valid, true);

  // 2) auditLocalChatAnswerGrounding: flags unverified files/symbols, passes verified repo files/symbols
  const badAudit = auditLocalChatAnswerGrounding(
    'Вызови `inventedMagicHelper()` внутри `core/nonexistent-magic.mjs`.',
    {
      repoFiles: groundingCtx.repoFiles,
      symbols: groundingCtx.symbols,
      ragContext: '### `core/local-gpu-engine.mjs` [L1-L20]\nexport async function runLocalProjectChat() {}',
      ragSources: [{ file: 'core/local-gpu-engine.mjs' }],
    }
  );
  assert.equal(badAudit.grounded, false);
  assert.ok(badAudit.unverifiedFiles.includes('core/nonexistent-magic.mjs'));
  assert.ok(badAudit.unverifiedSymbols.includes('inventedMagicHelper'));
  assert.ok(badAudit.warningRu.length > 0);

  const goodAudit = auditLocalChatAnswerGrounding(
    'Функция `runLocalProjectChat` в `core/local-gpu-engine.mjs` работает через `ram`, `gpu`, `vram` и `ast` в Smart Composer (Ghost Text).',
    {
      repoFiles: groundingCtx.repoFiles,
      symbols: groundingCtx.symbols,
      ragContext: '### `core/local-gpu-engine.mjs` [L1-L20]\nexport async function runLocalProjectChat() {}',
      ragSources: [{ file: 'core/local-gpu-engine.mjs' }],
    }
  );
  assert.equal(goodAudit.grounded, true);
  assert.equal(goodAudit.groundingScore, 1);
  assert.equal(goodAudit.warningRu, '');

  // 3) runLocalProjectChat: enables think === true when gpuContextTokens >= 4096 on gemma4:12b,
  //    injects [VERIFIED PROJECT MANIFEST], strips <think>/<thought>, and returns grounding
  const hw16gb = { available: true, freeMb: 13500, totalMb: 16384, vramReliable: true, vendor: 'nvidia' };
  const tagGemma = [{ name: 'gemma4:12b', size: 8.1 * 1024 ** 3 }];
  let capturedBody4k = null;
  const chat4kRes = await runLocalProjectChat({
    query: 'Как устроена функция runLocalProjectChat?',
    verifiedManifest: '- core/local-gpu-engine.mjs :: exports [runLocalProjectChat, verifyGhostContinuationGrounding]',
    ragContext: '### `core/local-gpu-engine.mjs` [L7109-L7140]\nexport async function runLocalProjectChat({ query = "" } = {}) {\n  return { ok: true };\n}',
    ragSources: [{ file: 'core/local-gpu-engine.mjs', startLine: 7109, endLine: 7140, score: 0.96 }],
    repoFiles: ['core/local-gpu-engine.mjs'],
    repoSymbols: ['runLocalProjectChat', 'verifyGhostContinuationGrounding'],
    cfgOverride: {
      gpuEnabled: true,
      gpuMaxVramMb: 16384,
      gpuContextTokens: 8192,
      gpuChatModel: 'gemma4:12b',
      gpuEmbedModel: 'qwen3-embedding:4b',
      gpuEndpoint: 'http://127.0.0.1:11434',
    },
    hwProbeFn: () => hw16gb,
    httpJsonFn: async (method, urlPath, body) => {
      if (method === 'GET' && urlPath === '/api/ps') return { ok: true, data: { models: [] } };
      if (method === 'GET' && urlPath === '/api/tags') return { ok: true, data: { models: tagGemma } };
      if (method === 'POST' && urlPath === '/api/chat') {
        capturedBody4k = body;
        return {
          ok: true,
          data: {
            message: {
              content:
                '<think>Проверим сигнатуру в манифесте.</think><thought>Сверим AST</thought>\nФункция `runLocalProjectChat` определена в `core/local-gpu-engine.mjs`.',
            },
          },
        };
      }
      return { ok: false };
    },
  });
  assert.equal(chat4kRes.ok, true);
  assert.equal(capturedBody4k?.think, true, 'Expected body.think === true when gpuContextTokens >= 4096 on gemma4:12b');
  const userTurnMsg = capturedBody4k?.messages?.[capturedBody4k.messages.length - 1]?.content || '';
  assert.match(userTurnMsg, /\[VERIFIED PROJECT MANIFEST\]/);
  assert.equal(/<think>|<thought>/i.test(chat4kRes.answer), false, 'Reasoning tags must be stripped');
  assert.ok(chat4kRes.grounding && chat4kRes.grounding.grounded === true);
  assert.equal(chat4kRes.grounding.groundingScore, 1);

  // 4) RamMemoryEngine: searchComposerContextFast & buildGroundedChatPack
  const tmpWs = makeTempDir('amr-grounding-e2e-');
  const ramEng = new RamMemoryEngine({ budgetMb: 64 });
  try {
    fs.writeFileSync(
      path.join(tmpWs, 'chatEngine.mjs'),
      [
        'export async function runMultiLineParamChat({',
        '  query = "",',
        '  gpuContextTokens = 8192,',
        '  verifiedManifest = "",',
        '} = {}) {',
        '  const inputBudgetTokens = Math.max(1024, gpuContextTokens - 512);',
        '  if (!query) return { ok: false, inputBudgetTokens };',
        '  return { ok: true, inputBudgetTokens, verifiedManifest };',
        '}',
        '',
        'export class GroundedPackBuilder {',
        '  buildMultiLineClassPack(',
        '    rootDir,',
        '    { maxChars = 8400, maxFiles = 5 } = {}',
        '  ) {',
        '    return { ok: true, rootDir, maxChars, maxFiles };',
        '  }',
        '}',
        '',
      ].join('\n'),
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmpWs, 'caller.mjs'),
      [
        "import { runMultiLineParamChat } from './chatEngine.mjs';",
        'export async function dispatchLocalAsk(q) {',
        '  return runMultiLineParamChat({ query: q, gpuContextTokens: 8192 });',
        '}',
        '',
      ].join('\n'),
      'utf8'
    );
    // Create synthetic pitfall & handoff noise inside tmpWs/.agents to verify exclusion
    fs.mkdirSync(path.join(tmpWs, '.agents'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpWs, '.agents', 'pitfall-ledger.json'),
      JSON.stringify({ pitfalls: [{ summary: 'PITFALL_NOISE_MARKER_DO_NOT_INCLUDE' }] }),
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmpWs, '.agents', 'session-handoff.json'),
      JSON.stringify({ recentGoals: ['HANDOFF_NOISE_MARKER_DO_NOT_INCLUDE'] }),
      'utf8'
    );

    await ramEng.warmWorkspaceAsync(tmpWs, { startWatcher: false });

    // Warm-up call then verify zero-overlap -> [] and <15ms real symbol hit
    const zeroOverlap = ramEng.searchComposerContextFast(tmpWs, 'привет как дела сегодня');
    assert.equal(zeroOverlap.ok, true);
    assert.deepEqual(zeroOverlap.matchedFiles, []);
    assert.deepEqual(zeroOverlap.ragSnippets, []);

    const tFast0 = performance.now();
    const fastHit = ramEng.searchComposerContextFast(tmpWs, 'Проверь runMultiLineParamChat');
    const fastElapsedMs = performance.now() - tFast0;
    assert.equal(fastHit.ok, true);
    assert.ok(fastElapsedMs < 15, `Expected searchComposerContextFast < 15ms, got ${fastElapsedMs.toFixed(2)}ms`);
    assert.ok(fastHit.matchedFiles.includes('chatEngine.mjs'));
    assert.ok(fastHit.matchedSymbols.includes('runMultiLineParamChat'));

    // buildGroundedChatPack: multi-line-param AST expansion (>1 line, not truncated to 1 line!),
    // multi-turn follow-up resolution via messages, and zero Pitfall/Handoff noise
    const followUpPack = ramEng.buildGroundedChatPack(
      tmpWs,
      'а почему там так считается лимит токенов?',
      {
        messages: [
          { role: 'user', content: 'Расскажи про runMultiLineParamChat в chatEngine.mjs' },
          { role: 'assistant', content: 'Функция `runMultiLineParamChat` в `chatEngine.mjs` вычисляет бюджет.' },
        ],
      }
    );
    assert.equal(followUpPack.ok, true);
    assert.ok(followUpPack.repoSymbols.includes('buildMultiLineClassPack'), 'Multi-line class methods must be indexed in repoSymbols');
    assert.ok(followUpPack.verifiedManifest.includes('chatEngine.mjs'));
    const chatEngineSrc = followUpPack.sources.find((s) => s.file === 'chatEngine.mjs');
    assert.ok(chatEngineSrc, 'Multi-turn follow-up must resolve chatEngine.mjs via prior messages');
    assert.ok(
      chatEngineSrc.endLine - chatEngineSrc.startLine >= 5,
      `Multi-line-param function slice must NOT be truncated to 1 line (got L${chatEngineSrc.startLine}-L${chatEngineSrc.endLine})`
    );
    assert.match(followUpPack.formatted, /inputBudgetTokens/);
    assert.equal(followUpPack.formatted.includes('PITFALL_NOISE_MARKER'), false);
    assert.equal(followUpPack.formatted.includes('HANDOFF_NOISE_MARKER'), false);
    assert.equal(/pitfall|auto-handoff/i.test(followUpPack.formatted), false);
  } finally {
    ramEng.close();
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }

  // 5) isEphemeralTestWorkspace & computeFastRamAutocomplete guards
  assert.equal(isEphemeralTestWorkspace(path.join(os.tmpdir(), 'amr-unit-123')), true);
  assert.equal(isEphemeralTestWorkspace('C:/Users/dev/AppData/Local/Temp/ag-local-rag-xyz'), true);
  const nonTempRepoPath = process.env.AMR_MUTATION_SANDBOX
    ? path.join(path.parse(ROOT_DIR).root, 'projects', 'antigravity-model-router')
    : ROOT_DIR;
  assert.equal(isEphemeralTestWorkspace(nonTempRepoPath), false);

  // Blocks 2-letter lowercase false-positive symbol/file completions
  const twoLetterRes = computeFastRamAutocomplete('Проверь in', {
    wsRoot: ROOT_DIR,
    symbols: ['indexWorkspaceVectors', 'invalidateAutocompleteContextCache'],
    repoFiles: ['install.js', 'core/local-gpu-engine.mjs', 'core/ram-memory-engine.mjs', 'core/ag-cli.mjs', 'core/hook-runner.mjs', 'core/mcp-server.mjs'],
  });
  assert.equal(
    twoLetterRes.continuation.startsWith('dexWorkspaceVectors') || twoLetterRes.continuation.startsWith('stall.js'),
    false,
    `Must block 2-letter lowercase token false-positive completion, got: "${twoLetterRes.continuation}"`
  );

  // Blocks blind unrelated file injection on broad prompts when workspace has many files and no target clue
  const broadRes = computeFastRamAutocomplete('Оптимизируй ', {
    wsRoot: ROOT_DIR,
    touchedFiles: ['core/unrelated-stale-module.mjs'],
    repoFiles: [
      'core/local-gpu-engine.mjs',
      'core/ram-memory-engine.mjs',
      'core/ag-cli.mjs',
      'core/hook-runner.mjs',
      'sidecars/panel/server.mjs',
      'sidecars/panel/ui.html',
    ],
  });
  assert.equal(
    broadRes.continuation.includes('unrelated-stale-module.mjs'),
    false,
    `Broad prompt without target clue must NOT blindly inject unrelated touched file, got: "${broadRes.continuation}"`
  );

  // 6) Closed-World Grounded Continuation: cold-index fail-closed, gated tech stack, PascalCase & cross-file chimera guards
  const coldFileCheck = verifyGhostContinuationGrounding('Проверь ', 'в файле core/magic-ghost.mjs', {
    repoFiles: [],
    touchedFiles: [],
    symbols: [],
  });
  assert.equal(coldFileCheck.valid, false);
  assert.equal(coldFileCheck.reason, 'unverified_cold_index');

  const coldSymCheck = verifyGhostContinuationGrounding('Проверь ', 'вызов computeGhostScore()', {
    repoFiles: [],
    touchedFiles: [],
    symbols: [],
  });
  assert.equal(coldSymCheck.valid, false);
  assert.equal(coldSymCheck.reason, 'unverified_cold_index');

  const ungroundedRedis = verifyGhostContinuationGrounding(
    'Почему в умном чате ',
    'возникает сброс сессии в Redis и WebSocket',
    groundingCtx
  );
  assert.equal(ungroundedRedis.valid, false);
  assert.equal(ungroundedRedis.reason, 'hallucinated_tech_term');

  const ungroundedRuTech = verifyGhostContinuationGrounding(
    'Оптимизируй кэш ',
    'при обращении к редису и постгресу',
    groundingCtx
  );
  assert.equal(ungroundedRuTech.valid, false);
  assert.equal(ungroundedRuTech.reason, 'hallucinated_tech_term');

  const groundedTechWhenInRepo = verifyGhostContinuationGrounding(
    'Проверь ',
    'очередь сообщений в Redis',
    { ...groundingCtx, repoTechTerms: ['redis'] }
  );
  assert.equal(groundedTechWhenInRepo.valid, true);

  const pascalHallucination = verifyGhostContinuationGrounding(
    'Подключи ',
    'обработчик через SmartChatController в панели',
    groundingCtx
  );
  assert.equal(pascalHallucination.valid, false);
  assert.equal(pascalHallucination.reason, 'hallucinated_symbol');
  assert.ok(pascalHallucination.unverified.includes('SmartChatController'));

  const chimeraCtx = {
    ...groundingCtx,
    repoFiles: ['sidecars/panel/ui.html', 'core/safe-json.mjs'],
    symbols: ['renderSmartComposerMirror', 'withFileLockSync'],
    symbolsByFile: {
      'sidecars/panel/ui.html': ['renderSmartComposerMirror', 'scheduleSmartAutocomplete'],
      'core/safe-json.mjs': ['withFileLockSync', 'atomicWriteJsonSync'],
    },
  };
  const crossFileChimera = verifyGhostContinuationGrounding(
    'Проверь в sidecars/panel/ui.html ',
    'вызов withFileLockSync()',
    chimeraCtx
  );
  assert.equal(crossFileChimera.valid, false);
  assert.equal(crossFileChimera.reason, 'cross_file_symbol_mismatch');
  assert.deepEqual(crossFileChimera.unverified, ['withFileLockSync']);

  const validSameFilePair = verifyGhostContinuationGrounding(
    'Проверь в sidecars/panel/ui.html ',
    'вызов renderSmartComposerMirror()',
    chimeraCtx
  );
  assert.equal(validSameFilePair.valid, true);

  // Verify unrelated recentGoals & touchedFiles do NOT bleed into GPU prompt when draft has no target clue
  let capturedPromptUserMsg = '';
  await generatePromptContinuation({
    draft: `Давай проверим все наши нововведения ${Date.now()} `,
    touchedFiles: ['core/stale-unrelated-file.mjs'],
    recentGoals: ['Починить старый баг сериализации XML'],
    cfgOverride: {
      gpuEnabled: true,
      gpuMaxVramMb: 16384,
      gpuChatModel: 'gemma4:12b',
      gpuEmbedModel: 'qwen3-embedding:0.6b',
      gpuEndpoint: 'http://127.0.0.1:11434',
    },
    hwProbeFn: () => hw16gb,
    httpJsonFn: async (method, urlPath, body) => {
      if (method === 'GET' && urlPath === '/api/ps') return { ok: true, data: { models: [{ name: 'gemma4:12b' }] } };
      if (method === 'GET' && urlPath === '/api/tags') return { ok: true, data: { models: tagGemma } };
      if (method === 'POST' && urlPath === '/api/chat') {
        capturedPromptUserMsg = body?.messages?.[1]?.content || '';
        return { ok: true, data: { message: { content: 'NONE' } } };
      }
      return { ok: false };
    },
  });
  assert.equal(capturedPromptUserMsg.includes('stale-unrelated-file.mjs'), false, 'Stale touched file must not bleed into unrelated draft');
  assert.equal(capturedPromptUserMsg.includes('сериализации XML'), false, 'Unrelated old goal must not bleed into RECENT');
});

test('Local Models v4 Anti-Hallucination: cross-file chimera, line-range audit, outOfContextSymbols + 2nd-hop RAM expansion, clean corrective retry, JSON Schema & AST outline', async () => {
  const hw16gb = { available: true, freeMb: 13500, totalMb: 16384, vramReliable: true, vendor: 'nvidia' };
  const tagGemma = [{ name: 'gemma4:12b', size: 8.1 * 1024 ** 3 }];
  const cfgV4 = {
    gpuEnabled: true,
    gpuMaxVramMb: 16384,
    gpuContextTokens: 8192,
    gpuChatModel: 'gemma4:12b',
    gpuEmbedModel: 'qwen3-embedding:0.6b',
    gpuEndpoint: 'http://127.0.0.1:11434',
  };

  // 1) auditLocalChatAnswerGrounding: crossFileMismatches, unverifiedLineCitations & outOfContextSymbols
  const auditRes = auditLocalChatAnswerGrounding(
    'Функция `withFileLockSync` определена в `sidecars/panel/ui.html`. Подробнее смотри в `core/local-gpu-engine.mjs:L999` и `helperNotInSlice`.',
    {
      repoFiles: ['sidecars/panel/ui.html', 'core/safe-json.mjs', 'core/local-gpu-engine.mjs'],
      symbols: ['renderSmartComposerMirror', 'withFileLockSync', 'runLocalProjectChat', 'helperNotInSlice'],
      symbolsByFile: {
        'sidecars/panel/ui.html': ['renderSmartComposerMirror'],
        'core/safe-json.mjs': ['withFileLockSync'],
        'core/local-gpu-engine.mjs': ['runLocalProjectChat'],
      },
      ragContext: '### `core/local-gpu-engine.mjs` [L10-L40]\nexport async function runLocalProjectChat() {}\n### `sidecars/panel/ui.html` [L1-L20]\nfunction renderSmartComposerMirror() {}',
      ragSources: [
        { file: 'core/local-gpu-engine.mjs', startLine: 10, endLine: 40 },
        { file: 'sidecars/panel/ui.html', startLine: 1, endLine: 20 },
      ],
    }
  );
  assert.equal(auditRes.grounded, false);
  assert.equal(auditRes.crossFileMismatches.length, 1);
  assert.equal(auditRes.crossFileMismatches[0].symbol, 'withFileLockSync');
  assert.equal(auditRes.crossFileMismatches[0].claimedFile, 'sidecars/panel/ui.html');
  assert.ok(auditRes.unverifiedLineCitations.includes('core/local-gpu-engine.mjs:L999'));
  assert.ok(auditRes.outOfContextSymbols.includes('helperNotInSlice'));

  // 2) runLocalProjectChat: clean corrective retry (does NOT pollute assistant history with bad draft)
  const chatCalls = [];
  const retryChatRes = await runLocalProjectChat({
    query: 'Как устроена функция runLocalProjectChat?',
    ragContext: '### `core/local-gpu-engine.mjs` [L10-L40]\nexport async function runLocalProjectChat() { return true; }',
    ragSources: [{ file: 'core/local-gpu-engine.mjs', startLine: 10, endLine: 40 }],
    repoFiles: ['core/local-gpu-engine.mjs'],
    repoSymbols: ['runLocalProjectChat'],
    cfgOverride: cfgV4,
    hwProbeFn: () => hw16gb,
    httpJsonFn: async (method, urlPath, body) => {
      if (method === 'GET' && urlPath === '/api/ps') return { ok: true, data: { models: [{ name: 'gemma4:12b' }] } };
      if (method === 'GET' && urlPath === '/api/tags') return { ok: true, data: { models: tagGemma } };
      if (method === 'POST' && urlPath === '/api/chat') {
        chatCalls.push(body);
        if (chatCalls.length === 1) {
          return { ok: true, data: { message: { content: 'Вызови `fakeGhostFn()` в `core/missing-file.mjs`.' } } };
        }
        return { ok: true, data: { message: { content: 'Функция `runLocalProjectChat` описана в `core/local-gpu-engine.mjs:L10-L40`.' } } };
      }
      return { ok: false };
    },
  });
  assert.equal(chatCalls.length, 2, 'Expected corrective retry pass on ungrounded response');
  assert.equal(
    chatCalls[1].messages.some((m) => m.role === 'assistant' && m.content.includes('fakeGhostFn')),
    false,
    'Corrective retry must NOT pollute assistant history with the hallucinated answer'
  );
  assert.equal(retryChatRes.ok, true);
  assert.equal(retryChatRes.grounding.grounded, true);

  // 3) 2nd-hop RAM slice expansion + claim verifier
  let extraHopFetchedFor = null;
  let verifierCalls = 0;
  const hopRes = await runLocalProjectChat({
    query: 'Как работает runLocalProjectChat?',
    ragContext: '### `core/local-gpu-engine.mjs` [L10-L40]\nexport async function runLocalProjectChat() { return true; }',
    ragSources: [{ file: 'core/local-gpu-engine.mjs', startLine: 10, endLine: 40 }],
    repoFiles: ['core/local-gpu-engine.mjs', 'core/helper.mjs'],
    repoSymbols: ['runLocalProjectChat', 'helperOut'],
    enableClaimVerifier: true,
    fetchExtraSlicesFn: async (syms) => {
      extraHopFetchedFor = syms;
      return [{ file: 'core/helper.mjs', startLine: 1, endLine: 12, symbol: 'helperOut', snippetText: 'export function helperOut() { return 42; }' }];
    },
    cfgOverride: cfgV4,
    hwProbeFn: () => hw16gb,
    httpJsonFn: async (method, urlPath, body) => {
      if (method === 'GET' && urlPath === '/api/ps') return { ok: true, data: { models: [{ name: 'gemma4:12b' }] } };
      if (method === 'GET' && urlPath === '/api/tags') return { ok: true, data: { models: tagGemma } };
      if (method === 'POST' && urlPath === '/api/chat') {
        if (typeof body?.format === 'object') {
          verifierCalls += 1;
          return { ok: true, data: { message: { content: JSON.stringify({ verified: true, unsupportedClaims: [] }) } } };
        }
        return { ok: true, data: { message: { content: 'Метод `runLocalProjectChat` вызывает `helperOut` из `core/helper.mjs:L1-L12`.' } } };
      }
      return { ok: false };
    },
  });
  assert.deepEqual(extraHopFetchedFor, ['helperOut']);
  assert.equal(verifierCalls, 1);
  assert.equal(hopRes.claimVerification?.verified, true);
  assert.ok(hopRes.sources.some((s) => s.file === 'core/helper.mjs'));

  // 4) verifyChatClaimsLocally detects unsupported claims
  const badClaims = await verifyChatClaimsLocally({
    answer: 'Функция всегда ждёт 9999 мс.',
    ragContext: 'export function run() { return 42; }',
    cfgOverride: cfgV4,
    httpJsonFn: async () => ({
      ok: true,
      data: { message: { content: JSON.stringify({ verified: false, unsupportedClaims: ['Таймаут 9999 мс не указан в коде'] }) } },
    }),
  });
  assert.equal(badClaims.verified, false);
  assert.equal(badClaims.unsupportedClaims.length, 1);

  // 5) classifySkillWithLlm sends JSON Schema enum and falls back to format:'json' on schema error
  const skillBodies = [];
  const schemaFallbackRes = await classifySkillWithLlm(
    'Проверь SQL запрос',
    [{ slug: 'sql-perf', description: 'SQL tuning' }],
    {
      model: 'gemma4:12b',
      chatHttpFn: async (body) => {
        skillBodies.push(body);
        if (typeof body.format === 'object') {
          return { ok: false, error: 'unsupported format schema' };
        }
        return { ok: true, data: { message: { content: '{"slug":"sql-perf","confidence":0.92}' } } };
      },
    }
  );
  assert.equal(typeof skillBodies[0].format, 'object');
  assert.deepEqual(skillBodies[0].format.properties.slug.enum, ['sql-perf', 'none']);
  assert.equal(skillBodies[1].format, 'json');
  assert.equal(schemaFallbackRes.slug, 'sql-perf');

  // 6) critiqueEditedDiffLocally parses JSON BUG response cleanly
  const jsonCritic = await critiqueEditedDiffLocally({
    filePath: 'demo.mjs',
    oldText: 'export function run(x) { return x; }\n',
    newText: 'export function run(x) { return x; }\nexport async function saveData(x) { fetch(x); return true; }\n',
    cfgOverride: cfgV4,
    httpJsonFn: async () => ({
      ok: true,
      data: { message: { content: '{"status":"BUG","issue":"Missing await before fetch(x)"}' } },
    }),
  });
  assert.equal(jsonCritic.hasBug, true);
  assert.match(jsonCritic.issues[0], /Missing await/);

  // 7) buildGroundedChatPack: AST control-flow outline (>85 lines), compound query decomposition, symbolsByFile & findSymbolSlicesFast
  const tmpWs = makeTempDir('amr-v4-rag-');
  const ramEng = new RamMemoryEngine({ budgetMb: 64 });
  try {
    const longLines = [
      'export function processAlphaPipeline(input, flag) {',
      '  if (!input) return { ok: false, reason: "empty" };',
      ...Array.from({ length: 42 }, (_, i) => `  const step_${i} = ${i};`),
      '  if (flag === "strict") {',
      '    return { ok: true, mode: "strict", val: step_41 };',
      '  }',
      ...Array.from({ length: 42 }, (_, i) => `  const tail_${i} = ${i};`),
      '  const targetNeedleToken = tail_41 + 1;',
      '  return { ok: true, targetNeedleToken };',
      '}',
    ];
    fs.writeFileSync(path.join(tmpWs, 'alphaEngine.mjs'), longLines.join('\n') + '\n', 'utf8');
    fs.writeFileSync(
      path.join(tmpWs, 'betaGuard.mjs'),
      'export function validateBetaFallback(err) {\n  if (!err) return "ok";\n  return "beta_failed";\n}\n',
      'utf8'
    );
    await ramEng.warmWorkspaceAsync(tmpWs, { startWatcher: false });

    const pack = ramEng.buildGroundedChatPack(
      tmpWs,
      'Как работает processAlphaPipeline с targetNeedleToken? И почему срабатывает validateBetaFallback?',
      { maxFiles: 4 }
    );
    assert.equal(pack.ok, true);
    assert.ok(pack.symbolsByFile && Array.isArray(pack.symbolsByFile['alphaEngine.mjs']));
    assert.ok(pack.sources.some((s) => s.file === 'alphaEngine.mjs'));
    assert.ok(pack.sources.some((s) => s.file === 'betaGuard.mjs'));
    assert.match(pack.formatted, /\[outline\]/, 'Folded long function must expose AST control-flow outline lines');

    const fastExtra = ramEng.findSymbolSlicesFast(tmpWs, ['validateBetaFallback'], { maxSlices: 2 });
    assert.equal(fastExtra.length, 1);
    assert.equal(fastExtra[0].file, 'betaGuard.mjs');
    assert.match(fastExtra[0].snippetText, /beta_failed/);
  } finally {
    ramEng.close();
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
});

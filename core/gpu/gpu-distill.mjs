/**
 * @file gpu-distill.mjs
 * @description SimHash distill cache and local log/file distillation via Ollama.
 */

import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import path from 'node:path';
import { hashShingle64 } from '../cpu-graph-contracts.mjs';
import { atomicWriteJsonSync, safeReadJsonSync } from '../safe-json.mjs';
import { checkFileSecurity, redactSecretsInText } from '../security-guard.mjs';
import { normalizeLang, readActiveUiLanguage } from '../i18n.mjs';
import {
  CACHE_DIR,
  GPU_DISTILL_CACHE_FILE,
  RAM_DISTILL_CACHE_MAX,
  RAM_DISTILL_CACHE_TTL_MS,
  clampInt,
  gpuRuntime,
  inFlightDistillMap,
  loadGpuConfig,
  ollamaHttpJson,
  ramDistillCache,
  readFreshTtlLruEntry,
  recordGpuTelemetryPatch,
  stripReasoningTags,
} from './gpu-shared-state.mjs';
import {
  ensureOllamaRunning,
  estimateModelVramMb,
  evaluateGpuThermalAndLoadGuard,
  evaluateVramModelFit,
  getCachedOrFetchOllamaTagMap,
  normalizeOllamaTag,
  probeNvidiaGpu,
  reconcileLoadedModelsVram,
  unloadModelsExceedingBudget,
} from './gpu-vram-runtime.mjs';

function popcnt32(v) {
  v = v - ((v >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

function hammingDistance64(aHi, aLo, bHi, bLo) {
  return popcnt32((aHi ^ bHi) >>> 0) + popcnt32((aLo ^ bLo) >>> 0);
}

function computeErrorLogSimHash64(text = '') {
  const norm = String(text || '')
    .toLowerCase()
    .replace(/\b\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}:\d{2}(?:\.\d+)?z?\b/g, ' <ts> ')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, ' <uuid> ')
    .replace(/\b0x[0-9a-f]+\b/g, ' <hex> ');
  const tokens = norm.match(/[a-zа-яё0-9_]+/gi);
  if (!tokens || tokens.length < 6) return null;
  const weights = new Int32Array(64);
  for (let i = 0; i < tokens.length; i++) {
    const [hi, lo] = hashShingle64(tokens[i]);
    for (let b = 0; b < 32; b++) {
      weights[b] += ((lo >>> b) & 1) ? 1 : -1;
      weights[32 + b] += ((hi >>> b) & 1) ? 1 : -1;
    }
  }
  let lo = 0;
  let hi = 0;
  for (let b = 0; b < 32; b++) {
    if (weights[b] > 0) lo = (lo | (1 << b)) >>> 0;
    if (weights[32 + b] > 0) hi = (hi | (1 << b)) >>> 0;
  }
  return { hi: hi >>> 0, lo: lo >>> 0 };
}

export function ensureDistillCacheLoaded() {
  if (gpuRuntime.ramDistillCacheLoaded) return;
  gpuRuntime.ramDistillCacheLoaded = true;
  try {
    if (!existsSync(GPU_DISTILL_CACHE_FILE)) return;
    const parsed = safeReadJsonSync(GPU_DISTILL_CACHE_FILE, () => null, { selfHeal: false });
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
    const now = Date.now();
    for (const item of entries) {
      if (!Array.isArray(item) || item.length !== 2) continue;
      const [key, entry] = item;
      if (!key || !entry || typeof entry !== 'object') continue;
      if ((now - (entry.ts || 0)) >= RAM_DISTILL_CACHE_TTL_MS) continue;
      if (ramDistillCache.size >= RAM_DISTILL_CACHE_MAX) {
        const oldest = ramDistillCache.keys().next().value;
        if (oldest !== undefined) ramDistillCache.delete(oldest);
      }
      ramDistillCache.set(String(key), entry);
    }
  } catch {}
}

function persistDistillCacheNow() {
  try {
    if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
    const now = Date.now();
    const entries = [];
    for (const [key, entry] of ramDistillCache.entries()) {
      if (!entry || (now - (entry.ts || 0)) >= RAM_DISTILL_CACHE_TTL_MS) continue;
      entries.push([key, entry]);
    }
    atomicWriteJsonSync(GPU_DISTILL_CACHE_FILE, { version: 1, entries }, { spaces: 0 });
  } catch {}
}

function schedulePersistDistillCache() {
  if (gpuRuntime.distillCacheSaveTimer) return;
  gpuRuntime.distillCacheSaveTimer = setTimeout(() => {
    gpuRuntime.distillCacheSaveTimer = null;
    persistDistillCacheNow();
  }, 1200);
  if (typeof gpuRuntime.distillCacheSaveTimer.unref === 'function') {
    gpuRuntime.distillCacheSaveTimer.unref();
  }
}

export function getFreshDistillCacheEntry(key) {
  return readFreshTtlLruEntry(ramDistillCache, key, RAM_DISTILL_CACHE_TTL_MS);
}

export function setDistillCacheEntry(key, entry) {
  ensureDistillCacheLoaded();
  if (ramDistillCache.has(key)) {
    ramDistillCache.delete(key);
  } else if (ramDistillCache.size >= RAM_DISTILL_CACHE_MAX) {
    const oldestKey = ramDistillCache.keys().next().value;
    if (oldestKey !== undefined) ramDistillCache.delete(oldestKey);
  }
  ramDistillCache.set(key, entry);
  schedulePersistDistillCache();
}

/**
 * Вычисляет стабильный дискретный размер контекста num_ctx (4096 / 8192 / 12288),
 * чтобы уложиться в 12 ГБ VRAM и избежать лишних перезапусков KV-кэша между запросами.
 */
export function computeSafeNumCtx(cfg = {}, hw = null, loadedModels = [], estimatedPromptChars = 4000, tagMap = null) {
  const safeCfg = cfg && typeof cfg === 'object' ? cfg : {};
  const { loadedVramMb: ollamaLoadedMb } = reconcileLoadedModelsVram(loadedModels, tagMap, hw);
  let hwAvailCapMb = 4096;
  if (hw?.available) {
    if (hw.vendor === 'nvidia' && Number(hw.freeMb) > 0) {
      hwAvailCapMb = hw.freeMb + ollamaLoadedMb - 512;
    } else if (Number(hw.totalMb) > 0) {
      hwAvailCapMb = Math.max(2048, hw.totalMb - 1024);
    } else {
      hwAvailCapMb = Number(safeCfg.gpuMaxVramMb) || 4096;
    }
  }
  const effectiveBudgetMb = Math.min(Number(safeCfg.gpuMaxVramMb) || 8192, Math.max(2048, hwAvailCapMb));

  let vramCap = 4096;
  if (effectiveBudgetMb >= 20000) {
    vramCap = 32768;
  } else if (effectiveBudgetMb >= 12500) {
    vramCap = 16384;
  } else if (effectiveBudgetMb >= 11400) {
    vramCap = 12288;
  } else if (effectiveBudgetMb >= 9600) {
    vramCap = 8192;
  }
  const capCtx = Math.min(Number(safeCfg.gpuContextTokens) || vramCap, vramCap);

  // Фиксированный стандартный бакет 8192 избавляет Ollama от пересоздания KV-кэша между вызовами разной длины
  const stdBucket = Math.min(capCtx, 8192);
  if ((estimatedPromptChars || 0) <= 19000) {
    return stdBucket;
  }
  return capCtx;
}

/**
 * Умная обрезка сверхдлинного текста перед отправкой в локальную LLM (сохраняет шапку + строки с ошибками/совпадениями + хвост).
 */
function prepareBoundedInput(rawText, query, maxChars) {
  const text = String(rawText || '');
  if (text.length <= maxChars) return { text, truncated: false };

  const lines = text.split(/\r?\n/);
  const headBudget = Math.floor(maxChars * 0.25);
  const tailBudget = Math.floor(maxChars * 0.45);
  const midBudget = maxChars - headBudget - tailBudget;

  const head = text.slice(0, headBudget);
  const tail = text.slice(text.length - tailBudget);

  // Отбираем ключевые строки из середины (ошибки, исключения, слова из query)
  const keywords = String(query || '').toLowerCase().split(/\s+/).filter((w) => w.length >= 3);
  const midMatches = [];
  let midLen = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (midLen >= midBudget) break;
    const isImportant = /(?:error|exception|fail|failed|fatal|warn|traceback|at\s+\S+:\d+)/i.test(line)
      || (keywords.length > 0 && keywords.some((k) => line.toLowerCase().includes(k)));
    if (isImportant) {
      const tagged = `L${i + 1}: ${line.slice(0, 260)}`;
      midMatches.push(tagged);
      midLen += tagged.length + 1;
    }
  }

  const combined = `${head}\n\n... [KEY LINES SAMPLED: ${midMatches.length}] ...\n${midMatches.join('\n')}\n\n... [TAIL] ...\n${tail}`;
  return { text: combined.slice(0, maxChars), truncated: true };
}

function buildDistillSystemPrompt(mode = 'general') {
  switch (mode) {
    case 'error_log':
      return 'You are a concise technical log distiller. Extract: 1) Exact root error/exit code, 2) Exact file path and line numbers if present, 3) Failed assertion/command, 4) One-line cause. NEVER invent paths or symbols. Reply strictly in <= 12 compact bullets.';
    case 'docs':
      return 'You are a precise documentation distiller. Extract only actionable APIs, exact signatures, flags, limits, and constraints relevant to the user question. Preserve exact symbol names and URLs verbatim. Be ultra concise.';
    case 'code_digest':
      return 'You are a code reader assistant. Summarize exact responsibilities, exported functions, side effects, and dependencies with verbatim file:line citations. Omit boilerplate.';
    case 'qa':
      return 'Answer the user question strictly from the provided text with exact citations and zero filler.';
    default:
      return 'Compress the provided raw text into concise, high-signal technical facts. Preserve all file paths, symbol names, numbers, and error messages verbatim. No fluff.';
  }
}

/**
 * Прогоняет объёмный текст, лог или документацию через локальную LLM на RTX 4070 Ti SUPER.
 * @param {object} params
 * @param {string} params.text Исходный сырой текст
 * @param {string} [params.query=''] Конкретный вопрос / фокус сжатия
 * @param {string} [params.mode='general'] error_log | docs | code_digest | qa | general
 * @param {number} [params.maxOutputTokens=450]
 * @param {number} [params.timeoutMs=35000]
 * @param {string} [params.model]
 */
export async function distillText(rawParams = {}) {
  const {
    text = '',
    query = '',
    mode = 'general',
    maxOutputTokens = 450,
    timeoutMs = 35000,
    model = '',
    minFreeVramMb = 0,
    strictTimeout = false,
    workspaceRoot = '',
    _skipAtFile = false,
    lang = '',
    cfgOverride = null,
    httpJsonFn = null,
    hwProbeFn = null,
    useDistillCache = false,
    skipThermalGuard = false,
    _bypassCache = false,
  } = (rawParams && typeof rawParams === 'object' ? rawParams : {});
  const rawText = String(text || '');
  const trimmedText = rawText.trim();
  if (!trimmedText) {
    return { ok: false, error: 'Empty input text' };
  }

  if (!_skipAtFile && !trimmedText.includes('\n') && trimmedText.startsWith('@file:')) {
    const extractedPath = trimmedText.slice(6).trim().replace(/^["']|["']$/g, '');
    if (!extractedPath) {
      return { ok: false, error: 'Empty @file: path' };
    }
    return distillLocalFile({
      filePath: extractedPath,
      workspaceRoot,
      query,
      mode,
      maxOutputTokens,
      timeoutMs,
      model,
      minFreeVramMb,
      strictTimeout,
      lang,
      cfgOverride,
      httpJsonFn,
      hwProbeFn,
    });
  }

  const cfg = cfgOverride ? loadGpuConfig(cfgOverride) : loadGpuConfig();
  if (!cfg.gpuEnabled) {
    return { ok: false, error: 'GPU engine disabled' };
  }

  const callHttp = httpJsonFn || ollamaHttpJson;
  const requestedModel = model || cfg.gpuChatModel;
  const requestedTag = normalizeOllamaTag(requestedModel);
  const allowCache = !_bypassCache && (!httpJsonFn || useDistillCache);
  const normalizedText = rawText.replace(/\r\n/g, '\n').trim();
  const exactCacheKey = allowCache
    ? createHash('sha256')
        .update(`${requestedTag}|${mode}|${maxOutputTokens}|${query}|${normalizedText}`)
        .digest('hex')
    : '';
  const errorSimHash = allowCache && mode === 'error_log' ? computeErrorLogSimHash64(normalizedText) : null;

  if (allowCache) {
    ensureDistillCacheLoaded();
    let hitEntry = getFreshDistillCacheEntry(exactCacheKey);
    if (!hitEntry && mode === 'error_log' && errorSimHash) {
      const now = Date.now();
      for (const [k, entry] of ramDistillCache.entries()) {
        if (!entry || entry.kind !== 'distill') continue;
        if ((now - (entry.ts || 0)) >= RAM_DISTILL_CACHE_TTL_MS) continue;
        if (
          entry.requestedTag !== requestedTag ||
          entry.mode !== 'error_log' ||
          entry.maxOutputTokens !== maxOutputTokens ||
          entry.query !== query ||
          entry.simhashHi == null ||
          entry.simhashLo == null
        ) {
          continue;
        }
        const lenRatio = normalizedText.length / Math.max(1, entry.textLen || 1);
        if (lenRatio < 0.9 || lenRatio > 1.1) continue;
        if (hammingDistance64(errorSimHash.hi, errorSimHash.lo, entry.simhashHi, entry.simhashLo) <= 2) {
          hitEntry = getFreshDistillCacheEntry(k);
          break;
        }
      }
    }
    if (hitEntry && hitEntry.res) {
      recordGpuTelemetryPatch((cur) => ({
        ...cur,
        distillCacheHits: (cur.distillCacheHits || 0) + 1,
        savedTokensEstimate: (cur.savedTokensEstimate || 0) + (hitEntry.res.savedTokensEstimate || 0),
      }));
      return { ...hitEntry.res, fromRamCache: true, latencyMs: 0.2 };
    }
  }

  const rawHash = createHash('sha1').update(rawText).digest('hex');
  const dedupKey = createHash('sha1')
    .update(`${requestedTag}|${cfg.gpuMaxVramMb}|${cfg.gpuEndpoint || ''}|${mode}|${maxOutputTokens}|${query}|${rawText.length}|${rawHash}`)
    .digest('hex')
    .slice(0, 20);
  if (!httpJsonFn && inFlightDistillMap.has(dedupKey)) {
    return inFlightDistillMap.get(dedupKey);
  }

  const runPromise = (async () => {
    const hw = hwProbeFn ? hwProbeFn() : probeNvidiaGpu();
    if (!skipThermalGuard) {
      const thermalGuard = evaluateGpuThermalAndLoadGuard(hw, { isBackground: false });
      if (thermalGuard.throttled) {
        return {
          ok: false,
          skippedThermalGuard: true,
          thermalReason: thermalGuard.reason,
          tempC: thermalGuard.tempC,
          utilPct: thermalGuard.utilPct,
          error: thermalGuard.message,
        };
      }
    }

    if (!httpJsonFn) {
      const ready = await ensureOllamaRunning(cfg);
      if (!ready.ok) {
        return { ok: false, error: ready.error || 'Ollama not reachable' };
      }
    }

    const psRes = await callHttp('GET', '/api/ps', null, 800, cfg.gpuEndpoint);
    let loadedModels = Array.isArray(psRes?.data?.models) ? psRes.data.models : [];

    let tagSource = null;
    if (httpJsonFn) {
      const tagsRes = await callHttp('GET', '/api/tags', null, 800, cfg.gpuEndpoint);
      tagSource = tagsRes?.ok && Array.isArray(tagsRes.data?.models) ? tagsRes.data.models : null;
    } else {
      tagSource = await getCachedOrFetchOllamaTagMap(cfg);
    }

    const fit = evaluateVramModelFit({
      cfg: { ...cfg, gpuChatModel: requestedModel },
      tagModels: tagSource,
      loadedModels,
      hw,
    });
    const tagInventoryKnown = Array.isArray(tagSource) || (tagSource instanceof Map && tagSource.size > 0);

    let targetModel = requestedModel;
    if (fit.selectedSizeFits && (!tagInventoryKnown || fit.selectedChatDownloaded)) {
      targetModel = requestedModel;
    } else if (!model && fit.bestFallbackChatModel) {
      targetModel = fit.bestFallbackChatModel;
    } else {
      await unloadModelsExceedingBudget({ cfg, loadedModels, tagModels: tagSource, hw, callHttp });
      return {
        ok: false,
        skippedVramCap: true,
        needsModelDownload: fit.needsModelDownload,
        recommendedPullModel: fit.recommendedPullModel,
        error: (normalizeLang(lang || cfg.uiLanguage || readActiveUiLanguage(), 'en') === 'en')
          ? (fit.reasonEn || fit.reasonRu || `Model ${requestedModel} exceeds the ${fit.capGb} GB VRAM limit`)
          : (fit.reasonRu || fit.reasonEn || `Модель ${requestedModel} превышает лимит ${fit.capGb} ГБ VRAM`),
      };
    }

    const targetTag = normalizeOllamaTag(targetModel);
    const targetEstVramMb = estimateModelVramMb(targetModel, tagSource, [], cfg.gpuEmbedModel);
    const unloadRes = await unloadModelsExceedingBudget({
      cfg,
      loadedModels,
      tagModels: tagSource,
      hw,
      callHttp,
      reserveForModel: { name: targetModel, estVramMb: targetEstVramMb, isEmbed: false },
    });
    loadedModels = unloadRes.remainingRaw;
    const ollamaLoadedMb = unloadRes.loadedVramMb;
    const isModelWarm = loadedModels.some((m) => normalizeOllamaTag(m?.name || m?.model || '') === targetTag);

    if (minFreeVramMb > 0 && !isModelWarm && hw?.available && (hw.freeMb + ollamaLoadedMb) < minFreeVramMb) {
      return {
        ok: false,
        skippedLowVram: true,
        error: `Insufficient free VRAM (${hw.freeMb}MB + ${ollamaLoadedMb}MB < ${minFreeVramMb}MB)`,
      };
    }

    const numCtx = computeSafeNumCtx(cfg, hw, loadedModels, rawText.length + (query?.length || 0), tagSource);
    const effectiveTimeoutMs = strictTimeout
      ? clampInt(timeoutMs, 1500, 60000, 11500)
      : (isModelWarm ? Math.max(timeoutMs, 20000) : Math.max(timeoutMs, 55000));
    const maxInputChars = Math.max(4000, Math.floor((numCtx - maxOutputTokens - 500) * 2.6));
    const bounded = prepareBoundedInput(rawText, query, maxInputChars);

    const userMsg = query && query.trim()
      ? `FOCUS QUESTION: ${query.trim()}\n\nRAW INPUT (${rawText.length} chars):\n${bounded.text}`
      : `Compress and extract key technical facts from this input (${rawText.length} chars):\n${bounded.text}`;

    const body = {
      model: targetModel,
      stream: false,
      keep_alive: cfg.gpuKeepAlive,
      messages: [
        { role: 'system', content: buildDistillSystemPrompt(mode) },
        { role: 'user', content: userMsg },
      ],
      options: {
        num_ctx: numCtx,
        num_predict: clampInt(maxOutputTokens, 64, 2048, 450),
        temperature: 0.1,
      },
    };
    if (/qwen3|gemma4|deepseek/i.test(targetModel)) {
      body.think = false;
    }

    const t0 = Date.now();
    let chatRes = await callHttp('POST', '/api/chat', body, effectiveTimeoutMs, cfg.gpuEndpoint);
    if (!chatRes.ok && Object.hasOwn(body, 'think') && /think/i.test(String(chatRes.error || ''))) {
      delete body.think;
      chatRes = await callHttp('POST', '/api/chat', body, effectiveTimeoutMs, cfg.gpuEndpoint);
    }
    const latencyMs = Date.now() - t0;

    if (!chatRes.ok) {
      return { ok: false, error: chatRes.error || 'Ollama /api/chat failed', latencyMs };
    }

    const distilled = stripReasoningTags(String(chatRes.data?.message?.content || '')).trim();
    if (!distilled) {
      return { ok: false, error: 'Ollama /api/chat returned empty content', latencyMs };
    }
    const savedChars = Math.max(0, rawText.length - distilled.length);
    const savedTokensEstimate = Math.round(savedChars / 3.8);

    if (!httpJsonFn) {
      recordGpuTelemetryPatch((cur) => ({
        ...cur,
        distillCalls: (cur.distillCalls || 0) + 1,
        rawCharsProcessed: (cur.rawCharsProcessed || 0) + rawText.length,
        distilledCharsReturned: (cur.distilledCharsReturned || 0) + distilled.length,
        savedChars: (cur.savedChars || 0) + savedChars,
        savedTokensEstimate: (cur.savedTokensEstimate || 0) + savedTokensEstimate,
        lastLatencyMs: latencyMs,
        lastModel: targetModel,
        lastMode: mode,
        lastAt: new Date().toISOString(),
      }));
    }

    const resultObj = {
      ok: true,
      model: targetModel,
      autoSwitchedFrom: targetModel !== requestedModel ? requestedModel : undefined,
      mode,
      numCtx,
      truncatedInput: bounded.truncated,
      originalChars: rawText.length,
      distilledChars: distilled.length,
      savedChars,
      savedTokensEstimate,
      latencyMs,
      promptEvalCount: chatRes.data?.prompt_eval_count || 0,
      evalCount: chatRes.data?.eval_count || 0,
      summary: distilled,
    };

    if (allowCache) {
      setDistillCacheEntry(exactCacheKey, {
        kind: 'distill',
        ts: Date.now(),
        requestedTag,
        mode,
        maxOutputTokens,
        query,
        textLen: normalizedText.length,
        simhashHi: errorSimHash ? errorSimHash.hi : null,
        simhashLo: errorSimHash ? errorSimHash.lo : null,
        res: resultObj,
      });
    }

    return resultObj;
  })();

  if (httpJsonFn) {
    return runPromise;
  }
  inFlightDistillMap.set(dedupKey, runPromise);
  try {
    return await runPromise;
  } finally {
    if (inFlightDistillMap.get(dedupKey) === runPromise) {
      inFlightDistillMap.delete(dedupKey);
    }
  }
}

/**
 * Читает локальный файл/лог с диска с проверкой Security Guard и прогоняет через локальную GPU-модель
 * без траты облачных входных или выходных токенов на передачу сырого текста.
 * @param {object} params
 */
/**
 * Decodes a text buffer while transparently supporting UTF-16LE/BE (with or without BOM)
 * and UTF-8 BOM, rejecting true binary buffers containing NUL bytes.
 * @param {Buffer} buf
 * @param {number} [maxProbe=4096]
 * @returns {{ ok: boolean, encoding?: string, text?: string, error?: string }}
 */
export function decodeTextBufferAutoUtf(buf, maxProbe = 4096) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) {
    return { ok: true, encoding: 'utf8', text: '' };
  }
  const probeLen = Math.min(buf.length, Math.max(16, Number(maxProbe) || 4096));

  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return {
      ok: true,
      encoding: 'utf16le',
      text: buf.subarray(2).toString('utf16le').replace(/^\uFEFF/, ''),
    };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const body = Buffer.from(buf.subarray(2));
    for (let i = 0; i + 1 < body.length; i += 2) {
      const tmp = body[i];
      body[i] = body[i + 1];
      body[i + 1] = tmp;
    }
    return {
      ok: true,
      encoding: 'utf16be',
      text: body.toString('utf16le').replace(/^\uFEFF/, ''),
    };
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    const afterBom = buf.subarray(3);
    if (afterBom.subarray(0, Math.min(afterBom.length, probeLen)).includes(0)) {
      return { ok: false, error: 'Binary file detected (NUL bytes in header); distillation skipped' };
    }
    return {
      ok: true,
      encoding: 'utf8-bom',
      text: afterBom.toString('utf8'),
    };
  }

  const probe = buf.subarray(0, probeLen);
  if (probe.includes(0)) {
    if (buf.length >= 4) {
      let evenZeros = 0;
      let oddZeros = 0;
      const pairs = Math.floor(probe.length / 2);
      for (let i = 0; i + 1 < probe.length; i += 2) {
        if (probe[i] === 0) evenZeros++;
        if (probe[i + 1] === 0) oddZeros++;
      }
      if (evenZeros === 0 && pairs > 0 && oddZeros >= Math.floor(pairs * 0.4)) {
        return {
          ok: true,
          encoding: 'utf16le',
          text: buf.toString('utf16le').replace(/^\uFEFF/, ''),
        };
      }
    }
    return { ok: false, error: 'Binary file detected (NUL bytes in header); distillation skipped' };
  }

  return { ok: true, encoding: 'utf8', text: buf.toString('utf8') };
}

function decodeTailSliceWithEncoding(buf, encoding = 'utf8') {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return '';
  if (encoding === 'utf16le') {
    const evenLen = buf.length - (buf.length % 2);
    return buf.subarray(0, evenLen).toString('utf16le');
  }
  if (encoding === 'utf16be') {
    const evenLen = buf.length - (buf.length % 2);
    const copy = Buffer.from(buf.subarray(0, evenLen));
    for (let i = 0; i + 1 < copy.length; i += 2) {
      const tmp = copy[i];
      copy[i] = copy[i + 1];
      copy[i + 1] = tmp;
    }
    return copy.toString('utf16le');
  }
  return buf.toString('utf8');
}

export async function distillLocalFile(rawOpts = {}) {
  const {
    filePath = '',
    workspaceRoot = '',
    startLine = 0,
    endLine = 0,
    query = '',
    mode = 'general',
    maxOutputTokens = 450,
    timeoutMs = 35000,
    model = '',
    minFreeVramMb = 0,
    strictTimeout = false,
    lang = '',
    cfgOverride = null,
    httpJsonFn = null,
    hwProbeFn = null,
  } = (rawOpts && typeof rawOpts === 'object' ? rawOpts : {});
  if (typeof filePath !== 'string' || !filePath.trim() || filePath.includes('\0')) {
    return { ok: false, error: 'Invalid filePath' };
  }
  const cleanFilePath = filePath.trim();
  const wsRoot = workspaceRoot ? path.resolve(workspaceRoot) : process.cwd();
  const absPath = path.isAbsolute(cleanFilePath) ? path.resolve(cleanFilePath) : path.resolve(wsRoot, cleanFilePath);

  const sec = checkFileSecurity({ filePath: absPath, workspaceRoot: wsRoot, toolName: 'gpu_distill' });
  if (!sec.allow) {
    return { ok: false, blocked: true, error: sec.reason || 'Access denied by Security Guard' };
  }

  let st;
  try {
    if (!existsSync(absPath)) {
      return { ok: false, error: `File not found: ${absPath}` };
    }
    st = statSync(absPath);
    if (!st.isFile()) {
      return { ok: false, error: `Not a regular file: ${absPath}` };
    }
  } catch (err) {
    return { ok: false, error: `Cannot stat file: ${err.message}` };
  }

  const MAX_FULL_READ_BYTES = 2 * 1024 * 1024;
  let rawText = '';
  let lineStartOffset = 1;
  try {
    if (st.size <= MAX_FULL_READ_BYTES) {
      const buf = readFileSync(absPath);
      const decoded = decodeTextBufferAutoUtf(buf, 4096);
      if (!decoded.ok) {
        return { ok: false, error: decoded.error || 'Binary file detected (NUL bytes in header); distillation skipped' };
      }
      rawText = decoded.text;
    } else {
      const wantSlice = Number(startLine) > 0 || Number(endLine) > 0;
      const headBytes = 512 * 1024;
      const tailBytes = 1536 * 1024;
      const fd = openSync(absPath, 'r');
      try {
        if (wantSlice && Number(startLine) >= 1) {
          const sReq = Math.max(1, Number(startLine) || 1);
          const eReq = Number(endLine) > 0 ? Math.max(sReq, Number(endLine)) : sReq + 500;
          const CHUNK_SIZE = 256 * 1024;
          const readBuf = Buffer.alloc(CHUNK_SIZE);
          let pos = 0;
          let curLine = 1;
          let carry = '';
          const collected = [];
          let collectedBytes = 0;
          const probeBytes = readSync(fd, readBuf, 0, Math.min(4096, st.size), 0);
          const probeRes = decodeTextBufferAutoUtf(readBuf.subarray(0, probeBytes), 4096);
          if (!probeRes.ok) {
            return { ok: false, error: probeRes.error || 'Binary file detected (NUL bytes in header); distillation skipped' };
          }
          if (probeRes.encoding === 'utf8' || probeRes.encoding === 'utf8bom') {
            pos = probeRes.encoding === 'utf8bom' ? 3 : 0;
            while (pos < st.size && curLine <= eReq && collectedBytes < MAX_FULL_READ_BYTES) {
              const n = readSync(fd, readBuf, 0, Math.min(CHUNK_SIZE, st.size - pos), pos);
              if (n <= 0) break;
              pos += n;
              const str = carry + readBuf.subarray(0, n).toString('utf8');
              const parts = str.split(/\r?\n/);
              carry = pos < st.size ? (parts.pop() ?? '') : '';
              for (const ln of parts) {
                if (curLine >= sReq && curLine <= eReq) {
                  collected.push(ln);
                  collectedBytes += Buffer.byteLength(ln, 'utf8') + 1;
                  if (collectedBytes >= MAX_FULL_READ_BYTES) break;
                }
                curLine++;
              }
            }
            if (carry && curLine >= sReq && curLine <= eReq && collectedBytes < MAX_FULL_READ_BYTES) {
              collected.push(carry);
            }
            rawText = collected.join('\n');
            lineStartOffset = sReq;
          }
        }
        if (!rawText) {
          const headBuf = Buffer.alloc(headBytes);
          const headRead = readSync(fd, headBuf, 0, headBytes, 0);
          const headDecoded = decodeTextBufferAutoUtf(headBuf.subarray(0, headRead), 4096);
          if (!headDecoded.ok) {
            return { ok: false, error: headDecoded.error || 'Binary file detected (NUL bytes in header); distillation skipped' };
          }
          const tailBuf = Buffer.alloc(tailBytes);
          let tailPos = Math.max(headRead, st.size - tailBytes);
          if ((headDecoded.encoding === 'utf16le' || headDecoded.encoding === 'utf16be') && (tailPos % 2 !== 0)) {
            tailPos = Math.max(headRead, tailPos - 1);
          }
          const tailRead = readSync(fd, tailBuf, 0, tailBytes, tailPos);
          const tailText = decodeTailSliceWithEncoding(tailBuf.subarray(0, tailRead), headDecoded.encoding);
          rawText = `${headDecoded.text}\n\n... [TRUNCATED LARGE FILE: ${st.size} bytes] ...\n\n${tailText}`;
        }
      } finally {
        try { closeSync(fd); } catch {}
      }
    }
  } catch (err) {
    return { ok: false, error: `Failed to read file: ${err.message}` };
  }

  if (st.size <= MAX_FULL_READ_BYTES && (Number(startLine) > 0 || Number(endLine) > 0)) {
    const allLines = rawText.split(/\r?\n/);
    const s = Math.max(1, Number(startLine) || 1);
    const e = Math.min(allLines.length, Number(endLine) > 0 ? Number(endLine) : allLines.length);
    if (s <= e) {
      rawText = allLines.slice(s - 1, e).join('\n');
      lineStartOffset = s;
    }
  }

  const ext = path.extname(absPath).toLowerCase();
  let effectiveMode = mode && mode !== 'general' ? mode : 'general';
  if (effectiveMode === 'general') {
    if (['.log', '.err', '.out'].includes(ext)) effectiveMode = 'error_log';
    else if (['.md', '.txt', '.rst'].includes(ext)) effectiveMode = 'docs';
    else if (['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs', '.java', '.cpp', '.c'].includes(ext)) {
      effectiveMode = 'code_digest';
    }
  }

  let formattedContent = redactSecretsInText(rawText);
  if (st.size <= MAX_FULL_READ_BYTES && (effectiveMode === 'code_digest' || effectiveMode === 'error_log')) {
    const lines = formattedContent.split(/\r?\n/);
    if (lines.length <= 2500) {
      formattedContent = lines.map((line, idx) => `L${lineStartOffset + idx}: ${line}`).join('\n');
    }
  }

  const res = await distillText({
    text: formattedContent,
    query,
    mode: effectiveMode,
    maxOutputTokens,
    timeoutMs,
    model,
    minFreeVramMb,
    strictTimeout,
    lang,
    workspaceRoot: wsRoot,
    _skipAtFile: true,
    cfgOverride,
    httpJsonFn,
    hwProbeFn,
  });

  return { ...res, sourceFile: absPath };
}

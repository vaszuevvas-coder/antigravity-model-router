/**
 * @file gpu-vram-runtime.mjs
 * @description VRAM budgeting, Ollama lifecycle, host RAM warmup, status snapshot, and cascade model pulls.
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import { join } from 'node:path';
import { normalizeLang, pickLang, readActiveUiLanguage } from '../i18n.mjs';
import { HF_GGUF_FALLBACK_MAP, buildGpuCascadeBundleForHardware, probeAnyGpu, resolveGpuModelPairForVramCap } from '../hardware-profiler.mjs';
import { atomicWriteJsonSync, safeReadJsonSync } from '../safe-json.mjs';
import {
  CACHE_DIR,
  DEFAULT_GPU_CONFIG,
  GPU_PULL_STATUS_FILE,
  HOST_RAM_WARM_COOLDOWN_MS,
  OLLAMA_BIN_TTL_MS,
  OLLAMA_SPAWN_COOLDOWN_MS,
  OLLAMA_TAGS_TTL_MS,
  clampInt,
  destroyOllamaKeepAliveAgents,
  getGpuLiveActivity,
  getGpuTelemetry,
  gpuRuntime,
  isLocalChatActive,
  isProcessAliveSafe,
  keepAliveHttpAgent,
  keepAliveHttpsAgent,
  loadGpuConfig,
  ollamaHttpJson,
  probeNvidiaGpu,
  ramDistillCache,
  recordGpuTelemetryPatch,
  resolveDefaultGpuModelsDir,
  sameEmbedModel,
} from './gpu-shared-state.mjs';
export { probeNvidiaGpu };

export function normalizeOllamaTag(name = '') {
  const clean = String(name || '').trim().toLowerCase();
  if (!clean) return '';
  return clean.includes(':') ? clean : `${clean}:latest`;
}

function updateOllamaTagsCache(endpoint, rawTagModels = []) {
  if (!Array.isArray(rawTagModels)) return gpuRuntime.ollamaTagsCache.map;
  const nextMap = new Map();
  for (const m of rawTagModels) {
    const norm = normalizeOllamaTag(m?.name || m?.model || '');
    const bytes = Number(m?.size) > 0
      ? Number(m.size)
      : Math.round((Number(m?.sizeGb) || 0) * (1024 ** 3));
    if (norm && bytes > 0) {
      nextMap.set(norm, bytes);
    }
  }
  gpuRuntime.ollamaTagsCache = {
    ts: Date.now(),
    endpoint: String(endpoint || ''),
    map: nextMap,
  };
  return nextMap;
}

export async function getCachedOrFetchOllamaTagMap(cfg) {
  const endpoint = String(cfg?.gpuEndpoint || DEFAULT_GPU_CONFIG.gpuEndpoint);
  if (
    gpuRuntime.ollamaTagsCache.map.size > 0 &&
    gpuRuntime.ollamaTagsCache.endpoint === endpoint &&
    (Date.now() - gpuRuntime.ollamaTagsCache.ts) < OLLAMA_TAGS_TTL_MS
  ) {
    return gpuRuntime.ollamaTagsCache.map;
  }
  const tagsRes = await ollamaHttpJson('GET', '/api/tags', null, 700, endpoint);
  if (tagsRes.ok && Array.isArray(tagsRes.data?.models)) {
    return updateOllamaTagsCache(endpoint, tagsRes.data.models);
  }
  return gpuRuntime.ollamaTagsCache.endpoint === endpoint ? gpuRuntime.ollamaTagsCache.map : new Map();
}

/**
 * Reconciles Ollama /api/ps VRAM figures with /api/tags total model size and physical GPU usage.
 * Workaround for Ollama llamacpp runner reporting only KV/draft buffer (~0.85 GB) for multimodal models.
 * @param {Array<object>} [psModels=[]]
 * @param {Array<object>|Map<string, number>|null} [tagModelsOrMap=null]
 * @param {object|null} [hw=null]
 */
export function reconcileLoadedModelsVram(psModels = [], tagModelsOrMap = null, hw = null) {
  const tagBytesMap = new Map();
  if (tagModelsOrMap instanceof Map) {
    for (const [k, v] of tagModelsOrMap.entries()) {
      const norm = normalizeOllamaTag(k);
      const bytes = Math.max(0, Number(v) || 0);
      if (norm && bytes > 0) tagBytesMap.set(norm, bytes);
    }
  } else if (Array.isArray(tagModelsOrMap) && tagModelsOrMap.length > 0) {
    for (const m of tagModelsOrMap) {
      const norm = normalizeOllamaTag(m?.name || m?.model || '');
      const bytes = Number(m?.size) > 0
        ? Number(m.size)
        : Math.round((Number(m?.sizeGb) || 0) * (1024 ** 3));
      if (norm && bytes > 0) tagBytesMap.set(norm, bytes);
    }
  }
  if (tagBytesMap.size === 0 && gpuRuntime.ollamaTagsCache.map.size > 0) {
    for (const [k, v] of gpuRuntime.ollamaTagsCache.map.entries()) {
      tagBytesMap.set(k, v);
    }
  }

  const list = Array.isArray(psModels) ? psModels : [];
  const items = list.map((m) => {
    const name = String(m?.name || m?.model || '');
    const normTag = normalizeOllamaTag(name);
    const psSize = Math.max(0, Number(m?.size) || 0);
    const psVram = Math.max(0, Number(m?.size_vram) || 0);
    const rawVramMb = typeof m?.rawVramMb === 'number'
      ? m.rawVramMb
      : (psVram > 0 ? Math.round(psVram / (1024 * 1024)) : Math.max(0, Number(m?.vramMb) || 0));
    const expiresAt = m?.expiresAt || m?.expires_at || null;

    if (m?.reconciledVram === true && typeof m?.vramMb === 'number') {
      return {
        name,
        vramMb: m.vramMb,
        rawVramMb,
        reconciledCandidate: m.vramMb > rawVramMb,
        expiresAt,
      };
    }

    const tagSize = tagBytesMap.get(normTag) || 0;
    const isUnderReported = tagSize > 0 && psVram > 0 && psSize > 0 && psSize < tagSize * 0.85;
    let vramMb = rawVramMb;
    if (isUnderReported) {
      const offloadRatio = Math.min(1, Math.max(0, psVram / psSize));
      vramMb = Math.max(rawVramMb, Math.round(((tagSize + psSize) * offloadRatio) / (1024 * 1024)));
    }

    return {
      name,
      vramMb,
      rawVramMb,
      reconciledCandidate: isUnderReported && vramMb > rawVramMb,
      expiresAt,
    };
  });

  if (hw?.available && hw?.vramReliable && Number(hw.usedMb) > 0) {
    let fixedMb = 0;
    let reconciledSumMb = 0;
    let rawReconciledSum = 0;
    for (const item of items) {
      if (item.reconciledCandidate) {
        reconciledSumMb += item.vramMb;
        rawReconciledSum += item.rawVramMb;
      } else {
        fixedMb += item.vramMb;
      }
    }
    if (fixedMb + reconciledSumMb > Number(hw.usedMb) && reconciledSumMb > 0) {
      const availForReconciled = Math.max(0, Number(hw.usedMb) - fixedMb);
      const targetCap = Math.max(rawReconciledSum, availForReconciled);
      let adjustedSum = 0;
      for (const item of items) {
        if (!item.reconciledCandidate) continue;
        const scaled = Math.round((item.vramMb / reconciledSumMb) * availForReconciled);
        item.vramMb = Math.max(Math.min(item.rawVramMb, availForReconciled), scaled);
        adjustedSum += item.vramMb;
      }
      if (adjustedSum > targetCap) {
        let excess = adjustedSum - targetCap;
        const candidates = items
          .filter((item) => item.reconciledCandidate && item.vramMb > 0)
          .sort((a, b) => b.vramMb - a.vramMb);
        for (const item of candidates) {
          if (excess <= 0) break;
          const floor = Math.min(item.rawVramMb, availForReconciled);
          const reducible = Math.max(0, item.vramMb - floor);
          const cut = Math.min(excess, reducible);
          item.vramMb -= cut;
          excess -= cut;
        }
      }
    }
  }

  const loadedModels = items.map((item) => ({
    name: item.name,
    vramMb: item.vramMb,
    rawVramMb: item.rawVramMb,
    reconciledVram: Boolean(item.vramMb > item.rawVramMb),
    expiresAt: item.expiresAt,
  }));
  const loadedVramMb = loadedModels.reduce((sum, m) => sum + (m.vramMb || 0), 0);
  return { loadedModels, loadedVramMb };
}

export const VRAM_CAP_TOLERANCE_MB = 128;

export function isOllamaEmbedModel(name = '', configuredEmbed = '') {
  const raw = String(name || '').trim();
  if (!raw) return false;
  if (configuredEmbed && sameEmbedModel(raw, configuredEmbed)) return true;
  return /(?:^|[/:_-])(?:embed|embedding|bge|nomic|mxbai|snowflake|minilm|e5)/i.test(raw);
}

function buildTagBytesMapFromSource(tagModelsOrMap = null) {
  const map = new Map();
  if (tagModelsOrMap instanceof Map) {
    for (const [k, v] of tagModelsOrMap.entries()) {
      const norm = normalizeOllamaTag(k);
      const bytes = Math.max(0, Number(v) || 0);
      if (norm && bytes > 0) map.set(norm, { name: String(k), bytes });
    }
    return { map, hasExplicitList: map.size > 0 };
  }
  if (Array.isArray(tagModelsOrMap)) {
    for (const m of tagModelsOrMap) {
      const rawName = String(m?.name || m?.model || '').trim();
      const norm = normalizeOllamaTag(rawName);
      const bytes = Number(m?.size) > 0
        ? Number(m.size)
        : Math.round((Number(m?.sizeGb) || 0) * (1024 ** 3));
      if (norm && bytes > 0) map.set(norm, { name: rawName || norm, bytes });
    }
    return { map, hasExplicitList: true };
  }
  if (gpuRuntime.ollamaTagsCache.map.size > 0) {
    for (const [k, v] of gpuRuntime.ollamaTagsCache.map.entries()) {
      map.set(k, { name: k, bytes: Math.max(0, Number(v) || 0) });
    }
  }
  return { map, hasExplicitList: false };
}

/**
 * Estimates total VRAM footprint (MB) for an Ollama model using live /api/ps, /api/tags, or parameter tag heuristic.
 */
export function estimateModelVramMb(modelName = '', tagModelsOrMap = null, reconciledLoaded = [], configuredEmbed = '') {
  const norm = normalizeOllamaTag(modelName);
  if (!norm) return 0;

  if (Array.isArray(reconciledLoaded)) {
    const warm = reconciledLoaded.find((m) => normalizeOllamaTag(m?.name || m?.model || '') === norm);
    if (warm && Number(warm.vramMb) > 0) {
      return Math.round(Number(warm.vramMb));
    }
  }

  const { map } = buildTagBytesMapFromSource(tagModelsOrMap);
  const tagEntry = map.get(norm);
  const isEmbed = isOllamaEmbedModel(modelName, configuredEmbed);

  if (tagEntry && tagEntry.bytes > 0) {
    const diskMb = tagEntry.bytes / (1024 * 1024);
    return isEmbed
      ? Math.max(256, Math.round(diskMb * 1.15 + 250))
      : Math.max(512, Math.round(diskMb * 1.12 + 220));
  }

  // Fallback parameter-count heuristic when Ollama is sleeping or model is not yet pulled
  const paramMatch = /(?:^|[:_-])e?(\d+(?:\.\d+)?)b(?=$|[:_-])/i.exec(modelName);
  if (paramMatch) {
    const paramsB = Number(paramMatch[1]);
    if (Number.isFinite(paramsB) && paramsB > 0) {
      return isEmbed
        ? Math.max(256, Math.round(paramsB * 1100 + 250))
        : Math.max(600, Math.round(paramsB * 680 + 450));
    }
  }
  return 0;
}

export function recommendPullModelForCap(capMb = 4096) {
  const cap = Number(capMb) || 4096;
  if (cap < 11264) return 'qwen3:4b';
  return 'gemma4:12b';
}

/**
 * Selects the optimal installed Chat + Embed model pair for the configured VRAM budget (MB).
 * @param {{ capMb?: number, tagModels?: Array|Map|null, loadedModels?: Array, hw?: object|null }} [opts={}]
 */
export function selectBestInstalledPairForCap({
  capMb = 4096,
  tagModels = null,
  loadedModels = [],
  hw = null,
} = {}) {
  const cap = clampInt(capMb, 2048, 32768, 4096);
  const ideal = resolveGpuModelPairForVramCap(cap);
  const { loadedModels: recLoaded } = reconcileLoadedModelsVram(loadedModels, tagModels, hw);
  const { map: tagBytesMap } = buildTagBytesMapFromSource(tagModels);

  if (tagBytesMap.size === 0) {
    return {
      gpuChatModel: ideal.gpuChatModel,
      gpuEmbedModel: ideal.gpuEmbedModel,
      gpuContextTokens: ideal.gpuContextTokens,
      idealChat: ideal.gpuChatModel,
      idealEmbed: ideal.gpuEmbedModel,
      hasInventory: false,
    };
  }

  let embedPriority = ['qwen3-embedding:0.6b', 'qwen3-embedding:4b'];
  if (cap >= 20480) {
    embedPriority = ['qwen3-embedding:8b', 'qwen3-embedding:4b', 'qwen3-embedding:0.6b'];
  } else if ((cap >= 8192 && cap < 12288) || cap >= 14336) {
    embedPriority = ['qwen3-embedding:4b', 'qwen3-embedding:0.6b'];
  }

  const maxEmbedVramMb = Math.max(1200, cap - 1400);
  const downloadedEmbeds = [];
  for (const [, entry] of tagBytesMap.entries()) {
    if (!isOllamaEmbedModel(entry.name)) continue;
    const estVramMb = estimateModelVramMb(entry.name, tagModels, recLoaded, entry.name);
    if (estVramMb > 0 && estVramMb <= maxEmbedVramMb) {
      downloadedEmbeds.push({ name: entry.name, norm: normalizeOllamaTag(entry.name), estVramMb });
    }
  }

  let chosenEmbed = '';
  for (const pref of embedPriority) {
    const hit = downloadedEmbeds.find((m) => m.norm === normalizeOllamaTag(pref));
    if (hit) {
      chosenEmbed = hit.name;
      break;
    }
  }
  if (!chosenEmbed && downloadedEmbeds.length > 0) {
    downloadedEmbeds.sort((a, b) => a.estVramMb - b.estVramMb);
    chosenEmbed = downloadedEmbeds[0].name;
  }
  if (!chosenEmbed) {
    chosenEmbed = ideal.gpuEmbedModel;
  }

  const embedEstMb = estimateModelVramMb(chosenEmbed, tagModels, recLoaded, chosenEmbed) || 950;
  const chatBudgetMb = Math.max(1280, cap - Math.min(cap - 1280, embedEstMb));

  const downloadedChats = [];
  for (const [, entry] of tagBytesMap.entries()) {
    if (isOllamaEmbedModel(entry.name, chosenEmbed)) continue;
    const estVramMb = estimateModelVramMb(entry.name, tagModels, recLoaded, chosenEmbed);
    if (estVramMb > 0 && estVramMb <= (chatBudgetMb + VRAM_CAP_TOLERANCE_MB)) {
      downloadedChats.push({ name: entry.name, norm: normalizeOllamaTag(entry.name), estVramMb });
    }
  }

  const idealChatNorm = normalizeOllamaTag(ideal.gpuChatModel);
  const idealHit = downloadedChats.find((m) => m.norm === idealChatNorm);
  let chosenChat = idealHit ? idealHit.name : '';
  if (!chosenChat && downloadedChats.length > 0) {
    const familyScore = (n) => (/^(?:qwen3|gemma4|qwen2\.5-coder)/i.test(n) ? 1 : 0);
    downloadedChats.sort((a, b) => {
      if (Math.abs(b.estVramMb - a.estVramMb) > 128) return b.estVramMb - a.estVramMb;
      const fsDiff = familyScore(b.name) - familyScore(a.name);
      return fsDiff !== 0 ? fsDiff : b.estVramMb - a.estVramMb;
    });
    chosenChat = downloadedChats[0].name;
  }
  if (!chosenChat) {
    chosenChat = ideal.gpuChatModel;
  }

  return {
    gpuChatModel: chosenChat,
    gpuEmbedModel: chosenEmbed,
    gpuContextTokens: ideal.gpuContextTokens,
    idealChat: ideal.gpuChatModel,
    idealEmbed: ideal.gpuEmbedModel,
    chatBudgetMb,
    embedEstMb,
    hasInventory: true,
  };
}

/**
 * Evaluates whether configured chat/embed models and loaded VRAM fit within gpuMaxVramMb.
 */
export function evaluateVramModelFit({ cfg = {}, tagModels = null, loadedModels = [], hw = null } = {}) {
  const mergedCfg = { ...DEFAULT_GPU_CONFIG, ...(cfg || {}) };
  const capMb = clampInt(mergedCfg.gpuMaxVramMb, 2048, 32768, DEFAULT_GPU_CONFIG.gpuMaxVramMb);
  const capGb = Math.max(2, Math.round(capMb / 1024));
  const { loadedModels: recLoaded, loadedVramMb } = reconcileLoadedModelsVram(loadedModels, tagModels, hw);

  const { map: tagBytesMap, hasExplicitList } = buildTagBytesMapFromSource(tagModels);
  const downloadedList = [];
  for (const [normTag, entry] of tagBytesMap.entries()) {
    downloadedList.push({
      name: entry.name || normTag,
      normTag,
      sizeBytes: entry.bytes,
      sizeGb: Number((entry.bytes / (1024 ** 3)).toFixed(2)),
    });
  }

  let embedReserveMb = 0;
  if (mergedCfg.gpuSemanticSearch !== false && mergedCfg.gpuEmbedModel) {
    const embedEst = estimateModelVramMb(mergedCfg.gpuEmbedModel, tagModels, recLoaded, mergedCfg.gpuEmbedModel) || 950;
    const maxEmbedShareMb = Math.max(1536, Math.round(capMb * 0.45));
    embedReserveMb = embedEst <= capMb ? Math.min(maxEmbedShareMb, embedEst) : 0;
  }
  const chatVramBudgetMb = Math.max(1280, capMb - embedReserveMb);

  const selectedChatModel = String(mergedCfg.gpuChatModel || DEFAULT_GPU_CONFIG.gpuChatModel).trim();
  const selectedChatNorm = normalizeOllamaTag(selectedChatModel);
  const selectedChatDownloaded = downloadedList.some((m) => m.normTag === selectedChatNorm);
  const selectedChatEstVramMb = estimateModelVramMb(selectedChatModel, tagModels, recLoaded, mergedCfg.gpuEmbedModel);
  const selectedSizeFits = selectedChatEstVramMb === 0 || selectedChatEstVramMb <= (chatVramBudgetMb + VRAM_CAP_TOLERANCE_MB);
  const tagsInventoryKnown = hasExplicitList || downloadedList.length > 0;
  const selectedChatFits = selectedSizeFits && (!tagsInventoryKnown || selectedChatDownloaded);

  const compatibleChatModels = downloadedList
    .filter((m) => !isOllamaEmbedModel(m.name, mergedCfg.gpuEmbedModel))
    .map((m) => ({
      name: m.name,
      sizeGb: m.sizeGb,
      estVramMb: estimateModelVramMb(m.name, tagModels, recLoaded, mergedCfg.gpuEmbedModel),
    }))
    .filter((m) => m.estVramMb > 0 && m.estVramMb <= (chatVramBudgetMb + VRAM_CAP_TOLERANCE_MB))
    .sort((a, b) => b.estVramMb - a.estVramMb);

  const bestFallbackChatModel = compatibleChatModels[0]?.name || '';
  const overBudgetLoaded = loadedVramMb > (capMb + VRAM_CAP_TOLERANCE_MB);
  const needsModelDownload = Boolean(
    mergedCfg.gpuEnabled !== false &&
    (!selectedSizeFits || (tagsInventoryKnown && !selectedChatDownloaded)) &&
    compatibleChatModels.length === 0
  );
  const recommendedPullModel = recommendPullModelForCap(capMb);

  let reasonRu = '';
  let reasonEn = '';
  if (!selectedSizeFits && compatibleChatModels.length === 0) {
    const estGb = (selectedChatEstVramMb / 1024).toFixed(1);
    reasonRu = `Модель ${selectedChatModel} (~${estGb} ГБ в VRAM) превышает установленный лимит ${capGb} ГБ. Подходящей компактной модели в Ollama не найдено (рекомендуется ${recommendedPullModel}).`;
    reasonEn = `Model ${selectedChatModel} (~${estGb} GB VRAM) exceeds configured ${capGb} GB limit. No suitable compact model found in Ollama (recommended: ${recommendedPullModel}).`;
  } else if (!selectedSizeFits && bestFallbackChatModel) {
    const estGb = (selectedChatEstVramMb / 1024).toFixed(1);
    reasonRu = `Модель ${selectedChatModel} (~${estGb} ГБ в VRAM) превышает лимит ${capGb} ГБ — автопилот использует совместимую ${bestFallbackChatModel}.`;
    reasonEn = `Model ${selectedChatModel} (~${estGb} GB VRAM) exceeds ${capGb} GB limit — autopilot will use compatible ${bestFallbackChatModel}.`;
  } else if (tagsInventoryKnown && !selectedChatDownloaded && compatibleChatModels.length === 0) {
    reasonRu = `Модель ${selectedChatModel} не скачана в Ollama — требуется загрузка модели под лимит ${capGb} ГБ (например, ${recommendedPullModel}).`;
    reasonEn = `Model ${selectedChatModel} is not downloaded in Ollama — pull a model within the ${capGb} GB cap (e.g., ${recommendedPullModel}).`;
  }

  return {
    capMb,
    capGb,
    chatVramBudgetMb,
    embedReserveMb,
    loadedVramMb,
    overBudgetLoaded,
    selectedChatModel,
    selectedChatDownloaded,
    selectedChatEstVramMb,
    selectedSizeFits,
    selectedChatFits,
    compatibleChatModels,
    bestFallbackChatModel,
    needsModelDownload,
    recommendedPullModel,
    reasonRu,
    reasonEn,
  };
}

async function unloadSingleOllamaModel(name, cfg, callHttp = ollamaHttpJson) {
  if (!name) return false;
  const isEmbed = isOllamaEmbedModel(name, cfg.gpuEmbedModel);
  const res = isEmbed
    ? await callHttp('POST', '/api/embed', { model: name, input: '', keep_alive: 0 }, 2500, cfg.gpuEndpoint)
    : await callHttp('POST', '/api/generate', { model: name, prompt: '', keep_alive: 0, stream: false }, 2500, cfg.gpuEndpoint);
  return Boolean(res?.ok !== false);
}

export async function unloadModelsExceedingBudget({
  cfg,
  loadedModels = [],
  tagModels = null,
  hw = null,
  callHttp = ollamaHttpJson,
  reserveForModel = null,
} = {}) {
  const capMb = clampInt(cfg.gpuMaxVramMb, 2048, 32768, DEFAULT_GPU_CONFIG.gpuMaxVramMb);
  const rec = reconcileLoadedModelsVram(loadedModels, tagModels, hw);
  const fitPre = evaluateVramModelFit({ cfg, tagModels, loadedModels: rec.loadedModels, hw });

  const reserveTag = reserveForModel?.name ? normalizeOllamaTag(reserveForModel.name) : '';
  const reserveEstMb = Number(reserveForModel?.estVramMb) || 0;
  const reserveIsLoaded = Boolean(
    reserveTag && rec.loadedModels.some((m) => normalizeOllamaTag(m?.name || '') === reserveTag)
  );
  const incomingMb = reserveIsLoaded ? 0 : reserveEstMb;

  const toUnload = new Set();
  const kept = [];
  const activeChatNorm = normalizeOllamaTag(cfg.gpuChatModel);
  const activeEmbedNorm = normalizeOllamaTag(cfg.gpuEmbedModel);

  for (const m of rec.loadedModels) {
    const normName = normalizeOllamaTag(m.name);
    const isEmbed = isOllamaEmbedModel(m.name, cfg.gpuEmbedModel);
    const exceedsSingle = m.vramMb > (capMb + VRAM_CAP_TOLERANCE_MB);
    const exceedsChatBudget = !isEmbed && m.vramMb > (fitPre.chatVramBudgetMb + VRAM_CAP_TOLERANCE_MB);
    const isStaleNonActive =
      !reserveTag &&
      Boolean(normName) &&
      normName !== activeChatNorm &&
      normName !== activeEmbedNorm &&
      (isEmbed || rec.loadedVramMb > (capMb * 0.75));
    if (exceedsSingle || exceedsChatBudget || isStaleNonActive) {
      toUnload.add(m.name);
    } else {
      kept.push(m);
    }
  }

  let keptSumMb = kept.reduce((s, m) => s + (m.vramMb || 0), 0);
  if ((keptSumMb + incomingMb) > (capMb + VRAM_CAP_TOLERANCE_MB) && kept.length > 0) {
    // Evict non-target models (chat models before embedder, largest first) until budget is met
    const evictOrder = kept
      .filter((m) => !reserveTag || normalizeOllamaTag(m.name) !== reserveTag)
      .sort((a, b) => {
        const aEmb = isOllamaEmbedModel(a.name, cfg.gpuEmbedModel) ? 1 : 0;
        const bEmb = isOllamaEmbedModel(b.name, cfg.gpuEmbedModel) ? 1 : 0;
        if (aEmb !== bEmb) return aEmb - bEmb;
        return (b.vramMb || 0) - (a.vramMb || 0);
      });
    for (const cand of evictOrder) {
      if ((keptSumMb + incomingMb) <= (capMb + VRAM_CAP_TOLERANCE_MB)) break;
      toUnload.add(cand.name);
      keptSumMb -= (cand.vramMb || 0);
    }
  }

  const unloaded = [];
  if (toUnload.size > 0) {
    await Promise.all(
      Array.from(toUnload).map(async (name) => {
        await unloadSingleOllamaModel(name, cfg, callHttp);
        unloaded.push(name);
      })
    );
  }

  const remainingRaw = Array.isArray(loadedModels)
    ? loadedModels.filter((m) => !toUnload.has(m?.name || m?.model || ''))
    : [];
  const remainingRec = rec.loadedModels.filter((m) => !toUnload.has(m.name));
  return {
    unloaded,
    remainingRaw,
    remainingRec,
    loadedVramMb: remainingRec.reduce((s, m) => s + (m.vramMb || 0), 0),
  };
}

/**
 * Unloads currently warm Ollama models that violate gpuMaxVramMb and returns updated VRAM fit status.
 */
export async function enforceVramCapInOllama({ cfgOverride = null, httpJsonFn = null, hwProbeFn = null } = {}) {
  const cfg = cfgOverride ? loadGpuConfig(cfgOverride) : loadGpuConfig();
  const callHttp = httpJsonFn || ollamaHttpJson;
  const hw = hwProbeFn ? hwProbeFn() : probeNvidiaGpu();

  const [psRes, tagsRes] = await Promise.all([
    callHttp('GET', '/api/ps', null, 800, cfg.gpuEndpoint),
    callHttp('GET', '/api/tags', null, 800, cfg.gpuEndpoint),
  ]);

  const tagModels = tagsRes?.ok && Array.isArray(tagsRes.data?.models) ? tagsRes.data.models : null;
  if (tagModels && !httpJsonFn) {
    updateOllamaTagsCache(cfg.gpuEndpoint, tagModels);
  }

  if (!psRes?.ok) {
    return {
      ok: true,
      ollamaRunning: false,
      unloaded: [],
      kept: [],
      vramFit: evaluateVramModelFit({ cfg, tagModels, loadedModels: [], hw }),
    };
  }

  const loadedModels = Array.isArray(psRes.data?.models) ? psRes.data.models : [];
  const res = await unloadModelsExceedingBudget({
    cfg,
    loadedModels,
    tagModels,
    hw,
    callHttp,
  });

  const vramFit = evaluateVramModelFit({
    cfg,
    tagModels,
    loadedModels: res.remainingRaw,
    hw,
  });

  return {
    ok: true,
    ollamaRunning: true,
    unloaded: res.unloaded,
    kept: res.remainingRec,
    vramFit,
  };
}

// probeNvidiaGpu moved to ./gpu-shared-state.mjs to prevent circular dependency

export const GPU_THERMAL_THROTTLE_TEMP_C = 84;

export const GPU_EXTERNAL_BUSY_UTIL_PCT = 90;

/**
 * Evaluates real-time GPU thermal and external compute utilization guards
 * to prevent local LLM work during overheating or heavy external GPU workloads (games/render).
 * @param {object|null} [hw=null]
 * @param {object} [opts={}]
 */
export function evaluateGpuThermalAndLoadGuard(
  hw = null,
  {
    maxTempC = GPU_THERMAL_THROTTLE_TEMP_C,
    maxExternalUtilPct = GPU_EXTERNAL_BUSY_UTIL_PCT,
    isBackground = false,
    liveActivity = null,
  } = {}
) {
  if (!hw || !hw.available) {
    return { ok: true, throttled: false, reason: '', tempC: 0, utilPct: 0, message: '' };
  }
  const tempC = Number(hw.tempC) || 0;
  const utilPct = Number(hw.utilPct) || 0;
  if (tempC >= maxTempC) {
    return {
      ok: false,
      throttled: true,
      reason: 'thermal_throttle',
      tempC,
      utilPct,
      message: `GPU temperature ${tempC}°C >= ${maxTempC}°C — local GPU work paused`,
    };
  }
  if (isBackground && utilPct >= maxExternalUtilPct) {
    const live = liveActivity || getGpuLiveActivity();
    const ourGpuBusy = isLocalChatActive() || Number(live?.inFlightCount || 0) > 0;
    if (!ourGpuBusy) {
      return {
        ok: false,
        throttled: true,
        reason: 'external_gpu_busy',
        tempC,
        utilPct,
        message: `External GPU utilization ${utilPct}% >= ${maxExternalUtilPct}% — background GPU task deferred`,
      };
    }
  }
  return { ok: true, throttled: false, reason: '', tempC, utilPct, message: '' };
}

/**
 * Находит исполняемый файл Ollama на Windows / POSIX с мемоизацией на 5 минут.
 * @param {boolean} [force=false]
 * @returns {string|null}
 */
export function findOllamaBinary(force = false) {
  const now = Date.now();
  if (!force && gpuRuntime.ollamaBinCache.ts > 0 && (now - gpuRuntime.ollamaBinCache.ts) < OLLAMA_BIN_TTL_MS) {
    return gpuRuntime.ollamaBinCache.path;
  }
  let resolvedPath = null;
  if (process.platform === 'win32') {
    const candidates = [
      join(os.homedir(), 'AppData', 'Local', 'Programs', 'Ollama', 'ollama.exe'),
      'C:\\Program Files\\Ollama\\ollama.exe',
    ];
    for (const c of candidates) {
      if (existsSync(c)) {
        resolvedPath = c;
        break;
      }
    }
    if (!resolvedPath) {
      try {
        const resolved = execFileSync('where.exe', ['ollama'], { encoding: 'utf8', timeout: 800, windowsHide: true }).trim();
        const first = resolved.split(/\r?\n/)[0]?.trim();
        if (first && existsSync(first)) resolvedPath = first;
      } catch {}
    }
  } else {
    try {
      const resolved = execFileSync('which', ['ollama'], { encoding: 'utf8', timeout: 800 }).trim();
      resolvedPath = resolved || null;
    } catch {}
  }
  gpuRuntime.ollamaBinCache = { ts: now, path: resolvedPath };
  return resolvedPath;
}

/**
 * Builds deterministic Ollama serve environment variables with single-slot parallel KV-cache
 * to avoid unnecessary 2-4x VRAM reservation.
 * @param {object} [cfg]
 * @param {string} [hostPort='127.0.0.1:11434']
 * @param {object} [baseEnv=process.env]
 */
export function buildOllamaSpawnEnv(cfg = {}, hostPort = '127.0.0.1:11434', baseEnv = process.env) {
  const resolved = cfg && typeof cfg === 'object' ? { ...DEFAULT_GPU_CONFIG, ...cfg } : loadGpuConfig();
  const spawnEnv = {
    ...baseEnv,
    OLLAMA_MAX_LOADED_MODELS: '2',
    OLLAMA_NUM_PARALLEL: '1',
    OLLAMA_KEEP_ALIVE: resolved.gpuKeepAlive,
    OLLAMA_FLASH_ATTENTION: '1',
    OLLAMA_KV_CACHE_TYPE: 'q8_0',
    OLLAMA_HOST: hostPort,
  };
  if (resolved.gpuModelsDir) {
    spawnEnv.OLLAMA_MODELS = resolved.gpuModelsDir;
  }
  return spawnEnv;
}

/**
 * Builds platform-safe child_process.spawn options for `ollama serve`.
 * On Windows, `detached: true` sets Win32 DETACHED_PROCESS which overrides CREATE_NO_WINDOW (`windowsHide`)
 * and strips the hidden console handle, causing child `ollama runner` / `nvidia-smi` processes to flash CMD windows.
 * @param {object} [spawnEnv=process.env]
 * @param {string} [platform=process.platform]
 */
export function buildOllamaSpawnOpts(spawnEnv = process.env, platform = process.platform) {
  return {
    detached: platform !== 'win32',
    windowsHide: true,
    stdio: 'ignore',
    env: spawnEnv,
  };
}

/**
 * Гарантирует, что локальный сервер Ollama запущен (при необходимости лениво поднимает процесс).
 * @param {object} [cfgInput]
 */
export async function ensureOllamaRunning(cfgInput = null) {
  if (gpuRuntime.ensureOllamaPromise) return gpuRuntime.ensureOllamaPromise;
  gpuRuntime.ensureOllamaPromise = ensureOllamaRunningImpl(cfgInput).finally(() => {
    gpuRuntime.ensureOllamaPromise = null;
  });
  return gpuRuntime.ensureOllamaPromise;
}

async function ensureOllamaRunningImpl(cfgInput = null) {
  const cfg = cfgInput || loadGpuConfig();
  if (!cfg.gpuEnabled) {
    return { ok: false, running: false, error: 'GPU engine disabled in router-state.json' };
  }

  let targetOrigin = '';
  try {
    targetOrigin = new URL(cfg.gpuEndpoint || 'http://127.0.0.1:11434').origin;
  } catch {}
  if (
    !cfg.gpuAutoStart &&
    gpuRuntime.ollamaOfflineUntilTs > Date.now() &&
    (!targetOrigin || !gpuRuntime.ollamaOfflineEndpoint || gpuRuntime.ollamaOfflineEndpoint === targetOrigin)
  ) {
    return { ok: false, running: false, error: 'Ollama offline (backoff circuit active)' };
  }

  const probe = await ollamaHttpJson('GET', '/api/tags', null, 700, cfg.gpuEndpoint);
  if (probe.ok) {
    gpuRuntime.ollamaOfflineUntilTs = 0;
    return { ok: true, running: true, models: Array.isArray(probe.data?.models) ? probe.data.models : [] };
  }

  if (!cfg.gpuAutoStart) {
    return { ok: false, running: false, error: probe.error || 'Ollama offline (gpuAutoStart=false)' };
  }

  if (gpuRuntime.lastOllamaSpawnTs && (Date.now() - gpuRuntime.lastOllamaSpawnTs) < OLLAMA_SPAWN_COOLDOWN_MS) {
    return { ok: false, running: false, error: 'Ollama startup cooldown active (10s)' };
  }

  const bin = findOllamaBinary();
  if (!bin) {
    return { ok: false, running: false, installed: false, error: 'Ollama binary not found' };
  }

  let hostPort = '127.0.0.1:11434';
  try {
    const u = new URL(cfg.gpuEndpoint);
    hostPort = u.host;
  } catch {}

  gpuRuntime.lastOllamaSpawnTs = Date.now();
  let spawnErr = null;
  try {
    if (cfg.gpuModelsDir) {
      try { mkdirSync(cfg.gpuModelsDir, { recursive: true }); } catch {}
    }
    const spawnEnv = buildOllamaSpawnEnv(cfg, hostPort, process.env);
    const child = spawn(bin, ['serve'], buildOllamaSpawnOpts(spawnEnv));
    child.on('error', (err) => { spawnErr = err; });
    if (typeof child.unref === 'function') child.unref();
  } catch (err) {
    return { ok: false, running: false, error: `Failed to start ollama serve: ${err.message}` };
  }

  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 350));
    if (spawnErr) {
      return { ok: false, running: false, error: `Failed to start ollama serve: ${spawnErr.message}` };
    }
    const check = await ollamaHttpJson('GET', '/api/tags', null, 600, cfg.gpuEndpoint);
    if (check.ok) {
      gpuRuntime.ollamaOfflineUntilTs = 0;
      return { ok: true, running: true, startedNow: true, models: Array.isArray(check.data?.models) ? check.data.models : [] };
    }
  }

  return { ok: false, running: false, error: 'Ollama did not become ready within 4.2s' };
}

function parseOllamaModelRef(rawModel = '') {
  const raw = String(rawModel || '').trim();
  if (!raw) return null;
  const lastSlash = raw.lastIndexOf('/');
  const lastColon = raw.lastIndexOf(':');
  const hasTag = lastColon > lastSlash;
  const namePart = hasTag ? raw.slice(0, lastColon) : raw;
  const tag = (hasTag ? raw.slice(lastColon + 1) : 'latest') || 'latest';
  const parts = namePart.split('/').filter(Boolean);
  if (parts.length === 0) return null;
  let host = '';
  let namespace = 'library';
  let repo = '';
  if (parts.length === 1) {
    repo = parts[0];
  } else if (parts.length === 2) {
    namespace = parts[0];
    repo = parts[1];
  } else {
    host = parts[0];
    namespace = parts[1];
    repo = parts.slice(2).join('/');
  }
  return { host, namespace, repo, tag };
}

function collectManifestLayerBlobs(doc, blobsDir, outSet, visited = new Set()) {
  if (!doc || typeof doc !== 'object') return;
  if (Array.isArray(doc.layers)) {
    for (const layer of doc.layers) {
      const digest = String(layer?.digest || '').trim();
      if (digest.startsWith('sha256:')) {
        outSet.add(digest.replace(':', '-'));
      }
    }
    return;
  }
  if (Array.isArray(doc.manifests)) {
    const ggufEntries = doc.manifests.filter((m) => m?.format === 'gguf' || m?.runner === 'llamacpp');
    const targets = ggufEntries.length > 0 ? ggufEntries : doc.manifests;
    for (const entry of targets) {
      const digest = String(entry?.digest || '').trim();
      if (!digest.startsWith('sha256:')) continue;
      const blobName = digest.replace(':', '-');
      if (visited.has(blobName)) continue;
      visited.add(blobName);
      try {
        const subRaw = readFileSync(join(blobsDir, blobName), 'utf8');
        collectManifestLayerBlobs(JSON.parse(subRaw), blobsDir, outSet, visited);
      } catch {}
    }
  }
}

/**
 * Resolves GGUF blob filenames from Ollama manifests/manifests-v2 so active chat/embed models warm first.
 * @param {string} modelsDir
 * @param {Array<string|{model:string,priority:number}>} priorityModels
 * @returns {Map<string, number>}
 */
export function resolveOllamaManifestBlobPriority(modelsDir, priorityModels = []) {
  const priorityMap = new Map();
  if (!modelsDir || !Array.isArray(priorityModels) || priorityModels.length === 0) return priorityMap;
  const blobsDir = join(modelsDir, 'blobs');

  priorityModels.forEach((item, idx) => {
    const modelName = typeof item === 'string' ? item : item?.model;
    const priority = typeof item === 'object' && Number.isFinite(item?.priority)
      ? Number(item.priority)
      : Math.max(1, priorityModels.length - idx);
    const ref = parseOllamaModelRef(modelName);
    if (!ref) return;

    const v2Hosts = ref.host ? [ref.host] : ['ollama.com', 'registry.ollama.ai'];
    const v1Hosts = ref.host ? [ref.host] : ['registry.ollama.ai', 'ollama.com'];
    const candidateManifests = [
      ...v2Hosts.map((h) => join(modelsDir, 'manifests-v2', h, ref.namespace, ref.repo, ref.tag)),
      ...v1Hosts.map((h) => join(modelsDir, 'manifests', h, ref.namespace, ref.repo, ref.tag)),
    ];

    const blobsForModel = new Set();
    for (const manifestPath of candidateManifests) {
      try {
        if (!existsSync(manifestPath)) continue;
        const doc = JSON.parse(readFileSync(manifestPath, 'utf8'));
        collectManifestLayerBlobs(doc, blobsDir, blobsForModel);
        if (blobsForModel.size > 0) break;
      } catch {}
    }

    for (const blobName of blobsForModel) {
      const prev = priorityMap.get(blobName) || 0;
      if (priority > prev) priorityMap.set(blobName, priority);
    }
  });

  return priorityMap;
}

/**
 * Streams Ollama GGUF model blobs into the OS DDR5 RAM page cache at 0 MB VRAM cost.
 * Prioritizes active chat and embed model blobs via Ollama manifests before falling back to recency.
 * @param {object} [opts]
 */
export async function warmGgufModelsInHostRam({
  cfgOverride = null,
  freeRamMbOverride = null,
  modelsDirOverride = '',
  maxBytesToWarm = 12 * 1024 * 1024 * 1024,
  chunkBytes = 4 * 1024 * 1024,
  minBlobBytes = 100 * 1024 * 1024,
  force = false,
} = {}) {
  const cfg = cfgOverride ? loadGpuConfig(cfgOverride) : loadGpuConfig();
  const enabled = cfgOverride?.gpuEnabled !== undefined
    ? Boolean(cfgOverride.gpuEnabled) && cfg.gpuWarmHostRamCache !== false
    : (cfg.gpuEnabled && cfg.gpuWarmHostRamCache !== false);
  if (!enabled) {
    return { ok: false, skippedReason: 'disabled' };
  }

  const freeRamMb = freeRamMbOverride != null
    ? Number(freeRamMbOverride)
    : Math.round(os.freemem() / (1024 * 1024));
  if (!Number.isFinite(freeRamMb) || freeRamMb < 20480) {
    return { ok: false, skippedReason: 'low_free_ram', freeRamMb };
  }

  const now = Date.now();
  if (!force && gpuRuntime.lastHostRamWarmTs > 0 && (now - gpuRuntime.lastHostRamWarmTs) < HOST_RAM_WARM_COOLDOWN_MS) {
    return { ok: false, skippedReason: 'cooldown', freeRamMb };
  }

  const modelsDir = modelsDirOverride || resolveDefaultGpuModelsDir(cfg.gpuModelsDir);
  if (!modelsDir) {
    return { ok: false, skippedReason: 'no_models_dir', freeRamMb, blobsWarmed: 0, warmedMb: 0 };
  }

  const blobsDir = join(modelsDir, 'blobs');
  let dirents;
  try {
    dirents = await fsPromises.readdir(blobsDir, { withFileTypes: true });
  } catch {
    return { ok: false, skippedReason: 'no_blobs_dir', freeRamMb, blobsWarmed: 0, warmedMb: 0 };
  }

  const priorityMap = resolveOllamaManifestBlobPriority(modelsDir, [
    { model: cfg.gpuChatModel, priority: 2 },
    { model: cfg.gpuEmbedModel, priority: 1 },
  ]);

  const minBytes = Math.max(1, Number(minBlobBytes) || (100 * 1024 * 1024));
  const candidates = [];
  for (const d of dirents) {
    if (!d.isFile()) continue;
    const fullPath = join(blobsDir, d.name);
    try {
      const st = await fsPromises.stat(fullPath);
      if (st.isFile() && st.size >= minBytes) {
        candidates.push({
          name: d.name,
          path: fullPath,
          size: st.size,
          mtimeMs: st.mtimeMs,
          priority: priorityMap.get(d.name) || 0,
        });
      }
    } catch {}
  }

  candidates.sort((a, b) => (b.priority - a.priority) || (b.mtimeMs - a.mtimeMs) || (b.size - a.size));

  const t0 = Date.now();
  const safeChunkBytes = Math.max(4096, Math.min(64 * 1024 * 1024, Number(chunkBytes) || (4 * 1024 * 1024)));
  const maxBytes = Math.max(0, Number(maxBytesToWarm) || (12 * 1024 * 1024 * 1024));
  const buf = Buffer.allocUnsafe(safeChunkBytes);
  let totalBytesWarmed = 0;
  let blobsWarmed = 0;
  let bytesSinceYield = 0;
  const warmedFiles = [];

  for (const blob of candidates) {
    if (totalBytesWarmed >= maxBytes) break;
    let fh = null;
    let blobBytesRead = 0;
    try {
      fh = await fsPromises.open(blob.path, 'r');
      let offset = 0;
      while (totalBytesWarmed < maxBytes) {
        const remaining = maxBytes - totalBytesWarmed;
        const toRead = Math.min(safeChunkBytes, remaining);
        const { bytesRead } = await fh.read(buf, 0, toRead, offset);
        if (!bytesRead) break;
        offset += bytesRead;
        blobBytesRead += bytesRead;
        totalBytesWarmed += bytesRead;
        bytesSinceYield += bytesRead;
        if (bytesSinceYield >= 16 * 1024 * 1024) {
          bytesSinceYield = 0;
          await new Promise((resolve) => setImmediate(resolve));
        }
      }
      if (blobBytesRead > 0) {
        blobsWarmed++;
        warmedFiles.push(blob.name);
      }
    } catch {
      // Skip unreadable or vanished blob safely
    } finally {
      if (fh) {
        try { await fh.close(); } catch {}
      }
    }
  }

  gpuRuntime.lastHostRamWarmTs = Date.now();
  const warmedMb = Number((totalBytesWarmed / (1024 * 1024)).toFixed(3));
  const elapsedMs = Date.now() - t0;

  recordGpuTelemetryPatch((cur) => ({
    ...cur,
    hostRamWarmedMb: warmedMb,
  }));

  return { ok: true, blobsWarmed, warmedMb, elapsedMs, warmedFiles };
}

/**
 * Принудительно выгружает все модели Ollama из видеопамяти (освобождает 100% VRAM под игры или рендер).
 */
export async function unloadAllModels() {
  const cfg = loadGpuConfig();
  const psRes = await ollamaHttpJson('GET', '/api/ps', null, 1000, cfg.gpuEndpoint);
  if (!psRes.ok) {
    return { ok: true, unloaded: [], note: 'Ollama already offline' };
  }
  const loaded = Array.isArray(psRes.data?.models) ? psRes.data.models : [];
  const results = await Promise.all(
    loaded.map(async (m) => {
      const name = m?.name || m?.model;
      if (!name) return null;
      await unloadSingleOllamaModel(name, cfg);
      return name;
    })
  );
  return { ok: true, unloaded: results.filter(Boolean) };
}

/**
 * Безопасно выгружает модели Ollama из VRAM при закрытии приложения (с жёстким таймаутом).
 */
export async function unloadModelsOnAppExit({
  force = false,
  timeoutMs = 1800,
  closeAgents = false,
  loadConfigFn = loadGpuConfig,
  unloadFn = unloadAllModels,
} = {}) {
  try {
    const cfg = loadConfigFn();
    if (!force && (!cfg?.gpuEnabled || cfg.gpuUnloadOnExit === false)) {
      return {
        ok: true,
        skipped: true,
        reason: !cfg?.gpuEnabled ? 'gpu_disabled' : 'unload_on_exit_disabled',
        unloaded: [],
      };
    }
    const waitMs = clampInt(timeoutMs, 200, 10000, 1800);
    let timer = null;
    const res = await Promise.race([
      Promise.resolve().then(() => unloadFn()),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, timedOut: true, unloaded: [] }), waitMs);
        if (typeof timer.unref === 'function') timer.unref();
      }),
    ]);
    if (timer) clearTimeout(timer);
    return res || { ok: true, unloaded: [] };
  } catch (err) {
    return { ok: false, error: err?.message || String(err), unloaded: [] };
  } finally {
    if (closeAgents) {
      destroyOllamaKeepAliveAgents();
    }
  }
}

/**
 * Возвращает полный снимок состояния локальной GPU, Ollama, скачанных моделей и сэкономленных токенов.
 */
export async function getGpuStatusSnapshot(opts = {}) {
  const cfg = loadGpuConfig();
  const hw = probeNvidiaGpu(Boolean(opts?.force));
  const installedBinary = findOllamaBinary();
  const [tagsRes, psRes] = await Promise.all([
    ollamaHttpJson('GET', '/api/tags', null, 700, cfg.gpuEndpoint),
    ollamaHttpJson('GET', '/api/ps', null, 700, cfg.gpuEndpoint),
  ]);

  if (tagsRes.ok) {
    updateOllamaTagsCache(cfg.gpuEndpoint, tagsRes.data?.models);
  }

  const downloadedModels = Array.isArray(tagsRes.data?.models)
    ? tagsRes.data.models.map((m) => ({
        name: m.name,
        sizeGb: Number(((Number(m.size) || 0) / (1024 ** 3)).toFixed(2)),
      }))
    : [];

  const { loadedModels, loadedVramMb: ollamaLoadedVramMb } = reconcileLoadedModelsVram(
    psRes.data?.models || [],
    tagsRes.data?.models || [],
    hw
  );

  const vramFit = evaluateVramModelFit({
    cfg,
    tagModels: tagsRes.ok ? (tagsRes.data?.models || []) : null,
    loadedModels,
    hw,
  });

  const liveActivity = getGpuLiveActivity();
  const thermalGuard = evaluateGpuThermalAndLoadGuard(hw, { isBackground: true, liveActivity });

  const cascadeBundle = buildGpuCascadeBundleForHardware(Number(hw?.totalMb) || 0, {
    mode: 'cascade',
    selectedCapMb: cfg.gpuMaxVramMb,
    downloadedModels,
  });
  const cascadeStatus = {
    totalCount: cascadeBundle.models.length,
    missingCount: tagsRes.ok ? cascadeBundle.missingModels.length : 0,
    approxMissingDiskGb: tagsRes.ok ? cascadeBundle.approxMissingDiskGb : 0,
    missingModels: tagsRes.ok ? cascadeBundle.missingModels.map((m) => m.name) : [],
  };

  return {
    config: cfg,
    hardware: hw,
    thermalGuard,
    ollama: {
      installed: Boolean(installedBinary),
      binaryPath: installedBinary || null,
      running: Boolean(tagsRes.ok),
      downloadedModels,
      loadedModels,
      loadedVramMb: ollamaLoadedVramMb,
    },
    vramFit,
    cascadeStatus,
    pullStatus: getGpuPullJobStatus(),
    telemetry: {
      ...getGpuTelemetry(),
      distillCacheEntries: ramDistillCache.size,
    },
    liveActivity,
  };
}

// --- Устойчивая каскадная загрузка моделей Ollama с автофоллбэком на Hugging Face ---

const SAFE_OLLAMA_TAG_RE = /^[a-z0-9._:/-]{2,128}$/i;

let activePullJob = {
  active: false,
  cancelRequested: false,
  childProc: null,
  status: {
    active: false,
    pid: 0,
    startedAt: 0,
    updatedAt: 0,
    finishedAt: 0,
    totalCount: 0,
    completedCount: 0,
    currentIndex: -1,
    currentModel: '',
    currentPercent: 0,
    source: '',
    statusText: '',
    cancelled: false,
    error: '',
    items: [],
  },
};

function persistPullStatus(statusObj, force = false) {
  const now = Date.now();
  if (!force && statusObj._lastDiskWriteAt && (now - statusObj._lastDiskWriteAt) < 400) return;
  statusObj._lastDiskWriteAt = now;
  const clean = {
    active: Boolean(statusObj.active),
    pid: Number(statusObj.pid) || 0,
    startedAt: Number(statusObj.startedAt) || 0,
    updatedAt: Number(statusObj.updatedAt) || now,
    finishedAt: Number(statusObj.finishedAt) || 0,
    totalCount: Number(statusObj.totalCount) || 0,
    completedCount: Number(statusObj.completedCount) || 0,
    currentIndex: Number.isInteger(statusObj.currentIndex) ? statusObj.currentIndex : -1,
    currentModel: String(statusObj.currentModel || ''),
    currentPercent: Number(statusObj.currentPercent) || 0,
    source: String(statusObj.source || ''),
    statusText: String(statusObj.statusText || ''),
    cancelled: Boolean(statusObj.cancelled),
    error: String(statusObj.error || ''),
    items: Array.isArray(statusObj.items) ? statusObj.items.map((it) => ({ ...it })) : [],
  };
  try {
    if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
    atomicWriteJsonSync(GPU_PULL_STATUS_FILE, clean, { spaces: 0 });
  } catch {}
}

export function getGpuPullJobStatus() {
  if (activePullJob.active) {
    return {
      ...activePullJob.status,
      items: activePullJob.status.items.map((it) => ({ ...it })),
    };
  }
  const disk = safeReadJsonSync(GPU_PULL_STATUS_FILE, () => null, { selfHeal: false });
  if (disk && typeof disk === 'object') {
    if (disk.active) {
      const stale = (Date.now() - Number(disk.updatedAt || 0)) > 15 * 60 * 1000 || (disk.pid && !isProcessAliveSafe(disk.pid));
      if (stale) {
        const isEnStale = readActiveUiLanguage() === 'en';
        return {
          ...disk,
          active: false,
          statusText: disk.statusText || (isEnStale ? 'Download interrupted' : 'Загрузка прервана'),
          statusTextRu: disk.statusTextRu || 'Загрузка прервана',
          statusTextEn: disk.statusTextEn || 'Download interrupted',
        };
      }
    }
    return disk;
  }
  return { ...activePullJob.status, items: [] };
}

export function cancelGpuPullJob() {
  activePullJob.cancelRequested = true;
  if (activePullJob.childProc && !activePullJob.childProc.killed) {
    try {
      activePullJob.childProc.kill();
    } catch {}
  }
  if (activePullJob.active) {
    activePullJob.status.cancelled = true;
    activePullJob.status.active = false;
    activePullJob.status.finishedAt = Date.now();
    activePullJob.status.updatedAt = Date.now();
    activePullJob.status.statusText = readActiveUiLanguage() === 'en' ? 'Download cancelled by user' : 'Загрузка отменена пользователем';
    activePullJob.status.statusTextRu = 'Загрузка отменена пользователем';
    activePullJob.status.statusTextEn = 'Download cancelled by user';
    activePullJob.active = false;
    persistPullStatus(activePullJob.status, true);
  }
  return getGpuPullJobStatus();
}

function formatCompactPullError(rawLine = '', maxLen = 220) {
  const cleaned = String(rawLine || '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  const shortened = cleaned.replace(/https?:\/\/([^/\s"']+)([^\s"']*)/gi, (full, host, rest) => {
    if (rest && rest.length > 16) {
      const protoEnd = full.indexOf('://');
      return `${full.slice(0, protoEnd + 3)}${host}/...`;
    }
    return full;
  });
  if (shortened.length <= maxLen) return shortened;
  const headLen = Math.max(40, Math.floor(maxLen * 0.55));
  const tailLen = Math.max(30, maxLen - headLen - 3);
  return `${shortened.slice(0, headLen)}...${shortened.slice(-tailLen)}`;
}

function isTransientPullError(errText = '') {
  const s = String(errText || '');
  if (!s) return false;
  if (/\b(?:401|403|404|not found|unauthorized|invalid|no space|manifest unknown)\b/i.test(s)) return false;
  return /\b(?:timeout|timed out|eof|reset|broken pipe|tls|handshake|head\s+"https?:|get\s+"https?:|429|502|503|504|temporar|unreachable|wsarecv|обрыв|таймаут)\b/i.test(s);
}

export { formatCompactPullError, isTransientPullError };

/**
 * Executes Ollama model management (`pull`, `cp`, `rm`) purely over loopback HTTP API
 * so zero `ollama.exe` CLI subprocesses or Windows console windows are ever spawned.
 */
async function execDefaultOllamaHttpStep(
  args = [],
  { cfg = null, onLine = null, manifestTimeoutMs = 20000, totalTimeoutMs = 30 * 60 * 1000, checkCancelled = null, lang = '' } = {}
) {
  const resolvedCfg = cfg || loadGpuConfig();
  const isEnStep = normalizeLang(lang || resolvedCfg?.uiLanguage || readActiveUiLanguage(), 'en') === 'en';
  const endpoint = resolvedCfg.gpuEndpoint || 'http://127.0.0.1:11434';
  const cmd = String(args[0] || '').toLowerCase();

  if (cmd === 'cp') {
    const res = await ollamaHttpJson('POST', '/api/copy', { source: args[1], destination: args[2] }, manifestTimeoutMs, endpoint);
    return { ok: Boolean(res?.ok), code: res?.ok ? 0 : 1, sawDownloadProgress: true, error: res?.error || '' };
  }
  if (cmd === 'rm') {
    const res = await ollamaHttpJson('DELETE', '/api/delete', { model: args[1] }, manifestTimeoutMs, endpoint);
    return { ok: Boolean(res?.ok), code: res?.ok ? 0 : 1, sawDownloadProgress: true, error: res?.error || '' };
  }
  if (cmd !== 'pull') {
    return execDefaultOllamaCliStep(args, { cfg: resolvedCfg, onLine, manifestTimeoutMs, totalTimeoutMs, checkCancelled, lang });
  }

  let url;
  try {
    url = new URL('/api/pull', endpoint);
    const h = String(url.hostname || '').toLowerCase();
    if (h !== '127.0.0.1' && h !== 'localhost' && h !== '::1' && h !== '[::1]') {
      return { ok: false, code: -1, sawDownloadProgress: false, error: 'gpuEndpoint must target localhost/loopback' };
    }
  } catch (err) {
    return { ok: false, code: -1, sawDownloadProgress: false, error: err.message };
  }

  return new Promise((resolvePromise) => {
    const isHttps = url.protocol === 'https:';
    const mod = isHttps ? https : http;
    const payloadStr = JSON.stringify({ model: String(args[1] || ''), stream: true });
    let settled = false;
    let sawDownloadProgress = false;
    let lastActivityAt = Date.now();
    let lastErrorLine = '';
    let lineBuf = '';
    let reqRef = null;

    const finish = (res) => {
      if (settled) return;
      settled = true;
      clearInterval(watchdog);
      clearTimeout(hardTimer);
      if (activePullJob.childProc && activePullJob.childProc._httpReq === reqRef) {
        activePullJob.childProc = null;
      }
      resolvePromise({ sawDownloadProgress, ...res });
    };

    const processJsonLine = (rawLine) => {
      const trimmed = String(rawLine || '').trim();
      if (!trimmed) return;
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        return;
      }
      if (msg?.error) {
        lastErrorLine = formatCompactPullError(String(msg.error), 220);
        return;
      }
      const statusStr = String(msg?.status || '').trim();
      const total = Number(msg?.total) || 0;
      const completed = Number(msg?.completed) || 0;
      let pct = null;
      if (total > 0 && completed >= 0) {
        pct = Math.max(0, Math.min(100, Math.round((completed / total) * 100)));
      } else if (/^success$/i.test(statusStr)) {
        pct = 100;
      }
      if ((pct !== null && pct > 0) || total > 0 || /\b(?:verifying|writing manifest|success)\b/i.test(statusStr)) {
        sawDownloadProgress = true;
        lastActivityAt = Date.now();
      } else if (statusStr) {
        lastActivityAt = Date.now();
      }
      onLine?.(statusStr || trimmed, pct);
    };

    const req = mod.request(
      {
        hostname: url.hostname,
        port: Number(url.port) || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        agent: isHttps ? keepAliveHttpsAgent : keepAliveHttpAgent,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payloadStr, 'utf8'),
        },
      },
      (res) => {
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          lineBuf += chunk;
          let nlIdx;
          while ((nlIdx = lineBuf.indexOf('\n')) !== -1) {
            const line = lineBuf.slice(0, nlIdx);
            lineBuf = lineBuf.slice(nlIdx + 1);
            processJsonLine(line);
          }
        });
        res.on('end', () => {
          if (lineBuf.trim()) {
            processJsonLine(lineBuf);
            lineBuf = '';
          }
          if (res.statusCode >= 200 && res.statusCode < 300 && !lastErrorLine) {
            finish({ ok: true, code: 0 });
          } else {
            finish({
              ok: false,
              code: res.statusCode || 1,
              error: lastErrorLine || `HTTP ${res.statusCode}`,
            });
          }
        });
      }
    );
    reqRef = req;
    activePullJob.childProc = {
      _httpReq: req,
      kill() {
        try { req.destroy(); } catch {}
      },
    };

    const watchdog = setInterval(() => {
      if (checkCancelled?.() || activePullJob.cancelRequested) {
        try { req.destroy(); } catch {}
        finish({ ok: false, code: -1, cancelled: true, error: isEnStep ? 'Cancelled by user' : 'Отменено пользователем' });
        return;
      }
      const idleMs = Date.now() - lastActivityAt;
      const limitMs = sawDownloadProgress ? 90_000 : manifestTimeoutMs;
      if (idleMs > limitMs) {
        try { req.destroy(); } catch {}
        finish({
          ok: false,
          code: -1,
          error: lastErrorLine || (sawDownloadProgress
            ? (isEnStep ? 'Download stream interrupted' : 'Обрыв потока загрузки')
            : (isEnStep ? 'Ollama registry timeout (TLS/manifest timeout)' : 'Таймаут реестра Ollama (TLS/manifest timeout)')),
        });
      }
    }, 1000);

    const hardTimer = setTimeout(() => {
      try { req.destroy(); } catch {}
      finish({ ok: false, code: -1, error: isEnStep ? 'Maximum model download timeout exceeded' : 'Превышено максимальное время загрузки модели' });
    }, totalTimeoutMs);

    req.on('error', (err) => {
      if (checkCancelled?.() || activePullJob.cancelRequested) {
        finish({ ok: false, code: -1, cancelled: true, error: isEnStep ? 'Cancelled by user' : 'Отменено пользователем' });
        return;
      }
      finish({ ok: false, code: -1, error: lastErrorLine || err?.message || (isEnStep ? 'HTTP model download error' : 'Ошибка HTTP-загрузки модели') });
    });

    req.write(payloadStr);
    req.end();
  });
}

function execDefaultOllamaCliStep(
  args = [],
  { cfg = null, onLine = null, manifestTimeoutMs = 20000, totalTimeoutMs = 30 * 60 * 1000, checkCancelled = null, lang = '' } = {}
) {
  const isEnStep = normalizeLang(lang || cfg?.uiLanguage || readActiveUiLanguage(), 'en') === 'en';
  return new Promise((resolvePromise) => {
    const bin = findOllamaBinary();
    if (!bin) {
      resolvePromise({ ok: false, code: -1, error: isEnStep ? 'Ollama is not installed on this PC' : 'Ollama не установлена на этом ПК' });
      return;
    }
    const env = { ...process.env };
    if (cfg?.gpuModelsDir) env.OLLAMA_MODELS = cfg.gpuModelsDir;

    const child = spawn(bin, args, { env, detached: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    activePullJob.childProc = child;

    let settled = false;
    let sawDownloadProgress = args[0] !== 'pull';
    let lastActivityAt = Date.now();
    let lastErrorLine = '';

    const finish = (res) => {
      if (settled) return;
      settled = true;
      clearInterval(watchdog);
      clearTimeout(hardTimer);
      if (activePullJob.childProc === child) activePullJob.childProc = null;
      resolvePromise({ sawDownloadProgress, ...res });
    };

    const handleChunk = (buf) => {
      const txt = String(buf || '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
      const parts = txt.split(/[\r\n]+/);
      for (const raw of parts) {
        const line = raw.trim();
        if (!line) continue;
        if (/\b(?:error|failed|timeout)\b/i.test(line)) {
          lastErrorLine = formatCompactPullError(line, 220);
        }
        const pctMatch = /\b(\d{1,3})%/.exec(line);
        const pct = pctMatch ? Math.max(0, Math.min(100, Number(pctMatch[1]))) : null;
        if ((pct !== null && pct > 0) || /\b(?:MB\/s|GB\/s|KB\/s|verifying|writing manifest|success)\b/i.test(line)) {
          sawDownloadProgress = true;
          lastActivityAt = Date.now();
        }
        onLine?.(line, pct);
      }
    };

    child.stdout?.on('data', handleChunk);
    child.stderr?.on('data', handleChunk);

    const watchdog = setInterval(() => {
      if (checkCancelled?.() || activePullJob.cancelRequested) {
        try { child.kill(); } catch {}
        finish({ ok: false, code: -1, cancelled: true, error: isEnStep ? 'Cancelled by user' : 'Отменено пользователем' });
        return;
      }
      const idleMs = Date.now() - lastActivityAt;
      const limitMs = sawDownloadProgress ? 90_000 : manifestTimeoutMs;
      if (idleMs > limitMs) {
        try { child.kill(); } catch {}
        finish({
          ok: false,
          code: -1,
          error: lastErrorLine || (sawDownloadProgress
            ? (isEnStep ? 'Download stream interrupted' : 'Обрыв потока загрузки')
            : (isEnStep ? 'Ollama registry timeout (TLS/manifest timeout)' : 'Таймаут реестра Ollama (TLS/manifest timeout)')),
        });
      }
    }, 1000);

    const hardTimer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish({ ok: false, code: -1, error: isEnStep ? 'Maximum model download timeout exceeded' : 'Превышено максимальное время загрузки модели' });
    }, totalTimeoutMs);

    child.on('error', (err) => {
      finish({ ok: false, code: -1, error: err?.message || (isEnStep ? 'Failed to launch ollama' : 'Ошибка запуска ollama') });
    });

    child.on('close', (code) => {
      if (code === 0) {
        finish({ ok: true, code: 0 });
      } else {
        finish({ ok: false, code: Number(code), error: lastErrorLine || `ollama exited with code ${code}` });
      }
    });
  });
}

/**
 * Downloads a single Ollama model with automatic fallback to official Hugging Face GGUF mirror.
 * @param {string} modelName
 * @param {object} [opts={}]
 */
export async function pullSingleOllamaModelWithFallback(
  modelName,
  { cfg = null, onProgress = null, execStepFn = null, checkCancelled = null, hfMaxAttempts = 3, retryDelayMs = null, lang = '' } = {}
) {
  const resolvedCfg = cfg || loadGpuConfig();
  const isEn = normalizeLang(lang || resolvedCfg?.uiLanguage || readActiveUiLanguage(), 'en') === 'en';
  const cleanName = String(modelName || '').trim();
  if (!SAFE_OLLAMA_TAG_RE.test(cleanName)) {
    return { ok: false, model: cleanName, error: isEn ? 'Invalid model name' : 'Некорректное имя модели' };
  }
  let useHttpDaemon = false;
  if (!execStepFn) {
    const ready = await ensureOllamaRunning({ ...resolvedCfg, gpuEnabled: true, gpuAutoStart: true });
    useHttpDaemon = Boolean(ready?.ok);
  }
  const runStep = execStepFn || ((args, opts) => (
    useHttpDaemon
      ? execDefaultOllamaHttpStep(args, { ...opts, cfg: resolvedCfg, checkCancelled, lang: isEn ? 'en' : 'ru' })
      : execDefaultOllamaCliStep(args, { ...opts, cfg: resolvedCfg, checkCancelled, lang: isEn ? 'en' : 'ru' })
  ));
  const waitMs = Number.isFinite(retryDelayMs) ? Math.max(0, Number(retryDelayMs)) : (execStepFn ? 5 : 1800);
  const pauseBeforeRetry = () => new Promise((r) => setTimeout(r, waitMs));
  const cancelledMsg = isEn ? 'Cancelled by user' : 'Отменено пользователем';

  onProgress?.({
    percent: 0,
    source: 'ollama',
    statusText: isEn ? `Downloading ${cleanName} from Ollama...` : `Скачивание ${cleanName} из Ollama...`,
  });
  let r1 = await runStep(['pull', cleanName], {
    manifestTimeoutMs: 20000,
    onLine: (_line, pct) => {
      if (pct !== null) {
        onProgress?.({ percent: pct, source: 'ollama', statusText: `Ollama: ${cleanName} (${pct}%)` });
      }
    },
  });
  if (r1?.ok) {
    return { ok: true, model: cleanName, source: 'ollama' };
  }
  if (checkCancelled?.() || r1?.cancelled) {
    return { ok: false, cancelled: true, model: cleanName, error: cancelledMsg };
  }

  const norm = normalizeOllamaTag(cleanName);
  const hfMeta = HF_GGUF_FALLBACK_MAP[norm];
  const hfTag = hfMeta?.hfTag || '';
  if (!hfTag) {
    if (r1?.sawDownloadProgress && isTransientPullError(r1?.error)) {
      if (waitMs > 0) await pauseBeforeRetry();
      if (checkCancelled?.()) {
        return { ok: false, cancelled: true, model: cleanName, error: cancelledMsg };
      }
      onProgress?.({
        percent: 0,
        source: 'ollama',
        statusText: isEn ? `Retrying Ollama: ${cleanName}...` : `Повтор Ollama: ${cleanName}...`,
      });
      r1 = await runStep(['pull', cleanName], {
        manifestTimeoutMs: 25000,
        onLine: (_line, pct) => {
          if (pct !== null) {
            onProgress?.({ percent: pct, source: 'ollama', statusText: `Ollama: ${cleanName} (${pct}%)` });
          }
        },
      });
      if (r1?.ok) {
        return { ok: true, model: cleanName, source: 'ollama' };
      }
      if (checkCancelled?.() || r1?.cancelled) {
        return { ok: false, cancelled: true, model: cleanName, error: cancelledMsg };
      }
    }
    return {
      ok: false,
      model: cleanName,
      source: 'ollama',
      error: formatCompactPullError(r1?.error || (isEn ? 'Failed to download model' : 'Не удалось скачать модель'), 240),
    };
  }

  const maxAttempts = Math.max(1, Number(hfMaxAttempts) || 3);
  let r2 = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (checkCancelled?.()) {
      return { ok: false, cancelled: true, model: cleanName, error: cancelledMsg };
    }
    const statusLabel = attempt === 1
      ? (isEn ? `Hugging Face mirror: ${cleanName}...` : `Резервное зеркало Hugging Face: ${cleanName}...`)
      : (isEn ? `Hugging Face retry (${attempt}/${maxAttempts}): ${cleanName}...` : `Повтор Hugging Face (${attempt}/${maxAttempts}): ${cleanName}...`);
    onProgress?.({ percent: 0, source: 'huggingface', statusText: statusLabel });
    r2 = await runStep(['pull', hfTag], {
      manifestTimeoutMs: 45000,
      onLine: (_line, pct) => {
        if (pct !== null) {
          onProgress?.({ percent: pct, source: 'huggingface', statusText: `Hugging Face: ${cleanName} (${pct}%)` });
        }
      },
    });
    if (r2?.ok) break;
    if (checkCancelled?.() || r2?.cancelled) {
      return { ok: false, cancelled: true, model: cleanName, error: cancelledMsg };
    }
    if (attempt < maxAttempts && isTransientPullError(r2?.error)) {
      if (waitMs > 0) await pauseBeforeRetry();
      continue;
    }
    break;
  }
  if (!r2?.ok) {
    return {
      ok: false,
      cancelled: Boolean(r2?.cancelled),
      model: cleanName,
      source: 'huggingface',
      error: formatCompactPullError(r2?.error || r1?.error || (isEn ? 'Hugging Face download failed' : 'Ошибка загрузки с Hugging Face'), 240),
    };
  }

  const rCp = await runStep(['cp', hfTag, cleanName], { manifestTimeoutMs: 30000 });
  if (!rCp?.ok) {
    return { ok: false, model: cleanName, source: 'huggingface', error: rCp?.error || (isEn ? 'Failed to register model tag' : 'Не удалось зарегистрировать тег модели') };
  }
  await runStep(['rm', hfTag], { manifestTimeoutMs: 15000 }).catch(() => {});
  return { ok: true, model: cleanName, source: 'huggingface', hfTag };
}

/**
 * Starts sequential background download of a deduplicated model cascade.
 * @param {object} [opts={}]
 */
export async function startGpuCascadePull({
  models = [],
  mode = 'cascade',
  totalVramMb = 0,
  selectedCapMb = 0,
  installedTags = null,
  lang = '',
  cfgOverride = null,
  execStepFn = null,
  awaitCompletion = false,
} = {}) {
  if (activePullJob.active) {
    return { ...getGpuPullJobStatus(), alreadyRunning: true };
  }

  const cfg = cfgOverride ? loadGpuConfig(cfgOverride) : loadGpuConfig();
  const pullLang = normalizeLang(lang || cfg.uiLanguage || readActiveUiLanguage(), 'en');
  const isEnPull = pullLang === 'en';
  let candidateList = Array.isArray(models)
    ? models.map((m) => String(m || '').trim()).filter((m) => SAFE_OLLAMA_TAG_RE.test(m))
    : [];
  if (candidateList.length === 0) {
    const hwVram = Number(totalVramMb) || probeNvidiaGpu()?.totalMb || 0;
    const bundle = buildGpuCascadeBundleForHardware(hwVram, {
      mode: mode === 'active_only' ? 'active_only' : 'cascade',
      selectedCapMb: Number(selectedCapMb) || cfg.gpuMaxVramMb || 4096,
    });
    candidateList = bundle.models.map((m) => m.name);
  }

  const deduped = [];
  const seen = new Set();
  for (const m of candidateList.slice(0, 8)) {
    const norm = normalizeOllamaTag(m);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    deduped.push(m);
  }

  const installedSet = new Set();
  if (Array.isArray(installedTags)) {
    for (const t of installedTags) {
      const norm = normalizeOllamaTag(typeof t === 'string' ? t : (t?.name || t?.model || ''));
      if (norm) installedSet.add(norm);
    }
  } else if (!execStepFn) {
    const tagsRes = await ollamaHttpJson('GET', '/api/tags', null, 800, cfg.gpuEndpoint);
    const list = Array.isArray(tagsRes?.data?.models) ? tagsRes.data.models : [];
    for (const t of list) {
      const norm = normalizeOllamaTag(t?.name || t?.model || '');
      if (norm) installedSet.add(norm);
    }
  }

  const items = deduped.map((name) => {
    const isInstalled = installedSet.has(normalizeOllamaTag(name));
    return {
      name,
      status: isInstalled ? 'skipped' : 'pending',
      percent: isInstalled ? 100 : 0,
      source: isInstalled ? 'installed' : '',
      error: '',
    };
  });

  const now = Date.now();
  const initialDone = items.filter((it) => it.status === 'skipped').length;
  if (initialDone === items.length) {
    const readyStatus = {
      active: false,
      pid: process.pid,
      startedAt: now,
      updatedAt: now,
      finishedAt: now,
      totalCount: items.length,
      completedCount: items.length,
      currentIndex: -1,
      currentModel: '',
      currentPercent: 100,
      source: 'installed',
      statusText: isEnPull ? 'All cascade models are already installed ✓' : 'Все модели каскада уже установлены ✓',
      statusTextRu: 'Все модели каскада уже установлены ✓',
      statusTextEn: 'All cascade models are already installed ✓',
      cancelled: false,
      error: '',
      items,
    };
    activePullJob.status = readyStatus;
    persistPullStatus(activePullJob.status, true);
    return getGpuPullJobStatus();
  }

  activePullJob.active = true;
  activePullJob.cancelRequested = false;
  activePullJob.status = {
    active: true,
    pid: process.pid,
    startedAt: now,
    updatedAt: now,
    finishedAt: 0,
    totalCount: items.length,
    completedCount: initialDone,
    currentIndex: -1,
    currentModel: '',
    currentPercent: 0,
    source: '',
    statusText: isEnPull ? 'Preparing cascade model download...' : 'Подготовка каскадной загрузки моделей...',
    statusTextRu: 'Подготовка каскадной загрузки моделей...',
    statusTextEn: 'Preparing cascade model download...',
    cancelled: false,
    error: '',
    items,
  };
  persistPullStatus(activePullJob.status, true);

  const runLoop = async () => {
    const errors = [];
    try {
      for (let i = 0; i < items.length; i++) {
        if (activePullJob.cancelRequested) break;
        const item = items[i];
        if (item.status === 'skipped') continue;

        item.status = 'downloading';
        activePullJob.status.currentIndex = i;
        activePullJob.status.currentModel = item.name;
        activePullJob.status.currentPercent = 0;
        activePullJob.status.updatedAt = Date.now();
        persistPullStatus(activePullJob.status, true);

        const res = await pullSingleOllamaModelWithFallback(item.name, {
          cfg,
          lang: pullLang,
          execStepFn,
          checkCancelled: () => activePullJob.cancelRequested,
          onProgress: ({ percent, source, statusText }) => {
            if (!activePullJob.active) return;
            item.percent = Number(percent) || 0;
            if (source) item.source = source;
            activePullJob.status.currentPercent = item.percent;
            activePullJob.status.source = source || activePullJob.status.source;
            activePullJob.status.statusText = statusText || activePullJob.status.statusText;
            activePullJob.status.statusTextRu = statusText || activePullJob.status.statusTextRu;
            activePullJob.status.statusTextEn = statusText || activePullJob.status.statusTextEn;
            activePullJob.status.updatedAt = Date.now();
            persistPullStatus(activePullJob.status, false);
          },
        });

        if (res.ok) {
          item.status = 'done';
          item.percent = 100;
          item.source = res.source || 'ollama';
          activePullJob.status.completedCount = items.filter((x) => x.status === 'done' || x.status === 'skipped').length;
          activePullJob.status.currentPercent = 100;
          activePullJob.status.statusText = isEnPull ? `Installed: ${item.name}` : `Установлено: ${item.name}`;
          activePullJob.status.statusTextRu = `Установлено: ${item.name}`;
          activePullJob.status.statusTextEn = `Installed: ${item.name}`;
        } else {
          item.status = res.cancelled ? 'cancelled' : 'error';
          item.error = res.error || (isEnPull ? 'Download error' : 'Ошибка загрузки');
          if (!res.cancelled) errors.push(`${item.name}: ${item.error}`);
        }
        activePullJob.status.updatedAt = Date.now();
        persistPullStatus(activePullJob.status, true);
      }
    } finally {
      if (!execStepFn) {
        const refreshTags = await ollamaHttpJson('GET', '/api/tags', null, 800, cfg.gpuEndpoint).catch(() => null);
        if (refreshTags?.ok) updateOllamaTagsCache(cfg.gpuEndpoint, refreshTags.data?.models);
      }
      activePullJob.active = false;
      activePullJob.status.active = false;
      activePullJob.status.finishedAt = Date.now();
      activePullJob.status.updatedAt = Date.now();
      activePullJob.status.currentIndex = -1;
      activePullJob.status.currentModel = '';
      if (activePullJob.cancelRequested) {
        activePullJob.status.cancelled = true;
        activePullJob.status.statusText = isEnPull ? 'Download cancelled' : 'Загрузка отменена';
        activePullJob.status.statusTextRu = 'Загрузка отменена';
        activePullJob.status.statusTextEn = 'Download cancelled';
      } else if (errors.length > 0) {
        activePullJob.status.error = formatCompactPullError(errors.join('; '), 320);
        activePullJob.status.statusText = isEnPull
          ? `Completed with errors (${activePullJob.status.completedCount}/${items.length})`
          : `Завершено с ошибками (${activePullJob.status.completedCount}/${items.length})`;
        activePullJob.status.statusTextRu = `Завершено с ошибками (${activePullJob.status.completedCount}/${items.length})`;
        activePullJob.status.statusTextEn = `Completed with errors (${activePullJob.status.completedCount}/${items.length})`;
      } else {
        activePullJob.status.statusText = isEnPull
          ? `Done: downloaded ${activePullJob.status.completedCount}/${items.length} models ✓`
          : `Готово: загружено ${activePullJob.status.completedCount}/${items.length} моделей ✓`;
        activePullJob.status.statusTextRu = `Готово: загружено ${activePullJob.status.completedCount}/${items.length} моделей ✓`;
        activePullJob.status.statusTextEn = `Done: downloaded ${activePullJob.status.completedCount}/${items.length} models ✓`;
      }
      persistPullStatus(activePullJob.status, true);
    }
  };

  const loopPromise = runLoop().catch(() => {});
  if (awaitCompletion) {
    await loopPromise;
  }
  return getGpuPullJobStatus();
}

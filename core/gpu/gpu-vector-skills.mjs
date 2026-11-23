/**
 * @file gpu-vector-skills.mjs
 * @description Int8 MRL workspace vector store, semantic code search, and semantic skill matcher.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path, { dirname, join } from 'node:path';
import { extractFileSymbolsWithRanges } from '../repo-mapper.mjs';
import { atomicWriteJsonSync, safeReadJsonSync, sleepSync, withFileLockSync } from '../safe-json.mjs';
import {
  CACHE_DIR,
  CODE_DOC_SKIP_EXT,
  DEFAULT_GPU_CONFIG,
  PLUGIN_ROOT,
  gpuRuntime,
  loadGpuConfig,
  ollamaHttpJson,
  ramSkillVectorCache,
  ramVectorCache,
  recordGpuTelemetryPatch,
  sameEmbedModel,
} from './gpu-shared-state.mjs';
import {
  VRAM_CAP_TOLERANCE_MB,
  ensureOllamaRunning,
  estimateModelVramMb,
  evaluateGpuThermalAndLoadGuard,
  evaluateVramModelFit,
  getCachedOrFetchOllamaTagMap,
  normalizeOllamaTag,
  probeNvidiaGpu,
  unloadModelsExceedingBudget,
} from './gpu-vram-runtime.mjs';

function resolveMrlTargetDim(nativeLen, model, cfg) {
  if (!Number.isFinite(nativeLen) || nativeLen <= 0) return 0;
  if (/qwen3/i.test(model || '') && nativeLen >= 512) {
    return Math.min(nativeLen, Number(cfg?.gpuEmbedDim) || 512);
  }
  return nativeLen;
}

/**
 * Нормализует вектор (с опциональным MRL-усечением Matryoshka) к единичной длине (L2 norm = 1).
 */
function normalizeVector(arr, targetDim = 0) {
  if (!arr || typeof arr.length !== 'number' || arr.length === 0) return new Float32Array(0);
  const len = targetDim > 0 && targetDim < arr.length ? targetDim : arr.length;
  let sumSq = 0;
  for (let i = 0; i < len; i++) {
    const v = Number(arr[i]) || 0;
    sumSq += v * v;
  }
  const norm = Math.sqrt(sumSq) || 1;
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = (Number(arr[i]) || 0) / norm;
  }
  return out;
}

export function quantizeUnitToInt8(vec) {
  if (!vec || typeof vec.length !== 'number' || vec.length === 0) return new Int8Array(0);
  if (vec instanceof Int8Array) return vec;
  const out = new Int8Array(vec.length);
  let maxAbs = 0;
  for (let i = 0; i < vec.length; i++) {
    const a = Math.abs(Number(vec[i]) || 0);
    if (a > maxAbs) maxAbs = a;
  }
  if (maxAbs === 0) return out;
  const invScale = 127 / maxAbs;
  for (let i = 0; i < vec.length; i++) {
    out[i] = Math.max(-127, Math.min(127, Math.round((Number(vec[i]) || 0) * invScale)));
  }
  return out;
}

export function dotProductPrefix(a, b, prefixLen) {
  const len = Math.min(prefixLen, a.length, b.length);
  if (len === 0) return 0;
  let dot = 0;
  let sumA2 = 0;
  let sumB2 = 0;
  for (let i = 0; i < len; i++) {
    const av = a[i];
    const bv = b[i];
    dot += av * bv;
    sumA2 += av * av;
    sumB2 += bv * bv;
  }
  const denom = Math.sqrt(sumA2 * sumB2);
  return denom > 0 ? dot / denom : 0;
}

export function dotProductUnit(a, b) {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  if (b instanceof Int8Array) {
    let dot = 0;
    let sumB2 = 0;
    for (let i = 0; i < len; i++) {
      const bv = b[i];
      dot += a[i] * bv;
      sumB2 += bv * bv;
    }
    return sumB2 > 0 ? dot / Math.sqrt(sumB2) : 0;
  }
  let sum = 0;
  for (let i = 0; i < len; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}

export function formatEmbedInput(text, kind = 'document', model = '') {
  const clean = String(text || '').slice(0, 6500);
  if (/qwen3/i.test(model || '')) {
    if (kind === 'skill_query') {
      return `Instruct: Given a user software task or request, retrieve the specialized AI engineering skill profile whose capabilities best execute this task\nQuery: ${clean}`;
    }
    if (kind === 'query') {
      return `Instruct: Given a software engineering or code search query, retrieve relevant source code snippets, symbols, and documentation passages that answer the query\nQuery: ${clean}`;
    }
    return clean;
  }
  if (/nomic/i.test(model || '')) {
    const prefix = kind === 'document' ? 'search_document: ' : 'search_query: ';
    return prefix + clean;
  }
  return clean;
}

/**
 * Генерирует нормализованные векторы эмбеддингов через локальный /api/embed.
 * @param {string[]} texts
 * @param {'document'|'query'} [kind='document']
 * @param {object} [opts={}]
 */
export async function embedTexts(texts = [], kind = 'document', { model = '', timeoutMs = 20000 } = {}) {
  const cfg = loadGpuConfig();
  if (!cfg.gpuEnabled || !cfg.gpuSemanticSearch) {
    return { ok: false, error: 'GPU semantic search disabled' };
  }
  const list = Array.isArray(texts) ? texts.filter((t) => typeof t === 'string' && t.trim().length > 0) : [];
  if (list.length === 0) return { ok: true, embeddings: [] };

  const ready = await ensureOllamaRunning(cfg);
  if (!ready.ok) return { ok: false, error: ready.error };

  const targetModel = model || cfg.gpuEmbedModel;
  const estEmbedMb = estimateModelVramMb(targetModel, gpuRuntime.ollamaTagsCache.map, [], cfg.gpuEmbedModel);
  if (estEmbedMb > (cfg.gpuMaxVramMb + VRAM_CAP_TOLERANCE_MB)) {
    return {
      ok: false,
      skippedVramCap: true,
      error: `Embed model ${targetModel} (~${(estEmbedMb / 1024).toFixed(1)} GB) exceeds VRAM cap (${Math.round(cfg.gpuMaxVramMb / 1024)} GB)`,
    };
  }
  const formatted = list.map((t) => formatEmbedInput(t, kind, targetModel));

  const res = await ollamaHttpJson(
    'POST',
    '/api/embed',
    {
      model: targetModel,
      input: formatted.length === 1 ? formatted[0] : formatted,
      keep_alive: cfg.gpuEmbedKeepAlive || cfg.gpuKeepAlive,
    },
    timeoutMs,
    cfg.gpuEndpoint
  );

  if (!res.ok || !Array.isArray(res.data?.embeddings)) {
    return { ok: false, error: res.error || 'Ollama /api/embed failed' };
  }

  return {
    ok: true,
    model: targetModel,
    embeddings: res.data.embeddings.map((v) => normalizeVector(v, resolveMrlTargetDim(v?.length || 0, targetModel, cfg))),
  };
}

function extractFileExportsQuick(content) {
  const out = [];
  const seen = new Set();
  const re = /^\s*export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm;
  let m;
  while ((m = re.exec(content)) !== null) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      out.push(m[1]);
      if (out.length >= 8) break;
    }
  }
  return out;
}

function extractFirstSignature(lines, startLine1, endLine1) {
  const stop = Math.min(lines.length, startLine1 + 4, endLine1);
  for (let i = Math.max(0, startLine1 - 1); i < stop; i++) {
    const l = String(lines[i] || '').trim();
    if (!l || l.startsWith('//') || l.startsWith('*') || l.startsWith('/*')) continue;
    return l.replace(/\s+/g, ' ').slice(0, 110);
  }
  return '';
}

/**
 * Contextual Retrieval header builder (Файл + экспорты + сигнатура без LLM) and safe windowed range splitter.
 */
function formatContextualHeader(relPath, startLine, endLine, symbols = [], fileExports = [], sig = '') {
  const symText = Array.isArray(symbols) && symbols.length > 0 ? symbols.slice(0, 6).join(', ') : 'module';
  const expPart = Array.isArray(fileExports) && fileExports.length > 0 ? ` | Exports: ${fileExports.join(', ')}` : '';
  const sigPart = sig ? ` | Sig: ${sig}` : '';
  return `File: ${relPath} [L${startLine}-L${endLine}] | Symbols: ${symText}${expPart}${sigPart}`;
}

function emitWindowedRange(relPath, lines, fromLine1, toLine1, contextSymbols, { maxLines, overlapLines, maxChars, fileExports = [] }, outChunks) {
  const startIdx0 = Math.max(0, fromLine1 - 1);
  const stopIdx0 = Math.min(lines.length, toLine1);
  let idx = startIdx0;
  while (idx < stopIdx0) {
    let end = idx;
    let charAcc = 0;
    while (end < stopIdx0 && (end - idx) < maxLines) {
      const nextLen = lines[end].length + 1;
      if (charAcc > 0 && (charAcc + nextLen) > maxChars) break;
      charAcc += nextLen;
      end++;
    }
    if (end === idx) end = Math.min(stopIdx0, idx + 1);
    const body = lines.slice(idx, end).join('\n').trim();
    if (body.length >= 25) {
      const startLine = idx + 1;
      const endLine = end;
      const sig = extractFirstSignature(lines, startLine, endLine);
      outChunks.push({
        relPath,
        startLine,
        endLine,
        textForEmbed: `${formatContextualHeader(relPath, startLine, endLine, contextSymbols, fileExports, sig)}\n${body}`,
      });
    }
    if (end >= stopIdx0) break;
    // Safe forward advance (>= 50% of chunk height) avoids 1-line slide bloat on dense code
    const spanLen = end - idx;
    const safeOverlap = Math.min(overlapLines, Math.floor(spanLen / 3));
    const minNext = idx + Math.max(1, Math.floor(spanLen * 0.5));
    idx = Math.max(minNext, end - safeOverlap);
  }
}

/**
 * cAST-inspired structure-aware AST chunking with Contextual Retrieval headers.
 */
export function chunkFileForVectors(relPath, content, { maxLines = 55, overlapLines = 8, maxChars = 1700 } = {}) {
  const rawText = String(content || '');
  const lines = rawText.split(/\r?\n/);
  if (lines.length === 0) return [];
  const ext = path.extname(String(relPath || '')).toLowerCase();
  const fileExports = extractFileExportsQuick(rawText);

  let rawSpans = [];
  if (ext && !ext.endsWith('.md') && !ext.endsWith('.txt') && !ext.endsWith('.json')) {
    try {
      rawSpans = extractFileSymbolsWithRanges(ext, rawText) || [];
    } catch {
      rawSpans = [];
    }
  }

  const spans = rawSpans
    .filter((s) => s && Number.isFinite(s.startLine) && Number.isFinite(s.endLine) && s.startLine >= 1 && s.endLine >= s.startLine && s.endLine <= lines.length)
    .sort((a, b) => a.startLine - b.startLine || (b.endLine - a.endLine))
    .filter((s, idx, arr) => idx === 0 || s.startLine > arr[idx - 1].startLine || s.endLine > arr[idx - 1].endLine);

  // Deduplicate nested spans contained strictly inside a parent span that already fits comfortably
  const topSpans = [];
  for (const s of spans) {
    const prev = topSpans[topSpans.length - 1];
    if (prev && s.startLine >= prev.startLine && s.endLine <= prev.endLine && (prev.endLine - prev.startLine + 1) <= maxLines) {
      if (s.name && prev.subNames && !prev.subNames.includes(s.name)) {
        prev.subNames.push(s.name);
      }
      continue;
    }
    topSpans.push({
      startLine: s.startLine,
      endLine: s.endLine,
      names: s.name ? [s.name] : [],
      subNames: s.name ? [s.name] : [],
    });
  }

  const chunks = [];
  const opts = { maxLines, overlapLines, maxChars, fileExports };
  if (topSpans.length === 0) {
    emitWindowedRange(relPath, lines, 1, lines.length, [], opts, chunks);
    return chunks;
  }

  let cursorLine = 1;
  let i = 0;
  while (i < topSpans.length) {
    const span = topSpans[i];
    if (span.startLine > cursorLine) {
      emitWindowedRange(relPath, lines, cursorLine, span.startLine - 1, [], opts, chunks);
    }

    const effectiveStart = Math.max(cursorLine, span.startLine);
    let grpEnd = span.endLine;
    const grpSymbols = [...(span.subNames || span.names)];

    const spanHeight = grpEnd - effectiveStart + 1;
    const spanBody = lines.slice(effectiveStart - 1, grpEnd).join('\n');

    if (spanHeight > maxLines || spanBody.length > maxChars) {
      emitWindowedRange(relPath, lines, effectiveStart, grpEnd, grpSymbols, opts, chunks);
      cursorLine = Math.max(cursorLine, grpEnd + 1);
      i++;
      continue;
    }

    // cAST sibling merge: combine small adjacent symbols within line & char budgets
    let j = i + 1;
    while (j < topSpans.length) {
      const nextSpan = topSpans[j];
      const gapLines = nextSpan.startLine - grpEnd - 1;
      const mergedHeight = nextSpan.endLine - effectiveStart + 1;
      if (gapLines > 6 || mergedHeight > maxLines) break;
      const mergedLen = lines.slice(effectiveStart - 1, nextSpan.endLine).join('\n').length;
      if (mergedLen > maxChars) break;
      grpEnd = Math.max(grpEnd, nextSpan.endLine);
      for (const nm of nextSpan.subNames || nextSpan.names) {
        if (nm && !grpSymbols.includes(nm)) grpSymbols.push(nm);
      }
      j++;
    }

    const body = lines.slice(effectiveStart - 1, grpEnd).join('\n').trim();
    if (body.length >= 25) {
      const sig = extractFirstSignature(lines, effectiveStart, grpEnd);
      chunks.push({
        relPath,
        startLine: effectiveStart,
        endLine: grpEnd,
        textForEmbed: `${formatContextualHeader(relPath, effectiveStart, grpEnd, grpSymbols, fileExports, sig)}\n${body}`,
      });
    }
    cursorLine = Math.max(cursorLine, grpEnd + 1);
    i = j;
  }

  if (cursorLine <= lines.length) {
    emitWindowedRange(relPath, lines, cursorLine, lines.length, [], opts, chunks);
  }
  return chunks;
}

export function getVectorStorePaths(wsAbsRoot, embedModel = '') {
  const norm = process.platform === 'win32' ? wsAbsRoot.toLowerCase() : wsAbsRoot;
  const normEmbed = normalizeOllamaTag(embedModel || DEFAULT_GPU_CONFIG.gpuEmbedModel);
  const keyStr = (!normEmbed || normEmbed === DEFAULT_GPU_CONFIG.gpuEmbedModel)
    ? norm
    : `${norm}::embed=${normEmbed}`;
  const hash = createHash('sha1').update(keyStr).digest('hex').slice(0, 12);
  return {
    legacyJsonPath: join(CACHE_DIR, `gpu-vectors-${hash}.json`),
    metaPath: join(CACHE_DIR, `gpu-vectors-${hash}.meta.json`),
    binPath: join(CACHE_DIR, `gpu-vectors-${hash}.bin`),
  };
}

export function saveWorkspaceVectorStore(wsAbsRoot, store) {
  try {
    const targetDir = store?.metaPath ? path.dirname(store.metaPath) : CACHE_DIR;
    if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
    let totalDims = 0;
    let firstVecDim = 0;
    for (const val of store.files.values()) {
      for (const c of val.chunks || []) {
        if (c?.vec?.length > 0) {
          totalDims += c.vec.length;
          if (!firstVecDim) firstVecDim = c.vec.length;
        }
      }
    }

    const packed = new Int8Array(totalDims);
    const metaFiles = {};
    let cursor = 0;

    for (const [rel, val] of store.files.entries()) {
      const chunkTuples = [];
      for (const c of val.chunks || []) {
        const len = c?.vec?.length || 0;
        if (!len) continue;
        const qVec = quantizeUnitToInt8(c.vec);
        c.vec = qVec;
        packed.set(qVec, cursor);
        chunkTuples.push([c.startLine, c.endLine, cursor, len]);
        cursor += len;
      }
      if (chunkTuples.length > 0 || val.sha1) {
        metaFiles[rel] = { s: val.sha1 || '', c: chunkTuples };
      }
    }

    withFileLockSync(store.metaPath, () => {
      const tmpBin = `${store.binPath}.${process.pid}.${Date.now()}.tmp`;
      try {
        writeFileSync(tmpBin, Buffer.from(packed.buffer, packed.byteOffset, cursor));
        let renameErr = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            renameSync(tmpBin, store.binPath);
            renameErr = null;
            break;
          } catch (err) {
            renameErr = err;
            if ((err?.code === 'EPERM' || err?.code === 'EBUSY' || err?.code === 'EACCES') && attempt < 2) {
              sleepSync(25 * (attempt + 1));
              continue;
            }
            throw err;
          }
        }
        if (renameErr) throw renameErr;

        atomicWriteJsonSync(
          store.metaPath,
          {
            format: 'i8bin-v2',
            workspace: wsAbsRoot,
            model: store.model,
            dim: firstVecDim || store.dim || 0,
            updatedAt: new Date().toISOString(),
            files: metaFiles,
          },
          { spaces: 0 }
        );
        try {
          store.metaMtimeMs = statSync(store.metaPath).mtimeMs;
        } catch {}

        if (store.legacyJsonPath && existsSync(store.legacyJsonPath)) {
          try {
            unlinkSync(store.legacyJsonPath);
          } catch {}
        }
      } finally {
        if (existsSync(tmpBin)) {
          try {
            unlinkSync(tmpBin);
          } catch {}
        }
      }
    });
  } catch {}
}

export function loadWorkspaceVectorStore(wsAbsRoot, embedModel, { cacheDir = '' } = {}) {
  const normEmbed = normalizeOllamaTag(embedModel || DEFAULT_GPU_CONFIG.gpuEmbedModel);
  const normWs = process.platform === 'win32' ? wsAbsRoot.toLowerCase() : wsAbsRoot;
  const cacheKey = `${cacheDir ? `${cacheDir}::` : ''}${normWs}::${normEmbed}`;
  const basePaths = getVectorStorePaths(wsAbsRoot, embedModel);
  const paths = cacheDir
    ? {
        legacyJsonPath: join(cacheDir, path.basename(basePaths.legacyJsonPath)),
        metaPath: join(cacheDir, path.basename(basePaths.metaPath)),
        binPath: join(cacheDir, path.basename(basePaths.binPath)),
      }
    : basePaths;
  let diskMetaMtimeMs = 0;
  try {
    if (existsSync(paths.metaPath)) {
      diskMetaMtimeMs = statSync(paths.metaPath).mtimeMs;
    }
  } catch {}

  const mem = ramVectorCache.get(cacheKey);
  if (mem && sameEmbedModel(mem.model, embedModel) && mem.metaMtimeMs === diskMetaMtimeMs) return mem;

  const files = new Map();
  let totalChunks = 0;
  let storedDim = 0;
  let loadedFromBinary = false;

  if (existsSync(paths.metaPath) && existsSync(paths.binPath)) {
    const meta = safeReadJsonSync(paths.metaPath, () => null, { selfHeal: false });
    const cfg = loadGpuConfig();
    const expectedMrlDim = /qwen3/i.test(embedModel || '') ? (cfg.gpuEmbedDim || 512) : 0;
    const dimCompatible = !expectedMrlDim || !meta?.dim || meta.dim === expectedMrlDim;
    if (meta && meta.format === 'i8bin-v2' && sameEmbedModel(meta.model, embedModel) && dimCompatible && meta.files && typeof meta.files === 'object') {
      storedDim = Number(meta.dim || 0);
      try {
        const binBuf = readFileSync(paths.binPath);
        const ab = binBuf.buffer.slice(binBuf.byteOffset, binBuf.byteOffset + binBuf.byteLength);
        const allInt8 = new Int8Array(ab);

        for (const [rel, fData] of Object.entries(meta.files)) {
          const tuples = fData?.c;
          if (!fData || !Array.isArray(tuples)) continue;
          const chunks = [];
          for (const t of tuples) {
            if (!Array.isArray(t) || t.length < 4) continue;
            const [startLine, endLine, offset, len] = t;
            if (offset < 0 || len <= 0 || offset + len > allInt8.length) continue;
            if (!storedDim) storedDim = len;
            chunks.push({
              startLine,
              endLine,
              vec: allInt8.subarray(offset, offset + len),
            });
          }
          if (chunks.length > 0) {
            files.set(rel, { sha1: fData.s || '', chunks });
            totalChunks += chunks.length;
          }
        }
        loadedFromBinary = true;
      } catch {
        files.clear();
        totalChunks = 0;
      }
    } else if (meta && (meta.format !== 'i8bin-v2' || !sameEmbedModel(meta.model, embedModel) || !dimCompatible)) {
      // Stale vector store (old f32bin-v1, replaced embed model, or changed MRL dim): auto-purge so index rebuilds compact i8bin-v2
      for (const oldPath of [paths.binPath, paths.metaPath]) {
        try {
          if (existsSync(oldPath)) unlinkSync(oldPath);
        } catch {}
      }
    }
  }

  if (!loadedFromBinary && existsSync(paths.legacyJsonPath)) {
    try {
      unlinkSync(paths.legacyJsonPath);
    } catch {}
  }

  const slot = {
    model: embedModel,
    dim: storedDim,
    metaMtimeMs: diskMetaMtimeMs,
    files,
    totalChunks,
    metaPath: paths.metaPath,
    binPath: paths.binPath,
    legacyJsonPath: paths.legacyJsonPath,
  };

  ramVectorCache.set(cacheKey, slot);
  return slot;
}

/**
 * Инкрементально индексирует файлы из RAM-кэша (только новые или изменённые по SHA1) в векторное хранилище GPU.
 * @param {string} wsAbsRoot
 * @param {Map<string, object>} ramFilesMap Map<relPath, { buf, ext }>
 * @param {object} [options={}]
 */
export async function indexWorkspaceVectors(wsAbsRoot, ramFilesMap, { maxNewFiles = 200 } = {}) {
  const cfg = loadGpuConfig();
  if (!cfg.gpuEnabled || !cfg.gpuSemanticSearch) {
    return { ok: false, error: 'GPU semantic search disabled' };
  }
  const absRoot = path.resolve(wsAbsRoot);
  const store = loadWorkspaceVectorStore(absRoot, cfg.gpuEmbedModel);
  const isIgnoredVecRel = (rel) => /^(?:scratch|\.cache|\.git|\.agents|backups|\.shadow)[\\/]/i.test(rel);

  // Удаляем из индекса удалённые или служебные файлы
  let removed = 0;
  for (const rel of store.files.keys()) {
    if (!ramFilesMap.has(rel) || isIgnoredVecRel(rel)) {
      store.files.delete(rel);
      removed++;
    }
  }

  // Находим изменившиеся или новые файлы
  const pendingFiles = [];
  for (const [rel, entry] of ramFilesMap.entries()) {
    if (CODE_DOC_SKIP_EXT.has(entry.ext)) continue;
    if (isIgnoredVecRel(rel)) continue;
    if (entry.sizeBytes > 400_000) continue; // пропускаем огромные дампы
    const sha1 = createHash('sha1').update(entry.buf).digest('hex').slice(0, 16);
    const existing = store.files.get(rel);
    if (!existing || existing.sha1 !== sha1) {
      pendingFiles.push({ rel, entry, sha1 });
      if (pendingFiles.length >= maxNewFiles) break;
    }
  }

  if (pendingFiles.length === 0 && removed === 0) {
    return {
      ok: true,
      model: cfg.gpuEmbedModel,
      indexedNow: 0,
      totalFiles: store.files.size,
      totalChunks: store.totalChunks,
      cached: true,
    };
  }

  const hwBg = probeNvidiaGpu();
  const bgGuard = evaluateGpuThermalAndLoadGuard(hwBg, { isBackground: true });
  if (bgGuard.throttled) {
    return {
      ok: false,
      skippedThermalGuard: true,
      thermalReason: bgGuard.reason,
      tempC: bgGuard.tempC,
      utilPct: bgGuard.utilPct,
      error: bgGuard.message,
    };
  }

  const ready = await ensureOllamaRunning(cfg);
  if (!ready.ok) {
    return { ok: false, error: ready.error };
  }

  // Нарезаем чанки (многопоточно на CPU worker_threads при пакете >= 8 файлов) и отправляем батчами по 12 штук
  const allChunkJobs = [];
  const tempFileMap = new Map();
  let chunkBatched = false;
  if (pendingFiles.length >= 8) {
    try {
      const { loadCpuConfig, runCpuBatch } = await import('../cpu-worker-pool.mjs');
      if (loadCpuConfig().cpuMulticoreEnabled) {
        const batchInput = pendingFiles.map((pf) => ({
          relPath: pf.rel,
          sha1: pf.sha1,
          text: pf.entry.buf.toString('utf8'),
        }));
        const chunkedRes = await runCpuBatch('chunkVectorsBatch', batchInput, { minItemsForWorkers: 8 });
        if (Array.isArray(chunkedRes) && chunkedRes.length === pendingFiles.length) {
          for (const item of chunkedRes) {
            const chunks = item.chunks || [];
            tempFileMap.set(item.relPath, { sha1: item.sha1, expectedCount: chunks.length, chunks: [] });
            for (const c of chunks) {
              allChunkJobs.push({ rel: item.relPath, chunk: c });
            }
          }
          chunkBatched = true;
        }
      }
    } catch {}
  }
  if (!chunkBatched) {
    for (const pf of pendingFiles) {
      const content = pf.entry.buf.toString('utf8');
      const chunks = chunkFileForVectors(pf.rel, content);
      tempFileMap.set(pf.rel, { sha1: pf.sha1, expectedCount: chunks.length, chunks: [] });
      for (const c of chunks) {
        allChunkJobs.push({ rel: pf.rel, chunk: c });
      }
    }
  }

  const t0 = Date.now();
  const BATCH_SIZE = 12;
  let embeddedChunks = 0;

  for (let i = 0; i < allChunkJobs.length; i += BATCH_SIZE) {
    const slice = allChunkJobs.slice(i, i + BATCH_SIZE);
    const res = await embedTexts(slice.map((j) => j.chunk.textForEmbed), 'document', { model: cfg.gpuEmbedModel, timeoutMs: 25000 });
    if (res.ok && res.embeddings.length === slice.length) {
      for (let k = 0; k < slice.length; k++) {
        const job = slice[k];
        tempFileMap.get(job.rel).chunks.push({
          startLine: job.chunk.startLine,
          endLine: job.chunk.endLine,
          vec: quantizeUnitToInt8(res.embeddings[k]),
        });
        embeddedChunks++;
      }
    } else {
      // Поштучный фолбэк при сбое батча
      for (const job of slice) {
        const single = await embedTexts([job.chunk.textForEmbed.slice(0, 3500)], 'document', { model: cfg.gpuEmbedModel, timeoutMs: 10000 });
        if (single.ok && single.embeddings[0]) {
          tempFileMap.get(job.rel).chunks.push({
            startLine: job.chunk.startLine,
            endLine: job.chunk.endLine,
            vec: quantizeUnitToInt8(single.embeddings[0]),
          });
          embeddedChunks++;
        }
      }
    }
  }

  for (const [rel, data] of tempFileMap.entries()) {
    if (data.chunks.length > 0 && data.chunks.length === data.expectedCount) {
      store.files.set(rel, { sha1: data.sha1, chunks: data.chunks });
    } else if (data.chunks.length > 0) {
      // Частичная индексация при сбое батча: сохраняем доступные чанки, но сбрасываем sha1 для переиндексации
      store.files.set(rel, { sha1: '', chunks: data.chunks });
    }
  }

  let totalChunks = 0;
  for (const v of store.files.values()) totalChunks += v.chunks.length;
  store.totalChunks = totalChunks;
  saveWorkspaceVectorStore(absRoot, store);

  recordGpuTelemetryPatch((cur) => ({
    ...cur,
    indexedFiles: store.files.size,
    indexedChunks: totalChunks,
    lastAt: new Date().toISOString(),
  }));

  return {
    ok: true,
    model: cfg.gpuEmbedModel,
    indexedNow: tempFileMap.size,
    embeddedChunks,
    removed,
    totalFiles: store.files.size,
    totalChunks,
    elapsedMs: Date.now() - t0,
  };
}

/**
 * Инкрементально переиндексирует один изменённый файл в векторном хранилище GPU (для фонового debounce после edit/write).
 * @param {string} wsAbsRoot
 * @param {string} relPath
 * @param {Buffer|string} bufOrText
 */
export async function indexSingleFileVector(wsAbsRoot, relPath, bufOrText) {
  const cfg = loadGpuConfig();
  if (!cfg.gpuEnabled || !cfg.gpuSemanticSearch || !wsAbsRoot || !relPath) {
    return { ok: false, error: 'GPU semantic search disabled' };
  }
  const cleanRel = String(relPath).replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
  if (/^(?:scratch|\.cache|\.git|\.agents|backups|\.shadow)\//i.test(cleanRel)) {
    return { ok: true, skipped: true };
  }
  const ext = path.extname(cleanRel).toLowerCase();
  if (CODE_DOC_SKIP_EXT.has(ext)) return { ok: true, skipped: true };

  const buf = Buffer.isBuffer(bufOrText) ? bufOrText : Buffer.from(String(bufOrText || ''), 'utf8');
  if (buf.length === 0 || buf.length > 400_000) return { ok: true, skipped: true };

  const absRoot = path.resolve(wsAbsRoot);
  const store = loadWorkspaceVectorStore(absRoot, cfg.gpuEmbedModel);
  const sha1 = createHash('sha1').update(buf).digest('hex').slice(0, 16);
  const existing = store.files.get(cleanRel);
  if (existing && existing.sha1 === sha1) {
    return { ok: true, skipped: true, cached: true };
  }

  const hw = probeNvidiaGpu();
  const singleGuard = evaluateGpuThermalAndLoadGuard(hw, { isBackground: true });
  if (singleGuard.throttled) {
    return {
      ok: false,
      skippedThermalGuard: true,
      thermalReason: singleGuard.reason,
      tempC: singleGuard.tempC,
      utilPct: singleGuard.utilPct,
      error: singleGuard.message,
    };
  }
  if (hw?.available && hw.freeMb < 1200) {
    return { ok: false, skippedLowVram: true, error: 'Insufficient free VRAM for single-file indexing' };
  }

  const chunks = chunkFileForVectors(cleanRel, buf.toString('utf8'));
  if (chunks.length === 0) {
    store.files.delete(cleanRel);
    saveWorkspaceVectorStore(absRoot, store);
    return { ok: true, indexedChunks: 0 };
  }

  const res = await embedTexts(chunks.map((c) => c.textForEmbed), 'document', { model: cfg.gpuEmbedModel, timeoutMs: 12000 });
  if (!res.ok || res.embeddings.length !== chunks.length) {
    return { ok: false, error: res.error || 'Single-file embed failed' };
  }

  const packedChunks = chunks.map((c, idx) => ({
    startLine: c.startLine,
    endLine: c.endLine,
    vec: quantizeUnitToInt8(res.embeddings[idx]),
  }));
  store.files.set(cleanRel, { sha1, chunks: packedChunks });
  let totalChunks = 0;
  for (const v of store.files.values()) totalChunks += v.chunks.length;
  store.totalChunks = totalChunks;
  saveWorkspaceVectorStore(absRoot, store);

  recordGpuTelemetryPatch((cur) => ({
    ...cur,
    indexedFiles: store.files.size,
    indexedChunks: totalChunks,
    lastAt: new Date().toISOString(),
  }));

  return { ok: true, file: cleanRel, indexedChunks: packedChunks.length, totalChunks };
}

/**
 * Ищет наиболее близкие по смыслу фрагменты проекта через GPU-эмбеддинги с двухступенчатым MRL рескорингом.
 * @param {string} wsAbsRoot
 * @param {string} query
 * @param {number} [topK=8]
 */
export async function semanticSearchWorkspace(wsAbsRoot, query, topK = 8) {
  const cfg = loadGpuConfig();
  if (!cfg.gpuEnabled || !cfg.gpuSemanticSearch) {
    return { ok: false, error: 'GPU semantic search disabled', hits: [] };
  }
  const absRoot = path.resolve(wsAbsRoot);
  const store = loadWorkspaceVectorStore(absRoot, cfg.gpuEmbedModel);
  if (store.files.size === 0) {
    return { ok: true, empty: true, hits: [] };
  }

  const t0 = Date.now();
  const qRes = await embedTexts([query], 'query', { model: cfg.gpuEmbedModel, timeoutMs: 8000 });
  if (!qRes.ok || !qRes.embeddings[0]) {
    return { ok: false, error: qRes.error || 'Failed to embed query', hits: [] };
  }
  const qVec = qRes.embeddings[0];
  const allEntries = [];
  for (const [rel, fData] of store.files.entries()) {
    for (const chunk of fData.chunks) {
      if (chunk.vec && chunk.vec.length > 0) {
        allEntries.push({ rel, chunk });
      }
    }
  }

  let candidates = allEntries;
  if (allEntries.length > 96 && qVec.length >= 256) {
    const MRL_COARSE = 128;
    const coarseScored = allEntries.map((item) => ({
      item,
      coarseSim: dotProductPrefix(qVec, item.chunk.vec, MRL_COARSE),
    }));
    coarseScored.sort((a, b) => b.coarseSim - a.coarseSim);
    candidates = coarseScored.slice(0, Math.max(64, topK * 8)).map((x) => x.item);
  }

  const scored = candidates.map(({ rel, chunk }) => ({
    relPath: rel,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    similarity: Number(dotProductUnit(qVec, chunk.vec).toFixed(4)),
  }));

  scored.sort((a, b) => b.similarity - a.similarity);
  const hits = scored.slice(0, topK);

  recordGpuTelemetryPatch((cur) => ({
    ...cur,
    semanticSearches: (cur.semanticSearches || 0) + 1,
    lastLatencyMs: Date.now() - t0,
    lastModel: cfg.gpuEmbedModel,
    lastMode: 'semantic_search',
    lastAt: new Date().toISOString(),
  }));

  return {
    ok: true,
    model: cfg.gpuEmbedModel,
    totalChunksSearched: allEntries.length,
    elapsedMs: Date.now() - t0,
    hits,
  };
}

/**
 * Гарантирует прогрев лёгкой модели эмбеддингов (qwen3-embedding:0.6b, <1 ГБ VRAM) в видеопамяти.
 * @param {object} [opts={}]
 */
export async function ensureEmbedModelWarm({ minFreeVramMb = 1500, cfgOverride = null, hwProbeFn = null, isBackground = false } = {}) {
  const cfg = cfgOverride || loadGpuConfig();
  if (!cfg.gpuEnabled || !cfg.gpuSemanticSearch) {
    return { ok: false, error: 'GPU semantic search disabled' };
  }
  const preHw = hwProbeFn ? hwProbeFn() : probeNvidiaGpu();
  const warmGuard = evaluateGpuThermalAndLoadGuard(preHw, { isBackground });
  if (warmGuard.throttled) {
    return {
      ok: false,
      skippedThermalGuard: true,
      thermalReason: warmGuard.reason,
      tempC: warmGuard.tempC,
      utilPct: warmGuard.utilPct,
      error: warmGuard.message,
    };
  }
  const ready = await ensureOllamaRunning(cfg);
  if (!ready.ok) {
    return { ok: false, error: ready.error || 'Ollama not reachable' };
  }

  const psRes = await ollamaHttpJson('GET', '/api/ps', null, 800, cfg.gpuEndpoint);
  const loadedModels = Array.isArray(psRes.data?.models) ? psRes.data.models : [];
  const targetTag = normalizeOllamaTag(cfg.gpuEmbedModel);
  const estEmbedMb = estimateModelVramMb(cfg.gpuEmbedModel, gpuRuntime.ollamaTagsCache.map, [], cfg.gpuEmbedModel) || 950;
  if (estEmbedMb > (cfg.gpuMaxVramMb + VRAM_CAP_TOLERANCE_MB)) {
    return {
      ok: false,
      skippedVramCap: true,
      error: `Embed model ${cfg.gpuEmbedModel} exceeds VRAM cap (${Math.round(cfg.gpuMaxVramMb / 1024)} GB)`,
    };
  }

  const alreadyWarm = loadedModels.some((m) => {
    const name = m?.name || m?.model || '';
    return normalizeOllamaTag(name) === targetTag || sameEmbedModel(name, cfg.gpuEmbedModel);
  });
  if (alreadyWarm) {
    return { ok: true, alreadyWarm: true, model: cfg.gpuEmbedModel };
  }

  const hw = probeNvidiaGpu();
  await unloadModelsExceedingBudget({
    cfg,
    loadedModels,
    tagModels: gpuRuntime.ollamaTagsCache.map,
    hw,
    reserveForModel: { name: cfg.gpuEmbedModel, estVramMb: estEmbedMb, isEmbed: true },
  });
  if (hw?.available && hw.vramReliable && hw.freeMb < minFreeVramMb) {
    return { ok: false, skippedLowVram: true, error: `Insufficient free VRAM (${hw.freeMb}MB < ${minFreeVramMb}MB)` };
  }

  const res = await ollamaHttpJson(
    'POST',
    '/api/embed',
    {
      model: cfg.gpuEmbedModel,
      input: 'warmup',
      keep_alive: cfg.gpuEmbedKeepAlive || cfg.gpuKeepAlive,
    },
    12000,
    cfg.gpuEndpoint
  );
  return { ok: Boolean(res.ok), alreadyWarm: false, model: cfg.gpuEmbedModel, error: res.ok ? '' : (res.error || 'Warmup embed failed') };
}

function scoreWorkspaceCodeTargets(qVec, store, { topK = 6, minSim = 0.40 } = {}) {
  const bestByFile = new Map();
  for (const [rel, fData] of store.files.entries()) {
    let bestSim = -1;
    let bestChunk = null;
    for (const chunk of fData.chunks) {
      if (!chunk.vec || chunk.vec.length === 0) continue;
      if (qVec.length >= 256 && chunk.vec.length >= 256 && store.totalChunks > 120) {
        const coarse = dotProductPrefix(qVec, chunk.vec, 128);
        if (coarse < (minSim - 0.14)) continue;
      }
      const sim = dotProductUnit(qVec, chunk.vec);
      if (sim > bestSim) {
        bestSim = sim;
        bestChunk = chunk;
      }
    }
    if (bestChunk && bestSim >= minSim) {
      const cleanFile = rel.replace(/\\/g, '/');
      bestByFile.set(cleanFile, {
        file: cleanFile,
        score: Number(bestSim.toFixed(4)),
        startLine: bestChunk.startLine,
        endLine: bestChunk.endLine,
      });
    }
  }
  return Array.from(bestByFile.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

/**
 * Быстрый неблокирующий поиск целевых файлов по прогретому векторному индексу (<150 мс для хука PreInvocation и MCP).
 * Не запускает холодный старт Ollama и не индексирует файлы на лету — работает только если модель уже теплая в VRAM.
 * @param {string} wsAbsRoot
 * @param {string} query
 * @param {object} [opts={}]
 */
export async function peekWarmSemanticTargets(wsAbsRoot, query, { topK = 6, minSim = 0.40, timeoutMs = 85, recordTelemetry = false } = {}) {
  const bundle = await peekWarmSemanticBundle(wsAbsRoot, query, {
    topK,
    minSim,
    timeoutMs,
    recordTelemetry,
    includeCode: true,
    includeSkills: false,
  });
  return bundle.semanticFiles;
}

// --- Семантический векторный индекс скиллов (qwen3-embedding:0.6b + контрастные якоря + gemma4:12b фоллбэк) ---

const CONTRASTIVE_SKILL_ANCHORS = [
  'General conversation, greetings, weather, casual chat, simple factual Q&A unrelated to specialized engineering workflows.',
  'Standard backend API, SQL database schema, system design of queues/databases, migrations, REST/GraphQL CRUD, git commands, config files, basic bug fixes.',
  'Simple code explanation, reading a file, answering how a function works without specialized tooling.',
];

const UNSAFE_SKILL_SLUGS = new Set(['__proto__', 'constructor', 'prototype', 'tostring', 'valueof', 'hasownproperty']);

function normalizeSkillSlug(raw = '') {
  const slug = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/^-+|-+$/g, '');
  if (!slug || UNSAFE_SKILL_SLUGS.has(slug) || slug === 'proto') return '';
  return slug;
}

function parseSkillFrontmatterSimple(content = '') {
  const text = String(content || '');
  const fmMatch = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!fmMatch) return { name: '', description: '', body: text };

  const body = text.slice(fmMatch[0].length);
  const lines = fmMatch[1].split(/\r?\n/);
  let name = '';
  let description = '';

  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    const rawVal = kv[2].trim();
    let val = '';
    if (/^[>|]-?$/.test(rawVal)) {
      const folded = rawVal.startsWith('>');
      const block = [];
      let j = i + 1;
      while (j < lines.length) {
        if (/^\s+\S/.test(lines[j])) {
          block.push(lines[j].trim());
          j++;
        } else if (!lines[j].trim()) {
          block.push('');
          j++;
        } else {
          break;
        }
      }
      i = j - 1;
      val = folded ? block.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim() : block.join('\n').trim();
    } else {
      val = rawVal.replace(/^['"]|['"]$/g, '').trim();
    }
    if (key === 'name') name = val;
    if (key === 'description') description = val;
  }

  return { name, description, body };
}

/**
 * Сканирует каталог скиллов и формирует мульти-секционные текстовые профили (desc + sections + evals)
 * без привязки к словарям ключевых слов. При указании customRoot читает ТОЛЬКО его.
 * @param {string} [customRoot='']
 */
export function discoverSkillSemanticEntries(customRoot = '') {
  const dirs = customRoot
    ? [path.resolve(customRoot)]
    : [
        join(PLUGIN_ROOT, 'skills'),
        join(os.homedir(), '.gemini', 'config', 'plugins', 'antigravity-model-router', 'skills'),
        join(os.homedir(), '.gemini', 'config', 'skills'),
        join(os.homedir(), '.gemini', 'antigravity', 'skills'),
      ];

  const bySlug = new Map();
  for (const dir of dirs) {
    if (!dir || !existsSync(dir)) continue;
    let subEntries = [];
    try {
      subEntries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of subEntries) {
      if (!entry?.isDirectory?.()) continue;
      const slug = normalizeSkillSlug(entry.name);
      if (!slug || bySlug.has(slug)) continue;

      const folder = join(dir, entry.name);
      const skillFile = join(folder, 'SKILL.md');
      if (!existsSync(skillFile)) continue;

      let rawSkillMd = '';
      try {
        rawSkillMd = readFileSync(skillFile, 'utf8');
      } catch {
        continue;
      }

      const fm = parseSkillFrontmatterSimple(rawSkillMd);
      const cleanBody = fm.body.replace(/```[\s\S]*?```/g, '');
      const chunks = [
        { kind: 'desc', text: `${slug}: ${fm.description || fm.name || entry.name}` },
      ];

      const sections = cleanBody
        .split(/^##+\s+/m)
        .map((s) => s.split(/\r?\n/).filter((l) => !l.trim().startsWith('|')).join('\n').trim())
        .filter((s) => s.length > 30)
        .slice(0, 5);
      for (const sec of sections) {
        chunks.push({ kind: 'sec', text: `${slug} — ${sec.slice(0, 420)}` });
      }

      let rawEvals = '';
      const evalsFile = join(folder, 'evals', 'evals.json');
      if (existsSync(evalsFile)) {
        try {
          rawEvals = readFileSync(evalsFile, 'utf8');
          const parsedEvals = JSON.parse(rawEvals);
          const posList = Array.isArray(parsedEvals?.positive) ? parsedEvals.positive.slice(0, 4) : [];
          for (const item of posList) {
            if (typeof item === 'string' && item.trim()) {
              chunks.push({ kind: 'sec', text: `${slug} — ${item.trim().slice(0, 320)}` });
            }
          }
          const negList = Array.isArray(parsedEvals?.negative) ? parsedEvals.negative.slice(0, 4) : [];
          for (const item of negList) {
            if (typeof item === 'string' && item.trim()) {
              chunks.push({ kind: 'neg', text: item.trim().slice(0, 320) });
            }
          }
        } catch {}
      }

      const sha1 = createHash('sha1')
        .update(`${slug}\n${rawSkillMd}\n${rawEvals}`)
        .digest('hex')
        .slice(0, 16);

      bySlug.set(slug, {
        slug,
        name: fm.name || entry.name,
        description: fm.description || '',
        path: folder,
        sha1,
        chunks,
      });
    }
  }

  return Array.from(bySlug.values());
}

function getSkillVectorStoreMeta(embedModel, customRoot = '') {
  const normTag = normalizeOllamaTag(embedModel);
  const scopeKey = customRoot ? path.resolve(customRoot) : '__default__';
  const cacheScope = process.platform === 'win32' ? scopeKey.toLowerCase() : scopeKey;
  const cacheKey = `${cacheScope}::${normTag}`;
  if (customRoot) {
    return { cacheKey, storePath: '' };
  }
  const modelHash = createHash('sha1').update(normTag || 'default').digest('hex').slice(0, 12);
  return {
    cacheKey,
    storePath: join(CACHE_DIR, `gpu-skill-vectors-${modelHash}.json`),
  };
}

function countRealSkills(entriesMap) {
  let count = 0;
  for (const slug of entriesMap.keys()) {
    if (slug !== '__none__') count++;
  }
  return count;
}

function loadSkillVectorStore(embedModel, customRoot = '') {
  const cfg = loadGpuConfig();
  const { cacheKey, storePath } = getSkillVectorStoreMeta(embedModel, customRoot);
  let diskMtimeMs = 0;
  if (storePath && existsSync(storePath)) {
    try {
      diskMtimeMs = statSync(storePath).mtimeMs;
    } catch {}
  }

  const mem = ramSkillVectorCache.get(cacheKey);
  if (mem && sameEmbedModel(mem.model, embedModel) && (!storePath || mem.metaMtimeMs === diskMtimeMs)) {
    return mem;
  }

  const entries = new Map();
  let dim = 0;
  if (storePath && existsSync(storePath)) {
    const raw = safeReadJsonSync(storePath, () => null, { selfHeal: false });
    const expectedDim = /qwen3/i.test(embedModel || '') ? (cfg.gpuEmbedDim || 512) : 0;
    const dimOk = !expectedDim || !raw?.dim || raw.dim === expectedDim;
    if (raw && raw.format === 'skill-i8-v1' && sameEmbedModel(raw.model, embedModel) && dimOk && raw.entries && typeof raw.entries === 'object') {
      dim = Number(raw.dim || 0);
      for (const [slug, val] of Object.entries(raw.entries)) {
        if (!val || !Array.isArray(val.chunks)) continue;
        const hydratedChunks = [];
        for (const c of val.chunks) {
          if (!c || !Array.isArray(c.vec) || c.vec.length === 0) continue;
          if (!dim) dim = c.vec.length;
          hydratedChunks.push({
            kind: String(c.kind || 'sec'),
            vec: Int8Array.from(c.vec),
          });
        }
        if (hydratedChunks.length > 0) {
          entries.set(slug, { sha1: String(val.sha1 || ''), chunks: hydratedChunks });
        }
      }
    }
  }

  const slot = {
    cacheKey,
    storePath,
    model: embedModel,
    dim,
    metaMtimeMs: diskMtimeMs,
    skillsCount: countRealSkills(entries),
    entries,
  };
  ramSkillVectorCache.set(cacheKey, slot);
  return slot;
}

function saveSkillVectorStore(store) {
  if (!store || !store.storePath) return;
  try {
    if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
    const serialized = {};
    for (const [slug, val] of store.entries.entries()) {
      serialized[slug] = {
        sha1: val.sha1 || '',
        chunks: (val.chunks || []).map((c) => ({
          kind: c.kind || 'sec',
          vec: Array.from(c.vec || []),
        })),
      };
    }
    atomicWriteJsonSync(
      store.storePath,
      {
        format: 'skill-i8-v1',
        model: store.model,
        dim: store.dim || 0,
        updatedAt: new Date().toISOString(),
        entries: serialized,
      },
      { spaces: 0 }
    );
    try {
      store.metaMtimeMs = statSync(store.storePath).mtimeMs;
    } catch {}
  } catch {}
}

/**
 * Инкрементально строит и кэширует мульти-секционный векторный индекс скиллов в памяти/на диске
 * с контрастными анти-якорями __none__ (поддерживает инъекцию embedBatchFn для оффлайн-тестов).
 * @param {object} [opts={}]
 */
export async function indexSkillVectors({
  customRoot = '',
  cfgOverride = null,
  timeoutMs = 15000,
  embedBatchFn = null,
} = {}) {
  const cfg = cfgOverride || loadGpuConfig();
  if (!embedBatchFn && (!cfg.gpuEnabled || !cfg.gpuSemanticSearch)) {
    return { ok: false, error: 'GPU semantic search disabled' };
  }

  const skillEntries = discoverSkillSemanticEntries(customRoot);
  const store = loadSkillVectorStore(cfg.gpuEmbedModel, customRoot);

  if (skillEntries.length === 0) {
    store.entries.clear();
    store.skillsCount = 0;
    return { ok: true, skillsCount: 0, chunksCount: 0, updatedCount: 0, store };
  }

  const anchorSha1 = createHash('sha1').update(CONTRASTIVE_SKILL_ANCHORS.join('\n')).digest('hex').slice(0, 16);
  const desiredEntries = [
    ...skillEntries,
    {
      slug: '__none__',
      sha1: anchorSha1,
      chunks: CONTRASTIVE_SKILL_ANCHORS.map((text) => ({ kind: 'anchor', text })),
    },
  ];
  const validSlugs = new Set(desiredEntries.map((e) => e.slug));

  let prunedCount = 0;
  for (const existingSlug of store.entries.keys()) {
    if (!validSlugs.has(existingSlug)) {
      store.entries.delete(existingSlug);
      prunedCount++;
    }
  }

  const toEmbedEntries = desiredEntries.filter((e) => {
    const cached = store.entries.get(e.slug);
    return !cached || cached.sha1 !== e.sha1 || !Array.isArray(cached.chunks) || cached.chunks.length === 0;
  });

  if (toEmbedEntries.length > 0) {
    if (!embedBatchFn) {
      const ready = await ensureOllamaRunning(cfg);
      if (!ready.ok) {
        return { ok: false, error: ready.error || 'Ollama not reachable' };
      }
    }

    const flatItems = [];
    for (const e of toEmbedEntries) {
      for (const ch of e.chunks) {
        flatItems.push({ slug: e.slug, sha1: e.sha1, kind: ch.kind, text: ch.text });
      }
    }

    const rawEmbeddings = [];
    const batchSize = 48;
    for (let i = 0; i < flatItems.length; i += batchSize) {
      const slice = flatItems.slice(i, i + batchSize);
      const texts = slice.map((item) => item.text);
      if (embedBatchFn) {
        const out = await embedBatchFn(texts, 'document');
        const list = Array.isArray(out) ? out : (Array.isArray(out?.embeddings) ? out.embeddings : null);
        if (!list || list.length !== slice.length) {
          return { ok: false, error: 'Custom embedBatchFn returned mismatched embeddings' };
        }
        rawEmbeddings.push(...list);
      } else {
        const res = await ollamaHttpJson(
          'POST',
          '/api/embed',
          {
            model: cfg.gpuEmbedModel,
            input: texts.map((t) => formatEmbedInput(t, 'document', cfg.gpuEmbedModel)),
            truncate: true,
            keep_alive: cfg.gpuEmbedKeepAlive || cfg.gpuKeepAlive,
          },
          timeoutMs,
          cfg.gpuEndpoint
        );
        if (!res.ok || !Array.isArray(res.data?.embeddings) || res.data.embeddings.length !== slice.length) {
          return { ok: false, error: res.error || 'Skill embed batch failed' };
        }
        rawEmbeddings.push(...res.data.embeddings);
      }
    }

    const grouped = new Map();
    for (let i = 0; i < flatItems.length; i++) {
      const metaItem = flatItems[i];
      const rawEmb = rawEmbeddings[i];
      const normVec = normalizeVector(rawEmb, resolveMrlTargetDim(rawEmb?.length || 0, cfg.gpuEmbedModel, cfg));
      if (!store.dim && normVec.length > 0) store.dim = normVec.length;
      const qVec = quantizeUnitToInt8(normVec);
      if (!grouped.has(metaItem.slug)) {
        grouped.set(metaItem.slug, { sha1: metaItem.sha1, chunks: [] });
      }
      grouped.get(metaItem.slug).chunks.push({ kind: metaItem.kind, vec: qVec });
    }
    for (const [slug, val] of grouped.entries()) {
      store.entries.set(slug, val);
    }
  }

  store.skillsCount = countRealSkills(store.entries);
  ramSkillVectorCache.set(store.cacheKey, store);
  if (store.storePath && (toEmbedEntries.length > 0 || prunedCount > 0)) {
    saveSkillVectorStore(store);
  }

  let chunksCount = 0;
  for (const val of store.entries.values()) {
    chunksCount += val.chunks?.length || 0;
  }
  return {
    ok: true,
    skillsCount: store.skillsCount,
    chunksCount,
    updatedCount: toEmbedEntries.length,
    store,
  };
}

/**
 * Ранжирует скиллы по косинусному сходству к вектору задачи относительно контрастных анти-якорей __none__.
 * @param {Float32Array|number[]} qSkillVec
 * @param {object} skillStore
 * @param {object} [opts={}]
 */
export function scoreSkillVectorsWithQueryVec(
  qSkillVec,
  skillStore,
  { topK = 3, minScore = 0.46, minDeltaVsNone = 0.04, minMargin = 0.02 } = {}
) {
  if (!qSkillVec || qSkillVec.length === 0 || !skillStore?.entries || skillStore.entries.size === 0) {
    return { warm: false, bestNoneSim: 0, candidates: [], rawTop: [] };
  }

  let bestNoneSim = 0;
  const anchorEntry = skillStore.entries.get('__none__');
  if (anchorEntry?.chunks?.length > 0) {
    bestNoneSim = -1;
    for (const ch of anchorEntry.chunks) {
      if (!ch?.vec || ch.vec.length === 0) continue;
      const sim = dotProductUnit(qSkillVec, ch.vec);
      if (sim > bestNoneSim) bestNoneSim = sim;
    }
    if (bestNoneSim < -0.99) bestNoneSim = 0;
  }

  const rawScores = [];
  for (const [slug, entry] of skillStore.entries.entries()) {
    if (slug === '__none__' || !Array.isArray(entry?.chunks)) continue;
    let descSim = -1;
    let maxSecSim = -1;
    let maxNegSim = -1;

    for (const ch of entry.chunks) {
      if (!ch?.vec || ch.vec.length === 0) continue;
      const sim = dotProductUnit(qSkillVec, ch.vec);
      if (ch.kind === 'desc') {
        if (sim > descSim) descSim = sim;
      } else if (ch.kind === 'neg') {
        if (sim > maxNegSim) maxNegSim = sim;
      } else {
        if (sim > maxSecSim) maxSecSim = sim;
      }
    }

    if (descSim < 0 && maxSecSim < 0) continue;
    const effectiveDesc = descSim >= 0 ? descSim : maxSecSim;
    let baseScore = maxSecSim > 0
      ? (0.55 * Math.max(effectiveDesc, maxSecSim) + 0.45 * effectiveDesc)
      : effectiveDesc;
    if (maxNegSim > 0.55 && maxNegSim > baseScore - 0.03) {
      baseScore -= (maxNegSim - baseScore + 0.06);
    }

    rawScores.push({
      slug,
      score: Number(baseScore.toFixed(4)),
      descSim: Number(effectiveDesc.toFixed(4)),
      maxSecSim: Number((maxSecSim > 0 ? maxSecSim : effectiveDesc).toFixed(4)),
    });
  }

  rawScores.sort((a, b) => b.score - a.score);
  const ranked = rawScores.map((item, idx) => {
    const nextScore = rawScores[idx + 1]?.score ?? 0;
    const deltaVsNone = Number((item.score - bestNoneSim).toFixed(4));
    const margin = Number((item.score - nextScore).toFixed(4));
    return {
      ...item,
      deltaVsNone,
      margin,
      confident: item.score >= 0.48 && deltaVsNone >= 0.05 && margin >= minMargin,
      source: 'vector',
    };
  });

  const candidates = ranked
    .filter((item) => item.score >= minScore && item.deltaVsNone >= minDeltaVsNone)
    .slice(0, topK);

  return {
    warm: true,
    bestNoneSim: Number(bestNoneSim.toFixed(4)),
    candidates,
    rawTop: ranked.slice(0, topK),
  };
}

/**
 * Единый горячий пакетный запрос (<150 мс): за один вызов /api/embed получает цели кода И семантические скиллы.
 * @param {string} wsAbsRoot
 * @param {string} query
 * @param {object} [opts={}]
 */
export async function peekWarmSemanticBundle(
  wsAbsRoot,
  query,
  {
    topK = 6,
    minSim = 0.38,
    skillTopK = 3,
    timeoutMs = 150,
    recordTelemetry = false,
    includeCode = true,
    includeSkills = true,
  } = {}
) {
  const empty = { semanticFiles: [], semanticSkills: [], skillIndexWarm: false };
  try {
    if (gpuRuntime.ollamaOfflineUntilTs > Date.now()) {
      return empty;
    }
    const cfg = loadGpuConfig();
    if (!cfg.gpuEnabled || !cfg.gpuSemanticSearch || !query || String(query).trim().length < 5) {
      return empty;
    }

    const codeStore = includeCode && wsAbsRoot
      ? loadWorkspaceVectorStore(path.resolve(wsAbsRoot), cfg.gpuEmbedModel)
      : null;
    const skillStore = includeSkills ? loadSkillVectorStore(cfg.gpuEmbedModel) : null;

    if (includeSkills && (!skillStore || skillStore.skillsCount === 0) && !gpuRuntime.bgSkillIndexInFlight) {
      gpuRuntime.bgSkillIndexInFlight = true;
      indexSkillVectors({ cfgOverride: cfg }).catch(() => {}).finally(() => {
        gpuRuntime.bgSkillIndexInFlight = false;
      });
    }

    const hasCode = Boolean(codeStore && codeStore.files.size > 0);
    const hasSkills = Boolean(skillStore && skillStore.skillsCount > 0);
    if (!hasCode && !hasSkills) {
      return { ...empty, skillIndexWarm: hasSkills };
    }

    const inputs = [];
    let codeIdx = -1;
    let skillIdx = -1;
    if (hasCode) {
      codeIdx = inputs.length;
      inputs.push(formatEmbedInput(query, 'query', cfg.gpuEmbedModel));
    }
    if (hasSkills) {
      skillIdx = inputs.length;
      inputs.push(formatEmbedInput(query, 'skill_query', cfg.gpuEmbedModel));
    }

    const t0 = Date.now();
    const res = await ollamaHttpJson(
      'POST',
      '/api/embed',
      {
        model: cfg.gpuEmbedModel,
        input: inputs.length === 1 ? inputs[0] : inputs,
        truncate: true,
        keep_alive: cfg.gpuEmbedKeepAlive || cfg.gpuKeepAlive,
      },
      timeoutMs,
      cfg.gpuEndpoint
    );
    if (!res.ok || !Array.isArray(res.data?.embeddings) || res.data.embeddings.length === 0) {
      if (!res.ok && /timeout/i.test(String(res.error || '')) && !gpuRuntime.bgEmbedWarmInFlight) {
        gpuRuntime.bgEmbedWarmInFlight = true;
        ensureEmbedModelWarm({ cfgOverride: cfg }).catch(() => {}).finally(() => {
          gpuRuntime.bgEmbedWarmInFlight = false;
        });
      }
      return { ...empty, skillIndexWarm: hasSkills };
    }

    let semanticFiles = [];
    if (codeIdx >= 0 && Array.isArray(res.data.embeddings[codeIdx])) {
      const rawCode = res.data.embeddings[codeIdx];
      const qCodeVec = normalizeVector(rawCode, resolveMrlTargetDim(rawCode.length, cfg.gpuEmbedModel, cfg));
      semanticFiles = scoreWorkspaceCodeTargets(qCodeVec, codeStore, { topK, minSim });
    }

    let semanticSkills = [];
    if (skillIdx >= 0 && Array.isArray(res.data.embeddings[skillIdx])) {
      const rawSkill = res.data.embeddings[skillIdx];
      const qSkillVec = normalizeVector(rawSkill, resolveMrlTargetDim(rawSkill.length, cfg.gpuEmbedModel, cfg));
      const scored = scoreSkillVectorsWithQueryVec(qSkillVec, skillStore, { topK: skillTopK });
      semanticSkills = scored.candidates;
    }

    if (recordTelemetry && (semanticFiles.length > 0 || semanticSkills.length > 0)) {
      recordGpuTelemetryPatch((cur) => ({
        ...cur,
        semanticSearches: (cur.semanticSearches || 0) + 1,
        lastLatencyMs: Date.now() - t0,
        lastModel: cfg.gpuEmbedModel,
        lastMode: 'pre_invocation_warm',
        lastAt: new Date().toISOString(),
      }));
    }

    return { semanticFiles, semanticSkills, skillIndexWarm: hasSkills };
  } catch {
    return empty;
  }
}

/**
 * Прямой быстрый поиск семантических скиллов по тёплому индексу (<120 мс).
 * @param {string} query
 * @param {object} [opts={}]
 */
export async function peekWarmSemanticSkills(query, { topK = 3, timeoutMs = 120 } = {}) {
  const bundle = await peekWarmSemanticBundle('', query, {
    skillTopK: topK,
    timeoutMs,
    includeCode: false,
    includeSkills: true,
  });
  return {
    semanticSkills: bundle.semanticSkills,
    skillIndexWarm: bundle.skillIndexWarm,
  };
}

/**
 * Генеративный фоллбэк-классификатор на локальной gemma4:12b (для серой зоны или оффлайн CLI).
 * Возвращает строгий JSON {"slug": "<exact_slug_or_none>", "confidence": 0.0}.
 * @param {string} queryText
 * @param {Array<object>} [skillsList=[]]
 * @param {object} [opts={}]
 */
export async function classifySkillWithLlm(
  queryText,
  skillsList = [],
  { timeoutMs = 12000, model = '', cfgOverride = null, chatHttpFn = null, tagModels = null, hwProbeFn = null } = {}
) {
  const cleanQuery = String(queryText || '').trim();
  const list = Array.isArray(skillsList) ? skillsList.filter((s) => s && s.slug) : [];
  if (!cleanQuery || list.length === 0) {
    return { ok: false, slug: '', confidence: 0 };
  }

  const cfg = cfgOverride ? loadGpuConfig(cfgOverride) : loadGpuConfig();
  if (!chatHttpFn && !cfg.gpuEnabled) {
    return { ok: false, slug: '', confidence: 0, error: 'GPU engine disabled' };
  }
  if (!chatHttpFn) {
    const ready = await ensureOllamaRunning(cfg);
    if (!ready.ok) {
      return { ok: false, slug: '', confidence: 0, error: ready.error || 'Ollama not reachable' };
    }
  }

  const requestedModel = model || cfg.gpuChatModel;
  let targetModel = requestedModel;
  const shouldCheckVram = Boolean(!chatHttpFn || cfgOverride || tagModels);

  if (shouldCheckVram) {
    const hw = hwProbeFn ? hwProbeFn() : (!chatHttpFn ? probeNvidiaGpu() : null);
    let loadedModels = [];
    let tagSource = tagModels;
    if (!chatHttpFn) {
      const psRes = await ollamaHttpJson('GET', '/api/ps', null, 800, cfg.gpuEndpoint);
      loadedModels = Array.isArray(psRes?.data?.models) ? psRes.data.models : [];
      if (!tagSource) {
        tagSource = await getCachedOrFetchOllamaTagMap(cfg);
      }
    }
    const fit = evaluateVramModelFit({
      cfg: { ...cfg, gpuChatModel: requestedModel },
      tagModels: tagSource,
      loadedModels,
      hw,
    });
    const tagInventoryKnown = Array.isArray(tagSource) || (tagSource instanceof Map && tagSource.size > 0);
    if (fit.selectedSizeFits && (!tagInventoryKnown || fit.selectedChatDownloaded)) {
      targetModel = requestedModel;
    } else if (!model && fit.bestFallbackChatModel) {
      targetModel = fit.bestFallbackChatModel;
    } else {
      if (!chatHttpFn && loadedModels.length > 0) {
        await unloadModelsExceedingBudget({ cfg, loadedModels, tagModels: tagSource, hw });
      }
      return {
        ok: false,
        skippedVramCap: true,
        needsModelDownload: fit.needsModelDownload,
        recommendedPullModel: fit.recommendedPullModel,
        slug: '',
        confidence: 0,
        error: fit.reasonRu || `Модель ${requestedModel} превышает лимит ${fit.capGb} ГБ VRAM`,
      };
    }

    if (!chatHttpFn) {
      const estMb = estimateModelVramMb(targetModel, tagSource, [], cfg.gpuEmbedModel);
      await unloadModelsExceedingBudget({
        cfg,
        loadedModels,
        tagModels: tagSource,
        hw,
        reserveForModel: { name: targetModel, estVramMb: estMb, isEmbed: false },
      });
    }
  }

  const cappedCatalog = list.slice(0, 20);
  const catalogText = cappedCatalog
    .map((s) => `- ${s.slug}: ${String(s.description || s.name || s.slug).replace(/\s+/g, ' ').slice(0, 220)}`)
    .join('\n');
  const allowedSlugEnum = Array.from(new Set([...cappedCatalog.map((s) => s.slug), 'none']));
  const skillJsonSchema = {
    type: 'object',
    properties: {
      slug: { type: 'string', enum: allowedSlugEnum },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
    },
    required: ['slug', 'confidence'],
    additionalProperties: false,
  };

  const body = {
    model: targetModel,
    stream: false,
    keep_alive: cfg.gpuKeepAlive,
    format: skillJsonSchema,
    messages: [
      {
        role: 'system',
        content:
          'You are an intent classifier for engineering AI skills. Pick the single exact skill slug from the provided list ONLY if the task genuinely needs that specialized workflow; otherwise return "none" (e.g. generic CRUD, SQL design, git commands, simple Q&A or casual chat). Output strict JSON: {"slug":"<exact_slug_or_none>","confidence":0.0}.',
      },
      {
        role: 'user',
        content: `Task:\n${cleanQuery.slice(0, 1200)}\n\nAvailable skills:\n${catalogText}`,
      },
    ],
    options: {
      temperature: 0,
      num_predict: 96,
      num_ctx: 4096,
    },
  };
  if (/qwen3|gemma4/i.test(targetModel)) {
    body.think = false;
  }

  const invokeChat = async (payload) => {
    if (chatHttpFn) return chatHttpFn(payload);
    return ollamaHttpJson('POST', '/api/chat', payload, timeoutMs, cfg.gpuEndpoint);
  };

  let activeBody = body;
  let chatRes = await invokeChat(activeBody);
  if (!chatRes?.ok && Object.hasOwn(activeBody, 'think') && /think/i.test(String(chatRes?.error || ''))) {
    activeBody = { ...activeBody };
    delete activeBody.think;
    chatRes = await invokeChat(activeBody);
  }
  if (!chatRes?.ok && typeof activeBody.format === 'object' && /format|schema|json/i.test(String(chatRes?.error || ''))) {
    activeBody = { ...activeBody, format: 'json' };
    chatRes = await invokeChat(activeBody);
  }
  if (!chatRes?.ok) {
    return { ok: false, slug: '', confidence: 0, error: chatRes?.error || 'LLM classification failed' };
  }

  const rawContent = String(chatRes.data?.message?.content || chatRes.data?.response || '').trim();
  const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { ok: false, slug: '', confidence: 0, error: 'Malformed JSON from LLM classifier' };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    const rawSlug = String(parsed?.slug || '').trim().toLowerCase();
    const confidence = Number(parsed?.confidence ?? 0);
    if (!rawSlug || rawSlug === 'none') {
      return { ok: true, slug: '', confidence: Number.isFinite(confidence) ? confidence : 0, model: targetModel };
    }
    const matched = list.find((s) => s.slug.toLowerCase() === rawSlug);
    if (!matched || !Number.isFinite(confidence) || confidence < 0.55) {
      return { ok: true, slug: '', confidence: Number.isFinite(confidence) ? confidence : 0, model: targetModel };
    }
    return {
      ok: true,
      slug: matched.slug,
      confidence: Number(confidence.toFixed(4)),
      model: targetModel,
    };
  } catch {
    return { ok: false, slug: '', confidence: 0, error: 'JSON parse error from LLM classifier' };
  }
}

/**
 * Двухступенчатый AI-классификатор скиллов: Stage 1 векторы qwen3-embedding:0.6b -> Stage 2 gemma4:12b.
 * @param {string} queryText
 * @param {object} [opts={}]
 */
export async function matchSkillsAi(
  queryText,
  {
    customRoot = '',
    allowLlmFallback = true,
    topK = 3,
    embedTimeoutMs = 5000,
    llmTimeoutMs = 12000,
    embedQueryFn = null,
    embedBatchFn = null,
    llmJudgeFn = null,
  } = {}
) {
  const cleanQuery = String(queryText || '').trim();
  const skills = discoverSkillSemanticEntries(customRoot);
  if (!cleanQuery || skills.length === 0) {
    return { ok: true, source: 'empty', bestSlug: '', candidates: [] };
  }

  const cfg = loadGpuConfig();
  let scored = null;

  try {
    const idxRes = await indexSkillVectors({
      customRoot,
      cfgOverride: cfg,
      timeoutMs: embedTimeoutMs,
      embedBatchFn,
    });

    if (idxRes?.ok && idxRes.store && idxRes.store.skillsCount > 0) {
      let rawQueryEmb = null;
      if (embedQueryFn) {
        const qOut = await embedQueryFn(cleanQuery);
        rawQueryEmb = Array.isArray(qOut) || ArrayBuffer.isView(qOut)
          ? qOut
          : (Array.isArray(qOut?.embeddings?.[0]) ? qOut.embeddings[0] : null);
      } else if (cfg.gpuEnabled && cfg.gpuSemanticSearch) {
        const embRes = await ollamaHttpJson(
          'POST',
          '/api/embed',
          {
            model: cfg.gpuEmbedModel,
            input: formatEmbedInput(cleanQuery, 'skill_query', cfg.gpuEmbedModel),
            truncate: true,
            keep_alive: cfg.gpuEmbedKeepAlive || cfg.gpuKeepAlive,
          },
          embedTimeoutMs,
          cfg.gpuEndpoint
        );
        if (embRes.ok && Array.isArray(embRes.data?.embeddings?.[0])) {
          rawQueryEmb = embRes.data.embeddings[0];
        }
      }

      if (rawQueryEmb && rawQueryEmb.length > 0) {
        const qSkillVec = normalizeVector(
          rawQueryEmb,
          resolveMrlTargetDim(rawQueryEmb.length, cfg.gpuEmbedModel, cfg)
        );
        scored = scoreSkillVectorsWithQueryVec(qSkillVec, idxRes.store, { topK });

        if (scored.candidates[0]?.confident) {
          return {
            ok: true,
            source: 'vector',
            bestSlug: scored.candidates[0].slug,
            candidates: scored.candidates,
          };
        }

        const topRaw = scored.rawTop[0];
        if (topRaw && (topRaw.score - scored.bestNoneSim) <= -0.03) {
          return {
            ok: true,
            source: 'vector_none',
            bestSlug: '',
            candidates: [],
          };
        }
      }
    }
  } catch {}

  if (allowLlmFallback) {
    const bySlug = new Map(skills.map((s) => [s.slug, s]));
    const candidateMetas = scored?.rawTop?.length > 0
      ? scored.rawTop.slice(0, 5).map((r) => bySlug.get(r.slug)).filter(Boolean)
      : skills.slice(0, 20);
    if (candidateMetas.length > 0) {
      const llmRes = llmJudgeFn
        ? await llmJudgeFn(cleanQuery, candidateMetas)
        : await classifySkillWithLlm(cleanQuery, candidateMetas, { timeoutMs: llmTimeoutMs, cfgOverride: cfg });
      if (llmRes?.ok && llmRes.slug) {
        const conf = Number(llmRes.confidence || 0.7);
        return {
          ok: true,
          source: 'llm_fallback',
          bestSlug: llmRes.slug,
          candidates: [
            {
              slug: llmRes.slug,
              score: Number(conf.toFixed(4)),
              confident: true,
              source: 'llm_fallback',
            },
          ],
        };
      }
    }
  }

  return {
    ok: true,
    source: 'none',
    bestSlug: '',
    candidates: scored?.candidates || [],
  };
}

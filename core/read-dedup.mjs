/**
 * @file read-dedup.mjs
 * @description Read-Once Context Hash Guard. Prevents duplicate file re-reads within the same chat session
 * to conserve context tokens, with a zero-deadlock fail-safe mechanism.
 */

import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { peekActiveModelFromTranscript, resolveReadDedupPolicy } from './model-profile.mjs';
import { atomicWriteJsonSync, safeReadJsonSync, updateJsonAtomicSync } from './safe-json.mjs';
import {
  clearReadSnapshots,
  computeMyersLineDelta,
  loadReadSnapshot,
  saveReadSnapshot,
} from './cpu-delta-reread.mjs';
import { recordCpuCompressionSaving } from './cpu-worker-pool.mjs';
import { resolveTunnelCacheDir } from './cache-dir.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, '..');
const getCacheDir = () => resolveTunnelCacheDir(PLUGIN_ROOT);
const getDedupFile = () => join(getCacheDir(), 'read-dedup-state.json');
const getCompactionStateFile = () => join(getCacheDir(), 'compaction-state.json');

const MAX_ENTRIES = 120;
const TTL_MS = 6 * 60 * 60 * 1000; // 6 hours auto-prune TTL
const ACTIVE_WINDOW_MS = 3 * 60 * 1000; // 3 minutes active context window before compaction/truncation
const IDE_MAX_READ_LINES = 800;
const IDE_MAX_READ_BYTES = 46080;
const UNSAFE_PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty']);

/**
 * Merges a new [start, end] interval into an existing list of intervals,
 * merging ONLY overlapping or contiguous intervals so disjoint slices never falsely cover the gap.
 * @param {Array<[number, number]>} existingRanges
 * @param {[number, number]} newRange
 * @returns {Array<[number, number]>}
 */
function mergeContiguousRanges(existingRanges = [], [newStart, newEnd]) {
  const all = [...existingRanges.filter((r) => Array.isArray(r) && r.length === 2), [newStart, newEnd]];
  all.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [s, e] of all) {
    if (merged.length === 0) {
      merged.push([s, e]);
    } else {
      const last = merged[merged.length - 1];
      if (s <= last[1] + 1) {
        last[1] = Math.max(last[1], e);
      } else {
        merged.push([s, e]);
      }
    }
  }
  return merged;
}

/**
 * Ensures cache directory exists.
 */
function ensureCacheDir() {
  const dir = getCacheDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Creates default initial state.
 * @returns {{ version: number, entries: Array<object> }}
 */
function createInitialState() {
  return {
    version: 1,
    entries: []
  };
}

function peekTranscriptCompactionTailTs(transcriptPath = '') {
  if (!transcriptPath || typeof transcriptPath !== 'string' || !existsSync(transcriptPath)) {
    return 0;
  }
  let stat;
  try {
    stat = statSync(transcriptPath);
  } catch {
    return 0;
  }
  if (!stat.size) return 0;

  const tailBytes = Math.min(stat.size, 32768);
  const buf = Buffer.allocUnsafe(tailBytes);
  let fd = null;
  try {
    fd = openSync(transcriptPath, 'r');
    readSync(fd, buf, 0, tailBytes, stat.size - tailBytes);
  } catch {
    return 0;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch {}
    }
  }

  const tailText = buf.toString('utf-8');
  if (
    !tailText.includes('<CONTEXT_SUMMARY>') &&
    !tailText.includes('CHECKPOINT') &&
    !tailText.includes('Resuming from a compaction')
  ) {
    return 0;
  }

  const lines = tailText.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (
      !line ||
      (!line.includes('<CONTEXT_SUMMARY>') &&
        !line.includes('CHECKPOINT') &&
        !line.includes('Resuming from a compaction'))
    ) {
      continue;
    }
    try {
      const obj = JSON.parse(line);
      const isBoundary =
        obj?.type === 'CHECKPOINT' ||
        (typeof obj?.content === 'string' &&
          (obj.content.includes('<CONTEXT_SUMMARY>') || obj.content.includes('# Resuming from a compaction')));
      if (isBoundary) {
        const parsedTs = obj.created_at ? Date.parse(obj.created_at) : NaN;
        return Number.isFinite(parsedTs) && parsedTs > 0 ? parsedTs : stat.mtimeMs;
      }
    } catch {}
  }
  return 0;
}

/**
 * Checks whether the requested file read is a duplicate of content already present in context.
 * Guarantees zero-deadlock: duplicate reads are blocked at most once; subsequent attempts proceed.
 *
 * @param {object} params
 * @param {string} [params.filePath=''] Target file path
 * @param {number} [params.startLine=1] Requested start line (1-indexed)
 * @param {number} [params.endLine=999999] Requested end line (inclusive)
 * @param {number} [params.byteOffset=0] Byte offset for pagination
 * @param {string} [params.conversationId='default'] Active conversation ID
 * @param {number} [params.stepIdx=0] Current trajectory step index
 * @param {object|null} [params.modelProfile=null] Active model profile (optional)
 * @param {string} [params.transcriptPath=''] Active transcript.jsonl path for compaction reset check
 * @returns {{ allow: boolean, duplicate: boolean, savedBytes: number, sha1?: string, reason: string }}
 */
export function checkAndRecordRead(opts = {}) {
  const {
    filePath = '',
    startLine = 1,
    endLine = 999999,
    byteOffset = 0,
    conversationId = 'default',
    stepIdx = 0,
    modelProfile = null,
    transcriptPath = ''
  } = opts && typeof opts === 'object' ? opts : {};
  if (!filePath || typeof filePath !== 'string') {
    return { allow: true, duplicate: false, savedBytes: 0, reason: '' };
  }

  // Never block pagination of truncated lines/files via ByteOffset > 0
  if (Number(byteOffset) > 0) {
    return { allow: true, duplicate: false, savedBytes: 0, reason: '' };
  }

  // Normalize path and ignore internal caches
  const normSlash = filePath.replace(/\\/g, '/').toLowerCase();
  if (normSlash.includes('/.cache/') || normSlash.includes('/.system_generated/')) {
    return { allow: true, duplicate: false, savedBytes: 0, reason: '' };
  }

  if (!existsSync(filePath)) {
    return { allow: true, duplicate: false, savedBytes: 0, reason: '' };
  }

  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    return { allow: true, duplicate: false, savedBytes: 0, reason: '' };
  }

  // Skip tiny files (<600 B) and large binary/blob files (>5 MB)
  if (!stat.isFile() || stat.size < 600 || stat.size > 5 * 1024 * 1024) {
    return { allow: true, duplicate: false, savedBytes: 0, reason: '' };
  }

  let normPath = '';
  try {
    normPath = resolve(filePath).toLowerCase();
  } catch {
    normPath = filePath.toLowerCase();
  }

  const rawConvo = String(conversationId || 'default');
  const convoKey = UNSAFE_PROTO_KEYS.has(rawConvo) ? 'default' : rawConvo;
  const curStep = Number(stepIdx) || 0;
  ensureCacheDir();

  const effStart = Math.max(1, Number(startLine) || 1);
  const rawEnd = Number(endLine);

  // Zero-disk-read fast-path when file mtime + size are unchanged since last SHA-1 computation
  const preState = safeReadJsonSync(getDedupFile(), createInitialState, { selfHeal: false });
  const preEntry = Array.isArray(preState?.entries)
    ? preState.entries.find((e) => e && e.convoKey === convoKey && e.normPath === normPath)
    : null;

  let sha1 = '';
  let totalLines = 0;
  let effEnd = effStart;
  let sliceBytes = 0;
  let rawContent = null;

  const canUseMetaFastPath =
    Boolean(preEntry) &&
    !preEntry.editedSinceRead &&
    preEntry.mtimeMs === stat.mtimeMs &&
    preEntry.fileSize === stat.size &&
    Boolean(preEntry.sha1) &&
    Number(preEntry.totalLines) > 0 &&
    (stat.size <= IDE_MAX_READ_BYTES ||
      (Array.isArray(preEntry.ranges) &&
        rawEnd > 0 &&
        rawEnd < 999999 &&
        preEntry.ranges.some(([rs, re]) => rs <= effStart && re >= Math.min(preEntry.totalLines, effStart + IDE_MAX_READ_LINES - 1, rawEnd))));

  if (canUseMetaFastPath) {
    sha1 = preEntry.sha1;
    totalLines = preEntry.totalLines;
    effEnd = Math.max(
      effStart,
      Math.min(
        totalLines,
        effStart + IDE_MAX_READ_LINES - 1,
        rawEnd && rawEnd < 999999 ? rawEnd : totalLines
      )
    );
    sliceBytes = Math.min(stat.size, Math.max(1, Math.round((stat.size * (effEnd - effStart + 1)) / totalLines)));
  } else {
    let content = '';
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      return { allow: true, duplicate: false, savedBytes: 0, reason: '' };
    }
    rawContent = content;

    sha1 = createHash('sha1').update(content).digest('hex');
    const lines = content.split('\n');
    totalLines = lines.length;
    // IDE read_file enforces BOTH 800 lines and 46,080 bytes per call
    const maxLineEnd = Math.max(
      effStart,
      Math.min(
        totalLines,
        effStart + IDE_MAX_READ_LINES - 1,
        rawEnd && rawEnd < 999999 ? rawEnd : totalLines
      )
    );
    let cumBytes = 0;
    let actualEnd = effStart - 1;
    for (let i = effStart - 1; i < maxLineEnd; i++) {
      const lineBytes = Buffer.byteLength(lines[i], 'utf-8') + (i > effStart - 1 ? 1 : 0);
      if (cumBytes + lineBytes > IDE_MAX_READ_BYTES) {
        break;
      }
      cumBytes += lineBytes;
      actualEnd = i + 1; // 1-based complete line
    }
    // If even the first requested line exceeds 46,080 bytes, it was truncated mid-line: allow without recording full-line coverage
    if (actualEnd < effStart) {
      return { allow: true, duplicate: false, savedBytes: 0, sha1: sha1.slice(0, 8), reason: '' };
    }
    effEnd = actualEnd;
    sliceBytes = cumBytes;
  }

  const shortHash = sha1.slice(0, 8);
  const baseConvoKey = convoKey.replace(/__[0-9a-f]{8}$/i, '') || 'default';
  const compState = safeReadJsonSync(getCompactionStateFile(), () => ({ epochs: {}, resetTimestamps: {} }), { selfHeal: false });
  const compactionEpoch = Number((compState?.epochs?.[convoKey] ?? compState?.epochs?.[baseConvoKey]) || 0);
  const stateResetTs = Math.max(
    Number(compState?.resetTimestamps?.[convoKey] || 0),
    Number(compState?.resetTimestamps?.[baseConvoKey] || 0)
  );
  const tailResetTs = transcriptPath ? peekTranscriptCompactionTailTs(transcriptPath) : 0;
  const effectiveResetTs = Math.max(stateResetTs, tailResetTs);

  const activeProfile = modelProfile || peekActiveModelFromTranscript(transcriptPath || '', conversationId === 'default' ? '' : conversationId);
  const dedupPolicy = resolveReadDedupPolicy(activeProfile);
  const activeWindowMs = dedupPolicy.activeWindowMs || ACTIVE_WINDOW_MS;
  const maxStepGap = dedupPolicy.maxStepGap || 18;

  let result = { allow: true, duplicate: false, savedBytes: 0, sha1: shortHash, reason: '' };
  let snapshotToSave = null;
  let deltaTelemetry = null;

  updateJsonAtomicSync(getDedupFile(), createInitialState, (state) => {
    const curTime = Number.isFinite(Number(opts?.nowMs)) ? Number(opts.nowMs) : Date.now();
    let entries = Array.isArray(state?.entries) ? state.entries : [];

    // Auto-prune entries older than 6 hours
    entries = entries.filter((e) => e && (curTime - (e.ts || 0) <= TTL_MS));

    const existingIdx = entries.findIndex(
      (e) => e.convoKey === convoKey && e.normPath === normPath
    );
    const entry = existingIdx >= 0 ? entries[existingIdx] : null;

    const withinTimeWindow = Boolean(entry) && (curTime - (entry.ts || 0)) <= activeWindowMs;
    const withinStepWindow = curStep === 0 || (curStep - (entry?.stepIdx || 0)) <= maxStepGap;
    const afterCompactionReset = effectiveResetTs > 0 && (entry?.ts || 0) <= effectiveResetTs;
    const sameCompactionEpoch = (entry?.compactionEpoch ?? compactionEpoch) === compactionEpoch;
    const isFreshEntry =
      Boolean(entry) &&
      entry.sha1 === sha1 &&
      withinTimeWindow &&
      withinStepWindow &&
      !afterCompactionReset &&
      sameCompactionEpoch;

    const priorRanges = entry
      ? (Array.isArray(entry.ranges) && entry.ranges.length > 0
          ? entry.ranges
          : [[entry.startLine ?? 1, entry.endLine ?? 999999]])
      : [];
    const existingRanges = isFreshEntry ? priorRanges : [];

    const priorCoversRange =
      Boolean(entry) &&
      priorRanges.some(
        ([rs, re]) => rs <= effStart && (re >= effEnd || (re >= (entry.totalLines || 0) && effEnd <= totalLines))
      );

    const canTryDelta =
      Boolean(entry) &&
      rawContent !== null &&
      withinTimeWindow &&
      withinStepWindow &&
      !afterCompactionReset &&
      sameCompactionEpoch &&
      priorCoversRange &&
      entry.sha1 !== sha1 &&
      entry.deltaServedSha1 !== sha1;

    let deltaRes = null;
    if (canTryDelta) {
      const prevText = loadReadSnapshot({ sha1: entry.sha1, normPath, convoKey });
      if (typeof prevText === 'string' && prevText.length > 0) {
        deltaRes = computeMyersLineDelta(prevText, rawContent, {
          startLine: effStart,
          endLine: effEnd,
        });
      }
    }

    const isCovered = isFreshEntry && existingRanges.some(([rs, re]) => rs <= effStart && re >= effEnd);
    const isSameStepHookEcho = curStep === 0 && (entry?.stepIdx || 0) === 0 && (curTime - (entry?.ts || 0)) < 500;

    if (deltaRes?.canUseDelta) {
      const mergedDeltaRanges = mergeContiguousRanges(priorRanges, [effStart, effEnd]);
      entries[existingIdx] = {
        convoKey,
        normPath,
        fileName: basename(filePath),
        sha1,
        mtimeMs: stat.mtimeMs,
        fileSize: stat.size,
        totalLines,
        compactionEpoch,
        startLine: mergedDeltaRanges[0][0],
        endLine: mergedDeltaRanges[mergedDeltaRanges.length - 1][1],
        ranges: mergedDeltaRanges,
        stepIdx: curStep,
        blockedOnce: true,
        editedSinceRead: false,
        deltaServedSha1: sha1,
        ts: curTime,
      };
      if (totalLines >= 60 && stat.size <= 384 * 1024) {
        snapshotToSave = { sha1, text: rawContent, normPath, filePath, convoKey };
      }
      deltaTelemetry = { savedChars: deltaRes.savedBytes, latencyMs: deltaRes.elapsedMs };
      result = {
        allow: false,
        duplicate: false,
        deltaCompressed: true,
        savedBytes: deltaRes.savedBytes,
        sha1: shortHash,
        reason: `⚡ [CPU Delta-on-Reread] \`${basename(filePath)}\` [L${effStart}-L${effEnd}] (+${deltaRes.addedLines}/-${deltaRes.removedLines}L, saved ${deltaRes.savedBytes}B / ~${deltaRes.savedTokensEstimate} tok, SHA-1 ${shortHash}):\n${deltaRes.diffText}`,
      };
    } else if (isCovered && entry.blockedOnce !== true && !isSameStepHookEcho) {
      // Mark as blocked once to ensure zero-deadlock fail-safe on retry
      entry.blockedOnce = true;
      entry.editedSinceRead = false;
      entry.ts = curTime;
      result = {
        allow: false,
        duplicate: true,
        savedBytes: sliceBytes,
        sha1: shortHash,
        reason: `♻️ [Read-Once Guard] \`${basename(filePath)}\` [L${effStart}-L${effEnd}] is unchanged on disk (SHA-1 ${shortHash}). Reuse content already in chat context instead of re-reading.`
      };
    } else {
      // First read, disk content changed, post-compaction reset, disjoint/wider range, or blockedOnce consumed
      const baseRanges = (isFreshEntry && !entry?.blockedOnce) ? existingRanges : [];
      const mergedRanges = mergeContiguousRanges(baseRanges, [effStart, effEnd]);
      const newEntry = {
        convoKey,
        normPath,
        fileName: basename(filePath),
        sha1,
        mtimeMs: stat.mtimeMs,
        fileSize: stat.size,
        totalLines,
        compactionEpoch,
        startLine: mergedRanges[0][0],
        endLine: mergedRanges[mergedRanges.length - 1][1],
        ranges: mergedRanges,
        stepIdx: curStep,
        blockedOnce: false,
        editedSinceRead: false,
        deltaServedSha1: isFreshEntry ? (entry?.deltaServedSha1 || '') : '',
        ts: curTime
      };

      if (existingIdx >= 0) {
        entries[existingIdx] = newEntry;
      } else {
        entries.push(newEntry);
      }

      if (rawContent !== null && totalLines >= 60 && stat.size <= 384 * 1024) {
        snapshotToSave = { sha1, text: rawContent, normPath, filePath, convoKey };
      }

      result = {
        allow: true,
        duplicate: false,
        savedBytes: 0,
        sha1: shortHash,
        reason: ''
      };
    }

    // Cap max entries
    if (entries.length > MAX_ENTRIES) {
      entries = entries.slice(-MAX_ENTRIES);
    }

    return {
      version: 1,
      entries
    };
  });

  if (snapshotToSave) {
    saveReadSnapshot(snapshotToSave);
  }
  if (deltaTelemetry) {
    try {
      recordCpuCompressionSaving({
        kind: 'delta_reread',
        savedChars: deltaTelemetry.savedChars,
        latencyMs: deltaTelemetry.latencyMs,
      });
    } catch {}
  }

  return result;
}

/**
 * Marks read cache entries for a modified file as edited so the next re-read can
 * serve a Myers line delta without losing the previous SHA-1 or snapshot.
 * @param {string} [filePath='']
 */
export function markFileEditedForDelta(filePath = '') {
  if (!filePath || typeof filePath !== 'string') return;
  let targetNorm = '';
  try {
    targetNorm = resolve(filePath).toLowerCase();
  } catch {
    targetNorm = filePath.toLowerCase();
  }

  ensureCacheDir();
  updateJsonAtomicSync(getDedupFile(), createInitialState, (state) => {
    const entries = Array.isArray(state?.entries) ? state.entries : [];
    for (const e of entries) {
      if (e && e.normPath === targetNorm) {
        e.editedSinceRead = true;
        e.blockedOnce = false;
      }
    }
    return {
      version: 1,
      entries
    };
  });
}

/**
 * Invalidates read cache entries for a modified file.
 * @param {string} [filePath='']
 */
export function invalidateReadCacheForFile(filePath = '') {
  if (!filePath || typeof filePath !== 'string') return;
  let targetNorm = '';
  try {
    targetNorm = resolve(filePath).toLowerCase();
  } catch {
    targetNorm = filePath.toLowerCase();
  }

  ensureCacheDir();
  updateJsonAtomicSync(getDedupFile(), createInitialState, (state) => {
    const entries = (state?.entries || []).filter((e) => e && e.normPath !== targetNorm);
    return {
      version: 1,
      entries
    };
  });
  clearReadSnapshots({ filePath, normPath: targetNorm });
}

/**
 * Invalidates read cache entries for a conversation (e.g., after /compact or <CONTEXT_SUMMARY>).
 * @param {string} [conversationId='default']
 */
export function invalidateReadCacheForConvo(conversationId = 'default') {
  const rawConvo = String(conversationId || 'default');
  const convoKey = UNSAFE_PROTO_KEYS.has(rawConvo) ? 'default' : rawConvo;
  const baseKey = convoKey.replace(/__[0-9a-f]{8}$/i, '') || 'default';
  ensureCacheDir();
  updateJsonAtomicSync(getDedupFile(), createInitialState, (state) => {
    const entries = (state?.entries || []).filter((e) => {
      if (!e) return false;
      const k = String(e.convoKey || '');
      return k !== convoKey && k !== baseKey && !k.startsWith(`${baseKey}__`);
    });
    return {
      version: 1,
      entries,
    };
  });
  clearReadSnapshots({ conversationId: convoKey, convoKey });
}

/**
 * Clears read deduplication state cache.
 */
export function resetReadDedupState() {
  ensureCacheDir();
  atomicWriteJsonSync(getDedupFile(), createInitialState());
  clearReadSnapshots();
}

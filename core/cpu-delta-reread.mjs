/**
 * @file cpu-delta-reread.mjs
 * @description Mechanic #5: Myers Delta-on-Reread + compressed read snapshot cache (.cache/read-snapshots/).
 * Computes bounded Myers line diffs over [startLine..endLine] when an already-read file is edited
 * and re-read within the active context window, avoiding full-file re-reads.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';
import { extractFileSymbolsWithRanges } from './repo-mapper.mjs';
import { safeReadJsonSync, updateJsonAtomicSync } from './safe-json.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, '..');
const SNAPSHOT_DIR = join(PLUGIN_ROOT, '.cache', 'read-snapshots');
const SNAPSHOT_INDEX_FILE = join(SNAPSHOT_DIR, 'index.json');

const MIN_SNAPSHOT_LINES = 60;
const MAX_SNAPSHOT_BYTES = 384 * 1024; // 384 KB
const SNAPSHOT_LRU_CAP = 40;
const SNAPSHOT_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const MAX_MYERS_D = 800;

function ensureSnapshotDir() {
  if (!existsSync(SNAPSHOT_DIR)) {
    mkdirSync(SNAPSHOT_DIR, { recursive: true });
  }
}

function defaultSnapshotIndex() {
  return { version: 1, entries: [] };
}

function normalizePathSafe(filePath = '') {
  if (!filePath || typeof filePath !== 'string') return '';
  try {
    return resolve(filePath).toLowerCase();
  } catch {
    return filePath.toLowerCase();
  }
}

function sanitizeSha1(sha1 = '') {
  const clean = String(sha1 || '').trim().toLowerCase().replace(/[^0-9a-f]/g, '');
  return clean.length >= 8 ? clean : '';
}

function snapshotBlobPath(sha1) {
  return join(SNAPSHOT_DIR, `${sha1}.zlib`);
}

function removeOrphanBlobs(activeEntries = []) {
  try {
    if (!existsSync(SNAPSHOT_DIR)) return;
    const keepFiles = new Set(['index.json', 'index.json.lock']);
    for (const e of activeEntries) {
      if (e?.sha1) keepFiles.add(`${e.sha1}.zlib`);
    }
    const files = readdirSync(SNAPSHOT_DIR);
    for (const f of files) {
      if (!keepFiles.has(f) && f.endsWith('.zlib')) {
        try {
          rmSync(join(SNAPSHOT_DIR, f), { force: true });
        } catch {}
      }
    }
  } catch {}
}

/**
 * Saves a zlib-compressed text snapshot for a file (>=60 lines and <=384KB).
 * Supports either an options object or `(sha1, text, meta)` positional form.
 * @param {object|string} params
 * @returns {boolean}
 */
export function saveReadSnapshot(params = {}, positionalText = undefined, positionalMeta = {}) {
  const opts = typeof params === 'string'
    ? { sha1: params, text: positionalText, ...(positionalMeta || {}) }
    : (params && typeof params === 'object' ? params : {});

  const sha1 = sanitizeSha1(opts.sha1);
  const text = typeof opts.text === 'string' ? opts.text : '';
  if (!sha1 || !text) return false;

  const rawBytes = Buffer.byteLength(text, 'utf8');
  if (rawBytes > MAX_SNAPSHOT_BYTES) return false;

  const lines = text.split('\n').length;
  if (lines < MIN_SNAPSHOT_LINES) return false;

  const normPath = opts.normPath ? String(opts.normPath).toLowerCase() : normalizePathSafe(opts.filePath || '');
  const convoKey = String(opts.convoKey || opts.conversationId || 'default');

  try {
    ensureSnapshotDir();
    const compressed = deflateSync(Buffer.from(text, 'utf8'));
    writeFileSync(snapshotBlobPath(sha1), compressed);

    let activeEntries = [];
    updateJsonAtomicSync(SNAPSHOT_INDEX_FILE, defaultSnapshotIndex, (state) => {
      const now = Date.now();
      let entries = (Array.isArray(state?.entries) ? state.entries : []).filter(
        (e) => e && e.sha1 && (now - (e.ts || 0) <= SNAPSHOT_TTL_MS)
      );

      const idx = entries.findIndex(
        (e) => e.sha1 === sha1 && (!normPath || e.normPath === normPath) && (!convoKey || e.convoKey === convoKey)
      );
      const record = {
        sha1,
        normPath,
        convoKey,
        lines,
        rawBytes,
        compressedBytes: compressed.length,
        ts: now,
      };
      if (idx >= 0) {
        entries[idx] = record;
      } else {
        entries.push(record);
      }

      // Enforce LRU cap (keep most recently used)
      entries.sort((a, b) => (a.ts || 0) - (b.ts || 0));
      if (entries.length > SNAPSHOT_LRU_CAP) {
        entries = entries.slice(-SNAPSHOT_LRU_CAP);
      }
      activeEntries = entries;
      return { version: 1, entries };
    });

    removeOrphanBlobs(activeEntries);
    return true;
  } catch {
    return false;
  }
}

/**
 * Loads a previously saved zlib-compressed read snapshot by SHA-1.
 * @param {string|{ sha1?: string, normPath?: string, filePath?: string }} sha1OrOpts
 * @returns {string|null}
 */
export function loadReadSnapshot(sha1OrOpts = '') {
  const opts = typeof sha1OrOpts === 'string'
    ? { sha1: sha1OrOpts }
    : (sha1OrOpts && typeof sha1OrOpts === 'object' ? sha1OrOpts : {});

  const sha1 = sanitizeSha1(opts.sha1);
  if (!sha1) return null;

  const blobFile = snapshotBlobPath(sha1);
  if (!existsSync(blobFile)) return null;

  const now = Date.now();
  const index = safeReadJsonSync(SNAPSHOT_INDEX_FILE, defaultSnapshotIndex, { selfHeal: false });
  const entries = Array.isArray(index?.entries) ? index.entries : [];
  const matching = entries.find((e) => e && e.sha1 === sha1);
  if (matching && (now - (matching.ts || 0) > SNAPSHOT_TTL_MS)) {
    return null;
  }

  try {
    const raw = inflateSync(readFileSync(blobFile)).toString('utf8');
    // Touch LRU timestamp if tracked in index
    if (matching) {
      try {
        updateJsonAtomicSync(SNAPSHOT_INDEX_FILE, defaultSnapshotIndex, (state) => {
          const list = Array.isArray(state?.entries) ? state.entries : [];
          for (const e of list) {
            if (e && e.sha1 === sha1) {
              e.ts = Date.now();
            }
          }
          return { version: 1, entries: list };
        });
      } catch {}
    }
    return raw;
  } catch {
    return null;
  }
}

/**
 * Clears read snapshots globally, for a specific file, or for a conversation.
 * @param {{ filePath?: string, normPath?: string, conversationId?: string, convoKey?: string, sha1?: string }} [filter={}]
 */
export function clearReadSnapshots(filter = {}) {
  if (!existsSync(SNAPSHOT_DIR)) return;
  const targetNorm = filter?.normPath
    ? String(filter.normPath).toLowerCase()
    : normalizePathSafe(filter?.filePath || '');
  const rawConvo = filter?.convoKey || filter?.conversationId || '';
  const targetSha1 = filter?.sha1 ? sanitizeSha1(filter.sha1) : '';

  if (!targetNorm && !rawConvo && !targetSha1) {
    try {
      const files = readdirSync(SNAPSHOT_DIR);
      for (const f of files) {
        if (f.endsWith('.zlib') || f === 'index.json') {
          try {
            rmSync(join(SNAPSHOT_DIR, f), { force: true });
          } catch {}
        }
      }
    } catch {}
    return;
  }

  const baseConvo = rawConvo ? String(rawConvo).replace(/__[0-9a-f]{8}$/i, '') || 'default' : '';
  let activeEntries = [];
  try {
    updateJsonAtomicSync(SNAPSHOT_INDEX_FILE, defaultSnapshotIndex, (state) => {
      const now = Date.now();
      const entries = (Array.isArray(state?.entries) ? state.entries : []).filter((e) => {
        if (!e || !e.sha1) return false;
        if (now - (e.ts || 0) > SNAPSHOT_TTL_MS) return false;
        if (targetSha1 && e.sha1 === targetSha1) return false;
        if (targetNorm && e.normPath === targetNorm) return false;
        if (rawConvo) {
          const k = String(e.convoKey || '');
          if (k === rawConvo || k === baseConvo || k.startsWith(`${baseConvo}__`)) {
            return false;
          }
        }
        return true;
      });
      activeEntries = entries;
      return { version: 1, entries };
    });
    removeOrphanBlobs(activeEntries);
  } catch {}
}

/**
 * Runs bounded Myers O(ND) diff on trimmed middle line slices A[0..N-1] and B[0..M-1].
 * Returns edit ops in slice coordinates (offset by prefix), or null if edit distance exceeds maxD.
 */
function runBoundedMyersMiddle(A, B, prefix, maxD) {
  const N = A.length;
  const M = B.length;
  if (N === 0 && M === 0) return [];
  if (N === 0) {
    return B.map((line, j) => ({ type: 'add', newIdx: prefix + j, line }));
  }
  if (M === 0) {
    return A.map((line, i) => ({ type: 'del', oldIdx: prefix + i, line }));
  }

  const offset = maxD;
  const v = new Int32Array(2 * maxD + 1);
  v.fill(-1);
  v[offset + 1] = 0;
  const trace = [];
  let foundD = -1;

  for (let d = 0; d <= maxD; d++) {
    trace.push(new Int32Array(v));
    for (let k = -d; k <= d; k += 2) {
      const idx = offset + k;
      let x;
      if (k === -d || (k !== d && v[idx - 1] < v[idx + 1])) {
        x = v[idx + 1];
      } else {
        x = v[idx - 1] + 1;
      }
      let y = x - k;
      while (x < N && y < M && A[x] === B[y]) {
        x++;
        y++;
      }
      v[idx] = x;
      if (x === N && y === M) {
        foundD = d;
        break;
      }
    }
    if (foundD >= 0) break;
  }

  if (foundD < 0) return null;

  let x = N;
  let y = M;
  const revOps = [];
  for (let d = foundD; d >= 0; d--) {
    const vPrev = trace[d];
    const k = x - y;
    let prevK;
    if (k === -d || (k !== d && vPrev[offset + k - 1] < vPrev[offset + k + 1])) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = vPrev[offset + prevK];
    const prevY = prevX - prevK;

    while (x > prevX && y > prevY) {
      x--;
      y--;
      revOps.push({ type: 'eq', oldIdx: prefix + x, newIdx: prefix + y, line: A[x] });
    }
    if (d > 0) {
      if (x === prevX) {
        y--;
        revOps.push({ type: 'add', newIdx: prefix + y, line: B[y] });
      } else {
        x--;
        revOps.push({ type: 'del', oldIdx: prefix + x, line: A[x] });
      }
    }
  }

  revOps.reverse();
  return revOps;
}

/**
 * Formats middle diff ops + boundary context into unified-style hunks.
 */
function formatDiffHunks(prevSlice, nextSlice, prefix, suffix, middleOps, effStart, contextLines) {
  const ctx = Math.max(0, Math.min(8, Number(contextLines) || 0));
  const windowOps = [];

  const preStart = Math.max(0, prefix - ctx);
  for (let i = preStart; i < prefix; i++) {
    windowOps.push({ type: 'eq', oldIdx: i, newIdx: i, line: prevSlice[i] });
  }
  for (const op of middleOps) {
    windowOps.push(op);
  }
  const sufOldStart = prevSlice.length - suffix;
  const sufNewStart = nextSlice.length - suffix;
  const sufTake = Math.min(suffix, ctx);
  for (let i = 0; i < sufTake; i++) {
    windowOps.push({
      type: 'eq',
      oldIdx: sufOldStart + i,
      newIdx: sufNewStart + i,
      line: prevSlice[sufOldStart + i],
    });
  }

  // Group into hunks separated by > 2 * ctx equal lines
  const changeIndices = [];
  for (let i = 0; i < windowOps.length; i++) {
    if (windowOps[i].type !== 'eq') changeIndices.push(i);
  }
  if (changeIndices.length === 0) {
    return `@@ [no changes in L${effStart}-L${effStart + nextSlice.length - 1}] @@`;
  }

  const hunks = [];
  let hStart = Math.max(0, changeIndices[0] - ctx);
  let hEnd = Math.min(windowOps.length - 1, changeIndices[0] + ctx);

  for (let c = 1; c < changeIndices.length; c++) {
    const ci = changeIndices[c];
    const nextStart = Math.max(0, ci - ctx);
    if (nextStart <= hEnd + 1) {
      hEnd = Math.min(windowOps.length - 1, ci + ctx);
    } else {
      hunks.push([hStart, hEnd]);
      hStart = nextStart;
      hEnd = Math.min(windowOps.length - 1, ci + ctx);
    }
  }
  hunks.push([hStart, hEnd]);

  const out = [];
  for (const [s, e] of hunks) {
    const slice = windowOps.slice(s, e + 1);
    let oldCount = 0;
    let newCount = 0;
    let firstOld = null;
    let firstNew = null;
    const body = [];
    for (const op of slice) {
      if (op.type === 'eq') {
        if (firstOld === null) firstOld = op.oldIdx;
        if (firstNew === null) firstNew = op.newIdx;
        oldCount++;
        newCount++;
        body.push(` ${op.line}`);
      } else if (op.type === 'del') {
        if (firstOld === null) firstOld = op.oldIdx;
        oldCount++;
        body.push(`-${op.line}`);
      } else if (op.type === 'add') {
        if (firstNew === null) firstNew = op.newIdx;
        newCount++;
        body.push(`+${op.line}`);
      }
    }
    const oldLine1 = effStart + (firstOld ?? 0);
    const newLine1 = effStart + (firstNew ?? 0);
    out.push(`@@ -${oldLine1},${oldCount} +${newLine1},${newCount} @@`);
    for (const line of body) out.push(line);
  }

  return out.join('\n');
}

/**
 * Computes a bounded Myers line delta between two versions of a file over [startLine..endLine].
 *
 * @param {string} prevText
 * @param {string} nextText
 * @param {{ startLine?: number, endLine?: number, contextLines?: number, maxChangedRatio?: number }} [options={}]
 * @returns {{
 *   canUseDelta: boolean,
 *   diffText?: string,
 *   addedLines?: number,
 *   removedLines?: number,
 *   unchangedLines?: number,
 *   savedBytes?: number,
 *   savedTokensEstimate?: number,
 *   elapsedMs: number
 * }}
 */
export function computeMyersLineDelta(
  prevText = '',
  nextText = '',
  { startLine = 1, endLine = 999999, contextLines = 2, maxChangedRatio = 0.35, filePath = 'file.mjs' } = {}
) {
  const t0 = performance.now();
  if (typeof prevText !== 'string' || typeof nextText !== 'string' || !prevText || !nextText) {
    return { canUseDelta: false, elapsedMs: Number((performance.now() - t0).toFixed(3)) };
  }

  const prevAll = prevText.replace(/\r\n/g, '\n').split('\n');
  const nextAll = nextText.replace(/\r\n/g, '\n').split('\n');

  const effStart = Math.max(1, Number(startLine) || 1);
  const rawEnd = Number(endLine);
  const sIdx = effStart - 1;
  const eIdxPrev = Number.isFinite(rawEnd) && rawEnd > 0 ? Math.min(prevAll.length, rawEnd) : prevAll.length;
  const eIdxNext = Number.isFinite(rawEnd) && rawEnd > 0 ? Math.min(nextAll.length, rawEnd) : nextAll.length;

  const prevSlice = prevAll.slice(sIdx, eIdxPrev);
  const nextSlice = nextAll.slice(sIdx, eIdxNext);
  if (prevSlice.length === 0 || nextSlice.length === 0) {
    return { canUseDelta: false, elapsedMs: Number((performance.now() - t0).toFixed(3)) };
  }

  const sliceBytes = Buffer.byteLength(nextSlice.join('\n'), 'utf8');
  if (sliceBytes <= 0) {
    return { canUseDelta: false, elapsedMs: Number((performance.now() - t0).toFixed(3)) };
  }

  // Fast prefix/suffix trim
  const minLen = Math.min(prevSlice.length, nextSlice.length);
  let prefix = 0;
  while (prefix < minLen && prevSlice[prefix] === nextSlice[prefix]) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < minLen - prefix &&
    prevSlice[prevSlice.length - 1 - suffix] === nextSlice[nextSlice.length - 1 - suffix]
  ) {
    suffix++;
  }

  const A = prevSlice.slice(prefix, prevSlice.length - suffix);
  const B = nextSlice.slice(prefix, nextSlice.length - suffix);

  const maxLen = Math.max(prevSlice.length, nextSlice.length);
  const boundedMaxD = Math.min(
    MAX_MYERS_D,
    Math.max(40, Math.ceil(maxLen * maxChangedRatio * 2.2) + 8)
  );

  const middleOps = runBoundedMyersMiddle(A, B, prefix, boundedMaxD);
  if (!middleOps) {
    return { canUseDelta: false, elapsedMs: Number((performance.now() - t0).toFixed(3)) };
  }

  let addedLines = 0;
  let removedLines = 0;
  let midEq = 0;
  for (const op of middleOps) {
    if (op.type === 'add') addedLines++;
    else if (op.type === 'del') removedLines++;
    else midEq++;
  }
  const unchangedLines = prefix + suffix + midEq;
  const changedLinesRatio = (addedLines + removedLines) / Math.max(1, prevSlice.length + nextSlice.length);

  if (changedLinesRatio > maxChangedRatio) {
    return { canUseDelta: false, elapsedMs: Number((performance.now() - t0).toFixed(3)) };
  }

  const diffText = formatDiffHunks(prevSlice, nextSlice, prefix, suffix, middleOps, effStart, contextLines);
  const diffBytes = Buffer.byteLength(diffText, 'utf8');

  if (diffBytes >= sliceBytes * 0.45) {
    return { canUseDelta: false, elapsedMs: Number((performance.now() - t0).toFixed(3)) };
  }

  const savedBytes = Math.max(0, sliceBytes - diffBytes);
  const savedTokensEstimate = Math.max(0, Math.round(savedBytes / 3.8));
  const elapsedMs = Number((performance.now() - t0).toFixed(3));

  let astSymbolSummary = '';
  try {
    const ext = extname(String(filePath || 'file.mjs')).toLowerCase() || '.mjs';
    const syms = extractFileSymbolsWithRanges(ext, nextText) || [];
    if (syms.length >= 3) {
      const changedLines = new Set();
      for (const op of middleOps) {
        if (op.type === 'add') {
          changedLines.add(effStart + (op.newIdx ?? 0));
        } else if (op.type === 'del') {
          changedLines.add(effStart + (op.oldIdx ?? 0));
        }
      }
      const modifiedNames = [];
      for (const s of syms) {
        if (!s?.name || s.name === 'anonymous') continue;
        const sStart = Number(s.startLine) || 1;
        const sEnd = Number(s.endLine) || sStart;
        let touched = false;
        for (const ln of changedLines) {
          if (ln >= sStart && ln <= sEnd) {
            touched = true;
            break;
          }
        }
        if (touched && !modifiedNames.includes(s.name)) {
          modifiedNames.push(s.name);
        }
      }
      if (modifiedNames.length > 0 && modifiedNames.length <= 3) {
        const unchangedCount = Math.max(0, syms.length - modifiedNames.length);
        astSymbolSummary = `[AST-Delta: ${unchangedCount} unchanged symbols | Modified: ${modifiedNames.join(', ')}]`;
      }
    }
  } catch {}

  return {
    canUseDelta: true,
    diffText,
    astSymbolSummary,
    addedLines,
    removedLines,
    unchangedLines,
    savedBytes,
    savedTokensEstimate,
    elapsedMs,
  };
}

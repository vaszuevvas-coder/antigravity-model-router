/**
 * @file ram-sota-arena.mjs
 * @description RAM SOTA Arena & Memory Compression Engines:
 *   1. SharedRamArena: Slabbed SharedArrayBuffer UTF-8 file arena with zero-copy worker slices & slab compaction.
 *   2. CsrInvertedIndex: Flat Uint32Array Compressed Sparse Row (CSR) inverted index for fast token intersections.
 *   3. ObservationWindowMemoizer (ACON ICML 2026): Cross-turn tool output memoization with zero-deadlock retry bypass.
 *   4. EpisodicRepairIndex (RepairKV ICML 2026): Post-compaction episodic fact & snippet recall.
 *   5. orderSlicesPrefixStable: Canonical prefix-stable slice ordering for prompt-cache preservation.
 */

import { extractDeterministicFactTable } from './cpu-sbfl-healer.mjs';
import { expandQueryBilingualStems } from './cpu-reranker.mjs';

const DEFAULT_SLAB_SIZE_BYTES = 16 * 1024 * 1024;
const MIN_SLAB_SIZE_BYTES = 1024;
const FRAGMENTATION_COMPACT_THRESHOLD = 0.45;
const HAS_SHARED_ARRAY_BUFFER = typeof SharedArrayBuffer === 'function';
const sharedUtf8Decoder = new TextDecoder('utf-8');

function normalizeArenaPath(p) {
  let norm = String(p || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (process.platform === 'win32') norm = norm.toLowerCase();
  return norm;
}

function toPosixPath(p) {
  return String(p || '').replace(/\\/g, '/');
}

/**
 * Slabbed SharedArrayBuffer arena storing raw UTF-8 file buffers with compaction and ArrayBuffer fallback.
 */
export class SharedRamArena {
  /**
   * @param {{ slabSizeBytes?: number }} [options={}]
   */
  constructor({ slabSizeBytes = DEFAULT_SLAB_SIZE_BYTES } = {}) {
    this.slabSizeBytes = Math.max(MIN_SLAB_SIZE_BYTES, Number(slabSizeBytes) || DEFAULT_SLAB_SIZE_BYTES);
    this.sharedMemoryActive = HAS_SHARED_ARRAY_BUFFER;
    /** @type {Array<object|null>} */
    this.slabs = [];
    /** @type {Map<string, { sab: SharedArrayBuffer|ArrayBuffer, isShared: boolean, slabIndex: number, byteOffset: number, byteLength: number }>} */
    this.files = new Map();
    this.reclaimedBytes = 0;
  }

  _allocBuffer(byteLength) {
    return HAS_SHARED_ARRAY_BUFFER ? new SharedArrayBuffer(byteLength) : new ArrayBuffer(byteLength);
  }

  _storeSlab(slab) {
    const freeIdx = this.slabs.indexOf(null);
    if (freeIdx !== -1) {
      this.slabs[freeIdx] = slab;
      return freeIdx;
    }
    this.slabs.push(slab);
    return this.slabs.length - 1;
  }

  _compactSlab(slabIndex) {
    const slab = this.slabs[slabIndex];
    if (!slab || slab.dedicated) return;
    if (slab.files.size === 0 || slab.usedBytes === 0) {
      this.slabs[slabIndex] = null;
      return;
    }

    const newSab = this._allocBuffer(slab.byteLength);
    const newUint8 = new Uint8Array(newSab);
    let offset = 0;

    for (const relPath of slab.files) {
      const desc = this.files.get(relPath);
      if (!desc) continue;
      if (desc.byteLength > 0) {
        newUint8.set(slab.uint8.subarray(desc.byteOffset, desc.byteOffset + desc.byteLength), offset);
      }
      desc.sab = newSab;
      desc.isShared = HAS_SHARED_ARRAY_BUFFER;
      desc.byteOffset = offset;
      offset += desc.byteLength;
    }

    slab.sab = newSab;
    slab.uint8 = newUint8;
    slab.cursor = offset;
    slab.usedBytes = offset;
  }

  /**
   * Writes a UTF-8 file buffer into the arena, returning a zero-copy slice descriptor.
   * @param {string} relPath
   * @param {Buffer|Uint8Array|string} buf
   * @returns {{ sab: SharedArrayBuffer|ArrayBuffer, isShared: boolean, slabIndex: number, byteOffset: number, byteLength: number }}
   */
  writeBuffer(relPath, buf) {
    const key = String(relPath || '');
    const src = Buffer.isBuffer(buf)
      ? buf
      : (buf instanceof Uint8Array ? buf : Buffer.from(String(buf ?? ''), 'utf8'));
    const byteLength = src.byteLength;

    let prevSlabIdx = -1;
    if (this.files.has(key)) {
      prevSlabIdx = this.files.get(key).slabIndex;
      this.freeFile(key);
      if (prevSlabIdx >= 0 && this.slabs[prevSlabIdx] && !this.slabs[prevSlabIdx].dedicated) {
        const ps = this.slabs[prevSlabIdx];
        if (ps.cursor > ps.usedBytes) {
          this._compactSlab(prevSlabIdx);
        }
      }
    }

    if (byteLength > this.slabSizeBytes) {
      const sab = this._allocBuffer(byteLength);
      const uint8 = new Uint8Array(sab);
      uint8.set(src, 0);
      const slabIndex = this._storeSlab({
        sab,
        uint8,
        byteLength,
        cursor: byteLength,
        usedBytes: byteLength,
        dedicated: true,
        files: new Set([key]),
      });
      const descriptor = { sab, isShared: HAS_SHARED_ARRAY_BUFFER, slabIndex, byteOffset: 0, byteLength };
      this.files.set(key, descriptor);
      return descriptor;
    }

    let targetIdx = -1;
    for (let i = 0; i < this.slabs.length; i++) {
      const slab = this.slabs[i];
      if (!slab || slab.dedicated) continue;
      if (slab.byteLength - slab.cursor >= byteLength) {
        targetIdx = i;
        break;
      }
      const fragRatio = slab.cursor > 0 ? (slab.cursor - slab.usedBytes) / slab.cursor : 0;
      if (fragRatio > FRAGMENTATION_COMPACT_THRESHOLD && slab.byteLength - slab.usedBytes >= byteLength) {
        this._compactSlab(i);
        if (this.slabs[i] && this.slabs[i].byteLength - this.slabs[i].cursor >= byteLength) {
          targetIdx = i;
          break;
        }
      }
    }

    if (targetIdx === -1) {
      const sab = this._allocBuffer(this.slabSizeBytes);
      targetIdx = this._storeSlab({
        sab,
        uint8: new Uint8Array(sab),
        byteLength: this.slabSizeBytes,
        cursor: 0,
        usedBytes: 0,
        dedicated: false,
        files: new Set(),
      });
    }

    const slab = this.slabs[targetIdx];
    const byteOffset = slab.cursor;
    if (byteLength > 0) {
      slab.uint8.set(src, byteOffset);
    }
    slab.cursor += byteLength;
    slab.usedBytes += byteLength;
    slab.files.add(key);

    const descriptor = {
      sab: slab.sab,
      isShared: HAS_SHARED_ARRAY_BUFFER,
      slabIndex: targetIdx,
      byteOffset,
      byteLength,
    };
    this.files.set(key, descriptor);
    return descriptor;
  }

  /**
   * Frees a file from the arena, compacts fragmented slabs (>45%), and drops empty slabs.
   * @param {string} relPath
   * @returns {boolean}
   */
  freeFile(relPath) {
    const key = String(relPath || '');
    const desc = this.files.get(key);
    if (!desc) return false;

    this.files.delete(key);
    const slab = this.slabs[desc.slabIndex];
    if (slab) {
      slab.files.delete(key);
      slab.usedBytes = Math.max(0, slab.usedBytes - desc.byteLength);
      this.reclaimedBytes += desc.byteLength;
      if (slab.files.size === 0 || slab.usedBytes === 0) {
        this.slabs[desc.slabIndex] = null;
      } else if (!slab.dedicated && slab.cursor > 0) {
        const fragRatio = (slab.cursor - slab.usedBytes) / slab.cursor;
        if (fragRatio > FRAGMENTATION_COMPACT_THRESHOLD) {
          this._compactSlab(desc.slabIndex);
        }
      }
    }
    return true;
  }

  /**
   * Decodes a UTF-8 string directly from an arena slice descriptor without intermediate Buffer copies.
   * @param {{ sab: SharedArrayBuffer|ArrayBuffer, byteOffset: number, byteLength: number }|null} descriptor
   * @returns {string}
   */
  readArenaUtf8(descriptor) {
    if (!descriptor || !descriptor.sab) return '';
    const offset = Math.max(0, Number(descriptor.byteOffset) || 0);
    const len = Math.max(0, Number(descriptor.byteLength) || 0);
    if (len === 0 || offset + len > descriptor.sab.byteLength) return '';
    return sharedUtf8Decoder.decode(new Uint8Array(descriptor.sab, offset, len));
  }

  /**
   * Releases all slabs and tracked descriptors.
   */
  clear() {
    this.files.clear();
    this.slabs = [];
    this.reclaimedBytes = 0;
  }

  /**
   * Returns current arena slab and memory accounting telemetry.
   * @returns {{ slabCount: number, allocatedBytes: number, usedBytes: number, sharedMemoryActive: boolean }}
   */
  getStats() {
    let slabCount = 0;
    let allocatedBytes = 0;
    let usedBytes = 0;
    for (const slab of this.slabs) {
      if (!slab) continue;
      slabCount += 1;
      allocatedBytes += slab.byteLength;
      usedBytes += slab.usedBytes;
    }
    return {
      slabCount,
      allocatedBytes,
      usedBytes,
      sharedMemoryActive: this.sharedMemoryActive,
    };
  }
}

/**
 * Compact flat Uint32Array Compressed Sparse Row (CSR) posting index for O(min-posting) intersections.
 */
export class CsrInvertedIndex {
  constructor() {
    /** @type {string[]} */
    this.docIdToRelPath = [];
    /** @type {Map<string, number>} */
    this.relPathToDocId = new Map();
    /** @type {Uint32Array} */
    this.termOffsets = new Uint32Array(0);
    /** @type {Uint32Array} */
    this.postings = new Uint32Array(0);
    /** @type {Map<string, number>} */
    this.termDict = new Map();
  }

  /**
   * Builds the flat CSR posting arrays from workspace filesMap and tokenIndexMap.
   * @param {Map<string, object>} filesMap
   * @param {Map<string, Set<string>>} tokenIndexMap
   */
  buildFromTokenMap(filesMap, tokenIndexMap) {
    this.docIdToRelPath = [];
    this.relPathToDocId = new Map();
    this.termDict = new Map();

    if (!(filesMap instanceof Map) || filesMap.size === 0 || !(tokenIndexMap instanceof Map)) {
      this.termOffsets = new Uint32Array(1);
      this.postings = new Uint32Array(0);
      return this;
    }

    const sortedPaths = Array.from(filesMap.keys()).sort();
    for (let i = 0; i < sortedPaths.length; i++) {
      const rel = sortedPaths[i];
      this.docIdToRelPath.push(rel);
      this.relPathToDocId.set(rel, i);
    }

    const termEntries = [];
    let totalPostings = 0;
    for (const [term, relSet] of tokenIndexMap.entries()) {
      if (!relSet || relSet.size === 0) continue;
      const docIds = [];
      for (const rel of relSet) {
        const id = this.relPathToDocId.get(rel);
        if (id !== undefined) docIds.push(id);
      }
      if (docIds.length === 0) continue;
      docIds.sort((a, b) => a - b);
      const termId = termEntries.length;
      this.termDict.set(term, termId);
      termEntries.push(docIds);
      totalPostings += docIds.length;
    }

    const termOffsets = new Uint32Array(termEntries.length + 1);
    const postings = new Uint32Array(totalPostings);
    let cursor = 0;
    for (let t = 0; t < termEntries.length; t++) {
      termOffsets[t] = cursor;
      const list = termEntries[t];
      for (let j = 0; j < list.length; j++) {
        postings[cursor++] = list[j];
      }
    }
    termOffsets[termEntries.length] = cursor;

    this.termOffsets = termOffsets;
    this.postings = postings;
    return this;
  }

  _getTermSlice(term) {
    let termId = this.termDict.get(term);
    if (termId === undefined && typeof term === 'string') {
      termId = this.termDict.get(term.toLowerCase());
    }
    if (termId === undefined) return null;
    const start = this.termOffsets[termId];
    const end = this.termOffsets[termId + 1];
    return this.postings.subarray(start, end);
  }

  /**
   * Returns all file paths containing a given term.
   * @param {string} term
   * @returns {string[]}
   */
  lookupTermFiles(term) {
    const slice = this._getTermSlice(term);
    if (!slice || slice.length === 0) return [];
    const out = new Array(slice.length);
    for (let i = 0; i < slice.length; i++) {
      out[i] = this.docIdToRelPath[slice[i]];
    }
    return out;
  }

  /**
   * Intersects postings across multiple terms using two-pointer merge from shortest posting list.
   * @param {string[]} terms
   * @returns {string[]}
   */
  intersectTerms(terms) {
    if (!Array.isArray(terms) || terms.length === 0) return [];
    const slices = [];
    for (const term of terms) {
      const s = this._getTermSlice(term);
      if (!s || s.length === 0) return [];
      slices.push(s);
    }

    slices.sort((a, b) => a.length - b.length);
    let current = slices[0];

    for (let idx = 1; idx < slices.length; idx++) {
      const other = slices[idx];
      const next = [];
      let i = 0;
      let j = 0;
      while (i < current.length && j < other.length) {
        const a = current[i];
        const b = other[j];
        if (a === b) {
          next.push(a);
          i++;
          j++;
        } else if (a < b) {
          i++;
        } else {
          j++;
        }
      }
      if (next.length === 0) return [];
      current = next;
    }

    const out = new Array(current.length);
    for (let i = 0; i < current.length; i++) {
      out[i] = this.docIdToRelPath[current[i]];
    }
    return out;
  }

  /**
   * Returns CSR index size and byte footprint telemetry.
   * @returns {{ docCount: number, termCount: number, postingsCount: number, byteLength: number }}
   */
  getStats() {
    return {
      docCount: this.docIdToRelPath.length,
      termCount: this.termDict.size,
      postingsCount: this.postings.length,
      byteLength: this.termOffsets.byteLength + this.postings.byteLength,
    };
  }
}

/**
 * ACON (ICML 2026) cross-turn tool output memoizer with immediate retry-bypass to prevent deadlocks.
 */
export class ObservationWindowMemoizer {
  /**
   * @param {{ maxEntries?: number }} [options={}]
   */
  constructor({ maxEntries = 600 } = {}) {
    this.maxEntries = Math.max(16, Number(maxEntries) || 600);
    /** @type {Map<string, object>} */
    this.entries = new Map();
    this.hits = 0;
    this.savedCharsTotal = 0;
  }

  _makeKey(convoId, epoch, toolName, targetKey) {
    return `${convoId ?? 'default'}|${epoch ?? 0}|${toolName ?? ''}|${targetKey ?? ''}`;
  }

  /**
   * Checks whether an unchanged observation is already present in the active context window.
   */
  checkMemo({ convoId = 'default', epoch = 0, toolName = '', targetKey = '', currentSha1 = '', stepIdx = -1 } = {}) {
    const key = this._makeKey(convoId, epoch, toolName, targetKey);
    const entry = this.entries.get(key);
    if (!entry || !currentSha1 || entry.contentSha1 !== currentSha1) {
      return { hit: false, retryBypass: false };
    }

    const now = Date.now();
    const isImmediateRetry =
      (stepIdx >= 0 && entry.lastBypassCheckStep === stepIdx) ||
      (stepIdx < 0 && entry.lastHitTs > 0 && now - entry.lastHitTs < 1800);

    if (isImmediateRetry) {
      this.entries.delete(key);
      return { hit: false, retryBypass: true };
    }

    // Refresh LRU order on hit
    this.entries.delete(key);
    entry.lastHitTs = now;
    entry.lastBypassCheckStep = stepIdx;
    this.entries.set(key, entry);

    this.hits += 1;
    this.savedCharsTotal += entry.charLen;

    return {
      hit: true,
      savedChars: entry.charLen,
      memoNotice: `⚡ [RAM Context Memo] Unchanged ${toolName} (${targetKey}) already in active context (sha1:${String(currentSha1).slice(0, 8)}). Re-call immediately if full raw dump is required.`,
    };
  }

  /**
   * Records a full observation into the LRU memo table.
   */
  recordMemo({
    convoId = 'default',
    epoch = 0,
    toolName = '',
    targetKey = '',
    contentSha1 = '',
    charLen = 0,
    stepIdx = -1,
    fileDeps = [],
  } = {}) {
    if (!contentSha1) return;
    const key = this._makeKey(convoId, epoch, toolName, targetKey);
    if (this.entries.has(key)) {
      this.entries.delete(key);
    }

    const normDeps = Array.isArray(fileDeps)
      ? fileDeps.map((d) => normalizeArenaPath(d)).filter(Boolean)
      : [];

    this.entries.set(key, {
      convoId: String(convoId ?? 'default'),
      epoch: Number(epoch ?? 0),
      toolName: String(toolName ?? ''),
      targetKey: String(targetKey ?? ''),
      contentSha1: String(contentSha1),
      stepIdx: Number.isFinite(Number(stepIdx)) ? Number(stepIdx) : -1,
      lastHitTs: 0,
      lastBypassCheckStep: -1,
      charLen: Math.max(0, Number(charLen) || 0),
      fileDeps: normDeps,
    });

    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      this.entries.delete(oldestKey);
    }
  }

  _pathMatchesTarget(normCandidate, normRel) {
    if (!normCandidate || !normRel) return false;
    if (normCandidate === normRel) return true;
    if (normCandidate.endsWith(`/${normRel}`)) return true;
    if (normCandidate.startsWith(`${normRel}:`) || normCandidate.startsWith(`${normRel}#`)) return true;
    const colonIdx = normCandidate.indexOf(':');
    const hashIdx = normCandidate.indexOf('#');
    const cutIdx = colonIdx !== -1 && hashIdx !== -1 ? Math.min(colonIdx, hashIdx) : Math.max(colonIdx, hashIdx);
    if (cutIdx > 0) {
      const baseTarget = normCandidate.slice(0, cutIdx);
      if (baseTarget === normRel || baseTarget.endsWith(`/${normRel}`)) return true;
    }
    return false;
  }

  /**
   * Invalidates all memoized entries referencing a modified or deleted file.
   * @param {string} relPath
   * @returns {number}
   */
  invalidateFile(relPath) {
    const normRel = normalizeArenaPath(relPath);
    if (!normRel) return 0;
    let removed = 0;
    for (const [key, entry] of this.entries.entries()) {
      const normTarget = normalizeArenaPath(entry.targetKey);
      const hitsTarget = this._pathMatchesTarget(normTarget, normRel);
      const hitsDep = Array.isArray(entry.fileDeps) && entry.fileDeps.some((d) => this._pathMatchesTarget(d, normRel));
      if (hitsTarget || hitsDep) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  /**
   * Invalidates all memoized entries for a conversation ID.
   * @param {string} convoId
   * @returns {number}
   */
  invalidateConvo(convoId) {
    const prefix = `${convoId ?? 'default'}|`;
    let removed = 0;
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  /**
   * Returns memoization hit and token savings telemetry.
   * @returns {{ entries: number, hits: number, savedCharsTotal: number, savedTokensEstimate: number }}
   */
  getStats() {
    return {
      entries: this.entries.size,
      hits: this.hits,
      savedCharsTotal: this.savedCharsTotal,
      savedTokensEstimate: Math.round(this.savedCharsTotal / 3.8),
    };
  }
}

const MAX_REPAIR_ITEMS_PER_BUCKET = 120;
const SALIENT_ERROR_RE = /\b(?:error|exception|fail(?:ed|ure)?|typeerror|referenceerror|syntaxerror|rangeerror|enoent|eisdir|bug|root\s*cause|fix(?:ed)?|crash(?:ed)?|timeout|assert(?:ion)?)\b|ошибк|исправлен|упал/i;
const SALIENT_DECISION_RE = /\b(?:decided|decision|because|switched|invariant|contract|must|never|always|workaround|preserved|keep|avoid)\b|решен|потому|контракт/i;
const FILE_REF_RE = /(?:[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_./-]+|[a-zA-Z0-9_.-]+\.(?:mjs|js|cjs|ts|tsx|jsx|py|go|rs|json|md|html))/g;
const SYMBOL_REF_RE = /\b(?:[a-z][a-zA-Z0-9]{2,}[A-Z][a-zA-Z0-9]*|[A-Z][a-zA-Z0-9]{2,}[a-z][a-zA-Z0-9]*|[a-z]+_[a-z0-9_]{2,}|[A-Z][A-Z0-9_]{3,})\b/g;

/**
 * RepairKV (ICML 2026) post-compaction episodic fact & snippet recall index.
 */
export class EpisodicRepairIndex {
  constructor() {
    /** @type {Map<string, Array<object>>} */
    this.buckets = new Map();
    this.recallsCount = 0;
    this.savedTokensEstimate = 0;
    this._seq = 1;
  }

  _bucketKey(convoId = 'default', wsPath = '') {
    const normWs = normalizeArenaPath(wsPath).replace(/\/+$/, '');
    return `${convoId ?? 'default'}|${normWs}`;
  }

  _buildFactRecord(line) {
    const clean = String(line || '').replace(/\s+/g, ' ').trim();
    if (clean.length < 8) return null;

    const files = Array.from(new Set(clean.match(FILE_REF_RE) || [])).slice(0, 8);
    const symbols = Array.from(new Set(clean.match(SYMBOL_REF_RE) || [])).slice(0, 12);
    const errors = [];
    const errMatches = clean.match(/\b(?:[A-Z][a-zA-Z]*Error|ENOENT|EACCES|FAIL|Exception)\b/g);
    if (errMatches) {
      for (const e of errMatches) {
        if (!errors.includes(e)) errors.push(e);
      }
    }

    const exp = expandQueryBilingualStems(clean);
    const stemSet = new Set(exp?.allConcepts || []);
    for (const f of files) {
      stemSet.add(f.toLowerCase());
      const base = f.split('/').pop();
      if (base) stemSet.add(base.toLowerCase());
    }
    for (const s of symbols) stemSet.add(s.toLowerCase());
    for (const e of errors) stemSet.add(e.toLowerCase());

    return {
      id: `rk-${this._seq++}`,
      text: clean.slice(0, 260),
      symbols,
      files,
      errors,
      stems: Array.from(stemSet),
      ts: Date.now(),
    };
  }

  /**
   * Archives deterministic pre-compaction facts, file references, symbols, and error diagnostics.
   */
  archiveFacts({ convoId = 'default', wsPath = '', rawText = '', steps = [] } = {}) {
    const key = this._bucketKey(convoId, wsPath);
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = [];
      this.buckets.set(key, bucket);
    }

    const candidateLines = [];
    const factTable = extractDeterministicFactTable(steps);
    if (factTable) {
      for (const ln of factTable.split(/\r?\n/)) {
        const t = ln.trim();
        if (t && !t.startsWith('###')) candidateLines.push(t);
      }
    }

    const textSources = [];
    if (typeof rawText === 'string' && rawText.trim()) {
      textSources.push(rawText);
    }
    if (Array.isArray(steps)) {
      for (const step of steps) {
        if (typeof step?.content === 'string' && step.content.trim()) {
          textSources.push(step.content);
        }
      }
    }

    for (const src of textSources) {
      for (const rawLine of src.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (line.length < 10) continue;
        const isSalient =
          FILE_REF_RE.test(line) ||
          SYMBOL_REF_RE.test(line) ||
          SALIENT_ERROR_RE.test(line) ||
          SALIENT_DECISION_RE.test(line);
        FILE_REF_RE.lastIndex = 0;
        SYMBOL_REF_RE.lastIndex = 0;
        if (isSalient) {
          candidateLines.push(line);
        }
      }
    }

    const existingTexts = new Set(bucket.map((item) => item.text));
    let archivedCount = 0;

    for (const line of candidateLines) {
      const rec = this._buildFactRecord(line);
      if (!rec || existingTexts.has(rec.text)) continue;
      existingTexts.add(rec.text);
      bucket.push(rec);
      archivedCount += 1;
    }

    if (bucket.length > MAX_REPAIR_ITEMS_PER_BUCKET) {
      bucket.splice(0, bucket.length - MAX_REPAIR_ITEMS_PER_BUCKET);
    }

    return { archivedCount, totalItems: bucket.length };
  }

  /**
   * Recalls the most relevant archived episodic facts for a post-compaction query.
   */
  recallFacts({ convoId = 'default', wsPath = '', query = '', topK = 3 } = {}) {
    const key = this._bucketKey(convoId, wsPath);
    const bucket = this.buckets.get(key);
    const cleanQuery = String(query || '').trim();
    if (!bucket || bucket.length === 0 || !cleanQuery) {
      return { recalled: [], formattedHint: '' };
    }

    const exp = expandQueryBilingualStems(cleanQuery);
    const queryTerms = new Set([
      ...(exp?.allConcepts || []),
      ...(exp?.rawIdentifiers || []),
    ]);
    for (const f of cleanQuery.match(FILE_REF_RE) || []) queryTerms.add(f.toLowerCase());
    for (const s of cleanQuery.match(SYMBOL_REF_RE) || []) queryTerms.add(s.toLowerCase());

    if (queryTerms.size === 0) {
      return { recalled: [], formattedHint: '' };
    }

    const scored = [];
    for (const item of bucket) {
      let score = 0;
      const itemStems = new Set(item.stems || []);
      const itemFiles = new Set((item.files || []).map((f) => f.toLowerCase()));
      const itemSyms = new Set((item.symbols || []).map((s) => s.toLowerCase()));
      const itemErrors = new Set((item.errors || []).map((e) => e.toLowerCase()));

      for (const qt of queryTerms) {
        if (itemFiles.has(qt)) score += 4;
        if (itemSyms.has(qt)) score += 3.5;
        if (itemErrors.has(qt)) score += 3;
        if (itemStems.has(qt)) score += 1.5;
      }

      if (score > 0) {
        scored.push({ item, score });
      }
    }

    if (scored.length === 0) {
      return { recalled: [], formattedHint: '' };
    }

    scored.sort((a, b) => b.score - a.score || b.item.ts - a.item.ts);
    const limit = Math.max(1, Number(topK) || 3);
    const recalled = scored.slice(0, limit).map(({ item, score }) => ({
      id: item.id,
      text: item.text,
      score: Number(score.toFixed(2)),
      files: item.files,
      symbols: item.symbols,
      errors: item.errors,
    }));

    let formattedHint = '🔧 [RAM RepairKV Recall]';
    for (const r of recalled) {
      const nextLine = `\n- ${r.text}`;
      if (formattedHint.length + nextLine.length > 550) {
        const remaining = 550 - formattedHint.length;
        if (remaining > 20) {
          formattedHint += `${nextLine.slice(0, remaining - 3)}...`;
        }
        break;
      }
      formattedHint += nextLine;
    }

    this.recallsCount += 1;
    this.savedTokensEstimate += Math.max(12, Math.round(formattedHint.length / 3.8));

    return { recalled, formattedHint };
  }

  /**
   * Returns RepairKV archive & recall telemetry.
   * @returns {{ buckets: number, items: number, recallsCount: number, savedTokensEstimate: number }}
   */
  getStats() {
    let items = 0;
    for (const b of this.buckets.values()) items += b.length;
    return {
      buckets: this.buckets.size,
      items,
      recallsCount: this.recallsCount,
      savedTokensEstimate: this.savedTokensEstimate,
    };
  }
}

const CONTRACT_FILE_RE = /(?:^|\/)(?:package\.json|tsconfig\.json|index\.[cm]?[jt]sx?|.*(?:contract|schema|types|config|manifest)[^/]*)$/i;

/**
 * Orders context slices with canonical prefix stability: pinned/contract slices sorted by POSIX file + startLine first,
 * followed by volatile turn-specific slices at the tail.
 * @param {Array<object>} [slices=[]]
 * @param {{ pinnedFiles?: string[] }} [options={}]
 * @returns {Array<object>}
 */
export function orderSlicesPrefixStable(slices = [], { pinnedFiles = [] } = {}) {
  if (!Array.isArray(slices) || slices.length <= 1) {
    return Array.isArray(slices) ? [...slices] : [];
  }

  const pinnedSet = new Set(
    (Array.isArray(pinnedFiles) ? pinnedFiles : []).map((f) => toPosixPath(f).replace(/^\.\//, ''))
  );

  const stableBase = [];
  const volatileTail = [];

  for (const slice of slices) {
    if (!slice || typeof slice !== 'object') continue;
    const posixFile = toPosixPath(slice.file || slice.relPath || '').replace(/^\.\//, '');
    const isStable =
      pinnedSet.has(posixFile) ||
      slice.pinned === true ||
      slice.isContract === true ||
      slice.stable === true ||
      CONTRACT_FILE_RE.test(posixFile);

    if (isStable) {
      stableBase.push({ slice, posixFile, startLine: Number(slice.startLine) || 0 });
    } else {
      volatileTail.push(slice);
    }
  }

  stableBase.sort(
    (a, b) => a.posixFile.localeCompare(b.posixFile) || a.startLine - b.startLine
  );

  return [...stableBase.map((entry) => entry.slice), ...volatileTail];
}

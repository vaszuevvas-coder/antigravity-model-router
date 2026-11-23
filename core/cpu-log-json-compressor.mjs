/**
 * @file cpu-log-json-compressor.mjs
 * @description Zero-VRAM CPU log and structured payload compressors:
 *  - Mechanic #2: Online Drain3-style fixed-depth prefix tree log clustering (`compressLogsDrain3`).
 *  - Mechanic #3: Headroom-style Smart Crusher for JSON/JSONL payloads (`crushStructuredPayload`).
 * Imports only Node built-ins and `./security-guard.mjs`.
 */

import { performance } from 'node:perf_hooks';
import { redactSecretsInText } from './security-guard.mjs';
import { crushJsonArrayToToon } from './toon-formatter.mjs';

const CRITICAL_FAULT_RE = /(?:\b(?:[A-Z][A-Za-z0-9]*Error|Error|[A-Z][A-Za-z0-9]*Exception|Exception|ERROR|FAIL|FATAL|PANIC)\b|ERR_)/;
const ANOMALY_STATUS_RE = /error|fail|warn|deny|denied|block|timeout|critical/i;
const ANOMALY_ERR_KEYS = ['error', 'err', 'errors', 'issues', 'brokenImports'];
const ANOMALY_STATUS_KEYS = ['status', 'level', 'severity'];

const ISO_TS_RE = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})?\b/g;
const TIME_RE = /\b\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?\b/g;
const UUID_RE = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;
const IPV4_RE = /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\b/g;
const WIN_PATH_RE = /(?:[A-Za-z]:\\|\\\\)[^\s"'`,;)}\]]+/g;
const POSIX_PATH_RE = /(?:^|(?<=[\s"'`(=:,[{]))(?:\.{1,2}\/[^\s"'`,;)}\]]+|\/[A-Za-z0-9._-]+\/[^\s"'`,;)}\]]*|\/[A-Za-z0-9._-]+\.[A-Za-z0-9]{1,8})/g;
const HEX_RE = /\b(?:0x[0-9a-fA-F]{6,}|[0-9a-fA-F]{8,})\b/g;
const NUM_DUR_RE = /(?<![A-Za-z0-9_-])-\d+(?:\.\d+)?(?:ms|us|ns|s|kb|mb|gb|tb|%)?(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])\d+(?:\.\d+)?(?:ms|us|ns|s|kb|mb|gb|tb|%)?(?![A-Za-z0-9_])/gi;

/**
 * Masks dynamic log tokens (timestamps, UUID/hex, IPv4:port, paths, numbers/durations) as `<*>`.
 * @param {string} line
 * @returns {string}
 */
function maskDynamicTokens(line) {
  return line
    .replace(ISO_TS_RE, '<*>')
    .replace(TIME_RE, '<*>')
    .replace(UUID_RE, '<*>')
    .replace(IPV4_RE, '<*>')
    .replace(WIN_PATH_RE, '<*>')
    .replace(POSIX_PATH_RE, '<*>')
    .replace(HEX_RE, '<*>')
    .replace(NUM_DUR_RE, '<*>');
}

/**
 * Computes Drain3 positional token similarity between template tokens and line tokens.
 * Exact non-wildcard matches score 1.0; wildcard matches score 0.4 so unrelated lines sharing
 * only leading timestamps do not over-merge at simThreshold = 0.5.
 * @param {string[]} tmplTokens
 * @param {string[]} lineTokens
 * @returns {number}
 */
function computeTokenSimilarity(tmplTokens, lineTokens) {
  const maxLen = Math.max(tmplTokens.length, lineTokens.length);
  if (maxLen === 0) return 1;
  const minLen = Math.min(tmplTokens.length, lineTokens.length);

  if (
    tmplTokens.length === lineTokens.length
    && tmplTokens.every((t) => t === '<*>')
    && lineTokens.every((t) => t === '<*>')
  ) {
    return 1;
  }

  let score = 0;
  for (let i = 0; i < minLen; i++) {
    const a = tmplTokens[i];
    const b = lineTokens[i];
    if (a === b) {
      score += a === '<*>' ? 0.4 : 1.0;
    } else if (a === '<*>' || b === '<*>') {
      score += 0.4;
    }
  }
  return score / maxLen;
}

/**
 * Gets or inserts a child node in the Drain3 prefix tree respecting maxChildren.
 * @param {{ children: Map<string, any> }} parent
 * @param {string} key
 * @param {number} maxChildren
 * @param {boolean} isLeafParent
 */
function getOrCreateTreeChild(parent, key, maxChildren, isLeafParent) {
  const normKey = key === '<*>' ? '<*>' : key;
  if (parent.children.has(normKey)) {
    return parent.children.get(normKey);
  }
  const targetKey = parent.children.size < maxChildren ? normKey : '<*>';
  if (parent.children.has(targetKey)) {
    return parent.children.get(targetKey);
  }
  const node = isLeafParent ? { clusters: [] } : { children: new Map() };
  parent.children.set(targetKey, node);
  return node;
}

/**
 * Compresses repetitive terminal/application logs using an online Drain3-style fixed-depth prefix tree.
 * Preserves 100% of unique lines (count === 1) and critical fault lines verbatim in chronological order.
 *
 * @param {string} rawText
 * @param {{ simThreshold?: number, maxClusters?: number, maxChildren?: number }} [options={}]
 * @returns {{
 *   compressed: string,
 *   wasCompressed: boolean,
 *   originalLines: number,
 *   outputLines: number,
 *   clusterCount: number,
 *   collapsedCount: number,
 *   originalChars: number,
 *   compressedChars: number,
 *   savedChars: number,
 *   savedTokensEstimate: number,
 *   elapsedMs: number
 * }}
 */
export function compressLogsDrain3(rawText = '', { simThreshold = 0.5, maxClusters = 200, maxChildren = 64 } = {}) {
  const t0 = performance.now();
  const clean = redactSecretsInText(typeof rawText === 'string' ? rawText : String(rawText ?? '')).replace(/\r\n/g, '\n');
  const originalChars = clean.length;

  if (!clean.trim()) {
    const elapsedMs = Number((performance.now() - t0).toFixed(3));
    return {
      compressed: clean,
      wasCompressed: false,
      originalLines: clean ? clean.split('\n').length : 0,
      outputLines: clean ? clean.split('\n').length : 0,
      clusterCount: 0,
      collapsedCount: 0,
      originalChars,
      compressedChars: originalChars,
      savedChars: 0,
      savedTokensEstimate: 0,
      elapsedMs,
    };
  }

  const rawLines = clean.split('\n');
  const originalLines = rawLines.length;
  const root = { children: new Map() };
  const clusters = [];
  const events = [];

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    if (!line.trim()) continue;

    if (CRITICAL_FAULT_RE.test(line)) {
      events.push({ kind: 'verbatim', line });
      continue;
    }

    const maskedLine = maskDynamicTokens(line.trim());
    const tokens = maskedLine.split(/\s+/).filter(Boolean);
    const lenBucket = tokens.length <= 64
      ? String(tokens.length)
      : String(64 + Math.floor((tokens.length - 64) / 8) * 8);
    const head1 = tokens[0] || '<EMPTY>';
    const head2 = tokens.length < 2 ? '<END>' : tokens[1];

    const depth1 = getOrCreateTreeChild(root, lenBucket, maxChildren, false);
    const depth2 = getOrCreateTreeChild(depth1, head1, maxChildren, false);
    const leaf = getOrCreateTreeChild(depth2, head2, maxChildren, true);

    let bestCluster = null;
    let bestSim = -1;
    for (let c = 0; c < leaf.clusters.length; c++) {
      const cand = leaf.clusters[c];
      const sim = computeTokenSimilarity(cand.templateTokens, tokens);
      if (sim >= simThreshold && sim > bestSim) {
        bestSim = sim;
        bestCluster = cand;
      }
    }

    if (bestCluster) {
      const minLen = Math.min(bestCluster.templateTokens.length, tokens.length);
      for (let k = 0; k < minLen; k++) {
        if (bestCluster.templateTokens[k] !== tokens[k]) {
          bestCluster.templateTokens[k] = '<*>';
        }
      }
      if (bestCluster.templateTokens.length > minLen) {
        bestCluster.templateTokens.length = minLen;
      }
      bestCluster.count += 1;
      bestCluster.templateStr = bestCluster.templateTokens.join(' ');
    } else if (clusters.length < maxClusters) {
      const cluster = {
        id: clusters.length + 1,
        templateTokens: [...tokens],
        templateStr: tokens.join(' '),
        firstLine: line,
        count: 1,
      };
      clusters.push(cluster);
      leaf.clusters.push(cluster);
      events.push({ kind: 'cluster', cluster });
    } else {
      events.push({ kind: 'verbatim', line });
    }
  }

  let collapsedCount = 0;
  const outLines = [];
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.kind === 'verbatim') {
      outLines.push(ev.line);
    } else if (ev.cluster.count === 1) {
      outLines.push(ev.cluster.firstLine);
    } else {
      collapsedCount += 1;
      outLines.push(`[×${ev.cluster.count}] ${ev.cluster.firstLine} (template: ${ev.cluster.templateStr})`);
    }
  }

  const candidate = outLines.join('\n');
  const didCompress = collapsedCount > 0 && candidate.length < originalChars;
  const compressed = didCompress ? candidate : clean;
  const compressedChars = compressed.length;
  const savedChars = Math.max(0, originalChars - compressedChars);
  const savedTokensEstimate = Math.round(savedChars / 3.8);
  const elapsedMs = Number((performance.now() - t0).toFixed(3));

  return {
    compressed,
    wasCompressed: didCompress,
    originalLines,
    outputLines: didCompress ? outLines.length : originalLines,
    clusterCount: clusters.length,
    collapsedCount: didCompress ? collapsedCount : 0,
    originalChars,
    compressedChars,
    savedChars,
    savedTokensEstimate,
    elapsedMs,
  };
}

function isPlainObject(val) {
  return Boolean(val) && typeof val === 'object' && !Array.isArray(val);
}

function isNonEmptyValue(val) {
  if (val === null || val === undefined || val === false || val === 0) return false;
  if (typeof val === 'string') return val.trim().length > 0;
  if (Array.isArray(val)) return val.length > 0;
  if (typeof val === 'object') return Object.keys(val).length > 0;
  return Boolean(val);
}

/**
 * Checks whether a structured record represents an error/warning/anomaly that must not be dropped.
 * @param {Record<string, any>} obj
 * @returns {boolean}
 */
function isAnomalyObject(obj) {
  if (!isPlainObject(obj)) return false;
  if (obj.ok === false || obj.valid === false) return true;
  for (const key of ANOMALY_ERR_KEYS) {
    if (key in obj && isNonEmptyValue(obj[key])) return true;
  }
  for (const key of ANOMALY_STATUS_KEYS) {
    if (key in obj && obj[key] !== null && obj[key] !== undefined) {
      if (ANOMALY_STATUS_RE.test(String(obj[key]))) return true;
    }
  }
  return false;
}

/**
 * Checks whether an array of length >= 4 is a homogeneous object array sharing >= 60% of keys.
 * @param {any[]} arr
 * @returns {{ homogeneous: boolean, schemaKeys: string[] }}
 */
function analyzeHomogeneousArray(arr) {
  if (!Array.isArray(arr) || arr.length < 4) {
    return { homogeneous: false, schemaKeys: [] };
  }
  const objItems = arr.filter(isPlainObject);
  if (objItems.length < 4 || objItems.length < arr.length * 0.8) {
    return { homogeneous: false, schemaKeys: [] };
  }

  const keyFreq = new Map();
  for (const item of objItems) {
    for (const k of Object.keys(item)) {
      keyFreq.set(k, (keyFreq.get(k) || 0) + 1);
    }
  }

  const unionKeys = Array.from(keyFreq.keys());
  if (unionKeys.length === 0) {
    return { homogeneous: false, schemaKeys: [] };
  }

  const minCount = objItems.length * 0.6;
  let sharedCount = 0;
  for (const cnt of keyFreq.values()) {
    if (cnt >= minCount) sharedCount += 1;
  }

  if (sharedCount / unionKeys.length < 0.6) {
    return { homogeneous: false, schemaKeys: [] };
  }
  return { homogeneous: true, schemaKeys: unionKeys };
}

/**
 * Prunes null, undefined, empty-string, and empty-array keys on large objects.
 * @param {any} value
 * @param {boolean} pruneEmpty
 * @returns {any}
 */
function pruneObjectKeys(value, pruneEmpty) {
  if (!isPlainObject(value)) return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (pruneEmpty) {
      if (v === null || v === undefined || v === '') continue;
      if (Array.isArray(v) && v.length === 0) continue;
    }
    out[k] = isPlainObject(v) ? pruneObjectKeys(v, pruneEmpty) : v;
  }
  return out;
}

/**
 * Builds a compact field-distribution summary across omitted homogeneous items.
 * @param {Record<string, any>[]} items
 * @param {string[]} schemaKeys
 * @returns {string}
 */
function summarizeFieldCounts(items, schemaKeys) {
  if (!items.length || !schemaKeys.length) return '';
  const priority = new Set(['status', 'ok', 'valid', 'level', 'severity', 'type', 'kind', 'code']);
  const orderedKeys = [
    ...schemaKeys.filter((k) => priority.has(k)),
    ...schemaKeys.filter((k) => !priority.has(k)),
  ].slice(0, 5);

  const parts = [];
  for (const key of orderedKeys) {
    const counts = new Map();
    for (const item of items) {
      if (!isPlainObject(item) || !(key in item)) continue;
      const v = item[key];
      const label = (v === null || typeof v !== 'object') ? String(v) : '[obj]';
      counts.set(label, (counts.get(label) || 0) + 1);
      if (counts.size > 6) break;
    }
    if (counts.size === 0) continue;
    if (counts.size <= 5) {
      const dist = Array.from(counts.entries())
        .map(([val, cnt]) => `${val}=${cnt}`)
        .join(', ');
      parts.push(`${key}: {${dist}}`);
    } else if (priority.has(key)) {
      parts.push(`${key}: ${items.length} vals`);
    }
    if (parts.length >= 3) break;
  }
  return parts.length > 0 ? ` (${parts.join('; ')})` : '';
}

function isPrimitiveArray(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return false;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (v !== null && typeof v === 'object') return false;
  }
  return true;
}

/**
 * Crushes a homogeneous object array into schema + compact samples + summary + anomalies.
 * @param {any[]} arr
 * @param {string[]} schemaKeys
 * @param {{ sampleKeep: number, maxAnomalies: number, pruneEmpty: boolean }} opts
 */
function crushHomogeneousArray(arr, schemaKeys, { sampleKeep, maxAnomalies, pruneEmpty }) {
  const anomalies = [];
  const normals = [];
  for (const item of arr) {
    if (isAnomalyObject(item)) {
      anomalies.push(pruneObjectKeys(item, pruneEmpty));
    } else {
      normals.push(pruneObjectKeys(item, pruneEmpty));
    }
  }

  const keptNormals = normals.slice(0, Math.max(0, sampleKeep));
  const omittedCount = Math.max(0, normals.length - keptNormals.length);
  const keptAnomalies = anomalies.slice(0, Math.max(0, maxAnomalies));
  const extraAnomalies = Math.max(0, anomalies.length - keptAnomalies.length);
  const fieldSummary = omittedCount > 0 ? summarizeFieldCounts(arr, schemaKeys) : '';

  const schemaLine = `#schema: [${schemaKeys.join(', ')}]`;
  const omittedLine = omittedCount > 0
    ? `... +${omittedCount} homogeneous items omitted${fieldSummary}`
    : '';
  const extraAnomalyLine = extraAnomalies > 0
    ? `... +${extraAnomalies} additional anomalies omitted`
    : '';

  return {
    schemaLine,
    keptNormals,
    omittedLine,
    keptAnomalies,
    extraAnomalyLine,
    anomaliesKept: keptAnomalies.length,
  };
}

/**
 * Headroom-style Smart Crusher for JSON objects/arrays and JSONL streams (>=4 JSON lines).
 *
 * @param {string} rawText
 * @param {{ minChars?: number, sampleKeep?: number, maxAnomalies?: number }} [options={}]
 * @returns {{
 *   crushed: string,
 *   wasCrushed: boolean,
 *   format: 'json'|'jsonl'|'text',
 *   anomaliesKept: number,
 *   originalChars: number,
 *   crushedChars: number,
 *   savedChars: number,
 *   savedTokensEstimate: number,
 *   elapsedMs: number
 * }}
 */
export function crushStructuredPayload(rawText = '', { minChars = 500, sampleKeep = 2, maxAnomalies = 12, format: requestedFormat = 'auto' } = {}) {
  const t0 = performance.now();
  const clean = redactSecretsInText(typeof rawText === 'string' ? rawText : String(rawText ?? '')).replace(/\r\n/g, '\n');
  const originalChars = clean.length;

  const noOpResult = (format = 'text') => ({
    crushed: clean,
    wasCrushed: false,
    format,
    anomaliesKept: 0,
    originalChars,
    crushedChars: originalChars,
    savedChars: 0,
    savedTokensEstimate: 0,
    elapsedMs: Number((performance.now() - t0).toFixed(3)),
  });

  if (originalChars < minChars) {
    return noOpResult('text');
  }

  const trimmed = clean.trim();
  let format = 'text';
  let parsed = null;
  let isTopLevelHomogeneous = false;

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      parsed = JSON.parse(trimmed);
      format = 'json';
    } catch {
      parsed = null;
    }
  }

  if (parsed === null) {
    const lines = trimmed.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length >= 4) {
      const items = [];
      let allJson = true;
      for (const line of lines) {
        if (!line.startsWith('{') && !line.startsWith('[')) {
          allJson = false;
          break;
        }
        try {
          items.push(JSON.parse(line));
        } catch {
          allJson = false;
          break;
        }
      }
      if (allJson && items.length >= 4) {
        parsed = items;
        format = 'jsonl';
      }
    }
  }

  if (parsed === null) {
    return noOpResult('text');
  }

  if (requestedFormat === 'toon' && Array.isArray(parsed)) {
    const toonRes = crushJsonArrayToToon(parsed, { sampleKeep, maxAnomalies });
    if (toonRes.ok && toonRes.toonChars < originalChars) {
      const savedChars = originalChars - toonRes.toonChars;
      return {
        crushed: toonRes.toon,
        wasCrushed: true,
        format: 'toon',
        anomaliesKept: toonRes.anomaliesKept,
        originalChars,
        crushedChars: toonRes.toonChars,
        savedChars,
        savedTokensEstimate: Math.round(savedChars / 3.8),
        elapsedMs: Number((performance.now() - t0).toFixed(3)),
      };
    }
  }

  const pruneEmpty = originalChars > 1200;
  let totalAnomaliesKept = 0;
  let didStructuralCrush = false;

  if (Array.isArray(parsed)) {
    const homo = analyzeHomogeneousArray(parsed);
    if (homo.homogeneous) {
      isTopLevelHomogeneous = true;
      didStructuralCrush = true;
      const res = crushHomogeneousArray(parsed, homo.schemaKeys, { sampleKeep, maxAnomalies, pruneEmpty });
      totalAnomaliesKept += res.anomaliesKept;
      const lines = [res.schemaLine];
      for (const n of res.keptNormals) lines.push(JSON.stringify(n));
      if (res.omittedLine) lines.push(res.omittedLine);
      for (const a of res.keptAnomalies) lines.push(JSON.stringify(a));
      if (res.extraAnomalyLine) lines.push(res.extraAnomalyLine);

      const candidate = lines.join('\n');
      if (candidate.length < originalChars) {
        const crushedChars = candidate.length;
        const savedChars = originalChars - crushedChars;
        return {
          crushed: candidate,
          wasCrushed: true,
          format,
          anomaliesKept: totalAnomaliesKept,
          originalChars,
          crushedChars,
          savedChars,
          savedTokensEstimate: Math.round(savedChars / 3.8),
          elapsedMs: Number((performance.now() - t0).toFixed(3)),
        };
      }
    }
  }

  const transformNode = (node, depth = 0) => {
    if (depth > 12) return node;
    if (Array.isArray(node)) {
      const homo = analyzeHomogeneousArray(node);
      if (homo.homogeneous) {
        didStructuralCrush = true;
        const res = crushHomogeneousArray(node, homo.schemaKeys, { sampleKeep, maxAnomalies, pruneEmpty });
        totalAnomaliesKept += res.anomaliesKept;
        const out = [res.schemaLine, ...res.keptNormals];
        if (res.omittedLine) out.push(res.omittedLine);
        out.push(...res.keptAnomalies);
        if (res.extraAnomalyLine) out.push(res.extraAnomalyLine);
        return out;
      }
      if (isPrimitiveArray(node) && node.length > 24) {
        didStructuralCrush = true;
        const headCount = Math.min(4, Math.max(2, sampleKeep + 1));
        const tailCount = 2;
        const omitted = node.length - headCount - tailCount;
        return [
          ...node.slice(0, headCount),
          `... +${omitted} primitive items omitted (total ${node.length})`,
          ...node.slice(-tailCount),
        ];
      }
      return node.map((item) => transformNode(item, depth + 1));
    }

    if (isPlainObject(node)) {
      const out = {};
      for (const [k, v] of Object.entries(node)) {
        if (pruneEmpty) {
          if (v === null || v === undefined || v === '') {
            didStructuralCrush = true;
            continue;
          }
          if (Array.isArray(v) && v.length === 0) {
            didStructuralCrush = true;
            continue;
          }
        }
        const transformed = transformNode(v, depth + 1);
        if (pruneEmpty && Array.isArray(transformed) && transformed.length === 0) {
          didStructuralCrush = true;
          continue;
        }
        out[k] = transformed;
      }
      return out;
    }

    return node;
  };

  if (!isTopLevelHomogeneous) {
    const transformed = transformNode(parsed, 0);
    const candidate = JSON.stringify(transformed);
    const savedChars = originalChars - candidate.length;
    const significantCompact = savedChars >= originalChars * 0.25;
    if (candidate.length < originalChars && (didStructuralCrush || significantCompact)) {
      return {
        crushed: candidate,
        wasCrushed: true,
        format,
        anomaliesKept: totalAnomaliesKept,
        originalChars,
        crushedChars: candidate.length,
        savedChars,
        savedTokensEstimate: Math.round(savedChars / 3.8),
        elapsedMs: Number((performance.now() - t0).toFixed(3)),
      };
    }
  }

  return noOpResult(format);
}

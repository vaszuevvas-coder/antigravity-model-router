/**
 * @file toon-formatter.mjs
 * @description Token-Oriented Object Notation (TOON) serializer for homogeneous arrays,
 * API payloads, and compact RepoMap symbol tables (-35% to -60% tokens vs JSON).
 */

/**
 * Encodes a single cell value into compact TOON format.
 * Quotes only when containing delimiter, quotes, or newlines.
 * @param {unknown} val
 * @returns {string}
 */
export function encodeToonValue(val) {
  if (val === null || val === undefined) return '';
  if (typeof val === 'boolean' || typeof val === 'number') {
    return Number.isNaN(val) ? 'null' : String(val);
  }
  let str;
  if (typeof val === 'object') {
    if (Array.isArray(val)) {
      if (val.length === 0) return '[]';
      const inner = val.slice(0, 6).map((x) => (x && typeof x === 'object' ? JSON.stringify(x) : String(x ?? '')));
      str = `[${inner.join('|')}${val.length > 6 ? `|+${val.length - 6}` : ''}]`;
    } else {
      try {
        str = JSON.stringify(val);
      } catch {
        str = String(val);
      }
    }
  } else {
    str = String(val);
  }
  const normalized = str.replace(/\r?\n/g, ' ').trim();
  if (!normalized) return '';
  if (normalized.includes(',') || normalized.includes('"') || normalized.includes(':') || /^\s|\s$/.test(str)) {
    return `"${normalized.replace(/"/g, '""')}"`;
  }
  return normalized;
}

/**
 * Serializes an array of objects into TOON tabular notation:
 *   tableName[N]{col1,col2,...}:
 *     v1,v2,...
 * @param {string} tableName
 * @param {Array<Record<string, unknown>>} rows
 * @param {string[]} [columns=[]]
 */
export function encodeToonTable(tableName = 'items', rows = [], columns = []) {
  const safeName = String(tableName || 'items').replace(/[^a-zA-Z0-9_.-]/g, '_') || 'items';
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) {
    return {
      ok: true,
      toon: `${safeName}[0]{}:`,
      rowCount: 0,
      columns: [],
      originalChars: 2,
      toonChars: `${safeName}[0]{}:`.length,
      savedChars: 0,
      savedTokensEstimate: 0,
    };
  }

  let cols = Array.isArray(columns) && columns.length > 0 ? [...columns] : [];
  if (cols.length === 0) {
    const keySet = new Set();
    for (const row of list) {
      if (row && typeof row === 'object' && !Array.isArray(row)) {
        for (const k of Object.keys(row)) {
          keySet.add(k);
        }
      }
    }
    cols = Array.from(keySet);
  }

  const header = `${safeName}[${list.length}]{${cols.join(',')}}:`;
  const lines = [header];
  for (const row of list) {
    const cells = cols.map((col) => encodeToonValue(row && typeof row === 'object' ? row[col] : ''));
    lines.push(`  ${cells.join(',')}`);
  }
  const toon = lines.join('\n');
  let originalChars = 0;
  try {
    originalChars = JSON.stringify(list).length;
  } catch {
    originalChars = toon.length;
  }
  const toonChars = toon.length;
  const savedChars = Math.max(0, originalChars - toonChars);
  return {
    ok: true,
    toon,
    rowCount: list.length,
    columns: cols,
    originalChars,
    toonChars,
    savedChars,
    savedTokensEstimate: Math.round(savedChars / 3.8),
  };
}

function isAnomalyRow(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  if (obj.ok === false || obj.valid === false || obj.passed === false) return true;
  if (typeof obj.status === 'number' && obj.status >= 400) return true;
  const st = typeof obj.status === 'string' ? obj.status.toLowerCase() : '';
  if (st === 'error' || st === 'failed' || st === 'fail' || st === 'err' || st === 'critical' || st === 'rejected') {
    return true;
  }
  if (obj.error || obj.err || obj.exception || obj.stack) return true;
  if (Array.isArray(obj.errors) && obj.errors.length > 0) return true;
  if (Array.isArray(obj.issues) && obj.issues.length > 0) return true;
  return false;
}

/**
 * Compresses a homogeneous JSON array (or JSON string) into a TOON table,
 * retaining `sampleKeep` normal rows plus up to `maxAnomalies` error/anomaly rows.
 * @param {string|Array<Record<string, unknown>>} input
 * @param {{ tableName?: string, sampleKeep?: number, maxAnomalies?: number }} [options={}]
 */
export function crushJsonArrayToToon(input, options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const tableName = typeof opts.tableName === 'string' && opts.tableName ? opts.tableName : 'items';
  const sampleKeep = opts.sampleKeep ?? 3;
  const maxAnomalies = opts.maxAnomalies ?? 12;
  let arr = input;
  let originalChars = 0;
  if (typeof input === 'string') {
    originalChars = input.length;
    try {
      arr = JSON.parse(input);
    } catch {
      return { ok: false, wasCrushed: false, toon: input, originalChars, toonChars: originalChars, savedChars: 0, savedTokensEstimate: 0, anomaliesKept: 0 };
    }
  }
  if (!Array.isArray(arr) || arr.length === 0) {
    return { ok: false, wasCrushed: false, toon: typeof input === 'string' ? input : '[]', originalChars, toonChars: originalChars, savedChars: 0, savedTokensEstimate: 0, anomaliesKept: 0 };
  }
  if (!originalChars) {
    try { originalChars = JSON.stringify(arr).length; } catch { originalChars = 0; }
  }

  const objRows = arr.filter((x) => x && typeof x === 'object' && !Array.isArray(x));
  if (objRows.length < arr.length * 0.7) {
    return { ok: false, wasCrushed: false, toon: typeof input === 'string' ? input : JSON.stringify(arr), originalChars, toonChars: originalChars, savedChars: 0, savedTokensEstimate: 0, anomaliesKept: 0 };
  }

  const keyFreq = new Map();
  for (const r of objRows) {
    for (const k of Object.keys(r)) {
      keyFreq.set(k, (keyFreq.get(k) || 0) + 1);
    }
  }
  const columns = Array.from(keyFreq.keys());
  if (arr.length < 4) {
    const tbl = encodeToonTable(tableName, objRows, columns);
    const savedChars = Math.max(0, originalChars - tbl.toonChars);
    return {
      ok: true,
      wasCrushed: savedChars > 0,
      toon: tbl.toon,
      originalChars,
      toonChars: tbl.toonChars,
      savedChars,
      savedTokensEstimate: Math.round(savedChars / 3.8),
      anomaliesKept: objRows.filter(isAnomalyRow).length,
    };
  }

  const normals = [];
  const anomalies = [];
  for (const row of objRows) {
    if (isAnomalyRow(row)) anomalies.push(row);
    else normals.push(row);
  }

  const keptNormals = normals.slice(0, Math.max(1, sampleKeep));
  const keptAnomalies = anomalies.slice(0, Math.max(1, maxAnomalies));
  const selected = [...keptNormals, ...keptAnomalies];
  const omittedCount = Math.max(0, objRows.length - selected.length);

  const tbl = encodeToonTable(tableName, selected, columns);
  const lines = [tbl.toon];
  if (omittedCount > 0) {
    lines.push(`# omitted: ${omittedCount} normal rows (total ${objRows.length}, anomalies ${anomalies.length})`);
  }
  const toon = lines.join('\n');
  const toonChars = toon.length;
  const savedChars = Math.max(0, originalChars - toonChars);
  return {
    ok: true,
    wasCrushed: toonChars < originalChars,
    toon,
    originalChars,
    toonChars,
    savedChars,
    savedTokensEstimate: Math.round(savedChars / 3.8),
    anomaliesKept: keptAnomalies.length,
  };
}

/**
 * Formats ranked RepoMap entries using compact TOON symbol tables per file.
 * @param {Array<{ entry: { relPath: string, imports?: string[], symbols?: Array<{ kind?: string, name?: string, startLine?: number, endLine?: number }> } }>} rankedEntries
 * @param {number} [maxChars=12000]
 */
export function formatRepoMapToon(rankedEntries = [], maxChars = 12000) {
  const list = Array.isArray(rankedEntries) ? rankedEntries : [];
  const lines = [`# RAM Repo Map TOON (${list.length} code files)`];
  let len = lines[0].length;
  for (const item of list) {
    const entry = item?.entry || item;
    if (!entry?.relPath) continue;
    const block = [`### ${entry.relPath}`];
    if (Array.isArray(entry.imports) && entry.imports.length > 0) {
      block.push(`imports[${Math.min(8, entry.imports.length)}]: ${entry.imports.slice(0, 8).join(',')}`);
    }
    const syms = Array.isArray(entry.symbols) ? entry.symbols.slice(0, 14) : [];
    if (syms.length > 0) {
      const symRows = syms.map((s) => ({
        kind: s.kind || 'fn',
        name: s.name || s.signature || 'anon',
        lines: `${s.startLine || 1}-${s.endLine || s.startLine || 1}`,
      }));
      block.push(encodeToonTable('symbols', symRows, ['kind', 'name', 'lines']).toon);
    }
    const chunk = block.join('\n');
    if (len + chunk.length + 3 > maxChars) break;
    lines.push('', chunk);
    len += chunk.length + 2;
  }
  return lines.join('\n');
}

function sortObjectKeysRecursive(val, seen = new WeakSet()) {
  if (val === null || typeof val !== 'object') return val;
  if (seen.has(val)) return '[Circular]';
  seen.add(val);
  try {
    if (Array.isArray(val)) {
      return val.map((item) => sortObjectKeysRecursive(item, seen));
    }
    const proto = Object.getPrototypeOf(val);
    if (proto !== null && proto !== Object.prototype) {
      return val;
    }
    const out = {};
    const keys = Object.keys(val).sort();
    for (const k of keys) {
      out[k] = sortObjectKeysRecursive(val[k], seen);
    }
    return out;
  } finally {
    seen.delete(val);
  }
}

/**
 * Deterministically sorts plain object keys recursively before JSON serialization
 * so prefix-cache hashes never break on object key insertion order.
 * @param {unknown} value
 * @param {number} [space=0]
 * @returns {string}
 */
export function canonicalizeJson(value, space = 0) {
  return JSON.stringify(sortObjectKeysRecursive(value), null, space);
}

/**
 * Converts an absolute or Windows path to a compact POSIX relative path against workspaceRoot.
 * @param {string} [filePath='']
 * @param {string} [workspaceRoot='']
 * @returns {string}
 */
export function toPosixRelPath(filePath = '', workspaceRoot = '') {
  const cleanFile = String(filePath || '').trim().replace(/\\/g, '/');
  if (!cleanFile) return '';
  const rawWs = String(workspaceRoot || '').trim().replace(/\\/g, '/');
  const cleanWs = rawWs === '/' ? '/' : rawWs.replace(/\/+$/, '');
  if (cleanWs) {
    const fileLower = cleanFile.toLowerCase();
    const wsPrefixLower = cleanWs === '/' ? '/' : `${cleanWs.toLowerCase()}/`;
    if (fileLower === cleanWs.toLowerCase()) return '.';
    if (fileLower.startsWith(wsPrefixLower)) {
      return cleanFile.slice(wsPrefixLower.length);
    }
  }
  return cleanFile;
}

/**
 * Flattens deeply nested configuration JSON objects into compact `dot.path=value` lines
 * (-40% to -55% tokens vs pretty/compact nested JSON braces).
 * @param {string|Record<string, unknown>} input
 * @param {{ maxEntries?: number, prefix?: string }} [options={}]
 */
export function flattenNestedConfigToDotPaths(input, options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const maxEntries = opts.maxEntries ?? 60;
  const prefix = opts.prefix ?? '';
  let obj = input;
  let originalChars = 0;
  if (typeof input === 'string') {
    originalChars = input.length;
    try {
      obj = JSON.parse(input);
    } catch {
      return { ok: false, text: input, entryCount: 0, savedChars: 0, savedTokensEstimate: 0 };
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    const rawStr = typeof input === 'string' ? input : JSON.stringify(obj ?? {});
    return { ok: false, text: rawStr, entryCount: 0, savedChars: 0, savedTokensEstimate: 0 };
  }
  if (!originalChars) {
    try {
      originalChars = JSON.stringify(obj, null, 2).length;
    } catch {
      originalChars = 0;
    }
  }

  const lines = [];
  const cap = Math.max(1, Number(maxEntries) || 60);
  let truncatedCount = 0;
  const seen = new WeakSet();

  function walk(node, pathPrefix) {
    if (node === null || node === undefined || typeof node !== 'object') {
      if (lines.length < cap) {
        const rendered = typeof node === 'string' ? node.replace(/\r?\n/g, ' ').trim() : String(node);
        lines.push(`${pathPrefix}=${rendered}`);
      } else {
        truncatedCount++;
      }
      return;
    }
    if (seen.has(node)) return;
    seen.add(node);
    try {
      if (Array.isArray(node)) {
        const allPrim = node.every((x) => x === null || typeof x !== 'object');
        if (allPrim && node.length <= 12) {
          if (lines.length < cap) {
            lines.push(`${pathPrefix}=[${node.map((x) => String(x ?? 'null')).join(', ')}]`);
          } else {
            truncatedCount++;
          }
        } else {
          for (let i = 0; i < node.length; i++) {
            walk(node[i], `${pathPrefix}[${i}]`);
          }
        }
        return;
      }
      const keys = Object.keys(node).sort();
      if (keys.length === 0 && pathPrefix) {
        if (lines.length < cap) lines.push(`${pathPrefix}={}`);
        else truncatedCount++;
        return;
      }
      for (const k of keys) {
        const nextKey = pathPrefix ? `${pathPrefix}.${k}` : k;
        walk(node[k], nextKey);
      }
    } finally {
      seen.delete(node);
    }
  }

  walk(obj, String(prefix || '').trim());
  if (truncatedCount > 0) {
    lines.push(`# ... +${truncatedCount} more entries omitted`);
  }
  const text = lines.join('\n');
  const savedChars = Math.max(0, originalChars - text.length);
  return {
    ok: true,
    text,
    entryCount: lines.length,
    originalChars,
    flattenedChars: text.length,
    savedChars,
    savedTokensEstimate: Math.round(savedChars / 3.8),
  };
}

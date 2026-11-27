/**
 * @file ram-index-helpers.mjs
 * @description Pure buffer, tokenizer, AST symbol slicing, and query enrichment helpers for RamMemoryEngine.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { stemWord } from '../repo-mapper.mjs';
import { recordCpuCompressionSaving } from '../cpu-worker-pool.mjs';
import { selectDiverseSlicesMMR } from '../cpu-ast-graph-compressor.mjs';

export function computeBufSha1(buf) {
  return createHash('sha1').update(buf).digest('hex').slice(0, 16);
}

export const DEFAULT_BUDGET_MB = 4096; // 4 GB default RAM budget (calibrated up to 32 GB)
export const MAX_SINGLE_FILE_BYTES = 8 * 1024 * 1024; // Skip giant blobs > 8 MB per file
export const DEFAULT_MAX_FILES_PER_WS = 30_000;

export const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.cache',
  '.agents',
  'scratch',
  'checkpoints',
  'backups',
  '.shadow',
  '.turbo',
  '.vscode',
  '.idea',
  'vendor',
  '__pycache__',
  '.venv',
  'venv',
  'env',
  'coverage',
  'target',
  'out',
  'tmp',
  'temp',
]);

export const IGNORED_FILES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'Cargo.lock',
  'poetry.lock',
  'composer.lock',
]);

export const TEXT_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.mts', '.cts',
  '.py', '.go', '.rs', '.java', '.kt', '.cs', '.cpp', '.c', '.h', '.hpp',
  '.rb', '.php', '.swift', '.lua', '.sql', '.graphql', '.proto',
  '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.env.example',
  '.html', '.htm', '.css', '.scss', '.sass', '.less', '.vue', '.svelte',
  '.md', '.mdx', '.txt', '.sh', '.bash', '.ps1', '.bat', '.cmd', '.xml',
]);

export const CODE_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.mts', '.cts', '.py', '.go', '.rs', '.json',
]);

/**
 * Builds an Int32Array of byte start offsets for every line in a UTF-8 Buffer.
 * @param {Buffer} buf
 * @returns {Int32Array}
 */
export function buildLineOffsets(buf) {
  if (!buf || typeof buf.length !== 'number') return Int32Array.from([0]);
  const offsets = [0];
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 10) { // '\n'
      offsets.push(i + 1);
    }
  }
  return Int32Array.from(offsets);
}

/**
 * Decodes a 1-indexed inclusive [startLine, endLine] range directly from Buffer + Int32Array offsets.
 * @param {Buffer} buf
 * @param {Int32Array} lineOffsets
 * @param {number} startLine
 * @param {number} endLine
 * @returns {string}
 */
export function sliceBufferLines(buf, lineOffsets, startLine, endLine, { compactLines = false } = {}) {
  if (!buf || typeof buf.length !== 'number' || !lineOffsets || lineOffsets.length === 0) {
    return '';
  }
  const totalLines = lineOffsets.length;
  const s = Math.max(1, Math.min(totalLines, Number(startLine) || 1));
  const e = Math.max(s, Math.min(totalLines, Number(endLine) || totalLines));
  const startByte = lineOffsets[s - 1];
  const endByte = e < totalLines ? Math.max(startByte, lineOffsets[e] - 1) : buf.length;
  const raw = buf.toString('utf8', startByte, endByte);
  const lines = raw.split(/\r?\n/).map((line) => line.replace(/\r$/g, ''));
  return lines.map((line, idx) => (compactLines ? `${s + idx}|${line}` : `L${s + idx}: ${line}`)).join('\n');
}

/**
 * Conversational Russian filler words filtered from lexical search & posting lists
 * so general chat questions do not trigger false-positive code matches.
 */
export const RU_CONVERSATIONAL_STOPWORDS = new Set([
  'как', 'что', 'где', 'когда', 'почему', 'зачем', 'какой', 'какая', 'какие', 'какое',
  'думаешь', 'думаю', 'сейчас', 'можно', 'нужно', 'надо', 'стоит', 'вообще', 'кажется',
  'давай', 'сделаем', 'просто', 'очень', 'уже', 'ещё', 'еще', 'или', 'для', 'при',
  'это', 'этот', 'эта', 'эти', 'этого', 'этом', 'наш', 'наше', 'наши', 'нашу', 'наших',
  'нас', 'есть', 'нет', 'если', 'тогда', 'тут', 'здесь', 'там', 'расскажи', 'подскажи',
  'объясни', 'помоги', 'скажи', 'ли', 'бы', 'же', 'вот', 'так', 'про', 'над', 'под', 'без',
]);

/**
 * Extracts normalized searchable tokens (splitting camelCase & snake_case) from text.
 * @param {string} text
 * @returns {Set<string>}
 */
export function extractSearchTokens(text) {
  const tokens = new Set();
  if (!text || typeof text !== 'string') return tokens;
  const unCamel = text.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  const matches = unCamel.toLowerCase().match(/[a-zа-яё0-9_]{2,}/g) || [];
  for (const w of matches) {
    if (w.length > 48 || RU_CONVERSATIONAL_STOPWORDS.has(w)) continue;
    tokens.add(w);
    if (w.includes('_')) {
      for (const part of w.split('_')) {
        if (part.length >= 2 && !RU_CONVERSATIONAL_STOPWORDS.has(part)) tokens.add(part);
      }
    }
    const stemmed = stemWord(w);
    if (stemmed && stemmed.length >= 3 && !RU_CONVERSATIONAL_STOPWORDS.has(stemmed)) tokens.add(stemmed);
  }
  return tokens;
}

export const BM25F_K1 = 1.2;
export const BM25F_WEIGHTS = { pe: 4.5, sig: 3.0, body: 1.2, doc: 0.7 };
export const BM25F_B = { pe: 0.4, sig: 0.5, body: 0.65, doc: 0.5 };
export const MAX_TRIGRAMS_CODE = 4096;
export const MAX_TRIGRAMS_DOC = 1536;
export const MAX_TRIGRAMS_PER_FILE = MAX_TRIGRAMS_CODE;
export const DOC_TRIGRAM_EXTS = new Set(['.md', '.mdx', '.txt', '.rst', '.adoc']);
const HASH_COMMENT_EXTS = new Set(['.py', '.rb', '.sh', '.bash', '.ps1', '.yaml', '.yml', '.toml', '.ini', '.graphql', '.env.example', '']);

export function resolveMaxTrigramsForExt(ext = '') {
  return DOC_TRIGRAM_EXTS.has(String(ext).toLowerCase()) ? MAX_TRIGRAMS_DOC : MAX_TRIGRAMS_CODE;
}

export function extractTrigrams(text, maxCount = MAX_TRIGRAMS_PER_FILE) {
  const trigrams = new Set();
  if (!text || typeof text !== 'string') return trigrams;
  const norm = text.toLowerCase().replace(/\s+/g, ' ');
  if (norm.length < 3) return trigrams;
  for (let i = 0; i <= norm.length - 3; i++) {
    const tri = norm.slice(i, i + 3);
    if (tri === '   ') continue;
    trigrams.add(tri);
    if (trigrams.size >= maxCount) break;
  }
  return trigrams;
}

export function tokenizeFieldCounts(text) {
  const tfMap = new Map();
  let totalLen = 0;
  if (!text || typeof text !== 'string') return { tfMap, totalLen };
  const unCamel = text.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  const matches = unCamel.toLowerCase().match(/[a-zа-яё0-9_]{2,}/g) || [];
  for (const w of matches) {
    if (w.length > 48 || RU_CONVERSATIONAL_STOPWORDS.has(w)) continue;
    tfMap.set(w, (tfMap.get(w) || 0) + 1);
    totalLen += 1;
    if (w.includes('_')) {
      for (const part of w.split('_')) {
        if (part.length >= 2 && !RU_CONVERSATIONAL_STOPWORDS.has(part)) {
          tfMap.set(part, (tfMap.get(part) || 0) + 1);
        }
      }
    }
    const stemmed = stemWord(w);
    if (stemmed && stemmed.length >= 3 && stemmed !== w && !RU_CONVERSATIONAL_STOPWORDS.has(stemmed)) {
      tfMap.set(stemmed, (tfMap.get(stemmed) || 0) + 1);
    }
  }
  return { tfMap, totalLen };
}

export function buildFileSearchStructures(relPath, ext, text, symbols, exportedSymbols, semanticMeta, enableTrigrams) {
  const normExt = String(ext || '').toLowerCase();
  const isDocExt = DOC_TRIGRAM_EXTS.has(normExt);
  const allowHashComment = HASH_COMMENT_EXTS.has(normExt);
  const bodyLines = [];
  const docLines = [];
  const sigExtras = [];
  const rawLines = text ? text.split(/\r?\n/) : [];
  let inBlockComment = false;

  for (const line of rawLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (isDocExt) {
      if (trimmed.startsWith('#')) sigExtras.push(trimmed);
      else docLines.push(trimmed);
      continue;
    }
    if (inBlockComment) {
      docLines.push(trimmed);
      if (trimmed.includes('*/')) inBlockComment = false;
      continue;
    }
    if (trimmed.startsWith('/*')) {
      docLines.push(trimmed);
      if (!trimmed.includes('*/')) inBlockComment = true;
      continue;
    }
    if (trimmed.startsWith('//') || (allowHashComment && /^#(?!!)/.test(trimmed))) {
      docLines.push(trimmed);
    } else {
      bodyLines.push(line);
    }
  }

  const peText = `${relPath} ${(exportedSymbols || []).join(' ')}`;
  const sigText = `${(symbols || []).map((s) => `${s?.name || ''} ${s?.signature || ''}`).join(' ')} ${sigExtras.join(' ')}`;
  const docText = `${docLines.join('\n')} ${semanticMeta?.docSummary || ''} ${(semanticMeta?.docStems || []).join(' ')}`;
  const bodyText = bodyLines.join('\n');

  const peCounts = tokenizeFieldCounts(peText);
  const sigCounts = tokenizeFieldCounts(sigText);
  const bodyCounts = tokenizeFieldCounts(bodyText);
  const docCounts = tokenizeFieldCounts(docText);

  const fieldPostings = new Map();
  const addZone = (tfMap, shiftBits) => {
    for (const [tok, cnt] of tfMap.entries()) {
      const cur = fieldPostings.get(tok) || 0;
      const curVal = (cur >>> shiftBits) & 0x7f;
      const nextVal = Math.min(127, curVal + cnt);
      fieldPostings.set(tok, (cur & ~(0x7f << shiftBits)) | (nextVal << shiftBits));
    }
  };
  addZone(peCounts.tfMap, 0);
  addZone(sigCounts.tfMap, 7);
  addZone(bodyCounts.tfMap, 14);
  addZone(docCounts.tfMap, 21);

  const tokens = new Set(fieldPostings.keys());
  const fieldLengths = {
    pe: Math.max(1, peCounts.totalLen),
    sig: Math.max(1, sigCounts.totalLen),
    body: Math.max(1, bodyCounts.totalLen),
    doc: Math.max(1, docCounts.totalLen),
  };

  let trigrams = null;
  if (enableTrigrams) {
    trigrams = extractTrigrams(`${relPath}\n${text}`, resolveMaxTrigramsForExt(ext));
  }

  return { tokens, fieldPostings, fieldLengths, trigrams };
}

/**
 * Normalizes path to forward slashes relative to rootDir.
 * @param {string} rootDir
 * @param {string} targetPath
 * @returns {string}
 */
export function normalizeDriveCase(p) {
  return process.platform === 'win32'
    ? String(p).replace(/^([a-z]):/, (_, d) => `${d.toUpperCase()}:`)
    : String(p);
}

export function toRelPath(rootDir, targetPath) {
  return path.relative(normalizeDriveCase(rootDir), normalizeDriveCase(targetPath)).replace(/\\/g, '/');
}

/**
 * Strips JSONC comments and trailing commas for safe tsconfig.json / jsconfig.json parsing.
 * @param {string} raw
 * @returns {string}
 */
function stripJsonComments(raw = '') {
  let out = '';
  let inStr = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    const next = raw[i + 1];
    if (inStr) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inStr = false;
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < raw.length && raw[i] !== '\n') i++;
      if (i < raw.length) out += '\n';
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < raw.length && !(raw[i] === '*' && raw[i + 1] === '/')) i++;
      i += 1;
      continue;
    }
    out += ch;
  }
  return out.replace(/,\s*([}\]])/g, '$1');
}

/**
 * Loads JS/TS path alias rules from tsconfig.json, jsconfig.json, and package.json `imports` (#alias).
 * Inspired by code-review-graph tsconfig_resolver + npm_alias_resolver.
 * @param {string} absRoot
 * @returns {{ baseUrl: string, rules: Array<{ prefix: string, suffix: string, targets: string[] }> }}
 */
export function loadJsAliasRules(absRoot = '') {
  const result = { baseUrl: '', rules: [] };
  if (!absRoot || typeof absRoot !== 'string') return result;

  const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
  const seenRule = new Set();
  const addRule = (pattern, rawTargets, basePrefix = '') => {
    const pat = String(pattern || '').trim();
    if (!pat) return;
    const starIdx = pat.indexOf('*');
    const wildcard = starIdx !== -1;
    const prefix = wildcard ? pat.slice(0, starIdx) : pat;
    const suffix = wildcard ? pat.slice(starIdx + 1) : '';
    const targets = (Array.isArray(rawTargets) ? rawTargets : [rawTargets])
      .map((t) => {
        const clean = String(t || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
        if (!clean) return '';
        return basePrefix ? path.posix.normalize(path.posix.join(basePrefix, clean)) : clean;
      })
      .filter(Boolean);
    if (targets.length === 0) return;
    const key = `${wildcard ? '1' : '0'}|${prefix}|${suffix}|${targets.join(',')}`;
    if (seenRule.has(key)) return;
    seenRule.add(key);
    result.rules.push({ prefix, suffix, wildcard, targets });
  };

  const readJsoncBounded = (filePath) => {
    try {
      const st = fs.statSync(filePath);
      if (!st.isFile() || st.size > MAX_CONFIG_BYTES) return null;
      const raw = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(stripJsonComments(raw));
    } catch {
      return null;
    }
  };

  const resolveExtendsConfig = (childPath, extRel) => {
    if (typeof extRel !== 'string' || !extRel.startsWith('.')) return null;
    const childDir = path.dirname(childPath);
    const parentLimit = path.dirname(absRoot);
    const candidates = [path.resolve(childDir, extRel)];
    if (!extRel.endsWith('.json')) candidates.push(path.resolve(childDir, `${extRel}.json`));
    for (const cand of candidates) {
      const normCand = path.resolve(cand);
      const relFromParent = toRelPath(parentLimit, normCand);
      if (!relFromParent || relFromParent === '..' || relFromParent.startsWith('../') || path.isAbsolute(relFromParent)) continue;
      const parsed = readJsoncBounded(normCand);
      if (parsed && typeof parsed === 'object') return parsed;
    }
    return null;
  };

  for (const cfgName of ['tsconfig.json', 'jsconfig.json']) {
    try {
      const cfgPath = path.join(absRoot, cfgName);
      if (!fs.existsSync(cfgPath)) continue;
      const parsed = readJsoncBounded(cfgPath);
      if (!parsed || typeof parsed !== 'object') continue;
      const parentParsed = resolveExtendsConfig(cfgPath, parsed.extends);
      const parentCo = parentParsed?.compilerOptions && typeof parentParsed.compilerOptions === 'object'
        ? parentParsed.compilerOptions
        : {};
      const childCo = parsed?.compilerOptions && typeof parsed.compilerOptions === 'object'
        ? parsed.compilerOptions
        : {};
      if (!Object.keys(parentCo).length && !Object.keys(childCo).length) continue;

      const rawBaseUrl = typeof childCo.baseUrl === 'string'
        ? childCo.baseUrl
        : (typeof parentCo.baseUrl === 'string' ? parentCo.baseUrl : '');
      const baseUrl = rawBaseUrl.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
      if (baseUrl && baseUrl !== '.' && !result.baseUrl) {
        result.baseUrl = baseUrl;
      }
      const mergedPaths = {
        ...(parentCo.paths && typeof parentCo.paths === 'object' ? parentCo.paths : {}),
        ...(childCo.paths && typeof childCo.paths === 'object' ? childCo.paths : {}),
      };
      for (const [pat, arr] of Object.entries(mergedPaths)) {
        addRule(pat, arr, baseUrl && baseUrl !== '.' ? baseUrl : '');
      }
    } catch {}
  }

  const collectExportTargets = (val, out, depth = 0) => {
    if (depth > 3 || val == null) return;
    if (typeof val === 'string') {
      out.push(val);
    } else if (Array.isArray(val)) {
      for (const item of val) collectExportTargets(item, out, depth + 1);
    } else if (typeof val === 'object') {
      for (const k of ['default', 'import', 'node', 'require', 'types']) {
        if (val[k] !== undefined) collectExportTargets(val[k], out, depth + 1);
      }
    }
  };

  try {
    const pkgPath = path.join(absRoot, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const st = fs.statSync(pkgPath);
      if (st.isFile() && st.size <= MAX_CONFIG_BYTES) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (pkg?.imports && typeof pkg.imports === 'object') {
          for (const [pat, val] of Object.entries(pkg.imports)) {
            if (!pat.startsWith('#')) continue;
            const targets = [];
            collectExportTargets(val, targets, 0);
            addRule(pat, targets, '');
          }
        }
      }
    }
  } catch {}

  // Longer prefixes win first (e.g. `@/components/*` before `@/*`)
  result.rules.sort((a, b) => b.prefix.length - a.prefix.length);
  return result;
}

/**
 * Extracts a single Markdown section by heading title or slug without reading the entire document.
 * Inspired by graphify/sections.py (`get_section`).
 * @param {string} rawText
 * @param {string} sectionQuery
 * @returns {{ found: boolean, heading: string, level: number, startLine: number, endLine: number, availableHeadings: Array<{ line: number, level: number, title: string }> }}
 */
export function extractMarkdownSection(rawText = '', sectionQuery = '') {
  const text = typeof rawText === 'string' ? rawText : '';
  const query = String(sectionQuery || '').trim();
  const lines = text.split(/\r?\n/);
  const headings = [];
  let inFence = false;
  let fenceChar = '';

  const slugify = (s) => String(s || '')
    .toLowerCase()
    .replace(/`+/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const fenceM = /^\s*(`{3,}|~{3,})/.exec(ln);
    if (fenceM) {
      if (!inFence) {
        inFence = true;
        fenceChar = fenceM[1][0];
      } else if (fenceM[1][0] === fenceChar) {
        inFence = false;
        fenceChar = '';
      }
      continue;
    }
    if (inFence) continue;
    const hM = /^\s*(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/.exec(ln);
    if (hM) {
      const title = hM[2].trim();
      headings.push({
        line: i + 1,
        level: hM[1].length,
        title,
        lower: title.toLowerCase(),
        slug: slugify(title),
      });
    }
  }

  const availableHeadings = headings.map((h) => ({ line: h.line, level: h.level, title: h.title }));
  if (!query || headings.length === 0) {
    return { found: false, heading: '', level: 0, startLine: 1, endLine: lines.length, availableHeadings };
  }

  const qLower = query.replace(/^#+\s*/, '').trim().toLowerCase();
  const qSlug = slugify(qLower);
  if (!qLower && !qSlug) {
    return { found: false, heading: '', level: 0, startLine: 1, endLine: lines.length, availableHeadings };
  }
  let matchedIdx = headings.findIndex((h) => (qLower && h.lower === qLower) || (qSlug && h.slug === qSlug));
  if (matchedIdx === -1) {
    matchedIdx = headings.findIndex((h) => (qLower && h.lower.includes(qLower)) || (qSlug && h.slug.includes(qSlug)));
  }
  if (matchedIdx === -1) {
    return { found: false, heading: '', level: 0, startLine: 1, endLine: lines.length, availableHeadings };
  }

  const hit = headings[matchedIdx];
  let endLine = lines.length;
  for (let j = matchedIdx + 1; j < headings.length; j++) {
    if (headings[j].level <= hit.level) {
      endLine = headings[j].line - 1;
      break;
    }
  }
  while (endLine > hit.line && !lines[endLine - 1]?.trim()) {
    endLine -= 1;
  }

  return {
    found: true,
    heading: hit.title,
    level: hit.level,
    startLine: hit.line,
    endLine: Math.max(hit.line, endLine),
    availableHeadings,
  };
}

const REGEX_STATIC_BLIND_SPOT_EXTS = new Set(['.py', '.go', '.rs', '.rb', '.php', '.java', '.kt', '.cs', '.cpp', '.c', '.swift']);

/**
 * Builds a concise honest uncertainty marker (<= 190 chars) ONLY when a graph query returns 0 hits.
 * Inspired by code-review-graph/uncertainty.py: prevents blind fallback grepping across the whole repo.
 * @param {{ mode?: string, target?: string, ws?: object, resultCount?: number }} [opts={}]
 * @returns {string}
 */
export function buildGraphUncertaintyNote({ mode = '', target = '', ws = null, resultCount = 0 } = {}) {
  if (Number(resultCount) > 0) return '';
  const cleanTarget = String(target || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  const totalFiles = ws?.files?.size || 0;
  if (totalFiles === 0) {
    return '⚠️ [Graph Uncertainty] RAM index is empty for this workspace; warm the workspace before relying on 0 results.';
  }
  const hasTarget = ws.files.has(cleanTarget) || Boolean(ws.filesLower?.has(cleanTarget.toLowerCase()));
  if (cleanTarget && !hasTarget) {
    const ext = path.posix.extname(cleanTarget).toLowerCase();
    if (ext && !TEXT_EXTENSIONS.has(ext)) {
      return `⚠️ [Graph Uncertainty] "${cleanTarget}" uses unindexed extension (${ext}); static graph cannot trace it.`;
    }
    return `⚠️ [Graph Uncertainty] "${cleanTarget}" is not in the warm RAM index (${totalFiles} files); check exact path or warm workspace.`;
  }
  const ext = cleanTarget ? path.posix.extname(cleanTarget).toLowerCase() : '';
  if (ext && REGEX_STATIC_BLIND_SPOT_EXTS.has(ext)) {
    return `ℹ️ [Graph Uncertainty] 0 static ${mode || 'graph'} edges for ${ext}; dynamic dispatch/reflection/DI may be invisible to static AST.`;
  }
  return `ℹ️ [Graph Uncertainty] 0 static ${mode || 'graph'} edges found; target may be an entrypoint, test, or wired dynamically (DI/string path/CLI).`;
}

/**
 * Resolves candidate local import relative path within workspace (JS/TS ESM NodeNext, tsconfig/@/# aliases, Vite queries, Python/Go).
 * @param {string} fromRel
 * @param {string} spec
 * @param {Map<string, object>} filesMap
 * @returns {string|null}
 */
export function resolveImportRel(fromRel, spec, filesMap, options = {}) {
  if (!spec || typeof spec !== 'string') return null;
  const noQuery = spec.split('?')[0].trim();
  const cleanSpec = noQuery.startsWith('#') ? noQuery : noQuery.split('#')[0].trim();
  if (!cleanSpec) return null;

  const filesLower = options?.filesLower instanceof Map ? options.filesLower : null;
  const findInFilesMap = (cand) => {
    if (!cand) return null;
    if (filesMap.has(cand)) return cand;
    if (filesLower) {
      const mapped = filesLower.get(cand.toLowerCase());
      if (mapped && filesMap.has(mapped)) return mapped;
    } else if (process.platform === 'win32' && filesMap.size <= 5000) {
      const low = cand.toLowerCase();
      for (const k of filesMap.keys()) {
        if (k.toLowerCase() === low) return k;
      }
    }
    return null;
  };

  const baseDir = path.posix.dirname(fromRel);

  // Python relative and workspace-absolute imports
  if (fromRel.endsWith('.py')) {
    if (cleanSpec.startsWith('.') && !cleanSpec.startsWith('./') && !cleanSpec.startsWith('../')) {
      const dots = cleanSpec.match(/^\.+/)?.[0].length || 1;
      const baseSegs = !baseDir || baseDir === '.' ? [] : baseDir.split('/').filter(Boolean);
      if (dots - 1 > baseSegs.length) return null;
      const pyBase = baseSegs.slice(0, baseSegs.length - (dots - 1)).join('/');
      const modRel = cleanSpec.slice(dots).replace(/\./g, '/');
      const pyRaw = modRel
        ? [
            pyBase ? path.posix.join(pyBase, `${modRel}.py`) : `${modRel}.py`,
            pyBase ? path.posix.join(pyBase, modRel, '__init__.py') : `${modRel}/__init__.py`,
          ]
        : [pyBase ? path.posix.join(pyBase, '__init__.py') : '__init__.py'];
      for (const rawCand of pyRaw) {
        const normCand = path.posix.normalize(rawCand);
        if (normCand && normCand !== '..' && !normCand.startsWith('../')) {
          const hit = findInFilesMap(normCand);
          if (hit) return hit;
        }
      }
      return null;
    }
    if (!cleanSpec.startsWith('./') && !cleanSpec.startsWith('../') && /^[A-Za-z_][A-Za-z0-9_.]*$/.test(cleanSpec)) {
      const modPath = cleanSpec.replace(/\./g, '/');
      const pyAbsCands = [
        `${modPath}.py`,
        `${modPath}/__init__.py`,
        `src/${modPath}.py`,
        `src/${modPath}/__init__.py`,
      ];
      const slashIdx = modPath.lastIndexOf('/');
      if (slashIdx > 0) {
        const parentMod = modPath.slice(0, slashIdx);
        pyAbsCands.push(`${parentMod}.py`, `src/${parentMod}.py`);
      }
      for (const cand of pyAbsCands) {
        const hit = findInFilesMap(cand);
        if (hit) return hit;
      }
      return null;
    }
  }

  // Go module-local package imports via go.mod module prefix
  if (fromRel.endsWith('.go')) {
    const goPrefix = options?.goModulePrefix || '';
    const goPkgMainFile = options?.goPkgMainFile;
    if (goPrefix && (cleanSpec === goPrefix || cleanSpec.startsWith(`${goPrefix}/`))) {
      const subDir = cleanSpec === goPrefix ? '' : cleanSpec.slice(goPrefix.length + 1);
      if (goPkgMainFile instanceof Map) {
        const mainHit = goPkgMainFile.get(subDir);
        if (mainHit && filesMap.has(mainHit)) return mainHit;
      }
      const prefixDot = subDir ? `${subDir}/` : '';
      for (const rel of filesMap.keys()) {
        if (!rel.endsWith('.go') || rel.endsWith('_test.go')) continue;
        if (subDir ? (rel.startsWith(prefixDot) && !rel.slice(prefixDot.length).includes('/')) : !rel.includes('/')) {
          return rel;
        }
      }
      return null;
    }
  }

  const probeJoinedCandidates = (joinedRaw) => {
    const cleanedRaw = String(joinedRaw || '').replace(/^\/+/, '');
    if (!cleanedRaw) return null;
    let rawNorm = path.posix.normalize(cleanedRaw);
    if (rawNorm.length > 1) rawNorm = rawNorm.replace(/\/+$/, '');
    if (!rawNorm || rawNorm === '..' || rawNorm.startsWith('../')) return null;
    if (rawNorm === '.') {
      for (const rootIdx of ['index.mjs', 'index.js', 'index.ts', 'index.tsx', 'index.mts', 'index.d.ts', '__init__.py']) {
        const hit = findInFilesMap(rootIdx);
        if (hit) return hit;
      }
      return null;
    }
    const joined = rawNorm;
    const candidates = [joined];
    // TypeScript NodeNext / ESM convention: `.js`/`.mjs`/`.cjs` import specifiers -> `.ts`/`.tsx`/`.mts`/`.cts`/`.d.ts`
    if (/\.(?:[cm]?js|jsx)$/i.test(joined)) {
      const stem = joined.replace(/\.(?:[cm]?js|jsx)$/i, '');
      candidates.push(
        `${stem}.ts`,
        `${stem}.tsx`,
        `${stem}.mts`,
        `${stem}.cts`,
        `${stem}.d.ts`,
        `${stem}.d.mts`,
        `${stem}.d.cts`,
        `${stem}.jsx`
      );
    }
    candidates.push(
      `${joined}.mjs`,
      `${joined}.js`,
      `${joined}.ts`,
      `${joined}.tsx`,
      `${joined}.mts`,
      `${joined}.cts`,
      `${joined}.d.ts`,
      `${joined}.cjs`,
      `${joined}.jsx`,
      `${joined}.py`,
      `${joined}/index.mjs`,
      `${joined}/index.js`,
      `${joined}/index.ts`,
      `${joined}/index.tsx`,
      `${joined}/index.mts`,
      `${joined}/index.d.ts`,
      `${joined}/__init__.py`
    );
    for (const c of candidates) {
      const hit = findInFilesMap(c);
      if (hit) return hit;
    }
    return null;
  };

  if (cleanSpec.startsWith('./') || cleanSpec.startsWith('../') || cleanSpec === '.' || cleanSpec === '..') {
    return probeJoinedCandidates(path.posix.join(baseDir, cleanSpec));
  }

  // JS/TS tsconfig.json / jsconfig.json paths & package.json #imports aliases
  const jsAliases = options?.jsAliases;
  if (jsAliases && typeof jsAliases === 'object') {
    const rawSpec = spec.split('?')[0].trim(); // keep leading `#` for package.json imports
    const rules = Array.isArray(jsAliases.rules) ? jsAliases.rules : [];
    for (const rule of rules) {
      const isWildcard = typeof rule.wildcard === 'boolean' ? rule.wildcard : true;
      if (!isWildcard) {
        if (rawSpec === rule.prefix) {
          for (const t of rule.targets) {
            const hit = probeJoinedCandidates(t);
            if (hit) return hit;
          }
        }
        continue;
      }
      if (
        rawSpec.length >= rule.prefix.length + rule.suffix.length &&
        rawSpec.startsWith(rule.prefix) &&
        (!rule.suffix || rawSpec.endsWith(rule.suffix))
      ) {
        const matchedMid = rawSpec.slice(
          rule.prefix.length,
          rule.suffix ? rawSpec.length - rule.suffix.length : undefined
        );
        for (const t of rule.targets) {
          const expanded = t.includes('*')
            ? t.replace(/\*/g, matchedMid)
            : (matchedMid ? `${t}/${matchedMid}` : t);
          const hit = probeJoinedCandidates(expanded);
          if (hit) return hit;
        }
      }
    }
    if (jsAliases.baseUrl && !rawSpec.startsWith('#') && !rawSpec.startsWith('node:')) {
      const hit = probeJoinedCandidates(path.posix.join(jsAliases.baseUrl, rawSpec));
      if (hit) return hit;
    }
  }

  return null;
}

/**
 * Infers SWE-Pruner task phase (`explore | edit | debug`) from prompt and fault signals.
 * @param {string} [prompt='']
 * @param {{ faultText?: string, hasEditedTargets?: boolean }} [options={}]
 * @returns {'explore'|'edit'|'debug'}
 */
export function inferContextPruningPhase(prompt = '', { faultText = '', hasEditedTargets = false } = {}) {
  const f = String(faultText || '').trim();
  const p = String(prompt || '').trim();
  if (
    f ||
    /(?:\b(?:ReferenceError|TypeError|SyntaxError|AssertionError|RangeError|Traceback)\b|\bnot ok\b|\bFAIL\b|at\s+[^\s()]+\.[cm]?[jt]sx?:\d+|ошибк[аиу]|падает|упал|стектрейс)/i.test(p)
  ) {
    return 'debug';
  }
  if (
    hasEditedTargets ||
    /(?:^|[^a-zA-Zа-яёА-ЯЁ0-9_-])(?:edit_file|patch-symbol|replace|refactor|переименуй|замени\s+в|исправь\s+функцию|отредактируй|добавь\s+в)(?=$|[^a-zA-Zа-яёА-ЯЁ0-9_-])/i.test(p)
  ) {
    return 'edit';
  }
  return 'explore';
}

export function selectDiverseSlicesWithTelemetry(pool, { topK = 6, lambda = 0.72 } = {}) {
  if (!Array.isArray(pool) || pool.length <= 1) {
    return Array.isArray(pool) ? pool.slice(0, topK) : [];
  }
  const t0 = performance.now();
  const mmrRes = selectDiverseSlicesMMR(pool, { topK, lambda });
  const filtered = Array.isArray(mmrRes?.filteredDuplicates) ? mmrRes.filteredDuplicates : [];
  if (filtered.length > 0) {
    const savedChars = filtered.reduce(
      (sum, item) => sum + Math.max(120, String(item?.snippetText ?? item?.text ?? item?.snippet ?? '').length),
      0
    );
    try {
      recordCpuCompressionSaving({
        kind: 'mmr',
        savedChars,
        latencyMs: performance.now() - t0,
      });
    } catch {}
  }
  return Array.isArray(mmrRes?.selected) ? mmrRes.selected : pool.slice(0, topK);
}

export const COMPOSER_STOPWORDS = new Set([
  'как', 'что', 'где', 'когда', 'почему', 'зачем', 'какой', 'какая', 'какие', 'каком',
  'это', 'эту', 'этот', 'эти', 'этих', 'для', 'или', 'при', 'без', 'под', 'над', 'про',
  'мне', 'нам', 'тут', 'там', 'все', 'всё', 'еще', 'ещё', 'уже', 'просто', 'очень',
  'нужно', 'надо', 'можно', 'будет', 'есть', 'был', 'была', 'были', 'она', 'они', 'его',
  'сделай', 'напиши', 'покажи', 'проверь', 'исправь', 'добавь', 'объясни', 'помоги',
  'пожалуйста', 'работ', 'работает', 'делать', 'лучше', 'сейчас', 'такое', 'через',
  'привет', 'прив', 'помог', 'пожалуйст', 'спасибо', 'спасиб', 'красиво', 'красив',
  'оформить', 'оформ', 'мысль', 'мысл', 'давай', 'хочу', 'скажи', 'расскажи', 'добрый',
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'what', 'where', 'when', 'why',
  'how', 'can', 'you', 'please', 'make', 'add', 'fix', 'check', 'show', 'explain',
  'help', 'into', 'about', 'have', 'has', 'are', 'was', 'were', 'will', 'would',
  'should', 'could', 'does', 'work', 'works', 'working', 'using', 'used', 'hello', 'thanks',
]);

export const SHORT_TECH_TOKENS = new Set([
  'ui', 'db', 'fs', 'os', 'ip', 'ws', 'ai', 'id', 'kv', 'gc',
  'ast', 'mcp', 'gpu', 'ram', 'cpu', 'ipc', 'rag', 'cli', 'hud',
  'csp', 'lru', 'rrf', 'mmr', 'ppr', 'api', 'sse', 'url', 'jwt', 'env', 'git',
]);

export const IGNORED_MULTI_TURN_IDS = new Set([
  'javascript', 'typescript', 'powershell', 'antigravity', 'github', 'ollama', 'nodejs',
  'string', 'number', 'boolean', 'object', 'array', 'promise', 'error', 'typeerror',
  'syntaxerror', 'referenceerror', 'console', 'return', 'function', 'typeof', 'import',
  'export', 'default', 'async', 'await', 'const', 'true', 'false', 'null', 'undefined',
  'math', 'json', 'date', 'buffer', 'settimeout', 'cleartimeout', 'setinterval', 'clearinterval',
]);

const FILE_MENTION_RE = /[A-Za-z0-9_./-]+\.(?:mjs|cjs|js|ts|tsx|jsx|json|md|html|css|py|go|rs|toml|yaml|yml)\b/gi;

/**
 * Enriches a follow-up chat query with up to `maxExtraTerms` file paths and code identifiers
 * mentioned in the last 4 conversation turns (pure CPU, 0ms).
 * @param {string} [query='']
 * @param {Array<{ role?: string, content?: string }>} [messages=[]]
 * @param {{ maxExtraTerms?: number }} [options={}]
 * @returns {string}
 */
export function enrichMultiTurnChatQuery(query = '', messages = [], { maxExtraTerms = 6 } = {}) {
  const cleanQuery = String(query || '').trim();
  if (!cleanQuery || !Array.isArray(messages) || messages.length === 0) {
    return cleanQuery;
  }
  const limit = Math.max(1, Math.min(12, Number(maxExtraTerms) || 6));
  const queryLower = cleanQuery.toLowerCase();
  const seenLower = new Set();
  const extraTerms = [];

  const pushCandidate = (raw, isFile = false) => {
    if (extraTerms.length >= limit) return;
    const cleaned = String(raw || '')
      .trim()
      .replace(/^[`'"]+|[`'":;,.)\]]+$/g, '')
      .replace(/^\.\//, '');
    if (!cleaned || cleaned.length < 3 || cleaned.length > 88) return;
    if (/^https?:\/\//i.test(cleaned) || /^\d+$/.test(cleaned)) return;
    const lower = cleaned.toLowerCase();
    if (IGNORED_MULTI_TURN_IDS.has(lower) || COMPOSER_STOPWORDS.has(lower)) return;
    if (queryLower.includes(lower) || seenLower.has(lower)) return;
    seenLower.add(lower);
    if (isFile) {
      const base = path.posix.basename(lower);
      if (base) seenLower.add(base);
    }
    extraTerms.push(cleaned);
  };

  const recentTurns = messages.slice(-4);
  for (let i = recentTurns.length - 1; i >= 0 && extraTerms.length < limit; i--) {
    const text = String(recentTurns[i]?.content || '');
    if (!text) continue;

    for (const m of text.matchAll(FILE_MENTION_RE)) {
      pushCandidate(m[0], true);
      if (extraTerms.length >= limit) break;
    }
    for (const m of text.matchAll(/`([A-Za-z0-9_./$-]{3,80})(?:\(\))?`/g)) {
      const val = m[1];
      pushCandidate(val, /\.[a-z0-9]{1,5}$/i.test(val));
      if (extraTerms.length >= limit) break;
    }
    for (const m of text.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]{2,})\s*\(/g)) {
      pushCandidate(m[1], false);
      if (extraTerms.length >= limit) break;
    }
    for (const m of text.matchAll(/\b[a-zA-Z_$][a-z0-9_$]*[A-Z][A-Za-z0-9_$]*\b/g)) {
      pushCandidate(m[0], false);
      if (extraTerms.length >= limit) break;
    }
    for (const m of text.matchAll(/\b[a-zA-Z]{2,}_[a-zA-Z0-9_]{2,}\b/g)) {
      pushCandidate(m[0], false);
      if (extraTerms.length >= limit) break;
    }
  }

  return extraTerms.length > 0 ? `${cleanQuery} ${extraTerms.join(' ')}` : cleanQuery;
}

const GATED_WORKSPACE_TECH_TERMS = [
  'redis', 'sqlite', 'postgres', 'postgresql', 'mysql', 'mongodb', 'supabase', 'firebase',
  'prisma', 'drizzle', 'typeorm', 'sequelize', 'graphql', 'grpc', 'trpc', 'kafka', 'rabbitmq',
  'celery', 'docker', 'kubernetes', 'k8s', 'terraform', 'ansible', 'nginx', 'caddy', 'sonarqube',
  'indexeddb', 'vllm', 'mtls', 'oauth', 'jwt', 'webpack', 'rollup', 'nextjs', 'nuxt', 'svelte',
  'angular', 'fastapi', 'flask', 'django', 'websocket',
];

export function setBoundedRepoMapCache(ws, key, value, maxEntries = 24) {
  if (!ws?.repoMapCache) return;
  if (ws.repoMapCache.has(key)) ws.repoMapCache.delete(key);
  ws.repoMapCache.set(key, value);
  while (ws.repoMapCache.size > maxEntries) {
    const oldest = ws.repoMapCache.keys().next().value;
    if (oldest === undefined) break;
    ws.repoMapCache.delete(oldest);
  }
}

function cloneInventory(inv) {
  const symCopy = Object.create(null);
  for (const [k, v] of Object.entries(inv.symbolsByFile || {})) {
    symCopy[k] = Array.isArray(v) ? [...v] : v;
  }
  return {
    repoFiles: [...(inv.repoFiles || [])],
    repoSymbols: [...(inv.repoSymbols || [])],
    symbolsByFile: symCopy,
    repoTechTerms: [...(inv.repoTechTerms || [])],
  };
}

export function collectWorkspaceGroundingInventory(ws, { maxRepoFiles = 500, maxRepoSymbols = 2500 } = {}) {
  if (!ws || !ws.files || ws.files.size === 0) {
    return { repoFiles: [], repoSymbols: [], symbolsByFile: {}, repoTechTerms: [] };
  }
  const cacheKey = `__grounding_inv_${maxRepoFiles}_${maxRepoSymbols}__`;
  if (ws.repoMapCache?.has(cacheKey)) {
    const cached = ws.repoMapCache.get(cacheKey);
    ws.repoMapCache.delete(cacheKey);
    ws.repoMapCache.set(cacheKey, cached);
    return cloneInventory(cached);
  }

  const allRels = Array.from(ws.files.keys());
  let repoFiles;
  if (allRels.length <= maxRepoFiles) {
    repoFiles = allRels;
  } else {
    const codeFirst = [];
    const others = [];
    for (const rel of allRels) {
      const entry = ws.files.get(rel);
      if (entry && CODE_EXTENSIONS.has(entry.ext)) codeFirst.push(rel);
      else others.push(rel);
    }
    repoFiles = [...codeFirst, ...others].slice(0, maxRepoFiles);
  }

  const repoSymbols = [];
  const seenSyms = new Set();
  const directSymsByFile = new Map();
  const foundTechSet = new Set();

  const addSym = (raw) => {
    if (repoSymbols.length >= maxRepoSymbols) return;
    const name = typeof raw === 'string' ? raw.trim() : String(raw?.name || '').trim();
    if (!name || name.length < 2 || name === 'anonymous' || seenSyms.has(name)) return;
    seenSyms.add(name);
    repoSymbols.push(name);
  };

  for (const [rel, entry] of ws.files.entries()) {
    const localSet = new Set();
    for (const exp of entry.exportedSymbols || []) {
      const n = typeof exp === 'string' ? exp.trim() : '';
      if (n && n.length >= 2 && n !== 'anonymous') {
        localSet.add(n);
        addSym(n);
      }
    }
    for (const sym of entry.symbols || []) {
      const n = String(sym?.name || '').trim();
      if (n && n.length >= 2 && n !== 'anonymous') {
        localSet.add(n);
      }
    }
    if (localSet.size > 0) {
      directSymsByFile.set(rel, Array.from(localSet).slice(0, 120));
    }
    if (entry.tokens && foundTechSet.size < GATED_WORKSPACE_TECH_TERMS.length) {
      for (const term of GATED_WORKSPACE_TECH_TERMS) {
        if (!foundTechSet.has(term) && entry.tokens.has(term)) {
          foundTechSet.add(term);
        }
      }
    }
  }
  if (repoSymbols.length < maxRepoSymbols) {
    for (const entry of ws.files.values()) {
      for (const sym of entry.symbols || []) {
        addSym(sym);
        if (repoSymbols.length >= maxRepoSymbols) break;
      }
      if (repoSymbols.length >= maxRepoSymbols) break;
    }
  }

  // Build 1-hop aware symbolsByFile (own symbols + imported/caller neighbor symbols)
  const symbolsByFile = Object.create(null);
  for (const rel of repoFiles) {
    const merged = new Set(directSymsByFile.get(rel) || []);
    for (const fwd of ws.forwardDeps?.get(rel) || []) {
      for (const s of directSymsByFile.get(fwd) || []) {
        merged.add(s);
        if (merged.size >= 240) break;
      }
      if (merged.size >= 240) break;
    }
    for (const rev of ws.reverseDeps?.get(rel) || []) {
      for (const s of directSymsByFile.get(rev) || []) {
        merged.add(s);
        if (merged.size >= 300) break;
      }
      if (merged.size >= 300) break;
    }
    if (merged.size > 0) {
      symbolsByFile[rel] = Array.from(merged);
    }
  }

  const inv = {
    repoFiles,
    repoSymbols,
    symbolsByFile,
    repoTechTerms: Array.from(foundTechSet),
  };
  setBoundedRepoMapCache(ws, cacheKey, inv, 24);
  return cloneInventory(inv);
}

export function extractExplicitFileMatches(text = '', filesMap) {
  const matched = new Set();
  if (!text || !filesMap || filesMap.size === 0) return matched;
  const mentions = String(text).match(FILE_MENTION_RE) || [];
  if (mentions.length === 0) return matched;

  const normMentions = mentions
    .map((m) => m.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').toLowerCase())
    .filter(Boolean);
  if (normMentions.length === 0) return matched;

  for (const rel of filesMap.keys()) {
    const relLower = rel.toLowerCase();
    const baseLower = path.posix.basename(relLower);
    for (const men of normMentions) {
      if (relLower === men || relLower.endsWith(`/${men}`) || baseLower === men) {
        matched.add(rel);
        break;
      }
    }
  }
  return matched;
}

const JS_METHOD_EXT_SET = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.mts', '.cts']);
const JS_CONTROL_KEYWORDS = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'with',
  'function',
  'return',
  'typeof',
  'delete',
  'throw',
  'await',
  'super',
  'import',
]);

/**
 * Supplements `extractFileAllMetadata` with class/object method declarations that use
 * multi-line parameter lists or destructured `{ ... } = {}` defaults in large classes.
 */
export function augmentJsMethodSymbols(ext, text, baseSymbols = []) {
  if (!JS_METHOD_EXT_SET.has(ext) || !text) return baseSymbols;
  const existingLines = new Set(baseSymbols.map((s) => s.startLine));
  const lines = text.split(/\r?\n/);
  const added = [];
  const headRe =
    /^(\s{2,6})(?:(?:public|private|protected|readonly|override|async|static|get|set)\s+)*([A-Za-z_$][A-Za-z0-9_$]{1,})\s*\(/;

  for (let i = 0; i < lines.length; i++) {
    const startLine = i + 1;
    if (existingLines.has(startLine)) continue;
    const m = headRe.exec(lines[i]);
    if (!m) continue;
    const name = m[2];
    if (JS_CONTROL_KEYWORDS.has(name)) continue;
    const openIdx = lines[i].indexOf('(', m[1].length);
    if (openIdx < 0) continue;

    let depth = 0;
    let foundBody = false;
    let inQuote = '';
    let escaped = false;
    let inBlockComment = false;
    let closeLine = -1;
    let closeCol = -1;

    for (let j = i; j < Math.min(lines.length, i + 16); j++) {
      const ln = lines[j];
      const startCol = j === i ? openIdx : 0;
      for (let c = startCol; c < ln.length; c++) {
        const ch = ln[c];
        const next = ln[c + 1];
        if (inBlockComment) {
          if (ch === '*' && next === '/') {
            inBlockComment = false;
            c++;
          }
          continue;
        }
        if (inQuote) {
          if (escaped) escaped = false;
          else if (ch === '\\') escaped = true;
          else if (ch === inQuote) inQuote = '';
          continue;
        }
        if (ch === '/' && next === '/') break;
        if (ch === '/' && next === '*') {
          inBlockComment = true;
          c++;
          continue;
        }
        if (ch === '\'' || ch === '"' || ch === '`') {
          inQuote = ch;
          continue;
        }
        if (ch === '(') depth++;
        else if (ch === ')') {
          depth--;
          if (depth === 0) {
            closeLine = j;
            closeCol = c + 1;
            break;
          }
        }
      }
      if (depth <= 0 && closeLine !== -1) break;
    }

    if (closeLine !== -1 && depth === 0) {
      let retAngle = 0;
      let retParen = 0;
      let retBrace = 0;
      let retBracket = 0;
      let sawTypeColon = false;
      let bQuote = '';
      let bEscaped = false;
      let bBlock = false;
      let done = false;
      for (let k = closeLine; k < Math.min(lines.length, closeLine + 3) && !done; k++) {
        const ln = lines[k];
        const c0 = k === closeLine ? closeCol : 0;
        for (let c = c0; c < ln.length; c++) {
          const ch = ln[c];
          const next = ln[c + 1];
          if (bBlock) {
            if (ch === '*' && next === '/') {
              bBlock = false;
              c++;
            }
            continue;
          }
          if (bQuote) {
            if (bEscaped) bEscaped = false;
            else if (ch === '\\') bEscaped = true;
            else if (ch === bQuote) bQuote = '';
            continue;
          }
          if (ch === '/' && next === '/') break;
          if (ch === '/' && next === '*') {
            bBlock = true;
            c++;
            continue;
          }
          if (ch === '\'' || ch === '"' || ch === '`') {
            bQuote = ch;
            continue;
          }
          if (/\s/.test(ch)) continue;
          if (ch === ':' && !sawTypeColon && retParen === 0 && retBrace === 0 && retAngle === 0 && retBracket === 0) {
            sawTypeColon = true;
            continue;
          }
          if (sawTypeColon) {
            if (ch === '<') { retAngle++; continue; }
            if (ch === '>') {
              if (c > 0 && ln[c - 1] === '=') continue; // => inside type
              retAngle = Math.max(0, retAngle - 1);
              continue;
            }
            if (ch === '(') { retParen++; continue; }
            if (ch === ')') { retParen = Math.max(0, retParen - 1); continue; }
            if (ch === '[') { retBracket++; continue; }
            if (ch === ']') { retBracket = Math.max(0, retBracket - 1); continue; }
            if (ch === '{') {
              // Inside TS object return type only if previous non-space token was ':' or type operator, OR check if matching '}' precedes '{'
              const restOnLine = ln.slice(c + 1);
              const looksLikeTsReturnObj = !/^\s*(?:\/\/.*)?$/.test(restOnLine) && !/\breturn\b/.test(restOnLine);
              if (retBrace === 0 && !looksLikeTsReturnObj) {
                foundBody = true;
                done = true;
                break;
              }
              retBrace++;
              continue;
            }
            if (ch === '}') {
              retBrace = Math.max(0, retBrace - 1);
              continue;
            }
            if (ch === ';' && retBrace === 0 && retParen === 0) {
              done = true;
              break;
            }
          } else {
            if (ch === '{') {
              foundBody = true;
              done = true;
              break;
            }
            if (ch === '=' && next === '>') {
              done = true;
              break;
            }
            if (ch === ';') {
              done = true;
              break;
            }
            // Any unexpected token right after `)` (not `:` or `{`) means a call, not a method declaration
            done = true;
            break;
          }
        }
      }
    }

    if (foundBody) {
      added.push({
        name,
        kind: 'method',
        signature: `method ${name}()`,
        startLine,
        endLine: startLine,
      });
    }
  }

  if (added.length === 0) return baseSymbols;
  return [...baseSymbols, ...added].sort((a, b) => a.startLine - b.startLine);
}

/**
 * Resolves the true closing line of an AST symbol, handling functions with multi-line
 * destructured parameters where regex extractors set `sym.endLine === sym.startLine`.
 */
export function inferEffectiveSymbolEndLine(entry, syms, symStart, rawSymEnd, fallbackEndHint = 0, cap = 55) {
  const totalLines = entry?.lineCount || 1;
  if (rawSymEnd > symStart + 1) {
    return Math.min(totalLines, rawSymEnd);
  }

  const buf = entry?.buf;
  const lineOffsets = entry?.lineOffsets;
  const measureLineIndent = (lineNo) => {
    if (!buf || !lineOffsets || lineNo < 1 || lineNo > totalLines) return 0;
    const bStart = lineOffsets[lineNo - 1] || 0;
    let indent = 0;
    while (bStart + indent < buf.length) {
      const ch = buf[bStart + indent];
      if (ch === 32 || ch === 9) indent++;
      else break;
    }
    return indent;
  };

  const declIndent = measureLineIndent(symStart);
  let nextBoundary = totalLines;
  for (const s of syms || []) {
    const otherStart = Number(s?.startLine) || 0;
    if (otherStart > symStart && otherStart - 1 < nextBoundary) {
      if (measureLineIndent(otherStart) <= declIndent) {
        nextBoundary = otherStart - 1;
      }
    }
  }

  const scanEnd = Math.min(totalLines, nextBoundary, symStart + 360);
  if (scanEnd > symStart && buf && lineOffsets) {
    const startByte = lineOffsets[symStart - 1] || 0;
    const endByte = scanEnd < totalLines
      ? Math.max(startByte, lineOffsets[scanEnd] - 1)
      : buf.length;
    const rawChunk = buf.toString('utf8', startByte, endByte);
    const chunkLines = rawChunk.split(/\r?\n/);
    const firstLine = chunkLines[0] || '';

    if (entry?.ext === '.py') {
      let sawColon = /:\s*(?:#.*)?$/.test(firstLine);
      let lastBodyIdx = 0;
      for (let i = 1; i < chunkLines.length; i++) {
        const ln = chunkLines[i];
        const trimmed = ln.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const lineIndent = ln.match(/^[ \t]*/)?.[0].length || 0;
        if (!sawColon) {
          if (/:\s*(?:#.*)?$/.test(ln)) sawColon = true;
          lastBodyIdx = i;
          continue;
        }
        if (lineIndent <= declIndent) {
          break;
        }
        lastBodyIdx = i;
      }
      if (lastBodyIdx > 0) {
        return Math.min(totalLines, symStart + lastBodyIdx);
      }
    } else {
      const closeBraceRe = declIndent === 0
        ? /^}\s*;?\s*$/
        : new RegExp(`^[ \\t]{0,${declIndent}}}\\s*;?\\s*$`);

      let sawOpenBrace = firstLine.includes('{');
      for (let i = 1; i < chunkLines.length; i++) {
        const ln = chunkLines[i];
        if (!sawOpenBrace && ln.includes('{')) {
          sawOpenBrace = true;
        }
        if (sawOpenBrace && closeBraceRe.test(ln)) {
          return Math.min(totalLines, symStart + i);
        }
      }
    }
  }

  const minTarget = Math.max(Number(fallbackEndHint) || symStart, symStart + cap - 1);
  return Math.max(symStart, Math.min(totalLines, nextBoundary, minTarget));
}

export function expandSliceToWholeAstSymbol(entry, rawStart, rawEnd, focusLine = 0, query = '', maxSliceLines = 55) {
  const cap = Math.max(16, Math.min(80, Number(maxSliceLines) || 55));
  const totalLines = entry?.lineCount || 1;
  const sRaw = Math.max(1, Math.min(totalLines, Number(rawStart) || 1));
  const eRaw = Math.max(sRaw, Math.min(totalLines, Number(rawEnd) || sRaw));
  const buf = entry?.buf;
  const lineOffsets = entry?.lineOffsets;
  if (!buf || !lineOffsets || lineOffsets.length === 0) {
    return { startLine: sRaw, endLine: eRaw, symbol: '', signature: '', snippetText: '' };
  }
  const entrySnapshot = { ...entry, buf, lineOffsets };
  const focus = focusLine > 0 ? Math.max(1, Math.min(totalLines, Number(focusLine))) : Math.round((sRaw + eRaw) / 2);
  const queryLower = String(query || '').toLowerCase();

  const syms = Array.isArray(entry.symbols) ? entry.symbols : [];
  const candidates = [];
  for (const sym of syms) {
    const symStart = Number(sym?.startLine) || 0;
    if (symStart < 1) continue;
    const rawSymEnd = Math.max(symStart, Math.min(totalLines, Number(sym?.endLine) || symStart));
    const symEnd = inferEffectiveSymbolEndLine(entrySnapshot, syms, symStart, rawSymEnd, eRaw + 24, cap);
    if (symStart <= eRaw + 3 && symEnd >= sRaw - 3) {
      candidates.push({ sym, symStart, symEnd, span: symEnd - symStart + 1 });
    }
  }

  if (candidates.length > 0) {
    const hasCompactFn = candidates.some((c) => c.sym.kind !== 'class' || c.span <= 220);
    const filtered = hasCompactFn
      ? candidates.filter((c) => !(c.sym.kind === 'class' && c.span > 220 && focus > c.symStart + 4))
      : candidates;
    const pool = filtered.length > 0 ? filtered : candidates;

    let best = pool[0];
    let bestScore = -Infinity;
    for (const c of pool) {
      const nameLower = String(c.sym.name || '').toLowerCase();
      let score = 0;
      if (nameLower.length >= 3 && queryLower.includes(nameLower)) score += 120;
      if (c.symStart <= focus && c.symEnd >= focus) score += 45;
      if (c.sym.kind && c.sym.kind !== 'class') score += 12;
      score -= Math.min(90, c.span * 0.18);
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }

    const { sym, symStart, symEnd, span } = best;
    if (span <= cap) {
      return {
        startLine: symStart,
        endLine: symEnd,
        symbol: sym.name || '',
        signature: sym.signature || '',
        snippetText: sliceBufferLines(buf, lineOffsets, symStart, symEnd),
      };
    }

    const extractControlOutline = (fromLine, toLine, maxItems = 4) => {
      if (!buf || !lineOffsets || toLine < fromLine) return [];
      const rawRange = sliceBufferLines(buf, lineOffsets, fromLine, Math.min(toLine, fromLine + 160));
      const hits = [];
      for (const line of rawRange.split('\n')) {
        const m = /^(L\d+):\s*(.+)$/.exec(line);
        if (!m) continue;
        const body = m[2].trim();
        if (/^(?:if\s*\(|else\s+if\s*\(|return\b|throw\b|catch\b|await\b|switch\s*\()/i.test(body)) {
          hits.push(`${m[1]}:   // [outline] ${body.slice(0, 92)}`);
          if (hits.length >= maxItems) break;
        }
      }
      return hits;
    };

    if (eRaw <= symStart + cap - 1) {
      const endBounded = Math.min(symEnd, symStart + cap - 1);
      let headSnippet = sliceBufferLines(buf, lineOffsets, symStart, endBounded);
      if (symEnd - endBounded > 10) {
        const tailOutline = extractControlOutline(endBounded + 1, symEnd, 4);
        if (tailOutline.length > 0) {
          headSnippet += `\nL${endBounded + 1}:   // ... [L${endBounded + 1}-L${symEnd} tail outline:]\n${tailOutline.join('\n')}`;
        }
      }
      return {
        startLine: symStart,
        endLine: endBounded,
        symbol: sym.name || '',
        signature: sym.signature || '',
        snippetText: headSnippet,
      };
    }

    // Detect multi-line parameter signature end (up to 14 lines) so full signature stays visible
    let detectedSigLines = 3;
    const maxSigProbe = Math.min(totalLines, symStart + 14, sRaw - 1);
    if (maxSigProbe > symStart) {
      const sigStartByte = lineOffsets[symStart - 1] || 0;
      const sigEndByte = maxSigProbe < totalLines
        ? Math.max(sigStartByte, lineOffsets[maxSigProbe] - 1)
        : buf.length;
      const sigProbeRaw = buf.toString('utf8', sigStartByte, sigEndByte);
      const sigProbeArr = sigProbeRaw.split(/\r?\n/);
      for (let si = 0; si < sigProbeArr.length; si++) {
        if (/\)\s*(?::[^{=]+)?\{\s*$/.test(sigProbeArr[si])) {
          detectedSigLines = si + 1;
          break;
        }
      }
    }
    const sigHeadLines = Math.min(14, Math.max(1, Math.min(detectedSigLines, sRaw - symStart)));
    const bodyBudget = Math.max(10, cap - sigHeadLines - 1);
    const halfPad = Math.max(2, Math.floor((bodyBudget - Math.min(bodyBudget, eRaw - sRaw + 1)) / 2));
    let winStart = Math.max(symStart + sigHeadLines, sRaw - halfPad);
    let winEnd = Math.min(symEnd, winStart + bodyBudget - 1);
    if (winEnd - winStart + 1 < bodyBudget) {
      winStart = Math.max(symStart + sigHeadLines, winEnd - bodyBudget + 1);
    }

    const headText = sliceBufferLines(buf, lineOffsets, symStart, symStart + sigHeadLines - 1);
    const bodyText = sliceBufferLines(buf, lineOffsets, winStart, winEnd);

    const hasGap = winStart > symStart + sigHeadLines;
    let gapLine = '\n';
    if (hasGap) {
      const gapOutline = extractControlOutline(symStart + sigHeadLines, winStart - 1, 4);
      gapLine = gapOutline.length > 0
        ? `\nL${symStart + sigHeadLines}:   // ... [L${symStart + sigHeadLines}-L${winStart - 1} folded; control flow:]\n${gapOutline.join('\n')}\n`
        : `\nL${symStart + sigHeadLines}:   // ... [L${symStart + sigHeadLines}-L${winStart - 1} folded to fit ${cap}L symbol cap] ...\n`;
    }
    let tailLine = '';
    if (symEnd - winEnd > 10) {
      const tailOutline = extractControlOutline(winEnd + 1, symEnd, 3);
      if (tailOutline.length > 0) {
        tailLine = `\nL${winEnd + 1}:   // ... [L${winEnd + 1}-L${symEnd} tail outline:]\n${tailOutline.join('\n')}`;
      }
    }
    return {
      startLine: symStart,
      endLine: winEnd,
      symbol: sym.name || '',
      signature: sym.signature || '',
      snippetText: `${headText}${gapLine}${bodyText}${tailLine}`,
    };
  }

  const windowCap = Math.min(cap, 42);
  const startL = Math.max(1, sRaw - 6);
  const endL = Math.min(totalLines, startL + windowCap - 1, Math.max(eRaw + 14, startL + 18));
  return {
    startLine: startL,
    endLine: endL,
    symbol: '',
    signature: '',
    snippetText: sliceBufferLines(buf, lineOffsets, startL, endL),
  };
}

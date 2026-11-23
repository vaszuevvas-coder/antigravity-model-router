/**
 * @file ram-index-helpers.mjs
 * @description Pure buffer, tokenizer, AST symbol slicing, and query enrichment helpers for RamMemoryEngine.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { extractFileAllMetadata, stemWord } from '../repo-mapper.mjs';
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
  const unCamel = text.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
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
  const unCamel = text.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
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
  const isDocExt = ext === '.md' || ext === '.mdx' || ext === '.txt';
  const bodyLines = [];
  const docLines = [];
  const sigExtras = [];
  const rawLines = text ? text.split(/\r?\n/) : [];

  for (const line of rawLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (isDocExt) {
      if (trimmed.startsWith('#')) sigExtras.push(trimmed);
      else docLines.push(trimmed);
    } else if (/^(?:\/\/|\/\*|\*|#(?!!))/.test(trimmed)) {
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
 * Resolves candidate local import relative path within workspace (JS/TS ESM NodeNext, Vite queries, Python relative).
 * @param {string} fromRel
 * @param {string} spec
 * @param {Map<string, object>} filesMap
 * @returns {string|null}
 */
export function resolveImportRel(fromRel, spec, filesMap, options = {}) {
  if (!spec || typeof spec !== 'string') return null;
  const cleanSpec = spec.split('?')[0].split('#')[0].trim();
  if (!cleanSpec) return null;

  const baseDir = path.posix.dirname(fromRel);

  // Python relative and workspace-absolute imports
  if (fromRel.endsWith('.py')) {
    if (cleanSpec.startsWith('.') && !cleanSpec.startsWith('./') && !cleanSpec.startsWith('../')) {
      const dots = cleanSpec.match(/^\.+/)?.[0].length || 1;
      let pyBase = baseDir;
      for (let i = 1; i < dots; i++) {
        pyBase = path.posix.dirname(pyBase);
      }
      const modRel = cleanSpec.slice(dots).replace(/\./g, '/');
      const pyRaw = modRel
        ? [path.posix.join(pyBase, `${modRel}.py`), path.posix.join(pyBase, modRel, '__init__.py')]
        : [path.posix.join(pyBase, '__init__.py')];
      for (const rawCand of pyRaw) {
        const normCand = path.posix.normalize(rawCand);
        if (!normCand.startsWith('../') && filesMap.has(normCand)) {
          return normCand;
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
        if (filesMap.has(cand)) return cand;
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

  if (!cleanSpec.startsWith('./') && !cleanSpec.startsWith('../')) return null;
  const joined = path.posix.normalize(path.posix.join(baseDir, cleanSpec));
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
    if (filesMap.has(c)) return c;
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

export function collectWorkspaceGroundingInventory(ws, { maxRepoFiles = 500, maxRepoSymbols = 2500 } = {}) {
  if (!ws || !ws.files || ws.files.size === 0) {
    return { repoFiles: [], repoSymbols: [], symbolsByFile: {}, repoTechTerms: [] };
  }
  const cacheKey = `__grounding_inv_${maxRepoFiles}_${maxRepoSymbols}__`;
  if (ws.repoMapCache?.has(cacheKey)) {
    return ws.repoMapCache.get(cacheKey);
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
  ws.repoMapCache?.set(cacheKey, inv);
  return inv;
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

const JS_METHOD_EXT_SET = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx']);
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
    for (let j = i; j < Math.min(lines.length, i + 16); j++) {
      const ln = lines[j];
      const startCol = j === i ? openIdx : 0;
      for (let c = startCol; c < ln.length; c++) {
        const ch = ln[c];
        if (ch === '(') depth++;
        else if (ch === ')') {
          depth--;
          if (depth === 0) {
            const rest = ln.slice(c + 1);
            if (/^\s*(?::[^\{;]+)?\{\s*(?:\/\/.*)?$/.test(rest)) {
              foundBody = true;
            }
            break;
          }
        }
      }
      if (depth <= 0) break;
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
  const totalLines = entry.lineCount || 1;
  if (rawSymEnd > symStart + 1) {
    return Math.min(totalLines, rawSymEnd);
  }

  const measureLineIndent = (lineNo) => {
    if (!entry.buf || !entry.lineOffsets || lineNo < 1 || lineNo > totalLines) return 0;
    const bStart = entry.lineOffsets[lineNo - 1] || 0;
    let indent = 0;
    while (bStart + indent < entry.buf.length) {
      const ch = entry.buf[bStart + indent];
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
  if (scanEnd > symStart && entry.buf && entry.lineOffsets) {
    const startByte = entry.lineOffsets[symStart - 1] || 0;
    const endByte = scanEnd < totalLines
      ? Math.max(startByte, entry.lineOffsets[scanEnd] - 1)
      : entry.buf.length;
    const rawChunk = entry.buf.toString('utf8', startByte, endByte);
    const chunkLines = rawChunk.split(/\r?\n/);
    const firstLine = chunkLines[0] || '';
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

  const minTarget = Math.max(Number(fallbackEndHint) || symStart, symStart + cap - 1);
  return Math.max(symStart, Math.min(totalLines, nextBoundary, minTarget));
}

export function expandSliceToWholeAstSymbol(entry, rawStart, rawEnd, focusLine = 0, query = '', maxSliceLines = 55) {
  const cap = Math.max(16, Math.min(80, Number(maxSliceLines) || 55));
  const totalLines = entry.lineCount || 1;
  const sRaw = Math.max(1, Math.min(totalLines, Number(rawStart) || 1));
  const eRaw = Math.max(sRaw, Math.min(totalLines, Number(rawEnd) || sRaw));
  const focus = focusLine > 0 ? Math.max(1, Math.min(totalLines, Number(focusLine))) : Math.round((sRaw + eRaw) / 2);
  const queryLower = String(query || '').toLowerCase();

  const syms = Array.isArray(entry.symbols) ? entry.symbols : [];
  const candidates = [];
  for (const sym of syms) {
    const symStart = Number(sym?.startLine) || 0;
    if (symStart < 1) continue;
    const rawSymEnd = Math.max(symStart, Math.min(totalLines, Number(sym?.endLine) || symStart));
    const symEnd = inferEffectiveSymbolEndLine(entry, syms, symStart, rawSymEnd, eRaw + 24, cap);
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
        snippetText: sliceBufferLines(entry.buf, entry.lineOffsets, symStart, symEnd),
      };
    }

    const extractControlOutline = (fromLine, toLine, maxItems = 4) => {
      if (!entry.buf || !entry.lineOffsets || toLine < fromLine) return [];
      const rawRange = sliceBufferLines(entry.buf, entry.lineOffsets, fromLine, Math.min(toLine, fromLine + 160));
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
      let headSnippet = sliceBufferLines(entry.buf, entry.lineOffsets, symStart, endBounded);
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
      const sigProbeRaw = entry.buf.toString(
        'utf8',
        entry.lineOffsets[symStart - 1] || 0,
        maxSigProbe < totalLines ? entry.lineOffsets[maxSigProbe] - 1 : entry.buf.length
      );
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

    const headText = sliceBufferLines(entry.buf, entry.lineOffsets, symStart, symStart + sigHeadLines - 1);
    const bodyText = sliceBufferLines(entry.buf, entry.lineOffsets, winStart, winEnd);

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
    snippetText: sliceBufferLines(entry.buf, entry.lineOffsets, startL, endL),
  };
}

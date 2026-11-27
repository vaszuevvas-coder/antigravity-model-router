/**
 * @file background-sentinel.mjs
 * @description Unified Background Sentinel coordinator (CPU + RAM + Idle Local GPU) with P0 Preemption:
 *   - Engine A: Zero-Token Shadow Contract & Syntax Guard (100% CPU+RAM, 0% GPU)
 *   - Engine B: Idle Local GPU Diff Reviewer / Local BugBot (SHA-256 deduplicated)
 *   - Engine C: Idle Module Symbol Cards (incremental SHA-256 bilingual module index)
 *   - Engine D: Speculative Prompt-Draft Context Pre-Warmer (45s RAM LRU, Jaccard >= 0.65)
 *   - Engine E: Opt-In Idle Shadow Micro-Tests (disabled by default, abortable child process)
 */

import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path, { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { atomicWriteJsonSync, safeReadJsonSync, updateJsonAtomicSync } from './safe-json.mjs';
import {
  buildWorkspaceSimHashIndex,
  findNearDuplicateFunctions,
  queryCoChangePartners,
  verifyExportArityAndKeyContracts,
} from './cpu-graph-contracts.mjs';
import { expandQueryBilingualStems } from './cpu-reranker.mjs';
import { extractFileSymbolsWithRanges } from './repo-mapper.mjs';
import {
  generateIdleModuleSymbolCard,
  generateLocalCommitSummary,
  getMsSinceLastForegroundGpu,
  preemptBackgroundGpuWork,
  reviewGitDiffHunkLocally,
} from './local-gpu-engine.mjs';
import { redactSecretsInText } from './security-guard.mjs';
import { normalizeLang, pickLang } from './i18n.mjs';
import { resolveTunnelCacheDir } from './cache-dir.mjs';
import { lspBridge } from './lsp-bridge.mjs';
import { knowledgeHub } from './sqlite-knowledge-hub.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, '..');
const DEFAULT_CACHE_DIR = join(PLUGIN_ROOT, '.cache');
const LOCAL_STATE_FILE = join(PLUGIN_ROOT, 'router-state.json');
const INSTALLED_STATE_FILE = join(
  os.homedir(),
  '.gemini',
  'config',
  'plugins',
  'antigravity-model-router',
  'router-state.json'
);

export const DEFAULT_SENTINEL_CONFIG = {
  sentinelEnabled: true,
  sentinelShadowGuard: true,
  sentinelLocalBugBot: true,
  sentinelSymbolCards: true,
  sentinelSpeculativeWarm: true,
  sentinelShadowTests: false,
};

const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  '.cache',
  '.next',
  'dist',
  'build',
  'out',
  'coverage',
  '.system_generated',
  '.turbo',
  '__pycache__',
]);

const ELIGIBLE_CARD_EXTS = new Set(['.mjs', '.js', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs']);
const JS_TS_EXTS = new Set(['.mjs', '.js', '.cjs', '.ts', '.tsx', '.jsx']);
const SPECULATIVE_TTL_MS = 45_000;
const SPECULATIVE_MAX_ENTRIES = 16;

function normWsKey(wsPath = '') {
  const abs = resolve(wsPath || process.cwd());
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

function toPosixRel(wsAbsRoot, targetPath = '') {
  if (!targetPath || typeof targetPath !== 'string') return '';
  const raw = targetPath.trim();
  if (!raw) return '';
  const rel = path.isAbsolute(raw) ? path.relative(wsAbsRoot, raw) : raw;
  return rel.replace(/\\/g, '/').replace(/^\.\//, '');
}

function computeWsHash(wsPath = '') {
  return createHash('sha1').update(normWsKey(wsPath)).digest('hex').slice(0, 16);
}

function sha256Hex(text = '') {
  return createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

function sha1Hex(text = '') {
  return createHash('sha1').update(String(text || ''), 'utf8').digest('hex');
}

function isTestRelPath(relPath = '') {
  const norm = relPath.replace(/\\/g, '/');
  return (
    /(?:^|\/)(?:tests?|__tests__|scratch)\//i.test(norm) ||
    /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(norm) ||
    /(?:^|\/)(?:test_[^/]+|[^/]+_test)\.py$/i.test(norm)
  );
}

function isIgnoredRelPath(relPath = '') {
  if (!relPath || relPath.startsWith('..')) return true;
  const parts = relPath.replace(/\\/g, '/').split('/');
  return parts.some((p) => IGNORED_DIRS.has(p));
}

function readLiveRouterStateRaw() {
  if (typeof process.env.TUNNEL_TEST_STATE_PATH === 'string' && process.env.TUNNEL_TEST_STATE_PATH.trim()) {
    return safeReadJsonSync(resolve(process.env.TUNNEL_TEST_STATE_PATH.trim()), () => ({}), { selfHeal: false }) || {};
  }
  const candidates = [];
  for (const p of [LOCAL_STATE_FILE, INSTALLED_STATE_FILE]) {
    try {
      if (existsSync(p)) {
        const st = statSync(p);
        candidates.push({ path: p, mtimeMs: st.mtimeMs || 0 });
      }
    } catch {}
  }
  if (candidates.length === 0) return {};
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return safeReadJsonSync(candidates[0].path, () => ({}), { selfHeal: false }) || {};
}

export function loadSentinelConfig(stateOverride = null) {
  const disk = readLiveRouterStateRaw();
  const merged = {
    ...disk,
    ...(stateOverride && typeof stateOverride === 'object' ? stateOverride : {}),
  };
  const rawEnvProf = typeof process.env.TUNNEL_HOOK_PROFILE === 'string' ? process.env.TUNNEL_HOOK_PROFILE.trim().toLowerCase() : '';
  const rawStateProf = typeof merged.hookProfile === 'string' ? merged.hookProfile.trim().toLowerCase() : '';
  const effectiveProfile = (rawEnvProf === 'minimal' || rawEnvProf === 'standard' || rawEnvProf === 'strict')
    ? rawEnvProf
    : ((rawStateProf === 'minimal' || rawStateProf === 'standard' || rawStateProf === 'strict') ? rawStateProf : 'standard');
  const explicitBugBotOverride = Boolean(stateOverride && typeof stateOverride === 'object' && Object.hasOwn(stateOverride, 'sentinelLocalBugBot'));
  return {
    sentinelEnabled: merged.sentinelEnabled !== false,
    sentinelShadowGuard: merged.sentinelShadowGuard !== false,
    sentinelLocalBugBot: (!explicitBugBotOverride && effectiveProfile === 'minimal') ? false : merged.sentinelLocalBugBot !== false,
    sentinelSymbolCards: merged.sentinelSymbolCards !== false,
    sentinelSpeculativeWarm: merged.sentinelSpeculativeWarm !== false,
    sentinelShadowTests: Boolean(merged.sentinelShadowTests === true),
  };
}

function scanWorkspaceFilesFallback(absRoot, maxFiles = 320) {
  const filesMap = new Map();
  if (!absRoot || !existsSync(absRoot)) return filesMap;

  const walk = (dir) => {
    if (filesMap.size >= maxFiles) return;
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (filesMap.size >= maxFiles) break;
      if (IGNORED_DIRS.has(ent.name)) continue;
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full);
      } else if (ent.isFile()) {
        const ext = extname(ent.name).toLowerCase();
        if (!ELIGIBLE_CARD_EXTS.has(ext) && ext !== '.json') continue;
        try {
          const st = statSync(full);
          if (st.size > 512 * 1024) continue;
          const text = readFileSync(full, 'utf8');
          const rel = toPosixRel(absRoot, full);
          const syms = JS_TS_EXTS.has(ext) ? extractFileSymbolsWithRanges(ext, text) : [];
          const exportedSymbols = extractExportedSymbolNames(text);
          filesMap.set(rel, {
            relPath: rel,
            ext,
            text,
            mtimeMs: st.mtimeMs || 0,
            symbols: syms,
            exportedSymbols,
          });
        } catch {}
      }
    }
  };

  walk(absRoot);
  return filesMap;
}

function extractExportedSymbolNames(code = '') {
  const names = new Set();
  const re = /export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z0-9_$]+)/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    if (m[1]) names.add(m[1]);
  }
  const namedRe = /export\s*\{([^}]+)\}/g;
  while ((m = namedRe.exec(code)) !== null) {
    for (const part of m[1].split(',')) {
      const clean = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (clean && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(clean)) names.add(clean);
    }
  }
  return Array.from(names);
}

function getEntryText(entry) {
  if (!entry) return '';
  if (typeof entry === 'string') return entry;
  if (typeof entry.text === 'string') return entry.text;
  if (Buffer.isBuffer(entry.buf)) return entry.buf.toString('utf8');
  return '';
}

const REGEX_PREFIX_KEYWORDS = new Set([
  'return',
  'throw',
  'case',
  'default',
  'delete',
  'void',
  'typeof',
  'await',
  'yield',
  'in',
  'of',
  'instanceof',
  'new',
  'else',
  'do',
]);

const NON_IMPORT_CLAUSE_KEYWORDS = new Set([
  'function',
  'class',
  'const',
  'let',
  'var',
  'return',
  'if',
  'for',
  'while',
  'switch',
  'try',
  'throw',
  'import',
  'export',
]);

/**
 * Lightweight single-pass JS/TS lexer that skips comments, regex literals,
 * and static template literal bodies while preserving `${...}` expressions
 * and string literals so fake imports inside strings never trigger false positives.
 */
function createJsImportLexer(rawCode = '') {
  const code = String(rawCode || '').replace(/^#![^\r\n]*/, '');
  const len = code.length;
  let i = 0;
  let canRegex = true;
  const tplStack = [];
  let pushed = null;

  const consumeTemplateBody = () => {
    while (i < len) {
      const ch = code[i];
      if (ch === '\\' && i + 1 < len) {
        i += 2;
        continue;
      }
      if (ch === '`') {
        i += 1;
        canRegex = false;
        return { type: 'tpl', value: '`' };
      }
      if (ch === '$' && i + 1 < len && code[i + 1] === '{') {
        i += 2;
        tplStack.push(0);
        canRegex = true;
        return { type: 'punct', value: '${' };
      }
      i += 1;
    }
    canRegex = false;
    return null;
  };

  const readNext = () => {
    while (i < len) {
      const ch = code[i];
      const next = i + 1 < len ? code[i + 1] : '';

      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v') {
        i += 1;
        continue;
      }
      if (ch === '/' && next === '/') {
        i += 2;
        while (i < len && code[i] !== '\n' && code[i] !== '\r') i += 1;
        continue;
      }
      if (ch === '/' && next === '*') {
        i += 2;
        while (i < len && !(code[i] === '*' && code[i + 1] === '/')) i += 1;
        i = Math.min(len, i + 2);
        continue;
      }
      if (ch === "'" || ch === '"') {
        const q = ch;
        i += 1;
        const start = i;
        let end = i;
        while (i < len) {
          const sc = code[i];
          if (sc === '\\' && i + 1 < len) {
            i += 2;
            end = i;
            continue;
          }
          if (sc === q) {
            end = i;
            i += 1;
            break;
          }
          if (sc === '\n' || sc === '\r') {
            end = i;
            break;
          }
          i += 1;
          end = i;
        }
        canRegex = false;
        return { type: 'str', value: code.slice(start, end) };
      }
      if (ch === '`') {
        i += 1;
        const tplTok = consumeTemplateBody();
        if (tplTok) return tplTok;
        continue;
      }
      if (ch === '/' && canRegex) {
        i += 1;
        let inClass = false;
        while (i < len) {
          const rc = code[i];
          if (rc === '\n' || rc === '\r') break;
          if (rc === '\\' && i + 1 < len) {
            i += 2;
            continue;
          }
          if (rc === '[') inClass = true;
          else if (rc === ']') inClass = false;
          else if (rc === '/' && !inClass) {
            i += 1;
            while (i < len && /[a-zA-Z]/.test(code[i])) i += 1;
            break;
          }
          i += 1;
        }
        canRegex = false;
        return { type: 'regex', value: '/' };
      }
      if (tplStack.length > 0 && ch === '}') {
        const depth = tplStack[tplStack.length - 1];
        if (depth === 0) {
          tplStack.pop();
          i += 1;
          const resumed = consumeTemplateBody();
          if (resumed) return resumed;
          continue;
        }
        tplStack[tplStack.length - 1] = depth - 1;
        i += 1;
        canRegex = true;
        return { type: 'punct', value: '}' };
      }
      if (tplStack.length > 0 && ch === '{') {
        tplStack[tplStack.length - 1] += 1;
        i += 1;
        canRegex = true;
        return { type: 'punct', value: '{' };
      }
      if (/[A-Za-z_$]/.test(ch)) {
        const start = i;
        i += 1;
        while (i < len && /[A-Za-z0-9_$]/.test(code[i])) i += 1;
        const value = code.slice(start, i);
        canRegex = REGEX_PREFIX_KEYWORDS.has(value);
        return { type: 'id', value };
      }
      if (/[0-9]/.test(ch)) {
        i += 1;
        while (i < len && /[0-9a-fA-FxXoObBnNeE_.]/.test(code[i])) i += 1;
        canRegex = false;
        return { type: 'num', value: '0' };
      }
      if (ch === '=' && next === '>') {
        i += 2;
        canRegex = true;
        return { type: 'punct', value: '=>' };
      }
      if (ch === '?' && next === '.') {
        i += 2;
        canRegex = false;
        return { type: 'punct', value: '?.' };
      }
      i += 1;
      canRegex = '([{,;:=!&|?+~^*-/%<>}'.includes(ch);
      return { type: 'punct', value: ch };
    }
    return null;
  };

  return {
    next() {
      if (pushed) {
        const tok = pushed;
        pushed = null;
        return tok;
      }
      return readNext();
    },
    peek() {
      if (!pushed) pushed = readNext();
      return pushed;
    },
    pushBack(tok) {
      if (tok) pushed = tok;
    },
  };
}

function isRelativeImportSpec(spec = '') {
  return typeof spec === 'string' && (spec.startsWith('./') || spec.startsWith('../'));
}

function scanFromClauseSpec(lexer, initialBraceDepth = 0) {
  let braceDepth = initialBraceDepth;
  while (true) {
    const cur = lexer.next();
    if (!cur) return '';
    if (cur.type === 'punct' && cur.value === '{') {
      braceDepth += 1;
      continue;
    }
    if (cur.type === 'punct' && cur.value === '}') {
      if (braceDepth > 0) braceDepth -= 1;
      else return '';
      continue;
    }
    if (braceDepth === 0) {
      if (cur.type === 'id' && cur.value === 'from' && lexer.peek()?.type === 'str') {
        return lexer.next().value;
      }
      if (cur.type === 'punct' && (cur.value === ';' || cur.value === '=' || cur.value === '(' || cur.value === ')' || cur.value === ':')) {
        lexer.pushBack(cur);
        return '';
      }
      if (cur.type === 'id' && NON_IMPORT_CLAUSE_KEYWORDS.has(cur.value)) {
        lexer.pushBack(cur);
        return '';
      }
    }
  }
}

export function extractRelativeImportSpecs(code = '') {
  const specs = [];
  const lexer = createJsImportLexer(code);
  let prevTok = null;

  while (true) {
    const tok = lexer.next();
    if (!tok) break;

    const isPropAccess = prevTok && prevTok.type === 'punct' && (prevTok.value === '.' || prevTok.value === '?.');
    if (tok.type === 'id' && !isPropAccess && (tok.value === 'import' || tok.value === 'export')) {
      const next = lexer.peek();
      if (!next) break;
      if (next.type === 'punct' && (next.value === ':' || next.value === '.' || next.value === ';')) {
        prevTok = tok;
        continue;
      }

      if (tok.value === 'import') {
        if (next.type === 'str') {
          const strTok = lexer.next();
          if (isRelativeImportSpec(strTok.value)) specs.push(strTok.value);
          prevTok = strTok;
          continue;
        }
        if (next.type === 'punct' && next.value === '(') {
          lexer.next();
          const arg = lexer.peek();
          if (arg && arg.type === 'str') {
            const strTok = lexer.next();
            const after = lexer.peek();
            if (after && after.type === 'punct' && (after.value === ')' || after.value === ',')) {
              if (isRelativeImportSpec(strTok.value)) specs.push(strTok.value);
            }
            prevTok = strTok;
            continue;
          }
          prevTok = next;
          continue;
        }
        if (next.type === 'id' || (next.type === 'punct' && (next.value === '*' || next.value === '{'))) {
          const firstClause = lexer.next();
          const initDepth = firstClause.type === 'punct' && firstClause.value === '{' ? 1 : 0;
          const spec = scanFromClauseSpec(lexer, initDepth);
          if (isRelativeImportSpec(spec)) specs.push(spec);
          prevTok = null;
          continue;
        }
      } else {
        // export re-exports only appear with *, {, or type */{
        let enterReExport = next.type === 'punct' && (next.value === '*' || next.value === '{');
        if (!enterReExport && next.type === 'id' && next.value === 'type') {
          lexer.next();
          const afterType = lexer.peek();
          if (afterType && afterType.type === 'punct' && (afterType.value === '*' || afterType.value === '{')) {
            enterReExport = true;
          } else {
            prevTok = next;
            continue;
          }
        }
        if (enterReExport) {
          const firstClause = lexer.next();
          const initDepth = firstClause.type === 'punct' && firstClause.value === '{' ? 1 : 0;
          const spec = scanFromClauseSpec(lexer, initDepth);
          if (isRelativeImportSpec(spec)) specs.push(spec);
          prevTok = null;
          continue;
        }
      }
    }

    prevTok = tok;
  }

  return specs;
}

function resolveRelativeImportExists(absRoot, fromRel, spec, filesMap) {
  const cleanSpec = spec.split('?')[0].split('#')[0];
  const baseRel = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), cleanSpec)).replace(/\/+$/, '');
  const candidates = [
    baseRel,
    `${baseRel}.mjs`,
    `${baseRel}.js`,
    `${baseRel}.ts`,
    `${baseRel}.tsx`,
    `${baseRel}.jsx`,
    `${baseRel}.cjs`,
    `${baseRel}.json`,
    `${baseRel}/index.mjs`,
    `${baseRel}/index.js`,
    `${baseRel}/index.ts`,
    `${baseRel}/index.tsx`,
  ];
  if (/\.[cm]?js$/i.test(baseRel)) {
    const stem = baseRel.replace(/\.[cm]?js$/i, '');
    candidates.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.cts`);
  }
  for (const cand of candidates) {
    if (filesMap?.has(cand)) return true;
    try {
      if (existsSync(resolve(absRoot, cand))) return true;
    } catch {}
  }
  return false;
}

function filterLockfilesFromGitDiff(rawDiff = '') {
  if (!rawDiff) return { diffSlice: '', touchedFiles: [] };
  const chunks = rawDiff.split(/(?=^diff --git )/m);
  const kept = [];
  const touched = [];
  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    const headerMatch = chunk.match(/^diff --git a\/(.+?) b\/(.+?)$/m);
    const bFile = headerMatch ? headerMatch[2].trim() : '';
    if (
      bFile &&
      /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|Cargo\.lock|poetry\.lock|composer\.lock)$|\.lock$/i.test(
        bFile
      )
    ) {
      continue;
    }
    if (bFile && !touched.includes(bFile)) touched.push(bFile);
    kept.push(chunk);
  }
  return {
    diffSlice: kept.join('').slice(0, 12 * 1024),
    touchedFiles: touched,
  };
}

function tokenizeSpeculativeQuery(q = '') {
  const norm = String(q || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  const matches = norm.match(/[a-zа-яё0-9_./-]{2,}/gi) || [];
  return { norm, tokens: new Set(matches) };
}

function computeSetJaccard(a, b) {
  if (!a || !b || a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const item of a) {
    if (b.has(item)) inter += 1;
  }
  const union = a.size + b.size - inter;
  return union > 0 ? inter / union : 0;
}

function execFileWithAbort(bin, args, options = {}) {
  return new Promise((resolvePromise) => {
    let child = null;
    try {
      child = execFile(bin, args, options, (err, stdout, stderr) => {
        if (options.onChildExit) options.onChildExit(child);
        if (err) {
          const aborted = Boolean(err.name === 'AbortError' || err.code === 'ABORT_ERR' || options.signal?.aborted);
          resolvePromise({
            ok: false,
            aborted,
            stdout: String(stdout || ''),
            stderr: String(stderr || ''),
            error: err.message || 'Process failed',
          });
          return;
        }
        resolvePromise({
          ok: true,
          aborted: false,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
        });
      });
      if (options.onChildSpawn) options.onChildSpawn(child);
    } catch (err) {
      resolvePromise({
        ok: false,
        aborted: Boolean(options.signal?.aborted),
        stdout: '',
        stderr: '',
        error: err.message || 'Spawn failed',
      });
    }
  });
}

function defaultHealthRecord() {
  return {
    status: 'clean',
    errorCount: 0,
    warnCount: 0,
    cloneCount: 0,
    clonePairs: [],
    issues: [],
    coChangeAlerts: [],
    lastRunAt: null,
  };
}

function defaultBugBotRecord() {
  return {
    reviewedDiffHash: '',
    findingsCount: 0,
    findings: [],
    lastRunAt: null,
  };
}

function defaultShadowTestsRecord(enabled = false) {
  return {
    enabled: Boolean(enabled),
    lastStatus: 'idle',
    lastSummaryRu: '',
    lastRunAt: null,
  };
}

/**
 * Fast, zero-GPU reader of cached Sentinel status across processes (used by UI sidecar server).
 */
export function readCachedSentinelSnapshot(wsPath = '', stateOverride = null, { cacheDir = DEFAULT_CACHE_DIR } = {}) {
  const config = loadSentinelConfig(stateOverride);
  const wsKey = wsPath ? normWsKey(wsPath) : '';
  const wsHash = wsPath ? computeWsHash(wsPath) : '';

  const healthFile = join(cacheDir, 'sentinel-health.json');
  const bugBotFile = join(cacheDir, 'sentinel-bugbot.json');
  const runtimeFile = join(cacheDir, 'sentinel-runtime.json');
  const cardsFile = wsHash ? join(cacheDir, 'symbol-cards', `${wsHash}.json`) : '';

  const healthAll = safeReadJsonSync(healthFile, () => ({ workspaces: {} }), { selfHeal: false }) || { workspaces: {} };
  const bugBotAll = safeReadJsonSync(bugBotFile, () => ({ workspaces: {} }), { selfHeal: false }) || { workspaces: {} };
  const runtime = safeReadJsonSync(runtimeFile, () => ({}), { selfHeal: false }) || {};
  const cardsDoc = cardsFile && existsSync(cardsFile)
    ? safeReadJsonSync(cardsFile, () => ({ files: {} }), { selfHeal: false }) || { files: {} }
    : { files: {} };

  const pickWsEntry = (mapObj, fallbackFn) => {
    const map = mapObj && typeof mapObj === 'object' ? mapObj : {};
    if (wsKey && Object.hasOwn(map, wsKey)) return { ...fallbackFn(), ...map[wsKey] };
    const firstKey = Object.keys(map)[0];
    return firstKey ? { ...fallbackFn(), ...map[firstKey] } : fallbackFn();
  };

  const shadowGuard = pickWsEntry(healthAll.workspaces, defaultHealthRecord);
  const bugBot = pickWsEntry(bugBotAll.workspaces, defaultBugBotRecord);
  const rtWs = pickWsEntry(runtime.workspaces, () => ({ shadowTests: defaultShadowTestsRecord(config.sentinelShadowTests) }));
  const shadowTests = {
    ...defaultShadowTestsRecord(config.sentinelShadowTests),
    ...(rtWs.shadowTests || {}),
    enabled: Boolean(config.sentinelShadowTests),
  };

  const indexedFiles = cardsDoc?.files && typeof cardsDoc.files === 'object' ? Object.keys(cardsDoc.files).length : 0;
  const totalEligibleFiles = Math.max(indexedFiles, Number(cardsDoc?.totalEligibleFiles || 0));
  const coveragePct = totalEligibleFiles > 0 ? Math.min(100, Math.round((indexedFiles / totalEligibleFiles) * 100)) : 0;

  let state = 'idle';
  const now = Date.now();
  if (!config.sentinelEnabled) {
    state = 'disabled';
  } else if (runtime.state === 'working' && now - Number(runtime.stateTs || 0) < 35_000) {
    state = 'working';
  } else if (runtime.state === 'preempted' && now - Number(runtime.stateTs || 0) < 8_000) {
    state = 'preempted';
  }

  return {
    ok: true,
    enabled: Boolean(config.sentinelEnabled),
    config,
    state,
    currentTaskRu: state === 'working' ? String(runtime.currentTaskRu || '') : '',
    preemptedCount: Number(runtime.preemptedCount || 0),
    speculativeHits: Number(runtime.speculativeHits || 0),
    shadowGuard: {
      status: shadowGuard.status || 'clean',
      errorCount: Number(shadowGuard.errorCount || 0),
      warnCount: Number(shadowGuard.warnCount || 0),
      cloneCount: Number(shadowGuard.cloneCount || 0),
      clonePairs: Array.isArray(shadowGuard.clonePairs) ? shadowGuard.clonePairs : [],
      issues: Array.isArray(shadowGuard.issues) ? shadowGuard.issues : [],
      coChangeAlerts: Array.isArray(shadowGuard.coChangeAlerts) ? shadowGuard.coChangeAlerts : [],
      lastRunAt: shadowGuard.lastRunAt || null,
    },
    bugBot: {
      reviewedDiffHash: String(bugBot.reviewedDiffHash || ''),
      findingsCount: Number(bugBot.findingsCount || (Array.isArray(bugBot.findings) ? bugBot.findings.length : 0)),
      findings: Array.isArray(bugBot.findings) ? bugBot.findings : [],
      lastRunAt: bugBot.lastRunAt || null,
    },
    symbolCards: {
      indexedFiles,
      totalEligibleFiles,
      coveragePct,
      lastFile: String(cardsDoc?.lastFile || ''),
      lastRunAt: cardsDoc?.lastRunAt || null,
    },
    shadowTests,
  };
}

export class BackgroundSentinel {
  constructor({ cacheDir = '', stateOverride = null } = {}) {
    this._customCacheDir = cacheDir && cacheDir !== DEFAULT_CACHE_DIR ? String(cacheDir) : '';
    this.stateOverride = stateOverride;
    this.lastActivityTs = Date.now();
    this.lastPreemptTs = 0;
    this.preemptedCount = 0;
    this.speculativeHits = 0;
    this.currentState = 'idle';
    this.currentTaskRu = '';
    this.activeAbortController = null;
    this.activeChildProc = null;
    this.ramEngineRef = null;
    this.workspaces = new Map(); // wsKey -> { absRoot, dirtyFiles: Set, shadowGuardDirty, bugBotDirty, symbolCardsDirty, shadowTestsDirty, shadowDebounceTimer, specDebounceTimer, specDebounceSeq }
    this.syntaxSha1Cache = new Map(); // sha1 -> { valid, error }
    this.speculativeLru = new Map(); // lruKey -> { wsKey, normQuery, tokens, goldContextHint, semanticFiles, createdAt, buildLatencyMs }
    this.daemonTimer = null;
    this.tickInFlight = false;

    this._hydrateCountersFromDisk();
  }

  get cacheDir() {
    return this._customCacheDir || resolveTunnelCacheDir(PLUGIN_ROOT);
  }

  set cacheDir(val) {
    this._customCacheDir = val && val !== DEFAULT_CACHE_DIR ? String(val) : '';
  }

  _ensureCacheDirs() {
    if (!existsSync(this.cacheDir)) {
      mkdirSync(this.cacheDir, { recursive: true });
    }
    const cardsDir = join(this.cacheDir, 'symbol-cards');
    if (!existsSync(cardsDir)) {
      mkdirSync(cardsDir, { recursive: true });
    }
  }

  _hydrateCountersFromDisk() {
    try {
      const runtimeFile = join(this.cacheDir, 'sentinel-runtime.json');
      if (existsSync(runtimeFile)) {
        const rt = safeReadJsonSync(runtimeFile, () => ({}), { selfHeal: false }) || {};
        this.preemptedCount = Number(rt.preemptedCount || 0);
        this.speculativeHits = Number(rt.speculativeHits || 0);
      }
    } catch {}
  }

  _persistRuntimePatch(patchFn) {
    try {
      this._ensureCacheDirs();
      const runtimeFile = join(this.cacheDir, 'sentinel-runtime.json');
      updateJsonAtomicSync(
        runtimeFile,
        () => ({ state: 'idle', currentTaskRu: '', stateTs: 0, preemptedCount: 0, speculativeHits: 0, workspaces: {} }),
        (cur) => {
          const base = cur && typeof cur === 'object' ? cur : {};
          return patchFn({
            state: base.state || 'idle',
            currentTaskRu: base.currentTaskRu || '',
            stateTs: Number(base.stateTs || 0),
            preemptedCount: Math.max(this.preemptedCount, Number(base.preemptedCount || 0)),
            speculativeHits: Math.max(this.speculativeHits, Number(base.speculativeHits || 0)),
            workspaces: base.workspaces && typeof base.workspaces === 'object' ? { ...base.workspaces } : {},
          });
        }
      );
    } catch {}
  }

  _getConfig(extraOverride = null) {
    const mergedOverride =
      this.stateOverride || extraOverride
        ? { ...(this.stateOverride || {}), ...(extraOverride || {}) }
        : null;
    return loadSentinelConfig(mergedOverride);
  }

  _getOrCreateWsState(wsPath) {
    const absRoot = resolve(wsPath || process.cwd());
    const wsKey = normWsKey(absRoot);
    let st = this.workspaces.get(wsKey);
    if (!st) {
      st = {
        absRoot,
        wsKey,
        dirtyFiles: new Set(),
        lastEditedFiles: [],
        shadowGuardDirty: false,
        bugBotDirty: true,
        symbolCardsDirty: true,
        shadowTestsDirty: false,
        shadowDebounceTimer: null,
        specDebounceTimer: null,
        specDebounceSeq: 0,
      };
      this.workspaces.set(wsKey, st);
    }
    return st;
  }

  async _resolveWorkspaceFiles(absRoot, ramEngine = null) {
    const eng = ramEngine || this.ramEngineRef;
    if (eng) {
      try {
        let ws = typeof eng.getOrCreateWorkspace === 'function' ? eng.getOrCreateWorkspace(absRoot) : null;
        if (ws && ws.files && ws.files.size === 0 && typeof eng.warmWorkspaceAsync === 'function') {
          ws = await eng.warmWorkspaceAsync(absRoot, { startWatcher: false });
        }
        if (ws && ws.files && ws.files.size > 0) {
          return { ws, filesMap: ws.files };
        }
      } catch {}
    }
    return { ws: null, filesMap: scanWorkspaceFilesFallback(absRoot) };
  }

  _beginWorking(taskRu, abortController = null, taskEn = '') {
    this.currentState = 'working';
    this.currentTaskRu = taskRu;
    this.currentTaskEn = taskEn || taskRu;
    this.activeAbortController = abortController;
    this._persistRuntimePatch((cur) => ({
      ...cur,
      state: 'working',
      currentTaskRu: taskRu,
      currentTaskEn: this.currentTaskEn,
      stateTs: Date.now(),
      preemptedCount: this.preemptedCount,
      speculativeHits: this.speculativeHits,
    }));
  }

  _endWorking(ctrl) {
    if (this.activeAbortController === ctrl) {
      this.activeAbortController = null;
    }
    if (this.currentState === 'working') {
      this.currentState = 'idle';
      this.currentTaskRu = '';
      this.currentTaskEn = '';
      this._persistRuntimePatch((cur) => ({
        ...cur,
        state: 'idle',
        currentTaskRu: '',
        currentTaskEn: '',
        stateTs: Date.now(),
        preemptedCount: this.preemptedCount,
        speculativeHits: this.speculativeHits,
      }));
    }
  }

  /**
   * P0 Preemption: immediately aborts any in-flight background GPU call or shadow test runner (<5ms).
   */
  preempt(reason = 'foreground_p0') {
    this.lastActivityTs = Date.now();
    const hadLocalActive =
      this.currentState === 'working' ||
      Boolean(this.activeAbortController && !this.activeAbortController.signal.aborted) ||
      Boolean(this.activeChildProc);

    if (this.activeAbortController) {
      try {
        this.activeAbortController.abort(reason);
      } catch {}
      this.activeAbortController = null;
    }
    if (this.activeChildProc) {
      try {
        this.activeChildProc.kill();
      } catch {}
      this.activeChildProc = null;
    }

    const gpuRes = preemptBackgroundGpuWork(reason);
    const preemptedGpuCount = Number(gpuRes?.preemptedCount || 0);
    const preempted = hadLocalActive || preemptedGpuCount > 0;

    if (preempted) {
      this.preemptedCount += 1;
      this.currentState = 'preempted';
      this.lastPreemptTs = Date.now();
      this.currentTaskRu = '';
      this._persistRuntimePatch((cur) => ({
        ...cur,
        state: 'preempted',
        currentTaskRu: '',
        stateTs: this.lastPreemptTs,
        preemptedCount: this.preemptedCount,
        speculativeHits: this.speculativeHits,
      }));
    }

    return {
      ok: true,
      preempted,
      preemptedGpuCount,
      preemptedCount: this.preemptedCount,
    };
  }

  /**
   * Marks a workspace file dirty and schedules debounced Engine A (Shadow Guard, 2200ms idle).
   */
  notifyFileChanged(wsPath, relPath, ramEngine = null) {
    if (!wsPath) return;
    this.lastActivityTs = Date.now();
    if (ramEngine) this.ramEngineRef = ramEngine;

    const wsState = this._getOrCreateWsState(wsPath);
    const normRel = toPosixRel(wsState.absRoot, relPath);
    if (normRel && !isIgnoredRelPath(normRel)) {
      wsState.dirtyFiles.add(normRel);
      wsState.lastEditedFiles = [normRel, ...wsState.lastEditedFiles.filter((f) => f !== normRel)].slice(0, 8);
    }
    wsState.shadowGuardDirty = true;
    wsState.bugBotDirty = true;
    wsState.symbolCardsDirty = true;
    wsState.shadowTestsDirty = true;

    if (wsState.shadowDebounceTimer) {
      clearTimeout(wsState.shadowDebounceTimer);
    }
    wsState.shadowDebounceTimer = setTimeout(() => {
      wsState.shadowDebounceTimer = null;
      const cfg = this._getConfig();
      if (cfg.sentinelEnabled && cfg.sentinelShadowGuard) {
        this.runShadowGuardPass(wsState.absRoot, ramEngine || this.ramEngineRef).catch(() => {});
      }
    }, 2200);
    if (typeof wsState.shadowDebounceTimer.unref === 'function') {
      wsState.shadowDebounceTimer.unref();
    }
  }

  _checkSyntaxCached(relPath, ext, text) {
    const hash = sha1Hex(`${ext}::${text}`);
    const cached = this.syntaxSha1Cache.get(hash);
    if (cached) return cached;

    let result = { valid: true, error: '' };
    if (ext === '.json') {
      const base = path.posix.basename(relPath).toLowerCase();
      if (!base.startsWith('tsconfig') && !base.endsWith('.jsonc')) {
        try {
          JSON.parse(text);
        } catch (err) {
          result = { valid: false, error: `Invalid JSON in ${relPath}: ${err.message}` };
        }
      }
    } else if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
      const usesEsmOrAwait = ext === '.mjs' || /\b(?:import|export|await)\b/.test(text);
      if (!usesEsmOrAwait) {
        try {
          new vm.Script(text, { filename: relPath });
        } catch (err) {
          result = { valid: false, error: `SyntaxError in ${relPath}: ${err.message}` };
        }
      } else {
        try {
          execFileSync(process.execPath, ['--input-type=module', '--check'], {
            input: text,
            encoding: 'utf8',
            timeout: 1500,
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
        } catch (err) {
          const stderr = String(err?.stderr || err?.message || '').trim();
          const firstErr =
            stderr
              .split(/\r?\n/)
              .map((l) => l.trim())
              .find((l) => /(?:SyntaxError|Error)/i.test(l)) ||
            stderr.split(/\r?\n/)[0] ||
            'Syntax error';
          result = { valid: false, error: `${relPath}: ${firstErr.slice(0, 200)}` };
        }
      }
    }

    if (this.syntaxSha1Cache.size > 256) {
      const firstKey = this.syntaxSha1Cache.keys().next().value;
      if (firstKey) this.syntaxSha1Cache.delete(firstKey);
    }
    this.syntaxSha1Cache.set(hash, result);
    return result;
  }

  /**
   * Engine A: Pure CPU+RAM Shadow Contract & Syntax Guard (0% GPU, 0 cloud tokens).
   */
  async runShadowGuardPass(wsPath, ramEngine = null) {
    const absRoot = resolve(wsPath || process.cwd());
    const wsState = this._getOrCreateWsState(absRoot);
    const { ws, filesMap } = await this._resolveWorkspaceFiles(absRoot, ramEngine);

    const issues = [];
    const coChangeAlerts = [];
    const dirtySet = new Set(wsState.dirtyFiles);
    const checkAllSyntax = filesMap.size <= 36;

    // 1. Syntax + Broken Relative Imports
    for (const [relPath, entry] of filesMap.entries()) {
      const ext = entry?.ext || extname(relPath).toLowerCase();
      const text = getEntryText(entry);
      if (!text) continue;

      if (ext === '.json' || checkAllSyntax || dirtySet.has(relPath) || !/\b(?:import|export|await)\b/.test(text)) {
        const syn = this._checkSyntaxCached(relPath, ext, text);
        if (!syn.valid) {
          issues.push({
            severity: 'error',
            type: 'syntax_error',
            file: relPath,
            detail: syn.error,
          });
          continue;
        }
      }

      if (JS_TS_EXTS.has(ext)) {
        const specs = extractRelativeImportSpecs(text);
        for (const spec of specs) {
          if (!resolveRelativeImportExists(absRoot, relPath, spec, filesMap)) {
            issues.push({
              severity: 'error',
              type: 'broken_import',
              file: relPath,
              detail: `Unresolved relative import "${spec}" in ${relPath}`,
            });
          }
        }
      }
    }

    // 2. Cross-File Function Arity & Destructured-Key Contracts
    const jsEntries = [];
    for (const [relPath, entry] of filesMap.entries()) {
      const ext = entry?.ext || extname(relPath).toLowerCase();
      if (JS_TS_EXTS.has(ext)) {
        jsEntries.push({ file: relPath, text: getEntryText(entry) });
      }
    }

    for (const item of jsEntries) {
      if (!item.text.includes('export ')) continue;
      const baseNoExt = path.posix.basename(item.file, extname(item.file));
      const revSet = ws?.reverseDeps?.get?.(item.file);
      const dependentEntries = jsEntries.filter((other) => {
        if (other.file === item.file) return false;
        if (revSet && revSet.has(other.file)) return true;
        return other.text.includes(baseNoExt) && other.text.includes('import ');
      });
      if (dependentEntries.length === 0) continue;

      const contractRes = verifyExportArityAndKeyContracts(item.file, item.text, dependentEntries);
      if (!contractRes.valid && Array.isArray(contractRes.issues)) {
        for (const cIss of contractRes.issues) {
          issues.push({
            severity: 'error',
            type: cIss.type || 'contract_mismatch',
            file: cIss.file || item.file,
            symbol: cIss.symbol || '',
            line: cIss.line || 1,
            detail: cIss.detail,
          });
        }
      }
    }

    // 3. Git Evolutionary Co-Change Partner Alerts (>= 0.75 confidence)
    if (dirtySet.size > 0 && existsSync(join(absRoot, '.git'))) {
      let gitDirtySet = new Set(dirtySet);
      try {
        const stOut = execFileSync('git', ['status', '--porcelain'], {
          cwd: absRoot,
          encoding: 'utf8',
          timeout: 1200,
          windowsHide: true,
        });
        for (const line of stOut.split(/\r?\n/)) {
          const f = line.slice(3).trim().replace(/\\/g, '/');
          if (f) gitDirtySet.add(f);
        }
      } catch {}

      for (const dirtyFile of dirtySet) {
        const coRes = queryCoChangePartners(absRoot, dirtyFile, {
          minConfidence: 0.75,
          minSupport: 2,
          topK: 4,
        });
        for (const p of coRes?.partners || []) {
          if (p.confidence >= 0.75 && !gitDirtySet.has(p.file)) {
            const pct = Math.round(p.confidence * 100);
            coChangeAlerts.push({
              file: dirtyFile,
              partnerFile: p.file,
              confidence: p.confidence,
              coCommits: p.coCommits,
              detailRu: `${dirtyFile} обычно меняется вместе с ${p.file} (${pct}%)`,
              detailEn: `${dirtyFile} usually changes together with ${p.file} (${pct}%)`,
            });
          }
        }
      }
    }

    // 4. SimHash Clone Count & Pair Details
    let cloneCount = 0;
    const clonePairs = [];
    try {
      const simIndex = buildWorkspaceSimHashIndex(filesMap);
      if (simIndex.size > 1) {
        const seenPairs = new Set();
        const probeFiles =
          dirtySet.size > 0
            ? Array.from(dirtySet).filter((f) => filesMap.has(f))
            : Array.from(simIndex.keys()).slice(0, 24);
        for (const f of probeFiles) {
          const text = getEntryText(filesMap.get(f));
          const dupRes = findNearDuplicateFunctions(simIndex, f, text);
          for (const cl of dupRes.clones || []) {
            const a = `${f}#${cl.symbol}`;
            const b = `${cl.targetFile}#${cl.targetSymbol}`;
            const pairKey = a < b ? `${a}<->${b}` : `${b}<->${a}`;
            if (!seenPairs.has(pairKey)) {
              seenPairs.add(pairKey);
              if (clonePairs.length < 10) {
                const pct = Math.max(0, Math.min(100, Number(cl.similarityPct) || 0));
                clonePairs.push({
                  file: f,
                  symbol: cl.symbol || '',
                  line: Number(cl.line) || 1,
                  targetFile: cl.targetFile || '',
                  targetSymbol: cl.targetSymbol || '',
                  targetLine: Number(cl.targetLine) || 1,
                  similarityPct: pct,
                  detailRu: `Дубликат SimHash (${pct}%): ${f}#${cl.symbol} ↔ ${cl.targetFile}#${cl.targetSymbol}`,
                  detailEn: `SimHash duplicate (${pct}%): ${f}#${cl.symbol} ↔ ${cl.targetFile}#${cl.targetSymbol}`,
                });
              }
            }
          }
        }
        cloneCount = seenPairs.size;
      }
    } catch {}

    // 5. Cached LSP type/contract diagnostics (if LSP server active)
    try {
      const lspIssues = lspBridge.getCachedDiagnosticsForWorkspace(absRoot);
      for (const liss of lspIssues) {
        if (!issues.some((x) => x.file === liss.file && x.line === liss.line && x.detail === liss.detail)) {
          issues.push(liss);
        }
      }
    } catch {}

    const errorCount = issues.filter((i) => i.severity === 'error').length;
    const warnCount = issues.filter((i) => i.severity === 'warn').length + coChangeAlerts.length;
    const status = errorCount > 0 ? 'error' : warnCount > 0 ? 'warn' : 'clean';
    const record = {
      status,
      errorCount,
      warnCount,
      cloneCount,
      clonePairs,
      issues: issues.slice(0, 20),
      coChangeAlerts: coChangeAlerts.slice(0, 10),
      lastRunAt: new Date().toISOString(),
    };

    wsState.shadowGuardDirty = false;
    wsState.dirtyFiles.clear();

    this._ensureCacheDirs();
    const healthFile = join(this.cacheDir, 'sentinel-health.json');
    updateJsonAtomicSync(
      healthFile,
      () => ({ workspaces: {} }),
      (cur) => {
        const workspaces = cur?.workspaces && typeof cur.workspaces === 'object' ? { ...cur.workspaces } : {};
        workspaces[wsState.wsKey] = record;
        return { workspaces };
      }
    );

    return { ok: true, ...record };
  }

  /**
   * Returns '' when workspace has 0 deterministic errors (zero token bloat!).
   * Returns <= 3 compact lines when Shadow Guard detected deterministic errors.
   */
  formatSentinelAlertForPrompt(wsPath) {
    const cfg = this._getConfig();
    if (!cfg.sentinelEnabled || !cfg.sentinelShadowGuard || !wsPath) return '';

    const healthFile = join(this.cacheDir, 'sentinel-health.json');
    if (!existsSync(healthFile)) return '';
    const healthAll = safeReadJsonSync(healthFile, () => ({ workspaces: {} }), { selfHeal: false });
    const rec = healthAll?.workspaces?.[normWsKey(wsPath)];
    if (!rec || Number(rec.errorCount || 0) === 0 || !Array.isArray(rec.issues)) {
      return '';
    }

    const errIssues = rec.issues.filter((i) => i && i.severity === 'error');
    if (errIssues.length === 0) return '';

    const lines = [
      `🛡️ [Shadow Guard] ${errIssues.length} deterministic contract/syntax error(s) in workspace:`,
    ];
    for (const iss of errIssues.slice(0, 2)) {
      lines.push(`  - ${String(iss.detail || '').slice(0, 180)}`);
    }
    return lines.slice(0, 3).join('\n');
  }

  /**
   * Engine B: Idle Local GPU Diff Reviewer (Local BugBot) with SHA-256 diff deduplication.
   */
  async runIdleLocalBugBotPass(wsPath, ramEngine = null, opts = {}) {
    const cfg = this._getConfig(opts.cfgOverride);
    if ((!cfg.sentinelEnabled || !cfg.sentinelLocalBugBot) && !opts.force) {
      return { ok: false, skipped: true, findings: [] };
    }

    const absRoot = resolve(wsPath || process.cwd());
    const wsState = this._getOrCreateWsState(absRoot);
    let rawDiff = typeof opts.diffTextOverride === 'string' ? opts.diffTextOverride : '';

    if (!rawDiff && existsSync(join(absRoot, '.git'))) {
      const headRes = await execFileWithAbort('git', ['--no-pager', 'diff', '-U2', '--no-color', 'HEAD'], {
        cwd: absRoot,
        timeout: 2500,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
      });
      rawDiff = headRes.ok && headRes.stdout.trim() ? headRes.stdout : '';
      if (!rawDiff) {
        const idxRes = await execFileWithAbort('git', ['--no-pager', 'diff', '-U2', '--no-color'], {
          cwd: absRoot,
          timeout: 2500,
          maxBuffer: 2 * 1024 * 1024,
          windowsHide: true,
        });
        if (idxRes.ok) rawDiff = idxRes.stdout;
      }
    }

    const { diffSlice, touchedFiles } = filterLockfilesFromGitDiff(rawDiff);
    const bugBotFile = join(this.cacheDir, 'sentinel-bugbot.json');
    this._ensureCacheDirs();

    if (!diffSlice.trim()) {
      const cleanRec = {
        reviewedDiffHash: '',
        findingsCount: 0,
        findings: [],
        lastRunAt: new Date().toISOString(),
      };
      wsState.bugBotDirty = false;
      updateJsonAtomicSync(bugBotFile, () => ({ workspaces: {} }), (cur) => ({
        workspaces: { ...(cur?.workspaces || {}), [wsState.wsKey]: cleanRec },
      }));
      return { ok: true, ...cleanRec };
    }

    const diffHash = sha256Hex(diffSlice);
    const existingAll = safeReadJsonSync(bugBotFile, () => ({ workspaces: {} }), { selfHeal: false });
    const prevRec = existingAll?.workspaces?.[wsState.wsKey];
    if (!opts.force && prevRec && prevRec.reviewedDiffHash === diffHash) {
      wsState.bugBotDirty = false;
      return {
        ok: true,
        dedupSkipped: true,
        reviewedDiffHash: diffHash,
        findingsCount: Number(prevRec.findingsCount || 0),
        findings: Array.isArray(prevRec.findings) ? prevRec.findings : [],
        lastRunAt: prevRec.lastRunAt,
      };
    }

    // Gather 1-hop neighbor contracts from RAM index
    let neighborContracts = '';
    try {
      const { ws, filesMap } = await this._resolveWorkspaceFiles(absRoot, ramEngine);
      const contractLines = [];
      const neighborSet = new Set(touchedFiles);
      for (const tf of touchedFiles) {
        for (const fwd of ws?.forwardDeps?.get?.(tf) || []) neighborSet.add(fwd);
        for (const rev of ws?.reverseDeps?.get?.(tf) || []) neighborSet.add(rev);
      }
      for (const nf of Array.from(neighborSet).slice(0, 6)) {
        const entry = filesMap.get(nf);
        if (!entry) continue;
        const sigs = (entry.symbols || [])
          .slice(0, 8)
          .map((s) => s.signature || s.name)
          .filter(Boolean);
        if (sigs.length > 0) {
          contractLines.push(`${nf}: ${sigs.join('; ')}`);
        }
      }
      neighborContracts = contractLines.join('\n').slice(0, 1800);
    } catch {}

    const ac = new AbortController();
    this._beginWorking('Локальный BugBot: проверка git diff', ac, 'Local BugBot: reviewing git diff');
    try {
      const res = await reviewGitDiffHunkLocally({
        relPath: touchedFiles[0] || '',
        diffText: diffSlice,
        neighborContracts,
        timeoutMs: opts.timeoutMs || 12000,
        httpJsonFn: opts.httpJsonFn || null,
        cfgOverride: opts.cfgOverride || null,
        signal: ac.signal,
      });

      if (ac.signal.aborted || res?.aborted) {
        return { ok: false, aborted: true, findings: [] };
      }
      if (!res?.ok) {
        return { ok: false, aborted: false, findings: [], error: res?.error || 'BugBot failed' };
      }

      const savedRec = {
        reviewedDiffHash: diffHash,
        findingsCount: res.findings.length,
        findings: res.findings,
        lastRunAt: new Date().toISOString(),
      };
      wsState.bugBotDirty = false;
      updateJsonAtomicSync(bugBotFile, () => ({ workspaces: {} }), (cur) => ({
        workspaces: { ...(cur?.workspaces || {}), [wsState.wsKey]: savedRec },
      }));
      return { ok: true, ...savedRec };
    } finally {
      this._endWorking(ac);
    }
  }

  /**
   * Engine C: Incremental SHA-256 Bilingual Module Symbol Cards on idle GPU.
   */
  async runIdleSymbolCardsPass(wsPath, ramEngine = null, opts = {}) {
    const cfg = this._getConfig(opts.cfgOverride);
    if ((!cfg.sentinelEnabled || !cfg.sentinelSymbolCards) && !opts.force) {
      return { ok: false, skipped: true, indexedNow: 0 };
    }

    const absRoot = resolve(wsPath || process.cwd());
    const wsState = this._getOrCreateWsState(absRoot);
    const wsHash = computeWsHash(absRoot);
    this._ensureCacheDirs();
    const cardsFile = join(this.cacheDir, 'symbol-cards', `${wsHash}.json`);

    const { filesMap } = await this._resolveWorkspaceFiles(absRoot, ramEngine);
    const doc = safeReadJsonSync(cardsFile, () => ({ wsKey: wsState.wsKey, files: {} }), { selfHeal: true }) || {
      wsKey: wsState.wsKey,
      files: {},
    };
    const cachedFiles = doc.files && typeof doc.files === 'object' ? { ...doc.files } : {};

    const staleCandidates = [];
    let totalEligibleFiles = 0;

    for (const [relPath, entry] of filesMap.entries()) {
      const ext = entry?.ext || extname(relPath).toLowerCase();
      if (!ELIGIBLE_CARD_EXTS.has(ext) || isTestRelPath(relPath) || isIgnoredRelPath(relPath)) {
        continue;
      }
      const text = getEntryText(entry);
      if (!text.trim()) continue;
      totalEligibleFiles += 1;

      const sha256 = sha256Hex(text);
      const prev = cachedFiles[relPath];
      if (!prev || prev.sha256 !== sha256) {
        staleCandidates.push({
          relPath,
          text,
          sha256,
          exportedSymbols: Array.isArray(entry?.exportedSymbols)
            ? entry.exportedSymbols
            : extractExportedSymbolNames(text),
        });
      }
    }

    const maxFiles = Math.max(1, Math.min(20, Number(opts.maxFiles) || 2));
    const batch = staleCandidates.slice(0, maxFiles);

    if (batch.length === 0) {
      wsState.symbolCardsDirty = false;
      atomicWriteJsonSync(cardsFile, {
        wsKey: wsState.wsKey,
        totalEligibleFiles,
        lastFile: doc.lastFile || '',
        lastRunAt: doc.lastRunAt || new Date().toISOString(),
        files: cachedFiles,
      });
      return {
        ok: true,
        indexedNow: 0,
        indexedFiles: Object.keys(cachedFiles).length,
        totalEligibleFiles,
      };
    }

    const ac = new AbortController();
    this._beginWorking(
      `Индексация паспортов модулей (${batch[0].relPath})`,
      ac,
      `Indexing module symbol cards (${batch[0].relPath})`
    );
    let indexedNow = 0;
    let lastFile = doc.lastFile || '';
    let aborted = false;

    try {
      for (const item of batch) {
        if (ac.signal.aborted) {
          aborted = true;
          break;
        }
        const cardRes = await generateIdleModuleSymbolCard({
          relPath: item.relPath,
          codeText: item.text,
          exportedSymbols: item.exportedSymbols,
          timeoutMs: opts.timeoutMs || 9000,
          httpJsonFn: opts.httpJsonFn || null,
          cfgOverride: opts.cfgOverride || null,
          signal: ac.signal,
        });
        if (ac.signal.aborted || cardRes?.aborted) {
          aborted = true;
          break;
        }
        if (cardRes?.ok && cardRes.card) {
          cachedFiles[item.relPath] = {
            sha256: item.sha256,
            purposeRu: cardRes.card.purposeRu,
            purposeEn: cardRes.card.purposeEn,
            keyContracts: cardRes.card.keyContracts,
            updatedAt: new Date().toISOString(),
          };
          lastFile = item.relPath;
          indexedNow += 1;
        }
      }

      if (!aborted && staleCandidates.length <= batch.length && indexedNow === batch.length) {
        wsState.symbolCardsDirty = false;
      }

      atomicWriteJsonSync(cardsFile, {
        wsKey: wsState.wsKey,
        totalEligibleFiles,
        lastFile,
        lastRunAt: new Date().toISOString(),
        files: cachedFiles,
      });

      return {
        ok: !aborted,
        aborted,
        indexedNow,
        indexedFiles: Object.keys(cachedFiles).length,
        totalEligibleFiles,
      };
    } finally {
      this._endWorking(ac);
    }
  }

  /**
   * Scores cached Symbol Cards against bilingual RU/EN query stems.
   */
  searchSymbolCardsLexical(wsPath, query, { topK = 5 } = {}) {
    if (!wsPath || !query || !String(query).trim()) return [];
    const cardsFile = join(this.cacheDir, 'symbol-cards', `${computeWsHash(wsPath)}.json`);
    if (!existsSync(cardsFile)) return [];

    const doc = safeReadJsonSync(cardsFile, () => ({ files: {} }), { selfHeal: false });
    const filesObj = doc?.files && typeof doc.files === 'object' ? doc.files : {};
    const entries = Object.entries(filesObj);
    if (entries.length === 0) return [];

    const qInfo = expandQueryBilingualStems(query);
    const enConcepts = (qInfo?.allConcepts || []).filter((t) => t && t.length >= 2);
    const ruRawTokens = (String(query).toLowerCase().match(/[а-яё]{3,}/gi) || []).map((w) =>
      w.length >= 6 ? w.slice(0, w.length - 2) : w
    );
    const searchStems = Array.from(new Set([...enConcepts, ...ruRawTokens]));
    if (searchStems.length === 0) return [];

    const scored = [];
    for (const [file, card] of entries) {
      if (!card || typeof card !== 'object') continue;
      const fileLow = file.toLowerCase();
      const ruLow = String(card.purposeRu || '').toLowerCase();
      const enLow = String(card.purposeEn || '').toLowerCase();
      const contractsLow = String(card.keyContracts || '').toLowerCase();

      let score = 0;
      for (const stem of searchStems) {
        if (fileLow.includes(stem)) score += 3.0;
        if (contractsLow.includes(stem)) score += 2.5;
        if (enLow.includes(stem)) score += 2.0;
        if (ruLow.includes(stem)) score += 2.2;
      }
      if (score > 0) {
        scored.push({
          file,
          score: Number(score.toFixed(2)),
          purposeRu: String(card.purposeRu || ''),
          purposeEn: String(card.purposeEn || ''),
          keyContracts: String(card.keyContracts || ''),
        });
      }
    }

    scored.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
    return scored.slice(0, Math.max(1, Number(topK) || 5));
  }

  /**
   * Immediately warms speculative Gold Context + Symbol Card lexical boost into RAM LRU.
   */
  warmSpeculativeContextNow(wsPath, draftQuery, ramEngine = null) {
    const cfg = this._getConfig();
    if (!cfg.sentinelEnabled || !cfg.sentinelSpeculativeWarm) {
      return { ok: false, skipped: true };
    }
    const cleanDraft = String(draftQuery || '').trim();
    if (!wsPath || cleanDraft.length < 4) {
      return { ok: false, skipped: true };
    }

    const t0 = performance.now();
    const absRoot = resolve(wsPath);
    const wsKey = normWsKey(absRoot);
    const { norm, tokens } = tokenizeSpeculativeQuery(cleanDraft);
    const eng = ramEngine || this.ramEngineRef;

    const cardHits = this.searchSymbolCardsLexical(absRoot, cleanDraft, { topK: 3 });
    const pseudoSemanticHits = cardHits.map((c, idx) => ({
      file: c.file,
      score: Math.max(0.42, 0.78 - idx * 0.08),
      startLine: 1,
      endLine: 45,
    }));

    let formattedSlices = '';
    const semanticFiles = cardHits.map((c) => ({ file: c.file, score: c.score }));

    if (eng && typeof eng.buildHybridGoldContext === 'function') {
      try {
        const hybridRes = eng.buildHybridGoldContext(absRoot, cleanDraft, pseudoSemanticHits, {
          maxResults: 4,
          contextLines: 3,
        });
        if (hybridRes?.ok && hybridRes.formatted) {
          formattedSlices = hybridRes.formatted.slice(0, 1500);
          for (const r of hybridRes.results || []) {
            if (r?.file && !semanticFiles.some((sf) => sf.file === r.file)) {
              semanticFiles.push({ file: r.file, score: Number(r.score || 0.5) });
            }
          }
        }
      } catch {}
    }

    const cardLines = cardHits.map(
      (c) => `  • ${c.file}: ${c.purposeRu || c.purposeEn}${c.keyContracts ? ` [${c.keyContracts}]` : ''}`
    );

    if (!formattedSlices && cardLines.length === 0) {
      return { ok: false, empty: true };
    }

    const parts = ['⚡ [Speculative RAM Gold Context]'];
    if (cardLines.length > 0) {
      parts.push('📇 [Module Symbol Cards]:\n' + cardLines.join('\n'));
    }
    if (formattedSlices) {
      parts.push(formattedSlices);
    }

    const goldContextHint = parts.join('\n');
    const buildLatencyMs = Number((performance.now() - t0).toFixed(2));
    const lruKey = `${wsKey}::${norm}`;

    // Evict stale or overflow entries
    const now = Date.now();
    for (const [k, v] of this.speculativeLru.entries()) {
      if (now - v.createdAt > SPECULATIVE_TTL_MS) {
        this.speculativeLru.delete(k);
      }
    }
    if (this.speculativeLru.has(lruKey)) {
      this.speculativeLru.delete(lruKey);
    }
    while (this.speculativeLru.size >= SPECULATIVE_MAX_ENTRIES) {
      const oldest = this.speculativeLru.keys().next().value;
      if (!oldest) break;
      this.speculativeLru.delete(oldest);
    }

    this.speculativeLru.set(lruKey, {
      wsKey,
      normQuery: norm,
      tokens,
      goldContextHint,
      semanticFiles,
      createdAt: now,
      buildLatencyMs,
    });

    return { ok: true, goldContextHint, semanticFiles, latencyMs: buildLatencyMs };
  }

  /**
   * Engine D: Debounces 250ms while user types in composer, pre-warming Gold Context in RAM.
   */
  scheduleSpeculativeWarm(wsPath, draftQuery, ramEngine = null, { delayMs = 250 } = {}) {
    const cfg = this._getConfig();
    if (!cfg.sentinelEnabled || !cfg.sentinelSpeculativeWarm || !wsPath || !String(draftQuery || '').trim()) {
      return Promise.resolve({ ok: false, skipped: true });
    }
    if (ramEngine) this.ramEngineRef = ramEngine;

    const wsState = this._getOrCreateWsState(wsPath);
    if (wsState.specDebounceTimer) {
      clearTimeout(wsState.specDebounceTimer);
      wsState.specDebounceTimer = null;
    }
    const seq = ++wsState.specDebounceSeq;

    return new Promise((resolvePromise) => {
      const waitMs = Math.max(10, Number(delayMs) || 250);
      wsState.specDebounceTimer = setTimeout(() => {
        wsState.specDebounceTimer = null;
        if (seq !== wsState.specDebounceSeq) {
          resolvePromise({ ok: false, superseded: true });
          return;
        }
        const res = this.warmSpeculativeContextNow(wsState.absRoot, draftQuery, ramEngine || this.ramEngineRef);
        resolvePromise(res);
      }, waitMs);
      if (typeof wsState.specDebounceTimer.unref === 'function') {
        wsState.specDebounceTimer.unref();
      }
    });
  }

  /**
   * Engine D consumer: matches exact normalized query or token Jaccard >= 0.65 within 45s TTL.
   */
  consumeSpeculativeContext(wsPath, query) {
    if (!wsPath || !query || !String(query).trim()) {
      return { hit: false, goldContextHint: '', semanticFiles: [], latencyMs: 0 };
    }
    const wsKey = normWsKey(wsPath);
    const { norm, tokens } = tokenizeSpeculativeQuery(query);
    const now = Date.now();

    let bestKey = null;
    let bestEntry = null;
    let bestScore = 0;

    for (const [k, entry] of this.speculativeLru.entries()) {
      if (now - entry.createdAt > SPECULATIVE_TTL_MS) {
        this.speculativeLru.delete(k);
        continue;
      }
      if (entry.wsKey !== wsKey) continue;
      if (entry.normQuery === norm) {
        bestKey = k;
        bestEntry = entry;
        bestScore = 1;
        break;
      }
      const jac = computeSetJaccard(tokens, entry.tokens);
      if (jac >= 0.65 && jac > bestScore) {
        bestScore = jac;
        bestKey = k;
        bestEntry = entry;
      }
    }

    if (!bestEntry || !bestKey) {
      return { hit: false, goldContextHint: '', semanticFiles: [], latencyMs: 0 };
    }

    // Refresh LRU order
    this.speculativeLru.delete(bestKey);
    this.speculativeLru.set(bestKey, bestEntry);

    this.speculativeHits += 1;
    this._persistRuntimePatch((cur) => ({
      ...cur,
      preemptedCount: this.preemptedCount,
      speculativeHits: this.speculativeHits,
    }));

    return {
      hit: true,
      goldContextHint: bestEntry.goldContextHint,
      semanticFiles: bestEntry.semanticFiles,
      latencyMs: bestEntry.buildLatencyMs,
    };
  }

  /**
   * Engine E: Opt-In Idle Shadow Micro-Tests (runs ONLY when sentinelShadowTests === true or opts.force === true).
   */
  async runIdleShadowMicroTests(wsPath, opts = {}) {
    const cfg = this._getConfig(opts.cfgOverride);
    if (!cfg.sentinelShadowTests && !opts.force) {
      return {
        ok: true,
        skipped: true,
        enabled: false,
        lastStatus: 'disabled',
        lastSummaryRu: 'Фоновые микро-тесты выключены (opt-in)',
        lastSummaryEn: 'Shadow micro-tests are disabled (opt-in)',
      };
    }

    const absRoot = resolve(wsPath || process.cwd());
    const wsState = this._getOrCreateWsState(absRoot);

    let targetTests = Array.isArray(opts.testFiles)
      ? opts.testFiles.map((f) => resolve(absRoot, f)).filter((f) => existsSync(f))
      : [];

    if (targetTests.length === 0) {
      const candidateTargets = wsState.lastEditedFiles.length > 0 ? wsState.lastEditedFiles : [];
      const testsDir = join(absRoot, 'tests');
      for (const rel of candidateTargets) {
        const stem = path.posix.basename(rel, extname(rel));
        for (const ext of ['.test.mjs', '.test.js', '.spec.mjs', '.spec.js']) {
          const direct = join(testsDir, `${stem}${ext}`);
          if (existsSync(direct) && !targetTests.includes(direct)) {
            targetTests.push(direct);
          }
        }
      }
      if (targetTests.length === 0 && existsSync(testsDir)) {
        try {
          const allTestFiles = readdirSync(testsDir)
            .filter((n) => /\.(?:test|spec)\.(?:mjs|js)$/i.test(n))
            .map((n) => join(testsDir, n));
          if (allTestFiles.length > 0) {
            targetTests.push(allTestFiles[0]);
          }
        } catch {}
      }
    }

    if (targetTests.length === 0) {
      wsState.shadowTestsDirty = false;
      const idleRec = {
        enabled: Boolean(cfg.sentinelShadowTests),
        lastStatus: 'idle',
        lastSummaryRu: 'Подходящие микро-тесты не найдены',
        lastSummaryEn: 'No matching micro-tests found',
        lastRunAt: new Date().toISOString(),
      };
      this._saveShadowTestsState(wsState.wsKey, idleRec);
      return { ok: true, ...idleRec };
    }

    const ac = new AbortController();
    const shortName = path.basename(targetTests[0]);
    this._beginWorking(`Теневой прогон теста ${shortName}`, ac, `Shadow test run: ${shortName}`);

    try {
      const childEnv = { ...process.env };
      delete childEnv.NODE_TEST_CONTEXT;
      const runRes = await execFileWithAbort(
        process.execPath,
        ['--test', ...targetTests.slice(0, 2)],
        {
          cwd: absRoot,
          env: childEnv,
          signal: ac.signal,
          timeout: Math.max(250, Number(opts.timeoutMs) || 6000),
          windowsHide: true,
          onChildSpawn: (child) => {
            this.activeChildProc = child;
          },
          onChildExit: (child) => {
            if (this.activeChildProc === child) {
              this.activeChildProc = null;
            }
          },
        }
      );

      if (ac.signal.aborted || runRes.aborted) {
        const preemptRec = {
          enabled: Boolean(cfg.sentinelShadowTests),
          lastStatus: 'preempted',
          lastSummaryRu: `Прервано P0-задачей (${shortName})`,
          lastSummaryEn: `Preempted by P0 task (${shortName})`,
          lastRunAt: new Date().toISOString(),
        };
        this._saveShadowTestsState(wsState.wsKey, preemptRec);
        return { ok: false, aborted: true, ...preemptRec };
      }

      wsState.shadowTestsDirty = false;
      const status = runRes.ok ? 'pass' : 'fail';
      const errTail = String(runRes.stderr || runRes.stdout || runRes.error).trim().slice(0, 140);
      const summaryRu = runRes.ok
        ? `Пройдено: ${shortName}`
        : `Сбой в ${shortName}: ${errTail}`;
      const summaryEn = runRes.ok
        ? `Passed: ${shortName}`
        : `Failed in ${shortName}: ${errTail}`;
      const finalRec = {
        enabled: Boolean(cfg.sentinelShadowTests),
        lastStatus: status,
        lastSummaryRu: summaryRu,
        lastSummaryEn: summaryEn,
        lastRunAt: new Date().toISOString(),
      };
      this._saveShadowTestsState(wsState.wsKey, finalRec);
      return { ok: runRes.ok, ...finalRec };
    } finally {
      this.activeChildProc = null;
      this._endWorking(ac);
    }
  }

  _saveShadowTestsState(wsKey, shadowTestsRec) {
    this._persistRuntimePatch((cur) => {
      const workspaces = { ...(cur.workspaces || {}) };
      workspaces[wsKey] = {
        ...(workspaces[wsKey] || {}),
        shadowTests: shadowTestsRec,
      };
      return { ...cur, workspaces };
    });
  }

  /**
   * Returns complete live status snapshot matching UI & MCP contract.
   */
  getStatusSnapshot(wsPath = '', ramEngine = null) {
    const targetWs = wsPath || Array.from(this.workspaces.values())[0]?.absRoot || process.cwd();
    const snap = readCachedSentinelSnapshot(targetWs, this.stateOverride, { cacheDir: this.cacheDir });

    // Overlay freshest in-memory state & counters
    const cfg = snap.config;
    let liveState = 'idle';
    if (!cfg.sentinelEnabled) {
      liveState = 'disabled';
    } else if (this.currentState === 'working') {
      liveState = 'working';
    } else if (this.lastPreemptTs > 0 && Date.now() - this.lastPreemptTs < 8000) {
      liveState = 'preempted';
    }

    // If symbolCards haven't run yet but ramEngine has workspace loaded, surface eligible count accurately
    let { indexedFiles, totalEligibleFiles, coveragePct } = snap.symbolCards;
    const eng = ramEngine || this.ramEngineRef;
    if (totalEligibleFiles === 0 && eng && typeof eng.getOrCreateWorkspace === 'function') {
      try {
        const ws = eng.getOrCreateWorkspace(resolve(targetWs));
        if (ws?.files?.size > 0) {
          let elig = 0;
          for (const [rel, ent] of ws.files.entries()) {
            const ext = ent?.ext || extname(rel).toLowerCase();
            if (ELIGIBLE_CARD_EXTS.has(ext) && !isTestRelPath(rel) && !isIgnoredRelPath(rel)) {
              elig += 1;
            }
          }
          totalEligibleFiles = Math.max(indexedFiles, elig);
          coveragePct = totalEligibleFiles > 0 ? Math.min(100, Math.round((indexedFiles / totalEligibleFiles) * 100)) : 0;
        }
      } catch {}
    }

    return {
      ...snap,
      state: liveState,
      currentTaskRu: liveState === 'working' ? this.currentTaskRu : '',
      currentTaskEn: liveState === 'working' ? (this.currentTaskEn || this.currentTaskRu) : '',
      preemptedCount: Math.max(this.preemptedCount, snap.preemptedCount),
      speculativeHits: Math.max(this.speculativeHits, snap.speculativeHits),
      symbolCards: {
        ...snap.symbolCards,
        indexedFiles,
        totalEligibleFiles,
        coveragePct,
      },
    };
  }

  /**
   * Executes manual or IPC actions: 'run_now', 'clear_findings', 'speculative_warm', 'preempt'.
   */
  async runAction({
    action = 'run_now',
    mode = 'all',
    wsPath = '',
    query = '',
    force = false,
    ramEngine = null,
    httpJsonFn = null,
    cfgOverride = null,
    lang = 'ru',
  } = {}) {
    const resolvedLang = normalizeLang(lang, 'ru');
    const isEn = resolvedLang === 'en';
    const targetWs = resolve(wsPath || Array.from(this.workspaces.values())[0]?.absRoot || process.cwd());
    const wsKey = normWsKey(targetWs);
    if (ramEngine) this.ramEngineRef = ramEngine;

    if (action === 'preempt') {
      this.preempt('manual_action_preempt');
      return this.getStatusSnapshot(targetWs, ramEngine);
    }

    if (action === 'clear_findings') {
      this._ensureCacheDirs();
      const bugBotFile = join(this.cacheDir, 'sentinel-bugbot.json');
      updateJsonAtomicSync(bugBotFile, () => ({ workspaces: {} }), (cur) => {
        const prev = cur?.workspaces?.[wsKey] || defaultBugBotRecord();
        return {
          workspaces: {
            ...(cur?.workspaces || {}),
            [wsKey]: { ...prev, reviewedDiffHash: '', findingsCount: 0, findings: [] },
          },
        };
      });
      const healthFile = join(this.cacheDir, 'sentinel-health.json');
      updateJsonAtomicSync(healthFile, () => ({ workspaces: {} }), (cur) => {
        const prev = cur?.workspaces?.[wsKey] || defaultHealthRecord();
        const errCount = Number(prev.errorCount || 0);
        return {
          workspaces: {
            ...(cur?.workspaces || {}),
            [wsKey]: {
              ...prev,
              warnCount: 0,
              cloneCount: 0,
              clonePairs: [],
              coChangeAlerts: [],
              status: errCount > 0 ? 'error' : 'clean',
            },
          },
        };
      });
      return this.getStatusSnapshot(targetWs, ramEngine);
    }

    if (action === 'speculative_warm') {
      this.warmSpeculativeContextNow(targetWs, query, ramEngine || this.ramEngineRef);
      return this.getStatusSnapshot(targetWs, ramEngine);
    }

    if (action === 'prepare_commit') {
      const cfg = this._getConfig(cfgOverride);
      const sgRes = await this.runShadowGuardPass(targetWs, ramEngine || this.ramEngineRef);
      let rawDiff = '';
      let statusOut = '';
      try {
        statusOut = String(execFileSync('git', ['status', '--porcelain'], { cwd: targetWs, encoding: 'utf8', timeout: 4000, windowsHide: true }) || '');
      } catch {}
      try {
        rawDiff = String(execFileSync('git', ['diff', 'HEAD'], { cwd: targetWs, encoding: 'utf8', timeout: 5000, windowsHide: true }) || '');
      } catch {
        try {
          rawDiff = String(execFileSync('git', ['diff', '--cached'], { cwd: targetWs, encoding: 'utf8', timeout: 5000, windowsHide: true }) || '');
        } catch {}
      }
      const { diffSlice, touchedFiles } = filterLockfilesFromGitDiff(rawDiff);
      const changedFiles = touchedFiles.length > 0
        ? touchedFiles
        : statusOut.split(/\r?\n/).filter((l) => l.length >= 4).map((l) => l.slice(3).trim().replace(/^"|"$/g, '')).filter(Boolean);

      const blockers = [];
      const warnings = [];
      if (sgRes && Number(sgRes.errorCount || 0) > 0) {
        blockers.push(
          isEn
            ? `Syntax/type errors detected (${sgRes.errorCount})`
            : `Найдены ошибки синтаксиса/типов (${sgRes.errorCount})`
        );
      }
      // Scan added diff lines only for leaked tokens/keys
      const addedLines = diffSlice.split(/\r?\n/).filter((l) => /^\+[^+]/.test(l)).join('\n');
      const secretRx = /(?:ghp_[A-Za-z0-9]{16,}|sk-[A-Za-z0-9]{20,}|AIza[A-Za-z0-9_-]{20,}|-----BEGIN (?:RSA|EC|OPENSSH) PRIVATE KEY-----)/;
      if (secretRx.test(addedLines) || (addedLines && redactSecretsInText(addedLines) !== addedLines)) {
        blockers.push(
          isEn
            ? 'Possible secret key or token detected in diff (+ lines)'
            : 'Обнаружен возможный секретный ключ или токен в диффе (+ строки)'
        );
      }

      if (cfg.sentinelLocalBugBot !== false && diffSlice) {
        await this.runIdleLocalBugBotPass(targetWs, ramEngine || this.ramEngineRef, {
          force: Boolean(force),
          httpJsonFn,
          cfgOverride,
        });
      }
      const snap = this.getStatusSnapshot(targetWs, ramEngine);
      const bbFindings = Array.isArray(snap?.bugBot?.findings) ? snap.bugBot.findings : [];
      for (const bf of bbFindings) {
        const bfText = isEn ? (bf.issueEn || bf.issueRu || bf.file || 'risk') : (bf.issueRu || bf.issueEn || bf.file || 'риск');
        if (bf?.severity === 'high') blockers.push(`BugBot: ${bfText}`);
        else if (bf?.issueRu || bf?.issueEn) warnings.push(`BugBot: ${bfText}`);
      }
      if (Number(sgRes?.warnCount || 0) > 0) {
        warnings.push(
          isEn
            ? `Shadow Guard / contract warnings (${sgRes.warnCount})`
            : `Предупреждения Shadow Guard / контрактов (${sgRes.warnCount})`
        );
      }

      const commitMeta = await generateLocalCommitSummary({
        diffText: diffSlice || addedLines,
        changedFiles,
        issuesCount: blockers.length + warnings.length,
        httpJsonFn,
        cfgOverride,
        lang: resolvedLang,
      });

      const defaultMsg = changedFiles.length
        ? (isEn ? `chore: update ${changedFiles[0]}` : `chore: обновить ${changedFiles[0]}`)
        : '';
      const summaryRu = commitMeta?.summaryRu || commitMeta?.error || 'Изменения не обнаружены';
      const summaryEn = commitMeta?.summaryEn || commitMeta?.summaryRu || commitMeta?.error || 'No changes detected';

      return {
        ...snap,
        preCommit: {
          ok: true,
          readyToCommit: blockers.length === 0,
          blockers,
          warnings,
          changedFiles,
          commitMessage: commitMeta?.commitMessage || defaultMsg,
          summaryRu,
          summaryEn,
          viaGpu: Boolean(commitMeta?.viaGpu),
        },
      };
    }

    // Default: 'run_now'
    const cfg = this._getConfig(cfgOverride);
    const forceRun = Boolean(force);
    if ((mode === 'all' && cfg.sentinelShadowGuard !== false) || mode === 'shadow_guard') {
      await this.runShadowGuardPass(targetWs, ramEngine || this.ramEngineRef);
    }
    if ((mode === 'all' && cfg.sentinelSymbolCards !== false) || mode === 'symbol_cards') {
      await this.runIdleSymbolCardsPass(targetWs, ramEngine || this.ramEngineRef, {
        force: forceRun || mode === 'symbol_cards',
        httpJsonFn,
        cfgOverride,
      });
    }
    if ((mode === 'all' && cfg.sentinelLocalBugBot !== false) || mode === 'bugbot') {
      await this.runIdleLocalBugBotPass(targetWs, ramEngine || this.ramEngineRef, {
        force: forceRun || mode === 'bugbot',
        httpJsonFn,
        cfgOverride,
      });
    }
    if (mode === 'shadow_tests' || (mode === 'all' && cfg.sentinelShadowTests)) {
      await this.runIdleShadowMicroTests(targetWs, {
        force: forceRun || mode === 'shadow_tests',
        cfgOverride,
      });
    }

    return this.getStatusSnapshot(targetWs, ramEngine);
  }

  /**
   * Starts unref'd background daemon loop inside RAM MCP server checking idle thresholds.
   */
  startDaemonLoop(ramEngine = null, { intervalMs = 5000 } = {}) {
    if (ramEngine) this.ramEngineRef = ramEngine;
    this.stopDaemonLoop();

    const tick = async () => {
      if (this.tickInFlight) return;
      const cfg = this._getConfig();
      if (!cfg.sentinelEnabled) return;

      const idleLocalMs = Date.now() - this.lastActivityTs;
      const idleGpuMs = getMsSinceLastForegroundGpu();
      const effectiveIdleMs = Math.min(idleLocalMs, idleGpuMs);

      // Sync tracked workspaces from ramEngine if available
      if (this.ramEngineRef?.workspaces instanceof Map) {
        for (const wsObj of this.ramEngineRef.workspaces.values()) {
          if (wsObj?.absRoot) this._getOrCreateWsState(wsObj.absRoot);
        }
      }

      this.tickInFlight = true;
      try {
        for (const wsState of this.workspaces.values()) {
          if (Date.now() - this.lastActivityTs < 2500) break;

          if (effectiveIdleMs >= 2500 && cfg.sentinelShadowGuard && wsState.shadowGuardDirty) {
            await this.runShadowGuardPass(wsState.absRoot, this.ramEngineRef);
            try {
              if (this.ramEngineRef?.repairIndex?.buckets) {
                knowledgeHub.saveRepairKvBuckets(wsState.absRoot, this.ramEngineRef.repairIndex.buckets);
              }
            } catch {}
          }

          if (
            Date.now() - this.lastActivityTs >= 15_000 &&
            getMsSinceLastForegroundGpu() >= 15_000
          ) {
            if (cfg.sentinelSymbolCards && wsState.symbolCardsDirty) {
              await this.runIdleSymbolCardsPass(wsState.absRoot, this.ramEngineRef, { maxFiles: 2 });
            }
            if (
              Date.now() - this.lastActivityTs >= 15_000 &&
              getMsSinceLastForegroundGpu() >= 15_000 &&
              cfg.sentinelLocalBugBot &&
              wsState.bugBotDirty
            ) {
              await this.runIdleLocalBugBotPass(wsState.absRoot, this.ramEngineRef);
            }
          }

          if (
            Date.now() - this.lastActivityTs >= 35_000 &&
            cfg.sentinelShadowTests &&
            wsState.shadowTestsDirty
          ) {
            await this.runIdleShadowMicroTests(wsState.absRoot);
          }
        }
      } catch {} finally {
        this.tickInFlight = false;
      }
    };

    this.daemonTimer = setInterval(tick, Math.max(500, Number(intervalMs) || 5000));
    if (typeof this.daemonTimer.unref === 'function') {
      this.daemonTimer.unref();
    }
    return this.daemonTimer;
  }

  stopDaemonLoop() {
    if (this.daemonTimer) {
      clearInterval(this.daemonTimer);
      this.daemonTimer = null;
    }
    for (const wsState of this.workspaces.values()) {
      if (wsState.shadowDebounceTimer) {
        clearTimeout(wsState.shadowDebounceTimer);
        wsState.shadowDebounceTimer = null;
      }
      if (wsState.specDebounceTimer) {
        clearTimeout(wsState.specDebounceTimer);
        wsState.specDebounceTimer = null;
      }
    }
  }
}

export const sentinel = new BackgroundSentinel();

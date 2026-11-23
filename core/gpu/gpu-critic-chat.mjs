/**
 * @file gpu-critic-chat.mjs
 * @description JS ref-bug lexer, diff critic, local RAG project chat, symbol cards, and hunk review.
 */

import { createHash } from 'node:crypto';
import https from 'node:https';
import path, { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactSecretsInText } from '../security-guard.mjs';
import {
  DEFAULT_GPU_CONFIG,
  clampInt,
  gpuRuntime,
  isLocalChatActive,
  loadGpuConfig,
  ollamaHttpJson,
  parseStrictBackgroundJson,
  recordGpuTelemetryPatch,
  registerBackgroundGpuController,
  stripReasoningTags,
} from './gpu-shared-state.mjs';
export { stripReasoningTags };
import {
  VRAM_CAP_TOLERANCE_MB,
  ensureOllamaRunning,
  estimateModelVramMb,
  evaluateGpuThermalAndLoadGuard,
  evaluateVramModelFit,
  getCachedOrFetchOllamaTagMap,
  isOllamaEmbedModel,
  normalizeOllamaTag,
  probeNvidiaGpu,
  reconcileLoadedModelsVram,
  unloadModelsExceedingBudget,
} from './gpu-vram-runtime.mjs';
import { ensureDistillCacheLoaded, getFreshDistillCacheEntry, setDistillCacheEntry } from './gpu-distill.mjs';
import {
  GROUNDING_FILE_PATH_RE,
  GROUNDING_GATED_TECH_ALIAS_TO_CANONICAL,
  GROUNDING_STANDARD_IDENTIFIERS_LOWER,
  buildKnownSymbolSet,
  extractCitedFilePathsFromText,
  extractTerminalIdentifierFromExpr,
  getPosixBasename,
  matchesKnownRepoFile,
  normalizeGroundingPosixPath,
  stripFileExt,
} from './gpu-composer-copilot.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const CRITIC_CODE_EXTS = new Set(['.js', '.mjs', '.cjs']);

const CRITIC_JS_KEYWORDS = new Set([
  'const', 'let', 'var', 'function', 'async', 'await', 'class', 'extends', 'import', 'from', 'as',
  'export', 'default', 'return', 'if', 'else', 'for', 'of', 'in', 'while', 'do', 'switch', 'case',
  'break', 'continue', 'try', 'catch', 'finally', 'throw', 'new', 'typeof', 'instanceof', 'delete',
  'void', 'yield', 'this', 'super', 'true', 'false', 'null', 'undefined', 'NaN', 'Infinity', 'static',
  'get', 'set', 'debugger', 'with',
]);

const CRITIC_GLOBALS = new Set([
  'globalThis', 'global', 'process', 'Buffer', 'console', 'Math', 'JSON', 'Object', 'Array', 'String',
  'Number', 'Boolean', 'Symbol', 'BigInt', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Promise', 'Error',
  'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'URIError', 'EvalError', 'AggregateError',
  'AssertionError', 'RegExp', 'Date', 'Intl', 'Reflect', 'Proxy', 'Atomics', 'SharedArrayBuffer',
  'ArrayBuffer', 'DataView', 'Int8Array', 'Uint8Array', 'Int16Array', 'Uint16Array', 'Int32Array',
  'Uint32Array', 'Float32Array', 'Float64Array', 'TextEncoder', 'TextDecoder', 'URL', 'URLSearchParams',
  'AbortController', 'AbortSignal', 'performance', 'fetch', 'setTimeout', 'clearTimeout', 'setInterval',
  'clearInterval', 'setImmediate', 'clearImmediate', 'queueMicrotask', 'structuredClone', 'atob', 'btoa',
  'crypto', 'Event', 'EventTarget', 'CustomEvent', 'Headers', 'Request', 'Response', 'FormData', 'Blob',
  'FileReader', 'WebSocket', 'Worker', 'window', 'document', 'navigator', 'localStorage', 'sessionStorage',
  'location', 'history', 'screen', 'requestAnimationFrame', 'cancelAnimationFrame', 'HTMLElement', 'Node',
  'Element', 'MutationObserver', 'ResizeObserver', 'IntersectionObserver', 'module', 'exports', 'require',
  '__dirname', '__filename', 'arguments', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURI',
  'decodeURI', 'encodeURIComponent', 'decodeURIComponent', 'eval', 'Function', 'SidecarApp',
]);

function stripJsCommentsStringsRegex(rawCode = '') {
  const code = String(rawCode || '').replace(/^#![^\r\n]*/, (m) => ' '.repeat(m.length));
  const out = [];
  const tplStack = [];
  const len = code.length;
  let i = 0;
  let lastSig = '';
  const pushBlank = (ch) => out.push(ch === '\n' ? '\n' : ' ');

  while (i < len) {
    const ch = code[i];
    const next = i + 1 < len ? code[i + 1] : '';

    if (tplStack.length > 0 && tplStack[tplStack.length - 1] === 0 && ch === '}') {
      tplStack.pop();
      out.push(' ');
      i++;
      while (i < len) {
        const tc = code[i];
        if (tc === '\\' && i + 1 < len) {
          pushBlank(tc);
          pushBlank(code[i + 1]);
          i += 2;
          continue;
        }
        if (tc === '`') {
          out.push(' ');
          lastSig = '`';
          i++;
          break;
        }
        if (tc === '$' && i + 1 < len && code[i + 1] === '{') {
          out.push(' ', ' ');
          tplStack.push(0);
          lastSig = '{';
          i += 2;
          break;
        }
        pushBlank(tc);
        i++;
      }
      continue;
    }

    if (ch === '/' && next === '/') {
      out.push(' ', ' ');
      i += 2;
      while (i < len && code[i] !== '\n') {
        out.push(' ');
        i++;
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      out.push(' ', ' ');
      i += 2;
      while (i < len && !(code[i] === '*' && i + 1 < len && code[i + 1] === '/')) {
        pushBlank(code[i]);
        i++;
      }
      if (i < len) {
        out.push(' ', ' ');
        i += 2;
      }
      continue;
    }
    if (ch === '\'' || ch === '"') {
      const q = ch;
      out.push(' ');
      i++;
      while (i < len) {
        if (code[i] === '\\' && i + 1 < len) {
          pushBlank(code[i]);
          pushBlank(code[i + 1]);
          i += 2;
          continue;
        }
        if (code[i] === q) {
          out.push(' ');
          i++;
          break;
        }
        pushBlank(code[i]);
        i++;
      }
      lastSig = q;
      continue;
    }
    if (ch === '`') {
      out.push(' ');
      i++;
      while (i < len) {
        if (code[i] === '\\' && i + 1 < len) {
          pushBlank(code[i]);
          pushBlank(code[i + 1]);
          i += 2;
          continue;
        }
        if (code[i] === '`') {
          out.push(' ');
          lastSig = '`';
          i++;
          break;
        }
        if (code[i] === '$' && i + 1 < len && code[i + 1] === '{') {
          out.push(' ', ' ');
          tplStack.push(0);
          lastSig = '{';
          i += 2;
          break;
        }
        pushBlank(code[i]);
        i++;
      }
      continue;
    }
    if (ch === '/') {
      const prevTail = out.slice(-16).join('');
      const isRegexAfterKeyword = /(?:^|[^a-zA-Z0-9_$])(?:return|throw|case|typeof|delete|void|yield|await|in|of|else)\s*$/.test(prevTail);
      const isRegexStart = !lastSig || '=(,:!&|?+~^;{}\n[<>*-'.includes(lastSig) || isRegexAfterKeyword;
      if (isRegexStart) {
        out.push(' ');
        i++;
        let inClass = false;
        while (i < len) {
          if (code[i] === '\\' && i + 1 < len) {
            out.push(' ', ' ');
            i += 2;
            continue;
          }
          if (code[i] === '\n') break;
          if (code[i] === '[') inClass = true;
          else if (code[i] === ']') inClass = false;
          else if (code[i] === '/' && !inClass) {
            out.push(' ');
            i++;
            while (i < len && /[a-z]/i.test(code[i])) {
              out.push(' ');
              i++;
            }
            break;
          }
          out.push(' ');
          i++;
        }
        lastSig = '/';
        continue;
      }
    }

    if (tplStack.length > 0) {
      if (ch === '{') tplStack[tplStack.length - 1] += 1;
      else if (ch === '}') tplStack[tplStack.length - 1] -= 1;
    }
    out.push(ch);
    if (!/\s/.test(ch)) lastSig = ch;
    i++;
  }
  return out.join('');
}

function collectDeclaredJsIdentifiers(strippedCode = '') {
  const declared = new Set();
  const addId = (id) => {
    if (id && !CRITIC_JS_KEYWORDS.has(id)) declared.add(id);
  };

  // Extract identifiers from parameter lists or LHS destructuring patterns (skipping nested default RHS expressions)
  const extractBindingNames = (chunk, { allowTopLevelComma = true } = {}) => {
    let lDepth = 0;
    let rhsDepth = 0;
    let inDefault = false;
    let buf = '';
    const flushBuf = () => {
      const ids = buf.match(/\b[a-zA-Z_$][a-zA-Z0-9_$]*\b/g) || [];
      for (const id of ids) addId(id);
      buf = '';
    };
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i];
      if (inDefault) {
        if (c === '{' || c === '[' || c === '(') rhsDepth++;
        else if (c === '}' || c === ']' || c === ')') {
          if (rhsDepth > 0) {
            rhsDepth--;
          } else {
            inDefault = false;
            lDepth = Math.max(0, lDepth - 1);
          }
        } else if (c === ',' && rhsDepth === 0 && (lDepth > 0 || allowTopLevelComma)) {
          inDefault = false;
          buf = '';
        }
        continue;
      }
      if (c === '{' || c === '[' || c === '(') {
        flushBuf();
        lDepth++;
        continue;
      }
      if (c === '}' || c === ']' || c === ')') {
        flushBuf();
        lDepth = Math.max(0, lDepth - 1);
        continue;
      }
      if (c === '=' && chunk[i + 1] !== '>') {
        flushBuf();
        inDefault = true;
        rhsDepth = 0;
        continue;
      }
      if (c === ',') {
        flushBuf();
        continue;
      }
      if (c === ':') {
        // Rename pattern `{ origKey: localAlias }`: discard origKey, keep localAlias
        buf = '';
        continue;
      }
      buf += c;
    }
    if (!inDefault) flushBuf();
  };

  for (const m of strippedCode.matchAll(/\b(?:function\s*\*?|class)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g)) {
    addId(m[1]);
  }
  for (const m of strippedCode.matchAll(/(?:^|\n)[ \t]*(?:static[ \t]+)?(?:async[ \t]+)?(?:get[ \t]+|set[ \t]+|\*[ \t]*)?([a-zA-Z_$][a-zA-Z0-9_$]*)[ \t]*\(/g)) {
    addId(m[1]);
  }
  for (const m of strippedCode.matchAll(/\bcatch\s*\(\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\)/g)) {
    addId(m[1]);
  }
  for (const m of strippedCode.matchAll(/(?:^|\n)\s*import\s+([\s\S]*?)\s+from\s+/g)) {
    const clause = m[1].replace(/\b[a-zA-Z_$][a-zA-Z0-9_$]*\s+as\s+/g, '');
    for (const id of clause.match(/\b[a-zA-Z_$][a-zA-Z0-9_$]*\b/g) || []) addId(id);
  }
  for (const m of strippedCode.matchAll(/(?:^|\n)\s*export\s*\{([\s\S]*?)\}\s*from\s+/g)) {
    const clause = m[1].replace(/\b[a-zA-Z_$][a-zA-Z0-9_$]*\s+as\s+/g, '');
    for (const id of clause.match(/\b[a-zA-Z_$][a-zA-Z0-9_$]*\b/g) || []) addId(id);
  }

  // Balanced scanner for const/let/var declarations (handles multi-line destructuring and comma-separated bindings)
  for (const m of strippedCode.matchAll(/\b(?:const|let|var)\s+/g)) {
    let idx = m.index + m[0].length;
    let depth = 0;
    const start = idx;
    const limit = Math.min(strippedCode.length, idx + 1500);
    while (idx < limit) {
      const c = strippedCode[idx];
      if (c === '{' || c === '[' || c === '(') depth++;
      else if (c === '}' || c === ']' || c === ')') {
        if (depth === 0) break;
        depth--;
      } else if (depth === 0) {
        if (c === ';') break;
        if (c === '\n' && !/[=,+\-*/?:&|({[\s]$/.test(strippedCode.slice(start, idx))) {
          // Stop if line already finished a simple declaration
          if (strippedCode.slice(start, idx).includes('=')) break;
        }
        if ((c === 'i' && strippedCode.slice(idx, idx + 2) === 'in' && !/[a-zA-Z0-9_$]/.test(strippedCode[idx - 1] || '') && !/[a-zA-Z0-9_$]/.test(strippedCode[idx + 2] || '')) ||
            (c === 'o' && strippedCode.slice(idx, idx + 2) === 'of' && !/[a-zA-Z0-9_$]/.test(strippedCode[idx - 1] || '') && !/[a-zA-Z0-9_$]/.test(strippedCode[idx + 2] || ''))) {
          break;
        }
      }
      idx++;
    }
    extractBindingNames(strippedCode.slice(start, idx));
  }

  // Balanced parameter-list scanner before `=>` or `{` (handles default calls like `rootDir = process.cwd()`)
  for (let i = 0; i < strippedCode.length; i++) {
    if (strippedCode[i] !== '(') continue;
    let depth = 1;
    let j = i + 1;
    const limit = Math.min(strippedCode.length, i + 800);
    while (j < limit && depth > 0) {
      if (strippedCode[j] === '(') depth++;
      else if (strippedCode[j] === ')') depth--;
      j++;
    }
    if (depth === 0) {
      const after = strippedCode.slice(j, j + 24);
      if (/^\s*(?:=>|\{)/.test(after)) {
        const prefix = strippedCode.slice(Math.max(0, i - 24), i);
        if (!/\b(?:if|while|for|switch|catch|with)\s*$/.test(prefix)) {
          extractBindingNames(strippedCode.slice(i + 1, j - 1));
        }
      }
    }
  }
  for (const m of strippedCode.matchAll(/\b([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=>/g)) {
    addId(m[1]);
  }

  return declared;
}

/**
 * Fast zero-LLM guard that checks newly added JS/MJS lines for undeclared identifier references
 * (such as accidental `ReferenceError: GPU_PULL_PID is not defined`).
 * @param {string} [oldText='']
 * @param {string} [newText='']
 * @param {string} [ext='.mjs']
 * @returns {{ ok: boolean, issues: string[] }}
 */
export function scanAddedIdentifiersForRefBugs(oldText = '', newText = '', ext = '.mjs') {
  const normExt = String(ext || '.mjs').toLowerCase();
  if (!CRITIC_CODE_EXTS.has(normExt) || !newText || typeof newText !== 'string') {
    return { ok: true, issues: [] };
  }

  const oldLinesSet = new Set(String(oldText || '').replace(/\r\n/g, '\n').split('\n'));
  const strippedFull = stripJsCommentsStringsRegex(newText);
  const declared = collectDeclaredJsIdentifiers(strippedFull);
  const strippedLines = strippedFull.split('\n');
  const rawNewLines = newText.replace(/\r\n/g, '\n').split('\n');

  const issues = [];
  const seenIssues = new Set();

  for (let i = 0; i < strippedLines.length; i++) {
    const rawLine = rawNewLines[i] ?? '';
    if (oldText && oldLinesSet.has(rawLine)) continue;

    const line = strippedLines[i];
    if (!line || !line.trim()) continue;
    if (/^\s*(?:import|export\s+\{)/.test(line)) continue;
    const prevLine = i > 0 ? strippedLines[i - 1] : '';
    const prevEndedWithDot = /(?:\?\.|\.)\s*$/.test(prevLine);

    const rx = /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\b/g;
    let m;
    while ((m = rx.exec(line)) !== null) {
      const id = m[1];
      if (id.length < 2 || CRITIC_JS_KEYWORDS.has(id) || CRITIC_GLOBALS.has(id) || declared.has(id)) {
        continue;
      }
      const before = line.slice(0, m.index);
      const after = line.slice(m.index + id.length);
      // Skip property access (`.foo`, `?.foo`, or continuation from previous line ending in `.`)
      if (/(?:\?\.|\.)\s*$/.test(before) || (prevEndedWithDot && !before.trim())) continue;
      // Skip object property key or switch/label even inside ternary branches (`? { key: val }`)
      if (/^\s*:(?!:)/.test(after)) {
        const lastQ = before.lastIndexOf('?');
        const lastScope = Math.max(before.lastIndexOf('{'), before.lastIndexOf(','), before.lastIndexOf('('));
        if (lastQ <= lastScope) continue;
      }
      // Skip destructured/alias keys (`foo as bar`)
      if (/^\s+as\b/.test(after)) continue;

      if (!seenIssues.has(id)) {
        seenIssues.add(id);
        issues.push(`Line ${i + 1}: "${id}" looks undeclared (potential ReferenceError)`);
        if (issues.length >= 5) break;
      }
    }
    if (issues.length >= 5) break;
  }

  return { ok: issues.length === 0, issues };
}

function extractEnclosingFunctionHeader(newText = '', firstAddedLineIdx = -1) {
  const lines = String(newText || '').replace(/\r\n/g, '\n').split('\n');
  if (lines.length === 0) return '';
  const startIdx = firstAddedLineIdx >= 0 ? Math.min(firstAddedLineIdx, lines.length - 1) : lines.length - 1;
  const fnRe = /(?:^|\s)(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+\w+\s*\([^)]*\)/;
  const methodRe = /^\s*(?:async\s+)?[a-zA-Z_$][a-zA-Z0-9_$]*\s*\([^)]*\)\s*\{/;
  const arrowRe = /^\s*(?:export\s+)?(?:const|let)\s+[a-zA-Z_$][a-zA-Z0-9_$]*\s*=\s*(?:async\s+)?\([^)]*\)\s*=>/;
  const minScan = Math.max(0, startIdx - 45);
  for (let i = startIdx; i >= minScan; i--) {
    const ln = lines[i] || '';
    if (!ln.trim()) continue;
    if (fnRe.test(ln) || arrowRe.test(ln) || (methodRe.test(ln) && !/^\s*(?:if|for|while|switch|catch)\b/.test(ln))) {
      return ln.trim().slice(0, 140);
    }
  }
  return '';
}

/**
 * Post-edit diff critic: runs instant CPU undeclared-reference guard first, then optionally
 * runs a compact local Ollama (gemma4:12b) bug check on the diff hunk when GPU is enabled.
 * @param {object} [params={}]
 */
export async function critiqueEditedDiffLocally({
  filePath = '',
  oldText = '',
  newText = '',
  timeoutMs = 1500,
  httpJsonFn = null,
  cfgOverride = null,
  useDistillCache = false,
  _bypassCache = false,
} = {}) {
  const ext = path.extname(String(filePath || '.mjs')).toLowerCase() || '.mjs';
  const refCheck = scanAddedIdentifiersForRefBugs(oldText, newText, ext);
  if (!refCheck.ok && refCheck.issues.length > 0) {
    return {
      ok: true,
      hasBug: true,
      source: 'cpu_ref_guard',
      issues: refCheck.issues,
      alert: `🔎 [Post-Edit Critic (${path.basename(filePath || 'file')})] ${refCheck.issues.join('; ')}`,
    };
  }

  const cfg = cfgOverride ? loadGpuConfig(cfgOverride) : loadGpuConfig();
  if (!cfg.gpuEnabled || cfg.gpuPostEditCritic === false || !newText) {
    return { ok: true, hasBug: false, source: 'cpu_ref_guard', issues: [], alert: '' };
  }

  const oldSet = new Set(String(oldText || '').replace(/\r\n/g, '\n').split('\n'));
  const newLines = String(newText).replace(/\r\n/g, '\n').split('\n');
  let firstAddedIdx = -1;
  const addedLines = [];
  for (let i = 0; i < newLines.length; i++) {
    if (!oldSet.has(newLines[i])) {
      if (firstAddedIdx === -1) firstAddedIdx = i;
      addedLines.push(newLines[i]);
      if (addedLines.length >= 40) break;
    }
  }
  const added = addedLines.join('\n');
  if (!added || added.length < 15) {
    return { ok: true, hasBug: false, source: 'skipped', issues: [], alert: '' };
  }

  const callHttp = httpJsonFn || ollamaHttpJson;
  const cachedTags = gpuRuntime.ollamaTagsCache.map.size > 0 ? gpuRuntime.ollamaTagsCache.map : null;
  const fit = evaluateVramModelFit({ cfg, tagModels: cachedTags });
  let chatModel = '';
  if (fit.selectedSizeFits) {
    chatModel = cfg.gpuChatModel;
  } else if (fit.bestFallbackChatModel) {
    chatModel = fit.bestFallbackChatModel;
  } else if (httpJsonFn) {
    chatModel = cfg.gpuChatModel || 'qwen3:4b';
  } else if (fit.chatVramBudgetMb >= 2600) {
    chatModel = 'qwen3:4b';
  }
  if (!chatModel) {
    return { ok: true, hasBug: false, source: 'vram_cap_skip', issues: [], alert: '' };
  }

  const targetTag = normalizeOllamaTag(chatModel);
  const allowCache = !_bypassCache && (!httpJsonFn || useDistillCache);
  const criticKey = allowCache
    ? `critic:${createHash('sha1').update(`${targetTag}|${filePath}|${added}`).digest('hex')}`
    : '';
  if (allowCache) {
    ensureDistillCacheLoaded();
    const cached = getFreshDistillCacheEntry(criticKey);
    if (cached && cached.kind === 'critic' && cached.res) {
      recordGpuTelemetryPatch((cur) => ({
        ...cur,
        distillCacheHits: (cur.distillCacheHits || 0) + 1,
      }));
      return { ...cached.res, fromRamCache: true };
    }
  }

  const scopeHeader = extractEnclosingFunctionHeader(newText, firstAddedIdx);
  const codeBlock = scopeHeader && !added.includes(scopeHeader)
    ? `// Enclosing scope: ${scopeHeader}\n${added}`
    : added;

  const criticSchema = {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['OK', 'BUG'] },
      issue: { type: 'string' },
    },
    required: ['status', 'issue'],
    additionalProperties: false,
  };
  const prompt = [
    `Review ONLY these added code lines in ${path.basename(filePath || 'file')} for obvious runtime bugs (missing await, wrong arg order, memory/timer leak, undefined variable).`,
    !httpJsonFn
      ? 'Output strict JSON: {"status":"OK","issue":""} if clean, or {"status":"BUG","issue":"<1 short sentence>"} if there is a real bug.'
      : 'Reply strictly with "OK" if clean, or "BUG: <1 short sentence>" if there is a real bug.',
    '```',
    codeBlock.slice(0, 1800),
    '```',
  ].join('\n');

  try {
    const criticBody = {
      model: chatModel,
      stream: false,
      think: false,
      keep_alive: cfg.gpuKeepAlive,
      ...(!httpJsonFn ? { format: criticSchema } : {}),
      messages: [{ role: 'user', content: prompt }],
      options: { temperature: 0.05, num_predict: 96, num_ctx: 4096 },
    };
    const effectiveCriticTimeout = Math.max(400, Number(timeoutMs) || 1500);
    let res = await callHttp('POST', '/api/chat', criticBody, effectiveCriticTimeout, cfg.gpuEndpoint);
    if (!res?.ok && Object.hasOwn(criticBody, 'format') && /format|schema/i.test(String(res?.error || ''))) {
      const plainBody = { ...criticBody };
      delete plainBody.format;
      res = await callHttp('POST', '/api/chat', plainBody, effectiveCriticTimeout, cfg.gpuEndpoint);
    }
    const reply = String(res?.data?.message?.content || res?.data?.response || '').trim();
    let bugDetected = false;
    let cleanIssue = '';
    const jsonCandidate = reply.match(/\{[\s\S]*\}/);
    if (jsonCandidate) {
      try {
        const parsed = JSON.parse(jsonCandidate[0]);
        if (String(parsed?.status || '').toUpperCase() === 'BUG' && String(parsed?.issue || '').trim()) {
          bugDetected = true;
          cleanIssue = String(parsed.issue).trim().slice(0, 180);
        }
      } catch {}
    }
    if (!bugDetected && /^BUG\s*:/i.test(reply)) {
      bugDetected = true;
      cleanIssue = reply.replace(/^BUG\s*:\s*/i, '').trim().slice(0, 180);
    }
    if (bugDetected && cleanIssue) {
      const bugOut = {
        ok: true,
        hasBug: true,
        source: chatModel,
        issues: [cleanIssue],
        alert: `🔎 [GPU Diff Critic (${chatModel})] ${cleanIssue}`,
      };
      if (allowCache && res?.ok) {
        setDistillCacheEntry(criticKey, { kind: 'critic', ts: Date.now(), res: bugOut });
      }
      return bugOut;
    }
    const cleanOut = { ok: true, hasBug: false, source: chatModel, issues: [], alert: '' };
    if (allowCache && res?.ok) {
      setDistillCacheEntry(criticKey, { kind: 'critic', ts: Date.now(), res: cleanOut });
    }
    return cleanOut;
  } catch {}

  return { ok: true, hasBug: false, source: chatModel, issues: [], alert: '' };
}

function estimateTokensApprox(str = '') {
  const s = String(str || '');
  return s ? Math.ceil(s.length / 3.2) : 0;
}

function capStringByCharsOnLine(str = '', maxChars = 0) {
  const text = String(str || '');
  const limit = Math.max(0, Math.floor(Number(maxChars) || 0));
  if (!text || limit <= 0) return '';
  if (text.length <= limit) return text;
  const slice = text.slice(0, limit);
  const lastNl = slice.lastIndexOf('\n');
  return (lastNl > Math.floor(limit * 0.5) ? slice.slice(0, lastNl) : slice).trimEnd();
}

// stripReasoningTags moved to ./gpu-shared-state.mjs to prevent circular import

function extractRagRangesByFile(ragSources = [], ragContext = '', knownFilesNorm = []) {
  const rangesByFile = new Map();
  const addRange = (rawFile, startLine, endLine) => {
    const norm = normalizeGroundingPosixPath(rawFile);
    const s = Number(startLine);
    const e = Number(endLine || startLine);
    if (!norm || !Number.isFinite(s) || s < 1) return;
    const key = norm.toLowerCase();
    const list = rangesByFile.get(key) || [];
    list.push({ start: s, end: Math.max(s, Number.isFinite(e) ? e : s) });
    rangesByFile.set(key, list);
  };

  for (const src of Array.isArray(ragSources) ? ragSources : []) {
    if (src && typeof src === 'object' && src.file && src.startLine) {
      addRange(src.file, src.startLine, src.endLine || src.startLine);
    }
  }

  // Parse `### \`file\` [L10-L40]` and manifest `- \`file\` ... [L10-L40]` ranges
  const ctxLines = String(ragContext || '').split(/\r?\n/);
  for (const line of ctxLines) {
    const headerMatch = /^#{2,4}\s*`([^`]+)`\s*\[L(\d+)(?:-L?(\d+))?\]/i.exec(line.trim());
    if (headerMatch) {
      addRange(headerMatch[1], headerMatch[2], headerMatch[3] || headerMatch[2]);
      continue;
    }
    const manifestMatch = /^-\s*`([^`]+)`/.exec(line.trim());
    if (manifestMatch) {
      const mFile = manifestMatch[1];
      for (const lm of line.matchAll(/\[L(\d+)(?:-L?(\d+))?\]/gi)) {
        addRange(mFile, lm[1], lm[2] || lm[1]);
      }
    }
  }

  // Also index by basename for unambiguous short-path matching
  const resolveRangesForCited = (citedFile) => {
    const citedNorm = normalizeGroundingPosixPath(citedFile).toLowerCase();
    if (rangesByFile.has(citedNorm)) return rangesByFile.get(citedNorm);
    const citedBase = getPosixBasename(citedNorm);
    const matched = [];
    for (const [k, list] of rangesByFile.entries()) {
      if (
        (citedNorm.includes('/') && k.endsWith(`/${citedNorm}`)) ||
        (!citedNorm.includes('/') && getPosixBasename(k) === citedBase) ||
        (k.includes('/') && k === citedNorm)
      ) {
        matched.push(...list);
      }
    }
    if (matched.length === 0 && knownFilesNorm.length > 0) {
      for (const kf of knownFilesNorm) {
        const kfLow = kf.toLowerCase();
        if (rangesByFile.has(kfLow) && getPosixBasename(kfLow) === citedBase) {
          matched.push(...rangesByFile.get(kfLow));
        }
      }
    }
    return matched;
  };

  return { rangesByFile, resolveRangesForCited };
}

function extractRagSlicesTextByFile(ragContext = '') {
  const byFile = new Map();
  const lines = String(ragContext || '').split(/\r?\n/);
  let currentFile = '';
  let buf = [];
  const flush = () => {
    if (currentFile && buf.length > 0) {
      const prev = byFile.get(currentFile) || '';
      byFile.set(currentFile, `${prev}\n${buf.join('\n')}`);
    }
    buf = [];
  };
  for (const line of lines) {
    const hm = /^#{2,4}\s*`([^`]+)`\s*(?:\[L\d+[^\]]*\])?/i.exec(line.trim());
    if (hm) {
      flush();
      currentFile = normalizeGroundingPosixPath(hm[1]).toLowerCase();
      continue;
    }
    if (/^##\s/.test(line.trim())) {
      flush();
      currentFile = '';
      continue;
    }
    if (currentFile) buf.push(line);
  }
  flush();
  return byFile;
}

/**
 * Audits a local RAG chat answer against the workspace file/AST index and retrieved RAG slices,
 * detecting hallucinated file paths, invented symbols, out-of-context guesses, cross-file chimeras, and invalid line citations.
 * @param {string} [answer='']
 * @param {{ repoFiles?: string[], symbols?: string[], symbolsByFile?: Record<string, string[]>, ragContext?: string, ragSources?: Array<{ file?: string, startLine?: number, endLine?: number }|string> }} [groundingIndex={}]
 */
export function auditLocalChatAnswerGrounding(answer = '', groundingIndex = {}) {
  const ansStr = String(answer || '');
  const repoFiles = Array.isArray(groundingIndex?.repoFiles) ? groundingIndex.repoFiles : [];
  const symbols = Array.isArray(groundingIndex?.symbols) ? groundingIndex.symbols : [];
  const symbolsByFile =
    groundingIndex?.symbolsByFile && typeof groundingIndex.symbolsByFile === 'object'
      ? groundingIndex.symbolsByFile
      : null;
  const ragContext = String(groundingIndex?.ragContext || '');
  const ragSources = Array.isArray(groundingIndex?.ragSources) ? groundingIndex.ragSources : [];

  const knownFilesNorm = [];
  const seenKnown = new Set();
  const addKnownFile = (f) => {
    const norm = normalizeGroundingPosixPath(f);
    if (!norm || seenKnown.has(norm.toLowerCase())) return;
    seenKnown.add(norm.toLowerCase());
    knownFilesNorm.push(norm);
  };

  for (const f of repoFiles) addKnownFile(f);
  for (const src of ragSources) {
    const fileVal = typeof src === 'string' ? src : src?.file;
    if (fileVal) addKnownFile(fileVal);
  }
  for (const rf of extractCitedFilePathsFromText(ragContext, knownFilesNorm)) {
    addKnownFile(rf);
  }

  const citedFiles = extractCitedFilePathsFromText(ansStr, knownFilesNorm);
  const verifiedFiles = [];
  const unverifiedFiles = [];
  for (const cf of citedFiles) {
    if (matchesKnownRepoFile(cf, knownFilesNorm)) {
      verifiedFiles.push(cf);
    } else {
      unverifiedFiles.push(cf);
    }
  }

  const knownFileBaseLower = new Set();
  for (const kf of [...knownFilesNorm, ...citedFiles]) {
    const base = getPosixBasename(kf).toLowerCase();
    if (base) {
      knownFileBaseLower.add(base);
      const stem = stripFileExt(base);
      if (stem) knownFileBaseLower.add(stem);
    }
  }

  const knownSymbols = buildKnownSymbolSet(symbols, ragContext);
  const sliceKnownSymbols = ragContext.trim() ? buildKnownSymbolSet([], ragContext) : knownSymbols;
  const candidateSymbols = [];
  const pushCandidateSym = (ident) => {
    const s = String(ident || '').trim();
    if (!s || s.length < 3) return;
    if (!s.includes('_') && /^[A-Z][A-Z0-9]{1,6}$/.test(s)) return;
    const lower = s.toLowerCase();
    if (GROUNDING_STANDARD_IDENTIFIERS_LOWER.has(lower)) return;
    if (knownFileBaseLower.has(lower)) return;
    if (!candidateSymbols.includes(s)) candidateSymbols.push(s);
  };

  // Strip fenced blocks before scanning inline `backticks`
  const proseWithoutFences = ansStr.replace(/```[\s\S]*?```/g, ' ');
  const inlineBtRe = /`([^`\r\n]{2,96})`/g;
  let bm;
  while ((bm = inlineBtRe.exec(proseWithoutFences)) !== null) {
    const inner = bm[1].trim().replace(/;+$/, '');
    if (
      !inner ||
      /\s/.test(inner) ||
      inner.includes('/') ||
      inner.includes('\\') ||
      inner.includes(':') ||
      inner.includes('=') ||
      inner.includes('<') ||
      inner.includes('>') ||
      inner.startsWith('-') ||
      inner.startsWith('.') ||
      inner.startsWith('@') ||
      inner.startsWith('#')
    ) {
      continue;
    }
    if (/\.[A-Za-z0-9]{2,4}$/.test(inner) && !/\(/.test(inner)) {
      const dottedSymMatch = /^([A-Za-z_$][A-Za-z0-9_$]*)\.([A-Za-z_$][A-Za-z0-9_$]{2,})$/.exec(inner);
      if (!dottedSymMatch) continue;
      // Ignore file basenames like `ui.html` or `server.mjs`
      const extLower = dottedSymMatch[2].toLowerCase();
      if (
        /^(?:mjs|cjs|js|ts|tsx|jsx|json|md|html|css|py|go|rs|toml|yaml|yml|txt|log|sql|sh|ps1|bat|cmd|exe|dll|gguf)$/.test(
          extLower
        )
      ) {
        continue;
      }
    }
    const termIdent = extractTerminalIdentifierFromExpr(inner, { allowArgs: true });
    if (termIdent) {
      const noCall = inner.replace(/\s*\([^)]*\)$/, '');
      if (knownSymbols.has(noCall)) {
        pushCandidateSym(noCall);
      } else {
        pushCandidateSym(termIdent);
      }
    }
  }

  // Scan fn(...) calls and multi-hump PascalCase identifiers across answer (masking URLs, file paths, inline backticks, and local declarations)
  const callScanText = ansStr
    .replace(/https?:\/\/[^\s)`"'>]+/gi, ' ')
    .replace(GROUNDING_FILE_PATH_RE, ' ')
    .replace(/`[^`\r\n]*`/g, ' ')
    .replace(/\bfunction\s+[A-Za-z_$][A-Za-z0-9_$]*\s*\(/g, '(');

  const fnCallRe = /\b([A-Za-z_$][A-Za-z0-9_$]{2,})(\s*)\(([^)\r\n]{0,40})/g;
  let cm;
  while ((cm = fnCallRe.exec(callScanText)) !== null) {
    const fnName = cm[1];
    const ws = cm[2] || '';
    const insidePreview = cm[3] || '';
    if (ws.length > 0) {
      if (
        !/^(?:[a-z]+[A-Z][A-Za-z0-9_]*|[a-z]{2,}_[a-z0-9_]{2,})$/.test(fnName) ||
        /^\s*[А-Яа-яЁё]/.test(insidePreview)
      ) {
        continue;
      }
    }
    pushCandidateSym(fnName);
  }

  const pascalChatRe = /\b([A-Z][a-z0-9]+[A-Z][A-Za-z0-9_]*)\b/g;
  let pcm;
  while ((pcm = pascalChatRe.exec(callScanText)) !== null) {
    if (!GROUNDING_GATED_TECH_ALIAS_TO_CANONICAL.has(pcm[1].toLowerCase())) {
      pushCandidateSym(pcm[1]);
    }
  }

  const verifiedSymbols = [];
  const unverifiedSymbols = [];
  const outOfContextSymbols = [];
  for (const sym of candidateSymbols) {
    if (knownSymbols.has(sym)) {
      verifiedSymbols.push(sym);
      if (ragContext.trim() && !sliceKnownSymbols.has(sym)) {
        outOfContextSymbols.push(sym);
      }
    } else {
      unverifiedSymbols.push(sym);
    }
  }

  // Cross-file chimera detection (symbol claimed inside file A while defined only in file B and absent from A's slice)
  const crossFileMismatches = [];
  if (symbolsByFile && Object.keys(symbolsByFile).length > 0 && verifiedSymbols.length > 0) {
    const symMapNorm = new Map();
    const symToOwners = new Map();
    for (const [fKey, fSyms] of Object.entries(symbolsByFile)) {
      const fNorm = normalizeGroundingPosixPath(fKey).toLowerCase();
      if (!fNorm || !Array.isArray(fSyms) || fSyms.length === 0) continue;
      const expandedSet = buildKnownSymbolSet(fSyms);
      symMapNorm.set(fNorm, expandedSet);
      for (const symName of expandedSet) {
        const owners = symToOwners.get(symName) || [];
        if (!owners.includes(fKey)) owners.push(fKey);
        symToOwners.set(symName, owners);
      }
    }
    const ragSlicesByFile = extractRagSlicesTextByFile(ragContext);
    const resolveMappedFile = (cf) => {
      const cfNorm = normalizeGroundingPosixPath(cf).toLowerCase();
      if (symMapNorm.has(cfNorm)) return cfNorm;
      const cfBase = getPosixBasename(cfNorm);
      for (const k of symMapNorm.keys()) {
        if ((cfNorm.includes('/') && k.endsWith(`/${cfNorm}`)) || (!cfNorm.includes('/') && getPosixBasename(k) === cfBase)) {
          return k;
        }
      }
      return '';
    };

    const sentences = proseWithoutFences.split(/(?<=[.!?])\s+|\r?\n+/);
    const seenMismatchKey = new Set();
    for (const sent of sentences) {
      if (!sent || sent.length < 6) continue;
      const sentFiles = extractCitedFilePathsFromText(sent, knownFilesNorm).filter((f) => matchesKnownRepoFile(f, knownFilesNorm));
      if (sentFiles.length !== 1) continue;
      const claimedRaw = sentFiles[0];
      const claimedMapped = resolveMappedFile(claimedRaw);
      if (!claimedMapped) continue;
      const claimedSymSet = symMapNorm.get(claimedMapped);
      if (!claimedSymSet || claimedSymSet.size === 0) continue;
      const claimedSliceText = ragSlicesByFile.get(claimedMapped) || '';
      const claimedSliceSet = claimedSliceText ? buildKnownSymbolSet([], claimedSliceText) : null;

      for (const sym of verifiedSymbols) {
        const symEsc = sym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (!new RegExp(`\\b${symEsc}\\b`).test(sent)) continue;
        if (claimedSymSet.has(sym)) continue;
        if (claimedSliceSet && claimedSliceSet.has(sym)) continue;
        const actualFiles = (symToOwners.get(sym) || []).filter((f) => normalizeGroundingPosixPath(f).toLowerCase() !== claimedMapped);
        if (actualFiles.length === 0) continue;
        const mKey = `${sym}@${claimedRaw}`;
        if (seenMismatchKey.has(mKey)) continue;
        seenMismatchKey.add(mKey);
        crossFileMismatches.push({
          symbol: sym,
          claimedFile: claimedRaw,
          actualFiles: actualFiles.slice(0, 3),
        });
      }
    }
  }

  // Line-range citation verification (checks file:L#-L# / file#L# / file [L#-L#] against provided RAG slice ranges)
  const unverifiedLineCitations = [];
  const { resolveRangesForCited } = extractRagRangesByFile(ragSources, ragContext, knownFilesNorm);
  const lineCitePatterns = [
    /\b([A-Za-z0-9_./-]+\.(?:mjs|cjs|js|ts|tsx|jsx|json|md|html|css|py|go|rs))`?\s*(?::|#)\s*L?(\d{1,6})(?:\s*-\s*L?(\d{1,6}))?/gi,
    /`([A-Za-z0-9_./-]+\.(?:mjs|cjs|js|ts|tsx|jsx|json|md|html|css|py|go|rs))`\s*\[L(\d{1,6})(?:\s*-\s*L?(\d{1,6}))?\]/gi,
  ];
  const seenLineCite = new Set();
  for (const re of lineCitePatterns) {
    let lm;
    while ((lm = re.exec(ansStr)) !== null) {
      const fCite = lm[1];
      const lStart = Number(lm[2]);
      const lEnd = Number(lm[3] || lm[2]);
      if (!fCite || !Number.isFinite(lStart) || lStart < 1) continue;
      if (!matchesKnownRepoFile(fCite, knownFilesNorm)) continue;
      const allowedRanges = resolveRangesForCited(fCite);
      if (!allowedRanges || allowedRanges.length === 0) continue;
      const inAnyRange = allowedRanges.some((r) => lStart >= (r.start - 5) && lEnd <= (r.end + 5));
      if (!inAnyRange) {
        const citeStr = lEnd !== lStart ? `${fCite}:L${lStart}-L${lEnd}` : `${fCite}:L${lStart}`;
        if (!seenLineCite.has(citeStr)) {
          seenLineCite.add(citeStr);
          unverifiedLineCitations.push(citeStr);
        }
      }
    }
  }

  const grounded =
    unverifiedFiles.length === 0 &&
    unverifiedSymbols.length === 0 &&
    crossFileMismatches.length === 0 &&
    unverifiedLineCitations.length === 0;
  const issueCount =
    unverifiedFiles.length +
    unverifiedSymbols.length +
    crossFileMismatches.length +
    unverifiedLineCitations.length;
  const totalChecked =
    verifiedFiles.length + verifiedSymbols.length + issueCount;
  const groundingScore =
    totalChecked === 0
      ? 1
      : Number(Math.max(0, (verifiedFiles.length + verifiedSymbols.length - crossFileMismatches.length - unverifiedLineCitations.length) / totalChecked).toFixed(3));

  const warnParts = [];
  if (unverifiedFiles.length > 0) {
    warnParts.push(
      `не найдены файлы в индексе: ${unverifiedFiles.slice(0, 5).map((f) => `\`${f}\``).join(', ')}`
    );
  }
  if (unverifiedSymbols.length > 0) {
    warnParts.push(
      `не подтверждены символы в RAG/AST: ${unverifiedSymbols.slice(0, 6).map((s) => `\`${s}\``).join(', ')}`
    );
  }
  if (crossFileMismatches.length > 0) {
    warnParts.push(
      `перепутаны модули символов: ${crossFileMismatches.slice(0, 4).map((m) => `\`${m.symbol}\` (указан \`${m.claimedFile}\`, реально в \`${m.actualFiles[0]}\`)`).join(', ')}`
    );
  }
  if (unverifiedLineCitations.length > 0) {
    warnParts.push(
      `строки вне загруженных RAG-срезов: ${unverifiedLineCitations.slice(0, 4).map((c) => `\`${c}\``).join(', ')}`
    );
  }
  const outOfContextWarningRu = outOfContextSymbols.length > 0
    ? `упомянуты символы из индекса без полного тела в текущих срезах: ${outOfContextSymbols.slice(0, 5).map((s) => `\`${s}\``).join(', ')}`
    : '';
  const warningRu = warnParts.join('; ');

  return {
    grounded,
    groundingScore,
    verifiedFiles,
    unverifiedFiles,
    verifiedSymbols,
    unverifiedSymbols,
    outOfContextSymbols,
    crossFileMismatches,
    unverifiedLineCitations,
    outOfContextWarningRu,
    warningRu,
  };
}

/**
 * Verifies factual claims in a local RAG answer against the retrieved code slices using Ollama JSON Schema.
 * @param {object} [options={}]
 */
export async function verifyChatClaimsLocally({
  answer = '',
  ragContext = '',
  model = 'gemma4:12b',
  timeoutMs = 10000,
  cfgOverride = null,
  httpJsonFn = null,
  signal = null,
} = {}) {
  const cleanAnswer = String(answer || '').trim();
  const cleanCtx = String(ragContext || '').trim();
  if (!cleanAnswer || !cleanCtx) {
    return { ok: true, verified: true, unsupportedClaims: [] };
  }

  const cfg = cfgOverride ? loadGpuConfig(cfgOverride) : loadGpuConfig();
  const callHttp = httpJsonFn || ollamaHttpJson;
  const claimSchema = {
    type: 'object',
    properties: {
      verified: { type: 'boolean' },
      unsupportedClaims: { type: 'array', items: { type: 'string' } },
    },
    required: ['verified', 'unsupportedClaims'],
    additionalProperties: false,
  };

  const payload = {
    model: model || cfg.gpuChatModel,
    stream: false,
    keep_alive: cfg.gpuKeepAlive,
    format: claimSchema,
    messages: [
      {
        role: 'system',
        content:
          'You are a strict NLI code-claim verifier. Check whether every factual claim, behavior, number, or config default in ANSWER is directly supported by CODE_CONTEXT. Output JSON: {"verified":true/false,"unsupportedClaims":["..."]}.',
      },
      {
        role: 'user',
        content: `[CODE_CONTEXT]\n${cleanCtx.slice(0, 7500)}\n\n[ANSWER]\n${cleanAnswer.slice(0, 2600)}`,
      },
    ],
    options: {
      temperature: 0,
      num_predict: 160,
      num_ctx: Math.min(8192, clampInt(cfg.gpuContextTokens, 4096, 32768, 8192)),
    },
  };
  if (/qwen3|gemma4|deepseek/i.test(payload.model)) {
    payload.think = false;
  }

  try {
    let res = await callHttp('POST', '/api/chat', payload, Math.max(2500, Number(timeoutMs) || 8000), cfg.gpuEndpoint, { signal });
    if (!res?.ok && typeof payload.format === 'object' && /format|schema/i.test(String(res?.error || ''))) {
      res = await callHttp('POST', '/api/chat', { ...payload, format: 'json' }, Math.max(2500, Number(timeoutMs) || 8000), cfg.gpuEndpoint, { signal });
    }
    if (!res?.ok) {
      return { ok: false, verified: true, unsupportedClaims: [], error: res?.error || 'Verifier failed' };
    }
    const raw = String(res.data?.message?.content || res.data?.response || '').trim();
    const jm = raw.match(/\{[\s\S]*\}/);
    if (!jm) return { ok: false, verified: true, unsupportedClaims: [] };
    const parsed = JSON.parse(jm[0]);
    const unsupportedClaims = Array.isArray(parsed?.unsupportedClaims)
      ? parsed.unsupportedClaims.map((c) => String(c || '').trim()).filter(Boolean).slice(0, 5)
      : [];
    const verified = parsed?.verified !== false && unsupportedClaims.length === 0;
    return { ok: true, verified, unsupportedClaims };
  } catch (err) {
    return { ok: false, verified: true, unsupportedClaims: [], error: err?.message || 'Verifier exception' };
  }
}

function countGroundingViolations(g) {
  if (!g || typeof g !== 'object') return 0;
  return (
    (g.unverifiedFiles?.length || 0) +
    (g.unverifiedSymbols?.length || 0) +
    (g.crossFileMismatches?.length || 0) +
    (g.unverifiedLineCitations?.length || 0)
  );
}

/**
 * Runs a 100% local, zero-cloud-quota RAG project chat turn via the local Ollama engine,
 * enforcing strict VRAM fit guards, CoT reasoning headroom, 2nd-hop RAM expansion, and AST/RAM grounding verification.
 * @param {object} [options={}]
 */
export async function runLocalProjectChat({
  query = '',
  messages = [],
  ragContext = '',
  ragSources = [],
  verifiedManifest = '',
  repoFiles = [],
  repoSymbols = [],
  symbolsByFile = null,
  fetchExtraSlicesFn = null,
  enableClaimVerifier = false,
  allowCorrectiveRetry = true,
  enableThinking = true,
  workspaceName = '',
  maxOutputTokens = 768,
  timeoutMs = 45000,
  signal = null,
  cfgOverride = null,
  httpJsonFn = null,
  hwProbeFn = null,
} = {}) {
  const rawQuery = String(query || '').trim().slice(0, 12000);
  if (!rawQuery) {
    return { ok: false, answer: '', error: 'Empty query' };
  }
  if (signal?.aborted) {
    return { ok: false, aborted: true, answer: '', error: 'Ollama request aborted' };
  }

  const cfg = cfgOverride ? loadGpuConfig(cfgOverride) : loadGpuConfig();
  if (!cfg.gpuEnabled) {
    return {
      ok: false,
      skippedGpuDisabled: true,
      answer: '',
      error: 'Локальный GPU-движок выключен в настройках',
    };
  }

  const safeQuery = redactSecretsInText(rawQuery);
  const safeRagRaw = redactSecretsInText(String(ragContext || '').trim());
  const safeManifestRaw = redactSecretsInText(String(verifiedManifest || '').trim());
  const cleanRepoFiles = Array.isArray(repoFiles)
    ? repoFiles.map((f) => String(f || '').trim()).filter(Boolean)
    : [];
  const cleanRepoSymbols = Array.isArray(repoSymbols)
    ? repoSymbols.map((s) => String(s || '').trim()).filter(Boolean)
    : [];
  const callHttp = httpJsonFn || ollamaHttpJson;

  if (!httpJsonFn) {
    const ready = await ensureOllamaRunning(cfg);
    if (!ready.ok) {
      return { ok: false, answer: '', error: ready.error || 'Ollama not reachable' };
    }
    if (signal?.aborted) {
      return { ok: false, aborted: true, answer: '', error: 'Ollama request aborted' };
    }
  }

  const hw = hwProbeFn ? hwProbeFn() : probeNvidiaGpu();
  const psRes = await callHttp('GET', '/api/ps', null, 800, cfg.gpuEndpoint, { signal });
  if (signal?.aborted || psRes?.aborted) {
    return { ok: false, aborted: true, answer: '', error: 'Ollama request aborted' };
  }
  let loadedModels = Array.isArray(psRes?.data?.models) ? psRes.data.models : [];

  let tagSource = null;
  if (httpJsonFn) {
    const tagsRes = await callHttp('GET', '/api/tags', null, 800, cfg.gpuEndpoint, { signal });
    if (signal?.aborted || tagsRes?.aborted) {
      return { ok: false, aborted: true, answer: '', error: 'Ollama request aborted' };
    }
    tagSource = tagsRes?.ok && Array.isArray(tagsRes.data?.models) ? tagsRes.data.models : null;
  } else {
    tagSource = await getCachedOrFetchOllamaTagMap(cfg);
  }
  if (signal?.aborted) {
    return { ok: false, aborted: true, answer: '', error: 'Ollama request aborted' };
  }

  const requestedModel = cfg.gpuChatModel;
  const fit = evaluateVramModelFit({
    cfg: { ...cfg, gpuChatModel: requestedModel },
    tagModels: tagSource,
    loadedModels,
    hw,
  });
  const tagInventoryKnown = Array.isArray(tagSource) || (tagSource instanceof Map && tagSource.size > 0);

  let targetModel = requestedModel;
  if (fit.selectedSizeFits && (!tagInventoryKnown || fit.selectedChatDownloaded)) {
    targetModel = requestedModel;
  } else if (fit.bestFallbackChatModel) {
    targetModel = fit.bestFallbackChatModel;
  } else {
    await unloadModelsExceedingBudget({ cfg, loadedModels, tagModels: tagSource, hw, callHttp });
    return {
      ok: false,
      skippedVramCap: true,
      needsModelDownload: Boolean(fit.needsModelDownload),
      recommendedPullModel: fit.recommendedPullModel || '',
      answer: '',
      error: fit.reasonRu || `Модель ${requestedModel} превышает лимит ${fit.capGb} ГБ VRAM`,
    };
  }

  // Live free-VRAM guard when target model is cold
  let targetTag = normalizeOllamaTag(targetModel);
  let targetEstVramMb = estimateModelVramMb(targetModel, tagSource, [], cfg.gpuEmbedModel);
  const preWarmTarget = loadedModels.some((m) => normalizeOllamaTag(m?.name || m?.model || '') === targetTag);
  if (!preWarmTarget && hw?.available && hw?.vramReliable && Number(hw.freeMb) > 0 && targetEstVramMb > 0) {
    const recPre = reconcileLoadedModelsVram(loadedModels, tagSource, hw);
    const reclaimableChatMb = recPre.loadedModels
      .filter((m) => !isOllamaEmbedModel(m.name, cfg.gpuEmbedModel))
      .reduce((sum, m) => sum + (Number(m.vramMb) || 0), 0);
    const liveAvailMb = Number(hw.freeMb) + reclaimableChatMb + VRAM_CAP_TOLERANCE_MB;
    if (targetEstVramMb > liveAvailMb && Array.isArray(fit.compatibleChatModels) && fit.compatibleChatModels.length > 0) {
      const warmCompatible = fit.compatibleChatModels.find((cand) =>
        loadedModels.some((m) => normalizeOllamaTag(m?.name || m?.model || '') === normalizeOllamaTag(cand.name))
      );
      const fittingCold = fit.compatibleChatModels.find(
        (cand) => cand.estVramMb > 0 && cand.estVramMb <= liveAvailMb
      );
      const chosenLive = warmCompatible || fittingCold;
      if (chosenLive?.name) {
        targetModel = chosenLive.name;
        targetTag = normalizeOllamaTag(targetModel);
        targetEstVramMb = chosenLive.estVramMb || estimateModelVramMb(targetModel, tagSource, [], cfg.gpuEmbedModel);
      }
    }
  }

  const unloadRes = await unloadModelsExceedingBudget({
    cfg,
    loadedModels,
    tagModels: tagSource,
    hw,
    callHttp,
    reserveForModel: { name: targetModel, estVramMb: targetEstVramMb, isEmbed: false },
  });
  if (signal?.aborted) {
    return { ok: false, aborted: true, answer: '', error: 'Ollama request aborted' };
  }
  loadedModels = unloadRes.remainingRaw;

  const ctxCap = clampInt(cfg.gpuContextTokens, 2048, 32768, 12288);
  const predictTokens = clampInt(maxOutputTokens, 128, Math.min(2048, Math.floor(ctxCap * 0.35)), 768);
  const isReasoningModel = /qwen3|gemma4|deepseek/i.test(targetModel);
  const useThinking = isReasoningModel && enableThinking !== false && ctxCap >= 4096;
  const thinkingHeadroom = ctxCap >= 8192 ? 1792 : 768;
  const effectivePredictTokens = useThinking
    ? Math.min(Math.floor(ctxCap * 0.55), predictTokens + thinkingHeadroom)
    : predictTokens;

  const wsTitle = String(workspaceName || '').trim();
  const systemPrompt = [
    `You are a local AI coding assistant running 100% locally on the developer's GPU${wsTitle ? ` for workspace "${wsTitle}"` : ''}.`,
    'Think carefully through code contracts, imports, and call flows before answering, then respond clearly and concisely in Russian (using backticks for symbol names, file paths, and code).',
    'Ground every file path, function signature, symbol name, numeric constant, and behavior strictly in [VERIFIED PROJECT MANIFEST] and [PROJECT RAG CONTEXT], citing exact `[file:L#-L#]` slices.',
    'NEVER guess, extrapolate, or invent missing functions, files, line numbers, CLI flags, or APIs; if the provided slices do not contain the answer, explicitly state: "В предоставленных срезах кода этого нет".',
  ].join(' ');

  const inputBudgetTokens = Math.max(
    1024,
    ctxCap - effectivePredictTokens - estimateTokensApprox(systemPrompt) - 160
  );
  const cappedManifest = safeManifestRaw
    ? capStringByCharsOnLine(safeManifestRaw, Math.min(1800, Math.floor(inputBudgetTokens * 0.16 * 3.2)))
    : '';
  const isDeepFlowQuery = /(?:как работает|почему|цепочк|поток|оптимизир|архитектур|взаимодейств|сравни|how does|why|flow|trace|architect)/i.test(safeQuery);
  const ragBudgetShare = cappedManifest ? (isDeepFlowQuery ? 0.56 : 0.46) : (isDeepFlowQuery ? 0.66 : 0.58);
  const cappedRag = capStringByCharsOnLine(safeRagRaw, Math.floor(inputBudgetTokens * ragBudgetShare) * 3.2);
  const cappedQuery =
    capStringByCharsOnLine(safeQuery, Math.floor(inputBudgetTokens * 0.24) * 3.2) || safeQuery.slice(0, 512);

  const buildUserTurn = (ragText) => {
    const sections = [];
    if (cappedManifest) sections.push(`[VERIFIED PROJECT MANIFEST]\n${cappedManifest}`);
    if (ragText) sections.push(`[PROJECT RAG CONTEXT]\n${ragText}`);
    return sections.length > 0
      ? `${sections.join('\n\n')}\n\n[USER QUESTION]\n${cappedQuery}`
      : cappedQuery;
  };
  const userTurnContent = buildUserTurn(cappedRag);

  const fixedTurnTokens = estimateTokensApprox(userTurnContent);
  let historyBudgetLeft = Math.max(0, inputBudgetTokens - fixedTurnTokens);

  const cleanPrior = Array.isArray(messages)
    ? messages
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
        .map((m) => ({ role: m.role, content: redactSecretsInText(m.content.trim().slice(0, 4000)) }))
    : [];

  const keptHistoryRev = [];
  for (let i = cleanPrior.length - 1; i >= 0 && keptHistoryRev.length < 10; i--) {
    const turn = cleanPrior[i];
    const tCost = estimateTokensApprox(turn.content) + 12;
    if (tCost > historyBudgetLeft) break;
    keptHistoryRev.push(turn);
    historyBudgetLeft -= tCost;
  }
  const keptHistory = keptHistoryRev.reverse();

  const usedInputTokens =
    estimateTokensApprox(systemPrompt) +
    keptHistory.reduce((acc, m) => acc + estimateTokensApprox(m.content) + 12, 0) +
    fixedTurnTokens;
  const numCtxUsed = Math.min(
    ctxCap,
    Math.max(2048, Math.ceil((usedInputTokens + effectivePredictTokens + 256) / 512) * 512)
  );

  const body = {
    model: targetModel,
    stream: false,
    keep_alive: cfg.gpuKeepAlive,
    messages: [
      { role: 'system', content: systemPrompt },
      ...keptHistory,
      { role: 'user', content: userTurnContent },
    ],
    options: {
      num_ctx: numCtxUsed,
      num_predict: effectivePredictTokens,
      temperature: 0.2,
    },
  };
  if (isReasoningModel) {
    body.think = useThinking;
  }

  const effectiveTimeoutMs = clampInt(timeoutMs, 2000, 120000, 45000);
  const reqOpts = {
    signal,
    workInfoOverride: {
      op: 'local_chat',
      model: targetModel,
      detail: `Локальный RAG-чат (${targetModel})`,
    },
  };

  const t0 = Date.now();
  gpuRuntime.activeLocalChatCount += 1;
  let chatRes = null;
  let rawReply = '';
  let answer = '';
  try {
    chatRes = await callHttp('POST', '/api/chat', body, effectiveTimeoutMs, cfg.gpuEndpoint, reqOpts);
    if (signal?.aborted || chatRes?.aborted) {
      return { ok: false, aborted: true, answer: '', error: 'Ollama request aborted' };
    }
    if (!chatRes.ok && Object.hasOwn(body, 'think') && /think/i.test(String(chatRes.error || ''))) {
      delete body.think;
      chatRes = await callHttp('POST', '/api/chat', body, effectiveTimeoutMs, cfg.gpuEndpoint, reqOpts);
      if (signal?.aborted || chatRes?.aborted) {
        return { ok: false, aborted: true, answer: '', error: 'Ollama request aborted' };
      }
    }
    if (chatRes?.ok) {
      rawReply = String(chatRes.data?.message?.content || chatRes.data?.response || '');
      answer = stripReasoningTags(rawReply);
      // Fallback if CoT consumed the entire num_predict budget without closing the thought block
      if (
        !answer &&
        useThinking &&
        (chatRes.data?.message?.thinking || /<(?:think|thought)|<\|thought\|/i.test(rawReply)) &&
        !signal?.aborted
      ) {
        const noThinkBody = {
          ...body,
          think: false,
          options: {
            ...body.options,
            num_predict: predictTokens,
          },
        };
        const fallbackRes = await callHttp('POST', '/api/chat', noThinkBody, effectiveTimeoutMs, cfg.gpuEndpoint, reqOpts);
        if (signal?.aborted || fallbackRes?.aborted) {
          return { ok: false, aborted: true, answer: '', error: 'Ollama request aborted' };
        }
        if (fallbackRes?.ok) {
          chatRes = fallbackRes;
          rawReply = String(fallbackRes.data?.message?.content || fallbackRes.data?.response || '');
          answer = stripReasoningTags(rawReply);
        }
      }
    }
  } finally {
    gpuRuntime.activeLocalChatCount = Math.max(0, gpuRuntime.activeLocalChatCount - 1);
  }

  let latencyMs = Date.now() - t0;
  if (!chatRes?.ok) {
    return {
      ok: false,
      answer: '',
      model: targetModel,
      latencyMs,
      error: chatRes?.error || 'Ollama /api/chat failed',
    };
  }

  if (!answer) {
    return {
      ok: false,
      answer: '',
      model: targetModel,
      latencyMs,
      error: 'Локальная модель вернула пустой ответ',
    };
  }

  let effectiveRagRaw = safeRagRaw;
  const effectiveRagSources = Array.isArray(ragSources) ? [...ragSources] : [];
  let groundingContextStr = safeManifestRaw ? `${safeManifestRaw}\n${effectiveRagRaw}` : effectiveRagRaw;
  let grounding = auditLocalChatAnswerGrounding(answer, {
    repoFiles: cleanRepoFiles,
    symbols: cleanRepoSymbols,
    symbolsByFile,
    ragContext: groundingContextStr,
    ragSources: effectiveRagSources,
  });

  // 2nd-Hop Self-Grounding: pull missing symbol slices from RAM when model references real repo symbols outside current context
  if (
    grounding.outOfContextSymbols?.length > 0 &&
    typeof fetchExtraSlicesFn === 'function' &&
    (effectiveTimeoutMs - (Date.now() - t0)) >= 4000 &&
    !signal?.aborted
  ) {
    try {
      const extraSlices = await fetchExtraSlicesFn(grounding.outOfContextSymbols.slice(0, 3));
      if (Array.isArray(extraSlices) && extraSlices.length > 0) {
        const extraBlocks = [];
        for (const sl of extraSlices) {
          if (!sl?.file || !sl?.snippetText) continue;
          const sLine = Math.max(1, Number(sl.startLine) || 1);
          const eLine = Math.max(sLine, Number(sl.endLine) || sLine);
          const symTag = sl.symbol ? ` (\`${sl.symbol}\`)` : '';
          extraBlocks.push(`### \`${sl.file}\` [L${sLine}-L${eLine}]${symTag}\n\`\`\`\n${sl.snippetText}\n\`\`\``);
          if (!effectiveRagSources.some((s) => s.file === sl.file && s.startLine === sLine && s.endLine === eLine)) {
            effectiveRagSources.push({ file: sl.file, startLine: sLine, endLine: eLine, score: 0.99 });
          }
        }
        if (extraBlocks.length > 0) {
          effectiveRagRaw = `${effectiveRagRaw ? `${effectiveRagRaw}\n\n` : ''}${extraBlocks.join('\n\n')}`;
          groundingContextStr = safeManifestRaw ? `${safeManifestRaw}\n${effectiveRagRaw}` : effectiveRagRaw;
          const expandedCappedRag = capStringByCharsOnLine(
            effectiveRagRaw,
            Math.floor(inputBudgetTokens * Math.min(0.68, ragBudgetShare + 0.12)) * 3.2
          );
          const hopTurnContent = buildUserTurn(expandedCappedRag);
          const hopCtx = Math.min(
            ctxCap,
            Math.max(numCtxUsed, Math.ceil((estimateTokensApprox(systemPrompt) + estimateTokensApprox(hopTurnContent) + predictTokens + 256) / 512) * 512)
          );
          const hopBody = {
            ...body,
            ...(isReasoningModel ? { think: false } : {}),
            messages: [
              { role: 'system', content: systemPrompt },
              ...keptHistory,
              { role: 'user', content: hopTurnContent },
            ],
            options: {
              ...body.options,
              num_ctx: hopCtx,
              num_predict: predictTokens,
              temperature: 0.05,
            },
          };
          const remHopMs = effectiveTimeoutMs - (Date.now() - t0);
          if (remHopMs >= 3000) {
            gpuRuntime.activeLocalChatCount += 1;
            try {
              const hopRes = await callHttp('POST', '/api/chat', hopBody, Math.min(20000, remHopMs), cfg.gpuEndpoint, reqOpts);
              if (signal?.aborted || hopRes?.aborted) {
                return { ok: false, aborted: true, answer: '', error: 'Ollama request aborted' };
              }
              if (hopRes?.ok) {
                const hopReply = stripReasoningTags(String(hopRes.data?.message?.content || hopRes.data?.response || ''));
                if (hopReply) {
                  answer = hopReply;
                  grounding = auditLocalChatAnswerGrounding(answer, {
                    repoFiles: cleanRepoFiles,
                    symbols: cleanRepoSymbols,
                    symbolsByFile,
                    ragContext: groundingContextStr,
                    ragSources: effectiveRagSources,
                  });
                }
              }
            } finally {
              gpuRuntime.activeLocalChatCount = Math.max(0, gpuRuntime.activeLocalChatCount - 1);
            }
            latencyMs = Date.now() - t0;
          }
        }
      }
    } catch {}
  }

  // Corrective Retry without hardcoded 15s cutoff and without polluting assistant history with hallucinated reply
  if (
    !grounding.grounded &&
    (cleanRepoFiles.length > 0 || cleanRepoSymbols.length > 0) &&
    grounding.warningRu
  ) {
    const remainingBudgetMs = effectiveTimeoutMs - (Date.now() - t0);
    if (allowCorrectiveRetry !== false && remainingBudgetMs >= 3500 && !signal?.aborted) {
      const violationParts = [];
      if (grounding.unverifiedFiles.length > 0) {
        violationParts.push(`несуществующие файлы: ${grounding.unverifiedFiles.slice(0, 6).join(', ')}`);
      }
      if (grounding.unverifiedSymbols.length > 0) {
        violationParts.push(`выдуманные символы: ${grounding.unverifiedSymbols.slice(0, 8).join(', ')}`);
      }
      if (grounding.crossFileMismatches.length > 0) {
        violationParts.push(
          `ошибочная привязка файлов: ${grounding.crossFileMismatches
            .slice(0, 4)
            .map((m) => `${m.symbol} не в ${m.claimedFile}, а в ${m.actualFiles[0]}`)
            .join('; ')}`
        );
      }
      if (grounding.unverifiedLineCitations.length > 0) {
        violationParts.push(`неверные номера строк: ${grounding.unverifiedLineCitations.slice(0, 5).join(', ')}`);
      }
      const validRangesHint = effectiveRagSources
        .slice(0, 6)
        .map((s) => `${s.file}:L${s.startLine}-${s.endLine}`)
        .join(', ');
      const correctionBlock = [
        '[CORRECTION CONSTRAINTS]',
        `Previous draft failed grounding check (${violationParts.join(' | ')}).`,
        validRangesHint ? `Allowed exact slice citations: ${validRangesHint}.` : '',
        'Answer the [USER QUESTION] again cleanly in Russian, strictly removing every unverified file/symbol/line citation and using ONLY symbols present in [VERIFIED PROJECT MANIFEST] and [PROJECT RAG CONTEXT]. If information is missing, state "В предоставленных срезах кода этого нет".',
      ].filter(Boolean).join('\n');

      const retryTurnContent = `${buildUserTurn(capStringByCharsOnLine(effectiveRagRaw, Math.floor(inputBudgetTokens * ragBudgetShare) * 3.2))}\n\n${correctionBlock}`;
      const retryCtx = Math.min(
        ctxCap,
        Math.max(
          numCtxUsed,
          Math.ceil((estimateTokensApprox(systemPrompt) + estimateTokensApprox(retryTurnContent) + predictTokens + 256) / 512) * 512
        )
      );
      const correctiveBody = {
        ...body,
        ...(isReasoningModel ? { think: false } : {}),
        messages: [
          { role: 'system', content: systemPrompt },
          ...keptHistory,
          { role: 'user', content: retryTurnContent },
        ],
        options: {
          ...body.options,
          num_ctx: retryCtx,
          num_predict: predictTokens,
          temperature: 0.05,
        },
      };

      gpuRuntime.activeLocalChatCount += 1;
      try {
        const retryRes = await callHttp(
          'POST',
          '/api/chat',
          correctiveBody,
          Math.min(20000, Math.max(4000, remainingBudgetMs)),
          cfg.gpuEndpoint,
          reqOpts
        );
        if (signal?.aborted || retryRes?.aborted) {
          return { ok: false, aborted: true, answer: '', error: 'Ollama request aborted' };
        }
        if (retryRes?.ok) {
          const retryReply = stripReasoningTags(
            String(retryRes.data?.message?.content || retryRes.data?.response || '')
          );
          if (retryReply) {
            const retryGrounding = auditLocalChatAnswerGrounding(retryReply, {
              repoFiles: cleanRepoFiles,
              symbols: cleanRepoSymbols,
              symbolsByFile,
              ragContext: groundingContextStr,
              ragSources: effectiveRagSources,
            });
            const oldIssues = countGroundingViolations(grounding);
            const newIssues = countGroundingViolations(retryGrounding);
            if (newIssues < oldIssues || (newIssues === oldIssues && retryGrounding.groundingScore >= grounding.groundingScore)) {
              answer = retryReply;
              grounding = retryGrounding;
            }
          }
        }
      } finally {
        gpuRuntime.activeLocalChatCount = Math.max(0, gpuRuntime.activeLocalChatCount - 1);
      }
      latencyMs = Date.now() - t0;
    }

    if (!grounding.grounded && grounding.warningRu) {
      answer = `${answer}\n\n> ⚠️ Сверка с индексом RAM: ${grounding.warningRu}`;
    }
  }

  let claimVerification = null;
  if (
    enableClaimVerifier === true &&
    effectiveRagRaw &&
    (effectiveTimeoutMs - (Date.now() - t0)) >= 4000 &&
    !signal?.aborted
  ) {
    claimVerification = await verifyChatClaimsLocally({
      answer,
      ragContext: effectiveRagRaw,
      model: targetModel,
      timeoutMs: Math.min(10000, effectiveTimeoutMs - (Date.now() - t0)),
      cfgOverride: cfg,
      httpJsonFn,
      signal,
    });
    if (claimVerification && claimVerification.verified === false && claimVerification.unsupportedClaims.length > 0) {
      answer = `${answer}\n\n> 🔎 Проверка утверждений по коду: не все детали подтверждены срезами (${claimVerification.unsupportedClaims.slice(0, 2).join('; ')}).`;
    }
  }

  recordGpuTelemetryPatch((cur) => ({
    ...cur,
    lastLatencyMs: latencyMs,
    lastModel: targetModel,
    lastMode: 'local_chat',
    lastAt: new Date().toISOString(),
  }));

  const isExplicitNoContextRefusal =
    /в\s+предоставленных\s+срезах\s+кода\s+этого\s+нет/i.test(answer) &&
    (grounding?.verifiedFiles?.length || 0) === 0 &&
    (grounding?.verifiedSymbols?.length || 0) === 0;

  return {
    ok: true,
    answer,
    model: targetModel,
    sources: isExplicitNoContextRefusal ? [] : effectiveRagSources,
    grounding,
    ...(claimVerification ? { claimVerification } : {}),
    contextTokensEst: usedInputTokens,
    numCtxUsed,
    latencyMs,
    zeroCloudQuota: true,
  };
}

/**
 * Generates a compact bilingual Symbol Card for a module during GPU idle windows.
 * Automatically yields (<5ms) on P0 foreground GPU preemption.
 */
export async function generateIdleModuleSymbolCard({
  relPath = '',
  codeText = '',
  exportedSymbols = [],
  timeoutMs = 9000,
  httpJsonFn = null,
  cfgOverride = null,
  signal = null,
} = {}) {
  if (signal?.aborted) {
    return { ok: false, aborted: true, error: 'Ollama request aborted' };
  }
  const cleanRel = String(relPath || '').trim();
  const cleanCode = String(codeText || '').trim();
  if (!cleanRel || !cleanCode) {
    return { ok: false, aborted: false, error: 'Missing relPath or codeText' };
  }

  const cfg = cfgOverride ? loadGpuConfig(cfgOverride) : loadGpuConfig();
  if (cfgOverride && cfgOverride.gpuEnabled === false) {
    return { ok: false, aborted: false, skippedGpuDisabled: true, error: 'GPU disabled' };
  }
  if (!httpJsonFn) {
    if (!cfg.gpuEnabled) {
      return { ok: false, aborted: false, skippedGpuDisabled: true, error: 'GPU disabled' };
    }
    if (isLocalChatActive()) {
      return { ok: false, aborted: false, throttled: true, error: 'Local chat active' };
    }
    const guard = evaluateGpuThermalAndLoadGuard(probeNvidiaGpu(), { isBackground: true });
    if (guard.throttled) {
      return { ok: false, aborted: false, throttled: true, error: guard.message || guard.reason };
    }
  }

  const bgCtrl = new AbortController();
  const unregisterBg = registerBackgroundGpuController(bgCtrl);
  let onExtAbort = null;
  if (signal && typeof signal.addEventListener === 'function') {
    onExtAbort = () => {
      try { bgCtrl.abort(); } catch {}
    };
    signal.addEventListener('abort', onExtAbort, { once: true });
  }

  try {
    const safeSnippet = redactSecretsInText(cleanCode.slice(0, 5600));
    const exportsStr = Array.isArray(exportedSymbols) && exportedSymbols.length > 0
      ? exportedSymbols.slice(0, 24).join(', ')
      : 'none';
    const body = {
      model: cfg.gpuChatModel || DEFAULT_GPU_CONFIG.gpuChatModel,
      stream: false,
      think: false,
      format: 'json',
      keep_alive: cfg.gpuKeepAlive,
      messages: [
        {
          role: 'system',
          content:
            'Output ONLY strict JSON: {"purposeRu":"...","purposeEn":"...","keyContracts":"..."}. Each value 1 short sentence, <=240 chars total.',
        },
        {
          role: 'user',
          content: `FILE: ${cleanRel}\nEXPORTS: ${exportsStr}\nCODE:\n${safeSnippet}`,
        },
      ],
      options: {
        temperature: 0.1,
        num_predict: 200,
        num_ctx: 4096,
      },
    };

    const callHttp = httpJsonFn || ollamaHttpJson;
    const res = await callHttp('POST', '/api/chat', body, timeoutMs, cfg.gpuEndpoint, {
      priority: 'background',
      signal: bgCtrl.signal,
      _skipBgRegister: true,
      workInfoOverride: {
        op: 'symbol_card',
        model: body.model,
        detail: `Паспорт модуля ${path.basename(cleanRel)}`,
      },
    });

    if (bgCtrl.signal.aborted || signal?.aborted || res?.aborted) {
      return { ok: false, aborted: true, error: 'Ollama request aborted' };
    }
    if (!res?.ok) {
      return { ok: false, aborted: false, error: res?.error || 'Ollama symbol card call failed' };
    }

    const rawReply =
      typeof res.data?.message?.content === 'string'
        ? res.data.message.content
        : typeof res.data?.response === 'string'
          ? res.data.response
          : res.data && typeof res.data === 'object' && ('purposeRu' in res.data || 'purposeEn' in res.data)
            ? JSON.stringify(res.data)
            : '';
    const parsed = parseStrictBackgroundJson(rawReply);
    if (!parsed) {
      return { ok: false, aborted: false, error: 'Invalid Symbol Card JSON' };
    }

    const purposeRu = String(parsed.purposeRu || '').trim().slice(0, 140);
    const purposeEn = String(parsed.purposeEn || '').trim().slice(0, 140);
    const keyContracts = String(parsed.keyContracts || '').trim().slice(0, 140);
    if (!purposeRu && !purposeEn && !keyContracts) {
      return { ok: false, aborted: false, error: 'Empty Symbol Card fields' };
    }

    return {
      ok: true,
      card: { purposeRu, purposeEn, keyContracts },
      model: body.model,
    };
  } finally {
    unregisterBg();
    if (signal && onExtAbort && typeof signal.removeEventListener === 'function') {
      try { signal.removeEventListener('abort', onExtAbort); } catch {}
    }
  }
}

/**
 * Audits a git diff hunk locally on idle GPU for high-confidence runtime/logic bugs only.
 * Automatically yields (<5ms) on P0 foreground GPU preemption.
 */
export async function reviewGitDiffHunkLocally({
  relPath = '',
  diffText = '',
  neighborContracts = '',
  timeoutMs = 12000,
  httpJsonFn = null,
  cfgOverride = null,
  signal = null,
} = {}) {
  if (signal?.aborted) {
    return { ok: false, aborted: true, findings: [], error: 'Ollama request aborted' };
  }
  const cleanDiff = String(diffText || '').trim();
  if (!cleanDiff) {
    return { ok: true, findings: [] };
  }

  const cfg = cfgOverride ? loadGpuConfig(cfgOverride) : loadGpuConfig();
  if (cfgOverride && cfgOverride.gpuEnabled === false) {
    return { ok: false, aborted: false, skippedGpuDisabled: true, findings: [], error: 'GPU disabled' };
  }
  if (!httpJsonFn) {
    if (!cfg.gpuEnabled) {
      return { ok: false, aborted: false, skippedGpuDisabled: true, findings: [], error: 'GPU disabled' };
    }
    if (isLocalChatActive()) {
      return { ok: false, aborted: false, throttled: true, findings: [], error: 'Local chat active' };
    }
    const guard = evaluateGpuThermalAndLoadGuard(probeNvidiaGpu(), { isBackground: true });
    if (guard.throttled) {
      return { ok: false, aborted: false, throttled: true, findings: [], error: guard.message || guard.reason };
    }
  }

  const bgCtrl = new AbortController();
  const unregisterBg = registerBackgroundGpuController(bgCtrl);
  let onExtAbort = null;
  if (signal && typeof signal.addEventListener === 'function') {
    onExtAbort = () => {
      try { bgCtrl.abort(); } catch {}
    };
    signal.addEventListener('abort', onExtAbort, { once: true });
  }

  try {
    const safeDiff = redactSecretsInText(cleanDiff.slice(0, 12000));
    const safeContracts = redactSecretsInText(String(neighborContracts || '').trim().slice(0, 2400));
    const body = {
      model: cfg.gpuChatModel || DEFAULT_GPU_CONFIG.gpuChatModel,
      stream: false,
      think: false,
      format: 'json',
      keep_alive: cfg.gpuKeepAlive,
      messages: [
        {
          role: 'system',
          content:
            'You are a strict local runtime bug auditor. Report ONLY high-confidence runtime, contract, null-deref, async, or logic bugs in the git diff (ignore style/naming). Output strict JSON: {"findings":[{"severity":"high"|"medium","lineHint":"...","issueRu":"...","fixPromptRu":"..."}]} (empty array if clean, max 3 items).',
        },
        {
          role: 'user',
          content: [
            relPath ? `FILE: ${relPath}` : '',
            safeContracts ? `NEIGHBOR CONTRACTS:\n${safeContracts}` : '',
            `GIT DIFF:\n${safeDiff}`,
          ].filter(Boolean).join('\n\n'),
        },
      ],
      options: {
        temperature: 0.05,
        num_predict: 360,
        num_ctx: 6144,
      },
    };

    const callHttp = httpJsonFn || ollamaHttpJson;
    const res = await callHttp('POST', '/api/chat', body, timeoutMs, cfg.gpuEndpoint, {
      priority: 'background',
      signal: bgCtrl.signal,
      _skipBgRegister: true,
      workInfoOverride: {
        op: 'local_bugbot',
        model: body.model,
        detail: relPath ? `Локальный BugBot (${path.basename(relPath)})` : 'Локальный BugBot диффа',
      },
    });

    if (bgCtrl.signal.aborted || signal?.aborted || res?.aborted) {
      return { ok: false, aborted: true, findings: [], error: 'Ollama request aborted' };
    }
    if (!res?.ok) {
      return { ok: false, aborted: false, findings: [], error: res?.error || 'Ollama BugBot call failed' };
    }

    const rawReply =
      typeof res.data?.message?.content === 'string'
        ? res.data.message.content
        : typeof res.data?.response === 'string'
          ? res.data.response
          : res.data && typeof res.data === 'object' && Array.isArray(res.data.findings)
            ? JSON.stringify(res.data)
            : '';
    const parsed = parseStrictBackgroundJson(rawReply);
    if (!parsed || !Array.isArray(parsed.findings)) {
      return { ok: false, aborted: false, findings: [], error: 'Invalid BugBot JSON' };
    }

    const findings = parsed.findings
      .filter((f) => f && typeof f === 'object' && String(f.issueRu || '').trim().length > 0)
      .slice(0, 3)
      .map((f) => ({
        severity: String(f.severity || '').toLowerCase() === 'high' ? 'high' : 'medium',
        file: String(f.file || relPath || '').trim(),
        lineHint: String(f.lineHint || '').trim().slice(0, 64),
        issueRu: String(f.issueRu || '').trim().slice(0, 260),
        fixPromptRu: String(f.fixPromptRu || '').trim().slice(0, 320),
      }));

    return { ok: true, findings, model: body.model };
  } finally {
    unregisterBg();
    if (signal && onExtAbort && typeof signal.removeEventListener === 'function') {
      try { signal.removeEventListener('abort', onExtAbort); } catch {}
    }
  }
}

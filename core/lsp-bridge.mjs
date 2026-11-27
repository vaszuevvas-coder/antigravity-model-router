/**
 * @file lsp-bridge.mjs
 * @description Live Language Server Protocol (LSP) multiplexer over stdio JSON-RPC 2.0.
 * Zero external dependencies. Supports TypeScript/JS, Python (pyright/pylsp), Go (gopls), Rust (rust-analyzer).
 * Provides <60ms cached/live diagnostics for PostToolUse, exact references/definitions/hover, and code actions.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { delimiter, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_IDLE_UNLOAD_MS = 10 * 60 * 1000;
const DISCOVERY_CACHE_TTL_MS = 30 * 1000;
const MAX_OPEN_DOCS = 128;
const HEADER_DELIM_CRLF = Buffer.from('\r\n\r\n', 'ascii');
const HEADER_DELIM_LF = Buffer.from('\n\n', 'ascii');

function asObj(val) {
  return val && typeof val === 'object' && !Array.isArray(val) ? val : {};
}

function asStr(val, fallback = '') {
  if (typeof val === 'string') return val;
  if (val === null || val === undefined) return fallback;
  return String(val);
}

function clampNum(val, min, max, fallback) {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function sha1Short(text = '') {
  return createHash('sha1').update(asStr(text), 'utf8').digest('hex');
}

function normalizeUriKey(uri = '') {
  const s = asStr(uri).trim();
  if (!s) return '';
  if (process.platform === 'win32') {
    return s.replace(/^file:\/\/\/([A-Z]):/i, (_, d) => `file:///${d.toLowerCase()}:`);
  }
  return s;
}

function filePathToUri(absPath) {
  try {
    return pathToFileURL(resolve(asStr(absPath))).href;
  } catch {
    return '';
  }
}

function uriToRelPath(wsRoot, uri) {
  try {
    const abs = fileURLToPath(asStr(uri));
    const rel = relative(resolve(asStr(wsRoot || process.cwd())), abs).replace(/\\/g, '/');
    return rel || abs.replace(/\\/g, '/');
  } catch {
    return asStr(uri);
  }
}

/**
 * Encodes a JSON-RPC 2.0 message using LSP Content-Length framing in UTF-8 bytes.
 * @param {object} payload
 * @returns {Buffer}
 */
export function encodeLspMessage(payload) {
  const safePayload = asObj(payload);
  const bodyBuf = Buffer.from(JSON.stringify(safePayload), 'utf8');
  const headerBuf = Buffer.from(`Content-Length: ${bodyBuf.length}\r\n\r\n`, 'ascii');
  return Buffer.concat([headerBuf, bodyBuf]);
}

/**
 * Stateful byte-accurate LSP Content-Length frame decoder.
 * Handles coalesced packets and split UTF-8 multi-byte chunks cleanly.
 */
export class LspFrameDecoder {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    if (chunk === null || chunk === undefined) return [];
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(asStr(chunk), 'utf8');
    if (buf.length === 0) return [];
    this.buffer = this.buffer.length === 0 ? buf : Buffer.concat([this.buffer, buf]);

    const messages = [];
    while (this.buffer.length > 0) {
      let sepIdx = this.buffer.indexOf(HEADER_DELIM_CRLF);
      let sepLen = 4;
      if (sepIdx === -1) {
        sepIdx = this.buffer.indexOf(HEADER_DELIM_LF);
        sepLen = 2;
      }
      if (sepIdx === -1) break;

      const headerStr = this.buffer.subarray(0, sepIdx).toString('ascii');
      const lenMatch = /content-length:\s*(\d+)/i.exec(headerStr);
      const bodyStart = sepIdx + sepLen;
      if (!lenMatch) {
        // Skip malformed header block cleanly
        this.buffer = this.buffer.subarray(bodyStart);
        continue;
      }

      const contentLength = Number(lenMatch[1]);
      if (!Number.isFinite(contentLength) || contentLength < 0 || contentLength > 32 * 1024 * 1024) {
        this.buffer = this.buffer.subarray(bodyStart);
        continue;
      }

      if (this.buffer.length < bodyStart + contentLength) {
        break;
      }

      const bodySlice = this.buffer.subarray(bodyStart, bodyStart + contentLength);
      this.buffer = this.buffer.subarray(bodyStart + contentLength);

      try {
        const parsed = JSON.parse(bodySlice.toString('utf8'));
        if (parsed && typeof parsed === 'object') {
          messages.push(parsed);
        }
      } catch {}
    }

    return messages;
  }

  reset() {
    this.buffer = Buffer.alloc(0);
  }
}

/**
 * Detects language group and LSP languageId from file path extension.
 * @param {string} filePath
 * @returns {{ langGroup: string, languageId: string } | null}
 */
export function detectLanguageForFile(filePath = '') {
  const clean = asStr(filePath).trim();
  if (!clean) return null;
  const ext = extname(clean).toLowerCase();
  switch (ext) {
    case '.ts':
    case '.mts':
    case '.cts':
      return { langGroup: 'tsserver', languageId: 'typescript' };
    case '.tsx':
      return { langGroup: 'tsserver', languageId: 'typescriptreact' };
    case '.js':
    case '.mjs':
    case '.cjs':
      return { langGroup: 'tsserver', languageId: 'javascript' };
    case '.jsx':
      return { langGroup: 'tsserver', languageId: 'javascriptreact' };
    case '.py':
      return { langGroup: 'python', languageId: 'python' };
    case '.go':
      return { langGroup: 'go', languageId: 'go' };
    case '.rs':
      return { langGroup: 'rust', languageId: 'rust' };
    default:
      return null;
  }
}

function findExecutableInPath(names = []) {
  const pathEnv = asStr(process.env.PATH || process.env.Path || '');
  if (!pathEnv) return '';
  const dirs = pathEnv.split(delimiter).map((d) => d.trim()).filter(Boolean);
  const isWin = process.platform === 'win32';
  const exts = isWin ? ['.exe', '.cmd', '.bat', ''] : [''];

  for (const dir of dirs) {
    for (const base of names) {
      for (const ext of exts) {
        const candidate = join(dir, `${base}${ext}`);
        try {
          if (existsSync(candidate) && statSync(candidate).isFile()) {
            return candidate;
          }
        } catch {}
      }
    }
  }
  return '';
}

function resolveNodeModuleBinScript(startDir, pkgName, binName = '') {
  let cur = resolve(asStr(startDir || process.cwd()));
  for (let depth = 0; depth < 6; depth++) {
    const pkgDir = join(cur, 'node_modules', pkgName);
    const pkgJsonPath = join(pkgDir, 'package.json');
    if (existsSync(pkgJsonPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
        let binRel = '';
        if (typeof pkg.bin === 'string') {
          binRel = pkg.bin;
        } else if (pkg.bin && typeof pkg.bin === 'object') {
          binRel = pkg.bin[binName] || pkg.bin[pkgName] || Object.values(pkg.bin)[0] || '';
        }
        if (binRel) {
          const fullBin = resolve(pkgDir, binRel);
          if (existsSync(fullBin)) return fullBin;
        }
      } catch {}
    }
    const parent = dirname(cur);
    if (!parent || parent === cur) break;
    cur = parent;
  }
  return '';
}

function resolveCmdWrapperToNodeScript(cmdPath) {
  const clean = asStr(cmdPath);
  if (!clean || !/\.(?:cmd|bat)$/i.test(clean)) return '';
  try {
    const raw = readFileSync(clean, 'utf8');
    // Match npm's standard .cmd wrapper target relative to %~dp0 or %dp0%
    const m = /"(?:%~dp0|%dp0%|[^"]*\\)([^"\r\n]+\.(?:mjs|cjs|js))"/i.exec(raw);
    if (m && m[1]) {
      const candidate = resolve(dirname(clean), m[1].replace(/\\/g, '/'));
      if (existsSync(candidate)) return candidate;
    }
  } catch {}
  return '';
}

/**
 * Resolves an installed LSP server executable + args for a workspace and language group.
 * @param {string} langGroup
 * @param {string} wsRoot
 * @param {object} [opts={}]
 * @returns {{ available: boolean, serverName: string, command: string, args: string[], shell?: boolean } | null}
 */
export function resolveLspServerCommand(langGroup = '', wsRoot = '', opts = {}) {
  const safeOpts = asObj(opts);
  const group = asStr(langGroup).trim().toLowerCase();
  const absRoot = wsRoot ? resolve(asStr(wsRoot)) : process.cwd();
  if (!group) return null;

  const override = safeOpts.serverCmdOverride;
  if (typeof override === 'function') {
    const custom = override(group, absRoot);
    if (custom && custom.command) {
      return {
        available: true,
        serverName: asStr(custom.serverName || group),
        command: asStr(custom.command),
        args: Array.isArray(custom.args) ? custom.args.map(String) : [],
        shell: Boolean(custom.shell),
        env: asObj(custom.env),
      };
    }
    if (custom === false || (custom && custom.available === false)) return null;
  } else if (override && typeof override === 'object') {
    const custom = override[group] || override.default;
    if (custom && custom.command) {
      return {
        available: true,
        serverName: asStr(custom.serverName || group),
        command: asStr(custom.command),
        args: Array.isArray(custom.args) ? custom.args.map(String) : [],
        shell: Boolean(custom.shell),
        env: asObj(custom.env),
      };
    }
  }

  if (group === 'tsserver') {
    const jsEntry = resolveNodeModuleBinScript(absRoot, 'typescript-language-server', 'typescript-language-server');
    if (jsEntry) {
      return {
        available: true,
        serverName: 'typescript-language-server',
        command: process.execPath,
        args: [jsEntry, '--stdio'],
        shell: false,
      };
    }
    const binPath = findExecutableInPath(['typescript-language-server']);
    if (binPath) {
      const nodeScript = resolveCmdWrapperToNodeScript(binPath);
      if (nodeScript) {
        return {
          available: true,
          serverName: 'typescript-language-server',
          command: process.execPath,
          args: [nodeScript, '--stdio'],
          shell: false,
        };
      }
      return {
        available: true,
        serverName: 'typescript-language-server',
        command: binPath,
        args: ['--stdio'],
        shell: process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(binPath),
      };
    }
    return null;
  }

  if (group === 'python') {
    const venvCandidates = process.platform === 'win32'
      ? [join(absRoot, '.venv', 'Scripts', 'pyright-langserver.exe'), join(absRoot, 'venv', 'Scripts', 'pyright-langserver.exe')]
      : [join(absRoot, '.venv', 'bin', 'pyright-langserver'), join(absRoot, 'venv', 'bin', 'pyright-langserver')];
    for (const c of venvCandidates) {
      if (existsSync(c)) {
        return { available: true, serverName: 'pyright-langserver', command: c, args: ['--stdio'], shell: false };
      }
    }
    const pyrightBin = findExecutableInPath(['pyright-langserver']);
    if (pyrightBin) {
      const nodeScript = resolveCmdWrapperToNodeScript(pyrightBin);
      if (nodeScript) {
        return { available: true, serverName: 'pyright-langserver', command: process.execPath, args: [nodeScript, '--stdio'], shell: false };
      }
      return {
        available: true,
        serverName: 'pyright-langserver',
        command: pyrightBin,
        args: ['--stdio'],
        shell: process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(pyrightBin),
      };
    }
    const pylspBin = findExecutableInPath(['pylsp']);
    if (pylspBin) {
      return {
        available: true,
        serverName: 'pylsp',
        command: pylspBin,
        args: [],
        shell: process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(pylspBin),
      };
    }
    return null;
  }

  if (group === 'go') {
    const goplsBin = findExecutableInPath(['gopls']);
    return goplsBin ? { available: true, serverName: 'gopls', command: goplsBin, args: [], shell: false } : null;
  }

  if (group === 'rust') {
    const raBin = findExecutableInPath(['rust-analyzer']);
    return raBin ? { available: true, serverName: 'rust-analyzer', command: raBin, args: [], shell: false } : null;
  }

  return null;
}

/**
 * Applies LSP WorkspaceEdit or TextEdit[] to an in-memory UTF-8 document string.
 * @param {string} originalText
 * @param {object|Array} workspaceEdit
 * @param {string} [targetUri='']
 * @returns {{ ok: boolean, text: string, editsApplied: number }}
 */
export function applyWorkspaceEditToText(originalText = '', workspaceEdit = null, targetUri = '') {
  const text = asStr(originalText);
  if (!workspaceEdit || (typeof workspaceEdit !== 'object' && !Array.isArray(workspaceEdit))) {
    return { ok: false, text, editsApplied: 0 };
  }

  const targetNorm = normalizeUriKey(targetUri);
  let edits = [];

  if (Array.isArray(workspaceEdit)) {
    edits = workspaceEdit;
  } else {
    if (workspaceEdit.changes && typeof workspaceEdit.changes === 'object') {
      for (const [uri, list] of Object.entries(workspaceEdit.changes)) {
        if (!Array.isArray(list)) continue;
        if (!targetNorm || normalizeUriKey(uri) === targetNorm) {
          edits.push(...list);
        }
      }
    }
    if (Array.isArray(workspaceEdit.documentChanges)) {
      for (const docChange of workspaceEdit.documentChanges) {
        if (!docChange || typeof docChange !== 'object') continue;
        const docUri = docChange.textDocument?.uri || '';
        if (!targetNorm || !docUri || normalizeUriKey(docUri) === targetNorm) {
          if (Array.isArray(docChange.edits)) edits.push(...docChange.edits);
        }
      }
    }
  }

  const validEdits = edits.filter(
    (e) => e && e.range && e.range.start && e.range.end && typeof e.newText === 'string'
  );
  if (validEdits.length === 0) {
    return { ok: false, text, editsApplied: 0 };
  }

  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);
  }
  const posToOffset = (pos) => {
    const line = clampNum(pos?.line, 0, Math.max(0, lineStarts.length - 1), 0);
    const char = clampNum(pos?.character, 0, 100_000, 0);
    const lineStart = lineStarts[line] ?? text.length;
    const nextLineStart = line + 1 < lineStarts.length ? lineStarts[line + 1] : text.length;
    const maxLineEnd = nextLineStart > lineStart && text[nextLineStart - 1] === '\n'
      ? (nextLineStart - 1 > lineStart && text[nextLineStart - 2] === '\r' ? nextLineStart - 2 : nextLineStart - 1)
      : nextLineStart;
    return Math.min(maxLineEnd, lineStart + char);
  };

  const indexed = validEdits
    .map((e) => ({
      start: posToOffset(e.range.start),
      end: posToOffset(e.range.end),
      newText: e.newText,
    }))
    .sort((a, b) => b.start - a.start || b.end - a.end);

  let out = text;
  for (const ed of indexed) {
    const s = Math.max(0, Math.min(ed.start, out.length));
    const e = Math.max(s, Math.min(ed.end, out.length));
    out = out.slice(0, s) + ed.newText + out.slice(e);
  }

  return { ok: true, text: out, editsApplied: indexed.length };
}

function formatHoverContents(contents) {
  if (!contents) return '';
  if (typeof contents === 'string') return contents.trim();
  if (Array.isArray(contents)) {
    return contents.map(formatHoverContents).filter(Boolean).join('\n');
  }
  if (typeof contents === 'object') {
    if (typeof contents.value === 'string') return contents.value.trim();
  }
  return '';
}

function normalizeLocations(wsRoot, rawLocs) {
  const arr = Array.isArray(rawLocs) ? rawLocs : (rawLocs ? [rawLocs] : []);
  const out = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const uri = item.uri || item.targetUri || '';
    const range = item.range || item.targetSelectionRange || item.targetRange || null;
    if (!uri || !range?.start) continue;
    out.push({
      file: uriToRelPath(wsRoot, uri),
      uri,
      line: clampNum(range.start.line, 0, 1_000_000, 0) + 1,
      character: clampNum(range.start.character, 0, 100_000, 0) + 1,
    });
  }
  return out;
}

class LspSession {
  constructor({ wsRoot, langGroup, serverCmd, idleUnloadMs, spawnFn, onDispose }) {
    this.wsRoot = resolve(wsRoot);
    this.rootUri = filePathToUri(this.wsRoot);
    this.langGroup = langGroup;
    this.serverName = serverCmd.serverName;
    this.serverCmd = serverCmd;
    this.idleUnloadMs = Math.max(500, Number(idleUnloadMs) || DEFAULT_IDLE_UNLOAD_MS);
    this.spawnFn = typeof spawnFn === 'function' ? spawnFn : spawn;
    this.onDispose = typeof onDispose === 'function' ? onDispose : () => {};

    this.proc = null;
    this.decoder = new LspFrameDecoder();
    this.nextId = 1;
    this.pending = new Map(); // id -> { resolve, reject, timer }
    this.openDocs = new Map(); // normUri -> { uri, languageId, version, sha1, text, diagnostics, updatedAt }
    this.diagWaiters = new Map(); // normUri -> Array<{ resolve, timer }>
    this.initPromise = null;
    this.initialized = false;
    this.disposed = false;
    this.lastActivityAt = Date.now();
    this.idleTimer = null;
    this._touchIdle();
  }

  _touchIdle() {
    this.lastActivityAt = Date.now();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.disposed) return;
    this.idleTimer = setTimeout(() => {
      this.shutdown().catch(() => {});
    }, this.idleUnloadMs);
    if (typeof this.idleTimer.unref === 'function') this.idleTimer.unref();
  }

  _terminateProc(proc) {
    if (!proc) return;
    try { proc.stdout?.removeAllListeners?.(); } catch {}
    try { proc.stderr?.removeAllListeners?.(); } catch {}
    try { proc.removeAllListeners?.(); } catch {}
    try { if (!proc.killed) proc.kill(); } catch {}
  }

  _setOpenDoc(key, doc) {
    while (!this.openDocs.has(key) && this.openDocs.size >= MAX_OPEN_DOCS) {
      const oldestKey = this.openDocs.keys().next().value;
      if (oldestKey === undefined) break;
      this.openDocs.delete(oldestKey);
    }
    this.openDocs.set(key, doc);
  }

  async ensureStarted(timeoutMs = 1500) {
    if (this.disposed) return false;
    if (this.initialized && this.proc && !this.proc.killed) return true;
    if (this.initPromise) {
      return await this._raceTimeout(this.initPromise, timeoutMs, false);
    }

    this.initPromise = (async () => {
      let spawnedProc = null;
      try {
        const proc = this.spawnFn(this.serverCmd.command, this.serverCmd.args || [], {
          cwd: this.wsRoot,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          shell: Boolean(this.serverCmd.shell),
          env: { ...process.env, ...(this.serverCmd.env || {}) },
        });
        if (!proc || !proc.stdin || !proc.stdout) {
          if (proc) this._terminateProc(proc);
          this.initPromise = null;
          return false;
        }
        spawnedProc = proc;
        this.proc = proc;
        if (typeof proc.unref === 'function') proc.unref();

        proc.stdout.on('data', (chunk) => this._handleStdoutChunk(chunk));
        proc.stderr?.on('data', () => {});
        proc.on('exit', () => this._handleProcessExit());
        proc.on('error', () => this._handleProcessExit());

        const initRes = await this.sendRequest(
          'initialize',
          {
            processId: process.pid,
            clientInfo: { name: 'the-tunnel-lsp-bridge', version: '1.0.0' },
            rootUri: this.rootUri,
            workspaceFolders: [{ uri: this.rootUri, name: 'workspace' }],
            capabilities: {
              textDocument: {
                synchronization: { dynamicRegistration: false, didSave: true },
                publishDiagnostics: { relatedInformation: false },
                hover: { contentFormat: ['plaintext', 'markdown'] },
                definition: { linkSupport: true },
                references: {},
                codeAction: {
                  codeActionLiteralSupport: {
                    codeActionKind: { valueSet: ['quickfix', 'source.organizeImports', 'source.fixAll'] },
                  },
                },
              },
              workspace: { workspaceFolders: true },
            },
          },
          Math.max(400, Math.min(4000, timeoutMs + 500))
        );
        if (!initRes || this.disposed) {
          if (spawnedProc) this._terminateProc(spawnedProc);
          this._handleProcessExit();
          return false;
        }
        this.sendNotification('initialized', {});
        this.initialized = true;
        this._touchIdle();
        return true;
      } catch {
        if (spawnedProc) this._terminateProc(spawnedProc);
        this._handleProcessExit();
        return false;
      }
    })();

    return await this._raceTimeout(this.initPromise, timeoutMs, false);
  }

  _raceTimeout(promise, ms, fallbackVal) {
    let timer = null;
    return Promise.race([
      promise,
      new Promise((resolveRace) => {
        timer = setTimeout(() => resolveRace(fallbackVal), Math.max(10, Number(ms) || 50));
        if (typeof timer.unref === 'function') timer.unref();
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  _handleStdoutChunk(chunk) {
    const msgs = this.decoder.push(chunk);
    for (const msg of msgs) {
      if (msg.id !== undefined && msg.id !== null && (Object.hasOwn(msg, 'result') || Object.hasOwn(msg, 'error'))) {
        const entry = this.pending.get(msg.id);
        if (entry) {
          this.pending.delete(msg.id);
          clearTimeout(entry.timer);
          if (msg.error) entry.reject(new Error(msg.error.message || 'LSP error'));
          else entry.resolve(msg.result);
        }
        continue;
      }

      if (msg.method === 'textDocument/publishDiagnostics' && msg.params?.uri) {
        const key = normalizeUriKey(msg.params.uri);
        const diags = Array.isArray(msg.params.diagnostics) ? msg.params.diagnostics : [];
        const prev = this.openDocs.get(key) || {
          uri: msg.params.uri,
          languageId: '',
          version: 0,
          sha1: '',
          text: '',
          diagnostics: [],
          updatedAt: Date.now(),
        };
        prev.diagnostics = diags;
        prev.updatedAt = Date.now();
        this._setOpenDoc(key, prev);

        const waiters = this.diagWaiters.get(key);
        if (waiters && waiters.length > 0) {
          this.diagWaiters.delete(key);
          for (const w of waiters) {
            clearTimeout(w.timer);
            w.resolve(diags);
          }
        }
      } else if (msg.id !== undefined && msg.method) {
        // Answer server-initiated requests (e.g. workspace/configuration) gracefully
        this._writeFrame({ jsonrpc: '2.0', id: msg.id, result: null });
      }
    }
  }

  _handleProcessExit() {
    this.initialized = false;
    const prevProc = this.proc;
    this.proc = null;
    this.initPromise = null;
    if (prevProc) this._terminateProc(prevProc);
    for (const [, entry] of this.pending.entries()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('LSP exited'));
    }
    this.pending.clear();
    for (const [, list] of this.diagWaiters.entries()) {
      for (const w of list) {
        clearTimeout(w.timer);
        w.resolve(null);
      }
    }
    this.diagWaiters.clear();
  }

  _writeFrame(payload) {
    if (!this.proc?.stdin || this.proc.stdin.destroyed || this.disposed) return false;
    try {
      this.proc.stdin.write(encodeLspMessage(payload));
      return true;
    } catch {
      return false;
    }
  }

  sendNotification(method, params = {}) {
    this._touchIdle();
    return this._writeFrame({ jsonrpc: '2.0', method, params });
  }

  sendRequest(method, params = {}, timeoutMs = 450) {
    this._touchIdle();
    const id = this.nextId++;
    return new Promise((resolveReq, rejectReq) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectReq(new Error(`LSP timeout: ${method}`));
      }, Math.max(15, Number(timeoutMs) || 450));
      if (typeof timer.unref === 'function') timer.unref();

      this.pending.set(id, { resolve: resolveReq, reject: rejectReq, timer });
      if (!this._writeFrame({ jsonrpc: '2.0', id, method, params })) {
        clearTimeout(timer);
        this.pending.delete(id);
        rejectReq(new Error('LSP stdin closed'));
      }
    });
  }

  syncDocument(absPath, languageId, text) {
    const uri = filePathToUri(absPath);
    const key = normalizeUriKey(uri);
    const nextText = asStr(text);
    const nextSha1 = sha1Short(nextText);
    const existing = this.openDocs.get(key);

    if (!existing || existing.version === 0) {
      const doc = {
        uri,
        languageId,
        version: 1,
        sha1: nextSha1,
        text: nextText,
        diagnostics: existing?.diagnostics || [],
        updatedAt: Date.now(),
      };
      this._setOpenDoc(key, doc);
      this.sendNotification('textDocument/didOpen', {
        textDocument: { uri, languageId, version: 1, text: nextText },
      });
      return { uri, key, version: 1, changed: true };
    }

    if (existing.sha1 === nextSha1) {
      return { uri: existing.uri, key, version: existing.version, changed: false };
    }

    const nextVer = existing.version + 1;
    existing.version = nextVer;
    existing.sha1 = nextSha1;
    existing.text = nextText;
    existing.updatedAt = Date.now();
    this.sendNotification('textDocument/didChange', {
      textDocument: { uri: existing.uri, version: nextVer },
      contentChanges: [{ text: nextText }],
    });
    return { uri: existing.uri, key, version: nextVer, changed: true };
  }

  waitForDiagnostics(uriKey, waitMs = 45) {
    return new Promise((resolveWait) => {
      const timer = setTimeout(() => {
        const list = this.diagWaiters.get(uriKey) || [];
        const idx = list.findIndex((x) => x.resolve === resolveWait);
        if (idx !== -1) list.splice(idx, 1);
        if (list.length === 0) this.diagWaiters.delete(uriKey);
        const cached = this.openDocs.get(uriKey)?.diagnostics || [];
        resolveWait({ fresh: false, diagnostics: cached });
      }, Math.max(10, Number(waitMs) || 45));
      if (typeof timer.unref === 'function') timer.unref();

      const arr = this.diagWaiters.get(uriKey) || [];
      arr.push({
        timer,
        resolve: (diags) => {
          resolveWait({ fresh: diags !== null, diagnostics: Array.isArray(diags) ? diags : [] });
        },
      });
      this.diagWaiters.set(uriKey, arr);
    });
  }

  async shutdown() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const proc = this.proc;
    if (proc && !proc.killed) {
      const waitExit = new Promise((resolveExit) => {
        const t = setTimeout(resolveExit, 300);
        if (typeof t.unref === 'function') t.unref();
        proc.once('exit', () => {
          clearTimeout(t);
          resolveExit();
        });
      });
      try {
        await Promise.race([
          this.sendRequest('shutdown', null, 150).catch(() => {}),
          new Promise((r) => setTimeout(r, 150)),
        ]);
        this._writeFrame({ jsonrpc: '2.0', method: 'exit', params: null });
      } catch {}
      try {
        if (!proc.killed) proc.kill();
      } catch {}
      await waitExit;
    }
    this._handleProcessExit();
    this.onDispose();
  }
}

export class LspBridgeManager {
  constructor(opts = {}) {
    const safeOpts = asObj(opts);
    this.idleUnloadMs = Math.max(500, Number(safeOpts.idleUnloadMs) || DEFAULT_IDLE_UNLOAD_MS);
    this.serverCmdOverride = safeOpts.serverCmdOverride || null;
    this.spawnFn = typeof safeOpts.spawnFn === 'function' ? safeOpts.spawnFn : null;
    this.sessions = new Map(); // `${normWs}::${langGroup}` -> LspSession
    this.discoveryCache = new Map(); // key -> { ts, cmd }
  }

  _sessionKey(wsRoot, langGroup) {
    const normWs = resolve(asStr(wsRoot || process.cwd()));
    const wsKey = process.platform === 'win32' ? normWs.toLowerCase() : normWs;
    return `${wsKey}::${asStr(langGroup).toLowerCase()}`;
  }

  _resolveCommandCached(langGroup, wsRoot, opts = {}) {
    const safeOpts = asObj(opts);
    const localOverride = safeOpts.serverCmdOverride ?? this.serverCmdOverride;
    if (localOverride) {
      return resolveLspServerCommand(langGroup, wsRoot, { serverCmdOverride: localOverride });
    }
    const key = this._sessionKey(wsRoot, langGroup);
    const now = Date.now();
    const cached = this.discoveryCache.get(key);
    if (cached && now - cached.ts < DISCOVERY_CACHE_TTL_MS) {
      return cached.cmd;
    }
    const cmd = resolveLspServerCommand(langGroup, wsRoot);
    this.discoveryCache.set(key, { ts: now, cmd });
    return cmd;
  }

  async _getOrStartSession(wsRoot, langGroup, opts = {}) {
    const cmd = this._resolveCommandCached(langGroup, wsRoot, opts);
    if (!cmd || !cmd.available) return null;

    const key = this._sessionKey(wsRoot, langGroup);
    let session = this.sessions.get(key);
    if (!session || session.disposed) {
      session = new LspSession({
        wsRoot,
        langGroup,
        serverCmd: cmd,
        idleUnloadMs: opts.idleUnloadMs || this.idleUnloadMs,
        spawnFn: opts.spawnFn || this.spawnFn,
        onDispose: () => {
          if (this.sessions.get(key) === session) {
            this.sessions.delete(key);
          }
        },
      });
      this.sessions.set(key, session);
    }
    return session;
  }

  _readTargetText(absFile, providedText) {
    if (typeof providedText === 'string') return providedText;
    if (Buffer.isBuffer(providedText)) return providedText.toString('utf8');
    try {
      if (existsSync(absFile)) return readFileSync(absFile, 'utf8');
    } catch {}
    return '';
  }

  _formatDiagnosticsList(rawDiags = []) {
    return (Array.isArray(rawDiags) ? rawDiags : [])
      .filter((d) => d && typeof d === 'object' && d.message)
      .slice(0, 25)
      .map((d) => ({
        severity: clampNum(d.severity, 1, 4, 1),
        severityLabel: d.severity === 1 ? 'error' : d.severity === 2 ? 'warning' : 'info',
        line: clampNum(d.range?.start?.line, 0, 1_000_000, 0) + 1,
        character: clampNum(d.range?.start?.character, 0, 100_000, 0) + 1,
        code: d.code !== undefined && d.code !== null ? String(d.code) : '',
        source: asStr(d.source || 'lsp'),
        message: asStr(d.message).replace(/\s+/g, ' ').trim().slice(0, 220),
      }));
  }

  async checkFileDiagnostics(wsRoot = '', filePath = '', contentText = undefined, opts = {}) {
    const safeOpts = asObj(opts);
    const absRoot = resolve(asStr(wsRoot || process.cwd()));
    const rawFile = asStr(filePath).trim();
    if (!rawFile) {
      return { ok: false, available: false, language: '', diagnostics: [], errorCount: 0, warningCount: 0, formattedAlert: '' };
    }
    const absFile = isAbsolute(rawFile) ? resolve(rawFile) : resolve(absRoot, rawFile);
    const relPath = relative(absRoot, absFile).replace(/\\/g, '/') || rawFile;
    const langInfo = detectLanguageForFile(absFile);
    if (!langInfo) {
      return { ok: false, available: false, language: '', filePath: relPath, diagnostics: [], errorCount: 0, warningCount: 0, formattedAlert: '' };
    }

    const timeoutMs = clampNum(safeOpts.timeoutMs, 15, 10_000, 65);
    const t0 = Date.now();
    const session = await this._getOrStartSession(absRoot, langInfo.langGroup, safeOpts);
    if (!session) {
      return {
        ok: false,
        available: false,
        language: langInfo.languageId,
        filePath: relPath,
        diagnostics: [],
        errorCount: 0,
        warningCount: 0,
        formattedAlert: '',
      };
    }

    const ready = await session.ensureStarted(Math.max(25, timeoutMs - 10));
    if (!ready) {
      return {
        ok: true,
        available: true,
        warming: true,
        language: langInfo.languageId,
        serverName: session.serverName,
        filePath: relPath,
        diagnostics: [],
        errorCount: 0,
        warningCount: 0,
        formattedAlert: '',
      };
    }

    const docText = this._readTargetText(absFile, contentText);
    const synced = session.syncDocument(absFile, langInfo.languageId, docText);
    const remainingMs = Math.max(12, timeoutMs - (Date.now() - t0));

    let rawDiags;
    if (synced.changed || safeOpts.waitFresh === true) {
      const waitRes = await session.waitForDiagnostics(synced.key, remainingMs);
      rawDiags = waitRes.diagnostics;
    } else {
      rawDiags = session.openDocs.get(synced.key)?.diagnostics || [];
    }

    const diagnostics = this._formatDiagnosticsList(rawDiags);
    const errorCount = diagnostics.filter((d) => d.severity === 1).length;
    const warningCount = diagnostics.filter((d) => d.severity === 2).length;
    const errorsOnly = diagnostics.filter((d) => d.severity === 1);
    const formattedAlert = errorsOnly.length > 0
      ? `🧬 [LSP ${session.serverName}] ${relPath}: ${errorsOnly.slice(0, 3).map((d) => `L${d.line}:${d.character} ${d.message}`).join(' | ')}`.slice(0, 420)
      : '';

    return {
      ok: true,
      available: true,
      language: langInfo.languageId,
      serverName: session.serverName,
      filePath: relPath,
      diagnostics,
      errorCount,
      warningCount,
      formattedAlert,
    };
  }

  async queryReferencesAndHover(wsRoot = '', filePath = '', line = 0, character = 0, opts = {}) {
    const safeOpts = asObj(opts);
    const absRoot = resolve(asStr(wsRoot || process.cwd()));
    const rawFile = asStr(filePath).trim();
    if (!rawFile) return { ok: false, available: false, hover: '', definitions: [], references: [] };

    const absFile = isAbsolute(rawFile) ? resolve(rawFile) : resolve(absRoot, rawFile);
    const relPath = relative(absRoot, absFile).replace(/\\/g, '/') || rawFile;
    const langInfo = detectLanguageForFile(absFile);
    if (!langInfo) return { ok: false, available: false, filePath: relPath, hover: '', definitions: [], references: [] };

    const timeoutMs = clampNum(safeOpts.timeoutMs, 30, 10_000, 450);
    const session = await this._getOrStartSession(absRoot, langInfo.langGroup, safeOpts);
    if (!session) return { ok: false, available: false, filePath: relPath, hover: '', definitions: [], references: [] };

    const ready = await session.ensureStarted(Math.max(80, Math.floor(timeoutMs * 0.6)));
    if (!ready) return { ok: false, available: true, warming: true, filePath: relPath, hover: '', definitions: [], references: [] };

    const docText = this._readTargetText(absFile, safeOpts.contentText);
    const synced = session.syncDocument(absFile, langInfo.languageId, docText);
    const lspLine = safeOpts.oneBased === true
      ? Math.max(0, clampNum(line, 1, 1_000_000, 1) - 1)
      : clampNum(line, 0, 1_000_000, 0);
    const lspChar = clampNum(character, 0, 100_000, 0);
    const posParams = { textDocument: { uri: synced.uri }, position: { line: lspLine, character: lspChar } };

    const [refsSettled, defSettled, hoverSettled] = await Promise.allSettled([
      session.sendRequest(
        'textDocument/references',
        { ...posParams, context: { includeDeclaration: safeOpts.includeDeclaration !== false } },
        timeoutMs
      ),
      session.sendRequest('textDocument/definition', posParams, timeoutMs),
      session.sendRequest('textDocument/hover', posParams, timeoutMs),
    ]);

    const references = refsSettled.status === 'fulfilled' ? normalizeLocations(absRoot, refsSettled.value) : [];
    const definitions = defSettled.status === 'fulfilled' ? normalizeLocations(absRoot, defSettled.value) : [];
    const hover = hoverSettled.status === 'fulfilled' ? formatHoverContents(hoverSettled.value?.contents) : '';

    return {
      ok: true,
      available: true,
      serverName: session.serverName,
      filePath: relPath,
      hover,
      definitions,
      references,
    };
  }

  async requestFastCodeActions(wsRoot = '', filePath = '', opts = {}) {
    const safeOpts = asObj(opts);
    const absRoot = resolve(asStr(wsRoot || process.cwd()));
    const rawFile = asStr(filePath).trim();
    if (!rawFile) return { ok: false, available: false, actions: [], appliedText: '' };

    const absFile = isAbsolute(rawFile) ? resolve(rawFile) : resolve(absRoot, rawFile);
    const relPath = relative(absRoot, absFile).replace(/\\/g, '/') || rawFile;
    const langInfo = detectLanguageForFile(absFile);
    if (!langInfo) return { ok: false, available: false, filePath: relPath, actions: [], appliedText: '' };

    const timeoutMs = clampNum(safeOpts.timeoutMs, 30, 10_000, 450);
    const session = await this._getOrStartSession(absRoot, langInfo.langGroup, safeOpts);
    if (!session) return { ok: false, available: false, filePath: relPath, actions: [], appliedText: '' };

    const ready = await session.ensureStarted(Math.max(80, Math.floor(timeoutMs * 0.6)));
    if (!ready) return { ok: false, available: true, warming: true, filePath: relPath, actions: [], appliedText: '' };

    const docText = this._readTargetText(absFile, safeOpts.contentText);
    const synced = session.syncDocument(absFile, langInfo.languageId, docText);
    const lineCount = Math.max(1, docText.split(/\r?\n/).length);
    const diags = Array.isArray(safeOpts.diagnostics)
      ? safeOpts.diagnostics
      : (session.openDocs.get(synced.key)?.diagnostics || []);

    const range = safeOpts.range && safeOpts.range.start && safeOpts.range.end
      ? safeOpts.range
      : { start: { line: 0, character: 0 }, end: { line: lineCount, character: 0 } };

    let rawActions = [];
    try {
      const res = await session.sendRequest(
        'textDocument/codeAction',
        {
          textDocument: { uri: synced.uri },
          range,
          context: {
            diagnostics: diags,
            only: Array.isArray(safeOpts.only) ? safeOpts.only : ['source.organizeImports', 'quickfix'],
          },
        },
        timeoutMs
      );
      if (Array.isArray(res)) rawActions = res;
    } catch {
      return { ok: false, available: true, filePath: relPath, actions: [], appliedText: '' };
    }

    const actions = rawActions
      .filter((a) => a && typeof a === 'object')
      .map((a) => ({
        title: asStr(a.title || a.command?.title || 'Code Action'),
        kind: asStr(a.kind || ''),
        hasEdit: Boolean(a.edit && (a.edit.changes || a.edit.documentChanges)),
        edit: a.edit || null,
      }));

    let appliedText = '';
    if (safeOpts.apply === true) {
      const firstEditable = actions.find((a) => a.hasEdit);
      if (firstEditable) {
        const applied = applyWorkspaceEditToText(docText, firstEditable.edit, synced.uri);
        if (applied.ok) appliedText = applied.text;
      }
    }

    return {
      ok: true,
      available: true,
      serverName: session.serverName,
      filePath: relPath,
      actions,
      appliedText,
    };
  }

  getCachedDiagnosticsForWorkspace(wsRoot = '') {
    const absRoot = resolve(asStr(wsRoot || process.cwd()));
    const targetPrefix = `${process.platform === 'win32' ? absRoot.toLowerCase() : absRoot}::`;
    const issues = [];

    for (const [key, session] of this.sessions.entries()) {
      if (!key.startsWith(targetPrefix) || session.disposed) continue;
      for (const doc of session.openDocs.values()) {
        const rel = uriToRelPath(absRoot, doc.uri);
        for (const d of this._formatDiagnosticsList(doc.diagnostics)) {
          if (d.severity !== 1) continue;
          issues.push({
            severity: 'error',
            type: 'lsp_type_error',
            file: rel,
            line: d.line,
            character: d.character,
            detail: `${rel}:${d.line}:${d.character} [${d.source}] ${d.message}`,
          });
        }
      }
    }
    return issues.slice(0, 20);
  }

  getStatusSnapshot(wsRoot = '') {
    const absRoot = wsRoot ? resolve(asStr(wsRoot)) : '';
    const targetPrefix = absRoot ? `${process.platform === 'win32' ? absRoot.toLowerCase() : absRoot}::` : '';
    const activeServers = [];
    let openDocsCount = 0;
    let diagnosticsErrorCount = 0;
    let lastActivityAt = 0;

    for (const [key, session] of this.sessions.entries()) {
      if (targetPrefix && !key.startsWith(targetPrefix)) continue;
      if (session.disposed) continue;
      openDocsCount += session.openDocs.size;
      lastActivityAt = Math.max(lastActivityAt, session.lastActivityAt || 0);
      let sessErrors = 0;
      for (const doc of session.openDocs.values()) {
        for (const d of doc.diagnostics || []) {
          if (d?.severity === 1) sessErrors += 1;
        }
      }
      diagnosticsErrorCount += sessErrors;
      activeServers.push({
        langGroup: session.langGroup,
        serverName: session.serverName,
        initialized: session.initialized,
        openDocs: session.openDocs.size,
        errorCount: sessErrors,
      });
    }

    let tsAvailable = false;
    let pyAvailable = false;
    try {
      tsAvailable = Boolean(this._resolveCommandCached('tsserver', absRoot || process.cwd()));
      pyAvailable = Boolean(this._resolveCommandCached('python', absRoot || process.cwd()));
    } catch {}

    return {
      ok: true,
      available: activeServers.length > 0 || tsAvailable || pyAvailable,
      activeServers,
      installedBackends: { tsserver: tsAvailable, python: pyAvailable },
      openDocsCount,
      diagnosticsErrorCount,
      lastActivityAt,
    };
  }

  async shutdownWorkspace(wsRoot = '') {
    const absRoot = resolve(asStr(wsRoot || process.cwd()));
    const targetPrefix = `${process.platform === 'win32' ? absRoot.toLowerCase() : absRoot}::`;
    const targets = [];
    for (const [key, session] of this.sessions.entries()) {
      if (key.startsWith(targetPrefix)) targets.push(session.shutdown());
    }
    await Promise.allSettled(targets);
    return { ok: true, stopped: targets.length };
  }

  async shutdownAll() {
    const targets = Array.from(this.sessions.values()).map((s) => s.shutdown());
    await Promise.allSettled(targets);
    this.sessions.clear();
    return { ok: true, stopped: targets.length };
  }
}

export const lspBridge = new LspBridgeManager();

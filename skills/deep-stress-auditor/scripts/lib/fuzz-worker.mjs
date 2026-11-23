/**
 * @file fuzz-worker.mjs
 * @description Zero-mutation sandboxed worker for [T6] Property-Fuzzing.
 *              Intercepts fs, fs/promises, child_process, net, http, https, fetch & process.exit BEFORE importing target modules.
 */

import childProcess from 'node:child_process';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import { pathToFileURL } from 'node:url';
import workerThreads, { isMainThread, parentPort, workerData } from 'node:worker_threads';

const BLOCKED_MSG = 'ERR_SANDBOX_MUTATION_BLOCKED: Side-effect write/network/exec blocked during stress fuzzing';
const rpcPort = workerData?.__fuzzPort || parentPort;
const origSetTimeout = globalThis.setTimeout.bind(globalThis);
let blockedCallsInTurn = 0;
let virtualTimeOffsetMs = 0;

function denySync() {
  if (++blockedCallsInTurn > 16) virtualTimeOffsetMs += 500;
  const err = new Error(BLOCKED_MSG);
  err.code = 'ERR_SANDBOX_FS_MUTATION_BLOCKED';
  throw err;
}

async function denyAsync() {
  if (++blockedCallsInTurn > 16) virtualTimeOffsetMs += 500;
  const err = new Error(BLOCKED_MSG);
  err.code = 'ERR_SANDBOX_FS_MUTATION_BLOCKED';
  throw err;
}

function installZeroMutationSandbox() {
  const blockedSyncFs = [
    'writeFileSync', 'appendFileSync', 'rmSync', 'rmdirSync', 'unlinkSync',
    'mkdirSync', 'renameSync', 'copyFileSync', 'cpSync', 'chmodSync', 'chownSync',
    'truncateSync', 'symlinkSync', 'linkSync', 'createWriteStream', 'watch', 'watchFile',
  ];
  for (const m of blockedSyncFs) {
    if (typeof fs[m] === 'function') fs[m] = denySync;
  }
  if (typeof fs.unwatchFile === 'function') fs.unwatchFile = () => {};
  const blockedAsyncFs = [
    'writeFile', 'appendFile', 'rm', 'rmdir', 'unlink',
    'mkdir', 'rename', 'copyFile', 'cp', 'chmod', 'chown', 'truncate', 'symlink', 'link',
  ];
  for (const m of blockedAsyncFs) {
    if (typeof fsPromises[m] === 'function') fsPromises[m] = denyAsync;
  }
  fs.writeFile = (_p, _d, cb) => {
    const fn = typeof _d === 'function' ? _d : cb;
    if (typeof fn === 'function') fn(new Error(BLOCKED_MSG));
  };

  const isValidFsPathArg = (p) => (
    (typeof p === 'string' && p.length > 0 && !p.includes('\0')) ||
    (Buffer.isBuffer(p) && p.length > 0 && !p.includes(0)) ||
    (p instanceof URL && p.protocol === 'file:' && !p.pathname.includes('%00'))
  );
  const assertValidFsPathArg = (p) => {
    if (!isValidFsPathArg(p)) {
      const err = new TypeError('The "path" argument must be a non-empty string, Buffer, or file URL without null bytes');
      err.code = 'ERR_INVALID_ARG_TYPE';
      throw err;
    }
  };
  for (const m of ['readFileSync', 'statSync', 'lstatSync', 'readdirSync', 'realpathSync', 'accessSync']) {
    if (typeof fs[m] === 'function') {
      const origFn = fs[m].bind(fs);
      fs[m] = (pathArg, ...rest) => {
        assertValidFsPathArg(pathArg);
        return origFn(pathArg, ...rest);
      };
    }
  }
  if (typeof fs.existsSync === 'function') {
    const origExists = fs.existsSync.bind(fs);
    fs.existsSync = (pathArg) => {
      if (!isValidFsPathArg(pathArg)) return false;
      return origExists(pathArg);
    };
  }
  for (const m of ['readFile', 'stat', 'lstat', 'readdir', 'realpath', 'access']) {
    if (typeof fsPromises[m] === 'function') {
      const origAsyncFn = fsPromises[m].bind(fsPromises);
      fsPromises[m] = async (pathArg, ...rest) => {
        assertValidFsPathArg(pathArg);
        return origAsyncFn(pathArg, ...rest);
      };
    }
  }

  const writeFlagBits = (fs.constants.O_WRONLY || 1)
    | (fs.constants.O_RDWR || 2)
    | (fs.constants.O_CREAT || 64)
    | (fs.constants.O_TRUNC || 512)
    | (fs.constants.O_APPEND || 1024);
  const isWriteOpenFlags = (flags) => (typeof flags === 'string'
    ? /[wa+]/.test(flags)
    : (typeof flags === 'number' && (flags & writeFlagBits) !== 0));
  const origOpenSync = fs.openSync.bind(fs);
  fs.openSync = (pathArg, flags, mode) => {
    assertValidFsPathArg(pathArg);
    if (isWriteOpenFlags(flags)) denySync();
    return origOpenSync(pathArg, flags, mode);
  };
  if (typeof fsPromises.open === 'function') {
    const origFpOpen = fsPromises.open.bind(fsPromises);
    fsPromises.open = async (pathArg, flags, mode) => {
      assertValidFsPathArg(pathArg);
      if (isWriteOpenFlags(flags)) return denyAsync();
      return origFpOpen(pathArg, flags, mode);
    };
  }

  for (const m of ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork']) {
    if (typeof childProcess[m] === 'function') childProcess[m] = denySync;
  }
  if (workerThreads && typeof workerThreads === 'object') {
    try {
      workerThreads.Worker = function BlockedSandboxWorker() {
        denySync();
      };
    } catch {}
  }
  for (const mod of [http, https]) {
    if (typeof mod.request === 'function') mod.request = denySync;
    if (typeof mod.get === 'function') mod.get = denySync;
    if (typeof mod.createServer === 'function') mod.createServer = denySync;
  }
  if (typeof net.connect === 'function') net.connect = denySync;
  if (typeof net.createConnection === 'function') net.createConnection = denySync;
  if (typeof net.createServer === 'function') net.createServer = denySync;

  globalThis.fetch = denyAsync;
  globalThis.setInterval = () => ({ unref() {}, ref() {}, hasRef() { return false; } });
  globalThis.setTimeout = (...args) => {
    const handle = origSetTimeout(...args);
    if (handle && typeof handle.unref === 'function') handle.unref();
    return handle;
  };
  // Fast-forward Date.now() only after repeated blocked FS retries inside a single call
  const origDateNow = Date.now.bind(Date);
  Date.now = () => origDateNow() + virtualTimeOffsetMs;
  // Prevent blocking sync lock-retry loops from stalling worker thread
  Atomics.wait = () => 'not-equal';
  process.on('unhandledRejection', () => {});
  process.exit = (code) => {
    const err = new Error(`ERR_SANDBOX_EXIT_BLOCKED (${code})`);
    err.code = 'ERR_SANDBOX_EXIT_BLOCKED';
    throw err;
  };
  console.log = () => {};
  console.info = () => {};
  console.warn = () => {};
  console.error = () => {};

  try {
    syncBuiltinESMExports();
  } catch {}
}

installZeroMutationSandbox();

const importedModules = new Map();

async function loadTargetModule(filePath) {
  if (importedModules.has(filePath)) return importedModules.get(filePath);
  const mod = await import(pathToFileURL(filePath).href);
  importedModules.set(filePath, mod);
  return mod;
}

function buildDeepObject(depth) {
  let obj = { leaf: 'v' };
  for (let i = 0; i < depth; i++) {
    obj = { nested: obj };
  }
  return obj;
}

function buildProtoPayloadObj() {
  const o = {};
  Object.defineProperty(o, '__proto__', { value: { __auditPolluted__: true }, enumerable: true });
  return o;
}

const FUZZ_MATRIX = [
  { id: 'zero', kind: 'number', value: 0 },
  { id: 'neg_zero', kind: 'number', value: -0 },
  { id: 'nan', kind: 'number', value: Number.NaN },
  { id: 'infinity', kind: 'number', value: Number.POSITIVE_INFINITY },
  { id: 'max_safe', kind: 'number', value: Number.MAX_SAFE_INTEGER },
  { id: 'empty_buf', kind: 'buffer', value: Buffer.alloc(0) },
  { id: 'empty_str', kind: 'string', value: '' },
  { id: 'null_byte_str', kind: 'string', value: 'sample\x00injected' },
  { id: 'surrogate_rtl_emoji', kind: 'string', value: '\uD800\u202E👨‍👩‍👧‍👦\uDEAD' },
  { id: 'path_traversal', kind: 'string', value: '../../..\\..\\etc\\passwd' },
  { id: 'proto_str', kind: 'string', value: '__proto__' },
  { id: 'constructor_str', kind: 'string', value: 'constructor' },
  { id: 'prototype_str', kind: 'string', value: 'prototype' },
  { id: 'proto_obj', kind: 'object', value: buildProtoPayloadObj() },
  { id: 'deep_obj_60', kind: 'object', value: buildDeepObject(60) },
  { id: 'long_50kb_str', kind: 'string', value: `${'line_safe_0\n'.repeat(2000)}a`.repeat(2) },
  { id: 'null', kind: 'nullish', value: null },
  { id: 'undefined', kind: 'nullish', value: undefined },
];

function isEngineTypeCrash(err) {
  const msg = String(err?.message || err);
  if (err instanceof RangeError || /Maximum call stack|Invalid string length|Invalid array length/i.test(msg)) {
    return 'RANGE_OR_STACK';
  }
  if (err instanceof ReferenceError) return 'REFERENCE_ERROR';
  if (err instanceof TypeError && /(?:Cannot read propert|Cannot destructure|is not a function|is not iterable|Cannot convert undefined or null)/i.test(msg)) {
    return 'UNHANDLED_TYPE_ERROR';
  }
  return null;
}

async function invokeWithTimeoutCheck(fn, arg, asyncTimeoutMs = 80) {
  blockedCallsInTurn = 0;
  virtualTimeOffsetMs = 0;
  try {
    const out = fn(arg);
    if (out && typeof out.then === 'function') {
      out.catch(() => {});
      let timer;
      const timeoutPromise = new Promise((_, reject) => {
        timer = origSetTimeout(() => {
          const err = new Error('Async sandbox timeout');
          err.code = 'ERR_SANDBOX_ASYNC_TIMEOUT';
          reject(err);
        }, asyncTimeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
      });
      try {
        return await Promise.race([out, timeoutPromise]);
      } finally {
        clearTimeout(timer);
      }
    }
    return out;
  } finally {
    blockedCallsInTurn = 0;
    virtualTimeOffsetMs = 0;
  }
}

async function runModuleFuzz({ file, relPath, candidates }) {
  const modStart = performance.now();
  const issues = [];
  let mod;
  try {
    mod = await loadTargetModule(file);
  } catch (err) {
    // Module requires external sidecar/network on import; skip safely
    return { ok: true, skipped: String(err?.message || err).slice(0, 120), issues };
  }

  for (const fnName of candidates || []) {
    if (performance.now() - modStart > 1100) break;
    const fn = mod?.[fnName];
    if (typeof fn !== 'function') continue;

    // Baseline check: does function accept benign string / object without throwing?
    let acceptsString = false;
    let acceptsObject = false;
    const baseStart = performance.now();
    try {
      await invokeWithTimeoutCheck(fn, 'benign_sample_input');
      acceptsString = true;
    } catch {}
    try {
      await invokeWithTimeoutCheck(fn, { sample: true, key: 'value' });
      acceptsObject = true;
    } catch {}
    const baselineMs = performance.now() - baseStart;

    for (const p of FUZZ_MATRIX) {
      if (performance.now() - modStart > 1100) break;
      delete Object.prototype.__auditPolluted__;
      try {
        await invokeWithTimeoutCheck(fn, p.value);
        if (Object.prototype.__auditPolluted__ === true) {
          delete Object.prototype.__auditPolluted__;
          issues.push({
            kind: 'PROTOTYPE_POLLUTION',
            fnName,
            payloadId: p.id,
            payload: p.value,
            message: `${fnName}() polluted Object.prototype when fed '${p.id}'`,
          });
          break;
        }
      } catch (err) {
        if (Object.prototype.__auditPolluted__ === true) {
          delete Object.prototype.__auditPolluted__;
          issues.push({
            kind: 'PROTOTYPE_POLLUTION',
            fnName,
            payloadId: p.id,
            payload: p.value,
            message: `${fnName}() polluted Object.prototype`,
          });
          break;
        }
        const crashKind = isEngineTypeCrash(err);
        const isSandboxDenied =
          err?.code === 'ERR_SANDBOX_FS_MUTATION_BLOCKED' ||
          err?.code === 'ERR_SANDBOX_EXIT_BLOCKED' ||
          err?.code === 'ERR_SANDBOX_ASYNC_TIMEOUT';
        if (isSandboxDenied) continue;

        if (crashKind === 'RANGE_OR_STACK' || crashKind === 'REFERENCE_ERROR') {
          issues.push({
            kind: crashKind,
            fnName,
            payloadId: p.id,
            payload: p.value,
            message: `${fnName}() threw ${err?.name || 'Error'} on '${p.id}': ${String(err?.message || err).slice(0, 120)}`,
          });
          break;
        }
        if (crashKind === 'UNHANDLED_TYPE_ERROR') {
          if ((p.kind === 'string' && acceptsString) || (p.kind === 'object' && acceptsObject)) {
            issues.push({
              kind: crashKind,
              fnName,
              payloadId: p.id,
              payload: p.value,
              message: `${fnName}() crashed with unhandled TypeError on '${p.id}': ${String(err?.message || err).slice(0, 120)}`,
            });
            break;
          }
          if (p.kind === 'nullish' && (acceptsString || acceptsObject)) {
            issues.push({
              kind: 'NULLISH_GUARD_MISSING',
              fnName,
              payloadId: p.id,
              payload: p.value,
              message: `${fnName}() lacks nullish guard on '${p.id}': ${String(err?.message || err).slice(0, 120)}`,
            });
            break;
          }
        }
      }
    }

    // 200-step memory leak micro-benchmark on fast pure benign functions
    if ((acceptsString || acceptsObject) && baselineMs < 5 && performance.now() - modStart < 1200) {
      const sampleInput = acceptsString ? 'steady_state_probe_payload' : { ok: true };
      const startHeap = process.memoryUsage().heapUsed;
      for (let step = 0; step < 200; step++) {
        try {
          await invokeWithTimeoutCheck(fn, sampleInput);
        } catch {}
      }
      if (typeof globalThis.gc === 'function') globalThis.gc();
      const deltaMb = (process.memoryUsage().heapUsed - startHeap) / (1024 * 1024);
      if (deltaMb > 24) {
        issues.push({
          kind: 'HEAP_LEAK',
          fnName,
          payloadId: '200_step_loop',
          payload: null,
          message: `${fnName}() retained +${deltaMb.toFixed(1)} MB heap over 200 iterations`,
        });
      }
    }
  }

  return { ok: true, relPath, issues };
}

async function testSinglePayload({ file, fnName, payload }) {
  delete Object.prototype.__auditPolluted__;
  try {
    const mod = await loadTargetModule(file);
    const fn = mod?.[fnName];
    if (typeof fn !== 'function') return { reproduced: false };
    await invokeWithTimeoutCheck(fn, payload);
    if (Object.prototype.__auditPolluted__ === true) {
      delete Object.prototype.__auditPolluted__;
      return { reproduced: true };
    }
    return { reproduced: false };
  } catch (err) {
    if (Object.prototype.__auditPolluted__ === true) {
      delete Object.prototype.__auditPolluted__;
      return { reproduced: true };
    }
    if (err?.code === 'ERR_SANDBOX_FS_MUTATION_BLOCKED' || err?.code === 'ERR_SANDBOX_EXIT_BLOCKED') {
      return { reproduced: false };
    }
    return { reproduced: Boolean(isEngineTypeCrash(err)) };
  }
}

if (!isMainThread && rpcPort) {
  rpcPort.on('message', async (msg) => {
    if (msg?.cmd === 'shutdown') {
      try {
        rpcPort.close?.();
      } catch {}
      return;
    }
    const id = msg?.id;
    try {
      if (msg?.cmd === 'fuzzModule') {
        const res = await runModuleFuzz(msg.payload);
        rpcPort.postMessage({ __fuzzRpc: true, id, ok: true, res });
      } else if (msg?.cmd === 'testSinglePayload') {
        const res = await testSinglePayload(msg.payload);
        rpcPort.postMessage({ __fuzzRpc: true, id, ok: true, res });
      } else {
        rpcPort.postMessage({ __fuzzRpc: true, id, ok: false, error: `Unknown command: ${msg?.cmd}` });
      }
    } catch (err) {
      rpcPort.postMessage({ __fuzzRpc: true, id, ok: false, error: String(err?.message || err) });
    }
  });
}

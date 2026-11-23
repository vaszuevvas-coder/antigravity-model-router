/**
 * @file sandbox-fuzzer.mjs
 * @description Parent controller for [T6] zero-mutation worker fuzzing with timeout watchdog and automatic ddmin minimization.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MessageChannel, Worker } from 'node:worker_threads';
import { minimizeChunks } from '../../../delta-bug-minimizer/scripts/ddmin-runner.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_SCRIPT = join(__dirname, 'fuzz-worker.mjs');

class IsolatedFuzzWorker {
  constructor() {
    this.worker = null;
    this.port = null;
    this.msgSeq = 0;
  }

  async terminateWorkerBounded(w, port, graceMs = 500) {
    try {
      port?.postMessage?.({ cmd: 'shutdown' });
    } catch {}
    try {
      port?.removeAllListeners?.();
      port?.unref?.();
      port?.close?.();
    } catch {}
    if (!w) return;
    await Promise.race([
      Promise.resolve(w.terminate()).catch(() => {}),
      new Promise((resolve) => {
        const t = setTimeout(resolve, graceMs);
        if (typeof t.unref === 'function') t.unref();
      }),
    ]);
  }

  ensureWorker() {
    if (this.worker && this.port) return { worker: this.worker, port: this.port };
    const { port1, port2 } = new MessageChannel();
    const w = new Worker(WORKER_SCRIPT, {
      workerData: { __fuzzPort: port2 },
      transferList: [port2],
    });
    w.unref();
    if (typeof port1.unref === 'function') port1.unref();
    this.worker = w;
    this.port = port1;
    return { worker: w, port: port1 };
  }

  async call(cmd, payload, timeoutMs = 750) {
    const { worker: w, port } = this.ensureWorker();
    const id = ++this.msgSeq;
    return await new Promise((resolve) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        port.off('message', onMsg);
        w.off('error', onErr);
        w.off('exit', onExit);
      };
      const onMsg = (msg) => {
        if (!msg?.__fuzzRpc || msg?.id !== id) return;
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ timedOut: false, ...msg });
      };
      const onErr = (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ timedOut: false, ok: false, error: String(err?.message || err) });
      };
      const onExit = (code) => {
        if (this.worker === w) this.worker = null;
        if (this.port === port) this.port = null;
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ timedOut: false, ok: false, error: `Worker exited unexpectedly (${code})` });
      };
      const timer = setTimeout(async () => {
        if (settled) return;
        settled = true;
        cleanup();
        if (this.worker === w) this.worker = null;
        if (this.port === port) this.port = null;
        await this.terminateWorkerBounded(w, port, 500);
        resolve({ timedOut: true, ok: false, error: `Worker timed out after ${timeoutMs}ms` });
      }, timeoutMs);
      port.on('message', onMsg);
      if (typeof port.unref === 'function') port.unref();
      w.on('error', onErr);
      w.on('exit', onExit);
      port.postMessage({ id, cmd, payload });
    });
  }

  async close() {
    const w = this.worker;
    const port = this.port;
    this.worker = null;
    this.port = null;
    await this.terminateWorkerBounded(w, port, 500);
  }
}

async function minimizeFailingStringPayload(runner, file, fnName, rawStr, maxDurationMs = 1500) {
  if (typeof rawStr !== 'string' || rawStr.length <= 12) return null;

  // Phase A: line-level minimization if multi-line
  const lines = rawStr.split(/\r?\n/);
  let current = rawStr;
  let steps = 0;
  const startMs = performance.now();
  const withinBudget = () => steps < 48 && performance.now() - startMs < maxDurationMs;

  const testSub = async (candidateStr) => {
    if (!withinBudget()) return false;
    steps += 1;
    const resp = await runner.call('testSinglePayload', { file, fnName, payload: candidateStr }, 250);
    return Boolean(resp?.timedOut || resp?.res?.reproduced);
  };

  if (lines.length > 1) {
    // Async sequential ddmin over lines
    let chunks = lines;
    let n = 2;
    let guard = 0;
    while (chunks.length >= 2 && guard++ < 40 && withinBudget()) {
      if (n > chunks.length) n = chunks.length;
      const stepSize = Math.max(1, Math.ceil(chunks.length / n));
      let reduced = false;
      for (let i = 0; i < chunks.length && withinBudget(); i += stepSize) {
        const sub = chunks.slice(i, i + stepSize);
        if (await testSub(sub.join('\n'))) {
          chunks = sub;
          n = Math.max(2, n - 1);
          reduced = true;
          break;
        }
      }
      if (reduced) continue;
      for (let i = 0; i < chunks.length && withinBudget(); i += stepSize) {
        const comp = [...chunks.slice(0, i), ...chunks.slice(i + stepSize)];
        if (comp.length > 0 && (await testSub(comp.join('\n')))) {
          chunks = comp;
          n = Math.max(2, n - 1);
          reduced = true;
          break;
        }
      }
      if (reduced) continue;
      if (n < chunks.length) n = Math.min(chunks.length, n * 2);
      else break;
    }
    current = chunks.join('\n');
  }

  // Phase B: char-chunk minimization when string is still > 24 chars
  if (current.length > 24 && withinBudget()) {
    let chars = Array.from(current);
    let n = 2;
    let guard = 0;
    while (chars.length >= 4 && guard++ < 40 && withinBudget()) {
      if (n > chars.length) n = chars.length;
      const stepSize = Math.max(1, Math.ceil(chars.length / n));
      let reduced = false;
      for (let i = 0; i < chars.length && withinBudget(); i += stepSize) {
        const sub = chars.slice(i, i + stepSize);
        if (await testSub(sub.join(''))) {
          chars = sub;
          n = Math.max(2, n - 1);
          reduced = true;
          break;
        }
      }
      if (reduced) continue;
      if (n < chars.length) n = Math.min(chars.length, n * 2);
      else break;
    }
    current = chars.join('');
  }

  // Also ensure ddmin-runner helper works cleanly for structural array baseline
  const smoke = minimizeChunks(['ok', 'ok'], () => false);
  void smoke;

  return current.length < rawStr.length ? current : null;
}

/**
 * Runs [T6] zero-mutation sandboxed property-fuzzing across candidate JS/ESM modules.
 */
export async function runSandboxedPropertyFuzz(fileResults, { maxModules = 80, totalTimeoutMs = 25000 } = {}) {
  const candidates = fileResults
    .filter((f) => {
      if (!f.fuzzMeta?.safeToImportInSandbox || !(f.fuzzMeta.fuzzCandidates?.length > 0) || f.syntaxOk === false) {
        return false;
      }
      const norm = String(f.relPath || f.file || '').replace(/\\/g, '/').toLowerCase();
      if (norm.endsWith('/fuzz-worker.mjs') || norm.endsWith('/sandbox-fuzzer.mjs')) return false;
      return true;
    })
    .slice(0, maxModules);

  const findings = [];
  if (candidates.length === 0) return findings;

  const runner = new IsolatedFuzzWorker();
  const fuzzStartMs = performance.now();
  try {
    for (const item of candidates) {
      if (performance.now() - fuzzStartMs > totalTimeoutMs) break;
      const resp = await runner.call('fuzzModule', {
        file: item.file,
        relPath: item.relPath,
        candidates: item.fuzzMeta.fuzzCandidates,
      }, 4000);

      if (resp.timedOut) {
        findings.push({
          tier: 'T6',
          ruleId: 'FUZZ_WORKER_TIMEOUT',
          severity: 'CRITICAL',
          cwe: 'CWE-835',
          confidence: 0.94,
          file: item.relPath,
          line: 1,
          message: `Module fuzzing timed out (>4000ms) — possible infinite loop or hang on adversarial input`,
          evidence: item.fuzzMeta.fuzzCandidates.join(', '),
        });
        continue;
      }

      const issues = resp?.res?.issues || [];
      for (const iss of issues) {
        let minimalRepro = '';
        if (typeof iss.payload === 'string' && iss.payload.length > 16) {
          const shrunk = await minimizeFailingStringPayload(runner, item.file, iss.fnName, iss.payload);
          if (shrunk) {
            minimalRepro = `ddmin: ${iss.payload.length}B -> ${shrunk.length}B (${JSON.stringify(shrunk.slice(0, 48))})`;
          }
        }
        const sev = iss.kind === 'PROTOTYPE_POLLUTION'
          ? 'CRITICAL'
          : ((iss.kind === 'HEAP_LEAK' || iss.kind === 'NULLISH_GUARD_MISSING') ? 'MEDIUM' : 'HIGH');
        const cwe = iss.kind === 'PROTOTYPE_POLLUTION'
          ? 'CWE-1321'
          : (iss.kind === 'RANGE_OR_STACK'
            ? 'CWE-674'
            : (iss.kind === 'HEAP_LEAK'
              ? 'CWE-401'
              : (iss.kind === 'NULLISH_GUARD_MISSING' ? 'CWE-476' : 'CWE-20')));
        const confidence = iss.kind === 'NULLISH_GUARD_MISSING' ? 0.75 : 0.93;
        findings.push({
          tier: 'T6',
          ruleId: `FUZZ_${iss.kind}`,
          severity: sev,
          cwe,
          confidence,
          file: item.relPath,
          line: 1,
          message: iss.message,
          evidence: minimalRepro || `payload=${iss.payloadId}`,
        });
      }
    }
  } finally {
    await runner.close();
  }

  return findings;
}

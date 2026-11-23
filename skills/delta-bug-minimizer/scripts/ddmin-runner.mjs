#!/usr/bin/env node
/**
 * @file ddmin-runner.mjs
 * @description Delta Debugging (ddmin) input minimizer & Elephant-Goldfish handoff card formatter.
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { beginCpuLiveWork, endCpuLiveWork, resolveCpuThreadBudget } from '../../../core/cpu-worker-pool.mjs';

const execFileAsync = promisify(execFile);

/**
 * Splits array into n chunks.
 * @param {Array} arr
 * @param {number} n
 * @returns {Array<Array>}
 */
function splitChunks(arr, n) {
  if (!Array.isArray(arr) || n <= 0) return [];
  const count = Math.min(n, arr.length);
  const chunks = [];
  const len = arr.length;
  let start = 0;
  for (let i = 0; i < count; i++) {
    const end = Math.round(((i + 1) * len) / count);
    if (end > start) {
      chunks.push(arr.slice(start, end));
      start = end;
    }
  }
  return chunks;
}

/**
 * Minimizes an array of items using Zeller's ddmin algorithm.
 * Tests subsets and complements via testFn(subset) === true when failure reproduces.
 *
 * @param {Array} items Failing input array (e.g. lines, chunks)
 * @param {Function} testFn Evaluator returning true if subset reproduces failure
 * @returns {Array} Minimal reproducing subset
 */
export function minimizeChunks(items, testFn) {
  if (!Array.isArray(items)) return [];
  if (typeof testFn !== 'function') return [...items];
  if (items.length <= 1) return [...items];

  let c = [...items];
  let n = 2;
  let guard = 0;

  const runTest = (subset) => {
    try {
      return testFn(subset) === true;
    } catch {
      return false;
    }
  };

  while (c.length >= 2 && guard++ < 500) {
    if (n > c.length) n = c.length;
    const chunks = splitChunks(c, n);
    let reduced = false;

    // 1. Test subsets
    for (let i = 0; i < chunks.length; i++) {
      if (runTest(chunks[i])) {
        c = chunks[i];
        n = Math.max(n - 1, 2);
        reduced = true;
        break;
      }
    }
    if (reduced) continue;

    // 2. Test complements
    for (let i = 0; i < chunks.length; i++) {
      const complement = chunks.filter((_, idx) => idx !== i).flat();
      if (complement.length > 0 && runTest(complement)) {
        c = complement;
        n = Math.max(n - 1, 2);
        reduced = true;
        break;
      }
    }
    if (reduced) continue;

    // 3. Increase granularity
    if (n < c.length) {
      n = Math.min(c.length, n * 2);
    } else {
      break;
    }
  }

  return c;
}

/**
 * Evaluates subsets/complements in parallel batches with AbortController early cancellation.
 */
async function findFirstFailingCandidateParallel(candidates, asyncTestFn, concurrency) {
  if (!candidates || candidates.length === 0) return null;
  const ac = new AbortController();
  let winningIdx = Infinity;
  let winner = null;
  let nextIdx = 0;
  const settled = new Set();
  const workerTotal = Math.max(1, Math.min(concurrency, candidates.length));

  const tryAbortIfDeterministic = () => {
    if (winningIdx === Infinity) return;
    for (let k = 0; k < winningIdx; k++) {
      if (!settled.has(k)) return;
    }
    ac.abort();
  };

  await Promise.all(
    Array.from({ length: workerTotal }, async (_, slot) => {
      while (!ac.signal.aborted) {
        const idx = nextIdx++;
        if (idx >= candidates.length || idx >= winningIdx) break;
        const cand = candidates[idx];
        try {
          const hit = await asyncTestFn(cand, ac.signal, slot);
          if (hit === true && idx < winningIdx) {
            winningIdx = idx;
            winner = cand;
          }
        } catch {
          // treat thrown evaluation error as non-reproducing
        } finally {
          settled.add(idx);
          tryAbortIfDeterministic();
        }
      }
    })
  );
  return winner;
}

/**
 * Multi-core parallel Zeller's ddmin input minimizer.
 * Evaluates independent subsets & complements concurrently across CPU cores.
 *
 * @param {Array} items Failing input array
 * @param {(subset: Array, signal?: AbortSignal, workerSlot?: number) => Promise<boolean>|boolean} asyncTestFn
 * @param {{ concurrency?: number }} [options={}]
 * @returns {Promise<Array>} Minimal reproducing subset
 */
export async function minimizeChunksParallel(items, asyncTestFn, { concurrency = 0, skipTelemetry = false } = {}) {
  if (!Array.isArray(items)) return [];
  if (typeof asyncTestFn !== 'function') return [...items];
  if (items.length <= 1) return [...items];

  const t0 = Date.now();
  const defaultThreads = Math.max(2, Math.min(16, Math.max(2, (cpus()?.length || 8) - 4)));
  const maxThreads = Math.max(1, Number(concurrency) || resolveCpuThreadBudget?.() || defaultThreads);
  const liveTicket = !skipTelemetry
    ? beginCpuLiveWork({
        op: 'ddmin_parallel',
        workers: Math.min(maxThreads, items.length),
        items: items.length,
        detail: `Минимизация ddmin (${items.length} фрагм.)`,
        detailEn: `ddmin minimization (${items.length} chunks)`,
      })
    : null;
  let c = [...items];
  let n = 2;
  let guard = 0;

  try {
    while (c.length >= 2 && guard++ < 500) {
      if (n > c.length) n = c.length;
      const chunks = splitChunks(c, n);

      const subWinner = await findFirstFailingCandidateParallel(chunks, asyncTestFn, maxThreads);
      if (subWinner) {
        c = subWinner;
        n = Math.max(n - 1, 2);
        continue;
      }

      const complements = [];
      for (let i = 0; i < chunks.length; i++) {
        const comp = chunks.filter((_, idx) => idx !== i).flat();
        if (comp.length > 0) complements.push(comp);
      }
      const compWinner = await findFirstFailingCandidateParallel(complements, asyncTestFn, maxThreads);
      if (compWinner) {
        c = compWinner;
        n = Math.max(n - 1, 2);
        continue;
      }

      if (n < c.length) {
        n = Math.min(c.length, n * 2);
      } else {
        break;
      }
    }

    return c;
  } finally {
    if (liveTicket) {
      endCpuLiveWork(liveTicket.jobId, {
        op: 'ddmin_parallel',
        workers: Math.min(maxThreads, items.length),
        items: c.length,
        detail: `Минимизация ddmin (${items.length} → ${c.length})`,
        detailEn: `ddmin minimization (${items.length} → ${c.length})`,
        latencyMs: Date.now() - t0,
      });
    }
  }
}

/**
 * Formats a compact 5-line English Elephant-Goldfish handoff card (<=400 chars).
 *
 * @param {object} [card={}]
 * @param {string} [card.rootCause='']
 * @param {string} [card.invariant='']
 * @param {string} [card.minimalRepro='']
 * @param {Array<string>|string} [card.rejectedDeadEnds=[]]
 * @param {string} [card.patchSpec='']
 * @returns {string} 5-line handoff block
 */
export function formatElephantGoldfishCard(card = {}) {
  if (!card || typeof card !== 'object') card = {};
  const rootCause = String(card.rootCause || 'unknown').trim().slice(0, 90);
  const invariant = String(card.invariant || 'none').trim().slice(0, 90);
  const repro = String(card.minimalRepro || 'none').trim().slice(0, 80);

  let deadEnds = 'none';
  if (Array.isArray(card.rejectedDeadEnds)) {
    const list = card.rejectedDeadEnds.map((d) => String(d).trim()).filter(Boolean);
    deadEnds = list.length > 0 ? list.slice(0, 3).join(', ') : 'none';
  } else if (card.rejectedDeadEnds) {
    deadEnds = String(card.rejectedDeadEnds).trim();
  }
  deadEnds = deadEnds.slice(0, 80);

  const patch = String(card.patchSpec || 'none').trim().slice(0, 100);

  const lines = [
    `ROOT: ${rootCause}`,
    `INVARIANT: ${invariant}`,
    `REPRO: ${repro}`,
    `DEAD-ENDS: ${deadEnds}`,
    `PATCH: ${patch}`
  ];

  const result = lines.join('\n');
  return result.length > 400 ? `${result.slice(0, 397)}...` : result;
}

/**
 * CLI Execution Handler
 */
async function runCli() {
  const args = process.argv.slice(2);
  let outFile = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--output=')) outFile = resolve(args[i].slice('--output='.length));
    else if ((args[i] === '--output' || args[i] === '-o') && i + 1 < args.length) outFile = resolve(args[++i]);
  }
  const emitOutput = (obj) => {
    const text = JSON.stringify(obj);
    if (outFile) {
      mkdirSync(dirname(outFile), { recursive: true });
      writeFileSync(outFile, text + '\n', 'utf8');
    } else if (obj && obj.ok === false) {
      console.error(text);
    } else {
      console.log(text);
    }
  };

  if (args.includes('--self-test')) {
    let steps = 0;
    const testArr = Array.from({ length: 16 }, (_, i) => (i === 11 ? 'BUG_TOKEN' : `line_${i + 1}`));
    const minimized = minimizeChunks(testArr, (subset) => {
      steps++;
      return subset.includes('BUG_TOKEN');
    });

    let parallelSteps = 0;
    const parallelArr = Array.from({ length: 32 }, (_, i) => (i === 23 ? 'BUG_TOKEN' : `line_${i + 1}`));
    const minParallel = await minimizeChunksParallel(parallelArr, async (subset) => {
      parallelSteps++;
      return subset.includes('BUG_TOKEN');
    });

    const ok =
      Array.isArray(minimized) && minimized.length === 1 && minimized[0] === 'BUG_TOKEN' && steps <= 12
      && Array.isArray(minParallel) && minParallel.length === 1 && minParallel[0] === 'BUG_TOKEN';
    emitOutput({ ok, minimized, steps, minParallel, parallelSteps, threadsUsed: resolveCpuThreadBudget() });
    process.exit(ok ? 0 : 1);
  }

  const inputIdx = args.indexOf('--input');
  const cmdIdx = args.indexOf('--cmd');

  if (inputIdx !== -1 && cmdIdx !== -1 && args[inputIdx + 1] && args[cmdIdx + 1]) {
    const inputFile = args[inputIdx + 1];
    const cmdTemplate = args[cmdIdx + 1];

    if (!/\{file\}/i.test(cmdTemplate)) {
      emitOutput({ ok: false, error: 'Command template (--cmd) must contain {FILE} placeholder' });
      process.exit(1);
    }

    if (!existsSync(inputFile)) {
      console.error(JSON.stringify({ ok: false, error: `File not found: ${inputFile}` }));
      process.exit(1);
    }

    const lines = readFileSync(inputFile, 'utf8').split(/\r?\n/);
    const threadsUsed = resolveCpuThreadBudget();
    const slotTmpFiles = new Map();
    let steps = 0;

    const testFn = async (subset, signal, slot = 0) => {
      steps++;
      const tmpFile = join(tmpdir(), `ddmin-${process.pid}-${slot}.tmp`);
      slotTmpFiles.set(slot, tmpFile);
      try {
        writeFileSync(tmpFile, subset.join('\n'), 'utf8');
        const cmd = cmdTemplate.replace(/\{file\}/gi, `"${tmpFile}"`);
        const execOpts = { shell: true, windowsHide: true };
        if (signal) execOpts.signal = signal;
        await execFileAsync(cmd, execOpts);
        return false;
      } catch (err) {
        if (err?.name === 'AbortError' || signal?.aborted) return false;
        return true;
      }
    };

    try {
      const initialFails = await testFn(lines, undefined, 0);
      if (!initialFails) {
        emitOutput({ ok: false, error: 'Initial input did not reproduce failure (oracle exited 0)' });
        process.exit(1);
      }
      if (lines.length > 1) {
        const emptyFails = await testFn([], undefined, 0);
        if (emptyFails) {
          emitOutput({ ok: false, error: 'Oracle command fails even on empty input; check --cmd syntax and executable paths' });
          process.exit(1);
        }
      }
      const minimized = await minimizeChunksParallel(lines, testFn, { concurrency: threadsUsed });
      emitOutput({ ok: true, minimized, steps, threadsUsed });
    } finally {
      for (const fp of slotTmpFiles.values()) {
        try {
          if (existsSync(fp)) rmSync(fp, { force: true });
        } catch {}
      }
    }
    return;
  }

  console.log('Usage: node ddmin-runner.mjs --self-test | --input <file> --cmd "<cmd_with_{FILE}>" [--output <path>]');
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  const self = resolve(fileURLToPath(import.meta.url));
  const arg = resolve(process.argv[1]);
  return process.platform === 'win32' ? self.toLowerCase() === arg.toLowerCase() : self === arg;
})();
if (isMain) {
  await runCli();
}

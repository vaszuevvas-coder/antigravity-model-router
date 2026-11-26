#!/usr/bin/env node
/**
 * @file run-stress-audit.mjs
 * @description Universal Repo-Agnostic Polyglot Deep Stress Auditor (Contour A + Contour B + Sandboxed ddmin Fuzzing).
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { runCpuBatch, shutdownCpuPool } from '../../../core/cpu-worker-pool.mjs';
import { auditFileItem } from './lib/file-worker-tasks.mjs';
import { analyzeCrossFileAndContracts } from './lib/graph-and-contracts.mjs';
import { runNativeCheckers } from './lib/native-runners.mjs';
import { buildAuditReport, formatCliMarkdownReport } from './lib/report-formatter.mjs';
import { runSandboxedPropertyFuzz } from './lib/sandbox-fuzzer.mjs';
import { collectAndDetectStack } from './lib/stack-detector.mjs';

const execFileAsync = promisify(execFile);

process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w?.name !== 'ExperimentalWarning') console.warn(w);
});

export function parseAuditCliArgs(argv = []) {
  const safeArgv = Array.isArray(argv) ? argv : [];
  let targetDir = process.cwd();
  let dirSet = false;
  let fuzz = false;
  let deep = false;
  let native = false;
  let json = false;
  let help = false;
  let failOn = 'high';
  let output = '';
  let maxFiles = 0;
  let ratchetPath = '';
  let updateRatchet = false;

  for (let i = 0; i < safeArgv.length; i++) {
    const arg = safeArgv[i];
    if (!arg) continue;
    if (arg === '--help' || arg === '-h') help = true;
    else if (arg === '--fuzz') fuzz = true;
    else if (arg === '--deep') {
      deep = true;
      fuzz = true;
      native = true;
    } else if (arg === '--native') native = true;
    else if (arg === '--json') json = true;
    else if (arg === '--update-ratchet') updateRatchet = true;
    else if (arg.startsWith('--ratchet=')) ratchetPath = resolve(arg.slice('--ratchet='.length));
    else if (arg.startsWith('--fail-on=')) failOn = arg.slice('--fail-on='.length);
    else if (arg.startsWith('--max-files=')) maxFiles = Math.max(100, Math.min(50000, Number(arg.slice('--max-files='.length)) || 0));
    else if (arg.startsWith('--output=')) output = resolve(arg.slice('--output='.length));
    else if ((arg === '--output' || arg === '-o') && i + 1 < safeArgv.length) output = resolve(safeArgv[++i]);
    else if (!arg.startsWith('-') && !dirSet) {
      targetDir = resolve(arg);
      dirSet = true;
    }
  }
  return { targetDir: resolve(targetDir), fuzz, deep, native, json, help, failOn, output, maxFiles, ratchetPath, updateRatchet };
}

/**
 * Complexity Ratchet (inspired by OmniRoute eslint.complexity-ratchets):
 * Prevents new edits from increasing per-file cyclomatic complexity above a saved baseline JSON.
 * @param {Array<object>} fileResults
 * @param {string} baselinePath
 * @param {{ updateBaseline?: boolean, newFileCeiling?: number }} [opts={}]
 */
export function evaluateComplexityRatchet(fileResults = [], baselinePath = '', { updateBaseline = false, newFileCeiling = 35 } = {}) {
  const currentMap = {};
  for (const fr of Array.isArray(fileResults) ? fileResults : []) {
    const rel = String(fr?.relPath || '').replace(/\\/g, '/');
    const cc = Number(fr?.cyclomaticComplexity || 0);
    if (rel && cc > 0) currentMap[rel] = cc;
  }

  const findings = [];
  if (baselinePath && existsSync(baselinePath)) {
    try {
      const prevDoc = JSON.parse(readFileSync(baselinePath, 'utf8'));
      const prevFiles = prevDoc?.files && typeof prevDoc.files === 'object' ? prevDoc.files : {};
      for (const [rel, cc] of Object.entries(currentMap)) {
        const prevCc = Object.hasOwn(prevFiles, rel) ? Number(prevFiles[rel]) : null;
        if (prevCc !== null && cc > prevCc) {
          findings.push({
            tier: 'T2',
            ruleId: 'COMPLEXITY_RATCHET_REGRESSION',
            severity: 'HIGH',
            cwe: 'CWE-1121',
            confidence: 0.95,
            file: rel,
            line: 1,
            message: `Cyclomatic complexity regressed from baseline ${prevCc} -> ${cc} (+${cc - prevCc})`,
            evidence: `baseline=${prevCc}, current=${cc}`,
          });
        } else if (prevCc === null && cc > newFileCeiling) {
          findings.push({
            tier: 'T2',
            ruleId: 'COMPLEXITY_RATCHET_NEW_FILE',
            severity: 'MEDIUM',
            cwe: 'CWE-1121',
            confidence: 0.9,
            file: rel,
            line: 1,
            message: `New file exceeds complexity ratchet ceiling (${cc} > ${newFileCeiling})`,
            evidence: `ceiling=${newFileCeiling}, current=${cc}`,
          });
        }
      }
    } catch {}
  }

  if (updateBaseline && baselinePath) {
    mkdirSync(dirname(baselinePath), { recursive: true });
    writeFileSync(
      baselinePath,
      JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), files: currentMap }, null, 2) + '\n',
      'utf8'
    );
  }

  return { ok: findings.length === 0, trackedFiles: Object.keys(currentMap).length, findings };
}

/**
 * Executes universal polyglot stress audit against any targetDir without project-specific assumptions.
 */
export async function runStressAudit(targetDir, options = {}) {
  const t0 = performance.now();
  const absTarget = resolve(targetDir || process.cwd());
  const fuzzEnabled = Boolean(options.fuzz || options.deep);
  const nativeEnabled = Boolean(options.native || options.deep);
  const deepEnabled = Boolean(options.deep);
  const failOn = options.failOn || 'high';
  const profile = deepEnabled ? 'deep' : (fuzzEnabled ? 'fuzz' : (nativeEnabled ? 'native' : 'fast'));

  // 1. Discover files, BOM/encoding & stack
  const defaultMaxFiles = deepEnabled ? 8000 : 5000;
  const effectiveMaxFiles = Number(options.maxFiles) > 0
    ? Math.max(100, Math.min(50000, Math.floor(Number(options.maxFiles))))
    : defaultMaxFiles;
  const workspace = collectAndDetectStack(absTarget, {
    maxDepth: deepEnabled ? 12 : 10,
    maxFiles: effectiveMaxFiles,
  });

  // 2. Contour A: Parallel per-file analysis via CpuWorkerPool (or local when < 20 files)
  const batchPayload = workspace.files.map((f) => ({
    ...f,
    fuzzEnabled,
  }));

  const fileResults = batchPayload.length >= 20
    ? await runCpuBatch('auditFileBatch', batchPayload, { minItemsForWorkers: 20, skipTelemetry: true })
    : batchPayload.map((item) => auditFileItem(item));

  const allFindings = [];
  const subprocPending = [];
  for (const fr of fileResults) {
    if (Array.isArray(fr?.findings)) allFindings.push(...fr.findings);
    if (fr?.needsSubprocessCheck && fr?.file) {
      subprocPending.push(fr);
    }
  }
  for (let i = 0; i < subprocPending.length; i += 4) {
    const chunk = subprocPending.slice(i, i + 4);
    await Promise.all(chunk.map(async (fr) => {
      try {
        await execFileAsync(process.execPath, ['--check', fr.file], { encoding: 'utf8', timeout: 4000, windowsHide: true });
      } catch (err) {
        allFindings.push({
          tier: 'T1',
          ruleId: 'SYNTAX_ERROR',
          severity: 'CRITICAL',
          cwe: 'CWE-1006',
          confidence: 0.99,
          file: fr.relPath,
          line: 1,
          message: 'Node syntax check failed',
          evidence: String(err?.stderr || err?.message || err).slice(0, 160),
        });
      }
    }));
  }

  // 3. Cross-file graph, exports, cycles, orphans, Blast Radius, .env drift & UI-API contracts
  const crossRes = analyzeCrossFileAndContracts({
    rootDir: workspace.rootDir,
    dirEntriesCache: workspace.dirEntriesCache,
    manifests: workspace.manifests,
    rootPkg: workspace.rootPkg,
    fileResults,
  });
  allFindings.push(...crossRes.findings);

  // 4. Contour B (optional/auto on --deep): native compilers/linters
  let nativeTools = [];
  if (nativeEnabled) {
    const natRes = await runNativeCheckers({
      rootDir: workspace.rootDir,
      stack: workspace.stack,
      manifests: workspace.manifests,
      files: workspace.files,
    });
    nativeTools = natRes.tools;
    allFindings.push(...natRes.findings);
  }

  // 5. [T6] Isolated zero-mutation property-fuzzing + ddmin auto-minimization
  if (fuzzEnabled) {
    const fuzzFindings = await runSandboxedPropertyFuzz(fileResults, {
      maxModules: deepEnabled ? 120 : 60,
    });
    allFindings.push(...fuzzFindings);
  }

  // 5b. Optional Complexity Ratchet baseline comparison
  if (options.ratchetPath) {
    const ratchetRes = evaluateComplexityRatchet(fileResults, options.ratchetPath, {
      updateBaseline: Boolean(options.updateRatchet),
    });
    allFindings.push(...ratchetRes.findings);
  }

  const report = buildAuditReport({
    targetDir: workspace.rootDir,
    profile,
    elapsedMs: performance.now() - t0,
    scannedFiles: workspace.files.length,
    truncated: Boolean(workspace.truncated),
    maxFiles: workspace.maxFiles,
    stack: workspace.stack,
    blastRadiusHubs: crossRes.blastRadiusHubs,
    nativeTools,
    rawFindings: allFindings,
    failOn,
  });

  if (options.shutdownPool !== false) {
    await shutdownCpuPool();
  }
  return report;
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  const self = resolve(fileURLToPath(import.meta.url));
  const arg = resolve(process.argv[1]);
  return process.platform === 'win32' ? self.toLowerCase() === arg.toLowerCase() : self === arg;
})();

if (isMain) {
  (async () => {
    const opts = parseAuditCliArgs(process.argv.slice(2));
    if (opts.help) {
      console.log('Usage: node run-stress-audit.mjs [targetDir] [--fuzz] [--deep] [--native] [--json] [--output <path>] [--fail-on=critical|high|medium|none]');
      process.exit(0);
    }
    try {
      const report = await runStressAudit(opts.targetDir, opts);
      const rendered = opts.json ? JSON.stringify(report, null, 2) : formatCliMarkdownReport(report);
      if (opts.output) {
        mkdirSync(dirname(opts.output), { recursive: true });
        writeFileSync(opts.output, rendered + '\n', 'utf8');
      } else {
        console.log(rendered);
      }
      process.exit(report.status === 'PASSED' ? 0 : 1);
    } catch (err) {
      await shutdownCpuPool().catch(() => {});
      console.error(JSON.stringify({ status: 'FAILED', error: String(err?.message || err) }));
      process.exit(1);
    }
  })();
}


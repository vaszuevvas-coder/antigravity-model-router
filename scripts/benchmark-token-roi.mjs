#!/usr/bin/env node
/**
 * @file benchmark-token-roi.mjs
 * @description Offline Token-Economy & Cache-Hit ROI benchmark for The Tunnel v3.21.0.
 * Measures real compression savings across RTK/ObsMasker, Dot-Path Config Flattening,
 * TOON tables, POSIX path normalization, AgentDiet waste pruning, and brain/ transcripts.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { maskTerminalOutput } from '../core/obs-masker.mjs';
import { crushJsonArrayToToon, flattenNestedConfigToDotPaths, toPosixRelPath } from '../core/toon-formatter.mjs';
import { analyzeAgentDietTrajectoryWaste } from '../core/history-compactor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

function readPackageVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
    if (pkg && typeof pkg.version === 'string' && pkg.version.trim()) {
      return pkg.version.trim();
    }
  } catch {}
  return '3.32.1';
}

function readLiveGpuTelemetry() {
  const candidates = [
    join(homedir(), '.gemini', 'config', 'plugins', 'antigravity-model-router', '.cache', 'gpu-telemetry.json'),
    join(REPO_ROOT, '.cache', 'gpu-telemetry.json'),
  ];
  for (const fp of candidates) {
    if (!existsSync(fp)) continue;
    try {
      const data = JSON.parse(readFileSync(fp, 'utf8'));
      if (data && typeof data === 'object') return data;
    } catch {}
  }
  return null;
}

function estTokens(text = '') {
  return Math.max(0, Math.round(String(text || '').length / 3.8));
}

function collectTranscriptMetrics(maxSessions = 12, brainDirsOverride = null) {
  const geminiRoot = join(homedir(), '.gemini');
  const brainDirs = Array.isArray(brainDirsOverride)
    ? brainDirsOverride.filter((p) => existsSync(p))
    : ['antigravity', 'antigravity-ide', 'antigravity-cli']
        .map((d) => join(geminiRoot, d, 'brain'))
        .filter((p) => existsSync(p));

  const logs = [];
  for (const bDir of brainDirs) {
    try {
      for (const ent of readdirSync(bDir, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        const logPath = join(bDir, ent.name, '.system_generated', 'logs', 'transcript.jsonl');
        if (!existsSync(logPath)) continue;
        try {
          const st = statSync(logPath);
          if (st.isFile() && st.size > 0 && st.size <= 32 * 1024 * 1024) {
            logs.push({ path: logPath, mtimeMs: st.mtimeMs });
          }
        } catch {}
      }
    } catch {}
  }

  logs.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const picked = logs.slice(0, Math.max(0, Number(maxSessions) || 12));

  let sessionsScanned = 0;
  let totalInputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalOutputTokens = 0;
  let ramToolCalls = 0;
  let gpuToolCalls = 0;

  for (const item of picked) {
    try {
      const raw = readFileSync(item.path, 'utf8');
      const lines = raw.split(/\r?\n/).filter(Boolean);
      sessionsScanned++;
      for (const line of lines) {
        let obj;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        if (typeof obj.input_tokens === 'number') totalInputTokens += obj.input_tokens;
        if (typeof obj.cache_read_tokens === 'number') totalCacheReadTokens += obj.cache_read_tokens;
        if (typeof obj.output_tokens === 'number') totalOutputTokens += obj.output_tokens;
        if (Array.isArray(obj.tool_calls)) {
          for (const tc of obj.tool_calls) {
            const n = String(tc?.name || '');
            const lazyToolName = String(tc?.args?.ToolName || tc?.arguments?.ToolName || '');
            if (n.includes('ram_')) ramToolCalls++;
            if (n.includes('gpu_') || (n.includes('call_mcp_tool') && lazyToolName.includes('gpu_'))) {
              gpuToolCalls++;
            }
          }
        }
      }
    } catch {}
  }

  const promptSum = totalInputTokens + totalCacheReadTokens;
  const cacheHitRatePct = promptSum > 0 ? Number(((totalCacheReadTokens / promptSum) * 100).toFixed(1)) : 0;

  return {
    sessionsScanned,
    totalInputTokens,
    totalCacheReadTokens,
    totalOutputTokens,
    cacheHitRatePct,
    ramToolCalls,
    gpuToolCalls,
  };
}

/**
 * Runs deterministic SOTA token-compression fixtures + real local transcript ROI analysis.
 * @param {{ maxSessions?: number, brainDirs?: string[]|null }} [options={}]
 */
export function runTokenRoiBenchmark({ maxSessions = 12, brainDirs = null } = {}) {
  // 1. Terminal test flood + spinners + internal frames
  const tapLines = [
    'Downloading weights... 20%\rDownloading weights... 65%\rDownloading weights... 100%',
    ...Array.from({ length: 80 }, (_, i) => `✔ suite check #${i + 1} verified (${(i + 1) * 0.4}ms)`),
    '✖ broken assertion in parser',
    'AssertionError: expected 1 to equal 2',
    '    at node:internal/test_runner/test:100:5',
    '    at node:internal/process/task_queues:95:5',
    '    at Object.<anonymous> (core/obs-masker.mjs:10:1)',
    'ℹ tests 81 | pass 80 | fail 1',
  ].join('\n');
  const obsRes = maskTerminalOutput(tapLines, 1, { workspaceRoot: REPO_ROOT });

  // 2. Deeply nested JSON config -> Dot-Path Flattening
  const nestedCfg = {
    runtime: {
      mcp: {
        ramMemory: {
          heapLimitMb: 8192,
          limits: { maxFiles: 30000, maxSingleMb: 8, watchDebounceMs: 120 },
        },
      },
      gpu: {
        ollama: {
          endpoint: { url: 'http://127.0.0.1:11434', keepAlive: '15m' },
          vram: { budgetMb: 14336, chatModel: 'gemma4:12b', embedModel: 'qwen3-embedding:4b' },
        },
      },
      cache: {
        prefix: { floorTokens: 4096, compactionThreshold: 120000 },
      },
    },
  };
  const rawCfgPretty = JSON.stringify(nestedCfg, null, 2);
  const dotRes = flattenNestedConfigToDotPaths(nestedCfg);

  // 3. Homogeneous JSON array -> TOON
  const rows = Array.from({ length: 40 }, (_, i) => ({
    id: i + 1,
    module: `core/mod-${i}.mjs`,
    status: i === 17 || i === 33 ? 'error' : 'ok',
    latencyMs: 12 + i,
    dependents: i % 5,
  }));
  const rawArrStr = JSON.stringify(rows, null, 2);
  const toonRes = crushJsonArrayToToon(rows, { tableName: 'modules' });

  // 4. Windows absolute paths -> POSIX relative paths
  const absPaths = Array.from({ length: 25 }, (_, i) =>
    `C:\\Users\\dev\\projects\\antigravity-model-router\\core\\module-${i}.mjs`
  );
  const posixPaths = absPaths.map((p) => toPosixRelPath(p, 'C:/Users/dev/projects/antigravity-model-router'));
  const absJoined = absPaths.join('\n');
  const posixJoined = posixPaths.join('\n');

  // 5. AgentDiet trajectory waste
  const simSteps = [
    { tool_calls: [{ name: 'read_file', args: { Path: 'core/router.mjs' } }], content: 'L1..L200 '.repeat(120) },
    { tool_calls: [{ name: 'read_file', args: { Path: 'core/router.mjs' } }], content: 'L1..L200 '.repeat(120) },
    { content: '✖ test failed\nAssertionError: mismatch\n' + 'stack '.repeat(80) },
    { tool_calls: [{ name: 'edit_file', args: { Path: 'core/router.mjs' } }], content: 'patched' },
    { content: '✔ all tests passed\nℹ fail 0' },
  ];
  const dietRes = analyzeAgentDietTrajectoryWaste(simSteps);
  const dietTotalTok = simSteps.reduce((s, st) => s + estTokens(st.content || ''), 0);

  const pillars = [
    {
      name: 'RTK + ObsMasker v2 (TAP + Frames + Spinners)',
      beforeTok: estTokens(tapLines),
      afterTok: estTokens(obsRes.masked),
    },
    {
      name: 'Dot-Path Config Flattening',
      beforeTok: estTokens(rawCfgPretty),
      afterTok: estTokens(dotRes.text),
    },
    {
      name: 'TOON Table Crusher',
      beforeTok: estTokens(rawArrStr),
      afterTok: estTokens(toonRes.toon),
    },
    {
      name: 'POSIX Relative Path Canonicalization',
      beforeTok: estTokens(absJoined),
      afterTok: estTokens(posixJoined),
    },
    {
      name: 'AgentDiet Superseded Trajectory Pruning',
      beforeTok: dietTotalTok,
      afterTok: Math.max(0, dietTotalTok - dietRes.estimatedPrunedTokens),
    },
  ].map((p) => {
    const savedTok = Math.max(0, p.beforeTok - p.afterTok);
    const reductionPct = p.beforeTok > 0 ? Number(((savedTok / p.beforeTok) * 100).toFixed(1)) : 0;
    return { ...p, savedTok, reductionPct };
  });

  const totalBeforeTok = pillars.reduce((s, p) => s + p.beforeTok, 0);
  const totalAfterTok = pillars.reduce((s, p) => s + p.afterTok, 0);
  const overallSavedPct = totalBeforeTok > 0
    ? Number((((totalBeforeTok - totalAfterTok) / totalBeforeTok) * 100).toFixed(1))
    : 0;

  const liveSessions = collectTranscriptMetrics(maxSessions, brainDirs);
  const gpuTelemetry = readLiveGpuTelemetry();

  return {
    ok: true,
    version: readPackageVersion(),
    pillars,
    overall: {
      beforeTok: totalBeforeTok,
      afterTok: totalAfterTok,
      savedTok: Math.max(0, totalBeforeTok - totalAfterTok),
      reductionPct: overallSavedPct,
    },
    liveSessions,
    gpuTelemetry,
  };
}

function formatRoiReport(res) {
  const version = res.version || readPackageVersion();
  const gpuTel = res.gpuTelemetry;
  const gpuOpsSuffix = gpuTel
    ? ` | GPU engine ops: ${(Number(gpuTel.semanticSearches) || 0) + (Number(gpuTel.distillCalls) || 0)} (saved ~${Number(gpuTel.savedTokensEstimate) || 0} tok)`
    : '';
  const lines = [
    `⚡ [The Tunnel v${version} — Token-Economy ROI Benchmark]`,
    ...res.pillars.map(
      (p) => `  • ${p.name}: ${p.beforeTok} -> ${p.afterTok} tok (-${p.reductionPct}%, saved ${p.savedTok} tok)`
    ),
    `  => Composite Fixture Compression: ${res.overall.beforeTok} -> ${res.overall.afterTok} tok (-${res.overall.reductionPct}%)`,
    `  => Live Brain Transcripts (${res.liveSessions.sessionsScanned} chats): Cache Hit ${res.liveSessions.cacheHitRatePct}% | RAM calls: ${res.liveSessions.ramToolCalls} | GPU calls: ${res.liveSessions.gpuToolCalls}${gpuOpsSuffix}`,
  ];
  return lines.join('\n');
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  const self = resolve(fileURLToPath(import.meta.url));
  const arg = resolve(process.argv[1]);
  return process.platform === 'win32' ? self.toLowerCase() === arg.toLowerCase() : self === arg;
})();

if (isMain) {
  const args = process.argv.slice(2);
  let asJson = false;
  let outFile = '';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') asJson = true;
    else if (a.startsWith('--output=')) outFile = resolve(a.slice('--output='.length));
    else if ((a === '--output' || a === '-o') && i + 1 < args.length) outFile = resolve(args[++i]);
  }
  const report = runTokenRoiBenchmark();
  const rendered = asJson ? JSON.stringify(report, null, 2) : formatRoiReport(report);
  if (outFile) {
    mkdirSync(dirname(outFile), { recursive: true });
    writeFileSync(outFile, rendered + '\n', 'utf8');
  } else {
    console.log(rendered);
  }
}

#!/usr/bin/env node
/**
 * @file ag-cli.mjs
 * @description Universal Terminal AI Toolkit (Gemini 4 Hydrogen / Neon / Carbon / Argon + Orchestrator Edition).
 * Exposes all Gen-3 SOTA token-saving & self-healing mechanisms via a single CLI
 * for terminal coding agents, scripts, and Batch API workflows.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  getCompactRankedRepoMap,
  extractGoldContextSlices,
  findReverseImporters,
  verifyImportContracts,
  findSymbolUsagesAcrossRepo,
  diffRepoChronos,
  findDeadExports,
  buildArchitectPlanDossier
} from './repo-mapper.mjs';
import { applySearchReplace, applySymbolReplacement } from './diff-patcher.mjs';
import { maskTerminalOutput, maskTerminalOutputSmart } from './obs-masker.mjs';
import { verifyFileSyntax, runImpactedMicroTests } from './auto-verifier.mjs';
import { createShadowCheckpoint, rollbackCheckpoint, listCheckpoints } from './shadow-guard.mjs';
import { formatPitfallsForSessionStart, recordPitfall, listPitfalls } from './pitfall-ledger.mjs';
import { formatHandoffForSessionStart, recordHandoffGoal, recordHandoffAction } from './session-handoff.mjs';
import { estimateTaskGradeAndThinkingBudget, compileUserIntentToTechSpec } from './tool-pruner.mjs';
import { evaluateBayesianRoute, recordModelOutcome, getBayesianSummary } from './bayesian-router.mjs';
import { resolveComboFailoverTarget } from './quota-pacer.mjs';
import { checkCommandSecurity, redactSecretsInText } from './security-guard.mjs';
import { recordErrorFingerprint, recordCleanSuccess, getCircuitState } from './circuit-breaker.mjs';
import { getRouterStatusSummary } from './router-cli.mjs';
import {
  distillText,
  ensureEmbedModelWarm,
  getGpuStatusSnapshot,
  indexWorkspaceVectors,
  loadGpuConfig,
  runLocalProjectChat,
  unloadAllModels,
} from './local-gpu-engine.mjs';
import { RamMemoryEngine } from './ram-memory-engine.mjs';
import { formatSemanticSearchHeader } from './ram-memory-mcp.mjs';
import { ingestRuntimeFault } from './runtime-wiretap.mjs';
import { extractVariableSlice } from '../skills/program-slicer-ocd/scripts/slice-variable.mjs';
import { runCodemod } from '../skills/ast-codemod-refactor/scripts/run-codemod.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function mapModelToGemini4Route(grade, recommendedModel = '', { batch = false } = {}) {
  const batchNote = batch
    ? ' | Batch API (-50%): $0.75/$3.75 (Hydrogen), $1.50/$7.50 (Neon)'
    : ' | Implicit Cache >=4096 tok prefix & >=2050 tok turn delta';
  if (grade === 'L' || grade === 'XL' || recommendedModel === 'pro') {
    return {
      primary: 'Orchestrator (Neon ↔ Hydrogen) / Orchestrator (Carbon) / gemini-4-neon (XHigh)',
      scout: 'gemini-flash-lite (scout) / gemini-4-hydrogen-medium or gemini-4-neon-medium (workers)',
      mode: `Planner (Neon/Carbon) + Executor (Hydrogen)${batch ? ' [Batch Mode]' : ''}`,
      thinkingBudget: `Unthrottled Compact EN Thinking (set max_output_tokens >= 32768; preserve thoughtSignature)${batchNote}`,
    };
  }
  if (grade === 'M') {
    return {
      primary: 'gemini-4-hydrogen (medium/high) — beats Argon baseline (51 vs 50) at $1.50/$7.50 (escalate to Neon $3/$15 only on Deep/Blast)',
      scout: 'gemini-flash-lite',
      mode: `Direct Hydrogen Editor + CLI Guardrails${batch ? ' [Batch Mode]' : ''}`,
      thinkingBudget: `Compact EN Thinking (medium default; preserve thoughtSignature)${batchNote}`,
    };
  }
  return {
    primary: 'gemini-4-hydrogen (medium) or gemini-3.8-flash',
    scout: 'none (Zero-Turn CLI)',
    mode: `Single-Shot Fast Hydrogen${batch ? ' [Batch Mode]' : ''}`,
    thinkingBudget: `Minimal/Medium EN Thinking${batchNote}`,
  };
}

function printHelp() {
  console.log(`
╔════════════════════════════════════════════════════════════════════════════╗
║  🚀 THE TUNNEL v4.0.1 — GEMINI 4 + 12GB RAM + LOCAL GPU CLI                ║
╚════════════════════════════════════════════════════════════════════════════╝

Usage: node ag-cli.mjs <command> [arguments]

🧠 CONTEXT & ROUTING (Zero-Turn Token Savers):
  context "<prompt>" [dir] [--batch] [--gateway <url>]
                                  Build Zero-Turn Prompt Package:
                                  Grade (S/M/L/XL), Gemini 4 route, Batch API rates,
                                  Combo Failover target (supports OMNIROUTE_BASE_URL),
                                  Tech Spec, Gold Slices, RepoMap & Pitfalls.
  repomap [dir] [maxChars]        PageRank-sorted repository map (default 4000 chars).
  gold "<query>" [dir]            Extract Zero-Turn Gold Context function slices + X-Ray.
  dossier "<prompt>" [dir]        Build 5-Phase Architect Dossier for Gemini 4 Neon / Carbon / Orchestrator.
  slice <file> <symbol> [line]    Program Slicer OCD: extract only lines mutating/using symbol.
  usages <symbol> [dir]           Find all usages of an exported symbol across the repo.
  blast <file> [dir]              Blast Radius: reverse importers & contract dependencies.
  chronos [dir] [--reset]         Repo Chronos: AST symbol diff since last snapshot.
  dead-exports [dir]              Find unused exported functions/classes across repo.

🛠️ SAFE EDITING & SELF-HEALING EXECUTION:
  patch <file> [patchFile|-]      Apply <<<<<<< SEARCH ... >>>>>>> REPLACE block with:
                                  1) Shadow Checkpoint, 2) In-RAM Syntax Check, 3) Contract Check.
  verify <file> [dir]             Run Syntax Check + Import Contract Check + Impacted Micro-Tests.
  run "<command>" [--gpu]         Execute shell command via Security Guard + Observation Masker
                                  (add --gpu to distill huge logs on local RTX GPU).
  watch <command...>              Live Runtime Wiretap: stream output & auto-capture crashes into UI.
  gpu <status|warm|search|distill|unload>
                                  Manage local RTX GPU / Ollama (12 GB VRAM cap):
                                    status, warm [dir], search "<q>" [dir],
                                    distill "<q>" [file|-], unload.
  codemod --find <A> --replace <B> [--word] [--regex] [--dry-run] [dir]
                                  Multi-file deterministic refactor with syntax rollback.
  rollback [latest|<id>]          Restore file from Shadow Checkpoint (or 'list' checkpoints).

📊 TELEMETRY & MEMORY:
  status [dir]                    Router status, Bayesian domain priors & Circuit Breaker.
  pitfalls [dir]                  Show or record project Pitfall Ledger (anti-repeat memory).
  handoff [dir]                   Show cross-session Handoff & Project Passport.
`);
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = (args[0] || 'help').toLowerCase();

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    printHelp();
    process.exit(0);
  }

  if (cmd === 'context') {
    const isBatch = args.includes('--batch');
    let wsFlagDir = '';
    let gatewayFlag = '';
    const cleanArgs = [];
    for (let i = 1; i < args.length; i++) {
      const a = args[i];
      if (a === '--batch') continue;
      if (a === '--ws' && i + 1 < args.length) {
        wsFlagDir = args[++i];
        continue;
      }
      if (a.startsWith('--ws=')) {
        wsFlagDir = a.slice(5);
        continue;
      }
      if (a === '--gateway' && i + 1 < args.length) {
        gatewayFlag = args[++i];
        continue;
      }
      if (a.startsWith('--gateway=')) {
        gatewayFlag = a.slice(10);
        continue;
      }
      if (a.startsWith('-')) continue;
      cleanArgs.push(a);
    }
    const prompt = cleanArgs[0] || '';
    const rootDir = path.resolve(wsFlagDir || cleanArgs[1] || process.cwd());
    if (!prompt) {
      console.error('Error: Provide a task prompt. Example: node ag-cli.mjs context "Fix auth token refresh bug"');
      process.exit(1);
    }

    const gradeInfo = estimateTaskGradeAndThinkingBudget(prompt, { heavyThreshold: 'L' }, { wsPath: rootDir });
    const route = mapModelToGemini4Route(gradeInfo.grade, gradeInfo.recommendedModel, { batch: isBatch });
    const comboName = gradeInfo.grade === 'XL' || gradeInfo.grade === 'L' ? 'deep_architect' : (gradeInfo.grade === 'S' ? 'budget_fast' : 'daily_coding');
    let localGpuAvailable = false;
    try {
      const stateFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'router-state.json');
      if (fs.existsSync(stateFile)) {
        const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        localGpuAvailable = Boolean(st?.gpuEnabled);
      }
    } catch {}
    const comboPick = resolveComboFailoverTarget({ combo: comboName, localGpuAvailable });
    const rawGateway = (gatewayFlag || process.env.OMNIROUTE_BASE_URL || '').trim();
    const safeGateway = /^https?:\/\/[^\s]+$/i.test(rawGateway) ? rawGateway : '';
    const techSpec = compileUserIntentToTechSpec(prompt, { wsPath: rootDir });
    const gold = extractGoldContextSlices(rootDir, prompt, { maxFiles: 3, maxTotalChars: 3200 });
    const repoMap = getCompactRankedRepoMap(rootDir, 2500);
    const pitfalls = formatPitfallsForSessionStart(rootDir);
    const handoff = formatHandoffForSessionStart(rootDir);

    console.log(`# 🎯 Gemini 4 Route & Zero-Turn Context${isBatch ? ' (Batch API -50%)' : ''}`);
    console.log(`- **Task Complexity**: ${gradeInfo.grade} (${gradeInfo.reason || 'heuristic + scope'})`);
    console.log(`- **Recommended Model**: ${route.primary}`);
    console.log(`- **Failover Combo (${comboPick.combo})**: ${comboPick.selected} (chain: ${comboPick.chain.join(' -> ')})`);
    if (safeGateway) {
      console.log(`- **External AI Gateway**: ${safeGateway}`);
    }
    console.log(`- **Scout / Worker**: ${route.scout}`);
    console.log(`- **Execution Mode**: ${route.mode}`);
    console.log(`- **Thinking Protocol**: ${route.thinkingBudget}`);
    const specText = techSpec?.formattedSpec || techSpec?.formatted || '';
    if (specText) {
      console.log(`\n${specText}`);
    }
    if (pitfalls) {
      console.log(`\n${pitfalls}`);
    }
    if (handoff) {
      console.log(`\n${handoff}`);
    }
    const goldText = gold?.formattedHint || gold?.formatted || '';
    if (goldText) {
      console.log(`\n## ⚡ Zero-Turn Gold Context Slices (Read-Once — Do Not Re-Read Full Files)\n${goldText}`);
    }
    if (repoMap && (repoMap.markdown || typeof repoMap === 'string')) {
      console.log(`\n## 🗺️ PageRank RepoMap\n${repoMap.markdown || repoMap}`);
    }
    return;
  }

  if (cmd === 'repomap') {
    const rootDir = path.resolve(args[1] || process.cwd());
    const maxChars = args[2] ? parseInt(args[2], 10) : 4000;
    const rm = getCompactRankedRepoMap(rootDir, maxChars);
    console.log(rm.markdown || rm);
    return;
  }

  if (cmd === 'gold') {
    const query = args[1] || '';
    const rootDir = path.resolve(args[2] || process.cwd());
    if (!query) {
      console.error('Usage: node ag-cli.mjs gold "<search query or prompt>" [dir]');
      process.exit(1);
    }
    const res = extractGoldContextSlices(rootDir, query, { maxFiles: 4, maxTotalChars: 4500 });
    console.log(typeof res === 'string' ? res : (res?.formatted || 'No matching slices found.'));
    return;
  }

  if (cmd === 'dossier') {
    const prompt = args[1] || '';
    const rootDir = path.resolve(args[2] || process.cwd());
    const res = buildArchitectPlanDossier(rootDir, prompt, 5);
    console.log(typeof res === 'string' ? res : (res?.formatted || JSON.stringify(res, null, 2)));
    return;
  }

  if (cmd === 'slice') {
    const file = args[1];
    const symbol = args[2];
    const focusLine = args[3] ? parseInt(args[3], 10) : 0;
    if (!file || !symbol) {
      console.error('Usage: node ag-cli.mjs slice <file> <symbol> [focusLine]');
      process.exit(1);
    }
    const res = extractVariableSlice(file, symbol, { focusLine });
    console.log(res.formatted || res.summary || JSON.stringify(res, null, 2));
    return;
  }

  if (cmd === 'usages') {
    const symbol = args[1];
    const rootDir = path.resolve(args[2] || process.cwd());
    if (!symbol) {
      console.error('Usage: node ag-cli.mjs usages <symbol> [dir]');
      process.exit(1);
    }
    const res = findSymbolUsagesAcrossRepo(rootDir, symbol);
    console.log(typeof res === 'string' ? res : (res?.formatted || JSON.stringify(res, null, 2)));
    return;
  }

  if (cmd === 'blast') {
    const file = args[1];
    const rootDir = path.resolve(args[2] || process.cwd());
    if (!file) {
      console.error('Usage: node ag-cli.mjs blast <file> [dir]');
      process.exit(1);
    }
    const rev = findReverseImporters(rootDir, path.resolve(file), 12);
    const contracts = verifyImportContracts(rootDir, path.resolve(file));
    console.log(`💥 [Blast Radius] Target: ${file}`);
    console.log(`Reverse dependents (${rev.dependents?.length || 0}):`);
    for (const d of rev.dependents || []) {
      console.log(`  - ${d.file || d.relPath} (imports: ${(d.importedSymbols || []).join(', ') || '*'})`);
    }
    const brokenList = (contracts.brokenImports || [])
      .map((b) => `${b.dependentFile}: missing ${(b.missingSymbols || []).join(', ')}`)
      .join('; ');
    console.log(`Contract check: ${contracts.valid ? '✅ OK' : '❌ BROKEN -> ' + brokenList}`);
    return;
  }

  if (cmd === 'chronos') {
    const resetBaseline = args.includes('--reset');
    const dir = args.slice(1).find(a => !a.startsWith('--')) || process.cwd();
    const res = diffRepoChronos(path.resolve(dir), { resetBaseline });
    console.log(res.formatted || JSON.stringify(res, null, 2));
    return;
  }

  if (cmd === 'dead-exports') {
    const dir = path.resolve(args[1] || process.cwd());
    const res = findDeadExports(dir);
    console.log(res.formatted || JSON.stringify(res, null, 2));
    return;
  }

  if (cmd === 'patch') {
    const targetFile = args[1];
    const patchSource = args[2] || '-';
    if (!targetFile) {
      console.error('Usage: node ag-cli.mjs patch <targetFile> [patchFile | - for stdin]');
      process.exit(1);
    }
    const resolvedTarget = path.resolve(targetFile);
    const patchText = patchSource === '-'
      ? fs.readFileSync(0, 'utf8')
      : fs.readFileSync(path.resolve(patchSource), 'utf8');

    // 1. Create Shadow Checkpoint before modifying
    const cp = createShadowCheckpoint({ filePath: resolvedTarget, toolName: 'ag-cli:patch' });
    try {
      // 2. Apply transactional SEARCH/REPLACE (includes in-RAM syntax check)
      const res = applySearchReplace(resolvedTarget, patchText);
      // 3. Verify import contracts
      const contracts = verifyImportContracts(process.cwd(), resolvedTarget);
      recordCleanSuccess(resolvedTarget);
      recordHandoffAction({
        workspaceRoot: process.cwd(),
        filePath: resolvedTarget,
        toolName: 'ag-cli:patch',
        verifyOk: Boolean(contracts.valid),
      });
      console.log(`✅ [Transactional Patch OK] Applied ${res.appliedBlocks} block(s) to ${ path.basename(resolvedTarget) } (saved ${res.savedOutputChars} chars).`);
      if (cp?.id) {
        console.log(`🛡️ [Shadow Checkpoint] ID: ${cp.id} (rollback with: node ag-cli.mjs rollback ${cp.id})`);
      }
      if (!contracts.valid) {
        console.warn(
          `⚠️ [Contract Warning] Broken imports detected:\n` +
          (contracts.brokenImports || []).map((b) => `  - ${b.dependentFile} expects ${(b.missingSymbols || []).join(', ')}`).join('\n')
        );
      }
    } catch (err) {
      recordErrorFingerprint({ source: 'edit', errorText: err.message, filePath: resolvedTarget });
      console.error(`❌ [Patch Aborted] ${err.message}`);
      process.exit(1);
    }
    return;
  }

  if (cmd === 'patch-symbol') {
    const targetFile = args[1];
    const symbolName = args[2];
    const repSource = args[3] || '-';
    if (!targetFile || !symbolName) {
      console.error('Usage: node ag-cli.mjs patch-symbol <targetFile> <symbol> [replacementFile | - for stdin]');
      process.exit(1);
    }
    const resolvedTarget = path.resolve(targetFile);
    const replacementCode = repSource === '-'
      ? fs.readFileSync(0, 'utf8')
      : fs.readFileSync(path.resolve(repSource), 'utf8');
    const cp = createShadowCheckpoint({ filePath: resolvedTarget, toolName: 'ag-cli:patch-symbol' });
    try {
      const res = applySymbolReplacement(resolvedTarget, symbolName, replacementCode);
      const contracts = verifyImportContracts(process.cwd(), resolvedTarget);
      recordCleanSuccess(resolvedTarget);
      console.log(`✅ [Symbol Patch OK] Replaced ${res.symbol} [L${res.startLine}-${res.endLine}] in ${path.basename(resolvedTarget)} (${res.oldBytes}->${res.newBytes}B).`);
      if (cp?.id) {
        console.log(`🛡️ [Shadow Checkpoint] ID: ${cp.id}`);
      }
      if (!contracts.valid) {
        console.warn(`⚠️ [Contract Warning] Broken imports: ${(contracts.brokenImports || []).length}`);
      }
    } catch (err) {
      recordErrorFingerprint({ source: 'edit', errorText: err.message, filePath: resolvedTarget });
      console.error(`❌ [Symbol Patch Aborted] ${err.message}`);
      process.exit(1);
    }
    return;
  }

  if (cmd === 'verify') {
    const targetFile = args[1];
    const rootDir = path.resolve(args[2] || process.cwd());
    if (!targetFile) {
      console.error('Usage: node ag-cli.mjs verify <file> [dir]');
      process.exit(1);
    }
    const resolvedTarget = path.resolve(targetFile);
    const syn = verifyFileSyntax(resolvedTarget);
    const contracts = verifyImportContracts(rootDir, resolvedTarget);
    const tests = await runImpactedMicroTests({ rootDir, filePath: resolvedTarget, timeoutMs: 4000 });

    console.log(`🔍 [Self-Verify] ${path.basename(resolvedTarget)}:`);
    console.log(`  1. Syntax (${syn.checker}): ${syn.valid ? '✅ OK' : '❌ FAIL: ' + syn.error}`);
    console.log(`  2. Import Contracts: ${contracts.valid ? '✅ OK' : '❌ BROKEN (' + (contracts.brokenImports?.length || 0) + ')'}`);
    if (tests.ran) {
      console.log(`  3. Impacted Micro-Tests (${(tests.testFiles || []).map(f => path.basename(f)).join(', ')}): ${tests.valid ? '✅ PASS' : '❌ FAIL'}`);
      if (!tests.valid && tests.error) {
        console.log(`     Failure: ${tests.error}`);
        recordPitfall({
          type: 'test_fail',
          fileName: path.basename(resolvedTarget),
          summary: String(tests.error).slice(0, 120),
          workspaceRoot: rootDir
        });
      }
    } else {
      console.log(`  3. Impacted Micro-Tests: ⏭️ None coupled`);
    }

    const allOk = Boolean(syn.valid && contracts.valid && (!tests.ran || tests.valid));
    recordModelOutcome({
      domain: 'algo_refactor',
      filePath: resolvedTarget,
      success: allOk
    });
    if (!allOk) process.exit(1);
    return;
  }

  if (cmd === 'run') {
    const noGpu = args.includes('--no-gpu');
    const rawCmd = args.slice(1).filter((a) => a !== '--gpu' && a !== '--no-gpu').join(' ');
    if (!rawCmd) {
      console.error('Usage: node ag-cli.mjs run "<shell command>" [--gpu|--no-gpu]');
      process.exit(1);
    }
    const sec = checkCommandSecurity({ commandLine: rawCmd, workspaceRoot: process.cwd() });
    if (!sec.allow) {
      console.error(`🛑 [Security Guard Blocked] ${sec.reason}`);
      process.exit(2);
    }

    const isWin = process.platform === 'win32';
    const shell = isWin ? 'powershell.exe' : '/bin/sh';
    const winUtf8Prefix = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8; ';
    const shellArgs = isWin ? ['-NoProfile', '-Command', `${winUtf8Prefix}${rawCmd}`] : ['-c', rawCmd];

    const child = spawnSync(shell, shellArgs, {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024
    });

    const combined = `${child.stdout || ''}\n${child.stderr || ''}`.trim();
    const exitCode = child.status ?? 1;
    const cleaned = redactSecretsInText(combined);
    const masked = noGpu
      ? maskTerminalOutput(cleaned, exitCode, { recordToBreaker: false, enableCcr: true, workspaceRoot: process.cwd() })
      : await maskTerminalOutputSmart(cleaned, exitCode, { recordToBreaker: false, enableCcr: true, workspaceRoot: process.cwd(), query: rawCmd.slice(0, 160) });

    if (exitCode !== 0) {
      const cb = recordErrorFingerprint({ source: 'cmd', errorText: masked.masked });
      if (cb.tripped) {
        console.error(`\n⚡ [CIRCUIT BREAKER TRIPPED] ${cb.reason || 'Repeated command failure'}`);
        console.error(`👉 Escalate to Gemini 4 Neon / Carbon / Orchestrator and change architectural approach!`);
      }
    } else {
      recordCleanSuccess();
    }

    console.log(masked.masked);
    process.exit(exitCode);
  }

  if (cmd === 'codemod') {
    let rootDir = process.cwd();
    let find = '';
    let replace = '';
    let isRegex = false;
    let wordBoundary = false;
    let dryRun = false;

    const codemodArgs = args.slice(1);
    for (let i = 0; i < codemodArgs.length; i++) {
      const a = codemodArgs[i];
      if (a === '--find' && i + 1 < codemodArgs.length) find = codemodArgs[++i];
      else if (a === '--replace' && i + 1 < codemodArgs.length) replace = codemodArgs[++i];
      else if (a === '--word') wordBoundary = true;
      else if (a === '--regex') isRegex = true;
      else if (a === '--dry-run') dryRun = true;
      else if (!a.startsWith('-')) rootDir = a;
    }
    const res = runCodemod({ rootDir: path.resolve(rootDir), find, replace, isRegex, wordBoundary, dryRun });
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (cmd === 'rollback') {
    const target = args[1] || 'latest';
    if (target === 'list') {
      const list = listCheckpoints(15);
      console.log(JSON.stringify(list, null, 2));
      return;
    }
    const res = rollbackCheckpoint(target);
    console.log(res.formatted || JSON.stringify(res, null, 2));
    return;
  }

  if (cmd === 'pitfalls') {
    const dir = path.resolve(args[1] || process.cwd());
    console.log(formatPitfallsForSessionStart(dir) || 'No pitfalls recorded yet.');
    return;
  }

  if (cmd === 'handoff') {
    const dir = path.resolve(args[1] || process.cwd());
    console.log(formatHandoffForSessionStart(dir) || 'No session handoff recorded yet.');
    return;
  }

  if (cmd === 'gpu') {
    const sub = (args[1] || 'status').toLowerCase();
    if (sub === 'status') {
      const snap = await getGpuStatusSnapshot();
      console.log(JSON.stringify(snap, null, 2));
      return;
    }
    if (sub === 'unload') {
      const u = await unloadAllModels();
      console.log(JSON.stringify(u, null, 2));
      return;
    }
    if (sub === 'warm') {
      const dir = path.resolve(args[2] || process.cwd());
      const ram = new RamMemoryEngine();
      try {
        const ws = ram.ensureWarm(dir);
        if (!ws) {
          console.error(`Invalid workspace: ${dir}`);
          process.exit(1);
        }
        const res = await indexWorkspaceVectors(ws.absRoot, ws.files, { maxNewFiles: 500 });
        if (res?.ok && res.cached) {
          await ensureEmbedModelWarm();
        }
        console.log(JSON.stringify(res, null, 2));
      } finally {
        ram.close();
      }
      return;
    }
    if (sub === 'search') {
      const query = args[2] || '';
      const dir = path.resolve(args[3] || process.cwd());
      if (!query) {
        console.error('Usage: node ag-cli.mjs gpu search "<query>" [dir]');
        process.exit(1);
      }
      const ram = new RamMemoryEngine();
      try {
        const res = await ram.searchSemantic(dir, query, { maxResults: 6, contextLines: 2 });
        const header = res.ok ? formatSemanticSearchHeader(res) : '';
        console.log(res.formatted ? `${header}${res.formatted}` : JSON.stringify(res, null, 2));
      } finally {
        ram.close();
      }
      return;
    }
    if (sub === 'distill') {
      const query = args[2] || '';
      const src = args[3] || '-';
      const text = src === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(path.resolve(src), 'utf8');
      const res = await distillText({ text, query, mode: 'general' });
      console.log(res.ok ? res.summary : `ERROR: ${res.error}`);
      if (!res.ok) process.exit(1);
      return;
    }
    if (sub === 'chat') {
      const query = args[2] || '';
      const dir = path.resolve(args[3] || process.cwd());
      if (!query) {
        console.error('Usage: node ag-cli.mjs gpu chat "<query>" [dir]');
        process.exit(1);
      }
      const ram = new RamMemoryEngine();
      try {
        const ws = ram.ensureWarm(dir);
        if (!ws) {
          console.error(`Invalid workspace: ${dir}`);
          process.exit(1);
        }
        const gpuCfg = loadGpuConfig();
        if (gpuCfg.gpuEnabled && gpuCfg.gpuSemanticSearch) {
          await indexWorkspaceVectors(ws.absRoot, ws.files, { maxNewFiles: 20 }).catch(() => null);
        }
        const sem = await ram.searchSemantic(dir, query, {
          maxResults: 6,
          contextLines: 3,
          reindexMissing: false,
        });
        const hits = Array.isArray(sem?.results) ? sem.results : [];
        const pack = typeof ram.buildGroundedChatPack === 'function'
          ? ram.buildGroundedChatPack(dir, query, {
              maxChars: 8400,
              warmSemanticHits: hits,
            })
          : ram.getContextPack(dir, query, {
              maxChars: 6800,
              warmSemanticHits: hits,
              toon: true,
            });
        const ragSources = [];
        const seenSrc = new Set();
        for (const h of [...(Array.isArray(pack?.sources) ? pack.sources : []), ...hits]) {
          const rel = String(h?.file || h?.relPath || '').trim();
          if (!rel) continue;
          const startLine = Number(h?.startLine || h?.line || 1);
          const endLine = Number(h?.endLine || startLine);
          const sKey = `${rel}:${startLine}-${endLine}`;
          if (seenSrc.has(sKey)) continue;
          seenSrc.add(sKey);
          ragSources.push({
            file: rel,
            startLine,
            endLine,
            score: Number(h?.rerankScore ?? h?.hybridScore ?? h?.similarity ?? h?.score ?? 0),
          });
          if (ragSources.length >= 6) break;
        }
        const chatRes = await runLocalProjectChat({
          query,
          ragContext: pack?.formatted || sem?.formatted || '',
          ragSources,
          verifiedManifest: pack?.verifiedManifest || '',
          repoFiles: Array.isArray(pack?.repoFiles) ? pack.repoFiles : [],
          repoSymbols: Array.isArray(pack?.repoSymbols) ? pack.repoSymbols : [],
          symbolsByFile: pack?.symbolsByFile && typeof pack.symbolsByFile === 'object' ? pack.symbolsByFile : {},
          fetchExtraSlicesFn: typeof ram.findSymbolSlicesFast === 'function'
            ? (syms) => ram.findSymbolSlicesFast(ws.absRoot, syms, { maxSlices: 3, maxLinesPerSlice: 38 })
            : null,
          workspaceName: path.basename(ws.absRoot),
        });
        if (!chatRes.ok) {
          console.error(`ERROR: ${chatRes.error || 'Local RAG chat failed'}`);
          process.exit(1);
        }
        console.log(`[${chatRes.model} | ${chatRes.contextTokensEst} tok | ${chatRes.latencyMs}ms | 0 cloud quota]\n`);
        console.log(chatRes.answer);
        if (Array.isArray(chatRes.sources) && chatRes.sources.length > 0) {
          console.log(
            `\nИсточники: ${chatRes.sources.map((s) => `${s.file}:L${s.startLine}-${s.endLine}`).join(', ')}`
          );
        }
      } finally {
        ram.close();
      }
      return;
    }
    console.error(`Unknown gpu subcommand: ${sub}`);
    process.exit(1);
  }

  if (cmd === 'watch') {
    const rawCmdParts = args.slice(1).filter(Boolean);
    if (rawCmdParts.length === 0) {
      console.error('Usage: node ag-cli.mjs watch <command...>');
      process.exit(1);
    }
    const rawCmdStr = rawCmdParts.join(' ').trim();
    const sec = checkCommandSecurity(rawCmdStr, process.cwd());
    if (sec && (sec.allowed === false || sec.allow === false)) {
      console.error(`Security Guard blocked watch command: ${sec.reason}`);
      process.exit(1);
    }
    const tokens = rawCmdParts.length === 1
      ? rawCmdParts[0].match(/"[^"]*"|'[^']*'|\S+/g)?.map((t) => t.replace(/^["']|["']$/g, '')) || []
      : rawCmdParts;
    let bin = tokens[0] || '';
    if (/^node(?:\.exe)?$/i.test(bin)) bin = process.execPath;
    const childArgs = tokens.slice(1);
    let capturedErr = '';
    const faultRx = /(?:Error|Exception|AssertionError|TypeError|ReferenceError|SyntaxError|Unhandled|FATAL|panic:)/i;

    await new Promise((resolveWatch) => {
      const child = spawn(bin, childArgs, {
        cwd: process.cwd(),
        stdio: ['inherit', 'pipe', 'pipe'],
        windowsHide: false,
        shell: false,
      });
      child.stdout?.on('data', (chunk) => {
        const txt = chunk.toString('utf8');
        process.stdout.write(txt);
        if (faultRx.test(txt)) {
          capturedErr = `${capturedErr}\n${txt}`.slice(-8000);
        }
      });
      child.stderr?.on('data', (chunk) => {
        const txt = chunk.toString('utf8');
        process.stderr.write(txt);
        capturedErr = `${capturedErr}\n${txt}`.slice(-8000);
        if (faultRx.test(txt)) {
          try {
            ingestRuntimeFault({
              workspaceRoot: process.cwd(),
              source: 'ag-watch',
              command: rawCmdStr,
              rawError: capturedErr,
              exitCode: 1,
            });
          } catch {}
        }
      });
      child.on('exit', (code) => {
        if ((code || 0) !== 0 && capturedErr.trim()) {
          try {
            ingestRuntimeFault({
              workspaceRoot: process.cwd(),
              source: 'ag-watch',
              command: rawCmdStr,
              rawError: capturedErr,
              exitCode: code || 1,
            });
          } catch {}
        }
        resolveWatch();
      });
      child.on('error', (err) => {
        try {
          ingestRuntimeFault({
            workspaceRoot: process.cwd(),
            source: 'ag-watch',
            command: rawCmdStr,
            rawError: err?.stack || err?.message || String(err),
            exitCode: 1,
          });
        } catch {}
        console.error(err?.message || err);
        resolveWatch();
      });
    });
    return;
  }

  if (cmd === 'status') {
    const dir = path.resolve(args[1] || process.cwd());
    const status = getRouterStatusSummary(dir);
    const bayes = getBayesianSummary();
    const cb = getCircuitState();
    console.log(status.formatted);
    console.log(`🤖 [Gemini 4 Profile] Executor: Hydrogen ($1.50/$7.50, Index 51–54) | Coding Sweet-Spot: Neon ($3/$15, Index 61) | Architect: Orchestrator (Neon/Carbon, -24% quota)`);
    console.log(`💾 [Gemini 4 Cache Rules] Prefix floor: >=4,096 tokens | Multi-turn delta: >=2,050 tokens | Interactions API: store:true preserves thoughtSignature`);
    const localPluginRoot = path.resolve(__dirname, '..');
    const installedPluginRoot = path.join(os.homedir(), '.gemini', 'config', 'plugins', 'antigravity-model-router');
    const routerStateCandidates = [
      path.join(installedPluginRoot, 'router-state.json'),
      path.join(localPluginRoot, 'router-state.json'),
    ];
    let configuredRamBudgetMb = 4096;
    for (const rsPath of routerStateCandidates) {
      try {
        if (fs.existsSync(rsPath)) {
          const rs = JSON.parse(fs.readFileSync(rsPath, 'utf8'));
          if (Number(rs?.ramMaxBudgetMb) > 0) {
            configuredRamBudgetMb = Number(rs.ramMaxBudgetMb);
            break;
          }
        }
      } catch {}
    }

    const checkPidAlive = (pidVal) => {
      const pidNum = Number(pidVal);
      if (!Number.isInteger(pidNum) || pidNum <= 0) return false;
      try {
        process.kill(pidNum, 0);
        return true;
      } catch (err) {
        return err?.code === 'EPERM';
      }
    };

    const daemonCandidates = [
      path.join(localPluginRoot, '.cache', 'ram-daemon.json'),
      path.join(installedPluginRoot, '.cache', 'ram-daemon.json'),
    ];
    let ramStatus = `Standby (starts via MCP ram-memory, budget ${configuredRamBudgetMb} MB)`;
    for (const dFile of daemonCandidates) {
      try {
        if (!fs.existsSync(dFile)) continue;
        const d = JSON.parse(fs.readFileSync(dFile, 'utf8'));
        const entries = [
          d,
          ...(d?.instances && typeof d.instances === 'object' ? Object.values(d.instances) : []),
        ];
        const liveInst = entries.find((inst) => inst?.port && checkPidAlive(inst.pid));
        if (liveInst) {
          const activeBudgetMb = Number(liveInst.budgetMb) > 0 ? Number(liveInst.budgetMb) : configuredRamBudgetMb;
          ramStatus = `Active PID ${Number(liveInst.pid)} on 127.0.0.1:${liveInst.port} (budget ${activeBudgetMb} MB)`;
          break;
        }
      } catch {}
    }
    console.log(`🧠 [In-RAM Memory] ${ramStatus}`);
    try {
      const gpuSnap = await getGpuStatusSnapshot();
      const hwText = gpuSnap.hardware?.available
        ? `${gpuSnap.hardware.name} (${gpuSnap.hardware.freeMb}/${gpuSnap.hardware.totalMb} MB free)`
        : 'No supported GPU detected';
      const ollText = gpuSnap.ollama?.running
        ? `Ollama ON (${gpuSnap.ollama.downloadedModels.length} downloaded, ${gpuSnap.ollama.loadedVramMb} MB VRAM loaded)`
        : `Ollama ${gpuSnap.ollama?.installed ? 'Installed/Standby' : 'Not installed'}`;
      console.log(`🎮 [Local GPU <=${gpuSnap.config.gpuMaxVramMb}MB] ${hwText} | ${ollText} | Saved: ~${gpuSnap.telemetry?.savedTokensEstimate || 0} tok`);
    } catch {}
    const isTripped = cb.status === 'TRIPPED';
    const domainCount = Array.isArray(bayes.domains)
      ? bayes.domains.length
      : Object.keys(bayes.domains || {}).length;
    console.log(`🔌 [Circuit Breaker] Status: ${isTripped ? 'TRIPPED' : 'OK'} | Repeat Count: ${cb.repeatCount || 0}`);
    console.log(`📊 [Bayesian Domains] Tracked domains: ${domainCount}`);
    return;
  }

  console.error(`Unknown command: ${cmd}. Run 'node ag-cli.mjs help' for usage.`);
  process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error(`Fatal CLI Error: ${err.message}`);
    process.exit(1);
  });
}

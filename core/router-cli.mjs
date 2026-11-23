#!/usr/bin/env node
/**
 * @file router-cli.mjs
 * @description Единый интерфейс командной строки (CLI) для The Tunnel v3.30.0.
 * Предоставляет команды диагностики, анализа символов, слайсинга, кодомода и резервного копирования профиля.
 */

import fs from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { atomicWriteJsonSync, safeReadJsonSync } from './safe-json.mjs';
import { sanitizeStatePatch } from '../sidecars/panel/server.mjs';
import { diffRepoChronos, findDeadExports, findSymbolUsagesAcrossRepo } from './repo-mapper.mjs';
import {
  appendLearnedPattern,
  appendLearnedPatternAi,
  distillPitfallsIntoSkills,
  distillPitfallsIntoSkillsAi,
  evolveReadyInstincts,
  listCrystallizedSkills,
} from './skill-crystallizer.mjs';
import { auditAgentEnvironment } from './agent-shield.mjs';
import { knowledgeHub } from './sqlite-knowledge-hub.mjs';
import { checkProjectCompletionInvariants, initAcceptanceGatesMarkdown } from './completion-gates.mjs';
import { formatProjectSetupReportRu, recommendProjectSetup } from './project-setup-recommender.mjs';
import { importSkillFromSource, searchSkillsCatalog } from './skill-registry-bridge.mjs';
import { clearExpiredComboCooldowns, DEFAULT_COMBO_CHAINS, recordComboProviderCooldown, resolveComboFailoverTarget } from './quota-pacer.mjs';
import { auditAllSkills, auditSkill } from '../skills/skill-architect/scripts/audit-skill.mjs';
import { extractVariableSlice } from '../skills/program-slicer-ocd/scripts/slice-variable.mjs';
import { runCodemod } from '../skills/ast-codemod-refactor/scripts/run-codemod.mjs';
import { applySymbolReplacement } from './diff-patcher.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(__dirname, '..');
const CACHE_DIR = join(PLUGIN_ROOT, '.cache');
const ROUTER_STATE_FILE = join(PLUGIN_ROOT, 'router-state.json');

function getRouterStateFile() {
  const envPath = typeof process.env.TUNNEL_TEST_STATE_PATH === 'string' ? process.env.TUNNEL_TEST_STATE_PATH.trim() : '';
  return envPath ? resolve(envPath) : ROUTER_STATE_FILE;
}

const GUARDRAIL_KEYS = [
  'repoMap',
  'toolPruning',
  'diffOnly',
  'obsMasking',
  'selfVerify',
  'cascadeVerify',
  'shadowCheckpoints',
  'transactionalPatch',
  'blastRadius',
  'circuitBreaker',
  'historyCompaction',
  'pitfallLedger',
  'thinkingLimiter',
  'pageRankGraph',
  'zeroTurnSlices',
  'bayesianRouter',
  'testImpactVerify',
  'sessionHandoff',
  'readDedup',
  'skillCrystallizer',
  'securityGuard',
  'configProtection',
  'completionGates',
  'ramCacheEnabled',
  'ramAutoWarmOnSessionStart',
  'gpuEnabled',
  'gpuAutoStart',
  'gpuAutoDistillLogs',
  'gpuSemanticSearch',
  'gpuShowPreTaskAdvice',
  'gpuUnloadOnExit',
  'gpuPostEditCritic',
  'cpuMulticoreEnabled',
  'cpuTrigramIndex',
  'cpuCrossRerank',
  'cpuParallelVerify',
  'orchestratorSmartSynergy',
  'swarmAutoVerifier',
  'swarmQuotaFailover',
  'showBadge',
  'confirmBeforeRun',
  'uiDesignPreviewGate',
  'ramSotaEngines',
  'gpuWarmHostRamCache',
  'cpuSotaEngines',
  'sentinelEnabled',
  'sentinelShadowGuard',
  'sentinelLocalBugBot',
  'sentinelSymbolCards',
  'sentinelSpeculativeWarm',
  'sentinelShadowTests',
  'lspBridgeEnabled',
  'sqliteKnowledgeEnabled',
  'shadowWorktreeEnabled',
  'runtimeWiretapEnabled',
  'quotaPacerEnabled',
  'composerVoiceEnabled',
  'mutationGuardEnabled',
  'floatingHudEnabled'
];

export const DEPRECATED_STATE_KEYS = [
  'recommendTeamwork',
  'recommendSkills',
  'activeSkillProfiles',
  'splitExecution',
  'chainOfDraft',
  'workerModel',
];

export function stripDeprecatedStateKeys(state = {}) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return {};
  const next = { ...state };
  for (const k of DEPRECATED_STATE_KEYS) {
    delete next[k];
  }
  return next;
}

const BACKUP_CACHE_FILES = [
  { key: 'domain-priors.json', candidates: ['domain-priors.json', 'bayesian-priors.json'] },
  { key: 'pitfalls-ledger.json', candidates: ['pitfalls-ledger.json', 'pitfall-ledger.json'] },
  { key: 'session-handoff.json', candidates: ['session-handoff.json'] },
  { key: 'project-passport.json', candidates: ['project-passport.json'] }
];

function resolveSafeBackupPath(backupPath = '', { allowArbitraryPath = false } = {}) {
  const defaultPath = join(CACHE_DIR, 'router-profile-backup.json');
  if (!backupPath || typeof backupPath !== 'string' || !backupPath.trim()) {
    return { ok: true, path: defaultPath };
  }
  const resolved = resolve(backupPath.trim());
  if (allowArbitraryPath === true) {
    return { ok: true, path: resolved };
  }
  const isInsideRoot = (candidate, rootDir) => {
    const norm = (p) => resolve(p).replace(/\\/g, '/').replace(/\/+$/, '');
    const c = process.platform === 'win32' ? norm(candidate).toLowerCase() : norm(candidate);
    const r = process.platform === 'win32' ? norm(rootDir).toLowerCase() : norm(rootDir);
    return c === r || c.startsWith(`${r}/`);
  };
  const allowedRoots = [CACHE_DIR, join(homedir(), '.gemini')];
  if (!allowedRoots.some((root) => isInsideRoot(resolved, root))) {
    return {
      ok: false,
      path: '',
      error: `Path policy blocked arbitrary backupPath outside .cache/~/.gemini: ${backupPath}`,
    };
  }
  return { ok: true, path: resolved };
}

/**
 * Создает полный слепок профиля маршрутизатора и кэша весов
 * @param {string} [backupPath='']
 * @param {{ allowArbitraryPath?: boolean }} [options={}]
 * @returns {{ ok: boolean, path: string, keysSaved: number, formatted: string, error?: string }}
 */
export function backupRouterProfile(backupPath = '', options = {}) {
  try {
    const pathCheck = resolveSafeBackupPath(backupPath, options);
    if (!pathCheck.ok) {
      return {
        ok: false,
        path: '',
        keysSaved: 0,
        error: pathCheck.error,
        formatted: `❌ [Profile Backup Blocked] ${pathCheck.error}`,
      };
    }
    const targetPath = pathCheck.path;
    const state = stripDeprecatedStateKeys(safeReadJsonSync(getRouterStateFile(), {}));

    const cacheFiles = {};
    for (const item of BACKUP_CACHE_FILES) {
      for (const cand of item.candidates) {
        const candPath = join(CACHE_DIR, cand);
        if (fs.existsSync(candPath)) {
          const content = safeReadJsonSync(candPath, null);
          if (content !== null) {
            cacheFiles[item.key] = content;
            break;
          }
        }
      }
    }

    const pluginMeta = safeReadJsonSync(join(PLUGIN_ROOT, 'plugin.json'), {});
    const snapshot = {
      version: String(pluginMeta?.version || '3.30.0'),
      createdAt: new Date().toISOString(),
      state,
      cacheFiles
    };

    atomicWriteJsonSync(targetPath, snapshot);

    // Также дублируем в ~/.gemini/router-profile-backup.json для защиты от очистки .cache
    if (process.env.TUNNEL_TEST_ISOLATE_INSTALLED !== '1') {
      try {
        const geminiDir = join(homedir(), '.gemini');
        if (!fs.existsSync(geminiDir)) {
          fs.mkdirSync(geminiDir, { recursive: true });
        }
        const homeBackupPath = join(geminiDir, 'router-profile-backup.json');
        atomicWriteJsonSync(homeBackupPath, snapshot);
      } catch {}
    }

    const sectionsSaved = Object.keys(cacheFiles).length + 1;
    const stateKeysCount = Object.keys(state || {}).length;
    const keysSaved = stateKeysCount > 0 ? stateKeysCount : sectionsSaved;
    return {
      ok: true,
      path: targetPath,
      keysSaved,
      sectionsSaved,
      formatted: `💾 [Profile Backup] Saved snapshot to ${targetPath} (${keysSaved} keys, ${sectionsSaved} sections preserved).`
    };
  } catch (err) {
    return {
      ok: false,
      path: backupPath,
      keysSaved: 0,
      error: err.message,
      formatted: `❌ [Profile Backup Failed] ${err.message}`
    };
  }
}

/**
 * Восстанавливает профиль маршрутизатора и кэшированные веса из резервной копии
 * @param {string} [backupPath='']
 * @param {{ allowArbitraryPath?: boolean }} [options={}]
 * @returns {{ ok: boolean, path: string, restoredKeys: number, formatted: string, error?: string }}
 */
export function restoreRouterProfile(backupPath = '', options = {}) {
  try {
    let sourcePath = '';
    const candidates = [];
    if (backupPath) {
      const pathCheck = resolveSafeBackupPath(backupPath, options);
      if (!pathCheck.ok) {
        return {
          ok: false,
          path: '',
          restoredKeys: 0,
          error: pathCheck.error,
          formatted: `❌ [Profile Restore Blocked] ${pathCheck.error}`,
        };
      }
      candidates.push(pathCheck.path);
    }
    if (process.env.TUNNEL_TEST_ISOLATE_INSTALLED !== '1') {
      candidates.push(join(homedir(), '.gemini', 'router-profile-backup.json'));
    }
    candidates.push(join(CACHE_DIR, 'router-profile-backup.json'));

    for (const cand of candidates) {
      if (fs.existsSync(cand)) {
        sourcePath = cand;
        break;
      }
    }

    if (!sourcePath) {
      return {
        ok: false,
        path: '',
        restoredKeys: 0,
        error: 'Backup file not found in candidates',
        formatted: '❌ [Profile Restore] No backup snapshot found.'
      };
    }

    const snapshot = safeReadJsonSync(sourcePath, null);
    if (!snapshot || typeof snapshot !== 'object') {
      return {
        ok: false,
        path: sourcePath,
        restoredKeys: 0,
        error: 'Invalid backup snapshot structure',
        formatted: `❌ [Profile Restore] Failed to parse backup from ${sourcePath}.`
      };
    }

    const ALLOWED_RESTORE_CACHE_MAP = new Map([
      ['bayesian-priors.json', 'domain-priors.json'],
      ['domain-priors.json', 'domain-priors.json'],
      ['pitfall-ledger.json', 'pitfalls-ledger.json'],
      ['pitfalls-ledger.json', 'pitfalls-ledger.json'],
      ['session-handoff.json', 'session-handoff.json'],
      ['project-passport.json', 'project-passport.json'],
    ]);

    const cacheFiles = snapshot.cacheFiles && typeof snapshot.cacheFiles === 'object' && !Array.isArray(snapshot.cacheFiles)
      ? snapshot.cacheFiles
      : {};
    for (const key of Object.keys(cacheFiles)) {
      if (basename(key) !== key || key.includes('..') || key.includes('/') || key.includes('\\') || !ALLOWED_RESTORE_CACHE_MAP.has(key)) {
        return {
          ok: false,
          path: sourcePath,
          restoredKeys: 0,
          error: `Blocked unsafe or unknown cacheFiles key in backup: ${key}`,
          formatted: `❌ [Profile Restore Blocked] Unsafe cache key '${key}' in backup snapshot.`
        };
      }
    }

    let sectionsRestored = 0;
    let stateKeysRestored = 0;
    if (snapshot.state && typeof snapshot.state === 'object' && !Array.isArray(snapshot.state)) {
      const stateFile = getRouterStateFile();
      const prevState = stripDeprecatedStateKeys(safeReadJsonSync(stateFile, {}));
      const cleanPatch = sanitizeStatePatch(snapshot.state);
      const safeMerged = sanitizeStatePatch({ ...prevState, ...cleanPatch });
      atomicWriteJsonSync(stateFile, {
        ...safeMerged,
        updatedAt: new Date().toISOString(),
      });
      stateKeysRestored = Object.keys(safeMerged).length;
      sectionsRestored++;
    }

    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
    }

    for (const [key, data] of Object.entries(cacheFiles)) {
      const targetName = ALLOWED_RESTORE_CACHE_MAP.get(key);
      atomicWriteJsonSync(join(CACHE_DIR, targetName), data);
      sectionsRestored++;
    }

    const restoredKeys = stateKeysRestored > 0 ? stateKeysRestored : sectionsRestored;
    return {
      ok: true,
      path: sourcePath,
      restoredKeys,
      sectionsRestored,
      formatted: `📂 [Profile Restore] Successfully restored snapshot from ${sourcePath} (${restoredKeys} keys, ${sectionsRestored} sections restored).`
    };
  } catch (err) {
    return {
      ok: false,
      path: backupPath,
      restoredKeys: 0,
      error: err.message,
      formatted: `❌ [Profile Restore Failed] ${err.message}`
    };
  }
}

/**
 * Возвращает сводку состояния маршрутизатора и защитных контуров
 * @param {string} [workspaceRoot=process.cwd()]
 * @returns {{ ok: boolean, version: string, activeGuardrails: number, totalGuardrails: number, strategy: string, skillsCount: number, formatted: string }}
 */
export function getRouterStatusSummary(workspaceRoot = process.cwd()) {
  const state = stripDeprecatedStateKeys(safeReadJsonSync(getRouterStateFile(), {}));
  const activeGuardrails = GUARDRAIL_KEYS.filter(k => state[k] !== false).length;
  const totalGuardrails = GUARDRAIL_KEYS.length;
  const strategy = state.strategy || 'flash_dispatcher';
  const hookProfile = state.hookProfile || 'standard';
  let skillsCount = 10;
  try {
    const skDir = join(PLUGIN_ROOT, 'skills');
    if (fs.existsSync(skDir)) {
      skillsCount = fs.readdirSync(skDir, { withFileTypes: true }).filter(d => d.isDirectory()).length;
    }
  } catch {}

  const pluginMeta = safeReadJsonSync(join(PLUGIN_ROOT, 'plugin.json'), {});
  const version = String(pluginMeta?.version || '3.30.0');
  const formatted = `🛡️ [Router Status] v${version} | Strategy: ${strategy} | Profile: ${hookProfile} | Guardrails: ${activeGuardrails}/${totalGuardrails} active | Skills: ${skillsCount} ready`;

  return {
    ok: true,
    version,
    activeGuardrails,
    totalGuardrails,
    strategy,
    hookProfile,
    skillsCount,
    formatted
  };
}

// Диспетчер командной строки CLI
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const cmd = args[0] || 'status';

  if (cmd === 'status') {
    const dir = args[1] || process.cwd();
    const res = getRouterStatusSummary(dir);
    console.log(res.formatted);
  } else if (cmd === 'usages') {
    const symbol = args[1];
    const dir = args[2] || process.cwd();
    if (!symbol) {
      console.error('Usage: node router-cli.mjs usages <symbol> [dir]');
      process.exit(1);
    }
    const res = findSymbolUsagesAcrossRepo(dir, symbol);
    console.log(res.formatted || JSON.stringify(res, null, 2));
  } else if (cmd === 'chronos') {
    const resetBaseline = args.includes('--reset');
    const dir = args.slice(1).find(a => !a.startsWith('--')) || process.cwd();
    const res = diffRepoChronos(dir, { resetBaseline });
    console.log(res.formatted || JSON.stringify(res, null, 2));
  } else if (cmd === 'dead-exports') {
    const dir = args[1] || process.cwd();
    const res = findDeadExports(dir);
    console.log(res.formatted || JSON.stringify(res, null, 2));
  } else if (cmd === 'slice') {
    const file = args[1];
    const symbol = args[2];
    const focusLine = args[3] ? parseInt(args[3], 10) : 0;
    if (!file || !symbol) {
      console.error('Usage: node router-cli.mjs slice <file> <symbol> [focusLine]');
      process.exit(1);
    }
    const res = extractVariableSlice(file, symbol, { focusLine });
    console.log(res.formatted || res.summary || JSON.stringify(res, null, 2));
  } else if (cmd === 'patch-symbol') {
    const file = args[1];
    const symbolName = args[2];
    const repFile = args[3];
    if (!file || !symbolName || !repFile) {
      console.error('Usage: node router-cli.mjs patch-symbol <file> <symbol> <replacementFile>');
      process.exit(1);
    }
    const code = fs.readFileSync(resolve(repFile), 'utf8');
    const res = applySymbolReplacement(file, symbolName, code);
    console.log(`✅ [Symbol Patch OK] ${res.symbol} [L${res.startLine}-${res.endLine}] (${res.oldBytes}->${res.newBytes}B)`);
  } else if (cmd === 'codemod') {
    let rootDir = process.cwd();
    let find = '';
    let replace = '';
    let isRegex = false;
    let wordBoundary = false;
    let dryRun = false;

    const codemodArgs = args.slice(1);
    for (let i = 0; i < codemodArgs.length; i++) {
      const a = codemodArgs[i];
      if (a === '--find' && i + 1 < codemodArgs.length) {
        find = codemodArgs[++i];
      } else if (a === '--replace' && i + 1 < codemodArgs.length) {
        replace = codemodArgs[++i];
      } else if (a === '--word') {
        wordBoundary = true;
      } else if (a === '--regex') {
        isRegex = true;
      } else if (a === '--dry-run') {
        dryRun = true;
      } else if (!a.startsWith('-')) {
        rootDir = a;
      }
    }
    const res = runCodemod({ rootDir, find, replace, isRegex, wordBoundary, dryRun });
    console.log(JSON.stringify(res, null, 2));
  } else if (cmd === 'backup') {
    const backupPath = args[1] || '';
    const res = backupRouterProfile(backupPath, { allowArbitraryPath: true });
    console.log(res.formatted || JSON.stringify(res, null, 2));
  } else if (cmd === 'restore') {
    const backupPath = args[1] || '';
    const res = restoreRouterProfile(backupPath, { allowArbitraryPath: true });
    console.log(res.formatted || JSON.stringify(res, null, 2));
  } else if (cmd === 'skills') {
    const skills = listCrystallizedSkills();
    console.log(`💎 [Skills Registry] Total: ${skills.length}`);
    for (const s of skills) {
      const modeTag = s.isRichSkill ? 'Rich Skill' : 'Capsule';
      const learnedTag = s.learnedPatternsCount > 0 ? ` | +${s.learnedPatternsCount} learned` : '';
      console.log(`  - ${s.slug} (${modeTag}, ${s.linesCount}L${learnedTag})`);
    }
  } else if (cmd === 'learn') {
    let skillSlug = 'custom-skill';
    let pattern = '';
    let category = 'recipe';
    let verifyCmd = '';
    const triggers = [];

    const learnArgs = args.slice(1);
    for (let i = 0; i < learnArgs.length; i++) {
      const a = learnArgs[i];
      if ((a === '--skill' || a === '-s') && i + 1 < learnArgs.length) {
        skillSlug = learnArgs[++i];
      } else if ((a === '--pattern' || a === '-p') && i + 1 < learnArgs.length) {
        pattern = learnArgs[++i];
      } else if ((a === '--category' || a === '-c') && i + 1 < learnArgs.length) {
        category = learnArgs[++i];
      } else if ((a === '--verify' || a === '-v') && i + 1 < learnArgs.length) {
        verifyCmd = learnArgs[++i];
      } else if ((a === '--trigger' || a === '-t') && i + 1 < learnArgs.length) {
        triggers.push(learnArgs[++i]);
      } else if (!a.startsWith('-') && !pattern) {
        pattern = a;
      }
    }

    if (!pattern) {
      console.error('Usage: node router-cli.mjs learn --skill <slug> --pattern "<verified lesson>" [--category recipe|invariant] [--trigger <kw>]');
      process.exit(1);
    }

    const res = await appendLearnedPatternAi({
      slug: skillSlug,
      pattern,
      category,
      triggers,
      verifyCmd
    });
    console.log(
      `💎 [Skill Evolved] ${res.slug} (${res.action} via ${res.mode} | ${res.linesCount}L | learned: ${res.learnedPatternsCount})`
    );
  } else if (cmd === 'audit-skill') {
    const auditArgs = args.slice(1);
    let runAll = false;
    let asJson = false;
    let target = '';
    for (const a of auditArgs) {
      if (a === '--all') runAll = true;
      else if (a === '--json') asJson = true;
      else if (!a.startsWith('-') && !target) target = a;
    }
    if (!runAll && !target) {
      console.error('Usage: node router-cli.mjs audit-skill (<slugOrDir> | --all) [--json]');
      process.exit(1);
    }
    const res = runAll ? auditAllSkills() : auditSkill(target);
    if (asJson) {
      console.log(JSON.stringify(res, null, 2));
    } else if (runAll) {
      console.log(`🏗️ [Skill-Architect Audit] Total: ${res.total} | Avg: ${res.averageScore}/100`);
      for (const item of res.results) {
        console.log(`  ${item.ok ? '✅' : '❌'} ${item.slug}: ${item.score}/100 (${item.grade}) | err:${item.errorsCount} warn:${item.warningsCount}`);
      }
    } else {
      console.log(`${res.ok ? '✅' : '❌'} [Skill-Architect] ${res.slug}: ${res.score}/100 (${res.grade}) | Recall: ${res.triggerEval.recall}`);
      for (const f of res.findings) {
        console.log(`  - [${f.severity.toUpperCase()} ${f.id}] ${f.message}`);
      }
    }
    if (!res.ok) process.exit(1);
  } else if (cmd === 'distill-pitfalls') {
    const distillArgs = args.slice(1);
    let dryRun = false;
    let customDir = '';
    let limit = 20;
    for (let i = 0; i < distillArgs.length; i++) {
      const a = distillArgs[i];
      if (a === '--dry-run') dryRun = true;
      else if (a === '--dir' && i + 1 < distillArgs.length) customDir = distillArgs[++i];
      else if (a === '--limit' && i + 1 < distillArgs.length) limit = Math.max(1, Number(distillArgs[++i]) || 20);
    }
    const res = await distillPitfallsIntoSkillsAi({
      workspaceRoot: process.cwd(),
      targetDir: customDir,
      limit,
      dryRun
    });
    console.log(
      `🧪 [EvoSkill Distill] Scanned: ${res.scannedPitfalls} | Evolved: ${res.evolvedSkills.length}${res.dryRun ? ' (dry-run)' : ''}`
    );
    for (const s of res.evolvedSkills) {
      console.log(`  - ${s.slug}: +${s.invariantsCount} causal invariant(s) (${s.action || 'preview'})`);
    }
  } else if (cmd === 'instincts') {
    const instArgs = args.slice(1);
    let wsDir = process.cwd();
    let includePromoted = false;
    let asJson = false;
    for (let i = 0; i < instArgs.length; i++) {
      const a = instArgs[i];
      if (a === '--all') includePromoted = true;
      else if (a === '--json') asJson = true;
      else if (a === '--dir' && i + 1 < instArgs.length) wsDir = resolve(instArgs[++i]);
    }
    const res = knowledgeHub.listInstincts({ workspaceRoot: wsDir, includePromoted, minConfidence: 0.1, limit: 50 });
    if (asJson) {
      console.log(JSON.stringify(res, null, 2));
    } else {
      const items = res.items || [];
      console.log(`🧠 [Инстинкты проекта] Найдено: ${items.length} (${wsDir})`);
      for (const it of items) {
        const confPct = Math.round((it.effectiveConfidence || 0) * 100);
        const tag = it.promotedSkill
          ? `✅ -> ${it.promotedSkill}`
          : (it.readyForPromotion ? '🚀 Готов к /evolve' : '⏳ Накопление');
        console.log(`  - [${it.id.slice(0, 8)}] ${confPct}% (x${it.evidenceCount}) ${tag}: ${it.pattern}`);
      }
    }
  } else if (cmd === 'evolve') {
    const evArgs = args.slice(1);
    let wsDir = process.cwd();
    let dryRun = false;
    let skillSlug = '';
    for (let i = 0; i < evArgs.length; i++) {
      const a = evArgs[i];
      if (a === '--dry-run') dryRun = true;
      else if (a === '--dir' && i + 1 < evArgs.length) wsDir = resolve(evArgs[++i]);
      else if ((a === '--skill' || a === '-s') && i + 1 < evArgs.length) skillSlug = evArgs[++i];
    }
    const res = evolveReadyInstincts({ workspaceRoot: wsDir, skillSlug, dryRun });
    console.log(
      `🚀 [Эволюция инстинктов] Кандидатов: ${res.candidatesCount} | Повышено в навыки: ${res.promoted.length}${res.dryRun ? ' (предпросмотр)' : ''}`
    );
    for (const p of res.promoted) {
      console.log(`  - ${p.skillSlug || 'preview'}: ${p.pattern}`);
    }
  } else if (cmd === 'shield') {
    const shArgs = args.slice(1);
    let wsDir = process.cwd();
    let includeGlobal = true;
    let asJson = false;
    let strictMode = false;
    for (let i = 0; i < shArgs.length; i++) {
      const a = shArgs[i];
      if (a === '--workspace-only') includeGlobal = false;
      else if (a === '--json') asJson = true;
      else if (a === '--strict') strictMode = true;
      else if (a === '--dir' && i + 1 < shArgs.length) wsDir = resolve(shArgs[++i]);
    }
    const res = auditAgentEnvironment({ workspaceRoot: wsDir, includeGlobal });
    if (asJson) {
      console.log(JSON.stringify(res, null, 2));
    } else {
      console.log(`🛡️ [AgentShield] ${res.summaryRu}`);
      for (const f of res.findings) {
        console.log(`  - [${String(f.severity || 'low').toUpperCase()} · ${f.ruleId}] ${f.file}: ${f.message}`);
      }
    }
    if (strictMode && Number(res?.counts?.critical || 0) > 0) {
      process.exit(1);
    }
  } else if (cmd === 'memory') {
    const memArgs = args.slice(1);
    let wsDir = process.cwd();
    let query = '';
    let timelineId = '';
    let detailIds = [];
    let asJson = false;
    for (let i = 0; i < memArgs.length; i++) {
      const a = memArgs[i];
      if (a === '--json') asJson = true;
      else if (a === '--dir' && i + 1 < memArgs.length) wsDir = resolve(memArgs[++i]);
      else if (a === '--timeline' && i + 1 < memArgs.length) timelineId = memArgs[++i];
      else if (a === '--details' && i + 1 < memArgs.length) detailIds = memArgs[++i].split(',').map((s) => s.trim()).filter(Boolean);
      else if (!a.startsWith('-') && !query) query = a;
    }
    const res = timelineId
      ? knowledgeHub.getSessionEpisodeTimeline({ workspaceRoot: wsDir, anchorId: timelineId })
      : detailIds.length > 0
        ? knowledgeHub.getSessionEpisodesByIds({ workspaceRoot: wsDir, ids: detailIds })
        : knowledgeHub.searchSessionEpisodes({ workspaceRoot: wsDir, query, limit: 12 });
    if (asJson) {
      console.log(JSON.stringify(res, null, 2));
    } else {
      console.log(`🧠 [3-Layer Session Memory] (${wsDir})`);
      for (const it of res.items || []) {
        if (it.summary !== undefined) {
          console.log(`  [${it.id}] (${it.kind}) ${it.title}\n    Summary: ${it.summary}\n    Decisions: ${(it.decisions || []).join(' | ')}`);
        } else {
          console.log(`  - [#${it.shortId || it.id?.slice(0, 6)} ${it.date || ''} | ${it.kind}] ${it.title} (~${it.estTokens || 0}t)`);
        }
      }
    }
  } else if (cmd === 'ccr') {
    const ccrArgs = args.slice(1);
    let hash = '';
    let query = '';
    let startLine = 1;
    let endLine = 0;
    for (let i = 0; i < ccrArgs.length; i++) {
      const a = ccrArgs[i];
      if ((a === '--query' || a === '-q') && i + 1 < ccrArgs.length) query = ccrArgs[++i];
      else if (a === '--start' && i + 1 < ccrArgs.length) startLine = Number(ccrArgs[++i]) || 1;
      else if (a === '--end' && i + 1 < ccrArgs.length) endLine = Number(ccrArgs[++i]) || 0;
      else if (!a.startsWith('-') && !hash) hash = a;
    }
    if (!hash) {
      console.error('Usage: node router-cli.mjs ccr <hash> [--query <q>] [--start <n>] [--end <n>]');
      process.exit(1);
    }
    const res = knowledgeHub.retrieveCcrBlob({ hash, query, startLine, endLine });
    if (!res.ok) {
      console.error(`❌ CCR retrieve failed: ${res.error}`);
      process.exit(1);
    }
    console.log(`[📦 CCR #${res.hash} | L${res.returnedStartLine}-${res.returnedEndLine}/${res.totalLines}]\n${res.text}`);
  } else if (cmd === 'gates') {
    const sub = String(args[1] || '').toLowerCase();
    if (sub === 'init') {
      const targetDir = resolve(args.find((a, idx) => idx > 1 && !a.startsWith('-')) || process.cwd());
      const overwrite = args.includes('--overwrite');
      const res = initAcceptanceGatesMarkdown(targetDir, { overwrite });
      if (args.includes('--json')) {
        console.log(JSON.stringify(res, null, 2));
      } else if (res.ok) {
        console.log(`🚧 [GATES.md] Создан шаблон критериев приёмки: ${res.outPath} (${res.count} пунктов)`);
      } else {
        console.error(`⚠️ [GATES.md] ${res.reason || 'Не удалось создать файл'} (${res.outPath})`);
        process.exit(1);
      }
    } else {
      const targetDir = resolve(args.find((a, idx) => idx > 0 && !a.startsWith('-')) || process.cwd());
      const res = checkProjectCompletionInvariants(targetDir, []);
      if (args.includes('--json')) {
        console.log(JSON.stringify(res, null, 2));
      } else {
        console.log(`🚧 [Completion Gates] ${res.ok ? 'OK' : `Warnings: ${res.warnings.length}`} (${targetDir})`);
        if (res.gates) {
          console.log(`  GATES.md: ${res.gates.met.length}/${res.gates.total} met | unmet: ${res.gates.unmet.length} | abandoned: ${res.gates.abandoned.length}`);
        }
        for (const w of res.warnings) {
          console.log(`  - [${w.kind}] ${w.message}`);
        }
      }
    }
  } else if (cmd === 'doctor' || cmd === 'setup-recommend') {
    const targetDir = resolve(args.find((a, idx) => idx > 0 && !a.startsWith('-')) || process.cwd());
    const st = safeReadJsonSync(getRouterStateFile(), () => ({}), { selfHeal: true });
    const res = recommendProjectSetup({ workspaceRoot: targetDir, currentState: st });
    if (args.includes('--json')) {
      console.log(JSON.stringify(res, null, 2));
    } else {
      console.log(formatProjectSetupReportRu(res));
    }
    if (!res.ok) process.exit(1);
  } else if (cmd === 'find-skills') {
    const fArgs = args.slice(1);
    const localOnly = fArgs.includes('--local-only');
    const asJson = fArgs.includes('--json');
    const query = fArgs.find((a) => !a.startsWith('-')) || '';
    const res = await searchSkillsCatalog({ query, workspaceRoot: process.cwd(), includeRemote: !localOnly });
    if (asJson) {
      console.log(JSON.stringify(res, null, 2));
    } else {
      console.log(`🔎 [Поиск навыков] Запрос: "${query || '*'}" | Локальных: ${res.localMatches.length} | Внешних: ${res.remoteMatches.length}${res.offlineFallback ? ' (офлайн)' : ''}`);
      for (const s of res.localMatches) {
        console.log(`  ✅ [локальный] ${s.slug}: ${s.description.slice(0, 110)}`);
      }
      for (const s of res.remoteMatches) {
        const tag = s.alreadyInstalled ? '⚠️ уже установлен' : (s.sourceRepo || 'skills.sh');
        console.log(`  🌐 [${tag}] ${s.slug} (${s.installs || 0} уст.): ${s.description.slice(0, 100)}`);
      }
    }
  } else if (cmd === 'import-skill') {
    const impArgs = args.slice(1);
    let source = '';
    let slug = '';
    let targetSkillsDir = '';
    let dryRun = false;
    let force = false;
    let asJson = false;
    for (let i = 0; i < impArgs.length; i++) {
      const a = impArgs[i];
      if ((a === '--skill' || a === '-s') && i + 1 < impArgs.length) slug = impArgs[++i];
      else if (a === '--target-dir' && i + 1 < impArgs.length) targetSkillsDir = resolve(impArgs[++i]);
      else if (a === '--dry-run') dryRun = true;
      else if (a === '--force') force = true;
      else if (a === '--json') asJson = true;
      else if (!a.startsWith('-') && !source) source = a;
    }
    if (!source || !slug) {
      console.error('Usage: node router-cli.mjs import-skill <localPathOrOwnerRepo> --skill <slug> [--target-dir <dir>] [--dry-run] [--json]');
      process.exit(1);
    }
    const res = await importSkillFromSource({
      source,
      slug,
      ...(targetSkillsDir ? { targetSkillsDir } : {}),
      dryRun,
      force,
    });
    if (asJson) {
      console.log(JSON.stringify(res, null, 2));
    } else if (res.ok) {
      console.log(`🛡️ [Импорт навыка] ${res.slug}: ${res.dryRun ? 'проверка пройдена (dry-run)' : `установлен в ${res.installedDir}`}`);
    } else {
      console.error(`❌ [Импорт навыка] Заблокирован (${res.error || (res.reasons || []).join('; ')})`);
    }
    if (!res.ok) process.exit(1);
  } else if (cmd === 'combo') {
    const cArgs = args.slice(1);
    let comboName = 'daily_coding';
    let cooldownModel = '';
    let minutes = 15;
    let reset = false;
    let asJson = false;
    for (let i = 0; i < cArgs.length; i++) {
      const a = cArgs[i];
      if (a === '--cooldown' && i + 1 < cArgs.length) cooldownModel = cArgs[++i];
      else if (a === '--minutes' && i + 1 < cArgs.length) minutes = Math.max(1, Number(cArgs[++i]) || 15);
      else if (a === '--reset') reset = true;
      else if (a === '--json') asJson = true;
      else if (!a.startsWith('-') && Object.hasOwn(DEFAULT_COMBO_CHAINS, a)) comboName = a;
    }
    if (reset) clearExpiredComboCooldowns({ resetAll: true });
    if (cooldownModel) {
      recordComboProviderCooldown({ modelOrTier: cooldownModel, cooldownMs: minutes * 60 * 1000 });
    }
    const res = resolveComboFailoverTarget({ combo: comboName });
    if (asJson) {
      console.log(JSON.stringify(res, null, 2));
    } else {
      console.log(`🔀 [Combo Failover · ${res.combo}] Активная цель: ${res.selected}`);
      console.log(`   Цепочка: ${res.chain.join(' -> ')}`);
      if (res.skippedOnCooldown.length) {
        console.log(`   На паузе (cooldown): ${res.skippedOnCooldown.map((s) => `${s.model} (${s.reason})`).join(', ')}`);
      }
    }
  } else if (cmd === 'audit-ui') {
    const targetPath = resolve(args.find((a, idx) => idx > 0 && !a.startsWith('-')) || process.cwd());
    const { auditUiPath, formatUiAuditReport } = await import('../skills/ui-ux-design-system/scripts/audit-ui.mjs');
    const report = auditUiPath(targetPath);
    if (args.includes('--json')) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatUiAuditReport(report));
    }
  } else {
    console.error(`Unknown command: ${cmd}`);
    console.error('Available commands: status, usages, chronos, dead-exports, slice, codemod, skills, learn, audit-skill, distill-pitfalls, instincts, evolve, shield, memory, ccr, gates, doctor, find-skills, import-skill, combo, audit-ui, backup, restore');
    process.exit(1);
  }
}

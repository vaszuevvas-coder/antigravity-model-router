#!/usr/bin/env node
/**
 * Кроссплатформенный установщик плагина antigravity-model-router
 * Копирует файлы плагина в ~/.gemini/config/plugins/antigravity-model-router
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  clampSettingsToHardwareCeilings,
  computeHardwareCeilings,
  computeMaxRamBudgetMb,
  detectCpuAndRam,
  probeAnyGpu,
  recommendHardwareSettings,
  syncMcpRamBudget,
} from './core/hardware-profiler.mjs';
import { findOllamaBinary } from './core/local-gpu-engine.mjs';
import { buildPanelUi } from './core/panel-ui-builder.mjs';
import { detectOsLocale, normalizeLang } from './core/i18n.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLUGIN_NAME = 'antigravity-model-router';
const srcDir = __dirname;
const targetDir = path.join(os.homedir(), '.gemini', 'config', 'plugins', PLUGIN_NAME);

export const EXCLUDE = new Set([
  '.git',
  '.gitignore',
  '.agents',
  '.cache',
  'checkpoints',
  'backups',
  '.shadow',
  'node_modules',
  'scratch',
  'tests',
  'dist',
  'build',
  'releases',
  'scripts',
  'package.json',
  'package-lock.json',
  'AGENTS.md',
  'GEMINI.md',
  'constructor',
  'toString',
  '__proto__',
  '--ws',
  'install.js',
  'install.bat',
  'install.sh',
  'uninstall.bat',
  'Установить плагин.bat',
  'Удалить плагин.bat',
]);

// Nested directory exclusions: never skip `scripts/` inside `skills/<name>/scripts/`
const NESTED_EXCLUDE = new Set([
  '.git',
  '.cache',
  'checkpoints',
  'backups',
  '.shadow',
  'node_modules',
  'tests',
  'ui-src',
  'constructor',
  'toString',
  '__proto__',
  '--ws',
]);

const DEPRECATED_STATE_KEYS = [
  'recommendTeamwork',
  'recommendSkills',
  'activeSkillProfiles',
  'splitExecution',
  'chainOfDraft',
  'workerModel',
];

export function sanitizeMergedState(mergedState) {
  const next = { ...(mergedState || {}) };
  for (const k of DEPRECATED_STATE_KEYS) {
    delete next[k];
  }
  if (typeof next.gpuChatModel === 'string' && /^gemma3(?::12b)?$/i.test(next.gpuChatModel.trim())) {
    next.gpuChatModel = 'gemma4:12b';
  }
  if (typeof next.gpuEmbedModel === 'string' && /^nomic-embed-text(?::latest)?$/i.test(next.gpuEmbedModel.trim())) {
    next.gpuEmbedModel = 'qwen3-embedding:0.6b';
  }
  for (const dirKey of ['gpuModelsDir', 'gpuOllamaDir']) {
    if (typeof next[dirKey] === 'string' && next[dirKey].trim()) {
      const dir = next[dirKey].trim();
      if (process.platform === 'win32') {
        const m = /^([A-Za-z]):[\\/]/.exec(dir);
        if (m && !fs.existsSync(`${m[1]}:\\`)) {
          next[dirKey] = '';
        }
      }
    }
  }
  if (typeof next.uiLanguage === 'string') {
    const lang = next.uiLanguage.trim().toLowerCase();
    next.uiLanguage = lang === 'ru' ? 'ru' : 'en';
  }
  return next;
}

export function pruneRootOrphans(srcRoot, destRoot) {
  if (!fs.existsSync(destRoot)) return 0;
  const ROOT_PRESERVE = new Set(['.cache', 'router-state.json', 'mcp_config.json']);
  let removed = 0;
  for (const entry of fs.readdirSync(destRoot, { withFileTypes: true })) {
    if (ROOT_PRESERVE.has(entry.name)) continue;
    const destEntry = path.join(destRoot, entry.name);
    const srcEntry = path.join(srcRoot, entry.name);
    let shouldDelete = EXCLUDE.has(entry.name) || !fs.existsSync(srcEntry);
    if (!shouldDelete) {
      try {
        const srcIsDir = fs.statSync(srcEntry).isDirectory();
        if (entry.isDirectory() !== srcIsDir) shouldDelete = true;
      } catch {
        shouldDelete = true;
      }
    }
    if (shouldDelete) {
      try {
        fs.rmSync(destEntry, { recursive: true, force: true });
        removed++;
      } catch {}
    }
  }
  return removed;
}

function isPreservedUserSkillDir(destDirPath, entry) {
  if (!entry || !entry.isDirectory()) return false;
  if (path.basename(destDirPath) !== 'skills') return false;
  const fullEntry = path.join(destDirPath, entry.name);
  if (entry.name.startsWith('project-')) return true;
  return fs.existsSync(path.join(fullEntry, '.user-skill.json'));
}

function pruneOrphanFiles(srcDirPath, destDirPath) {
  if (!fs.existsSync(destDirPath)) return 0;
  let removed = 0;
  for (const entry of fs.readdirSync(destDirPath, { withFileTypes: true })) {
    const destEntry = path.join(destDirPath, entry.name);
    const srcEntry = path.join(srcDirPath, entry.name);
    if (!fs.existsSync(srcEntry)) {
      if (isPreservedUserSkillDir(destDirPath, entry)) {
        continue;
      }
      try {
        fs.rmSync(destEntry, { recursive: true, force: true });
        removed++;
      } catch {}
    } else if (entry.isDirectory()) {
      try {
        if (fs.statSync(srcEntry).isDirectory()) {
          removed += pruneOrphanFiles(srcEntry, destEntry);
        } else {
          fs.rmSync(destEntry, { recursive: true, force: true });
          removed++;
        }
      } catch {}
    }
  }
  return removed;
}

export function maintainCacheDir(cacheDir) {
  const res = {
    repomapsRemoved: 0,
    vectorsPurged: 0,
    digestsPruned: 0,
    legacyRemoved: 0,
  };
  if (!fs.existsSync(cacheDir)) return res;

  // Migrate legacy cache filenames cleanly into canonical v3.7 filenames before removing legacy duplicates
  for (const [legacyName, canonicalName] of [
    ['bayesian-priors.json', 'domain-priors.json'],
    ['pitfall-ledger.json', 'pitfalls-ledger.json'],
  ]) {
    const legacyFile = path.join(cacheDir, legacyName);
    const canonicalFile = path.join(cacheDir, canonicalName);
    if (fs.existsSync(legacyFile)) {
      try {
        if (!fs.existsSync(canonicalFile) || fs.statSync(canonicalFile).size === 0) {
          fs.copyFileSync(legacyFile, canonicalFile);
        }
        fs.unlinkSync(legacyFile);
        res.legacyRemoved++;
      } catch {}
    }
  }

  for (const staleName of ['read-dedup-state.json', 'overwrite-guard.json']) {
    const staleFile = path.join(cacheDir, staleName);
    if (fs.existsSync(staleFile)) {
      try {
        fs.unlinkSync(staleFile);
        res.legacyRemoved++;
      } catch {}
    }
  }

  const repomaps = [];
  const digests = [];
  const validVectorStores = [];

  for (const name of fs.readdirSync(cacheDir)) {
    const fullPath = path.join(cacheDir, name);

    if (/^repomap-.*\.json$/i.test(name)) {
      try {
        const st = fs.statSync(fullPath);
        if (st.size === 0) {
          fs.unlinkSync(fullPath);
          res.repomapsRemoved++;
          continue;
        }
        const parsed = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
        if (parsed?.schemaVersion !== 2) {
          fs.unlinkSync(fullPath);
          res.repomapsRemoved++;
        } else {
          repomaps.push({ fullPath, mtimeMs: st.mtimeMs });
        }
      } catch {
        try {
          fs.unlinkSync(fullPath);
          res.repomapsRemoved++;
        } catch {}
      }
      continue;
    }

    if (/^compaction-digest-.*\.md$/i.test(name)) {
      try {
        const st = fs.statSync(fullPath);
        if (st.size === 0) {
          fs.unlinkSync(fullPath);
          res.digestsPruned++;
        } else {
          digests.push({ fullPath, mtimeMs: st.mtimeMs });
        }
      } catch {}
      continue;
    }

    // Purge legacy JSON vector stores and any pre-i8bin-v2 (.bin/.meta.json) stores (e.g. bloated f32bin-v1)
    if (/^gpu-vectors-[a-f0-9]+\.json$/i.test(name)) {
      try {
        fs.unlinkSync(fullPath);
        res.vectorsPurged++;
      } catch {}
      continue;
    }

    const metaMatch = /^(gpu-vectors-[a-f0-9]+)\.meta\.json$/i.exec(name);
    if (metaMatch) {
      const base = metaMatch[1];
      const binPath = path.join(cacheDir, `${base}.bin`);
      let validI8 = false;
      let mtimeMs = 0;
      try {
        const meta = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
        const wsExists = !meta?.workspaceRoot || fs.existsSync(meta.workspaceRoot);
        if (meta?.format === 'i8bin-v2' && !/nomic-embed/i.test(String(meta?.model || '')) && fs.existsSync(binPath) && wsExists) {
          validI8 = true;
          mtimeMs = fs.statSync(binPath).mtimeMs || fs.statSync(fullPath).mtimeMs || 0;
        }
      } catch {}
      if (!validI8) {
        try { fs.unlinkSync(fullPath); } catch {}
        try { if (fs.existsSync(binPath)) fs.unlinkSync(binPath); } catch {}
        res.vectorsPurged++;
      } else {
        validVectorStores.push({ metaPath: fullPath, binPath, mtimeMs });
      }
      continue;
    }

    const binMatch = /^(gpu-vectors-[a-f0-9]+)\.bin$/i.exec(name);
    if (binMatch) {
      const metaPath = path.join(cacheDir, `${binMatch[1]}.meta.json`);
      if (!fs.existsSync(metaPath)) {
        try {
          fs.unlinkSync(fullPath);
          res.vectorsPurged++;
        } catch {}
      }
    }
  }

  if (validVectorStores.length > 8) {
    validVectorStores.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (let i = 8; i < validVectorStores.length; i++) {
      try { fs.unlinkSync(validVectorStores[i].metaPath); } catch {}
      try { fs.unlinkSync(validVectorStores[i].binPath); } catch {}
      res.vectorsPurged++;
    }
  }

  // Prune & compact high-frequency JSON caches (max 64 entries, spaces: 0)
  const nowMs = Date.now();
  const compactJsonStore = (fileName, wrapKey, maxAgeMs, getTs, keepFn) => {
    const fp = path.join(cacheDir, fileName);
    if (!fs.existsSync(fp)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(fp, 'utf8'));
      const rawMap = wrapKey ? parsed?.[wrapKey] : parsed;
      if (!rawMap || typeof rawMap !== 'object' || Array.isArray(rawMap)) return;
      const pinned = [];
      const regular = [];
      for (const [k, v] of Object.entries(rawMap)) {
        if (!v || typeof v !== 'object') continue;
        if (keepFn && keepFn(k, v)) {
          pinned.push([k, v, getTs(v) || nowMs]);
        } else {
          const ts = getTs(v) || 0;
          if (ts > 0 && (maxAgeMs <= 0 || nowMs - ts <= maxAgeMs)) {
            regular.push([k, v, ts]);
          }
        }
      }
      regular.sort((a, b) => b[2] - a[2]);
      const nextMap = {};
      for (const [k, v] of pinned) nextMap[k] = v;
      for (const [k, v] of regular.slice(0, Math.max(0, 64 - pinned.length))) nextMap[k] = v;
      const nextDoc = wrapKey ? { ...parsed, [wrapKey]: nextMap } : nextMap;
      fs.writeFileSync(fp, JSON.stringify(nextDoc), 'utf8');
    } catch {}
  };

  compactJsonStore(
    'circuit-breaker.json',
    'buckets',
    30 * 60 * 1000,
    (v) => (v?.updatedAt ? Date.parse(v.updatedAt) || 0 : 0),
    (_k, v) => Boolean(v?.status && v.status !== 'CLOSED')
  );
  compactJsonStore('pre-invocation-turn.json', 'turns', 2 * 60 * 60 * 1000, (v) => Number(v?.ts || 0));
  compactJsonStore('execution-tracker.json', 'tasks', 15 * 60 * 1000, (v) => Number(v?.ts || 0));
  try {
    const compFile = path.join(cacheDir, 'compaction-state.json');
    if (fs.existsSync(compFile)) {
      const comp = JSON.parse(fs.readFileSync(compFile, 'utf8'));
      const epochs = comp?.epochs && typeof comp.epochs === 'object' ? comp.epochs : {};
      const resets = comp?.resetTimestamps && typeof comp.resetTimestamps === 'object' ? comp.resetTimestamps : {};
      const keys = Array.from(new Set([...Object.keys(epochs), ...Object.keys(resets)]));
      keys.sort((a, b) => (Number(resets[b] || 0) || 0) - (Number(resets[a] || 0) || 0));
      const nextEp = {};
      const nextRs = {};
      for (const k of keys.slice(0, 64)) {
        if (Object.hasOwn(epochs, k)) nextEp[k] = epochs[k];
        if (Object.hasOwn(resets, k)) nextRs[k] = resets[k];
      }
      fs.writeFileSync(
        compFile,
        JSON.stringify({ epochs: nextEp, resetTimestamps: nextRs, totalCompactions: Number(comp?.totalCompactions || 0) }),
        'utf8'
      );
    }
  } catch {}

  if (repomaps.length > 6) {
    repomaps.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (let i = 6; i < repomaps.length; i++) {
      try {
        fs.unlinkSync(repomaps[i].fullPath);
        res.repomapsRemoved++;
      } catch {}
    }
  }

  if (digests.length > 10) {
    digests.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (let i = 10; i < digests.length; i++) {
      try {
        fs.unlinkSync(digests[i].fullPath);
        res.digestsPruned++;
      } catch {}
    }
  }

  // Prune stale quarantine staging directories left by aborted skill imports
  const quarantineDir = path.join(cacheDir, 'skill-quarantine');
  if (fs.existsSync(quarantineDir)) {
    try {
      const cutoffMs = Date.now() - 60 * 60 * 1000;
      for (const ent of fs.readdirSync(quarantineDir, { withFileTypes: true })) {
        const qItem = path.join(quarantineDir, ent.name);
        try {
          const st = fs.statSync(qItem);
          if ((st.mtimeMs || 0) < cutoffMs) {
            fs.rmSync(qItem, { recursive: true, force: true });
            res.legacyRemoved++;
          }
        } catch {}
      }
    } catch {}
  }

  return res;
}

function purgeDuplicateGlobalSkills(installedPluginDir) {
  const globalDirs = [
    path.join(os.homedir(), '.gemini', 'antigravity', 'skills'),
    path.join(os.homedir(), '.gemini', 'config', 'skills'),
  ];
  const fallbackSlugs = [
    'ast-codemod-refactor',
    'binary-app-localizer',
    'context-fork',
    'deep-stress-auditor',
    'delta-bug-minimizer',
    'game-systems-architect',
    'github-publish-guard',
    'model-router',
    'playwright-cli',
    'program-slicer-ocd',
    'programmatic-video-studio',
    'skill-architect',
    'ui-ux-design-system',
    'vj-video-fx-studio',
  ];
  const slugSet = new Set(fallbackSlugs);
  const srcSkillsDir = path.join(srcDir, 'skills');
  if (fs.existsSync(srcSkillsDir)) {
    try {
      for (const ent of fs.readdirSync(srcSkillsDir, { withFileTypes: true })) {
        if (ent.isDirectory() && fs.existsSync(path.join(srcSkillsDir, ent.name, 'SKILL.md'))) {
          slugSet.add(ent.name);
        }
      }
    } catch {}
  }
  const pluginSkillSlugs = Array.from(slugSet);
  let removed = 0;
  for (const globalSkillsDir of globalDirs) {
    if (!fs.existsSync(globalSkillsDir)) continue;
    for (const skillName of pluginSkillSlugs) {
      const pluginSkillDir = path.join(installedPluginDir, 'skills', skillName);
      const legacySkillDir = path.join(globalSkillsDir, skillName);
      if (fs.existsSync(pluginSkillDir) && fs.existsSync(legacySkillDir)) {
        try {
          fs.rmSync(legacySkillDir, { recursive: true, force: true });
          removed++;
        } catch {}
      }
    }
  }
  return removed;
}

function resolveTargetDir(customTarget) {
  if (typeof customTarget === 'string' && customTarget.trim()) {
    return path.resolve(customTarget.trim());
  }
  return targetDir;
}

function getExternalBackupPath(destRoot) {
  return path.join(path.dirname(destRoot), `${PLUGIN_NAME}-state.backup.json`);
}

function safeParseJsonObject(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {}
  return null;
}

export function createStateBackup(destRoot, externalBackupPath = '') {
  const resolvedDest = resolveTargetDir(destRoot);
  const statePath = path.join(resolvedDest, 'router-state.json');
  const parsed = safeParseJsonObject(statePath);
  if (!parsed) {
    return { ok: false, backupPath: '', externalBackupPath: '', state: null };
  }

  const cacheDir = path.join(resolvedDest, '.cache');
  const backupPath = path.join(cacheDir, 'router-state.backup.json');
  const payload = JSON.stringify(parsed, null, 2) + '\n';

  let writtenInternal = '';
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(backupPath, payload, 'utf8');
    writtenInternal = backupPath;
  } catch {}

  let writtenExternal = '';
  if (typeof externalBackupPath === 'string' && externalBackupPath.trim()) {
    try {
      const extPath = path.resolve(externalBackupPath.trim());
      fs.mkdirSync(path.dirname(extPath), { recursive: true });
      fs.writeFileSync(extPath, payload, 'utf8');
      writtenExternal = extPath;
    } catch {}
  }

  return {
    ok: Boolean(writtenInternal || writtenExternal),
    backupPath: writtenInternal,
    externalBackupPath: writtenExternal,
    state: parsed,
  };
}

function computeMergedState(srcStatePath, destStatePath, fallbackExistingState = null) {
  const srcState = safeParseJsonObject(srcStatePath) || {};
  const diskExisting = safeParseJsonObject(destStatePath);
  const existingState = diskExisting || (fallbackExistingState && typeof fallbackExistingState === 'object' ? fallbackExistingState : {});
  const isAlreadyConfigured =
    existingState.onboardingCompleted === true || existingState.hardwareProfiled === true;

  const sys = detectCpuAndRam();
  const gpu = probeAnyGpu({ force: false });
  const ceilings = computeHardwareCeilings({ system: sys, gpu });

  let hwAutoDefaults = {};
  if (!isAlreadyConfigured) {
    const oll = { installed: Boolean(findOllamaBinary()), running: false, downloadedModels: [] };
    hwAutoDefaults = recommendHardwareSettings({
      system: sys,
      gpu,
      ollama: oll,
      subscriptionTier: existingState.subscriptionTier || srcState.subscriptionTier || 'pro',
    }).recommendedPatch;
  }

  const resolvedUiLanguage =
    existingState.uiLanguage === 'ru' || existingState.uiLanguage === 'en'
      ? existingState.uiLanguage
      : isAlreadyConfigured
        ? 'ru'
        : (srcState.uiLanguage === 'ru' ? 'ru' : 'en');

  return sanitizeMergedState(
    clampSettingsToHardwareCeilings(
      {
        ...srcState,
        ...hwAutoDefaults,
        ...existingState,
        uiLanguage: resolvedUiLanguage,
        onboardingCompleted: Boolean(existingState.onboardingCompleted),
        hardwareProfiled: true,
      },
      ceilings
    )
  );
}

function calibrateOrMergeState(srcStatePath, destStatePath, fallbackExistingState = null) {
  const mergedState = computeMergedState(srcStatePath, destStatePath, fallbackExistingState);
  fs.mkdirSync(path.dirname(destStatePath), { recursive: true });
  fs.writeFileSync(destStatePath, JSON.stringify(mergedState, null, 2) + '\n', 'utf8');
  return mergedState;
}

function sleepMsSync(ms) {
  const waitMs = Math.max(0, Number(ms) || 0);
  if (!waitMs) return;
  try {
    if (typeof SharedArrayBuffer !== 'undefined' && typeof Atomics !== 'undefined') {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
      return;
    }
  } catch {}
  const end = Date.now() + waitMs;
  while (Date.now() < end) { /* fallback spin wait */ }
}

const TRANSIENT_COPY_ERR_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);

function copyFileWithRetrySync(srcPath, destPath, retries = 3, delayMs = 150) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      fs.copyFileSync(srcPath, destPath);
      return;
    } catch (err) {
      lastErr = err;
      if (!TRANSIENT_COPY_ERR_CODES.has(err?.code) || attempt >= retries) {
        throw err;
      }
      sleepMsSync(delayMs);
    }
  }
  if (lastErr) throw lastErr;
}

function copyRecursive(src, dest, destRoot = dest, options = {}, depth = 0) {
  fs.mkdirSync(dest, { recursive: true });
  const activeExclude = depth === 0 ? EXCLUDE : NESTED_EXCLUDE;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (activeExclude.has(entry.name)) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyRecursive(srcPath, destPath, destRoot, options, depth + 1);
    } else {
      // Сохраняем пользовательский router-state.json при обновлении, а для чистой установки калибруем лимиты под реальное железо ПК
      if (entry.name === 'router-state.json') {
        try {
          calibrateOrMergeState(srcPath, destPath, options.fallbackExistingState || null);
          continue;
        } catch {}
      }
      // Прописываем точный абсолютный путь к MCP-серверу RAM и безопасный бюджет памяти при установке, сохраняя eager-настройки пользователя
      if (entry.name === 'mcp_config.json') {
        try {
          const mcpCfg = JSON.parse(fs.readFileSync(srcPath, 'utf8'));
          const existingMcp = safeParseJsonObject(destPath);
          const installedStatePath = path.join(destRoot, 'router-state.json');
          const existingState = safeParseJsonObject(installedStatePath) || options.fallbackExistingState || {};
          const sysRam = detectCpuAndRam();
          const maxRamCapMb = computeMaxRamBudgetMb(sysRam.totalRamMb);
          const fallbackRamMb = sysRam.recommendedRamBudgetMb;
          const budgetMb = Math.max(
            512,
            Math.min(maxRamCapMb, Number(existingState.ramMaxBudgetMb) || fallbackRamMb)
          );
          if (mcpCfg?.mcpServers?.['ram-memory']) {
            mcpCfg.mcpServers['ram-memory'].args = [
              `--max-old-space-size=${budgetMb}`,
              path.join(destRoot, 'core', 'ram-memory-mcp.mjs'),
            ];
            const prevTools = existingMcp?.mcpServers?.['ram-memory']?.tools;
            const nextTools = mcpCfg.mcpServers['ram-memory'].tools;
            if (prevTools && typeof prevTools === 'object' && nextTools && typeof nextTools === 'object') {
              for (const [toolKey, toolCfg] of Object.entries(nextTools)) {
                if (Object.hasOwn(prevTools, toolKey) && typeof prevTools[toolKey]?.eager === 'boolean') {
                  toolCfg.eager = prevTools[toolKey].eager;
                }
              }
            }
          }
          fs.writeFileSync(destPath, JSON.stringify(mcpCfg, null, 2), 'utf8');
          continue;
        } catch {}
      }
      copyFileWithRetrySync(srcPath, destPath);
    }
  }
}

export function parseInstallCliArgs(argv = process.argv.slice(2)) {
  const safeArgv = Array.isArray(argv) ? argv : [];
  const opts = {
    action: 'install',
    targetDir: '',
    lang: '',
    purge: false,
    dryRun: false,
    silent: false,
    json: false,
    help: false,
  };
  for (let i = 0; i < safeArgv.length; i++) {
    const arg = String(safeArgv[i] || '').trim();
    if (!arg) continue;
    if (arg === '--help' || arg === '-h' || arg === '/?') {
      opts.help = true;
    } else if (arg === '--uninstall' || arg === 'uninstall' || arg === '/U' || arg === '/u') {
      opts.action = 'uninstall';
    } else if (arg === '--status' || arg === 'status') {
      opts.action = 'status';
    } else if (arg === '--purge') {
      opts.purge = true;
    } else if (arg === '--dry-run') {
      opts.dryRun = true;
    } else if (arg === '--silent' || arg === '/S' || arg === '/s') {
      opts.silent = true;
    } else if (arg === '--json') {
      opts.json = true;
    } else if (arg === '--lang' && i + 1 < safeArgv.length) {
      opts.lang = String(safeArgv[++i] || '').trim();
    } else if (arg.startsWith('--lang=')) {
      opts.lang = arg.slice('--lang='.length).trim();
    } else if (arg === '--target' && i + 1 < safeArgv.length) {
      opts.targetDir = String(safeArgv[++i] || '').trim();
    } else if (arg.startsWith('--target=')) {
      opts.targetDir = arg.slice('--target='.length).trim();
    }
  }
  return opts;
}

export function getInstallStatus({ targetDir: customTarget } = {}) {
  const destRoot = resolveTargetDir(customTarget);
  const pluginManifest = safeParseJsonObject(path.join(destRoot, 'plugin.json'));
  const installed = Boolean(fs.existsSync(destRoot) && pluginManifest);
  const hasState = fs.existsSync(path.join(destRoot, 'router-state.json'));
  const internalBackup = path.join(destRoot, '.cache', 'router-state.backup.json');
  const externalBackup = getExternalBackupPath(destRoot);
  const stateBackupPath = fs.existsSync(internalBackup)
    ? internalBackup
    : fs.existsSync(externalBackup)
      ? externalBackup
      : '';
  return {
    installed,
    version: pluginManifest?.version ? String(pluginManifest.version) : '',
    targetDir: destRoot,
    hasState,
    stateBackupPath,
    nodeVersion: process.version,
  };
}

export function runUninstall({ targetDir: customTarget, purge = false, silent = false, lang = '' } = {}) {
  const isRu = normalizeLang(lang || detectOsLocale(), 'en') === 'ru';
  const destRoot = resolveTargetDir(customTarget);
  const externalBackup = getExternalBackupPath(destRoot);
  const log = silent ? () => {} : (...args) => console.log(...args);

  if (!fs.existsSync(destRoot)) {
    if (purge && fs.existsSync(externalBackup)) {
      try {
        fs.unlinkSync(externalBackup);
      } catch {}
    }
    log(isRu ? `[i] Плагин ${PLUGIN_NAME} не найден в: ${destRoot}` : `[i] Plugin ${PLUGIN_NAME} was not found at: ${destRoot}`);
    return {
      ok: true,
      removed: false,
      targetDir: destRoot,
      backupPath: !purge && fs.existsSync(externalBackup) ? externalBackup : '',
    };
  }

  let backupPath = '';
  if (!purge) {
    const backupRes = createStateBackup(destRoot, externalBackup);
    if (backupRes.ok && backupRes.externalBackupPath) {
      backupPath = backupRes.externalBackupPath;
    }
  } else if (fs.existsSync(externalBackup)) {
    try {
      fs.unlinkSync(externalBackup);
    } catch {}
  }

  fs.rmSync(destRoot, { recursive: true, force: true });
  log(isRu ? `[✓] Плагин ${PLUGIN_NAME} удалён из: ${destRoot}` : `[OK] Plugin ${PLUGIN_NAME} removed from: ${destRoot}`);
  if (backupPath) {
    log(isRu ? `[✓] Резервная копия настроек сохранена: ${backupPath}` : `[OK] Settings backup saved: ${backupPath}`);
  }
  return {
    ok: true,
    removed: true,
    targetDir: destRoot,
    backupPath,
  };
}

export function runInstall({ srcRoot = srcDir, targetDir: customTarget, dryRun = false, silent = false, lang = '' } = {}) {
  const isRu = normalizeLang(lang || detectOsLocale(), 'en') === 'ru';
  const resolvedSrc = path.resolve(srcRoot || srcDir);
  const destRoot = resolveTargetDir(customTarget);
  const isDefaultTarget = path.resolve(destRoot) === path.resolve(targetDir);
  const inPlace = resolvedSrc === destRoot;
  const log = silent ? () => {} : (...args) => console.log(...args);

  const srcManifest = safeParseJsonObject(path.join(resolvedSrc, 'plugin.json'));
  const version = srcManifest?.version ? String(srcManifest.version) : '4.0.1';
  const srcStatePath = path.join(resolvedSrc, 'router-state.json');
  const destStatePath = path.join(destRoot, 'router-state.json');
  const externalBackupPath = getExternalBackupPath(destRoot);
  const fallbackBackupState = !fs.existsSync(destStatePath) ? safeParseJsonObject(externalBackupPath) : null;

  if (dryRun) {
    const previewState = computeMergedState(srcStatePath, destStatePath, fallbackBackupState);
    log(isRu ? `[DRY-RUN] Версия: v${version}` : `[DRY-RUN] Version: v${version}`);
    log(isRu ? `[DRY-RUN] Целевая папка: ${destRoot}` : `[DRY-RUN] Target directory: ${destRoot}`);
    log(
      isRu
        ? `[DRY-RUN] Профиль ПК: RAM=${previewState.ramMaxBudgetMb} МБ, CPU=${previewState.cpuMaxThreads} потоков, GPU=${previewState.gpuEnabled ? previewState.gpuChatModel : 'выкл'}`
        : `[DRY-RUN] Hardware profile: RAM=${previewState.ramMaxBudgetMb} MB, CPU=${previewState.cpuMaxThreads} threads, GPU=${previewState.gpuEnabled ? previewState.gpuChatModel : 'off'}`
    );
    if (fallbackBackupState) {
      log(isRu ? `[DRY-RUN] Будут восстановлены настройки из бэкапа: ${externalBackupPath}` : `[DRY-RUN] Will restore settings from backup: ${externalBackupPath}`);
    }
    return {
      ok: true,
      dryRun: true,
      targetDir: destRoot,
      version,
      inPlace,
      orphansRemoved: 0,
      globalDupesRemoved: 0,
      restoredFromBackup: Boolean(fallbackBackupState),
      state: previewState,
    };
  }

  if (fs.existsSync(destStatePath)) {
    createStateBackup(destRoot);
  }

  if (inPlace) {
    log(`[✓] Плагин уже находится в целевой директории: ${destRoot} — выполняем калибровку и обслуживание.`);
    try {
      calibrateOrMergeState(destStatePath, destStatePath, fallbackBackupState);
    } catch {}
  } else {
    try {
      buildPanelUi({ repoRoot: resolvedSrc });
    } catch {}
    copyRecursive(resolvedSrc, destRoot, destRoot, { fallbackExistingState: fallbackBackupState });
  }

  try {
    const finalState = safeParseJsonObject(destStatePath);
    if (finalState) {
      syncMcpRamBudget(destRoot, finalState.ramMaxBudgetMb || 4096, {
        resolveAbsoluteEntry: true,
        gpuEnabled: Boolean(finalState.gpuEnabled),
      });
    }
  } catch {}

  let orphansRemoved = 0;
  if (!inPlace) {
    orphansRemoved = pruneRootOrphans(resolvedSrc, destRoot);
    for (const managedDir of ['core', 'sidecars', 'skills', 'rules', 'assets', 'agents']) {
      orphansRemoved += pruneOrphanFiles(path.join(resolvedSrc, managedDir), path.join(destRoot, managedDir));
    }

    // Очистка устаревших файлов и временных папок прошлых версий в целевой директории плагина
    for (const legacyDirRel of ['scratch', '.agents', 'checkpoints', '--ws']) {
      const legacyDirPath = path.join(destRoot, legacyDirRel);
      try {
        if (fs.existsSync(legacyDirPath)) {
          fs.rmSync(legacyDirPath, { recursive: true, force: true });
        }
      } catch {}
    }
    for (const legacyRel of [
      path.join('core', 'roi-tracker.mjs'),
      path.join('.cache', 'optimization-metrics.json'),
      path.join('.cache', 'roi-metrics.json'),
      path.join('.cache', 'transcript-telemetry-cache.json'),
    ]) {
      const legacyPath = path.join(destRoot, legacyRel);
      try {
        if (fs.existsSync(legacyPath)) {
          fs.unlinkSync(legacyPath);
        }
      } catch {}
    }
  }

  const globalDupesRemoved = isDefaultTarget ? purgeDuplicateGlobalSkills(destRoot) : 0;

  // Чистка и обновление кэшей (.cache) The Tunnel v4.0.1: legacy priors/ledgers, старый f32bin-v1, нулевые repomap/digest
  const targetCacheStats = maintainCacheDir(path.join(destRoot, '.cache'));
  const localCacheStats = inPlace || !isDefaultTarget
    ? { repomapsRemoved: 0, vectorsPurged: 0, digestsPruned: 0, legacyRemoved: 0 }
    : maintainCacheDir(path.join(resolvedSrc, '.cache'));
  const totalRepomapsRemoved = targetCacheStats.repomapsRemoved + localCacheStats.repomapsRemoved;
  const totalVectorsPurged = targetCacheStats.vectorsPurged + localCacheStats.vectorsPurged;
  const totalDigestsPruned = targetCacheStats.digestsPruned + localCacheStats.digestsPruned;
  const totalLegacyRemoved = targetCacheStats.legacyRemoved + localCacheStats.legacyRemoved;

  log(
    isRu
      ? `[✓] Обслуживание The Tunnel v4.0.1: удалено сирот=${orphansRemoved}, дублей скиллов v3.0=${globalDupesRemoved}, legacy-кэшей=${totalLegacyRemoved}, устаревших f32bin/json векторов=${totalVectorsPurged}, устаревших repomap=${totalRepomapsRemoved}, старых дайджестов=${totalDigestsPruned}`
      : `[OK] The Tunnel v4.0.1 maintenance: orphansRemoved=${orphansRemoved}, dupSkills=${globalDupesRemoved}, legacyCaches=${totalLegacyRemoved}, staleVectors=${totalVectorsPurged}, staleRepomaps=${totalRepomapsRemoved}, prunedDigests=${totalDigestsPruned}`
  );
  if (fallbackBackupState) {
    log(isRu ? `[✓] Пользовательские настройки восстановлены из резервной копии: ${externalBackupPath}` : `[OK] User settings restored from backup: ${externalBackupPath}`);
  }
  log(isRu ? `[✓] Плагин The Tunnel (${PLUGIN_NAME}) v${version} успешно установлен в:` : `[OK] Plugin The Tunnel (${PLUGIN_NAME}) v${version} installed to:`);
  log(`    ${destRoot}`);
  log(isRu ? `\nПерезапустите Google Antigravity или напишите агенту в чате:` : `\nRestart Google Antigravity or ask the agent in chat:`);
  log(isRu ? `    "Открой панель управления The Tunnel"` : `    "Open the The Tunnel control panel"`);

  return {
    ok: true,
    dryRun: false,
    targetDir: destRoot,
    version,
    inPlace,
    orphansRemoved,
    globalDupesRemoved,
    restoredFromBackup: Boolean(fallbackBackupState),
  };
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  const self = path.resolve(__filename);
  const arg = path.resolve(process.argv[1]);
  return process.platform === 'win32' ? self.toLowerCase() === arg.toLowerCase() : self === arg;
})();
if (isMain) {
  const cliOpts = parseInstallCliArgs(process.argv.slice(2));
  const isRu = normalizeLang(cliOpts.lang || detectOsLocale(), 'en') === 'ru';
  const nodeMajor = Number(String(process.versions?.node || '0').split('.')[0]) || 0;
  if (nodeMajor < 22) {
    console.error(
      isRu
        ? `[ОШИБКА] Требуется Node.js v22.0.0+ (текущая: v${process.versions?.node || '?'}). Установите актуальную LTS с https://nodejs.org/`
        : `[ERROR] Node.js v22.0.0+ is required (found v${process.versions?.node || '?'}). Install current LTS from https://nodejs.org/`
    );
    process.exit(1);
  }
  if (cliOpts.help) {
    console.log([
      isRu ? `Установщик ${PLUGIN_NAME}:` : `${PLUGIN_NAME} installer:`,
      '  node install.js [--target <dir>] [--lang en|ru] [--dry-run] [--silent]',
      '  node install.js --status [--target <dir>] [--lang en|ru] [--json]',
      '  node install.js --uninstall [--target <dir>] [--lang en|ru] [--purge] [--silent]',
    ].join('\n'));
  } else if (cliOpts.action === 'status') {
    const st = getInstallStatus({ targetDir: cliOpts.targetDir });
    if (cliOpts.json) {
      console.log(JSON.stringify(st, null, 2));
    } else if (isRu) {
      console.log(`Статус: ${st.installed ? `установлен (v${st.version || '?'})` : 'не установлен'}`);
      console.log(`Путь:   ${st.targetDir}`);
      console.log(`Настройки: ${st.hasState ? 'найдены' : 'нет'}${st.stateBackupPath ? ` (бэкап: ${st.stateBackupPath})` : ''}`);
      console.log(`Node.js: ${st.nodeVersion}`);
    } else {
      console.log(`Status:   ${st.installed ? `installed (v${st.version || '?'})` : 'not installed'}`);
      console.log(`Path:     ${st.targetDir}`);
      console.log(`Settings: ${st.hasState ? 'present' : 'none'}${st.stateBackupPath ? ` (backup: ${st.stateBackupPath})` : ''}`);
      console.log(`Node.js:  ${st.nodeVersion}`);
    }
  } else if (cliOpts.action === 'uninstall') {
    runUninstall({ targetDir: cliOpts.targetDir, purge: cliOpts.purge, silent: cliOpts.silent, lang: cliOpts.lang });
  } else {
    runInstall({ targetDir: cliOpts.targetDir, dryRun: cliOpts.dryRun, silent: cliOpts.silent, lang: cliOpts.lang });
  }
}

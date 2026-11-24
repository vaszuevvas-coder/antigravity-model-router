/**
 * @file panel-state-skills.mjs
 * @description Panel state schema, sanitization, lazy core loaders, skill discovery, and RAM daemon IPC helpers.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import http from 'node:http';
import { cpus, homedir, totalmem } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getSubscriptionCapabilities, sanitizeSwarmWorkerTierForSubscription } from '../../../core/model-profile.mjs';
import { safeReadJsonSync, updateJsonAtomicSync } from '../../../core/safe-json.mjs';
import { BLOCKED_PROTO_KEYS, isAllowedLoopbackEndpoint, isPidAlive, isValidWorkspaceDir } from './panel-security.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Путь к файлу состояния в корне плагина
export const STATE_PATH = join(__dirname, '..', '..', '..', 'router-state.json');

export function resolvePanelStatePath() {
  const envPath = typeof process.env.TUNNEL_TEST_STATE_PATH === 'string' ? process.env.TUNNEL_TEST_STATE_PATH.trim() : '';
  return envPath ? resolve(envPath) : STATE_PATH;
}

export const DEPRECATED_STATE_KEYS = [
  'recommendTeamwork',
  'recommendSkills',
  'activeSkillProfiles',
  'splitExecution',
  'chainOfDraft',
  'workerModel',
];

export const DEFAULT_PANEL_BLOCK_ORDER = [
  'smartProjectBanner',
  'agLiveProgressWrap',
  'smartComposerCard',
  'skillsSectionCard',
  'agentModeCard',
  'skillProfilesFieldset',
  'swarmTelemetryCard',
  'gpuRamCard',
  'sentinelSectionCard',
  'snapshotsBayesianSpoiler',
  'expertDetailsBox',
  'checkpointsCard',
  'intelligenceBayesianCard',
  'expertCircuitBox',
  'expertPitfallsBox',
  'expertKnowledgeBox',
  'expertGuardrailsCard',
  'expertProfileCard',
  'expertRamGpuFieldset',
];

const VALID_PANEL_BLOCK_IDS = new Set(DEFAULT_PANEL_BLOCK_ORDER);

export const COLLAPSIBLE_PANEL_CARD_IDS = new Set([
  'smartComposerCard',
  'skillsSectionCard',
  'agentModeCard',
  'skillProfilesFieldset',
  'swarmTelemetryCard',
  'gpuRamCard',
  'sentinelSectionCard',
  'checkpointsCard',
  'intelligenceBayesianCard',
  'expertGuardrailsCard',
  'expertProfileCard',
  'expertRamGpuFieldset',
]);

export const DEFAULT_COLLAPSED_PANEL_CARDS = {
  swarmTelemetryCard: true,
  gpuRamCard: true,
  sentinelSectionCard: true,
};

export const PANEL_SPOILER_IDS = new Set([
  'snapshotsBayesianSpoiler',
  'expertDetailsBox',
]);

export function sanitizeBooleanIdMap(rawMap, allowedIds) {
  if (!rawMap || typeof rawMap !== 'object' || Array.isArray(rawMap)) return null;
  const out = {};
  for (const [key, val] of Object.entries(rawMap)) {
    if (BLOCKED_PROTO_KEYS.has(key)) continue;
    if (allowedIds.has(key) && val === true) {
      out[key] = true;
    }
  }
  return out;
}

export function migrateLegacyPanelCollapsedCards(rawState) {
  if (!rawState || typeof rawState !== 'object' || Array.isArray(rawState)) return null;
  const rawCollapsed =
    rawState.panelCollapsedCards && typeof rawState.panelCollapsedCards === 'object' && !Array.isArray(rawState.panelCollapsedCards)
      ? { ...rawState.panelCollapsedCards }
      : null;
  const rawSpoilers =
    rawState.panelOpenSpoilers && typeof rawState.panelOpenSpoilers === 'object' && !Array.isArray(rawState.panelOpenSpoilers)
      ? rawState.panelOpenSpoilers
      : null;
  const rawOrder = Array.isArray(rawState.panelBlockOrder) ? rawState.panelBlockOrder : null;
  const hasLegacyOrder = Boolean(
    rawOrder && (rawOrder.includes('telemetrySwarmSpoiler') || rawOrder.includes('hardwareResourcesSpoiler'))
  );
  const hasLegacySpoilers = Boolean(
    rawSpoilers && (Object.hasOwn(rawSpoilers, 'telemetrySwarmSpoiler') || Object.hasOwn(rawSpoilers, 'hardwareResourcesSpoiler'))
  );
  if (!hasLegacyOrder && !hasLegacySpoilers) {
    return sanitizeBooleanIdMap(rawCollapsed, COLLAPSIBLE_PANEL_CARD_IDS);
  }
  const next = { ...(rawCollapsed || {}) };
  if (!rawSpoilers?.telemetrySwarmSpoiler) {
    next.swarmTelemetryCard = true;
  }
  if (!rawSpoilers?.hardwareResourcesSpoiler) {
    next.gpuRamCard = true;
    next.sentinelSectionCard = true;
  } else if (next.gpuRamCard === true && !Object.hasOwn(next, 'sentinelSectionCard')) {
    next.sentinelSectionCard = true;
  }
  return sanitizeBooleanIdMap(next, COLLAPSIBLE_PANEL_CARD_IDS);
}

export function sanitizePanelBlockOrder(rawOrder) {
  if (!Array.isArray(rawOrder)) return null;
  const seen = new Set();
  const out = [];
  const pushUnique = (id) => {
    if (VALID_PANEL_BLOCK_IDS.has(id) && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  };
  const trimmedList = rawOrder.map((item) => (typeof item === 'string' ? item.trim() : ''));
  const hasExplicitSentinel = trimmedList.includes('sentinelSectionCard');
  for (const id of trimmedList) {
    if (id === 'telemetrySwarmSpoiler') {
      pushUnique('swarmTelemetryCard');
      continue;
    }
    if (id === 'hardwareResourcesSpoiler') {
      pushUnique('gpuRamCard');
      if (!hasExplicitSentinel) pushUnique('sentinelSectionCard');
      continue;
    }
    pushUnique(id);
    if (id === 'gpuRamCard' && !hasExplicitSentinel) {
      pushUnique('sentinelSectionCard');
    }
  }
  if (out.length === 0) return null;
  for (const defId of DEFAULT_PANEL_BLOCK_ORDER) {
    if (!seen.has(defId)) {
      seen.add(defId);
      if (defId === 'smartComposerCard') {
        const anchorIdx = out.indexOf('agLiveProgressWrap');
        if (anchorIdx >= 0) {
          out.splice(anchorIdx + 1, 0, defId);
          continue;
        }
      }
      if (defId === 'sentinelSectionCard') {
        const anchorIdx = out.indexOf('gpuRamCard');
        if (anchorIdx >= 0) {
          out.splice(anchorIdx + 1, 0, defId);
          continue;
        }
      }
      out.push(defId);
    }
  }
  return out;
}

export const VALID_PANEL_SECTIONS = new Set([
  'core',
  'skills',
  'swarm',
  'hw',
  'checkpoints',
  'bayesian',
  'circuit',
  'compaction',
  'pitfalls',
]);

export function resolvePanelFetchSections(queryData = {}, state = {}, options = {}) {
  const orderedBlocks = sanitizePanelBlockOrder(state?.panelBlockOrder) || [...DEFAULT_PANEL_BLOCK_ORDER];
  const openSpoilers = sanitizeBooleanIdMap(state?.panelOpenSpoilers, PANEL_SPOILER_IDS) || {};
  const collapsedCards = migrateLegacyPanelCollapsedCards(state) || {};

  const rawSections = queryData?.sections;
  const adaptive = queryData?.adaptive === '1' || queryData?.adaptive === true || queryData?.adaptive === 'true';
  const defaultNone = Boolean(options?.defaultNone);

  let requestedList = [];
  if (typeof rawSections === 'string' && rawSections.trim()) {
    requestedList = rawSections.split(',');
  } else if (Array.isArray(rawSections) && rawSections.length > 0) {
    requestedList = rawSections;
  }

  const explicitSet = new Set();
  for (const item of requestedList) {
    const clean = typeof item === 'string' ? item.trim() : '';
    if (clean && !BLOCKED_PROTO_KEYS.has(clean) && VALID_PANEL_SECTIONS.has(clean)) {
      explicitSet.add(clean);
    }
  }

  const flags = {
    all: false,
    core: true,
    skills: false,
    swarm: false,
    hw: false,
    checkpoints: false,
    bayesian: false,
    circuit: false,
    compaction: false,
    pitfalls: false,
  };

  if (explicitSet.size > 0) {
    flags.core = !defaultNone || explicitSet.has('core');
    for (const sec of VALID_PANEL_SECTIONS) {
      if (sec !== 'core' && explicitSet.has(sec)) {
        flags[sec] = true;
      }
    }
  } else if (adaptive) {
    const snapshotsOpen = Boolean(openSpoilers.snapshotsBayesianSpoiler);
    const expertOpen = Boolean(openSpoilers.expertDetailsBox);
    flags.core = true;
    flags.skills = !collapsedCards.skillsSectionCard;
    flags.swarm = !collapsedCards.swarmTelemetryCard;
    flags.hw =
      !collapsedCards.gpuRamCard ||
      !collapsedCards.sentinelSectionCard ||
      (expertOpen && !collapsedCards.expertRamGpuFieldset);
    flags.checkpoints = snapshotsOpen && !collapsedCards.checkpointsCard;
    flags.bayesian = snapshotsOpen && !collapsedCards.intelligenceBayesianCard;
    flags.circuit = expertOpen || !collapsedCards.agentModeCard;
    flags.compaction = expertOpen;
    flags.pitfalls = expertOpen;
  } else if (!defaultNone) {
    flags.all = true;
    for (const sec of VALID_PANEL_SECTIONS) {
      flags[sec] = true;
    }
  } else {
    flags.core = false;
  }

  const included = [];
  const deferred = [];
  for (const sec of VALID_PANEL_SECTIONS) {
    if (flags[sec]) included.push(sec);
    else deferred.push(sec);
  }

  return {
    ...flags,
    included,
    deferred,
    orderedBlocks,
  };
}

export const DEFAULT_STATE = {
  strategy: 'flash_dispatcher',
  heavyThreshold: 'L',
  showBadge: true,
  confirmBeforeRun: true,
  confirmThreshold: 'M',
  orchestratorSmartSynergy: true,
  swarmMode: 'auto_xl',
  swarmWorkerTier: 'hydrogen_auto',
  swarmAutoVerifier: true,
  swarmQuotaFailover: true,
  panelTheme: 'glass_teal',
  uiLanguage: 'en',
  panelBlockOrder: [...DEFAULT_PANEL_BLOCK_ORDER],
  panelCollapsedCards: { ...DEFAULT_COLLAPSED_PANEL_CARDS },
  panelOpenSpoilers: {},
  selfVerify: true,
  subscriptionTier: 'pro',
  hardwareProfiled: false,
  onboardingCompleted: false,
  uiDesignPreviewGate: true,
  uiInspirationMode: 'ask',
  grillMode: 'auto',
  leanMode: 'full',
  terseMode: 'off',
  skillModes: {},
  repoMap: true,
  toolPruning: true,
  diffOnly: true,
  obsMasking: true,
  cascadeVerify: true,
  shadowCheckpoints: true,
  transactionalPatch: true,
  blastRadius: true,
  circuitBreaker: true,
  historyCompaction: true,
  compactionTokenThreshold: 120000,
  pitfallLedger: true,
  thinkingLimiter: true,
  pageRankGraph: true,
  zeroTurnSlices: true,
  bayesianRouter: true,
  testImpactVerify: true,
  sessionHandoff: true,
  readDedup: true,
  skillCrystallizer: true,
  securityGuard: true,
  configProtection: true,
  completionGates: true,
  hookProfile: 'standard',
  ramCacheEnabled: true,
  ramMaxBudgetMb: 4096,
  ramAutoWarmOnSessionStart: true,
  ramSotaEngines: true,
  gpuWarmHostRamCache: true,
  gpuEnabled: false,
  gpuEndpoint: 'http://127.0.0.1:11434',
  gpuMaxVramMb: 4096,
  gpuChatModel: 'gemma4:12b',
  gpuEmbedModel: 'qwen3-embedding:0.6b',
  gpuKeepAlive: '15m',
  gpuEmbedKeepAlive: '90m',
  gpuContextTokens: 4096,
  gpuModelsDir: '',
  gpuAutoStart: true,
  gpuAutoDistillLogs: true,
  gpuSemanticSearch: true,
  gpuShowPreTaskAdvice: true,
  gpuUnloadOnExit: true,
  gpuPostEditCritic: true,
  cpuMulticoreEnabled: true,
  cpuMaxThreads: 6,
  cpuTrigramIndex: true,
  cpuCrossRerank: true,
  cpuParallelVerify: true,
  cpuSotaEngines: true,
  sentinelEnabled: true,
  sentinelShadowGuard: true,
  sentinelLocalBugBot: true,
  sentinelSymbolCards: true,
  sentinelSpeculativeWarm: true,
  sentinelShadowTests: false,
  lspBridgeEnabled: true,
  sqliteKnowledgeEnabled: true,
  shadowWorktreeEnabled: true,
  runtimeWiretapEnabled: true,
  quotaPacerEnabled: true,
  composerVoiceEnabled: false,
  mutationGuardEnabled: false,
  federatedWorkspaces: [],
  floatingHudEnabled: false,
  updatedAt: new Date().toISOString(),
};

export const ALLOWED_STATE_KEYS = new Set(Object.keys(DEFAULT_STATE));

const VALID_STRATEGIES = new Set(['balanced', 'economy', 'performance', 'flash_dispatcher', 'auto_balance', 'pro_architect']);

const VALID_THRESHOLDS = new Set(['ALL', 'S', 'M', 'L', 'XL', 'OFF']);

const VALID_SWARM_MODES = new Set(['auto_xl', 'aggressive_l', 'manual_only', 'off', 'always_ask', 'auto_all']);

const VALID_SWARM_TIERS = new Set(['hydrogen_auto', 'neon_auto', 'inherit', 'argon_auto', 'carbon_auto']);

const VALID_THEMES = new Set(['glass_teal', 'studio_titanium']);
const VALID_UI_LANGUAGES = new Set(['en', 'ru']);

export function normalizeUiLanguageValue(rawLang, fallback = null) {
  const s = typeof rawLang === 'string' ? rawLang.trim().toLowerCase() : '';
  if (VALID_UI_LANGUAGES.has(s)) return s;
  return fallback;
}

const LEGACY_THEME_FALLBACKS = {
  amber_hive: 'glass_teal',
  conductor_paper: 'studio_titanium',
};

function normalizePanelThemeValue(rawTheme) {
  const s = typeof rawTheme === 'string' ? rawTheme.trim() : '';
  if (VALID_THEMES.has(s)) return s;
  if (Object.hasOwn(LEGACY_THEME_FALLBACKS, s)) return LEGACY_THEME_FALLBACKS[s];
  return null;
}

const VALID_SUBSCRIPTION_TIERS = new Set(['pro', 'ultra']);

const VALID_UI_INSPIRATION_MODES = new Set(['ask', 'showroom', 'web_refs']);

const VALID_GRILL_MODES = new Set(['off', 'auto', 'always']);

const VALID_LEAN_MODES = new Set(['off', 'lite', 'full', 'ultra']);

const VALID_TERSE_MODES = new Set(['off', 'caveman', 'ultracave']);

const VALID_HOOK_PROFILES = new Set(['minimal', 'standard', 'strict']);

export function clampSafeInt(val, min, max, fallback) {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

export function getRuntimeHardwareCeilings(ceilingsOverride = null) {
  if (ceilingsOverride && typeof ceilingsOverride === 'object') {
    return ceilingsOverride;
  }
  try {
    if (panelRuntime.hardwareProfilerSync?.computeHardwareCeilings) {
      return panelRuntime.hardwareProfilerSync.computeHardwareCeilings({
        pluginRoot: join(__dirname, '..', '..', '..'),
      });
    }
  } catch {}
  const ramMb = Math.max(1024, Math.round(totalmem() / (1024 * 1024)));
  const cores = Math.max(1, (cpus() || []).length || 4);
  return {
    totalRamMb: ramMb,
    totalRamGb: Math.max(1, Math.round(ramMb / 1024)),
    logicalCores: cores,
    gpuAvailable: false,
    gpuName: '',
    gpuTotalVramMb: 0,
    maxVramMb: 4096,
    maxRamBudgetMb: ramMb <= 8700 ? 4096 : ramMb <= 17500 ? 8192 : ramMb <= 35000 ? 16384 : 32768,
    maxCpuThreads: Math.max(2, Math.min(64, cores - 4)),
  };
}

export function sanitizeStatePatch(patch = {}, options = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return {};
  const ceilings = getRuntimeHardwareCeilings(options?.ceilings);
  const out = {};
  for (const [key, val] of Object.entries(patch)) {
    if (BLOCKED_PROTO_KEYS.has(key) || !ALLOWED_STATE_KEYS.has(key) || key === 'updatedAt') continue;
    if (typeof DEFAULT_STATE[key] === 'boolean') {
      if (typeof val === 'boolean') out[key] = val;
      continue;
    }
    switch (key) {
      case 'strategy':
        if (VALID_STRATEGIES.has(String(val))) out[key] = String(val);
        break;
      case 'heavyThreshold':
      case 'confirmThreshold':
        if (VALID_THRESHOLDS.has(String(val))) out[key] = String(val);
        break;
      case 'swarmMode':
        if (VALID_SWARM_MODES.has(String(val))) out[key] = String(val);
        break;
      case 'swarmWorkerTier':
        if (VALID_SWARM_TIERS.has(String(val))) out[key] = String(val);
        break;
      case 'panelTheme': {
        const normTheme = normalizePanelThemeValue(val);
        if (normTheme) out[key] = normTheme;
        break;
      }
      case 'uiLanguage': {
        const normLang = normalizeUiLanguageValue(val);
        if (normLang) out[key] = normLang;
        break;
      }
      case 'subscriptionTier':
        if (VALID_SUBSCRIPTION_TIERS.has(String(val))) out[key] = String(val);
        break;
      case 'uiInspirationMode':
        if (VALID_UI_INSPIRATION_MODES.has(String(val))) out[key] = String(val);
        break;
      case 'grillMode':
        if (VALID_GRILL_MODES.has(String(val))) out[key] = String(val);
        break;
      case 'leanMode':
        if (VALID_LEAN_MODES.has(String(val))) out[key] = String(val);
        break;
      case 'terseMode':
        if (VALID_TERSE_MODES.has(String(val))) out[key] = String(val);
        break;
      case 'hookProfile':
        if (VALID_HOOK_PROFILES.has(String(val))) out[key] = String(val);
        break;
      case 'compactionTokenThreshold':
        out[key] = clampSafeInt(val, 16000, 500000, DEFAULT_STATE.compactionTokenThreshold);
        break;
      case 'ramMaxBudgetMb':
        out[key] = clampSafeInt(
          val,
          512,
          ceilings.maxRamBudgetMb,
          Math.min(DEFAULT_STATE.ramMaxBudgetMb, ceilings.maxRamBudgetMb)
        );
        break;
      case 'gpuMaxVramMb':
        out[key] = clampSafeInt(
          val,
          2048,
          ceilings.maxVramMb,
          Math.min(DEFAULT_STATE.gpuMaxVramMb, ceilings.maxVramMb)
        );
        break;
      case 'gpuContextTokens':
        out[key] = clampSafeInt(val, 2048, 32768, DEFAULT_STATE[key]);
        break;
      case 'cpuMaxThreads':
        out[key] = clampSafeInt(
          val,
          1,
          ceilings.maxCpuThreads,
          Math.min(DEFAULT_STATE.cpuMaxThreads, ceilings.maxCpuThreads)
        );
        break;
      case 'gpuEndpoint': {
        const cleanEp = typeof val === 'string' ? val.trim().replace(/\/+$/, '') : '';
        if (isAllowedLoopbackEndpoint(cleanEp)) out[key] = cleanEp;
        break;
      }
      case 'gpuChatModel':
      case 'gpuEmbedModel':
      case 'gpuKeepAlive':
      case 'gpuEmbedKeepAlive': {
        if (typeof val === 'string') {
          const clean = val.trim();
          if (clean && clean.length <= 128 && !/[\r\n\0]/.test(clean)) out[key] = clean;
        }
        break;
      }
      case 'gpuModelsDir': {
        if (typeof val === 'string') {
          const clean = val.trim();
          if (clean.length <= 512 && !/[\r\n\0]/.test(clean)) out[key] = clean;
        }
        break;
      }
      case 'skillModes':
        if (val && typeof val === 'object' && !Array.isArray(val)) {
          out[key] = sanitizeSkillModesPatch(val);
        }
        break;
      case 'panelBlockOrder': {
        const cleanOrder = sanitizePanelBlockOrder(val);
        if (cleanOrder) out[key] = cleanOrder;
        break;
      }
      case 'panelCollapsedCards': {
        const cleanCollapsed = sanitizeBooleanIdMap(val, COLLAPSIBLE_PANEL_CARD_IDS);
        if (cleanCollapsed) out[key] = cleanCollapsed;
        break;
      }
      case 'panelOpenSpoilers': {
        const cleanSpoilers = sanitizeBooleanIdMap(val, PANEL_SPOILER_IDS);
        if (cleanSpoilers) out[key] = cleanSpoilers;
        break;
      }
      case 'federatedWorkspaces': {
        if (Array.isArray(val)) {
          const seen = new Set();
          const peers = [];
          for (const item of val) {
            const s = typeof item === 'string' ? item.trim() : '';
            if (!s || s.length > 512 || /[\r\n\0]/.test(s) || BLOCKED_PROTO_KEYS.has(s)) continue;
            if (!isValidWorkspaceDir(s)) continue;
            const resolved = resolve(s);
            const normKey = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
            if (seen.has(normKey)) continue;
            seen.add(normKey);
            peers.push(resolved);
            if (peers.length >= 8) break;
          }
          out[key] = peers;
        }
        break;
      }
      default:
        break;
    }
  }
  if (out.subscriptionTier === 'pro' && out.swarmWorkerTier) {
    out.swarmWorkerTier = sanitizeSwarmWorkerTierForSubscription('pro', out.swarmWorkerTier);
  } else if (options?.currentSubscriptionTier === 'pro' && out.subscriptionTier !== 'ultra' && out.swarmWorkerTier) {
    out.swarmWorkerTier = sanitizeSwarmWorkerTierForSubscription('pro', out.swarmWorkerTier);
  }
  return out;
}

export { getSubscriptionCapabilities, sanitizeSwarmWorkerTierForSubscription };

// Human-readable English titles for Skill Registry cards
const SKILL_EN_TITLES = {
  'ui-ux-design-system': '🎨 Design, Style & Variant Showroom (A/B/C)',
  'game-systems-architect': '🎮 Game Mechanics, Balance & Game Feel',
  'deep-stress-auditor': '🔬 Deep Project Stress & Security Audit',
  'vj-video-fx-studio': '📺 DaVinci OpenFX, Resolume Shaders & Broadcast',
  'programmatic-video-studio': '🎬 Programmatic Video & Motion (HyperFrames / Remotion)',
  'binary-app-localizer': '📦 App, Game & Binary Resource Localization',
  'ru-docs': '📝 Russian Technical Docs & Guides',
  'ru-ui-update': '🇷🇺 Antigravity Russian UI Pack Updater',
  'ast-codemod-refactor': '🛠️ Safe Multi-File AST Refactor & Rename',
  'program-slicer-ocd': '🔍 Data-Flow Program Slicing for Large Files',
  'delta-bug-minimizer': '🐞 Automated Delta Debugging for Flaky Failures',
  'skill-architect': '🏗️ AI Skill Designer & Trigger Auditor (Skill Architect)',
  'github-publish-guard': '🐙 GitHub Publish Guard (Privacy, Rules & Release Audit)',
  'context7-mcp': '📚 Up-to-Date Library & Framework Docs (Context7)',
  'chrome-devtools': '🌐 Live Browser UI & Network Inspector',
  'a11y-debugging': '👁️ Accessibility, Contrast & Keyboard Audit',
  'debug-optimize-lcp': '⚡ Page Load Speed & LCP Optimizer',
  'memory-leak-debugging': '🧹 Heap Snapshot & Memory Leak Debugger',
  'cookie-debugging': '🔑 Session, Auth & Cookie Diagnostics',
  'troubleshooting': '🔌 Browser Debugger Connection Diagnostics',
  'model-router': '🧭 The Tunnel · 3D Model Router & AI Autopilot',
  'context-fork': '🧩 Context Window & Token Economy Protocol',
  'plugin': '🔌 Plugin Manager & Bundling Guide',
  'agy-customizations': '⚙️ Antigravity Rules, Hooks & Customizations',
  'antigravity-guide': '📖 Antigravity Features, CLI & Reference',
  'automation': '⏰ Scheduled Background Automations',
  'ui-plugin-navigation': '🪟 Side-Pane UI Plugin Quick Navigation',
  'migrate-workflows': '🔄 Legacy Workflow-to-Skill Migrator',
  'migrate-agent-settings': '📥 Import Settings from Other AI Agents',
  'generative_ui': '✨ Interactive HTML Widgets & Diagrams in Chat',
  'mcp-app-development': '🪟 Interactive MCP App & Side-Pane Builder',
  'permissioned-github': '🐙 Permissioned GitHub Workflow Helper',
  'swarm': '🐝 Parallel Swarm Coordination for Large Tasks',
  'swarm_monitor': '⏱️ Swarm Anti-Stall Monitor Worker',
  'swarm_narrator': '📰 Live Swarm Overview Narrator',
  'swarm_pane': '📊 Swarm Overview Plan & Timeline Updater',
  'run-workflow': '🔀 Multi-Agent Python Pipeline (Workflow)',
  'sonar-integrate': '🛡️ Connect SonarQube CLI & MCP Server',
  'sonar-analyze': '🔍 Analyze File with SonarQube',
  'sonar-quality-gate': '🚦 SonarQube Quality Gate Status',
  'sonar-list-issues': '📋 List SonarQube Code Issues',
  'sonar-fix-issue': '🔧 Fix Specific SonarQube Issue',
  'sonar-coverage': '🧪 Find Low Test Coverage Lines',
  'sonar-duplication': '📑 Detect Duplicated Code Blocks',
  'sonar-dependency-risks': '📦 Scan Dependency Risks (SCA / CVE)',
  'sonar-triage-dependency-risks': '🩺 Triage Reachable CVEs & Dependency Fixes',
  'sonar-list-projects': '🗂️ List Accessible SonarQube Projects',
  'gemini-api-dev': '✨ Build Apps with Gemini API SDK',
  'gemini-api-cli': '💻 Run Gemini API & Media from Terminal',
  'gemini-live-api-dev': '🎙️ Real-Time Voice & Streaming (Gemini Live API)',
  'gemini-omni-flash-api': '🎬 Video Generation & Editing (Gemini Omni)',
};

// Plain-language triggers: when AI Autopilot attaches each skill automatically
const SKILL_EN_HINTS = {
  'ui-ux-design-system': 'Activates when you redesign screens, UI, or animations — offers visual style calibration and A/B/C previews',
  'game-systems-architect': 'Activates for game projects — helps design progression math, combat feel, economies, and deterministic loops',
  'deep-stress-auditor': 'Activates for deep stability checks — uncovers concurrency hazards, security taint flows, and runtime bottlenecks',
  'vj-video-fx-studio': 'Activates for DaVinci Resolve OpenFX, Resolume GLSL/ISF shaders, Wire patches, and broadcast overlays',
  'programmatic-video-studio': 'Activates for code-driven promo videos, animated intros, or UI demos rendered to MP4/WebM via HyperFrames/Remotion',
  'binary-app-localizer': 'Activates when translating Electron ASAR bundles, desktop apps, JSON/XML resources, or game strings safely',
  'ru-docs': 'Activates when writing or translating clear Russian READMEs, changelogs, and API guides',
  'ru-ui-update': 'Activates when checking, updating, or rolling back Russian UI localization of Antigravity',
  'ast-codemod-refactor': 'Activates when renaming symbols, rewriting signatures, or migrating imports across 3+ files safely',
  'program-slicer-ocd': 'Activates when tracing variable mutations across large (>150L) files without burning full-file tokens',
  'delta-bug-minimizer': 'Activates for flaky or oversized failing inputs — binary-searches down to a minimal reproducer',
  'skill-architect': 'Activates when authoring or linting SKILL.md bundles — prevents trigger collisions and context bloat',
  'github-publish-guard': 'Activates before GitHub pushes or releases — checks for local machine paths, secrets, GitHub limits, and version/docs accuracy',
  'context7-mcp': 'Activates when up-to-date framework and library documentation is needed without AI guesswork',
  'chrome-devtools': 'Activates for live browser page inspection, DOM checks, performance traces, and UI automation',
  'a11y-debugging': 'Activates when auditing semantic HTML, ARIA labels, focus states, and color contrast',
  'debug-optimize-lcp': 'Activates when diagnosing slow page loads, Core Web Vitals, or hero render bottlenecks (LCP)',
  'memory-leak-debugging': 'Activates when diagnosing slowdowns, OOM errors, or retained JS heap growth via DevTools',
  'cookie-debugging': 'Activates when troubleshooting auth redirects, 401/403 session issues, or SameSite cookie flags',
  'troubleshooting': 'Activates when Chrome DevTools browser targets or MCP connections fail to attach',
  'model-router': 'Controls 3D Task Triage, model power tiers, Swarm routing, and Pre-Task confirmation gates',
  'context-fork': 'Guides cache-aligned reads, RAM slicing, and read-only exploration offloading to preserve prompt budget',
  'plugin': 'Activates when installing, enabling, disabling, or packaging extensions into Antigravity plugins',
  'agy-customizations': 'Activates when configuring skills, rules, hooks, and MCP servers across Antigravity scopes',
  'antigravity-guide': 'Activates when answering questions about Antigravity IDE, CLI, shortcuts, and configuration',
  'automation': 'Activates when setting up recurring cron jobs or scheduled background automations',
  'ui-plugin-navigation': 'Surfaces one-click pills in chat to open relevant side-pane plugin dashboards',
  'migrate-workflows': 'Migrates legacy workflow files into modular SKILL.md skills safely',
  'migrate-agent-settings': 'Imports MCP servers, skills, slash commands, and rules from Cursor, Claude Code, Codex, or Gemini CLI',
  'generative_ui': 'Activates when interactive HTML charts, diagrams, or widgets explain concepts better than plain text',
  'mcp-app-development': 'Activates when building or theming interactive MCP App UIs for chat or side panes',
  'permissioned-github': 'Handles restricted GitHub operations cleanly with least-privilege permission prompts',
  'swarm': 'Engages on wide XL tasks: parallel isolated workers per module plus @verifier code review',
  'swarm_monitor': 'Internal Swarm watchdog: pings stalled workers only if the entire Swarm stops making progress',
  'swarm_narrator': 'Internal Swarm coordinator: keeps the live Overview status and artifact timeline up to date',
  'swarm_pane': 'Updates goal groups and screenshot timeline inside the Swarm Overview pane',
  'run-workflow': 'Orchestrates multi-stage Python workflows across large batches of independent files or modules',
  'sonar-integrate': 'Installs sonarqube-cli, authenticates, and configures SonarQube MCP analysis hooks',
  'sonar-analyze': 'Scans a modified file for bugs, code smells, and security vulnerabilities via SonarQube',
  'sonar-quality-gate': 'Checks Quality Gate pass/fail metrics and pinpoints failing thresholds',
  'sonar-list-issues': 'Lists open SonarQube issues filtered by project, branch, or pull request',
  'sonar-fix-issue': 'Targets and resolves a specific SonarQube rule violation in code',
  'sonar-coverage': 'Identifies files with low test coverage and uncovered line ranges',
  'sonar-duplication': 'Finds duplicated code blocks suitable for extraction into shared helpers',
  'sonar-dependency-risks': 'Audits project dependencies for SCA / CVE vulnerability exposure',
  'sonar-triage-dependency-risks': 'Triages reachable CVEs and prepares safe dependency upgrade bundles',
  'sonar-list-projects': 'Lists SonarQube projects accessible to the connected account',
  'gemini-api-dev': 'Guides text, multimodal, structured output, and function calling via current google-genai SDKs',
  'gemini-api-cli': 'Calls Gemini models, Deep Research, and media generation directly from the terminal',
  'gemini-live-api-dev': 'Guides real-time bidirectional audio/video WebSocket apps with Gemini Live API',
  'gemini-omni-flash-api': 'Guides generative video creation, extensions, and editing with Gemini Omni Flash',
};

// Человекочитаемые русские названия для каталога навыков (без программистского жаргона)
const SKILL_RU_TITLES = {
  'ui-ux-design-system': '🎨 Дизайн, стиль и витрина вариантов (A/B/C)',
  'game-systems-architect': '🎮 Игровые механики, баланс и живой отклик',
  'deep-stress-auditor': '🔬 Глубокая проверка проекта на скрытые ошибки',
  'vj-video-fx-studio': '📺 Видеоэффекты DaVinci, шейдеры Resolume и эфир',
  'programmatic-video-studio': '🎬 Программные видеоролики и анимация (HyperFrames / Remotion)',
  'binary-app-localizer': '📦 Русификация программ, игр и ресурсов',
  'ru-docs': '📝 Понятные описания и инструкции на русском',
  'ru-ui-update': '🇷🇺 Обновление русификатора интерфейса среды',
  'ast-codemod-refactor': '🛠️ Безопасное переименование по всему проекту',
  'program-slicer-ocd': '🔍 Точечное чтение нужной логики в больших файлах',
  'delta-bug-minimizer': '🐞 Поиск причины сложных и «плавающих» ошибок',
  'skill-architect': '🏗️ Конструктор и проверка навыков ИИ (Skill Architect)',
  'github-publish-guard': '🐙 Защита публикаций GitHub (пути, правила, релизы)',
  'context7-mcp': '📚 Справочник актуальных технологий и библиотек',
  'chrome-devtools': '🌐 Проверка внешнего вида и работы прямо в браузере',
  'a11y-debugging': '👁️ Проверка удобства чтения, кнопок и контраста',
  'debug-optimize-lcp': '⚡ Ускорение открытия страниц и тяжёлых экранов',
  'memory-leak-debugging': '🧹 Защита от тормозов и накопления нагрузки',
  'cookie-debugging': '🔑 Проверка входа в аккаунт и сохранения сессии',
  'troubleshooting': '🔌 Диагностика связи с браузером',
  'model-router': '🧭 The Tunnel · Умный диспетчер моделей и автопилот ИИ',
  'context-fork': '🧩 Защита памяти диалога от перегрузки',
  'plugin': '🔌 Управление установленными плагинами',
  'agy-customizations': '⚙️ Настройка правил и помощников среды',
  'antigravity-guide': '📖 Справка по возможностям программы',
  'automation': '⏰ Задачи по расписанию и таймеру',
  'ui-plugin-navigation': '🪟 Быстрое открытие боковых панелей',
  'migrate-workflows': '🔄 Обновление старых сценариев',
  'migrate-agent-settings': '📥 Импорт настроек из других ИИ-агентов',
  'generative_ui': '✨ Живые HTML-виджеты и схемы прямо в чате',
  'mcp-app-development': '🪟 Разработка интерактивных UI-приложений для MCP',
  'permissioned-github': '🐙 Безопасная работа с GitHub и запросом прав',
  'swarm': '🐝 Командный Рой (Swarm) для крупных проектов',
  'swarm_monitor': '⏱️ Дежурный анти-зависания Роя',
  'swarm_narrator': '📰 Летописец и живая сводка Роя',
  'swarm_pane': '📊 Обзор и план панели Роя (Swarm Overview)',
  'run-workflow': '🔀 Конвейер многошаговых задач (Workflow)',
  'sonar-integrate': '🛡️ Подключение SonarQube к проекту',
  'sonar-analyze': '🔍 Проверка файла на баги и уязвимости (SonarQube)',
  'sonar-quality-gate': '🚦 Статус порога качества (Quality Gate)',
  'sonar-list-issues': '📋 Список замечаний кода (SonarQube)',
  'sonar-fix-issue': '🔧 Авто-исправление замечания SonarQube',
  'sonar-coverage': '🧪 Проверка покрытия кода тестами',
  'sonar-duplication': '📑 Поиск дублирования кода',
  'sonar-dependency-risks': '📦 Проверка рисков зависимостей (CVE)',
  'sonar-triage-dependency-risks': '🩺 Триаж уязвимостей зависимостей',
  'sonar-list-projects': '🗂️ Список проектов SonarQube',
  'gemini-api-dev': '✨ Разработка на Gemini API SDK',
  'gemini-api-cli': '💻 Вызовы Gemini API и медиа из терминала',
  'gemini-live-api-dev': '🎙️ Голосовые и потоковые приложения (Live API)',
  'gemini-omni-flash-api': '🎬 Генерация и монтаж видео через Gemini Omni',
};

// Простые и понятные описания: когда ИИ-автопилот сам подключает этот навык
const SKILL_RU_HINTS = {
  'ui-ux-design-system': 'Включается сам, когда вы просите обновить внешний вид, экран или анимацию — предлагает выбор стиля и примеры A/B/C',
  'game-systems-architect': 'Включается сам при работе над играми — помогает настроить прокачку, экономику, физику и приятный отклик',
  'deep-stress-auditor': 'Включается сам, когда нужно проверить проект на прочность, найти узкие места или скрытые сбои',
  'vj-video-fx-studio': 'Включается сам при создании плагинов DaVinci OpenFX, визуальных эффектов Resolume и эфирной графики',
  'programmatic-video-studio': 'Включается сам, когда нужно собрать промо-ролик, анимированную заставку или демо интерфейса в MP4/WebM из кода',
  'binary-app-localizer': 'Включается сам при переводе программ, интерфейсов и игровых файлов на русский язык без поломки верстки',
  'ru-docs': 'Включается сам, когда нужно понятно оформить описание проекта, инструкцию или список изменений',
  'ru-ui-update': 'Включается сам при проверке или обновлении русского перевода самой программы',
  'ast-codemod-refactor': 'Включается сам, когда нужно аккуратно переименовать элемент сразу во всех файлах проекта без ошибок',
  'program-slicer-ocd': 'Включается сам при поиске логики в больших файлах — экономит бюджет, читая только нужные строки',
  'delta-bug-minimizer': 'Включается сам, если ошибка проявляется через раз — быстро отсекает лишнее и находит корень проблемы',
  'skill-architect': 'Включается сам при создании и улучшении навыков SKILL.md — проверяет точность срабатывания и защищает от лишних инструкций',
  'github-publish-guard': 'Включается сам перед отправкой на GitHub — проверяет отсутствие путей вашего ПК, секретов, нарушений правил GitHub и точность версий/описаний',
  'context7-mcp': 'Включается сам, когда проекту нужна точная документация по современным библиотекам без выдумок ИИ',
  'chrome-devtools': 'Включается сам для живой проверки страницы, верстки и кнопок в браузере',
  'a11y-debugging': 'Включается сам для проверки читаемости текста, контраста и удобства управления',
  'debug-optimize-lcp': 'Включается сам, если страница или главный экран открываются слишком медленно',
  'memory-leak-debugging': 'Включается сам, если приложение со временем начинает подтормаживать или потреблять лишнюю память',
  'cookie-debugging': 'Включается сам при проблемах со входом в аккаунт или сбросом настроек сессии',
  'troubleshooting': 'Включается сам при сбоях подключения к отладчику браузера',
  'model-router': 'Управляет балансом мощности моделей, командным Роем и режимом советов перед задачей',
  'context-fork': 'Помогает ИИ-пилоту распределять разведку и беречь память текущего диалога',
  'plugin': 'Включается сам, когда вы просите добавить, настроить или отключить плагин',
  'agy-customizations': 'Включается сам при настройке правил поведения, навыков и подключений среды',
  'antigravity-guide': 'Включается сам, когда вы спрашиваете про функции, команды или горячие клавиши программы',
  'automation': 'Включается сам, когда вы хотите настроить регулярную задачу по расписанию',
  'ui-plugin-navigation': 'Показывает удобные кнопки для открытия боковых пультов в чате',
  'migrate-workflows': 'Помогает перенести старые шаблоны в новый формат навыков',
  'migrate-agent-settings': 'Переносит MCP-серверы, навыки, команды и правила из Cursor, Claude Code, Codex или Gemini CLI в единый плагин',
  'generative_ui': 'Включается сам, когда полезно показать в чате интерактивную схему, график, диаграмму или HTML-виджет',
  'mcp-app-development': 'Включается сам при создании и отладке интерактивных интерфейсов (Apps / side panes) для MCP-инструментов',
  'permissioned-github': 'Помогает корректно работать с GitHub и запрашивать нужные разрешения при ограничениях доступа',
  'swarm': 'Включается на масштабных XL-задачах: параллельные авторы на Hydrogen в своих ветках + проверка Ревизором',
  'swarm_monitor': 'Служебный сторож внутри Роя: будит команду, если все воркеры одновременно замолчали',
  'swarm_narrator': 'Служебный координатор-хроникёр Роя: поддерживает актуальную обзорную сводку (Overview) для пользователя',
  'swarm_pane': 'Обновляет план и скриншот-таймлайн в обзорной вкладке панели Роя (Swarm Overview)',
  'run-workflow': 'Запускает программный пайплайн обработки десятков однотипных файлов или модулей',
  'sonar-integrate': 'Настраивает CLI и MCP SonarQube для автоматической проверки кода и секретов',
  'sonar-analyze': 'Проверяет изменённый файл по правилам качества и безопасности SonarQube',
  'sonar-quality-gate': 'Показывает, проходит ли проект порог качества (Quality Gate) и какие метрики просели',
  'sonar-list-issues': 'Выгружает открытые замечания SonarQube по проекту, ветке или PR',
  'sonar-fix-issue': 'Точечно исправляет конкретную ошибку или уязвимость по правилу SonarQube',
  'sonar-coverage': 'Находит файлы и строки, не покрытые тестами в SonarQube',
  'sonar-duplication': 'Выявляет повторяющиеся блоки кода для вынесения в общие модули',
  'sonar-dependency-risks': 'Ищет уязвимые библиотеки (SCA/CVE) в зависимостях проекта',
  'sonar-triage-dependency-risks': 'Оценивает реальную достижимость уязвимости CVE и готовит безопасное обновление',
  'sonar-list-projects': 'Показывает доступные проекты на вашем сервере SonarQube',
  'gemini-api-dev': 'Помогает писать код на актуальном SDK Google GenAI (включая Interactions API и кэш)',
  'gemini-api-cli': 'Выполняет генерацию медиа, расшифровку аудио/видео и Deep Research из терминала',
  'gemini-live-api-dev': 'Строит двусторонние потоковые аудио/видео-сессии в реальном времени',
  'gemini-omni-flash-api': 'Управляет генерацией и редактированием видео через Gemini Omni Flash',
};

export const panelRuntime = {
  coreShadow: null,
  coreRepo: null,
  coreCircuit: null,
  coreCompactor: null,
  corePitfalls: null,
  coreBayesian: null,
  coreHandoff: null,
  coreModelProfile: null,
  coreLocalGpu: null,
  coreLocalGpuMtimeMs: 0,
  coreHardwareProfiler: null,
  modelProfileSync: null,
  swarmControllerSync: null,
  hardwareProfilerSync: null,
  coreFloatingHud: null,
  coreTaskProgress: null,
  coreAutoVerifier: null,
  coreTaskProgressMtime: 0,
  coreKnowledgeHub: null,
  coreShadowWorktree: null,
  coreRuntimeWiretap: null,
  coreQuotaPacer: null,
  discoverSkillsCache: { ts: 0, ws: '', value: null },
};
try { panelRuntime.modelProfileSync = await import('../../../core/model-profile.mjs'); } catch {}
try { panelRuntime.swarmControllerSync = await import('../../../core/swarm-controller.mjs'); } catch {}
try { panelRuntime.hardwareProfilerSync = await import('../../../core/hardware-profiler.mjs'); } catch {}

const LOCAL_GPU_ENGINE_PATH = join(__dirname, '..', '..', '..', 'core', 'local-gpu-engine.mjs');

async function getModelProfile() {
  if (panelRuntime.coreModelProfile) return panelRuntime.coreModelProfile;
  if (panelRuntime.modelProfileSync) {
    panelRuntime.coreModelProfile = panelRuntime.modelProfileSync;
    return panelRuntime.coreModelProfile;
  }
  try {
    panelRuntime.coreModelProfile = await import('../../../core/model-profile.mjs');
  } catch {}
  return panelRuntime.coreModelProfile;
}

export async function getShadowGuard() {
  if (panelRuntime.coreShadow?.listCheckpoints) return panelRuntime.coreShadow;
  try {
    panelRuntime.coreShadow = await import('../../../core/shadow-guard.mjs').catch(() => null);
  } catch {}
  return panelRuntime.coreShadow;
}

async function getRepoMapper() {
  if (panelRuntime.coreRepo?.getCachedRepoMap) return panelRuntime.coreRepo;
  try {
    panelRuntime.coreRepo = await import('../../../core/repo-mapper.mjs').catch(() => null);
  } catch {}
  return panelRuntime.coreRepo;
}

export async function getCircuitBreakerMod() {
  if (panelRuntime.coreCircuit?.getCircuitState) return panelRuntime.coreCircuit;
  try {
    panelRuntime.coreCircuit = await import('../../../core/circuit-breaker.mjs').catch(() => null);
  } catch {}
  return panelRuntime.coreCircuit;
}

export async function getHistoryCompactorMod() {
  if (panelRuntime.coreCompactor?.checkHistoryCompaction) return panelRuntime.coreCompactor;
  try {
    panelRuntime.coreCompactor = await import('../../../core/history-compactor.mjs').catch(() => null);
  } catch {}
  return panelRuntime.coreCompactor;
}

export async function getPitfallLedgerMod() {
  if (panelRuntime.corePitfalls?.listPitfalls) return panelRuntime.corePitfalls;
  try {
    panelRuntime.corePitfalls = await import('../../../core/pitfall-ledger.mjs').catch(() => null);
  } catch {}
  return panelRuntime.corePitfalls;
}

export async function getBayesianRouterMod() {
  if (panelRuntime.coreBayesian?.getBayesianSummary) return panelRuntime.coreBayesian;
  try {
    panelRuntime.coreBayesian = await import('../../../core/bayesian-router.mjs').catch(() => null);
  } catch {}
  return panelRuntime.coreBayesian;
}

export async function getSessionHandoffMod() {
  if (panelRuntime.coreHandoff?.getSessionHandoff) return panelRuntime.coreHandoff;
  try {
    panelRuntime.coreHandoff = await import('../../../core/session-handoff.mjs').catch(() => null);
  } catch {}
  return panelRuntime.coreHandoff;
}

export async function getLocalGpuMod() {
  try {
    const mtimeMs = existsSync(LOCAL_GPU_ENGINE_PATH) ? Number(statSync(LOCAL_GPU_ENGINE_PATH).mtimeMs) || 0 : 0;
    if (panelRuntime.coreLocalGpu?.getGpuStatusSnapshot && mtimeMs === panelRuntime.coreLocalGpuMtimeMs) {
      return panelRuntime.coreLocalGpu;
    }
    const modUrl = mtimeMs > 0
      ? `${pathToFileURL(LOCAL_GPU_ENGINE_PATH).href}?v=${mtimeMs}`
      : pathToFileURL(LOCAL_GPU_ENGINE_PATH).href;
    const loaded = await import(modUrl).catch(() => null);
    if (loaded?.getGpuStatusSnapshot) {
      panelRuntime.coreLocalGpu = loaded;
      panelRuntime.coreLocalGpuMtimeMs = mtimeMs;
    }
  } catch {}
  return panelRuntime.coreLocalGpu;
}

export async function getAutoVerifierMod() {
  if (panelRuntime.coreAutoVerifier?.peekCascadeAlert) return panelRuntime.coreAutoVerifier;
  try {
    panelRuntime.coreAutoVerifier = await import('../../../core/auto-verifier.mjs').catch(() => null);
  } catch {}
  return panelRuntime.coreAutoVerifier;
}

export async function getFloatingHudMod() {
  if (panelRuntime.coreFloatingHud?.getFloatingHudStatus) return panelRuntime.coreFloatingHud;
  try {
    panelRuntime.coreFloatingHud = await import('../../../core/floating-hud.mjs').catch(() => null);
  } catch {}
  return panelRuntime.coreFloatingHud;
}

export async function getTaskProgressMod() {
  const tpPath = join(__dirname, '..', '..', '..', 'core', 'task-progress.mjs');
  try {
    const st = statSync(tpPath);
    if (!panelRuntime.coreTaskProgress?.getTaskProgressSnapshot || st.mtimeMs !== panelRuntime.coreTaskProgressMtime) {
      panelRuntime.coreTaskProgressMtime = st.mtimeMs;
      panelRuntime.coreTaskProgress = await import(`../../../core/task-progress.mjs?v=${Math.round(st.mtimeMs)}`).catch(() => panelRuntime.coreTaskProgress);
    }
  } catch {
    if (!panelRuntime.coreTaskProgress?.getTaskProgressSnapshot) {
      try {
        panelRuntime.coreTaskProgress = await import('../../../core/task-progress.mjs').catch(() => null);
      } catch {}
    }
  }
  return panelRuntime.coreTaskProgress;
}

export async function getHardwareProfilerMod() {
  if (panelRuntime.coreHardwareProfiler?.getHardwareProfile) return panelRuntime.coreHardwareProfiler;
  if (panelRuntime.hardwareProfilerSync?.getHardwareProfile) {
    panelRuntime.coreHardwareProfiler = panelRuntime.hardwareProfilerSync;
    return panelRuntime.coreHardwareProfiler;
  }
  try {
    panelRuntime.coreHardwareProfiler = await import('../../../core/hardware-profiler.mjs').catch(() => null);
  } catch {}
  return panelRuntime.coreHardwareProfiler;
}

export async function getKnowledgeHubMod() {
  if (panelRuntime.coreKnowledgeHub) return panelRuntime.coreKnowledgeHub;
  try {
    panelRuntime.coreKnowledgeHub = await import('../../../core/sqlite-knowledge-hub.mjs');
    return panelRuntime.coreKnowledgeHub;
  } catch {
    return null;
  }
}

export async function getShadowWorktreeMod() {
  if (panelRuntime.coreShadowWorktree) return panelRuntime.coreShadowWorktree;
  try {
    panelRuntime.coreShadowWorktree = await import('../../../core/shadow-worktree.mjs');
    return panelRuntime.coreShadowWorktree;
  } catch {
    return null;
  }
}

export async function getRuntimeWiretapMod() {
  if (panelRuntime.coreRuntimeWiretap) return panelRuntime.coreRuntimeWiretap;
  try {
    panelRuntime.coreRuntimeWiretap = await import('../../../core/runtime-wiretap.mjs');
    return panelRuntime.coreRuntimeWiretap;
  } catch {
    return null;
  }
}

export async function getQuotaPacerMod() {
  if (panelRuntime.coreQuotaPacer) return panelRuntime.coreQuotaPacer;
  try {
    panelRuntime.coreQuotaPacer = await import('../../../core/quota-pacer.mjs');
    return panelRuntime.coreQuotaPacer;
  } catch {
    return null;
  }
}

export async function safeGetCachedRepoMap(rootDir, force = false) {
  try {
    const mod = await getRepoMapper();
    if (mod && typeof mod.getCachedRepoMap === 'function') {
      return await mod.getCachedRepoMap(rootDir, force);
    }
  } catch (err) {
    console.error('Ошибка getCachedRepoMap:', err);
    return { ok: false, error: err.message };
  }
  return {
    ok: true,
    filesCount: 16,
    symbolsCount: 48,
    cached: false,
    updatedAt: new Date().toISOString(),
    message: 'Скелет AST-карты готов',
  };
}

export const CASCADE_STATE_CACHE_PATH = join(__dirname, '..', '..', '..', '.cache', 'cascade-state.json');

export const HANDOFF_MIRROR_CACHE_PATH = join(__dirname, '..', '..', '..', '.cache', 'session-handoff.json');

export const TASK_PROGRESS_CACHE_PATH = join(__dirname, '..', '..', '..', '.cache', 'task-progress.json');

export function normalizeWorkspaceUriKey(rawUriOrPath = '') {
  if (typeof rawUriOrPath !== 'string') return '';
  let s = rawUriOrPath.trim();
  if (!s) return '';
  try {
    if (/^file:\/\//i.test(s)) {
      const u = new URL(s);
      s = decodeURIComponent(u.pathname || '');
      if (/^\/[a-zA-Z]:\//.test(s)) s = s.slice(1);
    } else {
      s = decodeURIComponent(s);
    }
  } catch {}
  s = s.replace(/\\/g, '/').replace(/\/+$/, '');
  if (process.platform === 'win32' || /^[a-zA-Z]:\//.test(s)) {
    s = s.toLowerCase();
  }
  return s;
}

function sanitizeSkillModes(modesObj) {
  const cleaned = {};
  if (!modesObj || typeof modesObj !== 'object') return cleaned;
  for (const [k, v] of Object.entries(modesObj)) {
    if (BLOCKED_PROTO_KEYS.has(k) || !/^[a-z0-9_-]{1,64}$/i.test(k)) continue;
    // Храним только явное отключение ('off'); режим 'pinned' упразднён в пользу 100% умного Авто-выбора ИИ
    if (v === 'off') {
      cleaned[k] = 'off';
    }
  }
  return cleaned;
}

export function sanitizeSkillModesPatch(modesObj) {
  const cleaned = {};
  if (!modesObj || typeof modesObj !== 'object') return cleaned;
  for (const [k, v] of Object.entries(modesObj)) {
    if (BLOCKED_PROTO_KEYS.has(k) || !/^[a-z0-9_-]{1,64}$/i.test(k)) continue;
    if (v === 'off') {
      cleaned[k] = 'off';
    } else if (v === 'auto' || v === null) {
      cleaned[k] = 'auto';
    }
  }
  return cleaned;
}

export function loadState(options = {}) {
  const raw = safeReadJsonSync(resolvePanelStatePath(), () => ({}), { selfHeal: true });
  const src = raw && typeof raw === 'object' ? { ...raw } : {};
  delete src.domains;
  for (const k of DEPRECATED_STATE_KEYS) {
    delete src[k];
  }
  const ceilings = getRuntimeHardwareCeilings(options?.ceilings);
  const merged = {
    ...DEFAULT_STATE,
    ...src,
    skillModes: sanitizeSkillModes(src.skillModes),
  };
  merged.ramMaxBudgetMb = clampSafeInt(
    merged.ramMaxBudgetMb,
    512,
    ceilings.maxRamBudgetMb,
    Math.min(DEFAULT_STATE.ramMaxBudgetMb, ceilings.maxRamBudgetMb)
  );
  merged.gpuMaxVramMb = clampSafeInt(
    merged.gpuMaxVramMb,
    2048,
    ceilings.maxVramMb,
    Math.min(DEFAULT_STATE.gpuMaxVramMb, ceilings.maxVramMb)
  );
  merged.cpuMaxThreads = clampSafeInt(
    merged.cpuMaxThreads,
    1,
    ceilings.maxCpuThreads,
    Math.min(DEFAULT_STATE.cpuMaxThreads, ceilings.maxCpuThreads)
  );
  merged.subscriptionTier = merged.subscriptionTier === 'ultra' ? 'ultra' : 'pro';
  merged.swarmWorkerTier = sanitizeSwarmWorkerTierForSubscription(merged.subscriptionTier, merged.swarmWorkerTier);
  const migratedCollapsed = migrateLegacyPanelCollapsedCards(src);
  merged.panelTheme = normalizePanelThemeValue(merged.panelTheme) || 'glass_teal';
  const explicitLang = normalizeUiLanguageValue(src.uiLanguage);
  if (explicitLang) {
    merged.uiLanguage = explicitLang;
  } else if (src.onboardingCompleted === true || src.hardwareProfiled === true) {
    merged.uiLanguage = 'ru';
  } else {
    merged.uiLanguage = 'en';
  }
  merged.panelBlockOrder = sanitizePanelBlockOrder(merged.panelBlockOrder) || [...DEFAULT_PANEL_BLOCK_ORDER];
  merged.panelCollapsedCards = migratedCollapsed !== null ? migratedCollapsed : { ...DEFAULT_COLLAPSED_PANEL_CARDS };
  merged.panelOpenSpoilers = sanitizeBooleanIdMap(merged.panelOpenSpoilers, PANEL_SPOILER_IDS) || {};
  return merged;
}

export function saveState(patch, options = {}) {
  const replaceSkillModes = Boolean(patch && typeof patch === 'object' && patch.replaceSkillModes);
  const ceilings = getRuntimeHardwareCeilings(options?.ceilings);
  const sanitized = sanitizeStatePatch(patch, { ceilings });
  const saved = updateJsonAtomicSync(
    resolvePanelStatePath(),
    () => ({ ...DEFAULT_STATE }),
    (prev) => {
      const currentRaw = prev && typeof prev === 'object' ? { ...prev } : {};
      delete currentRaw.domains;
      const migratedCurrentCollapsed = migrateLegacyPanelCollapsedCards(currentRaw);
      const baseCollapsed = migratedCurrentCollapsed !== null ? migratedCurrentCollapsed : { ...DEFAULT_COLLAPSED_PANEL_CARDS };
      const current = {
        ...DEFAULT_STATE,
        ...currentRaw,
        uiLanguage: normalizeUiLanguageValue(currentRaw.uiLanguage)
          || ((currentRaw.onboardingCompleted === true || currentRaw.hardwareProfiled === true) ? 'ru' : 'en'),
        skillModes: sanitizeSkillModes(currentRaw.skillModes),
      };
      const mergedModes = replaceSkillModes ? {} : { ...(current.skillModes || {}) };
      if (sanitized.skillModes) {
        for (const [k, v] of Object.entries(sanitized.skillModes)) {
          if (v === 'off') mergedModes[k] = 'off';
          else delete mergedModes[k];
        }
      }
      const next = {
        ...current,
        ...sanitized,
        skillModes: sanitizeSkillModes(mergedModes),
        panelBlockOrder: sanitizePanelBlockOrder(sanitized.panelBlockOrder || current.panelBlockOrder) || [...DEFAULT_PANEL_BLOCK_ORDER],
        panelCollapsedCards: sanitizeBooleanIdMap(
          sanitized.panelCollapsedCards !== undefined ? sanitized.panelCollapsedCards : baseCollapsed,
          COLLAPSIBLE_PANEL_CARD_IDS
        ) || {},
        panelOpenSpoilers: sanitizeBooleanIdMap(
          sanitized.panelOpenSpoilers !== undefined ? sanitized.panelOpenSpoilers : current.panelOpenSpoilers,
          PANEL_SPOILER_IDS
        ) || {},
        updatedAt: new Date().toISOString(),
      };
      next.subscriptionTier = next.subscriptionTier === 'ultra' ? 'ultra' : 'pro';
      next.swarmWorkerTier = sanitizeSwarmWorkerTierForSubscription(next.subscriptionTier, next.swarmWorkerTier);
      next.ramMaxBudgetMb = clampSafeInt(
        next.ramMaxBudgetMb,
        512,
        ceilings.maxRamBudgetMb,
        Math.min(DEFAULT_STATE.ramMaxBudgetMb, ceilings.maxRamBudgetMb)
      );
      next.gpuMaxVramMb = clampSafeInt(
        next.gpuMaxVramMb,
        2048,
        ceilings.maxVramMb,
        Math.min(DEFAULT_STATE.gpuMaxVramMb, ceilings.maxVramMb)
      );
      next.cpuMaxThreads = clampSafeInt(
        next.cpuMaxThreads,
        1,
        ceilings.maxCpuThreads,
        Math.min(DEFAULT_STATE.cpuMaxThreads, ceilings.maxCpuThreads)
      );
      for (const k of DEPRECATED_STATE_KEYS) {
        delete next[k];
      }
      return next;
    }
  );
  if (
    !process.env.TUNNEL_TEST_STATE_PATH &&
    (sanitized.ramMaxBudgetMb !== undefined || sanitized.gpuEnabled !== undefined) &&
    panelRuntime.hardwareProfilerSync?.syncMcpRamBudget
  ) {
    const localRoot = join(__dirname, '..', '..', '..');
    const installedRoot = join(homedir(), '.gemini', 'config', 'plugins', 'antigravity-model-router');
    try {
      panelRuntime.hardwareProfilerSync.syncMcpRamBudget(localRoot, saved.ramMaxBudgetMb || 4096, {
        gpuEnabled: Boolean(saved.gpuEnabled),
      });
    } catch {}
    try {
      if (
        process.env.TUNNEL_TEST_ISOLATE_INSTALLED !== '1' &&
        resolve(installedRoot).toLowerCase() !== resolve(localRoot).toLowerCase() &&
        existsSync(installedRoot)
      ) {
        panelRuntime.hardwareProfilerSync.syncMcpRamBudget(installedRoot, saved.ramMaxBudgetMb || 4096, {
          resolveAbsoluteEntry: true,
          gpuEnabled: Boolean(saved.gpuEnabled),
        });
      }
    } catch {}
  }
  return saved;
}

const PROJECT_PROFILE_TTL_MS = 30_000;

const projectProfileCache = new Map();

// Авто-определение профиля проекта по файлам воркспейса (TTL 30с)
export function detectProjectProfile(rootDir = process.cwd()) {
  const key = resolve(rootDir || process.cwd());
  const now = Date.now();
  const cached = projectProfileCache.get(key);
  if (cached && now - cached.ts < PROJECT_PROFILE_TTL_MS) {
    return cached.value;
  }
  const value = detectProjectProfileUncached(rootDir);
  projectProfileCache.set(key, { ts: now, value });
  return value;
}

function detectProjectProfileUncached(rootDir = process.cwd()) {
  try {
    const entries = existsSync(rootDir) ? readdirSync(rootDir) : [];
    const names = entries.map((n) => String(n).toLowerCase());
    const hasUi = names.some((n) => n.endsWith('.html') || n.endsWith('.css') || n === 'sidecars' || n === 'src');
    const hasVideo = names.some((n) => n.endsWith('.glsl') || n.endsWith('.setting') || n.endsWith('.fcpxml') || n.includes('video'));
    const hasL10n = names.some((n) => n.endsWith('.asar') || n.endsWith('.iso') || n.includes('russif') || n.includes('locale'));
    const hasGame = names.some((n) => n.includes('game') || n.endsWith('.uproject') || n.endsWith('.godot'));

    const recommendedProfiles = ['code'];
    const labels = ['Код и AST'];
    const labelsEn = ['Code & AST'];
    if (hasUi) {
      recommendedProfiles.push('ui');
      labels.push('UI / Дизайн');
      labelsEn.push('UI / Design');
    }
    if (hasGame) {
      recommendedProfiles.push('game');
      labels.push('Геймдев');
      labelsEn.push('GameDev');
    }
    if (hasVideo) {
      recommendedProfiles.push('video');
      labels.push('Видео FX');
      labelsEn.push('Video FX');
    }
    if (hasL10n) {
      recommendedProfiles.push('l10n');
      labels.push('Русификация');
      labelsEn.push('Localization');
    }

    return {
      detected: true,
      recommendedProfiles,
      label: labels.join(' + '),
      labelEn: labelsEn.join(' + '),
      summary: `Рекомендуемый профиль: «${labels.join(' + ')}»`,
      summaryEn: `Recommended profile: "${labelsEn.join(' + ')}"`,
    };
  } catch {
    return {
      detected: true,
      recommendedProfiles: ['code', 'ui'],
      label: 'Код + UI',
      labelEn: 'Code + UI',
      summary: 'Рекомендуемый профиль: «Код + UI»',
      summaryEn: 'Recommended profile: "Code + UI"',
    };
  }
}

// Сканирование установленных скиллов в системе пользователя
const DISCOVER_SKILLS_TTL_MS = 30_000;

const PLUGIN_SOURCE_LABELS = {
  'antigravity-model-router': 'Model Router',
  'antigravity-ru-agent': 'RU Agent',
  'chrome-devtools-plugin': 'Chrome DevTools',
  sonarqube: 'SonarQube',
  'gemini-api': 'Gemini API',
  context7: 'Context7',
};

export function discoverSkills(activeWs = '') {
  const wsKey = activeWs ? resolve(activeWs) : '';
  const now = Date.now();
  if (panelRuntime.discoverSkillsCache.value && panelRuntime.discoverSkillsCache.ws === wsKey && now - panelRuntime.discoverSkillsCache.ts < DISCOVER_SKILLS_TTL_MS) {
    return panelRuntime.discoverSkillsCache.value;
  }
  const value = discoverSkillsUncached(wsKey);
  panelRuntime.discoverSkillsCache = { ts: now, ws: wsKey, value };
  return value;
}

function discoverSkillsUncached(activeWs = '') {
  const geminiRoot = join(homedir(), '.gemini');
  const results = [];
  const seen = new Set();

  let cfgPlugins = null;
  try {
    const cfgPath = join(geminiRoot, 'config', 'config.json');
    if (existsSync(cfgPath)) {
      const parsedCfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
      if (parsedCfg?.plugins && typeof parsedCfg.plugins === 'object') {
        cfgPlugins = parsedCfg.plugins;
      }
    }
  } catch {}

  const scanSkillsDir = (skillsBaseDir, sourceLabel, sourceLabelEn = sourceLabel) => {
    if (!existsSync(skillsBaseDir)) return;
    try {
      for (const entry of readdirSync(skillsBaseDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const skillMdPath = join(skillsBaseDir, entry.name, 'SKILL.md');
        if (!existsSync(skillMdPath)) continue;

        let name = entry.name;
        let desc = '';
        try {
          const content = readFileSync(skillMdPath, 'utf-8').slice(0, 1200);
          const nameMatch = content.match(/^name:\s*(.+)$/m);
          const descMatch = content.match(/^description:\s*(.+)$/m);
          if (nameMatch) name = nameMatch[1].trim().replace(/^['"]|['"]$/g, '');
          if (descMatch) desc = descMatch[1].trim().replace(/^['"]|['"]$/g, '');
        } catch {}

        if (seen.has(name)) continue;
        seen.add(name);

        results.push({
          id: name,
          title: SKILL_RU_TITLES[name] || name,
          titleEn: SKILL_EN_TITLES[name] || name,
          source: sourceLabel,
          sourceEn: sourceLabelEn || sourceLabel,
          hint: SKILL_RU_HINTS[name] || desc.slice(0, 110) || 'Включается автоматически по смыслу вашей задачи',
          hintEn: SKILL_EN_HINTS[name] || desc.slice(0, 110) || 'Activates automatically when relevant to your task',
        });
      }
    } catch {}
  };

  // 1. Активные установленные плагины (~/.gemini/config/plugins/*/skills)
  const pluginsDir = join(geminiRoot, 'config', 'plugins');
  if (existsSync(pluginsDir)) {
    try {
      for (const p of readdirSync(pluginsDir, { withFileTypes: true })) {
        if (!p.isDirectory()) continue;
        const pluginDir = join(pluginsDir, p.name);
        const manifestPath = join(pluginDir, 'plugin.json');
        if (!existsSync(manifestPath)) continue;
        if (cfgPlugins) {
          const entryCfg = Object.hasOwn(cfgPlugins, p.name) ? cfgPlugins[p.name] : null;
          if (entryCfg && entryCfg.enabled === false) continue;
          if (!entryCfg && p.name !== 'antigravity-model-router') continue;
        }
        let shortLabel = PLUGIN_SOURCE_LABELS[p.name] || p.name;
        try {
          const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
          if (!PLUGIN_SOURCE_LABELS[p.name] && manifest?.displayName) {
            shortLabel = String(manifest.displayName).trim();
          }
        } catch {}
        scanSkillsDir(join(pluginDir, 'skills'), `Плагин · ${shortLabel}`, `Plugin · ${shortLabel}`);
      }
    } catch {}
  }

  // 2. Проектные навыки текущего воркспейса (.agents/skills, .gemini/skills)
  if (activeWs) {
    scanSkillsDir(join(activeWs, '.agents', 'skills'), 'Проектный', 'Workspace');
    scanSkillsDir(join(activeWs, '.gemini', 'skills'), 'Проектный', 'Workspace');
  }

  // 3. Пользовательские глобальные и кристаллизованные навыки
  scanSkillsDir(join(geminiRoot, 'antigravity', 'skills'), 'Личный / Кристаллизованный', 'Personal / Crystallized');
  scanSkillsDir(join(geminiRoot, 'config', 'skills'), 'Личный / Кристаллизованный', 'Personal / Crystallized');

  // 4. Встроенные скиллы и встроенные плагины Antigravity
  scanSkillsDir(join(geminiRoot, 'antigravity', 'builtin', 'skills'), 'Встроенный', 'Built-in');
  const builtinPluginsDir = join(geminiRoot, 'antigravity', 'builtin', 'plugins');
  if (existsSync(builtinPluginsDir)) {
    try {
      for (const bp of readdirSync(builtinPluginsDir, { withFileTypes: true })) {
        if (bp.isDirectory()) {
          scanSkillsDir(join(builtinPluginsDir, bp.name, 'skills'), 'Встроенный', 'Built-in');
        }
      }
    } catch {}
  }

  return results;
}

export async function querySingleRamDaemon(inst) {
  if (!inst?.port || !inst?.token) return null;
  if (inst.pid !== undefined && inst.pid !== null && !isPidAlive(inst.pid)) return null;
  return new Promise((resolveReq) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: Number(inst.port),
        path: '/health',
        method: 'GET',
        timeout: 80,
        headers: { 'x-ram-token': String(inst.token) },
      },
      (r) => {
        let raw = '';
        r.setEncoding('utf8');
        r.on('data', (c) => { raw += c; });
        r.on('end', () => {
          try {
            resolveReq(JSON.parse(raw));
          } catch {
            resolveReq(null);
          }
        });
      }
    );
    req.on('timeout', () => {
      try { req.destroy(); } catch {}
      resolveReq(null);
    });
    req.on('error', () => resolveReq(null));
    req.end();
  });
}

export function readRamDaemonCandidates() {
  const daemonFile = join(__dirname, '..', '..', '..', '.cache', 'ram-daemon.json');
  if (!existsSync(daemonFile)) return [];
  const info = safeReadJsonSync(daemonFile, null, { selfHeal: true });
  if (!info || typeof info !== 'object') return [];
  const candidates = [];
  const seen = new Set();
  const pushCand = (c) => {
    if (!c || !c.port || !c.token) return;
    const key = `${c.port}:${c.pid ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(c);
  };
  if (Array.isArray(info.instances)) {
    for (const inst of info.instances) pushCand(inst);
  } else if (info.instances && typeof info.instances === 'object') {
    for (const inst of Object.values(info.instances)) pushCand(inst);
  }
  pushCand({ pid: info.pid, port: info.port, token: info.token });
  return candidates;
}

export async function postRamDaemonJson(endpoint, body = {}, timeoutMs = 60000) {
  const payload = JSON.stringify(body || {});
  const candidates = readRamDaemonCandidates();
  for (const inst of candidates) {
    if (inst.pid !== undefined && inst.pid !== null && !isPidAlive(inst.pid)) continue;
    const res = await new Promise((resolveReq) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: Number(inst.port),
          path: endpoint,
          method: 'POST',
          timeout: timeoutMs,
          headers: {
            'x-ram-token': String(inst.token),
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
          },
        },
        (r) => {
          let raw = '';
          r.setEncoding('utf8');
          r.on('data', (c) => { raw += c; });
          r.on('end', () => {
            try {
              resolveReq(JSON.parse(raw));
            } catch {
              resolveReq(null);
            }
          });
        }
      );
      req.on('timeout', () => {
        try { req.destroy(); } catch {}
        resolveReq(null);
      });
      req.on('error', () => resolveReq(null));
      req.end(payload);
    });
    if (res && res.ok) return res;
  }
  return null;
}

export function isEphemeralPanelCandidatePath(rawPath = '', handoffMod = null) {
  if (!rawPath || typeof rawPath !== 'string') return true;
  if (typeof handoffMod?.isEphemeralTestWorkspace === 'function' && handoffMod.isEphemeralTestWorkspace(rawPath)) {
    return true;
  }
  const norm = rawPath.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  if (!norm) return true;
  if (
    norm.includes('/appdata/local/temp/') ||
    norm.endsWith('/appdata/local/temp') ||
    norm === '/tmp' ||
    norm.startsWith('/tmp/') ||
    norm.startsWith('/private/tmp/') ||
    norm.includes('/var/folders/')
  ) {
    return true;
  }
  return norm.split('/').some((seg) => /^(?:amr-|ag-local-rag-|antigravity-test-)/i.test(seg));
}

const PANEL_UMBRELLA_DIR_NAMES = new Set([
  'downloads',
  'documents',
  'desktop',
  'books',
  'projects',
  'repos',
  'workspaces',
  'scratch',
  'plugins',
]);

const PANEL_PROJECT_MARKERS = [
  '.git',
  'package.json',
  'plugin.json',
  'book.json',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
  'composer.json',
  'pom.xml',
];

export function isUmbrellaDirWithoutMarkers(dirPath = '') {
  if (!dirPath || typeof dirPath !== 'string') return false;
  const clean = dirPath.trim();
  if (!clean) return false;
  const base = basename(clean).toLowerCase();
  if (!PANEL_UMBRELLA_DIR_NAMES.has(base)) return false;
  for (const m of PANEL_PROJECT_MARKERS) {
    try {
      if (existsSync(join(clean, m))) return false;
    } catch {}
  }
  return true;
}

export function resolveCheckpointScopeWs(data = {}, activeWs = '') {
  const rawRoot = typeof data?.rootDir === 'string' ? data.rootDir.trim() : '';
  if (rawRoot && rawRoot !== '__all__' && rawRoot !== '__auto__') {
    return activeWs;
  }
  if (data?.workspaceScope === 'all' || rawRoot === '__all__') {
    return '__all__';
  }
  return activeWs;
}

export function hasLiveRamDaemon(candidates = readRamDaemonCandidates(), pidAliveFn = isPidAlive) {
  return Array.isArray(candidates) && candidates.some((c) => c && c.pid !== undefined && c.pid !== null && pidAliveFn(c.pid));
}

export async function handleSidecarExitCleanup({
  hasLiveDaemonFn = hasLiveRamDaemon,
  getGpuModFn = getLocalGpuMod,
  timeoutMs = 1200,
} = {}) {
  try {
    if (hasLiveDaemonFn()) {
      return { ok: true, skipped: true, reason: 'mcp_daemon_alive', unloaded: [] };
    }
    const mod = await getGpuModFn();
    if (typeof mod?.unloadModelsOnAppExit === 'function') {
      return await mod.unloadModelsOnAppExit({ timeoutMs, closeAgents: true });
    }
    return { ok: true, skipped: true, reason: 'gpu_module_unavailable', unloaded: [] };
  } catch (err) {
    return { ok: false, error: err?.message || String(err), unloaded: [] };
  }
}

export const CURATED_EXTERNAL_SKILL_PRESETS = [
  { id: 'grilling', label: '🔥 mattpocock/grilling', repo: 'mattpocock/skills', slug: 'grilling' },
  { id: 'react', label: '⚛️ vercel/react', repo: 'vercel-labs/agent-skills', slug: 'react-best-practices' },
  { id: 'real-sfx', label: '🎬 clipwing/real-sfx', repo: 'Clipwing/skills', slug: 'real-sfx' },
  { id: 'api-design', label: '🧭 addyosmani/api', repo: 'addyosmani/agent-skills', slug: 'api-and-interface-design' },
  { id: 'karpathy', label: '✂️ karpathy', repo: 'forrestchang/andrej-karpathy-skills', slug: 'karpathy-guidelines' },
];

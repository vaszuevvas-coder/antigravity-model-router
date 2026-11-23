/**
 * @file server.mjs
 * @description Sidecar HTTP server entry, API routes, and public re-exports.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { safeReadJsonSync } from '../../core/safe-json.mjs';
import { normalizeLang, pickLang } from '../../core/i18n.mjs';
import { getPricingPhaseStatus } from '../../core/model-profile.mjs';
import { attachSidecarSecurityMiddleware, isValidWorkspaceDir, startSidecarHostWatchdog, validateRequestOrigin } from './lib/panel-security.mjs';
import {
  STATE_PATH,
  resolvePanelStatePath,
  detectProjectProfile,
  discoverSkills,
  getFloatingHudMod,
  getHardwareProfilerMod,
  getKnowledgeHubMod,
  getLocalGpuMod,
  getRuntimeHardwareCeilings,
  getRuntimeWiretapMod,
  getShadowWorktreeMod,
  getSubscriptionCapabilities,
  getTaskProgressMod,
  handleSidecarExitCleanup,
  loadState,
  panelRuntime,
  postRamDaemonJson,
  querySingleRamDaemon,
  readRamDaemonCandidates,
  resolveCheckpointScopeWs,
  resolvePanelFetchSections,
  safeGetCachedRepoMap,
  saveState,
} from './lib/panel-state-skills.mjs';
import { fetchSentinelPanelStatus, getBackgroundSentinelMod, normalizeSentinelSnapshotPayload, sentinelPanelCache } from './lib/panel-sentinel-adapter.mjs';
import {
  ALLOWED_SLASH_COMMANDS,
  DEFAULT_CHAT_QUEUE_MAX_SIZE,
  Queue,
  SAFE_SIDE_ID_RE,
  buildComposerAtSuggestions,
  computeFastRamAutocomplete,
  dispatchChatMessageFromSidecar,
  getAutocompleteCtxRefreshQueue,
  getAutocompleteWorkspaceContext,
  prioritizeContextForDraft,
} from './lib/panel-composer-engine.mjs';
import {
  collectKnownWorkspacesForPanel,
  collectTelemetry,
  gpuStatusPanelCache,
  mergeRamSavingsIntoTelemetry,
  resolveActiveWorkspaceForPanel,
  safeCheckCompaction,
  safeClearPitfalls,
  safeGetBayesianSummary,
  safeGetCircuitState,
  safeGetCpuStatus,
  safeGetGpuStatus,
  safeGetHardwareProfile,
  safeGetHudAndProgressStatus,
  safeGetKnowledgeSnapshot,
  safeGetQuotaForecast,
  safeGetRamCacheStatus,
  safeGetTurnDiffSummary,
  safeGetWiretapFaults,
  safeListCheckpoints,
  safeListPitfalls,
  safeListShadowWorktrees,
  safeListTurnCheckpoints,
  safeResetBayesianPriors,
  safeResetCircuitBreaker,
  safeRollbackCheckpoint,
  safeRollbackTurn,
  safeTriggerManualCompactionDigest,
} from './lib/panel-telemetry-collectors.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

export {
  isAllowedLoopbackEndpoint,
  isValidWorkspaceDir,
  isAllowedLoopbackHost,
  validateRequestOrigin,
  attachSidecarSecurityMiddleware,
  parseLoopbackHostPort,
  probeLoopbackTcpPort,
  startSidecarHostWatchdog,
} from './lib/panel-security.mjs';

export {
  DEPRECATED_STATE_KEYS,
  DEFAULT_PANEL_BLOCK_ORDER,
  COLLAPSIBLE_PANEL_CARD_IDS,
  DEFAULT_COLLAPSED_PANEL_CARDS,
  PANEL_SPOILER_IDS,
  sanitizeBooleanIdMap,
  migrateLegacyPanelCollapsedCards,
  sanitizePanelBlockOrder,
  VALID_PANEL_SECTIONS,
  resolvePanelFetchSections,
  DEFAULT_STATE,
  ALLOWED_STATE_KEYS,
  getRuntimeHardwareCeilings,
  getSubscriptionCapabilities,
  sanitizeStatePatch,
  normalizeWorkspaceUriKey,
  sanitizeSkillModesPatch,
  loadState,
  saveState,
  detectProjectProfile,
  discoverSkills,
  hasLiveRamDaemon,
  handleSidecarExitCleanup,
} from './lib/panel-state-skills.mjs';

export {
  fetchSentinelPanelStatus,
} from './lib/panel-sentinel-adapter.mjs';

export {
  buildComposerAtSuggestions,
  buildSmartContinuationChips,
  prioritizeContextForDraft,
  computeFastRamAutocomplete,
  invalidateAutocompleteContextCache,
  resolveProjectIdForWorkspace,
  extractConversationIdFromAgentApiOutput,
  DEFAULT_CHAT_QUEUE_MAX_SIZE,
  Queue,
  dispatchChatMessageFromSidecar,
} from './lib/panel-composer-engine.mjs';

export {
  collectTelemetry,
  resolveActiveWorkspaceForPanel,
  safeGetRamCacheStatus,
  mergeRamSavingsIntoTelemetry,
  safeGetCpuStatus,
} from './lib/panel-telemetry-collectors.mjs';

let SidecarApp = null;

let Response = null;
try {
  const sdk = await import('sidecar_sdk');
  SidecarApp = sdk.SidecarApp || sdk.default?.SidecarApp || null;
  Response = sdk.Response || sdk.default?.Response || null;
} catch {
  try {
    const fallbackSdkPath = join(homedir(), '.gemini', 'config', 'node_modules', 'sidecar_sdk', 'index.mjs');
    if (existsSync(fallbackSdkPath)) {
      const sdk = await import(pathToFileURL(fallbackSdkPath).href);
      SidecarApp = sdk.SidecarApp || sdk.default?.SidecarApp || null;
      Response = sdk.Response || sdk.default?.Response || null;
    }
  } catch {}
}

if (!Response) {
  Response = class FallbackResponse {
    constructor(body, init = {}) {
      const opts = init && typeof init === 'object' ? init : {};
      this.body = body;
      this.status = opts.status || 200;
      this.headers = opts.headers || {};
      this.contentType = opts.contentType || this.headers['content-type'] || this.headers['Content-Type'] || 'text/plain';
    }
    static html(body, status = 200) {
      return new FallbackResponse(body, { status, contentType: 'text/html; charset=utf-8' });
    }
    static json(data, status = 200) {
      return { status, body: data };
    }
    static error(message, status = 500) {
      return { status, error: message };
    }
  };
}

const UI_HTML_PATH = join(__dirname, 'ui.html');

const PLUGIN_JSON_PATH = join(__dirname, '..', '..', 'plugin.json');

function getPluginVersion() {
  try {
    const meta = safeReadJsonSync(PLUGIN_JSON_PATH, null, { selfHeal: false });
    const ver = typeof meta?.version === 'string' ? meta.version.trim() : '';
    if (ver) return ver;
  } catch {}
  return '3.32.2';
}

function getUiBuildVersion() {
  try {
    const st = statSync(UI_HTML_PATH);
    return `${Math.round(st.mtimeMs)}-${st.size}`;
  } catch {
    return '0';
  }
}

function isMainEntry() {
  try {
    if (!process.argv[1]) return false;
    const norm = (p) => resolve(p).replace(/\\/g, '/');
    const a = norm(process.argv[1]);
    const b = norm(fileURLToPath(import.meta.url));
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
}

export async function startSidecarPanel(options = {}) {
  const AppCtor = options?.SidecarAppClass || SidecarApp;
  if (!AppCtor) return null;
  let app = null;
  try {
    app = new AppCtor();
  } catch {
    return null;
  }
  let securityMiddlewareActive = false;
  const ensurePostReq = (req) => (req && typeof req === 'object' ? (req.method ? req : { ...req, method: 'POST' }) : req);
  const isRouteAuthorized = (req) => (req ? validateRequestOrigin(ensurePostReq(req)) : securityMiddlewareActive);

  app.page('/', () => {
    const html = readFileSync(UI_HTML_PATH, 'utf-8');
    return new Response(html, {
      contentType: 'text/html; charset=utf-8',
      headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
    });
  });

  app.page('/favicon.ico', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="#0a84ff"/></svg>';
    return new Response(svg, {
      contentType: 'image/svg+xml; charset=utf-8',
      headers: { 'Cache-Control': 'public, max-age=86400' },
    });
  });

  let mcpStartupSynced = false;
  app.api('/api/state', async (data) => {
    let state = loadState();
    const panelPluginRoot = join(__dirname, '..', '..');
    if (state.onboardingCompleted === false && state.hardwareProfiled !== true && panelRuntime.hardwareProfilerSync?.ensureHardwareCalibratedOnce) {
      try {
        const cal = await panelRuntime.hardwareProfilerSync.ensureHardwareCalibratedOnce({
          pluginRoot: panelPluginRoot,
          statePath: resolvePanelStatePath(),
        });
        if (cal?.calibrated && cal.state) {
          state = loadState();
          mcpStartupSynced = true;
        }
      } catch {}
    }
    if (
      !mcpStartupSynced &&
      !process.env.TUNNEL_TEST_STATE_PATH &&
      process.env.TUNNEL_TEST_ISOLATE_INSTALLED !== '1' &&
      panelRuntime.hardwareProfilerSync?.syncMcpRamBudget
    ) {
      mcpStartupSynced = true;
      try {
        panelRuntime.hardwareProfilerSync.syncMcpRamBudget(panelPluginRoot, state.ramMaxBudgetMb || 4096, {
          resolveAbsoluteEntry: true,
          gpuEnabled: Boolean(state.gpuEnabled),
        });
      } catch {}
    }
    const rawReqRoot = typeof data?.rootDir === 'string' ? data.rootDir.trim() : '';
    const isAllScope = data?.workspaceScope === 'all' || rawReqRoot === '__all__';
    const isPinned = Boolean(rawReqRoot && rawReqRoot !== '__all__' && rawReqRoot !== '__auto__' && isValidWorkspaceDir(rawReqRoot));
    const hudPack = await safeGetHudAndProgressStatus(state, isPinned ? resolve(rawReqRoot) : '');
    const autoWs = await resolveActiveWorkspaceForPanel('', { taskProgress: hudPack.progress });
    const activeWs = isPinned ? resolve(rawReqRoot) : autoWs;
    const cpWs = resolveCheckpointScopeWs(data, activeWs);
    const sec = resolvePanelFetchSections(data, state, { endpoint: 'state' });
    const needHwProfile = sec.all || sec.hw || state.onboardingCompleted === false;
    const telemetry = collectTelemetry(state.compactionTokenThreshold || 120000, { workspaceRoot: activeWs });
    const [checkpoints, turnCheckpoints, shadowWorktrees, wiretapFaults, quotaPacer, circuitBreaker, compaction, pitfalls, bayesian, ramCache, gpu, hardwareProfile, sentinel, knowledgeSnap] = await Promise.all([
      sec.checkpoints ? safeListCheckpoints(isAllScope ? 20 : 10, cpWs) : Promise.resolve(undefined),
      sec.checkpoints ? safeListTurnCheckpoints(isAllScope ? 16 : 10, cpWs) : Promise.resolve(undefined),
      sec.checkpoints && state.shadowWorktreeEnabled !== false ? safeListShadowWorktrees(activeWs) : Promise.resolve(undefined),
      safeGetWiretapFaults(activeWs, state),
      safeGetQuotaForecast(state),
      sec.circuit ? safeGetCircuitState(activeWs) : Promise.resolve(undefined),
      sec.compaction
        ? safeCheckCompaction(telemetry.compactionThresholdTokens || state.compactionTokenThreshold || 120000, telemetry)
        : Promise.resolve(undefined),
      sec.pitfalls ? safeListPitfalls(10, activeWs) : Promise.resolve(undefined),
      sec.bayesian ? safeGetBayesianSummary(activeWs) : Promise.resolve(undefined),
      sec.hw ? safeGetRamCacheStatus(state) : Promise.resolve(undefined),
      sec.hw ? safeGetGpuStatus() : Promise.resolve(undefined),
      needHwProfile ? safeGetHardwareProfile(state, false) : Promise.resolve(undefined),
      fetchSentinelPanelStatus(activeWs, state),
      sec.pitfalls ? safeGetKnowledgeSnapshot(activeWs, state) : Promise.resolve(undefined),
    ]);
    const knownWorkspaces = await collectKnownWorkspacesForPanel({
      activeWs,
      autoWs,
      taskProgress: hudPack.progress,
      ramCache,
    });
    const mergedTelemetry = ramCache ? mergeRamSavingsIntoTelemetry(telemetry, ramCache) : telemetry;
    const skills = sec.skills ? discoverSkills(activeWs) : undefined;
    const cpu = sec.hw ? safeGetCpuStatus(state, ramCache) : undefined;
    return {
      state,
      activeWorkspace: activeWs,
      autoWorkspace: autoWs,
      workspaceScope: isAllScope ? 'all' : (isPinned ? 'pinned' : 'auto'),
      knownWorkspaces,
      ...(skills !== undefined ? { skills } : {}),
      projectDetection: detectProjectProfile(activeWs),
      telemetry: mergedTelemetry,
      ...(checkpoints !== undefined ? { checkpoints } : {}),
      ...(turnCheckpoints !== undefined ? { turnCheckpoints } : {}),
      ...(shadowWorktrees !== undefined ? { shadowWorktrees } : {}),
      wiretapFaults,
      quotaPacer,
      ...(circuitBreaker !== undefined ? { circuitBreaker } : {}),
      ...(compaction !== undefined ? { compaction } : {}),
      ...(pitfalls !== undefined ? { pitfalls } : {}),
      ...(knowledgeSnap !== undefined ? { victoryRecipes: knowledgeSnap.recipes, federatedPeers: knowledgeSnap.peers, knowledgeStats: knowledgeSnap.stats } : {}),
      ...(bayesian !== undefined ? { bayesian } : {}),
      ...(ramCache !== undefined ? { ramCache } : {}),
      ...(gpu !== undefined ? { gpu } : {}),
      ...(cpu !== undefined ? { cpu } : {}),
      sentinel,
      ...(hardwareProfile !== undefined ? { hardwareProfile } : {}),
      hardwareCeilings: hardwareProfile?.hardwareCeilings || getRuntimeHardwareCeilings(),
      subscriptionCapabilities: getSubscriptionCapabilities(state?.subscriptionTier),
      pricingPhase: getPricingPhaseStatus(),
      floatingHud: hudPack.hud,
      taskProgress: hudPack.progress,
      pluginVersion: getPluginVersion(),
      uiBuildVersion: getUiBuildVersion(),
      includedSections: sec.included,
      deferredSections: sec.deferred,
    };
  }, 'GET');

  app.api('/api/telemetry', async (data) => {
    const state = loadState();
    const rawReqRoot = typeof data?.rootDir === 'string' ? data.rootDir.trim() : '';
    const isAllScope = data?.workspaceScope === 'all' || rawReqRoot === '__all__';
    const isPinned = Boolean(rawReqRoot && rawReqRoot !== '__all__' && rawReqRoot !== '__auto__' && isValidWorkspaceDir(rawReqRoot));
    const hudPack = await safeGetHudAndProgressStatus(state, isPinned ? resolve(rawReqRoot) : '');
    const autoWs = await resolveActiveWorkspaceForPanel('', { taskProgress: hudPack.progress });
    const activeWs = isPinned ? resolve(rawReqRoot) : autoWs;
    const sec = resolvePanelFetchSections(data, state, { endpoint: 'telemetry' });
    const telemetry = collectTelemetry(state.compactionTokenThreshold || 120000, { workspaceRoot: activeWs });
    const [circuitBreaker, compaction, ramCache, gpu, bayesian, sentinel, wiretapFaults, quotaPacer] = await Promise.all([
      sec.circuit ? safeGetCircuitState(activeWs) : Promise.resolve(undefined),
      sec.compaction
        ? safeCheckCompaction(telemetry.compactionThresholdTokens || state.compactionTokenThreshold || 120000, telemetry)
        : Promise.resolve(undefined),
      sec.hw ? safeGetRamCacheStatus(state) : Promise.resolve(undefined),
      sec.hw ? safeGetGpuStatus() : Promise.resolve(undefined),
      sec.bayesian ? safeGetBayesianSummary(activeWs) : Promise.resolve(undefined),
      fetchSentinelPanelStatus(activeWs, state),
      safeGetWiretapFaults(activeWs, state),
      safeGetQuotaForecast(state),
    ]);
    const knownWorkspaces = await collectKnownWorkspacesForPanel({
      activeWs,
      autoWs,
      taskProgress: hudPack.progress,
      ramCache,
    });
    const mergedTelemetry = ramCache ? mergeRamSavingsIntoTelemetry(telemetry, ramCache) : telemetry;
    const cpu = sec.hw ? safeGetCpuStatus(state, ramCache) : undefined;
    return {
      ok: true,
      activeWorkspace: activeWs,
      autoWorkspace: autoWs,
      workspaceScope: isAllScope ? 'all' : (isPinned ? 'pinned' : 'auto'),
      knownWorkspaces,
      projectDetection: detectProjectProfile(activeWs),
      telemetry: mergedTelemetry,
      wiretapFaults,
      quotaPacer,
      ...(circuitBreaker !== undefined ? { circuitBreaker } : {}),
      ...(compaction !== undefined ? { compaction } : {}),
      ...(ramCache !== undefined ? { ramCache } : {}),
      ...(gpu !== undefined ? { gpu } : {}),
      ...(cpu !== undefined ? { cpu } : {}),
      sentinel,
      hardwareCeilings: getRuntimeHardwareCeilings(),
      ...(bayesian !== undefined ? { bayesian } : {}),
      floatingHud: hudPack.hud,
      taskProgress: hudPack.progress,
      pricingPhase: getPricingPhaseStatus(),
      pluginVersion: getPluginVersion(),
      uiBuildVersion: getUiBuildVersion(),
      includedSections: sec.included,
      ts: Date.now(),
    };
  }, 'GET');

  app.api('/api/panel-sections', async (data) => {
    const state = loadState();
    const rawReqRoot = typeof data?.rootDir === 'string' ? data.rootDir.trim() : '';
    const isAllScope = data?.workspaceScope === 'all' || rawReqRoot === '__all__';
    const activeWs = await resolveActiveWorkspaceForPanel(rawReqRoot);
    const cpWs = resolveCheckpointScopeWs(data, activeWs);
    const sec = resolvePanelFetchSections(data, state, { endpoint: 'sections', defaultNone: true });
    const telemetry = sec.compaction ? collectTelemetry(state.compactionTokenThreshold || 120000, { workspaceRoot: activeWs }) : null;
    const [checkpoints, turnCheckpoints, shadowWorktrees, circuitBreaker, compaction, pitfalls, bayesian, ramCache, gpu, hardwareProfile, sentinel, knowledgeSnap] = await Promise.all([
      sec.checkpoints ? safeListCheckpoints(isAllScope ? 20 : 10, cpWs) : Promise.resolve(undefined),
      sec.checkpoints ? safeListTurnCheckpoints(isAllScope ? 16 : 10, cpWs) : Promise.resolve(undefined),
      sec.checkpoints && state.shadowWorktreeEnabled !== false ? safeListShadowWorktrees(activeWs) : Promise.resolve(undefined),
      sec.circuit ? safeGetCircuitState(activeWs) : Promise.resolve(undefined),
      sec.compaction && telemetry
        ? safeCheckCompaction(telemetry.compactionThresholdTokens || state.compactionTokenThreshold || 120000, telemetry)
        : Promise.resolve(undefined),
      sec.pitfalls ? safeListPitfalls(10, activeWs) : Promise.resolve(undefined),
      sec.bayesian ? safeGetBayesianSummary(activeWs) : Promise.resolve(undefined),
      sec.hw ? safeGetRamCacheStatus(state) : Promise.resolve(undefined),
      sec.hw ? safeGetGpuStatus() : Promise.resolve(undefined),
      sec.hw ? safeGetHardwareProfile(state, false) : Promise.resolve(undefined),
      sec.hw ? fetchSentinelPanelStatus(activeWs, state) : Promise.resolve(undefined),
      sec.pitfalls ? safeGetKnowledgeSnapshot(activeWs, state) : Promise.resolve(undefined),
    ]);
    const skills = sec.skills ? discoverSkills(activeWs) : undefined;
    const cpu = sec.hw ? safeGetCpuStatus(state, ramCache) : undefined;
    return {
      ok: true,
      includedSections: sec.included,
      ...(skills !== undefined ? { skills } : {}),
      ...(checkpoints !== undefined ? { checkpoints } : {}),
      ...(turnCheckpoints !== undefined ? { turnCheckpoints } : {}),
      ...(shadowWorktrees !== undefined ? { shadowWorktrees } : {}),
      ...(circuitBreaker !== undefined ? { circuitBreaker } : {}),
      ...(compaction !== undefined ? { compaction } : {}),
      ...(pitfalls !== undefined ? { pitfalls } : {}),
      ...(knowledgeSnap !== undefined ? { victoryRecipes: knowledgeSnap.recipes, federatedPeers: knowledgeSnap.peers, knowledgeStats: knowledgeSnap.stats } : {}),
      ...(bayesian !== undefined ? { bayesian } : {}),
      ...(ramCache !== undefined ? { ramCache } : {}),
      ...(gpu !== undefined ? { gpu } : {}),
      ...(cpu !== undefined ? { cpu } : {}),
      ...(sentinel !== undefined ? { sentinel } : {}),
      ...(hardwareProfile !== undefined ? { hardwareProfile } : {}),
      ...(hardwareProfile?.hardwareCeilings ? { hardwareCeilings: hardwareProfile.hardwareCeilings } : {}),
      ts: Date.now(),
    };
  }, 'GET');

  const handleStateUpdate = async (data, req) => {
    if (!isRouteAuthorized(req)) {
      return { ok: false, status: 403, error: 'Forbidden origin' };
    }
    let next = saveState(data);
    const rawReqRoot = typeof data?.rootDir === 'string' ? data.rootDir.trim() : '';
    const isAllScope = data?.workspaceScope === 'all' || rawReqRoot === '__all__';
    const isPinned = Boolean(rawReqRoot && rawReqRoot !== '__all__' && rawReqRoot !== '__auto__' && isValidWorkspaceDir(rawReqRoot));
    const autoWs = await resolveActiveWorkspaceForPanel('');
    const activeWs = isPinned ? resolve(rawReqRoot) : autoWs;
    const cpWs = resolveCheckpointScopeWs(data, activeWs);
    const telemetry = collectTelemetry(next.compactionTokenThreshold || 120000, { workspaceRoot: activeWs });
    const hasGpuPatch = Boolean(data && typeof data === 'object' && Object.keys(data).some((k) => k.startsWith('gpu')));
    const touchesVramOrModel = Boolean(
      data &&
      typeof data === 'object' &&
      (
        Object.hasOwn(data, 'gpuMaxVramMb') ||
        Object.hasOwn(data, 'gpuChatModel') ||
        Object.hasOwn(data, 'gpuEmbedModel') ||
        Object.hasOwn(data, 'gpuEnabled')
      )
    );
    let capEnforcement = null;
    if (touchesVramOrModel && process.env.TUNNEL_TEST_ISOLATE_INSTALLED !== '1') {
      try {
        const gpuMod = await getLocalGpuMod();
        if (next.gpuEnabled === false) {
          if (gpuMod?.unloadAllModels) await gpuMod.unloadAllModels().catch(() => {});
        } else if (
          Object.hasOwn(data, 'gpuMaxVramMb') ||
          Object.hasOwn(data, 'gpuChatModel') ||
          Object.hasOwn(data, 'gpuEmbedModel')
        ) {
          if (
            Object.hasOwn(data, 'gpuMaxVramMb') &&
            gpuMod?.selectBestInstalledPairForCap &&
            (!Object.hasOwn(data, 'gpuChatModel') || !Object.hasOwn(data, 'gpuEmbedModel'))
          ) {
            const preSnap = gpuMod.getGpuStatusSnapshot
              ? await gpuMod.getGpuStatusSnapshot({ force: true }).catch(() => null)
              : null;
            const bestPair = gpuMod.selectBestInstalledPairForCap({
              capMb: next.gpuMaxVramMb,
              tagModels: preSnap?.ollama?.downloadedModels || null,
              loadedModels: preSnap?.ollama?.loadedModels || [],
              hw: preSnap?.hardware || null,
            });
            const pairPatch = {};
            if (!Object.hasOwn(data, 'gpuChatModel') && bestPair?.gpuChatModel && bestPair.gpuChatModel !== next.gpuChatModel) {
              pairPatch.gpuChatModel = bestPair.gpuChatModel;
            }
            if (!Object.hasOwn(data, 'gpuEmbedModel') && bestPair?.gpuEmbedModel && bestPair.gpuEmbedModel !== next.gpuEmbedModel) {
              pairPatch.gpuEmbedModel = bestPair.gpuEmbedModel;
            }
            if (!Object.hasOwn(data, 'gpuContextTokens') && bestPair?.gpuContextTokens && bestPair.gpuContextTokens !== next.gpuContextTokens) {
              pairPatch.gpuContextTokens = bestPair.gpuContextTokens;
            }
            if (Object.keys(pairPatch).length > 0) {
              next = saveState(pairPatch);
            }
          }
          if (gpuMod?.enforceVramCapInOllama) {
            capEnforcement = await gpuMod.enforceVramCapInOllama({ cfgOverride: next }).catch(() => null);
            if (
              Object.hasOwn(data, 'gpuMaxVramMb') &&
              !Object.hasOwn(data, 'gpuChatModel') &&
              capEnforcement?.vramFit &&
              !capEnforcement.vramFit.selectedChatFits &&
              capEnforcement.vramFit.bestFallbackChatModel
            ) {
              next = saveState({ gpuChatModel: capEnforcement.vramFit.bestFallbackChatModel });
            }
          }
        }
      } catch {}
      gpuStatusPanelCache.ts = 0;
    }
    const hasSentinelPatch = Boolean(
      data &&
      typeof data === 'object' &&
      (Object.keys(data).some((k) => k.startsWith('sentinel')) || Object.hasOwn(data, 'hookProfile'))
    );
    if (hasSentinelPatch) {
      sentinelPanelCache.ts = 0;
    }
    if (
      process.env.TUNNEL_TEST_ISOLATE_INSTALLED !== '1' &&
      data &&
      typeof data === 'object' &&
      (
        Object.hasOwn(data, 'ramCacheEnabled') ||
        Object.hasOwn(data, 'ramMaxBudgetMb') ||
        Object.hasOwn(data, 'hookProfile') ||
        Object.hasOwn(data, 'lspBridgeEnabled')
      )
    ) {
      await Promise.all(readRamDaemonCandidates().map((c) => querySingleRamDaemon(c))).catch(() => {});
    }
    const [checkpoints, turnCheckpoints, shadowWorktrees, wiretapFaults, quotaPacer, circuitBreaker, compaction, pitfalls, bayesian, ramCache, gpu, hardwareProfile, hudPack, sentinel, knowledgeSnap] = await Promise.all([
      safeListCheckpoints(isAllScope ? 20 : 10, cpWs),
      safeListTurnCheckpoints(isAllScope ? 16 : 10, cpWs),
      next.shadowWorktreeEnabled !== false ? safeListShadowWorktrees(activeWs) : Promise.resolve([]),
      safeGetWiretapFaults(activeWs, next),
      safeGetQuotaForecast(next),
      safeGetCircuitState(activeWs),
      safeCheckCompaction(telemetry.compactionThresholdTokens || next.compactionTokenThreshold || 120000, telemetry),
      safeListPitfalls(10, activeWs),
      safeGetBayesianSummary(activeWs),
      safeGetRamCacheStatus(next),
      safeGetGpuStatus({ force: hasGpuPatch }),
      safeGetHardwareProfile(next, false),
      safeGetHudAndProgressStatus(next, activeWs),
      fetchSentinelPanelStatus(activeWs, next, { force: hasSentinelPatch }),
      safeGetKnowledgeSnapshot(activeWs, next),
    ]);
    const knownWorkspaces = await collectKnownWorkspacesForPanel({
      activeWs,
      autoWs,
      taskProgress: hudPack.progress,
      ramCache,
    });
    const mergedTelemetry = mergeRamSavingsIntoTelemetry(telemetry, ramCache);
    return {
      state: next,
      activeWorkspace: activeWs,
      autoWorkspace: autoWs,
      workspaceScope: isAllScope ? 'all' : (isPinned ? 'pinned' : 'auto'),
      knownWorkspaces,
      skills: discoverSkills(activeWs),
      projectDetection: detectProjectProfile(activeWs),
      telemetry: mergedTelemetry,
      checkpoints,
      turnCheckpoints,
      shadowWorktrees,
      wiretapFaults,
      quotaPacer,
      circuitBreaker,
      compaction,
      pitfalls,
      victoryRecipes: knowledgeSnap.recipes,
      federatedPeers: knowledgeSnap.peers,
      knowledgeStats: knowledgeSnap.stats,
      bayesian,
      ramCache,
      gpu,
      capEnforcement,
      cpu: safeGetCpuStatus(next, ramCache),
      sentinel,
      hardwareProfile,
      hardwareCeilings: hardwareProfile?.hardwareCeilings || getRuntimeHardwareCeilings(),
      subscriptionCapabilities: getSubscriptionCapabilities(next?.subscriptionTier),
      floatingHud: hudPack.hud,
      taskProgress: hudPack.progress,
      pluginVersion: getPluginVersion(),
      uiBuildVersion: getUiBuildVersion(),
    };
  };

  app.api('/api/state', handleStateUpdate, 'POST');
  app.api('/api/update', handleStateUpdate, 'POST');

  app.api('/api/sentinel', async (data, req) => {
    if (!isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    try {
      sentinelPanelCache.ts = 0;
      const wsRoot = await resolveActiveWorkspaceForPanel(data?.rootDir);
      const curState = loadState();
      const ALLOWED_SENTINEL_ACTIONS = new Set(['run_now', 'clear_findings', 'speculative_warm', 'preempt', 'prepare_commit']);
      const ALLOWED_SENTINEL_MODES = new Set(['all', 'shadow_guard', 'bugbot', 'symbol_cards', 'shadow_tests']);
      const rawAction = typeof data?.action === 'string' ? data.action.trim() : 'run_now';
      const rawMode = typeof data?.mode === 'string' ? data.mode.trim() : 'all';
      const actionPayload = {
        action: ALLOWED_SENTINEL_ACTIONS.has(rawAction) ? rawAction : 'run_now',
        mode: ALLOWED_SENTINEL_MODES.has(rawMode) ? rawMode : 'all',
        query: typeof data?.query === 'string' ? data.query.slice(0, 600) : '',
        force: Boolean(data?.force),
        wsPath: wsRoot,
        cfgOverride: curState,
        lang: normalizeLang(curState?.uiLanguage, 'en'),
      };
      const daemonRes = process.env.TUNNEL_TEST_ISOLATE_INSTALLED === '1'
        ? null
        : await postRamDaemonJson('/sentinel/action', actionPayload, 25000);
      if (daemonRes && daemonRes.ok) {
        const normalized = normalizeSentinelSnapshotPayload(daemonRes, curState);
        Object.assign(sentinelPanelCache, {
          ts: Date.now(),
          wsKey: String(wsRoot || ''),
          enabled: curState.sentinelEnabled !== false,
          shadowTests: Boolean(curState.sentinelShadowTests),
          value: normalized,
        });
        return { ok: true, sentinel: normalized, ...(daemonRes.preCommit ? { preCommit: daemonRes.preCommit } : {}) };
      }

      const sentinelMod = await getBackgroundSentinelMod();
      let res = null;
      if (sentinelMod?.sentinel && typeof sentinelMod.sentinel.runAction === 'function') {
        res = await sentinelMod.sentinel.runAction(actionPayload);
      } else if (typeof sentinelMod?.runAction === 'function') {
        res = await sentinelMod.runAction(actionPayload);
      } else if (typeof sentinelMod?.runSentinelAction === 'function') {
        res = await sentinelMod.runSentinelAction(actionPayload);
      } else if (sentinelMod?.default && typeof sentinelMod.default.runAction === 'function') {
        res = await sentinelMod.default.runAction(actionPayload);
      }
      if (res) {
        const normalized = normalizeSentinelSnapshotPayload(res, curState);
        Object.assign(sentinelPanelCache, {
          ts: Date.now(),
          wsKey: String(wsRoot || ''),
          enabled: curState.sentinelEnabled !== false,
          shadowTests: Boolean(curState.sentinelShadowTests),
          value: normalized,
        });
        return { ok: true, sentinel: normalized, ...(res.preCommit ? { preCommit: res.preCommit } : {}) };
      }

      const fallback = await fetchSentinelPanelStatus(wsRoot, curState, { force: true });
      return { ok: true, sentinel: fallback };
    } catch (err) {
      const lang = normalizeLang(loadState()?.uiLanguage, 'en');
      return { ok: false, error: err?.message || pickLang(lang, 'Ошибка выполнения Фонового Дозора', 'Background Sentinel execution failed') };
    }
  }, 'POST');

  app.api('/api/rollback', async (data, req) => {
    if (!isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const activeWs = await resolveActiveWorkspaceForPanel(data?.rootDir);
    const cpWs = resolveCheckpointScopeWs(data, activeWs);
    return await safeRollbackCheckpoint(data?.checkpointId || 'latest', cpWs, { lang: normalizeLang(loadState()?.uiLanguage, 'en') });
  }, 'POST');

  app.api('/api/checkpoints/turns', async (data) => {
    const activeWs = await resolveActiveWorkspaceForPanel(data?.rootDir);
    const cpWs = resolveCheckpointScopeWs(data, activeWs);
    const curState = loadState();
    const [turns, worktrees] = await Promise.all([
      safeListTurnCheckpoints(cpWs === '__all__' ? 20 : 15, cpWs),
      curState.shadowWorktreeEnabled !== false ? safeListShadowWorktrees(activeWs) : Promise.resolve([]),
    ]);
    return { ok: true, turns, worktrees };
  }, 'GET');

  app.api('/api/checkpoints/turn-diff', async (data, req) => {
    if (!isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const activeWs = await resolveActiveWorkspaceForPanel(data?.rootDir);
    const cpWs = resolveCheckpointScopeWs(data, activeWs);
    return await safeGetTurnDiffSummary(data?.turnId || 'latest', cpWs, { lang: normalizeLang(loadState()?.uiLanguage, 'en') });
  }, 'POST');

  app.api('/api/checkpoints/rollback-turn', async (data, req) => {
    if (!isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const activeWs = await resolveActiveWorkspaceForPanel(data?.rootDir);
    const cpWs = resolveCheckpointScopeWs(data, activeWs);
    return await safeRollbackTurn(data?.turnId || 'latest', cpWs, { lang: normalizeLang(loadState()?.uiLanguage, 'en') });
  }, 'POST');

  app.api('/api/worktree/action', async (data, req) => {
    if (!isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const activeWs = await resolveActiveWorkspaceForPanel(data?.rootDir);
    const curState = loadState();
    const lang = normalizeLang(curState?.uiLanguage, 'en');
    const mod = await getShadowWorktreeMod();
    if (!mod) return { ok: false, error: pickLang(lang, 'Модуль Git-песочницы недоступен', 'Git sandbox module unavailable') };
    const act = String(data?.action || 'list').trim();
    if (act === 'create') {
      const created = mod.createShadowWorktree({ workspaceRoot: activeWs, label: data?.label || '', state: curState, lang });
      return { ...created, worktrees: mod.listShadowWorktrees(activeWs) };
    }
    if (act === 'diff') {
      return mod.getShadowWorktreeDiff({ id: data?.id || '', workspaceRoot: activeWs, lang });
    }
    if (act === 'promote') {
      const res = mod.promoteShadowWorktree({ id: data?.id || '', workspaceRoot: activeWs, cleanup: data?.cleanup !== false, lang });
      return { ...res, worktrees: mod.listShadowWorktrees(activeWs) };
    }
    if (act === 'discard') {
      const res = mod.discardShadowWorktree({ id: data?.id || '', workspaceRoot: activeWs, lang });
      return { ...res, worktrees: mod.listShadowWorktrees(activeWs) };
    }
    return { ok: true, worktrees: mod.listShadowWorktrees(activeWs) };
  }, 'POST');

  app.api('/api/wiretap/faults', async (data) => {
    const activeWs = await resolveActiveWorkspaceForPanel(data?.rootDir);
    return { ok: true, faults: await safeGetWiretapFaults(activeWs, loadState()) };
  }, 'GET');

  app.api('/api/wiretap/fault', async (data, req) => {
    if (!isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const activeWs = await resolveActiveWorkspaceForPanel(data?.rootDir);
    const curState = loadState();
    const lang = normalizeLang(curState?.uiLanguage, 'en');
    const mod = await getRuntimeWiretapMod();
    if (!mod) return { ok: false, error: pickLang(lang, 'Модуль Wiretap недоступен', 'Runtime Wiretap module unavailable') };
    const ingestRes = mod.ingestRuntimeFault({
      workspaceRoot: activeWs,
      source: data?.source || 'panel',
      command: data?.command || '',
      rawError: data?.rawError || data?.error || '',
      exitCode: data?.exitCode ?? 1,
      state: curState,
      lang,
    });
    return { ...ingestRes, faults: await safeGetWiretapFaults(activeWs, curState) };
  }, 'POST');

  app.api('/api/wiretap/clear', async (data, req) => {
    if (!isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const activeWs = await resolveActiveWorkspaceForPanel(data?.rootDir);
    const lang = normalizeLang(loadState()?.uiLanguage, 'en');
    const mod = await getRuntimeWiretapMod();
    if (!mod) return { ok: false, error: pickLang(lang, 'Модуль Wiretap недоступен', 'Runtime Wiretap module unavailable') };
    return mod.clearWiretapFaults(activeWs);
  }, 'POST');

  app.api('/api/repomap', async (data, req) => {
    if (!isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const root = data?.rootDir ? String(data.rootDir) : await resolveActiveWorkspaceForPanel();
    if (!isValidWorkspaceDir(root)) {
      return new Response(JSON.stringify({ ok: false, status: 400, error: 'Invalid workspace directory' }), {
        status: 400,
        contentType: 'application/json',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    }
    return await safeGetCachedRepoMap(root, true);
  }, 'POST');

  app.api('/api/circuit-reset', async (data, req) => {
    if (!isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const activeWs = await resolveActiveWorkspaceForPanel(data?.rootDir);
    return await safeResetCircuitBreaker(activeWs);
  }, 'POST');

  app.api('/api/bayesian-reset', async (data, req) => {
    if (!isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const activeWs = await resolveActiveWorkspaceForPanel(data?.rootDir);
    return await safeResetBayesianPriors(activeWs, Boolean(data?.onlyFragility));
  }, 'POST');

  app.api('/api/compact-digest', async (data, req) => {
    if (!isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    return await safeTriggerManualCompactionDigest(data);
  }, 'POST');

  app.api('/api/pitfalls-clear', async (data, req) => {
    if (!isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const activeWs = await resolveActiveWorkspaceForPanel(data?.rootDir);
    return await safeClearPitfalls(activeWs);
  }, 'POST');

  app.api('/api/knowledge/recipes', async (data, req) => {
    if (!isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const activeWs = await resolveActiveWorkspaceForPanel(data?.rootDir);
    const mod = await getKnowledgeHubMod();
    const hub = mod?.knowledgeHub;
    if (!hub) return { ok: false, error: 'Knowledge hub unavailable' };
    return { ok: true, recipes: hub.listVictoryRecipes(activeWs, 15), stats: hub.getStats(activeWs) };
  }, 'GET');

  app.api('/api/knowledge/recipes', async (data, req) => {
    if (!isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const activeWs = await resolveActiveWorkspaceForPanel(data?.rootDir);
    const mod = await getKnowledgeHubMod();
    const hub = mod?.knowledgeHub;
    if (!hub) return { ok: false, error: 'Knowledge hub unavailable' };
    if (data?.action === 'clear') {
      hub.clearVictoryRecipes(activeWs);
    } else if (data?.fixSummary || data?.errorExcerpt) {
      hub.recordVictoryRecipe({
        workspaceRoot: activeWs,
        errorExcerpt: data.errorExcerpt || '',
        touchedFiles: Array.isArray(data.touchedFiles) ? data.touchedFiles : [],
        fixSummary: data.fixSummary || '',
      });
    }
    return { ok: true, recipes: hub.listVictoryRecipes(activeWs, 15), stats: hub.getStats(activeWs) };
  }, 'POST');

  app.api('/api/knowledge/federation', async (data, req) => {
    if (!isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const activeWs = await resolveActiveWorkspaceForPanel(data?.rootDir);
    const mod = await getKnowledgeHubMod();
    const hub = mod?.knowledgeHub;
    if (!hub) return { ok: false, error: 'Knowledge hub unavailable' };
    const normPeer = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
    const activeNorm = normPeer(resolve(activeWs));
    let targetPeers = Array.isArray(data?.peers) ? data.peers : null;
    if (!targetPeers && typeof data?.addPeer === 'string' && data.addPeer.trim()) {
      const rawAdd = data.addPeer.trim();
      const candAbs = isAbsolute(rawAdd) ? resolve(rawAdd) : resolve(activeWs, rawAdd);
      let isDir = false;
      try {
        isDir = existsSync(candAbs) && statSync(candAbs).isDirectory() && isValidWorkspaceDir(candAbs);
      } catch {
        isDir = false;
      }
      if (!isDir || normPeer(candAbs) === activeNorm) {
        const lang = normalizeLang(loadState()?.uiLanguage, 'en');
        return {
          ok: false,
          error: pickLang(lang, 'Папка репозитория не найдена или совпадает с текущим проектом', 'Repository folder not found or matches current workspace'),
          peers: hub.getFederatedWorkspaces(activeWs),
          stats: hub.getStats(activeWs),
        };
      }
      const existing = hub.getFederatedWorkspaces(activeWs).map((p) => p.path);
      targetPeers = [...existing, candAbs];
    } else if (!targetPeers && typeof data?.removePeer === 'string' && data.removePeer.trim()) {
      const rawRm = data.removePeer.trim();
      const rmAbs = isAbsolute(rawRm) ? resolve(rawRm) : resolve(activeWs, rawRm);
      const rmRawNorm = normPeer(rawRm);
      const rmAbsNorm = normPeer(rmAbs);
      targetPeers = hub
        .getFederatedWorkspaces(activeWs)
        .map((p) => p.path)
        .filter((p) => {
          const pn = normPeer(resolve(activeWs, p));
          return pn !== rmAbsNorm && normPeer(p) !== rmRawNorm;
        });
    }
    if (!targetPeers) targetPeers = hub.getFederatedWorkspaces(activeWs).map((p) => p.path);
    const res = hub.setFederatedWorkspaces(activeWs, targetPeers);
    const nextState = saveState({
      federatedWorkspaces: Array.isArray(res.peers) ? res.peers.map((p) => p.path) : [],
    });
    return { ok: true, peers: res.peers, state: nextState, stats: hub.getStats(activeWs) };
  }, 'POST');

  app.api('/api/shield', async (data, req) => {
    if (req && !isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const lang = normalizeLang(loadState()?.uiLanguage, 'en');
    try {
      const activeWs = await resolveActiveWorkspaceForPanel(data?.rootDir);
      const { auditAgentEnvironment } = await import('../../core/agent-shield.mjs');
      const includeGlobal = !(data?.workspaceOnly === '1' || data?.workspaceOnly === true || data?.workspaceOnly === 'true');
      return auditAgentEnvironment({ workspaceRoot: activeWs, includeGlobal, lang });
    } catch (err) {
      return { ok: false, error: err?.message || pickLang(lang, 'Ошибка аудита AgentShield', 'AgentShield audit failed') };
    }
  }, 'GET');

  app.api('/api/setup-recommendations', async (data, req) => {
    if (req && !isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const curState = loadState();
    const lang = normalizeLang(curState?.uiLanguage, 'en');
    try {
      const activeWs = await resolveActiveWorkspaceForPanel(data?.rootDir);
      const { recommendProjectSetup } = await import('../../core/project-setup-recommender.mjs');
      return recommendProjectSetup({ workspaceRoot: activeWs, currentState: curState });
    } catch (err) {
      return { ok: false, error: err?.message || pickLang(lang, 'Ошибка диагностики стека проекта', 'Setup Doctor analysis failed') };
    }
  }, 'GET');

  app.api('/api/setup-recommendations/apply', async (data, req) => {
    if (req && !isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const curState = loadState();
    const lang = normalizeLang(curState?.uiLanguage, 'en');
    try {
      const activeWs = await resolveActiveWorkspaceForPanel(data?.rootDir);
      const kind = typeof data?.kind === 'string' ? data.kind.trim().toLowerCase() : '';
      const { recommendProjectSetup } = await import('../../core/project-setup-recommender.mjs');
      const rec = recommendProjectSetup({ workspaceRoot: activeWs, currentState: curState });
      let applied = false;
      let detail = '';

      if (kind === 'hook_profile') {
        const patch = {
          hookProfile: rec.recommendedHookProfile || 'standard',
          ...(rec.recommendedToggles && typeof rec.recommendedToggles === 'object' ? rec.recommendedToggles : {}),
        };
        saveState(patch);
        applied = true;
        detail = pickLang(lang, `Применён профиль хуков ${patch.hookProfile}`, `Applied hook profile ${patch.hookProfile}`);
      } else if (kind === 'agentignore') {
        const outPath = join(activeWs, '.agentignore');
        try {
          writeFileSync(outPath, '.env*\nsecrets/\n*.pem\n*.key\n', {
            encoding: 'utf8',
            flag: data?.overwrite ? 'w' : 'wx',
          });
        } catch (wErr) {
          if (wErr?.code !== 'EEXIST') throw wErr;
        }
        applied = true;
        detail = pickLang(lang, 'Создан файл .agentignore (UTF-8)', 'Created .agentignore (UTF-8)');
      } else if (kind === 'design_md') {
        const { generateDesignMdFromCode } = await import('../../skills/ui-ux-design-system/scripts/extract-design-md.mjs');
        const mdRes = generateDesignMdFromCode(activeWs, { write: true, overwrite: Boolean(data?.overwrite) });
        applied = Boolean(mdRes?.ok);
        detail = mdRes?.ok
          ? pickLang(lang, 'Сгенерирован DESIGN.md', 'Generated DESIGN.md')
          : (mdRes?.reason || mdRes?.error || pickLang(lang, 'Не удалось создать DESIGN.md', 'Failed to generate DESIGN.md'));
      } else if (kind === 'gates_md') {
        const { initAcceptanceGatesMarkdown } = await import('../../core/completion-gates.mjs');
        const gRes = initAcceptanceGatesMarkdown(activeWs, { overwrite: Boolean(data?.overwrite), lang });
        applied = Boolean(gRes?.ok || gRes?.exists);
        detail = gRes?.ok
          ? pickLang(lang, 'Создан журнал GATES.md', 'Created GATES.md checklist')
          : (gRes?.reason || pickLang(lang, 'GATES.md уже существует', 'GATES.md already exists'));
      } else {
        return { ok: false, error: pickLang(lang, 'Неизвестный тип рекомендации Setup Doctor', 'Unknown Setup Doctor recommendation kind') };
      }

      const freshRec = recommendProjectSetup({ workspaceRoot: activeWs, currentState: loadState() });
      return {
        ok: applied,
        applied,
        kind,
        detail,
        recommendation: freshRec,
        state: loadState(),
      };
    } catch (err) {
      return { ok: false, error: err?.message || pickLang(lang, 'Ошибка применения рекомендации Setup Doctor', 'Failed to apply Setup Doctor recommendation') };
    }
  }, 'POST');

  app.api('/api/skills/search', async (data, req) => {
    if (req && !isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const lang = normalizeLang(loadState()?.uiLanguage, 'en');
    try {
      const activeWs = await resolveActiveWorkspaceForPanel(data?.rootDir);
      const { searchSkillsCatalog } = await import('../../core/skill-registry-bridge.mjs');
      return await searchSkillsCatalog({
        query: typeof data?.query === 'string' ? data.query : '',
        workspaceRoot: activeWs,
        includeRemote: data?.includeRemote !== false,
        limit: Number(data?.limit) || 8,
        lang,
      });
    } catch (err) {
      return { ok: false, error: err?.message || pickLang(lang, 'Ошибка поиска навыков', 'Skill search failed'), localMatches: [], remoteMatches: [] };
    }
  }, 'POST');

  app.api('/api/skills/import', async (data, req) => {
    if (req && !isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const lang = normalizeLang(loadState()?.uiLanguage, 'en');
    try {
      const activeWs = await resolveActiveWorkspaceForPanel(data?.rootDir);
      const { importSkillFromSource } = await import('../../core/skill-registry-bridge.mjs');
      const res = await importSkillFromSource({
        source: typeof data?.source === 'string' ? data.source : '',
        slug: typeof data?.slug === 'string' ? data.slug : '',
        force: Boolean(data?.force),
        dryRun: Boolean(data?.dryRun),
        lang,
      });
      if (panelRuntime?.discoverSkillsCache) {
        panelRuntime.discoverSkillsCache.ts = 0;
      }
      return {
        ...res,
        skills: discoverSkills(activeWs),
      };
    } catch (err) {
      return { ok: false, installed: false, error: err?.message || pickLang(lang, 'Ошибка карантинного импорта навыка', 'Skill quarantine import failed') };
    }
  }, 'POST');

  app.api('/api/instincts', async (data, req) => {
    if (req && !isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const lang = normalizeLang(loadState()?.uiLanguage, 'en');
    try {
      const activeWs = await resolveActiveWorkspaceForPanel(data?.rootDir);
      const mod = await getKnowledgeHubMod();
      const hub = mod?.knowledgeHub;
      if (!hub || typeof hub.listInstincts !== 'function') {
        return { ok: false, error: 'Knowledge hub unavailable', items: [] };
      }
      const includePromoted = data?.all === '1' || data?.all === true || data?.all === 'true';
      const listed = hub.listInstincts({ workspaceRoot: activeWs, includePromoted, minConfidence: 0.1, limit: 30 });
      return { ok: true, items: listed.items || [], stats: hub.getStats(activeWs) };
    } catch (err) {
      return { ok: false, error: err?.message || pickLang(lang, 'Ошибка чтения инстинктов', 'Failed to read instincts'), items: [] };
    }
  }, 'GET');

  app.api('/api/instincts/promote', async (data, req) => {
    if (req && !isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const lang = normalizeLang(loadState()?.uiLanguage, 'en');
    try {
      const activeWs = await resolveActiveWorkspaceForPanel(data?.rootDir);
      const mod = await getKnowledgeHubMod();
      const hub = mod?.knowledgeHub;
      if (!hub) return { ok: false, error: 'Knowledge hub unavailable' };
      const { promoteInstinctToSkill } = await import('../../core/skill-crystallizer.mjs');
      const res = promoteInstinctToSkill({
        instinctId: typeof data?.id === 'string' ? data.id : '',
        workspaceRoot: activeWs,
        skillSlug: typeof data?.skillSlug === 'string' ? data.skillSlug : '',
        hub,
        lang,
      });
      if (!res.ok) return res;
      const listed = hub.listInstincts({ workspaceRoot: activeWs, includePromoted: false, minConfidence: 0.1, limit: 30 });
      return { ...res, items: listed.items || [], stats: hub.getStats(activeWs) };
    } catch (err) {
      return { ok: false, error: err?.message || pickLang(lang, 'Ошибка повышения инстинкта в навык', 'Failed to promote instinct to skill') };
    }
  }, 'POST');

  app.api('/api/instincts/delete', async (data, req) => {
    if (req && !isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const lang = normalizeLang(loadState()?.uiLanguage, 'en');
    try {
      const activeWs = await resolveActiveWorkspaceForPanel(data?.rootDir);
      const mod = await getKnowledgeHubMod();
      const hub = mod?.knowledgeHub;
      if (!hub || typeof hub.deleteInstinct !== 'function') {
        return { ok: false, error: 'Knowledge hub unavailable', items: [] };
      }
      const delRes = hub.deleteInstinct({
        id: typeof data?.id === 'string' ? data.id : '',
        workspaceRoot: activeWs,
      });
      const listed = hub.listInstincts({ workspaceRoot: activeWs, includePromoted: false, minConfidence: 0.1, limit: 30 });
      return { ...delRes, ok: Boolean(delRes?.ok), items: listed.items || [], stats: hub.getStats(activeWs) };
    } catch (err) {
      return { ok: false, error: err?.message || pickLang(lang, 'Ошибка удаления инстинкта', 'Failed to delete instinct'), items: [] };
    }
  }, 'POST');

  app.api('/api/knowledge/episodes', async (data, req) => {
    if (req && !isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    try {
      const activeWs = await resolveActiveWorkspaceForPanel(data?.rootDir);
      const mod = await getKnowledgeHubMod();
      const hub = mod?.knowledgeHub;
      if (!hub || typeof hub.searchSessionEpisodes !== 'function') {
        return { ok: false, error: 'Knowledge hub unavailable', items: [] };
      }
      const res = hub.searchSessionEpisodes({
        workspaceRoot: activeWs,
        query: typeof data?.query === 'string' ? data.query : '',
        limit: Number(data?.limit) || 15,
      });
      return { ok: true, items: res.items || [], stats: hub.getStats(activeWs) };
    } catch (err) {
      const lang = normalizeLang(loadState()?.uiLanguage, 'en');
      return { ok: false, error: err?.message || pickLang(lang, 'Ошибка чтения эпизодов памяти', 'Failed to read memory episodes'), items: [] };
    }
  }, 'GET');

  app.api('/api/gates', async (data, req) => {
    if (req && !isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    try {
      const activeWs = await resolveActiveWorkspaceForPanel(data?.rootDir);
      const gatesPath = join(activeWs, 'GATES.md');
      if (!existsSync(gatesPath)) {
        return { ok: true, exists: false, gatesPath, total: 0, metCount: 0, unmetCount: 0, items: [] };
      }
      const { parseAcceptanceGatesMarkdown } = await import('../../core/completion-gates.mjs');
      const parsed = parseAcceptanceGatesMarkdown(readFileSync(gatesPath, 'utf8'));
      return {
        ok: true,
        exists: true,
        gatesPath,
        total: Number(parsed?.total || 0),
        metCount: Array.isArray(parsed?.met) ? parsed.met.length : 0,
        unmetCount: Array.isArray(parsed?.unmet) ? parsed.unmet.length : 0,
        abandonedCount: Array.isArray(parsed?.abandoned) ? parsed.abandoned.length : 0,
        items: parsed?.items || [],
      };
    } catch (err) {
      const lang = normalizeLang(loadState()?.uiLanguage, 'en');
      return { ok: false, error: err?.message || pickLang(lang, 'Ошибка чтения GATES.md', 'Failed to read GATES.md') };
    }
  }, 'GET');

  app.api('/api/gates', async (data, req) => {
    if (req && !isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const lang = normalizeLang(loadState()?.uiLanguage, 'en');
    try {
      const activeWs = await resolveActiveWorkspaceForPanel(data?.rootDir);
      const { initAcceptanceGatesMarkdown, parseAcceptanceGatesMarkdown } = await import('../../core/completion-gates.mjs');
      const initRes = initAcceptanceGatesMarkdown(activeWs, { overwrite: Boolean(data?.overwrite), lang });
      const gatesPath = join(activeWs, 'GATES.md');
      const parsed = existsSync(gatesPath) ? parseAcceptanceGatesMarkdown(readFileSync(gatesPath, 'utf8')) : null;
      return {
        ok: Boolean(initRes?.ok || initRes?.exists),
        exists: existsSync(gatesPath),
        gatesPath,
        total: Number(parsed?.total || 0),
        metCount: Array.isArray(parsed?.met) ? parsed.met.length : 0,
        unmetCount: Array.isArray(parsed?.unmet) ? parsed.unmet.length : 0,
        items: parsed?.items || [],
      };
    } catch (err) {
      return { ok: false, error: err?.message || pickLang(lang, 'Ошибка создания GATES.md', 'Failed to create GATES.md') };
    }
  }, 'POST');

  app.api('/api/quota/reset-cooldowns', async (_data, req) => {
    if (req && !isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const lang = normalizeLang(loadState()?.uiLanguage, 'en');
    try {
      const { clearExpiredComboCooldowns } = await import('../../core/quota-pacer.mjs');
      const cleared = clearExpiredComboCooldowns({ resetAll: true });
      const quotaPacer = await safeGetQuotaForecast(loadState());
      return { ok: true, cleared, quotaPacer };
    } catch (err) {
      return { ok: false, error: err?.message || pickLang(lang, 'Ошибка сброса пауз Combo', 'Failed to reset Combo cooldowns') };
    }
  }, 'POST');

  app.api('/api/graph', async (data, req) => {
    if (req && !isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const lang = normalizeLang(loadState()?.uiLanguage, 'en');
    try {
      const activeWs = await resolveActiveWorkspaceForPanel(data?.rootDir);
      const { RamMemoryEngine } = await import('../../core/ram-memory-engine.mjs');
      const { computeCacheWarmthStatus } = await import('../../core/quota-pacer.mjs');
      const { getSessionReuseSummary, getSessionVerificationFreshness } = await import('../../core/completion-gates.mjs');
      const tmpEngine = new RamMemoryEngine({ budgetMb: 256 });
      let graphReport = null;
      try {
        graphReport = tmpEngine.queryKnowledgeGraph(activeWs, {
          mode: 'report',
          maxClusters: 8,
          maxGodNodes: 6,
          startWatcher: false,
        });
      } finally {
        tmpEngine.evict('all');
      }
      const warmth = computeCacheWarmthStatus();
      const reuse = getSessionReuseSummary({ workspaceRoot: activeWs });
      const verification = getSessionVerificationFreshness({ workspaceRoot: activeWs });
      return {
        ok: Boolean(graphReport?.ok),
        workspaceRoot: activeWs,
        topologyHash: graphReport?.topologyHash || '',
        fileCount: Number(graphReport?.fileCount || 0),
        modularityQ: Number(graphReport?.modularityQ || 0),
        clusters: graphReport?.clusters || [],
        godNodes: graphReport?.godNodes || [],
        bridges: graphReport?.bridges || [],
        questions: graphReport?.questions || [],
        cacheWarmth: warmth,
        reuse,
        verification,
      };
    } catch (err) {
      return { ok: false, error: err?.message || pickLang(lang, 'Ошибка построения графа архитектуры', 'Failed to build architecture graph') };
    }
  }, 'GET');

  app.api('/api/debt', async (data, req) => {
    if (req && !isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const lang = normalizeLang(loadState()?.uiLanguage, 'en');
    try {
      const activeWs = await resolveActiveWorkspaceForPanel(data?.rootDir);
      const { scanShortcutDebt } = await import('../../core/shortcut-debt-ledger.mjs');
      const res = scanShortcutDebt(activeWs, {
        marker: typeof data?.marker === 'string' ? data.marker : '',
        lang,
      });
      return res;
    } catch (err) {
      return { ok: false, error: err?.message || pickLang(lang, 'Ошибка сканирования техдолга shortcut:', 'Failed to scan shortcut debt ledger') };
    }
  }, 'GET');

  app.api('/api/profile-backup', async (data, req) => {
    if (!isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    try {
      const cli = await import('../../core/router-cli.mjs');
      if (data?.action === 'restore') {
        const res = cli.restoreRouterProfile('');
        if (res?.ok) {
          gpuStatusPanelCache.ts = 0;
          sentinelPanelCache.ts = 0;
          const restored = loadState();
          if (panelRuntime.hardwareProfilerSync?.syncMcpRamBudget) {
            const localRoot = join(__dirname, '..', '..');
            const installedRoot = join(homedir(), '.gemini', 'config', 'plugins', 'antigravity-model-router');
            try {
              panelRuntime.hardwareProfilerSync.syncMcpRamBudget(localRoot, restored.ramMaxBudgetMb || 4096, {
                gpuEnabled: Boolean(restored.gpuEnabled),
              });
            } catch {}
            try {
              if (
                process.env.TUNNEL_TEST_ISOLATE_INSTALLED !== '1' &&
                resolve(installedRoot).toLowerCase() !== resolve(localRoot).toLowerCase() &&
                existsSync(installedRoot)
              ) {
                panelRuntime.hardwareProfilerSync.syncMcpRamBudget(installedRoot, restored.ramMaxBudgetMb || 4096, {
                  resolveAbsoluteEntry: true,
                  gpuEnabled: Boolean(restored.gpuEnabled),
                });
              }
            } catch {}
          }
          return { ...res, state: restored };
        }
        return res;
      }
      return cli.backupRouterProfile('');
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }, 'POST');

  app.api('/api/gpu', async (data, req) => {
    if (!isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const curGpuState = loadState();
    const lang = normalizeLang(curGpuState?.uiLanguage, 'en');
    try {
      const mod = await getLocalGpuMod();
      if (!mod) return { ok: false, error: pickLang(lang, 'Модуль GPU недоступен', 'Local GPU module unavailable') };
      const action = data?.action || 'status';
      if (action === 'unload' || action === 'warm' || action === 'enforce_cap' || action === 'warm_host_ram') {
        gpuStatusPanelCache.ts = 0;
      }
      const fetchFreshGpuSnap = async () => {
        const snap = await mod.getGpuStatusSnapshot({ force: true });
        if (snap) Object.assign(gpuStatusPanelCache, { ts: Date.now(), value: snap });
        return snap;
      };
      if (action === 'enforce_cap') {
        const res = typeof mod.enforceVramCapInOllama === 'function' ? await mod.enforceVramCapInOllama() : { ok: true, unloaded: [] };
        const snap = await fetchFreshGpuSnap();
        return { ...res, gpu: snap };
      }
      if (action === 'warm_host_ram') {
        const res = typeof mod.warmGgufModelsInHostRam === 'function'
          ? await mod.warmGgufModelsInHostRam({ force: true })
          : { ok: false, skippedReason: 'unavailable' };
        const snap = await fetchFreshGpuSnap();
        return { ...res, gpu: snap };
      }
      if (action === 'pull_status') {
        const pullStatus = typeof mod.getGpuPullJobStatus === 'function' ? mod.getGpuPullJobStatus() : null;
        return { ok: true, pullStatus };
      }
      if (action === 'pull_cancel') {
        const pullStatus = typeof mod.cancelGpuPullJob === 'function' ? mod.cancelGpuPullJob() : null;
        gpuStatusPanelCache.ts = 0;
        return { ok: true, pullStatus };
      }
      if (action === 'pull_cascade') {
        const snap = await fetchFreshGpuSnap();
        const curState = loadState();
        const hwMod = await getHardwareProfilerMod();
        const hwProfile = hwMod?.getHardwareProfile
          ? await hwMod.getHardwareProfile({ pluginRoot: join(__dirname, '..', '..'), force: false, subscriptionTier: curState.subscriptionTier === 'ultra' ? 'ultra' : 'pro' }).catch(() => null)
          : null;
        const totalVramMb = Number(data?.totalVramMb) || Number(snap?.hardware?.totalMb) || Number(hwProfile?.gpu?.totalMb) || 0;
        const selectedCapMb = Number(data?.selectedCapMb) || Number(curState.gpuMaxVramMb) || 4096;
        const pullMode = data?.mode === 'active_only' ? 'active_only' : 'cascade';
        const downloadedModels = snap?.ollama?.downloadedModels || [];
        const bundle = hwMod?.buildGpuCascadeBundleForHardware
          ? hwMod.buildGpuCascadeBundleForHardware(totalVramMb, { mode: pullMode, selectedCapMb, downloadedModels })
          : { mode: pullMode, models: [], missingModels: [] };
        const safeModelsOverride = Array.isArray(data?.models)
          ? data.models.map((m) => String(m || '').trim()).filter((m) => /^[a-z0-9._:/-]{2,128}$/i.test(m)).slice(0, 8)
          : [];
        const targetModels = safeModelsOverride.length > 0 ? safeModelsOverride : bundle.models.map((m) => m.name);
        const pullStatus = typeof mod.startGpuCascadePull === 'function'
          ? await mod.startGpuCascadePull({
              models: targetModels,
              mode: pullMode,
              totalVramMb,
              selectedCapMb,
              installedTags: downloadedModels.map((m) => m.name),
              lang: normalizeLang(curState?.uiLanguage, lang),
            })
          : null;
        gpuStatusPanelCache.ts = 0;
        return { ok: true, bundle, pullStatus, gpu: snap };
      }
      if (action === 'unload') {
        const u = await mod.unloadAllModels();
        const snap = await fetchFreshGpuSnap();
        return { ...u, gpu: snap };
      }
      if (action === 'warm') {
        const wsRoot = await resolveActiveWorkspaceForPanel(data?.rootDir);
        if (!isValidWorkspaceDir(wsRoot)) {
          return new Response(
            JSON.stringify({ ok: false, status: 400, error: pickLang(lang, 'Рабочая папка не найдена или недопустима', 'Workspace directory not found or invalid') }),
            {
              status: 400,
              contentType: 'application/json',
              headers: { 'Content-Type': 'application/json; charset=utf-8' },
            }
          );
        }
        const daemonRes = await postRamDaemonJson('/gpu/warm', { wsPath: wsRoot, maxNewFiles: 350 }, 90000);
        if (daemonRes && typeof daemonRes.ok === 'boolean' && daemonRes.ok) {
          const snap = await fetchFreshGpuSnap();
          return { ...daemonRes, gpu: snap, viaDaemon: true };
        }
        const { RamMemoryEngine } = await import('../../core/ram-memory-engine.mjs');
        const ram = new RamMemoryEngine();
        try {
          const ws = await ram.warmWorkspaceAsync(wsRoot, { startWatcher: false });
          if (!ws) return { ok: false, error: pickLang(lang, 'Рабочая папка не найдена', 'Workspace directory not found') };
          const idx = await mod.indexWorkspaceVectors(ws.absRoot, ws.files, { maxNewFiles: 350 });
          const snap = await fetchFreshGpuSnap();
          return { ...idx, gpu: snap, viaDaemon: false };
        } finally {
          ram.evict('all');
        }
      }
      if (action === 'test_distill') {
        const res = await mod.distillText({
          text: 'ERROR: TypeError: Cannot read properties of undefined (reading "port") at C:/app/server.js:42:11\n    at Module._compile (node:internal/modules/cjs/loader:1562:14)\nStack trace noise repeated 20 times.',
          query: pickLang(lang, 'Какая причина ошибки и в какой строке?', 'What is the root cause and line number?'),
          mode: 'error_log',
          maxOutputTokens: 160,
        });
        const snap = await fetchFreshGpuSnap();
        return { ...res, gpu: snap };
      }
      const snap = await fetchFreshGpuSnap();
      return { ok: true, gpu: snap };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }, 'POST');

  app.api('/api/hardware', async (data, req) => {
    if (!isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const curState = loadState();
    const lang = normalizeLang(curState?.uiLanguage, 'en');
    try {
      const mod = await getHardwareProfilerMod();
      if (!mod) return { ok: false, error: pickLang(lang, 'Модуль профилирования железа недоступен', 'Hardware profiler module unavailable') };
      const action = String(data?.action || 'scan');
      const subTier = data?.subscriptionTier === 'ultra' || curState.subscriptionTier === 'ultra' ? 'ultra' : 'pro';
      const force = action === 'scan' || action === 'rescan' || action === 'auto_apply' || Boolean(data?.force);
      const profile = await mod.getHardwareProfile({
        pluginRoot: join(__dirname, '..', '..'),
        force,
        subscriptionTier: subTier,
      });

      if (action === 'auto_apply') {
        const patch = {
          ...(profile?.recommendation?.recommendedPatch || {}),
          hardwareProfiled: true,
        };
        const next = saveState(patch);
        const promptText = mod.buildAiHardwareTuningPrompt(profile, next, { lang: normalizeLang(next?.uiLanguage, lang) });
        return { ok: true, state: next, hardwareProfile: profile, appliedPatch: patch, promptText };
      }

      if (action === 'model_search_prompt') {
        const gpuSnap = await safeGetGpuStatus({ force: true });
        const promptText = typeof mod.buildAiModelSearchPrompt === 'function'
          ? mod.buildAiModelSearchPrompt(profile, curState, gpuSnap, { lang })
          : mod.buildAiHardwareTuningPrompt(profile, curState, { lang });
        return { ok: true, hardwareProfile: profile, gpu: gpuSnap, promptText };
      }

      if (action === 'vram_fit_prompt') {
        const gpuSnap = await safeGetGpuStatus({ force: true });
        const promptText = typeof mod.buildVramFitModelPrompt === 'function'
          ? mod.buildVramFitModelPrompt(profile, curState, gpuSnap, { lang })
          : (typeof mod.buildAiModelSearchPrompt === 'function'
              ? mod.buildAiModelSearchPrompt(profile, curState, gpuSnap, { lang })
              : mod.buildAiHardwareTuningPrompt(profile, curState, { lang }));
        return { ok: true, isVramFitPrompt: true, hardwareProfile: profile, gpu: gpuSnap, promptText };
      }

      const promptText = mod.buildAiHardwareTuningPrompt(profile, curState, { lang });
      return { ok: true, hardwareProfile: profile, promptText };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }, 'POST');

  app.api('/api/hud', async (data, req) => {
    if (!isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const lang = normalizeLang(loadState()?.uiLanguage, 'en');
    try {
      const [hudMod, progMod] = await Promise.all([getFloatingHudMod(), getTaskProgressMod()]);
      if (!progMod) return { ok: false, error: pickLang(lang, 'Модуль прогресса задач недоступен', 'Task progress module unavailable') };
      const action = String(data?.action || 'status');
      // Плавающее окно Floating HUD отключено по решению пользователя: гарантируем его остановку
      if (hudMod?.stopFloatingHud) {
        hudMod.stopFloatingHud();
      }
      if (action === 'demo') {
        const progress = progMod.setExplicitTaskProgress({
          currentStep: 2,
          totalSteps: 4,
          percent: 55,
          stepTitle: pickLang(lang, 'Демо-прогресс в панели', 'Demo progress in panel'),
          status: 'running',
        });
        return { ok: true, floatingHud: { running: false, enabled: false }, taskProgress: progress };
      }
      if (action === 'start' || action === 'stop') {
        const next = saveState({ floatingHudEnabled: false });
        return { ok: true, state: next, floatingHud: { running: false, enabled: false }, taskProgress: progMod.getTaskProgressSnapshot() };
      }
      if (action === 'reset_stale' || action === 'dismiss_chat') {
        const progress = typeof progMod.dismissStaleChats === 'function'
          ? progMod.dismissStaleChats({
              conversationId: typeof data?.conversationId === 'string' ? data.conversationId : '',
              workspaceRoot: typeof data?.workspaceRoot === 'string' ? data.workspaceRoot : '',
            })
          : progMod.resetTaskProgress();
        return { ok: true, floatingHud: { running: false, enabled: false }, taskProgress: progress };
      }
      if (action === 'set_progress') {
        const progress = progMod.setExplicitTaskProgress({
          currentStep: data?.currentStep,
          totalSteps: data?.totalSteps,
          percent: data?.percent,
          stepTitle: data?.stepTitle,
          status: data?.status,
          steps: data?.steps,
        });
        return { ok: true, floatingHud: { running: false, enabled: false }, taskProgress: progress };
      }
      return { ok: true, floatingHud: { running: false, enabled: false }, taskProgress: progMod.getTaskProgressSnapshot() };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }, 'POST');

  let activeAutocompleteAbort = null;
  const chatMessageQueue = new Queue({
    maxSize: DEFAULT_CHAT_QUEUE_MAX_SIZE,
    maxAgeMs: 45000,
    taskTimeoutMs: 20000,
    parallelBatchSize: 4,
    autoProcess: true,
    onError: (err) => {
      console.warn('[sidecar/chat-queue] step error:', err?.message || err);
    },
  });
  const autocompleteGpuQueue = new Queue({
    maxSize: DEFAULT_CHAT_QUEUE_MAX_SIZE,
    maxAgeMs: 8000,
    taskTimeoutMs: 6800,
    parallelBatchSize: 2,
    autoProcess: true,
  });

  app.api('/api/autocomplete', async (data, req) => {
    if (!isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const seq = Number(data?.seq) || 0;
    try {
      const mode = String(data?.mode || 'suggest');
      const ctx = await getAutocompleteWorkspaceContext(data?.rootDir, {
        allowStaleWhileRevalidate: mode !== 'context',
      });
      if (mode === 'context') {
        return {
          ok: true,
          workspaceName: ctx.workspaceName,
          touchedFiles: ctx.touchedFiles,
          cascadeAlert: ctx.cascadeAlert || null,
          chips: ctx.chips,
          queue: autocompleteGpuQueue.getStats(),
          ctxQueue: getAutocompleteCtxRefreshQueue().getStats(),
        };
      }

      const draft = String(data?.draft || '').slice(0, 600);
      const scopedCtx = prioritizeContextForDraft(draft, ctx);
      const stage = data?.stage === 'fast' ? 'fast' : 'gpu';
      const curState = loadState();
      const autocompleteLang = normalizeLang(curState?.uiLanguage, 'en');
      const fastRes = computeFastRamAutocomplete(draft, { ...scopedCtx, lang: autocompleteLang });

      const verifyFastCandidate = async (candidateText) => {
        if (!candidateText) return '';
        const gpuModRef = panelRuntime.coreLocalGpu || (await getLocalGpuMod());
        if (typeof gpuModRef?.verifyGhostContinuationGrounding === 'function') {
          const vRes = gpuModRef.verifyGhostContinuationGrounding(draft, candidateText, {
            repoFiles: ctx.repoFiles || [],
            touchedFiles: ctx.touchedFiles || [],
            symbols: ctx.symbols || [],
            symbolsByFile: ctx.symbolsByFile || {},
            allowedSlashCommands: ALLOWED_SLASH_COMMANDS,
          });
          if (vRes && vRes.valid === false) return '';
        }
        return candidateText;
      };

      if (stage === 'fast' || curState.gpuEnabled === false) {
        const verifiedFast = await verifyFastCandidate(fastRes.continuation);
        return {
          ok: true,
          seq,
          continuation: verifiedFast,
          source: verifiedFast ? 'ram' : 'none',
          latencyMs: 1,
          chips: ctx.chips,
        };
      }

      if (activeAutocompleteAbort) {
        try { activeAutocompleteAbort.abort(); } catch {}
      }
      autocompleteGpuQueue.supersedePending(
        () => true,
        'AUTOCOMPLETE_SUPERSEDED',
        pickLang(autocompleteLang, 'Подсказка заменена более новым вводом', 'Suggestion superseded by newer input')
      );

      const ac = new AbortController();
      activeAutocompleteAbort = ac;

      const gpuRes = await autocompleteGpuQueue.enqueue(
        async ({ signal }) => {
          const onQueueAbort = () => {
            try { ac.abort(); } catch {}
          };
          if (signal) {
            if (signal.aborted) onQueueAbort();
            else signal.addEventListener('abort', onQueueAbort, { once: true });
          }
          try {
            if (ac.signal.aborted) {
              return { ok: false, aborted: true };
            }
            let ragRes = null;
            if (draft.trim().length >= 5) {
              ragRes = await postRamDaemonJson(
                '/ram/composer-rag',
                { wsPath: ctx.wsRoot || '', query: draft },
                800
              ).catch(() => null);
              if (ac.signal.aborted) {
                return { ok: false, aborted: true };
              }
            }

            const ragMatchedFiles = Array.isArray(ragRes?.matchedFiles)
              ? ragRes.matchedFiles.filter(Boolean)
              : [];
            const ragMatchedSymbols = Array.isArray(ragRes?.matchedSymbols)
              ? ragRes.matchedSymbols.filter(Boolean)
              : [];
            const ragSnippets = Array.isArray(ragRes?.ragSnippets)
              ? ragRes.ragSnippets.slice(0, 3)
              : [];

            const draftLower = draft.toLowerCase();
            const hasExplicitTargetTail =
              scopedCtx.matchedDirs.length > 0 ||
              Boolean(scopedCtx.cascadeAlert?.file) ||
              /(?:^|\s)(?:файл[аеуыов]*|модул[ьяюеией]*)\s*$/i.test(draft);
            const draftMatchingTouched = scopedCtx.touchedFiles.filter((f) => {
              const baseNoExt = basename(f).replace(/\.[^.]+$/, '').toLowerCase();
              const stems = baseNoExt.split(/[-_.]/).filter((s) => s.length >= 3);
              return (baseNoExt.length >= 3 && draftLower.includes(baseNoExt)) || stems.some((s) => draftLower.includes(s));
            });

            let mergedFiles = [...ragMatchedFiles];
            if (hasExplicitTargetTail) {
              mergedFiles = [...new Set([...ragMatchedFiles, ...scopedCtx.touchedFiles])].slice(0, 6);
            } else if (mergedFiles.length === 0 && draftMatchingTouched.length > 0) {
              mergedFiles = draftMatchingTouched.slice(0, 4);
            } else {
              mergedFiles = mergedFiles.slice(0, 6);
            }

            let symbolHints = ragMatchedSymbols.slice(0, 8);
            if (!ragRes && symbolHints.length === 0) {
              symbolHints = scopedCtx.symbols
                .filter((sym) => sym.length >= 4 && draftLower.includes(sym.toLowerCase().slice(0, Math.min(sym.length, 6))))
                .slice(0, 6);
            }

            const groundingRepoFiles = Array.isArray(ragRes?.repoFiles) && ragRes.repoFiles.length > 0
              ? ragRes.repoFiles
              : (ctx.repoFiles || []);
            const groundingRepoSymbols = Array.isArray(ragRes?.repoSymbols) && ragRes.repoSymbols.length > 0
              ? ragRes.repoSymbols
              : (ctx.symbols || []);
            const groundingSymbolsByFile =
              ragRes?.symbolsByFile && typeof ragRes.symbolsByFile === 'object' && Object.keys(ragRes.symbolsByFile).length > 0
                ? ragRes.symbolsByFile
                : (ctx.symbolsByFile || {});
            const groundingRepoTechTerms = Array.isArray(ragRes?.repoTechTerms) ? ragRes.repoTechTerms : [];

            const mod = await getLocalGpuMod();
            if (mod && typeof mod.generatePromptContinuation === 'function') {
              return await mod.generatePromptContinuation({
                draft,
                recentGoals: scopedCtx.recentGoals,
                touchedFiles: mergedFiles,
                symbolHints,
                ragSnippets,
                repoFiles: groundingRepoFiles,
                allRepoSymbols: groundingRepoSymbols,
                symbolsByFile: groundingSymbolsByFile,
                repoTechTerms: groundingRepoTechTerms,
                allowedSlashCommands: ALLOWED_SLASH_COMMANDS,
                lang: autocompleteLang,
                signal: ac.signal,
              });
            }
            return null;
          } finally {
            if (signal) {
              try { signal.removeEventListener('abort', onQueueAbort); } catch {}
            }
            if (activeAutocompleteAbort === ac) {
              activeAutocompleteAbort = null;
            }
          }
        },
        { label: `autocomplete#${seq}`, groupKey: 'autocomplete-gpu', maxAgeMs: 8000, timeoutMs: 6800 }
      );

      if (ac.signal.aborted || gpuRes?.aborted) {
        return { ok: false, aborted: true, seq, continuation: '' };
      }

      if (gpuRes && gpuRes.ok && gpuRes.continuation) {
        return {
          ok: true,
          seq,
          continuation: gpuRes.continuation,
          source: 'gpu',
          model: gpuRes.model || '',
          latencyMs: gpuRes.latencyMs || 0,
          fromRamCache: Boolean(gpuRes.fromRamCache),
          chips: ctx.chips,
          queue: autocompleteGpuQueue.getStats(),
        };
      }

      const gpuExplicitlySilenced = Boolean(
        gpuRes?.abstainedCompletedSentence ||
        gpuRes?.rejectedHallucination
      );
      const verifiedFallback = gpuExplicitlySilenced
        ? ''
        : await verifyFastCandidate(fastRes.continuation);
      return {
        ok: true,
        seq,
        continuation: verifiedFallback,
        source: verifiedFallback ? 'ram' : 'none',
        gpuFallbackReason: gpuRes?.rejectedHallucination || (gpuRes?.abstainedCompletedSentence ? 'completed_sentence' : (gpuRes?.error || '')),
        latencyMs: gpuRes?.latencyMs || 1,
        chips: ctx.chips,
        queue: autocompleteGpuQueue.getStats(),
      };
    } catch (err) {
      if (
        err?.code === 'AUTOCOMPLETE_SUPERSEDED' ||
        err?.code === 'QUEUE_OVERFLOW' ||
        err?.code === 'QUEUE_TASK_EXPIRED' ||
        err?.code === 'QUEUE_DISPOSED'
      ) {
        return { ok: false, aborted: true, seq, continuation: '' };
      }
      return { ok: false, error: err?.message || pickLang(normalizeLang(loadState()?.uiLanguage, 'en'), 'Ошибка автодополнения', 'Autocomplete failed'), continuation: '' };
    }
  }, 'POST');

  app.api('/api/chat-send', async (data, req) => {
    if (!isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const lang = normalizeLang(loadState()?.uiLanguage, 'en');
    try {
      const rawMessage = typeof data?.message === 'string' ? data.message.trim() : '';
      if (!rawMessage) {
        return { ok: false, code: 'EMPTY_MESSAGE', error: pickLang(lang, 'Пустой текст запроса', 'Prompt message is empty'), queue: chatMessageQueue.getStats() };
      }
      if (rawMessage.length > 32000) {
        return { ok: false, code: 'MESSAGE_TOO_LONG', error: pickLang(lang, 'Слишком длинный текст запроса', 'Prompt message is too long'), queue: chatMessageQueue.getStats() };
      }

      const rawCid = typeof data?.conversationId === 'string' ? data.conversationId.trim() : '';
      const groupKey = SAFE_SIDE_ID_RE.test(rawCid) ? rawCid : 'default';
      const result = await chatMessageQueue.enqueue(
        async () =>
          await dispatchChatMessageFromSidecar({
            message: rawMessage,
            conversationId: data?.conversationId,
            projectId: data?.projectId,
            workspaceUris: Array.isArray(data?.workspaceUris) ? data.workspaceUris : [],
            rootDir: typeof data?.rootDir === 'string' ? data.rootDir : '',
            title: typeof data?.title === 'string' ? data.title : '',
            allowNewConversation: data?.allowNewConversation !== false,
            lang,
          }),
        { label: 'chat-send', groupKey, maxAgeMs: 45000, timeoutMs: 20000 }
      );
      return {
        ...result,
        queue: chatMessageQueue.getStats(),
      };
    } catch (err) {
      return {
        ok: false,
        code: err?.code || 'CHAT_QUEUE_ERROR',
        dropped: Boolean(err?.dropped),
        error: err?.message || pickLang(lang, 'Ошибка отправки в чат', 'Failed to send chat message'),
        queue: chatMessageQueue.getStats(),
      };
    }
  }, 'POST');

  app.api('/api/local-chat', async (data, req) => {
    if (!isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const curLocalState = loadState();
    const lang = normalizeLang(curLocalState?.uiLanguage, 'en');
    try {
      const rawMessage = typeof data?.message === 'string' ? data.message.trim() : '';
      if (!rawMessage) {
        return { ok: false, code: 'EMPTY_MESSAGE', answer: '', error: pickLang(lang, 'Пустой текст запроса', 'Prompt message is empty') };
      }
      if (rawMessage.length > 12000) {
        return { ok: false, code: 'MESSAGE_TOO_LONG', answer: '', error: pickLang(lang, 'Слишком длинный текст запроса (макс. 12000 символов)', 'Prompt message is too long (max 12,000 chars)') };
      }

      const cleanMessages = Array.isArray(data?.messages)
        ? data.messages
            .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
            .slice(-10)
            .map((m) => ({
              role: m.role,
              content: m.content.trim().slice(0, 4000),
            }))
        : [];

      const wsRoot = await resolveActiveWorkspaceForPanel(typeof data?.rootDir === 'string' ? data.rootDir : '');
      const daemonRes = (process.env.TUNNEL_TEST_ISOLATE_INSTALLED === '1' || curLocalState.gpuEnabled === false)
        ? null
        : await postRamDaemonJson(
            '/gpu/chat',
            {
              wsPath: wsRoot,
              query: rawMessage,
              messages: cleanMessages,
              maxOutputTokens: data?.maxOutputTokens,
              lang,
            },
            60000
          );
      if (daemonRes && typeof daemonRes.ok === 'boolean') {
        return { ...daemonRes, viaDaemon: true };
      }

      const gpuMod = await getLocalGpuMod();
      if (!gpuMod || typeof gpuMod.runLocalProjectChat !== 'function') {
        return { ok: false, answer: '', error: pickLang(lang, 'Модуль локального GPU-движка недоступен', 'Local GPU engine module unavailable') };
      }
      const gpuCfg = typeof gpuMod.loadGpuConfig === 'function' ? gpuMod.loadGpuConfig(curLocalState) : null;
      if (gpuCfg && !gpuCfg.gpuEnabled) {
        return {
          ok: false,
          skippedGpuDisabled: true,
          answer: '',
          error: pickLang(lang, 'Локальный GPU-движок выключен в настройках', 'Local GPU engine is disabled in settings'),
          viaDaemon: false,
        };
      }

      const { RamMemoryEngine } = await import('../../core/ram-memory-engine.mjs');
      const ram = new RamMemoryEngine();
      try {
        const warmRes = await ram.warmWorkspaceAsync(wsRoot, { startWatcher: false });
        const ws = warmRes?.ok ? ram.ensureWarm(wsRoot) : null;
        if (!ws || !ws.files) {
          return { ok: false, answer: '', error: pickLang(lang, 'Рабочая папка проекта не найдена', 'Project workspace folder not found'), viaDaemon: false };
        }
        let effectiveQuery = rawMessage;
        if (cleanMessages.length > 0) {
          const carryTerms = [];
          const seenTerms = new Set();
          const lowerRaw = rawMessage.toLowerCase();
          for (const turn of cleanMessages.slice(-4)) {
            const text = String(turn?.content || '');
            const fileHits = text.match(/[A-Za-z0-9_./-]+\.(?:mjs|cjs|js|ts|tsx|jsx|json|md|html|css|py|go|rs)\b/g) || [];
            const codeHits = text.match(/\b(?:[a-z]+[A-Z][A-Za-z0-9_]*|[a-z]{2,}_[a-z0-9_]{2,})\b/g) || [];
            for (const term of [...fileHits, ...codeHits]) {
              const t = term.trim();
              const tl = t.toLowerCase();
              if (t.length >= 3 && !seenTerms.has(tl) && !lowerRaw.includes(tl)) {
                seenTerms.add(tl);
                carryTerms.push(t);
                if (carryTerms.length >= 6) break;
              }
            }
            if (carryTerms.length >= 6) break;
          }
          if (carryTerms.length > 0) {
            effectiveQuery = `${rawMessage} ${carryTerms.join(' ')}`;
          }
        }

        const hasBoundedIndexer = typeof gpuMod.indexWorkspaceVectors === 'function';
        if (gpuCfg?.gpuSemanticSearch !== false && hasBoundedIndexer) {
          await gpuMod.indexWorkspaceVectors(ws.absRoot, ws.files, { maxNewFiles: 20 }).catch(() => null);
        }
        const semRes = await ram.searchSemantic(ws.absRoot, effectiveQuery, {
          maxResults: 6,
          contextLines: 3,
          reindexMissing: !hasBoundedIndexer,
        });
        const hits = Array.isArray(semRes?.results) ? semRes.results : [];
        const packRes = typeof ram.buildGroundedChatPack === 'function'
          ? ram.buildGroundedChatPack(ws.absRoot, rawMessage, {
              messages: cleanMessages,
              maxChars: 8400,
              warmSemanticHits: hits,
            })
          : ram.getContextPack(ws.absRoot, rawMessage, {
              maxChars: 6800,
              warmSemanticHits: hits,
              toon: true,
            });
        const ragSources = [];
        const seenSrc = new Set();
        const combinedSources = [
          ...(Array.isArray(packRes?.sources) ? packRes.sources : []),
          ...hits,
        ];
        for (const h of combinedSources) {
          const rel = String(h?.file || '').trim();
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
        let repoFiles = Array.isArray(packRes?.repoFiles) ? packRes.repoFiles : [];
        let repoSymbols = Array.isArray(packRes?.repoSymbols) ? packRes.repoSymbols : [];
        if (repoFiles.length === 0 && ws.files instanceof Map) {
          repoFiles = Array.from(ws.files.keys()).slice(0, 500);
        }
        if (repoSymbols.length === 0 && ws.files instanceof Map) {
          const symSet = new Set();
          for (const entry of ws.files.values()) {
            for (const s of entry?.exportedSymbols || []) {
              if (typeof s === 'string' && s.length >= 3) symSet.add(s);
            }
            for (const sw of entry?.symbols || []) {
              if (typeof sw?.name === 'string' && sw.name.length >= 3) symSet.add(sw.name);
            }
            if (symSet.size >= 2500) break;
          }
          repoSymbols = Array.from(symSet).slice(0, 2500);
        }
        const chatRes = await gpuMod.runLocalProjectChat({
          query: rawMessage,
          messages: cleanMessages,
          ragContext: packRes?.formatted || semRes?.formatted || '',
          ragSources,
          verifiedManifest: packRes?.verifiedManifest || '',
          repoFiles,
          repoSymbols,
          symbolsByFile: packRes?.symbolsByFile && typeof packRes.symbolsByFile === 'object' ? packRes.symbolsByFile : {},
          fetchExtraSlicesFn: typeof ram.findSymbolSlicesFast === 'function'
            ? (syms) => ram.findSymbolSlicesFast(ws.absRoot, syms, { maxSlices: 3, maxLinesPerSlice: 38 })
            : null,
          workspaceName: basename(ws.absRoot),
          maxOutputTokens: data?.maxOutputTokens,
          lang,
        });
        return { ...chatRes, viaDaemon: false };
      } finally {
        ram.evict('all');
      }
    } catch (err) {
      const lang = normalizeLang(loadState()?.uiLanguage, 'en');
      return {
        ok: false,
        code: err?.code || 'LOCAL_CHAT_ERROR',
        answer: '',
        error: err?.message || pickLang(lang, 'Ошибка локального RAG-чата', 'Local RAG chat failed'),
      };
    }
  }, 'POST');

  app.api('/api/composer/at-suggest', async (data, req) => {
    if (!isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const curState = loadState();
    const lang = normalizeLang(curState?.uiLanguage, 'en');
    try {
      const wsRoot = await resolveActiveWorkspaceForPanel(typeof data?.rootDir === 'string' ? data.rootDir : '');
      const [repoMap, wiretapFaults, knowledgeSnap] = await Promise.all([
        safeGetCachedRepoMap(wsRoot, false).catch(() => null),
        safeGetWiretapFaults(wsRoot, curState),
        safeGetKnowledgeSnapshot(wsRoot, curState),
      ]);
      const filesIndex = Array.isArray(repoMap?.filesIndex) ? repoMap.filesIndex : [];
      const files = [];
      const symbols = [];
      for (const f of filesIndex.slice(0, 100)) {
        const rel = String(f?.file || f?.relPath || '').trim();
        if (rel) files.push(rel);
        const seenFileSyms = new Set();
        const symsWithRanges = Array.isArray(f?.symbolsWithRanges) ? f.symbolsWithRanges : [];
        for (const sw of symsWithRanges.slice(0, 12)) {
          const sName = String(sw?.name || '').trim();
          if (sName && !seenFileSyms.has(sName)) {
            seenFileSyms.add(sName);
            symbols.push({ name: sName, file: rel, line: Number(sw?.startLine || sw?.line || 0) });
          }
        }
        const exported = Array.isArray(f?.exportedSymbols) ? f.exportedSymbols : [];
        for (const expName of exported.slice(0, 12)) {
          const sName = String(expName || '').trim();
          if (sName && !seenFileSyms.has(sName)) {
            seenFileSyms.add(sName);
            symbols.push({ name: sName, file: rel, line: 0 });
          }
        }
        const legacySyms = Array.isArray(f?.symbols) ? f.symbols : [];
        for (const s of legacySyms.slice(0, 12)) {
          const sName = typeof s === 'string' ? s : String(s?.name || '').trim();
          if (sName && !seenFileSyms.has(sName)) {
            seenFileSyms.add(sName);
            symbols.push({ name: sName, file: rel, line: Number(s?.line || 0) });
          }
        }
      }
      if (files.length === 0 && wsRoot && existsSync(wsRoot)) {
        try {
          for (const d of readdirSync(wsRoot, { withFileTypes: true }).slice(0, 30)) {
            if (d.isFile() && /\.(?:mjs|js|ts|tsx|py|html|css|json|md)$/i.test(d.name)) {
              files.push(d.name);
            }
          }
        } catch {}
      }
      return buildComposerAtSuggestions({
        query: typeof data?.query === 'string' ? data.query : '',
        files,
        symbols,
        wiretapFaults,
        federatedPeers: knowledgeSnap?.peers || [],
        limit: Number(data?.limit || 10),
        lang,
      });
    } catch (err) {
      return { ok: false, items: [], error: err?.message || pickLang(lang, 'Ошибка загрузки @-подсказок', 'Failed to load @-suggestions') };
    }
  }, 'POST');

  app.api('/api/composer/vision', async (data, req) => {
    if (!isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const curState = loadState();
    const lang = normalizeLang(curState?.uiLanguage, 'en');
    try {
      const gpuMod = await getLocalGpuMod();
      if (!gpuMod || typeof gpuMod.analyzeUiScreenshotLocally !== 'function') {
        return { ok: false, error: pickLang(lang, 'Модуль мультимодального анализа недоступен', 'Multimodal vision module unavailable') };
      }
      return await gpuMod.analyzeUiScreenshotLocally({
        imageBase64: typeof data?.imageBase64 === 'string' ? data.imageBase64 : '',
        userHint: typeof data?.userHint === 'string' ? data.userHint : '',
        timeoutMs: Number(data?.timeoutMs || 18000),
        lang,
      });
    } catch (err) {
      return { ok: false, error: err?.message || pickLang(lang, 'Ошибка анализа скриншота', 'Screenshot analysis failed') };
    }
  }, 'POST');

  app.api('/api/composer/voice-structure', async (data, req) => {
    if (!isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const curState = loadState();
    const lang = normalizeLang(curState?.uiLanguage, 'en');
    try {
      const wsRoot = await resolveActiveWorkspaceForPanel(typeof data?.rootDir === 'string' ? data.rootDir : '');
      const gpuMod = await getLocalGpuMod();
      if (!gpuMod || typeof gpuMod.structureVoiceTranscriptLocally !== 'function') {
        return { ok: false, error: pickLang(lang, 'Модуль обработки голоса недоступен', 'Voice structuring module unavailable') };
      }
      const repoMap = await safeGetCachedRepoMap(wsRoot, false).catch(() => null);
      const workspaceFiles = Array.isArray(repoMap?.filesIndex)
        ? repoMap.filesIndex.slice(0, 20).map((f) => f?.file || f?.relPath).filter(Boolean)
        : [];
      return await gpuMod.structureVoiceTranscriptLocally({
        rawTranscript: typeof data?.rawTranscript === 'string' ? data.rawTranscript : '',
        workspaceFiles,
        lang,
      });
    } catch (err) {
      return { ok: false, error: err?.message || pickLang(lang, 'Ошибка структурирования текста', 'Text structuring failed') };
    }
  }, 'POST');

  app.api('/api/chat-queue', async (_data, req) => {
    if (!isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    return {
      ok: true,
      chatQueue: chatMessageQueue.getStats(),
      autocompleteQueue: autocompleteGpuQueue.getStats(),
    };
  }, 'GET');

  const server = await app.run();
  if (server) {
    attachSidecarSecurityMiddleware(server);
    securityMiddlewareActive = true;
    if (typeof server.once === 'function') {
      server.once('close', () => {
        chatMessageQueue.dispose();
        autocompleteGpuQueue.dispose();
      });
    }
  }
  return app;
}

if (isMainEntry() && SidecarApp) {
  let sidecarShutdownPromise = null;
  let activeSidecarApp = null;
  let hostWatchdog = null;
  const triggerSidecarExitCleanup = () => {
    if (sidecarShutdownPromise) return sidecarShutdownPromise;
    try { hostWatchdog?.stop(); } catch {}
    const forceTimer = setTimeout(() => process.exit(0), 2500);
    if (typeof forceTimer.unref === 'function') forceTimer.unref();
    sidecarShutdownPromise = Promise.allSettled([
      activeSidecarApp?.close ? activeSidecarApp.close() : Promise.resolve(),
      handleSidecarExitCleanup(),
    ])
      .catch(() => {})
      .finally(() => {
        clearTimeout(forceTimer);
        process.exit(0);
      });
    return sidecarShutdownPromise;
  };
  process.on('SIGINT', () => void triggerSidecarExitCleanup());
  process.on('SIGTERM', () => void triggerSidecarExitCleanup());
  process.on('SIGHUP', () => void triggerSidecarExitCleanup());
  process.on('SIGBREAK', () => void triggerSidecarExitCleanup());
  startSidecarPanel()
    .then((app) => {
      activeSidecarApp = app;
      if (app) {
        hostWatchdog = startSidecarHostWatchdog({
          onHostLost: () => {
            void triggerSidecarExitCleanup();
          },
        });
      }
    })
    .catch((err) => {
      console.error('[sidecar] Startup failed:', err?.message || err);
      process.exitCode = 1;
    });
}

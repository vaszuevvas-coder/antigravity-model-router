/**
 * @file server.mjs
 * @description Sidecar HTTP server entry, API routes, and public re-exports.
 */

import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { safeReadJsonSync, withFileLockSync } from '../../core/safe-json.mjs';
import { normalizeLang, pickLang } from '../../core/i18n.mjs';
import { getPricingPhaseStatus } from '../../core/model-profile.mjs';
import {
  applyPluginUpdate,
  checkForPluginUpdate,
  clearPluginUpdateStatus,
  getPluginUpdateStatus,
  isAllowedPluginDownloadUrl,
  readPluginMeta,
} from '../../core/plugin-updater.mjs';
import { loadPluginChangelog } from '../../core/changelog-parser.mjs';
import {
  appendDebugLog,
  buildDiagnosticBundle,
  clearDebugLog,
  formatDiagnosticBundleSummary,
  getDebugLogStatus,
  readDebugLogEntries,
  VALID_DEBUG_LOG_MODES,
} from '../../core/debug-logger.mjs';
import {
  buildProjectGraphPayload,
  buildFileSymbolGraphPayload,
  parseGitChurnOutput,
  aggregateSemanticGraphHits,
} from '../../core/project-graph-builder.mjs';
import { attachSidecarSecurityMiddleware, getActiveSidecarRequest, isSafeCreatableFolderPath, isValidSidecarToken, isValidWorkspaceDir, startSidecarHostWatchdog, validateRequestOrigin } from './lib/panel-security.mjs';
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
  isEphemeralPanelCandidatePath,
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
  collectRoiTimeline,
  collectTelemetry,
  discoverUserProjectsForGraph,
  gpuStatusPanelCache,
  invalidateGuardPulseCache,
  mergeRamSavingsIntoTelemetry,
  primeGuardPulseShieldCache,
  resolveActiveWorkspaceForPanel,
  safeCheckCompaction,
  safeClearPitfalls,
  safeGetBayesianSummary,
  safeGetCircuitState,
  safeGetCpuStatus,
  safeGetGpuStatus,
  safeGetGuardPulse,
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
  isSafeCreatableFolderPath,
  isValidSidecarToken,
  isValidWorkspaceDir,
  isAllowedLoopbackHost,
  validateRequestOrigin,
  attachSidecarSecurityMiddleware,
  getActiveSidecarRequest,
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
  discoverUserProjectsForGraph,
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
      return new FallbackResponse(JSON.stringify(data), {
        status,
        contentType: 'application/json; charset=utf-8',
      });
    }
    static error(message, status = 500) {
      return new FallbackResponse(JSON.stringify({ ok: false, error: message }), {
        status,
        contentType: 'application/json; charset=utf-8',
      });
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
  return '4.0.9';
}

const PANEL_SERVER_STARTED_AT = Date.now();
const PANEL_LOADED_VERSION = getPluginVersion();

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
  const resolveUpdaterRoot = () => (
    typeof options?.pluginRoot === 'string' && options.pluginRoot.trim()
      ? resolve(options.pluginRoot.trim())
      : join(__dirname, '..', '..')
  );
  const logServerErr = (event, err, level = 'warn') => {
    try {
      appendDebugLog({
        level,
        source: 'panel-server',
        event,
        message: err?.message || String(err || event),
      }, { pluginRoot: resolveUpdaterRoot() });
    } catch {}
  };
  const clampFiniteInt = (raw, min, max, fallback) => {
    const n = Number(raw);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : fallback;
  };
  const AppCtor = options?.SidecarAppClass || SidecarApp;
  if (!AppCtor) return null;
  let app = null;
  try {
    app = new AppCtor();
  } catch (err) {
    logServerErr('sidecar_app_init_failed', err, 'error');
    return null;
  }
  let securityMiddlewareActive = false;
  let activeHttpServer = null;
  const resolveReq = (req) => req || getActiveSidecarRequest() || null;
  const hasRequestContext = (req) => Boolean(resolveReq(req));
  const ensureMethodReq = (req, expectedMethod = '') => {
    if (!req || typeof req !== 'object') return req;
    const method = String(expectedMethod || req.method || 'POST').toUpperCase();
    return req.method === method ? req : { ...req, method };
  };
  const isRouteAuthorized = (req, authOpts = {}) => {
    const activeReq = resolveReq(req);
    return activeReq
      ? validateRequestOrigin(ensureMethodReq(activeReq, authOpts?.method), {
          enforceGetOrigin: true,
          expectedToken: options?.expectedToken,
          allowAuthCodeExchange: Boolean(authOpts?.allowAuthCodeExchange),
        })
      : securityMiddlewareActive;
  };

  let uiHtmlCache = { key: '', html: '' };
  const servePanelHtmlPage = () => {
    try {
      const st = statSync(UI_HTML_PATH);
      const cacheKey = `${Math.round(st.mtimeMs)}-${st.size}`;
      if (uiHtmlCache.key !== cacheKey || !uiHtmlCache.html) {
        uiHtmlCache = { key: cacheKey, html: readFileSync(UI_HTML_PATH, 'utf-8') };
      }
      return new Response(uiHtmlCache.html, {
        contentType: 'text/html; charset=utf-8',
        headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
      });
    } catch (err) {
      logServerErr('serve_ui_html_failed', err, 'error');
      return new Response('<!doctype html><html><body><h1>Panel UI unavailable</h1></body></html>', {
        status: 503,
        contentType: 'text/html; charset=utf-8',
        headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
      });
    }
  };

  app.page('/', servePanelHtmlPage);
  app.page('/graph', servePanelHtmlPage);

  const GRAPH_ICON_PATH = join(__dirname, 'graph-icon.svg');
  const GRAPH_ICON_FALLBACK_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="2.2" stroke="#f04848" stroke-width="1.5"/><circle cx="3" cy="3.5" r="1.6" stroke="#f04848" stroke-width="1.4"/><circle cx="13" cy="4" r="1.6" stroke="#f04848" stroke-width="1.4"/><circle cx="12.5" cy="12.5" r="1.6" stroke="#f04848" stroke-width="1.4"/><circle cx="3.5" cy="12.5" r="1.6" stroke="#f04848" stroke-width="1.4"/><path d="M4.2 4.6L6.4 6.6M11.7 5L9.7 6.8M9.6 9.5L11.4 11.3M6.3 9.5L4.6 11.4" stroke="#f04848" stroke-width="1.3" stroke-linecap="round"/></svg>';

  app.page('/graph-icon.svg', () => {
    let svg = GRAPH_ICON_FALLBACK_SVG;
    try {
      if (existsSync(GRAPH_ICON_PATH)) svg = readFileSync(GRAPH_ICON_PATH, 'utf-8');
    } catch (err) {
      logServerErr('serve_graph_icon_failed', err);
    }
    return new Response(svg, {
      contentType: 'image/svg+xml; charset=utf-8',
      headers: { 'Cache-Control': 'public, max-age=86400' },
    });
  });

  app.page('/favicon.ico', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="#0a84ff"/></svg>';
    return new Response(svg, {
      contentType: 'image/svg+xml; charset=utf-8',
      headers: { 'Cache-Control': 'public, max-age=86400' },
    });
  });

  function parseOpenWorkspacesFromRequest(data, req) {
    const activeReq = resolveReq(req);
    const out = [];
    const seen = new Set();
    const pushItem = (raw) => {
      const s = String(raw || '').trim();
      if (!s || seen.has(s)) return;
      seen.add(s);
      out.push(s);
    };
    if (Array.isArray(data?.openWorkspaces)) {
      for (const item of data.openWorkspaces) pushItem(item);
    } else if (typeof data?.openWorkspaces === 'string' && data.openWorkspaces.trim()) {
      for (const item of data.openWorkspaces.split('|')) pushItem(item);
    }
    const hdr = activeReq?.headers?.['x-open-workspaces'] || activeReq?.headers?.['X-Open-Workspaces'] || '';
    if (typeof hdr === 'string' && hdr.trim()) {
      let decoded = hdr;
      try { decoded = decodeURIComponent(hdr); } catch {}
      for (const item of decoded.split('|')) pushItem(item);
    }
    return out.slice(0, 24);
  }

  function parseActiveConversationIdFromRequest(data, req) {
    const activeReq = resolveReq(req);
    const fromData = typeof data?.activeConversationId === 'string' ? data.activeConversationId.trim() : '';
    if (fromData) return fromData.slice(0, 128);
    const hdr = activeReq?.headers?.['x-active-conversation-id'] || activeReq?.headers?.['X-Active-Conversation-Id'] || '';
    return typeof hdr === 'string' ? hdr.trim().slice(0, 128) : '';
  }

  function resolvePanelWorkspaceFromRequest(data, req, extraOpts = {}) {
    const rawReqRoot = typeof data?.rootDir === 'string' ? data.rootDir.trim() : '';
    const openWorkspaces = Array.isArray(extraOpts.openWorkspaces)
      ? extraOpts.openWorkspaces
      : parseOpenWorkspacesFromRequest(data, req);
    const activeConversationId = typeof extraOpts.activeConversationId === 'string'
      ? extraOpts.activeConversationId
      : parseActiveConversationIdFromRequest(data, req);
    return resolveActiveWorkspaceForPanel(rawReqRoot, {
      ...extraOpts,
      openWorkspaces,
      activeConversationId,
    });
  }

  let mcpStartupSynced = false;
  let hardwareCalibInFlight = null;
  let gpuVramPatchSeq = 0;
  let composerHandoffSeq = 0;
  let latestComposerHandoff = null;
  const COMPOSER_HANDOFF_TTL_MS = 60_000;

  function getActiveComposerHandoff() {
    if (!latestComposerHandoff) return null;
    if (Date.now() - latestComposerHandoff.ts > COMPOSER_HANDOFF_TTL_MS) {
      latestComposerHandoff = null;
      return null;
    }
    return latestComposerHandoff;
  }

  app.api('/api/composer/handoff', async (data, req) => {
    if (!isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const rawTokens = Array.isArray(data?.tokens) ? data.tokens : [];
    const tokens = rawTokens
      .map((t) => String(t || '').trim().slice(0, 512))
      .filter(Boolean)
      .slice(0, 32);
    const prompt = typeof data?.prompt === 'string' ? data.prompt.trim().slice(0, 6000) : '';
    const text = typeof data?.text === 'string' ? data.text.trim().slice(0, 8000) : '';
    if (tokens.length === 0 && !prompt && !text) {
      return { ok: false, error: 'Empty composer handoff payload' };
    }
    composerHandoffSeq += 1;
    latestComposerHandoff = {
      seq: composerHandoffSeq,
      tokens,
      prompt,
      text,
      ts: Date.now(),
    };
    return { ok: true, seq: composerHandoffSeq };
  }, 'POST');

  app.api('/api/state', async (data, req) => {
    if (hasRequestContext(req) && !isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    let state = loadState();
    const lang = normalizeLang(state?.uiLanguage, 'en');
    try {
      const panelPluginRoot = resolveUpdaterRoot();
      const isDevRepoDefaultState =
        !process.env.TUNNEL_TEST_STATE_PATH &&
        existsSync(join(panelPluginRoot, '.git')) &&
        resolve(resolvePanelStatePath()).toLowerCase() === resolve(STATE_PATH).toLowerCase();
      if (
        process.env.TUNNEL_TEST_ISOLATE_INSTALLED !== '1' &&
        !isDevRepoDefaultState &&
        state.onboardingCompleted === false &&
        state.hardwareProfiled !== true &&
        panelRuntime.hardwareProfilerSync?.ensureHardwareCalibratedOnce
      ) {
        try {
          if (!hardwareCalibInFlight) {
            hardwareCalibInFlight = Promise.resolve(
              panelRuntime.hardwareProfilerSync.ensureHardwareCalibratedOnce({
                pluginRoot: panelPluginRoot,
                statePath: resolvePanelStatePath(),
              })
            ).finally(() => {
              hardwareCalibInFlight = null;
            });
          }
          const cal = await hardwareCalibInFlight;
          if (cal?.calibrated && cal.state) {
            state = loadState();
            mcpStartupSynced = true;
          }
        } catch (err) {
          logServerErr('hardware_calib_once_failed', err);
        }
      }
      if (
        !mcpStartupSynced &&
        !process.env.TUNNEL_TEST_STATE_PATH &&
        process.env.TUNNEL_TEST_ISOLATE_INSTALLED !== '1' &&
        panelRuntime.hardwareProfilerSync?.syncMcpRamBudget
      ) {
        try {
          panelRuntime.hardwareProfilerSync.syncMcpRamBudget(panelPluginRoot, state.ramMaxBudgetMb || 4096, {
            resolveAbsoluteEntry: true,
            gpuEnabled: Boolean(state.gpuEnabled),
          });
          mcpStartupSynced = true;
        } catch (err) {
          logServerErr('mcp_startup_sync_failed', err);
        }
      }
      const rawReqRoot = typeof data?.rootDir === 'string' ? data.rootDir.trim() : '';
      const isAllScope = data?.workspaceScope === 'all' || rawReqRoot === '__all__';
      const isPinned = Boolean(rawReqRoot && rawReqRoot !== '__all__' && rawReqRoot !== '__auto__' && isValidWorkspaceDir(rawReqRoot));
      const openWorkspaces = parseOpenWorkspacesFromRequest(data, req);
      const activeConversationId = parseActiveConversationIdFromRequest(data, req);
      const hudPack = await safeGetHudAndProgressStatus(state, isPinned ? resolve(rawReqRoot) : '');
      const autoWs = await resolveActiveWorkspaceForPanel('', {
        taskProgress: hudPack.progress,
        openWorkspaces,
        activeConversationId,
      });
      const activeWs = isPinned ? resolve(rawReqRoot) : autoWs;
      const cpWs = resolveCheckpointScopeWs(data, activeWs);
      const sec = resolvePanelFetchSections(data, state, { endpoint: 'state' });
      const needHwProfile = sec.all || sec.hw || state.onboardingCompleted === false;
      const telemetry = collectTelemetry(state.compactionTokenThreshold || 120000, { workspaceRoot: activeWs });
      const [checkpoints, turnCheckpoints, shadowWorktrees, wiretapFaults, quotaPacer, circuitBreaker, compaction, pitfalls, bayesian, ramStatusForTelemetry, gpu, hardwareProfile, sentinel, knowledgeSnap] = await Promise.all([
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
        safeGetRamCacheStatus(state),
        sec.hw ? safeGetGpuStatus() : Promise.resolve(undefined),
        needHwProfile ? safeGetHardwareProfile(state, false) : Promise.resolve(undefined),
        fetchSentinelPanelStatus(activeWs, state),
        sec.pitfalls ? safeGetKnowledgeSnapshot(activeWs, state) : Promise.resolve(undefined),
      ]);
      const ramCache = sec.hw ? ramStatusForTelemetry : undefined;
      const knownWorkspaces = await collectKnownWorkspacesForPanel({
        activeWs,
        autoWs,
        openWorkspaces,
        taskProgress: hudPack.progress,
        ramCache: ramStatusForTelemetry,
      });
      const mergedTelemetry = ramStatusForTelemetry ? mergeRamSavingsIntoTelemetry(telemetry, ramStatusForTelemetry) : telemetry;
      const roiTimeline = collectRoiTimeline({
        currentTelemetry: mergedTelemetry,
        quotaPacer,
        workspaceRoot: activeWs,
      });
      const skills = sec.skills ? discoverSkills(activeWs) : undefined;
      const cpu = sec.hw ? safeGetCpuStatus(state, ramCache) : undefined;
      const guardPulse = await safeGetGuardPulse(activeWs, state, {
        sentinel,
        wiretapFaults,
        circuitBreaker,
        pitfalls,
        bayesian,
        gpu,
        ramCache,
        shadowWorktrees,
      });
      return {
        state,
        activeWorkspace: activeWs,
        autoWorkspace: autoWs,
        workspaceScope: isAllScope ? 'all' : (isPinned ? 'pinned' : 'auto'),
        knownWorkspaces,
        ...(skills !== undefined ? { skills } : {}),
        projectDetection: detectProjectProfile(activeWs),
        telemetry: mergedTelemetry,
        roiTimeline,
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
        guardPulse,
        ...(hardwareProfile !== undefined ? { hardwareProfile } : {}),
        hardwareCeilings: hardwareProfile?.hardwareCeilings || getRuntimeHardwareCeilings(),
        subscriptionCapabilities: getSubscriptionCapabilities(state?.subscriptionTier),
        pricingPhase: getPricingPhaseStatus(),
        floatingHud: hudPack.hud,
        taskProgress: hudPack.progress,
        pluginVersion: getPluginVersion(),
        uiBuildVersion: getUiBuildVersion(),
        debugLogStatus: getDebugLogStatus({ pluginRoot: resolveUpdaterRoot(), state }),
        includedSections: sec.included,
        deferredSections: sec.deferred,
      };
    } catch (err) {
      logServerErr('api_state_get_failed', err, 'error');
      return { ok: false, error: err?.message || pickLang(lang, 'Ошибка загрузки состояния панели', 'Failed to load panel state') };
    }
  }, 'GET');

  app.api('/api/telemetry', async (data, req) => {
    if (hasRequestContext(req) && !isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const state = loadState();
    const lang = normalizeLang(state?.uiLanguage, 'en');
    try {
      const rawReqRoot = typeof data?.rootDir === 'string' ? data.rootDir.trim() : '';
      const isAllScope = data?.workspaceScope === 'all' || rawReqRoot === '__all__';
      const isPinned = Boolean(rawReqRoot && rawReqRoot !== '__all__' && rawReqRoot !== '__auto__' && isValidWorkspaceDir(rawReqRoot));
      const openWorkspaces = parseOpenWorkspacesFromRequest(data, req);
      const activeConversationId = parseActiveConversationIdFromRequest(data, req);
      const hudPack = await safeGetHudAndProgressStatus(state, isPinned ? resolve(rawReqRoot) : '');
      const autoWs = await resolveActiveWorkspaceForPanel('', {
        taskProgress: hudPack.progress,
        openWorkspaces,
        activeConversationId,
      });
      const activeWs = isPinned ? resolve(rawReqRoot) : autoWs;
      const sec = resolvePanelFetchSections(data, state, { endpoint: 'telemetry' });
      const telemetry = collectTelemetry(state.compactionTokenThreshold || 120000, { workspaceRoot: activeWs });
      const [circuitBreaker, compaction, ramStatusForTelemetry, gpu, bayesian, sentinel, wiretapFaults, quotaPacer] = await Promise.all([
        sec.circuit ? safeGetCircuitState(activeWs) : Promise.resolve(undefined),
        sec.compaction
          ? safeCheckCompaction(telemetry.compactionThresholdTokens || state.compactionTokenThreshold || 120000, telemetry)
          : Promise.resolve(undefined),
        safeGetRamCacheStatus(state),
        sec.hw ? safeGetGpuStatus() : Promise.resolve(undefined),
        sec.bayesian ? safeGetBayesianSummary(activeWs) : Promise.resolve(undefined),
        fetchSentinelPanelStatus(activeWs, state),
        safeGetWiretapFaults(activeWs, state),
        safeGetQuotaForecast(state),
      ]);
      const ramCache = sec.hw ? ramStatusForTelemetry : undefined;
      const knownWorkspaces = await collectKnownWorkspacesForPanel({
        activeWs,
        autoWs,
        openWorkspaces,
        taskProgress: hudPack.progress,
        ramCache: ramStatusForTelemetry,
      });
      const mergedTelemetry = ramStatusForTelemetry ? mergeRamSavingsIntoTelemetry(telemetry, ramStatusForTelemetry) : telemetry;
      const roiTimeline = collectRoiTimeline({
        currentTelemetry: mergedTelemetry,
        quotaPacer,
        workspaceRoot: activeWs,
      });
      const cpu = sec.hw ? safeGetCpuStatus(state, ramCache) : undefined;
      const guardPulse = await safeGetGuardPulse(activeWs, state, {
        sentinel,
        wiretapFaults,
        circuitBreaker,
        bayesian,
        gpu,
        ramCache,
      });
      return {
        ok: true,
        activeWorkspace: activeWs,
        autoWorkspace: autoWs,
        workspaceScope: isAllScope ? 'all' : (isPinned ? 'pinned' : 'auto'),
        knownWorkspaces,
        projectDetection: detectProjectProfile(activeWs),
        telemetry: mergedTelemetry,
        roiTimeline,
        wiretapFaults,
        quotaPacer,
        ...(circuitBreaker !== undefined ? { circuitBreaker } : {}),
        ...(compaction !== undefined ? { compaction } : {}),
        ...(ramCache !== undefined ? { ramCache } : {}),
        ...(gpu !== undefined ? { gpu } : {}),
        ...(cpu !== undefined ? { cpu } : {}),
        sentinel,
        guardPulse,
        hardwareCeilings: getRuntimeHardwareCeilings(),
        ...(bayesian !== undefined ? { bayesian } : {}),
        floatingHud: hudPack.hud,
        taskProgress: hudPack.progress,
        composerHandoff: getActiveComposerHandoff(),
        pricingPhase: getPricingPhaseStatus(),
        pluginVersion: getPluginVersion(),
        uiBuildVersion: getUiBuildVersion(),
        includedSections: sec.included,
        ts: Date.now(),
      };
    } catch (err) {
      logServerErr('api_telemetry_failed', err);
      return { ok: false, error: err?.message || pickLang(lang, 'Ошибка сбора телеметрии', 'Failed to collect telemetry') };
    }
  }, 'GET');

  app.api('/api/panel-sections', async (data, req) => {
    if (hasRequestContext(req) && !isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const state = loadState();
    const lang = normalizeLang(state?.uiLanguage, 'en');
    try {
      const rawReqRoot = typeof data?.rootDir === 'string' ? data.rootDir.trim() : '';
      const isAllScope = data?.workspaceScope === 'all' || rawReqRoot === '__all__';
      const activeWs = await resolvePanelWorkspaceFromRequest(data, req);
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
    } catch (err) {
      logServerErr('api_panel_sections_failed', err);
      return { ok: false, error: err?.message || pickLang(lang, 'Ошибка загрузки секций панели', 'Failed to load panel sections') };
    }
  }, 'GET');

  const handleStateUpdate = async (data, req) => {
    const activeReq = resolveReq(req);
    if (!isRouteAuthorized(activeReq)) {
      return { ok: false, status: 403, error: 'Forbidden origin' };
    }
    const lang = normalizeLang(loadState()?.uiLanguage, 'en');
    try {
      let next = saveState(data);
      const rawReqRoot = typeof data?.rootDir === 'string' ? data.rootDir.trim() : '';
      const isFastUpdate =
        data?.fast === '1' ||
        data?.fast === true ||
        data?.fast === 'true' ||
        String(activeReq?.headers?.['x-panel-fast-update'] || '') === '1';
      const canUseFastPath = Boolean(
        isFastUpdate &&
        !data?.skillModes &&
        !data?.replaceSkillModes
      );
      const patchKeys = data && typeof data === 'object' ? Object.keys(data) : [];
      const hasGpuPatch = patchKeys.some((k) => k.startsWith('gpu'));
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
        const myVramSeq = ++gpuVramPatchSeq;
        try {
          const gpuMod = await getLocalGpuMod();
          if (next.gpuEnabled === false) {
            if (myVramSeq === gpuVramPatchSeq && gpuMod?.unloadAllModels) {
              await gpuMod.unloadAllModels().catch(() => {});
            }
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
              if (myVramSeq === gpuVramPatchSeq) {
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
            }
            if (myVramSeq === gpuVramPatchSeq && gpuMod?.enforceVramCapInOllama) {
              capEnforcement = await gpuMod.enforceVramCapInOllama({ cfgOverride: next }).catch(() => null);
              if (
                myVramSeq === gpuVramPatchSeq &&
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
        } catch (err) {
          logServerErr('gpu_vram_enforce_failed', err);
        }
        gpuStatusPanelCache.ts = 0;
      } else if (hasGpuPatch) {
        gpuStatusPanelCache.ts = 0;
      }
      const hasSentinelPatch = patchKeys.some((k) => k.startsWith('sentinel')) || Boolean(data && typeof data === 'object' && Object.hasOwn(data, 'hookProfile'));
      if (hasSentinelPatch) {
        sentinelPanelCache.ts = 0;
      }
      const touchesEnvDoctorSettings = Boolean(
        data &&
        typeof data === 'object' &&
        (
          Object.hasOwn(data, 'gpuEnabled') ||
          Object.hasOwn(data, 'gpuMaxVramMb') ||
          Object.hasOwn(data, 'gpuChatModel') ||
          Object.hasOwn(data, 'gpuEmbedModel') ||
          Object.hasOwn(data, 'ramCacheEnabled') ||
          Object.hasOwn(data, 'ramMaxBudgetMb') ||
          Object.hasOwn(data, 'shadowWorktreeEnabled')
        )
      );
      if (touchesEnvDoctorSettings) {
        invalidateGuardPulseCache('', ['env']);
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

      if (canUseFastPath) {
        const hasRamOrCpuPatch = patchKeys.some(
          (k) => k.startsWith('ram') || k.startsWith('cpu') || k === 'hookProfile' || k === 'lspBridgeEnabled'
        );
        const [gpu, sentinel, ramCache] = await Promise.all([
          hasGpuPatch ? safeGetGpuStatus({ force: true }) : Promise.resolve(undefined),
          hasSentinelPatch
            ? resolvePanelWorkspaceFromRequest(data, req).then((ws) => fetchSentinelPanelStatus(ws, next, { force: true }))
            : Promise.resolve(undefined),
          hasRamOrCpuPatch ? safeGetRamCacheStatus(next) : Promise.resolve(undefined),
        ]);
        const cpu = hasRamOrCpuPatch ? safeGetCpuStatus(next, ramCache) : undefined;
        return {
          ok: true,
          fast: true,
          state: next,
          ...(gpu !== undefined ? { gpu } : {}),
          ...(capEnforcement ? { capEnforcement } : {}),
          ...(sentinel !== undefined ? { sentinel } : {}),
          ...(ramCache !== undefined ? { ramCache } : {}),
          ...(cpu !== undefined ? { cpu } : {}),
          subscriptionCapabilities: getSubscriptionCapabilities(next?.subscriptionTier),
          pluginVersion: getPluginVersion(),
          uiBuildVersion: getUiBuildVersion(),
        };
      }

      const isAllScope = data?.workspaceScope === 'all' || rawReqRoot === '__all__';
      const isPinned = Boolean(rawReqRoot && rawReqRoot !== '__all__' && rawReqRoot !== '__auto__' && isValidWorkspaceDir(rawReqRoot));
      const openWorkspaces = parseOpenWorkspacesFromRequest(data, req);
      const activeConversationId = parseActiveConversationIdFromRequest(data, req);
      const autoWs = await resolveActiveWorkspaceForPanel('', { openWorkspaces, activeConversationId });
      const activeWs = isPinned ? resolve(rawReqRoot) : autoWs;
      const cpWs = resolveCheckpointScopeWs(data, activeWs);
      const telemetry = collectTelemetry(next.compactionTokenThreshold || 120000, { workspaceRoot: activeWs });
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
        openWorkspaces,
        taskProgress: hudPack.progress,
        ramCache,
      });
      const mergedTelemetry = mergeRamSavingsIntoTelemetry(telemetry, ramCache);
      const roiTimeline = collectRoiTimeline({
        currentTelemetry: mergedTelemetry,
        quotaPacer,
        workspaceRoot: activeWs,
      });
      const guardPulse = await safeGetGuardPulse(activeWs, next, {
        sentinel,
        wiretapFaults,
        circuitBreaker,
        pitfalls,
        bayesian,
        gpu,
        ramCache,
        shadowWorktrees,
      });
      return {
        state: next,
        activeWorkspace: activeWs,
        autoWorkspace: autoWs,
        workspaceScope: isAllScope ? 'all' : (isPinned ? 'pinned' : 'auto'),
        knownWorkspaces,
        skills: discoverSkills(activeWs),
        projectDetection: detectProjectProfile(activeWs),
        telemetry: mergedTelemetry,
        roiTimeline,
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
        guardPulse,
        hardwareProfile,
        hardwareCeilings: hardwareProfile?.hardwareCeilings || getRuntimeHardwareCeilings(),
        subscriptionCapabilities: getSubscriptionCapabilities(next?.subscriptionTier),
        floatingHud: hudPack.hud,
        taskProgress: hudPack.progress,
        debugLogStatus: getDebugLogStatus({ pluginRoot: resolveUpdaterRoot(), state: next }),
        pricingPhase: getPricingPhaseStatus(),
        pluginVersion: getPluginVersion(),
        uiBuildVersion: getUiBuildVersion(),
      };
    } catch (err) {
      logServerErr('api_state_post_failed', err, 'error');
      return { ok: false, error: err?.message || pickLang(lang, 'Ошибка обновления настроек панели', 'Failed to update panel settings') };
    }
  };

  app.api('/api/state', handleStateUpdate, 'POST');
  app.api('/api/update', handleStateUpdate, 'POST');

  app.api('/api/sentinel', async (data, req) => {
    if (!isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    try {
      sentinelPanelCache.ts = 0;
      const wsRoot = await resolvePanelWorkspaceFromRequest(data, req);
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
      logServerErr('api_sentinel_failed', err);
      const lang = normalizeLang(loadState()?.uiLanguage, 'en');
      return { ok: false, error: err?.message || pickLang(lang, 'Ошибка выполнения Фонового Дозора', 'Background Sentinel execution failed') };
    }
  }, 'POST');

  app.api('/api/rollback', async (data, req) => {
    if (!isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const lang = normalizeLang(loadState()?.uiLanguage, 'en');
    try {
      const activeWs = await resolvePanelWorkspaceFromRequest(data, req);
      const cpWs = resolveCheckpointScopeWs(data, activeWs);
      return await safeRollbackCheckpoint(data?.checkpointId || 'latest', cpWs, { lang });
    } catch (err) {
      logServerErr('api_rollback_failed', err);
      return { ok: false, error: err?.message || pickLang(lang, 'Ошибка отката контрольной точки', 'Failed to rollback checkpoint') };
    }
  }, 'POST');

  app.api('/api/checkpoints/turns', async (data, req) => {
    if (hasRequestContext(req) && !isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const curState = loadState();
    const lang = normalizeLang(curState?.uiLanguage, 'en');
    try {
      const activeWs = await resolvePanelWorkspaceFromRequest(data, req);
      const cpWs = resolveCheckpointScopeWs(data, activeWs);
      const [turns, worktrees] = await Promise.all([
        safeListTurnCheckpoints(cpWs === '__all__' ? 20 : 15, cpWs),
        curState.shadowWorktreeEnabled !== false ? safeListShadowWorktrees(activeWs) : Promise.resolve([]),
      ]);
      return { ok: true, turns, worktrees };
    } catch (err) {
      logServerErr('api_checkpoints_turns_failed', err);
      return { ok: false, turns: [], worktrees: [], error: err?.message || pickLang(lang, 'Ошибка чтения снимков ходов', 'Failed to list turn checkpoints') };
    }
  }, 'GET');

  app.api('/api/checkpoints/turn-diff', async (data, req) => {
    if (!isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const lang = normalizeLang(loadState()?.uiLanguage, 'en');
    try {
      const activeWs = await resolvePanelWorkspaceFromRequest(data, req);
      const cpWs = resolveCheckpointScopeWs(data, activeWs);
      return await safeGetTurnDiffSummary(data?.turnId || 'latest', cpWs, { lang });
    } catch (err) {
      logServerErr('api_turn_diff_failed', err);
      return { ok: false, error: err?.message || pickLang(lang, 'Ошибка чтения diff хода', 'Failed to load turn diff') };
    }
  }, 'POST');

  app.api('/api/checkpoints/rollback-turn', async (data, req) => {
    if (!isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const lang = normalizeLang(loadState()?.uiLanguage, 'en');
    try {
      const activeWs = await resolvePanelWorkspaceFromRequest(data, req);
      const cpWs = resolveCheckpointScopeWs(data, activeWs);
      return await safeRollbackTurn(data?.turnId || 'latest', cpWs, { lang });
    } catch (err) {
      logServerErr('api_rollback_turn_failed', err);
      return { ok: false, error: err?.message || pickLang(lang, 'Ошибка отката хода', 'Failed to rollback turn') };
    }
  }, 'POST');

  app.api('/api/worktree/action', async (data, req) => {
    if (!isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const curState = loadState();
    const lang = normalizeLang(curState?.uiLanguage, 'en');
    try {
      const activeWs = await resolvePanelWorkspaceFromRequest(data, req);
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
    } catch (err) {
      logServerErr('api_worktree_action_failed', err);
      return { ok: false, error: err?.message || pickLang(lang, 'Ошибка операции Git-песочницы', 'Git sandbox action failed') };
    }
  }, 'POST');

  app.api('/api/wiretap/faults', async (data, req) => {
    if (hasRequestContext(req) && !isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const curState = loadState();
    const lang = normalizeLang(curState?.uiLanguage, 'en');
    try {
      const activeWs = await resolvePanelWorkspaceFromRequest(data, req);
      return { ok: true, faults: await safeGetWiretapFaults(activeWs, curState) };
    } catch (err) {
      logServerErr('api_wiretap_faults_failed', err);
      return { ok: false, faults: [], error: err?.message || pickLang(lang, 'Ошибка чтения журнала Wiretap', 'Failed to read Wiretap faults') };
    }
  }, 'GET');

  app.api('/api/wiretap/fault', async (data, req) => {
    if (!isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const curState = loadState();
    const lang = normalizeLang(curState?.uiLanguage, 'en');
    try {
      const activeWs = await resolvePanelWorkspaceFromRequest(data, req);
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
    } catch (err) {
      logServerErr('api_wiretap_ingest_failed', err);
      return { ok: false, error: err?.message || pickLang(lang, 'Ошибка регистрации сбоя Wiretap', 'Failed to ingest Wiretap fault') };
    }
  }, 'POST');

  app.api('/api/wiretap/clear', async (data, req) => {
    if (!isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const lang = normalizeLang(loadState()?.uiLanguage, 'en');
    try {
      const activeWs = await resolvePanelWorkspaceFromRequest(data, req);
      const mod = await getRuntimeWiretapMod();
      if (!mod) return { ok: false, error: pickLang(lang, 'Модуль Wiretap недоступен', 'Runtime Wiretap module unavailable') };
      return mod.clearWiretapFaults(activeWs);
    } catch (err) {
      logServerErr('api_wiretap_clear_failed', err);
      return { ok: false, error: err?.message || pickLang(lang, 'Ошибка очистки Wiretap', 'Failed to clear Wiretap faults') };
    }
  }, 'POST');

  app.api('/api/repomap', async (data, req) => {
    if (!isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const lang = normalizeLang(loadState()?.uiLanguage, 'en');
    try {
      const root = (typeof data?.rootDir === 'string' && data.rootDir.trim())
        ? data.rootDir.trim()
        : await resolvePanelWorkspaceFromRequest(data, req);
      if (!isValidWorkspaceDir(root)) {
        return { ok: false, status: 400, error: 'Invalid workspace directory' };
      }
      return await safeGetCachedRepoMap(root, true);
    } catch (err) {
      logServerErr('api_repomap_failed', err);
      return { ok: false, error: err?.message || pickLang(lang, 'Ошибка обновления карты репозитория', 'Failed to refresh RepoMap') };
    }
  }, 'POST');

  app.api('/api/circuit-reset', async (data, req) => {
    if (!isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const lang = normalizeLang(loadState()?.uiLanguage, 'en');
    try {
      const activeWs = await resolvePanelWorkspaceFromRequest(data, req);
      const res = await safeResetCircuitBreaker(activeWs);
      invalidateGuardPulseCache(activeWs, ['fast']);
      return res;
    } catch (err) {
      logServerErr('api_circuit_reset_failed', err);
      return { ok: false, error: err?.message || pickLang(lang, 'Ошибка сброса предохранителя', 'Failed to reset circuit breaker') };
    }
  }, 'POST');

  app.api('/api/bayesian-reset', async (data, req) => {
    if (!isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const lang = normalizeLang(loadState()?.uiLanguage, 'en');
    try {
      const activeWs = await resolvePanelWorkspaceFromRequest(data, req);
      const res = await safeResetBayesianPriors(activeWs, Boolean(data?.onlyFragility));
      invalidateGuardPulseCache(activeWs, ['fast']);
      return res;
    } catch (err) {
      logServerErr('api_bayesian_reset_failed', err);
      return { ok: false, error: err?.message || pickLang(lang, 'Ошибка сброса байесовской статистики', 'Failed to reset Bayesian priors') };
    }
  }, 'POST');

  app.api('/api/compact-digest', async (data, req) => {
    if (!isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const lang = normalizeLang(loadState()?.uiLanguage, 'en');
    try {
      return await safeTriggerManualCompactionDigest(data);
    } catch (err) {
      logServerErr('api_compact_digest_failed', err);
      return { ok: false, error: err?.message || pickLang(lang, 'Ошибка сборки дайджеста контекста', 'Failed to trigger compaction digest') };
    }
  }, 'POST');

  app.api('/api/pitfalls-clear', async (data, req) => {
    if (!isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const lang = normalizeLang(loadState()?.uiLanguage, 'en');
    try {
      const activeWs = await resolvePanelWorkspaceFromRequest(data, req);
      const res = await safeClearPitfalls(activeWs);
      invalidateGuardPulseCache(activeWs, ['fast']);
      return res;
    } catch (err) {
      logServerErr('api_pitfalls_clear_failed', err);
      return { ok: false, error: err?.message || pickLang(lang, 'Ошибка очистки журнала граблей', 'Failed to clear pitfalls') };
    }
  }, 'POST');

  app.api('/api/knowledge/recipes', async (data, req) => {
    if (!isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const lang = normalizeLang(loadState()?.uiLanguage, 'en');
    try {
      const activeWs = await resolvePanelWorkspaceFromRequest(data, req);
      const mod = await getKnowledgeHubMod();
      const hub = mod?.knowledgeHub;
      if (!hub) return { ok: false, error: 'Knowledge hub unavailable' };
      return { ok: true, recipes: hub.listVictoryRecipes(activeWs, 15), stats: hub.getStats(activeWs) };
    } catch (err) {
      logServerErr('api_knowledge_recipes_get_failed', err);
      return { ok: false, recipes: [], error: err?.message || pickLang(lang, 'Ошибка чтения рецептов побед', 'Failed to read victory recipes') };
    }
  }, 'GET');

  app.api('/api/knowledge/recipes', async (data, req) => {
    if (!isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const lang = normalizeLang(loadState()?.uiLanguage, 'en');
    try {
      const activeWs = await resolvePanelWorkspaceFromRequest(data, req);
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
    } catch (err) {
      logServerErr('api_knowledge_recipes_post_failed', err);
      return { ok: false, error: err?.message || pickLang(lang, 'Ошибка обновления рецептов побед', 'Failed to update victory recipes') };
    }
  }, 'POST');

  app.api('/api/knowledge/federation', async (data, req) => {
    if (!isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const lang = normalizeLang(loadState()?.uiLanguage, 'en');
    try {
      const activeWs = await resolvePanelWorkspaceFromRequest(data, req);
      const mod = await getKnowledgeHubMod();
      const hub = mod?.knowledgeHub;
      if (!hub) return { ok: false, error: 'Knowledge hub unavailable' };
      const normPeer = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
      const activeNorm = normPeer(resolve(activeWs));
      let targetPeers = null;
      if (Array.isArray(data?.peers)) {
        const seenPeers = new Set();
        targetPeers = [];
        for (const rawPeer of data.peers.slice(0, 24)) {
          if (typeof rawPeer !== 'string' || !rawPeer.trim()) continue;
          const candAbs = isAbsolute(rawPeer.trim()) ? resolve(rawPeer.trim()) : resolve(activeWs, rawPeer.trim());
          const candNorm = normPeer(candAbs);
          if (candNorm === activeNorm || seenPeers.has(candNorm)) continue;
          let isDir = false;
          try {
            isDir = existsSync(candAbs) && statSync(candAbs).isDirectory() && isValidWorkspaceDir(candAbs);
          } catch {
            isDir = false;
          }
          if (isDir) {
            seenPeers.add(candNorm);
            targetPeers.push(candAbs);
          }
        }
      }
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
          return {
            ok: false,
            error: pickLang(lang, 'Папка репозитория не найдена или совпадает с текущим проектом', 'Repository folder not found or matches current workspace'),
            peers: hub.getFederatedWorkspaces(activeWs),
            stats: hub.getStats(activeWs),
          };
        }
        const existing = hub.getFederatedWorkspaces(activeWs).map((p) => p.path);
        const candNorm = normPeer(candAbs);
        const alreadyLinked = existing.some((p) => normPeer(resolve(activeWs, p)) === candNorm);
        targetPeers = alreadyLinked ? existing : [...existing, candAbs];
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
    } catch (err) {
      logServerErr('api_knowledge_federation_failed', err);
      return { ok: false, error: err?.message || pickLang(lang, 'Ошибка обновления федерации репозиториев', 'Failed to update repository federation') };
    }
  }, 'POST');

  app.api('/api/shield', async (data, req) => {
    if (hasRequestContext(req) && !isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const lang = normalizeLang(loadState()?.uiLanguage, 'en');
    try {
      const activeWs = await resolvePanelWorkspaceFromRequest(data, req);
      const { auditAgentEnvironment } = await import('../../core/agent-shield.mjs');
      const includeGlobal = !(data?.workspaceOnly === '1' || data?.workspaceOnly === true || data?.workspaceOnly === 'true');
      const report = auditAgentEnvironment({ workspaceRoot: activeWs, includeGlobal, lang });
      primeGuardPulseShieldCache(activeWs, report);
      return report;
    } catch (err) {
      logServerErr('api_shield_failed', err);
      return { ok: false, error: err?.message || pickLang(lang, 'Ошибка аудита AgentShield', 'AgentShield audit failed') };
    }
  }, 'GET');

  app.api('/api/guard-pulse', async (data, req) => {
    if (hasRequestContext(req) && !isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const curState = loadState();
    const lang = normalizeLang(curState?.uiLanguage, 'en');
    try {
      const activeWs = await resolvePanelWorkspaceFromRequest(data, req);
      const force = data?.force === '1' || data?.force === true || data?.force === 'true';
      const [sentinel, wiretapFaults, gpu, ramCache, shadowWorktrees] = await Promise.all([
        fetchSentinelPanelStatus(activeWs, curState, { force }),
        safeGetWiretapFaults(activeWs, curState),
        safeGetGpuStatus(),
        safeGetRamCacheStatus(curState),
        curState.shadowWorktreeEnabled !== false ? safeListShadowWorktrees(activeWs) : Promise.resolve([]),
      ]);
      const guardPulse = await safeGetGuardPulse(activeWs, curState, {
        force,
        sentinel,
        wiretapFaults,
        gpu,
        ramCache,
        shadowWorktrees,
      });
      return { ok: true, guardPulse, sentinel, wiretapFaults };
    } catch (err) {
      logServerErr('api_guard_pulse_failed', err);
      return { ok: false, error: err?.message || pickLang(lang, 'Ошибка пульса защиты', 'Guard pulse failed') };
    }
  }, 'GET');

  app.api('/api/guard-audit', async (data, req) => {
    if (!isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const curState = loadState();
    const lang = normalizeLang(curState?.uiLanguage, 'en');
    const ALLOWED_SCOPES = new Set(['all', 'bugs', 'shield', 'instincts', 'risks', 'env']);
    const rawScope = typeof data?.scope === 'string' ? data.scope.trim().toLowerCase() : 'all';
    const scope = ALLOWED_SCOPES.has(rawScope) ? rawScope : 'all';
    try {
      const activeWs = await resolvePanelWorkspaceFromRequest(data, req);
      if (scope === 'all') {
        invalidateGuardPulseCache(activeWs);
      } else if (scope === 'shield') {
        invalidateGuardPulseCache(activeWs, ['shield']);
      } else if (scope === 'env') {
        invalidateGuardPulseCache(activeWs, ['env']);
      } else if (scope === 'instincts' || scope === 'risks') {
        invalidateGuardPulseCache(activeWs, ['fast']);
      }

      let sentinel = null;
      if (scope === 'all' || scope === 'bugs') {
        sentinelPanelCache.ts = 0;
        const actionPayload = {
          action: 'run_now',
          mode: 'all',
          force: true,
          wsPath: activeWs,
          cfgOverride: curState,
          lang,
        };
        const daemonRes = process.env.TUNNEL_TEST_ISOLATE_INSTALLED === '1'
          ? null
          : await postRamDaemonJson('/sentinel/action', actionPayload, 20000);
        if (daemonRes && daemonRes.ok) {
          sentinel = normalizeSentinelSnapshotPayload(daemonRes, curState);
        } else {
          const sentinelMod = await getBackgroundSentinelMod();
          let res = null;
          if (sentinelMod?.sentinel && typeof sentinelMod.sentinel.runAction === 'function') {
            res = await sentinelMod.sentinel.runAction(actionPayload);
          } else if (typeof sentinelMod?.runAction === 'function') {
            res = await sentinelMod.runAction(actionPayload);
          } else if (typeof sentinelMod?.runSentinelAction === 'function') {
            res = await sentinelMod.runSentinelAction(actionPayload);
          }
          sentinel = res
            ? normalizeSentinelSnapshotPayload(res, curState)
            : await fetchSentinelPanelStatus(activeWs, curState, { force: true });
        }
        Object.assign(sentinelPanelCache, {
          ts: Date.now(),
          wsKey: String(activeWs || ''),
          enabled: curState.sentinelEnabled !== false,
          shadowTests: Boolean(curState.sentinelShadowTests),
          value: sentinel,
        });
      } else {
        sentinel = await fetchSentinelPanelStatus(activeWs, curState);
      }

      const [wiretapFaults, gpu, ramCache, shadowWorktrees] = await Promise.all([
        safeGetWiretapFaults(activeWs, curState),
        safeGetGpuStatus({ force: scope === 'all' || scope === 'env' }),
        safeGetRamCacheStatus(curState),
        curState.shadowWorktreeEnabled !== false ? safeListShadowWorktrees(activeWs) : Promise.resolve([]),
      ]);

      const guardPulse = await safeGetGuardPulse(activeWs, curState, {
        force: scope === 'all',
        forceShield: scope === 'all' || scope === 'shield',
        forceEnv: scope === 'all' || scope === 'env',
        forceFast: scope === 'all' || scope === 'instincts' || scope === 'risks',
        sentinel,
        wiretapFaults,
        gpu,
        ramCache,
        shadowWorktrees,
      });
      return { ok: true, scope, guardPulse, sentinel, wiretapFaults, ts: Date.now() };
    } catch (err) {
      logServerErr('api_guard_audit_failed', err);
      return { ok: false, error: err?.message || pickLang(lang, 'Ошибка комплексной проверки защиты', 'Guard audit failed') };
    }
  }, 'POST');

  app.api('/api/setup-recommendations', async (data, req) => {
    if (hasRequestContext(req) && !isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const curState = loadState();
    const lang = normalizeLang(curState?.uiLanguage, 'en');
    try {
      const activeWs = await resolvePanelWorkspaceFromRequest(data, req);
      const { recommendProjectSetup } = await import('../../core/project-setup-recommender.mjs');
      return recommendProjectSetup({ workspaceRoot: activeWs, currentState: curState });
    } catch (err) {
      logServerErr('api_setup_recommendations_failed', err);
      return { ok: false, error: err?.message || pickLang(lang, 'Ошибка диагностики стека проекта', 'Setup Doctor analysis failed') };
    }
  }, 'GET');

  app.api('/api/setup-recommendations/apply', async (data, req) => {
    if (!isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const curState = loadState();
    const lang = normalizeLang(curState?.uiLanguage, 'en');
    try {
      const activeWs = await resolvePanelWorkspaceFromRequest(data, req);
      const kind = typeof data?.kind === 'string' ? data.kind.trim().toLowerCase() : '';
      const { recommendProjectSetup } = await import('../../core/project-setup-recommender.mjs');
      const rec = recommendProjectSetup({ workspaceRoot: activeWs, currentState: curState });
      let applied = false;
      let detail = '';

      let alreadyExists = false;
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
          withFileLockSync(outPath, () => {
            try {
              if (lstatSync(outPath).isSymbolicLink()) {
                throw new Error(pickLang(lang, 'Отказ перезаписи символической ссылки .agentignore', 'Refusing symlink overwrite for .agentignore'));
              }
            } catch (statErr) {
              if (statErr?.code !== 'ENOENT') throw statErr;
            }
            writeFileSync(outPath, '.env*\nsecrets/\n*.pem\n*.key\n', {
              encoding: 'utf8',
              flag: data?.overwrite ? 'w' : 'wx',
            });
          });
        } catch (wErr) {
          if (wErr?.code !== 'EEXIST') throw wErr;
          alreadyExists = true;
        }
        applied = true;
        detail = alreadyExists
          ? pickLang(lang, '.agentignore уже существует (без перезаписи)', '.agentignore already exists (not overwritten)')
          : pickLang(lang, 'Создан файл .agentignore (UTF-8)', 'Created .agentignore (UTF-8)');
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
        ...(kind === 'agentignore' ? { exists: true, alreadyExists } : {}),
        recommendation: freshRec,
        state: loadState(),
      };
    } catch (err) {
      logServerErr('api_setup_recommendations_apply_failed', err);
      return { ok: false, error: err?.message || pickLang(lang, 'Ошибка применения рекомендации Setup Doctor', 'Failed to apply Setup Doctor recommendation') };
    }
  }, 'POST');

  app.api('/api/health-doctor', async (data, req) => {
    if (hasRequestContext(req) && !isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const curState = loadState();
    const lang = normalizeLang(curState?.uiLanguage, 'en');
    try {
      const activeWs = await resolvePanelWorkspaceFromRequest(data, req);
      const { diagnoseRuntimeHealth } = await import('../../core/health-doctor.mjs');
      const [gpuStatus, ramStatus, worktrees] = await Promise.all([
        safeGetGpuStatus(),
        safeGetRamCacheStatus(curState),
        safeListShadowWorktrees(activeWs),
      ]);
      return diagnoseRuntimeHealth({
        workspaceRoot: activeWs,
        state: curState,
        gpuStatus,
        ramStatus,
        worktrees,
      });
    } catch (err) {
      logServerErr('api_health_doctor_failed', err);
      return { ok: false, error: err?.message || pickLang(lang, 'Ошибка Health-Doctor', 'Health-Doctor diagnostics failed') };
    }
  }, 'GET');

  app.api('/api/health-doctor/fix', async (data, req) => {
    if (!isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const curState = loadState();
    const lang = normalizeLang(curState?.uiLanguage, 'en');
    try {
      const activeWs = await resolvePanelWorkspaceFromRequest(data, req);
      const fixAction = typeof data?.fixAction === 'string' ? data.fixAction.trim() : 'fix_all';
      const { diagnoseRuntimeHealth, applyHealthDoctorFix } = await import('../../core/health-doctor.mjs');
      const [gpuStatus, ramStatus, worktrees] = await Promise.all([
        safeGetGpuStatus(),
        safeGetRamCacheStatus(curState),
        safeListShadowWorktrees(activeWs),
      ]);
      const fixRes = await applyHealthDoctorFix({
        fixAction,
        workspaceRoot: activeWs,
        state: curState,
        gpuStatus,
        ramStatus,
        worktrees,
        saveStateFn: (patch) => saveState(patch),
        startOllamaFn: async () => {
          const mod = await getLocalGpuMod();
          if (!mod || typeof mod.ensureOllamaRunning !== 'function') return { ok: false, error: 'GPU module unavailable' };
          gpuStatusPanelCache.ts = 0;
          return mod.ensureOllamaRunning();
        },
        warmRamFn: async (wsRoot) => {
          const targetWs = wsRoot || activeWs;
          const daemonRes = await postRamDaemonJson('/warm', { wsPath: targetWs }, 20000);
          if (daemonRes && daemonRes.ok) return daemonRes;
          const { RamMemoryEngine } = await import('../../core/ram-memory-engine.mjs');
          const ram = new RamMemoryEngine();
          try {
            const warmRes = ram.warmWorkspace(targetWs);
            const count = Number(warmRes?.filesLoaded || warmRes?.filesCached || 0);
            return { ok: true, filesLoaded: count, filesCached: count };
          } finally {
            try { ram.evict('all'); } catch {}
          }
        },
        pruneWorktreesFn: async (orphans) => {
          const mod = await getShadowWorktreeMod();
          if (!mod || typeof mod.discardShadowWorktree !== 'function') return { pruned: 0 };
          let pruned = 0;
          for (const ow of orphans) {
            try {
              const r = mod.discardShadowWorktree({ id: ow.id, workspaceRoot: activeWs, lang });
              if (r?.ok) pruned += 1;
            } catch (pruneErr) {
              logServerErr('health_doctor_prune_worktree_failed', pruneErr);
            }
          }
          return { pruned };
        },
      });
      if (!fixRes.ok) return fixRes;
      gpuStatusPanelCache.ts = 0;
      invalidateGuardPulseCache(activeWs, ['env']);
      const [freshGpu, freshRam, freshWts] = await Promise.all([
        safeGetGpuStatus(),
        safeGetRamCacheStatus(loadState()),
        safeListShadowWorktrees(activeWs),
      ]);
      const health = diagnoseRuntimeHealth({
        workspaceRoot: activeWs,
        state: loadState(),
        gpuStatus: freshGpu,
        ramStatus: freshRam,
        worktrees: freshWts,
      });
      return { ...fixRes, health, state: loadState() };
    } catch (err) {
      logServerErr('api_health_doctor_fix_failed', err);
      return { ok: false, error: err?.message || pickLang(lang, 'Ошибка авто-исправления Health-Doctor', 'Health-Doctor auto-fix failed') };
    }
  }, 'POST');

  app.api('/api/skills/search', async (data, req) => {
    if (!isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const lang = normalizeLang(loadState()?.uiLanguage, 'en');
    try {
      const activeWs = await resolvePanelWorkspaceFromRequest(data, req);
      const { searchSkillsCatalog } = await import('../../core/skill-registry-bridge.mjs');
      return await searchSkillsCatalog({
        query: typeof data?.query === 'string' ? data.query : '',
        workspaceRoot: activeWs,
        includeRemote: data?.includeRemote !== false,
        limit: clampFiniteInt(data?.limit, 1, 50, 8),
        lang,
      });
    } catch (err) {
      logServerErr('api_skills_search_failed', err);
      return { ok: false, error: err?.message || pickLang(lang, 'Ошибка поиска навыков', 'Skill search failed'), localMatches: [], remoteMatches: [] };
    }
  }, 'POST');

  app.api('/api/skills/import', async (data, req) => {
    if (!isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const lang = normalizeLang(loadState()?.uiLanguage, 'en');
    try {
      const activeWs = await resolvePanelWorkspaceFromRequest(data, req);
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
      logServerErr('api_skills_import_failed', err);
      return { ok: false, installed: false, error: err?.message || pickLang(lang, 'Ошибка карантинного импорта навыка', 'Skill quarantine import failed') };
    }
  }, 'POST');

  app.api('/api/instincts', async (data, req) => {
    if (hasRequestContext(req) && !isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const lang = normalizeLang(loadState()?.uiLanguage, 'en');
    try {
      const activeWs = await resolvePanelWorkspaceFromRequest(data, req);
      const mod = await getKnowledgeHubMod();
      const hub = mod?.knowledgeHub;
      if (!hub || typeof hub.listInstincts !== 'function') {
        return { ok: false, error: 'Knowledge hub unavailable', items: [] };
      }
      const includePromoted = data?.all === '1' || data?.all === true || data?.all === 'true';
      const listed = hub.listInstincts({ workspaceRoot: activeWs, includePromoted, minConfidence: 0.1, limit: 30 });
      return { ok: true, items: listed.items || [], stats: hub.getStats(activeWs) };
    } catch (err) {
      logServerErr('api_instincts_get_failed', err);
      return { ok: false, error: err?.message || pickLang(lang, 'Ошибка чтения инстинктов', 'Failed to read instincts'), items: [] };
    }
  }, 'GET');

  app.api('/api/instincts/promote', async (data, req) => {
    if (!isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const lang = normalizeLang(loadState()?.uiLanguage, 'en');
    try {
      const activeWs = await resolvePanelWorkspaceFromRequest(data, req);
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
      invalidateGuardPulseCache(activeWs, ['fast']);
      if (panelRuntime?.discoverSkillsCache) {
        panelRuntime.discoverSkillsCache.ts = 0;
      }
      const listed = hub.listInstincts({ workspaceRoot: activeWs, includePromoted: false, minConfidence: 0.1, limit: 30 });
      return { ...res, items: listed.items || [], stats: hub.getStats(activeWs) };
    } catch (err) {
      logServerErr('api_instincts_promote_failed', err);
      return { ok: false, error: err?.message || pickLang(lang, 'Ошибка повышения инстинкта в навык', 'Failed to promote instinct to skill') };
    }
  }, 'POST');

  app.api('/api/instincts/evolve-all', async (data, req) => {
    if (!isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const curState = loadState();
    const lang = normalizeLang(curState?.uiLanguage, 'en');
    try {
      const activeWs = await resolvePanelWorkspaceFromRequest(data, req);
      const mod = await getKnowledgeHubMod();
      const hub = mod?.knowledgeHub;
      if (!hub) return { ok: false, error: 'Knowledge hub unavailable' };
      const { evolveReadyInstincts } = await import('../../core/skill-crystallizer.mjs');
      const res = evolveReadyInstincts({
        workspaceRoot: activeWs,
        hub,
        lang,
      });
      invalidateGuardPulseCache(activeWs, ['fast']);
      if (panelRuntime?.discoverSkillsCache) {
        panelRuntime.discoverSkillsCache.ts = 0;
      }
      const listed = hub.listInstincts({ workspaceRoot: activeWs, includePromoted: false, minConfidence: 0.1, limit: 30 });
      const guardPulse = await safeGetGuardPulse(activeWs, curState, { forceFast: true });
      return {
        ...res,
        promotedCount: Array.isArray(res?.promoted) ? res.promoted.length : 0,
        items: listed.items || [],
        stats: hub.getStats(activeWs),
        guardPulse,
      };
    } catch (err) {
      logServerErr('api_instincts_evolve_all_failed', err);
      return { ok: false, error: err?.message || pickLang(lang, 'Ошибка пакетного создания навыков из инстинктов', 'Failed to evolve ready instincts') };
    }
  }, 'POST');

  app.api('/api/instincts/delete', async (data, req) => {
    if (!isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const lang = normalizeLang(loadState()?.uiLanguage, 'en');
    try {
      const activeWs = await resolvePanelWorkspaceFromRequest(data, req);
      const mod = await getKnowledgeHubMod();
      const hub = mod?.knowledgeHub;
      if (!hub || typeof hub.deleteInstinct !== 'function') {
        return { ok: false, error: 'Knowledge hub unavailable', items: [] };
      }
      const delRes = hub.deleteInstinct({
        id: typeof data?.id === 'string' ? data.id : '',
        workspaceRoot: activeWs,
      });
      invalidateGuardPulseCache(activeWs, ['fast']);
      const listed = hub.listInstincts({ workspaceRoot: activeWs, includePromoted: false, minConfidence: 0.1, limit: 30 });
      return { ...delRes, ok: Boolean(delRes?.ok), items: listed.items || [], stats: hub.getStats(activeWs) };
    } catch (err) {
      logServerErr('api_instincts_delete_failed', err);
      return { ok: false, error: err?.message || pickLang(lang, 'Ошибка удаления инстинкта', 'Failed to delete instinct'), items: [] };
    }
  }, 'POST');

  app.api('/api/knowledge/episodes', async (data, req) => {
    if (hasRequestContext(req) && !isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    try {
      const activeWs = await resolvePanelWorkspaceFromRequest(data, req);
      const mod = await getKnowledgeHubMod();
      const hub = mod?.knowledgeHub;
      if (!hub || typeof hub.searchSessionEpisodes !== 'function') {
        return { ok: false, error: 'Knowledge hub unavailable', items: [] };
      }
      const res = hub.searchSessionEpisodes({
        workspaceRoot: activeWs,
        query: typeof data?.query === 'string' ? data.query : '',
        limit: clampFiniteInt(data?.limit, 1, 100, 15),
      });
      return { ok: true, items: res.items || [], stats: hub.getStats(activeWs) };
    } catch (err) {
      logServerErr('api_knowledge_episodes_failed', err);
      const lang = normalizeLang(loadState()?.uiLanguage, 'en');
      return { ok: false, error: err?.message || pickLang(lang, 'Ошибка чтения эпизодов памяти', 'Failed to read memory episodes'), items: [] };
    }
  }, 'GET');

  app.api('/api/gates', async (data, req) => {
    if (hasRequestContext(req) && !isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    try {
      const activeWs = await resolvePanelWorkspaceFromRequest(data, req);
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
      logServerErr('api_gates_get_failed', err);
      const lang = normalizeLang(loadState()?.uiLanguage, 'en');
      return { ok: false, error: err?.message || pickLang(lang, 'Ошибка чтения GATES.md', 'Failed to read GATES.md') };
    }
  }, 'GET');

  app.api('/api/gates', async (data, req) => {
    if (!isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const lang = normalizeLang(loadState()?.uiLanguage, 'en');
    try {
      const activeWs = await resolvePanelWorkspaceFromRequest(data, req);
      const { initAcceptanceGatesMarkdown, parseAcceptanceGatesMarkdown } = await import('../../core/completion-gates.mjs');
      const initRes = initAcceptanceGatesMarkdown(activeWs, { overwrite: Boolean(data?.overwrite), lang });
      invalidateGuardPulseCache(activeWs, ['env']);
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
      logServerErr('api_gates_post_failed', err);
      return { ok: false, error: err?.message || pickLang(lang, 'Ошибка создания GATES.md', 'Failed to create GATES.md') };
    }
  }, 'POST');

  app.api('/api/quota/reset-cooldowns', async (_data, req) => {
    if (!isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const lang = normalizeLang(loadState()?.uiLanguage, 'en');
    try {
      const { clearExpiredComboCooldowns } = await import('../../core/quota-pacer.mjs');
      const cleared = clearExpiredComboCooldowns({ resetAll: true });
      const quotaPacer = await safeGetQuotaForecast(loadState());
      return { ok: true, cleared, quotaPacer };
    } catch (err) {
      logServerErr('api_quota_reset_cooldowns_failed', err);
      return { ok: false, error: err?.message || pickLang(lang, 'Ошибка сброса пауз Combo', 'Failed to reset Combo cooldowns') };
    }
  }, 'POST');

  app.api('/api/graph', async (data, req) => {
    if (hasRequestContext(req) && !isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const lang = normalizeLang(loadState()?.uiLanguage, 'en');
    try {
      const activeWs = await resolvePanelWorkspaceFromRequest(data, req);
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
      logServerErr('api_graph_failed', err);
      return { ok: false, error: err?.message || pickLang(lang, 'Ошибка построения графа архитектуры', 'Failed to build architecture graph') };
    }
  }, 'GET');

  const execFileAsync = promisify(execFile);
  const FALLBACK_GRAPH_TTL_MS = 30_000;
  const GIT_DIFF_TTL_MS = 15_000;
  const GIT_CHURN_TTL_MS = 60_000;
  const MAX_GRAPH_AUX_CACHE = 64;
  let fallbackGraphEntry = null;
  let fallbackGraphEvictTimer = null;
  let fallbackGraphInitPromise = null;
  let fallbackGraphInitWs = '';
  let fallbackGraphGen = 0;
  const gitDiffCache = new Map();
  const gitChurnCache = new Map();

  const setBoundedCacheEntry = (cacheMap, key, value, maxEntries = MAX_GRAPH_AUX_CACHE) => {
    if (!cacheMap || !key) return;
    if (cacheMap.has(key)) cacheMap.delete(key);
    cacheMap.set(key, value);
    while (cacheMap.size > maxEntries) {
      const oldestKey = cacheMap.keys().next().value;
      if (oldestKey === undefined) break;
      cacheMap.delete(oldestKey);
    }
  };

  const retireFallbackEntry = (entry) => {
    if (!entry) return;
    entry.retired = true;
    if (entry.activeUsers <= 0) {
      try { entry.engine?.evict?.('all'); } catch {}
    }
  };

  const clearFallbackGraphEvictTimer = () => {
    if (fallbackGraphEvictTimer) {
      clearTimeout(fallbackGraphEvictTimer);
      fallbackGraphEvictTimer = null;
    }
  };

  const scheduleFallbackGraphEvict = (entry) => {
    clearFallbackGraphEvictTimer();
    if (!entry || entry.retired || fallbackGraphEntry !== entry) return;
    const elapsed = Math.max(0, Date.now() - entry.updatedAt);
    const delayMs = Math.max(50, FALLBACK_GRAPH_TTL_MS - elapsed);
    fallbackGraphEvictTimer = setTimeout(() => {
      fallbackGraphEvictTimer = null;
      if (fallbackGraphEntry === entry && entry.activeUsers <= 0 && (Date.now() - entry.updatedAt >= FALLBACK_GRAPH_TTL_MS)) {
        fallbackGraphEntry = null;
        retireFallbackEntry(entry);
      }
    }, delayMs);
    fallbackGraphEvictTimer.unref?.();
  };

  const acquireFallbackEntryHandle = (entry) => {
    entry.activeUsers += 1;
    entry.updatedAt = Date.now();
    clearFallbackGraphEvictTimer();
    let released = false;
    return {
      engine: entry.engine,
      ephemeral: false,
      release: () => {
        if (released) return;
        released = true;
        entry.activeUsers = Math.max(0, entry.activeUsers - 1);
        if (entry.retired && entry.activeUsers <= 0) {
          try { entry.engine?.evict?.('all'); } catch {}
        } else if (!entry.retired && fallbackGraphEntry === entry && entry.activeUsers <= 0) {
          scheduleFallbackGraphEvict(entry);
        }
      },
    };
  };

  const shouldBypassHostDaemonForGraph = (wsPath) =>
    process.env.TUNNEL_TEST_ISOLATE_INSTALLED === '1' || isEphemeralPanelCandidatePath(wsPath);

  const loadFragileFileMap = async (activeWs) => {
    const fragileMap = new Map();
    try {
      const bayesianSummary = await safeGetBayesianSummary(activeWs);
      const fList = Array.isArray(bayesianSummary?.fragileFiles) ? bayesianSummary.fragileFiles : [];
      for (const f of fList) {
        if (f?.file) {
          const normFile = String(f.file).replace(/\\/g, '/');
          fragileMap.set(normFile, {
            reliabilityPercent: Number(f.reliabilityPercent ?? 100),
            runs: Number(f.runs || 0),
            failures: Number(f.failures || 0),
          });
        }
      }
    } catch {}
    return fragileMap;
  };

  const getOrCreateFallbackGraphEngine = async (activeWs, { forceRefresh = false } = {}) => {
    if (shouldBypassHostDaemonForGraph(activeWs)) {
      const { RamMemoryEngine } = await import('../../core/ram-memory-engine.mjs');
      const ephEngine = new RamMemoryEngine({ budgetMb: 256 });
      let released = false;
      return {
        engine: ephEngine,
        ephemeral: true,
        release: () => {
          if (released) return;
          released = true;
          try { ephEngine.evict('all'); } catch {}
        },
      };
    }
    while (!forceRefresh && fallbackGraphInitPromise && fallbackGraphInitWs === activeWs) {
      try {
        await fallbackGraphInitPromise;
      } catch {
        break;
      }
    }
    const now = Date.now();
    const cur = fallbackGraphEntry;
    const sameWs = Boolean(cur && cur.wsPath === activeWs);
    const isFresh = Boolean(sameWs && cur?.engine && !cur.retired && !forceRefresh && (now - cur.updatedAt < FALLBACK_GRAPH_TTL_MS));
    if (isFresh) {
      return acquireFallbackEntryHandle(cur);
    }
    const myGen = ++fallbackGraphGen;
    const initPromise = (async () => {
      const { RamMemoryEngine } = await import('../../core/ram-memory-engine.mjs');
      const nextEngine = new RamMemoryEngine({ budgetMb: 256 });
      const entry = { engine: nextEngine, wsPath: activeWs, updatedAt: Date.now(), activeUsers: 0, retired: false };
      if (myGen !== fallbackGraphGen) {
        entry.retired = true;
        return entry;
      }
      const prev = fallbackGraphEntry;
      clearFallbackGraphEvictTimer();
      retireFallbackEntry(prev);
      fallbackGraphEntry = entry;
      return entry;
    })();
    fallbackGraphInitWs = activeWs;
    fallbackGraphInitPromise = initPromise;
    try {
      const entry = await initPromise;
      return acquireFallbackEntryHandle(entry);
    } finally {
      if (fallbackGraphInitPromise === initPromise) {
        fallbackGraphInitPromise = null;
        fallbackGraphInitWs = '';
      }
    }
  };

  const unquoteGitPath = (rawPath = '') => {
    let p = String(rawPath || '').trim();
    if (p.startsWith('"') && p.endsWith('"') && p.length >= 2) {
      p = p.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    return p.replace(/\\/g, '/').replace(/^\.\//, '');
  };

  app.api('/api/project-graph', async (data, req) => {
    if (hasRequestContext(req) && !isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const lang = normalizeLang(loadState()?.uiLanguage, 'en');
    try {
      const activeWs = await resolvePanelWorkspaceFromRequest(data, req);
      const focusRaw = typeof data?.focus === 'string' ? data.focus.trim().replace(/\\/g, '/').replace(/^\.\//, '') : '';
      const depth = Math.max(1, Math.min(3, Math.floor(Number(data?.depth) || 2)));
      const maxNodes = Math.max(30, Math.min(25000, Math.floor(Number(data?.maxNodes) || 220)));
      const includeTests = data?.includeTests === true || data?.includeTests === '1' || data?.includeTests === 'true';
      const includeDocs = data?.includeDocs !== false && data?.includeDocs !== '0' && data?.includeDocs !== 'false';
      const forceRefresh = data?.refresh === true || data?.refresh === '1' || data?.refresh === 'true';

      const fragileMap = await loadFragileFileMap(activeWs);

      if (!forceRefresh && !shouldBypassHostDaemonForGraph(activeWs)) {
        const daemonRes = await postRamDaemonJson(
          '/graph/project-map',
          { wsPath: activeWs, focus: focusRaw, depth, maxNodes, includeTests, includeDocs },
          1200
        );
        if (daemonRes && daemonRes.ok) {
          if (Array.isArray(daemonRes.nodes) && fragileMap.size > 0) {
            for (const n of daemonRes.nodes) {
              const frag = fragileMap.get(n.id);
              if (frag) {
                n.isFragile = Boolean(frag.runs > 0 && frag.reliabilityPercent < 80);
                n.reliabilityPercent = frag.reliabilityPercent;
              }
            }
          }
          return daemonRes;
        }
      }

      const { engine, release } = await getOrCreateFallbackGraphEngine(activeWs, { forceRefresh });
      try {
        return buildProjectGraphPayload(engine, activeWs, {
          focus: focusRaw,
          depth,
          maxNodes,
          includeTests,
          includeDocs,
          fragileMap,
          startWatcher: false,
          source: 'local_cache',
        });
      } finally {
        release();
      }
    } catch (err) {
      logServerErr('api_project_graph_failed', err);
      return { ok: false, error: err?.message || pickLang(lang, 'Ошибка построения карты проекта', 'Failed to build project graph') };
    }
  }, 'GET');

  app.api('/api/project-graph/path', async (data, req) => {
    if (hasRequestContext(req) && !isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const lang = normalizeLang(loadState()?.uiLanguage, 'en');
    try {
      const from = typeof data?.from === 'string' ? data.from.trim().replace(/\\/g, '/').replace(/^\.\//, '') : '';
      const to = typeof data?.to === 'string' ? data.to.trim().replace(/\\/g, '/').replace(/^\.\//, '') : '';
      if (!from || !to) {
        return {
          ok: false,
          found: false,
          error: pickLang(lang, 'Укажите оба узла для поиска пути (from и to)', 'Both "from" and "to" nodes are required'),
        };
      }
      const activeWs = await resolvePanelWorkspaceFromRequest(data, req);
      const maxDepth = Math.max(1, Math.min(8, Math.floor(Number(data?.maxDepth) || 6)));
      const direction = data?.direction === 'directed' ? 'directed' : 'both';

      if (!shouldBypassHostDaemonForGraph(activeWs)) {
        const daemonRes = await postRamDaemonJson(
          '/graph/path',
          { wsPath: activeWs, from, to, maxDepth, direction },
          1200
        );
        if (daemonRes && typeof daemonRes.found === 'boolean') {
          return {
            ok: true,
            found: daemonRes.found,
            from,
            to,
            hops: Number(daemonRes.hops || 0),
            mode: daemonRes.mode || 'none',
            path: Array.isArray(daemonRes.path) ? daemonRes.path : [],
            edges: Array.isArray(daemonRes.edges) ? daemonRes.edges : [],
            formattedHint: daemonRes.formattedHint || '',
            source: 'ram_daemon',
          };
        }
      }

      const { engine, release } = await getOrCreateFallbackGraphEngine(activeWs, { forceRefresh: false });
      try {
        const res = engine.findGraphPath(activeWs, from, to, { maxDepth, direction });
        return {
          ok: true,
          found: Boolean(res?.found),
          from,
          to,
          hops: Number(res?.hops || 0),
          mode: res?.mode || 'none',
          path: Array.isArray(res?.path) ? res.path : [],
          edges: Array.isArray(res?.edges) ? res.edges : [],
          formattedHint: res?.formattedHint || '',
          source: 'local_cache',
        };
      } finally {
        release();
      }
    } catch (err) {
      logServerErr('api_project_graph_path_failed', err);
      return { ok: false, found: false, error: err?.message || pickLang(lang, 'Ошибка поиска пути в графе', 'Failed to find graph path') };
    }
  }, 'GET');

  app.api('/api/project-graph/git-diff', async (data, req) => {
    if (hasRequestContext(req) && !isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    try {
      const activeWs = await resolvePanelWorkspaceFromRequest(data, req);
      const forceRefresh = data?.refresh === true || data?.refresh === '1' || data?.refresh === 'true';
      const now = Date.now();
      const cached = gitDiffCache.get(activeWs);
      if (!forceRefresh && cached && (now - cached.ts < (cached.ttlMs || GIT_DIFF_TTL_MS))) {
        return cached.payload;
      }

      let payload;
      let cacheTtlMs = GIT_DIFF_TTL_MS;
      try {
        const { stdout } = await execFileAsync('git', ['-c', 'core.quotepath=false', 'status', '--porcelain=v1', '-uall'], {
          cwd: activeWs,
          timeout: 1500,
          windowsHide: true,
          maxBuffer: 1024 * 1024,
        });
        const stagedSet = new Set();
        const unstagedSet = new Set();
        const untrackedSet = new Set();
        const changedSet = new Set();

        const lines = String(stdout || '').split(/\r?\n/);
        for (const rawLine of lines) {
          if (!rawLine || rawLine.length < 4) continue;
          const x = rawLine[0];
          const y = rawLine[1];
          let filePart = rawLine.slice(3);
          if ((x === 'R' || x === 'C' || y === 'R' || y === 'C') && filePart.includes(' -> ')) {
            const parts = filePart.split(' -> ');
            filePart = parts[parts.length - 1];
          }
          const rel = unquoteGitPath(filePart);
          if (!rel) continue;
          changedSet.add(rel);
          if (x === '?' && y === '?') {
            untrackedSet.add(rel);
          } else {
            if (x !== ' ' && x !== '?') stagedSet.add(rel);
            if (y !== ' ' && y !== '?') unstagedSet.add(rel);
          }
        }

        payload = {
          ok: true,
          available: true,
          workspaceRoot: activeWs,
          changedFiles: Array.from(changedSet).sort(),
          stagedFiles: Array.from(stagedSet).sort(),
          unstagedFiles: Array.from(unstagedSet).sort(),
          untrackedFiles: Array.from(untrackedSet).sort(),
        };
      } catch (gitErr) {
        const isTransient = Boolean(gitErr?.killed || gitErr?.signal === 'SIGTERM' || gitErr?.code === 'ETIMEDOUT');
        const isConfirmedNoGit = gitErr?.code === 'ENOENT' || /not a git repository/i.test(String(gitErr?.stderr || gitErr?.message || ''));
        cacheTtlMs = isTransient ? 0 : (isConfirmedNoGit ? GIT_DIFF_TTL_MS : 2000);
        if (isTransient) logServerErr('git_diff_timeout', gitErr);
        payload = {
          ok: true,
          available: false,
          workspaceRoot: activeWs,
          changedFiles: [],
          stagedFiles: [],
          unstagedFiles: [],
          untrackedFiles: [],
        };
      }

      if (cacheTtlMs > 0) {
        setBoundedCacheEntry(gitDiffCache, activeWs, { ts: now, ttlMs: cacheTtlMs, payload });
      }
      return payload;
    } catch (err) {
      logServerErr('api_project_graph_git_diff_failed', err);
      return {
        ok: true,
        available: false,
        changedFiles: [],
        stagedFiles: [],
        unstagedFiles: [],
        untrackedFiles: [],
      };
    }
  }, 'GET');

  app.api('/api/project-graph/symbols', async (data, req) => {
    if (hasRequestContext(req) && !isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const lang = normalizeLang(loadState()?.uiLanguage, 'en');
    try {
      const file = typeof data?.file === 'string' ? data.file.trim().replace(/\\/g, '/').replace(/^\.\//, '') : '';
      if (!file) {
        return {
          ok: false,
          isSymbolsView: true,
          nodes: [],
          edges: [],
          error: pickLang(lang, 'Укажите файл для графа символов', 'Target file is required for symbols view'),
        };
      }
      const activeWs = await resolvePanelWorkspaceFromRequest(data, req);
      const maxExternal = Math.max(8, Math.min(60, Math.floor(Number(data?.maxExternal) || 36)));

      if (!shouldBypassHostDaemonForGraph(activeWs)) {
        const daemonRes = await postRamDaemonJson(
          '/graph/symbols',
          { wsPath: activeWs, file, maxExternal },
          1200
        );
        if (daemonRes && daemonRes.ok) {
          return daemonRes;
        }
      }

      const { engine, release } = await getOrCreateFallbackGraphEngine(activeWs, { forceRefresh: false });
      try {
        return buildFileSymbolGraphPayload(engine, activeWs, file, {
          maxExternal,
          startWatcher: false,
          source: 'local_cache',
        });
      } finally {
        release();
      }
    } catch (err) {
      logServerErr('api_project_graph_symbols_failed', err);
      return {
        ok: false,
        isSymbolsView: true,
        nodes: [],
        edges: [],
        error: err?.message || pickLang(lang, 'Ошибка построения графа AST-символов', 'Failed to build AST symbol graph'),
      };
    }
  }, 'GET');

  app.api('/api/project-graph/git-churn', async (data, req) => {
    if (hasRequestContext(req) && !isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    try {
      const activeWs = await resolvePanelWorkspaceFromRequest(data, req);
      const days = Math.max(7, Math.min(365, Math.floor(Number(data?.days) || 90)));
      const forceRefresh = data?.refresh === true || data?.refresh === '1' || data?.refresh === 'true';
      const cacheKey = `${activeWs}|${days}`;
      const now = Date.now();
      const cached = gitChurnCache.get(cacheKey);
      if (!forceRefresh && cached && (now - cached.ts < (cached.ttlMs || GIT_CHURN_TTL_MS))) {
        return cached.payload;
      }

      let payload;
      let cacheTtlMs = GIT_CHURN_TTL_MS;
      try {
        const { stdout } = await execFileAsync('git', ['-c', 'core.quotepath=false', 'log', `--since=${days} days ago`, '--name-only', '--pretty=format:'], {
          cwd: activeWs,
          timeout: 2500,
          windowsHide: true,
          maxBuffer: 4 * 1024 * 1024,
        });
        const parsed = parseGitChurnOutput(stdout);
        payload = {
          ok: true,
          available: true,
          workspaceRoot: activeWs,
          days,
          totalTouches: parsed.totalTouches,
          maxChurn: parsed.maxChurn,
          churnByFile: parsed.churnByFile,
        };
      } catch (gitErr) {
        const isTransient = Boolean(gitErr?.killed || gitErr?.signal === 'SIGTERM' || gitErr?.code === 'ETIMEDOUT');
        const isConfirmedNoGit = gitErr?.code === 'ENOENT' || /not a git repository/i.test(String(gitErr?.stderr || gitErr?.message || ''));
        cacheTtlMs = isTransient ? 0 : (isConfirmedNoGit ? GIT_CHURN_TTL_MS : 2000);
        if (isTransient) logServerErr('git_churn_timeout', gitErr);
        payload = {
          ok: true,
          available: false,
          workspaceRoot: activeWs,
          days,
          totalTouches: 0,
          maxChurn: 0,
          churnByFile: {},
        };
      }

      if (cacheTtlMs > 0) {
        setBoundedCacheEntry(gitChurnCache, cacheKey, { ts: now, ttlMs: cacheTtlMs, payload });
      }
      return payload;
    } catch (err) {
      logServerErr('api_project_graph_git_churn_failed', err);
      return {
        ok: true,
        available: false,
        days: 90,
        totalTouches: 0,
        maxChurn: 0,
        churnByFile: {},
      };
    }
  }, 'GET');

  app.api('/api/project-graph/semantic-search', async (data, req) => {
    if (hasRequestContext(req) && !isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    try {
      const activeWs = await resolvePanelWorkspaceFromRequest(data, req);
      const q = typeof data?.q === 'string' ? data.q.trim() : '';
      if (q.length < 2) {
        return { ok: true, query: q, mode: 'empty', scoresByFile: {}, matches: [] };
      }

      if (!shouldBypassHostDaemonForGraph(activeWs)) {
        const daemonRes = await postRamDaemonJson(
          '/graph/semantic-search',
          { wsPath: activeWs, query: q, maxResults: 14 },
          3500
        );
        if (daemonRes && daemonRes.ok) {
          return daemonRes;
        }
      }

      const { engine, release } = await getOrCreateFallbackGraphEngine(activeWs, { forceRefresh: false });
      try {
        const semRes = await engine.searchSemantic(activeWs, q, {
          maxResults: 14,
          contextLines: 0,
          reindexMissing: false,
        });
        return aggregateSemanticGraphHits(semRes, q, 'local_cache');
      } finally {
        release();
      }
    } catch (err) {
      logServerErr('api_project_graph_semantic_search_failed', err);
      return {
        ok: false,
        query: typeof data?.q === 'string' ? data.q : '',
        mode: 'error',
        scoresByFile: {},
        matches: [],
        error: err?.message || 'Semantic search failed',
      };
    }
  }, 'GET');

  const findStandaloneBrowserExecutable = () => {
    const candidates = process.platform === 'win32'
      ? [
          process.env['ProgramFiles(x86)'] ? join(process.env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe') : '',
          process.env.ProgramFiles ? join(process.env.ProgramFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : '',
          process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : '',
          process.env.ProgramFiles ? join(process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
          process.env['ProgramFiles(x86)'] ? join(process.env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
          process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
        ]
      : process.platform === 'darwin'
        ? [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
            '/Applications/Chromium.app/Contents/MacOS/Chromium',
          ]
        : [
            '/usr/bin/google-chrome',
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
            '/usr/bin/microsoft-edge',
          ];
    for (const exe of candidates) {
      if (exe && existsSync(exe)) return exe;
    }
    return '';
  };

  const launchStandaloneGraphWindow = (targetUrl) => {
    const exe = findStandaloneBrowserExecutable();
    try {
      if (exe) {
        // Never set windowsHide:true on GUI browser launch: on Windows cold start,
        // CreateProcessW passes SW_HIDE and hides the first --app window.
        const child = spawn(
          exe,
          [
            `--app=${targetUrl}`,
            '--window-size=1440,900',
            '--start-maximized',
            '--disable-features=Translate',
            '--no-first-run',
            '--no-default-browser-check',
          ],
          {
            detached: true,
            stdio: 'ignore',
          }
        );
        child.on('error', (spawnErr) => { logServerErr('graph_window_spawn_failed', spawnErr); });
        child.unref();
        return { ok: true, mode: 'app_window' };
      }
      if (process.platform === 'win32') {
        const child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', targetUrl], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        });
        child.on('error', (spawnErr) => { logServerErr('graph_window_spawn_failed', spawnErr); });
        child.unref();
        return { ok: true, mode: 'browser_tab' };
      }
      const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
      const child = spawn(opener, [targetUrl], { detached: true, stdio: 'ignore' });
      child.on('error', (spawnErr) => { logServerErr('graph_window_spawn_failed', spawnErr); });
      child.unref();
      return { ok: true, mode: 'browser_tab' };
    } catch (err) {
      return { ok: false, error: err?.message || 'Failed to spawn browser window' };
    }
  };

  const MAX_GRAPH_AUTH_CODES = 16;
  const GRAPH_AUTH_CODE_TTL_MS = 30_000;
  const graphAuthCodes = new Map();
  const pruneGraphAuthCodes = (now = Date.now()) => {
    for (const [k, entry] of graphAuthCodes.entries()) {
      if (!entry || entry.expiresAt <= now) graphAuthCodes.delete(k);
    }
    while (graphAuthCodes.size >= MAX_GRAPH_AUTH_CODES) {
      const oldestKey = graphAuthCodes.keys().next().value;
      if (oldestKey === undefined) break;
      graphAuthCodes.delete(oldestKey);
    }
  };

  app.api('/api/project-graph/exchange-auth', async (data, req) => {
    if (!isRouteAuthorized(req, { allowAuthCodeExchange: true })) return { ok: false, status: 403, error: 'Forbidden origin' };
    pruneGraphAuthCodes();
    const code = typeof data?.authCode === 'string' ? data.authCode.trim() : '';
    if (!code) return { ok: false, error: 'Missing authCode' };
    const entry = graphAuthCodes.get(code);
    graphAuthCodes.delete(code);
    if (!entry || entry.expiresAt <= Date.now()) {
      return { ok: false, error: 'Invalid or expired authCode' };
    }
    return { ok: true, token: entry.token };
  }, 'POST');

  app.api('/api/project-graph/open-window', async (data, req) => {
    if (!isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const lang = normalizeLang(loadState()?.uiLanguage, 'en');
    try {
      const activeReq = resolveReq(req);
      const activeWs = await resolvePanelWorkspaceFromRequest(data, req);
      let port = 0;
      try {
        const addr = activeHttpServer && typeof activeHttpServer.address === 'function' ? activeHttpServer.address() : null;
        if (addr && typeof addr === 'object' && Number.isInteger(addr.port) && addr.port > 0) {
          port = addr.port;
        }
      } catch {}
      if (!port && activeReq?.headers?.host) {
        const rawHost = String(activeReq.headers.host).trim();
        const m = /^(?:127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})$/i.exec(rawHost);
        if (m) {
          const p = Number(m[1]);
          if (p >= 1 && p <= 65535) port = p;
        }
      }
      if (!port) {
        const envPort = Number(process.env.SIDECAR_PORT || process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || process.env.PORT || 0);
        if (Number.isInteger(envPort) && envPort >= 1 && envPort <= 65535) port = envPort;
      }
      if (!port) {
        return {
          ok: false,
          fallbackModal: true,
          error: pickLang(lang, 'Локальный порт панели недоступен', 'Panel loopback port unavailable'),
        };
      }

      const rawToken =
        (activeReq?.headers && (activeReq.headers['x-sidecar-token'] || activeReq.headers['x-antigravity-token'])) ||
        (typeof data?.token === 'string' ? data.token : '') ||
        process.env.SIDECAR_TOKEN ||
        process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN ||
        '';
      const rawFocus = typeof data?.focus === 'string' ? data.focus.trim().replace(/\\/g, '/').replace(/^\.\//, '') : '';
      const cleanFocus = (
        rawFocus &&
        rawFocus.length <= 512 &&
        !/[\r\n\0]/.test(rawFocus) &&
        !rawFocus.startsWith('/') &&
        !/^[a-zA-Z]:/.test(rawFocus) &&
        !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(rawFocus) &&
        !rawFocus.split('/').some((seg) => seg === '..')
      ) ? rawFocus : '';
      const urlParams = new URLSearchParams();
      urlParams.set('view', 'graph');
      urlParams.set('lang', lang);
      if (activeWs) urlParams.set('rootDir', activeWs);
      if (cleanFocus) urlParams.set('focus', cleanFocus);
      const cleanToken = String(rawToken || '').trim();
      if (cleanToken) {
        pruneGraphAuthCodes();
        const authCode = randomBytes(18).toString('hex');
        graphAuthCodes.set(authCode, {
          token: cleanToken,
          expiresAt: Date.now() + GRAPH_AUTH_CODE_TTL_MS,
        });
        urlParams.set('authCode', authCode);
      }
      const targetUrl = `http://127.0.0.1:${port}/?${urlParams.toString()}`;

      if (data?.dryRun === true) {
        return { ok: true, url: targetUrl, dryRun: true, mode: 'dry_run' };
      }

      const launched = launchStandaloneGraphWindow(targetUrl);
      if (!launched.ok) {
        return { ok: false, fallbackModal: true, error: launched.error || 'Window launch failed' };
      }
      return { ok: true, url: targetUrl, mode: launched.mode };
    } catch (err) {
      logServerErr('api_project_graph_open_window_failed', err);
      return {
        ok: false,
        fallbackModal: true,
        error: err?.message || pickLang(lang, 'Не удалось открыть отдельное окно карты', 'Failed to open standalone graph window'),
      };
    }
  }, 'POST');

  app.api('/api/project-graph/workspaces', async (data, req) => {
    if (hasRequestContext(req) && !isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const lang = normalizeLang(loadState()?.uiLanguage, 'en');
    try {
      const state = loadState();
      const rawReqRoot = typeof data?.rootDir === 'string' ? data.rootDir.trim() : '';
      const isPinnedReq = Boolean(rawReqRoot && rawReqRoot !== '__all__' && rawReqRoot !== '__auto__' && isValidWorkspaceDir(rawReqRoot));
      const openWorkspaces = parseOpenWorkspacesFromRequest(data, req);
      const activeConversationId = parseActiveConversationIdFromRequest(data, req);
      const [activeWs, autoWs, ramCache, hudPack] = await Promise.all([
        resolveActiveWorkspaceForPanel(rawReqRoot, { openWorkspaces, activeConversationId }),
        resolveActiveWorkspaceForPanel('', { openWorkspaces, activeConversationId }),
        safeGetRamCacheStatus(state).catch(() => null),
        safeGetHudAndProgressStatus(state, isPinnedReq ? resolve(rawReqRoot) : '').catch(() => null),
      ]);
      const extraRoots = Array.isArray(data?.extraRoots)
        ? data.extraRoots
        : (typeof data?.extraRoots === 'string' ? data.extraRoots.split('|').filter(Boolean) : []);
      const workspaces = await discoverUserProjectsForGraph({
        activeWs,
        autoWs,
        extraRoots,
        openWorkspaces,
        taskProgress: hudPack?.progress || null,
        ramCache,
        allowActiveEphemeral: isPinnedReq,
      });
      return {
        ok: true,
        activeWorkspace: activeWs,
        autoWorkspace: autoWs,
        workspaces,
      };
    } catch (err) {
      logServerErr('api_project_graph_workspaces_failed', err);
      return {
        ok: false,
        workspaces: [],
        error: err?.message || pickLang(lang, 'Не удалось получить список проектов', 'Failed to list projects'),
      };
    }
  }, 'GET');

  let activeFolderPickerPromise = null;
  let activeFolderPickerController = null;

  async function openNativeFolderPicker({
    rawPath = undefined,
    dryRun = false,
    initialDir = '',
    title = '',
    allowNewFolder = false,
    allowCreatablePath = false,
    lang = 'en',
  } = {}) {
    if (typeof rawPath === 'string') {
      const clean = rawPath.trim();
      if (allowCreatablePath) {
        if (!isSafeCreatableFolderPath(clean)) {
          return {
            ok: false,
            error: pickLang(lang, 'Указан некорректный путь к папке', 'Specified folder path is invalid'),
          };
        }
        if (process.platform === 'win32') {
          const drv = /^([A-Za-z]):/.exec(clean);
          if (drv && !existsSync(`${drv[1]}:\\`)) {
            return {
              ok: false,
              error: pickLang(lang, `Диск ${drv[1]}: не найден`, `Drive ${drv[1]}: not found`),
            };
          }
        }
      } else if (!isValidWorkspaceDir(clean)) {
        return {
          ok: false,
          error: pickLang(lang, 'Указанная папка не существует или недоступна', 'Specified folder does not exist or is inaccessible'),
        };
      }
      const abs = resolve(clean);
      return {
        ok: true,
        cancelled: false,
        workspaceRoot: abs,
        dir: abs,
        projectName: basename(abs) || abs,
      };
    }

    if (dryRun === true) {
      return { ok: true, cancelled: true, dryRun: true, workspaceRoot: '', dir: '' };
    }

    if (activeFolderPickerPromise) {
      return activeFolderPickerPromise;
    }

    const runPicker = (async () => {
      const rawInit = typeof initialDir === 'string' ? initialDir.trim() : '';
      const safeInitDir = rawInit && isValidWorkspaceDir(rawInit) ? resolve(rawInit) : '';
      const pickerTitle = title || pickLang(lang, 'Выберите папку', 'Select folder');
      const pickerEnv = {
        ...process.env,
        AG_PICKER_INITIAL_DIR: safeInitDir,
        AG_PICKER_TITLE: pickerTitle,
      };

      let picked = '';
      const pickerController = new AbortController();
      activeFolderPickerController = pickerController;
      if (process.platform === 'win32') {
        const psScript = [
          '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
          'Add-Type -AssemblyName System.Windows.Forms',
          '[System.Windows.Forms.Application]::EnableVisualStyles()',
          '$dlg = New-Object System.Windows.Forms.FolderBrowserDialog',
          "$dlg.Description = if ($env:AG_PICKER_TITLE) { $env:AG_PICKER_TITLE } else { 'Select folder' }",
          `$dlg.ShowNewFolderButton = ${allowNewFolder ? '$true' : '$false'}`,
          'if ($env:AG_PICKER_INITIAL_DIR -and (Test-Path -LiteralPath $env:AG_PICKER_INITIAL_DIR -PathType Container)) { $dlg.SelectedPath = $env:AG_PICKER_INITIAL_DIR }',
          "$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false; FormBorderStyle = 'None'; Opacity = 0; Width = 1; Height = 1; StartPosition = 'CenterScreen' }",
          '$owner.Show()',
          '$owner.Activate()',
          '$res = $dlg.ShowDialog($owner)',
          '$owner.Close()',
          '$owner.Dispose()',
          'if ($res -eq [System.Windows.Forms.DialogResult]::OK -and $dlg.SelectedPath) { [Console]::Out.Write($dlg.SelectedPath) }',
        ].join('; ');
        try {
          const { stdout } = await execFileAsync(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-STA', '-Command', psScript],
            { timeout: 120000, windowsHide: true, env: pickerEnv, maxBuffer: 1024 * 1024, signal: pickerController.signal }
          );
          picked = String(stdout || '').trim();
        } catch (psErr) {
          if (psErr?.name === 'AbortError' || pickerController.signal.aborted) {
            return { ok: true, cancelled: true, workspaceRoot: '', dir: '' };
          }
          logServerErr('folder_picker_win32_failed', psErr);
          if (psErr?.code === 1 && !String(psErr?.stderr || '').trim()) {
            return { ok: true, cancelled: true, workspaceRoot: '', dir: '' };
          }
          throw new Error(pickLang(lang, 'Не удалось открыть системный диалог выбора папки', 'Failed to open native folder picker dialog'));
        }
      } else if (process.platform === 'darwin') {
        const osaScript = [
          'set initDir to system attribute "AG_PICKER_INITIAL_DIR"',
          'set dlgTitle to system attribute "AG_PICKER_TITLE"',
          'if initDir is not "" then',
          '  POSIX path of (choose folder with prompt dlgTitle default location (POSIX file initDir))',
          'else',
          '  POSIX path of (choose folder with prompt dlgTitle)',
          'end if',
        ].join('\n');
        try {
          const { stdout } = await execFileAsync('osascript', ['-e', osaScript], {
            timeout: 120000,
            env: pickerEnv,
            maxBuffer: 1024 * 1024,
            signal: pickerController.signal,
          });
          picked = String(stdout || '').trim();
        } catch (err) {
          if (err?.name === 'AbortError' || pickerController.signal.aborted) {
            return { ok: true, cancelled: true, workspaceRoot: '', dir: '' };
          }
          const msg = String(err?.stderr || err?.message || '');
          if (err?.code === 1 || /user canceled|-128/i.test(msg)) {
            return { ok: true, cancelled: true, workspaceRoot: '', dir: '' };
          }
          throw err;
        }
      } else {
        const zenityArgs = ['--file-selection', '--directory', `--title=${pickerTitle}`];
        if (safeInitDir) zenityArgs.push(`--filename=${safeInitDir.replace(/\/+$/, '')}/`);
        try {
          const { stdout } = await execFileAsync('zenity', zenityArgs, {
            timeout: 120000,
            env: pickerEnv,
            maxBuffer: 1024 * 1024,
            signal: pickerController.signal,
          });
          picked = String(stdout || '').trim();
        } catch (zenErr) {
          if (zenErr?.name === 'AbortError' || pickerController.signal.aborted) {
            return { ok: true, cancelled: true, workspaceRoot: '', dir: '' };
          }
          if (zenErr?.code === 1) {
            return { ok: true, cancelled: true, workspaceRoot: '', dir: '' };
          }
          if (zenErr?.code === 'ENOENT') {
            const kdArgs = ['--getexistingdirectory', safeInitDir || homedir(), '--title', pickerTitle];
            try {
              const { stdout } = await execFileAsync('kdialog', kdArgs, {
                timeout: 120000,
                env: pickerEnv,
                maxBuffer: 1024 * 1024,
                signal: pickerController.signal,
              });
              picked = String(stdout || '').trim();
            } catch (kdErr) {
              if (kdErr?.name === 'AbortError' || pickerController.signal.aborted) {
                return { ok: true, cancelled: true, workspaceRoot: '', dir: '' };
              }
              if (kdErr?.code === 1) {
                return { ok: true, cancelled: true, workspaceRoot: '', dir: '' };
              }
              throw kdErr;
            }
          } else {
            throw zenErr;
          }
        }
      }

      if (!picked) {
        return { ok: true, cancelled: true, workspaceRoot: '', dir: '' };
      }
      if (!isValidWorkspaceDir(picked)) {
        return {
          ok: false,
          error: pickLang(lang, 'Выбранная папка недоступна', 'Selected folder is inaccessible'),
        };
      }
      const abs = resolve(picked);
      return {
        ok: true,
        cancelled: false,
        workspaceRoot: abs,
        dir: abs,
        projectName: basename(abs) || abs,
      };
    })();

    activeFolderPickerPromise = runPicker;
    try {
      return await runPicker;
    } finally {
      activeFolderPickerController = null;
      if (activeFolderPickerPromise === runPicker) {
        activeFolderPickerPromise = null;
      }
    }
  }

  app.api('/api/project-graph/pick-folder', async (data, req) => {
    if (!isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const lang = normalizeLang(loadState()?.uiLanguage, 'en');
    try {
      return await openNativeFolderPicker({
        rawPath: data && Object.prototype.hasOwnProperty.call(data, 'path') ? data.path : undefined,
        dryRun: data?.dryRun === true,
        initialDir: data?.initialDir,
        title: pickLang(lang, 'Выберите папку проекта для карты', 'Select project folder for map'),
        allowNewFolder: false,
        allowCreatablePath: false,
        lang,
      });
    } catch (err) {
      logServerErr('api_project_graph_pick_folder_failed', err);
      return {
        ok: false,
        error: err?.message || pickLang(lang, 'Не удалось открыть диалог выбора папки', 'Failed to open folder picker'),
      };
    }
  }, 'POST');

  app.api('/api/gpu/pick-folder', async (data, req) => {
    if (!isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const lang = normalizeLang(loadState()?.uiLanguage, 'en');
    const mode = data?.mode === 'models' ? 'models' : 'ollama';
    try {
      const title = mode === 'models'
        ? pickLang(lang, 'Выберите папку для хранения моделей Ollama (OLLAMA_MODELS)', 'Select folder for Ollama models (OLLAMA_MODELS)')
        : pickLang(lang, 'Выберите папку для установки Ollama и локальных моделей', 'Select folder for Ollama installation and local models');
      return await openNativeFolderPicker({
        rawPath: data && Object.prototype.hasOwnProperty.call(data, 'path') ? data.path : undefined,
        dryRun: data?.dryRun === true,
        initialDir: data?.initialDir,
        title,
        allowNewFolder: true,
        allowCreatablePath: true,
        lang,
      });
    } catch (err) {
      logServerErr('api_gpu_pick_folder_failed', err);
      return {
        ok: false,
        error: err?.message || pickLang(lang, 'Не удалось открыть диалог выбора папки', 'Failed to open folder picker'),
      };
    }
  }, 'POST');

  app.api('/api/debt', async (data, req) => {
    if (hasRequestContext(req) && !isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const lang = normalizeLang(loadState()?.uiLanguage, 'en');
    try {
      const activeWs = await resolvePanelWorkspaceFromRequest(data, req);
      const { scanShortcutDebt } = await import('../../core/shortcut-debt-ledger.mjs');
      const res = scanShortcutDebt(activeWs, {
        marker: typeof data?.marker === 'string' ? data.marker : '',
        lang,
      });
      return res;
    } catch (err) {
      logServerErr('api_debt_failed', err);
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
          invalidateGuardPulseCache('', ['env', 'fast']);
          if (panelRuntime?.discoverSkillsCache) {
            panelRuntime.discoverSkillsCache.ts = 0;
          }
          const restored = loadState();
          if (
            !process.env.TUNNEL_TEST_STATE_PATH &&
            process.env.TUNNEL_TEST_ISOLATE_INSTALLED !== '1' &&
            panelRuntime.hardwareProfilerSync?.syncMcpRamBudget
          ) {
            const localRoot = resolveUpdaterRoot();
            const installedRoot = join(homedir(), '.gemini', 'config', 'plugins', 'antigravity-model-router');
            try {
              panelRuntime.hardwareProfilerSync.syncMcpRamBudget(localRoot, restored.ramMaxBudgetMb || 4096, {
                gpuEnabled: Boolean(restored.gpuEnabled),
              });
            } catch (syncErr) {
              logServerErr('profile_restore_mcp_sync_local_failed', syncErr);
            }
            try {
              if (
                resolve(installedRoot).toLowerCase() !== resolve(localRoot).toLowerCase() &&
                existsSync(installedRoot)
              ) {
                panelRuntime.hardwareProfilerSync.syncMcpRamBudget(installedRoot, restored.ramMaxBudgetMb || 4096, {
                  resolveAbsoluteEntry: true,
                  gpuEnabled: Boolean(restored.gpuEnabled),
                });
              }
            } catch (syncErr) {
              logServerErr('profile_restore_mcp_sync_installed_failed', syncErr);
            }
          }
          return { ...res, state: restored };
        }
        return res;
      }
      return cli.backupRouterProfile('');
    } catch (err) {
      logServerErr('api_profile_backup_failed', err);
      return { ok: false, error: err?.message || String(err || 'Profile backup failed') };
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
      if (action === 'pull_dismiss_error') {
        const pullStatus = typeof mod.clearGpuPullErrorStatus === 'function' ? mod.clearGpuPullErrorStatus() : null;
        gpuStatusPanelCache.ts = 0;
        return { ok: true, pullStatus };
      }
      if (action === 'install_status') {
        const installStatus = typeof mod.getOllamaInstallJobStatus === 'function' ? mod.getOllamaInstallJobStatus() : null;
        return { ok: true, installStatus };
      }
      if (action === 'install_dismiss') {
        const installStatus = typeof mod.clearOllamaInstallJobStatus === 'function' ? mod.clearOllamaInstallJobStatus() : null;
        gpuStatusPanelCache.ts = 0;
        return { ok: true, installStatus };
      }
      if (action === 'install_ollama') {
        const curState = loadState();
        const reqInstallDir = typeof data?.installDir === 'string'
          ? data.installDir.trim()
          : String(curState.gpuOllamaDir || '').trim();
        const reqModelsDir = typeof data?.modelsDir === 'string' && data.modelsDir.trim()
          ? data.modelsDir.trim()
          : (reqInstallDir ? join(reqInstallDir, 'models') : String(curState.gpuModelsDir || '').trim());
        if ((reqInstallDir && !isSafeCreatableFolderPath(reqInstallDir)) || (reqModelsDir && !isSafeCreatableFolderPath(reqModelsDir))) {
          return {
            ok: false,
            error: pickLang(lang, 'Некорректный путь установки Ollama или папки моделей', 'Invalid Ollama install or models directory path'),
          };
        }
        const mirrorMode = data?.mirrorMode === 'huggingface'
          ? 'huggingface'
          : (curState.gpuPreferHfMirror ? 'huggingface' : 'auto');
        const nextPatch = {
          gpuEnabled: true,
          gpuOllamaDir: reqInstallDir,
          gpuModelsDir: reqModelsDir,
        };
        if (typeof data?.preferHfMirror === 'boolean') {
          nextPatch.gpuPreferHfMirror = data.preferHfMirror;
        }
        const saved = saveState(nextPatch);
        const pullModeAfter = data?.pullModeAfter === 'cascade' || data?.pullModeAfter === 'active_only'
          ? data.pullModeAfter
          : '';
        const selectedCapMb = Number(data?.selectedCapMb) || Number(saved?.gpuMaxVramMb) || 4096;
        const installStatus = typeof mod.startOllamaInstallJob === 'function'
          ? await mod.startOllamaInstallJob({
              installDir: reqInstallDir,
              modelsDir: reqModelsDir,
              pullModeAfter,
              selectedCapMb,
              mirrorMode,
              lang: normalizeLang(saved?.uiLanguage, lang),
            })
          : { ok: false, phase: 'error', error: pickLang(lang, 'Установщик Ollama недоступен', 'Ollama installer unavailable') };
        gpuStatusPanelCache.ts = 0;
        const snap = await fetchFreshGpuSnap();
        return {
          ok: installStatus?.ok !== false && installStatus?.phase !== 'error',
          installStatus,
          state: saved,
          gpu: snap,
          error: installStatus?.error || '',
        };
      }
      if (action === 'pull_cascade') {
        const snap = await fetchFreshGpuSnap();
        const curState = loadState();
        const safeModelsOverride = Array.isArray(data?.models)
          ? data.models.map((m) => String(m || '').trim()).filter((m) => /^[a-z0-9._:/-]{2,128}$/i.test(m)).slice(0, 8)
          : [];
        if (!snap?.ollama?.installed && !snap?.ollama?.running && safeModelsOverride.length === 0) {
          return {
            ok: false,
            code: 'OLLAMA_NOT_INSTALLED',
            error: pickLang(lang, 'Ollama не установлена — сначала установите Ollama', 'Ollama is not installed — install Ollama first'),
            gpu: snap,
          };
        }
        const hwMod = await getHardwareProfilerMod();
        const hwProfile = hwMod?.getHardwareProfile
          ? await hwMod.getHardwareProfile({ pluginRoot: resolveUpdaterRoot(), force: false, subscriptionTier: curState.subscriptionTier === 'ultra' ? 'ultra' : 'pro' }).catch(() => null)
          : null;
        const totalVramMb = Number(data?.totalVramMb) || Number(snap?.hardware?.totalMb) || Number(hwProfile?.gpu?.totalMb) || 0;
        const selectedCapMb = Number(data?.selectedCapMb) || Number(curState.gpuMaxVramMb) || 4096;
        const pullMode = data?.mode === 'active_only' ? 'active_only' : 'cascade';
        const mirrorMode = data?.mirrorMode === 'huggingface'
          ? 'huggingface'
          : (data?.mirrorMode === 'auto' ? 'auto' : (curState.gpuPreferHfMirror ? 'huggingface' : 'auto'));
        const downloadedModels = snap?.ollama?.downloadedModels || [];
        const bundle = hwMod?.buildGpuCascadeBundleForHardware
          ? hwMod.buildGpuCascadeBundleForHardware(totalVramMb, { mode: pullMode, selectedCapMb, downloadedModels })
          : { mode: pullMode, models: [], missingModels: [] };
        const targetModels = safeModelsOverride.length > 0 ? safeModelsOverride : bundle.models.map((m) => m.name);
        const pullStatus = typeof mod.startGpuCascadePull === 'function'
          ? await mod.startGpuCascadePull({
              models: targetModels,
              mode: pullMode,
              mirrorMode,
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
        const wsRoot = await resolvePanelWorkspaceFromRequest(data, req);
        if (!isValidWorkspaceDir(wsRoot)) {
          return { ok: false, status: 400, error: pickLang(lang, 'Рабочая папка не найдена или недопустима', 'Workspace directory not found or invalid') };
        }
        const daemonRes = await postRamDaemonJson('/gpu/warm', { wsPath: wsRoot, maxNewFiles: 350 }, 90000);
        if (daemonRes && typeof daemonRes.ok === 'boolean' && daemonRes.ok) {
          const snap = await fetchFreshGpuSnap();
          return { ...daemonRes, gpu: snap, viaDaemon: true };
        }
        const { RamMemoryEngine } = await import('../../core/ram-memory-engine.mjs');
        const ram = new RamMemoryEngine();
        try {
          const warmRes = await ram.warmWorkspaceAsync(wsRoot, { startWatcher: false });
          const ws = warmRes?.files
            ? warmRes
            : (warmRes?.ok ? ram.getOrCreateWorkspace(wsRoot) : null);
          if (!ws || !ws.files) return { ok: false, error: pickLang(lang, 'Рабочая папка не найдена', 'Workspace directory not found') };
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
      logServerErr('api_gpu_failed', err);
      return { ok: false, error: err?.message || pickLang(lang, 'Ошибка GPU-модуля', 'GPU operation failed') };
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
        pluginRoot: resolveUpdaterRoot(),
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
      logServerErr('api_hardware_failed', err);
      return { ok: false, error: err?.message || pickLang(lang, 'Ошибка профилирования железа', 'Hardware profiling failed') };
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
      logServerErr('api_hud_failed', err);
      return { ok: false, error: err?.message || pickLang(lang, 'Ошибка HUD-прогресса', 'HUD operation failed') };
    }
  }, 'POST');

  let activeAutocompleteAbort = null;
  let autocompleteOrderSeq = 0;
  let latestAutocompleteOrderSeq = 0;
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
    parallelBatchSize: 1,
    autoProcess: true,
    onError: (err) => {
      if (err?.code !== 'AUTOCOMPLETE_SUPERSEDED') {
        logServerErr('autocomplete_queue_error', err);
      }
    },
  });

  app.api('/api/autocomplete', async (data, req) => {
    if (!isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const seq = Number(data?.seq) || 0;
    const mode = String(data?.mode || 'suggest');
    const stage = data?.stage === 'fast' ? 'fast' : 'gpu';
    const reqOrder = (mode !== 'context' && stage !== 'fast') ? ++autocompleteOrderSeq : 0;
    if (reqOrder > 0) latestAutocompleteOrderSeq = reqOrder;
    try {
      const rawAutoRoot = typeof data?.rootDir === 'string' ? data.rootDir.trim() : '';
      const effectiveAutoRoot = (rawAutoRoot && rawAutoRoot !== '__auto__' && rawAutoRoot !== '__all__')
        ? rawAutoRoot
        : await resolvePanelWorkspaceFromRequest(data, req);
      const ctx = await getAutocompleteWorkspaceContext(effectiveAutoRoot, {
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

      const draft = String(data?.draft || '').slice(0, 1200);
      const scopedCtx = prioritizeContextForDraft(draft, ctx);
      const curState = loadState();
      const autocompleteLang = normalizeLang(curState?.uiLanguage, 'en');
      const allowFollowUp = data?.allowFollowUp !== false;
      const recentMessages = Array.isArray(data?.recentMessages)
        ? data.recentMessages
            .slice(-4)
            .map((m) => ({
              role: m?.role === 'assistant' ? 'assistant' : 'user',
              content: String(m?.content || '').trim().slice(0, 220),
            }))
            .filter((m) => m.content.length > 0)
        : [];
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

      if (reqOrder > 0 && reqOrder !== latestAutocompleteOrderSeq) {
        return { ok: false, aborted: true, seq, continuation: '' };
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
                { wsPath: ctx.wsRoot || '', query: draft.slice(-600) },
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
                recentMessages,
                touchedFiles: mergedFiles,
                symbolHints,
                ragSnippets,
                repoFiles: groundingRepoFiles,
                allRepoSymbols: groundingRepoSymbols,
                symbolsByFile: groundingSymbolsByFile,
                repoTechTerms: groundingRepoTechTerms,
                allowedSlashCommands: ALLOWED_SLASH_COMMANDS,
                allowFollowUpSentence: allowFollowUp,
                maxOutputTokens: 56,
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

      if (ac.signal.aborted || gpuRes?.aborted || (reqOrder > 0 && reqOrder !== latestAutocompleteOrderSeq)) {
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
        err?.code === 'QUEUE_TASK_TIMEOUT' ||
        err?.code === 'QUEUE_DISPOSED'
      ) {
        return { ok: false, aborted: true, seq, continuation: '' };
      }
      logServerErr('api_autocomplete_failed', err);
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
      logServerErr('api_chat_send_failed', err);
      return {
        ok: false,
        code: err?.code || 'CHAT_QUEUE_ERROR',
        dropped: Boolean(err?.dropped),
        error: err?.message || pickLang(lang, 'Ошибка отправки в чат', 'Failed to send chat message'),
        queue: chatMessageQueue.getStats(),
      };
    }
  }, 'POST');

  const activeLocalChatControllers = new Map();

  app.api('/api/local-chat/abort', async (data, req) => {
    if (!isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const reqId = typeof data?.requestId === 'string' ? data.requestId.trim().slice(0, 128) : '';
    if (reqId) {
      const ac = activeLocalChatControllers.get(reqId);
      if (ac) {
        try { ac.abort('client_requested_abort'); } catch {}
        activeLocalChatControllers.delete(reqId);
        return { ok: true, abortedCount: 1, requestId: reqId };
      }
      return { ok: true, abortedCount: 0, requestId: reqId };
    }
    let abortedCount = 0;
    for (const [id, ac] of activeLocalChatControllers.entries()) {
      try { ac.abort('client_requested_abort'); } catch {}
      activeLocalChatControllers.delete(id);
      abortedCount += 1;
    }
    return { ok: true, abortedCount };
  }, 'POST');

  app.api('/api/local-chat', async (data, req) => {
    const activeReq = resolveReq(req);
    if (!isRouteAuthorized(activeReq)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const curLocalState = loadState();
    const lang = normalizeLang(curLocalState?.uiLanguage, 'en');
    const reqAbort = new AbortController();
    const requestId = (typeof data?.requestId === 'string' && data.requestId.trim())
      ? data.requestId.trim().slice(0, 128)
      : ('lc-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
    const prevCtrl = activeLocalChatControllers.get(requestId);
    if (prevCtrl) {
      try { prevCtrl.abort('superseded_request_id'); } catch {}
    }
    activeLocalChatControllers.set(requestId, reqAbort);

    const triggerClientAbort = () => {
      if (!reqAbort.signal.aborted) reqAbort.abort('client_disconnected');
    };
    if (activeReq?.aborted || activeReq?.destroyed || activeReq?.socket?.destroyed) {
      triggerClientAbort();
    }
    const onReqAborted = () => triggerClientAbort();
    const onSocketClose = () => triggerClientAbort();
    if (activeReq && typeof activeReq.on === 'function') activeReq.on('aborted', onReqAborted);
    if (activeReq?.socket && typeof activeReq.socket.on === 'function') activeReq.socket.on('close', onSocketClose);

    const maxLifetimeTimer = setTimeout(() => {
      if (!reqAbort.signal.aborted) reqAbort.abort('local_chat_max_lifetime');
      if (activeLocalChatControllers.get(requestId) === reqAbort) {
        activeLocalChatControllers.delete(requestId);
      }
    }, 180_000);
    maxLifetimeTimer.unref?.();

    const abortedResponse = (viaDaemon) => ({
      ok: false,
      aborted: true,
      answer: '',
      error: pickLang(lang, 'Запрос отменён', 'Request aborted'),
      ...(viaDaemon !== undefined ? { viaDaemon } : {}),
    });

    try {
      if (reqAbort.signal.aborted) return abortedResponse();
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

      const wsRoot = await resolvePanelWorkspaceFromRequest(data, req);
      if (reqAbort.signal.aborted) return abortedResponse();
      const focusFile = typeof data?.focusFile === 'string' ? data.focusFile.trim().slice(0, 512) : '';
      const daemonRes = (process.env.TUNNEL_TEST_ISOLATE_INSTALLED === '1' || curLocalState.gpuEnabled === false)
        ? null
        : await postRamDaemonJson(
            '/gpu/chat',
            {
              wsPath: wsRoot,
              query: rawMessage,
              focusFile,
              messages: cleanMessages,
              maxOutputTokens: data?.maxOutputTokens,
              lang,
            },
            60000,
            { signal: reqAbort.signal, stopOnResponse: true }
          );
      if (reqAbort.signal.aborted || daemonRes?.aborted) {
        return abortedResponse(true);
      }
      if (daemonRes?.timedOut) {
        return {
          ok: false,
          timedOut: true,
          answer: '',
          error: pickLang(lang, 'Превышено время ожидания локального GPU', 'Local GPU request timed out'),
          viaDaemon: true,
        };
      }
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
      if (reqAbort.signal.aborted) return abortedResponse(false);

      const { RamMemoryEngine } = await import('../../core/ram-memory-engine.mjs');
      const ram = new RamMemoryEngine();
      try {
        const warmRes = await ram.warmWorkspaceAsync(wsRoot, { startWatcher: false });
        if (reqAbort.signal.aborted) return abortedResponse(false);
        const ws = warmRes?.ok ? ram.ensureWarm(wsRoot) : null;
        if (!ws || !ws.files) {
          return { ok: false, answer: '', error: pickLang(lang, 'Рабочая папка проекта не найдена', 'Project workspace folder not found'), viaDaemon: false };
        }
        const queryWithFocus = focusFile && !rawMessage.toLowerCase().includes(focusFile.toLowerCase())
          ? `${rawMessage} ${focusFile}`
          : rawMessage;
        let effectiveQuery = queryWithFocus;
        if (cleanMessages.length > 0) {
          const carryTerms = [];
          const seenTerms = new Set();
          const lowerRaw = queryWithFocus.toLowerCase();
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
            effectiveQuery = `${queryWithFocus} ${carryTerms.join(' ')}`;
          }
        }

        const hasBoundedIndexer = typeof gpuMod.indexWorkspaceVectors === 'function';
        const chatActive = typeof gpuMod.isLocalChatActive === 'function' && gpuMod.isLocalChatActive();
        if (!reqAbort.signal.aborted && !chatActive && gpuCfg?.gpuSemanticSearch !== false && hasBoundedIndexer) {
          await gpuMod.indexWorkspaceVectors(ws.absRoot, ws.files, { maxNewFiles: 20 }).catch(() => null);
        }
        if (reqAbort.signal.aborted) return abortedResponse(false);

        const semRes = await ram.searchSemantic(ws.absRoot, effectiveQuery, {
          maxResults: 6,
          contextLines: 3,
          reindexMissing: !hasBoundedIndexer,
        });
        if (reqAbort.signal.aborted) return abortedResponse(false);

        const hits = Array.isArray(semRes?.results) ? semRes.results : [];
        const packRes = typeof ram.buildGroundedChatPack === 'function'
          ? ram.buildGroundedChatPack(ws.absRoot, queryWithFocus, {
              messages: cleanMessages,
              maxChars: 8400,
              warmSemanticHits: hits,
              focusFile,
            })
          : ram.getContextPack(ws.absRoot, queryWithFocus, {
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
        if (reqAbort.signal.aborted) return abortedResponse(false);
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
          signal: reqAbort.signal,
          lang,
        });
        return { ...chatRes, viaDaemon: false };
      } finally {
        ram.evict('all');
      }
    } catch (err) {
      if (reqAbort.signal.aborted) return abortedResponse();
      logServerErr('api_local_chat_failed', err);
      return {
        ok: false,
        code: err?.code || 'LOCAL_CHAT_ERROR',
        answer: '',
        error: err?.message || pickLang(lang, 'Ошибка локального RAG-чата', 'Local RAG chat failed'),
      };
    } finally {
      clearTimeout(maxLifetimeTimer);
      if (activeLocalChatControllers.get(requestId) === reqAbort) {
        activeLocalChatControllers.delete(requestId);
      }
      if (activeReq && typeof activeReq.off === 'function') {
        activeReq.off('aborted', onReqAborted);
      } else if (activeReq && typeof activeReq.removeListener === 'function') {
        activeReq.removeListener('aborted', onReqAborted);
      }
      if (activeReq?.socket && typeof activeReq.socket.off === 'function') {
        activeReq.socket.off('close', onSocketClose);
      } else if (activeReq?.socket && typeof activeReq.socket.removeListener === 'function') {
        activeReq.socket.removeListener('close', onSocketClose);
      }
    }
  }, 'POST');

  app.api('/api/composer/at-suggest', async (data, req) => {
    if (!isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const curState = loadState();
    const lang = normalizeLang(curState?.uiLanguage, 'en');
    try {
      const wsRoot = await resolvePanelWorkspaceFromRequest(data, req);
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
        limit: clampFiniteInt(data?.limit, 1, 50, 10),
        lang,
      });
    } catch (err) {
      logServerErr('api_composer_at_suggest_failed', err);
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
        timeoutMs: clampFiniteInt(data?.timeoutMs, 1000, 60000, 18000),
        lang,
      });
    } catch (err) {
      logServerErr('api_composer_vision_failed', err);
      return { ok: false, error: err?.message || pickLang(lang, 'Ошибка анализа скриншота', 'Screenshot analysis failed') };
    }
  }, 'POST');

  app.api('/api/composer/voice-structure', async (data, req) => {
    if (!isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const curState = loadState();
    const lang = normalizeLang(curState?.uiLanguage, 'en');
    try {
      const wsRoot = await resolvePanelWorkspaceFromRequest(data, req);
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
      logServerErr('api_composer_voice_structure_failed', err);
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

  const updateHandlers = options?.updateHandlers && typeof options.updateHandlers === 'object'
    ? options.updateHandlers
    : null;

  let lastPluginUpdateCheck = null;

  const getUpdateRuntimeCtx = () => ({
    pid: process.pid,
    serverStartedAt: PANEL_SERVER_STARTED_AT,
    runningVersion: PANEL_LOADED_VERSION,
  });

  app.api('/api/plugin/update-check', async (data, req) => {
    if (hasRequestContext(req) && !isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const pluginRoot = resolveUpdaterRoot();
    const force = data?.force === true || data?.force === '1' || data?.force === 'true';
    const lang = normalizeLang(loadState()?.uiLanguage, 'en');
    const runtimeCtx = getUpdateRuntimeCtx();
    try {
      const checkFn = typeof updateHandlers?.checkForPluginUpdate === 'function'
        ? updateHandlers.checkForPluginUpdate
        : checkForPluginUpdate;
      const statusFn = typeof updateHandlers?.getPluginUpdateStatus === 'function'
        ? updateHandlers.getPluginUpdateStatus
        : getPluginUpdateStatus;
      const checkRes = await checkFn({ pluginRoot, force, lang });
      if (checkRes && checkRes.ok) {
        lastPluginUpdateCheck = checkRes;
      }
      const status = statusFn(pluginRoot, runtimeCtx);
      return { ...checkRes, status };
    } catch (err) {
      logServerErr('plugin_update_check_failed', err);
      return {
        ok: false,
        updateAvailable: false,
        error: err?.message || 'Update check failed',
        status: getPluginUpdateStatus(pluginRoot, runtimeCtx),
      };
    }
  }, 'GET');

  app.api('/api/plugin/update-status', async (_data, req) => {
    if (hasRequestContext(req) && !isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const lang = normalizeLang(loadState()?.uiLanguage, 'en');
    try {
      const pluginRoot = resolveUpdaterRoot();
      const statusFn = typeof updateHandlers?.getPluginUpdateStatus === 'function'
        ? updateHandlers.getPluginUpdateStatus
        : getPluginUpdateStatus;
      return { ok: true, status: statusFn(pluginRoot, getUpdateRuntimeCtx()) };
    } catch (err) {
      logServerErr('plugin_update_status_failed', err);
      return { ok: false, error: err?.message || pickLang(lang, 'Ошибка чтения статуса обновления', 'Failed to read update status') };
    }
  }, 'GET');

  app.api('/api/plugin/update-apply', async (data, req) => {
    if (!isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const curState = loadState();
    const lang = normalizeLang(curState?.uiLanguage, 'en');
    const pluginRoot = resolveUpdaterRoot();
    const downloadUrl = typeof data?.downloadUrl === 'string' ? data.downloadUrl.trim() : '';
    const targetVersion = typeof data?.targetVersion === 'string' ? data.targetVersion.trim() : '';
    const forceApply = data?.forceApply === true || data?.force === true;
    const pinnedRepo = readPluginMeta(pluginRoot).repo;
    if (downloadUrl && !isAllowedPluginDownloadUrl(downloadUrl, pinnedRepo)) {
      return {
        ok: false,
        status: 400,
        started: false,
        error: pickLang(lang, 'Отклонён недоверенный URL обновления (не соответствует репозиторию плагина)', 'Blocked untrusted update URL (does not match plugin repository)'),
      };
    }
    const cachedCheck = lastPluginUpdateCheck && lastPluginUpdateCheck.downloadUrl === downloadUrl
      ? lastPluginUpdateCheck
      : null;
    try {
      const applyFn = typeof updateHandlers?.applyPluginUpdate === 'function'
        ? updateHandlers.applyPluginUpdate
        : applyPluginUpdate;
      const status = await applyFn({
        pluginRoot,
        downloadUrl,
        targetVersion,
        expectedSha256: cachedCheck?.expectedSha256 || '',
        checksumUrl: cachedCheck?.checksumUrl || '',
        forceApply,
        lang,
        awaitCompletion: false,
        appliedByPid: process.pid,
      });
      return {
        ok: status?.ok !== false && status?.phase !== 'error',
        started: Boolean(status?.active),
        status,
        error: status?.error || '',
      };
    } catch (err) {
      logServerErr('plugin_update_apply_failed', err);
      return {
        ok: false,
        started: false,
        error: err?.message || pickLang(lang, 'Ошибка запуска обновления', 'Failed to start plugin update'),
        status: getPluginUpdateStatus(pluginRoot, getUpdateRuntimeCtx()),
      };
    }
  }, 'POST');

  app.api('/api/plugin/update-dismiss', async (_data, req) => {
    if (!isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const lang = normalizeLang(loadState()?.uiLanguage, 'en');
    try {
      const pluginRoot = resolveUpdaterRoot();
      const dismissFn = typeof updateHandlers?.clearPluginUpdateStatus === 'function'
        ? updateHandlers.clearPluginUpdateStatus
        : clearPluginUpdateStatus;
      return { ok: true, status: dismissFn(pluginRoot) };
    } catch (err) {
      logServerErr('plugin_update_dismiss_failed', err);
      return { ok: false, error: err?.message || pickLang(lang, 'Ошибка сброса статуса обновления', 'Failed to dismiss plugin update status') };
    }
  }, 'POST');

  app.api('/api/plugin/changelog', async (data, req) => {
    if (hasRequestContext(req) && !isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const stateLang = normalizeLang(loadState()?.uiLanguage, 'en');
    const lang = typeof data?.lang === 'string' && data.lang.trim() ? normalizeLang(data.lang, stateLang) : stateLang;
    try {
      const pluginRoot = resolveUpdaterRoot();
      return loadPluginChangelog({
        pluginRoot,
        currentVersion: PANEL_LOADED_VERSION,
        remoteRelease: lastPluginUpdateCheck,
        lang,
      });
    } catch (err) {
      logServerErr('plugin_changelog_failed', err);
      return {
        ok: false,
        lang,
        versions: [],
        error: err?.message || pickLang(lang, 'Ошибка загрузки истории изменений', 'Failed to load changelog'),
      };
    }
  }, 'GET');

  app.api('/api/debug/status', async (data, req) => {
    if (hasRequestContext(req) && !isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const state = loadState();
    const lang = normalizeLang(state?.uiLanguage, 'en');
    try {
      const pluginRoot = resolveUpdaterRoot();
      const rawLimit = Number(data?.limit);
      const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(300, Math.round(rawLimit))) : 60;
      const rawLevel = typeof data?.level === 'string' ? data.level.trim().toLowerCase() : 'all';
      const level = ['all', 'error', 'warn', 'info', 'debug'].includes(rawLevel) ? rawLevel : 'all';
      const status = getDebugLogStatus({ pluginRoot, state });
      const logData = readDebugLogEntries({ pluginRoot, limit, level });
      return {
        ...status,
        entries: logData.entries,
        filteredEntries: logData.filteredEntries,
      };
    } catch (err) {
      logServerErr('debug_status_failed', err);
      return { ok: false, entries: [], filteredEntries: [], error: err?.message || pickLang(lang, 'Ошибка чтения дебаг-лога', 'Failed to read debug log status') };
    }
  }, 'GET');

  app.api('/api/debug/mode', async (data, req) => {
    if (!isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const pluginRoot = resolveUpdaterRoot();
    const curState = loadState();
    const lang = normalizeLang(curState?.uiLanguage, 'en');
    try {
      const mode = typeof data?.mode === 'string' ? data.mode.trim().toLowerCase() : '';
      if (!VALID_DEBUG_LOG_MODES.has(mode)) {
        return {
          ok: false,
          status: 400,
          error: pickLang(lang, 'Недопустимый режим дебаг-лога', 'Invalid debug log mode'),
        };
      }
      const nextState = saveState({ debugLogMode: mode });
      appendDebugLog({
        level: 'info',
        source: 'panel-server',
        event: 'debug_mode_changed',
        message: `Debug log mode set to ${mode}`,
      }, { state: nextState, pluginRoot });
      return {
        ok: true,
        mode,
        state: nextState,
        status: getDebugLogStatus({ pluginRoot, state: nextState }),
      };
    } catch (err) {
      logServerErr('debug_mode_failed', err);
      return { ok: false, error: err?.message || pickLang(lang, 'Ошибка переключения режима дебаг-лога', 'Failed to switch debug log mode') };
    }
  }, 'POST');

  app.api('/api/debug/client-log', async (data, req) => {
    if (!isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const state = loadState();
    const lang = normalizeLang(state?.uiLanguage, 'en');
    try {
      const pluginRoot = resolveUpdaterRoot();
      const rawLvl = typeof data?.level === 'string' ? data.level.trim().toLowerCase() : 'error';
      const level = ['debug', 'info', 'warn', 'error'].includes(rawLvl) ? rawLvl : 'error';
      const event = typeof data?.event === 'string' ? data.event.trim().slice(0, 80) : 'client_error';
      const message = typeof data?.message === 'string' ? data.message.trim().slice(0, 600) : '';
      if (!message) {
        return { ok: false, logged: false, error: 'Empty log message' };
      }
      const logged = appendDebugLog({
        level,
        source: 'panel-ui',
        event: event || 'client_error',
        message,
        meta: data?.meta,
      }, { state, pluginRoot });
      return { ok: true, logged };
    } catch (err) {
      logServerErr('debug_client_log_failed', err);
      return { ok: false, logged: false, error: err?.message || pickLang(lang, 'Ошибка записи клиентского лога', 'Failed to write client log') };
    }
  }, 'POST');

  app.api('/api/debug/clear', async (_data, req) => {
    if (!isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const lang = normalizeLang(loadState()?.uiLanguage, 'en');
    try {
      const pluginRoot = resolveUpdaterRoot();
      clearDebugLog({ pluginRoot });
      return {
        ok: true,
        status: getDebugLogStatus({ pluginRoot, state: loadState() }),
      };
    } catch (err) {
      logServerErr('debug_clear_failed', err);
      return { ok: false, error: err?.message || pickLang(lang, 'Ошибка очистки дебаг-лога', 'Failed to clear debug log') };
    }
  }, 'POST');

  app.api('/api/debug/export', async (data, req) => {
    if (hasRequestContext(req) && !isRouteAuthorized(req)) return { ok: false, status: 403, error: 'Forbidden origin' };
    const state = loadState();
    const lang = normalizeLang(state?.uiLanguage, 'en');
    try {
      const pluginRoot = resolveUpdaterRoot();
      const activeWs = await resolvePanelWorkspaceFromRequest(data, req);
      const [gpuStatus, ramStatus, worktrees] = await Promise.all([
        safeGetGpuStatus(),
        safeGetRamCacheStatus(state),
        safeListShadowWorktrees(activeWs),
      ]);
      let healthReport = null;
      try {
        const { diagnoseRuntimeHealth } = await import('../../core/health-doctor.mjs');
        healthReport = diagnoseRuntimeHealth({
          workspaceRoot: activeWs,
          state,
          gpuStatus,
          ramStatus,
          worktrees,
        });
      } catch (healthErr) {
        logServerErr('debug_export_health_failed', healthErr);
      }
      const updateStatus = getPluginUpdateStatus(pluginRoot, getUpdateRuntimeCtx());
      const bundle = buildDiagnosticBundle({
        pluginRoot,
        state,
        healthReport,
        updateStatus,
        ramStatus,
        gpuStatus,
        limit: 400,
      });
      const markdownSummary = formatDiagnosticBundleSummary(bundle, lang);
      const isoDate = new Date().toISOString().slice(0, 10);
      return {
        ok: true,
        filename: `the-tunnel-debug-v${PANEL_LOADED_VERSION}-${isoDate}.json`,
        bundle,
        markdownSummary,
      };
    } catch (err) {
      logServerErr('debug_export_failed', err);
      return { ok: false, error: err?.message || pickLang(lang, 'Ошибка экспорта диагностического пакета', 'Failed to export diagnostic bundle') };
    }
  }, 'GET');

  let resourcesCleaned = false;
  const cleanupPanelResources = () => {
    if (resourcesCleaned) return;
    resourcesCleaned = true;
    try { chatMessageQueue.dispose(); } catch {}
    try { autocompleteGpuQueue.dispose(); } catch {}
    if (activeFolderPickerController) {
      try { activeFolderPickerController.abort('panel_closing'); } catch {}
      activeFolderPickerController = null;
    }
    if (activeAutocompleteAbort) {
      try { activeAutocompleteAbort.abort('panel_closing'); } catch {}
      activeAutocompleteAbort = null;
    }
    for (const [id, ac] of activeLocalChatControllers.entries()) {
      try { ac.abort('panel_closing'); } catch {}
      activeLocalChatControllers.delete(id);
    }
    latestComposerHandoff = null;
    fallbackGraphGen += 1;
    clearFallbackGraphEvictTimer();
    retireFallbackEntry(fallbackGraphEntry);
    fallbackGraphEntry = null;
    fallbackGraphInitPromise = null;
    fallbackGraphInitWs = '';
    gitDiffCache.clear();
    gitChurnCache.clear();
    graphAuthCodes.clear();
  };

  let runResult = null;
  try {
    runResult = await app.run();
  } catch (err) {
    cleanupPanelResources();
    throw err;
  }
  const server = runResult || app?.server || app?._server || null;
  if (server && typeof server === 'object') {
    activeHttpServer = server;
    attachSidecarSecurityMiddleware(server, { expectedToken: options?.expectedToken });
    securityMiddlewareActive = true;
    if (typeof server.once === 'function') {
      server.once('close', cleanupPanelResources);
    }
  }
  if (app && typeof app.close === 'function') {
    const origClose = app.close.bind(app);
    app.close = async (...args) => {
      try {
        return await origClose(...args);
      } finally {
        cleanupPanelResources();
      }
    };
  }
  return app;
}

if (isMainEntry() && SidecarApp) {
  let sidecarShutdownPromise = null;
  let shutdownRequested = false;
  let activeSidecarApp = null;
  let hostWatchdog = null;
  const triggerSidecarExitCleanup = () => {
    shutdownRequested = true;
    if (sidecarShutdownPromise) return sidecarShutdownPromise;
    try { hostWatchdog?.stop(); } catch {}
    const forceTimer = setTimeout(() => process.exit(0), 2500);
    if (typeof forceTimer.unref === 'function') forceTimer.unref();
    sidecarShutdownPromise = Promise.allSettled([
      activeSidecarApp?.close ? activeSidecarApp.close() : Promise.resolve(),
      handleSidecarExitCleanup(),
      getTaskProgressMod()
        .then((progMod) => progMod?.markHostRestartAndReapActiveTasks?.({ bootAt: Date.now() }))
        .catch(() => {}),
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
      if (shutdownRequested) {
        try { app?.close?.().catch?.(() => {}); } catch {}
        return;
      }
      if (app) {
        getTaskProgressMod()
          .then((progMod) => progMod?.markHostRestartAndReapActiveTasks?.({ bootAt: Date.now() }))
          .catch(() => {});
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

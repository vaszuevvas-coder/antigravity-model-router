/**
 * @file panel-sentinel-adapter.mjs
 * @description Background Sentinel panel status adapter and finding normalization.
 */

import { postRamDaemonJson } from './panel-state-skills.mjs';

const SENTINEL_PANEL_CACHE_TTL_MS = 2200;

export const sentinelPanelCache = { ts: 0, wsKey: '', enabled: null, shadowTests: null, value: null };

let coreBackgroundSentinel = null;

export async function getBackgroundSentinelMod() {
  if (coreBackgroundSentinel) return coreBackgroundSentinel;
  try {
    coreBackgroundSentinel = await import('../../../core/background-sentinel.mjs');
    return coreBackgroundSentinel;
  } catch {
    return null;
  }
}

function buildDefaultSentinelSnapshot(currentState = {}) {
  const st = currentState && typeof currentState === 'object' ? currentState : {};
  const enabled = st.sentinelEnabled !== false;
  return {
    ok: true,
    enabled,
    state: st.sentinelEnabled === false ? 'disabled' : 'idle',
    currentTaskRu: st.sentinelEnabled === false ? 'Выключен' : 'Ожидание простоя',
    currentTaskEn: st.sentinelEnabled === false ? 'Disabled' : 'Idle (waiting)',
    preemptedCount: 0,
    speculativeHits: 0,
    shadowGuard: {
      status: 'healthy',
      errorCount: 0,
      warnCount: 0,
      cloneCount: 0,
      clonePairs: [],
      issues: [],
      coChangeAlerts: [],
    },
    bugBot: {
      findingsCount: 0,
      findings: [],
    },
    symbolCards: {
      indexedFiles: 0,
      totalEligibleFiles: 0,
      coveragePct: 0,
      lastFile: '',
    },
    shadowTests: {
      enabled: Boolean(st.sentinelShadowTests),
      lastStatus: 'idle',
      lastSummaryRu: 'Выкл (предохранитель)',
      lastSummaryEn: 'Off (safety guard)',
    },
  };
}

export function normalizeSentinelSnapshotPayload(rawSnap, currentState = {}) {
  const base = buildDefaultSentinelSnapshot(currentState);
  if (!rawSnap || typeof rawSnap !== 'object') return base;
  const src = rawSnap.sentinel && typeof rawSnap.sentinel === 'object' ? rawSnap.sentinel : rawSnap;
  return {
    ...base,
    ...src,
    ok: true,
    currentTaskRu: (typeof src.currentTaskRu === 'string' && src.currentTaskRu.trim()) ? src.currentTaskRu : base.currentTaskRu,
    currentTaskEn: (typeof src.currentTaskEn === 'string' && src.currentTaskEn.trim()) ? src.currentTaskEn : base.currentTaskEn,
    shadowGuard: {
      ...base.shadowGuard,
      ...(src.shadowGuard && typeof src.shadowGuard === 'object' ? src.shadowGuard : {}),
    },
    bugBot: {
      ...base.bugBot,
      ...(src.bugBot && typeof src.bugBot === 'object' ? src.bugBot : {}),
    },
    symbolCards: {
      ...base.symbolCards,
      ...(src.symbolCards && typeof src.symbolCards === 'object' ? src.symbolCards : {}),
    },
    shadowTests: {
      ...base.shadowTests,
      ...(src.shadowTests && typeof src.shadowTests === 'object' ? src.shadowTests : {}),
    },
  };
}

export async function fetchSentinelPanelStatus(wsRoot, currentState = {}, { force = false } = {}) {
  const st = currentState && typeof currentState === 'object' ? currentState : {};
  const enabled = st.sentinelEnabled !== false;
  const shadowTests = Boolean(st.sentinelShadowTests);
  const wsKey = String(wsRoot || '');
  const now = Date.now();
  if (
    !force &&
    sentinelPanelCache.value &&
    sentinelPanelCache.wsKey === wsKey &&
    sentinelPanelCache.enabled === enabled &&
    sentinelPanelCache.shadowTests === shadowTests &&
    now - sentinelPanelCache.ts < SENTINEL_PANEL_CACHE_TTL_MS
  ) {
    return sentinelPanelCache.value;
  }

  try {
    const daemonRes = await postRamDaemonJson('/sentinel/status', { wsPath: wsRoot }, 400);
    if (daemonRes && daemonRes.ok) {
      const normalized = normalizeSentinelSnapshotPayload(daemonRes, st);
      Object.assign(sentinelPanelCache, { ts: Date.now(), wsKey, enabled, shadowTests, value: normalized });
      return normalized;
    }
  } catch {}

  try {
    const sentinelMod = await getBackgroundSentinelMod();
    const reader =
      sentinelMod?.readCachedSentinelSnapshot ||
      sentinelMod?.default?.readCachedSentinelSnapshot ||
      sentinelMod?.sentinel?.readCachedSentinelSnapshot;
    if (typeof reader === 'function') {
      const cachedSnap = await reader(wsRoot, st);
      if (cachedSnap && typeof cachedSnap === 'object') {
        const normalized = normalizeSentinelSnapshotPayload(cachedSnap, st);
        Object.assign(sentinelPanelCache, { ts: Date.now(), wsKey, enabled, shadowTests, value: normalized });
        return normalized;
      }
    }
  } catch {}

  const fallback = buildDefaultSentinelSnapshot(st);
  Object.assign(sentinelPanelCache, { ts: Date.now(), wsKey, enabled, shadowTests, value: fallback });
  return fallback;
}

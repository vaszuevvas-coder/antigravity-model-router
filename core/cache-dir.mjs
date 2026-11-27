/**
 * @file cache-dir.mjs
 * @description Shared cache path resolver (`TUNNEL_CACHE_DIR` override) and bounded LRU/TTL pruning helpers.
 */

import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const UNSAFE_KEYS = new Set([
  '__proto__',
  'constructor',
  'prototype',
  'toString',
  'valueOf',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
]);

const DEFAULT_MAX_ENTRIES = 64;
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Resolves the `.cache` directory for a plugin root, respecting `process.env.TUNNEL_CACHE_DIR`
 * so isolated tests never pollute production `.cache/*.json`.
 * @param {string} [pluginRoot=process.cwd()]
 * @returns {string}
 */
export function resolveTunnelCacheDir(pluginRoot = process.cwd()) {
  const override = typeof process.env.TUNNEL_CACHE_DIR === 'string' ? process.env.TUNNEL_CACHE_DIR.trim() : '';
  if (override) return resolve(override);
  const root = typeof pluginRoot === 'string' && pluginRoot.trim() ? pluginRoot : process.cwd();
  return join(root, '.cache');
}

/**
 * Ensures the resolved cache directory exists.
 * @param {string} cacheDir
 * @returns {string}
 */
export function ensureTunnelCacheDir(cacheDir) {
  if (typeof cacheDir !== 'string' || !cacheDir.trim()) return '';
  mkdirSync(cacheDir, { recursive: true });
  return cacheDir;
}

/**
 * Prunes a plain key->record map by TTL and LRU max-entries cap while preserving pinned records.
 * @template T
 * @param {Record<string, T>} mapObj
 * @param {{
 *   maxEntries?: number,
 *   maxAgeMs?: number,
 *   now?: number,
 *   getTs?: (val: T, key: string) => number,
 *   keepPredicate?: (key: string, val: T) => boolean,
 * }} [options={}]
 * @returns {Record<string, T>}
 */
export function pruneObjectMapByTimestamp(mapObj, options = {}) {
  if (!mapObj || typeof mapObj !== 'object' || Array.isArray(mapObj)) return {};

  const opts = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
  const defaultGetTs = (val) => Number(val?.ts || val?.updatedAtMs || 0) || 0;
  const getTs = typeof opts.getTs === 'function' ? opts.getTs : defaultGetTs;
  const keepPredicate = typeof opts.keepPredicate === 'function' ? opts.keepPredicate : null;

  const rawNow = opts.now;
  const now = typeof rawNow === 'number' && Number.isFinite(rawNow) ? rawNow : Date.now();

  const rawMaxAge = opts.maxAgeMs;
  const maxAgeMs =
    rawMaxAge !== null && rawMaxAge !== '' && typeof rawMaxAge !== 'boolean' && Number.isFinite(Number(rawMaxAge))
      ? Number(rawMaxAge)
      : DEFAULT_MAX_AGE_MS;

  const rawMaxEntries = opts.maxEntries;
  const limit =
    rawMaxEntries !== null &&
    rawMaxEntries !== '' &&
    typeof rawMaxEntries !== 'boolean' &&
    Number.isFinite(Number(rawMaxEntries))
      ? Math.max(1, Math.round(Number(rawMaxEntries)))
      : DEFAULT_MAX_ENTRIES;

  const pinned = [];
  const regular = [];

  for (const [k, v] of Object.entries(mapObj)) {
    if (!k || UNSAFE_KEYS.has(k) || !v || typeof v !== 'object' || Array.isArray(v)) continue;

    let rawTs = 0;
    try {
      rawTs = Number(getTs(v, k));
    } catch {
      continue;
    }
    const ts = Number.isFinite(rawTs) && rawTs > 0 ? rawTs : 0;

    let isPinned = false;
    if (keepPredicate) {
      try {
        isPinned = Boolean(keepPredicate(k, v));
      } catch {
        isPinned = false;
      }
    }

    if (isPinned) {
      pinned.push({ k, v, ts: ts || now });
      continue;
    }

    if (maxAgeMs > 0) {
      if (!ts || now - ts > maxAgeMs) continue;
    }
    regular.push({ k, v, ts });
  }

  if (pinned.length > limit) {
    pinned.sort((a, b) => b.ts - a.ts);
  }
  const keptPinnedCount = Math.min(pinned.length, limit);
  const allowedRegular = Math.max(0, limit - keptPinnedCount);

  if (regular.length > allowedRegular) {
    regular.sort((a, b) => b.ts - a.ts);
  }

  const out = {};
  for (let i = 0; i < keptPinnedCount; i++) {
    out[pinned[i].k] = pinned[i].v;
  }
  for (let i = 0; i < regular.length && i < allowedRegular; i++) {
    out[regular[i].k] = regular[i].v;
  }
  return out;
}

/**
 * Checks whether a process PID is alive via signal 0 probe.
 * @param {number|string} pid
 * @param {{ treatSelfAsAlive?: boolean }} [options]
 * @returns {boolean}
 */
export function isPidAlive(pid, options = {}) {
  if (typeof pid !== 'number' && (typeof pid !== 'string' || !pid.trim())) return false;
  const num = Number(pid);
  if (!Number.isInteger(num) || num <= 0) return false;
  const opts = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
  if (opts.treatSelfAsAlive && num === process.pid) return true;
  try {
    process.kill(num, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/**
 * Builds the shared live-activity telemetry structure for CPU/GPU coprocessors.
 * @param {Record<string, unknown>} [extra={}]
 * @returns {Record<string, unknown>}
 */
export function createBaseLiveActivityState(extra = {}) {
  const safeExtra = extra && typeof extra === 'object' && !Array.isArray(extra) ? extra : {};
  return {
    opSeq: 0,
    inFlight: [],
    lastCompletedAt: 0,
    lastOp: '',
    lastDetail: '',
    lastLatencyMs: 0,
    ...safeExtra,
  };
}

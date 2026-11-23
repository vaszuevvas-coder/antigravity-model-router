/**
 * @file cache-dir.mjs
 * @description Shared cache path resolver (`TUNNEL_CACHE_DIR` override) and bounded LRU/TTL pruning helpers.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty']);

/**
 * Resolves the `.cache` directory for a plugin root, respecting `process.env.TUNNEL_CACHE_DIR`
 * so isolated tests never pollute production `.cache/*.json`.
 * @param {string} pluginRoot
 * @returns {string}
 */
export function resolveTunnelCacheDir(pluginRoot = process.cwd()) {
  const override = typeof process.env.TUNNEL_CACHE_DIR === 'string' ? process.env.TUNNEL_CACHE_DIR.trim() : '';
  if (override) return resolve(override);
  return join(pluginRoot, '.cache');
}

/**
 * Ensures the resolved cache directory exists.
 * @param {string} cacheDir
 * @returns {string}
 */
export function ensureTunnelCacheDir(cacheDir) {
  if (cacheDir && !existsSync(cacheDir)) {
    mkdirSync(cacheDir, { recursive: true });
  }
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
export function pruneObjectMapByTimestamp(
  mapObj,
  {
    maxEntries = 64,
    maxAgeMs = 24 * 60 * 60 * 1000,
    now = Date.now(),
    getTs = (val) => Number(val?.ts || val?.updatedAtMs || 0) || 0,
    keepPredicate = null,
  } = {}
) {
  if (!mapObj || typeof mapObj !== 'object' || Array.isArray(mapObj)) return {};

  const pinned = [];
  const regular = [];

  for (const [k, v] of Object.entries(mapObj)) {
    if (!k || UNSAFE_KEYS.has(k) || !v || typeof v !== 'object') continue;
    if (typeof keepPredicate === 'function' && keepPredicate(k, v)) {
      pinned.push({ k, v, ts: Number(getTs(v, k)) || now });
      continue;
    }
    const ts = Number(getTs(v, k)) || 0;
    if (maxAgeMs > 0) {
      if (!ts || now - ts > maxAgeMs) continue;
    }
    regular.push({ k, v, ts });
  }

  const limit = Number.isFinite(Number(maxEntries)) ? Math.max(1, Math.round(Number(maxEntries))) : 64;
  if (pinned.length + regular.length > limit) {
    regular.sort((a, b) => b.ts - a.ts);
  }
  const allowedRegular = Math.max(0, limit - pinned.length);

  const out = {};
  for (const item of pinned) {
    out[item.k] = item.v;
  }
  for (let i = 0; i < regular.length && i < allowedRegular; i++) {
    out[regular[i].k] = regular[i].v;
  }
  return out;
}

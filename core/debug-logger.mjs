/**
 * @file debug-logger.mjs
 * @description Rotating, privacy-redacted NDJSON diagnostic logger and support bundle exporter.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { arch, homedir, hostname, platform, release, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTunnelCacheDir } from './cache-dir.mjs';
import { safeReadJsonSync } from './safe-json.mjs';
import { redactSecretsInText } from './security-guard.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PLUGIN_ROOT = join(__dirname, '..');

export const VALID_DEBUG_LOG_MODES = new Set(['off', 'errors', 'verbose']);
export const DEFAULT_MAX_LOG_BYTES = 2 * 1024 * 1024;
const MAX_STRING_LEN = 2000;
const MAX_ARRAY_ITEMS = 80;
const MAX_OBJECT_KEYS = 80;
const MAX_DEPTH = 6;
const SENSITIVE_KEY_RE = /(?:token|secret|password|passwd|auth|cookie|apikey|api_key|privatekey|credential)/i;

function escapeRegexLiteral(str = '') {
  return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function resolvePluginRoot(pluginRoot = '') {
  if (typeof pluginRoot === 'string' && pluginRoot.trim()) {
    return resolve(pluginRoot.trim());
  }
  return DEFAULT_PLUGIN_ROOT;
}

/**
 * Returns active and rotated NDJSON debug log file paths inside `.cache`.
 * @param {string} [pluginRoot='']
 */
export function getDebugLogPaths(pluginRoot = '') {
  const root = resolvePluginRoot(pluginRoot);
  const cacheDir = resolveTunnelCacheDir(root);
  return {
    cacheDir,
    activePath: join(cacheDir, 'debug-log.ndjson'),
    prevPath: join(cacheDir, 'debug-log.prev.ndjson'),
  };
}

/**
 * Resolves effective debug logging mode: `off` | `errors` | `verbose`.
 * @param {object | null} [state=null]
 * @param {string} [pluginRoot='']
 */
export function resolveDebugLogMode(state = null, pluginRoot = '') {
  const envMode = typeof process.env.TUNNEL_DEBUG_LOG === 'string'
    ? process.env.TUNNEL_DEBUG_LOG.trim().toLowerCase()
    : '';
  if (VALID_DEBUG_LOG_MODES.has(envMode)) return envMode;

  let resolvedState = state;
  if (!resolvedState || typeof resolvedState !== 'object') {
    const root = resolvePluginRoot(pluginRoot);
    const stateFile = typeof process.env.TUNNEL_TEST_STATE_PATH === 'string' && process.env.TUNNEL_TEST_STATE_PATH.trim()
      ? resolve(process.env.TUNNEL_TEST_STATE_PATH.trim())
      : join(root, 'router-state.json');
    resolvedState = safeReadJsonSync(stateFile, null, { selfHeal: false });
  }

  const raw = typeof resolvedState?.debugLogMode === 'string'
    ? resolvedState.debugLogMode.trim().toLowerCase()
    : '';
  if (VALID_DEBUG_LOG_MODES.has(raw)) return raw;
  return 'errors';
}

/**
 * Checks whether an entry severity should be written for the current log mode.
 * @param {string} [level='info']
 * @param {string} [mode='errors']
 */
export function shouldLogDebug(level = 'info', mode = 'errors') {
  const normMode = VALID_DEBUG_LOG_MODES.has(String(mode || '').toLowerCase())
    ? String(mode).toLowerCase()
    : 'errors';
  if (normMode === 'off') return false;
  if (normMode === 'verbose') return true;
  const normLvl = String(level || 'info').trim().toLowerCase();
  return normLvl === 'error' || normLvl === 'warn';
}

function resolveUserIdentityHints(opts = {}) {
  let home = typeof opts.homedir === 'string' ? opts.homedir.trim() : '';
  if (!home) {
    try { home = homedir(); } catch { home = ''; }
  }
  let user = typeof opts.username === 'string' ? opts.username.trim() : '';
  if (!user) {
    try { user = userInfo().username || ''; } catch { user = ''; }
  }
  let host = typeof opts.hostname === 'string' ? opts.hostname.trim() : '';
  if (!host) {
    try { host = hostname() || ''; } catch { host = ''; }
  }
  return { home, user, host };
}

/**
 * Redacts secrets, home directories, OS usernames, and hostnames from free text.
 * @param {string} [text='']
 * @param {{ homedir?: string, username?: string, hostname?: string }} [opts={}]
 */
export function sanitizeDebugText(text = '', opts = {}) {
  if (typeof text !== 'string' || !text) return '';
  let out = redactSecretsInText(text);
  const { home, user, host } = resolveUserIdentityHints(opts);

  if (home && home.length >= 3) {
    const winHome = home.replace(/\//g, '\\').replace(/\\+$/, '');
    const posixHome = home.replace(/\\/g, '/').replace(/\/+$/, '');
    for (const variant of new Set([winHome, posixHome])) {
      if (!variant) continue;
      const flags = process.platform === 'win32' ? 'gi' : 'g';
      out = out.replace(new RegExp(escapeRegexLiteral(variant), flags), '<HOME>');
    }
  }

  out = out.replace(/([A-Za-z]:\\Users\\)([^\\/:*?"<>|\r\n\s]+)/gi, '$1<USER>');
  out = out.replace(/(\/(?:Users|home)\/)([^/\r\n\s]+)/g, '$1<USER>');

  if (user && user.length >= 3) {
    const flags = process.platform === 'win32' ? 'gi' : 'g';
    out = out.replace(new RegExp(`\\b${escapeRegexLiteral(user)}\\b`, flags), '<USER>');
  }

  if (host && host.length >= 3 && !/^(?:localhost|127\.0\.0\.1)$/i.test(host)) {
    out = out.replace(new RegExp(`\\b${escapeRegexLiteral(host)}\\b`, 'gi'), '<HOST>');
  }

  if (out.length > MAX_STRING_LEN) {
    return `${out.slice(0, MAX_STRING_LEN)}…[truncated]`;
  }
  return out;
}

/**
 * Recursively sanitizes structured metadata for safe persistence and export.
 * @param {any} value
 * @param {{ homedir?: string, username?: string, hostname?: string }} [opts={}]
 * @param {number} [depth=0]
 */
export function sanitizeDebugPayload(value, opts = {}, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return sanitizeDebugText(value, opts);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Error) {
    return {
      name: sanitizeDebugText(value.name || 'Error', opts),
      message: sanitizeDebugText(value.message || '', opts),
      stack: sanitizeDebugText(String(value.stack || '').slice(0, 1200), opts),
    };
  }
  if (depth >= MAX_DEPTH) return '[max-depth]';
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeDebugPayload(item, opts, depth + 1));
  }
  if (typeof value === 'object') {
    const out = {};
    const keys = Object.keys(value).slice(0, MAX_OBJECT_KEYS);
    for (const k of keys) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      if (SENSITIVE_KEY_RE.test(k)) {
        out[k] = '[REDACTED]';
        continue;
      }
      out[k] = sanitizeDebugPayload(value[k], opts, depth + 1);
    }
    return out;
  }
  return String(value);
}

function rotateLogIfNeeded(activePath, prevPath, maxBytes) {
  try {
    if (!existsSync(activePath)) return;
    const st = statSync(activePath);
    if (Number(st.size || 0) < maxBytes) return;
    try {
      if (existsSync(prevPath)) unlinkSync(prevPath);
    } catch {}
    renameSync(activePath, prevPath);
  } catch {}
}

/**
 * Appends a single sanitized NDJSON entry if enabled by `debugLogMode`. Never throws.
 * @param {object} [entry={}]
 * @param {{ pluginRoot?: string, state?: object | null, maxBytes?: number, force?: boolean }} [opts={}]
 */
export function appendDebugLog(entry = {}, opts = {}) {
  try {
    const safeOpts = opts && typeof opts === 'object' ? opts : {};
    const safeEntry = entry && typeof entry === 'object' ? entry : {};
    const level = ['debug', 'info', 'warn', 'error'].includes(String(safeEntry.level || '').toLowerCase())
      ? String(safeEntry.level).toLowerCase()
      : 'info';
    const root = resolvePluginRoot(safeOpts.pluginRoot);
    const mode = resolveDebugLogMode(safeOpts.state || null, root);
    if (!safeOpts.force && !shouldLogDebug(level, mode)) {
      return false;
    }

    const { cacheDir, activePath, prevPath } = getDebugLogPaths(root);
    mkdirSync(cacheDir, { recursive: true });
    const maxBytes = Math.max(1024, Number(safeOpts.maxBytes) || DEFAULT_MAX_LOG_BYTES);
    rotateLogIfNeeded(activePath, prevPath, maxBytes);

    const nowMs = Number.isFinite(Number(safeEntry.ts)) ? Number(safeEntry.ts) : Date.now();
    const record = {
      ts: nowMs,
      iso: new Date(nowMs).toISOString(),
      level,
      source: sanitizeDebugText(String(safeEntry.source || 'core').slice(0, 64), safeOpts),
      event: sanitizeDebugText(String(safeEntry.event || 'log').slice(0, 96), safeOpts),
      message: sanitizeDebugText(String(safeEntry.message || '').slice(0, 1200), safeOpts),
    };
    if (Number.isFinite(Number(safeEntry.durationMs))) {
      record.durationMs = Math.max(0, Math.round(Number(safeEntry.durationMs)));
    }
    if (safeEntry.meta !== undefined) {
      record.meta = sanitizeDebugPayload(safeEntry.meta, safeOpts);
    }

    appendFileSync(activePath, `${JSON.stringify(record)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

function readNdjsonFileSafe(filePath) {
  if (!existsSync(filePath)) return { entries: [], bytes: 0 };
  try {
    const st = statSync(filePath);
    const raw = readFileSync(filePath, 'utf8');
    const entries = [];
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object') entries.push(parsed);
      } catch {}
    }
    return { entries, bytes: Number(st.size || 0) };
  } catch {
    return { entries: [], bytes: 0 };
  }
}

/**
 * Reads recorded entries from rotated + active NDJSON logs.
 * @param {{ pluginRoot?: string, limit?: number, level?: string }} [options={}]
 */
export function readDebugLogEntries(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const root = resolvePluginRoot(opts.pluginRoot);
  const { activePath, prevPath } = getDebugLogPaths(root);
  const prev = readNdjsonFileSafe(prevPath);
  const active = readNdjsonFileSafe(activePath);
  const all = [...prev.entries, ...active.entries];

  let errorCount = 0;
  let warnCount = 0;
  let lastEntryAt = 0;
  for (const item of all) {
    const lvl = String(item.level || '').toLowerCase();
    if (lvl === 'error') errorCount += 1;
    else if (lvl === 'warn') warnCount += 1;
    if (Number(item.ts || 0) > lastEntryAt) lastEntryAt = Number(item.ts || 0);
  }

  const filterLevel = String(opts.level || 'all').trim().toLowerCase();
  const filtered = filterLevel && filterLevel !== 'all'
    ? all.filter((it) => String(it.level || '').toLowerCase() === filterLevel)
    : all;

  const limit = Math.max(1, Math.min(2000, Number(opts.limit) || 250));
  const sliced = filtered.slice(-limit);

  return {
    totalEntries: all.length,
    filteredEntries: filtered.length,
    errorCount,
    warnCount,
    fileSizeBytes: prev.bytes + active.bytes,
    lastEntryAt,
    entries: sliced,
  };
}

/**
 * Deletes active and rotated debug log files.
 * @param {{ pluginRoot?: string }} [options={}]
 */
export function clearDebugLog(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const { activePath, prevPath } = getDebugLogPaths(opts.pluginRoot);
  let cleared = 0;
  for (const fp of [activePath, prevPath]) {
    try {
      if (existsSync(fp)) {
        unlinkSync(fp);
        cleared += 1;
      }
    } catch {}
  }
  return { ok: true, clearedFiles: cleared };
}

/**
 * Returns summary status of the debug logger for UI badges and APIs.
 * @param {{ pluginRoot?: string, state?: object | null }} [options={}]
 */
export function getDebugLogStatus(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const root = resolvePluginRoot(opts.pluginRoot);
  const mode = resolveDebugLogMode(opts.state || null, root);
  const stats = readDebugLogEntries({ pluginRoot: root, limit: 1 });
  return {
    ok: true,
    mode,
    enabled: mode !== 'off',
    verbose: mode === 'verbose',
    totalEntries: stats.totalEntries,
    errorCount: stats.errorCount,
    warnCount: stats.warnCount,
    fileSizeBytes: stats.fileSizeBytes,
    lastEntryAt: stats.lastEntryAt,
  };
}

function readLocalPluginInfo(root) {
  const pluginManifest = safeReadJsonSync(join(root, 'plugin.json'), null, { selfHeal: false });
  const pkgManifest = safeReadJsonSync(join(root, 'package.json'), null, { selfHeal: false });
  const version = (typeof pluginManifest?.version === 'string' && pluginManifest.version.trim())
    || (typeof pkgManifest?.version === 'string' && pkgManifest.version.trim())
    || '4.0.5';
  const name = (typeof pluginManifest?.name === 'string' && pluginManifest.name.trim())
    || (typeof pkgManifest?.name === 'string' && pkgManifest.name.trim())
    || 'antigravity-model-router';
  const repo = (typeof pluginManifest?.repository === 'string' && pluginManifest.repository.trim())
    || 'vaszuevvas-coder/antigravity-model-router';
  return { name, version, repo };
}

/**
 * Builds a complete anonymized diagnostic bundle ready to save as JSON and share with maintainers.
 * @param {object} [options={}]
 */
export function buildDiagnosticBundle(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const root = resolvePluginRoot(opts.pluginRoot);
  const meta = readLocalPluginInfo(root);
  const mode = resolveDebugLogMode(opts.state || null, root);
  const logStats = readDebugLogEntries({
    pluginRoot: root,
    limit: Math.max(1, Math.min(1000, Number(opts.limit) || 400)),
  });

  const rawState = opts.state && typeof opts.state === 'object' ? { ...opts.state } : {};
  if (Array.isArray(rawState.federatedWorkspaces)) {
    rawState.federatedWorkspaces = rawState.federatedWorkspaces.map((_w, i) => `<FEDERATED_WS_${i + 1}>`);
  }

  const rawBundle = {
    schemaVersion: '1.0',
    generatedAt: new Date().toISOString(),
    plugin: {
      name: meta.name,
      version: meta.version,
      repo: meta.repo,
    },
    environment: {
      platform: platform(),
      osRelease: release(),
      arch: arch(),
      nodeVersion: process.version,
    },
    debugLog: {
      mode,
      totalEntries: logStats.totalEntries,
      errorCount: logStats.errorCount,
      warnCount: logStats.warnCount,
      fileSizeBytes: logStats.fileSizeBytes,
      lastEntryAt: logStats.lastEntryAt,
    },
    state: rawState,
    health: opts.healthReport || null,
    runtime: {
      updateStatus: opts.updateStatus || null,
      ram: opts.ramStatus ? {
        daemonRunning: Boolean(opts.ramStatus.daemonRunning),
        filesCount: Number(opts.ramStatus.filesCount || 0),
        usedMb: Number(opts.ramStatus.usedMb || 0),
        budgetMb: Number(opts.ramStatus.budgetMb || 0),
      } : null,
      gpu: opts.gpuStatus ? {
        reachable: Boolean(opts.gpuStatus.reachable),
        chatModel: opts.gpuStatus.chatModel || '',
        embedModel: opts.gpuStatus.embedModel || '',
        error: opts.gpuStatus.error || '',
      } : null,
    },
    entries: logStats.entries,
  };

  return sanitizeDebugPayload(rawBundle, opts);
}

/**
 * Formats a concise Markdown summary from an already-sanitized diagnostic bundle.
 * @param {object} bundle
 * @param {string} [lang='ru']
 */
export function formatDiagnosticBundleSummary(bundle = {}, lang = 'ru') {
  const isEn = String(lang || 'ru').trim().toLowerCase() === 'en';
  const b = bundle && typeof bundle === 'object' ? bundle : {};
  const plugin = b.plugin || {};
  const env = b.environment || {};
  const dbg = b.debugLog || {};
  const entries = Array.isArray(b.entries) ? b.entries : [];
  const recentErrors = entries.filter((e) => e && (e.level === 'error' || e.level === 'warn')).slice(-8);

  const lines = [
    isEn
      ? `### The Tunnel Diagnostic Report (v${plugin.version || '?'})`
      : `### Отчёт диагностики The Tunnel (v${plugin.version || '?'})`,
    `- **Generated:** ${b.generatedAt || new Date().toISOString()}`,
    `- **OS / Node:** ${env.platform || '?'} ${env.osRelease || ''} (${env.arch || '?'}) · Node ${env.nodeVersion || '?'}`,
    `- **Debug Mode:** \`${dbg.mode || 'errors'}\` · Entries: ${Number(dbg.totalEntries || 0)} (errors: ${Number(dbg.errorCount || 0)}, warns: ${Number(dbg.warnCount || 0)})`,
  ];

  if (b.health && typeof b.health === 'object') {
    const score = b.health.score !== undefined ? `${b.health.score}/100` : 'n/a';
    const issues = Array.isArray(b.health.issues) ? b.health.issues.length : 0;
    lines.push(`- **Health-Doctor:** ${score} (issues: ${issues})`);
  }

  if (recentErrors.length > 0) {
    lines.push('', isEn ? '#### Recent Errors / Warnings' : '#### Последние ошибки и предупреждения');
    for (const err of recentErrors) {
      lines.push(`- \`[${err.iso || ''}] [${String(err.level || 'error').toUpperCase()}] [${err.source || 'core'}:${err.event || 'log'}]\` ${err.message || ''}`);
    }
  } else {
    lines.push('', isEn ? '_No errors or warnings recorded in log._' : '_Ошибок и предупреждений в логе не зафиксировано._');
  }

  return lines.join('\n');
}

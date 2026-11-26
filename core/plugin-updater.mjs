/**
 * @file plugin-updater.mjs
 * @description Safe GitHub update checker and 1-click installer for The Tunnel plugin.
 */

import { execFile } from 'node:child_process';
import { setDefaultResultOrder } from 'node:dns';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { normalizeLang } from './i18n.mjs';
import { atomicWriteJsonSync, safeReadJsonSync } from './safe-json.mjs';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PLUGIN_ROOT = resolve(__dirname, '..');

export const DEFAULT_GITHUB_REPO = 'vaszuevvas-coder/antigravity-model-router';
export const UPDATE_CHECK_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
export const MAX_UPDATE_ARCHIVE_BYTES = 80 * 1024 * 1024;

export const ALLOWED_GITHUB_HOSTS = new Set([
  'github.com',
  'api.github.com',
  'codeload.github.com',
  'raw.githubusercontent.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);

export const PRESERVED_ROOT_ENTRIES = new Set([
  'router-state.json',
  '.cache',
  'checkpoints',
  'backups',
  '.git',
  '.shadow',
  'node_modules',
  'scratch',
  '.agents',
]);

const activeJobs = new Map();

function resolvePluginRoot(pluginRoot = '') {
  const clean = typeof pluginRoot === 'string' ? pluginRoot.trim() : '';
  return clean ? resolve(clean) : DEFAULT_PLUGIN_ROOT;
}

function getCacheFilePath(pluginRoot = '') {
  return join(resolvePluginRoot(pluginRoot), '.cache', 'plugin-update-check.json');
}

function getStatusFilePath(pluginRoot = '') {
  return join(resolvePluginRoot(pluginRoot), '.cache', 'plugin-update-status.json');
}

function createIdleStatus(pluginRoot = '') {
  return {
    ok: true,
    active: false,
    phase: 'idle',
    percent: 0,
    downloadedBytes: 0,
    totalBytes: 0,
    pluginRoot: resolvePluginRoot(pluginRoot),
    installedTarget: '',
    targetVersion: '',
    needsRestart: false,
    startedAt: 0,
    updatedAt: 0,
    finishedAt: 0,
    statusText: '',
    statusTextRu: '',
    statusTextEn: '',
    error: '',
    dismissed: false,
  };
}

/**
 * Parses a SemVer string such as "v3.34.0" or "3.34.0-rc.1".
 * @param {string} rawVersion
 * @returns {{ major: number, minor: number, patch: number, prerelease: string[], version: string } | null}
 */
export function parseSemver(rawVersion = '') {
  if (typeof rawVersion !== 'string') return null;
  const trimmed = rawVersion.trim().replace(/^v/i, '');
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/.exec(trimmed);
  if (!m) return null;
  if (m[4] && (m[4].startsWith('.') || m[4].endsWith('.') || m[4].includes('..'))) return null;
  if (m[5] && (m[5].startsWith('.') || m[5].endsWith('.') || m[5].includes('..'))) return null;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3]);
  if (!Number.isInteger(major) || !Number.isInteger(minor) || !Number.isInteger(patch)) return null;
  const preRaw = m[4] || '';
  const prerelease = preRaw ? preRaw.split('.') : [];
  const version = `${major}.${minor}.${patch}${preRaw ? `-${preRaw}` : ''}`;
  return { major, minor, patch, prerelease, version };
}

/**
 * Compares two SemVer strings (-1 if a < b, 0 if equal, 1 if a > b).
 * Returns 0 if either version is invalid.
 * @param {string} a
 * @param {string} b
 * @returns {-1 | 0 | 1}
 */
export function compareSemver(a = '', b = '') {
  const pa = parseSemver(String(a || ''));
  const pb = parseSemver(String(b || ''));
  if (!pa || !pb) return 0;

  for (const field of ['major', 'minor', 'patch']) {
    if (pa[field] > pb[field]) return 1;
    if (pa[field] < pb[field]) return -1;
  }

  const aPre = pa.prerelease;
  const bPre = pb.prerelease;
  if (aPre.length === 0 && bPre.length === 0) return 0;
  if (aPre.length === 0) return 1;
  if (bPre.length === 0) return -1;

  const len = Math.max(aPre.length, bPre.length);
  for (let i = 0; i < len; i++) {
    if (i >= aPre.length) return -1;
    if (i >= bPre.length) return 1;
    const x = aPre[i];
    const y = bPre[i];
    if (x === y) continue;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) {
      const xn = Number(x);
      const yn = Number(y);
      if (xn !== yn) return xn > yn ? 1 : -1;
    } else if (xNum !== yNum) {
      // Numeric pre-release identifiers have lower precedence than non-numeric ones per SemVer 2.0.0
      return xNum ? -1 : 1;
    } else {
      return x > y ? 1 : -1;
    }
  }
  return 0;
}

/**
 * Validates that a download or API URL uses HTTPS and belongs to an allowlisted GitHub host.
 * @param {string} rawUrl
 * @returns {boolean}
 */
export function isAllowedGitHubUrl(rawUrl = '') {
  if (typeof rawUrl !== 'string') return false;
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.length > 1024 || /[\r\n\0]/.test(trimmed)) return false;
  try {
    const u = new URL(trimmed);
    if (u.protocol !== 'https:') return false;
    if (u.username || u.password) return false;
    return ALLOWED_GITHUB_HOSTS.has(String(u.hostname || '').toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Extracts `owner/repo` slug from a GitHub URL or slug string.
 * @param {string} rawRepo
 * @returns {string}
 */
export function parseGitHubRepoSlug(rawRepo = '') {
  if (typeof rawRepo !== 'string') return '';
  const trimmed = rawRepo.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmed)) {
    return trimmed.replace(/\.git$/i, '');
  }
  try {
    const u = new URL(trimmed);
    if (u.hostname.toLowerCase() !== 'github.com') return '';
    const parts = u.pathname.replace(/^\/+|\/+$/g, '').split('/');
    if (parts.length >= 2 && parts[0] && parts[1]) {
      return `${parts[0]}/${parts[1].replace(/\.git$/i, '')}`;
    }
  } catch {}
  return '';
}

/**
 * Reads plugin metadata (version and GitHub repo) from plugin.json with package.json fallback.
 * @param {string} [pluginRoot]
 */
export function readPluginMeta(pluginRoot = '') {
  const root = resolvePluginRoot(pluginRoot);
  const pluginManifest = safeReadJsonSync(join(root, 'plugin.json'), null, { selfHeal: false });
  const pkgManifest = safeReadJsonSync(join(root, 'package.json'), null, { selfHeal: false });

  const rawVer = (typeof pluginManifest?.version === 'string' && pluginManifest.version.trim())
    || (typeof pkgManifest?.version === 'string' && pkgManifest.version.trim())
    || '4.0.2';
  const version = parseSemver(rawVer)?.version || '4.0.2';

  const rawRepo =
    pluginManifest?.repository?.url
    || pluginManifest?.repository
    || pluginManifest?.homepage
    || pkgManifest?.repository?.url
    || pkgManifest?.repository
    || '';
  const repo = parseGitHubRepoSlug(typeof rawRepo === 'string' ? rawRepo : '') || DEFAULT_GITHUB_REPO;

  return {
    pluginRoot: root,
    version,
    repo,
    homepage: `https://github.com/${repo}`,
  };
}

/**
 * Returns true in automated test contexts so existing tests never make live network calls to GitHub.
 * @returns {boolean}
 */
export function isUpdateCheckDisabledByEnv() {
  if (process.env.TUNNEL_DISABLE_UPDATE_CHECK === '1') return true;
  if (typeof process.env.TUNNEL_TEST_STATE_PATH === 'string' && process.env.TUNNEL_TEST_STATE_PATH.trim()) return true;
  if (process.env.NODE_TEST_CONTEXT) return true;
  return false;
}

function compactUpdateError(err, maxLen = 220) {
  const raw = String(err?.message || err || 'Unknown error').replace(/\s+/g, ' ').trim();
  if (raw.length <= maxLen) return raw;
  return `${raw.slice(0, maxLen - 1)}…`;
}

function formatUpdateError(err, lang = 'ru') {
  const raw = compactUpdateError(err);
  const isEn = normalizeLang(lang, 'ru') === 'en';
  if (/HTTP\s*403\b|rate\s*limit/i.test(raw)) {
    return isEn ? `GitHub rate limit reached (${raw})` : `Лимит запросов GitHub (${raw})`;
  }
  if (/HTTP\s*404\b/i.test(raw)) {
    return isEn ? `Release archive not found on GitHub (${raw})` : `Архив релиза не найден на GitHub (${raw})`;
  }
  if (/AbortError|TimeoutError|timed out|timeout/i.test(raw)) {
    return isEn ? `Connection timed out (${raw})` : `Превышено время ожидания сети (${raw})`;
  }
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|fetch failed|network/i.test(raw)) {
    return isEn ? `Network error connecting to GitHub (${raw})` : `Ошибка сети при подключении к GitHub (${raw})`;
  }
  if (/EBUSY|EPERM|EACCES/i.test(raw)) {
    return isEn ? `Plugin file is locked by another process (${raw})` : `Файл плагина занят другим процессом (${raw})`;
  }
  return raw;
}

let ipv4DnsConfigured = false;
function ensureIpv4FirstDns() {
  if (ipv4DnsConfigured) return;
  ipv4DnsConfigured = true;
  try {
    setDefaultResultOrder('ipv4first');
  } catch {}
}

function isRetryableNetworkError(err) {
  const name = String(err?.name || '');
  const code = String(err?.code || err?.cause?.code || '');
  const msg = String(err?.message || err || '');
  return /AbortError|TimeoutError|timed out|timeout|fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|UND_ERR/i.test(
    `${name} ${code} ${msg}`
  );
}

let cachedSystemProxy = { checkedAt: 0, url: '' };
function sanitizeProxyUrl(raw = '') {
  const s = String(raw || '').trim();
  if (!s || /[\s\r\n\0]/.test(s)) return '';
  const withProto = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`;
  try {
    const u = new URL(withProto);
    if (!u.hostname || (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'socks5:' && u.protocol !== 'socks5h:')) {
      return '';
    }
    return u.href.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

async function detectSystemProxyUrl() {
  const envRaw = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || process.env.ALL_PROXY || process.env.all_proxy || '';
  const envProxy = sanitizeProxyUrl(envRaw);
  if (envProxy) return envProxy;

  if (process.platform !== 'win32') return '';
  const now = Date.now();
  if (now - cachedSystemProxy.checkedAt < 60_000) {
    return cachedSystemProxy.url;
  }

  let detected = '';
  try {
    const { stdout } = await execFileAsync(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
      { windowsHide: true, timeout: 2500 }
    );
    const enabledMatch = /ProxyEnable\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(stdout);
    const enabled = enabledMatch ? parseInt(enabledMatch[1], 16) !== 0 : false;
    if (enabled) {
      const serverMatch = /ProxyServer\s+REG_SZ\s+([^\r\n]+)/i.exec(stdout);
      const rawServer = (serverMatch?.[1] || '').trim();
      if (rawServer) {
        let candidate = rawServer;
        if (rawServer.includes('=')) {
          const parts = rawServer.split(';').map((p) => p.trim()).filter(Boolean);
          const httpsPart = parts.find((p) => /^https=/i.test(p));
          const httpPart = parts.find((p) => /^http=/i.test(p));
          const socksPart = parts.find((p) => /^socks=/i.test(p));
          const chosen = httpsPart || httpPart || socksPart || parts[0] || '';
          const eqIdx = chosen.indexOf('=');
          const scheme = eqIdx > 0 ? chosen.slice(0, eqIdx).toLowerCase() : '';
          const hostPort = eqIdx > 0 ? chosen.slice(eqIdx + 1).trim() : chosen;
          candidate = scheme === 'socks' ? `socks5h://${hostPort}` : `http://${hostPort}`;
        }
        detected = sanitizeProxyUrl(candidate);
      }
    }
  } catch {}

  cachedSystemProxy = { checkedAt: now, url: detected };
  return detected;
}

async function defaultFallbackHttpGet(url, { headers = {}, timeoutMs = 15000, followRedirects = true } = {}) {
  if (!isAllowedGitHubUrl(url)) {
    throw new Error('Untrusted GitHub URL');
  }
  const curlBin = process.platform === 'win32' ? 'curl.exe' : 'curl';
  const maxSecs = String(Math.max(2, Math.ceil((Number(timeoutMs) || 15000) / 1000)));
  const proxyUrl = await detectSystemProxyUrl();
  const marker = '__TUNNEL_CURL_META__';
  const args = [
    '-4',
    '-sS',
    '--max-time',
    maxSecs,
    '-w',
    `\n${marker}\n%{http_code}\n%{redirect_url}\n%{url_effective}`,
  ];
  if (followRedirects) {
    args.push('-L', '--max-redirs', '5');
  }
  if (proxyUrl) {
    args.push('--proxy', proxyUrl);
  }
  for (const [k, v] of Object.entries(headers || {})) {
    if (!k || v === undefined || v === null) continue;
    args.push('-H', `${k}: ${String(v)}`);
  }
  args.push(url);

  const { stdout } = await execFileAsync(curlBin, args, {
    windowsHide: true,
    timeout: Math.max(5000, (Number(timeoutMs) || 15000) + 3000),
    maxBuffer: 4 * 1024 * 1024,
  });

  const idx = stdout.lastIndexOf(`\n${marker}\n`);
  if (idx < 0) {
    throw new Error('Malformed curl response');
  }
  const body = stdout.slice(0, idx);
  const metaLines = stdout.slice(idx + marker.length + 2).split(/\r?\n/);
  const status = Number(metaLines[0] || 0);
  const redirectUrl = String(metaLines[1] || '').trim();
  const effectiveUrl = String(metaLines[2] || '').trim() || url;

  if (effectiveUrl && !isAllowedGitHubUrl(effectiveUrl)) {
    throw new Error(`Untrusted redirect target: ${effectiveUrl}`);
  }
  return {
    ok: status >= 200 && status < 300,
    status,
    url: effectiveUrl,
    headers: {
      get: (key) => (String(key || '').toLowerCase() === 'location' ? redirectUrl : ''),
    },
    json: async () => JSON.parse(body),
    text: async () => body,
  };
}

async function defaultFallbackDownloadFile(
  urlStr,
  destZipPath,
  currentVersion,
  { timeoutMs = 45000, onProgress = null } = {}
) {
  if (!isAllowedGitHubUrl(urlStr)) {
    throw new Error('Untrusted download URL');
  }
  const curlBin = process.platform === 'win32' ? 'curl.exe' : 'curl';
  const maxSecs = String(Math.max(5, Math.ceil((Number(timeoutMs) || 45000) / 1000)));
  const proxyUrl = await detectSystemProxyUrl();
  const args = [
    '-4',
    '-sS',
    '-L',
    '--max-redirs',
    '5',
    '--max-time',
    maxSecs,
    '--max-filesize',
    String(MAX_UPDATE_ARCHIVE_BYTES),
    '-A',
    `antigravity-model-router/${currentVersion}`,
    '-o',
    destZipPath,
    '-w',
    '%{http_code}\n%{url_effective}',
  ];
  if (proxyUrl) {
    args.push('--proxy', proxyUrl);
  }
  args.push(urlStr);

  const cleanupDest = () => {
    try {
      if (existsSync(destZipPath)) unlinkSync(destZipPath);
    } catch {}
  };

  let stdout = '';
  try {
    ({ stdout } = await execFileAsync(curlBin, args, {
      windowsHide: true,
      timeout: Math.max(8000, (Number(timeoutMs) || 45000) + 5000),
      maxBuffer: 1024 * 1024,
    }));
  } catch (err) {
    cleanupDest();
    throw err;
  }

  const lines = String(stdout || '').trim().split(/\r?\n/);
  const status = Number(lines[0] || 0);
  const effectiveUrl = String(lines[1] || '').trim();
  if (effectiveUrl && !isAllowedGitHubUrl(effectiveUrl)) {
    cleanupDest();
    throw new Error(`Untrusted redirect target: ${effectiveUrl}`);
  }
  if (!Number.isFinite(status) || status < 200 || status >= 300) {
    cleanupDest();
    throw new Error(`Archive download HTTP ${status || 'unknown'}`);
  }
  if (!existsSync(destZipPath)) {
    throw new Error('Downloaded update archive is empty');
  }
  const size = statSync(destZipPath).size;
  if (size <= 0) {
    cleanupDest();
    throw new Error('Downloaded update archive is empty');
  }
  if (size > MAX_UPDATE_ARCHIVE_BYTES) {
    cleanupDest();
    throw new Error(`Update archive exceeds ${MAX_UPDATE_ARCHIVE_BYTES} bytes`);
  }
  if (typeof onProgress === 'function') {
    try { onProgress(size, size); } catch {}
  }
  return size;
}

/**
 * Returns the persisted or active update installer status for a plugin root.
 * @param {string} [pluginRoot]
 */
export function getPluginUpdateStatus(pluginRoot = '') {
  const root = resolvePluginRoot(pluginRoot);
  const mem = activeJobs.get(root);
  if (mem?.status) {
    return { ...mem.status };
  }
  const disk = safeReadJsonSync(getStatusFilePath(root), null, { selfHeal: false });
  if (disk && typeof disk === 'object' && !Array.isArray(disk)) {
    const base = createIdleStatus(root);
    const merged = { ...base, ...disk, pluginRoot: root };
    // Clear stale active lock left behind by an earlier process exit
    if (merged.active) {
      merged.active = false;
      if (merged.phase && merged.phase !== 'done' && merged.phase !== 'error' && merged.phase !== 'idle') {
        merged.phase = 'idle';
      }
    }
    return merged;
  }
  return createIdleStatus(root);
}

/**
 * Clears any visible update status banner state on disk.
 * @param {string} [pluginRoot]
 */
export function clearPluginUpdateStatus(pluginRoot = '') {
  const root = resolvePluginRoot(pluginRoot);
  const idle = { ...createIdleStatus(root), dismissed: true, updatedAt: Date.now() };
  const mem = activeJobs.get(root);
  if (mem && !mem.active) {
    mem.status = idle;
  }
  try {
    atomicWriteJsonSync(getStatusFilePath(root), idle);
  } catch {}
  return idle;
}

function persistUpdateStatus(pluginRoot, nextStatus) {
  try {
    atomicWriteJsonSync(getStatusFilePath(pluginRoot), nextStatus);
  } catch {}
}

/**
 * Checks GitHub releases (with IPv4-first DNS, proxy/curl fallback, and release-redirect / main-branch fallbacks)
 * for newer versions. Uses a 6h disk cache unless `force: true` is passed.
 * @param {object} [options={}]
 */
export async function checkForPluginUpdate(options = {}) {
  const {
    pluginRoot = '',
    force = false,
    cacheTtlMs = UPDATE_CHECK_CACHE_TTL_MS,
    fetchFn = null,
    fallbackHttpFn = null,
    timeoutMs = 15000,
    lang = 'ru',
    allowInTests = false,
  } = options && typeof options === 'object' ? options : {};

  const meta = readPluginMeta(pluginRoot);
  const cachePath = getCacheFilePath(meta.pluginRoot);

  if (typeof fetchFn !== 'function' && !allowInTests && isUpdateCheckDisabledByEnv()) {
    return {
      ok: true,
      skipped: true,
      repo: meta.repo,
      currentVersion: meta.version,
      latestVersion: meta.version,
      updateAvailable: false,
      releaseUrl: meta.homepage,
      downloadUrl: '',
      releaseNotes: '',
      publishedAt: '',
      source: 'skipped_test_env',
      checkedAt: Date.now(),
      cached: false,
    };
  }

  if (!force) {
    const cached = safeReadJsonSync(cachePath, null, { selfHeal: false });
    if (
      cached &&
      typeof cached === 'object' &&
      cached.ok === true &&
      cached.repo === meta.repo &&
      cached.currentVersion === meta.version &&
      Number.isFinite(Number(cached.checkedAt)) &&
      (Date.now() - Number(cached.checkedAt)) < Math.max(0, Number(cacheTtlMs) || 0)
    ) {
      const updateAvailable = compareSemver(cached.latestVersion, meta.version) > 0;
      return {
        ...cached,
        updateAvailable,
        cached: true,
      };
    }
  }

  const useRealNetwork = typeof fetchFn !== 'function';
  if (useRealNetwork) {
    ensureIpv4FirstDns();
  }

  const fetchImpl = !useRealNetwork ? fetchFn : globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    return {
      ok: false,
      skipped: false,
      repo: meta.repo,
      currentVersion: meta.version,
      latestVersion: meta.version,
      updateAvailable: false,
      releaseUrl: meta.homepage,
      downloadUrl: '',
      releaseNotes: '',
      publishedAt: '',
      source: 'error',
      error: 'Fetch API unavailable',
      checkedAt: Date.now(),
      cached: false,
    };
  }

  const reqHeaders = {
    Accept: 'application/vnd.github+json',
    'User-Agent': `antigravity-model-router/${meta.version}`,
  };

  const buildSignal = () => (
    typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(Math.max(1000, Number(timeoutMs) || 15000))
      : undefined
  );

  const requestWithFallback = async (url, { followRedirects = true } = {}) => {
    try {
      return await fetchImpl(url, {
        headers: reqHeaders,
        redirect: followRedirects ? 'follow' : 'manual',
        signal: buildSignal(),
      });
    } catch (err) {
      if (isRetryableNetworkError(err)) {
        if (typeof fallbackHttpFn === 'function') {
          return await fallbackHttpFn(url, { headers: reqHeaders, timeoutMs, followRedirects });
        }
        if (useRealNetwork) {
          return await defaultFallbackHttpGet(url, { headers: reqHeaders, timeoutMs, followRedirects });
        }
      }
      throw err;
    }
  };

  const fetchBranchFallback = async () => {
    const rawPluginUrl = `https://raw.githubusercontent.com/${meta.repo}/main/plugin.json`;
    const branchRes = await requestWithFallback(rawPluginUrl);
    if (!branchRes || !branchRes.ok) {
      throw new Error(`GitHub manifest HTTP ${branchRes ? branchRes.status : 'unknown'}`);
    }
    const manifest = await branchRes.json();
    const parsedBranchVer = parseSemver(String(manifest?.version || ''));
    if (!parsedBranchVer) {
      throw new Error('Invalid remote plugin.json version');
    }
    return {
      latestVersion: parsedBranchVer.version,
      releaseUrl: meta.homepage,
      downloadUrl: `https://codeload.github.com/${meta.repo}/zip/refs/heads/main`,
      releaseNotes: '',
      publishedAt: '',
      source: 'branch',
    };
  };

  try {
    const releaseApiUrl = `https://api.github.com/repos/${meta.repo}/releases/latest`;
    let res = null;
    let primaryErr = null;
    try {
      res = await requestWithFallback(releaseApiUrl);
    } catch (err) {
      primaryErr = err;
    }

    let latestVersion = '';
    let releaseUrl = `${meta.homepage}/releases`;
    let downloadUrl = '';
    let releaseNotes = '';
    let publishedAt = '';
    let source = 'release';

    if (res && res.status === 404) {
      ({ latestVersion, releaseUrl, downloadUrl, releaseNotes, publishedAt, source } = await fetchBranchFallback());
    } else if (res && res.ok) {
      const rel = await res.json();
      const rawTag = String(rel?.tag_name || '').trim();
      const parsedRelVer = parseSemver(rawTag) || parseSemver(String(rel?.name || ''));
      if (!parsedRelVer) {
        throw new Error(`Invalid release tag: ${rawTag || '?'}`);
      }
      latestVersion = parsedRelVer.version;
      if (typeof rel?.html_url === 'string' && isAllowedGitHubUrl(rel.html_url)) {
        releaseUrl = rel.html_url.trim();
      }
      const assets = Array.isArray(rel?.assets) ? rel.assets : [];
      const zipAsset = assets.find((a) => (
        typeof a?.browser_download_url === 'string' &&
        /\.zip(?:$|\?)/i.test(a.browser_download_url) &&
        isAllowedGitHubUrl(a.browser_download_url)
      ));
      const tagForUrl = rawTag || `v${latestVersion}`;
      downloadUrl = zipAsset
        ? zipAsset.browser_download_url.trim()
        : `https://codeload.github.com/${meta.repo}/zip/refs/tags/${encodeURIComponent(tagForUrl)}`;
      releaseNotes = String(rel?.body || '').trim().slice(0, 600);
      publishedAt = typeof rel?.published_at === 'string' ? rel.published_at.trim() : '';
      source = 'release';
    } else {
      // Fallback 1: github.com/<repo>/releases/latest redirect -> /releases/tag/vX.Y.Z
      try {
        const webLatestUrl = `https://github.com/${meta.repo}/releases/latest`;
        const redirRes = await requestWithFallback(webLatestUrl, { followRedirects: false });
        if (redirRes && ((redirRes.status >= 300 && redirRes.status < 400) || redirRes.ok)) {
          const loc = String(redirRes.headers?.get?.('location') || redirRes.url || '').trim();
          const tagMatch = /\/releases\/tag\/([^/?#]+)/i.exec(loc);
          if (tagMatch && tagMatch[1]) {
            const rawTag = decodeURIComponent(tagMatch[1]);
            const parsedTagVer = parseSemver(rawTag);
            if (parsedTagVer) {
              latestVersion = parsedTagVer.version;
              releaseUrl = `https://github.com/${meta.repo}/releases/tag/${encodeURIComponent(rawTag)}`;
              downloadUrl = `https://codeload.github.com/${meta.repo}/zip/refs/tags/${encodeURIComponent(rawTag)}`;
              source = 'release_redirect';
            }
          }
        }
      } catch {}

      // Fallback 2: raw.githubusercontent.com/<repo>/main/plugin.json
      if (!latestVersion) {
        try {
          ({ latestVersion, releaseUrl, downloadUrl, releaseNotes, publishedAt, source } = await fetchBranchFallback());
        } catch {}
      }

      if (!latestVersion) {
        throw primaryErr || new Error(`GitHub API HTTP ${res ? res.status : 'unknown'}`);
      }
    }

    if (!isAllowedGitHubUrl(downloadUrl)) {
      throw new Error('Untrusted download URL returned by GitHub');
    }

    const updateAvailable = compareSemver(latestVersion, meta.version) > 0;
    const payload = {
      ok: true,
      skipped: false,
      repo: meta.repo,
      currentVersion: meta.version,
      latestVersion,
      updateAvailable,
      releaseUrl,
      downloadUrl,
      releaseNotes,
      publishedAt,
      source,
      checkedAt: Date.now(),
      cached: false,
    };
    try {
      atomicWriteJsonSync(cachePath, payload);
    } catch {}
    return payload;
  } catch (err) {
    return {
      ok: false,
      skipped: false,
      repo: meta.repo,
      currentVersion: meta.version,
      latestVersion: meta.version,
      updateAvailable: false,
      releaseUrl: meta.homepage,
      downloadUrl: '',
      releaseNotes: '',
      publishedAt: '',
      source: 'error',
      error: formatUpdateError(err, lang),
      checkedAt: Date.now(),
      cached: false,
    };
  }
}

/**
 * Recursively verifies an extracted directory tree contains no symlinks or path-traversal escapes.
 * @param {string} extractDir
 * @returns {{ ok: true, fileCount: number }}
 */
export function validateExtractedTreeSafe(extractDir) {
  const baseAbs = resolve(String(extractDir || ''));
  if (!existsSync(baseAbs)) {
    throw new Error('Extracted directory does not exist');
  }
  const baseReal = realpathSync(baseAbs);
  let fileCount = 0;

  const walk = (curDir) => {
    const entries = readdirSync(curDir, { withFileTypes: true });
    for (const entry of entries) {
      const name = String(entry.name || '');
      if (!name || name === '.' || name === '..' || name.includes('\0')) {
        throw new Error(`Unsafe archive entry name: ${name}`);
      }
      const fullPath = resolve(curDir, name);
      const rel = relative(baseAbs, fullPath);
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
        throw new Error(`Archive path escape detected: ${name}`);
      }
      const lst = lstatSync(fullPath);
      if (lst.isSymbolicLink()) {
        throw new Error(`Unsafe symlink in update archive: ${rel}`);
      }
      const entryReal = realpathSync(fullPath);
      if (entryReal !== baseReal && !entryReal.startsWith(baseReal + sep)) {
        throw new Error(`Archive realpath escape detected: ${rel}`);
      }
      if (lst.isDirectory()) {
        walk(fullPath);
      } else {
        fileCount += 1;
      }
    }
  };

  walk(baseAbs);
  return { ok: true, fileCount };
}

/**
 * Resolves the safe installation target. When running from a `.git` dev repo,
 * updates the installed plugin directory instead of clobbering uncommitted source files.
 * @param {string} [pluginRoot]
 * @param {string} [explicitTargetDir]
 * @returns {string}
 */
export function resolveSafeInstallTarget(pluginRoot = '', explicitTargetDir = '') {
  const explicit = typeof explicitTargetDir === 'string' ? explicitTargetDir.trim() : '';
  if (explicit) return resolve(explicit);
  const root = resolvePluginRoot(pluginRoot);
  if (existsSync(join(root, '.git'))) {
    return join(homedir(), '.gemini', 'config', 'plugins', 'antigravity-model-router');
  }
  return root;
}

function findExtractedPluginRoot(extractDir) {
  const base = resolve(extractDir);
  if (existsSync(join(base, 'plugin.json')) || existsSync(join(base, 'package.json'))) {
    return base;
  }
  const entries = readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory());
  for (const dirEntry of entries) {
    const candidate = join(base, dirEntry.name);
    if (existsSync(join(candidate, 'plugin.json')) || existsSync(join(candidate, 'package.json'))) {
      return candidate;
    }
  }
  throw new Error('Update archive missing plugin.json');
}

async function defaultExtractZip(zipPath, destDir, platform = process.platform) {
  mkdirSync(destDir, { recursive: true });
  if (platform === 'win32') {
    const esc = (s) => `'${String(s || '').replace(/'/g, "''")}'`;
    const psCmd = `Expand-Archive -LiteralPath ${esc(zipPath)} -DestinationPath ${esc(destDir)} -Force`;
    await execFileAsync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', psCmd],
      { windowsHide: true, timeout: 60000 }
    );
    return;
  }
  try {
    await execFileAsync('unzip', ['-q', '-o', zipPath, '-d', destDir], { timeout: 60000 });
  } catch (unzipErr) {
    // Fallback to bsdtar/tar if unzip binary is missing on POSIX hosts
    try {
      await execFileAsync('tar', ['-xf', zipPath, '-C', destDir], { timeout: 60000 });
    } catch {
      throw unzipErr;
    }
  }
}

async function downloadUpdateArchive(
  urlStr,
  destZipPath,
  currentVersion,
  { fetchFn = null, fallbackDownloadFn = null, timeoutMs = 45000, onProgress = null } = {}
) {
  if (!isAllowedGitHubUrl(urlStr)) {
    throw new Error('Untrusted download URL');
  }
  const useRealNetwork = typeof fetchFn !== 'function';
  if (useRealNetwork) {
    ensureIpv4FirstDns();
  }
  const fetchImpl = !useRealNetwork ? fetchFn : globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('Fetch API unavailable');
  }
  const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(Math.max(2000, Number(timeoutMs) || 45000))
    : undefined;

  let res;
  try {
    res = await fetchImpl(urlStr, {
      headers: { 'User-Agent': `antigravity-model-router/${currentVersion}` },
      redirect: 'follow',
      signal,
    });
  } catch (err) {
    if (isRetryableNetworkError(err)) {
      if (typeof fallbackDownloadFn === 'function') {
        return await fallbackDownloadFn(urlStr, destZipPath, currentVersion, { timeoutMs, onProgress });
      }
      if (useRealNetwork) {
        return await defaultFallbackDownloadFile(urlStr, destZipPath, currentVersion, { timeoutMs, onProgress });
      }
    }
    throw err;
  }

  if (res && typeof res.url === 'string' && res.url && !isAllowedGitHubUrl(res.url)) {
    throw new Error(`Untrusted redirect target: ${res.url}`);
  }
  if (!res || !res.ok) {
    throw new Error(`Archive download HTTP ${res ? res.status : 'unknown'}`);
  }
  const cl = Number(res.headers?.get?.('content-length') || res.headers?.['content-length'] || 0);
  const totalBytes = Number.isFinite(cl) && cl > 0 ? cl : 0;
  if (totalBytes > MAX_UPDATE_ARCHIVE_BYTES) {
    throw new Error(`Update archive exceeds ${MAX_UPDATE_ARCHIVE_BYTES} bytes`);
  }

  const reportProgress = typeof onProgress === 'function' ? onProgress : null;
  let buf;
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks = [];
    let receivedBytes = 0;
    let lastEmitAt = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        receivedBytes += value.byteLength;
        if (receivedBytes > MAX_UPDATE_ARCHIVE_BYTES) {
          try { await reader.cancel(); } catch {}
          throw new Error(`Update archive exceeds ${MAX_UPDATE_ARCHIVE_BYTES} bytes`);
        }
        chunks.push(Buffer.from(value));
        const now = Date.now();
        if (reportProgress && (now - lastEmitAt >= 120 || (totalBytes > 0 && receivedBytes >= totalBytes))) {
          lastEmitAt = now;
          try { reportProgress(receivedBytes, totalBytes); } catch {}
        }
      }
    } finally {
      try { reader.releaseLock?.(); } catch {}
    }
    buf = Buffer.concat(chunks);
    if (reportProgress && buf.length > 0) {
      try { reportProgress(buf.length, totalBytes || buf.length); } catch {}
    }
  } else if (typeof res.arrayBuffer === 'function') {
    buf = Buffer.from(await res.arrayBuffer());
    if (reportProgress && buf.length > 0) {
      try { reportProgress(buf.length, totalBytes || buf.length); } catch {}
    }
  } else if (typeof res.text === 'function') {
    buf = Buffer.from(await res.text(), 'binary');
    if (reportProgress && buf.length > 0) {
      try { reportProgress(buf.length, totalBytes || buf.length); } catch {}
    }
  } else {
    throw new Error('Archive response unreadable');
  }
  if (buf.length === 0) {
    throw new Error('Downloaded update archive is empty');
  }
  if (buf.length > MAX_UPDATE_ARCHIVE_BYTES) {
    throw new Error(`Update archive exceeds ${MAX_UPDATE_ARCHIVE_BYTES} bytes`);
  }
  writeFileSync(destZipPath, buf);
  return buf.length;
}

function copyFilteredTreeFallback(sourceDir, installTarget, depth = 0) {
  mkdirSync(installTarget, { recursive: true });
  const skipNames = depth === 0 ? PRESERVED_ROOT_ENTRIES : new Set(['.git', '.cache', 'node_modules', 'tests', '.shadow']);
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    if (skipNames.has(entry.name)) continue;
    const srcPath = join(sourceDir, entry.name);
    const dstPath = join(installTarget, entry.name);
    if (entry.isDirectory()) {
      copyFilteredTreeFallback(srcPath, dstPath, depth + 1);
    } else {
      copyFileSync(srcPath, dstPath);
    }
  }
}

/**
 * Downloads, verifies, extracts, and installs a newer version of the plugin from GitHub
 * while preserving user router-state.json, .cache, checkpoints, and backups.
 * @param {object} [options={}]
 */
export async function applyPluginUpdate(options = {}) {
  const {
    pluginRoot = '',
    targetDir = '',
    downloadUrl = '',
    targetVersion = '',
    forceApply = false,
    fetchFn = null,
    fallbackHttpFn = null,
    fallbackDownloadFn = null,
    extractZipFn = null,
    runInstallFn = null,
    lang = 'ru',
    timeoutMs = 45000,
    awaitCompletion = true,
  } = options && typeof options === 'object' ? options : {};

  const root = resolvePluginRoot(pluginRoot);
  const existingJob = activeJobs.get(root);
  if (existingJob?.active) {
    return { ...existingJob.status, alreadyRunning: true };
  }

  const cleanLang = normalizeLang(lang, 'ru');
  const isEn = cleanLang === 'en';
  const meta = readPluginMeta(root);
  const installTarget = resolveSafeInstallTarget(root, targetDir);

  let effectiveDownloadUrl = typeof downloadUrl === 'string' ? downloadUrl.trim() : '';
  let effectiveVersion = typeof targetVersion === 'string' ? (parseSemver(targetVersion)?.version || targetVersion.trim()) : '';

  const now = Date.now();
  const job = {
    active: true,
    status: {
      ...createIdleStatus(root),
      ok: true,
      active: true,
      phase: 'downloading',
      percent: 10,
      installedTarget: installTarget,
      targetVersion: effectiveVersion || meta.version,
      startedAt: now,
      updatedAt: now,
      statusText: isEn ? 'Checking and downloading update...' : 'Проверка и загрузка обновления...',
      statusTextRu: 'Проверка и загрузка обновления...',
      statusTextEn: 'Checking and downloading update...',
      dismissed: false,
    },
  };
  activeJobs.set(root, job);

  const setStatus = (patch) => {
    Object.assign(job.status, patch, { updatedAt: Date.now() });
    persistUpdateStatus(root, job.status);
  };
  persistUpdateStatus(root, job.status);

  const runUpdate = async () => {
    let tempWorkDir = '';
    try {
      if (!effectiveDownloadUrl) {
        const checkRes = await checkForPluginUpdate({
          pluginRoot: root,
          force: true,
          fetchFn,
          fallbackHttpFn,
          lang: cleanLang,
          timeoutMs: Math.min(timeoutMs, 15000),
          allowInTests: Boolean(fetchFn || forceApply),
        });
        if (!checkRes.ok) {
          throw new Error(checkRes.error || (isEn ? 'Failed to check GitHub for updates' : 'Не удалось проверить обновления на GitHub'));
        }
        if (!checkRes.updateAvailable && !forceApply) {
          setStatus({
            ok: true,
            active: false,
            phase: 'done',
            percent: 100,
            finishedAt: Date.now(),
            targetVersion: checkRes.currentVersion,
            needsRestart: false,
            error: '',
            statusText: isEn ? `Already up to date (v${checkRes.currentVersion})` : `Установлена актуальная версия (v${checkRes.currentVersion})`,
            statusTextRu: `Установлена актуальная версия (v${checkRes.currentVersion})`,
            statusTextEn: `Already up to date (v${checkRes.currentVersion})`,
          });
          return { ...job.status, upToDate: true };
        }
        effectiveDownloadUrl = checkRes.downloadUrl;
        effectiveVersion = checkRes.latestVersion || effectiveVersion;
      }

      if (!isAllowedGitHubUrl(effectiveDownloadUrl)) {
        throw new Error(isEn ? 'Blocked non-GitHub update download URL' : 'Отклонён недоверенный URL загрузки обновления');
      }

      const verLabel = effectiveVersion ? `v${effectiveVersion}` : (isEn ? 'update' : 'обновление');
      setStatus({
        phase: 'downloading',
        percent: 15,
        downloadedBytes: 0,
        totalBytes: 0,
        targetVersion: effectiveVersion || meta.version,
        statusText: isEn ? `Downloading ${verLabel} from GitHub...` : `Скачивание ${verLabel} с GitHub...`,
        statusTextRu: `Скачивание ${verLabel} с GitHub...`,
        statusTextEn: `Downloading ${verLabel} from GitHub...`,
      });

      tempWorkDir = mkdtempSync(join(tmpdir(), 'tunnel-update-'));
      const zipPath = join(tempWorkDir, 'update.zip');
      const extractDir = join(tempWorkDir, 'extracted');

      const formatMb = (bytes) => (Number(bytes || 0) / (1024 * 1024)).toFixed(1);
      await downloadUpdateArchive(effectiveDownloadUrl, zipPath, meta.version, {
        fetchFn,
        fallbackDownloadFn,
        timeoutMs,
        onProgress: (downloadedBytes, totalBytes) => {
          let pct;
          if (totalBytes > 0) {
            const ratio = Math.max(0, Math.min(1, downloadedBytes / totalBytes));
            pct = Math.min(60, Math.max(15, 15 + Math.round(ratio * 45)));
          } else {
            pct = Math.min(55, Math.max(18, 18 + Math.round(downloadedBytes / (256 * 1024))));
          }
          const ruText = totalBytes > 0
            ? `Скачивание ${verLabel} (${formatMb(downloadedBytes)} / ${formatMb(totalBytes)} МБ)...`
            : `Скачивание ${verLabel} (${formatMb(downloadedBytes)} МБ)...`;
          const enText = totalBytes > 0
            ? `Downloading ${verLabel} (${formatMb(downloadedBytes)} / ${formatMb(totalBytes)} MB)...`
            : `Downloading ${verLabel} (${formatMb(downloadedBytes)} MB)...`;
          setStatus({
            phase: 'downloading',
            percent: pct,
            downloadedBytes,
            totalBytes,
            statusText: isEn ? enText : ruText,
            statusTextRu: ruText,
            statusTextEn: enText,
          });
        },
      });

      setStatus({
        phase: 'extracting',
        percent: 65,
        statusText: isEn ? 'Verifying and extracting update archive...' : 'Проверка и распаковка архива обновления...',
        statusTextRu: 'Проверка и распаковка архива обновления...',
        statusTextEn: 'Verifying and extracting update archive...',
      });

      if (typeof extractZipFn === 'function') {
        await extractZipFn(zipPath, extractDir);
      } else {
        await defaultExtractZip(zipPath, extractDir);
      }
      validateExtractedTreeSafe(extractDir);
      const sourceDir = findExtractedPluginRoot(extractDir);
      const extractedMeta = readPluginMeta(sourceDir);
      if (extractedMeta.version && !effectiveVersion) {
        effectiveVersion = extractedMeta.version;
      }

      // Preserve existing user router-state.json in memory as an extra safeguard
      const targetStatePath = join(installTarget, 'router-state.json');
      let stateBackupRaw = null;
      if (existsSync(targetStatePath)) {
        try {
          stateBackupRaw = readFileSync(targetStatePath, 'utf8');
        } catch {}
      }

      setStatus({
        phase: 'installing',
        percent: 80,
        targetVersion: effectiveVersion || extractedMeta.version || meta.version,
        statusText: isEn ? `Installing ${verLabel} into plugin folder...` : `Установка ${verLabel} в папку плагина...`,
        statusTextRu: `Установка ${verLabel} в папку плагина...`,
        statusTextEn: `Installing ${verLabel} into plugin folder...`,
      });

      const installerScript = join(sourceDir, 'install.js');
      if (typeof runInstallFn === 'function') {
        await runInstallFn({
          sourceDir,
          targetDir: installTarget,
          targetVersion: effectiveVersion || extractedMeta.version,
          silent: true,
        });
      } else if (existsSync(installerScript)) {
        await execFileAsync(
          process.execPath,
          [installerScript, '--target', installTarget, '--silent', '--lang', cleanLang],
          { cwd: sourceDir, windowsHide: true, timeout: 60000 }
        );
      } else {
        copyFilteredTreeFallback(sourceDir, installTarget);
      }

      if (stateBackupRaw !== null) {
        let stateIntact = false;
        if (existsSync(targetStatePath)) {
          try {
            const parsed = JSON.parse(readFileSync(targetStatePath, 'utf8'));
            stateIntact = Boolean(parsed && typeof parsed === 'object' && !Array.isArray(parsed));
          } catch {}
        }
        if (!stateIntact) {
          mkdirSync(dirname(targetStatePath), { recursive: true });
          writeFileSync(targetStatePath, stateBackupRaw, 'utf8');
        }
      }

      // Clear stale update-check caches so UI reflects installed version accurately
      for (const cacheCandidate of [getCacheFilePath(root), getCacheFilePath(installTarget)]) {
        try {
          if (existsSync(cacheCandidate)) unlinkSync(cacheCandidate);
        } catch {}
      }

      const doneVer = effectiveVersion || extractedMeta.version || meta.version;
      setStatus({
        ok: true,
        active: false,
        phase: 'done',
        percent: 100,
        finishedAt: Date.now(),
        targetVersion: doneVer,
        installedTarget: installTarget,
        needsRestart: true,
        error: '',
        statusText: isEn
          ? `Updated to v${doneVer} ✓ Restart Google Antigravity to apply.`
          : `Обновлено до v${doneVer} ✓ Перезапустите Google Antigravity.`,
        statusTextRu: `Обновлено до v${doneVer} ✓ Перезапустите Google Antigravity.`,
        statusTextEn: `Updated to v${doneVer} ✓ Restart Google Antigravity to apply.`,
      });
      return { ...job.status };
    } catch (err) {
      const msg = compactUpdateError(err);
      const ruErr = formatUpdateError(err, 'ru');
      const enErr = formatUpdateError(err, 'en');
      setStatus({
        ok: false,
        active: false,
        phase: 'error',
        finishedAt: Date.now(),
        needsRestart: false,
        error: msg,
        statusText: isEn ? enErr : ruErr,
        statusTextRu: ruErr,
        statusTextEn: enErr,
      });
      return { ...job.status };
    } finally {
      job.active = false;
      if (tempWorkDir) {
        try {
          rmSync(tempWorkDir, { recursive: true, force: true });
        } catch {}
      }
    }
  };

  const promise = runUpdate();
  if (awaitCompletion) {
    return await promise;
  }
  promise.catch(() => {});
  return { ...job.status };
}

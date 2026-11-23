#!/usr/bin/env node
/**
 * @file fetch-open-media.mjs
 * @description Zero-LLM openly-licensed photo & audio/SFX fetcher via Openverse API + Wikimedia Commons fallback.
 *   Enforces SSRF protection, 15 MB download cap, safe filename slugs, and single-line CREDITS attribution.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePublicRefUrl } from './fetch-web-refs.mjs';

const __filename = fileURLToPath(import.meta.url);
const MAX_MEDIA_BYTES = 15 * 1024 * 1024;
const ALLOWED_MEDIA_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.svg', '.mp3', '.wav', '.ogg', '.flac']);

function slugifyFilePart(raw = '', fallback = 'media') {
  const clean = String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return clean || fallback;
}

/**
 * Builds a validated Openverse API v1 search URL (no API key required for anonymous tier).
 * @param {{ query: string, mediaType?: 'images'|'audio', license?: string, pageSize?: number, aspectRatio?: string }} [opts={}]
 * @returns {string}
 */
export function buildOpenverseSearchUrl(opts = {}) {
  const safe = opts && typeof opts === 'object' && !Array.isArray(opts) ? opts : {};
  const {
    query = '',
    mediaType = 'images',
    license = 'cc0,pdm,by',
    pageSize = 10,
    aspectRatio = '',
  } = safe;
  const cleanQuery = String(query || '').trim();
  const endpoint = mediaType === 'audio' ? 'audio' : 'images';
  const params = new URLSearchParams();
  params.set('q', cleanQuery);
  params.set('page_size', String(Math.max(1, Math.min(20, Number(pageSize) || 10))));
  if (license) params.set('license', String(license).trim());
  if (endpoint === 'images' && aspectRatio) params.set('aspect_ratio', String(aspectRatio).trim());
  return `https://api.openverse.org/v1/${endpoint}/?${params.toString()}`;
}

/**
 * Normalizes Openverse API JSON payload into compact attribution-ready asset records.
 * @param {object} payload
 * @param {'images'|'audio'} [mediaType='images']
 */
export function normalizeOpenverseResults(payload = {}, mediaType = 'images') {
  const rows = Array.isArray(payload?.results) ? payload.results : [];
  const out = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const urlCheck = validatePublicRefUrl(row.url || '');
    if (!urlCheck.ok) continue;
    const license = String(row.license || 'cc-by').toUpperCase();
    const creator = String(row.creator || 'Unknown creator').trim();
    const title = String(row.title || 'Untitled').trim();
    const source = String(row.source || 'Openverse').trim();
    const attributionLine = `${title} by ${creator} (${license}, via ${source})`;
    out.push({
      id: String(row.id || ''),
      mediaType: mediaType === 'audio' ? 'audio' : 'images',
      title,
      creator,
      license,
      licenseUrl: String(row.license_url || ''),
      url: urlCheck.url,
      thumbnail: validatePublicRefUrl(row.thumbnail || '').url || '',
      durationMs: Number.isFinite(Number(row.duration)) ? Number(row.duration) : 0,
      width: Number.isFinite(Number(row.width)) ? Number(row.width) : 0,
      height: Number.isFinite(Number(row.height)) ? Number(row.height) : 0,
      attributionLine,
    });
  }
  return out;
}

/**
 * Formats a compact single-line footer credit + markdown CREDITS block (taste-skill House Rule #1).
 * @param {Array<object>} [items=[]]
 */
export function formatCreditsFooterLine(items = []) {
  const list = Array.isArray(items) ? items.filter((x) => x && x.attributionLine) : [];
  if (list.length === 0) {
    return { footerLine: '', creditsMarkdown: '' };
  }
  const footerLine = `Media credits: ${list.slice(0, 6).map((x) => x.attributionLine).join(' · ')}`;
  const creditsMarkdown = [
    '# Media Credits',
    '',
    ...list.map((x) => `- **${x.title}** — ${x.creator} (${x.license}${x.licenseUrl ? `, [license](${x.licenseUrl})` : ''}) · ${x.url}`),
  ].join('\n');
  return { footerLine, creditsMarkdown };
}

function inferMediaExt(rawUrl = '', contentType = '', mediaType = 'images') {
  try {
    const ext = path.extname(new URL(rawUrl).pathname).toLowerCase();
    if (ALLOWED_MEDIA_EXTS.has(ext)) return ext;
  } catch {}
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('png')) return '.png';
  if (ct.includes('webp')) return '.webp';
  if (ct.includes('svg')) return '.svg';
  if (ct.includes('wav')) return '.wav';
  if (ct.includes('ogg')) return '.ogg';
  if (ct.includes('mpeg') || ct.includes('mp3')) return '.mp3';
  return mediaType === 'audio' ? '.mp3' : '.jpg';
}

async function fetchWikimediaFallbackImages({ query, limit = 6, fetchImpl, timeoutMs }) {
  const apiUrl = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrnamespace=6&gsrsearch=${encodeURIComponent(query)}&gsrlimit=${Math.max(1, Math.min(12, limit))}&prop=imageinfo&iiprop=url|size|extmetadata&format=json`;
  const resp = await fetchImpl(apiUrl, {
    headers: { 'User-Agent': 'antigravity-model-router/3.28' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) return [];
  const data = await resp.json();
  const pages = Object.values(data?.query?.pages || {});
  const out = [];
  for (const p of pages) {
    const info = Array.isArray(p?.imageinfo) ? p.imageinfo[0] : null;
    const urlCheck = validatePublicRefUrl(info?.url || '');
    if (!urlCheck.ok) continue;
    const meta = info?.extmetadata || {};
    const license = String(meta.LicenseShortName?.value || 'CC').replace(/<[^>]+>/g, '').trim();
    const creator = String(meta.Artist?.value || 'Wikimedia Contributor').replace(/<[^>]+>/g, '').trim().slice(0, 80);
    const title = String(p?.title || 'Media').replace(/^File:/i, '').trim();
    out.push({
      id: String(p?.pageid || out.length + 1),
      mediaType: 'images',
      title,
      creator,
      license,
      licenseUrl: String(meta.LicenseUrl?.value || ''),
      url: urlCheck.url,
      thumbnail: '',
      durationMs: 0,
      width: Number(info?.width || 0),
      height: Number(info?.height || 0),
      attributionLine: `${title} by ${creator} (${license}, via Wikimedia Commons)`,
    });
  }
  return out;
}

/**
 * Queries Openverse REST API (with Wikimedia image fallback), optionally downloads vetted files, and returns credits.
 */
export async function searchOpenMedia(opts = {}) {
  const safe = opts && typeof opts === 'object' && !Array.isArray(opts) ? opts : {};
  const {
    query = '',
    mediaType = 'images',
    license = 'cc0,pdm,by',
    limit = 6,
    aspectRatio = '',
    outDir = '',
    download = false,
    fetchImpl = globalThis.fetch,
    timeoutMs = 8000,
  } = safe;
  const cleanQuery = String(query || '').trim();
  if (!cleanQuery) {
    return { ok: false, error: 'empty_query', items: [], downloadedFiles: [], footerLine: '', creditsMarkdown: '' };
  }
  if (typeof fetchImpl !== 'function') {
    return { ok: false, error: 'fetch_unavailable', items: [], downloadedFiles: [], footerLine: '', creditsMarkdown: '' };
  }

  const searchUrl = buildOpenverseSearchUrl({ query: cleanQuery, mediaType, license, pageSize: limit, aspectRatio });
  let items = [];
  let source = 'openverse';

  try {
    const resp = await fetchImpl(searchUrl, {
      headers: { 'User-Agent': 'antigravity-model-router/3.28', Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (resp.ok) {
      const json = await resp.json();
      items = normalizeOpenverseResults(json, mediaType).slice(0, limit);
    }
  } catch {}

  if (items.length === 0 && mediaType !== 'audio') {
    try {
      items = await fetchWikimediaFallbackImages({ query: cleanQuery, limit, fetchImpl, timeoutMs });
      if (items.length > 0) source = 'wikimedia_commons';
    } catch {}
  }

  const downloadedFiles = [];
  if (download && outDir && items.length > 0) {
    const absOut = path.resolve(outDir);
    fs.mkdirSync(absOut, { recursive: true });
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const safe = validatePublicRefUrl(item.url);
      if (!safe.ok) continue;
      try {
        const assetResp = await fetchImpl(safe.url, { signal: AbortSignal.timeout(timeoutMs) });
        if (!assetResp.ok) continue;
        const ab = await assetResp.arrayBuffer();
        if (ab.byteLength === 0 || ab.byteLength > MAX_MEDIA_BYTES) continue;
        const ext = inferMediaExt(safe.url, assetResp.headers?.get?.('content-type') || '', mediaType);
        const fileName = `${String(i + 1).padStart(2, '0')}-${slugifyFilePart(item.title, 'asset')}${ext}`;
        const destPath = path.join(absOut, fileName);
        fs.writeFileSync(destPath, Buffer.from(ab));
        item.localPath = destPath;
        downloadedFiles.push(destPath);
      } catch {}
    }
  }

  const credits = formatCreditsFooterLine(items);
  if (download && outDir && credits.creditsMarkdown) {
    fs.writeFileSync(path.join(path.resolve(outDir), 'CREDITS.md'), credits.creditsMarkdown, 'utf8');
  }

  return {
    ok: items.length > 0,
    source,
    query: cleanQuery,
    mediaType: mediaType === 'audio' ? 'audio' : 'images',
    items,
    downloadedFiles,
    ...credits,
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMain) {
  const args = process.argv.slice(2);
  let query = '';
  let mediaType = 'images';
  let license = 'cc0,pdm,by';
  let limit = 6;
  let outDir = '';
  let asJson = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--query' && args[i + 1]) query = args[++i];
    else if (a === '--type' && args[i + 1]) mediaType = args[++i];
    else if (a === '--license' && args[i + 1]) license = args[++i];
    else if (a === '--limit' && args[i + 1]) limit = Number(args[++i]) || 6;
    else if (a === '--out' && args[i + 1]) outDir = args[++i];
    else if (a === '--json') asJson = true;
    else if (!a.startsWith('-') && !query) query = a;
  }

  const res = await searchOpenMedia({ query, mediaType, license, limit, outDir, download: Boolean(outDir) });
  if (asJson) {
    console.log(JSON.stringify(res, null, 2));
  } else {
    console.log(`🌐 [OpenMedia/${res.source}] "${res.query}" -> ${res.items.length} results`);
    for (const item of res.items) {
      console.log(`  - ${item.attributionLine} -> ${item.localPath || item.url}`);
    }
    if (res.footerLine) console.log(`\n${res.footerLine}`);
  }
}

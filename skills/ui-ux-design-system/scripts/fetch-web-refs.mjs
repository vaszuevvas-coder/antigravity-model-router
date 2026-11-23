#!/usr/bin/env node
/**
 * @file fetch-web-refs.mjs
 * @description Zero-LLM token-efficient pipeline for open UI/UX web design references:
 *   1) Strict public URL & SSRF validation + non-bypass challenge/login/CAPTCHA detection;
 *   2) Platform fast-paths (CodePen /image/large.png + oEmbed) & HTTP og:image / CSS metadata;
 *   3) Dembrandt / DESIGN.md-style deterministic CSS token extraction (colors, fonts, radii, blur, motion);
 *   4) 7-day SHA-1 disk cache (.cache/web-refs/) + local headless Edge/Chrome screenshot fallback;
 *   5) Direct integration with build-showroom.mjs and optional local Ollama distillation.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizeLang, readActiveUiLanguage } from '../../../core/i18n.mjs';
import {
  findHeadlessBrowserExecutable,
  generateShowroomHtml,
  generateShowroomVisualPreviews,
  openFileInDefaultBrowser,
  renderVariantPreviewPngBuffer,
} from './build-showroom.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_CACHE_DIR = path.resolve(__dirname, '..', '..', '..', '.cache', 'web-refs');
const DEFAULT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_HTML_BYTES = 512 * 1024;
const MAX_CSS_BYTES = 256 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_CSS_SCAN_CHARS = 350_000;

const GENERIC_FONT_SET = new Set([
  'sans-serif',
  'serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  '-apple-system',
  'blinkmacsystemfont',
  'segoe ui',
  'roboto',
  'helvetica neue',
  'arial',
  'noto sans',
  'apple color emoji',
  'segoe ui emoji',
  'segoe ui symbol',
  'inherit',
  'initial',
  'unset',
  'ui-sans-serif',
  'ui-serif',
  'ui-monospace',
]);

function isPrivateOrLoopbackIpv4(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  const c = Number(m[3]);
  const d = Number(m[4]);
  if (a > 255 || b > 255 || c > 255 || d > 255) return true;
  if (a === 127 || a === 0 || a === 10) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function isPrivateOrLoopbackHost(rawHost = '') {
  const host = String(rawHost || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    return true;
  }
  if (isPrivateOrLoopbackIpv4(host)) return true;
  if (host === '::1' || host === '::') return true;
  if (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')) return true;
  if (host.startsWith('::ffff:')) {
    const v4Part = host.slice(7);
    if (isPrivateOrLoopbackIpv4(v4Part)) return true;
    const hexMatch = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v4Part);
    if (hexMatch) {
      const hi = parseInt(hexMatch[1], 16);
      const lo = parseInt(hexMatch[2], 16);
      const dotted = `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
      if (isPrivateOrLoopbackIpv4(dotted)) return true;
    }
  }
  return false;
}

/**
 * Validates that an external design reference URL is strictly public http(s) and non-SSRF.
 * @param {string} rawUrl
 * @returns {{ ok: boolean, url: string, host: string, reason?: string }}
 */
export function validatePublicRefUrl(rawUrl) {
  if (typeof rawUrl !== 'string') {
    return { ok: false, url: '', host: '', reason: 'invalid_url' };
  }
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.length > 2048 || /[\r\n\0]/.test(trimmed)) {
    return { ok: false, url: '', host: '', reason: 'invalid_url' };
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, url: '', host: '', reason: 'invalid_url' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, url: '', host: '', reason: 'unsupported_scheme' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, url: '', host: '', reason: 'credentials_disallowed' };
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  if (isPrivateOrLoopbackHost(parsed.hostname)) {
    return { ok: false, url: '', host, reason: 'ssrf_private_host' };
  }
  return { ok: true, url: parsed.href, host };
}

/**
 * Detects CAPTCHA, anti-bot gates, HTTP blocks, or login/paywall redirects.
 * Never attempts to solve or bypass any gate.
 * @param {{ status?: number, html?: string, finalUrl?: string }} [params]
 * @returns {{ blocked: boolean, reason: string }}
 */
export function detectAccessChallenge(opts = {}) {
  const safeOpts = opts && typeof opts === 'object' && !Array.isArray(opts) ? opts : {};
  const { status = 200, html = '', finalUrl = '' } = safeOpts;
  const code = Number(status || 200);
  if (code === 401 || code === 407) {
    return { blocked: true, reason: 'auth_or_paywall' };
  }
  if (code === 403 || code === 429 || code === 451) {
    return { blocked: true, reason: `http_blocked_${code}` };
  }

  if (finalUrl) {
    try {
      const parsed = new URL(String(finalUrl));
      if (/\/(?:login|signin|sign-in|auth|paywall|subscribe|account\/login|challenge|cdn-cgi\/challenge)/i.test(parsed.pathname)) {
        return { blocked: true, reason: 'auth_or_paywall' };
      }
    } catch {}
  }

  const snippet = String(html || '').slice(0, 64_000);
  const titleMatch = /<title[^>]*>([^<]{0,200})<\/title>/i.exec(snippet);
  const titleText = titleMatch ? titleMatch[1] : '';
  if (/(?:just a moment|attention required!\s*\|\s*cloudflare|checking your browser)/i.test(titleText)) {
    return { blocked: true, reason: 'captcha_or_antibot' };
  }
  if (
    /(?:cf-turnstile|cf-chl-bypass|_cf_chl_opt|<altcha-widget|verify you are human|подтвердите, что вы человек|enable javascript and cookies to continue)/i.test(snippet) ||
    /class=["'][^"']{0,120}(?:g-recaptcha|h-captcha|cf-turnstile)[^"']{0,120}["']/i.test(snippet)
  ) {
    return { blocked: true, reason: 'captcha_or_antibot' };
  }

  return { blocked: false, reason: '' };
}

/**
 * Resolves platform-specific direct preview image / metadata API URLs without spinning up a browser.
 * @param {string} safeUrl
 * @returns {{ platform: 'codepen'|'generic', directImageUrl: string, oembedUrl: string }}
 */
export function resolveDirectPlatformPreview(safeUrl) {
  const str = String(safeUrl || '');
  const codepenMatch = /^https?:\/\/(?:www\.)?codepen\.io\/([a-zA-Z0-9_-]+)\/(?:pen|full|details|debug)\/([a-zA-Z0-9_-]+)/i.exec(str);
  if (codepenMatch) {
    const user = codepenMatch[1];
    const slug = codepenMatch[2];
    const canonicalPenUrl = `https://codepen.io/${user}/pen/${slug}`;
    return {
      platform: 'codepen',
      directImageUrl: `${canonicalPenUrl}/image/large.png`,
      oembedUrl: `https://codepen.io/api/oembed?format=json&url=${encodeURIComponent(canonicalPenUrl)}`,
    };
  }
  return { platform: 'generic', directImageUrl: '', oembedUrl: '' };
}

function decodeBasicHtmlEntities(text = '') {
  return String(text || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractMetaContent(headHtml, attrName, attrValues) {
  const tagRe = /<meta\b([^>]{1,600})>/gi;
  let m;
  while ((m = tagRe.exec(headHtml)) !== null) {
    const attrs = m[1];
    const nameMatch = new RegExp(`\\b${attrName}\\s*=\\s*(?:"([^"]{1,120})"|'([^']{1,120})'|([^\\s>]{1,120}))`, 'i').exec(attrs);
    const key = (nameMatch?.[1] || nameMatch?.[2] || nameMatch?.[3] || '').trim().toLowerCase();
    if (!attrValues.includes(key)) continue;
    const contentMatch = /\bcontent\s*=\s*(?:"([^"]{0,1000})"|'([^']{0,1000})'|([^\s>]{1,500}))/i.exec(attrs);
    const val = contentMatch?.[1] ?? contentMatch?.[2] ?? contentMatch?.[3] ?? '';
    if (val) return decodeBasicHtmlEntities(val);
  }
  return '';
}

function normalizeHexOrRgbToHex(rawColor = '') {
  const s = String(rawColor || '').trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(s)) {
    return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  }
  if (/^#[0-9a-f]{4}$/.test(s)) {
    return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  }
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  if (/^#[0-9a-f]{8}$/.test(s)) return s.slice(0, 7);

  const rgbMatch = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(s);
  if (rgbMatch) {
    if (rgbMatch[4] !== undefined) {
      const alphaRaw = rgbMatch[4];
      const alpha = alphaRaw.endsWith('%') ? parseFloat(alphaRaw) / 100 : parseFloat(alphaRaw);
      if (!Number.isFinite(alpha) || alpha <= 0.05) return '';
    }
    const r = Math.min(255, Number(rgbMatch[1]));
    const g = Math.min(255, Number(rgbMatch[2]));
    const b = Math.min(255, Number(rgbMatch[3]));
    return `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
  }
  return '';
}

function hexToRgbTuple(hex) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return null;
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}

function computeColorMetrics(hex) {
  const rgb = hexToRgbTuple(hex);
  if (!rgb) return { L: 0.5, S: 0, rgb: [128, 128, 128] };
  const [r, g, b] = rgb.map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const S = max === 0 ? 0 : d / max;
  const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return { L, S, rgb };
}

function colorDistance(rgbA, rgbB) {
  const dr = rgbA[0] - rgbB[0];
  const dg = rgbA[1] - rgbB[1];
  const db = rgbA[2] - rgbB[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/**
 * Extracts metadata and Dembrandt / DESIGN.md-style CSS design tokens from raw HTML & CSS.
 * @param {string} [html='']
 * @param {string} [extraCss='']
 * @returns {{ meta: object, tokens: object }}
 */
export function extractDesignTokensFromHtmlAndCss(html = '', extraCss = '') {
  const htmlStr = String(html || '');
  const headSlice = htmlStr.slice(0, 120_000);

  const rawTitleTag = /<title[^>]*>([^<]{1,200})<\/title>/i.exec(headSlice)?.[1] || '';
  const title = extractMetaContent(headSlice, 'property', ['og:title']) ||
    extractMetaContent(headSlice, 'name', ['twitter:title']) ||
    decodeBasicHtmlEntities(rawTitleTag);
  const description = extractMetaContent(headSlice, 'property', ['og:description']) ||
    extractMetaContent(headSlice, 'name', ['description', 'twitter:description']);
  const ogImage = extractMetaContent(headSlice, 'property', ['og:image', 'og:image:secure_url']) ||
    extractMetaContent(headSlice, 'name', ['twitter:image', 'twitter:image:src']);
  const themeColor = normalizeHexOrRgbToHex(extractMetaContent(headSlice, 'name', ['theme-color']));

  const stylesheetHrefs = [];
  const linkRe = /<link\b([^>]{1,600})>/gi;
  let linkMatch;
  while ((linkMatch = linkRe.exec(headSlice)) !== null && stylesheetHrefs.length < 2) {
    const attrs = linkMatch[1];
    if (!/\brel\s*=\s*(?:"[^"]*stylesheet[^"]*"|'[^']*stylesheet[^']*'|stylesheet\b)/i.test(attrs)) continue;
    const hrefMatch = /\bhref\s*=\s*(?:"([^"]{1,500})"|'([^']{1,500})'|([^\s>]{1,500}))/i.exec(attrs);
    const href = hrefMatch?.[1] || hrefMatch?.[2] || hrefMatch?.[3] || '';
    if (href && !href.startsWith('data:')) {
      stylesheetHrefs.push(decodeBasicHtmlEntities(href));
    }
  }

  const styleChunks = [];
  const styleBlockRe = /<style\b[^>]{0,120}>([\s\S]{1,120000}?)<\/style>/gi;
  let sm;
  while ((sm = styleBlockRe.exec(htmlStr)) !== null && styleChunks.length < 12) {
    styleChunks.push(sm[1]);
  }
  const inlineStyleRe = /\bstyle\s*=\s*(?:"([^"]{1,600})"|'([^']{1,600})')/gi;
  let im;
  while ((im = inlineStyleRe.exec(headSlice)) !== null && styleChunks.length < 60) {
    styleChunks.push(im[1] || im[2] || '');
  }
  if (extraCss) styleChunks.push(String(extraCss));

  const cssText = styleChunks.join('\n').slice(0, MAX_CSS_SCAN_CHARS);

  // 1. Semantic CSS custom properties
  const cssVars = [];
  const seenVarNames = new Set();
  const varRe = /(--[a-zA-Z0-9_-]{2,48})\s*:\s*([^;}{]{1,90})/g;
  let vm;
  while ((vm = varRe.exec(cssText)) !== null && cssVars.length < 10) {
    const name = vm[1].trim();
    const val = vm[2].trim();
    if (!seenVarNames.has(name) && val) {
      seenVarNames.add(name);
      cssVars.push(`${name}: ${val}`);
    }
  }

  // 2. Color extraction & perceptual clustering
  const colorCounts = new Map();
  const addColorCount = (hex, weight = 1) => {
    if (!hex) return;
    colorCounts.set(hex, (colorCounts.get(hex) || 0) + weight);
  };
  if (themeColor) addColorCount(themeColor, 5);

  const colorTokenRe = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*[,/]\s*[\d.]{1,6}%?)?\s*\)/g;
  let cm;
  while ((cm = colorTokenRe.exec(cssText)) !== null) {
    addColorCount(normalizeHexOrRgbToHex(cm[0]), 1);
  }

  const sortedColors = Array.from(colorCounts.entries()).sort((a, b) => b[1] - a[1]);
  const clustered = [];
  for (const [hex, count] of sortedColors) {
    const metrics = computeColorMetrics(hex);
    const duplicate = clustered.some((item) => colorDistance(item.rgb, metrics.rgb) < 18);
    if (!duplicate) {
      clustered.push({ hex, count, ...metrics });
    }
    if (clustered.length >= 16) break;
  }

  const varBgHints = new Set();
  const varAccentHints = new Set();
  for (const entry of cssVars) {
    const [k, v] = entry.split(/:\s*(.+)/);
    const hex = normalizeHexOrRgbToHex(v || '');
    if (!hex) continue;
    if (/^--(?:bg|canvas|surface|paper|ground)/i.test(k)) varBgHints.add(hex);
    if (/^--(?:accent|primary|brand|cta|highlight)/i.test(k)) varAccentHints.add(hex);
  }

  const surfaces = [];
  const accents = [];
  for (const c of clustered) {
    if (surfaces.length < 3 && (varBgHints.has(c.hex) || c.L >= 0.82 || c.L <= 0.18)) {
      surfaces.push(c.hex);
    }
    if (accents.length < 3 && (varAccentHints.has(c.hex) || (c.S >= 0.28 && c.L > 0.08 && c.L < 0.90))) {
      accents.push(c.hex);
    }
  }
  const palette = clustered.slice(0, 6).map((c) => c.hex);

  // 3. Fonts
  const fontCounts = new Map();
  const fontRe = /font-family\s*:\s*([^;}{]{1,140})/gi;
  let fm;
  while ((fm = fontRe.exec(cssText)) !== null) {
    const parts = fm[1].split(',');
    for (const part of parts) {
      const cleaned = part.trim().replace(/^["']|["']$/g, '').trim();
      if (!cleaned || /^var\(/i.test(cleaned) || GENERIC_FONT_SET.has(cleaned.toLowerCase())) continue;
      fontCounts.set(cleaned, (fontCounts.get(cleaned) || 0) + 1);
      break;
    }
  }
  const fontFamilies = Array.from(fontCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name]) => name);

  // 4. Radii, glass blur, shadows, motion curves
  const radiusCounts = new Map();
  const radiusRe = /border-radius\s*:\s*([^;}{]{1,48})/gi;
  let rm;
  while ((rm = radiusRe.exec(cssText)) !== null) {
    const val = rm[1].trim().replace(/\s*!important$/i, '');
    if (val && val !== '0' && val !== '0px' && !/^var\(/i.test(val)) {
      radiusCounts.set(val, (radiusCounts.get(val) || 0) + 1);
    }
  }
  const radii = Array.from(radiusCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([val]) => val);

  const blurMatch = /(?:backdrop-filter|-webkit-backdrop-filter)\s*:\s*([^;}{]{1,80})/i.exec(cssText);
  const glassBlur = blurMatch && /blur\(/i.test(blurMatch[1]) ? blurMatch[1].trim() : '';

  const shadows = [];
  const shadowRe = /box-shadow\s*:\s*([^;}{]{4,120})/gi;
  let shm;
  while ((shm = shadowRe.exec(cssText)) !== null && shadows.length < 2) {
    const val = shm[1].trim();
    if (val !== 'none' && !shadows.includes(val)) shadows.push(val);
  }

  const motion = [];
  const motionRe = /(cubic-bezier\(\s*[-0-9.,\s]{3,40}\))/gi;
  let mm;
  while ((mm = motionRe.exec(cssText)) !== null && motion.length < 2) {
    const curve = mm[1].replace(/\s+/g, ' ').trim();
    if (!motion.includes(curve)) motion.push(curve);
  }

  return {
    meta: {
      title,
      description,
      ogImage,
      themeColor,
      stylesheetHrefs,
    },
    tokens: {
      cssVars,
      palette,
      surfaces,
      accents,
      fontFamilies,
      radii,
      glassBlur,
      shadows,
      motion,
    },
  };
}

/**
 * Formats extracted tokens into a concise Russian summary (<= 220 chars) for notes & preview cards.
 * @param {object} [tokens={}]
 * @returns {string}
 */
export function formatTokensNotesRu(tokens = {}, opts = {}) {
  const langArg = typeof opts === 'string' ? opts : opts?.lang;
  const isEn = normalizeLang(langArg || readActiveUiLanguage(), 'en') === 'en';
  const parts = [];
  const palette = Array.isArray(tokens.palette) ? tokens.palette : [];
  const accents = Array.isArray(tokens.accents) ? tokens.accents : [];
  const surfaces = Array.isArray(tokens.surfaces) ? tokens.surfaces : [];
  const fonts = Array.isArray(tokens.fontFamilies) ? tokens.fontFamilies : [];
  const radii = Array.isArray(tokens.radii) ? tokens.radii : [];

  const colorList = (surfaces.length > 0 ? surfaces.slice(0, 2) : palette.slice(0, 2));
  if (colorList.length > 0 || accents.length > 0) {
    const baseStr = colorList.join(', ');
    const accStr = accents[0] ? (baseStr ? (isEn ? `, accent ${accents[0]}` : `, акцент ${accents[0]}`) : accents[0]) : '';
    parts.push(`${isEn ? 'Palette' : 'Палитра'}: ${baseStr}${accStr}`);
  }
  if (fonts.length > 0) parts.push(`${isEn ? 'Fonts' : 'Шрифты'}: ${fonts.slice(0, 2).join(', ')}`);
  if (radii.length > 0) parts.push(`${isEn ? 'Radius' : 'Скругления'}: ${radii.slice(0, 2).join(', ')}`);
  if (tokens.glassBlur) parts.push(`${isEn ? 'Glass' : 'Стекло'}: ${tokens.glassBlur}`);
  if (Array.isArray(tokens.motion) && tokens.motion[0]) parts.push(`${isEn ? 'Motion' : 'Анимация'}: ${tokens.motion[0]}`);

  const full = parts.join(' • ');
  if (full.length <= 220) return full;
  return `${full.slice(0, 217)}...`;
}

function detectImageExtensionFromBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return '';
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return '.png';
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
  // GIF: GIF8
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return '.gif';
  // WEBP: RIFF....WEBP
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return '.webp';
  }
  return '';
}

async function readResponseBufferLimited(res, maxBytes) {
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) {
    return buf.subarray(0, maxBytes);
  }
  return buf;
}

async function safeFetchWithRedirectGuard(rawUrl, { fetchImpl, timeoutMs, accept = '*/*', maxRedirects = 3 } = {}) {
  let currentUrl = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const v = validatePublicRefUrl(currentUrl);
    if (!v.ok) {
      return { ok: false, blocked: true, reason: v.reason || 'invalid_url', status: 0, finalUrl: currentUrl, res: null };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(v.url, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          Accept: accept,
          'User-Agent': 'Mozilla/5.0 (compatible; AntigravityDesignRefBot/1.0)',
        },
      });
    } catch (err) {
      clearTimeout(timer);
      return { ok: false, blocked: false, reason: err?.name === 'AbortError' ? 'timeout' : 'network_error', status: 0, finalUrl: v.url, res: null };
    }
    clearTimeout(timer);

    const status = Number(res?.status || 0);
    if (status >= 300 && status < 400) {
      const loc = res?.headers?.get?.('location') || '';
      if (!loc || hop >= maxRedirects) {
        return { ok: false, blocked: true, reason: 'redirect_limit_or_empty', status, finalUrl: v.url, res: null };
      }
      let nextUrl = '';
      try {
        nextUrl = new URL(loc, v.url).href;
      } catch {
        return { ok: false, blocked: true, reason: 'invalid_redirect', status, finalUrl: v.url, res: null };
      }
      const nextChallenge = detectAccessChallenge({ status: 200, finalUrl: nextUrl });
      if (nextChallenge.blocked) {
        return { ok: false, blocked: true, reason: nextChallenge.reason, status, finalUrl: nextUrl, res: null };
      }
      currentUrl = nextUrl;
      continue;
    }

    const reportedUrl = res?.url ? String(res.url) : v.url;
    if (res?.url) {
      const repValid = validatePublicRefUrl(reportedUrl);
      if (!repValid.ok) {
        return { ok: false, blocked: true, reason: repValid.reason || 'ssrf_redirect', status, finalUrl: reportedUrl, res: null };
      }
    }
    return { ok: true, blocked: false, reason: '', status, finalUrl: reportedUrl, res };
  }
  return { ok: false, blocked: true, reason: 'redirect_loop', status: 0, finalUrl: currentUrl, res: null };
}

function resolveAbsoluteCandidateUrl(candidate, baseUrl) {
  if (!candidate) return '';
  try {
    return new URL(String(candidate).trim(), baseUrl).href;
  } catch {
    return '';
  }
}

function tryCaptureHeadlessScreenshot(targetUrl, outPngPath) {
  const browserExe = findHeadlessBrowserExecutable();
  if (!browserExe) return false;
  let tmpProfileDir = null;
  try {
    tmpProfileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-webref-'));
    execFileSync(
      browserExe,
      [
        '--headless',
        '--disable-gpu',
        '--hide-scrollbars',
        '--no-first-run',
        '--no-default-browser-check',
        '--mute-audio',
        `--user-data-dir=${tmpProfileDir}`,
        '--window-size=1280,800',
        `--screenshot=${outPngPath}`,
        targetUrl,
      ],
      { timeout: 7000, stdio: 'ignore' }
    );
    return fs.existsSync(outPngPath) && fs.statSync(outPngPath).size > 1000;
  } catch {
    return false;
  } finally {
    if (tmpProfileDir) {
      try {
        fs.rmSync(tmpProfileDir, { recursive: true, force: true });
      } catch {}
    }
  }
}

function sha1Key(str) {
  return crypto.createHash('sha1').update(String(str || '')).digest('hex').slice(0, 16);
}

function loadCachedReference(cacheDir, url, ttlMs) {
  try {
    const key = sha1Key(url);
    const metaPath = path.join(cacheDir, `${key}.json`);
    if (!fs.existsSync(metaPath)) return null;
    const data = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    if (!data || !data.cachedAt || Date.now() - Number(data.cachedAt) > ttlMs) return null;
    const imgPath = data.cachedImageFile ? path.join(cacheDir, data.cachedImageFile) : '';
    if (!imgPath || !fs.existsSync(imgPath)) return null;
    return { data, imgPath };
  } catch {
    return null;
  }
}

function saveCachedReference(cacheDir, url, card, localImagePath) {
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    const key = sha1Key(url);
    const ext = path.extname(localImagePath) || '.png';
    const cachedImageFile = `${key}${ext}`;
    fs.copyFileSync(localImagePath, path.join(cacheDir, cachedImageFile));
    const metaPath = path.join(cacheDir, `${key}.json`);
    fs.writeFileSync(
      metaPath,
      JSON.stringify({
        cachedAt: Date.now(),
        url,
        title: card.title,
        host: card.host,
        sourceUrl: card.sourceUrl,
        tokens: card.tokens,
        notesSummary: card.notesSummary,
        cachedImageFile,
      }, null, 2),
      'utf8'
    );
  } catch {}
}

function buildCompactMarkdownPreview(cards = [], { lang = '' } = {}) {
  if (!Array.isArray(cards) || cards.length === 0) return '';
  const isEn = normalizeLang(lang || readActiveUiLanguage(), 'en') === 'en';
  return cards
    .map((card, i) => {
      const normImg = String(card.imagePath || '').replace(/\\/g, '/');
      const imgMdPath = normImg.startsWith('/') ? normImg : `/${normImg}`;
      const lines = [
        `### ${i + 1}. ${card.title || card.host} (\`${card.host}\`)`,
        `![${card.title || card.host}](${imgMdPath})`,
        `- **${isEn ? 'Source' : 'Источник'}:** [${card.host}](${card.sourceUrl})`,
      ];
      if (card.notesSummary) {
        lines.push(`- **${isEn ? 'CSS tokens & patterns' : 'CSS-токены и приёмы'}:** ${card.notesSummary}`);
      }
      return lines.join('\n');
    })
    .join('\n\n');
}

/**
 * Fetches up to `limit` open UI/UX web design references with zero LLM browser loops.
 * @param {string[]} [urls=[]]
 * @param {object} [options={}]
 */
export async function fetchWebReferencesBatch(urls = [], options = {}) {
  const batchLang = normalizeLang(options.lang || readActiveUiLanguage(), 'en');
  const isEnBatch = batchLang === 'en';
  const artifactDir = path.resolve(options.artifactDir || path.join(process.cwd(), '.cache', 'web-refs-out'));
  const cacheDir = path.resolve(options.cacheDir || DEFAULT_CACHE_DIR);
  const cacheTtlMs = Number(options.cacheTtlMs || DEFAULT_CACHE_TTL_MS);
  const noCache = Boolean(options.noCache);
  const limit = Math.max(1, Math.min(5, Number(options.limit || 3)));
  const timeoutMs = Math.max(800, Number(options.timeoutMs || 4500));
  const allowHeadlessFallback = options.allowHeadlessFallback !== false;
  const fastPng = Boolean(options.fastPng);
  const buildShowroom = Boolean(options.buildShowroom);
  const openShowroom = Boolean(options.openShowroom);
  const gpuDistill = Boolean(options.gpuDistill);
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch;

  fs.mkdirSync(artifactDir, { recursive: true });

  const uniqueInputUrls = Array.from(new Set((Array.isArray(urls) ? urls : []).map((u) => String(u || '').trim()).filter(Boolean)));
  const cards = [];
  const skipped = [];
  let cacheHits = 0;

  for (const rawUrl of uniqueInputUrls) {
    if (cards.length >= limit) break;

    const valid = validatePublicRefUrl(rawUrl);
    if (!valid.ok) {
      skipped.push({ url: rawUrl, reason: valid.reason || 'invalid_url' });
      continue;
    }

    const idx = cards.length + 1;

    if (!noCache) {
      const cached = loadCachedReference(cacheDir, valid.url, cacheTtlMs);
      if (cached) {
        const ext = path.extname(cached.imgPath) || '.png';
        const outImgPath = path.join(artifactDir, `ref-${idx}${ext}`);
        fs.copyFileSync(cached.imgPath, outImgPath);
        cacheHits++;
        cards.push({
          id: String(idx),
          title: cached.data.title || valid.host,
          host: cached.data.host || valid.host,
          sourceUrl: cached.data.sourceUrl || valid.url,
          imagePath: outImgPath,
          fromCache: true,
          tokens: cached.data.tokens || {},
          notesSummary: cached.data.notesSummary || '',
        });
        continue;
      }
    }

    const platformHint = resolveDirectPlatformPreview(valid.url);
    let oembedTitle = '';
    let oembedImage = '';

    if (platformHint.oembedUrl && typeof fetchImpl === 'function') {
      const oe = await safeFetchWithRedirectGuard(platformHint.oembedUrl, {
        fetchImpl,
        timeoutMs: Math.min(timeoutMs, 3000),
        accept: 'application/json',
      });
      if (oe.ok && oe.res?.ok) {
        try {
          const oeJson = await oe.res.json();
          if (oeJson?.title) oembedTitle = String(oeJson.title).trim();
          if (oeJson?.thumbnail_url) oembedImage = String(oeJson.thumbnail_url).trim();
        } catch {}
      }
    }

    if (typeof fetchImpl !== 'function') {
      skipped.push({ url: valid.url, reason: 'fetch_unavailable' });
      continue;
    }

    const pageFetch = await safeFetchWithRedirectGuard(valid.url, {
      fetchImpl,
      timeoutMs,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    });

    if (!pageFetch.ok || !pageFetch.res) {
      skipped.push({ url: valid.url, reason: pageFetch.reason || 'fetch_failed' });
      continue;
    }

    const status = Number(pageFetch.status || pageFetch.res.status || 200);
    let html = '';
    try {
      const htmlBuf = await readResponseBufferLimited(pageFetch.res, MAX_HTML_BYTES);
      html = htmlBuf.toString('utf8');
    } catch {
      skipped.push({ url: valid.url, reason: 'read_body_failed' });
      continue;
    }

    const challenge = detectAccessChallenge({ status, html, finalUrl: pageFetch.finalUrl });
    if (challenge.blocked) {
      skipped.push({ url: valid.url, reason: challenge.reason });
      continue;
    }
    if (status < 200 || status >= 400) {
      skipped.push({ url: valid.url, reason: `http_status_${status}` });
      continue;
    }

    let extracted = extractDesignTokensFromHtmlAndCss(html);
    if (extracted.tokens.palette.length < 2 && extracted.meta.stylesheetHrefs.length > 0) {
      const cssUrl = resolveAbsoluteCandidateUrl(extracted.meta.stylesheetHrefs[0], pageFetch.finalUrl);
      if (cssUrl) {
        const cssFetch = await safeFetchWithRedirectGuard(cssUrl, {
          fetchImpl,
          timeoutMs: Math.min(timeoutMs, 2500),
          accept: 'text/css,*/*;q=0.1',
        });
        if (cssFetch.ok && cssFetch.res && cssFetch.status >= 200 && cssFetch.status < 300) {
          try {
            const cssBuf = await readResponseBufferLimited(cssFetch.res, MAX_CSS_BYTES);
            extracted = extractDesignTokensFromHtmlAndCss(html, cssBuf.toString('utf8'));
          } catch {}
        }
      }
    }

    const candidateImgUrl =
      resolveAbsoluteCandidateUrl(platformHint.directImageUrl || oembedImage, pageFetch.finalUrl) ||
      resolveAbsoluteCandidateUrl(extracted.meta.ogImage, pageFetch.finalUrl);

    let savedImgPath = '';
    if (candidateImgUrl) {
      const imgFetch = await safeFetchWithRedirectGuard(candidateImgUrl, {
        fetchImpl,
        timeoutMs,
        accept: 'image/png,image/jpeg,image/webp,image/gif,*/*;q=0.5',
      });
      if (imgFetch.ok && imgFetch.res && imgFetch.status >= 200 && imgFetch.status < 300) {
        try {
          const imgBuf = await readResponseBufferLimited(imgFetch.res, MAX_IMAGE_BYTES);
          const ext = detectImageExtensionFromBuffer(imgBuf);
          if (ext) {
            savedImgPath = path.join(artifactDir, `ref-${idx}${ext}`);
            fs.writeFileSync(savedImgPath, imgBuf);
          }
        } catch {}
      }
    }

    if (!savedImgPath) {
      const pngTarget = path.join(artifactDir, `ref-${idx}.png`);
      const captured = allowHeadlessFallback && !fastPng ? tryCaptureHeadlessScreenshot(pageFetch.finalUrl, pngTarget) : false;
      if (captured) {
        savedImgPath = pngTarget;
      } else {
        const swatchBuf = renderVariantPreviewPngBuffer(
          {
            id: String(idx),
            label: oembedTitle || extracted.meta.title || valid.host,
            subtitle: valid.host,
            stageBg: extracted.tokens.surfaces[0] || '#12141a',
            accentColor: extracted.tokens.accents[0] || extracted.tokens.palette[0] || '#3b82f6',
            notes: formatTokensNotesRu(extracted.tokens, { lang: batchLang }),
          },
          idx - 1,
          600,
          340
        );
        fs.writeFileSync(pngTarget, swatchBuf);
        savedImgPath = pngTarget;
      }
    }

    let notesSummary = formatTokensNotesRu(extracted.tokens, { lang: batchLang });
    if (gpuDistill && !notesSummary) {
      try {
        const gpuMod = await import('../../../core/local-gpu-engine.mjs');
        if (gpuMod?.distillText) {
          const d = await gpuMod.distillText({
            text: `Title: ${extracted.meta.title}\nDesc: ${extracted.meta.description}\nVars: ${extracted.tokens.cssVars.join('; ')}`,
            mode: 'docs',
            maxOutputTokens: 120,
          });
          if (d?.ok && d.digest) {
            notesSummary = String(d.digest).replace(/\s+/g, ' ').trim().slice(0, 220);
          }
        }
      } catch {}
    }

    const card = {
      id: String(idx),
      title: (oembedTitle || extracted.meta.title || valid.host).slice(0, 90),
      host: valid.host,
      sourceUrl: valid.url,
      imagePath: savedImgPath,
      fromCache: false,
      tokens: extracted.tokens,
      notesSummary: notesSummary || extracted.meta.description?.slice(0, 180) || '',
    };

    if (!noCache) {
      saveCachedReference(cacheDir, valid.url, card, savedImgPath);
    }
    cards.push(card);
  }

  const variants = cards.map((card, i) => ({
    id: String.fromCharCode(65 + i),
    label: card.title,
    subtitle: card.host,
    stageBg: card.tokens?.surfaces?.[0] || '#14171f',
    accentColor: card.tokens?.accents?.[0] || '#3b82f6',
    referenceImage: card.imagePath,
    sourceUrl: card.sourceUrl,
    notes: card.notesSummary,
  }));

  const spec = {
    lang: batchLang,
    title: options.title || (isEnBatch ? 'Open web design references' : 'Подборка открытых веб-референсов'),
    variants,
  };
  let specPath = '';
  if (variants.length > 0) {
    specPath = path.join(artifactDir, 'web-refs-spec.json');
    fs.writeFileSync(specPath, JSON.stringify(spec, null, 2), 'utf8');
  }

  let showroomPath = '';
  let overviewScreenshot = '';
  if (buildShowroom && variants.length > 0) {
    const htmlRes = generateShowroomHtml(spec);
    if (htmlRes.ok) {
      showroomPath = path.join(artifactDir, 'preview-showroom.html');
      fs.writeFileSync(showroomPath, htmlRes.html, 'utf8');
      const previews = generateShowroomVisualPreviews(spec, artifactDir, { fastPng, lang: batchLang });
      overviewScreenshot = previews.overviewScreenshot || '';
      if (openShowroom) {
        openFileInDefaultBrowser(showroomPath);
      }
    }
  }

  return {
    ok: cards.length > 0,
    count: cards.length,
    cacheHits,
    cards,
    skipped,
    specPath,
    showroomPath,
    overviewScreenshot,
    markdownPreview: buildCompactMarkdownPreview(cards, { lang: batchLang }),
  };
}

// CLI Runner
const isMain = (() => {
  if (!process.argv[1]) return false;
  const self = path.resolve(fileURLToPath(import.meta.url));
  const arg = path.resolve(process.argv[1]);
  return process.platform === 'win32' ? self.toLowerCase() === arg.toLowerCase() : self === arg;
})();

if (isMain) {
  const args = process.argv.slice(2);
  const urls = [];
  const opts = {};

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') {
      console.log(
        'Usage: node fetch-web-refs.mjs <url...> [--artifact-dir <dir>] [--limit N] [--timeout ms] [--title str] [--lang en|ru] [--no-cache] [--fast-png] [--no-headless] [--build-showroom] [--open] [--gpu-distill]'
      );
      process.exit(0);
    } else if (a === '--artifact-dir' && args[i + 1]) opts.artifactDir = args[++i];
    else if (a.startsWith('--artifact-dir=')) opts.artifactDir = a.slice('--artifact-dir='.length);
    else if (a === '--cache-dir' && args[i + 1]) opts.cacheDir = args[++i];
    else if (a === '--limit' && args[i + 1]) opts.limit = Number(args[++i]);
    else if (a === '--timeout' && args[i + 1]) opts.timeoutMs = Number(args[++i]);
    else if (a === '--title' && args[i + 1]) opts.title = args[++i];
    else if (a === '--lang' && args[i + 1]) opts.lang = args[++i];
    else if (a.startsWith('--lang=')) opts.lang = a.slice('--lang='.length);
    else if (a === '--no-cache') opts.noCache = true;
    else if (a === '--fast-png') opts.fastPng = true;
    else if (a === '--no-headless') opts.allowHeadlessFallback = false;
    else if (a === '--build-showroom') opts.buildShowroom = true;
    else if (a === '--open') opts.openShowroom = true;
    else if (a === '--gpu-distill') opts.gpuDistill = true;
    else if (!a.startsWith('-')) urls.push(a);
  }

  const res = await fetchWebReferencesBatch(urls, opts);
  console.log(JSON.stringify(res));
}

/**
 * @file i18n.mjs
 * @description Shared bilingual (EN/RU) locale resolution and text helpers for The Tunnel core, CLI, and installers.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PLUGIN_ROOT = path.resolve(__dirname, '..');

/**
 * Normalizes a language tag or preference string to `'ru'` or `'en'`.
 * @param {unknown} raw
 * @param {'en'|'ru'} [fallback='en']
 * @returns {'en'|'ru'}
 */
export function normalizeLang(raw, fallback = 'en') {
  const fb = String(fallback || '').trim().toLowerCase() === 'ru' ? 'ru' : 'en';
  if (typeof raw !== 'string') return fb;
  const clean = raw.trim().toLowerCase();
  if (!clean) return fb;
  if (clean === 'ru' || clean.startsWith('ru-') || clean.startsWith('ru_')) return 'ru';
  if (clean === 'en' || clean.startsWith('en-') || clean.startsWith('en_')) return 'en';
  return fb;
}

/**
 * Detects CLI/env/OS locale (`'ru'` on Russian OS or explicit override, `'en'` everywhere else).
 * Priority: `--lang=en|ru` argv -> `TUNNEL_LANG` -> `LC_ALL`/`LC_MESSAGES`/`LANG` -> `Intl` OS locale.
 * @param {Record<string, string | undefined>} [env=process.env]
 * @param {string[]} [argv=process.argv]
 * @returns {'en'|'ru'}
 */
export function detectOsLocale(env = process.env, argv = process.argv) {
  const args = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i] || '').trim();
    const m = /^--lang=(.+)$/i.exec(a);
    if (m) {
      const val = m[1].trim().toLowerCase();
      if (val.startsWith('ru')) return 'ru';
      if (val.startsWith('en')) return 'en';
    }
    if (a === '--lang' && i + 1 < args.length) {
      const val = String(args[i + 1] || '').trim().toLowerCase();
      if (val.startsWith('ru')) return 'ru';
      if (val.startsWith('en')) return 'en';
    }
  }

  const envObj = env && typeof env === 'object' ? env : {};
  const tunnelLang = typeof envObj.TUNNEL_LANG === 'string' ? envObj.TUNNEL_LANG.trim().toLowerCase() : '';
  if (tunnelLang) {
    if (tunnelLang.startsWith('ru')) return 'ru';
    if (tunnelLang.startsWith('en')) return 'en';
  }

  for (const key of ['LC_ALL', 'LC_MESSAGES', 'LANG']) {
    const val = typeof envObj[key] === 'string' ? envObj[key].trim().toLowerCase() : '';
    if (!val || val === 'c' || val === 'posix') continue;
    return val.startsWith('ru') ? 'ru' : 'en';
  }

  try {
    const intlLocale = String(Intl.DateTimeFormat().resolvedOptions().locale || '').trim().toLowerCase();
    if (intlLocale) {
      return intlLocale.startsWith('ru') ? 'ru' : 'en';
    }
  } catch {}

  return 'en';
}

/**
 * Resolves the active user language from router state, preserving legacy fallback when `uiLanguage` is absent.
 * @param {Record<string, any> | null | undefined} state
 * @param {'en'|'ru'} [fallback='ru']
 * @returns {'en'|'ru'}
 */
export function resolveStateLanguage(state, fallback = 'ru') {
  const raw = typeof state?.uiLanguage === 'string' ? state.uiLanguage.trim().toLowerCase() : '';
  if (raw === 'en') return 'en';
  if (raw === 'ru') return 'ru';
  return String(fallback || '').trim().toLowerCase() === 'en' ? 'en' : 'ru';
}

/**
 * Picks Russian or English text according to `lang`.
 * @template T
 * @param {unknown} lang
 * @param {T} ruText
 * @param {T} enText
 * @returns {T}
 */
export function pickLang(lang, ruText, enText) {
  return normalizeLang(lang, 'en') === 'ru' ? ruText : enText;
}

/**
 * Infers language from free-form text (`'ru'` if Cyrillic count >= 3 or exceeds Latin letters, else `'en'`).
 * @param {unknown} text
 * @param {'en'|'ru'} [fallback='en']
 * @returns {'en'|'ru'}
 */
export function detectTextLanguage(text, fallback = 'en') {
  const str = typeof text === 'string' ? text : '';
  if (!str.trim()) return normalizeLang(fallback, 'en');
  const cyrMatches = str.match(/[А-Яа-яЁё]/g);
  const cyrCount = cyrMatches ? cyrMatches.length : 0;
  if (cyrCount >= 3) return 'ru';
  const latMatches = str.match(/[A-Za-z]/g);
  const latCount = latMatches ? latMatches.length : 0;
  if (cyrCount > 0 && cyrCount > latCount) return 'ru';
  return latCount > 0 ? 'en' : normalizeLang(fallback, 'en');
}

/**
 * Reads `uiLanguage` from `router-state.json` under `pluginRoot` (defaults to `'en'` when missing).
 * @param {string} [pluginRoot=DEFAULT_PLUGIN_ROOT]
 * @returns {'en'|'ru'}
 */
export function readActiveUiLanguage(pluginRoot = DEFAULT_PLUGIN_ROOT) {
  try {
    const statePath = path.join(pluginRoot || DEFAULT_PLUGIN_ROOT, 'router-state.json');
    if (!fs.existsSync(statePath)) return 'en';
    const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (typeof raw?.uiLanguage === 'string') {
      return normalizeLang(raw.uiLanguage, 'en');
    }
  } catch {}
  return 'en';
}

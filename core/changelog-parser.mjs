/**
 * @file changelog-parser.mjs
 * @description Zero-dependency Keep-a-Changelog parser for in-app "What's new" viewer.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeLang, pickLang, readActiveUiLanguage } from './i18n.mjs';
import { compareSemver, isAllowedGitHubUrl, readPluginMeta } from './plugin-updater.mjs';

const _changelogMemCache = new Map();
const MAX_CHANGELOG_CACHE = 8;

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PLUGIN_ROOT = join(__dirname, '..');

const VERSION_HEADER_RE = /^##\s+\[?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\]?(?:\s*[—–-]\s*(.+))?$/;
const SECTION_HEADER_RE = /^###\s+(.+)$/;
const TOP_BULLET_RE = /^-\s+(.+)$/;
const SUB_BULLET_RE = /^\s{2,}-\s+(.+)$/;
const MD_LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/g;

/**
 * Strips Markdown link targets while preserving inline code (`...`) and bold (`**...**`)
 * markers for safe DOM token rendering.
 * @param {string} [raw='']
 * @returns {string}
 */
export function cleanChangelogInlineText(raw = '') {
  if (typeof raw !== 'string' || !raw) return '';
  return raw
    .replace(MD_LINK_RE, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitLeadAndBody(cleanText = '') {
  const s = String(cleanText || '').trim();
  if (!s) return { lead: '', text: '' };
  const m = /^\*\*([^*]+)\*\*\s*:\s*(.+)$/.exec(s);
  if (m) {
    return {
      lead: cleanChangelogInlineText(m[1]),
      text: cleanChangelogInlineText(m[2]),
    };
  }
  const mNoColon = /^\*\*([^*]+)\*\*\s+(.+)$/.exec(s);
  if (mNoColon) {
    return {
      lead: cleanChangelogInlineText(mNoColon[1]),
      text: cleanChangelogInlineText(mNoColon[2]),
    };
  }
  return { lead: '', text: s };
}

function parseReleaseNotesBody(notesText = '', fallbackTitle = 'Changes') {
  const rawLines = String(notesText || '').replace(/\r\n/g, '\n').split('\n');
  const sections = [];
  let curSection = null;

  const ensureSection = (title) => {
    if (!curSection) {
      curSection = { title: title || fallbackTitle, items: [] };
      sections.push(curSection);
    }
    return curSection;
  };

  for (const rawLine of rawLines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed === '---') continue;
    const hMatch = /^#{2,4}\s+(.+)$/.exec(trimmed);
    if (hMatch) {
      curSection = { title: cleanChangelogInlineText(hMatch[1]), items: [] };
      sections.push(curSection);
      continue;
    }
    const bMatch = /^(?:[-*+]|•|\d+\.)\s+(.+)$/.exec(trimmed);
    if (bMatch) {
      const sec = ensureSection(fallbackTitle);
      const parsed = splitLeadAndBody(cleanChangelogInlineText(bMatch[1]));
      if (parsed.lead || parsed.text) {
        sec.items.push({ lead: parsed.lead, text: parsed.text, subitems: [] });
      }
      continue;
    }
    const sec = ensureSection(fallbackTitle);
    const cleaned = cleanChangelogInlineText(trimmed);
    if (cleaned) {
      sec.items.push({ lead: '', text: cleaned, subitems: [] });
    }
  }

  return sections.filter((s) => s.items.length > 0);
}

/**
 * Resolves the best-matching changelog file path for the requested UI language.
 * @param {string} pluginRoot
 * @param {'en'|'ru'} lang
 * @returns {{ path: string, fileName: string, lang: 'en'|'ru' }}
 */
export function resolveChangelogFilePath(pluginRoot, lang = 'en') {
  const targetLang = normalizeLang(lang, 'en');
  const candidates = targetLang === 'ru'
    ? [
        { fileName: 'CHANGELOG.ru.md', lang: 'ru' },
        { fileName: 'CHANGELOG.md', lang: 'en' },
      ]
    : [
        { fileName: 'CHANGELOG.md', lang: 'en' },
        { fileName: 'CHANGELOG.en.md', lang: 'en' },
        { fileName: 'CHANGELOG.ru.md', lang: 'ru' },
      ];
  for (const item of candidates) {
    const abs = join(pluginRoot, item.fileName);
    if (existsSync(abs)) {
      return { path: abs, fileName: item.fileName, lang: item.lang };
    }
  }
  return { path: '', fileName: '', lang: targetLang };
}

/**
 * Parses Keep-a-Changelog Markdown into structured versions, sections, and items.
 * @param {string} [markdownText='']
 * @param {{ lang?: 'en'|'ru' }} [options={}]
 * @returns {{ title: string, intro: string, versions: Array<object> }}
 */
export function parseChangelogMarkdown(markdownText = '', options = {}) {
  const lang = normalizeLang(options?.lang, 'en');
  const lines = String(markdownText || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').split('\n');
  let title = 'The Tunnel';
  const introParts = [];
  const versions = [];
  let curVersion = null;
  let curSection = null;
  let lastItem = null;

  const finalizeItemCount = (ver) => {
    if (!ver) return;
    ver.itemCount = ver.sections.reduce(
      (sum, sec) => sum + sec.items.reduce((s2, it) => s2 + 1 + (Array.isArray(it.subitems) ? it.subitems.length : 0), 0),
      0
    );
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');
    const trimmed = line.trim();
    if (!trimmed || trimmed === '---') continue;

    if (!curVersion && /^#\s+/.test(trimmed)) {
      title = cleanChangelogInlineText(trimmed.replace(/^#\s+/, ''));
      continue;
    }

    const verMatch = VERSION_HEADER_RE.exec(trimmed);
    if (verMatch) {
      finalizeItemCount(curVersion);
      curVersion = {
        version: verMatch[1].trim(),
        date: verMatch[2] ? cleanChangelogInlineText(verMatch[2]) : '',
        sections: [],
        itemCount: 0,
      };
      versions.push(curVersion);
      curSection = null;
      lastItem = null;
      continue;
    }

    if (!curVersion) {
      const cleanedIntro = cleanChangelogInlineText(trimmed.replace(/^>\s*/, ''));
      if (cleanedIntro) introParts.push(cleanedIntro);
      continue;
    }

    const secMatch = SECTION_HEADER_RE.exec(trimmed);
    if (secMatch) {
      curSection = {
        title: cleanChangelogInlineText(secMatch[1]),
        items: [],
      };
      curVersion.sections.push(curSection);
      lastItem = null;
      continue;
    }

    const subMatch = SUB_BULLET_RE.exec(line);
    if (subMatch && lastItem) {
      const subText = cleanChangelogInlineText(subMatch[1]);
      if (subText) lastItem.subitems.push(subText);
      continue;
    }

    const topMatch = TOP_BULLET_RE.exec(trimmed);
    if (topMatch) {
      if (!curSection) {
        curSection = { title: pickLang(lang, 'Изменения', 'Changes'), items: [] };
        curVersion.sections.push(curSection);
      }
      const parsed = splitLeadAndBody(cleanChangelogInlineText(topMatch[1]));
      lastItem = {
        lead: parsed.lead,
        text: parsed.text,
        subitems: [],
      };
      curSection.items.push(lastItem);
      continue;
    }

    const contText = cleanChangelogInlineText(trimmed);
    if (contText && lastItem) {
      if (lastItem.subitems.length > 0) {
        const idx = lastItem.subitems.length - 1;
        lastItem.subitems[idx] = `${lastItem.subitems[idx]} ${contText}`.trim();
      } else {
        lastItem.text = lastItem.text ? `${lastItem.text} ${contText}` : contText;
      }
    }
  }

  finalizeItemCount(curVersion);

  return {
    title,
    intro: introParts.join(' ').trim(),
    versions,
  };
}

/**
 * Loads localized CHANGELOG (`CHANGELOG.ru.md` or `CHANGELOG.md`) and optionally prepends an un-installed newer remote release.
 * @param {{ pluginRoot?: string, currentVersion?: string, remoteRelease?: object | null, lang?: string }} [options={}]
 */
export function loadPluginChangelog(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const root = resolve(
    typeof opts.pluginRoot === 'string' && opts.pluginRoot.trim()
      ? opts.pluginRoot.trim()
      : DEFAULT_PLUGIN_ROOT
  );
  const lang = normalizeLang(
    typeof opts.lang === 'string' && opts.lang.trim() ? opts.lang : readActiveUiLanguage(root),
    'en'
  );
  const meta = readPluginMeta(root);
  const resolvedCurrent = typeof opts.currentVersion === 'string' && opts.currentVersion.trim()
    ? opts.currentVersion.trim().replace(/^v/i, '')
    : meta.version;

  const resolvedFile = resolveChangelogFilePath(root, lang);
  if (!resolvedFile.path) {
    return {
      ok: true,
      lang,
      sourceFile: '',
      currentVersion: resolvedCurrent,
      repo: meta.repo,
      releaseUrl: `${meta.homepage}/releases`,
      totalVersions: 0,
      missingFile: true,
      versions: [],
    };
  }

  let rawMd = '';
  let parsed = null;
  let versions = null;
  try {
    const st = statSync(resolvedFile.path);
    const cacheKey = `${resolvedFile.path}|${lang}|${resolvedCurrent}|${st.mtimeMs}|${st.size}`;
    const hit = _changelogMemCache.get(cacheKey);
    if (hit) {
      parsed = hit.parsed;
      versions = hit.versions.map((v) => ({ ...v }));
    } else {
      rawMd = readFileSync(resolvedFile.path, 'utf8');
      parsed = parseChangelogMarkdown(rawMd, { lang });
      versions = parsed.versions.map((v) => ({
        ...v,
        isCurrent: compareSemver(v.version, resolvedCurrent) === 0 || v.version === resolvedCurrent,
        isRemotePending: false,
        releaseUrl: `${meta.homepage}/releases/tag/v${v.version}`,
      }));
      if (_changelogMemCache.size >= MAX_CHANGELOG_CACHE) {
        const firstKey = _changelogMemCache.keys().next().value;
        if (firstKey !== undefined) _changelogMemCache.delete(firstKey);
      }
      _changelogMemCache.set(cacheKey, { parsed, versions: versions.map((v) => ({ ...v })) });
    }
  } catch {
    rawMd = readFileSync(resolvedFile.path, 'utf8');
    parsed = parseChangelogMarkdown(rawMd, { lang });
    versions = parsed.versions.map((v) => ({
      ...v,
      isCurrent: compareSemver(v.version, resolvedCurrent) === 0 || v.version === resolvedCurrent,
      isRemotePending: false,
      releaseUrl: `${meta.homepage}/releases/tag/v${v.version}`,
    }));
  }

  const remote = opts.remoteRelease && typeof opts.remoteRelease === 'object' ? opts.remoteRelease : null;
  const remoteVer = typeof remote?.latestVersion === 'string' ? remote.latestVersion.trim().replace(/^v/i, '') : '';
  const topLocalVer = versions[0]?.version || '0.0.0';
  if (remoteVer && compareSemver(remoteVer, topLocalVer) > 0) {
    const parsedRemoteSections = parseReleaseNotesBody(
      remote.releaseNotes || '',
      pickLang(lang, 'Изменения', 'Changes')
    );
    const sections = parsedRemoteSections.length > 0
      ? parsedRemoteSections
      : [{
          title: pickLang(lang, 'Доступно обновление на GitHub', 'GitHub Update Available'),
          items: [{
            lead: pickLang(lang, `Версия v${remoteVer}`, `Version v${remoteVer}`),
            text: pickLang(
              lang,
              'Нажмите «Да, обновить» в верхнем баннере, чтобы установить новый релиз с сохранением настроек.',
              'Click "Yes, update" in the top banner to install the new release while keeping your settings.'
            ),
            subitems: [],
          }],
        }];
    const itemCount = sections.reduce((sum, sec) => sum + sec.items.length, 0);
    const publishedDate = typeof remote.publishedAt === 'string' && remote.publishedAt.trim()
      ? remote.publishedAt.trim().slice(0, 10)
      : '';
    versions.unshift({
      version: remoteVer,
      date: publishedDate,
      sections,
      itemCount,
      isCurrent: compareSemver(remoteVer, resolvedCurrent) === 0 || remoteVer === resolvedCurrent,
      isRemotePending: true,
      releaseUrl: typeof remote.releaseUrl === 'string' && remote.releaseUrl.trim() && isAllowedGitHubUrl(remote.releaseUrl.trim())
        ? remote.releaseUrl.trim()
        : `${meta.homepage}/releases/tag/v${remoteVer}`,
    });
  }

  return {
    ok: true,
    lang,
    sourceFile: resolvedFile.fileName,
    title: parsed.title,
    intro: parsed.intro,
    currentVersion: resolvedCurrent,
    repo: meta.repo,
    releaseUrl: `${meta.homepage}/releases`,
    totalVersions: versions.length,
    missingFile: false,
    versions,
  };
}

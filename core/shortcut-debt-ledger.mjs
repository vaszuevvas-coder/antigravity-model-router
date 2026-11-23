/**
 * @file shortcut-debt-ledger.mjs
 * @description Deliberate Technical Debt Harvester (inspired by Ponytail `/ponytail-debt`).
 * Scans repository source files for structured deferral comments (`shortcut: <ceiling>, <upgrade trigger>`
 * or `ponytail: ...`), flags silent-rot entries missing an upgrade trigger (`no-trigger`),
 * and provides single-file debt hints during edits.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import path, { extname, join, relative, resolve } from 'node:path';
import { parseAgentIgnore } from './security-guard.mjs';

const DEFAULT_MAX_FILES = 4000;
const MAX_FILE_BYTES = 256 * 1024;

const SKIP_DIR_RE = /(?:^|\/)(?:node_modules|\.git|dist|build|out|vendor|venv|\.venv|__pycache__|coverage|\.next|target|\.cache|snapshots|exports|migrations|fixtures)(?:\/|$)/i;
const SKIP_TEST_FILE_RE = /(?:^|\/)(?:test_[^/]*|[^/]*(?:_test|\.test|\.spec|\.gen|\.min|\.d)\.[a-z0-9]+)$/i;
const SOURCE_EXT_RE = /\.(?:[cm]?[jt]sx?|py|go|rs|rb|java|kt|kts|scala|c|cc|cpp|h|hpp|cs|swift|php|lua|sh|ps1|sql|vue|svelte|css|scss|yaml|yml|toml)$/i;

const TRIGGER_HINT_RE = /\b(?:when|if|once|after|above|beyond|over|exceeds?|reaches?|at\s+\d|switch\s+to|upgrade\s+to|replace\s+with|migrate\s+to|use\s+\w+\s+(?:if|when)|когда|если|при\s+|после\s+|свыше|больше|перейти\s+на|заменить\s+на)\b|[><=]\s*\d/i;

function escapeRegex(str = '') {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildMarkerLineRegex(customMarker = '') {
  const cleanCustom = String(customMarker || '').trim().replace(/[^a-zA-Zа-яА-ЯёЁ0-9_-]/g, '');
  const markerGroup = cleanCustom
    ? escapeRegex(cleanCustom)
    : '(?:shortcut|ponytail)';
  // Match real comment prefixes (`//`, `#`, `/*`, `*`, `--`, `<!--`) so prose strings mentioning `shortcut:` are skipped.
  return new RegExp(`(?:^|\\s)(?:\\/\\/|#|\\/\\*|\\*|--|<!--)\\s*(${markerGroup})\\s*:\\s*(.+)$`, 'i');
}

function stripTrailingCommentClose(raw = '') {
  return String(raw || '')
    .replace(/\s*(?:\*\/|-->)\s*$/, '')
    .trim();
}

/**
 * Parses the body after `shortcut:` into `{ ceiling, upgradeTrigger, hasTrigger }`.
 * Convention: `shortcut: <the limit / ceiling>, <when to upgrade>`.
 * Also supports `;` or `->` / `—` separators when a comma is omitted.
 */
export function parseShortcutCommentBody(rawBody = '') {
  const cleaned = stripTrailingCommentClose(rawBody);
  if (!cleaned) {
    return { ceiling: '', upgradeTrigger: '', hasTrigger: false, isNonDeferralNote: true };
  }

  // Skip false-positive UI comments about keyboard shortcuts (e.g. `// shortcut: Ctrl+K opens search`)
  if (/^(?:ctrl|cmd|alt|shift|meta|opt|key|hotkey|горяч[а-яё]+\s+клавиш)/i.test(cleaned) && !TRIGGER_HINT_RE.test(cleaned)) {
    return { ceiling: '', upgradeTrigger: '', hasTrigger: false, isNonDeferralNote: true };
  }

  let ceiling = cleaned;
  let upgradeTrigger = '';

  const splitPatterns = [
    /^(.+?)\s*(?:;|->|→|—)\s*(.+)$/,
    /^(.+?),\s*((?:when|if|once|after|switch|upgrade|replace|migrate|use\s+|pass\s+|move\s+|add\s+|когда|если|при\s+|после\s+|перейти|заменить).+)$/i,
    /^(.+?)\.\s+((?:Use|Switch|Upgrade|Replace|Migrate|Pass|Move|When|If|Когда|Если|При\s+|Перейти|Заменить).+)$/i,
    /^(.+?),\s*(.+)$/,
  ];

  for (const pat of splitPatterns) {
    const m = pat.exec(cleaned);
    if (m && m[1] && m[2]) {
      ceiling = m[1].trim();
      upgradeTrigger = m[2].trim();
      break;
    }
  }

  const hasTrigger = Boolean(
    (upgradeTrigger && upgradeTrigger.length >= 4 && TRIGGER_HINT_RE.test(`${ceiling} ${upgradeTrigger}`)) ||
    (upgradeTrigger && /^(?:use|switch|upgrade|replace|migrate|pass|move|перейти|заменить|использовать)\b/i.test(upgradeTrigger))
  );

  return {
    ceiling,
    upgradeTrigger,
    hasTrigger,
    isNonDeferralNote: false,
  };
}

/**
 * Scans a single file's text for `shortcut:` / `ponytail:` debt markers (<1ms).
 * @param {string} relFile
 * @param {string} content
 * @param {{ marker?: string }} [options={}]
 */
export function extractFileShortcutMarkers(relFile = '', content = '', { marker = '' } = {}) {
  const text = typeof content === 'string' ? content : '';
  if (!text) return [];
  const cleanMark = String(marker || '').trim().toLowerCase();
  if (!cleanMark && !text.includes('shortcut:') && !text.includes('ponytail:') && !text.includes('SHORTCUT:') && !text.includes('PONYTAIL:')) {
    return [];
  }

  const lineRe = buildMarkerLineRegex(marker);
  const lines = text.split(/\r?\n/);
  const items = [];

  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i];
    if (lineText.length > 600) continue;
    const m = lineRe.exec(lineText);
    if (!m) continue;
    const parsed = parseShortcutCommentBody(m[2]);
    if (parsed.isNonDeferralNote) continue;
    items.push({
      file: String(relFile || '').replace(/\\/g, '/'),
      line: i + 1,
      marker: m[1].toLowerCase(),
      ceiling: parsed.ceiling,
      upgradeTrigger: parsed.upgradeTrigger,
      hasTrigger: parsed.hasTrigger,
      rotRisk: !parsed.hasTrigger,
      rawBody: stripTrailingCommentClose(m[2]),
    });
  }
  return items;
}

function listWorkspaceCandidateFiles(absRoot, maxFiles = DEFAULT_MAX_FILES) {
  try {
    const stdout = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
      cwd: absRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3500,
      maxBuffer: 64 * 1024 * 1024,
    });
    const tracked = stdout
      .split(/\r?\n/)
      .map((s) => s.trim().replace(/\\/g, '/'))
      .filter(Boolean);
    if (tracked.length > 0) {
      return tracked.slice(0, maxFiles * 3);
    }
  } catch {
    // Fallback to bounded directory walk when outside a git repo
  }

  const out = [];
  const walk = (dir, depth) => {
    if (depth > 7 || out.length >= maxFiles * 3) return;
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.name.startsWith('.') && ent.name !== '.github') continue;
      const full = join(dir, ent.name);
      const rel = relative(absRoot, full).replace(/\\/g, '/');
      if (ent.isDirectory()) {
        if (!SKIP_DIR_RE.test(`${rel}/`)) walk(full, depth + 1);
      } else if (ent.isFile()) {
        out.push(rel);
      }
      if (out.length >= maxFiles * 3) break;
    }
  };
  walk(absRoot, 0);
  return out;
}

/**
 * Scans a workspace for `shortcut:` / `ponytail:` technical debt markers.
 * @param {string} [workspaceRoot=process.cwd()]
 * @param {{ marker?: string, maxFiles?: number, includeTests?: boolean }} [options={}]
 */
export function scanShortcutDebt(workspaceRoot = process.cwd(), options = {}) {
  const t0 = performance.now();
  const {
    marker = '',
    maxFiles = DEFAULT_MAX_FILES,
    includeTests = false,
  } = options && typeof options === 'object' ? options : {};

  if (!workspaceRoot || typeof workspaceRoot !== 'string' || !existsSync(workspaceRoot)) {
    return {
      ok: false,
      workspaceRoot: String(workspaceRoot || ''),
      scannedFiles: 0,
      totalMarkers: 0,
      noTriggerCount: 0,
      items: [],
      byFile: {},
      elapsedMs: 0,
      formatted: '',
    };
  }

  const absRoot = resolve(workspaceRoot);
  const agentIgnore = parseAgentIgnore(absRoot);
  const candidates = listWorkspaceCandidateFiles(absRoot, maxFiles);
  const items = [];
  const byFile = {};
  let scannedFiles = 0;

  for (const rel of candidates) {
    if (scannedFiles >= maxFiles) break;
    if (!SOURCE_EXT_RE.test(rel)) continue;
    if (SKIP_DIR_RE.test(rel)) continue;
    if (!includeTests && SKIP_TEST_FILE_RE.test(rel)) continue;
    if (agentIgnore?.ignores?.(rel)) continue;

    const absFile = join(absRoot, rel);
    try {
      const st = lstatSync(absFile);
      if (!st.isFile() || st.size > MAX_FILE_BYTES) continue;
      const content = readFileSync(absFile, 'utf8');
      scannedFiles++;
      const hits = extractFileShortcutMarkers(rel, content, { marker });
      if (hits.length > 0) {
        byFile[rel] = hits;
        items.push(...hits);
      }
    } catch {
      // Ignore unreadable files
    }
  }

  const noTriggerCount = items.filter((it) => it.rotRisk).length;
  const elapsedMs = Number((performance.now() - t0).toFixed(2));
  const report = {
    ok: true,
    workspaceRoot: absRoot,
    scannedFiles,
    totalMarkers: items.length,
    noTriggerCount,
    items,
    byFile,
    elapsedMs,
    formatted: '',
  };
  report.formatted = formatShortcutDebtReport(report);
  return report;
}

/**
 * Formats the shortcut debt ledger as a concise human/CLI report.
 */
export function formatShortcutDebtReport(report = {}, { lang = 'ru' } = {}) {
  const isEn = lang === 'en';
  if (!report || !report.ok) {
    return isEn ? '❌ Failed to scan shortcut debt ledger.' : '❌ Не удалось просканировать реестр техдолга shortcut:.';
  }
  if (report.totalMarkers === 0) {
    return isEn
      ? `✅ No shortcut debt. Clean ledger (${report.scannedFiles} files scanned in ${report.elapsedMs}ms).`
      : `✅ Осознанный техдолг (shortcut:) не обнаружен. Чистый реестр (проверено ${report.scannedFiles} файлов за ${report.elapsedMs} мс).`;
  }

  const lines = [
    isEn
      ? `📌 [Shortcut Debt Ledger] ${report.totalMarkers} markers (${report.noTriggerCount} with no-trigger rot risk):`
      : `📌 [Реестр техдолга shortcut:] ${report.totalMarkers} меток (риск забвения no-trigger: ${report.noTriggerCount}):`,
  ];

  for (const item of report.items.slice(0, 40)) {
    const tag = item.rotRisk ? ' ⚠️ [no-trigger]' : '';
    const upg = item.upgradeTrigger
      ? (isEn ? ` | upgrade: ${item.upgradeTrigger}` : ` | триггер: ${item.upgradeTrigger}`)
      : '';
    lines.push(`  - ${item.file}:${item.line} — ceiling: ${item.ceiling}${upg}${tag}`);
  }
  if (report.items.length > 40) {
    lines.push(`  ... +${report.items.length - 40} more`);
  }
  return lines.join('\n');
}

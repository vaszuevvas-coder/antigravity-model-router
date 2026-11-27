#!/usr/bin/env node
/**
 * @file query-ux-matrix.mjs
 * @description Pure Node.js query engine over skills/ui-ux-design-system/references/ux-matrix.json
 *   Combines UI/UX Pro Max (MIT), Impeccable surface modes (Apache-2.0), and Taste three dials (MIT).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandRuQueryToEnTerms } from '../../../core/ru-en-lexicon.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REFERENCES_DIR = path.resolve(__dirname, '..', 'references');
const MATRIX_PATH = path.join(REFERENCES_DIR, 'ux-matrix.json');
const TEMPLATE_PATH = path.join(REFERENCES_DIR, 'design-md-template.md');

let cachedMatrix = null;

export function loadUxMatrix(customPath = MATRIX_PATH) {
  const validPath =
    typeof customPath === 'string' && customPath.trim().length > 0 && !customPath.includes('\0')
      ? customPath.trim()
      : MATRIX_PATH;
  if (validPath === MATRIX_PATH && cachedMatrix) return cachedMatrix;
  const raw = fs.readFileSync(validPath, 'utf8');
  const parsed = JSON.parse(raw);
  if (validPath === MATRIX_PATH) cachedMatrix = parsed;
  return parsed;
}

const RU_UX_DOMAIN_SUPPLEMENTS = [
  [/(?:финтех|финанс|банк|кошел|платеж|крипт|трейд)/i, ['fintech', 'finance', 'banking', 'crypto', 'dashboard']],
  [/(?:аналит|дашборд|метрик|телеметр|график|диаграмм|отчет|отчёт|консол|админ|панел)/i, ['analytics', 'dashboard', 'chart', 'admin', 'console', 'operate']],
  [/(?:магазин|маркет|товар|корзин|каталог|коммерц|оплат|заказ)/i, ['ecommerce', 'store', 'shop', 'product', 'checkout']],
  [/(?:медиц|клиник|здоров|врач|пациент|аптек)/i, ['healthcare', 'medical', 'clinic', 'wellness']],
  [/(?:образован|курс|обучен|школ|урок|студент)/i, ['education', 'learning', 'course', 'edtech']],
  [/(?:портфолио|галере|витрин|шоукейс|креатив|студи|агентств)/i, ['portfolio', 'gallery', 'showcase', 'agency', 'experience']],
  [/(?:лендинг|промо|маркетинг|стартап|геро|онбординг|главн)/i, ['landing', 'marketing', 'hero', 'saas', 'persuade']],
  [/(?:документ|блог|стать|справк|руковод|вики|база\s+знан)/i, ['docs', 'article', 'blog', 'manual', 'read']],
  [/(?:недвиж|аренд|бронир|отел|путешест)/i, ['real estate', 'booking', 'travel', 'property']],
  [/(?:чат|мессендж|ии|нейросет|ассистент|бот)/i, ['ai', 'chat', 'assistant', 'copilot']],
  [/(?:игр|гейм|лобби|инвентар)/i, ['game', 'gaming', 'hud']],
];

function expandBilingualUxQuery(rawText = '') {
  const base = String(rawText || '').trim();
  if (!base || !/[а-яё]/i.test(base)) {
    return { expandedText: base, extraTokens: [] };
  }
  const extra = new Set();
  const lex = expandRuQueryToEnTerms(base, { maxTerms: 24 });
  for (const term of lex.enTerms || []) extra.add(term.toLowerCase());
  for (const [rx, terms] of RU_UX_DOMAIN_SUPPLEMENTS) {
    if (rx.test(base)) {
      for (const t of terms) extra.add(t.toLowerCase());
    }
  }
  const extraTokens = Array.from(extra);
  const expandedText = extraTokens.length > 0 ? `${base} ${extraTokens.join(' ')}` : base;
  return { expandedText, extraTokens };
}

function tokenize(text = '') {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-zа-яё0-9]+/i)
    .filter((t) => t.length >= 2);
}

function scoreItem(item, tokens, queryLower) {
  const hay = JSON.stringify(item).toLowerCase();
  let score = 0;
  if (queryLower && hay.includes(queryLower)) score += 6;
  for (const tok of tokens) {
    if (hay.includes(tok)) score += 2;
  }
  return score;
}

function readDealHistory(historyPath = '') {
  if (!historyPath || typeof historyPath !== 'string' || historyPath.includes('\0')) return { palettes: [], typography: [] };
  try {
    if (!fs.existsSync(historyPath)) return { palettes: [], typography: [] };
    const parsed = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
    return {
      palettes: Array.isArray(parsed?.palettes) ? parsed.palettes.map(String) : [],
      typography: Array.isArray(parsed?.typography) ? parsed.typography.map(String) : [],
    };
  } catch {
    return { palettes: [], typography: [] };
  }
}

function writeDealHistory(historyPath = '', history = { palettes: [], typography: [] }, chosenPalette = null, chosenType = null) {
  if (!historyPath || typeof historyPath !== 'string' || historyPath.includes('\0')) return;
  const next = {
    palettes: [...(history.palettes || [])],
    typography: [...(history.typography || [])],
  };
  const pKey = chosenPalette ? String(chosenPalette.productType || chosenPalette.primary || '') : '';
  const tKey = chosenType ? String(chosenType.name || chosenType.heading || '') : '';
  if (pKey) next.palettes = [...next.palettes.filter((x) => x !== pKey), pKey].slice(-12);
  if (tKey) next.typography = [...next.typography.filter((x) => x !== tKey), tKey].slice(-12);
  try {
    fs.mkdirSync(path.dirname(path.resolve(historyPath)), { recursive: true });
    fs.writeFileSync(path.resolve(historyPath), JSON.stringify(next, null, 2), 'utf8');
  } catch {
    // Non-fatal: history persistence should never block matrix queries
  }
}

function pickTop(items = [], tokens = [], queryLower = '', limit = 3, recentKeys = [], keyFn = null) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const recentSet = new Set(Array.isArray(recentKeys) ? recentKeys : []);
  const applyHistoryOrder = (list) => {
    if (recentSet.size === 0 || typeof keyFn !== 'function') return list;
    const fresh = [];
    const used = [];
    for (const item of list) {
      if (recentSet.has(String(keyFn(item) || ''))) used.push(item);
      else fresh.push(item);
    }
    return [...fresh, ...used];
  };
  if (tokens.length === 0 && !queryLower) return applyHistoryOrder(items).slice(0, limit);
  const scored = items
    .map((item, idx) => ({ item, idx, score: scoreItem(item, tokens, queryLower) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.idx - b.idx);
  const ordered = scored.length > 0 ? scored.map((r) => r.item) : items;
  return applyHistoryOrder(ordered).slice(0, limit);
}

/**
 * Queries curated UI/UX design matrix for reasoning rules, palettes, typography, charts, and Taste dials.
 * @param {object} [params={}]
 */
export function queryUxMatrix(opts = {}) {
  const {
    domain = '',
    mode = '',
    stack = '',
    includeCharts = false,
    limit = 3,
    matrixPath = MATRIX_PATH,
    historyPath = '',
  } = opts && typeof opts === 'object' ? opts : {};
  const matrix = loadUxMatrix(matrixPath);
  const history = readDealHistory(historyPath);
  const queryText = [domain, stack].filter(Boolean).join(' ').trim();
  const { expandedText, extraTokens } = expandBilingualUxQuery(queryText);
  const queryLower = expandedText.toLowerCase();
  const tokens = Array.from(new Set([...tokenize(expandedText), ...extraTokens]));
  const safeLimit = Math.max(1, Math.min(10, Number(limit) || 3));

  const normMode = String(mode || '').trim().toLowerCase();
  const surfaceKey = matrix.surfaceModes && Object.hasOwn(matrix.surfaceModes, normMode)
    ? normMode
    : (/landing|marketing|hero|store|shop|persuade/i.test(queryLower)
        ? 'persuade'
        : /docs|article|blog|guide|manual|read/i.test(queryLower)
          ? 'read'
          : /portfolio|gallery|showcase|3d|webgl|experience/i.test(queryLower)
            ? 'experience'
            : 'operate');

  const surfaceMode = matrix.surfaceModes?.[surfaceKey] || {
    label: 'Operate',
    description: 'Scanability, consistent tokens, restraint.',
    recommendedDials: { DESIGN_VARIANCE: 3, MOTION_INTENSITY: 3, VISUAL_DENSITY: 8 },
  };

  const stackTokens = tokenize(stack || '');
  const stackGuidelines = stackTokens.length > 0 && Array.isArray(matrix.stacks)
    ? pickTop(matrix.stacks, stackTokens, String(stack || '').toLowerCase(), Math.min(3, safeLimit))
    : [];

  const palettes = pickTop(
    matrix.palettes,
    tokens,
    queryLower,
    safeLimit,
    history.palettes,
    (p) => p?.productType || p?.primary || ''
  );
  const typography = pickTop(
    matrix.typography,
    tokens,
    queryLower,
    safeLimit,
    history.typography,
    (t) => t?.name || t?.heading || ''
  );
  if (historyPath) {
    writeDealHistory(historyPath, history, palettes[0], typography[0]);
  }

  return {
    ok: true,
    query: queryText || '(general)',
    expandedTerms: extraTokens,
    surfaceModeKey: surfaceKey,
    surfaceMode,
    tasteDials: surfaceMode.recommendedDials,
    reasoning: pickTop(matrix.reasoning, tokens, queryLower, safeLimit),
    palettes,
    typography,
    uxGuidelines: pickTop(matrix.uxGuidelines, tokens, queryLower, Math.max(3, safeLimit)),
    stackGuidelines,
    motion: pickTop(matrix.motion, tokens, queryLower, 2),
    charts: includeCharts ? pickTop(matrix.charts, tokens, queryLower, safeLimit) : [],
  };
}

export function formatUxBrief(res = {}) {
  if (!res || !res.ok) return 'No UX matrix results.';
  const d = res.tasteDials || {};
  const lines = [
    `🎨 [UI/UX Pro Max + Taste + Impeccable Brief] Query: "${res.query}"`,
    `- Surface Mode: ${res.surfaceMode?.label || res.surfaceModeKey} — ${res.surfaceMode?.description || ''}`,
    `- Taste Dials (1..10): DESIGN_VARIANCE=${d.DESIGN_VARIANCE ?? 4}, MOTION_INTENSITY=${d.MOTION_INTENSITY ?? 4}, VISUAL_DENSITY=${d.VISUAL_DENSITY ?? 6}`,
  ];
  if (res.reasoning?.[0]) {
    const r = res.reasoning[0];
    lines.push(`- Pattern (${r.category}): ${r.pattern} | Style: ${r.style} | Avoid: ${r.antiPatterns}`);
  }
  if (res.palettes?.[0]) {
    const p = res.palettes[0];
    lines.push(`- Palette (${p.productType}): primary=${p.primary}, accent=${p.accent}, bg=${p.bg}, fg=${p.fg}, card=${p.card}, border=${p.border}`);
  }
  if (res.typography?.[0]) {
    const t = res.typography[0];
    lines.push(`- Typography (${t.name}): heading="${t.heading}" + body="${t.body}" (${t.mood})`);
  }
  if (res.uxGuidelines?.length) {
    lines.push(`- Key UX Rules: ${res.uxGuidelines.slice(0, 3).map((u) => `[${u.category}] ${u.doRule}`).join(' | ')}`);
  }
  if (res.stackGuidelines?.length) {
    lines.push(`- Stack Rules (${res.stackGuidelines[0].stack}): ${res.stackGuidelines.map((s) => s.doRule).join(' | ')}`);
  }
  if (res.charts?.length) {
    lines.push(`- Chart Guidance: ${res.charts.slice(0, 2).map((c) => `${c.dataType} -> ${c.bestChart} (a11y: ${c.a11yFallback})`).join(' | ')}`);
  }
  return lines.join('\n');
}

export function initDesignMd(targetDir = process.cwd(), rawOpts = {}) {
  const { domain = 'App UI', mode = 'operate', overwrite = false } =
    rawOpts && typeof rawOpts === 'object' ? rawOpts : {};
  const cleanDir =
    typeof targetDir === 'string' && targetDir.trim().length > 0 && !targetDir.includes('\0')
      ? targetDir.trim()
      : process.cwd();
  const dirAbs = path.resolve(cleanDir);
  const outPath = path.join(dirAbs, 'DESIGN.md');
  if (fs.existsSync(outPath) && !overwrite) {
    return { ok: false, exists: true, outPath, reason: 'DESIGN.md already exists' };
  }
  const tpl = fs.existsSync(TEMPLATE_PATH)
    ? fs.readFileSync(TEMPLATE_PATH, 'utf8')
    : '# DESIGN.md\n\n- Surface Mode: {{SURFACE_MODE}}\n- Taste Dials: {{TASTE_DIALS}}\n';
  const res = queryUxMatrix({ domain, mode });
  const p = res.palettes?.[0] || {};
  const t = res.typography?.[0] || {};
  const r = res.reasoning?.[0] || {};
  const d = res.tasteDials || {};
  const rendered = tpl
    .replaceAll('{{DOMAIN}}', domain || 'Product UI')
    .replaceAll('{{SURFACE_MODE}}', `${res.surfaceMode?.label || 'Operate'} (${res.surfaceMode?.description || ''})`)
    .replaceAll('{{TASTE_DIALS}}', `DESIGN_VARIANCE=${d.DESIGN_VARIANCE ?? 4}, MOTION_INTENSITY=${d.MOTION_INTENSITY ?? 4}, VISUAL_DENSITY=${d.VISUAL_DENSITY ?? 6}`)
    .replaceAll('{{PRIMARY}}', p.primary || '#2563EB')
    .replaceAll('{{ACCENT}}', p.accent || '#EA580C')
    .replaceAll('{{BG_CANVAS}}', p.bg || '#F8FAFC')
    .replaceAll('{{TEXT_PRIMARY}}', p.fg || '#1E293B')
    .replaceAll('{{BG_SURFACE}}', p.card || '#FFFFFF')
    .replaceAll('{{BORDER_SUBTLE}}', p.border || '#E2E8F0')
    .replaceAll('{{HEADING_FONT}}', t.heading || 'Plus Jakarta Sans')
    .replaceAll('{{BODY_FONT}}', t.body || 'Inter')
    .replaceAll('{{ANTI_PATTERNS}}', r.antiPatterns || 'No cliché AI purple gradients, no uncalibrated nesting');

  fs.mkdirSync(dirAbs, { recursive: true });
  fs.writeFileSync(outPath, rendered, 'utf8');
  return { ok: true, outPath, surfaceMode: res.surfaceModeKey };
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  const self = path.resolve(__filename);
  const arg = path.resolve(process.argv[1]);
  return process.platform === 'win32' ? self.toLowerCase() === arg.toLowerCase() : self === arg;
})();
if (isMain) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: node query-ux-matrix.mjs [domain] [--mode persuade|operate|read|experience] [--stack <name>] [--limit 3] [--charts] [--init-design-md <dir>] [--overwrite] [--json]');
    process.exit(0);
  }
  let domain = '';
  let mode = '';
  let stack = '';
  let limit = 3;
  let includeCharts = false;
  let asJson = false;
  let initDir = '';
  let historyPath = '';
  let overwrite = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--domain=')) domain = a.slice('--domain='.length);
    else if (a === '--domain' && i + 1 < args.length && !args[i + 1].startsWith('-')) domain = args[++i];
    else if (a.startsWith('--mode=')) mode = a.slice('--mode='.length);
    else if (a === '--mode' && i + 1 < args.length && !args[i + 1].startsWith('-')) mode = args[++i];
    else if (a.startsWith('--stack=')) stack = a.slice('--stack='.length);
    else if (a === '--stack' && i + 1 < args.length && !args[i + 1].startsWith('-')) stack = args[++i];
    else if (a.startsWith('--limit=')) limit = Number(a.slice('--limit='.length)) || 3;
    else if (a === '--limit' && i + 1 < args.length && !args[i + 1].startsWith('-')) limit = Number(args[++i]) || 3;
    else if (a.startsWith('--history=')) historyPath = a.slice('--history='.length);
    else if (a === '--history' && i + 1 < args.length && !args[i + 1].startsWith('-')) historyPath = args[++i];
    else if (a.startsWith('--init-design-md=')) initDir = a.slice('--init-design-md='.length);
    else if (a === '--init-design-md' && i + 1 < args.length && !args[i + 1].startsWith('-')) initDir = args[++i];
    else if (a === '--charts') includeCharts = true;
    else if (a === '--json') asJson = true;
    else if (a === '--overwrite') overwrite = true;
    else if (!a.startsWith('-') && !domain) domain = a;
  }
  if (initDir) {
    const initRes = initDesignMd(initDir, { domain: domain || 'App UI', mode: mode || 'operate', overwrite });
    console.log(JSON.stringify(initRes, null, 2));
    process.exit(initRes.ok ? 0 : 1);
  }
  const res = queryUxMatrix({ domain, mode, stack, includeCharts, limit, historyPath });
  console.log(asJson ? JSON.stringify(res, null, 2) : formatUxBrief(res));
}

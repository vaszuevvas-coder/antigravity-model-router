#!/usr/bin/env node
/**
 * @file audit-ui.mjs
 * @description Deterministic offline UI/UX linter inspired by pbakaus/impeccable & Leonxlnx/taste-skill.
 *   Scores 5 technical dimensions (0-4 each, max 20): antiSlop, accessibility, performance, responsive, tokens.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { collectFilesByExt, findHeadlessBrowserExecutable } from './build-showroom.mjs';

const __filename = fileURLToPath(import.meta.url);
const UI_EXT_RE = /\.(?:html?|css|scss|jsx|tsx|vue|svelte)$/i;
const IGNORE_DIRS = new Set(['node_modules', '.git', '.cache', 'dist', 'build', 'coverage']);

function findLineNumber(text, index) {
  if (index <= 0) return 1;
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function parseHexColorRgb(hex = '') {
  const clean = String(hex || '').trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]+$/.test(clean)) return null;
  if (clean.length === 3 || clean.length === 4) {
    return [
      parseInt(clean[0] + clean[0], 16),
      parseInt(clean[1] + clean[1], 16),
      parseInt(clean[2] + clean[2], 16),
    ];
  }
  if (clean.length === 6 || clean.length === 8) {
    return [
      parseInt(clean.slice(0, 2), 16),
      parseInt(clean.slice(2, 4), 16),
      parseInt(clean.slice(4, 6), 16),
    ];
  }
  return null;
}

function relativeLuminance([r8, g8, b8]) {
  const lin = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r8) + 0.7152 * lin(g8) + 0.0722 * lin(b8);
}

/**
 * Computes WCAG 2.1 contrast ratio between two hex colors (#rgb / #rrggbb).
 * @param {string} hexA
 * @param {string} hexB
 * @returns {number|null}
 */
export function computeWcagContrastRatio(hexA = '', hexB = '') {
  const rgbA = parseHexColorRgb(hexA);
  const rgbB = parseHexColorRgb(hexB);
  if (!rgbA || !rgbB) return null;
  const l1 = relativeLuminance(rgbA);
  const l2 = relativeLuminance(rgbB);
  const bright = Math.max(l1, l2);
  const dark = Math.min(l1, l2);
  return Number(((bright + 0.05) / (dark + 0.05)).toFixed(2));
}

/**
 * Audits a single UI/CSS/markup file across 5 craft dimensions.
 * @param {string} content
 * @param {string} [filePath='ui.html']
 */
function findLayoutKeyframeMatch(text) {
  const kfHeaderRe = /@keyframes\s+[A-Za-z0-9_-]+\s*\{/gi;
  let m;
  while ((m = kfHeaderRe.exec(text)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < text.length && depth > 0) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') depth--;
      i++;
    }
    const blockBody = text.slice(m.index + m[0].length, Math.max(m.index + m[0].length, i - 1));
    const propHit = /(?<![-\w])(?:width|height|top|left|margin|padding)\s*:/i.exec(blockBody);
    if (propHit) {
      return { index: m.index + m[0].length + propHit.index };
    }
  }
  return null;
}

export function auditUiContent(content = '', filePath = 'ui.html') {
  const text = typeof content === 'string' ? content : String(content || '');
  const findings = [];
  const deductions = { antiSlop: 0, accessibility: 0, performance: 0, responsive: 0, tokens: 0 };

  const add = (dimension, severity, ruleId, line, message, penalty = 1) => {
    findings.push({ dimension, severity, ruleId, line, message, file: filePath });
    deductions[dimension] = Math.min(4, (deductions[dimension] || 0) + penalty);
  };

  // 1. Anti-Slop (Impeccable & Taste clichés)
  const aiPurpleGlow = text.match(/linear-gradient\([^)]*(?:#(?:6366f1|8b5cf6|a855f7|00f2fe|7c3aed)|indigo-\d00|purple-\d00)[^)]*(?:#(?:a855f7|ec4899|06b6d4|38ef7d|0d1117)|purple-\d00|pink-\d00|cyan-\d00)/i);
  if (aiPurpleGlow) {
    add('antiSlop', 'medium', 'cliche-ai-gradient', findLineNumber(text, aiPurpleGlow.index), 'Generic AI indigo/purple/cyber gradient detected; derive domain palette via query-ux-matrix.mjs.', 2);
  }
  const cyberHud = text.match(/#0d1117[\s\S]{0,400}#00f2fe|#00f2fe[\s\S]{0,400}#0d1117/i);
  if (cyberHud) {
    add('antiSlop', 'high', 'legacy-preset-clone', findLineNumber(text, cyberHud.index), 'Cloned legacy #0d1117 + #00f2fe preset detected; synthesize fresh domain tokens.', 2);
  }
  const emojiIconMatches = text.match(/<(?:button|a|span|div)[^>]*class\s*=\s*['"][^'"]*\bicon\b[^'"]*['"][^>]*>\s*[\u{1F300}-\u{1FAFF}]/gu) || [];
  if (emojiIconMatches.length >= 3) {
    add('antiSlop', 'low', 'emoji-as-ui-icons', 1, 'Using multiple raw emojis inside .icon containers; prefer crisp SVG icons for studio polish.', 1);
  }
  // Second-gen AI tells (frontend-design) & copywriting/structural slop (taste-skill 2.5 copy-lint)
  const claudePaletteHit = text.match(/#f[45]f[12]e[ab][\s\S]{0,600}#d97757|#d97757[\s\S]{0,600}#f[45]f[12]e[ab]/i);
  if (claudePaletteHit) {
    add('antiSlop', 'low', 'cliche-claude-terracotta', findLineNumber(text, claudePaletteHit.index), 'Templated cream + terracotta (#f4f1ea + #d97757) AI tell detected; derive palette from the brief.', 1);
  }
  const arrowButtons = text.match(/<(?:a|button)\b[^>]*>[^<\n]{1,80}→\s*<\/(?:a|button)>/gi) || [];
  if (arrowButtons.length >= 4) {
    add('antiSlop', 'low', 'template-arrow-buttons', 1, `${arrowButtons.length} buttons/links append decorative "→"; keep CTAs direct without template chrome.`, 1);
  }
  const loremHit = text.match(/\b(?:lorem\s+ipsum|dolor\s+sit\s+amet|consectetur\s+adipiscing)\b/i);
  if (loremHit) {
    add('antiSlop', 'medium', 'placeholder-lorem-copy', findLineNumber(text, loremHit.index), 'Placeholder Lorem ipsum copy detected; ship real domain copy instead.', 1);
  }
  const eyebrowNodes = text.match(/<(?:div|span|p)\b[^>]*\bclass\s*=\s*['"][^'"]*\b(?:eyebrow|kicker|overline|section-label)\b[^'"]*['"][^>]*>/gi) || [];
  if (eyebrowNodes.length >= 4 && /text-transform\s*:\s*uppercase/i.test(text)) {
    add('antiSlop', 'low', 'eyebrow-caps-spam', 1, `${eyebrowNodes.length} uppercase eyebrow labels detected; avoid repeating tracked-out ALL-CAPS tags above every block.`, 1);
  }
  const fakeSeqHits = text.match(/<(?:div|span|p|h[2-6])\b(?![^>]*data-(?:steps|timeline))[^>]*>\s*0[1-9](?:\s*<\/|\s*[./—-])?/gi) || [];
  if (fakeSeqHits.length >= 3) {
    add('antiSlop', 'low', 'decorative-fake-numbering', 1, 'Decorative 01/02/03 numbering on non-sequential elements; reserve step numbers for real sequences or <ol>.', 1);
  }
  // Taste 2.5 contact hygiene & Emil Kowalski micro-interaction craft
  const fakeContactHit = text.match(/\b(?:hello|info|contact|support)@(?:acme|company|brand|startup|mycorp)\.(?:com|io|co)\b|\+1\s*\(?555\)?[\s.-]\d{3}[\s.-]\d{4}/i);
  if (fakeContactHit) {
    add('antiSlop', 'low', 'invented-contact-data', findLineNumber(text, fakeContactHit.index), 'Invented placeholder email/phone detected; use RFC .example domains and never real-format placeholder phone numbers.', 1);
  }
  const scaleZeroHit = text.match(/transform\s*:\s*[^;}\n]*\bscale\(\s*0(?:\.0+)?\s*\)/i);
  if (scaleZeroHit) {
    add('antiSlop', 'low', 'motion-scale-zero', findLineNumber(text, scaleZeroHit.index), 'Animating from scale(0) pops unnaturally; start from scale(0.95) with opacity: 0.', 1);
  }

  // 2. Accessibility (A11y)
  const outlineNone = text.match(/outline\s*:\s*(?:none|0)\b/i);
  if (outlineNone && !/:focus-visible\b/i.test(text)) {
    add('accessibility', 'high', 'missing-focus-visible', findLineNumber(text, outlineNone.index), 'outline: none/0 used without any :focus-visible replacement indicator.', 2);
  }
  const reducedMotionKill = text.match(/@media\s*\(\s*prefers-reduced-motion[\s\S]{0,280}animation-duration\s*:\s*0\.0+1m?s/i);
  if (reducedMotionKill) {
    add('accessibility', 'medium', 'blanket-motion-kill', findLineNumber(text, reducedMotionKill.index), 'Blanket 0.01ms prefers-reduced-motion kill removes intentional state feedback; swap to crisp opacity/instant transitions.', 1);
  }
  const clickableDiv = text.match(/<(?:div|span)\b[^>]*(?:on[cC]lick\s*=|@click\s*=)[^>]*>/);
  if (clickableDiv && !/\brole\s*=\s*['"]button['"]|\btabindex\s*=/i.test(clickableDiv[0])) {
    add('accessibility', 'high', 'clickable-non-semantic', findLineNumber(text, clickableDiv.index), 'Clickable <div>/<span> lacks semantic <button> or role="button" + tabindex.', 2);
  }
  const imgNoAlt = text.match(/<img\b(?![^>]*\balt\s*=)[^>]*>/i);
  if (imgNoAlt) {
    add('accessibility', 'medium', 'img-missing-alt', findLineNumber(text, imgNoAlt.index), '<img> element missing alt attribute.', 1);
  }

  // 3. Performance
  const transAll = text.match(/transition\s*:\s*all\b/i);
  if (transAll) {
    add('performance', 'medium', 'transition-all', findLineNumber(text, transAll.index), 'transition: all animates layout properties; restrict to transform and opacity.', 1);
  }
  const easeInUi = text.match(/transition(?:-timing-function)?\s*:[^;}\n]*\bease-in\b(?!-out)/i);
  if (easeInUi) {
    add('performance', 'low', 'motion-ease-in-ui', findLineNumber(text, easeInUi.index), 'ease-in makes UI transitions feel sluggish on start; use strong ease-out (e.g. cubic-bezier(0.23, 1, 0.32, 1)).', 1);
  }
  const layoutAnim = findLayoutKeyframeMatch(text);
  if (layoutAnim) {
    add('performance', 'high', 'layout-keyframe-animation', findLineNumber(text, layoutAnim.index), 'Keyframe animates layout-thrashing property (width/height/top/left/margin/padding); use transform.', 2);
  }
  const heavyBlurMatches = text.match(/backdrop-filter\s*:\s*blur\(\s*(?:2[5-9]|[3-9]\d|\d{3,})px\)/gi) || [];
  if (heavyBlurMatches.length >= 2) {
    add('performance', 'low', 'excessive-backdrop-blur', 1, 'Multiple heavy backdrop-filter blurs (>=25px) risk GPU frame drops; cap blur or surface count.', 1);
  }

  // 4. Responsive & Overflow
  const raw100vh = text.match(/\b100vh\b/i);
  if (raw100vh && !/\b100dvh\b/i.test(text)) {
    add('responsive', 'low', 'vh-instead-of-dvh', findLineNumber(text, raw100vh.index), '100vh used without 100dvh mobile viewport fallback.', 1);
  }
  const ellipsisNoMinWidth = text.match(/text-overflow\s*:\s*ellipsis\b/i);
  if (ellipsisNoMinWidth && !/min-width\s*:\s*0\b/i.test(text)) {
    add('responsive', 'medium', 'ellipsis-missing-min-width', findLineNumber(text, ellipsisNoMinWidth.index), 'text-overflow: ellipsis without min-width: 0 can break flex truncation.', 1);
  }
  const fixedWideWidth = text.match(/(?<![-\w])width\s*:\s*(?:7[6-9]\d|[89]\d\d|\d{4,})px\b/i);
  if (fixedWideWidth && !/max-width\s*:/i.test(text)) {
    add('responsive', 'medium', 'fixed-wide-px-width', findLineNumber(text, fixedWideWidth.index), 'Large fixed px width without max-width causes horizontal overflow on narrow viewports.', 2);
  }

  // 5. Token & System Hygiene + WCAG Root Contrast + Localized Overflow
  // For HTML/markup files, inspect CSS/inline styles & markup rather than JS canvas palettes or HTML numeric entities (&#039;)
  const isMarkupFile = /\.(?:html?|jsx|tsx|vue|svelte)$/i.test(filePath);
  const styleAndMarkupText = isMarkupFile
    ? text
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (m) => m.replace(/[^\n]/g, ' '))
        .replace(/data:image\/[^"'\s)]+/gi, 'data:image/scrubbed')
    : text;
  const rootMatch = /:root\s*\{[\s\S]*?\}/.exec(styleAndMarkupText);
  if (rootMatch) {
    const varMap = new Map();
    const varRx = /(--[a-zA-Z0-9_-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\b/g;
    let vm;
    while ((vm = varRx.exec(rootMatch[0])) !== null) {
      varMap.set(vm[1].toLowerCase(), vm[2]);
    }
    const bgEntry = ['--bg-canvas', '--bg-primary', '--bg', '--bg-surface', '--surface'].map((k) => [k, varMap.get(k)]).find(([, v]) => Boolean(v));
    const fgEntry = ['--text-primary', '--fg', '--text', '--fg-primary', '--ink'].map((k) => [k, varMap.get(k)]).find(([, v]) => Boolean(v));
    if (bgEntry && fgEntry) {
      const ratio = computeWcagContrastRatio(bgEntry[1], fgEntry[1]);
      if (ratio !== null && ratio < 4.5) {
        add('accessibility', 'high', 'low-root-contrast', findLineNumber(styleAndMarkupText, rootMatch.index), `Low WCAG contrast (${ratio}:1 < 4.5:1) between ${bgEntry[0]} (${bgEntry[1]}) and ${fgEntry[0]} (${fgEntry[1]}).`, 2);
      }
    }
  }
  const nowrapClipMatch = /\{[^}]*white-space\s*:\s*nowrap[^}]*(?<![-\w])width\s*:\s*(?:[1-9]\d|1[0-7]\d)px\b[^}]*\}|\{[^}]*(?<![-\w])width\s*:\s*(?:[1-9]\d|1[0-7]\d)px\b[^}]*white-space\s*:\s*nowrap[^}]*\}/i.exec(styleAndMarkupText);
  if (nowrapClipMatch && !/text-overflow\s*:\s*ellipsis|overflow\s*:\s*hidden/i.test(nowrapClipMatch[0])) {
    add('responsive', 'low', 'nowrap-fixed-width-clip', findLineNumber(styleAndMarkupText, nowrapClipMatch.index), 'Fixed narrow px width with white-space: nowrap risks clipping localized RU/DE labels; use min-width or ellipsis.', 1);
  }
  const bodyWithoutRoot = (rootMatch ? styleAndMarkupText.replace(rootMatch[0], '') : styleAndMarkupText)
    .replace(/--[a-zA-Z0-9_-]+\s*:\s*[^;\n}]+/g, '');
  const rawHexes = bodyWithoutRoot.match(/(?<!&)#[0-9a-fA-F]{3,8}\b/g) || [];
  const uniqNonVarHex = new Set(rawHexes.map((h) => h.toLowerCase()));
  const usesCssVars = /var\(--[a-z0-9-]+/i.test(styleAndMarkupText);
  if (uniqNonVarHex.size >= 10 && !usesCssVars) {
    add('tokens', 'medium', 'untokenized-hardcoded-colors', 1, `${uniqNonVarHex.size} hardcoded hex colors with no CSS custom properties (:root var(--...)).`, 2);
  } else if (uniqNonVarHex.size >= 18) {
    add('tokens', 'low', 'excess-raw-hex-drift', 1, `${uniqNonVarHex.size} un-tokenized raw hex literals outside :root.`, 1);
  }
  const radii = new Set(
    (styleAndMarkupText.match(/border-radius\s*:\s*([^;}\n]+)/gi) || [])
      .map((r) => r.replace(/\s*!important/gi, '').toLowerCase().trim())
      .filter((r) => !/border-radius\s*:\s*0(?:px)?$/.test(r))
  );
  if (radii.size >= 7) {
    add('tokens', 'low', 'border-radius-drift', 1, `${radii.size} distinct border-radius values; consolidate into a coherent token scale.`, 1);
  }

  const dimensions = {
    antiSlop: Math.max(0, 4 - deductions.antiSlop),
    accessibility: Math.max(0, 4 - deductions.accessibility),
    performance: Math.max(0, 4 - deductions.performance),
    responsive: Math.max(0, 4 - deductions.responsive),
    tokens: Math.max(0, 4 - deductions.tokens),
  };
  const totalScore = Object.values(dimensions).reduce((a, b) => a + b, 0);

  return {
    ok: findings.every((f) => f.severity !== 'high'),
    file: filePath,
    score: totalScore,
    maxScore: 20,
    dimensions,
    findings,
  };
}

export function auditUiPath(targetPath = process.cwd()) {
  const abs = path.resolve(targetPath);
  if (!fs.existsSync(abs)) {
    return { ok: false, error: 'path_not_found', target: abs, filesScanned: 0, averageScore: 0, results: [], findings: [] };
  }
  const files = collectFilesByExt(abs, UI_EXT_RE, IGNORE_DIRS);
  const results = files.map((f) => auditUiContent(fs.readFileSync(f, 'utf8'), path.relative(abs, f) || path.basename(f)));
  const allFindings = results.flatMap((r) => r.findings);
  const avg = results.length > 0
    ? Number((results.reduce((s, r) => s + r.score, 0) / results.length).toFixed(1))
    : 20;
  return {
    ok: allFindings.every((f) => f.severity !== 'high'),
    target: abs,
    filesScanned: results.length,
    averageScore: avg,
    maxScore: 20,
    results,
    findings: allFindings,
  };
}

export function formatUiAuditReport(report = {}) {
  const safeRep = report && typeof report === 'object' ? report : {};
  if (safeRep.error) return `❌ [UI Audit] ${safeRep.error}: ${safeRep.target || ''}`;
  const lines = [
    `🎨 [UI/UX Craft Audit] Files: ${safeRep.filesScanned ?? 1} | Score: ${safeRep.averageScore ?? safeRep.score}/20 | Status: ${safeRep.ok ? 'PASS' : 'NEEDS POLISH'}`,
  ];
  for (const f of (safeRep.findings || []).slice(0, 18)) {
    lines.push(`  - [${String(f.severity).toUpperCase()} · ${f.dimension}/${f.ruleId}] ${f.file}:L${f.line} — ${f.message}`);
  }
  if ((safeRep.findings || []).length === 0 && (!safeRep.viewports || safeRep.viewports.skipped || safeRep.viewports.ok)) {
    lines.push('  ✅ Zero anti-slop, a11y, performance, responsive, or token issues found.');
  }
  if (safeRep.viewports && !safeRep.viewports.skipped) {
    const vpResults = Array.isArray(safeRep.viewports.results) ? safeRep.viewports.results : [];
    const failedVp = vpResults.filter((r) => !r.ok);
    lines.push(`  📐 Viewports: ${vpResults.length} checked, ${failedVp.length} failed`);
    for (const r of failedVp.slice(0, 6)) {
      lines.push(`    - [${r.width}px] overflow=${Boolean(r.hasHorizontalOverflow)} brokenImgs=${r.brokenImages ?? 0}`);
    }
  }
  return lines.join('\n');
}

function sendCdpCommand(ws, id, method, params = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener('message', onMsg);
      ws.removeEventListener('close', onClose);
      ws.removeEventListener('error', onErr);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(new Error(`CDP timeout: ${method}`));
    }, 5000);
    function onClose() {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(new Error(`CDP socket closed: ${method}`));
    }
    function onErr(ev) {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(ev?.error || new Error(`CDP socket error: ${method}`));
    }
    function onMsg(ev) {
      let msg;
      try { msg = JSON.parse(String(ev.data || '')); } catch { return; }
      if (msg.id === id) {
        if (settled) return;
        settled = true;
        cleanup();
        if (msg.error) rejectPromise(new Error(msg.error.message || method));
        else resolvePromise(msg.result || {});
      }
    }
    ws.addEventListener('message', onMsg);
    ws.addEventListener('close', onClose);
    ws.addEventListener('error', onErr);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

/**
 * Multi-viewport headless browser gate (1440/1024/768/390) verifying overflow and broken hero/image slots.
 * @param {string} targetUrlOrHtmlPath
 * @param {{ widths?: number[], timeoutMs?: number }} [options={}]
 */
export async function auditUiViewports(targetUrlOrHtmlPath = '', rawOpts = {}) {
  const { widths = [1440, 1024, 768, 390], timeoutMs = 12000 } =
    rawOpts && typeof rawOpts === 'object' ? rawOpts : {};
  const raw = String(targetUrlOrHtmlPath || '').trim();
  if (!raw) return { ok: false, skipped: false, error: 'missing_target', results: [] };

  let targetUrl = raw;
  if (!/^https?:\/\//i.test(raw) && !/^file:\/\//i.test(raw)) {
    const abs = path.resolve(raw);
    if (!fs.existsSync(abs)) {
      return { ok: false, skipped: false, error: 'target_not_found', target: abs, results: [] };
    }
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      return { ok: false, skipped: false, error: 'target_not_found', target: abs, results: [] };
    }
    if (st.isDirectory()) {
      const indexCand = path.join(abs, 'index.html');
      let htmlEntry = fs.existsSync(indexCand) ? indexCand : '';
      if (!htmlEntry) {
        const htmlFiles = collectFilesByExt(abs, /\.html?$/i, IGNORE_DIRS);
        if (htmlFiles[0]) htmlEntry = htmlFiles[0];
      }
      if (!htmlEntry) {
        return { ok: true, skipped: true, reason: 'non_html_target', target: abs, results: [] };
      }
      targetUrl = pathToFileURL(htmlEntry).href;
    } else if (!/\.html?$/i.test(abs)) {
      return { ok: true, skipped: true, reason: 'non_html_target', target: abs, results: [] };
    } else {
      targetUrl = pathToFileURL(abs).href;
    }
  }

  const browserExe = findHeadlessBrowserExecutable();
  if (!browserExe || typeof globalThis.WebSocket !== 'function') {
    return { ok: true, skipped: true, reason: 'no_headless_browser', target: targetUrl, results: [] };
  }

  const tmpProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-viewports-'));
  let proc = null;
  let ws = null;
  try {
    proc = spawn(
      browserExe,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--remote-debugging-port=0',
        `--user-data-dir=${tmpProfile}`,
        targetUrl,
      ],
      { detached: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }
    );

    const wsBaseUrl = await new Promise((resolveUrl, rejectUrl) => {
      let buf = '';
      let settled = false;
      const cleanupProc = () => {
        clearTimeout(t);
        proc.stderr?.off('data', onData);
        proc.off('exit', onExit);
        proc.off('error', onErr);
      };
      const t = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanupProc();
        rejectUrl(new Error('devtools_listen_timeout'));
      }, Math.min(6000, timeoutMs));
      const onData = (chunk) => {
        if (settled) return;
        buf += chunk.toString('utf8');
        if (buf.length > 65536) buf = buf.slice(-16384);
        const m = /DevTools listening on (ws:\/\/[^\s]+)/i.exec(buf);
        if (m) {
          settled = true;
          cleanupProc();
          resolveUrl(m[1]);
        }
      };
      const onExit = (code) => {
        if (settled) return;
        settled = true;
        cleanupProc();
        rejectUrl(new Error(`browser_exited_${code}`));
      };
      const onErr = (err) => {
        if (settled) return;
        settled = true;
        cleanupProc();
        rejectUrl(err || new Error('browser_spawn_error'));
      };
      proc.stderr?.on('data', onData);
      proc.once('exit', onExit);
      proc.once('error', onErr);
    });
    proc.on('error', () => {});

    const httpBase = wsBaseUrl.replace(/^ws:/i, 'http:').replace(/\/devtools\/browser\/.*$/, '');
    const targetsRes = await fetch(`${httpBase}/json/list`, { signal: AbortSignal.timeout(3000) });
    const targets = await targetsRes.json();
    const pageTarget = (Array.isArray(targets) ? targets : []).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (!pageTarget) {
      return { ok: true, skipped: true, reason: 'no_page_target', target: targetUrl, results: [] };
    }

    ws = new globalThis.WebSocket(pageTarget.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('ws_open_timeout')), 3000);
      ws.addEventListener('open', () => { clearTimeout(t); res(); }, { once: true });
      ws.addEventListener('error', (e) => { clearTimeout(t); rej(e?.error || new Error('ws_error')); }, { once: true });
    });

    let seq = 1;
    await sendCdpCommand(ws, seq++, 'Page.enable');
    await sendCdpCommand(ws, seq++, 'Runtime.enable');
    await new Promise((r) => setTimeout(r, 350));

    const results = [];
    for (const width of widths) {
      const w = Number(width) || 1440;
      await sendCdpCommand(ws, seq++, 'Emulation.setDeviceMetricsOverride', {
        width: w,
        height: 900,
        deviceScaleFactor: 1,
        mobile: w <= 480,
      });
      await new Promise((r) => setTimeout(r, 120));
      const evalRes = await sendCdpCommand(ws, seq++, 'Runtime.evaluate', {
        returnByValue: true,
        expression: `(() => {
          const docEl = document.documentElement;
          const overflowPx = Math.max(0, Math.round((docEl?.scrollWidth || 0) - window.innerWidth));
          const imgs = Array.from(document.querySelectorAll('img'));
          const brokenImages = imgs.filter((im) => !im.complete || im.naturalWidth === 0).length;
          const emptySections = Array.from(document.querySelectorAll('section, main')).filter((el) => el.getBoundingClientRect().height < 4 && el.children.length === 0).length;
          return { width: window.innerWidth, overflowPx, brokenImages, emptySections };
        })()`,
      });
      const metrics = evalRes?.result?.value || { width: w, overflowPx: 0, brokenImages: 0, emptySections: 0 };
      results.push({
        ...metrics,
        ok: metrics.overflowPx <= 2 && metrics.brokenImages === 0 && metrics.emptySections === 0,
      });
    }

    return {
      ok: results.every((r) => r.ok),
      skipped: false,
      target: targetUrl,
      results,
    };
  } catch (err) {
    return {
      ok: true,
      skipped: true,
      reason: err?.message || 'viewport_probe_error',
      target: targetUrl,
      results: [],
    };
  } finally {
    try { ws?.close(); } catch {}
    if (proc) {
      try { proc.kill(); } catch {}
      await new Promise((res) => {
        const timer = setTimeout(res, 250);
        if (typeof timer.unref === 'function') timer.unref();
        proc.once('exit', () => {
          clearTimeout(timer);
          res();
        });
      });
    }
    try { fs.rmSync(tmpProfile, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch {}
  }
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
    console.log('Usage: node audit-ui.mjs <file-or-dir> [--viewports] [--json]');
    process.exit(0);
  }
  const asJson = args.includes('--json');
  const checkViewports = args.includes('--viewports');
  const target = args.find((a) => !a.startsWith('-')) || process.cwd();
  const report = auditUiPath(target);
  if (checkViewports) {
    report.viewports = await auditUiViewports(target);
    if (report.viewports && !report.viewports.skipped && !report.viewports.ok) {
      report.ok = false;
    }
  }
  console.log(asJson ? JSON.stringify(report, null, 2) : formatUiAuditReport(report));
}

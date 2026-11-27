#!/usr/bin/env node
/**
 * @file run-webapp-dogfood.mjs
 * @description Autonomous Dogfood QA & compact @eN interactive DOM distiller (inspired by vercel-labs/agent-browser).
 *   Uses external `agent-browser` CLI when installed for live CDP snapshots & console errors,
 *   or falls back to zero-dependency static HTML/DOM inspection (~90% smaller than raw HTML).
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);

function stripTagsAndSpaces(html = '') {
  return String(html || '')
    .replace(/<[^>]{1,300}>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function readHtmlAttr(attrs = '', name = '') {
  const rx = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]{0,400})"|'([^']{0,400})'|([^\\s>]{1,200}))`, 'i');
  const m = rx.exec(attrs);
  if (!m) return '';
  return String(m[1] ?? m[2] ?? m[3] ?? '').trim();
}

/**
 * Probes whether `agent-browser` CLI binary is available in PATH.
 * @param {Function} [spawnSyncImpl]
 * @returns {{ installed: boolean, version: string }}
 */
export function detectAgentBrowserCli(spawnSyncImpl = spawnSync) {
  if (typeof spawnSyncImpl !== 'function') {
    return { installed: false, version: '' };
  }
  try {
    const res = spawnSyncImpl('agent-browser', ['--version'], {
      windowsHide: true,
      timeout: 1500,
      encoding: 'utf8',
    });
    if (res.status === 0) {
      return { installed: true, version: String(res.stdout || '').trim().slice(0, 80) };
    }
  } catch {}
  return { installed: false, version: '' };
}

/**
 * Distills HTML into a compact `@e1..@eN` interactive control tree (~90% fewer tokens than raw DOM)
 * and flags accessibility/QA issues (unlabeled buttons, dead href="#", empty data-action, duplicate IDs).
 * @param {string} [html='']
 */
export function extractCompactInteractiveRefTree(html = '') {
  const raw = typeof html === 'string' ? html : String(html || '');
  const cleanHtml = raw
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');

  const refs = [];
  const issues = [];
  const seenIds = new Map();

  // Check duplicate IDs across elements (avoid matching data-*-id attributes)
  const idRe = /(?:^|[\s"'<])id\s*=\s*(?:"([^"]{1,120})"|'([^']{1,120})')/gi;
  let idMatch;
  while ((idMatch = idRe.exec(cleanHtml)) !== null) {
    const idVal = String(idMatch[1] ?? idMatch[2] ?? '').trim();
    if (!idVal) continue;
    const prev = seenIds.get(idVal) || 0;
    seenIds.set(idVal, prev + 1);
    if (prev === 1) {
      issues.push({ severity: 'medium', ruleId: 'duplicate-dom-id', detail: `Duplicate id="${idVal}"` });
    }
  }

  // Index explicit <label for="id"> text so associated inputs carry their accessible name
  const labelForMap = new Map();
  const labelForRe = /<label\b([^>]{0,400})>([\s\S]{0,400}?)<\/label>/gi;
  let lfMatch;
  while ((lfMatch = labelForRe.exec(cleanHtml)) !== null) {
    const forId = readHtmlAttr(lfMatch[1] || '', 'for');
    if (forId) {
      const txt = stripTagsAndSpaces(lfMatch[2] || '');
      if (txt) labelForMap.set(forId, txt);
    }
  }

  // Extract interactive elements: button, a, input, select, textarea, or explicit role="button" / data-action
  const controlRe = /<(button|a|input|select|textarea|div|span)\b([^>]{0,1200})(?:>([\s\S]{0,600}?)<\/\1>|\/?>)/gi;
  let m;
  let seq = 1;
  while ((m = controlRe.exec(cleanHtml)) !== null) {
    const tag = m[1].toLowerCase();
    const attrs = m[2] || '';
    const inner = m[3] || '';
    const roleAttr = readHtmlAttr(attrs, 'role').toLowerCase();
    const actionAttr = readHtmlAttr(attrs, 'data-action');
    const hrefAttr = readHtmlAttr(attrs, 'href');
    const typeAttr = readHtmlAttr(attrs, 'type').toLowerCase();

    if ((tag === 'div' || tag === 'span') && roleAttr !== 'button' && !actionAttr) {
      continue;
    }
    if (tag === 'input' && typeAttr === 'hidden') {
      continue;
    }
    if (/(?:^|\s)hidden(?:\s*=\s*(?:""|''|"hidden"|'hidden'|hidden)|(?=\s|$))/i.test(attrs) && !/\btype\s*=\s*["']?hidden/i.test(attrs)) {
      continue;
    }
    if (readHtmlAttr(attrs, 'aria-hidden').toLowerCase() === 'true' && readHtmlAttr(attrs, 'tabindex').trim() === '-1') {
      continue;
    }

    const id = readHtmlAttr(attrs, 'id');
    const ariaLabel = readHtmlAttr(attrs, 'aria-label');
    const titleAttr = readHtmlAttr(attrs, 'title');
    const placeholderAttr = readHtmlAttr(attrs, 'placeholder');
    const valueAttr = readHtmlAttr(attrs, 'value');
    const disabled = /\bdisabled\b/i.test(attrs);
    const textLabel = stripTagsAndSpaces(inner);
    let labelFromElement = id ? (labelForMap.get(id) || '') : '';
    if (!labelFromElement && (tag === 'input' || tag === 'select' || tag === 'textarea')) {
      const beforeChunk = cleanHtml.slice(Math.max(0, m.index - 400), m.index);
      const lastOpenLabel = beforeChunk.lastIndexOf('<label');
      const lastCloseLabel = beforeChunk.lastIndexOf('</label');
      if (lastOpenLabel !== -1 && lastOpenLabel > lastCloseLabel) {
        const afterEnd = cleanHtml.indexOf('</label>', m.index + m[0].length);
        if (afterEnd !== -1 && afterEnd - m.index < 600) {
          labelFromElement = stripTagsAndSpaces(cleanHtml.slice(m.index + m[0].length, afterEnd));
        }
      }
    }
    const label = textLabel || ariaLabel || titleAttr || placeholderAttr || valueAttr || labelFromElement || '';
    const ref = `@e${seq++}`;
    const role = roleAttr || (tag === 'a' ? 'link' : tag === 'input' ? `input:${typeAttr || 'text'}` : tag);

    const missingAccessibleName = !label;
    refs.push({
      ref,
      tag,
      role,
      label: label.slice(0, 120),
      id,
      action: actionAttr,
      href: hrefAttr,
      disabled,
      missingAccessibleName,
    });

    if (missingAccessibleName) {
      issues.push({
        severity: 'medium',
        ruleId: 'unlabeled-interactive-control',
        detail: `${ref} <${tag}${id ? ` id="${id}"` : ''}> lacks visible text, aria-label, title, or placeholder.`,
      });
    }
    if (tag === 'a' && (hrefAttr === '#' || /^javascript:/i.test(hrefAttr)) && !actionAttr) {
      issues.push({
        severity: 'low',
        ruleId: 'dead-anchor-href',
        detail: `${ref} <a> uses dead href="${hrefAttr}" without data-action.`,
      });
    }
    if (/\bdata-action\s*=\s*["']\s*["']/i.test(attrs)) {
      issues.push({
        severity: 'medium',
        ruleId: 'empty-data-action',
        detail: `${ref} <${tag}${id ? ` id="${id}"` : ''}> has empty data-action="".`,
      });
    }
  }

  return {
    interactiveCount: refs.length,
    refs,
    issues,
  };
}

/**
 * Computes `--delta` diff between two interactive ref snapshots.
 * @param {Array<object>} [beforeRefs=[]]
 * @param {Array<object>} [afterRefs=[]]
 */
export function diffInteractiveSnapshots(beforeRefs = [], afterRefs = []) {
  const keyOf = (r) => `${r.tag}|${r.id || ''}|${r.action || ''}|${r.role || ''}`;
  const beforeMap = new Map();
  for (const r of Array.isArray(beforeRefs) ? beforeRefs : []) {
    beforeMap.set(keyOf(r), r);
  }
  const afterMap = new Map();
  for (const r of Array.isArray(afterRefs) ? afterRefs : []) {
    afterMap.set(keyOf(r), r);
  }

  const added = [];
  const removed = [];
  const changed = [];

  for (const [k, after] of afterMap.entries()) {
    const before = beforeMap.get(k);
    if (!before) {
      added.push(after);
    } else if (before.label !== after.label || Boolean(before.disabled) !== Boolean(after.disabled)) {
      changed.push({ before, after });
    }
  }
  for (const [k, before] of beforeMap.entries()) {
    if (!afterMap.has(k)) {
      removed.push(before);
    }
  }

  return { added, removed, changed };
}

function isAllowedDogfoodUrl(raw = '') {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    // Block cloud metadata SSRF IPs/hosts while explicitly allowing localhost/127.0.0.1 for local QA
    if (
      h === '169.254.169.254' ||
      h.startsWith('169.254.') ||
      h.startsWith('::ffff:169.254.') ||
      h.startsWith('::ffff:a9fe:') ||
      h === 'metadata.google.internal' ||
      h === 'metadata.goog'
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs a systematic Dogfood QA inspection on a URL or local HTML file.
 */
export async function runWebappDogfoodAudit(opts = {}) {
  const safe = opts && typeof opts === 'object' && !Array.isArray(opts) ? opts : {};
  const {
    target = '',
    sessionName = '',
    useAgentBrowser = true,
    fetchImpl = globalThis.fetch,
    spawnSyncImpl = spawnSync,
    outPath = '',
  } = safe;
  const rawTarget = String(target || '').trim();
  if (!rawTarget) {
    return { ok: false, error: 'missing_target', engine: 'none', interactiveCount: 0, refs: [], issues: [] };
  }

  const isUrl = /^https?:\/\//i.test(rawTarget);
  if (isUrl && !isAllowedDogfoodUrl(rawTarget)) {
    return { ok: false, error: 'blocked_target_url', engine: 'none', interactiveCount: 0, refs: [], issues: [] };
  }

  let engine = 'builtin-static-dom';
  let refs = [];
  const issues = [];

  if (isUrl && useAgentBrowser) {
    const cli = detectAgentBrowserCli(spawnSyncImpl);
    if (cli.installed) {
      const safeSession = (sessionName || `dogfood-${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 48);
      try {
        const openRes = spawnSyncImpl('agent-browser', ['--session', safeSession, 'open', rawTarget], {
          windowsHide: true,
          timeout: 12000,
          encoding: 'utf8',
        });
        if (openRes.status === 0) {
          engine = 'agent-browser';
          const snapRes = spawnSyncImpl('agent-browser', ['--session', safeSession, 'snapshot', '-i', '--json'], {
            windowsHide: true,
            timeout: 8000,
            encoding: 'utf8',
          });
          if (snapRes.status === 0 && snapRes.stdout) {
            try {
              const parsed = JSON.parse(snapRes.stdout);
              refs = Array.isArray(parsed?.refs) ? parsed.refs : (Array.isArray(parsed) ? parsed : []);
            } catch {}
          }
          const errRes = spawnSyncImpl('agent-browser', ['--session', safeSession, 'errors'], {
            windowsHide: true,
            timeout: 5000,
            encoding: 'utf8',
          });
          if (errRes.status === 0 && String(errRes.stdout || '').trim()) {
            issues.push({
              severity: 'high',
              ruleId: 'browser-runtime-errors',
              detail: String(errRes.stdout).trim().slice(0, 500),
            });
          }
        }
      } finally {
        try {
          spawnSyncImpl('agent-browser', ['--session', safeSession, 'close'], { windowsHide: true, timeout: 3000 });
        } catch {}
      }
    }
  }

  if (engine === 'builtin-static-dom') {
    let html = '';
    if (isUrl) {
      if (typeof fetchImpl !== 'function') {
        return { ok: false, error: 'fetch_unavailable', engine, interactiveCount: 0, refs: [], issues: [] };
      }
      try {
        let curUrl = rawTarget;
        let resp = null;
        for (let hop = 0; hop <= 3; hop++) {
          if (!isAllowedDogfoodUrl(curUrl)) {
            return { ok: false, error: 'blocked_target_url', engine, interactiveCount: 0, refs: [], issues: [] };
          }
          resp = await fetchImpl(curUrl, { redirect: 'manual', signal: AbortSignal.timeout(8000) });
          const status = Number(resp?.status ?? (resp?.ok ? 200 : 0));
          if (status >= 300 && status < 400) {
            const loc = resp?.headers?.get?.('location') || '';
            await resp?.body?.cancel?.().catch(() => {});
            if (!loc || hop >= 3) {
              return { ok: false, error: 'redirect_blocked', engine, interactiveCount: 0, refs: [], issues: [] };
            }
            curUrl = new URL(loc, curUrl).href;
            continue;
          }
          if (resp?.url && !isAllowedDogfoodUrl(String(resp.url))) {
            return { ok: false, error: 'blocked_target_url', engine, interactiveCount: 0, refs: [], issues: [] };
          }
          break;
        }
        if (!resp?.ok) {
          return { ok: false, error: `http_${resp?.status || 'failed'}`, engine, interactiveCount: 0, refs: [], issues: [] };
        }
        html = await resp.text();
      } catch (err) {
        return { ok: false, error: err?.message || 'fetch_failed', engine, interactiveCount: 0, refs: [], issues: [] };
      }
    } else {
      let absFile = path.resolve(rawTarget);
      if (fs.existsSync(absFile) && fs.statSync(absFile).isDirectory()) {
        const indexCand = path.join(absFile, 'index.html');
        const firstHtml = fs.readdirSync(absFile).find((f) => /\.html?$/i.test(f));
        absFile = fs.existsSync(indexCand) ? indexCand : (firstHtml ? path.join(absFile, firstHtml) : indexCand);
      }
      if (!fs.existsSync(absFile)) {
        return { ok: false, error: 'file_not_found', engine, interactiveCount: 0, refs: [], issues: [] };
      }
      html = fs.readFileSync(absFile, 'utf8');
    }
    const extracted = extractCompactInteractiveRefTree(html);
    refs = extracted.refs;
    issues.push(...extracted.issues);
  }

  const highOrMedium = issues.filter((i) => i.severity === 'high' || i.severity === 'medium');
  const summaryLines = [
    `# Dogfood QA Report`,
    `- **Target**: ${rawTarget}`,
    `- **Engine**: ${engine}`,
    `- **Interactive Refs**: ${refs.length}`,
    `- **Findings**: ${issues.length} (${highOrMedium.length} high/medium)`,
    '',
    ...issues.slice(0, 20).map((it) => `- [${String(it.severity).toUpperCase()} · ${it.ruleId}] ${it.detail}`),
  ];
  const summaryMarkdown = summaryLines.join('\n');

  if (outPath) {
    const absOut = path.resolve(outPath);
    fs.mkdirSync(path.dirname(absOut), { recursive: true });
    fs.writeFileSync(absOut, summaryMarkdown, 'utf8');
  }

  return {
    ok: issues.every((i) => i.severity !== 'high'),
    engine,
    target: rawTarget,
    interactiveCount: refs.length,
    refs,
    issues,
    summaryMarkdown,
  };
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  const self = path.resolve(__filename);
  const arg = path.resolve(process.argv[1]);
  return process.platform === 'win32' ? self.toLowerCase() === arg.toLowerCase() : self === arg;
})();
if (isMain) {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const getArg = (flag) => {
    const idx = args.indexOf(flag);
    return idx >= 0 && args[idx + 1] ? args[idx + 1] : '';
  };
  const outPath = getArg('--out');
  const deltaPath = getArg('--delta');
  const target = args.find((a) => !a.startsWith('-') && a !== outPath && a !== deltaPath) || '';
  const report = await runWebappDogfoodAudit({ target, outPath });
  if (deltaPath && fs.existsSync(path.resolve(deltaPath))) {
    try {
      const prev = JSON.parse(fs.readFileSync(path.resolve(deltaPath), 'utf8'));
      const prevRefs = Array.isArray(prev?.refs) ? prev.refs : (Array.isArray(prev) ? prev : []);
      report.delta = diffInteractiveSnapshots(prevRefs, report.refs);
    } catch {}
  }
  console.log(asJson ? JSON.stringify(report, null, 2) : report.summaryMarkdown || `Dogfood QA: ${report.error || 'done'}`);
}

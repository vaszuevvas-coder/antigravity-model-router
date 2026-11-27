#!/usr/bin/env node
/**
 * @file lint-video-composition.mjs
 * @description Deterministic offline linter & seek-snapshot helper for HyperFrames (HTML/GSAP)
 *   and Remotion (React/TSX) programmatic video compositions.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { collectFilesByExt, findHeadlessBrowserExecutable } from '../../ui-ux-design-system/scripts/build-showroom.mjs';

const __filename = fileURLToPath(import.meta.url);
const VIDEO_EXT_RE = /\.(?:html?|tsx?|jsx?|mjs)$/i;
const IGNORE_DIRS = new Set(['node_modules', '.git', '.cache', 'dist', 'build', 'coverage']);

function findLineNumber(text, index) {
  if (index <= 0) return 1;
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

export function detectCompositionMode(code = '', filePath = '') {
  const lower = String(filePath || '').toLowerCase();
  const isRemotion =
    /from\s+['"]remotion['"]|\buseCurrentFrame\s*\(|\buseVideoConfig\s*\(|<Composition\b/i.test(code) ||
    ((lower.endsWith('.tsx') || lower.endsWith('.jsx')) && /AbsoluteFill|Sequence/.test(code));
  if (isRemotion) return 'remotion';

  const isHyperFrames =
    /data-composition-id|window\.__timelines|gsap\.timeline\s*\(/i.test(code) ||
    lower.endsWith('.html') ||
    lower.endsWith('.htm');
  if (isHyperFrames) return 'hyperframes';

  return 'unknown';
}

/**
 * Audits a single HyperFrames or Remotion composition for frame-determinism hazards.
 * @param {string} content
 * @param {string} [filePath='composition.html']
 */
export function lintVideoCompositionContent(content = '', filePath = 'composition.html') {
  const text = typeof content === 'string' ? content : String(content || '');
  const mode = detectCompositionMode(text, filePath);
  const findings = [];

  const add = (severity, ruleId, index, message) => {
    findings.push({
      severity,
      ruleId,
      line: findLineNumber(text, index),
      file: filePath,
      message,
    });
  };

  // Shared non-determinism checks
  const mathRandom = /\bMath\.random\s*\(/.exec(text);
  if (mathRandom) {
    add('high', 'nondeterministic-random', mathRandom.index, 'Math.random() causes frame-to-frame flicker during seek/parallel render; use a seeded PRNG or Remotion random(seed).');
  }
  const dateNow = /\b(?:Date\.now\s*\(|new\s+Date\s*\(\s*\))/.exec(text);
  if (dateNow) {
    add('medium', 'nondeterministic-clock', dateNow.index, 'Wall-clock Date.now()/new Date() breaks repeatable frame rendering; derive time from timeline seconds or frame index.');
  }
  const kfHeaderRe = /@keyframes\s+[A-Za-z0-9_-]+\s*\{/gi;
  let kfMatch;
  while ((kfMatch = kfHeaderRe.exec(text)) !== null) {
    let depth = 1;
    let i = kfMatch.index + kfMatch[0].length;
    while (i < text.length && depth > 0) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') depth--;
      i++;
    }
    const blockBody = text.slice(kfMatch.index + kfMatch[0].length, Math.max(kfMatch.index + kfMatch[0].length, i - 1));
    const propHit = /(?<![-\w])(?:width|height|top|left|margin|padding)\s*:/i.exec(blockBody);
    if (propHit) {
      add('medium', 'layout-keyframe-animation', kfMatch.index + kfMatch[0].length + propHit.index, 'Animating layout properties (width/height/top/left) causes jitter; animate transform and opacity.');
      break;
    }
  }

  if (mode === 'hyperframes') {
    const tlMatch = /gsap\.timeline\s*\(([^)]*)\)/.exec(text);
    if (tlMatch && !/paused\s*:\s*true/.test(tlMatch[1])) {
      add('high', 'hyperframes-unpaused-timeline', tlMatch.index, 'HyperFrames requires gsap.timeline({ paused: true }) so the renderer controls exact seek time.');
    }
    if (/gsap\.(?:timeline|to|from|fromTo)\s*\(/.test(text) && !/window\.__timelines\b/.test(text)) {
      add('high', 'hyperframes-missing-registry', 0, 'Register your GSAP timeline on window.__timelines[compositionId] for HyperFrames frame stepping.');
    }
    if (/gsap\.timeline/.test(text) && !/data-composition-id\s*=/.test(text)) {
      add('medium', 'hyperframes-missing-composition-id', 0, 'Root element lacks data-composition-id / data-duration attributes.');
    }
  } else if (mode === 'remotion') {
    const cssTrans = /\btransition\s*:\s*[^;}\n]+/i.exec(text);
    if (cssTrans) {
      add('high', 'remotion-css-transition', cssTrans.index, 'CSS transition breaks Remotion frame-by-frame capture; compute values from useCurrentFrame() / spring().');
    }
    const rafOrTimer = /\b(?:requestAnimationFrame|setInterval|setTimeout)\s*\(/.exec(text);
    if (rafOrTimer) {
      add('high', 'remotion-async-timer', rafOrTimer.index, 'requestAnimationFrame/setInterval/setTimeout desyncs Remotion parallel renders; use frame-driven math.');
    }
    const interp = /\binterpolate\s*\([^;]+?\)/s.exec(text);
    if (interp && !/extrapolate(?:Left|Right)/.test(interp[0])) {
      add('low', 'remotion-unclamped-interpolate', interp.index, 'Consider extrapolateLeft/Right: "clamp" on interpolate() to prevent out-of-range overshoot.');
    }
  }

  return {
    ok: findings.every((f) => f.severity !== 'high'),
    mode,
    file: filePath,
    findings,
  };
}

export function lintVideoCompositionPath(targetPath = process.cwd()) {
  const abs = path.resolve(targetPath);
  if (!fs.existsSync(abs)) {
    return { ok: false, error: 'path_not_found', target: abs, filesScanned: 0, results: [], findings: [] };
  }
  const files = collectFilesByExt(abs, VIDEO_EXT_RE, IGNORE_DIRS);
  const results = files
    .map((f) => lintVideoCompositionContent(fs.readFileSync(f, 'utf8'), path.relative(abs, f) || path.basename(f)))
    .filter((r) => r.mode !== 'unknown' || files.length === 1);
  const findings = results.flatMap((r) => r.findings);
  return {
    ok: findings.every((f) => f.severity !== 'high'),
    target: abs,
    filesScanned: results.length,
    results,
    findings,
  };
}

/**
 * Captures seeked PNG frames of a HyperFrames HTML composition at specified timestamps using local headless Chrome/Edge.
 */
export function captureHtmlTimelineSnapshots(
  htmlPath,
  { timestampsSec = [0, 1], outDir = '', width = 1280, height = 720, browserExe = findHeadlessBrowserExecutable() } = {}
) {
  const absHtml = path.resolve(htmlPath);
  if (!existsSyncOrFalse(absHtml)) {
    return { ok: false, error: 'html_not_found', snapshots: [] };
  }
  if (!browserExe) {
    return { ok: true, skipped: true, reason: 'no_headless_browser', snapshots: [] };
  }

  const targetOutDir = resolveOutDir(absHtml, outDir);
  fs.mkdirSync(targetOutDir, { recursive: true });
  const rawHtml = fs.readFileSync(absHtml, 'utf8');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-snap-'));
  const snapshots = [];

  try {
    const times = (Array.isArray(timestampsSec) ? timestampsSec : [0])
      .map((n) => Math.max(0, Number(n) || 0))
      .slice(0, 6);

    for (let i = 0; i < times.length; i++) {
      const t = times[i];
      const baseHref = new URL('./', pathToFileURL(absHtml)).href;
      const baseTag = `<base href="${baseHref}">`;
      const withBaseHtml = /<head[^>]*>/i.test(rawHtml)
        ? rawHtml.replace(/<head[^>]*>/i, (m) => `${m}${baseTag}`)
        : `${baseTag}\n${rawHtml}`;
      const inject = `<script>window.addEventListener('DOMContentLoaded',function(){try{var map=window.__timelines||{};for(var k in map){if(map[k]&&typeof map[k].seek==='function'){map[k].pause(${t});map[k].seek(${t});}}}catch(e){}});</script>`;
      const injectedHtml = withBaseHtml.includes('</body>')
        ? withBaseHtml.replace('</body>', `${inject}</body>`)
        : `${withBaseHtml}\n${inject}`;
      const snapHtml = path.join(tmpRoot, `frame-${i}.html`);
      fs.writeFileSync(snapHtml, injectedHtml, 'utf8');
      const outPng = path.join(targetOutDir, `frame-${String(t).replace('.', '_')}s.png`);

      try {
        execFileSync(
          browserExe,
          [
            '--headless',
            '--disable-gpu',
            '--hide-scrollbars',
            '--no-first-run',
            '--no-default-browser-check',
            `--user-data-dir=${path.join(tmpRoot, `prof-${i}`)}`,
            `--window-size=${Math.max(320, Number(width) || 1280)},${Math.max(240, Number(height) || 720)}`,
            `--screenshot=${outPng}`,
            pathToFileURL(snapHtml).href,
          ],
          { timeout: 8000, stdio: 'ignore', windowsHide: true }
        );
        if (fs.existsSync(outPng) && fs.statSync(outPng).size > 100) {
          snapshots.push({ t, path: outPng });
        }
      } catch {}
    }
  } finally {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
  }

  return { ok: true, skipped: false, snapshots };
}

function existsSyncOrFalse(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function resolveOutDir(absHtml, outDir) {
  return outDir ? path.resolve(outDir) : path.join(path.dirname(absHtml), 'snapshots');
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMain) {
  const args = process.argv.slice(2);
  let asJson = false;
  let target = '';
  let snapRaw = '';
  let outDir = '';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') asJson = true;
    else if (a === '--snapshot' && i + 1 < args.length) snapRaw = args[++i];
    else if (a === '--out-dir' && i + 1 < args.length) outDir = args[++i];
    else if (!a.startsWith('-') && !target) target = a;
  }
  const report = lintVideoCompositionPath(target || process.cwd());
  let snapRes = null;
  if (snapRaw && target && /\.html?$/i.test(target)) {
    const times = snapRaw.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n >= 0);
    snapRes = captureHtmlTimelineSnapshots(target, { timestampsSec: times.length ? times : [0, 1], outDir });
  }
  const payload = snapRes ? { ...report, snapshots: snapRes } : report;
  if (asJson) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(`🎬 [Video Composition Lint] Files: ${report.filesScanned} | Status: ${report.ok ? 'PASS' : 'NEEDS FIX'}`);
    for (const f of report.findings) {
      console.log(`  - [${f.severity.toUpperCase()} · ${f.ruleId}] ${f.file}:L${f.line} — ${f.message}`);
    }
    if (snapRes) {
      console.log(`  📸 Snapshots: ${snapRes.skipped ? `skipped (${snapRes.reason})` : `${snapRes.snapshots.length} captured`}`);
    }
  }
  if (!report.ok) process.exit(1);
}

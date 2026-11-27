#!/usr/bin/env node
/**
 * @file extract-design-md.mjs
 * @description Reverse-engineers a DESIGN.md specification from an existing CSS/HTML/JS/TS/Tailwind codebase
 *   at 0 LLM tokens (inspired by pbakaus/impeccable `/impeccable document`).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const STYLE_EXT_RE = /\.(?:css|scss|html?|jsx|tsx|vue|svelte)$/i;
const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.cache', 'dist', 'build', 'coverage', 'releases', 'snapshots',
  '.next', '.nuxt', '.svelte-kit', '.turbo', 'out', 'target', 'vendor', '.venv', '__pycache__',
]);
const LOW_PRIORITY_DESIGN_DIRS = new Set([
  'docs', 'dev-docs', 'doc', 'docs_src', 'examples', 'example', 'playground', 'benchmarks',
  'fixtures', '__fixtures__', '__tests__', 'tests', 'test', 'tutorials', 'samples',
]);

function collectDesignFiles(absRoot, maxFiles = 120) {
  const acc = [];
  let st;
  try {
    st = fs.statSync(absRoot);
  } catch {
    return acc;
  }
  if (st.isFile()) {
    if (STYLE_EXT_RE.test(absRoot) || /tailwind\.config\./i.test(path.basename(absRoot))) acc.push(absRoot);
    return acc;
  }
  const primaryQueue = [{ dir: absRoot, depth: 0 }];
  const lowPriQueue = [];
  let pHead = 0;
  let lHead = 0;

  while ((pHead < primaryQueue.length || lHead < lowPriQueue.length) && acc.length < maxFiles) {
    const item = pHead < primaryQueue.length ? primaryQueue[pHead++] : lowPriQueue[lHead++];
    if (item.depth > 7) continue;
    let entries;
    try {
      entries = fs.readdirSync(item.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      if (acc.length >= maxFiles) break;
      if (IGNORE_DIRS.has(ent.name)) continue;
      if (ent.name.startsWith('.') && ent.name !== '.storybook') continue;
      const full = path.join(item.dir, ent.name);
      if (ent.isDirectory()) {
        if (LOW_PRIORITY_DESIGN_DIRS.has(ent.name.toLowerCase())) {
          lowPriQueue.push({ dir: full, depth: item.depth + 1 });
        } else {
          primaryQueue.push({ dir: full, depth: item.depth + 1 });
        }
      } else if (ent.isFile() && (STYLE_EXT_RE.test(ent.name) || /tailwind\.config\./i.test(ent.name))) {
        acc.push(full);
      }
    }
  }
  return acc;
}

function hexLuminance(hex = '') {
  const clean = hex.replace('#', '').trim();
  let r = 0, g = 0, b = 0;
  if (clean.length === 3 || clean.length === 4) {
    r = parseInt(clean[0] + clean[0], 16) / 255;
    g = parseInt(clean[1] + clean[1], 16) / 255;
    b = parseInt(clean[2] + clean[2], 16) / 255;
  } else if (clean.length === 6 || clean.length === 8) {
    r = parseInt(clean.slice(0, 2), 16) / 255;
    g = parseInt(clean.slice(2, 4), 16) / 255;
    b = parseInt(clean.slice(4, 6), 16) / 255;
  } else {
    return 0.5;
  }
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/**
 * Extracts CSS variables, recurring hex colors, font families, radii, and easings from workspace styles.
 * @param {string} [targetDir=process.cwd()]
 * @param {{ maxFiles?: number }} [options={}]
 */
export function extractDesignTokensFromWorkspace(targetDir = process.cwd(), rawOpts = {}) {
  const { maxFiles = 120 } = rawOpts && typeof rawOpts === 'object' ? rawOpts : {};
  const absRoot = path.resolve(targetDir || process.cwd());
  if (!fs.existsSync(absRoot)) {
    return { ok: false, error: 'path_not_found', target: absRoot };
  }

  const files = collectDesignFiles(absRoot, maxFiles);
  const cssVars = new Map();
  const colorCounts = new Map();
  const fonts = new Map();
  const radii = new Map();
  const easings = new Set();

  for (const f of files) {
    let raw = '';
    try {
      raw = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }

    const rootBlocks = raw.match(/(?::root|@theme|html|body|\.dark|\[data-theme[^\]]*\])[^{]*\{[^}]*\}/g) || [];
    for (const blk of rootBlocks) {
      let m;
      const varRx = /(--[a-zA-Z0-9_-]+)\s*:\s*([^;\n}]+)/g;
      while ((m = varRx.exec(blk)) !== null) {
        const key = m[1].trim();
        const val = m[2].trim();
        if (!cssVars.has(key)) cssVars.set(key, val);
      }
    }
    if (/\.(?:css|scss)$/i.test(f) && cssVars.size < 40) {
      // Capture component/theme custom property definitions (e.g. .excalidraw { --color-primary: ... })
      const blockVarRx = /(--[a-zA-Z0-9_-]+)\s*:\s*([^;\n}]+)/g;
      let bm;
      while ((bm = blockVarRx.exec(raw)) !== null && cssVars.size < 60) {
        const key = bm[1].trim();
        const val = bm[2].trim();
        if (val && !val.startsWith('var(') && !cssVars.has(key)) cssVars.set(key, val);
      }
    }

    for (const hex of raw.match(/#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g) || []) {
      const norm = hex.toLowerCase();
      colorCounts.set(norm, (colorCounts.get(norm) || 0) + 1);
    }

    let fm;
    const fontRx = /font-family\s*:\s*([^;}\n]+)/gi;
    while ((fm = fontRx.exec(raw)) !== null) {
      const val = fm[1].trim().replace(/\s+/g, ' ');
      if (val && !val.startsWith('var(')) fonts.set(val, (fonts.get(val) || 0) + 1);
    }

    let rm;
    const radRx = /border-radius\s*:\s*([^;}\n]+)/gi;
    while ((rm = radRx.exec(raw)) !== null) {
      const val = rm[1].trim();
      if (val && val !== '0' && val !== '0px') radii.set(val, (radii.get(val) || 0) + 1);
    }

    for (const em of raw.match(/cubic-bezier\([^)]+\)/gi) || []) {
      easings.add(em.replace(/\s+/g, ' ').trim());
    }
  }

  const topColors = Array.from(colorCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 16)
    .map(([hex, count]) => ({ hex, count, luminance: Number(hexLuminance(hex).toFixed(3)) }));

  const sortedFonts = Array.from(fonts.entries()).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })).slice(0, 6);
  const sortedRadii = Array.from(radii.entries()).sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, count })).slice(0, 8);

  const varEntries = Array.from(cssVars.entries()).slice(0, 40).map(([name, value]) => ({ name, value }));
  const findVar = (rx) => varEntries.find((v) => rx.test(v.name))?.value || '';

  const lightCanvas = topColors.find((c) => c.luminance >= 0.7)?.hex;
  const darkInk = topColors.find((c) => c.luminance <= 0.15)?.hex;
  const accentHex = topColors.find((c) => c.luminance > 0.12 && c.luminance < 0.72)?.hex;

  const summary = {
    bgCanvas: findVar(/^--(?:bg-canvas|bg-primary|bg-base|bg|canvas|surface-bg|default-bg-color)$/i) || lightCanvas || topColors[0]?.hex || '#faf7f2',
    bgSurface: findVar(/^--(?:bg-surface|surface|surface-primary|card|bg-card|bg-elevated|island-bg-color)$/i) || '#ffffff',
    textPrimary: findVar(/^--(?:text-primary|text-main|fg-primary|fg|text|ink|color-text|color-text-primary|text-primary-color)$/i) || darkInk || '#18181b',
    accentPrimary: findVar(/^--(?:accent-primary|color-primary|accent|primary|brand|color-brand)$/i) || accentHex || '#2563eb',
    borderSubtle: findVar(/^--(?:border-subtle|border|divider|line|default-border-color)$/i) || '#e4e4e7',
    primaryFont: sortedFonts[0]?.name || 'system-ui, sans-serif',
  };

  return {
    ok: true,
    target: absRoot,
    filesScanned: files.length,
    summary,
    cssVariables: varEntries,
    topColors,
    fonts: sortedFonts,
    radii: sortedRadii,
    easings: Array.from(easings).slice(0, 6),
  };
}

/**
 * Generates DESIGN.md from extracted codebase tokens.
 */
export function generateDesignMdFromCode(targetDir = process.cwd(), rawOpts = {}) {
  const { outPath = '', overwrite = false, write = true } =
    rawOpts && typeof rawOpts === 'object' ? rawOpts : {};
  const absRoot = path.resolve(targetDir || process.cwd());
  const extracted = extractDesignTokensFromWorkspace(absRoot);
  if (!extracted.ok) return extracted;

  const baseOutDir = fs.statSync(absRoot).isFile() ? path.dirname(absRoot) : absRoot;
  const targetFile = outPath ? path.resolve(outPath) : path.join(baseOutDir, 'DESIGN.md');
  if (write && fs.existsSync(targetFile) && !overwrite) {
    return { ok: false, exists: true, outPath: targetFile, reason: 'DESIGN.md already exists' };
  }

  const s = extracted.summary;
  const varsLines = extracted.cssVariables.length
    ? extracted.cssVariables.slice(0, 18).map((v) => `- \`${v.name}\`: \`${v.value}\``)
    : ['- _(No explicit `:root` custom properties found yet — migrate hardcoded hexes into `:root` tokens.)_'];

  const markdown = [
    `# DESIGN.md — ${path.basename(absRoot)} (Extracted Blueprint)`,
    '',
    `- **Extracted From**: ${extracted.filesScanned} style/component file(s)`,
    `- **Surface Mode**: Operate / Product UI (document derived tokens before adding new screens)`,
    '',
    '## Core Palette Tokens',
    `- **Canvas (\`--bg-canvas\`)**: \`${s.bgCanvas}\``,
    `- **Surface (\`--bg-surface\`)**: \`${s.bgSurface}\``,
    `- **Primary Text (\`--text-primary\`)**: \`${s.textPrimary}\``,
    `- **Accent (\`--accent-primary\`)**: \`${s.accentPrimary}\``,
    `- **Border (\`--border-subtle\`)**: \`${s.borderSubtle}\``,
    '',
    '## Typography, Radii & Motion',
    `- **Primary Font Stack**: ${s.primaryFont}`,
    `- **Radii Scale**: ${extracted.radii.map((r) => `\`${r.value}\``).join(', ') || '`6px`, `10px`, `14px`'}`,
    `- **Custom Easings**: ${extracted.easings.map((e) => `\`${e}\``).join(', ') || '`cubic-bezier(0.22, 1, 0.36, 1)`'}`,
    '',
    '## Discovered `:root` Custom Properties',
    ...varsLines,
    '',
  ].join('\n');

  if (write) {
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.writeFileSync(targetFile, markdown, 'utf8');
  }

  return {
    ok: true,
    outPath: targetFile,
    written: Boolean(write),
    filesScanned: extracted.filesScanned,
    summary: extracted.summary,
    markdown,
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
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: node extract-design-md.mjs [targetDir] [--write] [--overwrite] [--out <DESIGN.md>] [--json]');
    process.exit(0);
  }
  const doWrite = args.includes('--write');
  const overwrite = args.includes('--overwrite');
  const asJson = args.includes('--json');
  let outPath = '';
  let target = '';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--out=')) outPath = a.slice('--out='.length);
    else if (a === '--out' && i + 1 < args.length && !args[i + 1].startsWith('-')) outPath = args[++i];
    else if (!a.startsWith('-') && !target) target = a;
  }
  target = target || process.cwd();
  const res = doWrite
    ? generateDesignMdFromCode(target, { outPath, overwrite, write: true })
    : extractDesignTokensFromWorkspace(target);
  if (asJson) {
    console.log(JSON.stringify(res, null, 2));
  } else if (res.ok) {
    console.log(
      doWrite
        ? `🎨 [DESIGN.md Extracted] Written to ${res.outPath} (${res.filesScanned} files scanned)`
        : `🎨 [DESIGN Tokens] Scanned ${res.filesScanned} files | canvas=${res.summary.bgCanvas} text=${res.summary.textPrimary} accent=${res.summary.accentPrimary} vars=${res.cssVariables.length}`
    );
  } else {
    console.error(`❌ [extract-design-md] ${res.reason || res.error}`);
    process.exit(1);
  }
}

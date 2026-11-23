/**
 * @file panel-ui-builder.mjs
 * @description Deterministic compiler for `sidecars/panel/ui-src/*` -> single CSP-clean `sidecars/panel/ui.html`.
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_REPO_ROOT = path.resolve(__dirname, '..');

const STYLES_PLACEHOLDER = '/*__PANEL_STYLES__*/';
const SCRIPT_PLACEHOLDER = '/*__PANEL_SCRIPT__*/';
const INLINE_HANDLER_RE = /\bon(?:click|change|input|keydown|keyup)\s*=/i;

/**
 * Compiles modular `sidecars/panel/ui-src` assets into `sidecars/panel/ui.html`.
 * Safely skips when `ui-src/head-body.html` is absent (e.g. installed plugin or release archive).
 * @param {{ repoRoot?: string, checkOnly?: boolean }} [options={}]
 */
export function buildPanelUi(opts = {}) {
  const { repoRoot = DEFAULT_REPO_ROOT, checkOnly = false } = opts && typeof opts === 'object' ? opts : {};
  const root = path.resolve(repoRoot || DEFAULT_REPO_ROOT);
  const panelDir = path.join(root, 'sidecars', 'panel');
  const srcDir = path.join(panelDir, 'ui-src');
  const templatePath = path.join(srcDir, 'head-body.html');
  const stylesPath = path.join(srcDir, 'styles.css');
  const jsDir = path.join(srcDir, 'js');
  const outPath = path.join(panelDir, 'ui.html');

  if (!fs.existsSync(templatePath) || !fs.existsSync(stylesPath) || !fs.existsSync(jsDir)) {
    return { ok: true, skipped: true, reason: 'ui_src_absent', outPath };
  }

  const template = fs.readFileSync(templatePath, 'utf8').replace(/\r\n/g, '\n');
  if (!template.includes(STYLES_PLACEHOLDER) || !template.includes(SCRIPT_PLACEHOLDER)) {
    throw new Error('ui-src/head-body.html missing required /*__PANEL_STYLES__*/ or /*__PANEL_SCRIPT__*/ placeholder');
  }

  const styles = fs.readFileSync(stylesPath, 'utf8').replace(/\r\n/g, '\n').replace(/\n$/, '');
  const jsFiles = fs
    .readdirSync(jsDir)
    .filter((f) => f.endsWith('.js'))
    .sort((a, b) => a.localeCompare(b));
  if (jsFiles.length === 0) {
    throw new Error('ui-src/js contains no .js files');
  }

  const scriptParts = jsFiles.map((fileName) =>
    fs.readFileSync(path.join(jsDir, fileName), 'utf8').replace(/\r\n/g, '\n').replace(/\n$/, '')
  );
  const combinedScript = scriptParts.join('\n');

  // Validate compiled JS syntax & CSP hygiene before emitting ui.html
  new vm.Script(combinedScript, { filename: 'sidecars/panel/ui.html' });

  const compiled = template
    .replace(STYLES_PLACEHOLDER, () => styles)
    .replace(SCRIPT_PLACEHOLDER, () => combinedScript);

  if (INLINE_HANDLER_RE.test(compiled)) {
    throw new Error('Compiled ui.html violated CSP guard: inline on* handler detected');
  }

  const existing = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8').replace(/\r\n/g, '\n') : '';
  const changed = existing !== compiled;

  if (checkOnly) {
    return {
      ok: !changed,
      skipped: false,
      changed,
      inSync: !changed,
      jsFiles,
      outPath,
      lines: compiled.split('\n').length,
    };
  }

  if (changed) {
    fs.writeFileSync(outPath, compiled, 'utf8');
  }

  return {
    ok: true,
    skipped: false,
    changed,
    inSync: true,
    jsFiles,
    outPath,
    lines: compiled.split('\n').length,
  };
}

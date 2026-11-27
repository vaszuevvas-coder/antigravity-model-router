#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPanelUi } from '../core/panel-ui-builder.mjs';

const __filename = fileURLToPath(import.meta.url);
const isMain = (() => {
  if (!process.argv[1]) return false;
  const self = path.resolve(__filename);
  const arg = path.resolve(process.argv[1]);
  return process.platform === 'win32' ? self.toLowerCase() === arg.toLowerCase() : self === arg;
})();

if (isMain) {
  const args = new Set(process.argv.slice(2));
  const checkOnly = args.has('--check');
  const res = buildPanelUi({ checkOnly });

  if (checkOnly && !res.ok) {
    console.error('[✗] sidecars/panel/ui.html устарел относительно sidecars/panel/ui-src. Запустите: node scripts/build-panel-ui.mjs');
    process.exit(1);
  }

  console.log(
    res.skipped
      ? '[i] ui-src отсутствует, сборка пропущена'
      : `[✓] ui.html собран (${res.lines} строк, ${res.jsFiles.length} JS-модулей, changed=${res.changed})`
  );
}

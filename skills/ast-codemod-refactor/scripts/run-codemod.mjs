#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyContentSyntax } from '../../../core/auto-verifier.mjs';
import { atomicWriteJsonSync } from '../../../core/safe-json.mjs';

const DEFAULT_EXTS = ['.mjs', '.js', '.ts', '.tsx', '.jsx', '.json', '.md'];
const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.cache',
  '.agents',
  'scratch',
  'checkpoints',
  'backups',
  '.shadow',
  'dist',
  'build',
  'coverage',
  '.antigravity'
]);

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function collectFiles(dirOrFile, extensions, acc = []) {
  try {
    const stat = fs.statSync(dirOrFile);
    if (stat.isFile()) {
      const ext = path.extname(dirOrFile).toLowerCase();
      if (extensions.includes(ext)) {
        acc.push(dirOrFile);
      }
      return acc;
    }
    const entries = fs.readdirSync(dirOrFile, { withFileTypes: true });
    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      const fullPath = path.join(dirOrFile, entry.name);
      if (entry.isDirectory()) {
        collectFiles(fullPath, extensions, acc);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (extensions.includes(ext)) {
          acc.push(fullPath);
        }
      }
    }
  } catch {
    // Ignore unreadable dirs/files
  }
  return acc;
}

export function runCodemod(options = {}) {
  try {
    if (!options || typeof options !== 'object') {
      return { ok: false, error: 'Invalid options', scannedFiles: 0, modifiedFiles: [], syntaxVerified: 0, rolledBack: [] };
    }

    const {
      rootDir = process.cwd(),
      find = '',
      replace = '',
      isRegex = false,
      extensions = DEFAULT_EXTS,
      dryRun = false,
      wordBoundary = false
    } = options;

    if (!find || typeof find !== 'string' && !(find instanceof RegExp)) {
      return { ok: false, error: 'Target pattern (find) is required', scannedFiles: 0, modifiedFiles: [], syntaxVerified: 0, rolledBack: [] };
    }

    const targetDir = typeof rootDir === 'string' ? path.resolve(rootDir) : process.cwd();
    if (!fs.existsSync(targetDir)) {
      return { ok: false, error: `Directory not found: ${targetDir}`, scannedFiles: 0, modifiedFiles: [], syntaxVerified: 0, rolledBack: [] };
    }

    const validExts = Array.isArray(extensions)
      ? extensions.map((e) => (typeof e === 'string' ? (e.startsWith('.') ? e : `.${e}`).toLowerCase() : '')).filter(Boolean)
      : DEFAULT_EXTS;

    let searchPattern;
    try {
      const rawFind = find instanceof RegExp ? find.source : String(find);
      if (isRegex || find instanceof RegExp) {
        const patternStr = wordBoundary ? `(?<![A-Za-z0-9_$])(?:${rawFind})(?![A-Za-z0-9_$])` : rawFind;
        searchPattern = new RegExp(patternStr, 'g');
      } else {
        const escaped = escapeRegex(rawFind);
        const patternStr = wordBoundary ? `(?<![A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])` : escaped;
        searchPattern = new RegExp(patternStr, 'g');
      }
    } catch (err) {
      return { ok: false, error: `Regex compilation failed: ${err.message}`, scannedFiles: 0, modifiedFiles: [], syntaxVerified: 0, rolledBack: [] };
    }

    const allFiles = collectFiles(targetDir, validExts);
    const modifiedFiles = [];
    const rolledBack = [];
    const backupSnapshot = {};
    let syntaxVerified = 0;

    for (const filePath of allFiles) {
      let content;
      try {
        content = fs.readFileSync(filePath, 'utf8');
      } catch {
        continue;
      }

      if (!searchPattern.test(content)) {
        continue;
      }
      searchPattern.lastIndex = 0;

      const replaceStr = String(replace ?? '');
      const newContent = (isRegex || find instanceof RegExp)
        ? content.replace(searchPattern, replaceStr)
        : content.replace(searchPattern, () => replaceStr);
      if (newContent === content) continue;

      if (dryRun) {
        modifiedFiles.push({ path: filePath, originalSize: content.length, newSize: newContent.length });
        continue;
      }

      backupSnapshot[filePath] = content;

      try {
        fs.writeFileSync(filePath, newContent, 'utf8');
      } catch (writeErr) {
        rolledBack.push({ path: filePath, reason: `Write failure: ${writeErr.message}` });
        continue;
      }

      const ext = path.extname(filePath).toLowerCase();
      if (['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json'].includes(ext)) {
        const verdict = verifyContentSyntax(newContent, filePath);
        if (!verdict.valid) {
          delete backupSnapshot[filePath];
          try {
            fs.writeFileSync(filePath, content, 'utf8');
          } catch {
            // Best effort
          }
          rolledBack.push({ path: filePath, reason: (verdict.error || 'Syntax check failed').trim() });
          continue;
        }
        if (verdict.checked) syntaxVerified++;
      }

      modifiedFiles.push({ path: filePath, originalSize: content.length, newSize: newContent.length });
    }

    // Persist backup for rollback safety
    if (!dryRun && Object.keys(backupSnapshot).length > 0) {
      try {
        const cacheDir = path.join(targetDir, '.cache');
        fs.mkdirSync(cacheDir, { recursive: true });
        atomicWriteJsonSync(path.join(cacheDir, 'codemod-backup.json'), backupSnapshot);
      } catch {
        // Non-fatal backup persistence
      }
    }

    return {
      ok: true,
      scannedFiles: allFiles.length,
      modifiedFiles,
      syntaxVerified,
      rolledBack
    };
  } catch (err) {
    return {
      ok: false,
      error: err.message,
      scannedFiles: 0,
      modifiedFiles: [],
      syntaxVerified: 0,
      rolledBack: []
    };
  }
}

// CLI runner
const isMain = (() => {
  if (!process.argv[1]) return false;
  const self = path.resolve(fileURLToPath(import.meta.url));
  const arg = path.resolve(process.argv[1]);
  return process.platform === 'win32' ? self.toLowerCase() === arg.toLowerCase() : self === arg;
})();
if (isMain) {
  const args = process.argv.slice(2);
  let rootDir = process.cwd();
  let find = '';
  let replace = '';
  let isRegex = false;
  let wordBoundary = false;
  let dryRun = false;
  let extensions = DEFAULT_EXTS;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: node run-codemod.mjs [rootDir] --find <pattern> --replace <replacement> [--regex] [--word] [--ext <.js,.mjs,...>] [--dry-run]'
      );
      process.exit(0);
    } else if (arg === '--find' && i + 1 < args.length) {
      find = args[++i];
    } else if (arg === '--replace' && i + 1 < args.length) {
      replace = args[++i];
    } else if (arg === '--regex') {
      isRegex = true;
    } else if (arg === '--word') {
      wordBoundary = true;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--ext' && i + 1 < args.length) {
      extensions = args[++i].split(',').map((s) => s.trim());
    } else if (!arg.startsWith('-')) {
      rootDir = arg;
    }
  }

  const result = runCodemod({ rootDir, find, replace, isRegex, extensions, dryRun, wordBoundary });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

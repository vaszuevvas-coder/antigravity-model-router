/**
 * @file stack-detector.mjs
 * @description Zero-config polyglot workspace walker & stack detector (JS/TS/Node/Browser, Python, Go, Rust, C/C++/C#/Java, Web, Config, SQL, Shell, CI).
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join, relative, resolve } from 'node:path';

export const UNIVERSAL_IGNORED_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  'vendor',
  '.venv',
  'venv',
  'env',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  '.parcel-cache',
  'coverage',
  'checkpoints',
  'backups',
  '.shadow',
  'releases',
  'scratch',
  'tmp',
  'temp',
  '--ws',
]);

export const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.ico', '.avif', '.tiff',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.node', '.wasm', '.pyc', '.pyo', '.class', '.o', '.a', '.lib',
  '.zip', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar', '.asar',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp3', '.wav', '.ogg', '.flac', '.mp4', '.webm', '.avi', '.mov', '.mkv',
  '.sqlite', '.sqlite3', '.db', '.mdb', '.parquet',
  '.lockb',
]);

const CODE_AND_TEXT_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.jsx',
  '.ts', '.mts', '.cts', '.tsx',
  '.py', '.pyw',
  '.go',
  '.rs',
  '.c', '.h', '.cpp', '.hpp', '.cc', '.cxx',
  '.cs',
  '.java',
  '.html', '.htm', '.css', '.scss', '.sass', '.less', '.vue', '.svelte',
  '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.sql',
  '.sh', '.bash', '.zsh', '.bat', '.cmd', '.ps1',
  '.md', '.txt',
]);

const LANGUAGE_BY_EXT = {
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascript',
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'typescript',
  '.py': 'python',
  '.pyw': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.c': 'c_cpp',
  '.h': 'c_cpp',
  '.cpp': 'c_cpp',
  '.hpp': 'c_cpp',
  '.cc': 'c_cpp',
  '.cxx': 'c_cpp',
  '.cs': 'csharp',
  '.java': 'java',
  '.html': 'web',
  '.htm': 'web',
  '.css': 'web',
  '.scss': 'web',
  '.sass': 'web',
  '.less': 'web',
  '.vue': 'web',
  '.svelte': 'web',
  '.json': 'config',
  '.jsonc': 'config',
  '.yaml': 'config',
  '.yml': 'config',
  '.toml': 'config',
  '.ini': 'config',
  '.cfg': 'config',
  '.conf': 'config',
  '.sql': 'sql',
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  '.bat': 'shell',
  '.cmd': 'shell',
  '.ps1': 'shell',
};

const JS_FRAMEWORK_DEPS = [
  ['express', 'express'],
  ['fastify', 'fastify'],
  ['hono', 'hono'],
  ['koa', 'koa'],
  ['next', 'next'],
  ['react', 'react'],
  ['vue', 'vue'],
  ['svelte', 'svelte'],
  ['electron', 'electron'],
  ['@nestjs/core', 'nestjs'],
  ['vite', 'vite'],
];
const PY_FRAMEWORK_DEPS = [
  [/^\s*["']?fastapi\b|(?:^|[\s"',=\[<])fastapi(?:[\s"',=\]>~^!]|$)/m, 'fastapi'],
  [/^\s*["']?flask\b|(?:^|[\s"',=\[<])flask(?:[\s"',=\]>~^!]|$)/m, 'flask'],
  [/^\s*["']?django\b|(?:^|[\s"',=\[<])django(?:[\s"',=\]>~^!]|$)/m, 'django'],
];
const GO_FRAMEWORK_DEPS = [
  ['github.com/gin-gonic/gin', 'gin'],
  ['github.com/go-chi/chi', 'chi'],
  ['github.com/gofiber/fiber', 'fiber'],
];
const RUST_FRAMEWORK_DEPS = [
  [/\bactix-web\b/, 'actix'],
  [/\baxum\b/, 'axum'],
];

function parseSimpleGitignore(rootDir) {
  const giPath = join(rootDir, '.gitignore');
  if (!existsSync(giPath)) return [];
  const rules = [];
  try {
    const raw = readFileSync(giPath, 'utf8');
    for (const rawLine of raw.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#') || line.startsWith('!')) continue;
      const clean = line.replace(/^\.\//, '').replace(/\/+$/, '');
      if (!clean) continue;
      rules.push({
        raw: clean,
        anchored: line.startsWith('/'),
        dirOnly: line.endsWith('/'),
      });
    }
  } catch {}
  return rules;
}

function matchesGitignore(relPosix, baseName, isDir, rules) {
  if (!rules || rules.length === 0) return false;
  for (const r of rules) {
    if (r.dirOnly && !isDir) continue;
    const pat = r.anchored ? r.raw.slice(1) : r.raw;
    if (!pat) continue;
    if (!pat.includes('/') && !pat.includes('*')) {
      if (baseName === pat) return true;
    } else if (pat.startsWith('*.')) {
      const suffix = pat.slice(1);
      if (baseName.endsWith(suffix)) return true;
    } else if (!pat.includes('*')) {
      if (relPosix === pat || relPosix.startsWith(`${pat}/`)) return true;
    }
  }
  return false;
}

export function isTestFilePath(relPosix = '') {
  if (typeof relPosix !== 'string' || !relPosix) return false;
  const norm = relPosix.replace(/\\/g, '/').toLowerCase();
  if (/(?:^|\/)(?:tests?|__tests__|specs?|fixtures?|testdata)\//.test(norm)) return true;
  if (/\.(?:test|spec)\.[^./]+$/.test(norm)) return true;
  if (/(?:^|\/)test_[^/]+\.py$/.test(norm)) return true;
  if (/_test\.(?:go|py|rs)$/.test(norm)) return true;
  return false;
}

export function inspectBufferEncoding(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) {
    return { encoding: 'utf8', hasUtf8Bom: false, hasUtf16Bom: false, hasNullBytes: false, text: '' };
  }
  const hasUtf8Bom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  const hasUtf16LeBom = buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe;
  const hasUtf16BeBom = buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff;
  const hasUtf16Bom = hasUtf16LeBom || hasUtf16BeBom;

  let hasNullBytes = false;
  if (!hasUtf16Bom) {
    const checkLen = Math.min(buf.length, 65536);
    for (let i = 0; i < checkLen; i++) {
      if (buf[i] === 0x00) {
        hasNullBytes = true;
        break;
      }
    }
  }

  let text = '';
  if (hasUtf16LeBom) {
    text = buf.subarray(2).toString('utf16le');
  } else if (hasUtf16BeBom) {
    const evenLen = buf.length - ((buf.length - 2) % 2);
    const body = Buffer.from(buf.subarray(2, evenLen));
    body.swap16();
    text = body.toString('utf16le');
  } else if (hasUtf8Bom) {
    text = buf.subarray(3).toString('utf8');
  } else {
    text = buf.toString('utf8');
  }
  return { encoding: hasUtf16Bom ? 'utf16' : 'utf8', hasUtf8Bom, hasUtf16Bom, hasNullBytes, text };
}

function classifyFileKind(relPosix, baseName, ext) {
  const lowerBase = baseName.toLowerCase();
  if (lowerBase.startsWith('dockerfile')) return { language: 'ci_container', kind: 'dockerfile' };
  if (/^docker-compose.*\.ya?ml$/.test(lowerBase)) return { language: 'ci_container', kind: 'compose' };
  if (/^\.github\/workflows\/.*\.ya?ml$/.test(relPosix.toLowerCase())) return { language: 'ci_container', kind: 'github_workflow' };
  if (lowerBase === '.env' || lowerBase.startsWith('.env.')) return { language: 'config', kind: 'env' };
  if (ext === '.json' || ext === '.jsonc') return { language: 'config', kind: 'json' };
  const lang = LANGUAGE_BY_EXT[ext] || null;
  if (!lang) return null;
  return { language: lang, kind: ext.slice(1) };
}

/**
 * Walks targetDir, inspects encoding/BOM, classifies files and detects full polyglot stack.
 * @param {string} targetDir
 * @param {{ maxDepth?: number, maxFiles?: number, maxBytesPerFile?: number }} [options={}]
 */
export function collectAndDetectStack(targetDir, options = {}) {
  const absRoot = resolve(targetDir || process.cwd());
  const maxDepth = Number.isFinite(options.maxDepth) ? options.maxDepth : 10;
  const maxFiles = Number.isFinite(options.maxFiles) ? options.maxFiles : 5000;
  const maxBytesPerFile = Number.isFinite(options.maxBytesPerFile) ? options.maxBytesPerFile : 1500000;
  const skipFileText = Boolean(options.skipFileText);

  const gitignoreRules = parseSimpleGitignore(absRoot);
  const files = [];
  const dirEntriesCache = new Map();
  const manifests = {
    packageJsonPaths: [],
    tsconfigPaths: [],
    pyprojectPaths: [],
    requirementsPaths: [],
    goModPaths: [],
    cargoTomlPaths: [],
    envExamplePaths: [],
    biomeJsonPaths: [],
  };
  const languageCounts = {};
  const traits = new Set();
  const frameworks = new Set();
  const skippedFiles = [];
  let truncatedByCap = false;

  const LOW_PRIORITY_DIRS = new Set([
    'docs',
    'docs_src',
    'doc',
    'site',
    'translations',
    'i18n',
    'l10n',
    'examples',
    'example',
    'tutorials',
    'playground',
    'benchmarks',
    'samples',
    'demos',
  ]);
  const primaryQueue = [{ dir: absRoot, depth: 0 }];
  const lowPriQueue = [];
  let pHead = 0;
  let lHead = 0;

  while ((pHead < primaryQueue.length || lHead < lowPriQueue.length) && files.length < maxFiles) {
    const item = pHead < primaryQueue.length ? primaryQueue[pHead++] : lowPriQueue[lHead++];
    const { dir, depth } = item;
    if (depth > maxDepth) continue;

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    const nameSet = new Set();
    for (const e of entries) nameSet.add(e.name);
    dirEntriesCache.set(dir, nameSet);

    entries.sort((a, b) => a.name.localeCompare(b.name));

    const childDirs = [];
    // Process all files in current directory BEFORE descending into subdirectories
    for (const entry of entries) {
      if (files.length >= maxFiles) {
        truncatedByCap = true;
        break;
      }
      const name = entry.name;
      const fullPath = join(dir, name);
      const relPosix = relative(absRoot, fullPath).replace(/\\/g, '/');

      if (entry.isDirectory()) {
        if (UNIVERSAL_IGNORED_DIRS.has(name)) continue;
        if (name.startsWith('.') && name !== '.github' && name !== '.vscode') continue;
        if (matchesGitignore(relPosix, name, true, gitignoreRules)) continue;
        childDirs.push({ dir: fullPath, depth: depth + 1, name: name.toLowerCase() });
        continue;
      }

      if (!entry.isFile()) continue;
      if (matchesGitignore(relPosix, name, false, gitignoreRules)) continue;

      const ext = extname(name).toLowerCase();
      const lowerName = name.toLowerCase();
      if (BINARY_EXTENSIONS.has(ext)) continue;

      const isKnownSpecial =
        lowerName === 'dockerfile' ||
        lowerName.startsWith('dockerfile.') ||
        lowerName === '.env' ||
        lowerName.startsWith('.env.') ||
        lowerName === 'go.mod' ||
        lowerName === 'cargo.toml' ||
        lowerName === 'pyproject.toml' ||
        lowerName === 'requirements.txt';

      if (!isKnownSpecial && !CODE_AND_TEXT_EXTENSIONS.has(ext)) continue;

      let st;
      try {
        st = statSync(fullPath);
      } catch {
        continue;
      }
      if (st.size > maxBytesPerFile) {
        skippedFiles.push({ relPath: relPosix, reason: `size>${maxBytesPerFile}` });
        continue;
      }

      let enc = { encoding: 'utf8', hasUtf8Bom: false, hasUtf16Bom: false, hasNullBytes: false, text: '' };
      if (!skipFileText) {
        let rawBuf;
        try {
          rawBuf = readFileSync(fullPath);
        } catch (err) {
          files.push({
            file: fullPath,
            relPath: relPosix,
            ext,
            baseName: name,
            size: st.size,
            readError: String(err?.message || err),
          });
          continue;
        }
        enc = inspectBufferEncoding(rawBuf);
      }
      const cls = classifyFileKind(relPosix, name, ext);
      if (cls) {
        languageCounts[cls.language] = (languageCounts[cls.language] || 0) + 1;
      }

      if (lowerName === 'package.json') manifests.packageJsonPaths.push(fullPath);
      else if (/^[tj]sconfig.*\.json$/i.test(lowerName)) manifests.tsconfigPaths.push(fullPath);
      else if (lowerName === 'pyproject.toml') manifests.pyprojectPaths.push(fullPath);
      else if (lowerName === 'requirements.txt') manifests.requirementsPaths.push(fullPath);
      else if (lowerName === 'go.mod') manifests.goModPaths.push(fullPath);
      else if (lowerName === 'cargo.toml') manifests.cargoTomlPaths.push(fullPath);
      else if (/^\.env\.(?:example|sample|template)$/i.test(lowerName)) manifests.envExamplePaths.push(fullPath);
      else if (lowerName === 'biome.json' || lowerName === 'biome.jsonc') manifests.biomeJsonPaths.push(fullPath);

      if (ext === '.mjs') traits.add('esm');
      if (ext === '.cjs') traits.add('cjs');
      if (ext === '.jsx') traits.add('jsx');
      if (ext === '.tsx') traits.add('tsx');
      if (ext === '.html' || ext === '.htm' || ext === '.css' || ext === '.vue' || ext === '.svelte') {
        traits.add('browser');
      }

      const isFixtureOrPlayground = /(?:^|\/)(?:playground|__fixtures__|test-fixtures)\//i.test(relPosix);
      files.push({
        file: fullPath,
        relPath: relPosix,
        ext,
        baseName: name,
        size: st.size,
        language: cls?.language || 'text',
        kind: cls?.kind || 'text',
        isTestFile: isTestFilePath(relPosix) || isFixtureOrPlayground,
        encoding: enc.encoding,
        hasUtf8Bom: enc.hasUtf8Bom,
        hasUtf16Bom: enc.hasUtf16Bom,
        hasNullBytes: enc.hasNullBytes,
        text: enc.text,
      });
    }

    for (const sub of childDirs) {
      if (sub.depth <= maxDepth) {
        if (LOW_PRIORITY_DIRS.has(sub.name)) {
          lowPriQueue.push({ dir: sub.dir, depth: sub.depth });
        } else {
          primaryQueue.push({ dir: sub.dir, depth: sub.depth });
        }
      }
    }
  }

  const rootPkgJson = join(absRoot, 'package.json');
  let rootPkg = null;
  const collectPkgFrameworks = (pkg) => {
    if (!pkg || typeof pkg !== 'object') return;
    const depSet = new Set();
    for (const grp of [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies]) {
      if (grp && typeof grp === 'object') {
        for (const k of Object.keys(grp)) depSet.add(k.toLowerCase());
      }
    }
    for (const [needle, fw] of JS_FRAMEWORK_DEPS) {
      if (depSet.has(needle)) frameworks.add(fw);
    }
  };
  if (existsSync(rootPkgJson)) {
    try {
      rootPkg = JSON.parse(readFileSync(rootPkgJson, 'utf8'));
      traits.add('nodejs');
      if (rootPkg?.type === 'module') traits.add('esm');
      else if (rootPkg?.type === 'commonjs') traits.add('cjs');
      collectPkgFrameworks(rootPkg);
    } catch {}
  }

  let subPkgChecked = 0;
  for (const pkgPath of manifests.packageJsonPaths) {
    if (subPkgChecked >= 25) break;
    if (pkgPath === rootPkgJson) continue;
    const relPkg = relative(absRoot, pkgPath).replace(/\\/g, '/').toLowerCase();
    if (/^(?:docs?|docs_src|examples?|playground|__fixtures__|test-fixtures)\//.test(relPkg)) continue;
    subPkgChecked++;
    try {
      traits.add('nodejs');
      collectPkgFrameworks(JSON.parse(readFileSync(pkgPath, 'utf8')));
    } catch {}
  }

  for (const pyPath of [...manifests.pyprojectPaths, ...manifests.requirementsPaths]) {
    try {
      const txt = readFileSync(pyPath, 'utf8').toLowerCase();
      for (const [rx, fw] of PY_FRAMEWORK_DEPS) {
        if (rx.test(txt)) frameworks.add(fw);
      }
    } catch {}
  }
  for (const gmPath of manifests.goModPaths) {
    traits.add('go-mod');
    try {
      const txt = readFileSync(gmPath, 'utf8').toLowerCase();
      for (const [needle, fw] of GO_FRAMEWORK_DEPS) {
        if (txt.includes(needle)) frameworks.add(fw);
      }
    } catch {}
  }
  if (manifests.cargoTomlPaths.length > 0) {
    traits.add('cargo');
    for (const cPath of manifests.cargoTomlPaths.slice(0, 12)) {
      try {
        const txt = readFileSync(cPath, 'utf8').toLowerCase();
        for (const [rx, fw] of RUST_FRAMEWORK_DEPS) {
          if (rx.test(txt)) frameworks.add(fw);
        }
      } catch {}
    }
  }

  const languages = Object.entries(languageCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([lang]) => lang);

  return {
    rootDir: absRoot,
    files,
    skippedFiles,
    dirEntriesCache,
    manifests,
    rootPkg,
    truncated: truncatedByCap,
    maxFiles,
    stack: {
      languages,
      languageCounts,
      traits: Array.from(traits).sort(),
      frameworks: Array.from(frameworks).sort(),
      totalFiles: files.length,
      truncated: truncatedByCap,
      maxFiles,
    },
  };
}

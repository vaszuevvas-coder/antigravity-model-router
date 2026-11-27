#!/usr/bin/env node
/**
 * @file scaffold-cli-harness.mjs
 * @description Zero-dependency prober and contract validator for agent-native CLI harnesses (CLI-Anything protocol).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.venv', 'venv', '__pycache__', 'target', '.cache']);

const BACKEND_SIGNALS = [
  { id: 'python_cli', file: 'pyproject.toml', kind: 'Python package/CLI backend' },
  { id: 'node_cli', file: 'package.json', kind: 'Node.js / TypeScript backend' },
  { id: 'rust_cli', file: 'Cargo.toml', kind: 'Rust binary backend' },
  { id: 'go_cli', file: 'go.mod', kind: 'Go binary backend' },
  { id: 'cmake_cpp', file: 'CMakeLists.txt', kind: 'C/C++ native engine' },
];

const DATA_FORMAT_EXTS = new Set(['.json', '.xml', '.svg', '.yaml', '.yml', '.toml', '.sql', '.sqlite', '.blend', '.kra', '.xcf', '.mlt', '.tscn']);

/**
 * Probes a repository or app directory to map backend stack, existing CLI entrypoints, and project data formats.
 * @param {string} targetDir
 */
export function probeAppForCliHarness(targetDir = process.cwd()) {
  const absRoot = path.resolve(targetDir || process.cwd());
  if (!fs.existsSync(absRoot) || !fs.statSync(absRoot).isDirectory()) {
    return { ok: false, exitCode: 2, error: `Directory not found: ${absRoot}` };
  }

  const backends = [];
  const existingCliBins = [];
  for (const sig of BACKEND_SIGNALS) {
    const p = path.join(absRoot, sig.file);
    if (!fs.existsSync(p)) continue;
    backends.push({ id: sig.id, manifest: sig.file, kind: sig.kind });
    if (sig.file === 'package.json') {
      try {
        const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (typeof pkg.bin === 'string') existingCliBins.push(pkg.bin);
        else if (pkg.bin && typeof pkg.bin === 'object') existingCliBins.push(...Object.keys(pkg.bin));
      } catch {}
    }
  }

  const dataFormats = new Set();
  const commandCandidates = [];
  const walk = (dir, depth = 0) => {
    if (depth > 3 || commandCandidates.length >= 25) return;
    let ents = [];
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of ents) {
      if (SKIP_DIRS.has(ent.name)) continue;
      const full = path.join(dir, ent.name);
      const rel = path.relative(absRoot, full).replace(/\\/g, '/');
      if (ent.isDirectory()) {
        if (/(?:^|\/)(?:cli|commands?|bin|scripts|actions?)$/i.test(rel)) {
          commandCandidates.push(rel);
        }
        walk(full, depth + 1);
      } else {
        const ext = path.extname(ent.name).toLowerCase();
        if (DATA_FORMAT_EXTS.has(ext)) dataFormats.add(ext);
        if (/(?:cli|cmd|main|harness|repl)\.(?:py|mjs|js|ts|go|rs)$/i.test(ent.name)) {
          commandCandidates.push(rel);
        }
      }
    }
  };
  walk(absRoot, 0);

  return {
    ok: true,
    exitCode: 0,
    root: absRoot,
    backends,
    existingCliBins,
    dataFormats: Array.from(dataFormats).sort(),
    commandCandidates: commandCandidates.slice(0, 20),
    recommendedStrategy: existingCliBins.length > 0
      ? 'wrap_existing_cli_with_json_contract'
      : backends.length > 0
        ? 'build_7phase_backend_harness'
        : 'inspect_binary_or_file_format_first',
  };
}

/**
 * Validates a generated CLI harness directory against the agent-native CLI-Anything contract.
 * Checks: entry script with --json & --help support, test presence, and consumer SKILL.md.
 * @param {string} harnessDir
 */
export function validateCliHarness(harnessDir = process.cwd()) {
  const absDir = path.resolve(harnessDir || process.cwd());
  if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) {
    return { ok: false, exitCode: 2, error: `Harness directory not found: ${absDir}`, checks: [], gaps: ['directory_missing'] };
  }

  let hasJsonFlag = false;
  let hasHelpFlag = false;
  let hasTests = false;
  let hasSkillMd = false;
  const scannedCode = [];

  const walk = (dir, depth = 0) => {
    if (depth > 4) return;
    let ents = [];
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of ents) {
      if (SKIP_DIRS.has(ent.name)) continue;
      const full = path.join(dir, ent.name);
      const rel = path.relative(absDir, full).replace(/\\/g, '/');
      if (ent.isDirectory()) {
        if (/^(?:tests?|__tests__)$/i.test(ent.name)) hasTests = true;
        walk(full, depth + 1);
      } else {
        if (/^SKILL\.md$/i.test(ent.name)) hasSkillMd = true;
        const isTestFile = /(?:\.test\.|\.spec\.|_test\.|^test_)/i.test(ent.name)
          || /(?:^|\/)(?:tests?|__tests__)\//i.test(rel);
        if (isTestFile) hasTests = true;
        if (!isTestFile && /\.(?:py|mjs|cjs|mts|cts|js|ts|go|rs)$/i.test(ent.name) && scannedCode.length < 40) {
          scannedCode.push(rel);
          try {
            const st = fs.statSync(full);
            if (!st.isFile() || st.size > 2 * 1024 * 1024) continue;
            const raw = fs.readFileSync(full, 'utf8').slice(0, 64 * 1024);
            if (/--json|['"]json['"]|json_output/i.test(raw)) hasJsonFlag = true;
            if (/--help|\busage:|\bargparse\b|\bclick\b|\bcommander\b|\byargs\b/i.test(raw)) hasHelpFlag = true;
          } catch {}
        }
      }
    }
  };
  walk(absDir, 0);

  const checks = [
    { id: 'json_contract', passed: hasJsonFlag, detail: '--json machine-readable output support' },
    { id: 'self_describing_help', passed: hasHelpFlag, detail: '--help / usage documentation' },
    { id: 'automated_tests', passed: hasTests, detail: 'Automated unit/E2E tests' },
    { id: 'consumer_skill_md', passed: hasSkillMd, detail: 'Consumer SKILL.md guide' },
  ];
  const gaps = checks.filter((c) => !c.passed).map((c) => c.id);
  const ok = gaps.length === 0;

  return {
    ok,
    exitCode: ok ? 0 : 3,
    root: absDir,
    scannedCodeFiles: scannedCode.length,
    checks,
    gaps,
  };
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  const self = path.resolve(fileURLToPath(import.meta.url));
  const arg = path.resolve(process.argv[1]);
  return process.platform === 'win32' ? self.toLowerCase() === arg.toLowerCase() : self === arg;
})();

if (isMain) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    console.log('Usage: node scaffold-cli-harness.mjs (--probe <dir> | --validate <harnessDir>) [--json]');
    process.exit(0);
  }
  const asJson = args.includes('--json');
  const getValArg = (flag) => {
    const eq = args.find((a) => a.startsWith(`${flag}=`));
    if (eq) return eq.slice(flag.length + 1);
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] && !args[idx + 1].startsWith('-') ? args[idx + 1] : '';
  };
  const probeTarget = getValArg('--probe');
  const valTarget = getValArg('--validate');
  let res;
  if (probeTarget) {
    res = probeAppForCliHarness(probeTarget);
  } else if (valTarget) {
    res = validateCliHarness(valTarget);
  } else {
    res = { ok: false, exitCode: 2, error: 'Specify --probe <dir> or --validate <harnessDir>' };
  }
  if (asJson) {
    console.log(JSON.stringify(res, null, 2));
  } else {
    console.log(res.ok ? `OK: ${res.root}` : `GAPS/ERROR (${res.exitCode}): ${res.error || (res.gaps || []).join(', ')}`);
  }
  process.exit(res.exitCode ?? (res.ok ? 0 : 1));
}

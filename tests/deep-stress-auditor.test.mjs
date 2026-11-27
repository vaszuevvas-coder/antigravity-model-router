import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStressAudit } from '../skills/deep-stress-auditor/scripts/run-stress-audit.mjs';
import { inspectBufferEncoding } from '../skills/deep-stress-auditor/scripts/lib/stack-detector.mjs';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function walkFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function snapshotTree(dir) {
  return walkFiles(dir)
    .map((f) => `${path.relative(dir, f).replace(/\\/g, '/')}:${fs.statSync(f).size}`)
    .sort();
}

test('1. Repo-agnostic purity: zero hardcoded router-internal symbols or filenames inside skills/deep-stress-auditor/', () => {
  const skillRoot = path.join(ROOT_DIR, 'skills', 'deep-stress-auditor');
  const forbidden = [
    'security-guard.mjs',
    'diff-patcher.mjs',
    'local-gpu-engine.mjs',
    'ui.html',
    'panelFetch',
    'server.mjs',
    'ag-cli.mjs',
    'pack-release.mjs',
    'ram-memory-engine.mjs',
    'cpu-reranker.mjs',
    'v3.7-p0-p1-contracts',
    'v3.8-cpu-coprocessor-contracts',
  ];
  for (const fp of walkFiles(skillRoot)) {
    const content = fs.readFileSync(fp, 'utf8');
    for (const needle of forbidden) {
      assert.equal(
        content.includes(needle),
        false,
        `Forbidden plugin-specific token '${needle}' found in ${path.relative(ROOT_DIR, fp)}`
      );
    }
  }
});

test('2. Universal polyglot matrix [T1-T6]: detects all planted bugs across JS/Python/Go/HTML/Config + ddmin with 0 disk mutations', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-polyglot-'));
  try {
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'public'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'py'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'go'), { recursive: true });

    // [T1] package.json with broken exports target + missing dependency ('zod' not declared)
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({
        name: 'synthetic-polyglot',
        version: '1.0.0',
        type: 'module',
        main: './src/app.mjs',
        exports: { '.': './src/missing-entry.mjs' },
        dependencies: { express: '^4.19.0', 'unused-ghost-pkg': '^1.0.0' },
      }, null, 2),
      'utf8'
    );

    // [T1] UTF-8 BOM + shebang script + invalid JSON
    const bomBuf = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('#!/usr/bin/env bash\necho ok\n', 'utf8'),
    ]);
    fs.writeFileSync(path.join(tmpDir, 'deploy.sh'), bomBuf);
    fs.writeFileSync(path.join(tmpDir, 'broken.json'), '{ "bad": }', 'utf8');

    // [T3] .env.example missing STRIPE_LIVE_WEBHOOK_KEY
    fs.writeFileSync(path.join(tmpDir, '.env.example'), 'PORT=3000\nDB_URL=postgres://localhost/app\n', 'utf8');

    // [T2] 3-node circular dependencies + broken named export + Blast Radius hub
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'hub.mjs'),
      [
        "import { stepB } from './cycleB.mjs';",
        'export function coreHelper(x) {',
        '  if (x > 1) return x + 1;',
        '  if (x < 0) return stepB(x);',
        '  return 0;',
        '}',
        'export async function asyncSaveItem(item) { return item; }',
      ].join('\n'),
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'cycleB.mjs'),
      "import { stepC } from './cycleC.mjs';\nexport function stepB(v) { return stepC(v); }\n",
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'cycleC.mjs'),
      "import { coreHelper } from './hub.mjs';\nexport function stepC(v) { return coreHelper(v); }\n",
      'utf8'
    );

    // [T1][T2][T3][T4][T5] Main JS backend + tainted sinks + ReDoS + secret + floating promise + TOCTOU
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'app.mjs'),
      [
        "import express from 'express';",
        "import { z } from 'zod';",
        "import { existsSync, writeFileSync } from 'node:fs';",
        "import { nonExistentSymbol, asyncSaveItem } from './hub.mjs';",
        "import { winHelper } from '.\\\\winSub.mjs';",
        '',
        `const GH_TOKEN = "${['ghp', 'Q9xLmNpRsTuVwXyZaBcDeFgHiJkLmN847291'].join('_')}";`,
        'const webhookSecret = process.env.STRIPE_LIVE_WEBHOOK_KEY;',
        'const emailBacktrackRe = /^([a-zA-Z]+)+$/;',
        '',
        'const app = express();',
        "app.get('/api/v1/users', (req, res) => {",
        '  const uid = req.query.id;',
        '  db.query(`SELECT * FROM users WHERE id = ${uid}`);',
        '  asyncSaveItem(uid);',
        "  if (!existsSync('/tmp/flag')) {",
        "    writeFileSync('/tmp/flag', '1');",
        '  }',
        '  res.json({ ok: true, uid, webhookSecret, winHelper, nonExistentSymbol, z, GH_TOKEN, emailBacktrackRe });',
        '});',
        '[1, 2].forEach(async (n) => { await asyncSaveItem(n); });',
      ].join('\n'),
      'utf8'
    );
    fs.writeFileSync(path.join(tmpDir, 'src', 'winSub.mjs'), 'export const winHelper = 1;\n', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'src', 'orphan.mjs'), 'export function neverImported() { return 42; }\n', 'utf8');

    // [T5] Frontend HTML & JS with broken API route + missing DOM ID
    fs.writeFileSync(
      path.join(tmpDir, 'public', 'index.html'),
      '<!doctype html><html><body><div id="root"></div><div id="status-bar"></div></body></html>\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'public', 'client.mjs'),
      [
        "const btn = document.getElementById('missing-save-btn');",
        "export async function loadGhost() { return fetch('/api/v1/ghost-route'); }",
        'export { btn };',
      ].join('\n'),
      'utf8'
    );

    // [T3][T4] Python file with command injection + unclosed open()
    fs.writeFileSync(
      path.join(tmpDir, 'py', 'worker.py'),
      [
        'import subprocess',
        'def run_task(request):',
        "    cmd = request.args.get('cmd')",
        '    subprocess.run(f"echo {cmd}", shell=True)',
        "    fh = open('data.txt', 'r')",
        '    return fh.read()',
      ].join('\n'),
      'utf8'
    );

    // [T1][T4] Go file with missing defer Close
    fs.writeFileSync(
      path.join(tmpDir, 'go', 'main.go'),
      [
        'package main',
        'import "os"',
        'func readCfg() {',
        '  f, _ := os.Open("cfg.json")',
        '  _ = f',
        '}',
      ].join('\n'),
      'utf8'
    );

    // [T6] Pure parser modules for sandboxed fuzzing + ddmin + attempted disk write block
    const sideEffectTarget = path.join(tmpDir, 'pwned.txt').replace(/\\/g, '/');
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'fuzzTargets.mjs'),
      [
        "import fs from 'node:fs';",
        'export function parsePacket(raw) {',
        "  if (typeof raw !== 'string') return [];",
        "  if (raw.includes('aline_safe')) {",
        "    throw new RangeError('Simulated deep parser crash on aline_safe');",
        '  }',
        "  return raw.split('\\n');",
        '}',
        'export function unsafeMerge(obj) {',
        "  if (obj && typeof obj === 'object' && '__proto__' in obj) {",
        '    Object.assign(Object.prototype, obj.__proto__);',
        '  }',
        '  return true;',
        '}',
        'export function evilSideEffect(val) {',
        `  fs.writeFileSync('${sideEffectTarget}', String(val));`,
        '  return true;',
        '}',
      ].join('\n'),
      'utf8'
    );

    const beforeTree = snapshotTree(tmpDir);
    const report = await runStressAudit(tmpDir, { fuzz: true, shutdownPool: false });
    const afterTree = snapshotTree(tmpDir);

    // Zero disk mutations check
    assert.equal(fs.existsSync(path.join(tmpDir, 'pwned.txt')), false, 'Sandbox must block fs writes');
    assert.deepEqual(afterTree, beforeTree, 'Target repository files must be untouched by audit & fuzzing');
    assert.equal(report.status, 'FAILED');
    assert.ok(report.blastRadiusHubs.length >= 1, 'Expected Blast Radius hub metrics');

    const rules = new Set(report.findings.map((f) => f.ruleId));
    assert.ok(rules.has('BROKEN_MANIFEST_TARGET'), 'Missing BROKEN_MANIFEST_TARGET');
    assert.ok(rules.has('BOM_SHEBANG_CONFLICT'), 'Missing BOM_SHEBANG_CONFLICT');
    assert.ok(rules.has('INVALID_JSON'), 'Missing INVALID_JSON');
    assert.ok(rules.has('NON_PORTABLE_BACKSLASH_IMPORT'), 'Missing NON_PORTABLE_BACKSLASH_IMPORT');
    assert.ok(rules.has('MISSING_DEPENDENCY'), 'Missing MISSING_DEPENDENCY');
    assert.ok(rules.has('BROKEN_NAMED_EXPORT'), 'Missing BROKEN_NAMED_EXPORT');
    assert.ok(rules.has('CIRCULAR_DEPENDENCY'), 'Missing CIRCULAR_DEPENDENCY');
    assert.ok(rules.has('ORPHAN_MODULE'), 'Missing ORPHAN_MODULE');
    assert.ok(rules.has('UNUSED_DEPENDENCY'), 'Missing UNUSED_DEPENDENCY');
    assert.ok(rules.has('HARDCODED_SECRET'), 'Missing HARDCODED_SECRET');
    assert.ok(rules.has('ENV_EXAMPLE_DRIFT'), 'Missing ENV_EXAMPLE_DRIFT');
    assert.ok(rules.has('SQL_INJECTION'), 'Missing SQL_INJECTION');
    assert.ok(rules.has('COMMAND_INJECTION'), 'Missing COMMAND_INJECTION');
    assert.ok(rules.has('REDOS_VULNERABILITY') || rules.has('REDOS_TIMEOUT') || rules.has('REDOS_PATTERN_RISK'), 'Missing ReDoS finding');
    assert.ok(rules.has('FLOATING_PROMISE'), 'Missing FLOATING_PROMISE');
    assert.ok(rules.has('ASYNC_FOREACH'), 'Missing ASYNC_FOREACH');
    assert.ok(rules.has('TOCTOU_FILE_RACE'), 'Missing TOCTOU_FILE_RACE');
    assert.ok(rules.has('UNCLOSED_FILE_HANDLE'), 'Missing Python UNCLOSED_FILE_HANDLE');
    assert.ok(rules.has('GO_MISSING_DEFER_CLOSE'), 'Missing Go GO_MISSING_DEFER_CLOSE');
    assert.ok(rules.has('BROKEN_API_CONTRACT'), 'Missing BROKEN_API_CONTRACT');
    assert.ok(rules.has('MISSING_DOM_ID'), 'Missing MISSING_DOM_ID');
    assert.ok(rules.has('FUZZ_RANGE_OR_STACK'), 'Missing T6 FUZZ_RANGE_OR_STACK');
    assert.ok(rules.has('FUZZ_PROTOTYPE_POLLUTION'), 'Missing T6 FUZZ_PROTOTYPE_POLLUTION');

    // Assert ddmin shrunk the multi-line 50KB crashing input down near 'aline_safe'
    const packetCrash = report.findings.find((f) => f.ruleId === 'FUZZ_RANGE_OR_STACK' && f.file === 'src/fuzzTargets.mjs');
    assert.ok(packetCrash?.evidence.includes('ddmin:') && packetCrash.evidence.includes('aline_safe'), `Expected ddmin minimalRepro, got: ${packetCrash?.evidence}`);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test('3. Self-audit fast latency budget (<= 3000ms) & --fuzz --json CLI on workspace root', async () => {
  const fastReport = await runStressAudit(ROOT_DIR, { fuzz: false, shutdownPool: true });
  assert.equal(fastReport.status, 'PASSED', `Fast self-audit failed: ${JSON.stringify(fastReport.findings.filter((f) => f.severity === 'CRITICAL' || f.severity === 'HIGH'))}`);
  assert.ok(fastReport.elapsedMs <= 3000, `Fast scan exceeded 3000ms budget: ${fastReport.elapsedMs}ms`);

  const cliStdout = execFileSync(
    process.execPath,
    [path.join(ROOT_DIR, 'skills', 'deep-stress-auditor', 'scripts', 'run-stress-audit.mjs'), ROOT_DIR, '--fuzz', '--json'],
    { encoding: 'utf8', timeout: 25000, windowsHide: true }
  );
  const parsed = JSON.parse(cliStdout);
  assert.equal(parsed.status, 'PASSED', `CLI --fuzz self-audit failed: ${JSON.stringify(parsed.findings.filter((f) => f.severity === 'CRITICAL' || f.severity === 'HIGH'))}`);
  assert.ok(parsed.scanned >= 20);
});

test('3b. Polyglot real-world edge cases: ambient .d.ts, Python triple-quoted docstrings & Go reassigned defer Close', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-poly-edge-'));
  try {
    fs.mkdirSync(path.join(tmpDir, 'types'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'pypkg'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'goapp'), { recursive: true });

    // Ambient .d.ts with uninitialized const declaration (valid TypeScript declaration file)
    fs.writeFileSync(path.join(tmpDir, 'types', 'ambient.d.ts'), 'const str: string\nexport default str\n', 'utf8');
    // Python module with relative import example inside triple-quoted docstring
    fs.writeFileSync(path.join(tmpDir, 'pypkg', '__init__.py'), '', 'utf8');
    fs.writeFileSync(
      path.join(tmpDir, 'pypkg', 'app.py'),
      'def docs_example():\n    """\n    Example:\n        from .nonexistent_doc import helper\n    """\n    return 1\n',
      'utf8'
    );
    // Go file with os.Open assigned to intermediate variable and closed via defer reader.Close() within 12 lines
    fs.writeFileSync(
      path.join(tmpDir, 'goapp', 'client.go'),
      [
        'package goapp',
        'import "os"',
        'func readCfg(p string) error {',
        '  var r *os.File',
        '  if r == nil {',
        '    f, err := os.Open(p)',
        '    if err != nil { return err }',
        '    r = f',
        '  }',
        '  _ = r',
        '  defer r.Close()',
        '  return nil',
        '}',
      ].join('\n'),
      'utf8'
    );

    const rep = await runStressAudit(tmpDir, { fuzz: false, shutdownPool: false });
    const ruleIds = rep.findings.map((f) => f.ruleId);
    assert.equal(ruleIds.includes('SYNTAX_ERROR'), false, `Unexpected SYNTAX_ERROR on .d.ts: ${JSON.stringify(rep.findings)}`);
    assert.equal(ruleIds.includes('BROKEN_RELATIVE_IMPORT'), false, `Unexpected BROKEN_RELATIVE_IMPORT in docstring: ${JSON.stringify(rep.findings)}`);
    assert.equal(ruleIds.includes('GO_MISSING_DEFER_CLOSE'), false, `Unexpected GO_MISSING_DEFER_CLOSE: ${JSON.stringify(rep.findings)}`);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test('4. JS/TS import lexer ignores string/template/regex fixtures and method calls while catching real broken imports', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-lexer-'));
  try {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'lexer-fixture', type: 'module' }, null, 2), 'utf8');
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'real-dep.mjs'), 'export const ok = 1;\n', 'utf8');
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'clean-fixtures.mjs'),
      [
        'import { ok } from "./real-dep.mjs";',
        'const s1 = \'obj.import("./fake-single.mjs");\';',
        'const s2 = "require(\\"./fake-double.mjs\\")";',
        'const tpl = `',
        'import { ghost } from "./fake-tpl-esm.mjs";',
        'export { ghost2 } from "./fake-tpl-reexport.mjs";',
        'const x = import("./fake-tpl-dyn.mjs");',
        '`;',
        'const re = /import\\s*\\(\\s*["\']\\.\\/fake-re\\.mjs["\']\\s*\\)/g;',
        'const obj = { import: () => 1, require: () => 2 };',
        'obj.import("./fake-method.mjs");',
        'obj?.require("./fake-opt-require.mjs");',
        'export const out = [ok, s1, s2, tpl, re, obj];',
      ].join('\n'),
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'real-broken.mjs'),
      [
        'export async function load() {',
        '  const v = `${await import("./actually-missing-tpl-expr.mjs")}`;',
        '  return v;',
        '}',
      ].join('\n'),
      'utf8'
    );

    const report = await runStressAudit(tmpDir, { fuzz: false, shutdownPool: true });
    const broken = report.findings.filter((f) => f.ruleId === 'BROKEN_RELATIVE_IMPORT');
    assert.deepEqual(
      broken.map((f) => ({ file: f.file, evidence: f.evidence })),
      [{ file: 'src/real-broken.mjs', evidence: './actually-missing-tpl-expr.mjs' }],
      `Unexpected BROKEN_RELATIVE_IMPORT findings: ${JSON.stringify(broken)}`
    );
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test('5. Batch 7A fixes: CRLF import line accuracy, inline type imports, $ taint IDs, UTF-16BE BOM, INFO severity parity & missing targetDir', async () => {
  const missingReport = await runStressAudit(path.join(os.tmpdir(), `nonexistent-dsa-${Date.now()}`), { fuzz: false, shutdownPool: true });
  assert.equal(missingReport.status, 'FAILED');
  assert.ok(missingReport.findings.some((f) => f.ruleId === 'TARGET_NOT_FOUND' && f.severity === 'CRITICAL'));

  // UTF-16BE BOM ('A' = 0x00 0x41, 'B' = 0x00 0x42) decodes cleanly without U+FFFD replacement chars
  const beBuf = Buffer.from([0xfe, 0xff, 0x00, 0x41, 0x00, 0x42]);
  const encRes = inspectBufferEncoding(beBuf);
  assert.equal(encRes.encoding, 'utf16');
  assert.equal(encRes.text, 'AB');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-b7a-'));
  try {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'dsa-b7a', type: 'module', dependencies: {} }, null, 2), 'utf8');
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'types-mod.mjs'), 'export const helper = 1;\nexport function pass(x) { return helper + x; }\n', 'utf8');
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'crlf-and-taint.mjs'),
      [
        'import { exec } from "node:child_process";',
        'import { type GhostType, helper } from "./types-mod.mjs";',
        'import "https://cdn.jsdelivr.net/npm/lit@3/+esm";',
        'const { $cmd } = req.query;',
        'exec($cmd);',
        'export const bad = await import("./missing-crlf.mjs");',
      ].join('\r\n'),
      'utf8'
    );
    const report = await runStressAudit(tmpDir, { fuzz: false, shutdownPool: true });
    assert.equal(report.findings.some((f) => f.ruleId === 'MISSING_DEPENDENCY' && f.evidence.includes('https:')), false);
    assert.equal(report.findings.some((f) => f.ruleId === 'BROKEN_NAMED_EXPORT' && f.evidence.includes('GhostType')), false);
    assert.ok(report.findings.some((f) => f.ruleId === 'COMMAND_INJECTION'));
    const crlfBroken = report.findings.find((f) => f.ruleId === 'BROKEN_RELATIVE_IMPORT');
    assert.equal(crlfBroken?.line, 6);
    const sevSum = report.summary.CRITICAL + report.summary.HIGH + report.summary.MEDIUM + report.summary.INFO;
    assert.equal(sevSum, report.summary.total);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

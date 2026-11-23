/**
 * @file native-runners.mjs
 * @description Contour B optional native compiler/linter runners (--native or --deep).
 *              Auto-discovers installed tools (oxlint, biome, tsc, python ast, ruff, go vet, cargo check) with short timeouts.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function runToolSafe(cmd, args, cwd, timeoutMs = 6000) {
  try {
    const res = await execFileAsync(cmd, args, {
      cwd,
      timeout: timeoutMs,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
    });
    return { available: true, code: 0, stdout: res.stdout || '', stderr: res.stderr || '' };
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'EINVAL' || err?.code === 'EACCES') {
      return { available: false, code: -1, stdout: '', stderr: '' };
    }
    return {
      available: true,
      code: typeof err?.code === 'number' ? err.code : 1,
      stdout: String(err?.stdout || ''),
      stderr: String(err?.stderr || err?.message || ''),
    };
  }
}

function normRel(rootDir, filePath) {
  if (!filePath) return '';
  if (filePath.startsWith(rootDir)) return relative(rootDir, filePath).replace(/\\/g, '/');
  return String(filePath).replace(/\\/g, '/');
}

/**
 * Runs detected Contour B native tools matching repository stack.
 */
export async function runNativeCheckers({ rootDir, stack, manifests, files }) {
  const findings = [];
  const tools = [];
  const langs = new Set(stack?.languages || []);
  const tasks = [];

  // 1. JS/TS: oxlint / biome / tsc
  if (langs.has('javascript') || langs.has('typescript')) {
    tasks.push((async () => {
      const localOxlint = join(rootDir, 'node_modules', '.bin', process.platform === 'win32' ? 'oxlint.cmd' : 'oxlint');
      const bin = existsSync(localOxlint) ? localOxlint : 'oxlint';
      const r = await runToolSafe(bin, ['--format', 'json', '.'], rootDir, 5000);
      if (!r.available) return;
      tools.push({ tool: 'oxlint', exitCode: r.code });
      try {
        const parsed = JSON.parse(r.stdout || '{}');
        for (const d of (parsed.diagnostics || []).slice(0, 30)) {
          if (d.severity !== 'error' && d.severity !== 'deny') continue;
          findings.push({
            tier: 'NATIVE',
            ruleId: `OXLINT_${String(d.code || 'ERROR').replace(/[^A-Za-z0-9_]/g, '_')}`,
            severity: 'HIGH',
            cwe: 'CWE-1006',
            confidence: 0.95,
            file: normRel(rootDir, d.filename || ''),
            line: Number(d.labels?.[0]?.span?.line || 1),
            message: String(d.message || 'oxlint error').slice(0, 140),
            evidence: 'oxlint',
          });
        }
      } catch {}
    })());

    if (manifests.biomeJsonPaths.length > 0) {
      tasks.push((async () => {
        const localBiome = join(rootDir, 'node_modules', '.bin', process.platform === 'win32' ? 'biome.cmd' : 'biome');
        const bin = existsSync(localBiome) ? localBiome : 'biome';
        const r = await runToolSafe(bin, ['check', '--reporter=json', '.'], rootDir, 5000);
        if (!r.available) return;
        tools.push({ tool: 'biome', exitCode: r.code });
        try {
          const parsed = JSON.parse(r.stdout || '{}');
          for (const d of (parsed.diagnostics || []).filter((x) => x.severity === 'error').slice(0, 25)) {
            findings.push({
              tier: 'NATIVE',
              ruleId: 'BIOME_ERROR',
              severity: 'HIGH',
              cwe: 'CWE-1006',
              confidence: 0.94,
              file: normRel(rootDir, d.location?.path?.file || ''),
              line: 1,
              message: String(d.description || 'Biome diagnostic').slice(0, 140),
              evidence: d.category || 'biome',
            });
          }
        } catch {}
      })());
    }

    if (manifests.tsconfigPaths.length > 0) {
      tasks.push((async () => {
        const localTsc = join(rootDir, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
        const bin = existsSync(localTsc) ? localTsc : 'tsc';
        const r = await runToolSafe(bin, ['--noEmit', '--pretty', 'false'], rootDir, 7000);
        if (!r.available) return;
        tools.push({ tool: 'tsc', exitCode: r.code });
        if (r.code !== 0) {
          for (const line of `${r.stdout}\n${r.stderr}`.split(/\r?\n/).slice(0, 25)) {
            const m = line.match(/^([^(]+)\((\d+),\d+\):\s*error\s+(TS\d+):\s*(.+)/);
            if (m) {
              findings.push({
                tier: 'NATIVE',
                ruleId: `TSC_${m[3]}`,
                severity: 'HIGH',
                cwe: 'CWE-1006',
                confidence: 0.97,
                file: normRel(rootDir, m[1].trim()),
                line: Number(m[2]),
                message: m[4].slice(0, 140),
                evidence: m[3],
              });
            }
          }
        }
      })());
    }
  }

  // 2. Python: ruff + zero-mutation python ast.parse (writes 0 .pyc files)
  if (langs.has('python')) {
    tasks.push((async () => {
      const r = await runToolSafe('ruff', ['check', '--output-format', 'json', '.'], rootDir, 5000);
      if (!r.available) return;
      tools.push({ tool: 'ruff', exitCode: r.code });
      try {
        const arr = JSON.parse(r.stdout || '[]');
        for (const d of arr.slice(0, 30)) {
          findings.push({
            tier: 'NATIVE',
            ruleId: `RUFF_${d.code || 'ERR'}`,
            severity: /^[FE]/.test(String(d.code || '')) ? 'HIGH' : 'MEDIUM',
            cwe: 'CWE-1006',
            confidence: 0.94,
            file: normRel(rootDir, d.filename || ''),
            line: Number(d.location?.row || 1),
            message: String(d.message || 'ruff lint error').slice(0, 140),
            evidence: d.code || 'ruff',
          });
        }
      } catch {}
    })());

    const pyFiles = files.filter((f) => f.language === 'python' && !f.readError).slice(0, 80).map((f) => f.relPath);
    if (pyFiles.length > 0) {
      tasks.push((async () => {
        const pyScript = [
          'import ast, json, sys',
          'errs = []',
          'for p in sys.argv[1:]:',
          '  try:',
          '    with open(p, "r", encoding="utf-8") as fh:',
          '      ast.parse(fh.read(), filename=p)',
          '  except SyntaxError as e:',
          '    errs.append({"file": p, "line": e.lineno or 1, "msg": str(e.msg)})',
          'print(json.dumps(errs))',
        ].join('\n');
        let r = await runToolSafe('python', ['-B', '-c', pyScript, ...pyFiles], rootDir, 5000);
        if (!r.available) r = await runToolSafe('python3', ['-B', '-c', pyScript, ...pyFiles], rootDir, 5000);
        if (!r.available) return;
        tools.push({ tool: 'python-ast', exitCode: r.code });
        try {
          for (const e of JSON.parse(r.stdout || '[]')) {
            findings.push({
              tier: 'T1',
              ruleId: 'PYTHON_SYNTAX_ERROR',
              severity: 'CRITICAL',
              cwe: 'CWE-1006',
              confidence: 0.99,
              file: normRel(rootDir, e.file),
              line: Number(e.line || 1),
              message: `Python SyntaxError: ${e.msg}`,
              evidence: 'python ast.parse',
            });
          }
        } catch {}
      })());
    }
  }

  // 3. Go: go vet
  if (langs.has('go') && manifests.goModPaths.length > 0) {
    tasks.push((async () => {
      const r = await runToolSafe('go', ['vet', './...'], rootDir, 7000);
      if (!r.available) return;
      tools.push({ tool: 'go-vet', exitCode: r.code });
      if (r.code !== 0) {
        for (const line of `${r.stdout}\n${r.stderr}`.split(/\r?\n/).slice(0, 20)) {
          const m = line.match(/^([^:\s]+\.go):(\d+):(?:\d+:)?\s*(.+)/);
          if (m) {
            findings.push({
              tier: 'NATIVE',
              ruleId: 'GO_VET',
              severity: 'HIGH',
              cwe: 'CWE-1006',
              confidence: 0.96,
              file: normRel(rootDir, m[1]),
              line: Number(m[2]),
              message: m[3].slice(0, 140),
              evidence: 'go vet',
            });
          }
        }
      }
    })());
  }

  // 4. Rust: cargo check
  if (langs.has('rust') && manifests.cargoTomlPaths.length > 0) {
    tasks.push((async () => {
      const r = await runToolSafe('cargo', ['check', '--message-format=json', '-q'], rootDir, 8000);
      if (!r.available) return;
      tools.push({ tool: 'cargo-check', exitCode: r.code });
      for (const line of r.stdout.split(/\r?\n/)) {
        if (!line.startsWith('{')) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.reason === 'compiler-message' && obj.message?.level === 'error') {
            const sp = obj.message.spans?.[0];
            findings.push({
              tier: 'NATIVE',
              ruleId: `CARGO_${obj.message.code?.code || 'ERR'}`,
              severity: 'CRITICAL',
              cwe: 'CWE-1006',
              confidence: 0.98,
              file: normRel(rootDir, sp?.file_name || 'Cargo.toml'),
              line: Number(sp?.line_start || 1),
              message: String(obj.message.message || 'Rust compiler error').slice(0, 140),
              evidence: 'cargo check',
            });
          }
        } catch {}
      }
    })());
  }

  await Promise.all(tasks);
  return { tools, findings };
}

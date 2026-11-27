import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { evaluateComplexityRatchet } from '../skills/deep-stress-auditor/scripts/run-stress-audit.mjs';
import { auditFileItem } from '../skills/deep-stress-auditor/scripts/lib/file-worker-tasks.mjs';
import { analyzeCrossFileAndContracts } from '../skills/deep-stress-auditor/scripts/lib/graph-and-contracts.mjs';
import { runNativeCheckers } from '../skills/deep-stress-auditor/scripts/lib/native-runners.mjs';
import { extractCompactInteractiveRefTree, runWebappDogfoodAudit } from '../skills/deep-stress-auditor/scripts/run-webapp-dogfood.mjs';
import { auditGithubPublish, checkMarkdownLinks } from '../skills/github-publish-guard/scripts/audit-github-publish.mjs';
import { runCodemod } from '../skills/ast-codemod-refactor/scripts/run-codemod.mjs';
import { sliceSourceCode } from '../skills/program-slicer-ocd/scripts/slice-variable.mjs';
import { evaluateSkillTriggers, parseYamlFrontmatter } from '../skills/skill-architect/scripts/audit-skill.mjs';
import { aggregateEvalIteration } from '../skills/skill-architect/scripts/eval-skill-benchmark.mjs';
import { lintVideoCompositionContent } from '../skills/programmatic-video-studio/scripts/lint-video-composition.mjs';
import { readResponseBufferLimited } from '../skills/ui-ux-design-system/scripts/fetch-web-refs.mjs';
import { normalizeOpenverseResults, searchOpenMedia } from '../skills/ui-ux-design-system/scripts/fetch-open-media.mjs';
import { generateDesignMdFromCode } from '../skills/ui-ux-design-system/scripts/extract-design-md.mjs';

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('1. Complexity Ratchet reads `cyclomatic` from auditFileItem without field mismatch', () => {
  const item = auditFileItem({
    relPath: 'src/calc.mjs',
    file: 'C:/fake/src/calc.mjs',
    ext: '.mjs',
    language: 'javascript',
    text: 'export function calc(a, b) { if (a > 0 && b > 0) return a + b; return 0; }\n',
  });
  const tmpDir = makeTmpDir('skills-ratchet-');
  try {
    const baseline = path.join(tmpDir, 'ratchet.json');
    const init = evaluateComplexityRatchet([item], baseline, { updateBaseline: true });
    assert.equal(init.trackedFiles, 1);
    const saved = JSON.parse(fs.readFileSync(baseline, 'utf8'));
    assert.ok(saved.files['src/calc.mjs'] >= 2);
    const reg = evaluateComplexityRatchet([{ relPath: 'src/calc.mjs', cyclomatic: saved.files['src/calc.mjs'] + 3 }], baseline);
    assert.equal(reg.ok, false);
    assert.equal(reg.findings[0].ruleId, 'COMPLEXITY_RATCHET_REGRESSION');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('2. checkJsTsSyntax emits relPath (not abs path) and catches TS annotations inside .mjs', () => {
  const res = auditFileItem({
    relPath: 'src/bad.mjs',
    file: path.resolve('src/bad.mjs'),
    ext: '.mjs',
    language: 'javascript',
    text: 'export const x: number = 1;\n',
  });
  assert.equal(res.syntaxOk, false);
  assert.equal(res.findings[0].ruleId, 'SYNTAX_ERROR');
  assert.equal(res.findings[0].file, 'src/bad.mjs');
});

test('3. computeTransitiveExports handles diamond re-exports without false BROKEN_NAMED_EXPORT', () => {
  const tmpDir = makeTmpDir('skills-diamond-');
  try {
    const files = {
      'leaf.mjs': 'export const sharedVal = 42;\n',
      'shared.mjs': "export * from './leaf.mjs';\n",
      'a.mjs': "export * from './shared.mjs';\n",
      'b.mjs': "export * from './shared.mjs';\n",
      'barrel.mjs': "export * from './a.mjs';\nexport * from './b.mjs';\n",
      'consumer.mjs': "import { sharedVal } from './barrel.mjs';\nexport const out = sharedVal;\n",
    };
    const fileResults = [];
    for (const [rel, text] of Object.entries(files)) {
      const abs = path.join(tmpDir, rel);
      fs.writeFileSync(abs, text, 'utf8');
      fileResults.push(auditFileItem({ relPath: rel, file: abs, ext: '.mjs', language: 'javascript', text }));
    }
    const cross = analyzeCrossFileAndContracts({
      rootDir: tmpDir,
      dirEntriesCache: new Map(),
      manifests: { packageJsonPaths: [], tsconfigPaths: [], envExamplePaths: [] },
      rootPkg: null,
      fileResults,
    });
    const broken = cross.findings.filter((f) => f.ruleId === 'BROKEN_NAMED_EXPORT');
    assert.equal(broken.length, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('4. runNativeCheckers handles missing manifests/files safely', async () => {
  const res = await runNativeCheckers({ rootDir: process.cwd(), stack: { languages: [] } });
  assert.deepEqual(res.findings, []);
  assert.deepEqual(res.tools, []);
});

test('5. run-webapp-dogfood preserves class="is-hidden" controls and blocks SSRF redirects', async () => {
  const tree = extractCompactInteractiveRefTree('<button class="is-hidden" id="okBtn">Save</button><button hidden id="hidBtn">Hide</button>');
  assert.equal(tree.interactiveCount, 1);
  assert.equal(tree.refs[0].id, 'okBtn');

  const ssrfRes = await runWebappDogfoodAudit({
    target: 'https://example.com/start',
    useAgentBrowser: false,
    fetchImpl: async () => ({
      ok: false,
      status: 302,
      headers: { get: (k) => (k.toLowerCase() === 'location' ? 'http://169.254.169.254/latest/meta-data/' : '') },
      body: { cancel: async () => {} },
    }),
  });
  assert.equal(ssrfRes.ok, false);
  assert.equal(ssrfRes.error, 'blocked_target_url');
});

test('6. audit-github-publish handles malformed % in MD links and nested cache dirs', () => {
  const tmpDir = makeTmpDir('skills-gh-');
  try {
    fs.writeFileSync(path.join(tmpDir, 'LICENSE'), 'MIT', 'utf8');
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'dist/\n', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '[bad](docs/100%-guide.md)\n', 'utf8');
    fs.mkdirSync(path.join(tmpDir, 'packages', 'sub', 'scratch'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'packages', 'sub', 'scratch', 'dep.js'), 'export default 1;\n', 'utf8');

    const mdIssues = checkMarkdownLinks('[bad](docs/100%-guide.md)', 'README.md', tmpDir);
    assert.equal(mdIssues.length, 1);
    assert.equal(mdIssues[0].ruleId, 'broken_md_link');

    const audit = auditGithubPublish({ rootDir: tmpDir });
    assert.equal(audit.ok, false);
    assert.ok(audit.errors.some((e) => e.ruleId === 'gh_forbidden_cache_dir' && e.file.includes('packages/sub/scratch/')));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('7. ddmin-runner cleans up tmp files on exit 1 and accepts quoted "{FILE}"', () => {
  const tmpDir = makeTmpDir('skills-ddmin-clean-');
  try {
    const inp = path.join(tmpDir, 'in.txt');
    fs.writeFileSync(inp, 'ok_line\n', 'utf8');
    const beforeFiles = new Set(fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('ddmin-')));
    let exitCode = 0;
    try {
      execFileSync(
        process.execPath,
        [path.resolve('skills/delta-bug-minimizer/scripts/ddmin-runner.mjs'), '--input', inp, '--cmd', 'node -e "process.exit(0)" "{FILE}"'],
        { encoding: 'utf8', windowsHide: true }
      );
    } catch (err) {
      exitCode = err.status ?? 1;
    }
    assert.equal(exitCode, 1);
    const afterFiles = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('ddmin-') && !beforeFiles.has(f));
    assert.equal(afterFiles.length, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('8. runCodemod preserves RegExp flags and writes backup for single-file rootDir', () => {
  const tmpDir = makeTmpDir('skills-codemod-');
  try {
    const file = path.join(tmpDir, 'sample.mjs');
    fs.writeFileSync(file, 'export const a = "FOO";\nexport const b = "foo";\n', 'utf8');
    const res = runCodemod({ rootDir: file, find: /foo/i, replace: 'bar' });
    assert.equal(res.ok, true);
    assert.equal(res.modifiedFiles.length, 1);
    assert.ok(fs.existsSync(path.join(tmpDir, '.cache', 'codemod-backup.json')));
    const updated = fs.readFileSync(file, 'utf8');
    assert.match(updated, /export const a = "bar";/);
    assert.match(updated, /export const b = "bar";/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('9. sliceSourceCode handles regex quotes and keeps focusLine hits near bottom', () => {
  const lines = [
    'export function topFn() {',
    "  const re = /'/;",
    '  let target = 1;',
  ];
  for (let i = 0; i < 15; i++) lines.push(`  target += ${i};`);
  lines.push('}', 'export function bottomFn() {', '  let target = 99;', '  return target;', '}');
  const res = sliceSourceCode(lines.join('\n'), 'target', { focusLine: lines.length - 1, maxLines: 4 });
  assert.equal(res.ok, true);
  assert.ok(res.sliceLines.some((s) => s.line === lines.length - 1));
  assert.ok(res.sliceLines.some((s) => s.code.includes('bottomFn')));
});

test('10. audit-skill handles BOM/nullish inputs and eval-skill-benchmark avoids NaN', () => {
  const fm = parseYamlFrontmatter('\uFEFF---\nname: demo-skill\ndescription: Use when testing BOM handling in skills.\n---\nBody\n');
  assert.equal(fm.hasFrontmatter, true);
  assert.equal(fm.name, 'demo-skill');

  const trig = evaluateSkillTriggers({ targetSkill: null, siblingSkills: [null], positivePrompts: ['test'] });
  assert.equal(trig.recall, 0);

  const tmpDir = makeTmpDir('skills-bench-');
  try {
    const iterDir = path.join(tmpDir, 'iter-1');
    fs.mkdirSync(path.join(iterDir, 'c1', 'with_skill'), { recursive: true });
    fs.mkdirSync(path.join(iterDir, 'c1', 'without_skill'), { recursive: true });
    fs.writeFileSync(path.join(iterDir, 'c1', 'with_skill', 'timing.json'), JSON.stringify({ total_tokens: 'N/A', duration_ms: 'bad' }));
    fs.writeFileSync(path.join(iterDir, 'c1', 'without_skill', 'timing.json'), JSON.stringify({ total_tokens: 100, duration_ms: 50 }));
    const bench = aggregateEvalIteration(iterDir, { writeBenchmark: false });
    assert.equal(bench.with_skill_total_tokens, 0);
    assert.equal(Number.isFinite(bench.token_delta_pct), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('11. lintVideoCompositionContent detects second unclamped interpolate() in semicolon-free JSX', () => {
  const code = `
    import { interpolate, useCurrentFrame } from 'remotion';
    export const Demo = () => {
      const f = useCurrentFrame();
      const a = interpolate(f, [0, 10], [0, 1], { extrapolateRight: 'clamp' })
      const b = interpolate(f, [10, 20], [0, 100])
      return <div>{a + b}</div>
    }
  `;
  const res = lintVideoCompositionContent(code, 'Demo.tsx');
  assert.ok(res.findings.some((f) => f.ruleId === 'remotion-unclamped-interpolate'));
});

test('12. fetch-web-refs streaming cap, fetch-open-media SSRF redirect & licenseUrl, and extract-design-md single file', async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array(1024));
    },
    cancel() {
      cancelled = true;
    },
  });
  const buf = await readResponseBufferLimited({ body: stream }, 1500);
  assert.equal(buf.length, 1500);
  assert.equal(cancelled, true);

  const norm = normalizeOpenverseResults({
    results: [{ id: '1', title: 'Pic', creator: 'A', license: 'cc0', license_url: 'javascript:alert(1)', url: 'https://example.com/a.png' }],
  });
  assert.equal(norm[0].licenseUrl, '');

  const tmpDir = makeTmpDir('skills-media-');
  try {
    const mediaRes = await searchOpenMedia({
      query: 'sky',
      download: true,
      outDir: tmpDir,
      fetchImpl: async (url) => {
        if (String(url).includes('api.openverse.org')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ results: [{ id: '1', title: 'Sky', creator: 'A', license: 'cc0', url: 'https://example.com/sky.png' }] }),
          };
        }
        return {
          ok: false,
          status: 302,
          headers: { get: () => 'http://127.0.0.1/secret.png' },
          body: { cancel: async () => {} },
        };
      },
    });
    assert.equal(mediaRes.downloadedFiles.length, 0);

    const cssFile = path.join(tmpDir, 'styles.css');
    fs.writeFileSync(cssFile, ':root { --bg-canvas: #ffffff; --text-primary: #111111; }', 'utf8');
    const md = generateDesignMdFromCode(cssFile, { write: true, overwrite: true });
    assert.equal(md.ok, true);
    assert.equal(md.outPath, path.join(tmpDir, 'DESIGN.md'));
    assert.equal(fs.existsSync(md.outPath), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('13. Windows CLI entrypoints execute even with lowercase drive letter in argv[1]', () => {
  if (process.platform !== 'win32') return;
  const absScript = path.resolve('skills/skill-architect/scripts/audit-skill.mjs');
  const lowerDrive = absScript[0].toLowerCase() + absScript.slice(1);
  const out = execFileSync(process.execPath, [lowerDrive, 'skill-architect', '--json'], { encoding: 'utf8', windowsHide: true });
  const parsed = JSON.parse(out);
  assert.equal(parsed.slug, 'skill-architect');
  assert.equal(parsed.ok, true);
});

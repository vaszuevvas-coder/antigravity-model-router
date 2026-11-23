import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { runCodemod } from '../skills/ast-codemod-refactor/scripts/run-codemod.mjs';
import { minimizeChunks } from '../skills/delta-bug-minimizer/scripts/ddmin-runner.mjs';
import { extractVariableSlice } from '../skills/program-slicer-ocd/scripts/slice-variable.mjs';
import { auditAllSkills, auditSkill } from '../skills/skill-architect/scripts/audit-skill.mjs';
import { generateShowroomHtml } from '../skills/ui-ux-design-system/scripts/build-showroom.mjs';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function runCliScript(scriptRelPath, args = [], opts = {}) {
  const scriptPath = path.join(ROOT_DIR, scriptRelPath);
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [scriptPath, ...args], {
      cwd: opts.cwd || ROOT_DIR,
      windowsHide: true,
      timeout: opts.timeout || 20_000,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return {
      code: typeof err.code === 'number' ? err.code : 1,
      stdout: err.stdout || '',
      stderr: err.stderr || err.message || '',
    };
  }
}

test('1. ast-codemod-refactor: multi-file --word rename, --dry-run, and syntax-error auto-rollback', async () => {
  const tmpDir = makeTempDir('amr-skill-codemod-');
  try {
    const files = [
      path.join(tmpDir, 'alpha.mjs'),
      path.join(tmpDir, 'beta.mjs'),
      path.join(tmpDir, 'nested', 'gamma.mjs'),
    ];
    fs.mkdirSync(path.dirname(files[2]), { recursive: true });

    fs.writeFileSync(
      files[0],
      'export const legacyWidget = 1;\nexport const legacyWidgetExtra = 2;\n',
      'utf8'
    );
    fs.writeFileSync(
      files[1],
      'import { legacyWidget } from "./alpha.mjs";\nexport function getVal() { return legacyWidget + 10; }\n',
      'utf8'
    );
    fs.writeFileSync(
      files[2],
      'export const legacyWidget = "gamma";\nexport const label = "keep_legacyWidget_suffix";\n',
      'utf8'
    );

    // 1a. CLI multi-file --word rename
    const cliRes = await runCliScript('skills/ast-codemod-refactor/scripts/run-codemod.mjs', [
      tmpDir,
      '--find',
      'legacyWidget',
      '--replace',
      'modernWidget',
      '--word',
    ]);
    assert.equal(cliRes.code, 0, `run-codemod CLI failed: ${cliRes.stderr}`);
    const parsed = JSON.parse(cliRes.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.modifiedFiles.length, 3);
    assert.equal(parsed.syntaxVerified, 3);
    assert.equal(parsed.rolledBack.length, 0);

    assert.match(fs.readFileSync(files[0], 'utf8'), /\bmodernWidget\b/);
    assert.match(fs.readFileSync(files[0], 'utf8'), /\blegacyWidgetExtra\b/, '--word must preserve partial-match identifiers');
    assert.match(fs.readFileSync(files[1], 'utf8'), /\bmodernWidget\b/);
    assert.match(fs.readFileSync(files[2], 'utf8'), /\bmodernWidget\b/);
    assert.match(fs.readFileSync(files[2], 'utf8'), /keep_legacyWidget_suffix/);

    // 1b. --dry-run leaves files untouched
    const beforeDry = files.map((f) => fs.readFileSync(f));
    const dryRes = await runCliScript('skills/ast-codemod-refactor/scripts/run-codemod.mjs', [
      tmpDir,
      '--find',
      'modernWidget',
      '--replace',
      'futureWidget',
      '--word',
      '--dry-run',
    ]);
    assert.equal(dryRes.code, 0);
    const dryParsed = JSON.parse(dryRes.stdout);
    assert.equal(dryParsed.ok, true);
    assert.equal(dryParsed.modifiedFiles.length, 3);
    for (let i = 0; i < files.length; i++) {
      assert.equal(Buffer.compare(fs.readFileSync(files[i]), beforeDry[i]), 0, 'dry-run must not alter disk bytes');
    }

    // 1c. Syntax-error auto-rollback restores 100% of original bytes
    const beforeBroken = files.map((f) => fs.readFileSync(f));
    const brokenRes = runCodemod({
      rootDir: tmpDir,
      find: 'modernWidget',
      replace: 'const = ;',
      wordBoundary: true,
    });
    assert.equal(brokenRes.ok, true);
    assert.ok(brokenRes.rolledBack.length > 0, 'Syntax error should trigger rollback');
    assert.equal(brokenRes.rolledBack.length, 3);
    assert.equal(brokenRes.modifiedFiles.length, 0);
    for (let i = 0; i < files.length; i++) {
      assert.equal(
        Buffer.compare(fs.readFileSync(files[i]), beforeBroken[i]),
        0,
        `Rolled-back file ${files[i]} must retain exact original bytes`
      );
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('2. delta-bug-minimizer: minimizeChunks shrinks 40-element array + CLI against temp failing script', async () => {
  const tmpDir = makeTempDir('amr-skill-ddmin-');
  try {
    // 2a. Function API: 40-element array -> minimal 2-element failing pair ['TRIGGER_A', 'TRIGGER_B']
    const items = Array.from({ length: 40 }, (_, i) => {
      if (i === 7) return 'TRIGGER_A';
      if (i === 29) return 'TRIGGER_B';
      return `noise_item_${i}`;
    });
    const minimized = minimizeChunks(
      items,
      (subset) => subset.includes('TRIGGER_A') && subset.includes('TRIGGER_B')
    );
    assert.deepEqual(minimized, ['TRIGGER_A', 'TRIGGER_B']);

    // 2b. CLI execution against temp failing oracle script
    const inputPath = path.join(tmpDir, 'lines.txt');
    const oraclePath = path.join(tmpDir, 'oracle.mjs');
    const outPath = path.join(tmpDir, 'ddmin-out.json');

    const lines = Array.from({ length: 24 }, (_, i) => {
      if (i === 4) return 'FAIL_ALPHA';
      if (i === 19) return 'FAIL_BETA';
      return `harmless_line_${i}`;
    });
    fs.writeFileSync(inputPath, lines.join('\n'), 'utf8');
    fs.writeFileSync(
      oraclePath,
      [
        "import fs from 'node:fs';",
        'const text = fs.readFileSync(process.argv[2], "utf8");',
        'if (text.includes("FAIL_ALPHA") && text.includes("FAIL_BETA")) process.exit(1);',
        'process.exit(0);',
      ].join('\n'),
      'utf8'
    );

    const cliRes = await runCliScript('skills/delta-bug-minimizer/scripts/ddmin-runner.mjs', [
      '--input',
      inputPath,
      '--cmd',
      `node "${oraclePath}" {FILE}`,
      '--output',
      outPath,
    ]);
    assert.equal(cliRes.code, 0, `ddmin-runner CLI failed: ${cliRes.stderr}`);
    const outJson = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    assert.equal(outJson.ok, true);
    assert.deepEqual(outJson.minimized, ['FAIL_ALPHA', 'FAIL_BETA']);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('3. program-slicer-ocd: extractVariableSlice + CLI tracks decl/alias/mutate/branch/return with >2x compression', async () => {
  const tmpDir = makeTempDir('amr-skill-slicer-');
  try {
    const targetFile = path.join(tmpDir, 'large-module.mjs');
    const noiseLines = Array.from({ length: 155 }, (_, i) => `export function UNRELATED_NOISE_${i}(x) { return x + ${i}; }`);
    const targetFunc = [
      'export function processOrder(basePrice, bonus) {',
      '  let orderTotal = basePrice;',
      '  const orderAlias = orderTotal;',
      '  orderTotal += bonus;',
      '  if (orderTotal > 100) {',
      '    console.log("high", orderAlias);',
      '  }',
      '  return orderTotal;',
      '}',
    ];
    const fullSource = [...noiseLines, ...targetFunc].join('\n');
    fs.writeFileSync(targetFile, fullSource, 'utf8');

    // 3a. Function API
    const sliceRes = extractVariableSlice(targetFile, 'orderTotal');
    assert.equal(sliceRes.ok, true);
    assert.ok(sliceRes.totalFileLines > 160, `Expected >160 lines, got ${sliceRes.totalFileLines}`);
    assert.ok(sliceRes.aliases.includes('orderAlias'), 'Alias orderAlias should be discovered');

    const roles = new Set(sliceRes.sliceLines.map((item) => item.role));
    assert.ok(roles.has('decl'), 'Expected decl role in sliceLines');
    assert.ok(roles.has('mutate'), 'Expected mutate role in sliceLines');
    assert.ok(roles.has('branch'), 'Expected branch role in sliceLines');
    assert.ok(roles.has('return'), 'Expected return role in sliceLines');
    assert.ok(
      sliceRes.sliceLines.some((item) => item.code.includes('orderAlias')),
      'Alias usage line should be included in sliceLines'
    );
    assert.equal(
      sliceRes.sliceLines.some((item) => item.code.includes('UNRELATED_NOISE')),
      false,
      'Unrelated lines must be omitted from slice'
    );

    const compressionRatio = sliceRes.totalFileLines / sliceRes.sliceLines.length;
    assert.ok(compressionRatio > 2, `Expected compressionRatio > 2, got ${compressionRatio}`);

    // 3b. CLI execution
    const cliRes = await runCliScript('skills/program-slicer-ocd/scripts/slice-variable.mjs', [
      targetFile,
      'orderTotal',
    ]);
    assert.equal(cliRes.code, 0, `slice-variable CLI failed: ${cliRes.stderr}`);
    assert.match(cliRes.stdout, /\[decl\]/);
    assert.match(cliRes.stdout, /\[mutate\]/);
    assert.match(cliRes.stdout, /\[branch\]/);
    assert.match(cliRes.stdout, /\[return\]/);
    assert.match(cliRes.stdout, /orderAlias/);
    assert.doesNotMatch(cliRes.stdout, /UNRELATED_NOISE/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('4. skill-architect: auditAllSkills passes repo skills/ with 0 errors and auditSkill catches broken SKILL.md', async () => {
  const tmpDir = makeTempDir('amr-skill-architect-');
  try {
    // 4a. Real repo skills/ audit
    const repoSkillsDir = path.join(ROOT_DIR, 'skills');
    const allRes = auditAllSkills(repoSkillsDir);
    assert.equal(allRes.ok, true, `Expected all repo skills to pass without errors: ${JSON.stringify(allRes.results.filter((r) => !r.ok))}`);
    assert.ok(allRes.total >= 5);
    for (const r of allRes.results) {
      assert.equal(r.errorsCount, 0, `Skill ${r.slug} reported errors: ${JSON.stringify(r.findings)}`);
    }

    // 4b. Broken temp SKILL.md (missing frontmatter, 3+ rigid ALWAYS/NEVER without causal clause, missing scripts/ghost.mjs)
    const brokenSkillDir = path.join(tmpDir, 'broken-skill');
    fs.mkdirSync(brokenSkillDir, { recursive: true });
    fs.writeFileSync(
      path.join(brokenSkillDir, 'SKILL.md'),
      [
        '# Broken Skill Without Frontmatter',
        '',
        '- ALWAYS obey arbitrary rule one.',
        '- NEVER touch anything at all.',
        '- STRICTLY follow rigid rule three.',
        '',
        'Run `node scripts/ghost.mjs` to trigger missing script error.',
      ].join('\n'),
      'utf8'
    );

    const brokenRes = auditSkill(brokenSkillDir, { skillsRoot: tmpDir });
    assert.equal(brokenRes.ok, false);
    assert.ok(brokenRes.errorsCount >= 2);
    const findingIds = new Set(brokenRes.findings.map((f) => f.id));
    assert.ok(findingIds.has('FM_MISSING'), 'Should catch missing YAML frontmatter (FM_MISSING)');
    assert.ok(findingIds.has('NT_UNEXPLAINED_RIGID_CAPS'), 'Should catch rigid ALWAYS/NEVER without causal clause');
    assert.ok(findingIds.has('PD_BROKEN_SCRIPT_REF'), 'Should catch missing scripts/ghost.mjs');

    // 4c. CLI audit on broken skill returns exit code 1 with JSON findings
    const cliRes = await runCliScript('skills/skill-architect/scripts/audit-skill.mjs', [
      brokenSkillDir,
      '--skills-root',
      tmpDir,
      '--json',
    ]);
    assert.equal(cliRes.code, 1);
    const cliJson = JSON.parse(cliRes.stdout);
    assert.equal(cliJson.ok, false);
    const cliIds = new Set(cliJson.findings.map((f) => f.id));
    assert.ok(cliIds.has('FM_MISSING'));
    assert.ok(cliIds.has('NT_UNEXPLAINED_RIGID_CAPS'));
    assert.ok(cliIds.has('PD_BROKEN_SCRIPT_REF'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('5. ui-ux-design-system: build-showroom CLI (--fast-png, NO --open) + HTML XSS sanitization + PNG previews', async () => {
  const tmpDir = makeTempDir('amr-skill-showroom-');
  try {
    const specPath = path.join(tmpDir, 'spec.json');
    const outHtmlPath = path.join(tmpDir, 'out', 'showroom.html');
    const spec = {
      title: 'E2E Showroom Test',
      variants: [
        {
          id: 'A',
          label: 'Variant A XSS Probe',
          subtitle: 'Tests script escape and javascript URL blocking',
          stageBg: '#f7f3eb',
          accentColor: '#c85a32',
          html: '<div class="card">Hello</script><script>window.__xss=1</script></div>',
          sourceUrl: 'javascript:alert(1)',
        },
        {
          id: 'B',
          label: 'Variant B Ref Probe',
          subtitle: 'Tests referenceImage javascript blocking',
          stageBg: '#eef2f6',
          accentColor: '#2563eb',
          html: '<div class="bento">Bento Grid</div>',
          referenceImage: 'javascript:alert(2)',
          sourceUrl: 'https://example.com/design-ref',
        },
        {
          id: 'C',
          label: 'Variant C Dark',
          subtitle: 'Clean dark variant',
          stageBg: '#12100e',
          accentColor: '#f59e0b',
          html: '<div class="studio-card">Dark Stage</div>',
        },
      ],
    };
    fs.writeFileSync(specPath, JSON.stringify(spec, null, 2), 'utf8');

    // 5a. Function API check
    const fnRes = generateShowroomHtml(spec);
    assert.equal(fnRes.ok, true);
    assert.equal(fnRes.variantCount, 3);

    // 5b. CLI execution (NEVER pass --open!)
    const cliRes = await runCliScript('skills/ui-ux-design-system/scripts/build-showroom.mjs', [
      specPath,
      outHtmlPath,
      '--fast-png',
    ]);
    assert.equal(cliRes.code, 0, `build-showroom CLI failed: ${cliRes.stderr}`);
    const outJson = JSON.parse(cliRes.stdout);
    assert.equal(outJson.ok, true);
    assert.equal(outJson.variantCount, 3);
    assert.equal(outJson.opened, false);
    assert.equal(outJson.screenshots.length, 3);

    const htmlOut = fs.readFileSync(outHtmlPath, 'utf8');
    assert.equal(
      htmlOut.includes('window.__xss=1</script>'),
      false,
      'Injected </script> must be escaped'
    );
    assert.ok(htmlOut.includes('&amp;lt;/script'), 'Escaped &amp;lt;/script should appear in srcdoc');
    assert.equal(
      /javascript\s*:/i.test(htmlOut),
      false,
      'javascript: URLs must be completely blocked from output HTML'
    );
    assert.ok(htmlOut.includes('https://example.com/design-ref'), 'Valid https sourceUrl should be preserved');

    const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    for (const pngPath of [...outJson.screenshots, outJson.overviewScreenshot]) {
      assert.equal(fs.existsSync(pngPath), true, `Missing PNG preview: ${pngPath}`);
      const buf = fs.readFileSync(pngPath);
      assert.ok(buf.length > 100, `PNG file unexpectedly small: ${pngPath}`);
      assert.equal(buf.subarray(0, 8).compare(pngMagic), 0, `Invalid PNG header in ${pngPath}`);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

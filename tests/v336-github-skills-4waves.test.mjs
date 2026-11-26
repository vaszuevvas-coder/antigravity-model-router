import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildGraphUncertaintyNote,
  extractMarkdownSection,
  loadJsAliasRules,
  resolveImportRel,
} from '../core/ram/ram-index-helpers.mjs';
import { RamMemoryEngine } from '../core/ram-memory-engine.mjs';
import { compressRtkCommandOutput, maskTerminalOutput } from '../core/obs-masker.mjs';
import { detectCliFailRecoveryFriction } from '../core/friction-observer.mjs';
import { scanConstraintWeakeningInDiff } from '../core/completion-gates.mjs';
import { classifyAntigravity429 } from '../core/quota-pacer.mjs';
import { evaluateComplexityRatchet } from '../skills/deep-stress-auditor/scripts/run-stress-audit.mjs';
import {
  probeAppForCliHarness,
  validateCliHarness,
} from '../skills/cli-anything-harness/scripts/scaffold-cli-harness.mjs';

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('Wave A1: tsconfig.json @/* & package.json #imports alias resolution in RamMemoryEngine', () => {
  const dir = makeTmpDir('tunnel-v336-alias-');
  try {
    fs.mkdirSync(path.join(dir, 'src/components'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'src/utils'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'tsconfig.json'),
      `{\n  // comment\n  "compilerOptions": {\n    "baseUrl": ".",\n    "paths": {\n      "@/*": ["src/*"],\n    }\n  }\n}\n`
    );
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'demo', imports: { '#utils/*': './src/utils/*.ts' } }, null, 2)
    );
    fs.writeFileSync(path.join(dir, 'src/utils/format.ts'), 'export function fmt(x: string) { return x.trim(); }\n');
    fs.writeFileSync(
      path.join(dir, 'src/components/Card.tsx'),
      `import { fmt } from '@/utils/format';\nimport { fmt as f2 } from '#utils/format';\nexport const Card = () => fmt(f2('hi'));\n`
    );

    const rules = loadJsAliasRules(dir);
    assert.ok(rules.rules.length >= 2);
    const filesMap = new Map([
      ['src/utils/format.ts', {}],
      ['src/components/Card.tsx', {}],
    ]);
    assert.equal(resolveImportRel('src/components/Card.tsx', '@/utils/format', filesMap, { jsAliases: rules }), 'src/utils/format.ts');
    assert.equal(resolveImportRel('src/components/Card.tsx', '#utils/format', filesMap, { jsAliases: rules }), 'src/utils/format.ts');

    const ram = new RamMemoryEngine({ budgetMb: 64 });
    try {
      ram.warmWorkspace(dir, { startWatcher: false });
      const ws = ram.getOrCreateWorkspace(dir);
      const rev = ws.reverseDeps.get('src/utils/format.ts');
      assert.ok(rev && rev.has('src/components/Card.tsx'), 'reverseDeps should link @/ alias importer');
    } finally {
      ram.evict('all');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Wave A2: Markdown section slicing skips fenced code blocks and returns TOC on miss', () => {
  const md = [
    '# Project Guide',
    'Intro line.',
    '```markdown',
    '## Fake Heading Inside Fence',
    '```',
    '## Architecture Overview',
    'Core module connects RAM and CPU.',
    '### Subcomponent',
    'Sub detail.',
    '## Deployment',
    'Run install.js.',
  ].join('\n');

  const hit = extractMarkdownSection(md, 'architecture-overview');
  assert.equal(hit.found, true);
  assert.equal(hit.heading, 'Architecture Overview');
  assert.equal(hit.startLine, 6);
  assert.equal(hit.endLine, 9);
  assert.ok(!hit.availableHeadings.some((h) => h.title.includes('Fake Heading')));

  const dir = makeTmpDir('tunnel-v336-mdsec-');
  const ram = new RamMemoryEngine({ budgetMb: 64 });
  try {
    fs.writeFileSync(path.join(dir, 'GUIDE.md'), md);
    const sliced = ram.slice(dir, 'GUIDE.md', { section: 'Deployment' });
    assert.equal(sliced.ok, true);
    assert.equal(sliced.section, 'Deployment');
    assert.ok(sliced.formatted.includes('Run install.js.'));
    assert.ok(!sliced.formatted.includes('Core module connects'));

    const miss = ram.slice(dir, 'GUIDE.md', { section: 'Nonexistent' });
    assert.equal(miss.ok, false);
    assert.ok(miss.formatted.includes('Available headings'));
    assert.ok(miss.formatted.includes('Architecture Overview'));
  } finally {
    ram.evict('all');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Wave A3: Honest Graph Uncertainty Markers attach only on 0-hit graph queries', () => {
  const dir = makeTmpDir('tunnel-v336-uncert-');
  const ram = new RamMemoryEngine({ budgetMb: 64 });
  try {
    fs.writeFileSync(path.join(dir, 'standalone.js'), 'export const ping = () => 1;\n');
    fs.writeFileSync(path.join(dir, 'other.py'), 'def run():\n    return 2\n');
    ram.warmWorkspace(dir, { startWatcher: false });
    const ws = ram.getOrCreateWorkspace(dir);

    assert.equal(buildGraphUncertaintyNote({ mode: 'affected', target: 'standalone.js', ws, resultCount: 2 }), '');
    const pyNote = buildGraphUncertaintyNote({ mode: 'affected', target: 'other.py', ws, resultCount: 0 });
    assert.ok(pyNote.includes('.py'));
    assert.ok(pyNote.length <= 190);

    const aff = ram.queryKnowledgeGraph(dir, { mode: 'affected', target: 'standalone.js', startWatcher: false });
    assert.ok(aff.uncertaintyNote && aff.formatted.includes('Graph Uncertainty'));

    const pMiss = ram.queryKnowledgeGraph(dir, { mode: 'path', from: 'standalone.js', to: 'other.py', startWatcher: false });
    assert.equal(pMiss.found, false);
    assert.ok(pMiss.uncertaintyNote && pMiss.formatted.includes('Graph Uncertainty'));
  } finally {
    ram.evict('all');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Wave A4: RTK declarative CLI filters (git_log, pkg_install, html_structural) & auto CCR spillover', () => {
  const gitLogLines = [];
  for (let i = 0; i < 10; i++) {
    gitLogLines.push(`commit ${String(i).repeat(10)}abcdef`);
    gitLogLines.push('Author: Dev User <dev@example.com>');
    gitLogLines.push('Date:   Mon Nov 25 10:00:00 2026 +0300');
    gitLogLines.push('');
    gitLogLines.push(`    feat: implement feature item ${i}`);
    gitLogLines.push('');
  }
  const logRes = compressRtkCommandOutput(gitLogLines.join('\n'), 0, 'git log');
  assert.equal(logRes.matched, true);
  assert.equal(logRes.profile, 'git_log');
  assert.ok(logRes.compressed.includes('RTK-GitLog'));

  const pipLines = [
    ...Array.from({ length: 24 }, (_, i) => `Requirement already satisfied: pkg-${i} in /usr/lib/python`),
    'Successfully installed demo-tool-1.0.0',
  ];
  const pipRes = compressRtkCommandOutput(pipLines.join('\n'), 0, 'pip install demo-tool');
  assert.equal(pipRes.matched, true);
  assert.equal(pipRes.profile, 'pkg_install');
  assert.ok(pipRes.compressed.includes('Successfully installed'));

  const html = `<!doctype html><html><head><style>${'body{color:red}'.repeat(120)}</style><script>${'console.log(1);'.repeat(120)}</script></head><body><main><h1>Title</h1></main></body></html>`;
  const htmlRes = compressRtkCommandOutput(html, 0, 'curl page');
  assert.equal(htmlRes.matched, true);
  assert.equal(htmlRes.profile, 'html_structural');
  assert.ok(htmlRes.compressed.includes('<h1>Title</h1>'));

  // Auto-CCR spillover for >=10KB output via custom stub hub
  const bigNoise = Array.from({ length: 280 }, (_, i) => `info: processing shard item ${i} with status ok`).join('\n');
  let storedCount = 0;
  const stubHub = {
    storeCcrBlob: () => {
      storedCount += 1;
      return { ok: true, hash: 'deadbeef01' };
    },
  };
  const masked = maskTerminalOutput(bigNoise, 0, { ccrHub: stubHub, commandLine: 'node batch.mjs' });
  assert.equal(storedCount, 1);
  assert.equal(masked.ccrHash, 'deadbeef01');
  assert.ok(masked.masked.includes('CCR #deadbeef01'));
});

test('Wave A5: CLI Fail->Succeed Learner detects corrected command pair', () => {
  const dir = makeTmpDir('tunnel-v336-clilearn-');
  const stateFile = path.join(dir, 'friction.json');
  try {
    const f1 = detectCliFailRecoveryFriction({
      conversationId: 'c-cli',
      commandLine: 'git status --porcelain-v99',
      exitCode: 129,
      errorOutput: 'error: unknown option `porcelain-v99`',
      stateFile,
      nowMs: 10_000,
    });
    assert.equal(f1.detected, false);

    const f2 = detectCliFailRecoveryFriction({
      conversationId: 'c-cli',
      commandLine: 'git status --porcelain',
      exitCode: 0,
      errorOutput: '',
      stateFile,
      nowMs: 18_000,
    });
    assert.equal(f2.detected, true);
    assert.equal(f2.signalType, 'cli_correction');
    assert.equal(f2.errorType, 'unknown_flag');
    assert.equal(f2.baseCommand, 'git status');
    assert.ok(f2.candidatePattern.includes('--porcelain'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Wave B1: Anti-Cheating Constraint Diff Guard catches suppressions, .only, and stripped assertions', () => {
  const oldCode = 'export function calc(x) {\n  // @ts-ignore pre-existing\n  return x + 1;\n}\n';
  const newCode = 'export function calc(x) {\n  // @ts-ignore pre-existing\n  // eslint-disable-next-line no-unused-vars\n  return x + 1;\n}\n';
  const res = scanConstraintWeakeningInDiff(oldCode, newCode, 'core/calc.mjs');
  assert.equal(res.ok, false);
  assert.equal(res.issues.length, 1);
  assert.equal(res.issues[0].kind, 'lint_suppression');

  const oldTest = `test('a', () => {\n  assert.equal(1, 1);\n  assert.equal(2, 2);\n  assert.equal(3, 3);\n});\n`;
  const newTest = `test.only('a', () => {\n  assert.equal(1, 1);\n});\n`;
  const testRes = scanConstraintWeakeningInDiff(oldTest, newTest, 'tests/calc.test.mjs');
  assert.equal(testRes.ok, false);
  const kinds = new Set(testRes.issues.map((i) => i.kind));
  assert.ok(kinds.has('focused_test_only'));
  assert.ok(kinds.has('stripped_assertions'));
});

test('Wave B2: Antigravity 429 Classifier distinguishes quota, credits, RPM, and soft burst limits', () => {
  const q = classifyAntigravity429('Individual quota reached. Contact your administrator to enable overages.', { lang: 'en' });
  assert.equal(q.category, 'quota_exhausted');
  assert.equal(q.shouldSwitchModel, true);

  const cr = classifyAntigravity429('google_one_ai insufficient credits remaining', { lang: 'ru' });
  assert.equal(cr.category, 'credits_exhausted');
  assert.ok(cr.recommendation.includes('кредитов'));

  const rpm = classifyAntigravity429('HTTP 429 rate limit exceeded, retry-after: 90s', { lang: 'en' });
  assert.equal(rpm.category, 'rate_limited');
  assert.equal(rpm.cooldownMs, 90_000);

  const soft = classifyAntigravity429('503 service temporarily overloaded, try again shortly', { lang: 'en' });
  assert.equal(soft.category, 'soft_rate_limit');
  assert.equal(soft.shouldSwitchModel, false);
});

test('Wave B3: Complexity Ratchet baseline tracks and catches cyclomatic regressions', () => {
  const dir = makeTmpDir('tunnel-v336-ratchet-');
  const baselinePath = path.join(dir, 'complexity-baseline.json');
  try {
    const initRes = evaluateComplexityRatchet(
      [{ relPath: 'core/a.mjs', cyclomaticComplexity: 18 }],
      baselinePath,
      { updateBaseline: true }
    );
    assert.equal(initRes.ok, true);
    assert.ok(fs.existsSync(baselinePath));

    const passRes = evaluateComplexityRatchet([{ relPath: 'core/a.mjs', cyclomaticComplexity: 18 }], baselinePath);
    assert.equal(passRes.ok, true);

    const failRes = evaluateComplexityRatchet(
      [
        { relPath: 'core/a.mjs', cyclomaticComplexity: 24 },
        { relPath: 'core/new-giant.mjs', cyclomaticComplexity: 42 },
      ],
      baselinePath
    );
    assert.equal(failRes.ok, false);
    const ids = new Set(failRes.findings.map((f) => f.ruleId));
    assert.ok(ids.has('COMPLEXITY_RATCHET_REGRESSION'));
    assert.ok(ids.has('COMPLEXITY_RATCHET_NEW_FILE'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Wave C & D: ui-ux-design-system references & cli-anything-harness probe/validate contract', () => {
  const skillRoot = path.resolve('skills/ui-ux-design-system');
  assert.ok(fs.existsSync(path.join(skillRoot, 'references/emil-choreography-gestures.md')));
  assert.ok(fs.existsSync(path.join(skillRoot, 'references/impeccable-craft-floor.md')));
  const reactRules = fs.readFileSync(path.join(skillRoot, 'references/react-vercel-rules.md'), 'utf8');
  assert.ok(reactRules.includes('<ViewTransition>'));

  const dir = makeTmpDir('tunnel-v336-cliharness-');
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo-app', bin: { demo: './cli.mjs' } }));
    fs.writeFileSync(path.join(dir, 'scene.json'), '{"layers":[]}');
    fs.writeFileSync(path.join(dir, 'cli.mjs'), 'console.log("--json", "--help");\n');

    const probe = probeAppForCliHarness(dir);
    assert.equal(probe.ok, true);
    assert.equal(probe.recommendedStrategy, 'wrap_existing_cli_with_json_contract');
    assert.ok(probe.dataFormats.includes('.json'));

    const partial = validateCliHarness(dir);
    assert.equal(partial.ok, false);
    assert.equal(partial.exitCode, 3);
    assert.ok(partial.gaps.includes('automated_tests'));
    assert.ok(partial.gaps.includes('consumer_skill_md'));

    fs.writeFileSync(path.join(dir, 'cli.test.mjs'), 'import assert from "node:assert";\n');
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: demo\ndescription: Demo\n---\n');
    const full = validateCliHarness(dir);
    assert.equal(full.ok, true);
    assert.equal(full.exitCode, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

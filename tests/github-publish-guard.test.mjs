import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  auditGithubPublish,
  checkMarkdownLinks,
  formatAuditReport,
  scanTextForFingerprints,
  scanTextForSecrets,
} from '../skills/github-publish-guard/scripts/audit-github-publish.mjs';

function makeTempRepo(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-publish-guard-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  return dir;
}

test('scanTextForFingerprints catches OS user paths and ignores generic placeholders', () => {
  const leaked = scanTextForFingerprints(
    'const p = "C:\\\\Users\\\\SecretOwner\\\\Desktop\\\\repo";\nconst u = "/Users/SecretOwner/dev";\n',
    'src/config.mjs',
    { currentUsername: 'SecretOwner', currentHostname: 'MY-WORKSTATION-99' },
  );
  assert.equal(leaked.filter((f) => f.ruleId === 'machine_user_path').length, 2);

  const safe = scanTextForFingerprints(
    'const example = "C:\\\\Users\\\\<user>\\\\project";\nconst doc = "/home/example/app";\n',
    'README.md',
    { currentUsername: 'SecretOwner', currentHostname: 'MY-WORKSTATION-99' },
  );
  assert.equal(safe.length, 0);
});

test('scanTextForSecrets catches tokens and skips masked examples', () => {
  const token = ['ghp', '_1234567890abcdefghij1234567890'].join('');
  const hits = scanTextForSecrets(`const tok = "${token}";\n`, 'src/api.mjs');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].ruleId, 'secret_gh_pat');

  const masked = scanTextForSecrets('Token: ghp_************************\n', 'README.md');
  assert.equal(masked.length, 0);
});

test('checkMarkdownLinks flags broken relative links and allows existing files and URLs', () => {
  const dir = makeTempRepo({
    'README.md': '[OK](LICENSE) [Broken](docs/missing.md) [Web](https://github.com/example/repo)',
    LICENSE: 'MIT',
  });
  try {
    const res = checkMarkdownLinks(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), 'README.md', dir);
    assert.equal(res.length, 1);
    assert.equal(res[0].ruleId, 'broken_md_link');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('auditGithubPublish blocks dirty router-state, .env files, and version mismatch', () => {
  const dir = makeTempRepo({
    'package.json': JSON.stringify({ name: 'demo-plugin', version: '1.2.0' }),
    'plugin.json': JSON.stringify({ name: 'demo-plugin', version: '1.1.0' }),
    'router-state.json': JSON.stringify({ hardwareProfiled: true, gpuModelsDir: 'D:\\Ollama\\models' }),
    '.env': 'API_SECRET=supersecretvalue',
    'README.md': '# Demo v1.0.0\n',
    'CHANGELOG.md': '## [1.1.0]\n',
    LICENSE: 'MIT',
    '.gitignore': 'node_modules/\n',
  });
  try {
    const res = auditGithubPublish({ rootDir: dir, currentUsername: 'UnitTester', currentHostname: 'UNIT-HOST-77' });
    assert.equal(res.ok, false);
    const ids = new Set(res.errors.map((e) => e.ruleId));
    assert.ok(ids.has('version_mismatch'));
    assert.ok(ids.has('dirty_router_state'));
    assert.ok(ids.has('gh_forbidden_secret_file'));
    assert.ok(ids.has('readme_version_mismatch'));
    assert.ok(formatAuditReport(res).includes('BLOCKED'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('auditGithubPublish passes cleanly on a compliant repository', () => {
  const dir = makeTempRepo({
    'package.json': JSON.stringify({ name: 'clean-repo', version: '2.0.0' }),
    'plugin.json': JSON.stringify({ name: 'clean-repo', version: '2.0.0' }),
    'router-state.json': JSON.stringify({ hardwareProfiled: false, onboardingCompleted: false, gpuModelsDir: '', gpuEnabled: false }),
    'README.md': '# Clean Repo v2.0.0\n\nSee [LICENSE](LICENSE).\n',
    'CHANGELOG.md': '# Changelog\n\n## [2.0.0] — 2026-11-24\n- Initial release\n',
    LICENSE: 'MIT License',
    '.gitignore': '.env\nnode_modules/\n',
    'src/index.mjs': 'export const ok = true;\n',
  });
  try {
    const res = auditGithubPublish({ rootDir: dir, strict: true, currentUsername: 'UnitTester', currentHostname: 'UNIT-HOST-77' });
    assert.equal(res.ok, true);
    assert.equal(res.errorsCount, 0);
    assert.equal(res.warningsCount, 0);
    assert.equal(res.grade, 'A');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('auditGithubPublish catches long-line secrets, repo-escaping links, release-manifest drift, and nonexistent root', () => {
  const missing = auditGithubPublish({ rootDir: path.join(os.tmpdir(), `gh-missing-${Date.now()}`) });
  assert.equal(missing.ok, false);
  assert.equal(missing.errors[0].ruleId, 'root_not_found');

  const dir = makeTempRepo({
    'package.json': JSON.stringify({ name: 'long-line-repo', version: '2.0.0' }),
    'plugin.json': JSON.stringify({ name: 'long-line-repo', version: '2.0.0' }),
    'release-manifest.json': JSON.stringify({ version: '1.9.0' }),
    'README.md': '# Repo v2.0.0\n\n`[ignored](does-not-exist.md)`\n![Banner](/LICENSE)\n[Escape](../../outside.md)\n',
    'CHANGELOG.md': '# Changelog\n\n## [2.0.0]\n',
    LICENSE: 'MIT',
    '.gitignore': 'node_modules/\n',
    'src/bundle.min.js': `${'a'.repeat(4500)} const k="ghp_${'Z'.repeat(36)}";`,
  });
  try {
    const res = auditGithubPublish({ rootDir: dir, currentUsername: 'UnitTester', currentHostname: 'UNIT-HOST-77' });
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.ruleId === 'secret_gh_pat'));
    const warnIds = new Set(res.warnings.map((w) => w.ruleId));
    assert.ok(warnIds.has('release_manifest_version_mismatch'));
    assert.ok(warnIds.has('broken_md_link'));
    assert.equal(res.warnings.filter((w) => w.ruleId === 'broken_md_link').length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

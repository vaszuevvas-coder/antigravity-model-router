#!/usr/bin/env node
/**
 * Deterministic Pre-Publish GitHub Guard (Zero-Dependency Node.js ESM).
 * Audits any Git repository (with optional Antigravity plugin template checks) for:
 *  1. Machine fingerprints & privacy leaks (OS user/home paths, hostnames, LAN IPs, secrets, personal templates)
 *  2. GitHub rules & repo hygiene (50MB/100MB size limits, forbidden/cache/junk files, LICENSE/.gitignore/README)
 *  3. Metadata, docs & remote parity (SemVer sync, relative MD links, counts, remote branch & GitHub Releases)
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MB = 1024 * 1024;
const GH_WARN_BYTES = 50 * MB;
const GH_MAX_BYTES = 100 * MB;
const MAX_TEXT_SCAN_BYTES = 2 * MB;

const BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.tiff',
  '.pdf', '.zip', '.tar', '.gz', '.7z', '.rar', '.exe', '.dll', '.so',
  '.dylib', '.bin', '.wasm', '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp3', '.mp4', '.webm', '.wav', '.ogg', '.sqlite', '.db', '.asar',
]);

const GENERIC_USERNAMES = new Set([
  'user', 'username', 'yourname', 'your-name', 'your_name', 'name',
  'alice', 'bob', 'charlie', 'john', 'jane', 'doe', 'example', 'sample',
  'demo', 'test', 'runner', 'admin', 'root', 'node', 'vscode', 'codespace',
  'github', 'ubuntu', 'debian', 'dev', 'developer', 'owner', 'author',
  'you', 'me', 'someone', 'guest', 'default', 'public', 'all users',
]);

const GENERIC_HOSTNAMES = new Set([
  'localhost', 'desktop', 'laptop', 'workstation', 'server', 'host',
  'my-pc', 'mypc', 'ubuntu', 'debian', 'linux', 'windows', 'macos',
]);

const FORBIDDEN_SECRET_FILES = [
  /^\.env(?:\.[^.]+)?$/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
];

const ALLOWED_ENV_EXAMPLES = /^\.env\.(?:example|sample|template|dist|schema)$/i;

const FORBIDDEN_CACHE_PREFIXES = [
  'node_modules/',
  '.cache/',
  'scratch/',
  'backups/',
  'checkpoints/',
  '.shadow/',
];

const JUNK_BASENAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

const SECRET_RULES = [
  { id: 'gh_pat', label: 'GitHub token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g },
  { id: 'gh_fine_pat', label: 'GitHub fine-grained PAT', re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },
  { id: 'aws_key', label: 'AWS access key ID', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: 'openai_key', label: 'OpenAI/Anthropic API key', re: /\bsk-(?:proj-|ant-|live-|test-)?[A-Za-z0-9_-]{24,}\b/g },
  { id: 'google_api', label: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: 'slack_token', label: 'Slack token', re: /\bxox[baprs]-[0-9A-Za-z-]{16,}\b/g },
  { id: 'private_key', label: 'Private key block', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g },
];

// Match Windows / macOS / Linux absolute home directories
const WIN_USER_PATH_RE = /\b([A-Za-z]:(?:\\|\/)+Users(?:\\|\/)+)([^\\\/\s"'`<>|;,)\]}]+)/gi;
const UNIX_HOME_PATH_RE = /(?:^|[\s"'`(=:])(\/(?:Users|home)\/)([A-Za-z0-9._-]+)/g;
const LAN_IP_RE = /\b(?:192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g;

function toPosix(p) {
  return String(p || '').replace(/\\/g, '/');
}

function isTestOrFixtureFile(relPath) {
  const p = toPosix(relPath).toLowerCase();
  return (
    p.startsWith('tests/')
    || p.startsWith('test/')
    || p.includes('/__tests__/')
    || /\.test\.[cm]?[jt]sx?$/.test(p)
    || /\.spec\.[cm]?[jt]sx?$/.test(p)
    || p === 'skills/github-publish-guard/scripts/audit-github-publish.mjs'
  );
}

function isMaskedOrPlaceholderToken(token) {
  const s = String(token || '').toLowerCase();
  if (/(\*{4,}|x{4,}|0{8,}|1{8,}|a{8,}|example|sample|dummy|fake|test|placeholder|redacted)/i.test(s)) {
    return true;
  }
  return false;
}

function isPlaceholderUser(userSegment) {
  const raw = String(userSegment || '').trim().replace(/[.,:;!?]+$/, '');
  if (!raw) return true;
  if (/^[<$%{[]/.test(raw) || raw.includes('<') || raw.includes('$') || raw.includes('%')) return true;
  if (GENERIC_USERNAMES.has(raw.toLowerCase())) return true;
  if (/^\*+$/.test(raw)) return true;
  return false;
}

function looksLikeRegexLiteralLine(line) {
  const trimmed = String(line || '').trim();
  return (
    /\/[^/\n]+\/[gimsuy]*/.test(trimmed)
    && (trimmed.includes('RegExp') || trimmed.includes('_RE') || trimmed.includes('.test(') || trimmed.includes('.match(') || trimmed.includes('.replace('))
  );
}

function runCmdSafe(bin, args, cwd, timeoutMs = 8000) {
  try {
    const out = execFileSync(bin, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
      windowsHide: true,
    });
    return { ok: true, stdout: String(out || '').trim(), stderr: '' };
  } catch (err) {
    return {
      ok: false,
      stdout: String(err?.stdout || '').trim(),
      stderr: String(err?.stderr || err?.message || '').trim(),
    };
  }
}

function collectFilesToAudit(rootDir, stagedOnly = false) {
  const isGit = fs.existsSync(path.join(rootDir, '.git'));
  if (isGit) {
    const args = stagedOnly
      ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']
      : ['ls-files', '-z'];
    const res = runCmdSafe('git', args, rootDir);
    if (res.ok) {
      const files = res.stdout.split('\0').filter(Boolean).map(toPosix);
      if (!stagedOnly) {
        // Also include untracked non-ignored files so newly created files are audited pre-commit
        const untracked = runCmdSafe('git', ['ls-files', '--others', '--exclude-standard', '-z'], rootDir);
        if (untracked.ok && untracked.stdout) {
          for (const u of untracked.stdout.split('\0').filter(Boolean).map(toPosix)) {
            if (!files.includes(u)) files.push(u);
          }
        }
      }
      return { isGit: true, files };
    }
  }
  // Fallback walker for non-git directories
  const files = [];
  const skipDirs = new Set(['.git', 'node_modules', '.cache', 'dist', 'build']);
  function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.isDirectory()) {
        if (!skipDirs.has(ent.name)) walk(path.join(dir, ent.name));
      } else if (ent.isFile()) {
        files.push(toPosix(path.relative(rootDir, path.join(dir, ent.name))));
      }
    }
  }
  walk(rootDir);
  return { isGit: false, files };
}

/**
 * Scans a single text file for machine fingerprints (OS user paths, hostnames, LAN IPs).
 */
export function scanTextForFingerprints(text, relPath, {
  currentUsername = '',
  currentHostname = '',
} = {}) {
  const findings = [];
  const lines = String(text || '').split(/\r?\n/);
  const isTestFile = isTestOrFixtureFile(relPath);
  const normUser = String(currentUsername || '').trim().toLowerCase();
  const normHost = String(currentHostname || '').trim().toLowerCase();
  const checkHost = normHost.length >= 5 && !GENERIC_HOSTNAMES.has(normHost);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line || line.length > 4000) continue;
    const lineNum = i + 1;
    const isRegexLine = looksLikeRegexLiteralLine(line);

    // 1. Windows absolute user paths: C:\Users\<name>
    WIN_USER_PATH_RE.lastIndex = 0;
    let m;
    while ((m = WIN_USER_PATH_RE.exec(line)) !== null) {
      const userSeg = m[2];
      const matchesCurrentUser = normUser.length >= 3 && userSeg.toLowerCase() === normUser;
      if (matchesCurrentUser) {
        findings.push({
          severity: 'error',
          category: 'privacy',
          ruleId: 'machine_user_path',
          file: relPath,
          line: lineNum,
          message: `Current OS username leaked in Windows path: ${m[1]}${userSeg}`,
        });
      } else if (!isTestFile && !isRegexLine && !isPlaceholderUser(userSeg)) {
        findings.push({
          severity: 'error',
          category: 'privacy',
          ruleId: 'abs_home_path',
          file: relPath,
          line: lineNum,
          message: `Absolute Windows user path detected: ${m[1]}${userSeg}`,
        });
      }
    }

    // 2. Unix absolute home paths: /Users/<name> or /home/<name>
    UNIX_HOME_PATH_RE.lastIndex = 0;
    while ((m = UNIX_HOME_PATH_RE.exec(line)) !== null) {
      const userSeg = m[2];
      const matchesCurrentUser = normUser.length >= 3 && userSeg.toLowerCase() === normUser;
      if (matchesCurrentUser) {
        findings.push({
          severity: 'error',
          category: 'privacy',
          ruleId: 'machine_user_path',
          file: relPath,
          line: lineNum,
          message: `Current OS username leaked in home path: ${m[1]}${userSeg}`,
        });
      } else if (!isTestFile && !isRegexLine && !isPlaceholderUser(userSeg)) {
        findings.push({
          severity: 'error',
          category: 'privacy',
          ruleId: 'abs_home_path',
          file: relPath,
          line: lineNum,
          message: `Absolute Unix home path detected: ${m[1]}${userSeg}`,
        });
      }
    }

    // 3. Machine hostname in non-test config/docs
    if (checkHost && !isTestFile) {
      const hostIdx = line.toLowerCase().indexOf(normHost);
      if (hostIdx !== -1) {
        const prev = hostIdx > 0 ? line[hostIdx - 1] : ' ';
        const next = line[hostIdx + normHost.length] || ' ';
        if (!/[a-z0-9_-]/i.test(prev) && !/[a-z0-9_-]/i.test(next)) {
          findings.push({
            severity: 'warn',
            category: 'privacy',
            ruleId: 'machine_hostname',
            file: relPath,
            line: lineNum,
            message: `Local machine hostname detected ("${currentHostname}")`,
          });
        }
      }
    }

    // 4. Private LAN IPs in non-test files (skip loopback 127.0.0.1 and RFC 5737 doc ranges)
    if (!isTestFile && !isRegexLine) {
      LAN_IP_RE.lastIndex = 0;
      while ((m = LAN_IP_RE.exec(line)) !== null) {
        findings.push({
          severity: 'warn',
          category: 'privacy',
          ruleId: 'lan_ip',
          file: relPath,
          line: lineNum,
          message: `Private LAN IP address detected: ${m[0]}`,
        });
      }
    }
  }
  return findings;
}

/**
 * Scans text for unredacted API keys, GitHub tokens, AWS keys, and private key blocks.
 */
export function scanTextForSecrets(text, relPath) {
  const findings = [];
  const lines = String(text || '').split(/\r?\n/);
  const isTestFile = isTestOrFixtureFile(relPath);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line || line.length > 4000) continue;
    if (looksLikeRegexLiteralLine(line)) continue;
    for (const rule of SECRET_RULES) {
      rule.re.lastIndex = 0;
      let m;
      while ((m = rule.re.exec(line)) !== null) {
        const hit = m[0];
        if (isMaskedOrPlaceholderToken(hit)) continue;
        // Skip synthetic test fixtures only if explicitly marked as fake/mock on the same line
        if (isTestFile && /(?:mock|fake|fixture|dummy|test_token|synthetic)/i.test(line)) continue;
        const preview = hit.length > 12 ? `${hit.slice(0, 6)}...${hit.slice(-4)}` : '***';
        findings.push({
          severity: 'error',
          category: 'privacy',
          ruleId: `secret_${rule.id}`,
          file: relPath,
          line: i + 1,
          message: `Potential ${rule.label} exposed (${preview})`,
        });
      }
    }
  }
  return findings;
}

/**
 * Validates relative Markdown links in README.md / CHANGELOG.md exist on disk.
 */
export function checkMarkdownLinks(text, relPath, rootDir) {
  const findings = [];
  const baseDir = path.dirname(path.join(rootDir, relPath));
  const lines = String(text || '').split(/\r?\n/);
  let inFence = false;
  const linkRe = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    linkRe.lastIndex = 0;
    let m;
    while ((m = linkRe.exec(line)) !== null) {
      const target = m[1].trim();
      if (
        !target
        || target.startsWith('#')
        || /^[a-z][a-z0-9+.-]*:/i.test(target)
        || target.startsWith('//')
      ) {
        continue;
      }
      const cleanPath = decodeURIComponent(target.split('#')[0].split('?')[0]);
      if (!cleanPath) continue;
      const absTarget = path.resolve(baseDir, cleanPath);
      if (!fs.existsSync(absTarget)) {
        findings.push({
          severity: 'warn',
          category: 'docs',
          ruleId: 'broken_md_link',
          file: relPath,
          line: i + 1,
          message: `Broken relative Markdown link: "${target}"`,
        });
      }
    }
  }
  return findings;
}

/**
 * Checks template hygiene for Antigravity plugin router-state.json when present.
 */
function checkRouterStateTemplate(rootDir) {
  const findings = [];
  const pluginPath = path.join(rootDir, 'plugin.json');
  const statePath = path.join(rootDir, 'router-state.json');
  if (!fs.existsSync(pluginPath) || !fs.existsSync(statePath)) return findings;

  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (state.hardwareProfiled === true) {
      findings.push({
        severity: 'error',
        category: 'privacy',
        ruleId: 'dirty_router_state',
        file: 'router-state.json',
        line: 1,
        message: 'Template router-state.json has hardwareProfiled=true (personal machine state leaked)',
      });
    }
    if (state.onboardingCompleted === true) {
      findings.push({
        severity: 'error',
        category: 'privacy',
        ruleId: 'dirty_router_state',
        file: 'router-state.json',
        line: 1,
        message: 'Template router-state.json has onboardingCompleted=true (should be false in repo template)',
      });
    }
    if (typeof state.gpuModelsDir === 'string' && state.gpuModelsDir.trim() !== '') {
      findings.push({
        severity: 'error',
        category: 'privacy',
        ruleId: 'dirty_router_state',
        file: 'router-state.json',
        line: 1,
        message: `Template router-state.json has non-empty gpuModelsDir ("${state.gpuModelsDir}")`,
      });
    }
    if (state.gpuEnabled === true) {
      findings.push({
        severity: 'warn',
        category: 'privacy',
        ruleId: 'router_state_gpu_enabled',
        file: 'router-state.json',
        line: 1,
        message: 'Template router-state.json has gpuEnabled=true (defaults should be portable)',
      });
    }
  } catch (err) {
    findings.push({
      severity: 'error',
      category: 'metadata',
      ruleId: 'invalid_json',
      file: 'router-state.json',
      line: 1,
      message: `Invalid JSON in router-state.json: ${err.message}`,
    });
  }
  return findings;
}

/**
 * Verifies version parity, docs counts, release manifests, and Markdown links.
 */
export function checkVersionAndDocsParity(rootDir) {
  const findings = [];
  const meta = {
    packageVersion: null,
    pluginVersion: null,
    skillsCount: 0,
    testsCount: 0,
  };

  const pkgPath = path.join(rootDir, 'package.json');
  const pluginPath = path.join(rootDir, 'plugin.json');
  const readmePath = path.join(rootDir, 'README.md');
  const changelogPath = path.join(rootDir, 'CHANGELOG.md');
  const bannerPath = path.join(rootDir, 'assets', 'banner.svg');

  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (typeof pkg.version === 'string') meta.packageVersion = pkg.version.trim();
    } catch (err) {
      findings.push({
        severity: 'error',
        category: 'metadata',
        ruleId: 'invalid_json',
        file: 'package.json',
        line: 1,
        message: `Invalid JSON in package.json: ${err.message}`,
      });
    }
  }

  if (fs.existsSync(pluginPath)) {
    try {
      const plugin = JSON.parse(fs.readFileSync(pluginPath, 'utf8'));
      if (typeof plugin.version === 'string') meta.pluginVersion = plugin.version.trim();
    } catch (err) {
      findings.push({
        severity: 'error',
        category: 'metadata',
        ruleId: 'invalid_json',
        file: 'plugin.json',
        line: 1,
        message: `Invalid JSON in plugin.json: ${err.message}`,
      });
    }
  }

  const canonicalVersion = meta.packageVersion || meta.pluginVersion;

  if (meta.packageVersion && meta.pluginVersion && meta.packageVersion !== meta.pluginVersion) {
    findings.push({
      severity: 'error',
      category: 'metadata',
      ruleId: 'version_mismatch',
      file: 'plugin.json',
      line: 1,
      message: `Version mismatch: package.json=${meta.packageVersion} vs plugin.json=${meta.pluginVersion}`,
    });
  }

  // Count actual skills and test suites if directories exist
  const skillsDir = path.join(rootDir, 'skills');
  if (fs.existsSync(skillsDir)) {
    try {
      meta.skillsCount = fs.readdirSync(skillsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && fs.existsSync(path.join(skillsDir, d.name, 'SKILL.md')))
        .length;
    } catch {}
  }

  const testsDir = path.join(rootDir, 'tests');
  if (fs.existsSync(testsDir)) {
    try {
      meta.testsCount = fs.readdirSync(testsDir, { withFileTypes: true })
        .filter((d) => d.isFile() && /\.test\.[cm]?js$/.test(d.name))
        .length;
    } catch {}
  }

  if (fs.existsSync(readmePath)) {
    const readme = fs.readFileSync(readmePath, 'utf8');
    findings.push(...checkMarkdownLinks(readme, 'README.md', rootDir));

    if (canonicalVersion) {
      const headerMatch = /^#\s+[^\n]*?\bv(\d+\.\d+\.\d+)\b/m.exec(readme);
      if (headerMatch && headerMatch[1] !== canonicalVersion) {
        findings.push({
          severity: 'error',
          category: 'docs',
          ruleId: 'readme_version_mismatch',
          file: 'README.md',
          line: 1,
          message: `README.md title version v${headerMatch[1]} does not match v${canonicalVersion}`,
        });
      }
      const setupMatch = /Setup\.exe|(\bv\d+\.\d+\.\d+\.zip\b)/i.test(readme)
        ? /The-Tunnel-v(\d+\.\d+\.\d+)(?:-Setup\.exe|\.zip)/g
        : null;
      if (setupMatch) {
        let m;
        while ((m = setupMatch.exec(readme)) !== null) {
          if (m[1] !== canonicalVersion) {
            findings.push({
              severity: 'warn',
              category: 'docs',
              ruleId: 'readme_installer_version_mismatch',
              file: 'README.md',
              line: 1,
              message: `README.md installer reference v${m[1]} differs from v${canonicalVersion}`,
            });
            break;
          }
        }
      }
    }

    if (meta.skillsCount > 0) {
      const skillCountMatch = /\b(\d+)\s+built-in(?:\s+specialized|\s+domain)?\s+skills\b/i.exec(readme);
      if (skillCountMatch && Number(skillCountMatch[1]) !== meta.skillsCount) {
        findings.push({
          severity: 'warn',
          category: 'docs',
          ruleId: 'readme_count_mismatch',
          file: 'README.md',
          line: 1,
          message: `README.md says ${skillCountMatch[1]} built-in skills, but skills/ has ${meta.skillsCount}`,
        });
      }
    }

    if (meta.testsCount > 0) {
      const testCountMatch = /\b(\d+)\s+automated\s+test\s+suites\b/i.exec(readme);
      if (testCountMatch && Number(testCountMatch[1]) !== meta.testsCount) {
        findings.push({
          severity: 'warn',
          category: 'docs',
          ruleId: 'readme_count_mismatch',
          file: 'README.md',
          line: 1,
          message: `README.md says ${testCountMatch[1]} automated test suites, but tests/ has ${meta.testsCount}`,
        });
      }
    }
  }

  if (fs.existsSync(changelogPath) && canonicalVersion) {
    const changelog = fs.readFileSync(changelogPath, 'utf8');
    findings.push(...checkMarkdownLinks(changelog, 'CHANGELOG.md', rootDir));
    const escaped = canonicalVersion.replace(/\./g, '\\.');
    const hasSection = new RegExp(`^##\\s+\\[?v?${escaped}\\]?\\b`, 'm').test(changelog);
    if (!hasSection) {
      findings.push({
        severity: 'warn',
        category: 'docs',
        ruleId: 'changelog_version_missing',
        file: 'CHANGELOG.md',
        line: 1,
        message: `CHANGELOG.md has no section for version ${canonicalVersion}`,
      });
    }
  }

  if (fs.existsSync(bannerPath) && canonicalVersion) {
    const svg = fs.readFileSync(bannerPath, 'utf8');
    const verMatches = svg.match(/\bv\d+\.\d+\.\d+\b/g) || [];
    if (verMatches.length > 0 && !verMatches.includes(`v${canonicalVersion}`)) {
      findings.push({
        severity: 'warn',
        category: 'docs',
        ruleId: 'banner_version_mismatch',
        file: 'assets/banner.svg',
        line: 1,
        message: `assets/banner.svg lists ${verMatches[0]} instead of v${canonicalVersion}`,
      });
    }
  }

  return { findings, meta };
}

/**
 * Optional remote check against origin branch and GitHub Releases via git/gh.
 */
function checkRemoteSync(rootDir, canonicalVersion) {
  const findings = [];
  const remoteInfo = {
    originUrl: null,
    ahead: 0,
    behind: 0,
    uncommittedCount: 0,
    latestReleaseTag: null,
  };

  const originRes = runCmdSafe('git', ['remote', 'get-url', 'origin'], rootDir);
  if (originRes.ok) {
    remoteInfo.originUrl = originRes.stdout;
  } else {
    findings.push({
      severity: 'warn',
      category: 'remote',
      ruleId: 'no_git_origin',
      file: '.git/config',
      line: 1,
      message: 'No git "origin" remote configured',
    });
    return { findings, remoteInfo };
  }

  const statusRes = runCmdSafe('git', ['status', '--porcelain'], rootDir);
  if (statusRes.ok && statusRes.stdout) {
    const lines = statusRes.stdout.split(/\r?\n/).filter(Boolean);
    remoteInfo.uncommittedCount = lines.length;
    findings.push({
      severity: 'warn',
      category: 'remote',
      ruleId: 'uncommitted_changes',
      file: '.',
      line: 1,
      message: `${lines.length} uncommitted file(s) in working tree`,
    });
  }

  const abRes = runCmdSafe('git', ['rev-list', '--left-right', '--count', 'HEAD...@{u}'], rootDir);
  if (abRes.ok && abRes.stdout) {
    const [ahead, behind] = abRes.stdout.split(/\s+/).map(Number);
    remoteInfo.ahead = Number.isFinite(ahead) ? ahead : 0;
    remoteInfo.behind = Number.isFinite(behind) ? behind : 0;
    if (remoteInfo.behind > 0) {
      findings.push({
        severity: 'warn',
        category: 'remote',
        ruleId: 'branch_behind_remote',
        file: '.',
        line: 1,
        message: `Local branch is behind upstream by ${remoteInfo.behind} commit(s)`,
      });
    }
    if (remoteInfo.ahead > 0) {
      findings.push({
        severity: 'warn',
        category: 'remote',
        ruleId: 'branch_ahead_remote',
        file: '.',
        line: 1,
        message: `Local branch is ahead of upstream by ${remoteInfo.ahead} unpushed commit(s)`,
      });
    }
  }

  const ghRes = runCmdSafe('gh', ['release', 'list', '--limit', '1', '--json', 'tagName'], rootDir, 10000);
  if (ghRes.ok && ghRes.stdout) {
    try {
      const arr = JSON.parse(ghRes.stdout);
      if (Array.isArray(arr) && arr[0]?.tagName) {
        remoteInfo.latestReleaseTag = arr[0].tagName;
        if (canonicalVersion && arr[0].tagName !== `v${canonicalVersion}`) {
          findings.push({
            severity: 'warn',
            category: 'remote',
            ruleId: 'github_release_version_drift',
            file: 'package.json',
            line: 1,
            message: `Latest GitHub Release is ${arr[0].tagName}, while local version is v${canonicalVersion}`,
          });
        }
      }
    } catch {}
  }

  return { findings, remoteInfo };
}

/**
 * Main entry point: runs all 3 audit gates (Privacy/Fingerprints, GitHub Rules, Metadata/Docs).
 */
export function auditGithubPublish({
  rootDir = process.cwd(),
  stagedOnly = false,
  checkRemote = false,
  strict = false,
  currentUsername = '',
  currentHostname = '',
} = {}) {
  const absRoot = path.resolve(rootDir);
  let resolvedUser = currentUsername;
  if (!resolvedUser) {
    try {
      resolvedUser = os.userInfo().username || '';
    } catch {
      resolvedUser = process.env.USERNAME || process.env.USER || '';
    }
  }
  const resolvedHost = currentHostname || os.hostname() || '';

  const allFindings = [];
  const { isGit, files } = collectFilesToAudit(absRoot, stagedOnly);

  // Gate 2a: Required repository hygiene files
  if (!stagedOnly) {
    if (!fs.existsSync(path.join(absRoot, 'LICENSE')) && !fs.existsSync(path.join(absRoot, 'LICENSE.md'))) {
      allFindings.push({
        severity: 'warn',
        category: 'github_rules',
        ruleId: 'gh_missing_license',
        file: 'LICENSE',
        line: 1,
        message: 'Repository is missing a LICENSE file',
      });
    }
    if (!fs.existsSync(path.join(absRoot, '.gitignore'))) {
      allFindings.push({
        severity: 'warn',
        category: 'github_rules',
        ruleId: 'gh_missing_gitignore',
        file: '.gitignore',
        line: 1,
        message: 'Repository is missing a .gitignore file',
      });
    }
    if (!fs.existsSync(path.join(absRoot, 'README.md'))) {
      allFindings.push({
        severity: 'warn',
        category: 'docs',
        ruleId: 'gh_missing_readme',
        file: 'README.md',
        line: 1,
        message: 'Repository is missing a README.md file',
      });
    }
  }

  let scannedFiles = 0;
  for (const relPath of files) {
    const absPath = path.join(absRoot, relPath);
    if (!fs.existsSync(absPath)) continue;
    let stat;
    try {
      stat = fs.lstatSync(absPath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    scannedFiles += 1;

    const base = path.basename(relPath);
    const ext = path.extname(relPath).toLowerCase();

    // Gate 2b: GitHub blob size limits
    if (stat.size > GH_MAX_BYTES) {
      allFindings.push({
        severity: 'error',
        category: 'github_rules',
        ruleId: 'gh_file_over_100mb',
        file: relPath,
        line: 1,
        message: `File exceeds GitHub 100 MB hard limit (${(stat.size / MB).toFixed(1)} MB)`,
      });
    } else if (stat.size > GH_WARN_BYTES) {
      allFindings.push({
        severity: 'warn',
        category: 'github_rules',
        ruleId: 'gh_file_over_50mb',
        file: relPath,
        line: 1,
        message: `File exceeds GitHub 50 MB recommended limit (${(stat.size / MB).toFixed(1)} MB)`,
      });
    }

    // Gate 2c: Forbidden tracked secret/cache/junk files
    if (!ALLOWED_ENV_EXAMPLES.test(base) && FORBIDDEN_SECRET_FILES.some((re) => re.test(base))) {
      allFindings.push({
        severity: 'error',
        category: 'github_rules',
        ruleId: 'gh_forbidden_secret_file',
        file: relPath,
        line: 1,
        message: `Sensitive/secret file should not be published to GitHub: ${relPath}`,
      });
    }
    if (FORBIDDEN_CACHE_PREFIXES.some((prefix) => relPath.startsWith(prefix))) {
      allFindings.push({
        severity: 'error',
        category: 'github_rules',
        ruleId: 'gh_forbidden_cache_dir',
        file: relPath,
        line: 1,
        message: `Build/cache/dependency artifact should not be tracked in Git: ${relPath}`,
      });
    }
    if (JUNK_BASENAMES.has(base)) {
      allFindings.push({
        severity: 'warn',
        category: 'github_rules',
        ruleId: 'gh_os_junk_file',
        file: relPath,
        line: 1,
        message: `OS metadata junk file tracked in repo: ${relPath}`,
      });
    }

    // Gate 1: Text content scan for fingerprints & secrets
    if (BINARY_EXTS.has(ext) || stat.size > MAX_TEXT_SCAN_BYTES) continue;
    let text = '';
    try {
      const buf = fs.readFileSync(absPath);
      if (buf.includes(0)) continue; // skip binary content
      text = buf.toString('utf8');
    } catch {
      continue;
    }

    allFindings.push(
      ...scanTextForFingerprints(text, relPath, {
        currentUsername: resolvedUser,
        currentHostname: resolvedHost,
      }),
    );
    allFindings.push(...scanTextForSecrets(text, relPath));
  }

  // Gate 1b: Antigravity plugin template hygiene
  allFindings.push(...checkRouterStateTemplate(absRoot));

  // Gate 3: Metadata & documentation parity
  const { findings: docsFindings, meta } = checkVersionAndDocsParity(absRoot);
  allFindings.push(...docsFindings);

  // Optional Gate 3b: Remote GitHub sync
  let remoteInfo = null;
  if (checkRemote && isGit) {
    const remoteRes = checkRemoteSync(absRoot, meta.packageVersion || meta.pluginVersion);
    allFindings.push(...remoteRes.findings);
    remoteInfo = remoteRes.remoteInfo;
  }

  const errors = allFindings.filter((f) => f.severity === 'error');
  const warnings = allFindings.filter((f) => f.severity === 'warn');
  const score = Math.max(0, 100 - errors.length * 25 - warnings.length * 5);
  const grade = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : 'F';
  const ok = strict ? (errors.length === 0 && warnings.length === 0) : errors.length === 0;

  return {
    ok,
    grade,
    score,
    strict,
    rootDir: absRoot,
    scannedFiles,
    errorsCount: errors.length,
    warningsCount: warnings.length,
    errors,
    warnings,
    metadata: meta,
    remote: remoteInfo,
  };
}

export function formatAuditReport(result) {
  const lines = [];
  const badge = result.ok ? 'PASS' : 'BLOCKED';
  lines.push(
    `[GitHub Publish Guard] ${badge} | Grade ${result.grade} (${result.score}/100) | Files: ${result.scannedFiles} | Errors: ${result.errorsCount} | Warnings: ${result.warningsCount}`,
  );
  if (result.metadata?.packageVersion) {
    lines.push(
      `  Metadata: v${result.metadata.packageVersion}${result.metadata.pluginVersion ? ` (plugin: v${result.metadata.pluginVersion})` : ''} | skills: ${result.metadata.skillsCount} | tests: ${result.metadata.testsCount}`,
    );
  }
  if (result.remote) {
    lines.push(
      `  Remote: ahead=${result.remote.ahead}, behind=${result.remote.behind}, uncommitted=${result.remote.uncommittedCount}, latestRelease=${result.remote.latestReleaseTag || 'none'}`,
    );
  }
  for (const err of result.errors) {
    lines.push(`  [ERROR ${err.ruleId}] ${err.file}:${err.line} — ${err.message}`);
  }
  for (const warn of result.warnings) {
    lines.push(`  [WARN  ${warn.ruleId}] ${warn.file}:${warn.line} — ${warn.message}`);
  }
  return lines.join('\n');
}

function parseCliArgs(argv) {
  const opts = {
    rootDir: process.cwd(),
    stagedOnly: false,
    checkRemote: false,
    strict: false,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--root' && argv[i + 1]) {
      opts.rootDir = argv[++i];
    } else if (a === '--staged') {
      opts.stagedOnly = true;
    } else if (a === '--remote') {
      opts.checkRemote = true;
    } else if (a === '--strict') {
      opts.strict = true;
    } else if (a === '--json') {
      opts.json = true;
    } else if (a === '--help' || a === '-h') {
      opts.help = true;
    }
  }
  return opts;
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);
if (isDirectRun) {
  const opts = parseCliArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('Usage: node audit-github-publish.mjs [--root <dir>] [--staged] [--remote] [--strict] [--json]');
    process.exit(0);
  }
  const result = auditGithubPublish(opts);
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatAuditReport(result));
  }
  process.exit(result.ok ? 0 : 1);
}

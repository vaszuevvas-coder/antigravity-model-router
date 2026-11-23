#!/usr/bin/env node
/**
 * Синхронная проверка и обновление версии в package.json и plugin.json.
 * Использование:
 *   node scripts/bump-version.mjs --check
 *   node scripts/bump-version.mjs patch|minor|major|<x.y.z> [--dry-run] [--json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_REPO_ROOT = path.resolve(__dirname, '..');

const SEMVER_CORE_RE = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/;
const SEMVER_PRERELEASE_PART_RE = /^[0-9A-Za-z-]+$/;

/**
 * Parses and validates a SemVer string (with optional leading `v`).
 * @param {string} raw
 * @returns {{ major: number, minor: number, patch: number, prerelease: string, version: string }}
 */
export function parseSemver(raw) {
  const str = String(raw ?? '').trim();
  const match = SEMVER_CORE_RE.exec(str);
  if (!match) {
    throw new Error(`Некорректная SemVer-версия: "${str}" (ожидается формат X.Y.Z или X.Y.Z-tag)`);
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  const prerelease = match[4] || '';
  if (prerelease) {
    const parts = prerelease.split('.');
    if (!parts.every((part) => part.length > 0 && SEMVER_PRERELEASE_PART_RE.test(part))) {
      throw new Error(`Некорректная SemVer-версия: "${str}" (ожидается формат X.Y.Z или X.Y.Z-tag)`);
    }
  }
  const version = prerelease ? `${major}.${minor}.${patch}-${prerelease}` : `${major}.${minor}.${patch}`;
  return { major, minor, patch, prerelease, version };
}

/**
 * Computes the next SemVer version from a bump keyword or explicit version string.
 * @param {string} currentVersion
 * @param {string} target
 * @returns {string}
 */
export function computeNextVersion(currentVersion, target) {
  const cur = parseSemver(currentVersion);
  const cmd = String(target ?? '').trim();
  if (cmd === 'patch') return `${cur.major}.${cur.minor}.${cur.patch + 1}`;
  if (cmd === 'minor') return `${cur.major}.${cur.minor + 1}.0`;
  if (cmd === 'major') return `${cur.major + 1}.0.0`;
  return parseSemver(cmd).version;
}

function readJsonObject(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Файл не найден: ${label} (${filePath})`);
  }
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Некорректный JSON-объект в ${label}`);
  }
  return parsed;
}

/**
 * Optional companion-file version synchronization rules (runs only when files exist).
 * Keeps model names (e.g. `Flash 3.8`) and auth headers intact.
 */
const PANEL_UI_VERSION_PATTERNS = [
  [/(<title>[^<]*?The Tunnel[^<]*?\bv)\d+\.\d+(?:\.\d+)?([^<]*<\/title>)/, (v) => `$1${v}$2`],
  [/(The Tunnel\s*·\s*Мастер\s+v)\d+\.\d+(?:\.\d+)?/g, (v) => `$1${v}`],
  [/(The Tunnel(?:\s*·\s*Liquid Glass)?\s+v)\d+\.\d+(?:\.\d+)?/g, (v) => `$1${v}`],
  [/(Обновлён режим The Tunnel\s+v)\d+\.\d+(?:\.\d+)?(:)/g, (v) => `$1${v}$2`],
];

const COMPANION_VERSION_RULES = [
  {
    rel: 'sidecars/panel/ui.html',
    patterns: PANEL_UI_VERSION_PATTERNS,
  },
  {
    rel: 'sidecars/panel/ui-src/head-body.html',
    patterns: PANEL_UI_VERSION_PATTERNS,
  },
  {
    rel: 'sidecars/panel/ui-src/js/01-workspace-wizard.js',
    patterns: PANEL_UI_VERSION_PATTERNS,
  },
  {
    rel: 'sidecars/panel/server.mjs',
    patterns: [
      [/(function getPluginVersion\(\)[\s\S]*?return\s+')\d+\.\d+(?:\.\d+)?(')/, (v) => `$1${v}$2`],
    ],
  },
  {
    rel: 'sidecars/panel/sidecar.json',
    patterns: [[/(пульт управления(?:\s+Liquid Glass)?\s+v)\d+\.\d+(?:\.\d+)?/, (v) => `$1${v}`]],
  },
  {
    rel: 'Установить плагин.bat',
    patterns: [[/^(title\s+Установка\s+The Tunnel\s+v)\d+\.\d+(?:\.\d+)?/m, (v) => `$1${v}`]],
  },
  {
    rel: 'core/hook-runner.mjs',
    patterns: [
      [/(# The Tunnel\s+v)\d+\.\d+(?:\.\d+)?/g, (v) => `$1${v}`],
      [/(['`]Автопилот\s+v)\d+\.\d+(?:\.\d+)?/g, (v) => `$1${v}`],
      [/(Когнитивный ИИ-Автопилот\s+v)\d+\.\d+(?:\.\d+)?/, (v) => `$1${v}`],
    ],
  },
  {
    rel: 'core/ag-cli.mjs',
    patterns: [
      [
        /^║(  🚀 THE TUNNEL v)\d+\.\d+(?:\.\d+)?( — GEMINI 4 \+ 12GB RAM \+ LOCAL GPU CLI)\s*║$/m,
        (v) => (_m, p1, p2) => '║' + `${p1}${v}${p2}`.padEnd(76, ' ') + '║',
      ],
    ],
  },
  {
    rel: 'core/router-cli.mjs',
    patterns: [
      [/(@description Единый интерфейс командной строки \(CLI\) для The Tunnel\s+v)\d+\.\d+(?:\.\d+)?(\.)/, (v) => `$1${v}$2`],
      [/(pluginMeta\?\.version \|\|\s*')\d+\.\d+(?:\.\d+)?(')/g, (v) => `$1${v}$2`],
    ],
  },
  {
    rel: 'core/task-progress.mjs',
    patterns: [[/(^\s*version:\s*')\d+\.\d+(?:\.\d+)?(',)/m, (v) => `$1${v}$2`]],
  },
  {
    rel: 'core/tool-pruner.mjs',
    patterns: [[/(3D Cognitive Router\s+v)\d+\.\d+(?:\.\d+)?/, (v) => `$1${v}`]],
  },
  {
    rel: 'install.js',
    patterns: [
      [/(srcManifest\?\.version \? String\(srcManifest\.version\) :\s*')\d+\.\d+(?:\.\d+)?(')/, (v) => `$1${v}$2`],
      [/(The Tunnel\s+v)\d+\.\d+(?:\.\d+)?(:)/g, (v) => `$1${v}$2`],
    ],
  },
  {
    rel: 'scripts/pack-release.mjs',
    patterns: [[/(String\((?:pluginJson\.version \|\| pkgJson\.version \|\| |version \|\| )')\d+\.\d+(?:\.\d+)?(')/g, (v) => `$1${v}$2`]],
  },
  {
    rel: 'rules/AGENTS.md',
    patterns: [
      [/^(# The Tunnel\s+v)\d+\.\d+(?:\.\d+)?/m, (v) => `$1${v}`],
      [/^(## 3\. Cache Hygiene & Guardrails \(v)\d+\.\d+(?:\.\d+)?(\))/m, (v) => `$1${v}$2`],
    ],
  },
  {
    rel: 'agents/router-verifier.md',
    patterns: [[/((?:для|in) The Tunnel\s+v)\d+\.\d+(?:\.\d+)?(\.)/, (v) => `$1${v}$2`]],
  },
  {
    rel: 'skills/model-router/SKILL.md',
    patterns: [
      [/((?:Стратегия маршрутизации моделей|Control protocol for) The Tunnel\s+v)\d+\.\d+(?:\.\d+)?/, (v) => `$1${v}`],
      [/^(# The Tunnel\s+v)\d+\.\d+(?:\.\d+)?/m, (v) => `$1${v}`],
      [/(^\s*-\s*\*\*v)\d+\.\d+(?:\.\d+)?(\s+3D Task Tensor)/m, (v) => `$1${v}$2`],
      [/(## 2\. (?:Autopilot Guardrails|Guardrails & Coprocessors) \(v2\.0 -> v)\d+\.\d+(?:\.\d+)?(\))/m, (v) => `$1${v}$2`],
      [/(3\. \*\*v3\.0–v)\d+\.\d+(?:\.\d+)?(\s+SOTA\*\*:)/m, (v) => `$1${v}$2`],
    ],
  },
  {
    rel: 'skills/context-fork/SKILL.md',
    patterns: [
      [/((?:Протоколы экономии токенов и оркестрации|protocol for) The Tunnel\s+v)\d+\.\d+(?:\.\d+)?/, (v) => `$1${v}`],
      [/^(# Context Fork & Token Economy(?: Runbook)? \(v)\d+\.\d+(?:\.\d+)?/m, (v) => `$1${v}`],
    ],
  },
  {
    rel: 'README.md',
    patterns: [
      [/^(# The Tunnel\s+`v)\d+\.\d+(?:\.\d+)?(`)/m, (v) => `$1${v}$2`],
      [/^(## Ключевые возможности\s+v)\d+\.\d+(?:\.\d+)?/m, (v) => `$1${v}`],
      [/(Пульт(?: управления)?(?:\s+The Tunnel(?:\s*·)?)?(?:\s+Liquid Glass)?\s+`?v)\d+\.\d+(?:\.\d+)?(`?)/g, (v) => `$1${v}$2`],
      [/(Манифест плагина The Tunnel \(v)\d+\.\d+(?:\.\d+)?(\))/, (v) => `$1${v}$2`],
      [/(Plugin manifest \(The Tunnel v)\d+\.\d+(?:\.\d+)?(\))/, (v) => `$1${v}$2`],
      [/(alt="The Tunnel v)\d+\.\d+(?:\.\d+)?(\s+—)/, (v) => `$1${v}$2`],
      [/(Полная история изменений \(v1\.0\.0 — v)\d+\.\d+(?:\.\d+)?(\))/, (v) => `$1${v}$2`],
      [/(The-Tunnel-v)\d+\.\d+(?:\.\d+)?(-Setup\.exe|\.zip)/g, (v) => `$1${v}$2`],
    ],
  },
  {
    rel: 'assets/banner.svg',
    patterns: [
      [/(Диспетчер моделей ИИ \((?:Liquid Glass\s+)?v)\d+\.\d+(?:\.\d+)?(\))/g, (v) => `$1${v}$2`],
      [/(панели The Tunnel \((?:Liquid Glass\s+)?v)\d+\.\d+(?:\.\d+)?(\))/g, (v) => `$1${v}$2`],
      [/(THE TUNNEL\s+·\s+v)\d+\.\d+(?:\.\d+)?/g, (v) => `$1${v}`],
      [/(<tspan fill="#38bdf8">v)\d+\.\d+(?:\.\d+)?(<\/tspan>)/g, (v) => `$1${v}$2`],
    ],
  },
  {
    rel: 'scripts/benchmark-token-roi.mjs',
    patterns: [[/(\breturn\s+')\d+\.\d+(?:\.\d+)?(';)/, (v) => `$1${v}$2`]],
  },
];

function syncCompanionVersionFiles(root, nextVersion, dryRun = false) {
  const touched = [];
  for (const spec of COMPANION_VERSION_RULES) {
    const absPath = path.join(root, spec.rel);
    if (!fs.existsSync(absPath)) continue;
    const orig = fs.readFileSync(absPath, 'utf8');
    let next = orig;
    for (const [re, repl] of spec.patterns) {
      const replacement = repl(nextVersion);
      next = next.replace(re, replacement);
    }
    if (next !== orig) {
      if (!dryRun) {
        fs.writeFileSync(absPath, next, 'utf8');
      }
      touched.push(spec.rel);
    }
  }
  return touched;
}

/**
 * Checks or synchronously updates `version` across package.json, plugin.json, and existing companion files.
 * @param {{ repoRoot?: string, target?: string, dryRun?: boolean }} [options]
 */
export function syncVersionFiles({ repoRoot = DEFAULT_REPO_ROOT, target = 'check', dryRun = false } = {}) {
  const root = path.resolve(repoRoot);
  const pkgPath = path.join(root, 'package.json');
  const pluginPath = path.join(root, 'plugin.json');

  const pkgJson = readJsonObject(pkgPath, 'package.json');
  const pluginJson = readJsonObject(pluginPath, 'plugin.json');

  const pkgVersion = parseSemver(pkgJson.version).version;
  const pluginVersion = parseSemver(pluginJson.version).version;
  const inSync = pkgVersion === pluginVersion;

  const normalizedTarget = String(target || 'check').trim();
  if (normalizedTarget === 'check') {
    return {
      ok: inSync,
      action: 'check',
      inSync,
      packageVersion: pkgVersion,
      pluginVersion,
      version: inSync ? pkgVersion : '',
    };
  }

  const isRelativeBump = normalizedTarget === 'patch' || normalizedTarget === 'minor' || normalizedTarget === 'major';
  if (isRelativeBump && !inSync) {
    throw new Error(
      `Рассинхрон версий (package.json=${pkgVersion}, plugin.json=${pluginVersion}). Укажите явную версию X.Y.Z для синхронизации.`
    );
  }

  const nextVersion = computeNextVersion(pkgVersion, normalizedTarget);
  const updatedFiles = ['package.json', 'plugin.json'];
  if (!dryRun) {
    pkgJson.version = nextVersion;
    if (typeof pkgJson.description === 'string') {
      pkgJson.description = pkgJson.description.replace(/(диспетчер моделей(?: ИИ)?\s+)v\d+\.\d+(?:\.\d+)?/, `$1v${nextVersion}`);
    }
    pluginJson.version = nextVersion;
    if (typeof pluginJson.description === 'string') {
      pluginJson.description = pluginJson.description.replace(/(The Tunnel\s+)v\d+\.\d+(?:\.\d+)?/, `$1v${nextVersion}`);
    }
    fs.writeFileSync(pkgPath, JSON.stringify(pkgJson, null, 2) + '\n', 'utf8');
    fs.writeFileSync(pluginPath, JSON.stringify(pluginJson, null, 2) + '\n', 'utf8');
  }
  const companionTouched = syncCompanionVersionFiles(root, nextVersion, dryRun);
  updatedFiles.push(...companionTouched);

  return {
    ok: true,
    action: 'bump',
    inSync: true,
    previousPackageVersion: pkgVersion,
    previousPluginVersion: pluginVersion,
    version: nextVersion,
    updatedFiles,
    dryRun: Boolean(dryRun),
  };
}

/**
 * Parses CLI arguments for bump-version.mjs.
 * @param {string[]} [argv]
 */
export function parseVersionCliArgs(argv = process.argv.slice(2)) {
  const opts = {
    target: '',
    check: false,
    dryRun: false,
    json: false,
    help: false,
  };

  for (const rawArg of argv) {
    const arg = String(rawArg || '').trim();
    if (!arg) continue;
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--check') {
      opts.check = true;
    } else if (arg === '--dry-run') {
      opts.dryRun = true;
    } else if (arg === '--json') {
      opts.json = true;
    } else if (arg.startsWith('-')) {
      throw new Error(`Неизвестный флаг: ${arg}`);
    } else if (opts.target) {
      throw new Error(`Лишний аргумент: ${arg} (уже задана цель "${opts.target}")`);
    } else {
      opts.target = arg;
    }
  }

  if (opts.check && opts.target) {
    throw new Error('Нельзя одновременно указывать --check и новую версию');
  }
  if (!opts.target) {
    opts.target = 'check';
  }
  return opts;
}

function printHelp() {
  console.log(
    [
      'Использование:',
      '  node scripts/bump-version.mjs [--check] [--json]',
      '  node scripts/bump-version.mjs <patch|minor|major|X.Y.Z> [--dry-run] [--json]',
    ].join('\n')
  );
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  const self = path.resolve(__filename);
  const arg = path.resolve(process.argv[1]);
  return process.platform === 'win32' ? self.toLowerCase() === arg.toLowerCase() : self === arg;
})();

if (isMain) {
  let cli;
  try {
    cli = parseVersionCliArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`Ошибка аргументов: ${err.message}`);
    process.exit(1);
  }

  if (cli.help) {
    printHelp();
    process.exit(0);
  }

  try {
    const res = syncVersionFiles({
      repoRoot: DEFAULT_REPO_ROOT,
      target: cli.target,
      dryRun: cli.dryRun,
    });
    if (cli.json) {
      console.log(JSON.stringify(res, null, 2));
    } else if (res.action === 'check') {
      if (res.inSync) {
        console.log(`Версии синхронизированы: ${res.version} (package.json + plugin.json)`);
      } else {
        console.error(`Рассинхрон версий: package.json=${res.packageVersion}, plugin.json=${res.pluginVersion}`);
      }
    } else {
      const prefix = res.dryRun ? '[dry-run] ' : '';
      console.log(
        `${prefix}Версия обновлена: ${res.previousPackageVersion} -> ${res.version} (${res.updatedFiles.join(', ')})`
      );
    }
    if (!res.ok) process.exit(1);
  } catch (err) {
    if (cli.json) {
      console.log(JSON.stringify({ ok: false, error: err.message }, null, 2));
    } else {
      console.error(`Ошибка: ${err.message}`);
    }
    process.exit(1);
  }
}

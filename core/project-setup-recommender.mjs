/**
 * @file project-setup-recommender.mjs
 * @description Read-only stack analyzer & automation recommender (inspired by anthropics/claude-code-setup).
 * Reuses `collectAndDetectStack` in <50ms without external dependencies and suggests optimal hookProfile,
 * local skills, project hygiene artifacts, and external MCP integrations.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectAndDetectStack } from '../skills/deep-stress-auditor/scripts/lib/stack-detector.mjs';
import { normalizeLang } from './i18n.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, '..');

function resolveCliScriptPath(...segments) {
  const installedRoot = join(homedir(), '.gemini', 'config', 'plugins', 'antigravity-model-router');
  const installedCand = join(installedRoot, ...segments);
  const localCand = join(PLUGIN_ROOT, ...segments);
  const chosen = existsSync(installedCand) ? installedCand : localCand;
  return /\s/.test(chosen) ? `"${chosen}"` : chosen;
}

function readTextSafe(filePath, maxBytes = 128_000) {
  try {
    if (!filePath || !existsSync(filePath)) return '';
    return readFileSync(filePath, 'utf8').slice(0, maxBytes);
  } catch {
    return '';
  }
}

function collectDependencySignals(stackRes) {
  const deps = new Set();
  const addPkgDeps = (pkg) => {
    if (!pkg || typeof pkg !== 'object') return;
    for (const group of [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies]) {
      if (group && typeof group === 'object') {
        for (const key of Object.keys(group)) {
          deps.add(key.toLowerCase());
        }
      }
    }
  };
  addPkgDeps(stackRes?.rootPkg);
  const manifests = stackRes?.manifests || {};
  let subChecked = 0;
  for (const pkgPath of manifests.packageJsonPaths || []) {
    if (subChecked >= 25) break;
    if (stackRes?.rootDir && resolve(pkgPath) === join(stackRes.rootDir, 'package.json')) continue;
    const normPkg = String(pkgPath).replace(/\\/g, '/').toLowerCase();
    if (/\/(?:docs?|docs_src|examples?|playground|__fixtures__|test-fixtures)\//.test(normPkg)) continue;
    subChecked++;
    try {
      const txt = readTextSafe(pkgPath, 64_000);
      if (txt) addPkgDeps(JSON.parse(txt));
    } catch {}
  }
  for (const p of [...(manifests.pyprojectPaths || []), ...(manifests.requirementsPaths || []), ...(manifests.goModPaths || []), ...(manifests.cargoTomlPaths || [])]) {
    const txt = readTextSafe(p, 64_000).toLowerCase();
    for (const token of ['playwright', 'posthog', 'pytest', 'fastapi', 'django', 'flask', 'sqlalchemy', 'prisma', 'supabase', 'remotion', 'gsap']) {
      if (new RegExp(`(?:^|[\\s"',=\\[<])${token}\\b`).test(txt)) deps.add(token);
    }
  }
  return deps;
}

/**
 * Analyzes a workspace read-only and returns tailored automation recommendations.
 * @param {{ workspaceRoot?: string, currentState?: object|null, maxFiles?: number, env?: object }} [options={}]
 */
export function recommendProjectSetup(opts = {}) {
  const {
    workspaceRoot = process.cwd(),
    currentState = null,
    maxFiles = 1200,
    env = process.env,
  } = opts && typeof opts === 'object' && !Array.isArray(opts) ? opts : {};
  const absRoot = resolve(workspaceRoot || process.cwd());
  if (!existsSync(absRoot)) {
    return { ok: false, error: 'workspace_not_found', workspaceRoot: absRoot };
  }

  const scan = collectAndDetectStack(absRoot, {
    maxDepth: 6,
    maxFiles: Math.max(50, Number(maxFiles) || 1200),
    maxBytesPerFile: 512_000,
    skipFileText: true,
  });

  const stack = scan.stack || { languages: [], traits: [], frameworks: [], totalFiles: 0 };
  const files = Array.isArray(scan.files) ? scan.files : [];
  const deps = collectDependencySignals(scan);
  const langSet = new Set(stack.languages || []);
  const fwSet = new Set(stack.frameworks || []);
  const traitSet = new Set(stack.traits || []);

  const hasTests = files.some((f) => f.isTestFile) || Boolean(scan.rootPkg?.scripts?.test);
  const nonDocUiFiles = files.filter(
    (f) =>
      /\.(?:css|scss|html?|jsx|tsx|vue|svelte)$/i.test(f.relPath || '') &&
      !/^(?:docs?|docs_src|examples?|tutorials?|coverage|\.github|dist|build)\//i.test(f.relPath || '')
  );
  const backendFilesCount = files.filter((f) => /\.(?:go|py|rs|java|c|cpp|h|hpp)$/i.test(f.relPath || '')).length;
  const hasExplicitUiFramework =
    traitSet.has('jsx') ||
    traitSet.has('tsx') ||
    fwSet.has('react') ||
    fwSet.has('next') ||
    fwSet.has('vue') ||
    fwSet.has('svelte') ||
    deps.has('tailwindcss') ||
    deps.has('vite') ||
    Boolean(scan.rootPkg?.dependencies?.react || scan.rootPkg?.dependencies?.vue || scan.rootPkg?.dependencies?.svelte);
  const hasFrontend =
    hasExplicitUiFramework ||
    (nonDocUiFiles.length >= 2 && (backendFilesCount < 50 || nonDocUiFiles.length * 10 >= files.length)) ||
    (traitSet.has('browser') && nonDocUiFiles.length >= 1 && backendFilesCount < 40);

  const hasProgrammaticVideo =
    deps.has('remotion') ||
    deps.has('@remotion/cli') ||
    deps.has('hyperframes') ||
    (deps.has('gsap') && files.filter((f) => /\.(?:html?|tsx?|jsx?|mjs)$/i.test(f.relPath || '')).slice(0, 20).some((f) => /data-composition-id|window\.__timelines|useCurrentFrame/i.test(readTextSafe(f.file, 32_000))));

  const hasShaderOrVfx = files.some((f) => /\.(?:glsl|frag|vert|isf|ofx)$/i.test(f.relPath || '')) ||
    (langSet.has('c_cpp') && files.filter((f) => /\.(?:c|cpp|h|hpp)$/i.test(f.relPath || '')).slice(0, 12).some((f) => /OfxActionLoad/i.test(readTextSafe(f.file, 32_000)))) ||
    files.filter((f) => /gamestate_integration/i.test(f.relPath || '')).slice(0, 4).some((f) => /gamestate_integration/i.test(readTextSafe(f.file, 16_000)));

  const hasGameSignals =
    deps.has('phaser') ||
    deps.has('three') ||
    deps.has('pixi.js') ||
    deps.has('babylonjs') ||
    existsSync(join(absRoot, 'project.godot'));

  const hasTypedOrSystemsLang =
    langSet.has('typescript') || langSet.has('rust') || langSet.has('go') || langSet.has('c_cpp') || langSet.has('java');
  const hasEnvFiles = files.some((f) => /(?:^|\/)\.env(?:\.|$)/i.test(f.relPath || '')) || existsSync(join(absRoot, '.env'));

  const hasDesignMd = existsSync(join(absRoot, 'DESIGN.md'));
  const hasGatesMd = existsSync(join(absRoot, 'GATES.md'));
  const hasAgentIgnore = existsSync(join(absRoot, '.agentignore'));
  const hasSonar = existsSync(join(absRoot, 'sonar-project.properties'));

  let recommendedHookProfile = 'standard';
  let hookProfileReasonRu = 'Сбалансированный профиль для повседневной разработки и проверок после правок.';
  let hookProfileReasonEn = 'Balanced profile for daily development and post-edit verification.';
  if (stack.totalFiles <= 8 && !hasTests && !hasTypedOrSystemsLang) {
    recommendedHookProfile = 'minimal';
    hookProfileReasonRu = 'Небольшой проект или набор скриптов без тяжёлых связей — достаточно лёгких защитных хуков.';
    hookProfileReasonEn = 'Small script/project with few dependencies — lightweight guard hooks are sufficient.';
  } else if (hasTypedOrSystemsLang || (hasTests && stack.totalFiles >= 45) || langSet.has('ci_container')) {
    recommendedHookProfile = 'strict';
    hookProfileReasonRu = 'Типизированный или крупный проект с тестами — строгий профиль гарантирует LSP, каскад-проверку и защиту конфигов.';
    hookProfileReasonEn = 'Typed or large tested codebase — strict profile enforces LSP checks, cascade audits, and config protection.';
  }

  const recommendedToggles = {
    lspBridgeEnabled: langSet.has('typescript') || langSet.has('javascript') || langSet.has('python') || langSet.has('go') || langSet.has('rust'),
    testImpactVerify: hasTests,
    uiDesignPreviewGate: hasFrontend,
    configProtection: (scan.manifests?.tsconfigPaths?.length || 0) > 0 || (scan.manifests?.biomeJsonPaths?.length || 0) > 0 || existsSync(join(absRoot, '.eslintrc.json')),
    completionGates: stack.totalFiles >= 5,
  };

  const recommendedLocalSkills = [];
  const addSkill = (slug, reasonRu, reasonEn) => {
    if (!recommendedLocalSkills.some((s) => s.slug === slug)) {
      recommendedLocalSkills.push({ slug, reasonRu, reasonEn: reasonEn || reasonRu });
    }
  };

  if (hasFrontend) {
    addSkill(
      'ui-ux-design-system',
      'Обнаружен веб-интерфейс/CSS/JSX — пригодится DESIGN.md, матрица палитр и проверка UI audit-ui.',
      'Web UI/CSS/JSX detected — DESIGN.md tokens, palette matrix, and audit-ui checks are recommended.'
    );
  }
  if (hasProgrammaticVideo) {
    addSkill(
      'programmatic-video-studio',
      'Обнаружены зависимости или композиции Remotion/HyperFrames/GSAP.',
      'Remotion/HyperFrames/GSAP dependencies or compositions detected.'
    );
  }
  if (hasShaderOrVfx) {
    addSkill(
      'vj-video-fx-studio',
      'Обнаружены шейдеры GLSL/ISF или плагины OpenFX/GSI.',
      'GLSL/ISF shaders or OpenFX/GSI plugins detected.'
    );
  }
  if (hasGameSignals) {
    addSkill(
      'game-systems-architect',
      'Обнаружен игровой движок/сцена (Phaser/Three/Pixi/Godot).',
      'Game engine/scene dependencies detected (Phaser/Three/Pixi/Godot).'
    );
  }
  if (stack.totalFiles >= 12) {
    addSkill(
      'deep-stress-auditor',
      'Многомодульный проект — полезен периодический прогон стресс-аудита и Blast Radius.',
      'Multi-module repository — periodic stress audit and Blast Radius checks are recommended.'
    );
  }
  if (stack.totalFiles >= 20 && (langSet.has('javascript') || langSet.has('typescript') || langSet.has('python'))) {
    addSkill(
      'ast-codemod-refactor',
      'Крупная кодовая база — массовое переименование безопаснее выполнять через run-codemod с откатом.',
      'Large codebase — run bulk renames safely via run-codemod with rollback snapshots.'
    );
  }

  const projectHygieneSuggestions = [];
  if (hasEnvFiles && !hasAgentIgnore) {
    projectHygieneSuggestions.push({
      kind: 'agentignore',
      titleRu: 'Добавьте .agentignore для дополнительной изоляции .env и локальных секретов',
      titleEn: 'Add .agentignore to isolate .env and local secret files',
      command: `node -e "require('fs').writeFileSync('.agentignore','.env*\\nsecrets/\\n','utf8')"`,
    });
  }
  if (hasFrontend && !hasDesignMd) {
    const extractScript = resolveCliScriptPath('skills', 'ui-ux-design-system', 'scripts', 'extract-design-md.mjs');
    projectHygieneSuggestions.push({
      kind: 'design_md',
      titleRu: 'Сгенерируйте DESIGN.md прямо из существующего CSS/токенов проекта',
      titleEn: 'Generate DESIGN.md directly from existing CSS variables/tokens',
      command: `node ${extractScript} . --write`,
    });
  }
  if (stack.totalFiles >= 25 && !hasGatesMd) {
    const cliScript = resolveCliScriptPath('core', 'router-cli.mjs');
    projectHygieneSuggestions.push({
      kind: 'gates_md',
      titleRu: 'Для крупных задач можно создать журнал приёмки GATES.md (unlazy)',
      titleEn: 'Create a GATES.md acceptance gate checklist for large tasks',
      command: `node ${cliScript} gates init .`,
    });
  }
  if (currentState?.hookProfile && currentState.hookProfile !== recommendedHookProfile) {
    projectHygieneSuggestions.push({
      kind: 'hook_profile',
      titleRu: `Текущий профиль хуков (${currentState.hookProfile}) отличается от рекомендованного (${recommendedHookProfile})`,
      titleEn: `Current hook profile (${currentState.hookProfile}) differs from recommended (${recommendedHookProfile})`,
      command: '',
    });
  }

  const externalIntegrations = [];
  if (deps.has('playwright') || deps.has('@playwright/test')) {
    externalIntegrations.push({
      id: 'playwright',
      kind: 'cli_or_mcp',
      name: 'Playwright / Chrome DevTools',
      nameEn: 'Playwright / Chrome DevTools',
      reasonRu: 'В проекте найден Playwright — удобно гонять E2E и accessibility-снимки без раздувания контекста.',
      reasonEn: 'Playwright found in dependencies — great for E2E and accessibility snapshots without bloating context.',
      command: 'npx playwright test',
    });
  }
  if (deps.has('posthog') || deps.has('posthog-js') || deps.has('posthog-node')) {
    externalIntegrations.push({
      id: 'posthog',
      kind: 'mcp_or_plugin',
      name: 'PostHog AI Plugin / MCP',
      nameEn: 'PostHog AI Plugin / MCP',
      reasonRu: 'В зависимостях найден PostHog — можно подключить просмотр фиче-флагов и ошибок прямо из агента.',
      reasonEn: 'PostHog found in dependencies — inspect feature flags and error telemetry directly from the agent.',
      command: 'npx @posthog/wizard mcp add',
    });
  }
  if (fwSet.has('react') || fwSet.has('next') || deps.has('prisma') || deps.has('@prisma/client') || deps.has('@supabase/supabase-js')) {
    externalIntegrations.push({
      id: 'context7',
      kind: 'installed_mcp',
      name: 'Context7 MCP (уже установлен)',
      nameEn: 'Context7 MCP (already installed)',
      reasonRu: 'Найдены внешние фреймворки/ORM — проверяйте свежие API через Context7 перед написанием кода.',
      reasonEn: 'External frameworks/ORMs detected — verify up-to-date APIs via Context7 before coding.',
      command: '',
    });
  }
  if (hasSonar) {
    externalIntegrations.push({
      id: 'sonarqube',
      kind: 'installed_skill',
      name: 'SonarQube Skills (уже установлен)',
      nameEn: 'SonarQube Skills (already installed)',
      reasonRu: 'Найден sonar-project.properties — доступен авто-анализ Quality Gate и уязвимостей.',
      reasonEn: 'sonar-project.properties detected — Quality Gate and vulnerability analysis ready.',
      command: '',
    });
  }
  if (deps.has('@google/genai')) {
    externalIntegrations.push({
      id: 'gemini-api',
      kind: 'installed_skill',
      name: 'Gemini API Dev Skill (уже установлен)',
      nameEn: 'Gemini API Dev Skill (already installed)',
      reasonRu: 'Найден @google/genai — используйте актуальный Interactions API вместо устаревшего SDK.',
      reasonEn: '@google/genai detected — use the current Interactions API rather than legacy SDK patterns.',
      command: '',
    });
  }
  if (env?.FIRECRAWL_API_KEY) {
    externalIntegrations.push({
      id: 'firecrawl',
      kind: 'env_detected',
      name: 'Firecrawl API (ключ обнаружен)',
      nameEn: 'Firecrawl API (key detected)',
      reasonRu: 'Обнаружен FIRECRAWL_API_KEY — доступен импорт документации в чистый Markdown.',
      reasonEn: 'FIRECRAWL_API_KEY detected — documentation import to clean Markdown is available.',
      command: '',
    });
  }
  if (env?.PERPLEXITY_API_KEY) {
    externalIntegrations.push({
      id: 'perplexity',
      kind: 'env_detected',
      name: 'Perplexity MCP (ключ обнаружен)',
      nameEn: 'Perplexity MCP (key detected)',
      reasonRu: 'Обнаружен PERPLEXITY_API_KEY — доступен глубокий поиск с источниками через внешний MCP.',
      reasonEn: 'PERPLEXITY_API_KEY detected — grounded deep search is available via external MCP.',
      command: '',
    });
  }

  return {
    ok: true,
    workspaceRoot: absRoot,
    stack: {
      languages: stack.languages || [],
      frameworks: stack.frameworks || [],
      traits: stack.traits || [],
      totalFiles: stack.totalFiles || 0,
      hasTests,
      hasFrontend,
    },
    artifacts: {
      designMd: hasDesignMd,
      gatesMd: hasGatesMd,
      agentIgnore: hasAgentIgnore,
      sonarProps: hasSonar,
    },
    recommendedHookProfile,
    hookProfileReasonRu,
    hookProfileReasonEn,
    recommendedToggles,
    recommendedLocalSkills,
    projectHygieneSuggestions,
    externalIntegrations,
  };
}

/**
 * Formats project setup recommendation report into English or Russian CLI output.
 * @param {object} [report={}]
 * @param {'en'|'ru'} [lang='en']
 */
export function formatProjectSetupReport(report = {}, lang = 'en') {
  const isRu = normalizeLang(lang, 'en') === 'ru';
  if (!report || !report.ok) {
    return isRu
      ? `❌ [Setup Doctor] Не удалось проанализировать проект: ${report?.error || 'unknown_error'}`
      : `❌ [Setup Doctor] Failed to analyze project: ${report?.error || 'unknown_error'}`;
  }
  const st = report.stack || {};
  const lines = isRu
    ? [
        `🩺 [Setup Doctor] Проект: ${report.workspaceRoot}`,
        `   Стек: ${(st.languages || []).join(', ') || 'text'} | Фреймворки: ${(st.frameworks || []).join(', ') || 'нет'} | Файлов: ${st.totalFiles || 0}`,
        `   Профиль хуков: ${report.recommendedHookProfile} — ${report.hookProfileReasonRu}`,
      ]
    : [
        `🩺 [Setup Doctor] Project: ${report.workspaceRoot}`,
        `   Stack: ${(st.languages || []).join(', ') || 'text'} | Frameworks: ${(st.frameworks || []).join(', ') || 'none'} | Files: ${st.totalFiles || 0}`,
        `   Hook profile: ${report.recommendedHookProfile} — ${report.hookProfileReasonEn || report.hookProfileReasonRu}`,
      ];
  if (report.recommendedLocalSkills?.length) {
    lines.push(isRu ? '   Рекомендованные локальные навыки:' : '   Recommended local skills:');
    for (const sk of report.recommendedLocalSkills) {
      lines.push(`     • ${sk.slug} — ${isRu ? sk.reasonRu : (sk.reasonEn || sk.reasonRu)}`);
    }
  }
  if (report.projectHygieneSuggestions?.length) {
    lines.push(isRu ? '   Улучшения гигиены проекта:' : '   Project hygiene improvements:');
    for (const h of report.projectHygieneSuggestions) {
      const title = isRu ? h.titleRu : (h.titleEn || h.titleRu);
      lines.push(`     • ${title}${h.command ? ` (${h.command})` : ''}`);
    }
  }
  if (report.externalIntegrations?.length) {
    lines.push(isRu ? '   Подключения под обнаруженные зависимости:' : '   Integrations for detected dependencies:');
    for (const ext of report.externalIntegrations) {
      const name = isRu ? ext.name : (ext.nameEn || ext.name);
      const reason = isRu ? ext.reasonRu : (ext.reasonEn || ext.reasonRu);
      lines.push(`     • ${name}: ${reason}`);
    }
  }
  return lines.join('\n');
}

/**
 * Formats project setup recommendation report into concise CLI output (RU default for backwards compat).
 * @param {object} [report={}]
 * @param {'en'|'ru'} [lang='ru']
 */
export function formatProjectSetupReportRu(report = {}, lang = 'ru') {
  return formatProjectSetupReport(report, lang);
}

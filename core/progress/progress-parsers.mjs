/**
 * @file progress-parsers.mjs
 * @description Pure workspace/transcript/plan/step parsing & label formatting helpers for task-progress.
 */

import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { redactSecretsInText } from '../security-guard.mjs';

const REGISTRY_TTL_MS = 2 * 60 * 60 * 1000;
export const MAX_TIMELINE_STEPS = 30;
export const UNSCOPED_CHAT_PROJECT_RU = 'Без проекта';
export const UNSCOPED_CHAT_PROJECT_EN = 'No project';

function clampInt(val, min, max, fallback) {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

export function sanitizeWorkspaceRoot(workspaceRoot = '') {
  let clean = String(workspaceRoot || '').trim();
  clean = clean.replace(/^["'\s]+|["'\s]+$/g, '');
  clean = clean.replace(/\\\\/g, '\\').replace(/[\\/]+$/, '');
  return clean.replace(/^["'\s]+|["'\s]+$/g, '');
}

const ANTIGRAVITY_WORKTREE_RE =
  /[\\/]\.gemini[\\/]antigravity[\\/]worktrees[\\/]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-zA-Z0-9_-]{6,64})[\\/]([^\\/]+)$/i;

export function parseAntigravityWorktreePath(workspaceRoot = '') {
  const clean = sanitizeWorkspaceRoot(workspaceRoot);
  if (!clean) return null;
  const m = ANTIGRAVITY_WORKTREE_RE.exec(clean);
  if (!m) return null;
  return {
    parentCid: normalizeConversationId(m[1]),
    worktreeDir: m[2] || '',
  };
}

export function sanitizeFileBasename(filePath = '') {
  let raw = '';
  if (typeof filePath === 'string') {
    raw = filePath;
  } else if (filePath && typeof filePath === 'object') {
    raw = String(filePath.filePath || filePath.relPath || filePath.path || filePath.file || filePath.name || '');
  }
  const clean = raw.trim().replace(/^["'\s]+|["'\s]+$/g, '');
  if (!clean || clean.includes('[object ')) return '';
  return basename(clean).replace(/["']+$/g, '');
}

export function normalizeConversationId(rawCid = 'default') {
  const clean = String(rawCid || 'default').trim().replace(/^["'\s]+|["'\s]+$/g, '') || 'default';
  return clean.replace(/__[0-9a-f]{8}$/i, '') || 'default';
}

export const UUID_PROJ_NAME_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isBrainOrTempWorkspacePath(wsPath = '') {
  const norm = sanitizeWorkspaceRoot(wsPath).replace(/\\/g, '/').toLowerCase();
  if (!norm) return true;
  return (
    norm.includes('/.gemini/antigravity/brain') ||
    norm.includes('/.gemini/antigravity-ide/brain') ||
    norm.includes('/.gemini/antigravity-cli/brain') ||
    norm.includes('/.system_generated/')
  );
}

export function extractProjectName(workspaceRoot = '', fallbackProjectName = '') {
  const clean = sanitizeWorkspaceRoot(workspaceRoot);
  if (!clean || isBrainOrTempWorkspacePath(clean)) return fallbackProjectName || 'antigravity-model-router';
  if (ANTIGRAVITY_WORKTREE_RE.test(clean) && fallbackProjectName) {
    return String(fallbackProjectName).trim().replace(/^["']+$/g, '') || 'antigravity-model-router';
  }
  const base = basename(clean).replace(/["']+$/g, '');
  if (UUID_PROJ_NAME_RE.test(base) && fallbackProjectName) {
    return fallbackProjectName;
  }
  return base || fallbackProjectName || 'antigravity-model-router';
}

const PROGRESS_EXACT_RU_TO_EN = new Map([
  ['Без проекта', 'No project'],
  ['В ожидании задач', 'Waiting for tasks'],
  ['Ожидание задачи', 'Waiting for task'],
  ['Выполнение операции', 'Running operation'],
  ['Выполнение задачи', 'Running task'],
  ['Выполнение', 'Running'],
  ['Задача выполнена', 'Task completed'],
  ['Завершено ✓', 'Completed ✓'],
  ['Завершено', 'Completed'],
  ['Готово', 'Done'],
  ['Ожидание ответа пользователя', 'Waiting for user reply'],
  ['Ожидание ответа', 'Waiting for reply'],
  ['Ошибка выполнения команды', 'Command failed'],
  ['Ошибка выполнения', 'Execution error'],
  ['Работа субагента', 'Subagent running'],
  ['Запуск субагента', 'Launching subagent'],
  ['Фоновая задача', 'Background task'],
  ['Фоновые задачи', 'Background tasks'],
  ['Параллельная работа субагентов', 'Parallel subagents active'],
  ['Параллельная работа агентов', 'Parallel agents active'],
  ['Параллельные агенты', 'Parallel agents'],
  ['Вопрос пользователю', 'Question for user'],
  ['Согласование деталей с пользователем перед выполнением', 'Clarifying task details before execution'],
  ['Ревью этапа архитектором', 'Architect stage review'],
  ['Сверка правок исполнителя с планом и тестами', 'Reviewing executor edits against plan & tests'],
  ['Выполнение согласованного плана', 'Executing approved plan'],
  ['План согласован · выполнение', 'Plan approved · running'],
  ['Обновление чек-листа', 'Updating checklist'],
  ['Фиксация плана работ', 'Finalizing work plan'],
  ['Дополнительная сверка кода', 'Additional code verification'],
  ['Анализ задачи', 'Analyzing task'],
  ['Анализ контекста', 'Inspecting context'],
  ['Технический разбор', 'Technical analysis'],
  ['Анализ связей, контрактов и формирование ответа', 'Analyzing dependencies, contracts & drafting answer'],
  ['RAM-поиск и анализ кода', 'RAM search & code analysis'],
  ['Поиск релевантных модулей в RAM/GPU и анализ контекста', 'Searching relevant modules in RAM/GPU & analyzing context'],
  ['Синтез инженерного ответа по срезам кода', 'Synthesizing engineering answer from code slices'],
  ['RAM-срез целевого узла', 'RAM slice of target node'],
  ['Чтение целевого среза кода в RAM', 'Reading target code slice in RAM'],
  ['Точечный diff-патч', 'Surgical diff patch'],
  ['Точечное изменение файла с контролем отката', 'Surgical file edit with rollback guard'],
  ['AST-чек синтаксиса', 'AST syntax check'],
  ['Авто-проверка синтаксиса и контрактов', 'Automated syntax & contract check'],
  ['Контракты AST (Blast Radius)', 'AST Contracts (Blast Radius)'],
  ['Сверка импортов, экспортов и обратных зависимостей', 'Checking imports, exports & reverse dependencies'],
  ['Автотесты и верификация', 'Automated tests & verification'],
  ['Прогон регрессионных тестов и финальная проверка', 'Running regression tests & final verification'],
  ['RAM-срез и граф связей', 'RAM slice & dependency graph'],
  ['Архитектурный анализ графа зависимостей и срезов кода', 'Architectural dependency graph & slice analysis'],
  ['Модификация целевых узлов', 'Modifying target nodes'],
  ['Последовательное внесение изменений в целевые модули', 'Applying incremental edits to target modules'],
  ['Контракты AST и импорты', 'AST contracts & imports'],
  ['Контроль целостности импортов и обратных зависимостей', 'Validating import integrity & reverse dependencies'],
  ['Запуск тестового набора и финальная проверка', 'Running test suite & final verification'],
  ['AST-чек и микро-тесты', 'AST check & micro-tests'],
  ['Проверка синтаксиса, контрактов импорта и микро-тестов', 'Checking syntax, import contracts & micro-tests'],
  ['RAM-срез и поиск связей', 'RAM slice & dependency lookup'],
  ['Поиск целевых модулей в RAM/GPU и анализ зависимостей', 'Finding target modules in RAM/GPU & analyzing dependencies'],
  ['Внесение патчей в модули', 'Patching modules'],
  ['Модификация целевых файлов через diff-патчи', 'Modifying target files via diff patches'],
  ['Проверка синтаксиса, импортов и затронутых тестов', 'Checking syntax, imports & impacted tests'],
  ['Внесение изменений', 'Applying changes'],
  ['Внесение патчей', 'Applying patches'],
  ['Модификация кода', 'Modifying code'],
  ['Изменения проверены', 'Changes verified'],
  ['Команда выполнена', 'Command completed'],
  ['Команда терминала', 'Terminal command'],
  ['Выполнение команды терминала', 'Running terminal command'],
  ['Проверки пройдены · финализация', 'Checks passed · finalizing'],
  ['Контракты AST и синтаксис ✓', 'AST contracts & syntax ✓'],
  ['Синтаксис и контракты импорта проверены', 'Syntax & import contracts verified'],
  ['Ошибка проверки синтаксиса', 'Syntax check failed'],
  ['Чтение среза в RAM', 'Reading slice in RAM'],
  ['Быстрый поиск в RAM', 'Fast RAM search'],
  ['Анализ графа связей в RAM', 'Analyzing dependency graph in RAM'],
  ['Сборка контекста в RAM', 'Building context pack in RAM'],
  ['Семантический поиск GPU', 'GPU semantic search'],
  ['Дистилляция на GPU', 'GPU distillation'],
  ['Чтение файла', 'Reading file'],
  ['Разведка контекста', 'Context scouting'],
  ['Аудит связей', 'Contract audit'],
  ['Финальная проверка', 'Final check'],
  ['Демо-прогресс в панели', 'Demo progress in panel'],
]);

const PROGRESS_PREFIX_RU_TO_EN = [
  [/^Этап\s+(\d+)\s+из\s+(\d+)(.*)$/i, (_, a, b, tail) => `Step ${a} of ${b}${tail ? localizeProgressLabelToEn(tail) : ''}`],
  [/^Этап\s+(\d+)$/i, 'Step $1'],
  [/^Чат\s+#(\d+)$/i, 'Chat #$1'],
  [/^Рой\s+#(\d+)$/i, 'Swarm #$1'],
  [/^Агент\s+#(\d+)$/i, 'Agent #$1'],
  [/^Рой:\s*(.+)$/i, (_, rest) => `Swarm: ${localizeProgressLabelToEn(rest)}`],
  [/^Агент:\s*(.+)$/i, (_, rest) => `Agent: ${localizeProgressLabelToEn(rest)}`],
  [/^Субагент:\s*(.+)$/i, (_, rest) => `Subagent: ${localizeProgressLabelToEn(rest)}`],
  [/^Фон\s*\((\d+)\):\s*(.+)$/i, (_, n, rest) => `Background (${n}): ${localizeProgressLabelToEn(rest)}`],
  [/^Фон:\s*(.+)$/i, (_, rest) => `Background: ${localizeProgressLabelToEn(rest)}`],
  [/^Вопрос пользователю:\s*(.+)$/i, 'Question for user: $1'],
  [/^Вопрос:\s*(.+)$/i, 'Question: $1'],
  [/^RAM-срез\s+(.+)$/i, 'RAM slice $1'],
  [/^RAM-поиск:\s*(.+)$/i, 'RAM search: $1'],
  [/^Срез и связи\s+(.+)$/i, 'Slice & deps $1'],
  [/^Граф и срез\s+(.+)$/i, 'Graph & slice $1'],
  [/^Патч\s+(.+)$/i, 'Patch $1'],
  [/^Правка\s+(.+)$/i, 'Edit $1'],
  [/^Реализация\s+(.+)$/i, 'Implement $1'],
  [/^Анализ\s+(.+)$/i, 'Inspect $1'],
  [/^Синхронизация\s+(.+)$/i, 'Sync $1'],
  [/^Тесты?:\s*(.+)$/i, (_, r) => `Tests: ${r === 'автотесты' ? 'tests' : r}`],
  [/^Тест\s+(.+)$/i, 'Test $1'],
  [/^Микро-тест\s+(.+)$/i, 'Micro-test $1'],
  [/^Запуск тестов:\s*(.+)$/i, 'Running tests: $1'],
  [/^Запуск\s+(.+)$/i, 'Run $1'],
  [/^Уточнение\s+(.+)$/i, 'Refining $1'],
  [/^Чтение RAM-срезов(?:\s+и\s+символов)?:\s*(.+)$/i, 'Reading RAM slices: $1'],
  [/^Чтение среза и зависимостей:\s*(.+)$/i, 'Reading slice & deps: $1'],
  [/^Чтение срезов и зависимостей:\s*(.+)$/i, 'Reading slices & deps: $1'],
  [/^Дополнительное чтение\s+(.+)$/i, 'Reading $1'],
  [/^Чтение и анализ\s+(.+)$/i, 'Inspecting $1'],
  [/^Чтение\s+(.+)$/i, 'Reading $1'],
  [/^Поиск в RAM\/GPU:\s*(.+)$/i, 'RAM/GPU search: $1'],
  [/^Анализ графа зависимостей и срезов:\s*(.+)$/i, 'Analyzing dependency graph & slices: $1'],
  [/^Модификация(?:\s+целевых)?\s+модулей:\s*(.+)$/i, 'Modifying modules: $1'],
  [/^Модификация:\s*(.+)$/i, 'Modifying: $1'],
  [/^Точечная правка:\s*(.+)$/i, 'Surgical edit: $1'],
  [/^Внесение изменений в:\s*(.+)$/i, 'Editing: $1'],
  [/^Проверено:\s*(.+)$/i, 'Verified: $1'],
  [/^Обновлён\s+(.+)$/i, 'Updated $1'],
  [/^Верификация:\s*(.+)$/i, 'Verification: $1'],
  [/^Прогон (?:авто)?тестов:\s*(.+)$/i, 'Running tests: $1'],
  [/^Прогон тестов\s*\(([^)]+)\)$/i, 'Running tests ($1)'],
  [/^Команда:\s*(.+)$/i, 'Command: $1'],
  [/^Терминал:\s*(.+)$/i, 'Terminal: $1'],
  [/^Сбой команды:\s*(.+)$/i, 'Command failed: $1'],
  [/^Контракты AST\s*\((\d+)\s+завис\.\)$/i, 'AST contracts ($1 deps)'],
  [/^Сверка импортов и контрактов\s*\((\d+)\s+обратных зависимостей\)$/i, 'Checking imports & contracts ($1 reverse deps)'],
  [/^Test-Impact верификация:\s*(.+)$/i, 'Test-Impact verification: $1'],
  [/^Сбой контракта\s*\((\d+)\)$/i, 'Contract violation ($1)'],
  [/^Нарушены контракты импорта\s*\((\d+)\s+модулей\)$/i, 'Broken import contracts ($1 modules)'],
  [/^Ошибка проверки:\s*(.+)$/i, 'Check error: $1'],
  [/^Ошибка проверки\s+(.+)$/i, 'Check error in $1'],
  [/^GPU-поиск:\s*(.+)$/i, 'GPU search: $1'],
  [/^GPU-сжатие\s+(.+)$/i, 'GPU distill $1'],
  [/^(.+?)\s+выполнен ✓$/i, '$1 completed ✓'],
];

/**
 * Translates generated Russian task-progress labels/tooltips into concise English equivalents
 * so live UI & exports work seamlessly in EN mode without mutating stored canonical strings.
 * @param {string} [raw='']
 * @returns {string}
 */
export function localizeProgressLabelToEn(raw = '') {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (PROGRESS_EXACT_RU_TO_EN.has(s)) {
    return PROGRESS_EXACT_RU_TO_EN.get(s);
  }
  if (s.includes(' · ')) {
    const parts = s.split(' · ').map((part) => localizeProgressLabelToEn(part));
    const joined = parts.join(' · ');
    if (joined !== s) return joined;
  }
  for (const [rx, rep] of PROGRESS_PREFIX_RU_TO_EN) {
    if (rx.test(s)) {
      return typeof rep === 'function' ? s.replace(rx, rep) : s.replace(rx, rep);
    }
  }
  return s;
}

/**
 * Attaches `titleEn`, `fullTitleEn`, and `activeDetailEn` to a timeline step object.
 * @param {object} step
 * @returns {object}
 */
export function localizeStepToEn(step) {
  if (!step || typeof step !== 'object') return step;
  const titleEn = step.titleEn || localizeProgressLabelToEn(step.title || '');
  const fullTitleEn = step.fullTitleEn || localizeProgressLabelToEn(step.fullTitle || step.title || '');
  const activeDetailEn = step.activeDetail ? (step.activeDetailEn || localizeProgressLabelToEn(step.activeDetail)) : '';
  return {
    ...step,
    titleEn,
    fullTitleEn,
    ...(activeDetailEn ? { activeDetailEn } : {}),
  };
}

export function buildActiveProjectsSummary(activeChats = []) {
  if (!Array.isArray(activeChats) || activeChats.length === 0) return [];
  const byProj = new Map();
  for (const c of activeChats) {
    if (!c) continue;
    if (c.status !== 'running' && c.status !== 'waiting_user') continue;
    const isUnscoped = Boolean(c.isUnscopedChat || (!c.workspaceRoot && (!c.projectName || c.projectName === UNSCOPED_CHAT_PROJECT_RU)));
    const proj = String(c.projectName || (isUnscoped ? UNSCOPED_CHAT_PROJECT_RU : '')).trim();
    if (!proj) continue;
    let bucket = byProj.get(proj);
    if (!bucket) {
      const stageRu = c.stageLabel || 'Выполнение';
      const stepRu = c.stepTitle || '';
      bucket = {
        projectName: proj,
        projectNameEn: isUnscoped ? UNSCOPED_CHAT_PROJECT_EN : (c.projectNameEn || proj),
        isUnscopedChat: isUnscoped,
        workspaceRoot: c.workspaceRoot || '',
        status: c.status,
        pctSum: 0,
        activeChatsCount: 0,
        stageLabel: stageRu,
        stageLabelEn: c.stageLabelEn || localizeProgressLabelToEn(stageRu),
        stepTitle: stepRu,
        stepTitleEn: c.stepTitleEn || localizeProgressLabelToEn(stepRu),
        updatedAt: Number(c.updatedAt || 0),
      };
      byProj.set(proj, bucket);
    }
    bucket.activeChatsCount += 1;
    bucket.pctSum += clampInt(c.percent, 0, 100, 0);
    if (c.status === 'running') {
      bucket.status = 'running';
    }
    const ts = Number(c.updatedAt || 0);
    if (ts >= bucket.updatedAt) {
      bucket.updatedAt = ts;
      if (c.workspaceRoot) bucket.workspaceRoot = c.workspaceRoot;
      if (c.stageLabel) {
        bucket.stageLabel = c.stageLabel;
        bucket.stageLabelEn = c.stageLabelEn || localizeProgressLabelToEn(c.stageLabel);
      }
      if (c.stepTitle) {
        bucket.stepTitle = c.stepTitle;
        bucket.stepTitleEn = c.stepTitleEn || localizeProgressLabelToEn(c.stepTitle);
      }
    }
  }
  return Array.from(byProj.values())
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 6)
    .map((b) => ({
      projectName: b.projectName,
      projectNameEn: b.projectNameEn || b.projectName,
      ...(b.isUnscopedChat ? { isUnscopedChat: true } : {}),
      workspaceRoot: b.workspaceRoot,
      status: b.status,
      percent: Math.round(b.pctSum / Math.max(1, b.activeChatsCount)),
      activeChatsCount: b.activeChatsCount,
      stageLabel: b.stageLabel,
      stageLabelEn: b.stageLabelEn || localizeProgressLabelToEn(b.stageLabel),
      stepTitle: b.stepTitle,
      stepTitleEn: b.stepTitleEn || localizeProgressLabelToEn(b.stepTitle),
      updatedAt: b.updatedAt,
    }));
}

export function buildFormattedProgressText({ status = 'idle', currentStep = 0, totalSteps = 0, stepTitle = '' } = {}) {
  const cleanTitle = String(stepTitle || '').trim();
  if (status === 'idle' || totalSteps <= 0 || currentStep <= 0) {
    return cleanTitle && cleanTitle !== 'В ожидании задач'
      ? `В ожидании задач · ${cleanTitle}`
      : 'В ожидании задач';
  }
  const safeStep = clampInt(currentStep, 1, Math.max(1, totalSteps), 1);
  const safeTotal = Math.max(safeStep, clampInt(totalSteps, 1, MAX_TIMELINE_STEPS, 3));
  const fallbackOp = status === 'completed' ? 'Задача выполнена' : (status === 'waiting_user' ? 'Ожидание ответа' : 'Выполнение операции');
  return `Этап ${safeStep} из ${safeTotal} · ${cleanTitle || fallbackOp}`;
}

export function buildFormattedProgressTextEn({ status = 'idle', currentStep = 0, totalSteps = 0, stepTitle = '', stepTitleEn = '' } = {}) {
  const rawTitle = String(stepTitleEn || '').trim() || localizeProgressLabelToEn(stepTitle || '');
  if (status === 'idle' || totalSteps <= 0 || currentStep <= 0) {
    return rawTitle && rawTitle !== 'Waiting for tasks' && rawTitle !== 'Waiting for task'
      ? `Waiting for tasks · ${rawTitle}`
      : 'Waiting for tasks';
  }
  const safeStep = clampInt(currentStep, 1, Math.max(1, totalSteps), 1);
  const safeTotal = Math.max(safeStep, clampInt(totalSteps, 1, MAX_TIMELINE_STEPS, 3));
  const fallbackOp = status === 'completed' ? 'Task completed' : (status === 'waiting_user' ? 'Waiting for reply' : 'Running operation');
  return `Step ${safeStep} of ${safeTotal} · ${rawTitle || fallbackOp}`;
}

export function extractTopicLabelFromPrompt(userPrompt = '') {
  let text = String(userPrompt || '');
  text = text
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, ' ')
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, ' ')
    .replace(/<SYSTEM_MESSAGE>[\s\S]*?<\/SYSTEM_MESSAGE>/gi, ' ')
    .replace(/<\/?(?:USER_REQUEST|CONTEXT_SUMMARY)>/gi, ' ')
    .replace(/\[Plan Approved[^\]]*\]/gi, ' ')
    .replace(/^A\d+\s*:\s*\(Recommended\)\s*/im, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  const firstClause = text.split(/[.!?\n]/)[0].trim();
  const words = firstClause.split(/\s+/).filter(Boolean).slice(0, 4);
  let label = words.join(' ').replace(/^[,;:\-–—]+|[,;:\-–—]+$/g, '').trim();
  if (label.length > 32) {
    label = `${label.slice(0, 30).trim()}…`;
  }
  return label;
}

export function assignChatNumber(registryObj = {}, conversationId = 'default', projectName = 'antigravity-model-router', now = Date.now()) {
  const cid = String(conversationId || 'default').trim() || 'default';
  const proj = String(projectName || 'antigravity-model-router').trim();
  const nextReg = {};
  for (const [k, v] of Object.entries(registryObj || {})) {
    if (v && typeof v === 'object' && now - Number(v.updatedAt || v.createdAt || 0) <= REGISTRY_TTL_MS) {
      nextReg[k] = { ...v };
    }
  }
  if (nextReg[cid] && nextReg[cid].projectName === proj && Number.isInteger(nextReg[cid].chatNumber) && nextReg[cid].chatNumber > 0) {
    nextReg[cid].updatedAt = now;
    return { chatNumber: nextReg[cid].chatNumber, registry: nextReg };
  }
  const used = new Set();
  for (const [k, v] of Object.entries(nextReg)) {
    if (k !== cid && v.projectName === proj && Number.isInteger(v.chatNumber)) {
      used.add(v.chatNumber);
    }
  }
  let num = 1;
  while (used.has(num)) num += 1;
  nextReg[cid] = {
    chatNumber: num,
    projectName: proj,
    createdAt: nextReg[cid]?.createdAt || now,
    updatedAt: now,
  };
  return { chatNumber: num, registry: nextReg };
}

export function resolveTranscriptPathForChat(conversationId = '', explicitPath = '', customBrainDirs = null) {
  if (explicitPath && typeof explicitPath === 'string' && existsSync(explicitPath)) {
    if (explicitPath.endsWith('transcript_full.jsonl')) {
      const compactSibling = join(dirname(explicitPath), 'transcript.jsonl');
      if (existsSync(compactSibling)) return compactSibling;
    }
    return explicitPath;
  }
  const cid = normalizeConversationId(conversationId);
  if (!cid || cid === 'default' || !/^[a-zA-Z0-9_-]{1,128}$/.test(cid)) return '';
  const brainRoots = Array.isArray(customBrainDirs) && customBrainDirs.length > 0
    ? customBrainDirs
    : ['antigravity', 'antigravity-ide', 'antigravity-cli'].map((d) => join(homedir(), '.gemini', d, 'brain'));
  for (const bRoot of brainRoots) {
    const candidate = join(bRoot, cid, '.system_generated', 'logs', 'transcript.jsonl');
    if (existsSync(candidate)) return candidate;
    const fullCandidate = join(bRoot, cid, '.system_generated', 'logs', 'transcript_full.jsonl');
    if (existsSync(fullCandidate)) return fullCandidate;
  }
  return '';
}

const STEP_CODE_EXT_RE = '(?:mjs|cjs|js|ts|tsx|jsx|py|rs|go|html|css|scss|json|vue|svelte|md|sql|sh|ps1|yaml|yml|toml)';
const TEST_FILE_RE = /\.(?:test|spec)\.[a-z0-9]+$|^test_[a-z0-9_]+\.py$/i;
const IGNORED_AST_SYMBOLS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'await',
  'constructor', 'super', 'import', 'export', 'default', 'else', 'try',
  'finally', 'throw', 'delete', 'void', 'function', 'class', 'const',
  'let', 'var', 'async', 'new', 'this', 'true', 'false', 'null', 'undefined',
]);

export function truncateAtCleanBoundary(text = '', limit = 30) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  if (s.length <= limit) return s;
  const maxContent = Math.max(4, limit - 1);
  const slice = s.slice(0, maxContent);
  const lastSep = Math.max(slice.lastIndexOf(' '), slice.lastIndexOf(','), slice.lastIndexOf(';'), slice.lastIndexOf('·'));
  const minPrefix = Math.floor(limit * 0.48);

  if (lastSep >= minPrefix) {
    const trimmed = slice.slice(0, lastSep).replace(/[\s,;:\-–—·]+$/g, '').trim();
    if (trimmed) return `${trimmed}…`;
  }

  // Long compound filename or identifier crossing the boundary: preserve a readable stem
  const stemSep = Math.max(slice.lastIndexOf('.'), slice.lastIndexOf('-'), slice.lastIndexOf('_'), slice.lastIndexOf('/'));
  if (stemSep >= Math.floor(limit * 0.6)) {
    const stem = slice.slice(0, stemSep).replace(/[\s,;:\-–—·/]+$/g, '').trim();
    if (stem) return `${stem}…`;
  }

  return `${slice.replace(/[\s,;:\-–—·]+$/g, '').trim()}…`;
}

/**
 * Normalizes a verbose plan heading or tool description into a compact technical step badge
 * plus a full technical tooltip string.
 */
export function compactTechnicalStepLabel(rawText = '', maxChars = 30) {
  let text = String(rawText || '').trim();
  if (!text) return { title: '', fullTitle: '' };

  // Resolve markdown links `[label](file:///.../foo.mjs#L10)` -> `foo.mjs`
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, lbl, href) => {
    const cleanLbl = String(lbl || '').trim();
    const cleanHref = String(href || '').split('#')[0].split('?')[0].trim();
    const base = sanitizeFileBasename(cleanHref);
    if (base && (cleanLbl.includes(base) || !/\.[a-z0-9]{1,8}$/i.test(cleanLbl))) {
      return base;
    }
    return cleanLbl || base;
  });

  // Strip markdown markup, checkboxes, (Recommended), and leading numbering
  text = text
    .replace(/^\s*#{1,6}\s+/, '')
    .replace(/^\s*[-*+]\s+\[[ xX]\]\s*/, '')
    .replace(/^\s*[-*+]\s+/, '')
    .replace(/[`*_~]/g, '')
    .replace(/\((?:recommended|рекомендуется)\)\s*/gi, '')
    .replace(/^(?:(?:step|шаг|этап)\s*\d+\s*[.:—–-]\s*|\d+[.)]\s*)/i, '')
    .replace(/^(?:(?:step|шаг|этап)\s*\d+\s*[.:—–-]\s*|\d+[.)]\s*)/i, '')
    .trim();

  // Shorten full/relative file paths (outside http/https URLs) to basename
  text = text.replace(
    new RegExp(`(?<![:/])(?:[A-Za-z]:[\\\\/]|[.\\\\/])?(?:[A-Za-z0-9_.-]+[\\\\/])+([A-Za-z0-9_.-]+\\.${STEP_CODE_EXT_RE})(?:#L\\d+(?:-L?\\d+)?)?`, 'gi'),
    '$1'
  );

  // Drop bureaucratic filler verbs at the beginning
  for (let pass = 0; pass < 2; pass++) {
    text = text
      .replace(/^(?:необходимо|нужно|следует|потребуется|требуется|предстоит|выполнить|произвести|осуществить|сделать|провести)\s+/i, '')
      .trim();
  }

  // Drop redundant generic Russian nouns right before an explicit filename
  text = text.replace(
    new RegExp(`\\b(?:файла|файлов|файл|модуля|модулей|модуль|скрипта|скрипт|компонента|компонент|теста)\\s+(?=[A-Za-z0-9_.-]+\\.${STEP_CODE_EXT_RE}\\b)`, 'gi'),
    ''
  );

  const enBaseText = text
    .replace(/\s+/g, ' ')
    .replace(/[.,;:\-–—\s]+$/g, '')
    .trim();

  // Map common English plan headings to crisp Russian engineering verbs
  text = text
    .replace(/^run\s+tests?\b[\s:-]*/i, 'Тесты ')
    .replace(/^(?:update|modify|edit|patch)\b[\s:-]*/i, 'Патч ')
    .replace(/^(?:add|implement|create|build)\b[\s:-]*/i, 'Реализация ')
    .replace(/^(?:verify|test|validate)\b[\s:-]*/i, 'Тесты ')
    .replace(/^(?:read|inspect|check|analyze|analyse)\b[\s:-]*/i, 'Анализ ')
    .replace(/^(?:sync|deploy|install)\b[\s:-]*/i, 'Синхронизация ')
    .replace(/\s+/g, ' ')
    .replace(/[.,;:\-–—\s]+$/g, '')
    .trim();

  if (!text) return { title: '', fullTitle: '', titleEn: '', fullTitleEn: '' };

  // Capitalize first letter unless it starts with a lowercase code/filename token (e.g. `server.mjs`, `node:test`)
  if (!/^[a-z0-9_.-]+(?:\.[a-z0-9]+|:)/i.test(text)) {
    text = text.charAt(0).toUpperCase() + text.slice(1);
  }

  let enText = localizeProgressLabelToEn(enBaseText || text);
  if (enText && !/^[a-z0-9_.-]+(?:\.[a-z0-9]+|:)/i.test(enText)) {
    enText = enText.charAt(0).toUpperCase() + enText.slice(1);
  }

  const formatCompact = (str, lim) => {
    if (!str) return { compact: '', full: '' };
    const full = str.length > 140 ? truncateAtCleanBoundary(str, 140) : str;
    let compact = '';
    if (str.length <= lim) {
      compact = str;
    } else {
      const sepMatch = /^(.+?)\s+(?:—|–|:)\s+(.+)$/.exec(str);
      if (sepMatch && sepMatch[1].trim().length >= 5 && sepMatch[1].trim().length <= lim) {
        const head = sepMatch[1].trim();
        const tailWords = sepMatch[2].trim().split(/\s+/).filter(Boolean);
        const firstJoined = tailWords.length > 0 ? `${head} · ${tailWords[0]}` : head;
        compact = firstJoined.length <= lim ? truncateAtCleanBoundary(str, lim) : head;
      } else {
        compact = truncateAtCleanBoundary(str, lim);
      }
    }
    return { compact, full };
  };

  const limit = Math.min(32, Math.max(8, Number(maxChars) || 30));
  const ruCompact = formatCompact(text, limit);
  const enCompact = formatCompact(enText || localizeProgressLabelToEn(text), limit);

  return {
    title: ruCompact.compact,
    fullTitle: ruCompact.full,
    titleEn: enCompact.compact || ruCompact.compact,
    fullTitleEn: enCompact.full || ruCompact.full,
  };
}

/**
 * Extracts the primary function, class, or exported constant identifier from an edit snippet.
 */
export function extractPrimarySymbolFromSnippet(snippet = '') {
  const src = String(snippet || '');
  if (!src.trim()) return '';

  const patterns = [
    /(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:function\*?|class)\s+([A-Za-z_$][A-Za-z0-9_$]{1,40})\b/,
    /(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]{1,40})\s*=\s*(?:async\s*)?(?:\(|[A-Za-z_$][A-Za-z0-9_$]*\s*=>|function\b|class\b)/,
    /\b(?:def|fn|func)\s+([A-Za-z_][A-Za-z0-9_]{1,40})\s*(?:\(|<)/,
    /^\s*(?:(?:public|private|protected)\s+)?(?:static\s+)?(?:async\s+)?([A-Za-z_$][A-Za-z0-9_$]{2,40})\s*\([^)\n]*\)\s*(?::\s*[A-Za-z0-9_<>\[\]| ]+)?\s*\{/m,
    /(?:export\s+)?(?:const|let)\s+([A-Za-z_$][A-Za-z0-9_$]{2,40})\s*=/,
  ];

  for (const re of patterns) {
    const m = re.exec(src);
    if (m && m[1]) {
      const sym = m[1].trim();
      if (!IGNORED_AST_SYMBOLS.has(sym.toLowerCase())) {
        return sym.length > 22 ? `${sym.slice(0, 21)}…` : sym;
      }
    }
  }
  return '';
}

/**
 * Extracts explicitly named code/test files from user prompt or text.
 */
export function extractTargetFilesFromText(text = '') {
  let clean = String(text || '');
  clean = clean
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, ' ')
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, ' ')
    .replace(/<SYSTEM_MESSAGE>[\s\S]*?<\/SYSTEM_MESSAGE>/gi, ' ')
    .replace(/https?:\/\/\S+/gi, ' ');

  const re = new RegExp(`(?<![A-Za-z0-9_.-])(?:[A-Za-z0-9_.-]+[\\\\/])*([A-Za-z0-9_.-]+\\.${STEP_CODE_EXT_RE})\\b`, 'gi');
  const seen = new Set();
  const codeFiles = [];
  const testFiles = [];

  let m;
  while ((m = re.exec(clean)) !== null) {
    const base = sanitizeFileBasename(m[1]);
    if (!base) continue;
    const key = base.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (TEST_FILE_RE.test(base)) {
      testFiles.push(base);
    } else {
      codeFiles.push(base);
    }
  }

  return {
    allFiles: [...codeFiles, ...testFiles],
    codeFiles,
    testFiles,
  };
}

/**
 * Formats a list of target filenames compactly (e.g. `server.mjs, ui.html +1`).
 */
export function formatTargetFilesCompact(files = [], maxLen = 22) {
  const unique = [];
  const seen = new Set();
  for (const raw of Array.isArray(files) ? files : []) {
    const base = sanitizeFileBasename(raw);
    if (!base) continue;
    const k = base.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(base);
  }
  if (unique.length === 0) return '';
  if (unique.length === 1) {
    return unique[0].length <= maxLen ? unique[0] : truncateAtCleanBoundary(unique[0], maxLen);
  }

  const picked = [];
  for (let i = 0; i < unique.length; i++) {
    const candidateList = [...picked, unique[i]];
    const remaining = unique.length - candidateList.length;
    const suffix = remaining > 0 ? ` +${remaining}` : '';
    const joined = candidateList.join(', ') + suffix;
    if (joined.length <= maxLen || picked.length === 0) {
      picked.push(unique[i]);
      if (joined.length > maxLen && picked.length === 1) break;
    } else {
      break;
    }
  }

  const rem = unique.length - picked.length;
  const suffix = rem > 0 ? ` +${rem}` : '';
  const result = picked.join(', ') + suffix;
  if (result.length <= maxLen) return result;

  const singleBudget = Math.max(8, maxLen - suffix.length);
  return `${truncateAtCleanBoundary(picked[0], singleBudget)}${suffix}`;
}

export function classifyScopeTargets(matchedFiles = [], userPrompt = '') {
  const fromPrompt = extractTargetFilesFromText(userPrompt);
  const seen = new Set();
  const codeFiles = [];
  const testFiles = [];

  const pushFile = (raw) => {
    const base = sanitizeFileBasename(raw);
    if (!base) return;
    const key = base.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    if (TEST_FILE_RE.test(base)) {
      testFiles.push(base);
    } else {
      codeFiles.push(base);
    }
  };

  for (const f of Array.isArray(matchedFiles) ? matchedFiles : []) pushFile(f);
  for (const f of fromPrompt.allFiles) pushFile(f);

  return {
    codeFiles,
    testFiles,
    editTargets: codeFiles.length > 0 ? codeFiles : testFiles,
    allFiles: [...codeFiles, ...testFiles],
  };
}

const RECON_CMD_RE = /^(?:(?:cd|pushd|Set-Location|sl)\s+[^;&|\n]+[;&|]+\s*)*(?:git\s+(?:status|diff|log|show|grep|branch|rev-parse|ls-files)|rg|grep|ag|ack|Select-String|sls|Get-ChildItem|gci|ls|dir|Get-Content|gc|cat|type|head|tail|find|fd|tree|where|which|Get-Item|gi|Test-Path|stat)\b/i;
const STRICT_TEST_RUNNER_RE = /\b(?:node\s+(?:[^\n;|]*?\s)?--(?:test|check)\b|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|check|lint|typecheck|verify)\b|pytest\b|vitest\b|jest\b|mocha\b|cargo\s+(?:test|check)\b|go\s+test\b|dotnet\s+test\b|tsc\b[^\n;|]*--noEmit|run-stress-audit\.mjs\b)/i;
const TEST_EXEC_PREFIX_RE = /^(?:(?:cd|pushd|Set-Location|sl)\s+[^;&|\n]+[;&|]+\s*)*(?:node|python3?|tsx|ts-node|npx|bun|deno|vitest|jest|pytest|mocha)\b/i;

export function formatCommandStepLabel(commandLine = '', toolSummary = '', isPost = false) {
  const cmd = String(commandLine || '').trim();
  const hasTestRunner = STRICT_TEST_RUNNER_RE.test(cmd);
  const isReconCmd = !hasTestRunner && RECON_CMD_RE.test(cmd);
  const isTestCmd = !isReconCmd && hasTestRunner;

  // 1. Explicit test filename ONLY when executed by a test runner or interpreter (never for ls/rg/Get-ChildItem)
  const testFileMatch = !isReconCmd && (isTestCmd || TEST_EXEC_PREFIX_RE.test(cmd))
    ? /(?:^|[\s"'\\/])([A-Za-z0-9_.-]+\.(?:test|spec)\.[A-Za-z0-9]+|test_[A-Za-z0-9_]+\.py)\b/i.exec(cmd)
    : null;
  if (testFileMatch && testFileMatch[1]) {
    const tf = sanitizeFileBasename(testFileMatch[1]);
    const base = compactTechnicalStepLabel(`Тест ${tf}`, 30);
    return {
      title: base.title,
      postTitle: isPost ? `Тест ${tf} ✓` : base.title,
      fullTitle: `${isPost ? 'Проверено' : 'Запуск тестов'}: ${tf}`,
      isTestCmd: true,
      isReconCmd: false,
    };
  }

  // 2. Named script execution (e.g. `node install.js`, `python build.py`)
  let scriptMatch = null;
  if (!isReconCmd) {
    const execArgsMatch = /(?:^|\s)(?:node|python3?|tsx|ts-node|pwsh|bash)\s+([^\n"'|;>&]+)/i.exec(cmd);
    if (execArgsMatch) {
      const tokens = execArgsMatch[1].trim().split(/\s+/);
      for (const tok of tokens) {
        if (!tok || tok.startsWith('-')) continue;
        const mFile = /^([^\s"'|;>&]+\.(?:mjs|cjs|js|ts|py|sh|ps1))\b/i.exec(tok);
        if (mFile) {
          scriptMatch = mFile;
        }
        break;
      }
    }
  }
  if (scriptMatch && scriptMatch[1]) {
    const sf = sanitizeFileBasename(scriptMatch[1]);
    const lbl = compactTechnicalStepLabel(`Запуск ${sf}`, 30);
    return {
      title: lbl.title,
      postTitle: isPost ? `${sf} выполнен ✓` : lbl.title,
      fullTitle: `Команда: ${sf}${toolSummary ? ` (${toolSummary})` : ''}`.slice(0, 140),
      isTestCmd,
      isReconCmd: false,
    };
  }

  // 3. Test runner without single file
  if (isTestCmd) {
    const runnerMatch = /\b(pytest|vitest|jest|mocha|cargo\s+test|go\s+test|npm\s+test|node\s+--test)\b/i.exec(cmd);
    const runner = runnerMatch ? runnerMatch[1].replace(/\s+/g, ' ') : 'автотесты';
    const lbl = compactTechnicalStepLabel(`Тесты: ${runner}`, 30);
    return {
      title: lbl.title,
      postTitle: isPost ? 'Проверки пройдены · финализация' : lbl.title,
      fullTitle: toolSummary ? `${toolSummary} (${runner})` : `Прогон тестов (${runner})`,
      isTestCmd: true,
      isReconCmd: false,
    };
  }

  // 4. Russian/clean toolSummary
  if (toolSummary) {
    const lbl = compactTechnicalStepLabel(toolSummary, 30);
    if (lbl.title) {
      return {
        title: lbl.title,
        postTitle: isPost ? 'Команда выполнена' : lbl.title,
        fullTitle: lbl.fullTitle,
        isTestCmd: false,
        isReconCmd,
      };
    }
  }

  // 5. Fallback binary + subcommand
  const binMatch = /^([A-Za-z0-9_.-]+)(?:\s+([A-Za-z0-9_.:/-]+))?/.exec(cmd);
  if (binMatch) {
    const cliStr = binMatch[2] && !binMatch[2].startsWith('-') ? `${binMatch[1]} ${binMatch[2]}` : binMatch[1];
    const lbl = compactTechnicalStepLabel(`CLI: ${cliStr}`, 30);
    return {
      title: lbl.title,
      postTitle: isPost ? 'Команда выполнена' : lbl.title,
      fullTitle: `Терминал: ${cmd.slice(0, 120)}`,
      isTestCmd: false,
      isReconCmd,
    };
  }

  return {
    title: 'Команда терминала',
    postTitle: isPost ? 'Команда выполнена' : 'Команда терминала',
    fullTitle: 'Выполнение команды терминала',
    isTestCmd: false,
    isReconCmd,
  };
}

/**
 * Parses top-level steps from an `exit_plan_mode` markdown plan, excluding `Re-plan if:` tails.
 */
export function extractStepsFromPlanText(planText = '', maxSteps = 24) {
  const raw = String(planText || '').replace(/\r\n/g, '\n').trim();
  if (!raw) return [];

  // Strip trailing emergency / notes blocks so they never leak into progress chips
  const cutMatch = /^(?:#{1,4}\s*)?(?:re-plan\s+if\b|перепланировать\b|pitfalls\b|подводные\s+камни\b)/im.exec(raw);
  const body = cutMatch ? raw.slice(0, cutMatch.index).trim() : raw;
  if (!body) return [];

  const headingItems = [];
  const headingRe = /^#{1,4}\s*(?:(?:step|шаг|этап)\s*\d+\s*[.:—–-]\s*|\d+[.)]\s+)(.+)$/gim;
  let hm;
  while ((hm = headingRe.exec(body)) !== null) {
    const txt = String(hm[1] || '').trim();
    if (txt.length >= 4) headingItems.push(txt);
  }

  let selectedRaw = [];
  if (headingItems.length >= 2) {
    selectedRaw = headingItems;
  } else {
    const listItems = [];
    const listRe = /^ {0,2}(\d+)[.)]\s+(.+)$/gm;
    let lm;
    while ((lm = listRe.exec(body)) !== null) {
      const txt = String(lm[2] || '').trim();
      if (txt.length >= 4) listItems.push(txt);
    }
    if (listItems.length >= 2) {
      selectedRaw = listItems;
    }
  }

  if (selectedRaw.length < 2) return [];

  const cap = Math.max(2, Math.min(MAX_TIMELINE_STEPS, Number(maxSteps) || 24));
  if (selectedRaw.length > cap) {
    selectedRaw = [...selectedRaw.slice(0, cap - 1), selectedRaw[selectedRaw.length - 1]];
  }

  const out = [];
  for (const rawItem of selectedRaw) {
    const compacted = compactTechnicalStepLabel(rawItem, 30);
    if (!compacted.title) continue;
    out.push({
      index: out.length + 1,
      title: compacted.title,
      fullTitle: compacted.fullTitle || compacted.title,
      titleEn: compacted.titleEn || localizeProgressLabelToEn(compacted.title),
      fullTitleEn: compacted.fullTitleEn || localizeProgressLabelToEn(compacted.fullTitle || compacted.title),
      source: 'plan',
      status: out.length === 0 ? 'running' : 'pending',
    });
  }

  return out.length >= 2 ? out : [];
}

/**
 * Normalizes an Antigravity `update_steps` checklist payload into progress timeline steps.
 */
export function normalizeChecklistSteps(rawSteps = []) {
  let list = rawSteps;
  if (typeof list === 'string') {
    try { list = JSON.parse(list); } catch { list = []; }
  }
  if (!Array.isArray(list) || list.length === 0) return [];

  const out = [];
  for (const item of list) {
    if (out.length >= MAX_TIMELINE_STEPS) break;
    const rawTitle = typeof item === 'string'
      ? item.trim()
      : String(item?.title || item?.label || item?.name || '').trim();
    if (!rawTitle) continue;
    const rawSt = String(item?.status || 'pending').trim().toLowerCase();
    let status = 'pending';
    if (rawSt === 'done' || rawSt === 'completed' || rawSt === 'skipped') {
      status = 'completed';
    } else if (rawSt === 'in_progress' || rawSt === 'running' || rawSt === 'active') {
      status = 'running';
    } else if (rawSt === 'failed' || rawSt === 'error') {
      status = 'error';
    }
    const compacted = compactTechnicalStepLabel(rawTitle, 30);
    out.push({
      index: out.length + 1,
      title: compacted.title || rawTitle.slice(0, 30),
      fullTitle: rawTitle.slice(0, 140),
      titleEn: compacted.titleEn || localizeProgressLabelToEn(compacted.title || rawTitle.slice(0, 30)),
      fullTitleEn: localizeProgressLabelToEn(rawTitle.slice(0, 140)),
      source: 'checklist',
      status,
      ...(rawSt === 'skipped' ? { skipped: true } : {}),
    });
  }
  return out;
}

export function formatMcpToolSubtitle(toolName = '', args = {}) {
  const t = String(toolName || '');
  const f = args?.filePath || args?.Path || args?.path || '';
  const shortF = sanitizeFileBasename(f);
  const rawSummary = String(args?.toolSummary || '').trim();
  const rawQuery = String(args?.query || args?.prompt || '').trim();
  const qCompact = rawQuery ? truncateAtCleanBoundary(rawQuery, 18) : '';

  if (t === 'update_steps') return 'Обновление чек-листа';
  if (t.includes('ram_slice')) return shortF ? `RAM-срез ${shortF}` : 'Чтение среза в RAM';
  if (t.includes('ram_search')) return qCompact ? `RAM-поиск: ${qCompact}` : 'Быстрый поиск в RAM';
  if (t.includes('ram_graph_query')) return 'Анализ графа связей в RAM';
  if (t.includes('ram_context_pack')) {
    return rawSummary ? compactTechnicalStepLabel(rawSummary, 30).title : 'Сборка контекста в RAM';
  }
  if (t.includes('gpu_semantic_search')) return qCompact ? `GPU-поиск: ${qCompact}` : 'Семантический поиск GPU';
  if (t.includes('gpu_distill')) return shortF ? `GPU-сжатие ${shortF}` : 'Дистилляция на GPU';
  if (t === 'read_file') return shortF ? `Чтение ${shortF}` : 'Чтение файла';
  if (t === 'edit_file' || t === 'write_file') return shortF ? `Правка ${shortF}` : 'Внесение изменений';
  if (t === 'run_command') {
    return formatCommandStepLabel(args?.CommandLine || args?.command || args?.cmd || '', rawSummary, false).title;
  }
  if (t === 'exit_plan_mode') return 'Фиксация плана работ';
  if (rawSummary) return compactTechnicalStepLabel(rawSummary, 30).title;
  return '';
}

export function resolveTranscriptBirthMs(transcriptPath = '', fallbackNow = Date.now()) {
  if (!transcriptPath || typeof transcriptPath !== 'string' || !existsSync(transcriptPath)) {
    return fallbackNow;
  }
  try {
    const st = statSync(transcriptPath);
    return Math.round(st.birthtimeMs || fallbackNow);
  } catch {
    return fallbackNow;
  }
}

const SKILL_PATH_RE = /(?:^|[\\/])skills[\\/]([a-z0-9._-]+)[\\/]SKILL\.md$/i;
export const RAM_GPU_TOOL_RE = /(?:ram_search|ram_slice|ram_context_pack|ram_graph_query|ram_stats|gpu_distill|gpu_semantic_search)/i;
export const RAM_SAVED_TOKENS_PER_CALL = 650;

export function extractSkillSlugFromPath(rawPath = '') {
  const clean = String(rawPath || '').replace(/^@file:/i, '').trim();
  if (!clean) return '';
  const m = SKILL_PATH_RE.exec(clean);
  return m && m[1] ? m[1] : '';
}

const MAX_PUBLIC_BACKGROUND_TASKS = 25;
const MAX_TASK_LOGS_TO_SCAN = 60;
const STALE_BG_TASK_TTL_MS = 10 * 60 * 1000;
const STALE_DAEMON_BG_TASK_TTL_MS = 6 * 60 * 60 * 1000;

function parseTranscriptEntryTs(entry, fallback = 0) {
  const raw = entry?.created_at || entry?.timestamp || '';
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.round(raw);
  if (typeof raw === 'string' && raw) {
    const ms = Date.parse(raw);
    if (Number.isFinite(ms)) return Math.round(ms);
  }
  return fallback;
}

function unwrapTranscriptStringArg(raw = '') {
  let s = String(raw ?? '').trim();
  if (!s) return '';
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    try {
      const parsed = JSON.parse(s);
      if (typeof parsed === 'string') return parsed.trim();
    } catch {}
  }
  s = s.replace(/^["']+/, '').replace(/["']+$/, '');
  return s.replace(/\\"/g, '"').trim();
}

function extractGenericToolOutputBody(content = '') {
  const lines = String(content || '').replace(/\r\n/g, '\n').split('\n');
  let idx = 0;
  let hasCompletedAt = false;
  while (idx < lines.length && idx < 4) {
    const trimmed = lines[idx].trim();
    if (/^Created At:\s*/i.test(trimmed)) {
      idx += 1;
      continue;
    }
    if (/^Completed At:\s*/i.test(trimmed)) {
      hasCompletedAt = true;
      idx += 1;
      continue;
    }
    break;
  }
  return { body: lines.slice(idx).join('\n').trimStart(), hasCompletedAt };
}

function isCodeOrFileReadPayload(body = '') {
  if (!body) return false;
  if (
    body.startsWith('// [RAM Lines ') ||
    body.startsWith('[🎮 ') ||
    body.startsWith('Showing lines ') ||
    body.startsWith('Partial read (') ||
    body.startsWith('Made ') ||
    body.startsWith('### `')
  ) {
    return true;
  }
  if (body.startsWith("The tool's output was truncated") && (/^\s*L\d+:\s/m.test(body) || /^\s*\d+:\s/m.test(body))) {
    return true;
  }
  return false;
}

function classifyBgTerminalStatus(rawText = '', defaultStatus = 'done') {
  const s = String(rawText || '').toLowerCase();
  if (/\b(?:failed|error|errored)\b|finished with error:/i.test(s)) return 'error';
  if (/\b(?:killed|cancelled|canceled|stopped|terminated|aborted)\b/i.test(s)) return 'cancelled';
  if (/\b(?:finished|completed|done|exited)\b|finished with result:/i.test(s)) return 'done';
  return defaultStatus;
}

function sanitizeBgPreviewText(raw = '', maxLen = 120) {
  const clean = redactSecretsInText(String(raw || ''))
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return '';
  return clean.length > maxLen ? `${clean.slice(0, Math.max(8, maxLen - 1)).trimEnd()}…` : clean;
}

function readBoundedLogHeadAndTail(filePath, maxHeadBytes = 512, maxTailBytes = 1024) {
  let st;
  try {
    st = statSync(filePath);
  } catch {
    return null;
  }
  const size = Number(st.size || 0);
  let fd = null;
  let headText = '';
  let tailText = '';
  try {
    if (size > 0) {
      fd = openSync(filePath, 'r');
      const headLen = Math.min(size, maxHeadBytes);
      const headBuf = Buffer.allocUnsafe(headLen);
      readSync(fd, headBuf, 0, headLen, 0);
      headText = headBuf.toString('utf-8');

      if (size <= maxHeadBytes) {
        tailText = headText;
      } else {
        const tailLen = Math.min(size, maxTailBytes);
        const tailBuf = Buffer.allocUnsafe(tailLen);
        readSync(fd, tailBuf, 0, tailLen, size - tailLen);
        tailText = tailBuf.toString('utf-8');
      }
    }
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch {}
    }
  }
  return {
    size,
    birthtimeMs: Math.round(Number(st.birthtimeMs || st.mtimeMs || 0)),
    mtimeMs: Math.round(Number(st.mtimeMs || 0)),
    headText,
    tailText,
  };
}

function inferBgStatusFromLogTail(tailText = '') {
  const s = String(tailText || '');
  if (!s) return '';
  if (/\bexit(?:ed)?(?:\s+with)?\s+(?:code|status)[:=\s]+0\b/i.test(s)) return 'done';
  if (/\bexit(?:ed)?(?:\s+with)?\s+(?:code|status)[:=\s]+[1-9]\d*\b/i.test(s)) return 'error';
  if (/\b(?:killed|cancelled|canceled|terminated|aborted)\b/i.test(s)) return 'cancelled';
  if (/\b(?:completed|finished)\b/i.test(s)) return 'done';
  return '';
}

function extractBgLabelFromLogHead(headText = '') {
  const lines = String(headText || '').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const cmdMatch = /^(?:command|cmd|description|task)\s*:\s*(.+)$/i.exec(line);
    if (cmdMatch?.[1]) return sanitizeBgPreviewText(cmdMatch[1], 110);
    const cleaned = line.replace(/^[>$#]\s*/, '').trim();
    if (cleaned.length >= 3) return sanitizeBgPreviewText(cleaned, 110);
  }
  return '';
}

function scanConversationBackgroundTaskLogs(transcriptPath, bgTasksMap, upsertBgTask) {
  try {
    const tasksDir = join(dirname(dirname(transcriptPath)), 'tasks');
    if (!existsSync(tasksDir)) return;
    const entries = readdirSync(tasksDir, { withFileTypes: true });
    const logCandidates = [];
    for (const d of entries) {
      if (!d.isFile()) continue;
      const m = /^task-(.+)\.log$/i.exec(d.name);
      if (!m?.[1]) continue;
      const fullPath = join(tasksDir, d.name);
      let st;
      try {
        st = statSync(fullPath);
      } catch {
        continue;
      }
      logCandidates.push({
        taskId: m[1].trim(),
        fullPath,
        mtimeMs: Math.round(Number(st.mtimeMs || 0)),
        birthtimeMs: Math.round(Number(st.birthtimeMs || st.mtimeMs || 0)),
      });
    }
    if (logCandidates.length === 0) return;
    logCandidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const slice = logCandidates.slice(0, MAX_TASK_LOGS_TO_SCAN);

    for (const item of slice) {
      const sample = readBoundedLogHeadAndTail(item.fullPath, 512, 1024);
      if (!sample) continue;
      const tailStatus = inferBgStatusFromLogTail(sample.tailText);
      let matchedKey = '';
      if (bgTasksMap.has(item.taskId)) {
        matchedKey = item.taskId;
      } else {
        for (const existingKey of bgTasksMap.keys()) {
          if (existingKey.endsWith(`/${item.taskId}`) || existingKey.endsWith(`-${item.taskId}`) || existingKey === `task-${item.taskId}`) {
            matchedKey = existingKey;
            break;
          }
        }
      }

      if (matchedKey) {
        const prev = bgTasksMap.get(matchedKey);
        const nextStatus = prev.status === 'running' && tailStatus ? tailStatus : prev.status;
        const headHint = !prev.commandPreview ? extractBgLabelFromLogHead(sample.headText) : '';
        upsertBgTask(matchedKey, {
          status: nextStatus,
          ...(headHint ? { commandPreview: headHint } : {}),
          startedAt: prev.startedAt || sample.birthtimeMs || sample.mtimeMs,
          updatedAt: Math.max(prev.updatedAt || 0, sample.mtimeMs),
        });
      } else {
        const headHint = extractBgLabelFromLogHead(sample.headText);
        const formatted = headHint ? formatCommandStepLabel(headHint, '', false).title : '';
        const label = formatted || headHint || `Задача ${item.taskId.slice(0, 8)}`;
        upsertBgTask(item.taskId, {
          status: tailStatus || 'done',
          label,
          commandPreview: headHint || label,
          isDaemon: false,
          startedAt: sample.birthtimeMs || sample.mtimeMs,
          updatedAt: sample.mtimeMs,
        });
      }
    }
  } catch {}
}

export function inspectTranscriptTurnState(transcriptPath = '', now = Date.now(), opts = {}) {
  const hostBootAt = Math.max(0, Number(opts?.hostBootAt || 0));
  if (!transcriptPath || typeof transcriptPath !== 'string' || !existsSync(transcriptPath)) {
    return { exists: false };
  }
  let st;
  try {
    st = statSync(transcriptPath);
  } catch {
    return { exists: false };
  }
  if (!st.size) return { exists: true, mtimeMs: st.mtimeMs, size: 0, state: 'empty', stepKey: '' };

  const tailBytes = Math.min(st.size, 65536);
  const buf = Buffer.allocUnsafe(tailBytes);
  let fd = null;
  try {
    fd = openSync(transcriptPath, 'r');
    readSync(fd, buf, 0, tailBytes, st.size - tailBytes);
  } catch {
    return { exists: false };
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch {}
    }
  }

  const rawText = buf.toString('utf-8');
  const rawLines = rawText.split('\n');
  const startIdx = st.size > tailBytes ? 1 : 0;
  const parsed = [];
  for (let i = startIdx; i < rawLines.length; i++) {
    const line = rawLines[i].trim();
    if (!line) continue;
    try {
      parsed.push(JSON.parse(line));
    } catch {}
  }
  if (parsed.length === 0) {
    return { exists: true, mtimeMs: st.mtimeMs, size: st.size, state: 'active', stepKey: '' };
  }

  let lastUserIdx = -1;
  let lastUserPrompt = '';
  for (let i = parsed.length - 1; i >= 0; i--) {
    if (parsed[i]?.type === 'USER_INPUT') {
      lastUserIdx = i;
      lastUserPrompt = String(parsed[i]?.content || '');
      break;
    }
  }

  let plannerToolSteps = 0;
  let latestToolSubtitle = '';
  let detectedWorkspace = '';
  let extractedPlanSteps = [];
  let latestChecklistSteps = [];
  let ranTestLabel = '';
  const inspectedFiles = [];
  const searchQueries = [];
  const editedFiles = [];
  const askedQuestions = [];
  const activeSkills = [];
  let ramSavedCalls = 0;
  const spawnedSubagentRoles = {};
  const swarmNameToCids = new Map();
  const killedSubagentCids = new Set();
  const killedSwarmNames = new Set();
  const backgroundTasksMap = new Map();
  const pendingRunCommands = [];
  let bgSeq = 0;
  let killedAllSubagents = false;
  let coordinatorPostedDone = false;
  let allSubagentsStoppedByRestart = false;

  const upsertBgTask = (rawId, patch = {}) => {
    const id = String(rawId || '').trim();
    if (!id) return;
    const prev = backgroundTasksMap.get(id);
    const nextSeq = prev ? prev.seq : ++bgSeq;
    const prevStarted = Number(prev?.startedAt || 0);
    const patchStarted = Number(patch.startedAt || 0);
    const prevUpdated = Number(prev?.updatedAt || 0);
    const patchUpdated = Number(patch.updatedAt || 0);
    const nextLabel = unwrapTranscriptStringArg(patch.label || prev?.label || 'Фоновая задача')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'Фоновая задача';
    const nextPreview = unwrapTranscriptStringArg(patch.commandPreview || prev?.commandPreview || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
    backgroundTasksMap.set(id, {
      taskId: id,
      label: nextLabel,
      commandPreview: nextPreview,
      description: nextPreview || nextLabel,
      status: patch.status || prev?.status || 'running',
      isDaemon: typeof patch.isDaemon === 'boolean' ? patch.isDaemon : Boolean(prev?.isDaemon),
      startedAt: prevStarted > 0 ? prevStarted : patchStarted,
      updatedAt: Math.max(prevUpdated, patchUpdated, patchStarted),
      seq: nextSeq,
    });
  };

  // Cross-turn scan of Swarm / subagent roster, kills, background tasks, and server-restart stop notices
  for (let i = 0; i < parsed.length; i++) {
    const entry = parsed[i];
    if (!entry) continue;
    const entryTs = parseTranscriptEntryTs(entry, 0);
    if (entry.source === 'SYSTEM' && typeof entry.content === 'string') {
      if (/All your subagents and background tasks have been stopped/i.test(entry.content)) {
        allSubagentsStoppedByRestart = true;
        for (const [bgId, bgVal] of backgroundTasksMap.entries()) {
          if (bgVal.status === 'running') {
            upsertBgTask(bgId, { status: 'cancelled', updatedAt: entryTs || bgVal.updatedAt });
          }
        }
      } else {
        const finIdMatch = /Task id\s+"([^"]+)"\s+(finished|completed|failed|killed|cancelled|canceled|stopped|exited|terminated)/i.exec(entry.content);
        const senderFinMatch = /sender=([^\s]+)[\s\S]*?(finished with (?:result|error):|task\s+(?:completed|failed|killed|cancelled|canceled|stopped|exited|terminated))/i.exec(entry.content);
        if (finIdMatch?.[1]) {
          const finId = finIdMatch[1].trim();
          const hasNonZeroExit = /Command exited with code\s+[1-9]\d*/i.test(entry.content);
          upsertBgTask(finId, {
            status: hasNonZeroExit ? 'error' : classifyBgTerminalStatus(finIdMatch[2], 'done'),
            updatedAt: entryTs || undefined,
          });
        }
        if (senderFinMatch?.[1]) {
          const senderId = senderFinMatch[1].trim();
          if (backgroundTasksMap.has(senderId)) {
            const hasNonZeroExit = /Command exited with code\s+[1-9]\d*/i.test(entry.content);
            upsertBgTask(senderId, {
              status: hasNonZeroExit ? 'error' : classifyBgTerminalStatus(senderFinMatch[2], 'done'),
              updatedAt: entryTs || undefined,
            });
          }
        }
        if (!finIdMatch && !senderFinMatch) {
          const stillRunningMatch = /sender=([^\s]+)[\s\S]*?Background command is still running(?:\s+after\s+\d+s)?:\s*([^\r\n<]*)/i.exec(entry.content);
          if (stillRunningMatch?.[1]) {
            const bgId = stillRunningMatch[1].trim();
            const bgDesc = String(stillRunningMatch[2] || '').replace(/\s+Task logs are available at:.*$/i, '').trim().slice(0, 160);
            const prevBg = backgroundTasksMap.get(bgId);
            const safePreview = sanitizeBgPreviewText(bgDesc, 120);
            const niceLabel = (!prevBg?.label && safePreview)
              ? (formatCommandStepLabel(safePreview, '', false).title || safePreview)
              : '';
            upsertBgTask(bgId, {
              status: 'running',
              ...(niceLabel ? { label: niceLabel } : {}),
              ...(!prevBg?.commandPreview && safePreview ? { commandPreview: safePreview } : {}),
              updatedAt: entryTs || undefined,
            });
          }
        }
      }
      continue;
    }
    if (entry.type === 'PLANNER_RESPONSE' && Array.isArray(entry.tool_calls)) {
      for (const tc of entry.tool_calls) {
        const tName = String(tc?.name || '');
        const tArgs = tc?.args && typeof tc.args === 'object' ? tc.args : {};
        if (tName === 'run_command') {
          const rawDaemon = unwrapTranscriptStringArg(tArgs.IsDaemon ?? tArgs.isDaemon ?? '').toLowerCase();
          pendingRunCommands.push({
            summary: unwrapTranscriptStringArg(tArgs.toolSummary || '').replace(/\s+/g, ' ').trim().slice(0, 120),
            command: unwrapTranscriptStringArg(tArgs.CommandLine || tArgs.command || tArgs.cmd || '').trim(),
            isDaemon: tArgs.IsDaemon === true || tArgs.isDaemon === true || rawDaemon === 'true',
            createdAt: entryTs,
          });
          if (pendingRunCommands.length > 20) pendingRunCommands.shift();
        } else if (tName === 'invoke_subagent') {
          allSubagentsStoppedByRestart = false;
          killedAllSubagents = false;
        } else if (tName === 'manage_task') {
          const mtAct = String(tArgs.Action || tArgs.action || '').replace(/^["'\s]+|["'\s]+$/g, '').toLowerCase();
          const mtId = String(tArgs.TaskId || tArgs.taskId || '').replace(/^["'\s]+|["'\s]+$/g, '').trim();
          if (mtAct === 'kill' && mtId) {
            upsertBgTask(mtId, { status: 'cancelled', updatedAt: entryTs || undefined });
          }
        } else if (tName === 'swarm') {
          const act = String(tArgs.action || '').replace(/^["'\s]+|["'\s]+$/g, '').toLowerCase();
          const rawMember = String(tArgs.name || '').replace(/^["'\s]+|["'\s]+$/g, '').toLowerCase();
          if (act === 'add') {
            allSubagentsStoppedByRestart = false;
            killedAllSubagents = false;
            coordinatorPostedDone = false;
            if (rawMember) {
              for (const k of Array.from(killedSwarmNames)) {
                if (k === rawMember || k.startsWith(`${rawMember}-`)) killedSwarmNames.delete(k);
              }
            }
          } else if (act === 'kill' && rawMember) {
            killedSwarmNames.add(rawMember);
            for (const [mName, cids] of swarmNameToCids.entries()) {
              if (mName === rawMember || mName.startsWith(`${rawMember}-`)) {
                for (const kc of cids) killedSubagentCids.add(kc);
              }
            }
          }
        } else if (tName === 'manage_subagents') {
          const mAct = String(tArgs.Action || tArgs.action || '').replace(/^["'\s]+|["'\s]+$/g, '').toLowerCase();
          if (mAct === 'kill_all') {
            killedAllSubagents = true;
            for (const sc of Object.keys(spawnedSubagentRoles)) killedSubagentCids.add(sc);
          } else if (mAct === 'kill') {
            let ids = tArgs.ConversationIds ?? tArgs.conversationIds;
            if (typeof ids === 'string') {
              try { ids = JSON.parse(ids); } catch { ids = []; }
            }
            if (Array.isArray(ids)) {
              for (const rawId of ids) {
                const normId = normalizeConversationId(rawId);
                if (normId && normId !== 'default') killedSubagentCids.add(normId);
              }
            }
          }
        } else if (tName === 'post_message') {
          const pTxt = String(tArgs.text || '').replace(/^["'\s]+|["'\s]+$/g, '');
          if (/^\[done\]/i.test(pTxt)) {
            coordinatorPostedDone = true;
          }
        }
      }
    } else if (entry.type === 'GENERIC' && typeof entry.content === 'string') {
      const { body: gBody, hasCompletedAt } = extractGenericToolOutputBody(entry.content);
      const isCodeDump = isCodeOrFileReadPayload(gBody);
      const entryStatusUpper = String(entry.status || '').toUpperCase();
      const bgStartMatch = (!isCodeDump && !(hasCompletedAt && entryStatusUpper === 'DONE'))
        ? /^Tool is running as a background task with task id:\s*([A-Za-z0-9_./:-]+)/i.exec(gBody)
        : null;
      if (bgStartMatch?.[1]) {
        const bgTaskId = bgStartMatch[1].trim();
        const gHead = gBody.slice(0, 500);
        const bgDescMatch = /^Task Description:\s*([^\r\n]+)/im.exec(gHead);
        const bgDesc = String(bgDescMatch?.[1] || '').replace(/\s+Task logs are available at:.*$/i, '').trim().slice(0, 160);
        let pairedCmd = null;
        if (pendingRunCommands.length > 0) {
          const normDesc = bgDesc.replace(/\s+/g, ' ').trim();
          let matchIdx = -1;
          if (normDesc) {
            for (let pi = pendingRunCommands.length - 1; pi >= 0; pi--) {
              const normCmd = String(pendingRunCommands[pi]?.command || '').replace(/\s+/g, ' ').trim();
              if (normCmd && (normCmd === normDesc || normCmd.includes(normDesc) || normDesc.includes(normCmd))) {
                matchIdx = pi;
                break;
              }
            }
          }
          pairedCmd = matchIdx !== -1 ? pendingRunCommands.splice(matchIdx, 1)[0] : pendingRunCommands.pop();
        }
        const safePreview = sanitizeBgPreviewText(pairedCmd?.command || bgDesc, 120);
        const cmdFormatted = bgDesc ? formatCommandStepLabel(bgDesc, '', false).title : (pairedCmd?.command ? formatCommandStepLabel(pairedCmd.command, '', false).title : '');
        const bgLabel = (pairedCmd?.summary)
          || (bgDesc && !/^[a-z0-9_.-]+[\\/]/i.test(bgDesc) && bgDesc.length <= 96 ? sanitizeBgPreviewText(bgDesc, 110) : '')
          || cmdFormatted
          || sanitizeBgPreviewText(bgDesc, 110)
          || 'Фоновая задача';
        upsertBgTask(bgTaskId, {
          status: 'running',
          label: bgLabel,
          commandPreview: safePreview || bgLabel,
          isDaemon: Boolean(pairedCmd?.isDaemon),
          startedAt: entryTs || pairedCmd?.createdAt || undefined,
          updatedAt: entryTs || pairedCmd?.createdAt || undefined,
        });
      } else if (!isCodeDump && /^Command exited with code\b/im.test(gBody) && pendingRunCommands.length > 0) {
        pendingRunCommands.shift();
      }
      const bgStatusDoneMatch = !isCodeDump
        ? /^Task:\s*([A-Za-z0-9_./:-]+)\s+Status:\s*(COMPLETED|DONE|FAILED|ERROR|KILLED|CANCELLED|CANCELED|EXITED|STOPPED|TERMINATED)\b/im.exec(gBody)
        : null;
      if (bgStatusDoneMatch?.[1]) {
        upsertBgTask(bgStatusDoneMatch[1].trim(), {
          status: classifyBgTerminalStatus(bgStatusDoneMatch[2], 'done'),
          updatedAt: entryTs || undefined,
        });
      }
      const bgKilledMatch = !isCodeDump
        ? /^(?:Killed|Stopped|Cancelled|Canceled)\s+task(?:\s+id)?[:\s"]+([A-Za-z0-9_./:-]+)/im.exec(gBody)
        : null;
      if (bgKilledMatch?.[1]) {
        upsertBgTask(bgKilledMatch[1].trim(), {
          status: 'cancelled',
          updatedAt: entryTs || undefined,
        });
      }
      if (entry.content.includes('"added"') && entry.content.includes('"conversation_id"')) {
        const addedMatches = entry.content.matchAll(
          /"status"\s*:\s*"added"[\s\S]*?"name"\s*:\s*"([a-zA-Z0-9_-]{1,48})"[\s\S]*?"conversation_id"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-zA-Z0-9_-]{6,64})"/gi
        );
        for (const am of addedMatches) {
          const wName = String(am[1] || '').trim();
          const wCid = normalizeConversationId(am[2]);
          if (wName && wCid && wCid !== 'default') {
            spawnedSubagentRoles[wCid] = wName;
            killedSubagentCids.delete(wCid);
            const lk = wName.toLowerCase();
            if (!swarmNameToCids.has(lk)) swarmNameToCids.set(lk, new Set());
            swarmNameToCids.get(lk).add(wCid);
          }
        }
      }
    }
  }

  let pendingInvokeRoles = [];
  for (let i = Math.max(0, lastUserIdx + 1); i < parsed.length; i++) {
    const item = parsed[i];
    if (item?.type === 'PLANNER_RESPONSE' && Array.isArray(item.tool_calls) && item.tool_calls.length > 0) {
      plannerToolSteps += 1;
      const lastTc = item.tool_calls[item.tool_calls.length - 1];
      const sub = formatMcpToolSubtitle(lastTc?.name, lastTc?.args);
      if (sub) latestToolSubtitle = sub;
      const wsArg = lastTc?.args?.workspaceRoot || lastTc?.args?.Cwd || '';
      if (wsArg && typeof wsArg === 'string' && !isBrainOrTempWorkspacePath(wsArg)) {
        detectedWorkspace = sanitizeWorkspaceRoot(wsArg);
      }
      const rolesBatch = [];
      for (const tc of item.tool_calls) {
        const tName = String(tc?.name || '');
        const tArgs = tc?.args && typeof tc.args === 'object' ? tc.args : {};
        if (tName === 'update_steps') {
          const parsedChecklist = normalizeChecklistSteps(tArgs.steps);
          if (parsedChecklist.length > 0) {
            latestChecklistSteps = parsedChecklist;
          }
        }
        if (tName === 'exit_plan_mode' && typeof tArgs.plan === 'string' && tArgs.plan.trim()) {
          const parsedPlan = extractStepsFromPlanText(tArgs.plan, 24);
          if (parsedPlan.length >= 2) {
            extractedPlanSteps = parsedPlan;
          }
        }
        if (tName === 'ask_question') {
          let qList = tArgs.questions;
          if (typeof qList === 'string') {
            try { qList = JSON.parse(qList); } catch {}
          }
          const firstQ = Array.isArray(qList) && qList[0]
            ? (typeof qList[0] === 'string' ? qList[0] : String(qList[0]?.question || ''))
            : '';
          const qLine = firstQ.split(/[\n?!]/)[0].trim().slice(0, 100);
          askedQuestions.push(qLine || 'Вопрос пользователю');
        }
        const rawPathArg = String(tArgs.filePath || tArgs.Path || tArgs.path || tArgs.text || '').trim();
        const skillSlug = extractSkillSlugFromPath(rawPathArg);
        if (skillSlug && (tName === 'read_file' || tName.includes('ram_slice') || tName.includes('gpu_distill')) && !activeSkills.includes(skillSlug) && activeSkills.length < 6) {
          activeSkills.push(skillSlug);
        }
        if (RAM_GPU_TOOL_RE.test(tName)) {
          ramSavedCalls += 1;
        }
        const fArg = sanitizeFileBasename(tArgs.filePath || tArgs.Path || tArgs.path || '');
        if (fArg && (tName === 'read_file' || tName.includes('ram_slice') || tName.includes('gpu_distill'))) {
          if (!inspectedFiles.includes(fArg)) inspectedFiles.push(fArg);
        }
        if (tName.includes('ram_search') || tName.includes('gpu_semantic_search') || tName.includes('ram_context_pack')) {
          const q = String(tArgs.query || tArgs.prompt || '').trim();
          if (q && !searchQueries.includes(q)) searchQueries.push(q);
        }
        if (fArg && (tName === 'edit_file' || tName === 'write_file')) {
          if (!editedFiles.includes(fArg)) editedFiles.push(fArg);
        }
        if (tName === 'run_command') {
          const cmdStr = String(tArgs.CommandLine || tArgs.command || tArgs.cmd || '').trim();
          const cmdMeta = formatCommandStepLabel(cmdStr, String(tArgs.toolSummary || '').trim(), false);
          if (cmdMeta.isTestCmd) {
            ranTestLabel = cmdMeta.title;
          }
        }
        if (tName === 'invoke_subagent') {
          const r = String(tArgs.Role || tArgs.role || '').trim();
          if (r) rolesBatch.push(r);
        }
      }
      if (rolesBatch.length > 0) pendingInvokeRoles = rolesBatch;
    } else if (pendingInvokeRoles.length > 0 && typeof item?.content === 'string') {
      const cidMatches = [...item.content.matchAll(/(?:conversationId["'\s:=]+|conversation:\/\/)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-zA-Z0-9_-]{6,64})/gi)];
      for (let mIdx = 0; mIdx < cidMatches.length; mIdx++) {
        const foundCid = normalizeConversationId(cidMatches[mIdx][1]);
        const roleForCid = pendingInvokeRoles[Math.min(mIdx, pendingInvokeRoles.length - 1)];
        if (foundCid && roleForCid) {
          spawnedSubagentRoles[foundCid] = roleForCid;
          killedSubagentCids.delete(foundCid);
        }
      }
      if (cidMatches.length > 0) pendingInvokeRoles = [];
    }
  }

  let lastMeaningful = null;
  let lastMeaningfulIdx = -1;
  let lastPlannerIdx = -1;
  for (let i = parsed.length - 1; i >= 0; i--) {
    const item = parsed[i];
    if (!item) continue;
    if (lastPlannerIdx < 0 && item.type === 'PLANNER_RESPONSE') {
      lastPlannerIdx = i;
    }
    if (lastMeaningfulIdx < 0 && item.source !== 'SYSTEM' && item.source !== 'SYSTEM_SDK') {
      lastMeaningful = item;
      lastMeaningfulIdx = i;
    }
    if (lastPlannerIdx >= 0 && lastMeaningfulIdx >= 0) break;
  }
  if (!lastMeaningful) {
    lastMeaningful = parsed[parsed.length - 1];
    lastMeaningfulIdx = parsed.length - 1;
  }

  let stoppedByServerRestart = false;
  let hasTrailingWakeupMessage = false;
  for (let i = Math.max(0, lastMeaningfulIdx + 1); i < parsed.length; i++) {
    const trailing = parsed[i];
    if (!trailing || trailing.source !== 'SYSTEM' || typeof trailing.content !== 'string') continue;
    if (/All your subagents and background tasks have been stopped/i.test(trailing.content)) {
      stoppedByServerRestart = true;
    } else if (trailing.content.includes('[Message]') || trailing.content.includes('[board]')) {
      hasTrailingWakeupMessage = true;
    }
  }

  const stepKey = `${lastMeaningful?.step_index ?? ''}:${lastMeaningful?.created_at ?? ''}:${lastMeaningful?.type ?? ''}`;
  const statusUpper = String(lastMeaningful?.status || '').toUpperCase();
  const lastToolCalls = lastMeaningful?.type === 'PLANNER_RESPONSE' && Array.isArray(lastMeaningful.tool_calls)
    ? lastMeaningful.tool_calls
    : [];
  const lastToolIsExitPlan = lastToolCalls.some((tc) => tc?.name === 'exit_plan_mode');
  scanConversationBackgroundTaskLogs(transcriptPath, backgroundTasksMap, upsertBgTask);
  if (stoppedByServerRestart) {
    for (const [bgId, bgVal] of backgroundTasksMap.entries()) {
      if (bgVal.status === 'running') {
        upsertBgTask(bgId, { status: 'cancelled', updatedAt: bgVal.updatedAt || Math.round(st.mtimeMs || 0) });
      }
    }
  }
  if (hostBootAt > 0) {
    for (const [bgId, bgVal] of backgroundTasksMap.entries()) {
      if (bgVal.status === 'running') {
        const bgLastTs = Math.max(Number(bgVal.updatedAt || 0), Number(bgVal.startedAt || 0));
        if ((bgLastTs > 0 && bgLastTs < hostBootAt) || (bgLastTs === 0 && Number(st.mtimeMs || 0) < hostBootAt)) {
          upsertBgTask(bgId, { status: 'cancelled', updatedAt: bgLastTs || Math.round(st.mtimeMs || 0) });
        }
      }
    }
  }
  const transcriptMtimeMs = Math.round(Number(st.mtimeMs || 0));
  for (const [bgId, bgVal] of backgroundTasksMap.entries()) {
    if (bgVal.status !== 'running') continue;
    const bgLastTs = Math.max(Number(bgVal.updatedAt || 0), Number(bgVal.startedAt || 0));
    // Daemons stay alive while transcript or log is active; non-daemons expire from their own last activity or file mtime.
    const effectiveTs = bgVal.isDaemon
      ? Math.max(bgLastTs, transcriptMtimeMs)
      : (bgLastTs > 0 ? bgLastTs : transcriptMtimeMs);
    const maxAgeMs = bgVal.isDaemon ? STALE_DAEMON_BG_TASK_TTL_MS : STALE_BG_TASK_TTL_MS;
    if (effectiveTs > 0 && (now - effectiveTs) > maxAgeMs) {
      upsertBgTask(bgId, { status: 'cancelled', updatedAt: bgLastTs || transcriptMtimeMs });
    }
  }
  const allBgTasks = Array.from(backgroundTasksMap.values()).sort((a, b) => {
    const aRun = a.status === 'running' ? 0 : 1;
    const bRun = b.status === 'running' ? 0 : 1;
    if (aRun !== bRun) return aRun - bRun;
    const updDiff = Number(b.updatedAt || 0) - Number(a.updatedAt || 0);
    if (updDiff !== 0) return updDiff;
    const startDiff = Number(b.startedAt || 0) - Number(a.startedAt || 0);
    if (startDiff !== 0) return startDiff;
    return Number(b.seq || 0) - Number(a.seq || 0);
  });
  const backgroundTasksTotalCount = allBgTasks.length;
  const backgroundTasks = allBgTasks.slice(0, MAX_PUBLIC_BACKGROUND_TASKS).map((t) => ({
    id: t.taskId,
    taskId: t.taskId,
    label: t.label,
    labelEn: localizeProgressLabelToEn(t.label),
    commandPreview: t.commandPreview,
    status: t.status,
    isDaemon: Boolean(t.isDaemon),
    startedAt: Number(t.startedAt || 0),
    updatedAt: Number(t.updatedAt || 0),
  }));
  const runningBackgroundTasks = stoppedByServerRestart
    ? []
    : allBgTasks.filter((t) => t.status === 'running');
  const hasRunningBackgroundTask = runningBackgroundTasks.length > 0;
  let backgroundTaskLabel = '';
  if (hasRunningBackgroundTask) {
    const latestBg = runningBackgroundTasks[0];
    const cmdShort = latestBg?.description
      ? formatCommandStepLabel(latestBg.description, '', false).title
      : (latestBg?.label || '');
    const rawBgLabel = runningBackgroundTasks.length > 1
      ? `Фон (${runningBackgroundTasks.length}): ${cmdShort || 'Фоновые задачи'}`
      : `Фон: ${cmdShort || 'Фоновая задача'}`;
    backgroundTaskLabel = compactTechnicalStepLabel(rawBgLabel, 34).title || rawBgLabel;
  }
  const baseTelemetry = {
    exists: true,
    mtimeMs: st.mtimeMs,
    size: st.size,
    stepKey,
    plannerToolSteps,
    latestToolSubtitle,
    lastUserPrompt,
    detectedWorkspace,
    spawnedSubagentRoles,
    killedSubagentCids: Array.from(killedSubagentCids),
    killedSwarmNames: Array.from(killedSwarmNames),
    killedAllSubagents,
    coordinatorPostedDone,
    allSubagentsStoppedByRestart,
    backgroundTasks,
    backgroundTasksTotalCount,
    runningBackgroundTasks,
    hasRunningBackgroundTask,
    backgroundTaskLabel,
    extractedPlanSteps,
    checklistSteps: latestChecklistSteps,
    inspectedFiles,
    searchQueries,
    editedFiles,
    askedQuestions,
    ranTestLabel,
    activeSkills,
    lastToolIsExitPlan,
    ramSavedTokens: ramSavedCalls * RAM_SAVED_TOKENS_PER_CALL,
  };

  if (statusUpper === 'CANCELLED' || statusUpper === 'CANCELED' || statusUpper === 'ABORTED') {
    return { ...baseTelemetry, state: 'cancelled' };
  }

  // Native Swarm worker parked on swarm_wait ("Waiting for a message...") -> sleeping on board (✓ in native UI)
  if (lastPlannerIdx >= 0 && lastMeaningfulIdx > lastPlannerIdx) {
    const lpTools = Array.isArray(parsed[lastPlannerIdx]?.tool_calls) ? parsed[lastPlannerIdx].tool_calls : [];
    if (lpTools.some((tc) => tc?.name === 'swarm_wait')) {
      const postModelSteps = parsed
        .slice(lastPlannerIdx + 1)
        .filter((it) => it && it.source !== 'SYSTEM' && it.source !== 'SYSTEM_SDK');
      const hasRunningSibling = postModelSteps.some((it) => String(it?.status || '').toUpperCase() === 'RUNNING');
      const hasWaitParkOutput = postModelSteps.some(
        (it) => typeof it?.content === 'string' && /Waiting for a message\b/i.test(it.content)
      );
      const isFreshWakeup = hasTrailingWakeupMessage && !stoppedByServerRestart && (now - Number(st.mtimeMs || 0) < 45_000);
      if (!hasRunningSibling && hasWaitParkOutput && !isFreshWakeup) {
        return { ...baseTelemetry, swarmParked: true, state: 'completed' };
      }
    }
  }

  if (lastMeaningful?.type === 'PLANNER_RESPONSE') {
    const tcs = Array.isArray(lastMeaningful.tool_calls) ? lastMeaningful.tool_calls : [];
    if (tcs.some((tc) => tc?.name === 'ask_question')) {
      return { ...baseTelemetry, state: 'waiting_user' };
    }
    if (tcs.length === 0 && (statusUpper === 'DONE' || statusUpper === '')) {
      if (hasRunningBackgroundTask) {
        return { ...baseTelemetry, state: 'running' };
      }
      if (stoppedByServerRestart) {
        return { ...baseTelemetry, state: 'cancelled' };
      }
      return { ...baseTelemetry, state: 'completed' };
    }
  }

  if (stoppedByServerRestart) {
    return { ...baseTelemetry, state: 'cancelled' };
  }

  return {
    ...baseTelemetry,
    state: 'running',
  };
}

export function buildDefaultStepsForGrade(grade = 'M', isReadOnlyQuestion = false, context = {}) {
  return buildDefaultStepsForGradeRaw(grade, isReadOnlyQuestion, context).map(localizeStepToEn);
}

function buildDefaultStepsForGradeRaw(grade = 'M', isReadOnlyQuestion = false, context = {}) {
  const { codeFiles, testFiles, editTargets } = classifyScopeTargets(
    context?.matchedFiles || [],
    context?.userPrompt || ''
  );
  const hasScope = editTargets.length > 0 || testFiles.length > 0;

  if (isReadOnlyQuestion) {
    if (hasScope) {
      const readList = editTargets.length > 0 ? editTargets : testFiles;
      const compactRead = formatTargetFilesCompact(readList, 18);
      return [
        {
          index: 1,
          title: compactTechnicalStepLabel(`RAM-срез ${compactRead}`, 30).title,
          fullTitle: `Чтение RAM-срезов и символов: ${readList.join(', ')}`,
          source: 'scope',
          status: 'running',
        },
        {
          index: 2,
          title: 'Технический разбор',
          fullTitle: 'Анализ связей, контрактов и формирование ответа',
          source: 'scope',
          status: 'pending',
        },
      ];
    }
    return [
      {
        index: 1,
        title: 'RAM-поиск и анализ кода',
        fullTitle: 'Поиск релевантных модулей в RAM/GPU и анализ контекста',
        source: 'default',
        status: 'running',
      },
      {
        index: 2,
        title: 'Технический разбор',
        fullTitle: 'Синтез инженерного ответа по срезам кода',
        source: 'default',
        status: 'pending',
      },
    ];
  }

  const g = String(grade || 'M').toUpperCase();
  if (g === 'S') {
    if (hasScope) {
      const targetList = editTargets.length > 0 ? editTargets : testFiles;
      const compactRead = formatTargetFilesCompact(targetList, 18);
      const compactPatch = formatTargetFilesCompact(targetList, 22);
      return [
        {
          index: 1,
          title: compactTechnicalStepLabel(`RAM-срез ${compactRead}`, 30).title,
          fullTitle: `Чтение среза и зависимостей: ${targetList.join(', ')}`,
          source: 'scope',
          status: 'running',
        },
        {
          index: 2,
          title: compactTechnicalStepLabel(`Патч ${compactPatch}`, 30).title,
          fullTitle: `Точечная правка: ${targetList.join(', ')}`,
          source: 'scope',
          status: 'pending',
        },
        {
          index: 3,
          title: testFiles.length > 0 ? compactTechnicalStepLabel(`Тест ${formatTargetFilesCompact(testFiles, 22)}`, 30).title : 'AST-чек синтаксиса',
          fullTitle: testFiles.length > 0 ? `Прогон автотестов: ${testFiles.join(', ')}` : 'Авто-проверка синтаксиса и импортов',
          source: 'scope',
          status: 'pending',
        },
      ];
    }
    return [
      { index: 1, title: 'RAM-срез целевого узла', fullTitle: 'Чтение целевого среза кода в RAM', source: 'default', status: 'running' },
      { index: 2, title: 'Точечный diff-патч', fullTitle: 'Точечное изменение файла с контролем отката', source: 'default', status: 'pending' },
      { index: 3, title: 'AST-чек синтаксиса', fullTitle: 'Авто-проверка синтаксиса и контрактов', source: 'default', status: 'pending' },
    ];
  }

  if (g === 'L' || g === 'XL') {
    if (hasScope) {
      const targets = editTargets.length > 0 ? editTargets : testFiles;
      const compactGraph = formatTargetFilesCompact(targets, 16);
      const compactPatch = formatTargetFilesCompact(targets, 22);
      const compactTest = testFiles.length > 0 ? formatTargetFilesCompact(testFiles, 22) : '';
      return [
        {
          index: 1,
          title: compactTechnicalStepLabel(`Граф и срез ${compactGraph}`, 30).title,
          fullTitle: `Анализ графа зависимостей и срезов: ${targets.join(', ')}`,
          source: 'scope',
          status: 'running',
        },
        {
          index: 2,
          title: compactTechnicalStepLabel(`Патч ${compactPatch}`, 30).title,
          fullTitle: `Модификация целевых модулей: ${targets.join(', ')}`,
          source: 'scope',
          status: 'pending',
        },
        {
          index: 3,
          title: 'Контракты AST (Blast Radius)',
          fullTitle: 'Сверка импортов, экспортов и обратных зависимостей',
          source: 'scope',
          status: 'pending',
        },
        {
          index: 4,
          title: compactTest ? compactTechnicalStepLabel(`Тест ${compactTest}`, 30).title : 'Автотесты и верификация',
          fullTitle: compactTest ? `Прогон автотестов: ${testFiles.join(', ')}` : 'Прогон регрессионных тестов и финальная проверка',
          source: 'scope',
          status: 'pending',
        },
      ];
    }
    return [
      { index: 1, title: 'RAM-срез и граф связей', fullTitle: 'Архитектурный анализ графа зависимостей и срезов кода', source: 'default', status: 'running' },
      { index: 2, title: 'Модификация целевых узлов', fullTitle: 'Последовательное внесение изменений в целевые модули', source: 'default', status: 'pending' },
      { index: 3, title: 'Контракты AST и импорты', fullTitle: 'Контроль целостности импортов и обратных зависимостей', source: 'default', status: 'pending' },
      { index: 4, title: 'Автотесты и верификация', fullTitle: 'Запуск тестового набора и финальная проверка', source: 'default', status: 'pending' },
    ];
  }

  if (hasScope) {
    const targets = editTargets.length > 0 ? editTargets : testFiles;
    const compactRead = formatTargetFilesCompact(targets, 16);
    const compactPatch = formatTargetFilesCompact(targets, 22);
    const compactTest = testFiles.length > 0 ? formatTargetFilesCompact(testFiles, 22) : '';
    return [
      {
        index: 1,
        title: compactTechnicalStepLabel(`Срез и связи ${compactRead}`, 30).title,
        fullTitle: `Чтение RAM-срезов и связей: ${targets.join(', ')}`,
        source: 'scope',
        status: 'running',
      },
      {
        index: 2,
        title: compactTechnicalStepLabel(`Патч ${compactPatch}`, 30).title,
        fullTitle: `Внесение изменений в: ${targets.join(', ')}`,
        source: 'scope',
        status: 'pending',
      },
      {
        index: 3,
        title: compactTest ? compactTechnicalStepLabel(`Тест ${compactTest}`, 30).title : 'AST-чек и микро-тесты',
        fullTitle: compactTest ? `Прогон тестов: ${testFiles.join(', ')}` : 'Проверка синтаксиса, контрактов импорта и микро-тестов',
        source: 'scope',
        status: 'pending',
      },
    ];
  }

  return [
    { index: 1, title: 'RAM-срез и поиск связей', fullTitle: 'Поиск целевых модулей в RAM/GPU и анализ зависимостей', source: 'default', status: 'running' },
    { index: 2, title: 'Внесение патчей в модули', fullTitle: 'Модификация целевых файлов через diff-патчи', source: 'default', status: 'pending' },
    { index: 3, title: 'AST-чек и микро-тесты', fullTitle: 'Проверка синтаксиса, импортов и затронутых тестов', source: 'default', status: 'pending' },
  ];
}

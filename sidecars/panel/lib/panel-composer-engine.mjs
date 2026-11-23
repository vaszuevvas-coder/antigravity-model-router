/**
 * @file panel-composer-engine.mjs
 * @description Smart Composer @-autocomplete, continuation chips, chat dispatch queue, and CLI runner.
 */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import http from 'node:http';
import { detectTextLanguage, normalizeLang, pickLang, readActiveUiLanguage } from '../../../core/i18n.mjs';
import net from 'node:net';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { safeReadJsonSync } from '../../../core/safe-json.mjs';
import { isCompletedSentenceDraft, sanitizeGhostContinuation } from '../../../core/local-gpu-engine.mjs';
import { isValidWorkspaceDir } from './panel-security.mjs';
import {
  CASCADE_STATE_CACHE_PATH,
  HANDOFF_MIRROR_CACHE_PATH,
  TASK_PROGRESS_CACHE_PATH,
  getAutoVerifierMod,
  getSessionHandoffMod,
  normalizeWorkspaceUriKey,
  safeGetCachedRepoMap,
} from './panel-state-skills.mjs';
import { resolveActiveWorkspaceForPanel } from './panel-telemetry-collectors.mjs';

/**
 * Быстро (без LLM, <10 мс) формирует подсказки @-чипов для Умного Композера 2.0.
 * Поддерживает @file:, @symbol:, @git:diff, @git:staged, @error:last и @repo:.
 * @param {object} [opts={}]
 * @returns {{ ok: boolean, items: Array<{ token: string, kind: string, label: string, detail: string }> }}
 */
export function buildComposerAtSuggestions(opts = {}) {
  const safe = opts && typeof opts === 'object' && !Array.isArray(opts) ? opts : {};
  const uiLang = safe.lang ? normalizeLang(safe.lang, 'ru') : 'ru';
  const rawQuery = typeof safe.query === 'string' ? safe.query.trim().toLowerCase() : '';
  const needle = rawQuery.replace(/^@/, '');
  const limit = Number.isFinite(Number(safe.limit)) ? Math.max(1, Math.min(20, Math.round(Number(safe.limit)))) : 10;

  const candidates = [];
  const push = (token, kind, labelRu, detailRu, labelEn = labelRu, detailEn = detailRu) => {
    const label = pickLang(uiLang, labelRu, labelEn);
    const detail = pickLang(uiLang, detailRu, detailEn);
    if (
      needle &&
      !token.toLowerCase().includes(needle) &&
      !label.toLowerCase().includes(needle) &&
      !String(labelRu).toLowerCase().includes(needle) &&
      !String(labelEn).toLowerCase().includes(needle)
    ) return;
    candidates.push({ token, kind, label, labelEn, detail, detailEn });
  };

  push('@git:diff', 'git', 'Текущий diff', 'Незафиксированные правки git diff HEAD', 'Working diff', 'Uncommitted edits (git diff HEAD)');
  push('@git:staged', 'git', 'Индекс staged', 'Подготовленные изменения git diff --cached', 'Staged diff', 'Staged changes (git diff --cached)');

  const faults = Array.isArray(safe.wiretapFaults) ? safe.wiretapFaults : [];
  if (faults.length > 0) {
    const f0 = faults[0];
    const faultDetail = `${f0.file || 'runtime'}: ${String(f0.summary || '').slice(0, 60)}`;
    push('@error:last', 'error', 'Последний сбой', faultDetail, 'Last error', faultDetail);
  } else {
    push('@error:last', 'error', 'Последний сбой', 'Последняя перехваченная ошибка Wiretap', 'Last error', 'Latest captured Wiretap runtime fault');
  }

  const peers = Array.isArray(safe.federatedPeers) ? safe.federatedPeers : [];
  for (const peer of peers.slice(0, 4)) {
    const label = typeof peer === 'string' ? basename(peer) : String(peer?.label || basename(peer?.path || '')).trim();
    if (label) {
      push(`@repo:${label}`, 'repo', label, 'Связанный репозиторий (Federation)', label, 'Federated peer repository');
    }
  }

  const files = Array.isArray(safe.files) ? safe.files : [];
  for (const f of files) {
    if (candidates.length >= limit * 4) break;
    const rel = typeof f === 'string' ? f : String(f?.file || f?.relPath || '').trim();
    if (!rel) continue;
    push(`@file:${rel}`, 'file', basename(rel), rel);
  }

  const symbols = Array.isArray(safe.symbols) ? safe.symbols : [];
  for (const sym of symbols) {
    if (candidates.length >= limit * 4) break;
    const name = typeof sym === 'string' ? sym : String(sym?.name || sym?.symbol || '').trim();
    const fileLoc = sym?.file ? `${sym.file}${sym.line ? `:L${sym.line}` : ''}` : '';
    if (name) {
      push(`@symbol:${name}`, 'symbol', name, fileLoc || 'символ проекта', name, fileLoc || 'project symbol');
    }
  }

  return { ok: true, items: candidates.slice(0, limit) };
}

const SLASH_AUTOCOMPLETE_PRESETS = [
  { cmd: '/plan', tail: ' — составь пошаговый план реализации', tailEn: ' — create a step-by-step implementation plan' },
  { cmd: '/boost', tail: ' — глубокий инженерный анализ и проверка', tailEn: ' — deep engineering analysis and verification' },
  { cmd: '/goal', tail: ' — доведи задачу до полного прохождения тестов', tailEn: ' — keep going until all tests pass' },
  { cmd: '/swarm', tail: ' — распредели модули по параллельным воркерам', tailEn: ' — distribute modules across parallel workers' },
  { cmd: '/compact', tail: ' — сожми историю диалога и освободи контекст', tailEn: ' — compact conversation history and free context' },
  { cmd: '/grill-me', tail: ' — задай уточняющие вопросы по архитектуре', tailEn: ' — ask clarifying architecture questions' },
  { cmd: '/learn', tail: ' — зафиксируй правило для будущих задач', tailEn: ' — capture a persistent rule for future tasks' },
];

export const ALLOWED_SLASH_COMMANDS = SLASH_AUTOCOMPLETE_PRESETS.map((p) => p.cmd);

const STANDALONE_TECH_TOKEN_STOPWORDS = new Set([
  'ram', 'gpu', 'cpu', 'api', 'cli', 'mcp', 'ast', 'rag', 'llm', 'sse',
  'dom', 'css', 'html', 'json', 'http', 'https', 'url', 'uri', 'git',
  'env', 'log', 'logs', 'cfg', 'app', 'err', 'res', 'req', 'msg', 'src',
  'doc', 'docs', 'web', 'net', 'key', 'keys', 'map', 'set', 'get', 'run',
  'fix', 'add', 'new', 'old', 'max', 'min', 'all', 'use', 'can', 'not',
  'for', 'and', 'the', 'with', 'from', 'into', 'test', 'tests', 'node',
]);

/**
 * Формирует 3 контекстных чипа «Следующий шаг» для виджета Smart Composer (с приоритетом активного cascadeAlert).
 * @param {{ workspaceName?: string, touchedFiles?: string[], recentGoals?: string[], cascadeAlert?: { file?: string, checker?: string, error?: string }|null }} [params={}]
 */
export function buildSmartContinuationChips(opts = {}) {
  const { workspaceName = '', touchedFiles = [], recentGoals = [], cascadeAlert = null } =
    opts && typeof opts === 'object' ? opts : {};
  const cleanFiles = Array.isArray(touchedFiles)
    ? touchedFiles.map((f) => String(f || '').trim()).filter(Boolean)
    : [];
  const alertFile = typeof cascadeAlert?.file === 'string' ? cascadeAlert.file.trim() : '';
  if (alertFile) {
    const alertBase = basename(alertFile) || alertFile;
    const checkerNote = cascadeAlert?.checker ? ` (${cascadeAlert.checker})` : '';
    const errSnippet = typeof cascadeAlert?.error === 'string' && cascadeAlert.error.trim()
      ? `: ${cascadeAlert.error.trim().replace(/\s+/g, ' ').slice(0, 110)}`
      : '';
    const secondFile = cleanFiles.find((f) => f !== alertFile) || alertFile;
    const secondBase = basename(secondFile) || secondFile;
    return [
      {
        label: `🚨 Исправить ${alertBase}`,
        labelEn: `🚨 Fix ${alertBase}`,
        prompt: `Исправь ошибку проверки${checkerNote} в ${alertFile}${errSnippet} и убедись, что автотесты зелёные`,
        promptEn: `Fix the check error${checkerNote} in ${alertFile}${errSnippet} and verify tests pass`,
        title: `Активный алерт проверки в ${alertFile}`,
        titleEn: `Active verification alert in ${alertFile}`,
      },
      {
        label: `🔍 Проверить ${secondBase}`,
        labelEn: `🔍 Inspect ${secondBase}`,
        prompt: `Проверь изменения в ${secondFile} на крайние случаи и потенциальные ошибки`,
        promptEn: `Inspect changes in ${secondFile} for edge cases and regressions`,
        title: `Вставить проверку ${secondFile}`,
        titleEn: `Insert review prompt for ${secondFile}`,
      },
      {
        label: '🧪 Прогнать тесты',
        labelEn: '🧪 Run tests',
        prompt: `Прогони профильные автотесты по правкам в ${alertBase} и убедись, что нет регрессий`,
        promptEn: `Run relevant automated tests for ${alertBase} and ensure no regressions`,
        title: 'Вставить запрос на запуск тестов',
        titleEn: 'Insert test-run prompt',
      },
    ];
  }
  if (cleanFiles.length > 0) {
    const topFile = cleanFiles[0];
    const base = basename(topFile) || topFile;
    return [
      {
        label: `🔍 Проверить ${base}`,
        labelEn: `🔍 Inspect ${base}`,
        prompt: `Проверь изменения в ${topFile} на крайние случаи и потенциальные ошибки`,
        promptEn: `Inspect changes in ${topFile} for edge cases and potential bugs`,
        title: `Вставить проверку ${topFile}`,
        titleEn: `Insert review prompt for ${topFile}`,
      },
      {
        label: '🧪 Прогнать тесты',
        labelEn: '🧪 Run tests',
        prompt: `Прогони профильные автотесты по последним правкам в ${base} и убедись, что нет регрессий`,
        promptEn: `Run targeted tests for recent edits in ${base} and ensure no regressions`,
        title: 'Вставить запрос на запуск тестов',
        titleEn: 'Insert test-run prompt',
      },
      {
        label: '⚡ Узкие места',
        labelEn: '⚡ Bottlenecks',
        prompt: `Оцени производительность и узкие места в ${topFile}, предложи точечное улучшение`,
        promptEn: `Analyze performance bottlenecks in ${topFile} and suggest a surgical fix`,
        title: 'Вставить запрос на поиск узких мест',
        titleEn: 'Insert bottleneck-analysis prompt',
      },
    ];
  }
  const scopeNote = workspaceName ? ` проекта ${workspaceName}` : ' проекта';
  const scopeNoteEn = workspaceName ? ` of ${workspaceName}` : '';
  const hasGoals = Array.isArray(recentGoals) && recentGoals.length > 0;
  return [
    {
      label: '🧭 Ревью архитектуры',
      labelEn: '🧭 Architecture Review',
      prompt: `Проведи краткое ревью архитектуры${scopeNote} и выдели слабые места`,
      promptEn: `Run a concise architecture review${scopeNoteEn} and highlight weak spots`,
      title: `Ревью архитектуры${scopeNote}`,
      titleEn: `Architecture review${scopeNoteEn}`,
    },
    {
      label: '🐞 Найти риски и баги',
      labelEn: '🐞 Find Risks & Bugs',
      prompt: hasGoals
        ? `Найди потенциальные баги, гонки или необработанные ошибки в модулях после недавних задач`
        : 'Найди потенциальные баги, гонки или необработанные ошибки в ключевых модулях',
      promptEn: hasGoals
        ? 'Find potential bugs, races, or unhandled errors in recently modified modules'
        : 'Find potential bugs, race conditions, or unhandled errors across core modules',
      title: 'Поиск потенциальных багов',
      titleEn: 'Search for potential bugs',
    },
    {
      label: '📋 План доработки',
      labelEn: '📋 Implementation Plan',
      prompt: 'Составь пошаговый инженерный план реализации следующей задачи: ',
      promptEn: 'Create a step-by-step engineering plan for the following task: ',
      title: 'Шаблон пошагового плана',
      titleEn: 'Step-by-step plan template',
    },
  ];
}

/**
 * Динамически приоритизирует файлы и символы из директорий, упомянутых в черновике (например `sidecars`, `core`, `skills`),
 * а также активный алерт из `peekCascadeAlert`, сохраняя нулевую задержку (<0.2 мс).
 */
export function prioritizeContextForDraft(draft = '', context = {}) {
  const rawDraft = String(draft || '');
  const baseTouched = Array.isArray(context?.touchedFiles)
    ? context.touchedFiles.map((f) => String(f || '').trim()).filter(Boolean)
    : [];
  const baseRepoFiles = Array.isArray(context?.repoFiles)
    ? context.repoFiles.map((f) => String(f || '').trim()).filter(Boolean)
    : [];
  const baseSymbols = Array.isArray(context?.symbols)
    ? context.symbols.map((s) => String(s || '').trim()).filter(Boolean)
    : [];
  const symbolsByFile = context?.symbolsByFile && typeof context.symbolsByFile === 'object'
    ? context.symbolsByFile
    : {};
  const cascadeAlert = context?.cascadeAlert && typeof context.cascadeAlert === 'object'
    ? context.cascadeAlert
    : null;

  const allFiles = [...new Set([...baseTouched, ...baseRepoFiles])];
  const dirPrefixes = new Set();
  for (const f of allFiles) {
    const norm = f.replace(/\\/g, '/');
    const slashIdx = norm.indexOf('/');
    if (slashIdx > 1) {
      dirPrefixes.add(norm.slice(0, slashIdx).toLowerCase());
      const secondSlash = norm.indexOf('/', slashIdx + 1);
      if (secondSlash > slashIdx + 1) {
        dirPrefixes.add(norm.slice(0, secondSlash).toLowerCase());
      }
    }
  }

  const matchedDirs = [];
  if (rawDraft && dirPrefixes.size > 0) {
    const lowerDraft = rawDraft.toLowerCase();
    for (const dir of dirPrefixes) {
      const escaped = dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const rx = new RegExp(`(?:^|[\\s(\`"«'/@])${escaped}(?=$|[\\s.,:;!?)\`"»'/\\\\])`, 'i');
      if (rx.test(lowerDraft)) {
        matchedDirs.push(dir);
      }
    }
    matchedDirs.sort((a, b) => b.length - a.length);
  }

  const alertFile = typeof cascadeAlert?.file === 'string' ? cascadeAlert.file.trim().replace(/\\/g, '/') : '';
  if (matchedDirs.length === 0 && !alertFile) {
    return {
      ...context,
      touchedFiles: baseTouched,
      repoFiles: baseRepoFiles,
      symbols: baseSymbols,
      matchedDirs: [],
    };
  }

  const inMatchedDir = (f) => {
    const norm = String(f || '').replace(/\\/g, '/').toLowerCase();
    return matchedDirs.some((d) => norm === d || norm.startsWith(`${d}/`));
  };

  const scopedFiles = allFiles.filter(inMatchedDir);
  const prioritizedTouched = [];
  const seenTouched = new Set();
  const pushTouched = (f) => {
    if (!f || seenTouched.has(f)) return;
    seenTouched.add(f);
    prioritizedTouched.push(f);
  };
  if (alertFile && matchedDirs.length === 0) pushTouched(alertFile);
  for (const f of scopedFiles) pushTouched(f);
  if (alertFile) pushTouched(alertFile);
  for (const f of baseTouched) pushTouched(f);

  const prioritizedRepo = [];
  const seenRepo = new Set();
  for (const f of [...scopedFiles, ...baseRepoFiles]) {
    if (!f || seenRepo.has(f)) continue;
    seenRepo.add(f);
    prioritizedRepo.push(f);
  }

  const prioritizedSymbols = [];
  const seenSyms = new Set();
  const pushSym = (s) => {
    if (!s || seenSyms.has(s)) return;
    seenSyms.add(s);
    prioritizedSymbols.push(s);
  };
  for (const f of scopedFiles) {
    const norm = f.replace(/\\/g, '/');
    const list = symbolsByFile[norm] || symbolsByFile[f] || [];
    for (const sym of list) pushSym(sym);
  }
  if (alertFile) {
    const list = symbolsByFile[alertFile] || [];
    for (const sym of list) pushSym(sym);
  }
  for (const s of baseSymbols) pushSym(s);

  return {
    ...context,
    touchedFiles: prioritizedTouched,
    repoFiles: prioritizedRepo,
    symbols: prioritizedSymbols,
    matchedDirs,
  };
}

/**
 * Сверхбыстрый (<5 мс) локальный предсказатель Ghost Text по файлам, символам, целям и русским инженерным заготовкам.
 * @param {string} [draft='']
 * @param {{ touchedFiles?: string[], repoFiles?: string[], symbols?: string[], symbolsByFile?: Record<string, string[]>, recentGoals?: string[], cascadeAlert?: object|null }} [context={}]
 * @returns {{ continuation: string, source: 'ram'|'none' }}
 */
export function computeFastRamAutocomplete(draft = '', context = {}) {
  const rawDraft = String(draft || '');
  const trimmed = rawDraft.trim();
  if (!trimmed || rawDraft.length > 600 || isCompletedSentenceDraft(rawDraft)) {
    return { continuation: '', source: 'none' };
  }

  const scopedCtx = prioritizeContextForDraft(rawDraft, context);
  const uiLang = context?.lang
    ? normalizeLang(context.lang, readActiveUiLanguage())
    : detectTextLanguage(rawDraft, readActiveUiLanguage());
  const cleanTouched = scopedCtx.touchedFiles;
  const cleanRepoFiles = scopedCtx.repoFiles;
  const cleanSymbols = scopedCtx.symbols;
  const cleanGoals = Array.isArray(scopedCtx?.recentGoals)
    ? scopedCtx.recentGoals.map((g) => String(g || '').trim()).filter(Boolean)
    : [];
  const cascadeAlert = scopedCtx?.cascadeAlert && typeof scopedCtx.cascadeAlert === 'object'
    ? scopedCtx.cascadeAlert
    : null;

  // 1. Slash-команды (/plan, /boost, /swarm, ...)
  const leftTrimmed = rawDraft.trimStart();
  if (leftTrimmed.startsWith('/') && !/\s/.test(leftTrimmed)) {
    const lowerSlash = leftTrimmed.toLowerCase();
    for (const preset of SLASH_AUTOCOMPLETE_PRESETS) {
      if (preset.cmd.startsWith(lowerSlash)) {
        const tail = uiLang === 'ru' ? preset.tail : (preset.tailEn || preset.tail);
        const fullLine = `${preset.cmd}${tail}`;
        const cont = fullLine.slice(leftTrimmed.length);
        if (cont) return { continuation: cont, source: 'ram' };
      }
    }
  }

  // 2. Автодополнение незавершённого имени файла, пути или символа кода
  const tokenMatch = /(?:^|([\s(@«"'`]))([A-Za-z0-9_./-]{2,})$/.exec(rawDraft);
  if (tokenMatch && tokenMatch[2]) {
    const leadDelim = tokenMatch[1] || '';
    const tok = tokenMatch[2];
    const tokLower = tok.toLowerCase();
    const hasSlash = tok.includes('/');
    const hasDot = tok.includes('.');
    const startsUpper = /^[A-Z]/.test(tok);
    const hasCodeShape =
      tok.includes('_') ||
      /[a-z][A-Z]/.test(tok) ||
      /^[A-Z][A-Za-z0-9]{2,}$/.test(tok) ||
      leadDelim === '`' ||
      leadDelim === '@';
    const precededByFileCue = /(?:^|\s)(?:в|во|из|для|открой|файл[аеуыов]*|модул[ьяюеией]*|папк[аеуи]|file|module|folder|in|from)\s+[A-Za-z0-9_./-]{2,}$/i.test(rawDraft);
    const isGenericStopword =
      !hasSlash &&
      !hasDot &&
      !hasCodeShape &&
      !precededByFileCue &&
      STANDALONE_TECH_TOKEN_STOPWORDS.has(tokLower);

    const allowFileMatch =
      !isGenericStopword &&
      (hasSlash || hasDot || tok.length >= 3 || (tok.length === 2 && startsUpper));
    const allowSymbolMatch =
      !isGenericStopword &&
      !hasSlash &&
      !hasDot &&
      (tok.length >= 3 || (tok.length === 2 && startsUpper));

    if (allowFileMatch || allowSymbolMatch) {
      const fileCandidates = [];
      const seenCand = new Set();
      const requireExactCase = tok.length === 2 && startsUpper && !hasSlash && !hasDot;
      const pushCand = (val, forceExactCase = false) => {
        if (!val || seenCand.has(val)) return;
        if ((requireExactCase || forceExactCase) && !val.startsWith(tok)) return;
        seenCand.add(val);
        fileCandidates.push(val);
      };
      if (allowFileMatch) {
        for (const f of cleanTouched) {
          pushCand(f);
          if (!hasSlash) pushCand(basename(f));
        }
        for (const f of cleanRepoFiles) {
          pushCand(f);
          if (!hasSlash) pushCand(basename(f));
        }
      }
      if (allowSymbolMatch) {
        for (const sym of cleanSymbols) {
          pushCand(sym);
        }
      }

      const matchedCand = fileCandidates.find(
        (cand) => cand.toLowerCase().startsWith(tokLower) && cand.length > tok.length
      );
      if (matchedCand) {
        return { continuation: matchedCand.slice(tok.length), source: 'ram' };
      }
    }
  }

  // 3. Совпадение с реальными целями активной сессии и недавних диалогов
  if (trimmed.length >= 6) {
    const lowerLeft = leftTrimmed.toLowerCase();
    for (const goal of cleanGoals) {
      if (goal.toLowerCase().startsWith(lowerLeft) && goal.length > leftTrimmed.length + 3) {
        const cont = sanitizeGhostContinuation(rawDraft, goal);
        if (cont) return { continuation: cont, source: 'ram' };
      }
    }
  }

  // 4. Только подтверждённые контекстные привязки: активный cascadeAlert, директория проекта или явный предлог цели при известном файле
  if (cascadeAlert?.file && /^(?:исправ|почин)[а-яё]*\s*$/i.test(trimmed)) {
    const checkerHint = cascadeAlert.checker ? ` (${cascadeAlert.checker})` : '';
    const cont = sanitizeGhostContinuation(rawDraft, `ошибку${checkerHint} в ${cascadeAlert.file} и проверь автотесты`);
    if (cont) return { continuation: cont, source: 'ram' };
  }
  if (cascadeAlert?.file && /^(?:fix|repair|resolve)\s*$/i.test(trimmed)) {
    const checkerHint = cascadeAlert.checker ? ` (${cascadeAlert.checker})` : '';
    const cont = sanitizeGhostContinuation(rawDraft, `the check error${checkerHint} in ${cascadeAlert.file} and verify unit tests`);
    if (cont) return { continuation: cont, source: 'ram' };
  }
  if (scopedCtx.matchedDirs.length > 0 && cleanTouched.length > 0) {
    const dirPrimaryFile = cleanTouched[0];
    const dirPrimarySym = cleanSymbols[0] || '';
    if (
      /(?:из\s+файлов|в\s+папке|в\s+модулях|внутри)\s+[A-Za-z0-9_/-]+\s+(?:через|в|из|используя)\s*$/i.test(rawDraft) ||
      /(?:files\s+in|inside|in\s+folder|in\s+directory|within)\s+[A-Za-z0-9_/-]+\s+(?:via|using|in|with)\s*$/i.test(rawDraft)
    ) {
      const symClause = dirPrimarySym ? ` (${dirPrimarySym})` : '';
      const cont = sanitizeGhostContinuation(rawDraft, `${dirPrimaryFile}${symClause}`);
      if (cont) return { continuation: cont, source: 'ram' };
    }
  }

  const endsWithTargetPreposition = /(?:^|\s)(?:в|во|из|для|файл[аеу]?|модул[ьяюеи]|file|module|in\s+(?:the\s+)?(?:file|module))\s*$/i.test(rawDraft);
  const isScopedCallerContext =
    cleanTouched.length > 0 &&
    !context?.wsRoot &&
    (!Array.isArray(context?.repoFiles) || context.repoFiles.length <= 5);
  if (
    endsWithTargetPreposition &&
    cleanTouched.length > 0 &&
    (scopedCtx.matchedDirs.length > 0 || cascadeAlert?.file || isScopedCallerContext)
  ) {
    const cont = sanitizeGhostContinuation(rawDraft, cleanTouched[0]);
    if (cont) return { continuation: cont, source: 'ram' };
  }

  return { continuation: '', source: 'none' };
}

let autocompleteCtxCache = { ts: 0, wsRoot: '', stateSig: '', value: null };

const inFlightAutocompleteCtxByRoot = new Map();

let autocompleteCtxRefreshQueue = null;

export function getAutocompleteCtxRefreshQueue() {
  if (!autocompleteCtxRefreshQueue) {
    autocompleteCtxRefreshQueue = new Queue({
      maxSize: 32,
      maxAgeMs: 5000,
      taskTimeoutMs: 2500,
      parallelBatchSize: 2,
      autoProcess: true,
    });
  }
  return autocompleteCtxRefreshQueue;
}

export function invalidateAutocompleteContextCache() {
  autocompleteCtxCache = { ts: 0, wsRoot: '', stateSig: '', value: null };
}

function readFastAutocompleteSyncSignature(wsRoot = '') {
  let cascadeMtime = 0;
  let handoffMtime = 0;
  let progressMtime = 0;
  let wsHandoffMtime = 0;
  try {
    if (existsSync(CASCADE_STATE_CACHE_PATH)) cascadeMtime = Math.round(statSync(CASCADE_STATE_CACHE_PATH).mtimeMs);
  } catch {}
  try {
    if (existsSync(HANDOFF_MIRROR_CACHE_PATH)) handoffMtime = Math.round(statSync(HANDOFF_MIRROR_CACHE_PATH).mtimeMs);
  } catch {}
  try {
    if (existsSync(TASK_PROGRESS_CACHE_PATH)) progressMtime = Math.round(statSync(TASK_PROGRESS_CACHE_PATH).mtimeMs);
  } catch {}
  try {
    if (wsRoot) {
      const agentsHandoff = join(wsRoot, '.agents', 'session-handoff.json');
      const localHandoff = join(wsRoot, '.cache', 'session-handoff.json');
      if (existsSync(agentsHandoff)) wsHandoffMtime = Math.round(statSync(agentsHandoff).mtimeMs);
      else if (existsSync(localHandoff)) wsHandoffMtime = Math.round(statSync(localHandoff).mtimeMs);
    }
  } catch {}
  return `${cascadeMtime}:${handoffMtime}:${progressMtime}:${wsHandoffMtime}`;
}

function toRelativeWorkspaceFilePath(wsRoot = '', rawFilePath = '') {
  const cleanPath = String(rawFilePath || '').trim();
  if (!cleanPath) return '';
  const normFile = cleanPath.replace(/\\/g, '/');
  if (!wsRoot) return normFile;
  const normRoot = String(wsRoot).replace(/\\/g, '/').replace(/\/+$/, '');
  const lowerFile = process.platform === 'win32' ? normFile.toLowerCase() : normFile;
  const lowerRoot = process.platform === 'win32' ? normRoot.toLowerCase() : normRoot;
  if (lowerFile.startsWith(`${lowerRoot}/`)) {
    return normFile.slice(normRoot.length + 1);
  }
  return normFile;
}

function extractRepoFilesAndSymbolsForAutocomplete(repoMap) {
  const repoFiles = [];
  const symbols = [];
  const symbolsByFile = Object.create(null);
  const seenFiles = new Set();
  const seenSyms = new Set();
  if (!repoMap || typeof repoMap !== 'object') return { repoFiles, symbols, symbolsByFile };

  if (Array.isArray(repoMap.filesIndex)) {
    for (const entry of repoMap.filesIndex) {
      const f = typeof entry?.file === 'string' ? entry.file.trim().replace(/\\/g, '/') : '';
      if (f && !seenFiles.has(f) && repoFiles.length < 400) {
        seenFiles.add(f);
        repoFiles.push(f);
      }
      const perFileSyms = f ? (symbolsByFile[f] || (symbolsByFile[f] = [])) : null;
      if (Array.isArray(entry?.exportedSymbols)) {
        for (const sym of entry.exportedSymbols) {
          const sName = typeof sym === 'string' ? sym.trim() : '';
          if (sName && sName.length >= 3) {
            if (perFileSyms && perFileSyms.length < 80 && !perFileSyms.includes(sName)) {
              perFileSyms.push(sName);
            }
            if (!seenSyms.has(sName) && symbols.length < 2000) {
              seenSyms.add(sName);
              symbols.push(sName);
            }
          }
        }
      }
      if (Array.isArray(entry?.symbolsWithRanges)) {
        for (const sw of entry.symbolsWithRanges) {
          const sName = typeof sw?.name === 'string' ? sw.name.trim() : '';
          if (sName && sName.length >= 3) {
            if (perFileSyms && perFileSyms.length < 80 && !perFileSyms.includes(sName)) {
              perFileSyms.push(sName);
            }
            if (!seenSyms.has(sName) && symbols.length < 2000) {
              seenSyms.add(sName);
              symbols.push(sName);
            }
          }
        }
      }
    }
  }

  if (repoFiles.length === 0 && typeof repoMap.markdown === 'string') {
    const fileRx = /^###\s+`([^`]+)`/gm;
    let m;
    while ((m = fileRx.exec(repoMap.markdown)) !== null && repoFiles.length < 400) {
      const f = m[1].trim().replace(/\\/g, '/');
      if (f && !seenFiles.has(f)) {
        seenFiles.add(f);
        repoFiles.push(f);
      }
    }
  }

  return { repoFiles, symbols, symbolsByFile };
}

function isExistingWorkspaceRelativeFile(wsRoot = '', relFile = '') {
  const cleanRel = String(relFile || '').trim().replace(/\\/g, '/');
  if (!cleanRel || cleanRel.startsWith('..') || isAbsolute(cleanRel)) return false;
  if (!wsRoot || !isValidWorkspaceDir(wsRoot)) return false;
  try {
    const targetPath = join(wsRoot, cleanRel);
    if (!existsSync(targetPath)) return false;
    const absRoot = resolve(wsRoot).replace(/\\/g, '/').replace(/\/+$/, '');
    const absTarget = resolve(targetPath).replace(/\\/g, '/');
    const inside = process.platform === 'win32'
      ? absTarget.toLowerCase().startsWith(`${absRoot.toLowerCase()}/`)
      : absTarget.startsWith(`${absRoot}/`);
    return inside && statSync(targetPath).isFile();
  } catch {
    return false;
  }
}

async function rebuildAutocompleteWorkspaceContext(wsRoot = '', stateSig = '') {
  const cacheKey = wsRoot || '__default__';
  if (inFlightAutocompleteCtxByRoot.has(cacheKey)) {
    return await inFlightAutocompleteCtxByRoot.get(cacheKey);
  }

  const loadContextPromise = getAutocompleteCtxRefreshQueue().enqueue(
    async () => {
      const loadHandoff = async () => {
        try {
          const hMod = await getSessionHandoffMod();
          const handoff = hMod?.getSessionHandoff ? hMod.getSessionHandoff(wsRoot, { createDir: false }) : null;
          if (handoff && typeof handoff === 'object') {
            const touchedFiles = Array.isArray(handoff.touchedFiles)
              ? handoff.touchedFiles
                  .map((item) => (typeof item === 'string' ? item : item?.file))
                  .map((s) => String(s || '').trim().replace(/\\/g, '/'))
                  .filter(Boolean)
                  .slice(0, 14)
              : [];
            const recentGoals = Array.isArray(handoff.recentGoals)
              ? handoff.recentGoals.map((g) => String(g || '').trim()).filter(Boolean).slice(0, 6)
              : [];
            return { touchedFiles, recentGoals };
          }
        } catch {}
        return { touchedFiles: [], recentGoals: [] };
      };

      const loadRepoMap = async () => {
        try {
          if (isValidWorkspaceDir(wsRoot)) {
            const repoMap = await safeGetCachedRepoMap(wsRoot, false);
            return extractRepoFilesAndSymbolsForAutocomplete(repoMap);
          }
        } catch {}
        return { repoFiles: [], symbols: [], symbolsByFile: Object.create(null) };
      };

      const loadCascadeAlert = async () => {
        try {
          const vMod = await getAutoVerifierMod();
          const rawAlert = vMod?.peekCascadeAlert ? vMod.peekCascadeAlert() : null;
          if (rawAlert && typeof rawAlert === 'object' && rawAlert.filePath) {
            const relAlertFile = toRelativeWorkspaceFilePath(wsRoot, rawAlert.filePath);
            if (wsRoot && !isExistingWorkspaceRelativeFile(wsRoot, relAlertFile)) {
              return null;
            }
            return {
              file: relAlertFile,
              checker: String(rawAlert.checker || '').trim(),
              error: String(rawAlert.error || '').trim().slice(0, 220),
              failedAt: String(rawAlert.failedAt || ''),
            };
          }
        } catch {}
        return null;
      };

      const loadLiveSession = async () => {
        const liveFiles = [];
        const liveGoals = [];
        try {
          if (existsSync(TASK_PROGRESS_CACHE_PATH)) {
            const prog = safeReadJsonSync(TASK_PROGRESS_CACHE_PATH, () => null, { selfHeal: false });
            const normTargetWs = wsRoot ? resolve(wsRoot).replace(/\\/g, '/').toLowerCase() : '';
            const chatsObj = prog?.chats && typeof prog.chats === 'object' ? prog.chats : {};
            const matchingChats = Object.values(chatsObj)
              .filter((c) => {
                if (!c || typeof c !== 'object') return false;
                if (!normTargetWs) return true;
                const cWs = c.workspaceRoot ? resolve(String(c.workspaceRoot)).replace(/\\/g, '/').toLowerCase() : '';
                return !cWs || cWs === normTargetWs;
              })
              .sort((a, b) => (Number(b?.updatedAt) || 0) - (Number(a?.updatedAt) || 0));
            for (const ch of matchingChats.slice(0, 2)) {
              const g = String(ch.goal || ch.title || '').trim();
              if (g && g.length >= 6 && !liveGoals.includes(g)) {
                liveGoals.push(g);
              }
              if (Array.isArray(ch.editedFiles)) {
                for (const ef of ch.editedFiles) {
                  const relEf = toRelativeWorkspaceFilePath(wsRoot, ef);
                  if (relEf && !liveFiles.includes(relEf)) liveFiles.push(relEf);
                }
              }
            }
          }
        } catch {}

        if (wsRoot && isValidWorkspaceDir(wsRoot) && existsSync(join(wsRoot, '.git'))) {
          const gitDirty = await new Promise((resGit) => {
            execFile(
              'git',
              ['status', '--porcelain', '-uno'],
              { cwd: wsRoot, timeout: 450, windowsHide: true, maxBuffer: 65536 },
              (err, stdout) => {
                if (err || !stdout) return resGit([]);
                const out = [];
                for (const line of String(stdout).split(/\r?\n/)) {
                  if (line.length < 4) continue;
                  let rawRel = line.slice(3).trim();
                  const arrowIdx = rawRel.indexOf(' -> ');
                  if (arrowIdx >= 0) rawRel = rawRel.slice(arrowIdx + 4).trim();
                  rawRel = rawRel.replace(/^"+|"+$/g, '').replace(/\\/g, '/');
                  if (rawRel && !out.includes(rawRel)) {
                    out.push(rawRel);
                    if (out.length >= 8) break;
                  }
                }
                resGit(out);
              }
            );
          });
          for (const gf of gitDirty) {
            if (!liveFiles.includes(gf)) liveFiles.push(gf);
          }
        }
        return { liveFiles, liveGoals };
      };

      // Fetch handoff metadata, live session/git state, cached AST repo map, and peekCascadeAlert concurrently
      const [handoffData, liveData, repoData, cascadeAlert] = await Promise.all([
        loadHandoff(),
        loadLiveSession(),
        loadRepoMap(),
        loadCascadeAlert(),
      ]);

      const touchedFiles = [];
      const seenTouched = new Set();
      if (cascadeAlert?.file && (!wsRoot || isExistingWorkspaceRelativeFile(wsRoot, cascadeAlert.file))) {
        seenTouched.add(cascadeAlert.file);
        touchedFiles.push(cascadeAlert.file);
      }
      for (const f of [...liveData.liveFiles, ...handoffData.touchedFiles]) {
        if (f && !seenTouched.has(f) && (!wsRoot || isExistingWorkspaceRelativeFile(wsRoot, f))) {
          seenTouched.add(f);
          touchedFiles.push(f);
        }
      }
      const recentGoals = [];
      for (const g of [...liveData.liveGoals, ...handoffData.recentGoals]) {
        if (g && !recentGoals.includes(g)) recentGoals.push(g);
      }
      if (cascadeAlert?.file && cascadeAlert?.error) {
        recentGoals.unshift(
          readActiveUiLanguage() === 'en'
            ? `Fix alert (${cascadeAlert.checker || 'syntax'}) in ${cascadeAlert.file}`
            : `Исправить алерт (${cascadeAlert.checker || 'syntax'}) в ${cascadeAlert.file}`
        );
      }

      const workspaceName = wsRoot ? basename(wsRoot) : '';
      const chips = buildSmartContinuationChips({
        workspaceName,
        touchedFiles,
        recentGoals,
        cascadeAlert,
      });
      const resolvedSig = stateSig || readFastAutocompleteSyncSignature(wsRoot);
      const ctxVal = {
        wsRoot,
        workspaceName,
        touchedFiles,
        recentGoals,
        repoFiles: repoData.repoFiles,
        symbols: repoData.symbols,
        symbolsByFile: repoData.symbolsByFile,
        cascadeAlert,
        chips,
      };
      autocompleteCtxCache = { ts: Date.now(), wsRoot, stateSig: resolvedSig, value: ctxVal };
      return ctxVal;
    },
    { label: `ctx-sync:${cacheKey}`, groupKey: `ctx:${cacheKey}`, maxAgeMs: 5000, timeoutMs: 2500 }
  );

  inFlightAutocompleteCtxByRoot.set(cacheKey, loadContextPromise);
  try {
    return await loadContextPromise;
  } finally {
    if (inFlightAutocompleteCtxByRoot.get(cacheKey) === loadContextPromise) {
      inFlightAutocompleteCtxByRoot.delete(cacheKey);
    }
  }
}

export async function getAutocompleteWorkspaceContext(explicitRoot = '', { allowStaleWhileRevalidate = false } = {}) {
  const wsRoot = await resolveActiveWorkspaceForPanel(explicitRoot);
  const now = Date.now();
  const liveSig = readFastAutocompleteSyncSignature(wsRoot);
  const sameRoot = autocompleteCtxCache.value && autocompleteCtxCache.wsRoot === wsRoot;
  const sigMatches = sameRoot && autocompleteCtxCache.stateSig === liveSig;

  if (sigMatches && (now - autocompleteCtxCache.ts) < 12000) {
    return autocompleteCtxCache.value;
  }
  // Zero-latency path: if state signature matches and cache is only mildly aged, return immediately & refresh via async Queue
  if (allowStaleWhileRevalidate && sigMatches && autocompleteCtxCache.value) {
    rebuildAutocompleteWorkspaceContext(wsRoot, liveSig).catch(() => {});
    return autocompleteCtxCache.value;
  }
  return await rebuildAutocompleteWorkspaceContext(wsRoot, liveSig);
}

export const SAFE_SIDE_ID_RE = /^[a-zA-Z0-9_-]{8,128}$/;

const UUID_V4_LIKE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function resolveSidecarEventsDir(explicitEventsDir = '', env = process.env) {
  if (typeof explicitEventsDir === 'string' && explicitEventsDir.trim()) {
    return explicitEventsDir.trim();
  }
  const execDataDir = typeof env?.ANTIGRAVITY_EXECUTABLE_DATA_DIR === 'string'
    ? env.ANTIGRAVITY_EXECUTABLE_DATA_DIR.trim()
    : '';
  if (execDataDir) {
    const candidate = join(dirname(execDataDir), 'events');
    if (existsSync(candidate)) return candidate;
  }
  return join(homedir(), '.gemini', 'antigravity', 'sidecar_data', 'antigravity-model-router', 'panel', 'events');
}

export function resolveProjectIdForWorkspace({
  workspaceUris = [],
  rootDir = '',
  explicitProjectId = '',
  eventsDir = '',
  env = process.env,
} = {}) {
  if (typeof explicitProjectId === 'string' && SAFE_SIDE_ID_RE.test(explicitProjectId.trim())) {
    return explicitProjectId.trim();
  }

  const targetKeys = new Set();
  if (Array.isArray(workspaceUris)) {
    for (const u of workspaceUris) {
      const k = normalizeWorkspaceUriKey(u);
      if (k) targetKeys.add(k);
    }
  }
  if (typeof rootDir === 'string' && rootDir.trim()) {
    const rk = normalizeWorkspaceUriKey(rootDir);
    if (rk) targetKeys.add(rk);
  }

  let newestAnyProjectId = '';
  const evDir = resolveSidecarEventsDir(eventsDir, env);
  try {
    if (existsSync(evDir)) {
      const files = readdirSync(evDir)
        .filter((f) => f.endsWith('.json'))
        .sort()
        .reverse()
        .slice(0, 30);

      for (const name of files) {
        try {
          const parsed = JSON.parse(readFileSync(join(evDir, name), 'utf8'));
          const meta = parsed?.payload?.conversationMetadata?.metadata
            || parsed?.payload?.conversation_metadata?.metadata
            || parsed?.response?.conversationMetadata?.metadata
            || parsed?.response?.conversation_metadata?.metadata;
          if (!meta || typeof meta !== 'object') continue;
          const pid = String(meta.projectId || meta.project_id || '').trim();
          if (!SAFE_SIDE_ID_RE.test(pid)) continue;
          if (!newestAnyProjectId) newestAnyProjectId = pid;

          if (targetKeys.size > 0) {
            const metaUris = [];
            if (Array.isArray(meta.workspaceUris)) metaUris.push(...meta.workspaceUris);
            if (Array.isArray(meta.workspaces)) {
              for (const w of meta.workspaces) {
                if (w?.workspaceFolderAbsoluteUri) metaUris.push(w.workspaceFolderAbsoluteUri);
                if (w?.gitRootAbsoluteUri) metaUris.push(w.gitRootAbsoluteUri);
              }
            }
            const matched = metaUris.some((u) => {
              const uk = normalizeWorkspaceUriKey(u);
              return Boolean(uk && targetKeys.has(uk));
            });
            if (matched) return pid;
          }
        } catch {}
      }
    }
  } catch {}

  const envPid = typeof env?.ANTIGRAVITY_PROJECT_ID === 'string' ? env.ANTIGRAVITY_PROJECT_ID.trim() : '';
  if (SAFE_SIDE_ID_RE.test(envPid)) return envPid;
  return newestAnyProjectId;
}

export function extractConversationIdFromAgentApiOutput(payload, depth = 0) {
  if (!payload || typeof payload !== 'object' || depth > 4) return '';
  const directKeys = [
    'conversationId',
    'conversation_id',
    'newConversationId',
    'new_conversation_id',
    'rootConversationId',
    'root_conversation_id',
  ];
  for (const k of directKeys) {
    const val = payload[k];
    if (typeof val === 'string' && SAFE_SIDE_ID_RE.test(val.trim())) {
      return val.trim();
    }
  }
  const nestedPriority = [
    'response',
    'newConversation',
    'new_conversation',
    'conversation',
    'conversationMetadata',
    'conversation_metadata',
    'metadata',
    'payload',
  ];
  for (const nk of nestedPriority) {
    if (payload[nk] && typeof payload[nk] === 'object') {
      const found = extractConversationIdFromAgentApiOutput(payload[nk], depth + 1);
      if (found) return found;
    }
  }
  for (const [k, v] of Object.entries(payload)) {
    if (k === 'parentConversationId' || k === 'parent_conversation_id' || k === 'projectId' || k === 'project_id' || k === 'initializationStateId') {
      continue;
    }
    if (typeof v === 'string' && /conversation.?id/i.test(k) && SAFE_SIDE_ID_RE.test(v.trim())) {
      return v.trim();
    }
    if (v && typeof v === 'object' && !Array.isArray(v) && !nestedPriority.includes(k)) {
      const found = extractConversationIdFromAgentApiOutput(v, depth + 1);
      if (found) return found;
    }
  }
  return '';
}

function detectNewlyCreatedBrainConversationId(tStartMs, env = process.env) {
  const candidates = [];
  const execDataDir = typeof env?.ANTIGRAVITY_EXECUTABLE_DATA_DIR === 'string'
    ? env.ANTIGRAVITY_EXECUTABLE_DATA_DIR.trim()
    : '';
  if (execDataDir) {
    let cur = execDataDir;
    for (let i = 0; i < 6; i += 1) {
      const p = dirname(cur);
      if (!p || p === cur) break;
      if (basename(cur) === 'sidecar_data') {
        candidates.push(join(p, 'brain'));
        break;
      }
      cur = p;
    }
  }
  candidates.push(join(homedir(), '.gemini', 'antigravity', 'brain'));

  let newestCid = '';
  let newestTs = 0;
  for (const brainDir of candidates) {
    try {
      if (!existsSync(brainDir)) continue;
      for (const entry of readdirSync(brainDir)) {
        if (!UUID_V4_LIKE_RE.test(entry)) continue;
        const st = statSync(join(brainDir, entry));
        if (!st.isDirectory()) continue;
        const ts = Math.max(Number(st.birthtimeMs || 0), Number(st.ctimeMs || 0), Number(st.mtimeMs || 0));
        if (ts >= (tStartMs - 1500) && ts >= newestTs) {
          newestTs = ts;
          newestCid = entry;
        }
      }
      if (newestCid) return newestCid;
    } catch {}
  }
  return '';
}

function runAgentApiCliAsync(args, callEnv, env = process.env) {
  const rawExe = typeof env?.ANTIGRAVITY_AGENTAPI_EXE === 'string' ? env.ANTIGRAVITY_AGENTAPI_EXE.trim() : '';
  const useDirectExe = Boolean(rawExe && isAbsolute(rawExe) && existsSync(rawExe));
  const exeFile = useDirectExe ? rawExe : 'agentapi';
  const execArgs = useDirectExe ? ['agentapi', ...args] : args;

  return new Promise((resolveRun) => {
    execFile(
      exeFile,
      execArgs,
      {
        encoding: 'utf8',
        env: callEnv,
        shell: false,
        windowsHide: true,
        timeout: 15000,
        maxBuffer: 2 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        const outText = typeof stdout === 'string' ? stdout.trim() : '';
        const errText = typeof stderr === 'string' ? stderr.trim() : '';
        let parsed = null;
        if (outText) {
          try {
            parsed = JSON.parse(outText);
          } catch {}
        }
        const rpcError = parsed && typeof parsed.error === 'string' && parsed.error.trim()
          ? parsed.error.trim()
          : '';
        if (err || rpcError) {
          resolveRun({
            ok: false,
            parsed,
            error: rpcError || errText || (err && err.message) || 'agentapi execution failed',
          });
          return;
        }
        resolveRun({ ok: true, parsed: parsed || {}, error: '' });
      }
    );
  });
}

export const DEFAULT_CHAT_QUEUE_MAX_SIZE = 100;

function clampQueueInt(val, min, max, fallback) {
  const n = Number(val);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

/**
 * Bounded non-blocking async task queue (max 100 items) with automatic expiration/overflow eviction,
 * sequential `processNext()` execution, `Promise.all` batch processing, and per-step error isolation.
 */
export class Queue {
  constructor(options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    this.maxSize = clampQueueInt(opts.maxSize, 1, DEFAULT_CHAT_QUEUE_MAX_SIZE, DEFAULT_CHAT_QUEUE_MAX_SIZE);
    this.maxAgeMs = clampQueueInt(opts.maxAgeMs, 10, 3600000, 30000);
    this.taskTimeoutMs = clampQueueInt(opts.taskTimeoutMs, 20, 120000, 20000);
    this.parallelBatchSize = clampQueueInt(opts.parallelBatchSize, 1, 16, 4);
    this.autoProcess = opts.autoProcess !== false;
    this._nowFn = typeof opts.nowFn === 'function' ? opts.nowFn : () => Date.now();
    this._onError = typeof opts.onError === 'function' ? opts.onError : null;
    this._onDrop = typeof opts.onDrop === 'function' ? opts.onDrop : null;

    this._items = [];
    this._head = 0;
    this._seq = 0;
    this._processing = false;
    this._scheduled = false;
    this._disposed = false;
    this._expiryTimer = null;
    this._nextTickHandle = null;
    this._nextTickIsImmediate = false;
    this._stats = {
      enqueued: 0,
      completed: 0,
      failed: 0,
      timedOut: 0,
      droppedOverflow: 0,
      droppedExpired: 0,
      droppedSuperseded: 0,
      totalLatencyMs: 0,
      lastError: '',
      lastDropReason: '',
    };
  }

  _now() {
    try {
      const ts = Number(this._nowFn());
      if (Number.isFinite(ts)) return ts;
    } catch {}
    return Date.now();
  }

  get size() {
    return Math.max(0, this._items.length - this._head);
  }

  isEmpty() {
    return this.size === 0;
  }

  _shiftItem() {
    if (this._head >= this._items.length) return null;
    const item = this._items[this._head];
    this._items[this._head] = undefined;
    this._head += 1;
    if (this._head >= this._items.length) {
      this._items = [];
      this._head = 0;
    } else if (this._head >= 32 && this._head * 2 >= this._items.length) {
      this._items = this._items.slice(this._head);
      this._head = 0;
    }
    return item;
  }

  _clearExpiryTimer() {
    if (this._expiryTimer) {
      clearTimeout(this._expiryTimer);
      this._expiryTimer = null;
    }
  }

  _clearNextTick() {
    if (this._nextTickHandle) {
      if (this._nextTickIsImmediate && typeof clearImmediate === 'function') {
        clearImmediate(this._nextTickHandle);
      } else {
        clearTimeout(this._nextTickHandle);
      }
      this._nextTickHandle = null;
      this._nextTickIsImmediate = false;
    }
    this._scheduled = false;
  }

  _scheduleExpiryTimer() {
    this._clearExpiryTimer();
    if (this._disposed || this.size === 0) return;
    let minExpiresAt = Infinity;
    for (let i = this._head; i < this._items.length; i += 1) {
      const entry = this._items[i];
      if (entry && entry.expiresAt < minExpiresAt) {
        minExpiresAt = entry.expiresAt;
      }
    }
    if (!Number.isFinite(minExpiresAt)) return;
    const delayMs = Math.max(10, Math.min(minExpiresAt - this._now(), 60000));
    this._expiryTimer = setTimeout(() => {
      this._expiryTimer = null;
      if (!this._disposed) {
        this.pruneExpired();
      }
    }, delayMs);
    this._expiryTimer.unref?.();
  }

  _scheduleNextTick() {
    if (this._disposed || this._scheduled || this._processing || this.size === 0) return;
    this._scheduled = true;
    const runStep = () => {
      this._nextTickHandle = null;
      this._nextTickIsImmediate = false;
      this._scheduled = false;
      if (this._disposed || this.size === 0) return;
      this.processNext().catch(() => {});
    };
    if (typeof setImmediate === 'function') {
      this._nextTickIsImmediate = true;
      this._nextTickHandle = setImmediate(runStep);
    } else {
      this._nextTickIsImmediate = false;
      this._nextTickHandle = setTimeout(runStep, 0);
      this._nextTickHandle.unref?.();
    }
  }

  _rejectEntry(entry, code, message, dropped = true) {
    const err = new Error(message || code);
    err.code = code;
    err.dropped = Boolean(dropped);
    err.taskId = entry?.id || 0;
    if (dropped && this._onDrop) {
      try {
        this._onDrop({
          id: entry?.id || 0,
          label: entry?.label || 'task',
          groupKey: entry?.groupKey || 'default',
          code,
          message: err.message,
        });
      } catch {}
    }
    try {
      entry.reject(err);
    } catch {}
    return err;
  }

  pruneExpired(now = this._now()) {
    if (this.size === 0) {
      this._clearExpiryTimer();
      return 0;
    }
    const checkTs = Number.isFinite(Number(now)) ? Number(now) : this._now();
    const expired = [];
    const kept = [];
    for (let i = this._head; i < this._items.length; i += 1) {
      const entry = this._items[i];
      if (!entry) continue;
      if (checkTs >= entry.expiresAt) {
        expired.push(entry);
      } else {
        kept.push(entry);
      }
    }
    if (expired.length > 0) {
      this._items = kept;
      this._head = 0;
      for (const entry of expired) {
        this._stats.droppedExpired += 1;
        this._stats.lastDropReason = 'QUEUE_TASK_EXPIRED';
        this._rejectEntry(
          entry,
          'QUEUE_TASK_EXPIRED',
          pickLang(readActiveUiLanguage(), 'Задача автоматически сброшена по истечении времени ожидания в очереди', 'Queued task automatically dropped after waiting too long'),
          true
        );
      }
    }
    this._scheduleExpiryTimer();
    return expired.length;
  }

  supersedePending(predicate, code = 'QUEUE_SUPERSEDED', message = pickLang(readActiveUiLanguage(), 'Задача заменена более новым запросом', 'Task superseded by a newer request')) {
    if (this.size === 0 || typeof predicate !== 'function') return 0;
    const dropped = [];
    const kept = [];
    for (let i = this._head; i < this._items.length; i += 1) {
      const entry = this._items[i];
      if (!entry) continue;
      let match = false;
      try {
        match = Boolean(predicate(entry));
      } catch {}
      if (match) dropped.push(entry);
      else kept.push(entry);
    }
    if (dropped.length > 0) {
      this._items = kept;
      this._head = 0;
      for (const entry of dropped) {
        this._stats.droppedSuperseded += 1;
        this._stats.lastDropReason = code;
        this._rejectEntry(entry, code, message, true);
      }
      this._scheduleExpiryTimer();
    }
    return dropped.length;
  }

  enqueue(taskFn, meta = {}) {
    const lang = readActiveUiLanguage();
    if (this._disposed) {
      const err = new Error(pickLang(lang, 'Очередь остановлена', 'Queue is stopped'));
      err.code = 'QUEUE_DISPOSED';
      return Promise.reject(err);
    }
    if (typeof taskFn !== 'function') {
      const err = new Error(pickLang(lang, 'Задача очереди должна быть функцией', 'Queue task must be a function'));
      err.code = 'INVALID_TASK';
      return Promise.reject(err);
    }

    const metaObj = meta && typeof meta === 'object' ? meta : {};
    const now = this._now();
    this.pruneExpired(now);

    let guard = 0;
    while (this.size >= this.maxSize && guard++ <= this.maxSize) {
      const oldest = this._shiftItem();
      if (!oldest) break;
      this._stats.droppedOverflow += 1;
      this._stats.lastDropReason = 'QUEUE_OVERFLOW';
      this._rejectEntry(
        oldest,
        'QUEUE_OVERFLOW',
        pickLang(lang, `Очередь достигла лимита (${this.maxSize} сообщений): старая задача сброшена`, `Queue limit (${this.maxSize} messages) reached: oldest task dropped`),
        true
      );
    }

    const ttlMs = clampQueueInt(metaObj.maxAgeMs, 10, 3600000, this.maxAgeMs);
    const timeoutMs = clampQueueInt(metaObj.timeoutMs, 20, 120000, this.taskTimeoutMs);
    const groupKey = typeof metaObj.groupKey === 'string' && metaObj.groupKey.trim()
      ? metaObj.groupKey.trim().slice(0, 128)
      : 'default';
    const label = typeof metaObj.label === 'string' && metaObj.label.trim()
      ? metaObj.label.trim().slice(0, 80)
      : 'task';

    const entry = {
      id: ++this._seq,
      label,
      groupKey,
      createdAt: now,
      expiresAt: now + ttlMs,
      timeoutMs,
      taskFn,
      resolve: null,
      reject: null,
    };

    const taskPromise = new Promise((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
    });

    this._items.push(entry);
    this._stats.enqueued += 1;
    this._scheduleExpiryTimer();
    if (this.autoProcess && !this._processing) {
      this._scheduleNextTick();
    }
    return taskPromise;
  }

  async _executeEntry(entry) {
    const startedAt = this._now();
    if (startedAt >= entry.expiresAt) {
      this._stats.droppedExpired += 1;
      this._stats.lastDropReason = 'QUEUE_TASK_EXPIRED';
      const expiredErr = this._rejectEntry(
        entry,
        'QUEUE_TASK_EXPIRED',
        pickLang(readActiveUiLanguage(), 'Задача автоматически сброшена перед выполнением (просрочена)', 'Queued task automatically dropped before execution (expired)'),
        true
      );
      return { ok: false, id: entry.id, dropped: true, error: expiredErr };
    }

    const ac = new AbortController();
    let timeoutTimer = null;
    const timeoutPromise = new Promise((_, rejectTimeout) => {
      timeoutTimer = setTimeout(() => {
        try { ac.abort(); } catch {}
        const timeoutErr = new Error(pickLang(readActiveUiLanguage(), `Таймаут шага очереди (${entry.timeoutMs} мс)`, `Queue step timed out (${entry.timeoutMs} ms)`));
        timeoutErr.code = 'QUEUE_TASK_TIMEOUT';
        timeoutErr.timedOut = true;
        rejectTimeout(timeoutErr);
      }, entry.timeoutMs);
      timeoutTimer.unref?.();
    });

    try {
      const execPromise = Promise.resolve().then(() =>
        entry.taskFn({
          id: entry.id,
          label: entry.label,
          groupKey: entry.groupKey,
          signal: ac.signal,
          createdAt: entry.createdAt,
        })
      );
      execPromise.catch(() => {});
      const result = await Promise.race([execPromise, timeoutPromise]);
      this._stats.completed += 1;
      this._stats.totalLatencyMs += Math.max(0, this._now() - startedAt);
      try {
        entry.resolve(result);
      } catch {}
      return { ok: true, id: entry.id, result };
    } catch (err) {
      const errObj = err instanceof Error ? err : new Error(String(err || 'Queue step failed'));
      this._stats.failed += 1;
      if (errObj.code === 'QUEUE_TASK_TIMEOUT') {
        this._stats.timedOut += 1;
      }
      this._stats.lastError = errObj.message;
      if (this._onError) {
        try {
          this._onError(errObj, { id: entry.id, label: entry.label, groupKey: entry.groupKey });
        } catch {}
      }
      try {
        entry.reject(errObj);
      } catch {}
      return { ok: false, id: entry.id, error: errObj };
    } finally {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
    }
  }

  async processNext() {
    if (this._disposed) {
      return { processed: false, disposed: true, remaining: 0 };
    }
    if (this._processing) {
      return { processed: false, busy: true, remaining: this.size };
    }

    this._processing = true;
    this._clearNextTick();
    try {
      this.pruneExpired();
      const entry = this._shiftItem();
      this._scheduleExpiryTimer();
      if (!entry) {
        return { processed: false, empty: true, remaining: 0 };
      }
      const stepRes = await this._executeEntry(entry);
      return { ...stepRes, processed: true, remaining: this.size };
    } finally {
      this._processing = false;
      if (!this._disposed && this.autoProcess && this.size > 0) {
        this._scheduleNextTick();
      }
    }
  }

  async processBatch(maxItems = this.parallelBatchSize) {
    if (this._disposed) {
      return { processed: 0, succeeded: 0, failed: 0, results: [], remaining: 0 };
    }
    if (this._processing) {
      return { processed: 0, busy: true, succeeded: 0, failed: 0, results: [], remaining: this.size };
    }

    const limit = clampQueueInt(maxItems, 1, 16, this.parallelBatchSize);
    this._processing = true;
    this._clearNextTick();
    try {
      this.pruneExpired();
      const active = this._items.slice(this._head).filter(Boolean);
      this._items = [];
      this._head = 0;

      if (active.length === 0) {
        this._clearExpiryTimer();
        return { processed: 0, succeeded: 0, failed: 0, results: [], remaining: 0 };
      }

      const batch = [];
      const deferred = [];
      const seenGroups = new Set();
      for (const entry of active) {
        const gKey = entry.groupKey || 'default';
        if (batch.length < limit && !seenGroups.has(gKey)) {
          seenGroups.add(gKey);
          batch.push(entry);
        } else {
          deferred.push(entry);
        }
      }
      this._items = deferred;
      this._head = 0;
      this._scheduleExpiryTimer();

      const results = await Promise.all(batch.map((entry) => this._executeEntry(entry)));
      let succeeded = 0;
      let failed = 0;
      for (const r of results) {
        if (r && r.ok) succeeded += 1;
        else failed += 1;
      }
      return {
        processed: results.length,
        succeeded,
        failed,
        results,
        remaining: this.size,
      };
    } finally {
      this._processing = false;
      if (!this._disposed && this.autoProcess && this.size > 0) {
        this._scheduleNextTick();
      }
    }
  }

  async processAllParallel(batchSize = this.parallelBatchSize) {
    const waveResults = [];
    let totalProcessed = 0;
    let totalSucceeded = 0;
    let totalFailed = 0;
    const maxWaves = this.maxSize + 4;

    for (let wave = 0; wave < maxWaves; wave += 1) {
      if (this._disposed || this.size === 0) break;
      const batchRes = await this.processBatch(batchSize);
      if (batchRes.busy || batchRes.processed === 0) break;
      waveResults.push(batchRes);
      totalProcessed += batchRes.processed;
      totalSucceeded += batchRes.succeeded;
      totalFailed += batchRes.failed;
      if (this.size > 0) {
        await new Promise((resolveYield) => {
          if (typeof setImmediate === 'function') {
            setImmediate(resolveYield);
          } else {
            const t = setTimeout(resolveYield, 0);
            t.unref?.();
          }
        });
      }
    }

    return {
      processed: totalProcessed,
      succeeded: totalSucceeded,
      failed: totalFailed,
      waves: waveResults.length,
      remaining: this.size,
    };
  }

  clear(code = 'QUEUE_CLEARED', message = pickLang(readActiveUiLanguage(), 'Очередь очищена', 'Queue cleared')) {
    this._clearNextTick();
    this._clearExpiryTimer();
    const pending = this._items.slice(this._head).filter(Boolean);
    this._items = [];
    this._head = 0;
    for (const entry of pending) {
      this._stats.lastDropReason = code;
      this._rejectEntry(entry, code, message, true);
    }
    return pending.length;
  }

  dispose() {
    this._disposed = true;
    return this.clear('QUEUE_DISPOSED', pickLang(readActiveUiLanguage(), 'Очередь остановлена', 'Queue stopped'));
  }

  getStats() {
    const avgLatencyMs = this._stats.completed > 0
      ? Number((this._stats.totalLatencyMs / this._stats.completed).toFixed(1))
      : 0;
    return {
      size: this.size,
      maxSize: this.maxSize,
      maxAgeMs: this.maxAgeMs,
      taskTimeoutMs: this.taskTimeoutMs,
      processing: this._processing,
      disposed: this._disposed,
      ...this._stats,
      avgLatencyMs,
    };
  }
}

export async function dispatchChatMessageFromSidecar({
  message = '',
  conversationId = '',
  projectId = '',
  workspaceUris = [],
  rootDir = '',
  title = '',
  allowNewConversation = true,
  execAgentApiFn = null,
  eventsDir = '',
  env = process.env,
  lang = '',
} = {}) {
  const uiLang = lang ? normalizeLang(lang, readActiveUiLanguage()) : readActiveUiLanguage();
  const cleanMessage = typeof message === 'string' ? message.trim() : '';
  if (!cleanMessage) {
    return { ok: false, code: 'EMPTY_MESSAGE', error: pickLang(uiLang, 'Пустой текст запроса', 'Prompt message is empty') };
  }
  if (cleanMessage.length > 32000) {
    return { ok: false, code: 'MESSAGE_TOO_LONG', error: pickLang(uiLang, 'Слишком длинный текст запроса', 'Prompt message is too long') };
  }

  const hasHostEnv = Boolean(
    typeof execAgentApiFn === 'function' ||
    (env && env.ANTIGRAVITY_LS_ADDRESS && env.ANTIGRAVITY_CSRF_TOKEN)
  );
  if (!hasHostEnv) {
    return {
      ok: false,
      code: 'NO_AGENTAPI_ENV',
      error: pickLang(uiLang, 'Панель открыта вне контейнера Antigravity', 'Panel is running outside Antigravity host'),
    };
  }

  const cleanConvoId = typeof conversationId === 'string' && SAFE_SIDE_ID_RE.test(conversationId.trim())
    ? conversationId.trim()
    : '';
  const cleanTitle = typeof title === 'string'
    ? title.replace(/[\r\n\0]+/g, ' ').trim().slice(0, 120)
    : '';
  const cliMessage = cleanMessage.startsWith('-') ? (' ' + cleanMessage) : cleanMessage;
  const targetProjectId = resolveProjectIdForWorkspace({
    workspaceUris,
    rootDir,
    explicitProjectId: projectId,
    eventsDir,
    env,
  });

  const callEnv = { ...env };
  if (targetProjectId) {
    callEnv.ANTIGRAVITY_PROJECT_ID = targetProjectId;
  }

  const runner = typeof execAgentApiFn === 'function'
    ? (cliArgs) => execAgentApiFn(cliArgs, callEnv)
    : (cliArgs) => runAgentApiCliAsync(cliArgs, callEnv, env);

  if (cleanConvoId) {
    const sendArgs = ['send-message'];
    if (cleanTitle) sendArgs.push(`--title=${cleanTitle}`);
    sendArgs.push(cleanConvoId, cliMessage);
    const sendRes = await runner(sendArgs);
    if (sendRes && sendRes.ok) {
      return {
        ok: true,
        mode: 'existing_conversation',
        conversationId: cleanConvoId,
        projectId: targetProjectId,
      };
    }
    const errStr = String(sendRes?.error || '');
    const isNotFound = /not_found|trajectory not found/i.test(errStr);
    if (!isNotFound || allowNewConversation === false) {
      return {
        ok: false,
        code: 'SEND_FAILED',
        error: errStr || pickLang(uiLang, 'Не удалось отправить сообщение в текущий чат', 'Failed to send message to current chat'),
      };
    }
  }

  if (allowNewConversation === false) {
    return {
      ok: false,
      code: 'NO_ACTIVE_CONVERSATION',
      error: pickLang(uiLang, 'Активный чат не выбран', 'No active chat selected'),
    };
  }

  const tStartMs = Date.now();
  const newArgs = ['new-conversation'];
  if (cleanTitle) newArgs.push(`--title=${cleanTitle}`);
  newArgs.push(cliMessage);
  const newRes = await runner(newArgs);
  if (!newRes || !newRes.ok) {
    return {
      ok: false,
      code: 'NEW_CONVERSATION_FAILED',
      error: String(newRes?.error || pickLang(uiLang, 'Не удалось запустить новый чат', 'Failed to start a new chat')),
    };
  }

  const createdCid =
    extractConversationIdFromAgentApiOutput(newRes.parsed) ||
    detectNewlyCreatedBrainConversationId(tStartMs, env);

  return {
    ok: true,
    mode: 'new_conversation',
    conversationId: createdCid,
    projectId: targetProjectId,
  };
}

/**
 * @file pitfall-ledger.mjs
 * @description Модуль эпизодической памяти ошибок (#5 Episodic Pitfall Ledger).
 * Накапливает лаконичные предостережения и уроки из откатов (rollback), транзакционных отмен
 * и сбоев синтаксиса. Инжектирует их на этапе SessionStart, предотвращая повторение ошибок.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteJsonSync, safeReadJsonSync, updateJsonAtomicSync } from './safe-json.mjs';
import { resolveTunnelCacheDir } from './cache-dir.mjs';
import { redactSecretsInText } from './security-guard.mjs';

const UNSAFE_WORKSPACE_NAMES = new Set(['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty']);

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, '..');
const getCacheDir = () => resolveTunnelCacheDir(PLUGIN_ROOT);
const getMirrorFile = () => join(getCacheDir(), 'pitfalls-ledger.json');
const MAX_PITFALLS = 15;
const PITFALL_TTL_MS = 14 * 24 * 3600 * 1000; // TTL: 14 дней (авто-очистка устаревших граблей)

/**
 * Обеспечивает существование директории кэша.
 */
function ensureCacheDir() {
  const cacheDir = getCacheDir();
  if (!existsSync(cacheDir)) {
    mkdirSync(cacheDir, { recursive: true });
  }
}

/**
 * Определяет основной путь хранения реестра ошибок.
 * @param {string} [workspaceRoot='']
 * @returns {string}
 */
function getStoragePath(workspaceRoot = '') {
  if (workspaceRoot && typeof workspaceRoot === 'string') {
    const trimmed = workspaceRoot.trim();
    const isUnsafe =
      !trimmed ||
      trimmed.startsWith('-') ||
      basename(trimmed).startsWith('-') ||
      trimmed.includes('\0') ||
      UNSAFE_WORKSPACE_NAMES.has(trimmed) ||
      UNSAFE_WORKSPACE_NAMES.has(basename(trimmed));
    const looksLikeValidDir = !isUnsafe && existsSync(trimmed);
    if (looksLikeValidDir) {
      try {
        const agentsDir = join(trimmed, '.agents');
        if (!existsSync(agentsDir)) {
          mkdirSync(agentsDir, { recursive: true });
        }
        return join(agentsDir, 'pitfalls-ledger.json');
      } catch {}
    }
  }
  ensureCacheDir();
  return getMirrorFile();
}

/**
 * Загружает список правил из файла с авто-исцелением при повреждении.
 * @param {string} filePath
 * @returns {Array<object>}
 */
function loadFromFile(filePath) {
  const raw = safeReadJsonSync(filePath, () => [], { selfHeal: true });
  if (Array.isArray(raw)) {
    const now = Date.now();
    // Filter out expired entries on read without mutating disk under read callers
    return raw.filter((item) => {
      if (!item || !item.createdAt) return true;
      const ts = new Date(item.createdAt).getTime();
      if (isNaN(ts)) return true;
      return now - ts <= PITFALL_TTL_MS;
    });
  }
  return [];
}

/**
 * Сохраняет список правил в файл атомарно.
 * @param {string} filePath
 * @param {Array<object>} items
 */
function saveToFile(filePath, items) {
  atomicWriteJsonSync(filePath, items);
}

/**
 * Регистрирует новое правило или предостережение в реестре атомарно под файловым замком.
 * @param {object} params
 * @param {string} [params.type='rollback'] Тип ошибки ('rollback', 'syntax_abort', 'test_failure')
 * @param {string} [params.fileName=''] Имя или путь к файлу
 * @param {string} [params.summary=''] Описание инцидента или урока
 * @param {string} [params.workspaceRoot=''] Корень рабочей области
 * @returns {object} Записанный объект правила
 */
export function recordPitfall({
  type = 'rollback',
  fileName = '',
  summary = '',
  workspaceRoot = '',
  maxRuleLength = 160,
} = {}) {
  const primaryPath = getStoragePath(workspaceRoot);
  ensureCacheDir();

  const cleanBase = fileName ? basename(fileName) : '';
  let cleanSummary = redactSecretsInText(String(summary || ''))
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Игнорируем ложноположительные срабатывания Test-Impact при таймауте, если в выводе только ✔/✓ без реального падения
  if (type === 'test_failure' || type === 'test_fail') {
    const payloadAfterPrefix = cleanSummary.replace(
      /^(?:\[[^\]]+\]\s*)?(?:test-impact\s+fail(?:ed)?|micro-test\s+failed)(?:\s*\([^)]*\))?:\s*/i,
      ''
    );
    const hasPassGlyph = /[✔✓]/.test(payloadAfterPrefix);
    const hasRealFailureMarker =
      /[✖✗×]|\bnot ok\b|\b(?:error|fail(?:ed|ure)?|exception|syntaxerror|referenceerror|typeerror|assertionerror)\b/i.test(
        payloadAfterPrefix
      );
    if (hasPassGlyph && !hasRealFailureMarker) {
      return {
        id: null,
        type,
        fileName: cleanBase,
        rule: cleanSummary,
        ignoredFalsePositive: true,
      };
    }
  }

  let ruleText = cleanSummary;
  if (!ruleText.startsWith('[')) {
    const prefix = cleanBase ? `[${cleanBase}] ` : `[${type}] `;
    ruleText = `${prefix}${cleanSummary}`;
  }

  // Ограничиваем правило по границе слова (160 по умолчанию, до 220 для ReasoningBank)
  const capLen = Math.max(80, Math.min(240, Number(maxRuleLength) || 160));
  if (ruleText.length > capLen) {
    const sliced = ruleText.slice(0, capLen - 3);
    const lastSpace = sliced.lastIndexOf(' ');
    ruleText = `${(lastSpace > Math.floor(capLen * 0.6) ? sliced.slice(0, lastSpace) : sliced).trim()}...`;
  }

  let normKey;
  if (type === 'test_failure' || type === 'test_fail') {
    const mTest = cleanSummary.match(/\(([^)]+)\)/);
    const testKey = (mTest ? mTest[1] : cleanSummary.slice(0, 40)).toLowerCase().replace(/[^a-z0-9а-яё._-]/gi, '');
    normKey = `${type}::${cleanBase.toLowerCase()}::${testKey}`;
  } else if (type === 'syntax_abort' || type === 'syntax_error') {
    normKey = `${type}::${cleanBase.toLowerCase()}`;
  } else {
    normKey = `${type}::${cleanBase.toLowerCase()}::${ruleText
      .toLowerCase()
      .replace(/[^a-z0-9а-яё]/gi, '')
      .slice(0, 60)}`;
  }

  const now = new Date().toISOString();
  const id = `pf_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const normWs = workspaceRoot ? workspaceRoot.replace(/\\/g, '/').toLowerCase() : '';

  const newEntry = {
    id,
    type,
    fileName: cleanBase,
    rule: ruleText,
    workspaceRoot: normWs,
    createdAt: now,
    normKey
  };

  const updatedList = updateJsonAtomicSync(primaryPath, () => [], (existing) => {
    let list = Array.isArray(existing) ? existing : [];
    if (list.length === 0 && primaryPath !== getMirrorFile()) {
      const mirrorList = loadFromFile(getMirrorFile()).filter(
        (item) => !normWs || (Boolean(item.workspaceRoot) && item.workspaceRoot === normWs)
      );
      if (mirrorList.length > 0) list = mirrorList;
    }

    const curTime = Date.now();
    list = list.filter((item) => {
      if (!item || !item.createdAt) return true;
      const ts = new Date(item.createdAt).getTime();
      if (isNaN(ts)) return true;
      return curTime - ts <= PITFALL_TTL_MS;
    });

    // Дедупликация: удаляем старый дубликат при наличии
    list = list.filter((item) => item.normKey !== normKey);
    list.unshift(newEntry);

    // Ограничиваем не более MAX_PITFALLS (15) записей
    if (list.length > MAX_PITFALLS) {
      list = list.slice(0, MAX_PITFALLS);
    }

    return list;
  });

  if (primaryPath !== getMirrorFile()) {
    updateJsonAtomicSync(getMirrorFile(), () => [], (mirrorExisting) => {
      const others = Array.isArray(mirrorExisting)
        ? mirrorExisting.filter((item) => item && (!item.workspaceRoot || item.workspaceRoot !== normWs))
        : [];
      return [...updatedList, ...others].slice(0, MAX_PITFALLS * 4);
    });
  }

  return {
    id: newEntry.id,
    type: newEntry.type,
    fileName: newEntry.fileName,
    rule: newEntry.rule,
    createdAt: newEntry.createdAt
  };
}

/**
 * Возвращает список правил из реестра.
 * @param {number} [limit=15]
 * @param {string} [workspaceRoot='']
 * @returns {Array<{ id: string, type: string, fileName: string, rule: string, createdAt: string }>}
 */
export function listPitfalls(limit = 15, workspaceRoot = '') {
  const primaryPath = getStoragePath(workspaceRoot);
  const normWs = workspaceRoot ? workspaceRoot.replace(/\\/g, '/').toLowerCase() : '';
  let list = loadFromFile(primaryPath);
  if (list.length === 0 && primaryPath !== getMirrorFile()) {
    list = loadFromFile(getMirrorFile()).filter(
      (item) => !normWs || (item.workspaceRoot && item.workspaceRoot === normWs)
    );
  } else if (normWs) {
    list = list.filter((item) => Boolean(item.workspaceRoot) && item.workspaceRoot === normWs);
  }

  return list.slice(0, Math.max(1, limit)).map((item) => ({
    id: item.id,
    type: item.type,
    fileName: item.fileName,
    rule: item.rule,
    createdAt: item.createdAt
  }));
}

/**
 * Очищает реестр предостережений.
 * @param {string} [workspaceRoot='']
 * @returns {{ ok: boolean }}
 */
export function clearPitfalls(workspaceRoot = '') {
  const primaryPath = getStoragePath(workspaceRoot);
  saveToFile(primaryPath, []);
  if (primaryPath !== getMirrorFile()) {
    const normWs = workspaceRoot ? workspaceRoot.replace(/\\/g, '/').toLowerCase() : '';
    updateJsonAtomicSync(getMirrorFile(), () => [], (existing) => {
      const list = Array.isArray(existing) ? existing : [];
      return normWs
        ? list.filter((item) => item && (!item.workspaceRoot || item.workspaceRoot !== normWs))
        : [];
    });
  }
  return { ok: true };
}

/**
 * Удаляет исправленные записи о синтаксических ошибках и провалах тестов для файла после успешной проверки.
 * @param {object} [params={}]
 * @param {string} [params.fileName=''] Имя или путь к файлу
 * @param {string} [params.workspaceRoot=''] Корень рабочей области
 * @param {string[]} [params.types=['syntax_abort', 'syntax_error', 'test_failure', 'test_fail']] Типы записей к очистке
 * @returns {{ removed: number }}
 */
export function resolvePitfallsForFile(opts = {}) {
  const {
    fileName = '',
    workspaceRoot = '',
    types = ['syntax_abort', 'syntax_error', 'test_failure', 'test_fail'],
  } = opts && typeof opts === 'object' ? opts : {};
  const cleanBase = fileName ? basename(fileName).toLowerCase() : '';
  if (!cleanBase) return { removed: 0 };

  const typeSet = new Set(Array.isArray(types) ? types : []);
  if (typeSet.size === 0) return { removed: 0 };

  const primaryPath = getStoragePath(workspaceRoot);
  const normWs = workspaceRoot ? workspaceRoot.replace(/\\/g, '/').toLowerCase() : '';
  const matchesResolved = (item) => {
    if (!item || !typeSet.has(item.type)) return false;
    const itemBase = String(item.fileName || '').toLowerCase();
    const itemRule = String(item.rule || '').toLowerCase();
    return itemBase === cleanBase || itemRule.includes(`(${cleanBase})`);
  };

  const primaryPreview = loadFromFile(primaryPath);
  const hasPrimaryMatch = primaryPreview.some(matchesResolved);
  let hasMirrorMatch = false;
  if (primaryPath !== getMirrorFile() && existsSync(getMirrorFile())) {
    const mirrorPreview = loadFromFile(getMirrorFile());
    hasMirrorMatch = mirrorPreview.some(
      (item) => (!normWs || item.workspaceRoot === normWs) && matchesResolved(item)
    );
  }

  if (!hasPrimaryMatch && !hasMirrorMatch) {
    return { removed: 0 };
  }

  let removed = 0;
  if (hasPrimaryMatch) {
    updateJsonAtomicSync(primaryPath, () => [], (existing) => {
      const list = Array.isArray(existing) ? existing : [];
      return list.filter((item) => {
        if (matchesResolved(item)) {
          removed++;
          return false;
        }
        return true;
      });
    });
  }

  if (hasMirrorMatch && primaryPath !== getMirrorFile()) {
    updateJsonAtomicSync(getMirrorFile(), () => [], (existing) => {
      const list = Array.isArray(existing) ? existing : [];
      return list.filter((item) => {
        const sameWs = !normWs ? !item?.workspaceRoot : item?.workspaceRoot === normWs;
        if (sameWs && matchesResolved(item)) {
          if (!hasPrimaryMatch) removed++;
          return false;
        }
        return true;
      });
    });
  }

  return { removed };
}

/**
 * Records a compact single-line ReasoningBank contrastive lesson:
 * `[file] Avoid: <antiPattern> -> Why: <rootCause> -> Fix: <verifiedFix>` (<= 220 chars).
 * @param {object} [params={}]
 */
export function recordContrastiveLesson({
  fileName = '',
  antiPattern = '',
  rootCause = '',
  verifiedFix = '',
  workspaceRoot = '',
} = {}) {
  const cleanFile = fileName ? basename(String(fileName).trim()) : 'general';
  const cleanAnti = String(antiPattern || '').replace(/\s+/g, ' ').trim();
  const cleanWhy = String(rootCause || '').replace(/\s+/g, ' ').trim();
  const cleanFix = String(verifiedFix || '').replace(/\s+/g, ' ').trim();
  const parts = [];
  if (cleanAnti) parts.push(`Avoid: ${cleanAnti}`);
  if (cleanWhy) parts.push(`Why: ${cleanWhy}`);
  if (cleanFix) parts.push(`Fix: ${cleanFix}`);
  const summary = parts.length > 0 ? `[${cleanFile}] ${parts.join(' -> ')}` : `[${cleanFile}] Contrastive lesson`;
  return recordPitfall({
    type: 'reasoning_bank',
    fileName: cleanFile,
    summary,
    workspaceRoot,
    maxRuleLength: 220,
  });
}

/**
 * Форматирует топ-10 правил в компактный Markdown-список для замороженной инъекции в SessionStart.
 * @param {string} [workspaceRoot='']
 * @returns {string} Markdown-блок или пустая строка
 */
export function formatPitfallsForSessionStart(workspaceRoot = '') {
  const items = listPitfalls(10, workspaceRoot);
  if (!items || items.length === 0) {
    return '';
  }

  const lines = [
    '## Pitfall Ledger (Do Not Repeat):',
    ...items.map((p) => `- ⚠️ ${p.rule}`)
  ];

  let formatted = lines.join('\n');
  if (formatted.length > 1200) {
    formatted = `${formatted.slice(0, 1180)}\n- ... *(more pitfalls omitted)*`;
  }

  return formatted;
}

/**
 * @file shadow-guard.mjs
 * @description Модуль теневых чекпоинтов (Shadow Guard) плагина The Tunnel (antigravity-model-router).
 * Создаёт быстрые теневые копии изменяемых файлов перед вызовами edit_file/write_file,
 * позволяя мгновенно откатить повреждённые или ошибочно изменённые файлы.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeReadJsonSync, atomicWriteJsonSync, withFileLockSync } from './safe-json.mjs';
import { recordModelOutcome } from './bayesian-router.mjs';
import { recordPitfall } from './pitfall-ledger.mjs';
import { invalidateReadCacheForFile } from './read-dedup.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, '..');
const CACHE_DIR = join(PLUGIN_ROOT, '.cache');
const CHECKPOINTS_DIR = join(CACHE_DIR, 'shadow-checkpoints');
const INDEX_FILE = join(CHECKPOINTS_DIR, 'index.json');
const MAX_CHECKPOINTS_PER_WORKSPACE = 60;
const MAX_TOTAL_CHECKPOINTS = 300;
const MAX_BACKUP_SIZE_BYTES = 2 * 1024 * 1024; // Лимит размера для бэкапа — 2 МБ
const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const PROJECT_ROOT_MARKERS = [
  '.git',
  'package.json',
  'plugin.json',
  'book.json',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
  'composer.json',
  'pom.xml',
];
const UMBRELLA_DIR_NAMES = new Set([
  'downloads',
  'documents',
  'desktop',
  'books',
  'projects',
  'repos',
  'workspaces',
  'scratch',
  'plugins',
]);

/**
 * Проверяет наличие директории хранилища чекпоинтов и создаёт её при необходимости.
 */
function ensureStorage() {
  if (!existsSync(CHECKPOINTS_DIR)) {
    mkdirSync(CHECKPOINTS_DIR, { recursive: true });
  }
}

/**
 * Читает индекс чекпоинтов из index.json.
 * @returns {Array<object>} Массив чекпоинтов.
 */
function loadIndex() {
  ensureStorage();
  const raw = safeReadJsonSync(INDEX_FILE, () => []);
  return Array.isArray(raw) ? raw : [];
}

/**
 * Проверяет, следует ли игнорировать файл (артефакты, логи диалогов, внутренняя папка .cache).
 * @param {string} filePath Путь к файлу.
 * @returns {boolean} True, если файл должен быть проигнорирован.
 */
export function isIgnoredPath(filePath) {
  if (!filePath || typeof filePath !== 'string') return true;
  const norm = filePath.replace(/\\/g, '/').toLowerCase();
  if (
    /(?:^|\/)(?:\.gemini\/antigravity\/brain|antigravity\/brain|\.system_generated|\.cache)(?:\/|$)/.test(norm)
  ) {
    return true;
  }
  return false;
}

function normalizeRootForMatch(p = '') {
  const s = resolve(String(p || '')).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? s.toLowerCase() : s;
}

function hasProjectMarker(dirPath = '') {
  if (!dirPath) return false;
  for (const m of PROJECT_ROOT_MARKERS) {
    try {
      if (existsSync(join(dirPath, m))) return true;
    } catch {}
  }
  return false;
}

function findNearestMarkerRoot(filePath = '') {
  if (!filePath) return '';
  let dir = dirname(resolve(filePath));
  const homeNorm = normalizeRootForMatch(homedir() || '');
  for (let i = 0; i < 10; i++) {
    const dirNorm = normalizeRootForMatch(dir);
    if (homeNorm && dirNorm === homeNorm) break;
    if (hasProjectMarker(dir)) return dir;
    const parent = dirname(dir);
    if (!parent || parent === dir) break;
    dir = parent;
  }
  return '';
}

/**
 * Resolves the true project root for an edited file, preventing umbrella folders
 * (like Downloads/Desktop/scratch) or external workspace sessions from swallowing
 * separate projects (e.g. plugin.json, book.json, .git, package.json).
 * @param {string} [filePath='']
 * @param {string} [workspaceRoot='']
 * @returns {string}
 */
export function resolveEffectiveProjectRoot(filePath = '', workspaceRoot = '') {
  const cleanFile = safeStr(filePath, 1024).trim();
  const cleanWs = safeStr(workspaceRoot, 1024).trim();
  if (!cleanFile) {
    return cleanWs ? resolve(cleanWs) : process.cwd();
  }
  const absFile = resolve(cleanFile);
  const markerRoot = findNearestMarkerRoot(absFile);
  if (!cleanWs || cleanWs === '__all__' || cleanWs === '__auto__') {
    return markerRoot || dirname(absFile);
  }
  const absWs = resolve(cleanWs);
  const normFile = normalizeRootForMatch(absFile);
  const normWs = normalizeRootForMatch(absWs);

  if (normFile !== normWs && !normFile.startsWith(`${normWs}/`)) {
    return markerRoot || dirname(absFile);
  }

  if (markerRoot) {
    const normMarker = normalizeRootForMatch(markerRoot);
    if (normMarker !== normWs && normMarker.startsWith(`${normWs}/`)) {
      const wsBaseLower = basename(absWs).toLowerCase();
      if (UMBRELLA_DIR_NAMES.has(wsBaseLower) || !hasProjectMarker(absWs)) {
        return markerRoot;
      }
    }
  }
  return absWs;
}

function resolveRepoRootForFile(filePath = '') {
  return resolveEffectiveProjectRoot(filePath, '');
}

/**
 * Создаёт теневой чекпоинт перед изменением файла.
 * @param {object} params Параметры чекпоинта.
 * @param {string} params.filePath Путь к файлу.
 * @param {string} [params.conversationId=''] ID диалога.
 * @param {string} [params.toolName='edit_file'] Имя вызванного инструмента.
 * @param {number} [params.stepIdx=0] Номер шага в диалоге.
 * @returns {object|null} Объект чекпоинта или null, если путь игнорируется.
 */
function safeStr(val, maxLen = 512) {
  if (typeof val !== 'string') return '';
  return val.replace(/\0/g, '').slice(0, maxLen);
}

function normPathKey(filePath = '') {
  const p = resolve(safeStr(filePath) || '.');
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

function matchesWorkspaceCheckpoint(cp, workspaceRoot = '') {
  const cleanWs = safeStr(workspaceRoot).trim();
  if (!cleanWs || cleanWs === '__all__') return true;
  if (!cp || typeof cp !== 'object') return false;
  const cpEffective = cp.filePath
    ? resolveEffectiveProjectRoot(cp.filePath, cp.workspaceRoot || '')
    : (cp.workspaceRoot ? resolve(cp.workspaceRoot) : '');
  const normTarget = normalizeRootForMatch(cleanWs);
  const normCpWs = cpEffective ? normalizeRootForMatch(cpEffective) : '';
  if (normCpWs && normCpWs === normTarget) return true;
  if (cp.filePath) {
    const normFile = normalizeRootForMatch(cp.filePath);
    if (normFile === normTarget || normFile.startsWith(`${normTarget}/`)) {
      const targetBase = basename(normTarget).toLowerCase();
      if (!UMBRELLA_DIR_NAMES.has(targetBase) && (!normCpWs || normCpWs.startsWith(`${normTarget}/`))) {
        return true;
      }
    }
  }
  return false;
}

export function createShadowCheckpoint(params = {}) {
  const safe = params && typeof params === 'object' && !Array.isArray(params) ? params : null;
  if (!safe) return null;
  const filePath = safeStr(safe.filePath, 1024).trim();
  if (!filePath || isIgnoredPath(filePath)) {
    return null;
  }
  const workspaceRoot = safeStr(safe.workspaceRoot, 1024).trim();
  const conversationId = safeStr(safe.conversationId, 128);
  const toolName = safeStr(safe.toolName, 64) || 'edit_file';
  const stepIdx = Number(safe.stepIdx || 0) || 0;
  const turnId = safeStr(safe.turnId, 128).trim();
  const turnLabel = safeStr(safe.turnLabel, 120).replace(/\s+/g, ' ').trim();

  ensureStorage();
  const absPath = resolve(filePath);
  const absKey = process.platform === 'win32' ? absPath.toLowerCase() : absPath;
  const effectiveWs = resolveEffectiveProjectRoot(absPath, workspaceRoot);

  let preExisted = false;
  let preSizeBytes = 0;
  let preMtimeMs = 0;
  let preBeforePreview = '';
  let preBeforeLines = 0;
  try {
    if (existsSync(absPath)) {
      preExisted = true;
      const st = statSync(absPath);
      if (st.isFile()) {
        preSizeBytes = st.size;
        preMtimeMs = st.mtimeMs;
        if (preSizeBytes <= 256 * 1024) {
          const text = readFileSync(absPath, 'utf8');
          preBeforePreview = text.slice(0, 400);
          preBeforeLines = text ? text.split(/\r?\n/).length : 0;
        }
      }
    }
  } catch {}

  let checkpoint = null;
  let evicted = [];

  withFileLockSync(INDEX_FILE, () => {
    const currentList = loadIndex();
    if (preExisted && preSizeBytes > 0) {
      // Skip duplicate .bak copy only when the same turn already snapshotted exact size+mtime
      const latestSame = currentList.find((c) => {
        if (c.restored || !c.filePath) return false;
        const cKey = process.platform === 'win32' ? String(c.filePath).toLowerCase() : String(c.filePath);
        return cKey === absKey;
      });
      if (
        latestSame &&
        String(latestSame.turnId || '') === turnId &&
        (latestSame.backedUp ?? latestSame.existed) &&
        latestSame.sizeBytes === preSizeBytes &&
        latestSame.mtimeMs === preMtimeMs
      ) {
        checkpoint = latestSame;
        return;
      }
    }

    const id = `chk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const bakPath = join(CHECKPOINTS_DIR, `${id}.bak`);
    let backedUp = false;

    if (preExisted && preSizeBytes <= MAX_BACKUP_SIZE_BYTES) {
      try {
        copyFileSync(absPath, bakPath);
        backedUp = true;
      } catch {
        backedUp = false;
      }
    }

    checkpoint = {
      id,
      filePath: absPath,
      fileName: basename(absPath),
      workspaceRoot: effectiveWs,
      timestamp: new Date().toISOString(),
      conversationId,
      toolName,
      stepIdx,
      turnId,
      turnLabel,
      existed: preExisted,
      backedUp,
      sizeBytes: preSizeBytes,
      mtimeMs: preMtimeMs,
      beforeLines: preBeforeLines,
      beforePreview: preBeforePreview,
      restored: false,
    };

    const list = [checkpoint, ...currentList];

    const countsByWs = new Map();
    const kept = [];
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const itemWs = item.filePath
        ? resolveEffectiveProjectRoot(item.filePath, item.workspaceRoot || '')
        : (item.workspaceRoot || '');
      const wsKey = itemWs ? normalizeRootForMatch(itemWs) : 'global';
      const cnt = (countsByWs.get(wsKey) || 0) + 1;
      if (cnt <= MAX_CHECKPOINTS_PER_WORKSPACE) {
        countsByWs.set(wsKey, cnt);
        kept.push(item);
      } else {
        evicted.push(item);
      }
    }
    if (kept.length > MAX_TOTAL_CHECKPOINTS) {
      evicted.push(...kept.splice(MAX_TOTAL_CHECKPOINTS));
    }
    atomicWriteJsonSync(INDEX_FILE, kept);
  }, { maxWaitMs: 12000 });

  for (const old of evicted) {
    if (old.backedUp ?? old.existed) {
      const oldBak = join(CHECKPOINTS_DIR, `${old.id}.bak`);
      try {
        if (existsSync(oldBak)) {
          unlinkSync(oldBak);
        }
      } catch {}
    }
  }

  return checkpoint;
}

/**
 * Возвращает список последних чекпоинтов (сначала новые).
 * @param {number} [limit=15] Максимальное количество записей.
 * @param {string} [workspaceRoot=''] Опциональный фильтр по воркспейсу.
 * @returns {Array<object>} Массив чекпоинтов.
 */
export function listCheckpoints(limit = 15, workspaceRoot = '') {
  const safeLimit = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(200, Math.round(Number(limit)))) : 15;
  const cleanWs = safeStr(workspaceRoot, 1024).trim();
  const list = loadIndex();
  const filtered = (cleanWs && cleanWs !== '__all__')
    ? list.filter((c) => matchesWorkspaceCheckpoint(c, cleanWs))
    : list;
  return filtered.slice(0, safeLimit).map((c) => {
    const effectiveWs = c?.filePath
      ? resolveEffectiveProjectRoot(c.filePath, c.workspaceRoot || '')
      : (c?.workspaceRoot ? resolve(c.workspaceRoot) : '');
    return {
      ...c,
      workspaceRoot: effectiveWs || c?.workspaceRoot || '',
      projectName: effectiveWs ? basename(effectiveWs) : '',
    };
  });
}

function isEphemeralCheckpointDir(dirPath = '') {
  if (!dirPath || typeof dirPath !== 'string') return true;
  const norm = dirPath.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  if (!norm) return true;
  const sysTmp = String(tmpdir() || '').trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  if (sysTmp && (norm === sysTmp || norm.startsWith(`${sysTmp}/`))) return true;
  if (
    norm.includes('/appdata/local/temp/') ||
    norm.endsWith('/appdata/local/temp') ||
    norm === '/tmp' ||
    norm.startsWith('/tmp/') ||
    norm.startsWith('/private/tmp/') ||
    norm.includes('/var/folders/')
  ) {
    return true;
  }
  const segs = norm.split('/');
  return segs.some((seg) => /^(?:amr-|ag-local-rag-|antigravity-test-)/i.test(seg));
}

/**
 * Возвращает список уникальных проектов, для которых есть снимки в индексе.
 * @returns {Array<{ workspaceRoot: string, projectName: string, checkpointsCount: number, activeCheckpointsCount: number, lastTimestamp: string }>}
 */
export function listCheckpointWorkspaces() {
  const list = loadIndex();
  const byWs = new Map();
  for (const cp of list) {
    if (!cp || typeof cp !== 'object') continue;
    const effectiveWs = cp.filePath
      ? resolveEffectiveProjectRoot(cp.filePath, cp.workspaceRoot || '')
      : (cp.workspaceRoot ? resolve(cp.workspaceRoot) : '');
    if (!effectiveWs || isEphemeralCheckpointDir(effectiveWs)) continue;
    try {
      if (!existsSync(effectiveWs)) continue;
    } catch {
      continue;
    }
    const key = normalizeRootForMatch(effectiveWs);
    let rec = byWs.get(key);
    if (!rec) {
      rec = {
        workspaceRoot: effectiveWs,
        projectName: basename(effectiveWs) || effectiveWs,
        checkpointsCount: 0,
        activeCheckpointsCount: 0,
        lastTimestamp: cp.timestamp || '',
      };
      byWs.set(key, rec);
    }
    rec.checkpointsCount += 1;
    if (!cp.restored) rec.activeCheckpointsCount += 1;
    if (cp.timestamp && (!rec.lastTimestamp || new Date(cp.timestamp) > new Date(rec.lastTimestamp))) {
      rec.lastTimestamp = cp.timestamp;
    }
  }
  return Array.from(byWs.values()).sort(
    (a, b) => new Date(b.lastTimestamp || 0).getTime() - new Date(a.lastTimestamp || 0).getTime()
  );
}

function inferDomainForFile(filePath = '') {
  const fpLower = String(filePath || '').toLowerCase();
  return /(?:security|auth|guard|secret|token|crypt|firewall)/i.test(fpLower)
    ? 'security'
    : /\.(?:css|scss|less|html|vue|svelte|jsx|tsx)$|(?:view|ui|component|style|theme|modal|panel|particle|anim)/i.test(fpLower)
      ? 'ui_browser'
      : /\.(?:md|txt|rst)$/i.test(fpLower)
        ? 'docs'
        : /\.(?:sql|prisma)$|(?:schema|migration|controller|route|db|database)/i.test(fpLower)
          ? 'backend_db'
          : /(?:dockerfile|\.ya?ml|\.sh|\.ps1|compose)/i.test(fpLower)
            ? 'devops'
            : 'algo_refactor';
}

function computeLineDiffStats(beforeText = '', afterText = '') {
  const aStr = typeof beforeText === 'string' ? beforeText : '';
  const bStr = typeof afterText === 'string' ? afterText : '';
  if (aStr === bStr) return { addedLines: 0, removedLines: 0 };
  const aLines = aStr ? aStr.split(/\r?\n/) : [];
  const bLines = bStr ? bStr.split(/\r?\n/) : [];
  if (aLines.length === 0) return { addedLines: bLines.length, removedLines: 0 };
  if (bLines.length === 0) return { addedLines: 0, removedLines: aLines.length };

  if (aLines.length * bLines.length <= 200_000) {
    const n = aLines.length;
    const m = bLines.length;
    let prev = new Uint32Array(m + 1);
    let curr = new Uint32Array(m + 1);
    for (let i = 1; i <= n; i++) {
      const lineA = aLines[i - 1];
      curr.fill(0);
      for (let j = 1; j <= m; j++) {
        curr[j] = lineA === bLines[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
      }
      const tmp = prev;
      prev = curr;
      curr = tmp;
    }
    const lcs = prev[m];
    return {
      removedLines: Math.max(0, n - lcs),
      addedLines: Math.max(0, m - lcs),
    };
  }

  const freqA = new Map();
  for (const line of aLines) freqA.set(line, (freqA.get(line) || 0) + 1);
  let matched = 0;
  for (const line of bLines) {
    const cnt = freqA.get(line) || 0;
    if (cnt > 0) {
      matched += 1;
      freqA.set(line, cnt - 1);
    }
  }
  return {
    removedLines: Math.max(0, aLines.length - matched),
    addedLines: Math.max(0, bLines.length - matched),
  };
}

/**
 * Выполняет откат к указанному чекпоинту.
 * @param {string} [checkpointId='latest'] ID чекпоинта или 'latest' для последнего неоткаченного.
 * @param {string} [workspaceRoot=''] Опциональный фильтр по воркспейсу для 'latest'.
 * @returns {{ ok: boolean, checkpoint?: object, error?: string }} Результат отката.
 */
export function rollbackCheckpoint(checkpointId = 'latest', workspaceRoot = '', { lang = 'ru' } = {}) {
  const isEn = String(lang || '').trim().toLowerCase() === 'en';
  const cleanId = safeStr(checkpointId, 128).trim();
  const rawWs = safeStr(workspaceRoot, 1024).trim();
  const cleanWs = rawWs === '__all__' ? '' : rawWs;
  if (!cleanId || BLOCKED_KEYS.has(cleanId)) {
    return { ok: false, error: isEn ? 'Invalid checkpointId' : 'Некорректный checkpointId' };
  }
  ensureStorage();
  const lockOutcome = withFileLockSync(INDEX_FILE, () => {
    const list = loadIndex();
    if (list.length === 0) {
      return { ok: false, error: isEn ? 'Checkpoints list is empty' : 'Список чекпоинтов пуст' };
    }

    let checkpoint = null;
    if (cleanId === 'latest') {
      const candidates = cleanWs
        ? list.filter((c) => matchesWorkspaceCheckpoint(c, cleanWs))
        : list;
      if (candidates.length === 0) {
        return { ok: false, error: isEn ? 'No checkpoints found for current workspace' : 'Чекпоинты для текущего воркспейса не найдены' };
      }
      checkpoint = candidates.find((c) => !c.restored) || candidates[0];
    } else {
      checkpoint = list.find((c) => c.id === cleanId);
    }

    if (!checkpoint) {
      return { ok: false, error: isEn ? `Checkpoint not found: ${cleanId}` : `Чекпоинт не найден: ${cleanId}` };
    }

    try {
      const hasBackup = checkpoint.backedUp !== undefined ? Boolean(checkpoint.backedUp) : Boolean(checkpoint.existed);
      if (checkpoint.existed) {
        if (!hasBackup) {
          return {
            ok: false,
            error: isEn
              ? `File ${checkpoint.fileName} exceeded shadow backup limit (>2 MB) or was locked during snapshot; rollback cancelled to protect data`
              : `Файл ${checkpoint.fileName} превышал лимит теневой копии (>2 МБ) или был занят при создании снимка; откат отменён для защиты данных`,
          };
        }
        const bakPath = join(CHECKPOINTS_DIR, `${checkpoint.id}.bak`);
        if (!existsSync(bakPath)) {
          return { ok: false, error: isEn ? `Snapshot file ${checkpoint.id}.bak is missing` : `Файл снимка ${checkpoint.id}.bak отсутствует` };
        }
        mkdirSync(dirname(checkpoint.filePath), { recursive: true });
        copyFileSync(bakPath, checkpoint.filePath);
      } else {
        // Если файл был создан с нуля инструментом — аккуратно удаляем его
        if (existsSync(checkpoint.filePath)) {
          unlinkSync(checkpoint.filePath);
        }
      }

      const restoredAt = new Date().toISOString();
      const updated = list.map((c) => (
        c.id === checkpoint.id ? { ...c, restored: true, restoredAt } : c
      ));
      atomicWriteJsonSync(INDEX_FILE, updated);
      checkpoint = { ...checkpoint, restored: true, restoredAt };
      return { ok: true, checkpoint };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  });

  if (!lockOutcome.ok) {
    return lockOutcome;
  }

  const { checkpoint } = lockOutcome;
  try {
    invalidateReadCacheForFile(checkpoint.filePath);
  } catch {}

  const effectiveWs = resolveEffectiveProjectRoot(checkpoint.filePath, checkpoint.workspaceRoot || '');

  // Автоматическая синхронная фиксация инцидента отката в Pitfall Ledger
  try {
    recordPitfall({
      type: 'rollback',
      fileName: checkpoint.fileName,
      workspaceRoot: effectiveWs,
      summary: `Rollback (${checkpoint.toolName}) in ${checkpoint.fileName}: verify edge-cases; do not repeat reverted patch.`,
    });
  } catch {}

  try {
    recordModelOutcome({
      domain: inferDomainForFile(checkpoint.filePath),
      filePath: checkpoint.filePath,
      workspaceRoot: effectiveWs,
      success: false,
      signalType: 'rollback',
    });
  } catch {}

  return { ok: true, checkpoint };
}

/**
 * Возвращает список последних ходов диалога (Turn-Level Checkpoints), агрегированных из файловых снимков.
 * @param {number} [limit=12]
 * @param {string} [workspaceRoot='']
 * @returns {Array<object>}
 */
export function listTurnCheckpoints(limit = 12, workspaceRoot = '') {
  const safeLimit = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(100, Math.round(Number(limit)))) : 12;
  const cleanWs = safeStr(workspaceRoot, 1024).trim();
  const isAllMode = !cleanWs || cleanWs === '__all__';
  const list = loadIndex();
  const filtered = isAllMode ? list : list.filter((c) => matchesWorkspaceCheckpoint(c, cleanWs));

  const grouped = new Map();
  for (const cp of filtered) {
    if (!cp || !cp.id) continue;
    const baseTurnKey = safeStr(cp.turnId, 128).trim() || `single_${cp.id}`;
    const effectiveWs = cp.filePath
      ? resolveEffectiveProjectRoot(cp.filePath, cp.workspaceRoot || '')
      : (cp.workspaceRoot ? resolve(cp.workspaceRoot) : '');
    const grpKey = (isAllMode && effectiveWs)
      ? `${baseTurnKey}::${normalizeRootForMatch(effectiveWs)}`
      : baseTurnKey;
    let grp = grouped.get(grpKey);
    if (!grp) {
      grp = {
        turnId: baseTurnKey,
        workspaceRoot: effectiveWs,
        projectName: effectiveWs ? basename(effectiveWs) : '',
        turnLabel: safeStr(cp.turnLabel, 120) || (cp.fileName ? `Правка ${cp.fileName}` : 'Правка файлов'),
        turnLabelEn: safeStr(cp.turnLabelEn || cp.turnLabel, 120) || (cp.fileName ? `Edit ${cp.fileName}` : 'File edits'),
        timestamp: cp.timestamp || new Date().toISOString(),
        conversationId: safeStr(cp.conversationId, 128),
        filesSet: new Set(),
        checkpointIds: [],
        restoredCount: 0,
      };
      grouped.set(grpKey, grp);
    }
    if (cp.fileName) grp.filesSet.add(cp.fileName);
    grp.checkpointIds.push(cp.id);
    if (cp.restored) grp.restoredCount += 1;
    if (!grp.turnLabel && cp.turnLabel) grp.turnLabel = safeStr(cp.turnLabel, 120);
  }

  const out = [];
  for (const grp of grouped.values()) {
    out.push({
      turnId: grp.turnId,
      workspaceRoot: grp.workspaceRoot,
      projectName: grp.projectName,
      turnLabel: grp.turnLabel,
      turnLabelEn: grp.turnLabelEn,
      timestamp: grp.timestamp,
      conversationId: grp.conversationId,
      filesCount: grp.filesSet.size,
      editsCount: grp.checkpointIds.length,
      files: Array.from(grp.filesSet),
      checkpointIds: grp.checkpointIds,
      allRestored: grp.checkpointIds.length > 0 && grp.restoredCount === grp.checkpointIds.length,
    });
    if (out.length >= safeLimit) break;
  }
  return out;
}

function resolveTurnKeyMatch(cp, turnId) {
  const cpKey = safeStr(cp?.turnId, 128).trim() || `single_${cp?.id || ''}`;
  return cpKey === turnId;
}

/**
 * Вычисляет сводку изменений (diff summary) всех файлов относительно состояния до начала хода.
 * @param {string} [turnId='latest']
 * @param {string} [workspaceRoot='']
 * @param {{ lang?: 'en'|'ru' }} [opts={}]
 * @returns {object}
 */
export function getTurnDiffSummary(turnId = 'latest', workspaceRoot = '', { lang = 'ru' } = {}) {
  const isEn = String(lang || '').trim().toLowerCase() === 'en';
  if (typeof turnId !== 'string' || (workspaceRoot !== undefined && typeof workspaceRoot !== 'string')) {
    return { ok: false, error: isEn ? 'Invalid turnId' : 'Некорректный turnId', files: [] };
  }
  const cleanTurnArg = safeStr(turnId, 128).trim();
  const rawWs = safeStr(workspaceRoot, 1024).trim();
  const cleanWs = rawWs === '__all__' ? '' : rawWs;
  if (!cleanTurnArg || BLOCKED_KEYS.has(cleanTurnArg)) {
    return { ok: false, error: isEn ? 'Invalid turnId' : 'Некорректный turnId', files: [] };
  }

  const list = loadIndex();
  const candidates = cleanWs ? list.filter((c) => matchesWorkspaceCheckpoint(c, cleanWs)) : list;
  if (candidates.length === 0) {
    return { ok: false, error: isEn ? 'No snapshots found' : 'Снимки не найдены', files: [] };
  }

  let resolvedTurnId = cleanTurnArg;
  if (resolvedTurnId === 'latest') {
    const firstActive = candidates.find((c) => !c.restored) || candidates[0];
    resolvedTurnId = safeStr(firstActive.turnId, 128).trim() || `single_${firstActive.id}`;
  }

  // Filter checkpoints in this turn (list is newest -> oldest)
  const turnCps = candidates.filter((c) => resolveTurnKeyMatch(c, resolvedTurnId));
  if (turnCps.length === 0) {
    return { ok: false, error: isEn ? `Turn not found: ${resolvedTurnId}` : `Ход не найден: ${resolvedTurnId}`, files: [] };
  }

  // Find earliest checkpoint per unique filePath to represent the true pre-turn baseline
  const baselineByFile = new Map();
  for (let i = turnCps.length - 1; i >= 0; i--) {
    const cp = turnCps[i];
    if (!cp?.filePath) continue;
    const fKey = normPathKey(cp.filePath);
    if (!baselineByFile.has(fKey)) {
      baselineByFile.set(fKey, cp);
    }
  }

  const files = [];
  let totalAdded = 0;
  let totalRemoved = 0;
  for (const cp of baselineByFile.values()) {
    let beforeText = '';
    if (cp.existed) {
      const bakPath = join(CHECKPOINTS_DIR, `${cp.id}.bak`);
      if (cp.backedUp && existsSync(bakPath)) {
        try { beforeText = readFileSync(bakPath, 'utf8'); } catch {}
      }
    }
    const existsNow = existsSync(cp.filePath);
    let afterText = '';
    if (existsNow) {
      try { afterText = readFileSync(cp.filePath, 'utf8'); } catch {}
    }

    let status = 'modified';
    if (!cp.existed && existsNow) status = 'created';
    else if (cp.existed && !existsNow) status = 'deleted';
    else if (cp.existed && existsNow && beforeText === afterText) status = 'unchanged';

    const stats = computeLineDiffStats(beforeText, afterText);
    totalAdded += stats.addedLines;
    totalRemoved += stats.removedLines;
    files.push({
      fileName: cp.fileName || basename(cp.filePath),
      filePath: cp.filePath,
      status,
      addedLines: stats.addedLines,
      removedLines: stats.removedLines,
    });
  }

  return {
    ok: true,
    turnId: resolvedTurnId,
    turnLabel: safeStr(turnCps[0]?.turnLabel, 120) || files[0]?.fileName || resolvedTurnId,
    timestamp: turnCps[0]?.timestamp || '',
    files,
    totalAdded,
    totalRemoved,
  };
}

/**
 * Откатывает ВСЕ файлы, изменённые или созданные за один ход (Turn-Level Time-Machine).
 * Для каждого файла используется самый ранний пред-ходовый снимок (если файла не существовало — он удаляется).
 * @param {string} [turnId='latest']
 * @param {string} [workspaceRoot='']
 * @returns {object}
 */
export function rollbackTurn(turnId = 'latest', workspaceRoot = '', { lang = 'ru' } = {}) {
  const isEn = String(lang || '').trim().toLowerCase() === 'en';
  const cleanTurnArg = safeStr(turnId, 128).trim();
  const rawWs = safeStr(workspaceRoot, 1024).trim();
  const cleanWs = rawWs === '__all__' ? '' : rawWs;
  if (!cleanTurnArg || BLOCKED_KEYS.has(cleanTurnArg)) {
    return { ok: false, error: isEn ? 'Invalid turnId' : 'Некорректный turnId' };
  }

  ensureStorage();
  const lockOutcome = withFileLockSync(INDEX_FILE, () => {
    const list = loadIndex();
    if (list.length === 0) {
      return { ok: false, error: isEn ? 'Checkpoints list is empty' : 'Список чекпоинтов пуст' };
    }
    const candidates = cleanWs ? list.filter((c) => matchesWorkspaceCheckpoint(c, cleanWs)) : list;
    if (candidates.length === 0) {
      return { ok: false, error: isEn ? 'No checkpoints found for current workspace' : 'Чекпоинты для текущего воркспейса не найдены' };
    }

    let resolvedTurnId = cleanTurnArg;
    if (resolvedTurnId === 'latest') {
      const targetCp = candidates.find((c) => !c.restored) || candidates[0];
      resolvedTurnId = safeStr(targetCp.turnId, 128).trim() || `single_${targetCp.id}`;
    }

    const turnCps = candidates.filter((c) => resolveTurnKeyMatch(c, resolvedTurnId));
    if (turnCps.length === 0) {
      return { ok: false, error: isEn ? `Turn not found: ${resolvedTurnId}` : `Ход не найден: ${resolvedTurnId}` };
    }

    // Group earliest checkpoint per unique filePath so repeated edits in one turn revert to pre-turn baseline
    const baselineByFile = new Map();
    for (let i = turnCps.length - 1; i >= 0; i--) {
      const cp = turnCps[i];
      if (!cp?.filePath || cp.restored) continue;
      const fKey = normPathKey(cp.filePath);
      if (!baselineByFile.has(fKey)) {
        baselineByFile.set(fKey, cp);
      }
    }

    if (baselineByFile.size === 0) {
      return { ok: false, error: isEn ? `Turn ${resolvedTurnId} has already been rolled back` : `Ход ${resolvedTurnId} уже был откачен` };
    }

    // Verify all backups exist before mutating disk (atomic safety)
    for (const cp of baselineByFile.values()) {
      const hasBackup = cp.backedUp !== undefined ? Boolean(cp.backedUp) : Boolean(cp.existed);
      if (cp.existed) {
        if (!hasBackup) {
          return {
            ok: false,
            error: isEn
              ? `File ${cp.fileName} exceeded shadow backup limit (>2 MB); turn rollback cancelled`
              : `Файл ${cp.fileName} превышал лимит теневой копии (>2 МБ); откат хода отменён`,
          };
        }
        const bakPath = join(CHECKPOINTS_DIR, `${cp.id}.bak`);
        if (!existsSync(bakPath)) {
          return { ok: false, error: isEn ? `Snapshot file ${cp.id}.bak is missing` : `Файл снимка ${cp.id}.bak отсутствует` };
        }
      }
    }

    const restoredFiles = [];
    const deletedFiles = [];
    const primaryCp = turnCps[0];
    try {
      for (const cp of baselineByFile.values()) {
        if (cp.existed) {
          const bakPath = join(CHECKPOINTS_DIR, `${cp.id}.bak`);
          mkdirSync(dirname(cp.filePath), { recursive: true });
          copyFileSync(bakPath, cp.filePath);
          restoredFiles.push(cp.filePath);
        } else {
          if (existsSync(cp.filePath)) {
            unlinkSync(cp.filePath);
          }
          deletedFiles.push(cp.filePath);
        }
      }

      const restoredAt = new Date().toISOString();
      const targetIds = new Set(turnCps.map((c) => c.id));
      const updated = list.map((c) => (
        targetIds.has(c.id) ? { ...c, restored: true, restoredAt } : c
      ));
      atomicWriteJsonSync(INDEX_FILE, updated);

      return {
        ok: true,
        turnId: resolvedTurnId,
        turnLabel: safeStr(primaryCp?.turnLabel, 120) || resolvedTurnId,
        restoredFiles,
        deletedFiles,
        count: restoredFiles.length + deletedFiles.length,
        primaryCheckpoint: primaryCp,
      };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  });

  if (!lockOutcome.ok) {
    return lockOutcome;
  }

  for (const fp of [...lockOutcome.restoredFiles, ...lockOutcome.deletedFiles]) {
    try { invalidateReadCacheForFile(fp); } catch {}
  }

  const cp0 = lockOutcome.primaryCheckpoint;
  if (cp0) {
    const effectiveWs = resolveEffectiveProjectRoot(cp0.filePath, cp0.workspaceRoot || '');
    try {
      recordPitfall({
        type: 'rollback',
        fileName: basename(cp0.filePath || 'turn'),
        workspaceRoot: effectiveWs,
        summary: `Turn rollback (${lockOutcome.turnLabel}, ${lockOutcome.count} files): verify edge-cases before retrying.`,
      });
    } catch {}
    try {
      recordModelOutcome({
        domain: inferDomainForFile(cp0.filePath),
        filePath: cp0.filePath,
        workspaceRoot: effectiveWs,
        success: false,
        signalType: 'rollback',
      });
    } catch {}
  }

  return {
    ok: true,
    turnId: lockOutcome.turnId,
    turnLabel: lockOutcome.turnLabel,
    restoredFiles: lockOutcome.restoredFiles,
    deletedFiles: lockOutcome.deletedFiles,
    count: lockOutcome.count,
  };
}

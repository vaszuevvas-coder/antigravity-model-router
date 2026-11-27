/**
 * @file safe-json.mjs
 * @description Модуль атомарного чтения, записи и синхронизации JSON-файлов для защиты от гонок
 * параллельных процессов (субагентов Teamwork) и повреждения состояния при сбоях.
 */

import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const activeProcessLocks = new Map();

const NON_RETRYABLE_READ_CODES = new Set([
  'ENOENT',
  'EISDIR',
  'ENOTDIR',
  'EINVAL',
  'ENAMETOOLONG',
  'ELOOP',
]);

const TRANSIENT_FS_CODES = new Set([
  'EBUSY',
  'EPERM',
  'EACCES',
  'EMFILE',
  'ENFILE',
  'ENOTEMPTY',
]);

const TMP_ARTIFACT_SUFFIX_RE = /^\d+\.[a-z0-9]{4,16}\.tmp$/;

function stripUtf8Bom(raw) {
  if (typeof raw !== 'string') return '';
  return raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
}

function removePathWithRetry(targetPath, { recursive = false } = {}) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      if (recursive) {
        rmSync(targetPath, { recursive: true, force: true });
      } else {
        unlinkSync(targetPath);
      }
      return true;
    } catch (err) {
      if (err?.code === 'ENOENT') return true;
      if (attempt < 3 && TRANSIENT_FS_CODES.has(err?.code)) {
        sleepSync(5 * attempt);
        continue;
      }
      return false;
    }
  }
  return false;
}

function sweepOrphanArtifacts(targetPath, minAgeMs = 30000) {
  try {
    const dir = dirname(targetPath);
    const base = basename(targetPath);
    const stalePrefix = `${base}.lock.stale.`;
    const staleFbPrefix = `${base}.lock.fb.stale.`;
    const tmpPrefix = `${base}.`;
    const cutoff = Date.now() - Math.max(30000, Number(minAgeMs) || 30000);
    const entries = readdirSync(dir);
    for (const name of entries) {
      const isStaleLock = name.startsWith(stalePrefix) || name.startsWith(staleFbPrefix);
      const isTmpFile =
        !isStaleLock &&
        name.startsWith(tmpPrefix) &&
        TMP_ARTIFACT_SUFFIX_RE.test(name.slice(tmpPrefix.length));
      if (!isStaleLock && !isTmpFile) continue;
      const fullPath = join(dir, name);
      try {
        const st = statSync(fullPath);
        if (st.mtimeMs < cutoff) {
          removePathWithRetry(fullPath, { recursive: isStaleLock });
        }
      } catch {}
    }
  } catch {}
}

function normalizeLockKey(lockDir) {
  const abs = resolve(String(lockDir || ''));
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

const SLEEP_BUF = (() => {
  try {
    return new Int32Array(new SharedArrayBuffer(4));
  } catch {
    return null;
  }
})();

/**
 * Тихая синхронная пауза без нагрузки на CPU.
 * @param {number} ms Количество миллисекунд
 */
export function sleepSync(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return;
  if (SLEEP_BUF) {
    try {
      Atomics.wait(SLEEP_BUF, 0, 0, ms);
      return;
    } catch {}
  }
  const start = Date.now();
  while (Date.now() - start < ms) {}
}

/**
 * Выполняет функцию fn внутри межпроцессного файлового замка на базе атомарного создания каталога.
 * @template T
 * @param {string} targetPath Путь к защищаемому файлу
 * @param {() => T} fn Выполняемая функция
 * @param {object} [options]
 * @param {number} [options.maxWaitMs=5000] Максимальное время ожидания захвата замка
 * @param {number} [options.staleLockMs=6000] Время устаревания зависшего замка
 * @param {boolean} [options.createDir=true] Создавать ли родительский каталог, если он отсутствует
 * @returns {T}
 */
export function withFileLockSync(targetPath, fn, options = {}) {
  if (typeof targetPath !== 'string' || !targetPath.trim() || targetPath.includes('\0')) {
    throw new TypeError('Invalid targetPath');
  }
  const opts = options && typeof options === 'object' ? options : {};
  const maxWaitMs = Number.isFinite(Number(opts.maxWaitMs)) && Number(opts.maxWaitMs) > 0
    ? Number(opts.maxWaitMs)
    : 5000;
  const staleLockMs = Number.isFinite(Number(opts.staleLockMs)) && Number(opts.staleLockMs) > 0
    ? Number(opts.staleLockMs)
    : 6000;
  const createDir = opts.createDir !== false;

  const dir = dirname(targetPath);
  if (createDir) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch {}
  }

  const primaryLockDir = `${targetPath}.lock`;
  const primaryLockKey = normalizeLockKey(primaryLockDir);
  const prevDepth = activeProcessLocks.get(primaryLockKey) || 0;
  if (prevDepth > 0) {
    // Re-entrant call in the same process: reuse active lock instead of self-deadlocking
    activeProcessLocks.set(primaryLockKey, prevDepth + 1);
    try {
      const res = fn();
      if (res !== null && (typeof res === 'object' || typeof res === 'function') && typeof res.then === 'function') {
        throw new TypeError('withFileLockSync requires a synchronous callback');
      }
      return res;
    } finally {
      const rem = (activeProcessLocks.get(primaryLockKey) || 1) - 1;
      if (rem > 0) activeProcessLocks.set(primaryLockKey, rem);
      else activeProcessLocks.delete(primaryLockKey);
    }
  }

  let activeLockDir = primaryLockDir;
  let activeOwnerFile = join(activeLockDir, 'owner');
  let usingFallback = false;
  let zombieProbeCount = 0;
  let firstZombieProbeAt = 0;
  let staleEvictFailCount = 0;
  const ownerToken = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  const startTime = Date.now();
  let acquired = false;

  while (Date.now() - startTime < maxWaitMs) {
    try {
      mkdirSync(activeLockDir);
      try {
        writeFileSync(activeOwnerFile, ownerToken, 'utf-8');
        acquired = true;
        break;
      } catch (writeErr) {
        removePathWithRetry(activeLockDir, { recursive: true });
        throw writeErr;
      }
    } catch (err) {
      if (err && (err.code === 'EEXIST' || err.code === 'EACCES' || err.code === 'EPERM' || err.code === 'EBUSY')) {
        if (err.code === 'EPERM' || err.code === 'EACCES') {
          if (!firstZombieProbeAt) firstZombieProbeAt = Date.now();
          zombieProbeCount++;
        }
        try {
          const st = statSync(activeLockDir);
          if (!st.isDirectory()) {
            const corruptPath = `${activeLockDir}.stale.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}`;
            try {
              renameSync(activeLockDir, corruptPath);
              removePathWithRetry(corruptPath, { recursive: false });
            } catch {
              removePathWithRetry(activeLockDir, { recursive: false });
            }
            continue;
          }
          let effectiveStaleMs = staleLockMs;
          try {
            const ownerRaw = readFileSync(activeOwnerFile, 'utf-8');
            const parts = String(ownerRaw || '').split(':');
            const ownerPid = Number(parts[0]);
            const ownerTs = Number(parts[1]) || st.mtimeMs;
            if (Number.isInteger(ownerPid) && ownerPid > 0) {
              try {
                process.kill(ownerPid, 0);
                effectiveStaleMs = Math.max(staleLockMs, 60000);
              } catch (killErr) {
                if (killErr?.code === 'ESRCH') {
                  effectiveStaleMs = Math.min(staleLockMs, 50);
                } else if (killErr?.code === 'EPERM') {
                  if (Date.now() - ownerTs < 15000) {
                    effectiveStaleMs = Math.max(staleLockMs, 60000);
                  }
                }
              }
            }
          } catch (ownerErr) {
            if (ownerErr?.code === 'ENOENT') {
              effectiveStaleMs = Math.min(staleLockMs, 350);
            } else if (ownerErr?.code === 'EPERM' || ownerErr?.code === 'EACCES') {
              if (!firstZombieProbeAt) firstZombieProbeAt = Date.now();
              zombieProbeCount++;
            }
          }
          if (Date.now() - st.mtimeMs > effectiveStaleMs) {
            // Atomically claim stale lock before removal to prevent TOCTOU double-eviction
            const stalePath = `${activeLockDir}.stale.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}`;
            try {
              renameSync(activeLockDir, stalePath);
              removePathWithRetry(stalePath, { recursive: true });
              sweepOrphanArtifacts(targetPath, Math.max(staleLockMs, 30000));
              continue;
            } catch (evictErr) {
              if (evictErr && (evictErr.code === 'EPERM' || evictErr.code === 'EACCES' || evictErr.code === 'EBUSY')) {
                if (!firstZombieProbeAt) firstZombieProbeAt = Date.now();
                staleEvictFailCount++;
              }
            }
          }
        } catch {}
        if (!usingFallback && firstZombieProbeAt > 0 && Date.now() - firstZombieProbeAt >= 60) {
          let isDirUnreadableEperm = false;
          if (zombieProbeCount >= 4) {
            try {
              readdirSync(activeLockDir);
            } catch (rdErr) {
              isDirUnreadableEperm = rdErr?.code === 'EPERM' || rdErr?.code === 'EACCES';
            }
          }
          if ((zombieProbeCount >= 4 && isDirUnreadableEperm) || staleEvictFailCount >= 4) {
            usingFallback = true;
            activeLockDir = `${targetPath}.lock.fb`;
            activeOwnerFile = join(activeLockDir, 'owner');
            zombieProbeCount = 0;
            firstZombieProbeAt = 0;
            staleEvictFailCount = 0;
            continue;
          }
        }
        sleepSync(3 + Math.floor(Math.random() * 6));
      } else if (err && (err.code === 'ENOENT' || err.code === 'ENOTEMPTY')) {
        if (err.code === 'ENOENT' && !createDir) {
          throw err;
        }
        if (createDir) {
          try {
            mkdirSync(dir, { recursive: true });
          } catch {}
        }
        sleepSync(4);
      } else {
        throw err;
      }
    }
  }

  if (!acquired) {
    throw new Error(`Lock acquisition timeout (${maxWaitMs}ms) for ${targetPath}`);
  }

  activeProcessLocks.set(primaryLockKey, 1);
  try {
    const res = fn();
    if (res !== null && (typeof res === 'object' || typeof res === 'function') && typeof res.then === 'function') {
      throw new TypeError('withFileLockSync requires a synchronous callback');
    }
    return res;
  } finally {
    activeProcessLocks.delete(primaryLockKey);
    // Only release activeLockDir if this process still owns it (prevents deleting a stolen lock)
    let stillOwned = false;
    try {
      stillOwned = readFileSync(activeOwnerFile, 'utf-8') === ownerToken;
    } catch {
      stillOwned = false;
    }
    if (stillOwned) {
      const releasedPath = `${activeLockDir}.stale.${process.pid}.${Date.now()}.${randomBytes(2).toString('hex')}`;
      let releasedViaRename = false;
      try {
        renameSync(activeLockDir, releasedPath);
        releasedViaRename = true;
        removePathWithRetry(releasedPath, { recursive: true });
      } catch {
        releasedViaRename = false;
      }
      if (!releasedViaRename && !removePathWithRetry(activeLockDir, { recursive: true })) {
        try {
          unlinkSync(activeOwnerFile);
          rmdirSync(activeLockDir);
        } catch {}
      }
    }
  }
}

/**
 * Разрешает значение по умолчанию (вызывает фабрику или клонирует объект).
 * @param {any} factory
 * @returns {any}
 */
function resolveDefault(factory) {
  if (typeof factory === 'function') {
    return factory();
  }
  if (factory && typeof factory === 'object') {
    try {
      return structuredClone(factory);
    } catch {
      try {
        return JSON.parse(JSON.stringify(factory));
      } catch {
        return Array.isArray(factory) ? [...factory] : { ...factory };
      }
    }
  }
  return factory;
}

/**
 * Safeguards callers expecting a non-null object/array default against files containing literal JSON `null`.
 * @param {any} parsed
 * @param {any} defaultFactory
 * @returns {any}
 */
function coerceParsedWithDefault(parsed, defaultFactory) {
  if (parsed !== null) {
    return parsed;
  }
  if (defaultFactory === null || defaultFactory === undefined) {
    return parsed;
  }
  const def = resolveDefault(defaultFactory);
  if (def !== null && typeof def === 'object') {
    return def;
  }
  return parsed;
}

/**
 * Безопасно читает JSON-файл. При отсутствии или повреждении файла возвращает дефолт
 * и опционально тихо самоисцеляет повреждённый файл без спама в console.error.
 * @template T
 * @param {string} filePath Путь к файлу
 * @param {T | (() => T)} defaultFactory Фабрика или объект по умолчанию
 * @param {object} [options]
 * @param {boolean} [options.selfHeal=true] Перезаписать ли битый/пустой файл значением по умолчанию
 * @param {number} [options.lockWaitMs=750] Максимальное время ожидания замка при самоисцелении
 * @param {boolean} [options.backupCorrupt=false] Сохранить ли резервную копию `.corrupt` перед перезаписью битого JSON
 * @returns {T}
 */
export function safeReadJsonSync(filePath, defaultFactory, options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const selfHeal = opts.selfHeal !== undefined ? Boolean(opts.selfHeal) : true;
  const backupCorrupt = Boolean(opts.backupCorrupt);
  const lockWaitMs = Number.isFinite(Number(opts.lockWaitMs)) && Number(opts.lockWaitMs) > 0
    ? Math.min(5000, Math.round(Number(opts.lockWaitMs)))
    : 750;

  if (typeof filePath !== 'string' || !filePath.trim() || filePath.includes('\0')) {
    return resolveDefault(defaultFactory);
  }

  if (!existsSync(filePath)) {
    return resolveDefault(defaultFactory);
  }

  const maxAttempts = 5;
  let readOk = false;
  let ioError = false;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const raw = readFileSync(filePath, 'utf-8');
      readOk = true;
      ioError = false;
      const cleaned = stripUtf8Bom(raw);
      if (cleaned.trim()) {
        try {
          const parsed = JSON.parse(cleaned);
          return coerceParsedWithDefault(parsed, defaultFactory);
        } catch {
          // Possible torn write from a concurrent non-locked writer — retry before healing
        }
      }
    } catch (err) {
      if (err && NON_RETRYABLE_READ_CODES.has(err.code)) {
        return resolveDefault(defaultFactory);
      }
      // Transient EPERM/EBUSY/EACCES during atomic rename or AV scan on Windows
      ioError = true;
    }
    if (attempt < maxAttempts) {
      sleepSync(4 * attempt);
    }
  }

  // Never self-heal onto disk if read failed due to transient OS lock (EBUSY/EPERM/EACCES)
  if (!readOk || ioError || !selfHeal) {
    return resolveDefault(defaultFactory);
  }

  // Never recreate a file that was concurrently deleted before acquiring the lock
  if (!existsSync(filePath)) {
    return resolveDefault(defaultFactory);
  }

  try {
    return withFileLockSync(
      filePath,
      () => {
        if (!existsSync(filePath)) {
          return resolveDefault(defaultFactory);
        }

        let latestRaw = '';
        let latestReadOk = false;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            latestRaw = readFileSync(filePath, 'utf-8');
            latestReadOk = true;
            break;
          } catch (err) {
            if (err && NON_RETRYABLE_READ_CODES.has(err.code)) {
              return resolveDefault(defaultFactory);
            }
            if (attempt < 3) {
              sleepSync(4 * attempt);
            }
          }
        }

        // Never overwrite disk if re-read under lock failed with an OS I/O error
        if (!latestReadOk) {
          return resolveDefault(defaultFactory);
        }

        const latestCleaned = stripUtf8Bom(latestRaw);
        if (latestCleaned.trim()) {
          try {
            const parsed = JSON.parse(latestCleaned);
            return coerceParsedWithDefault(parsed, defaultFactory);
          } catch {
            // Confirmed corrupted JSON under lock — proceed to self-heal
          }
          if (backupCorrupt) {
            try {
              writeFileSync(`${filePath}.corrupt`, latestRaw, 'utf-8');
            } catch {}
          }
        }

        const def = resolveDefault(defaultFactory);
        atomicWriteJsonSync(filePath, def);
        return def;
      },
      { maxWaitMs: lockWaitMs, createDir: false }
    );
  } catch {
    return resolveDefault(defaultFactory);
  }
}

/**
 * Атомарно записывает JSON в файл через временный файл и renameSync с повторами на Windows.
 * @param {string} filePath Путь к целевому файлу
 * @param {any} data Данные для сериализации
 * @param {{ spaces?: number }} [options={}] Параметры форматирования
 */
export function atomicWriteJsonSync(filePath, data, options = {}) {
  if (typeof filePath !== 'string' || !filePath.trim() || filePath.includes('\0')) {
    throw new TypeError('Invalid filePath');
  }
  const opts = options && typeof options === 'object' ? options : {};
  const spaces = opts.spaces !== undefined ? opts.spaces : 2;
  const dir = dirname(filePath);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {}

  const payload = data === undefined ? null : data;
  let jsonStr = typeof payload === 'string' ? payload : JSON.stringify(payload, null, spaces);
  if (jsonStr === undefined) {
    jsonStr = 'null';
  }
  const tmpPath = `${filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;

  let renamed = false;
  try {
    writeFileSync(tmpPath, jsonStr, 'utf-8');

    const maxAttempts = 16;
    let lastRenameErr = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        renameSync(tmpPath, filePath);
        renamed = true;
        break;
      } catch (err) {
        lastRenameErr = err;
        if (attempt < maxAttempts) {
          sleepSync(Math.min(60, 6 * attempt));
        }
      }
    }

    if (!renamed) {
      throw lastRenameErr || new Error(`Atomic rename failed for ${filePath}`);
    }
  } finally {
    if (!renamed && existsSync(tmpPath)) {
      const cleaned = removePathWithRetry(tmpPath, { recursive: false });
      if (!cleaned) {
        sweepOrphanArtifacts(filePath, 30000);
      }
    }
  }
}

/**
 * Атомарно читает, мутирует и сохраняет JSON-файл под файловым замком.
 * Гарантирует целостность при параллельной записи из нескольких процессов.
 * @template T
 * @param {string} filePath Путь к файлу
 * @param {T | (() => T)} defaultFactory Фабрика по умолчанию
 * @param {(current: T) => T} mutatorFn Функция изменения состояния
 * @param {{ spaces?: number, maxWaitMs?: number, staleLockMs?: number, createDir?: boolean }} [options={}] Параметры записи JSON и замка
 * @returns {T} Обновлённое состояние
 */
export function updateJsonAtomicSync(filePath, defaultFactory, mutatorFn, options = {}) {
  return withFileLockSync(
    filePath,
    () => {
      const current = safeReadJsonSync(filePath, defaultFactory, { selfHeal: true });
      const rawNext = mutatorFn(current);
      if (rawNext !== null && (typeof rawNext === 'object' || typeof rawNext === 'function') && typeof rawNext.then === 'function') {
        throw new TypeError('updateJsonAtomicSync requires a synchronous mutatorFn');
      }
      const updated = rawNext !== undefined ? rawNext : current;
      atomicWriteJsonSync(filePath, updated, options);
      return updated;
    },
    { maxWaitMs: options?.maxWaitMs, staleLockMs: options?.staleLockMs, createDir: options?.createDir }
  );
}

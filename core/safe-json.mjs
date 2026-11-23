/**
 * @file safe-json.mjs
 * @description Модуль атомарного чтения, записи и синхронизации JSON-файлов для защиты от гонок
 * параллельных процессов (субагентов Teamwork) и повреждения состояния при сбоях.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

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
  if (!ms || ms <= 0) return;
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
 * @returns {T}
 */
export function withFileLockSync(targetPath, fn, { maxWaitMs = 5000, staleLockMs = 6000 } = {}) {
  const dir = dirname(targetPath);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {}

  const lockDir = `${targetPath}.lock`;
  const ownerFile = join(lockDir, 'owner');
  const ownerToken = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  const startTime = Date.now();
  let acquired = false;

  while (Date.now() - startTime < maxWaitMs) {
    try {
      mkdirSync(lockDir);
      try {
        writeFileSync(ownerFile, ownerToken, 'utf-8');
        acquired = true;
        break;
      } catch (writeErr) {
        try {
          rmSync(lockDir, { recursive: true, force: true });
        } catch {}
        throw writeErr;
      }
    } catch (err) {
      if (err && (err.code === 'EEXIST' || err.code === 'EACCES' || err.code === 'EPERM' || err.code === 'EBUSY')) {
        try {
          const st = statSync(lockDir);
          let effectiveStaleMs = staleLockMs;
          try {
            const ownerRaw = readFileSync(ownerFile, 'utf-8');
            const ownerPid = Number(String(ownerRaw || '').split(':')[0]);
            if (Number.isInteger(ownerPid) && ownerPid > 0) {
              let alive = false;
              try {
                process.kill(ownerPid, 0);
                alive = true;
              } catch (killErr) {
                alive = killErr?.code === 'EPERM';
              }
              if (alive) {
                effectiveStaleMs = Math.max(staleLockMs, 60000);
              }
            }
          } catch {}
          if (Date.now() - st.mtimeMs > effectiveStaleMs) {
            // Atomically claim stale lock before removal to prevent TOCTOU double-eviction
            const stalePath = `${lockDir}.stale.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}`;
            try {
              renameSync(lockDir, stalePath);
              rmSync(stalePath, { recursive: true, force: true });
              continue;
            } catch {}
          }
        } catch {}
        sleepSync(3 + Math.floor(Math.random() * 6));
      } else if (err && (err.code === 'ENOENT' || err.code === 'ENOTEMPTY')) {
        try {
          mkdirSync(dir, { recursive: true });
        } catch {}
        sleepSync(4);
      } else {
        throw err;
      }
    }
  }

  if (!acquired) {
    throw new Error(`Lock acquisition timeout (${maxWaitMs}ms) for ${targetPath}`);
  }

  try {
    return fn();
  } finally {
    // Only release lockDir if this process still owns it (prevents deleting a stolen lock)
    let stillOwned = false;
    try {
      stillOwned = readFileSync(ownerFile, 'utf-8') === ownerToken;
    } catch {
      stillOwned = false;
    }
    if (stillOwned) {
      try {
        rmSync(lockDir, { recursive: true, force: true });
      } catch {
        try {
          unlinkSync(ownerFile);
          rmdirSync(lockDir);
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
      return JSON.parse(JSON.stringify(factory));
    }
  }
  return factory;
}

/**
 * Безопасно читает JSON-файл. При отсутствии или повреждении файла возвращает дефолт
 * и опционально тихо самоисцеляет повреждённый файл без спама в console.error.
 * @template T
 * @param {string} filePath Путь к файлу
 * @param {T | (() => T)} defaultFactory Фабрика или объект по умолчанию
 * @param {object} [options]
 * @param {boolean} [options.selfHeal=true] Перезаписать ли битый/пустой файл значением по умолчанию
 * @returns {T}
 */
export function safeReadJsonSync(filePath, defaultFactory, { selfHeal = true } = {}) {
  if (!existsSync(filePath)) {
    return resolveDefault(defaultFactory);
  }

  let content = '';
  let readOk = false;
  let ioError = false;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      content = readFileSync(filePath, 'utf-8');
      readOk = true;
      ioError = false;
      if (content && content.trim()) {
        break;
      }
    } catch {
      // Transient EPERM/EBUSY during atomic rename on Windows
      ioError = true;
    }
    sleepSync(4 * attempt);
  }
  if (!readOk && !existsSync(filePath)) {
    return resolveDefault(defaultFactory);
  }

  // Never self-heal onto disk if read failed due to transient OS lock (EBUSY/EPERM)
  if (ioError && (!content || !content.trim())) {
    return resolveDefault(defaultFactory);
  }

  const verifyAndSelfHealUnderLock = () => {
    const def = resolveDefault(defaultFactory);
    if (!selfHeal || !readOk || ioError) return def;
    try {
      return withFileLockSync(filePath, () => {
        if (existsSync(filePath)) {
          try {
            const latest = readFileSync(filePath, 'utf-8');
            if (latest && latest.trim()) {
              return JSON.parse(latest);
            }
          } catch {}
        }
        atomicWriteJsonSync(filePath, def);
        return def;
      });
    } catch {
      return def;
    }
  };

  if (!content || !content.trim()) {
    return verifyAndSelfHealUnderLock();
  }

  try {
    return JSON.parse(content);
  } catch {
    // Тихое самоисцеление повреждённого JSON строго под файловым замком
    return verifyAndSelfHealUnderLock();
  }
}

/**
 * Атомарно записывает JSON в файл через временный файл и renameSync с повторами на Windows.
 * @param {string} filePath Путь к целевому файлу
 * @param {any} data Данные для сериализации
 */
export function atomicWriteJsonSync(filePath, data, { spaces = 2 } = {}) {
  const dir = dirname(filePath);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {}

  const payload = data === undefined ? null : data;
  let jsonStr = typeof payload === 'string' ? payload : JSON.stringify(payload, null, spaces);
  if (jsonStr === undefined) {
    jsonStr = 'null';
  }
  const tmpPath = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2, 7)}.tmp`;

  let renamed = false;
  try {
    writeFileSync(tmpPath, jsonStr, 'utf-8');

    const maxAttempts = 12;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        renameSync(tmpPath, filePath);
        renamed = true;
        break;
      } catch {
        if (attempt < maxAttempts) {
          sleepSync(Math.min(50, 6 * attempt));
        }
      }
    }

    if (!renamed) {
      writeFileSync(filePath, jsonStr, 'utf-8');
    }
  } finally {
    try {
      if (existsSync(tmpPath)) {
        unlinkSync(tmpPath);
      }
    } catch {}
  }
}

/**
 * Атомарно читает, мутирует и сохраняет JSON-файл под файловым замком.
 * Гарантирует целостность при параллельной записи из нескольких процессов.
 * @template T
 * @param {string} filePath Путь к файлу
 * @param {T | (() => T)} defaultFactory Фабрика по умолчанию
 * @param {(current: T) => T} mutatorFn Функция изменения состояния
 * @param {{ spaces?: number }} [options={}] Параметры записи JSON
 * @returns {T} Обновлённое состояние
 */
export function updateJsonAtomicSync(filePath, defaultFactory, mutatorFn, options = {}) {
  return withFileLockSync(filePath, () => {
    const current = safeReadJsonSync(filePath, defaultFactory, { selfHeal: true });
    const updated = mutatorFn(current) || current;
    atomicWriteJsonSync(filePath, updated, options);
    return updated;
  });
}

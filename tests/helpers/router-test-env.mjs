import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function isPidAliveSafe(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

process.env.TUNNEL_TEST_ISOLATE_INSTALLED ??= '1';

let ownedSuiteCacheDir = '';
if (!process.env.TUNNEL_CACHE_DIR) {
  // Best-effort sweep of prior exited suite caches whose v8-compile-cache was locked until exit on Windows
  try {
    const cutoff = Date.now() - 1_800_000;
    for (const name of fs.readdirSync(os.tmpdir())) {
      if (!name.startsWith('amr-suite-cache-')) continue;
      const pidMatch = /^amr-suite-cache-(\d+)-/.exec(name);
      if (pidMatch && isPidAliveSafe(Number(pidMatch[1]))) continue;
      const full = path.join(os.tmpdir(), name);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { recursive: true, force: true });
      } catch {}
    }
  } catch {}
  ownedSuiteCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), `amr-suite-cache-${process.pid}-`));
  process.env.TUNNEL_CACHE_DIR = ownedSuiteCacheDir;
}

export const SUITE_CACHE_DIR = process.env.TUNNEL_CACHE_DIR;

export function makeTempDir(prefix = 'amr-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function registerSuiteLifecycle(testRunner, { cleanupFns = [] } = {}) {
  testRunner.after(async () => {
    for (const fn of cleanupFns) {
      if (typeof fn !== 'function') continue;
      try {
        await fn();
      } catch {}
    }
    try {
      const { knowledgeHub } = await import('../../core/sqlite-knowledge-hub.mjs');
      knowledgeHub?.close?.();
    } catch {}
    if (ownedSuiteCacheDir) {
      try {
        fs.rmSync(ownedSuiteCacheDir, { recursive: true, force: true });
      } catch {}
    }
  });
}

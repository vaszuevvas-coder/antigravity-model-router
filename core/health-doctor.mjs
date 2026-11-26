/**
 * @file health-doctor.mjs
 * @description Runtime Health-Doctor diagnostics and 1-click safe auto-remediation
 *   for Ollama reachability, RAM daemon warm state, stale .lock files, orphaned
 *   shadow git worktrees, and GPU VRAM model mismatches.
 */

import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTunnelCacheDir } from './cache-dir.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, '..');

export const STALE_LOCK_AGE_MS = 5 * 60 * 1000;
export const ORPHAN_WORKTREE_AGE_MS = 24 * 60 * 60 * 1000;
export const ALLOWED_FIX_ACTIONS = new Set([
  'clean_stale_locks',
  'prune_orphan_worktrees',
  'start_ollama',
  'apply_vram_fallback',
  'warm_ram_cache',
  'fix_all',
]);

function findStaleFilesBySuffix(cacheDir, suffix, nowMs = Date.now()) {
  if (!cacheDir || !existsSync(cacheDir)) return [];
  const stale = [];
  try {
    const entries = readdirSync(cacheDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(suffix)) continue;
      const fullPath = join(cacheDir, entry.name);
      try {
        const st = statSync(fullPath);
        const ageMs = Math.max(0, nowMs - Number(st.mtimeMs || 0));
        if (ageMs >= STALE_LOCK_AGE_MS) {
          stale.push({ name: entry.name, path: fullPath, ageMs });
        }
      } catch {}
    }
  } catch {}
  return stale;
}

function findStaleLockFiles(cacheDir, nowMs = Date.now()) {
  return findStaleFilesBySuffix(cacheDir, '.lock', nowMs);
}

function findStaleTmpFiles(cacheDir, nowMs = Date.now()) {
  return findStaleFilesBySuffix(cacheDir, '.tmp', nowMs);
}

function findOrphanWorktrees(worktrees = [], nowMs = Date.now()) {
  if (!Array.isArray(worktrees)) return [];
  const orphans = [];
  for (const wt of worktrees) {
    if (!wt || typeof wt !== 'object') continue;
    const wtPath = typeof wt.path === 'string' ? wt.path : '';
    const existsFlag = wt.exists !== undefined ? Boolean(wt.exists) : (wtPath ? existsSync(wtPath) : false);
    const ts = Number(wt.createdAt || wt.updatedAt || 0);
    const ageMs = Number.isFinite(Number(wt.ageMs))
      ? Number(wt.ageMs)
      : (ts > 0 ? Math.max(0, nowMs - ts) : 0);
    if (!existsFlag || ageMs > ORPHAN_WORKTREE_AGE_MS) {
      orphans.push({
        id: String(wt.id || wt.name || wtPath || 'unknown'),
        path: wtPath,
        reason: !existsFlag ? 'missing_dir' : 'expired',
        ageMs,
      });
    }
  }
  return orphans;
}

/**
 * Evaluates runtime health across locks, worktrees, Ollama, VRAM fit, and RAM daemon.
 * @param {object} [opts={}]
 */
export function diagnoseRuntimeHealth(opts = {}) {
  const safeOpts = opts && typeof opts === 'object' ? opts : {};
  const nowMs = Number.isFinite(Number(safeOpts.nowMs)) ? Number(safeOpts.nowMs) : Date.now();
  const state = safeOpts.state && typeof safeOpts.state === 'object' ? safeOpts.state : {};
  const cacheDir = typeof safeOpts.cacheDir === 'string' && safeOpts.cacheDir.trim()
    ? resolve(safeOpts.cacheDir.trim())
    : resolveTunnelCacheDir(PLUGIN_ROOT);
  const gpuStatus = safeOpts.gpuStatus && typeof safeOpts.gpuStatus === 'object' ? safeOpts.gpuStatus : null;
  const ramStatus = safeOpts.ramStatus && typeof safeOpts.ramStatus === 'object' ? safeOpts.ramStatus : null;
  const worktrees = Array.isArray(safeOpts.worktrees) ? safeOpts.worktrees : [];

  const staleLocks = findStaleLockFiles(cacheDir, nowMs);
  const staleTmps = findStaleTmpFiles(cacheDir, nowMs);
  const orphanWorktrees = findOrphanWorktrees(worktrees, nowMs);
  const issues = [];

  if (staleLocks.length > 0 || staleTmps.length > 0) {
    const totalStale = staleLocks.length + staleTmps.length;
    const sampleNames = [...staleLocks, ...staleTmps].slice(0, 3).map((l) => l.name).join(', ');
    issues.push({
      id: 'stale_locks',
      severity: 'warn',
      fixAction: 'clean_stale_locks',
      canAutoFix: true,
      titleRu: staleLocks.length > 0
        ? `Зависшие lock/tmp-файлы (${totalStale})`
        : `Осиротевшие .tmp-файлы (${staleTmps.length})`,
      titleEn: staleLocks.length > 0
        ? `Stale .lock/.tmp files (${totalStale})`
        : `Orphaned .tmp files (${staleTmps.length})`,
      detailRu: `Найдены временные/lock файлы старше 5 мин: ${sampleNames}`,
      detailEn: `Found stale lock/tmp files older than 5 min: ${sampleNames}`,
      meta: { count: totalStale, lockCount: staleLocks.length, tmpCount: staleTmps.length },
    });
  }

  if (orphanWorktrees.length > 0) {
    issues.push({
      id: 'orphan_worktrees',
      severity: 'warn',
      fixAction: 'prune_orphan_worktrees',
      canAutoFix: true,
      titleRu: `Сиротские git-песочницы (${orphanWorktrees.length})`,
      titleEn: `Orphaned git worktrees (${orphanWorktrees.length})`,
      detailRu: `Песочницы старше 24ч или без каталога: ${orphanWorktrees.slice(0, 3).map((w) => w.id).join(', ')}`,
      detailEn: `Worktrees older than 24h or missing folder: ${orphanWorktrees.slice(0, 3).map((w) => w.id).join(', ')}`,
      meta: { count: orphanWorktrees.length },
    });
  }

  const gpuEnabled = state?.gpuEnabled === true;
  const ollamaInstalled = Boolean(gpuStatus?.ollama?.installed);
  const ollamaRunning = Boolean(gpuStatus?.ollama?.running);
  if (gpuEnabled && ollamaInstalled && !ollamaRunning) {
    issues.push({
      id: 'ollama_offline',
      severity: 'high',
      fixAction: 'start_ollama',
      canAutoFix: true,
      titleRu: 'Ollama не отвечает на локальном порту',
      titleEn: 'Ollama server is offline',
      detailRu: 'GPU-контур включён, но сервер Ollama остановлен',
      detailEn: 'GPU contour is enabled, but Ollama daemon is not running',
    });
  }

  const vramFit = gpuStatus?.vramFit || null;
  if (gpuEnabled && vramFit && vramFit.selectedChatFits === false && vramFit.bestFallbackChatModel) {
    issues.push({
      id: 'vram_mismatch',
      severity: 'warn',
      fixAction: 'apply_vram_fallback',
      canAutoFix: true,
      titleRu: `Модель не помещается в лимит VRAM → ${vramFit.bestFallbackChatModel}`,
      titleEn: `Model exceeds VRAM cap → ${vramFit.bestFallbackChatModel}`,
      detailRu: `Рекомендуется переключить чат-модель на ${vramFit.bestFallbackChatModel}`,
      detailEn: `Recommended switch to ${vramFit.bestFallbackChatModel}`,
      meta: { fallbackModel: String(vramFit.bestFallbackChatModel) },
    });
  }

  const ramEnabled = state?.ramCacheEnabled !== false;
  const ramCold = Boolean(ramEnabled && ramStatus && (!ramStatus.running || Number(ramStatus.cachedFiles || 0) === 0));
  if (ramCold) {
    issues.push({
      id: 'ram_daemon_cold',
      severity: 'info',
      fixAction: 'warm_ram_cache',
      canAutoFix: true,
      titleRu: 'Буфер In-RAM проекта не прогрет',
      titleEn: 'In-RAM workspace buffer is cold',
      detailRu: 'Прогрев загрузит файлы проекта в память для срезов <1 мс',
      detailEn: 'Warming loads workspace files into RAM for <1 ms slicing',
    });
  }

  const penalty = issues.reduce(
    (acc, it) => acc + (it.severity === 'high' ? 30 : it.severity === 'warn' ? 15 : 8),
    0
  );
  const score = Math.max(0, 100 - penalty);

  return {
    ok: true,
    healthy: issues.length === 0,
    score,
    checkedAt: new Date(nowMs).toISOString(),
    checks: {
      staleLocksCount: staleLocks.length,
      staleTmpCount: staleTmps.length,
      orphanWorktreesCount: orphanWorktrees.length,
      ollamaOk: !gpuEnabled || !ollamaInstalled || ollamaRunning,
      vramFitOk: !gpuEnabled || !vramFit || vramFit.selectedChatFits !== false,
      ramWarmOk: !ramCold,
    },
    issues,
  };
}

/**
 * Safely executes one or all allowlisted Health-Doctor auto-remediation actions.
 * @param {object} [opts={}]
 */
export async function applyHealthDoctorFix(opts = {}) {
  const safeOpts = opts && typeof opts === 'object' ? opts : {};
  const fixAction = typeof safeOpts.fixAction === 'string' ? safeOpts.fixAction.trim() : '';
  if (!ALLOWED_FIX_ACTIONS.has(fixAction)) {
    return { ok: false, error: `Unsupported fixAction: ${fixAction || 'empty'}`, applied: 0, log: [] };
  }

  const nowMs = Number.isFinite(Number(safeOpts.nowMs)) ? Number(safeOpts.nowMs) : Date.now();
  const state = safeOpts.state && typeof safeOpts.state === 'object' ? safeOpts.state : {};
  const cacheDir = typeof safeOpts.cacheDir === 'string' && safeOpts.cacheDir.trim()
    ? resolve(safeOpts.cacheDir.trim())
    : resolveTunnelCacheDir(PLUGIN_ROOT);
  const gpuStatus = safeOpts.gpuStatus && typeof safeOpts.gpuStatus === 'object' ? safeOpts.gpuStatus : null;
  const ramStatus = safeOpts.ramStatus && typeof safeOpts.ramStatus === 'object' ? safeOpts.ramStatus : null;
  const worktrees = Array.isArray(safeOpts.worktrees) ? safeOpts.worktrees : [];
  const workspaceRoot = typeof safeOpts.workspaceRoot === 'string' ? safeOpts.workspaceRoot : '';

  const targets = fixAction === 'fix_all'
    ? diagnoseRuntimeHealth({ workspaceRoot, state, cacheDir, gpuStatus, ramStatus, worktrees, nowMs }).issues.map((i) => i.fixAction)
    : [fixAction];

  const log = [];
  let applied = 0;

  for (const act of targets) {
    if (act === 'clean_stale_locks') {
      const stale = [...findStaleLockFiles(cacheDir, nowMs), ...findStaleTmpFiles(cacheDir, nowMs)];
      let removed = 0;
      for (const item of stale) {
        try {
          unlinkSync(item.path);
          removed += 1;
        } catch {}
      }
      if (removed > 0) applied += 1;
      log.push({
        action: act,
        ok: true,
        messageRu: removed > 0 ? `Удалено зависших lock/tmp-файлов: ${removed}` : 'Зависших lock/tmp-файлов не обнаружено',
        messageEn: removed > 0 ? `Removed stale .lock/.tmp files: ${removed}` : 'No stale .lock/.tmp files found',
      });
    } else if (act === 'prune_orphan_worktrees') {
      const orphans = findOrphanWorktrees(worktrees, nowMs);
      let pruned = 0;
      if (typeof safeOpts.pruneWorktreesFn === 'function') {
        const res = await safeOpts.pruneWorktreesFn(orphans);
        pruned = Number(res?.pruned ?? orphans.length);
      }
      if (pruned > 0) applied += 1;
      log.push({
        action: act,
        ok: true,
        messageRu: pruned > 0 ? `Очищено сиротских песочниц: ${pruned}` : 'Сиротских песочниц не найдено',
        messageEn: pruned > 0 ? `Pruned orphaned worktrees: ${pruned}` : 'No orphaned worktrees found',
      });
    } else if (act === 'start_ollama') {
      let ok = false;
      let errMsg = '';
      if (typeof safeOpts.startOllamaFn === 'function') {
        try {
          const r = await safeOpts.startOllamaFn();
          ok = Boolean(r?.ok ?? r);
          if (!ok && r?.error) errMsg = String(r.error);
        } catch (err) {
          errMsg = err?.message || 'start failed';
        }
      }
      if (ok) applied += 1;
      log.push({
        action: act,
        ok,
        messageRu: ok ? 'Сервер Ollama успешно запущен' : `Не удалось запустить Ollama${errMsg ? `: ${errMsg}` : ''}`,
        messageEn: ok ? 'Ollama server started' : `Failed to start Ollama${errMsg ? `: ${errMsg}` : ''}`,
      });
    } else if (act === 'apply_vram_fallback') {
      const fallback = String(gpuStatus?.vramFit?.bestFallbackChatModel || '').trim();
      let ok = false;
      if (fallback && typeof safeOpts.saveStateFn === 'function') {
        safeOpts.saveStateFn({ gpuChatModel: fallback });
        ok = true;
        applied += 1;
      }
      log.push({
        action: act,
        ok,
        messageRu: ok ? `Модель переключена на ${fallback}` : 'Подходящая модель-замена не найдена',
        messageEn: ok ? `Switched chat model to ${fallback}` : 'No suitable fallback model found',
      });
    } else if (act === 'warm_ram_cache') {
      let ok = false;
      let filesCount = 0;
      if (typeof safeOpts.warmRamFn === 'function') {
        try {
          const r = await safeOpts.warmRamFn(workspaceRoot);
          ok = Boolean(r?.ok ?? r);
          filesCount = Number(r?.filesCached || r?.cachedFiles || 0);
        } catch {}
      }
      if (ok) applied += 1;
      log.push({
        action: act,
        ok,
        messageRu: ok ? `In-RAM буфер прогрет (${filesCount} ф.)` : 'Не удалось прогреть In-RAM буфер',
        messageEn: ok ? `Warmed In-RAM buffer (${filesCount} files)` : 'Failed to warm In-RAM buffer',
      });
    }
  }

  return { ok: true, applied, log };
}

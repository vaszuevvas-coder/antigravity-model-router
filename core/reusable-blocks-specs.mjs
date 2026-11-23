/**
 * @file reusable-blocks-specs.mjs
 * @description Lightweight SOTA 2026 persistence primitives:
 *   1. Caveman v4 Rock #4 (`Blocks`): caches verified diagnostic micro-scripts in `.cache/reusable-blocks.json`
 *      so recurring checks cost ~76 tokens instead of regenerating ~400-token ad-hoc shell scripts.
 *   2. OpenSpec (`explore -> propose -> apply -> archive`): stores bounded (`<= 50 KB`) feature delta-specs
 *      in `.cache/specs/` across multi-session `L/XL` tasks without bloating `AGENTS.md`.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureTunnelCacheDir, resolveTunnelCacheDir } from './cache-dir.mjs';
import { atomicWriteJsonSync, safeReadJsonSync, updateJsonAtomicSync } from './safe-json.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, '..');
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export const MAX_OPENSPEC_BYTES = 50 * 1024; // Strict 50 KB OpenSpec cap

function resolveBaseCacheDir(customCacheDir = '') {
  if (typeof customCacheDir === 'string' && customCacheDir.trim()) {
    return ensureTunnelCacheDir(resolve(customCacheDir.trim()));
  }
  return ensureTunnelCacheDir(resolveTunnelCacheDir(PLUGIN_ROOT));
}

function normWsHash(workspaceRoot = '') {
  const s = String(workspaceRoot || process.cwd()).trim();
  const norm = (process.platform === 'win32' ? resolve(s).toLowerCase() : resolve(s)).replace(/\\/g, '/');
  return createHash('sha1').update(norm).digest('hex').slice(0, 12);
}

function sanitizeSpecSlug(raw = '') {
  const clean = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  if (!clean || UNSAFE_KEYS.has(clean)) return '';
  return clean;
}

// ============================================================================
// 1. Caveman v4 Rock #4 — Reusable Diagnostic Code Blocks
// ============================================================================

export function saveReusableBlock(opts = {}) {
  const {
    workspaceRoot = process.cwd(),
    name = '',
    description = '',
    command = '',
    tags = [],
    cacheDir = '',
    nowMs = Date.now(),
  } = opts && typeof opts === 'object' ? opts : {};
  const slug = sanitizeSpecSlug(name);
  const cmd = String(command || '').trim();
  if (!slug || !cmd || cmd.length > 4000) {
    return { ok: false, error: 'invalid_block_name_or_command' };
  }
  const wsHash = normWsHash(workspaceRoot);
  const file = join(resolveBaseCacheDir(cacheDir), 'reusable-blocks.json');
  const cleanTags = Array.isArray(tags)
    ? tags.map((t) => String(t || '').trim().toLowerCase()).filter(Boolean).slice(0, 8)
    : [];

  let saved = null;
  updateJsonAtomicSync(file, () => ({ workspaces: {} }), (doc) => {
    const workspaces = doc?.workspaces && typeof doc.workspaces === 'object' ? { ...doc.workspaces } : {};
    const bucket = workspaces[wsHash] && typeof workspaces[wsHash] === 'object' ? { ...workspaces[wsHash] } : {};
    const prev = Object.hasOwn(bucket, slug) ? bucket[slug] : null;
    saved = {
      name: slug,
      description: String(description || '').trim().slice(0, 200),
      command: cmd,
      tags: cleanTags,
      runs: Number(prev?.runs || 0),
      updatedAt: nowMs,
    };
    bucket[slug] = saved;
    const entries = Object.entries(bucket)
      .sort((a, b) => Number(b[1]?.updatedAt || 0) - Number(a[1]?.updatedAt || 0))
      .slice(0, 40);
    workspaces[wsHash] = Object.fromEntries(entries);
    return { workspaces };
  }, { spaces: 2 });

  return { ok: true, block: saved };
}

export function listReusableBlocks(opts = {}) {
  const { workspaceRoot = process.cwd(), query = '', cacheDir = '' } = opts && typeof opts === 'object' ? opts : {};
  const wsHash = normWsHash(workspaceRoot);
  const file = join(resolveBaseCacheDir(cacheDir), 'reusable-blocks.json');
  const doc = safeReadJsonSync(file, () => ({ workspaces: {} }), { selfHeal: true });
  const bucket = doc?.workspaces?.[wsHash];
  if (!bucket || typeof bucket !== 'object') return [];
  const q = String(query || '').trim().toLowerCase();
  const all = Object.values(bucket).filter((b) => b && b.name && b.command);
  if (!q) return all.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  const tokens = q.split(/\s+/).filter((t) => t.length >= 2);
  return all
    .filter((b) => {
      const hay = `${b.name} ${b.description || ''} ${(b.tags || []).join(' ')} ${b.command}`.toLowerCase();
      return tokens.some((t) => hay.includes(t));
    })
    .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
}

// ============================================================================
// 2. OpenSpec Lightweight Delta-Spec Ledger (`explore -> propose -> apply -> archive`)
// ============================================================================

const VALID_SPEC_PHASES = new Set(['explore', 'propose', 'apply', 'archive']);

function resolveSpecsDir(workspaceRoot = process.cwd(), customCacheDir = '') {
  const dir = join(resolveBaseCacheDir(customCacheDir), 'specs', normWsHash(workspaceRoot));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function upsertOpenSpecDelta(opts = {}) {
  const {
    workspaceRoot = process.cwd(),
    slug: rawSlug = '',
    title = '',
    phase = 'propose',
    content = '',
    cacheDir = '',
    nowMs = Date.now(),
  } = opts && typeof opts === 'object' ? opts : {};
  const slug = sanitizeSpecSlug(rawSlug || title);
  if (!slug) {
    return { ok: false, error: 'invalid_spec_slug' };
  }
  const cleanPhase = VALID_SPEC_PHASES.has(String(phase).toLowerCase()) ? String(phase).toLowerCase() : 'propose';
  const body = String(content || '').trim();
  const byteLength = Buffer.byteLength(body, 'utf8');
  if (byteLength > MAX_OPENSPEC_BYTES) {
    return {
      ok: false,
      error: `spec_exceeds_50kb_cap (${byteLength} > ${MAX_OPENSPEC_BYTES} bytes)`,
      byteLength,
    };
  }

  const dir = resolveSpecsDir(workspaceRoot, cacheDir);
  const metaPath = join(dir, `${slug}.meta.json`);
  const mdPath = join(dir, `${slug}.md`);
  const meta = {
    slug,
    title: String(title || slug).trim().slice(0, 140),
    phase: cleanPhase,
    byteLength,
    updatedAt: new Date(nowMs).toISOString(),
    updatedAtMs: nowMs,
  };
  writeFileSync(mdPath, `${body}\n`, 'utf8');
  atomicWriteJsonSync(metaPath, meta);

  return { ok: true, spec: meta, mdPath };
}

export function listOpenSpecDeltas(opts = {}) {
  const { workspaceRoot = process.cwd(), includeArchived = false, cacheDir = '' } = opts && typeof opts === 'object' ? opts : {};
  const dir = resolveSpecsDir(workspaceRoot, cacheDir);
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.meta.json'));
  } catch {
    return [];
  }
  const specs = [];
  for (const f of files) {
    const meta = safeReadJsonSync(join(dir, f), () => null, { selfHeal: false });
    if (!meta || !meta.slug) continue;
    if (!includeArchived && meta.phase === 'archive') continue;
    specs.push(meta);
  }
  return specs.sort((a, b) => Number(b.updatedAtMs || 0) - Number(a.updatedAtMs || 0));
}

export function readOpenSpecDelta(opts = {}) {
  const { workspaceRoot = process.cwd(), slug: rawSlug = '', cacheDir = '' } = opts && typeof opts === 'object' ? opts : {};
  const slug = sanitizeSpecSlug(rawSlug);
  if (!slug) return { ok: false, error: 'invalid_spec_slug' };
  const dir = resolveSpecsDir(workspaceRoot, cacheDir);
  const metaPath = join(dir, `${slug}.meta.json`);
  const mdPath = join(dir, `${slug}.md`);
  if (!existsSync(metaPath) || !existsSync(mdPath)) {
    return { ok: false, error: 'spec_not_found' };
  }
  const meta = safeReadJsonSync(metaPath, () => null, { selfHeal: false });
  const content = readFileSync(mdPath, 'utf8');
  return { ok: true, spec: meta, content };
}

export function formatActiveSpecsForHandoff(workspaceRoot = process.cwd(), opts = {}) {
  const { cacheDir = '' } = opts && typeof opts === 'object' ? opts : {};
  const active = listOpenSpecDeltas({ workspaceRoot, includeArchived: false, cacheDir }).slice(0, 4);
  if (active.length === 0) return '';
  const items = active.map((s) => `\`${s.slug}\` [${s.phase}, ${Math.max(1, Math.round((s.byteLength || 0) / 1024))}KB]`).join(', ');
  return `- Active OpenSpec Deltas: ${items}`;
}

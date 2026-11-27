/**
 * @file sqlite-knowledge-hub.mjs
 * @description Persistent NVMe Knowledge Hub powered by built-in Node.js `node:sqlite` (WAL mode, zero external deps):
 *   1. Persistent RepairKV snapshots & SHA-1 AST metadata cache (<30ms cold start after reboot; does NOT duplicate i8bin-v2 vectors).
 *   2. Victory Recipes (`victory_recipes`): confirmed test-passing bugfix patterns paired with Pitfall Ledger.
 *   3. Cross-Repo Federation (`repo_federation`): links companion repositories (e.g. frontend <-> backend) for federated search.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandQueryBilingualStems } from './cpu-reranker.mjs';
import { atomicWriteJsonSync, safeReadJsonSync, updateJsonAtomicSync } from './safe-json.mjs';
import { resolveTunnelCacheDir } from './cache-dir.mjs';
import { redactSecretsInText } from './security-guard.mjs';

let DatabaseSyncCtor = null;
try {
  const sqliteMod = await import('node:sqlite');
  if (typeof sqliteMod?.DatabaseSync === 'function') {
    DatabaseSyncCtor = sqliteMod.DatabaseSync;
  }
} catch {}

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, '..');
const CACHE_DIR = join(PLUGIN_ROOT, '.cache');
const DEFAULT_DB_PATH = join(CACHE_DIR, 'tunnel-knowledge.sqlite');
const UNSAFE_KEYS = new Set([
  '__proto__',
  'constructor',
  'prototype',
  'toString',
  'valueOf',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
]);

function asObj(val) {
  return val && typeof val === 'object' && !Array.isArray(val) ? val : {};
}

function asStr(val, fallback = '') {
  if (typeof val === 'string') return val;
  if (val === null || val === undefined) return fallback;
  return String(val);
}

function clampInt(val, min, max, fallback) {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function normWsKey(wsPath = '') {
  const raw = asStr(wsPath).trim();
  if (!raw || UNSAFE_KEYS.has(raw)) return '';
  try {
    const abs = resolve(raw);
    return (process.platform === 'win32' ? abs.toLowerCase() : abs).replace(/\\/g, '/').replace(/\/+$/, '');
  } catch {
    return '';
  }
}

function extractSearchStems(text = '', files = []) {
  const clean = asStr(text);
  const exp = expandQueryBilingualStems(clean);
  const stems = new Set(Array.isArray(exp?.allConcepts) ? exp.allConcepts : []);
  const rawIds = clean.match(/[A-Za-z_][A-Za-z0-9_.-]{2,}|[а-яА-ЯёЁ]{3,}/g) || [];
  for (const id of rawIds) {
    const low = id.toLowerCase();
    if (!UNSAFE_KEYS.has(low)) stems.add(low);
  }
  if (Array.isArray(files)) {
    for (const f of files) {
      const s = asStr(f).trim();
      if (!s) continue;
      stems.add(s.toLowerCase());
      const base = basename(s).toLowerCase();
      if (base) stems.add(base);
    }
  }
  return Array.from(stems).slice(0, 64);
}

export class SqliteKnowledgeHub {
  constructor(opts = {}) {
    const safeOpts = asObj(opts);
    this._isDefaultPath = !asStr(safeOpts.dbPath).trim();
    const initialDb = this._isDefaultPath
      ? join(resolveTunnelCacheDir(PLUGIN_ROOT), 'tunnel-knowledge.sqlite')
      : asStr(safeOpts.dbPath).trim();
    this.dbPath = initialDb || DEFAULT_DB_PATH;
    this.jsonFallbackPath = `${this.dbPath}.fallback.json`;
    this.maxRecipesPerWs = clampInt(safeOpts.maxRecipesPerWs, 5, 500, 60);
    this.maxAstRowsPerWs = clampInt(safeOpts.maxAstRowsPerWs, 50, 50_000, 12_000);
    this.maxBucketsPerWs = clampInt(safeOpts.maxBucketsPerWs, 2, 100, 24);
    this.maxInstinctsPerWs = clampInt(safeOpts.maxInstinctsPerWs, 10, 500, 80);
    this.db = null;
    this.backend = DatabaseSyncCtor ? 'sqlite_wal' : 'json_fallback';
    this._closed = false;
  }

  _syncDefaultPathIfNeeded() {
    if (!this._isDefaultPath) return;
    const nextDb = join(resolveTunnelCacheDir(PLUGIN_ROOT), 'tunnel-knowledge.sqlite');
    if (nextDb && nextDb !== this.dbPath) {
      if (this.db) {
        try { this.db.close(); } catch {}
        this.db = null;
      }
      this.dbPath = nextDb;
      this.jsonFallbackPath = `${nextDb}.fallback.json`;
    }
  }

  _ensureDb() {
    this._syncDefaultPathIfNeeded();
    if (this._closed) this._closed = false;
    if (this.db) return this.db;
    if (!DatabaseSyncCtor) {
      this.backend = 'json_fallback';
      return null;
    }

    try {
      const dir = dirname(this.dbPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const db = new DatabaseSyncCtor(this.dbPath);
      db.exec('PRAGMA journal_mode = WAL;');
      db.exec('PRAGMA synchronous = NORMAL;');
      db.exec('PRAGMA busy_timeout = 2000;');
      db.exec(`
        CREATE TABLE IF NOT EXISTS repair_kv_snapshots (
          bucket_key TEXT PRIMARY KEY,
          ws_key TEXT NOT NULL,
          items_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_repair_ws ON repair_kv_snapshots (ws_key, updated_at DESC);

        CREATE TABLE IF NOT EXISTS ast_meta_cache (
          ws_key TEXT NOT NULL,
          rel_path TEXT NOT NULL,
          sha1 TEXT NOT NULL,
          meta_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (ws_key, rel_path)
        );
        CREATE INDEX IF NOT EXISTS idx_ast_ws ON ast_meta_cache (ws_key);

        CREATE TABLE IF NOT EXISTS victory_recipes (
          id TEXT PRIMARY KEY,
          ws_key TEXT NOT NULL,
          norm_key TEXT NOT NULL,
          error_excerpt TEXT NOT NULL,
          touched_files_json TEXT NOT NULL,
          fix_summary TEXT NOT NULL,
          stems_json TEXT NOT NULL,
          hits INTEGER NOT NULL DEFAULT 1,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_victory_ws ON victory_recipes (ws_key, norm_key);

        CREATE TABLE IF NOT EXISTS repo_federation (
          primary_ws_key TEXT NOT NULL,
          peer_ws_path TEXT NOT NULL,
          peer_label TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (primary_ws_key, peer_ws_path)
        );

        CREATE TABLE IF NOT EXISTS project_instincts (
          id TEXT PRIMARY KEY,
          ws_key TEXT NOT NULL,
          norm_key TEXT NOT NULL,
          pattern TEXT NOT NULL,
          category TEXT NOT NULL DEFAULT 'recipe',
          confidence REAL NOT NULL DEFAULT 0.35,
          evidence_count INTEGER NOT NULL DEFAULT 1,
          promoted_skill TEXT NOT NULL DEFAULT '',
          stems_json TEXT NOT NULL DEFAULT '[]',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_instincts_ws ON project_instincts (ws_key, confidence DESC, updated_at DESC);

        CREATE TABLE IF NOT EXISTS ccr_blobs (
          hash TEXT PRIMARY KEY,
          ws_key TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'terminal',
          command_hint TEXT NOT NULL DEFAULT '',
          original_text TEXT NOT NULL,
          original_chars INTEGER NOT NULL,
          original_lines INTEGER NOT NULL,
          compressed_chars INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_ccr_expires ON ccr_blobs (expires_at);
        CREATE INDEX IF NOT EXISTS idx_ccr_ws ON ccr_blobs (ws_key, created_at DESC);

        CREATE TABLE IF NOT EXISTS session_episodes (
          id TEXT PRIMARY KEY,
          ws_key TEXT NOT NULL,
          conversation_id TEXT NOT NULL DEFAULT '',
          title TEXT NOT NULL,
          kind TEXT NOT NULL DEFAULT 'session',
          summary TEXT NOT NULL DEFAULT '',
          decisions_json TEXT NOT NULL DEFAULT '[]',
          touched_files_json TEXT NOT NULL DEFAULT '[]',
          stems_json TEXT NOT NULL DEFAULT '[]',
          est_tokens INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_episodes_ws ON session_episodes (ws_key, updated_at DESC);
      `);
      this.db = db;
      this.backend = 'sqlite_wal';
      return db;
    } catch {
      this.backend = 'json_fallback';
      this.db = null;
      return null;
    }
  }

  _readFallbackDoc() {
    this._syncDefaultPathIfNeeded();
    const raw = safeReadJsonSync(
      this.jsonFallbackPath,
      () => ({ repairBuckets: {}, astMeta: {}, victoryRecipes: {}, federation: {}, projectInstincts: {}, ccrBlobs: {}, sessionEpisodes: {} }),
      { selfHeal: true }
    );
    return {
      repairBuckets: asObj(raw?.repairBuckets),
      astMeta: asObj(raw?.astMeta),
      victoryRecipes: asObj(raw?.victoryRecipes),
      federation: asObj(raw?.federation),
      projectInstincts: asObj(raw?.projectInstincts),
      ccrBlobs: asObj(raw?.ccrBlobs),
      sessionEpisodes: asObj(raw?.sessionEpisodes),
    };
  }

  _writeFallbackDoc(doc) {
    this._syncDefaultPathIfNeeded();
    try {
      const dir = dirname(this.jsonFallbackPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      atomicWriteJsonSync(this.jsonFallbackPath, doc);
      return true;
    } catch {
      return false;
    }
  }

  _updateFallbackDoc(mutatorFn) {
    this._syncDefaultPathIfNeeded();
    try {
      const dir = dirname(this.jsonFallbackPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      updateJsonAtomicSync(
        this.jsonFallbackPath,
        () => ({
          repairBuckets: {},
          astMeta: {},
          victoryRecipes: {},
          federation: {},
          projectInstincts: {},
          ccrBlobs: {},
          sessionEpisodes: {},
        }),
        (raw) => {
          const doc = {
            repairBuckets: asObj(raw?.repairBuckets),
            astMeta: asObj(raw?.astMeta),
            victoryRecipes: asObj(raw?.victoryRecipes),
            federation: asObj(raw?.federation),
            projectInstincts: asObj(raw?.projectInstincts),
            ccrBlobs: asObj(raw?.ccrBlobs),
            sessionEpisodes: asObj(raw?.sessionEpisodes),
          };
          const next = mutatorFn(doc);
          return next && typeof next === 'object' ? next : doc;
        }
      );
      return true;
    } catch {
      return false;
    }
  }

  close() {
    this._closed = true;
    if (this.db) {
      try {
        this.db.close();
      } catch {}
      this.db = null;
    }
  }

  // --------------------------------------------------------------------------
  // 1. Persistent RepairKV & AST Meta Cache
  // --------------------------------------------------------------------------

  saveRepairKvBuckets(wsPath = '', bucketsMap = null) {
    const wsKey = normWsKey(wsPath);
    if (!wsKey || !bucketsMap) return { ok: false, savedBuckets: 0 };

    const entries = bucketsMap instanceof Map
      ? Array.from(bucketsMap.entries())
      : (typeof bucketsMap === 'object' ? Object.entries(bucketsMap) : []);

    const matched = [];
    for (const [bKey, items] of entries) {
      if (!bKey || !Array.isArray(items) || items.length === 0) continue;
      const pipeIdx = String(bKey).indexOf('|');
      const bWs = pipeIdx !== -1 ? normWsKey(String(bKey).slice(pipeIdx + 1)) : '';
      if (bWs === wsKey || !bWs) {
        matched.push({ bucketKey: String(bKey), items: items.slice(-60) });
      }
    }
    if (matched.length === 0) return { ok: true, savedBuckets: 0 };

    const now = Date.now();
    const db = this._ensureDb();
    if (db) {
      try {
        const stmt = db.prepare(`
          INSERT INTO repair_kv_snapshots (bucket_key, ws_key, items_json, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(bucket_key) DO UPDATE SET
            ws_key = excluded.ws_key,
            items_json = excluded.items_json,
            updated_at = excluded.updated_at
        `);
        db.exec('BEGIN IMMEDIATE;');
        try {
          for (const m of matched) {
            stmt.run(m.bucketKey, wsKey, JSON.stringify(m.items), now);
          }
          db.exec('COMMIT;');
        } catch (err) {
          try { db.exec('ROLLBACK;'); } catch {}
          throw err;
        }
        return { ok: true, savedBuckets: matched.length };
      } catch {
        return { ok: false, savedBuckets: 0 };
      }
    }

    this._updateFallbackDoc((doc) => {
      if (!doc.repairBuckets[wsKey] || typeof doc.repairBuckets[wsKey] !== 'object' || Array.isArray(doc.repairBuckets[wsKey])) {
        doc.repairBuckets[wsKey] = {};
      }
      for (const m of matched) {
        if (UNSAFE_KEYS.has(m.bucketKey)) continue;
        doc.repairBuckets[wsKey][m.bucketKey] = { items: m.items, updatedAt: now };
      }
      return doc;
    });
    return { ok: true, savedBuckets: matched.length };
  }

  loadRepairKvBuckets(wsPath = '') {
    const wsKey = normWsKey(wsPath);
    if (!wsKey) return new Map();

    const out = new Map();
    const db = this._ensureDb();
    if (db) {
      try {
        const rows = db
          .prepare('SELECT bucket_key, items_json FROM repair_kv_snapshots WHERE ws_key = ? ORDER BY updated_at DESC LIMIT ?')
          .all(wsKey, this.maxBucketsPerWs);
        for (const r of rows) {
          try {
            const parsed = JSON.parse(r.items_json);
            if (Array.isArray(parsed) && parsed.length > 0) {
              out.set(String(r.bucket_key), parsed);
            }
          } catch {}
        }
        return out;
      } catch {
        return out;
      }
    }

    const doc = this._readFallbackDoc();
    const wsBuckets = asObj(doc.repairBuckets[wsKey]);
    for (const [k, v] of Object.entries(wsBuckets)) {
      if (Array.isArray(v?.items)) out.set(k, v.items);
    }
    return out;
  }

  hydrateRepairIndex(repairIndex, wsPath = '') {
    if (!repairIndex || !(repairIndex.buckets instanceof Map)) return 0;
    const loaded = this.loadRepairKvBuckets(wsPath);
    let restoredBuckets = 0;
    for (const [k, items] of loaded.entries()) {
      const existing = repairIndex.buckets.get(k);
      if (!existing || existing.length === 0) {
        repairIndex.buckets.set(k, items);
        restoredBuckets += 1;
      }
    }
    return restoredBuckets;
  }

  saveAstMetaBatch(wsPath = '', entries = []) {
    const wsKey = normWsKey(wsPath);
    const list = Array.isArray(entries) ? entries : [];
    if (!wsKey || list.length === 0) return { ok: false, saved: 0 };

    const now = Date.now();
    const cleanRows = [];
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const relPath = asStr(item.relPath).replace(/\\/g, '/').replace(/^\.\//, '').trim();
      const sha1 = asStr(item.sha1).trim();
      if (!relPath || !sha1 || UNSAFE_KEYS.has(relPath)) continue;
      const meta = {
        symbolsWithRanges: Array.isArray(item.symbolsWithRanges || item.symbols)
          ? (item.symbolsWithRanges || item.symbols).slice(0, 180)
          : [],
        imports: Array.isArray(item.imports) ? item.imports.slice(0, 80) : [],
        exportedSymbols: Array.isArray(item.exportedSymbols) ? item.exportedSymbols.slice(0, 120) : [],
        semanticMeta: asObj(item.semanticMeta),
      };
      cleanRows.push({ relPath, sha1, metaJson: JSON.stringify(meta) });
    }
    if (cleanRows.length === 0) return { ok: true, saved: 0 };

    const db = this._ensureDb();
    if (db) {
      try {
        const stmt = db.prepare(`
          INSERT INTO ast_meta_cache (ws_key, rel_path, sha1, meta_json, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(ws_key, rel_path) DO UPDATE SET
            sha1 = excluded.sha1,
            meta_json = excluded.meta_json,
            updated_at = excluded.updated_at
        `);
        db.exec('BEGIN IMMEDIATE;');
        try {
          for (const row of cleanRows.slice(0, this.maxAstRowsPerWs)) {
            stmt.run(wsKey, row.relPath, row.sha1, row.metaJson, now);
          }
          db.exec('COMMIT;');
        } catch (err) {
          try { db.exec('ROLLBACK;'); } catch {}
          throw err;
        }
        return { ok: true, saved: cleanRows.length };
      } catch {
        return { ok: false, saved: 0 };
      }
    }

    this._updateFallbackDoc((doc) => {
      if (!doc.astMeta[wsKey] || typeof doc.astMeta[wsKey] !== 'object' || Array.isArray(doc.astMeta[wsKey])) {
        doc.astMeta[wsKey] = {};
      }
      for (const row of cleanRows) {
        doc.astMeta[wsKey][row.relPath] = { sha1: row.sha1, meta: JSON.parse(row.metaJson), updatedAt: now };
      }
      return doc;
    });
    return { ok: true, saved: cleanRows.length };
  }

  loadAstMetaMap(wsPath = '') {
    const wsKey = normWsKey(wsPath);
    const out = new Map();
    if (!wsKey) return out;

    const db = this._ensureDb();
    if (db) {
      try {
        const rows = db
          .prepare('SELECT rel_path, sha1, meta_json FROM ast_meta_cache WHERE ws_key = ? LIMIT ?')
          .all(wsKey, this.maxAstRowsPerWs);
        for (const r of rows) {
          try {
            const meta = JSON.parse(r.meta_json);
            if (meta && typeof meta === 'object') {
              out.set(String(r.rel_path), { sha1: String(r.sha1), meta });
            }
          } catch {}
        }
        return out;
      } catch {
        return out;
      }
    }

    const doc = this._readFallbackDoc();
    const wsMeta = asObj(doc.astMeta[wsKey]);
    for (const [rel, val] of Object.entries(wsMeta)) {
      if (val && val.sha1 && val.meta) out.set(rel, { sha1: val.sha1, meta: val.meta });
    }
    return out;
  }

  // --------------------------------------------------------------------------
  // 2. Victory Recipes (Episodic Successful Fixes)
  // --------------------------------------------------------------------------

  recordVictoryRecipe(opts = {}) {
    const safeOpts = asObj(opts);
    const wsKey = normWsKey(safeOpts.workspaceRoot);
    if (!wsKey) return { ok: false, error: 'Invalid workspaceRoot' };

    const rawErr = redactSecretsInText(asStr(safeOpts.errorExcerpt)).replace(/\s+/g, ' ').trim().slice(0, 220);
    const rawFix = redactSecretsInText(asStr(safeOpts.fixSummary)).replace(/\s+/g, ' ').trim().slice(0, 260);
    if (!rawErr && !rawFix) return { ok: false, error: 'Empty recipe' };

    const touchedFiles = Array.isArray(safeOpts.touchedFiles)
      ? Array.from(new Set(safeOpts.touchedFiles.map((f) => asStr(f).replace(/\\/g, '/').trim()).filter(Boolean))).slice(0, 12)
      : [];

    const normKey = createHash('sha1')
      .update(`${rawErr.toLowerCase().slice(0, 96)}|${rawFix.toLowerCase().slice(0, 96)}`)
      .digest('hex')
      .slice(0, 16);
    const stems = extractSearchStems(`${rawErr} ${rawFix}`, touchedFiles);
    const now = Date.now();
    const id = `vr_${normKey}`;

    const db = this._ensureDb();
    if (db) {
      try {
        const existing = db
          .prepare('SELECT id, hits FROM victory_recipes WHERE ws_key = ? AND norm_key = ? LIMIT 1')
          .get(wsKey, normKey);
        if (existing) {
          db.prepare('UPDATE victory_recipes SET fix_summary = ?, touched_files_json = ?, stems_json = ?, hits = hits + 1, updated_at = ? WHERE id = ?')
            .run(rawFix || rawErr, JSON.stringify(touchedFiles), JSON.stringify(stems), now, existing.id);
        } else {
          db.prepare(`
            INSERT INTO victory_recipes (id, ws_key, norm_key, error_excerpt, touched_files_json, fix_summary, stems_json, hits, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
          `).run(id, wsKey, normKey, rawErr, JSON.stringify(touchedFiles), rawFix || rawErr, JSON.stringify(stems), now);

          db.prepare(`
            DELETE FROM victory_recipes
            WHERE ws_key = ? AND id NOT IN (
              SELECT id FROM victory_recipes WHERE ws_key = ? ORDER BY updated_at DESC LIMIT ?
            )
          `).run(wsKey, wsKey, this.maxRecipesPerWs);
        }
        return {
          ok: true,
          recipe: { id, errorExcerpt: rawErr, touchedFiles, fixSummary: rawFix || rawErr, updatedAt: new Date(now).toISOString() },
        };
      } catch {
        return { ok: false, error: 'SQLite error' };
      }
    }

    this._updateFallbackDoc((doc) => {
      const list = Array.isArray(doc.victoryRecipes[wsKey]) ? [...doc.victoryRecipes[wsKey]] : [];
      const found = list.find((r) => r.normKey === normKey);
      if (found) {
        found.fixSummary = rawFix || rawErr;
        found.touchedFiles = touchedFiles;
        found.stems = stems;
        found.hits = Number(found.hits || 1) + 1;
        found.updatedAt = now;
      } else {
        list.unshift({
          id,
          normKey,
          errorExcerpt: rawErr,
          touchedFiles,
          fixSummary: rawFix || rawErr,
          stems,
          hits: 1,
          updatedAt: now,
        });
      }
      doc.victoryRecipes[wsKey] = list.slice(0, this.maxRecipesPerWs);
      return doc;
    });
    return {
      ok: true,
      recipe: { id, errorExcerpt: rawErr, touchedFiles, fixSummary: rawFix || rawErr, updatedAt: new Date(now).toISOString() },
    };
  }

  listVictoryRecipes(workspaceRoot = '', limit = 15) {
    const wsKey = normWsKey(workspaceRoot);
    const maxN = clampInt(limit, 1, 100, 15);
    if (!wsKey) return [];

    const db = this._ensureDb();
    if (db) {
      try {
        const rows = db
          .prepare('SELECT id, error_excerpt, touched_files_json, fix_summary, stems_json, hits, updated_at FROM victory_recipes WHERE ws_key = ? ORDER BY updated_at DESC LIMIT ?')
          .all(wsKey, maxN);
        return rows.map((r) => ({
          id: String(r.id),
          errorExcerpt: String(r.error_excerpt || ''),
          touchedFiles: (() => { try { return JSON.parse(r.touched_files_json); } catch { return []; } })(),
          fixSummary: String(r.fix_summary || ''),
          stems: (() => { try { return JSON.parse(r.stems_json); } catch { return []; } })(),
          hits: Number(r.hits || 1),
          updatedAt: new Date(Number(r.updated_at || Date.now())).toISOString(),
        }));
      } catch {
        return [];
      }
    }

    const doc = this._readFallbackDoc();
    const list = Array.isArray(doc.victoryRecipes[wsKey]) ? doc.victoryRecipes[wsKey] : [];
    return list.slice(0, maxN).map((r) => ({
      id: String(r.id),
      errorExcerpt: String(r.errorExcerpt || ''),
      touchedFiles: Array.isArray(r.touchedFiles) ? r.touchedFiles : [],
      fixSummary: String(r.fixSummary || ''),
      stems: Array.isArray(r.stems) ? r.stems : [],
      hits: Number(r.hits || 1),
      updatedAt: new Date(Number(r.updatedAt || Date.now())).toISOString(),
    }));
  }

  clearVictoryRecipes(workspaceRoot = '') {
    const wsKey = normWsKey(workspaceRoot);
    if (!wsKey) return { ok: false, removed: 0 };

    const db = this._ensureDb();
    if (db) {
      try {
        const info = db.prepare('DELETE FROM victory_recipes WHERE ws_key = ?').run(wsKey);
        return { ok: true, removed: Number(info?.changes || 0) };
      } catch {
        return { ok: false, removed: 0 };
      }
    }

    let prev = 0;
    this._updateFallbackDoc((doc) => {
      prev = Array.isArray(doc.victoryRecipes[wsKey]) ? doc.victoryRecipes[wsKey].length : 0;
      delete doc.victoryRecipes[wsKey];
      return doc;
    });
    return { ok: true, removed: prev };
  }

  matchVictoryRecipes(workspaceRoot = '', queryOrError = '', opts = {}) {
    const safeOpts = asObj(opts);
    const cleanQuery = asStr(queryOrError).trim();
    if (!workspaceRoot || cleanQuery.length < 4) {
      return { ok: true, recipes: [], formattedHint: '' };
    }

    const all = this.listVictoryRecipes(workspaceRoot, 50);
    if (all.length === 0) return { ok: true, recipes: [], formattedHint: '' };

    const qStems = new Set(extractSearchStems(cleanQuery));
    if (qStems.size === 0) return { ok: true, recipes: [], formattedHint: '' };

    const scored = [];
    for (const rec of all) {
      const rStems = new Set(Array.isArray(rec.stems) ? rec.stems : extractSearchStems(`${rec.errorExcerpt} ${rec.fixSummary}`, rec.touchedFiles));
      let overlap = 0;
      for (const qs of qStems) {
        if (rStems.has(qs)) {
          overlap += qs.includes('.') ? 2.5 : 1.0;
        }
      }
      if (overlap >= 1.5) {
        const score = overlap + Math.min(0.6, Math.log1p(rec.hits || 1) * 0.25);
        scored.push({ ...rec, score: Number(score.toFixed(2)) });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    const topK = clampInt(safeOpts.topK, 1, 6, 3);
    const recipes = scored.slice(0, topK);
    if (recipes.length === 0) return { ok: true, recipes: [], formattedHint: '' };

    const top = recipes[0];
    const filesStr = top.touchedFiles.length > 0 ? ` (${top.touchedFiles.slice(0, 3).join(', ')})` : '';
    const hintBody = `${top.errorExcerpt ? `${top.errorExcerpt} -> ` : ''}${top.fixSummary}${filesStr}`.replace(/\s+/g, ' ').trim();
    const formattedHint = `🏆 [Victory Recipe] ${hintBody}`.slice(0, 260);
    return { ok: true, recipes, formattedHint };
  }

  // --------------------------------------------------------------------------
  // 3. Cross-Repo Federation
  // --------------------------------------------------------------------------

  setFederatedWorkspaces(primaryWs = '', peerPaths = []) {
    const primaryKey = normWsKey(primaryWs);
    if (!primaryKey) return { ok: false, peers: [] };

    const rawPeers = Array.isArray(peerPaths) ? peerPaths : [];
    const seen = new Set();
    const cleanPeers = [];
    for (const p of rawPeers) {
      const s = asStr(p).trim();
      if (!s || UNSAFE_KEYS.has(s) || /[\r\n\0]/.test(s)) continue;
      let absPeer = '';
      try {
        absPeer = isAbsolute(s) ? resolve(s) : (primaryWs ? resolve(primaryWs, s) : resolve(s));
      } catch {
        continue;
      }
      const peerKey = normWsKey(absPeer);
      if (!peerKey || peerKey === primaryKey || seen.has(peerKey)) continue;
      try {
        if (!existsSync(absPeer) || !statSync(absPeer).isDirectory()) continue;
      } catch {
        continue;
      }
      seen.add(peerKey);
      cleanPeers.push({ path: absPeer, label: basename(absPeer) || absPeer });
      if (cleanPeers.length >= 8) break;
    }

    const now = Date.now();
    const db = this._ensureDb();
    if (db) {
      try {
        db.exec('BEGIN IMMEDIATE;');
        try {
          db.prepare('DELETE FROM repo_federation WHERE primary_ws_key = ?').run(primaryKey);
          const stmt = db.prepare('INSERT INTO repo_federation (primary_ws_key, peer_ws_path, peer_label, updated_at) VALUES (?, ?, ?, ?)');
          for (const p of cleanPeers) {
            stmt.run(primaryKey, p.path, p.label, now);
          }
          db.exec('COMMIT;');
        } catch (err) {
          try { db.exec('ROLLBACK;'); } catch {}
          throw err;
        }
        return { ok: true, peers: cleanPeers };
      } catch {
        return { ok: false, peers: [] };
      }
    }

    this._updateFallbackDoc((doc) => {
      doc.federation[primaryKey] = cleanPeers;
      return doc;
    });
    return { ok: true, peers: cleanPeers };
  }

  getFederatedWorkspaces(primaryWs = '') {
    const primaryKey = normWsKey(primaryWs);
    if (!primaryKey) return [];

    const db = this._ensureDb();
    if (db) {
      try {
        const rows = db
          .prepare('SELECT peer_ws_path, peer_label FROM repo_federation WHERE primary_ws_key = ? ORDER BY peer_label ASC')
          .all(primaryKey);
        return rows
          .filter((r) => r.peer_ws_path && existsSync(String(r.peer_ws_path)))
          .map((r) => ({ path: String(r.peer_ws_path), label: String(r.peer_label || basename(String(r.peer_ws_path))) }));
      } catch {
        return [];
      }
    }

    const doc = this._readFallbackDoc();
    const arr = Array.isArray(doc.federation[primaryKey]) ? doc.federation[primaryKey] : [];
    return arr.filter((p) => p?.path && existsSync(p.path));
  }

  searchFederatedPeers(primaryWs = '', query = '', ramEngine = null, opts = {}) {
    const safeOpts = asObj(opts);
    const cleanQuery = asStr(query).trim();
    if (!primaryWs || !cleanQuery || !ramEngine || typeof ramEngine.search !== 'function') {
      return { ok: true, peerCount: 0, results: [], formatted: '' };
    }

    const registered = this.getFederatedWorkspaces(primaryWs);
    const extraRaw = Array.isArray(safeOpts.extraPeers) ? safeOpts.extraPeers : [];
    const primaryKey = normWsKey(primaryWs);
    const peersMap = new Map();
    for (const r of registered) {
      peersMap.set(normWsKey(r.path), r);
    }
    for (const ep of extraRaw) {
      const s = asStr(ep).trim();
      const k = normWsKey(s);
      if (k && k !== primaryKey && existsSync(s) && !peersMap.has(k)) {
        peersMap.set(k, { path: resolve(s), label: basename(resolve(s)) });
      }
    }

    const peers = Array.from(peersMap.values());
    if (peers.length === 0) {
      return { ok: true, peerCount: 0, results: [], formatted: '' };
    }

    const maxResults = clampInt(safeOpts.maxResults, 1, 12, 4);
    const contextLines = clampInt(safeOpts.contextLines, 0, 8, 2);
    const allResults = [];

    for (const peer of peers) {
      try {
        const peerKey = normWsKey(peer.path);
        const alreadyLoaded = Boolean(ramEngine.workspaces?.has?.(peerKey));
        if (!alreadyLoaded && typeof ramEngine.warmWorkspace === 'function') {
          ramEngine.warmWorkspace(peer.path, { startWatcher: false });
        } else if (!alreadyLoaded && typeof ramEngine.ensureWarm === 'function') {
          ramEngine.ensureWarm(peer.path, { startWatcher: false });
        }
        const sr = ramEngine.search(peer.path, cleanQuery, { maxResults: 3, contextLines });
        if (sr?.ok && Array.isArray(sr.results)) {
          for (const hit of sr.results) {
            allResults.push({
              ...hit,
              peerRepo: peer.label,
              peerPath: peer.path,
            });
          }
        }
      } catch {}
    }

    allResults.sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
    const top = allResults.slice(0, maxResults);
    if (top.length === 0) {
      return { ok: true, peerCount: peers.length, results: [], formatted: '' };
    }

    const blocks = top.map((r) => {
      const head = `// [Federated: ${r.peerRepo}] ${r.file} [L${r.startLine}-L${r.endLine}]`;
      return `${head}\n${asStr(r.snippet).trimEnd()}`;
    });
    return {
      ok: true,
      peerCount: peers.length,
      results: top,
      formatted: blocks.join('\n\n'),
    };
  }

  // --------------------------------------------------------------------------
  // 4. Two-Stage Project Instincts (Confidence & Half-Life Decay -> Skills)
  // --------------------------------------------------------------------------

  _computeDecayedConfidence(confidence, updatedAtMs, nowMs = Date.now()) {
    const base = Math.max(0, Math.min(0.95, Number(confidence ?? 0.35)));
    const ageDays = Math.max(0, (Number(nowMs || Date.now()) - Number(updatedAtMs || nowMs)) / (1000 * 60 * 60 * 24));
    return Number(Math.max(0, Math.min(0.95, base * Math.pow(0.5, ageDays / 14))).toFixed(4));
  }

  _normalizeInstinctRow(row, nowMs = Date.now()) {
    const promotedSkill = asStr(row.promoted_skill ?? row.promotedSkill);
    const rawConfidence = Number(row.confidence ?? 0.35);
    const updatedAt = Number(row.updated_at ?? row.updatedAt ?? nowMs);
    const effectiveConfidence = promotedSkill
      ? Number(Math.min(0.95, rawConfidence).toFixed(4))
      : this._computeDecayedConfidence(rawConfidence, updatedAt, nowMs);
    const evidenceCount = Number(row.evidence_count ?? row.evidenceCount ?? 1);
    let stems = [];
    if (Array.isArray(row.stems)) {
      stems = row.stems;
    } else if (typeof row.stems_json === 'string') {
      try {
        stems = JSON.parse(row.stems_json);
      } catch {
        stems = [];
      }
    }
    return {
      id: asStr(row.id),
      wsKey: asStr(row.ws_key ?? row.wsKey),
      normKey: asStr(row.norm_key ?? row.normKey),
      pattern: asStr(row.pattern),
      category: asStr(row.category || 'recipe') === 'invariant' ? 'invariant' : 'recipe',
      confidence: Number(rawConfidence.toFixed(4)),
      effectiveConfidence,
      evidenceCount,
      promotedSkill,
      stems: Array.isArray(stems) ? stems : [],
      createdAt: Number(row.created_at ?? row.createdAt ?? updatedAt),
      updatedAt,
      readyForPromotion: !promotedSkill && effectiveConfidence >= 0.75 && evidenceCount >= 3,
    };
  }

  recordInstinct({
    workspaceRoot = '',
    pattern = '',
    category = 'recipe',
    initialConfidence = 0.35,
    deltaConfidence = 0.2,
    nowMs = Date.now(),
  } = {}) {
    const wsKey = normWsKey(workspaceRoot);
    const cleanPattern = redactSecretsInText(asStr(pattern)).replace(/\s+/g, ' ').trim().slice(0, 280);
    if (!wsKey || cleanPattern.length < 8) {
      return { ok: false, error: 'invalid_instinct' };
    }
    const cleanCategory = category === 'invariant' ? 'invariant' : 'recipe';
    const normKey = createHash('sha1').update(cleanPattern.toLowerCase()).digest('hex').slice(0, 16);
    const id = createHash('sha1').update(`${wsKey}|${normKey}`).digest('hex').slice(0, 20);
    const stems = extractSearchStems(cleanPattern);
    const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
    const stepDelta = Math.max(0.05, Math.min(0.5, Number(deltaConfidence ?? 0.2) || 0.2));
    const initConf = Number(Math.max(0.1, Math.min(0.95, Number(initialConfidence ?? 0.35) || 0.35)).toFixed(4));

    const db = this._ensureDb();
    if (db) {
      try {
        const existing = db
          .prepare('SELECT id, confidence, evidence_count, promoted_skill, created_at, updated_at FROM project_instincts WHERE ws_key = ? AND norm_key = ?')
          .get(wsKey, normKey);
        if (existing) {
          const decayedPrev = existing.promoted_skill
            ? Number(existing.confidence || 0.35)
            : this._computeDecayedConfidence(existing.confidence, existing.updated_at, now);
          const nextConf = Number(Math.min(0.95, decayedPrev + stepDelta).toFixed(4));
          const nextEvidence = Number(existing.evidence_count || 1) + 1;
          db.prepare(
            'UPDATE project_instincts SET pattern = ?, category = ?, confidence = ?, evidence_count = ?, stems_json = ?, updated_at = ? WHERE id = ?'
          ).run(cleanPattern, cleanCategory, nextConf, nextEvidence, JSON.stringify(stems), now, existing.id);
          const promotedSkill = asStr(existing.promoted_skill);
          return {
            ok: true,
            id: asStr(existing.id),
            wsKey,
            pattern: cleanPattern,
            category: cleanCategory,
            confidence: nextConf,
            effectiveConfidence: nextConf,
            evidenceCount: nextEvidence,
            promotedSkill,
            readyForPromotion: !promotedSkill && nextConf >= 0.75 && nextEvidence >= 3,
            updated: true,
          };
        }

        db.prepare(`
          INSERT INTO project_instincts (id, ws_key, norm_key, pattern, category, confidence, evidence_count, promoted_skill, stems_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 1, '', ?, ?, ?)
        `).run(id, wsKey, normKey, cleanPattern, cleanCategory, initConf, JSON.stringify(stems), now, now);

        db.prepare(`
          DELETE FROM project_instincts
          WHERE ws_key = ? AND promoted_skill = '' AND id NOT IN (
            SELECT id FROM project_instincts WHERE ws_key = ? ORDER BY promoted_skill != '' DESC, confidence DESC, updated_at DESC LIMIT ?
          )
        `).run(wsKey, wsKey, this.maxInstinctsPerWs);

        return {
          ok: true,
          id,
          wsKey,
          pattern: cleanPattern,
          category: cleanCategory,
          confidence: initConf,
          effectiveConfidence: initConf,
          evidenceCount: 1,
          promotedSkill: '',
          readyForPromotion: false,
          updated: false,
        };
      } catch (err) {
        return { ok: false, error: err?.message || 'sqlite_instinct_error' };
      }
    }

    let outcome = null;
    this._updateFallbackDoc((doc) => {
      const list = Array.isArray(doc.projectInstincts[wsKey]) ? [...doc.projectInstincts[wsKey]] : [];
      const idx = list.findIndex((it) => it && it.normKey === normKey);
      if (idx !== -1) {
        const prev = list[idx];
        const decayedPrev = prev.promotedSkill
          ? Number(prev.confidence || 0.35)
          : this._computeDecayedConfidence(prev.confidence, prev.updatedAt, now);
        const nextConf = Number(Math.min(0.95, decayedPrev + stepDelta).toFixed(4));
        const nextEvidence = Number(prev.evidenceCount || 1) + 1;
        list[idx] = {
          ...prev,
          pattern: cleanPattern,
          category: cleanCategory,
          confidence: nextConf,
          evidenceCount: nextEvidence,
          stems,
          updatedAt: now,
        };
        doc.projectInstincts[wsKey] = list;
        const promotedSkill = asStr(prev.promotedSkill);
        outcome = {
          ok: true,
          id: asStr(prev.id),
          wsKey,
          pattern: cleanPattern,
          category: cleanCategory,
          confidence: nextConf,
          effectiveConfidence: nextConf,
          evidenceCount: nextEvidence,
          promotedSkill,
          readyForPromotion: !promotedSkill && nextConf >= 0.75 && nextEvidence >= 3,
          updated: true,
        };
        return doc;
      }

      const item = {
        id,
        wsKey,
        normKey,
        pattern: cleanPattern,
        category: cleanCategory,
        confidence: initConf,
        evidenceCount: 1,
        promotedSkill: '',
        stems,
        createdAt: now,
        updatedAt: now,
      };
      list.push(item);
      list.sort((a, b) => Number(Boolean(b.promotedSkill)) - Number(Boolean(a.promotedSkill)) || Number(b.confidence || 0) - Number(a.confidence || 0) || Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
      doc.projectInstincts[wsKey] = list.slice(0, this.maxInstinctsPerWs);
      outcome = {
        ok: true,
        id,
        wsKey,
        pattern: cleanPattern,
        category: cleanCategory,
        confidence: initConf,
        effectiveConfidence: initConf,
        evidenceCount: 1,
        promotedSkill: '',
        readyForPromotion: false,
        updated: false,
      };
      return doc;
    });
    return outcome || { ok: false, error: 'fallback_instinct_error' };
  }

  listInstincts({
    workspaceRoot = '',
    minConfidence = 0.2,
    includePromoted = false,
    limit = 30,
    nowMs = Date.now(),
  } = {}) {
    const wsKey = normWsKey(workspaceRoot);
    const minConf = Math.max(0, Math.min(1, Number(minConfidence ?? 0.2)));
    const maxItems = clampInt(limit, 1, 200, 30);
    const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
    let rawRows = [];

    const db = this._ensureDb();
    if (db) {
      try {
        rawRows = wsKey
          ? db.prepare('SELECT * FROM project_instincts WHERE ws_key = ? ORDER BY updated_at DESC').all(wsKey)
          : db.prepare('SELECT * FROM project_instincts ORDER BY updated_at DESC').all();
      } catch {
        rawRows = [];
      }
    } else {
      const doc = this._readFallbackDoc();
      if (wsKey) {
        rawRows = Array.isArray(doc.projectInstincts[wsKey]) ? doc.projectInstincts[wsKey] : [];
      } else {
        for (const arr of Object.values(doc.projectInstincts)) {
          if (Array.isArray(arr)) rawRows.push(...arr);
        }
      }
    }

    const items = rawRows
      .map((r) => this._normalizeInstinctRow(r, now))
      .filter((it) => (includePromoted || !it.promotedSkill) && it.effectiveConfidence >= minConf)
      .sort((a, b) => b.effectiveConfidence - a.effectiveConfidence || b.evidenceCount - a.evidenceCount || b.updatedAt - a.updatedAt)
      .slice(0, maxItems);

    return { ok: true, items };
  }

  getInstinctById(id = '', workspaceRoot = '', nowMs = Date.now()) {
    const cleanId = asStr(id).trim();
    if (!cleanId) return null;
    const wsKey = normWsKey(workspaceRoot);
    const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();

    const db = this._ensureDb();
    if (db) {
      try {
        const row = wsKey
          ? db.prepare('SELECT * FROM project_instincts WHERE id = ? AND ws_key = ?').get(cleanId, wsKey)
          : db.prepare('SELECT * FROM project_instincts WHERE id = ?').get(cleanId);
        return row ? this._normalizeInstinctRow(row, now) : null;
      } catch {
        return null;
      }
    }

    const doc = this._readFallbackDoc();
    const lists = wsKey
      ? [Array.isArray(doc.projectInstincts[wsKey]) ? doc.projectInstincts[wsKey] : []]
      : Object.values(doc.projectInstincts).filter(Array.isArray);
    for (const arr of lists) {
      const hit = arr.find((it) => it && it.id === cleanId);
      if (hit) return this._normalizeInstinctRow(hit, now);
    }
    return null;
  }

  markInstinctPromoted({ id = '', skillSlug = '', workspaceRoot = '', nowMs = Date.now() } = {}) {
    const cleanId = asStr(id).trim();
    const cleanSlug = asStr(skillSlug).trim().slice(0, 64);
    if (!cleanId || !cleanSlug) return { ok: false, error: 'invalid_promote_args' };
    const wsKey = normWsKey(workspaceRoot);
    const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();

    const db = this._ensureDb();
    if (db) {
      try {
        const info = wsKey
          ? db.prepare('UPDATE project_instincts SET promoted_skill = ?, updated_at = ? WHERE id = ? AND ws_key = ?').run(cleanSlug, now, cleanId, wsKey)
          : db.prepare('UPDATE project_instincts SET promoted_skill = ?, updated_at = ? WHERE id = ?').run(cleanSlug, now, cleanId);
        return { ok: Number(info?.changes || 0) > 0, id: cleanId, skillSlug: cleanSlug };
      } catch {
        return { ok: false, id: cleanId, skillSlug: cleanSlug };
      }
    }

    let updated = false;
    this._updateFallbackDoc((doc) => {
      const keys = wsKey ? [wsKey] : Object.keys(doc.projectInstincts);
      for (const k of keys) {
        const arr = Array.isArray(doc.projectInstincts[k]) ? [...doc.projectInstincts[k]] : [];
        const idx = arr.findIndex((it) => it && it.id === cleanId);
        if (idx !== -1) {
          arr[idx] = { ...arr[idx], promotedSkill: cleanSlug, updatedAt: now };
          doc.projectInstincts[k] = arr;
          updated = true;
          break;
        }
      }
      return doc;
    });
    return { ok: updated, id: cleanId, skillSlug: cleanSlug };
  }

  deleteInstinct({ id = '', workspaceRoot = '' } = {}) {
    const cleanId = asStr(id).trim();
    if (!cleanId) return { ok: false, deleted: false, error: 'invalid_instinct_id' };
    const wsKey = normWsKey(workspaceRoot);
    const db = this._ensureDb();
    if (db) {
      try {
        const info = wsKey
          ? db.prepare('DELETE FROM project_instincts WHERE id = ? AND ws_key = ?').run(cleanId, wsKey)
          : db.prepare('DELETE FROM project_instincts WHERE id = ?').run(cleanId);
        const deleted = Number(info?.changes || 0) > 0;
        return { ok: deleted, deleted, id: cleanId };
      } catch {
        return { ok: false, deleted: false, id: cleanId };
      }
    }
    let deleted = false;
    this._updateFallbackDoc((doc) => {
      const keys = wsKey ? [wsKey] : Object.keys(doc.projectInstincts);
      for (const k of keys) {
        const arr = Array.isArray(doc.projectInstincts[k]) ? doc.projectInstincts[k] : [];
        const next = arr.filter((it) => it && it.id !== cleanId);
        if (next.length !== arr.length) {
          doc.projectInstincts[k] = next;
          deleted = true;
          break;
        }
      }
      return doc;
    });
    return { ok: deleted, deleted, id: cleanId };
  }

  decayInstincts({ workspaceRoot = '', minKeepConfidence = 0.15, nowMs = Date.now() } = {}) {
    const wsKey = normWsKey(workspaceRoot);
    const minKeep = Math.max(0.01, Math.min(0.9, Number(minKeepConfidence ?? 0.15)));
    const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
    let removed = 0;

    const db = this._ensureDb();
    if (db) {
      try {
        const rows = wsKey
          ? db.prepare("SELECT id, confidence, updated_at FROM project_instincts WHERE ws_key = ? AND promoted_skill = ''").all(wsKey)
          : db.prepare("SELECT id, confidence, updated_at FROM project_instincts WHERE promoted_skill = ''").all();
        const delStmt = db.prepare('DELETE FROM project_instincts WHERE id = ?');
        db.exec('BEGIN IMMEDIATE;');
        try {
          for (const r of rows) {
            if (this._computeDecayedConfidence(r.confidence, r.updated_at, now) < minKeep) {
              delStmt.run(r.id);
              removed++;
            }
          }
          db.exec('COMMIT;');
        } catch (err) {
          try { db.exec('ROLLBACK;'); } catch {}
          throw err;
        }
        return { ok: true, removed };
      } catch {
        return { ok: false, removed: 0 };
      }
    }

    this._updateFallbackDoc((doc) => {
      const keys = wsKey ? [wsKey] : Object.keys(doc.projectInstincts);
      for (const k of keys) {
        const arr = Array.isArray(doc.projectInstincts[k]) ? doc.projectInstincts[k] : [];
        const kept = arr.filter((it) => {
          if (!it) return false;
          if (it.promotedSkill) return true;
          const eff = this._computeDecayedConfidence(it.confidence, it.updatedAt, now);
          if (eff < minKeep) {
            removed++;
            return false;
          }
          return true;
        });
        doc.projectInstincts[k] = kept;
      }
      return doc;
    });
    return { ok: true, removed };
  }

  // --------------------------------------------------------------------------
  // 5. Headroom Reversible Compression Store (CCR + SmartCrumb)
  // --------------------------------------------------------------------------

  storeCcrBlob({
    text = '',
    workspaceRoot = '',
    source = 'terminal',
    commandHint = '',
    compressedChars = 0,
    ttlMs = 30 * 60 * 1000,
    maxEntries = 200,
    maxTotalBytes = 16 * 1024 * 1024,
    nowMs = Date.now(),
  } = {}) {
    const rawStr = asStr(text);
    if (!rawStr) return { ok: false, error: 'empty_blob' };
    const redacted = redactSecretsInText(rawStr).slice(0, 4 * 1024 * 1024);
    const originalChars = redacted.length;
    const originalLines = redacted.split(/\r?\n/).length;
    const compChars = clampInt(compressedChars, 0, originalChars, 0);
    const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
    const safeTtl = clampInt(ttlMs, 1000, 7 * 24 * 60 * 60 * 1000, 30 * 60 * 1000);
    const expiresAt = now + safeTtl;
    const safeMaxEntries = clampInt(maxEntries, 5, 2000, 200);
    const safeMaxBytes = clampInt(maxTotalBytes, 65536, 128 * 1024 * 1024, 16 * 1024 * 1024);
    const wsKey = normWsKey(workspaceRoot);
    const cleanSource = asStr(source, 'terminal').trim().slice(0, 40) || 'terminal';
    const cleanCmd = redactSecretsInText(asStr(commandHint)).replace(/\s+/g, ' ').trim().slice(0, 220);
    const hash = createHash('sha256').update(redacted).digest('hex').slice(0, 16);

    const db = this._ensureDb();
    if (db) {
      try {
        db.exec('BEGIN IMMEDIATE;');
        try {
          db.prepare('DELETE FROM ccr_blobs WHERE expires_at < ?').run(now);
          db.prepare(`
            INSERT INTO ccr_blobs (hash, ws_key, source, command_hint, original_text, original_chars, original_lines, compressed_chars, created_at, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(hash) DO UPDATE SET
              ws_key = excluded.ws_key,
              source = excluded.source,
              command_hint = excluded.command_hint,
              original_text = excluded.original_text,
              original_chars = excluded.original_chars,
              original_lines = excluded.original_lines,
              compressed_chars = excluded.compressed_chars,
              created_at = excluded.created_at,
              expires_at = excluded.expires_at
          `).run(hash, wsKey, cleanSource, cleanCmd, redacted, originalChars, originalLines, compChars, now, expiresAt);

          db.prepare(`
            DELETE FROM ccr_blobs WHERE hash NOT IN (
              SELECT hash FROM ccr_blobs ORDER BY created_at DESC LIMIT ?
            )
          `).run(safeMaxEntries);

          const rowsByAge = db.prepare('SELECT hash, original_chars FROM ccr_blobs ORDER BY created_at DESC').all();
          let accBytes = 0;
          const overQuotaHashes = [];
          for (const r of rowsByAge) {
            const sz = Number(r.original_chars || 0);
            if (accBytes + sz > safeMaxBytes && accBytes > 0) {
              overQuotaHashes.push(r.hash);
            } else {
              accBytes += sz;
            }
          }
          if (overQuotaHashes.length > 0) {
            const delStmt = db.prepare('DELETE FROM ccr_blobs WHERE hash = ?');
            for (const h of overQuotaHashes) delStmt.run(h);
          }
          db.exec('COMMIT;');
        } catch (err) {
          try { db.exec('ROLLBACK;'); } catch {}
          throw err;
        }
        return { ok: true, hash, originalChars, originalLines, compressedChars: compChars, expiresAt };
      } catch (err) {
        return { ok: false, error: err?.message || 'sqlite_ccr_store_error' };
      }
    }

    this._updateFallbackDoc((doc) => {
      const map = asObj(doc.ccrBlobs);
      for (const [k, v] of Object.entries(map)) {
        if (!v || Number(v.expiresAt || 0) < now) delete map[k];
      }
      map[hash] = {
        hash,
        wsKey,
        source: cleanSource,
        commandHint: cleanCmd,
        originalText: redacted,
        originalChars,
        originalLines,
        compressedChars: compChars,
        createdAt: now,
        expiresAt,
      };
      const sorted = Object.values(map).sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
      const kept = {};
      let totalBytes = 0;
      for (const item of sorted) {
        if (Object.keys(kept).length >= safeMaxEntries) break;
        const sz = Number(item.originalChars || 0);
        if (totalBytes + sz > safeMaxBytes && totalBytes > 0) continue;
        totalBytes += sz;
        kept[item.hash] = item;
      }
      doc.ccrBlobs = kept;
      return doc;
    });
    return { ok: true, hash, originalChars, originalLines, compressedChars: compChars, expiresAt };
  }

  retrieveCcrBlob({
    hash = '',
    query = '',
    startLine = 1,
    endLine = 0,
    maxChars = 6000,
    nowMs = Date.now(),
  } = {}) {
    const cleanHash = asStr(hash).trim().toLowerCase();
    if (!/^[a-f0-9]{12,64}$/.test(cleanHash)) {
      return { ok: false, error: 'invalid_hash_format' };
    }
    const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
    const safeMaxChars = clampInt(maxChars, 250, 32000, 6000);
    let record = null;

    const db = this._ensureDb();
    if (db) {
      try {
        const row = db.prepare('SELECT * FROM ccr_blobs WHERE hash = ?').get(cleanHash);
        if (!row) return { ok: false, error: 'not_found_or_expired' };
        if (Number(row.expires_at || 0) < now) {
          try { db.prepare('DELETE FROM ccr_blobs WHERE hash = ?').run(cleanHash); } catch {}
          return { ok: false, error: 'not_found_or_expired' };
        }
        record = {
          hash: asStr(row.hash),
          source: asStr(row.source, 'terminal'),
          commandHint: asStr(row.command_hint),
          originalText: asStr(row.original_text),
          originalChars: Number(row.original_chars || 0),
          originalLines: Number(row.original_lines || 0),
        };
      } catch (err) {
        return { ok: false, error: err?.message || 'sqlite_ccr_read_error' };
      }
    } else {
      const doc = this._readFallbackDoc();
      const entry = Object.hasOwn(doc.ccrBlobs, cleanHash) ? doc.ccrBlobs[cleanHash] : null;
      if (!entry || Number(entry.expiresAt || 0) < now) {
        if (entry) {
          this._updateFallbackDoc((latest) => {
            const latestEntry = Object.hasOwn(latest.ccrBlobs, cleanHash) ? latest.ccrBlobs[cleanHash] : null;
            if (latestEntry && Number(latestEntry.expiresAt || 0) < now) {
              delete latest.ccrBlobs[cleanHash];
            }
            return latest;
          });
        }
        return { ok: false, error: 'not_found_or_expired' };
      }
      record = {
        hash: asStr(entry.hash),
        source: asStr(entry.source, 'terminal'),
        commandHint: asStr(entry.commandHint),
        originalText: asStr(entry.originalText),
        originalChars: Number(entry.originalChars || 0),
        originalLines: Number(entry.originalLines || 0),
      };
    }

    const lines = record.originalText.split(/\r?\n/);
    const totalLines = lines.length;
    const cleanQuery = asStr(query).trim().slice(0, 120);
    let outLines = [];
    let returnedStartLine = 1;
    let returnedEndLine = 0;
    let matchCount = 0;
    let truncated = false;

    if (cleanQuery) {
      let matcher = null;
      let usingRegex = false;
      const lowerQ = cleanQuery.toLowerCase();
      const substrMatcher = (ln) => ln.toLowerCase().includes(lowerQ);
      const rxLiteralMatch = /^\/(.+)\/([imsu]*)$/.exec(cleanQuery);
      const rawRegexPattern = cleanQuery.startsWith('re:') ? cleanQuery.slice(3).trim() : (rxLiteralMatch ? rxLiteralMatch[1] : '');
      const rawRegexFlags = rxLiteralMatch ? rxLiteralMatch[2].replace(/g/g, '') : 'i';
      if (
        rawRegexPattern &&
        rawRegexPattern.length <= 80 &&
        !/\([^)]*(?:[+*]|\{[0-9,])[^)]*\)[+*?{]|\([^)]*\|[^)]*\)[+*?{]/.test(rawRegexPattern)
      ) {
        try {
          const rx = new RegExp(rawRegexPattern, rawRegexFlags.includes('i') ? rawRegexFlags : `${rawRegexFlags}i`);
          matcher = (ln) => rx.test(String(ln || '').slice(0, 2000));
          usingRegex = true;
        } catch {
          matcher = null;
        }
      }
      if (!matcher) {
        matcher = substrMatcher;
      }

      const selectedIdx = new Set();
      const regexDeadline = Date.now() + 40;
      for (let i = 0; i < totalLines; i++) {
        if (usingRegex && (i & 31) === 0 && Date.now() > regexDeadline) {
          usingRegex = false;
          matcher = substrMatcher;
        }
        if (matcher(lines[i])) {
          matchCount += 1;
          const from = Math.max(0, i - 2);
          const to = Math.min(totalLines - 1, i + 2);
          for (let j = from; j <= to; j++) selectedIdx.add(j);
        }
      }
      const sortedIdx = Array.from(selectedIdx).sort((a, b) => a - b);
      if (sortedIdx.length > 0) {
        returnedStartLine = sortedIdx[0] + 1;
        let prev = -1;
        let charCount = 0;
        for (const idx of sortedIdx) {
          const gapLine = prev !== -1 && idx - prev > 1 ? `... (${idx - prev - 1} lines omitted) ...` : '';
          const fmtLine = `L${idx + 1}: ${lines[idx]}`;
          const addLen = (gapLine ? gapLine.length + 1 : 0) + fmtLine.length + 1;
          if (charCount + addLen > safeMaxChars && outLines.length > 0) {
            truncated = true;
            break;
          }
          if (gapLine) {
            outLines.push(gapLine);
            charCount += gapLine.length + 1;
          }
          outLines.push(fmtLine);
          charCount += fmtLine.length + 1;
          returnedEndLine = idx + 1;
          prev = idx;
        }
      } else {
        returnedStartLine = 0;
        returnedEndLine = 0;
      }
    } else {
      const s = clampInt(startLine, 1, Math.max(1, totalLines), 1);
      const defaultEnd = Math.min(totalLines, s + 119);
      const requestedEnd = Number(endLine) > 0 ? clampInt(endLine, s, totalLines, defaultEnd) : defaultEnd;
      returnedStartLine = s;
      let charCount = 0;
      for (let idx = s - 1; idx < requestedEnd; idx++) {
        const fmtLine = `L${idx + 1}: ${lines[idx]}`;
        if (charCount + fmtLine.length + 1 > safeMaxChars && outLines.length > 0) {
          truncated = true;
          break;
        }
        outLines.push(fmtLine);
        charCount += fmtLine.length + 1;
        returnedEndLine = idx + 1;
      }
      if (requestedEnd < totalLines) truncated = true;
    }

    return {
      ok: true,
      hash: record.hash,
      source: record.source,
      commandHint: record.commandHint,
      totalLines,
      totalChars: record.originalChars || record.originalText.length,
      returnedStartLine,
      returnedEndLine,
      matchCount,
      truncated,
      text: outLines.join('\n'),
    };
  }

  pruneExpiredCcrBlobs({ nowMs = Date.now(), maxEntries = 200 } = {}) {
    const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
    const safeMax = clampInt(maxEntries, 5, 2000, 200);
    const db = this._ensureDb();
    if (db) {
      try {
        const expInfo = db.prepare('DELETE FROM ccr_blobs WHERE expires_at < ?').run(now);
        const capInfo = db.prepare(`
          DELETE FROM ccr_blobs WHERE hash NOT IN (
            SELECT hash FROM ccr_blobs ORDER BY created_at DESC LIMIT ?
          )
        `).run(safeMax);
        return { ok: true, removed: Number(expInfo?.changes || 0) + Number(capInfo?.changes || 0) };
      } catch {
        return { ok: false, removed: 0 };
      }
    }
    let removed = 0;
    this._updateFallbackDoc((doc) => {
      const entries = Object.values(asObj(doc.ccrBlobs));
      const alive = entries
        .filter((e) => e && Number(e.expiresAt || 0) >= now)
        .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
      const kept = {};
      for (const item of alive.slice(0, safeMax)) kept[item.hash] = item;
      removed = Math.max(0, entries.length - Object.keys(kept).length);
      doc.ccrBlobs = kept;
      return doc;
    });
    return { ok: true, removed };
  }

  // --------------------------------------------------------------------------
  // 6. 3-Layer Episodic Session Memory (claude-mem + RooFlow decision_log)
  // --------------------------------------------------------------------------

  _normalizeEpisodeRow(row) {
    if (!row) return null;
    let decisions = [];
    let touchedFiles = [];
    let stems = [];
    try {
      decisions = Array.isArray(row.decisions) ? row.decisions : JSON.parse(asStr(row.decisions_json, '[]'));
    } catch {}
    try {
      touchedFiles = Array.isArray(row.touchedFiles) ? row.touchedFiles : JSON.parse(asStr(row.touched_files_json, '[]'));
    } catch {}
    try {
      stems = Array.isArray(row.stems) ? row.stems : JSON.parse(asStr(row.stems_json, '[]'));
    } catch {}
    return {
      id: asStr(row.id),
      wsKey: asStr(row.ws_key ?? row.wsKey),
      conversationId: asStr(row.conversation_id ?? row.conversationId),
      title: asStr(row.title),
      kind: asStr(row.kind, 'session'),
      summary: asStr(row.summary),
      decisions: Array.isArray(decisions) ? decisions : [],
      touchedFiles: Array.isArray(touchedFiles) ? touchedFiles : [],
      stems: Array.isArray(stems) ? stems : [],
      estTokens: Number(row.est_tokens ?? row.estTokens ?? 0),
      createdAt: Number(row.created_at ?? row.createdAt ?? 0),
      updatedAt: Number(row.updated_at ?? row.updatedAt ?? 0),
    };
  }

  _toEpisodeIndexRow(ep, score = 0) {
    const dt = new Date(ep.updatedAt || ep.createdAt || Date.now());
    const mm = String(dt.getMonth() + 1).padStart(2, '0');
    const dd = String(dt.getDate()).padStart(2, '0');
    return {
      id: ep.id,
      shortId: ep.id.slice(0, 6),
      date: `${mm}-${dd}`,
      kind: ep.kind,
      title: ep.title,
      files: ep.touchedFiles.slice(0, 4),
      estTokens: ep.estTokens,
      score: Number(score.toFixed(3)),
      updatedAt: ep.updatedAt,
    };
  }

  recordSessionEpisode({
    workspaceRoot = '',
    conversationId = '',
    title = '',
    kind = 'session',
    summary = '',
    decisions = [],
    touchedFiles = [],
    nowMs = Date.now(),
  } = {}) {
    const wsKey = normWsKey(workspaceRoot);
    if (!wsKey) return { ok: false, error: 'invalid_workspace' };
    const VALID_KINDS = new Set(['session', 'decision', 'bugfix', 'feature', 'refactor', 'discovery']);
    const cleanKind = VALID_KINDS.has(asStr(kind).trim().toLowerCase())
      ? asStr(kind).trim().toLowerCase()
      : 'session';
    const cleanConvo = asStr(conversationId).trim().slice(0, 120);
    const cleanTitle = redactSecretsInText(asStr(title)).replace(/\s+/g, ' ').trim().slice(0, 160);
    const cleanSummary = redactSecretsInText(asStr(summary)).replace(/\s+/g, ' ').trim().slice(0, 1600);
    const cleanDecisions = (Array.isArray(decisions) ? decisions : [])
      .slice(0, 10)
      .map((d) => redactSecretsInText(asStr(d)).replace(/\s+/g, ' ').trim().slice(0, 220))
      .filter(Boolean);
    const cleanFiles = (Array.isArray(touchedFiles) ? touchedFiles : [])
      .slice(0, 12)
      .map((f) => asStr(f).replace(/\\/g, '/').trim().slice(0, 180))
      .filter(Boolean);

    if (!cleanTitle && !cleanSummary && cleanDecisions.length === 0 && cleanFiles.length === 0) {
      return { ok: false, error: 'empty_episode' };
    }
    const finalTitle = cleanTitle || cleanSummary.slice(0, 96) || cleanFiles.slice(0, 2).join(', ');
    const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
    const stems = extractSearchStems(`${finalTitle} ${cleanSummary} ${cleanDecisions.join(' ')}`, cleanFiles);
    const decisionsJson = JSON.stringify(cleanDecisions);
    const filesJson = JSON.stringify(cleanFiles);
    const stemsJson = JSON.stringify(stems);
    const estTokens = Math.max(12, Math.ceil((finalTitle.length + cleanSummary.length + decisionsJson.length) / 3.8));
    const seed = cleanConvo && cleanKind === 'session'
      ? `${wsKey}|session|${cleanConvo}`
      : `${wsKey}|${cleanKind}|${cleanConvo}|${finalTitle}|${now}`;
    const id = createHash('sha1').update(seed).digest('hex').slice(0, 16);

    const db = this._ensureDb();
    if (db) {
      try {
        let existingId = '';
        if (cleanConvo && cleanKind === 'session') {
          const hit = db
            .prepare("SELECT id FROM session_episodes WHERE ws_key = ? AND conversation_id = ? AND kind = 'session' LIMIT 1")
            .get(wsKey, cleanConvo);
          if (hit?.id) existingId = asStr(hit.id);
        }
        if (existingId) {
          db.prepare(`
            UPDATE session_episodes
            SET title = ?, summary = ?, decisions_json = ?, touched_files_json = ?, stems_json = ?, est_tokens = ?, updated_at = ?
            WHERE id = ?
          `).run(finalTitle, cleanSummary, decisionsJson, filesJson, stemsJson, estTokens, now, existingId);
          return { ok: true, id: existingId, updated: true };
        }

        db.prepare(`
          INSERT INTO session_episodes (id, ws_key, conversation_id, title, kind, summary, decisions_json, touched_files_json, stems_json, est_tokens, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, wsKey, cleanConvo, finalTitle, cleanKind, cleanSummary, decisionsJson, filesJson, stemsJson, estTokens, now, now);

        db.prepare(`
          DELETE FROM session_episodes
          WHERE ws_key = ? AND id NOT IN (
            SELECT id FROM session_episodes WHERE ws_key = ? ORDER BY updated_at DESC LIMIT 120
          )
        `).run(wsKey, wsKey);
        return { ok: true, id, updated: false };
      } catch (err) {
        return { ok: false, error: err?.message || 'sqlite_episode_error' };
      }
    }

    let outcome = null;
    this._updateFallbackDoc((doc) => {
      const list = Array.isArray(doc.sessionEpisodes[wsKey]) ? [...doc.sessionEpisodes[wsKey]] : [];
      const existingIdx = cleanConvo && cleanKind === 'session'
        ? list.findIndex((it) => it && it.conversationId === cleanConvo && it.kind === 'session')
        : -1;
      if (existingIdx !== -1) {
        const prev = list[existingIdx];
        list[existingIdx] = {
          ...prev,
          title: finalTitle,
          summary: cleanSummary,
          decisions: cleanDecisions,
          touchedFiles: cleanFiles,
          stems,
          estTokens,
          updatedAt: now,
        };
        doc.sessionEpisodes[wsKey] = list;
        outcome = { ok: true, id: asStr(prev.id), updated: true };
        return doc;
      }
      list.push({
        id,
        wsKey,
        conversationId: cleanConvo,
        title: finalTitle,
        kind: cleanKind,
        summary: cleanSummary,
        decisions: cleanDecisions,
        touchedFiles: cleanFiles,
        stems,
        estTokens,
        createdAt: now,
        updatedAt: now,
      });
      list.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
      doc.sessionEpisodes[wsKey] = list.slice(0, 120);
      outcome = { ok: true, id, updated: false };
      return doc;
    });
    return outcome || { ok: false, error: 'fallback_episode_error' };
  }

  _loadEpisodesForWorkspace(wsKey) {
    const db = this._ensureDb();
    if (db) {
      try {
        const rows = wsKey
          ? db.prepare('SELECT * FROM session_episodes WHERE ws_key = ? ORDER BY updated_at DESC LIMIT 120').all(wsKey)
          : db.prepare('SELECT * FROM session_episodes ORDER BY updated_at DESC LIMIT 120').all();
        return rows.map((r) => this._normalizeEpisodeRow(r)).filter(Boolean);
      } catch {
        return [];
      }
    }
    const doc = this._readFallbackDoc();
    const rawList = wsKey
      ? (Array.isArray(doc.sessionEpisodes[wsKey]) ? doc.sessionEpisodes[wsKey] : [])
      : Object.values(doc.sessionEpisodes).flat().filter(Boolean);
    return rawList
      .map((r) => this._normalizeEpisodeRow(r))
      .filter(Boolean)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 120);
  }

  searchSessionEpisodes({ workspaceRoot = '', query = '', kind = '', limit = 8 } = {}) {
    const wsKey = normWsKey(workspaceRoot);
    const cleanKind = asStr(kind).trim().toLowerCase();
    const maxItems = clampInt(limit, 1, 50, 8);
    const episodes = this._loadEpisodesForWorkspace(wsKey)
      .filter((ep) => !cleanKind || ep.kind === cleanKind);

    const cleanQuery = asStr(query).trim();
    if (!cleanQuery) {
      return {
        ok: true,
        items: episodes.slice(0, maxItems).map((ep, idx) => this._toEpisodeIndexRow(ep, Math.max(0.1, 1 - idx * 0.05))),
      };
    }

    const qStems = extractSearchStems(cleanQuery);
    const qLower = cleanQuery.toLowerCase();
    const scored = [];
    for (const ep of episodes) {
      const epStemSet = new Set(ep.stems);
      let hits = 0;
      for (const s of qStems) {
        if (epStemSet.has(s)) hits += 1;
      }
      const hay = `${ep.title} ${ep.summary} ${ep.decisions.join(' ')} ${ep.touchedFiles.join(' ')}`.toLowerCase();
      if (hay.includes(qLower)) hits += 2;
      if (hits <= 0) continue;
      const denom = Math.max(1, qStems.length);
      const ageDays = Math.max(0, (Date.now() - ep.updatedAt) / 86_400_000);
      const recencyBoost = 1 / (1 + ageDays * 0.08);
      const score = (hits / denom) * 0.8 + recencyBoost * 0.2;
      scored.push({ ep, score });
    }
    scored.sort((a, b) => b.score - a.score || b.ep.updatedAt - a.ep.updatedAt);
    return {
      ok: true,
      items: scored.slice(0, maxItems).map(({ ep, score }) => this._toEpisodeIndexRow(ep, score)),
    };
  }

  getSessionEpisodeTimeline({ workspaceRoot = '', anchorId = '', before = 2, after = 2 } = {}) {
    const wsKey = normWsKey(workspaceRoot);
    const cleanAnchor = asStr(anchorId).trim();
    if (!cleanAnchor) return { ok: false, error: 'missing_anchor_id', items: [] };
    const episodes = this._loadEpisodesForWorkspace(wsKey)
      .sort((a, b) => a.updatedAt - b.updatedAt || a.createdAt - b.createdAt);
    const idx = episodes.findIndex((ep) => ep.id === cleanAnchor || ep.id.startsWith(cleanAnchor));
    if (idx === -1) return { ok: false, error: 'anchor_not_found', anchorId: cleanAnchor, items: [] };
    const from = Math.max(0, idx - clampInt(before, 0, 10, 2));
    const to = Math.min(episodes.length - 1, idx + clampInt(after, 0, 10, 2));
    const items = episodes.slice(from, to + 1).map((ep) => ({
      ...this._toEpisodeIndexRow(ep, ep.id === episodes[idx].id ? 1 : 0.5),
      isAnchor: ep.id === episodes[idx].id,
      summaryPreview: ep.summary.slice(0, 180),
      decisionsCount: ep.decisions.length,
    }));
    return { ok: true, anchorId: episodes[idx].id, items };
  }

  getSessionEpisodesByIds({ workspaceRoot = '', ids = [] } = {}) {
    const wsKey = normWsKey(workspaceRoot);
    const targetIds = (Array.isArray(ids) ? ids : [ids])
      .map((x) => asStr(x).trim())
      .filter(Boolean)
      .slice(0, 20);
    if (targetIds.length === 0) return { ok: true, items: [] };
    const episodes = this._loadEpisodesForWorkspace(wsKey);
    const items = [];
    for (const target of targetIds) {
      const hit = episodes.find((ep) => ep.id === target || ep.id.startsWith(target));
      if (hit && !items.some((x) => x.id === hit.id)) {
        items.push({
          id: hit.id,
          conversationId: hit.conversationId,
          kind: hit.kind,
          title: hit.title,
          summary: hit.summary,
          decisions: hit.decisions,
          touchedFiles: hit.touchedFiles,
          estTokens: hit.estTokens,
          createdAt: hit.createdAt,
          updatedAt: hit.updatedAt,
        });
      }
    }
    return { ok: true, items };
  }

  formatSessionMemoryIndexForStart(workspaceRoot = '', { limit = 5, maxChars = 480 } = {}) {
    const res = this.searchSessionEpisodes({ workspaceRoot, limit });
    const items = Array.isArray(res?.items) ? res.items : [];
    if (items.length === 0) return '';
    const cap = clampInt(maxChars, 140, 1200, 480);
    const lines = ['### Episodic Memory Index (recall: ram_memory_recall)'];
    for (const it of items) {
      const topFiles = it.files.slice(0, 2).map((f) => basename(f)).join(', ');
      const filePart = topFiles ? ` (${topFiles})` : '';
      const shortTitle = it.title.length > 56 ? `${it.title.slice(0, 53)}...` : it.title;
      const line = `- [#${it.shortId} ${it.date} | ${it.kind}] ${shortTitle}${filePart} (~${it.estTokens}t)`;
      if (lines.join('\n').length + line.length + 1 > cap) break;
      lines.push(line);
    }
    return lines.length > 1 ? lines.join('\n') : '';
  }

  getStats(wsPath = '') {
    const wsKey = normWsKey(wsPath);
    const db = this._ensureDb();
    if (db) {
      try {
        const repairRow = wsKey
          ? db.prepare('SELECT COUNT(*) AS cnt FROM repair_kv_snapshots WHERE ws_key = ?').get(wsKey)
          : db.prepare('SELECT COUNT(*) AS cnt FROM repair_kv_snapshots').get();
        const astRow = wsKey
          ? db.prepare('SELECT COUNT(*) AS cnt FROM ast_meta_cache WHERE ws_key = ?').get(wsKey)
          : db.prepare('SELECT COUNT(*) AS cnt FROM ast_meta_cache').get();
        const recRow = wsKey
          ? db.prepare('SELECT COUNT(*) AS cnt FROM victory_recipes WHERE ws_key = ?').get(wsKey)
          : db.prepare('SELECT COUNT(*) AS cnt FROM victory_recipes').get();
        const fedRow = wsKey
          ? db.prepare('SELECT COUNT(*) AS cnt FROM repo_federation WHERE primary_ws_key = ?').get(wsKey)
          : db.prepare('SELECT COUNT(*) AS cnt FROM repo_federation').get();
        const instRow = wsKey
          ? db.prepare('SELECT COUNT(*) AS cnt FROM project_instincts WHERE ws_key = ?').get(wsKey)
          : db.prepare('SELECT COUNT(*) AS cnt FROM project_instincts').get();
        const ccrRow = wsKey
          ? db.prepare('SELECT COUNT(*) AS cnt FROM ccr_blobs WHERE ws_key = ?').get(wsKey)
          : db.prepare('SELECT COUNT(*) AS cnt FROM ccr_blobs').get();
        const epRow = wsKey
          ? db.prepare('SELECT COUNT(*) AS cnt FROM session_episodes WHERE ws_key = ?').get(wsKey)
          : db.prepare('SELECT COUNT(*) AS cnt FROM session_episodes').get();
        return {
          ok: true,
          backend: this.backend,
          dbPath: this.dbPath,
          repairBucketsCount: Number(repairRow?.cnt || 0),
          astCachedFilesCount: Number(astRow?.cnt || 0),
          recipesCount: Number(recRow?.cnt || 0),
          federatedCount: Number(fedRow?.cnt || 0),
          instinctsCount: Number(instRow?.cnt || 0),
          ccrBlobsCount: Number(ccrRow?.cnt || 0),
          sessionEpisodesCount: Number(epRow?.cnt || 0),
        };
      } catch {}
    }

    const doc = this._readFallbackDoc();
    return {
      ok: true,
      backend: this.backend,
      dbPath: this.dbPath,
      repairBucketsCount: wsKey ? Object.keys(asObj(doc.repairBuckets[wsKey])).length : Object.keys(doc.repairBuckets).length,
      astCachedFilesCount: wsKey ? Object.keys(asObj(doc.astMeta[wsKey])).length : Object.keys(doc.astMeta).length,
      recipesCount: wsKey && Array.isArray(doc.victoryRecipes[wsKey]) ? doc.victoryRecipes[wsKey].length : 0,
      federatedCount: wsKey && Array.isArray(doc.federation[wsKey]) ? doc.federation[wsKey].length : 0,
      instinctsCount: wsKey && Array.isArray(doc.projectInstincts[wsKey]) ? doc.projectInstincts[wsKey].length : 0,
      ccrBlobsCount: wsKey
        ? Object.values(asObj(doc.ccrBlobs)).filter((b) => b && b.wsKey === wsKey).length
        : Object.keys(asObj(doc.ccrBlobs)).length,
      sessionEpisodesCount: wsKey && Array.isArray(doc.sessionEpisodes[wsKey]) ? doc.sessionEpisodes[wsKey].length : 0,
    };
  }
}

export const knowledgeHub = new SqliteKnowledgeHub();

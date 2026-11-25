/**
 * @file skill-registry-bridge.mjs
 * @description Local-first skill discovery & quarantined external import bridge (inspired by vercel-labs/skills `find-skills`).
 * Enforces strict path/slug validation, AgentShield scanning (trojan BiDi, secrets, prompt injection),
 * and Skill-Architect Negative Transfer & sibling collision checks before any SKILL.md lands in `skills/`.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanSkillFile } from './agent-shield.mjs';
import { ensureTunnelCacheDir, resolveTunnelCacheDir } from './cache-dir.mjs';
import { expandRuQueryToEnTerms } from './ru-en-lexicon.mjs';
import { auditSkill, DEFAULT_SKILLS_ROOT, parseYamlFrontmatter } from '../skills/skill-architect/scripts/audit-skill.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, '..');

const SKILL_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const REPO_SLUG_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty']);
const MAX_QUARANTINE_FILE_BYTES = 512 * 1024;
const FORBIDDEN_BINARY_EXT_RE = /\.(?:exe|dll|so|dylib|bat|cmd|ps1|bin|wasm|node|zip|tar|gz)$/i;
const LOCAL_SKILL_MD_CACHE = new Map();
const MAX_SKILL_MD_CACHE = 64;

export function validateSkillSlug(raw = '') {
  const s = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!s || UNSAFE_KEYS.has(s) || !SKILL_SLUG_RE.test(s)) return '';
  return s;
}

export function validateRepoSlug(raw = '') {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s || s.includes('..') || !REPO_SLUG_RE.test(s)) return '';
  return s;
}

function tokenizeQuery(query = '') {
  const raw = String(query || '').trim().toLowerCase();
  const ruExp = expandRuQueryToEnTerms(raw, { maxTerms: 20 });
  const baseTokens = raw.split(/[^a-zа-яё0-9-]+/i).filter((t) => t.length >= 2);
  return Array.from(new Set([...baseTokens, ...(ruExp.enTerms || []).map((t) => t.toLowerCase())]));
}

function collectLocalSkills(skillsRoots = []) {
  const entries = [];
  const seen = new Set();

  for (const root of skillsRoots) {
    if (!root || !existsSync(root)) continue;
    let dirs = [];
    try {
      dirs = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const slug = validateSkillSlug(d.name);
      if (!slug || seen.has(slug)) continue;
      const mdPath = join(root, d.name, 'SKILL.md');
      if (!existsSync(mdPath)) continue;
      try {
        const st = statSync(mdPath);
        const cached = LOCAL_SKILL_MD_CACHE.get(mdPath);
        let entry = null;
        if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
          entry = cached.entry;
        } else {
          const raw = readFileSync(mdPath, 'utf8');
          const fm = parseYamlFrontmatter(raw);
          entry = {
            slug,
            name: fm.name || slug,
            description: fm.description || '',
            skillDir: join(root, d.name),
            source: 'local',
            alreadyInstalled: true,
          };
          if (LOCAL_SKILL_MD_CACHE.size >= MAX_SKILL_MD_CACHE) {
            const oldestKey = LOCAL_SKILL_MD_CACHE.keys().next().value;
            if (oldestKey !== undefined) LOCAL_SKILL_MD_CACHE.delete(oldestKey);
          }
          LOCAL_SKILL_MD_CACHE.set(mdPath, { mtimeMs: st.mtimeMs, size: st.size, entry });
        }
        seen.add(slug);
        entries.push({ ...entry });
      } catch {}
    }
  }
  return entries;
}

/**
 * Searches local skills first (Merge-Over-Create) and optionally queries remote skills.sh / GitHub registries.
 */
export async function searchSkillsCatalog(opts = {}) {
  const {
    query = '',
    workspaceRoot = process.cwd(),
    skillsRoot = DEFAULT_SKILLS_ROOT,
    includeRemote = true,
    fetchImpl = globalThis.fetch,
    timeoutMs = 4500,
    limit = 8,
  } = opts && typeof opts === 'object' && !Array.isArray(opts) ? opts : {};
  const cleanQuery = String(query || '').trim();
  const tokens = tokenizeQuery(cleanQuery);
  const searchRoots = [resolve(skillsRoot)];
  if (workspaceRoot && existsSync(workspaceRoot)) {
    const seenRoots = new Set([searchRoots[0].toLowerCase()]);
    for (const cand of [
      resolve(workspaceRoot, '.agents', 'skills'),
      resolve(workspaceRoot, '.gemini', 'skills'),
      resolve(workspaceRoot, 'skills'),
    ]) {
      const k = cand.toLowerCase();
      if (!seenRoots.has(k)) {
        seenRoots.add(k);
        searchRoots.push(cand);
      }
    }
  }

  const localSkills = collectLocalSkills(searchRoots);
  const localSlugSet = new Set(localSkills.map((s) => s.slug));

  const scoreText = (text) => {
    const hay = String(text || '').toLowerCase();
    if (!tokens.length) return 1;
    let sc = 0;
    if (cleanQuery && hay.includes(cleanQuery.toLowerCase())) sc += 6;
    for (const tok of tokens) {
      if (hay.includes(tok)) sc += 2;
    }
    return sc;
  };

  const localMatches = localSkills
    .map((sk) => ({ ...sk, score: scoreText(`${sk.slug} ${sk.name} ${sk.description}`) }))
    .filter((sk) => (tokens.length === 0 ? true : sk.score > 0))
    .sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug))
    .slice(0, limit);

  let remoteMatches = [];
  let remoteError = '';
  let offlineFallback = false;

  if (includeRemote && cleanQuery && typeof fetchImpl === 'function') {
    const url = `https://skills.sh/api/search?q=${encodeURIComponent(cleanQuery)}&limit=${Math.min(20, Math.max(4, limit))}`;
    try {
      const resp = await fetchImpl(url, {
        headers: { Accept: 'application/json', 'User-Agent': 'antigravity-model-router/3.34.1' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!resp.ok) {
        remoteError = `http_${resp.status}`;
      } else {
        const data = await resp.json();
        const rawList = Array.isArray(data) ? data : (Array.isArray(data?.skills) ? data.skills : []);
        remoteMatches = rawList
          .slice(0, limit)
          .map((item) => {
            const slug = validateSkillSlug(item?.slug || item?.skillId || item?.name || '');
            const sourceRepo = validateRepoSlug(item?.source || item?.repo || item?.repository || '');
            const alreadyInstalled = Boolean(slug && localSlugSet.has(slug));
            return {
              slug: slug || String(item?.name || 'unknown').slice(0, 64),
              name: String(item?.name || slug || 'unknown'),
              sourceRepo,
              installs: Number(item?.installs || item?.stars || 0),
              description: String(item?.description || '').slice(0, 260),
              alreadyInstalled,
              mergeRecommended: alreadyInstalled,
              source: 'remote',
            };
          });
      }
    } catch (err) {
      offlineFallback = true;
      remoteError = String(err?.message || 'network_unavailable');
    }
  }

  return {
    ok: true,
    query: cleanQuery,
    localMatches,
    remoteMatches,
    remoteError,
    offlineFallback,
  };
}

function sanitizeRelativeSkillPath(relPath = '') {
  const norm = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '').trim();
  if (!norm || norm.includes('..') || norm.includes('\0') || /^[a-zA-Z]:/.test(norm)) return '';
  return norm;
}

function collectFilesRecursive(dirAbs, baseAbs = dirAbs, depth = 0, out = []) {
  if (depth > 4 || out.length >= 120 || !existsSync(dirAbs)) return out;
  let entries = [];
  try {
    entries = readdirSync(dirAbs, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    if (out.length >= 120) break;
    if (typeof ent.isSymbolicLink === 'function' && ent.isSymbolicLink()) continue;
    const full = join(dirAbs, ent.name);
    if (ent.isDirectory()) {
      collectFilesRecursive(full, baseAbs, depth + 1, out);
    } else if (ent.isFile()) {
      const rel = relative(baseAbs, full).replace(/\\/g, '/');
      if (rel) out.push({ fullPath: full, relPath: rel });
    }
  }
  return out;
}

/**
 * Stages a candidate skill in `.cache/skill-quarantine/` and runs AgentShield + Skill-Architect audits.
 */
export function quarantineAndAuditSkillCandidate(opts = {}) {
  const {
    slug = '',
    skillMarkdown = '',
    extraFiles = {},
    existingSkillsRoot = DEFAULT_SKILLS_ROOT,
    cacheDir = '',
    lang = 'ru',
  } = opts && typeof opts === 'object' && !Array.isArray(opts) ? opts : {};
  const isEn = String(lang || '').trim().toLowerCase() === 'en';
  const cleanSlug = validateSkillSlug(slug);
  if (!cleanSlug) {
    return { ok: false, approved: false, error: 'invalid_skill_slug', reasons: [isEn ? 'Invalid skill slug' : 'Некорректный slug навыка'] };
  }
  const mdText = typeof skillMarkdown === 'string' ? skillMarkdown : '';
  if (!mdText.trim()) {
    return { ok: false, approved: false, error: 'empty_skill_markdown', reasons: [isEn ? 'Empty SKILL.md' : 'Пустой SKILL.md'] };
  }

  const baseCache = ensureTunnelCacheDir(cacheDir ? resolve(cacheDir) : resolveTunnelCacheDir(PLUGIN_ROOT));
  const quarantineRoot = join(baseCache, 'skill-quarantine');
  const qDir = join(quarantineRoot, `${cleanSlug}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  mkdirSync(qDir, { recursive: true });

  const shieldFindings = [];
  const mdBytes = Buffer.byteLength(mdText, 'utf8');
  if (mdBytes > MAX_QUARANTINE_FILE_BYTES || mdText.includes('\0')) {
    shieldFindings.push({
      file: join(qDir, 'SKILL.md'),
      kind: 'skill',
      severity: 'critical',
      ruleId: 'skill_oversized_or_binary',
      message: isEn
        ? `SKILL.md exceeds ${Math.round(MAX_QUARANTINE_FILE_BYTES / 1024)} KB limit or contains binary data`
        : `SKILL.md превышает лимит ${Math.round(MAX_QUARANTINE_FILE_BYTES / 1024)} КБ или содержит бинарные данные`,
      excerpt: '',
    });
  }

  const skillMdPath = join(qDir, 'SKILL.md');
  writeFileSync(skillMdPath, mdText.slice(0, MAX_QUARANTINE_FILE_BYTES), 'utf8');

  if (extraFiles && typeof extraFiles === 'object' && !Array.isArray(extraFiles)) {
    for (const [rawRel, content] of Object.entries(extraFiles)) {
      const safeRel = sanitizeRelativeSkillPath(rawRel);
      if (!safeRel || safeRel.toUpperCase() === 'SKILL.MD') continue;
      if (FORBIDDEN_BINARY_EXT_RE.test(safeRel)) {
        shieldFindings.push({
          file: safeRel,
          kind: 'skill',
          severity: 'critical',
          ruleId: 'skill_oversized_or_binary',
          message: isEn
            ? `Forbidden binary or executable attachment: ${safeRel}`
            : `Запрещённое бинарное или исполняемое вложение: ${safeRel}`,
          excerpt: safeRel,
        });
        continue;
      }
      if (content && typeof content === 'object' && !Buffer.isBuffer(content) && content.oversizedOrBinary) {
        shieldFindings.push({
          file: safeRel,
          kind: 'skill',
          severity: 'critical',
          ruleId: 'skill_oversized_or_binary',
          message: isEn
            ? `Attachment exceeds 512 KB or is binary: ${safeRel}`
            : `Вложение превышает 512 КБ или является бинарным: ${safeRel}`,
          excerpt: safeRel,
        });
        continue;
      }
      const isBuf = Buffer.isBuffer(content);
      const rawText = isBuf ? content.toString('utf8') : String(content ?? '');
      const hasNull = isBuf ? content.includes(0) : rawText.includes('\0');
      const byteSize = isBuf ? content.length : Buffer.byteLength(rawText, 'utf8');
      if (hasNull || byteSize > MAX_QUARANTINE_FILE_BYTES) {
        shieldFindings.push({
          file: safeRel,
          kind: 'skill',
          severity: 'critical',
          ruleId: 'skill_oversized_or_binary',
          message: isEn
            ? `Attachment ${safeRel} exceeds 512 KB or contains null bytes`
            : `Вложение ${safeRel} превышает 512 КБ или содержит нулевые байты`,
          excerpt: safeRel,
        });
        continue;
      }
      const dest = resolve(qDir, safeRel);
      if (!dest.startsWith(resolve(qDir) + sep)) continue;
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, rawText, 'utf8');
    }
  }

  // Scan ALL quarantined files (SKILL.md + scripts/* + references/* + evals/*), never SKILL.md alone
  const allQuarantinedFiles = collectFilesRecursive(qDir);
  for (const qFile of allQuarantinedFiles) {
    shieldFindings.push(...scanSkillFile(qFile.fullPath, { lang: isEn ? 'en' : 'ru' }));
  }
  const shieldBlocking = shieldFindings.filter((f) => f.severity === 'critical' || f.severity === 'high');
  const existingAbs = resolve(existingSkillsRoot || DEFAULT_SKILLS_ROOT);
  const skillAudit = auditSkill(qDir, { skillsRoot: existingAbs });

  const collisions = Array.isArray(skillAudit?.triggerEval?.collisions) ? skillAudit.triggerEval.collisions : [];
  const maxCollision = collisions.reduce((mx, c) => Math.max(mx, Number(c?.similarity || 0)), 0);

  const reasons = [];
  if (shieldBlocking.length > 0) {
    reasons.push(
      isEn
        ? `AgentShield blocked threat: ${Array.from(new Set(shieldBlocking.map((f) => f.ruleId))).join(', ')}`
        : `AgentShield заблокировал угрозу: ${Array.from(new Set(shieldBlocking.map((f) => f.ruleId))).join(', ')}`
    );
  }
  if ((skillAudit?.errorsCount || 0) > 0) {
    const ids = (skillAudit.findings || []).filter((f) => f.severity === 'error').map((f) => f.id).join(', ');
    reasons.push(
      isEn
        ? `Skill-Architect found errors (${skillAudit.errorsCount}): ${ids}`
        : `Skill-Architect обнаружил ошибки (${skillAudit.errorsCount}): ${ids}`
    );
  }
  if (maxCollision >= 0.55) {
    reasons.push(
      isEn
        ? `High trigger collision (>=0.55) with existing skills (${maxCollision})`
        : `Высокая коллизия триггеров (>=0.55) с существующими навыками (${maxCollision})`
    );
  }

  const approved = shieldBlocking.length === 0 && (skillAudit?.errorsCount || 0) === 0 && maxCollision < 0.55;

  return {
    ok: true,
    approved,
    slug: cleanSlug,
    quarantineDir: qDir,
    shieldFindings,
    shieldBlockingCount: shieldBlocking.length,
    skillAudit,
    maxCollision,
    reasons,
  };
}

/**
 * Installs a candidate skill only after passing quarantine security & Negative Transfer verification.
 */
export function installQuarantinedSkill(opts = {}) {
  const {
    quarantineDir = '',
    skillMarkdown = '',
    extraFiles = {},
    slug = '',
    targetSkillsDir = DEFAULT_SKILLS_ROOT,
    existingSkillsRoot = '',
    cacheDir = '',
    source = 'external',
    force = false,
    dryRun = false,
    lang = 'ru',
  } = opts && typeof opts === 'object' && !Array.isArray(opts) ? opts : {};
  const cleanSlug = validateSkillSlug(slug);
  if (!cleanSlug) {
    return { ok: false, installed: false, blocked: true, error: 'invalid_skill_slug' };
  }

  let md = typeof skillMarkdown === 'string' ? skillMarkdown : '';
  const mergedExtra =
    extraFiles && typeof extraFiles === 'object' && !Array.isArray(extraFiles) ? { ...extraFiles } : {};
  if (!md && quarantineDir && existsSync(join(quarantineDir, 'SKILL.md'))) {
    md = readFileSync(join(quarantineDir, 'SKILL.md'), 'utf8');
    if (Object.keys(mergedExtra).length === 0) {
      for (const f of collectFilesRecursive(quarantineDir)) {
        if (f.relPath.toUpperCase() === 'SKILL.MD') continue;
        try {
          const st = statSync(f.fullPath);
          if (FORBIDDEN_BINARY_EXT_RE.test(f.relPath) || st.size > MAX_QUARANTINE_FILE_BYTES) {
            mergedExtra[f.relPath] = { oversizedOrBinary: true };
          } else {
            mergedExtra[f.relPath] = readFileSync(f.fullPath);
          }
        } catch {}
      }
    }
  }

  const audit = quarantineAndAuditSkillCandidate({
    slug: cleanSlug,
    skillMarkdown: md,
    extraFiles: mergedExtra,
    existingSkillsRoot: existingSkillsRoot || targetSkillsDir,
    cacheDir,
    lang,
  });

  const cleanupQuarantine = (dir) => {
    try {
      if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    } catch {}
  };

  if (!audit.ok) {
    cleanupQuarantine(audit.quarantineDir);
    cleanupQuarantine(quarantineDir);
    return { ok: false, installed: false, blocked: true, error: audit.error, audit };
  }

  // Security threats from AgentShield are never bypassed, even with force=true.
  if (audit.shieldBlockingCount > 0) {
    cleanupQuarantine(audit.quarantineDir);
    cleanupQuarantine(quarantineDir);
    return {
      ok: false,
      installed: false,
      blocked: true,
      securityBlocked: true,
      reasons: audit.reasons,
      audit,
    };
  }

  if (!audit.approved && !force) {
    cleanupQuarantine(audit.quarantineDir);
    cleanupQuarantine(quarantineDir);
    return {
      ok: false,
      installed: false,
      blocked: true,
      reasons: audit.reasons,
      audit,
    };
  }

  if (dryRun) {
    cleanupQuarantine(audit.quarantineDir);
    cleanupQuarantine(quarantineDir);
    return {
      ok: true,
      dryRun: true,
      installed: false,
      slug: cleanSlug,
      audit,
    };
  }

  const destDir = resolve(targetSkillsDir, cleanSlug);
  const rootAbs = resolve(targetSkillsDir);
  if (!destDir.startsWith(rootAbs + sep)) {
    cleanupQuarantine(audit.quarantineDir);
    return { ok: false, installed: false, blocked: true, error: 'unsafe_target_path' };
  }

  mkdirSync(destDir, { recursive: true });
  cpSync(audit.quarantineDir, destDir, { recursive: true, force: true });
  try {
    writeFileSync(
      join(destDir, '.user-skill.json'),
      JSON.stringify({ slug: cleanSlug, importedAt: new Date().toISOString(), source: String(source || 'external') }, null, 2),
      'utf8'
    );
  } catch {}
  cleanupQuarantine(audit.quarantineDir);
  if (quarantineDir && resolve(quarantineDir) !== resolve(audit.quarantineDir)) {
    cleanupQuarantine(quarantineDir);
  }

  return {
    ok: true,
    installed: true,
    slug: cleanSlug,
    installedDir: destDir,
    audit,
  };
}

/**
 * Fetches/reads a skill from a local folder or GitHub repo (`owner/repo`), quarantines, audits, and installs it.
 */
export async function importSkillFromSource(opts = {}) {
  const {
    source = '',
    slug = '',
    targetSkillsDir = DEFAULT_SKILLS_ROOT,
    existingSkillsRoot = '',
    cacheDir = '',
    force = false,
    dryRun = false,
    fetchImpl = globalThis.fetch,
    timeoutMs = 5000,
    lang = 'ru',
  } = opts && typeof opts === 'object' && !Array.isArray(opts) ? opts : {};
  const isEn = String(lang || '').trim().toLowerCase() === 'en';
  const cleanSource = String(source || '').trim();
  const cleanSlug = validateSkillSlug(slug);
  if (!cleanSource || !cleanSlug) {
    return { ok: false, installed: false, error: 'source_and_slug_required' };
  }

  const localAbs = resolve(cleanSource);
  if (existsSync(localAbs)) {
    const st = statSync(localAbs);
    const skillMdFile = st.isDirectory() ? join(localAbs, 'SKILL.md') : localAbs;
    if (!existsSync(skillMdFile)) {
      return { ok: false, installed: false, error: 'local_skill_md_not_found' };
    }
    const mdSt = statSync(skillMdFile);
    if (mdSt.size > MAX_QUARANTINE_FILE_BYTES) {
      return {
        ok: false,
        installed: false,
        blocked: true,
        securityBlocked: true,
        error: 'skill_file_oversized',
        reasons: [
          isEn
            ? `SKILL.md exceeds safe limit ${Math.round(MAX_QUARANTINE_FILE_BYTES / 1024)} KB`
            : `SKILL.md превышает безопасный лимит ${Math.round(MAX_QUARANTINE_FILE_BYTES / 1024)} КБ`,
        ],
      };
    }
    const md = readFileSync(skillMdFile, 'utf8');
    const extraFiles = {};
    if (st.isDirectory()) {
      for (const sub of ['scripts', 'references', 'evals', 'examples', 'resources']) {
        const subDir = join(localAbs, sub);
        if (!existsSync(subDir)) continue;
        for (const f of collectFilesRecursive(subDir, localAbs)) {
          try {
            const fst = statSync(f.fullPath);
            if (FORBIDDEN_BINARY_EXT_RE.test(f.relPath) || fst.size > MAX_QUARANTINE_FILE_BYTES) {
              extraFiles[f.relPath] = { oversizedOrBinary: true };
            } else {
              extraFiles[f.relPath] = readFileSync(f.fullPath);
            }
          } catch {}
        }
      }
    }
    return installQuarantinedSkill({
      skillMarkdown: md,
      extraFiles,
      slug: cleanSlug,
      source: cleanSource,
      targetSkillsDir,
      existingSkillsRoot,
      cacheDir,
      force,
      dryRun,
      lang,
    });
  }

  const repo = validateRepoSlug(cleanSource);
  if (!repo || typeof fetchImpl !== 'function') {
    return { ok: false, installed: false, error: 'invalid_source_repo_or_offline' };
  }

  const candidateUrls = [
    `https://raw.githubusercontent.com/${repo}/main/skills/${cleanSlug}/SKILL.md`,
    `https://raw.githubusercontent.com/${repo}/master/skills/${cleanSlug}/SKILL.md`,
    `https://raw.githubusercontent.com/${repo}/main/SKILL.md`,
  ];

  let fetchedMd = '';
  let fetchedUrl = '';
  for (const url of candidateUrls) {
    try {
      const resp = await fetchImpl(url, {
        headers: { 'User-Agent': 'antigravity-model-router/3.28' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (resp.ok) {
        const text = await resp.text();
        if (url.endsWith(`/${repo}/main/SKILL.md`)) {
          const repoShort = (repo.split('/')[1] || '').toLowerCase();
          const fmName = String(parseYamlFrontmatter(text)?.name || '').trim().toLowerCase();
          if (repoShort !== cleanSlug && fmName !== cleanSlug) {
            continue;
          }
        }
        fetchedMd = text;
        fetchedUrl = url;
        break;
      }
    } catch {}
  }

  if (!fetchedMd.trim()) {
    return { ok: false, installed: false, error: 'remote_skill_not_found', repo, slug: cleanSlug };
  }

  const res = installQuarantinedSkill({
    skillMarkdown: fetchedMd,
    slug: cleanSlug,
    source: repo,
    targetSkillsDir,
    existingSkillsRoot,
    cacheDir,
    force,
    dryRun,
    lang,
  });
  return { ...res, sourceUrl: fetchedUrl };
}

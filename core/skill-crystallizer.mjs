import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeReadJsonSync, updateJsonAtomicSync, atomicWriteJsonSync, withFileLockSync } from './safe-json.mjs';
import { ensureTunnelCacheDir, resolveTunnelCacheDir } from './cache-dir.mjs';
import { listPitfalls } from './pitfall-ledger.mjs';
import { matchSkillsAi } from './local-gpu-engine.mjs';
import { knowledgeHub } from './sqlite-knowledge-hub.mjs';

export const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const CACHE_DIR = resolveTunnelCacheDir(PLUGIN_ROOT);
export const CRYSTALLIZER_STATE_FILE = join(CACHE_DIR, 'skill-crystallizer.json');
export const PLUGIN_SKILLS_DIR = join(PLUGIN_ROOT, 'skills');
export const INSTALLED_PLUGIN_SKILLS_DIR = join(homedir(), '.gemini', 'config', 'plugins', 'antigravity-model-router', 'skills');
export const GLOBAL_SKILLS_DIR = join(homedir(), '.gemini', 'config', 'skills');
export const LEGACY_GLOBAL_SKILLS_DIR = join(homedir(), '.gemini', 'antigravity', 'skills');
export const MAX_BODY_LINES = 80;
export const MAX_LEARNED_PATTERNS = 15;
export const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty']);

function writeTextAtomicLocked(targetPath, text) {
  const dir = dirname(targetPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  withFileLockSync(targetPath, () => {
    atomicWriteJsonSync(targetPath, String(text ?? ''));
  });
}

function resolveCrystallizerCacheDir() {
  return ensureTunnelCacheDir(resolveTunnelCacheDir(PLUGIN_ROOT));
}

function getCrystallizerStateFile() {
  return join(resolveCrystallizerCacheDir(), 'skill-crystallizer.json');
}

function ensureCacheDir() {
  const dir = resolveCrystallizerCacheDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function createInitialState() {
  return {
    skills: {},
    totalCrystallized: 0,
    lastUpdated: new Date().toISOString()
  };
}

/**
 * Normalizes skill identifier into a safe kebab-case slug.
 * @param {string} raw
 * @returns {string}
 */
export function sanitizeSlug(raw = '') {
  const str = typeof raw === 'string' ? raw : String(raw || '');
  const trimmed = str.trim().toLowerCase();
  if (UNSAFE_KEYS.has(trimmed)) {
    return 'custom-skill';
  }

  let slug = trimmed
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/^-+|-+$/g, '');

  if (!slug || UNSAFE_KEYS.has(slug) || slug === 'proto') {
    return 'custom-skill';
  }
  return slug;
}

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return { name: '', description: '' };
  const raw = match[1];
  let name = '';
  let description = '';
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kvMatch = lines[i].match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (!kvMatch) continue;
    const key = kvMatch[1].toLowerCase();
    const rawVal = kvMatch[2].trim();
    let val = '';
    if (/^[>|]-?$/.test(rawVal)) {
      const folded = rawVal.startsWith('>');
      const block = [];
      let j = i + 1;
      while (j < lines.length) {
        if (/^\s+\S/.test(lines[j])) {
          block.push(lines[j].trim());
          j++;
        } else if (!lines[j].trim()) {
          block.push('');
          j++;
        } else {
          break;
        }
      }
      i = j - 1;
      val = folded ? block.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim() : block.join('\n').trim();
    } else {
      val = rawVal.replace(/^['"]|['"]$/g, '').trim();
    }
    if (key === 'name') name = val;
    if (key === 'description') description = val;
  }
  return { name, description };
}

function parseSkillSections(content) {
  const frontmatter = parseFrontmatter(content);
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');

  const triggers = [];
  const invariants = [];
  const recipeSteps = [];
  let verifyCmd = '';

  let currentSection = '';
  const lines = body.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^##\s*(?:1\.\s*)?triggers/i.test(trimmed)) {
      currentSection = 'triggers';
      continue;
    } else if (/^##\s*(?:2\.\s*)?invariants/i.test(trimmed)) {
      currentSection = 'invariants';
      continue;
    } else if (/^##\s*(?:3\.\s*)?(?:step|recipe)/i.test(trimmed)) {
      currentSection = 'recipe';
      continue;
    } else if (/^##\s*(?:4\.\s*)?verify/i.test(trimmed)) {
      currentSection = 'verify';
      continue;
    } else if (/^##\s+/.test(trimmed)) {
      currentSection = 'other';
      continue;
    }

    if (!trimmed) continue;

    if (currentSection === 'triggers') {
      const m = trimmed.match(/^[-*]\s*(.+)$/);
      if (m) {
        const parts = m[1].split(',').map(p => p.trim()).filter(Boolean);
        triggers.push(...parts);
      }
    } else if (currentSection === 'invariants') {
      const m = trimmed.match(/^[-*]\s*(.+)$/);
      if (m) invariants.push(m[1].trim());
    } else if (currentSection === 'recipe') {
      const m = trimmed.match(/^(?:\d+\.|\*|-)\s*(.+)$/);
      if (m) recipeSteps.push(m[1].trim());
    } else if (currentSection === 'verify') {
      const codeMatch = trimmed.match(/^`{1,3}([^`]+)`{1,3}$/);
      if (codeMatch && !verifyCmd) {
        verifyCmd = codeMatch[1].trim();
      } else if (!verifyCmd && !trimmed.startsWith('```')) {
        verifyCmd = trimmed;
      }
    }
  }

  return { frontmatter, triggers, invariants, recipeSteps, verifyCmd };
}

export function synthesizeTriggerDescription(opts = {}) {
  const {
    slug,
    description = '',
    triggers = [],
    invariants = [],
    recipeSteps = []
  } = opts && typeof opts === 'object' ? opts : {};
  const cleanDesc = String(description || '').replace(/\s+/g, ' ').trim();
  if (cleanDesc && !/^skill capsule for\b/i.test(cleanDesc)) {
    return cleanDesc;
  }
  const humanSlug = String(slug || 'custom-skill').replace(/[-_]+/g, ' ').trim();
  const sampleHint = String(recipeSteps[0] || invariants[0] || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 90);
  const summaryPart = sampleHint ? `: ${sampleHint}` : '';
  const trigList = (Array.isArray(triggers) ? triggers : [])
    .map(t => String(t || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 6);
  const trigClause = trigList.length > 0
    ? `Use when tasks involve: ${trigList.join(', ')}.`
    : `Use when tasks require ${humanSlug} workflows and verification.`;
  return `Specialized workflow for ${humanSlug}${summaryPart}. ${trigClause}`;
}

function buildSkillBundle({ slug, description, triggers = [], invariants = [], recipeSteps = [], verifyCmd = '' }) {
  const trigList = triggers.length > 0 ? triggers : ['manual execution'];
  const fullInvList = invariants.length > 0 ? [...invariants] : ['keep changes minimal and backward-compatible'];
  const fullStepList = recipeSteps.length > 0 ? [...recipeSteps] : ['execute task adhering to specification'];
  const vCmd = verifyCmd || 'node --check';

  const render = (invs, steps, overflowLink = '') => {
    const stepLines = steps.map((step, idx) => `${idx + 1}. ${step}`);
    if (overflowLink) {
      stepLines.push(overflowLink);
    }
    return [
      '---',
      `name: ${slug}`,
      `description: ${description}`,
      '---',
      `# ${slug} — Compact EN Execution Capsule`,
      '',
      '## 1. Triggers',
      `- ${trigList.join(', ')}`,
      '',
      '## 2. Invariants & Pitfalls',
      ...invs.map(inv => `- ${inv}`),
      '',
      '## 3. Step-by-Step Recipe',
      ...stepLines,
      '',
      '## 4. Verify Command',
      `\`${vCmd}\``,
      ''
    ].join('\n');
  };

  const fullMd = render(fullInvList, fullStepList);
  if (fullMd.split('\n').length <= MAX_BODY_LINES) {
    return { md: fullMd, overflowMd: '' };
  }

  const refLink = '- Extended invariants & full recipe: [references/extended-recipes.md](./references/extended-recipes.md)';
  const invList = [...fullInvList];
  const stepList = [...fullStepList];
  let md = render(invList, stepList, refLink);

  while (md.split('\n').length > MAX_BODY_LINES && stepList.length > 2) {
    stepList.pop();
    md = render(invList, stepList, refLink);
  }

  while (md.split('\n').length > MAX_BODY_LINES && invList.length > 1) {
    invList.pop();
    md = render(invList, stepList, refLink);
  }

  const lines = md.split('\n');
  if (lines.length > MAX_BODY_LINES) {
    md = lines.slice(0, MAX_BODY_LINES).join('\n');
  }

  const overflowMd = [
    `# ${slug} — Extended Invariants & Recipe Reference`,
    '',
    '## Full Invariants & Pitfalls',
    ...fullInvList.map(inv => `- ${inv}`),
    '',
    '## Complete Step-by-Step Recipe',
    ...fullStepList.map((step, idx) => `${idx + 1}. ${step}`),
    '',
    '## Verify Command',
    `\`${vCmd}\``,
    ''
  ].join('\n');

  return { md, overflowMd };
}

function buildSkillMd(params) {
  return buildSkillBundle(params).md;
}

/**
 * Checks whether a SKILL.md file is an auto-generated compact capsule vs a rich authorial skill.
 * @param {string} [content='']
 * @returns {boolean}
 */
export function isCapsuleSkill(content = '') {
  const trimmed = String(content || '').trim();
  if (!trimmed) return true;
  if (/^#\s+.+—\s*Compact EN Execution Capsule/im.test(trimmed)) {
    return true;
  }
  const hasAllCapsuleHeaders =
    /^##\s*1\.\s*Triggers/im.test(trimmed) &&
    /^##\s*2\.\s*Invariants/im.test(trimmed) &&
    /^##\s*3\.\s*Step-by-Step Recipe/im.test(trimmed) &&
    /^##\s*4\.\s*Verify Command/im.test(trimmed);
  return hasAllCapsuleHeaders;
}

const LEARNED_SECTION_HEADER = '## Learned Patterns & Verified Recipes';

/**
 * Counts how many learned pattern bullets exist in a SKILL.md content string.
 * @param {string} [content='']
 * @returns {number}
 */
export function countLearnedPatterns(content = '') {
  const idx = String(content || '').indexOf(LEARNED_SECTION_HEADER);
  if (idx === -1) return 0;
  const tail = content.slice(idx + LEARNED_SECTION_HEADER.length);
  const nextSectionIdx = tail.search(/\r?\n##\s+/);
  const sectionBody = nextSectionIdx === -1 ? tail : tail.slice(0, nextSectionIdx);
  return sectionBody
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => /^[-*]\s+/.test(l)).length;
}

function normalizePatternKey(line = '') {
  return String(line || '')
    .toLowerCase()
    .replace(/^[-*]\s*/, '')
    .replace(/\*\*\[[^\]]+\]\*\*\s*/g, '')
    .replace(/\[(?:invariant|recipe|verify|triggers)\]\s*/gi, '')
    .replace(/[^a-zA-Zа-яА-ЯёЁ0-9]+/g, ' ')
    .trim();
}

function arePatternsNearDuplicate(aKey = '', bKey = '') {
  if (!aKey || !bKey) return false;
  if (aKey === bKey) return true;
  const wordsA = new Set(aKey.split(/\s+/).filter(w => w.length >= 3));
  const wordsB = new Set(bKey.split(/\s+/).filter(w => w.length >= 3));
  if (wordsA.size < 3 || wordsB.size < 3) return false;
  let inter = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) inter++;
  }
  const union = wordsA.size + wordsB.size - inter;
  return union > 0 && inter / union >= 0.72;
}

/**
 * Non-destructively appends verified invariants and recipe steps into the
 * `## Learned Patterns & Verified Recipes` section at the bottom of a rich authorial SKILL.md,
 * preserving 100% of the core skill instructions and deduplicating near-identical entries.
 * @param {string} existingContent
 * @param {object} params
 * @returns {string}
 */
export function mergeIntoRichSkillMd(
  existingContent = '',
  { triggers = [], invariants = [], recipeSteps = [], verifyCmd = '' } = {}
) {
  const raw = String(existingContent || '');
  const idx = raw.indexOf(LEARNED_SECTION_HEADER);

  let baseContent = raw.trimEnd();
  const existingBullets = [];

  if (idx !== -1) {
    const before = raw.slice(0, idx).trimEnd();
    const afterHeader = raw.slice(idx + LEARNED_SECTION_HEADER.length);
    const nextSectionMatch = afterHeader.match(/\r?\n(##\s+[\s\S]*)$/);
    const sectionBody = nextSectionMatch ? afterHeader.slice(0, nextSectionMatch.index) : afterHeader;
    const trailingSections = nextSectionMatch ? `\n\n${nextSectionMatch[1].trimEnd()}` : '';

    for (const line of sectionBody.split(/\r?\n/)) {
      const t = line.trim();
      if (/^[-*]\s+/.test(t)) {
        existingBullets.push(t.replace(/^\*\s+/, '- '));
      }
    }
    baseContent = `${before}${trailingSections}`;
  }

  const seenKeys = existingBullets.map(normalizePatternKey).filter(Boolean);
  const mergedBullets = [...existingBullets];

  const addBullet = (prefix, text) => {
    const clean = String(text || '').replace(/\r?\n/g, ' ').trim();
    if (!clean) return;
    const key = normalizePatternKey(clean);
    if (!key || seenKeys.some(existingKey => arePatternsNearDuplicate(existingKey, key))) return;
    seenKeys.push(key);
    mergedBullets.push(`- **[${prefix}]** ${clean}`);
  };

  for (const inv of invariants) {
    addBullet('Invariant', inv);
  }
  for (const step of recipeSteps) {
    addBullet('Recipe', step);
  }
  if (verifyCmd && verifyCmd.trim() && verifyCmd.trim() !== 'node --check') {
    addBullet('Verify', `\`${verifyCmd.trim()}\``);
  }
  if (Array.isArray(triggers) && triggers.length > 0 && invariants.length === 0 && recipeSteps.length === 0) {
    addBullet('Triggers', triggers.join(', '));
  }

  if (mergedBullets.length === 0) {
    return `${baseContent}\n`;
  }

  const cappedBullets = mergedBullets.slice(-MAX_LEARNED_PATTERNS);
  return `${baseContent}\n\n${LEARNED_SECTION_HEADER}\n${cappedBullets.join('\n')}\n`;
}

/**
 * Scans directories for crystallized skills and returns their metadata.
 * @param {string} [customRoot='']
 * @param {object} [options={}]
 * @returns {Array<{ slug: string, name: string, description: string, linesCount: number, hasScripts: boolean, isRichSkill: boolean, learnedPatternsCount: number, path: string, updatedAt: string }>}
 */
export function listCrystallizedSkills(customRoot = '', options = {}) {
  const dirsToScan = [];
  if (customRoot) {
    dirsToScan.push(resolve(customRoot));
  } else {
    dirsToScan.push(PLUGIN_SKILLS_DIR);
    if (existsSync(INSTALLED_PLUGIN_SKILLS_DIR) && resolve(INSTALLED_PLUGIN_SKILLS_DIR) !== resolve(PLUGIN_SKILLS_DIR)) {
      dirsToScan.push(INSTALLED_PLUGIN_SKILLS_DIR);
    }
    const wsRoot = options?.workspaceRoot ? resolve(options.workspaceRoot) : '';
    if (wsRoot) {
      for (const relWsSkills of [
        join(wsRoot, '.agents', 'skills'),
        join(wsRoot, '.gemini', 'skills'),
        join(wsRoot, 'skills'),
      ]) {
        if (existsSync(relWsSkills) && resolve(relWsSkills) !== resolve(PLUGIN_SKILLS_DIR)) {
          dirsToScan.push(relWsSkills);
        }
      }
    }
    if (existsSync(GLOBAL_SKILLS_DIR)) {
      dirsToScan.push(GLOBAL_SKILLS_DIR);
    }
    if (existsSync(LEGACY_GLOBAL_SKILLS_DIR)) {
      dirsToScan.push(LEGACY_GLOBAL_SKILLS_DIR);
    }
  }

  const skillsMap = new Map();

  for (const dir of dirsToScan) {
    if (!existsSync(dir)) continue;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const subfolder = join(dir, entry.name);
      const skillFile = join(subfolder, 'SKILL.md');
      if (!existsSync(skillFile)) continue;

      const slug = sanitizeSlug(entry.name);
      if (skillsMap.has(slug)) continue;

      let content = '';
      let updatedAt = new Date().toISOString();
      try {
        content = readFileSync(skillFile, 'utf-8');
        const st = statSync(skillFile);
        updatedAt = st.mtime.toISOString();
      } catch {
        continue;
      }

      const fm = parseFrontmatter(content);
      const linesCount = content.split(/\r?\n/).length;
      const isRichSkill = !isCapsuleSkill(content);
      const learnedPatternsCount = countLearnedPatterns(content);

      let hasScripts = false;
      const scriptsDir = join(subfolder, 'scripts');
      if (existsSync(scriptsDir)) {
        try {
          const scriptFiles = readdirSync(scriptsDir);
          hasScripts = scriptFiles.length > 0;
        } catch {
          hasScripts = false;
        }
      }

      skillsMap.set(slug, {
        slug: entry.name,
        name: fm.name || entry.name,
        description: fm.description || '',
        linesCount,
        hasScripts,
        isRichSkill,
        learnedPatternsCount,
        path: subfolder,
        updatedAt
      });
    }
  }

  return Array.from(skillsMap.values());
}

/**
 * Finds matching existing skill by exact slug, semantic vector match, or frontmatter trigger overlap (>= 50%).
 * @param {string} slug
 * @param {string[]} [triggers=[]]
 * @param {string} [customRoot='']
 * @param {object} [options={}]
 * @returns {{ matchType: 'exact'|'semantic'|'overlap', skill: object } | null}
 */
export function findMatchingExistingSkill(slug, triggers = [], customRoot = '', options = {}) {
  const skills = listCrystallizedSkills(customRoot);
  const targetSlug = sanitizeSlug(slug);

  // 1. Exact slug match
  const exact = skills.find(s => s.slug.toLowerCase() === targetSlug.toLowerCase());
  if (exact) {
    return { matchType: 'exact', skill: exact };
  }

  // 2. Semantic match passed from qwen3-embedding:0.6b / gemma4:12b judge
  const semanticSlug = String(options?.semanticSlug || '').trim().toLowerCase();
  if (semanticSlug) {
    const semMatch = skills.find(s => s.slug.toLowerCase() === semanticSlug);
    if (semMatch) {
      return { matchType: 'semantic', skill: semMatch };
    }
  }
  if (Array.isArray(options?.semanticSkills) && options.semanticSkills.length > 0) {
    const bestCandidate = options.semanticSkills.find(
      s => s?.slug && s.confident !== false && (s.score ?? 1) >= 0.46
    );
    if (bestCandidate) {
      const semMatch = skills.find(s => s.slug.toLowerCase() === String(bestCandidate.slug).toLowerCase());
      if (semMatch) {
        return { matchType: 'semantic', skill: semMatch };
      }
    }
  }

  // 3. Frontmatter self-description overlap when >= 2 explicit triggers are supplied
  const normTriggers = (Array.isArray(triggers) ? triggers : [])
    .map(t => String(t || '').trim().toLowerCase())
    .filter(t => t.length > 0);

  if (normTriggers.length >= 2) {
    let bestOverlapSkill = null;
    let bestOverlapRatio = 0;

    for (const skill of skills) {
      const searchTarget = `${skill.slug} ${skill.description}`.toLowerCase();
      const matchCount = normTriggers.filter(t => {
        if (searchTarget.includes(t)) return true;
        const words = t.split(/[^a-zA-Zа-яА-ЯёЁ0-9_-]+/).filter(w => w.length >= 2);
        return words.length > 0 && words.some(w => searchTarget.includes(w));
      }).length;

      const ratio = matchCount / normTriggers.length;
      if (ratio >= 0.5 && ratio > bestOverlapRatio) {
        bestOverlapRatio = ratio;
        bestOverlapSkill = skill;
      }
    }

    if (bestOverlapSkill) {
      return { matchType: 'overlap', skill: bestOverlapSkill };
    }
  }

  return null;
}

/**
 * Асинхронный семантический поиск существующего скилла через qwen3-embedding:0.6b + фоллбэк gemma4:12b.
 * @param {string} slug
 * @param {string[]} [triggers=[]]
 * @param {string} [customRoot='']
 * @param {object} [options={}]
 */
export async function findMatchingExistingSkillAi(slug, triggers = [], customRoot = '', options = {}) {
  const direct = findMatchingExistingSkill(slug, triggers, customRoot, options);
  if (direct && (direct.matchType === 'exact' || direct.matchType === 'semantic')) {
    return direct;
  }
  const triggerList = (Array.isArray(triggers) ? triggers : []).map(t => String(t || '').trim()).filter(Boolean);
  const queryText = `${String(slug || '').trim()}${triggerList.length ? `: ${triggerList.join(', ')}` : ''}`.trim();
  if (!queryText) return direct;

  try {
    const aiRes = await matchSkillsAi(queryText, {
      customRoot,
      allowLlmFallback: options.allowLlmFallback !== false,
      ...options,
    });
    if (aiRes?.bestSlug) {
      const semMatch = findMatchingExistingSkill(slug, triggers, customRoot, {
        ...options,
        semanticSlug: aiRes.bestSlug,
      });
      if (semMatch) return semMatch;
    }
  } catch {}
  return direct;
}

/**
 * Packages or updates reusable patterns into a SKILL.md.
 * - For rich authorial skills (`!isCapsuleSkill`), preserves 100% of core content and appends to `## Learned Patterns & Verified Recipes`.
 * - For compact capsule skills, merges the 4 structured sections under <=80 lines.
 * @param {object} params
 * @returns {{ ok: boolean, action: 'created'|'merged', mode: 'rich_append'|'capsule', slug: string, skillPath: string, linesCount: number, learnedPatternsCount: number }}
 */
export function crystallizeSkill({
  slug,
  description = '',
  triggers = [],
  invariants = [],
  recipeSteps = [],
  verifyCmd = '',
  scriptName = '',
  scriptContent = '',
  targetDir = '',
  forceCapsule = false,
  semanticSlug = '',
  semanticSkills = []
} = {}) {
  const sanitizedSlug = sanitizeSlug(slug);
  const isIsolatedTarget = Boolean(targetDir && String(targetDir).trim());
  const match = findMatchingExistingSkill(sanitizedSlug, triggers, targetDir, { semanticSlug, semanticSkills });

  const effectiveSlug = match ? match.skill.slug : sanitizedSlug;
  const skillDir = isIsolatedTarget
    ? join(resolve(targetDir), effectiveSlug)
    : (match ? match.skill.path : join(GLOBAL_SKILLS_DIR, effectiveSlug));
  const skillPath = join(skillDir, 'SKILL.md');

  let content = '';
  let overflowMd = '';
  let mergeMode = 'capsule';

  if (match) {
    let existingContent = '';
    try {
      if (existsSync(skillPath)) {
        existingContent = readFileSync(skillPath, 'utf-8');
      } else if (match.skill?.path && existsSync(join(match.skill.path, 'SKILL.md'))) {
        existingContent = readFileSync(join(match.skill.path, 'SKILL.md'), 'utf-8');
      }
    } catch {}

    if (!forceCapsule && existingContent && !isCapsuleSkill(existingContent)) {
      mergeMode = 'rich_append';
      content = mergeIntoRichSkillMd(existingContent, {
        triggers,
        invariants,
        recipeSteps,
        verifyCmd
      });
    } else {
      const parsed = parseSkillSections(existingContent);

      const mergedTriggers = [...parsed.triggers];
      for (const t of triggers) {
        const norm = String(t || '').trim();
        if (norm && !mergedTriggers.some(x => x.toLowerCase() === norm.toLowerCase())) {
          mergedTriggers.push(norm);
        }
      }

      const mergedInvariants = [...parsed.invariants];
      for (const inv of invariants) {
        const norm = String(inv || '').trim();
        if (norm && !mergedInvariants.some(x => x.toLowerCase() === norm.toLowerCase())) {
          mergedInvariants.push(norm);
        }
      }

      const mergedSteps = [...parsed.recipeSteps];
      for (const step of recipeSteps) {
        const norm = String(step || '').trim();
        if (norm && !mergedSteps.some(x => x.toLowerCase() === norm.toLowerCase())) {
          mergedSteps.push(norm);
        }
      }

      const finalDesc = synthesizeTriggerDescription({
        slug: effectiveSlug,
        description: (description && description.trim()) || parsed.frontmatter.description || match.skill.description,
        triggers: mergedTriggers,
        invariants: mergedInvariants,
        recipeSteps: mergedSteps
      });
      const finalVerify = verifyCmd || parsed.verifyCmd || 'node --check';

      const bundle = buildSkillBundle({
        slug: effectiveSlug,
        description: finalDesc,
        triggers: mergedTriggers,
        invariants: mergedInvariants,
        recipeSteps: mergedSteps,
        verifyCmd: finalVerify
      });
      content = bundle.md;
      overflowMd = bundle.overflowMd;
    }
  } else {
    const finalDesc = synthesizeTriggerDescription({
      slug: effectiveSlug,
      description,
      triggers,
      invariants,
      recipeSteps
    });
    const bundle = buildSkillBundle({
      slug: effectiveSlug,
      description: finalDesc,
      triggers,
      invariants,
      recipeSteps,
      verifyCmd
    });
    content = bundle.md;
    overflowMd = bundle.overflowMd;
  }

  // Write SKILL.md (and optional references overflow) atomically under per-file lock
  writeTextAtomicLocked(skillPath, content);
  if (overflowMd) {
    writeTextAtomicLocked(join(skillDir, 'references', 'extended-recipes.md'), overflowMd);
  }

  const absSkillDir = resolve(skillDir);
  const absPluginSkillsDir = resolve(PLUGIN_SKILLS_DIR);
  const isCorePluginSkill =
    !isIsolatedTarget &&
    (absSkillDir === absPluginSkillsDir ||
      absSkillDir.startsWith(`${absPluginSkillsDir}${sep}`) ||
      absSkillDir.startsWith(`${absPluginSkillsDir}/`) ||
      absSkillDir.startsWith(`${absPluginSkillsDir}\\`));

  // Mirror core plugin skills only to INSTALLED_PLUGIN_SKILLS_DIR when targetDir is not isolated
  if (
    isCorePluginSkill &&
    INSTALLED_PLUGIN_SKILLS_DIR &&
    resolve(INSTALLED_PLUGIN_SKILLS_DIR) !== absPluginSkillsDir &&
    existsSync(dirname(INSTALLED_PLUGIN_SKILLS_DIR))
  ) {
    try {
      const installedDir = join(INSTALLED_PLUGIN_SKILLS_DIR, effectiveSlug);
      writeTextAtomicLocked(join(installedDir, 'SKILL.md'), content);
      if (overflowMd) {
        writeTextAtomicLocked(join(installedDir, 'references', 'extended-recipes.md'), overflowMd);
      }
    } catch {}
  }

  // Write optional script atomically under per-file lock (mirror only for core plugin skills)
  if (scriptName && scriptContent) {
    const safeScriptName = basename(scriptName);
    const scriptsDir = join(skillDir, 'scripts');
    writeTextAtomicLocked(join(scriptsDir, safeScriptName), scriptContent);

    if (
      isCorePluginSkill &&
      INSTALLED_PLUGIN_SKILLS_DIR &&
      resolve(INSTALLED_PLUGIN_SKILLS_DIR) !== absPluginSkillsDir &&
      existsSync(dirname(INSTALLED_PLUGIN_SKILLS_DIR))
    ) {
      try {
        writeTextAtomicLocked(join(INSTALLED_PLUGIN_SKILLS_DIR, effectiveSlug, 'scripts', safeScriptName), scriptContent);
      } catch {}
    }
  }

  const linesCount = content.split(/\r?\n/).length;
  const learnedPatternsCount = countLearnedPatterns(content);

  // Update crystallizer state (skip global state tracking for isolated test targetDir)
  if (!isIsolatedTarget) {
    try {
      ensureCacheDir();
      updateJsonAtomicSync(getCrystallizerStateFile(), createInitialState, (state) => {
        const current = state && typeof state === 'object' ? state : createInitialState();
        if (!current.skills || typeof current.skills !== 'object') {
          current.skills = {};
        }
        current.skills[effectiveSlug] = {
          slug: effectiveSlug,
          action: match ? 'merged' : 'created',
          mode: mergeMode,
          updatedAt: new Date().toISOString(),
          linesCount,
          learnedPatternsCount
        };
        current.totalCrystallized = (Number(current.totalCrystallized) || 0) + 1;
        current.lastUpdated = new Date().toISOString();
        return current;
      });
    } catch {}
  }

  return {
    ok: true,
    action: match ? 'merged' : 'created',
    mode: mergeMode,
    slug: effectiveSlug,
    skillPath,
    linesCount,
    learnedPatternsCount,
    hasOverflowReferences: Boolean(overflowMd)
  };
}

/**
 * Convenience helper to non-destructively append a single verified pattern or guardrail into an existing or new skill.
 * @param {object} params
 * @returns {{ ok: boolean, action: 'created'|'merged', mode: 'rich_append'|'capsule', slug: string, skillPath: string, linesCount: number, learnedPatternsCount: number }}
 */
export function appendLearnedPattern({
  slug,
  pattern = '',
  category = 'recipe',
  triggers = [],
  verifyCmd = '',
  targetDir = '',
  semanticSlug = '',
  semanticSkills = []
} = {}) {
  const cleanPattern = String(pattern || '').trim();
  const isInvariant = /^(?:invariant|pitfall|guardrail)$/i.test(String(category || '').trim());
  return crystallizeSkill({
    slug,
    triggers,
    invariants: isInvariant && cleanPattern ? [cleanPattern] : [],
    recipeSteps: !isInvariant && cleanPattern ? [cleanPattern] : [],
    verifyCmd,
    targetDir,
    semanticSlug,
    semanticSkills
  });
}

/**
 * Семантический вариант appendLearnedPattern с автоподбором существующего скилла через qwen3-embedding:0.6b / gemma4:12b.
 * @param {object} params
 */
export async function appendLearnedPatternAi({
  slug,
  pattern = '',
  category = 'recipe',
  triggers = [],
  verifyCmd = '',
  targetDir = '',
  aiOptions = {}
} = {}) {
  const match = await findMatchingExistingSkillAi(
    slug,
    [...triggers, pattern].filter(Boolean),
    targetDir,
    aiOptions
  );
  return appendLearnedPattern({
    slug,
    pattern,
    category,
    triggers,
    verifyCmd,
    targetDir,
    semanticSlug: match?.skill?.slug || ''
  });
}

/**
 * Resolves pre-computed semantic skill match synchronously (zero keyword dictionary).
 * @param {string} [userPrompt='']
 * @param {string[]} [editedFiles=[]]
 * @param {object} [options={}]
 * @returns {string} Matched skill slug or empty string
 */
export function inferTargetSkillFromContext(userPrompt = '', editedFiles = [], options = {}) {
  const top = Array.isArray(options?.semanticSkills) ? options.semanticSkills[0] : null;
  if (top?.slug && top.confident !== false && (top.score ?? 1) >= 0.46) {
    return String(top.slug);
  }
  return '';
}

/**
 * Асинхронный семантический подбор целевого скилла по промпту и списку изменённых файлов
 * через векторный индекс qwen3-embedding:0.6b с фоллбэком на gemma4:12b.
 * @param {string} [userPrompt='']
 * @param {string[]} [editedFiles=[]]
 * @param {object} [options={}]
 * @returns {Promise<string>}
 */
export async function inferTargetSkillFromContextAi(userPrompt = '', editedFiles = [], options = {}) {
  const precomputed = inferTargetSkillFromContext(userPrompt, editedFiles, options);
  if (precomputed) return precomputed;

  const filesList = Array.isArray(editedFiles) ? editedFiles.filter(Boolean) : [];
  const queryParts = [String(userPrompt || '').trim()];
  if (filesList.length > 0) {
    queryParts.push(`Files: ${filesList.slice(0, 8).join(', ')}`);
  }
  const combinedQuery = queryParts.filter(Boolean).join('\n');
  if (!combinedQuery) return '';

  try {
    const res = await matchSkillsAi(combinedQuery, {
      customRoot: options.customRoot || '',
      allowLlmFallback: options.allowLlmFallback !== false,
      ...options
    });
    return res?.bestSlug || '';
  } catch {
    return '';
  }
}

const EXPLICIT_CRYSTALLIZE_RE = /(?:создай\s+скилл|упакуй\s+в\s+скилл|сохрани\s+как\s+скилл|дополни\s+скилл|обнови\s+скилл|crystallize\s+skill|\/learn\b)/i;

function formatCrystallizerGateResult({ explicit, suggestedSkill = '', lastBarrierSummary = '' }) {
  const targetHint = suggestedSkill
    ? `Target existing skill "${suggestedSkill}" (rich append-only)`
    : 'Use Merge-Over-Create into matching skill';
  const barrierNote = lastBarrierSummary ? ` (${String(lastBarrierSummary).slice(0, 70)})` : '';
  return {
    shouldCrystallize: true,
    mode: explicit ? 'explicit' : 'barrier_overcome',
    suggestedSkill,
    formattedHint: `💎 [Skill-Crystallizer] Non-trivial solution verified${barrierNote}. ${targetHint} via core/skill-crystallizer.mjs or \`node core/router-cli.mjs learn --skill ${suggestedSkill || '<slug>'} --pattern "<verified fix>"\` (verify via \`node core/router-cli.mjs audit-skill ${suggestedSkill || '<slug>'}\`).`
  };
}

/**
 * Evaluates whether crystallization gate is triggered (sync path using precomputed semanticSkills).
 * @param {object} params
 * @returns {{ shouldCrystallize: boolean, mode: 'explicit'|'barrier_overcome'|'none', suggestedSkill: string, formattedHint: string }}
 */
export function evaluateCrystallizationGate({
  userPrompt = '',
  conversationId = 'default',
  overcameBarrier = false,
  verifiedFilesCount = 0,
  recoveredFilesCount = 0,
  editedFiles = [],
  lastBarrierSummary = '',
  semanticSkills = []
} = {}) {
  const promptText = typeof userPrompt === 'string' ? userPrompt : String(userPrompt || '');
  const explicit = EXPLICIT_CRYSTALLIZE_RE.test(promptText);
  const barrierCondition =
    Boolean(overcameBarrier) &&
    (Number(verifiedFilesCount) >= 2 || Number(recoveredFilesCount) >= 1);

  if (explicit || barrierCondition) {
    const suggestedSkill = inferTargetSkillFromContext(promptText, editedFiles, { semanticSkills });
    return formatCrystallizerGateResult({ explicit, suggestedSkill, lastBarrierSummary });
  }

  return {
    shouldCrystallize: false,
    mode: 'none',
    suggestedSkill: '',
    formattedHint: ''
  };
}

/**
 * Асинхронные ворота кристаллизации: при срабатывании подбирает скилл через векторы или gemma4:12b.
 * @param {object} [params={}]
 */
export async function evaluateCrystallizationGateAi({
  userPrompt = '',
  conversationId = 'default',
  overcameBarrier = false,
  verifiedFilesCount = 0,
  recoveredFilesCount = 0,
  editedFiles = [],
  lastBarrierSummary = '',
  semanticSkills = [],
  targetDir = '',
  customRoot = '',
  timeoutMs = 2200,
  aiOptions = {}
} = {}) {
  const promptText = typeof userPrompt === 'string' ? userPrompt : String(userPrompt || '');
  const explicit = EXPLICIT_CRYSTALLIZE_RE.test(promptText);
  const barrierCondition =
    Boolean(overcameBarrier) &&
    (Number(verifiedFilesCount) >= 2 || Number(recoveredFilesCount) >= 1);

  if (!explicit && !barrierCondition) {
    return {
      shouldCrystallize: false,
      mode: 'none',
      suggestedSkill: '',
      formattedHint: ''
    };
  }

  const suggestedSkill = await inferTargetSkillFromContextAi(promptText, editedFiles, {
    semanticSkills,
    customRoot: customRoot || targetDir || '',
    llmTimeoutMs: timeoutMs,
    ...aiOptions
  });
  return formatCrystallizerGateResult({ explicit, suggestedSkill, lastBarrierSummary });
}

function appendPitfallToGroup(grouped, p, targetSlug) {
  if (!targetSlug) return;
  const cleanRule = String(p.rule).replace(/\s+/g, ' ').trim();
  const scopeLabel = p.fileName || p.type || 'guardrail';
  const causalLine = `Guardrail (${scopeLabel}): ${cleanRule} — prevents repeat ${p.type || 'regression'} regression.`;
  if (!grouped.has(targetSlug)) {
    grouped.set(targetSlug, []);
  }
  const list = grouped.get(targetSlug);
  if (!list.includes(causalLine)) {
    list.push(causalLine);
  }
}

function applyDistilledPitfallGroups(grouped, { dryRun = false, targetDir = '' } = {}) {
  const evolvedSkills = [];
  for (const [slug, invariants] of grouped.entries()) {
    if (dryRun) {
      evolvedSkills.push({
        slug,
        action: 'preview',
        invariantsCount: invariants.length,
        invariants
      });
    } else {
      const res = crystallizeSkill({
        slug,
        invariants,
        targetDir
      });
      evolvedSkills.push({
        ...res,
        invariantsCount: invariants.length
      });
    }
  }
  return evolvedSkills;
}

/**
 * EvoSkill failure-driven distillation (sync): converts recent Pitfall Ledger regressions into
 * causal "Why"-invariants inside pre-resolved skills or `project-guardrails` in isolated `targetDir`.
 * @param {object} [options={}]
 * @returns {{ ok: boolean, dryRun: boolean, scannedPitfalls: number, evolvedSkills: Array<object> }}
 */
export function distillPitfallsIntoSkills({
  workspaceRoot = '',
  targetDir = '',
  limit = 20,
  dryRun = false,
  semanticSkills = [],
  resolvedSkillsMap = null
} = {}) {
  const pitfalls = listPitfalls(limit, workspaceRoot);
  const grouped = new Map();

  for (let i = 0; i < pitfalls.length; i++) {
    const p = pitfalls[i];
    if (!p || !p.rule) continue;
    const preResolved = resolvedSkillsMap && typeof resolvedSkillsMap === 'object'
      ? (resolvedSkillsMap[i] || resolvedSkillsMap[p.fileName] || '')
      : '';
    const targetSlug =
      preResolved ||
      inferTargetSkillFromContext(`${p.fileName || ''} ${p.rule}`, p.fileName ? [p.fileName] : [], { semanticSkills }) ||
      (targetDir ? 'project-guardrails' : '');
    appendPitfallToGroup(grouped, p, targetSlug);
  }

  const evolvedSkills = applyDistilledPitfallGroups(grouped, { dryRun, targetDir });

  return {
    ok: true,
    dryRun: Boolean(dryRun),
    scannedPitfalls: pitfalls.length,
    evolvedSkills
  };
}

/**
 * Асинхронная EvoSkill-дистилляция ошибок из Pitfall Ledger в релевантные скиллы
 * с AI-маршрутизацией через qwen3-embedding:0.6b + фоллбэк gemma4:12b.
 * @param {object} [options={}]
 */
export async function distillPitfallsIntoSkillsAi({
  workspaceRoot = '',
  targetDir = '',
  limit = 20,
  dryRun = false,
  aiOptions = {}
} = {}) {
  const pitfalls = listPitfalls(limit, workspaceRoot);
  const grouped = new Map();

  for (const p of pitfalls) {
    if (!p || !p.rule) continue;
    const matchedSlug = await inferTargetSkillFromContextAi(
      `${p.fileName || ''} ${p.rule}`,
      p.fileName ? [p.fileName] : [],
      { customRoot: targetDir, ...aiOptions }
    );
    const targetSlug = matchedSlug || (targetDir ? 'project-guardrails' : '');
    appendPitfallToGroup(grouped, p, targetSlug);
  }

  const evolvedSkills = applyDistilledPitfallGroups(grouped, { dryRun, targetDir });

  return {
    ok: true,
    dryRun: Boolean(dryRun),
    scannedPitfalls: pitfalls.length,
    evolvedSkills
  };
}

/**
 * Promotes a single high-confidence project instinct into a reusable SKILL.md entry.
 * @param {object} [options={}]
 * @returns {{ ok: boolean, error?: string, instinctId?: string, skillSlug?: string, result?: object }}
 */
export function promoteInstinctToSkill({
  instinctId = '',
  workspaceRoot = '',
  skillSlug = '',
  targetDir = '',
  hub = knowledgeHub,
} = {}) {
  if (!instinctId || !hub || typeof hub.getInstinctById !== 'function') {
    return { ok: false, error: 'invalid_instinct_promote_args' };
  }
  const instinct = hub.getInstinctById(instinctId, workspaceRoot);
  if (!instinct) {
    return { ok: false, error: 'instinct_not_found' };
  }

  const wsFallbackSlug = workspaceRoot ? `project-${basename(resolve(workspaceRoot))}` : 'project-guardrails';
  const targetSlug = sanitizeSlug(skillSlug || instinct.promotedSkill || wsFallbackSlug || 'project-guardrails');
  const effectiveTargetDir =
    targetDir && String(targetDir).trim()
      ? targetDir
      : workspaceRoot && String(workspaceRoot).trim()
        ? join(resolve(workspaceRoot), '.agents', 'skills')
        : '';
  const res = appendLearnedPattern({
    slug: targetSlug,
    pattern: instinct.pattern,
    category: instinct.category,
    targetDir: effectiveTargetDir,
  });
  if (res?.ok && res.skillPath) {
    try {
      const markerPath = join(dirname(res.skillPath), '.user-skill.json');
      if (!existsSync(markerPath)) {
        writeTextAtomicLocked(markerPath, JSON.stringify({ source: 'instinct', slug: res.slug || targetSlug, createdAt: new Date().toISOString() }, null, 2));
      }
    } catch {}
  }

  if (!res || res.ok === false) {
    return { ok: false, error: res?.error || 'crystallize_failed', instinctId, skillSlug: targetSlug };
  }

  hub.markInstinctPromoted({ id: instinct.id, skillSlug: res.slug || targetSlug, workspaceRoot });
  return {
    ok: true,
    instinctId: instinct.id,
    skillSlug: res.slug || targetSlug,
    pattern: instinct.pattern,
    result: res,
  };
}

/**
 * Evolves all unpromoted project instincts meeting confidence & evidence thresholds into skills.
 * @param {object} [options={}]
 * @returns {{ ok: boolean, dryRun: boolean, candidatesCount: number, promoted: Array<object> }}
 */
export function evolveReadyInstincts({
  workspaceRoot = '',
  minConfidence = 0.75,
  minEvidence = 3,
  skillSlug = '',
  dryRun = false,
  targetDir = '',
  hub = knowledgeHub,
} = {}) {
  if (!hub || typeof hub.listInstincts !== 'function') {
    return { ok: false, dryRun: Boolean(dryRun), candidatesCount: 0, promoted: [] };
  }
  const listed = hub.listInstincts({
    workspaceRoot,
    minConfidence,
    includePromoted: false,
    limit: 50,
  });
  const candidates = (listed?.items || []).filter(
    (it) => !it.promotedSkill && Number(it.effectiveConfidence || 0) >= minConfidence && Number(it.evidenceCount || 0) >= minEvidence
  );

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      candidatesCount: candidates.length,
      promoted: candidates.map((c) => ({
        instinctId: c.id,
        pattern: c.pattern,
        confidence: c.effectiveConfidence,
        evidenceCount: c.evidenceCount,
        action: 'preview',
      })),
    };
  }

  const promoted = [];
  for (const c of candidates) {
    const pRes = promoteInstinctToSkill({
      instinctId: c.id,
      workspaceRoot,
      skillSlug,
      targetDir,
      hub,
    });
    if (pRes.ok) {
      promoted.push(pRes);
    }
  }
  return {
    ok: true,
    dryRun: false,
    candidatesCount: candidates.length,
    promoted,
  };
}

export {
  detectUserCorrectionFriction,
  detectEditChurnFriction,
  recordFrictionObservation,
} from './friction-observer.mjs';

/**
 * Resets skill crystallizer state file.
 * @returns {object}
 */
export function resetSkillCrystallizerState() {
  ensureCacheDir();
  const initial = createInitialState();
  atomicWriteJsonSync(getCrystallizerStateFile(), initial);
  return initial;
}

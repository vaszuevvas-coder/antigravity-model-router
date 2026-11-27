#!/usr/bin/env node
/**
 * @file audit-skill.mjs
 * @description SOTA 2026 Deterministic Skill Auditor & Local Trigger Evaluator.
 * Evaluates SKILL.md bundles for Negative Transfer anti-patterns (SkillsBench/SkillGenBench),
 * Progressive Disclosure compliance, broken script references, and zero-token local
 * BM25F + trigram Trigger & Sibling Collision metrics.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_SKILLS_ROOT = resolve(__dirname, '..', '..');

const RIGID_DIRECTIVE_RE = /\b(?:ALWAYS|NEVER|STRICTLY|MUST\s+ALWAYS|MUST\s+NEVER)\b|(?:СТРОГО\s+ЗАПРЕЩЕНО|НИКОГДА\s+НЕ|ВСЕГДА\s+ОБЯЗАТЕЛЬНО)/;
const CAUSAL_MARKER_RE = /\b(?:because|since|so\s+that|otherwise|prevents|to\s+prevent|avoids|to\s+avoid|causes|leads\s+to|risks|breaks|wastes)\b|(?:потому\s+что|так\s+как|иначе|чтобы|во\s+избежание|приводит\s+к|защищает\s+от|—|->|→)/i;
const GENERIC_FILLER_RE = /\b(?:write\s+clean\s+code|use\s+meaningful\s+variable\s+names|follow\s+general\s+best\s+practices|add\s+proper\s+comments\s+everywhere)\b|(?:пиши\s+чистый\s+код|используй\s+понятные\s+имена\s+переменных|следуй\s+лучшим\s+практикам)/i;
const TRIGGER_CLAUSE_RE = /(?:use\s+when|use\s+this|use\s+for|activate|trigger|используй|включается|применяй|когда\s+нужно|при\s+)/i;
const VERIFY_MENTION_RE = /(?:verify|validation|--check|--dry-run|--test|npm\s+test|node\s+|проверк|верификац|тест)/i;

/**
 * Parses YAML frontmatter including inline scalars and multiline block scalars (`>-`, `>`, `|`, `|-`).
 * @param {string} [content='']
 * @returns {{ hasFrontmatter: boolean, name: string, description: string, body: string, bodyLinesCount: number, totalLinesCount: number }}
 */
export function parseYamlFrontmatter(content = '') {
  const text = String(content || '').replace(/^\uFEFF/, '');
  const totalLinesCount = text ? text.split(/\r?\n/).length : 0;
  const fmMatch = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!fmMatch) {
    return {
      hasFrontmatter: false,
      name: '',
      description: '',
      license: '',
      compatibility: '',
      allowedTools: '',
      body: text,
      bodyLinesCount: totalLinesCount,
      totalLinesCount,
    };
  }

  const rawFm = fmMatch[1];
  const body = text.slice(fmMatch[0].length);
  const bodyLinesCount = body.trim() ? body.split(/\r?\n/).length : 0;

  let name = '';
  let description = '';
  let license = '';
  let compatibility = '';
  let allowedTools = '';
  const fmLines = rawFm.split(/\r?\n/);

  for (let i = 0; i < fmLines.length; i++) {
    const line = fmLines[i];
    const kvMatch = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (!kvMatch) continue;

    const key = kvMatch[1].toLowerCase();
    const rawVal = kvMatch[2].trim();

    let resolvedVal = '';
    if (/^[>|]-?$/.test(rawVal)) {
      const folded = rawVal.startsWith('>');
      const blockLines = [];
      let j = i + 1;
      while (j < fmLines.length) {
        const sub = fmLines[j];
        if (/^\s+\S/.test(sub)) {
          blockLines.push(sub.trim());
          j++;
        } else if (!sub.trim()) {
          blockLines.push('');
          j++;
        } else {
          break;
        }
      }
      i = j - 1;
      resolvedVal = folded
        ? blockLines.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
        : blockLines.join('\n').trim();
    } else {
      resolvedVal = rawVal.replace(/^['"]|['"]$/g, '').trim();
    }

    if (key === 'name') name = resolvedVal;
    if (key === 'description') description = resolvedVal;
    if (key === 'license') license = resolvedVal;
    if (key === 'compatibility') compatibility = resolvedVal;
    if (key === 'allowed-tools' || key === 'allowed_tools') allowedTools = resolvedVal;
  }

  return {
    hasFrontmatter: true,
    name,
    description,
    license,
    compatibility,
    allowedTools,
    body,
    bodyLinesCount,
    totalLinesCount,
  };
}

function stripFencedCodeBlocks(body = '') {
  const lines = String(body || '').split(/\r?\n/);
  const proseLines = [];
  const blockLengths = [];
  let inFence = false;
  let fenceLen = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^`{3,}/.test(trimmed)) {
      if (!inFence) {
        inFence = true;
        fenceLen = 0;
      } else {
        inFence = false;
        blockLengths.push(fenceLen);
      }
      continue;
    }
    if (inFence) {
      fenceLen++;
    } else {
      proseLines.push(line);
    }
  }
  return { prose: proseLines.join('\n'), proseLines, blockLengths };
}

function extractRelativeScriptRefs(body = '') {
  const refs = new Set();
  const re = /(?:^|[\s"'`(\[])((?:<skill_dir>\/|\.\/)?scripts\/([a-zA-Z0-9_.-]+\.(?:mjs|cjs|js|py|sh|ps1)))/g;
  let match;
  while ((match = re.exec(body)) !== null) {
    const fileName = match[2];
    if (fileName && !fileName.includes('<') && !fileName.includes('{')) {
      refs.add(fileName);
    }
  }
  return Array.from(refs);
}

/**
 * Evaluates a SKILL.md string for Negative Transfer anti-patterns and Progressive Disclosure health.
 * @param {string} [content='']
 * @param {string} [skillDir='']
 * @returns {{ score: number, grade: 'A'|'B'|'C'|'D', metrics: object, findings: Array<{ id: string, severity: 'error'|'warn', penalty: number, message: string }> }}
 */
export function analyzeNegativeTransfer(content = '', skillDir = '') {
  const parsed = parseYamlFrontmatter(content);
  const { prose, proseLines, blockLengths } = stripFencedCodeBlocks(parsed.body);
  const findings = [];
  let score = 100;

  const pushFinding = (id, severity, penalty, message) => {
    score -= penalty;
    findings.push({ id, severity, penalty, message });
  };

  if (!parsed.hasFrontmatter || !parsed.name || !parsed.description) {
    pushFinding(
      'FM_MISSING',
      'error',
      35,
      'Missing YAML frontmatter or required `name` / `description` fields for progressive disclosure.'
    );
  } else {
    // agentskills.io v1 specification checks (`name`, `description`, `compatibility`)
    if (
      parsed.name.length > 64 ||
      !/^[a-z0-9-]+$/.test(parsed.name) ||
      parsed.name.startsWith('-') ||
      parsed.name.endsWith('-') ||
      parsed.name.includes('--')
    ) {
      pushFinding(
        'FM_SPEC_NAME_INVALID',
        'error',
        20,
        `Frontmatter \`name\` ("${parsed.name}") violates agentskills.io spec (must be 1..64 chars, lowercase a-z0-9-, no leading/trailing '-' or '--').`
      );
    } else if (skillDir) {
      const dirBase = basename(resolve(skillDir));
      const isTempFixtureDir = /^(?:amr-|tmp-|skill-test-|quarantine-)/i.test(dirBase);
      if (!isTempFixtureDir && dirBase !== parsed.name) {
        pushFinding(
          'FM_NAME_DIR_MISMATCH',
          'warn',
          6,
          `Frontmatter \`name\` ("${parsed.name}") should match parent directory name ("${dirBase}") per agentskills.io spec.`
        );
      }
    }
    if (parsed.compatibility && parsed.compatibility.length > 500) {
      pushFinding(
        'FM_SPEC_COMPAT_OVERFLOW',
        'error',
        15,
        `Frontmatter \`compatibility\` is ${parsed.compatibility.length} chars (agentskills.io max is 500).`
      );
    }
    if (parsed.description.length > 1024) {
      pushFinding(
        'FM_SPEC_DESC_OVERFLOW',
        'error',
        20,
        `Frontmatter \`description\` is ${parsed.description.length} chars (agentskills.io max is 1024).`
      );
    }
    if (parsed.description.length < 35 || /^skill capsule for\b/i.test(parsed.description)) {
      pushFinding(
        'FM_GENERIC_DESC',
        'error',
        25,
        'Frontmatter `description` is a generic placeholder or too short (<35 chars); model cannot reliably route intent.'
      );
    }
    if (!TRIGGER_CLAUSE_RE.test(parsed.description)) {
      pushFinding(
        'FM_NO_TRIGGER_CLAUSE',
        'warn',
        10,
        'Frontmatter `description` lacks an explicit trigger clause ("Use when..." / "Используй, когда...").'
      );
    }
    if (parsed.description.length > 450) {
      pushFinding(
        'FM_OVERLONG_DESC',
        'warn',
        8,
        `Frontmatter description is ${parsed.description.length} chars (>450); keep startup catalog concise.`
      );
    }
  }

  let rigidCount = 0;
  let unexplainedRigidCount = 0;
  for (const line of proseLines) {
    if (!/^\s*(?:[-*]|\d+\.)\s+/.test(line)) continue;
    if (RIGID_DIRECTIVE_RE.test(line)) {
      rigidCount++;
      if (!CAUSAL_MARKER_RE.test(line)) {
        unexplainedRigidCount++;
      }
    }
  }
  if (unexplainedRigidCount >= 3 && unexplainedRigidCount / Math.max(1, rigidCount) > 0.5) {
    pushFinding(
      'NT_UNEXPLAINED_RIGID_CAPS',
      'warn',
      12,
      `Found ${unexplainedRigidCount}/${rigidCount} rigid uppercase rules without causal "Why" rationale (risk of Negative Transfer).`
    );
  }

  if (GENERIC_FILLER_RE.test(prose)) {
    pushFinding(
      'NT_GENERIC_FILLER',
      'warn',
      10,
      'Contains generic textbook coding advice the model already knows; keep only repository/workflow delta.'
    );
  }

  const hasReferencesDir = Boolean(skillDir && existsSync(join(skillDir, 'references')));
  if (parsed.bodyLinesCount > 320) {
    pushFinding(
      'PD_BODY_BLOAT',
      'error',
      20,
      `SKILL.md body is ${parsed.bodyLinesCount} lines (>320); offload heavy docs to \`references/\`.`
    );
  } else if (parsed.bodyLinesCount > 160 && !hasReferencesDir) {
    pushFinding(
      'PD_BODY_BLOAT',
      'warn',
      10,
      `SKILL.md body is ${parsed.bodyLinesCount} lines (>160) without \`references/\` folder for progressive disclosure.`
    );
  }

  const maxCodeBlockLines = blockLengths.length > 0 ? Math.max(...blockLengths) : 0;
  if (maxCodeBlockLines > 45) {
    pushFinding(
      'PD_INLINE_CODE_DUMP',
      'warn',
      8,
      `Inline fenced code block spans ${maxCodeBlockLines} lines (>45); extract deterministic logic into \`scripts/\`.`
    );
  }

  const scriptRefs = extractRelativeScriptRefs(parsed.body);
  if (skillDir && existsSync(skillDir) && scriptRefs.length > 0) {
    const missingScripts = scriptRefs.filter((fileName) => !existsSync(join(skillDir, 'scripts', fileName)));
    if (missingScripts.length > 0) {
      pushFinding(
        'PD_BROKEN_SCRIPT_REF',
        'error',
        25,
        `Referenced scripts missing under scripts/: ${missingScripts.join(', ')}`
      );
    }
  }

  if (!VERIFY_MENTION_RE.test(parsed.body)) {
    pushFinding(
      'PD_MISSING_VERIFY',
      'warn',
      8,
      'No verification step or check command detected in SKILL.md.'
    );
  }

  const clampedScore = Math.max(0, Math.min(100, score));
  const grade = clampedScore >= 90 ? 'A' : clampedScore >= 75 ? 'B' : clampedScore >= 60 ? 'C' : 'D';

  return {
    score: clampedScore,
    grade,
    metrics: {
      totalLines: parsed.totalLinesCount,
      bodyLines: parsed.bodyLinesCount,
      descriptionChars: parsed.description.length,
      rigidDirectives: rigidCount,
      unexplainedRigidDirectives: unexplainedRigidCount,
      maxCodeBlockLines,
      scriptRefsCount: scriptRefs.length,
      hasReferencesDir,
    },
    findings,
  };
}

function tokenizeBilingual(text = '') {
  const rawTokens = String(text || '')
    .toLowerCase()
    .match(/[a-zа-яё0-9_-]{2,}/g);
  if (!rawTokens) return [];
  const out = new Set();
  for (const tok of rawTokens) {
    out.add(tok);
    if (tok.length >= 6) {
      out.add(tok.slice(0, 5));
    }
  }
  return Array.from(out);
}

function charTrigrams(text = '') {
  const norm = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const grams = new Set();
  if (norm.length < 3) {
    if (norm) grams.add(norm);
    return grams;
  }
  for (let i = 0; i <= norm.length - 3; i++) {
    grams.add(norm.slice(i, i + 3));
  }
  return grams;
}

function jaccardSets(aSet, bSet) {
  if (!aSet.size || !bSet.size) return 0;
  let inter = 0;
  for (const item of aSet) {
    if (bSet.has(item)) inter++;
  }
  const union = aSet.size + bSet.size - inter;
  return union > 0 ? inter / union : 0;
}

function computeBm25fSkillScore(query, skill) {
  const qTokens = tokenizeBilingual(query);
  if (qTokens.length === 0) return 0;

  const nameSet = new Set(tokenizeBilingual(`${skill.slug || ''} ${skill.name || ''}`));
  const descSet = new Set(tokenizeBilingual(skill.description || ''));
  const headSet = new Set(tokenizeBilingual(skill.headings || ''));

  let weightedHits = 0;
  for (const tok of qTokens) {
    let tf = 0;
    if (nameSet.has(tok)) tf += 2.5;
    if (descSet.has(tok)) tf += 2.0;
    if (headSet.has(tok)) tf += 1.0;
    if (tf > 0) {
      weightedHits += tf / (tf + 1.2);
    }
  }

  const lexScore = weightedHits / Math.max(1, Math.min(qTokens.length, 8));
  const triScore = jaccardSets(charTrigrams(query), charTrigrams(`${skill.name || ''} ${skill.description || ''}`));
  return Number((lexScore + 0.35 * triScore).toFixed(4));
}

function buildSyntheticProbes(targetSkill) {
  const desc = String(targetSkill.description || '').trim();
  const cleanHeadings = String(targetSkill.headings || '')
    .split(/\s+/)
    .filter((w) => w.length >= 4)
    .slice(0, 6)
    .join(' ');
  const probes = [];
  if (desc) {
    probes.push(desc.slice(0, 140));
    const triggerSplit = desc.split(/(?:use\s+when|используй,?\s+когда|при\s+)/i);
    if (triggerSplit.length > 1 && triggerSplit[1].trim().length >= 12) {
      probes.push(triggerSplit[1].trim().slice(0, 120));
    }
  }
  const humanSlug = String(targetSkill.slug || targetSkill.name || '').replace(/-/g, ' ').trim();
  if (humanSlug || cleanHeadings) {
    probes.push(`${humanSlug} ${cleanHeadings}`.trim());
  }
  return Array.from(new Set(probes.filter(Boolean))).slice(0, 3);
}

/**
 * Evaluates local BM25F + trigram trigger precision/recall and sibling collisions at 0 cloud tokens.
 * @param {object} params
 * @returns {{ recall: number, specificity: number, falseNegatives: string[], falsePositives: string[], collisions: Array<{ slug: string, similarity: number }>, syntheticProbesUsed: boolean }}
 */
export function evaluateSkillTriggers({
  targetSkill,
  siblingSkills = [],
  positivePrompts = [],
  negativePrompts = [],
} = {}) {
  const safeTarget = targetSkill && typeof targetSkill === 'object' ? targetSkill : {};
  const safeSiblings = Array.isArray(siblingSkills) ? siblingSkills.filter(Boolean) : [];
  const targetDescTokens = new Set(tokenizeBilingual(`${safeTarget.name || ''} ${safeTarget.description || ''}`));
  const targetTrigrams = charTrigrams(safeTarget.description || '');

  const collisions = [];
  for (const sib of safeSiblings) {
    if (sib.slug === safeTarget.slug) continue;
    const sibTokens = new Set(tokenizeBilingual(`${sib.name || ''} ${sib.description || ''}`));
    const sibTrigrams = charTrigrams(sib.description || '');
    const sim = Number((0.6 * jaccardSets(targetDescTokens, sibTokens) + 0.4 * jaccardSets(targetTrigrams, sibTrigrams)).toFixed(3));
    if (sim >= 0.55) {
      collisions.push({ slug: sib.slug, similarity: sim });
    }
  }
  collisions.sort((a, b) => b.similarity - a.similarity);

  const syntheticProbesUsed = !Array.isArray(positivePrompts) || positivePrompts.length === 0;
  const posList = syntheticProbesUsed ? buildSyntheticProbes(safeTarget) : positivePrompts;
  const negList = Array.isArray(negativePrompts) ? negativePrompts : [];

  const falseNegatives = [];
  for (const prompt of posList) {
    const targetScore = computeBm25fSkillScore(prompt, safeTarget);
    let topSibScore = 0;
    for (const sib of safeSiblings) {
      if (sib.slug === safeTarget.slug) continue;
      const s = computeBm25fSkillScore(prompt, sib);
      if (s > topSibScore) topSibScore = s;
    }
    if (!(targetScore > 0 && targetScore >= topSibScore * 0.85)) {
      falseNegatives.push(prompt);
    }
  }

  const falsePositives = [];
  for (const prompt of negList) {
    const targetScore = computeBm25fSkillScore(prompt, safeTarget);
    let topSibScore = 0;
    for (const sib of safeSiblings) {
      if (sib.slug === safeTarget.slug) continue;
      const s = computeBm25fSkillScore(prompt, sib);
      if (s > topSibScore) topSibScore = s;
    }
    if (targetScore > topSibScore && targetScore >= 0.35) {
      falsePositives.push(prompt);
    }
  }

  const recall = posList.length > 0 ? Number(((posList.length - falseNegatives.length) / posList.length).toFixed(3)) : 1;
  const specificity = negList.length > 0 ? Number(((negList.length - falsePositives.length) / negList.length).toFixed(3)) : 1;

  return {
    recall,
    specificity,
    falseNegatives,
    falsePositives,
    collisions,
    syntheticProbesUsed,
  };
}

function loadSkillMeta(skillDir) {
  const skillMdPath = join(skillDir, 'SKILL.md');
  if (!existsSync(skillMdPath)) return null;
  const content = readFileSync(skillMdPath, 'utf-8');
  const parsed = parseYamlFrontmatter(content);
  const headings = parsed.body
    .split(/\r?\n/)
    .filter((l) => /^#{1,3}\s+/.test(l))
    .map((l) => l.replace(/^#{1,3}\s+/, '').trim())
    .join(' ');
  const slug = basename(skillDir);
  return {
    slug,
    name: parsed.name || slug,
    description: parsed.description || '',
    headings,
    content,
    skillDir,
  };
}

function loadSiblingSkills(skillsRoot, excludeSlug = '') {
  if (!skillsRoot || !existsSync(skillsRoot)) return [];
  const list = [];
  try {
    for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === excludeSlug) continue;
      const meta = loadSkillMeta(join(skillsRoot, entry.name));
      if (meta) list.push(meta);
    }
  } catch {}
  return list;
}

function loadEvalPrompts(skillDir, explicitEvalFile = '') {
  const candidates = explicitEvalFile
    ? [resolve(explicitEvalFile)]
    : [join(skillDir, 'evals', 'evals.json')];
  for (const cand of candidates) {
    if (!existsSync(cand)) continue;
    try {
      const parsed = JSON.parse(readFileSync(cand, 'utf-8'));
      const positive = Array.isArray(parsed?.positive) ? parsed.positive.map(String) : [];
      const negative = Array.isArray(parsed?.negative) ? parsed.negative.map(String) : [];
      if (Array.isArray(parsed?.evals)) {
        for (const item of parsed.evals) {
          if (!item?.prompt) continue;
          if (item.should_trigger === false) negative.push(String(item.prompt));
          else positive.push(String(item.prompt));
        }
      }
      return { positive, negative };
    } catch {}
  }
  return { positive: [], negative: [] };
}

/**
 * Audits a single skill folder or slug inside `skillsRoot`.
 * @param {string} targetPathOrSlug
 * @param {object} [options={}]
 * @returns {object}
 */
export function auditSkill(targetPathOrSlug, { skillsRoot = DEFAULT_SKILLS_ROOT, evalFile = '' } = {}) {
  const rawTarget = String(targetPathOrSlug || '').trim();
  const directCandidate = rawTarget ? resolve(rawTarget) : '';
  let skillDir = '';

  if (directCandidate && existsSync(join(directCandidate, 'SKILL.md'))) {
    skillDir = directCandidate;
  } else if (directCandidate && basename(directCandidate) === 'SKILL.md' && existsSync(directCandidate)) {
    skillDir = dirname(directCandidate);
  } else {
    skillDir = join(resolve(skillsRoot), rawTarget);
  }

  const meta = loadSkillMeta(skillDir);
  if (!meta) {
    return {
      ok: false,
      slug: rawTarget || 'unknown',
      name: rawTarget || 'unknown',
      skillDir,
      score: 0,
      grade: 'D',
      errorsCount: 1,
      warningsCount: 0,
      findings: [{ id: 'SKILL_NOT_FOUND', severity: 'error', penalty: 100, message: `SKILL.md not found in ${skillDir}` }],
      triggerEval: { recall: 0, specificity: 1, falseNegatives: [], falsePositives: [], collisions: [], syntheticProbesUsed: true },
      metrics: {},
    };
  }

  const nt = analyzeNegativeTransfer(meta.content, skillDir);
  const siblingsRoot = existsSync(skillsRoot) ? resolve(skillsRoot) : dirname(skillDir);
  const siblings = loadSiblingSkills(siblingsRoot, meta.slug);
  const evals = loadEvalPrompts(skillDir, evalFile);
  const triggerEval = evaluateSkillTriggers({
    targetSkill: meta,
    siblingSkills: siblings,
    positivePrompts: evals.positive,
    negativePrompts: evals.negative,
  });

  const findings = [...nt.findings];
  let score = nt.score;
  if (triggerEval.collisions.length > 0) {
    score = Math.max(0, score - 8);
    findings.push({
      id: 'TRIG_SIBLING_COLLISION',
      severity: 'warn',
      penalty: 8,
      message: `High trigger similarity (>=0.55) with sibling skill(s): ${triggerEval.collisions.map((c) => `${c.slug} (${c.similarity})`).join(', ')}`,
    });
  }
  if (triggerEval.falsePositives.length > 0) {
    score = Math.max(0, score - 10);
    findings.push({
      id: 'TRIG_FALSE_POSITIVE',
      severity: 'warn',
      penalty: 10,
      message: `False positive triggers on ${triggerEval.falsePositives.length} negative prompt(s).`,
    });
  }

  const grade = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : 'D';
  const errorsCount = findings.filter((f) => f.severity === 'error').length;
  const warningsCount = findings.filter((f) => f.severity === 'warn').length;

  return {
    ok: errorsCount === 0,
    slug: meta.slug,
    name: meta.name,
    skillDir,
    score,
    grade,
    errorsCount,
    warningsCount,
    findings,
    triggerEval,
    metrics: nt.metrics,
  };
}

/**
 * Audits all skills in a skills root directory.
 * @param {string} [skillsRoot=DEFAULT_SKILLS_ROOT]
 * @returns {{ ok: boolean, total: number, averageScore: number, results: object[] }}
 */
export function auditAllSkills(skillsRoot = DEFAULT_SKILLS_ROOT) {
  const root = resolve(skillsRoot);
  if (!existsSync(root)) {
    return { ok: false, total: 0, averageScore: 0, results: [] };
  }
  const slugs = readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(root, d.name, 'SKILL.md')))
    .map((d) => d.name)
    .sort();

  const results = slugs.map((slug) => auditSkill(slug, { skillsRoot: root }));
  const total = results.length;
  const averageScore = total > 0 ? Math.round(results.reduce((sum, r) => sum + r.score, 0) / total) : 0;
  const ok = results.every((r) => r.ok);

  return { ok, total, averageScore, results };
}

function isExecutedDirectly() {
  try {
    if (!process.argv[1]) return false;
    const self = resolve(fileURLToPath(import.meta.url));
    const arg = resolve(process.argv[1]);
    return process.platform === 'win32' ? self.toLowerCase() === arg.toLowerCase() : self === arg;
  } catch {
    return false;
  }
}

if (isExecutedDirectly()) {
  const args = process.argv.slice(2);
  let runAll = false;
  let asJson = false;
  let strict = false;
  let skillsRoot = DEFAULT_SKILLS_ROOT;
  let evalFile = '';
  let target = '';
  let outFile = '';

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--all') runAll = true;
    else if (a === '--json') asJson = true;
    else if (a === '--strict') strict = true;
    else if (a === '--skills-root' && i + 1 < args.length) skillsRoot = args[++i];
    else if (a === '--eval' && i + 1 < args.length) evalFile = args[++i];
    else if (a.startsWith('--output=')) outFile = resolve(a.slice('--output='.length));
    else if ((a === '--output' || a === '-o') && i + 1 < args.length) outFile = resolve(args[++i]);
    else if (!a.startsWith('-') && !target) target = a;
  }

  if (!runAll && !target) {
    console.error('Usage: node audit-skill.mjs (<slugOrDir> | --all) [--skills-root <dir>] [--eval <evals.json>] [--json] [--strict] [--output <path>]');
    process.exit(1);
  }

  const resolvedTargetDir = target ? resolve(process.cwd(), target) : '';
  const isSkillsBatchDir =
    !runAll &&
    Boolean(resolvedTargetDir) &&
    existsSync(resolvedTargetDir) &&
    statSync(resolvedTargetDir).isDirectory() &&
    !existsSync(join(resolvedTargetDir, 'SKILL.md')) &&
    readdirSync(resolvedTargetDir, { withFileTypes: true }).some(
      (entry) => entry.isDirectory() && existsSync(join(resolvedTargetDir, entry.name, 'SKILL.md'))
    );

  const output = runAll
    ? auditAllSkills(skillsRoot)
    : isSkillsBatchDir
      ? auditAllSkills(resolvedTargetDir)
      : auditSkill(target, { skillsRoot, evalFile });

  const outLines = [];
  if (asJson) {
    outLines.push(JSON.stringify(output, null, 2));
  } else if (runAll || isSkillsBatchDir) {
    outLines.push(`🏗️ [Skill-Architect Audit] Skills: ${output.total} | Avg Score: ${output.averageScore}/100`);
    for (const r of output.results) {
      const status = r.ok ? '✅' : '❌';
      outLines.push(`  ${status} ${r.slug}: ${r.score}/100 (${r.grade}) | err:${r.errorsCount} warn:${r.warningsCount} | recall:${r.triggerEval.recall}`);
      for (const f of r.findings) {
        outLines.push(`     - [${f.severity.toUpperCase()} ${f.id}] ${f.message}`);
      }
    }
  } else {
    const status = output.ok ? '✅' : '❌';
    outLines.push(`${status} [Skill-Architect] ${output.slug}: ${output.score}/100 (Grade ${output.grade}) | Recall: ${output.triggerEval.recall} | Specificity: ${output.triggerEval.specificity}`);
    for (const f of output.findings) {
      outLines.push(`  - [${f.severity.toUpperCase()} ${f.id}] ${f.message}`);
    }
  }
  const renderedOut = outLines.join('\n');
  if (outFile) {
    mkdirSync(dirname(outFile), { recursive: true });
    writeFileSync(outFile, renderedOut + '\n', 'utf8');
  } else {
    console.log(renderedOut);
  }

  const isBatchMode = runAll || isSkillsBatchDir;
  const failed = !output.ok || (strict && (isBatchMode ? output.results.some((r) => r.warningsCount > 0) : output.warningsCount > 0));
  if (failed) process.exit(1);
}

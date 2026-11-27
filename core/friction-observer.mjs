/**
 * @file friction-observer.mjs
 * @description Task-Observer style Friction Detector:
 *   1. Captures explicit RU/EN user correction cues and undo-redo edit churn.
 *   2. Persists observations into SqliteKnowledgeHub `project_instincts` for confidence accumulation.
 *   3. Strictly non-destructive: never edits SKILL.md directly until explicit promotion via evolveReadyInstincts.
 */

import { basename, dirname, resolve } from 'node:path';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureTunnelCacheDir, resolveTunnelCacheDir } from './cache-dir.mjs';
import { safeReadJsonSync, updateJsonAtomicSync } from './safe-json.mjs';
import { redactSecretsInText } from './security-guard.mjs';
import { knowledgeHub } from './sqlite-knowledge-hub.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, '..');
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty']);
const CHURN_TTL_MS = 30 * 60 * 1000;
const MAX_EDIT_EVENTS_PER_CONVO = 12;

const USER_CORRECTION_PATTERNS = [
  /(?:^|[\s,.!?;:])(?:нет|неа|стоп|подожди)[,\s]+(?:не\s+так|так\s+не\s+надо|не\s+нужно|не\s+трогай|не\s+меняй|переделай)/i,
  /(?:почему|зачем)\s+ты\s+(?:снова|опять|ещ[её]\s+раз|удалил|сломал|забыл|игнорируешь)/i,
  /(?:ты\s+(?:забыл|пропустил|упустил|перепутал|сломал|опять\s+сделал)|я\s+же\s+(?:говорил|просил|писал))/i,
  /(?:переделай\s+нормально|хватит\s+(?:гадать|выдумывать|переписывать))/i,
  /(?:^|[\s,.!?;:])(?:no|nope|stop)[,\s]+(?:not\s+like\s+that|don'?t\s+do\s+that|do\s+not\s+change|revert\s+that)/i,
  /(?:why\s+did\s+you\s+again|you\s+forgot\s+to|i\s+already\s+(?:told|asked)\s+you|stop\s+(?:doing|adding|guessing)\s+that)/i,
];

const IGNORE_CORRECTION_CONTEXT_RE = /^(?:\[plan review|\s*A\d+\s*:|(?:да|ок|хорошо|подтверждаю|запускай|продолжай|approve|yes)\b)/i;

function normConvoKey(conversationId = '') {
  const s = String(conversationId || 'default').trim().slice(0, 120);
  if (!s || UNSAFE_KEYS.has(s)) return 'default';
  return s;
}

function getChurnWindowPath(customPath = '') {
  if (typeof customPath === 'string' && customPath.trim()) return resolve(customPath.trim());
  return join(ensureTunnelCacheDir(resolveTunnelCacheDir(PLUGIN_ROOT)), 'friction-window.json');
}

function cleanSnippet(raw = '', maxLen = 130) {
  return redactSecretsInText(String(raw || ''))
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

/**
 * Detects explicit user correction friction in prompts while ignoring normal questions and plan approvals.
 * @param {string} [userPrompt='']
 * @param {object} [context={}]
 * @returns {{ detected: boolean, signalType: 'user_correction'|'none', candidatePattern: string, category: 'invariant', targetSkillHint: string }}
 */
export function detectUserCorrectionFriction(userPrompt = '', context = {}) {
  const text = typeof userPrompt === 'string' ? userPrompt.trim() : String(userPrompt || '').trim();
  const empty = { detected: false, signalType: 'none', candidatePattern: '', category: 'invariant', targetSkillHint: '' };
  if (text.length < 10 || text.length > 2000 || IGNORE_CORRECTION_CONTEXT_RE.test(text)) {
    return empty;
  }

  const matched = USER_CORRECTION_PATTERNS.some((rx) => rx.test(text));
  if (!matched) return empty;

  const files = Array.isArray(context?.touchedFiles)
    ? context.touchedFiles.slice(0, 3).map((f) => {
        const rawPath = typeof f === 'string' ? f : (f?.file || f?.filePath || '');
        return basename(String(rawPath || ''));
      }).filter(Boolean)
    : [];
  const topSkill = Array.isArray(context?.semanticSkills) && context.semanticSkills[0]?.slug
    ? String(context.semanticSkills[0].slug)
    : '';
  const excerpt = cleanSnippet(text, 125);
  const fileScope = files.length > 0 ? ` [${files.join(', ')}]` : '';
  const candidatePattern = `Avoid repeated user correction${fileScope}: "${excerpt}"`;

  return {
    detected: true,
    signalType: 'user_correction',
    candidatePattern,
    category: 'invariant',
    targetSkillHint: topSkill,
  };
}

/**
 * Detects undo-redo oscillation or rapid repeated re-edits on the same code block within 3 minutes.
 * @param {object} [params={}]
 * @returns {{ detected: boolean, signalType: 'revert_churn'|'none', candidatePattern: string, filePath: string }}
 */
export function detectEditChurnFriction(opts = {}) {
  const {
    conversationId = 'default',
    filePath = '',
    targetText = '',
    replacementText = '',
    workspaceRoot = '',
    stateFile = '',
    nowMs = Date.now(),
  } = opts && typeof opts === 'object' ? opts : {};
  const cleanFile = String(filePath || '').replace(/\\/g, '/').trim();
  const empty = { detected: false, signalType: 'none', candidatePattern: '', filePath: cleanFile };
  if (!cleanFile) return empty;

  const targetNorm = String(targetText || '').replace(/\s+/g, ' ').trim().slice(0, 260);
  const replaceNorm = String(replacementText || '').replace(/\s+/g, ' ').trim().slice(0, 260);
  if (!targetNorm && !replaceNorm) return empty;

  const cid = normConvoKey(conversationId);
  const winPath = getChurnWindowPath(stateFile);
  let detectedReason = '';

  updateJsonAtomicSync(winPath, () => ({ windows: {}, cliFails: {} }), (cur) => {
    const rawWins = cur?.windows && typeof cur.windows === 'object' && !Array.isArray(cur.windows) ? cur.windows : {};
    const nextWins = {};
    for (const [k, v] of Object.entries(rawWins)) {
      if (!k || UNSAFE_KEYS.has(k) || !v || (nowMs - Number(v.updatedAt || 0)) >= CHURN_TTL_MS) continue;
      nextWins[k] = v;
    }

    const prevEvents = Array.isArray(nextWins[cid]?.events) ? nextWins[cid].events : [];
    const recentSameFile = prevEvents.filter(
      (e) => e && e.file === cleanFile && (nowMs - Number(e.ts || 0)) <= 3 * 60 * 1000
    );

    const hasRevertOscillation = Boolean(
      replaceNorm &&
      recentSameFile.some((e) => e.targetNorm && e.targetNorm === replaceNorm && e.replaceNorm === targetNorm)
    );
    const rapidBlockEdits = recentSameFile.length >= 2 && targetNorm && recentSameFile.some(
      (e) => e.replaceNorm && (e.replaceNorm.includes(targetNorm.slice(0, 48)) || targetNorm.includes(e.replaceNorm.slice(0, 48)))
    );

    if (hasRevertOscillation) {
      detectedReason = 'undo_redo_oscillation';
    } else if (rapidBlockEdits) {
      detectedReason = 'rapid_block_reedit';
    }

    const updatedEvents = detectedReason
      ? prevEvents.filter((e) => e && e.file !== cleanFile && (nowMs - Number(e.ts || 0)) < CHURN_TTL_MS).slice(-MAX_EDIT_EVENTS_PER_CONVO)
      : [
          ...prevEvents.filter((e) => e && (nowMs - Number(e.ts || 0)) < CHURN_TTL_MS),
          { file: cleanFile, targetNorm, replaceNorm, ts: nowMs },
        ].slice(-MAX_EDIT_EVENTS_PER_CONVO);

    nextWins[cid] = { updatedAt: nowMs, events: updatedEvents };
    return {
      windows: nextWins,
      cliFails: cur?.cliFails && typeof cur.cliFails === 'object' && !Array.isArray(cur.cliFails) ? cur.cliFails : {},
    };
  }, { spaces: 0 });

  if (!detectedReason) return empty;

  const base = basename(cleanFile);
  const candidatePattern = detectedReason === 'undo_redo_oscillation'
    ? `Verify invariants in ${base} before patching to avoid undo-redo edit oscillation`
    : `Inspect surrounding callers and invariants in ${base} once before applying multi-pass edits`;

  return {
    detected: true,
    signalType: 'revert_churn',
    candidatePattern,
    filePath: cleanFile,
  };
}

const CLI_ERROR_CLASSIFIERS = [
  { type: 'unknown_flag', re: /(?:unknown\s+(?:option|flag|argument)|unrecognized\s+(?:option|argument)|invalid\s+option|unexpected\s+argument|bad\s+option|no\s+such\s+option|parameter\s+cannot\s+be\s+found)/i },
  { type: 'command_not_found', re: /(?:command\s+not\s+found|is\s+not\s+recognized\s+as\s+an?\s+internal|not\s+recognized\s+as\s+the\s+name\s+of\s+a\s+cmdlet|ENOENT)/i },
  { type: 'wrong_path', re: /(?:no\s+such\s+file\s+or\s+directory|cannot\s+find\s+path|does\s+not\s+exist|cannot\s+open\s+file|path\s+not\s+found)/i },
  { type: 'missing_arg', re: /(?:missing\s+(?:required\s+)?(?:argument|operand|parameter)|requires\s+an?\s+(?:argument|value)|expected\s+at\s+least)/i },
  { type: 'permission_denied', re: /(?:permission\s+denied|access\s+is\s+denied|EACCES|EPERM)/i },
  { type: 'wrong_syntax', re: /(?:syntax\s+error|unexpected\s+token|parse\s+error|invalid\s+syntax)/i },
];

function extractBaseCliCommand(rawCmd = '') {
  let cleaned = String(rawCmd || '').trim();
  const posixAssignRe = /^[A-Za-z_][A-Za-z0-9_]*=\S+\s+/;
  const psAssignRe = /^\$env:[A-Za-z_][A-Za-z0-9_]*=\S+;\s*/i;
  for (let i = 0; i < 16; i++) {
    if (posixAssignRe.test(cleaned)) {
      cleaned = cleaned.replace(posixAssignRe, '');
    } else if (psAssignRe.test(cleaned)) {
      cleaned = cleaned.replace(psAssignRe, '');
    } else {
      break;
    }
  }
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  const first = basename(parts[0].replace(/^["']|["']$/g, '')).replace(/\.(?:exe|cmd|bat)$/i, '').toLowerCase();
  if ((first === 'npx' || first === 'npm' || first === 'pnpm' || first === 'yarn' || first === 'git' || first === 'node' || first === 'python' || first === 'python3' || first === 'cargo' || first === 'go') && parts[1] && !parts[1].startsWith('-')) {
    return `${first} ${parts[1].toLowerCase()}`;
  }
  return first;
}

function classifyCliError(errorOutput = '') {
  const txt = String(errorOutput || '');
  for (const item of CLI_ERROR_CLASSIFIERS) {
    if (item.re.test(txt)) return item.type;
  }
  return 'other';
}

/**
 * CLI Fail->Succeed Learner (inspired by rtk/src/learn):
 * Records failed CLI invocations per conversation and detects when a subsequent run of the
 * same base command succeeds with corrected flags/paths within 5 minutes.
 * @param {object} [opts={}]
 * @returns {{ detected: boolean, signalType: 'cli_correction'|'none', errorType: string, baseCommand: string, wrongCmd: string, rightCmd: string, candidatePattern: string }}
 */
export function detectCliFailRecoveryFriction(opts = {}) {
  const {
    conversationId = 'default',
    commandLine = '',
    exitCode = 0,
    errorOutput = '',
    stateFile = '',
    nowMs = Date.now(),
  } = opts && typeof opts === 'object' ? opts : {};

  const cmd = cleanSnippet(commandLine, 180);
  const empty = { detected: false, signalType: 'none', errorType: '', baseCommand: '', wrongCmd: '', rightCmd: '', candidatePattern: '' };
  if (!cmd || cmd.length < 3) return empty;

  const baseCommand = extractBaseCliCommand(cmd);
  if (!baseCommand) return empty;

  const cid = normConvoKey(conversationId);
  const winPath = getChurnWindowPath(stateFile);
  let matchedFail = null;

  updateJsonAtomicSync(winPath, () => ({ windows: {}, cliFails: {} }), (cur) => {
    const rawFails = cur?.cliFails && typeof cur.cliFails === 'object' && !Array.isArray(cur.cliFails) ? cur.cliFails : {};
    const nextFails = {};
    for (const [k, v] of Object.entries(rawFails)) {
      if (!k || UNSAFE_KEYS.has(k) || !v || (nowMs - Number(v.updatedAt || 0)) >= CHURN_TTL_MS) continue;
      nextFails[k] = v;
    }

    const prevList = Array.isArray(nextFails[cid]?.events) ? nextFails[cid].events : [];
    const freshList = prevList.filter((e) => e && (nowMs - Number(e.ts || 0)) <= 5 * 60 * 1000);

    if (Number(exitCode) !== 0) {
      const errorType = classifyCliError(errorOutput);
      const updated = [
        ...freshList,
        { baseCommand, cmd, errorType, ts: nowMs },
      ].slice(-10);
      nextFails[cid] = { updatedAt: nowMs, events: updated };
    } else {
      for (let i = freshList.length - 1; i >= 0; i--) {
        const ev = freshList[i];
        if (ev.baseCommand === baseCommand && ev.cmd !== cmd) {
          matchedFail = ev;
          freshList.splice(i, 1);
          break;
        }
      }
      nextFails[cid] = { updatedAt: nowMs, events: freshList };
    }

    return {
      windows: cur?.windows && typeof cur.windows === 'object' && !Array.isArray(cur.windows) ? cur.windows : {},
      cliFails: nextFails,
    };
  }, { spaces: 0 });

  if (!matchedFail) return empty;

  const wrongShort = matchedFail.cmd.slice(0, 75);
  const rightShort = cmd.slice(0, 75);
  const candidatePattern = `CLI correction (${matchedFail.errorType}) for "${baseCommand}": avoid \`${wrongShort}\`, use \`${rightShort}\``;

  return {
    detected: true,
    signalType: 'cli_correction',
    errorType: matchedFail.errorType,
    baseCommand,
    wrongCmd: matchedFail.cmd,
    rightCmd: cmd,
    candidatePattern,
  };
}

/**
 * Records a friction observation into SqliteKnowledgeHub project_instincts without modifying SKILL.md directly.
 * @param {object} [params={}]
 */
export function recordFrictionObservation(rawOpts = {}) {
  const {
    workspaceRoot = '',
    signalType = 'user_correction',
    pattern = '',
    targetSkill = '',
    hub = knowledgeHub,
    nowMs = Date.now(),
    lang = 'ru',
  } = rawOpts && typeof rawOpts === 'object' ? rawOpts : {};
  const cleanPattern = cleanSnippet(pattern, 220);
  if (!cleanPattern || !workspaceRoot || !hub || typeof hub.recordInstinct !== 'function') {
    return { ok: false, recorded: false, readyForPromotion: false, instinctId: '', confidence: 0, promotionHint: '' };
  }

  const res = hub.recordInstinct({
    workspaceRoot,
    pattern: cleanPattern,
    category: 'invariant',
    initialConfidence: 0.42,
    nowMs,
  });

  if (!res?.ok) {
    return { ok: false, recorded: false, readyForPromotion: false, instinctId: '', confidence: 0, promotionHint: '' };
  }

  const isEn = String(lang || '').trim().toLowerCase() === 'en';
  const ready = Boolean(res.readyForPromotion);
  const skillRef = targetSkill ? ` into skill "${targetSkill}"` : '';
  const cliPath = join(PLUGIN_ROOT, 'core', 'router-cli.mjs');
  const cliRef = /\s/.test(cliPath) ? `"${cliPath}"` : cliPath;
  const confPct = Math.round((res.effectiveConfidence || 0) * 100);
  const promotionHint = ready
    ? (isEn
        ? `🔎 [Task-Observer] Recurring friction (${signalType}) reached ${confPct}% confidence. Candidate ready for crystallization${skillRef}: \`node ${cliRef} evolve\`.`
        : `🔎 [Task-Observer] Повторяющееся трение (${signalType}) набрало ${confPct}% уверенности. Кандидат готов к кристаллизации${skillRef}: \`node ${cliRef} evolve\`.`)
    : '';

  return {
    ok: true,
    recorded: true,
    readyForPromotion: ready,
    instinctId: String(res.id || ''),
    confidence: Number(res.effectiveConfidence || res.confidence || 0.42),
    evidenceCount: Number(res.evidenceCount || 1),
    promotionHint,
  };
}

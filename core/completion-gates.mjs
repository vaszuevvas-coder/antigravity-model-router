/**
 * @file completion-gates.mjs
 * @description Unlazy-inspired completion discipline & stop-gate verifier:
 *   1. Strictly read-only GATES.md acceptance ledger parser (never executes CHECK: commands).
 *   2. Line-level diff scanner catching newly added TODO/FIXME/unimplemented stubs (ignores HTML placeholder="").
 *   3. Session stub ledger & project completion invariants (ui.html bundle freshness, unmet GATES.md).
 *   4. Stop-hook anti-loop evaluator capped by maxBlocks.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureTunnelCacheDir, resolveTunnelCacheDir } from './cache-dir.mjs';
import { safeReadJsonSync, updateJsonAtomicSync } from './safe-json.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, '..');
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty']);
const STUB_STATE_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_CONVOS = 40;

function getStateFilePath(customPath = '') {
  if (typeof customPath === 'string' && customPath.trim()) {
    return resolve(customPath.trim());
  }
  return join(ensureTunnelCacheDir(resolveTunnelCacheDir(PLUGIN_ROOT)), 'completion-gates-state.json');
}

function defaultState() {
  return { conversations: {}, stopBlocks: {}, verification: {}, reuse: {} };
}

function normWsKey(ws = '') {
  const s = String(ws || '').trim();
  if (!s) return '';
  try {
    const abs = resolve(s);
    return (process.platform === 'win32' ? abs.toLowerCase() : abs).replace(/\\/g, '/').replace(/\/+$/, '');
  } catch {
    return s.replace(/\\/g, '/');
  }
}

function normConvoKey(conversationId = '') {
  const s = String(conversationId || 'default').trim().slice(0, 120);
  if (!s || UNSAFE_KEYS.has(s)) return 'default';
  return s;
}

function pruneMapByTs(obj, nowMs = Date.now()) {
  const out = {};
  const entries = Object.entries(obj && typeof obj === 'object' ? obj : {})
    .filter(([k, v]) => k && !UNSAFE_KEYS.has(k) && v && typeof v === 'object' && (nowMs - Number(v.updatedAt || 0)) < STUB_STATE_TTL_MS)
    .sort((a, b) => Number(b[1].updatedAt || 0) - Number(a[1].updatedAt || 0))
    .slice(0, MAX_CONVOS);
  for (const [k, v] of entries) out[k] = v;
  return out;
}

/**
 * Strictly read-only parser for GATES.md acceptance ledgers (inspired by Leonxlnx/unlazy).
 * Never executes CHECK: shell lines.
 * @param {string} [markdown='']
 * @returns {{ total: number, met: Array<object>, unmet: Array<object>, abandoned: Array<object>, malformed: Array<string> }}
 */
export function parseAcceptanceGatesMarkdown(markdown = '') {
  const text = typeof markdown === 'string' ? markdown : String(markdown || '');
  if (!text.trim()) {
    return { total: 0, met: [], unmet: [], abandoned: [], malformed: [] };
  }

  const lines = text.split(/\r?\n/);
  const gates = [];
  const seenIds = new Set();
  const abandonedMap = new Map();
  const malformed = [];
  let current = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();

    const abandonMatch = /^ABANDON:\s*([A-Za-z0-9._-]+)(?:\s+(.*))?$/.exec(trimmed);
    if (abandonMatch) {
      const id = abandonMatch[1];
      const reason = String(abandonMatch[2] || '').trim();
      if (!reason) {
        malformed.push(`Line ${i + 1}: ABANDON ${id} missing non-empty reason`);
      } else {
        abandonedMap.set(id, reason);
      }
      current = null;
      continue;
    }

    const boxMatch = /^[-*]\s+\[([ xX])\]\s+(?:([A-Za-z0-9._-]+):\s*)?(.+)$/.exec(trimmed);
    if (boxMatch) {
      const checked = boxMatch[1].toLowerCase() === 'x';
      const id = boxMatch[2] ? boxMatch[2].trim() : `gate-${gates.length + 1}`;
      const title = boxMatch[3].trim();
      if (seenIds.has(id)) {
        malformed.push(`Line ${i + 1}: duplicate gate id "${id}"`);
      }
      seenIds.add(id);
      current = { id, title, checked, hasCheck: false, hasExpect: false, line: i + 1 };
      gates.push(current);
      continue;
    }

    if (current && /^\s+(CHECK|EXPECT):/.test(raw)) {
      if (trimmed.startsWith('CHECK:')) current.hasCheck = true;
      if (trimmed.startsWith('EXPECT:')) current.hasExpect = true;
      continue;
    }

    if (trimmed === '' || trimmed.startsWith('#')) {
      current = null;
    }
  }

  const met = [];
  const unmet = [];
  const abandoned = [];

  for (const g of gates) {
    if (abandonedMap.has(g.id)) {
      abandoned.push({ ...g, reason: abandonedMap.get(g.id) });
    } else if (g.checked) {
      met.push(g);
    } else {
      unmet.push(g);
    }
  }

  for (const [abId, reason] of abandonedMap.entries()) {
    if (!seenIds.has(abId)) {
      abandoned.push({ id: abId, title: reason, checked: false, hasCheck: false, hasExpect: false, line: 0, reason });
    }
  }

  return {
    total: gates.length,
    met,
    unmet,
    abandoned,
    malformed,
  };
}

const SKIP_STUB_EXT_RE = /\.(?:md|txt|json|csv|svg|lock|map|html?)$/i;
const SKIP_STUB_TEST_RE = /(?:^|[/\\])(?:tests?|__tests__|fixtures?|benchmarks?)[/\\]|\.(?:test|spec)\.[cm]?[jt]sx?$/i;

const STUB_PATTERNS = [
  { kind: 'todo_comment', rx: /(?:\/\/|#|\/\*)\s*(?:TODO|FIXME|XXX)\b(?:\s*[:(-]|\s+\S)/i },
  { kind: 'not_implemented_throw', rx: /\bthrow\s+new\s+(?:Error|TypeError)\s*\(\s*['"`](?:not\s+implemented|unimplemented|todo)\b/i },
  { kind: 'not_implemented_py_rs', rx: /\b(?:NotImplementedError\s*\(|todo!\s*\(|unimplemented!\s*\()/ },
  { kind: 'stub_marker', rx: /(?:\/\/|#|\*)\s*(?:placeholder|stub)\s+implementation\b/i },
];

/**
 * Computes added lines via multiset frequency diff and checks only newly introduced lines for stub markers.
 * Pre-existing TODOs and HTML `placeholder="..."` attributes are never flagged.
 * @param {string} [oldText='']
 * @param {string} [newText='']
 * @param {string} [filePath='']
 * @returns {{ ok: boolean, skipped: boolean, issues: Array<{ line: number, kind: string, excerpt: string }> }}
 */
export function scanAddedStubsInDiff(oldText = '', newText = '', filePath = '') {
  const cleanPath = String(filePath || '').replace(/\\/g, '/');
  if (cleanPath && (SKIP_STUB_EXT_RE.test(cleanPath) || SKIP_STUB_TEST_RE.test(cleanPath) || /(?:^|\/)completion-gates\.mjs$/i.test(cleanPath))) {
    return { ok: true, skipped: true, issues: [] };
  }

  const nextStr = typeof newText === 'string' ? newText : String(newText || '');
  if (!nextStr.trim()) {
    return { ok: true, skipped: false, issues: [] };
  }

  const prevCounts = new Map();
  if (typeof oldText === 'string' && oldText.length > 0) {
    for (const ln of oldText.split(/\r?\n/)) {
      const k = ln.trim();
      if (!k) continue;
      prevCounts.set(k, (prevCounts.get(k) || 0) + 1);
    }
  }

  const issues = [];
  const nextLines = nextStr.split(/\r?\n/);
  for (let i = 0; i < nextLines.length; i++) {
    const rawLine = nextLines[i];
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    const prevCount = prevCounts.get(trimmed) || 0;
    if (prevCount > 0) {
      prevCounts.set(trimmed, prevCount - 1);
      continue;
    }

    // Ignore HTML/JSX placeholder attribute lines explicitly
    if (/\bplaceholder\s*=\s*['"`{]/i.test(trimmed) && !/(?:\/\/|#|\/\*)\s*(?:TODO|FIXME|XXX)\b/i.test(trimmed)) {
      continue;
    }

    for (const pat of STUB_PATTERNS) {
      if (pat.rx.test(trimmed)) {
        issues.push({
          line: i + 1,
          kind: pat.kind,
          excerpt: trimmed.slice(0, 120),
        });
        break;
      }
    }
    if (issues.length >= 8) break;
  }

  return {
    ok: issues.length === 0,
    skipped: false,
    issues,
  };
}

const TEST_FILE_EXPLICIT_RE = /(?:^|[/\\])(?:tests?|__tests__|fixtures?|benchmarks?)[/\\]|\.(?:test|spec)\.[cm]?[jt]sx?$|_test\.(?:py|go)$|test_[^/\\]+\.py$/i;
const SKIPPED_TEST_PATTERNS = [
  { kind: 'skipped_test', rx: /^(?:test|it|describe)\.(?:skip|todo)\s*\(/ },
  { kind: 'skipped_test', rx: /^(?:xit|xdescribe|xtest)\s*\(/ },
  { kind: 'skipped_test', rx: /^@(?:unittest\.skip|pytest\.mark\.skip)\b/ },
  { kind: 'skipped_test', rx: /^#\[ignore(?:\s*\(|\s*\])/ },
];

/**
 * Flags newly added skipped/disabled tests (`test.skip`, `it.skip`, `pytest.mark.skip`, `#[ignore]`) in diff.
 * Pre-existing skipped tests in `oldText` are ignored.
 * @param {string} [oldText='']
 * @param {string} [newText='']
 * @param {string} [filePath='']
 * @returns {{ ok: boolean, skipped: boolean, issues: Array<{ line: number, kind: string, excerpt: string }> }}
 */
export function scanAddedSkippedTestsInDiff(oldText = '', newText = '', filePath = '') {
  const cleanPath = String(filePath || '').replace(/\\/g, '/');
  if (cleanPath && (SKIP_STUB_EXT_RE.test(cleanPath) || !TEST_FILE_EXPLICIT_RE.test(cleanPath) || /(?:^|\/)completion-gates\.mjs$/i.test(cleanPath))) {
    return { ok: true, skipped: true, issues: [] };
  }

  const nextStr = typeof newText === 'string' ? newText : String(newText || '');
  if (!nextStr.trim()) {
    return { ok: true, skipped: false, issues: [] };
  }

  const prevCounts = new Map();
  if (typeof oldText === 'string' && oldText.length > 0) {
    for (const ln of oldText.split(/\r?\n/)) {
      const k = ln.trim();
      if (!k) continue;
      prevCounts.set(k, (prevCounts.get(k) || 0) + 1);
    }
  }

  const issues = [];
  const nextLines = nextStr.split(/\r?\n/);
  for (let i = 0; i < nextLines.length; i++) {
    const trimmed = nextLines[i].trim();
    if (!trimmed) continue;

    const prevCount = prevCounts.get(trimmed) || 0;
    if (prevCount > 0) {
      prevCounts.set(trimmed, prevCount - 1);
      continue;
    }

    for (const pat of SKIPPED_TEST_PATTERNS) {
      if (pat.rx.test(trimmed)) {
        issues.push({
          line: i + 1,
          kind: pat.kind,
          excerpt: trimmed.slice(0, 120),
        });
        break;
      }
    }
    if (issues.length >= 8) break;
  }

  return {
    ok: issues.length === 0,
    skipped: false,
    issues,
  };
}

/**
 * Generates a read-only GATES.md acceptance ledger template in `targetDir`.
 * @param {string} [targetDir=process.cwd()]
 * @param {{ title?: string, gates?: Array<string|{ id?: string, title: string, check?: string, expect?: string }>, overwrite?: boolean }} [options={}]
 */
export function initAcceptanceGatesMarkdown(
  targetDir = process.cwd(),
  { title = 'Acceptance Gates', gates = [], overwrite = false } = {}
) {
  const dirAbs = resolve(targetDir || process.cwd());
  const outPath = join(dirAbs, 'GATES.md');
  if (existsSync(outPath) && !overwrite) {
    return { ok: false, exists: true, outPath, reason: 'GATES.md already exists' };
  }

  const defaultGates = Array.isArray(gates) && gates.length > 0
    ? gates
    : [
        { id: 'g1', title: 'Core implementation complete without stubs or TODOs', check: 'npm test', expect: '0 failed' },
        { id: 'g2', title: 'Static audit and lint pass cleanly', check: 'npm run audit', expect: 'CRITICAL=0 HIGH=0' },
      ];

  const lines = [`# ${String(title || 'Acceptance Gates').trim()}`, ''];
  defaultGates.forEach((raw, idx) => {
    const item = typeof raw === 'string' ? { id: `g${idx + 1}`, title: raw } : raw;
    const gid = String(item?.id || `g${idx + 1}`).replace(/[^A-Za-z0-9._-]/g, '-') || `g${idx + 1}`;
    const gtitle = String(item?.title || `Gate ${idx + 1}`).trim();
    lines.push(`- [ ] ${gid}: ${gtitle}`);
    if (item?.check) lines.push(`  CHECK: ${String(item.check).trim()}`);
    if (item?.expect) lines.push(`  EXPECT: ${String(item.expect).trim()}`);
  });
  lines.push('');

  mkdirSync(dirAbs, { recursive: true });
  writeFileSync(outPath, lines.join('\n'), 'utf8');
  return { ok: true, outPath, count: defaultGates.length };
}

export function recordSessionFileStubs(opts = {}) {
  const {
    conversationId = 'default',
    workspaceRoot = '',
    filePath = '',
    issues = [],
    stateFile = '',
    nowMs = Date.now(),
  } = opts && typeof opts === 'object' && !Array.isArray(opts) ? opts : {};
  const cid = normConvoKey(conversationId);
  const targetFile = String(filePath || '').replace(/\\/g, '/').trim();
  if (!targetFile) return { ok: false };
  const targetPath = getStateFilePath(stateFile);
  const wsKey = normWsKey(workspaceRoot);
  const list = Array.isArray(issues) ? issues.slice(0, 8) : [];

  updateJsonAtomicSync(targetPath, defaultState, (cur) => {
    const convos = pruneMapByTs(cur?.conversations, nowMs);
    const existing = Object.hasOwn(convos, cid) ? convos[cid] : { wsKey, files: {}, updatedAt: nowMs };
    const files = existing.files && typeof existing.files === 'object' && !Array.isArray(existing.files)
      ? { ...existing.files }
      : {};
    if (list.length > 0) {
      files[targetFile] = { issues: list, updatedAt: nowMs };
    } else {
      delete files[targetFile];
    }
    convos[cid] = { wsKey, files, updatedAt: nowMs };
    return {
      conversations: convos,
      stopBlocks: pruneMapByTs(cur?.stopBlocks, nowMs),
      verification: pruneMapByTs(cur?.verification, nowMs),
      reuse: pruneMapByTs(cur?.reuse, nowMs),
    };
  }, { spaces: 0 });

  return { ok: true, count: list.length };
}

const TEST_CMD_RE = /\b(?:npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|yarn\s+test|bun\s+test|npx\s+(?:jest|vitest)|jest|vitest|pytest|python3?\s+-m\s+pytest|go\s+test|cargo\s+test|mvn\s+test|gradle\s+test|rspec|phpunit|dotnet\s+test|node\s+(?:[^\n;&|]*\s+)?--test|deno\s+test|make\s+test)\b/i;

export function isVerificationTestCommand(commandLine = '') {
  return TEST_CMD_RE.test(String(commandLine || ''));
}

export function parseTestPassFailCounts(output = '') {
  const str = String(output || '');
  const pick = (re) => {
    const m = re.exec(str);
    return m ? Number(m[1]) : undefined;
  };
  return {
    passed: pick(/(\d+)\s+(?:passed|passing)\b/i) ?? pick(/(?:ℹ|#)\s*pass\s+(\d+)\b/i),
    failed: pick(/(\d+)\s+(?:failed|failing)\b/i) ?? pick(/(?:ℹ|#)\s*fail\s+(\d+)\b/i),
  };
}

export function recordSessionCodeEdit(opts = {}) {
  const {
    conversationId = 'default',
    workspaceRoot = '',
    filePath = '',
    stateFile = '',
    nowMs = Date.now(),
  } = opts && typeof opts === 'object' && !Array.isArray(opts) ? opts : {};
  const cleanPath = String(filePath || '').replace(/\\/g, '/').trim();
  if (!cleanPath || SKIP_STUB_EXT_RE.test(cleanPath)) {
    return { ok: true, skipped: true };
  }
  const cid = normConvoKey(conversationId);
  const targetPath = getStateFilePath(stateFile);
  const wsKey = normWsKey(workspaceRoot);

  updateJsonAtomicSync(targetPath, defaultState, (cur) => {
    const verMap = pruneMapByTs(cur?.verification, nowMs);
    const prev = Object.hasOwn(verMap, cid) ? verMap[cid] : {};
    verMap[cid] = {
      ...prev,
      wsKey: wsKey || prev.wsKey || '',
      lastCodeEditAt: nowMs,
      lastEditedFile: cleanPath,
      updatedAt: nowMs,
    };
    return {
      conversations: pruneMapByTs(cur?.conversations, nowMs),
      stopBlocks: pruneMapByTs(cur?.stopBlocks, nowMs),
      verification: verMap,
      reuse: pruneMapByTs(cur?.reuse, nowMs),
    };
  }, { spaces: 0 });

  return { ok: true, skipped: false, lastCodeEditAt: nowMs };
}

export function recordSessionTestExecution(opts = {}) {
  const {
    conversationId = 'default',
    workspaceRoot = '',
    commandLine = '',
    output = '',
    exitCode = 0,
    stateFile = '',
    nowMs = Date.now(),
  } = opts && typeof opts === 'object' && !Array.isArray(opts) ? opts : {};
  const cid = normConvoKey(conversationId);
  const targetPath = getStateFilePath(stateFile);
  const wsKey = normWsKey(workspaceRoot);
  const counts = parseTestPassFailCounts(output);
  const passed = counts.passed;
  const failed = counts.failed ?? (exitCode !== 0 ? 1 : 0);
  const lastTestExitOk = exitCode === 0 && (counts.failed === undefined || counts.failed === 0);

  updateJsonAtomicSync(targetPath, defaultState, (cur) => {
    const verMap = pruneMapByTs(cur?.verification, nowMs);
    const prev = Object.hasOwn(verMap, cid) ? verMap[cid] : {};
    verMap[cid] = {
      ...prev,
      wsKey: wsKey || prev.wsKey || '',
      lastTestRunAt: nowMs,
      lastTestCmd: String(commandLine || '').slice(0, 140),
      lastTestExitOk,
      passed: passed ?? prev.passed ?? 0,
      failed,
      updatedAt: nowMs,
    };
    return {
      conversations: pruneMapByTs(cur?.conversations, nowMs),
      stopBlocks: pruneMapByTs(cur?.stopBlocks, nowMs),
      verification: verMap,
      reuse: pruneMapByTs(cur?.reuse, nowMs),
    };
  }, { spaces: 0 });

  return { ok: true, lastTestExitOk, passed, failed };
}

export function getSessionVerificationFreshness(opts = {}) {
  const { conversationId = 'default', stateFile = '', nowMs = Date.now() } = opts && typeof opts === 'object' && !Array.isArray(opts) ? opts : {};
  const cid = normConvoKey(conversationId);
  const st = safeReadJsonSync(getStateFilePath(stateFile), defaultState, { selfHeal: true });
  const entry = st?.verification && Object.hasOwn(st.verification, cid) ? st.verification[cid] : null;
  if (!entry || (nowMs - Number(entry.updatedAt || 0)) >= STUB_STATE_TTL_MS) {
    return { state: 'not_run', lastCodeEditAt: 0, lastTestRunAt: 0, passed: 0, failed: 0, lastEditedFile: '' };
  }
  const lastCodeEditAt = Number(entry.lastCodeEditAt || 0);
  const lastTestRunAt = Number(entry.lastTestRunAt || 0);
  let state = 'not_run';
  if (lastTestRunAt > 0) {
    if (entry.lastTestExitOk === false) {
      state = 'fail';
    } else if (lastCodeEditAt > lastTestRunAt) {
      state = 'stale';
    } else {
      state = 'pass';
    }
  }
  return {
    state,
    lastCodeEditAt,
    lastTestRunAt,
    passed: Number(entry.passed || 0),
    failed: Number(entry.failed || 0),
    lastEditedFile: String(entry.lastEditedFile || ''),
  };
}

export function clearSessionFileStubs(opts = {}) {
  const { conversationId = 'default', filePath = '', stateFile = '' } = opts && typeof opts === 'object' && !Array.isArray(opts) ? opts : {};
  return recordSessionFileStubs({ conversationId, filePath, issues: [], stateFile });
}

export function getSessionStubSummary(opts = {}) {
  const { conversationId = 'default', stateFile = '', nowMs = Date.now() } = opts && typeof opts === 'object' && !Array.isArray(opts) ? opts : {};
  const cid = normConvoKey(conversationId);
  const targetPath = getStateFilePath(stateFile);
  const st = safeReadJsonSync(targetPath, defaultState, { selfHeal: true });
  const convEntry = st?.conversations && Object.hasOwn(st.conversations, cid) ? st.conversations[cid] : null;
  if (!convEntry || (nowMs - Number(convEntry.updatedAt || 0)) >= STUB_STATE_TTL_MS) {
    return { totalIssues: 0, files: [] };
  }
  const files = [];
  let totalIssues = 0;
  for (const [fp, entry] of Object.entries(convEntry.files || {})) {
    const issues = Array.isArray(entry?.issues) ? entry.issues : [];
    if (issues.length > 0) {
      totalIssues += issues.length;
      files.push({ filePath: fp, issues });
    }
  }
  return { totalIssues, files };
}

export function checkProjectCompletionInvariants(workspaceRoot = '', touchedFiles = []) {
  const warnings = [];
  if (!workspaceRoot || typeof workspaceRoot !== 'string' || !existsSync(workspaceRoot)) {
    return { ok: true, warnings, gates: null };
  }
  const wsAbs = resolve(workspaceRoot);

  // 1. Check stale panel ui.html bundle if ui-src files were edited
  const touchedUiSrc = (Array.isArray(touchedFiles) ? touchedFiles : []).filter((f) => {
    const norm = String(f || '').replace(/\\/g, '/').toLowerCase();
    return norm.includes('sidecars/panel/ui-src/');
  });
  if (touchedUiSrc.length > 0) {
    const bundlePath = join(wsAbs, 'sidecars', 'panel', 'ui.html');
    if (existsSync(bundlePath)) {
      try {
        const bundleMtime = statSync(bundlePath).mtimeMs;
        let newestSrcMtime = 0;
        for (const f of touchedUiSrc) {
          const absSrc = resolve(wsAbs, f);
          const candidate = existsSync(absSrc) ? absSrc : (existsSync(f) ? f : '');
          if (candidate) {
            const mt = statSync(candidate).mtimeMs;
            if (mt > newestSrcMtime) newestSrcMtime = mt;
          }
        }
        if (newestSrcMtime > bundleMtime + 50) {
          warnings.push({
            kind: 'ui_bundle_stale',
            message: 'Изменены шаблоны sidecars/panel/ui-src/, но бандл sidecars/panel/ui.html не пересобран (вызовите buildPanelUi).',
          });
        }
      } catch {}
    }
  }

  // 2. Check GATES.md read-only if present in workspace root
  let gatesSummary = null;
  const gatesPath = join(wsAbs, 'GATES.md');
  if (existsSync(gatesPath)) {
    try {
      const md = readFileSync(gatesPath, 'utf8');
      gatesSummary = parseAcceptanceGatesMarkdown(md);
      if (gatesSummary.malformed.length > 0) {
        warnings.push({
          kind: 'gates_malformed',
          message: `GATES.md содержит синтаксические замечания: ${gatesSummary.malformed.slice(0, 2).join('; ')}`,
        });
      }
      if (gatesSummary.unmet.length > 0) {
        const sample = gatesSummary.unmet.slice(0, 3).map((g) => g.id).join(', ');
        warnings.push({
          kind: 'gates_unmet',
          message: `В GATES.md остались незакрытые критерии (${gatesSummary.unmet.length}/${gatesSummary.total}: ${sample}).`,
        });
      }
      if (gatesSummary.abandoned.length > 0) {
        warnings.push({
          kind: 'gates_abandoned',
          message: `В GATES.md отмечены отложенные критерии (${gatesSummary.abandoned.map((g) => g.id).join(', ')}) — требуется явная передача пользователю.`,
        });
      }
    } catch {}
  }

  return {
    ok: warnings.length === 0,
    warnings,
    gates: gatesSummary,
  };
}

/**
 * Evaluates all completion gates on Stop event with bounded anti-loop guard.
 * @param {object} [params={}]
 * @returns {{ ok: boolean, shouldWarn: boolean, warnings: Array<object>, formattedSystemMessage: string }}
 */
export function evaluateStopCompletionGates(opts = {}) {
  const {
    workspaceRoot = '',
    conversationId = 'default',
    touchedFiles = [],
    hasError = false,
    terminationReason = '',
    maxBlocks = 2,
    stateFile = '',
    nowMs = Date.now(),
  } = opts && typeof opts === 'object' && !Array.isArray(opts) ? opts : {};
  if (hasError || /(?:abort|cancel|interrupt|error)/i.test(String(terminationReason || ''))) {
    return { ok: true, shouldWarn: false, warnings: [], formattedSystemMessage: '' };
  }

  const warnings = [];
  const stubRes = getSessionStubSummary({ conversationId, stateFile, nowMs });
  if (stubRes.totalIssues > 0) {
    const sample = stubRes.files
      .slice(0, 3)
      .map((f) => `${f.filePath.split('/').pop()}:${f.issues.map((i) => `L${i.line}`).join(',')}`)
      .join('; ');
    warnings.push({
      kind: 'added_stubs',
      message: `В изменённых файлах обнаружены новые незакрытые заглушки/TODO (${stubRes.totalIssues}: ${sample}).`,
    });
  }

  const invRes = checkProjectCompletionInvariants(workspaceRoot, touchedFiles);
  if (invRes.warnings.length > 0) {
    warnings.push(...invRes.warnings);
  }

  const verFresh = getSessionVerificationFreshness({ conversationId, stateFile, nowMs });
  if (verFresh.state === 'stale') {
    const editedShort = verFresh.lastEditedFile ? verFresh.lastEditedFile.split('/').pop() : 'source';
    warnings.push({
      kind: 'stale_tests',
      message: `Устаревший прогон тестов (stale): файл ${editedShort} редактировался ПОСЛЕ последнего запуска тестов — перезапусти проверку перед завершением.`,
    });
  } else if (verFresh.state === 'fail') {
    warnings.push({
      kind: 'failing_tests',
      message: `Последний прогон тестов завершился с ошибками (failed: ${verFresh.failed || 1}) — добейся зелёного статуса.`,
    });
  }

  const cid = normConvoKey(conversationId);
  const targetPath = getStateFilePath(stateFile);

  if (warnings.length === 0) {
    try {
      updateJsonAtomicSync(targetPath, defaultState, (cur) => {
        const stopBlocks = pruneMapByTs(cur?.stopBlocks, nowMs);
        delete stopBlocks[cid];
        return {
          conversations: pruneMapByTs(cur?.conversations, nowMs),
          stopBlocks,
          verification: pruneMapByTs(cur?.verification, nowMs),
          reuse: pruneMapByTs(cur?.reuse, nowMs),
        };
      }, { spaces: 0 });
    } catch {}
    return { ok: true, shouldWarn: false, warnings: [], formattedSystemMessage: '' };
  }

  const safeMax = Math.max(1, Math.min(5, Number(maxBlocks) || 2));
  let currentCount = 0;
  updateJsonAtomicSync(targetPath, defaultState, (cur) => {
    const stopBlocks = pruneMapByTs(cur?.stopBlocks, nowMs);
    const prev = Object.hasOwn(stopBlocks, cid) ? stopBlocks[cid] : { count: 0, updatedAt: nowMs };
    currentCount = Number(prev.count || 0) + 1;
    if (currentCount > safeMax) {
      delete stopBlocks[cid];
    } else {
      stopBlocks[cid] = { count: currentCount, updatedAt: nowMs };
    }
    return {
      conversations: pruneMapByTs(cur?.conversations, nowMs),
      stopBlocks,
      verification: pruneMapByTs(cur?.verification, nowMs),
      reuse: pruneMapByTs(cur?.reuse, nowMs),
    };
  }, { spaces: 0 });

  if (currentCount > safeMax) {
    return { ok: false, shouldWarn: false, warnings, formattedSystemMessage: '' };
  }

  const lines = [
    `🚧 [Completion Gate ${currentCount}/${safeMax}] Перед завершением проверь незакрытые пункты:`,
    ...warnings.slice(0, 4).map((w) => `- ${w.message}`),
  ];

  return {
    ok: false,
    shouldWarn: true,
    warnings,
    formattedSystemMessage: lines.join('\n'),
  };
}

/**
 * Advisory Karpathy Surgical-Diff guard catching excessive speculative expansion or trivial wrapper creep.
 * Skips new files, test files, docs/HTML, and completion-gates.mjs itself.
 */
export function assessDiffSurgicalDiscipline(
  oldText = '',
  newText = '',
  filePath = '',
  { maxExpansionRatio = 4.0, minOldLines = 40 } = {}
) {
  const cleanPath = String(filePath || '').replace(/\\/g, '/');
  if (
    !oldText ||
    !String(oldText).trim() ||
    (cleanPath && (SKIP_STUB_EXT_RE.test(cleanPath) || SKIP_STUB_TEST_RE.test(cleanPath) || /(?:^|\/)completion-gates\.mjs$/i.test(cleanPath)))
  ) {
    return { ok: true, skipped: true, oldLines: 0, newLines: 0, addedLines: 0, removedLines: 0, expansionRatio: 1, warnings: [] };
  }

  const oldArr = String(oldText).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const newArr = String(newText || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const oldLines = oldArr.length;
  const newLines = newArr.length;

  const oldCounts = new Map();
  for (const ln of oldArr) oldCounts.set(ln, (oldCounts.get(ln) || 0) + 1);
  const addedList = [];
  for (const ln of newArr) {
    const c = oldCounts.get(ln) || 0;
    if (c > 0) oldCounts.set(ln, c - 1);
    else addedList.push(ln);
  }

  const addedLines = addedList.length;
  const removedLines = Math.max(0, oldLines - (newLines - addedLines));
  const expansionRatio = Number((newLines / Math.max(1, oldLines)).toFixed(2));
  const newTrivialWrappers = addedList.filter((ln) =>
    /^export\s+(?:async\s+)?function\s+\w+\(([^)]{0,80})\)\s*\{\s*return\s+(?:await\s+)?[A-Za-z_$][\w$.]*\(\1\)\s*;?\s*\}$/.test(ln) ||
    /^export\s+const\s+\w+\s*=\s*\(([^)]{0,80})\)\s*=>\s*[A-Za-z_$][\w$.]*\(\1\)\s*;?$/.test(ln)
  ).length;

  const warnings = [];
  if (oldLines >= minOldLines && expansionRatio > maxExpansionRatio && (newLines - oldLines) >= 180) {
    warnings.push(`Karpathy Surgical Guard: файл вырос в ${expansionRatio}× (${oldLines} -> ${newLines} строк) — проверь, нет ли спекулятивного раздувания вне ТЗ.`);
  }
  if (newTrivialWrappers >= 3) {
    warnings.push(`Karpathy Simplicity Guard: добавлено ${newTrivialWrappers} однострочных обёрток-прокладок — используй прямой вызов вместо лишних слоёв.`);
  }

  return {
    ok: warnings.length === 0,
    skipped: false,
    oldLines,
    newLines,
    addedLines,
    removedLines,
    expansionRatio,
    newTrivialWrappers,
    warnings,
  };
}

const GENERIC_REUSE_NAMES = new Set([
  'main', 'init', 'run', 'get', 'set', 'test', 'setup', 'open', 'close', 'read', 'write',
  'start', 'stop', 'load', 'save', 'update', 'create', 'delete', 'handle', 'render', 'index',
  'new', 'call', 'apply', 'map', 'filter', 'reduce', 'forEach', 'some', 'every', 'find',
  'slice', 'push', 'join', 'split', 'trim', 'replace', 'match', 'exec', 'resolve', 'reject',
  'require', 'import', 'from', 'if', 'for', 'while', 'switch', 'catch', 'return', 'Number',
  'String', 'Boolean', 'Array', 'Object', 'Set', 'Map', 'Promise', 'Error', 'Date', 'Math', 'JSON',
]);

const REUSE_DEF_RULES = [
  [/\.[cm]?[jt]sx?$/i, [
    /^export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm,
    /^(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/gm,
    /^class\s+([A-Za-z_$][\w$]*)/gm,
  ]],
  [/\.py$/i, [/^(?:async\s+)?def\s+([A-Za-z]\w*)/gm, /^class\s+([A-Za-z]\w*)/gm]],
  [/\.go$/i, [/^func\s+(?:\([^)]*\)\s*)?([A-Za-z]\w*)/gm]],
  [/\.rs$/i, [/^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/gm]],
];

/**
 * Computes Ponytail-style code reuse score on a file edit:
 * `reusePct = reusedSymbols / (reusedSymbols + newDefinitions)`.
 * @param {string} oldText
 * @param {string} newText
 * @param {string} filePath
 * @param {Iterable<string>|Set<string>|Map<string, any>} [knownRepoSymbols=[]]
 */
export function computeDiffReuseMetrics(oldText = '', newText = '', filePath = '', knownRepoSymbols = []) {
  const cleanPath = String(filePath || '').replace(/\\/g, '/');
  if (!cleanPath || SKIP_STUB_EXT_RE.test(cleanPath) || SKIP_STUB_TEST_RE.test(cleanPath)) {
    return { skipped: true, reusedSymbols: [], newSymbols: [], reusedCount: 0, newCount: 0, reusePct: null };
  }
  const ruleEntry = REUSE_DEF_RULES.find(([extRe]) => extRe.test(cleanPath));
  if (!ruleEntry) {
    return { skipped: true, reusedSymbols: [], newSymbols: [], reusedCount: 0, newCount: 0, reusePct: null };
  }

  const oldSet = new Set(String(oldText || '').split(/\r?\n/));
  const addedBlock = String(newText || '')
    .split(/\r?\n/)
    .filter((ln) => !oldSet.has(ln))
    .join('\n');
  if (!addedBlock.trim()) {
    return { skipped: true, reusedSymbols: [], newSymbols: [], reusedCount: 0, newCount: 0, reusePct: null };
  }

  const existingDefsInOld = new Set();
  for (const re of ruleEntry[1]) {
    re.lastIndex = 0;
    for (const m of String(oldText || '').matchAll(re)) {
      if (m[1]) existingDefsInOld.add(m[1]);
    }
  }

  const newDefsSet = new Set();
  for (const re of ruleEntry[1]) {
    re.lastIndex = 0;
    for (const m of addedBlock.matchAll(re)) {
      const sym = m[1];
      if (sym && !existingDefsInOld.has(sym) && !GENERIC_REUSE_NAMES.has(sym) && !GENERIC_REUSE_NAMES.has(sym.toLowerCase())) {
        newDefsSet.add(sym);
      }
    }
  }

  const knownSet = new Set();
  if (knownRepoSymbols instanceof Map) {
    for (const k of knownRepoSymbols.keys()) knownSet.add(String(k));
  } else if (knownRepoSymbols && typeof knownRepoSymbols[Symbol.iterator] === 'function') {
    for (const item of knownRepoSymbols) {
      const sym = typeof item === 'string' ? item : item?.name || item?.symbol || '';
      if (sym) knownSet.add(String(sym));
    }
  }
  for (const s of existingDefsInOld) knownSet.add(s);

  const reusedSet = new Set();
  for (const m of addedBlock.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const callee = m[1];
    if (
      callee &&
      knownSet.has(callee) &&
      !newDefsSet.has(callee) &&
      !GENERIC_REUSE_NAMES.has(callee) &&
      !GENERIC_REUSE_NAMES.has(callee.toLowerCase())
    ) {
      reusedSet.add(callee);
    }
  }

  const reusedSymbols = [...reusedSet];
  const newSymbols = [...newDefsSet];
  const denom = reusedSymbols.length + newSymbols.length;
  const reusePct = denom > 0 ? Math.round((reusedSymbols.length / denom) * 100) : null;

  return {
    skipped: false,
    reusedSymbols,
    newSymbols,
    reusedCount: reusedSymbols.length,
    newCount: newSymbols.length,
    reusePct,
  };
}

export function recordSessionReuseMetrics(opts = {}) {
  const {
    conversationId = 'default',
    reusedSymbols = [],
    newSymbols = [],
    stateFile = '',
    nowMs = Date.now(),
  } = opts && typeof opts === 'object' && !Array.isArray(opts) ? opts : {};
  if ((!Array.isArray(reusedSymbols) || reusedSymbols.length === 0) && (!Array.isArray(newSymbols) || newSymbols.length === 0)) {
    return { ok: true, skipped: true };
  }
  const cid = normConvoKey(conversationId);
  const targetPath = getStateFilePath(stateFile);
  let snapshot = null;

  updateJsonAtomicSync(targetPath, defaultState, (cur) => {
    const reuseMap = pruneMapByTs(cur?.reuse, nowMs);
    const prev = Object.hasOwn(reuseMap, cid) ? reuseMap[cid] : { reused: [], created: [] };
    const reused = Array.from(new Set([...(Array.isArray(prev.reused) ? prev.reused : []), ...reusedSymbols])).slice(0, 120);
    const created = Array.from(new Set([...(Array.isArray(prev.created) ? prev.created : []), ...newSymbols])).slice(0, 120);
    const denom = reused.length + created.length;
    const reusePct = denom > 0 ? Math.round((reused.length / denom) * 100) : null;
    snapshot = { reused, created, reusedCount: reused.length, newCount: created.length, reusePct, updatedAt: nowMs };
    reuseMap[cid] = snapshot;
    return {
      conversations: pruneMapByTs(cur?.conversations, nowMs),
      stopBlocks: pruneMapByTs(cur?.stopBlocks, nowMs),
      verification: pruneMapByTs(cur?.verification, nowMs),
      reuse: reuseMap,
    };
  }, { spaces: 0 });

  return { ok: true, ...snapshot };
}

export function getSessionReuseSummary(opts = {}) {
  const { conversationId = 'default', stateFile = '', nowMs = Date.now() } = opts && typeof opts === 'object' && !Array.isArray(opts) ? opts : {};
  const cid = normConvoKey(conversationId);
  const st = safeReadJsonSync(getStateFilePath(stateFile), defaultState, { selfHeal: true });
  const entry = st?.reuse && Object.hasOwn(st.reuse, cid) ? st.reuse[cid] : null;
  if (!entry || (nowMs - Number(entry.updatedAt || 0)) >= STUB_STATE_TTL_MS) {
    return { reusedCount: 0, newCount: 0, reusePct: null, reused: [], created: [] };
  }
  return {
    reusedCount: Number(entry.reusedCount || 0),
    newCount: Number(entry.newCount || 0),
    reusePct: entry.reusePct ?? null,
    reused: Array.isArray(entry.reused) ? entry.reused : [],
    created: Array.isArray(entry.created) ? entry.created : [],
  };
}

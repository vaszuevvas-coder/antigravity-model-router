/**
 * @file obs-masker.mjs
 * @description Модуль маскирования и компрессии вывода терминала (Observation Masking).
 * Очищает ANSI-коды, сжимает успешные многострочные логи (>12 строк) в компактный статус
 * с сохранением ключевых итогов, а при ошибках фильтрует шумные системные фреймы (node:internal, node_modules)
 * и выставляет флаг эскалации triage для объёмных стектрейсов.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { redactSecretsInText } from './security-guard.mjs';
import { compressLogsDrain3, crushStructuredPayload } from './cpu-log-json-compressor.mjs';
import { knowledgeHub } from './sqlite-knowledge-hub.mjs';

export { compressLogsDrain3, crushStructuredPayload };

// Регулярное выражение для удаления ANSI escape-последовательностей
const ANSI_REGEX = /\x1B\[[0-?]*[ -/]*[@-~]/g;

// Паттерны шумных системных фреймов стектрейса
const NOISY_FRAME_PATTERNS = [
  /node:internal/i,
  /\bnode_modules[\\/]/i,
  /\binternal\/process\b/i,
  /\binternal\/modules\b/i,
  /at Module\._compile/i,
  /at Object\.Module\._extensions/i,
  /at Module\.load/i,
  /at Function\.Module\._load/i,
  /at executeUserEntryPoint/i,
  /at wrapSafe/i,
  /at Module\.runMain/i
];

// Паттерны информативных итоговых строк успешного выполнения
const SUCCESS_SUMMARY_PATTERNS = [
  /\b(?:passed|built|success|ok|completed|compiled|finished|done)\b/i,
  /✓|✔/i,
  /\btest\s+results?\b/i,
  /\bcommit\s+[0-9a-f]{6,}\b/i,
  /\bup\s+to\s+date\b/i
];

/**
 * RTK-Shield specialized command output compressor for TAP/test runners and large git diffs.
 * Collapses noisy passing assertions and summarizes git diffs before Drain3/generic fallback.
 * @param {string} [cleanText='']
 * @param {number} [exitCode=0]
 * @param {string} [cmdHint='']
 * @returns {{ matched: boolean, profile: string, compressed: string, savedChars: number }}
 */
export function compressRtkCommandOutput(cleanText = '', exitCode = 0, cmdHint = '') {
  const text = typeof cleanText === 'string' ? cleanText : String(cleanText ?? '');
  if (!text || text.length < 300) {
    return { matched: false, profile: 'none', compressed: text, savedChars: 0 };
  }
  const lines = text.split('\n');

  // 1. TAP / Test Runner profile (>= 8 passing test lines)
  const tapPassRx = /^\s*(?:[✔✓]\s+|ok\s+\d+\s+-)/;
  const tapFailRx = /^\s*(?:[✖✗]\s+|not ok\s+\d+)/;
  const tapMetaRx = /^\s*[ℹ#]\s*(?:tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\b/i;
  let tapPasses = 0;
  let tapFails = 0;
  for (const l of lines) {
    if (tapPassRx.test(l)) tapPasses += 1;
    else if (tapFailRx.test(l)) tapFails += 1;
  }

  if (tapPasses >= 8 || (tapPasses >= 4 && tapFails > 0)) {
    const kept = [];
    let inFailBlock = false;
    for (const l of lines) {
      if (tapFailRx.test(l)) {
        inFailBlock = true;
        kept.push(l);
        continue;
      }
      if (tapPassRx.test(l)) {
        inFailBlock = false;
        continue;
      }
      if (tapMetaRx.test(l) || /^\s*(?:AssertionError|ReferenceError|TypeError|SyntaxError|Error:|FAIL\b)/i.test(l)) {
        inFailBlock = /^\s*(?:AssertionError|ReferenceError|TypeError|SyntaxError|Error:|FAIL\b)/i.test(l);
        kept.push(l);
        continue;
      }
      if (inFailBlock) {
        if (/^\s*$/.test(l)) inFailBlock = false;
        kept.push(l);
      }
    }
    const header = `[✓ RTK-Test Summary: ${tapPasses} passed, ${tapFails} failed across ${lines.length}L${cmdHint ? ` (${String(cmdHint).slice(0, 40)})` : ''}]`;
    const compressed = [header, ...kept.slice(0, 35)].join('\n');
    if (compressed.length < text.length) {
      return {
        matched: true,
        profile: 'tap_tests',
        compressed,
        savedChars: text.length - compressed.length,
      };
    }
  }

  // 2. Large Git Diff profile (> 40 lines with diff --git headers)
  if (lines.length > 40 && text.includes('diff --git ')) {
    const fileStats = [];
    let cur = null;
    const sampleHunks = [];
    for (const l of lines) {
      const mDiff = /^diff --git a\/(.+?) b\/(.+)$/.exec(l);
      if (mDiff) {
        if (cur) fileStats.push(cur);
        cur = { file: mDiff[2], add: 0, del: 0 };
        if (sampleHunks.length < 24) sampleHunks.push(l);
        continue;
      }
      if (cur) {
        if (l.startsWith('+') && !l.startsWith('+++')) cur.add += 1;
        else if (l.startsWith('-') && !l.startsWith('---')) cur.del += 1;
        else if (l.startsWith('@@') && sampleHunks.length < 24) sampleHunks.push(l);
      }
    }
    if (cur) fileStats.push(cur);
    if (fileStats.length > 0) {
      const totalAdd = fileStats.reduce((s, f) => s + f.add, 0);
      const totalDel = fileStats.reduce((s, f) => s + f.del, 0);
      const summaryRows = fileStats.slice(0, 20).map((f) => `  ${f.file} (+${f.add}/-${f.del})`);
      if (fileStats.length > 20) summaryRows.push(`  ... +${fileStats.length - 20} more files`);
      const compressed = [
        `[⚡ RTK-GitDiff: ${fileStats.length} files, +${totalAdd}/-${totalDel} across ${lines.length}L]`,
        ...summaryRows,
        ...sampleHunks.slice(0, 12),
      ].join('\n');
      if (compressed.length < text.length * 0.75) {
        return {
          matched: true,
          profile: 'git_diff',
          compressed,
          savedChars: text.length - compressed.length,
        };
      }
    }
  }

  // 3. Large Git Status profile (>= 18 porcelain/status file rows)
  const gitStatusRx = /^(?:\s*(?:modified:|new file:|deleted:|renamed:)\s+.+|[ MADRCU?!]?[MADRCU?!]\s+\S+|[MADRCU?!][ MADRCU?!]\s+\S+)/;
  const statusRows = lines.filter((l) => gitStatusRx.test(l));
  if (statusRows.length >= 18) {
    const byDir = new Map();
    for (const r of statusRows) {
      const filePart = r.replace(/^(?:\s*(?:modified:|new file:|deleted:|renamed:)\s+|[ MADRCU?!]{1,2}\s+)/, '').trim();
      const dir = path.posix.dirname(filePart.replace(/\\/g, '/'));
      byDir.set(dir, (byDir.get(dir) || 0) + 1);
    }
    const dirSummary = Array.from(byDir.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([d, c]) => `  ${d}/ (${c} files)`);
    const compressed = [
      `[⚡ RTK-GitStatus: ${statusRows.length} changed/untracked files across ${byDir.size} dirs]`,
      ...dirSummary,
      ...statusRows.slice(0, 8),
    ].join('\n');
    if (compressed.length < text.length * 0.75) {
      return {
        matched: true,
        profile: 'git_status',
        compressed,
        savedChars: text.length - compressed.length,
      };
    }
  }

  // 4. Jest / Vitest / Pytest / Cargo Test suite profile
  const suitePassRx = /^\s*(?:PASS\b|\S+::\S+\s+PASSED\b|test\s+\S+\s+\.\.\.\s+ok\b)/;
  const suiteFailRx = /^\s*(?:FAIL\b|\S+::\S+\s+FAILED\b|test\s+\S+\s+\.\.\.\s+FAILED\b|●\s+)/;
  let sPasses = 0;
  let sFails = 0;
  for (const l of lines) {
    if (suitePassRx.test(l)) sPasses += 1;
    else if (suiteFailRx.test(l)) sFails += 1;
  }
  if (sPasses >= 8) {
    const kept = lines.filter((l) => !suitePassRx.test(l)).slice(0, 40);
    const compressed = [
      `[✓ RTK-Suite Summary: ${sPasses} passed, ${sFails} failed across ${lines.length}L]`,
      ...kept,
    ].join('\n');
    if (compressed.length < text.length * 0.8) {
      return {
        matched: true,
        profile: 'test_suites',
        compressed,
        savedChars: text.length - compressed.length,
      };
    }
  }

  return { matched: false, profile: 'none', compressed: text, savedChars: 0 };
}

function normalizeTerminalRawText(rawOutput) {
  let str = typeof rawOutput === 'string' ? rawOutput : String(rawOutput || '');
  if (str.includes('\0')) {
    str = str.replace(/\0/g, '');
  }
  str = str.replace(/^\uFEFF/, '');
  const lf = str.replace(/\r\n/g, '\n');
  if (!lf.includes('\r')) return lf;
  return lf
    .split('\n')
    .map((ln) => {
      if (!ln.includes('\r')) return ln;
      const parts = ln.split('\r');
      for (let i = parts.length - 1; i >= 0; i--) {
        if (parts[i].trim()) return parts[i];
      }
      return parts[parts.length - 1] || '';
    })
    .join('\n');
}

const LINE_FRAME_RE = /(?:^|[\s(])(?:file:\/\/\/)?([A-Za-z]:[\\/][^\s:()]{1,220}|[^\s:()]{1,220}\.(?:[cm]?[jt]sx?|py)):(\d{1,6})(?::\d{1,5})?/;

/**
 * Zero-Turn Fault Frame Pinning: locates the first user-code stack frame (skipping node_modules / node:)
 * and pins the source line verbatim so the model sees the bug with 0 file reads.
 * Linear O(N) per-line scan immune to ReDoS on long unspaced lines.
 * @param {string} [rawText='']
 * @param {string} [workspaceRoot='']
 * @returns {string}
 */
export function extractTopFaultCodePin(rawText = '', workspaceRoot = '') {
  const clean = String(rawText || '');
  if (!clean) return '';
  const lines = clean.slice(0, 12000).split(/\r?\n/);
  const limit = Math.min(lines.length, 40);
  for (let i = 0; i < limit; i++) {
    const ln = lines[i];
    if (!ln || ln.length > 400 || !ln.includes(':')) continue;
    const m = LINE_FRAME_RE.exec(ln);
    if (!m) continue;
    const rawFile = m[1];
    const lineNum = Number(m[2]);
    if (!rawFile || !Number.isFinite(lineNum) || lineNum < 1) continue;
    const norm = rawFile.replace(/\\/g, '/');
    if (norm.includes('node_modules/') || norm.startsWith('node:') || norm.startsWith('internal/')) {
      continue;
    }
    try {
      const candidate = path.isAbsolute(rawFile)
        ? path.resolve(rawFile)
        : path.resolve(workspaceRoot || process.cwd(), rawFile);
      if (!existsSync(candidate)) continue;
      const st = statSync(candidate);
      if (!st.isFile() || st.size > 512 * 1024) continue;
      const fileLines = readFileSync(candidate, 'utf8').split(/\r?\n/);
      if (lineNum > fileLines.length) continue;
      const codeLine = String(fileLines[lineNum - 1] || '').trim().slice(0, 140);
      if (!codeLine) continue;
      let relPosix = norm;
      if (workspaceRoot) {
        const rel = path.relative(path.resolve(workspaceRoot), candidate).replace(/\\/g, '/');
        if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) relPosix = rel;
      } else {
        relPosix = path.basename(candidate);
      }
      return `📌 [Fault Pin ${relPosix}:${lineNum}] -> ${codeLine}`;
    } catch {}
  }
  return '';
}

/**
 * Очищает вывод от ANSI-кодов и форматирует логи терминала
 * @param {string} [rawOutput=''] Исходный вывод терминала (stdout + stderr)
 * @param {number} [exitCode=0] Код завершения процесса
 * @param {object} [options={}] Дополнительные параметры
 * @param {number} [options.maxErrorLines=25] Максимальное количество строк стектрейса при ошибке
 * @returns {{ masked: string, originalLines: number, originalChars: number, maskedChars: number, savedChars: number, needsFlashLiteTriage: boolean, cpuCompressed: boolean, rtkProfile?: string }}
 */
export function maskTerminalOutput(rawOutput = '', exitCode = 0, options = {}) {
  const maxErrorLines = options.maxErrorLines || 25;

  const normalizedRaw = normalizeTerminalRawText(rawOutput);

  // Очистка секретов и ANSI-символов цветов/форматирования
  const clean = redactSecretsInText(normalizedRaw).replace(ANSI_REGEX, '');
  const allLines = clean.split('\n');
  const originalLines = allLines.length;
  const originalChars = clean.length;

  if (options.enabled === false) {
    const passthrough = clean.trim();
    return {
      masked: passthrough,
      originalLines,
      originalChars,
      maskedChars: passthrough.length,
      savedChars: 0,
      needsFlashLiteTriage: false,
      cpuCompressed: false,
      wasCrushed: false,
      compressionKind: 'none'
    };
  }

  let workingText = clean;
  let wasCrushed = false;
  let wasCompressed = false;
  let rtkProfile = 'none';

  const rtkRes = compressRtkCommandOutput(clean, exitCode, options.commandLine || '');
  if (rtkRes.matched) {
    workingText = rtkRes.compressed;
    wasCompressed = true;
    rtkProfile = rtkRes.profile;
  } else if (originalChars > 550 || originalLines > 16) {
    const trimmed = clean.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[') || originalLines >= 4) {
      const crushRes = crushStructuredPayload(clean, { minChars: originalLines > 16 ? 200 : 500 });
      if (crushRes.wasCrushed) {
        workingText = crushRes.crushed;
        wasCrushed = true;
      }
    }
    if (!wasCrushed) {
      const drainRes = compressLogsDrain3(workingText);
      if (drainRes.wasCompressed) {
        workingText = drainRes.compressed;
        wasCompressed = true;
      }
    }
  }

  const cpuCompressed = Boolean(wasCrushed || wasCompressed);
  const workingLines = workingText.split('\n');

  let masked = '';
  let needsFlashLiteTriage = false;

  if (exitCode === 0) {
    // Успешное выполнение
    if (originalLines <= 12 && !cpuCompressed) {
      masked = clean.trim();
    } else if (cpuCompressed && (wasCrushed || workingLines.length <= 28)) {
      const displayLines = workingLines.length <= 28 ? workingLines : workingLines.slice(0, 28);
      const displayText = displayLines.join('\n');
      const hiddenLines = Math.max(0, originalLines - displayLines.length);
      const hiddenChars = Math.max(0, originalChars - displayText.length);
      const header = `[✓ OBS-MASK] OK (hidden ${hiddenLines}L / ${hiddenChars} chars)`;
      masked = `${header}\n${displayText}`;
    } else {
      // Ищем до 4 ключевых итоговых строк
      const summaryLines = [];
      for (let i = workingLines.length - 1; i >= 0 && summaryLines.length < 4; i--) {
        const line = workingLines[i].trim();
        if (!line) continue;

        const isSummary = SUCCESS_SUMMARY_PATTERNS.some(p => p.test(line));
        if (isSummary) {
          summaryLines.unshift(line);
        }
      }

      // Если ни одной строки по паттернам не найдено, берем последние 3 непустые строки
      if (summaryLines.length === 0) {
        for (let i = workingLines.length - 1; i >= 0 && summaryLines.length < 3; i--) {
          const line = workingLines[i].trim();
          if (line) summaryLines.unshift(line);
        }
      }

      const hiddenLines = Math.max(0, originalLines - summaryLines.length);
      const summaryJoined = summaryLines.join('\n');
      const hiddenChars = Math.max(0, originalChars - summaryJoined.length);

      const header = `[✓ OBS-MASK] OK (hidden ${hiddenLines}L / ${hiddenChars} chars)`;
      const formattedLines = summaryLines.map(l => `- ${l}`).join('\n');
      masked = `${header}\n${formattedLines}`;
    }
  } else {
    // Ненулевой код завершения: фильтруем шум со сворачиванием внутренних кадров и сохраняем Head + ошибки + Tail лога
    const cleanLines = [];
    let foldedInternalCount = 0;
    const flushFoldedFrames = () => {
      if (foldedInternalCount > 0) {
        cleanLines.push(`    [... ${foldedInternalCount} internal frames folded]`);
        foldedInternalCount = 0;
      }
    };
    for (const rawLine of workingLines) {
      const line = rawLine.trimEnd();
      if (!line.trim()) continue;
      if (NOISY_FRAME_PATTERNS.some((p) => p.test(line))) {
        foldedInternalCount++;
        continue;
      }
      flushFoldedFrames();
      cleanLines.push(line);
    }
    flushFoldedFrames();

    if (cleanLines.length === 0) {
      for (const rawLine of workingLines) {
        const line = rawLine.trimEnd();
        if (line.trim()) cleanLines.push(line);
      }
    }

    let finalLines;
    if (cleanLines.length <= maxErrorLines) {
      finalLines = cleanLines;
    } else {
      const gapReserve = maxErrorLines >= 10 ? 2 : 1;
      const tailCount = Math.min(cleanLines.length, Math.max(Math.min(8, maxErrorLines), Math.floor(maxErrorLines * 0.56)));
      const headCount = Math.min(4, Math.max(0, Math.min(maxErrorLines - tailCount - gapReserve, Math.floor(maxErrorLines * 0.16))));
      const midBudget = Math.max(0, maxErrorLines - headCount - tailCount - gapReserve);
      const tailStart = Math.max(headCount, cleanLines.length - tailCount);

      const faultRegex = /(?:error\b|exception\b|fail(?:ed|ure)?\b|fatal:|syntaxerror|typeerror|referenceerror|assertionerror|panic:|err!|✗|×|\.[mc]?[jt]sx?:\d+)/i;
      const faultMatches = [];
      for (let i = headCount; i < tailStart; i++) {
        if (faultRegex.test(cleanLines[i])) {
          faultMatches.push(i);
        }
      }

      const selectedSet = new Set();
      for (let i = 0; i < headCount; i++) selectedSet.add(i);

      if (midBudget > 0 && faultMatches.length > 0) {
        const midPicked = new Set();
        for (let k = faultMatches.length - 1; k >= 0 && midPicked.size < midBudget; k--) {
          const idx = faultMatches[k];
          midPicked.add(idx);
          if (idx + 1 < tailStart && midPicked.size < midBudget) {
            midPicked.add(idx + 1);
          }
        }
        for (const idx of midPicked) selectedSet.add(idx);
      }

      for (let i = tailStart; i < cleanLines.length; i++) selectedSet.add(i);

      const selectedIndices = Array.from(selectedSet).sort((a, b) => a - b);
      finalLines = [];
      let prevIdx = -1;
      for (const idx of selectedIndices) {
        if (prevIdx !== -1 && idx - prevIdx > 1) {
          finalLines.push(`... (${idx - prevIdx - 1} lines omitted) ...`);
        }
        finalLines.push(cleanLines[idx]);
        prevIdx = idx;
      }
    }

    const header = `[✗ OBS-MASK] Exit ${exitCode}:`;
    const faultPin = options.disableFaultPin
      ? ''
      : extractTopFaultCodePin(clean, options.workspaceRoot || '');
    masked = `${header}\n${finalLines.join('\n')}${faultPin ? `\n${faultPin}` : ''}`;

    // Если исходный лог превышает 3500 символов (и CPU-компрессия не ужала его ниже порога), рекомендуем Flash-Lite Triage
    if (originalChars > 3500 && !(cpuCompressed && masked.length <= 1150)) {
      needsFlashLiteTriage = true;
      masked += `\n\n*(Large error log: ${originalChars} chars — triage via flash_lite)*`;
    }
  }

  let maskedChars = masked.length;
  let savedChars = Math.max(0, originalChars - maskedChars);
  const compressionKind = wasCrushed ? 'json' : (wasCompressed ? 'drain' : 'none');
  let ccrHash = '';

  const ccrActive = Boolean(options.enableCcr || options.ccrHub);
  if (ccrActive && originalChars >= 1200 && savedChars >= 600 && (masked.length + 140) < originalChars) {
    try {
      const hub = options.ccrHub || knowledgeHub;
      if (hub && typeof hub.storeCcrBlob === 'function') {
        const stored = hub.storeCcrBlob({
          text: clean,
          workspaceRoot: options.workspaceRoot || '',
          source: options.source || 'terminal',
          commandHint: options.commandLine || '',
          compressedChars: masked.length,
        });
        if (stored?.ok && stored.hash) {
          ccrHash = stored.hash;
          const maskedLines = masked.split('\n').length;
          const pct = Math.max(1, Math.min(99, Math.round((1 - (masked.length / Math.max(1, originalChars))) * 100)));
          const crumb = `\n[📦 CCR #${ccrHash} | ${originalLines}L->${maskedLines}L (-${pct}%) · Retrieve: ram_ccr_retrieve(hash="${ccrHash}", query="...")]`;
          if ((masked.length + crumb.length) < originalChars) {
            masked += crumb;
            maskedChars = masked.length;
            savedChars = Math.max(0, originalChars - maskedChars);
          }
        }
      }
    } catch {}
  }

  return {
    masked,
    originalLines,
    originalChars,
    maskedChars,
    savedChars,
    needsFlashLiteTriage,
    cpuCompressed,
    wasCrushed,
    compressionKind,
    rtkProfile,
    ...(ccrHash ? { ccrHash } : {}),
  };
}

/**
 * Асинхронная обёртка с опциональной GPU-дистилляцией (Ollama) для длинных логов (>3500 символов).
 * При отключённой или занятой видеокарте мгновенно возвращает детерминированный результат maskTerminalOutput.
 * @param {string} [rawOutput='']
 * @param {number} [exitCode=0]
 * @param {object} [options={}]
 */
export async function maskTerminalOutputSmart(rawOutput = '', exitCode = 0, options = {}) {
  const base = maskTerminalOutput(rawOutput, exitCode, options);
  if (base.cpuCompressed && base.maskedChars <= 1150 && base.savedChars >= base.originalChars * 0.45) {
    return { ...base, gpuDistilled: false };
  }
  const minChars = exitCode !== 0 ? 1500 : 2200;
  if (options.useGpu === false || base.originalChars <= minChars) {
    return { ...base, gpuDistilled: false };
  }
  if (exitCode === 0 && base.originalLines <= 32) {
    return { ...base, gpuDistilled: false };
  }

  try {
    const { distillText, loadGpuConfig } = await import('./local-gpu-engine.mjs');
    const cfg = loadGpuConfig();
    if (!cfg.gpuEnabled || !cfg.gpuAutoDistillLogs) {
      return { ...base, gpuDistilled: false };
    }
    const gpuRes = await distillText({
      text: redactSecretsInText(rawOutput),
      query: options.query || '',
      mode: exitCode !== 0 ? 'error_log' : 'general',
      maxOutputTokens: options.maxOutputTokens || 360,
      timeoutMs: options.gpuTimeoutMs || (options.hookMode ? 4500 : 12000),
      minFreeVramMb: options.minFreeVramMb ?? 5500,
      strictTimeout: Boolean(options.hookMode),
    });
    if (gpuRes.ok && gpuRes.summary) {
      const header = exitCode !== 0
        ? `[🎮 GPU-MASK] Exit ${exitCode} distilled (${gpuRes.model}, ${gpuRes.latencyMs}ms, -${gpuRes.savedTokensEstimate} tok):`
        : `[🎮 GPU-MASK] OK distilled (${gpuRes.model}, ${gpuRes.latencyMs}ms, -${gpuRes.savedTokensEstimate} tok):`;
      const verbatimFault = exitCode !== 0 && base.masked
        ? `\n--- Verbatim Fault/Tail ---\n${base.masked.slice(0, 650)}`
        : '';
      let masked = `${header}\n${gpuRes.summary}${verbatimFault}`;
      let ccrHash = base.ccrHash || '';
      const ccrActive = Boolean(options.enableCcr || options.ccrHub);
      if (ccrActive && !ccrHash && base.originalChars >= 1200) {
        try {
          const hub = options.ccrHub || knowledgeHub;
          const stored = hub?.storeCcrBlob?.({
            text: redactSecretsInText(normalizeTerminalRawText(rawOutput)).replace(ANSI_REGEX, ''),
            workspaceRoot: options.workspaceRoot || '',
            source: options.source || 'gpu_distill',
            commandHint: options.commandLine || options.query || '',
            compressedChars: masked.length,
          });
          if (stored?.ok && stored.hash) ccrHash = stored.hash;
        } catch {}
      }
      if (ccrActive && ccrHash && !masked.includes(`CCR #${ccrHash}`)) {
        const maskedLines = masked.split('\n').length;
        const pct = Math.max(1, Math.min(99, Math.round((1 - (masked.length / Math.max(1, base.originalChars))) * 100)));
        masked += `\n[📦 CCR #${ccrHash} | ${base.originalLines}L->${maskedLines}L (-${pct}%) · Retrieve: ram_ccr_retrieve(hash="${ccrHash}", query="...")]`;
      }
      return {
        masked,
        originalLines: base.originalLines,
        originalChars: base.originalChars,
        maskedChars: masked.length,
        savedChars: Math.max(0, base.originalChars - masked.length),
        needsFlashLiteTriage: false,
        cpuCompressed: base.cpuCompressed,
        gpuDistilled: true,
        gpuModel: gpuRes.model,
        gpuLatencyMs: gpuRes.latencyMs,
        ...(ccrHash ? { ccrHash } : {}),
      };
    }
  } catch {}

  return { ...base, gpuDistilled: false };
}

// Поддержка запуска из CLI: cmd 2>&1 | node core/obs-masker.mjs --stdin [--gpu|--no-gpu] [--force]
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cliArgs = process.argv.slice(2);
  const noGpuFlag = cliArgs.includes('--no-gpu');
  const forceMask = cliArgs.includes('--force');
  const exitCodeArg = cliArgs.find(a => a.startsWith('--exit-code='));
  let exitCode = 0;
  let numArgUsed = '';

  if (exitCodeArg) {
    exitCode = parseInt(exitCodeArg.split('=')[1], 10) || 0;
  } else {
    const numArg = cliArgs.find(a => /^\d+$/.test(a));
    if (numArg) {
      exitCode = parseInt(numArg, 10);
      numArgUsed = numArg;
    }
  }

  const rawPositional = cliArgs.find((a) => (
    a !== '--stdin' && a !== '--gpu' && a !== '--no-gpu' && a !== '--force' && !a.startsWith('--exit-code=') && a !== numArgUsed
  )) || '';
  const isStdin = cliArgs.includes('--stdin') || (!rawPositional && !process.stdin.isTTY);
  let maskEnabled = true;
  if (!forceMask) {
    try {
      const statePath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'router-state.json');
      if (existsSync(statePath)) {
        const st = JSON.parse(readFileSync(statePath, 'utf8'));
        if (st && st.obsMasking === false) maskEnabled = false;
      }
    } catch {}
  }

  const runMask = async (text) => {
    if (!maskEnabled) return maskTerminalOutput(text, exitCode, { enabled: false });
    const ccrOpts = { enableCcr: true, workspaceRoot: process.cwd() };
    return noGpuFlag ? maskTerminalOutput(text, exitCode, ccrOpts) : await maskTerminalOutputSmart(text, exitCode, ccrOpts);
  };

  if (isStdin) {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { input += chunk; });
    process.stdin.on('end', async () => {
      const res = await runMask(input);
      if (exitCode !== 0) {
        try {
          const { recordErrorFingerprint } = await import('./circuit-breaker.mjs');
          recordErrorFingerprint({ source: 'terminal', errorText: res.masked });
        } catch {}
      }
      console.log(res.masked);
    });
  } else {
    const res = await runMask(rawPositional);
    if (exitCode !== 0) {
      try {
        const { recordErrorFingerprint } = await import('./circuit-breaker.mjs');
        recordErrorFingerprint({ source: 'terminal', errorText: res.masked });
      } catch {}
    }
    console.log(res.masked);
  }
}

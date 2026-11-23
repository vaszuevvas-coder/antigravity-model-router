/**
 * @file file-worker-tasks.mjs
 * @description Worker-safe per-file polyglot analyzer for [T1] Syntax/Encoding, [T2] Graph/Exports/Complexity,
 *              [T3] Neuro-Symbolic Taint/Secrets/Env/ReDoS, [T4] Concurrency/Resource Leaks, and [T5] UI/API Signals.
 */

import { existsSync } from 'node:fs';
import * as nodeModule from 'node:module';
import { dirname, extname, resolve } from 'node:path';
import vm from 'node:vm';

const JS_TS_EXTS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx']);
const SCRIPT_CHECK_EXTS = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts']);

const SENSITIVE_ASSIGN_RE = /\b(api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key|client[_-]?secret|db[_-]?password|password|jwt[_-]?secret|signing[_-]?key)\b\s*[:=]\s*(['"`])([A-Za-z0-9+/=._-]{20,})\2/gi;

const TOKEN_PATTERNS = [
  { id: 'AWS_ACCESS_KEY', cwe: 'CWE-798', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { id: 'GITHUB_TOKEN', cwe: 'CWE-798', re: /\b(?:ghp|gho|ghu|ghs)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{30,}\b/g },
  { id: 'OPENAI_OR_ANTHROPIC_KEY', cwe: 'CWE-798', re: /\bsk-(?:proj-|ant-|live-)[A-Za-z0-9_-]{20,}\b/g },
  { id: 'GOOGLE_API_KEY', cwe: 'CWE-798', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: 'SLACK_TOKEN', cwe: 'CWE-798', re: /\bxox[baprs]-[0-9]{10,}-[A-Za-z0-9-]{10,}\b/g },
  { id: 'PRIVATE_KEY_BLOCK', cwe: 'CWE-798', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g },
];

const PLACEHOLDER_SECRET_RE = /(?:example|placeholder|changeme|dummy|sample|test[_-]?key|your[_-]?api[_-]?key|localhost|xxxx|0000)/i;

const DANGEROUS_REDOS_PATTERNS = [
  /\([^)]*[+*][^)]*\)[+*]/,
  /\([^)]*\|[^)]*\)[+*]/,
  /\(\.\*[^)]*\)[+*{]/,
  /\[[^\]]+\][+*][^/]*\1|\(\[[^\]]+\][+*]\)[+*]/,
];

function isSuspiciousRedosPattern(pattern) {
  if (!pattern || typeof pattern !== 'string') return false;
  // Normalize char classes that explicitly exclude '\' so provably disjoint O(N) escaped-literal groups can be collapsed
  let out = '';
  let i = 0;
  while (i < pattern.length) {
    if (pattern[i] === '\\' && i + 1 < pattern.length) {
      out += pattern[i] + pattern[i + 1];
      i += 2;
      continue;
    }
    if (pattern[i] === '[') {
      const start = i;
      i++;
      if (i < pattern.length && pattern[i] === '^') i++;
      if (i < pattern.length && pattern[i] === ']') i++;
      while (i < pattern.length && pattern[i] !== ']') {
        if (pattern[i] === '\\' && i + 1 < pattern.length) i += 2;
        else i++;
      }
      if (i < pattern.length && pattern[i] === ']') i++;
      const cls = pattern.slice(start, i);
      out += (cls.startsWith('[^') && cls.includes('\\\\')) ? '__NEG_NO_BS__' : cls;
      continue;
    }
    out += pattern[i++];
  }
  const normalized = out
    .replace(/\(\?:(?:\\\\\.|__NEG_NO_BS__)\|(?:\\\\\.|__NEG_NO_BS__)\)[+*]/g, '__ESC__')
    .replace(/\(\?:\\\\\.\|\\\[__ESC__\\\]\|__NEG_NO_BS__\)[+*]/g, '__RE_LIT__');
  return DANGEROUS_REDOS_PATTERNS.some((p) => p.test(normalized));
}

function shannonEntropy(str) {
  if (!str) return 0;
  const counts = new Map();
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    counts.set(ch, (counts.get(ch) || 0) + 1);
  }
  let ent = 0;
  for (const c of counts.values()) {
    const p = c / str.length;
    ent -= p * Math.log2(p);
  }
  return ent;
}

function stripJsonCommentsAndTrailingCommas(text) {
  let out = '';
  let inStr = false;
  let esc = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (ch === '\n') {
        inLine = false;
        out += '\n';
      }
      continue;
    }
    if (inBlock) {
      if (ch === '*' && next === '/') {
        inBlock = false;
        i++;
      } else if (ch === '\n') {
        out += '\n';
      }
      continue;
    }
    if (inStr) {
      out += ch;
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
    } else if (ch === '/' && next === '/') {
      inLine = true;
      i++;
    } else if (ch === '/' && next === '*') {
      inBlock = true;
      i++;
    } else {
      out += ch;
    }
  }
  return out.replace(/,\s*([}\]])/g, '$1');
}

/**
 * Line-preserving comment masker for JS/TS/Go/Rust/C/Java/C# and Python/Shell (# comments).
 * Leaves string literals intact except neutralizing comment markers inside strings? No, walks char-by-char properly!
 */
export function maskCommentsPreservingLines(code, language = 'javascript') {
  if (!code) return '';
  const useHashComments = language === 'python' || language === 'shell' || language === 'config';
  const useSlashComments = !useHashComments;
  let out = '';
  let i = 0;
  const n = code.length;

  while (i < n) {
    const ch = code[i];
    const next = code[i + 1];

    // Triple-quoted strings in Python
    if (useHashComments && (ch === '"' || ch === "'") && code[i + 1] === ch && code[i + 2] === ch) {
      const q3 = ch.repeat(3);
      out += q3;
      i += 3;
      while (i < n) {
        if (code[i] === '\\' && i + 1 < n) {
          out += code[i] + code[i + 1];
          i += 2;
          continue;
        }
        if (code.slice(i, i + 3) === q3) {
          out += q3;
          i += 3;
          break;
        }
        out += code[i];
        i++;
      }
      continue;
    }

    // Rust raw strings: r#"..."#, r"...", br#"..."#, cr#"..."#
    if (language === 'rust' && (ch === 'r' || ((ch === 'b' || ch === 'c') && next === 'r')) && (i === 0 || !/[A-Za-z0-9_]/.test(code[i - 1]))) {
      const prefixLen = ch === 'r' ? 1 : 2;
      let j = i + prefixLen;
      while (j < n && code[j] === '#') j++;
      if (j < n && code[j] === '"') {
        const hashCount = j - (i + prefixLen);
        const endFence = '"' + '#'.repeat(hashCount);
        out += code.slice(i, j + 1);
        i = j + 1;
        while (i < n) {
          if (code.startsWith(endFence, i)) {
            out += endFence;
            i += endFence.length;
            break;
          }
          out += code[i++];
        }
        continue;
      }
    }

    // Rust char literals ('x', '\n', '\u{...}') vs lifetimes ('a, 'static, '_)
    if (language === 'rust' && ch === "'") {
      const mChar = /^'(?:[^'\\\r\n]|\\(?:.|x[0-9a-fA-F]{2}|u\{[0-9a-fA-F_]{1,6}\}))'/.exec(code.slice(i, i + 20));
      if (mChar) {
        out += mChar[0];
        i += mChar[0].length;
      } else {
        out += ch;
        i++;
      }
      continue;
    }

    // Go raw backtick strings (`...`) do NOT treat backslash as an escape
    if (language === 'go' && ch === '`') {
      out += ch;
      i++;
      while (i < n) {
        const c = code[i++];
        out += c;
        if (c === '`') break;
      }
      continue;
    }

    // Standard strings (single, double, backtick)
    if (ch === '"' || ch === "'" || (useSlashComments && ch === '`')) {
      const q = ch;
      out += q;
      i++;
      while (i < n) {
        const c = code[i];
        if (c === '\\' && i + 1 < n) {
          out += c + code[i + 1];
          i += 2;
          continue;
        }
        out += c;
        i++;
        if (c === q) break;
        if (q !== '`' && c === '\n') break;
      }
      continue;
    }

    if (useSlashComments && ch === '/' && next === '/') {
      while (i < n && code[i] !== '\n') i++;
      continue;
    }

    if (useSlashComments && ch === '/' && next === '*') {
      i += 2;
      while (i < n) {
        if (code[i] === '*' && code[i + 1] === '/') {
          i += 2;
          break;
        }
        if (code[i] === '\n') out += '\n';
        i++;
      }
      continue;
    }

    if (useHashComments && ch === '#') {
      while (i < n && code[i] !== '\n') i++;
      continue;
    }

    // Preserve regex literals cleanly in JS/TS so // inside /.../ is not treated as comment
    if (useSlashComments && ch === '/' && next !== '/' && next !== '*') {
      const prevNonWs = out.replace(/[ \t]+$/, '').slice(-1);
      if (!prevNonWs || '=(,:!&|?+~^;{}\n['.includes(prevNonWs) || /\b(?:return|throw|case)\s*$/.test(out)) {
        out += ch;
        i++;
        let inClass = false;
        while (i < n) {
          const rc = code[i];
          if (rc === '\n') break;
          if (rc === '\\' && i + 1 < n) {
            out += rc + code[i + 1];
            i += 2;
            continue;
          }
          if (rc === '[') inClass = true;
          else if (rc === ']') inClass = false;
          else if (rc === '/' && !inClass) {
            out += rc;
            i++;
            break;
          }
          out += rc;
          i++;
        }
        continue;
      }
    }

    out += ch;
    i++;
  }
  return out;
}

/**
 * Strips string contents and regex literals to prevent regex/bracket checks from matching text inside strings.
 */
function stripStringsAndRegexesPreservingLines(codeNoComments, language = 'javascript') {
  const allowRegexLiterals = language === 'javascript' || language === 'typescript';
  let out = '';
  let i = 0;
  const n = codeNoComments.length;
  while (i < n) {
    const ch = codeNoComments[i];
    if (language === 'rust' && (ch === 'r' || ((ch === 'b' || ch === 'c') && codeNoComments[i + 1] === 'r')) && (i === 0 || !/[A-Za-z0-9_]/.test(codeNoComments[i - 1]))) {
      const prefixLen = ch === 'r' ? 1 : 2;
      let j = i + prefixLen;
      while (j < n && codeNoComments[j] === '#') j++;
      if (j < n && codeNoComments[j] === '"') {
        const hashCount = j - (i + prefixLen);
        const endFence = '"' + '#'.repeat(hashCount);
        out += '"';
        i = j + 1;
        while (i < n) {
          if (codeNoComments.startsWith(endFence, i)) {
            i += endFence.length;
            break;
          }
          if (codeNoComments[i] === '\n') out += '\n';
          i++;
        }
        out += '"';
        continue;
      }
    }
    if (language === 'rust' && ch === "'") {
      const mChar = /^'(?:[^'\\\r\n]|\\(?:.|x[0-9a-fA-F]{2}|u\{[0-9a-fA-F_]{1,6}\}))'/.exec(codeNoComments.slice(i, i + 20));
      if (mChar) {
        out += "''";
        i += mChar[0].length;
      } else {
        out += ch;
        i++;
      }
      continue;
    }
    if (language === 'go' && ch === '`') {
      out += '`';
      i++;
      while (i < n) {
        const c = codeNoComments[i++];
        if (c === '\n') out += '\n';
        if (c === '`') break;
      }
      out += '`';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const q = ch;
      out += q;
      i++;
      while (i < n) {
        const c = codeNoComments[i];
        if (c === '\\' && i + 1 < n) {
          i += 2;
          continue;
        }
        if (c === '\n') out += '\n';
        i++;
        if (c === q) break;
      }
      out += q;
      continue;
    }
    if (allowRegexLiterals && ch === '/' && codeNoComments[i + 1] !== '/' && codeNoComments[i + 1] !== '*') {
      const prevNonWs = out.replace(/[ \t]+$/, '').slice(-1);
      if (!prevNonWs || '=(,:!&|?+~^;{}\n['.includes(prevNonWs) || /\b(?:return|throw|case)\s*$/.test(out)) {
        out += '/';
        i++;
        let inClass = false;
        while (i < n) {
          const rc = codeNoComments[i];
          if (rc === '\n') break;
          if (rc === '\\' && i + 1 < n) {
            i += 2;
            continue;
          }
          if (rc === '[') inClass = true;
          else if (rc === ']') inClass = false;
          else if (rc === '/' && !inClass) {
            i++;
            break;
          }
          i++;
        }
        out += '/';
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

function isIntentionalErrorFixture(relPath = '') {
  const norm = String(relPath || '').replace(/\\/g, '/').toLowerCase();
  if (!/(?:^|\/)(?:__tests__|tests?|spec|__fixtures__|fixtures?|playground)\//.test(norm)) {
    return false;
  }
  return (
    /(?:^|\/)[^/]*(?:syntax[-_]?error|invalid[-_]?json|parse[-_]?error|malformed|broken|corrupt|bad[-_]?json|has[-_]?error|load[-_]?error|tsconfig-json-load-error)(?:\/|\.|$)/.test(norm) ||
    /(?:^|\/)(?:__fixtures__|fixtures)\/.*\.json$/i.test(norm)
  );
}

function isGitSymlinkStub(file, code) {
  if (!code || code.includes('\n')) return false;
  const trimmed = code.trim();
  if (!trimmed || trimmed.length > 260 || !/^\.\.?\/[A-Za-z0-9_.@/-]+$/.test(trimmed)) return false;
  try {
    return Boolean(file && existsSync(resolve(dirname(file), trimmed)));
  } catch {
    return false;
  }
}

function checkJsTsSyntax(file, ext, code, findings, relPath = file) {
  if (isIntentionalErrorFixture(relPath) || isGitSymlinkStub(file, code)) {
    return { syntaxOk: true, needsSubprocessCheck: false };
  }
  const isModuleLike = ext === '.mjs' || ext === '.mts' || ext === '.ts' || ext === '.tsx' ||
    (ext === '.js' && /\b(?:import|export)\b|\bawait\b/.test(code));

  const hasJsxMarkup = ext === '.js' && (
    /<\/[A-Za-z][A-Za-z0-9.]*>|<>|<\/>/.test(code) ||
    /(?:return\s*\(\s*|=>\s*\(?|[\s(=:?])<[A-Z][A-Za-z0-9.]*(?:\s|\/?>)/.test(code)
  );

  if (ext === '.cjs' || (ext === '.js' && !isModuleLike)) {
    try {
      new vm.Script(code, { filename: file });
      return { syntaxOk: true, needsSubprocessCheck: false };
    } catch (err) {
      if (hasJsxMarkup) {
        return { syntaxOk: true, needsSubprocessCheck: false };
      }
      if (/Illegal return statement/i.test(String(err?.message || '')) && /\b(?:module\.exports|exports\.|require\s*\()/.test(code)) {
        try {
          new vm.Script(`(function(exports,require,module,__filename,__dirname){\n${code}\n})`, { filename: file });
          return { syntaxOk: true, needsSubprocessCheck: false };
        } catch {}
      }
      findings.push({
        tier: 'T1',
        ruleId: 'SYNTAX_ERROR',
        severity: 'CRITICAL',
        cwe: 'CWE-1006',
        confidence: 0.99,
        file,
        line: 1,
        message: 'JavaScript syntax error',
        evidence: String(err?.message || err).slice(0, 180),
      });
      return { syntaxOk: false, needsSubprocessCheck: false };
    }
  }

  if (ext === '.jsx' || ext === '.tsx' || hasJsxMarkup || /\.d\.[cm]?ts$/i.test(relPath) || /\.d\.[cm]?ts$/i.test(file)) {
    return { syntaxOk: true, needsSubprocessCheck: false };
  }

  if (typeof nodeModule.stripTypeScriptTypes === 'function') {
    try {
      const stripped = nodeModule.stripTypeScriptTypes(code, { mode: 'strip' });
      if (ext === '.ts' || ext === '.mts' || ext === '.cts') {
        if (!/\b(?:import|export)\b/.test(stripped)) {
          new vm.Script(stripped, { filename: file });
        }
      }
      return { syntaxOk: true, needsSubprocessCheck: false };
    } catch (err) {
      if (err?.code === 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX') {
        return { syntaxOk: true, needsSubprocessCheck: false };
      }
      findings.push({
        tier: 'T1',
        ruleId: 'SYNTAX_ERROR',
        severity: 'CRITICAL',
        cwe: 'CWE-1006',
        confidence: 0.98,
        file,
        line: 1,
        message: `${ext === '.ts' || ext === '.mts' ? 'TypeScript' : 'ESM'} syntax error`,
        evidence: String(err?.message || err).slice(0, 180),
      });
      return { syntaxOk: false, needsSubprocessCheck: false };
    }
  }
  return { syntaxOk: true, needsSubprocessCheck: true };
}

function checkHtmlSyntax(file, html, findings) {
  const scriptMatches = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  for (const m of scriptMatches) {
    const attrs = m[1] || '';
    const code = m[2] || '';
    if (/\bsrc\s*=/i.test(attrs) || !code.trim()) continue;
    const typeMatch = attrs.match(/\btype\s*=\s*["']?([a-zA-Z0-9_/+.-]+)/i);
    const scriptType = (typeMatch?.[1] || '').toLowerCase();
    const prefixLines = html.slice(0, m.index).split(/\r?\n/).length;

    // Sanitize or skip server-side template expressions (Jinja2/Django/Handlebars/EJS)
    const hasTemplateTags = /\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}|\{#[\s\S]*?#\}|<%=?[\s\S]*?%>/.test(code);
    if (hasTemplateTags && /\{%[\s\S]*?%\}|<%(?!=)[\s\S]*?%>/.test(code)) {
      continue;
    }
    const sanitizedCode = hasTemplateTags
      ? code
          .replace(/\{#[\s\S]*?#\}/g, (s) => s.replace(/[^\r\n]/g, ' '))
          .replace(/\{\{[\s\S]*?\}\}|<%=[\s\S]*?%>/g, (s) => {
            const nl = s.match(/\n/g);
            return nl ? `null${'\n'.repeat(nl.length)}` : 'null';
          })
      : code;

    if (scriptType === 'application/json' || scriptType === 'importmap' || scriptType === 'speculationrules') {
      try {
        JSON.parse(sanitizedCode);
      } catch (err) {
        findings.push({
          tier: 'T1',
          ruleId: 'HTML_INLINE_JSON_ERROR',
          severity: 'HIGH',
          cwe: 'CWE-20',
          confidence: 0.96,
          file,
          line: prefixLines,
          message: `Invalid JSON inside <script type="${scriptType}">`,
          evidence: String(err?.message || err).slice(0, 160),
        });
      }
      continue;
    }

    if (scriptType && !['module', 'text/javascript', 'application/javascript'].includes(scriptType)) {
      continue;
    }

    try {
      if (scriptType === 'module' && typeof nodeModule.stripTypeScriptTypes === 'function') {
        nodeModule.stripTypeScriptTypes(sanitizedCode, { mode: 'strip' });
      } else if (scriptType !== 'module') {
        new vm.Script(sanitizedCode, { filename: file });
      }
    } catch (err) {
      findings.push({
        tier: 'T1',
        ruleId: 'HTML_INLINE_SCRIPT_SYNTAX_ERROR',
        severity: 'CRITICAL',
        cwe: 'CWE-1006',
        confidence: 0.97,
        file,
        line: prefixLines,
        message: 'Syntax error in HTML inline <script>',
        evidence: String(err?.message || err).slice(0, 180),
      });
    }
  }
}

function checkBracketBalance(file, strippedCode, findings) {
  const stack = [];
  const pairs = { '(': ')', '[': ']', '{': '}' };
  const closeToOpen = { ')': '(', ']': '[', '}': '{' };
  let line = 1;
  for (let i = 0; i < strippedCode.length; i++) {
    const ch = strippedCode[i];
    if (ch === '\n') {
      line++;
      continue;
    }
    if (pairs[ch]) {
      stack.push({ ch, line });
    } else if (closeToOpen[ch]) {
      const top = stack.pop();
      if (!top || top.ch !== closeToOpen[ch]) {
        findings.push({
          tier: 'T1',
          ruleId: 'UNBALANCED_DELIMITER',
          severity: 'HIGH',
          cwe: 'CWE-1006',
          confidence: 0.85,
          file,
          line,
          message: `Unmatched closing delimiter '${ch}'`,
          evidence: top ? `Expected '${pairs[top.ch]}' for opener at L${top.line}` : `Unexpected '${ch}'`,
        });
        return;
      }
    }
  }
  if (stack.length > 0) {
    const unclosed = stack[stack.length - 1];
    findings.push({
      tier: 'T1',
      ruleId: 'UNBALANCED_DELIMITER',
      severity: 'HIGH',
      cwe: 'CWE-1006',
      confidence: 0.85,
      file,
      line: unclosed.line,
      message: `Unclosed delimiter '${unclosed.ch}'`,
      evidence: `Opener '${unclosed.ch}' at L${unclosed.line} never closed`,
    });
  }
}

function checkConfigAndEncoding(item, findings) {
  const { relPath, ext, baseName, text, hasUtf8Bom, hasUtf16Bom, hasNullBytes } = item;
  const lowerBase = baseName.toLowerCase();

  if (hasNullBytes || hasUtf16Bom) {
    findings.push({
      tier: 'T1',
      ruleId: 'ENCODING_CORRUPTION',
      severity: 'HIGH',
      cwe: 'CWE-172',
      confidence: 0.94,
      file: relPath,
      line: 1,
      message: hasUtf16Bom ? 'UTF-16 BOM detected in source/config file (incompatible with POSIX/UTF-8 tooling)' : 'Unexpected NUL (0x00) bytes inside text file',
      evidence: hasUtf16Bom ? 'UTF-16 BOM header' : '0x00 byte present',
    });
  }

  if (hasUtf8Bom && text.startsWith('#!')) {
    findings.push({
      tier: 'T1',
      ruleId: 'BOM_SHEBANG_CONFLICT',
      severity: 'HIGH',
      cwe: 'CWE-172',
      confidence: 0.98,
      file: relPath,
      line: 1,
      message: 'UTF-8 BOM before #! shebang breaks execution on Linux/macOS',
      evidence: 'EF BB BF + #!',
    });
  }

  if (text.includes('\uFFFD')) {
    const lineIdx = text.split(/\r?\n/).findIndex((l) => l.includes('\uFFFD')) + 1;
    findings.push({
      tier: 'T1',
      ruleId: 'MOJIBAKE_REPLACEMENT_CHAR',
      severity: 'MEDIUM',
      cwe: 'CWE-172',
      confidence: 0.9,
      file: relPath,
      line: lineIdx || 1,
      message: 'Unicode replacement character (U+FFFD) detected — possible broken encoding',
      evidence: 'U+FFFD found',
    });
  }

  if (ext === '.json' || ext === '.jsonc') {
    if (isIntentionalErrorFixture(relPath)) return;
    const normRel = String(relPath || '').replace(/\\/g, '/');
    const allowJsonc =
      ext === '.jsonc' ||
      /^[tj]sconfig.*\.json$/i.test(lowerBase) ||
      lowerBase === 'biome.jsonc' ||
      lowerBase === 'biome.json' ||
      /(?:^|\/)\.(?:vscode|devcontainer)\/[^/]+\.json$/i.test(normRel) ||
      /^(?:\.?devcontainer|\.eslintrc|\.babelrc|\.swcrc|turbo|renovate|nx|rush|lerna|oclif)\.json$/i.test(lowerBase);
    try {
      JSON.parse(allowJsonc ? stripJsonCommentsAndTrailingCommas(text) : text);
    } catch (err) {
      findings.push({
        tier: 'T1',
        ruleId: 'INVALID_JSON',
        severity: 'CRITICAL',
        cwe: 'CWE-20',
        confidence: 0.99,
        file: relPath,
        line: 1,
        message: 'Invalid JSON syntax',
        evidence: String(err?.message || err).slice(0, 160),
      });
    }
  } else if (item.kind === 'env') {
    const lines = text.split(/\r?\n/);
    let openQuote = '';
    for (let i = 0; i < lines.length; i++) {
      const rawLine = lines[i];
      const t = rawLine.trim();
      if (openQuote) {
        let escaped = false;
        for (let c = 0; c < rawLine.length; c++) {
          const ch = rawLine[c];
          if (escaped) { escaped = false; continue; }
          if (ch === '\\' && openQuote === '"') { escaped = true; continue; }
          if (ch === openQuote) { openQuote = ''; break; }
        }
        continue;
      }
      if (!t || t.startsWith('#')) continue;
      if (!/^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=/.test(t)) {
        findings.push({
          tier: 'T1',
          ruleId: 'MALFORMED_ENV_LINE',
          severity: 'MEDIUM',
          cwe: 'CWE-1188',
          confidence: 0.85,
          file: relPath,
          line: i + 1,
          message: 'Malformed environment variable assignment',
          evidence: t.slice(0, 80),
        });
      } else {
        const eqPos = t.indexOf('=');
        const rhs = t.slice(eqPos + 1).trim();
        if (rhs.startsWith("'") || rhs.startsWith('"')) {
          const q = rhs[0];
          let closed = false;
          let escaped = false;
          for (let c = 1; c < rhs.length; c++) {
            const ch = rhs[c];
            if (escaped) { escaped = false; continue; }
            if (ch === '\\' && q === '"') { escaped = true; continue; }
            if (ch === q) { closed = true; break; }
          }
          if (!closed) openQuote = q;
        }
      }
    }
  } else if (ext === '.yaml' || ext === '.yml') {
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (/^\t+/.test(lines[i])) {
        findings.push({
          tier: 'T1',
          ruleId: 'YAML_TAB_INDENT',
          severity: 'HIGH',
          cwe: 'CWE-1006',
          confidence: 0.95,
          file: relPath,
          line: i + 1,
          message: 'Tab character used for YAML indentation (forbidden by YAML spec)',
          evidence: lines[i].slice(0, 60),
        });
        break;
      }
    }
  } else if (item.kind === 'dockerfile') {
    if (!/^\s*FROM\s+\S+/im.test(text)) {
      findings.push({
        tier: 'T1',
        ruleId: 'DOCKERFILE_MISSING_FROM',
        severity: 'HIGH',
        cwe: 'CWE-1188',
        confidence: 0.9,
        file: relPath,
        line: 1,
        message: 'Dockerfile missing valid FROM instruction',
        evidence: 'No FROM instruction found',
      });
    }
  }
}

function parseNamedSpecifiers(rawList) {
  const out = [];
  for (const part of rawList.split(',')) {
    const trimmed = part.trim().replace(/^type\s+/, '');
    if (!trimmed) continue;
    const asParts = trimmed.split(/\s+as\s+/);
    const imported = asParts[0].trim();
    const local = (asParts[1] || imported).trim();
    if (/^[A-Za-z0-9_$]+$/.test(imported)) {
      out.push({ imported, local });
    }
  }
  return out;
}

const JS_REGEX_PREFIX_KEYWORDS = new Set([
  'return', 'throw', 'case', 'default', 'delete', 'void', 'typeof',
  'await', 'yield', 'in', 'of', 'instanceof', 'new', 'else', 'do',
]);

const JS_NON_IMPORT_CLAUSE_KEYWORDS = new Set([
  'function', 'class', 'const', 'let', 'var', 'return', 'if',
  'for', 'while', 'switch', 'try', 'throw', 'import', 'export',
]);

/**
 * Single-pass JS/TS lexer that skips comments, regex literals, and static
 * template bodies while preserving `${...}` expressions and exact token offsets.
 */
function createJsTsImportLexer(rawCode = '') {
  const code = String(rawCode || '');
  const len = code.length;
  let i = 0;
  if (code.startsWith('#!')) {
    while (i < len && code[i] !== '\n' && code[i] !== '\r') i += 1;
  }
  let canRegex = true;
  const tplStack = [];
  let pushed = null;

  const consumeTemplateBody = (tokStart) => {
    while (i < len) {
      const ch = code[i];
      if (ch === '\\' && i + 1 < len) {
        i += 2;
        continue;
      }
      if (ch === '`') {
        i += 1;
        canRegex = false;
        return { type: 'tpl', value: '`', start: tokStart };
      }
      if (ch === '$' && i + 1 < len && code[i + 1] === '{') {
        const exprStart = i;
        i += 2;
        tplStack.push(0);
        canRegex = true;
        return { type: 'punct', value: '${', start: exprStart };
      }
      i += 1;
    }
    canRegex = false;
    return null;
  };

  const readNext = () => {
    while (i < len) {
      const ch = code[i];
      const next = i + 1 < len ? code[i + 1] : '';

      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v') {
        i += 1;
        continue;
      }
      if (ch === '/' && next === '/') {
        i += 2;
        while (i < len && code[i] !== '\n' && code[i] !== '\r') i += 1;
        continue;
      }
      if (ch === '/' && next === '*') {
        i += 2;
        while (i < len && !(code[i] === '*' && code[i + 1] === '/')) i += 1;
        i = Math.min(len, i + 2);
        continue;
      }
      if (ch === "'" || ch === '"') {
        const tokStart = i;
        const q = ch;
        i += 1;
        const valStart = i;
        let valEnd = i;
        while (i < len) {
          const sc = code[i];
          if (sc === '\\' && i + 1 < len) {
            i += 2;
            valEnd = i;
            continue;
          }
          if (sc === q) {
            valEnd = i;
            i += 1;
            break;
          }
          if (sc === '\n' || sc === '\r') {
            valEnd = i;
            break;
          }
          i += 1;
          valEnd = i;
        }
        canRegex = false;
        return { type: 'str', value: code.slice(valStart, valEnd), start: tokStart };
      }
      if (ch === '`') {
        const tokStart = i;
        i += 1;
        const tplTok = consumeTemplateBody(tokStart);
        if (tplTok) return tplTok;
        continue;
      }
      if (ch === '/' && canRegex) {
        const tokStart = i;
        i += 1;
        let inClass = false;
        while (i < len) {
          const rc = code[i];
          if (rc === '\n' || rc === '\r') break;
          if (rc === '\\' && i + 1 < len) {
            i += 2;
            continue;
          }
          if (rc === '[') inClass = true;
          else if (rc === ']') inClass = false;
          else if (rc === '/' && !inClass) {
            i += 1;
            while (i < len && /[a-zA-Z]/.test(code[i])) i += 1;
            break;
          }
          i += 1;
        }
        canRegex = false;
        return { type: 'regex', value: '/', start: tokStart };
      }
      if (tplStack.length > 0 && ch === '}') {
        const tokStart = i;
        const depth = tplStack[tplStack.length - 1];
        if (depth === 0) {
          tplStack.pop();
          i += 1;
          const resumed = consumeTemplateBody(tokStart);
          if (resumed) return resumed;
          continue;
        }
        tplStack[tplStack.length - 1] = depth - 1;
        i += 1;
        canRegex = true;
        return { type: 'punct', value: '}', start: tokStart };
      }
      if (tplStack.length > 0 && ch === '{') {
        const tokStart = i;
        tplStack[tplStack.length - 1] += 1;
        i += 1;
        canRegex = true;
        return { type: 'punct', value: '{', start: tokStart };
      }
      if (/[A-Za-z_$]/.test(ch)) {
        const tokStart = i;
        i += 1;
        while (i < len && /[A-Za-z0-9_$]/.test(code[i])) i += 1;
        const value = code.slice(tokStart, i);
        canRegex = JS_REGEX_PREFIX_KEYWORDS.has(value);
        return { type: 'id', value, start: tokStart };
      }
      if (/[0-9]/.test(ch)) {
        const tokStart = i;
        i += 1;
        while (i < len && /[0-9a-fA-FxXoObBnNeE_.]/.test(code[i])) i += 1;
        canRegex = false;
        return { type: 'num', value: '0', start: tokStart };
      }
      if (ch === '=' && next === '>') {
        const tokStart = i;
        i += 2;
        canRegex = true;
        return { type: 'punct', value: '=>', start: tokStart };
      }
      if (ch === '?' && next === '.') {
        const tokStart = i;
        i += 2;
        canRegex = false;
        return { type: 'punct', value: '?.', start: tokStart };
      }
      const tokStart = i;
      i += 1;
      canRegex = '([{,;:=!&|?+~^*-/%<>}'.includes(ch);
      return { type: 'punct', value: ch, start: tokStart };
    }
    return null;
  };

  return {
    next() {
      if (pushed) {
        const tok = pushed;
        pushed = null;
        return tok;
      }
      return readNext();
    },
    peek() {
      if (!pushed) pushed = readNext();
      return pushed;
    },
    pushBack(tok) {
      if (tok) pushed = tok;
    },
  };
}

function extractJsTsImportsAndExports(relPath, cleanCode, findings) {
  const imports = [];
  const namedExports = [];
  let hasDefaultExport = false;
  let hasStarReExport = false;
  const reExportSpecifiers = [];
  let isDynamicCjsExports = false;
  const asyncFunctions = [];
  let cyclomatic = 1;
  let maxNesting = 0;
  let curBraceDepth = 0;

  const lines = cleanCode.split(/\r?\n/);
  const lineOffsets = [0];
  for (let i = 0; i < lines.length; i++) {
    lineOffsets.push(lineOffsets[i] + lines[i].length + 1);
  }
  const offsetToLine = (idx) => {
    let lo = 0;
    let hi = lines.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lineOffsets[mid] <= idx) lo = mid + 1;
      else hi = mid - 1;
    }
    return Math.max(1, lo);
  };

  // Complexity & async functions
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const trimmed = l.trim();
    const fnAsync = trimmed.match(/^(?:export\s+(?:default\s+)?)?async\s+function\s+([A-Za-z0-9_$]+)/);
    if (fnAsync) asyncFunctions.push(fnAsync[1]);
    const arrowAsync = trimmed.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*async\s*(?:\([^)]*\)|[A-Za-z0-9_$]+)\s*=>/);
    if (arrowAsync) asyncFunctions.push(arrowAsync[1]);

    if (trimmed) {
      const branchHits = trimmed.match(/\b(?:if|else\s+if|for|while|case|catch)\b|\?\s*[^:?]+\s*:|&&|\|\|/g);
      if (branchHits) cyclomatic += branchHits.length;
      for (let k = 0; k < l.length; k++) {
        if (l[k] === '{') {
          curBraceDepth++;
          if (curBraceDepth > maxNesting) maxNesting = curBraceDepth;
        } else if (l[k] === '}' && curBraceDepth > 0) {
          curBraceDepth--;
        }
      }
    }
  }

  const checkBackslashSpecifier = (specifier, line, message) => {
    if (specifier.startsWith('.\\') || specifier.startsWith('..\\')) {
      findings.push({
        tier: 'T1',
        ruleId: 'NON_PORTABLE_BACKSLASH_IMPORT',
        severity: 'HIGH',
        cwe: 'CWE-20',
        confidence: 0.96,
        file: relPath,
        line,
        message,
        evidence: specifier,
      });
    }
  };

  // Single-pass lexical scan for ESM static imports, re-exports, dynamic import(), and CJS require()
  const lexer = createJsTsImportLexer(cleanCode);
  let prevTok = null;

  while (true) {
    const tok = lexer.next();
    if (!tok) break;

    const isPropAccess = prevTok && prevTok.type === 'punct' && (prevTok.value === '.' || prevTok.value === '?.');
    if (tok.type === 'id' && !isPropAccess) {
      if (tok.value === 'import') {
        const next = lexer.peek();
        if (!next) break;
        if (next.type === 'punct' && (next.value === ':' || next.value === '.' || next.value === ';')) {
          prevTok = tok;
          continue;
        }

        // Side-effect import: import './x.mjs'
        if (next.type === 'str') {
          const strTok = lexer.next();
          const specifier = strTok.value;
          const line = offsetToLine(tok.start);
          if (specifier) {
            checkBackslashSpecifier(specifier, line, 'Backslash used in module import specifier (breaks on Linux/macOS/ESM)');
            imports.push({
              specifier,
              line,
              kind: 'esm',
              namedImports: [],
              hasDefaultImport: false,
              hasNamespaceImport: false,
              isTypeOnly: false,
            });
          }
          prevTok = strTok;
          continue;
        }

        // Dynamic import: import('./x.mjs') or import('./x.mjs', { with: ... })
        if (next.type === 'punct' && next.value === '(') {
          lexer.next();
          const arg = lexer.peek();
          if (arg && arg.type === 'str') {
            const strTok = lexer.next();
            const after = lexer.peek();
            if (after && after.type === 'punct' && (after.value === ')' || after.value === ',')) {
              const specifier = strTok.value;
              const line = offsetToLine(tok.start);
              if (specifier) {
                checkBackslashSpecifier(specifier, line, 'Backslash used in require/import specifier');
                const lineTxt = lines[line - 1] || '';
                const isLazyDynamic = !/^\s*(?:await\s+)?import\s*\(/.test(lineTxt);
                imports.push({
                  specifier,
                  line,
                  kind: 'dynamic',
                  namedImports: [],
                  hasDefaultImport: false,
                  hasNamespaceImport: true,
                  isTypeOnly: isLazyDynamic,
                });
              }
            }
            prevTok = strTok;
            continue;
          }
          prevTok = next;
          continue;
        }

        // Static import: import [type] <clause> from './x.mjs'
        if (next.type === 'id' || (next.type === 'punct' && (next.value === '*' || next.value === '{'))) {
          const firstClause = lexer.next();
          const clauseStart = firstClause.start;
          let braceDepth = firstClause.type === 'punct' && firstClause.value === '{' ? 1 : 0;
          let fromTok = null;
          let specTok = null;

          while (true) {
            const cur = lexer.next();
            if (!cur) break;
            if (cur.type === 'punct' && cur.value === '{') {
              braceDepth += 1;
              continue;
            }
            if (cur.type === 'punct' && cur.value === '}') {
              if (braceDepth > 0) braceDepth -= 1;
              else break;
              continue;
            }
            if (braceDepth === 0) {
              if (cur.type === 'id' && cur.value === 'from' && lexer.peek()?.type === 'str') {
                fromTok = cur;
                specTok = lexer.next();
                break;
              }
              if (cur.type === 'punct' && (cur.value === ';' || cur.value === '=' || cur.value === '(' || cur.value === ')' || cur.value === ':')) {
                lexer.pushBack(cur);
                break;
              }
              if (cur.type === 'id' && JS_NON_IMPORT_CLAUSE_KEYWORDS.has(cur.value)) {
                lexer.pushBack(cur);
                break;
              }
            }
          }

          if (fromTok && specTok && specTok.value) {
            const line = offsetToLine(tok.start);
            const specifier = specTok.value;
            checkBackslashSpecifier(specifier, line, 'Backslash used in module import specifier (breaks on Linux/macOS/ESM)');

            let clause = cleanCode.slice(clauseStart, fromTok.start).trim();
            let isTypeOnly = false;
            if (/^type\s+(?:[A-Za-z_$*{])/.test(clause)) {
              isTypeOnly = true;
              clause = clause.replace(/^type\s+/, '').trim();
            }

            let hasDefaultImport = false;
            let hasNamespaceImport = false;
            let namedImports = [];
            if (clause) {
              if (/^\*\s+as\s+/.test(clause)) {
                hasNamespaceImport = true;
              } else {
                const braceMatch = clause.match(/\{([\s\S]*?)\}/);
                if (braceMatch) {
                  namedImports = parseNamedSpecifiers(braceMatch[1]);
                }
                const beforeBrace = clause.split('{')[0].replace(/,\s*$/, '').trim();
                if (beforeBrace && !beforeBrace.startsWith('*')) {
                  hasDefaultImport = true;
                }
              }
            }

            imports.push({
              specifier,
              line,
              kind: 'esm',
              namedImports,
              hasDefaultImport,
              hasNamespaceImport,
              isTypeOnly,
            });
            prevTok = specTok;
          } else {
            prevTok = null;
          }
          continue;
        }
      } else if (tok.value === 'export') {
        const next = lexer.peek();
        if (!next) break;
        if (next.type === 'punct' && (next.value === ':' || next.value === '.' || next.value === ';')) {
          prevTok = tok;
          continue;
        }

        let isTypeOnly = false;
        let head = next;
        if (next.type === 'id' && next.value === 'type') {
          lexer.next();
          const afterType = lexer.peek();
          if (afterType && afterType.type === 'punct' && (afterType.value === '*' || afterType.value === '{')) {
            isTypeOnly = true;
            head = afterType;
          } else {
            prevTok = next;
            continue;
          }
        }

        if (head && head.type === 'punct' && head.value === '*') {
          lexer.next();
          let nsAlias = '';
          if (lexer.peek()?.type === 'id' && lexer.peek().value === 'as') {
            lexer.next();
            if (lexer.peek()?.type === 'id') {
              nsAlias = lexer.next().value;
            }
          }
          if (lexer.peek()?.type === 'id' && lexer.peek().value === 'from') {
            lexer.next();
            if (lexer.peek()?.type === 'str') {
              const specTok = lexer.next();
              const specifier = specTok.value;
              const line = offsetToLine(tok.start);
              if (specifier) {
                checkBackslashSpecifier(specifier, line, 'Backslash used in module import specifier (breaks on Linux/macOS/ESM)');
                if (nsAlias) {
                  namedExports.push(nsAlias);
                } else {
                  hasStarReExport = true;
                  reExportSpecifiers.push(specifier);
                }
                imports.push({
                  specifier,
                  line,
                  kind: 'esm_reexport',
                  namedImports: [],
                  hasDefaultImport: false,
                  hasNamespaceImport: true,
                  isTypeOnly,
                });
              }
              prevTok = specTok;
              continue;
            }
          }
          prevTok = head;
          continue;
        }

        if (head && head.type === 'punct' && head.value === '{') {
          const openBrace = lexer.next();
          let braceDepth = 1;
          let closeBrace = null;
          while (braceDepth > 0) {
            const cur = lexer.next();
            if (!cur) break;
            if (cur.type === 'punct' && cur.value === '{') braceDepth += 1;
            else if (cur.type === 'punct' && cur.value === '}') {
              braceDepth -= 1;
              if (braceDepth === 0) closeBrace = cur;
            }
          }
          if (closeBrace && lexer.peek()?.type === 'id' && lexer.peek().value === 'from') {
            lexer.next();
            if (lexer.peek()?.type === 'str') {
              const specTok = lexer.next();
              const specifier = specTok.value;
              const line = offsetToLine(tok.start);
              if (specifier) {
                checkBackslashSpecifier(specifier, line, 'Backslash used in module import specifier (breaks on Linux/macOS/ESM)');
                const inner = cleanCode.slice(openBrace.start + 1, closeBrace.start);
                const namedImports = parseNamedSpecifiers(inner);
                for (const ni of namedImports) namedExports.push(ni.local);
                imports.push({
                  specifier,
                  line,
                  kind: 'esm_reexport',
                  namedImports,
                  hasDefaultImport: false,
                  hasNamespaceImport: false,
                  isTypeOnly,
                });
              }
              prevTok = specTok;
              continue;
            }
          }
          prevTok = closeBrace || openBrace;
          continue;
        }
      } else if (tok.value === 'require') {
        const next = lexer.peek();
        if (next && next.type === 'punct' && next.value === '(') {
          lexer.next();
          const arg = lexer.peek();
          if (arg && arg.type === 'str') {
            const strTok = lexer.next();
            const after = lexer.peek();
            if (after && after.type === 'punct' && after.value === ')') {
              const specifier = strTok.value;
              const line = offsetToLine(tok.start);
              if (specifier) {
                checkBackslashSpecifier(specifier, line, 'Backslash used in require/import specifier');
                imports.push({
                  specifier,
                  line,
                  kind: 'cjs',
                  namedImports: [],
                  hasDefaultImport: false,
                  hasNamespaceImport: true,
                  isTypeOnly: false,
                });
              }
            }
            prevTok = strTok;
            continue;
          }
          prevTok = next;
          continue;
        }
      }
    }

    prevTok = tok;
  }

  // Exports
  let m;
  const declExpRe = /^\s*export\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|type|interface|namespace|enum|module)\s+([A-Za-z0-9_$]+)/gm;
  while ((m = declExpRe.exec(cleanCode)) !== null) {
    namedExports.push(m[1]);
  }
  const destrExpRe = /^\s*export\s+(?:const|let|var)\s*\{([^}]+)\}/gm;
  while ((m = destrExpRe.exec(cleanCode)) !== null) {
    for (const part of m[1].split(',')) {
      const id = part.trim().split(/[:=]/)[0].trim();
      if (/^[A-Za-z0-9_$]+$/.test(id)) namedExports.push(id);
    }
  }
  const blockExpRe = /^\s*export\s+(?:type\s+)?\{([^}]+)\}(?!\s*from\b)/gm;
  while ((m = blockExpRe.exec(cleanCode)) !== null) {
    for (const ni of parseNamedSpecifiers(m[1])) {
      if (ni.local === 'default') hasDefaultExport = true;
      else namedExports.push(ni.local);
    }
  }
  if (/^\s*export\s+default\b/m.test(cleanCode)) {
    hasDefaultExport = true;
    const defNamed = cleanCode.match(/^\s*export\s+default\s+(?:async\s+)?(?:function\*?|class)\s+([A-Za-z0-9_$]+)/m);
    if (defNamed) namedExports.push(defNamed[1]);
  }
  const cjsPropRe = /^(?:module\.)?exports\.([A-Za-z0-9_$]+)\s*=/gm;
  while ((m = cjsPropRe.exec(cleanCode)) !== null) namedExports.push(m[1]);

  const cjsObjMatch = cleanCode.match(/^\s*module\.exports\s*=\s*\{([\s\S]*?)\}/m);
  if (cjsObjMatch) {
    hasDefaultExport = true;
    for (const part of cjsObjMatch[1].split(',')) {
      const k = part.trim().split(/[:=]/)[0].trim();
      if (/^[A-Za-z0-9_$]+$/.test(k)) namedExports.push(k);
    }
  } else if (/^\s*module\.exports\s*=/m.test(cleanCode)) {
    hasDefaultExport = true;
    isDynamicCjsExports = true;
  }

  return {
    imports,
    exports: {
      namedExports: Array.from(new Set(namedExports)),
      hasDefaultExport,
      hasStarReExport,
      reExportSpecifiers,
      isDynamicCjsExports,
    },
    asyncFunctions: Array.from(new Set(asyncFunctions)),
    cyclomatic,
    maxNesting,
  };
}

function extractPythonMeta(cleanCode) {
  const imports = [];
  const namedExports = [];
  const asyncFunctions = [];
  let cyclomatic = 1;
  const lines = cleanCode.split(/\r?\n/);
  let inTripleQuote = '';

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    // Skip lines inside multi-line Python triple-quoted docstrings/strings so code examples never trigger BROKEN_RELATIVE_IMPORT
    if (inTripleQuote) {
      const closeIdx = rawLine.indexOf(inTripleQuote);
      if (closeIdx !== -1) {
        inTripleQuote = '';
      }
      continue;
    }
    const tqMatch = rawLine.match(/("""|''')/);
    if (tqMatch) {
      const marker = tqMatch[1];
      const firstIdx = rawLine.indexOf(marker);
      const secondIdx = rawLine.indexOf(marker, firstIdx + 3);
      if (secondIdx === -1) {
        inTripleQuote = marker;
        continue;
      }
    }

    const branchHits = trimmed.match(/\b(?:if|elif|for|while|except|and|or)\b/g);
    if (branchHits) cyclomatic += branchHits.length;

    const fromMatch = trimmed.match(/^from\s+(\.+[A-Za-z0-9_.]*|[A-Za-z0-9_.]+)\s+import\s+(.+)/);
    if (fromMatch) {
      const mod = fromMatch[1];
      const names = fromMatch[2].split(',').map((s) => s.trim().split(/\s+as\s+/)[0].trim()).filter((n) => /^[A-Za-z0-9_]+$/.test(n));
      imports.push({
        specifier: mod,
        line: i + 1,
        kind: 'py',
        namedImports: names.map((n) => ({ imported: n, local: n })),
        hasDefaultImport: false,
        hasNamespaceImport: fromMatch[2].trim() === '*',
        isTypeOnly: false,
      });
      continue;
    }
    const impMatch = trimmed.match(/^import\s+([A-Za-z0-9_.,\s]+)/);
    if (impMatch) {
      for (const part of impMatch[1].split(',')) {
        const mod = part.trim().split(/\s+as\s+/)[0].trim();
        if (mod) {
          imports.push({ specifier: mod, line: i + 1, kind: 'py', namedImports: [], hasDefaultImport: true, hasNamespaceImport: true, isTypeOnly: false });
        }
      }
      continue;
    }
    const defMatch = trimmed.match(/^(async\s+)?def\s+([A-Za-z0-9_]+)\s*\(/);
    if (defMatch) {
      namedExports.push(defMatch[2]);
      if (defMatch[1]) asyncFunctions.push(defMatch[2]);
      continue;
    }
    const clsMatch = trimmed.match(/^class\s+([A-Za-z0-9_]+)/);
    if (clsMatch) namedExports.push(clsMatch[1]);
  }
  return {
    imports,
    exports: { namedExports, hasDefaultExport: false, hasStarReExport: false, reExportSpecifiers: [], isDynamicCjsExports: false },
    asyncFunctions,
    cyclomatic,
    maxNesting: 0,
  };
}

function scanSecretsAndEnv(item, cleanCode, findings) {
  const { relPath, isTestFile, text } = item;
  const envVars = [];

  // Extract env variable usages everywhere
  const envPatterns = [
    /process\.env\.([A-Z][A-Z0-9_]{1,60})\b/g,
    /process\.env\[['"]([A-Z][A-Z0-9_]{1,60})['"]\]/g,
    /import\.meta\.env\.([A-Z][A-Z0-9_]{1,60})\b/g,
    /os\.(?:getenv|environ\.get)\(\s*['"]([A-Z][A-Z0-9_]{1,60})['"]/g,
    /os\.environ\[['"]([A-Z][A-Z0-9_]{1,60})['"]\]/g,
    /os\.Getenv\(\s*["']([A-Z][A-Z0-9_]{1,60})["']\s*\)/g,
  ];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    for (const re of envPatterns) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(l)) !== null) {
        envVars.push({ name: m[1], line: i + 1 });
      }
    }
  }

  if (isTestFile || item.kind === 'env') {
    return envVars;
  }

  const codeLines = cleanCode.split(/\r?\n/);
  for (let i = 0; i < codeLines.length; i++) {
    const line = codeLines[i];
    if (!line.trim()) continue;

    for (const tp of TOKEN_PATTERNS) {
      tp.re.lastIndex = 0;
      const m = tp.re.exec(line);
      if (m && !PLACEHOLDER_SECRET_RE.test(m[0])) {
        findings.push({
          tier: 'T3',
          ruleId: 'HARDCODED_SECRET',
          severity: 'CRITICAL',
          cwe: tp.cwe,
          confidence: 0.96,
          file: relPath,
          line: i + 1,
          message: `Hardcoded credential/key detected (${tp.id})`,
          evidence: `${m[0].slice(0, 10)}...[redacted]`,
        });
      }
    }

    SENSITIVE_ASSIGN_RE.lastIndex = 0;
    let am;
    const isSampleOrDocPath = /(?:^|\/)(?:docs_src|examples?|tutorials?|fixtures?|__tests__)\//i.test(String(relPath || '').replace(/\\/g, '/'));
    while ((am = SENSITIVE_ASSIGN_RE.exec(line)) !== null) {
      const val = am[3];
      if (!val || PLACEHOLDER_SECRET_RE.test(val) || /^https?:\/\//i.test(val) || val.includes('/') || val.includes(' ')) continue;
      if (shannonEntropy(val) >= 3.85) {
        findings.push({
          tier: 'T3',
          ruleId: 'HIGH_ENTROPY_SECRET',
          severity: isSampleOrDocPath ? 'INFO' : 'HIGH',
          cwe: 'CWE-798',
          confidence: isSampleOrDocPath ? 0.55 : 0.85,
          file: relPath,
          line: i + 1,
          message: `High-entropy secret literal assigned to '${am[1]}'`,
          evidence: `${am[1]}="${val.slice(0, 4)}..." (H=${shannonEntropy(val).toFixed(2)})`,
        });
      }
    }
  }
  return envVars;
}

function buildAdversarialProbe(pattern) {
  if (pattern.includes('\\s')) return 'a' + ' '.repeat(34) + '\x00!';
  if (pattern.includes('\\d') || pattern.includes('0-9')) return '0'.repeat(34) + 'X!';
  if (pattern.includes('\\w') || pattern.includes('a-z') || pattern.includes('A-Z')) return 'a'.repeat(34) + '\x00!';
  return 'aaaa'.repeat(9) + '!@#\x00';
}

function scanRedos(item, cleanCode, fuzzEnabled, findings) {
  if (item.isTestFile || !JS_TS_EXTS.has(item.ext)) return;
  const lines = cleanCode.split(/\r?\n/);

  let redosCtx = null;
  let compileScript = null;
  let testScript = null;
  const prepareCompiledRegex = (pat, flg) => {
    if (!redosCtx) {
      redosCtx = vm.createContext({ pat: '', flg: '', inp: '', re: null, out: false });
      compileScript = new vm.Script('re = new RegExp(pat, flg); re.test("a!"); re.lastIndex = 0;');
      testScript = new vm.Script('if (re.global || re.sticky) re.lastIndex = 0; out = re.test(inp);');
    }
    redosCtx.pat = pat;
    redosCtx.flg = flg;
    try {
      compileScript.runInContext(redosCtx, { timeout: 90 });
    } catch (err) {
      redosCtx = null;
      throw err;
    }
  };
  const hasThreadCpu = typeof process.threadCpuUsage === 'function';
  const runTimedTestOnce = (inp) => {
    redosCtx.inp = inp;
    // Measure per-thread CPU time when available so OS preemption under parallel CPU load cannot trigger ReDoS false positives.
    const cpu0 = hasThreadCpu ? process.threadCpuUsage() : null;
    const t0 = performance.now();
    try {
      testScript.runInContext(redosCtx, { timeout: 90 });
    } catch (err) {
      redosCtx = null;
      throw err;
    }
    const wallMs = performance.now() - t0;
    if (cpu0) {
      const cpuDiff = process.threadCpuUsage(cpu0);
      return Math.min(wallMs, (cpuDiff.user + cpuDiff.system) / 1000);
    }
    return wallMs;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes('/') && !line.includes('RegExp')) continue;

    // Match regex literals or new RegExp('...') on this line
    const candidates = [];
    const litRe = /(?:^|[=(,:!&|?+~^;{}\[\s])\/((?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\[\r\n])+)\/([dgimsuvy]*)/g;
    let m;
    while ((m = litRe.exec(line)) !== null) {
      if (m[1] && !m[1].startsWith('*')) {
        candidates.push({ pattern: m[1], flags: m[2] || '' });
      }
    }
    const ctorRe = /new\s+RegExp\s*\(\s*(['"])((?:\\.|(?!\1).)+)\1(?:\s*,\s*(['"])([dgimsuvy]*)\3)?/g;
    while ((m = ctorRe.exec(line)) !== null) {
      candidates.push({ pattern: m[2], flags: m[4] || '' });
    }

    for (const cand of candidates) {
      const suspicious = isSuspiciousRedosPattern(cand.pattern);
      if (!suspicious && !fuzzEnabled) continue;
      if (cand.pattern.length < 6) continue;
      if (!suspicious && !/[+*].*[+*]/.test(cand.pattern)) continue;

      const safeFlags = cand.flags.replace(/[^gimsuy]/g, '');
      const probe = buildAdversarialProbe(cand.pattern);
      try {
        prepareCompiledRegex(cand.pattern, safeFlags);
        let minDt = runTimedTestOnce(probe);
        if (minDt > 40) {
          // 3-pass Math.min filter eliminates OS preemption spikes across parallel suites
          for (let pass = 0; pass < 2; pass++) {
            const nextDt = runTimedTestOnce(probe);
            if (nextDt < minDt) minDt = nextDt;
            if (minDt <= 40) break;
          }
        }
        if (minDt > 40) {
          findings.push({
            tier: 'T3',
            ruleId: 'REDOS_VULNERABILITY',
            severity: minDt > 80 ? 'CRITICAL' : 'HIGH',
            cwe: 'CWE-1333',
            confidence: 0.96,
            file: item.relPath,
            line: i + 1,
            message: `Catastrophic backtracking (ReDoS) measured ${minDt.toFixed(1)}ms on adversarial input`,
            evidence: `/${cand.pattern.slice(0, 60)}/${safeFlags}`,
          });
        } else if (suspicious) {
          findings.push({
            tier: 'T3',
            ruleId: 'REDOS_PATTERN_RISK',
            severity: 'MEDIUM',
            cwe: 'CWE-1333',
            confidence: 0.72,
            file: item.relPath,
            line: i + 1,
            message: 'Nested/overlapping quantifier in regex may backtrack on crafted inputs',
            evidence: `/${cand.pattern.slice(0, 60)}/${safeFlags}`,
          });
        }
      } catch (err) {
        const msg = String(err?.message || err);
        if (/timed out/i.test(msg)) {
          let timeouts = 1;
          let minDt = Infinity;
          for (let pass = 0; pass < 2; pass++) {
            try {
              prepareCompiledRegex(cand.pattern, safeFlags);
              const confirmDt = runTimedTestOnce(probe);
              if (confirmDt < minDt) minDt = confirmDt;
              if (minDt <= 40) break;
            } catch (confirmErr) {
              if (/timed out/i.test(String(confirmErr?.message || confirmErr))) {
                timeouts++;
              }
            }
          }
          if (timeouts >= 2 && minDt === Infinity) {
            findings.push({
              tier: 'T3',
              ruleId: 'REDOS_TIMEOUT',
              severity: 'CRITICAL',
              cwe: 'CWE-1333',
              confidence: 0.99,
              file: item.relPath,
              line: i + 1,
              message: 'Regex evaluation timed out (>90ms) — confirmed ReDoS vulnerability',
              evidence: `/${cand.pattern.slice(0, 60)}/${safeFlags}`,
            });
          } else if (minDt !== Infinity && minDt > 40) {
            findings.push({
              tier: 'T3',
              ruleId: 'REDOS_VULNERABILITY',
              severity: minDt > 80 ? 'CRITICAL' : 'HIGH',
              cwe: 'CWE-1333',
              confidence: 0.96,
              file: item.relPath,
              line: i + 1,
              message: `Catastrophic backtracking (ReDoS) measured ${minDt.toFixed(1)}ms on adversarial input`,
              evidence: `/${cand.pattern.slice(0, 60)}/${safeFlags}`,
            });
          } else if (suspicious) {
            findings.push({
              tier: 'T3',
              ruleId: 'REDOS_PATTERN_RISK',
              severity: 'MEDIUM',
              cwe: 'CWE-1333',
              confidence: 0.72,
              file: item.relPath,
              line: i + 1,
              message: 'Nested/overlapping quantifier in regex may backtrack on crafted inputs',
              evidence: `/${cand.pattern.slice(0, 60)}/${safeFlags}`,
            });
          }
        }
      }
    }
  }
}

const TAINT_SOURCE_RE = /\b(?:req\.(?:query|body|params|headers)|request\.(?:args|form|json|values|data)|r\.URL\.Query|r\.FormValue|c\.(?:Query|Param)|(?:location|window\.location)\.(?:search|hash)|searchParams\.get)\b/;
const SANITIZER_RE = /\b(?:parseInt|Number|Boolean|encodeURIComponent|escapeHtml|DOMPurify\.sanitize|sanitize|path\.basename|basename|filepath\.Base|shlex\.quote|html\.escape)\b/;
const SQL_VERB_RE = /\b(?:SELECT|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|DROP\s+TABLE)\b/i;

function scanTaintAndSecurity(item, cleanCode, findings) {
  if (item.isTestFile) return;
  const lines = cleanCode.split(/\r?\n/);
  const taintedVars = new Set();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) continue;

    // 1. Track taint sources & propagation
    if (TAINT_SOURCE_RE.test(trimmed)) {
      const destr = trimmed.match(/^(?:const|let|var)\s*\{([^}]+)\}\s*=/);
      if (destr) {
        for (const p of destr[1].split(',')) {
          const v = p.trim().split(/[:=]/).pop().trim();
          if (/^[A-Za-z0-9_$]+$/.test(v)) taintedVars.add(v);
        }
      }
      const assign = trimmed.match(/^(?:const|let|var\s+)?([A-Za-z0-9_]+)\s*(?::?=)\s*(.+)/);
      if (assign && !SANITIZER_RE.test(assign[2])) {
        taintedVars.add(assign[1]);
      }
    } else {
      const assign = trimmed.match(/^(?:const|let|var\s+)?([A-Za-z0-9_]+)\s*(?::?=)\s*(.+)/);
      if (assign) {
        const rhs = assign[2];
        if (SANITIZER_RE.test(rhs)) {
          taintedVars.delete(assign[1]);
        } else {
          for (const tv of taintedVars) {
            if (new RegExp(`\\b${tv}\\b`).test(rhs)) {
              taintedVars.add(assign[1]);
              break;
            }
          }
        }
      }
    }

    const lineHasTaint =
      TAINT_SOURCE_RE.test(trimmed) ||
      Array.from(taintedVars).some((tv) => new RegExp(`\\b${tv}\\b`).test(trimmed));

    // 2. CWE-89 SQL Injection (concatenation/template/f-string inside SQL query call)
    if (
      SQL_VERB_RE.test(trimmed) &&
      (/\.(?:query|execute|exec|raw)\s*\(/.test(trimmed) || /\b(?:cursor\.execute|db\.Query|db\.Exec)\s*\(/.test(trimmed)) &&
      (/\$\{[^}]+\}/.test(trimmed) || /['"`]\s*\+\s*[A-Za-z_]/.test(trimmed) || /\bf["'](?:SELECT|INSERT|UPDATE|DELETE)/i.test(trimmed) || /%\s*[A-Za-z_(]/.test(trimmed))
    ) {
      findings.push({
        tier: 'T3',
        ruleId: 'SQL_INJECTION',
        severity: 'CRITICAL',
        cwe: 'CWE-89',
        confidence: lineHasTaint ? 0.95 : 0.88,
        file: item.relPath,
        line: i + 1,
        message: 'Dynamic SQL query interpolation/concatenation (SQL Injection risk)',
        evidence: trimmed.slice(0, 120),
      });
    }

    // 3. CWE-78 Command Injection (exclude RegExp.prototype.exec / DB cursor .exec methods)
    const hasChildExecCall =
      /(?<!\.)\bexec(?:Sync)?\s*\(/.test(trimmed) ||
      /\b(?:child_process|cp|proc|shelljs|shell)\s*\.\s*exec(?:Sync)?\s*\(/.test(trimmed);
    const isJsShellSink = hasChildExecCall || (/\bspawn(?:Sync)?\s*\(/.test(trimmed) && /\bshell\s*:\s*true\b/.test(trimmed));
    const isPyShellSink = /\b(?:os\.system|os\.popen)\s*\(/.test(trimmed) || (/\bsubprocess\.\w+\s*\(/.test(trimmed) && /\bshell\s*=\s*True\b/.test(trimmed));
    const isGoShellSink = /\bexec\.Command\s*\(\s*["'](?:sh|bash|cmd(?:\.exe)?)["']/.test(trimmed);
    const hasCmdDynamicInterp = /\$\{[^}]+\}|['"`]\s*\+\s*[A-Za-z_]|\bf["']/.test(trimmed) || lineHasTaint;

    if (
      (isJsShellSink || isPyShellSink || isGoShellSink) &&
      (lineHasTaint ||
        (isPyShellSink && hasCmdDynamicInterp) ||
        (hasChildExecCall && /\bexec(?:Sync)?\s*\([^)]*(?:\$\{|\+)/.test(trimmed)))
    ) {
      if (lineHasTaint || isPyShellSink || !/\bexecFile(?:Sync)?\b/.test(trimmed)) {
        findings.push({
          tier: 'T3',
          ruleId: 'COMMAND_INJECTION',
          severity: lineHasTaint ? 'CRITICAL' : 'HIGH',
          cwe: 'CWE-78',
          confidence: lineHasTaint ? 0.94 : 0.81,
          file: item.relPath,
          line: i + 1,
          message: 'Untrusted or dynamically interpolated shell command execution',
          evidence: trimmed.slice(0, 120),
        });
      }
    }

    // 4. CWE-22 Path Traversal (only when tainted by request/external source & unsanitized)
    if (
      lineHasTaint &&
      !SANITIZER_RE.test(trimmed) &&
      /\b(?:readFile|readFileSync|writeFile|writeFileSync|createReadStream|sendFile|os\.Open|ioutil\.ReadFile|open)\s*\(/.test(trimmed) &&
      !/startsWith\s*\(/.test(lines.slice(Math.max(0, i - 5), i + 1).join('\n'))
    ) {
      findings.push({
        tier: 'T3',
        ruleId: 'PATH_TRAVERSAL',
        severity: 'HIGH',
        cwe: 'CWE-22',
        confidence: 0.87,
        file: item.relPath,
        line: i + 1,
        message: 'Tainted user input flows into filesystem path without containment/basename check',
        evidence: trimmed.slice(0, 120),
      });
    }

    // 5. CWE-918 SSRF
    if (
      lineHasTaint &&
      /\b(?:fetch|axios\.(?:get|post|put|request)|https?\.get|requests\.(?:get|post)|urllib\.request\.urlopen|http\.Get)\s*\(/.test(trimmed)
    ) {
      findings.push({
        tier: 'T3',
        ruleId: 'SSRF_RISK',
        severity: 'HIGH',
        cwe: 'CWE-918',
        confidence: 0.86,
        file: item.relPath,
        line: i + 1,
        message: 'Tainted user input used directly as outbound network request URL',
        evidence: trimmed.slice(0, 120),
      });
    }

    // 6. CWE-79 XSS
    if (/\.innerHTML\s*[+]?=|\.outerHTML\s*=|\bdocument\.write\s*\(|dangerouslySetInnerHTML/.test(trimmed)) {
      const rhsPart = trimmed.split('=').slice(1).join('=');
      if (lineHasTaint) {
        findings.push({
          tier: 'T3',
          ruleId: 'DOM_XSS',
          severity: 'HIGH',
          cwe: 'CWE-79',
          confidence: 0.9,
          file: relPathOr(item),
          line: i + 1,
          message: 'Tainted input written directly to HTML sink (XSS risk)',
          evidence: trimmed.slice(0, 120),
        });
      } else if (rhsPart && /(?:\$\{|\+)/.test(rhsPart) && !/(?:escapeHtml|escHtml|sanitize|DOMPurify|escape\s*\()/i.test(rhsPart)) {
        // Ignore pure static HTML + static L('ru', 'en') string literal concatenations.
        const dynCheck = rhsPart
          .replace(/\bL\s*\(\s*(?:'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")\s*,\s*(?:'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")\s*\)/g, '')
          .replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, '');
        if (/[A-Za-z0-9_$]|\$\{/.test(dynCheck)) {
          findings.push({
            tier: 'T3',
            ruleId: 'UNESCAPED_INNER_HTML',
            severity: 'MEDIUM',
            cwe: 'CWE-79',
            confidence: 0.72,
            file: item.relPath,
            line: i + 1,
            message: 'Dynamic HTML assigned to innerHTML/DOM sink without visible escaping',
            evidence: trimmed.slice(0, 120),
          });
        }
      }
    }

    // 7. CWE-502 / CWE-95 Unsafe Deserialization & Eval (skip literal/documentation strings via stripped check)
    const lineNoStrings = stripStringsAndRegexesPreservingLines(trimmed, item.language);
    if (/\bpickle\.loads?\s*\(/.test(lineNoStrings) || (/\byaml\.load\s*\(/.test(lineNoStrings) && !/Loader\s*=|SafeLoader/.test(trimmed))) {
      findings.push({
        tier: 'T3',
        ruleId: 'UNSAFE_DESERIALIZATION',
        severity: 'HIGH',
        cwe: 'CWE-502',
        confidence: 0.92,
        file: item.relPath,
        line: i + 1,
        message: 'Unsafe deserialization (pickle.load or yaml.load without SafeLoader)',
        evidence: trimmed.slice(0, 120),
      });
    }

    if (/\beval\s*\((?!['"`][^'"`]*['"`]\s*\))/.test(lineNoStrings) || /\bnew\s+Function\s*\((?!['"`][^'"`]*['"`]\s*\))/.test(lineNoStrings)) {
      if (lineHasTaint || JS_TS_EXTS.has(item.ext)) {
        findings.push({
          tier: 'T3',
          ruleId: 'DYNAMIC_CODE_EVAL',
          severity: lineHasTaint ? 'CRITICAL' : 'HIGH',
          cwe: 'CWE-95',
          confidence: lineHasTaint ? 0.94 : 0.82,
          file: item.relPath,
          line: i + 1,
          message: 'Dynamic eval() / new Function() execution on non-literal expression',
          evidence: trimmed.slice(0, 120),
        });
      }
    }

    // 8. CWE-1321 Static Prototype Pollution assignment guard check (JS/TS only; exclude ==/===, =>, and numeric [0][0])
    const ppMatch = JS_TS_EXTS.has(item.ext)
      ? /\[([A-Za-z0-9_$]+)\]\s*\[([A-Za-z0-9_$]+)\]\s*(?<![!=<>])=(?![=>])/.exec(trimmed)
      : null;
    if (
      ppMatch &&
      (!/^\d+$/.test(ppMatch[1]) || !/^\d+$/.test(ppMatch[2])) &&
      !/__proto__|prototype|constructor|Object\.create\(null\)/.test(lines.slice(Math.max(0, i - 6), i + 2).join('\n'))
    ) {
      findings.push({
        tier: 'T3',
        ruleId: 'PROTOTYPE_POLLUTION_RISK',
        severity: 'HIGH',
        cwe: 'CWE-1321',
        confidence: 0.78,
        file: item.relPath,
        line: i + 1,
        message: 'Dynamic two-level property write obj[k1][k2] = val without __proto__/constructor guard',
        evidence: trimmed.slice(0, 120),
      });
    }
  }
}

function relPathOr(item) {
  return item.relPath;
}

function scanConcurrencyAndLeaks(item, cleanCode, localAsyncFns, findings) {
  if (item.isTestFile) return { bareCalls: [] };
  const lines = cleanCode.split(/\r?\n/);
  const bareCalls = [];
  const asyncSet = new Set(localAsyncFns);

  const hasClearInterval = /\bclearInterval\s*\(|\.\s*unref\s*\(/.test(cleanCode);
  const hasCloseSync = /\bcloseSync\s*\(/.test(cleanCode);

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;

    // 1. .forEach(async ...) and new Promise(async ...)
    if (/\.forEach\s*\(\s*async\b/.test(trimmed)) {
      findings.push({
        tier: 'T4',
        ruleId: 'ASYNC_FOREACH',
        severity: 'HIGH',
        cwe: 'CWE-362',
        confidence: 0.92,
        file: item.relPath,
        line: i + 1,
        message: 'Array.prototype.forEach with async callback ignores returned Promises (race/unhandled errors)',
        evidence: trimmed.slice(0, 100),
      });
    }
    if (/\bnew\s+Promise\s*\(\s*async\b/.test(trimmed)) {
      findings.push({
        tier: 'T4',
        ruleId: 'ASYNC_PROMISE_EXECUTOR',
        severity: 'HIGH',
        cwe: 'CWE-755',
        confidence: 0.95,
        file: item.relPath,
        line: i + 1,
        message: 'Async executor passed to new Promise() swallows rejected promises',
        evidence: trimmed.slice(0, 100),
      });
    }

    // 2. Floating promises (local async functions & bare calls for cross-file resolution)
    if (JS_TS_EXTS.has(item.ext)) {
      const bareStmt = trimmed.match(/^([A-Za-z_$][A-Za-z0-9_$]*)\s*\([^)]*\)\s*;?$/);
      if (bareStmt) {
        const nextTrim = (lines[i + 1] || '').trim();
        const isChainedNextLine = /^\.(?:then|catch|finally)\b/.test(nextTrim);
        const isEntryMainCall = /\b(?:start|run|main|bootstrap|init)[A-Z_]/.test(bareStmt[1]) &&
          /\b(?:isMain|isMainEntry|process\.argv\[1\])/.test(lines.slice(Math.max(0, i - 3), i + 1).join('\n'));
        if (!isChainedNextLine && !isEntryMainCall) {
          const callee = bareStmt[1];
          if (asyncSet.has(callee)) {
            findings.push({
              tier: 'T4',
              ruleId: 'FLOATING_PROMISE',
              severity: 'HIGH',
              cwe: 'CWE-252',
              confidence: 0.9,
              file: item.relPath,
              line: i + 1,
              message: `Async function '${callee}()' called without await, return, or .catch()`,
              evidence: trimmed.slice(0, 100),
            });
          } else if (!['console', 'setTimeout', 'clearTimeout', 'clearInterval', 'assert', 'describe', 'it', 'test', 'push', 'pop', 'return'].includes(callee)) {
            bareCalls.push({ callee, line: i + 1, snippet: trimmed.slice(0, 90) });
          }
        }
      }
    }

    // 3. TOCTOU check-then-act file race: existsSync(...) followed closely by writeFileSync / unlinkSync without lock or 'wx'
    if (/\bexistsSync\s*\(/.test(trimmed)) {
      const windowCode = lines.slice(i, Math.min(lines.length, i + 4)).join('\n');
      if (/\bwriteFileSync\s*\(/.test(windowCode) && !/flag\s*:\s*['"]wx|withFileLockSync|atomicWrite/i.test(windowCode)) {
        findings.push({
          tier: 'T4',
          ruleId: 'TOCTOU_FILE_RACE',
          severity: 'MEDIUM',
          cwe: 'CWE-367',
          confidence: 0.78,
          file: item.relPath,
          line: i + 1,
          message: 'Check-then-act file write (existsSync -> writeFileSync) without lock or exclusive wx flag',
          evidence: trimmed.slice(0, 100),
        });
      }
    }

    // 4. Resource leaks: openSync without closeSync; Python open() outside `with` without close()
    if (JS_TS_EXTS.has(item.ext) && /\b(?:fs\.)?openSync\s*\(/.test(trimmed) && !hasCloseSync) {
      findings.push({
        tier: 'T4',
        ruleId: 'UNCLOSED_FD',
        severity: 'HIGH',
        cwe: 'CWE-775',
        confidence: 0.84,
        file: item.relPath,
        line: i + 1,
        message: 'openSync() called without matching closeSync() in module',
        evidence: trimmed.slice(0, 100),
      });
    }
    if (item.language === 'python') {
      const pyOpen = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*open\s*\(/);
      if (pyOpen && !new RegExp(`\\b${pyOpen[1]}\\.close\\s*\\(`).test(cleanCode)) {
        findings.push({
          tier: 'T4',
          ruleId: 'UNCLOSED_FILE_HANDLE',
          severity: 'HIGH',
          cwe: 'CWE-775',
          confidence: 0.91,
          file: item.relPath,
          line: i + 1,
          message: `Python file handle '${pyOpen[1]} = open(...)' opened outside 'with' context without .close()`,
          evidence: trimmed.slice(0, 100),
        });
      }
    }
    if (item.language === 'go') {
      if (/(?:os\.Open|http\.Get)\s*\(/.test(trimmed) && !/^\s*return\b/.test(trimmed)) {
        const goWindowLines = [];
        for (let k = i; k < Math.min(lines.length, i + 18); k++) {
          if (k > i && /^func\b/.test(lines[k].trim())) break;
          goWindowLines.push(lines[k]);
        }
        if (!/\bdefer\b[\s\S]{0,450}\.Close\s*\(/.test(goWindowLines.join('\n'))) {
          findings.push({
            tier: 'T4',
            ruleId: 'GO_MISSING_DEFER_CLOSE',
            severity: 'HIGH',
            cwe: 'CWE-775',
            confidence: 0.85,
            file: item.relPath,
            line: i + 1,
            message: 'Go resource opened without defer .Close()',
            evidence: trimmed.slice(0, 100),
          });
        }
      }
    }

    // 5. Unbounded interval timer leak
    if (JS_TS_EXTS.has(item.ext) && /\bsetInterval\s*\(/.test(trimmed) && !hasClearInterval) {
      findings.push({
        tier: 'T4',
        ruleId: 'UNTRACKED_SET_INTERVAL',
        severity: 'MEDIUM',
        cwe: 'CWE-400',
        confidence: 0.75,
        file: item.relPath,
        line: i + 1,
        message: 'setInterval() used without clearInterval() or .unref() (may leak timers or block process exit)',
        evidence: trimmed.slice(0, 100),
      });
    }

    // 6. Infinite retry loop without AbortSignal / break / return / sleep
    if (/^(?:while\s*\(\s*true\s*\)|for\s*\(\s*;\s*;\s*\))/.test(trimmed)) {
      const loopBody = lines.slice(i, Math.min(lines.length, i + 18)).join('\n');
      if (/\b(?:fetch|axios|request|connect|retry)\b/i.test(loopBody) && !/\b(?:break|return|signal|AbortController|setTimeout|sleep|maxRetries|attempt)\b/.test(loopBody)) {
        findings.push({
          tier: 'T4',
          ruleId: 'UNBOUNDED_RETRY_LOOP',
          severity: 'HIGH',
          cwe: 'CWE-835',
          confidence: 0.84,
          file: item.relPath,
          line: i + 1,
          message: 'Unbounded while(true)/for(;;) loop around network/retry operation without exit or backoff guard',
          evidence: trimmed.slice(0, 100),
        });
      }
    }
  }
  return { bareCalls };
}

function extractUiApiSignals(item, cleanCode) {
  const { relPath, ext, text } = item;
  const htmlIds = [];
  const domRefs = [];
  const dynamicDomIds = [];
  const frontendCalls = [];
  const backendRoutes = [];
  const ipcSenders = [];
  const ipcHandlers = [];

  if (ext === '.html' || ext === '.htm' || ext === '.vue' || ext === '.svelte') {
    const idRe = /\bid\s*=\s*["']([A-Za-z0-9_:-]+)["']/g;
    let m;
    while ((m = idRe.exec(text)) !== null) htmlIds.push(m[1]);
  }

  if (item.isTestFile) {
    return { htmlIds, domRefs, dynamicDomIds, frontendCalls, backendRoutes, ipcSenders, ipcHandlers };
  }

  const lines = cleanCode.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const lineNo = i + 1;

    // DOM lookups in JS/TS or inline HTML scripts
    if (JS_TS_EXTS.has(ext) || ext === '.html' || ext === '.htm') {
      const gebiRe = /getElementById\s*\(\s*(['"])([A-Za-z0-9_:-]+)\1\s*\)/g;
      let m;
      while ((m = gebiRe.exec(l)) !== null) domRefs.push({ id: m[2], line: lineNo });

      const qsRe = /querySelector(?:All)?\s*\(\s*(['"])#([A-Za-z0-9_:-]+)\1\s*\)/g;
      while ((m = qsRe.exec(l)) !== null) domRefs.push({ id: m[2], line: lineNo });

      // Dynamic ID creations in JS
      const dynAssign = l.match(/\.id\s*=\s*(['"`])([A-Za-z0-9_:-]+)\1/);
      if (dynAssign) dynamicDomIds.push(dynAssign[2]);
      const dynAttr = l.match(/setAttribute\s*\(\s*['"]id['"]\s*,\s*(['"`])([A-Za-z0-9_:-]+)\1/);
      if (dynAttr) dynamicDomIds.push(dynAttr[2]);
      const dynHtml = l.match(/\bid\s*=\s*\\?["']([A-Za-z0-9_:-]+)\\?["']/g);
      if (dynHtml && JS_TS_EXTS.has(ext)) {
        for (const hit of dynHtml) {
          const val = hit.match(/([A-Za-z0-9_:-]+)["']?$/);
          if (val) dynamicDomIds.push(val[1]);
        }
      }

      // Frontend API fetch / axios / *Fetch('/api/...')
      const fetchRe = /\b(?:fetch|axios\.(?:get|post|put|delete|patch|request)|[A-Za-z0-9_$]*Fetch)\s*\(\s*(['"`])(\/[^'"`?\s${}]+)(?:\?[^'"`]*)?\1/g;
      while ((m = fetchRe.exec(l)) !== null) {
        if (m[2].startsWith('/api/') || /^\/(?:v\d+\/|auth\/|rpc\/)/.test(m[2])) {
          frontendCalls.push({ route: m[2], line: lineNo });
        }
      }

      // IPC renderer invoke/send
      const ipcSendRe = /\bipcRenderer\.(?:invoke|send)\s*\(\s*(['"])([^'"]+)\1/g;
      while ((m = ipcSendRe.exec(l)) !== null) ipcSenders.push({ channel: m[2], line: lineNo });
      const ipcHandleRe = /\bipcMain\.(?:handle|on)\s*\(\s*(['"])([^'"]+)\1/g;
      while ((m = ipcHandleRe.exec(l)) !== null) ipcHandlers.push({ channel: m[2], line: lineNo });

      // Backend routes (Express/Fastify/Hono/Koa & raw Node http)
      const expressRe = /\b(?:app|router|server|fastify|hono)\.(?:get|post|put|delete|patch|all|use)\s*\(\s*(['"])(\/[^'"]*)\1/gi;
      while ((m = expressRe.exec(l)) !== null) backendRoutes.push({ route: m[2], line: lineNo, isPrefix: false });

      const nodeEqRe = /\b(?:pathname|url|req\.url)\s*===\s*(['"])(\/[^'"]*)\1/g;
      while ((m = nodeEqRe.exec(l)) !== null) backendRoutes.push({ route: m[2], line: lineNo, isPrefix: false });

      const nodePrefixRe = /\b(?:pathname|url|req\.url)\.startsWith\s*\(\s*(['"])(\/[^'"]*)\1/g;
      while ((m = nodePrefixRe.exec(l)) !== null) backendRoutes.push({ route: m[2], line: lineNo, isPrefix: true });
    }

    if (item.language === 'python') {
      const pyRouteRe = /@\w+\.(?:get|post|put|delete|patch|route)\s*\(\s*(['"])(\/[^'"]*)\1/g;
      let m;
      while ((m = pyRouteRe.exec(l)) !== null) backendRoutes.push({ route: m[2], line: lineNo, isPrefix: false });
    }

    if (item.language === 'go') {
      const goRouteRe = /\.(?:Get|Post|Put|Delete|Patch|HandleFunc|Handle|GET|POST|PUT|DELETE)\s*\(\s*"(\/[^"]*)"/g;
      let m;
      while ((m = goRouteRe.exec(l)) !== null) backendRoutes.push({ route: m[1], line: lineNo, isPrefix: false });
    }
  }

  return { htmlIds, domRefs, dynamicDomIds, frontendCalls, backendRoutes, ipcSenders, ipcHandlers };
}

function detectSafeSandboxFuzzCandidates(item, cleanCode, exportsMeta) {
  if (item.isTestFile) return { safeToImportInSandbox: false, fuzzCandidates: [] };
  if (item.ext !== '.mjs' && item.ext !== '.js' && item.ext !== '.cjs') {
    return { safeToImportInSandbox: false, fuzzCandidates: [] };
  }
  const hasTopLevelServerOrCli =
    /\b(?:createServer|listen|process\.exit|parentPort\.on|readline\.createInterface|execFileSync|execSync|spawnSync)\b/.test(cleanCode) &&
    !/\bisMain\b|\bfileURLToPath\(import\.meta\.url\)\s*===\s*resolve\(process\.argv\[1\]\)/.test(cleanCode);
  if (hasTopLevelServerOrCli) {
    return { safeToImportInSandbox: false, fuzzCandidates: [] };
  }

  const lines = cleanCode.split(/\r?\n/);
  const fuzzCandidates = [];
  for (const name of exportsMeta.namedExports) {
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) continue;
    const fnRe = new RegExp(`(?:export\\s+(?:async\\s+)?function\\s+${name}|(?:const|let|var)\\s+${name}\\s*=\\s*(?:async\\s*)?)\\(([^)]*)\\)`);
    const match = cleanCode.match(fnRe);
    if (!match) continue;
    const params = match[1].trim();
    if (!params) continue; // zero-arg getter, skip
    const lineIdx = lines.findIndex((l) => l.includes(`function ${name}`) || l.includes(`const ${name} =`));
    const bodySlice = lineIdx >= 0 ? lines.slice(lineIdx, lineIdx + 45).join('\n') : '';
    if (/\b(?:spawn|execFile|execSync|rmSync|rmdirSync|unlinkSync|http\.createServer|new\s+Worker|Atomics\.wait)\b/.test(bodySlice)) continue;
    fuzzCandidates.push(name);
  }
  return {
    safeToImportInSandbox: fuzzCandidates.length > 0,
    fuzzCandidates: fuzzCandidates.slice(0, 8),
  };
}

/**
 * Audits a single file item (pure CPU, safe inside CpuWorkerPool threads).
 * @param {object} item
 */
export function auditFileItem(item) {
  if (!item || typeof item !== 'object') {
    return { relPath: '', ok: false, error: 'Invalid audit item', findings: [] };
  }
  if (item.readError) {
    return {
      relPath: item.relPath || '',
      ok: false,
      error: item.readError,
      findings: [{
        tier: 'T1',
        ruleId: 'FILE_READ_ERROR',
        severity: 'HIGH',
        cwe: 'CWE-391',
        confidence: 0.99,
        file: item.relPath || '',
        line: 1,
        message: 'Failed to read file from disk',
        evidence: String(item.readError).slice(0, 160),
      }],
    };
  }

  const findings = [];
  const relPath = item.relPath || '';
  const ext = (item.ext || extname(relPath)).toLowerCase();
  const text = String(item.text || '');
  const fuzzEnabled = Boolean(item.fuzzEnabled);

  // [T1] Encoding, BOM & config checks
  checkConfigAndEncoding(item, findings);

  let syntaxOk = true;
  let needsSubprocessCheck = false;
  if (SCRIPT_CHECK_EXTS.has(ext) || ext === '.jsx' || ext === '.tsx') {
    const syn = checkJsTsSyntax(item.file || relPath, ext, text, findings, relPath);
    syntaxOk = syn.syntaxOk;
    needsSubprocessCheck = syn.needsSubprocessCheck;
  } else if (ext === '.html' || ext === '.htm') {
    checkHtmlSyntax(relPath, text, findings);
  }

  const cleanCode = maskCommentsPreservingLines(text, item.language);

  if (['go', 'rust', 'c_cpp', 'csharp', 'java'].includes(item.language) && !item.isTestFile) {
    const stripped = stripStringsAndRegexesPreservingLines(cleanCode, item.language);
    checkBracketBalance(relPath, stripped, findings);
  }

  // [T2] Graph, exports, async functions, complexity
  let graphMeta = {
    imports: [],
    exports: { namedExports: [], hasDefaultExport: false, hasStarReExport: false, reExportSpecifiers: [], isDynamicCjsExports: false },
    asyncFunctions: [],
    cyclomatic: 1,
    maxNesting: 0,
  };
  if (JS_TS_EXTS.has(ext)) {
    graphMeta = extractJsTsImportsAndExports(relPath, cleanCode, findings);
  } else if (item.language === 'python') {
    graphMeta = extractPythonMeta(cleanCode);
  }

  // [T3] Secrets, Env Vars, ReDoS & Intra-procedural Source->Sink Taint
  const envVars = scanSecretsAndEnv(item, cleanCode, findings);
  scanRedos(item, cleanCode, fuzzEnabled, findings);
  if (['javascript', 'typescript', 'python', 'go'].includes(item.language)) {
    scanTaintAndSecurity(item, cleanCode, findings);
  }

  // [T4] Concurrency, Async & Resource Leaks
  const concurrencyMeta = ['javascript', 'typescript', 'python', 'go'].includes(item.language)
    ? scanConcurrencyAndLeaks(item, cleanCode, graphMeta.asyncFunctions, findings)
    : { bareCalls: [] };

  // [T5] UI-API & DOM signals
  const uiApi = extractUiApiSignals(item, cleanCode);

  // [T6] Sandbox fuzz eligibility
  const fuzzMeta = detectSafeSandboxFuzzCandidates(item, cleanCode, graphMeta.exports);

  return {
    relPath,
    file: item.file || relPath,
    ext,
    language: item.language,
    isTestFile: Boolean(item.isTestFile),
    linesCount: text ? text.split(/\r?\n/).length : 0,
    syntaxOk,
    needsSubprocessCheck,
    imports: graphMeta.imports,
    exports: graphMeta.exports,
    asyncFunctions: graphMeta.asyncFunctions,
    cyclomatic: graphMeta.cyclomatic,
    maxNesting: graphMeta.maxNesting,
    envVars,
    bareCalls: concurrencyMeta.bareCalls,
    uiApi,
    fuzzMeta,
    findings,
  };
}

/**
 * @file security-guard.mjs
 * @description Security guardrails, .agentignore/.rooignore protection,
 * and RTK (Rust Token Killer) unbounded noisy command interception.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';

const _agentIgnoreCache = new Map(); // wsKey -> { sig, patterns, compiled }

/**
 * Parses .agentignore and .rooignore files in workspace root with mtime memoization.
 * Returns an array of clean pattern strings.
 *
 * @param {string} workspaceRoot
 * @returns {string[]}
 */
export function parseAgentIgnore(workspaceRoot = '') {
  if (!workspaceRoot || typeof workspaceRoot !== 'string' || workspaceRoot.length > 4096) {
    return [];
  }

  let absWs = '';
  try {
    absWs = resolve(workspaceRoot);
    if (!existsSync(absWs) || !statSync(absWs).isDirectory()) {
      return [];
    }
  } catch {
    return [];
  }

  const wsKey = process.platform === 'win32' ? absWs.toLowerCase() : absWs;
  const ignoreFiles = ['.agentignore', '.rooignore'];
  const sigParts = [];
  for (const file of ignoreFiles) {
    try {
      const fullPath = join(absWs, file);
      if (existsSync(fullPath)) {
        const st = statSync(fullPath);
        sigParts.push(`${file}:${st.mtimeMs}:${st.size}`);
      }
    } catch {}
  }
  const sig = sigParts.join('|');
  const cached = _agentIgnoreCache.get(wsKey);
  if (cached && cached.sig === sig) {
    return cached.patterns;
  }

function readIgnoreFileText(fullPath) {
  const buf = readFileSync(fullPath);
  if (!buf || buf.length === 0) return '';
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.subarray(2).toString('utf16le');
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.allocUnsafe(buf.length - 2);
    for (let i = 2; i + 1 < buf.length; i += 2) {
      swapped[i - 2] = buf[i + 1];
      swapped[i - 1] = buf[i];
    }
    return swapped.toString('utf16le');
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString('utf8');
  }
  let oddZeros = 0;
  const sampleLen = Math.min(buf.length, 512);
  for (let i = 1; i < sampleLen; i += 2) {
    if (buf[i] === 0) oddZeros++;
  }
  if (sampleLen >= 4 && oddZeros / (sampleLen / 2) > 0.2) {
    return buf.toString('utf16le');
  }
  return buf.toString('utf8');
}

  const patterns = [];
  for (const file of ignoreFiles) {
    try {
      const fullPath = join(absWs, file);
      if (existsSync(fullPath)) {
        const content = readIgnoreFileText(fullPath);
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < Math.min(lines.length, 300); i++) {
          const trimmed = lines[i].replace(/^\uFEFF/, '').trim();
          if (trimmed && !trimmed.startsWith('#') && trimmed.length <= 256) {
            patterns.push(trimmed);
          }
        }
      }
    } catch {
      // safe fallback on IO errors
    }
  }

  _agentIgnoreCache.set(wsKey, { sig, patterns });
  return patterns;
}

/**
 * Checks whether a relative path or basename matches an ignore pattern.
 * @param {string} relPath
 * @param {string} base
 * @param {string} pattern
 * @returns {boolean}
 */
function matchesPattern(relPath, base, pattern) {
  if (!pattern || typeof pattern !== 'string') return false;

  let pat = pattern.trim().replace(/\\/g, '/');
  if (pat.startsWith('/')) pat = pat.slice(1);
  const isDir = pat.endsWith('/');
  if (isDir) pat = pat.slice(0, -1);

  if (!pat || pat.length > 256) return false;

  if (isDir) {
    if (relPath.startsWith(pat + '/') || relPath.includes('/' + pat + '/')) return true;
  } else {
    if (relPath === pat || base === pat) return true;
    if (relPath.startsWith(pat + '/')) return true;
    if (relPath.includes('/' + pat + '/') || relPath.endsWith('/' + pat)) return true;
  }

  if (pat.includes('*') || pat.includes('?')) {
    // Cap consecutive wildcards to prevent catastrophic ReDoS backtracking
    const safePat = pat.replace(/\*{3,}/g, '**');
    if ((safePat.match(/\*/g) || []).length > 12) return false;
    try {
      const regStr = safePat
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '\x00GLOBSTAR\x00')
        .replace(/\*/g, '[^/]*')
        .replace(/\x00GLOBSTAR\x00/g, '.*')
        .replace(/\?/g, '[^/]');
      const regex = new RegExp(`(?:^|/)${regStr}(?:/|$)`, 'i');
      if (regex.test(relPath) || regex.test(base)) {
        return true;
      }
    } catch {
      // safe fallback on invalid glob
    }
  }

  return false;
}

/**
 * Checks if accessing filePath is allowed or blocked by security policies.
 *
 * @param {object} [options]
 * @param {string} [options.filePath]
 * @param {string} [options.workspaceRoot]
 * @param {string} [options.toolName]
 * @returns {{ allow: boolean, category: string, reason: string }}
 */
export function checkFileSecurity(opts = {}) {
  const options = (opts && typeof opts === 'object') ? opts : {};
  const filePath = typeof options.filePath === 'string' ? options.filePath : '';
  const workspaceRoot = typeof options.workspaceRoot === 'string' ? options.workspaceRoot : '';
  const toolName = typeof options.toolName === 'string' ? options.toolName : '';
  const configProtection = options.configProtection === true;
  const userPrompt = typeof options.userPrompt === 'string' ? options.userPrompt : '';

  if (!filePath) {
    return { allow: true, category: 'clean', reason: '' };
  }
  if (filePath.length > 4096) {
    return {
      allow: false,
      category: 'invalid_path',
      reason: '🔒 [Security Guard] File path exceeds safe maximum length (4096 chars).'
    };
  }

  // Normalize Win32 device prefixes (\\?\C:\..., \\?\UNC\..., \\.\C:\...) and separators across platforms
  const dePrefixedPath = filePath
    .trim()
    .replace(/^\\\\\?\\UNC\\/i, '\\\\')
    .replace(/^\\\\[?.]\\/, '');
  const slashNormPath = dePrefixedPath.replace(/\\/g, '/').replace(/[. ]+$/, '');

  const rawBaseSeg = (() => {
    const parts = slashNormPath.split('/').filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : slashNormPath;
  })().replace(/[. ]+$/, '');

  // Strip NTFS Alternate Data Streams (:Zone.Identifier / ::$DATA) ONLY on last segment without corrupting POSIX colons in dirs/times
  const isWinStyle = process.platform === 'win32' || /^[a-zA-Z]:[/\\]/.test(dePrefixedPath) || /^\\\\/.test(dePrefixedPath);
  const adsStrippedBase = isWinStyle
    ? rawBaseSeg.replace(/:.*$/, '').replace(/[. ]+$/, '')
    : rawBaseSeg.replace(/:(?:\$DATA|Zone\.Identifier.*)$/i, '').replace(/[. ]+$/, '');
  const baseCandidates = adsStrippedBase && adsStrippedBase !== rawBaseSeg ? [rawBaseSeg, adsStrippedBase] : [rawBaseSeg];
  const base = adsStrippedBase || rawBaseSeg;

  const safeTemplates = new Set(['.env.example', '.env.sample', '.env.template', '.env.test']);
  const normFullLower = slashNormPath.toLowerCase();

  // 1. Check secret/credential files
  for (const candBase of baseCandidates) {
    const lowerCand = candBase.toLowerCase();
    if (safeTemplates.has(lowerCand)) continue;
    const isEnv = /^\.env(?:\..+)?$/i.test(candBase);
    const isKeyOrConfig = /^(?:id_rsa|id_ed25519|id_ecdsa|id_dsa|authorized_keys|known_hosts|\.npmrc|\.pypirc|\.netrc|\.git-credentials|kubeconfig|credentials\.json)$/i.test(candBase);
    const isCloudCredPath = /\/(?:\.aws\/credentials|\.kube\/config|\.docker\/config\.json)$/.test(normFullLower);
    const isCertExt = /\.(?:pem|key|pfx|p12|kdbx|tfstate)$/i.test(candBase);

    if (isEnv || isKeyOrConfig || isCloudCredPath || isCertExt) {
      return {
        allow: false,
        category: 'secret_file',
        reason: `🔒 [Security Guard] Access to sensitive credential file '${candBase}' is blocked to prevent secret leakage into LLM context.`
      };
    }
  }

  // 2. Check .agentignore / .rooignore patterns
  if (workspaceRoot && typeof workspaceRoot === 'string') {
    const patterns = parseAgentIgnore(workspaceRoot);
    if (patterns.length > 0) {
      let relPath = slashNormPath;
      try {
        const absWs = resolve(workspaceRoot);
        const absFile = isAbsolute(dePrefixedPath) ? resolve(dePrefixedPath) : resolve(absWs, dePrefixedPath);
        relPath = relative(absWs, absFile);
      } catch {
        relPath = slashNormPath;
      }
      relPath = relPath.replace(/\\/g, '/');
      if (relPath.startsWith('./')) {
        relPath = relPath.slice(2);
      }

      for (const pat of patterns) {
        if (matchesPattern(relPath, base, pat)) {
          return {
            allow: false,
            category: 'agentignore',
            reason: `🔒 [Security Guard] File '${relPath || filePath}' is protected by .agentignore/.rooignore.`
          };
        }
      }
    }
  }

  // 3. Config Protection: prevent silent weakening of linter/formatter/typecheck/router configs on edits
  if (configProtection && (toolName === 'edit_file' || toolName === 'write_file')) {
    const protectedConfigRe = /^(?:\.eslintrc(?:\.[a-z0-9]+)?|eslint\.config\.[cm]?[jt]s|biome\.jsonc?|tsconfig(?:\.[a-z0-9_-]+)?\.json|\.prettierrc(?:\.[a-z0-9]+)?|prettier\.config\.[cm]?[jt]s|\.stylelintrc(?:\.[a-z0-9]+)?|\.ruff\.toml|ruff\.toml|\.flake8|\.pylintrc|mypy\.ini)$/i;
    const isRouterState = /^router-state\.json$/i.test(base);
    if (protectedConfigRe.test(base) || isRouterState) {
      const promptLower = userPrompt.toLowerCase();
      const explicitlyAuthorized = isRouterState
        ? (promptLower.includes('router-state.json') ||
            /(?:router-state|настройк[аиу]\s+роутер|конфиг\s+роутер|router\s+config|router\s+state)/i.test(userPrompt))
        : ((base && promptLower.includes(base.toLowerCase())) ||
            /(?:eslint|biome|tsconfig|prettier|stylelint|ruff|flake8|pylint|mypy|линтер|форматтер|типизац|конфиг|правил[ао]?\s+линтер|config\s+file)/i.test(userPrompt));
      if (!explicitlyAuthorized) {
        return {
          allow: false,
          category: 'config_protection',
          reason: isRouterState
            ? `🛡️ [Config Protection] Editing router config '${base}' is blocked unless explicitly requested by the user.`
            : `🛡️ [Config Protection] Editing quality/linter config '${base}' is blocked unless explicitly requested by the user. Fix the source code instead of weakening config rules.`
        };
      }
    }
  }

  return { allow: true, category: 'clean', reason: '' };
}

/**
 * Checks command string for destructive operations or unbounded noisy flood.
 * 
 * @param {object|string} [options]
 * @param {string} [options.commandLine]
 * @param {string} [options.workspaceRoot]
 * @param {string} [positionalWorkspaceRoot]
 * @returns {{ allow: boolean, allowed: boolean, category: string, reason: string, suggestedCmd: string }}
 */
export function checkCommandSecurity(opts = {}, positionalWorkspaceRoot = '') {
  const res = checkCommandSecurityImpl(opts, positionalWorkspaceRoot);
  return { ...res, allowed: Boolean(res.allow) };
}

function checkCommandSecurityImpl(opts = {}, positionalWorkspaceRoot = '') {
  const options = typeof opts === 'string'
    ? { commandLine: opts, workspaceRoot: typeof positionalWorkspaceRoot === 'string' ? positionalWorkspaceRoot : '' }
    : (opts && typeof opts === 'object' ? opts : {});
  const commandLine = typeof options.commandLine === 'string' ? options.commandLine : '';
  const workspaceRoot = typeof options.workspaceRoot === 'string' ? options.workspaceRoot : '';
  const depth = Number(options._depth || 0);

  if (!commandLine) {
    return { allow: true, category: 'clean', reason: '', suggestedCmd: '' };
  }

  const trimmed = commandLine.trim();
  if (!trimmed) {
    return { allow: true, category: 'clean', reason: '', suggestedCmd: '' };
  }

  // Decode and inspect PowerShell -EncodedCommand payloads to prevent Base64 secret/firewall bypass
  const psEncodedRe = /\b(?:powershell|pwsh)(?:\.exe)?\b[^\r\n]*?\s-(?:e|ec|enc|encodedcommand)(?:\s+|:)(?:"([^"]*)"|'([^']*)'|([^\s|;&]+))/gi;
  const isPrintableDecodedText = (s) => Boolean(s) && !/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFD\uD800-\uDFFF]/.test(s);
  let psEncMatch;
  while ((psEncMatch = psEncodedRe.exec(trimmed)) !== null) {
    const rawB64 = String(psEncMatch[1] ?? psEncMatch[2] ?? psEncMatch[3] ?? '').trim();
    if (!rawB64 || rawB64.length < 4 || !/^[A-Za-z0-9+/=]+$/.test(rawB64)) {
      return {
        allow: false,
        category: 'encoded_cmd',
        reason: '🔒 [Security Firewall] Blocked malformed or obfuscated PowerShell -EncodedCommand payload.',
        suggestedCmd: ''
      };
    }
    let decoded = '';
    try {
      const buf = Buffer.from(rawB64, 'base64');
      const utf16Cand = buf.toString('utf16le').replace(/\0/g, '').trim();
      if (isPrintableDecodedText(utf16Cand)) {
        decoded = utf16Cand;
      } else {
        const utf8Alt = buf.toString('utf8').replace(/\0/g, '').trim();
        if (isPrintableDecodedText(utf8Alt)) decoded = utf8Alt;
      }
    } catch {}
    if (!decoded) {
      return {
        allow: false,
        category: 'encoded_cmd',
        reason: '🔒 [Security Firewall] Blocked unreadable PowerShell -EncodedCommand payload.',
        suggestedCmd: ''
      };
    }
    if (depth < 2) {
      const subRes = checkCommandSecurityImpl({ commandLine: decoded, workspaceRoot, _depth: depth + 1 });
      if (!subRes.allow) {
        return subRes;
      }
    }
  }

  // Mask quoted string literals so safe searches like `rg "git reset --hard"` or commit messages do not false-positive
  const unquoted = trimmed
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''");

  // 0) Direct shell read/copy/exfiltration of protected secret files (.env, SSH keys, .agentignore)
  const fileReadSegRe = /(?:^|[|;&\r\n]|(?:^|[|;&\s])\/c\s+)\s*(?:cat|type|Get-Content|gc|more|head|tail|Select-String|sls|rg|grep|findstr|Copy-Item|cp|copy|Move-Item|mv|Get-Item|gi|Import-Csv)\b([^|;&\r\n]*)/gi;
  let segMatch;
  while ((segMatch = fileReadSegRe.exec(trimmed)) !== null) {
    const argTail = segMatch[1] || '';
    const tokens = argTail.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s]+/g) || [];
    let prevFlag = '';
    for (const rawTok of tokens) {
      let tok = rawTok.replace(/^['"]|['"]$/g, '');
      if (!tok) continue;
      if (/^-[A-Za-z0-9_-]+$/.test(tok)) {
        prevFlag = tok.toLowerCase();
        continue;
      }
      if (prevFlag === '-pattern' || prevFlag === '--regexp' || prevFlag === '-e') {
        prevFlag = '';
        continue;
      }
      prevFlag = '';
      if (/^-[A-Za-z]+[:=]/.test(tok)) {
        tok = tok.replace(/^-[A-Za-z]+[:=]/, '').replace(/^['"]|['"]$/g, '');
      }
      tok = tok.replace(/^\d*[<>]+/, '').replace(/^['"]|['"]$/g, '');
      if (!tok) continue;
      for (const piece of tok.split(/[<>]+/)) {
        const cleanedPiece = piece.replace(/^['"]|['"]$/g, '').trim();
        if (!cleanedPiece) continue;
        const fileCheck = checkFileSecurity({ filePath: cleanedPiece, workspaceRoot, toolName: 'run_command' });
        if (!fileCheck.allow) {
          return {
            allow: false,
            category: fileCheck.category,
            reason: fileCheck.reason,
            suggestedCmd: ''
          };
        }
      }
    }
  }

  const inlineReadRe = /(?:readFileSync|readFile|ReadAllText|ReadAllLines|ReadAllBytes)\s*\(\s*['"]([^'"]+)['"]|\bcurl\b[^\r\n]*?(?:\s|-[A-Za-z]+)@(['"]?[^\s|;&>'"]+['"]?)|\bpowershell(?:\.exe)?\b[^\r\n]*?\b(?:Get-Content|gc|cat|type|Select-String|sls)\s+(['"]?[^\s"'|;&\)]+['"]?)/gi;
  let readMatch;
  while ((readMatch = inlineReadRe.exec(trimmed)) !== null) {
    const rawArg = (readMatch[1] || readMatch[2] || readMatch[3] || '').replace(/^['"]|['"]$/g, '');
    if (rawArg && !rawArg.startsWith('-')) {
      const fileCheck = checkFileSecurity({ filePath: rawArg, workspaceRoot, toolName: 'run_command' });
      if (!fileCheck.allow) {
        return {
          allow: false,
          category: fileCheck.category,
          reason: fileCheck.reason,
          suggestedCmd: ''
        };
      }
    }
  }

  // A) Destructive / Exfiltration Firewall
  const gitPrefix = '\\bgit\\s+(?:-[A-Za-z]\\s+\\S+\\s+|--[a-z-]+(?:=\\S+)?\\s+)*';

  // Git reset --hard
  if (new RegExp(`${gitPrefix}reset\\s+[^;\\n]*--hard\\b`, 'i').test(unquoted)) {
    return {
      allow: false,
      category: 'destructive_cmd',
      reason: '🛑 [Security Firewall] Blocked destructive or exfiltration command: git reset --hard destroys uncommitted changes.',
      suggestedCmd: ''
    };
  }

  // Git checkout -- . / git restore . (full working tree wipe)
  if (new RegExp(`${gitPrefix}(?:checkout\\s+--\\s+\\.|restore\\s+(?:--worktree\\s+)?\\.)(?:\\s|$|;)`, 'i').test(unquoted)) {
    return {
      allow: false,
      category: 'destructive_cmd',
      reason: '🛑 [Security Firewall] Blocked destructive command: full working-tree discard (git checkout -- . / git restore .) destroys all local edits.',
      suggestedCmd: ''
    };
  }

  // Git clean -fd, -f, -df, -xdf
  if (new RegExp(`${gitPrefix}clean\\s+[^;\\n]*-[a-z]*f[a-z]*`, 'i').test(unquoted)) {
    return {
      allow: false,
      category: 'destructive_cmd',
      reason: '🛑 [Security Firewall] Blocked destructive or exfiltration command: git clean with force flag removes untracked files permanently.',
      suggestedCmd: ''
    };
  }

  // Git push --force (allow --force-with-lease)
  if (new RegExp(`${gitPrefix}push\\b`, 'i').test(unquoted)) {
    const hasForceWithLease = /--force-with-lease\b/i.test(unquoted);
    const hasForce = /(?:--force|-f)\b/i.test(unquoted);
    if (hasForce && !hasForceWithLease) {
      return {
        allow: false,
        category: 'destructive_cmd',
        reason: '🛑 [Security Firewall] Blocked destructive or exfiltration command: git push --force can overwrite remote history. Use --force-with-lease if necessary.',
        suggestedCmd: ''
      };
    }
  }

  // Quality-Gate / Git-Hook bypass protection (--no-verify, commit -n, HUSKY=0, LEFTHOOK=0)
  const isCommitHookBypass = new RegExp(`${gitPrefix}commit\\b[^;|\\r\\n]*?(?:\\s--no-verify\\b|\\s-(?!-)[a-z]*n[a-z]*(?=\\s|$|;|&|\\|))`, 'i').test(unquoted);
  const isPushHookBypass = new RegExp(`${gitPrefix}push\\b[^;|\\r\\n]*\\s--no-verify\\b`, 'i').test(unquoted);
  const isEnvHookBypass =
    /(?:^|[|;&\s])(?:\$env:)?(?:HUSKY|LEFTHOOK)\s*=\s*0(?=\s|$|[|;&])/i.test(unquoted) ||
    /(?:^|[|;&\s])(?:\$env:)?(?:HUSKY|LEFTHOOK)\s*=\s*['"]?0['"]?(?=\s|$|[|;&])[\s\S]*\bgit\b/i.test(trimmed);
  if (isCommitHookBypass || isPushHookBypass || isEnvHookBypass) {
    return {
      allow: false,
      category: 'quality_gate_bypass',
      reason: '🛡️ [Quality-Gate Guard] Blocked git hook bypass (--no-verify / commit -n / HUSKY=0 / LEFTHOOK=0). Fix the failing check instead of skipping hooks.',
      suggestedCmd: ''
    };
  }

  // Dangerous system / disk / registry commands
  const dangerousSysPattern = /\b(?:Format-Volume|diskpart|Stop-Computer|Restart-Computer)\b|cipher\s+\/w:|\breg\s+delete\b/i;
  if (dangerousSysPattern.test(unquoted)) {
    return {
      allow: false,
      category: 'destructive_cmd',
      reason: '🛑 [Security Firewall] Blocked destructive or exfiltration command: system disk/registry manipulation is restricted.',
      suggestedCmd: ''
    };
  }

  // Remote shell pipe execution
  const remotePipePattern = /(?:curl|wget|Invoke-WebRequest|iwr|irm)\b[^|;\n]*\|\s*(?:sh|bash|zsh|pwsh|powershell|iex|Invoke-Expression)\b/i;
  if (remotePipePattern.test(unquoted)) {
    return {
      allow: false,
      category: 'destructive_cmd',
      reason: '🛑 [Security Firewall] Blocked destructive or exfiltration command: piped remote shell execution poses critical exfiltration risk.',
      suggestedCmd: ''
    };
  }

  // Env-var secret exfiltration via network commands (inspect trimmed so quoted "$GITHUB_TOKEN" is caught)
  const netToolRe = /\b(?:curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|nc|ncat)\b/i;
  const envSecretRefRe = /(?:\$(?:env:)?|\$\{|%)(?:[A-Z0-9_]*(?:TOKEN|SECRET|API_KEY|PRIVATE_KEY|PASSWORD|PASSWD|CREDENTIALS?|AUTH_KEY)[A-Z0-9_]*)\b/i;
  if (netToolRe.test(trimmed) && envSecretRefRe.test(trimmed)) {
    const urls = trimmed.match(/https?:\/\/[^\s"'`]+/gi) || [];
    const loopbackOnly = urls.length > 0 && urls.every((u) => /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/i.test(u)) && !/\b(?:nc|ncat)\b/i.test(trimmed);
    if (!loopbackOnly) {
      return {
        allow: false,
        category: 'secret_exfil',
        reason: '🛑 [Security Firewall] Blocked potential secret environment-variable exfiltration via network command.',
        suggestedCmd: ''
      };
    }
  }

  // Root or home wipe: token-level check so project subfolders (e.g. rm -rf dist/, ./build/, C:/project/dist/) are allowed
  const isDangerousWipeTarget = (rawTok = '') => {
    const tok = String(rawTok).trim().replace(/^['"]|['"]$/g, '');
    if (!tok) return false;
    if (/^(?:\/+\*?|\.[\\/*]*)$/.test(tok)) return true;
    if (tok.startsWith('..') && /^[.\\/]+$/.test(tok)) {
      const segs = tok.split(/[\\/]+/);
      if (segs.every((s, idx) => s === '..' || (idx === segs.length - 1 && s === ''))) return true;
    }
    if (/^~(?:[\\/]+\*?)?$/.test(tok)) return true;
    if (/^(?:\$HOME|\$\{HOME\}|\$env:USERPROFILE|\$env:SystemDrive|%USERPROFILE%|%SYSTEMDRIVE%)(?:[\\/]+\*?)?$/i.test(tok)) return true;
    if (/^[a-zA-Z]:(?:[\\/]+\*?)?$/.test(tok)) return true;
    if (/^(?:\/(?:etc|usr|var|bin|sbin|lib|home|root|Users)|[a-zA-Z]:[\\/](?:Windows|Program Files(?: \(x86\))?|Users))(?:[\\/]+\*?)?$/i.test(tok)) return true;
    return false;
  };

  let isDestructiveRootWipe = false;
  for (const seg of trimmed.split(/[|;&\r\n]+/)) {
    const cmdM = seg.match(/(?:^|\s|\/c\s+)(Remove-Item|rmdir|rd|erase|del|rm|ri)\b([\s\S]*)$/i);
    if (!cmdM) continue;
    const rawCmdHead = cmdM[1].toLowerCase();
    const isWinDeleteCmd = rawCmdHead === 'rd' || rawCmdHead === 'rmdir' || rawCmdHead === 'del' || rawCmdHead === 'erase';
    const tokens = (cmdM[2] || '').match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s]+/g) || [];
    const hasRecursive = tokens.some((t) =>
      /^-[a-z]*r[a-z]*$/i.test(t) || /^--recursive$/i.test(t) || /^-Recurse$/i.test(t) || (isWinDeleteCmd && /^\/s$/i.test(t))
    );
    if (!hasRecursive) continue;

    const targets = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (/^-(?:Path|LiteralPath)$/i.test(t) && i + 1 < tokens.length) {
        targets.push(tokens[++i]);
        continue;
      }
      if (isWinDeleteCmd && /^\/[a-z0-9:]+$/i.test(t)) {
        continue;
      }
      if (/^-/.test(t)) {
        continue;
      }
      targets.push(t);
    }
    if (targets.some(isDangerousWipeTarget)) {
      isDestructiveRootWipe = true;
      break;
    }
  }

  if (isDestructiveRootWipe) {
    return {
      allow: false,
      category: 'destructive_cmd',
      reason: '🛑 [Security Firewall] Blocked destructive or exfiltration command: recursive deletion of root or home directory.',
      suggestedCmd: ''
    };
  }

  // B) RTK (Rust Token Killer) Unbounded Noisy Command Interceptor
  // Bare git log without bound or unbounded git log -p/--patch
  if (new RegExp(`${gitPrefix}log\\b`, 'i').test(unquoted)) {
    const isPatch = /(?:^|\s)(?:-p|--patch)\b/i.test(unquoted);
    const hasCountLimit = /(?:-n\b|--max-count\b|-\d+)/i.test(unquoted);
    if (isPatch && !hasCountLimit) {
      return {
        allow: false,
        category: 'rtk_noisy_cmd',
        suggestedCmd: 'git log -n 5 --stat',
        reason: "⚡ [RTK Token Guard] Unbounded 'git log -p/--patch' floods context. Add -n <count> or use git log -n 10 --stat."
      };
    }
    const isBounded = /(?:-n\b|--max-count\b|--oneline\b|-\d+)/i.test(unquoted);
    if (!isBounded) {
      return {
        allow: false,
        category: 'rtk_noisy_cmd',
        suggestedCmd: 'git log -n 15 --oneline',
        reason: "⚡ [RTK Token Guard] Bare 'git log' floods context. Use bounded: git log -n 15 --oneline"
      };
    }
  }

  // Raw un-piped lockfile dumps flood context with thousands of dependency hashes
  if (/(?:^|[;|&]\s*)(?:cat|type|Get-Content|gc)\s+[^\n|]*(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|poetry\.lock)\b/i.test(unquoted)) {
    const hasFilter = /\|\s*(?:Select-String|grep|rg|findstr|Measure-Object|Select-Object|head|tail|obs-masker)\b|-Head\b|-Tail\b|-TotalCount\b/i.test(unquoted);
    if (!hasFilter) {
      return {
        allow: false,
        category: 'rtk_noisy_cmd',
        suggestedCmd: 'Select-String -Path package-lock.json -Pattern "<pkg>"',
        reason: '⚡ [RTK Token Guard] Raw lockfile dump floods context. Pipe to Select-String / Select-Object -First 40 or read package.json.'
      };
    }
  }

  // Recursive directory tree flood: dir /s without filter, bare tree, or Get-ChildItem -Recurse without -Depth/Select-Object
  if (/\bdir\b[^\n|]*\/s\b/i.test(unquoted) && !/Select-Object|Measure-Object|obs-masker/i.test(unquoted)) {
    return {
      allow: false,
      category: 'rtk_noisy_cmd',
      suggestedCmd: 'Get-ChildItem -Depth 2',
      reason: '⚡ [RTK Token Guard] Unbounded recursive directory listing floods context. Add -Depth 2 or Select-Object -First 40.'
    };
  }

  if (/^\s*tree\b(?:\s+[\w./\\:-]+)?(?:\s*)$/i.test(unquoted)) {
    return {
      allow: false,
      category: 'rtk_noisy_cmd',
      suggestedCmd: 'Get-ChildItem -Depth 2',
      reason: '⚡ [RTK Token Guard] Unbounded recursive directory listing floods context. Add -Depth 2 or Select-Object -First 40.'
    };
  }

  const hasPipeOrFilterBounding = /(?:-Depth\b|Select-Object\b|Measure-Object\b|Where-Object\b|ForEach-Object\b|\|\s*%\b|obs-masker)/i.test(unquoted);
  if (!hasPipeOrFilterBounding) {
    const gciSegments = unquoted.split(/[|;&\r\n]+/);
    for (const seg of gciSegments) {
      if (/\b(?:Get-ChildItem|gci)\b/i.test(seg) && /(?:^|\s)-(?:r|recurse)\b/i.test(seg) && !/-Depth\b/i.test(seg)) {
        return {
          allow: false,
          category: 'rtk_noisy_cmd',
          suggestedCmd: 'Get-ChildItem -Depth 2',
          reason: '⚡ [RTK Token Guard] Unbounded recursive directory listing floods context. Add -Depth 2 or Select-Object -First 40.'
        };
      }
    }
  }

  return { allow: true, category: 'clean', reason: '', suggestedCmd: '' };
}

/**
 * Redacts common API keys, private keys, JWTs, and URI credentials from text.
 *
 * @param {string|Buffer|Error} text
 * @returns {string}
 */
export function redactSecretsInText(text = '') {
  let result = '';
  if (typeof text === 'string') {
    result = text;
  } else if (Buffer.isBuffer(text)) {
    result = text.toString('utf8');
  } else if (text instanceof Error) {
    result = text.stack || text.message || String(text);
  } else {
    return '';
  }

  if (!result) {
    return '';
  }

  // PEM private key blocks and standalone headers
  result = result.replace(
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    '[REDACTED_SECRET]'
  );
  result = result.replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g, '[REDACTED_SECRET]');

  // Bearer tokens (case-insensitive scheme, RFC 6750 b64token charset, single-line whitespace)
  result = result.replace(/\bBearer[ \t]+[A-Za-z0-9._~+/-]{25,}=*/gi, 'Bearer [REDACTED_SECRET]');

  // OpenAI / Anthropic / standard sk- keys (word-bounded to avoid corrupting Windows paths like task-management-service-v2)
  result = result.replace(/\bsk-(?:ant-|proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_SECRET]');

  // Google AIza & OAuth ya29 tokens
  result = result.replace(/\bAIza[0-9A-Za-z_-]{25,}\b/g, '[REDACTED_SECRET]');
  result = result.replace(/\bya29\.[A-Za-z0-9._-]{30,}\b/g, '[REDACTED_SECRET]');

  // GitHub classic & fine-grained PATs, GitLab PATs, Slack, HuggingFace, Perplexity, Firecrawl, AWS Access Keys
  result = result.replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED_SECRET]');
  result = result.replace(/\bgithub_pat_[A-Za-z0-9_]{24,}\b/g, '[REDACTED_SECRET]');
  result = result.replace(/\bglpat-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_SECRET]');
  result = result.replace(/\bxox[baprs]-[A-Za-z0-9-]{16,}\b/g, '[REDACTED_SECRET]');
  result = result.replace(/\bhf_[A-Za-z0-9]{24,}\b/g, '[REDACTED_SECRET]');
  result = result.replace(/\bpplx-[A-Za-z0-9]{24,}\b/g, '[REDACTED_SECRET]');
  result = result.replace(/\bfc-[a-f0-9]{24,}\b/gi, '[REDACTED_SECRET]');
  result = result.replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED_SECRET]');

  // Standalone JWT tokens
  result = result.replace(/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_SECRET]');

  // Basic-auth / DB credentials embedded in URIs (http(s), postgres, mysql, mongodb, redis, amqp, ftp, ssh)
  result = result.replace(
    /\b((?:https?|postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?|ftp|ssh):\/\/[^/\s:@?#]*):([^/\s@?#]+)@/gi,
    '$1:[REDACTED_SECRET]@'
  );

  return result;
}

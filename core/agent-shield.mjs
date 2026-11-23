/**
 * @file agent-shield.mjs
 * @description Offline security auditor for AI agent configs (mcp_config.json, hooks.json, SKILL.md).
 * Detects hardcoded API keys/secrets, dangerous shell hooks/args, Trojan Source BiDi chars, and prompt injection.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { checkCommandSecurity, redactSecretsInText } from './security-guard.mjs';

const MAX_SCAN_FILES = 200;
const MAX_FILE_BYTES = 512 * 1024;

const SEVERITY_WEIGHTS = {
  critical: 25,
  high: 15,
  medium: 7,
  low: 2,
};

const SECRET_PATTERNS = [
  { id: 'openai_anthropic_key', severity: 'critical', label: 'Захардкоженный API-ключ sk-*', rx: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { id: 'github_pat', severity: 'critical', label: 'Захардкоженный токен GitHub PAT', rx: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{24,})\b/g },
  { id: 'gitlab_pat', severity: 'critical', label: 'Захардкоженный токен GitLab PAT', rx: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { id: 'huggingface_token', severity: 'critical', label: 'Захардкоженный токен HuggingFace hf_*', rx: /\bhf_[A-Za-z0-9]{24,}\b/g },
  { id: 'perplexity_key', severity: 'critical', label: 'Захардкоженный ключ Perplexity pplx-*', rx: /\bpplx-[A-Za-z0-9]{24,}\b/g },
  { id: 'firecrawl_key', severity: 'critical', label: 'Захардкоженный ключ Firecrawl fc-*', rx: /\bfc-[a-f0-9]{24,}\b/gi },
  { id: 'google_api_key', severity: 'critical', label: 'Захардкоженный Google API ключ AIza*', rx: /\bAIza[0-9A-Za-z_-]{25,}\b/g },
  { id: 'aws_access_key', severity: 'critical', label: 'Захардкоженный AWS Access Key AKIA*', rx: /\bAKIA[0-9A-Z]{16}\b/g },
  { id: 'slack_token', severity: 'high', label: 'Захардкоженный Slack-токен xox*', rx: /\bxox[baprs]-[A-Za-z0-9-]{16,}\b/g },
  { id: 'private_key_pem', severity: 'critical', label: 'Приватный криптографический ключ PEM', rx: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g },
  { id: 'bearer_token', severity: 'high', label: 'Захардкоженный Bearer-токен', rx: /\bBearer\s+[A-Za-z0-9._-]{25,}/g },
  { id: 'jwt_token', severity: 'high', label: 'Захардкоженный JWT-токен', rx: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { id: 'db_uri_password', severity: 'critical', label: 'Учётные данные в URI базы данных', rx: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^:\s/]+:[^@\s/]{3,}@[^\s"']+/gi },
];

const PLACEHOLDER_RE = /^(?:\$\{[^}]+\}|%[A-Za-z0-9_]+%|\$[A-Za-z_][A-Za-z0-9_]*|<[A-Z0-9_:-]+>|YOUR_[A-Z0-9_]+|REPLACE_ME|EXAMPLE_.*)$/i;
const BIDI_TROJAN_RE = /[\u202A-\u202E\u2066-\u2069]/;
const ZERO_WIDTH_CLUSTER_RE = /[\u200B-\u200D\uFEFF]{4,}/;
const PROMPT_INJECTION_PATTERNS = [
  {
    id: 'prompt_override',
    severity: 'high',
    label: 'Инструкция перехвата приоритета (Prompt Injection)',
    rx: /\b(?:ignore|disregard|override|forget)\s+(?:all\s+)?(?:previous|prior|above|system|user)\s+(?:instructions|rules|prompts|guidelines)\b/i,
  },
  {
    id: 'secret_exfil',
    severity: 'critical',
    label: 'Попытка скрытой эксфильтрации секретов во внешнюю сеть',
    rx: /\b(?:exfiltrate|steal|upload|send|post)\s+(?:all\s+)?(?:secrets?|\.env|api[\s_-]?keys?|credentials?|ssh\s+keys?)\s+(?:to|via)\s+https?:\/\//i,
  },
  {
    id: 'stealth_deception',
    severity: 'medium',
    label: 'Скрытие действий от пользователя',
    rx: /\bdo\s+not\s+(?:tell|inform|show|mention\s+to)\s+(?:the\s+)?user\b/i,
  },
];
const REMOTE_PIPE_RE = /(?:curl|wget|Invoke-WebRequest|iwr|irm)\b[^\r\n|]*\|\s*(?:sh|bash|zsh|pwsh|powershell|iex|Invoke-Expression)\b/i;

function makeFinding({ file, kind, severity, ruleId, message, excerpt = '' }) {
  const safeExcerpt = redactSecretsInText(String(excerpt || '').replace(/\s+/g, ' ').trim()).slice(0, 140);
  return {
    file,
    kind,
    severity,
    ruleId,
    message,
    excerpt: safeExcerpt,
  };
}

function scanTextForSecrets(text, file, kind, findings) {
  if (!text || typeof text !== 'string') return false;
  let foundAny = false;
  for (const pat of SECRET_PATTERNS) {
    const flags = pat.rx.flags.includes('g') ? pat.rx.flags : `${pat.rx.flags}g`;
    const rx = new RegExp(pat.rx.source, flags);
    let match;
    let guard = 0;
    while ((match = rx.exec(text)) !== null && guard++ < 50) {
      const token = match[0];
      if (!token) {
        rx.lastIndex++;
        continue;
      }
      if (PLACEHOLDER_RE.test(token)) continue;
      foundAny = true;
      findings.push(
        makeFinding({
          file,
          kind,
          severity: pat.severity,
          ruleId: pat.id,
          message: pat.label,
          excerpt: token,
        })
      );
      break;
    }
  }
  return foundAny;
}

function readShieldTargetFile(filePath, kind, findings) {
  let raw = '';
  try {
    const st = statSync(filePath);
    if (!st.isFile()) return null;
    if (st.size > MAX_FILE_BYTES) {
      findings.push(
        makeFinding({
          file: filePath,
          kind,
          severity: 'high',
          ruleId: `${kind}_file_oversized`,
          message: `Файл (${kind}) превышает безопасный лимит ${Math.round(MAX_FILE_BYTES / 1024)} КБ (${st.size} байт)`,
        })
      );
      return null;
    }
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  return raw;
}

/**
 * Audits an MCP config JSON file (`mcp_config.json` / `.mcp.json`).
 * @param {string} filePath
 * @returns {Array<object>}
 */
export function scanMcpConfigFile(filePath) {
  const findings = [];
  if (!filePath || !existsSync(filePath)) return findings;
  const raw = readShieldTargetFile(filePath, 'mcp', findings);
  if (raw === null) return findings;

  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    findings.push(
      makeFinding({
        file: filePath,
        kind: 'mcp',
        severity: 'low',
        ruleId: 'invalid_mcp_json',
        message: 'Некорректный JSON в конфигурации MCP',
      })
    );
    return findings;
  }

  const servers = parsed?.mcpServers || parsed?.servers || (parsed && typeof parsed === 'object' ? parsed : {});
  for (const [serverName, cfg] of Object.entries(servers || {})) {
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) continue;
    const cmd = typeof cfg.command === 'string' ? cfg.command.trim() : '';
    const argsList = Array.isArray(cfg.args) ? cfg.args.map((a) => String(a ?? '')) : [];
    const joinedCmd = [cmd, ...argsList].filter(Boolean).join(' ');

    if (joinedCmd) {
      scanTextForSecrets(joinedCmd, filePath, 'mcp', findings);
      const secCmd = checkCommandSecurity({ commandLine: joinedCmd });
      if (secCmd && secCmd.allow === false && secCmd.category !== 'rtk_noisy_cmd') {
        findings.push(
          makeFinding({
            file: filePath,
            kind: 'mcp',
            severity: 'critical',
            ruleId: `mcp_unsafe_cmd_${secCmd.category || 'exec'}`,
            message: `MCP-сервер "${serverName}": опасная команда запуска (${secCmd.category})`,
            excerpt: joinedCmd,
          })
        );
      }

      const cmdBase = basename(cmd).toLowerCase().replace(/\.(?:exe|cmd|bat)$/i, '');
      const isShellHead = /^(?:cmd|sh|bash|zsh|pwsh|powershell)$/i.test(cmdBase);
      if (isShellHead && argsList.some((a) => /(?:&&|\|\||;|\$\(|`)/.test(a) && /(?:curl|wget|iwr|irm|iex|-enc)/i.test(a))) {
        findings.push(
          makeFinding({
            file: filePath,
            kind: 'mcp',
            severity: 'high',
            ruleId: 'mcp_shell_metachar',
            message: `MCP-сервер "${serverName}": цепочка shell-метасимволов в аргументах`,
            excerpt: joinedCmd,
          })
        );
      }
    }

    if (typeof cfg.url === 'string' && cfg.url.trim()) {
      const urlStr = cfg.url.trim();
      if (!PLACEHOLDER_RE.test(urlStr)) {
        scanTextForSecrets(urlStr, filePath, 'mcp', findings);
      }
    }

    if (cfg.headers && typeof cfg.headers === 'object' && !Array.isArray(cfg.headers)) {
      for (const [hdrKey, hdrVal] of Object.entries(cfg.headers)) {
        const valStr = typeof hdrVal === 'string' ? hdrVal.trim() : '';
        if (!valStr || PLACEHOLDER_RE.test(valStr)) continue;
        scanTextForSecrets(`${hdrKey}: ${valStr}`, filePath, 'mcp', findings);
      }
    }

    if (cfg.env && typeof cfg.env === 'object' && !Array.isArray(cfg.env)) {
      for (const [envKey, envVal] of Object.entries(cfg.env)) {
        const valStr = typeof envVal === 'string' ? envVal.trim() : '';
        if (!valStr || PLACEHOLDER_RE.test(valStr)) continue;
        const hitPattern = scanTextForSecrets(`${envKey}=${valStr}`, filePath, 'mcp', findings);
        if (
          !hitPattern &&
          /(?:API_KEY|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|ACCESS_TOKEN|AUTH_TOKEN)$/i.test(envKey) &&
          valStr.length >= 12 &&
          !/^(?:true|false|null|none|changeme|example|placeholder|test[-_a-z0-9]*)$/i.test(valStr)
        ) {
          findings.push(
            makeFinding({
              file: filePath,
              kind: 'mcp',
              severity: 'high',
              ruleId: 'mcp_hardcoded_env_secret',
              message: `MCP-сервер "${serverName}": захардкоженный секрет в env.${envKey} (используйте \${${envKey}})`,
              excerpt: `${envKey}=${valStr}`,
            })
          );
        }
      }
    }
  }

  return findings;
}

/**
 * Audits a hooks configuration file (`hooks.json`).
 * @param {string} filePath
 * @returns {Array<object>}
 */
export function scanHooksConfigFile(filePath) {
  const findings = [];
  if (!filePath || !existsSync(filePath)) return findings;
  const raw = readShieldTargetFile(filePath, 'hooks', findings);
  if (raw === null) return findings;

  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    findings.push(
      makeFinding({
        file: filePath,
        kind: 'hooks',
        severity: 'low',
        ruleId: 'invalid_hooks_json',
        message: 'Некорректный JSON в конфигурации хуков',
      })
    );
    return findings;
  }

  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (typeof node.command === 'string' && node.command.trim()) {
      const cmd = node.command.trim();
      scanTextForSecrets(cmd, filePath, 'hooks', findings);
      const sec = checkCommandSecurity({ commandLine: cmd });
      if (sec && sec.allow === false && sec.category !== 'rtk_noisy_cmd') {
        findings.push(
          makeFinding({
            file: filePath,
            kind: 'hooks',
            severity: sec.category === 'destructive_cmd' || sec.category === 'encoded_cmd' ? 'critical' : 'high',
            ruleId: `hook_unsafe_${sec.category || 'cmd'}`,
            message: `Опасная команда в хуке (${sec.category})`,
            excerpt: cmd,
          })
        );
      }
    }
    for (const val of Object.values(node)) {
      if (val && typeof val === 'object') walk(val);
    }
  };

  walk(parsed);
  return findings;
}

/**
 * Audits a SKILL.md instruction file for Trojan Source BiDi chars, secrets, and prompt-injection directives.
 * @param {string} filePath
 * @returns {Array<object>}
 */
export function scanSkillFile(filePath) {
  const findings = [];
  if (!filePath || !existsSync(filePath)) return findings;
  const raw = readShieldTargetFile(filePath, 'skill', findings);
  if (raw === null) return findings;

  if (BIDI_TROJAN_RE.test(raw)) {
    findings.push(
      makeFinding({
        file: filePath,
        kind: 'skill',
        severity: 'critical',
        ruleId: 'skill_bidi_trojan',
        message: 'Обнаружены скрытые Unicode BiDi-символы (риск Trojan Source)',
      })
    );
  }
  if (ZERO_WIDTH_CLUSTER_RE.test(raw)) {
    findings.push(
      makeFinding({
        file: filePath,
        kind: 'skill',
        severity: 'high',
        ruleId: 'skill_zero_width_obfuscation',
        message: 'Обнаружены кластеры невидимых zero-width символов в инструкции навыка',
      })
    );
  }

  scanTextForSecrets(raw, filePath, 'skill', findings);

  for (const pat of PROMPT_INJECTION_PATTERNS) {
    const m = pat.rx.exec(raw);
    if (m) {
      findings.push(
        makeFinding({
          file: filePath,
          kind: 'skill',
          severity: pat.severity,
          ruleId: `skill_${pat.id}`,
          message: pat.label,
          excerpt: m[0],
        })
      );
    }
  }

  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const codePart = line.replace(/(?:^|\s)(?:#|\/\/).*$/, '');
    const pipeMatch = REMOTE_PIPE_RE.exec(codePart);
    if (pipeMatch) {
      const prefix = codePart.slice(0, pipeMatch.index);
      if (!/\b(?:never|do\s+not|block(?:ed)?|forbidden|avoid|запрещ)\b/i.test(prefix)) {
        findings.push(
          makeFinding({
            file: filePath,
            kind: 'skill',
            severity: 'high',
            ruleId: 'skill_remote_pipe_exec',
            message: 'Небезопасный пример/команда удалённого запуска через pipe (curl|sh / iwr|iex)',
            excerpt: line,
          })
        );
        break;
      }
    }
  }

  return findings;
}

function collectCandidateFiles({ workspaceRoot, geminiRoot, includeGlobal }) {
  const candidates = [];
  const seen = new Set();
  const addIfExists = (filePath, kind) => {
    if (!filePath || candidates.length >= MAX_SCAN_FILES) return;
    try {
      const abs = resolve(filePath);
      const key = process.platform === 'win32' ? abs.toLowerCase() : abs;
      if (seen.has(key)) return;
      if (existsSync(abs) && statSync(abs).isFile()) {
        seen.add(key);
        candidates.push({ path: abs, kind });
      }
    } catch {}
  };

  const addSkillsTree = (skillsDir) => {
    if (!skillsDir || !existsSync(skillsDir)) return;
    try {
      for (const ent of readdirSync(skillsDir, { withFileTypes: true })) {
        if (candidates.length >= MAX_SCAN_FILES) break;
        if (ent.isDirectory()) {
          addIfExists(join(skillsDir, ent.name, 'SKILL.md'), 'skill');
        }
      }
    } catch {}
  };

  if (workspaceRoot && existsSync(workspaceRoot)) {
    addIfExists(join(workspaceRoot, 'mcp_config.json'), 'mcp');
    addIfExists(join(workspaceRoot, '.mcp.json'), 'mcp');
    addIfExists(join(workspaceRoot, 'hooks.json'), 'hooks');
    addIfExists(join(workspaceRoot, 'SKILL.md'), 'skill');
    addSkillsTree(join(workspaceRoot, 'skills'));
    addSkillsTree(join(workspaceRoot, '.gemini', 'skills'));
    addSkillsTree(join(workspaceRoot, '.agents', 'skills'));
  }

  if (includeGlobal && geminiRoot && existsSync(geminiRoot)) {
    addIfExists(join(geminiRoot, 'antigravity', 'mcp_config.json'), 'mcp');
    addSkillsTree(join(geminiRoot, 'antigravity', 'skills'));
    addSkillsTree(join(geminiRoot, 'config', 'skills'));
    const pluginsDir = join(geminiRoot, 'config', 'plugins');
    if (existsSync(pluginsDir)) {
      try {
        for (const ent of readdirSync(pluginsDir, { withFileTypes: true })) {
          if (candidates.length >= MAX_SCAN_FILES) break;
          if (!ent.isDirectory()) continue;
          const pDir = join(pluginsDir, ent.name);
          addIfExists(join(pDir, 'mcp_config.json'), 'mcp');
          addIfExists(join(pDir, 'hooks.json'), 'hooks');
          addSkillsTree(join(pDir, 'skills'));
        }
      } catch {}
    }
  }

  return candidates;
}

/**
 * Runs a full offline security audit of the AI agent environment (MCP configs, hooks, and skills).
 * @param {object} [options={}]
 * @returns {{ ok: boolean, score: number, grade: string, scannedFiles: number, counts: object, findings: Array<object>, summaryRu: string }}
 */
export function auditAgentEnvironment(opts = {}) {
  const {
    workspaceRoot = process.cwd(),
    geminiRoot = join(homedir(), '.gemini'),
    includeGlobal = true,
  } = opts && typeof opts === 'object' && !Array.isArray(opts) ? opts : {};
  const candidates = collectCandidateFiles({ workspaceRoot, geminiRoot, includeGlobal });
  const findings = [];

  for (const item of candidates) {
    if (item.kind === 'mcp') {
      findings.push(...scanMcpConfigFile(item.path));
    } else if (item.kind === 'hooks') {
      findings.push(...scanHooksConfigFile(item.path));
    } else if (item.kind === 'skill') {
      findings.push(...scanSkillFile(item.path));
    }
  }

  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  let penalty = 0;
  for (const f of findings) {
    const sev = Object.hasOwn(SEVERITY_WEIGHTS, f.severity) ? f.severity : 'low';
    counts[sev]++;
    penalty += SEVERITY_WEIGHTS[sev];
  }

  const score = Math.max(0, Math.min(100, 100 - penalty));
  const grade = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 40 ? 'D' : 'F';
  const summaryRu =
    findings.length === 0
      ? `Оценка ${score}/100 (${grade}): проверено файлов ${candidates.length}, угроз не обнаружено`
      : `Оценка ${score}/100 (${grade}): файлов ${candidates.length}, находок ${findings.length} (крит: ${counts.critical}, выс: ${counts.high}, сред: ${counts.medium})`;

  return {
    ok: true,
    score,
    grade,
    scannedFiles: candidates.length,
    counts,
    findings,
    summaryRu,
  };
}

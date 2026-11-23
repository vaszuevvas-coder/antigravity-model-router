# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 3.30.x  | Yes       |
| < 3.30  | No        |

## Reporting a Vulnerability

If you discover a security vulnerability in **The Tunnel (`antigravity-model-router`)**, please **do not** open a public issue with exploit details.

Instead, report it privately via **GitHub Security Advisories** (*Security* tab -> *Report a vulnerability*) or contact the maintainer directly with:

1. Affected component (`core/security-guard.mjs`, `sidecars/panel/server.mjs`, `core/ram-memory-mcp.mjs`, `install.js`, or a specific skill script).
2. Clear reproduction steps or a minimal proof of concept.
3. Expected vs. actual security impact.

We aim to acknowledge reports within **72 hours** and ship a fix as quickly as possible for supported releases.

## Security Architecture & Local-Only Guarantees

- **Local-only runtime:** The sidecar control panel (`sidecars/panel/server.mjs`), RAM-Memory MCP server (`core/ram-memory-mcp.mjs`), and optional Ollama GPU bridge (`http://127.0.0.1:11434`) bind exclusively to loopback (`127.0.0.1`) and do not transmit telemetry or source code to external servers.
- **Sidecar authentication:** Mutating sidecar endpoints validate loopback origin/host headers and per-session tokens.
- **Secret redaction & `.agentignore`:** `core/security-guard.mjs` and `core/obs-masker.mjs` redact common credential patterns before logs, CCR archives, or checkpoints are persisted, and respect `.agentignore` / `.env` protections.
- **Zero-dependency core:** Runtime modules rely only on Node.js built-ins (`node:>=22.0.0`) to minimize supply-chain exposure.
- **Safe release template:** `./router-state.json` in the repository is a sanitized default template; personal runtime settings live outside the repository in `~/.gemini/config/plugins/antigravity-model-router/router-state.json`.

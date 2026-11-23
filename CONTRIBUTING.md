# Contributing to The Tunnel (`antigravity-model-router`)

Thank you for your interest in contributing to **The Tunnel**!

## Development Setup

1. **Requirements:** Node.js `>=22.0.0` (ESM, zero external runtime dependencies).
2. **Clone & Test:**
   ```bash
   git clone https://github.com/vaszuevvas-coder/antigravity-model-router.git
   cd antigravity-model-router
   npm test
   npm run lint:skills
   ```
3. **Sync Local Plugin Install (optional):**
   ```bash
   node install.js
   ```
   `install.js` safely preserves your existing `~/.gemini/config/plugins/antigravity-model-router/router-state.json`.

## Guidelines

- Keep `core/` modules **zero-dependency** (Node.js built-ins only).
- Never commit personal paths, API keys, tokens, or live `router-state.json` files; the repository root `router-state.json` is a sanitized release template.
- Add or update tests in `tests/*.test.mjs` for any behavioral changes and ensure `npm test` passes.
- If modifying built-in skills under `skills/`, verify with `npm run lint:skills`.
- Follow the [Code of Conduct](CODE_OF_CONDUCT.md) and report security issues privately per [SECURITY.md](SECURITY.md).

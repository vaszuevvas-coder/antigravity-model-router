---
name: github-publish-guard
description: Deterministic pre-publish GitHub privacy, compliance, and release-accuracy auditor (scripts/audit-github-publish.mjs). Use when pushing code, syncing repositories, tagging releases, or verifying no local machine paths, secrets, GitHub policy violations, or stale metadata leak to GitHub.
---

# GitHub Publish Guard

Run deterministic zero-token pre-publish verification before committing, pushing, tagging, or publishing GitHub releases on any repository.

## 1. Pre-Publish Audit CLI

```bash
# Full repository audit (fingerprints, secrets, GitHub rules, docs & version parity)
node "<skill_dir>/scripts/audit-github-publish.mjs" --root "<repo_dir>"

# Audit only staged files before git commit
node "<skill_dir>/scripts/audit-github-publish.mjs" --root "<repo_dir>" --staged

# Include remote GitHub sync & release parity checks (origin/main, tags, gh releases)
node "<skill_dir>/scripts/audit-github-publish.mjs" --root "<repo_dir>" --remote

# Escalate warnings to blocking errors (recommended before public tags/releases)
node "<skill_dir>/scripts/audit-github-publish.mjs" --root "<repo_dir>" --remote --strict --json
```

## 2. Three Mandatory Audit Gates

1. **Privacy & Machine Fingerprints**:
   - Rejects absolute local home paths (`C:\Users\<name>`, `/Users/<name>`, `/home/<name>`), active OS usernames, machine hostnames, private LAN IPs, unredacted credentials/tokens/private keys, and personal overrides in template configs (`router-state.json` with `hardwareProfiled: true`, `gpuModelsDir`, or personal paths) because leaked machine fingerprints and secrets persist permanently in public git history.
2. **GitHub Rules & Repository Hygiene**:
   - Enforces GitHub blob limits (`>50 MB` warning, `>100 MB` hard block), flags tracked secret/cache/OS junk files (`.env`, `*.pem`, `*.key`, `node_modules/`, `.cache/`, `scratch/`, `.DS_Store`, `Thumbs.db`), and verifies `LICENSE`, `README.md`, and `.gitignore` presence because oversized files reject pushes and missing legal/ignore files risk policy or licensing issues.
3. **Metadata & Documentation Parity**:
   - Verifies version consistency across `package.json`, `plugin.json`, `README.md`, `CHANGELOG.md`, `assets/banner.svg`, and `release-manifest.json`, checks relative Markdown links exist on disk, compares documented skill/test counts against actual repository counts, and (with `--remote`) verifies `origin` sync and GitHub Release tag alignment because stale docs and broken links degrade trust and break installers.

## 3. Publish Workflow & Verification Gate

1. Run `audit-github-publish.mjs --root "<repo_dir>"` before `git commit`, `git push`, or `gh release create`.
2. Resolve every `error` finding (exit code `1`) before pushing; review `warn` findings or run `--strict` for public releases.
3. Never run `git push`, `git push --tags`, or `gh release create` without explicit user intent, and never use `--force` or skip failed privacy/secret checks.
4. After pushing a release, re-run with `--remote` to confirm `origin/main` and GitHub Releases reflect the exact published version and metadata.

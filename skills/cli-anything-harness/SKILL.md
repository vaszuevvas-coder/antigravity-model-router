---
name: cli-anything-harness
description: Builds, probes, and validates agent-native --json CLI harnesses for desktop GUI software or internal apps, and discovers scoped CLI-Hub Workflow Matrices via preflight. Use when wrapping Blender, GIMP, OBS, LibreOffice, or local tools into scriptable CLIs instead of brittle GUI clicking.
---

# CLI-Anything Harness & Workflow Matrix Protocol

Turn GUI-first desktop applications or internal services into reliable, stateful `--json` command-line interfaces instead of fragile screenshot/coordinate clicking.

## 1. Zero-Token Probe & Contract Validation CLI

```bash
# Inspect an app codebase to map backend engines, file formats, and existing CLI entrypoints
node "<skill_dir>/scripts/scaffold-cli-harness.mjs" --probe "<app_or_repo_dir>" --json

# Validate a generated CLI harness against the agent-native contract (--json, exit codes, help, tests)
node "<skill_dir>/scripts/scaffold-cli-harness.mjs" --validate "<harness_dir>" --json
```

## 2. Scoped CLI-Hub Discovery (`preflight` Before Install)
When automating established desktop apps (Blender, GIMP, OBS, LibreOffice, Krita, Godot, Shotcut, Zotero), check published harnesses before writing a new one:
- Run `cli-hub search <keyword>` or `cli-hub can "<capability>"` to find existing wrappers.
- For multi-tool creative/media pipelines, inspect Workflow Matrices (`cli-hub matrix preflight <matrix> --json`) and install **only** the required capability (`--capability <id>` or `--dry-run`) rather than bulk-installing an entire matrix.

## 3. 7-Phase GUI-to-CLI Build SOP (Custom Harnesses)
When no published wrapper exists, build a thin real-backend harness (never mock the engine):
1. **Analyze**: Map the real backend library/CLI (`bpy`, `ffmpeg`, `melt`, headless binary), project file format (XML/JSON/SQLite), and command/undo model.
2. **Design**: Expose both one-shot subcommands (for pipelines) and optional stateful session files (for multi-step workflows) with deterministic `--json` output and exit codes (`0` ok, `1` runtime error, `2` usage error, `3` partial/preflight gap).
3. **Implement Data & Probe Layer**: Add read-only `info`/`probe`/`list` commands first so agents inspect state before mutating.
4. **Implement Mutations**: One subcommand per logical domain operation with atomic saves and strict input validation.
5. **Real Backend Bridge**: Invoke the native headless engine directly with explicit timeouts and structured stderr capture.
6. **Verify**: Run automated unit + end-to-end tests exercising `--json` stdout parity and non-zero error contracts, then run `--validate`.
7. **Package**: Ship a concise consumer `SKILL.md` documenting commands, flags, and exit codes.

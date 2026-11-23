---
name: binary-app-localizer
description: Binary and desktop app localization engineering for Electron ASAR bundles, JSON/XML resources, Resolume/IDE UI, and console ROM/ISO string & font tables. Use when translating app interfaces, repacking ASAR archives, or patching binary strings safely.
---

# Binary App Localizer

## 1. Safety & Token Integrity
- **Backup & Verification**: Create `<file>.bak` and compute SHA-256 before patching so broken builds roll back cleanly.
- **Placeholder Integrity**: Preserve format tokens (`%s`, `%d`, `{0}`, `{{var}}`, `\n`, `\r\n`, HTML/XML tags) and internal enum/config keys; translate display strings only so runtime parsing never breaks.

## 2. Electron, Native Apps & ROM Bundles
- **ASAR & Workbench**: Unpack/repack `app.asar` or patch bundle scripts (`workbench.desktop.main.js`, `nls.messages.json`) via AST/regex key mapping, preserving UTF-8 BOM status, line endings (`CRLF`/`LF`), and `product.json` checksums.
- **Native XML / Binary Strings**: Locate strings in `Locale/`, `.xml`, `.po`, `.qm`, or binary tables; Cyrillic UTF-8 takes 2 bytes/char vs 1-byte ASCII, so never overflow fixed C-string buffers or truncate `\0` without updating pointer offset tables.
- **Console ROM / PSP ISO**: Preserve hardcoded sector LBA offsets (or regenerate TOC cleanly) and verify target bitmap/PGF font atlases include Cyrillic glyphs before remapping charsets.

## Learned Patterns & Verified Recipes
- **[Invariant]** Keep Russian translations within <=1.15x length of English strings in compact UI controls (e.g. Resolume Envelope, layer inspectors, toolbars) or use concise abbreviations so text never overlaps gear/settings icons.
- **[Invariant]** After app updates (Electron/Antigravity), never restore old .bak bundles from a previous version; run idempotent key/AST patchers over the fresh build files and recalculate product.json checksums.
- **[Recipe]** When building Windows localizer installers, auto-detect target app path via Registry/Program Files, verify admin permissions, and provide a 1-click backup rollback option.

---
name: ast-codemod-refactor
description: Deterministic multi-file AST and regex refactoring via scripts/run-codemod.mjs with snapshot backup and syntax rollback. Use when renaming symbols, migrating imports, or rewriting call signatures across 3+ files without looping edit_file.
---

# AST Codemod Refactor (Codemod-Over-Edit)

Execute mechanical multi-file edits (symbol renames, import migrations, parameter updates across 3+ files) via a single codemod invocation instead of looping `edit_file`, because sequential edits waste round-trips and risk partial syntax drift.

## CLI Usage

```bash
node "<skill_dir>/scripts/run-codemod.mjs" <rootDir> --find "<pattern>" --replace "<replacement>" [options]
```

- `--find <pattern>` / `--replace <str>`: Target literal or regex pattern and replacement (supports `$1`, `$2` under `--regex`).
- `--regex`: Treat `--find` as regular expression.
- `--word`: Enforce `\b<pattern>\b` word boundaries.
- `--ext <list>`: Comma-separated extensions (default `.mjs,.js,.ts,.tsx,.jsx,.json,.md`).
- `--dry-run`: Preview matches and file counts without disk mutation.

## Safety & Verification
- Ignores `node_modules`, `.git`, `.cache`, `dist`, `build`, `.antigravity` automatically.
- Writes atomic rollback snapshot to `.cache/codemod-backup.json` before touching files.
- Runs `verifyContentSyntax` on modified `.js`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.jsx`, and `.json` files; restores any failing file immediately.

## Programmatic API

```javascript
import { runCodemod } from './scripts/run-codemod.mjs';

const res = runCodemod({ rootDir: process.cwd(), find: 'oldSymbol', replace: 'newSymbol', wordBoundary: true, dryRun: false });
console.log(res.modifiedFiles, res.syntaxVerified);
```

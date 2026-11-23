---
name: program-slicer-ocd
description: Backward and forward data-flow program slicing via scripts/slice-variable.mjs (6-10x context compression). Use when tracing variable declarations, mutations, branches, or return paths inside source files >150 lines.
---

# Program Slicer OCD (Data-Flow Code Distillation)

Extract backward and forward data-flow slices for a symbol in files `>150` lines instead of reading full files, preventing context bloat and attention drift.

## CLI Usage

```bash
node "<skill_dir>/scripts/slice-variable.mjs" <filePath> <symbolName> [focusLine]
```

- `<filePath>`: Absolute or workspace-relative path.
- `<symbolName>`: Identifier, variable, or property name to slice.
- `[focusLine]`: Optional crash/defect line to anchor the slice window.

## Slicing Roles & Workflow
Annotated tags classify data flow: `[scope]` enclosing signature, `[decl]` declaration, `[mutate]` assignment/mutation, `[branch]` control guard, `[return]` output yield, `[use]` reads/calls.
1. Run `slice-variable.mjs` (or `ram_slice` with `symbol`) to distill flow into `<=60` lines (`6-10x` reduction).
2. Read only the flagged `StartLine..EndLine` (`±10` lines), apply `edit_file`, and verify affected tests.

## Programmatic API

```javascript
import { extractVariableSlice, sliceSourceCode } from './scripts/slice-variable.mjs';

const res = extractVariableSlice('core/swarm-controller.mjs', 'swarm');
console.log(res.formatted);
```

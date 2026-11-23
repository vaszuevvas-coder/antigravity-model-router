---
name: delta-bug-minimizer
description: Automated binary-search input minimization (ddmin via scripts/ddmin-runner.mjs) and 5-field Elephant-Goldfish subagent state handoff. Use when shrinking flaky or large failing inputs to a minimal reproducer.
---

# Delta Bug Minimizer & SSSM State Handoff

Isolate minimal failing inputs via binary delta debugging and enforce noise-free handoffs between scout and editor agents.

## 1. Delta Debugging (`ddmin`)
Shrink failing configs, logs, or inputs to 1–3 reproducing lines before editing, because guessing on large payloads wastes attempts:
```bash
node "<skill_dir>/scripts/ddmin-runner.mjs" --input <failing_file> --cmd "<test_command_with_{FILE}>"
node "<skill_dir>/scripts/ddmin-runner.mjs" --self-test
```
- Splits chunks into subsets/complements (`n = 2..N`), runs `<cmd>` replacing `{FILE}` with each candidate slice, and stops at 1-minimal failing delta.

## 2. Elephant & Goldfish Handoff (`SSSM 2026`)
Separate exploration noise from code edits:
`[Scout: Goldfish (flash_lite) reads logs/grep -> emits 5-field card & exits] -> [Editor: Elephant (native Hydrogen/Orchestrator, or Model:"inherit" Workspace:"share") applies targeted patch]`
- Never downgrade edits to `flash` on Gemini 4 because surgical edits require full reasoning fidelity.

```json
{
  "rootCause": "file:L#",
  "invariant": "Contract/behavior that must not break",
  "minimalRepro": "Short command or single input value",
  "rejectedDeadEnds": ["Failed attempt 1", "Invalid assumption 2"],
  "patchSpec": "file:L#-L# -> exact modification"
}
```

## 3. Programmatic API & Verification
```javascript
import { minimizeChunks, formatElephantGoldfishCard } from './scripts/ddmin-runner.mjs';

const cardText = formatElephantGoldfishCard({
  rootCause: 'core/session-handoff.mjs:L196',
  invariant: 'Preserve touchedFiles deduplication',
  minimalRepro: 'node --test tests/router-core.test.mjs',
  rejectedDeadEnds: ['Full-overwrite state file'],
  patchSpec: 'core/session-handoff.mjs:L195-L210 -> append rationales'
});
```
Run `--self-test` or the `minimalRepro` test command after patching to verify the minimal reproducer passes.

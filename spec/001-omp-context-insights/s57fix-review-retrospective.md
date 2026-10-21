# S5.7 remediation review retrospective

## Round outcomes

| Round | Verdict | Finding class | Concrete finding |
| --- | --- | --- | --- |
| 1 | FAIL | ast_edit identity + capture boundary | Duplicate normalized paths and directory/glob selectors overcounted; `beforeModelCall` ran before provider conversion/transforms. |
| 2 | FAIL | selector reconciliation + duplicate capture | Two resolved calls sharing a selector kept a phantom step path; prompt-time capture plus final-bound capture produced two entries for one request. |
| 3 | FAIL | unresolved shared-selector ownership | The fix cleared a selector from `step.filePaths` even when a second, unresolved call still owned it, desynchronizing step paths from aggregate activity. |

## Why each round fixed one instance only

- The ast_edit code now has two identities per call: provisional requested targets and concrete result files. Reconciliation was implemented as "remove every non-actual requested path", which is correct only when no unresolved call still owns that selector.
- The capture layer had two producers (prompt-time pending + final provider hook). Removing the stale producer exposed a remaining ordering issue, then the final hook fixed exact counts.
- Tests covered resolved-only and unresolved-only cases, but not the mixed ownership state.

## Systemic fixes

1. Selector removal is conditional on no unresolved call in the same step still owning the normalized path; resolved calls clear their `paths` after reconciliation.
2. Capture exists only at `afterProviderContext`, after conversion/normalization/`transformProviderContext`; prompt-time capture was deleted.
3. Regression tests cover duplicate spellings, shared resolved selectors, one-resolved/one-unresolved ownership, transformed context parity, and live PTY/Web six→seven.

## Review-brief correction

Any reconciliation between provisional and final identities must test the mixed state (some owners resolved, some unresolved), not only all-resolved or all-unresolved. Capture code must have exactly one producer; tests must count captures, not only final snapshots.

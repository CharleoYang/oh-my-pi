# T-05 review retrospective (3-round quota)

## Round outcomes

| Round | Verdict | Finding class | Concrete finding |
| --- | --- | --- | --- |
| 1 | FAIL | Freshness identity + truncated aggregate | Child freshness key erased `.jsonl` vs `.jsonl.gz`, so a same-mtime compression hit the stale trace memo. Fleet `costTotal` summed only returned steps, understating cost past the 1,000-step cap. |
| 2 | FAIL | Step eligibility reimplemented | `branchCost` treated explicit `contextTokens=0` with non-zero input as eligible; the shared fold floors `contextTokens` and skips the step, overcounting cost (8 vs 1). |
| 3 | FAIL | Same class at raw-token normalization | The predicate still compared raw values. `contextTokens=0.5` was eligible in the adapter but floored to 0 by the fold; mixed negative input/cache fields were eligible in the fold but rejected by the adapter. Differential fuzz: 39/65 mismatches, including a 2,205-entry transcript (4,657 vs 3,958). |

## Why each round fixed one instance only

- The adapter owned a second implementation of the fold's step-eligibility and token-normalization rules. Each fix refined that duplicate predicate against the last counterexample instead of removing the duplicate. The invariant is "fleet cost is the sum over exactly the fold's eligible steps"; any independent predicate will drift.
- Round 1 also merged two unrelated classes (freshness identity and aggregate truncation) into one patch. The freshness fix was correct; the aggregate fix reused the wrong accounting pass.
- Tests used hand-picked usage shapes. They did not include fractional/negative/duplicate/snapshot combinations until round 3's differential fuzz.

## Systemic fix in this revision

1. `foldContextTimeline` now accumulates `costTotal` and `peakTokensTotal` over **all eligible steps before `maxSteps` truncation** and returns them on `ContextTimeline`. This is one accounting pass, shared by TUI, journal, and fleet. The post-retrospective gate caught the same truncation class in `peakTokens`; the fix is the same aggregate-before-slice invariant.
2. The adapter deletes `branchCost` entirely and reads `timeline.costTotal`; there is no second eligibility predicate to drift.
3. Regression tests cover the 1,001-step cap, `contextTokens=0`, fractional values, mixed negative input/cache fields, duplicate IDs, snapshots, and a differential comparison against the fold oracle.
4. Freshness keys preserve the filename suffix per directory (`Scout.jsonl` vs `Scout.jsonl.gz`) while keeping the stem-based `trackId` unchanged.

## Review-brief correction

Any derived aggregate must be computed by the same pass as its source, not by a parallel predicate. Reviews must include a differential fuzz matrix against the authoritative fold for usage shapes (fractional, negative, duplicate, snapshot, >cap), not only hand-picked cases. Mixed finding classes must be split into separate patches with separate counterexamples.

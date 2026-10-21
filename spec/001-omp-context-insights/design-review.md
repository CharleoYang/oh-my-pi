# S2 design review — Round 3

**Verdict: pass. Open blocking findings: 0.** All eight round-1 findings and the round-2 legacy regression are resolved in the current design contract. This is a design-review verdict, not implementation approval, a test-pass claim, or authorization to install the binary.

Reviewer: DesignReview (independent subagent, not Main).

## Scope and evidence

Checked the final edits directly in FEATURE, interface, design, class-diagram fields and DECISIONS, including all four round-2 open findings and retained integration seams. Production citation evidence from prior rounds remains the baseline; in particular, the source null-leaf rule at `packages/coding-agent/src/session/session-entries.ts:361–367` was re-read in round 2 and is accurately mirrored now. The scoped git diff returned no output, so this verdict concerns the explicitly named current S2 documents, not an implementation patch.

Optional repository validator tests: **0 executed**. Product tests, built CLI, browser and PTY runs: **0 executed**. No runtime or validator pass is claimed. Only this report was written; review archives, product code, tests, feature state and installed binary were not modified. No user services were started, stopped or signaled.

## Findings and final dispositions

The historical severity is retained for traceability. Every finding below is marked fixed because the current document contains its correction; fixed does not mean implementation has landed.

### B1 — Historical details survive the response boundary

Anchor: `spec/001-omp-context-insights/[接口文档] context-insights.md:103`. Severity: blocking. Disposition: fixed.

ContextStep.details remains an explicit ContextStepDetails projection; interface 46–57 contains tool/skill/system-part counts and message counters. Design 260 budgets the projection newest-first after step truncation, while composition remains independently available. The HTTP response is ContextTimeline (interface 491), and the class diagram retains the projection. Fixed in design, not a claim of implemented functionality.

### B2 — Interactive reports have explicit focus and dispatch ownership

Anchor: `spec/001-omp-context-insights/[接口文档] context-insights.md:419`. Severity: blocking. Disposition: fixed.

Interface 419–423 still requires interactive:true, focused overlay presentation in native and ANSI modes, forwarding of otherwise-unhandled keys/native events, and host-level tests. Esc and scroll remain panel-owned. This addresses the production ReportPanel boundary identified in round 1 rather than assuming a new body receives keys automatically.

### B3 — Null active leaves are distinct from dangling leaves

Anchor: `spec/001-omp-context-insights/[设计文档] context-insights.md:472`. Severity: blocking. Disposition: fixed.

The boundary row now says activeLeafId=null yields an empty branch; only a dangling leaf uses newest-self-selected fallback. This agrees with design 322–324, interface 495 and DECISIONS D11 (line 15). Production packages/coding-agent/src/session/session-entries.ts:361–367 was checked in round 2: its null early return and subsequent fallback support this exact distinction. T-01 at design 495 separately names null→empty and dangling→fallback.

### B4 — Events share one file-order association rule

Anchor: `spec/001-omp-context-insights/[设计文档] context-insights.md:259`. Severity: blocking. Disposition: fixed.

Design 218 and 259 retain next-step association by file order, undefined for trailing events and absolute indices for omitted targets. step.eventIds uses the same rule; timestamp rollback cannot produce a second association. No reintroduction of the previous timestamp-based rule was found.

### B5 — Response caps and Browser budget agree with AC-07

Anchor: `spec/001-omp-context-insights/[接口文档] context-insights.md:254`. Severity: blocking. Disposition: fixed.

The default block retains 1000 steps, 200 events, 500 files and 500 Browser entries. Design 260 and 357–359 define whole-step details omission and counters. Interface 425 explicitly assigns TUI maxBrowserEntries=0. Composition does not consume this Browser budget and is not removed by it.

### B6 — Signed remainder remains authoritative

Anchor: `spec/001-omp-context-insights/FEATURE.md:84`. Severity: blocking. Disposition: fixed.

FEATURE decision 4, AC-01, interface 101–105 and DECISIONS D8 consistently preserve category estimates and expose signed unattributed without redistribution. compositionEstimated marks modern estimated composition; FEATURE AC-05 now distinguishes this from legacy composition unavailable.

### B7 — Capped overview rows conserve request and prompt totals

Anchor: `spec/001-omp-context-insights/FEATURE.md:72`. Severity: blocking. Disposition: fixed.

AC-04 now explicitly requires heatmap totals = returned session rows + omitted aggregates for both requests and promptTokens, over a range-scoped window. ContextSessionRow.promptTokens is present at interface 452; omittedRequests/omittedPromptTokens are present at 474–475. Interface 479–481, design 432–434 and DECISIONS D13 agree on the same cutoff and 200-row cap. The 201-single-request-root counterexample now has a defined result: 201 = 200 + 1. Metadata-only listSessionSummaries reuse still avoids lifetime counter contamination.

### B8 — Merged-part counts and zero-weight normalization have explicit formulas

Anchor: `spec/001-omp-context-insights/[接口文档] context-insights.md:323`. Severity: blocking. Disposition: fixed.

Interface 323, design 125/233 and DECISIONS D14 define systemPromptPartsOmitted as extra absorbed parts, originalCount-returnedCount. Thus 21 original parts at cap 20 produces omitted=1 and a final entry representing two originals. Interface 325 and design 124 explicitly restrict exact-sum invariants to positive weight sums and exempt the stated all-zero empty-item result. The class diagram carries the same numeric field without an alternative formula. The short type comments at interface 39/design 100 remain less precise than the prose, but the explicit formula and worked example now remove the prior competing interpretation; this is not an outstanding blocker.

### R2-1 — Legacy counts depend on source snapshots rather than response omission

Anchor: `spec/001-omp-context-insights/[设计文档] context-insights.md:263`. Severity: blocking. Disposition: fixed.

The return algorithm now counts only returned steps whose source lacks ContextSnapshotDetails/composition. Interface 183, design 213 and DECISIONS D15 agree: response budget omission increments detailsOmittedSteps, never legacySteps. For a modern-only TUI window with maxBrowserEntries=0, details are suppressed, composition remains, legacySteps=0 and the omission/truncated flags report the intentional projection loss. T-03 at design 497 explicitly includes this regression case.

## Cross-contract checks

- **Composition/details/legacy:** source composition remains available independently of Browser allocation. Whole-step newest-first budgeting occurs only within the returned steps window. TUI zero budget intentionally omits details; detailsOmittedSteps and truncated communicate that omission without falsely marking modern steps legacy.
- **Replay and fleet freshness:** null and dangling cases now agree across the detailed algorithm, boundary table, interface and decisions. The gzip-aware recursive discovery contract uses the same root/child set for fleet and ETag; sorting and raced/missing-child invalidation remain explicit.
- **Overview conservation:** row prompt totals and omitted request/prompt totals allow both acceptance equations to hold after the 200-root cap. The heatmap is range-scoped rather than a separate fixed seven-day window. Implementation tests should exercise >200 roots to cross the actual cap; the T-04 matrix shorthand >100 roots does not itself prove that boundary, whereas AC-04 explicitly requires truncated coverage.
- **System parts:** the extra-absorbed-count formula gives a recoverable last-row span: with last returned index i and omitted k, that row represents original indices i through i+k. The short type comment is not a second numeric rule. All-zero item weights are now a declared exception to exact sums, not an impossible invariant.
- **Report routing:** focus, forwarding and Esc/scroll ownership remain explicitly assigned to the host, with native and ANSI host tests required. Actual key handling must be demonstrated during implementation; the design now provides the necessary integration contract.
- **RL-08:** design section 8.4 retains negative mutation controls for missing sections, fake verdicts, self-review and open blockers, and section 8.3 requires independent fixture oracles. These are falsifiable plans; they have not been executed by this reviewer.
- **RL-09:** the single record below names a non-main reviewer and an ISO UTC timestamp. All historical blocking findings have disposition fixed, so zero unresolved blockers permits pass. No new blocking contradiction was found in the reviewed final edits.

## Machine-readable review record

```json
{
  "reviewer": "DesignReview",
  "reviewed_at": "2026-10-21T07:48:55.975711+00:00",
  "verdict": "pass",
  "findings": [
    {
      "severity": "blocking",
      "file": "spec/001-omp-context-insights/[接口文档] context-insights.md",
      "line": 103,
      "summary": "B1: Historical details survive the response boundary",
      "disposition": "fixed"
    },
    {
      "severity": "blocking",
      "file": "spec/001-omp-context-insights/[接口文档] context-insights.md",
      "line": 419,
      "summary": "B2: Interactive reports have explicit focus and dispatch ownership",
      "disposition": "fixed"
    },
    {
      "severity": "blocking",
      "file": "spec/001-omp-context-insights/[设计文档] context-insights.md",
      "line": 472,
      "summary": "B3: Null active leaves are distinct from dangling leaves",
      "disposition": "fixed"
    },
    {
      "severity": "blocking",
      "file": "spec/001-omp-context-insights/[设计文档] context-insights.md",
      "line": 259,
      "summary": "B4: Events share one file-order association rule",
      "disposition": "fixed"
    },
    {
      "severity": "blocking",
      "file": "spec/001-omp-context-insights/[接口文档] context-insights.md",
      "line": 254,
      "summary": "B5: Response caps and Browser budget agree with AC-07",
      "disposition": "fixed"
    },
    {
      "severity": "blocking",
      "file": "spec/001-omp-context-insights/FEATURE.md",
      "line": 84,
      "summary": "B6: Signed remainder remains authoritative",
      "disposition": "fixed"
    },
    {
      "severity": "blocking",
      "file": "spec/001-omp-context-insights/FEATURE.md",
      "line": 72,
      "summary": "B7: Capped overview rows conserve request and prompt totals",
      "disposition": "fixed"
    },
    {
      "severity": "blocking",
      "file": "spec/001-omp-context-insights/[接口文档] context-insights.md",
      "line": 323,
      "summary": "B8: Merged-part counts and zero-weight normalization have explicit formulas",
      "disposition": "fixed"
    },
    {
      "severity": "blocking",
      "file": "spec/001-omp-context-insights/[设计文档] context-insights.md",
      "line": 263,
      "summary": "R2-1: Legacy counts depend on source snapshots rather than response omission",
      "disposition": "fixed"
    }
  ]
}
```

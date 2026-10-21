# S2 design review — Round 2

**Verdict: fail. Open blocking findings: 4.** Five round-1 findings are fixed in the current design text; three remain partially unresolved, and one new budget/legacy contradiction is introduced. Reviewer: DesignReview, independent of Main.

## Scope and execution evidence

Re-read the current design, interface, class diagram, FEATURE acceptance/decision sections, DECISIONS and context-report; checked each round-1 finding against current text rather than the author summary. Re-read the production null-leaf implementation at `packages/coding-agent/src/session/session-entries.ts:344–368`; it confirms that null clears the branch, rather than selecting fallback. Prior production integration evidence remains applicable. The scoped git diff returned no output; this review is of the named frozen documents, not a claimed code patch.

Optional validator tests: **0 executed**. Product tests, CLI, browser and PTY runs: **0 executed**. No runtime success is claimed. No services or installed binary were touched. Only this report was written; round-1 archive and feature state remain unchanged.

## Findings and round-1 dispositions

### B1 — Carry historical drill-down through the timeline (fixed)

Anchor: `spec/001-omp-context-insights/[接口文档] context-insights.md:103`. Severity: blocking. Disposition: fixed.

Verified fixed in the design: ContextStepDetails at interface 46–57 contains the persisted counters and named arrays; ContextStep.details at 103 carries it, and the HTTP response at 490 remains ContextTimeline. Design 260 allocates a response-wide budget newest-first without altering composition; design 443–445 distinguishes legacy from budget omission. The class diagram now has the projection edge. This records a design fix, not an implemented feature.

### B2 — Specify interactive report focus and key forwarding (fixed)

Anchor: `spec/001-omp-context-insights/[接口文档] context-insights.md:419`. Severity: blocking. Disposition: fixed.

Verified fixed in the design: interface 419–423 and design 370–377 explicitly add interactive:true, force a focused overlay even when ANSI content fits, forward unhandled keyboard/native events, retain panel-owned Esc/scroll, and require host-level tests. These address the ReportPanel consumer routing previously inspected. The component keyboard table describes user-visible scrolling; the host contract now explicitly owns its dispatch.

### B3 — Keep null active leaves empty in every replay rule (open)

Anchor: `spec/001-omp-context-insights/[设计文档] context-insights.md:472`. Severity: blocking. Disposition: open.

Partially fixed, but the boundary table at design 472 explicitly sends activeLeafId=null AND dangling leaves through newest-self-selected fallback. Section 4.6 at 322–324 instead returns empty for null, and current production packages/coding-agent/src/session/session-entries.ts:361–367 returns null before fallback (re-read for this review). With an earlier assistant A followed by an off-branch entry capturing activeLeafId:null, the table resurrects A while live and section 4.6 return an empty branch. Remove null from the fallback case and assert the same empty result in both adapters. The new interface field and rejection of trace.activeChain are otherwise correct.

### B4 — Use one file-order event association (fixed)

Anchor: `spec/001-omp-context-insights/[设计文档] context-insights.md:218`. Severity: blocking. Disposition: fixed.

Verified fixed in the design: sections 3.3 and 4.2 (218,258–261) now use file order, next-step association, undefined for trailing events and absolute indices for targets outside the returned window. Both eventIds and stepIndex derive from the same rule; timestamps only display. Clock rollback no longer selects a second target. The independent event cap remains intentional; implementations should avoid treating a missing capped event object as a missing journal event.

### B5 — Align response caps with AC-07 (fixed)

Anchor: `spec/001-omp-context-insights/[接口文档] context-insights.md:259`. Severity: blocking. Disposition: fixed.

Verified fixed in the design: the DEFAULT_CONTEXT_LIMITS block defines maxSteps=1000, maxEvents=200, maxFiles=500 and maxBrowserEntries=500. Design 260 and 337–359 enforce a global named-entry budget after the step window, whole-step projection, omission counts and truncated. TUI explicitly uses maxBrowserEntries=0; retaining composition while omitting Browser details is intentional. The separate legacy-count regression is R2-1 below.

### B6 — Keep signed overshoot without redistribution (fixed)

Anchor: `spec/001-omp-context-insights/FEATURE.md:84`. Severity: blocking. Disposition: fixed.

Verified fixed in the design: FEATURE decision 4 now preserves the signed remainder, agrees with AC-01 and DECISIONS D8, and explicitly marks request-time estimates. ContextStep.compositionEstimated at interface 101 supplies the missing field. The 120-category/100-anchor case can now consistently preserve categories and return -20.

### B7 — Reconcile capped range rows with AC-04 conservation (open)

Anchor: `spec/001-omp-context-insights/[接口文档] context-insights.md:477`. Severity: blocking. Disposition: open.

The lifetime-counter defect is fixed: ContextSessionRow and cutoff SQL replace lifetime counters, and metadata-only reuse is explicit. However the revised response returns at most 200 roots (477) while KPI/heatmap cover the whole cutoff window (475), and unchanged FEATURE.md:72 still requires sum(heatmap.requests)==sum(session.requests). For 201 roots with one in-range request each, heatmap sums to 201 and returned rows to 200; omittedSessions=1 cannot supply the omitted request total. FEATURE still promises a 7-day heatmap while interface 452 and design 432 make it range-dependent. Amend the acceptance window/coverage contract explicitly: define equality over untruncated rows only, provide omitted aggregate counters or pagination, and align the heatmap requirement. Add a >200-root oracle, not merely the planned >100-root case.

### B8 — Make merged-part counts and zero-weight invariants consistent (open)

Anchor: `spec/001-omp-context-insights/[设计文档] context-insights.md:233`. Severity: blocking. Disposition: open.

The cap range [2,20], empty/single-part behavior, duplicate-name merge and zero-weight policy are now present. But systemPromptPartsOmitted is defined as the number of original parts merged into the final returned part (interface 39; design 125/233), while the explicit 21-part/cap-20 example merges original indices 19 and 20 and reports 1, not 2. Browser cannot derive parts[i..n] consistently from both definitions. Define the field as extra absorbed parts (originalCount-returnedCount), or change the example/formula to count all represented originals. Separately, interface 322 allows positive category totals with empty all-zero-weight arrays, but 325 still unconditionally promises exact equality when no entries were omitted. Qualify that invariant with the stated zero-weight exception and define its omission metadata. Otherwise the mandatory boundary fixtures admit contradictory expected values.

### R2-1 — Count legacy steps before dropping response details (open)

Anchor: `spec/001-omp-context-insights/[设计文档] context-insights.md:263`. Severity: blocking. Disposition: open.

New regression: design 260 deliberately clears step.details for budget-excluded steps, then 263 says legacySteps counts steps without details. Section 3.3 at 211 instead defines legacy by absent persisted ContextSnapshot.details/composition. TUI always uses maxBrowserEntries=0, so a new session whose snapshots all have composition would be labeled entirely legacy under the return algorithm; Overview at 400 renders History composition unavailable for N steps based on that counter. Count legacy from the source snapshot or composition, independently of response projection; only detailsOmittedSteps should count budget omissions. Add a modern-only fixture with maxBrowserEntries=0 asserting legacySteps=0, detailsOmittedSteps equal to returned modern steps, composition retained and truncated=true.

## Additional cross-contract checks

- **Details budget versus composition:** newest-first, whole-step projection and maxBrowserEntries=0 are now explicit; omission does not remove composition. detailsOmittedSteps applies within the returned step window, not to already omittedSteps. A budget suppression legitimately sets truncated; it must not imply legacy (R2-1).
- **Active replay versus ETag/fleet:** interface 493–494 and design 320–334 now require gzip-aware recursive discovery, the same root/descendant set for fingerprint and fleet, sorted paths, and treating races/missing children as changed. Leaf replay must be identical for root and child folds; B3 is the remaining null contradiction.
- **Report integration:** Esc/scroll precedence is explicit and host tests are required. Native events are forwarded to the body; the new component must then route them to its TabBar. This is an implementation obligation rather than a claim of already working UI.
- **Range aggregation:** DB approximation remains accurately labeled; no new table is needed for cutoff-filtered raw-message MAX/SUM/COUNT. Metadata-only listSessionSummaries reuse fixes the lifetime contamination. The new 200-root response cap and range heatmap need matching acceptance criteria (B7).
- **RL-08:** design 510–514 retains independent mutation controls for malformed verdicts, self-review, missing sections and open blockers. These plans can fail, but were not executed by this reviewer. Structural validators do not prove semantic agreement on the four counterexamples above.
- **RL-09:** exactly one JSON review record follows. Fixed means the current design actually contains the correction; it does not mean production implementation or tests exist. Four blocking findings are open, so the machine-readable verdict must remain fail.

## Machine-readable review record

```json
{
  "reviewer": "DesignReview",
  "reviewed_at": "2026-10-21T07:45:17.868808+00:00",
  "verdict": "fail",
  "findings": [
    {
      "severity": "blocking",
      "file": "spec/001-omp-context-insights/[接口文档] context-insights.md",
      "line": 103,
      "summary": "B1: Carry historical drill-down through the timeline",
      "disposition": "fixed"
    },
    {
      "severity": "blocking",
      "file": "spec/001-omp-context-insights/[接口文档] context-insights.md",
      "line": 419,
      "summary": "B2: Specify interactive report focus and key forwarding",
      "disposition": "fixed"
    },
    {
      "severity": "blocking",
      "file": "spec/001-omp-context-insights/[设计文档] context-insights.md",
      "line": 472,
      "summary": "B3: Keep null active leaves empty in every replay rule",
      "disposition": "open"
    },
    {
      "severity": "blocking",
      "file": "spec/001-omp-context-insights/[设计文档] context-insights.md",
      "line": 218,
      "summary": "B4: Use one file-order event association",
      "disposition": "fixed"
    },
    {
      "severity": "blocking",
      "file": "spec/001-omp-context-insights/[接口文档] context-insights.md",
      "line": 259,
      "summary": "B5: Align response caps with AC-07",
      "disposition": "fixed"
    },
    {
      "severity": "blocking",
      "file": "spec/001-omp-context-insights/FEATURE.md",
      "line": 84,
      "summary": "B6: Keep signed overshoot without redistribution",
      "disposition": "fixed"
    },
    {
      "severity": "blocking",
      "file": "spec/001-omp-context-insights/[接口文档] context-insights.md",
      "line": 477,
      "summary": "B7: Reconcile capped range rows with AC-04 conservation",
      "disposition": "open"
    },
    {
      "severity": "blocking",
      "file": "spec/001-omp-context-insights/[设计文档] context-insights.md",
      "line": 233,
      "summary": "B8: Make merged-part counts and zero-weight invariants consistent",
      "disposition": "open"
    },
    {
      "severity": "blocking",
      "file": "spec/001-omp-context-insights/[设计文档] context-insights.md",
      "line": 263,
      "summary": "R2-1: Count legacy steps before dropping response details",
      "disposition": "open"
    }
  ]
}
```

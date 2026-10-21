# S2 design review — FAIL

Reviewer: DesignReview (independent subagent, not Main).

**Verdict: fail. Eight blocking findings remain open.** The data contract loses Browser detail at the producer/consumer boundary, and the proposed report host does not dispatch interactive keys. No design, production, test, or feature-state file was changed.

## Scope and evidence

Read all six requested design-package documents and all thirteen minimum production files, plus ReportPanel and live branch replay implementations. The scoped git diff produced no output; this review covers the explicitly named current S2 documents, not a claimed implementation patch. Findings are anchored to those reviewed design lines. Production source citations were checked, not inferred from prose.

This assignment requests a design review, not execution of future S3/S5 implementation tests. Product tests, CLI runs, browser runs and PTY runs: **0 executed**. No installed binary was touched and no user service was started or signaled. Static conclusions below are not measured test outcomes.

## Blocking findings

### B1. Expose persisted drill-down details on each returned step

- Severity: blocking; disposition: open.
- Anchor: `spec/001-omp-context-insights/[接口文档] context-insights.md:83`.

The persisted schema contains toolSchemas, skills, systemPromptParts, messageCount and pendingMessageTokens (interface lines 27–41), but ContextStep (71–93) and ContextTimeline (138–159) expose only category totals. The fold copies only details.categories (design line 219); the HTTP response is exactly ContextTimeline (interface 427). Thus Composition/Browser cannot render their required historical named entries or message counters (design 387–389), even for new journals. The class diagram repeats this loss at lines 43–55. Add an explicitly bounded per-step details projection, including omission metadata, and carry it through fold and HTTP; test a selected non-latest step.

### B2. Route report input to the interactive context body

- Severity: blocking; disposition: open.
- Anchor: `spec/001-omp-context-insights/[设计文档] context-insights.md:322`.

The proposed host passes ContextInsightsView to unchanged showCommandReport. Production command-controller.ts:263–280 focuses ReportPanel in native/fullscreen modes and leaves focus with the editor for fitting ANSI reports. ReportPanel.handleInput (packages/tui/src/overlays/report-panel.ts:155–190) handles close/scroll and returns for every other key, never calling body.handleInput. Its native handler also handles only Close. Tab, 1–4, d and r therefore never reach the new component through this entry point. Define interactive-body input forwarding and focus ownership for both rendering modes, with host-level keyboard tests; component-only tests cannot catch this.

### B3. Match live active-leaf replay rather than copying trace activeChain

- Severity: blocking; disposition: open.
- Anchor: `spec/001-omp-context-insights/[设计文档] context-insights.md:287`.

The cited trace.ts:232–250 really does select the last physical id, but it is not equivalent to live replay. packages/coding-agent/src/session/session-entries.ts:344–367 honors activeLeafId, including null and dangling-leaf fallback; session-manager.ts:548–560 uses that behavior, and getBranchView at 3768–3769 reads that index. An off-branch late-usage entry can be physically last while selecting an earlier active leaf. The proposed journal algorithm then walks its parent chain instead of the live branch. ContextJournalEntry also omits activeLeafId (interface 191–213). Mirror current replay semantics and add off-branch/null/dangling-leaf parity fixtures before claiming AC-01.

### B4. Choose one event-to-step association rule

- Severity: blocking; disposition: open.
- Anchor: `spec/001-omp-context-insights/[设计文档] context-insights.md:228`.

The algorithm attaches eventIds by file-order intervals (design 222), then assigns event.stepIndex by timestamp (228), while ContextEvent describes events after the last step as undefined (147). Line 228 instead assigns those events to the last step. A trailing injection therefore has a last-step stepIndex but no reciprocal eventIds entry; clock rollback can similarly attach an event to two different steps. Specify one association rule, trailing-event behavior and truncation behavior, then derive both directions from it. This is required for Events-to-Trend navigation and the promised stable parity tests.

### B5. Reconcile API limits with the acceptance criteria

- Severity: blocking; disposition: open.
- Anchor: `spec/001-omp-context-insights/[接口文档] context-insights.md:227`.

DEFAULT_CONTEXT_LIMITS.maxEvents is 500 in both interface 227 and design 301, but FEATURE.md:75 requires events <= 200. A journal with 201 events is valid under the implementation contract and invalid under AC-07. The same acceptance criterion caps browser entries per API payload at 500, while the contract supplies only per-snapshot tool/skill caps and no response-wide browser limit. Resolve the limits and define omitted/truncated accounting before writing boundary fixtures.

### B6. Remove the contradictory overshoot redistribution decision

- Severity: blocking; disposition: open.
- Anchor: `spec/001-omp-context-insights/FEATURE.md:84`.

FEATURE.md:84 requires proportionally shrinking categories when they exceed the provider anchor and marking estimated. FEATURE.md:69 (AC-01), design 185–186, interface 85–86 and DECISIONS.md:12 instead require a signed remainder without redistribution. For categories totaling 120 and promptTokens 100, these mandate different outputs (rescaled 100 versus unchanged 120 with -20). The interface has no estimated field either. Make the frozen acceptance and decision text agree with D8 and include this concrete negative-remainder oracle.

### B7. Do not reuse lifetime session counters as range aggregates

- Severity: blocking; disposition: open.
- Anchor: `spec/001-omp-context-insights/[接口文档] context-insights.md:415`.

The interface says session rows follow range (413) and reuse listSessionSummaries (415). That production function (packages/stats/src/trace.ts:1145–1240) has only limit/q parameters, folds lifetime rollups, adds disk-only roots, and defaults to 100 rows; it has no cutoff. Attaching only peak/average to its returned SessionSummary leaves requests and totals lifetime-scoped and can omit roots, breaking AC-04 even when range=7d matches the heatmap. Specify reuse of metadata/root identity only, overwrite every range-dependent counter from the same cutoff-filtered relation as KPI, and state pagination/coverage. Test an old request plus a recent request and more than 100 roots.

### B8. Define normalization and system-part omission edge cases

- Severity: blocking; disposition: open.
- Anchor: `spec/001-omp-context-insights/[接口文档] context-insights.md:286`.

The contract permits maxSystemParts=0 or 1 (limits clamp at interface 249), but the max-1 plus final remainder rule has no valid zero-cap result and at cap=1 merges systemPrompt/systemContext into part 0, violating the category-specific invariants (design 108). With the normal cap of 20, an exact 20-part snapshot and a 21-part snapshot collapsed to 20 have no persisted original-count/omitted flag, yet Browser must label parts[19..n] and truncated must report omitted lists. Largest-remainder allocation (interface 288) also lacks an all-zero-weight rule for a positive target. Define permitted capture caps, zero-weight behavior, and explicit merged-part metadata; add 0/1/20/21-part fixtures. These are contract gaps, not measured runtime failures.

## Other reviewed contracts and verification conclusions

- **Citation check:** FEATURE B1 and context-report section 2.1 correctly cite `packages/ai/src/types.ts:1243–1263`: the current snapshot has totals but no details. `agent-session.ts:3988–4000` confirms successful-assistant capture; `8742–8757` confirms pre-request breakdown and pending snapshot. `context-usage.ts:386–415` confirms current-configuration category estimation. DECISIONS D7 cites real trace code, but the parity inference is invalid as explained in B3.
- **Persistence and privacy:** Optional details is a viable backward-compatible storage seam, with named tool/skill counts and system parts sufficient in principle once B1/B8 are fixed. Largest remainder before item truncation is coherent for nonempty positive-weight input. The design must not silently backfill legacy composition. Signed unattributed is otherwise clearly specified.
- **Files and prune:** Inferred prune timestamps are explicitly approximate and do not alter file history. The file adapter seam still needs care: design 261 requires normalized paths, whereas 275 says raw live entries pass through without copying; tool arguments may carry relative paths/read selectors. Specify one normalized projection before implementation, rather than letting live and journal invent separate rules. Missing-result accounting must follow the stated call-side policy, not only the toolResult loop.
- **TUI feasibility:** TabBar already has showHint, selection, native describe and keyboard methods (`tab-bar.ts:73–80,104–140,177–223`); ContextUsageView already has native and ANSI presentation and unavailable text (`context-usage.ts:963–999`). These pieces are reusable, but do not solve B2. Narrow/legacy/no-model cases and keeping the existing Overview card are explicitly planned. Refresh wording in design 339 still says host rebuild, whereas interface 374 and design 477 preserve state; use the latter consistently.
- **Stats without new tables:** `db.ts:146–183` stores input/cache/total tokens but not usage.contextTokens. The interface correctly labels global prompt totals DB approximation. Raw messages can supply MAX/SUM/COUNT; rollup is hourly and not keyed by session (`rollup.ts:73–83`), so session peaks cannot be recovered solely from additive rollups. Fixed 7-day heatmap and variable-range rows should only be compared over an identical window.
- **HTTP/fleet compatibility:** Existing trace routes prove ETag-first handling and 400/404 mapping (`server.ts:294–333`). Reuse must include transcript decompression (`trace.ts:168–172`) and recursive child discovery (`773–805`), not merely path guarding: design 286 currently says readFile and 289 mentions only *.jsonl. Fingerprints should include stable file identities, sorted order and the same descendant set as fleet, with pre-build/race semantics matching trace (`940–952`). Lexical path containment is the existing guard, not proof of symlink containment; no new security regression is claimed here.
- **Web dispatch:** The design explicitly plans additions to DashboardSection/NAV, useHashRoute and App. Current App.tsx:42–65 is the consuming switch and useHashRoute.ts:54–56 clears sessions outside traces; both must be migrated as planned. Browser is presently blocked by B1, not by route feasibility.
- **RL-08:** Design 429–454 requires observed red-before-green, independent fixture oracles and mutation tests for missing chapters, fake verdict, self-review and unresolved blockers. This is a falsifiable plan; it is not evidence those validators have run. No validator or TDD success is asserted. Add the counterexamples in B1–B8 to the planned negative controls.
- **RL-09:** The single record below identifies a non-main reviewer, UTC timestamp, explicit open dispositions and fail verdict. The acceptance predicate is pass only if no non-fixed blocking finding exists; this report intentionally cannot pass that gate.

## Machine-readable review record

```json
{
  "reviewer": "DesignReview",
  "reviewed_at": "2026-10-21T07:38:14.230009+00:00",
  "verdict": "fail",
  "findings": [
    {
      "severity": "blocking",
      "file": "spec/001-omp-context-insights/[接口文档] context-insights.md",
      "line": 83,
      "summary": "Expose persisted drill-down details on each returned step",
      "disposition": "open"
    },
    {
      "severity": "blocking",
      "file": "spec/001-omp-context-insights/[设计文档] context-insights.md",
      "line": 322,
      "summary": "Route report input to the interactive context body",
      "disposition": "open"
    },
    {
      "severity": "blocking",
      "file": "spec/001-omp-context-insights/[设计文档] context-insights.md",
      "line": 287,
      "summary": "Match live active-leaf replay rather than copying trace activeChain",
      "disposition": "open"
    },
    {
      "severity": "blocking",
      "file": "spec/001-omp-context-insights/[设计文档] context-insights.md",
      "line": 228,
      "summary": "Choose one event-to-step association rule",
      "disposition": "open"
    },
    {
      "severity": "blocking",
      "file": "spec/001-omp-context-insights/[接口文档] context-insights.md",
      "line": 227,
      "summary": "Reconcile API limits with the acceptance criteria",
      "disposition": "open"
    },
    {
      "severity": "blocking",
      "file": "spec/001-omp-context-insights/FEATURE.md",
      "line": 84,
      "summary": "Remove the contradictory overshoot redistribution decision",
      "disposition": "open"
    },
    {
      "severity": "blocking",
      "file": "spec/001-omp-context-insights/[接口文档] context-insights.md",
      "line": 415,
      "summary": "Do not reuse lifetime session counters as range aggregates",
      "disposition": "open"
    },
    {
      "severity": "blocking",
      "file": "spec/001-omp-context-insights/[接口文档] context-insights.md",
      "line": 286,
      "summary": "Define normalization and system-part omission edge cases",
      "disposition": "open"
    }
  ]
}
```

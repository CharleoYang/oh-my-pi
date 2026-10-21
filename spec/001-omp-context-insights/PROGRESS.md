# Context insights implementation evidence

## T-06 merged delivery

- The Context route provides bounded global KPIs, a heatmap and clickable session rows, plus Composition / Trend / Browser / Events / Files / Fleet detail.
- The shared global `all` selection maps to a visibly labeled `90d` Context range (D16). Session `s=` survives local tab changes; Files navigates to Traces and Fleet supports child/root navigation.
- Coverage resides in `packages/stats/test/context-ui.test.tsx`, `context-view-models.test.ts` and `context-css.test.ts`; T-07 additionally exercises the built SPA in real Chromium rather than substituting DOM-only tests.

## T-07 red-first history

- Signed test-only commit: `f33f1f9c05` (`test: add failing context insights cross-surface E2E`), made before product/docs edits.
- Observed red: 0 pass / 1 fail / 3 assertions; expected `Overview`, but the VirtualTerminal still showed the editor after sending `/context` and Enter in one input packet. The test was corrected to the existing terminal harness's split text/render/Enter sequence. This was a real harness failure, not a fabricated missing-feature history.
- Earlier environment prerequisite failures were also observed: missing generated HTML tool views, and a managed Chromium provisioning timeout. `bun run gen:tool-views` generates the ignored source prerequisite; an existing system Chrome is now tried without unnecessary downloading, still through `ensureChromiumExecutable` and a real headless launch.
- Lane-local dependency resolution required `bun install --offline --frozen-lockfile --ignore-scripts`; no dependency manifest/lock changed and no installed-omp replacement was requested. `bun --cwd=packages/natives run build` completed successfully from source; its only platform warning is unavailable Swift 6.4+/macOS 27 Foundation Models support. Generated native artifacts remain ignored and local.

## T-07 delivered acceptance

`packages/coding-agent/test/context-insights-e2e.test.ts` uses the shared six-step fixture with only real-journal envelope adaptation. It opens an actual SessionManager / AgentSession / InteractiveMode / VirtualTerminal report, exercises four pages, focus, delta, refresh and Esc, appends and flushes a seventh assistant turn, then compares the live and HTTP steps/events/files/peak/legacy/incomplete-call counts. The new turn is 140 prompt tokens with delta +120; Chromium detail must show the same seven requests and peak 140.

The same test starts `startServer(0)` on loopback, explicitly calls `syncAllSessions` and `refreshRollups`, checks 200 / ETag / 304, payload caps and body exclusion, and verifies overview conservation (heatmap = rows + omitted). It drives the real built SPA from `#/context`, clicks a session row, checks all six detail tabs and preserved `s=`, and rejects browser page errors. Screenshots stay in the temporary directory. Missing/unlaunchable Chromium fails `beforeAll`; there is no browser skip.

### Executed checks

- `bun test packages/coding-agent/test/context-insights-e2e.test.ts --timeout=180000`: **1 pass, 0 fail, 62 assertions**; real headless system Chrome and built stats client, including final isolation/privacy/installed-binary assertions.
- `bun run --cwd packages/stats check`: **exit 0** (lint, formatting, server/client types).
- `bun run --cwd packages/coding-agent check`: **exit 0**; four pre-existing unused-member/import/variable warnings, no errors.
- `bun run --cwd packages/tui check`: **exit 0**.
- `bun test packages/coding-agent/test/interactive-terminal-e2e.test.ts`: **7 pass, 0 fail, 27 assertions**.
- `bun scripts/ci/validate-context-insights-spec.ts` and `bun scripts/ci/validate-context-insights-tasks.ts`: **PASS**; original 7 task rows / 14 columns / dependency edges remain unchanged.
- Required broad command in the inherited Herdr/CMUX environment: **4282 pass, 9 fail**, 4298 tests / 351 files. Clearing Herdr session markers removed one failure; clearing CMUX session markers removed seven more. With `env -u HERDR_ENV -u HERDR_PANE_ID -u HERDR_TAB_ID -u HERDR_WORKSPACE_ID -u TERM_PROGRAM -u CMUX_WORKSPACE_ID -u CMUX_SURFACE_ID -u CMUX_REMOTE_TRANSPORT`, the command reported **4290 pass, 1 fail**, 4298 tests / 351 files. Remaining failure: `packages/tui/test/terminal-background.test.ts:224`, SIXEL palette expected 30, received 100. No unrelated product/test expectations were weakened.

#### Clean base comparison: known unrelated failure

At Main's request, created a clean detached worktree at base master `ee0bfc099a`, with the same lane dependency/native setup. `git status --short` was empty. The following command reproduced the same failure on base (the temporary comparison worktree was then removed):

```sh
env -u HERDR_ENV -u HERDR_PANE_ID -u HERDR_TAB_ID -u HERDR_WORKSPACE_ID -u TERM_PROGRAM -u CMUX_WORKSPACE_ID -u CMUX_SURFACE_ID -u CMUX_REMOTE_TRANSPORT bun test packages/tui/test/terminal-background.test.ts
```

```text
Expected: 30
Received: 100
Expected precision: 0
Expected difference: < 0.5
Received difference: 70
at expectSixelColor (.../packages/tui/test/terminal-background.test.ts:81:50)
at <anonymous> (.../packages/tui/test/terminal-background.test.ts:224:4)
(fail) terminal background SIXEL repaint > repaints multiplexer viewports without clearing their native history
17 pass
1 fail
Ran 18 tests across 1 file.
```

This is an evidenced pre-existing/environmental failure, not a T-07 regression. Main explicitly accepted recording it as a known PR failure without editing the unrelated test or product code. Final broad lane result after a fresh native source build remains **4290 pass / 1 fail**, 4298 tests / 351 files; feature E2E and all affected package static checks pass.

### No-overwrite / isolation gate

- Source-only test; no `/opt/homebrew/bin/omp` invocation, installer or `bun link`.
- Before/after SHA-256 plus mtime equality is asserted for `/opt/homebrew/bin/omp`; the final successful E2E exercised that assertion.
- Configuration, agent directory, sessions, auth DB, stats DB and Puppeteer cache resolve under the temporary tree; inherited XDG and PI session identity variables are cleared/restored. Browser profiles and screenshots are temporary. No real `~/.omp` writes are required by the test.
- **不覆盖已安装 omp。Installation or replacement still requires separate explicit user approval, even after all acceptance checks pass.**
- Existing stats and tui Unreleased changelogs already cover T-03/T-04/T-05/T-06; T-07 adds the missing ai fold and coding-agent snapshot/E2E release notes. Spec task-table rows/dependencies are intentionally unchanged.

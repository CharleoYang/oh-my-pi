# T-06 review retrospective (3-round quota)

## Round outcomes

| Round | Verdict | Finding class | Concrete findings |
| --- | --- | --- | --- |
| 1 | FAIL | Detail boundary semantics | Fleet key used as a path suffix; child data survived a root change; Files opened the root from a child view; unsupported schema rendered; Browser omitted system parts. |
| 2 | FAIL | Version boundary + chart domain | Schema guard ran after `timeline.steps` access, so a schema-only v2 response crashed; signed deltas were fed to a zero-based chart and painted below the axis. |
| 3 | FAIL | Theme-token existence | The new delta baseline/selection used `--border`/`--surface`, neither defined by either stats theme, so the baseline and active highlight were invisible. |

## Why each round fixed one instance only

- The detail view mixed data-shape assumptions (`steps` always present), identity state (root vs child), and CSS tokens. Reviews tested the render path with version-1-shaped fixtures and did not exercise the missing-field shape, the signed domain, or CSS variable resolution.
- Each fix added a component-level guard or a fixture variation, but no invariant check over the input/token space. The recurring shape is "rendering assumes a field/token exists because the common fixture has it."
- The CSS defect is invisible to DOM assertions: jsdom does not resolve custom properties, and the delta tests asserted inline geometry only. A token can be typo'd and all tests stay green.

## Systemic fix in this revision

1. Schema guard now runs before any version-dependent `steps` access; hooks remain unconditional. The regression fixture is the minimal shape `{schemaVersion:2, file}`, not a spread of a v1 timeline.
2. Delta mode has a dedicated signed zero-baseline list; no zero-based chart is used for signed values. Tests cover `-max..+max` and `undefined`.
3. A new `context-css.test.ts` reads `context.css` and `styles.css`, and fails on any `var(--token)` without a fallback that is not defined by the theme files. This is the oracle for the class that jsdom cannot see.
4. Delta active/hover styles use `--selected`/`--hover`; the baseline uses `--line-3`.

## Review-brief correction

UI reviews must include: (a) a minimal/partial payload for every version guard, (b) a signed/zero/undefined matrix for every numeric renderer, and (c) a static theme-token existence check for any new CSS variable, because jsdom does not resolve custom properties.

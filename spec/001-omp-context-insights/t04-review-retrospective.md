# T-04 review retrospective (3-round quota)

## Round outcomes

| Round | Verdict | Finding class | Concrete finding |
| --- | --- | --- | --- |
| 1 | FAIL | Path containment implemented as raw prefix matching | `substr(relative_file, 1, 2) <> '..'` admitted `project/../../../outside.jsonl`; external transcript contributed KPI/heatmap/rows. |
| 2 | FAIL | Same class, opposite direction: string predicates over-rejected | Added SQL predicates rejected every `.`/`..` segment, discarding valid `project/a/../b.jsonl` and `project/./c.jsonl`, and the adjacent prefix test discarded a literal `...` project. |
| 3 | FAIL | Boundary class outside SQL: dependency direction | `shared-types.ts` re-exported `@oh-my-pi/pi-ai` types. The client tsconfig then pulled the AI package into the client project and failed with 11 DOM/Node type errors that the server-only check did not show. |

## Why each round fixed one instance only

- Rounds 1–2 implemented path semantics with SQL string matching. Each patch encoded the previous counterexample as a predicate; the invariant ("the normalized path must remain under the sessions root, and the root identity is derived from normalized segments") was never expressed. The oracle is `path.normalize` plus the trace root-derivation rule, not a list of forbidden substrings.
- Tests covered only pre-normalized happy paths. Neither internal dot segments nor literal dot-prefixed project names were in the matrix, so over-rejection was invisible.
- Round 3's boundary was not part of the review brief. The lane ran the server check only; the client project (`tsconfig.client.json`) was never exercised until an independent reviewer ran the package `check` in a fresh worktree. The shared-types header already stated "no `@oh-my-pi/pi-ai` imports"; the change violated a written invariant that no check enforced for the client project.

## Systemic fixes in this revision

1. SQL now aggregates per raw `session_file` + bucket only. `contextRootFile()` normalizes each file with `path.normalize`, rejects normalized paths outside the sessions prefix, requires a project/transcript pair, and derives the root from normalized segments. Multiple spellings of one root merge in the JS fold.
2. Tests use the Node path oracle as the reference: escape (`project/../../../outside.jsonl`), dot-prefixed escape (`./outside.jsonl`), in-root normalization (`project/a/../b.jsonl`, `project/./c.jsonl`), and literal dot-named projects (`...`, `.hidden`).
3. `shared-types.ts` is dependency-free again: the context contract is declared locally instead of re-exported from `@oh-my-pi/pi-ai`.
4. The lane gate now includes both server and client projects (`bun run --cwd packages/stats check`), which is the check that exposed round 3.

## Review-brief correction

Acceptance for path work must state the invariant and the oracle, not examples: "for every input path, normalized containment and root identity must equal Node `path.normalize` + the trace derivation; include negative controls that must remain accepted." Type-boundary work must name every tsconfig that consumes the changed module.

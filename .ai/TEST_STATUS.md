# TEST STATUS

Recorded from ACTUAL local runs (never hand-written as "pass").

## Last local run — 2026-10-04 (branch auto/knowledge-graph)

Command: `npm run verify` (validate → typecheck → test)

- validate: **OK** (policies, build graph, agents, skills, adapters, domains, knowledge, state)
- typecheck (`tsc --noEmit`): **OK**
- vitest: **268 passed / 268** across 25 files (re-review added 3 more regressions)

New this change — `@uaap/knowledge-graph` (`packages/knowledge-graph/test/`): **19 tests**
- content-addressed + idempotent nodes/edges; fail-closed endpoint-type validation.
- impact direction is semantic per edge type (DEPENDS_ON propagates to the dependent, not the
  dependency); change-impact / blast-radius / bounded radius.
- regression selection (only tests whose coverage is in the blast radius).
- traceability path (requirement → evidence); root-cause (affected code → upstream dependencies).
- release assurance FAIL-CLOSED: open finding on shipped surface blocks; requirement without
  passing evidence = GAP; untraceable shipped feature; empty release never ASSURED.
- schema-validated document load + defense-in-depth rejection of illegal relationships.

Adversarial review (PR #10, 22 agents) confirmed 7 defects — ALL fixed with regression tests:
2×P0 release-assurance fake-PASS (bare shipped service/code untraceable check + requirement
discovery through containers), 2×P1 (case-sensitive finding status; duplicate-node-id silent
merge on load), 2×P2 (fail-open finding allow-list → closed allow-list; DATABASE findings never
blocked), 1×P3 (prototype-chain type-guard fail-open).

P0/P1/P2/P3 open: 0 / 0 / 0 / 0. Re-review of the fix commit pending before merge.

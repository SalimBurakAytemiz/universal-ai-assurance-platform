# TEST STATUS

Recorded from ACTUAL local runs (never hand-written as "pass").

## Last local run — 2026-10-04 (branch auto/knowledge-graph)

Command: `npm run verify` (validate → typecheck → test)

- validate: **OK** (policies, build graph, agents, skills, adapters, domains, knowledge, state)
- typecheck (`tsc --noEmit`): **OK**
- vitest: **255 passed / 255** across 25 files

New this change — `@uaap/knowledge-graph` (`packages/knowledge-graph/test/`): **19 tests**
- content-addressed + idempotent nodes/edges; fail-closed endpoint-type validation.
- impact direction is semantic per edge type (DEPENDS_ON propagates to the dependent, not the
  dependency); change-impact / blast-radius / bounded radius.
- regression selection (only tests whose coverage is in the blast radius).
- traceability path (requirement → evidence); root-cause (affected code → upstream dependencies).
- release assurance FAIL-CLOSED: open finding on shipped surface blocks; requirement without
  passing evidence = GAP; untraceable shipped feature; empty release never ASSURED.
- schema-validated document load + defense-in-depth rejection of illegal relationships.

P0/P1/P2/P3 open: 0 / 0 / 0 / 0.

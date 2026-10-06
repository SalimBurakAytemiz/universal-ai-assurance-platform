# TEST STATUS

Recorded from ACTUAL local runs (never hand-written as "pass").

## Last local run — 2026-10-06 (branch auto/autopilot-ci-monitor)

Command: `npm run verify` (validate → typecheck → test)

- validate: **OK** (policies, build graph, agents, skills, adapters, domains, knowledge, state)
- typecheck (`tsc --noEmit`): **OK**
- vitest: **295 passed / 295** across 26 files (autopilot CI monitor; review + re-review regressions)

New this change — `@uaap/knowledge-graph` (`packages/knowledge-graph/test/`): **36 tests**
- content-addressed + idempotent nodes/edges; fail-closed endpoint-type validation.
- impact direction is semantic per edge type (DEPENDS_ON propagates to the dependent, not the
  dependency); change-impact / blast-radius / bounded radius.
- regression selection (only tests whose coverage is in the blast radius).
- traceability path (requirement → evidence); root-cause (affected code → upstream dependencies).
- release assurance FAIL-CLOSED: open finding on shipped surface blocks; requirement without
  passing evidence = GAP; untraceable shipped feature; empty release never ASSURED.
- schema-validated document load + defense-in-depth rejection of illegal relationships.

Three isolated adversarial review rounds (cap=3) confirmed 10 defects total — ALL fixed with
regression tests:
- Review (22 agents): 2×P0 release-assurance fake-PASS (bare shipped service/code untraceable
  check + requirement discovery through containers), 2×P1 (case-sensitive finding status;
  duplicate-node-id silent merge on load), 2×P2 (fail-open finding allow-list → closed allow-list;
  DATABASE findings never blocked), 1×P3 (prototype-chain type-guard fail-open).
- Re-review (11 agents): 1×P1 residual (identity-collision on load: distinct doc ids, same
  (type,key), silent last-wins merge → now rejected), 1×P3 (failing evidence ignored → now any
  failing evidence forces GAP).
- Final re-review (4 agents): 1×P2 (isFailingEvidence was a failure DENYLIST missing FAILURE/
  ERRORED/KO → replaced with a vocabulary-CLOSED evidenceVerdict).

P0/P1/P2/P3 open: 0 / 0 / 0 / 0. Review cap reached; ready to merge.

# NEXT ACTIONS

> Authoritative "what to do next". Updated at every validated checkpoint.

## Just completed
- `@uaap/knowledge-graph` — assurance knowledge graph (requirement↔feature↔code↔component↔
  service↔api↔db/event/queue↔test↔finding↔evidence↔risk↔release) with traceability,
  change-impact, blast-radius, regression selection, root-cause and fail-closed release
  assurance. 19 tests. (build graph: 40 DONE / 7 READY / 1 BLOCKED / 7 NOT_STARTED.)

## Now building — execution engines (autonomous, dependency-ordered)
Order (Decision Ledger 2026-10-04): A API/contract → B web/Playwright → C database →
D realtime → E performance → F accessibility/visual → G security sandbox → H mobile → I specialized.

1. **quality-api-engine** — common engine contract (discover/plan/validate-prereqs/execute/
   collect-artifacts/produce-evidence/result/cancel/timeout/capabilities/health) + Ajv/JSON-Schema/
   OpenAPI request+response contract checks, headers, null/empty, negative, schema drift. Local
   fixtures only. Routes evidence through the Evidence Engine; findings through the finding lifecycle.
2. web engine (Playwright) — install Playwright locally; deterministic local HTML fixtures.
3. database validation engine — read-only consistency/schema checks against a local fixture.

## Locked by design (HUMAN_ACTION_REQUIRED)
- `security-active-validation-gate`: needs explicit external target authorization + scope.
  Security ENGINE + agents + lifecycle still built against local controlled fixtures.

## Human/environment-gated (not blocking other work)
- Research nodes (technology-scout/standards/advisory): implement pipeline/schemas/provenance/
  scheduler locally; mark live external fetch BLOCKED_EXTERNAL_RESEARCH if no internet.
- Desktop packaging: unsigned dev installer OK; production signing = DESKTOP_SIGNING_REQUIRED.
- Final license = FINAL_LICENSE_DECISION_REQUIRED (conservative placeholder stays).

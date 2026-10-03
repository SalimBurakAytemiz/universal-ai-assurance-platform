# NEXT ACTIONS

> Authoritative "what to do next". Updated at every validated checkpoint.

## Just completed (this session)
- Single-repository monorepo foundation + governance (README, SECURITY, CLAUDE.md, LICENSE).
- `@uaap/core` shared types.
- Fail-closed **Trust Kernel** + tests.
- **Policy-as-code** engine + baseline policy + schema + tests.
- **Audit** ledger (hash chain) + tests.
- **Tool Broker** (lease-based) + **Orchestrator** + end-to-end boundary tests.
- 72 canonical agent role definitions + agent registry schema + validator + test.
- Knowledge provenance/lifecycle schema + validator.
- `.ai/` state + build graph + CI workflow + desktop shell scaffold.

## Immediate READY nodes (dependency-aware)
1. `ci-workflow` — confirm green on GitHub Actions after push.
2. `github-automation` — PR/CI/review/merge loop.
3. `desktop-shell` — validate the Electron shell actually launches and shows honest state.

## Next buildable (after the above)
- `tool-adapter-registry`, `agent-permission-graph`, `structured-agent-events`.
- `project-model` → `digital-twin` → `domain-capability-model`.
- `knowledge-store` → `knowledge-lifecycle` → `knowledge-decay`.
- `evidence-engine` → `verification-engine` → `release-gate`.

## Locked by design (HUMAN_ACTION_REQUIRED)
- `security-active-validation-gate`: needs explicit external target authorization + scope.

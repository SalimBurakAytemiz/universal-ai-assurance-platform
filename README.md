# Universal AI Assurance Platform

**One product. One repository. One desktop application.**
Quality and Security are **domains** over one shared core — not separate products.

A local-first, desktop-controlled AI software-assurance platform. It is designed to
understand a software system, model it, plan assurance work, run Quality + Security +
Data + Performance + Reliability + Privacy + Accessibility checks, collect **real**
evidence, verify findings independently, and turn results into a release-assurance
decision — all behind a **fail-closed trust kernel**.

> This README reports **actual status**, not aspiration. Capabilities not yet built are
> marked honestly. See [`docs/REQUIREMENT-TRACEABILITY.md`](docs/REQUIREMENT-TRACEABILITY.md)
> and [`.ai/BUILD_GRAPH.json`](.ai/BUILD_GRAPH.json) for the authoritative state.

## Status (honest)

| Area | Status |
|------|--------|
| Monorepo + TypeScript + CI scaffold | **IMPLEMENTED** |
| Core shared types (`@uaap/core`) | **IMPLEMENTED** |
| Fail-closed Authorization / Trust Kernel | **IMPLEMENTED + TESTED** |
| Policy-as-code engine (schema-validated, fail-closed) | **IMPLEMENTED + TESTED** |
| Audit decision ledger + chain-of-custody hashing | **IMPLEMENTED + TESTED** |
| Lease-based Tool Broker (boundary enforcement) | **IMPLEMENTED + TESTED** |
| Orchestrator (no direct agent→target) | **IMPLEMENTED + TESTED** |
| `.ai/` persistent state + build graph | **IMPLEMENTED** |
| 72 canonical agents + runtime permissions + skill/tool-adapter/event registries | **IMPLEMENTED + TESTED** |
| Project + Target model persistence; Digital Twin steward | **IMPLEMENTED + TESTED** |
| Evidence engine (execution-backed + chain of custody) | **IMPLEMENTED + TESTED** |
| Verification engine (independent, separation of duties) | **IMPLEMENTED + TESTED** |
| Remediation lifecycle (SoD + independent retest + closure) | **IMPLEMENTED + TESTED** |
| Release gate (fail-closed, decision ledger) | **IMPLEMENTED + TESTED** |
| Desktop application (Electron shell, honest live state) | **SCAFFOLDED** |
| Quality execution engines (API/web/mobile/db via real tools) | **NOT STARTED** (interfaces/adapters planned) |
| Security execution engines (appsec/api/cloud via real tools) | **NOT STARTED** (interfaces/adapters planned) |
| Knowledge store / continuous-learning runtime | **NOT STARTED** (schema + validators done) |
| GitHub automation (PR/CI/review/merge in practice) | **IMPLEMENTED** (4 PRs merged this way) |
| Packaging / SBOM / desktop installer | **NOT STARTED** (planned) |

Current local test suite: **156 tests across 17 files, all passing.**

"IMPLEMENTED + TESTED" means real code with executable tests that pass locally.
"SCAFFOLDED" means a real, runnable skeleton that shows `NOT AVAILABLE` for backends
that do not exist yet. It never shows a fake green status.

## Architecture in one picture

```
Agent  →  Orchestrator  →  Authorization Kernel  →  Policy Engine  →  Tool Broker  →  Target
                                   │                      │               │
                                   └──────────────  Audit (immutable decision ledger)  ──────────────┘
```

A **direct `Agent → Target` path is forbidden** and is covered by a test that fails if
the boundary is bypassed.

## Requirements

- Node.js >= 20 (developed on Node 24), npm >= 10
- Windows is the first desktop target; the architecture keeps macOS/Linux possible.

## Quick start (developer)

```bash
npm install
npm run verify      # validate policies + build graph + state, typecheck, run tests
```

Individual steps:

```bash
npm run validate    # JSON-schema-validate policies, build graph, and .ai state
npm run typecheck   # tsc --noEmit across the workspace
npm run test        # vitest: kernel / policy / audit / broker / orchestrator / safety
```

Full local automation entry points (operational contract shared with the specs):

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-full-auto.ps1
```

## Repository layout

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). The short version:

- `packages/core` — shared domain types (modes, action classes, decisions, findings).
- `packages/authorization-kernel` — the fail-closed trust kernel.
- `packages/policy-engine` — policy-as-code, schema-validated, fail-closed.
- `packages/audit` — immutable decision ledger + chain-of-custody hashing.
- `packages/tool-broker` — lease-based tool access; the only path to a target adapter.
- `packages/orchestrator` — wires the mandatory decision pipeline.
- `apps/desktop` — the primary human control plane (Electron shell).
- `policies/`, `schemas/` — machine-readable policy + schemas.
- `.ai/` — persistent state so work survives session loss.
- `docs/` — canonical documentation + requirement traceability.

## Non-negotiables

No fake pass. No fake evidence. No fake finding. No fake authorization. No fake
execution. No fake review. No false "complete". No authorization → no active security
validation. Ambiguous → deny. Out of scope → deny. No direct agent → target. No policy
bypass. No AI-provider safety bypass. No committed secrets. No force push. No history
rewrite. Detector ≠ closure authority.

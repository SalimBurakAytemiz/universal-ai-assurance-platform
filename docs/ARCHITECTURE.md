# Architecture

**One product, one repository, one desktop.** Quality and Security are assurance *domains*
over one shared core — not separate products or repositories.

## The mandatory decision pipeline

```
Agent -> Orchestrator -> Authorization Kernel -> Policy Engine -> Tool Broker -> Adapter -> Target
                               |                    |              |
                               +-------------  Audit (hash-chained decision ledger)  -----------+
```

- **Authorization Kernel** (`@uaap/authorization-kernel`): the single fail-closed authority.
  Default DENY. Implemented + tested.
- **Policy Engine** (`@uaap/policy-engine`): policy-as-code, schema-validated, composed as an
  AND-gate that can only further restrict. Fail-closed on an invalid document.
- **Tool Broker** (`@uaap/tool-broker`): lease-based; owns the adapters privately; calls the
  kernel before any adapter runs.
- **Orchestrator** (`@uaap/orchestrator`): the only surface an agent touches. Exposes no
  adapter/broker/kernel, so a direct agent-to-target call is structurally impossible.
- **Audit** (`@uaap/audit`): append-only, tamper-evident ledger with chain-of-custody hashing.

## Monorepo layout

```
packages/        core, authorization-kernel, policy-engine, audit, tool-broker, orchestrator
apps/desktop/    Electron control-plane shell (honest live state)
agents/registry/ 72 canonical agent role definitions
policies/        policy-as-code documents          schemas/ JSON schemas (policy/graph/agent/knowledge)
scripts/         validators + local automation (*-full-auto.ps1)
.ai/             persistent state + build graph    docs/ canonical documentation
tests/           cross-package safety + integration tests
```

## Stack and rationale

TypeScript (npm workspaces) + Vitest + Ajv; Electron for the desktop (Windows-first,
cross-platform kept possible). Node/npm are already present on the host; no Rust toolchain,
so Tauri was not chosen. Deterministic work (hashing, schema validation, git) is done by code,
not by an LLM: lower cost, higher reproducibility, better auditability.

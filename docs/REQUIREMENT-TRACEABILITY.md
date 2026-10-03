# Requirement Traceability

Every significant requirement from the two source specs and the two master prompts has a
unique ID and a traceable chain: **SOURCE → STATUS → IMPLEMENTATION → TEST → EVIDENCE**.
A requirement never disappears silently; if it is not built, its status says so.

Status vocabulary: `IMPLEMENTED+TESTED` · `IMPLEMENTED` · `SCAFFOLDED` · `DOCUMENTED` ·
`NOT_STARTED` · `BLOCKED` (with reason).

Sources: `QA` = AI_QA_COMMAND_CENTER spec · `SEC` = AI-SECURITY-FACTORY handoff ·
`M1` = one-shot master build prompt · `M2` = agent/knowledge continuation addendum.

| ID | Requirement | Source | Status | Implementation | Test |
|----|-------------|--------|--------|----------------|------|
| REQ-REPO-001 | ONE product / ONE repository / ONE desktop | M1 §0 | IMPLEMENTED | monorepo root, single repo | — |
| REQ-GOV-001 | Governance files (README/SECURITY/CLAUDE/LICENSE) | M1 §5 | IMPLEMENTED | `README.md`,`SECURITY.md`,`CLAUDE.md`,`LICENSE` | — |
| REQ-GOV-LICENSE | Final licensing decision | M1 §88 | BLOCKED (human/legal); default all-rights-reserved | `LICENSE` | — |
| REQ-CORE-001 | Shared core domain types | M1 §6 | IMPLEMENTED+TESTED | `packages/core` | via dependents |
| REQ-SEC-TRUSTKERNEL-001 | Fail-closed trust kernel | SEC §9, M1 §19 | IMPLEMENTED+TESTED | `packages/authorization-kernel` | `kernel.test.ts` (17) |
| REQ-SEC-FAILCLOSED-001 | Default DENY; ambiguous→DENY | SEC §9, M1 §19 | IMPLEMENTED+TESTED | kernel gates | `kernel.test.ts` |
| REQ-SEC-POLICY-001 | Policy-as-code, schema-validated, fail-closed | M1 §21 | IMPLEMENTED+TESTED | `packages/policy-engine`, `policies/`, `schemas/policy.schema.json` | `policy.test.ts` (7) |
| REQ-SEC-BOUNDARY-001 | No direct agent→target | SEC §11, M1 §20 | IMPLEMENTED+TESTED | broker+orchestrator | `boundary.test.ts` (4) |
| REQ-AGENT-LEASE-001 | Lease-based tool permissions | M1 §26 | IMPLEMENTED+TESTED | `packages/tool-broker` | `boundary.test.ts` |
| REQ-ORCH-001 | Unified orchestrator pipeline | M1 §20 | IMPLEMENTED+TESTED | `packages/orchestrator` | `boundary.test.ts` |
| REQ-AUDIT-001 | Immutable decision ledger | M1 §48 | IMPLEMENTED+TESTED | `packages/audit` | `audit.test.ts` (3) |
| REQ-EVIDENCE-CUSTODY-001 | Chain of custody / hashing | M1 §31 | IMPLEMENTED+TESTED | `packages/audit`, `core/ids.ts` | `audit.test.ts` |
| REQ-STATE-001 | Persistent `.ai` state survives restart | M1 §55,§93 | IMPLEMENTED | `.ai/**` | `validate-state.mjs` |
| REQ-CI-VALIDATE-001 | Policy/graph/state validators | M1 §68 | IMPLEMENTED | `scripts/validate-*.mjs` | run in `verify` |
| REQ-CI-001 | CI pipeline | M1 §68 | IMPLEMENTED (pending first green on push) | `.github/workflows/ci.yml` | — |
| REQ-DESKTOP-001 | Desktop control plane, no fake green | M1 §7 | SCAFFOLDED | `apps/desktop` | manual launch |
| REQ-GITHUB-001 | GitHub lifecycle automation | M1 §58 | SCAFFOLDED (repo+push this session) | `.ai/GITHUB_STATE.json`, scripts | — |
| REQ-AGENT-72-001 | 72 canonical agents (9×8) | M2 §2 | IMPLEMENTED+TESTED | `agents/registry/agents.json` | `agent-registry.test.ts` (4) |
| REQ-AGENT-REGISTRY-001 | Versioned, schema-validated registry | M2 §6 | IMPLEMENTED+TESTED | `schemas/agent.schema.json`, validator | `agent-registry.test.ts` |
| REQ-AGENT-MIGRATION-001 | Old roles mapped, none dropped | M2 §3 | DOCUMENTED | `docs/AGENT-ROLE-MIGRATION-MAP.md` | `agent-registry.test.ts` (sample) |
| REQ-AGENT-PERM-001 | Least-privilege permission graph | M2 §7 | IMPLEMENTED (invariants in schema) + NOT_STARTED (runtime enforce) | `agent.schema.json` | `agent-registry.test.ts` |
| REQ-SKILL-001 | Versioned skill registry | M2 §35 | NOT_STARTED | — | — |
| REQ-TOOL-ADAPTER-001 | Tool adapter registry | M2 §36 | NOT_STARTED | interface in `tool-broker` | — |
| REQ-AGENT-EVENTS-001 | Structured agent events (schema) | M2 §9 | NOT_STARTED | — | — |
| REQ-AGENT-ACTIVATION-001 | Assurance planner selects team | M2 §8 | NOT_STARTED | — | — |
| REQ-EVALUATION-001/002 | Agent evaluation + certification | M2 §32,§33 | NOT_STARTED | — | — |
| REQ-KNOWLEDGE-PROV-001 | Knowledge provenance schema | M2 §23 | IMPLEMENTED | `schemas/knowledge-item.schema.json` | `validate-knowledge.mjs` |
| REQ-KNOWLEDGE-LIFECYCLE-001 | Candidate→certified lifecycle | M2 §24 | IMPLEMENTED (schema) + NOT_STARTED (engine) | schema | — |
| REQ-KNOWLEDGE-DECAY-001 | Freshness/decay | M2 §25 | NOT_STARTED | — | — |
| REQ-KNOWLEDGE-ISOLATION-001 | Global/org/project/run scopes | M2 §40 | IMPLEMENTED (scope field) + NOT_STARTED (enforce) | schema | — |
| REQ-RESEARCH-001/002/003 | Technology/standards/advisory intel | M2 §21,§29,§28 | NOT_STARTED | — | — |
| REQ-LEARNING-001 | Sandbox + evaluation + certification | M2 §20,§31 | NOT_STARTED | — | — |
| REQ-PROJECT-001 | Project + target model | M1 §8 | NOT_STARTED | — | — |
| REQ-TWIN-001 | Digital twin | M1 §10 | NOT_STARTED | — | — |
| REQ-GRAPH-001 | Assurance knowledge graph | M1 §11 | NOT_STARTED | — | — |
| REQ-DOMAIN-001 | Domain-aware + capability-based + packs | M1 §12,§13 | NOT_STARTED | — | — |
| REQ-QA-API-001 | Strict API contract (AJV) engine | QA §11, M1 §14 | NOT_STARTED | — | — |
| REQ-QA-WEB-001 | Web automation engine | QA §12 | NOT_STARTED | — | — |
| REQ-SEC-APPSEC-001 | Application security engine | SEC §12 | NOT_STARTED | — | — |
| REQ-SEC-ACTIVE-001 | Authorized active validation | SEC §4.2, M1 §17 | BLOCKED (needs external authorization + scope) | gate node | — |
| REQ-EVIDENCE-001 | Execution-backed evidence | QA §16, M1 §29 | NOT_STARTED | — | — |
| REQ-VERIFY-001 | Independent verification (SoD) | SEC §13, M1 §35 | NOT_STARTED | partial: SoD invariants in agent schema | — |
| REQ-REMEDIATION-001 | Remediation lifecycle | SEC §5, M1 §45 | NOT_STARTED | — | — |
| REQ-RELEASE-001 | Release gate on real results | M1 §46 | NOT_STARTED | — | — |
| REQ-PACKAGING-001 | Windows packaging + update/rollback | M1 §80,§81 | NOT_STARTED | build script stub | — |
| REQ-DESKTOP-AGENTS-001 | Desktop Agents view | M2 §48 | SCAFFOLDED (counts) | `apps/desktop` | — |
| REQ-DESKTOP-KNOWLEDGE-001 | Desktop Knowledge view | M2 §49 | NOT_STARTED | — | — |
| REQ-DESKTOP-LEARNING-001 | Desktop Learning view | M2 §50 | NOT_STARTED | — | — |

Legacy agent roles are additionally traced in `docs/AGENT-ROLE-MIGRATION-MAP.md`.

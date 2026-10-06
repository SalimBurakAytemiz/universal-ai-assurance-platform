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
| REQ-CI-001 | CI pipeline | M1 §68 | IMPLEMENTED+TESTED (green across PRs #10–#21) | `.github/workflows/ci.yml` (validate+typecheck+test on Node 20/22 + secret-scan) | CI runs |
| REQ-DESKTOP-001 | Desktop control plane, no fake green | M1 §7 | IMPLEMENTED+TESTED (Electron shell; headless BrowserWindow + full-app views runtime smoke, exit 0) | `apps/desktop` (consumes bundled @uaap/desktop-viewmodels) | `smoke/headless-smoke.cjs`, `smoke/views-smoke.cjs` |
| REQ-GITHUB-001 | GitHub lifecycle automation | M1 §58 | IMPLEMENTED (operationally proven across PRs #10–#21: branch→commit→push→PR→CI→head-pinned safe-merge→sync) | `.ai/GITHUB_STATE.json`, scripts | — |
| REQ-AGENT-72-001 | 72 canonical agents (9×8) | M2 §2 | IMPLEMENTED+TESTED | `agents/registry/agents.json` | `agent-registry.test.ts` (4) |
| REQ-AGENT-REGISTRY-001 | Versioned, schema-validated registry | M2 §6 | IMPLEMENTED+TESTED | `schemas/agent.schema.json`, validator | `agent-registry.test.ts` |
| REQ-AGENT-MIGRATION-001 | Old roles mapped, none dropped | M2 §3 | DOCUMENTED | `docs/AGENT-ROLE-MIGRATION-MAP.md` | `agent-registry.test.ts` (sample) |
| REQ-AGENT-PERM-001 | Least-privilege permission graph | M2 §7 | IMPLEMENTED+TESTED | `agent.schema.json` + `packages/agent-permissions` | `permissions.test.ts` (6) |
| REQ-SKILL-001 | Versioned skill registry | M2 §35 | IMPLEMENTED+TESTED | `schemas/skill.schema.json`, `skills/registry/skills.json`, validator | `skill-registry.test.ts` (3) |
| REQ-TOOL-ADAPTER-001 | Tool adapter registry | M2 §36 | IMPLEMENTED+TESTED | `packages/tool-adapter-registry`, `adapters/registry/adapters.json` | `adapters.test.ts` (5) |
| REQ-AGENT-EVENTS-001 | Structured agent events (schema) | M2 §9 | IMPLEMENTED+TESTED | `packages/agent-events`, `schemas/agent-event.schema.json` | `agent-events.test.ts` (7) |
| REQ-AGENT-ACTIVATION-001 | Assurance planner selects the run team (capabilities+domains+risk+budget, decision-ledger reasons) | M2 §8 | IMPLEMENTED+TESTED | `packages/assurance-planner` | `assurance-planner.test.ts` |
| REQ-EVALUATION-001 | Agent evaluation (benchmark metrics) | M2 §32 | IMPLEMENTED+TESTED | `packages/agent-evaluation` | `agent-evaluation.test.ts` |
| REQ-EVALUATION-002 | Agent certification (certify-before-active, no self-cert, regression gate) | M2 §33 | IMPLEMENTED+TESTED | `packages/agent-evaluation` | `agent-evaluation.test.ts` |
| REQ-KNOWLEDGE-PROV-001 | Knowledge provenance schema | M2 §23 | IMPLEMENTED | `schemas/knowledge-item.schema.json` | `validate-knowledge.mjs` |
| REQ-KNOWLEDGE-LIFECYCLE-001 | Candidate→certified lifecycle (external never directly ACTIVE) | M2 §24 | IMPLEMENTED+TESTED | `packages/knowledge` | `knowledge.test.ts` |
| REQ-KNOWLEDGE-DECAY-001 | Freshness/decay + revalidation | M2 §25 | IMPLEMENTED+TESTED | `packages/knowledge` (markStale/needsRevalidation) | `knowledge.test.ts` |
| REQ-KNOWLEDGE-ISOLATION-001 | Global/org/project/run scope isolation | M2 §40 | IMPLEMENTED+TESTED | `packages/knowledge` (query isolation) | `knowledge.test.ts` |
| REQ-RESEARCH-001/002/003 | Technology/standards/advisory intel | M2 §21,§29,§28 | IMPLEMENTED+TESTED (offline pipeline); live external fetch BLOCKED_EXTERNAL_RESEARCH | `packages/research-intelligence` (provided-only ingest, mandatory provenance, DISCOVERED→CANDIDATE, scheduler, LiveFetchGate always blocked) | `research-intelligence.test.ts` (11) |
| REQ-LEARNING-001 | Sandbox + evaluation + certification | M2 §20,§31 | IMPLEMENTED+TESTED (local Node-child sandbox — Docker's safe alternative; OS-jail isolation documented as needing a container runtime) | `packages/sandbox-learning` (bounded child-process runner, timeout-kill, env isolation, audit, eval integration) + `packages/agent-evaluation` | `sandbox-learning.test.ts` (9), `agent-evaluation.test.ts` |
| REQ-PROJECT-001 | Project + target model | M1 §8 | IMPLEMENTED+TESTED | `packages/project-model` (file-backed store) | `project-model.test.ts` (6) |
| REQ-TWIN-001 | Digital twin | M1 §10 | IMPLEMENTED+TESTED | `packages/digital-twin` (steward, provenance, staleness) | `digital-twin.test.ts` (7) |
| REQ-GRAPH-001 | Assurance knowledge graph | M1 §11 | IMPLEMENTED+TESTED | `packages/knowledge-graph` (traceability, change-impact, blast-radius, regression selection, fail-closed release assurance) | `knowledge-graph.test.ts` (36) |
| REQ-DOMAIN-001 | Domain-aware + capability-based + packs (generic fallback, multi-domain) | M1 §12,§13 | IMPLEMENTED+TESTED | `packages/domain-model`, `domain-packs/`, `schemas/domain-pack.schema.json` | `domain-model.test.ts` |
| REQ-ENGINE-CORE-001 | Execution-engine contract + total driveEngine runner | M1 §14, QA §10 | IMPLEMENTED+TESTED | `packages/engine-core` (lifecycle, CancellationToken+deadline, EngineCollector, never-throws driveEngine) | `engine-core.test.ts` (10) |
| REQ-QA-API-001 | Strict API contract (AJV) engine | QA §11, M1 §14 | IMPLEMENTED+TESTED | `packages/quality-api-engine` (request+response contract vs recorded exchanges, per-item isolation) | `quality-api-engine.test.ts` (17) |
| REQ-QA-WEB-001 | Web automation engine (offline: recorded web-flow validation; live Playwright capture gated) | QA §12 | IMPLEMENTED+TESTED | `packages/quality-web-engine` (navigation/element/console/network checks, fail-closed, secret-safe) | `quality-web-engine.test.ts` (21) |
| REQ-QA-DB-001 | Database validation engine (read-only) | QA §13 | IMPLEMENTED+TESTED | `packages/quality-database-engine` (schema/type/NOT NULL/PK/UNIQUE/FK/migration safety over fixtures) | `quality-database-engine.test.ts` (19) |
| REQ-QA-RT-001 | Realtime / event-stream validation engine | QA §13 | IMPLEMENTED+TESTED | `packages/quality-realtime-engine` (coverage/payload/ordering/duplicates/ack, fail-closed) | `quality-realtime-engine.test.ts` (18) |
| REQ-QA-PERF-001 | Performance budget engine | QA §14 | IMPLEMENTED+TESTED | `packages/quality-performance-engine` (latency percentiles + error-rate budgets from recorded samples) | `quality-performance-engine.test.ts` (13) |
| REQ-QA-A11Y-001 | Accessibility + visual engine | QA §15 | IMPLEMENTED+TESTED | `packages/quality-accessibility-engine` (WCAG over snapshots, contrast, visual-hash diff) | `quality-accessibility-engine.test.ts` (13) |
| REQ-SEC-APPSEC-001 | Application security engine | SEC §12 | IMPLEMENTED+TESTED (DETECTION-ONLY; active validation LOCKED_BY_DESIGN) | `packages/security-appsec-engine` (secrets/injection/config/headers/deps/TLS static analysis; secret-safe by construction) | `security-appsec-engine.test.ts` (19) |
| REQ-SEC-ACTIVE-001 | Authorized active validation | SEC §4.2, M1 §17 | BLOCKED (needs external authorization + scope) | gate node | — |
| REQ-EVIDENCE-001 | Execution-backed evidence + chain of custody | QA §16, M1 §29,§31 | IMPLEMENTED+TESTED | `packages/evidence-engine` | `evidence.test.ts` (11) |
| REQ-VERIFY-001 | Independent verification (SoD) | SEC §13, M1 §35 | IMPLEMENTED+TESTED | `packages/verification-engine` (+ agent schema invariants) | `verification.test.ts` (7) |
| REQ-REMEDIATION-001 | Remediation lifecycle (SoD + retest) | SEC §5, M1 §45 | IMPLEMENTED+TESTED | `packages/remediation-engine` | `remediation.test.ts` (11) |
| REQ-RELEASE-001 | Release gate on real results | M1 §46 | IMPLEMENTED+TESTED | `packages/release-gate` (fail-closed, decision ledger) | `release-gate.test.ts` (10) |
| REQ-PACKAGING-001 | Windows desktop packaging (dev/unsigned build) | M1 §80 | IMPLEMENTED+TESTED (dev/unsigned Win build via @electron/packager; packaged UAAP.exe runs + renders real state, startup smoke exit 0). Production code-signing = DESKTOP_SIGNING_REQUIRED (no cert). | `apps/desktop` (package:dir, verify:package) | `scripts/verify-package.mjs` (packaged-exe startup smoke) |
| REQ-DESKTOP-UPDATE-001 | Desktop auto-update + rollback | M1 §81 | NOT_STARTED — a signed auto-update channel needs a code-signing cert + an update-hosting service (DESKTOP_SIGNING_REQUIRED + external infra); rollback not yet designed. | — | — |
| REQ-DESKTOP-VM-001 | Desktop real-state view-model data layer (no fake green) | M2 §47 | IMPLEMENTED+TESTED (also consumed at runtime by the desktop shell) | `packages/desktop-viewmodels` (fail-closed; bundled into apps/desktop) | `desktop-viewmodels.test.ts` (15) + apps/desktop views smoke |
| REQ-DESKTOP-AGENTS-001 | Desktop Agents view | M2 §48 | IMPLEMENTED+TESTED (renders the real 72-role registry via the view-model; runtime smoke asserts it) | `apps/desktop` renderer | `smoke/views-smoke.cjs` |
| REQ-DESKTOP-KNOWLEDGE-001 | Desktop Knowledge view | M2 §49 | IMPLEMENTED+TESTED (knowledge-family nodes + skill registry, real state) | `apps/desktop` renderer | `smoke/views-smoke.cjs` |
| REQ-DESKTOP-LEARNING-001 | Desktop Learning view | M2 §50 | IMPLEMENTED+TESTED (evaluation/certification/sandbox nodes + certification state, real) | `apps/desktop` renderer | `smoke/views-smoke.cjs` |

| REQ-AUTOPILOT-STATES-001 | Runtime states (WAITING_PROVIDER/RETRY_SCHEDULED/...) | user 2026-10-04 | IMPLEMENTED+TESTED | `services/autopilot/lib/states.mjs` | `autopilot.test.mjs` |
| REQ-AUTOPILOT-STORE-001 | Durable job store (survives restart, atomic writes) | user 2026-10-04 | IMPLEMENTED+TESTED | `services/autopilot/lib/store.mjs` | `autopilot.test.mjs` |
| REQ-AUTOPILOT-SERVICE-001 | Session-independent scheduler + lifecycle (no LLM for deterministic) | user 2026-10-04 | IMPLEMENTED+TESTED | `services/autopilot/lib/service.mjs` | `autopilot.test.mjs` |
| REQ-AUTOPILOT-PROVIDER-001 | Provider availability -> WAITING_PROVIDER + bounded backoff; resume on return | user 2026-10-04 | IMPLEMENTED+TESTED | `services/autopilot/lib/provider.mjs`, `backoff.mjs` | `autopilot.test.mjs` |
| REQ-AUTOPILOT-MONITOR-001 | Independent Git/GitHub/PR/CI monitor (deterministic) | user 2026-10-04 | IMPLEMENTED+TESTED | `services/autopilot/lib/monitor.mjs` | `monitor.test.mjs` |
| REQ-AUTOPILOT-RECOVERY-001 | Crash/restart recovery, no duplicate commit/PR/merge | user 2026-10-04 | IMPLEMENTED+TESTED | `services/autopilot/lib/service.mjs` | `autopilot.test.mjs` |
| REQ-AUTOPILOT-CLI-001 | Lifecycle CLI start/stop/pause/resume/status/recover + PS1 wiring | user 2026-10-04 | IMPLEMENTED | `services/autopilot/cli.mjs`, `scripts/*-full-auto.ps1` | smoke-tested |
| REQ-AUTOPILOT-TESTS-001 | 5 restart/recovery proof tests | user 2026-10-04 | IMPLEMENTED+TESTED | `services/autopilot/test/autopilot.test.mjs` | 5/5 pass |
| REQ-AUTOPILOT-DESKTOP-001 | Desktop autopilot/provider/task/CI/recovery status | user 2026-10-04 | IMPLEMENTED (scaffold-connected) | `apps/desktop/*` | manual |

Legacy agent roles are additionally traced in `docs/AGENT-ROLE-MIGRATION-MAP.md`.

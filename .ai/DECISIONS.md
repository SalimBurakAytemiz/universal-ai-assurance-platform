# DECISIONS (append-only decision log)

- **2026-10-03** Canonical product = ONE product / ONE repository / ONE desktop. QA and
  Security are domains over one shared core, not separate repositories. (Master contract §0.)
- **2026-10-03** Execution model = dependency-aware continuous build graph, not phases.
- **2026-10-03** Stack = TypeScript monorepo (npm workspaces) + Vitest + Ajv; Electron for
  the desktop shell (Windows-first, cross-platform kept possible). Rationale: Node 24/npm 11
  already present; no Rust toolchain (Tauri needs cargo, not installed).
- **2026-10-03** The Trust Kernel is the single fail-closed authority (default DENY). The
  Policy Engine composes as an AND-gate that can only further restrict.
- **2026-10-03** Adapters are private to the Tool Broker; the Orchestrator exposes no adapter,
  broker, or kernel to agents — the no-direct-agent-to-target rule is structural, with a test.
- **2026-10-03** Repository = PRIVATE. Final license is a pending business/legal decision;
  conservative "all rights reserved" default committed meanwhile.
- **2026-10-03** 72 canonical agents are ROLE DEFINITIONS (9 guilds x 8), not 72 live LLMs.
  Agent != Model != Skill != Tool != Domain.
- **2026-10-04** Knowledge graph edges carry an explicit per-type IMPACT DIRECTION (forward/
  backward/both/none) instead of treating the graph as undirected. Change-impact, blast-radius
  and regression selection consult it — e.g. DEPENDS_ON propagates to the dependent only, so
  changing a dependency ripples to its consumers but not vice-versa. Rationale: directionless
  reachability over-reports and makes regression selection useless.
- **2026-10-04** Graph node/edge ids are CONTENT-ADDRESSED (sha256 of type+key / type+from+to),
  making graph construction idempotent and serialization deterministic (stable for hashing /
  provenance and for diffing a project's graph across scans).
- **2026-10-04** Execution-engine build order follows the master contract default
  A(API/contract) → B(web/Playwright) → C(database) → D(realtime) → E(performance) →
  F(accessibility/visual) → G(security sandbox) → H(mobile) → I(specialized), selected by
  dependency readiness + local installability + deterministic testability. Starting with the
  API/contract engine: zero external browser/device deps, Ajv already present, fully testable
  against local fixtures. Order may change if the real dependency graph proves another superior.

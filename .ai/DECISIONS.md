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
- **2026-10-06** Added `@uaap/engine-core`: the common execution-engine contract (discover → plan →
  validate-prereqs → execute → collect → evidence) + a total `driveEngine` runner (cancellation,
  timeout, health, structured EngineResult, never throws). Every assurance execution engine
  (Quality/Web/DB/Security/…) implements it, so the orchestrator/desktop treat engines uniformly.
- **2026-10-06** `@uaap/quality-api-engine` validates recorded request/response EXCHANGES against a
  contract and is OFFLINE-ONLY (no target I/O, nothing to authorize). Live exchanges will come from a
  broker-backed transport later; contract validation runs today against local fixtures. Dependency
  added: `ajv-formats@3.0.1` (MIT) for JSON-Schema format checks (email/date-time/uri/uuid).
- **2026-10-06** Execution-engine order altered (permitted by the contract): built the DATABASE
  validation engine (C) before the Web/Playwright engine (B). Reason: lowest external dependency +
  deterministic testability. Playwright needs a heavy browser-binary download via a separate
  `playwright install` step and a live browser runtime (unverified on this host; npm postinstall
  scripts are gated here). The read-only DB engine has ZERO external runtime dependency, validates a
  dataset snapshot against schema/constraints fully deterministically against local fixtures, and
  delivers immediate value. Web/Playwright is deferred until a browser runtime is confirmed
  installable; its offline portion (snapshot/accessibility validation) can be built first if not.
- **2026-10-06** `@uaap/quality-database-engine` is READ-ONLY by construction: it inspects a provided
  dataset snapshot (never connects to a DB, never mutates). Destructive migrations are flagged and
  require explicit approval (`allowDestructiveMigrations`), honoring "read-only by default".
- **2026-10-06** `@uaap/quality-realtime-engine` (engine D, realtime/event/queue) built with ALL
  robustness lessons from the API + DB engines baked in from the start: Array.isArray guards in
  discover/plan/execute, per-message/per-channel/per-event-spec isolation, safe Ajv compile,
  fail-closed ordering-mode vocabulary. Validates recorded message streams against channel contracts
  (event coverage, payload schema, headers, total/per-key sequence ordering + duplicates, delivery
  ack). Offline-only (captured streams; broker-backed subscriber later).
- **2026-10-06** `@uaap/quality-performance-engine` (engine E) validates recorded latency samples
  against bounded budgets (p50/p95/p99/max + error rate) per endpoint — OFFLINE, deterministic. It
  does NOT generate load (active load vs a target needs the target + authorization + k6 via the
  broker); it analyzes captured measurements. Fail-closed: a budget with no usable samples is
  UNVERIFIABLE, not a pass. Built with all robustness lessons baked in (array guards, per-sample
  isolation, duplicate-budget fail-closed, unknown-threshold vocabulary fail-closed).
- **2026-10-06** `@uaap/quality-accessibility-engine` (engine F) runs deterministic WCAG-style checks
  over captured page SNAPSHOTS (accessibility-tree-like element lists): image alt (alt="" is valid
  decorative), control labels, interactive accessible names, document lang, heading-order,
  duplicate ids, text contrast (WCAG luminance from provided fg/bg hex), and visual-regression
  (baseline vs current snapshot hash). OFFLINE (a Playwright capture transport would feed live
  snapshots later). Hardened: array guards, per-page/per-element isolation, duplicate-page
  fail-closed, malformed-color/element surfaced.
- **2026-10-06** `@uaap/security-appsec-engine` (engine G, security) is DETECTION-ONLY static analysis
  over LOCAL fixtures (source/config/headers/deps/TLS): hardcoded secrets (values REDACTED, never
  echoed), injection-prone patterns, insecure config, missing/permissive security headers,
  vulnerable deps (from PROVIDED advisories — never fetched), weak TLS. It executes nothing, sends
  no request, touches no live target — no Agent→Target path, nothing to authorize. Every finding is
  a detection SIGNAL that REQUIRES independent verification (detector is NOT a closure authority).
  Active validation against a real target remains a SEPARATE capability, security-active-validation-
  gate, LOCKED_BY_DESIGN. Test secret-like strings are assembled from fragments so no verbatim
  secret is committed (keeps the repo's own secret scanner green).
- **2026-10-06** `@uaap/research-intelligence` implements the SHARED local research pipeline for the
  technology-scout / standards-intelligence / advisory-intelligence nodes: ingestion, mandatory
  provenance (fail-closed), a certify-before-active lifecycle (findings admitted only as
  DISCOVERED/CANDIDATE — never self-certified/activated here; that is the knowledge/evaluation
  layer's authority), (kind,topic) supersede-by-recency, and a deterministic scheduler. LiveFetchGate
  ALWAYS returns BLOCKED_EXTERNAL_RESEARCH — no finding is ever fabricated; only PROVIDED local
  findings are ingested. Live external fetch stays BLOCKED_EXTERNAL_RESEARCH until a real fetcher is
  authorized/available.

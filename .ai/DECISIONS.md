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
- **2026-10-06** `@uaap/desktop-viewmodels` builds the REAL-state data layer behind the desktop views
  (Home/BuildGraph/Agents/Reviews/SecurityPosture) as pure, unit-tested derivations of .ai/* + the
  registries + the recorded test status — "no fake green dashboard": every value traces to state,
  absent state reads "unknown" (never "ok"), and security posture is FAIL-CLOSED (active validation
  reads LOCKED unless the real state says otherwise AND an authorization record exists; an
  inconsistency is surfaced, not hidden). The Electron window RENDERING of these view-models (the
  desktop-*-view nodes) still needs the desktop runtime to build/run and is not claimed here.

## 2026-10-06 — desktop-viewmodels adversarial review (PR #20, round 1): 8 confirmed defects fixed

An isolated adversarial workflow (27 agents: 3 review dimensions → 3-skeptic majority verify)
reviewed `@uaap/desktop-viewmodels` AFTER CI was already green. It confirmed 8 defects (all
unanimous 3/3) — exactly the fail-open / fake-green / crash-not-degrade failures the module exists
to prevent. CI green is NOT sufficient; the adversarial gate caught what the tests did not:

- **P1 fail-open (allow-list, not deny-list).** `securityPostureViewModel.locked` keyed on
  `=== "LOCKED_BY_DESIGN"`, so ANY other state value (typo, "", "PENDING", "enabled", stale) with a
  non-empty auth array read as UNLOCKED. Now unlock requires the state to be explicitly `ENABLED`
  AND a genuine authorization; every unrecognized state is LOCKED and surfaces an inconsistency.
- **P1 fail-open (genuine authorization).** `authorizationsPresent` was `Array.isArray && length>0`,
  so `[{}]`/`[null]`/`[0]`/`[""]`/an id-only stub masqueraded as a real authorization. Now each
  entry is structurally validated against `@uaap/core` `AuthorizationRecord` — non-empty `id` +
  `targetId` + at least one `allowedIdentifiers` entry (the "record + explicit scope" hard rule).
- **P2 fake-green on home.** `homeViewModel.activeSecurityValidation` passed the raw master state
  through (home badge read "ENABLED" with no auth). Now auth-gated to the effective posture.
- **P2 crash-not-degrade ×2.** `findRepoRoot()` and the `TEST_STATUS.md` `readFileSync` were outside
  try/catch; a packaged build or an EISDIR/EACCES/TOCTOU crashed the whole data layer. Both now
  degrade to the documented honest defaults.
- **P3 stale count.** `parseTestStatus` returned the FIRST doc match; now anchored to the
  authoritative `## Last local run` section.

Fixed with 5 new regression tests (13 in-package, 429/429 repo-wide). Decision: the authorization
check is a fail-closed STRUCTURAL check in the view-model (id+target+scope present), NOT a
re-implementation of the AuthorizationKernel's window/mode evaluation — the view-model's job is only
to refuse to render active validation as unlocked unless a genuine scoped record exists; the kernel
remains the authority for whether a specific action is permitted.

## 2026-10-06 — quality-web-engine built as an OFFLINE recorded-artifact validator (not a live driver)

The build graph's `quality-web-engine` node (QA §12, deps originally orchestrator + tool-adapter-
registry) was the last READY/buildable quality node. Decision: implement it the SAME way as every
sibling engine (api/database/realtime/performance/accessibility) — a deterministic, offline-only,
fail-closed validator over RECORDED web-interaction artifacts — rather than a live Playwright
driver. Rationale:
- Architectural consistency + hard rules: engines never touch a target directly (no Agent→Target);
  the accessibility engine already validates captured SNAPSHOTS, not a live browser. Driving a live
  browser is a tool-broker adapter gated behind an authorization, which stays locked here. The
  OFFLINE validation logic is what is technically executable in this environment, so it is what the
  node delivers; the live capture remains a documented gated boundary.
- Distinct scope (no overlap): functional web automation — navigation correctness (expected-URL
  exact + prefix glob), navigation error status, required-element presence/visibility, forbidden-
  element (error-state) detection, console errors, network failures, recorded step outcome — as
  opposed to accessibility (WCAG), api (contracts), performance (budgets).
- Node dependencies corrected to `["engine-core"]` (what the offline engine actually imports),
  matching the accessibility/performance siblings; the original orchestrator/tool-adapter deps
  reflected the never-built live-driver framing.
- FAIL-CLOSED / NO FAKE GREEN: an unrecorded required element or an expected-URL-with-no-actual is
  reported UNVERIFIABLE, never a silent pass. SECRET-SAFE BY CONSTRUCTION: URL query/fragment
  stripped before echoing; console/request bodies never echoed (only levels/statuses/methods/counts).

9 tests; `npm run verify` → 440/440 across 36 files. Adversarial review runs on the PR.

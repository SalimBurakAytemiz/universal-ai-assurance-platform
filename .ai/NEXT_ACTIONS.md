# NEXT ACTIONS

> Authoritative "what to do next". Updated at every validated checkpoint.

## Just completed
- **PR #21 — `@uaap/quality-web-engine`** (offline functional web engine over recorded flows). Validates
  recorded web-interaction artifacts (navigation/element/console/network/step-outcome), fail-closed,
  no Agent→Target; the live Playwright capture is a gated tool-broker adapter, not built here. 6
  isolated adversarial review rounds + a final confirmation → 14 confirmed defects, ALL fixed with
  regression tests — including a converged, leak-proof-by-construction `safeUrl` on the WHATWG parser
  (secret-safety hard rule). Merged squash `e0b3d42`. Post-merge verify: 452/452 across 36 files.
- (prev) PR #20 — `@uaap/desktop-viewmodels` (real-state view-model data layer, fail-closed), merged `8c9cbf9`.

## Build-graph status
**DONE 55 · READY 2 · BLOCKED 1 · NOT_STARTED 4.** Every pure-logic / offline-deterministic node is
DONE. The whole core (kernel/policy/audit/orchestrator/tool-broker), the full execution-engine layer
(api, web, database, realtime, performance, accessibility), the security appsec detection engine, the
knowledge graph, the research-intelligence pipeline, the autopilot durability chain, and the desktop
real-state data layer are all IMPLEMENTED+TESTED and merged. quality-web-engine was the LAST
offline-buildable node.

## Stopping boundary reached — remaining nodes need an external runtime or a human decision
None of the remaining nodes is technically executable/validatable in this environment without an
external runtime or a human/legal action. Per the contract, that is the only legitimate stop.

| Node | Status | Gate (why it cannot be truly completed here) |
|------|--------|-----------------------------------------------|
| `desktop-shell` | READY | Electron runtime — must build+run the app to validate rendering (not fakeable). |
| `desktop-agents-view` / `desktop-knowledge-view` / `desktop-learning-view` | NOT_STARTED | Electron runtime; consume the merged view-models. |
| `desktop-packaging` | NOT_STARTED | Windows build runtime; unsigned dev build OK, production = `DESKTOP_SIGNING_REQUIRED`. |
| `sandbox-learning` | READY | Sandbox execution runtime. |
| `security-active-validation-gate` | BLOCKED | `LOCKED_BY_DESIGN` — needs an explicit, signed, scoped human authorization in `.ai/security/`. Stays locked. |

## HUMAN_ACTION_REQUIRED (genuine external blockers only)
- **Electron / Playwright / sandbox runtimes** — to build+run+validate the desktop app, to drive the
  web engine's LIVE Playwright capture (the offline validator is built+tested; only live capture is
  gated), and sandboxed learning. Pure-logic layers they depend on are already built+tested.
- **`security-active-validation-gate`** — needs an explicit external-target authorization + scope
  record (`.ai/security/`). The security ENGINE, agents and lifecycle are already built and tested
  against local controlled fixtures; only ACTIVE validation is gated. Stays `LOCKED_BY_DESIGN`.
- **`DESKTOP_SIGNING_REQUIRED`** — production code-signing cert for signed installers (unsigned dev
  build is acceptable and ungated).
- **`FINAL_LICENSE_DECISION_REQUIRED`** — business/legal; conservative placeholder stays.
- **`BLOCKED_EXTERNAL_RESEARCH`** — live external fetch for the research pipeline (offline ingest +
  provenance + scheduler are built and tested; live fetch stays gated).

## On resume
Re-run the session-start procedure (`git status`/`log`, read `.ai/*`, `npm run verify`). If an
external runtime or a human authorization has since been provided, pick up the matching gated node
(e.g. Electron available → `desktop-shell`). Otherwise there is no new technically-executable node;
hold at this boundary rather than fabricating progress.

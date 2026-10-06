# NEXT ACTIONS

> Authoritative "what to do next". Updated at every validated checkpoint.

## Status — all technically-buildable nodes DONE
**Build graph: 62 DONE / 1 BLOCKED / 1 NOT_STARTED (64 total). verify: 477/477 across 38 files.**

This session the host was PROBED and the earlier "all remaining nodes are gated" conclusion was
DISPROVEN by actual attempted execution (`.ai/ENVIRONMENT_PROOF.md`). Everything buildable here was
then built AND runtime-validated:
- `sandbox-learning` (PR #22) — Node-child sandbox (Docker's safe local alternative); real timeout-kill,
  env isolation, audit; public surface total by construction.
- `desktop-shell` + `desktop-agents/knowledge/learning-view` (PR #23) — Electron shell consuming the
  reviewed `@uaap/desktop-viewmodels`; full-app headless views-smoke renders real state (exit 0).
- `desktop-packaging` (PR #24) — dev/unsigned Windows build; the packaged `UAAP.exe` self-validates
  (startup smoke exit 0).
- `quality-web-live-adapter` (PR #25) — Playwright live capture against LOCAL fixtures only
  (SSRF-safe, fail-closed), routed through the fail-closed web engine; live smoke exit 0.

## Remaining — PROVEN blockers only (external runtime / human / legal)
| Node / item | State | Proven blocker |
|-------------|-------|----------------|
| `security-active-validation-gate` | BLOCKED | LOCKED_BY_DESIGN — needs a signed, scoped human authorization record in `.ai/security/`. Engine/agents/lifecycle already built + tested on local fixtures. |
| `desktop-update-rollback` | NOT_STARTED | Signed auto-update channel needs a code-signing certificate + an update-hosting service (`DESKTOP_SIGNING_REQUIRED` + external infra). |
| Production desktop code-signing | — | `DESKTOP_SIGNING_REQUIRED` — no certificate present; cannot be safely synthesized. Dev/unsigned build is done + validated. |
| Final product license | — | `FINAL_LICENSE_DECISION_REQUIRED` — business/legal; conservative all-rights-reserved default stays. |
| Live external research fetch | — | `BLOCKED_EXTERNAL_RESEARCH` — offline research pipeline is built + tested; live fetch gated. |

## On resume
Re-run the session-start procedure (`git status`/`log`, read `.ai/*`, `npm run verify`). There is no
remaining node that is technically executable on this host without one of the proven blockers above
being lifted (a signing cert, an authorization record, an update-hosting service, or a legal
decision). If one is provided, pick up the matching node. Otherwise, do not fabricate progress.

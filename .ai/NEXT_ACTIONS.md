# NEXT ACTIONS

> Authoritative "what to do next". Updated at every validated checkpoint.

## Status — Release Candidate v0.9.0-rc.1 FROZEN (ACCEPT AS RC — NOT GA)

**PR #26 merged into `main` as `307cb8a78b64404f9ada58b79277385e33b8546f`** (squash of the reviewed
HEAD `9f56ca4`; trees byte-identical → reviewed == merged). **main CI: success.** Post-merge verify on
main: **500/500 across 39 files**; validators + typecheck OK. Build graph **62 DONE / 1 BLOCKED / 1
NOT_STARTED**, **0 false DONEs**. Tag: **`v0.9.0-rc.1`**. Full report:
`.ai/FINAL_SYSTEM_ACCEPTANCE_REPORT.md`; evidence: `.ai/ACCEPTANCE_EVIDENCE.md`.

The final independent audit + 3-round adversarial review fixed every P0/P1 (and all but one documented
P2) and hardened the trust kernel, broker, release-gate, SoD identity, autopilot, and desktop renderer.
No security gate was weakened; the active-validation gate stayed LOCKED_BY_DESIGN.

Agent certification: **72 defined, 0 certified** — the correct pre-certification state. Certification
requires a real evaluation benchmark (not executed; not fabricated). See MASTER_STATE.agentCertification.

## Remaining — PROVEN blockers only (external runtime / human / legal). The RC is frozen; these are GA gates.
| Item | State | Blocker |
|------|-------|---------|
| `security-active-validation-gate` | BLOCKED | LOCKED_BY_DESIGN — needs a signed, scoped human authorization record in `.ai/security/`. |
| `desktop-update-rollback` | NOT_STARTED | Signed auto-update channel needs a code-signing certificate + an update-hosting service. |
| Production desktop code-signing | — | `DESKTOP_SIGNING_REQUIRED` — no certificate present. Dev/unsigned build is done + validated. |
| Final product license | — | `FINAL_LICENSE_DECISION_REQUIRED` — business/legal; all-rights-reserved default stays. |
| Live external research fetch | — | `BLOCKED_EXTERNAL_RESEARCH` — offline pipeline built + tested; live fetch gated. |
| Agent certification to CERTIFIED/ACTIVE | — | Needs a real per-agent evaluation benchmark; must not be faked. |

## On resume
Re-run the session-start procedure (`git status`/`log`, read `.ai/*`, `npm run verify`). The RC is
frozen at `v0.9.0-rc.1`. There is no remaining node technically executable on this host without one of
the proven blockers above being lifted (a signing cert, an authorization record, an update-hosting
service, a legal decision, or an evaluation benchmark). If one is provided, pick up the matching work.
Otherwise, do not fabricate progress.

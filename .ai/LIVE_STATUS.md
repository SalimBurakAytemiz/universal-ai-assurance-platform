# LIVE STATUS

- **Release candidate: v0.9.0-rc.1** — ACCEPTED after a final independent system audit
  (`.ai/FINAL_SYSTEM_ACCEPTANCE_REPORT.md`). RC, not GA: signing / active-validation / license gated.
- Build graph: 64 nodes — **62 DONE, 1 BLOCKED (by design), 1 NOT_STARTED (gated)**. 0 false DONEs.
- Last verify: **500/500 tests PASS (39 files)**; typecheck OK; validators OK.
- Final adversarial review (3 rounds): 20 issues (P0×1, P1×7, P2×7, P3×5) — 19 fixed + regressed, 1
  accepted + documented. Open: P0 0 / P1 0 / P2 1 (accepted) / P3 0. No gate weakened.
- Active security validation: LOCKED_BY_DESIGN (unchanged, correct — hardened, never unlocked).
- GitHub: PRIVATE; PRs #2–#25 merged; RC audit PR in flight on `audit/final-acceptance-rc`.
- Host runtimes PROVEN this session (`.ai/ENVIRONMENT_PROOF.md`): Electron v32.3.3 (desktop shell +
  views + dev package all runtime-validated headless), Chrome + Edge (Playwright live capture),
  Node-child sandbox (Docker's safe local alternative), npm registry reachable. No native toolchain.
- EVERY technically-buildable node on this host is DONE. Remaining non-DONE nodes have PROVEN blockers:
  - `security-active-validation-gate` — BLOCKED, LOCKED_BY_DESIGN (needs a signed, scoped human
    authorization record in `.ai/security/`). The security engine/agents/lifecycle are built + tested
    against local fixtures; only ACTIVE external-target validation is gated.
  - `desktop-update-rollback` — NOT_STARTED; a signed auto-update channel needs a code-signing
    certificate + an update-hosting service (DESKTOP_SIGNING_REQUIRED + external infra).
- Also human/legal: FINAL_LICENSE_DECISION_REQUIRED (conservative all-rights-reserved default stays).

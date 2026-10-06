# TEST STATUS

Recorded from ACTUAL local runs (never hand-written as "pass").

## Last local run — 2026-10-07 (main @ 307cb8a, post-merge RC closure)

Command: `npm run verify` (validate → typecheck → test), run on `main` after PR #26 merged.

- Merged main commit: **`307cb8a78b64404f9ada58b79277385e33b8546f`** (squash of reviewed HEAD
  `9f56ca4`; trees byte-identical). **main CI: success.** Tag: `v0.9.0-rc.1`.
- validate: **OK**   typecheck (`tsc --noEmit`): **OK**
- vitest: **500 passed / 500** across **39 files** (0 failed, 0 skipped).

New this change:
- `tests/acceptance/e2e-acceptance.test.ts` (**14 tests**) — full end-to-end acceptance over a synthetic
  project: real Quality (web) + Security (appsec) engines → evidence bundle + tamper detection →
  verification (SoD) → remediation (SoD) + retest → release gate (all four decisions). Proves PASS +
  intentional FAIL and that `RELEASE_ALLOWED` is reached ONLY after a real
  detect→verify→remediate→retest→close→clean-re-run arc.
- Adversarial-review regression tests across the hardened surfaces: kernel (action→class binding, env
  consistency, trusted-clock expiry), broker (lease-scope enforcement, trusted clock), release-gate
  (case + Unicode self-approval), autopilot store (no cross-writer tmp race), plus the existing SoD and
  boundary suites.

Desktop smokes (Electron 32.3.3): `npm run smoke` exit 0, `npm run views` exit 0 (all checks true,
agentsTotal 72, securityLocked true, build graph 62/64, certified 0 — real state, no fake green).

Build graph: 64 nodes — **DONE 62, BLOCKED 1** (security-active-validation-gate, LOCKED_BY_DESIGN),
**NOT_STARTED 1** (desktop-update-rollback — gated). 0 false DONEs (structural audit).

## Final adversarial review (3 bounded rounds — see `.ai/ACCEPTANCE_EVIDENCE.md` §15)
20 issues found (P0×1, P1×7, P2×7, P3×5); 19 fixed + regressed; 1 accepted + documented (full Unicode
case folding on the SoD identity sanity-guard). **Open after remediation: P0 0 / P1 0 / P2 1 (accepted)
/ P3 0.** No security gate was weakened — every fix strengthened a gate. The active-validation gate
stayed LOCKED_BY_DESIGN.

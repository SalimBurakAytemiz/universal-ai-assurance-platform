# Universal AI Assurance Platform — v0.9.0-rc.1 (Release Candidate)

**Date:** 2026-10-07 · **Status:** Release Candidate (not a production release) · **Visibility:** private

This is the first release candidate, cut after a full independent system audit and release-candidate
acceptance pass. It is a local-first, fail-closed AI software **assurance** platform (Quality and
Security as domains over one shared core). It is defensive QA/security tooling — never offensive
tooling, never a provider-safety bypass.

## What this RC is
- One product, one repository, one desktop application, 32 `@uaap/*` workspace packages + an Electron
  desktop shell + a session-independent autopilot service.
- Verified on this host: `npm run verify` → validators OK, typecheck OK, **500 tests / 39 files PASS**
  (0 failed, 0 skipped). Desktop headless + views smokes exit 0 rendering real state. Dev/unsigned
  Windows package builds and self-validates on startup.

## Highlights
- **Fail-closed trust architecture, hardened.** A final adversarial review found and fixed a P0
  authorization bypass (self-asserted passive class) plus the P1/P2 cluster around it; the kernel now
  binds an action's risk class to the trusted catalog, enforces request/target environment
  consistency, evaluates expiry against a trusted clock, and the broker enforces lease scope. No
  security gate was weakened — every fix strengthened one.
- **Earned-green release gate.** The end-to-end acceptance test proves the composed platform returns
  `RELEASE_ALLOWED` only after a real detect→verify→remediate→retest→close→clean-re-run arc, and blocks
  on an open finding, a failed domain, or a tampered evidence bundle.
- **No fake anything.** Status is reported truthfully everywhere: 72 agents defined, 0 certified (all
  DRAFT); the desktop renders real backend state (no fabricated counters or optimistic green).

## Acceptance summary (see `.ai/FINAL_SYSTEM_ACCEPTANCE_REPORT.md`)
- Build graph: 62 DONE / 1 BLOCKED (security-active-validation-gate, by design) / 1 NOT_STARTED
  (desktop-update-rollback, gated). 0 nodes reopened (0 false DONEs).
- 72-agent registry: 72 unique across 9 guilds × 8; 0 separation-of-duties violations; 0 prohibited
  (R3) ceilings; all skill references resolve.
- Final adversarial review (3 rounds): 20 issues found (P0×1, P1×7, P2×7, P3×5); 19 fixed + regressed,
  1 accepted + documented (SoD identity full-Unicode case folding — a sanity-guard refinement).

## Install / run (dev)
```bash
npm install
npm run verify           # validators + typecheck + 500 tests
cd apps/desktop && npm install && npm run smoke   # headless desktop smoke (exit 0)
```

## Known limitations & external blockers (do not treat as production-complete)
- **Active external-target security validation is LOCKED_BY_DESIGN** — needs a signed, scoped human
  authorization record in `.ai/security/`. The engine/agents/lifecycle are built and tested against
  local fixtures only.
- **No production code-signing** — `DESKTOP_SIGNING_REQUIRED`; the attached artifact is a dev/UNSIGNED
  Windows build. Signed auto-update + rollback are not started (need a certificate + update host).
- **Final product license** is a business/legal decision (default: all rights reserved).
- **Dev/build-toolchain advisories** (vitest/vite/esbuild, electron-packager) exist but are not shipped
  in the product runtime (`npm audit --omit=dev` = 0). See `docs/release/v0.9.0-rc.1/ARTIFACT_HASHES.md`.
- **No live external research fetch** — the offline research pipeline is built/tested; live fetch is
  gated.

## Artifacts
- SBOM: `docs/release/v0.9.0-rc.1/SBOM.json` (CycloneDX 1.5).
- Artifact hashes: `docs/release/v0.9.0-rc.1/ARTIFACT_HASHES.md`.
- Dev/unsigned desktop package evidence: `.ai/PACKAGING_EVIDENCE.json`.

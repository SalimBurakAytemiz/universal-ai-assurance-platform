# Changelog

All notable changes to the Universal AI Assurance Platform are recorded here. This project adheres to
[Semantic Versioning](https://semver.org/). Dates are UTC.

## [0.9.0-rc.1] — 2026-10-07

First release candidate. Produced by a final, independent system audit and release-candidate
acceptance pass over the whole repository. See `.ai/FINAL_SYSTEM_ACCEPTANCE_REPORT.md` and
`.ai/ACCEPTANCE_EVIDENCE.md` for the full executed evidence.

### Added
- **Full end-to-end acceptance harness** (`tests/acceptance/e2e-acceptance.test.ts`, 14 tests): a
  synthetic project driven through the real composed pipeline — Quality (web) + Security (appsec)
  engines → evidence bundle (with tamper detection) → independent verification (SoD) → remediation
  (SoD) + retest → release gate (all four decisions). Proves the platform produces both a PASS and an
  intentionally-detected FAIL, and reaches `RELEASE_ALLOWED` only after a real
  detect→verify→remediate→retest→close→clean-re-run arc (green is earned, not defaulted).
- Executed acceptance evidence index (`.ai/ACCEPTANCE_EVIDENCE.md`), CycloneDX SBOM, release notes, and
  artifact-hash records under `docs/release/v0.9.0-rc.1/`.

### Security (final adversarial review — all P0/P1 fixed and regressed)
- **Trust kernel:** the effective action class is now bound to the authoritative action→class catalog
  (`max(declared, canonical)`); a caller can no longer self-assert `R0_PASSIVE` to skip the
  authorization gates for a target-touching action (**P0**). Added request/target environment
  consistency enforcement (**P1**) and a trusted-clock authorization-window check that ignores
  caller-supplied `request.now` (**P1**). Decision records are stamped from the trusted clock.
- **Tool broker:** lease scope is now ENFORCED at execute time (`identifiers ⊆ lease.scope`, **P2**);
  lease expiry uses the trusted clock; all broker audit events are trusted-clock stamped.
- **Release gate / verification / remediation:** separation-of-duties identity comparison now uses a
  shared `canonicalIdentity()` (NFKC + invisible-character stripping + case-fold), closing
  case-variant and Unicode-re-encoding self-approval bypasses (**P1**).
- **Autopilot:** the single-instance lock is released in a `finally` covering recover/resume/loop
  (**P2**); the atomic-write tmp sweep that raced concurrent control-file writers was removed, keeping
  only race-free unlink-on-failure (**P2**).
- **Desktop renderer:** `healthColor` no longer paints non-healthy statuses green via substring match
  (tokenized allow-list + negation guard, **P2**); the nav no longer badges `NOT AVAILABLE` views as
  green "live".
- **Live web adapter:** the `.test` TLD was dropped from the local allow-list (Chrome does not pin it
  to loopback — it was an SSRF vector, **P3**).

### Changed
- Root package version set to `0.9.0-rc.1`.
- Corrected a stale `.ai/KNOWN_ISSUES.md` entry that wrongly described the assurance engines as
  unbuilt; all engines are IMPLEMENTED+TESTED (traceability matrix reconciled).

### Known limitations / blockers (unchanged by design)
- `security-active-validation-gate` stays **LOCKED_BY_DESIGN** — authorized active validation against a
  real target requires a signed, scoped human authorization record.
- Production desktop code-signing + signed auto-update (`desktop-update-rollback`) require a
  code-signing certificate and an update-hosting service (not present). The dev/unsigned Windows build
  is produced and startup-validated.
- Final product license is a business/legal decision (default: all rights reserved).
- Dev/build toolchain carries `npm audit` advisories (vitest/vite/esbuild, electron-packager) that are
  NOT shipped in the product runtime (`npm audit --omit=dev` = 0 vulnerabilities).
- SoD identity comparison is a sanity guard; full Unicode case folding is approximated (documented).

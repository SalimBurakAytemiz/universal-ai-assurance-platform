# TEST STATUS

Recorded from ACTUAL local runs (never hand-written as "pass").

## Last local run — 2026-10-06 (branch auto/desktop-packaging)

Command: `npm run verify` (validate → typecheck → test) + the desktop packaging build + smoke.

- validate: **OK**   typecheck (`tsc --noEmit`): **OK**
- vitest: **471 passed / 471** across 37 files (unchanged — apps/desktop is not in the root
  vitest/tsconfig; its validation is real Electron runtime + packaging smokes, below)

Desktop packaging (dev/unsigned) — REAL build + startup validation on this Windows host:
- `npm run package:dir` (@electron/packager) → `dist/UAAP-win32-x64/UAAP.exe` (186 MB, electron
  32.3.3, **unsigned**). The packaged `resources/app/` contains the real src + the reviewed
  @uaap/desktop-viewmodels bundle.
- `npm run verify:package` → `PACKAGE_VERIFY_OK` (exit 0). It hashes the artifact
  (sha256 ed17ab79…), reads version metadata, and — the STARTUP VERIFICATION — launches the
  PACKAGED `UAAP.exe` with `UAAP_SMOKE=1 UAAP_REPO_ROOT=<repo>`; the packaged binary rendered the
  real repo state (exit 0, all view checks true, agents 72, security LOCKED). Evidence recorded in
  `.ai/PACKAGING_EVIDENCE.json`.
- PRODUCTION CODE-SIGNING + signed auto-update = `DESKTOP_SIGNING_REQUIRED` (no cert; cannot be
  safely synthesized).
- Shared startup-smoke logic (`src/views-check.js`) is reused by the dev views smoke (`npm run views`,
  exit 0) and the packaged-app `UAAP_SMOKE` mode — one assertion source, no divergence.

Build graph: 62 nodes — **DONE 61, BLOCKED 1** (security-active-validation-gate, LOCKED_BY_DESIGN).
Every technically-buildable node on this host is now DONE. Remaining: the by-design security gate
(signed scoped authorization), production code-signing (certificate), final license (legal).

P0/P1/P2/P3 open on this change: 0 / 0 / 0 / 0 (pre-PR; adversarial review runs on the PR).

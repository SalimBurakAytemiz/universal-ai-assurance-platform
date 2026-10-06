# TEST STATUS

Recorded from ACTUAL local runs (never hand-written as "pass").

## Last local run — 2026-10-06 (branch auto/quality-web-live-adapter)

Command: `npm run verify` (validate → typecheck → test) + the live-capture browser smoke.

- validate: **OK**   typecheck (`tsc --noEmit`): **OK**
- vitest: **476 passed / 476** across 38 files (+ quality-web-live-adapter: 5 CI-safe unit tests)

New this change — `@uaap/quality-web-live-adapter`: the LIVE capture front-end for the offline
`@uaap/quality-web-engine`.
- Drives the INSTALLED Chrome via `playwright-core` (`channel:"chrome"`, headless — no browser
  download) against a LOCAL fixture ONLY. FAIL-CLOSED: `isLocalTarget` refuses any non-local/external
  target (incl. cloud-metadata IPs) BEFORE launch — no Agent→Target, no customer target possible.
- Captures navigation / element presence+visibility / console LEVELS (never text — secret-safe) /
  network metadata, converts to the engine's `WebFlow`, and routes through the fail-closed engine.
- CI-safe pure tests (5): the local-target allow-list, `toLocalUrl`, and capture→engine routing on a
  hand-built captured flow (broken ⇒ planted findings; clean ⇒ zero). NO browser → runs in CI.
- Real browser validation (`npm run live`, exit 0, committed `smoke/live-capture.mjs`): the broken
  fixture yields `required-element-missing` + `forbidden-element-present` + `console-error`; the clean
  fixture yields ZERO findings. End-to-end live-capture → fail-closed engine, proven on this host
  (see `.ai/ENVIRONMENT_PROOF.md`).

Build graph: 64 nodes — **DONE 62, BLOCKED 1** (security-active-validation-gate, LOCKED_BY_DESIGN),
**NOT_STARTED 1** (desktop-update-rollback — signed update channel + update server = gated). Every
node that is technically buildable on this host is now DONE.

P0/P1/P2/P3 open on this change: 0 / 0 / 0 / 0 (pre-PR; adversarial review runs on the PR).

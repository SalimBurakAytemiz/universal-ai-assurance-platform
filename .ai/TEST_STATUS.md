# TEST STATUS

Recorded from ACTUAL local runs (never hand-written as "pass").

## Last local run — 2026-10-06 (branch auto/quality-web-live-adapter)

Command: `npm run verify` (validate → typecheck → test) + the live-capture browser smoke.

- validate: **OK**   typecheck (`tsc --noEmit`): **OK**
- vitest: **477 passed / 477** across 38 files (+ quality-web-live-adapter: 6 CI-safe unit tests incl. SSRF regression)

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

Adversarial review round 1 (PR #25, 14 agents) confirmed 4 defects — ALL fixed: 2×P1 SSRF bypasses
(isLocalTarget accepted file://REMOTE-host and //host / \\host UNC forms → Windows SMB/NTLM leak; now
refused, host-checked; toLocalUrl re-verifies the resolved host); P2 fail-open navigation (only the
initial goto was checked → added a Playwright route guard that aborts ANY non-local request incl.
redirects/clicks, + a post-nav locality check); P2 fail-open capture (forbids `.catch(()=>false)`
turned an errored check into a silent pass → presence helpers now return undefined on error so the
engine surfaces forbidden-unverifiable). Re-validated: 6 CI unit tests (incl. SSRF regression) + live
smoke exit 0. P0/P1/P2/P3 open: 0 / 0 / 0 / 0. Re-review runs on the fix commit.

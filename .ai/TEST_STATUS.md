# TEST STATUS

Recorded from ACTUAL local runs (never hand-written as "pass").

## Last local run — 2026-10-06 (branch auto/desktop-shell-views)

Command: `npm run verify` (validate → typecheck → test) + the Electron runtime smoke.

- validate: **OK** (policies, build graph, agents, skills, adapters, domains, knowledge, state)
- typecheck (`tsc --noEmit`): **OK**
- vitest: **471 passed / 471** across 37 files (unchanged — the desktop app is not in the root
  vitest/tsconfig; its validation is a real Electron runtime smoke, below)

Desktop shell + Agents/Knowledge/Learning/Security views — REAL Electron runtime validation
(`apps/desktop`, `npm run views`): launches the production app surface headless (real preload +
renderer), registers the same IPC state handler main.js uses (src/state.js), waits for the renderer
to receive real state, drives each view, and asserts the DOM reflects the COMPUTED real view-model
values. Result (exit 0):
`VIEWS_RESULT:{"ok":true,"checks":{...all true},"agentsTotal":72,"securityLocked":true,"homeDone":60,"homeTotal":62}`
(assertions are card-scoped via DOM + ground-truth-anchored — agents total ===72, a known knowledge
node id must render, security State card === the real posture — so a view collapsing to empty fails.)

- The desktop consumes the REVIEWED @uaap/desktop-viewmodels (bundled via esbuild to
  apps/desktop/vendor/, gitignored, rebuilt on demand) — no re-implemented logic, no fake green.
  Agents shows the real 72-role registry; Security is FAIL-CLOSED (LOCKED, no authorization);
  Knowledge/Learning render real build-graph + certification state.
- Electron headless smoke (`npm run smoke`, apps/desktop/smoke/headless-smoke.cjs) also passes
  (exit 0): app ready, BrowserWindow created, page loaded, clean shutdown — the shell lifecycle.
- CI (root) cannot run Electron (separate npm root, no browser binary / display on the Linux
  runner), so this runtime validation is the committed, reproducible LOCAL smoke; the pure
  view-model logic it depends on is covered by the root vitest suite (desktop-viewmodels, 15 tests).

Environment blocker-proof: `.ai/ENVIRONMENT_PROOF.md` (Electron v32.3.3 proven to run here).

Build graph: 62 nodes — DONE 60, BLOCKED 1 (security-active-validation-gate, LOCKED_BY_DESIGN),
NOT_STARTED 1 (desktop-packaging — dev build attempt next).

Adversarial review round 1 (PR #23, 17 agents) confirmed 5 defects — ALL fixed: 3 fake-green
(learningView showed green "0" when REVIEW_STATE absent -> now "unknown"/muted via the guarded
reviews view-model, summing ALL severities; systemHealth hardcoded green -> color now derives from
the value; home bundle-absent fallback showed the raw master state -> now fail-closed
"LOCKED_BY_DESIGN"); 2 weak smoke assertions (agentsCertified + knowledgeRendered were trivially
satisfied by static copy -> now card-scoped DOM reads + a required known knowledge node id).
Re-validated: npm run views exit 0, all card-scoped checks true. P0/P1/P2/P3 open: 0 / 0 / 0 / 0.
Re-review runs on the fix commit.

# ENVIRONMENT PROOF — attempted-execution evidence for every "runtime" blocker

Per the BLOCKER PROOF RULE: a node may only remain HUMAN_ACTION_REQUIRED / EXTERNAL_RUNTIME_BLOCKED
after every safe local/project-scoped install/configuration has been ATTEMPTED and the exact result
recorded. This file is the evidence. "Runtime missing" is not, by itself, a proven blocker.

## Host facts (probed 2026-10-06)

| capability | result | how probed |
|------------|--------|-----------|
| OS / arch | Windows 10 (10.0.19045), x64, 8 CPU, 17 GB | `node -e os` |
| Node / npm | Node v24.19.0 / npm 11.17.0 | `node -v`, `npm -v` |
| npm registry | REACHABLE | `npm view electron version` → 44.5.1 |
| pnpm / yarn | absent | `pnpm -v` / `yarn -v` |
| Docker | **NOT INSTALLED** | `docker --version` → not found |
| Python | 3.13.14 | `python --version` |
| native toolchain | **absent** (no cl/gcc/make) | `where cl` / `where gcc` / `where make` |
| Google Chrome | **PRESENT** `C:\Program Files (x86)\Google\Chrome\Application\chrome.exe` | file probe |
| Microsoft Edge | **PRESENT** `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe` | file probe |
| Electron | **INSTALLED + RUNS HEADLESS** (see below) | project-local install + smoke |

## Per-node blocker resolution

### Electron runtime — PROVEN AVAILABLE (substantiated by a committed, runnable smoke)
1. Required: Electron runtime (for desktop-shell, the desktop views, and dev packaging).
2. Attempt: project-local install in `apps/desktop` (electron ^32 already declared).
3. Command: `cd apps/desktop && npm install`.
4. Result: exit 0; `node_modules/electron/dist/electron.exe` present (186 MB); `electron --version` → `v32.3.3`.
5. Runtime smoke (headless, no desktop session), committed + reproducible at
   `apps/desktop/smoke/headless-smoke.cjs` (run via `npm run smoke` in apps/desktop): creates a
   `BrowserWindow({show:false})`, loads a `data:` page, evaluates renderer JS, reads it back, exits 0 →
   `SMOKE_RESULT:{"ok":true,"ready":true,"windowCreated":true,"loaded":true,...}`.
6. Conclusion for desktop-shell / desktop-*-view: **NOT BLOCKED — now RUNTIME-VALIDATED.** The full
   app surface was launched headless and every view asserted to render the COMPUTED real view-model
   state (`apps/desktop`, `npm run views`, committed at `apps/desktop/smoke/views-smoke.cjs`, exit 0):
   home 56/62 done, agents 72 (real registry), security LOCKED (fail-closed), knowledge/learning real.
   desktop-shell + the three views are DONE (runtime-validated).
7. Packaging — **dev/unsigned build PROVEN** (`.ai/PACKAGING_EVIDENCE.json`): `@electron/packager`
   produced `dist/UAAP-win32-x64/UAAP.exe` (186 MB, electron 32.3.3, unsigned) on this host, and the
   PACKAGED binary was launched in startup-smoke mode (`UAAP_SMOKE=1 UAAP_REPO_ROOT=<repo>`) and
   rendered the real repo state (exit 0, all view checks true, agents 72, security LOCKED). PRODUCTION
   CODE-SIGNING + a signed auto-update channel remain `DESKTOP_SIGNING_REQUIRED` — no code-signing
   certificate is present and none can be safely synthesized.

### sandbox-learning — Docker absent → safe local alternative used: RESOLVED
1. Required: an isolated execution runtime.
2. Attempt: `docker --version` → not installed. No safe automatic Docker install on this host.
3. Alternative attempted + ADOPTED: a Node `child_process` sandbox (`@uaap/sandbox-learning`) —
   dedicated per-run temp workspace, controlled env allow-list (no inherited secrets), wall-clock
   timeout → SIGKILL, output caps, artifact capture, deterministic cleanup, content-addressed audit
   trail, fail-closed task allow-list.
4. Result: **IMPLEMENTED + TESTED with real execution** — 9 tests incl. a real timeout-kill, a real
   crash capture, proven env isolation, and the outcomes fed into `@uaap/agent-evaluation`.
5. Honest limitation (recorded, not hidden): a Node child is NOT an OS jail — it bounds
   time/output/env/cwd but cannot stop a task touching the wider filesystem; the built-in
   `write-outside` probe measures and reports this, and `audit.osLevelIsolation` is always `false`.
   Only trusted, allow-listed synthetic tasks run here. True adversarial-code isolation needs a
   container/VM runtime (a Docker/OCI backend can be added behind the same interface later).
6. Conclusion: **NOT BLOCKED** for the platform's synthetic learning/eval tasks.

### playwright live-capture adapter — PROVEN (local-fixture only)
1. Required: Playwright + a browser.
2. Attempt: `playwright-core` installed project-local (lightweight — NO browser download); launched the
   ALREADY-INSTALLED Chrome via `chromium.launch({ channel: "chrome", headless: true })`.
3. Result: headless launch + page load + DOM/console/network capture all work (probe exit 0).
4. Adapter (`@uaap/quality-web-live-adapter`): drives a LOCAL fixture ONLY (fail-closed allow-list
   refuses any non-local/external target before launch), captures navigation/element/console/network,
   converts to the engine's WebFlow, and routes through the fail-closed @uaap/quality-web-engine.
5. Live smoke (`npm run live`, exit 0): the broken fixture yields the planted findings
   (required-element-missing, forbidden-element-present, console-error); the clean fixture yields ZERO.
   Pure routing + allow-list are unit-tested in the root suite (5 tests, no browser) so CI covers them.
6. Conclusion: **NOT BLOCKED.** Live capture against local fixtures is built + runtime-validated here.
   No external customer target is ever required or permitted.

### security-active-validation-gate — LOCKED_BY_DESIGN (unchanged)
Genuine, non-automatable: needs an explicit, signed, scoped human authorization record in
`.ai/security/`. NOT a runtime blocker; never unlocked by local/sandbox fixtures.

### FINAL_LICENSE_DECISION_REQUIRED — human/legal (unchanged)
Does not block technical work; conservative all-rights-reserved placeholder stays.

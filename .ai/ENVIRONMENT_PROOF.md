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

### desktop-shell / desktop-*-view / desktop-packaging — Electron: PROVEN AVAILABLE
1. Required: Electron runtime.
2. Attempt: project-local install in `apps/desktop` (electron ^32 already declared).
3. Command: `cd apps/desktop && npm install`.
4. Result: exit 0; `node_modules/electron/dist/electron.exe` present (186 MB); `electron --version` → `v32.3.3`.
5. Runtime smoke (headless, no display): a standalone script created a `BrowserWindow({show:false})`,
   loaded a `data:` page, evaluated renderer JS, read it back, and shut down cleanly →
   `SMOKE_RESULT:{"ok":true,"ready":true,"windowCreated":true,"loaded":true,...,"ms":667}` exit 0.
6. Conclusion: **NOT BLOCKED.** Electron builds AND runtime-validates on this host headlessly.
   Desktop shell, the three desktop views, and a dev (unsigned) package are all technically
   executable here and are being implemented + runtime-validated. Only PRODUCTION CODE-SIGNING
   (`DESKTOP_SIGNING_REQUIRED`) remains a credential blocker — a signing cert is not present and
   cannot be safely synthesized.

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

### playwright live-capture adapter — ATTEMPT PENDING (Chrome present; npm reachable)
Chrome is installed and npm is reachable, so a project-local Playwright install + a local-fixture
headless capture is expected to be feasible. Attempt + exact result recorded in its own PR.

### security-active-validation-gate — LOCKED_BY_DESIGN (unchanged)
Genuine, non-automatable: needs an explicit, signed, scoped human authorization record in
`.ai/security/`. NOT a runtime blocker; never unlocked by local/sandbox fixtures.

### FINAL_LICENSE_DECISION_REQUIRED — human/legal (unchanged)
Does not block technical work; conservative all-rights-reserved placeholder stays.

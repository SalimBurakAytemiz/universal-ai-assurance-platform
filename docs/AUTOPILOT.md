# Session-Independent Autopilot

A persistent **local automation service** that survives Claude session limits, UI closure, and
model unavailability. It is a real, runnable Node process (`services/autopilot/`, zero build, zero
deps) — not documentation. The Claude session is one *AI executor* that can attach to it; the
service itself keeps running without one.

## Guarantees (and what it must NOT do)
- Persists every job and its state to a durable store (`.ai/autopilot/jobs.json`, atomic writes).
- Monitors Git/GitHub/PR/CI **deterministically** (shells to `git`/`gh`, no LLM).
- Runs deterministic jobs with **no LLM**; AI-dependent jobs are delegated to an injected executor.
- Detects provider unavailability and parks AI work in `WAITING_PROVIDER` instead of losing it;
  resumes it when the provider returns. Retries AI tasks with **bounded exponential backoff**.
- Survives process restart; recovers from the durable store; **never re-runs DONE work**. A
  side-effecting job that crashed mid-run (left `RUNNING`) is **not** auto-rerun — it goes to
  `WAITING_APPROVAL` and is resolved by an injected `reconcile` hook (which checks "did the
  commit/PR/merge already happen?") or by an operator, so no commit/PR/merge is duplicated.
- Durable store is crash-safe (atomic write + fsync + `.bak`); a **corrupt store is never
  silently emptied or overwritten** — it is renamed to `.corrupt.<ts>` and the service refuses to
  start. Control (pause/resume/stop) lives in a separate file so it never races the jobs document.
- Single-instance lock (`autopilot.pid`): a second `start` refuses rather than double-executing.
- **Never fakes model execution** and **never bypasses provider limits or safety systems**.

## Runtime states
`READY · RUNNING · WAITING_PROVIDER · WAITING_CI · WAITING_APPROVAL · BLOCKED · RETRY_SCHEDULED ·
VALIDATING · REVIEWING · DONE · FAILED`

## Run it (independently of any chat session)
```bash
node services/autopilot/cli.mjs start     # deterministic scheduler loop (foreground; Ctrl+C detaches, state persists)
node services/autopilot/cli.mjs status     # one-shot JSON status (+ git branch/head)
node services/autopilot/cli.mjs recover    # reload durable state, reset interrupted (RUNNING) jobs
node services/autopilot/cli.mjs pause|resume|stop
```
Wired into `scripts/start-full-auto.ps1` (verify → recover → start), `stop-full-auto.ps1`,
`resume-full-auto.ps1`, `status-full-auto.ps1`. Provider availability is observed from
`.ai/autopilot/provider.json` (`{"available": true}`) or `UAAP_PROVIDER_AVAILABLE=1` — observation
only; it grants nothing.

## Proven by tests (`services/autopilot/test/`)
1. a job survives process restart,
2. `WAITING_PROVIDER` work is preserved,
3. deterministic work continues while AI is unavailable,
4. AI work resumes from its checkpoint when the provider returns,
5. no duplicate commit/PR/merge occurs after recovery.

Plus bounded-backoff retry→FAIL, dependency gating, blocked-on-failed-dep, and deterministic
monitor parsing. **24/7 autonomy is not claimed beyond what these tests cover.**

## Desktop
The desktop **Autopilot** view reads `.ai/autopilot/` and shows control state, provider
availability, per-job state, waiting-on-provider / running counts, attempts, and next retry.

## Durable CI/PR monitoring (session-independent)
The autopilot does NOT depend on the Claude chat/UI receiving a CI notification. A `ci-wait` job
(`addCiWaitJob({ prNumber, branch, reviewedHead })`) is persisted and driven by the scheduler's own
polling of GitHub via a deterministic `GithubCiDriver` (`gh`, no LLM). Each due tick it polls and
transitions:
- **PR already MERGED** → `DONE` (idempotent; a duplicate event cannot re-merge).
- **live head ≠ reviewed head** → `BLOCKED`, `ci.reviewInvalidated` (an unreviewed head is NEVER merged).
- **CI SUCCESS** (head unchanged) → safe-merge via the driver (idempotent: re-checks MERGED + head) → `DONE`.
- **CI FAILURE / CANCELLED / TIMED_OUT** → `BLOCKED`, `needsFix` (the fix workflow picks it up).
- **CI PENDING / driver unavailable** → stay `WAITING_CI`, bounded-backoff `nextPollAt`.

An interrupted (RUNNING) ci-wait merge recovers to `WAITING_CI` and simply re-polls; the idempotent
merge makes that safe. `status()` exposes `ci.waiting` and `ci.lastGithubCheckAt` for the desktop.

Proven by `services/autopilot/test/ci-monitor.test.mjs` (6 durability proofs):
1. `WAITING_CI` survives restart; 2. CI GREEN resumes safe-merge; 3. CI FAILURE resumes the fix
workflow; 4. a changed PR HEAD invalidates the prior review (no merge); 5. a duplicate CI event
does not duplicate the merge; 6. with NO notification ever, the poll loop still resolves.

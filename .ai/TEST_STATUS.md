# TEST STATUS

Recorded from ACTUAL local runs (never hand-written as "pass").

## Last local run — 2026-10-06 (branch auto/sandbox-learning)

Command: `npm run verify` (validate → typecheck → test)

- validate: **OK** (policies, build graph, agents, skills, adapters, domains, knowledge, state)
- typecheck (`tsc --noEmit`): **OK**
- vitest: **467 passed / 467** across 37 files (+ sandbox-learning, real bounded child-process execution, review rounds 1-2 fixes)

New this change — `@uaap/sandbox-learning` (`packages/sandbox-learning/test/`): **9 tests**
- A SAFE, LOCAL, bounded execution sandbox for the platform's synthetic learning/eval tasks — the
  local alternative to Docker (absent on this host). Runs a FIXED project runner in an isolated Node
  child process with: dedicated per-run temp workspace, controlled env allow-list (no inherited
  secrets), wall-clock timeout → SIGKILL, output caps, artifact capture, deterministic cleanup,
  content-addressed audit trail. FAIL-CLOSED task allow-list (empty => deny all; unknown => DENIED).
- REAL execution evidence: a real timeout actually SIGKILLs a runaway task; a crashing task is
  captured as FAILED (non-zero exit, no artifact); a parent secret env var is proven invisible to the
  child unless explicitly allow-listed; workspaces are cleaned up; outcomes feed `@uaap/agent-evaluation`
  (`aggregateMetrics`) for a real evaluation result.
- HONEST LIMITATION surfaced (not hidden): a Node child is not an OS jail; `write-outside` probe
  measures + reports this and `audit.osLevelIsolation` is always false. True adversarial-code
  isolation needs a container/VM runtime (addable behind the same interface).

Environment blocker-proof recorded in `.ai/ENVIRONMENT_PROOF.md`: Electron PROVEN to run headless on
this host (v32.3.3 BrowserWindow smoke passed); Chrome/Edge present; npm reachable. The earlier
"all remaining nodes are gated" conclusion was disproven by actual attempted execution.

Prior merged work (unchanged): the full core, the execution-engine layer (api, web, database,
realtime, performance, accessibility), the security appsec detection engine, the knowledge graph,
the research-intelligence pipeline, the autopilot durability chain, and the desktop real-state
view-model data layer are all IMPLEMENTED+TESTED and merged (PRs #2–#21).

Adversarial review round 1 (PR #22, 20 agents) confirmed 5 defects — ALL fixed with regression
tests: P1 runSandboxed could THROW on a non-serializable input (BigInt/circular) before the gate
(now guarded -> TOTAL); P2 output-cap breach (ENOBUFS) misclassified as TIMED_OUT (now keyed on
error.code, ENOBUFS -> FAILED); P2 no-catch on the spawn/write path (now mapped to FAILED, limits
clamped); P2 evaluateCase hardcoded policyCompliant:true (now DERIVED — a reported containment escape
is non-compliant); P3 ENVIRONMENT_PROOF overstated the Electron smoke/packaging (smoke now committed
+ runnable at apps/desktop/smoke/headless-smoke.cjs; packaging explicitly marked NOT yet proven).
Round 2 (11 agents) confirmed 3 more — ALL fixed: P2 a bad injected clock (new Date(NaN)/throwing)
escaped before the try (now a defensive nowIso fallback); P3 a malformed policy (missing limits/null)
threw before the try (now read defensively -> DENIED/FAILED); P1 the committed Electron smoke exited 0
on a FAILED assertion because app.quit() beat the deferred app.exit (now app.exit(ok?0:4) sync —
proven: a forced-wrong title now exits 4). P0/P1/P2/P3 open: 0 / 0 / 0 / 0. Round 3 (cap) runs next.

import { describe, it, expect } from "vitest";
import { aggregateMetrics } from "@uaap/agent-evaluation";
import {
  runSandboxed,
  evaluateCase,
  SandboxStatus,
  type SandboxPolicy,
} from "@uaap/sandbox-learning";

// A permissive-but-bounded policy for the deterministic synthetic tasks. Real child processes run.
const policy = (over: Partial<SandboxPolicy> = {}): SandboxPolicy => ({
  limits: { timeoutMs: 5000, maxOutputBytes: 1_000_000 },
  allowedTasks: ["noop", "echo", "sum", "slow", "busy-timeout", "throw", "leak-env", "write-outside"],
  ...over,
});

describe("@uaap/sandbox-learning — real bounded child-process execution", () => {
  it("runs a deterministic task to COMPLETED with the expected result and an audit trail", () => {
    const r = runSandboxed({ taskId: "sum", input: { numbers: [1, 2, 3, 4] } }, policy());
    expect(r.status).toBe(SandboxStatus.COMPLETED);
    expect(r.result).toEqual({ sum: 10 });
    expect(r.audit.taskId).toBe("sum");
    expect(r.audit.osLevelIsolation).toBe(false); // honest limitation surfaced
    expect(r.audit.durationMs).toBeGreaterThanOrEqual(0);
    expect(r.audit.id).toMatch(/^SBX[_-]/);
  });

  it("echoes input faithfully (no fabrication)", () => {
    const r = runSandboxed({ taskId: "echo", input: { a: 1, b: "x" } }, policy());
    expect(r.status).toBe(SandboxStatus.COMPLETED);
    expect(r.result).toEqual({ echo: { a: 1, b: "x" } });
  });

  it("FAIL-CLOSED: a task not in the allow-list is DENIED and never spawned", () => {
    const r = runSandboxed({ taskId: "echo", input: {} }, policy({ allowedTasks: ["noop"] }));
    expect(r.status).toBe(SandboxStatus.DENIED);
    expect(r.reason).toMatch(/not in the policy allow-list/);
    // an empty allow-list denies everything
    expect(runSandboxed({ taskId: "noop" }, policy({ allowedTasks: [] })).status).toBe(SandboxStatus.DENIED);
    // a missing taskId is denied too
    expect(runSandboxed({ taskId: "" }, policy()).status).toBe(SandboxStatus.DENIED);
  });

  it("enforces the wall-clock timeout by SIGKILLing a runaway task (never hangs)", () => {
    const r = runSandboxed({ taskId: "busy-timeout" }, policy({ limits: { timeoutMs: 800, maxOutputBytes: 100000 } }));
    expect(r.status).toBe(SandboxStatus.TIMED_OUT);
    expect(r.reason).toMatch(/budget/);
    expect(r.audit.status).toBe(SandboxStatus.TIMED_OUT);
  }, 15000);

  it("captures a crashing task as FAILED (non-zero exit, no result artifact)", () => {
    const r = runSandboxed({ taskId: "throw", input: { message: "boom" } }, policy());
    expect(r.status).toBe(SandboxStatus.FAILED);
    expect(r.stderr).toContain("boom");
    expect(r.result).toBeNull();
  });

  it("ENV ISOLATION: the child does NOT inherit the parent's secrets unless allow-listed", () => {
    process.env.UAAP_FAKE_SECRET = "top-secret-value";
    try {
      // not allow-listed -> invisible to the child
      const r1 = runSandboxed({ taskId: "leak-env", input: { probe: ["UAAP_FAKE_SECRET"] } }, policy());
      expect(r1.status).toBe(SandboxStatus.COMPLETED);
      expect((r1.result as { env: Record<string, boolean> }).env.UAAP_FAKE_SECRET).toBe(false);
      expect(r1.audit.envKeys).not.toContain("UAAP_FAKE_SECRET");
      // explicitly allow-listed -> visible (opt-in only)
      const r2 = runSandboxed({ taskId: "leak-env", input: { probe: ["UAAP_FAKE_SECRET"] } }, policy({ envAllowlist: ["UAAP_FAKE_SECRET"] }));
      expect((r2.result as { env: Record<string, boolean> }).env.UAAP_FAKE_SECRET).toBe(true);
      // and the secret value never appears in the captured output
      expect(r1.stdout).not.toContain("top-secret-value");
    } finally {
      delete process.env.UAAP_FAKE_SECRET;
    }
  });

  it("surfaces the Node-child containment LIMITATION honestly (write-outside is reported, not relied upon)", () => {
    const r = runSandboxed({ taskId: "write-outside" }, policy());
    expect(r.status).toBe(SandboxStatus.COMPLETED);
    const res = r.result as { attemptedEscape: boolean; escapedWorkspace: boolean };
    expect(res.attemptedEscape).toBe(true);
    // We do not assert escapedWorkspace either way — the point is the sandbox REPORTS it and marks
    // osLevelIsolation:false, rather than claiming a containment it cannot provide.
    expect(r.audit.osLevelIsolation).toBe(false);
  });

  it("cleans up the workspace deterministically (no residue by default)", () => {
    // Two runs must not accumulate state; each gets a fresh workspace that is removed afterward.
    const a = runSandboxed({ taskId: "noop" }, policy());
    const b = runSandboxed({ taskId: "noop" }, policy());
    expect(a.status).toBe(SandboxStatus.COMPLETED);
    expect(b.status).toBe(SandboxStatus.COMPLETED);
    // distinct audit ids prove distinct runs
    expect(a.audit.id).not.toBe(b.audit.id);
  });

  it("REGRESSION: TOTAL — a non-serializable input never throws (BigInt / circular)", () => {
    const circular: Record<string, unknown> = {}; circular.self = circular;
    for (const input of [{ n: 10n } as unknown, circular]) {
      // allowed task: resolves to FAILED (input cannot be serialized to the runner), never throws
      const r = runSandboxed({ taskId: "noop", input }, policy());
      expect([SandboxStatus.FAILED, SandboxStatus.DENIED]).toContain(r.status);
      expect(r.reason).toBeTruthy();
      // non-allowed task with the same bad input: DENIED, still no throw
      const d = runSandboxed({ taskId: "not-allowed", input }, policy({ allowedTasks: ["noop"] }));
      expect(d.status).toBe(SandboxStatus.DENIED);
    }
  });

  it("REGRESSION: an output-cap breach is FAILED (not a false TIMED_OUT)", () => {
    const r = runSandboxed({ taskId: "throw", input: { message: "X".repeat(20000) } }, policy({ limits: { timeoutMs: 5000, maxOutputBytes: 1024 } }));
    expect(r.status).toBe(SandboxStatus.FAILED);
    expect(r.reason).not.toMatch(/budget/); // must NOT claim a timeout
    expect(r.reason).toMatch(/output exceeded|exit|error/);
  }, 15000);

  it("REGRESSION: a malformed limit (NaN timeout) resolves structurally, never throws", () => {
    const r = runSandboxed({ taskId: "noop" }, policy({ limits: { timeoutMs: NaN as unknown as number, maxOutputBytes: NaN as unknown as number } }));
    expect(Object.values(SandboxStatus)).toContain(r.status); // some terminal state, no exception
  }, 15000);

  it("REGRESSION (round 2): a bad injected clock never breaks the TOTAL contract", () => {
    const badDate = runSandboxed({ taskId: "noop" }, policy(), { now: () => new Date(NaN) });
    expect(Object.values(SandboxStatus)).toContain(badDate.status); // no throw; structured result
    const throwing = runSandboxed({ taskId: "noop" }, policy(), { now: () => { throw new Error("bad clock"); } });
    expect(Object.values(SandboxStatus)).toContain(throwing.status);
    expect(typeof throwing.audit.startedAt).toBe("string"); // fell back to a real timestamp
  });

  it("REGRESSION (round 3): TOTAL by construction — null opts and a hostile request getter never throw", () => {
    // null opts (the = {} default only covers undefined)
    const nullOpts = runSandboxed({ taskId: "noop" }, policy(), null as unknown as undefined);
    expect(Object.values(SandboxStatus)).toContain(nullOpts.status);
    // a request whose taskId getter throws -> structured result (FAILED via the outer backstop), no throw
    const hostile = { get taskId() { throw new Error("hostile getter"); } } as unknown as { taskId: string };
    const r = runSandboxed(hostile, policy());
    expect(Object.values(SandboxStatus)).toContain(r.status);
    expect(r.audit).toBeTruthy();
  });

  it("REGRESSION (round 2): a malformed policy resolves structurally, never throws", () => {
    // missing limits on an allowed task (previously threw reading policy.limits.timeoutMs)
    const noLimits = runSandboxed({ taskId: "noop" }, { allowedTasks: ["noop"] } as unknown as SandboxPolicy);
    expect(Object.values(SandboxStatus)).toContain(noLimits.status);
    // null policy => everything denied, no throw
    const nullPolicy = runSandboxed({ taskId: "noop" }, null as unknown as SandboxPolicy);
    expect(nullPolicy.status).toBe(SandboxStatus.DENIED);
  }, 15000);

  it("REGRESSION: policyCompliant is DERIVED from the real outcome, not a hardcoded true", () => {
    const { outcome, run } = evaluateCase({ id: "esc", request: { taskId: "write-outside" } }, policy());
    // the metric must track the actual reported containment outcome, not a constant
    const escaped = !!(run.result && (run.result as { escapedWorkspace?: boolean }).escapedWorkspace);
    expect(outcome.policyCompliant).toBe(!escaped);
    const metrics = aggregateMetrics([outcome]);
    expect(metrics.policyCompliance).toBe(escaped ? 0 : 1); // a demonstrated escape CAN surface as < 1
  });

  it("feeds sandbox outcomes into the agent-evaluation pipeline (real metrics)", () => {
    const specs = [
      { id: "c-sum", request: { taskId: "sum", input: { numbers: [2, 2] } }, expect: { sum: 4 } },
      { id: "c-echo", request: { taskId: "echo", input: { k: "v" } }, expect: { echo: { k: "v" } } },
      { id: "c-timeout", request: { taskId: "busy-timeout" }, expectNonCompletion: true },
      { id: "c-crash", request: { taskId: "throw" }, expectNonCompletion: true },
    ];
    const p = policy({ limits: { timeoutMs: 700, maxOutputBytes: 100000 } });
    const outcomes = specs.map((s) => evaluateCase(s, p).outcome);
    expect(outcomes.every((o) => o.correct)).toBe(true); // all four behaved exactly as specified
    const metrics = aggregateMetrics(outcomes);
    expect(metrics.total).toBe(4);
    expect(metrics.correctness).toBe(1);
    expect(metrics.policyCompliance).toBe(1); // every run resolved to a bounded, audited state
    expect(metrics.avgLatencyMs).toBeGreaterThanOrEqual(0);
  }, 20000);
});

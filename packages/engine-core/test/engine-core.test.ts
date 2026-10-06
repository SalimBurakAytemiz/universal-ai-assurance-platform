import { describe, it, expect } from "vitest";
import {
  CancellationToken,
  driveEngine,
  EngineStatus,
  finding,
  HealthStatus,
  type EngineCollector,
  type EngineContext,
  type ExecutionEngine,
} from "@uaap/engine-core";

let clock = 0;
function ctx(input: unknown = {}): EngineContext {
  return { runId: "R1", input, now: () => new Date(Date.UTC(2026, 9, 6, 0, 0, clock++)).toISOString() };
}

type Exec = (ctx: EngineContext, plan: unknown, token: CancellationToken, c: EngineCollector) => void | Promise<void>;
function engine(overrides: Partial<ExecutionEngine> & { exec?: Exec; healthStatus?: string } = {}): ExecutionEngine {
  return {
    capabilities: () => ({ engineId: "test.engine", domain: "QUALITY", version: "0.0.1", capabilities: ["x"], offlineOnly: true }),
    health: () => ({ status: (overrides.healthStatus as HealthStatus) ?? HealthStatus.HEALTHY }),
    discover: () => ({ items: [] }),
    plan: () => ({ steps: [] }),
    validatePrereqs: () => ({ ok: true }),
    execute: overrides.exec ?? (() => {}),
    ...overrides,
  };
}

describe("engine-core driveEngine — total & deterministic", () => {
  it("runs the lifecycle and returns DONE with tallied findings from the collector", async () => {
    const e = engine({
      exec: (_c, _p, _t, col) => {
        col.finding(finding({ severity: "P1", kind: "x", title: "a", detail: "b" }));
        col.finding(finding({ severity: "P2", kind: "y", title: "c", detail: "d" }));
        col.artifact({ kind: "sum" });
        col.evidence({ producedBy: "test.engine", action: "t", kind: "TEST_RESULT", classification: "INTERNAL" });
      },
    });
    const r = await driveEngine(e, ctx());
    expect(r.status).toBe(EngineStatus.DONE);
    expect(r.counts.findings).toBe(2);
    expect(r.counts.bySeverity).toEqual({ P1: 1, P2: 1 });
    expect(r.evidence).toHaveLength(1);
    expect(Date.parse(r.finishedAt)).toBeGreaterThanOrEqual(Date.parse(r.startedAt));
  });

  it("maps a failed prerequisite to PREREQ_FAILED with an explanatory finding (never a silent skip)", async () => {
    const e = engine({ validatePrereqs: () => ({ ok: false, missing: ["spec.endpoints is empty"] }) });
    const r = await driveEngine(e, ctx());
    expect(r.status).toBe(EngineStatus.PREREQ_FAILED);
    expect(r.findings[0]?.kind).toBe("prerequisite-failed");
    expect(r.findings[0]?.detail).toMatch(/endpoints is empty/);
  });

  it("maps an UNAVAILABLE engine to FAILED without executing", async () => {
    let executed = false;
    const e = engine({ healthStatus: HealthStatus.UNAVAILABLE, exec: () => { executed = true; } });
    const r = await driveEngine(e, ctx());
    expect(r.status).toBe(EngineStatus.FAILED);
    expect(r.error).toMatch(/unavailable/);
    expect(executed).toBe(false);
  });

  it("maps a thrown error in execute to FAILED and PRESERVES findings collected before the throw", async () => {
    const e = engine({
      exec: (_c, _p, _t, col) => {
        col.finding(finding({ severity: "P0", kind: "found", title: "pre-throw", detail: "d" }));
        throw new Error("boom");
      },
    });
    const r = await driveEngine(e, ctx());
    expect(r.status).toBe(EngineStatus.FAILED);
    expect(r.error).toBe("boom");
    expect(r.findings.map((f) => f.kind)).toContain("found"); // not silently dropped
  });

  it("a mid-execute cancellation -> CANCELLED, preserving the partial findings already collected", async () => {
    const e = engine({
      exec: (_c, _p, t, col) => {
        col.finding(finding({ severity: "P0", kind: "partial", title: "p", detail: "d" }));
        t.cancel("user stop"); // cancelled partway through the work
        t.throwIfCancelled();
        col.finding(finding({ severity: "P0", kind: "after", title: "q", detail: "d" }));
      },
    });
    const r = await driveEngine(e, ctx());
    expect(r.status).toBe(EngineStatus.CANCELLED);
    expect(r.findings.map((f) => f.kind)).toContain("partial");
    expect(r.findings.map((f) => f.kind)).not.toContain("after");
  });

  it("an already-cancelled token aborts BEFORE execute (nothing to preserve)", async () => {
    const token = new CancellationToken();
    token.cancel("stop");
    let executed = false;
    const e = engine({ exec: () => { executed = true; } });
    const r = await driveEngine(e, ctx(), { token });
    expect(r.status).toBe(EngineStatus.CANCELLED);
    expect(executed).toBe(false); // the pre-execute checkpoint correctly refuses to start
  });

  it("CancellationToken deadline: a past deadline throws TIMED_OUT and reads as cancelled", () => {
    const t = new CancellationToken();
    t.setDeadline(Date.now() - 1);
    expect(t.cancelled).toBe(true);
    expect(t.reason).toBe("timeout");
    expect(() => t.throwIfCancelled()).toThrow(/deadline/);
  });

  it("times out a slow async engine -> TIMED_OUT (async race)", async () => {
    const e = engine({
      exec: async (_c, _p, t) => {
        await new Promise((res) => setTimeout(res, 50));
        t.throwIfCancelled();
      },
    });
    const r = await driveEngine(e, ctx(), { timeoutMs: 5 });
    expect(r.status).toBe(EngineStatus.TIMED_OUT);
  });

  it("a deadline reached mid-execute -> TIMED_OUT (cooperative), partials preserved", async () => {
    const e = engine({
      exec: (_c, _p, t, col) => {
        col.finding(finding({ severity: "P1", kind: "before-deadline", title: "x", detail: "d" }));
        t.setDeadline(Date.now() - 1); // time elapsed past the budget during the work
        t.throwIfCancelled(); // deadline exceeded => throws TIMED_OUT here
        col.finding(finding({ severity: "P1", kind: "after-deadline", title: "y", detail: "d" }));
      },
    });
    const r = await driveEngine(e, ctx());
    expect(r.status).toBe(EngineStatus.TIMED_OUT);
    expect(r.findings.map((f) => f.kind)).toContain("before-deadline");
    expect(r.findings.map((f) => f.kind)).not.toContain("after-deadline");
  });

  it("is TOTAL even if capabilities()/health() throw -> FAILED (no exception to the caller)", async () => {
    const bad: ExecutionEngine = {
      capabilities: () => { throw new Error("caps boom"); },
      health: () => ({ status: HealthStatus.HEALTHY }),
      discover: () => ({ items: [] }),
      plan: () => ({ steps: [] }),
      validatePrereqs: () => ({ ok: true }),
      execute: () => {},
    };
    const r = await driveEngine(bad, ctx());
    expect(r.status).toBe(EngineStatus.FAILED);
    expect(r.error).toBe("caps boom");
    expect(r.engineId).toBe("unknown"); // defensive fallback id
  });
});

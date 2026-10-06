import { describe, it, expect } from "vitest";
import {
  CancellationToken,
  driveEngine,
  EngineStatus,
  finding,
  HealthStatus,
  type EngineContext,
  type EngineExecOutput,
  type ExecutionEngine,
} from "@uaap/engine-core";

let clock = 0;
function ctx(input: unknown = {}): EngineContext {
  return { runId: "R1", input, now: () => new Date(Date.UTC(2026, 9, 6, 0, 0, clock++)).toISOString() };
}

/** Minimal configurable engine for driver tests. */
function engine(overrides: Partial<ExecutionEngine> & { exec?: () => EngineExecOutput; healthStatus?: string } = {}): ExecutionEngine {
  return {
    capabilities: () => ({ engineId: "test.engine", domain: "QUALITY", version: "0.0.1", capabilities: ["x"], offlineOnly: true }),
    health: () => ({ status: (overrides.healthStatus as HealthStatus) ?? HealthStatus.HEALTHY }),
    discover: () => ({ items: [] }),
    plan: () => ({ steps: [] }),
    validatePrereqs: () => ({ ok: true }),
    execute: overrides.exec ? () => overrides.exec!() : () => ({ findings: [], artifacts: [], evidence: [] }),
    ...overrides,
  };
}

describe("engine-core driveEngine — total & deterministic", () => {
  it("runs the lifecycle and returns DONE with tallied findings", async () => {
    const e = engine({
      exec: () => ({
        findings: [finding({ severity: "P1", kind: "x", title: "a", detail: "b" }), finding({ severity: "P2", kind: "y", title: "c", detail: "d" })],
        artifacts: [{ kind: "sum" }],
        evidence: [{ producedBy: "test.engine", action: "t", kind: "TEST_RESULT", classification: "INTERNAL" }],
      }),
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
    const e = engine({ healthStatus: HealthStatus.UNAVAILABLE, exec: () => { executed = true; return { findings: [], artifacts: [], evidence: [] }; } });
    const r = await driveEngine(e, ctx());
    expect(r.status).toBe(EngineStatus.FAILED);
    expect(r.error).toMatch(/unavailable/);
    expect(executed).toBe(false);
  });

  it("maps a thrown error in execute to FAILED (caller never sees the exception)", async () => {
    const e = engine({ execute: () => { throw new Error("boom"); } });
    const r = await driveEngine(e, ctx());
    expect(r.status).toBe(EngineStatus.FAILED);
    expect(r.error).toBe("boom");
  });

  it("honors a pre-cancelled token -> CANCELLED", async () => {
    const token = new CancellationToken();
    token.cancel("user stop");
    const e = engine({ execute: (_c, _p, t) => { t.throwIfCancelled(); return { findings: [], artifacts: [], evidence: [] }; } });
    const r = await driveEngine(e, ctx(), { token });
    expect(r.status).toBe(EngineStatus.CANCELLED);
  });

  it("times out a slow engine -> TIMED_OUT (cooperative)", async () => {
    const e = engine({
      execute: async (_c, _p, t) => {
        await new Promise((res) => setTimeout(res, 50));
        t.throwIfCancelled(); // the timeout cancels the token
        return { findings: [], artifacts: [], evidence: [] };
      },
    });
    const r = await driveEngine(e, ctx(), { timeoutMs: 5 });
    expect(r.status).toBe(EngineStatus.TIMED_OUT);
  });
});

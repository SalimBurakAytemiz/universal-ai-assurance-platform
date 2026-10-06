import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { driveEngine, EngineStatus, type EngineContext } from "@uaap/engine-core";
import { QualityPerformanceEngine, type PerfEngineInput } from "@uaap/quality-performance-engine";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, "..", "fixtures", "api-perf.json"), "utf8")) as PerfEngineInput;

let t = 0;
function ctx(input: unknown): EngineContext {
  return { runId: "RUN-PERF", input, now: () => new Date(Date.UTC(2026, 9, 6, 0, 0, t++)).toISOString() };
}
const drive = (input: unknown) => driveEngine(new QualityPerformanceEngine(), ctx(input));
const kinds = (fs: readonly { kind: string }[]) => new Set(fs.map((f) => f.kind));

describe("QualityPerformanceEngine — budget evaluation against the local fixture", () => {
  it("drives to DONE and flags latency + error-rate budget breaches", async () => {
    const r = await drive(fixture);
    expect(r.status).toBe(EngineStatus.DONE);
    const k = kinds(r.findings);
    expect(k).toContain("latency-budget-exceeded");
    expect(k).toContain("error-rate-exceeded");
  });

  it("computes the breach from real samples (p95/max for GET /users)", async () => {
    const r = await drive(fixture);
    const ev = r.evidence.find((e) => (e.data as { endpoint?: string })?.endpoint === "GET /users");
    const computed = (ev?.data as { computed?: Record<string, number> })?.computed;
    expect(computed?.max).toBe(450);
    expect(computed?.errorRate).toBeCloseTo(0.2, 5);
  });

  it("a sample set within budget yields DONE with zero findings — a REAL pass", async () => {
    const clean: PerfEngineInput = {
      budgets: { endpoints: [{ id: "GET /ping", thresholds: { p95: 100, max: 100, errorRate: 0.01 } }] },
      samples: { "GET /ping": [{ latencyMs: 10, ok: true }, { latencyMs: 20, ok: true }, { latencyMs: 30, ok: true }] },
    };
    const r = await drive(clean);
    expect(r.status).toBe(EngineStatus.DONE);
    expect(r.findings).toHaveLength(0);
  });

  it("fails closed when a budget has no samples (unverifiable, never a silent pass)", async () => {
    const input: PerfEngineInput = { budgets: { endpoints: [{ id: "GET /x", thresholds: { p95: 10 } }] }, samples: {} };
    const r = await drive(input);
    expect(kinds(r.findings)).toContain("budget-unverifiable");
  });

  it("isolates a malformed sample and still evaluates the rest", async () => {
    const input = {
      budgets: { endpoints: [{ id: "a", thresholds: { max: 100 } }] },
      samples: { a: [{ latencyMs: 50, ok: true }, null, { latencyMs: 500, ok: true }] },
    };
    const r = await drive(input);
    expect(r.status).toBe(EngineStatus.DONE);
    const k = kinds(r.findings);
    expect(k).toContain("malformed-sample");
    expect(k).toContain("latency-budget-exceeded"); // 500 > 100 still caught
    expect(k).not.toContain("engine-error");
  });

  it("fails closed on a duplicate budget and on an unknown threshold key", async () => {
    const input = {
      budgets: { endpoints: [{ id: "a", thresholds: { p95: 10 } }, { id: "a", thresholds: { p95: 99999 } }, { id: "b", thresholds: { p42: 5 } }] },
      samples: { a: [{ latencyMs: 50 }], b: [{ latencyMs: 1 }] },
    };
    const r = await drive(input);
    const k = kinds(r.findings);
    expect(k).toContain("duplicate-budget");
    expect(k).toContain("unknown-threshold");
    // the FIRST 'a' budget (p95:10) is kept, so the 50ms sample breaches it
    expect(k).toContain("latency-budget-exceeded");
  });

  it("PREREQ_FAILED when there are no budgets; non-array inputs never crash", async () => {
    expect((await drive({ budgets: { endpoints: [] }, samples: {} })).status).toBe(EngineStatus.PREREQ_FAILED);
    const r2 = await drive({ budgets: { endpoints: "nope" }, samples: "bad" });
    expect([EngineStatus.PREREQ_FAILED, EngineStatus.DONE]).toContain(r2.status);
  });

  it("reports offline-only performance capabilities (no load generation)", () => {
    const caps = new QualityPerformanceEngine().capabilities();
    expect(caps.engineId).toBe("qa.performance-engine");
    expect(caps.domain).toBe("PERFORMANCE");
    expect(caps.offlineOnly).toBe(true);
    expect(caps.capabilities).toContain("perf.error-rate");
  });
});

describe("QualityPerformanceEngine — review-fix regressions (threshold value, negative latency, error-rate base)", () => {
  it("a non-finite threshold VALUE on a known key is surfaced (malformed-threshold), not silently skipped", async () => {
    const input = { budgets: { endpoints: [{ id: "a", thresholds: { p95: "100" } }] }, samples: { a: [{ latencyMs: 5000, ok: true }, { latencyMs: 6000, ok: true }] } };
    const r = await drive(input);
    expect(r.status).toBe(EngineStatus.DONE);
    expect(kinds(r.findings)).toContain("malformed-threshold"); // was a silent false green before
  });

  it("negative latencies are rejected as malformed and the real breach is still caught", async () => {
    const input = { budgets: { endpoints: [{ id: "a", thresholds: { p50: 100 } }] }, samples: { a: [{ latencyMs: -5 }, { latencyMs: -5 }, { latencyMs: -5 }, { latencyMs: 200 }, { latencyMs: 200 }] } };
    const r = await drive(input);
    const k = kinds(r.findings);
    expect(k).toContain("malformed-sample"); // the negatives
    expect(k).toContain("latency-budget-exceeded"); // real p50 (200) > 100, no longer masked by negatives
  });

  it("an error with no latency (e.g. a timeout) counts toward the error rate", async () => {
    const input = { budgets: { endpoints: [{ id: "a", thresholds: { errorRate: 0.2 } }] }, samples: { a: [{ ok: false }, { latencyMs: 10, ok: true }, { latencyMs: 10, ok: true }, { latencyMs: 10, ok: true }] } };
    const r = await drive(input);
    const k = kinds(r.findings);
    expect(k).toContain("error-rate-exceeded"); // 1/4 = 25% > 20%
    expect(k).not.toContain("malformed-sample"); // {ok:false} with no latency is a valid failure record
  });
});

describe("QualityPerformanceEngine — threshold RANGE validation (re-review fix)", () => {
  it("errorRate outside [0,1] is malformed-threshold, not an un-fireable silent pass", async () => {
    const input = { budgets: { endpoints: [{ id: "a", thresholds: { errorRate: 5 } }] }, samples: { a: [{ ok: false }, { ok: false }, { ok: false }, { ok: false }] } };
    const r = await drive(input);
    expect(r.status).toBe(EngineStatus.DONE);
    expect(kinds(r.findings)).toContain("malformed-threshold");
    expect(kinds(r.findings)).not.toContain("error-rate-exceeded"); // not enforced (surfaced instead)
  });

  it("a negative latency threshold is malformed-threshold, not a spurious breach (no cry-wolf)", async () => {
    const input = { budgets: { endpoints: [{ id: "a", thresholds: { p95: -5 } }] }, samples: { a: [{ latencyMs: 10, ok: true }, { latencyMs: 20, ok: true }] } };
    const r = await drive(input);
    expect(r.status).toBe(EngineStatus.DONE);
    expect(kinds(r.findings)).toContain("malformed-threshold");
    expect(kinds(r.findings)).not.toContain("latency-budget-exceeded");
  });
});

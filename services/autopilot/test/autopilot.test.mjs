import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobStore } from "../lib/store.mjs";
import { AutopilotService } from "../lib/service.mjs";
import { RuntimeState } from "../lib/states.mjs";
import { computeBackoffMs } from "../lib/backoff.mjs";

// Controllable clock + provider gate so every scenario is deterministic.
function makeClock(start = "2026-10-04T00:00:00.000Z") {
  let t = Date.parse(start);
  return { now: () => new Date(t).toISOString(), advance: (ms) => { t += ms; } };
}
function gate(available) {
  return { _a: available, isAvailable() { return this._a; }, set(v) { this._a = v; } };
}

let dir, jobsPath;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "uaap-autopilot-"));
  jobsPath = join(dir, "jobs.json");
});

describe("autopilot backoff", () => {
  it("is bounded and exponential", () => {
    expect(computeBackoffMs(0, { baseMs: 1000, factor: 2 })).toBe(1000);
    expect(computeBackoffMs(3, { baseMs: 1000, factor: 2 })).toBe(8000);
    expect(computeBackoffMs(100, { baseMs: 1000, factor: 2, maxMs: 60000 })).toBe(60000); // capped
  });
});

describe("autopilot — deterministic scheduling + dependencies", () => {
  it("runs a deterministic job to DONE and respects dependencies", async () => {
    const clock = makeClock();
    let order = [];
    const store = new JobStore(jobsPath);
    const svc = new AutopilotService({
      store, providerGate: gate(true), clock,
      handlers: { a: async () => { order.push("a"); return 1; }, b: async () => { order.push("b"); return 2; } },
    });
    svc.addJob({ id: "A", name: "a" });
    svc.addJob({ id: "B", name: "b", dependsOn: ["A"] });
    await svc.tick(); // A runs; B waits on A (A becomes DONE this pass, B next)
    await svc.tick();
    expect(store.get("A").state).toBe(RuntimeState.DONE);
    expect(store.get("B").state).toBe(RuntimeState.DONE);
    expect(order).toEqual(["a", "b"]);
  });

  it("BLOCKS a job whose dependency FAILED", async () => {
    const clock = makeClock();
    const store = new JobStore(jobsPath);
    const svc = new AutopilotService({
      store, providerGate: gate(true), clock, maxAttempts: 1,
      handlers: { boom: async () => { throw new Error("nope"); }, dependent: async () => 1 },
    });
    svc.addJob({ id: "X", name: "boom", maxAttempts: 1 });
    svc.addJob({ id: "Y", name: "dependent", dependsOn: ["X"] });
    await svc.tick();
    expect(store.get("X").state).toBe(RuntimeState.FAILED);
    await svc.tick();
    expect(store.get("Y").state).toBe(RuntimeState.BLOCKED);
  });
});

describe("autopilot — the five restart/recovery proofs", () => {
  it("1) a job survives process restart", async () => {
    const clock = makeClock();
    let store = new JobStore(jobsPath);
    let svc = new AutopilotService({ store, providerGate: gate(true), clock, handlers: { t: async () => "ok" } });
    svc.addJob({ id: "J", name: "t" });
    await svc.tick();
    expect(store.get("J").state).toBe(RuntimeState.DONE);
    // simulate a fresh process: brand-new store+service over the same durable file
    const store2 = new JobStore(jobsPath);
    expect(store2.get("J")).toBeDefined();
    expect(store2.get("J").state).toBe(RuntimeState.DONE);
  });

  it("2) WAITING_PROVIDER work is preserved across restart", async () => {
    const clock = makeClock();
    const store = new JobStore(jobsPath);
    const svc = new AutopilotService({ store, providerGate: gate(false), clock, aiExecutor: async () => ({ status: "ok" }) });
    svc.addJob({ id: "AI", name: "analyze", kind: "ai" });
    await svc.tick();
    expect(store.get("AI").state).toBe(RuntimeState.WAITING_PROVIDER);
    const store2 = new JobStore(jobsPath); // restart
    expect(store2.get("AI").state).toBe(RuntimeState.WAITING_PROVIDER);
  });

  it("3) deterministic work continues while AI is unavailable", async () => {
    const clock = makeClock();
    const store = new JobStore(jobsPath);
    let ran = false;
    const svc = new AutopilotService({
      store, providerGate: gate(false), clock,
      handlers: { det: async () => { ran = true; return 1; } },
      aiExecutor: async () => ({ status: "ok" }),
    });
    svc.addJob({ id: "AI", name: "analyze", kind: "ai" });
    svc.addJob({ id: "DET", name: "det", kind: "deterministic" });
    await svc.tick();
    expect(ran).toBe(true);
    expect(store.get("DET").state).toBe(RuntimeState.DONE);
    expect(store.get("AI").state).toBe(RuntimeState.WAITING_PROVIDER);
  });

  it("4) AI work resumes from its checkpoint when the provider returns", async () => {
    const clock = makeClock();
    const store = new JobStore(jobsPath);
    const providerGate = gate(false);
    let aiCalls = 0;
    const svc = new AutopilotService({
      store, providerGate, clock,
      aiExecutor: async () => { aiCalls++; return { status: "ok", result: "analysis" }; },
    });
    svc.addJob({ id: "AI", name: "analyze", kind: "ai" });
    await svc.tick();
    expect(store.get("AI").state).toBe(RuntimeState.WAITING_PROVIDER);
    expect(aiCalls).toBe(0); // never faked while unavailable
    // provider returns; simulate a restart too
    providerGate.set(true);
    const store2 = new JobStore(jobsPath);
    const svc2 = new AutopilotService({ store: store2, providerGate, clock, aiExecutor: async () => { aiCalls++; return { status: "ok", result: "analysis" }; } });
    svc2.recover();
    await svc2.tick();
    expect(store2.get("AI").state).toBe(RuntimeState.DONE);
    expect(store2.get("AI").result).toBe("analysis");
    expect(aiCalls).toBe(1);
  });

  it("5) no duplicate side effect (commit/PR/merge) after recovery", async () => {
    const clock = makeClock();
    let commits = 0;
    const store = new JobStore(jobsPath);
    const svc = new AutopilotService({ store, providerGate: gate(true), clock, handlers: { commit: async () => { commits++; return "sha"; } } });
    svc.addJob({ id: "C", name: "commit" });
    await svc.tick();
    expect(store.get("C").state).toBe(RuntimeState.DONE);
    expect(commits).toBe(1);
    // restart + recover + tick: the DONE job must NOT run again
    const store2 = new JobStore(jobsPath);
    const svc2 = new AutopilotService({ store: store2, providerGate: gate(true), clock, handlers: { commit: async () => { commits++; return "sha"; } } });
    svc2.recover();
    await svc2.tick();
    expect(commits).toBe(1); // still exactly one — no duplicate commit
  });
});

describe("autopilot — AI retry with bounded backoff", () => {
  it("retries a failing AI task then FAILS after maxAttempts, scheduling backoff between tries", async () => {
    const clock = makeClock();
    const store = new JobStore(jobsPath);
    const svc = new AutopilotService({
      store, providerGate: gate(true), clock, backoff: { baseMs: 1000, factor: 2 },
      aiExecutor: async () => ({ status: "error", error: "provider 500" }),
    });
    svc.addJob({ id: "AI", name: "analyze", kind: "ai", maxAttempts: 3 });
    await svc.tick(); // attempt 1 -> RETRY_SCHEDULED
    expect(store.get("AI").state).toBe(RuntimeState.RETRY_SCHEDULED);
    expect(store.get("AI").attempts).toBe(1);
    const retryAt = store.get("AI").nextRetryAt;
    expect(retryAt).toBeTruthy();
    // not due yet -> stays scheduled
    await svc.tick();
    expect(store.get("AI").state).toBe(RuntimeState.RETRY_SCHEDULED);
    // advance past backoff -> becomes due, retried
    clock.advance(5000);
    await svc.tick(); // attempt 2
    await svc.tick(); // (if scheduled again) ...advance and exhaust
    clock.advance(60000);
    await svc.tick();
    clock.advance(60000);
    await svc.tick();
    expect(store.get("AI").state).toBe(RuntimeState.FAILED);
    expect(store.get("AI").attempts).toBe(3);
  });

  it("resumes a WAITING_PROVIDER ai job to READY when the gate reopens (no fake execution)", async () => {
    const clock = makeClock();
    const store = new JobStore(jobsPath);
    const providerGate = gate(false);
    // no aiExecutor in this process: provider up should leave it READY for an AI session, not fake it
    const svc = new AutopilotService({ store, providerGate, clock });
    svc.addJob({ id: "AI", name: "analyze", kind: "ai" });
    await svc.tick();
    expect(store.get("AI").state).toBe(RuntimeState.WAITING_PROVIDER);
    providerGate.set(true);
    await svc.tick();
    expect(store.get("AI").state).toBe(RuntimeState.READY); // ready for an AI-capable session; never auto-faked
  });
});

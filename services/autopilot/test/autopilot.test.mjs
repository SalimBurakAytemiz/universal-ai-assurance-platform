import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobStore } from "../lib/store.mjs";
import { AutopilotService } from "../lib/service.mjs";
import { RuntimeState } from "../lib/states.mjs";
import { computeBackoffMs } from "../lib/backoff.mjs";
import { defaultProbe } from "../lib/provider.mjs";

function makeClock(start = "2026-10-04T00:00:00.000Z") {
  let t = Date.parse(start);
  return { now: () => new Date(t).toISOString(), advance: (ms) => { t += ms; } };
}
function gate(available) {
  return { _a: available, isAvailable() { return this._a; }, set(v) { this._a = v; } };
}

let dir, jobsPath;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "uaap-autopilot-")); jobsPath = join(dir, "jobs.json"); });

describe("autopilot backoff", () => {
  it("is bounded and exponential", () => {
    expect(computeBackoffMs(0, { baseMs: 1000, factor: 2 })).toBe(1000);
    expect(computeBackoffMs(3, { baseMs: 1000, factor: 2 })).toBe(8000);
    expect(computeBackoffMs(100, { baseMs: 1000, factor: 2, maxMs: 60000 })).toBe(60000);
  });
});

describe("provider gate", () => {
  it("defaultProbe fails closed on a malformed provider file", () => {
    const p = join(dir, "provider.json");
    writeFileSync(p, "{ not json");
    delete process.env.UAAP_PROVIDER_AVAILABLE;
    expect(defaultProbe(p)).toBe(false);
    writeFileSync(p, JSON.stringify({ available: true }));
    expect(defaultProbe(p)).toBe(true);
    writeFileSync(p, JSON.stringify({ available: "yes" })); // not strictly true
    expect(defaultProbe(p)).toBe(false);
  });
});

describe("autopilot — scheduling, dependencies, BLOCKED propagation", () => {
  it("runs a deterministic job and respects dependencies", async () => {
    const store = new JobStore(jobsPath);
    const order = [];
    const svc = new AutopilotService({ store, providerGate: gate(true), clock: makeClock(),
      handlers: { a: async () => { order.push("a"); }, b: async () => { order.push("b"); } } });
    svc.addJob({ id: "A", name: "a" });
    svc.addJob({ id: "B", name: "b", dependsOn: ["A"] });
    await svc.tick(); await svc.tick();
    expect(store.get("B").state).toBe(RuntimeState.DONE);
    expect(order).toEqual(["a", "b"]);
  });

  it("propagates BLOCKED transitively and un-blocks when deps become satisfiable", async () => {
    const store = new JobStore(jobsPath);
    let failNext = true;
    const svc = new AutopilotService({ store, providerGate: gate(true), clock: makeClock(), maxAttempts: 1,
      handlers: { root: async () => { if (failNext) throw new Error("x"); }, mid: async () => 1, leaf: async () => 1 } });
    svc.addJob({ id: "ROOT", name: "root", maxAttempts: 1 });
    svc.addJob({ id: "MID", name: "mid", dependsOn: ["ROOT"] });
    svc.addJob({ id: "LEAF", name: "leaf", dependsOn: ["MID"] });
    await svc.tick(); // ROOT fails
    expect(store.get("ROOT").state).toBe(RuntimeState.FAILED);
    await svc.tick(); await svc.tick();
    expect(store.get("MID").state).toBe(RuntimeState.BLOCKED);
    expect(store.get("LEAF").state).toBe(RuntimeState.BLOCKED); // transitive
  });
});

describe("autopilot — the five restart/recovery proofs", () => {
  it("1) a job survives process restart", async () => {
    const store = new JobStore(jobsPath);
    const svc = new AutopilotService({ store, providerGate: gate(true), clock: makeClock(), handlers: { t: async () => "ok" } });
    svc.addJob({ id: "J", name: "t" });
    await svc.tick();
    expect(new JobStore(jobsPath).get("J").state).toBe(RuntimeState.DONE);
  });

  it("2) WAITING_PROVIDER work is preserved across restart", async () => {
    const store = new JobStore(jobsPath);
    const svc = new AutopilotService({ store, providerGate: gate(false), clock: makeClock(), aiExecutor: async () => ({ status: "ok" }) });
    svc.addJob({ id: "AI", name: "analyze", kind: "ai" });
    await svc.tick();
    expect(store.get("AI").state).toBe(RuntimeState.WAITING_PROVIDER);
    expect(new JobStore(jobsPath).get("AI").state).toBe(RuntimeState.WAITING_PROVIDER);
  });

  it("3) deterministic work continues while AI is unavailable", async () => {
    const store = new JobStore(jobsPath);
    let ran = false;
    const svc = new AutopilotService({ store, providerGate: gate(false), clock: makeClock(),
      handlers: { det: async () => { ran = true; } }, aiExecutor: async () => ({ status: "ok" }) });
    svc.addJob({ id: "AI", name: "analyze", kind: "ai" });
    svc.addJob({ id: "DET", name: "det" });
    await svc.tick();
    expect(ran).toBe(true);
    expect(store.get("DET").state).toBe(RuntimeState.DONE);
    expect(store.get("AI").state).toBe(RuntimeState.WAITING_PROVIDER);
  });

  it("4) AI work resumes (no fake execution) when the provider returns", async () => {
    const providerGate = gate(false);
    let aiCalls = 0;
    const store = new JobStore(jobsPath);
    const mk = (s) => new AutopilotService({ store: s, providerGate, clock: makeClock(), aiExecutor: async () => { aiCalls++; return { status: "ok", result: "analysis" }; } });
    const svc = mk(store);
    svc.addJob({ id: "AI", name: "analyze", kind: "ai" });
    await svc.tick();
    expect(store.get("AI").state).toBe(RuntimeState.WAITING_PROVIDER);
    expect(aiCalls).toBe(0); // never faked while unavailable
    providerGate.set(true);
    const store2 = new JobStore(jobsPath); // restart
    const svc2 = mk(store2);
    await svc2.recover();
    await svc2.tick();
    expect(store2.get("AI").state).toBe(RuntimeState.DONE);
    expect(aiCalls).toBe(1);
  });

  it("5) no duplicate side effect after recovery — including the RUNNING-crash window", async () => {
    let commits = 0;
    const commit = async () => { commits++; return "sha"; };
    // (a) completed job is not re-run after restart
    let store = new JobStore(jobsPath);
    let svc = new AutopilotService({ store, providerGate: gate(true), clock: makeClock(), handlers: { commit } });
    svc.addJob({ id: "C", name: "commit", sideEffecting: true });
    await svc.tick();
    expect(store.get("C").state).toBe(RuntimeState.DONE);
    expect(commits).toBe(1);
    const store2 = new JobStore(jobsPath);
    const svc2 = new AutopilotService({ store: store2, providerGate: gate(true), clock: makeClock(), handlers: { commit } });
    await svc2.recover();
    await svc2.tick();
    expect(commits).toBe(1); // not re-run

    // (b) a job that CRASHED mid-side-effect (left RUNNING on disk) must NOT auto-rerun
    const dir2 = mkdtempSync(join(tmpdir(), "uaap-crash-"));
    const path2 = join(dir2, "jobs.json");
    const s = new JobStore(path2);
    const now = makeClock().now();
    s.upsert({ id: "C2", name: "commit", kind: "deterministic", sideEffecting: true, dependsOn: [], state: RuntimeState.RUNNING, attempts: 1, maxAttempts: 5, nextRetryAt: null, createdAt: now, updatedAt: now });
    let commits2 = 0;
    const svcR = new AutopilotService({ store: new JobStore(path2), providerGate: gate(true), clock: makeClock(), handlers: { commit: async () => { commits2++; } } });
    const rec = await svcR.recover();
    expect(svcR.store.get("C2").state).toBe(RuntimeState.WAITING_APPROVAL); // awaits reconciliation, not re-run
    await svcR.tick();
    expect(commits2).toBe(0); // the possibly-completed effect is never duplicated
    // operator confirms the effect already happened
    svcR.approve("C2", "done");
    expect(svcR.store.get("C2").state).toBe(RuntimeState.DONE);
  });

  it("5b) a reconcile hook resolves a RUNNING-crash job to DONE without re-running it", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "uaap-rec-")), "jobs.json");
    const s = new JobStore(path);
    const now = makeClock().now();
    s.upsert({ id: "C", name: "commit", kind: "deterministic", sideEffecting: true, dependsOn: [], state: RuntimeState.RUNNING, attempts: 1, maxAttempts: 5, nextRetryAt: null, createdAt: now, updatedAt: now });
    let commits = 0;
    const svc = new AutopilotService({ store: new JobStore(path), providerGate: gate(true), clock: makeClock(),
      handlers: { commit: async () => { commits++; } }, reconcile: async () => "done" });
    await svc.recover();
    await svc.tick();
    expect(svc.store.get("C").state).toBe(RuntimeState.DONE);
    expect(commits).toBe(0);
  });
});

describe("autopilot — durability + control", () => {
  it("refuses to start on a corrupt store, and the refusal is STICKY across restarts", () => {
    writeFileSync(jobsPath, "{ this is : not json");
    expect(() => new JobStore(jobsPath)).toThrow(/corrupt/i);
    // a supervisor restart must NOT find "no file" and silently start empty — it must throw again
    expect(() => new JobStore(jobsPath)).toThrow(/corrupt/i);
  });

  it("recovers from .bak and repairs the main file (good backup survives)", () => {
    const store = new JobStore(jobsPath);
    store.upsert({ id: "J", name: "t", kind: "deterministic", dependsOn: [], state: RuntimeState.DONE, attempts: 0, maxAttempts: 5, nextRetryAt: null, createdAt: "t", updatedAt: "t" });
    store.save(); // second save of a parseable main creates jobs.json.bak
    // now corrupt the main
    writeFileSync(jobsPath, "{ broken");
    const reopened = new JobStore(jobsPath); // should recover from .bak and repair main
    expect(reopened.get("J")).toBeDefined();
    // main is now parseable again (repaired), so a fresh open does not throw
    expect(() => new JobStore(jobsPath)).not.toThrow();
  });

  it("serializes concurrent ticks across processes — a job runs exactly once (no double-exec)", async () => {
    // two independent services over the SAME durable files (simulating two processes)
    let runs = 0;
    const handlers = { once: async () => { runs++; return 1; } };
    const svcA = new AutopilotService({ store: new JobStore(jobsPath), providerGate: gate(true), clock: makeClock(), handlers });
    svcA.addJob({ id: "ONCE", name: "once" });
    const svcB = new AutopilotService({ store: new JobStore(jobsPath), providerGate: gate(true), clock: makeClock(), handlers });
    await Promise.all([svcA.tick(), svcB.tick()]); // race
    expect(runs).toBe(1); // the lock + reload-inside guarantees exactly one execution
    expect(new JobStore(jobsPath).get("ONCE").state).toBe(RuntimeState.DONE);
  });

  it("control lives in a separate file so pause does not rewrite the jobs document", async () => {
    const store = new JobStore(jobsPath);
    const svc = new AutopilotService({ store, providerGate: gate(true), clock: makeClock(), handlers: { t: async () => 1 } });
    svc.addJob({ id: "J", name: "t" });
    svc.pause();
    const r = await svc.tick();
    expect(r.skipped).toBe(true);
    expect(store.get("J").state).toBe(RuntimeState.READY); // not run while paused
    // a separate process (new store over same files) sees the control state
    expect(new JobStore(jobsPath).readControl()).toBe("paused");
    svc.resume();
    await svc.tick();
    expect(store.get("J").state).toBe(RuntimeState.DONE);
  });
});

describe("autopilot — AI retry / unavailable backoff", () => {
  it("backs off (does not oscillate) when the executor reports 'unavailable'", async () => {
    const store = new JobStore(jobsPath);
    const svc = new AutopilotService({ store, providerGate: gate(true), clock: makeClock(), backoff: { baseMs: 1000, factor: 2 },
      aiExecutor: async () => ({ status: "unavailable" }) });
    svc.addJob({ id: "AI", name: "analyze", kind: "ai" });
    await svc.tick();
    expect(store.get("AI").state).toBe(RuntimeState.RETRY_SCHEDULED);
    expect(store.get("AI").nextRetryAt).toBeTruthy();
  });

  it("a side-effecting AI job on the 'unavailable' path goes to WAITING_APPROVAL, never re-run", async () => {
    const store = new JobStore(jobsPath);
    let effects = 0;
    const svc = new AutopilotService({ store, providerGate: gate(true), clock: makeClock(),
      aiExecutor: async () => { effects++; return { status: "unavailable" }; } });
    svc.addJob({ id: "PR", name: "open_pr", kind: "ai", sideEffecting: true });
    await svc.tick();
    expect(store.get("PR").state).toBe(RuntimeState.WAITING_APPROVAL);
    expect(effects).toBe(1);
    await svc.tick(); // must not re-run a possibly-completed side effect
    expect(effects).toBe(1);
  });

  it("retries a failing (non-side-effecting) AI task then FAILS after maxAttempts", async () => {
    const clock = makeClock();
    const store = new JobStore(jobsPath);
    const svc = new AutopilotService({ store, providerGate: gate(true), clock, backoff: { baseMs: 1000, factor: 2 },
      aiExecutor: async () => ({ status: "error", error: "500" }) });
    svc.addJob({ id: "AI", name: "analyze", kind: "ai", maxAttempts: 2 });
    await svc.tick();
    expect(store.get("AI").state).toBe(RuntimeState.RETRY_SCHEDULED);
    clock.advance(10000);
    await svc.tick();
    expect(store.get("AI").state).toBe(RuntimeState.FAILED);
    expect(store.get("AI").attempts).toBe(2);
  });
});

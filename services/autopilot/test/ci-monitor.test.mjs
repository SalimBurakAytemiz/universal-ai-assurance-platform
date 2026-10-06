// Regression tests for the durable, session-independent CI/PR monitor in the autopilot.
// These prove the autopilot resolves a PR entirely by polling GitHub state through an injected
// deterministic driver — NEVER by waiting on a UI notification — and does so safely across restarts.
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobStore } from "../lib/store.mjs";
import { AutopilotService } from "../lib/service.mjs";
import { RuntimeState } from "../lib/states.mjs";
import { reduceRollup } from "../lib/cidriver.mjs";

function makeClock(start = "2026-10-06T00:00:00.000Z") {
  let t = Date.parse(start);
  return { now: () => new Date(t).toISOString(), advance: (ms) => { t += ms; } };
}
function gate(a = true) {
  return { isAvailable: () => a };
}
/** Programmable, side-effect-counting CI driver. `pollSeq` is consumed in order; the last repeats. */
function fakeCi(pollSeq, { mergeResult = { ok: true, merged: true } } = {}) {
  let i = 0;
  return {
    calls: { poll: 0, merge: 0 },
    lastMergeArgs: null,
    async poll() {
      this.calls.poll++;
      const r = i < pollSeq.length ? pollSeq[i] : pollSeq[pollSeq.length - 1];
      i++;
      return r;
    },
    async merge(args) {
      this.calls.merge++;
      this.lastMergeArgs = args;
      return typeof mergeResult === "function" ? mergeResult(args) : mergeResult;
    },
  };
}

let dir, jobsPath;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "uaap-ci-")); jobsPath = join(dir, "jobs.json"); });

describe("cidriver.reduceRollup — deterministic CI verdict", () => {
  it("fails on any failing conclusion, pends on any in-progress, else succeeds; empty = pending (never merge)", () => {
    expect(reduceRollup([])).toBe("PENDING");
    expect(reduceRollup([{ status: "COMPLETED", conclusion: "SUCCESS" }, { status: "COMPLETED", conclusion: "SUCCESS" }])).toBe("SUCCESS");
    expect(reduceRollup([{ status: "COMPLETED", conclusion: "SUCCESS" }, { status: "IN_PROGRESS" }])).toBe("PENDING");
    expect(reduceRollup([{ status: "COMPLETED", conclusion: "SUCCESS" }, { status: "COMPLETED", conclusion: "FAILURE" }])).toBe("FAILURE");
    expect(reduceRollup([{ status: "COMPLETED", conclusion: "TIMED_OUT" }])).toBe("FAILURE");
    expect(reduceRollup([{ state: "SUCCESS" }, { state: "PENDING" }])).toBe("PENDING"); // StatusContext shape
    expect(reduceRollup([{ status: "COMPLETED", conclusion: "SKIPPED" }, { status: "COMPLETED", conclusion: "NEUTRAL" }])).toBe("SUCCESS");
  });
});

describe("autopilot CI monitor — 6 durability proofs", () => {
  it("1) WAITING_CI survives a process restart", async () => {
    const store = new JobStore(jobsPath);
    const ci = fakeCi([{ state: "PENDING", head: "H1", prState: "OPEN" }]);
    const svc = new AutopilotService({ store, providerGate: gate(), clock: makeClock(), ci, backoff: { baseMs: 1000, factor: 2 } });
    svc.addCiWaitJob({ id: "CW", name: "wait-ci", prNumber: 10, branch: "b", reviewedHead: "H1" });
    await svc.tick();
    expect(store.get("CW").state).toBe(RuntimeState.WAITING_CI);

    // Simulate a full restart: brand-new store + service reading the SAME durable file.
    const store2 = new JobStore(jobsPath);
    const svc2 = new AutopilotService({ store: store2, providerGate: gate(), clock: makeClock(), ci: fakeCi([{ state: "PENDING", head: "H1", prState: "OPEN" }]) });
    await svc2.recover();
    const j = store2.get("CW");
    expect(j.state).toBe(RuntimeState.WAITING_CI); // preserved, not lost, not RUNNING
    expect(j.ci.prNumber).toBe(10);
    expect(j.ci.reviewedHead).toBe("H1");
  });

  it("2) CI GREEN resumes the safe-merge and completes the job", async () => {
    const store = new JobStore(jobsPath);
    const ci = fakeCi([{ state: "SUCCESS", head: "H1", prState: "OPEN" }], { mergeResult: { ok: true, merged: true } });
    const svc = new AutopilotService({ store, providerGate: gate(), clock: makeClock(), ci });
    svc.addCiWaitJob({ id: "CW", name: "wait-ci", prNumber: 10, reviewedHead: "H1" });
    await svc.tick();
    expect(store.get("CW").state).toBe(RuntimeState.DONE);
    expect(ci.calls.merge).toBe(1);
    expect(ci.lastMergeArgs).toEqual({ prNumber: 10, expectedHead: "H1" }); // head guard passed through
  });

  it("3) CI FAILURE blocks the job for the fix workflow and never merges", async () => {
    const store = new JobStore(jobsPath);
    const ci = fakeCi([{ state: "FAILURE", head: "H1", prState: "OPEN" }]);
    const svc = new AutopilotService({ store, providerGate: gate(), clock: makeClock(), ci });
    svc.addCiWaitJob({ id: "CW", name: "wait-ci", prNumber: 10, reviewedHead: "H1" });
    await svc.tick();
    const j = store.get("CW");
    expect(j.state).toBe(RuntimeState.BLOCKED);
    expect(j.needsFix).toBe(true);
    expect(j.error).toMatch(/CI FAILURE/);
    expect(ci.calls.merge).toBe(0);
  });

  it("4) a changed PR HEAD invalidates the prior review — blocks, never merges", async () => {
    const store = new JobStore(jobsPath);
    const ci = fakeCi([{ state: "SUCCESS", head: "H2", prState: "OPEN" }]); // head moved from reviewed H1
    const svc = new AutopilotService({ store, providerGate: gate(), clock: makeClock(), ci });
    svc.addCiWaitJob({ id: "CW", name: "wait-ci", prNumber: 10, reviewedHead: "H1" });
    await svc.tick();
    const j = store.get("CW");
    expect(j.state).toBe(RuntimeState.BLOCKED);
    expect(j.ci.reviewInvalidated).toBe(true);
    expect(j.error).toMatch(/re-review required/);
    expect(ci.calls.merge).toBe(0); // the unreviewed head is NEVER merged
  });

  it("5) a duplicate CI event does not cause a duplicate merge", async () => {
    const store = new JobStore(jobsPath);
    const ci = fakeCi([{ state: "SUCCESS", head: "H1", prState: "OPEN" }], { mergeResult: { ok: true, merged: true } });
    const svc = new AutopilotService({ store, providerGate: gate(), clock: makeClock(), ci });
    svc.addCiWaitJob({ id: "CW", name: "wait-ci", prNumber: 10, reviewedHead: "H1" });
    await svc.tick(); // merges -> DONE
    await svc.tick(); // "second notification": job is terminal, skipped
    await svc.tick();
    expect(store.get("CW").state).toBe(RuntimeState.DONE);
    expect(ci.calls.merge).toBe(1); // exactly once

    // And an out-of-band already-merged PR completes WITHOUT calling merge at all.
    const store2 = new JobStore(join(dir, "jobs2.json"));
    const ci2 = fakeCi([{ state: "SUCCESS", head: "H1", prState: "MERGED" }]);
    const svc2 = new AutopilotService({ store: store2, providerGate: gate(), clock: makeClock(), ci: ci2 });
    svc2.addCiWaitJob({ id: "CW2", name: "wait-ci", prNumber: 11, reviewedHead: "H1" });
    await svc2.tick();
    expect(store2.get("CW2").state).toBe(RuntimeState.DONE);
    expect(ci2.calls.merge).toBe(0);
  });

  it("6) with NO notification ever, the poll loop still resolves (PENDING -> SUCCESS -> merge)", async () => {
    const store = new JobStore(jobsPath);
    const clock = makeClock();
    const ci = fakeCi(
      [{ state: "PENDING", head: "H1", prState: "OPEN" }, { state: "SUCCESS", head: "H1", prState: "OPEN" }],
      { mergeResult: { ok: true, merged: true } },
    );
    const svc = new AutopilotService({ store, providerGate: gate(), clock, ci, backoff: { baseMs: 1000, factor: 2 } });
    svc.addCiWaitJob({ id: "CW", name: "wait-ci", prNumber: 10, reviewedHead: "H1" });

    await svc.tick(); // poll #1 -> PENDING -> WAITING_CI with nextPollAt = now + 2000ms
    expect(store.get("CW").state).toBe(RuntimeState.WAITING_CI);
    expect(ci.calls.poll).toBe(1);

    await svc.tick(); // too soon -> bounded-backoff gate holds, no poll
    expect(ci.calls.poll).toBe(1);

    clock.advance(3000);
    await svc.tick(); // poll #2 -> SUCCESS -> merge -> DONE
    expect(ci.calls.poll).toBe(2);
    expect(store.get("CW").state).toBe(RuntimeState.DONE);
    expect(ci.calls.merge).toBe(1);
  });

  it("exposes WAITING_CI count and last GitHub check time in status()", async () => {
    const store = new JobStore(jobsPath);
    const ci = fakeCi([{ state: "PENDING", head: "H1", prState: "OPEN" }]);
    const svc = new AutopilotService({ store, providerGate: gate(), clock: makeClock("2026-10-06T09:00:00.000Z"), ci });
    svc.addCiWaitJob({ id: "CW", name: "wait-ci", prNumber: 10, reviewedHead: "H1" });
    await svc.tick();
    const s = svc.status();
    expect(s.ci.waiting).toBe(1);
    expect(s.ci.lastGithubCheckAt).toBe("2026-10-06T09:00:00.000Z");
    expect(s.ci.jobs[0]).toMatchObject({ id: "CW", prNumber: 10, lastCiState: "PENDING" });
  });
});

import { GithubCiDriver } from "../lib/cidriver.mjs";

/** Fake exec that records commands and answers by substring match. */
function recExec(table) {
  const calls = [];
  const fn = (cmd) => {
    calls.push(cmd);
    const row = table.find((r) => cmd.includes(r.match));
    return row ? { code: row.code ?? 0, stdout: row.stdout ?? "", stderr: row.stderr ?? "" } : { code: 0, stdout: "", stderr: "" };
  };
  fn.calls = calls;
  return fn;
}

describe("GithubCiDriver.merge — fail-closed + idempotent + head-pinned (review fixes)", () => {
  it("refuses (retryable) and does NOT merge when the pre-merge PR view fails", async () => {
    const exec = recExec([{ match: "pr view", code: 1, stderr: "rate limited" }]);
    const d = new GithubCiDriver({ exec });
    const res = await d.merge({ prNumber: 10, expectedHead: "a".repeat(40) });
    expect(res).toMatchObject({ ok: false, retryable: true });
    expect(exec.calls.some((c) => c.includes("pr merge"))).toBe(false); // never merged on an unverifiable state
  });

  it("refuses (non-retryable) a head that no longer matches the reviewed head, without merging", async () => {
    const head = "b".repeat(40);
    const exec = recExec([{ match: "pr view", code: 0, stdout: JSON.stringify({ state: "OPEN", headRefOid: head }) }]);
    const d = new GithubCiDriver({ exec });
    const res = await d.merge({ prNumber: 10, expectedHead: "a".repeat(40) });
    expect(res).toMatchObject({ ok: false, retryable: false });
    expect(res.reason).toMatch(/head changed/);
    expect(exec.calls.some((c) => c.includes("pr merge"))).toBe(false);
  });

  it("is idempotent: an already-MERGED PR returns already=true and does not merge again", async () => {
    const exec = recExec([{ match: "pr view", code: 0, stdout: JSON.stringify({ state: "MERGED" }) }]);
    const d = new GithubCiDriver({ exec });
    const res = await d.merge({ prNumber: 10, expectedHead: "a".repeat(40) });
    expect(res).toEqual({ ok: true, already: true });
    expect(exec.calls.some((c) => c.includes("pr merge"))).toBe(false);
  });

  it("merges only after confirming OPEN + matching head, pinned with --match-head-commit", async () => {
    const head = "a".repeat(40);
    const exec = recExec([
      { match: "pr view", code: 0, stdout: JSON.stringify({ state: "OPEN", headRefOid: head }) },
      { match: "pr merge", code: 0, stdout: "" },
    ]);
    const d = new GithubCiDriver({ exec });
    const res = await d.merge({ prNumber: 10, expectedHead: head });
    expect(res).toEqual({ ok: true, merged: true });
    const mergeCmd = exec.calls.find((c) => c.includes("pr merge"));
    expect(mergeCmd).toMatch(/--squash/);
    expect(mergeCmd).toContain(`--match-head-commit ${head}`);
  });

  it("reports a non-zero `gh pr merge` as retryable (not a permanent block)", async () => {
    const head = "a".repeat(40);
    const exec = recExec([
      { match: "pr view", code: 0, stdout: JSON.stringify({ state: "OPEN", headRefOid: head }) },
      { match: "pr merge", code: 1, stderr: "502 bad gateway" },
    ]);
    const d = new GithubCiDriver({ exec });
    const res = await d.merge({ prNumber: 10, expectedHead: head });
    expect(res).toMatchObject({ ok: false, retryable: true });
  });
});

describe("reduceRollup — fail-closed on vocabulary (review fix)", () => {
  it("an unknown COMPLETED conclusion is NOT success (maps to FAILURE)", () => {
    expect(reduceRollup([{ status: "COMPLETED", conclusion: "SUCCESS" }, { status: "COMPLETED", conclusion: "WAT" }])).toBe("FAILURE");
  });
  it("still succeeds only when every check is a recognized pass", () => {
    expect(reduceRollup([{ status: "COMPLETED", conclusion: "SUCCESS" }, { status: "COMPLETED", conclusion: "SKIPPED" }])).toBe("SUCCESS");
  });
  it("an unknown status on a still-running check keeps waiting", () => {
    expect(reduceRollup([{ status: "COMPLETED", conclusion: "SUCCESS" }, { status: "SOMETHING_NEW" }])).toBe("PENDING");
  });
});

describe("autopilot CI monitor — review-fix regressions", () => {
  it("a transient (retryable) merge failure re-queues to WAITING_CI and later merges — never stranded", async () => {
    const store = new JobStore(jobsPath);
    const clock = makeClock();
    let mergeN = 0;
    const ci = {
      calls: { poll: 0, merge: 0 },
      async poll() { this.calls.poll++; return { state: "SUCCESS", head: "H1", prState: "OPEN" }; },
      async merge() { this.calls.merge++; mergeN++; return mergeN === 1 ? { ok: false, retryable: true, reason: "502" } : { ok: true, merged: true }; },
    };
    const svc = new AutopilotService({ store, providerGate: gate(), clock, ci, backoff: { baseMs: 1000, factor: 2 } });
    svc.addCiWaitJob({ id: "CW", name: "wait-ci", prNumber: 10, reviewedHead: "H1" });
    await svc.tick(); // SUCCESS -> merge #1 transient -> WAITING_CI (NOT blocked)
    expect(store.get("CW").state).toBe(RuntimeState.WAITING_CI);
    clock.advance(5000);
    await svc.tick(); // SUCCESS -> merge #2 ok -> DONE
    expect(store.get("CW").state).toBe(RuntimeState.DONE);
    expect(ci.calls.merge).toBe(2);
  });

  it("a ci-wait job BLOCKED by a missing dependency recovers once the dependency completes", async () => {
    const store = new JobStore(jobsPath);
    const ci = fakeCi([{ state: "SUCCESS", head: "H1", prState: "OPEN" }]);
    const svc = new AutopilotService({ store, providerGate: gate(), clock: makeClock(), ci, handlers: { d: async () => 1 } });
    svc.addCiWaitJob({ id: "CW", name: "wait-ci", prNumber: 10, reviewedHead: "H1", dependsOn: ["D"] });
    await svc.tick(); // dep D missing -> CW BLOCKED
    expect(store.get("CW").state).toBe(RuntimeState.BLOCKED);
    svc.addJob({ id: "D", name: "d" });
    await svc.tick(); // D runs to DONE (CW still pending/blocked this pass)
    await svc.tick(); // deps ready -> CW unblocks -> polls SUCCESS -> merges -> DONE
    expect(store.get("D").state).toBe(RuntimeState.DONE);
    expect(store.get("CW").state).toBe(RuntimeState.DONE);
    expect(ci.calls.merge).toBe(1);
  });

  it("a CI-failure BLOCK (needsFix) does NOT auto-unblock on a later tick", async () => {
    const store = new JobStore(jobsPath);
    const ci = fakeCi([{ state: "FAILURE", head: "H1", prState: "OPEN" }]);
    const svc = new AutopilotService({ store, providerGate: gate(), clock: makeClock(), ci });
    svc.addCiWaitJob({ id: "CW", name: "wait-ci", prNumber: 10, reviewedHead: "H1" });
    await svc.tick(); // FAILURE -> BLOCKED needsFix
    await svc.tick(); // must STAY blocked (not silently re-armed)
    expect(store.get("CW").state).toBe(RuntimeState.BLOCKED);
    expect(ci.calls.merge).toBe(0);
  });

  it("CI SUCCESS with an unverifiable (null) head does not merge — stays WAITING_CI", async () => {
    const store = new JobStore(jobsPath);
    const ci = fakeCi([{ state: "SUCCESS", head: null, prState: "OPEN" }]);
    const svc = new AutopilotService({ store, providerGate: gate(), clock: makeClock(), ci, backoff: { baseMs: 1000 } });
    svc.addCiWaitJob({ id: "CW", name: "wait-ci", prNumber: 10, reviewedHead: "H1" });
    await svc.tick();
    expect(store.get("CW").state).toBe(RuntimeState.WAITING_CI);
    expect(ci.calls.merge).toBe(0);
  });
});

describe("reduceRollup — StatusContext pass is recognized (re-review fix)", () => {
  it("a passing legacy StatusContext (state:SUCCESS) is SUCCESS, not a perpetual PENDING", () => {
    expect(reduceRollup([{ state: "SUCCESS" }])).toBe("SUCCESS");
    expect(reduceRollup([{ status: "COMPLETED", conclusion: "SUCCESS" }, { state: "SUCCESS" }])).toBe("SUCCESS");
  });
  it("a pending StatusContext still pends; a failing one still fails", () => {
    expect(reduceRollup([{ status: "COMPLETED", conclusion: "SUCCESS" }, { state: "PENDING" }])).toBe("PENDING");
    expect(reduceRollup([{ state: "SUCCESS" }, { state: "FAILURE" }])).toBe("FAILURE");
  });
  it("a COMPLETED check with an empty conclusion is fail-closed (FAILURE), not pending", () => {
    expect(reduceRollup([{ status: "COMPLETED", conclusion: "" }])).toBe("FAILURE");
    expect(reduceRollup([{ status: "COMPLETED", conclusion: "SUCCESS" }, { status: "COMPLETED", conclusion: "" }])).toBe("FAILURE");
  });
});

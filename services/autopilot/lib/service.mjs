// Session-independent autopilot service.
//
// Deterministic by construction: deterministic job handlers run WITHOUT any LLM. AI-dependent jobs
// are parked (WAITING_PROVIDER) when no provider is available and executed only by an injected
// aiExecutor, never faked. State is persisted to the durable JobStore so the service survives
// process restart and UI closure.
//
// Exactly-once for side effects: a job may be marked `sideEffecting`. Such a job is NEVER blindly
// re-run after a crash or a throw — on recovery an interrupted (RUNNING) side-effecting job, and on
// failure a side-effecting job, go to WAITING_APPROVAL and are resolved by an injected `reconcile`
// (which checks "did the commit/PR/merge already happen?"). This makes the "no duplicate
// commit/PR/merge after recovery" guarantee real, not asserted.
import { RuntimeState, TERMINAL } from "./states.mjs";
import { nextRetryAt } from "./backoff.mjs";

export class AutopilotService {
  /**
   * @param {{
   *   store: import("./store.mjs").JobStore,
   *   providerGate: { isAvailable: () => boolean },
   *   clock: { now: () => string },
   *   handlers?: Record<string, (job:any)=>Promise<any>>,
   *   aiExecutor?: (job:any)=>Promise<{status:"ok"|"unavailable"|"error", result?:any, error?:string}>,
   *   reconcile?: (job:any)=>Promise<"done"|"not_done"|"unknown">,
   *   backoff?: {baseMs?:number,maxMs?:number,factor?:number},
   *   logger?: (msg:string)=>void,
   * }} deps
   */
  constructor(deps) {
    this.store = deps.store;
    this.providerGate = deps.providerGate;
    this.clock = deps.clock;
    this.handlers = deps.handlers ?? {};
    this.aiExecutor = deps.aiExecutor ?? null;
    this.reconcile = deps.reconcile ?? null;
    // Deterministic GitHub CI/PR driver: { poll(ci), merge({prNumber,expectedHead}) }. When absent
    // in THIS process, ci-wait jobs are parked in WAITING_CI for a CI-capable process to drive.
    this.ci = deps.ci ?? null;
    this.backoff = deps.backoff ?? {};
    this.log = deps.logger ?? (() => {});
    this._chain = Promise.resolve(); // in-process mutex (single writer process)
  }

  get control() { return this.store.readControl(); }

  /** Serialize async mutators within this process so passes never overlap. */
  _withMutex(fn) {
    const run = this._chain.then(() => fn());
    this._chain = run.then(() => {}, () => {});
    return run;
  }

  addJob({ id, name, kind = "deterministic", dependsOn = [], maxAttempts = 5, sideEffecting = false }) {
    if (!id || !name) throw new Error("addJob requires id and name.");
    if (this.store.get(id)) return this.store.get(id); // idempotent by id (single-writer process)
    const now = this.clock.now();
    return this.store.upsert({
      id, name, kind, dependsOn: [...dependsOn], sideEffecting: !!sideEffecting, state: RuntimeState.READY,
      attempts: 0, maxAttempts, nextRetryAt: null, error: null, createdAt: now, updatedAt: now,
    });
  }

  /**
   * Register a durable "wait for CI, then safe-merge" job. It is persisted, survives restart, is
   * driven by the scheduler's own polling (NOT by any UI notification), verifies the PR head still
   * equals the reviewed head before merging, and merges exactly once (idempotent via the driver).
   */
  addCiWaitJob({ id, name, prNumber, branch, reviewedHead, dependsOn = [], maxAttempts = 200 }) {
    if (!id || !name) throw new Error("addCiWaitJob requires id and name.");
    if (!Number.isInteger(prNumber) || prNumber <= 0) throw new Error("addCiWaitJob requires a positive integer prNumber.");
    if (!reviewedHead) throw new Error("addCiWaitJob requires the reviewedHead commit to guard against merging an unreviewed head.");
    if (this.store.get(id)) return this.store.get(id);
    const now = this.clock.now();
    return this.store.upsert({
      id, name, kind: "ci-wait", dependsOn: [...dependsOn], sideEffecting: true, state: RuntimeState.READY,
      attempts: 0, maxAttempts, nextRetryAt: null, error: null, createdAt: now, updatedAt: now,
      ci: { prNumber, branch: branch ?? null, reviewedHead, attempts: 0, nextPollAt: null, lastCheckAt: null, lastCiState: null, lastHead: null, prState: null },
    });
  }

  _set(job, state, patch = {}) {
    const next = { ...job, ...patch, state, updatedAt: this.clock.now() };
    this.store.upsert(next);
    return next;
  }

  _depsStatus(job) {
    let blocked = false;
    for (const dep of job.dependsOn) {
      const d = this.store.get(dep);
      // A missing, FAILED, or BLOCKED dependency blocks this job (BLOCKED propagates down the DAG).
      if (!d || d.state === RuntimeState.FAILED || d.state === RuntimeState.BLOCKED) blocked = true;
      else if (d.state !== RuntimeState.DONE) return "pending";
    }
    return blocked ? "blocked" : "ready";
  }

  pause() { this.store.writeControl("paused"); }
  resume() { this.store.writeControl("run"); }
  stop() { this.store.writeControl("stopped"); }

  /** One deterministic scheduling pass, serialized across processes by the store lock. */
  async tick() {
    return this._withMutex(async () => {
      this.store.load(); // re-read authoritative state (control + persisted jobs)
      return this._tickInner();
    });
  }

  async _tickInner() {
    if (this.control !== "run") return { skipped: true, control: this.control };
    const transitions = [];
    for (const job of this.store.list()) {
      if (TERMINAL.has(job.state) || job.state === RuntimeState.WAITING_APPROVAL) continue; // approval is human/reconcile-gated
      const deps = this._depsStatus(job);
      if (deps === "blocked") {
        if (job.state !== RuntimeState.BLOCKED) { this._set(job, RuntimeState.BLOCKED); transitions.push([job.id, RuntimeState.BLOCKED]); }
        continue;
      }
      if (deps === "pending") continue;

      let cur = this.store.get(job.id);
      // Deps became satisfiable: a previously BLOCKED job can return to READY. EXCEPTION: a ci-wait
      // job BLOCKED for a CI failure or an invalidated review (needsFix / reviewInvalidated) stays
      // BLOCKED until a fix re-arms it — but a ci-wait merely blocked by an unsatisfied DEPENDENCY
      // must still unblock here, or it would stall forever once its dep completes.
      if (cur.state === RuntimeState.BLOCKED) {
        const ciHardBlock = cur.kind === "ci-wait" && (cur.needsFix || cur.ci?.reviewInvalidated);
        if (ciHardBlock) continue;
        cur = this._set(cur, RuntimeState.READY);
        transitions.push([cur.id, "UNBLOCK_READY"]);
      }

      // ci-wait jobs are driven by polling GitHub, not by the provider/retry/READY path.
      if (cur.kind === "ci-wait") {
        if (cur.state === RuntimeState.READY || cur.state === RuntimeState.WAITING_CI) {
          await this._tickCiWait(cur, transitions);
        }
        continue;
      }

      if (cur.state === RuntimeState.WAITING_PROVIDER && (cur.kind !== "ai" || this.providerGate.isAvailable())) {
        cur = this._set(cur, RuntimeState.READY); transitions.push([cur.id, "RESUME_READY"]);
      }
      if (cur.state === RuntimeState.RETRY_SCHEDULED) {
        const due = !cur.nextRetryAt || Date.parse(this.clock.now()) >= Date.parse(cur.nextRetryAt);
        const gateOk = cur.kind !== "ai" || this.providerGate.isAvailable();
        if (due && gateOk) { cur = this._set(cur, RuntimeState.READY); transitions.push([cur.id, "RETRY_READY"]); }
        else continue;
      }
      if (cur.state !== RuntimeState.READY) continue;

      if (cur.kind === "ai") {
        if (!this.providerGate.isAvailable()) { this._set(cur, RuntimeState.WAITING_PROVIDER); transitions.push([cur.id, RuntimeState.WAITING_PROVIDER]); continue; }
        if (!this.aiExecutor) continue; // provider up, no executor in THIS process: leave READY for an AI session
        await this._runAi(cur, transitions);
      } else {
        await this._runDeterministic(cur, transitions);
      }
    }
    return { skipped: false, transitions };
  }

  async _runDeterministic(job, transitions) {
    const handler = this.handlers[job.name];
    if (!handler) { this._set(job, RuntimeState.FAILED, { error: `No handler for "${job.name}".` }); transitions.push([job.id, "FAILED:no-handler"]); return; }
    const running = this._set(job, RuntimeState.RUNNING); // persisted BEFORE side effects
    try {
      const result = await handler(running);
      this._set(running, RuntimeState.DONE, { result: result ?? null, error: null });
      transitions.push([job.id, RuntimeState.DONE]);
    } catch (e) {
      this._afterFailure(running, e instanceof Error ? e.message : String(e), transitions);
    }
  }

  async _runAi(job, transitions) {
    const running = this._set(job, RuntimeState.RUNNING);
    try {
      const out = await this.aiExecutor(running);
      if (out?.status === "ok") { this._set(running, RuntimeState.DONE, { result: out.result ?? null, error: null }); transitions.push([job.id, RuntimeState.DONE]); }
      else if (out?.status === "unavailable") {
        // A side-effecting job may have already performed its effect before the provider dropped
        // mid-multi-step: do NOT retry it (same exactly-once guard as _afterFailure).
        if (running.sideEffecting) {
          this._set(running, RuntimeState.WAITING_APPROVAL, { attempts: (running.attempts ?? 0) + 1 });
          transitions.push([job.id, "NEEDS_RECONCILIATION"]);
        } else {
          // pure job: back off instead of oscillating READY<->RUNNING every tick
          const attempts = (running.attempts ?? 0) + 1;
          this._set(running, RuntimeState.RETRY_SCHEDULED, { attempts, nextRetryAt: nextRetryAt(this.clock.now(), attempts, this.backoff) });
          transitions.push([job.id, "UNAVAILABLE_BACKOFF"]);
        }
      } else { this._afterFailure(running, out?.error ?? "ai executor error", transitions); }
    } catch (e) {
      this._afterFailure(running, e instanceof Error ? e.message : String(e), transitions);
    }
  }

  _afterFailure(job, error, transitions) {
    // A side-effecting job that threw may have already performed its effect: do NOT blindly retry.
    if (job.sideEffecting) {
      this._set(job, RuntimeState.WAITING_APPROVAL, { attempts: (job.attempts ?? 0) + 1, error });
      transitions.push([job.id, "NEEDS_RECONCILIATION"]);
      return;
    }
    const attempts = (job.attempts ?? 0) + 1;
    if (attempts >= job.maxAttempts) { this._set(job, RuntimeState.FAILED, { attempts, error }); transitions.push([job.id, RuntimeState.FAILED]); }
    else { this._set(job, RuntimeState.RETRY_SCHEDULED, { attempts, error, nextRetryAt: nextRetryAt(this.clock.now(), attempts, this.backoff) }); transitions.push([job.id, RuntimeState.RETRY_SCHEDULED]); }
  }

  /**
   * Drive one poll of a WAITING_CI / READY ci-wait job. Deterministic, no LLM. Resolves entirely
   * from GitHub state fetched by the injected driver — never from a UI notification:
   *  - PR already MERGED .............. DONE (idempotent; a duplicate CI event cannot re-merge)
   *  - live head != reviewed head ..... BLOCKED, review invalidated (NEVER merges an unreviewed head)
   *  - CI SUCCESS ..................... safe-merge (exactly-once via the driver) -> DONE
   *  - CI FAILURE/CANCELLED/TIMED_OUT . BLOCKED, flagged needsFix (the fix workflow picks it up)
   *  - CI PENDING / driver UNAVAILABLE  stay WAITING_CI with bounded-backoff nextPollAt
   */
  async _tickCiWait(job, transitions) {
    const ci = job.ci ?? {};
    const now = this.clock.now();
    // Bounded backoff: do not poll again until nextPollAt is due (prevents hammering GitHub).
    if (job.state === RuntimeState.WAITING_CI && ci.nextPollAt && Date.parse(now) < Date.parse(ci.nextPollAt)) return;
    // No CI driver in THIS process: park in WAITING_CI for a CI-capable process; never stuck, never faked.
    if (!this.ci) {
      if (job.state !== RuntimeState.WAITING_CI) { this._set(job, RuntimeState.WAITING_CI, { ci }); transitions.push([job.id, RuntimeState.WAITING_CI]); }
      return;
    }
    let poll;
    try { poll = await this.ci.poll(ci); }
    catch (e) { poll = { state: "UNAVAILABLE", error: e instanceof Error ? e.message : String(e) }; }
    const attempts = (ci.attempts ?? 0) + 1;
    const base = { ...ci, attempts, lastCheckAt: now, lastCiState: poll?.state ?? "UNAVAILABLE", lastHead: poll?.head ?? ci.lastHead ?? null, prState: poll?.prState ?? ci.prState ?? null };

    if (poll?.prState === "MERGED") {
      this._set(job, RuntimeState.DONE, { ci: base, result: { merged: true, already: true } });
      transitions.push([job.id, "CI_ALREADY_MERGED"]);
      return;
    }
    if (poll?.head && ci.reviewedHead && poll.head !== ci.reviewedHead) {
      this._set(job, RuntimeState.BLOCKED, { ci: { ...base, reviewInvalidated: true }, error: `PR head ${poll.head} != reviewed ${ci.reviewedHead}; prior review is invalid, re-review required` });
      transitions.push([job.id, "CI_HEAD_CHANGED_REVIEW_INVALID"]);
      return;
    }
    if (poll?.state === "SUCCESS") {
      // Fail-closed: if the head is unverifiable (null/absent), do NOT merge — keep polling.
      if (!poll.head) {
        this._set(job, RuntimeState.WAITING_CI, { ci: { ...base, nextPollAt: nextRetryAt(now, attempts, this.backoff) } });
        transitions.push([job.id, "CI_WAIT_HEAD_UNVERIFIED"]);
        return;
      }
      // Side-effecting merge, persisted RUNNING before the effect. The driver's merge() is
      // idempotent (re-checks MERGED + head, pins --match-head-commit), so a crash-then-retry or a
      // duplicate event is safe.
      const running = this._set(job, RuntimeState.RUNNING, { ci: base });
      let res;
      try { res = await this.ci.merge({ prNumber: ci.prNumber, expectedHead: ci.reviewedHead }); }
      catch (e) { res = { ok: false, retryable: true, reason: e instanceof Error ? e.message : String(e) }; }
      if (res?.ok || res?.merged) {
        this._set(running, RuntimeState.DONE, { ci: { ...base, prState: "MERGED" }, result: { merged: true, already: !!res.already } });
        transitions.push([job.id, res?.already ? "CI_ALREADY_MERGED" : "CI_MERGED"]);
      } else if (res?.retryable) {
        // Transient/unverifiable (network, 5xx, rate-limited pre-check): retry via backoff, NEVER strand.
        this._set(running, RuntimeState.WAITING_CI, { ci: { ...base, nextPollAt: nextRetryAt(now, attempts, this.backoff) }, error: `merge retry: ${res?.reason ?? "transient"}` });
        transitions.push([job.id, "CI_MERGE_RETRY"]);
      } else {
        // Definitive safety refusal (PR closed, or head changed since review). Block for re-arm;
        // flag reviewInvalidated for a head change, needsFix otherwise.
        const headChanged = /head changed/i.test(res?.reason ?? "");
        this._set(running, RuntimeState.BLOCKED, { ci: { ...base, reviewInvalidated: headChanged }, needsFix: !headChanged, error: `safe-merge refused: ${res?.reason ?? "unknown"}` });
        transitions.push([job.id, "CI_MERGE_REFUSED"]);
      }
      return;
    }
    if (poll?.state === "FAILURE" || poll?.state === "CANCELLED" || poll?.state === "TIMED_OUT") {
      this._set(job, RuntimeState.BLOCKED, { ci: base, needsFix: true, error: `CI ${poll.state}` });
      transitions.push([job.id, `CI_${poll.state}`]);
      return;
    }
    // PENDING or UNAVAILABLE: keep waiting with bounded backoff (resolves purely by re-polling).
    this._set(job, RuntimeState.WAITING_CI, { ci: { ...base, nextPollAt: nextRetryAt(now, attempts, this.backoff) } });
    transitions.push([job.id, "CI_WAIT"]);
  }

  /**
   * Recover after a crash/restart. DONE/FAILED and all WAITING_* / RETRY_SCHEDULED jobs are
   * preserved. An interrupted (RUNNING) job is resolved WITHOUT duplicating side effects:
   *  - with a `reconcile` hook: done -> DONE, not_done -> READY, unknown -> WAITING_APPROVAL;
   *  - without it: a side-effecting job -> WAITING_APPROVAL (await an operator), a pure job -> READY.
   */
  async recover() {
    return this._withMutex(async () => this._recoverInner());
  }

  async _recoverInner() {
    this.store.load();
    const resolved = [];
    for (const job of this.store.list()) {
      if (job.state !== RuntimeState.RUNNING) continue;
      // An interrupted ci-wait merge returns to WAITING_CI and simply re-polls: the driver's merge()
      // is idempotent (it no-ops if the PR already merged), so this never double-merges.
      if (job.kind === "ci-wait") {
        this._set(job, RuntimeState.WAITING_CI, { ci: { ...(job.ci ?? {}), nextPollAt: null } });
        resolved.push([job.id, "CI_RESUME_WAIT"]);
        continue;
      }
      if (this.reconcile) {
        const r = await this.reconcile(job);
        if (r === "done") { this._set(job, RuntimeState.DONE); resolved.push([job.id, "RECONCILED_DONE"]); }
        else if (r === "not_done") { this._set(job, RuntimeState.READY); resolved.push([job.id, "RECONCILED_READY"]); }
        else { this._set(job, RuntimeState.WAITING_APPROVAL); resolved.push([job.id, "RECONCILE_UNKNOWN"]); }
      } else if (job.sideEffecting) {
        this._set(job, RuntimeState.WAITING_APPROVAL); resolved.push([job.id, "AWAIT_RECONCILE"]);
      } else {
        this._set(job, RuntimeState.READY); resolved.push([job.id, "RESET_READY"]);
      }
    }
    return { resolved, counts: this.counts() };
  }

  /** Operator decision for a WAITING_APPROVAL job: mark the (already-performed) effect DONE or (safe to redo) READY. */
  async approve(jobId, outcome /* "done" | "redo" */) {
    return this._withMutex(async () => {
      this.store.load();
      const job = this.store.get(jobId);
      if (!job || job.state !== RuntimeState.WAITING_APPROVAL) return { ok: false, reason: "Job is not awaiting approval." };
      this._set(job, outcome === "done" ? RuntimeState.DONE : RuntimeState.READY);
      return { ok: true };
    });
  }

  counts() { const c = {}; for (const j of this.store.list()) c[j.state] = (c[j.state] ?? 0) + 1; return c; }

  status() {
    const ciWaits = this.store.list().filter((j) => j.kind === "ci-wait");
    const lastGithubCheckAt = ciWaits
      .map((j) => j.ci?.lastCheckAt)
      .filter(Boolean)
      .sort()
      .pop() ?? null;
    return {
      control: this.control,
      providerAvailable: this.providerGate.isAvailable(),
      counts: this.counts(),
      jobs: this.store.list().map((j) => ({ id: j.id, name: j.name, kind: j.kind, state: j.state, attempts: j.attempts, nextRetryAt: j.nextRetryAt ?? null })),
      // Durable CI/PR monitor surface for the desktop/autopilot status view.
      ci: {
        waiting: ciWaits.filter((j) => j.state === RuntimeState.WAITING_CI).length,
        lastGithubCheckAt,
        jobs: ciWaits.map((j) => ({
          id: j.id, state: j.state, prNumber: j.ci?.prNumber ?? null, reviewedHead: j.ci?.reviewedHead ?? null,
          lastCiState: j.ci?.lastCiState ?? null, lastCheckAt: j.ci?.lastCheckAt ?? null,
          reviewInvalidated: !!j.ci?.reviewInvalidated, needsFix: !!j.needsFix,
        })),
      },
      checkpoint: this.store.meta.lastCheckpoint ?? null,
    };
  }

  /** Run tick() on an interval until control becomes "stopped" (used by the CLI `start`). */
  async startLoop(intervalMs = 5000, { sleep = (ms) => new Promise((r) => setTimeout(r, ms)), beforeTick } = {}) {
    this.resume();
    while (this.store.readControl() !== "stopped") {
      if (beforeTick) { try { await beforeTick(); } catch (e) { this.log(`beforeTick error: ${e}`); } }
      await this.tick(); // loads fresh state under the cross-process lock
      await sleep(intervalMs);
    }
    return this.status();
  }
}

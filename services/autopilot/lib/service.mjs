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
    this.backoff = deps.backoff ?? {};
    this.log = deps.logger ?? (() => {});
  }

  get control() { return this.store.readControl(); }

  addJob({ id, name, kind = "deterministic", dependsOn = [], maxAttempts = 5, sideEffecting = false }) {
    if (!id || !name) throw new Error("addJob requires id and name.");
    // Under the cross-process lock: reload, then add only if absent (idempotent by id).
    return this.store.withLockSync(() => {
      this.store.load();
      if (this.store.get(id)) return this.store.get(id);
      const now = this.clock.now();
      return this.store.upsert({
        id, name, kind, dependsOn: [...dependsOn], sideEffecting: !!sideEffecting, state: RuntimeState.READY,
        attempts: 0, maxAttempts, nextRetryAt: null, error: null, createdAt: now, updatedAt: now,
      });
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
    return this.store.withLock(async () => {
      this.store.load(); // fresh state under the lock (picks up external adds/control)
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
      // Deps became satisfiable: a previously BLOCKED job can return to READY.
      if (cur.state === RuntimeState.BLOCKED) { cur = this._set(cur, RuntimeState.READY); transitions.push([cur.id, "UNBLOCK_READY"]); }

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
   * Recover after a crash/restart. DONE/FAILED and all WAITING_* / RETRY_SCHEDULED jobs are
   * preserved. An interrupted (RUNNING) job is resolved WITHOUT duplicating side effects:
   *  - with a `reconcile` hook: done -> DONE, not_done -> READY, unknown -> WAITING_APPROVAL;
   *  - without it: a side-effecting job -> WAITING_APPROVAL (await an operator), a pure job -> READY.
   */
  async recover() {
    return this.store.withLock(async () => this._recoverInner());
  }

  async _recoverInner() {
    this.store.load();
    const resolved = [];
    for (const job of this.store.list()) {
      if (job.state !== RuntimeState.RUNNING) continue;
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
  approve(jobId, outcome /* "done" | "redo" */) {
    const job = this.store.get(jobId);
    if (!job || job.state !== RuntimeState.WAITING_APPROVAL) return { ok: false, reason: "Job is not awaiting approval." };
    this._set(job, outcome === "done" ? RuntimeState.DONE : RuntimeState.READY);
    return { ok: true };
  }

  counts() { const c = {}; for (const j of this.store.list()) c[j.state] = (c[j.state] ?? 0) + 1; return c; }

  status() {
    return {
      control: this.control,
      providerAvailable: this.providerGate.isAvailable(),
      counts: this.counts(),
      jobs: this.store.list().map((j) => ({ id: j.id, name: j.name, kind: j.kind, state: j.state, attempts: j.attempts, nextRetryAt: j.nextRetryAt ?? null })),
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

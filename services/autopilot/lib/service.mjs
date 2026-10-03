// Session-independent autopilot service.
//
// Deterministic by construction: the service itself runs deterministic job handlers WITHOUT any
// LLM. AI-dependent jobs are parked (WAITING_PROVIDER) when no provider is available and resumed
// when it returns; they are executed only by an injected aiExecutor (e.g. an AI-capable session),
// never faked here. All state is persisted to the durable JobStore so the service survives process
// restart and UI closure, and recovery never re-runs completed (DONE) work — so no commit/PR/merge
// is duplicated after a crash.
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
    this.backoff = deps.backoff ?? {};
    this.log = deps.logger ?? (() => {});
  }

  get control() {
    return this.store.meta.control ?? "run";
  }

  addJob({ id, name, kind = "deterministic", dependsOn = [], maxAttempts = 5 }) {
    if (!id || !name) throw new Error("addJob requires id and name.");
    if (this.store.get(id)) return this.store.get(id); // idempotent: never duplicate a job
    const now = this.clock.now();
    return this.store.upsert({
      id, name, kind, dependsOn: [...dependsOn], state: RuntimeState.READY,
      attempts: 0, maxAttempts, nextRetryAt: null, error: null, createdAt: now, updatedAt: now,
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
      if (!d || d.state === RuntimeState.FAILED) blocked = true;
      else if (d.state !== RuntimeState.DONE) return "pending";
    }
    return blocked ? "blocked" : "ready";
  }

  pause() { this.store.setMeta("control", "paused"); }
  resume() { this.store.setMeta("control", "run"); }
  stop() { this.store.setMeta("control", "stopped"); }

  /** One deterministic scheduling pass. Returns a summary of transitions. */
  async tick() {
    if (this.control !== "run") return { skipped: true, control: this.control };
    const transitions = [];
    for (const job of this.store.list()) {
      if (TERMINAL.has(job.state)) continue;
      const deps = this._depsStatus(job);
      if (deps === "blocked") {
        if (job.state !== RuntimeState.BLOCKED) { this._set(job, RuntimeState.BLOCKED); transitions.push([job.id, RuntimeState.BLOCKED]); }
        continue;
      }
      if (deps === "pending") continue;

      let cur = this.store.get(job.id);

      // Resume parked work when its gate reopens.
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
        if (!this.aiExecutor) continue; // provider up but no executor in THIS process: leave READY for an AI session
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
      else if (out?.status === "unavailable") { this._set(running, RuntimeState.WAITING_PROVIDER); transitions.push([job.id, RuntimeState.WAITING_PROVIDER]); }
      else { this._afterFailure(running, out?.error ?? "ai executor error", transitions); }
    } catch (e) {
      this._afterFailure(running, e instanceof Error ? e.message : String(e), transitions);
    }
  }

  _afterFailure(job, error, transitions) {
    const attempts = (job.attempts ?? 0) + 1;
    if (attempts >= job.maxAttempts) {
      this._set(job, RuntimeState.FAILED, { attempts, error });
      transitions.push([job.id, RuntimeState.FAILED]);
    } else {
      this._set(job, RuntimeState.RETRY_SCHEDULED, { attempts, error, nextRetryAt: nextRetryAt(this.clock.now(), attempts, this.backoff) });
      transitions.push([job.id, RuntimeState.RETRY_SCHEDULED]);
    }
  }

  /**
   * Recover after a crash/restart: reload durable state, and reset only jobs that were mid-flight
   * (RUNNING) back to READY. DONE/FAILED and all WAITING_* and RETRY_SCHEDULED jobs are preserved, so
   * completed side effects are never repeated and parked work is never lost.
   */
  recover() {
    this.store.load();
    const reset = [];
    for (const job of this.store.list()) {
      if (job.state === RuntimeState.RUNNING) { this._set(job, RuntimeState.READY); reset.push(job.id); }
    }
    return { reset, counts: this.counts() };
  }

  counts() {
    const c = {};
    for (const j of this.store.list()) c[j.state] = (c[j.state] ?? 0) + 1;
    return c;
  }

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
  async startLoop(intervalMs = 5000, sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
    this.resume();
    while (this.control !== "stopped") {
      this.store.load(); // pick up external control changes (pause/stop/resume) across processes
      await this.tick();
      await sleep(intervalMs);
    }
    return this.status();
  }
}

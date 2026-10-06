// @uaap/engine-core — the common contract every assurance EXECUTION ENGINE implements (Quality API,
// Web, Database, Security, …). It defines the lifecycle (discover → plan → validate-prerequisites →
// execute → collect artifacts → produce evidence → structured result) plus cancellation, timeout,
// capability and health reporting, and a deterministic `driveEngine` runner that sequences those
// steps and ALWAYS returns a structured EngineResult (never throws to the caller). Engines never
// touch a target directly — a target-touching engine receives a broker-backed transport; this core
// is transport-agnostic so it stays pure and testable.
import { newId, type AssuranceDomain, type DataClassification, type Severity } from "@uaap/core";

export const EngineStatus = {
  DONE: "DONE",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
  TIMED_OUT: "TIMED_OUT",
  PREREQ_FAILED: "PREREQ_FAILED",
} as const;
export type EngineStatus = (typeof EngineStatus)[keyof typeof EngineStatus];

export const HealthStatus = { HEALTHY: "HEALTHY", DEGRADED: "DEGRADED", UNAVAILABLE: "UNAVAILABLE" } as const;
export type HealthStatus = (typeof HealthStatus)[keyof typeof HealthStatus];

export interface EngineCapabilities {
  readonly engineId: string;
  readonly domain: AssuranceDomain;
  readonly version: string;
  /** Capability ids this engine can assure, e.g. "api.response-contract", "api.schema-drift". */
  readonly capabilities: readonly string[];
  /** True if the engine only inspects provided data and never touches a target (always safe). */
  readonly offlineOnly: boolean;
}

export interface EngineHealth {
  readonly status: HealthStatus;
  readonly detail?: string;
}

export interface EngineFinding {
  readonly id: string;
  readonly severity: Severity;
  /** Short kebab-case defect class, e.g. "response-contract-violation", "schema-drift". */
  readonly kind: string;
  readonly title: string;
  readonly detail: string;
  /** Where it was found (endpoint id, json pointer, exchange index…). */
  readonly locator?: string;
}

export interface EngineArtifact {
  readonly kind: string;
  readonly summary?: string;
  readonly ref?: string;
  readonly data?: unknown;
}

/** Evidence descriptor — shaped to feed @uaap/evidence-engine's EvidenceInput. Never a raw secret. */
export interface EngineEvidence {
  readonly producedBy: string;
  readonly action: string;
  readonly kind: string;
  readonly classification: DataClassification;
  readonly summary?: string;
  readonly data?: unknown;
  readonly ref?: string;
}

export interface EngineExecOutput {
  readonly findings: readonly EngineFinding[];
  readonly artifacts: readonly EngineArtifact[];
  readonly evidence: readonly EngineEvidence[];
}

/**
 * The sink an engine pushes results into AS it works. The driver owns it, so anything collected
 * before a cancellation / timeout / throw is PRESERVED in the final result (never silently dropped).
 */
export interface EngineCollector {
  finding(f: EngineFinding): void;
  artifact(a: EngineArtifact): void;
  evidence(e: EngineEvidence): void;
}

export interface Discovery {
  readonly items: readonly unknown[];
  readonly summary?: string;
}

export interface EnginePlan {
  readonly steps: readonly unknown[];
  readonly summary?: string;
}

export interface PrereqResult {
  readonly ok: boolean;
  /** Human-readable missing prerequisites (why execution cannot proceed). */
  readonly missing?: readonly string[];
  /** Optional findings explaining the prerequisite failure (so it is never a silent skip). */
  readonly findings?: readonly EngineFinding[];
}

export interface EngineContext {
  readonly runId: string;
  /** Engine input (spec + fixtures/exchanges). Opaque to the core. */
  readonly input: unknown;
  /** Injected clock — the core never calls Date.now directly for timestamps it records. */
  now(): string;
}

/**
 * Cooperative cancellation + deadline token. Engines MUST call throwIfCancelled() between units of
 * work; that is the ONLY way a CPU-bound (synchronous) engine can be interrupted — the deadline is
 * enforced there (Date.now based) as well as by the driver's async timeout race. An engine that never
 * checkpoints cannot be interrupted (documented contract).
 */
export class CancellationToken {
  private _cancelled = false;
  private _reason: string | undefined;
  private _deadlineMs: number | undefined;
  get cancelled(): boolean {
    return this._cancelled || this._deadlineExceeded();
  }
  get reason(): string | undefined {
    if (this._reason) return this._reason;
    return this._deadlineExceeded() ? "timeout" : undefined;
  }
  /** Absolute wall-clock deadline (epoch ms). Past it, throwIfCancelled() throws TIMED_OUT. */
  setDeadline(epochMs: number): void {
    this._deadlineMs = epochMs;
  }
  private _deadlineExceeded(): boolean {
    return this._deadlineMs !== undefined && Date.now() >= this._deadlineMs;
  }
  cancel(reason = "cancelled"): void {
    if (!this._cancelled) {
      this._cancelled = true;
      this._reason = reason;
    }
  }
  throwIfCancelled(): void {
    if (this._cancelled) throw new EngineAbort(this._reason ?? "cancelled", "CANCELLED");
    if (this._deadlineExceeded()) throw new EngineAbort("deadline exceeded", "TIMED_OUT");
  }
}

export class EngineAbort extends Error {
  constructor(message: string, readonly status: "CANCELLED" | "TIMED_OUT") {
    super(message);
    this.name = "EngineAbort";
  }
}

export interface ExecutionEngine {
  capabilities(): EngineCapabilities;
  health(): EngineHealth;
  discover(ctx: EngineContext): Promise<Discovery> | Discovery;
  plan(ctx: EngineContext, discovery: Discovery): Promise<EnginePlan> | EnginePlan;
  validatePrereqs(ctx: EngineContext, plan: EnginePlan): Promise<PrereqResult> | PrereqResult;
  /** Perform the checks, pushing each result into `collector` as it is produced (so partial results
   * survive an abort). Check `token.throwIfCancelled()` between units of work. */
  execute(ctx: EngineContext, plan: EnginePlan, token: CancellationToken, collector: EngineCollector): Promise<void> | void;
}

export interface EngineResult {
  readonly engineId: string;
  readonly runId: string;
  readonly domain: AssuranceDomain;
  readonly status: EngineStatus;
  readonly findings: readonly EngineFinding[];
  readonly artifacts: readonly EngineArtifact[];
  readonly evidence: readonly EngineEvidence[];
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly error?: string;
  readonly counts: { readonly findings: number; readonly bySeverity: Readonly<Record<string, number>> };
}

export interface DriveOptions {
  readonly timeoutMs?: number;
  readonly token?: CancellationToken;
}

function makeFinding(input: Omit<EngineFinding, "id">): EngineFinding {
  return { id: newId("FND"), ...input };
}

function tally(findings: readonly EngineFinding[]): EngineResult["counts"] {
  const bySeverity: Record<string, number> = {};
  for (const f of findings) bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
  return { findings: findings.length, bySeverity };
}

async function withTimeout<T>(p: Promise<T>, timeoutMs: number, token: CancellationToken): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      token.cancel("timeout"); // cooperative: signal the engine to stop at its next checkpoint
      reject(new EngineAbort(`engine timed out after ${timeoutMs}ms`, "TIMED_OUT"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Drive one engine through the full lifecycle and return a structured result. Deterministic and
 * TOTAL: a throw from ANY step (capabilities/health/discover/plan/prereqs/execute, or ctx.now),
 * a cancellation, a timeout, an UNAVAILABLE health check, or a failed prerequisite all map to an
 * EngineResult with the right status — the caller never gets an exception. Findings/evidence the
 * engine pushed into the collector BEFORE the stop are preserved (not silently dropped).
 *
 * Timeout is enforced two ways: the async race (for engines that await I/O) AND a wall-clock deadline
 * on the token (so a cooperative CPU-bound engine that calls throwIfCancelled() is also bounded). An
 * engine that never checkpoints and never yields cannot be interrupted — that is an engine-author bug.
 */
export async function driveEngine(engine: ExecutionEngine, ctx: EngineContext, opts: DriveOptions = {}): Promise<EngineResult> {
  const findings: EngineFinding[] = [];
  const artifacts: EngineArtifact[] = [];
  const evidence: EngineEvidence[] = [];
  const collector: EngineCollector = {
    finding: (f) => findings.push(f),
    artifact: (a) => artifacts.push(a),
    evidence: (e) => evidence.push(e),
  };
  const token = opts.token ?? new CancellationToken();
  const nowSafe = (): string => {
    try {
      return ctx.now();
    } catch {
      return new Date(0).toISOString();
    }
  };
  let engineId = "unknown";
  let domain: AssuranceDomain = "QUALITY";
  let startedAt = nowSafe();
  const finalize = (status: EngineStatus, error?: string): EngineResult => ({
    engineId,
    runId: ctx.runId,
    domain,
    status,
    findings: [...findings],
    artifacts: [...artifacts],
    evidence: [...evidence],
    startedAt,
    finishedAt: nowSafe(),
    ...(error !== undefined ? { error } : {}),
    counts: tally(findings),
  });

  try {
    const caps = engine.capabilities(); // inside try: a throwing engine still yields a FAILED result
    engineId = caps.engineId;
    domain = caps.domain;
    startedAt = nowSafe();
    const health = engine.health();
    if (health.status === HealthStatus.UNAVAILABLE) {
      return finalize(EngineStatus.FAILED, `engine unavailable${health.detail ? `: ${health.detail}` : ""}`);
    }
    if (opts.timeoutMs !== undefined) token.setDeadline(Date.now() + Math.max(0, opts.timeoutMs));

    const run = async (): Promise<EngineStatus> => {
      const discovery = await engine.discover(ctx);
      token.throwIfCancelled();
      const plan = await engine.plan(ctx, discovery);
      token.throwIfCancelled();
      const pre = await engine.validatePrereqs(ctx, plan);
      if (!pre.ok) {
        const pf = pre.findings && pre.findings.length > 0
          ? pre.findings
          : [makeFinding({ severity: "P2", kind: "prerequisite-failed", title: "Engine prerequisites not satisfied", detail: (pre.missing ?? ["unspecified"]).join("; ") })];
        for (const f of pf) collector.finding(f);
        return EngineStatus.PREREQ_FAILED;
      }
      token.throwIfCancelled();
      await engine.execute(ctx, plan, token, collector);
      return EngineStatus.DONE;
    };

    const status = opts.timeoutMs !== undefined ? await withTimeout(run(), opts.timeoutMs, token) : await run();
    // The deadline/cancel may have fired without the engine throwing (e.g. it finished just after):
    // reflect it in the status rather than reporting a DONE for a run that was actually cut short.
    if (status === EngineStatus.DONE && token.cancelled) {
      return finalize(token.reason === "timeout" ? EngineStatus.TIMED_OUT : EngineStatus.CANCELLED);
    }
    return finalize(status);
  } catch (e) {
    if (e instanceof EngineAbort) return finalize(e.status, e.message);
    return finalize(EngineStatus.FAILED, e instanceof Error ? e.message : String(e));
  }
}

/** Helper for engines to mint findings with ids. */
export function finding(input: Omit<EngineFinding, "id">): EngineFinding {
  return makeFinding(input);
}

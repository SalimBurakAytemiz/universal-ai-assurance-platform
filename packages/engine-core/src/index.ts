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

/** Cooperative cancellation token. Engines check it between units of work. */
export class CancellationToken {
  private _cancelled = false;
  private _reason: string | undefined;
  get cancelled(): boolean {
    return this._cancelled;
  }
  get reason(): string | undefined {
    return this._reason;
  }
  cancel(reason = "cancelled"): void {
    if (!this._cancelled) {
      this._cancelled = true;
      this._reason = reason;
    }
  }
  throwIfCancelled(): void {
    if (this._cancelled) throw new EngineAbort(this._reason ?? "cancelled", "CANCELLED");
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
  execute(ctx: EngineContext, plan: EnginePlan, token: CancellationToken): Promise<EngineExecOutput> | EngineExecOutput;
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
 * total: a thrown error, a cancellation, a timeout, an UNAVAILABLE health check, or a failed
 * prerequisite all map to an EngineResult with the right status — the caller never gets an
 * exception and findings/evidence collected before the stop are preserved.
 */
export async function driveEngine(engine: ExecutionEngine, ctx: EngineContext, opts: DriveOptions = {}): Promise<EngineResult> {
  const caps = engine.capabilities();
  const startedAt = ctx.now();
  const token = opts.token ?? new CancellationToken();
  const finalize = (status: EngineStatus, out: Partial<EngineExecOutput> & { error?: string }): EngineResult => ({
    engineId: caps.engineId,
    runId: ctx.runId,
    domain: caps.domain,
    status,
    findings: out.findings ?? [],
    artifacts: out.artifacts ?? [],
    evidence: out.evidence ?? [],
    startedAt,
    finishedAt: ctx.now(),
    ...(out.error !== undefined ? { error: out.error } : {}),
    counts: tally(out.findings ?? []),
  });

  const health = engine.health();
  if (health.status === HealthStatus.UNAVAILABLE) {
    return finalize(EngineStatus.FAILED, { error: `engine unavailable${health.detail ? `: ${health.detail}` : ""}` });
  }

  const run = async (): Promise<EngineResult> => {
    const discovery = await engine.discover(ctx);
    token.throwIfCancelled();
    const plan = await engine.plan(ctx, discovery);
    token.throwIfCancelled();
    const pre = await engine.validatePrereqs(ctx, plan);
    if (!pre.ok) {
      const findings =
        pre.findings && pre.findings.length > 0
          ? pre.findings
          : [makeFinding({ severity: "P2", kind: "prerequisite-failed", title: "Engine prerequisites not satisfied", detail: (pre.missing ?? ["unspecified"]).join("; ") })];
      return finalize(EngineStatus.PREREQ_FAILED, { findings });
    }
    token.throwIfCancelled();
    const out = await engine.execute(ctx, plan, token);
    return finalize(EngineStatus.DONE, out);
  };

  try {
    return opts.timeoutMs ? await withTimeout(run(), opts.timeoutMs, token) : await run();
  } catch (e) {
    if (e instanceof EngineAbort) return finalize(e.status, { error: e.message });
    return finalize(EngineStatus.FAILED, { error: e instanceof Error ? e.message : String(e) });
  }
}

/** Helper for engines to mint findings with ids. */
export function finding(input: Omit<EngineFinding, "id">): EngineFinding {
  return makeFinding(input);
}

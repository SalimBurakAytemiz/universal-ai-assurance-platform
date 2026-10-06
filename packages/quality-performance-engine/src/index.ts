// @uaap/quality-performance-engine — a performance assurance engine on the @uaap/engine-core
// lifecycle. It validates RECORDED latency samples against bounded budgets (p50/p95/p99/max latency
// and error rate) per endpoint. It does NOT generate load — active load generation against a target
// needs that target + authorization + a tool like k6, and would run through the broker. This engine
// analyzes measurements that were already captured (local fixtures today; a broker-produced sample
// set later), so it is OFFLINE-ONLY with nothing to authorize. Fail-closed: a budget with no usable
// samples is UNVERIFIABLE (never a silent pass); a clean sample set within budget yields zero findings.
import type { Severity } from "@uaap/core";
import {
  CancellationToken,
  finding,
  HealthStatus,
  type Discovery,
  type EngineCapabilities,
  type EngineCollector,
  type EngineContext,
  type EngineFinding,
  type EngineHealth,
  type EnginePlan,
  type ExecutionEngine,
  type PrereqResult,
} from "@uaap/engine-core";

export interface Thresholds {
  readonly p50?: number;
  readonly p95?: number;
  readonly p99?: number;
  readonly max?: number;
  /** Allowed error fraction in [0,1]. */
  readonly errorRate?: number;
}
export interface EndpointBudget {
  readonly id: string;
  readonly thresholds: Thresholds;
}
export interface PerfBudgets {
  readonly endpoints: readonly EndpointBudget[];
}
export interface PerfSample {
  readonly latencyMs: number;
  /** false => counted as an error for errorRate; anything else => success. */
  readonly ok?: boolean;
  readonly ts?: string | number;
}
export interface PerfEngineInput {
  readonly budgets: PerfBudgets;
  readonly samples: Readonly<Record<string, ReadonlyArray<PerfSample>>>;
}

const SEV = { P0: "P0", P1: "P1", P2: "P2", P3: "P3" } as const;
const LATENCY_METRICS = ["p50", "p95", "p99", "max"] as const;
const KNOWN_THRESHOLDS: ReadonlySet<string> = new Set([...LATENCY_METRICS, "errorRate"]);

/** Nearest-rank percentile over an ascending-sorted array (p in 0..100). */
function percentile(sortedAsc: readonly number[], p: number): number {
  const n = sortedAsc.length;
  if (n === 0) return NaN;
  if (p <= 0) return sortedAsc[0]!;
  if (p >= 100) return sortedAsc[n - 1]!;
  const rank = Math.ceil((p / 100) * n);
  const idx = Math.min(n - 1, Math.max(0, rank - 1));
  return sortedAsc[idx]!;
}

export class QualityPerformanceEngine implements ExecutionEngine {
  capabilities(): EngineCapabilities {
    return {
      engineId: "qa.performance-engine",
      domain: "PERFORMANCE",
      version: "0.1.0",
      capabilities: ["perf.latency-p50", "perf.latency-p95", "perf.latency-p99", "perf.latency-max", "perf.error-rate"],
      offlineOnly: true,
    };
  }
  health(): EngineHealth {
    return { status: HealthStatus.HEALTHY };
  }

  private input(ctx: EngineContext): PerfEngineInput {
    return ctx.input as PerfEngineInput;
  }
  private endpointsOf(ctx: EngineContext): readonly EndpointBudget[] {
    const e = (this.input(ctx)?.budgets as { endpoints?: unknown })?.endpoints;
    return Array.isArray(e) ? (e as EndpointBudget[]) : [];
  }

  discover(ctx: EngineContext): Discovery {
    const samples = this.input(ctx)?.samples;
    const endpoints = this.endpointsOf(ctx);
    return {
      items: endpoints.map((e) => e?.id),
      summary: `${endpoints.length} budget(s); ${samples && typeof samples === "object" ? Object.keys(samples).length : 0} sampled endpoint(s)`,
    };
  }

  plan(ctx: EngineContext, _discovery: Discovery): EnginePlan {
    const endpoints = this.endpointsOf(ctx);
    return { steps: endpoints.map((e) => ({ endpoint: e?.id })), summary: `evaluate ${endpoints.length} budget(s)` };
  }

  validatePrereqs(ctx: EngineContext, _plan: EnginePlan): PrereqResult {
    const input = this.input(ctx);
    const missing: string[] = [];
    if (!input || typeof input !== "object") missing.push("input is missing");
    else {
      if (!input.budgets || !Array.isArray(input.budgets.endpoints) || input.budgets.endpoints.length === 0) missing.push("budgets.endpoints is empty");
      if (!input.samples || typeof input.samples !== "object") missing.push("samples is missing");
    }
    return missing.length === 0 ? { ok: true } : { ok: false, missing };
  }

  execute(ctx: EngineContext, _plan: EnginePlan, token: CancellationToken, collector: EngineCollector): void {
    const input = this.input(ctx);
    const samples = input?.samples && typeof input.samples === "object" ? input.samples : {};

    // Admit well-formed budgets; a DUPLICATE endpoint id is ambiguous -> fail closed (keep first).
    const budgetById = new Map<string, EndpointBudget>();
    for (const b of this.endpointsOf(ctx)) {
      if (!(b && typeof b === "object" && typeof b.id === "string" && b.thresholds && typeof b.thresholds === "object")) {
        collector.finding(finding({ severity: SEV.P2, kind: "malformed-budget", title: "Malformed endpoint budget", detail: "A budget is null, has no string id, or has no thresholds object; skipped.", locator: "budgets.endpoints" }));
        continue;
      }
      if (budgetById.has(b.id)) {
        collector.finding(finding({ severity: SEV.P2, kind: "duplicate-budget", title: "Duplicate endpoint budget", detail: `Endpoint "${b.id}" has more than one budget; the ambiguous later one is ignored (first kept).`, locator: "budgets.endpoints" }));
        continue;
      }
      budgetById.set(b.id, b);
    }

    for (const name of Object.keys(samples)) {
      if (!budgetById.has(name)) collector.finding(finding({ severity: SEV.P3, kind: "unbudgeted-samples", title: "Samples without a budget", detail: `Samples for "${name}" have no declared budget; not evaluated.`, locator: `samples.${name}` }));
    }

    let evaluated = 0;
    for (const budget of budgetById.values()) {
      token.throwIfCancelled();
      const loc = `endpoint ${budget.id}`;
      try {
        const raw = samples[budget.id];
        if (!Array.isArray(raw)) {
          collector.finding(finding({ severity: SEV.P2, kind: "budget-unverifiable", title: "Budget has no samples", detail: `Endpoint "${budget.id}" declares a budget but has no sample array; it cannot pass (fail-closed).`, locator: loc }));
          continue;
        }
        const th = budget.thresholds;
        let violations = 0;
        const add = (f: EngineFinding) => {
          violations++;
          collector.finding(f);
        };

        // A threshold value is usable only if finite AND in its valid RANGE: latency budgets must be
        // >= 0 (a negative latency budget would cry wolf on healthy samples); errorRate must be in
        // [0,1] (an errorRate >= 1 can never fire — a silent false green; < 0 is nonsense).
        const inRange = (key: string, v: number): boolean => (key === "errorRate" ? v >= 0 && v <= 1 : v >= 0);
        const usable = (key: string, v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && inRange(key, v);
        // Fail-closed vocabulary + VALUE + RANGE validation: an unknown key, or a known key whose value
        // is non-finite or out of its valid range (e.g. "100", NaN, errorRate:5, p95:-5), is surfaced.
        for (const [key, val] of Object.entries(th)) {
          if (!KNOWN_THRESHOLDS.has(key)) add(finding({ severity: SEV.P2, kind: "unknown-threshold", title: "Unknown performance threshold", detail: `Endpoint "${budget.id}" declares threshold "${key}" which is not one of ${[...KNOWN_THRESHOLDS].join("/")}.`, locator: loc }));
          else if (!usable(key, val)) add(finding({ severity: SEV.P2, kind: "malformed-threshold", title: "Malformed performance threshold", detail: `Endpoint "${budget.id}" threshold "${key}" = ${JSON.stringify(val)} is not a finite number in its valid range (${key === "errorRate" ? "[0,1]" : ">= 0"}); it cannot be enforced (fail-closed).`, locator: loc }));
        }
        const limitOf = (k: "p50" | "p95" | "p99" | "max"): number | undefined => (usable(k, th[k]) ? (th[k] as number) : undefined);

        // Classify samples. A latency is usable only if it is a finite, NON-NEGATIVE number (a
        // negative latency is impossible and would deflate percentiles -> flagged malformed). The
        // error-rate base counts every observed request: any sample with a boolean `ok` OR a usable
        // latency; `ok===false` (even without a latency, e.g. a timeout) is an error.
        const latencies: number[] = [];
        let errors = 0;
        let errorTotal = 0;
        raw.forEach((s, i) => {
          const sloc = `${loc} sample[${i}]`;
          if (!s || typeof s !== "object") {
            add(finding({ severity: SEV.P2, kind: "malformed-sample", title: "Malformed performance sample", detail: `Sample ${i} is null or not an object.`, locator: sloc }));
            return;
          }
          const hasLatKey = Object.prototype.hasOwnProperty.call(s, "latencyMs");
          const latVal = (s as { latencyMs?: unknown }).latencyMs;
          const validLat = typeof latVal === "number" && Number.isFinite(latVal) && latVal >= 0;
          const hasOk = typeof s.ok === "boolean";
          if (validLat) latencies.push(latVal as number);
          else if (hasLatKey) add(finding({ severity: SEV.P2, kind: "malformed-sample", title: "Malformed performance sample", detail: `Sample ${i} latencyMs=${JSON.stringify(latVal)} is not a finite non-negative number.`, locator: sloc }));
          else if (!hasOk) add(finding({ severity: SEV.P2, kind: "malformed-sample", title: "Malformed performance sample", detail: `Sample ${i} has neither a usable latencyMs nor an ok flag.`, locator: sloc }));
          if (hasOk || validLat) {
            errorTotal++;
            if (s.ok === false) errors++;
          }
        });

        if (latencies.length === 0 && errorTotal === 0) {
          collector.finding(finding({ severity: SEV.P2, kind: "budget-unverifiable", title: "Budget has no usable samples", detail: `Endpoint "${budget.id}" has no usable samples; the budget cannot be evaluated (fail-closed).`, locator: loc }));
          continue;
        }
        evaluated++;
        const sorted = [...latencies].sort((a, b) => a - b);
        const computed = {
          p50: percentile(sorted, 50),
          p95: percentile(sorted, 95),
          p99: percentile(sorted, 99),
          max: sorted.length > 0 ? sorted[sorted.length - 1]! : NaN,
          errorRate: errorTotal > 0 ? errors / errorTotal : NaN,
        };

        for (const metric of LATENCY_METRICS) {
          const limit = limitOf(metric);
          if (limit === undefined) continue;
          if (latencies.length === 0) {
            add(finding({ severity: SEV.P2, kind: "budget-unverifiable", title: "Latency budget unverifiable", detail: `Endpoint "${budget.id}" declares a ${metric} budget but has no usable latency samples.`, locator: loc }));
          } else if (computed[metric] > limit) {
            add(finding({ severity: SEV.P1, kind: "latency-budget-exceeded", title: `Latency budget exceeded (${metric})`, detail: `${metric} = ${computed[metric].toFixed(2)}ms exceeds budget ${limit}ms.`, locator: loc }));
          }
        }
        if (usable("errorRate", th.errorRate)) {
          if (errorTotal === 0) add(finding({ severity: SEV.P2, kind: "budget-unverifiable", title: "Error-rate budget unverifiable", detail: `Endpoint "${budget.id}" declares an errorRate budget but has no samples with a delivery outcome.`, locator: loc }));
          else if (computed.errorRate > th.errorRate) add(finding({ severity: SEV.P1, kind: "error-rate-exceeded", title: "Error rate budget exceeded", detail: `error rate = ${(computed.errorRate * 100).toFixed(2)}% exceeds budget ${(th.errorRate * 100).toFixed(2)}% (${errors}/${errorTotal}).`, locator: loc }));
        }

        collector.evidence({
          producedBy: "qa.performance-engine",
          action: "perf.budget.evaluate",
          kind: "METRIC",
          classification: "INTERNAL",
          summary: `endpoint ${budget.id}: n=${latencies.length}, reqs=${errorTotal}, p95=${Number.isNaN(computed.p95) ? "n/a" : computed.p95.toFixed(1) + "ms"}, err=${Number.isNaN(computed.errorRate) ? "n/a" : (computed.errorRate * 100).toFixed(1) + "%"}, ${violations} violation(s)`,
          data: { endpoint: budget.id, latencySamples: latencies.length, requestSamples: errorTotal, computed, violations, at: ctx.now() },
        });
      } catch (e) {
        collector.finding(finding({ severity: SEV.P2, kind: "engine-error", title: "Engine error while evaluating budget", detail: e instanceof Error ? e.message : String(e), locator: loc }));
      }
    }

    collector.artifact({
      kind: "performance-summary",
      summary: `${evaluated}/${budgetById.size} budget(s) evaluated`,
      data: { declaredBudgets: budgetById.size, evaluatedBudgets: evaluated },
    });
  }
}

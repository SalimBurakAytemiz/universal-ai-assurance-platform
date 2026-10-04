// Agent evaluation + certification. Enforces SELF-LEARNING != SELF-TRUSTING on the agent side:
// an agent/model version is a trusted default ONLY after it passes an evaluation benchmark and is
// certified by someone OTHER than itself; a new version that REGRESSES on ANY tracked metric against
// the certified baseline is never auto-promoted; certification is the only gate to ACTIVE.

export const CertStatus = {
  DRAFT: "DRAFT", SANDBOX: "SANDBOX", EVALUATING: "EVALUATING", CERTIFIED: "CERTIFIED", ACTIVE: "ACTIVE",
  SUSPENDED: "SUSPENDED", DEPRECATED: "DEPRECATED", RETIRED: "RETIRED", FAILED_CERTIFICATION: "FAILED_CERTIFICATION",
} as const;
export type CertStatus = (typeof CertStatus)[keyof typeof CertStatus];

export interface CaseOutcome {
  readonly id: string;
  readonly correct: boolean;
  /** Whether this case ACTUALLY contains a finding/positive (for correct FP/FN denominators). */
  readonly expectedPositive?: boolean;
  readonly falsePositive?: boolean;
  readonly falseNegative?: boolean;
  readonly policyCompliant: boolean;
  readonly evidenceOk: boolean;
  readonly latencyMs: number;
  readonly tokenCost: number;
  readonly recovered?: boolean;
}

export interface EvaluationMetrics {
  readonly total: number;
  readonly correctness: number;
  readonly falsePositiveRate: number; // FP / actual-negatives
  readonly falseNegativeRate: number; // FN / actual-positives
  readonly policyCompliance: number; // must be 1.0 to certify
  readonly evidenceQuality: number;
  readonly reproducibility: number;
  readonly avgLatencyMs: number;
  readonly totalTokenCost: number;
  readonly failureRecovery: number;
}

export interface EvaluationResult {
  readonly agentId: string;
  readonly version: string;
  readonly metrics: EvaluationMetrics;
  readonly at: string;
}

const rate = (n: number, d: number): number => (d === 0 ? 0 : n / d);

/**
 * Aggregate per-case outcomes into metrics. FP/FN rates use the actual negative/positive
 * populations (from `expectedPositive`), not the total case count. If a population is zero but the
 * corresponding error occurred, the rate is 1 (fail-closed) rather than hidden by a 0 denominator.
 * `reproducible` (matched/repeats) is supplied by runEvaluation; when absent reproducibility is 1
 * (callers of this low-level util are responsible for measuring it — the gate consumes runEvaluation).
 */
export function aggregateMetrics(outcomes: readonly CaseOutcome[], reproducible?: { matched: number; repeats: number }): EvaluationMetrics {
  const total = outcomes.length;
  const correct = outcomes.filter((o) => o.correct).length;
  const fp = outcomes.filter((o) => o.falsePositive).length;
  const fn = outcomes.filter((o) => o.falseNegative).length;
  const positives = outcomes.filter((o) => o.expectedPositive === true).length;
  const negatives = outcomes.filter((o) => o.expectedPositive === false).length;
  const compliant = outcomes.filter((o) => o.policyCompliant).length;
  const evidence = outcomes.filter((o) => o.evidenceOk).length;
  const recoveryCases = outcomes.filter((o) => o.recovered !== undefined);
  const recovered = recoveryCases.filter((o) => o.recovered).length;
  return {
    total,
    correctness: rate(correct, total),
    falsePositiveRate: negatives > 0 ? rate(fp, negatives) : fp > 0 ? 1 : 0,
    falseNegativeRate: positives > 0 ? rate(fn, positives) : fn > 0 ? 1 : 0,
    policyCompliance: rate(compliant, total),
    evidenceQuality: rate(evidence, total),
    reproducibility: reproducible && reproducible.repeats > 0 ? rate(reproducible.matched, reproducible.repeats) : 1,
    avgLatencyMs: total === 0 ? 0 : outcomes.reduce((a, o) => a + o.latencyMs, 0) / total,
    totalTokenCost: outcomes.reduce((a, o) => a + o.tokenCost, 0),
    failureRecovery: recoveryCases.length === 0 ? 1 : rate(recovered, recoveryCases.length),
  };
}

/**
 * Run an evaluation by driving an injected runner over the benchmark cases. Each case is run
 * `repeats` times (default 3) to MEASURE reproducibility. A case declaring `recovery: true` whose
 * outcome omits `recovered` is scored as NOT recovered (fail-closed), so a declared recovery test
 * can never pass vacuously.
 */
export async function runEvaluation(
  agentId: string,
  version: string,
  cases: readonly { id: string; recovery?: boolean }[],
  runner: (caseId: string) => Promise<CaseOutcome>,
  now: string,
  opts: { repeats?: number } = {},
): Promise<EvaluationResult> {
  const repeats = Math.max(1, opts.repeats ?? 3);
  const outcomes: CaseOutcome[] = [];
  let matched = 0;
  let totalRepeats = 0;
  for (const c of cases) {
    const primary = coerceRecovery(c, await runner(c.id));
    outcomes.push(primary);
    for (let r = 1; r < repeats; r++) {
      const extra = await runner(c.id);
      totalRepeats++;
      if (extra.correct === primary.correct && !!extra.falsePositive === !!primary.falsePositive && !!extra.falseNegative === !!primary.falseNegative) matched++;
    }
  }
  return { agentId, version, metrics: aggregateMetrics(outcomes, totalRepeats > 0 ? { matched, repeats: totalRepeats } : undefined), at: now };
}

function coerceRecovery(c: { recovery?: boolean }, o: CaseOutcome): CaseOutcome {
  return c.recovery ? { ...o, recovered: o.recovered ?? false } : o;
}

export interface CertificationThresholds {
  readonly minCases: number;
  readonly minCorrectness: number;
  readonly maxFalsePositiveRate: number;
  readonly maxFalseNegativeRate: number;
  readonly minEvidenceQuality: number;
  readonly minReproducibility: number;
  readonly minFailureRecovery: number;
}

export const DEFAULT_THRESHOLDS: CertificationThresholds = {
  minCases: 10,
  minCorrectness: 0.9,
  maxFalsePositiveRate: 0.05,
  maxFalseNegativeRate: 0.1,
  minEvidenceQuality: 0.95,
  minReproducibility: 0.95,
  minFailureRecovery: 0.9,
};

export type CertDecision =
  | { readonly decision: "CERTIFY"; readonly reasons: string[] }
  | { readonly decision: "DO_NOT_PROMOTE"; readonly reasons: string[] }
  | { readonly decision: "FAIL"; readonly reasons: string[] };

const canon = (s: string | undefined): string => (s ?? "").trim().toLowerCase();

/**
 * Decide certification. FAILs if certifiedBy is missing, equals the agent (case/space-insensitive —
 * no self-certification), the sample is too small, any metric is non-finite, policy compliance is
 * not perfect, or any threshold is missed. If a certified baseline exists, a regression on ANY
 * tracked metric yields DO_NOT_PROMOTE.
 */
export function decideCertification(
  result: EvaluationResult,
  certifiedBy: string,
  thresholds: CertificationThresholds = DEFAULT_THRESHOLDS,
  baseline?: EvaluationMetrics,
): CertDecision {
  const m = result.metrics;
  const fail: string[] = [];

  // Finiteness first: a NaN/Infinity metric must FAIL, not silently skip a `<`/`>` gate.
  const nums: Record<string, number> = {
    correctness: m.correctness, falsePositiveRate: m.falsePositiveRate, falseNegativeRate: m.falseNegativeRate,
    policyCompliance: m.policyCompliance, evidenceQuality: m.evidenceQuality, reproducibility: m.reproducibility,
    failureRecovery: m.failureRecovery, total: m.total,
  };
  for (const [k, v] of Object.entries(nums)) if (!Number.isFinite(v)) fail.push(`Metric ${k} is not a finite number.`);

  if (!certifiedBy?.trim()) fail.push("certifiedBy is required.");
  if (canon(certifiedBy) === canon(result.agentId)) fail.push("An agent cannot certify itself (separation of duties).");
  if (m.total < thresholds.minCases) fail.push(`Sample size ${m.total} < minimum ${thresholds.minCases}.`);
  if (m.policyCompliance < 1) fail.push(`Policy compliance ${m.policyCompliance} < 1.0 (non-negotiable).`);
  if (m.correctness < thresholds.minCorrectness) fail.push(`Correctness ${m.correctness} < ${thresholds.minCorrectness}.`);
  if (m.falsePositiveRate > thresholds.maxFalsePositiveRate) fail.push(`False-positive rate ${m.falsePositiveRate} > ${thresholds.maxFalsePositiveRate}.`);
  if (m.falseNegativeRate > thresholds.maxFalseNegativeRate) fail.push(`False-negative rate ${m.falseNegativeRate} > ${thresholds.maxFalseNegativeRate}.`);
  if (m.evidenceQuality < thresholds.minEvidenceQuality) fail.push(`Evidence quality ${m.evidenceQuality} < ${thresholds.minEvidenceQuality}.`);
  if (m.reproducibility < thresholds.minReproducibility) fail.push(`Reproducibility ${m.reproducibility} < ${thresholds.minReproducibility}.`);
  if (m.failureRecovery < thresholds.minFailureRecovery) fail.push(`Failure recovery ${m.failureRecovery} < ${thresholds.minFailureRecovery}.`);
  if (fail.length > 0) return { decision: "FAIL", reasons: fail };

  if (baseline) {
    const reg: string[] = [];
    const worseHigher = (cur: number, base: number, name: string) => { if (Number.isFinite(base) && cur > base) reg.push(`${name} regressed (${cur} > baseline ${base}).`); };
    const worseLower = (cur: number, base: number, name: string) => { if (Number.isFinite(base) && cur < base) reg.push(`${name} regressed (${cur} < baseline ${base}).`); };
    worseLower(m.correctness, baseline.correctness, "Correctness");
    worseHigher(m.falsePositiveRate, baseline.falsePositiveRate, "False-positive rate");
    worseHigher(m.falseNegativeRate, baseline.falseNegativeRate, "False-negative rate");
    worseLower(m.evidenceQuality, baseline.evidenceQuality, "Evidence quality");
    worseLower(m.reproducibility, baseline.reproducibility, "Reproducibility");
    worseLower(m.failureRecovery, baseline.failureRecovery, "Failure recovery");
    if (reg.length > 0) return { decision: "DO_NOT_PROMOTE", reasons: reg };
  }
  return { decision: "CERTIFY", reasons: ["Meets all thresholds" + (baseline ? " and does not regress against the certified baseline." : ".")] };
}

const CERT_TRANSITIONS: Record<CertStatus, readonly CertStatus[]> = {
  DRAFT: [CertStatus.SANDBOX],
  SANDBOX: [CertStatus.EVALUATING],
  EVALUATING: [CertStatus.CERTIFIED, CertStatus.FAILED_CERTIFICATION],
  CERTIFIED: [CertStatus.ACTIVE, CertStatus.SUSPENDED, CertStatus.DEPRECATED],
  ACTIVE: [CertStatus.SUSPENDED, CertStatus.DEPRECATED],
  SUSPENDED: [CertStatus.EVALUATING, CertStatus.DEPRECATED, CertStatus.RETIRED],
  DEPRECATED: [CertStatus.RETIRED],
  RETIRED: [],
  FAILED_CERTIFICATION: [CertStatus.SANDBOX, CertStatus.RETIRED],
};

export function canTransition(from: CertStatus, to: CertStatus): boolean {
  return (CERT_TRANSITIONS[from] ?? []).includes(to);
}

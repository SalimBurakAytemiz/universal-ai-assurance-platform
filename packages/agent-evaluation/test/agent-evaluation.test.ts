import { describe, it, expect } from "vitest";
import {
  aggregateMetrics,
  runEvaluation,
  decideCertification,
  canTransition,
  CertStatus,
  DEFAULT_THRESHOLDS,
  type CaseOutcome,
  type EvaluationResult,
  type EvaluationMetrics,
} from "@uaap/agent-evaluation";

const NOW = "2026-10-04T12:00:00.000Z";

function outcome(o: Partial<CaseOutcome> = {}): CaseOutcome {
  return { id: "c", correct: true, expectedPositive: false, policyCompliant: true, evidenceOk: true, latencyMs: 10, tokenCost: 100, ...o };
}

/** 20 clean cases (alternating positive/negative populations) -> all gates pass. */
function perfectMetrics(): EvaluationMetrics {
  return aggregateMetrics(Array.from({ length: 20 }, (_, i) => outcome({ id: `c${i}`, expectedPositive: i % 2 === 0 })));
}
function perfectResult(agentId = "qa.api-contract"): EvaluationResult {
  return { agentId, version: "1.0.0", metrics: perfectMetrics(), at: NOW };
}

describe("aggregateMetrics", () => {
  it("uses actual negative/positive populations for FP/FN rates", () => {
    const m = aggregateMetrics([
      outcome({ correct: true, expectedPositive: false }), // negative, ok
      outcome({ correct: false, expectedPositive: true, falseNegative: true }), // positive, missed
      outcome({ correct: false, expectedPositive: false, falsePositive: true, policyCompliant: false }), // negative, FP
      outcome({ correct: true, expectedPositive: true, evidenceOk: false }), // positive, ok
    ]);
    expect(m.total).toBe(4);
    expect(m.correctness).toBe(0.5);
    expect(m.falsePositiveRate).toBe(0.5); // 1 FP / 2 negatives
    expect(m.falseNegativeRate).toBe(0.5); // 1 FN / 2 positives
    expect(m.policyCompliance).toBe(0.75);
    expect(m.evidenceQuality).toBe(0.75);
  });

  it("failureRecovery is 1 when no case tested recovery, else the recovered fraction", () => {
    expect(aggregateMetrics([outcome()]).failureRecovery).toBe(1);
    expect(aggregateMetrics([outcome({ recovered: true }), outcome({ recovered: false })]).failureRecovery).toBe(0.5);
  });
});

describe("runEvaluation", () => {
  it("drives the runner and MEASURES reproducibility across repeats", async () => {
    const calls: Record<string, number> = {};
    // flaky runner: correct on call 1 & 3, wrong on call 2 -> 1 of 2 repeats match
    const r = await runEvaluation("a", "1.0.0", [{ id: "x" }], async (id) => {
      calls[id] = (calls[id] ?? 0) + 1;
      return outcome({ id, correct: calls[id] !== 2 });
    }, NOW, { repeats: 3 });
    expect(r.metrics.reproducibility).toBe(0.5);
  });

  it("scores a declared recovery case with no `recovered` as NOT recovered (fail-closed)", async () => {
    const r = await runEvaluation("a", "1.0.0", [{ id: "x", recovery: true }], async (id) => outcome({ id }), NOW, { repeats: 1 });
    expect(r.metrics.failureRecovery).toBe(0);
  });
});

describe("decideCertification — SELF-LEARNING != SELF-TRUSTING", () => {
  it("CERTIFIES a passing result certified by someone else", () => {
    expect(decideCertification(perfectResult(), "human:salim").decision).toBe("CERTIFY");
  });

  it("FAILS self-certification even with case/whitespace variation", () => {
    expect(decideCertification(perfectResult("qa.api-contract"), "qa.api-contract").decision).toBe("FAIL");
    expect(decideCertification(perfectResult("qa.api-contract"), "  QA.API-CONTRACT  ").decision).toBe("FAIL");
  });

  it("FAILS when policy compliance is not perfect", () => {
    const outs = [outcome({ policyCompliant: false }), ...Array.from({ length: 19 }, (_, i) => outcome({ id: `c${i}`, expectedPositive: i % 2 === 0 }))];
    expect(decideCertification({ agentId: "a", version: "1", metrics: aggregateMetrics(outs), at: NOW }, "human").decision).toBe("FAIL");
  });

  it("FAILS when the sample size is below the minimum", () => {
    const small = aggregateMetrics(Array.from({ length: 5 }, (_, i) => outcome({ id: `c${i}`, expectedPositive: i % 2 === 0 })));
    const d = decideCertification({ agentId: "a", version: "1", metrics: small, at: NOW }, "human");
    expect(d.decision).toBe("FAIL");
    expect(d.reasons.join(" ")).toMatch(/sample size/i);
  });

  it("FAILS when any metric is non-finite (NaN cannot slip past a `<`/`>` gate)", () => {
    const m = { ...perfectMetrics(), correctness: NaN } as EvaluationMetrics;
    expect(decideCertification({ agentId: "a", version: "1", metrics: m, at: NOW }, "human").decision).toBe("FAIL");
  });

  it("DO_NOT_PROMOTE on a correctness regression vs baseline", () => {
    const baseline = perfectMetrics(); // correctness 1.0
    const outs = Array.from({ length: 20 }, (_, i) => outcome({ id: `c${i}`, expectedPositive: i % 2 === 0, correct: i < 19 })); // 0.95
    const d = decideCertification({ agentId: "a", version: "1.1.0", metrics: aggregateMetrics(outs), at: NOW }, "human", DEFAULT_THRESHOLDS, baseline);
    expect(d.decision).toBe("DO_NOT_PROMOTE");
  });

  it("DO_NOT_PROMOTE on an evidence-quality regression vs baseline (covered now, not just correctness/FP/FN)", () => {
    const baseline = perfectMetrics(); // evidenceQuality 1.0
    const outs = Array.from({ length: 20 }, (_, i) => outcome({ id: `c${i}`, expectedPositive: i % 2 === 0, evidenceOk: i < 19 })); // 0.95 (>= threshold, < baseline)
    const d = decideCertification({ agentId: "a", version: "1.1.0", metrics: aggregateMetrics(outs), at: NOW }, "human", DEFAULT_THRESHOLDS, baseline);
    expect(d.decision).toBe("DO_NOT_PROMOTE");
    expect(d.reasons.join(" ")).toMatch(/evidence/i);
  });
});

describe("certification lifecycle — certify before active", () => {
  it("only allows ACTIVE from CERTIFIED", () => {
    expect(canTransition(CertStatus.EVALUATING, CertStatus.ACTIVE)).toBe(false);
    expect(canTransition(CertStatus.CERTIFIED, CertStatus.ACTIVE)).toBe(true);
    expect(canTransition(CertStatus.DRAFT, CertStatus.ACTIVE)).toBe(false);
  });
  it("walks the legal pipeline and rejects skips", () => {
    expect(canTransition(CertStatus.DRAFT, CertStatus.SANDBOX)).toBe(true);
    expect(canTransition(CertStatus.SANDBOX, CertStatus.CERTIFIED)).toBe(false);
    expect(canTransition(CertStatus.RETIRED, CertStatus.ACTIVE)).toBe(false);
  });
});

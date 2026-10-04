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
} from "@uaap/agent-evaluation";

const NOW = "2026-10-04T12:00:00.000Z";

function outcome(o: Partial<CaseOutcome> = {}): CaseOutcome {
  return { id: "c", correct: true, policyCompliant: true, evidenceOk: true, latencyMs: 10, tokenCost: 100, ...o };
}

function perfectResult(agentId = "qa.api-contract"): EvaluationResult {
  const outs = Array.from({ length: 20 }, (_, i) => outcome({ id: `c${i}` }));
  return { agentId, version: "1.0.0", metrics: aggregateMetrics(outs), at: NOW };
}

describe("aggregateMetrics", () => {
  it("computes rates correctly", () => {
    const m = aggregateMetrics([
      outcome({ correct: true }),
      outcome({ correct: false, falseNegative: true }),
      outcome({ correct: false, falsePositive: true, policyCompliant: false }),
      outcome({ correct: true, evidenceOk: false }),
    ]);
    expect(m.total).toBe(4);
    expect(m.correctness).toBe(0.5);
    expect(m.falsePositiveRate).toBe(0.25);
    expect(m.falseNegativeRate).toBe(0.25);
    expect(m.policyCompliance).toBe(0.75);
    expect(m.evidenceQuality).toBe(0.75);
  });

  it("failureRecovery is 1 when no case tested recovery, else the recovered fraction", () => {
    expect(aggregateMetrics([outcome()]).failureRecovery).toBe(1);
    expect(aggregateMetrics([outcome({ recovered: true }), outcome({ recovered: false })]).failureRecovery).toBe(0.5);
  });
});

describe("runEvaluation", () => {
  it("drives the runner over all cases", async () => {
    const r = await runEvaluation("a", "1.0.0", [{ id: "x" }, { id: "y" }], async (id) => outcome({ id }), NOW);
    expect(r.metrics.total).toBe(2);
    expect(r.metrics.correctness).toBe(1);
  });
});

describe("decideCertification — SELF-LEARNING != SELF-TRUSTING", () => {
  it("CERTIFIES a passing result certified by someone else", () => {
    const d = decideCertification(perfectResult(), "human:salim");
    expect(d.decision).toBe("CERTIFY");
  });

  it("FAILS self-certification (agent certifying itself)", () => {
    const r = perfectResult("qa.api-contract");
    const d = decideCertification(r, "qa.api-contract");
    expect(d.decision).toBe("FAIL");
    expect(d.reasons.join(" ")).toMatch(/itself/i);
  });

  it("FAILS when policy compliance is not perfect (non-negotiable)", () => {
    const outs = [outcome({ policyCompliant: false }), ...Array.from({ length: 19 }, () => outcome())];
    const r: EvaluationResult = { agentId: "a", version: "1.0.0", metrics: aggregateMetrics(outs), at: NOW };
    expect(decideCertification(r, "human").decision).toBe("FAIL");
  });

  it("FAILS when correctness is below threshold", () => {
    const outs = Array.from({ length: 10 }, (_, i) => outcome({ correct: i < 5 })); // 0.5
    const r: EvaluationResult = { agentId: "a", version: "1.0.0", metrics: aggregateMetrics(outs), at: NOW };
    expect(decideCertification(r, "human").decision).toBe("FAIL");
  });

  it("DO_NOT_PROMOTE when a new version regresses against the certified baseline", () => {
    const baseline = perfectResult().metrics; // correctness 1.0
    const outs = Array.from({ length: 20 }, (_, i) => outcome({ correct: i < 19 })); // 0.95 < baseline, but > threshold 0.9
    const r: EvaluationResult = { agentId: "a", version: "1.1.0", metrics: aggregateMetrics(outs), at: NOW };
    const d = decideCertification(r, "human", DEFAULT_THRESHOLDS, baseline);
    expect(d.decision).toBe("DO_NOT_PROMOTE");
    expect(d.reasons.join(" ")).toMatch(/regress/i);
  });

  it("CERTIFIES a new version that meets thresholds and does not regress", () => {
    const baseline = aggregateMetrics(Array.from({ length: 20 }, (_, i) => outcome({ correct: i < 19 }))); // 0.95
    const r = perfectResult(); // 1.0 >= baseline
    expect(decideCertification(r, "human", DEFAULT_THRESHOLDS, baseline).decision).toBe("CERTIFY");
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
    expect(canTransition(CertStatus.SANDBOX, CertStatus.EVALUATING)).toBe(true);
    expect(canTransition(CertStatus.EVALUATING, CertStatus.CERTIFIED)).toBe(true);
    expect(canTransition(CertStatus.SANDBOX, CertStatus.CERTIFIED)).toBe(false);
    expect(canTransition(CertStatus.RETIRED, CertStatus.ACTIVE)).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import { AssuranceDomain, FindingStatus, Severity, type Finding } from "@uaap/core";
import { VerificationEngine, Verdict } from "@uaap/verification-engine";

const engine = new VerificationEngine();

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "F1",
    domain: AssuranceDomain.SECURITY,
    title: "stack trace exposed",
    status: FindingStatus.HYPOTHESIS,
    severity: Severity.P1,
    evidenceIds: [],
    detectedBy: "agent:sec.api-security",
    ...overrides,
  };
}

describe("VerificationEngine — separation of duties + evidence", () => {
  it("rejects verification by the detector itself (SoD)", () => {
    const r = engine.verify({ finding: finding(), verifierId: "agent:sec.api-security", verdict: Verdict.CONFIRM, evidenceIds: ["EV-1"], now: "t" });
    expect(r.ok).toBe(false);
  });

  it("rejects CONFIRM with no evidence", () => {
    const r = engine.verify({ finding: finding(), verifierId: "agent:evr.finding-verifier", verdict: Verdict.CONFIRM, evidenceIds: [], now: "t" });
    expect(r.ok).toBe(false);
  });

  it("rejects CONFIRM with only blank evidence refs", () => {
    const r = engine.verify({ finding: finding(), verifierId: "agent:evr.finding-verifier", verdict: Verdict.CONFIRM, evidenceIds: ["  "], now: "t" });
    expect(r.ok).toBe(false);
  });

  it("CONFIRMS with a different verifier and evidence, merging evidence ids", () => {
    const r = engine.verify({
      finding: finding({ evidenceIds: ["EV-0"] }),
      verifierId: "agent:evr.finding-verifier",
      verdict: Verdict.CONFIRM,
      evidenceIds: ["EV-1", "EV-1"],
      now: "t",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.finding.status).toBe(FindingStatus.CONFIRMED);
      expect(r.finding.evidenceIds).toEqual(["EV-0", "EV-1"]);
    }
  });

  it("REJECTS a finding as a false positive (no evidence required)", () => {
    const r = engine.verify({ finding: finding(), verifierId: "agent:evr.false-positive-challenger", verdict: Verdict.REJECT, now: "t" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.finding.status).toBe(FindingStatus.REJECTED_FALSE_POSITIVE);
  });

  it("refuses to verify an already-resolved finding (e.g. CLOSED)", () => {
    const r = engine.verify({ finding: finding({ status: FindingStatus.CLOSED }), verifierId: "v", verdict: Verdict.REJECT, now: "t" });
    expect(r.ok).toBe(false);
  });

  it("does not mutate the input finding", () => {
    const f = finding();
    engine.verify({ finding: f, verifierId: "v", verdict: Verdict.REJECT, now: "t" });
    expect(f.status).toBe(FindingStatus.HYPOTHESIS);
  });
});

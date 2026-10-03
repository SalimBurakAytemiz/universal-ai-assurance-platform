import { describe, it, expect } from "vitest";
import { AssuranceDomain, FindingStatus, Severity, type Finding } from "@uaap/core";
import { RemediationEngine, CaseStatus } from "@uaap/remediation-engine";

const NOW = "2026-10-03T12:00:00.000Z";

function confirmed(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "F1",
    domain: AssuranceDomain.SECURITY,
    title: "issue",
    status: FindingStatus.CONFIRMED,
    severity: Severity.P1,
    evidenceIds: ["EV-0"],
    detectedBy: "agent:detector",
    ...overrides,
  };
}

const startArgs = { remediatorId: "agent:remediator", rootCause: "null deref", fixStrategy: "guard input", patchRef: "PR-9", now: NOW };

describe("RemediationEngine — lifecycle + separation of duties", () => {
  it("full happy path with four distinct actors ends CLOSED", () => {
    const e = new RemediationEngine();
    const f0 = confirmed();
    const r1 = e.startRemediation({ finding: f0, ...startArgs });
    expect(r1.ok && r1.finding.status).toBe(FindingStatus.REMEDIATION_IN_PROGRESS);
    const f1 = r1.ok ? r1.finding : f0;

    const r2 = e.submitRetest({ finding: f1, validatorId: "agent:validator", passed: true, evidenceIds: ["EV-1"], now: NOW });
    expect(r2.ok && r2.finding.status).toBe(FindingStatus.RETEST_PENDING);
    const f2 = r2.ok ? r2.finding : f1;

    const r3 = e.close({ finding: f2, closerId: "agent:closer", now: NOW });
    expect(r3.ok && r3.finding.status).toBe(FindingStatus.CLOSED);
    expect(e.getCase("F1")!.status).toBe(CaseStatus.CLOSED);
  });

  it("rejects remediation of a non-CONFIRMED finding", () => {
    const e = new RemediationEngine();
    expect(e.startRemediation({ finding: confirmed({ status: FindingStatus.HYPOTHESIS }), ...startArgs }).ok).toBe(false);
  });

  it("rejects the detector remediating its own finding", () => {
    const e = new RemediationEngine();
    expect(e.startRemediation({ finding: confirmed(), ...startArgs, remediatorId: "agent:detector" }).ok).toBe(false);
  });

  it("requires root cause and fix strategy", () => {
    const e = new RemediationEngine();
    expect(e.startRemediation({ finding: confirmed(), ...startArgs, rootCause: "  " }).ok).toBe(false);
  });

  it("rejects a retest validator who is the detector or the remediator (SoD)", () => {
    const e = new RemediationEngine();
    const f1 = (e.startRemediation({ finding: confirmed(), ...startArgs }) as { finding: Finding }).finding;
    expect(e.submitRetest({ finding: f1, validatorId: "agent:detector", passed: true, evidenceIds: ["EV-1"], now: NOW }).ok).toBe(false);
    expect(e.submitRetest({ finding: f1, validatorId: "agent:remediator", passed: true, evidenceIds: ["EV-1"], now: NOW }).ok).toBe(false);
  });

  it("rejects a PASS retest with no evidence", () => {
    const e = new RemediationEngine();
    const f1 = (e.startRemediation({ finding: confirmed(), ...startArgs }) as { finding: Finding }).finding;
    expect(e.submitRetest({ finding: f1, validatorId: "agent:validator", passed: true, evidenceIds: [], now: NOW }).ok).toBe(false);
  });

  it("a FAILED retest REOPENS the finding", () => {
    const e = new RemediationEngine();
    const f1 = (e.startRemediation({ finding: confirmed(), ...startArgs }) as { finding: Finding }).finding;
    const r = e.submitRetest({ finding: f1, validatorId: "agent:validator", passed: false, now: NOW });
    expect(r.ok && r.finding.status).toBe(FindingStatus.REOPENED);
  });

  it("cannot close without a passing retest (wrong state)", () => {
    const e = new RemediationEngine();
    const f1 = (e.startRemediation({ finding: confirmed(), ...startArgs }) as { finding: Finding }).finding;
    expect(e.close({ finding: f1, closerId: "agent:closer", now: NOW }).ok).toBe(false);
  });

  it("rejects a closer who is the detector, remediator, or validator (independent closure)", () => {
    const e = new RemediationEngine();
    const f1 = (e.startRemediation({ finding: confirmed(), ...startArgs }) as { finding: Finding }).finding;
    const f2 = (e.submitRetest({ finding: f1, validatorId: "agent:validator", passed: true, evidenceIds: ["EV-1"], now: NOW }) as { finding: Finding }).finding;
    for (const closer of ["agent:detector", "agent:remediator", "agent:validator"]) {
      expect(e.close({ finding: f2, closerId: closer, now: NOW }).ok, closer).toBe(false);
    }
  });

  it("blocks the SoD bypass via whitespace-padded ids", () => {
    const e = new RemediationEngine();
    expect(e.startRemediation({ finding: confirmed(), ...startArgs, remediatorId: " agent:detector " }).ok).toBe(false);
  });

  it("does not mutate the input finding", () => {
    const e = new RemediationEngine();
    const f = confirmed();
    e.startRemediation({ finding: f, ...startArgs });
    expect(f.status).toBe(FindingStatus.CONFIRMED);
  });
});

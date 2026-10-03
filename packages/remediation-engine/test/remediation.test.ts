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

  it("refuses to restart a case that is RETEST_PENDING or CLOSED (replay/stale-finding SoD custody)", () => {
    const e = new RemediationEngine();
    const f0 = confirmed();
    const f1 = (e.startRemediation({ finding: f0, ...startArgs }) as { finding: Finding }).finding;
    const f2 = (e.submitRetest({ finding: f1, validatorId: "agent:validator", passed: true, evidenceIds: ["EV-1"], now: NOW }) as { finding: Finding }).finding;
    // replay the ORIGINAL confirmed finding (status still CONFIRMED) — must NOT reset the validated case
    expect(e.startRemediation({ finding: f0, ...startArgs }).ok).toBe(false);
    expect(e.getCase("F1")!.status).toBe(CaseStatus.RETEST_PENDING);
    // after close, also cannot restart
    e.close({ finding: f2, closerId: "agent:closer", now: NOW });
    expect(e.startRemediation({ finding: f0, ...startArgs }).ok).toBe(false);
    expect(e.getCase("F1")!.status).toBe(CaseStatus.CLOSED);
  });

  it("binds the independent-retest evidence into the CLOSED finding, trimmed and deduped", () => {
    const e = new RemediationEngine();
    const f1 = (e.startRemediation({ finding: confirmed({ evidenceIds: ["EV-0"] }), ...startArgs }) as { finding: Finding }).finding;
    const f2 = (e.submitRetest({ finding: f1, validatorId: "agent:validator", passed: true, evidenceIds: [" EV-1 ", "EV-1"], now: NOW }) as { finding: Finding }).finding;
    expect(f2.evidenceIds).toEqual(["EV-0", "EV-1"]);
    // close with a finding that LACKS the retest evidence — the engine must re-bind it from the case
    const r3 = e.close({ finding: { ...f2, evidenceIds: ["EV-0"] }, closerId: "agent:closer", now: NOW });
    expect(r3.ok).toBe(true);
    if (r3.ok) expect(r3.finding.evidenceIds).toEqual(["EV-0", "EV-1"]);
  });

  it("prevents cross-cycle role swapping (a cycle-1 validator cannot remediate after REOPEN)", () => {
    const e = new RemediationEngine();
    const f1 = (e.startRemediation({ finding: confirmed(), ...startArgs }) as { finding: Finding }).finding;
    const reopened = (e.submitRetest({ finding: f1, validatorId: "agent:validator", passed: false, now: NOW }) as { finding: Finding }).finding;
    expect(reopened.status).toBe(FindingStatus.REOPENED);
    // the prior validator now tries to be the remediator -> SoD reject
    const bad = e.startRemediation({ finding: reopened, remediatorId: "agent:validator", rootCause: "x", fixStrategy: "y", now: NOW });
    expect(bad.ok).toBe(false);
    // a fresh remediator can restart
    expect(e.startRemediation({ finding: reopened, remediatorId: "agent:remediator2", rootCause: "x", fixStrategy: "y", now: NOW }).ok).toBe(true);
  });

  it("blocks SoD bypass via case-variant ids", () => {
    const e = new RemediationEngine();
    expect(e.startRemediation({ finding: confirmed({ detectedBy: "agent:Det" }), ...startArgs, remediatorId: "AGENT:det" }).ok).toBe(false);
  });

  it("getCase returns an independent deep clone (mutating it does not affect engine state)", () => {
    const e = new RemediationEngine();
    e.startRemediation({ finding: confirmed(), ...startArgs });
    const c = e.getCase("F1")!;
    (c.history.remediators as string[]).push("intruder");
    expect(e.getCase("F1")!.history.remediators).toEqual(["agent:remediator"]);
  });
});

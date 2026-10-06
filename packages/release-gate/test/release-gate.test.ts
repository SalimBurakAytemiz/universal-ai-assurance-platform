import { describe, it, expect } from "vitest";
import { AssuranceDomain, FindingStatus, Severity, type Finding } from "@uaap/core";
import { evaluateRelease, GateStatus, ReleaseDecision, type GateDomainResult, type RiskAcceptance } from "@uaap/release-gate";

const NOW = "2026-10-03T12:00:00.000Z";
const FUTURE = "2026-12-01T00:00:00.000Z";
const PAST = "2026-09-01T00:00:00.000Z";

const pass = (domain: AssuranceDomain): GateDomainResult => ({ domain, status: GateStatus.PASS });

function finding(sev: Severity, overrides: Partial<Finding> = {}): Finding {
  return {
    id: "F_" + sev,
    domain: AssuranceDomain.SECURITY,
    title: sev + " issue",
    status: FindingStatus.CONFIRMED,
    severity: sev,
    evidenceIds: ["EV-1"],
    detectedBy: "d",
    ...overrides,
  };
}

const okDomains = [pass(AssuranceDomain.QUALITY), pass(AssuranceDomain.SECURITY)];

describe("evaluateRelease", () => {
  it("ALLOWS when all pass, evidence valid, no blocking findings", () => {
    const r = evaluateRelease({ domainResults: okDomains, findings: [], evidenceBundleValid: true, now: NOW });
    expect(r.decision).toBe(ReleaseDecision.RELEASE_ALLOWED);
  });

  it("BLOCKS when the evidence bundle is invalid (even if everything else passes)", () => {
    const r = evaluateRelease({ domainResults: okDomains, findings: [], evidenceBundleValid: false, now: NOW });
    expect(r.decision).toBe(ReleaseDecision.RELEASE_BLOCKED);
  });

  it("BLOCKS on a FAILED domain", () => {
    const r = evaluateRelease({
      domainResults: [pass(AssuranceDomain.QUALITY), { domain: AssuranceDomain.SECURITY, status: GateStatus.FAIL }],
      findings: [],
      evidenceBundleValid: true,
      now: NOW,
    });
    expect(r.decision).toBe(ReleaseDecision.RELEASE_BLOCKED);
  });

  it("requires HUMAN APPROVAL on a NOT_RUN domain (when nothing blocks)", () => {
    const r = evaluateRelease({
      domainResults: [pass(AssuranceDomain.QUALITY), { domain: AssuranceDomain.SECURITY, status: GateStatus.NOT_RUN }],
      findings: [],
      evidenceBundleValid: true,
      now: NOW,
    });
    expect(r.decision).toBe(ReleaseDecision.HUMAN_APPROVAL_REQUIRED);
  });

  it("BLOCKS on an open P1 without a valid acceptance", () => {
    const r = evaluateRelease({ domainResults: okDomains, findings: [finding(Severity.P1)], evidenceBundleValid: true, now: NOW });
    expect(r.decision).toBe(ReleaseDecision.RELEASE_BLOCKED);
    expect(r.blockingFindingIds).toContain("F_P1");
  });

  it("ALLOWS_WITH_ACCEPTED_RISK for an open P1 with a valid acceptance", () => {
    const acc: RiskAcceptance = { findingId: "F_P1", reason: "mitigated", owner: "o", approver: "a", expiry: FUTURE };
    const r = evaluateRelease({ domainResults: okDomains, findings: [finding(Severity.P1)], acceptances: [acc], evidenceBundleValid: true, now: NOW });
    expect(r.decision).toBe(ReleaseDecision.RELEASE_ALLOWED_WITH_ACCEPTED_RISK);
    expect(r.acceptedFindingIds).toContain("F_P1");
  });

  it("BLOCKS on an open P1 whose acceptance is EXPIRED", () => {
    const acc: RiskAcceptance = { findingId: "F_P1", reason: "mitigated", owner: "o", approver: "a", expiry: PAST };
    const r = evaluateRelease({ domainResults: okDomains, findings: [finding(Severity.P1)], acceptances: [acc], evidenceBundleValid: true, now: NOW });
    expect(r.decision).toBe(ReleaseDecision.RELEASE_BLOCKED);
  });

  it("NEVER allows a P0 to be risk-accepted (P0 always blocks)", () => {
    const acc: RiskAcceptance = { findingId: "F_P0", reason: "x", owner: "o", approver: "a", expiry: FUTURE };
    const r = evaluateRelease({ domainResults: okDomains, findings: [finding(Severity.P0)], acceptances: [acc], evidenceBundleValid: true, now: NOW });
    expect(r.decision).toBe(ReleaseDecision.RELEASE_BLOCKED);
  });

  it("ignores CLOSED / REJECTED findings and P2/P3 severities", () => {
    const r = evaluateRelease({
      domainResults: okDomains,
      findings: [
        finding(Severity.P1, { id: "closed", status: FindingStatus.CLOSED }),
        finding(Severity.P0, { id: "rejected", status: FindingStatus.REJECTED_FALSE_POSITIVE }),
        finding(Severity.P2, { id: "p2" }),
      ],
      evidenceBundleValid: true,
      now: NOW,
    });
    expect(r.decision).toBe(ReleaseDecision.RELEASE_ALLOWED);
  });

  it("BLOCKED takes precedence over NOT_RUN approval", () => {
    const r = evaluateRelease({
      domainResults: [{ domain: AssuranceDomain.QUALITY, status: GateStatus.NOT_RUN }, { domain: AssuranceDomain.SECURITY, status: GateStatus.FAIL }],
      findings: [],
      evidenceBundleValid: true,
      now: NOW,
    });
    expect(r.decision).toBe(ReleaseDecision.RELEASE_BLOCKED);
  });

  it("BLOCKS an unrecognized domain status (fail-closed, not fail-open to PASS)", () => {
    const r = evaluateRelease({
      domainResults: [pass(AssuranceDomain.QUALITY), { domain: AssuranceDomain.SECURITY, status: "ERROR" as unknown as GateStatus }],
      findings: [],
      evidenceBundleValid: true,
      now: NOW,
    });
    expect(r.decision).toBe(ReleaseDecision.RELEASE_BLOCKED);
  });

  it("BLOCKS an open finding with an unrecognized severity", () => {
    const r = evaluateRelease({
      domainResults: okDomains,
      findings: [finding("SEV9" as unknown as Severity, { id: "weird" })],
      evidenceBundleValid: true,
      now: NOW,
    });
    expect(r.decision).toBe(ReleaseDecision.RELEASE_BLOCKED);
    expect(r.blockingFindingIds).toContain("weird");
  });

  it("rejects a non-ISO acceptance expiry (no lenient date parsing)", () => {
    const acc: RiskAcceptance = { findingId: "F_P1", reason: "x", owner: "o", approver: "a", expiry: "soon" };
    const r = evaluateRelease({ domainResults: okDomains, findings: [finding(Severity.P1)], acceptances: [acc], evidenceBundleValid: true, now: NOW });
    expect(r.decision).toBe(ReleaseDecision.RELEASE_BLOCKED);
  });

  it("rejects a self-approved acceptance (owner == approver)", () => {
    const acc: RiskAcceptance = { findingId: "F_P1", reason: "x", owner: "same", approver: "same", expiry: FUTURE };
    const r = evaluateRelease({ domainResults: okDomains, findings: [finding(Severity.P1)], acceptances: [acc], evidenceBundleValid: true, now: NOW });
    expect(r.decision).toBe(ReleaseDecision.RELEASE_BLOCKED);
  });

  it("REGRESSION (P1): rejects a CASE-VARIANT self-approval (owner 'Alice' / approver 'alice')", () => {
    const acc: RiskAcceptance = { findingId: "F_P1", reason: "x", owner: "Alice", approver: "alice", expiry: FUTURE };
    const r = evaluateRelease({ domainResults: okDomains, findings: [finding(Severity.P1)], acceptances: [acc], evidenceBundleValid: true, now: NOW });
    expect(r.decision).toBe(ReleaseDecision.RELEASE_BLOCKED);
  });

  it("REGRESSION (P1): rejects a UNICODE-VARIANT self-approval (fullwidth 'ＡＬＩＣＥ' / 'alice')", () => {
    // NFKC maps the fullwidth form to ASCII; both canonicalize to "alice" → same identity → blocked.
    const acc: RiskAcceptance = { findingId: "F_P1", reason: "x", owner: "ＡＬＩＣＥ", approver: "alice", expiry: FUTURE };
    const r = evaluateRelease({ domainResults: okDomains, findings: [finding(Severity.P1)], acceptances: [acc], evidenceBundleValid: true, now: NOW });
    expect(r.decision).toBe(ReleaseDecision.RELEASE_BLOCKED);
  });

  it("requires approval when no domains were reported at all", () => {
    const r = evaluateRelease({ domainResults: [], findings: [], evidenceBundleValid: true, now: NOW });
    expect(r.decision).toBe(ReleaseDecision.HUMAN_APPROVAL_REQUIRED);
  });

  it("requires approval when a required domain is missing from the results", () => {
    const r = evaluateRelease({
      domainResults: [pass(AssuranceDomain.QUALITY)],
      requiredDomains: [AssuranceDomain.QUALITY, AssuranceDomain.SECURITY],
      findings: [],
      evidenceBundleValid: true,
      now: NOW,
    });
    expect(r.decision).toBe(ReleaseDecision.HUMAN_APPROVAL_REQUIRED);
  });
});

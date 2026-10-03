import { describe, it, expect } from "vitest";
import {
  AgentEventType,
  VerificationStatus,
  validateAgentEvent,
  isConfirmedFact,
  type Claim,
} from "@uaap/agent-events";

const AT = "2026-10-03T12:00:00.000Z";

describe("validateAgentEvent", () => {
  it("accepts a well-formed OBSERVATION", () => {
    const r = validateAgentEvent({ type: AgentEventType.OBSERVATION, sourceAgent: "proj.repo", at: AT });
    expect(r.ok).toBe(true);
  });

  it("rejects an unknown event type", () => {
    const r = validateAgentEvent({ type: "GOSSIP", sourceAgent: "x", at: AT });
    expect(r.ok).toBe(false);
  });

  it("rejects a FINDING_CANDIDATE without evidence refs / verification flag", () => {
    const r = validateAgentEvent({
      type: AgentEventType.FINDING_CANDIDATE,
      sourceAgent: "sec.api-security",
      at: AT,
      confidence: 0.9,
    });
    expect(r.ok).toBe(false);
  });

  it("accepts a FINDING_CANDIDATE with evidence refs and a verification flag", () => {
    const r = validateAgentEvent({
      type: AgentEventType.FINDING_CANDIDATE,
      sourceAgent: "sec.api-security",
      at: AT,
      evidenceRefs: ["EV-1"],
      requiresVerification: true,
    });
    expect(r.ok).toBe(true);
  });

  it("rejects a FINDING_VERIFIED that is not CONFIRMED with evidence (no fake verification)", () => {
    const bad = validateAgentEvent({
      type: AgentEventType.FINDING_VERIFIED,
      sourceAgent: "evr.finding-verifier",
      at: AT,
      evidenceRefs: ["EV-1"],
      verificationStatus: VerificationStatus.UNVERIFIED,
    });
    expect(bad.ok).toBe(false);

    const good = validateAgentEvent({
      type: AgentEventType.FINDING_VERIFIED,
      sourceAgent: "evr.finding-verifier",
      at: AT,
      evidenceRefs: ["EV-1"],
      verificationStatus: VerificationStatus.CONFIRMED,
    });
    expect(good.ok).toBe(true);
  });

  it("rejects out-of-range confidence", () => {
    const r = validateAgentEvent({ type: AgentEventType.HYPOTHESIS, sourceAgent: "x", at: AT, confidence: 1.5 });
    expect(r.ok).toBe(false);
  });

  it("rejects a CONFIRMED FINDING_VERIFIED with EMPTY evidence (evidence-required invariant)", () => {
    const r = validateAgentEvent({
      type: AgentEventType.FINDING_VERIFIED,
      sourceAgent: "evr.finding-verifier",
      at: AT,
      evidenceRefs: [],
      verificationStatus: VerificationStatus.CONFIRMED,
    });
    expect(r.ok).toBe(false);
  });

  it("rejects a FINDING_CANDIDATE with EMPTY evidence", () => {
    const r = validateAgentEvent({
      type: AgentEventType.FINDING_CANDIDATE,
      sourceAgent: "sec.api-security",
      at: AT,
      evidenceRefs: [],
      requiresVerification: true,
    });
    expect(r.ok).toBe(false);
  });
});

describe("Claim epistemics", () => {
  it("treats a claim as fact only when CONFIRMED with evidence", () => {
    const base: Claim = {
      claim: "endpoint leaks stack traces",
      source: "sec.api-security",
      evidenceRefs: [],
      confidence: 0.95,
      provenance: "run RUN-1",
      verificationStatus: VerificationStatus.UNVERIFIED,
    };
    expect(isConfirmedFact(base)).toBe(false); // high confidence is not evidence
    expect(isConfirmedFact({ ...base, verificationStatus: VerificationStatus.CONFIRMED })).toBe(false); // no evidence
    expect(
      isConfirmedFact({ ...base, verificationStatus: VerificationStatus.CONFIRMED, evidenceRefs: ["EV-1"] }),
    ).toBe(true);
  });
});

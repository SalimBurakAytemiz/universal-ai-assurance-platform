import { describe, it, expect } from "vitest";
import {
  ActionClass,
  AssuranceDomain,
  DataClassification,
  Decision,
  DecisionReason,
  Environment,
  Mode,
  type ActionRequest,
  type AuthorizationRecord,
} from "@uaap/core";
import { AuthorizationKernel, type PolicyEvaluator } from "@uaap/authorization-kernel";

// Authoritative action→canonical-class catalog (the trusted source an action's risk is derived from,
// NOT the caller-supplied request.actionClass).
const KNOWN_ACTIONS = new Map<string, ActionClass>([
  ["public.dns.lookup", ActionClass.R0_PASSIVE],
  ["http.readonly.get", ActionClass.R1_LOW_IMPACT],
  ["db.readonly.query", ActionClass.R1_LOW_IMPACT],
  ["web.click", ActionClass.R1_LOW_IMPACT],
  ["security.active.probe", ActionClass.R2_ELEVATED],
]);

const NOW = "2026-10-03T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);

function auth(overrides: Partial<AuthorizationRecord> = {}): AuthorizationRecord {
  return {
    id: "AUTH_1",
    mode: Mode.CLIENT_AUTHORIZED,
    targetId: "T1",
    allowedIdentifiers: ["app.example.com"],
    maxActionClass: ActionClass.R1_LOW_IMPACT,
    allowedEnvironments: [Environment.STAGING],
    allowedDomains: [AssuranceDomain.SECURITY, AssuranceDomain.QUALITY],
    notBefore: "2026-10-01T00:00:00.000Z",
    notAfter: "2026-11-01T00:00:00.000Z",
    grantedBy: "owner:salim",
    reference: "signed-authorization://AUTH_1",
    ...overrides,
  };
}

function req(overrides: Partial<ActionRequest> = {}): ActionRequest {
  return {
    requestId: "REQ_1",
    runId: "RUN_1",
    requestedBy: "agent:security.api",
    mode: Mode.CLIENT_AUTHORIZED,
    target: {
      id: "T1",
      name: "Example staging",
      identifiers: ["app.example.com"],
      environment: Environment.STAGING,
    },
    domain: AssuranceDomain.SECURITY,
    actionClass: ActionClass.R1_LOW_IMPACT,
    action: "http.readonly.get",
    environment: Environment.STAGING,
    dataPolicy: { maxClassification: DataClassification.INTERNAL, minimalProofOfAccessOnly: true },
    now: NOW,
    ...overrides,
  };
}

const kernel = (
  authorizations: AuthorizationRecord[] = [],
  policy?: PolicyEvaluator,
  clock: () => number = () => NOW_MS,
): AuthorizationKernel => new AuthorizationKernel({ authorizations, knownActions: KNOWN_ACTIONS, policy, clock });

describe("AuthorizationKernel — fail-closed behavior", () => {
  it("DENIES an unknown action (default deny)", () => {
    const r = kernel([auth()]).decide(req({ action: "totally.unknown.action" }));
    expect(r.decision).toBe(Decision.DENY);
    expect(r.reason).toBe(DecisionReason.UNKNOWN_ACTION);
  });

  it("DENIES a prohibited action class outright", () => {
    const r = kernel([auth()]).decide(req({ actionClass: ActionClass.R3_PROHIBITED }));
    expect(r.decision).toBe(Decision.DENY);
    expect(r.reason).toBe(DecisionReason.PROHIBITED_ACTION_CLASS);
  });

  it("DENIES an ambiguous target with no identifiers", () => {
    const r = kernel([auth()]).decide(
      req({ target: { id: "T1", name: "x", identifiers: [], environment: Environment.STAGING } }),
    );
    expect(r.decision).toBe(Decision.DENY);
    expect(r.reason).toBe(DecisionReason.AMBIGUOUS_TARGET);
  });

  it("DENIES active validation in PROSPECT_PASSIVE mode", () => {
    const r = kernel().decide(
      req({ mode: Mode.PROSPECT_PASSIVE, actionClass: ActionClass.R1_LOW_IMPACT }),
    );
    expect(r.decision).toBe(Decision.DENY);
    expect(r.reason).toBe(DecisionReason.AUTHORIZATION_MISSING);
  });

  it("DENIES an active action when no authorization record exists", () => {
    const r = kernel([]).decide(req());
    expect(r.decision).toBe(Decision.DENY);
    expect(r.reason).toBe(DecisionReason.AUTHORIZATION_MISSING);
  });

  it("DENIES when the authorization window has not opened / has expired (TRUSTED clock)", () => {
    const expiredClock = () => Date.parse("2026-12-01T00:00:00.000Z");
    const r = kernel([auth()], undefined, expiredClock).decide(req());
    expect(r.decision).toBe(Decision.DENY);
    expect(r.reason).toBe(DecisionReason.AUTHORIZATION_EXPIRED);
  });

  it("DENIES a target identifier outside the authorized scope", () => {
    const r = kernel([auth()]).decide(
      req({
        target: {
          id: "T1",
          name: "x",
          identifiers: ["app.example.com", "secret.internal.example.com"],
          environment: Environment.STAGING,
        },
      }),
    );
    expect(r.decision).toBe(Decision.DENY);
    expect(r.reason).toBe(DecisionReason.OUT_OF_SCOPE);
  });

  it("DENIES a domain outside the authorized scope", () => {
    const r = kernel([auth({ allowedDomains: [AssuranceDomain.QUALITY] })]).decide(
      req({ domain: AssuranceDomain.SECURITY }),
    );
    expect(r.decision).toBe(Decision.DENY);
    expect(r.reason).toBe(DecisionReason.OUT_OF_SCOPE);
  });

  it("DENIES a forbidden environment (e.g. PRODUCTION not authorized)", () => {
    const r = kernel([auth()]).decide(
      req({
        environment: Environment.PRODUCTION,
        target: {
          id: "T1",
          name: "x",
          identifiers: ["app.example.com"],
          environment: Environment.PRODUCTION,
        },
      }),
    );
    expect(r.decision).toBe(Decision.DENY);
    expect(r.reason).toBe(DecisionReason.ENVIRONMENT_FORBIDDEN);
  });

  it("DENIES an action class above the authorized ceiling", () => {
    const r = kernel([auth({ maxActionClass: ActionClass.R1_LOW_IMPACT })]).decide(
      req({ action: "security.active.probe", actionClass: ActionClass.R2_ELEVATED, approvalToken: "tok" }),
    );
    expect(r.decision).toBe(Decision.DENY);
    expect(r.reason).toBe(DecisionReason.OUT_OF_SCOPE);
  });

  it("REQUIRES human approval for an elevated (R2) action without an approval token", () => {
    const r = kernel([auth({ maxActionClass: ActionClass.R2_ELEVATED })]).decide(
      req({ action: "security.active.probe", actionClass: ActionClass.R2_ELEVATED }),
    );
    expect(r.decision).toBe(Decision.HUMAN_APPROVAL_REQUIRED);
    expect(r.reason).toBe(DecisionReason.ELEVATED_REQUIRES_APPROVAL);
  });

  it("DENIES full access to RESTRICTED data on a non-owned target", () => {
    const r = kernel([auth()]).decide(
      req({ dataPolicy: { maxClassification: DataClassification.RESTRICTED, minimalProofOfAccessOnly: false } }),
    );
    expect(r.decision).toBe(Decision.DENY);
    expect(r.reason).toBe(DecisionReason.DATA_POLICY_VIOLATION);
  });

  it("DENIES when the policy-as-code gate denies, even if kernel gates pass", () => {
    const denyAll: PolicyEvaluator = {
      evaluate: () => ({ allow: false, ruleId: "deny-all", explanation: "policy says no" }),
    };
    const r = kernel([auth()], denyAll).decide(req());
    expect(r.decision).toBe(Decision.DENY);
    expect(r.reason).toBe(DecisionReason.POLICY_DENY);
  });
});

describe("AuthorizationKernel — the narrow ALLOW paths", () => {
  it("ALLOWS a known passive (R0) action without an authorization record", () => {
    const r = kernel().decide(
      req({ mode: Mode.PROSPECT_PASSIVE, action: "public.dns.lookup", actionClass: ActionClass.R0_PASSIVE }),
    );
    expect(r.decision).toBe(Decision.ALLOW);
    expect(r.reason).toBe(DecisionReason.OK);
  });

  it("ALLOWS a fully authorized, in-scope R1 action", () => {
    const r = kernel([auth()]).decide(req());
    expect(r.decision).toBe(Decision.ALLOW);
    expect(r.evaluated).toContain("ALLOW");
  });

  it("ALLOWS an R2 action with a valid ceiling and an approval token", () => {
    const r = kernel([auth({ maxActionClass: ActionClass.R2_ELEVATED })]).decide(
      req({ action: "security.active.probe", actionClass: ActionClass.R2_ELEVATED, approvalToken: "approval-xyz" }),
    );
    expect(r.decision).toBe(Decision.ALLOW);
  });

  it("ALLOWS through the policy gate when the policy allows", () => {
    const allowAll: PolicyEvaluator = {
      evaluate: () => ({ allow: true, ruleId: "allow-in-scope", explanation: "ok" }),
    };
    const r = kernel([auth()], allowAll).decide(req());
    expect(r.decision).toBe(Decision.ALLOW);
    expect(r.evaluated).toContain("policy:allow-in-scope");
  });
});

describe("AuthorizationKernel — adversarial-review regression fixes", () => {
  it("REGRESSION (P0): a target-touching action mislabeled R0_PASSIVE cannot skip authorization", () => {
    // http.readonly.get is canonically R1 (touches a target). Self-asserting R0_PASSIVE must NOT
    // downgrade it onto the no-authorization passive path. With no authorization record → DENY.
    const r = kernel([]).decide(req({ action: "http.readonly.get", actionClass: ActionClass.R0_PASSIVE }));
    expect(r.decision).toBe(Decision.DENY);
    expect(r.reason).toBe(DecisionReason.AUTHORIZATION_MISSING);
    // ...and even inside PROSPECT_PASSIVE mode, the mislabel is still treated as the active R1 it is.
    const r2 = kernel().decide(
      req({ mode: Mode.PROSPECT_PASSIVE, action: "http.readonly.get", actionClass: ActionClass.R0_PASSIVE }),
    );
    expect(r2.decision).toBe(Decision.DENY);
  });

  it("REGRESSION (P0): the self-asserted class cannot ESCAPE the authorized ceiling by declaring lower", () => {
    // security.active.probe is canonically R2. Declaring R1 must not duck the R2 approval requirement.
    const r = kernel([auth({ maxActionClass: ActionClass.R2_ELEVATED })]).decide(
      req({ action: "security.active.probe", actionClass: ActionClass.R1_LOW_IMPACT }),
    );
    expect(r.decision).toBe(Decision.HUMAN_APPROVAL_REQUIRED);
    expect(r.reason).toBe(DecisionReason.ELEVATED_REQUIRES_APPROVAL);
  });

  it("REGRESSION (P1): a request environment contradicting the target's environment is denied", () => {
    const r = kernel([auth()]).decide(
      req({
        environment: Environment.STAGING,
        target: { id: "T1", name: "x", identifiers: ["app.example.com"], environment: Environment.PRODUCTION },
      }),
    );
    expect(r.decision).toBe(Decision.DENY);
    expect(r.reason).toBe(DecisionReason.AMBIGUOUS_SCOPE);
  });

  it("REGRESSION (P1): a backdated request.now cannot revive an expired authorization", () => {
    // Trusted clock is PAST the window; the agent backdates request.now into the window — still DENY.
    const pastWindow = () => Date.parse("2026-12-01T00:00:00.000Z");
    const r = kernel([auth()], undefined, pastWindow).decide(req({ now: "2026-10-15T00:00:00.000Z" }));
    expect(r.decision).toBe(Decision.DENY);
    expect(r.reason).toBe(DecisionReason.AUTHORIZATION_EXPIRED);
  });
});

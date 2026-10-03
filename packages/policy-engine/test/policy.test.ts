import { describe, it, expect } from "vitest";
import {
  ActionClass,
  AssuranceDomain,
  DataClassification,
  Environment,
  Mode,
  type ActionRequest,
} from "@uaap/core";
import { readFileSync } from "node:fs";
import { PolicyEngine, loadBaselinePolicy, type PolicyDocument } from "@uaap/policy-engine";

const schema = JSON.parse(
  readFileSync(new URL("../../../schemas/policy.schema.json", import.meta.url), "utf8"),
) as object;

function req(overrides: Partial<ActionRequest> = {}): ActionRequest {
  return {
    requestId: "REQ",
    runId: "RUN",
    requestedBy: "agent:test",
    mode: Mode.CLIENT_AUTHORIZED,
    target: { id: "T1", name: "t", identifiers: ["app.example.com"], environment: Environment.STAGING },
    domain: AssuranceDomain.QUALITY,
    actionClass: ActionClass.R1_LOW_IMPACT,
    action: "http.readonly.get",
    environment: Environment.STAGING,
    dataPolicy: { maxClassification: DataClassification.INTERNAL, minimalProofOfAccessOnly: true },
    now: "2026-10-03T12:00:00.000Z",
    ...overrides,
  };
}

describe("PolicyEngine — baseline policy", () => {
  const engine = loadBaselinePolicy();

  it("loads and validates the shipped baseline policy", () => {
    expect(engine.isValid).toBe(true);
    expect(engine.error).toBeNull();
  });

  it("allows low-impact assurance in non-production", () => {
    expect(engine.evaluate(req()).allow).toBe(true);
  });

  it("denies active work against production", () => {
    const v = engine.evaluate(req({ environment: Environment.PRODUCTION }));
    expect(v.allow).toBe(false);
    expect(v.ruleId).toBe("deny-production-by-default");
  });

  it("denies the prohibited action class", () => {
    const v = engine.evaluate(req({ actionClass: ActionClass.R3_PROHIBITED }));
    expect(v.allow).toBe(false);
    expect(v.ruleId).toBe("deny-prohibited-class");
  });

  it("allows passive actions in any mode", () => {
    const v = engine.evaluate(req({ mode: Mode.PROSPECT_PASSIVE, actionClass: ActionClass.R0_PASSIVE }));
    expect(v.allow).toBe(true);
    expect(v.ruleId).toBe("allow-passive-anywhere");
  });
});

describe("PolicyEngine — fail-closed on invalid documents", () => {
  it("treats a schema-invalid document as deny-all", () => {
    // default must be DENY per schema; here it is ALLOW ⇒ invalid ⇒ deny-all.
    const bad = { version: "1.0.0", name: "bad", default: "ALLOW", rules: [] } as unknown as PolicyDocument;
    const engine = new PolicyEngine(bad, schema as object);
    expect(engine.isValid).toBe(false);
    const v = engine.evaluate(req());
    expect(v.allow).toBe(false);
    expect(v.ruleId).toBe("policy-invalid");
  });

  it("denies when no rule matches (default-deny)", () => {
    const doc: PolicyDocument = {
      version: "1.0.0",
      name: "narrow",
      default: "DENY",
      rules: [
        { id: "only-dev", effect: "ALLOW", description: "dev only", match: { environments: ["DEV"] } },
      ],
    };
    const engine = new PolicyEngine(doc, schema as object);
    expect(engine.isValid).toBe(true);
    const v = engine.evaluate(req({ environment: Environment.STAGING }));
    expect(v.allow).toBe(false);
    expect(v.ruleId).toBe("default-deny");
  });
});

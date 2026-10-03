import { describe, it, expect } from "vitest";
import {
  ActionClass,
  AssuranceDomain,
  DataClassification,
  Environment,
  Mode,
  type ActionRequest,
  type AuthorizationRecord,
} from "@uaap/core";
import { AuthorizationKernel } from "@uaap/authorization-kernel";
import { AuditLedger, AuditEventType } from "@uaap/audit";
import { ToolBroker, type TargetAdapter } from "@uaap/tool-broker";

const NOW = "2026-10-03T12:00:00.000Z";
const SOON = "2026-10-03T13:00:00.000Z";

class ThrowingAdapter implements TargetAdapter {
  readonly capability = "danger";
  constructor(private readonly thrown: unknown) {}
  supports(action: string): boolean {
    return action === "danger.run";
  }
  execute(): never {
    throw this.thrown;
  }
}

function auth(): AuthorizationRecord {
  return {
    id: "A",
    mode: Mode.CLIENT_AUTHORIZED,
    targetId: "T1",
    allowedIdentifiers: ["app.example.com"],
    maxActionClass: ActionClass.R1_LOW_IMPACT,
    allowedEnvironments: [Environment.STAGING],
    allowedDomains: [AssuranceDomain.SECURITY],
    notBefore: "2026-10-01T00:00:00.000Z",
    notAfter: "2026-11-01T00:00:00.000Z",
    grantedBy: "owner",
    reference: "signed://A",
  };
}

function req(): ActionRequest {
  return {
    requestId: "R",
    runId: "RUN",
    requestedBy: "agent:test",
    mode: Mode.CLIENT_AUTHORIZED,
    target: { id: "T1", name: "t", identifiers: ["app.example.com"], environment: Environment.STAGING },
    domain: AssuranceDomain.SECURITY,
    actionClass: ActionClass.R1_LOW_IMPACT,
    action: "danger.run",
    environment: Environment.STAGING,
    dataPolicy: { maxClassification: DataClassification.INTERNAL, minimalProofOfAccessOnly: true },
    now: NOW,
  };
}

async function runWith(thrown: unknown) {
  const audit = new AuditLedger();
  const kernel = new AuthorizationKernel({
    authorizations: [auth()],
    knownActions: new Set(["danger.run"]),
  });
  const broker = new ToolBroker({ kernel, audit, adapters: new Map([["danger", new ThrowingAdapter(thrown)]]) });
  const lease = broker.issueLease({
    runId: "RUN",
    targetId: "T1",
    capability: "danger",
    scope: ["app.example.com"],
    issuedAt: NOW,
    expiresAt: SOON,
  });
  const result = await broker.execute(lease.id, req());
  return { result, audit };
}

describe("ToolBroker — an adapter that throws becomes an audited failure, never a rejected call", () => {
  it("handles a thrown Error", async () => {
    const { result, audit } = await runWith(new Error("boom"));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("boom");
    expect(audit.list().some((e) => e.type === AuditEventType.TOOL_EXECUTION)).toBe(true);
  });

  it("handles `throw undefined` / `throw null` without re-rejecting (the P2 regression)", async () => {
    for (const thrown of [undefined, null]) {
      const { result, audit } = await runWith(thrown);
      expect(result.ok).toBe(false);
      expect(audit.verify()).toEqual({ ok: true });
      expect(audit.list().some((e) => e.type === AuditEventType.TOOL_EXECUTION)).toBe(true);
    }
  });
});

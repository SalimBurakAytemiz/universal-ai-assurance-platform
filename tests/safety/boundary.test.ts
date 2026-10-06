import { describe, it, expect } from "vitest";
import {
  ActionClass,
  AssuranceDomain,
  DataClassification,
  Decision,
  Environment,
  Mode,
  newId,
  type ActionRequest,
  type AuthorizationRecord,
} from "@uaap/core";
import { AuthorizationKernel } from "@uaap/authorization-kernel";
import { PolicyEngine, loadBaselinePolicy } from "@uaap/policy-engine";
import { AuditLedger } from "@uaap/audit";
import { ToolBroker, type TargetAdapter } from "@uaap/tool-broker";
import { Orchestrator } from "@uaap/orchestrator";

const NOW = "2026-10-03T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const SOON = "2026-10-03T13:00:00.000Z";
const CLOCK = () => NOW_MS; // trusted clock pinned to NOW for deterministic window/expiry checks
const KNOWN = new Map<string, ActionClass>([["http.readonly.get", ActionClass.R1_LOW_IMPACT]]);

/** A spy adapter that counts how many times a target was actually touched. */
class SpyHttpAdapter implements TargetAdapter {
  readonly capability = "http.readonly";
  calls = 0;
  supports(action: string): boolean {
    return action === "http.readonly.get";
  }
  execute() {
    this.calls++;
    return { output: { status: 200 }, evidenceRef: "EV_" + this.calls };
  }
}

function auth(): AuthorizationRecord {
  return {
    id: "AUTH_1",
    mode: Mode.CLIENT_AUTHORIZED,
    targetId: "T1",
    allowedIdentifiers: ["app.example.com"],
    maxActionClass: ActionClass.R1_LOW_IMPACT,
    allowedEnvironments: [Environment.STAGING],
    allowedDomains: [AssuranceDomain.SECURITY],
    notBefore: "2026-10-01T00:00:00.000Z",
    notAfter: "2026-11-01T00:00:00.000Z",
    grantedBy: "owner:salim",
    reference: "signed://AUTH_1",
  };
}

function req(): ActionRequest {
  return {
    requestId: newId("REQ"),
    runId: "RUN_1",
    requestedBy: "agent:security.api",
    mode: Mode.CLIENT_AUTHORIZED,
    target: { id: "T1", name: "staging", identifiers: ["app.example.com"], environment: Environment.STAGING },
    domain: AssuranceDomain.SECURITY,
    actionClass: ActionClass.R1_LOW_IMPACT,
    action: "http.readonly.get",
    environment: Environment.STAGING,
    dataPolicy: { maxClassification: DataClassification.INTERNAL, minimalProofOfAccessOnly: true },
    now: NOW,
  };
}

function build(authorizations: AuthorizationRecord[], policy: PolicyEngine) {
  const adapter = new SpyHttpAdapter();
  const audit = new AuditLedger();
  const kernel = new AuthorizationKernel({ authorizations, knownActions: KNOWN, policy, clock: CLOCK });
  const broker = new ToolBroker({ kernel, audit, adapters: new Map([[adapter.capability, adapter]]), clock: CLOCK });
  const orchestrator = new Orchestrator(broker, audit);
  return { adapter, audit, broker, orchestrator };
}

describe("End-to-end boundary: Agent → Orchestrator → Kernel+Policy → Broker → Adapter", () => {
  it("NEVER touches the target when the decision is DENY (no authorization)", async () => {
    const { adapter, audit, orchestrator } = build([], loadBaselinePolicy());
    orchestrator.startRun("RUN_1", NOW);
    const result = await orchestrator.runSingle(req(), "http.readonly", SOON);

    expect(result.ok).toBe(false);
    expect(result.decision.decision).toBe(Decision.DENY);
    expect(adapter.calls).toBe(0); // the target was never reached
    // the denial is on the audit record
    expect(audit.list().some((e) => e.type === "DECISION")).toBe(true);
    expect(audit.list().some((e) => e.type === "TOOL_EXECUTION")).toBe(false);
  });

  it("reaches the target exactly once when fully authorized, and the audit chain verifies", async () => {
    const { adapter, audit, orchestrator } = build([auth()], loadBaselinePolicy());
    orchestrator.startRun("RUN_1", NOW);
    const result = await orchestrator.runSingle(req(), "http.readonly", SOON);

    expect(result.ok).toBe(true);
    expect(result.decision.decision).toBe(Decision.ALLOW);
    expect(adapter.calls).toBe(1);
    expect(audit.list().some((e) => e.type === "TOOL_EXECUTION")).toBe(true);
    expect(audit.verify()).toEqual({ ok: true });
  });

  it("the Orchestrator surface exposes no adapter, broker, or kernel to callers", () => {
    const { orchestrator } = build([auth()], loadBaselinePolicy());
    const ownKeys = Object.keys(orchestrator);
    // Only the private broker/audit fields exist, and nothing named 'adapter(s)'.
    expect(ownKeys.some((k) => /adapter/i.test(k))).toBe(false);
    // The public API is limited to orchestration methods.
    const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(orchestrator));
    expect(proto.sort()).toEqual(
      ["constructor", "dispatch", "issueLease", "runSingle", "startRun"].sort(),
    );
  });

  it("an expired lease is rejected before any kernel ALLOW can matter", async () => {
    const { adapter, orchestrator } = build([auth()], loadBaselinePolicy());
    const lease = orchestrator.issueLease({
      runId: "RUN_1",
      targetId: "T1",
      capability: "http.readonly",
      scope: ["app.example.com"],
      issuedAt: "2026-10-03T10:00:00.000Z",
      expiresAt: "2026-10-03T11:00:00.000Z",
    });
    const result = await orchestrator.dispatch(lease.id, req()); // trusted clock 12:00, lease expired at 11:00
    expect(result.ok).toBe(false);
    expect(adapter.calls).toBe(0);
  });

  it("REGRESSION (P0): flipping the request's actionClass to R0_PASSIVE does NOT skip authorization", async () => {
    // The exact bypass the adversarial review confirmed: with no authorization record, mislabeling the
    // adapter-backed, target-touching http.readonly.get as R0_PASSIVE must still DENY and never execute.
    const { adapter, orchestrator } = build([], loadBaselinePolicy());
    orchestrator.startRun("RUN_1", NOW);
    const passiveReq = { ...req(), actionClass: ActionClass.R0_PASSIVE };
    const result = await orchestrator.runSingle(passiveReq, "http.readonly", SOON);
    expect(result.ok).toBe(false);
    expect(result.decision.decision).toBe(Decision.DENY);
    expect(adapter.calls).toBe(0); // target never reached despite the R0 label
  });

  it("REGRESSION (P2): a lease narrowed below the broad authorization is ENFORCED by the broker", async () => {
    // Authorization covers both identifiers, but the lease is deliberately narrowed to one. A request
    // against the OTHER identifier is within the kernel's broad auth yet outside the lease scope → DENY.
    const broadAuth: AuthorizationRecord = { ...auth(), allowedIdentifiers: ["app.example.com", "b.example.com"] };
    const { adapter, broker } = build([broadAuth], loadBaselinePolicy());
    const lease = broker.issueLease({
      runId: "RUN_1",
      targetId: "T1",
      capability: "http.readonly",
      scope: ["app.example.com"], // narrowed: only the first identifier
      issuedAt: NOW,
      expiresAt: SOON,
    });
    const outOfScopeReq: ActionRequest = {
      ...req(),
      target: { id: "T1", name: "staging", identifiers: ["b.example.com"], environment: Environment.STAGING },
    };
    const result = await broker.execute(lease.id, outOfScopeReq);
    expect(result.ok).toBe(false);
    expect(adapter.calls).toBe(0); // the lease scope-narrowing actually confined the run
  });
});

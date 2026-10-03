import { describe, it, expect } from "vitest";
import { ActionClass } from "@uaap/core";
import { AgentPermissionResolver } from "@uaap/agent-permissions";

const resolver = AgentPermissionResolver.fromRepo();

describe("AgentPermissionResolver — least privilege from the real registry", () => {
  it("loads the 72-agent registry", () => {
    expect(resolver.getAgent("sec.application-security")).toBeDefined();
  });

  it("denies the hard-prohibited capabilities for EVERY agent", () => {
    const registry = (resolver as unknown as { byId: Map<string, unknown> }).byId;
    for (const id of registry.keys()) {
      for (const cap of ["authorization.create", "scope.expand", "policy.modify", "secret.export", "finding.close.own"]) {
        expect(resolver.can(id, cap).allow, `${id} ${cap}`).toBe(false);
      }
    }
  });

  it("denies an unknown capability (fail-closed)", () => {
    expect(resolver.can("sec.api-security", "database.drop").allow).toBe(false);
  });

  it("denies for an unknown agent", () => {
    expect(resolver.can("ghost.agent", "finding.detect").allow).toBe(false);
  });

  it("allows finding.detect only for detector-capable agents", () => {
    // sec.api-security is a detector; gov.master-orchestrator is not.
    expect(resolver.can("sec.api-security", "finding.detect").allow).toBe(true);
    expect(resolver.can("gov.master-orchestrator", "finding.detect").allow).toBe(false);
  });

  it("enforces the risk ceiling and never allows R3", () => {
    // gov agents are R0; sec.application-security is R2.
    expect(resolver.canPerformClass("gov.master-orchestrator", ActionClass.R1_LOW_IMPACT).allow).toBe(false);
    expect(resolver.canPerformClass("sec.application-security", ActionClass.R2_ELEVATED).allow).toBe(true);
    expect(resolver.canPerformClass("sec.application-security", ActionClass.R3_PROHIBITED).allow).toBe(false);
  });
});

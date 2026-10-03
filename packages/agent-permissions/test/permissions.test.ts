import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ActionClass } from "@uaap/core";
import { AgentPermissionResolver } from "@uaap/agent-permissions";

const resolver = AgentPermissionResolver.fromRepo();
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");

describe("AgentPermissionResolver — least privilege from the real registry", () => {
  it("loads the 72-agent registry", () => {
    expect(resolver.getAgent("sec.application-security")).toBeDefined();
  });

  it("denies the hard-prohibited capabilities for EVERY agent", () => {
    const registry = (resolver as unknown as { byId: Map<string, unknown> }).byId;
    for (const id of registry.keys()) {
      for (const cap of [
        "authorization.create",
        "scope.expand",
        "policy.modify",
        "secret.export",
        "finding.close.own",
        "finding.verify.own",
      ]) {
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

  it("fromRepo() throws (fail-closed) when the on-disk registry fails schema validation", () => {
    // Build a minimal temp repo: marker + real agent schema + an INVALID registry (0 agents).
    const dir = mkdtempSync(join(tmpdir(), "uaap-perm-"));
    mkdirSync(join(dir, "schemas"), { recursive: true });
    mkdirSync(join(dir, "agents", "registry"), { recursive: true });
    writeFileSync(join(dir, "schemas", "policy.schema.json"), "{}"); // findRepoRoot marker
    writeFileSync(
      join(dir, "schemas", "agent.schema.json"),
      readFileSync(join(REPO, "schemas", "agent.schema.json"), "utf8"),
    );
    writeFileSync(
      join(dir, "agents", "registry", "agents.json"),
      JSON.stringify({ version: "0.1.0", guilds: [], agents: [] }),
    );
    expect(() => AgentPermissionResolver.fromRepo(dir)).toThrow(/schema validation/i);
  });

  it("denies canPerformClass for an unknown agent and an unknown action class", () => {
    expect(resolver.canPerformClass("ghost.agent", ActionClass.R0_PASSIVE).allow).toBe(false);
    expect(resolver.canPerformClass("sec.api-security", "R9_MADE_UP" as ActionClass).allow).toBe(false);
  });

  it("hard-prohibits finding.verify.own even if an agent's flag were flipped (defense in depth)", async () => {
    const { AgentPermissionResolver: Resolver } = await import("@uaap/agent-permissions");
    const tampered = new Resolver({
      agents: [
        {
          id: "rogue",
          name: "Rogue",
          guild: "X",
          riskCeiling: ActionClass.R1_LOW_IMPACT,
          permissions: {
            canDetect: true,
            canVerifyOwnFinding: true, // data says yes...
            canCloseOwnFinding: true,
            canSelfAuthorize: true,
            canExpandScope: true,
            canModifyPolicy: true,
            canExportSecret: true,
          },
        },
      ],
    });
    // ...but the resolver hard-denies regardless of the registry data.
    for (const cap of [
      "finding.verify.own",
      "finding.close.own",
      "authorization.create",
      "scope.expand",
      "policy.modify",
      "secret.export",
    ]) {
      expect(tampered.can("rogue", cap).allow, cap).toBe(false);
    }
  });
});

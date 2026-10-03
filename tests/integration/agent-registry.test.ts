import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

interface AgentPermissions {
  canDetect: boolean;
  canVerifyOwnFinding: boolean;
  canCloseOwnFinding: boolean;
  canSelfAuthorize: boolean;
  canExpandScope: boolean;
  canModifyPolicy: boolean;
  canExportSecret: boolean;
}
interface Agent {
  id: string;
  name: string;
  guild: string;
  riskCeiling: string;
  permissions: AgentPermissions;
}
interface Registry {
  guilds: string[];
  agents: Agent[];
}

const registry = JSON.parse(
  readFileSync(new URL("../../agents/registry/agents.json", import.meta.url), "utf8"),
) as Registry;

describe("Canonical agent registry", () => {
  it("defines exactly 72 agents across 9 guilds (8 each)", () => {
    expect(registry.agents).toHaveLength(72);
    expect(registry.guilds).toHaveLength(9);
    for (const g of registry.guilds) {
      expect(registry.agents.filter((a) => a.guild === g)).toHaveLength(8);
    }
  });

  it("has unique agent ids", () => {
    const ids = registry.agents.map((a) => a.id);
    expect(new Set(ids).size).toBe(72);
  });

  it("enforces least-privilege invariants on EVERY agent", () => {
    for (const a of registry.agents) {
      // Separation of duties + the hard prohibitions must hold for all agents.
      expect(a.permissions.canCloseOwnFinding, a.id).toBe(false);
      expect(a.permissions.canSelfAuthorize, a.id).toBe(false);
      expect(a.permissions.canExpandScope, a.id).toBe(false);
      expect(a.permissions.canModifyPolicy, a.id).toBe(false);
      expect(a.permissions.canExportSecret, a.id).toBe(false);
      expect(a.riskCeiling, a.id).not.toBe("R3_PROHIBITED");
    }
  });

  it("maps the key legacy QA/Security roles to a canonical agent (no role silently dropped)", () => {
    const byId = new Map(registry.agents.map((a) => [a.id, a]));
    // A representative sample of the legacy roles the migration map must cover.
    for (const id of [
      "qa.api-contract", // was: API Contract Agent / AJV
      "qa.web-ui-automation", // was: Playwright Agent / Selenium Compatibility Agent
      "qa.mobile-quality", // was: Appium Android/iOS Agent
      "sec.application-security", // was: Web Security Agent
      "sec.api-security", // was: API Security Agent
      "know.standards-intelligence", // was: OWASP/CWE/ATT&CK/NIST Mappers
      "evr.finding-verifier", // was: Finding Verifier Agent
      "evr.release-gate", // was: Release Review Agent
    ]) {
      expect(byId.has(id), `missing canonical agent ${id}`).toBe(true);
    }
  });
});

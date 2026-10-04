import { describe, it, expect } from "vitest";
import { AssurancePlanner, CORE_ROLES } from "@uaap/assurance-planner";

const planner = AssurancePlanner.fromRepo();

describe("AssurancePlanner — run team manifest", () => {
  it("always includes the core governance/evidence/verification/reporting roles", () => {
    const m = planner.plan({ runId: "R1", capabilities: [], domains: ["generic"] });
    for (const id of CORE_ROLES) expect(m.selected.map((s) => s.agentId)).toContain(id);
    expect(m.totalRoles).toBe(72);
  });

  it("activates the roles a capability requires, each with a reason", () => {
    const m = planner.plan({ runId: "R1", capabilities: ["payment"], domains: ["fintech"] });
    const ids = m.selected.map((s) => s.agentId);
    for (const id of ["qa.api-contract", "sec.api-security", "dprp.data-integrity-and-reconciliation", "biz.business-rules-intelligence"]) {
      expect(ids).toContain(id);
    }
    const apiContract = m.selected.find((s) => s.agentId === "qa.api-contract")!;
    expect(apiContract.reason).toMatch(/payment/);
    // domain specialist activated because a sector domain is present
    expect(ids).toContain("biz.domain-specialist-coordinator");
  });

  it("does NOT activate irrelevant agents, and records why in notSelected", () => {
    const m = planner.plan({ runId: "R1", capabilities: ["payment"], domains: ["fintech"] });
    expect(m.selected.map((s) => s.agentId)).not.toContain("qa.mobile-quality");
    const mobile = m.notSelected.find((n) => n.agentId === "qa.mobile-quality");
    expect(mobile?.reason).toMatch(/not required/i);
  });

  it("does not add a domain specialist for a generic-only project", () => {
    const m = planner.plan({ runId: "R1", capabilities: [], domains: ["generic"] });
    expect(m.selected.map((s) => s.agentId)).not.toContain("biz.domain-specialist-coordinator");
  });

  it("adds extra assurance roles at HIGH risk", () => {
    const m = planner.plan({ runId: "R1", capabilities: [], domains: ["generic"], riskLevel: "HIGH" });
    const ids = m.selected.map((s) => s.agentId);
    expect(ids).toContain("evr.independent-regression-validator");
    expect(ids).toContain("dprp.reliability-engineering");
  });

  it("respects a budget: drops lowest-priority extras but NEVER a core role", () => {
    const full = planner.plan({ runId: "R1", capabilities: ["payment", "web", "mobile", "realtime"], domains: ["fintech", "gaming"], riskLevel: "HIGH" });
    const budgeted = planner.plan({ runId: "R1", capabilities: ["payment", "web", "mobile", "realtime"], domains: ["fintech", "gaming"], riskLevel: "HIGH", budgetMaxAgents: 9 });
    expect(budgeted.selectedCount).toBeLessThan(full.selectedCount);
    expect(budgeted.selectedCount).toBeLessThanOrEqual(9);
    for (const id of CORE_ROLES) expect(budgeted.selected.map((s) => s.agentId)).toContain(id); // core kept
    expect(budgeted.notSelected.some((n) => /over budget/i.test(n.reason))).toBe(true);
  });

  it("every selected role is a real registry agent id", () => {
    const m = planner.plan({ runId: "R1", capabilities: ["payment", "web", "mobile", "realtime", "data-store", "auth"], domains: ["fintech"], riskLevel: "HIGH" });
    const registryIds = new Set((AssurancePlanner.fromRepo() as unknown as { ids: Set<string> }).ids);
    for (const s of m.selected) expect(registryIds.has(s.agentId), s.agentId).toBe(true);
    expect(m.selectedCount + m.notSelected.filter((n) => /not required|over budget/.test(n.reason)).length).toBeGreaterThanOrEqual(m.totalRoles);
  });
});

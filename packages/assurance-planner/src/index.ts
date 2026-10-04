// Assurance Planner: turns a project's detected capabilities + domains + risk + budget into the
// RUN TEAM MANIFEST — the specific agent roles activated for a run, each with a reason (for the
// Decision Ledger). Only the needed agents are activated; 72 roles defined != 72 agents per run.
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readRepoJson } from "@uaap/core";

interface AgentDef { readonly id: string; readonly name: string; readonly guild: string }
interface AgentRegistry { readonly agents: readonly AgentDef[] }

/** Core governance/evidence/verification/reporting roles — always on a run (priority 0, never dropped). */
export const CORE_ROLES: readonly string[] = [
  "gov.master-orchestrator",
  "gov.authorization-gate",
  "gov.policy-decision",
  "gov.audit-and-provenance",
  "evr.evidence-collector",
  "evr.finding-verifier",
  "biz.technical-report",
];

/** Capability -> the agent roles it requires. */
export const CAPABILITY_ROLES: Record<string, readonly string[]> = {
  auth: ["sec.identity-access-and-session-security"],
  payment: ["qa.api-contract", "sec.api-security", "dprp.data-integrity-and-reconciliation", "biz.business-rules-intelligence"],
  ledger: ["dprp.data-integrity-and-reconciliation"],
  cart: ["qa.api-contract", "biz.critical-journey"],
  catalog: ["qa.api-contract"],
  inventory: ["dprp.data-integrity-and-reconciliation", "qa.api-contract"],
  currency: ["dprp.data-integrity-and-reconciliation", "biz.business-rules-intelligence"],
  realtime: ["qa.realtime-event-queue-quality"],
  "data-store": ["qa.database-and-migration-quality"],
  web: ["qa.web-ui-automation", "qa.visual-and-accessibility-quality"],
  mobile: ["qa.mobile-quality"],
};

/** Higher risk pulls in extra assurance roles. */
const RISK_ROLES: Record<string, readonly string[]> = {
  HIGH: ["dprp.reliability-engineering", "evr.false-positive-challenger", "evr.independent-regression-validator"],
};

export interface PlanInput {
  readonly runId: string;
  readonly capabilities: readonly string[];
  /** Domain pack ids present (a non-generic one activates the domain specialist). */
  readonly domains: readonly string[];
  readonly riskLevel?: "LOW" | "MEDIUM" | "HIGH";
  /** Max agents for this run (core roles are always kept even if this is smaller). */
  readonly budgetMaxAgents?: number;
}

export interface TeamMember { readonly agentId: string; readonly reason: string; readonly priority: number }
export interface RunTeamManifest {
  readonly runId: string;
  readonly selected: readonly TeamMember[];
  /** Roles considered but not selected, with WHY (budget drops + registry roles not required). */
  readonly notSelected: readonly { readonly agentId: string; readonly reason: string }[];
  /** Detected capabilities with NO role mapping — flagged so a coverage gap never passes silently. */
  readonly unmappedCapabilities: readonly string[];
  readonly selectedCount: number;
  readonly totalRoles: number;
}

export class AssurancePlanner {
  private readonly ids: Set<string>;
  constructor(registry: AgentRegistry) {
    this.ids = new Set(registry.agents.map((a) => a.id));
  }
  static fromRepo(startDir = dirname(fileURLToPath(import.meta.url))): AssurancePlanner {
    return new AssurancePlanner(readRepoJson<AgentRegistry>("agents/registry/agents.json", startDir));
  }

  /**
   * Build the run team. Core roles are priority 0 (never dropped). Capability/domain/risk roles are
   * priority 1-2. If budgetMaxAgents is set and exceeded, the lowest-priority (highest number) extra
   * roles are dropped first and recorded in notSelected with a reason. Every selected role must be a
   * real registry id (unknown mappings are dropped, never silently kept).
   */
  plan(input: PlanInput): RunTeamManifest {
    const coreSet = new Set(CORE_ROLES);
    const want = new Map<string, { reasons: string[]; priority: number }>();
    const add = (id: string, reason: string, priority: number) => {
      if (!this.ids.has(id)) return; // never select a role that is not a real registry agent
      const cur = want.get(id);
      if (!cur || priority < cur.priority) want.set(id, { reasons: [reason], priority });
      else if (priority === cur.priority && !cur.reasons.includes(reason)) cur.reasons.push(reason); // accumulate all justifications
    };

    for (const id of CORE_ROLES) add(id, "core governance / evidence / verification / reporting", 0);
    const unmappedCapabilities: string[] = [];
    for (const cap of input.capabilities) {
      const roles = CAPABILITY_ROLES[cap];
      if (roles === undefined) { if (!unmappedCapabilities.includes(cap)) unmappedCapabilities.push(cap); continue; }
      for (const id of roles) add(id, `required by capability "${cap}"`, 1);
    }
    const sectorDomains = input.domains.filter((d) => d && d !== "generic");
    if (sectorDomains.length > 0) add("biz.domain-specialist-coordinator", `domain(s) present: ${sectorDomains.join(", ")}`, 2);
    if (input.riskLevel === "HIGH") for (const id of RISK_ROLES.HIGH ?? []) add(id, "elevated risk level", 2);

    let members: TeamMember[] = [...want.entries()].map(([agentId, v]) => ({ agentId, reason: v.reasons.join("; "), priority: v.priority }));
    members.sort((a, b) => a.priority - b.priority || (a.agentId < b.agentId ? -1 : 1));

    const notSelected: { agentId: string; reason: string }[] = [];
    if (input.budgetMaxAgents !== undefined) {
      // Drop the lowest-priority NON-core roles first; CORE roles are never dropped (so the team may
      // exceed the budget when it is set below the core-role count). Carry the original reason.
      while (members.length > input.budgetMaxAgents) {
        let victimIdx = -1;
        for (let i = members.length - 1; i >= 0; i--) if (!coreSet.has(members[i]!.agentId)) { victimIdx = i; break; }
        if (victimIdx === -1) break; // only core roles remain — keep them even if over budget
        const victim = members.splice(victimIdx, 1)[0]!;
        notSelected.push({ agentId: victim.agentId, reason: `required (${victim.reason}); dropped: over budget (${input.budgetMaxAgents})` });
      }
    }

    // Record registry roles that were not required this run (for the Decision Ledger "why not").
    const selectedIds = new Set(members.map((m) => m.agentId));
    for (const id of this.ids) {
      if (!selectedIds.has(id) && !notSelected.some((n) => n.agentId === id)) {
        notSelected.push({ agentId: id, reason: "not required by detected capabilities/domains/risk" });
      }
    }

    return { runId: input.runId, selected: members, notSelected, unmappedCapabilities, selectedCount: members.length, totalRoles: this.ids.size };
  }
}

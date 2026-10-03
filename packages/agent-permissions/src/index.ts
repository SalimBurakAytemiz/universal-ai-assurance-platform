import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { ActionClass, readRepoJson } from "@uaap/core";

export interface AgentPermissions {
  readonly canDetect: boolean;
  readonly canVerifyOwnFinding: boolean;
  readonly canCloseOwnFinding: boolean;
  readonly canSelfAuthorize: boolean;
  readonly canExpandScope: boolean;
  readonly canModifyPolicy: boolean;
  readonly canExportSecret: boolean;
}

export interface AgentDefinition {
  readonly id: string;
  readonly name: string;
  readonly guild: string;
  readonly riskCeiling: ActionClass;
  readonly permissions: AgentPermissions;
}

export interface AgentRegistry {
  readonly agents: readonly AgentDefinition[];
}

export interface PermissionVerdict {
  readonly allow: boolean;
  readonly reason: string;
}

const ACTION_RANK: Record<string, number> = {
  [ActionClass.R0_PASSIVE]: 0,
  [ActionClass.R1_LOW_IMPACT]: 1,
  [ActionClass.R2_ELEVATED]: 2,
  [ActionClass.R3_PROHIBITED]: 3,
};

/**
 * Capability → the agent permission flag that governs it. Every capability listed here is
 * gated by a boolean on the agent. Capabilities NOT listed are unknown and denied (fail-closed).
 * The last five map to flags that are `const false` for all agents (schema-enforced), so these
 * capabilities are effectively never grantable to any agent.
 */
const CAPABILITY_PERMISSION: Record<string, keyof AgentPermissions> = {
  "finding.detect": "canDetect",
  "finding.verify.own": "canVerifyOwnFinding",
  "finding.close.own": "canCloseOwnFinding",
  "authorization.create": "canSelfAuthorize",
  "scope.expand": "canExpandScope",
  "policy.modify": "canModifyPolicy",
  "secret.export": "canExportSecret",
};

/**
 * Capabilities that must be denied for EVERY agent regardless of registry data — defense in
 * depth so the guarantee does not rest solely on a JSON file + a CI step. These all map to
 * permission flags that are `const false` in the agent schema.
 */
const HARD_PROHIBITED: ReadonlySet<string> = new Set([
  "authorization.create",
  "scope.expand",
  "policy.modify",
  "secret.export",
  "finding.close.own",
  "finding.verify.own",
]);

/** Resolves whether a given agent may exercise a capability or an action class. Fail-closed. */
export class AgentPermissionResolver {
  private readonly byId: Map<string, AgentDefinition>;

  constructor(registry: AgentRegistry) {
    this.byId = new Map(registry.agents.map((a) => [a.id, a]));
  }

  static fromRepo(startDir = dirname(fileURLToPath(import.meta.url))): AgentPermissionResolver {
    const registry = readRepoJson<AgentRegistry>("agents/registry/agents.json", startDir);
    const schema = readRepoJson<object>("schemas/agent.schema.json", startDir);
    const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
    if (!validate(registry)) {
      const msg = (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`.trim()).join("; ");
      throw new Error(`Agent registry failed schema validation; refusing to load (fail-closed): ${msg}`);
    }
    return new AgentPermissionResolver(registry);
  }

  getAgent(agentId: string): AgentDefinition | undefined {
    return this.byId.get(agentId);
  }

  /** Can this agent exercise a named capability? Unknown agent or capability ⇒ deny. */
  can(agentId: string, capability: string): PermissionVerdict {
    const agent = this.byId.get(agentId);
    if (!agent) return { allow: false, reason: `Unknown agent "${agentId}".` };
    // Defense in depth: these are denied for every agent regardless of registry data.
    if (HARD_PROHIBITED.has(capability)) {
      return { allow: false, reason: `Capability "${capability}" is hard-prohibited for all agents.` };
    }
    const flag = CAPABILITY_PERMISSION[capability];
    if (!flag) return { allow: false, reason: `Unknown capability "${capability}" (fail-closed).` };
    if (agent.permissions[flag]) return { allow: true, reason: `${agentId} has ${flag}.` };
    return { allow: false, reason: `${agentId} lacks ${flag} (capability "${capability}" denied).` };
  }

  /** Can this agent operate at a given action class, given its risk ceiling? R3 always denied. */
  canPerformClass(agentId: string, actionClass: ActionClass): PermissionVerdict {
    const agent = this.byId.get(agentId);
    if (!agent) return { allow: false, reason: `Unknown agent "${agentId}".` };
    if (actionClass === ActionClass.R3_PROHIBITED) {
      return { allow: false, reason: "R3_PROHIBITED is denied for every agent." };
    }
    const rank = ACTION_RANK[actionClass];
    const ceiling = ACTION_RANK[agent.riskCeiling];
    if (rank === undefined) return { allow: false, reason: `Unknown action class "${actionClass}".` };
    if (rank > (ceiling ?? -1)) {
      return { allow: false, reason: `${actionClass} exceeds ${agentId} risk ceiling ${agent.riskCeiling}.` };
    }
    return { allow: true, reason: `${actionClass} within ${agentId} ceiling ${agent.riskCeiling}.` };
  }
}

export { CAPABILITY_PERMISSION, HARD_PROHIBITED };

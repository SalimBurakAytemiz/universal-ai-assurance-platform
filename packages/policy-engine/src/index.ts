import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import type { ActionRequest } from "@uaap/core";

export interface PolicyMatch {
  readonly modes?: readonly string[];
  readonly domains?: readonly string[];
  readonly actionClasses?: readonly string[];
  readonly environments?: readonly string[];
  readonly actions?: readonly string[];
}

export interface PolicyRule {
  readonly id: string;
  readonly effect: "ALLOW" | "DENY";
  readonly description: string;
  readonly match?: PolicyMatch;
}

export interface PolicyDocument {
  readonly version: string;
  readonly name: string;
  readonly description?: string;
  readonly default: "DENY";
  readonly rules: readonly PolicyRule[];
}

export interface PolicyVerdict {
  readonly allow: boolean;
  readonly ruleId: string;
  readonly explanation: string;
}

/**
 * Fail-closed policy-as-code engine. Composed with the kernel as an AND-gate: it can
 * only further restrict. If the policy document fails schema validation, every request
 * is denied (infrastructure-level fail-closed), never silently allowed.
 */
export class PolicyEngine {
  private readonly valid: boolean;
  private readonly validationError: string | null;

  constructor(
    private readonly document: PolicyDocument,
    schema: object,
  ) {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    const validate: ValidateFunction = ajv.compile(schema);
    this.valid = validate(document) as boolean;
    this.validationError = this.valid
      ? null
      : (validate.errors ?? []).map((e) => `${e.instancePath} ${e.message}`).join("; ");
  }

  get isValid(): boolean {
    return this.valid;
  }

  get error(): string | null {
    return this.validationError;
  }

  evaluate(request: ActionRequest): PolicyVerdict {
    if (!this.valid) {
      return {
        allow: false,
        ruleId: "policy-invalid",
        explanation: `Policy document failed schema validation and is treated as deny-all: ${this.validationError}`,
      };
    }
    for (const rule of this.document.rules) {
      if (matches(rule.match, request)) {
        return { allow: rule.effect === "ALLOW", ruleId: rule.id, explanation: rule.description };
      }
    }
    return {
      allow: false,
      ruleId: "default-deny",
      explanation: "No policy rule matched; the fail-closed default is DENY.",
    };
  }
}

function matches(match: PolicyMatch | undefined, req: ActionRequest): boolean {
  if (!match) return true;
  if (match.modes && !match.modes.includes(req.mode)) return false;
  if (match.domains && !match.domains.includes(req.domain)) return false;
  if (match.actionClasses && !match.actionClasses.includes(req.actionClass)) return false;
  if (match.environments && !match.environments.includes(req.environment)) return false;
  if (match.actions && !match.actions.includes(req.action)) return false;
  return true;
}

/** Walk up from a starting directory until a directory containing `schemas/policy.schema.json` is found. */
function findRepoRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, "schemas", "policy.schema.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("Could not locate repository root containing schemas/policy.schema.json");
}

/** Load and validate the baseline policy from the repository's `policies/` + `schemas/`. */
export function loadBaselinePolicy(startDir?: string): PolicyEngine {
  const start = startDir ?? dirname(fileURLToPath(import.meta.url));
  const root = findRepoRoot(start);
  const schema = JSON.parse(readFileSync(join(root, "schemas", "policy.schema.json"), "utf8")) as object;
  const document = JSON.parse(
    readFileSync(join(root, "policies", "baseline.policy.json"), "utf8"),
  ) as PolicyDocument;
  return new PolicyEngine(document, schema);
}

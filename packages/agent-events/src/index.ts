import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import { readRepoJson } from "@uaap/core";

/** Canonical structured event types for agent-to-agent communication. */
export const AgentEventType = {
  OBSERVATION: "OBSERVATION",
  HYPOTHESIS: "HYPOTHESIS",
  TEST_PLAN: "TEST_PLAN",
  EXECUTION_RESULT: "EXECUTION_RESULT",
  FINDING_CANDIDATE: "FINDING_CANDIDATE",
  FINDING_VERIFIED: "FINDING_VERIFIED",
  FINDING_REJECTED: "FINDING_REJECTED",
  REMEDIATION_PROPOSED: "REMEDIATION_PROPOSED",
  RETEST_RESULT: "RETEST_RESULT",
  KNOWLEDGE_CANDIDATE: "KNOWLEDGE_CANDIDATE",
  KNOWLEDGE_CERTIFIED: "KNOWLEDGE_CERTIFIED",
  POLICY_DECISION: "POLICY_DECISION",
  APPROVAL_REQUIRED: "APPROVAL_REQUIRED",
} as const;
export type AgentEventType = (typeof AgentEventType)[keyof typeof AgentEventType];

/** Epistemic status: a claim is never a fact until verified against evidence. */
export const VerificationStatus = {
  UNVERIFIED: "UNVERIFIED",
  VALIDATION_PENDING: "VALIDATION_PENDING",
  CONFIRMED: "CONFIRMED",
  REJECTED: "REJECTED",
} as const;
export type VerificationStatus = (typeof VerificationStatus)[keyof typeof VerificationStatus];

export interface AgentEvent {
  readonly type: AgentEventType;
  readonly sourceAgent: string;
  readonly at: string;
  readonly projectId?: string;
  readonly targetId?: string;
  readonly runId?: string;
  readonly confidence?: number;
  readonly evidenceRefs?: readonly string[];
  readonly requiresVerification?: boolean;
  readonly verificationStatus?: VerificationStatus;
  readonly payload?: unknown;
}

export type ValidationResult =
  | { readonly ok: true; readonly event: AgentEvent }
  | { readonly ok: false; readonly errors: string[] };

let cachedValidator: ValidateFunction | null = null;

function validator(): ValidateFunction {
  if (cachedValidator) return cachedValidator;
  const schema = readRepoJson<object>(
    "schemas/agent-event.schema.json",
    dirname(fileURLToPath(import.meta.url)),
  );
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  cachedValidator = ajv.compile(schema);
  return cachedValidator;
}

/**
 * Validate an untrusted value as a structured agent event. Fail-closed: anything that does not
 * match the schema is rejected (a FINDING_VERIFIED without CONFIRMED status + evidence fails).
 */
export function validateAgentEvent(value: unknown): ValidationResult {
  const validate = validator();
  if (validate(value)) return { ok: true, event: value as AgentEvent };
  return {
    ok: false,
    errors: (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`.trim()),
  };
}

/** A knowledge/finding claim carrier. Confidence does not substitute for evidence. */
export interface Claim<T = unknown> {
  readonly claim: T;
  readonly source: string;
  readonly evidenceRefs: readonly string[];
  readonly confidence: number;
  readonly provenance: string;
  readonly verificationStatus: VerificationStatus;
}

/** A claim is actionable-as-fact only when CONFIRMED and backed by at least one evidence ref. */
export function isConfirmedFact(claim: Claim): boolean {
  return claim.verificationStatus === VerificationStatus.CONFIRMED && claim.evidenceRefs.length > 0;
}

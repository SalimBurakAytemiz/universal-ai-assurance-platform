// Canonical enumerations shared across the platform.
// Modeled as frozen const objects + derived union types so they are tree-shakeable,
// safe under `isolatedModules`, and usable as both values and types.

/** Operating mode for a target. Ownership/authorization is represented in state, never assumed. */
export const Mode = {
  /** Not yet a customer: only public / passive / non-intrusive analysis. No active testing. */
  PROSPECT_PASSIVE: "PROSPECT_PASSIVE",
  /** Explicitly authorized customer target, bounded by an explicit scope. */
  CLIENT_AUTHORIZED: "CLIENT_AUTHORIZED",
  /** System the operator owns/controls — ownership must be declared in state. */
  INTERNAL_OWNED: "INTERNAL_OWNED",
} as const;
export type Mode = (typeof Mode)[keyof typeof Mode];

/** Risk class of a requested action. Higher classes require stronger authorization. */
export const ActionClass = {
  /** Passive: normal public retrieval / metadata only. */
  R0_PASSIVE: "R0_PASSIVE",
  /** Low-impact, non-destructive validation within an explicit authorized scope. */
  R1_LOW_IMPACT: "R1_LOW_IMPACT",
  /** Elevated: potential impact on availability/data/state. Needs explicit per-action approval. */
  R2_ELEVATED: "R2_ELEVATED",
  /** Prohibited baseline: denied by default and not unlockable in this repository. */
  R3_PROHIBITED: "R3_PROHIBITED",
} as const;
export type ActionClass = (typeof ActionClass)[keyof typeof ActionClass];

/** The only possible outcomes of a trust/policy decision. There is no implicit ALLOW. */
export const Decision = {
  ALLOW: "ALLOW",
  DENY: "DENY",
  HUMAN_APPROVAL_REQUIRED: "HUMAN_APPROVAL_REQUIRED",
} as const;
export type Decision = (typeof Decision)[keyof typeof Decision];

/** Deployment environment of a target. */
export const Environment = {
  LOCAL: "LOCAL",
  DEV: "DEV",
  QA: "QA",
  STAGING: "STAGING",
  PREPROD: "PREPROD",
  PRODUCTION: "PRODUCTION",
} as const;
export type Environment = (typeof Environment)[keyof typeof Environment];

/** Data sensitivity classification used by evidence and tool-access policy. */
export const DataClassification = {
  PUBLIC: "PUBLIC",
  INTERNAL: "INTERNAL",
  CONFIDENTIAL: "CONFIDENTIAL",
  RESTRICTED: "RESTRICTED",
} as const;
export type DataClassification = (typeof DataClassification)[keyof typeof DataClassification];

/** Assurance domains. Quality and Security are peers over one shared core. */
export const AssuranceDomain = {
  QUALITY: "QUALITY",
  SECURITY: "SECURITY",
  DATA: "DATA",
  PERFORMANCE: "PERFORMANCE",
  RELIABILITY: "RELIABILITY",
  PRIVACY: "PRIVACY",
  ACCESSIBILITY: "ACCESSIBILITY",
} as const;
export type AssuranceDomain = (typeof AssuranceDomain)[keyof typeof AssuranceDomain];

/** Finding lifecycle states (shared QA + Security). Detector cannot drive to CLOSED alone. */
export const FindingStatus = {
  SIGNAL: "SIGNAL",
  HYPOTHESIS: "HYPOTHESIS",
  VALIDATION_PENDING: "VALIDATION_PENDING",
  CONFIRMED: "CONFIRMED",
  REMEDIATION_IN_PROGRESS: "REMEDIATION_IN_PROGRESS",
  RETEST_PENDING: "RETEST_PENDING",
  CLOSED: "CLOSED",
  REOPENED: "REOPENED",
  REJECTED_FALSE_POSITIVE: "REJECTED_FALSE_POSITIVE",
} as const;
export type FindingStatus = (typeof FindingStatus)[keyof typeof FindingStatus];

/** Severity for findings and review results. */
export const Severity = {
  P0: "P0",
  P1: "P1",
  P2: "P2",
  P3: "P3",
} as const;
export type Severity = (typeof Severity)[keyof typeof Severity];

/** Structured reason attached to every non-ALLOW decision (and to classified refusals). */
export const DecisionReason = {
  OK: "OK",
  DEFAULT_DENY: "DEFAULT_DENY",
  AUTHORIZATION_MISSING: "AUTHORIZATION_MISSING",
  AUTHORIZATION_EXPIRED: "AUTHORIZATION_EXPIRED",
  OUT_OF_SCOPE: "OUT_OF_SCOPE",
  AMBIGUOUS_TARGET: "AMBIGUOUS_TARGET",
  AMBIGUOUS_SCOPE: "AMBIGUOUS_SCOPE",
  UNKNOWN_ACTION: "UNKNOWN_ACTION",
  PROHIBITED_ACTION_CLASS: "PROHIBITED_ACTION_CLASS",
  ELEVATED_REQUIRES_APPROVAL: "ELEVATED_REQUIRES_APPROVAL",
  ENVIRONMENT_FORBIDDEN: "ENVIRONMENT_FORBIDDEN",
  DATA_POLICY_VIOLATION: "DATA_POLICY_VIOLATION",
  RATE_OR_BUDGET_EXCEEDED: "RATE_OR_BUDGET_EXCEEDED",
  TIME_WINDOW_CLOSED: "TIME_WINDOW_CLOSED",
  POLICY_DENY: "POLICY_DENY",
} as const;
export type DecisionReason = (typeof DecisionReason)[keyof typeof DecisionReason];

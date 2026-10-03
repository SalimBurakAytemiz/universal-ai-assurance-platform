import type {
  ActionClass,
  AssuranceDomain,
  DataClassification,
  Decision,
  DecisionReason,
  Environment,
  Mode,
  Severity,
} from "./enums";

/** A concrete target the platform may act upon. */
export interface TargetIdentity {
  /** Stable id for the target within a project. */
  readonly id: string;
  /** Human-readable name. */
  readonly name: string;
  /** Canonical identifier(s) that scope matching is performed against (host, repo, package, etc.). */
  readonly identifiers: readonly string[];
  readonly environment: Environment;
}

/** An explicit, bounded authorization for active work against a target. */
export interface AuthorizationRecord {
  readonly id: string;
  readonly mode: Mode;
  readonly targetId: string;
  /** Exact identifiers this authorization covers (must match the target). */
  readonly allowedIdentifiers: readonly string[];
  /** Highest action class allowed without additional per-action approval. */
  readonly maxActionClass: ActionClass;
  readonly allowedEnvironments: readonly Environment[];
  readonly allowedDomains: readonly AssuranceDomain[];
  /** ISO-8601 inclusive start / exclusive end of the authorization window. */
  readonly notBefore: string;
  readonly notAfter: string;
  /** Who granted it (human owner/approver reference) — provenance, not a secret. */
  readonly grantedBy: string;
  /** Free-text reference to the signed authorization artifact. */
  readonly reference: string;
}

/** Data-handling policy that travels with a request. */
export interface DataPolicy {
  readonly maxClassification: DataClassification;
  /** If true, only minimal proof-of-access is permitted (no full data extraction). */
  readonly minimalProofOfAccessOnly: boolean;
}

/** A request to perform a single action against a target. The kernel decides on it. */
export interface ActionRequest {
  readonly requestId: string;
  readonly runId: string;
  /** The agent/component asking. Agents never reach a target directly. */
  readonly requestedBy: string;
  readonly mode: Mode;
  readonly target: TargetIdentity;
  readonly domain: AssuranceDomain;
  readonly actionClass: ActionClass;
  /** Stable action name, e.g. "http.get", "db.readonly.query", "web.click". */
  readonly action: string;
  readonly environment: Environment;
  readonly dataPolicy: DataPolicy;
  /** ISO-8601 time the request is evaluated at (injected, for deterministic tests). */
  readonly now: string;
  /** Optional explicit human approval token for R2 actions. */
  readonly approvalToken?: string;
}

/** The immutable result of evaluating an ActionRequest. */
export interface DecisionResult {
  readonly requestId: string;
  readonly decision: Decision;
  readonly reason: DecisionReason;
  /** Human-readable explanation suitable for the Decision Ledger / UI. */
  readonly explanation: string;
  /** Ordered list of rule ids that were evaluated, for auditability. */
  readonly evaluated: readonly string[];
  readonly decidedAt: string;
}

/** A finding produced by any assurance domain. */
export interface Finding {
  readonly id: string;
  readonly domain: AssuranceDomain;
  readonly title: string;
  readonly status: FindingStatusValue;
  readonly severity: Severity;
  /** Ids of evidence records supporting the finding. Verified findings require evidence. */
  readonly evidenceIds: readonly string[];
  /** Component/agent that detected it. A detector cannot move status to CLOSED. */
  readonly detectedBy: string;
}

// Imported as a value elsewhere; re-declared as a type alias here to avoid a value import cycle.
import type { FindingStatus } from "./enums";
export type FindingStatusValue = FindingStatus;

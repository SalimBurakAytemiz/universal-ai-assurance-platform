import { AssuranceDomain, canonicalIdentity, FindingStatus, Severity, type Finding } from "@uaap/core";

export const GateStatus = { PASS: "PASS", FAIL: "FAIL", NOT_RUN: "NOT_RUN" } as const;
export type GateStatus = (typeof GateStatus)[keyof typeof GateStatus];

export const ReleaseDecision = {
  RELEASE_ALLOWED: "RELEASE_ALLOWED",
  RELEASE_ALLOWED_WITH_ACCEPTED_RISK: "RELEASE_ALLOWED_WITH_ACCEPTED_RISK",
  HUMAN_APPROVAL_REQUIRED: "HUMAN_APPROVAL_REQUIRED",
  RELEASE_BLOCKED: "RELEASE_BLOCKED",
} as const;
export type ReleaseDecision = (typeof ReleaseDecision)[keyof typeof ReleaseDecision];

export interface GateDomainResult {
  readonly domain: AssuranceDomain;
  readonly status: GateStatus;
  readonly evidenceIds?: readonly string[];
}

export interface RiskAcceptance {
  readonly findingId: string;
  readonly reason: string;
  readonly owner: string;
  readonly approver: string;
  /** ISO-8601. An acceptance is invalid once `now >= expiry`. */
  readonly expiry: string;
  readonly compensatingControl?: string;
}

export interface ReleaseGateInput {
  readonly domainResults: readonly GateDomainResult[];
  readonly findings: readonly Finding[];
  readonly acceptances?: readonly RiskAcceptance[];
  /** Domains that MUST be reported with a result; any missing one requires human approval. */
  readonly requiredDomains?: readonly AssuranceDomain[];
  /** Whether the run's evidence bundle verified (chain of custody intact). */
  readonly evidenceBundleValid: boolean;
  readonly now: string;
}

export interface ReleaseGateResult {
  readonly decision: ReleaseDecision;
  /** Decision Ledger: ordered, human-readable WHY. */
  readonly reasons: readonly string[];
  readonly blockingFindingIds: readonly string[];
  readonly acceptedFindingIds: readonly string[];
}

const OPEN_EXCLUDED: ReadonlySet<string> = new Set([
  FindingStatus.CLOSED,
  FindingStatus.REJECTED_FALSE_POSITIVE,
]);
const KNOWN_SEVERITY: ReadonlySet<string> = new Set(Object.values(Severity));
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function isOpen(f: Finding): boolean {
  return !OPEN_EXCLUDED.has(f.status);
}

/** A risk acceptance is valid only if complete, independently approved, strictly-ISO, and unexpired. */
function acceptanceValidFor(f: Finding, acceptances: readonly RiskAcceptance[], now: string): boolean {
  const a = acceptances.find((x) => x.findingId === f.id);
  if (!a) return false;
  if (!a.reason?.trim() || !a.owner?.trim() || !a.approver?.trim()) return false;
  // No self-approval (SoD). Identities are compared in canonical form (NFKC + trim + case-fold,
  // shared with the verification/remediation engines) so neither a case variant ("Alice"/"alice")
  // nor a Unicode re-encoding of the same identity can bypass the guard.
  if (canonicalIdentity(a.owner) === canonicalIdentity(a.approver)) return false;
  if (!ISO_8601.test(a.expiry) || !ISO_8601.test(now)) return false; // reject lenient/garbage dates
  const exp = Date.parse(a.expiry);
  const t = Date.parse(now);
  if (Number.isNaN(exp) || Number.isNaN(t)) return false;
  return t < exp;
}

/**
 * The Release Gate consumes REAL assurance results and returns a fail-closed decision with a
 * decision ledger. Precedence: BLOCKED > HUMAN_APPROVAL_REQUIRED > ALLOWED_WITH_ACCEPTED_RISK
 * > ALLOWED. Only an exact PASS contributes nothing; any other/unknown domain status or finding
 * severity is treated conservatively. P0 findings are never risk-acceptable; a broken evidence
 * bundle always blocks; missing required domains / no results at all require human approval.
 */
export function evaluateRelease(input: ReleaseGateInput): ReleaseGateResult {
  const acceptances = input.acceptances ?? [];
  const reasons: string[] = [];
  const blockers: string[] = [];
  const approvals: string[] = [];
  const blockingFindingIds: string[] = [];
  const acceptedFindingIds: string[] = [];

  // 1) Evidence integrity.
  if (!input.evidenceBundleValid) {
    blockers.push("evidence");
    reasons.push("Evidence bundle failed integrity verification — release blocked.");
  }

  // 2) Domain results — only an exact PASS is a clean pass; everything else is handled.
  for (const d of input.domainResults) {
    if (d.status === GateStatus.PASS) continue;
    if (d.status === GateStatus.FAIL) {
      blockers.push(`domain:${d.domain}`);
      reasons.push(`Domain ${d.domain} FAILED.`);
    } else if (d.status === GateStatus.NOT_RUN) {
      approvals.push(`domain:${d.domain}`);
      reasons.push(`Domain ${d.domain} was NOT RUN — human approval required to release without it.`);
    } else {
      blockers.push(`domain:${d.domain}`);
      reasons.push(`Domain ${d.domain} reported an unrecognized status "${String(d.status)}" — release blocked (fail-closed).`);
    }
  }

  // 3) Completeness — required domains must be reported; zero results means nothing ran.
  const reported = new Set(input.domainResults.map((d) => d.domain));
  for (const req of input.requiredDomains ?? []) {
    if (!reported.has(req)) {
      approvals.push(`missing-domain:${req}`);
      reasons.push(`Required domain ${req} was not reported — human approval required.`);
    }
  }
  if (input.domainResults.length === 0) {
    approvals.push("no-results");
    reasons.push("No assurance domains were reported — human approval required (nothing was run).");
  }

  // 4) Open findings by severity.
  for (const f of input.findings) {
    if (!isOpen(f)) continue;
    if (!KNOWN_SEVERITY.has(f.severity)) {
      blockers.push(`finding:${f.id}`);
      blockingFindingIds.push(f.id);
      reasons.push(`Open finding ${f.id} has an unrecognized severity "${String(f.severity)}" — release blocked.`);
      continue;
    }
    if (f.severity === Severity.P0) {
      blockers.push(`finding:${f.id}`);
      blockingFindingIds.push(f.id);
      reasons.push(`Open P0 finding ${f.id} ("${f.title}") — not risk-acceptable; release blocked.`);
    } else if (f.severity === Severity.P1) {
      if (acceptanceValidFor(f, acceptances, input.now)) {
        acceptedFindingIds.push(f.id);
        reasons.push(`Open P1 finding ${f.id} covered by a valid risk acceptance.`);
      } else {
        blockers.push(`finding:${f.id}`);
        blockingFindingIds.push(f.id);
        reasons.push(`Open P1 finding ${f.id} ("${f.title}") without a valid risk acceptance — release blocked.`);
      }
    }
    // P2/P3 do not block release by default.
  }

  let decision: ReleaseDecision;
  if (blockers.length > 0) decision = ReleaseDecision.RELEASE_BLOCKED;
  else if (approvals.length > 0) decision = ReleaseDecision.HUMAN_APPROVAL_REQUIRED;
  else if (acceptedFindingIds.length > 0) decision = ReleaseDecision.RELEASE_ALLOWED_WITH_ACCEPTED_RISK;
  else decision = ReleaseDecision.RELEASE_ALLOWED;

  if (reasons.length === 0) reasons.push("All domains PASS, evidence intact, no blocking findings.");
  return { decision, reasons, blockingFindingIds, acceptedFindingIds };
}

import { canonicalIdentity, FindingStatus, type Finding } from "@uaap/core";

/**
 * Remediation lifecycle with STRICT separation of duties:
 *   detector ≠ remediator ≠ regression-validator ≠ closure-authority,
 * enforced across the WHOLE history of a finding (no role may be swapped between cycles).
 * The engine tracks an authoritative case per finding; every transition gates on the STORED
 * case state (never on caller-supplied finding.status alone), is fail-closed, binds the
 * independent-retest evidence into the CLOSED finding, and never mutates the input finding.
 */

export const CaseStatus = {
  REMEDIATION_IN_PROGRESS: "REMEDIATION_IN_PROGRESS",
  RETEST_PENDING: "RETEST_PENDING",
  CLOSED: "CLOSED",
  REOPENED: "REOPENED",
} as const;
export type CaseStatus = (typeof CaseStatus)[keyof typeof CaseStatus];

export interface RoleHistory {
  readonly remediators: readonly string[];
  readonly validators: readonly string[];
  readonly closers: readonly string[];
}

export interface RemediationCase {
  readonly findingId: string;
  readonly detectedBy: string;
  readonly remediatorId: string;
  readonly rootCause: string;
  readonly fixStrategy: string;
  readonly patchRef?: string;
  readonly validatorId?: string;
  readonly retestPassed?: boolean;
  readonly retestEvidenceIds?: readonly string[];
  readonly closerId?: string;
  readonly status: CaseStatus;
  readonly history: RoleHistory;
  readonly startedAt: string;
  readonly retestedAt?: string;
  readonly closedAt?: string;
}

export type Outcome =
  | { readonly ok: true; readonly finding: Finding; readonly case: RemediationCase }
  | { readonly ok: false; readonly reason: string };

const norm = (s: string | undefined): string => (s ?? "").trim();
/** Canonical form for SoD identity comparison: NFKC + trim + case-fold (shared platform-wide), so
 * neither a case variant nor a Unicode re-encoding of the same identity can bypass separation of
 * duties. */
const canon = (s: string | undefined): string => canonicalIdentity(s);

export class RemediationEngine {
  private readonly cases = new Map<string, RemediationCase>();

  getCase(findingId: string): RemediationCase | undefined {
    const c = this.cases.get(findingId);
    return c ? structuredClone(c) : undefined;
  }

  /**
   * Begin (or, after a failed retest, re-begin) remediation. Rejected unless there is no case
   * or the stored case is REOPENED — a replayed/stale/crafted CONFIRMED finding can never reset
   * an in-progress, validated, or closed case. On a REOPENED restart the detector identity is
   * pinned from the stored case (it cannot drift via the caller's finding).
   */
  startRemediation(input: {
    finding: Finding;
    remediatorId: string;
    rootCause: string;
    fixStrategy: string;
    patchRef?: string;
    now: string;
  }): Outcome {
    const { finding } = input;
    if (!finding?.id) return { ok: false, reason: "A finding is required." };
    const remediatorId = norm(input.remediatorId);
    if (!remediatorId) return { ok: false, reason: "remediatorId is required." };
    if (!norm(input.rootCause) || !norm(input.fixStrategy)) {
      return { ok: false, reason: "Remediation requires a root cause and a fix strategy." };
    }

    const existing = this.cases.get(finding.id);
    if (existing && existing.status !== CaseStatus.REOPENED) {
      return { ok: false, reason: `A remediation case already exists for this finding (status ${existing.status}); cannot restart.` };
    }

    // Detector is pinned from the existing case on restart; otherwise taken from the finding.
    const detectedBy = existing ? existing.detectedBy : norm(finding.detectedBy);
    if (!detectedBy) return { ok: false, reason: "Finding has no detectedBy; separation of duties cannot be established." };
    if (!existing && finding.status !== FindingStatus.CONFIRMED && finding.status !== FindingStatus.REOPENED) {
      return { ok: false, reason: `Only a CONFIRMED or REOPENED finding can enter remediation (was ${finding.status}).` };
    }
    if (canon(remediatorId) === canon(detectedBy)) {
      return { ok: false, reason: "Separation of duties: the detector cannot remediate its own finding." };
    }
    const history = existing?.history ?? { remediators: [], validators: [], closers: [] };
    // A remediator must not have served as validator or closer for this finding in any cycle.
    if (history.validators.some((v) => canon(v) === canon(remediatorId)) || history.closers.some((c) => canon(c) === canon(remediatorId))) {
      return { ok: false, reason: "Separation of duties: a prior validator/closer cannot become the remediator." };
    }

    const remCase: RemediationCase = {
      findingId: finding.id,
      detectedBy,
      remediatorId,
      rootCause: input.rootCause,
      fixStrategy: input.fixStrategy,
      patchRef: input.patchRef,
      status: CaseStatus.REMEDIATION_IN_PROGRESS,
      history: { ...history, remediators: [...new Set([...history.remediators, remediatorId])] },
      startedAt: input.now,
    };
    this.cases.set(finding.id, remCase);
    return { ok: true, finding: { ...finding, status: FindingStatus.REMEDIATION_IN_PROGRESS }, case: structuredClone(remCase) };
  }

  /** Independent regression retest. Validator ∉ {detector, any remediator, any closer}. PASS needs evidence. */
  submitRetest(input: { finding: Finding; validatorId: string; passed: boolean; evidenceIds?: readonly string[]; now: string }): Outcome {
    const { finding } = input;
    const c = this.cases.get(finding?.id ?? "");
    if (!c) return { ok: false, reason: "No remediation case for this finding." };
    if (!Array.isArray(finding.evidenceIds)) return { ok: false, reason: "Finding is malformed (missing evidenceIds)." };
    if (c.status !== CaseStatus.REMEDIATION_IN_PROGRESS) {
      return { ok: false, reason: `Retest requires a case in REMEDIATION_IN_PROGRESS (was ${c.status}).` };
    }
    const validatorId = norm(input.validatorId);
    if (!validatorId) return { ok: false, reason: "validatorId is required." };
    if (canon(validatorId) === canon(c.detectedBy)) return { ok: false, reason: "SoD: the detector cannot be the regression validator." };
    if (c.history.remediators.some((r) => canon(r) === canon(validatorId))) {
      return { ok: false, reason: "SoD: a remediator of this finding cannot validate the fix." };
    }
    if (c.history.closers.some((cl) => canon(cl) === canon(validatorId))) {
      return { ok: false, reason: "SoD: a prior closer cannot be the validator." };
    }

    if (input.passed) {
      const evidence = [...new Set((input.evidenceIds ?? []).map(norm).filter(Boolean))];
      if (evidence.length === 0) return { ok: false, reason: "A PASS retest requires at least one evidence reference." };
      const next: RemediationCase = {
        ...c,
        validatorId,
        retestPassed: true,
        retestEvidenceIds: evidence,
        status: CaseStatus.RETEST_PENDING,
        retestedAt: input.now,
        history: { ...c.history, validators: [...new Set([...c.history.validators, validatorId])] },
      };
      this.cases.set(c.findingId, next);
      const mergedEvidence = [...new Set([...finding.evidenceIds.map(norm).filter(Boolean), ...evidence])];
      return { ok: true, finding: { ...finding, status: FindingStatus.RETEST_PENDING, evidenceIds: mergedEvidence }, case: structuredClone(next) };
    }

    const next: RemediationCase = {
      ...c,
      validatorId,
      retestPassed: false,
      status: CaseStatus.REOPENED,
      retestedAt: input.now,
      history: { ...c.history, validators: [...new Set([...c.history.validators, validatorId])] },
    };
    this.cases.set(c.findingId, next);
    return { ok: true, finding: { ...finding, status: FindingStatus.REOPENED }, case: structuredClone(next) };
  }

  /** Close a finding. Needs a RETEST_PENDING case with a passing retest; closer ∉ all prior roles. */
  close(input: { finding: Finding; closerId: string; now: string }): Outcome {
    const { finding } = input;
    const c = this.cases.get(finding?.id ?? "");
    if (!c) return { ok: false, reason: "No remediation case for this finding." };
    if (!Array.isArray(finding.evidenceIds)) return { ok: false, reason: "Finding is malformed (missing evidenceIds)." };
    if (c.status !== CaseStatus.RETEST_PENDING || c.retestPassed !== true) {
      return { ok: false, reason: "Closure requires a RETEST_PENDING case with a passing retest." };
    }
    const closerId = norm(input.closerId);
    if (!closerId) return { ok: false, reason: "closerId is required." };
    const cc = canon(closerId);
    if (
      cc === canon(c.detectedBy) ||
      c.history.remediators.some((r) => canon(r) === cc) ||
      c.history.validators.some((v) => canon(v) === cc) ||
      c.history.closers.some((x) => canon(x) === cc)
    ) {
      return { ok: false, reason: "SoD: the closer must be independent of the detector, remediator(s), and validator(s)." };
    }
    const next: RemediationCase = {
      ...c,
      closerId,
      status: CaseStatus.CLOSED,
      closedAt: input.now,
      history: { ...c.history, closers: [...new Set([...c.history.closers, closerId])] },
    };
    this.cases.set(c.findingId, next);
    // Bind the authoritative independent-retest evidence into the CLOSED finding.
    const mergedEvidence = [...new Set([...finding.evidenceIds.map(norm).filter(Boolean), ...(c.retestEvidenceIds ?? [])])];
    return { ok: true, finding: { ...finding, status: FindingStatus.CLOSED, evidenceIds: mergedEvidence }, case: structuredClone(next) };
  }
}

import { FindingStatus, type Finding } from "@uaap/core";

/**
 * Remediation lifecycle with STRICT separation of duties:
 *   detector ≠ remediator ≠ regression-validator ≠ closure-authority.
 * The engine tracks a case per finding so roles filled in earlier steps are enforced against
 * later ones. Every transition is fail-closed: a wrong state or a role collision is rejected,
 * a retest PASS requires evidence, and only an independently-retested fix can be CLOSED.
 */

export const CaseStatus = {
  REMEDIATION_IN_PROGRESS: "REMEDIATION_IN_PROGRESS",
  RETEST_PENDING: "RETEST_PENDING",
  CLOSED: "CLOSED",
  REOPENED: "REOPENED",
} as const;
export type CaseStatus = (typeof CaseStatus)[keyof typeof CaseStatus];

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
}

export type Outcome<T> = { readonly ok: true; readonly finding: Finding; readonly case: RemediationCase; readonly data?: T } | { readonly ok: false; readonly reason: string };

const norm = (s: string | undefined): string => (s ?? "").trim();

export class RemediationEngine {
  private readonly cases = new Map<string, RemediationCase>();

  getCase(findingId: string): RemediationCase | undefined {
    const c = this.cases.get(findingId);
    return c ? { ...c } : undefined;
  }

  /** Begin remediation of a CONFIRMED (or REOPENED) finding. Remediator must not be the detector. */
  startRemediation(input: {
    finding: Finding;
    remediatorId: string;
    rootCause: string;
    fixStrategy: string;
    patchRef?: string;
    now: string;
  }): Outcome<never> {
    const { finding } = input;
    const remediatorId = norm(input.remediatorId);
    const detectedBy = norm(finding?.detectedBy);
    if (!finding?.id) return { ok: false, reason: "A finding is required." };
    if (!detectedBy) return { ok: false, reason: "Finding has no detectedBy; separation of duties cannot be established." };
    if (!remediatorId) return { ok: false, reason: "remediatorId is required." };
    if (finding.status !== FindingStatus.CONFIRMED && finding.status !== FindingStatus.REOPENED) {
      return { ok: false, reason: `Only a CONFIRMED or REOPENED finding can enter remediation (was ${finding.status}).` };
    }
    if (remediatorId === detectedBy) {
      return { ok: false, reason: "Separation of duties: the detector cannot remediate its own finding." };
    }
    if (!norm(input.rootCause) || !norm(input.fixStrategy)) {
      return { ok: false, reason: "Remediation requires a root cause and a fix strategy." };
    }
    const remCase: RemediationCase = {
      findingId: finding.id,
      detectedBy,
      remediatorId,
      rootCause: input.rootCause,
      fixStrategy: input.fixStrategy,
      patchRef: input.patchRef,
      status: CaseStatus.REMEDIATION_IN_PROGRESS,
    };
    this.cases.set(finding.id, remCase);
    return { ok: true, finding: { ...finding, status: FindingStatus.REMEDIATION_IN_PROGRESS }, case: { ...remCase } };
  }

  /**
   * Independent regression retest. Validator must differ from BOTH the detector and the
   * remediator. A PASS requires evidence and moves to RETEST_PENDING (awaiting closure);
   * a FAIL reopens the finding.
   */
  submitRetest(input: {
    finding: Finding;
    validatorId: string;
    passed: boolean;
    evidenceIds?: readonly string[];
    now: string;
  }): Outcome<never> {
    const { finding } = input;
    const c = this.cases.get(finding?.id ?? "");
    if (!c) return { ok: false, reason: "No remediation case for this finding." };
    if (c.status !== CaseStatus.REMEDIATION_IN_PROGRESS) {
      return { ok: false, reason: `Retest requires a case in REMEDIATION_IN_PROGRESS (was ${c.status}).` };
    }
    const validatorId = norm(input.validatorId);
    if (!validatorId) return { ok: false, reason: "validatorId is required." };
    if (validatorId === c.detectedBy) return { ok: false, reason: "SoD: the detector cannot be the regression validator." };
    if (validatorId === c.remediatorId) return { ok: false, reason: "SoD: the remediator cannot validate its own fix." };

    if (input.passed) {
      const evidence = (input.evidenceIds ?? []).map(norm).filter(Boolean);
      if (evidence.length === 0) return { ok: false, reason: "A PASS retest requires at least one evidence reference." };
      const next: RemediationCase = { ...c, validatorId, retestPassed: true, retestEvidenceIds: evidence, status: CaseStatus.RETEST_PENDING };
      this.cases.set(c.findingId, next);
      const mergedEvidence = [...new Set([...finding.evidenceIds.map(norm).filter(Boolean), ...evidence])];
      return { ok: true, finding: { ...finding, status: FindingStatus.RETEST_PENDING, evidenceIds: mergedEvidence }, case: { ...next } };
    }

    const next: RemediationCase = { ...c, validatorId, retestPassed: false, status: CaseStatus.REOPENED };
    this.cases.set(c.findingId, next);
    return { ok: true, finding: { ...finding, status: FindingStatus.REOPENED }, case: { ...next } };
  }

  /**
   * Close a finding. Requires a RETEST_PENDING case with a passing independent retest, and a
   * closer distinct from the detector, remediator, and validator (closure is independent).
   */
  close(input: { finding: Finding; closerId: string; now: string }): Outcome<never> {
    const { finding } = input;
    const c = this.cases.get(finding?.id ?? "");
    if (!c) return { ok: false, reason: "No remediation case for this finding." };
    if (c.status !== CaseStatus.RETEST_PENDING || c.retestPassed !== true) {
      return { ok: false, reason: "Closure requires a RETEST_PENDING case with a passing retest." };
    }
    const closerId = norm(input.closerId);
    if (!closerId) return { ok: false, reason: "closerId is required." };
    if (closerId === c.detectedBy || closerId === c.remediatorId || closerId === c.validatorId) {
      return { ok: false, reason: "SoD: the closer must be independent of the detector, remediator, and validator." };
    }
    const next: RemediationCase = { ...c, closerId, status: CaseStatus.CLOSED };
    this.cases.set(c.findingId, next);
    return { ok: true, finding: { ...finding, status: FindingStatus.CLOSED }, case: { ...next } };
  }
}

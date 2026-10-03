import { FindingStatus, type Finding } from "@uaap/core";

export const Verdict = { CONFIRM: "CONFIRM", REJECT: "REJECT" } as const;
export type Verdict = (typeof Verdict)[keyof typeof Verdict];

export interface VerificationInput {
  readonly finding: Finding;
  /** The verifier. MUST differ from finding.detectedBy (separation of duties). */
  readonly verifierId: string;
  readonly verdict: Verdict;
  /** Evidence backing a CONFIRM. At least one non-blank id is required to confirm. */
  readonly evidenceIds?: readonly string[];
  readonly now: string;
}

export type VerificationResult =
  | { readonly ok: true; readonly finding: Finding; readonly verifiedBy: string; readonly verifiedAt: string }
  | { readonly ok: false; readonly reason: string };

/** Finding states that are eligible for verification (not already resolved). */
const VERIFIABLE: ReadonlySet<string> = new Set([
  FindingStatus.SIGNAL,
  FindingStatus.HYPOTHESIS,
  FindingStatus.VALIDATION_PENDING,
  FindingStatus.REOPENED,
]);

/**
 * Independent verification engine. Enforces separation of duties (the detector cannot verify
 * its own finding) and evidence-backed confirmation (a finding is never CONFIRMED without
 * evidence). It never CLOSES a finding — closure is a separate authority (the release gate).
 * SoD is compared on NORMALIZED (trimmed) identities so cosmetic variants cannot bypass it,
 * and a finding whose detector is unknown is rejected because SoD cannot be established.
 */
export class VerificationEngine {
  verify(input: VerificationInput): VerificationResult {
    const { finding, verdict } = input;
    const verifierId = input.verifierId?.trim();
    if (!verifierId) return { ok: false, reason: "verifierId is required." };
    if (!finding || !finding.id) return { ok: false, reason: "A finding is required." };
    if (!Array.isArray(finding.evidenceIds)) {
      return { ok: false, reason: "Finding is malformed (missing evidenceIds)." };
    }
    const detectedBy = finding.detectedBy?.trim();
    if (!detectedBy) {
      return { ok: false, reason: "Finding has no detectedBy; separation of duties cannot be established." };
    }
    // Canonical (case-insensitive) identity comparison so a case variant cannot bypass SoD.
    if (verifierId.toLowerCase() === detectedBy.toLowerCase()) {
      return { ok: false, reason: "Separation of duties: the detector cannot verify its own finding." };
    }
    if (!VERIFIABLE.has(finding.status)) {
      return { ok: false, reason: `Finding in status ${finding.status} is not eligible for verification.` };
    }

    if (verdict === Verdict.CONFIRM) {
      const evidence = (input.evidenceIds ?? []).map((e) => e?.trim()).filter((e): e is string => !!e);
      if (evidence.length === 0) {
        return { ok: false, reason: "A finding cannot be CONFIRMED without at least one evidence reference." };
      }
      const merged = [...new Set([...finding.evidenceIds.map((e) => e.trim()).filter(Boolean), ...evidence])];
      return {
        ok: true,
        finding: { ...finding, status: FindingStatus.CONFIRMED, evidenceIds: merged },
        verifiedBy: verifierId,
        verifiedAt: input.now,
      };
    }

    if (verdict === Verdict.REJECT) {
      return {
        ok: true,
        finding: { ...finding, status: FindingStatus.REJECTED_FALSE_POSITIVE },
        verifiedBy: verifierId,
        verifiedAt: input.now,
      };
    }

    return { ok: false, reason: `Unknown verdict "${String(verdict)}".` };
  }
}

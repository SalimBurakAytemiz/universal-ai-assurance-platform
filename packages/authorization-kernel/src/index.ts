import {
  ActionClass,
  Decision,
  DecisionReason,
  Mode,
  type ActionRequest,
  type AuthorizationRecord,
  type DecisionResult,
} from "@uaap/core";

/**
 * Structural interface for an optional policy-as-code AND-gate. The policy engine
 * can only further RESTRICT a request; it can never grant something the kernel denied.
 */
export interface PolicyEvaluator {
  evaluate(request: ActionRequest): {
    readonly allow: boolean;
    readonly ruleId: string;
    readonly explanation: string;
  };
}

export interface KernelConfig {
  /** Authorization records currently in effect (loaded from persistent state). */
  readonly authorizations: readonly AuthorizationRecord[];
  /** The set of action names the platform knows how to perform. Unknown ⇒ DENY. */
  readonly knownActions: ReadonlySet<string>;
  /** Optional policy-as-code gate applied AFTER the kernel's own gates pass. */
  readonly policy?: PolicyEvaluator;
}

/** Numeric rank for action classes so ceilings can be compared. R3 is prohibited outright. */
const ACTION_RANK: Record<ActionClass, number> = {
  [ActionClass.R0_PASSIVE]: 0,
  [ActionClass.R1_LOW_IMPACT]: 1,
  [ActionClass.R2_ELEVATED]: 2,
  [ActionClass.R3_PROHIBITED]: 3,
};

/**
 * The fail-closed Trust Kernel.
 *
 * Contract: `decide` returns ALLOW only if EVERY gate passes. Any missing,
 * ambiguous, out-of-scope, unknown, prohibited, or policy-denied condition
 * resolves to DENY (or HUMAN_APPROVAL_REQUIRED for elevated actions). There is
 * no code path that returns ALLOW by default.
 */
export class AuthorizationKernel {
  constructor(private readonly config: KernelConfig) {}

  decide(request: ActionRequest): DecisionResult {
    const evaluated: string[] = [];
    const deny = (reason: DecisionReason, explanation: string): DecisionResult =>
      this.result(request, Decision.DENY, reason, explanation, evaluated);
    const needApproval = (reason: DecisionReason, explanation: string): DecisionResult =>
      this.result(request, Decision.HUMAN_APPROVAL_REQUIRED, reason, explanation, evaluated);

    // Gate 0: structural sanity. A malformed request is ambiguous ⇒ deny.
    evaluated.push("G0_STRUCTURE");
    if (!request || !request.target || !request.action) {
      return deny(DecisionReason.AMBIGUOUS_TARGET, "Request is missing target or action.");
    }
    if (!isKnownMode(request.mode)) {
      return deny(DecisionReason.DEFAULT_DENY, `Unknown mode "${String(request.mode)}".`);
    }

    // Gate 1: action must be known, and never of the prohibited class.
    evaluated.push("G1_ACTION_KNOWN");
    if (request.actionClass === ActionClass.R3_PROHIBITED) {
      return deny(
        DecisionReason.PROHIBITED_ACTION_CLASS,
        `Action "${request.action}" is in the prohibited baseline class and is denied by default.`,
      );
    }
    if (ACTION_RANK[request.actionClass] === undefined) {
      return deny(DecisionReason.UNKNOWN_ACTION, `Unknown action class for "${request.action}".`);
    }
    if (!this.config.knownActions.has(request.action)) {
      return deny(DecisionReason.UNKNOWN_ACTION, `Action "${request.action}" is not a known action.`);
    }

    // Gate 2: target must be unambiguous.
    evaluated.push("G2_TARGET_UNAMBIGUOUS");
    if (!request.target.id || request.target.identifiers.length === 0) {
      return deny(DecisionReason.AMBIGUOUS_TARGET, "Target has no id or no identifiers.");
    }

    const isPassive = request.actionClass === ActionClass.R0_PASSIVE;

    // Passive actions (R0) are public/metadata only and do not require an authorization
    // record, but PROSPECT_PASSIVE mode may ONLY ever perform passive actions.
    if (request.mode === Mode.PROSPECT_PASSIVE && !isPassive) {
      evaluated.push("G3_PROSPECT_PASSIVE_ONLY");
      return deny(
        DecisionReason.AUTHORIZATION_MISSING,
        "PROSPECT_PASSIVE mode permits passive (R0) actions only; active validation requires an authorized client target.",
      );
    }

    if (!isPassive) {
      // Gate 3: a matching, valid authorization record is mandatory for any active action.
      evaluated.push("G3_AUTHORIZATION");
      const auth = this.config.authorizations.find(
        (a) => a.targetId === request.target.id && a.mode === request.mode,
      );
      if (!auth) {
        return deny(
          DecisionReason.AUTHORIZATION_MISSING,
          `No authorization record for target "${request.target.id}" in mode ${request.mode}.`,
        );
      }

      // Gate 4: time window.
      evaluated.push("G4_TIME_WINDOW");
      const now = Date.parse(request.now);
      const from = Date.parse(auth.notBefore);
      const until = Date.parse(auth.notAfter);
      if (Number.isNaN(now) || Number.isNaN(from) || Number.isNaN(until)) {
        return deny(DecisionReason.AMBIGUOUS_SCOPE, "Authorization or request has an invalid timestamp.");
      }
      if (now < from || now >= until) {
        return deny(
          DecisionReason.AUTHORIZATION_EXPIRED,
          `Request time ${request.now} is outside the authorization window [${auth.notBefore}, ${auth.notAfter}).`,
        );
      }

      // Gate 5: scope — every target identifier must be explicitly covered.
      evaluated.push("G5_SCOPE");
      const covered = new Set(auth.allowedIdentifiers);
      const uncovered = request.target.identifiers.filter((id) => !covered.has(id));
      if (uncovered.length > 0) {
        return deny(
          DecisionReason.OUT_OF_SCOPE,
          `Target identifier(s) not in authorized scope: ${uncovered.join(", ")}.`,
        );
      }
      if (!auth.allowedDomains.includes(request.domain)) {
        return deny(DecisionReason.OUT_OF_SCOPE, `Domain ${request.domain} is not in the authorized scope.`);
      }

      // Gate 6: environment.
      evaluated.push("G6_ENVIRONMENT");
      if (!auth.allowedEnvironments.includes(request.environment)) {
        return deny(
          DecisionReason.ENVIRONMENT_FORBIDDEN,
          `Environment ${request.environment} is not authorized for this target.`,
        );
      }

      // Gate 7: action-class ceiling + elevated-approval requirement.
      evaluated.push("G7_ACTION_CEILING");
      if (ACTION_RANK[request.actionClass] > ACTION_RANK[auth.maxActionClass]) {
        return deny(
          DecisionReason.OUT_OF_SCOPE,
          `Action class ${request.actionClass} exceeds the authorized ceiling ${auth.maxActionClass}.`,
        );
      }
      if (request.actionClass === ActionClass.R2_ELEVATED && !request.approvalToken) {
        return needApproval(
          DecisionReason.ELEVATED_REQUIRES_APPROVAL,
          "Elevated (R2) actions require an explicit per-action human approval token.",
        );
      }

      // Gate 8: data policy — restricted data with non-minimal access needs INTERNAL_OWNED.
      evaluated.push("G8_DATA_POLICY");
      if (
        request.dataPolicy.maxClassification === "RESTRICTED" &&
        !request.dataPolicy.minimalProofOfAccessOnly &&
        request.mode !== Mode.INTERNAL_OWNED
      ) {
        return deny(
          DecisionReason.DATA_POLICY_VIOLATION,
          "Full access to RESTRICTED data is only permitted on internally owned targets; use minimal proof-of-access.",
        );
      }
    }

    // Gate 9: policy-as-code AND-gate. Can only further restrict.
    if (this.config.policy) {
      evaluated.push("G9_POLICY");
      const verdict = this.config.policy.evaluate(request);
      evaluated.push(`policy:${verdict.ruleId}`);
      if (!verdict.allow) {
        return deny(DecisionReason.POLICY_DENY, verdict.explanation);
      }
    }

    evaluated.push("ALLOW");
    return this.result(
      request,
      Decision.ALLOW,
      DecisionReason.OK,
      isPassive
        ? `Passive action "${request.action}" permitted.`
        : `Action "${request.action}" permitted within authorized scope.`,
      evaluated,
    );
  }

  private result(
    request: ActionRequest,
    decision: Decision,
    reason: DecisionReason,
    explanation: string,
    evaluated: readonly string[],
  ): DecisionResult {
    return {
      requestId: request.requestId,
      decision,
      reason,
      explanation,
      evaluated: [...evaluated],
      decidedAt: request.now,
    };
  }
}

function isKnownMode(mode: unknown): mode is Mode {
  return mode === Mode.PROSPECT_PASSIVE || mode === Mode.CLIENT_AUTHORIZED || mode === Mode.INTERNAL_OWNED;
}

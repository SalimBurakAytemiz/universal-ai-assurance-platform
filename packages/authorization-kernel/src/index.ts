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
  /**
   * The authoritative catalog of action names the platform knows how to perform, mapped to each
   * action's TRUE (canonical) risk class. Unknown action ⇒ DENY. The canonical class is the trusted
   * source of an action's risk — it is NOT taken from the caller-supplied `request.actionClass`
   * (which an agent could set to R0_PASSIVE to skip the authorization gates). The effective class is
   * the STRICTER of the caller's declared class and this canonical class, so a target-touching action
   * can never be downgraded onto the passive (no-authorization) path. Built from the tool-adapter
   * registry's per-action `riskClass`.
   */
  readonly knownActions: ReadonlyMap<string, ActionClass>;
  /** Optional policy-as-code gate applied AFTER the kernel's own gates pass. */
  readonly policy?: PolicyEvaluator;
  /**
   * Trusted wall-clock source (epoch ms) for authorization-window decisions. Defaults to the real
   * clock. The window is evaluated against THIS, never against the caller-supplied `request.now`
   * (which an agent could backdate to revive an expired authorization). Injectable for deterministic
   * tests.
   */
  readonly clock?: () => number;
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
  private readonly clock: () => number;
  constructor(private readonly config: KernelConfig) {
    this.clock = config.clock ?? (() => Date.now());
  }

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
    const canonicalClass = this.config.knownActions.get(request.action);
    if (canonicalClass === undefined) {
      return deny(DecisionReason.UNKNOWN_ACTION, `Action "${request.action}" is not a known action.`);
    }
    // The action's canonical class is prohibited: deny outright (the catalog, not the caller, decides).
    if (canonicalClass === ActionClass.R3_PROHIBITED) {
      return deny(
        DecisionReason.PROHIBITED_ACTION_CLASS,
        `Action "${request.action}" is a prohibited-class action and is denied by default.`,
      );
    }
    // EFFECTIVE class = the STRICTER (higher-ranked) of the caller-declared class and the trusted
    // canonical class. A caller can voluntarily escalate scrutiny, but can NEVER downgrade a
    // target-touching action onto the passive path by self-asserting a lower class. This is the
    // fix for the "declare R0_PASSIVE to skip every authorization gate" bypass: isPassive and every
    // class-sensitive gate below are driven by the catalog, not by the untrusted request field.
    const effectiveClass =
      ACTION_RANK[request.actionClass] >= ACTION_RANK[canonicalClass] ? request.actionClass : canonicalClass;

    // Gate 2: target must be unambiguous, and its declared environment must be internally consistent
    // with the request's environment (a request claiming STAGING against a PRODUCTION target is an
    // ambiguity that must fail closed — otherwise the environment guards can be deceived).
    evaluated.push("G2_TARGET_UNAMBIGUOUS");
    if (!request.target.id || request.target.identifiers.length === 0) {
      return deny(DecisionReason.AMBIGUOUS_TARGET, "Target has no id or no identifiers.");
    }
    if (!request.environment || !request.target.environment) {
      return deny(DecisionReason.AMBIGUOUS_SCOPE, "Request or target is missing an environment.");
    }
    if (request.environment !== request.target.environment) {
      return deny(
        DecisionReason.AMBIGUOUS_SCOPE,
        `Request environment ${request.environment} contradicts the target's declared environment ${request.target.environment}.`,
      );
    }

    const isPassive = effectiveClass === ActionClass.R0_PASSIVE;

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

      // Gate 4: time window — evaluated against the TRUSTED clock, never the caller-supplied
      // request.now (which an agent could backdate to revive an expired authorization).
      evaluated.push("G4_TIME_WINDOW");
      const now = this.clock();
      const from = Date.parse(auth.notBefore);
      const until = Date.parse(auth.notAfter);
      if (Number.isNaN(now) || Number.isNaN(from) || Number.isNaN(until)) {
        return deny(DecisionReason.AMBIGUOUS_SCOPE, "Authorization or request has an invalid timestamp.");
      }
      if (now < from || now >= until) {
        return deny(
          DecisionReason.AUTHORIZATION_EXPIRED,
          `Current time is outside the authorization window [${auth.notBefore}, ${auth.notAfter}).`,
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

      // Gate 7: action-class ceiling + elevated-approval requirement. Uses the EFFECTIVE class.
      evaluated.push("G7_ACTION_CEILING");
      if (ACTION_RANK[effectiveClass] > ACTION_RANK[auth.maxActionClass]) {
        return deny(
          DecisionReason.OUT_OF_SCOPE,
          `Action class ${effectiveClass} exceeds the authorized ceiling ${auth.maxActionClass}.`,
        );
      }
      if (effectiveClass === ActionClass.R2_ELEVATED && !request.approvalToken) {
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

    // Gate 9: policy-as-code AND-gate. Can only further restrict. The policy is evaluated against the
    // EFFECTIVE class so a mislabeled action cannot match a passive-only allow rule by self-assertion.
    if (this.config.policy) {
      evaluated.push("G9_POLICY");
      const policyRequest =
        effectiveClass === request.actionClass ? request : { ...request, actionClass: effectiveClass };
      const verdict = this.config.policy.evaluate(policyRequest);
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
      // Stamp the decision with the TRUSTED clock, not the caller-supplied request.now — otherwise an
      // agent could write an arbitrary decision time into the tamper-evident audit ledger.
      decidedAt: new Date(this.clock()).toISOString(),
    };
  }
}

function isKnownMode(mode: unknown): mode is Mode {
  return mode === Mode.PROSPECT_PASSIVE || mode === Mode.CLIENT_AUTHORIZED || mode === Mode.INTERNAL_OWNED;
}

import { Decision, newId, type ActionRequest, type DecisionResult } from "@uaap/core";
import { AuthorizationKernel } from "@uaap/authorization-kernel";
import { AuditLedger, AuditEventType } from "@uaap/audit";

/**
 * A deterministic/external execution adapter. Adapters are the ONLY code that touches a
 * target, and they are held privately by the broker. Nothing hands an adapter to an agent.
 */
export interface TargetAdapter {
  /** Capability id, e.g. "http.readonly", "db.readonly", "git". */
  readonly capability: string;
  /** Whether this adapter can perform a given action name. */
  supports(action: string): boolean;
  /** Perform the action. Must not be reachable except via ToolBroker.execute. */
  execute(request: ActionRequest): Promise<AdapterResult> | AdapterResult;
}

export interface AdapterResult {
  readonly output: unknown;
  /** Reference to a stored evidence artifact, if any (no raw secrets). */
  readonly evidenceRef?: string;
}

/** A short-lived, scoped grant to use a capability for one run. */
export interface ToolLease {
  readonly id: string;
  readonly runId: string;
  readonly targetId: string;
  readonly capability: string;
  readonly scope: readonly string[];
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface BrokerResult {
  readonly ok: boolean;
  readonly decision: DecisionResult;
  readonly output?: unknown;
  readonly evidenceRef?: string;
  readonly reason?: string;
}

export interface ToolBrokerDeps {
  readonly kernel: AuthorizationKernel;
  readonly audit: AuditLedger;
  /** Adapters keyed by capability id. Kept private to the broker. */
  readonly adapters: ReadonlyMap<string, TargetAdapter>;
  /**
   * Trusted wall-clock source (epoch ms) for lease-expiry decisions. Defaults to the real clock.
   * Expiry is evaluated against THIS, never the caller-supplied request.now (which an agent could
   * backdate to keep using an expired lease). Injectable for deterministic tests.
   */
  readonly clock?: () => number;
}

/**
 * The Tool Broker. Every target-touching action is funneled here. For each request it:
 *  1. checks the presented lease is valid, unexpired, and in scope;
 *  2. asks the Authorization Kernel (which applies policy) and records the decision;
 *  3. executes via the matching adapter ONLY if the decision is ALLOW.
 * There is no path to an adapter that bypasses the kernel.
 */
export class ToolBroker {
  private readonly leases = new Map<string, ToolLease>();
  private readonly clock: () => number;
  constructor(private readonly deps: ToolBrokerDeps) {
    this.clock = deps.clock ?? (() => Date.now());
  }

  issueLease(input: {
    runId: string;
    targetId: string;
    capability: string;
    scope: readonly string[];
    issuedAt: string;
    expiresAt: string;
  }): ToolLease {
    const lease: ToolLease = { id: newId("LEASE"), ...input, scope: [...input.scope] };
    this.leases.set(lease.id, lease);
    // Audit `at` is stamped from the TRUSTED clock, never a caller-supplied time, so the tamper-evident
    // ledger's event times cannot be forged by an agent. (The lease's own issuedAt field remains the
    // declared lease metadata; expiry is enforced against the trusted clock in execute().)
    this.deps.audit.append(AuditEventType.LEASE_ISSUED, "tool-broker", lease, this.nowIso());
    return lease;
  }

  // `at` is accepted for backward compatibility but intentionally NOT used for the audit timestamp —
  // the ledger `at` is the trusted clock (see nowIso), not a caller-supplied value.
  revokeLease(leaseId: string, _at?: string): void {
    const lease = this.leases.get(leaseId);
    if (lease) {
      this.leases.delete(leaseId);
      this.deps.audit.append(AuditEventType.LEASE_REVOKED, "tool-broker", { leaseId }, this.nowIso());
    }
  }

  revokeAll(at: string): void {
    for (const id of [...this.leases.keys()]) this.revokeLease(id, at);
  }

  async execute(leaseId: string, request: ActionRequest): Promise<BrokerResult> {
    // 1) Lease validation.
    const lease = this.leases.get(leaseId);
    if (!lease) return this.deny(request, "No such lease (expired or never issued).");
    if (lease.runId !== request.runId) return this.deny(request, "Lease does not belong to this run.");
    if (lease.targetId !== request.target.id) return this.deny(request, "Lease target does not match request target.");
    // Expiry is checked against the TRUSTED clock, not the caller-supplied request.now.
    if (this.clock() >= Date.parse(lease.expiresAt)) {
      this.revokeLease(leaseId, request.now);
      return this.deny(request, "Lease has expired.");
    }
    // Lease scope is ENFORCED (not merely stored): every requested target identifier must fall
    // within the lease's declared scope. This makes a per-run scope-narrowing real — a lease issued
    // for a subset of the broad authorization cannot be used against identifiers outside that subset.
    const leaseScope = new Set(lease.scope);
    const outOfScope = request.target.identifiers.filter((id) => !leaseScope.has(id));
    if (outOfScope.length > 0) {
      return this.deny(request, `Target identifier(s) outside the lease scope: ${outOfScope.join(", ")}.`);
    }

    // 2) Kernel decision (applies policy). Always recorded.
    const decision = this.deps.kernel.decide(request);
    this.deps.audit.recordDecision(request.requestedBy, decision);
    if (decision.decision !== Decision.ALLOW) {
      return { ok: false, decision, reason: decision.explanation };
    }

    // 3) Adapter execution — only after ALLOW.
    const adapter = this.deps.adapters.get(lease.capability);
    if (!adapter || !adapter.supports(request.action)) {
      return { ok: false, decision, reason: `No adapter for capability "${lease.capability}" / action "${request.action}".` };
    }
    // A misbehaving adapter must not reject the broker call unexpectedly: record and return a failure.
    let result: AdapterResult;
    try {
      result = await adapter.execute(request);
    } catch (e) {
      // Derive the message defensively: an adapter may `throw null`/`throw undefined`, and
      // reading `.message` on that would itself throw inside the catch and re-reject the call.
      const msg = e instanceof Error ? e.message : String(e);
      const reason = `Adapter "${lease.capability}" threw during "${request.action}": ${msg}`;
      this.deps.audit.append(
        AuditEventType.TOOL_EXECUTION,
        request.requestedBy,
        { action: request.action, capability: lease.capability, error: reason },
        this.nowIso(),
      );
      return { ok: false, decision, reason };
    }
    this.deps.audit.append(
      AuditEventType.TOOL_EXECUTION,
      request.requestedBy,
      { action: request.action, capability: lease.capability, evidenceRef: result.evidenceRef },
      this.nowIso(),
    );
    return { ok: true, decision, output: result.output, evidenceRef: result.evidenceRef };
  }

  /** Trusted decision/record timestamp (ISO) — never the caller-supplied request.now. */
  private nowIso(): string {
    return new Date(this.clock()).toISOString();
  }

  private deny(request: ActionRequest, reason: string): BrokerResult {
    const decision: DecisionResult = {
      requestId: request.requestId,
      decision: Decision.DENY,
      reason: "DEFAULT_DENY",
      explanation: reason,
      evaluated: ["BROKER_LEASE_CHECK"],
      decidedAt: this.nowIso(),
    };
    this.deps.audit.recordDecision("tool-broker", decision);
    return { ok: false, decision, reason };
  }
}

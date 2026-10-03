import type { ActionRequest } from "@uaap/core";
import { AuditLedger, AuditEventType } from "@uaap/audit";
import { ToolBroker, type BrokerResult } from "@uaap/tool-broker";

/**
 * The Unified Orchestrator. It is the single entry point an agent uses to request work
 * against a target. It owns the Tool Broker; agents receive an Orchestrator handle and
 * NEVER receive a broker, a kernel, or an adapter. The mandatory path is therefore:
 *
 *   Agent → Orchestrator → (Kernel + Policy, inside the Broker) → Tool Broker → Adapter → Target
 *
 * A direct Agent → Target call is structurally impossible through this API surface.
 */
export class Orchestrator {
  constructor(
    private readonly broker: ToolBroker,
    private readonly audit: AuditLedger,
  ) {}

  /** Begin a run and record it. Returns a lightweight run handle. */
  startRun(runId: string, now: string): { runId: string } {
    this.audit.append(AuditEventType.STATE_CHANGE, "orchestrator", { event: "RUN_STARTED", runId }, now);
    return { runId };
  }

  /** Issue a scoped, expiring tool lease for a run (delegated to the broker). */
  issueLease(input: {
    runId: string;
    targetId: string;
    capability: string;
    scope: readonly string[];
    issuedAt: string;
    expiresAt: string;
  }) {
    return this.broker.issueLease(input);
  }

  /** Dispatch a single action request through the full decision pipeline. */
  async dispatch(leaseId: string, request: ActionRequest): Promise<BrokerResult> {
    return this.broker.execute(leaseId, request);
  }

  /** Convenience: issue a short lease, dispatch one action, then revoke the lease. */
  async runSingle(
    request: ActionRequest,
    capability: string,
    expiresAt: string,
  ): Promise<BrokerResult> {
    const lease = this.issueLease({
      runId: request.runId,
      targetId: request.target.id,
      capability,
      scope: request.target.identifiers,
      issuedAt: request.now,
      expiresAt,
    });
    try {
      return await this.dispatch(lease.id, request);
    } finally {
      this.broker.revokeLease(lease.id, request.now);
    }
  }
}

export { ToolBroker } from "@uaap/tool-broker";
export type { TargetAdapter, AdapterResult, BrokerResult, ToolLease } from "@uaap/tool-broker";

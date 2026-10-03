import { hashObject, type DecisionResult } from "@uaap/core";

export const AuditEventType = {
  DECISION: "DECISION",
  APPROVAL: "APPROVAL",
  TOOL_EXECUTION: "TOOL_EXECUTION",
  LEASE_ISSUED: "LEASE_ISSUED",
  LEASE_REVOKED: "LEASE_REVOKED",
  STATE_CHANGE: "STATE_CHANGE",
} as const;
export type AuditEventType = (typeof AuditEventType)[keyof typeof AuditEventType];

export interface AuditEntry {
  readonly seq: number;
  readonly at: string;
  readonly type: AuditEventType;
  /** Component/agent/human that caused the event. */
  readonly actor: string;
  /** JSON-serializable payload (no secrets). */
  readonly payload: unknown;
  /** Hash of the previous entry ("" for the genesis entry). */
  readonly prevHash: string;
  /** SHA-256 over {seq, at, type, actor, payload, prevHash}. */
  readonly hash: string;
}

export interface AuditSink {
  write(entry: AuditEntry): void;
}

/**
 * Append-only, tamper-evident decision ledger. Each entry's hash includes the previous
 * entry's hash, so any later modification breaks the chain and `verify()` detects it.
 * Entries are frozen; there is no public mutation or delete path.
 */
export class AuditLedger {
  private readonly entries: AuditEntry[] = [];
  private readonly sinks: AuditSink[];

  constructor(sinks: AuditSink[] = []) {
    this.sinks = sinks;
  }

  append(type: AuditEventType, actor: string, payload: unknown, at: string): AuditEntry {
    const seq = this.entries.length;
    const prevHash = seq === 0 ? "" : (this.entries[seq - 1] as AuditEntry).hash;
    const core = { seq, at, type, actor, payload, prevHash };
    const hash = hashObject(core);
    const entry: AuditEntry = Object.freeze({ ...core, hash });
    this.entries.push(entry);
    for (const sink of this.sinks) sink.write(entry);
    return entry;
  }

  /** Convenience: record a kernel/policy decision. */
  recordDecision(actor: string, decision: DecisionResult): AuditEntry {
    return this.append(AuditEventType.DECISION, actor, decision, decision.decidedAt);
  }

  list(): readonly AuditEntry[] {
    return [...this.entries];
  }

  /** Recompute the chain and confirm no entry was altered, inserted, or removed. */
  verify(): { ok: true } | { ok: false; brokenAt: number; reason: string } {
    let prevHash = "";
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i] as AuditEntry;
      if (e.seq !== i) return { ok: false, brokenAt: i, reason: `seq mismatch: expected ${i}, got ${e.seq}` };
      if (e.prevHash !== prevHash) return { ok: false, brokenAt: i, reason: "prevHash does not match prior entry" };
      const recomputed = hashObject({
        seq: e.seq,
        at: e.at,
        type: e.type,
        actor: e.actor,
        payload: e.payload,
        prevHash: e.prevHash,
      });
      if (recomputed !== e.hash) return { ok: false, brokenAt: i, reason: "entry hash does not match contents" };
      prevHash = e.hash;
    }
    return { ok: true };
  }
}

/** A sink that appends each entry as a JSON line to an array (e.g. for file persistence). */
export class MemoryArraySink implements AuditSink {
  readonly lines: string[] = [];
  write(entry: AuditEntry): void {
    this.lines.push(JSON.stringify(entry));
  }
}

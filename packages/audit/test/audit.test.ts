import { describe, it, expect } from "vitest";
import { AuditLedger, AuditEventType, MemoryArraySink, type AuditEntry } from "@uaap/audit";

const T = "2026-10-03T12:00:00.000Z";

describe("AuditLedger — tamper-evident hash chain", () => {
  it("links entries and verifies an intact chain", () => {
    const sink = new MemoryArraySink();
    const ledger = new AuditLedger([sink]);
    ledger.append(AuditEventType.DECISION, "kernel", { decision: "ALLOW" }, T);
    ledger.append(AuditEventType.TOOL_EXECUTION, "broker", { action: "http.readonly.get" }, T);
    ledger.append(AuditEventType.STATE_CHANGE, "orchestrator", { node: "core" }, T);

    expect(ledger.list()).toHaveLength(3);
    expect(sink.lines).toHaveLength(3);
    expect(ledger.verify()).toEqual({ ok: true });
    expect(ledger.list()[0]!.prevHash).toBe("");
    expect(ledger.list()[1]!.prevHash).toBe(ledger.list()[0]!.hash);
  });

  it("detects tampering with a committed entry", () => {
    const ledger = new AuditLedger();
    ledger.append(AuditEventType.DECISION, "kernel", { decision: "DENY" }, T);
    ledger.append(AuditEventType.DECISION, "kernel", { decision: "ALLOW" }, T);

    // Reach past the frozen public API to simulate a storage-layer tamper.
    const internal = ledger.list() as AuditEntry[];
    const forged = { ...internal[0]!, payload: { decision: "ALLOW" } };
    // Bracket access to a private field (TS escape hatch) to simulate a storage-layer tamper.
    (ledger["entries"] as AuditEntry[])[0] = forged;

    const result = ledger.verify();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.brokenAt).toBe(0);
  });

  it("freezes entries (no in-place field mutation)", () => {
    const ledger = new AuditLedger();
    const entry = ledger.append(AuditEventType.APPROVAL, "human:salim", { token: "ref" }, T);
    expect(() => {
      // @ts-expect-error — testing runtime immutability.
      entry.actor = "someone-else";
    }).toThrow();
  });
});

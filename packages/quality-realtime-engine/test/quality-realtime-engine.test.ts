import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { driveEngine, EngineStatus, type EngineContext } from "@uaap/engine-core";
import { QualityRealtimeEngine, type RealtimeEngineInput } from "@uaap/quality-realtime-engine";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, "..", "fixtures", "orders-stream.json"), "utf8")) as RealtimeEngineInput;

let t = 0;
function ctx(input: unknown): EngineContext {
  return { runId: "RUN-RT", input, now: () => new Date(Date.UTC(2026, 9, 6, 0, 0, t++)).toISOString() };
}
const drive = (input: unknown) => driveEngine(new QualityRealtimeEngine(), ctx(input));
const kinds = (fs: readonly { kind: string }[]) => new Set(fs.map((f) => f.kind));

describe("QualityRealtimeEngine — stream validation against the local fixture", () => {
  it("drives to DONE and detects every planted violation class", async () => {
    const r = await drive(fixture);
    expect(r.status).toBe(EngineStatus.DONE);
    const k = kinds(r.findings);
    for (const expected of ["payload-contract-violation", "payload-schema-drift", "missing-message-header", "unacked-message", "ordering-violation", "unknown-event-type"]) {
      expect(k, expected).toContain(expected);
    }
  });

  it("a fully-conformant, in-order, acked stream yields DONE with zero findings — a REAL pass", async () => {
    const clean: RealtimeEngineInput = {
      contracts: { channels: [{ name: "c", ordering: "total", requireAck: true, events: [{ type: "e", schema: { type: "object", required: ["id"], properties: { id: { type: "integer" } } } }] }] },
      streams: { c: [{ type: "e", seq: 1, payload: { id: 1 }, acked: true }, { type: "e", seq: 2, payload: { id: 2 }, acked: true }] },
    };
    const r = await drive(clean);
    expect(r.status).toBe(EngineStatus.DONE);
    expect(r.findings).toHaveLength(0);
  });

  it("detects a duplicate sequence number (total ordering)", async () => {
    const input: RealtimeEngineInput = {
      contracts: { channels: [{ name: "c", ordering: "total", events: [{ type: "e" }] }] },
      streams: { c: [{ type: "e", seq: 1 }, { type: "e", seq: 1 }] },
    };
    expect(kinds((await drive(input)).findings)).toContain("duplicate-sequence");
  });

  it("per-key ordering: a within-key regression is caught, cross-key interleaving is fine", async () => {
    const input: RealtimeEngineInput = {
      contracts: { channels: [{ name: "c", ordering: "per-key", orderKey: "key", events: [{ type: "e" }] }] },
      streams: {
        c: [
          { type: "e", key: "A", seq: 1 },
          { type: "e", key: "B", seq: 1 }, // different key, seq resets — OK
          { type: "e", key: "A", seq: 3 },
          { type: "e", key: "A", seq: 2 }, // within key A: 2 <= 3 -> violation
        ],
      },
    };
    const r = await drive(input);
    const ordering = r.findings.filter((f) => f.kind === "ordering-violation");
    expect(ordering).toHaveLength(1);
  });

  it("fails closed on an unrecognized ordering mode", async () => {
    const input = { contracts: { channels: [{ name: "c", ordering: "weird", events: [{ type: "e" }] }] }, streams: { c: [{ type: "e" }] } };
    expect(kinds((await drive(input)).findings)).toContain("unknown-ordering-mode");
  });

  it("isolates a malformed message and still checks the rest", async () => {
    const input = {
      contracts: { channels: [{ name: "c", ordering: "total", events: [{ type: "e" }] }] },
      streams: { c: [{ type: "e", seq: 2 }, null, { type: "e", seq: 1 }] },
    };
    const r = await drive(input);
    expect(r.status).toBe(EngineStatus.DONE);
    const k = kinds(r.findings);
    expect(k).toContain("malformed-message");
    expect(k).toContain("ordering-violation"); // seq 1 after 2 still caught
    expect(k).not.toContain("engine-error");
  });

  it("surfaces an unknown stream channel and a malformed channel without crashing", async () => {
    const input = {
      contracts: { channels: [null, { name: "c", events: [{ type: "e" }] }] },
      streams: { c: [{ type: "e" }], ghost: [{ type: "x" }] },
    };
    const r = await drive(input);
    expect(r.status).toBe(EngineStatus.DONE);
    const k = kinds(r.findings);
    expect(k).toContain("malformed-channel");
    expect(k).toContain("unknown-channel");
  });

  it("PREREQ_FAILED when there are no channels (fail-closed)", async () => {
    const r = await drive({ contracts: { channels: [] }, streams: {} });
    expect(r.status).toBe(EngineStatus.PREREQ_FAILED);
  });

  it("a non-array channels/streams does not crash discover/plan", async () => {
    const r = await drive({ contracts: { channels: "nope" }, streams: "bad" });
    expect([EngineStatus.PREREQ_FAILED, EngineStatus.DONE]).toContain(r.status); // never FAILED/thrown
  });

  it("reports offline-only realtime capabilities", () => {
    const caps = new QualityRealtimeEngine().capabilities();
    expect(caps.engineId).toBe("qa.realtime-engine");
    expect(caps.offlineOnly).toBe(true);
    expect(caps.capabilities).toContain("realtime.ordering");
  });
});

describe("QualityRealtimeEngine — review-fix regressions (ordering/ack correctness)", () => {
  const drive2 = (input: unknown) => driveEngine(new QualityRealtimeEngine(), ctx(input));

  it("honors channel.orderKey: a multi-partition stream keyed by a non-'key' field passes clean", async () => {
    const input = {
      contracts: { channels: [{ name: "c", ordering: "per-key", orderKey: "customerId", events: [{ type: "e" }] }] },
      streams: { c: [{ type: "e", customerId: "A", seq: 1 }, { type: "e", customerId: "B", seq: 1 }, { type: "e", customerId: "A", seq: 2 }, { type: "e", customerId: "B", seq: 2 }] },
    };
    const r = await drive2(input);
    expect(r.status).toBe(EngineStatus.DONE);
    expect(r.findings).toHaveLength(0); // each partition is in-order — no false positives
  });

  it("fails closed when an ordered channel's messages carry no seq (ordering unverifiable)", async () => {
    const input = { contracts: { channels: [{ name: "c", ordering: "total", events: [{ type: "e" }] }] }, streams: { c: [{ type: "e" }, { type: "e" }] } };
    const r = await drive2(input);
    expect(r.status).toBe(EngineStatus.DONE);
    expect(r.findings.filter((f) => f.kind === "missing-sequence")).toHaveLength(2); // not a silent pass
  });

  it("checks the ack requirement even for an unknown event type", async () => {
    const input = { contracts: { channels: [{ name: "c", requireAck: true, events: [{ type: "known" }] }] }, streams: { c: [{ type: "mystery", acked: false }] } };
    const r = await drive2(input);
    const k = kinds(r.findings);
    expect(k).toContain("unacked-message"); // ack is channel-level, not skipped by the unknown-type continue
    expect(k).toContain("unknown-event-type");
  });

  it("a non-string requiredHeaders entry does not crash the run", async () => {
    const input = { contracts: { channels: [{ name: "c", events: [{ type: "e", requiredHeaders: [123] }] }] }, streams: { c: [{ type: "e", headers: {} }] } };
    const r = await drive2(input);
    expect(r.status).toBe(EngineStatus.DONE);
    expect(kinds(r.findings)).not.toContain("engine-error");
    expect(kinds(r.findings)).toContain("missing-message-header");
  });

  it("type-preserving partition keys: numeric 1 and string '1' are not merged (no false duplicate)", async () => {
    const input = { contracts: { channels: [{ name: "c", ordering: "per-key", events: [{ type: "e" }] }] }, streams: { c: [{ type: "e", key: 1, seq: 1 }, { type: "e", key: "1", seq: 1 }] } };
    const r = await drive2(input);
    expect(r.findings.filter((f) => f.kind === "duplicate-sequence")).toHaveLength(0);
  });
});

describe("QualityRealtimeEngine — payload format constraints are validated (re-review fix)", () => {
  it("flags a payload field that violates a declared format (email)", async () => {
    const input = {
      contracts: { channels: [{ name: "c", events: [{ type: "e", schema: { type: "object", required: ["email"], properties: { email: { type: "string", format: "email" } } } }] }] },
      streams: { c: [{ type: "e", payload: { email: "definitely-not-an-email" } }] },
    };
    const r = await driveEngine(new QualityRealtimeEngine(), ctx(input));
    expect(kinds(r.findings)).toContain("payload-format-violation");
  });

  it("accepts a valid format value (no false positive)", async () => {
    const input = {
      contracts: { channels: [{ name: "c", events: [{ type: "e", schema: { type: "object", required: ["email"], properties: { email: { type: "string", format: "email" } } } }] }] },
      streams: { c: [{ type: "e", payload: { email: "a@b.com" } }] },
    };
    const r = await driveEngine(new QualityRealtimeEngine(), ctx(input));
    expect(r.findings).toHaveLength(0);
  });
});

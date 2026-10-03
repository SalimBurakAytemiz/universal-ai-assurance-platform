import { describe, it, expect } from "vitest";
import { DigitalTwinSteward, TwinFactKind, Freshness } from "@uaap/digital-twin";

const T1 = "2026-10-03T10:00:00.000Z";
const T2 = "2026-10-03T11:00:00.000Z";
const T3 = "2026-10-03T12:00:00.000Z";

describe("DigitalTwinSteward", () => {
  it("applies a non-critical fact without provenance", () => {
    const s = new DigitalTwinSteward("PRJ_1");
    const r = s.proposeUpdate({ kind: TwinFactKind.REQUIREMENT, key: "REQ-1", value: "login works", proposedBy: "proj.repo", now: T1 });
    expect(r.applied).toBe(true);
    if (r.applied) expect(r.created).toBe(true);
  });

  it("REJECTS a critical fact (SERVICE/API/...) without provenance", () => {
    const s = new DigitalTwinSteward("PRJ_1");
    const r = s.proposeUpdate({ kind: TwinFactKind.SERVICE, key: "payments", value: {}, proposedBy: "proj.arch", now: T1 });
    expect(r.applied).toBe(false);
  });

  it("applies a critical fact WITH provenance", () => {
    const s = new DigitalTwinSteward("PRJ_1");
    const r = s.proposeUpdate({
      kind: TwinFactKind.API,
      key: "POST /pay",
      value: { status: 200 },
      provenance: "openapi.yaml@a1b2c3",
      proposedBy: "proj.arch",
      now: T1,
    });
    expect(r.applied).toBe(true);
  });

  it("deduplicates by (kind,key): a second proposal updates in place", () => {
    const s = new DigitalTwinSteward("PRJ_1");
    s.proposeUpdate({ kind: TwinFactKind.REQUIREMENT, key: "REQ-1", value: "v1", proposedBy: "a", now: T1 });
    const second = s.proposeUpdate({ kind: TwinFactKind.REQUIREMENT, key: "REQ-1", value: "v2", proposedBy: "a", now: T2 });
    expect(second.applied).toBe(true);
    if (second.applied) expect(second.created).toBe(false);
    const facts = s.getFacts(TwinFactKind.REQUIREMENT);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.value).toBe("v2");
    expect(facts[0]!.updatedAt).toBe(T2);
    expect(facts[0]!.createdAt).toBe(T1);
  });

  it("marks facts STALE and a fresh proposal resets freshness", () => {
    const s = new DigitalTwinSteward("PRJ_1");
    s.proposeUpdate({ kind: TwinFactKind.COMPONENT, key: "cart", value: 1, proposedBy: "a", now: T1 });
    const n = s.markStale((f) => f.kind === TwinFactKind.COMPONENT, T2);
    expect(n).toBe(1);
    expect(s.staleFacts()).toHaveLength(1);
    s.proposeUpdate({ kind: TwinFactKind.COMPONENT, key: "cart", value: 2, proposedBy: "a", now: T3 });
    expect(s.getFact(TwinFactKind.COMPONENT, "cart")!.freshness).toBe(Freshness.FRESH);
    expect(s.staleFacts()).toHaveLength(0);
  });

  it("round-trips through a snapshot", () => {
    const s = new DigitalTwinSteward("PRJ_1");
    s.proposeUpdate({ kind: TwinFactKind.REQUIREMENT, key: "REQ-1", value: "x", proposedBy: "a", now: T1 });
    const snap = s.snapshot();
    const restored = new DigitalTwinSteward("PRJ_1", snap);
    expect(restored.getFacts()).toHaveLength(1);
    expect(restored.getFact(TwinFactKind.REQUIREMENT, "REQ-1")!.value).toBe("x");
  });

  it("rejects a proposal with a blank key", () => {
    const s = new DigitalTwinSteward("PRJ_1");
    expect(s.proposeUpdate({ kind: TwinFactKind.REQUIREMENT, key: "  ", value: 1, proposedBy: "a", now: T1 }).applied).toBe(false);
  });
});

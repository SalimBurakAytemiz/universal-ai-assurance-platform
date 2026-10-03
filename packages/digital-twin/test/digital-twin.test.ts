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

  it("preserves existing provenance when a re-proposal omits it, and ignores a blank provenance", () => {
    const s = new DigitalTwinSteward("PRJ_1");
    s.proposeUpdate({ kind: TwinFactKind.REQUIREMENT, key: "R", value: 1, provenance: "doc@v1", proposedBy: "a", now: T1 });
    s.proposeUpdate({ kind: TwinFactKind.REQUIREMENT, key: "R", value: 2, proposedBy: "a", now: T2 }); // no provenance
    expect(s.getFact(TwinFactKind.REQUIREMENT, "R")!.provenance).toBe("doc@v1");
    s.proposeUpdate({ kind: TwinFactKind.REQUIREMENT, key: "R", value: 3, provenance: "   ", proposedBy: "a", now: T3 }); // blank
    expect(s.getFact(TwinFactKind.REQUIREMENT, "R")!.provenance).toBe("doc@v1");
  });

  it("markStale is idempotent, returns 0 on no match, and bumps updatedAt", () => {
    const s = new DigitalTwinSteward("PRJ_1");
    s.proposeUpdate({ kind: TwinFactKind.COMPONENT, key: "c", value: 1, proposedBy: "a", now: T1 });
    expect(s.markStale(() => false, T2)).toBe(0); // no match
    expect(s.markStale((f) => f.kind === TwinFactKind.COMPONENT, T2)).toBe(1);
    expect(s.getFact(TwinFactKind.COMPONENT, "c")!.updatedAt).toBe(T2);
    expect(s.markStale((f) => f.kind === TwinFactKind.COMPONENT, T3)).toBe(0); // already STALE (FRESH guard)
  });

  it("refuses to restore a tampered snapshot (critical fact without provenance)", () => {
    const tampered = {
      projectId: "PRJ_1",
      facts: [
        {
          id: "FACT_x",
          kind: TwinFactKind.SERVICE,
          key: "payments",
          value: {},
          freshness: Freshness.FRESH,
          createdAt: T1,
          updatedAt: T1,
        },
      ],
    };
    expect(() => new DigitalTwinSteward("PRJ_1", tampered)).toThrow(/provenance/i);
  });

  it("rejects a critical fact with a blank/whitespace provenance", () => {
    const s = new DigitalTwinSteward("PRJ_1");
    expect(
      s.proposeUpdate({ kind: TwinFactKind.SERVICE, key: "svc", value: {}, provenance: "   ", proposedBy: "a", now: T1 }).applied,
    ).toBe(false);
  });

  it("refuses to restore a snapshot fact with bad timestamps or an out-of-enum freshness", () => {
    const base = { id: "FACT_x", kind: TwinFactKind.COMPONENT, key: "c", value: 1, createdAt: T1, updatedAt: T1 };
    // numeric createdAt would crash the getFacts() sort later -> must be rejected on restore
    expect(() => new DigitalTwinSteward("PRJ_1", { projectId: "PRJ_1", facts: [{ ...base, createdAt: 123 as unknown as string, freshness: Freshness.FRESH }] })).toThrow(/timestamp/i);
    // bogus freshness would make a fact permanently un-expirable -> must be rejected
    expect(() => new DigitalTwinSteward("PRJ_1", { projectId: "PRJ_1", facts: [{ ...base, freshness: "BOGUS" as unknown as typeof Freshness.FRESH }] })).toThrow(/freshness/i);
  });

  it("snapshot preserves STALE freshness and returned facts are copies (no internal mutation)", () => {
    const s = new DigitalTwinSteward("PRJ_1");
    s.proposeUpdate({ kind: TwinFactKind.COMPONENT, key: "c", value: { n: 1 }, proposedBy: "a", now: T1 });
    s.markStale(() => true, T2);
    const snap = s.snapshot();
    expect(snap.facts[0]!.freshness).toBe(Freshness.STALE);
    const restored = new DigitalTwinSteward("PRJ_1", snap);
    expect(restored.getFact(TwinFactKind.COMPONENT, "c")!.freshness).toBe(Freshness.STALE);

    // mutating a returned fact must not change the steward's internal state
    const got = s.getFact(TwinFactKind.COMPONENT, "c")!;
    (got.value as { n: number }).n = 999;
    expect((s.getFact(TwinFactKind.COMPONENT, "c")!.value as { n: number }).n).toBe(1);
  });

  it("isolates the stored value from write-side mutation of the caller's object", () => {
    const s = new DigitalTwinSteward("PRJ_1");
    const value = { n: 1 };
    s.proposeUpdate({ kind: TwinFactKind.COMPONENT, key: "c", value, proposedBy: "a", now: T1 });
    value.n = 999; // caller mutates the object it passed in, AFTER proposing
    expect((s.getFact(TwinFactKind.COMPONENT, "c")!.value as { n: number }).n).toBe(1);
  });
});

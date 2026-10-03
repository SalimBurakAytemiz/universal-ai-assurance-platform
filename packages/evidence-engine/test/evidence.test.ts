import { describe, it, expect } from "vitest";
import { DataClassification } from "@uaap/core";
import { EvidenceStore, EvidenceKind, computeContentHash, type EvidenceRecord } from "@uaap/evidence-engine";

const AT = "2026-10-03T12:00:00.000Z";
const base = {
  runId: "RUN_1",
  producedBy: "adapter:http.readonly",
  action: "http.readonly.get",
  kind: EvidenceKind.HTTP,
  at: AT,
  classification: DataClassification.INTERNAL,
};

describe("EvidenceStore — no evidence without execution", () => {
  it("records evidence tied to an execution", () => {
    const s = new EvidenceStore();
    const r = s.record({ ...base, data: { status: 200 } });
    expect(r.id).toMatch(/^EV_/);
    expect(r.contentHash).toHaveLength(64);
  });

  it("rejects evidence missing runId / producedBy / action / timestamp", () => {
    const s = new EvidenceStore();
    expect(() => s.record({ ...base, runId: "" })).toThrow(/runId/);
    expect(() => s.record({ ...base, producedBy: "" })).toThrow(/producedBy/);
    expect(() => s.record({ ...base, action: "" })).toThrow(/action/);
    expect(() => s.record({ ...base, at: "" })).toThrow(/timestamp/i);
  });

  it("rejects an invalid data classification", () => {
    const s = new EvidenceStore();
    expect(() => s.record({ ...base, classification: "TOP_SECRET" as unknown as DataClassification })).toThrow(/classification/i);
  });

  it("rejects evidence with neither a ref nor inline data (no concrete artifact)", () => {
    const s = new EvidenceStore();
    expect(() => s.record({ ...base })).toThrow(/artifact|ref|inline data/i);
  });

  it("redacts data, summary AND ref for sensitive records", () => {
    const s = new EvidenceStore();
    s.record({
      ...base,
      classification: DataClassification.RESTRICTED,
      data: { secretish: "x" },
      summary: "customer email was leaked: a@b.com",
      ref: "s3://tenant-42/dump.bin",
    });
    const [red] = s.redactedList("RUN_1");
    expect(red!.sensitive).toBe(true);
    expect(red!.data).toBeUndefined();
    expect(red!.summary).toBe("[REDACTED]");
    expect(red!.ref).toBe("[REDACTED]");
    // the non-redacted list still has it (access-controlled elsewhere)
    expect(s.list("RUN_1")[0]!.summary).toContain("leaked");
  });

  it("isolates stored records from caller mutation (clone on write and read)", () => {
    const s = new EvidenceStore();
    const input = { ...base, data: { n: 1 } };
    s.record(input);
    (input.data as { n: number }).n = 999;
    expect((s.list("RUN_1")[0]!.data as { n: number }).n).toBe(1);
  });
});

describe("EvidenceStore — chain of custody bundles", () => {
  it("produces a deterministic bundle hash and verifies it", () => {
    const s = new EvidenceStore();
    s.record({ ...base, data: { a: 1 } });
    s.record({ ...base, action: "db.readonly.query", kind: EvidenceKind.DB, data: { rows: 2 } });
    const bundle = s.bundle("RUN_1", { commit: "abc123", policyVersion: "1.0.0" });
    expect(bundle.count).toBe(2);
    expect(s.verifyBundle(bundle)).toBe(true);
  });

  it("detects tampering: adding evidence after bundling breaks verification", () => {
    const s = new EvidenceStore();
    s.record({ ...base, data: { a: 1 } });
    const bundle = s.bundle("RUN_1", { commit: "abc123" });
    s.record({ ...base, action: "extra.op", data: { a: 2 } });
    expect(s.verifyBundle(bundle)).toBe(false);
  });

  it("bundle hash depends on metadata (different commit => different hash)", () => {
    const s = new EvidenceStore();
    s.record({ ...base, data: { a: 1 } });
    const b1 = s.bundle("RUN_1", { commit: "aaa" });
    const b2 = s.bundle("RUN_1", { commit: "bbb" });
    expect(b1.bundleHash).not.toBe(b2.bundleHash);
  });

  it("verifyBundle RECOMPUTES from content: mutating a record's data breaks verification", () => {
    const s = new EvidenceStore();
    s.record({ ...base, data: { a: 1 } });
    const bundle = s.bundle("RUN_1", { commit: "abc" });
    // reach into internal storage to simulate a content tamper that leaves add/remove unchanged
    const internal = (s as unknown as { records: EvidenceRecord[] }).records;
    (internal[0] as { data: unknown }).data = { a: 999 };
    expect(s.verifyBundle(bundle)).toBe(false);
  });

  it("flipping classification RESTRICTED->PUBLIC changes the content hash (and breaks the bundle)", () => {
    const s = new EvidenceStore();
    s.record({ ...base, classification: DataClassification.RESTRICTED, data: { a: 1 } });
    const bundle = s.bundle("RUN_1");
    const internal = (s as unknown as { records: EvidenceRecord[] }).records;
    (internal[0] as { classification: DataClassification }).classification = DataClassification.PUBLIC;
    expect(s.verifyBundle(bundle)).toBe(false);
  });

  it("computeContentHash commits to classification (two records differing only by class differ)", () => {
    const a = computeContentHash({ ...base, classification: DataClassification.PUBLIC, data: { x: 1 } });
    const b = computeContentHash({ ...base, classification: DataClassification.RESTRICTED, data: { x: 1 } });
    expect(a).not.toBe(b);
  });
});

import { describe, it, expect } from "vitest";
import { DataClassification } from "@uaap/core";
import { EvidenceStore, EvidenceKind } from "@uaap/evidence-engine";

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

  it("flags CONFIDENTIAL/RESTRICTED as sensitive and redacts inline data in the redacted view", () => {
    const s = new EvidenceStore();
    s.record({ ...base, classification: DataClassification.RESTRICTED, data: { secretish: "ref-only" } });
    const [red] = s.redactedList("RUN_1");
    expect(red!.sensitive).toBe(true);
    expect(red!.data).toBeUndefined();
    // but the non-redacted get still has it (access-controlled elsewhere)
    expect(s.list("RUN_1")[0]!.data).toBeDefined();
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
});

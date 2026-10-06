import { describe, it, expect } from "vitest";
import { LiveFetchGate, ResearchKind, ResearchPipeline, ResearchScheduler, ResearchStatus } from "@uaap/research-intelligence";

let t = 0;
const clock = { now: () => new Date(Date.UTC(2026, 9, 6, 0, 0, t++)).toISOString() };
const prov = (source = "nvd", retrievedAt = "2026-10-01T00:00:00.000Z") => ({ source, method: "manual-import", retrievedAt });

describe("ResearchPipeline — ingestion, provenance, lifecycle", () => {
  it("admits a provided finding only as DISCOVERED (never self-certified/active)", () => {
    const p = new ResearchPipeline(clock);
    const r = p.ingest({ kind: ResearchKind.ADVISORY, topic: "CVE-2026-0001", title: "Example advisory", provenance: prov() });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.record.status).toBe(ResearchStatus.DISCOVERED);
  });

  it("REJECTS a finding without valid provenance (fail-closed, no silent admission)", () => {
    const p = new ResearchPipeline(clock);
    const noProv = p.ingest({ kind: ResearchKind.TECHNOLOGY, topic: "wasm", title: "WASM", provenance: { source: "", method: "", retrievedAt: "nope" } as never });
    expect(noProv.ok).toBe(false);
    if (!noProv.ok) expect(noProv.reason).toMatch(/provenance/);
  });

  it("promotes DISCOVERED -> CANDIDATE but NEVER self-certifies/activates", () => {
    const p = new ResearchPipeline(clock);
    const r = p.ingest({ kind: ResearchKind.STANDARD, topic: "OWASP-ASVS-5", title: "ASVS 5.0", provenance: prov("owasp") });
    expect(r.ok).toBe(true);
    const id = r.ok ? r.record.id : "";
    const promoted = p.promote(id);
    expect(promoted.ok && promoted.record.status).toBe(ResearchStatus.CANDIDATE);
    // cannot promote again (no CERTIFIED/ACTIVE path here)
    expect(p.promote(id).ok).toBe(false);
  });

  it("a newer finding SUPERSEDES the older for the same (kind, topic); an older/equal duplicate is rejected", () => {
    const p = new ResearchPipeline(clock);
    const first = p.ingest({ kind: ResearchKind.ADVISORY, topic: "CVE-X", title: "v1", provenance: prov("nvd", "2026-10-01T00:00:00.000Z") });
    const newer = p.ingest({ kind: ResearchKind.ADVISORY, topic: "CVE-X", title: "v2", provenance: prov("ghsa", "2026-10-05T00:00:00.000Z") });
    expect(newer.ok).toBe(true);
    if (newer.ok && first.ok) {
      expect(newer.superseded).toBe(first.record.id);
      expect(p.get(first.record.id)?.status).toBe(ResearchStatus.SUPERSEDED);
    }
    const older = p.ingest({ kind: ResearchKind.ADVISORY, topic: "CVE-X", title: "stale", provenance: prov("nvd", "2026-09-01T00:00:00.000Z") });
    expect(older.ok).toBe(false); // not more recent than the current
    expect(p.list(ResearchKind.ADVISORY)).toHaveLength(1); // only the current record is listed
  });

  it("rejects an unknown kind (incl. prototype names)", () => {
    const p = new ResearchPipeline(clock);
    for (const bogus of ["NOPE", "constructor", "toString"]) {
      expect(p.ingest({ kind: bogus as never, topic: "t", title: "x", provenance: prov() }).ok).toBe(false);
    }
  });
});

describe("LiveFetchGate — no fabricated research", () => {
  it("live external fetch is BLOCKED_EXTERNAL_RESEARCH and returns no finding", () => {
    const res = new LiveFetchGate().fetch("latest CVEs for lodash");
    expect(res.status).toBe("BLOCKED_EXTERNAL_RESEARCH");
    expect(res).not.toHaveProperty("items");
    expect(res).not.toHaveProperty("record");
  });
});

describe("ResearchScheduler — deterministic", () => {
  it("computes the next run and due state deterministically", () => {
    const s = new ResearchScheduler();
    const next = s.nextRunAt("2026-10-06T00:00:00.000Z", 3_600_000); // +1h
    expect(next).toBe("2026-10-06T01:00:00.000Z");
    expect(s.due("2026-10-06T00:30:00.000Z", next)).toBe(false);
    expect(s.due("2026-10-06T01:00:00.000Z", next)).toBe(true);
  });
});

describe("ResearchPipeline — review-fix regressions", () => {
  it("same-source newer finding supersedes with a DISTINCT id; the prior version stays retrievable", () => {
    const p = new ResearchPipeline(clock);
    const a = p.ingest({ kind: ResearchKind.ADVISORY, topic: "CVE-X", title: "v1", provenance: prov("nvd", "2026-10-01T00:00:00.000Z") });
    const b = p.ingest({ kind: ResearchKind.ADVISORY, topic: "CVE-X", title: "v2", provenance: prov("nvd", "2026-10-05T00:00:00.000Z") });
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(b.record.id).not.toBe(a.record.id); // distinct ids across versions
      expect(b.superseded).toBe(a.record.id);
      const old = p.get(a.record.id);
      expect(old?.status).toBe(ResearchStatus.SUPERSEDED); // prior version retained, not clobbered
      expect(old?.title).toBe("v1");
      expect(p.get(b.record.id)?.title).toBe("v2");
      expect(p.list(ResearchKind.ADVISORY)).toHaveLength(1); // only the current is listed
    }
  });

  it("defensive copy: mutating the caller's provenance after ingest cannot corrupt dedup state", () => {
    const p = new ResearchPipeline(clock);
    const prv = { source: "nvd", method: "manual-import", retrievedAt: "2026-10-05T00:00:00.000Z" };
    const first = p.ingest({ kind: ResearchKind.ADVISORY, topic: "CVE-Y", title: "current-newest", provenance: prv });
    expect(first.ok && first.record.provenance).not.toBe(prv); // stored provenance is a copy, not the caller's object
    prv.retrievedAt = "2000-01-01T00:00:00.000Z"; // caller mutates its own object post-ingest
    const stale = p.ingest({ kind: ResearchKind.ADVISORY, topic: "CVE-Y", title: "actually-older", provenance: prov("nvd", "2026-01-01T00:00:00.000Z") });
    expect(stale.ok).toBe(false); // the genuinely older finding is still rejected (dedup used the stored copy)
  });

  it("scheduler fails CLOSED on invalid input (no perpetual-due from epoch default)", () => {
    const s = new ResearchScheduler();
    expect(() => s.nextRunAt("", 1000)).toThrow(/valid ISO/);
    expect(() => s.nextRunAt("not-a-date", 1000)).toThrow(/valid ISO/);
    expect(s.due("also-garbage", "2026-10-06T00:00:00.000Z")).toBe(false); // invalid now => not due
    expect(s.due("2026-10-06T00:00:00.000Z", "garbage")).toBe(false); // invalid next => not due
  });
});

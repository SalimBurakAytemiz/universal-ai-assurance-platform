import { describe, it, expect } from "vitest";
import {
  KnowledgeStore,
  KnowledgeScope,
  TrustTier,
  LifecycleStatus,
  resolveKnowledgeConflict,
  type KnowledgeItem,
} from "@uaap/knowledge";

const T1 = "2026-10-03T10:00:00.000Z";
const T2 = "2026-10-03T11:00:00.000Z";

function item(overrides: Partial<KnowledgeItem> = {}): KnowledgeItem {
  return {
    knowledgeId: "K1",
    title: "Playwright v2 locator guidance",
    category: "tool",
    source: "https://playwright.dev/docs",
    sourceType: "official-docs",
    retrievedAt: T1,
    trustTier: TrustTier.TIER_1,
    scope: KnowledgeScope.GLOBAL,
    lifecycleStatus: LifecycleStatus.CANDIDATE,
    ...overrides,
  };
}

describe("KnowledgeStore — admission + lifecycle (SELF-LEARNING != SELF-TRUSTING)", () => {
  it("admits a DISCOVERED/CANDIDATE item", () => {
    const s = new KnowledgeStore();
    expect(s.add(item()).ok).toBe(true);
  });

  it("refuses to admit an item that is already ACTIVE or CERTIFIED", () => {
    const s = new KnowledgeStore();
    expect(s.add(item({ lifecycleStatus: LifecycleStatus.ACTIVE })).ok).toBe(false);
    expect(s.add(item({ lifecycleStatus: LifecycleStatus.CERTIFIED })).ok).toBe(false);
  });

  it("rejects a schema-invalid item", () => {
    const s = new KnowledgeStore();
    // missing required trustTier
    const bad = { ...item(), trustTier: undefined as unknown as TrustTier };
    expect(s.add(bad).ok).toBe(false);
  });

  it("rejects a non-GLOBAL item without a scopeRef", () => {
    const s = new KnowledgeStore();
    expect(s.add(item({ scope: KnowledgeScope.PROJECT })).ok).toBe(false);
  });

  it("rejects a duplicate knowledge id", () => {
    const s = new KnowledgeStore();
    s.add(item());
    expect(s.add(item()).ok).toBe(false);
  });

  it("external knowledge can NEVER jump straight to ACTIVE; it must pass through CERTIFIED", () => {
    const s = new KnowledgeStore();
    s.add(item());
    expect(s.promote("K1", LifecycleStatus.ACTIVE, T2).ok).toBe(false); // CANDIDATE -> ACTIVE illegal
    // walk the legal pipeline
    for (const to of [
      LifecycleStatus.SOURCE_VERIFIED,
      LifecycleStatus.SANDBOXED,
      LifecycleStatus.EVALUATED,
      LifecycleStatus.REVIEWED,
      LifecycleStatus.CERTIFIED,
      LifecycleStatus.ACTIVE,
    ]) {
      expect(s.promote("K1", to, T2).ok, `-> ${to}`).toBe(true);
    }
    expect(s.get("K1")!.lifecycleStatus).toBe(LifecycleStatus.ACTIVE);
  });

  it("rejects an illegal skip transition", () => {
    const s = new KnowledgeStore();
    s.add(item());
    expect(s.promote("K1", LifecycleStatus.REVIEWED, T2).ok).toBe(false); // CANDIDATE -> REVIEWED illegal
  });
});

describe("KnowledgeStore — scope isolation", () => {
  it("does not leak a PROJECT item of project A to a query for project B", () => {
    const s = new KnowledgeStore();
    s.add(item({ knowledgeId: "KA", scope: KnowledgeScope.PROJECT, scopeRef: "PRJ_A" }));
    s.add(item({ knowledgeId: "KG", scope: KnowledgeScope.GLOBAL }));
    const forB = s.query({ projectId: "PRJ_B" }).map((i) => i.knowledgeId);
    expect(forB).toContain("KG"); // GLOBAL visible to all
    expect(forB).not.toContain("KA"); // project A's private knowledge is isolated
    const forA = s.query({ projectId: "PRJ_A" }).map((i) => i.knowledgeId);
    expect(forA).toContain("KA");
  });

  it("activeKnowledge returns only ACTIVE items in context", () => {
    const s = new KnowledgeStore();
    s.add(item({ knowledgeId: "KG" }));
    // promote KG to ACTIVE
    for (const to of [
      LifecycleStatus.SOURCE_VERIFIED, LifecycleStatus.SANDBOXED, LifecycleStatus.EVALUATED,
      LifecycleStatus.REVIEWED, LifecycleStatus.CERTIFIED, LifecycleStatus.ACTIVE,
    ]) s.promote("KG", to, T2);
    s.add(item({ knowledgeId: "KC" })); // stays CANDIDATE
    expect(s.activeKnowledge().map((i) => i.knowledgeId)).toEqual(["KG"]);
  });
});

describe("KnowledgeStore — decay + conflict", () => {
  it("marks ACTIVE items STALE and flags them for revalidation", () => {
    const s = new KnowledgeStore();
    s.add(item({ knowledgeId: "KG" }));
    for (const to of [
      LifecycleStatus.SOURCE_VERIFIED, LifecycleStatus.SANDBOXED, LifecycleStatus.EVALUATED,
      LifecycleStatus.REVIEWED, LifecycleStatus.CERTIFIED, LifecycleStatus.ACTIVE,
    ]) s.promote("KG", to, T2);
    expect(s.markStale(() => true, T2)).toBe(1);
    expect(s.needsRevalidation().map((i) => i.knowledgeId)).toEqual(["KG"]);
  });

  it("resolveKnowledgeConflict prefers the lower trust tier, then more-advanced status", () => {
    const a = item({ knowledgeId: "A", trustTier: TrustTier.TIER_3, lifecycleStatus: LifecycleStatus.ACTIVE });
    const b = item({ knowledgeId: "B", trustTier: TrustTier.TIER_0, lifecycleStatus: LifecycleStatus.CANDIDATE });
    const r = resolveKnowledgeConflict([a, b]);
    expect(r.winner?.knowledgeId).toBe("B"); // TIER_0 beats TIER_3
    expect(r.conflict).toBe(false);
  });

  it("flags a true tie as a conflict", () => {
    const a = item({ knowledgeId: "A", trustTier: TrustTier.TIER_1, lifecycleStatus: LifecycleStatus.CANDIDATE, lastVerified: T1 });
    const b = item({ knowledgeId: "B", trustTier: TrustTier.TIER_1, lifecycleStatus: LifecycleStatus.CANDIDATE, lastVerified: T1 });
    expect(resolveKnowledgeConflict([a, b]).conflict).toBe(true);
  });

  it("never elects a REVOKED/SUPERSEDED item as conflict winner, even at a better trust tier", () => {
    const revoked = item({ knowledgeId: "R", trustTier: TrustTier.TIER_0, lifecycleStatus: LifecycleStatus.REVOKED });
    const active = item({ knowledgeId: "A", trustTier: TrustTier.TIER_3, lifecycleStatus: LifecycleStatus.ACTIVE });
    const r = resolveKnowledgeConflict([revoked, active]);
    expect(r.winner?.knowledgeId).toBe("A");
    expect(resolveKnowledgeConflict([revoked]).winner).toBeUndefined();
  });

  it("surfaces STALE items from ALL scopes (not just GLOBAL) in needsRevalidation", () => {
    const s = new KnowledgeStore();
    s.add(item({ knowledgeId: "KP", scope: KnowledgeScope.PROJECT, scopeRef: "PRJ_A" }));
    for (const to of [
      LifecycleStatus.SOURCE_VERIFIED, LifecycleStatus.SANDBOXED, LifecycleStatus.EVALUATED,
      LifecycleStatus.REVIEWED, LifecycleStatus.CERTIFIED, LifecycleStatus.ACTIVE,
    ]) s.promote("KP", to, T2);
    expect(s.markStale(() => true, T2)).toBe(1);
    expect(s.needsRevalidation().map((i) => i.knowledgeId)).toEqual(["KP"]);
  });

  it("markStale only affects ACTIVE items (CERTIFIED is left for promote/revoke)", () => {
    const s = new KnowledgeStore();
    s.add(item({ knowledgeId: "KC" }));
    for (const to of [
      LifecycleStatus.SOURCE_VERIFIED, LifecycleStatus.SANDBOXED, LifecycleStatus.EVALUATED,
      LifecycleStatus.REVIEWED, LifecycleStatus.CERTIFIED,
    ]) s.promote("KC", to, T2);
    expect(s.markStale(() => true, T2)).toBe(0); // CERTIFIED is not marked stale
    expect(s.get("KC")!.lifecycleStatus).toBe(LifecycleStatus.CERTIFIED);
  });

  it("returns deep copies (no internal mutation leak)", () => {
    const s = new KnowledgeStore();
    s.add(item());
    const got = s.get("K1")!;
    (got as { title: string }).title = "tampered";
    expect(s.get("K1")!.title).toBe("Playwright v2 locator guidance");
  });
});

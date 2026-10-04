import { describe, it, expect } from "vitest";
import { DomainRegistry, type DomainPack } from "@uaap/domain-model";

const registry = DomainRegistry.fromRepo();

describe("DomainRegistry — packs", () => {
  it("loads the shipped packs incl. a generic fallback", () => {
    expect(registry.get("fintech")).toBeDefined();
    expect(registry.get("ecommerce")).toBeDefined();
    expect(registry.get("gaming")).toBeDefined();
    expect(registry.generic()?.id).toBe("generic");
  });
});

describe("DomainRegistry — resolution", () => {
  it("resolves a single sector + always includes generic, unioning capabilities & invariants", () => {
    const r = registry.resolve(["we use Stripe for payment", "ledger table"]);
    const ids = r.domains.map((d) => d.id);
    expect(ids).toContain("fintech");
    expect(ids).toContain("generic");
    expect(r.multiDomain).toBe(false);
    expect(r.capabilities).toContain("payment");
    expect(r.capabilities).toContain("ledger");
    expect(r.businessInvariants.some((i) => /ledger balances/i.test(i))).toBe(true);
  });

  it("supports MULTI-domain projects (gaming + marketplace + payment)", () => {
    const r = registry.resolve(["loot matchmaking leaderboard", "shopping cart with sku inventory", "stripe payment ledger"]);
    const ids = r.domains.map((d) => d.id);
    expect(ids).toContain("gaming");
    expect(ids).toContain("ecommerce");
    expect(ids).toContain("fintech");
    expect(r.multiDomain).toBe(true);
    // union of capabilities across the matched domains
    for (const c of ["inventory", "cart", "payment", "realtime"]) expect(r.capabilities).toContain(c);
  });

  it("falls back to generic ONLY for an unknown domain (never crashes)", () => {
    const r = registry.resolve(["quantum flux capacitor service", "unknown-tech-xyz"]);
    expect(r.domains.map((d) => d.id)).toEqual(["generic"]);
    expect(r.multiDomain).toBe(false);
    expect(r.capabilities).toContain("auth"); // generic still contributes baseline capabilities
  });

  it("handles empty signals (generic only)", () => {
    expect(registry.resolve([]).domains.map((d) => d.id)).toEqual(["generic"]);
  });

  it("guarantees a generic fallback even if constructed without one", () => {
    const only: DomainPack = { id: "x", name: "X", capabilities: ["auth"], signals: ["xthing"] };
    const reg = new DomainRegistry([only]);
    expect(reg.generic()).toBeDefined();
    expect(reg.resolve(["nothing matches"]).domains.map((d) => d.id)).toEqual(["generic"]);
  });

  it("signal matching is case-insensitive", () => {
    const r = registry.resolve(["STRIPE PAYMENT"]);
    expect(r.domains.map((d) => d.id)).toContain("fintech");
  });

  it("does not match on substrings OR on bare common words / generic infra terms", () => {
    for (const noise of [
      // substring false-positives (killed by whole-word matching)
      "border-radius css styling",
      "production environment deploy",
      "load balancer healthcheck",
      "wildcard dns certificate",
      "concurrency control",
      "workshop booking",
      // bare common-word false-positives (killed by specific multi-word signals)
      "card component react dashboard", // UI "card" is not "credit card"
      "graphics card driver update",
      "performance trade-off analysis", // "trade" is no longer a gaming signal
      "sort results in ascending order", // "order" is not "purchase order"
      "dot product of two vectors", // "product" is not "product catalog"
      "binary tree balance rotation", // "balance" is not "account balance"
      "git checkout branch", // "checkout" is not an ecommerce signal
      // generic infra terms are NOT gaming-exclusive anymore
      "realtime websocket chat service",
      "live trading dashboard websocket realtime feed",
    ]) {
      expect(registry.resolve([noise]).domains.map((d) => d.id), noise).toEqual(["generic"]);
    }
  });

  it("a retail inventory system matches ecommerce only (not gaming) — signals are disambiguated", () => {
    const r = registry.resolve(["warehouse inventory management for retail stock"]);
    const ids = r.domains.map((d) => d.id);
    expect(ids).toContain("ecommerce");
    expect(ids).not.toContain("gaming");
  });
});

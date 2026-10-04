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

  it("supports MULTI-domain projects (gaming + marketplace + payment + realtime)", () => {
    const r = registry.resolve(["player inventory", "websocket realtime", "checkout cart", "stripe payment"]);
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

  it("uses WHOLE-WORD matching — common words that merely CONTAIN a signal do NOT match", () => {
    for (const noise of [
      "border-radius css styling",       // "order" ⊂ border  -> must NOT match ecommerce
      "production environment deploy",    // "product" ⊂ production
      "load balancer healthcheck",        // "balance" ⊂ balancer
      "wildcard dns certificate",         // "card" ⊂ wildcard
      "discard local changes",            // "card" ⊂ discard
      "concurrency control",              // "currency" ⊂ concurrency
      "workshop booking",                 // "shop" ⊂ workshop
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

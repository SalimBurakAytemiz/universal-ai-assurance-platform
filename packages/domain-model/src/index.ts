// Domain-aware + capability-based model. The platform is NOT single-domain: a project can match
// several domain packs at once, and an UNKNOWN domain falls back to the generic pack rather than
// crashing. Capabilities are detected from observed signals; domains contribute entities,
// invariants and QA/security patterns.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findRepoRoot } from "@uaap/core";

/** Split free-form text into lowercased alphanumeric word tokens for whole-word signal matching. */
function tokenize(s: string): string[] {
  return String(s).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

export interface DomainPack {
  readonly id: string;
  readonly name: string;
  readonly generic?: boolean;
  readonly entities?: readonly string[];
  readonly workflows?: readonly string[];
  readonly businessInvariants?: readonly string[];
  readonly criticalAssets?: readonly string[];
  readonly qaPatterns?: readonly string[];
  readonly securityPatterns?: readonly string[];
  readonly capabilities: readonly string[];
  /** Lowercased substrings that, if present in the project's signals, indicate this domain. */
  readonly signals?: readonly string[];
}

export interface DomainResolution {
  readonly domains: readonly DomainPack[]; // matched sector packs + the generic pack (always)
  readonly capabilities: readonly string[];
  readonly businessInvariants: readonly string[];
  readonly qaPatterns: readonly string[];
  readonly securityPatterns: readonly string[];
  readonly multiDomain: boolean;
}

/** Registry of domain packs. Always exposes a generic fallback so unknown domains never crash. */
export class DomainRegistry {
  private readonly byId = new Map<string, DomainPack>();

  constructor(packs: readonly DomainPack[]) {
    for (const p of packs) this.byId.set(p.id, p);
    if (!this.generic()) {
      // Guarantee a generic fallback even if none was provided.
      this.byId.set("generic", { id: "generic", name: "Generic", generic: true, capabilities: ["auth", "data-store"], signals: [] });
    }
  }

  static fromRepo(startDir = dirname(fileURLToPath(import.meta.url))): DomainRegistry {
    const root = findRepoRoot(startDir);
    const dir = join(root, "domain-packs");
    const packs: DomainPack[] = [];
    if (existsSync(dir)) {
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".json")) continue;
        packs.push(JSON.parse(readFileSync(join(dir, f), "utf8")) as DomainPack);
      }
    }
    return new DomainRegistry(packs);
  }

  generic(): DomainPack | undefined {
    return [...this.byId.values()].find((p) => p.generic);
  }

  get(id: string): DomainPack | undefined {
    return this.byId.get(id);
  }

  list(): DomainPack[] {
    return [...this.byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /**
   * Resolve the domains for a project from free-form signals (tech names, keywords, table names…).
   * Returns every sector pack whose signal appears, PLUS the generic pack (always), with the union
   * of capabilities, invariants and patterns. An unknown project matches only generic — never a crash.
   */
  resolve(signals: readonly string[]): DomainResolution {
    // Whole-WORD (tokenized) matching, NOT raw substring — so "border" never matches "order",
    // "production" never matches "product", "balancer" never matches "balance", etc. A multi-word
    // signal matches only if every one of its words is present as an input token. Empty/whitespace
    // signals tokenize to nothing and never match (closes the ''.includes('') footgun).
    const inputTokens = new Set(signals.flatMap(tokenize));
    const matchedSectors = this.list().filter(
      (p) => !p.generic && (p.signals ?? []).some((sig) => {
        const words = tokenize(sig);
        return words.length > 0 && words.every((w) => inputTokens.has(w));
      }),
    );
    const generic = this.generic();
    const domains = generic ? [...matchedSectors, generic] : matchedSectors;
    const uniq = (arr: string[]) => [...new Set(arr)].sort();
    return {
      domains,
      capabilities: uniq(domains.flatMap((d) => [...d.capabilities])),
      businessInvariants: uniq(domains.flatMap((d) => [...(d.businessInvariants ?? [])])),
      qaPatterns: uniq(domains.flatMap((d) => [...(d.qaPatterns ?? [])])),
      securityPatterns: uniq(domains.flatMap((d) => [...(d.securityPatterns ?? [])])),
      multiDomain: matchedSectors.length > 1,
    };
  }
}

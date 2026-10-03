import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import { readRepoJson } from "@uaap/core";

export const KnowledgeScope = {
  GLOBAL: "GLOBAL",
  ORGANIZATION: "ORGANIZATION",
  PROJECT: "PROJECT",
  RUN: "RUN",
} as const;
export type KnowledgeScope = (typeof KnowledgeScope)[keyof typeof KnowledgeScope];

export const TrustTier = { TIER_0: "TIER_0", TIER_1: "TIER_1", TIER_2: "TIER_2", TIER_3: "TIER_3", TIER_4: "TIER_4" } as const;
export type TrustTier = (typeof TrustTier)[keyof typeof TrustTier];

export const LifecycleStatus = {
  DISCOVERED: "DISCOVERED",
  CANDIDATE: "CANDIDATE",
  SOURCE_VERIFIED: "SOURCE_VERIFIED",
  SANDBOXED: "SANDBOXED",
  EVALUATED: "EVALUATED",
  REVIEWED: "REVIEWED",
  CERTIFIED: "CERTIFIED",
  ACTIVE: "ACTIVE",
  STALE: "STALE",
  DEPRECATED: "DEPRECATED",
  REVOKED: "REVOKED",
  SUPERSEDED: "SUPERSEDED",
} as const;
export type LifecycleStatus = (typeof LifecycleStatus)[keyof typeof LifecycleStatus];

export interface KnowledgeItem {
  readonly knowledgeId: string;
  readonly title: string;
  readonly category: string;
  readonly technology?: string;
  readonly version?: string;
  readonly source: string;
  readonly sourceType: string;
  readonly sourceReference?: string;
  readonly publisher?: string;
  readonly retrievedAt: string;
  readonly publishedAt?: string;
  readonly contentHash?: string;
  readonly license?: string;
  readonly confidence?: number;
  readonly trustTier: TrustTier;
  readonly scope: KnowledgeScope;
  /** Owning id for non-GLOBAL scopes (organizationId / projectId / runId). */
  readonly scopeRef?: string;
  readonly lifecycleStatus: LifecycleStatus;
  readonly lastVerified?: string;
  readonly stalenessPolicy?: string;
  readonly supersededBy?: string;
}

/** Legal forward lifecycle transitions. External info enters at DISCOVERED/CANDIDATE and can
 *  ONLY reach ACTIVE by passing through CERTIFIED — it can never jump straight to ACTIVE. */
const TRANSITIONS: Record<LifecycleStatus, readonly LifecycleStatus[]> = {
  DISCOVERED: [LifecycleStatus.CANDIDATE, LifecycleStatus.REVOKED],
  CANDIDATE: [LifecycleStatus.SOURCE_VERIFIED, LifecycleStatus.REVOKED],
  SOURCE_VERIFIED: [LifecycleStatus.SANDBOXED, LifecycleStatus.REVOKED],
  SANDBOXED: [LifecycleStatus.EVALUATED, LifecycleStatus.REVOKED],
  EVALUATED: [LifecycleStatus.REVIEWED, LifecycleStatus.REVOKED],
  REVIEWED: [LifecycleStatus.CERTIFIED, LifecycleStatus.REVOKED],
  CERTIFIED: [LifecycleStatus.ACTIVE, LifecycleStatus.REVOKED, LifecycleStatus.DEPRECATED],
  ACTIVE: [LifecycleStatus.STALE, LifecycleStatus.DEPRECATED, LifecycleStatus.REVOKED, LifecycleStatus.SUPERSEDED],
  STALE: [LifecycleStatus.SOURCE_VERIFIED, LifecycleStatus.REVOKED, LifecycleStatus.DEPRECATED],
  DEPRECATED: [LifecycleStatus.REVOKED],
  REVOKED: [],
  SUPERSEDED: [],
};

/** Lifecycle states an item may be ADDED in (external candidates only; never ACTIVE/CERTIFIED). */
const ADMISSIBLE_ON_ADD: ReadonlySet<LifecycleStatus> = new Set([LifecycleStatus.DISCOVERED, LifecycleStatus.CANDIDATE]);

export interface ScopeContext {
  readonly organizationId?: string;
  readonly projectId?: string;
  readonly runId?: string;
}

export type AddResult = { readonly ok: true; readonly item: KnowledgeItem } | { readonly ok: false; readonly reason: string };
export type PromoteResult = { readonly ok: true; readonly item: KnowledgeItem } | { readonly ok: false; readonly reason: string };

function clone<T>(v: T): T {
  return structuredClone(v);
}

/**
 * Scoped, provenance-aware knowledge store with a certify-before-active lifecycle.
 * - Isolation: a PROJECT item of project A is never visible to a query for project B; GLOBAL is
 *   visible to all. Project-private knowledge does not leak to GLOBAL.
 * - Admission: items may only be ADDED as DISCOVERED/CANDIDATE — nothing enters as ACTIVE.
 * - Promotion: only legal forward transitions; ACTIVE is reachable only from CERTIFIED.
 */
export class KnowledgeStore {
  private readonly items = new Map<string, KnowledgeItem>();
  private readonly validate: ValidateFunction;

  constructor(startDir = dirname(fileURLToPath(import.meta.url))) {
    const schema = readRepoJson<object>("schemas/knowledge-item.schema.json", startDir);
    this.validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
  }

  add(item: KnowledgeItem): AddResult {
    if (!this.validate(item)) {
      const msg = (this.validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`.trim()).join("; ");
      return { ok: false, reason: `Knowledge item failed schema validation: ${msg}` };
    }
    if (!ADMISSIBLE_ON_ADD.has(item.lifecycleStatus)) {
      return { ok: false, reason: `New knowledge must be added as DISCOVERED or CANDIDATE, not ${item.lifecycleStatus}.` };
    }
    if (item.scope !== KnowledgeScope.GLOBAL && !item.scopeRef?.trim()) {
      return { ok: false, reason: `A ${item.scope}-scoped item requires a scopeRef (owning id).` };
    }
    if (this.items.has(item.knowledgeId)) {
      return { ok: false, reason: `Knowledge id "${item.knowledgeId}" already exists.` };
    }
    this.items.set(item.knowledgeId, clone(item));
    return { ok: true, item: clone(item) };
  }

  get(knowledgeId: string): KnowledgeItem | undefined {
    const i = this.items.get(knowledgeId);
    return i ? clone(i) : undefined;
  }

  /** Promote (or retire) an item along a legal lifecycle transition. */
  promote(knowledgeId: string, to: LifecycleStatus, now: string): PromoteResult {
    const current = this.items.get(knowledgeId);
    if (!current) return { ok: false, reason: `No knowledge item "${knowledgeId}".` };
    const legal = TRANSITIONS[current.lifecycleStatus] ?? [];
    if (!legal.includes(to)) {
      return { ok: false, reason: `Illegal lifecycle transition ${current.lifecycleStatus} -> ${to}.` };
    }
    const next: KnowledgeItem = { ...current, lifecycleStatus: to, lastVerified: now };
    this.items.set(knowledgeId, next);
    return { ok: true, item: clone(next) };
  }

  /** Items visible in a scope context: GLOBAL always + matching ORG/PROJECT/RUN. Isolation enforced. */
  query(context: ScopeContext = {}): KnowledgeItem[] {
    return [...this.items.values()]
      .filter((i) => this.visible(i, context))
      // Deterministic UTF-16 code-unit ordering (not localeCompare) so output is reproducible across machines/ICU.
      .sort((a, b) => (a.knowledgeId < b.knowledgeId ? -1 : a.knowledgeId > b.knowledgeId ? 1 : 0))
      .map(clone);
  }

  /** ACTIVE knowledge visible in a context. */
  activeKnowledge(context: ScopeContext = {}): KnowledgeItem[] {
    return this.query(context).filter((i) => i.lifecycleStatus === LifecycleStatus.ACTIVE);
  }

  private visible(i: KnowledgeItem, ctx: ScopeContext): boolean {
    switch (i.scope) {
      case KnowledgeScope.GLOBAL:
        return true;
      case KnowledgeScope.ORGANIZATION:
        return !!ctx.organizationId && i.scopeRef === ctx.organizationId;
      case KnowledgeScope.PROJECT:
        return !!ctx.projectId && i.scopeRef === ctx.projectId;
      case KnowledgeScope.RUN:
        return !!ctx.runId && i.scopeRef === ctx.runId;
      default:
        return false; // unknown scope -> not visible (fail-closed)
    }
  }

  /** Mark matching ACTIVE items STALE. Only ACTIVE->STALE is a legal lifecycle move (see
   *  TRANSITIONS), so markStale is restricted to ACTIVE to keep promote() and decay consistent. */
  markStale(predicate: (item: KnowledgeItem) => boolean, now: string): number {
    let n = 0;
    for (const [id, i] of this.items) {
      if (i.lifecycleStatus === LifecycleStatus.ACTIVE && predicate(clone(i))) {
        this.items.set(id, { ...i, lifecycleStatus: LifecycleStatus.STALE, lastVerified: now });
        n++;
      }
    }
    return n;
  }

  /** ALL items that are STALE and therefore require revalidation — across every scope, not just
   *  GLOBAL (decay must surface tenant-scoped knowledge too). */
  needsRevalidation(): KnowledgeItem[] {
    return [...this.items.values()]
      .filter((i) => i.lifecycleStatus === LifecycleStatus.STALE)
      .sort((a, b) => (a.knowledgeId < b.knowledgeId ? -1 : a.knowledgeId > b.knowledgeId ? 1 : 0))
      .map(clone);
  }
}

const TIER_RANK: Record<string, number> = { TIER_0: 0, TIER_1: 1, TIER_2: 2, TIER_3: 3, TIER_4: 4 };
const STATUS_RANK: Record<string, number> = { ACTIVE: 0, CERTIFIED: 1, REVIEWED: 2, EVALUATED: 3, SANDBOXED: 4, SOURCE_VERIFIED: 5, CANDIDATE: 6, DISCOVERED: 7, STALE: 8, DEPRECATED: 9, SUPERSEDED: 10, REVOKED: 11 };

/**
 * Resolve conflicting knowledge items (same topic) by trust order: lower trust tier wins, then
 * more-advanced lifecycle status, then more-recently verified. Returns the winner and whether
 * the result was ambiguous (a true tie) so callers can record a KNOWLEDGE_CONFLICT.
 */
export function resolveKnowledgeConflict(items: readonly KnowledgeItem[]): { winner?: KnowledgeItem; conflict: boolean } {
  // A retracted/untrusted item must never be elected authoritative, regardless of its trust tier.
  const NON_CONSUMABLE: ReadonlySet<string> = new Set([
    LifecycleStatus.REVOKED,
    LifecycleStatus.SUPERSEDED,
    LifecycleStatus.DEPRECATED,
    LifecycleStatus.STALE,
  ]);
  const consumable = items.filter((i) => !NON_CONSUMABLE.has(i.lifecycleStatus));
  if (consumable.length === 0) return { conflict: false };
  items = consumable;
  const score = (i: KnowledgeItem): [number, number, string] => [
    TIER_RANK[i.trustTier] ?? 99,
    STATUS_RANK[i.lifecycleStatus] ?? 99,
    i.lastVerified ?? i.retrievedAt ?? "",
  ];
  const sorted = [...items].sort((a, b) => {
    const [ta, sa, va] = score(a);
    const [tb, sb, vb] = score(b);
    // recency: more-recent (larger ISO) first, by UTF-16 code unit for determinism.
    return ta - tb || sa - sb || (vb < va ? -1 : vb > va ? 1 : 0);
  });
  const [first, second] = sorted;
  const tie =
    !!second &&
    score(first!)[0] === score(second)[0] &&
    score(first!)[1] === score(second)[1] &&
    score(first!)[2] === score(second)[2];
  return { winner: clone(first!), conflict: tie };
}

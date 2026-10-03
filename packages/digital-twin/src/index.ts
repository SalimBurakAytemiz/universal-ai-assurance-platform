import { newId } from "@uaap/core";

/** Kinds of facts the project digital twin can hold. */
export const TwinFactKind = {
  ARCHITECTURE: "ARCHITECTURE",
  COMPONENT: "COMPONENT",
  SERVICE: "SERVICE",
  API: "API",
  DATABASE: "DATABASE",
  QUEUE: "QUEUE",
  EVENT: "EVENT",
  CLIENT: "CLIENT",
  DEPENDENCY: "DEPENDENCY",
  REQUIREMENT: "REQUIREMENT",
  FEATURE: "FEATURE",
  BUSINESS_FLOW: "BUSINESS_FLOW",
  CRITICAL_JOURNEY: "CRITICAL_JOURNEY",
  RISK: "RISK",
  TEST: "TEST",
  FINDING: "FINDING",
  EVIDENCE: "EVIDENCE",
  RELEASE: "RELEASE",
  INCIDENT: "INCIDENT",
} as const;
export type TwinFactKind = (typeof TwinFactKind)[keyof typeof TwinFactKind];

/** Critical architecture facts MUST carry a provenance/source reference. */
export const CRITICAL_KINDS: ReadonlySet<TwinFactKind> = new Set([
  TwinFactKind.ARCHITECTURE,
  TwinFactKind.SERVICE,
  TwinFactKind.API,
  TwinFactKind.DATABASE,
  TwinFactKind.DEPENDENCY,
]);

export const Freshness = { FRESH: "FRESH", STALE: "STALE" } as const;
export type Freshness = (typeof Freshness)[keyof typeof Freshness];

export interface TwinFact {
  readonly id: string;
  readonly kind: TwinFactKind;
  /** Stable dedupe key within a kind (e.g. a service name, an API path). */
  readonly key: string;
  readonly value: unknown;
  readonly provenance?: string;
  readonly freshness: Freshness;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface UpdateProposal {
  readonly kind: TwinFactKind;
  readonly key: string;
  readonly value: unknown;
  readonly provenance?: string;
  readonly proposedBy: string;
  readonly now: string;
}

export type ProposalResult =
  | { readonly applied: true; readonly fact: TwinFact; readonly created: boolean }
  | { readonly applied: false; readonly reason: string };

export interface TwinSnapshot {
  readonly projectId: string;
  readonly facts: readonly TwinFact[];
}

/**
 * The Digital Twin Steward is the ONLY writer to the twin. Agents submit `UpdateProposal`s;
 * the steward validates (critical facts require provenance), deduplicates by (kind, key), and
 * applies. Changing repository reality can mark prior facts STALE without deleting history.
 */
export class DigitalTwinSteward {
  private readonly facts = new Map<string, TwinFact>(); // keyed by `${kind}::${key}`

  constructor(public readonly projectId: string, snapshot?: TwinSnapshot) {
    if (snapshot) for (const f of snapshot.facts) this.facts.set(`${f.kind}::${f.key}`, f);
  }

  proposeUpdate(proposal: UpdateProposal): ProposalResult {
    if (!proposal.key.trim()) return { applied: false, reason: "Proposal is missing a stable key." };
    if (CRITICAL_KINDS.has(proposal.kind) && !proposal.provenance?.trim()) {
      return {
        applied: false,
        reason: `A ${proposal.kind} fact is critical and requires a provenance/source reference.`,
      };
    }
    const mapKey = `${proposal.kind}::${proposal.key}`;
    const existing = this.facts.get(mapKey);
    const fact: TwinFact = existing
      ? {
          ...existing,
          value: proposal.value,
          provenance: proposal.provenance ?? existing.provenance,
          freshness: Freshness.FRESH,
          updatedAt: proposal.now,
        }
      : {
          id: newId("FACT"),
          kind: proposal.kind,
          key: proposal.key,
          value: proposal.value,
          provenance: proposal.provenance,
          freshness: Freshness.FRESH,
          createdAt: proposal.now,
          updatedAt: proposal.now,
        };
    this.facts.set(mapKey, fact);
    return { applied: true, fact, created: !existing };
  }

  /** Mark every fact matching the predicate STALE (e.g. after a repository change). Returns count. */
  markStale(predicate: (fact: TwinFact) => boolean, now: string): number {
    let count = 0;
    for (const [k, f] of this.facts) {
      if (f.freshness === Freshness.FRESH && predicate(f)) {
        this.facts.set(k, { ...f, freshness: Freshness.STALE, updatedAt: now });
        count++;
      }
    }
    return count;
  }

  getFact(kind: TwinFactKind, key: string): TwinFact | undefined {
    return this.facts.get(`${kind}::${key}`);
  }

  getFacts(kind?: TwinFactKind): TwinFact[] {
    const all = [...this.facts.values()];
    return (kind ? all.filter((f) => f.kind === kind) : all).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  staleFacts(): TwinFact[] {
    return this.getFacts().filter((f) => f.freshness === Freshness.STALE);
  }

  snapshot(): TwinSnapshot {
    return { projectId: this.projectId, facts: this.getFacts() };
  }
}

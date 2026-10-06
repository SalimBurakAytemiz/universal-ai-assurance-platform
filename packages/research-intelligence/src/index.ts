// @uaap/research-intelligence — the local scaffolding for the technology-scout / standards /
// advisory research pipeline: ingestion, provenance, a certify-before-active lifecycle, conflict
// resolution, and a deterministic scheduler.
//
// Two hard rules it encodes:
//  1. NO FABRICATED RESEARCH. Live external fetch is NOT performed here — LiveFetchGate always
//     returns BLOCKED_EXTERNAL_RESEARCH. The pipeline only ingests findings that were PROVIDED to it
//     (local fixtures today; a real fetcher wired in later). It can never invent a finding.
//  2. SELF-LEARNING != SELF-TRUSTING. An ingested finding is admitted only as DISCOVERED/CANDIDATE
//     (untrusted). It can NEVER be self-promoted to CERTIFIED/ACTIVE here — certification is the
//     separate knowledge/evaluation layer's authority. Provenance is mandatory (fail-closed).
import { hashObject } from "@uaap/core";

export const ResearchKind = { TECHNOLOGY: "TECHNOLOGY", STANDARD: "STANDARD", ADVISORY: "ADVISORY" } as const;
export type ResearchKind = (typeof ResearchKind)[keyof typeof ResearchKind];

/** Status an ingested finding may hold HERE. Certification/activation live in the knowledge layer. */
export const ResearchStatus = { DISCOVERED: "DISCOVERED", CANDIDATE: "CANDIDATE", SUPERSEDED: "SUPERSEDED" } as const;
export type ResearchStatus = (typeof ResearchStatus)[keyof typeof ResearchStatus];

export interface ResearchProvenance {
  readonly source: string;
  readonly method: string;
  /** ISO timestamp the finding was retrieved from its source. */
  readonly retrievedAt: string;
}
export interface ResearchItemInput {
  readonly kind: ResearchKind;
  /** Stable topic within a kind (e.g. a technology name, a standard id, an advisory id). */
  readonly topic: string;
  readonly title: string;
  readonly provenance: ResearchProvenance;
  readonly url?: string;
  readonly summary?: string;
  readonly data?: unknown;
}
export interface ResearchRecord extends ResearchItemInput {
  readonly id: string;
  readonly status: ResearchStatus;
  readonly admittedAt: string;
  readonly contentHash: string;
}

export type IngestResult =
  | { readonly ok: true; readonly record: ResearchRecord; readonly superseded?: string }
  | { readonly ok: false; readonly reason: string };

export type LiveFetchResult = { readonly status: "BLOCKED_EXTERNAL_RESEARCH"; readonly reason: string };

function validProvenance(p: ResearchProvenance | undefined): p is ResearchProvenance {
  return (
    !!p &&
    typeof p.source === "string" && p.source.trim() !== "" &&
    typeof p.method === "string" && p.method.trim() !== "" &&
    typeof p.retrievedAt === "string" && !Number.isNaN(Date.parse(p.retrievedAt))
  );
}

/**
 * Live external fetch is intentionally NOT implemented. It returns a BLOCKED_EXTERNAL_RESEARCH
 * status so the scheduler/pipeline record the blocker honestly instead of fabricating a result. A
 * real fetcher is injected only when live research is actually authorized/available.
 */
export class LiveFetchGate {
  fetch(_query: string): LiveFetchResult {
    return { status: "BLOCKED_EXTERNAL_RESEARCH", reason: "Live external research is not available/authorized in this environment; no finding is fabricated." };
  }
}

export class ResearchPipeline {
  private readonly byId = new Map<string, ResearchRecord>();
  /** topic-key (kind|topic) -> the current (non-superseded) record id. */
  private readonly current = new Map<string, string>();

  constructor(private readonly clock: { now: () => string } = { now: () => new Date().toISOString() }) {}

  // The id includes retrievedAt so successive versions from the SAME source get DISTINCT ids — a
  // newer finding never collides with (and clobbers) the record it supersedes; the supersede chain
  // stays retrievable.
  static id(kind: ResearchKind, topic: string, source: string, retrievedAt: string): string {
    return `R_${hashObject({ kind, topic, source, retrievedAt })}`.slice(0, 26);
  }

  /**
   * Ingest a PROVIDED finding (never fetched). Rejected (fail-closed) if it lacks valid provenance or
   * required fields. Admitted only as DISCOVERED. A newer finding (by provenance.retrievedAt) for the
   * same (kind, topic) SUPERSEDES the older current one; an older/equal duplicate is rejected.
   */
  ingest(input: ResearchItemInput): IngestResult {
    if (!input || typeof input !== "object") return { ok: false, reason: "input is missing" };
    if (!Object.prototype.hasOwnProperty.call(ResearchKind, input.kind)) return { ok: false, reason: `unknown research kind "${input.kind}"` };
    if (typeof input.topic !== "string" || input.topic.trim() === "") return { ok: false, reason: "topic is required" };
    if (typeof input.title !== "string" || input.title.trim() === "") return { ok: false, reason: "title is required" };
    if (!validProvenance(input.provenance)) return { ok: false, reason: "valid provenance (source, method, retrievedAt) is required — a finding without provenance is not admitted (fail-closed)" };

    const key = `${input.kind}|${input.topic}`;
    const curId = this.current.get(key);
    const cur = curId ? this.byId.get(curId) : undefined;
    if (cur && Date.parse(input.provenance.retrievedAt) <= Date.parse(cur.provenance.retrievedAt)) {
      return { ok: false, reason: `a finding at least as recent already exists for ${key} (incoming ${input.provenance.retrievedAt} <= current ${cur.provenance.retrievedAt})` };
    }
    const now = this.clock.now();
    // Defensive copy: never store references into caller-owned objects — a later caller mutation
    // must not corrupt the pipeline's dedup/supersede state or desync the contentHash.
    const provenance: ResearchProvenance = { source: input.provenance.source, method: input.provenance.method, retrievedAt: input.provenance.retrievedAt };
    const data = input.data === undefined ? undefined : structuredClone(input.data);
    const record: ResearchRecord = {
      kind: input.kind,
      topic: input.topic,
      title: input.title,
      ...(input.url !== undefined ? { url: input.url } : {}),
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
      ...(data !== undefined ? { data } : {}),
      provenance,
      id: ResearchPipeline.id(input.kind, input.topic, provenance.source, provenance.retrievedAt),
      status: ResearchStatus.DISCOVERED,
      admittedAt: now,
      contentHash: hashObject({ kind: input.kind, topic: input.topic, title: input.title, url: input.url ?? null, summary: input.summary ?? null, data: data ?? null, provenance }),
    };
    if (cur) this.byId.set(cur.id, { ...cur, status: ResearchStatus.SUPERSEDED });
    this.byId.set(record.id, record);
    this.current.set(key, record.id);
    return cur ? { ok: true, record, superseded: cur.id } : { ok: true, record };
  }

  /** The ONLY self-advance available here: DISCOVERED -> CANDIDATE. Certification is NOT done here. */
  promote(id: string): IngestResult {
    const rec = this.byId.get(id);
    if (!rec) return { ok: false, reason: `no research record "${id}"` };
    if (rec.status !== ResearchStatus.DISCOVERED) return { ok: false, reason: `only a DISCOVERED record can be promoted to CANDIDATE (is ${rec.status})` };
    const next: ResearchRecord = { ...rec, status: ResearchStatus.CANDIDATE };
    this.byId.set(id, next);
    return { ok: true, record: next };
  }

  get(id: string): ResearchRecord | undefined {
    return this.byId.get(id);
  }
  /** Current (non-superseded) records, optionally filtered by kind. */
  list(kind?: ResearchKind): ResearchRecord[] {
    const out: ResearchRecord[] = [];
    for (const id of this.current.values()) {
      const r = this.byId.get(id);
      if (r && (kind === undefined || r.kind === kind)) out.push(r);
    }
    return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
}

/** Deterministic scheduler for recurring research runs. Pure; the clock is supplied by the caller. */
export class ResearchScheduler {
  /**
   * Next run = lastRun + interval. FAIL-CLOSED: an invalid/empty lastRun throws rather than silently
   * defaulting to epoch 0 (which would make the job perpetually "due"). A first-ever run with no
   * history must be handled explicitly by the caller, not papered over with 1970.
   */
  nextRunAt(lastRunIso: string, intervalMs: number): string {
    const t = Date.parse(lastRunIso);
    if (Number.isNaN(t)) throw new Error("nextRunAt requires a valid ISO lastRun timestamp");
    return new Date(t + Math.max(0, intervalMs)).toISOString();
  }
  /** Due only when both timestamps are valid and now >= next. Invalid input => NOT due (fail-closed). */
  due(nowIso: string, nextRunAtIso: string): boolean {
    const now = Date.parse(nowIso);
    const next = Date.parse(nextRunAtIso);
    if (Number.isNaN(now) || Number.isNaN(next)) return false;
    return now >= next;
  }
}

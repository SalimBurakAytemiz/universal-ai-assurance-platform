import { DataClassification, hashObject, newId } from "@uaap/core";

/** Kinds of evidence an execution can produce. */
export const EvidenceKind = {
  LOG: "LOG",
  SCREENSHOT: "SCREENSHOT",
  VIDEO: "VIDEO",
  TRACE: "TRACE",
  HTTP: "HTTP",
  DB: "DB",
  FILE: "FILE",
  METRIC: "METRIC",
  MARKER: "MARKER",
  TEST_RESULT: "TEST_RESULT",
} as const;
export type EvidenceKind = (typeof EvidenceKind)[keyof typeof EvidenceKind];

/** An input describing evidence produced by an ACTUAL executed operation. */
export interface EvidenceInput {
  readonly runId: string;
  /** The component/adapter/agent that executed the operation. */
  readonly producedBy: string;
  /** The executed action name (e.g. "http.readonly.get"). Evidence must tie to an execution. */
  readonly action: string;
  readonly kind: EvidenceKind;
  readonly at: string;
  readonly classification: DataClassification;
  /** Reference to the stored artifact (path/uri). Never a raw secret value. */
  readonly ref?: string;
  /** Inline, non-sensitive summary data to hash (no secrets). */
  readonly data?: unknown;
  /** Short human summary. */
  readonly summary?: string;
}

export interface EvidenceRecord extends EvidenceInput {
  readonly id: string;
  /** SHA-256 over ALL integrity-relevant fields (see computeContentHash). */
  readonly contentHash: string;
  /** True for CONFIDENTIAL/RESTRICTED evidence (access-controlled, redacted in views). */
  readonly sensitive: boolean;
}

export interface EvidenceBundle {
  readonly runId: string;
  readonly recordHashes: readonly string[];
  readonly meta: Readonly<Record<string, string>>;
  /** SHA-256 over {runId, sorted record hashes, meta} — tamper-evident chain of custody. */
  readonly bundleHash: string;
  readonly count: number;
}

const VALID_CLASS = new Set<string>(Object.values(DataClassification));
const SENSITIVE = "[REDACTED]";

function clone<T>(v: T): T {
  return structuredClone(v);
}

/**
 * Content hash that commits to EVERY integrity-relevant field — including classification,
 * producedBy, kind, timestamps, ref, and data — via a canonical (key-sorted) encoding. This
 * means any mutation (e.g. flipping RESTRICTED->PUBLIC, or altering `data`) changes the hash
 * and is detected by bundle verification. There is no delimiter-concatenation ambiguity.
 */
function computeContentHash(f: EvidenceInput): string {
  // Commits to EVERY EvidenceInput field, including summary — nothing a caller provides sits
  // outside the integrity envelope.
  return hashObject({
    runId: f.runId,
    producedBy: f.producedBy,
    action: f.action,
    kind: f.kind,
    at: f.at,
    classification: f.classification,
    ref: f.ref ?? null,
    data: f.data ?? null,
    summary: f.summary ?? null,
  });
}

/** Sensitivity is a function of the (hash-committed) classification, not a mutable flag. */
function isSensitive(c: DataClassification): boolean {
  return c === DataClassification.CONFIDENTIAL || c === DataClassification.RESTRICTED;
}

/**
 * Records evidence that originates from execution and produces tamper-evident bundles.
 * Invariant: there is no evidence without an execution reference — every record requires a
 * runId, a producedBy, an executed `action`, and a concrete artifact (`ref`) or inline `data`.
 * Bundle verification RECOMPUTES each record's hash from its content, so content tampering
 * (not just add/remove) is detected.
 */
export class EvidenceStore {
  private readonly records: EvidenceRecord[] = [];

  record(input: EvidenceInput): EvidenceRecord {
    if (!input.runId?.trim()) throw new Error("Evidence requires a runId (no evidence without a run).");
    if (!input.producedBy?.trim()) throw new Error("Evidence requires producedBy (who executed it).");
    if (!input.action?.trim()) throw new Error("Evidence requires an executed action (no execution, no evidence).");
    if (!input.at?.trim()) throw new Error("Evidence requires a timestamp.");
    if (!VALID_CLASS.has(input.classification)) throw new Error(`Invalid data classification "${input.classification}".`);
    if (!input.ref?.trim() && input.data === undefined) {
      throw new Error("Evidence requires a concrete artifact reference (ref) or inline data.");
    }

    const cleaned = clone(input);
    const record: EvidenceRecord = {
      ...cleaned,
      id: newId("EV"),
      contentHash: computeContentHash(cleaned),
      sensitive: isSensitive(input.classification),
    };
    this.records.push(record);
    return clone(record);
  }

  get(id: string): EvidenceRecord | undefined {
    const r = this.records.find((x) => x.id === id);
    return r ? clone(r) : undefined;
  }

  list(runId?: string): EvidenceRecord[] {
    return this.records
      .filter((r) => !runId || r.runId === runId)
      .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
      .map(clone);
  }

  /** A view with sensitive inline content (data, summary, ref) withheld. Hashes + ids remain. */
  redactedList(runId?: string): EvidenceRecord[] {
    return this.list(runId).map((r) =>
      // Decide from the hash-committed classification, not the mutable `sensitive` flag.
      isSensitive(r.classification)
        ? { ...r, data: undefined, summary: r.summary ? SENSITIVE : undefined, ref: r.ref ? SENSITIVE : undefined }
        : r,
    );
  }

  /** Build a tamper-evident bundle; per-record hashes are RECOMPUTED from content, not trusted. */
  bundle(runId: string, meta: Record<string, string> = {}): EvidenceBundle {
    const recordHashes = this.list(runId).map((r) => computeContentHash(r)).sort();
    const bundleHash = hashObject({ runId, recordHashes, meta });
    return { runId, recordHashes, meta: { ...meta }, bundleHash, count: recordHashes.length };
  }

  /** Recompute a bundle from current record CONTENT and confirm it matches a previously issued one. */
  verifyBundle(previous: EvidenceBundle): boolean {
    const current = this.bundle(previous.runId, previous.meta);
    return current.bundleHash === previous.bundleHash;
  }
}

export { computeContentHash };

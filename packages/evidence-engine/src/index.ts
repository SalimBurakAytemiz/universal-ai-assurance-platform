import { DataClassification, hashObject, newId, sha256Hex } from "@uaap/core";

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
  /** SHA-256 over the canonical content (data if present, else ref+action+at). */
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

function clone<T>(v: T): T {
  return structuredClone(v);
}

/**
 * Records evidence that originates from execution and produces tamper-evident bundles.
 * Invariant: there is no evidence without an execution reference — every record requires a
 * runId, a producedBy, and an executed `action`. Content is hashed for chain of custody.
 */
export class EvidenceStore {
  private readonly records: EvidenceRecord[] = [];

  record(input: EvidenceInput): EvidenceRecord {
    if (!input.runId?.trim()) throw new Error("Evidence requires a runId (no evidence without a run).");
    if (!input.producedBy?.trim()) throw new Error("Evidence requires producedBy (who executed it).");
    if (!input.action?.trim()) throw new Error("Evidence requires an executed action (no execution, no evidence).");
    if (!input.at?.trim()) throw new Error("Evidence requires a timestamp.");
    if (!VALID_CLASS.has(input.classification)) throw new Error(`Invalid data classification "${input.classification}".`);

    const contentHash =
      input.data !== undefined
        ? hashObject({ action: input.action, data: input.data })
        : sha256Hex(`${input.action}|${input.ref ?? ""}|${input.at}|${input.runId}`);
    const sensitive =
      input.classification === DataClassification.CONFIDENTIAL ||
      input.classification === DataClassification.RESTRICTED;

    const record: EvidenceRecord = { ...clone(input), id: newId("EV"), contentHash, sensitive };
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

  /** A view with inline data stripped from sensitive records (refs + hashes remain). */
  redactedList(runId?: string): EvidenceRecord[] {
    return this.list(runId).map((r) => (r.sensitive ? { ...r, data: undefined } : r));
  }

  /** Build a tamper-evident bundle for a run. The hash commits to the records and the metadata. */
  bundle(runId: string, meta: Record<string, string> = {}): EvidenceBundle {
    const recordHashes = this.list(runId).map((r) => r.contentHash).sort();
    const bundleHash = hashObject({ runId, recordHashes, meta });
    return { runId, recordHashes, meta: { ...meta }, bundleHash, count: recordHashes.length };
  }

  /** Recompute a bundle's hash from current records and confirm it matches a previously issued one. */
  verifyBundle(previous: EvidenceBundle): boolean {
    const current = this.bundle(previous.runId, previous.meta);
    return current.bundleHash === previous.bundleHash;
  }
}

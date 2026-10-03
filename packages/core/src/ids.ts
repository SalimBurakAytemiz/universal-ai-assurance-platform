import { createHash, randomUUID } from "node:crypto";

/** Generate a prefixed, collision-resistant id, e.g. newId("RUN") -> "RUN_01H...". */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

/** Deterministic, key-sorted JSON stringification for stable hashing / chain of custody. */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** SHA-256 hex of a string or buffer. */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** SHA-256 hex of the canonical form of any JSON-serializable value. */
export function hashObject(value: unknown): string {
  return sha256Hex(canonicalStringify(value));
}

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

/**
 * Canonical form of a human/agent identity for separation-of-duties comparison. It (1) applies Unicode
 * compatibility normalization (NFKC), (2) STRIPS invisible characters — control (Cc), format (Cf), and
 * default-ignorable code points such as zero-width spaces, the BOM, soft hyphen, and bidi/joiner
 * controls — and (3) trims and case-folds (lower-cases). So case variants, compatibility re-encodings,
 * precomposed-vs-decomposed forms, surrounding whitespace, and invisible-character injections all
 * collapse to the same string: a single actor cannot evade an SoD "X must differ from Y" guard by
 * re-encoding or decorating the same name with invisible glyphs. Shared by the verification,
 * remediation, and release-gate engines so the SoD identity-equality rule is identical everywhere.
 *
 * This is a best-effort identity-sanity normalization, not a cryptographic identity system: `.toLowerCase()`
 * approximates (does not fully implement) Unicode case folding, so a few exotic code points (e.g. ß↔ss)
 * remain un-folded. The identities it guards are component/agent ids and attested human owner/approver
 * references, so that residual is accepted; the guard's purpose is to stop accidental or trivially
 * re-encoded self-approval, not to adjudicate adversarial pseudonymity (two genuinely different strings
 * are, by design, two different actors).
 */
export function canonicalIdentity(s: string | undefined | null): string {
  return (s ?? "")
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, "")
    .trim()
    .toLowerCase();
}

/** SHA-256 hex of a string or buffer. */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** SHA-256 hex of the canonical form of any JSON-serializable value. */
export function hashObject(value: unknown): string {
  return sha256Hex(canonicalStringify(value));
}

import Ajv2020 from "ajv/dist/2020.js";
import { sha256Hex, hashObject, type ActionRequest } from "@uaap/core";
import type { TargetAdapter, AdapterResult } from "@uaap/tool-broker";

/**
 * Deterministic-first adapters. These perform local, pure computation (no external target),
 * demonstrating the adapter contract and the principle that reliably-deterministic work is done
 * by code rather than by an LLM. They are `TargetAdapter`-compatible so they can be registered
 * with the Tool Broker when a run needs them.
 */

/**
 * Computes SHA-256 of `request.input`. A string hashes to the standard SHA-256 of that string
 * (so results match external tools / known-answer vectors); an object hashes via the canonical
 * key-sorted form. By design this means a string equals the SHA-256 of its exact bytes — a
 * string and an equivalent serialized object can therefore share a digest; callers that need
 * them distinguished should tag the input type before hashing.
 */
export class HashAdapter implements TargetAdapter {
  readonly capability = "hash";
  supports(action: string): boolean {
    return action === "hash.sha256";
  }
  execute(request: ActionRequest): AdapterResult {
    // Strings hash as-is; objects hash via the canonical (key-sorted) form so equal inputs
    // with different key order produce the same digest.
    const digest =
      typeof request.input === "string" ? sha256Hex(request.input) : hashObject(request.input ?? null);
    return { output: { sha256: digest }, evidenceRef: `hash:${digest.slice(0, 12)}` };
  }
}

/** Validates `request.input = { schema, data }` with Ajv (deterministic contract check). */
export class SchemaValidateAdapter implements TargetAdapter {
  readonly capability = "schema";
  supports(action: string): boolean {
    return action === "schema.validate";
  }
  execute(request: ActionRequest): AdapterResult {
    const input = (request.input ?? {}) as { schema?: object; data?: unknown };
    if (!input.schema || typeof input.schema !== "object") {
      return { output: { valid: false, errors: ["no schema provided"] } };
    }
    try {
      // A fresh Ajv per call: compiling a $id-bearing schema twice on a shared instance throws
      // ("schema with key or id already exists"). A caller-supplied schema must never crash the
      // broker call — a malformed schema yields a validation failure, not an unhandled throw.
      const validate = new Ajv2020({ allErrors: true, strict: false }).compile(input.schema);
      const valid = validate(input.data) as boolean;
      const errors = valid
        ? []
        : (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`.trim());
      return { output: { valid, errors } };
    } catch (e) {
      return { output: { valid: false, errors: [`invalid schema: ${(e as Error).message}`] } };
    }
  }
}

export interface AdapterDescriptor {
  readonly id: string;
  readonly version: string;
  readonly capability: string;
  readonly actions: readonly string[];
  readonly riskClass: string;
  readonly deterministic?: boolean;
  readonly health: "HEALTHY" | "DEGRADED" | "NOT_IMPLEMENTED";
}

/** In-memory registry of adapter instances keyed by capability. */
export class AdapterRegistry {
  private readonly adapters = new Map<string, TargetAdapter>();

  register(adapter: TargetAdapter): this {
    this.adapters.set(adapter.capability, adapter);
    return this;
  }

  get(capability: string): TargetAdapter | undefined {
    return this.adapters.get(capability);
  }

  capabilities(): string[] {
    return [...this.adapters.keys()];
  }

  /** A map suitable for passing to the Tool Broker's `adapters` dependency. */
  asBrokerMap(): ReadonlyMap<string, TargetAdapter> {
    return new Map(this.adapters);
  }
}

/** Build the default registry of built-in deterministic adapters. */
export function createDefaultAdapterRegistry(): AdapterRegistry {
  return new AdapterRegistry().register(new HashAdapter()).register(new SchemaValidateAdapter());
}

import Ajv2020 from "ajv/dist/2020.js";
import { sha256Hex, type ActionRequest } from "@uaap/core";
import type { TargetAdapter, AdapterResult } from "@uaap/tool-broker";

/**
 * Deterministic-first adapters. These perform local, pure computation (no external target),
 * demonstrating the adapter contract and the principle that reliably-deterministic work is done
 * by code rather than by an LLM. They are `TargetAdapter`-compatible so they can be registered
 * with the Tool Broker when a run needs them.
 */

/** Computes SHA-256 of `request.input` (coerced to string). */
export class HashAdapter implements TargetAdapter {
  readonly capability = "hash";
  supports(action: string): boolean {
    return action === "hash.sha256";
  }
  execute(request: ActionRequest): AdapterResult {
    const data = typeof request.input === "string" ? request.input : JSON.stringify(request.input ?? null);
    const digest = sha256Hex(data);
    return { output: { sha256: digest }, evidenceRef: `hash:${digest.slice(0, 12)}` };
  }
}

/** Validates `request.input = { schema, data }` with Ajv (deterministic contract check). */
export class SchemaValidateAdapter implements TargetAdapter {
  readonly capability = "schema";
  private readonly ajv = new Ajv2020({ allErrors: true, strict: false });
  supports(action: string): boolean {
    return action === "schema.validate";
  }
  execute(request: ActionRequest): AdapterResult {
    const input = (request.input ?? {}) as { schema?: object; data?: unknown };
    if (!input.schema) {
      return { output: { valid: false, errors: ["no schema provided"] } };
    }
    const validate = this.ajv.compile(input.schema);
    const valid = validate(input.data) as boolean;
    const errors = valid ? [] : (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`.trim());
    return { output: { valid, errors } };
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

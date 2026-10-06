// @uaap/quality-api-engine — a strict API CONTRACT assurance engine implementing the shared
// @uaap/engine-core lifecycle. It validates recorded request/response EXCHANGES against an API
// contract: response schema (Ajv/JSON-Schema/OpenAPI-style), request contract, required headers,
// null/empty required fields, undocumented status codes, schema drift, and negative-case handling.
//
// It is OFFLINE-ONLY: it inspects exchanges that were already captured (local fixtures or, in a live
// run, exchanges a broker-backed transport produced) — it NEVER calls a target itself, so there is
// no Agent→Target path here and nothing to authorize. A real pass/fail is derived only from real
// data; it never fabricates a pass.
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { ErrorObject, ValidateFunction } from "ajv";
import type { Severity } from "@uaap/core";
import {
  CancellationToken,
  finding,
  HealthStatus,
  type Discovery,
  type EngineCapabilities,
  type EngineCollector,
  type EngineContext,
  type EngineFinding,
  type EngineHealth,
  type EnginePlan,
  type ExecutionEngine,
  type PrereqResult,
} from "@uaap/engine-core";

export interface ResponseContract {
  readonly schema?: object;
  readonly requiredHeaders?: readonly string[];
}
export interface EndpointSpec {
  readonly id: string;
  readonly method: string;
  readonly path: string;
  readonly request?: { readonly schema?: object; readonly requiredHeaders?: readonly string[] };
  /** Response contracts keyed by HTTP status (as a string, e.g. "200", "404"). */
  readonly responses: Readonly<Record<string, ResponseContract>>;
}
export interface ApiSpec {
  readonly endpoints: readonly EndpointSpec[];
}
export interface Exchange {
  readonly endpointId: string;
  /** Mark an intentionally-invalid request: its response MUST be a 4xx, else a defect. */
  readonly negative?: boolean;
  readonly request?: { readonly headers?: Readonly<Record<string, unknown>>; readonly body?: unknown };
  readonly response: { readonly status: number; readonly headers?: Readonly<Record<string, unknown>>; readonly body?: unknown };
}
export interface ApiEngineInput {
  readonly spec: ApiSpec;
  readonly exchanges: readonly Exchange[];
}

const SEV = { P0: "P0", P1: "P1", P2: "P2", P3: "P3" } as const;

/** Classify an Ajv response-schema error into a defect kind + severity. */
function classifyAjvError(e: ErrorObject): { kind: string; severity: Severity } {
  switch (e.keyword) {
    case "additionalProperties":
      return { kind: "schema-drift", severity: SEV.P2 }; // response carries a field the contract forbids
    case "required":
      return { kind: "missing-required-field", severity: SEV.P1 };
    case "format":
      return { kind: "format-violation", severity: SEV.P2 };
    default:
      return { kind: "response-contract-violation", severity: SEV.P1 };
  }
}

function lc(headers: Readonly<Record<string, unknown>> | undefined): Set<string> {
  return new Set(Object.keys(headers ?? {}).map((h) => h.toLowerCase()));
}

export class QualityApiEngine implements ExecutionEngine {
  private readonly ajv = addFormats(new Ajv2020({ allErrors: true, strict: false }));

  capabilities(): EngineCapabilities {
    return {
      engineId: "qa.api-contract-engine",
      domain: "QUALITY",
      version: "0.1.0",
      capabilities: [
        "api.response-contract",
        "api.request-contract",
        "api.schema-drift",
        "api.headers",
        "api.null-empty",
        "api.negative",
        "api.status-coverage",
        "api.format",
      ],
      offlineOnly: true,
    };
  }

  health(): EngineHealth {
    return { status: HealthStatus.HEALTHY };
  }

  private input(ctx: EngineContext): ApiEngineInput {
    return ctx.input as ApiEngineInput;
  }

  discover(ctx: EngineContext): Discovery {
    const { spec, exchanges } = this.input(ctx);
    return {
      items: exchanges ?? [],
      summary: `${spec?.endpoints?.length ?? 0} endpoint(s), ${exchanges?.length ?? 0} exchange(s)`,
    };
  }

  plan(ctx: EngineContext, _discovery: Discovery): EnginePlan {
    const { exchanges } = this.input(ctx);
    return {
      // Guard malformed (null/non-object) elements here too — execute reports them as findings.
      steps: (exchanges ?? []).map((x, i) => ({ index: i, endpointId: x?.endpointId, status: x?.response?.status })),
      summary: `validate ${exchanges?.length ?? 0} exchange(s) against the contract`,
    };
  }

  validatePrereqs(ctx: EngineContext, _plan: EnginePlan): PrereqResult {
    const input = this.input(ctx);
    const missing: string[] = [];
    if (!input || typeof input !== "object") missing.push("input is missing");
    else {
      if (!input.spec || !Array.isArray(input.spec.endpoints) || input.spec.endpoints.length === 0) missing.push("spec.endpoints is empty");
      if (!Array.isArray(input.exchanges)) missing.push("exchanges is not an array");
    }
    return missing.length === 0 ? { ok: true } : { ok: false, missing };
  }

  /** Compile a caller-supplied schema without letting an invalid one throw out of the engine. */
  private compile(schema: object): { validate: ValidateFunction } | { error: string } {
    try {
      return { validate: this.ajv.compile(schema) };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }

  execute(ctx: EngineContext, _plan: EnginePlan, token: CancellationToken, collector: EngineCollector): void {
    const { spec, exchanges } = this.input(ctx);
    // Build the endpoint map DEFENSIVELY: a malformed endpoint entry must not throw out of execute()
    // and void every exchange — it is skipped and reported, mirroring the per-exchange isolation.
    const byId = new Map<string, EndpointSpec>();
    for (const e of spec.endpoints) {
      if (e && typeof e === "object" && typeof (e as EndpointSpec).id === "string") byId.set((e as EndpointSpec).id, e as EndpointSpec);
      else collector.finding(finding({ severity: SEV.P2, kind: "malformed-endpoint", title: "Malformed endpoint in spec", detail: "Spec endpoint is null or has no string id; skipped.", locator: "spec.endpoints" }));
    }
    let checked = 0;
    let violationExchanges = 0;
    let totalFindings = 0;

    exchanges.forEach((x, i) => {
      token.throwIfCancelled(); // cooperative cancellation / deadline between exchanges
      const loc0 = `exchange[${i}]`;
      // Per-exchange isolation: one malformed exchange or one invalid schema must NOT void the run.
      try {
        if (!x || typeof x !== "object") {
          collector.finding(finding({ severity: SEV.P2, kind: "malformed-exchange", title: "Malformed exchange", detail: "Exchange is null or not an object.", locator: loc0 }));
          return;
        }
        const loc = `${loc0} ${x.endpointId}`;
        const ep = byId.get(x.endpointId);
        if (!ep) {
          collector.finding(finding({ severity: SEV.P2, kind: "unknown-endpoint", title: "Exchange references an unknown endpoint", detail: `No endpoint "${x.endpointId}" in the spec; coverage cannot be asserted.`, locator: loc }));
          return;
        }
        checked++;
        let v = 0;
        const add = (f: EngineFinding) => {
          v++;
          totalFindings++;
          collector.finding(f);
        };
        const statusKey = String(x.response?.status);
        const contract = ep.responses[statusKey];

        // Negative case: an intentionally-invalid request must be rejected (4xx).
        if (x.negative) {
          const s = x.response?.status ?? 0;
          if (!(s >= 400 && s < 500)) {
            add(finding({ severity: SEV.P1, kind: "negative-case-accepted", title: "Invalid request was not rejected", detail: `Negative exchange returned status ${s}; expected a 4xx client error.`, locator: loc }));
          }
        }

        // Status coverage: the returned status must be documented.
        if (!contract) {
          add(finding({ severity: SEV.P2, kind: "undocumented-status", title: "Undocumented response status", detail: `${ep.method} ${ep.path} returned status ${statusKey}, which is not declared in the contract.`, locator: loc }));
        } else {
          // Required response headers.
          const present = lc(x.response?.headers);
          for (const h of contract.requiredHeaders ?? []) {
            if (!present.has(h.toLowerCase())) {
              add(finding({ severity: SEV.P2, kind: "missing-response-header", title: "Missing required response header", detail: `Response is missing required header "${h}".`, locator: loc }));
            }
          }
          // Response body against the response schema.
          if (contract.schema) {
            const c = this.compile(contract.schema);
            if ("error" in c) {
              add(finding({ severity: SEV.P2, kind: "invalid-contract-schema", title: "Response contract schema is invalid", detail: c.error, locator: loc }));
            } else {
              if (!(c.validate(x.response?.body) as boolean)) {
                for (const e of c.validate.errors ?? []) {
                  const { kind, severity } = classifyAjvError(e);
                  add(finding({ severity, kind, title: "Response contract violation", detail: `${e.instancePath || "/"} ${e.message ?? ""}`.trim(), locator: loc }));
                }
              }
              // Null/empty required-field check (nested-aware): a required string that is "".
              for (const f of emptyRequiredStrings(contract.schema, x.response?.body)) {
                add(finding({ severity: SEV.P2, kind: "null-or-empty-required-field", title: "Required field is empty", detail: `Required field "${f}" is present but empty.`, locator: loc }));
              }
            }
          }
        }

        // Request contract (positive exchanges only — a negative one is invalid by design). The body
        // is validated even when absent: a missing-but-required request body is a real defect.
        if (!x.negative && ep.request?.schema) {
          const c = this.compile(ep.request.schema);
          if ("error" in c) {
            add(finding({ severity: SEV.P2, kind: "invalid-contract-schema", title: "Request contract schema is invalid", detail: c.error, locator: loc }));
          } else if (!(c.validate(x.request?.body) as boolean)) {
            for (const e of c.validate.errors ?? []) {
              add(finding({ severity: SEV.P2, kind: "request-contract-violation", title: "Request contract violation", detail: `${e.instancePath || "/"} ${e.message ?? ""}`.trim(), locator: loc }));
            }
          }
          // Null/empty required-field check on the REQUEST too (symmetry with the response side).
          for (const f of emptyRequiredStrings(ep.request.schema, x.request?.body)) {
            add(finding({ severity: SEV.P2, kind: "null-or-empty-required-field", title: "Required request field is empty", detail: `Required request field "${f}" is present but empty.`, locator: loc }));
          }
        }
        // Required request headers (positive exchanges).
        if (!x.negative && ep.request?.requiredHeaders?.length) {
          const present = lc(x.request?.headers);
          for (const h of ep.request.requiredHeaders) {
            if (!present.has(h.toLowerCase())) {
              add(finding({ severity: SEV.P2, kind: "missing-request-header", title: "Missing required request header", detail: `Request is missing required header "${h}".`, locator: loc }));
            }
          }
        }

        if (v > 0) violationExchanges++;
        // One evidence record per exchange — ties the verdict to real inspected data (no secrets).
        collector.evidence({
          producedBy: "qa.api-contract-engine",
          action: "api.contract.validate",
          kind: "TEST_RESULT",
          classification: "INTERNAL",
          summary: `${ep.method} ${ep.path} -> ${statusKey}: ${v} violation(s)`,
          data: { endpointId: x.endpointId, status: x.response?.status, negative: !!x.negative, violations: v, at: ctx.now() },
        });
      } catch (e) {
        // Totality: never let one exchange abort the rest. Record the engine error as a finding.
        collector.finding(finding({ severity: SEV.P2, kind: "engine-error", title: "Engine error while checking exchange", detail: e instanceof Error ? e.message : String(e), locator: loc0 }));
      }
    });

    collector.artifact({
      kind: "api-contract-summary",
      summary: `${checked} exchange(s) checked against ${spec.endpoints.length} endpoint(s); ${violationExchanges} with violations`,
      data: { endpoints: spec.endpoints.length, exchangesChecked: checked, exchangesWithViolations: violationExchanges, totalFindings },
    });
  }
}

interface SchemaView {
  type?: string;
  properties: Record<string, unknown>;
  required: string[];
  items?: object;
}

/**
 * Collapse a schema node to an effective view, flattening `allOf` members (shallow + recursive) and
 * NOT depending on an explicit `type` keyword — a node with `properties`/`items`/`required` is an
 * object/array schema in JSON Schema whether or not `type` is stated, matching how Ajv treats it.
 */
function schemaView(schema: unknown): SchemaView {
  const s = (schema && typeof schema === "object" ? schema : {}) as {
    type?: string;
    properties?: Record<string, unknown>;
    required?: unknown;
    items?: unknown;
    allOf?: unknown[];
  };
  let properties: Record<string, unknown> = { ...(s.properties ?? {}) };
  let required: string[] = Array.isArray(s.required) ? s.required.filter((r): r is string => typeof r === "string") : [];
  let items = (s.items && typeof s.items === "object" ? s.items : undefined) as object | undefined;
  let type = s.type;
  if (Array.isArray(s.allOf)) {
    for (const member of s.allOf) {
      const mv = schemaView(member);
      properties = { ...properties, ...mv.properties };
      required = [...required, ...mv.required];
      items = items ?? mv.items;
      type = type ?? mv.type;
    }
  }
  return { ...(type !== undefined ? { type } : {}), properties, required, ...(items ? { items } : {}) };
}

/**
 * Required-string property names (dotted/bracketed path) that are present but equal to "". Recurses
 * into nested objects and arrays-of-objects, infers structure WITHOUT needing an explicit `type`, and
 * flattens `allOf`. It is a heuristic augmentation over Ajv (JSON Schema has no "required AND
 * non-empty" without minLength). LIMITATION: it does not resolve `$ref` or branch `oneOf`/`anyOf`
 * composition — for guaranteed non-empty enforcement across any schema shape use `minLength: 1`,
 * which Ajv validates natively everywhere (and is reported as a normal contract violation here).
 */
function emptyRequiredStrings(schema: object, body: unknown, prefix = ""): string[] {
  if (!schema || typeof schema !== "object" || body === null || body === undefined) return [];
  const eff = schemaView(schema);
  const join = (p: string, k: string): string => (p ? `${p}.${k}` : k);
  const has = (o: Record<string, unknown>, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
  const out: string[] = [];
  // Array shape: `items` present and the body is an array — recurse into each element.
  if (eff.items && Array.isArray(body)) {
    body.forEach((el, i) => out.push(...emptyRequiredStrings(eff.items as object, el, `${prefix}[${i}]`)));
    return out;
  }
  if (typeof body !== "object") return out;
  const rec = body as Record<string, unknown>;
  for (const key of eff.required) {
    const prop = eff.properties[key] as { type?: string } | undefined;
    if (prop?.type === "string" && has(rec, key) && rec[key] === "") out.push(join(prefix, key));
  }
  for (const [key, prop] of Object.entries(eff.properties)) {
    if (!prop || typeof prop !== "object" || !has(rec, key)) continue;
    const cv = schemaView(prop);
    const structural = Object.keys(cv.properties).length > 0 || cv.items !== undefined || cv.required.length > 0;
    if (structural) out.push(...emptyRequiredStrings(prop as object, rec[key], join(prefix, key)));
  }
  return out;
}

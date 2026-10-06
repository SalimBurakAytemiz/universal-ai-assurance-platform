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
import type { ErrorObject } from "ajv";
import type { Severity } from "@uaap/core";
import {
  CancellationToken,
  finding,
  HealthStatus,
  type Discovery,
  type EngineArtifact,
  type EngineCapabilities,
  type EngineContext,
  type EngineEvidence,
  type EngineExecOutput,
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
      steps: (exchanges ?? []).map((x, i) => ({ index: i, endpointId: x.endpointId, status: x.response?.status })),
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

  execute(ctx: EngineContext, _plan: EnginePlan, token: CancellationToken): EngineExecOutput {
    const { spec, exchanges } = this.input(ctx);
    const byId = new Map(spec.endpoints.map((e) => [e.id, e]));
    const findings: EngineFinding[] = [];
    const evidence: EngineEvidence[] = [];
    let checked = 0;
    let violationExchanges = 0;

    exchanges.forEach((x, i) => {
      token.throwIfCancelled(); // cooperative cancellation / timeout between exchanges
      const loc = `exchange[${i}] ${x.endpointId}`;
      const ep = byId.get(x.endpointId);
      if (!ep) {
        findings.push(finding({ severity: SEV.P2, kind: "unknown-endpoint", title: "Exchange references an unknown endpoint", detail: `No endpoint "${x.endpointId}" in the spec; coverage cannot be asserted.`, locator: loc }));
        return;
      }
      checked++;
      const before = findings.length;
      const statusKey = String(x.response?.status);
      const contract = ep.responses[statusKey];

      // Negative case: an intentionally-invalid request must be rejected (4xx).
      if (x.negative) {
        const s = x.response?.status ?? 0;
        if (!(s >= 400 && s < 500)) {
          findings.push(finding({ severity: SEV.P1, kind: "negative-case-accepted", title: "Invalid request was not rejected", detail: `Negative exchange returned status ${s}; expected a 4xx client error.`, locator: loc }));
        }
      }

      // Status coverage: the returned status must be documented.
      if (!contract) {
        findings.push(finding({ severity: SEV.P2, kind: "undocumented-status", title: "Undocumented response status", detail: `${ep.method} ${ep.path} returned status ${statusKey}, which is not declared in the contract.`, locator: loc }));
      } else {
        // Required response headers.
        const present = lc(x.response?.headers);
        for (const h of contract.requiredHeaders ?? []) {
          if (!present.has(h.toLowerCase())) {
            findings.push(finding({ severity: SEV.P2, kind: "missing-response-header", title: "Missing required response header", detail: `Response is missing required header "${h}".`, locator: loc }));
          }
        }
        // Response body against the response schema.
        if (contract.schema) {
          const validate = this.ajv.compile(contract.schema);
          const ok = validate(x.response?.body) as boolean;
          if (!ok) {
            for (const e of validate.errors ?? []) {
              const { kind, severity } = classifyAjvError(e);
              findings.push(finding({ severity, kind, title: "Response contract violation", detail: `${e.instancePath || "/"} ${e.message ?? ""}`.trim(), locator: loc }));
            }
          }
          // Null/empty required-field check (beyond type errors): a required string that is "".
          for (const f of emptyRequiredStrings(contract.schema, x.response?.body)) {
            findings.push(finding({ severity: SEV.P2, kind: "null-or-empty-required-field", title: "Required field is empty", detail: `Required field "${f}" is present but empty.`, locator: loc }));
          }
        }
      }

      // Request contract (positive exchanges only — a negative one is invalid by design).
      if (!x.negative && ep.request?.schema && x.request?.body !== undefined) {
        const validate = this.ajv.compile(ep.request.schema);
        if (!(validate(x.request.body) as boolean)) {
          for (const e of validate.errors ?? []) {
            findings.push(finding({ severity: SEV.P2, kind: "request-contract-violation", title: "Request contract violation", detail: `${e.instancePath || "/"} ${e.message ?? ""}`.trim(), locator: loc }));
          }
        }
      }

      const violations = findings.length - before;
      if (violations > 0) violationExchanges++;
      // One evidence record per exchange — ties the verdict to real inspected data (no secrets).
      evidence.push({
        producedBy: "qa.api-contract-engine",
        action: "api.contract.validate",
        kind: "TEST_RESULT",
        classification: "INTERNAL",
        summary: `${ep.method} ${ep.path} -> ${statusKey}: ${violations} violation(s)`,
        data: { endpointId: x.endpointId, status: x.response?.status, negative: !!x.negative, violations, at: ctx.now() },
      });
    });

    const artifacts: EngineArtifact[] = [
      {
        kind: "api-contract-summary",
        summary: `${checked} exchange(s) checked against ${spec.endpoints.length} endpoint(s); ${violationExchanges} with violations`,
        data: { endpoints: spec.endpoints.length, exchangesChecked: checked, exchangesWithViolations: violationExchanges, totalFindings: findings.length },
      },
    ];

    return { findings, artifacts, evidence };
  }
}

/** Return required-string property names that are present in `body` but equal to "". */
function emptyRequiredStrings(schema: object, body: unknown): string[] {
  const s = schema as { properties?: Record<string, { type?: string }>; required?: string[] };
  if (!s || typeof body !== "object" || body === null || !Array.isArray(s.required)) return [];
  const out: string[] = [];
  const rec = body as Record<string, unknown>;
  for (const key of s.required) {
    const prop = s.properties?.[key];
    if (prop?.type === "string" && Object.prototype.hasOwnProperty.call(rec, key) && rec[key] === "") out.push(key);
  }
  return out;
}

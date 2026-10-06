import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { driveEngine, EngineStatus, type EngineContext } from "@uaap/engine-core";
import { QualityApiEngine, type ApiEngineInput } from "@uaap/quality-api-engine";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, "..", "fixtures", "users-api.json"), "utf8")) as ApiEngineInput;

let t = 0;
function ctx(input: unknown): EngineContext {
  return { runId: "RUN-API", input, now: () => new Date(Date.UTC(2026, 9, 6, 0, 0, t++)).toISOString() };
}
function kinds(findings: readonly { kind: string }[]): Set<string> {
  return new Set(findings.map((f) => f.kind));
}

describe("QualityApiEngine — contract validation against the local fixture", () => {
  it("drives to DONE and detects every planted defect class", async () => {
    const r = await driveEngine(new QualityApiEngine(), ctx(fixture));
    expect(r.status).toBe(EngineStatus.DONE);
    const k = kinds(r.findings);
    for (const expected of [
      "schema-drift",
      "missing-response-header",
      "response-contract-violation",
      "format-violation",
      "null-or-empty-required-field",
      "undocumented-status",
      "negative-case-accepted",
      "request-contract-violation",
      "unknown-endpoint",
    ]) {
      expect(k, expected).toContain(expected);
    }
  });

  it("does NOT flag the clean exchanges (no fake findings)", async () => {
    const r = await driveEngine(new QualityApiEngine(), ctx(fixture));
    // exchange[0] (valid 200) and exchange[4] (valid 404) must have zero violations in their evidence.
    const ev0 = r.evidence.find((e) => (e.data as { status?: number })?.status === 200 && (e.summary ?? "").includes("200: 0 violation"));
    expect(ev0).toBeDefined();
    const ev404 = r.evidence.find((e) => (e.data as { status?: number })?.status === 404);
    expect((ev404?.data as { violations?: number })?.violations).toBe(0);
  });

  it("emits one evidence record per known-endpoint exchange (ties verdict to real data)", async () => {
    const r = await driveEngine(new QualityApiEngine(), ctx(fixture));
    // 8 exchanges; the last (ghost) is an unknown endpoint -> no evidence, only a finding.
    expect(r.evidence).toHaveLength(7);
    expect(r.artifacts[0]?.kind).toBe("api-contract-summary");
  });

  it("schema drift (additionalProperties) and a missing header are both reported for exchange[1]", async () => {
    const r = await driveEngine(new QualityApiEngine(), ctx(fixture));
    const forX1 = r.findings.filter((f) => f.locator === "exchange[1] getUser");
    expect(forX1.map((f) => f.kind)).toContain("schema-drift");
    expect(forX1.map((f) => f.kind)).toContain("missing-response-header");
  });

  it("PREREQ_FAILED on a spec with no endpoints (fail-closed, not a fake pass)", async () => {
    const r = await driveEngine(new QualityApiEngine(), ctx({ spec: { endpoints: [] }, exchanges: [] }));
    expect(r.status).toBe(EngineStatus.PREREQ_FAILED);
    expect(r.findings[0]?.detail).toMatch(/endpoints is empty/);
  });

  it("a fully-conformant set yields DONE with zero findings — a REAL pass", async () => {
    const clean: ApiEngineInput = {
      spec: {
        endpoints: [
          {
            id: "ping",
            method: "GET",
            path: "/ping",
            responses: { "200": { schema: { type: "object", required: ["ok"], additionalProperties: false, properties: { ok: { type: "boolean" } } } } },
          },
        ],
      },
      exchanges: [{ endpointId: "ping", response: { status: 200, body: { ok: true } } }],
    };
    const r = await driveEngine(new QualityApiEngine(), ctx(clean));
    expect(r.status).toBe(EngineStatus.DONE);
    expect(r.findings).toHaveLength(0);
    expect(r.counts.findings).toBe(0);
  });

  it("reports engine capabilities and offline-only safety", () => {
    const caps = new QualityApiEngine().capabilities();
    expect(caps.engineId).toBe("qa.api-contract-engine");
    expect(caps.domain).toBe("QUALITY");
    expect(caps.offlineOnly).toBe(true);
    expect(caps.capabilities).toContain("api.schema-drift");
  });
});

describe("QualityApiEngine — review-fix regressions (no false negatives, total execution)", () => {
  const drive = (input: unknown) => driveEngine(new QualityApiEngine(), ctx(input));

  it("flags a missing-but-required request body (request contract no longer gated on body presence)", async () => {
    const input: ApiEngineInput = {
      spec: { endpoints: [{ id: "createUser", method: "POST", path: "/users", request: { schema: { type: "object", required: ["email", "name"], properties: { email: { type: "string" }, name: { type: "string" } } } }, responses: { "201": {} } }] },
      exchanges: [{ endpointId: "createUser", request: {}, response: { status: 201, body: {} } }],
    };
    const r = await drive(input);
    expect(r.status).toBe(EngineStatus.DONE);
    expect(r.findings.map((f) => f.kind)).toContain("request-contract-violation");
  });

  it("flags a missing required REQUEST header", async () => {
    const input: ApiEngineInput = {
      spec: { endpoints: [{ id: "createUser", method: "POST", path: "/users", request: { requiredHeaders: ["authorization"] }, responses: { "201": {} } }] },
      exchanges: [{ endpointId: "createUser", request: { headers: {}, body: { x: 1 } }, response: { status: 201, body: {} } }],
    };
    const r = await drive(input);
    expect(r.findings.map((f) => f.kind)).toContain("missing-request-header");
  });

  it("a single invalid contract schema does NOT void the whole run — other exchanges still validated", async () => {
    const input: ApiEngineInput = {
      spec: {
        endpoints: [
          { id: "a", method: "GET", path: "/a", responses: { "200": { schema: { type: "object", additionalProperties: false, properties: { id: { type: "integer" } } } } } },
          { id: "b", method: "GET", path: "/b", responses: { "200": { schema: { type: "object", properties: "not-an-object" } as unknown as object } } },
        ],
      },
      exchanges: [
        { endpointId: "a", response: { status: 200, body: { id: 1, leak: "secret" } } }, // real schema-drift
        { endpointId: "b", response: { status: 200, body: {} } }, // invalid schema
      ],
    };
    const r = await drive(input);
    expect(r.status).toBe(EngineStatus.DONE); // not FAILED
    const kinds = r.findings.map((f) => f.kind);
    expect(kinds).toContain("schema-drift"); // exchange a was still checked
    expect(kinds).toContain("invalid-contract-schema"); // exchange b reported, not thrown
  });

  it("a malformed (null) exchange is reported and the rest still run", async () => {
    const input = {
      spec: { endpoints: [{ id: "a", method: "GET", path: "/a", responses: { "200": { schema: { type: "object", required: ["id"], properties: { id: { type: "integer" } } } } } }] },
      exchanges: [null, { endpointId: "a", response: { status: 200, body: {} } }],
    };
    const r = await drive(input);
    expect(r.status).toBe(EngineStatus.DONE);
    const kinds = r.findings.map((f) => f.kind);
    expect(kinds).toContain("malformed-exchange");
    expect(kinds).toContain("missing-required-field"); // the valid exchange was still checked
  });

  it("detects a NESTED required empty string (api.null-empty is not top-level only)", async () => {
    const input: ApiEngineInput = {
      spec: {
        endpoints: [{ id: "a", method: "GET", path: "/a", responses: { "200": { schema: { type: "object", required: ["profile"], properties: { profile: { type: "object", required: ["name"], properties: { name: { type: "string" } } } } } } } }],
      },
      exchanges: [{ endpointId: "a", response: { status: 200, body: { profile: { name: "" } } } }],
    };
    const r = await drive(input);
    const empty = r.findings.find((f) => f.kind === "null-or-empty-required-field");
    expect(empty).toBeDefined();
    expect(empty?.detail).toMatch(/profile\.name/);
  });
});

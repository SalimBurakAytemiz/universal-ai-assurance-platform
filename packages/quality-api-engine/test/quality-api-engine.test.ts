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

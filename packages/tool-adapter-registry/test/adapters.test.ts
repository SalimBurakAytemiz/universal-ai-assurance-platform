import { describe, it, expect } from "vitest";
import {
  ActionClass,
  AssuranceDomain,
  DataClassification,
  Environment,
  Mode,
  sha256Hex,
  type ActionRequest,
} from "@uaap/core";
import {
  AdapterRegistry,
  HashAdapter,
  SchemaValidateAdapter,
  createDefaultAdapterRegistry,
} from "@uaap/tool-adapter-registry";

function req(action: string, input: unknown): ActionRequest {
  return {
    requestId: "R",
    runId: "RUN",
    requestedBy: "agent:test",
    mode: Mode.INTERNAL_OWNED,
    target: { id: "local", name: "local", identifiers: ["local"], environment: Environment.LOCAL },
    domain: AssuranceDomain.QUALITY,
    actionClass: ActionClass.R0_PASSIVE,
    action,
    environment: Environment.LOCAL,
    dataPolicy: { maxClassification: DataClassification.INTERNAL, minimalProofOfAccessOnly: true },
    now: "2026-10-03T12:00:00.000Z",
    input,
  };
}

describe("Deterministic adapters", () => {
  it("HashAdapter computes the correct SHA-256", async () => {
    const a = new HashAdapter();
    const out = (await a.execute(req("hash.sha256", "hello"))) as { output: { sha256: string } };
    expect(out.output.sha256).toBe(sha256Hex("hello"));
  });

  it("SchemaValidateAdapter validates data against a schema", async () => {
    const a = new SchemaValidateAdapter();
    const schema = { type: "object", required: ["n"], properties: { n: { type: "number" } } };
    const good = (await a.execute(req("schema.validate", { schema, data: { n: 1 } }))) as { output: { valid: boolean } };
    const bad = (await a.execute(req("schema.validate", { schema, data: { n: "x" } }))) as { output: { valid: boolean } };
    expect(good.output.valid).toBe(true);
    expect(bad.output.valid).toBe(false);
  });

  it("adapters declare the actions they support", () => {
    expect(new HashAdapter().supports("hash.sha256")).toBe(true);
    expect(new HashAdapter().supports("hash.md5")).toBe(false);
  });
});

describe("AdapterRegistry", () => {
  it("registers and retrieves adapters by capability", () => {
    const reg = createDefaultAdapterRegistry();
    expect(reg.capabilities().sort()).toEqual(["hash", "schema"]);
    expect(reg.get("hash")).toBeInstanceOf(HashAdapter);
    expect(reg.get("schema")).toBeInstanceOf(SchemaValidateAdapter);
    expect(reg.get("nope")).toBeUndefined();
  });

  it("produces a broker-compatible adapter map", () => {
    const map = createDefaultAdapterRegistry().asBrokerMap();
    expect(map.has("hash")).toBe(true);
    expect(new AdapterRegistry().asBrokerMap().size).toBe(0);
  });
});

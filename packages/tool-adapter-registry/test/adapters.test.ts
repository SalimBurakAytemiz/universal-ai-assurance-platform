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
  it("HashAdapter matches a known-answer SHA-256 vector", async () => {
    const a = new HashAdapter();
    const out = (await a.execute(req("hash.sha256", "hello"))) as { output: { sha256: string } };
    // Known-answer: SHA-256("hello")
    expect(out.output.sha256).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    expect(out.output.sha256).toBe(sha256Hex("hello"));
  });

  it("HashAdapter hashes objects canonically (key order does not matter)", async () => {
    const a = new HashAdapter();
    const one = (await a.execute(req("hash.sha256", { a: 1, b: 2 }))) as { output: { sha256: string } };
    const two = (await a.execute(req("hash.sha256", { b: 2, a: 1 }))) as { output: { sha256: string } };
    expect(one.output.sha256).toBe(two.output.sha256);
  });

  it("SchemaValidateAdapter validates data against a schema", async () => {
    const a = new SchemaValidateAdapter();
    const schema = { type: "object", required: ["n"], properties: { n: { type: "number" } } };
    const good = (await a.execute(req("schema.validate", { schema, data: { n: 1 } }))) as { output: { valid: boolean } };
    const bad = (await a.execute(req("schema.validate", { schema, data: { n: "x" } }))) as { output: { valid: boolean } };
    expect(good.output.valid).toBe(true);
    expect(bad.output.valid).toBe(false);
  });

  it("SchemaValidateAdapter can validate a $id-bearing schema repeatedly without throwing", async () => {
    const a = new SchemaValidateAdapter();
    const schema = { $id: "https://uaap.local/test.json", type: "object", required: ["x"], properties: { x: { type: "string" } } };
    const first = (await a.execute(req("schema.validate", { schema, data: { x: "ok" } }))) as { output: { valid: boolean } };
    const second = (await a.execute(req("schema.validate", { schema, data: { x: "ok" } }))) as { output: { valid: boolean } };
    expect(first.output.valid).toBe(true);
    expect(second.output.valid).toBe(true); // second call must not crash on duplicate $id
  });

  it("SchemaValidateAdapter returns a failure (not a throw) on a malformed schema or missing schema", async () => {
    const a = new SchemaValidateAdapter();
    const malformed = (await a.execute(req("schema.validate", { schema: { type: "not-a-real-type" }, data: 1 }))) as {
      output: { valid: boolean; errors: string[] };
    };
    expect(malformed.output.valid).toBe(false);
    expect(malformed.output.errors.length).toBeGreaterThan(0);

    const missing = (await a.execute(req("schema.validate", {}))) as { output: { valid: boolean } };
    expect(missing.output.valid).toBe(false);
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

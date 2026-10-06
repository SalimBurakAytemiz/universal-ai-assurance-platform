import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { driveEngine, EngineStatus, type EngineContext } from "@uaap/engine-core";
import { QualityDatabaseEngine, type DbEngineInput } from "@uaap/quality-database-engine";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, "..", "fixtures", "orders-db.json"), "utf8")) as DbEngineInput;

let t = 0;
function ctx(input: unknown): EngineContext {
  return { runId: "RUN-DB", input, now: () => new Date(Date.UTC(2026, 9, 6, 0, 0, t++)).toISOString() };
}
const drive = (input: unknown) => driveEngine(new QualityDatabaseEngine(), ctx(input));
const kinds = (fs: readonly { kind: string }[]) => new Set(fs.map((f) => f.kind));

describe("QualityDatabaseEngine — read-only validation against the local fixture", () => {
  it("drives to DONE and detects every planted violation class", async () => {
    const r = await drive(fixture);
    expect(r.status).toBe(EngineStatus.DONE);
    const k = kinds(r.findings);
    for (const expected of [
      "schema-drift",
      "not-null-violation",
      "type-violation",
      "primary-key-duplicate",
      "unique-violation",
      "fk-orphan",
      "destructive-migration",
    ]) {
      expect(k, expected).toContain(expected);
    }
  });

  it("does not flag the non-destructive migration, only the destructive one", async () => {
    const r = await drive(fixture);
    const destructive = r.findings.filter((f) => f.kind === "destructive-migration");
    expect(destructive).toHaveLength(1);
    expect(destructive[0]?.locator).toBe("migration 002_drop_note");
  });

  it("emits DB evidence per table with real row/violation counts", async () => {
    const r = await drive(fixture);
    const usersEv = r.evidence.find((e) => (e.data as { table?: string })?.table === "users");
    expect((usersEv?.data as { rows?: number })?.rows).toBe(4);
    expect(r.artifacts[0]?.kind).toBe("db-validation-summary");
  });

  it("a fully-consistent dataset yields DONE with zero findings — a REAL pass", async () => {
    const clean: DbEngineInput = {
      schema: {
        tables: [
          { name: "users", columns: [{ name: "id", type: "integer" }, { name: "email", type: "string" }], primaryKey: ["id"], unique: [["email"]] },
          { name: "orders", columns: [{ name: "id", type: "integer" }, { name: "user_id", type: "integer" }], primaryKey: ["id"], foreignKeys: [{ columns: ["user_id"], refTable: "users", refColumns: ["id"] }] },
        ],
      },
      dataset: {
        users: [{ id: 1, email: "a@b.com" }, { id: 2, email: "c@d.com" }],
        orders: [{ id: 10, user_id: 1 }, { id: 11, user_id: 2 }],
      },
    };
    const r = await drive(clean);
    expect(r.status).toBe(EngineStatus.DONE);
    expect(r.findings).toHaveLength(0);
  });

  it("flags an unverifiable FK when the referenced table has no rows (fail-closed, not a pass)", async () => {
    const input: DbEngineInput = {
      schema: { tables: [{ name: "orders", columns: [{ name: "id", type: "integer" }, { name: "user_id", type: "integer" }], foreignKeys: [{ columns: ["user_id"], refTable: "users", refColumns: ["id"] }] }] },
      dataset: { orders: [{ id: 1, user_id: 5 }] },
    };
    const r = await drive(input);
    expect(kinds(r.findings)).toContain("fk-unverifiable");
  });

  it("allows a destructive migration only with explicit approval", async () => {
    const input: DbEngineInput = {
      schema: { tables: [{ name: "t", columns: [{ name: "id", type: "integer" }] }] },
      dataset: { t: [{ id: 1 }] },
      migrations: [{ id: "m1", ops: [{ kind: "drop_table", table: "t" }] }],
      allowDestructiveMigrations: true,
    };
    const r = await drive(input);
    expect(kinds(r.findings)).not.toContain("destructive-migration");
  });

  it("PREREQ_FAILED when the schema has no tables (fail-closed)", async () => {
    const r = await drive({ schema: { tables: [] }, dataset: {} });
    expect(r.status).toBe(EngineStatus.PREREQ_FAILED);
  });

  it("reports read-only, offline-only capabilities", () => {
    const caps = new QualityDatabaseEngine().capabilities();
    expect(caps.engineId).toBe("qa.database-engine");
    expect(caps.domain).toBe("DATA");
    expect(caps.offlineOnly).toBe(true);
    expect(caps.capabilities).toContain("db.foreign-key");
  });
});

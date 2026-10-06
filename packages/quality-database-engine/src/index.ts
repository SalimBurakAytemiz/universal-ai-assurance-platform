// @uaap/quality-database-engine — a READ-ONLY database assurance engine implementing the shared
// @uaap/engine-core lifecycle. It validates a provided DATASET snapshot against a declared schema
// and constraints: column/type conformance, NOT NULL, primary-key uniqueness, UNIQUE constraints,
// foreign-key referential integrity, and migration SAFETY (destructive migrations require explicit
// approval). It never connects to a database — it inspects a snapshot (local fixture today; a
// broker-backed read-only extract later), so it is OFFLINE-ONLY, has nothing to authorize, and can
// never mutate data. Every verdict is tied to real inspected rows; it never fabricates a pass.
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

export type ColumnType = "string" | "integer" | "number" | "boolean" | "timestamp" | "uuid";
export interface ColumnSpec {
  readonly name: string;
  readonly type: ColumnType;
  readonly nullable?: boolean;
}
export interface ForeignKey {
  readonly columns: readonly string[];
  readonly refTable: string;
  readonly refColumns: readonly string[];
}
export interface TableSpec {
  readonly name: string;
  readonly columns: readonly ColumnSpec[];
  readonly primaryKey?: readonly string[];
  readonly unique?: readonly (readonly string[])[];
  readonly foreignKeys?: readonly ForeignKey[];
}
export interface DbSchema {
  readonly tables: readonly TableSpec[];
}
export interface MigrationOp {
  readonly kind: string;
  readonly table?: string;
  readonly column?: string;
}
export interface Migration {
  readonly id: string;
  readonly ops: readonly MigrationOp[];
}
export interface DbEngineInput {
  readonly schema: DbSchema;
  readonly dataset: Readonly<Record<string, ReadonlyArray<Readonly<Record<string, unknown>>>>>;
  readonly migrations?: readonly Migration[];
  /** Read-only safety: destructive migrations are flagged unless this is explicitly true. */
  readonly allowDestructiveMigrations?: boolean;
}

const SEV = { P0: "P0", P1: "P1", P2: "P2", P3: "P3" } as const;

/** Migration op kinds that destroy or narrow data — forbidden under the read-only default. */
const DESTRUCTIVE_KINDS: ReadonlySet<string> = new Set(["drop_table", "drop_column", "truncate", "delete_data"]);
/** Potentially-lossy op kinds — flagged lower severity for review. */
const LOSSY_KINDS: ReadonlySet<string> = new Set(["rename_table", "rename_column", "alter_column_type", "narrow_column"]);

function typeOk(type: ColumnType, v: unknown): boolean {
  switch (type) {
    case "string":
      return typeof v === "string";
    case "integer":
      return typeof v === "number" && Number.isInteger(v);
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    case "boolean":
      return typeof v === "boolean";
    case "timestamp":
      return typeof v === "string" && !Number.isNaN(Date.parse(v));
    case "uuid":
      return typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
    default:
      return true;
  }
}

function isNullish(v: unknown): boolean {
  return v === null || v === undefined;
}
function tuple(row: Record<string, unknown>, cols: readonly string[]): unknown[] {
  return cols.map((c) => row[c]);
}

export class QualityDatabaseEngine implements ExecutionEngine {
  capabilities(): EngineCapabilities {
    return {
      engineId: "qa.database-engine",
      domain: "DATA",
      version: "0.1.0",
      capabilities: ["db.schema-conformance", "db.not-null", "db.primary-key", "db.unique", "db.foreign-key", "db.migration-safety"],
      offlineOnly: true,
    };
  }

  health(): EngineHealth {
    return { status: HealthStatus.HEALTHY };
  }

  private input(ctx: EngineContext): DbEngineInput {
    return ctx.input as DbEngineInput;
  }

  discover(ctx: EngineContext): Discovery {
    const { schema, dataset } = this.input(ctx);
    return {
      items: schema?.tables?.map((t) => t.name) ?? [],
      summary: `${schema?.tables?.length ?? 0} table(s); dataset has ${Object.keys(dataset ?? {}).length} table(s) of rows`,
    };
  }

  plan(ctx: EngineContext, _discovery: Discovery): EnginePlan {
    const { schema, migrations } = this.input(ctx);
    return {
      steps: [...(schema?.tables ?? []).map((t) => ({ table: t.name })), ...(migrations ?? []).map((m) => ({ migration: m.id }))],
      summary: `validate ${schema?.tables?.length ?? 0} table(s) and ${migrations?.length ?? 0} migration(s)`,
    };
  }

  validatePrereqs(ctx: EngineContext, _plan: EnginePlan): PrereqResult {
    const input = this.input(ctx);
    const missing: string[] = [];
    if (!input || typeof input !== "object") missing.push("input is missing");
    else {
      if (!input.schema || !Array.isArray(input.schema.tables) || input.schema.tables.length === 0) missing.push("schema.tables is empty");
      if (!input.dataset || typeof input.dataset !== "object") missing.push("dataset is missing");
    }
    return missing.length === 0 ? { ok: true } : { ok: false, missing };
  }

  execute(ctx: EngineContext, _plan: EnginePlan, token: CancellationToken, collector: EngineCollector): void {
    const { schema, dataset, migrations, allowDestructiveMigrations } = this.input(ctx);
    const tableByName = new Map<string, TableSpec>();
    for (const t of schema.tables) {
      if (t && typeof t === "object" && typeof t.name === "string") tableByName.set(t.name, t);
      else collector.finding(finding({ severity: SEV.P2, kind: "malformed-table", title: "Malformed table in schema", detail: "Schema table is null or has no string name; skipped.", locator: "schema.tables" }));
    }

    // Flag dataset tables not present in the schema (coverage gap, not silent).
    for (const name of Object.keys(dataset)) {
      if (!tableByName.has(name)) {
        collector.finding(finding({ severity: SEV.P2, kind: "unknown-table", title: "Dataset table not in schema", detail: `Dataset includes table "${name}" that the schema does not declare.`, locator: `dataset.${name}` }));
      }
    }

    for (const table of tableByName.values()) {
      token.throwIfCancelled();
      const loc = `table ${table.name}`;
      try {
        const rows = dataset[table.name];
        if (!Array.isArray(rows)) continue; // no rows supplied for this table — nothing to inspect
        const colByName = new Map(table.columns.map((c) => [c.name, c]));
        let violations = 0;
        const add = (f: EngineFinding) => {
          violations++;
          collector.finding(f);
        };

        // Row-level: column drift, missing column, not-null, type.
        rows.forEach((row, i) => {
          const rloc = `${loc} row[${i}]`;
          for (const key of Object.keys(row)) {
            if (!colByName.has(key)) add(finding({ severity: SEV.P2, kind: "schema-drift", title: "Unknown column in row", detail: `Column "${key}" is not declared on table "${table.name}".`, locator: rloc }));
          }
          for (const col of table.columns) {
            const present = Object.prototype.hasOwnProperty.call(row, col.name);
            const val = row[col.name];
            if (!present || isNullish(val)) {
              if (!col.nullable) add(finding({ severity: SEV.P1, kind: "not-null-violation", title: "NOT NULL violation", detail: `Column "${col.name}" is NOT NULL but is ${present ? "null" : "absent"}.`, locator: rloc }));
              continue;
            }
            if (!typeOk(col.type, val)) add(finding({ severity: SEV.P1, kind: "type-violation", title: "Column type violation", detail: `Column "${col.name}" expected ${col.type} but got ${JSON.stringify(val)}.`, locator: rloc }));
          }
        });

        // Primary key: non-null + unique.
        if (table.primaryKey && table.primaryKey.length > 0) {
          const seen = new Set<string>();
          rows.forEach((row, i) => {
            const vals = tuple(row, table.primaryKey!);
            if (vals.some(isNullish)) add(finding({ severity: SEV.P1, kind: "primary-key-null", title: "Primary key contains NULL", detail: `PK (${table.primaryKey!.join(", ")}) has a null component.`, locator: `${loc} row[${i}]` }));
            else {
              const k = JSON.stringify(vals);
              if (seen.has(k)) add(finding({ severity: SEV.P1, kind: "primary-key-duplicate", title: "Duplicate primary key", detail: `PK (${table.primaryKey!.join(", ")}) = ${k} appears more than once.`, locator: `${loc} row[${i}]` }));
              seen.add(k);
            }
          });
        }

        // UNIQUE constraints (SQL semantics: rows with a NULL component are not compared).
        for (const uniq of table.unique ?? []) {
          const seen = new Set<string>();
          rows.forEach((row, i) => {
            const vals = tuple(row, uniq);
            if (vals.some(isNullish)) return;
            const k = JSON.stringify(vals);
            if (seen.has(k)) add(finding({ severity: SEV.P1, kind: "unique-violation", title: "UNIQUE constraint violation", detail: `UNIQUE (${uniq.join(", ")}) = ${k} is duplicated.`, locator: `${loc} row[${i}]` }));
            seen.add(k);
          });
        }

        // Foreign keys: referential integrity against the referenced table's rows.
        for (const fk of table.foreignKeys ?? []) {
          const refRows = dataset[fk.refTable];
          if (!Array.isArray(refRows)) {
            add(finding({ severity: SEV.P2, kind: "fk-unverifiable", title: "Foreign key cannot be verified", detail: `Referenced table "${fk.refTable}" has no rows in the dataset; referential integrity for (${fk.columns.join(", ")}) is unverifiable.`, locator: loc }));
            continue;
          }
          const refIndex = new Set<string>();
          for (const r of refRows) {
            const rv = tuple(r, fk.refColumns);
            if (!rv.some(isNullish)) refIndex.add(JSON.stringify(rv));
          }
          rows.forEach((row, i) => {
            const vals = tuple(row, fk.columns);
            if (vals.some(isNullish)) return; // null FK is allowed (enforced by NOT NULL separately)
            if (!refIndex.has(JSON.stringify(vals))) add(finding({ severity: SEV.P1, kind: "fk-orphan", title: "Foreign key orphan", detail: `(${fk.columns.join(", ")}) = ${JSON.stringify(vals)} has no match in ${fk.refTable}(${fk.refColumns.join(", ")}).`, locator: `${loc} row[${i}]` }));
          });
        }

        collector.evidence({
          producedBy: "qa.database-engine",
          action: "db.readonly.validate",
          kind: "DB",
          classification: "INTERNAL",
          summary: `table ${table.name}: ${rows.length} row(s), ${violations} violation(s)`,
          data: { table: table.name, rows: rows.length, violations, at: ctx.now() },
        });
      } catch (e) {
        collector.finding(finding({ severity: SEV.P2, kind: "engine-error", title: "Engine error while checking table", detail: e instanceof Error ? e.message : String(e), locator: loc }));
      }
    }

    // Migration safety (read-only default: destructive migrations require explicit approval).
    for (const m of migrations ?? []) {
      token.throwIfCancelled();
      for (const op of m.ops ?? []) {
        const kind = String(op?.kind ?? "").toLowerCase();
        if (DESTRUCTIVE_KINDS.has(kind) && !allowDestructiveMigrations) {
          collector.finding(finding({ severity: SEV.P1, kind: "destructive-migration", title: "Destructive migration without approval", detail: `Migration "${m.id}" op "${kind}"${op.table ? ` on ${op.table}` : ""}${op.column ? `.${op.column}` : ""} is destructive; the read-only default forbids it without explicit approval.`, locator: `migration ${m.id}` }));
        } else if (LOSSY_KINDS.has(kind) && !allowDestructiveMigrations) {
          collector.finding(finding({ severity: SEV.P2, kind: "potentially-lossy-migration", title: "Potentially lossy migration", detail: `Migration "${m.id}" op "${kind}" may lose or reshape data; review before applying.`, locator: `migration ${m.id}` }));
        }
      }
    }

    collector.artifact({
      kind: "db-validation-summary",
      summary: `${tableByName.size} table(s) validated; ${migrations?.length ?? 0} migration(s) reviewed`,
      data: { tables: tableByName.size, migrations: migrations?.length ?? 0 },
    });
  }
}

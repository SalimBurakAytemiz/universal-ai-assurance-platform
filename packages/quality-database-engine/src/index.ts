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

const KNOWN_TYPES: ReadonlySet<string> = new Set(["string", "integer", "number", "boolean", "timestamp", "uuid"]);

/** Migration op kinds that destroy or narrow data — forbidden under the read-only default. */
const DESTRUCTIVE_KINDS: ReadonlySet<string> = new Set(["drop_table", "drop_column", "truncate", "delete_data", "drop_schema", "drop_database", "drop_index"]);
/** Potentially-lossy op kinds — flagged lower severity for review. */
const LOSSY_KINDS: ReadonlySet<string> = new Set(["rename_table", "rename_column", "alter_column_type", "narrow_column"]);
/** Explicitly non-destructive op kinds. Anything NOT in any of the three sets is treated as unknown. */
const KNOWN_SAFE_KINDS: ReadonlySet<string> = new Set(["add_column", "add_index", "create_index", "create_table", "add_constraint", "add_foreign_key", "backfill"]);

/** Normalize an op kind so "DROP TABLE" / "drop-table" / "dropTable"-ish inputs collapse to one token. */
function normalizeKind(kind: unknown): string {
  return String(kind ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

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
      return false; // fail-closed: an unrecognized type never silently validates a value
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

  // discover()/plan() run BEFORE validatePrereqs, so they must tolerate a non-array tables/migrations
  // field (e.g. {} or a string) without throwing — Array.isArray, never just `?? []`.
  private tablesOf(ctx: EngineContext): readonly TableSpec[] {
    const t = (this.input(ctx)?.schema as { tables?: unknown })?.tables;
    return Array.isArray(t) ? (t as TableSpec[]) : [];
  }
  private migrationsOf(ctx: EngineContext): readonly Migration[] {
    const m = (this.input(ctx) as { migrations?: unknown })?.migrations;
    return Array.isArray(m) ? (m as Migration[]) : [];
  }

  discover(ctx: EngineContext): Discovery {
    const dataset = this.input(ctx)?.dataset;
    const tables = this.tablesOf(ctx);
    return {
      items: tables.map((t) => t?.name),
      summary: `${tables.length} table(s); dataset has ${dataset && typeof dataset === "object" ? Object.keys(dataset).length : 0} table(s) of rows`,
    };
  }

  plan(ctx: EngineContext, _discovery: Discovery): EnginePlan {
    const tables = this.tablesOf(ctx);
    const migrations = this.migrationsOf(ctx);
    return {
      steps: [...tables.map((t) => ({ table: t?.name })), ...migrations.map((m) => ({ migration: m?.id }))],
      summary: `validate ${tables.length} table(s) and ${migrations.length} migration(s)`,
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
    for (const t of Array.isArray(schema?.tables) ? schema.tables : []) {
      // A table must have a string name AND a columns array — otherwise table.columns.map() would
      // throw and mask every constraint check behind a generic engine-error (a false negative).
      if (t && typeof t === "object" && typeof t.name === "string" && Array.isArray(t.columns)) tableByName.set(t.name, t);
      else collector.finding(finding({ severity: SEV.P2, kind: "malformed-table", title: "Malformed table in schema", detail: "Schema table is null, has no string name, or has no columns array; skipped.", locator: "schema.tables" }));
    }

    // Flag dataset tables not present in the schema (coverage gap, not silent).
    for (const name of Object.keys(dataset)) {
      if (!tableByName.has(name)) {
        collector.finding(finding({ severity: SEV.P2, kind: "unknown-table", title: "Dataset table not in schema", detail: `Dataset includes table "${name}" that the schema does not declare.`, locator: `dataset.${name}` }));
      }
    }

    // A referenced-table index builder that skips non-object ref rows (so a null ref row can't crash FK checks).
    const isRowObject = (r: unknown): r is Record<string, unknown> => !!r && typeof r === "object" && !Array.isArray(r);
    let inspectedTables = 0;
    for (const table of tableByName.values()) {
      token.throwIfCancelled();
      const loc = `table ${table.name}`;
      try {
        const rawRows = dataset[table.name];
        if (!Array.isArray(rawRows)) {
          // A declared table with no dataset rows is UNVERIFIED, not validated — surface it, never a silent pass.
          collector.finding(finding({ severity: SEV.P3, kind: "table-not-in-dataset", title: "Declared table has no dataset rows", detail: `Table "${table.name}" is declared in the schema but absent from the dataset; it was not inspected.`, locator: loc }));
          continue;
        }
        inspectedTables++;
        const colByName = new Map(table.columns.map((c) => [c.name, c]));
        let violations = 0;
        const add = (f: EngineFinding) => {
          violations++;
          collector.finding(f);
        };

        // Isolate malformed rows up front: a null/non-object row becomes its own finding and does
        // NOT abort the PK/UNIQUE/FK checks for the rest of the table.
        const validRows: { row: Record<string, unknown>; i: number }[] = [];
        rawRows.forEach((row, i) => {
          if (isRowObject(row)) validRows.push({ row, i });
          else add(finding({ severity: SEV.P1, kind: "malformed-row", title: "Malformed row", detail: `Row ${i} of "${table.name}" is null or not an object.`, locator: `${loc} row[${i}]` }));
        });

        // Columns with an unrecognized declared type are surfaced (fail-closed) and excluded from the
        // per-value type check (so we never silently green-light nor flood with bogus type errors).
        const unknownTypeCols = new Set<string>();
        for (const col of table.columns) {
          if (!KNOWN_TYPES.has(col.type)) {
            unknownTypeCols.add(col.name);
            add(finding({ severity: SEV.P2, kind: "unknown-column-type", title: "Unknown column type", detail: `Column "${col.name}" declares unsupported type "${col.type}"; its values cannot be type-checked.`, locator: loc }));
          }
        }

        // Row-level: column drift, NOT NULL, type.
        for (const { row, i } of validRows) {
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
            if (!unknownTypeCols.has(col.name) && !typeOk(col.type, val)) add(finding({ severity: SEV.P1, kind: "type-violation", title: "Column type violation", detail: `Column "${col.name}" expected ${col.type} but got ${JSON.stringify(val)}.`, locator: rloc }));
          }
        }

        // Primary key: non-null + unique.
        if (table.primaryKey && table.primaryKey.length > 0) {
          const seen = new Set<string>();
          for (const { row, i } of validRows) {
            const vals = tuple(row, table.primaryKey);
            if (vals.some(isNullish)) add(finding({ severity: SEV.P1, kind: "primary-key-null", title: "Primary key contains NULL", detail: `PK (${table.primaryKey.join(", ")}) has a null component.`, locator: `${loc} row[${i}]` }));
            else {
              const k = JSON.stringify(vals);
              if (seen.has(k)) add(finding({ severity: SEV.P1, kind: "primary-key-duplicate", title: "Duplicate primary key", detail: `PK (${table.primaryKey.join(", ")}) = ${k} appears more than once.`, locator: `${loc} row[${i}]` }));
              seen.add(k);
            }
          }
        }

        // UNIQUE constraints (SQL semantics: rows with a NULL component are not compared).
        for (const uniq of table.unique ?? []) {
          const seen = new Set<string>();
          for (const { row, i } of validRows) {
            const vals = tuple(row, uniq);
            if (vals.some(isNullish)) continue;
            const k = JSON.stringify(vals);
            if (seen.has(k)) add(finding({ severity: SEV.P1, kind: "unique-violation", title: "UNIQUE constraint violation", detail: `UNIQUE (${uniq.join(", ")}) = ${k} is duplicated.`, locator: `${loc} row[${i}]` }));
            seen.add(k);
          }
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
            if (!isRowObject(r)) continue; // a malformed ref row cannot crash the FK pass
            const rv = tuple(r, fk.refColumns);
            if (!rv.some(isNullish)) refIndex.add(JSON.stringify(rv));
          }
          for (const { row, i } of validRows) {
            const vals = tuple(row, fk.columns);
            if (vals.some(isNullish)) continue; // null FK is allowed (enforced by NOT NULL separately)
            if (!refIndex.has(JSON.stringify(vals))) add(finding({ severity: SEV.P1, kind: "fk-orphan", title: "Foreign key orphan", detail: `(${fk.columns.join(", ")}) = ${JSON.stringify(vals)} has no match in ${fk.refTable}(${fk.refColumns.join(", ")}).`, locator: `${loc} row[${i}]` }));
          }
        }

        collector.evidence({
          producedBy: "qa.database-engine",
          action: "db.readonly.validate",
          kind: "DB",
          classification: "INTERNAL",
          summary: `table ${table.name}: ${rawRows.length} row(s), ${violations} violation(s)`,
          data: { table: table.name, rows: rawRows.length, violations, at: ctx.now() },
        });
      } catch (e) {
        collector.finding(finding({ severity: SEV.P2, kind: "engine-error", title: "Engine error while checking table", detail: e instanceof Error ? e.message : String(e), locator: loc }));
      }
    }

    // Migration safety (read-only default). FAIL-CLOSED on vocabulary: a kind that is neither a
    // known-safe op nor a recognized destructive/lossy one is surfaced as unknown, never assumed safe.
    // Normalize the container itself: a present-but-non-array `migrations` is a structured finding,
    // not a crash that would void the whole run.
    let migs: readonly Migration[] = [];
    if (Array.isArray(migrations)) migs = migrations;
    else if (migrations !== undefined && migrations !== null) {
      collector.finding(finding({ severity: SEV.P2, kind: "malformed-migrations-input", title: "Malformed migrations field", detail: "`migrations` is present but not an array; it was not reviewed.", locator: "migrations" }));
    }
    migs.forEach((m, mi) => {
      token.throwIfCancelled();
      const mloc = `migration ${m && typeof m === "object" && m.id ? m.id : `#${mi}`}`;
      try {
        if (!m || typeof m !== "object" || !Array.isArray(m.ops)) {
          collector.finding(finding({ severity: SEV.P2, kind: "malformed-migration", title: "Malformed migration", detail: "Migration is null, not an object, or has no ops array.", locator: mloc }));
          return;
        }
        for (const op of m.ops) {
          const kind = normalizeKind(op?.kind); // "DROP TABLE"/"drop-table" -> "drop_table"
          if (DESTRUCTIVE_KINDS.has(kind)) {
            if (!allowDestructiveMigrations) collector.finding(finding({ severity: SEV.P1, kind: "destructive-migration", title: "Destructive migration without approval", detail: `${mloc} op "${kind}"${op?.table ? ` on ${op.table}` : ""}${op?.column ? `.${op.column}` : ""} is destructive; the read-only default forbids it without explicit approval.`, locator: mloc }));
          } else if (LOSSY_KINDS.has(kind)) {
            if (!allowDestructiveMigrations) collector.finding(finding({ severity: SEV.P2, kind: "potentially-lossy-migration", title: "Potentially lossy migration", detail: `${mloc} op "${kind}" may lose or reshape data; review before applying.`, locator: mloc }));
          } else if (!KNOWN_SAFE_KINDS.has(kind)) {
            collector.finding(finding({ severity: SEV.P2, kind: "unknown-migration-op", title: "Unrecognized migration op", detail: `${mloc} op "${kind || "(empty)"}" is not a known-safe operation; it cannot be assumed non-destructive and needs review.`, locator: mloc }));
          }
        }
      } catch (e) {
        collector.finding(finding({ severity: SEV.P2, kind: "engine-error", title: "Engine error while checking migration", detail: e instanceof Error ? e.message : String(e), locator: mloc }));
      }
    });

    collector.artifact({
      kind: "db-validation-summary",
      summary: `${inspectedTables}/${tableByName.size} declared table(s) inspected; ${migs.length} migration(s) reviewed`,
      data: { declaredTables: tableByName.size, inspectedTables, migrations: migs.length },
    });
  }
}

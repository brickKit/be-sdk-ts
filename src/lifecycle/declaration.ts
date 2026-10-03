// The declaration migrations/lifecycle.yaml v1 (P16.1): parsed with the YAML 1.2 core schema, validated against
// schemas/lifecycle.schema.json, then checked against the invariants; every violation is fatal and names the table.
// Checks that need the migrated schema (NUMERIC precision, every table declared) take the facts as arguments;
// readColumnTypes / readTables read them from information_schema in a transaction.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { QueryRows } from "../store/types.js";
import { checkDeclarationSchema, parseYaml12 } from "./schemas.js";
import type { Declaration, EffectiveTable, TableDecl } from "./types.js";

export const DECLARATION_FILE = "lifecycle.yaml";

export class LifecycleDeclarationError extends Error {
  readonly reason: string;
  readonly table: string | undefined;
  constructor(reason: string, table: string | undefined, message: string) {
    super(table === undefined ? `lifecycle.yaml: ${message}` : `lifecycle.yaml: table ${table}: ${message}`);
    this.name = "LifecycleDeclarationError";
    this.reason = reason;
    this.table = table;
  }
}

export function loadDeclaration(migrationsDir: string): Declaration {
  const file = join(migrationsDir, DECLARATION_FILE);
  if (!existsSync(file)) throw new LifecycleDeclarationError("DECLARATION_MISSING", undefined, `${file} does not exist (P16.1)`);
  return parseDeclaration(readFileSync(file, "utf8"));
}

export function parseDeclaration(text: string): Declaration {
  let doc: unknown;
  try {
    doc = parseYaml12(text);
  } catch (e) {
    throw new LifecycleDeclarationError("DECLARATION_INVALID", undefined, `not YAML: ${(e as Error).message}`);
  }
  const problems = checkDeclarationSchema(doc);
  if (problems.length > 0) {
    // an invariant names the problem better than the schema's if/then branch does
    if (isObject(doc) && isObject(doc.tables)) checkInvariants(doc as unknown as Declaration);
    const first = problems[0]!;
    const table = /^\/tables\/([^/]+)/.exec(first.path)?.[1];
    throw new LifecycleDeclarationError("DECLARATION_INVALID", table, `${first.path} ${first.message}`);
  }
  const decl = doc as Declaration;
  checkInvariants(decl);
  return decl;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function checkInvariants(d: Declaration): void {
  for (const [name, raw] of Object.entries(d.tables)) {
    if (!isObject(raw)) continue;
    const t = raw as TableDecl;
    if (t.follows !== undefined && !(t.follows in d.tables)) {
      throw new LifecycleDeclarationError("FOLLOWS_UNKNOWN", name, `follows ${t.follows}, which is not declared`);
    }
    if (t.class === "ledger" && Array.isArray(t.pii) && t.pii.length > 0) {
      throw new LifecycleDeclarationError("LEDGER_PII", name, `a ledger table has no pii column (declares ${t.pii.join(", ")})`);
    }
    if (t.class === "ledger" && isObject(t.erasure) && "columns" in t.erasure) {
      throw new LifecycleDeclarationError("LEDGER_ERASURE_COLUMNS", name, "a ledger table declares no erasure.columns");
    }
    if (t.class === "queue" && t.tiers?.cold !== undefined && t.tiers.cold !== "never") {
      throw new LifecycleDeclarationError("QUEUE_COLD", name, "a queue table declares no tiers.cold");
    }
    if (t.class === "snapshot" && t.retention?.min !== undefined) {
      throw new LifecycleDeclarationError("SNAPSHOT_RETENTION", name, "a snapshot table declares no retention.min");
    }
  }
}

/** Every table with `follows` resolved (class, partition, rules from the parent), keyed by name. */
export function effectiveTables(d: Declaration): Map<string, EffectiveTable> {
  const out = new Map<string, EffectiveTable>();
  const root = (name: string, seen = new Set<string>()): string => {
    const f = d.tables[name]?.follows;
    if (f === undefined) return name;
    if (seen.has(f)) throw new LifecycleDeclarationError("FOLLOWS_UNKNOWN", name, "follows forms a cycle");
    seen.add(name);
    return root(f, seen);
  };
  for (const name of Object.keys(d.tables).sort()) {
    const own = d.tables[name]!;
    const parent: TableDecl = own.follows === undefined ? own : { ...d.tables[root(name)]!, erasure: own.erasure, pii: own.pii };
    out.set(name, { ...parent, follows: own.follows, name, class: parent.class ?? "reference", followers: [] });
  }
  for (const [name, t] of out) if (t.follows !== undefined) out.get(root(name))!.followers.push(name);
  return out;
}

const hasCold = (t: EffectiveTable) => t.tiers?.cold !== undefined && t.tiers.cold !== "never";

/** P16.1: every NUMERIC column of a table that declares tiers.cold has a precision. */
export function checkNumericPrecision(d: Declaration, columns: Record<string, Record<string, string>>): void {
  for (const t of effectiveTables(d).values()) {
    if (!hasCold(t)) continue;
    for (const [col, type] of Object.entries(columns[t.name] ?? {})) {
      if (/^numeric(\[\])*$/i.test(type.trim())) {
        throw new LifecycleDeclarationError("NUMERIC_PRECISION", t.name, `column ${col} is NUMERIC without a precision, and the table declares tiers.cold`);
      }
    }
  }
}

/** P16.1: a table with tiers.cold and an erasure action other than restrict cannot use a WORM cold store. */
export function checkWorm(d: Declaration, coldStoreIsWorm: boolean): void {
  if (!coldStoreIsWorm) return;
  for (const t of effectiveTables(d).values()) {
    const e = t.erasure;
    if (!hasCold(t) || e === undefined) continue;
    const actions = "columns" in e ? Object.values(e.columns) : [e.action];
    if (actions.some((a) => a !== "restrict")) {
      throw new LifecycleDeclarationError("WORM_ERASURE", t.name, "an erasable table with tiers.cold cannot use a WORM cold store");
    }
  }
}

/** Tables the platform owns or the migration tool keeps: exempt from P11.11. */
export function isExemptTable(name: string): boolean {
  return name.startsWith("besdk_") || name.startsWith("pgmigrations_");
}

/** P11.11 / P16.1: every table the migrations create is declared. */
export function checkAllDeclared(d: Declaration, tables: string[]): void {
  for (const name of [...tables].sort()) {
    if (!isExemptTable(name) && !(name in d.tables)) {
      throw new LifecycleDeclarationError("TABLE_UNDECLARED", name, "created by the migrations but not declared");
    }
  }
}

/** The schema's tables (not partitions), for checkAllDeclared; search_path = PG_SCHEMA. */
export async function readTables(query: QueryRows): Promise<string[]> {
  const rows = await query(`SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p') AND NOT c.relispartition ORDER BY 1`);
  return rows.map((r: { name: string }) => r.name);
}

/** Column types (format_type) of the schema's tables, for checkNumericPrecision. */
export async function readColumnTypes(query: QueryRows): Promise<Record<string, Record<string, string>>> {
  const rows = await query(`SELECT c.relname AS t, a.attname AS c, format_type(a.atttypid, a.atttypmod) AS type
      FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p') AND NOT c.relispartition
       AND a.attnum > 0 AND NOT a.attisdropped ORDER BY c.relname, a.attnum`);
  const out: Record<string, Record<string, string>> = {};
  for (const r of rows as { t: string; c: string; type: string }[]) (out[r.t] ??= {})[r.c] = r.type;
  return out;
}

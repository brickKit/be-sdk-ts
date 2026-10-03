// The canonical unit digest (P16): each row encoded column by column in declared order, every value in
// PostgreSQL's text output format, NULL as \N; fields separated by 0x1F, rows by 0x1E, rows ordered by primary
// key; SHA-256 of the whole. chain_n = SHA-256(chain_{n-1} ‖ unit_digest_n), the first link hashing the unit
// digest alone. The rows' text form is produced by PostgreSQL (`::text`), under fixed output settings (UTC,
// ISO dates, postgres intervals, shortest-exact floats, hex bytea) so it does not depend on the session; text
// primary key columns are ordered bytewise (COLLATE "C"), so another tool can reproduce the order.
import { createHash, type Hash } from "node:crypto";
import { quoteIdent } from "../store/sql.js";
import type { QueryRows } from "../store/types.js";

const FS = "\x1f";
const RS = "\x1e";
const NULL_TEXT = "\\N";
const FETCH = 1000;

export class UnitDigest {
  private readonly hash: Hash = createHash("sha256");
  rows = 0;

  addRow(values: (string | null)[]): void {
    this.addEncoded(values.map((v) => (v === null ? NULL_TEXT : v)).join(FS));
  }

  /** A row already encoded (fields joined by 0x1F, NULL as \N). */
  addEncoded(row: string): void {
    if (this.rows > 0) this.hash.update(RS);
    this.hash.update(row, "utf8");
    this.rows++;
  }

  finish(): { rows: number; digest: Buffer } {
    return { rows: this.rows, digest: this.hash.digest() };
  }
}

export function chainDigest(previous: Buffer | undefined, unit: Buffer): Buffer {
  const h = createHash("sha256");
  if (previous) h.update(previous);
  return h.update(unit).digest();
}

export interface Column {
  name: string;
  /** a collatable (text-like) type: ordered COLLATE "C" */
  collatable: boolean;
}

/** One row per tuple: `k` = the first key column as text, `r` = the encoded row. */
export function digestSelectSql(relation: string, columns: Column[], pk: Column[]): string {
  const fields = columns.map((c) => `COALESCE((${quoteIdent(c.name)})::text, '${NULL_TEXT}')`).join(", ");
  const order = pk.map((c) => `${quoteIdent(c.name)}${c.collatable ? ' COLLATE "C"' : ""}`).join(", ");
  const key = pk[0] ?? columns[0]!;
  return `SELECT (${quoteIdent(key.name)})::text AS k, array_to_string(ARRAY[${fields}], chr(31)) AS r FROM ${quoteIdent(relation)} ORDER BY ${order}`;
}

const SETTINGS: [string, string][] = [
  ["TimeZone", "UTC"], ["DateStyle", "ISO, MDY"], ["IntervalStyle", "postgres"], ["extra_float_digits", "1"], ["bytea_output", "hex"],
];

/** The declared columns and primary key of a table (a partition's parent), in order; no key = every column. */
export async function readShape(query: QueryRows, table: string): Promise<{ columns: Column[]; pk: Column[] }> {
  const columns = (await query(
    `SELECT attname AS name, attcollation <> 0 AS collatable FROM pg_attribute
      WHERE attrelid = to_regclass($1) AND attnum > 0 AND NOT attisdropped ORDER BY attnum`, [quoteIdent(table)])) as Column[];
  if (columns.length === 0) throw new Error(`lifecycle: ${table} is not a table of this schema`);
  const pk = (await query(
    `SELECT a.attname AS name, a.attcollation <> 0 AS collatable
       FROM pg_index i CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
      WHERE i.indrelid = to_regclass($1) AND i.indisprimary ORDER BY k.ord`, [quoteIdent(table)])) as Column[];
  return { columns, pk: pk.length > 0 ? pk : columns };
}

export interface DigestResult {
  rows: number;
  digest: Buffer;
  minId?: string;
  maxId?: string;
}

let cursorSeq = 0;

/** Digest of one unit (`relation`, shaped like `table`), read through a cursor in the caller's transaction. */
export async function computeDigest(query: QueryRows, table: string, relation: string): Promise<DigestResult> {
  const shape = await readShape(query, table);
  const saved = (await query(`SELECT ${SETTINGS.map(([n], i) => `current_setting('${n}') AS s${i}`).join(", ")}`))[0] as Record<string, string>;
  await setAll(query, SETTINGS.map(([n, v]) => [n, v]));
  const cursor = `besdk_digest_${++cursorSeq}`;
  const d = new UnitDigest();
  let minId: string | undefined;
  let maxId: string | undefined;
  try {
    await query(`DECLARE ${cursor} NO SCROLL CURSOR FOR ${digestSelectSql(relation, shape.columns, shape.pk)}`);
    for (;;) {
      const rows = (await query(`FETCH FORWARD ${FETCH} FROM ${cursor}`)) as { k: string | null; r: string }[];
      for (const row of rows) {
        minId ??= row.k ?? undefined;
        maxId = row.k ?? maxId;
        d.addEncoded(row.r);
      }
      if (rows.length < FETCH) break;
    }
    await query(`CLOSE ${cursor}`);
  } finally {
    await setAll(query, SETTINGS.map(([n], i) => [n, saved[`s${i}`]!]));
  }
  return { ...d.finish(), minId, maxId };
}

async function setAll(query: QueryRows, values: [string, string][]): Promise<void> {
  const sql = values.map((_, i) => `set_config($${2 * i + 1}, $${2 * i + 2}, true)`).join(", ");
  await query(`SELECT ${sql}`, values.flat());
}

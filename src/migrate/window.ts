// The outbox's partition window (P11.3, P16.6): weekly RANGE partitions on created_at with Monday 00:00 UTC
// boundaries, the current week and two ahead. A partition is created only when no existing partition overlaps
// its range ("by boundary, never by name"), through the owner's SECURITY DEFINER function, so the runtime
// role can run the same step later (the outbox pump keeps the window ahead).
//
// The same holds for the component's tables (P16.6, CP-LIFE-01): every RANGE-partitioned table of
// migrations/lifecycle.yaml gets its current period and `ahead` more (followers with the same bounds), so a
// database migrated on any day accepts writes that day; a `seal: immediate` table's new partitions get the
// sealed-unit guard at once. The lifecycle engine keeps the window ahead at run time.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DECLARATION_FILE, effectiveTables, loadDeclaration } from "../lifecycle/declaration.js";
import type { QueryRows } from "../store/types.js";

export const OUTBOX_TABLE = "besdk_outbox";
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

export interface RangePartition {
  name: string;
  from: Date;
  to: Date;
}

export function weekStartUtc(d: Date): Date {
  const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const sinceMonday = (day.getUTCDay() + 6) % 7;
  return new Date(day.getTime() - sinceMonday * DAY_MS);
}

const ymd = (d: Date) => d.toISOString().slice(0, 10).replaceAll("-", "");

export type Grain = "week" | "month" | "year";

/** The lower boundary (UTC) of the `grain` period containing `d`: Monday, the 1st, or 1 January, 00:00. */
export function grainStart(d: Date, grain: Grain): Date {
  if (grain === "week") return weekStartUtc(d);
  if (grain === "month") return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  return new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
}

/** `d` (a period boundary) moved by `n` periods of `grain`. */
export function grainAdd(d: Date, grain: Grain, n: number): Date {
  if (grain === "week") return new Date(d.getTime() + n * WEEK_MS);
  if (grain === "month") return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
  return new Date(Date.UTC(d.getUTCFullYear() + n, 0, 1));
}

/** The partition of `parent` for the period starting at `from`: named <parent>_p<YYYYMMDD>. */
export function rangePartition(parent: string, grain: Grain, from: Date): RangePartition {
  return { name: `${parent}_p${ymd(from)}`, from, to: grainAdd(from, grain, 1) };
}

/** The current period of `grain` and `ahead` more, oldest first (P16.6). */
export function rangeWindow(parent: string, grain: Grain, ahead: number, now: Date): RangePartition[] {
  const start = grainStart(now, grain);
  return Array.from({ length: ahead + 1 }, (_, i) => rangePartition(parent, grain, grainAdd(start, grain, i)));
}

/** The current week and `ahead` more, oldest first. */
export function outboxWindow(now: Date, ahead = 2, parent = OUTBOX_TABLE): RangePartition[] {
  const start = weekStartUtc(now).getTime();
  return Array.from({ length: ahead + 1 }, (_, i) => {
    const from = new Date(start + i * WEEK_MS);
    return { name: `${parent}_p${ymd(from)}`, from, to: new Date(from.getTime() + WEEK_MS) };
  });
}

// Bounds (epoch ms) of the existing partitions of a RANGE table, read from their partition expressions
// (MINVALUE / MAXVALUE become ±Infinity; a DEFAULT partition has no bounds and never blocks a new one).
const BOUNDS_SQL = `
SELECT c.relname AS name,
       CASE WHEN b.lo = 'MINVALUE' THEN '-Infinity'::float8 ELSE extract(epoch FROM b.lo::timestamptz)::float8 * 1000 END AS lo,
       CASE WHEN b.hi = 'MAXVALUE' THEN 'Infinity'::float8 ELSE extract(epoch FROM b.hi::timestamptz)::float8 * 1000 END AS hi
  FROM pg_inherits i
  JOIN pg_class c ON c.oid = i.inhrelid
  CROSS JOIN LATERAL (SELECT substring(pg_get_expr(c.relpartbound, c.oid) FROM 'FROM \\(''?([^'')]+)''?\\)') AS lo,
                             substring(pg_get_expr(c.relpartbound, c.oid) FROM 'TO \\(''?([^'')]+)''?\\)') AS hi) b
 WHERE i.inhparent = to_regclass($1) AND b.lo IS NOT NULL AND b.hi IS NOT NULL`;

/**
 * Ensures the window's partitions exist; returns the names created. `query` runs in the caller's
 * transaction (the outbox pump: `tx.query`) or the owner's migration session; search_path = PG_SCHEMA.
 */
export async function ensureRangeWindow(query: QueryRows, window: RangePartition[], parent = OUTBOX_TABLE): Promise<string[]> {
  const created: string[] = [];
  const existing = (await query(BOUNDS_SQL, [parent])) as { lo: number; hi: number }[];
  for (const p of window) {
    const overlaps = existing.some((e) => e.lo < p.to.getTime() && e.hi > p.from.getTime());
    if (overlaps) continue;
    const rows = await query("SELECT besdk_ensure_range_partition($1, $2, $3, $4) AS created", [parent, p.name, p.from, p.to]);
    if ((rows[0] as { created: boolean } | undefined)?.created) created.push(p.name);
    existing.push({ lo: p.from.getTime(), hi: p.to.getTime() });
  }
  return created;
}

/** The outbox's current window, as the platform migration and the outbox pump keep it. */
export function ensureOutboxWindow(query: QueryRows, now = new Date()): Promise<string[]> {
  return ensureRangeWindow(query, outboxWindow(now), OUTBOX_TABLE);
}

/**
 * The current window of every RANGE-partitioned table declared in `<migrationsDir>/lifecycle.yaml` (P16.6);
 * returns the partitions created. No lifecycle.yaml: nothing to do (the engine refuses to start without one).
 * Runs in the owner's migration transaction with search_path = PG_SCHEMA.
 */
export async function ensureLifecycleWindows(query: QueryRows, migrationsDir: string, now = new Date()): Promise<string[]> {
  if (!existsSync(join(migrationsDir, DECLARATION_FILE))) return [];
  const tables = effectiveTables(loadDeclaration(migrationsDir));
  const created: string[] = [];
  for (const t of tables.values()) {
    const p = t.partition;
    if (t.follows !== undefined || !p || !("grain" in p)) continue;
    const immediate = t.tiers?.seal === "immediate" && ["document", "ledger", "audit"].includes(t.class);
    for (const table of [t.name, ...t.followers]) {
      const made = await ensureRangeWindow(query, rangeWindow(table, p.grain, p.ahead ?? 2, now), table);
      if (immediate) for (const name of made) await query("SELECT besdk_seal_table($1)", [name]);
      created.push(...made);
    }
  }
  return created;
}

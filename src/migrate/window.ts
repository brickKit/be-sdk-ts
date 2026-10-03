// The outbox's partition window (P11.3, P16.6): weekly RANGE partitions on created_at with Monday 00:00 UTC
// boundaries, the current week and two ahead. A partition is created only when no existing partition overlaps
// its range ("by boundary, never by name"), through the owner's SECURITY DEFINER function, so the runtime
// role can run the same step later (the outbox pump keeps the window ahead).
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

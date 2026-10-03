// What the planner observes (P16): the attached partitions of every table with their bounds and seal guards,
// row statistics of the partitions it may act on, besdk_lifecycle_units, the holds in force, and the units already
// on a destruction list. Read in one transaction as the runtime role.
import { quoteIdent } from "../store/sql.js";
import type { QueryRows } from "../store/types.js";
import { rulesOf } from "./rules.js";
import {
  SEALED_STATES, type Declaration, type EffectiveTable, type HoldScope, type LifecycleConfig, type PartitionState,
  type PlannerState, type UnitRecord, type UnitState,
} from "./types.js";

const PARTITIONS_SQL = `
SELECT c.relname AS name,
       CASE WHEN b.lo IS NULL OR b.lo = 'MINVALUE' THEN NULL ELSE b.lo::timestamptz END AS lo,
       CASE WHEN b.hi IS NULL OR b.hi = 'MAXVALUE' THEN NULL ELSE b.hi::timestamptz END AS hi,
       b.lv AS list_value,
       EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = c.oid AND t.tgname = 'besdk_sealed_rows') AS guarded
  FROM pg_inherits i
  JOIN pg_class c ON c.oid = i.inhrelid
  CROSS JOIN LATERAL (SELECT pg_get_expr(c.relpartbound, c.oid) AS e) x
  CROSS JOIN LATERAL (SELECT substring(x.e FROM 'FROM \\(''?([^'')]+)''?\\)') AS lo,
                             substring(x.e FROM 'TO \\(''?([^'')]+)''?\\)') AS hi,
                             substring(x.e FROM 'IN \\(''([^'']*)''\\)') AS lv) b
 WHERE i.inhparent = to_regclass($1) AND x.e <> 'DEFAULT'
 ORDER BY lo NULLS FIRST, c.relname`;

/** The attached partitions of `table` (none when it is not partitioned or does not exist). */
export async function partitionsOf(query: QueryRows, table: string): Promise<PartitionState[]> {
  const rows = (await query(PARTITIONS_SQL, [quoteIdent(table)])) as
    { name: string; lo: Date | null; hi: Date | null; list_value: string | null; guarded: boolean }[];
  return rows.map((r) => ({
    name: r.name, from: r.lo ?? undefined, to: r.hi ?? undefined, listValue: r.list_value ?? undefined, guarded: r.guarded,
  }));
}

/** SQL for one partition's row count, open rows and latest closing instant under the table's `closed` rule. */
export function statsSql(t: EffectiveTable, relation: string): string {
  const c = t.closed;
  if (!c) return `SELECT count(*)::float8 AS rows, 0::float8 AS open, NULL::timestamptz AS max_closed FROM ${quoteIdent(relation)}`;
  const isClosed = `(${quoteIdent(c.column)})::text = ANY($1::text[])`;
  return `SELECT count(*)::float8 AS rows, count(*) FILTER (WHERE ${isClosed} IS NOT TRUE)::float8 AS open,
                 max((${quoteIdent(c.at)})::timestamptz) FILTER (WHERE ${isClosed}) AS max_closed
            FROM ${quoteIdent(relation)}`;
}

async function stats(query: QueryRows, t: EffectiveTable, relation: string): Promise<PartitionState["stats"]> {
  const r = (await query(statsSql(t, relation), t.closed ? [t.closed.in] : []))[0] as { rows: number; open: number; max_closed: Date | null };
  return { rows: r.rows, openRows: r.open, maxClosedAt: r.max_closed ?? undefined };
}

/** Whether the planner needs a partition's statistics this round (they cost a scan). */
function needsStats(t: EffectiveTable, p: PartitionState, rec: UnitRecord | undefined, now: Date): boolean {
  if (p.to === undefined || p.to > now) return false;
  if (t.class === "queue" || t.class === "platform") return true;
  if (!["document", "ledger", "audit"].includes(t.class)) return false;
  if (!rec || !SEALED_STATES.has(rec.state)) return t.tiers?.seal !== undefined;
  return rec.state !== "DESTROYED" && /after closed$/.test(t.retention?.min ?? "");
}

export async function readUnits(query: QueryRows): Promise<PlannerState["units"]> {
  const rows = (await query(`SELECT table_name, unit_key, state, range_from, range_to, sealed_at FROM besdk_lifecycle_units`)) as
    { table_name: string; unit_key: string; state: UnitState; range_from: Date | null; range_to: Date | null; sealed_at: Date | null }[];
  const out: PlannerState["units"] = {};
  for (const r of rows) {
    (out[r.table_name] ??= {})[r.unit_key] = {
      table: r.table_name, unitKey: r.unit_key, state: r.state,
      rangeFrom: r.range_from ?? undefined, rangeTo: r.range_to ?? undefined, sealedAt: r.sealed_at ?? undefined,
    };
  }
  return out;
}

export async function loadState(query: QueryRows, decl: Declaration, cfg: LifecycleConfig, now: Date): Promise<PlannerState> {
  const units = await readUnits(query);
  const partitions: PlannerState["partitions"] = {};
  for (const t of rulesOf(decl, cfg)) {
    if (!t.partition || t.follows !== undefined) continue;
    const parts = await partitionsOf(query, t.name);
    for (const p of parts) if (needsStats(t, p, units[t.name]?.[p.name], now)) p.stats = await stats(query, t, p.name);
    partitions[t.name] = parts;
  }
  const holds = (await query(`SELECT hold_id, scope FROM besdk_holds WHERE released_at IS NULL ORDER BY hold_id`)) as { hold_id: string; scope: HoldScope }[];
  const proposed = (await query(`SELECT DISTINCT table_name, unit_key FROM besdk_lifecycle_log WHERE action = 'destruction_proposed'`)) as
    { table_name: string; unit_key: string }[];
  return {
    partitions, units,
    holds: holds.map((h) => ({ holdId: h.hold_id, scope: h.scope })),
    proposed: new Set(proposed.map((p) => `${p.table_name}/${p.unit_key}`)),
  };
}

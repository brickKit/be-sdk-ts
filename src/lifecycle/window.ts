// P16.3 read helpers: the window of a List, and RANGE_COLD. A list request without a time range is filtered to the
// table's tiers.hot window (`none` or no hot tier = no window): a default filter, not a limit, so a named range
// older than the hot window reads warm rows. A range that touches a cold unit (COLD_PENDING_DROP, COLD) answers
// FAILED_PRECONDITION / RANGE_COLD unless the request includes cold data and a cold query adapter can serve it;
// with cold query `none` (this SDK release) it always answers RANGE_COLD, and with cold store `none` nothing is
// ever cold, so it never fires.
import { platformError } from "../errors/beError.js";
import { quoteIdent } from "../store/sql.js";
import type { QueryRows } from "../store/types.js";
import { hotFrom } from "./rules.js";
import { COLD_STATES, type EffectiveTable, type LifecycleConfig, type UnitState } from "./types.js";

export interface ReadRange {
  from?: Date;
  to?: Date;
}

export interface ColdUnit {
  unitKey: string;
  from?: Date;
  to?: Date;
  state: UnitState;
}

const overlaps = (u: ColdUnit, r: ReadRange) =>
  (u.to === undefined || r.from === undefined || u.to > r.from) && (u.from === undefined || r.to === undefined || u.from < r.to);

/** The window to read; throws RANGE_COLD when the range cannot be read completely. */
export function readWindow(t: EffectiveTable, range: ReadRange, includeCold: boolean, cold: ColdUnit[], now: Date, cfg: LifecycleConfig): ReadRange {
  const named = range.from !== undefined || range.to !== undefined;
  const w: ReadRange = named ? { from: range.from, to: range.to } : { from: hotFrom(t, now), to: undefined };
  const hit = cold.filter((u) => COLD_STATES.has(u.state) && overlaps(u, w));
  const coldQueryServes = includeCold && (cfg.cold_query as string) !== "none";
  if (hit.length === 0 || coldQueryServes) return w;
  const iso = (x: Date | undefined) => (x === undefined ? "" : x.toISOString());
  const sorted = [...hit].sort((a, b) => (a.from?.getTime() ?? -Infinity) - (b.from?.getTime() ?? -Infinity));
  const onlineFrom = cold.filter((u) => COLD_STATES.has(u.state)).reduce<Date | undefined>((m, u) => (u.to && (!m || u.to > m) ? u.to : m), undefined);
  throw platformError("RANGE_COLD", {
    online_from: iso(onlineFrom),
    cold_ranges: sorted.map((u) => `${iso(u.from)}/${iso(u.to)}`).join(","),
    thaw_allowed: String((cfg.cold_store as string) !== "none"),
    export_allowed: "false",
  }, `${t.name}: the range reaches data in the cold tier`);
}

/** The cold units of a table (besdk_lifecycle_units). */
export async function readColdUnits(query: QueryRows, table: string): Promise<ColdUnit[]> {
  const rows = await query(
    `SELECT unit_key, range_from, range_to, state FROM besdk_lifecycle_units WHERE table_name = $1 AND state = ANY($2::text[]) ORDER BY unit_key`,
    [table, [...COLD_STATES]],
  );
  return (rows as { unit_key: string; range_from: Date | null; range_to: Date | null; state: UnitState }[]).map((r) => ({
    unitKey: r.unit_key, from: r.range_from ?? undefined, to: r.range_to ?? undefined, state: r.state,
  }));
}

/** SQL condition for a window on `column` with parameters starting at $`first` (for the component's list query). */
export function windowCondition(column: string, w: ReadRange, first = 1): { sql: string; params: Date[] } {
  const parts: string[] = [];
  const params: Date[] = [];
  if (w.from) parts.push(`${quoteIdent(column)} >= $${first + params.push(w.from) - 1}`);
  if (w.to) parts.push(`${quoteIdent(column)} < $${first + params.push(w.to) - 1}`);
  return { sql: parts.length ? parts.join(" AND ") : "TRUE", params };
}

// The rules the planner and the executor share: the platform tables' built-in declarations, a table's rules with
// the deployment's overrides applied, anchor instants of a unit, and whether a hold covers a unit.
import { addSpan, anchorFiscalYearEnd, parseAfter, parseSpan, subtractSpan } from "./duration.js";
import { effectiveTables } from "./declaration.js";
import type { Declaration, EffectiveTable, HoldRecord, LifecycleConfig, PartitionState, UnitRecord } from "./types.js";

/** Runtime-owned partitioned tables (class platform): the outbox, dropped 14 days after all its rows are PUBLISHED. */
export const PLATFORM_TABLES: Record<string, EffectiveTable> = {
  besdk_outbox: {
    name: "besdk_outbox", class: "platform", followers: [],
    partition: { by: "created_at", grain: "week", ahead: 2 },
    closed: { column: "status", in: ["PUBLISHED"], at: "published_at" },
    retention: { min: "14d after closed", end: "destroy" },
  },
};

/** The fiscal calendar: the instant the fiscal year containing `t` ends (default: the natural UTC year). */
export type FiscalCalendar = (t: Date) => Date;

/** Every table the engine acts on (declared, then the platform's), overrides applied, sorted by name. */
export function rulesOf(decl: Declaration, cfg: LifecycleConfig): EffectiveTable[] {
  const out: EffectiveTable[] = [];
  for (const t of [...effectiveTables(decl).values(), ...Object.values(PLATFORM_TABLES)]) {
    const o = cfg.tables[t.name];
    if (!o) {
      out.push(t);
      continue;
    }
    out.push({
      ...t,
      tiers: { ...t.tiers, ...o.tiers },
      retention: { ...t.retention, ...(o.retention?.min !== undefined ? { min: o.retention.min } : {}) },
    });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export interface UnitFacts {
  partition: PartitionState;
  record?: UnitRecord;
}

/**
 * The instant a unit's anchor falls on; undefined when it is not known yet (no rows closed, not sealed).
 * created → the end of the unit's range (every row was created before it); closed → the latest closing instant,
 * or the end of the range for an empty unit; sealed → when it was sealed; fiscal_year_end → the end of the fiscal
 * year holding the unit's last instant.
 */
export function anchorInstant(anchor: string, u: UnitFacts, cal: FiscalCalendar = anchorFiscalYearEnd): Date | undefined {
  const to = u.partition.to;
  switch (anchor) {
    case "created":
      return to;
    case "closed":
      if (!u.partition.stats) return undefined;
      return u.partition.stats.maxClosedAt ?? (u.partition.stats.rows === 0 ? to : undefined);
    case "sealed":
      return u.record?.sealedAt;
    case "fiscal_year_end":
      return to === undefined ? undefined : cal(new Date(to.getTime() - 1));
    default:
      return undefined;
  }
}

/** Whether `<n> after <anchor>` (or forever / never) has passed for the unit at `now`. */
export function hasPassed(rule: string | undefined, u: UnitFacts, now: Date, cal?: FiscalCalendar): boolean {
  if (rule === undefined) return true;
  const r = parseAfter(rule);
  if (r === "forever" || r === "never") return false;
  const at = anchorInstant(r.anchor, u, cal);
  return at !== undefined && addSpan(at, r.span).getTime() <= now.getTime();
}

/** The hot window's lower bound of a list without a range (P16.3); undefined = no window. */
export function hotFrom(t: EffectiveTable, now: Date): Date | undefined {
  const hot = t.tiers?.hot;
  if (hot === undefined || hot === "none") return undefined;
  return subtractSpan(now, parseSpan(hot));
}

/** G9: a hold covers a unit when it names the table (or a table moving with it), the unit, or its erasure subject. */
export function isHeld(holds: HoldRecord[], t: EffectiveTable, unit: string): boolean {
  const tables = new Set([t.name, ...t.followers]);
  const subject = t.erasure?.subject;
  return holds.some(({ scope }) =>
    (scope.tables ?? []).some((x) => tables.has(x)) ||
    (scope.units ?? []).some((x) => tables.has(x.table) && x.unit_key === unit) ||
    (subject !== undefined && (scope.subjects ?? []).some((x) => x.subject === subject)));
}

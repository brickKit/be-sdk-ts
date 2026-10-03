// The planner (P16, G12): a pure function from the declaration, the observed state, the time and DATA_LIFECYCLE
// to the actions of one round. P0 scope: hot and warm tiers only, every cold adapter `none`.
//
// Order (deterministic): by kind — ensure_partition, install_guard, seal, expire, propose_destruction — then by
// table name (byte order), then by the unit's lower bound, then by unit key.
//
// Rules:
// - ensure_partition: every RANGE-partitioned table (and besdk_outbox) has the current period and `ahead` more
//   (default 2); a period is missing only when no attached partition overlaps it (by boundary, never by name).
//   Followers get the same bounds in the same action. LIST partitions are opened by the component's command.
// - install_guard: `seal: immediate` tables have the sealed-unit guard on every partition; the executor installs it
//   when it creates one, so the planner only repairs partitions created without it.
// - seal: document / ledger / audit units whose range has ended: `immediate` at once; `<n> after <anchor>` once the
//   anchor instant plus n has passed, where a unit with open rows is tried once (the executor marks it BLOCKED and
//   records the first 100 ids) and then waits until no open row remains. `on_signal` is sealed by the component.
// - expire: queue and platform partitions whose range has ended, with no open row (a non-empty partition of a
//   queue without `closed` is never expired: its open rows cannot be told), past retention.min, `end` not keep,
//   not under a hold (queue).
// - propose_destruction: sealed units of document / ledger / audit past retention.min with `end` destroy or
//   review, not under a hold, not already on the list. With cold store `none` nothing is exported and no business
//   unit is dropped (G4): a due unit only goes on the destruction list.
import { rangeWindow, type Grain } from "../migrate/window.js";
import { addSpan, parseAfter } from "./duration.js";
import { hasPassed, isHeld, rulesOf, type FiscalCalendar, type UnitFacts } from "./rules.js";
import {
  SEALED_STATES, type Action, type ActionKind, type Declaration, type EffectiveTable, type LifecycleConfig,
  type PartitionState, type PlannerState,
} from "./types.js";

const KIND_ORDER: ActionKind[] = ["ensure_partition", "install_guard", "seal", "expire", "propose_destruction"];
const BUSINESS = new Set(["document", "ledger", "audit"]);

export interface PlanOptions {
  calendar?: FiscalCalendar;
}

export function plan(decl: Declaration, state: PlannerState, now: Date, cfg: LifecycleConfig, o: PlanOptions = {}): Action[] {
  const out: Action[] = [];
  for (const t of rulesOf(decl, cfg)) {
    if (t.follows !== undefined) continue; // planned with the table it follows
    const parts = sortParts(state.partitions[t.name] ?? []);
    out.push(...ensure(t, parts, now), ...guards(t, parts));
    for (const p of parts) {
      const u: UnitFacts = { partition: p, record: state.units[t.name]?.[p.name] };
      const a = seal(t, u, now, o.calendar) ?? expire(t, u, state, now, o.calendar) ?? propose(t, u, state, now, o.calendar);
      if (a) out.push(a);
    }
  }
  return sortActions(out, state);
}

function sortParts(parts: PartitionState[]): PartitionState[] {
  return [...parts].sort((a, b) => (a.from?.getTime() ?? 0) - (b.from?.getTime() ?? 0) || cmp(a.name, b.name));
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function ensure(t: EffectiveTable, parts: PartitionState[], now: Date): Action[] {
  const p = t.partition;
  if (!p || !("grain" in p)) return [];
  return rangeWindow(t.name, p.grain as Grain, p.ahead ?? 2, now)
    .filter((w) => !parts.some((e) => e.from !== undefined && e.to !== undefined && e.from < w.to && e.to > w.from))
    .map((w) => ({ kind: "ensure_partition", table: t.name, unit: w.name, from: w.from, to: w.to, followers: [...t.followers] }));
}

function guards(t: EffectiveTable, parts: PartitionState[]): Action[] {
  if (t.tiers?.seal !== "immediate" || !BUSINESS.has(t.class)) return [];
  return parts.filter((p) => !p.guarded).map((p) => ({ kind: "install_guard", table: t.name, unit: p.name }));
}

const ended = (p: PartitionState, now: Date) => p.to !== undefined && p.to.getTime() <= now.getTime();

function seal(t: EffectiveTable, u: UnitFacts, now: Date, cal?: FiscalCalendar): Action | undefined {
  const rule = t.tiers?.seal;
  const p = u.partition;
  if (!BUSINESS.has(t.class) || rule === undefined || !ended(p, now) || p.to === undefined) return undefined;
  if (u.record && SEALED_STATES.has(u.record.state)) return undefined;
  const action: Action = { kind: "seal", table: t.name, unit: p.name, from: p.from, to: p.to };
  if (rule === "immediate") return action;
  if (rule === "on_signal" || rule === "never" || !p.stats) return undefined;
  const r = parseAfter(rule);
  if (r === "forever" || r === "never" || r.anchor === "sealed") return undefined;
  if (r.anchor === "closed" && t.closed === undefined) return undefined;
  if (p.stats.openRows > 0) {
    // the earliest instant the unit could be due; tried once, then BLOCKED until its rows close
    const earliest = addSpan(p.to, r.span);
    return u.record?.state !== "BLOCKED" && earliest <= now ? action : undefined;
  }
  return hasPassed(rule, u, now, cal) ? action : undefined;
}

function expire(t: EffectiveTable, u: UnitFacts, s: PlannerState, now: Date, cal?: FiscalCalendar): Action | undefined {
  const p = u.partition;
  if ((t.class !== "queue" && t.class !== "platform") || !ended(p, now) || !p.stats || p.from === undefined) return undefined;
  if (t.retention?.end === "keep") return undefined;
  if (p.stats.rows > 0 && (t.closed === undefined || p.stats.openRows > 0)) return undefined;
  if (t.class === "queue" && isHeld(s.holds, t, p.name)) return undefined;
  if (!hasPassed(t.retention?.min, u, now, cal)) return undefined;
  return { kind: "expire", table: t.name, unit: p.name, class: t.class };
}

function propose(t: EffectiveTable, u: UnitFacts, s: PlannerState, now: Date, cal?: FiscalCalendar): Action | undefined {
  const end = t.retention?.end;
  const min = t.retention?.min;
  const rec = u.record;
  if (!BUSINESS.has(t.class) || (end !== "destroy" && end !== "review") || min === undefined) return undefined;
  if (!rec || !SEALED_STATES.has(rec.state) || rec.state === "DESTROYED") return undefined;
  if (s.proposed.has(`${t.name}/${rec.unitKey}`) || isHeld(s.holds, t, rec.unitKey)) return undefined;
  if (!hasPassed(min, u, now, cal)) return undefined;
  return { kind: "propose_destruction", table: t.name, unit: rec.unitKey, basis: t.retention?.basis ?? "", end };
}

function sortActions(actions: Action[], s: PlannerState): Action[] {
  const from = (a: Action) => ("from" in a && a.from ? a.from.getTime() : (s.partitions[a.table]?.find((p) => p.name === a.unit)?.from?.getTime() ?? 0));
  return actions
    .map((a, i) => ({ a, i }))
    .sort((x, y) => KIND_ORDER.indexOf(x.a.kind) - KIND_ORDER.indexOf(y.a.kind) || cmp(x.a.table, y.a.table) ||
      from(x.a) - from(y.a) || cmp(x.a.unit, y.a.unit) || x.i - y.i)
    .map((x) => x.a);
}

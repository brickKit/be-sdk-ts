// The planner (P16, G12): a pure function of the declaration, the observed state, the time and DATA_LIFECYCLE.
// Test names follow the Go red tests of data-lifecycle-v2 §6.3 where one applies.
import { describe, expect, it } from "vitest";
import { parseDataLifecycle } from "../../../src/lifecycle/config.js";
import { loadDeclaration, parseDeclaration } from "../../../src/lifecycle/declaration.js";
import { plan } from "../../../src/lifecycle/planner.js";
import type { Action, Declaration, PartitionState, PlannerState, UnitRecord } from "../../../src/lifecycle/types.js";
import { rangePartition } from "../../../src/migrate/window.js";

const WIDGET = loadDeclaration(new URL("../../fixtures/lifecycle/widget/migrations/", import.meta.url).pathname);
const d = (s: string) => new Date(s);
const cfgOf = (decl: Declaration, raw?: object) => parseDataLifecycle(raw, decl);

function part(table: string, grain: "week" | "month" | "year", from: string, o: Partial<PartitionState> = {}): PartitionState {
  const p = rangePartition(table, grain, d(from));
  return { name: p.name, from: p.from, to: p.to, guarded: false, ...o };
}

function state(o: Partial<PlannerState> = {}): PlannerState {
  return { partitions: {}, units: {}, holds: [], proposed: new Set(), ...o };
}

function unitRec(table: string, unitKey: string, s: UnitRecord["state"], sealedAt?: string): Record<string, Record<string, UnitRecord>> {
  return { [table]: { [unitKey]: { table, unitKey, state: s, sealedAt: sealedAt ? d(sealedAt) : undefined } } };
}

const kinds = (a: Action[], kind: Action["kind"], table?: string) => a.filter((x) => x.kind === kind && (!table || x.table === table));

describe("plan: ensure partitions ahead (G1)", () => {
  it("TestEnsureAhead_window_covers_ahead: current period and `ahead` more, followers in the same action", () => {
    const a = plan(WIDGET, state(), d("2026-10-03T12:00:00Z"), cfgOf(WIDGET));
    const w = kinds(a, "ensure_partition", "widgets");
    expect(w.map((x) => x.unit)).toEqual(["widgets_2026m10", "widgets_2026m11", "widgets_2026m12", "widgets_2027m01"]);
    expect(w[0]).toMatchObject({ followers: ["widget_lines"] });
    expect(kinds(a, "ensure_partition", "widget_lines")).toEqual([]);
    expect(kinds(a, "ensure_partition", "widget_jobs")).toHaveLength(3);
    expect(kinds(a, "ensure_partition", "besdk_outbox")).toHaveLength(3);
    expect(kinds(a, "ensure_partition", "widget_owners")).toEqual([]);
  });

  it("TestEnsureAhead_existing_partition_with_another_name_is_taken_over (by boundary, never by name)", () => {
    const existing = { ...part("widgets", "month", "2026-10-01T00:00:00Z"), name: "widgets_2026_10" };
    const a = plan(WIDGET, state({ partitions: { widgets: [existing] } }), d("2026-10-03T12:00:00Z"), cfgOf(WIDGET));
    expect(kinds(a, "ensure_partition", "widgets").map((x) => x.unit)).not.toContain("widgets_2026m10");
  });
});

describe("plan: seal", () => {
  const now = d("2028-06-01T00:00:00Z");
  const old = (o: Partial<PartitionState>) => part("widgets", "month", "2026-01-01T00:00:00Z", o);

  it("all rows closed 18 months ago → seal; closed more recently → nothing yet", () => {
    const due = plan(WIDGET, state({ partitions: { widgets: [old({ stats: { rows: 3, openRows: 0, maxClosedAt: d("2026-11-30T00:00:00Z") } })] } }), now, cfgOf(WIDGET));
    expect(kinds(due, "seal", "widgets").map((x) => x.unit)).toEqual(["widgets_2026m01"]);
    const notYet = plan(WIDGET, state({ partitions: { widgets: [old({ stats: { rows: 3, openRows: 0, maxClosedAt: d("2027-01-15T00:00:00Z") } })] } }), now, cfgOf(WIDGET));
    expect(kinds(notYet, "seal")).toEqual([]);
  });

  it("TestSeal_open_rows: a unit with open rows is tried once (the executor marks it BLOCKED), not again while BLOCKED", () => {
    const p = old({ stats: { rows: 3, openRows: 1, maxClosedAt: d("2026-02-01T00:00:00Z") } });
    expect(kinds(plan(WIDGET, state({ partitions: { widgets: [p] } }), now, cfgOf(WIDGET)), "seal")).toHaveLength(1);
    const blocked = state({ partitions: { widgets: [p] }, units: unitRec("widgets", p.name, "BLOCKED") });
    expect(kinds(plan(WIDGET, blocked, now, cfgOf(WIDGET)), "seal")).toEqual([]);
    const cleared = state({ partitions: { widgets: [{ ...p, stats: { rows: 3, openRows: 0, maxClosedAt: d("2026-02-01T00:00:00Z") } }] }, units: unitRec("widgets", p.name, "BLOCKED") });
    expect(kinds(plan(WIDGET, cleared, now, cfgOf(WIDGET)), "seal")).toHaveLength(1);
  });

  it("an already sealed unit and the current partition are never planned", () => {
    const p = old({ stats: { rows: 1, openRows: 0, maxClosedAt: d("2026-01-02T00:00:00Z") } });
    const a = plan(WIDGET, state({ partitions: { widgets: [p] }, units: unitRec("widgets", p.name, "SEALED", "2027-08-01T00:00:00Z") }), now, cfgOf(WIDGET));
    expect(kinds(a, "seal")).toEqual([]);
  });

  it("immediate: the guard is installed on every unguarded partition, the digest taken once the range has ended", () => {
    const past = part("widget_ledger", "month", "2026-09-01T00:00:00Z", { stats: { rows: 2, openRows: 0 } });
    const cur = part("widget_ledger", "month", "2026-10-01T00:00:00Z");
    const a = plan(WIDGET, state({ partitions: { widget_ledger: [past, cur] } }), d("2026-10-03T00:00:00Z"), cfgOf(WIDGET));
    expect(kinds(a, "install_guard", "widget_ledger").map((x) => x.unit)).toEqual([past.name, cur.name]);
    expect(kinds(a, "seal", "widget_ledger").map((x) => x.unit)).toEqual([past.name]);
    expect(kinds(a, "ensure_partition", "widget_ledger").length).toBeGreaterThan(0);
  });

  it("on_signal is never planned: the component seals in its own transaction", () => {
    const decl = parseDeclaration("lifecycle: v1\ntables:\n  lines: {class: ledger, partition: {by: period, kind: list, opened_by: command}, tiers: {seal: on_signal}}\n");
    const p: PartitionState = { name: "lines_2026_p01", listValue: "2026-P01", guarded: false, stats: { rows: 5, openRows: 0 } };
    expect(plan(decl, state({ partitions: { lines: [p] } }), now, cfgOf(decl)).filter((x) => x.table === "lines")).toEqual([]);
  });
});

describe("plan: expire queue and platform partitions", () => {
  const jobs = (o: Partial<PartitionState>) => part("widget_jobs", "week", "2026-08-03T00:00:00Z", o);
  const now = d("2026-10-03T00:00:00Z");

  it("a queue partition without open rows past retention.min is expired; open rows keep it", () => {
    expect(kinds(plan(WIDGET, state({ partitions: { widget_jobs: [jobs({ stats: { rows: 0, openRows: 0 } })] } }), now, cfgOf(WIDGET)), "expire"))
      .toEqual([{ kind: "expire", table: "widget_jobs", unit: "widget_jobs_2026w32", class: "queue" }]);
    expect(kinds(plan(WIDGET, state({ partitions: { widget_jobs: [jobs({ stats: { rows: 4, openRows: 1 } })] } }), now, cfgOf(WIDGET)), "expire")).toEqual([]);
    const recent = part("widget_jobs", "week", "2026-09-21T00:00:00Z", { stats: { rows: 0, openRows: 0 } });
    expect(kinds(plan(WIDGET, state({ partitions: { widget_jobs: [recent] } }), now, cfgOf(WIDGET)), "expire")).toEqual([]);
  });

  it("a queue whose open rows the declaration cannot tell (no `closed`) keeps every non-empty partition", () => {
    expect(kinds(plan(WIDGET, state({ partitions: { widget_jobs: [jobs({ stats: { rows: 4, openRows: 0 } })] } }), now, cfgOf(WIDGET)), "expire")).toEqual([]);
  });

  it("the outbox: a partition is dropped 14 days after all its rows are PUBLISHED", () => {
    const p = part("besdk_outbox", "week", "2026-09-07T00:00:00Z", { stats: { rows: 9, openRows: 0, maxClosedAt: d("2026-09-15T00:00:00Z") } });
    expect(kinds(plan(WIDGET, state({ partitions: { besdk_outbox: [p] } }), now, cfgOf(WIDGET)), "expire").map((x) => x.unit)).toEqual([p.name]);
    const late = { ...p, stats: { rows: 9, openRows: 0, maxClosedAt: d("2026-09-25T00:00:00Z") } };
    expect(kinds(plan(WIDGET, state({ partitions: { besdk_outbox: [late] } }), now, cfgOf(WIDGET)), "expire")).toEqual([]);
    const pending = { ...p, stats: { rows: 9, openRows: 2, maxClosedAt: d("2026-09-15T00:00:00Z") } };
    expect(kinds(plan(WIDGET, state({ partitions: { besdk_outbox: [pending] } }), now, cfgOf(WIDGET)), "expire")).toEqual([]);
  });

  it("TestPlan_hold_covers_unit: no Destroy, no Erase, no expiry of held queue data", () => {
    const p = jobs({ stats: { rows: 0, openRows: 0 } });
    const held = state({ partitions: { widget_jobs: [p] }, holds: [{ holdId: "h1", scope: { tables: ["widget_jobs"] } }] });
    expect(kinds(plan(WIDGET, held, now, cfgOf(WIDGET)), "expire")).toEqual([]);
  });
});

describe("plan: retention and destruction", () => {
  const audit = (from: string) => part("widget_audit", "month", from, { guarded: true, stats: { rows: 1, openRows: 0 } });

  it("TestPlan_cold_store_none: no Export, and no business unit is ever dropped", () => {
    const parts = { widgets: [part("widgets", "month", "2026-01-01T00:00:00Z", { stats: { rows: 1, openRows: 0, maxClosedAt: d("2026-01-02T00:00:00Z") } })], widget_audit: [audit("2026-01-01T00:00:00Z")] };
    const units = { ...unitRec("widgets", parts.widgets[0]!.name, "SEALED", "2027-08-01T00:00:00Z"), ...unitRec("widget_audit", parts.widget_audit[0]!.name, "SEALED", "2026-02-02T00:00:00Z") };
    const a = plan(WIDGET, state({ partitions: parts, units }), d("2080-01-01T00:00:00Z"), cfgOf(WIDGET));
    expect(a.map((x) => x.kind)).not.toContain("export");
    expect(a.map((x) => x.kind)).not.toContain("destroy");
    expect(a.filter((x) => x.kind === "expire" && ["widgets", "widget_audit", "widget_ledger"].includes(x.table))).toEqual([]);
  });

  it("TestPlan_review_due: only a destruction list entry, never a direct Destroy, and only once", () => {
    const p = audit("2026-01-01T00:00:00Z");
    const s = state({ partitions: { widget_audit: [p] }, units: unitRec("widget_audit", p.name, "SEALED", "2026-02-02T00:00:00Z") });
    expect(kinds(plan(WIDGET, s, d("2029-01-31T00:00:00Z"), cfgOf(WIDGET)), "propose_destruction")).toEqual([]);
    const due = kinds(plan(WIDGET, s, d("2029-02-01T00:00:00Z"), cfgOf(WIDGET)), "propose_destruction");
    expect(due).toEqual([{ kind: "propose_destruction", table: "widget_audit", unit: p.name, basis: "fixture: audit trail, never below 6 months", end: "destroy" }]);
    const again = plan(WIDGET, { ...s, proposed: new Set([`widget_audit/${p.name}`]) }, d("2029-02-01T00:00:00Z"), cfgOf(WIDGET));
    expect(kinds(again, "propose_destruction")).toEqual([]);
  });

  it("TestPlan_hold_covers_unit: a held unit is never proposed for destruction", () => {
    const p = audit("2026-01-01T00:00:00Z");
    const s = state({ partitions: { widget_audit: [p] }, units: unitRec("widget_audit", p.name, "SEALED", "2026-02-02T00:00:00Z"),
      holds: [{ holdId: "h", scope: { units: [{ table: "widget_audit", unit_key: p.name }] } }] });
    expect(kinds(plan(WIDGET, s, d("2040-01-01T00:00:00Z"), cfgOf(WIDGET)), "propose_destruction")).toEqual([]);
  });

  it("TestPlan_fiscal_year_end_anchor: counted from the day after the fiscal year ends", () => {
    const decl = parseDeclaration("lifecycle: v1\ntables:\n  book: {class: ledger, partition: {by: created_at, grain: month}, tiers: {seal: immediate}, retention: {min: 1y after fiscal_year_end, end: review, basis: b}}\n");
    const dec = part("book", "month", "2024-12-01T00:00:00Z", { guarded: true, stats: { rows: 1, openRows: 0 } });
    const jan = part("book", "month", "2025-01-01T00:00:00Z", { guarded: true, stats: { rows: 1, openRows: 0 } });
    const s = state({ partitions: { book: [dec, jan] }, units: { book: { ...unitRec("book", dec.name, "SEALED").book, ...unitRec("book", jan.name, "SEALED").book } } });
    const at = (t: string) => kinds(plan(decl, s, d(t), cfgOf(decl)), "propose_destruction").map((x) => x.unit);
    expect(at("2025-12-31T23:59:59Z")).toEqual([]);
    expect(at("2026-01-01T00:00:00Z")).toEqual([dec.name]);
    expect(at("2027-01-01T00:00:00Z")).toEqual([dec.name, jan.name]);
  });

  it("a deployment override lengthens the minimum", () => {
    const p = audit("2026-01-01T00:00:00Z");
    const s = state({ partitions: { widget_audit: [p] }, units: unitRec("widget_audit", p.name, "SEALED") });
    const cfg = cfgOf(WIDGET, { tables: { widget_audit: { retention: { min: "5y after created" } } } });
    expect(kinds(plan(WIDGET, s, d("2029-02-01T00:00:00Z"), cfg), "propose_destruction")).toEqual([]);
  });
});

describe("plan: determinism (G12)", () => {
  it("orders actions by kind, then table, then range; the same input gives the same output", () => {
    const s = state({ partitions: { widget_ledger: [part("widget_ledger", "month", "2026-09-01T00:00:00Z", { stats: { rows: 0, openRows: 0 } })] } });
    const a = plan(WIDGET, s, d("2026-10-03T00:00:00Z"), cfgOf(WIDGET));
    const order = ["ensure_partition", "install_guard", "seal", "expire", "propose_destruction"];
    const keys = a.map((x) => `${order.indexOf(x.kind)}|${x.table}`);
    expect(keys).toEqual([...keys].sort());
    expect(plan(WIDGET, s, d("2026-10-03T00:00:00Z"), cfgOf(WIDGET))).toEqual(a);
  });
});

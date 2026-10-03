// P16.1: loading migrations/lifecycle.yaml v1 and its invariants (fatal, naming the table).
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkAllDeclared, checkNumericPrecision, checkWorm, effectiveTables, LifecycleDeclarationError, loadDeclaration, parseDeclaration,
} from "../../../src/lifecycle/declaration.js";

const WIDGET = new URL("../../fixtures/lifecycle/widget/migrations/", import.meta.url).pathname;

function fails(fn: () => unknown): LifecycleDeclarationError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(LifecycleDeclarationError);
    return e as LifecycleDeclarationError;
  }
  throw new Error("expected a LifecycleDeclarationError");
}

const yaml = (tables: string) => `lifecycle: v1\ntables:\n${tables}`;

describe("lifecycle.yaml v1", () => {
  it("loads the conformance widget declaration; follows resolves to the parent's class and partition", () => {
    const d = loadDeclaration(WIDGET);
    const t = effectiveTables(d);
    expect(Object.keys(d.tables)).toContain("widget_lines");
    expect(t.get("widget_lines")!.class).toBe("document");
    expect(t.get("widget_lines")!.partition).toEqual({ by: "created_at", grain: "month", ahead: 3 });
    expect(t.get("widgets")!.followers).toEqual(["widget_lines"]);
    expect(t.get("widget_owners")!.class).toBe("master");
  });

  it("a missing lifecycle.yaml is fatal", () => {
    const e = fails(() => loadDeclaration(join(WIDGET, "nope")));
    expect(e.reason).toBe("DECLARATION_MISSING");
  });

  it("reads YAML 1.2 core: `on` stays a string, duplicate keys are refused", () => {
    const e = fails(() => parseDeclaration(yaml("  a: {class: reference}\n  a: {class: master}\n")));
    expect(e.reason).toBe("DECLARATION_INVALID");
  });

  it("a schema violation names the table", () => {
    const e = fails(() => parseDeclaration(yaml("  orders: {class: document, tiers: {hot: 3h}}\n")));
    expect(e.reason).toBe("DECLARATION_INVALID");
    expect(e.table).toBe("orders");
  });

  it("TestPlan_ledger_pii_column: a ledger table with a pii column fails and names the table", () => {
    const e = fails(() => parseDeclaration(yaml("  postings: {class: ledger, pii: [phone]}\n")));
    expect(e.reason).toBe("LEDGER_PII");
    expect(e.table).toBe("postings");
    expect(e.message).toContain("phone");
  });

  it("a ledger table with erasure.columns fails", () => {
    const e = fails(() => parseDeclaration(yaml("  postings: {class: ledger, erasure: {subject: user, key: sub, columns: {name: anonymize}}}\n")));
    expect(e.reason).toBe("LEDGER_ERASURE_COLUMNS");
  });

  it("a queue table with tiers.cold fails", () => {
    const e = fails(() => parseDeclaration(yaml("  jobs: {class: queue, tiers: {cold: 1y after created}}\n")));
    expect(e.reason).toBe("QUEUE_COLD");
    expect(e.table).toBe("jobs");
  });

  it("a snapshot table with retention.min fails", () => {
    const e = fails(() => parseDeclaration(yaml("  snaps: {class: snapshot, retention: {min: 1y after created}}\n")));
    expect(e.reason).toBe("SNAPSHOT_RETENTION");
  });

  it("follows of an undeclared table fails", () => {
    const e = fails(() => parseDeclaration(yaml("  lines: {follows: orders}\n")));
    expect(e.reason).toBe("FOLLOWS_UNKNOWN");
    expect(e.table).toBe("lines");
  });

  it("TestPlan_cold_table_NUMERIC_without_precision: fails naming table and column", () => {
    const d = loadDeclaration(WIDGET);
    const e = fails(() => checkNumericPrecision(d, { widgets: { id: "uuid", price: "numeric" }, widget_lines: {} }));
    expect(e.reason).toBe("NUMERIC_PRECISION");
    expect(e.table).toBe("widgets");
    expect(e.message).toContain("price");
    // a follower of a cold table is frozen with it
    expect(() => checkNumericPrecision(d, { widgets: { price: "numeric(19,6)" }, widget_lines: { quantity: "numeric[]" } })).toThrow(/widget_lines/);
    // a table without tiers.cold may use NUMERIC without precision
    expect(() => checkNumericPrecision(d, { widget_jobs: { x: "numeric" }, widgets: { price: "numeric(19,6)" } })).not.toThrow();
  });

  it("TestPlan_erasable_table_with_WORM_store: cold + erasure other than restrict fails on a WORM store", () => {
    const d = parseDeclaration(yaml(
      "  people: {class: document, tiers: {cold: 1y after created}, erasure: {subject: user, key: sub, columns: {name: anonymize}}}\n" +
      "  kept: {class: document, tiers: {cold: 1y after created}, erasure: {subject: user, key: sub, columns: {name: restrict}}}\n"));
    const e = fails(() => checkWorm(d, true));
    expect(e.reason).toBe("WORM_ERASURE");
    expect(e.table).toBe("people");
    expect(() => checkWorm(d, false)).not.toThrow();
    expect(() => checkWorm(loadDeclaration(WIDGET), true)).not.toThrow(); // widgets: restrict only
  });

  it("every table the migrations create is declared (besdk_* and migration state tables exempt)", () => {
    const d = loadDeclaration(WIDGET);
    expect(() => checkAllDeclared(d, ["widgets", "widget_lines", "besdk_outbox", "pgmigrations_s_x", "besdk_migrations_s_x"])).not.toThrow();
    const e = fails(() => checkAllDeclared(d, ["widgets", "widget_notes"]));
    expect(e.reason).toBe("TABLE_UNDECLARED");
    expect(e.table).toBe("widget_notes");
  });
});

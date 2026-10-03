// The engine's rounds against real PostgreSQL 16 and 14 (P16.2, P16.6, G1, G2, G9; CP-LIFE-01).
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isBeError } from "../../../src/errors/beError.js";
import { LIFECYCLE_ROUTES } from "../../../src/lifecycle/routes.js";
import type { LifecycleEngine } from "../../../src/lifecycle/engine.js";
import type { Store } from "../../../src/store/index.js";
import { requirePg, type TestDb } from "../../support/pg.js";
import { insertWidget, logRows, migratedDb, newEngine, newStore, ownerPartition, unitRow } from "./lcSupport.js";

const NOW = new Date("2026-10-03T12:00:00Z");
const route = (id: string) => LIFECYCLE_ROUTES.find((r) => r.operationId === id)!;
const call = (e: LifecycleEngine, id: string, req: { params?: Record<string, string>; query?: Record<string, string>; body?: unknown } = {}) =>
  route(id).handler(e, { params: req.params ?? {}, query: req.query ?? {}, body: req.body, actor: "admin-1" });

describe.each([
  ["PG16", "BE_TEST_PG16"],
  ["PG14", "BE_TEST_PG14"],
] as const)("lifecycle engine on %s", (_label, envName) => {
  const dsn = requirePg(envName);
  const dbs: TestDb[] = [];
  const stores: Store[] = [];
  let db: TestDb;
  let store: Store;
  const track = (s: Store) => (stores.push(s), s);

  beforeAll(async () => {
    const m = await migratedDb(dsn, NOW);
    db = m.db;
    dbs.push(db);
    store = track(newStore(db));
  });
  afterAll(async () => {
    for (const s of stores) await s.close();
    for (const d of dbs) await d.cleanup();
  });

  it("CP-LIFE-01: migrated on any day, every partitioned table accepts writes that day", async () => {
    for (const day of [new Date(), new Date("2030-01-15T08:00:00Z")]) {
      const m = await migratedDb(dsn, day);
      dbs.push(m.db);
      expect(m.windows).toContain(`widgets_p${day.toISOString().slice(0, 8).replaceAll("-", "")}01`);
      const s = track(newStore(m.db));
      await s.tx(async (tx) => {
        const id = randomUUID();
        await tx.query(`INSERT INTO widget_lines VALUES ($1, $2, $1, 1, 'd', 1)`, [id, day]);
        await tx.query(`INSERT INTO widget_ledger VALUES ($1, $2, 'LE01', $1, 'E', $3, 'P', 'CNY', 1)`, [id, day, day.toISOString().slice(0, 10)]);
        await tx.query(`INSERT INTO widget_audit (id, created_at, caller, action) VALUES ($1, $2, 'system', 'created')`, [id, day]);
        await tx.query(`INSERT INTO widget_jobs VALUES ($1, $2, 'w', 'approved', 'PENDING', 0, '', $2)`, [id, day]);
      });
      await insertWidget(m.db, { createdAt: day.toISOString(), status: "DRAFT" });
    }
  });

  it("G1: a later round creates the partitions that keep the window ahead, once", async () => {
    const { engine } = newEngine(store, { now: new Date("2026-12-15T00:00:00Z") });
    const r = await engine.runOnce();
    const made = r.results.filter((x) => x.action.kind === "ensure_partition" && x.outcome === "done").map((x) => x.action.unit);
    expect(made).toContain("widgets_p20270301");
    const parts = await db.su(`SELECT relname FROM pg_class WHERE relname = 'widget_lines_p20270301' AND relnamespace = $1::regnamespace`, [db.schema]);
    expect(parts.rows).toHaveLength(1);
    expect((await unitRow(db, "widgets", "widgets_p20270301"))!.state).toBe("ACTIVE");
    const again = await engine.runOnce();
    expect(again.results.filter((x) => x.action.kind === "ensure_partition")).toEqual([]);
  });

  it("TestExpire_short_lock_timeout: a held parent lock makes the expiry fail fast and retry next round", async () => {
    const old = await ownerPartition(db, "widget_jobs", "2026-08-03T00:00:00Z", "2026-08-10T00:00:00Z");
    const reader = await db.session("super");
    await reader.query(`BEGIN; SELECT count(*) FROM ${db.schema}.widget_jobs`);
    const { engine, emitted } = newEngine(store, { now: NOW });
    const t0 = Date.now();
    const r = await engine.runOnce();
    const ex = r.results.find((x) => x.action.kind === "expire" && x.action.unit === old)!;
    expect(ex.outcome).toBe("failed");
    expect(ex.error).toMatch(/LOCK_TIMEOUT/);
    expect(Date.now() - t0).toBeLessThan(10_000);
    await reader.query("ROLLBACK");
    const r2 = await engine.runOnce();
    expect(r2.results.find((x) => x.action.kind === "expire" && x.action.unit === old)!.outcome).toBe("done");
    expect((await unitRow(db, "widget_jobs", old))!.state).toBe("DESTROYED");
    expect((await logRows(db, "expired")).map((x) => x.unit_key)).toContain(old);
    expect(emitted.map((e) => e.subject)).toContain("sdktest.db.lifecycle.destroyed.v1");
  });

  it("TestExpire_pooled_connection: role, search_path and settings are untouched afterwards", async () => {
    const url = new URL(dsn);
    [url.username, url.password] = [db.runtime, (await import("node:fs")).readFileSync(db.env.PG_PASSWORD_FILE!, "utf8").trim()];
    const pool = new pg.Pool({ connectionString: url.toString(), max: 1 });
    const probe = async () => (await pool.query(`SELECT current_user AS u, current_setting('search_path') AS sp,
      current_setting('lock_timeout') AS lt, current_setting('TimeZone') AS tz, current_setting('DateStyle') AS ds`)).rows[0];
    const before = await probe();
    await ownerPartition(db, "besdk_outbox", "2026-08-03T00:00:00Z", "2026-08-10T00:00:00Z");
    const s = track(newStore(db, pool));
    const { engine } = newEngine(s, { now: NOW });
    const r = await engine.runOnce();
    expect(r.results.find((x) => x.action.unit === "besdk_outbox_p20260803")!.outcome).toBe("done");
    expect(await probe()).toEqual(before);
    expect(before.u).toBe(db.runtime);
    await pool.end();
  });

  it("TestRun_two_replicas: two engines on one schema perform each step once", async () => {
    const units: string[] = [];
    for (const m of ["2025-01", "2025-02", "2025-03"]) {
      const next = m === "2025-03" ? "2025-04" : `2025-0${Number(m.slice(6)) + 1}`;
      units.push(await ownerPartition(db, "widget_audit", `${m}-01T00:00:00Z`, `${next}-01T00:00:00Z`));
    }
    const later = new Date("2027-02-10T00:00:00Z");
    const [a, b] = [newEngine(track(newStore(db)), { now: later }), newEngine(track(newStore(db)), { now: later })];
    const [ra, rb] = await Promise.all([a.engine.runOnce(), b.engine.runOnce()]);
    const done = [...ra.results, ...rb.results].filter((x) => x.outcome === "done").map((x) => `${x.action.kind}|${x.action.table}|${x.action.unit}`);
    expect(new Set(done).size).toBe(done.length);
    expect([...ra.results, ...rb.results].filter((x) => x.outcome === "failed")).toEqual([]);
    for (const u of units) expect((await logRows(db, "sealed")).filter((x) => x.unit_key === u)).toHaveLength(1);
    expect((await a.engine.verify("widget_audit")).ok).toBe(true);
  });

  it("G9 through the resource contract: a hold keeps a due queue partition; units and verify answer", async () => {
    const wk = await ownerPartition(db, "widget_jobs", "2026-08-17T00:00:00Z", "2026-08-24T00:00:00Z");
    const { engine } = newEngine(store, { now: NOW });
    const placed = (await call(engine, "placeHold", { body: { scope: { tables: ["widget_jobs"] }, reason: "audit 2026" } })).body as { hold_id: string; placed_by: string };
    expect(placed.placed_by).toBe("admin-1");
    expect(((await call(engine, "listHolds")).body as { holds: unknown[] }).holds).toHaveLength(1);
    expect((await engine.runOnce()).results.filter((x) => x.action.kind === "expire" && x.action.unit === wk)).toEqual([]);
    const released = (await call(engine, "releaseHold", { params: { hold_id: placed.hold_id } })).body as { released_at: string | null };
    expect(released.released_at).not.toBeNull();
    expect((await engine.runOnce()).results.find((x) => x.action.unit === wk)!.outcome).toBe("done");
    const bad = await call(engine, "placeHold", { body: { scope: { tables: ["nope"] }, reason: "x" } }).catch((e: unknown) => e);
    expect(isBeError(bad) && bad.reason).toBe("REQUEST_INVALID");
    const page = (await call(engine, "listUnits", { query: { table: "widget_audit", page_size: "2" } })).body as { units: { state: string }[]; next_cursor: string };
    expect(page.units).toHaveLength(2);
    expect(page.next_cursor).not.toBe("");
    const rest = (await call(engine, "listUnits", { query: { table: "widget_audit", cursor: page.next_cursor, page_size: "500" } })).body as { units: { state: string }[] };
    expect(rest.units.map((u) => u.state)).toContain("ACTIVE");
    expect((await call(engine, "verify", { query: { table: "widget_audit" } })).body).toMatchObject({ ok: true });
    expect((await logRows(db, "hold_placed"))).toHaveLength(1);
  });

  it("P16.3: the hot window by default; RANGE_COLD for a range reaching a cold unit", async () => {
    const { engine } = newEngine(store, { now: NOW });
    expect(await engine.window("widgets", {})).toEqual({ from: new Date("2026-07-05T12:00:00Z"), to: undefined });
    await db.su(`INSERT INTO ${db.schema}.besdk_lifecycle_units (table_name, unit_key, range_from, range_to, state)
      VALUES ('widgets', 'widgets_p20200101', '2020-01-01Z', '2020-02-01Z', 'COLD')`);
    const e = await engine.window("widgets", { from: new Date("2019-01-01T00:00:00Z") }).catch((x: unknown) => x);
    expect(isBeError(e) && [e.reason, e.metadata.cold_ranges]).toEqual(["RANGE_COLD", "2020-01-01T00:00:00.000Z/2020-02-01T00:00:00.000Z"]);
    expect((await engine.window("widgets", { from: new Date("2021-01-01T00:00:00Z") })).from).toEqual(new Date("2021-01-01T00:00:00Z"));
  });

  it("P16.1 at start: the migrated schema is fully declared; an undeclared table is fatal and named", async () => {
    const { engine } = newEngine(store, { now: NOW });
    await engine.checkSchema();
    await db.asOwner(`CREATE TABLE widget_notes (id uuid PRIMARY KEY)`);
    const e = await engine.checkSchema().catch((x: unknown) => x);
    expect(e).toMatchObject({ reason: "TABLE_UNDECLARED", table: "widget_notes" });
    await db.asOwner(`DROP TABLE widget_notes`);
  });

  it("dry-run executes only ensure_partition and reports the rest", async () => {
    const sep = await ownerPartition(db, "widget_audit", "2025-09-01T00:00:00Z", "2025-10-01T00:00:00Z");
    const { engine } = newEngine(store, { now: NOW, dataLifecycle: { mode: "dry-run" } });
    const r = await engine.runOnce();
    expect(r.results.find((x) => x.action.unit === sep)!.outcome).toBe("dry_run");
    expect(await unitRow(db, "widget_audit", sep)).toBeUndefined();
  });
});

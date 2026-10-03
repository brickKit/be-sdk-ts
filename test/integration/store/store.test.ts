// Store against real PostgreSQL 16 and 14 (P10.2–P10.6, P10.8).
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { runUnit, Unit } from "../../../src/context.js";
import { BeError } from "../../../src/errors/beError.js";
import { newMemberRegistry } from "../../../src/obs/metrics.js";
import { isUniqueViolation, Store } from "../../../src/store/index.js";
import { captureLogger } from "../../support/capture.js";
import { createTestDb, requirePg, type TestDb } from "../../support/pg.js";

const MEMBER = "sdktest/db";

function unit(ms: number, signal = new AbortController().signal) {
  return new Unit({ memberId: MEMBER, deadline: Date.now() + ms, signal });
}

async function caught(p: Promise<unknown>): Promise<BeError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(BeError);
    return e as BeError;
  }
  throw new Error("expected a BeError");
}

describe.each([
  ["PG16", "BE_TEST_PG16"],
  ["PG14", "BE_TEST_PG14"],
] as const)("Store on %s", (_label, envName) => {
  const dsn = requirePg(envName);
  let db: TestDb;
  const stores: Store[] = [];
  const newStore = (over: Record<string, string> = {}, extra: Partial<ConstructorParameters<typeof Store>[0]> = {}) => {
    const metrics = newMemberRegistry(MEMBER);
    const s = new Store({ memberId: MEMBER, config: db.config(over), logger: captureLogger(MEMBER).logger, metrics, ...extra });
    stores.push(s);
    return { store: s, metrics };
  };

  beforeAll(async () => {
    db = await createTestDb(dsn);
    await db.asOwner(`CREATE TABLE items (id int PRIMARY KEY, name text NOT NULL, n int NOT NULL DEFAULT 0)`);
    await db.asOwner(`INSERT INTO items (id, name) VALUES (1, 'one'), (2, 'two')`);
  });
  afterAll(async () => {
    for (const s of stores) await s.close();
    await db?.cleanup();
  });

  it("opens every transaction with the SET LOCAL block, and nothing leaks after commit", async () => {
    // a pool of one connection logged in as the superuser stands in for a shell's login role
    const pool = new pg.Pool({ connectionString: dsn, max: 1 });
    const { store } = newStore({}, { pool });
    const inside = await store.tx(async (tx) =>
      (await tx.query(`SELECT current_user AS usr, current_setting('search_path') AS sp,
        current_setting('application_name') AS app, current_setting('statement_timeout') AS st,
        current_setting('lock_timeout') AS lt, current_setting('idle_in_transaction_session_timeout') AS it,
        current_setting('TimeZone') AS tz, current_setting('transaction_isolation') AS iso, pg_backend_pid() AS pid`))[0]!,
    );
    expect(inside).toMatchObject({ usr: db.runtime, sp: db.schema, app: MEMBER, st: "5s", lt: "2s", it: "30s", tz: "UTC", iso: "read committed" });
    const after = (await pool.query(`SELECT current_user AS usr, current_setting('search_path') AS sp,
      current_setting('application_name') AS app, current_setting('statement_timeout') AS st, pg_backend_pid() AS pid`)).rows[0];
    expect(after.pid).toBe(inside.pid);
    expect(after.usr).not.toBe(db.runtime);
    expect(after.sp).not.toBe(db.schema);
    expect(after.app).not.toBe(MEMBER);
    expect(after.st).toBe("0");
    await store.close();
    await pool.end();
  });

  it("honours isolation, read-only and the 30 s snapshot timeout", async () => {
    const { store } = newStore();
    // a unit with a minute left: the snapshot's own 30 s cap applies, not the deadline
    const snap = await runUnit(unit(60_000), () => store.readSnapshot(async (tx) =>
      (await tx.query(`SELECT current_setting('transaction_isolation') AS iso, current_setting('transaction_read_only') AS ro,
        current_setting('statement_timeout') AS st`))[0]!,
    ));
    expect(snap).toEqual({ iso: "repeatable read", ro: "on", st: "30s" });
    const ser = await store.tx(async (tx) => (await tx.query(`SELECT current_setting('transaction_isolation') AS iso`))[0]!, { isolation: "serializable" });
    expect(ser.iso).toBe("serializable");
  });

  it("caps statement_timeout by the remaining deadline", async () => {
    const { store } = newStore();
    const st = await runUnit(unit(1_500), () => store.tx(async (tx) => (await tx.query(`SELECT current_setting('statement_timeout') AS st`))[0]!.st));
    const ms = st.endsWith("ms") ? Number(st.slice(0, -2)) : Number(st.slice(0, -1)) * 1000;
    expect(ms).toBeGreaterThan(1_000);
    expect(ms).toBeLessThanOrEqual(1_500);
  });

  it("sets transaction_timeout to the remaining deadline on PostgreSQL 17+ only (first and later transactions)", async () => {
    const { store } = newStore();
    for (let i = 0; i < 2; i++) {
      const r = await runUnit(unit(20_000), () => store.tx(async (tx) =>
        (await tx.query(`SELECT current_setting('server_version_num')::int AS v, current_setting('transaction_timeout', true) AS tt`))[0]!));
      if (r.v < 170000) expect(r.tt).toBeNull();
      else {
        const ms = r.tt.endsWith("ms") ? Number(r.tt.slice(0, -2)) : Number(r.tt.slice(0, -1)) * 1000;
        expect(ms).toBeGreaterThan(19_000);
        expect(ms).toBeLessThanOrEqual(20_000);
      }
    }
  });

  it("prefixes every statement with /* be:<schema> */ (visible in pg_stat_activity)", async () => {
    const { store } = newStore();
    const text = await store.tx(async (tx) => (await tx.query(`SELECT query FROM pg_stat_activity WHERE pid = pg_backend_pid()`))[0]!.query);
    expect(text.startsWith(`/* be:${db.schema} */ SELECT query`)).toBe(true);
  });

  it("validates rows with a zod schema", async () => {
    const { store } = newStore();
    const rows = await store.tx((tx) => tx.query(`SELECT id, name FROM items ORDER BY id`, [], z.object({ id: z.number(), name: z.string() })));
    expect(rows).toEqual([{ id: 1, name: "one" }, { id: 2, name: "two" }]);
    const e = await caught(store.tx((tx) => tx.query(`SELECT id, name FROM items`, [], z.object({ id: z.string() }))));
    expect([e.code, e.reason]).toEqual(["INTERNAL", "INTERNAL"]);
  });

  it("refuses a nested transaction with NESTED_TX", async () => {
    const { store } = newStore();
    const e = await caught(store.tx(() => store.tx(async () => 1)));
    expect([e.code, e.reason, e.domain]).toEqual(["INTERNAL", "NESTED_TX", "be"]);
  });

  it("re-runs the body on a serialization failure and succeeds", async () => {
    const { store, metrics } = newStore();
    let attempts = 0;
    const r = await store.tx(async (tx) => {
      attempts++;
      if (attempts === 1) await tx.query(`DO $$ BEGIN RAISE EXCEPTION USING ERRCODE = '40001'; END $$`);
      return (await tx.query(`SELECT 7 AS v`))[0]!.v;
    });
    expect([r, attempts]).toEqual([7, 2]);
    const retries = (await metrics.be.txRetries.get()).values;
    expect(retries.map((v) => [v.labels, v.value])).toEqual([[{ sqlstate: "40001" }, 1]]); // be_tx_retries_total{sqlstate} (stage-B ruling)
  });

  it("gives up after 3 attempts with ABORTED / TX_CONFLICT", async () => {
    const { store } = newStore();
    let attempts = 0;
    const e = await caught(store.tx(async (tx) => {
      attempts++;
      await tx.query(`DO $$ BEGIN RAISE EXCEPTION USING ERRCODE = '40P01'; END $$`);
    }));
    expect([e.code, e.reason, attempts]).toEqual(["ABORTED", "TX_CONFLICT", 3]);
  });

  it("two concurrent serializable writers: one is re-run and both commit", async () => {
    await db.asOwner(`CREATE TABLE IF NOT EXISTS ledger (k int PRIMARY KEY, total int NOT NULL); INSERT INTO ledger VALUES (1, 0) ON CONFLICT DO NOTHING`);
    const { store } = newStore();
    const bump = () => store.tx(async (tx) => {
      const [row] = await tx.query(`SELECT total FROM ledger WHERE k = 1`);
      await delay(150);
      await tx.query(`UPDATE ledger SET total = $1 WHERE k = 1`, [row!.total + 1]);
    }, { isolation: "serializable" });
    await Promise.all([bump(), bump()]);
    const [row] = await store.tx((tx) => tx.query(`SELECT total FROM ledger WHERE k = 1`));
    expect(row!.total).toBe(2);
  });

  it("maps a lock wait over 2 s to ABORTED / LOCK_TIMEOUT", async () => {
    const holder = await db.session();
    await holder.query(`BEGIN; SELECT * FROM ${db.schema}.items WHERE id = 1 FOR UPDATE`);
    const { store } = newStore();
    const t0 = Date.now();
    const e = await caught(store.tx((tx) => tx.query(`UPDATE items SET n = n + 1 WHERE id = 1`)));
    const took = Date.now() - t0;
    await holder.query("ROLLBACK");
    expect([e.code, e.reason]).toEqual(["ABORTED", "LOCK_TIMEOUT"]);
    expect(took).toBeGreaterThanOrEqual(1_900);
    expect(took).toBeLessThan(3_500);
  });

  it("fails with RESOURCE_EXHAUSTED / DB_POOL_EXHAUSTED when the member's budget is used up", async () => {
    const { store, metrics } = newStore({ PG_POOL_MAX: "1", PG_POOL_ACQUIRE_TIMEOUT: "200ms" });
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const first = store.tx(async (tx) => {
      await tx.query("SELECT 1");
      await held;
    });
    await delay(100);
    const t0 = Date.now();
    const e = await caught(store.tx((tx) => tx.query("SELECT 1")));
    expect([e.code, e.reason]).toEqual(["RESOURCE_EXHAUSTED", "DB_POOL_EXHAUSTED"]);
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect((await metrics.be.dbPoolInUse.get()).values[0]?.value).toBe(1);
    release();
    await first;
    await store.tx((tx) => tx.query("SELECT 1"));
    expect((await metrics.be.dbPoolInUse.get()).values[0]?.value).toBe(0);
    const waits = (await metrics.be.dbPoolWait.get()).values.find((v) => v.metricName === "be_db_pool_wait_seconds_count");
    expect(waits?.value).toBe(3);
  });

  it("refuses a statement once the deadline has passed and rolls back", async () => {
    const { store } = newStore();
    const e = await caught(runUnit(unit(300), () => store.tx(async (tx) => {
      await tx.query(`INSERT INTO items (id, name) VALUES (100, 'late')`);
      await delay(400);
      await tx.query("SELECT 1");
    })));
    expect(e.code).toBe("DEADLINE_EXCEEDED");
    const rows = await store.tx((tx) => tx.query(`SELECT 1 FROM items WHERE id = 100`));
    expect(rows).toHaveLength(0);
  });

  it("a statement running past the deadline is cancelled: DEADLINE_EXCEEDED / STATEMENT_TIMEOUT", async () => {
    const { store } = newStore();
    const t0 = Date.now();
    const e = await caught(runUnit(unit(600), () => store.tx((tx) => tx.query("SELECT pg_sleep(3)"))));
    expect([e.code, e.reason]).toEqual(["DEADLINE_EXCEEDED", "STATEMENT_TIMEOUT"]);
    expect(Date.now() - t0).toBeLessThan(1_500);
  });

  it("re-arms statement_timeout before a later statement so the transaction never outlives its deadline", async () => {
    const { store } = newStore();
    const t0 = Date.now();
    const e = await caught(runUnit(unit(1_200), () => store.tx(async (tx) => {
      await delay(700);
      await tx.query("SELECT pg_sleep(3)");
    })));
    expect(e.code).toBe("DEADLINE_EXCEEDED");
    expect(Date.now() - t0).toBeLessThan(1_900);
  });

  it("an aborted unit cancels the running statement with CANCELLED", async () => {
    const { store } = newStore();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    const t0 = Date.now();
    const e = await caught(runUnit(unit(10_000, ac.signal), () => store.tx((tx) => tx.query("SELECT pg_sleep(3)"))));
    expect(e.code).toBe("CANCELLED");
    expect(Date.now() - t0).toBeLessThan(1_500);
    await store.tx((tx) => tx.query("SELECT 1"));
  });

  it("a swallowed statement error does not commit silently", async () => {
    const { store } = newStore();
    const e = await caught(store.tx(async (tx) => {
      await tx.query(`INSERT INTO items (id, name) VALUES (200, 'x')`);
      await tx.query(`INSERT INTO items (id, name) VALUES (1, 'dup')`).catch(() => undefined);
    }));
    expect(e.code).toBe("INTERNAL");
    expect(await store.tx((tx) => tx.query(`SELECT 1 FROM items WHERE id = 200`))).toHaveLength(0);
  });

  it("unique violations stay recognisable through isUniqueViolation", async () => {
    const { store } = newStore();
    let err: unknown;
    try {
      await store.tx((tx) => tx.query(`INSERT INTO items (id, name) VALUES (1, 'dup')`));
    } catch (e) {
      err = e;
    }
    expect(isUniqueViolation(err)).toBe(true);
    expect((err as BeError).message).not.toContain("items_pkey");
  });

  it("transaction-level advisory locks: tryLock fails while another transaction holds the key", async () => {
    const { store } = newStore();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const holder = store.tx(async (tx) => {
      await tx.lock("job", "a", "b");
      locked();
      await held;
    });
    await isLocked;
    expect(await store.tx((tx) => tx.tryLock("job", "a", "b"))).toBe(false);
    expect(await store.tx((tx) => tx.tryLock("job", "a", "c"))).toBe(true);
    release();
    await holder;
    expect(await store.tx((tx) => tx.tryLock("job", "a", "b"))).toBe(true);
  });

  it("publish and enqueue need their capability; injected extensions receive the tx", async () => {
    const { store } = newStore();
    const e = await caught(store.tx((tx) => tx.publish({ subject: "x" })));
    expect([e.code, e.reason, e.metadata.capability]).toEqual(["UNIMPLEMENTED", "CAPABILITY_UNAVAILABLE", "events"]);
    const e2 = await caught(store.tx((tx) => tx.enqueue("k", {})));
    expect(e2.metadata.capability).toBe("jobs");
    const seen: string[] = [];
    const { store: s2 } = newStore({}, { extensions: { publish: async (tx, ev) => void seen.push(`${tx.schema}:${(ev as { subject: string }).subject}`) } });
    await s2.tx((tx) => tx.publish({ subject: "y" }));
    expect(seen).toEqual([`${db.schema}:y`]);
  });

  it("reports its identity", () => {
    const { store } = newStore();
    expect(store.identity).toEqual({ role: db.runtime, schema: db.schema });
  });

  it("new connections use a rotated password file", async () => {
    const { store } = newStore({ PG_POOL_MAX: "1" });
    await store.tx((tx) => tx.query("SELECT 1"));
    await db.rotateRuntimePassword();
    await db.su(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1`, [db.runtime]);
    await delay(1_200); // the secret is re-checked at most once a second
    const usr = await store.tx(async (tx) => (await tx.query(`SELECT current_user AS u`))[0]!.u);
    expect(usr).toBe(db.runtime);
  });
});

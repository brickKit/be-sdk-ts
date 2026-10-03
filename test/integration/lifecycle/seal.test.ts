// Sealing against real PostgreSQL 16 and 14 (P16.5, G5, G6; data-lifecycle-v2 §6.3 executor red tests).
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isBeError } from "../../../src/errors/beError.js";
import type { Store } from "../../../src/store/index.js";
import { requirePg, type TestDb } from "../../support/pg.js";
import { insertWidget, logRows, migratedDb, newEngine, newStore, ownerPartition, unitRow } from "./lcSupport.js";

const NOW = new Date("2026-10-03T12:00:00Z");

async function sealedError(p: Promise<unknown>) {
  const e = await p.then(() => undefined, (x: unknown) => x);
  expect(isBeError(e)).toBe(true);
  return e as { code: string; reason: string };
}

describe.each([
  ["PG16", "BE_TEST_PG16"],
  ["PG14", "BE_TEST_PG14"],
] as const)("lifecycle seal on %s", (_label, envName) => {
  const dsn = requirePg(envName);
  let db: TestDb;
  let store: Store;
  let jan: string;

  beforeAll(async () => {
    db = (await migratedDb(dsn, NOW)).db;
    store = newStore(db);
    jan = await ownerPartition(db, "widgets", "2024-01-01T00:00:00Z", "2024-02-01T00:00:00Z");
    await ownerPartition(db, "widget_lines", "2024-01-01T00:00:00Z", "2024-02-01T00:00:00Z");
  });
  afterAll(async () => {
    await store?.close();
    await db?.cleanup();
  });

  it("TestSeal_open_rows: the unit is BLOCKED and the first 100 open ids are recorded", async () => {
    await insertWidget(db, { createdAt: "2024-01-05T00:00:00Z", status: "APPROVED", updatedAt: "2024-01-20T00:00:00Z" });
    const open: string[] = [];
    for (let i = 0; i < 150; i++) open.push(await insertWidget(db, { createdAt: "2024-01-06T00:00:00Z", status: "DRAFT" }));
    const { engine } = newEngine(store, { now: NOW });
    const r = await engine.runOnce();
    const seal = r.results.find((x) => x.action.kind === "seal" && x.action.unit === jan)!;
    expect(seal.outcome).toBe("blocked");
    const u = await unitRow(db, "widgets", jan);
    expect(u!.state).toBe("BLOCKED");
    expect(u!.blocked_reason).toContain("150 row(s) not closed");
    const blocked = await logRows(db, "blocked");
    const first100 = [...open].sort().slice(0, 100);
    expect(blocked.at(-1)!.detail.ids).toEqual(first100);
    expect(blocked.at(-1)!.detail.open_rows).toBe(150);
    // the partition is still writable
    await store.tx((tx) => tx.query(`UPDATE widgets SET status = 'APPROVED', updated_at = '2024-01-25T00:00:00Z' WHERE created_at < '2024-02-01'`));
  });

  it("seals once every row is closed: guard, digest, chain, units, log, event; followers sealed with it", async () => {
    const lineId = randomUUID();
    await db.su(`INSERT INTO ${db.schema}.widget_lines VALUES ($1, '2024-01-10T00:00:00Z', $2, 1, 'line ''one''', 1.5)`, [lineId, randomUUID()]);
    const { engine, emitted } = newEngine(store, { now: NOW });
    const r = await engine.runOnce();
    expect(r.results.find((x) => x.action.kind === "seal" && x.action.unit === jan)!.outcome).toBe("done");
    const u = await unitRow(db, "widgets", jan);
    expect(u).toMatchObject({ state: "SEALED", rows: "151", blocked_reason: null });
    const lines = await unitRow(db, "widget_lines", "widget_lines_p20240101");
    expect(lines!.state).toBe("SEALED");
    // an independent encoding of the follower's unit: declared order, text output (UTC), 0x1F between fields
    const enc = `${lineId}\x1f2024-01-10 00:00:00+00\x1f${(await db.su(`SELECT widget_id::text AS w FROM ${db.schema}.widget_lines`)).rows[0].w}\x1f1\x1fline 'one'\x1f1.500000`;
    const expected = createHash("sha256").update(enc, "utf8").digest();
    expect(lines!.unit_digest.equals(expected)).toBe(true);
    expect(lines!.chain_digest.equals(createHash("sha256").update(expected).digest())).toBe(true);
    expect((await logRows(db, "sealed")).map((x) => x.unit_key)).toEqual([jan]);
    expect(emitted.map((e) => e.subject)).toEqual(["sdktest.db.lifecycle.sealed.v1"]);
    expect(emitted[0]!.payload).toMatchObject({ table: "widgets", unit_key: jan, rows: 151 });
  });

  it("TestSeal_UPDATE_after_seal_refused: UPDATE, DELETE and TRUNCATE answer UNIT_SEALED (SQLSTATE BE001)", async () => {
    const upd = await sealedError(store.tx((tx) => tx.query(`UPDATE widgets SET name = 'x' WHERE created_at < '2024-02-01'`)));
    expect([upd.code, upd.reason]).toEqual(["FAILED_PRECONDITION", "UNIT_SEALED"]);
    expect((await sealedError(store.tx((tx) => tx.query(`DELETE FROM widget_lines WHERE created_at < '2024-02-01'`)))).reason).toBe("UNIT_SEALED");
    const raw = await db.su(`SELECT 1`).then(async () => {
      try {
        await db.su(`TRUNCATE ${db.schema}.${jan}`);
        return "truncated";
      } catch (e) {
        return (e as { code?: string }).code;
      }
    });
    expect(raw).toBe("BE001");
    // the hot partitions stay writable
    await insertWidget(db, { createdAt: NOW.toISOString(), status: "DRAFT" });
    await store.tx((tx) => tx.query(`UPDATE widgets SET name = 'y' WHERE created_at >= '2026-10-01'`));
  });

  it("TestSeal_immediate: a ledger partition refuses UPDATE from the moment the migration created it", async () => {
    await db.su(`INSERT INTO ${db.schema}.widget_ledger VALUES ($1, $2, 'LE01', $3, 'E-1', $4, '2026-P10', 'CNY', 10)`, [randomUUID(), NOW, randomUUID(), "2026-10-03"]);
    expect((await sealedError(store.tx((tx) => tx.query(`UPDATE widget_ledger SET amount = 11`)))).reason).toBe("UNIT_SEALED");
  });

  it("TestVerify_modified_sealed_row: the chain check finds a row changed behind the guard", async () => {
    const { engine } = newEngine(store, { now: NOW });
    expect(await engine.verify("widgets")).toEqual({ ok: true, units_checked: 1, mismatched_units: [] });
    await db.su(`ALTER TABLE ${db.schema}.${jan} DISABLE TRIGGER besdk_sealed_rows`);
    await db.su(`UPDATE ${db.schema}.${jan} SET name = 'tampered' WHERE ctid = (SELECT min(ctid) FROM ${db.schema}.${jan})`);
    await db.su(`ALTER TABLE ${db.schema}.${jan} ENABLE TRIGGER besdk_sealed_rows`);
    expect(await engine.verify("widgets")).toEqual({ ok: false, units_checked: 1, mismatched_units: [jan] });
    expect((await engine.verify("widget_lines")).ok).toBe(true);
  });

  it("TestSeal_on_signal_commits_and_rolls_back_with_the_business_transaction", async () => {
    const mar = await ownerPartition(db, "widgets", "2024-03-01T00:00:00Z", "2024-04-01T00:00:00Z");
    await insertWidget(db, { createdAt: "2024-03-02T00:00:00Z", status: "SUSPENDED", updatedAt: "2026-09-01T00:00:00Z" });
    const { engine } = newEngine(store, { now: NOW });
    const boom = await store.tx(async (tx) => {
      expect((await engine.sealInTx(tx, "widgets", mar)).outcome).toBe("sealed");
      throw new Error("business rule failed");
    }).catch((e: Error) => e.message);
    expect(boom).toBe("business rule failed");
    expect(await unitRow(db, "widgets", mar)).toBeUndefined();
    await store.tx((tx) => tx.query(`UPDATE widgets SET name = 'still writable' WHERE created_at >= '2024-03-01' AND created_at < '2024-04-01'`));
    const r = await store.tx((tx) => engine.sealInTx(tx, "widgets", mar));
    expect(r.outcome).toBe("sealed");
    expect((await unitRow(db, "widgets", mar))!.state).toBe("SEALED");
    expect((await store.tx((tx) => engine.sealInTx(tx, "widgets", mar))).outcome).toBe("already_sealed");
    expect((await engine.verify("widgets")).units_checked).toBe(2);
  });
});

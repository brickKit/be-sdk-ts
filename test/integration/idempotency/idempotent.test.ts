// Command idempotency on real PostgreSQL 16 (P13, CP-IDEM-01…07): one-step replay, binding mismatch, two-step
// claim / complete / release, caller namespaces, concurrency, rollback, expiry.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { VerifiedUser } from "../../../src/auth/jwt.js";
import { runUnit, Unit } from "../../../src/context.js";
import type { BeError } from "../../../src/errors/beError.js";
import { idempotent } from "../../../src/idempotency/index.js";
import { runMigrations } from "../../../src/migrate/index.js";
import { newMemberRegistry } from "../../../src/obs/metrics.js";
import { Store } from "../../../src/store/index.js";
import { captureLogger } from "../../support/capture.js";
import { createTestDb, DB_MIGRATIONS, requirePg, type TestDb } from "../../support/pg.js";

let db: TestDb;
let store: Store;
const log = captureLogger("sdktest/basic");

beforeAll(async () => {
  db = await createTestDb(requirePg("BE_TEST_PG16"));
  const config = db.config();
  await runMigrations({ memberId: "sdktest/basic", config, logger: log.logger, migrationsDir: DB_MIGRATIONS, direction: "up" });
  store = new Store({ memberId: "sdktest/basic", config, logger: log.logger, metrics: newMemberRegistry("sdktest/basic") });
});
afterAll(async () => {
  await store.close();
  await db.cleanup();
});

const as = <T>(sub: string | undefined, fn: () => Promise<T>): Promise<T> => {
  const u = new Unit({ memberId: "sdktest/basic", deadline: Date.now() + 10_000, signal: new AbortController().signal });
  if (sub) u.user = { sub } as VerifiedUser;
  return runUnit(u, fn);
};
const cmd = (key: string, request: unknown = { name: "A", price: "12.50" }, target = "") => ({ key, name: "sdktest.basic.create", target, request });
const caught = (p: Promise<unknown>) => p.then(() => { throw new Error("expected a failure"); }, (e: BeError) => e);

describe("idempotent() one-step (P13.2, P13.3, CP-IDEM-01…04)", () => {
  it("runs once and replays the stored result for the same key", async () => {
    let runs = 0;
    const once = () => as("u1", () => store.tx((tx) => idempotent(tx, cmd("k1"), async () => ({ id: `w${++runs}` }))));
    expect(await once()).toEqual({ result: { id: "w1" }, replayed: false });
    expect(await once()).toEqual({ result: { id: "w1" }, replayed: true });
    expect(runs).toBe(1);
  });
  it("replays a body that differs only in key order (JCS)", async () => {
    await as("u1", () => store.tx((tx) => idempotent(tx, cmd("k2", { a: 1, b: 2 }), async () => 7)));
    expect(await as("u1", () => store.tx((tx) => idempotent(tx, cmd("k2", { b: 2, a: 1 }), async () => 8)))).toEqual({ result: 7, replayed: true });
  });
  it("answers IDEMPOTENCY_MISMATCH for another body, command or target", async () => {
    await as("u1", () => store.tx((tx) => idempotent(tx, cmd("k3"), async () => 1)));
    for (const c of [cmd("k3", { name: "B" }), { ...cmd("k3"), name: "sdktest.basic.approve" }, cmd("k3", undefined, "w9")]) {
      const e = await caught(as("u1", () => store.tx((tx) => idempotent(tx, c, async () => 2))));
      expect([e.code, e.reason, e.domain]).toEqual(["INVALID_ARGUMENT", "IDEMPOTENCY_MISMATCH", "be"]);
    }
  });
  it("keeps callers apart: another user, a service and the system run their own command (CP-IDEM-06)", async () => {
    await as("u1", () => store.tx((tx) => idempotent(tx, cmd("k4"), async () => "u1")));
    expect(await as("u2", () => store.tx((tx) => idempotent(tx, cmd("k4"), async () => "u2")))).toEqual({ result: "u2", replayed: false });
    expect(await as(undefined, () => store.tx((tx) => idempotent(tx, cmd("k4"), async () => "sys")))).toEqual({ result: "sys", replayed: false });
  });
  it("leaves no key behind when the transaction rolls back", async () => {
    await caught(as("u1", () => store.tx((tx) => idempotent(tx, cmd("k5"), async () => { throw new Error("boom"); }))));
    expect(await as("u1", () => store.tx((tx) => idempotent(tx, cmd("k5"), async () => "second")))).toEqual({ result: "second", replayed: false });
  });
  it("executes concurrent same-key commands once (CP-IDEM-07)", async () => {
    let runs = 0;
    const one = () => as("u1", () => store.tx((tx) => idempotent(tx, cmd("k6"), async () => {
      runs++;
      await tx.query("SELECT pg_sleep(0.2)");
      return "done";
    })));
    const results = await Promise.all([one(), one(), one()]);
    expect(runs).toBe(1);
    expect(results.map((r) => r.result)).toEqual(["done", "done", "done"]);
    expect(results.filter((r) => r.replayed).length).toBe(2);
  });
  it("runs without idempotency when no key came", async () => {
    let runs = 0;
    for (let i = 0; i < 2; i++) await as("u1", () => store.tx((tx) => idempotent(tx, cmd(""), async () => ++runs)));
    expect(runs).toBe(2);
  });
  it("treats an expired key as unused (P13.7)", async () => {
    await as("u1", () => store.tx((tx) => idempotent(tx, cmd("k7"), async () => 1)));
    await db.su(`UPDATE "${db.schema}".besdk_idempotency SET expires_at = now() - interval '1 s' WHERE idempotency_key = 'k7'`);
    expect(await as("u1", () => store.tx((tx) => idempotent(tx, cmd("k7", { other: true }), async () => 2)))).toEqual({ result: 2, replayed: false });
  });
});

describe("two-step: claim, network call, complete or release (P13.3, CP-IDEM-05)", () => {
  it("answers IN_PROGRESS while claimed, replays once completed", async () => {
    expect(await as("u1", () => store.tx((tx) => tx.idemClaim(cmd("t1"))))).toEqual({ found: false, inProgress: false });
    const e = await caught(as("u1", () => store.tx((tx) => tx.idemClaim(cmd("t1")))));
    expect([e.code, e.reason]).toEqual(["ABORTED", "IDEMPOTENCY_IN_PROGRESS"]);
    expect(await as("u1", () => store.tx((tx) => tx.idemLookup(cmd("t1"))))).toEqual({ found: true, inProgress: true });
    await as("u1", () => store.tx((tx) => tx.idemComplete(cmd("t1"), { ok: 1 })));
    expect(await as("u1", () => store.tx((tx) => tx.idemClaim(cmd("t1"))))).toEqual({ found: true, inProgress: false, result: { ok: 1 } });
  });
  it("release frees the key for a retry", async () => {
    await as("u1", () => store.tx((tx) => tx.idemClaim(cmd("t2"))));
    await as("u1", () => store.tx((tx) => tx.idemRelease(cmd("t2"))));
    expect(await as("u1", () => store.tx((tx) => tx.idemClaim(cmd("t2"))))).toEqual({ found: false, inProgress: false });
  });
  it("lookup of an unknown key is not found", async () => {
    expect(await as("u1", () => store.tx((tx) => tx.idemLookup(cmd("t3"))))).toEqual({ found: false, inProgress: false });
  });
});

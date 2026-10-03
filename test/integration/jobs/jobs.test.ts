// Background work on real PostgreSQL 16 (P14, CP-JOBS-01…06): every, singleton, cron, queue and reconciler,
// two runtimes on one schema standing in for two replicas; `job run` once; JOBS_OVERRIDES.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JobsRuntime, type JobsModule, type Override } from "../../../src/jobs/index.js";
import { runMigrations } from "../../../src/migrate/index.js";
import { newMemberRegistry, type MemberRegistry } from "../../../src/obs/metrics.js";
import { Supervisor } from "../../../src/runtime/supervisor.js";
import { Store, type TxExtensions } from "../../../src/store/index.js";
import { captureLogger } from "../../support/capture.js";
import { createTestDb, DB_MIGRATIONS, requirePg, type TestDb } from "../../support/pg.js";

let db: TestDb;
const log = captureLogger("sdktest/basic", "debug");
const opened: { rt: JobsRuntime; sup: Supervisor; store: Store }[] = [];

beforeAll(async () => {
  db = await createTestDb(requirePg("BE_TEST_PG16"));
  await runMigrations({ memberId: "sdktest/basic", config: db.config(), logger: log.logger, migrationsDir: DB_MIGRATIONS, direction: "up" });
  await db.asOwner(`CREATE TABLE side (id text PRIMARY KEY, note text); CREATE TABLE items (id text PRIMARY KEY, state text NOT NULL, due timestamptz NOT NULL DEFAULT now())`);
});
afterAll(async () => {
  for (const o of opened) await stopOne(o);
  await db.cleanup();
});

async function stopOne(o: (typeof opened)[number]): Promise<void> {
  await o.sup.stop(2_000);
  await o.rt.stop();
  await o.store.close();
}

function replica(module: JobsModule, o: { overrides?: Record<string, Override>; start?: boolean; metrics?: MemberRegistry } = {}) {
  const ext: TxExtensions = {};
  const metrics = o.metrics ?? newMemberRegistry("sdktest/basic");
  const store = new Store({ memberId: "sdktest/basic", config: db.config(), logger: log.logger, metrics, extensions: ext });
  const rt = new JobsRuntime({ memberId: "sdktest/basic", store, logger: log.logger, metrics, module, zone: "UTC", overrides: o.overrides ?? {}, leaseTtlMs: 600, pollMs: 50 });
  rt.validate();
  Object.assign(ext, rt.extensions);
  const sup = new Supervisor(log.logger, { initialBackoffMs: 20, maxBackoffMs: 100 });
  if (o.start !== false) rt.start(sup);
  const r = { rt, sup, store, metrics };
  opened.push(r);
  return r;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (pred: () => boolean | Promise<boolean>, ms = 8_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return;
    await sleep(25);
  }
  throw new Error("timed out waiting");
};
const runs = async (m: MemberRegistry, job: string, result: string) => (await m.be.jobRuns.get()).values.filter((v) => v.labels.job === job && v.labels.result === result).reduce((n, v) => n + v.value, 0);

describe("every (P14.2)", () => {
  it("runs on its interval, records results, and keeps running after a failure", async () => {
    let n = 0;
    const r = replica({ jobs: [{ name: "tick", kind: "every", intervalMs: 50, timeoutMs: 1_000, run: async () => { if (++n === 2) throw new Error("once"); } }] });
    await waitFor(() => n >= 4);
    await stopOne(opened.pop()!);
    expect(await runs(r.metrics, "tick", "error")).toBe(1);
    expect(await runs(r.metrics, "tick", "ok")).toBeGreaterThanOrEqual(3);
  });
  it("cancels a run at its timeout", async () => {
    let aborted = false;
    const r = replica({ jobs: [{ name: "slow", kind: "every", intervalMs: 1_000, timeoutMs: 100, run: async (signal) => { await sleep(300); aborted = signal.aborted; } }] });
    await r.rt.runOnce("slow");
    expect(aborted).toBe(true);
    expect(await runs(r.metrics, "slow", "timeout")).toBe(1);
    await stopOne(opened.pop()!);
  });
});

describe("cron (CP-JOBS-01)", () => {
  it("two replicas run each @every slot once", async () => {
    const seen: string[] = [];
    const job = { name: "c1", kind: "cron" as const, cron: "@every 1s", timeoutMs: 1_000, run: async (_s: AbortSignal, info: { slotAt?: Date }) => void seen.push(info.slotAt!.toISOString()) };
    replica({ jobs: [job] });
    replica({ jobs: [job] });
    await sleep(2_600);
    await stopOne(opened.pop()!);
    await stopOne(opened.pop()!);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBeGreaterThanOrEqual(2);
    const { rows } = await db.su(`SELECT count(*)::int AS n FROM "${db.schema}".besdk_job_slot WHERE name = 'c1' AND done_at IS NOT NULL`);
    expect(rows[0].n).toBe(seen.length);
  });
});

describe("singleton (CP-JOBS-02)", () => {
  it("has one holder at a time; another replica takes over after the holder stops", async () => {
    const ran: string[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    const mk = (who: string) => ({ jobs: [{ name: "s1", kind: "singleton" as const, intervalMs: 30, timeoutMs: 1_000, run: async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      ran.push(who);
      await sleep(20);
      concurrent--;
    } }] });
    const a = replica(mk("a"));
    await waitFor(() => ran.length >= 3);
    const b = replica(mk("b"));
    await sleep(300);
    const first = ran[0]!;
    expect(new Set(ran)).toEqual(new Set([first]));
    const holder = first === "a" ? a : b;
    await stopOne(opened.splice(opened.indexOf(holder), 1)[0]!);
    const other = first === "a" ? "b" : "a";
    await waitFor(() => ran.includes(other), 3_000);
    expect(maxConcurrent).toBe(1);
    await stopOne(opened.pop()!);
  });
});

describe("queue (CP-JOBS-03, CP-JOBS-04)", () => {
  it("runs each committed job once across replicas; a rolled-back enqueue does not exist; a unique key enqueues once", async () => {
    const done: string[] = [];
    const mod: JobsModule = { workers: [{ kind: "mail", concurrency: 4, timeoutMs: 1_000, run: async (j) => void done.push((j.args as { to: string }).to) }] };
    const a = replica(mod, { start: false });
    await a.store.tx(async (tx) => {
      for (let i = 0; i < 10; i++) await tx.enqueue("mail", { to: `u${i}` });
      await tx.enqueue("mail", { to: "uniq" }, { uniqueKey: "k1" });
      await tx.enqueue("mail", { to: "uniq" }, { uniqueKey: "k1" });
    });
    await a.store.tx(async (tx) => {
      await tx.enqueue("mail", { to: "ghost" });
      throw new Error("rollback");
    }).catch(() => undefined);
    a.rt.start(a.sup);
    replica(mod);
    await waitFor(() => done.length >= 11);
    await sleep(200);
    expect(done.sort()).toEqual([...Array.from({ length: 10 }, (_, i) => `u${i}`), "uniq"].sort());
    await stopOne(opened.pop()!);
    await stopOne(opened.pop()!);
  });
  it("retries with backoff, then dead-letters and calls onDead in a transaction", async () => {
    let flaky = 0;
    const mod: JobsModule = {
      workers: [
        { kind: "flaky", maxAttempts: 5, backoffMs: [30, 30], timeoutMs: 1_000, run: async () => { if (++flaky < 3) throw new Error("not yet"); } },
        { kind: "doomed", maxAttempts: 2, backoffMs: [30], timeoutMs: 1_000, run: async () => { throw new Error("never"); },
          onDead: async (tx, j) => void (await tx.query("INSERT INTO side (id, note) VALUES ($1, $2)", [j.id, "dead"])) },
      ],
    };
    const r = replica(mod);
    await r.store.tx(async (tx) => {
      await tx.enqueue("flaky", {});
      await tx.enqueue("doomed", {});
    });
    await waitFor(async () => (await db.su(`SELECT count(*)::int AS n FROM "${db.schema}".side WHERE note = 'dead'`)).rows[0].n === 1);
    await waitFor(async () => (await db.su(`SELECT count(*)::int AS n FROM "${db.schema}".besdk_job_queue WHERE kind = 'flaky' AND state = 'done'`)).rows[0].n === 1);
    expect(flaky).toBe(3);
    const { rows } = await db.su(`SELECT kind, state, attempts, last_error FROM "${db.schema}".besdk_job_queue WHERE kind IN ('flaky', 'doomed') ORDER BY kind`);
    expect(rows.map((x) => [x.kind, x.state, x.attempts])).toEqual([["doomed", "dead", 2], ["flaky", "done", 3]]);
    expect(rows[0].last_error).toContain("never");
    await stopOne(opened.pop()!);
  });
});

describe("reconciler (P14 five kinds)", () => {
  it("handles outside a transaction, applies in one, backs off and gives up past the maximum", async () => {
    await db.asOwner(`INSERT INTO items (id, state) VALUES ('good', 'pending'), ('bad', 'pending')`);
    let handled = 0;
    const r = replica({ reconcilers: [{
      name: "items", everyMs: 50, batch: 10, timeoutMs: 1_000, maxAttempts: 2, backoffMs: [20],
      candidates: (tx, limit) => tx.query<{ id: string }>("SELECT id FROM items WHERE state = 'pending' AND due <= now() ORDER BY id LIMIT $1", [limit]),
      id: (x) => x.id,
      handle: async (x) => {
        handled++;
        if (x.id === "bad") throw new Error("remote refused");
        return "confirmed";
      },
      apply: async (tx, x, out) => void (await tx.query("UPDATE items SET state = $2 WHERE id = $1", [x.id, out])),
      giveUp: async (tx, x) => void (await tx.query("UPDATE items SET state = 'suspended' WHERE id = $1", [x.id])),
    }] });
    await waitFor(async () => (await db.su(`SELECT count(*)::int AS n FROM "${db.schema}".items WHERE state IN ('confirmed', 'suspended')`)).rows[0].n === 2);
    const states = (await db.su(`SELECT id, state FROM "${db.schema}".items ORDER BY id`)).rows.map((x) => [x.id, x.state]);
    expect(states).toEqual([["bad", "suspended"], ["good", "confirmed"]]);
    await sleep(100);
    expect((await db.su(`SELECT count(*)::int AS n FROM "${db.schema}".besdk_reconcile`)).rows[0].n).toBe(0);
    expect((await r.metrics.be.reconcileGiveups.get()).values[0]?.value).toBe(1);
    expect(handled).toBe(3);
    await stopOne(opened.pop()!);
  });
});

describe("job run once (P14.8, CP-JOBS-06)", () => {
  it("cron: claims the most recent slot once; a second trigger is a no-op", async () => {
    let n = 0;
    const r = replica({ jobs: [{ name: "daily", kind: "cron", cron: "0 3 * * *", timeoutMs: 1_000, run: async () => void n++ }] }, { start: false });
    expect(await r.rt.runOnce("daily")).toMatchObject({ result: "ok" });
    expect(await r.rt.runOnce("daily")).toMatchObject({ result: "noop" });
    expect(n).toBe(1);
  });
  it("singleton: a no-op while another holder has the lease", async () => {
    const mod: JobsModule = { jobs: [{ name: "s2", kind: "singleton", intervalMs: 10_000, timeoutMs: 1_000, run: async () => { await sleep(10); } }] };
    const holder = replica(mod);
    await waitFor(async () => (await db.su(`SELECT count(*)::int AS n FROM "${db.schema}".besdk_job_lease WHERE name = 's2' AND expires_at > now()`)).rows[0].n === 1);
    const once = replica(mod, { start: false });
    expect(await once.rt.runOnce("s2")).toMatchObject({ result: "noop" });
    await stopOne(opened.splice(opened.indexOf(holder), 1)[0]!);
  });
  it("queue: drains the ready rows of the kind; a failure is reported", async () => {
    const got: number[] = [];
    const r = replica({ workers: [{ kind: "drain", timeoutMs: 1_000, run: async (j) => void got.push((j.args as { i: number }).i) }] }, { start: false });
    await r.store.tx(async (tx) => {
      for (let i = 0; i < 3; i++) await tx.enqueue("drain", { i });
    });
    expect(await r.rt.runOnce("drain")).toMatchObject({ result: "ok" });
    expect(got.sort()).toEqual([0, 1, 2]);
    const bad = replica({ jobs: [{ name: "boom", kind: "every", intervalMs: 1_000, timeoutMs: 1_000, run: async () => { throw new Error("x"); } }] }, { start: false });
    expect(await bad.rt.runOnce("boom")).toMatchObject({ result: "failed" });
    expect(await bad.rt.runOnce("nope")).toMatchObject({ result: "unknown" });
  });
});

describe("JOBS_OVERRIDES (P14.5)", () => {
  it("enabled: false stops the in-process schedule only; job run still runs it", async () => {
    let n = 0;
    const r = replica({ jobs: [{ name: "off", kind: "every", intervalMs: 20, timeoutMs: 1_000, run: async () => void n++ }] }, { overrides: { off: { enabled: false } } });
    await sleep(200);
    expect(n).toBe(0);
    expect(await r.rt.runOnce("off")).toMatchObject({ result: "ok" });
    expect(n).toBe(1);
  });
  it("an invalid schedule is a configuration error; an unknown job name is a WARN", () => {
    const mod: JobsModule = { jobs: [{ name: "c", kind: "cron", cron: "0 3 * * *", timeoutMs: 1_000, run: async () => {} }] };
    expect(() => replica(mod, { overrides: { c: { cron: "@daily" } }, start: false })).toThrow(/schedule/);
    replica(mod, { overrides: { ghost: { enabled: false } }, start: false });
    expect(log.lines.some((l) => l.level === "warn" && l.job === "ghost")).toBe(true);
  });
});

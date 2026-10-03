// The migration step against real PostgreSQL 16 and 14 (P11.1, P11.3, P16.6, r1-06).
import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../../src/migrate/index.js";
import { newMemberRegistry } from "../../../src/obs/metrics.js";
import { migrationVersions, Store } from "../../../src/store/index.js";
import { captureLogger } from "../../support/capture.js";
import { createTestDb, DB_MIGRATIONS, requirePg, type TestDb } from "../../support/pg.js";

const MEMBER = "sdktest/db";

describe.each([
  ["PG16", "BE_TEST_PG16"],
  ["PG14", "BE_TEST_PG14"],
] as const)("migrations on %s", (_label, envName) => {
  const dsn = requirePg(envName);
  const dbs: TestDb[] = [];
  let db: TestDb;
  const fresh = async () => {
    const d = await createTestDb(dsn);
    dbs.push(d);
    return d;
  };
  const migrate = (d: TestDb, over: Partial<Parameters<typeof runMigrations>[0]> = {}) => {
    const cap = captureLogger(MEMBER, "debug");
    return { cap, run: runMigrations({ memberId: MEMBER, config: d.config(), logger: cap.logger, migrationsDir: DB_MIGRATIONS, direction: "up", ...over }) };
  };
  const tables = async (d: TestDb) =>
    (await d.su(`SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY 1`, [d.schema])).rows.map((r) => r.tablename as string);

  beforeAll(async () => {
    db = await fresh();
  });
  afterAll(async () => {
    for (const d of dbs) await d.cleanup();
  });

  it("applies component and platform migrations, skipping lifecycle.yaml", async () => {
    const r = await migrate(db).run;
    expect(r.status).toBe("ok");
    expect(r.ran).toEqual(["0001_create-widgets", "0002_add-note"]);
    expect(r.platformRan).toEqual(["0001_besdk-platform"]);
    const t = await tables(db);
    expect(t).toContain("widgets");
    expect(t).toContain(`pgmigrations_${db.schema}`);
    expect(t).toContain(`besdk_migrations_${db.schema}`);
    for (const b of ["besdk_platform_version", "besdk_outbox", "besdk_event_cursor", "besdk_idempotency", "besdk_job_queue",
      "besdk_snapshot_sync", "besdk_number_series", "besdk_number_allocations", "besdk_lifecycle_units", "besdk_lifecycle_log"]) {
      expect(t).toContain(b);
    }
    expect(t).not.toContain("besdk_authz_acl");
    const pub = await db.su(`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'`);
    expect(pub.rows[0].n).toBe(0);
    const v = await db.su(`SELECT component, version FROM ${db.schema}.besdk_platform_version`);
    expect(v.rows).toEqual([{ component: MEMBER, version: 1 }]);
  });

  it("everything it created is owned by the owner role", async () => {
    const r = await db.su(`SELECT c.relname, pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'S', 'i')`, [db.schema]);
    expect(r.rows.filter((x) => x.owner !== db.owner)).toEqual([]);
    const f = await db.su(`SELECT p.proname, pg_get_userbyid(p.proowner) AS owner FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1`, [db.schema]);
    expect(f.rows.length).toBeGreaterThanOrEqual(7);
    expect(f.rows.filter((x) => x.owner !== db.owner)).toEqual([]);
  });

  it("creates the outbox window: the runtime role can write an outbox row right after migrating (P16.6)", async () => {
    const parts = await db.su(`SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
      WHERE i.inhparent = $1::regclass ORDER BY 1`, [`${db.schema}.besdk_outbox`]);
    expect(parts.rows).toHaveLength(3);
    const store = new Store({ memberId: MEMBER, config: db.config(), logger: captureLogger(MEMBER).logger, metrics: newMemberRegistry(MEMBER) });
    try {
      await store.tx((tx) => tx.query(`INSERT INTO besdk_outbox (id, created_at, subject, aggregate_type, aggregate_id, aggregate_version, occurred_at, payload)
        VALUES (gen_random_uuid(), now(), 'sdktest.db.widget.created.v1', 'widget', 'w1', 1, now(), '{}')`));
      const n = await store.tx((tx) => tx.query(`SELECT count(*)::int AS n FROM besdk_outbox`));
      expect(n[0]!.n).toBe(1);
      const v = await migrationVersions(store);
      expect(v).toEqual({ component: "0002_add-note", applied: ["0001_create-widgets", "0002_add-note"], platform: 1 });
    } finally {
      await store.close();
    }
  });

  it("a second run is a no-op and creates no partition twice", async () => {
    const r = await migrate(db).run;
    expect([r.status, r.ran, r.platformRan, r.partitionsCreated]).toEqual(["ok", [], [], []]);
  });

  it("an existing partition that covers the window by another name is respected (by boundary, not by name)", async () => {
    const d = await fresh();
    await migrate(d).run;
    const parts = await d.su(`SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid WHERE i.inhparent = $1::regclass`, [`${d.schema}.besdk_outbox`]);
    await d.asOwner(parts.rows.map((p) => `DROP TABLE ${p.relname}`).join("; ") +
      `; CREATE TABLE besdk_outbox_legacy PARTITION OF besdk_outbox FOR VALUES FROM ('2000-01-01') TO ('2100-01-01')`);
    const r = await migrate(d).run;
    expect(r.partitionsCreated).toEqual([]);
  });

  it("status lists applied and pending; down 1 reverts only the newest component migration", async () => {
    const d = await fresh();
    await migrate(d, { count: 1 }).run;
    const s = await migrate(d, { direction: "status" }).run;
    expect([s.applied, s.pending]).toEqual([["0001_create-widgets"], ["0002_add-note"]]);
    await migrate(d).run;
    const down = await migrate(d, { direction: "down", count: 1 }).run;
    expect(down.ran).toEqual(["0002_add-note"]);
    const cols = await d.su(`SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'widgets'`, [d.schema]);
    expect(cols.rows.map((c) => c.column_name)).not.toContain("note");
    expect(await tables(d)).toContain("besdk_outbox");
  });

  it("a schema newer than the image is reported as ahead, not migrated (P1.8)", async () => {
    const d = await fresh();
    const dir = mkdtempSync(join(tmpdir(), "besdk-mig-"));
    cpSync(DB_MIGRATIONS, dir, { recursive: true });
    writeFileSync(join(dir, "0003_newer.sql"), "-- Up Migration\nCREATE TABLE newer (id int);\n-- Down Migration\nDROP TABLE newer;\n");
    await migrate(d, { migrationsDir: dir }).run;
    const { cap, run } = migrate(d);
    const r = await run;
    expect(r.status).toBe("ahead");
    expect(r.unknown).toEqual(["0003_newer"]);
    expect(cap.lines.some((l) => l.level === "warn")).toBe(true);
  });

  it("two schemas migrate concurrently (per-schema lock)", async () => {
    const [a, b] = [await fresh(), await fresh()];
    const [ra, rb] = await Promise.all([migrate(a).run, migrate(b).run]);
    expect(ra.ran).toHaveLength(2);
    expect(rb.ran).toHaveLength(2);
  });

  it("two migrations of the same schema serialise and both succeed", async () => {
    const d = await fresh();
    const [r1, r2] = await Promise.all([migrate(d).run, migrate(d).run]);
    expect([...r1.ran, ...r2.ran].sort()).toEqual(["0001_create-widgets", "0002_add-note"]);
  });

  it("a lock held on a table makes the step retry and finally fail, naming the blocker", async () => {
    const d = await fresh();
    await migrate(d, { count: 1 }).run;
    // the owner can read its own sessions' SQL in pg_stat_activity (others show only pid and role)
    const holder = await d.session("owner");
    const pid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;
    await holder.query(`BEGIN; LOCK TABLE ${d.schema}.widgets IN ACCESS EXCLUSIVE MODE; SELECT 'blocker-marker'`);
    const { cap, run } = migrate(d, { lockRetryBaseMs: 50 });
    await expect(run).rejects.toMatchObject({ code: "55P03" });
    await holder.query("ROLLBACK");
    const err = cap.lines.find((l) => l.level === "error" && Array.isArray(l.blocking));
    expect(err).toBeDefined();
    expect(err.blocking).toEqual([expect.objectContaining({ pid, user: d.owner })]);
    expect(JSON.stringify(err.blocking)).toContain("blocker-marker");
    expect(cap.lines.filter((l) => l.level === "warn" && /lock timeout/i.test(l.msg))).toHaveLength(3);
  }, 60_000);
});

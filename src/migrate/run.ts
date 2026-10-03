// The migrate entry point (P11.1, P11.3): the component's migrations with node-pg-migrate, then, in the same
// step, on the same owner connection and under the same per-schema lock, the platform migration (besdk_*
// tables and functions, besdk_platform_version, the outbox's partition window, then the `afterPlatform` hook
// the events module uses for streams and durables).
//
// A component's migrations directory holds only `*.sql` files and lifecycle.yaml (P11.11). File names start
// with a number, ordered numerically (`0001_create-orders.sql`, or node-pg-migrate's 13/17-digit timestamps);
// each file has a `-- Up Migration` section and optionally a `-- Down Migration` section (without markers the
// whole file is "up" and cannot be reverted); each runs in its own transaction unless its first line is
// `-- be:no-transaction`. lifecycle.yaml and every other non-.sql file are skipped.
import { basename, extname } from "node:path";
import type pg from "pg";
// the per-module entry points (dist/legacy): one consistent set of runtime code and typings
import { runner, type RunnerOption } from "node-pg-migrate/runner";
import { getMigrationFilePaths } from "node-pg-migrate/migration";
import type { Config } from "../config/config.js";
import type { Logger } from "../log/logger.js";
import { platformMigrationsPath } from "../protocolFiles.js";
import { sqlStateOf } from "../store/errors.js";
import { quoteIdent } from "../store/sql.js";
import { sleep } from "../util/sleep.js";
import { componentStateTable, migrationLockValue, platformStateTable } from "./lockKey.js";
import { lockHolders, openMigrationSession, takeMigrationLock } from "./session.js";
import { SQL_ONLY_IGNORE, sqlLoaderStrategies } from "./sqlLoader.js";
import { ensureLifecycleWindows, ensureOutboxWindow } from "./window.js";

/** The platform migration version this SDK release applies (besdk_platform_version.version). */
export const PLATFORM_VERSION = 1;
const LOCK_RETRIES = 3;

export interface MigrateOptions {
  memberId: string;
  config: Config;
  logger: Logger;
  migrationsDir: string;
  direction: "up" | "down" | "status";
  /** up: at most this many; down: this many (default 1) */
  count?: number;
  /** runs after the platform migration, on the owner connection (event streams and durables, P12.4) */
  afterPlatform?: (client: pg.Client) => Promise<void>;
  now?: () => Date;
  /** first back-off after a lock timeout (default 1 s, doubling) */
  lockRetryBaseMs?: number;
}

export interface MigrateResult {
  /** "ahead": the schema has migrations this image does not know; nothing ran (the entry point exits 0, P1.8) */
  status: "ok" | "ahead";
  /** component migrations applied (up) or reverted (down) by this step */
  ran: string[];
  platformRan: string[];
  /** applied component migrations after the step, oldest first */
  applied: string[];
  pending: string[];
  /** applied, but absent from this image's migrations directory */
  unknown: string[];
  partitionsCreated: string[];
}

export async function runMigrations(o: MigrateOptions): Promise<MigrateResult> {
  const schema = o.config.require("PG_SCHEMA");
  const log = o.logger.child({ step: "migrate" });
  const client = await openMigrationSession(o);
  try {
    if (o.direction !== "status") await takeMigrationLock(client, migrationLockValue(schema), log);
    const files = await migrationNames(o.migrationsDir, log);
    const before = await appliedNames(client, schema, componentStateTable(schema));
    const unknown = before.filter((n) => !files.includes(n));
    const platform = await platformVersion(client, schema, o.memberId);
    const ahead = unknown.length > 0 || (platform ?? 0) > PLATFORM_VERSION;
    const result = (applied: string[], extra: Partial<MigrateResult> = {}): MigrateResult => ({
      status: ahead ? "ahead" : "ok", ran: [], platformRan: [], applied, partitionsCreated: [], unknown,
      pending: files.filter((n) => !applied.includes(n)), ...extra,
    });

    if (o.direction === "status") {
      const r = result(before);
      log.info({ applied: r.applied, pending: r.pending, unknown: r.unknown, platform: platform ?? null }, "migration status");
      return r;
    }
    if (ahead && o.direction === "up") {
      log.warn({ unknown, platform: platform ?? null, image_platform: PLATFORM_VERSION },
        "the schema is newer than this image; not migrating (an older image is being rolled back to)");
      return result(before);
    }
    const ran = await withLockRetry(client, schema, log, o.lockRetryBaseMs, () =>
      runTool(client, o, { dir: o.migrationsDir, table: componentStateTable(schema), direction: o.direction as "up" | "down" }));
    if (o.direction === "down") return result(await appliedNames(client, schema, componentStateTable(schema)), { ran });

    const platformRan = await withLockRetry(client, schema, log, o.lockRetryBaseMs, () =>
      runTool(client, { ...o, count: undefined }, { dir: platformMigrationsPath(), table: platformStateTable(schema), direction: "up" }));
    const partitionsCreated = await withLockRetry(client, schema, log, o.lockRetryBaseMs, () => platformState(client, schema, o));
    if (o.afterPlatform) await o.afterPlatform(client);
    const applied = await appliedNames(client, schema, componentStateTable(schema));
    log.info({ ran, platform_ran: platformRan, partitions_created: partitionsCreated }, "migrations applied");
    return result(applied, { ran, platformRan, partitionsCreated });
  } finally {
    // ending the session releases the session-level advisory locks
    await client.end().catch(() => undefined);
  }
}

function runTool(client: pg.Client, o: MigrateOptions, t: { dir: string; table: string; direction: "up" | "down" }): Promise<string[]> {
  const schema = o.config.require("PG_SCHEMA");
  const opts: RunnerOption = {
    dbClient: client,
    dir: t.dir,
    direction: t.direction,
    count: t.direction === "down" ? (o.count ?? 1) : o.count,
    schema,
    migrationsSchema: schema,
    migrationsTable: t.table,
    createSchema: false,
    createMigrationsSchema: false,
    ignorePattern: SQL_ONLY_IGNORE,
    checkOrder: true,
    // the step already holds this lock (takeMigrationLock); the tool's own lock re-enters it
    lockValue: migrationLockValue(schema),
    advisoryLockMode: "wait",
    singleTransaction: false,
    migrationLoaderStrategies: sqlLoaderStrategies,
    logger: toolLogger(o.logger),
  };
  return runner(opts).then((ms) => ms.map((m) => m.name));
}

/** besdk_platform_version and the outbox window, in one owner transaction. */
async function platformState(client: pg.Client, schema: string, o: MigrateOptions): Promise<string[]> {
  await client.query("BEGIN");
  try {
    await client.query(`SET LOCAL search_path TO ${quoteIdent(schema)}`);
    await client.query(
      `INSERT INTO besdk_platform_version (component, version) VALUES ($1, $2)
       ON CONFLICT (component) DO UPDATE SET version = EXCLUDED.version, applied_at = now()
       WHERE besdk_platform_version.version <> EXCLUDED.version`,
      [o.memberId, PLATFORM_VERSION],
    );
    const query = (sql: string, params?: unknown[]) => client.query(sql, params).then((r) => r.rows);
    const now = o.now?.() ?? new Date();
    const created = await ensureOutboxWindow(query, now);
    created.push(...(await ensureLifecycleWindows(query, o.migrationsDir, now))); // P16.6: declared tables too
    await client.query("COMMIT");
    return created;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  }
}

/** P11.1: a lock timeout is retried with back-off up to 3 times; the last failure names the lock holders. */
async function withLockRetry<T>(client: pg.Client, schema: string, log: Logger, baseMs = 1_000, step: () => Promise<T>): Promise<T> {
  for (let retry = 0; ; retry++) {
    try {
      return await step();
    } catch (e) {
      if (sqlStateOf(e) !== "55P03") throw e;
      // the tool leaves its transaction open on failure
      await client.query("ROLLBACK").catch(() => undefined);
      if (retry >= LOCK_RETRIES) {
        const blocking = await lockHolders(client, schema).catch(() => []);
        log.error({ blocking, error: (e as Error).message }, "migration failed: lock timeout after retries");
        throw e;
      }
      const wait = baseMs * 2 ** retry;
      log.warn({ retry: retry + 1, wait_ms: wait }, "migration hit a lock timeout; retrying");
      await sleep(wait);
    }
  }
}

async function migrationNames(dir: string, log: Logger): Promise<string[]> {
  const paths = await getMigrationFilePaths(dir, { ignorePattern: SQL_ONLY_IGNORE, logger: toolLogger(log) });
  return paths.map((p) => basename(p, extname(p)));
}

async function appliedNames(client: pg.Client, schema: string, table: string): Promise<string[]> {
  const exists = await client.query<{ ok: boolean }>(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`${quoteIdent(schema)}.${quoteIdent(table)}`]);
  if (!exists.rows[0]?.ok) return [];
  const r = await client.query<{ name: string }>(`SELECT name FROM ${quoteIdent(schema)}.${quoteIdent(table)} ORDER BY run_on, id`);
  return r.rows.map((x) => x.name);
}

async function platformVersion(client: pg.Client, schema: string, memberId: string): Promise<number | undefined> {
  const t = `${quoteIdent(schema)}.besdk_platform_version`;
  const exists = await client.query<{ ok: boolean }>(`SELECT to_regclass($1) IS NOT NULL AS ok`, [t]);
  if (!exists.rows[0]?.ok) return undefined;
  const r = await client.query<{ version: number }>(`SELECT version FROM ${t} WHERE component = $1`, [memberId]);
  return r.rows[0]?.version;
}

function toolLogger(log: Logger) {
  const l = log.child({ tool: "node-pg-migrate" });
  return {
    debug: (m: string) => l.debug(m),
    info: (m: string) => l.info(m),
    warn: (m: string) => l.warn(m),
    error: (m: string) => l.error(m),
  };
}

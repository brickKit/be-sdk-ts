// The migration connection (P11.1): a dedicated, unpooled session logged in as the owner PG_OWNER_USER, directly
// to PG_MIGRATION_HOST / PG_MIGRATION_PORT (falling back to PG_HOST / PG_PORT). It is the one connection
// where session-level settings and a session-level advisory lock are allowed; it is closed after the step.
import pg from "pg";
import type { Config } from "../config/config.js";
import type { Logger } from "../log/logger.js";
import { optional } from "../store/pool.js";
import { sleep } from "../util/sleep.js";

export const MIGRATION_SESSION_OPTIONS = "-c lock_timeout=5s -c statement_timeout=15min -c TimeZone=UTC";

export async function openMigrationSession(o: { memberId: string; config: Config; logger: Logger }): Promise<pg.Client> {
  const c = o.config;
  const owner = c.secret("PG_OWNER_PASSWORD_FILE");
  const client = new pg.Client({
    host: optional(() => c.string("PG_MIGRATION_HOST"), undefined) ?? c.require("PG_HOST"),
    port: optional(() => (c.has("PG_MIGRATION_PORT") ? c.int("PG_MIGRATION_PORT") : undefined), undefined) ??
      optional(() => c.int("PG_PORT", 5432), 5432),
    database: c.require("PG_DATABASE"),
    user: c.require("PG_OWNER_USER"),
    password: () => owner.current(),
    application_name: `${o.memberId}/migrate`,
    options: MIGRATION_SESSION_OPTIONS,
    connectionTimeoutMillis: 30_000,
  });
  // a dropped connection is reported through the failing query; the event alone must not crash the process
  client.on("error", (err) => o.logger.warn({ error: err.message }, "the migration connection failed"));
  await client.connect();
  return client;
}

/**
 * Takes the per-schema migration lock, polling until it is held (the tool's own wait would end after the
 * session's lock_timeout of 5 s while another replica migrates the same schema).
 */
export async function takeMigrationLock(client: pg.Client, lockValue: number, logger: Logger, maxWaitMs = 15 * 60_000): Promise<void> {
  const until = Date.now() + maxWaitMs;
  for (let n = 0; ; n++) {
    const r = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1::bigint) AS ok", [lockValue]);
    if (r.rows[0]?.ok) return;
    if (n === 0) logger.info({ lock: lockValue }, "another migration of this schema is running; waiting for its lock");
    if (Date.now() > until) throw new Error(`the migration lock ${lockValue} was not free within ${maxWaitMs} ms`);
    await sleep(Math.min(250 * 2 ** n, 2_000));
  }
}

export interface LockHolder {
  pid: number;
  user: string;
  application: string;
  /** first 200 characters; another role's SQL reads "<insufficient privilege>" unless the owner may read all stats */
  query: string;
}

/** Backends holding locks on relations of the schema: pid, role, application and the start of their SQL. */
export async function lockHolders(client: pg.Client, schema: string): Promise<LockHolder[]> {
  const r = await client.query<LockHolder>(
    `SELECT DISTINCT a.pid, a.usename AS user, a.application_name AS application, left(a.query, 200) AS query
       FROM pg_locks l
       JOIN pg_class c ON c.oid = l.relation
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE n.nspname = $1 AND l.granted AND a.pid <> pg_backend_pid()
      ORDER BY a.pid`,
    [schema],
  );
  return r.rows;
}

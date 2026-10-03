// The standalone connection pool (P10.5) and the pool-related settings every Store reads. The password is a
// function, so pg asks for it on every new connection and a rotated PG_PASSWORD_FILE applies to new
// connections (P2.9). TimeZone is a startup parameter, never a SET (P10.3).
import pg from "pg";
import type { Config } from "../config/config.js";
import { ConfigError } from "../config/configError.js";
import type { Logger } from "../log/logger.js";

export interface PoolSettings {
  max: number;
  acquireTimeoutMs: number;
  maxLifetimeMs: number;
  maxIdleMs: number;
}

/** An optional key the component did not declare reads as its catalogue default. */
export function optional<T>(read: () => T, def: T): T {
  try {
    return read();
  } catch (e) {
    if (e instanceof ConfigError && e.reason === "CONFIG_UNDECLARED") return def;
    throw e;
  }
}

export function poolSettings(c: Config): PoolSettings {
  return {
    max: optional(() => c.int("PG_POOL_MAX", 10), 10),
    acquireTimeoutMs: optional(() => c.duration("PG_POOL_ACQUIRE_TIMEOUT", 5_000), 5_000),
    maxLifetimeMs: optional(() => c.duration("PG_CONN_MAX_LIFETIME", 30 * 60_000), 30 * 60_000),
    maxIdleMs: optional(() => c.duration("PG_CONN_MAX_IDLE_TIME", 5 * 60_000), 5 * 60_000),
  };
}

const BACKSTOP_MS = 5_000;

/**
 * The member's own pool. Its sessions are named `<component ID>@<version>` (P10.2), and it never closes its last
 * idle connection (`min: 1`), so a contract migration sees the running version while it serves (P10.5, P11.4).
 * Further idle connections close after PG_CONN_MAX_IDLE_TIME.
 */
export function createStandalonePool(o: { config: Config; memberId: string; version: string; logger: Logger; settings: PoolSettings }): pg.Pool {
  const c = o.config;
  const secret = c.secret("PG_PASSWORD_FILE");
  const s = o.settings;
  const pool = new pg.Pool({
    host: c.require("PG_HOST"),
    port: optional(() => c.int("PG_PORT", 5432), 5432),
    database: c.require("PG_DATABASE"),
    user: c.require("PG_USER"),
    password: () => secret.current(),
    application_name: `${o.memberId}@${o.version}`,
    options: "-c TimeZone=UTC",
    max: s.max,
    min: 1,
    idleTimeoutMillis: s.maxIdleMs,
    maxLifetimeSeconds: Math.max(1, Math.ceil(s.maxLifetimeMs / 1000)),
    // the per-member semaphore bounds the wait; this only stops a hung connect
    connectionTimeoutMillis: s.acquireTimeoutMs + BACKSTOP_MS,
  });
  // an idle connection dropped by the server must not crash the process
  pool.on("error", (err) => o.logger.warn({ error: err.message }, "an idle database connection failed and was removed"));
  return pool;
}

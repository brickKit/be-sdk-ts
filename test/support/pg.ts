// A throwaway database identity for integration tests, created on a superuser DSN (BE_TEST_PG16 / BE_TEST_PG14
// from `make test-integration`): a random schema, an owner role that owns it, a runtime role with USAGE and DML
// through default privileges (not a member of the owner), password files, and a Config built from
// test/fixtures/db/component.yaml. cleanup() drops all of it.
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { Config } from "../../src/config/config.js";
import { readManifest } from "../../src/config/manifest.js";

export const DB_FIXTURE = new URL("../fixtures/db/", import.meta.url).pathname;
export const DB_MIGRATIONS = join(DB_FIXTURE, "migrations");
const manifest = readManifest(join(DB_FIXTURE, "component.yaml"));

/** The superuser DSN of a test server; a missing variable fails the test run (never skips it). */
export function requirePg(name: "BE_TEST_PG16" | "BE_TEST_PG14"): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set: run \`make test-integration\` (or export a superuser DSN)`);
  return v;
}

const q = (s: string) => `"${s.replaceAll('"', '""')}"`;

export interface TestDb {
  superDsn: string;
  schema: string;
  owner: string;
  runtime: string;
  env: Record<string, string>;
  config(over?: Record<string, string | undefined>): Config;
  /** runs SQL as the superuser */
  su(sql: string, params?: unknown[]): Promise<pg.QueryResult>;
  /** runs SQL as the owner role with search_path = schema, in one transaction (test setup DDL) */
  asOwner(sql: string): Promise<void>;
  /** a dedicated session (for holding locks), as the superuser by default; ended by cleanup() */
  session(as?: "super" | "owner" | "runtime"): Promise<pg.Client>;
  rotateRuntimePassword(): Promise<string>;
  cleanup(): Promise<void>;
}

export async function createTestDb(superDsn: string): Promise<TestDb> {
  const id = randomBytes(5).toString("hex");
  const schema = `s_${id}`;
  const owner = `o_${id}`;
  const runtime = `r_${id}`;
  const dir = mkdtempSync(join(tmpdir(), "besdk-pg-"));
  const ownerPw = randomBytes(12).toString("hex");
  let runtimePw = randomBytes(12).toString("hex");
  const ownerFile = join(dir, "owner-password");
  const runtimeFile = join(dir, "runtime-password");
  writeFileSync(ownerFile, `${ownerPw}\n`);
  writeFileSync(runtimeFile, `${runtimePw}\n`);

  const admin = new pg.Client({ connectionString: superDsn });
  await admin.connect();
  const sessions: pg.Client[] = [];
  await admin.query(`
    CREATE ROLE ${q(owner)} LOGIN PASSWORD '${ownerPw}';
    CREATE ROLE ${q(runtime)} LOGIN PASSWORD '${runtimePw}';
    CREATE SCHEMA ${q(schema)} AUTHORIZATION ${q(owner)};
    GRANT USAGE ON SCHEMA ${q(schema)} TO ${q(runtime)};
    ALTER DEFAULT PRIVILEGES FOR ROLE ${q(owner)} IN SCHEMA ${q(schema)} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${q(runtime)};
    ALTER DEFAULT PRIVILEGES FOR ROLE ${q(owner)} IN SCHEMA ${q(schema)} GRANT USAGE, SELECT ON SEQUENCES TO ${q(runtime)};`);

  const url = new URL(superDsn);
  const env: Record<string, string> = {
    PG_HOST: url.hostname,
    PG_PORT: url.port || "5432",
    PG_DATABASE: url.pathname.slice(1) || "postgres",
    PG_USER: runtime,
    PG_PASSWORD_FILE: runtimeFile,
    PG_OWNER_USER: owner,
    PG_OWNER_PASSWORD_FILE: ownerFile,
    PG_SCHEMA: schema,
  };

  return {
    superDsn,
    schema,
    owner,
    runtime,
    env,
    config: (over = {}) => Config.load(manifest, { ...env, ...over }),
    su: (sql, params) => admin.query(sql, params as unknown[]),
    asOwner: async (sql) => {
      await admin.query(`BEGIN; SET LOCAL ROLE ${q(owner)}; SET LOCAL search_path TO ${q(schema)}; ${sql}; COMMIT;`).catch(async (e) => {
        await admin.query("ROLLBACK");
        throw e;
      });
    },
    session: async (as = "super") => {
      // pg lets the connection string win over explicit fields, so the login goes into the URL
      const u = new URL(superDsn);
      if (as !== "super") [u.username, u.password] = as === "owner" ? [owner, ownerPw] : [runtime, runtimePw];
      const c = new pg.Client({ connectionString: u.toString() });
      await c.connect();
      sessions.push(c);
      return c;
    },
    rotateRuntimePassword: async () => {
      runtimePw = randomBytes(12).toString("hex");
      await admin.query(`ALTER ROLE ${q(runtime)} PASSWORD '${runtimePw}'`);
      writeFileSync(runtimeFile, `${runtimePw}\n`);
      const future = new Date(Date.now() + 5_000);
      utimesSync(runtimeFile, future, future);
      return runtimePw;
    },
    cleanup: async () => {
      for (const s of sessions) await s.end().catch(() => {});
      await admin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename IN ($1, $2) AND pid <> pg_backend_pid()`,
        [owner, runtime],
      );
      await admin.query(`
        DROP SCHEMA IF EXISTS ${q(schema)} CASCADE;
        DROP OWNED BY ${q(owner)}, ${q(runtime)};
        DROP ROLE IF EXISTS ${q(runtime)};
        DROP ROLE IF EXISTS ${q(owner)};`);
      await admin.end();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

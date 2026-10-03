// The start-up probe (P10.7) and the migration versions the runtime reports (/readyz "migrations", /_be/info).
// Both run as ordinary store transactions, so as PG_USER with the SET LOCAL block (P10.2).
import type { Store } from "./store.js";
import type { Tx } from "./tx.js";

export interface ProbeResult {
  /** false = fatal at start (P1.8): the server lacks a required capability */
  capabilitiesOk: boolean;
  versionNum: number;
  /** false = logged at ERROR, be_db_identity_ok 0, /readyz 503; the process keeps running */
  identityOk: boolean;
  problems: string[];
}

const MIN_STANDALONE = 140_000; // declarative partitioning with partitioned indexes, SKIP LOCKED: all ≥ 14
const MIN_SHELL = 160_000; // GRANT … WITH INHERIT FALSE, SET TRUE (P19.5)

const SCHEMA_SQL = `
SELECT n.oid IS NOT NULL AS exists,
       n.oid IS NOT NULL AND has_schema_privilege(current_user, n.oid, 'USAGE') AS usage,
       n.oid IS NOT NULL AND has_schema_privilege(current_user, n.oid, 'CREATE') AS create,
       r.oid IS NOT NULL AS owner_exists,
       r.oid IS NOT NULL AND pg_has_role(current_user, r.oid, 'MEMBER') AS owner_member,
       current_user AS usr
  FROM (SELECT $1::text AS s, $2::text AS o) x
  LEFT JOIN pg_namespace n ON n.nspname = x.s
  LEFT JOIN pg_roles r ON r.rolname = x.o`;

// ordinary and partitioned tables, partitions included: every one must be the owner's and fully writable
const TABLES_SQL = `
SELECT c.relname AS name, pg_get_userbyid(c.relowner) AS owner,
       has_table_privilege(current_user, c.oid, 'SELECT') AND has_table_privilege(current_user, c.oid, 'INSERT')
   AND has_table_privilege(current_user, c.oid, 'UPDATE') AND has_table_privilege(current_user, c.oid, 'DELETE') AS dml
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = $1 AND c.relkind IN ('r', 'p')
 ORDER BY c.relname`;

async function identityProblems(tx: Tx, schema: string, owner: string): Promise<string[]> {
  const p: string[] = [];
  const [s] = await tx.query(SCHEMA_SQL, [schema, owner]);
  if (!s!.exists) return [`schema ${schema} does not exist`];
  if (!s!.usage) p.push(`${s!.usr} lacks USAGE on schema ${schema}`);
  if (s!.create) p.push(`${s!.usr} holds CREATE on schema ${schema} (the runtime role must have DML only)`);
  if (!s!.owner_exists) p.push(`owner role ${owner} does not exist`);
  else if (s!.owner_member) p.push(`${s!.usr} is a member of the owner role ${owner}`);
  for (const t of await tx.query(TABLES_SQL, [schema])) {
    if (t.owner !== owner) p.push(`table ${t.name} is owned by ${t.owner}, not ${owner}`);
    if (!t.dml) p.push(`${s!.usr} lacks SELECT, INSERT, UPDATE or DELETE on table ${t.name}`);
  }
  return p;
}

/** Capabilities, then identity (P10.7). Logs identity problems at ERROR and sets be_db_identity_ok. */
export async function probeDatabase(
  store: Store,
  o: { ownerRole: string; shell: boolean; metrics?: { be: { dbIdentityOk: { set(v: number): void } } }; logger?: { error(o: object, m: string): void } },
): Promise<ProbeResult> {
  return store.tx(async (tx) => {
    const [v] = await tx.query<{ v: number }>(`SELECT current_setting('server_version_num')::int AS v`);
    const versionNum = v!.v;
    const min = o.shell ? MIN_SHELL : MIN_STANDALONE;
    const problems = versionNum < min ? [`PostgreSQL ${versionNum} is older than ${min}${o.shell ? " (a shell needs 16)" : ""}`] : [];
    const capabilitiesOk = problems.length === 0;
    const identity = await identityProblems(tx, store.identity.schema, o.ownerRole);
    problems.push(...identity);
    o.metrics?.be.dbIdentityOk.set(identity.length === 0 ? 1 : 0);
    if (identity.length > 0) o.logger?.error({ problems: identity }, "database identity check failed");
    return { capabilitiesOk, versionNum, identityOk: identity.length === 0, problems };
  }, { readOnly: true });
}

export interface MigrationVersions {
  /** the newest applied component migration (node-pg-migrate's order), or undefined */
  component: string | undefined;
  /** every applied component migration, oldest first */
  applied: string[];
  /** the platform migration version recorded for this member, or undefined */
  platform: number | undefined;
}

export async function migrationVersions(store: Store): Promise<MigrationVersions> {
  const schema = store.identity.schema;
  return store.tx(async (tx) => {
    const [t] = await tx.query(`SELECT to_regclass(quote_ident($1)) IS NOT NULL AS mig, to_regclass('besdk_platform_version') IS NOT NULL AS plat`, [`pgmigrations_${schema}`]);
    const applied = t!.mig
      ? (await tx.query<{ name: string }>(`SELECT name FROM "pgmigrations_${schema.replaceAll('"', '""')}" ORDER BY run_on, id`)).map((r) => r.name)
      : [];
    const plat = t!.plat ? await tx.query<{ version: number }>(`SELECT version FROM besdk_platform_version WHERE component = $1`, [store.memberId]) : [];
    return { component: applied.at(-1), applied, platform: plat[0]?.version };
  }, { readOnly: true });
}

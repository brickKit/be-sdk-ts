// Shared set-up of the lifecycle integration tests: a throwaway schema migrated with the conformance widget's
// tables and lifecycle.yaml (the platform migration's afterPlatform hook creates the component tables' window,
// as the runtime will), a Store as the runtime role, and an engine whose events are captured.
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { LifecycleEngine } from "../../../src/lifecycle/engine.js";
import { runMigrations } from "../../../src/migrate/index.js";
import { ensureLifecycleWindows } from "../../../src/migrate/window.js";
import { newMemberRegistry } from "../../../src/obs/metrics.js";
import { quoteIdent } from "../../../src/store/sql.js";
import { Store } from "../../../src/store/index.js";
import type { PoolLike } from "../../../src/store/types.js";
import { captureLogger } from "../../support/capture.js";
import { createTestDb, type TestDb } from "../../support/pg.js";

export const MEMBER = "sdktest/db";
export const WIDGET_MIGRATIONS = new URL("../../fixtures/lifecycle/widget/migrations/", import.meta.url).pathname;

export interface Emitted {
  subject: string;
  payload: Record<string, unknown>;
}

export async function windowHook(client: pg.Client, schema: string, now: Date): Promise<string[]> {
  await client.query("BEGIN");
  try {
    await client.query(`SET LOCAL search_path TO ${quoteIdent(schema)}`);
    const made = await ensureLifecycleWindows((sql, params) => client.query(sql, params).then((r) => r.rows), WIDGET_MIGRATIONS, now);
    await client.query("COMMIT");
    return made;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }
}

/** A migrated widget schema; `now` is the migration's day (default: today). */
export async function migratedDb(dsn: string, now = new Date()): Promise<{ db: TestDb; windows: string[] }> {
  const db = await createTestDb(dsn);
  let windows: string[] = [];
  await runMigrations({
    memberId: MEMBER, config: db.config(), logger: captureLogger(MEMBER).logger, migrationsDir: WIDGET_MIGRATIONS, direction: "up",
    afterPlatform: async (c) => {
      windows = await windowHook(c, db.schema, now);
    },
  });
  return { db, windows };
}

export function newStore(db: TestDb, pool?: PoolLike): Store {
  return new Store({ memberId: MEMBER, config: db.config(), logger: captureLogger(MEMBER).logger, metrics: newMemberRegistry(MEMBER), pool });
}

export function newEngine(store: Store, o: { now?: Date; dataLifecycle?: object } = {}) {
  const emitted: Emitted[] = [];
  const cap = captureLogger(MEMBER, "debug");
  const engine = LifecycleEngine.load({
    memberId: MEMBER, store, logger: cap.logger, migrationsDir: WIDGET_MIGRATIONS, dataLifecycle: o.dataLifecycle,
    now: o.now ? () => o.now! : undefined,
    emit: async (_tx, subject, payload) => {
      emitted.push({ subject, payload });
    },
  });
  return { engine, emitted, lines: cap.lines };
}

/** Creates a RANGE partition as the owner (a period the window no longer covers, for tests of older data). */
export async function ownerPartition(db: TestDb, table: string, from: string, to: string): Promise<string> {
  const name = `${table}_p${from.slice(0, 10).replaceAll("-", "")}`;
  await db.asOwner(`SELECT besdk_ensure_range_partition('${table}', '${name}', '${from}', '${to}')`);
  return name;
}

export async function insertWidget(db: TestDb, o: { createdAt: string; status: string; updatedAt?: string; id?: string }): Promise<string> {
  const id = o.id ?? randomUUID();
  await db.su(`INSERT INTO ${db.schema}.widgets (id, created_at, legal_entity_id, number, document_date, kind_code, name, region,
      owner_id, status, currency, price, quantity, amount, version, updated_at)
    VALUES ($1, $2, 'LE01', 'W-1', $5, 'STD', 'w', 'north', 'u1', $3, 'CNY', 1.5, 2, 3, 1, $4)`,
    [id, o.createdAt, o.status, o.updatedAt ?? o.createdAt, o.createdAt.slice(0, 10)]);
  return id;
}

export async function logRows(db: TestDb, action: string): Promise<{ table_name: string; unit_key: string; detail: any }[]> {
  return (await db.su(`SELECT table_name, unit_key, detail FROM ${db.schema}.besdk_lifecycle_log WHERE action = $1 ORDER BY id`, [action])).rows;
}

export async function unitRow(db: TestDb, table: string, unit: string): Promise<Record<string, any> | undefined> {
  return (await db.su(`SELECT * FROM ${db.schema}.besdk_lifecycle_units WHERE table_name = $1 AND unit_key = $2`, [table, unit])).rows[0];
}

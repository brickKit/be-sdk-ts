// The executor (P16.2, G2): each action is one transaction under a step lock (a transaction-level advisory lock
// keyed by the schema, "be.lifecycle" and the action; another executor holding it means the action is skipped this
// round) and a lock_timeout, so DDL never queues on the hot path. The runtime role performs DDL only through the
// platform's SECURITY DEFINER functions. Every action re-checks its precondition under the lock: two engines on
// one schema never perform the same step twice.
import { isBeError } from "../errors/beError.js";
import { rangePartition, ensureRangeWindow, type Grain } from "../migrate/window.js";
import { quoteIdent } from "../store/sql.js";
import type { Store } from "../store/store.js";
import type { Tx } from "../store/tx.js";
import type { QueryRows } from "../store/types.js";
import { appendLog, emitEvent, queryOf, type EngineContext } from "./context.js";
import { statsSql } from "./state.js";
import { findPartition, followerParts, LOCK_NAME, sealUnit } from "./seal.js";
import type { Action, EffectiveTable } from "./types.js";

export const ACTOR = "be.lifecycle";
/** lock_timeout of a step; expiry detaches under a shorter one (P16.2) */
export const STEP_LOCK_TIMEOUT_MS = 3_000;
export const EXPIRE_LOCK_TIMEOUT_MS = 1_000;

export type Outcome = "done" | "noop" | "blocked" | "locked" | "dry_run" | "failed";
export interface ActionResult {
  action: Action;
  outcome: Outcome;
  detail?: Record<string, unknown>;
  error?: string;
}

export async function execute(ctx: EngineContext, store: Store, a: Action): Promise<ActionResult> {
  try {
    return await store.tx(async (tx) => {
      if (!(await tx.tryLock(LOCK_NAME, a.kind, a.table, a.unit))) return { action: a, outcome: "locked" as const };
      return step(ctx, tx, a);
    }, { lockTimeoutMs: a.kind === "expire" ? EXPIRE_LOCK_TIMEOUT_MS : STEP_LOCK_TIMEOUT_MS, maxAttempts: 1 });
  } catch (e) {
    const error = isBeError(e) ? `${e.reason}: ${e.message}` : (e as Error).message;
    ctx.logger.warn({ kind: a.kind, table: a.table, unit: a.unit, error }, "lifecycle: action failed; retried next round");
    return { action: a, outcome: "failed", error };
  }
}

async function step(ctx: EngineContext, tx: Tx, a: Action): Promise<ActionResult> {
  const t = ctx.tables.get(a.table)!;
  switch (a.kind) {
    case "ensure_partition":
      return ensurePartition(ctx, tx, t, a);
    case "install_guard":
      return installGuard(tx, t, a);
    case "seal": {
      const r = await sealUnit(ctx, tx, a.table, a.unit, ACTOR);
      return { action: a, outcome: r.outcome === "sealed" ? "done" : r.outcome === "blocked" ? "blocked" : "noop", detail: r };
    }
    case "expire":
      return expire(ctx, tx, t, a);
    case "propose_destruction":
      return propose(tx, a);
  }
}

const isImmediate = (t: EffectiveTable) => t.tiers?.seal === "immediate" && ["document", "ledger", "audit"].includes(t.class);

/** Creates one period of `t` and its followers (same bounds, same transaction); guards them when sealed at once. */
async function ensurePartition(ctx: EngineContext, tx: Tx, t: EffectiveTable, a: Extract<Action, { kind: "ensure_partition" }>): Promise<ActionResult> {
  const query = queryOf(tx);
  const grain = (t.partition as { grain: Grain }).grain;
  const created: string[] = [];
  for (const table of [t.name, ...a.followers]) {
    const p = table === t.name ? { name: a.unit, from: a.from, to: a.to } : rangePartition(table, grain, a.from);
    const made = await ensureRangeWindow(query, [p], table);
    for (const name of made) {
      if (isImmediate(t)) await query(`SELECT besdk_seal_table($1)`, [name]);
      await query(`INSERT INTO besdk_lifecycle_units (table_name, unit_key, range_from, range_to, state) VALUES ($1, $2, $3, $4, 'ACTIVE')
        ON CONFLICT (table_name, unit_key) DO NOTHING`, [table, name, p.from, p.to]);
      created.push(name);
    }
  }
  if (created.length === 0) return { action: a, outcome: "noop" };
  await appendLog(query, { table: t.name, unit: a.unit, action: "partition_created", actor: ACTOR,
    detail: { partitions: created, from: a.from.toISOString(), to: a.to.toISOString(), guarded: isImmediate(t) } });
  ctx.logger.info({ table: t.name, partitions: created }, "lifecycle: partitions created");
  return { action: a, outcome: "done", detail: { created } };
}

async function installGuard(tx: Tx, t: EffectiveTable, a: Action): Promise<ActionResult> {
  const query = queryOf(tx);
  const p = await findPartition(query, t.name, a.unit);
  const rels = [p.name, ...(await followerParts(query, t, p)).map((f) => f.part)];
  let installed = false;
  for (const rel of rels) installed = ((await query(`SELECT besdk_seal_table($1) AS ok`, [rel]))[0] as { ok: boolean }).ok || installed;
  if (!installed) return { action: a, outcome: "noop" };
  await appendLog(query, { table: t.name, unit: a.unit, action: "guard_installed", actor: ACTOR, detail: { partitions: rels } });
  return { action: a, outcome: "done" };
}

/** Drops an expired queue or platform partition: under a write lock, no open row, then a plain DETACH + DROP. */
async function expire(ctx: EngineContext, tx: Tx, t: EffectiveTable, a: Extract<Action, { kind: "expire" }>): Promise<ActionResult> {
  const query = queryOf(tx);
  const p = await findPartition(query, t.name, a.unit).catch(() => undefined);
  if (!p) return { action: a, outcome: "noop" };
  await query(`LOCK TABLE ${quoteIdent(p.name)} IN SHARE ROW EXCLUSIVE MODE`);
  const s = await partitionStats(query, t, p.name);
  if (s.rows > 0 && (t.closed === undefined || s.open > 0)) return { action: a, outcome: "blocked", detail: { open_rows: s.open } };
  await query(`SELECT besdk_drop_partition($1, $2)`, [t.name, p.name]);
  const detail = { rows: s.rows, from: p.from?.toISOString() ?? null, to: p.to?.toISOString() ?? null, basis: t.retention?.basis ?? null };
  if (a.class === "queue") {
    await query(`INSERT INTO besdk_lifecycle_units AS u (table_name, unit_key, range_from, range_to, state, rows, destroyed_at)
      VALUES ($1, $2, $3, $4, 'DESTROYED', $5, now())
      ON CONFLICT (table_name, unit_key) DO UPDATE SET state = 'DESTROYED', rows = EXCLUDED.rows, destroyed_at = now(),
        version = u.version + 1, updated_at = now()`, [t.name, p.name, p.from ?? null, p.to ?? null, s.rows]);
  }
  await appendLog(query, { table: t.name, unit: p.name, action: "expired", actor: ACTOR, detail });
  if (a.class === "queue") await emitEvent(ctx, tx, "destroyed", { table: t.name, unit_key: p.name, ...detail });
  ctx.logger.info({ table: t.name, unit: p.name, rows: s.rows }, "lifecycle: expired partition dropped");
  return { action: a, outcome: "done", detail };
}

async function partitionStats(query: QueryRows, t: EffectiveTable, rel: string): Promise<{ rows: number; open: number }> {
  return (await query(statsSql(t, rel), t.closed ? [t.closed.in] : []))[0] as { rows: number; open: number };
}

/** Puts a due unit on the destruction list (besdk_lifecycle_log, kept forever); never destroys it. */
async function propose(tx: Tx, a: Extract<Action, { kind: "propose_destruction" }>): Promise<ActionResult> {
  const query = queryOf(tx);
  const dup = await query(`SELECT 1 FROM besdk_lifecycle_log WHERE action = 'destruction_proposed' AND table_name = $1 AND unit_key = $2`, [a.table, a.unit]);
  if (dup.length > 0) return { action: a, outcome: "noop" };
  const u = (await query(`SELECT rows, encode(unit_digest, 'hex') AS digest FROM besdk_lifecycle_units WHERE table_name = $1 AND unit_key = $2`,
    [a.table, a.unit]))[0] as { rows: string | null; digest: string | null } | undefined;
  await appendLog(query, { table: a.table, unit: a.unit, action: "destruction_proposed", actor: ACTOR,
    detail: { basis: a.basis, end: a.end, rows: u?.rows === null || u?.rows === undefined ? null : Number(u.rows), unit_digest: u?.digest ?? null, state: "PROPOSED" } });
  return { action: a, outcome: "done" };
}

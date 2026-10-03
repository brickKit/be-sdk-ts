// Sealing a unit (P16.5, G5, G6) and verifying the digest chain. In the caller's transaction: lock the unit's
// partitions against writes (SHARE ROW EXCLUSIVE: reads go on) → check that every row is closed (else BLOCKED,
// with the first 100 open ids) → install the guard through besdk_seal_table → digest each table of the unit and
// link it into that table's chain under a per-table chain lock → besdk_lifecycle_units → besdk_lifecycle_log →
// the `sealed` event. sealed_at is clock_timestamp() taken under the chain lock, so the chain's order is the
// order of sealed_at (then unit_key).
import { platformError } from "../errors/beError.js";
import { quoteIdent } from "../store/sql.js";
import type { Tx } from "../store/tx.js";
import type { QueryRows } from "../store/types.js";
import { appendLog, emitEvent, hex, queryOf, type EngineContext } from "./context.js";
import { chainDigest, computeDigest, readShape } from "./digest.js";
import { partitionsOf } from "./state.js";
import { SEALED_STATES, type EffectiveTable, type PartitionState, type UnitState } from "./types.js";

export const LOCK_NAME = "be.lifecycle";
const MAX_IDS = 100;

export type SealOutcome =
  | { outcome: "sealed"; rows: number; unitDigest: string; chainDigest: string }
  | { outcome: "already_sealed"; state: UnitState }
  | { outcome: "blocked"; openRows: number; ids: string[] };

export function businessTable(ctx: EngineContext, table: string): EffectiveTable {
  const t = ctx.tables.get(table);
  if (!t || !["document", "ledger", "audit"].includes(t.class) || t.follows !== undefined) {
    throw platformError("NOT_FOUND", undefined, `${table} is not a sealable table of lifecycle.yaml (document, ledger or audit, not a follower)`);
  }
  return t;
}

/** The partition of `table` named `unit`, or holding the LIST value `unit`. */
export async function findPartition(query: QueryRows, table: string, unit: string): Promise<PartitionState> {
  const parts = await partitionsOf(query, table);
  const p = parts.find((x) => x.name === unit) ?? parts.find((x) => x.listValue === unit);
  if (!p) throw platformError("NOT_FOUND", undefined, `${table} has no attached unit ${unit}`);
  return p;
}

/** Partitions of the followers with the same bounds as `p`. */
export async function followerParts(query: QueryRows, t: EffectiveTable, p: PartitionState): Promise<{ table: string; part: string }[]> {
  const out: { table: string; part: string }[] = [];
  for (const f of t.followers) {
    const match = (await partitionsOf(query, f)).find((x) =>
      (p.listValue !== undefined && x.listValue === p.listValue) || (p.from !== undefined && x.from?.getTime() === p.from.getTime()));
    if (match) out.push({ table: f, part: match.name });
  }
  return out;
}

async function openRows(query: QueryRows, t: EffectiveTable, part: string): Promise<{ n: number; ids: string[] }> {
  const c = t.closed!;
  const open = `(${quoteIdent(c.column)})::text = ANY($1::text[]) IS NOT TRUE`;
  const n = ((await query(`SELECT count(*)::float8 AS n FROM ${quoteIdent(part)} WHERE ${open}`, [c.in]))[0] as { n: number }).n;
  if (n === 0) return { n, ids: [] };
  const { pk } = await readShape(query, t.name);
  const order = pk.map((k) => `${quoteIdent(k.name)}${k.collatable ? ' COLLATE "C"' : ""}`).join(", ");
  const rows = await query(`SELECT (${quoteIdent(pk[0]!.name)})::text AS id FROM ${quoteIdent(part)} WHERE ${open} ORDER BY ${order} LIMIT ${MAX_IDS}`, [c.in]);
  return { n, ids: rows.map((r: { id: string }) => r.id) };
}

async function currentState(query: QueryRows, table: string, unit: string): Promise<UnitState | undefined> {
  const r = await query(`SELECT state FROM besdk_lifecycle_units WHERE table_name = $1 AND unit_key = $2 FOR UPDATE`, [table, unit]);
  return (r[0] as { state: UnitState } | undefined)?.state;
}

const UPSERT = `
INSERT INTO besdk_lifecycle_units AS u (table_name, unit_key, range_from, range_to, list_value, state, rows, min_id, max_id,
                                        unit_digest, chain_digest, sealed_at, blocked_reason)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
ON CONFLICT (table_name, unit_key) DO UPDATE SET state = EXCLUDED.state, rows = EXCLUDED.rows, min_id = EXCLUDED.min_id,
  max_id = EXCLUDED.max_id, unit_digest = EXCLUDED.unit_digest, chain_digest = EXCLUDED.chain_digest,
  sealed_at = EXCLUDED.sealed_at, blocked_reason = EXCLUDED.blocked_reason, range_from = EXCLUDED.range_from,
  range_to = EXCLUDED.range_to, list_value = EXCLUDED.list_value, version = u.version + 1, updated_at = now()`;

async function block(ctx: EngineContext, query: QueryRows, t: EffectiveTable, p: PartitionState, o: { n: number; ids: string[] }, actor: string) {
  const reason = `OPEN_ROWS: ${o.n} row(s) not closed (${t.closed!.column} not in ${t.closed!.in.join(", ")}); first ids: ${o.ids.join(", ")}`;
  await query(UPSERT, [t.name, p.name, p.from ?? null, p.to ?? null, p.listValue ?? null, "BLOCKED", null, null, null, null, null, null, reason]);
  await appendLog(query, { table: t.name, unit: p.name, action: "blocked", actor, detail: { reason: "OPEN_ROWS", open_rows: o.n, ids: o.ids } });
  ctx.logger.warn({ table: t.name, unit: p.name, open_rows: o.n }, "lifecycle: unit not sealed, it has open rows");
}

/** Digests one table's unit and links it into that table's chain; returns the stored digests. */
async function link(query: QueryRows, table: string, p: PartitionState, part: string, tx: Tx) {
  await tx.lock(LOCK_NAME, "chain", table);
  const d = await computeDigest(query, table, part);
  const prev = (await query(`SELECT chain_digest FROM besdk_lifecycle_units WHERE table_name = $1 AND chain_digest IS NOT NULL
    ORDER BY sealed_at DESC, unit_key DESC LIMIT 1`, [table]))[0] as { chain_digest: Buffer } | undefined;
  const chain = chainDigest(prev?.chain_digest, d.digest);
  const at = ((await query(`SELECT clock_timestamp() AS t`))[0] as { t: Date }).t;
  await query(UPSERT, [table, part, p.from ?? null, p.to ?? null, p.listValue ?? null, "SEALED", d.rows, d.minId ?? null, d.maxId ?? null, d.digest, chain, at, null]);
  return { rows: d.rows, unit_digest: hex(d.digest)!, chain_digest: hex(chain)!, min_id: d.minId ?? null, max_id: d.maxId ?? null };
}

/** Seals one unit of `table` in `tx` (the engine's seal step, or the component's on_signal seal). */
export async function sealUnit(ctx: EngineContext, tx: Tx, table: string, unit: string, actor: string): Promise<SealOutcome> {
  const query = queryOf(tx);
  const t = businessTable(ctx, table);
  const p = await findPartition(query, table, unit);
  const state = await currentState(query, table, p.name);
  if (state !== undefined && SEALED_STATES.has(state)) return { outcome: "already_sealed", state };
  const followers = await followerParts(query, t, p);
  for (const rel of [p.name, ...followers.map((f) => f.part)]) await query(`LOCK TABLE ${quoteIdent(rel)} IN SHARE ROW EXCLUSIVE MODE`);
  if (t.closed && t.tiers?.seal !== "immediate") {
    const open = await openRows(query, t, p.name);
    if (open.n > 0) {
      await block(ctx, query, t, p, open, actor);
      return { outcome: "blocked", openRows: open.n, ids: open.ids };
    }
  }
  for (const rel of [p.name, ...followers.map((f) => f.part)]) await query(`SELECT besdk_seal_table($1)`, [rel]);
  const main = await link(query, table, p, p.name, tx);
  const linked: Record<string, unknown>[] = [];
  for (const f of followers) linked.push({ table: f.table, unit_key: f.part, ...(await link(query, f.table, p, f.part, tx)) });
  const detail = { ...main, followers: linked };
  await appendLog(query, { table, unit: p.name, action: "sealed", actor, detail });
  await emitEvent(ctx, tx, "sealed", {
    table, unit_key: p.name, range_from: p.from?.toISOString() ?? null, range_to: p.to?.toISOString() ?? null, list_value: p.listValue ?? null, ...detail,
  });
  return { outcome: "sealed", rows: main.rows, unitDigest: main.unit_digest, chainDigest: main.chain_digest };
}

export interface VerifyReport {
  ok: boolean;
  units_checked: number;
  mismatched_units: string[];
}

/** G6: recomputes every sealed unit's digest still in the database and the table's whole chain. */
export async function verifyTable(query: QueryRows, table: string): Promise<VerifyReport> {
  const units = (await query(`SELECT unit_key, state, unit_digest, chain_digest FROM besdk_lifecycle_units
    WHERE table_name = $1 AND state = ANY($2::text[]) ORDER BY sealed_at, unit_key`, [table, [...SEALED_STATES]])) as
    { unit_key: string; state: UnitState; unit_digest: Buffer | null; chain_digest: Buffer | null }[];
  const mismatched: string[] = [];
  let prev: Buffer | undefined;
  for (const u of units) {
    let digest = u.unit_digest ?? Buffer.alloc(0);
    if (u.state !== "COLD" && u.state !== "DESTROYED") {
      const exists = ((await query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [quoteIdent(u.unit_key)]))[0] as { ok: boolean }).ok;
      digest = exists ? (await computeDigest(query, table, u.unit_key)).digest : Buffer.alloc(0);
    }
    const chain = chainDigest(prev, digest);
    if (!u.unit_digest?.equals(digest) || !u.chain_digest?.equals(chain)) mismatched.push(u.unit_key);
    // each link is checked against the stored previous link, so a change is reported at the unit it touched
    prev = u.chain_digest ?? chain;
  }
  return { ok: mismatched.length === 0, units_checked: units.length, mismatched_units: mismatched };
}

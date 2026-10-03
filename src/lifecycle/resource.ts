// The state behind the `_lifecycle` resource contract (P16.4): units of a table, and legal holds (G9).
import { newId } from "../ids.js";
import { BeError, platformError } from "../errors/beError.js";
import type { QueryRows } from "../store/types.js";
import { appendLog, type EngineContext } from "./context.js";
import { partitionsOf } from "./state.js";
import type { HoldScope } from "./types.js";

export interface UnitView {
  table: string;
  unit_key: string;
  range_from: string | null;
  range_to: string | null;
  list_value: string | null;
  state: string;
  rows: number | null;
  blocked_reason: string | null;
  sealed_at: string | null;
  cold_at: string | null;
  thawed_until: string | null;
}

export interface HoldView {
  hold_id: string;
  scope: HoldScope;
  reason: string;
  placed_by: string;
  placed_at: string;
  released_at: string | null;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export function encodeCursor(unitKey: string): string {
  return Buffer.from(JSON.stringify({ k: unitKey })).toString("base64url");
}

function decodeCursor(cursor: string): string {
  try {
    const v = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { k?: unknown };
    if (typeof v.k === "string") return v.k;
  } catch {
    // fall through
  }
  throw platformError("CURSOR_INVALID", undefined, "the cursor was not issued by this endpoint");
}

/** Units recorded in besdk_lifecycle_units, plus attached partitions without a record (ACTIVE), by unit key. */
export async function listUnits(query: QueryRows, table: string, pageSize = 100, cursor?: string): Promise<{ units: UnitView[]; next_cursor: string }> {
  const after = cursor ? decodeCursor(cursor) : undefined;
  const rows = (await query(`SELECT table_name, unit_key, range_from, range_to, list_value, state, rows, blocked_reason,
      sealed_at, cold_at, thawed_until FROM besdk_lifecycle_units WHERE table_name = $1`, [table])) as Record<string, any>[];
  const byKey = new Map<string, UnitView>();
  for (const r of rows) {
    byKey.set(r.unit_key, {
      table, unit_key: r.unit_key, range_from: iso(r.range_from), range_to: iso(r.range_to), list_value: r.list_value, state: r.state,
      rows: r.rows === null ? null : Number(r.rows), blocked_reason: r.blocked_reason, sealed_at: iso(r.sealed_at), cold_at: iso(r.cold_at),
      thawed_until: iso(r.thawed_until),
    });
  }
  for (const p of await partitionsOf(query, table)) {
    if (byKey.has(p.name)) continue;
    byKey.set(p.name, {
      table, unit_key: p.name, range_from: iso(p.from), range_to: iso(p.to), list_value: p.listValue ?? null, state: "ACTIVE",
      rows: null, blocked_reason: null, sealed_at: null, cold_at: null, thawed_until: null,
    });
  }
  const all = [...byKey.values()].sort((a, b) => (a.unit_key < b.unit_key ? -1 : a.unit_key > b.unit_key ? 1 : 0))
    .filter((u) => after === undefined || u.unit_key > after);
  const page = all.slice(0, pageSize);
  return { units: page, next_cursor: all.length > pageSize ? encodeCursor(page.at(-1)!.unit_key) : "" };
}

const toHold = (r: Record<string, any>): HoldView => ({
  hold_id: r.hold_id, scope: r.scope, reason: r.reason, placed_by: r.placed_by, placed_at: iso(r.placed_at)!, released_at: iso(r.released_at),
});

export async function listHolds(query: QueryRows): Promise<HoldView[]> {
  const rows = await query(`SELECT * FROM besdk_holds WHERE released_at IS NULL ORDER BY placed_at, hold_id`);
  return rows.map(toHold);
}

function invalid(field: string, description: string): BeError {
  return new BeError("INVALID_ARGUMENT", "REQUEST_INVALID", {
    domain: "be", message: `${field}: ${description}`, violations: [{ field, reason: "INVALID", description }],
  });
}

/** Checks a hold's scope: at least one of tables, units, subjects; tables must be declared. */
export function checkScope(ctx: EngineContext, scope: unknown): HoldScope {
  if (typeof scope !== "object" || scope === null || Array.isArray(scope)) throw invalid("scope", "an object");
  const s = scope as Record<string, unknown>;
  const extra = Object.keys(s).filter((k) => !["tables", "units", "subjects"].includes(k));
  if (extra.length > 0) throw invalid("scope", `unknown member ${extra[0]} (tables, units, subjects)`);
  const arr = (k: string) => (s[k] === undefined ? [] : Array.isArray(s[k]) ? (s[k] as unknown[]) : null);
  const [tables, units, subjects] = [arr("tables"), arr("units"), arr("subjects")];
  if (!tables || !units || !subjects) throw invalid("scope", "tables, units and subjects are arrays");
  if (tables.length + units.length + subjects.length === 0) throw invalid("scope", "names at least one table, unit or subject");
  for (const t of [...tables, ...units.map((u) => (u as { table?: unknown })?.table)]) {
    if (typeof t !== "string" || !ctx.tables.has(t)) throw invalid("scope", `${JSON.stringify(t)} is not a table of lifecycle.yaml`);
  }
  for (const u of units) if (typeof (u as { unit_key?: unknown }).unit_key !== "string") throw invalid("scope.units", "each has table and unit_key");
  for (const x of subjects) {
    const v = x as { subject?: unknown; subject_id?: unknown };
    if (typeof v.subject !== "string" || typeof v.subject_id !== "string") throw invalid("scope.subjects", "each has subject and subject_id");
  }
  return s as HoldScope;
}

export async function placeHold(ctx: EngineContext, query: QueryRows, scope: unknown, reason: unknown, actor: string): Promise<HoldView> {
  const sc = checkScope(ctx, scope);
  if (typeof reason !== "string" || reason.trim() === "") throw invalid("reason", "a non-empty string");
  const id = newId();
  const r = await query(`INSERT INTO besdk_holds (hold_id, scope, reason, placed_by, placed_at) VALUES ($1, $2::jsonb, $3, $4, now()) RETURNING *`,
    [id, JSON.stringify(sc), reason, actor]);
  await appendLog(query, { action: "hold_placed", actor, detail: { hold_id: id, scope: sc, reason } });
  return toHold(r[0]!);
}

export async function releaseHold(query: QueryRows, holdId: string, actor: string): Promise<HoldView> {
  const r = await query(`UPDATE besdk_holds SET released_at = now() WHERE hold_id = $1 AND released_at IS NULL RETURNING *`, [holdId]);
  if (r.length > 0) {
    await appendLog(query, { action: "hold_released", actor, detail: { hold_id: holdId } });
    return toHold(r[0]!);
  }
  const existing = await query(`SELECT * FROM besdk_holds WHERE hold_id = $1`, [holdId]);
  if (existing.length === 0) throw platformError("NOT_FOUND", undefined, `no hold ${holdId}`);
  return toHold(existing[0]!);
}

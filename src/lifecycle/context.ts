// What the executor, the seal and the resource handlers share: the effective rules, DATA_LIFECYCLE, the event
// hook, and the two append-only records every action leaves (besdk_lifecycle_log, P16.7).
import type { Logger } from "../log/logger.js";
import type { Tx } from "../store/tx.js";
import type { QueryRows } from "../store/types.js";
import { rulesOf, type FiscalCalendar } from "./rules.js";
import type { Declaration, EffectiveTable, LifecycleConfig } from "./types.js";

/** Writes one lifecycle event through the outbox, in `tx` (wired by the runtime to the member's outbox). */
export type EmitFn = (tx: Tx, subject: string, payload: Record<string, unknown>) => Promise<void>;

export const LIFECYCLE_EVENTS = ["sealed", "frozen", "thawed", "destroyed", "erasure_completed"] as const;
export type LifecycleEvent = (typeof LIFECYCLE_EVENTS)[number];

export interface EngineContext {
  memberId: string;
  decl: Declaration;
  cfg: LifecycleConfig;
  logger: Logger;
  tables: Map<string, EffectiveTable>;
  emit?: EmitFn;
  calendar?: FiscalCalendar;
}

export function newContext(o: Omit<EngineContext, "tables">): EngineContext {
  return { ...o, tables: new Map(rulesOf(o.decl, o.cfg).map((t) => [t.name, t])) };
}

export const queryOf = (tx: Tx): QueryRows => (sql, params) => tx.query(sql, params);

/** `<domain>.<name>.lifecycle.<action>.v1`; a `-` in the component ID becomes `_` (subject segments, P12.3). */
export function lifecycleSubject(memberId: string, action: LifecycleEvent): string {
  return `${memberId.replace("/", ".").replaceAll("-", "_")}.lifecycle.${action}.v1`;
}

export async function appendLog(query: QueryRows, e: { table?: string; unit?: string; action: string; actor: string; detail: object }): Promise<void> {
  await query(`INSERT INTO besdk_lifecycle_log (table_name, unit_key, action, actor, detail) VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [e.table ?? null, e.unit ?? null, e.action, e.actor, JSON.stringify(e.detail)]);
}

export async function emitEvent(ctx: EngineContext, tx: Tx, action: LifecycleEvent, payload: Record<string, unknown>): Promise<void> {
  if (!ctx.emit) {
    ctx.logger.debug({ action }, "lifecycle: no event hook wired; event not published");
    return;
  }
  await ctx.emit(tx, lifecycleSubject(ctx.memberId, action), payload);
}

export const hex = (b: Buffer | null | undefined) => (b ? b.toString("hex") : null);

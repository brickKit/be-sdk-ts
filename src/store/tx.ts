// One open transaction of a member (sdk-redesign-apis §4 `Tx`). Every statement carries the member's prefix
// (P10.2) and stays unnamed (r1-04: pg's unnamed statements are never reused across members); before each
// statement the remaining deadline is checked and statement_timeout lowered to it when needed (P10.3), and an
// aborted unit of work cancels the running statement. Driver errors are thrown unchanged: Store.tx maps them
// when the transaction ends, so a body can still inspect a SQLSTATE.
import type pg from "pg";
import type { ZodType } from "zod";
import type { Unit } from "../context.js";
import { BeError, platformError } from "../errors/beError.js";
import { cancelTargetOf, sendCancel } from "./cancel.js";
import { lockSql, prefixSql, statementTimeoutSql } from "./sql.js";

export interface EnqueueOptions {
  runAt?: Date;
  uniqueKey?: string;
}

/** Capabilities other SDK modules plug into every Tx (the events and jobs modules fill them). */
export interface TxExtensions {
  publish?: (tx: Tx, ev: unknown) => Promise<void>;
  enqueue?: (tx: Tx, kind: string, args: unknown, opts: EnqueueOptions) => Promise<void>;
}

export interface TxInit {
  client: pg.PoolClient;
  unit: Unit;
  schema: string;
  memberId: string;
  statementTimeoutMs: number;
  extensions: TxExtensions;
}

export class Tx {
  readonly schema: string;
  readonly memberId: string;
  private readonly client: pg.PoolClient;
  private readonly unit: Unit;
  private readonly extensions: TxExtensions;
  private statementTimeoutMs: number;
  private open = true;

  constructor(o: TxInit) {
    this.client = o.client;
    this.unit = o.unit;
    this.schema = o.schema;
    this.memberId = o.memberId;
    this.statementTimeoutMs = o.statementTimeoutMs;
    this.extensions = o.extensions;
  }

  /** Runs one statement; rows are validated with `row` when given. */
  async query<R = Record<string, any>>(sql: string, params?: unknown[], row?: ZodType<R>): Promise<R[]> {
    const res = await this.send(sql, params);
    if (!row) return res.rows as R[];
    return res.rows.map((r) => {
      const parsed = row.safeParse(r);
      if (!parsed.success) throw platformError("INTERNAL", undefined, "a row does not match its schema", parsed.error);
      return parsed.data;
    });
  }

  /** Waits for the transaction-level advisory lock `name` + parts (P10.8). */
  async lock(name: string, ...parts: string[]): Promise<void> {
    await this.send(lockSql(false), [name, parts.join("|")]);
  }

  /** Takes the lock when free; false when another transaction holds it. */
  async tryLock(name: string, ...parts: string[]): Promise<boolean> {
    const r = await this.send(lockSql(true), [name, parts.join("|")]);
    return (r.rows[0] as { locked: boolean }).locked;
  }

  publish(ev: unknown): Promise<void> {
    const p = this.extensions.publish;
    if (!p) throw platformError("CAPABILITY_UNAVAILABLE", { capability: "events" }, "no event bus is configured for this member");
    return p(this, ev);
  }

  enqueue(kind: string, args: unknown, opts: EnqueueOptions = {}): Promise<void> {
    const e = this.extensions.enqueue;
    if (!e) throw platformError("CAPABILITY_UNAVAILABLE", { capability: "jobs" }, "the job queue is not available for this member");
    return e(this, kind, args, opts);
  }

  /** @internal Store: the transaction is over; later statements are refused. */
  close(): void {
    this.open = false;
  }

  /** @internal Store: COMMIT / ROLLBACK, prefixed like every statement. */
  async finish(sql: "COMMIT" | "ROLLBACK"): Promise<pg.QueryResult> {
    this.open = false;
    return this.client.query(prefixSql(this.schema, sql));
  }

  private async send(sql: string, params?: unknown[]): Promise<pg.QueryResult> {
    if (!this.open) throw platformError("INTERNAL", undefined, "statement after the transaction ended");
    if (this.unit.signal.aborted) throw cancelled();
    const remaining = Math.floor(this.unit.remainingMs());
    if (remaining <= 0) throw platformError("DEADLINE_BUDGET_EXHAUSTED", undefined, "the deadline passed before the statement was sent");
    if (remaining < this.statementTimeoutMs) {
      await this.run(statementTimeoutSql(remaining));
      this.statementTimeoutMs = remaining;
    }
    return this.run(sql, params);
  }

  private async run(sql: string, params?: unknown[]): Promise<pg.QueryResult> {
    const signal = this.unit.signal;
    const target = cancelTargetOf(this.client);
    const onAbort = () => void (target && sendCancel(target));
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      // never pass `name`: pg's unnamed statements are not cached across members on a shared connection
      return await this.client.query({ text: prefixSql(this.schema, sql), values: params });
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

export function cancelled(cause?: unknown): BeError {
  return new BeError("CANCELLED", "", { message: "the unit of work was cancelled", cause });
}

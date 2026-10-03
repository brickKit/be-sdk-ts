// Shapes shared by the store, the migration step and the SDK modules built on them.
import type pg from "pg";
import type { Isolation } from "./sql.js";

/** Runs one statement and returns its rows (tx.query, or a dedicated client's query). */
export type QueryRows = (sql: string, params?: unknown[]) => Promise<any[]>;

/** The part of a pg.Pool the store uses: a shell passes its one shared physical pool (P10.5). */
export interface PoolLike {
  connect(): Promise<pg.PoolClient>;
  end(): Promise<void>;
}

export interface TxOptions {
  isolation?: Isolation;
  readOnly?: boolean;
  /** default 5 s (30 s for a read snapshot); always capped by the remaining deadline */
  statementTimeoutMs?: number;
  /** default 2 s */
  lockTimeoutMs?: number;
  /** default 30 s */
  idleTimeoutMs?: number;
  /** default 3; only 40001 / 40P01 re-run the body */
  maxAttempts?: number;
}

export interface DbIdentity {
  role: string;
  schema: string;
}

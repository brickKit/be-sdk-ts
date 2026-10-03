// A member's database access (P10): bound to the runtime role PG_USER, the schema PG_SCHEMA and the member's
// ID; never the owner (P10.12). Every access is a transaction opened with the SET LOCAL block (P10.2, P10.3);
// a member holds at most PG_POOL_MAX connections, waiting at most min(PG_POOL_ACQUIRE_TIMEOUT, remaining
// deadline) (P10.5); 40001 / 40P01 re-run the body (P10.4); one unit of work holds one connection (P10.6).
import type pg from "pg";
import type { Config } from "../config/config.js";
import { currentUnit, runUnit, Unit } from "../context.js";
import { BeError, isBeError, platformError } from "../errors/beError.js";
import { classifySqlState, MAX_TX_ATTEMPTS, type SqlContext } from "../errors/sqlstate.js";
import type { Logger } from "../log/logger.js";
import type { MemberRegistry } from "../obs/metrics.js";
import { sleep } from "../util/sleep.js";
import { isConnectionError, sqlStateOf } from "./errors.js";
import { createStandalonePool, poolSettings, type PoolSettings } from "./pool.js";
import { Semaphore, SemaphoreTimeout } from "./semaphore.js";
import {
  capStatementTimeout,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_LOCK_TIMEOUT_MS,
  preambleSql,
  prefixSql,
} from "./sql.js";
import { cancelled, Tx, type TxExtensions } from "./tx.js";
import type { DbIdentity, PoolLike, TxOptions } from "./types.js";

export interface StoreOptions {
  memberId: string;
  /** the component version: sessions are named `<member ID>@<version>` (P10.2); default "0.0.0" */
  version?: string;
  config: Config;
  logger: Logger;
  metrics: MemberRegistry;
  /** a shell's shared physical pool; absent = the store creates its own on first use */
  pool?: PoolLike;
  extensions?: TxExtensions;
  /** deadline of a transaction opened outside any unit of work (default 30 s) */
  backgroundDeadlineMs?: number;
}

interface Lease {
  client: pg.PoolClient;
  release(destroy?: Error): void;
}

const RETRYABLE = new Set(["40001", "40P01"]); // serialization failure, deadlock
const PG17 = 170_000;

export class Store {
  readonly memberId: string;
  private readonly version: string;
  private readonly config: Config;
  private readonly logger: Logger;
  private readonly metrics: MemberRegistry;
  private readonly settings: PoolSettings;
  private readonly budget: Semaphore;
  private readonly extensions: TxExtensions;
  private readonly backgroundDeadlineMs: number;
  private readonly role: string;
  private readonly schema: string;
  private pool: PoolLike | undefined;
  private readonly ownsPool: boolean;
  private serverVersion: number | undefined;

  constructor(o: StoreOptions) {
    this.memberId = o.memberId;
    this.version = o.version ?? "0.0.0";
    this.config = o.config;
    this.logger = o.logger;
    this.metrics = o.metrics;
    this.role = o.config.require("PG_USER");
    this.schema = o.config.require("PG_SCHEMA");
    this.settings = poolSettings(o.config);
    this.budget = new Semaphore(this.settings.max);
    this.extensions = o.extensions ?? {};
    this.backgroundDeadlineMs = o.backgroundDeadlineMs ?? 30_000;
    this.pool = o.pool;
    this.ownsPool = o.pool === undefined;
  }

  get identity(): DbIdentity {
    return { role: this.role, schema: this.schema };
  }

  /** The server's version number, known after the first transaction. */
  get serverVersionNum(): number | undefined {
    return this.serverVersion;
  }

  /** Runs `fn` in a transaction; the body may run up to `maxAttempts` times (only touch `tx` inside it). */
  async tx<T>(fn: (tx: Tx) => Promise<T>, opts: TxOptions = {}): Promise<T> {
    const parent = currentUnit();
    if (parent?.inTx) throw platformError("NESTED_TX", undefined, "a transaction was opened inside another one in the same unit of work");
    const unit = parent ?? this.backgroundUnit();
    const maxAttempts = Math.max(1, opts.maxAttempts ?? MAX_TX_ATTEMPTS);
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.attempt(unit, fn, opts);
      } catch (err) {
        const state = sqlStateOf(err);
        const retryable = state !== undefined && RETRYABLE.has(state);
        if (retryable && attempt < maxAttempts && !unit.signal.aborted && unit.remainingMs() > 0) {
          this.metrics.be.txRetries.inc({ sqlstate: state });
          const base = 10 * 2 ** (attempt - 1);
          await sleep(base * (0.5 + Math.random()), unit.signal);
          continue;
        }
        throw this.mapError(err, unit, retryable ? MAX_TX_ATTEMPTS : attempt);
      }
    }
  }

  /** REPEATABLE READ READ ONLY, statement_timeout up to 30 s (P10.3). */
  readSnapshot<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.tx(fn, { isolation: "repeatable read", readOnly: true, statementTimeoutMs: 30_000 });
  }

  /** Ends the store's own pool; a shared (shell) pool is left to its owner. */
  async close(): Promise<void> {
    const p = this.pool;
    this.pool = undefined;
    if (p && this.ownsPool) await p.end();
  }

  private backgroundUnit(): Unit {
    return new Unit({ memberId: this.memberId, deadline: Date.now() + this.backgroundDeadlineMs, signal: new AbortController().signal });
  }

  private async attempt<T>(unit: Unit, fn: (tx: Tx) => Promise<T>, opts: TxOptions): Promise<T> {
    if (unit.remainingMs() < 1) throw platformError("DEADLINE_BUDGET_EXHAUSTED", undefined, "the deadline passed before the transaction began");
    const lease = await this.acquire(unit);
    let tx: Tx | undefined;
    try {
      tx = await this.begin(lease.client, unit, opts);
      const open = tx;
      const result = await runUnit(unit.forTx(), () => fn(open));
      if (unit.signal.aborted) throw cancelled();
      if (unit.remainingMs() < 1) throw platformError("DEADLINE_BUDGET_EXHAUSTED", undefined, "the deadline passed before COMMIT");
      const done = await tx.finish("COMMIT");
      // COMMIT of a failed transaction answers ROLLBACK without an error: a swallowed statement error
      if (done.command === "ROLLBACK") throw platformError("INTERNAL", undefined, "the transaction was rolled back: a statement in it failed");
      lease.release();
      return result;
    } catch (err) {
      tx?.close();
      lease.release(await this.rollback(lease.client, err));
      throw err;
    }
  }

  /** Rolls back after a failure; returns an error when the connection must be destroyed instead of reused. */
  private async rollback(client: pg.PoolClient, cause: unknown): Promise<Error | undefined> {
    if (isConnectionError(cause)) return cause instanceof Error ? cause : new Error(String(cause));
    try {
      await client.query(prefixSql(this.schema, "ROLLBACK"));
      return undefined;
    } catch (e) {
      return e instanceof Error ? e : new Error(String(e));
    }
  }

  private async begin(client: pg.PoolClient, unit: Unit, opts: TxOptions): Promise<Tx> {
    const isolation = opts.isolation ?? "read committed";
    const readOnly = opts.readOnly ?? false;
    const remaining = Math.floor(unit.remainingMs());
    const snapshot = readOnly && isolation === "repeatable read";
    const statementTimeoutMs = capStatementTimeout({ remainingMs: remaining, requestedMs: opts.statementTimeoutMs, snapshot });
    const knownPg17 = this.serverVersion !== undefined && this.serverVersion >= PG17;
    const stmts = preambleSql({
      isolation, readOnly, role: this.role, schema: this.schema, applicationName: this.memberId, statementTimeoutMs,
      lockTimeoutMs: opts.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
      idleTimeoutMs: opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
      transactionTimeoutMs: knownPg17 ? remaining : undefined,
    });
    if (this.serverVersion === undefined) stmts.push("SELECT current_setting('server_version_num')::int AS v");
    // one round trip: a simple-protocol batch, same statements as P10 "What every transaction sends"
    const res = (await client.query(prefixSql(this.schema, stmts.join(";\n")))) as unknown as pg.QueryResult[];
    if (this.serverVersion === undefined) {
      this.serverVersion = (res.at(-1)?.rows[0] as { v: number }).v;
      if (this.serverVersion >= PG17) await client.query(prefixSql(this.schema, `SET LOCAL transaction_timeout = '${remaining}ms'`));
    }
    return new Tx({ client, unit, schema: this.schema, memberId: this.memberId, statementTimeoutMs, extensions: this.extensions });
  }

  private async acquire(unit: Unit): Promise<Lease> {
    const waitMs = Math.min(this.settings.acquireTimeoutMs, unit.remainingMs());
    const t0 = performance.now();
    let permit: () => void;
    try {
      permit = await this.budget.acquire(waitMs, unit.signal);
    } catch (e) {
      this.metrics.be.dbPoolWait.observe((performance.now() - t0) / 1000);
      if (e instanceof SemaphoreTimeout) throw this.exhausted(waitMs);
      throw cancelled(e);
    }
    this.metrics.be.dbPoolInUse.inc();
    const giveBack = () => {
      permit();
      this.metrics.be.dbPoolInUse.dec();
    };
    try {
      const client = await this.connect(Math.max(1, waitMs - (performance.now() - t0)), unit);
      this.metrics.be.dbPoolWait.observe((performance.now() - t0) / 1000);
      return {
        client,
        release: (destroy) => {
          client.release(destroy ?? false);
          giveBack();
        },
      };
    } catch (e) {
      this.metrics.be.dbPoolWait.observe((performance.now() - t0) / 1000);
      giveBack();
      throw e;
    }
  }

  /** pool.connect() bounded by the remaining wait; a late connection is returned to the pool. */
  private connect(waitMs: number, unit: Unit): Promise<pg.PoolClient> {
    this.pool ??= createStandalonePool({ config: this.config, memberId: this.memberId, version: this.version, logger: this.logger, settings: this.settings });
    const pending = this.pool.connect();
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        pending.then((c) => c.release(), () => undefined);
        reject(this.exhausted(waitMs));
      }, waitMs);
      pending.then(
        (c) => {
          clearTimeout(timer);
          if (settled) return;
          resolve(c);
        },
        (e: unknown) => {
          clearTimeout(timer);
          if (settled) return;
          reject(this.mapError(e, unit, 1));
        },
      );
    });
  }

  private exhausted(waitMs: number): BeError {
    return platformError("DB_POOL_EXHAUSTED", undefined, `no connection within ${Math.round(waitMs)} ms (PG_POOL_MAX ${this.settings.max})`);
  }

  /** How a failure leaves Store.tx: our own BeErrors as they are, driver errors through the SQLSTATE table. */
  private mapError(err: unknown, unit: Unit, attempt: number): unknown {
    if (isBeError(err)) return err;
    const state = sqlStateOf(err);
    if (state === undefined) {
      if (isConnectionError(err)) return platformError("DEPENDENCY_UNAVAILABLE", { dependency: "db" }, "the database cannot be reached", err);
      return err;
    }
    const context: SqlContext = unit.signal.aborted ? "cancelled" : unit.remainingMs() <= 0 ? "deadline_exceeded" : "none";
    if (state.startsWith("08")) return platformError("DEPENDENCY_UNAVAILABLE", { dependency: "db" }, `SQLSTATE ${state}`, err);
    const c = classifySqlState(state, { attempt, context, cause: err });
    return c.action === "fail" ? c.error : platformError("TX_CONFLICT", undefined, `SQLSTATE ${state}`, err);
  }
}


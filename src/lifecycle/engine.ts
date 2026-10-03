// The data lifecycle engine of one member (P16): the declaration, DATA_LIFECYCLE, and the operations the runtime
// exposes — runOnce (the singleton job `be.lifecycle`), sealInTx (Tx.seal, on_signal), verify (G6), window
// (P16.3), the LIST partitions a component opens by command, and the state behind the `_lifecycle` resource.
//
// Modes (P16.9): `on` executes every planned action; `dry-run` executes only ensure_partition and reports the rest;
// `off` executes only ensure_partition. Keeping the partition window ahead is guarantee G1 in every mode: without it
// the component cannot write.
import { platformError } from "../errors/beError.js";
import type { Logger } from "../log/logger.js";
import type { Store } from "../store/store.js";
import type { Tx } from "../store/tx.js";
import { parseDataLifecycle } from "./config.js";
import { newContext, queryOf, appendLog, type EmitFn, type EngineContext } from "./context.js";
import { checkAllDeclared, checkNumericPrecision, checkWorm, loadDeclaration, readColumnTypes, readTables } from "./declaration.js";
import { execute, type ActionResult } from "./executor.js";
import { plan } from "./planner.js";
import { LOCK_NAME, sealUnit, verifyTable, businessTable, type SealOutcome, type VerifyReport } from "./seal.js";
import { loadState } from "./state.js";
import type { FiscalCalendar } from "./rules.js";
import type { Action, Declaration, LifecycleConfig } from "./types.js";
import { readColdUnits, readWindow, type ReadRange } from "./window.js";

export interface EngineOptions {
  /** the member's ID, `<domain>/<name>` */
  memberId: string;
  store: Store;
  declaration: Declaration;
  config: LifecycleConfig;
  logger: Logger;
  /** writes a lifecycle event through the member's outbox, in the action's transaction */
  emit?: EmitFn;
  calendar?: FiscalCalendar;
  now?: () => Date;
}

export interface RunReport {
  mode: LifecycleConfig["mode"];
  planned: Action[];
  results: ActionResult[];
}

export class LifecycleEngine {
  readonly ctx: EngineContext;
  readonly store: Store;
  private readonly now: () => Date;

  constructor(o: EngineOptions) {
    this.ctx = newContext({ memberId: o.memberId, decl: o.declaration, cfg: o.config, logger: o.logger, emit: o.emit, calendar: o.calendar });
    this.store = o.store;
    this.now = o.now ?? (() => new Date());
  }

  /** Reads migrations/lifecycle.yaml and DATA_LIFECYCLE (raw JSON / YAML text or a parsed object); fatal on a violation. */
  static load(o: Omit<EngineOptions, "declaration" | "config"> & { migrationsDir: string; dataLifecycle?: string | object }): LifecycleEngine {
    const declaration = loadDeclaration(o.migrationsDir);
    return new LifecycleEngine({ ...o, declaration, config: parseDataLifecycle(o.dataLifecycle, declaration) });
  }

  get config(): LifecycleConfig {
    return this.ctx.cfg;
  }

  /**
   * P16.1 checks that need the migrated schema, at start: every table is declared, every NUMERIC column of a
   * cold table has a precision, no erasable cold table on a WORM store. Throws LifecycleDeclarationError.
   */
  async checkSchema(): Promise<void> {
    const { tables, columns } = await this.store.tx(async (tx) => ({ tables: await readTables(queryOf(tx)), columns: await readColumnTypes(queryOf(tx)) }), { readOnly: true });
    checkAllDeclared(this.ctx.decl, tables);
    checkNumericPrecision(this.ctx.decl, columns);
    checkWorm(this.ctx.decl, false);
  }

  /** The actions of one round, without executing them. */
  async plan(): Promise<Action[]> {
    const now = this.now();
    const state = await this.store.tx((tx) => loadState(queryOf(tx), this.ctx.decl, this.ctx.cfg, now), { readOnly: true, statementTimeoutMs: 30_000 });
    return plan(this.ctx.decl, state, now, this.ctx.cfg, { calendar: this.ctx.calendar });
  }

  /** One round: load state → plan → execute each action in its own transaction. `signal` stops between actions. */
  async runOnce(signal?: AbortSignal): Promise<RunReport> {
    const mode = this.ctx.cfg.mode;
    const planned = await this.plan();
    const results: ActionResult[] = [];
    for (const a of planned) {
      if (signal?.aborted) break;
      if (mode !== "on" && a.kind !== "ensure_partition") {
        results.push({ action: a, outcome: "dry_run" });
        continue;
      }
      results.push(await execute(this.ctx, this.store, a));
    }
    if (mode === "dry-run" && results.some((r) => r.outcome === "dry_run")) {
      this.ctx.logger.info({ actions: results.filter((r) => r.outcome === "dry_run").map((r) => `${r.action.kind} ${r.action.table}/${r.action.unit}`) },
        "lifecycle dry-run: actions not executed");
    }
    return { mode, planned, results };
  }

  /** Seals one unit in the caller's transaction (on_signal, Tx.seal); waits for the unit's step lock. */
  async sealInTx(tx: Tx, table: string, unit: string): Promise<SealOutcome> {
    businessTable(this.ctx, table);
    await tx.lock(LOCK_NAME, "seal", table, unit);
    return sealUnit(this.ctx, tx, table, unit, `${this.ctx.memberId}`);
  }

  /** G6: re-computes the digest chain of a table's sealed units. */
  verify(table: string): Promise<VerifyReport> {
    this.table(table);
    return this.store.readSnapshot((tx) => verifyTable(queryOf(tx), table));
  }

  /** P16.3: the window of a List on `table`; RANGE_COLD when the range reaches the cold tier. */
  async window(table: string, range: ReadRange, includeCold = false, tx?: Tx): Promise<ReadRange> {
    const t = this.table(table);
    const cold = tx ? await readColdUnits(queryOf(tx), table) : await this.store.tx((x) => readColdUnits(queryOf(x), table), { readOnly: true });
    return readWindow(t, range, includeCold, cold, this.now(), this.ctx.cfg);
  }

  /** Opens the LIST partition of `table` for `value` (a partition `opened_by: command`), in the caller's transaction. */
  async ensureListPartition(tx: Tx, table: string, value: string): Promise<{ name: string; created: boolean }> {
    const t = this.table(table);
    if (!t.partition || !("kind" in t.partition)) throw platformError("NOT_FOUND", undefined, `${table} is not LIST-partitioned in lifecycle.yaml`);
    const name = `${table}_${value.toLowerCase().replace(/[^a-z0-9_]+/g, "_")}`;
    const query = queryOf(tx);
    const created = ((await query(`SELECT besdk_ensure_list_partition($1, $2, $3) AS ok`, [table, name, value]))[0] as { ok: boolean }).ok;
    if (created) {
      if (t.tiers?.seal === "immediate") await query(`SELECT besdk_seal_table($1)`, [name]);
      await query(`INSERT INTO besdk_lifecycle_units (table_name, unit_key, list_value, state) VALUES ($1, $2, $3, 'ACTIVE')
        ON CONFLICT (table_name, unit_key) DO NOTHING`, [table, name, value]);
      await appendLog(query, { table, unit: name, action: "partition_created", actor: this.ctx.memberId, detail: { list_value: value } });
    }
    return { name, created };
  }

  /** A declared (or platform) table's effective rules; NOT_FOUND otherwise. */
  table(name: string) {
    const t = this.ctx.tables.get(name);
    if (!t) throw platformError("NOT_FOUND", undefined, `${name} is not a table of lifecycle.yaml`);
    return t;
  }
}

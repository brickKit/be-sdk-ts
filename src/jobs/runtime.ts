// A member's background work (P14): the module's jobs, workers and reconcilers plus the runtime-owned `be.*`
// jobs, each supervised (P1.7) under its name; JOBS_OVERRIDES applied (P14.5); `job run <name>` (P14.8); the
// tx.enqueue extension. The holder is `<member ID>/<instance>` (`/job-run:<instance>` for a one-shot run).
import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import type { Logger } from "pino";
import { ConfigError } from "../config/configError.js";
import { nsToMs, parseDurationNs } from "../config/duration.js";
import type { MemberRegistry } from "../obs/metrics.js";
import type { Supervisor } from "../runtime/supervisor.js";
import type { Store } from "../store/store.js";
import type { TxExtensions } from "../store/tx.js";
import { sleep } from "../util/sleep.js";
import { drainOnce, enqueue, runWorker } from "./queue.js";
import { reconcileOnce, runReconciler } from "./reconciler.js";
import { runCron, runEvery, runScheduledOnce, runSingleton, type Effective, type ScheduledDeps } from "./scheduled.js";
import { parseSchedule } from "./schedule.js";
import { CLEANUP, QUEUE_STATS } from "./sql.js";
import type { Job, JobsModule, Override, Reconciler, RunOnceResult, Worker } from "./types.js";

export interface JobsRuntimeOptions {
  memberId: string;
  store: Store;
  logger: Logger;
  metrics: MemberRegistry;
  module: JobsModule;
  /** BUSINESS_TIMEZONE */
  zone: string;
  /** JOBS_OVERRIDES */
  overrides: Record<string, Override>;
  /** runtime-owned jobs besides be.cleanup (be.lifecycle, …) */
  platformJobs?: Job[];
  /** `job run`: the holder becomes `<member>/job-run:<instance>` */
  oneShot?: boolean;
  /** tests only: lease TTL (default 30 s) and queue poll (default 500 ms) */
  leaseTtlMs?: number;
  pollMs?: number;
}

const STATS_EVERY_MS = 15_000;

/** The runtime-owned cleanup (P14.7): expired idempotency keys, old done queue rows, old slots. */
function cleanupJob(store: Store): Job {
  return {
    name: "be.cleanup", kind: "singleton", intervalMs: 3_600_000, timeoutMs: 60_000,
    run: () => store.tx(async (tx) => {
      for (const sql of CLEANUP) await tx.query(sql);
    }),
  };
}

export class JobsRuntime {
  readonly extensions: TxExtensions;
  private readonly o: JobsRuntimeOptions;
  private readonly d: ScheduledDeps & { pollMs: number };
  private readonly jobs = new Map<string, Effective>();
  private readonly workers = new Map<string, Worker>();
  private readonly reconcilers = new Map<string, { r: Reconciler; everyMs: number; enabled: boolean }>();
  private readonly outcomes = new Map<string, { lastSuccessAt: string | null; lastError: string; lastErrorAt: string | null }>();

  constructor(o: JobsRuntimeOptions) {
    this.o = o;
    const instance = `${hostname()}-${process.pid}-${randomBytes(3).toString("hex")}`;
    this.d = {
      memberId: o.memberId, logger: o.logger, metrics: o.metrics, store: o.store,
      holder: `${o.memberId}/${o.oneShot ? "job-run:" : ""}${instance}`, leaseTtlMs: o.leaseTtlMs ?? 30_000, pollMs: o.pollMs ?? 500,
      track: (job, result, error) => this.track(job, result, error),
    };
    for (const w of o.module.workers ?? []) this.workers.set(w.kind, w);
    this.extensions = { enqueue: (tx, kind, args, opts) => enqueue(this.workers, tx, kind, args, opts) };
  }

  /** Applies JOBS_OVERRIDES and checks every schedule; throws ConfigError (exit 78) on an invalid one. */
  validate(): void {
    const ov = this.o.overrides;
    const names = new Set<string>();
    for (const job of [...(this.o.module.jobs ?? []), cleanupJob(this.o.store), ...(this.o.platformJobs ?? [])]) {
      if (names.has(job.name)) throw new ConfigError("CONFIG_INVALID", "JOBS_OVERRIDES", `two jobs are named ${job.name}`);
      names.add(job.name);
      this.jobs.set(job.name, this.effective(job, ov[job.name] ?? {}));
    }
    for (const r of this.o.module.reconcilers ?? []) {
      names.add(r.name);
      const x = ov[r.name] ?? {};
      this.reconcilers.set(r.name, { r, everyMs: x.interval ? durationMs(r.name, x.interval) : r.everyMs, enabled: x.enabled !== false });
    }
    for (const k of this.workers.keys()) names.add(k);
    for (const name of Object.keys(ov)) if (!names.has(name)) this.o.logger.warn({ job: name }, "jobs_override_unknown_job");
  }

  private effective(job: Job, x: Override): Effective {
    const zone = job.tz ?? this.o.zone;
    const e: Effective = { job, intervalMs: x.interval ? durationMs(job.name, x.interval) : job.intervalMs ?? 0, zone, enabled: x.enabled !== false };
    if (!(job.timeoutMs > 0)) throw new ConfigError("CONFIG_INVALID", "JOBS_OVERRIDES", `job ${job.name} declares no timeout`);
    if (job.kind === "cron") {
      const expr = x.cron ?? job.cron ?? "";
      try {
        e.schedule = parseSchedule(expr);
      } catch (err) {
        throw new ConfigError("CONFIG_INVALID", "JOBS_OVERRIDES", `job ${job.name}: ${(err as Error).message}`);
      }
    } else if (!(e.intervalMs > 0)) throw new ConfigError("CONFIG_INVALID", "JOBS_OVERRIDES", `job ${job.name} declares no interval`);
    return e;
  }

  /** Starts every enabled piece of work under the supervisor. */
  start(sup: Supervisor): void {
    for (const e of this.jobs.values()) {
      if (!e.enabled) continue;
      const loop = e.job.kind === "every" ? runEvery : e.job.kind === "singleton" ? runSingleton : runCron;
      sup.run(e.job.name, (signal) => loop(this.d, e, signal));
    }
    for (const w of this.workers.values()) if (this.o.overrides[w.kind]?.enabled !== false) sup.run(`queue:${w.kind}`, (signal) => runWorker(this.d, w, signal));
    for (const x of this.reconcilers.values()) if (x.enabled) sup.run(`reconcile:${x.r.name}`, (signal) => runReconciler(this.d, x.r, x.everyMs, signal));
    if (this.workers.size > 0) sup.run("be.queue.stats", (signal) => this.queueStats(signal));
  }

  /** `job run <name>` (P14.8): one run of a job, a queue kind or a reconciler, whatever `enabled` says. */
  async runOnce(name: string, signal: AbortSignal = new AbortController().signal): Promise<RunOnceResult> {
    const e = this.jobs.get(name);
    if (e) return runScheduledOnce(this.d, e, signal);
    const w = this.workers.get(name);
    if (w) return drainOnce(this.d, w, signal);
    const r = this.reconcilers.get(name);
    if (r) return reconcileOnce(this.d, r.r, signal);
    return { result: "unknown", why: `no job, queue kind or reconciler named ${name}` };
  }

  private track(job: string, result: string, error: string): void {
    const name = job.replace(/^(queue|reconcile):/, "");
    const o = this.outcomes.get(name) ?? { lastSuccessAt: null, lastError: "", lastErrorAt: null };
    const now = new Date().toISOString();
    if (result === "ok") o.lastSuccessAt = now;
    else Object.assign(o, { lastError: error, lastErrorAt: now });
    this.outcomes.set(name, o);
  }

  /** The body of GET /{d}/{n}/_ops/jobs (P14.4, openapi/ops.yaml). */
  async ops(): Promise<{ jobs: Record<string, unknown>[]; queues: Record<string, unknown>[] }> {
    const jobs = this.describe().map((j) => {
      const o = this.outcomes.get(j.name);
      return { ...j, last_success_at: o?.lastSuccessAt ?? null, last_error: o?.lastError ?? "", last_error_at: o?.lastErrorAt ?? null };
    });
    const rows = await this.o.store.tx((tx) => tx.query<{ kind: string; state: string; n: number; oldest: number }>(QUEUE_STATS));
    const queues = [...this.workers.keys()].map((kind) => {
      const of = (state: string) => rows.find((r) => r.kind === kind && r.state === state);
      return { kind, ready: of("ready")?.n ?? 0, running: of("running")?.n ?? 0, dead: of("dead")?.n ?? 0, oldest_age_seconds: of("ready")?.oldest ?? 0 };
    });
    return { jobs, queues };
  }

  /** What GET /{d}/{n}/_ops/jobs lists (P14.4). */
  describe(): { name: string; kind: string; interval?: string; cron?: string; enabled: boolean }[] {
    const out: { name: string; kind: string; interval?: string; cron?: string; enabled: boolean }[] = [];
    for (const e of this.jobs.values()) out.push({ name: e.job.name, kind: e.job.kind, enabled: e.enabled, ...(e.job.kind === "cron" ? { cron: this.o.overrides[e.job.name]?.cron ?? e.job.cron } : { interval: `${e.intervalMs}ms` }) });
    for (const w of this.workers.values()) out.push({ name: w.kind, kind: "queue", enabled: this.o.overrides[w.kind]?.enabled !== false });
    for (const x of this.reconcilers.values()) out.push({ name: x.r.name, kind: "reconciler", interval: `${x.everyMs}ms`, enabled: x.enabled });
    return out;
  }

  private async queueStats(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const rows = await this.o.store.tx((tx) => tx.query<{ kind: string; state: string; n: number; oldest: number }>(QUEUE_STATS)).catch(() => []);
      for (const k of this.workers.keys()) for (const st of ["ready", "running", "dead"]) this.o.metrics.be.queueDepth.set({ kind: k, state: st }, 0);
      for (const r of rows) {
        this.o.metrics.be.queueDepth.set({ kind: r.kind, state: r.state }, r.n);
        if (r.state === "ready") this.o.metrics.be.queueOldestAge.set({ kind: r.kind }, r.oldest);
      }
      await sleep(STATS_EVERY_MS, signal);
    }
  }

  /** Nothing to close: leases are released by their loops when the supervisor stops them. */
  async stop(): Promise<void> {}
}

function durationMs(name: string, v: string): number {
  try {
    return nsToMs(parseDurationNs("JOBS_OVERRIDES", v));
  } catch {
    throw new ConfigError("CONFIG_INVALID", "JOBS_OVERRIDES", `job ${name}: not a duration: ${v}`);
  }
}

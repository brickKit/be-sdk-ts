// The `queue` kind (P14): rows inserted in the business transaction, claimed after commit with SKIP LOCKED,
// run outside any transaction, retried with backoff, `dead` past maxAttempts with the dead handler in a
// transaction. A `running` row past its lease is claimable again (a crashed worker's job runs again).
import { context, propagation } from "@opentelemetry/api";
import { currentUnit } from "../context.js";
import { platformError } from "../errors/beError.js";
import { deriveCausation } from "../events/causation.js";
import { newId } from "../ids.js";
import type { Store } from "../store/store.js";
import type { EnqueueOptions, Tx } from "../store/tx.js";
import { sleep } from "../util/sleep.js";
import { measuredRun, type RunDeps } from "./run.js";
import { QUEUE_CLAIM, QUEUE_DEAD, QUEUE_DONE, QUEUE_INSERT, QUEUE_RETRY } from "./sql.js";
import type { QueuedJob, RunOnceResult, Worker } from "./types.js";

export const DEFAULT_MAX_ATTEMPTS = 8;
export const DEFAULT_BACKOFF_MS = [1_000, 10_000, 60_000, 300_000, 900_000];
const LEASE_MARGIN_MS = 5_000;

export interface QueueDeps extends RunDeps {
  store: Store;
  pollMs: number;
}

/** tx.enqueue: one row in the caller's transaction; a live row with the same unique key makes it a no-op. */
export async function enqueue(workers: ReadonlyMap<string, Worker>, tx: Tx, kind: string, args: unknown, o: EnqueueOptions): Promise<void> {
  const w = workers.get(kind);
  if (!w) throw platformError("INTERNAL", undefined, `no worker of kind ${kind} is declared in this member's Module.workers`);
  const u = currentUnit();
  const c = u?.handling ? deriveCausation({ kind: "event", handled: u.handling }) : u?.queued ? deriveCausation({ kind: "queued_job", job: u.queued }) : { causationId: "", hopCount: 0 };
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  await tx.query(QUEUE_INSERT, [newId(), kind, JSON.stringify(args ?? null), o.uniqueKey ?? null, o.runAt ?? null, w.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, carrier.traceparent ?? "", c.causationId, c.hopCount]);
}

interface Claimed {
  id: string;
  kind: string;
  args: unknown;
  attempts: number;
  max_attempts: number;
  unique_key: string | null;
  causation_id: string;
  hop_count: number;
}

async function claim(d: QueueDeps, w: Worker, limit: number): Promise<Claimed[]> {
  return d.store.tx((tx) => tx.query<Claimed>(QUEUE_CLAIM, [w.kind, limit, w.timeoutMs + LEASE_MARGIN_MS]));
}

/** Runs one claimed row and records the outcome. */
async function execute(d: QueueDeps, w: Worker, row: Claimed, outer: AbortSignal): Promise<boolean> {
  const job: QueuedJob = { id: row.id, kind: row.kind, args: row.args, attempts: row.attempts, uniqueKey: row.unique_key };
  let failure: unknown;
  const result = await measuredRun(d, `queue:${w.kind}`, w.timeoutMs, outer, async (signal) => {
    const u = currentUnit();
    if (u) u.queued = { causationId: row.causation_id, hopCount: row.hop_count };
    try {
      await w.run(job, signal);
    } catch (e) {
      failure = e;
      throw e;
    }
  });
  if (result === "ok") {
    await d.store.tx((tx) => tx.query(QUEUE_DONE, [row.id]));
    return true;
  }
  const why = String((failure as Error)?.message ?? result).slice(0, 2_000);
  if (row.attempts >= row.max_attempts) {
    await d.store.tx(async (tx) => {
      const dead = await tx.query(QUEUE_DEAD, [row.id, why]);
      if (dead.length > 0 && w.onDead) await w.onDead(tx, job);
    });
  } else {
    const backoff = w.backoffMs ?? DEFAULT_BACKOFF_MS;
    await d.store.tx((tx) => tx.query(QUEUE_RETRY, [row.id, why, backoff[Math.min(row.attempts, backoff.length) - 1] ?? 1_000]));
  }
  return false;
}

/** The worker loop of one kind: up to `concurrency` jobs at once in this process. */
export async function runWorker(d: QueueDeps, w: Worker, signal: AbortSignal): Promise<void> {
  const max = Math.max(1, w.concurrency ?? 1);
  const inflight = new Set<Promise<unknown>>();
  while (!signal.aborted) {
    const free = max - inflight.size;
    const rows = free > 0 ? await claim(d, w, free) : [];
    for (const r of rows) {
      const p = execute(d, w, r, signal).catch((e) => d.logger.error({ kind: w.kind, error: String(e) }, "queue_record_failed")).finally(() => inflight.delete(p));
      inflight.add(p);
    }
    if (rows.length === 0 || inflight.size >= max) await Promise.race([sleep(d.pollMs, signal), ...inflight]);
  }
  await Promise.allSettled([...inflight]);
}

/** `job run <kind>`: the ready rows of the kind, once, within the worker's timeout (P14.8). */
export async function drainOnce(d: QueueDeps, w: Worker, signal: AbortSignal): Promise<RunOnceResult> {
  const end = AbortSignal.any([signal, AbortSignal.timeout(w.timeoutMs)]);
  let ok = 0;
  let failed = 0;
  while (!end.aborted) {
    const rows = await claim(d, w, Math.max(1, w.concurrency ?? 1));
    if (rows.length === 0) break;
    for (const good of await Promise.all(rows.map((r) => execute(d, w, r, end)))) good ? ok++ : failed++;
  }
  if (failed > 0) return { result: "failed", why: `${failed} of ${ok + failed} jobs failed` };
  return ok === 0 ? { result: "noop", why: "no ready jobs" } : { result: "ok" };
}

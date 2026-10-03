// The `reconciler` kind (P14): candidates from the component's own SQL (non-terminal and past deadline), each
// claimed with a lease in besdk_reconcile, handled outside any transaction, the outcome applied in a short
// transaction; a failure backs off; past maxAttempts the item is given up (suspend + exception task). Reaching a
// settled state deletes the item's row.
import { errorFields } from "../log/logger.js";
import type { Store } from "../store/store.js";
import { sleep } from "../util/sleep.js";
import { measuredRun, type RunDeps } from "./run.js";
import { RECONCILE_CLAIM, RECONCILE_DONE, RECONCILE_FAILED, RECONCILE_NEXT, RECONCILE_STATS } from "./sql.js";
import type { Reconciler, RunOnceResult } from "./types.js";

export const DEFAULT_RECONCILE_BACKOFF_MS = [10_000, 60_000, 300_000, 900_000, 3_600_000];
const LEASE_MARGIN_MS = 5_000;

export interface ReconcileDeps extends RunDeps {
  store: Store;
}

type ItemResult = "settled" | "retry" | "gave_up" | "skipped";

async function backoff<T>(d: ReconcileDeps, r: Reconciler<T>, item: T, id: string, why: string): Promise<ItemResult> {
  const delays = r.backoffMs ?? DEFAULT_RECONCILE_BACKOFF_MS;
  return d.store.tx(async (tx) => {
    const [row] = await tx.query<{ attempts: number }>(RECONCILE_FAILED, [r.name, id, why.slice(0, 2_000)]);
    const attempts = row?.attempts ?? 1;
    if (attempts >= (r.maxAttempts ?? 10)) {
      await r.giveUp(tx, item);
      await tx.query(RECONCILE_DONE, [r.name, id]);
      d.metrics.be.reconcileGiveups.inc({ name: r.name });
      d.logger.warn({ reconciler: r.name, item: id, attempts, error: why }, "reconcile_gave_up");
      return "gave_up";
    }
    await tx.query(RECONCILE_NEXT, [r.name, id, delays[Math.min(attempts, delays.length) - 1] ?? 1_000]);
    return "retry";
  });
}

async function one<T>(d: ReconcileDeps, r: Reconciler<T>, item: T, signal: AbortSignal): Promise<ItemResult> {
  const id = r.id(item);
  const claimed = await d.store.tx((tx) => tx.query(RECONCILE_CLAIM, [r.name, id, r.timeoutMs + LEASE_MARGIN_MS]));
  if (claimed.length === 0) return "skipped";
  let outcome: unknown;
  let failure: unknown;
  const result = await measuredRun(d, `reconcile:${r.name}`, r.timeoutMs, signal, async (s) => {
    try {
      outcome = await r.handle(item, s);
    } catch (e) {
      failure = e;
      throw e;
    }
  });
  if (result !== "ok") return backoff(d, r, item, id, String((failure as Error)?.message ?? result));
  const settled = await d.store.tx(async (tx) => {
    const done = (await r.apply(tx, item, outcome)) !== false;
    if (done) await tx.query(RECONCILE_DONE, [r.name, id]);
    return done;
  });
  return settled ? "settled" : backoff(d, r, item, id, "not settled yet");
}

/** One pass over the current candidates; returns how many items were handled. */
export async function reconcilePass<T>(d: ReconcileDeps, r: Reconciler<T>, signal: AbortSignal): Promise<{ handled: number; failed: number }> {
  const items = await d.store.tx((tx) => r.candidates(tx, r.batch ?? 50));
  let handled = 0;
  let failed = 0;
  for (const item of items) {
    if (signal.aborted) break;
    const res = await one(d, r, item, signal).catch((e) => (d.logger.error({ reconciler: r.name, ...errorFields(e) }, "reconcile_failed"), "retry" as const));
    if (res !== "skipped") handled++;
    if (res === "retry" || res === "gave_up") failed++;
  }
  await stats(d, r.name);
  return { handled, failed };
}

async function stats(d: ReconcileDeps, name: string): Promise<void> {
  const [s] = await d.store.tx((tx) => tx.query<{ n: number; oldest: number }>(RECONCILE_STATS, [name])).catch(() => []);
  if (!s) return;
  d.metrics.be.reconcilePending.set({ name }, s.n);
  d.metrics.be.reconcileOldestAge.set({ name }, s.oldest);
}

export async function runReconciler<T>(d: ReconcileDeps, r: Reconciler<T>, everyMs: number, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    await reconcilePass(d, r, signal).catch((e) => d.logger.error({ reconciler: r.name, ...errorFields(e) }, "reconcile_pass_failed"));
    await sleep(everyMs, signal);
  }
}

export async function reconcileOnce<T>(d: ReconcileDeps, r: Reconciler<T>, signal: AbortSignal): Promise<RunOnceResult> {
  const { handled, failed } = await reconcilePass(d, r, signal);
  if (failed > 0) return { result: "failed", why: `${failed} of ${handled} items not settled` };
  return handled === 0 ? { result: "noop", why: "no candidates" } : { result: "ok" };
}

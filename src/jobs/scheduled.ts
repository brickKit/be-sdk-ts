// The three scheduled kinds (P14 "The five kinds"): `every` on each replica's timer, `singleton` under a lease
// (TTL, renewed every TTL/3, a lost lease cancels the run, epoch as fencing token), `cron` by claiming each slot
// with INSERT … ON CONFLICT DO NOTHING (no leader; after downtime only the most recent missed slot runs).
import type { Store } from "../store/store.js";
import { sleep } from "../util/sleep.js";
import { measuredRun, type RunDeps, type RunResult } from "./run.js";
import { nextSlotAfter, slotAtOrBefore, type Schedule } from "./schedule.js";
import { LEASE_RELEASE, LEASE_RENEW, LEASE_ROW, LEASE_TAKE, SLOT_CLAIM, SLOT_DONE } from "./sql.js";
import type { Job, RunOnceResult } from "./types.js";

export interface ScheduledDeps extends RunDeps {
  store: Store;
  holder: string;
  leaseTtlMs: number;
}

/** A job with its effective schedule (JOBS_OVERRIDES applied). */
export interface Effective {
  job: Job;
  intervalMs: number;
  schedule?: Schedule;
  zone: string;
  enabled: boolean;
}

export async function runEvery(d: ScheduledDeps, e: Effective, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    await sleep(e.intervalMs, signal);
    if (signal.aborted) return;
    await measuredRun(d, e.job.name, e.job.timeoutMs, signal, (s) => e.job.run(s, {}));
  }
}

class Lease {
  private timer: NodeJS.Timeout | undefined;
  readonly lost = new AbortController();
  private readonly d: ScheduledDeps;
  private readonly name: string;
  readonly epoch: number;

  constructor(d: ScheduledDeps, name: string, epoch: number) {
    this.d = d;
    this.name = name;
    this.epoch = epoch;
  }

  static async take(d: ScheduledDeps, name: string): Promise<Lease | undefined> {
    const rows = await d.store.tx(async (tx) => {
      await tx.query(LEASE_ROW, [name]);
      return tx.query<{ epoch: string }>(LEASE_TAKE, [name, d.holder, d.leaseTtlMs]);
    });
    if (rows.length === 0) return undefined;
    const l = new Lease(d, name, Number(rows[0]!.epoch));
    l.timer = setInterval(() => void l.renew(), Math.max(10, Math.floor(d.leaseTtlMs / 3)));
    return l;
  }

  private async renew(): Promise<void> {
    const ok = await this.d.store.tx((tx) => tx.query(LEASE_RENEW, [this.name, this.d.holder, this.d.leaseTtlMs, this.epoch])).then((r) => r.length > 0, () => false);
    if (!ok) {
      this.d.logger.warn({ job: this.name, epoch: this.epoch }, "job_lease_lost");
      this.end();
      this.lost.abort(new Error("the lease was lost"));
    }
  }

  end(): void {
    clearInterval(this.timer);
  }

  async release(): Promise<void> {
    this.end();
    await this.d.store.tx((tx) => tx.query(LEASE_RELEASE, [this.name, this.d.holder])).catch(() => undefined);
  }
}

export async function runSingleton(d: ScheduledDeps, e: Effective, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    const lease = await Lease.take(d, e.job.name);
    if (!lease) {
      await sleep(Math.max(10, Math.floor(d.leaseTtlMs / 3)), signal);
      continue;
    }
    const held = AbortSignal.any([signal, lease.lost.signal]);
    try {
      while (!held.aborted) {
        await measuredRun(d, e.job.name, e.job.timeoutMs, held, (s) => e.job.run(s, { epoch: lease.epoch }));
        await sleep(e.intervalMs, held);
      }
    } finally {
      if (lease.lost.signal.aborted) lease.end();
      else await lease.release();
    }
  }
}

async function claimSlot(d: ScheduledDeps, name: string, slot: Date): Promise<boolean> {
  const rows = await d.store.tx((tx) => tx.query(SLOT_CLAIM, [name, slot, d.holder]));
  return rows.length > 0;
}

async function runSlot(d: ScheduledDeps, e: Effective, slot: Date, signal: AbortSignal): Promise<RunResult> {
  const result = await measuredRun(d, e.job.name, e.job.timeoutMs, signal, (s) => e.job.run(s, { slotAt: slot }));
  await d.store.tx((tx) => tx.query(SLOT_DONE, [e.job.name, slot, result])).catch(() => undefined);
  return result;
}

export async function runCron(d: ScheduledDeps, e: Effective, signal: AbortSignal): Promise<void> {
  let slot = slotAtOrBefore(e.schedule!, new Date(), e.zone);
  while (!signal.aborted) {
    if (await claimSlot(d, e.job.name, slot)) await runSlot(d, e, slot, signal);
    const next = nextSlotAfter(e.schedule!, slot, e.zone);
    await sleep(Math.max(0, next.getTime() - Date.now()), signal);
    slot = slotAtOrBefore(e.schedule!, new Date(Math.max(Date.now(), next.getTime())), e.zone); // overslept: only the latest
  }
}

/** `job run` for a scheduled job (P14.8). */
export async function runScheduledOnce(d: ScheduledDeps, e: Effective, signal: AbortSignal): Promise<RunOnceResult> {
  const verdict = (r: RunResult): RunOnceResult => (r === "ok" ? { result: "ok" } : { result: "failed", why: r });
  if (e.job.kind === "every") return verdict(await measuredRun(d, e.job.name, e.job.timeoutMs, signal, (s) => e.job.run(s, {})));
  if (e.job.kind === "cron") {
    const slot = slotAtOrBefore(e.schedule!, new Date(), e.zone);
    if (!(await claimSlot(d, e.job.name, slot))) return { result: "noop", why: `slot ${slot.toISOString()} already claimed` };
    return verdict(await runSlot(d, e, slot, signal));
  }
  const lease = await Lease.take(d, e.job.name);
  if (!lease) return { result: "noop", why: "the lease is held elsewhere" };
  try {
    return verdict(await measuredRun(d, e.job.name, e.job.timeoutMs, AbortSignal.any([signal, lease.lost.signal]), (s) => e.job.run(s, { epoch: lease.epoch })));
  } finally {
    await lease.release();
  }
}

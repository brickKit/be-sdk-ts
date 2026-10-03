// Every piece of background work runs supervised (P1.7): a failure, a rejection or an unexpected return is
// logged and the task restarts after 1 s doubling to 5 min; one task stopping never stops another.
import type { Logger } from "pino";
import { errorFields } from "../log/logger.js";
import { sleep } from "../util/sleep.js";

export type Task = (signal: AbortSignal) => Promise<void>;

export class Supervisor {
  private readonly logger: Logger;
  private readonly ac = new AbortController();
  private readonly running = new Set<Promise<void>>();
  private readonly initial: number;
  private readonly max: number;

  constructor(logger: Logger, o: { initialBackoffMs?: number; maxBackoffMs?: number } = {}) {
    this.logger = logger;
    this.initial = o.initialBackoffMs ?? 1_000;
    this.max = o.maxBackoffMs ?? 300_000;
  }

  get signal(): AbortSignal {
    return this.ac.signal;
  }

  run(name: string, task: Task): void {
    const p = this.loop(name, task).finally(() => this.running.delete(p));
    this.running.add(p);
  }

  private async loop(name: string, task: Task): Promise<void> {
    let backoff = this.initial;
    while (!this.ac.signal.aborted) {
      const started = Date.now();
      try {
        await task(this.ac.signal);
        if (this.ac.signal.aborted) return;
        this.logger.warn({ task: name }, "background task returned; restarting");
      } catch (e) {
        if (this.ac.signal.aborted) return;
        this.logger.error({ task: name, ...errorFields(e) }, "background task failed; restarting");
      }
      if (Date.now() - started > this.max) backoff = this.initial; // it ran a long time: start the backoff over
      await sleep(backoff, this.ac.signal);
      backoff = Math.min(backoff * 2, this.max);
    }
  }

  /** Cancels every task and waits up to `graceMs` for them to return. */
  async stop(graceMs: number): Promise<void> {
    this.ac.abort();
    await Promise.race([Promise.allSettled([...this.running]), sleep(graceMs)]);
  }
}

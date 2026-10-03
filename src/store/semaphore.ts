// A counting semaphore with bounded, FIFO waits: one member's connection budget (P10.5). Standalone it
// mirrors the pool size; in a shell it keeps a member inside its own PG_POOL_MAX on the shared pool, so one
// member exhausting its budget never starves another.

export class SemaphoreTimeout extends Error {
  constructor() {
    super("no permit became free in time");
    this.name = "SemaphoreTimeout";
  }
}

interface Waiter {
  grant: () => void;
}

export class Semaphore {
  readonly max: number;
  private used = 0;
  private readonly queue: Waiter[] = [];

  constructor(max: number) {
    if (!Number.isInteger(max) || max < 1) throw new Error(`semaphore size must be a positive integer, got ${max}`);
    this.max = max;
  }

  get inUse(): number {
    return this.used;
  }

  get waiting(): number {
    return this.queue.length;
  }

  /** Waits at most `waitMs` for a permit; resolves with its (idempotent) release function. */
  acquire(waitMs: number, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(abortError());
    if (this.used < this.max && this.queue.length === 0) return Promise.resolve(this.take());
    if (waitMs <= 0) return Promise.reject(new SemaphoreTimeout());
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { grant: () => (cleanup(), resolve(this.take())) };
      const drop = (err: Error) => {
        const i = this.queue.indexOf(waiter);
        if (i >= 0) this.queue.splice(i, 1);
        cleanup();
        reject(err);
      };
      const onAbort = () => drop(abortError());
      const timer = setTimeout(() => drop(new SemaphoreTimeout()), waitMs);
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.queue.push(waiter);
    });
  }

  private take(): () => void {
    this.used++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.used--;
      this.queue.shift()?.grant();
    };
  }
}

function abortError(): Error {
  return Object.assign(new Error("the wait was aborted"), { name: "AbortError" });
}

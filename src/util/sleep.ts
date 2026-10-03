/** Resolves after `ms`, at once when `signal` aborts, or when `wake` is called (returns true when woken). */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** A sleeper another party can cut short (a poke). */
export class Wakeable {
  private wake: (() => void) | undefined;
  private pending = false;

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (this.pending) {
      this.pending = false;
      return Promise.resolve();
    }
    const ac = new AbortController();
    this.wake = () => ac.abort();
    const onAbort = () => ac.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    return sleep(ms, ac.signal).finally(() => {
      signal?.removeEventListener("abort", onAbort);
      this.wake = undefined;
    });
  }

  poke(): void {
    if (this.wake) this.wake();
    else this.pending = true;
  }
}

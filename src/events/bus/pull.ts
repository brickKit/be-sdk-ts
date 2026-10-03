// The pull loop of one durable (P12.9, P1.6): bounded pull requests for the free handler slots only, and none
// left behind at stop. A pull request stays registered at the server until it expires; a message handed to a
// request nobody reads is redelivered only after ack_wait. So once the loop stops it sends no new request, lets
// the running one end, and naks at once whatever that one still brings.
import type { Logger } from "pino";
import { errorFields } from "../../log/logger.js";

/** Bounds one pull request; it is also the longest the loop keeps running after its signal aborts. */
export const FETCH_WAIT_MS = 1_000;
/** The pause after a failed pull request while the bus or the durable is unavailable. */
export const RETRY_DELAY_MS = 1_000;

export interface Pulled {
  nak(delayMs?: number): void;
}

export interface PullSource<M extends Pulled> {
  /** One pull request for at most `max` messages that ends by itself after `expiresMs`. */
  fetch(max: number, expiresMs: number): Promise<AsyncIterable<M>>;
  /** Called after a failed pull request: drop a handle that may be stale (a deleted durable). */
  forget?(): void;
}

export interface PullOptions {
  concurrency: number;
  signal: AbortSignal;
  logger: Logger;
  retryDelayMs?: number;
}

/**
 * Pulls until `signal` aborts and runs `handle` on each message, at most `concurrency` at once; returns once
 * the last pull request has ended and every handler it started has returned. A failed pull request is logged
 * once and retried after a pause; a handler that throws is logged and its delivery left for redelivery.
 */
export async function pullLoop<M extends Pulled>(src: PullSource<M>, handle: (m: M) => Promise<void>, o: PullOptions): Promise<void> {
  const { concurrency, signal, logger } = o;
  const aborted = new Promise<void>((r) => (signal.aborted ? r() : signal.addEventListener("abort", () => r(), { once: true })));
  const inflight = new Set<Promise<void>>();
  let failing = false;
  try {
    while (!signal.aborted) {
      if (inflight.size >= concurrency) {
        await Promise.race([...inflight, aborted]);
        continue;
      }
      try {
        // not interrupted on abort: the request must end before the loop does
        for await (const m of await src.fetch(concurrency - inflight.size, FETCH_WAIT_MS)) {
          if (signal.aborted) {
            m.nak();
            continue;
          }
          const p = handle(m)
            .catch((e) => logger.error(errorFields(e), "consumer_handler_crashed"))
            .finally(() => inflight.delete(p));
          inflight.add(p);
        }
        if (failing) logger.info("consumer_fetch_resumed");
        failing = false;
      } catch (e) {
        if (!failing) logger.warn(errorFields(e), "consumer_fetch_failed");
        failing = true;
        src.forget?.();
        await Promise.race([new Promise((r) => setTimeout(r, o.retryDelayMs ?? RETRY_DELAY_MS).unref()), aborted]);
      }
    }
  } finally {
    await Promise.allSettled([...inflight]);
  }
}

// The authz poke (P12.10, P6.1, P6.12): a best-effort core-NATS subscription on infra.authz.changed.v1. Each
// member subscribes on its own connection (a shell's members never share one); a poke wakes the bundle poll and
// the projection pull at once. Nothing is stored or redelivered: a lost poke only delays the next poll.
import { connect, type NatsConnection } from "@nats-io/transport-node";
import type { Logger } from "pino";
import { errorFields } from "../log/logger.js";

export const POKE_SUBJECT = "infra.authz.changed.v1";

/** The poke's payload: `revision` (a decimal string) and whether the bundle changed; `{}` when it does not parse. */
export interface Poke {
  revision?: string;
  bundle?: boolean;
}

export interface PokeSubscriberOptions {
  /** nats://… — the bus of EVENT_BUS_URL / NATS_URL */
  url: string;
  /** the connection's name: the member's component ID */
  name: string;
  logger: Logger;
}

export class PokeSubscriber {
  private readonly o: PokeSubscriberOptions;
  private readonly listeners: ((p: Poke) => void)[] = [];
  private readonly waiting: (() => void)[] = [];
  private isSubscribed = false;

  constructor(o: PokeSubscriberOptions) {
    this.o = o;
  }

  on(listener: (p: Poke) => void): void {
    this.listeners.push(listener);
  }

  /** Resolves once the subscription is registered with the server. */
  subscribed(): Promise<void> {
    return this.isSubscribed ? Promise.resolve() : new Promise((r) => this.waiting.push(r));
  }

  /** Connects (reconnecting forever), subscribes, and returns when `signal` aborts. Run it under the supervisor. */
  async run(signal: AbortSignal): Promise<void> {
    const nc = await connect({ servers: this.o.url, name: this.o.name, maxReconnectAttempts: -1, reconnectTimeWait: 2_000, reconnectJitter: 500, waitOnFirstConnect: true });
    try {
      const sub = nc.subscribe(POKE_SUBJECT, { callback: (err, m) => (err ? this.o.logger.warn(errorFields(err), "authz_poke_error") : this.deliver(m.data)) });
      await nc.flush();
      this.isSubscribed = true;
      for (const w of this.waiting.splice(0)) w();
      await untilAborted(signal, nc);
      sub.unsubscribe();
    } finally {
      await nc.close().catch(() => undefined);
    }
  }

  private deliver(data: Uint8Array): void {
    const p = parsePoke(data);
    this.o.logger.debug({ revision: p.revision }, "authz_poke");
    for (const l of this.listeners) l(p);
  }
}

function parsePoke(data: Uint8Array): Poke {
  try {
    const v = JSON.parse(new TextDecoder().decode(data)) as Record<string, unknown>;
    const p: Poke = {};
    if (typeof v.revision === "string" || typeof v.revision === "number") p.revision = String(v.revision);
    if (typeof v.bundle === "boolean") p.bundle = v.bundle;
    return p;
  } catch {
    return {};
  }
}

function untilAborted(signal: AbortSignal, nc: NatsConnection): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
    void nc.closed().then(() => resolve());
  });
}

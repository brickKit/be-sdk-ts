// The JetStream bus adapter (P12.4, P12.5, P12.13; r1-07): streams and durables are created when absent and
// never changed; publish waits for the PubAck; pull consumers with the protocol constants (ack_wait 30 s,
// max_ack_pending 256, max_deliver −1, no server backoff, DeliverAll) — redelivery delays and the delivery limit
// are the runtime's job (P12.7).
import { connect, headers as natsHeaders, nanos, type NatsConnection } from "@nats-io/transport-node";
import {
  AckPolicy, DeliverPolicy, DiscardPolicy, jetstream, jetstreamManager, StorageType,
  type ConsumerConfig, type JetStreamClient, type JetStreamManager, type JsMsg,
} from "@nats-io/jetstream";
import type { Logger } from "pino";
import { errorFields } from "../../log/logger.js";
import { DLQ_STREAM, streamFor } from "../names.js";

const DAY_MS = 24 * 3600 * 1000;
export const ACK_WAIT_MS = 30_000;

export interface Delivery {
  headers: Record<string, string>;
  data: Uint8Array;
  /** the broker's delivery count, 1-based */
  deliveryCount: number;
  streamSeq: number;
  ack(): void;
  nak(delayMs: number): void;
  term(reason: string): void;
  working(): void;
}

export interface BusOptions {
  url: string;
  /** the connection's name: the member's component ID (P12.13) */
  name: string;
  logger: Logger;
}

/** The durable's protocol constants (P12.5). */
export function durableConfig(durable: string, subject: string): Partial<ConsumerConfig> {
  return {
    durable_name: durable,
    filter_subject: subject,
    ack_policy: AckPolicy.Explicit,
    deliver_policy: DeliverPolicy.All,
    ack_wait: nanos(ACK_WAIT_MS),
    max_ack_pending: 256,
    max_deliver: -1,
    inactive_threshold: nanos(30 * DAY_MS),
  };
}

export class JetStreamBus {
  readonly connection: NatsConnection;
  private readonly js: JetStreamClient;
  private jsmP: Promise<JetStreamManager> | undefined;
  private readonly logger: Logger;
  private readonly streams = new Set<string>();

  private constructor(nc: NatsConnection, logger: Logger) {
    this.connection = nc;
    this.js = jetstream(nc);
    this.logger = logger;
  }

  /** Reconnects forever, every 2 s with jitter, and keeps trying when the bus is not up at start. */
  static async connect(o: BusOptions): Promise<JetStreamBus> {
    const nc = await connect({ servers: o.url, name: o.name, maxReconnectAttempts: -1, reconnectTimeWait: 2_000, reconnectJitter: 500, waitOnFirstConnect: true });
    const bus = new JetStreamBus(nc, o.logger);
    void bus.watchStatus();
    return bus;
  }

  private async watchStatus(): Promise<void> {
    for await (const s of this.connection.status()) {
      if (s.type === "disconnect" || s.type === "reconnect" || s.type === "error") this.logger.warn({ status: s.type }, "bus_status");
    }
  }

  private jsm(): Promise<JetStreamManager> {
    this.jsmP ??= jetstreamManager(this.connection);
    return this.jsmP;
  }

  /** "Create if missing, never change if present" for the subject's stream and BE_DLQ (P12.4). */
  async ensureStream(subject: string): Promise<void> {
    const { stream, filter } = streamFor(subject);
    await this.ensureNamedStream(stream, filter, 7 * DAY_MS);
    await this.ensureNamedStream(DLQ_STREAM, "dlq.>", 30 * DAY_MS);
  }

  private async ensureNamedStream(name: string, filter: string, maxAgeMs: number): Promise<void> {
    if (this.streams.has(name)) return;
    const jsm = await this.jsm();
    const exists = await jsm.streams.info(name).then(() => true, (e) => (isNotFound(e) ? false : Promise.reject(e)));
    if (!exists) {
      await jsm.streams
        .add({ name, subjects: [filter], max_age: nanos(maxAgeMs), max_bytes: 2 ** 30, discard: DiscardPolicy.Old, duplicate_window: nanos(600_000), storage: StorageType.File, num_replicas: 1 })
        .catch((e) => (isAlreadyExists(e) ? undefined : Promise.reject(e)));
    }
    this.streams.add(name);
  }

  /** Creates the durable when absent; an existing one is never updated, a drift from the constants is a WARN. */
  async ensureDurable(durable: string, subject: string): Promise<{ created: boolean; drift: string[] }> {
    const { stream } = streamFor(subject);
    const jsm = await this.jsm();
    const want = durableConfig(durable, subject);
    const info = await jsm.consumers.info(stream, durable).catch((e) => (isNotFound(e) ? undefined : Promise.reject(e)));
    if (!info) {
      try {
        await jsm.consumers.add(stream, want);
        return { created: true, drift: [] };
      } catch (e) {
        if (!isAlreadyExists(e)) throw e; // another replica created it first
      }
    }
    const have = (info ?? (await jsm.consumers.info(stream, durable))).config as unknown as Record<string, unknown>;
    const drift = Object.entries(want).filter(([k, v]) => k !== "durable_name" && JSON.stringify(have[k]) !== JSON.stringify(v)).map(([k]) => k);
    if ((have.backoff as unknown[] | undefined)?.length) drift.push("backoff");
    if (drift.length > 0) this.logger.warn({ durable, drift }, "durable_config_differs_kept");
    return { created: false, drift };
  }

  /** Publishes and waits for the stream's acknowledgement; `msgId` is the duplicate-suppression key. */
  async publish(subject: string, hdrs: Record<string, string>, data: Uint8Array, msgId: string): Promise<void> {
    const h = natsHeaders();
    for (const [k, v] of Object.entries(hdrs)) if (k !== "Nats-Msg-Id") h.set(k, v);
    await this.js.publish(subject, data, { msgID: msgId, headers: h, timeout: 5_000 });
  }

  /**
   * Pulls from the durable and hands at most `concurrency` messages at a time to `onMessage` until `signal`
   * aborts; the handler must ack, nak or term each delivery.
   */
  async consume(subject: string, durable: string, concurrency: number, onMessage: (d: Delivery) => Promise<void>, signal: AbortSignal): Promise<void> {
    const { stream } = streamFor(subject);
    const consumer = await this.js.consumers.get(stream, durable);
    const messages = await consumer.consume({ max_messages: concurrency });
    const stop = () => void messages.stop();
    signal.addEventListener("abort", stop, { once: true });
    const inflight = new Set<Promise<void>>();
    try {
      for await (const m of messages) {
        const p = onMessage(toDelivery(m))
          .catch((e) => this.logger.error(errorFields(e), "consumer_handler_crashed"))
          .finally(() => inflight.delete(p));
        inflight.add(p);
        if (inflight.size >= concurrency) await Promise.race(inflight);
        if (signal.aborted) break;
      }
    } finally {
      signal.removeEventListener("abort", stop);
      await Promise.allSettled([...inflight]);
    }
  }

  async close(): Promise<void> {
    await this.connection.drain().catch(() => this.connection.close());
  }
}

function toDelivery(m: JsMsg): Delivery {
  const headers: Record<string, string> = {};
  if (m.headers) for (const [k, v] of m.headers) headers[k] = v[0] ?? "";
  return {
    headers,
    data: m.data,
    deliveryCount: m.info.deliveryCount,
    streamSeq: m.info.streamSequence,
    ack: () => m.ack(),
    nak: (ms) => m.nak(ms),
    term: (reason) => m.term(reason),
    working: () => m.working(),
  };
}

function apiCode(e: unknown): number | undefined {
  return (e as { api_error?: { err_code?: number } })?.api_error?.err_code ?? (e as { code?: number })?.code;
}

function isNotFound(e: unknown): boolean {
  const c = apiCode(e);
  return c === 10059 || c === 10014 || /not found/i.test(String((e as Error)?.message));
}

function isAlreadyExists(e: unknown): boolean {
  const c = apiCode(e);
  return c === 10058 || c === 10148 || c === 10013 || /already (exists|in use)/i.test(String((e as Error)?.message));
}

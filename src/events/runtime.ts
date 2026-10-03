// A member's events (P12): tx.publish, the outbox pump and one consumer per subscription, all on the member's
// store and the bus named by EVENT_BUS_URL (falling back to NATS_URL). The bus is connected in the background
// (P1.2); work waits for it. Only the JetStream adapter exists in 0.6.0 (the PostgreSQL queue is planned).
import type { Tracer } from "@opentelemetry/api";
import type { NatsConnection } from "@nats-io/transport-node";
import type { Logger } from "pino";
import type { Config } from "../config/config.js";
import { platformError } from "../errors/beError.js";
import type { MemberRegistry } from "../obs/metrics.js";
import type { Supervisor } from "../runtime/supervisor.js";
import type { Store } from "../store/store.js";
import type { Tx, TxExtensions } from "../store/tx.js";
import { JetStreamBus } from "./bus/jetstream.js";
import { Consumer } from "./consumer.js";
import type { EventContracts } from "./contracts.js";
import { writeOutbox } from "./outbox.js";
import { OutboxPump } from "./pump.js";
import type { SubscriptionInfo } from "./inbound.js";
import type { EventInput, EventsDeclaration, Subscription } from "./types.js";

export interface EventsRuntimeOptions {
  memberId: string;
  version: string;
  config: Config;
  logger: Logger;
  metrics: MemberRegistry;
  tracer: Tracer;
  store: Store;
  contracts: EventContracts;
  declaration: EventsDeclaration;
}

/** What a consumer checks a message against: the subscription's declaration, else the shipped contract (stage-B ruling). */
export function subscriptionInfo(memberId: string, s: Pick<Subscription, "subject" | "aggregateType" | "transactionDocument">, c: { aggregateType: string; transactionDocument: boolean } | undefined): SubscriptionInfo {
  return {
    componentId: memberId, subject: s.subject,
    aggregateType: s.aggregateType ?? c?.aggregateType ?? "",
    transactionDocument: s.transactionDocument ?? c?.transactionDocument ?? false,
  };
}

export class EventsRuntime {
  readonly extensions: TxExtensions;
  private readonly o: EventsRuntimeOptions;
  private bus: JetStreamBus | undefined;
  private connecting: Promise<JetStreamBus> | undefined;
  private consumersStarted = 0;

  constructor(o: EventsRuntimeOptions) {
    this.o = o;
    const publishes = new Set(o.declaration.publishes ?? []);
    this.extensions = { publish: (tx: Tx, ev: unknown) => writeOutbox({ publishes, contracts: o.contracts }, tx, ev as EventInput) };
  }

  private busUrl(): string {
    const c = this.o.config;
    const url = c.orDefault("EVENT_BUS_URL", (x) => x.string("EVENT_BUS_URL"), undefined) ?? c.orDefault("NATS_URL", (x) => x.string("NATS_URL"), undefined);
    if (!url) throw platformError("CAPABILITY_UNAVAILABLE", { capability: "events" }, "neither EVENT_BUS_URL nor NATS_URL is set");
    if (!url.startsWith("nats://")) throw platformError("CAPABILITY_UNAVAILABLE", { capability: "bus_adapter" }, `no bus adapter for ${url.split(":")[0]} in be-sdk-ts 0.6.0`);
    return url;
  }

  private connect(): Promise<JetStreamBus> {
    this.connecting ??= JetStreamBus.connect({ url: this.busUrl(), name: this.o.memberId, logger: this.o.logger }).then((b) => (this.bus = b));
    return this.connecting;
  }

  /** Starts the pump and the consumers under the supervisor. */
  start(sup: Supervisor): void {
    const publishes = this.o.declaration.publishes ?? [];
    if (publishes.length > 0) {
      sup.run("be.outbox", async (signal) => {
        const bus = await this.connect();
        for (const s of publishes) await bus.ensureStream(s);
        await new OutboxPump({ ...this.o, bus }).run(signal);
      });
    }
    const maxDeliver = this.o.config.orDefault("EVENTS_MAX_DELIVER", (c) => (c.has("EVENTS_MAX_DELIVER") ? c.int("EVENTS_MAX_DELIVER") : undefined), undefined);
    const backoff = this.o.config.orDefault("EVENTS_BACKOFF", (c) => (c.has("EVENTS_BACKOFF") ? c.durations("EVENTS_BACKOFF") : undefined), undefined);
    for (const s of this.o.declaration.subscribe ?? []) {
      const c = this.o.contracts.get(s.subject);
      sup.run(`be.consume.${s.subject}`, async (signal) => {
        const bus = await this.connect();
        const consumer = new Consumer(s, {
          ...this.o, bus, maxDeliver: maxDeliver ?? s.maxDeliver ?? 8, backoffMs: backoff ?? s.backoffMs ?? [1_000, 10_000, 60_000, 300_000, 900_000, 1_800_000, 3_600_000],
          info: subscriptionInfo(this.o.memberId, s, c),
        });
        this.consumersStarted++;
        await consumer.run(signal);
      });
    }
  }

  /** True once the bus is connected and every consumer started. */
  ready(): boolean {
    return this.bus !== undefined && this.consumersStarted >= (this.o.declaration.subscribe ?? []).length;
  }

  busConnection(): NatsConnection | undefined {
    return this.bus?.connection;
  }

  async stop(): Promise<void> {
    await this.bus?.close();
  }
}

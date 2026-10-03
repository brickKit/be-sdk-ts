// One durable subscription (P12.5–P12.9): delivery limit and redelivery delays decided by the runtime, inbound
// checks, the aggregate-stream cursor in the handler's transaction, dead letters, progress every ack_wait / 3,
// the handler's deadline ack_wait − 5 s, a consumer span linked to the producer's span.
import { context, propagation, ROOT_CONTEXT, SpanKind, trace, type Link, type Tracer } from "@opentelemetry/api";
import type { Logger } from "pino";
import { runUnit, Unit } from "../context.js";
import { errorFields } from "../log/logger.js";
import type { MemberRegistry } from "../obs/metrics.js";
import type { Store } from "../store/store.js";
import type { Tx } from "../store/tx.js";
import { ACK_WAIT_MS, type Delivery, type JetStreamBus } from "./bus/jetstream.js";
import { acceptInbound, dlq, type InboundEvent, type SubscriptionInfo } from "./inbound.js";
import { durableName } from "./names.js";
import { dlqMsgId, overMaxDeliver } from "./redelivery.js";
import { PermanentError, type Subscription } from "./types.js";

const ADVANCE = `INSERT INTO besdk_event_cursor (consumer, aggregate_type, aggregate_id, version, event_id) VALUES ($1, $2, $3, $4, $5)
  ON CONFLICT (consumer, aggregate_type, aggregate_id) DO UPDATE SET version = EXCLUDED.version, event_id = EXCLUDED.event_id, seen_at = now()
  WHERE besdk_event_cursor.version < EXCLUDED.version RETURNING 1`;
const CURRENT = `SELECT version FROM besdk_event_cursor WHERE consumer = $1 AND aggregate_type = $2 AND aggregate_id = $3`;

export interface ConsumerDeps {
  memberId: string;
  store: Store;
  bus: JetStreamBus;
  logger: Logger;
  metrics: MemberRegistry;
  tracer: Tracer;
  maxDeliver: number;
  backoffMs: number[];
  /** the subscribed subject's aggregate type and transaction-document flag; unknown = taken from the message */
  info: SubscriptionInfo;
}

type Result = "applied" | "skipped" | "nak" | "dlq";

export class Consumer {
  readonly durable: string;
  private readonly s: Subscription;
  private readonly d: ConsumerDeps;

  constructor(s: Subscription, d: ConsumerDeps) {
    if (!s.apply === !s.run) throw new Error(`subscription ${s.subject}: exactly one of apply and run`);
    this.s = s;
    this.d = d;
    this.durable = durableName(d.memberId, s.subject);
  }

  async run(signal: AbortSignal): Promise<void> {
    await this.d.bus.ensureStream(this.s.subject);
    await this.d.bus.ensureDurable(this.durable, this.s.subject);
    await this.d.bus.consume(this.s.subject, this.durable, this.s.concurrency ?? 4, (m) => this.handle(m), signal);
  }

  private async handle(m: Delivery): Promise<void> {
    const result = await this.decide(m);
    this.d.metrics.be.consumerHandled.inc({ subject: this.s.subject, result });
  }

  private async decide(m: Delivery): Promise<Result> {
    if (overMaxDeliver(m.deliveryCount, this.d.maxDeliver)) return this.deadLetter(m, "MAX_DELIVER");
    const info = { ...this.d.info, aggregateType: this.d.info.aggregateType || (m.headers["ce-aggregatetype"] ?? "") };
    const a = acceptInbound(info, m.headers, new TextDecoder().decode(m.data), m.deliveryCount);
    if (a.action === "dlq") return this.deadLetter(m, a.reason);
    const ev = a.event;
    this.d.metrics.be.consumerLag.set({ subject: this.s.subject }, (Date.now() - ev.occurredAt.getTime()) / 1000);
    const beat = setInterval(() => m.working(), ACK_WAIT_MS / 3);
    try {
      const applied = await this.invoke(ev);
      m.ack();
      return applied ? "applied" : "skipped";
    } catch (e) {
      if (e instanceof PermanentError || (e as Error)?.name === "PermanentError") return this.deadLetter(m, "PERMANENT");
      const delay = this.d.backoffMs[Math.min(m.deliveryCount, this.d.backoffMs.length) - 1] ?? 1_000;
      this.d.logger.warn({ event_id: ev.id, subject: ev.subject, delivery: m.deliveryCount, ...errorFields(e) }, "event_handler_failed");
      m.nak(delay);
      return "nak";
    } finally {
      clearInterval(beat);
    }
  }

  /** Runs the handler in its own unit of work and span; true when the cursor advanced. */
  private invoke(ev: InboundEvent): Promise<boolean> {
    const producer = propagation.extract(ROOT_CONTEXT, { traceparent: ev.traceparent });
    const sc = trace.getSpanContext(producer);
    const links: Link[] = sc ? [{ context: sc }] : [];
    const span = this.d.tracer.startSpan(`consume ${ev.subject}`, { kind: SpanKind.CONSUMER, links, root: true }, ROOT_CONTEXT);
    const unit = new Unit({ memberId: this.d.memberId, deadline: Date.now() + ACK_WAIT_MS - 5_000, signal: AbortSignal.timeout(ACK_WAIT_MS - 5_000), requestId: span.spanContext().traceId });
    unit.handling = { id: ev.id, hopCount: ev.hopCount };
    const fields = { event_id: ev.id, subject: ev.subject, delivery: ev.delivery };
    return context.with(trace.setSpan(ROOT_CONTEXT, span), () =>
      runUnit(unit, async () => {
        try {
          const applied = this.s.apply ? await this.applyMode(ev) : await this.runMode(ev);
          this.d.logger.debug(fields, applied ? "event_applied" : "event_skipped");
          return applied;
        } finally {
          span.end();
        }
      }),
    );
  }

  private async applyMode(ev: InboundEvent): Promise<boolean> {
    return this.d.store.tx(async (tx) => {
      if (!(await this.advance(tx, ev))) return false;
      await this.s.apply!(tx, ev);
      return true;
    });
  }

  private async runMode(ev: InboundEvent): Promise<boolean> {
    const [cur] = await this.d.store.tx((tx) => tx.query<{ version: string }>(CURRENT, [this.s.consumer ?? "", ev.aggregateType, ev.aggregateId]));
    if (cur && BigInt(cur.version) >= ev.version) return false;
    await this.s.run!(ev);
    await this.d.store.tx((tx) => this.advance(tx, ev));
    return true;
  }

  private async advance(tx: Tx, ev: InboundEvent): Promise<boolean> {
    const rows = await tx.query(ADVANCE, [this.s.consumer ?? "", ev.aggregateType, ev.aggregateId, ev.version.toString(), ev.id]);
    return rows.length > 0;
  }

  private async deadLetter(m: Delivery, reason: string): Promise<Result> {
    const d = dlq({ componentId: this.d.memberId, subject: this.s.subject }, reason, m.deliveryCount);
    if (d.action !== "dlq") return "dlq";
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(m.headers)) if (k.startsWith("ce-") || k === "content-type" || k === "traceparent") headers[k] = v;
    Object.assign(headers, d.addedHeaders);
    try {
      await this.d.bus.publish(d.dlqSubject, headers, m.data, dlqMsgId(this.durable, m.streamSeq));
    } catch (e) {
      this.d.logger.error({ subject: this.s.subject, ...errorFields(e) }, "dlq_publish_failed");
      m.nak(this.d.backoffMs[0] ?? 1_000);
      return "nak";
    }
    m.term(reason);
    this.d.metrics.be.dlqMessages.inc({ subject: this.s.subject });
    this.d.logger.warn({ subject: this.s.subject, delivery: m.deliveryCount, reason, event_id: m.headers["ce-id"] ?? "" }, "event_dead_lettered");
    return "dlq";
  }
}

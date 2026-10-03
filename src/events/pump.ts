// The outbox pump (P12.1), the platform job `be.outbox`: claims due rows with SKIP LOCKED (DDL 02), publishes them
// outside the transaction, marks a row PUBLISHED only after the PubAck; a failure goes back to PENDING with a
// 1 s → 1 min backoff and is never dropped. Polls every 200 ms while busy, backing off to 2 s when idle.
import type { Logger } from "pino";
import { errorFields } from "../log/logger.js";
import { ensureOutboxWindow } from "../migrate/window.js";
import type { MemberRegistry } from "../obs/metrics.js";
import type { Store } from "../store/store.js";
import { sleep } from "../util/sleep.js";
import type { EventContracts } from "./contracts.js";
import { envelopeHeaders } from "./envelope.js";
import type { JetStreamBus } from "./bus/jetstream.js";
import { formatCeTime } from "./time.js";

const BATCH = 256;
const CLAIM = `UPDATE besdk_outbox SET status = 'SENDING', claimed_until = now() + interval '30 seconds', attempts = attempts + 1
 WHERE (id, created_at) IN (
   SELECT id, created_at FROM besdk_outbox
    WHERE (status = 'PENDING' AND next_attempt_at <= now()) OR (status = 'SENDING' AND claimed_until < now())
    ORDER BY created_at, id LIMIT ${BATCH} FOR UPDATE SKIP LOCKED)
 RETURNING id, created_at, subject, aggregate_type, aggregate_id, aggregate_version, occurred_at, traceparent, tracestate, causation_id, hop_count, payload::text AS payload_json, attempts`;
const DONE = `UPDATE besdk_outbox SET status = 'PUBLISHED', published_at = now(), claimed_until = NULL, last_error = '' WHERE id = ANY($1::uuid[])`;
const FAILED = `UPDATE besdk_outbox SET status = 'PENDING', claimed_until = NULL, next_attempt_at = now() + make_interval(secs => $2), last_error = $3 WHERE id = $1`;
const STATS = `SELECT count(*)::int AS pending, coalesce(extract(epoch FROM now() - min(created_at)), 0)::float8 AS oldest FROM besdk_outbox WHERE status <> 'PUBLISHED'`;

interface Row {
  id: string;
  subject: string;
  aggregate_type: string;
  aggregate_id: string;
  aggregate_version: string;
  occurred_at: Date;
  traceparent: string;
  tracestate: string;
  causation_id: string;
  hop_count: number;
  payload_json: string;
  attempts: number;
}

export interface PumpDeps {
  memberId: string;
  version: string;
  store: Store;
  bus: JetStreamBus;
  contracts: EventContracts;
  logger: Logger;
  metrics: MemberRegistry;
}

export function retryDelaySeconds(attempts: number): number {
  return Math.min(60, 2 ** Math.max(0, attempts - 1));
}

export class OutboxPump {
  private readonly d: PumpDeps;
  private windowCheckedAt = 0;
  private statsAt = 0;

  constructor(d: PumpDeps) {
    this.d = d;
  }

  async run(signal: AbortSignal): Promise<void> {
    let idle = 200;
    while (!signal.aborted) {
      await this.maintain();
      const n = await this.round();
      idle = n > 0 ? 200 : Math.min(idle * 2, 2_000);
      if (n < BATCH) await sleep(idle, signal);
    }
  }

  /** One claim-publish-mark round; returns the number of rows claimed. */
  async round(): Promise<number> {
    const rows = await this.d.store.tx((tx) => tx.query<Row>(CLAIM));
    if (rows.length === 0) return 0;
    const results = await Promise.allSettled(rows.map((r) => this.publishRow(r)));
    const ok = rows.filter((_, i) => results[i]!.status === "fulfilled").map((r) => r.id);
    if (ok.length > 0) await this.d.store.tx((tx) => tx.query(DONE, [ok]));
    for (const [i, r] of rows.entries()) {
      const res = results[i]!;
      if (res.status === "fulfilled") continue;
      const err = (res.reason as Error)?.message ?? String(res.reason);
      this.d.logger.warn({ event_id: r.id, subject: r.subject, ...errorFields(res.reason) }, "outbox_publish_failed");
      await this.d.store.tx((tx) => tx.query(FAILED, [r.id, retryDelaySeconds(r.attempts), err.slice(0, 500)]));
    }
    return rows.length;
  }

  private async publishRow(r: Row): Promise<void> {
    const contract = this.d.contracts.get(r.subject);
    const headers = envelopeHeaders(
      { componentId: this.d.memberId, version: this.d.version, eventsFile: contract?.file ?? "unknown.events.json" },
      {
        id: r.id, subject: r.subject, aggregateType: r.aggregate_type, aggregateId: r.aggregate_id, aggregateVersion: r.aggregate_version,
        occurredAt: formatCeTime(r.occurred_at.toISOString()), traceparent: r.traceparent, tracestate: r.tracestate, causationId: r.causation_id, hopCount: r.hop_count, payloadJson: r.payload_json,
      },
      { transactionDocument: false },
    );
    await this.d.bus.ensureStream(r.subject);
    await this.d.bus.publish(r.subject, headers, new TextEncoder().encode(r.payload_json), r.id);
    this.d.metrics.be.eventsPublished.inc({ subject: r.subject });
  }

  /** Hourly: keep the outbox's partition window ahead (P16.6) and export the backlog gauges. */
  private async maintain(): Promise<void> {
    if (Date.now() - this.windowCheckedAt < 3_600_000) return void (await this.stats());
    await this.d.store.tx((tx) => ensureOutboxWindow((sql, p) => tx.query(sql, p)));
    this.windowCheckedAt = Date.now();
    await this.stats();
  }

  private async stats(): Promise<void> {
    if (Date.now() - this.statsAt < 10_000) return;
    this.statsAt = Date.now();
    const [s] = await this.d.store.tx((tx) => tx.query<{ pending: number; oldest: number }>(STATS));
    this.d.metrics.be.outboxPending.set(s?.pending ?? 0);
    this.d.metrics.be.outboxOldestAge.set(s?.oldest ?? 0);
  }
}

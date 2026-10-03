import { describe, expect, it } from "vitest";
import { runVectors } from "../../support/vectors.js";
import { idTime, newId, parseId } from "../../../src/ids.js";
import { durableName, dlqSubject, streamFor } from "../../../src/events/names.js";
import { envelopeHeaders } from "../../../src/events/envelope.js";
import { deriveCausation } from "../../../src/events/causation.js";
import { acceptInbound } from "../../../src/events/inbound.js";
import { applyCursorSequence, redeliveryDecision } from "../../../src/events/redelivery.js";

const ctxOf = (c: any) =>
  c.kind === "event" ? { kind: "event" as const, handled: { id: c.handled.id, hopCount: c.handled.hop_count } }
  : c.kind === "queued_job" ? { kind: "queued_job" as const, job: { causationId: c.job.causation_id, hopCount: c.job.hop_count } }
  : { kind: c.kind };

describe("envelope vectors", () => {
  runVectors("envelope", "ids", {
    uuid7: (i) => {
      const id = parseId(i.id);
      const t = idTime(id);
      return { canonical: id, unix_ms: t.getTime(), created_at: t.toISOString().replace(".000Z", "Z") };
    },
  });
  runVectors("envelope", "headers", {
    envelope: (i) => ({
      headers: envelopeHeaders(
        { componentId: i.producer.component_id, version: i.producer.version, eventsFile: i.producer.events_file },
        {
          id: i.row.id, subject: i.row.subject, aggregateType: i.row.aggregate_type, aggregateId: i.row.aggregate_id,
          aggregateVersion: i.row.aggregate_version, occurredAt: i.row.occurred_at, traceparent: i.row.traceparent,
          causationId: i.row.causation_id, hopCount: i.row.hop_count, payloadJson: i.row.payload_json,
        },
        { transactionDocument: i.contract?.transaction_document === true },
      ),
    }),
  });
  runVectors("envelope", "derive", {
    derive: (i) => {
      const d = deriveCausation(ctxOf(i.context));
      return { causation_id: d.causationId, hop_count: d.hopCount };
    },
    enqueue_context: (i) => {
      const d = deriveCausation(ctxOf(i.context));
      return { job_causation_id: d.causationId, job_hop_count: d.hopCount };
    },
  });
  runVectors("envelope", "inbound", {
    accept: (i) => {
      const r = acceptInbound(
        { componentId: i.subscription.component_id, subject: i.subscription.subject, aggregateType: i.subscription.aggregate_type, transactionDocument: i.subscription.transaction_document },
        i.headers, i.payload_json, i.delivery,
      );
      if (r.action === "dlq") return { action: "dlq", dlq_subject: r.dlqSubject, added_headers: r.addedHeaders };
      const e = r.event;
      const ev: Record<string, unknown> = { id: e.id, subject: e.subject, source: e.source, aggregate_type: e.aggregateType, aggregate_id: e.aggregateId, version: Number(e.version), hop_count: e.hopCount, causation_id: e.causationId, occurred_at: e.occurredAtText, delivery: e.delivery };
      ev.legal_entity = e.legalEntity;
      return { action: "handle", event: ev };
    },
  });
  runVectors("envelope", "cursor", {
    cursor_sequence: (i) => applyCursorSequence(i.start, i.versions),
    redelivery: (i) => {
      const r = redeliveryDecision({ delivery: i.delivery, maxDeliver: i.max_deliver, backoff: i.backoff, outcome: i.outcome, durable: i.durable, streamSeq: i.stream_seq });
      return r;
    },
  });
  runVectors("envelope", "names", {
    stream: (i) => streamFor(i.subject),
    durable: (i) => ({ durable: durableName(i.component_id, i.subject), dlq_subject: dlqSubject(durableName(i.component_id, i.subject), i.subject) }),
  });
});

describe("newId", () => {
  it("makes UUIDv7 ids whose time is now", () => {
    const a = newId();
    expect(parseId(a)).toBe(a);
    expect(Math.abs(idTime(a).getTime() - Date.now())).toBeLessThan(1000);
    expect(newId() > a).toBe(true);
  });
});

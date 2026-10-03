// What a consumer does with a delivered message before any handler runs (P12.7, P12.8, P12.14, P11.8;
// vectors envelope/inbound): decode it, or send it to the dead letters with a reason.
import { parseId } from "../ids.js";
import { dlqSubject, durableName } from "./names.js";
import { formatCeTime, isRfc3339 } from "./time.js";

export const HOP_LIMIT = 10;

export interface SubscriptionInfo {
  componentId: string;
  subject: string;
  aggregateType: string;
  transactionDocument: boolean;
}

export interface InboundEvent {
  id: string;
  subject: string;
  source: string;
  aggregateType: string;
  aggregateId: string;
  version: bigint;
  hopCount: number;
  causationId: string;
  occurredAt: Date;
  occurredAtText: string;
  /** "" when the event carries none */
  legalEntity: string;
  traceparent: string;
  delivery: number;
  payload: Record<string, unknown>;
}

export type Accepted =
  | { action: "handle"; event: InboundEvent }
  | { action: "dlq"; reason: string; dlqSubject: string; addedHeaders: Record<string, string> };

const COUNT = /^(0|[1-9][0-9]*)$/;

class Reject extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

function envelope(s: SubscriptionInfo, h: Record<string, string>) {
  const need = (k: string) => {
    const v = h[k];
    if (v === undefined || v === "") throw new Reject("ENVELOPE_INVALID");
    return v;
  };
  if (need("ce-specversion") !== "1.0" || need("ce-type") !== s.subject || need("ce-aggregatetype") !== s.aggregateType) throw new Reject("ENVELOPE_INVALID");
  if (!/^application\/json(\s*;.*)?$/.test(need("content-type"))) throw new Reject("ENVELOPE_INVALID");
  let id: string;
  try {
    id = parseId(need("ce-id"));
  } catch {
    throw new Reject("ENVELOPE_INVALID");
  }
  const time = need("ce-time");
  const version = need("ce-aggregateversion");
  const hop = need("ce-hopcount");
  if (!isRfc3339(time) || !COUNT.test(version) || version === "0" || !COUNT.test(hop)) throw new Reject("ENVELOPE_INVALID");
  return { id, source: need("ce-source"), aggregateId: need("ce-subject"), time, version: BigInt(version), hop: Number(hop) };
}

export function acceptInbound(s: SubscriptionInfo, headers: Record<string, string>, payloadJson: string, delivery: number): Accepted {
  try {
    const e = envelope(s, headers);
    if (e.hop > HOP_LIMIT) throw new Reject("HOP_LIMIT");
    let payload: unknown;
    try {
      payload = JSON.parse(payloadJson);
    } catch {
      throw new Reject("PAYLOAD_INVALID");
    }
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) throw new Reject("PAYLOAD_INVALID");
    const le = headers["ce-legalentity"];
    if (s.transactionDocument && (!le || (payload as { legal_entity_id?: unknown }).legal_entity_id !== le)) throw new Reject("LEGAL_ENTITY_MISSING");
    const text = formatCeTime(e.time);
    return {
      action: "handle",
      event: {
        id: e.id, subject: s.subject, source: e.source, aggregateType: s.aggregateType, aggregateId: e.aggregateId,
        version: e.version, hopCount: e.hop, causationId: headers["ce-causationid"] ?? "", occurredAt: new Date(text),
        occurredAtText: text, legalEntity: le ?? "", traceparent: headers.traceparent ?? "", delivery, payload: payload as Record<string, unknown>,
      },
    };
  } catch (x) {
    if (!(x instanceof Reject)) throw x;
    return dlq(s, x.reason, delivery);
  }
}

export function dlq(s: Pick<SubscriptionInfo, "componentId" | "subject">, reason: string, delivery: number): Accepted {
  const durable = durableName(s.componentId, s.subject);
  return {
    action: "dlq",
    reason,
    dlqSubject: dlqSubject(durable, s.subject),
    addedHeaders: { "be-dlq-consumer": durable, "be-dlq-delivery": String(delivery), "be-dlq-reason": reason },
  };
}

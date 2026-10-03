// CloudEvents 1.0 binary-mode headers of an outbox row (P12 envelope; vectors envelope/headers).
import { SpecError } from "../errors/specError.js";
import { parseId } from "../ids.js";
import { validateSubject } from "./names.js";
import { formatCeTime } from "./time.js";

export interface Producer {
  componentId: string;
  version: string;
  eventsFile: string;
}

export interface OutboxRow {
  id: string;
  subject: string;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion: number | bigint | string;
  occurredAt: string;
  traceparent: string;
  causationId: string;
  hopCount: number;
  payloadJson: string;
}

export function legalEntityOf(payloadJson: string): string | undefined {
  try {
    const p = JSON.parse(payloadJson) as { legal_entity_id?: unknown };
    return typeof p?.legal_entity_id === "string" && p.legal_entity_id !== "" ? p.legal_entity_id : undefined;
  } catch {
    return undefined;
  }
}

export function envelopeHeaders(p: Producer, r: OutboxRow, contract: { transactionDocument: boolean }): Record<string, string> {
  const id = parseId(r.id);
  validateSubject(r.subject);
  const version = BigInt(r.aggregateVersion);
  if (version < 1n) throw new SpecError("ENVELOPE_INVALID", "the aggregate version starts at 1");
  const le = legalEntityOf(r.payloadJson);
  if (contract.transactionDocument && le === undefined) throw new SpecError("LEGAL_ENTITY_MISSING", "a transaction-document event carries legal_entity_id");
  const h: Record<string, string> = {
    "Nats-Msg-Id": id,
    "ce-aggregatetype": r.aggregateType,
    "ce-aggregateversion": version.toString(),
    "ce-dataschema": `${p.componentId}@${p.version}/contracts/events/${p.eventsFile}#${r.subject}`,
    "ce-hopcount": String(r.hopCount),
    "ce-id": id,
    "ce-source": p.componentId,
    "ce-specversion": "1.0",
    "ce-subject": r.aggregateId,
    "ce-time": formatCeTime(r.occurredAt),
    "ce-type": r.subject,
    "content-type": "application/json",
  };
  if (r.causationId) h["ce-causationid"] = r.causationId;
  if (le !== undefined) h["ce-legalentity"] = le;
  if (r.traceparent) h.traceparent = r.traceparent;
  return Object.fromEntries(Object.entries(h).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

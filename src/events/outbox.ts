// tx.publish (P12.1, P12.2, P12.8): one besdk_outbox row in the business transaction; the envelope is completed
// by the pump. Subject declared, payload valid against the contract, legal entity present on a transaction
// document, causation and hop count derived from the unit of work.
import { context, propagation } from "@opentelemetry/api";
import { currentUnit } from "../context.js";
import { platformError } from "../errors/beError.js";
import { idTime, newId } from "../ids.js";
import type { Tx } from "../store/tx.js";
import { deriveCausation } from "./causation.js";
import type { EventContracts } from "./contracts.js";
import { legalEntityOf } from "./envelope.js";
import type { EventInput } from "./types.js";

const INSERT = `INSERT INTO besdk_outbox
  (id, created_at, subject, aggregate_type, aggregate_id, aggregate_version, occurred_at, traceparent, causation_id, hop_count, headers, payload, tracestate)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`;

export interface OutboxWriter {
  publishes: ReadonlySet<string>;
  contracts: EventContracts;
}

export async function writeOutbox(w: OutboxWriter, tx: Tx, ev: EventInput): Promise<void> {
  if (!w.publishes.has(ev.subject)) throw platformError("INTERNAL", undefined, `subject ${ev.subject} is not declared in Module.events.publishes`);
  const contract = w.contracts.get(ev.subject);
  if (!contract) throw platformError("INTERNAL", undefined, `subject ${ev.subject} has no contract in contracts/events`);
  const version = BigInt(ev.version);
  if (version < 1n) throw platformError("INTERNAL", undefined, "the aggregate version starts at 1");
  const problems = contract.check(ev.payload);
  if (problems.length > 0) throw platformError("INTERNAL", undefined, `payload of ${ev.subject} breaks its contract: ${problems.join("; ")}`);
  const payloadJson = JSON.stringify(ev.payload);
  const le = legalEntityOf(payloadJson);
  if (contract.transactionDocument && le === undefined) throw platformError("INTERNAL", undefined, `LEGAL_ENTITY_MISSING: ${ev.subject} is a transaction-document event and needs legal_entity_id`);
  await insertOutbox(tx, { subject: ev.subject, aggregateType: contract.aggregateType, aggregateId: ev.aggregateId, version, payloadJson, legalEntity: le });
}

/**
 * The outbox row itself: causation and hop count from the unit of work, the trace context. Also used for the
 * runtime's own events (lifecycle, P16.7), which have no contract in the component's events file.
 */
export async function insertOutbox(tx: Tx, e: { subject: string; aggregateType: string; aggregateId: string; version: bigint; payloadJson: string; legalEntity?: string }): Promise<void> {
  const u = currentUnit();
  const { causationId, hopCount } = deriveCausation(u?.handling ? { kind: "event", handled: u.handling } : u?.queued ? { kind: "queued_job", job: u.queued } : { kind: "request" });
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  const id = newId();
  await tx.query(INSERT, [
    id, idTime(id), e.subject, e.aggregateType, e.aggregateId, e.version.toString(), new Date(), carrier.traceparent ?? "",
    causationId, hopCount, JSON.stringify(e.legalEntity ? { "ce-legalentity": e.legalEntity } : {}), e.payloadJson, carrier.tracestate ?? "",
  ]);
}

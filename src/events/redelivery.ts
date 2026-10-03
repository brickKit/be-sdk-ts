// Runtime-side redelivery (P12.5, P12.7; vectors envelope/cursor, r1-07): the broker has no backoff and
// max_deliver −1; the runtime naks with EVENTS_BACKOFF[min(d, len) − 1] and dead-letters above max_deliver.
export type Outcome = "ok" | "error" | "permanent";

export type Decision<D> =
  | { action: "ack"; handled: true }
  | { action: "nak"; delay: D; handled: true }
  | { action: "dlq"; reason: "MAX_DELIVER" | "PERMANENT"; handled: boolean; dlq_msg_id: string };

/** Before the handler: is this delivery above the limit? */
export function overMaxDeliver(delivery: number, maxDeliver: number): boolean {
  return delivery > maxDeliver;
}

export function dlqMsgId(durable: string, streamSeq: number | bigint): string {
  return `dlq:${durable}:${streamSeq}`;
}

export function redeliveryDecision<D>(i: { delivery: number; maxDeliver: number; backoff: D[]; outcome: Outcome; durable: string; streamSeq: number | bigint }): Decision<D> {
  if (overMaxDeliver(i.delivery, i.maxDeliver)) return { action: "dlq", reason: "MAX_DELIVER", handled: false, dlq_msg_id: dlqMsgId(i.durable, i.streamSeq) };
  if (i.outcome === "ok") return { action: "ack", handled: true };
  if (i.outcome === "permanent") return { action: "dlq", reason: "PERMANENT", handled: true, dlq_msg_id: dlqMsgId(i.durable, i.streamSeq) };
  return { action: "nak", delay: i.backoff[Math.min(i.delivery, i.backoff.length) - 1]!, handled: true };
}

/** State mode (P12.6): a version is applied only when greater than the cursor. */
export function applyCursorSequence(start: number | null, versions: number[]): { applied: number[]; final: number | null } {
  let cur = start;
  const applied: number[] = [];
  for (const v of versions) {
    if (cur === null || v > cur) {
      applied.push(v);
      cur = v;
    }
  }
  return { applied, final: cur };
}

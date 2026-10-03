// The events a module declares (P12, sdk-redesign-apis §2.7 in TS shape).
import type { Tx } from "../store/tx.js";
import type { InboundEvent } from "./inbound.js";

export type ConsumedEvent = InboundEvent;

export interface Subscription {
  subject: string;
  /** the cursor's consumer name (a projection), default "" (P12.6) */
  consumer?: string;
  /** runs inside the cursor's transaction, local writes only */
  apply?: (tx: Tx, ev: ConsumedEvent) => Promise<void>;
  /** runs outside any transaction, may call the network, idempotent on a business key */
  run?: (ev: ConsumedEvent) => Promise<void>;
  /** deliveries before dead-lettering; EVENTS_MAX_DELIVER wins when set; default 8 */
  maxDeliver?: number;
  /** redelivery delays in ms; EVENTS_BACKOFF wins when set */
  backoffMs?: number[];
  /** messages handled at once, default 4 */
  concurrency?: number;
}

export interface EventsDeclaration {
  /** subjects this component publishes; the aggregate type comes from the contract's x-aggregate-type */
  publishes?: string[];
  subscribe?: Subscription[];
}

/** What `tx.publish` takes. */
export interface EventInput {
  subject: string;
  aggregateId: string;
  /** the aggregate's version after this change; one sequence for all subjects of the aggregate type */
  version: number | bigint;
  payload: Record<string, unknown>;
}

/** A handler error that goes straight to the dead letters (P12.7). */
export class PermanentError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PermanentError";
  }
}

export function permanent(err: unknown): PermanentError {
  return err instanceof PermanentError ? err : new PermanentError(String((err as Error)?.message ?? err), { cause: err });
}

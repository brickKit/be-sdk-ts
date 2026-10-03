// What every outbound call checks before it starts (P7.7, P7.9, P8.4): not inside a transaction, enough budget
// left, a free slot in the (member, dependency) bulkhead.
import { currentUnit } from "../context.js";
import { platformError } from "../errors/beError.js";

export const OUTBOUND_MAX_MS = 3_000;
export const MIN_BUDGET_MS = 50;
export const BULKHEAD_SIZE = 64;

export function refuseInTx(): void {
  if (currentUnit()?.inTx) throw platformError("NETWORK_IN_TX", undefined, "an outbound call inside a transaction (P8.4)");
}

/** min(3 s, remaining − 50 ms); under 50 ms the call is not sent. */
export function outboundTimeoutMs(now = Date.now()): number {
  const u = currentUnit();
  const remaining = u ? u.deadline - now : Number.POSITIVE_INFINITY;
  if (remaining < MIN_BUDGET_MS) throw platformError("DEADLINE_BUDGET_EXHAUSTED", undefined, "too little time left to start a call");
  return Math.min(OUTBOUND_MAX_MS, remaining - MIN_BUDGET_MS);
}

export class Bulkhead {
  private inUse = 0;
  private readonly size: number;
  private readonly onChange: (n: number) => void;

  constructor(size = BULKHEAD_SIZE, onChange: (n: number) => void = () => {}) {
    this.size = size;
    this.onChange = onChange;
  }

  /** Takes a slot or fails at once with OUTBOUND_LIMIT; never queues. */
  enter(): () => void {
    if (this.inUse >= this.size) throw platformError("OUTBOUND_LIMIT", undefined, "too many concurrent calls to one dependency");
    this.inUse++;
    this.onChange(this.inUse);
    let left = false;
    return () => {
      if (left) return;
      left = true;
      this.inUse--;
      this.onChange(this.inUse);
    };
  }
}

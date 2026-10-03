// The outbound interceptor chain of P7.12, in this order: default deadline (P7.7) → bulkhead (P7.9) → metadata
// (P7.2) → client RED metrics → transaction guard (P8.4). grpc-js runs interceptors synchronously when the call
// is made, so each one reads the caller's unit of work and trace context at call time, never at dial time (P7.6).
// A refusal (too little budget, bulkhead full, open transaction) answers the call without sending anything.
import { randomUUID } from "node:crypto";
import { context, propagation } from "@opentelemetry/api";
import { InterceptingCall, type Interceptor, type InterceptorOptions, type NextCall, type StatusObject } from "@grpc/grpc-js";
import { currentUnit } from "../context.js";
import { platformError, type BeError } from "../errors/beError.js";
import { codeName } from "../errors/codes.js";
import type { MemberRegistry } from "../obs/metrics.js";
import { localStatus } from "./errors.js";

export const OUTBOUND_TIMEOUT_MS = 3_000;
export const DEADLINE_MARGIN_MS = 50;
export const MAX_CONCURRENT = 64;

type CallInterface = ReturnType<NextCall>;
type StatusListener = (status: StatusObject, next: (s: StatusObject) => void) => void;

/** A call the runtime answers itself: start() delivers the status on the next turn, nothing reaches the wire. */
class RefusedCall implements CallInterface {
  private readonly status: StatusObject;
  private done = false;
  constructor(status: StatusObject) {
    this.status = status;
  }
  start(_md: unknown, listener?: { onReceiveStatus?: (s: StatusObject) => void }): void {
    setImmediate(() => {
      if (this.done) return;
      this.done = true;
      listener?.onReceiveStatus?.(this.status);
    });
  }
  cancelWithStatus(): void {}
  getPeer(): string {
    return "";
  }
  sendMessageWithContext(): void {}
  sendMessage(): void {}
  startRead(): void {}
  halfClose(): void {}
  getAuthContext(): null {
    return null;
  }
}

function refuse(err: BeError): InterceptingCall {
  return new InterceptingCall(new RefusedCall(localStatus(err)));
}

/** Runs `onStatus` once when the call ends, whatever ends it, and passes the status on. */
function onEnd(next: CallInterface, onStatus: (s: StatusObject) => void): InterceptingCall {
  const status: StatusListener = (s, pass) => {
    onStatus(s);
    pass(s);
  };
  return new InterceptingCall(next, { start: (md, listener, pass) => pass(md, { onReceiveStatus: status }) });
}

const toMs = (d: InterceptorOptions["deadline"]): number => (d instanceof Date ? d.getTime() : (d ?? Infinity));

/** P7.7: min(3 s, remaining − 50 ms); never later than a deadline the component set; < 50 ms left → not sent. */
export const deadlineInterceptor: Interceptor = (options, next) => {
  const now = Date.now();
  let deadline = Math.min(now + OUTBOUND_TIMEOUT_MS, toMs(options.deadline));
  const unit = currentUnit();
  if (unit) {
    const remaining = unit.deadline - now;
    if (remaining < DEADLINE_MARGIN_MS) {
      return refuse(platformError("DEADLINE_BUDGET_EXHAUSTED", { remaining_ms: String(Math.max(0, remaining)) }, "too little time left to start the call"));
    }
    deadline = Math.min(deadline, unit.deadline - DEADLINE_MARGIN_MS);
  }
  return new InterceptingCall(next({ ...options, deadline }));
};

/** P7.9: a counter per (member, dependency); the 65th concurrent call fails at once and is never queued. */
export class Bulkhead {
  private inflight = 0;
  private readonly max: number;
  constructor(max = MAX_CONCURRENT) {
    this.max = max;
  }
  tryAcquire(): boolean {
    if (this.inflight >= this.max) return false;
    this.inflight++;
    return true;
  }
  release(): void {
    this.inflight--;
  }
  get size(): number {
    return this.inflight;
  }
}

export function bulkheadInterceptor(b: Bulkhead, target: string, metrics: MemberRegistry): Interceptor {
  return (options, next) => {
    if (!b.tryAcquire()) {
      return refuse(platformError("OUTBOUND_LIMIT", { target, limit: String(MAX_CONCURRENT) }, `more than ${MAX_CONCURRENT} concurrent calls to ${target}`));
    }
    metrics.be.outboundInflight.inc({ target });
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      b.release();
      metrics.be.outboundInflight.dec({ target });
    };
    try {
      return onEnd(next(options), release);
    } catch (e) {
      release();
      throw e;
    }
  };
}

/** P7.2: trace context, request ID, be-caller always, be-actor-* of the user whose request led to the call. */
export function metadataInterceptor(memberId: string): Interceptor {
  return (options, next) => {
    const unit = currentUnit();
    const active = context.active();
    return new InterceptingCall(next(options), {
      start: (md, listener, pass) => {
        const carrier: Record<string, string> = {};
        propagation.inject(active, carrier);
        for (const [k, v] of Object.entries(carrier)) md.set(k, v);
        md.set("x-request-id", unit?.requestId || randomUUID());
        md.set("be-caller", memberId);
        md.remove("be-actor-sub");
        md.remove("be-actor-act");
        const sub = unit?.user?.sub ?? unit?.system?.actorSub;
        const act = unit?.user?.act !== undefined ? JSON.stringify(unit.user.act) : unit?.system?.act;
        if (sub) md.set("be-actor-sub", sub);
        if (act) md.set("be-actor-act", act);
        pass(md, listener);
      },
    });
  };
}

/** be_grpc_client_handled_total{target, method, code} and the duration histogram. */
export function metricsInterceptor(target: string, metrics: MemberRegistry): Interceptor {
  return (options, next) => {
    const method = options.method_definition.path.replace(/^\//, "");
    const start = performance.now();
    return onEnd(next(options), (s) => {
      metrics.be.grpcClientHandled.inc({ target, method, code: codeName(s.code) });
      metrics.be.grpcClientDuration.observe({ target, method }, (performance.now() - start) / 1000);
    });
  };
}

/** P8.4: no network inside a transaction; a programming error, INTERNAL to every caller. */
export const txGuardInterceptor: Interceptor = (options, next) => {
  if (currentUnit()?.inTx) return refuse(platformError("NETWORK_IN_TX", undefined, `gRPC call ${options.method_definition.path} inside a transaction`));
  return new InterceptingCall(next(options));
};

/** The chain for one (member, dependency), outermost first. */
export function clientChain(memberId: string, target: string, bulkhead: Bulkhead, metrics: MemberRegistry): Interceptor[] {
  return [deadlineInterceptor, bulkheadInterceptor(bulkhead, target, metrics), metadataInterceptor(memberId), metricsInterceptor(target, metrics), txGuardInterceptor];
}

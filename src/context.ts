// The unit of work's context (sdk-redesign-apis §1.2): deadline, cancellation, request id, the verified user
// (and, in a private slot, the raw token), the system principal, the open-transaction marker and the event being
// handled. One AsyncLocalStorage per process; every entry point (HTTP hook, gRPC wrapper, event handler, job)
// runs its work inside `runUnit`. Error handlers never read it (r1-08): they use the request's own copy.
import { AsyncLocalStorage } from "node:async_hooks";
import type { Bundle } from "./auth/decide.js";
import type { VerifiedUser } from "./auth/jwt.js";

export interface SystemPrincipal {
  caller: string;
  actorSub: string;
  act: string;
}

export interface HandledEvent {
  id: string;
  hopCount: number;
}

const TOKEN = Symbol("rawToken");

export class Unit {
  readonly memberId: string;
  readonly deadline: number;
  readonly signal: AbortSignal;
  readonly requestId: string;
  user: VerifiedUser | undefined;
  bundle: Bundle | undefined;
  perm: string | undefined;
  system: SystemPrincipal | undefined;
  handling: HandledEvent | undefined;
  job: string | undefined;
  inTx = false;
  /** decides a guard for this request (set by the HTTP layer; used by GraphQL resolvers) */
  authorize: ((guard: string) => Promise<void>) | undefined;
  [TOKEN]: string | undefined;

  constructor(o: { memberId: string; deadline: number; signal: AbortSignal; requestId?: string }) {
    this.memberId = o.memberId;
    this.deadline = o.deadline;
    this.signal = o.signal;
    this.requestId = o.requestId ?? "";
  }

  /** A child unit for a transaction: same request, marked as holding a connection. */
  forTx(): Unit {
    const u = Object.assign(Object.create(Object.getPrototypeOf(this)) as Unit, this);
    u.inTx = true;
    return u;
  }

  setToken(t: string): void {
    this[TOKEN] = t;
  }

  /** The caller's raw access token, for user-plane forwarding only (P5.8). */
  rawToken(): string | undefined {
    return this[TOKEN];
  }

  remainingMs(now = Date.now()): number {
    return this.deadline - now;
  }
}

const als = new AsyncLocalStorage<Unit>();

export function runUnit<T>(u: Unit, fn: () => T): T {
  return als.run(u, fn);
}

export function currentUnit(): Unit | undefined {
  return als.getStore();
}

/** The current deadline (epoch ms), or undefined outside a unit of work. */
export function deadline(): number | undefined {
  return als.getStore()?.deadline;
}

/** The current cancellation signal: pass it to pg and fetch. */
export function signal(): AbortSignal | undefined {
  return als.getStore()?.signal;
}

/** The system principal of a gRPC system call, or undefined (P7.3). */
export function system(): SystemPrincipal | undefined {
  return als.getStore()?.system;
}

/** The idempotency namespace of the caller (P13.1): `user:<sub>`, `svc:<be-caller>` or `system`. */
export function callerOf(): string {
  const u = als.getStore();
  if (u?.user) return `user:${u.user.sub}`;
  if (u?.system) return `svc:${u.system.caller}`;
  return "system";
}

/** The current request ID (P3.2), or "" outside a request. */
export function requestId(): string {
  return als.getStore()?.requestId ?? "";
}

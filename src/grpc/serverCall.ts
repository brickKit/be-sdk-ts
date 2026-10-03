// One inbound unary call (P7.3, P7.4, P7.10, P4.2): every handler a component registers is wrapped by this.
// Steps: recovery (the whole call is one try, sync throws and rejections alike) → identity (be-caller required,
// the system principal, user-facing rpcs refused) → deadline floor (10 s without grpc-timeout) → batch limit →
// the handler inside the unit of work and the server span → error normalisation (google.rpc.Status details) →
// RED metrics → one access-log line. The span and the metrics cover refused calls too, so every log line has a
// trace ID and every answer is counted (the order of P7.4 is INTERNAL; only its effects are observable).
import { context, propagation, ROOT_CONTEXT, SpanKind, SpanStatusCode, trace, type Tracer } from "@opentelemetry/api";
import { Metadata, type sendUnaryData, type ServerUnaryCall, type StatusObject } from "@grpc/grpc-js";
import type { Logger } from "pino";
import { runUnit, Unit, type SystemPrincipal } from "../context.js";
import { BeError, platformError, isBeError } from "../errors/beError.js";
import type { ErrorCatalog } from "../errors/catalog.js";
import { codeName, logLevel } from "../errors/codes.js";
import { errorFields } from "../log/logger.js";
import type { MemberRegistry } from "../obs/metrics.js";
import type { BatchCheck } from "./batchLimits.js";
import type { MethodInfo } from "./descriptors.js";
import { loggedError, toStatus } from "./errors.js";

export const DEADLINE_FLOOR_MS = 10_000;

export interface CallDeps {
  memberId: string;
  locale: string;
  catalog: ErrorCatalog;
  logger: Logger;
  metrics: MemberRegistry;
  tracer: Tracer;
  /** the deadline of a call that sent no grpc-timeout (P7.4) */
  deadlineFloorMs: number;
}

export interface MethodPlan {
  info: MethodInfo;
  batch: BatchCheck;
  userFacing: boolean;
}

export type UnaryHandler = (call: ServerUnaryCall<unknown, unknown>, cb: sendUnaryData<unknown>) => unknown;

function first(md: Metadata, key: string): string {
  const v = md.get(key)[0];
  return typeof v === "string" ? v : "";
}

/** be-caller is required; be-actor-* are recorded, never used to grant access (P7.2, P7.3). */
function identify(md: Metadata, plan: MethodPlan): SystemPrincipal {
  const caller = first(md, "be-caller");
  if (caller === "") throw platformError("MISSING_CALLER", undefined, "a system call without be-caller");
  if (plan.userFacing) {
    // spec gap: P7.3 names no reason; TOKEN_INVALID is the reserved UNAUTHENTICATED reason for "no user token"
    throw platformError("TOKEN_INVALID", undefined, `${plan.info.method} is user-facing: it is served over REST only`);
  }
  return { caller, actorSub: first(md, "be-actor-sub"), act: first(md, "be-actor-act") };
}

/** Calls a grpc-js style (callback) or async (returns the reply) handler; both settle one promise. */
function invoke(handler: UnaryHandler, self: unknown, call: ServerUnaryCall<unknown, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const r = handler.call(self, call, (err, value) => (err ? reject(err) : resolve(value)));
    if (r && typeof (r as Promise<unknown>).then === "function") {
      (r as Promise<unknown>).then((v) => v !== undefined && resolve(v), reject);
    }
  });
}

/** The handler's result, or DEADLINE_BUDGET_EXHAUSTED when the unit's deadline passes first (signal aborted). */
function withDeadline(p: Promise<unknown>, unit: Unit, abort: AbortController): Promise<unknown> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abort.abort(platformError("DEADLINE_BUDGET_EXHAUSTED", undefined, "the call's deadline passed"));
      reject(abort.signal.reason);
    }, Math.max(0, unit.remainingMs()));
  });
  return Promise.race([p, expired]).finally(() => clearTimeout(timer));
}

export function wrapUnary(d: CallDeps, plan: MethodPlan, handler: UnaryHandler, self: unknown) {
  return (call: ServerUnaryCall<unknown, unknown>, cb: sendUnaryData<unknown>): void => {
    void serve(d, plan, handler, self, call, cb);
  };
}

async function serve(d: CallDeps, plan: MethodPlan, handler: UnaryHandler, self: unknown, call: ServerUnaryCall<unknown, unknown>, cb: sendUnaryData<unknown>): Promise<void> {
  const start = performance.now();
  const { service, method, path } = plan.info;
  const parent = propagation.extract(ROOT_CONTEXT, call.metadata.getMap());
  const span = d.tracer.startSpan(`${service}/${method}`, {
    kind: SpanKind.SERVER, attributes: { "rpc.system": "grpc", "rpc.service": service, "rpc.method": method },
  }, parent);
  const traceId = span.spanContext().traceId;
  const requestId = first(call.metadata, "x-request-id") || traceId;
  let principal: SystemPrincipal | undefined;
  let reply: unknown;
  let err: unknown;
  try {
    principal = identify(call.metadata, plan);
    const abort = new AbortController();
    call.on("cancelled", () => abort.abort(new BeError("CANCELLED", "", { message: "the caller cancelled" })));
    const sent = call.getDeadline();
    const callerDeadline = sent instanceof Date ? sent.getTime() : sent;
    const deadline = Number.isFinite(callerDeadline) ? callerDeadline : Date.now() + d.deadlineFloorMs;
    const unit = new Unit({ memberId: d.memberId, deadline, signal: abort.signal, requestId });
    unit.system = principal;
    const tooMany = plan.batch(call.request);
    if (tooMany) throw batchTooLarge(tooMany.field, tooMany.max, tooMany.got);
    const run = context.with(trace.setSpan(parent, span), () => runUnit(unit, () => invoke(handler, self, call)));
    reply = await withDeadline(run, unit, abort);
  } catch (e) {
    err = e;
  }
  let status: StatusObject | undefined;
  const expired = isBeError(err) && err.code === "DEADLINE_EXCEEDED";
  if (call.cancelled && !expired) {
    // the caller is gone: nothing to answer; recorded as CANCELLED, not logged as an error (P4.6)
    status = { code: 1, details: "cancelled", metadata: new Metadata() };
    err = undefined;
  } else if (err !== undefined) {
    status = toStatus(err, { memberId: d.memberId, locale: d.locale, catalog: d.catalog, path, requestId, traceId });
  }
  if (status) cb(status as StatusObject & Error);
  else cb(null, reply);
  finish(d, plan, { start, span, requestId, principal, err, status });
}

function batchTooLarge(field: string, max: number, got: number): BeError {
  const p = platformError("BATCH_TOO_LARGE", { field, max: String(max), got: String(got) });
  return new BeError(p.code, p.reason, {
    domain: "be", metadata: p.metadata, message: `${field} has ${got} items, at most ${max} are allowed`,
    violations: [{ field, reason: "BATCH_TOO_LARGE", description: `at most ${max} items` }],
  });
}

interface Outcome {
  start: number;
  span: ReturnType<Tracer["startSpan"]>;
  requestId: string;
  principal: SystemPrincipal | undefined;
  err: unknown;
  status: StatusObject | undefined;
}

function finish(d: CallDeps, plan: MethodPlan, o: Outcome): void {
  const { service, method } = plan.info;
  const code = o.status?.code ?? 0;
  const name = codeName(code);
  const seconds = (performance.now() - o.start) / 1000;
  d.metrics.be.grpcServerHandled.inc({ service, method, code: name });
  d.metrics.be.grpcServerDuration.observe({ service, method }, seconds);
  o.span.setAttribute("rpc.grpc.status_code", code);
  if (name === "INTERNAL" || name === "UNKNOWN" || name === "DATA_LOSS" || name === "UNAVAILABLE" || name === "DEADLINE_EXCEEDED") {
    o.span.setStatus({ code: SpanStatusCode.ERROR });
  }
  o.span.end();
  const sc = o.span.spanContext();
  const fields: Record<string, unknown> = {
    trace_id: sc.traceId, span_id: sc.spanId, request_id: o.requestId,
    "rpc.service": service, "rpc.method": method, "rpc.grpc.status_code": code, duration_ms: Math.round(seconds * 1000),
  };
  if (o.principal) {
    fields.caller = o.principal.caller;
    if (o.principal.actorSub) fields.actor_sub = o.principal.actorSub;
    if (o.principal.act) fields.act = o.principal.act;
  }
  let level = "info";
  if (o.err !== undefined) {
    Object.assign(fields, errorFields(loggedError(o.err, d.memberId)));
    const l = logLevel(name);
    if (l === "error" || l === "warn") level = l;
  }
  d.logger[level as "info"](fields, "grpc_request");
}

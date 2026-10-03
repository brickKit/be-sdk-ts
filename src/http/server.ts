// The member's HTTP server (P3): one Fastify instance per member (r1-08), the fixed server options, the hook
// chain request-id → trace → deadline → guard → RED metrics → access log, problem+json errors, the operations
// endpoints. Fastify ≥ 5.12 for handlerTimeout.
import { context, propagation, ROOT_CONTEXT, SpanKind, SpanStatusCode, trace, type Span, type Tracer } from "@opentelemetry/api";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { Logger } from "pino";
import { decide, type AuthDeps, type Guard } from "../auth/guard.js";
import { runUnit, Unit } from "../context.js";
import { BeError, platformError, isBeError } from "../errors/beError.js";
import type { ErrorCatalog } from "../errors/catalog.js";
import { logLevel } from "../errors/codes.js";
import { problemBody, publicError } from "../errors/problem.js";
import { errorFields } from "../log/logger.js";
import type { MemberRegistry } from "../obs/metrics.js";
import { mapFrameworkError } from "./errorMapping.js";
import { Router } from "./router.js";

export interface Readiness {
  ok: boolean;
  waiting: string[];
}

export interface HttpDeps {
  memberId: string;
  locale: string;
  catalog: ErrorCatalog;
  logger: Logger;
  metrics: MemberRegistry;
  tracer: Tracer;
  defaultTimeoutMs: number;
  auth: AuthDeps;
  ops: { readiness(): Readiness; info(): unknown };
}

export interface HttpServer {
  app: FastifyInstance;
  router: Router;
  /** listens on all interfaces, IPv4 and IPv6 (P1.13); returns a loopback base URL */
  listen(port: number): Promise<string>;
  /** stops accepting, lets in-flight requests finish within `graceMs`, then cuts what is left (P1.6) */
  close(graceMs?: number): Promise<void>;
}

interface RequestState {
  unit: Unit;
  span: Span;
  start: number;
  error?: BeError;
}

const STATE = Symbol("beState");
type WithState = FastifyRequest & { [STATE]?: RequestState };
const OPS = new Set(["/healthz", "/readyz", "/metrics", "/_be/info"]);

export function buildHttpServer(d: HttpDeps): HttpServer {
  const app = Fastify({
    logger: false,
    bodyLimit: 1 << 20,
    handlerTimeout: d.defaultTimeoutMs,
    requestTimeout: 30_000,
    keepAliveTimeout: 120_000,
    http: { headersTimeout: 5_000, connectionsCheckingInterval: 1_000 } as object,
    return503OnClosing: true,
  });
  app.addHook("onRequest", (req, reply, done) => onRequest(d, req as WithState, reply, done));
  app.addHook("preHandler", async (req) => {
    const guard = (req.routeOptions.config as { guard?: Guard }).guard;
    const st = (req as WithState)[STATE]!;
    if (guard) await decideCounted(d, guard, req.headers.authorization, st.unit);
  });
  app.addHook("onResponse", async (req, reply) => onResponse(d, req as WithState, reply));
  app.setErrorHandler((err, req, reply) => sendError(d, req as WithState, reply, err));
  app.setNotFoundHandler((req, reply) => sendError(d, req as WithState, reply, platformError("NOT_FOUND")));
  registerOps(app, d);
  return {
    app,
    router: new Router(app, d.memberId),
    listen: (port) => listenDualStack(app, port),
    close: (graceMs = 25_000) => drain(app, graceMs),
  };
}

function onRequest(d: HttpDeps, req: WithState, reply: FastifyReply, done: () => void): void {
  const start = performance.now();
  const parent = propagation.extract(ROOT_CONTEXT, req.headers);
  const route = req.routeOptions.url ?? "unmatched";
  const span = d.tracer.startSpan(`${req.method} ${route}`, { kind: SpanKind.SERVER, attributes: { "http.request.method": req.method, "http.route": route } }, parent);
  const traceId = span.spanContext().traceId;
  const inbound = req.headers["x-request-id"];
  const requestId = typeof inbound === "string" && inbound !== "" ? inbound : traceId;
  reply.header("x-request-id", requestId);
  const timeout = req.routeOptions.handlerTimeout || d.defaultTimeoutMs;
  const unit = new Unit({ memberId: d.memberId, deadline: Date.now() + timeout, signal: req.signal, requestId });
  req[STATE] = { unit, span, start };
  const decided = new Map<string, Promise<void>>();
  unit.authorize = (guard) => {
    let p = decided.get(guard);
    if (!p) decided.set(guard, (p = decideCounted(d, guard, req.headers.authorization, unit)));
    return p;
  };
  context.with(trace.setSpan(parent, span), () => runUnit(unit, done));
}

async function decideCounted(d: HttpDeps, guard: Guard, authorization: string | undefined, unit: Unit): Promise<void> {
  try {
    await decide(guard, authorization, unit, d.auth);
  } catch (e) {
    d.metrics.be.authzDenied.inc({ reason: (e as BeError).reason ?? "INTERNAL" });
    throw e;
  }
}

function sendError(d: HttpDeps, req: WithState, reply: FastifyReply, raw: unknown): void {
  const st = req[STATE];
  const err = mapFrameworkError(raw);
  const shown = publicError(err, d.memberId);
  if (st) st.error = isBeError(err) ? err.withDomain(d.memberId) : new BeError("INTERNAL", "INTERNAL", { domain: "be", message: String((raw as Error)?.message ?? raw), cause: raw });
  const ids = { path: req.url.split("?")[0]!, requestId: st?.unit.requestId ?? "", traceId: st?.span.spanContext().traceId ?? "" };
  let p;
  try {
    p = problemBody(shown, ids, { locale: d.locale, componentId: d.memberId, catalog: d.catalog });
  } catch {
    p = problemBody(new BeError("INTERNAL", "INTERNAL", { domain: "be" }), ids, { locale: d.locale, catalog: d.catalog });
  }
  const extra = (err as { headers?: Record<string, string> }).headers ?? {};
  reply.code(p.status).headers({ ...p.headers, ...extra }).type(p.contentType).send(p.body);
}

function onResponse(d: HttpDeps, req: WithState, reply: FastifyReply): void {
  const st = req[STATE];
  if (!st) return;
  const route = req.routeOptions.url ?? "unmatched";
  const seconds = (performance.now() - st.start) / 1000;
  const status = reply.statusCode;
  st.span.setAttribute("http.response.status_code", status);
  if (status >= 500) st.span.setStatus({ code: SpanStatusCode.ERROR });
  st.span.end();
  d.metrics.be.httpServerRequests.inc({ method: req.method, route, status_code: String(status) });
  d.metrics.be.httpServerDuration.observe({ method: req.method, route }, seconds);
  const sc = st.span.spanContext();
  const fields: Record<string, unknown> = {
    trace_id: sc.traceId, span_id: sc.spanId, request_id: st.unit.requestId,
    "http.request.method": req.method, "http.route": route, "http.response.status_code": status, duration_ms: Math.round(seconds * 1000),
  };
  if (st.unit.user) fields.sub = st.unit.user.sub;
  if (st.unit.perm) fields.perm = st.unit.perm;
  let level = OPS.has(route) ? "debug" : "info";
  if (st.error) {
    Object.assign(fields, errorFields(st.error));
    const l = logLevel(st.error.code);
    if (l === "error" || l === "warn") level = l;
  }
  d.logger[level as "info"](fields, "http_request");
}

function registerOps(app: FastifyInstance, d: HttpDeps): void {
  app.get("/healthz", async (_req, reply) => reply.type("text/plain").send("ok"));
  app.get("/readyz", async (_req, reply) => {
    const r = d.ops.readiness();
    if (r.ok) return reply.type("text/plain").send("ok");
    throw platformError("NOT_READY", { waiting: r.waiting.join(",") });
  });
  app.get("/metrics", async (_req, reply) => reply.type("text/plain; version=0.0.4").send(await d.metrics.registry.metrics()));
  app.get("/_be/info", async () => d.ops.info());
}

async function listenDualStack(app: FastifyInstance, port: number): Promise<string> {
  try {
    await app.listen({ port, host: "::", ipv6Only: false });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EAFNOSUPPORT" && (e as NodeJS.ErrnoException).code !== "EADDRNOTAVAIL") throw e;
    await app.listen({ port, host: "0.0.0.0" });
  }
  const addr = app.server.address();
  return `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : port}`;
}

/**
 * Node keeps a connection alive after a response that was in flight when close() was called, so close() alone
 * never resolves while a client holds it (seen with Fastify 5.12 / Node 24): close idle connections as they
 * appear, and every connection at the end of the grace period.
 */
async function drain(app: FastifyInstance, graceMs: number): Promise<void> {
  const closed = app.close();
  const tick = setInterval(() => app.server.closeIdleConnections(), 100);
  const cut = setTimeout(() => app.server.closeAllConnections(), graceMs);
  try {
    await closed;
  } finally {
    clearInterval(tick);
    clearTimeout(cut);
  }
}

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BeError } from "../../../src/errors/beError.js";
import { beCatalog, componentCatalog } from "../../../src/errors/catalog.js";
import { fromStatus, STATUS_DETAILS_KEY } from "../../../src/grpc/errors.js";
import { buildGrpcServer } from "../../../src/grpc/server.js";
import { decodeStatus } from "../../../src/grpc/statusDetails.js";
import { unary } from "../../../src/grpc/clients.js";
import { newMemberRegistry } from "../../../src/obs/metrics.js";
import { Telemetry } from "../../../src/obs/telemetry.js";
import { captureLogger } from "../../support/capture.js";
import { echoHarness, md, SERVER_ID, CLIENT_ID, type EchoHarness } from "../../support/grpcEcho.js";
import {
  BatchGetRequest, EchoServiceClient, EchoServiceService, FailRequest, GetRequest, SlowRequest, TouchRequest, WatchServiceService, protoMetadata,
} from "../../gen/sdktest/v1/echo.js";
import { protoMetadata as limitsMetadata } from "../../gen/be/v1/limits.js";

let h: EchoHarness;
let echo: InstanceType<typeof EchoServiceClient>;
let raw: InstanceType<typeof EchoServiceClient>;

beforeAll(async () => {
  h = await echoHarness();
  echo = h.clients().clients.client(EchoServiceClient, SERVER_ID, protoMetadata);
  raw = h.raw();
});
afterAll(async () => {
  await h.close();
});

/** a raw call: resolves with the reply or the ServiceError */
function rawCall(method: "get" | "slow" | "approve", req: object, meta = md({}), deadlineMs?: number): Promise<{ err: any; reply: any }> {
  const opts = deadlineMs === undefined ? {} : { deadline: Date.now() + deadlineMs };
  const full = method === "slow" ? SlowRequest.fromPartial(req) : method === "approve" ? TouchRequest.fromPartial(req) : GetRequest.fromPartial(req);
  return new Promise((res) => (raw[method] as Function).call(raw, full, meta, opts, (err: any, reply: any) => res({ err, reply })));
}

async function failure(p: Promise<unknown>): Promise<BeError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(BeError);
    return e as BeError;
  }
  throw new Error("expected the call to fail");
}

describe("identity (P7.2, P7.3)", () => {
  it("a call without be-caller answers UNAUTHENTICATED / MISSING_CALLER, with google.rpc.ErrorInfo", async () => {
    const { err } = await rawCall("get", { id: "nocaller" });
    expect(err.code).toBe(16);
    const d = decodeStatus(err.metadata.get(STATUS_DETAILS_KEY)[0]);
    expect(d.errorInfo).toEqual({ reason: "MISSING_CALLER", domain: "be", metadata: {} });
    expect(fromStatus(err)).toMatchObject({ code: "UNAUTHENTICATED", reason: "MISSING_CALLER", domain: "be" });
    expect(h.attempts.has("nocaller")).toBe(false);
  });

  it("marks the call as a system principal {caller, actor_sub, act}, recorded in the access log", async () => {
    const { err, reply } = await rawCall("get", { id: "who" }, md({ "be-caller": "erp/sales", "be-actor-sub": "u-1", "be-actor-act": '{"sub":"a","kind":"agent"}', "x-request-id": "rid-1" }));
    expect(err).toBeNull();
    expect(reply).toMatchObject({ caller: "erp/sales", actorSub: "u-1", actorAct: '{"sub":"a","kind":"agent"}', requestId: "rid-1" });
    const line = h.log.lines.find((l) => l.request_id === "rid-1");
    expect(line).toMatchObject({
      msg: "grpc_request", level: "info", "rpc.service": "sdktest.echo.v1.EchoService", "rpc.method": "Get", "rpc.grpc.status_code": 0,
      caller: "erp/sales", actor_sub: "u-1", component_id: SERVER_ID,
    });
    expect(line.trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(line.span_id).toMatch(/^[0-9a-f]{16}$/);
    expect(typeof line.duration_ms).toBe("number");
  });

  it("a user-facing rpc answers UNAUTHENTICATED before any component code runs", async () => {
    const e = await failure(unary(echo.approve.bind(echo), TouchRequest.fromPartial({ id: "w", idempotencyKey: "k" })));
    expect(e).toMatchObject({ code: "UNAUTHENTICATED", reason: "TOKEN_INVALID", domain: "be" });
    expect(h.approveRan.value).toBe(false);
  });
});

describe("deadline floor (P7.4)", () => {
  it("a call without grpc-timeout gets 10 s; a call with one keeps the caller's", async () => {
    const { reply } = await rawCall("get", { id: "floor" }, md({ "be-caller": "erp/sales" }));
    expect(reply.deadlineRemainingMs).toBeGreaterThan(9_500);
    expect(reply.deadlineRemainingMs).toBeLessThanOrEqual(10_000);
    const { reply: r2 } = await rawCall("get", { id: "floor2" }, md({ "be-caller": "erp/sales" }), 25_000);
    expect(r2.deadlineRemainingMs).toBeGreaterThan(24_000);
    expect(r2.deadlineRemainingMs).toBeLessThanOrEqual(25_000);
  });

  it("past the floor the unit's signal aborts and the call answers DEADLINE_EXCEEDED", async () => {
    const short = await echoHarness({ deadlineFloorMs: 200 });
    try {
      const c = short.raw();
      const t0 = Date.now();
      const err = await new Promise<any>((res) => c.slow(SlowRequest.fromPartial({ ms: 2000 }), md({ "be-caller": "erp/sales" }), (e) => res(e)));
      expect(Date.now() - t0).toBeLessThan(1500);
      expect(fromStatus(err)).toMatchObject({ code: "DEADLINE_EXCEEDED", reason: "DEADLINE_BUDGET_EXHAUSTED", domain: "be" });
      expect(short.log.lines.find((l) => l["rpc.method"] === "Slow")).toMatchObject({ level: "warn", "error.reason": "DEADLINE_BUDGET_EXHAUSTED" });
    } finally {
      await short.close();
    }
  });
});

describe("batch limits (P7.10)", () => {
  const n = (k: number) => Array.from({ length: k }, (_, i) => `x${i}`);
  const cases: [string, object, Record<string, string>][] = [
    ["explicit max_items", { ids: n(4) }, { field: "ids", max: "3", got: "4" }],
    ["default 500", { tags: n(501) }, { field: "tags", max: "500", got: "501" }],
    ["nested message", { filter: { skuIds: n(3) } }, { field: "filter.sku_ids", max: "2", got: "3" }],
  ];
  for (const [name, req, meta] of cases) {
    it(`${name}: INVALID_ARGUMENT / BATCH_TOO_LARGE with metadata and BadRequest`, async () => {
      const e = await failure(unary(echo.batchGet.bind(echo), BatchGetRequest.fromPartial(req)));
      expect(e).toMatchObject({ code: "INVALID_ARGUMENT", reason: "BATCH_TOO_LARGE", domain: "be", metadata: meta });
      expect(e.violations).toEqual([{ field: meta.field, reason: "BATCH_TOO_LARGE", description: `at most ${meta.max} items` }]);
      const d = decodeStatus((e.cause as any).metadata.get(STATUS_DETAILS_KEY)[0]);
      expect(d.badRequest).toEqual([{ field: meta.field, reason: "BATCH_TOO_LARGE", description: `at most ${meta.max} items` }]);
    });
  }
  it("within the limits the handler runs", async () => {
    expect(await unary(echo.batchGet.bind(echo), BatchGetRequest.fromPartial({ ids: n(3), tags: n(500), filter: { skuIds: n(2) } }))).toEqual({ count: 3 });
  });
});

describe("error normalisation (P4.2, P4.3)", () => {
  it("a BeError arrives as the same code / reason / domain / metadata / violations / retry delay", async () => {
    const e = await failure(unary(echo.fail.bind(echo), FailRequest.fromPartial({
      code: "FAILED_PRECONDITION", reason: "THING_NOT_DRAFT", metadata: { status: "APPROVED" }, message: "not a draft", violationField: "items[0].qty",
    })));
    expect(e).toMatchObject({ code: "FAILED_PRECONDITION", reason: "THING_NOT_DRAFT", domain: SERVER_ID, metadata: { status: "APPROVED" }, message: "not a draft" });
    expect(e.violations).toEqual([{ field: "items[0].qty", reason: "MUST_BE_POSITIVE", description: "must be > 0" }]);
    const r = await failure(unary(echo.fail.bind(echo), FailRequest.fromPartial({ code: "RESOURCE_EXHAUSTED", reason: "QUOTA_FULL", retryAfterMs: 1500 })));
    expect(r).toMatchObject({ code: "RESOURCE_EXHAUSTED", reason: "QUOTA_FULL", retryAfterMs: 1500 });
  });

  it("the status message is the default-language detail of the catalogue for reserved reasons", async () => {
    const { err } = await rawCall("get", { id: "x" });
    expect(err.details).toBe(beCatalog().render("be", "MISSING_CALLER", "en", {}).detail);
    expect(err.details).not.toBe("a system call without be-caller"); // the catalogue's text, not the log message
  });

  it("an exception answers INTERNAL with a generic message; the original goes only to the log, at error", async () => {
    const e = await failure(unary(echo.fail.bind(echo), FailRequest.fromPartial({ throwPlain: true })));
    expect(e).toMatchObject({ code: "INTERNAL", reason: "INTERNAL", domain: "be", metadata: {} });
    expect(e.message).not.toMatch(/secret|SELECT|app\.ts/);
    expect(JSON.stringify((e.cause as any).metadata.getMap())).not.toMatch(/secret/);
    const line = h.log.lines.find((l) => l["rpc.method"] === "Fail" && l.level === "error");
    expect(line).toMatchObject({ msg: "grpc_request", "error.code": "INTERNAL", "error.reason": "INTERNAL", "rpc.grpc.status_code": 13 });
    expect(line.error).toMatch(/SELECT secret/);
  });

  it("a hidden code raised by component code leaves as INTERNAL / be", async () => {
    const e = await failure(unary(echo.fail.bind(echo), FailRequest.fromPartial({ code: "DATA_LOSS", reason: "TORN_PAGE" })));
    expect(e).toMatchObject({ code: "DATA_LOSS", reason: "INTERNAL", domain: "be" });
  });
});

describe("RED metrics and tracing", () => {
  it("counts every answer by service, method and code", async () => {
    const text = await h.reg.registry.metrics();
    expect(text).toMatch(/be_grpc_server_handled_total\{[^}]*service="sdktest\.echo\.v1\.EchoService",method="Get",code="OK"[^}]*\} [1-9]/);
    expect(text).toMatch(/be_grpc_server_handled_total\{[^}]*method="Get",code="UNAUTHENTICATED"[^}]*\} [1-9]/);
    expect(text).toMatch(/be_grpc_server_duration_seconds_count\{[^}]*method="BatchGet"/);
  });

  it("continues the caller's trace in a server span from the member's tracer", async () => {
    const tp = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    await rawCall("get", { id: "traced" }, md({ "be-caller": "erp/sales", traceparent: tp }));
    await h.flushSpans();
    const span = h.spans.getFinishedSpans().find((s) => s.spanContext().traceId === "4bf92f3577b34da6a3ce929d0e0e4736");
    expect(span).toMatchObject({ name: "sdktest.echo.v1.EchoService/Get", kind: 1 /* SERVER */ });
    expect(span!.parentSpanContext?.spanId).toBe("00f067aa0ba902b7");
    expect(span!.resource.attributes["service.name"]).toBe(SERVER_ID);
    expect(span!.attributes).toMatchObject({ "rpc.system": "grpc", "rpc.service": "sdktest.echo.v1.EchoService", "rpc.method": "Get", "rpc.grpc.status_code": 0 });
    const line = h.log.lines.find((l) => l.trace_id === "4bf92f3577b34da6a3ce929d0e0e4736");
    expect(line).toBeDefined();
    expect(line.request_id).toBe("4bf92f3577b34da6a3ce929d0e0e4736"); // no x-request-id: the trace ID
  });
});

describe("registration (P7.5, P7.11)", () => {
  const deps = () => ({
    memberId: SERVER_ID, locale: "en", catalog: componentCatalog(SERVER_ID, undefined), logger: captureLogger().logger,
    metrics: newMemberRegistry(SERVER_ID), tracer: Telemetry.create("", { namespace: "t", environment: "t" }).member(SERVER_ID, "1").tracer,
    maxConnectionAgeMs: 300_000,
  });
  it("refuses a streaming rpc", () => {
    expect(() => buildGrpcServer(deps()).addService(WatchServiceService, { watch: () => {} }, { schema: protoMetadata })).toThrow(/streaming.*P7\.11/);
  });
  it("refuses a service whose schema does not describe it, and an unknown user-facing name", () => {
    expect(() => buildGrpcServer(deps()).addService(EchoServiceService, {}, { schema: limitsMetadata })).toThrow(/not in the schema/);
    expect(() => buildGrpcServer(deps()).addService(EchoServiceService, {}, { schema: protoMetadata, userFacing: ["Nope"] })).toThrow(/Nope/);
  });
  it("sets the server options explicitly", () => {
    const s = buildGrpcServer({ ...deps(), maxConnectionAgeMs: 1234 });
    const opts = (s.server as any).options;
    expect(opts).toMatchObject({ "grpc.max_receive_message_length": 4 << 20, "grpc.max_connection_age_ms": 1234, "grpc.max_connection_age_grace_ms": 30_000 });
  });
  it("refuses a request above 4 MiB", async () => {
    const big = "x".repeat(5 << 20);
    const { err } = await rawCall("get", { id: big }, md({ "be-caller": CLIENT_ID }));
    expect(err.code).toBe(8); // RESOURCE_EXHAUSTED, by grpc-js before any handler
  });
  it("listens on IPv4 and IPv6 loopback", async () => {
    const { credentials } = await import("@grpc/grpc-js");
    for (const host of ["127.0.0.1", "[::1]"]) {
      const c = new EchoServiceClient(`${host}:${h.port}`, credentials.createInsecure());
      const r = await new Promise<any>((res) => c.get(GetRequest.fromPartial({ id: "v6" }), md({ "be-caller": CLIENT_ID }), (e, x) => res(e ?? x)));
      expect(r.caller).toBe(CLIENT_ID);
      c.close();
    }
  });
});

import { context, trace } from "@opentelemetry/api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { VerifiedUser } from "../../../src/auth/jwt.js";
import { runUnit, Unit } from "../../../src/context.js";
import { BeError } from "../../../src/errors/beError.js";
import { unary, type GrpcClients } from "../../../src/grpc/clients.js";
import { DependencyAbsentError } from "../../../src/errors/dependencyAbsent.js";
import { Telemetry } from "../../../src/obs/telemetry.js";
import { CreateRequest, EchoServiceClient, GetRequest, SlowRequest, protoMetadata } from "../../gen/sdktest/v1/echo.js";
import { CLIENT_ID, echoHarness, SERVER_ID, type EchoHarness } from "../../support/grpcEcho.js";

let h: EchoHarness;
let clients: GrpcClients;
let creg: ReturnType<EchoHarness["clients"]>["reg"];
let echo: InstanceType<typeof EchoServiceClient>;

beforeAll(async () => {
  h = await echoHarness();
  ({ clients, reg: creg } = h.clients());
  echo = clients.client(EchoServiceClient, SERVER_ID, protoMetadata);
});
afterAll(async () => {
  await h.close();
});

const get = (c: InstanceType<typeof EchoServiceClient>, id: string, failFirst = 0) => unary(c.get.bind(c), GetRequest.fromPartial({ id, failFirst }));
const slow = (c: InstanceType<typeof EchoServiceClient>, ms: number) => unary(c.slow.bind(c), SlowRequest.fromPartial({ ms }));

function unit(deadlineInMs: number, extra: Partial<Unit> = {}): Unit {
  const u = new Unit({ memberId: CLIENT_ID, deadline: Date.now() + deadlineInMs, signal: new AbortController().signal, requestId: "rid-client" });
  return Object.assign(u, extra);
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

describe("connections (P7.6)", () => {
  it("one cached channel per (dependency, port); 50 calls over one TCP connection", async () => {
    expect(clients.conn(SERVER_ID)).toBe(clients.conn(SERVER_ID, "grpc"));
    const other = clients.client(EchoServiceClient, SERVER_ID, protoMetadata);
    h.peers.clear();
    await Promise.all(Array.from({ length: 50 }, (_, i) => get(i % 2 ? echo : other, `conn${i}`)));
    expect(h.peers.size).toBe(1);
  });

  it("a component closing its client does not close the shared channel", async () => {
    const mine = clients.client(EchoServiceClient, SERVER_ID, protoMetadata);
    mine.close();
    expect((await get(echo, "after-close")).id).toBe("after-close");
  });

  it("an absent dependency is DependencyAbsentError, not an empty address", () => {
    expect(() => clients.conn("sdktest/absent")).toThrow(DependencyAbsentError);
    expect(() => clients.familyConn("IAM_GRPC_URL")).toThrow(DependencyAbsentError);
  });

  it("a slot family's *_GRPC_URL is dialled the same way", async () => {
    const authz = clients.familyClient(EchoServiceClient, "AUTHZ_GRPC_URL", protoMetadata);
    expect((await get(authz, "family")).caller).toBe(CLIENT_ID);
  });

  it("an unreachable dependency is UNAVAILABLE / DEPENDENCY_UNAVAILABLE naming it (stage-B ruling)", async () => {
    const dead = clients.client(EchoServiceClient, "sdktest/dead", protoMetadata);
    const e = await failure(unary(dead.create.bind(dead), CreateRequest.fromPartial({ id: "x" })));
    expect(e).toMatchObject({ code: "UNAVAILABLE", reason: "DEPENDENCY_UNAVAILABLE", domain: "be", metadata: { dependency: "sdktest/dead" } });
  });
});

describe("metadata (P7.2)", () => {
  it("carries be-caller, be-actor-sub and be-actor-act of the unit's user, x-request-id and the caller's traceparent", async () => {
    const user = { sub: "u-42", act: { sub: "agent-1", kind: "agent" } } as unknown as VerifiedUser;
    const tracer = Telemetry.create("", { namespace: "t", environment: "t" }).member(CLIENT_ID, "1").tracer;
    const span = tracer.startSpan("caller");
    const r = await context.with(trace.setSpan(context.active(), span), () => runUnit(unit(5_000, { user }), () => get(echo, "meta")));
    span.end();
    expect(r).toMatchObject({ caller: CLIENT_ID, actorSub: "u-42", actorAct: '{"sub":"agent-1","kind":"agent"}', requestId: "rid-client" });
    expect(r.traceparent).toContain(span.spanContext().traceId);
    expect(r.traceparent).toContain(span.spanContext().spanId);
  });

  it("background work: be-caller always, no actor, a fresh request ID", async () => {
    const r = await get(echo, "bg");
    expect(r).toMatchObject({ caller: CLIENT_ID, actorSub: "", actorAct: "" });
    expect(r.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("in a shell, each member's calls carry that member's ID", async () => {
    const { clients: b } = h.clients("sdktest/other");
    const c = b.client(EchoServiceClient, SERVER_ID, protoMetadata);
    expect((await get(c, "member-b")).caller).toBe("sdktest/other");
  });

  it("a system call relays the actor it received", async () => {
    const u = unit(5_000, { system: { caller: "erp/sales", actorSub: "u-7", act: '{"sub":"x","kind":"agent"}' } });
    const r = await runUnit(u, () => get(echo, "relay"));
    expect(r).toMatchObject({ caller: CLIENT_ID, actorSub: "u-7", actorAct: '{"sub":"x","kind":"agent"}' });
  });
});

describe("deadlines (P7.7)", () => {
  it("min(3 s, remaining − 50 ms), observed by the server as the call's deadline", async () => {
    const long = await runUnit(unit(60_000), () => slow(echo, 0));
    expect(long.deadlineRemainingMs).toBeGreaterThan(2_800);
    expect(long.deadlineRemainingMs).toBeLessThanOrEqual(3_000);
    const short = await runUnit(unit(1_000), () => slow(echo, 0));
    expect(short.deadlineRemainingMs).toBeGreaterThan(800);
    expect(short.deadlineRemainingMs).toBeLessThanOrEqual(950);
    const none = await slow(echo, 0); // background work: 3 s
    expect(none.deadlineRemainingMs).toBeLessThanOrEqual(3_000);
  });

  it("under 50 ms remaining the call is not sent: DEADLINE_EXCEEDED / DEADLINE_BUDGET_EXHAUSTED", async () => {
    const e = await failure(runUnit(unit(30), () => get(echo, "too-late")));
    expect(e).toMatchObject({ code: "DEADLINE_EXCEEDED", reason: "DEADLINE_BUDGET_EXHAUSTED", domain: "be" });
    expect(h.attempts.has("too-late")).toBe(false);
  });
});

describe("transaction guard (P8.4)", () => {
  it("a call inside a transaction is refused as INTERNAL / NETWORK_IN_TX and never sent", async () => {
    const tx = unit(5_000).forTx();
    const e = await failure(runUnit(tx, () => get(echo, "in-tx")));
    expect(e).toMatchObject({ code: "INTERNAL", reason: "NETWORK_IN_TX", domain: "be" });
    expect(h.attempts.has("in-tx")).toBe(false);
  });
});

describe("bulkhead (P7.9)", () => {
  it("the 65th concurrent call fails at once with RESOURCE_EXHAUSTED / OUTBOUND_LIMIT; nothing is queued", async () => {
    const hung = Array.from({ length: 64 }, () => slow(echo, 700));
    await new Promise((r) => setTimeout(r, 50));
    expect(await creg.registry.metrics()).toMatch(/be_outbound_inflight\{[^}]*target="sdktest\/echo"[^}]*\} 64/);
    const t0 = Date.now();
    const e = await failure(slow(echo, 0));
    expect(Date.now() - t0).toBeLessThan(100);
    expect(e).toMatchObject({ code: "RESOURCE_EXHAUSTED", reason: "OUTBOUND_LIMIT", domain: "be", metadata: { target: "sdktest/echo" } });
    await Promise.all(hung);
    expect((await get(echo, "after-bulkhead")).id).toBe("after-bulkhead");
    expect(await creg.registry.metrics()).toMatch(/be_outbound_inflight\{[^}]*target="sdktest\/echo"[^}]*\} 0/);
  });
});

describe("client RED metrics", () => {
  it("count calls by target, method and code", async () => {
    const text = await creg.registry.metrics();
    expect(text).toMatch(/be_grpc_client_handled_total\{[^}]*target="sdktest\/echo",method="sdktest\.echo\.v1\.EchoService\/Get",code="OK"[^}]*\} [1-9]/);
    expect(text).toMatch(/be_grpc_client_handled_total\{[^}]*method="sdktest\.echo\.v1\.EchoService\/Get",code="INTERNAL"[^}]*\} 1/); // the NETWORK_IN_TX refusal
    expect(text).toMatch(/be_grpc_client_duration_seconds_count\{[^}]*target="sdktest\/echo",method="sdktest\.echo\.v1\.EchoService\/Slow"/);
  });
});

describe("retries from the contract (P7.8)", () => {
  // own server = own target = own grpc-js retry budget
  let r: EchoHarness;
  let c: InstanceType<typeof EchoServiceClient>;
  beforeAll(async () => {
    r = await echoHarness();
    c = r.clients().clients.client(EchoServiceClient, SERVER_ID, protoMetadata);
  });
  afterAll(async () => {
    await r.close();
  });

  it("a NO_SIDE_EFFECTS method is retried on UNAVAILABLE: 3 attempts in total", async () => {
    expect((await get(c, "twice", 2)).attempts).toBe(3);
    const e = await failure(get(c, "always", 99));
    expect(e).toMatchObject({ code: "UNAVAILABLE", reason: "NOT_READY", domain: "be" });
    expect(r.attempts.get("always")).toBe(3);
  });

  it("a method without an idempotency level is not retried", async () => {
    const e = await failure(unary(c.create.bind(c), CreateRequest.fromPartial({ id: "create", failFirst: 1 })));
    expect(e).toMatchObject({ code: "UNAVAILABLE", reason: "NOT_READY" });
    expect(r.attempts.get("create")).toBe(1);
  });
});

import { createServer, type IncomingHttpHeaders } from "node:http";
import { context, trace } from "@opentelemetry/api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runUnit, Unit } from "../../../src/context.js";
import { newMemberRegistry } from "../../../src/obs/metrics.js";
import { Telemetry } from "../../../src/obs/telemetry.js";
import { ExternalHttp, UserHttp } from "../../../src/outbound/http.js";

let base: string;
let seen: IncomingHttpHeaders[] = [];
let hold: (() => void)[] = [];
const server = createServer((req, res) => {
  seen.push(req.headers);
  if (req.url === "/problem") {
    res.writeHead(400, { "content-type": "application/problem+json" });
    return res.end(JSON.stringify({ code: "FAILED_PRECONDITION", reason: "INSUFFICIENT_STOCK", domain: "erp/inventory", metadata: { available: "2" } }));
  }
  if (req.url === "/hang") return void hold.push(() => res.end("{}"));
  if (req.url === "/plain500") return void res.writeHead(502).end("bad gateway");
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ ok: true, path: req.url }));
});
const tel = Telemetry.create("", {}).member("sdktest/basic", "3.0.0");
const metrics = newMemberRegistry("sdktest/basic");

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  for (const h of hold) h();
  await new Promise((r) => server.close(r));
});

function userUnit(over: Partial<Unit> = {}): Unit {
  const u = new Unit({ memberId: "sdktest/basic", deadline: Date.now() + 10_000, signal: new AbortController().signal, requestId: "rq-9" });
  u.user = { sub: "u_me" } as Unit["user"];
  u.setToken("aaa.bbb.ccc");
  return Object.assign(u, over);
}
const inUnit = <T>(u: Unit, fn: () => Promise<T>) => {
  const span = tel.tracer.startSpan("parent");
  return context.with(trace.setSpan(context.active(), span), () => runUnit(u, fn));
};
const user = () => new UserHttp({ memberId: "sdktest/basic", dependency: "erp/inventory", address: base, metrics });

describe("UserHttp (P8.1, P8.2)", () => {
  it("forwards the caller's token, request id and trace context", async () => {
    seen = [];
    expect(await inUnit(userUnit(), () => user().json("GET", "/stock"))).toEqual({ ok: true, path: "/stock" });
    expect(seen[0]).toMatchObject({ authorization: "Bearer aaa.bbb.ccc", "x-request-id": "rq-9" });
    expect(seen[0]!.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
  });
  it("refuses without a user, and inside a transaction", async () => {
    const noUser = new Unit({ memberId: "sdktest/basic", deadline: Date.now() + 1000, signal: new AbortController().signal });
    await expect(inUnit(noUser, () => user().json("GET", "/x"))).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(inUnit(userUnit().forTx(), () => user().json("GET", "/x"))).rejects.toMatchObject({ code: "INTERNAL", reason: "NETWORK_IN_TX" });
  });
  it("restores a problem+json answer as the same code, reason and domain", async () => {
    await expect(inUnit(userUnit(), () => user().json("GET", "/problem"))).rejects.toMatchObject({ code: "FAILED_PRECONDITION", reason: "INSUFFICIENT_STOCK", domain: "erp/inventory", metadata: { available: "2" } });
    await expect(inUnit(userUnit(), () => user().json("GET", "/plain500"))).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });
  it("gives the call min(3 s, remaining − 50 ms) and refuses under 50 ms", async () => {
    const short = userUnit({ deadline: Date.now() + 30 } as Partial<Unit>);
    await expect(inUnit(short, () => user().json("GET", "/x"))).rejects.toMatchObject({ code: "DEADLINE_EXCEEDED", reason: "DEADLINE_BUDGET_EXHAUSTED" });
    const t0 = Date.now();
    const soon = userUnit({ deadline: Date.now() + 300 } as Partial<Unit>);
    await expect(inUnit(soon, () => user().json("GET", "/hang"))).rejects.toMatchObject({ code: "DEADLINE_EXCEEDED" });
    expect(Date.now() - t0).toBeLessThan(600);
  });
  it("allows 64 concurrent calls per dependency and refuses the 65th at once", async () => {
    const u = user();
    const calls = Array.from({ length: 64 }, () => inUnit(userUnit(), () => u.json("GET", "/hang")).catch(() => undefined));
    await new Promise((r) => setTimeout(r, 100));
    await expect(inUnit(userUnit(), () => u.json("GET", "/x"))).rejects.toMatchObject({ code: "RESOURCE_EXHAUSTED", reason: "OUTBOUND_LIMIT" });
    for (const h of hold.splice(0)) h();
    await Promise.all(calls);
    expect(await metrics.registry.metrics()).toContain('be_http_client_requests_total{target="erp/inventory",method="GET",status_code="200"');
  });
});

describe("ExternalHttp (P8.3)", () => {
  it("sends no internal header", async () => {
    seen = [];
    const ext = new ExternalHttp({ memberId: "sdktest/basic", name: "dingtalk", metrics, timeoutMs: 1000 });
    const r = await inUnit(userUnit(), () => ext.fetch(`http://${base}/hook`, { headers: { "x-custom": "1" } }));
    expect(r.status).toBe(200);
    expect(seen[0]!.authorization).toBeUndefined();
    expect(seen[0]!["x-request-id"]).toBeUndefined();
    expect(seen[0]!["x-custom"]).toBe("1");
    await expect(inUnit(userUnit().forTx(), () => ext.fetch(`http://${base}/hook`))).rejects.toMatchObject({ reason: "NETWORK_IN_TX" });
  });
});

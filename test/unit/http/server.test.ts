import { connect } from "node:net";
import { trace } from "@opentelemetry/api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BundleSource } from "../../../src/auth/bundle.js";
import { AUTHENTICATED, PUBLIC } from "../../../src/auth/guard.js";
import { JwtVerifier } from "../../../src/auth/jwt.js";
import { access } from "../../../src/auth/access.js";
import { requestId, signal } from "../../../src/context.js";
import { beError } from "../../../src/errors/beError.js";
import { componentCatalog } from "../../../src/errors/catalog.js";
import { buildHttpServer, type HttpServer } from "../../../src/http/server.js";
import { newMemberRegistry } from "../../../src/obs/metrics.js";
import { Telemetry } from "../../../src/obs/telemetry.js";
import { captureLogger } from "../../support/capture.js";
import { bundle, fakeAuthz, type FakeAuthz } from "../../support/fakeAuthz.js";
import { fakeIam, type FakeIam } from "../../support/fakeIam.js";

let iam: FakeIam;
let authz: FakeAuthz;
let srv: HttpServer;
let base: string;
let bundleSrc: BundleSource;
const log = captureLogger();
const reg = newMemberRegistry("sdktest/basic");
let ready = { ok: false, waiting: ["bundle", "db_identity"] };
let aborted = false;

beforeAll(async () => {
  iam = await fakeIam();
  authz = await fakeAuthz(bundle({ rep: ["sdktest.basic.view"] }, { stale_since: { u_stale: Math.floor(Date.now() / 1000) + 100 } }));
  bundleSrc = new BundleSource({ authzUrl: authz.url });
  const tel = Telemetry.create("", { namespace: "t", environment: "test" }).member("sdktest/basic", "3.0.0");
  srv = buildHttpServer({
    memberId: "sdktest/basic", locale: "en", catalog: componentCatalog("sdktest/basic", undefined), logger: log.logger, metrics: reg,
    tracer: tel.tracer, defaultTimeoutMs: 10_000,
    auth: { verifier: new JwtVerifier({ jwksUrl: `${iam.url}/.well-known/jwks.json`, issuer: iam.issuer, audience: iam.tenant }), bundle: bundleSrc },
    ops: { readiness: () => ready, info: () => ({ component_id: "sdktest/basic" }) },
  });
  const r = srv.router;
  r.get("/open", PUBLIC, async () => ({ traceId: trace.getActiveSpan()?.spanContext().traceId, rid: requestId() }));
  r.get("/me", AUTHENTICATED, async () => ({ sub: access().user().sub }));
  r.get("/things/:id", "sdktest.basic.view", async (req) => ({ id: (req.params as { id: string }).id, has: access().has("sdktest.basic.view") }));
  r.post("/upload", PUBLIC, async (req) => ({ n: JSON.stringify(req.body).length }));
  r.post("/upload-big", PUBLIC, async (req) => ({ n: JSON.stringify(req.body).length }), { bodyLimit: 4 << 20 });
  r.get("/slow", PUBLIC, async () => {
    const s = signal()!;
    await new Promise((res) => setTimeout(res, 400));
    aborted = s.aborted;
    return { done: true };
  }, { timeoutMs: 100 });
  r.get("/fail", PUBLIC, async () => { throw beError("FAILED_PRECONDITION", "THING_NOT_DRAFT", { status: "APPROVED" }, "not a draft"); });
  r.get("/crash", PUBLIC, async () => { throw new Error("SELECT secret FROM x failed"); });
  base = await srv.listen(0);
});
afterAll(async () => {
  await srv.close();
  await iam.close();
  await authz.close();
});

const get = (path: string, headers: Record<string, string> = {}) => fetch(base + path, { headers });

describe("operations endpoints (P1.3, P1.4, P3.12, P20)", () => {
  it("listens on IPv4 and IPv6 loopback (P1.13)", async () => {
    const port = new URL(base).port;
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
    expect((await fetch(`http://[::1]:${port}/healthz`)).status).toBe(200);
  });
  it("/healthz answers 200 for GET and HEAD", async () => {
    expect((await get("/healthz")).status).toBe(200);
    expect((await fetch(base + "/healthz", { method: "HEAD" })).status).toBe(200);
  });
  it("/readyz answers 503 NOT_READY with what is missing, then 200", async () => {
    const r = await get("/readyz");
    expect(r.status).toBe(503);
    expect(r.headers.get("content-type")).toContain("application/problem+json");
    expect(await r.json()).toMatchObject({ reason: "NOT_READY", domain: "be", metadata: { waiting: "bundle,db_identity" } });
    ready = { ok: true, waiting: [] };
    expect((await get("/readyz")).status).toBe(200);
  });
  it("/_be/info and /metrics", async () => {
    expect(await (await get("/_be/info")).json()).toEqual({ component_id: "sdktest/basic" });
    await get("/sdktest/basic/open");
    reg.meter.createCounter("widgets_made").add(2);
    const m = await (await get("/metrics")).text();
    expect(m).toMatch(/widgets_made(_total)?\{[^}]*component="sdktest\/basic"[^}]*\} 2/);
    expect(m).toMatch(/be_http_server_requests_total\{method="GET",route="\/sdktest\/basic\/open",status_code="200",component="sdktest\/basic"\} \d/);
  });
});

describe("request headers (P3.2, P3.3)", () => {
  it("keeps an inbound X-Request-Id and continues the caller's trace", async () => {
    const r = await get("/sdktest/basic/open", { "x-request-id": "rq-1", traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" });
    expect(r.headers.get("x-request-id")).toBe("rq-1");
    expect(await r.json()).toEqual({ traceId: "4bf92f3577b34da6a3ce929d0e0e4736", rid: "rq-1" });
  });
  it("uses the trace ID when no request ID came", async () => {
    const r = await get("/sdktest/basic/open");
    const body = (await r.json()) as { traceId: string; rid: string };
    expect(r.headers.get("x-request-id")).toBe(body.traceId);
    expect(body.rid).toBe(body.traceId);
  });
});

describe("guards (P5, P6.2, P1.5)", () => {
  it("401 without a token, 503 before the bundle, then 403 / 200 by key", async () => {
    let r = await get("/sdktest/basic/things/1");
    expect([r.status, ((await r.json()) as { reason: string }).reason]).toEqual([401, "TOKEN_INVALID"]);
    const tok = { authorization: `Bearer ${await iam.sign()}` };
    r = await get("/sdktest/basic/things/1", tok);
    expect([r.status, ((await r.json()) as { reason: string }).reason]).toEqual([503, "AUTHZ_NOT_READY"]);
    await bundleSrc.fetchOnce();
    r = await get("/sdktest/basic/things/1", tok);
    expect(await r.json()).toEqual({ id: "1", has: true });
    r = await get("/sdktest/basic/things/1", { authorization: `Bearer ${await iam.sign({ roles: ["other"] })}` });
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ reason: "MISSING_PERMISSION", metadata: { permission: "sdktest.basic.view" } });
    expect(await (await get("/sdktest/basic/me", tok)).json()).toEqual({ sub: "u_me" });
  });
  it("answers a stale token 401 TOKEN_STALE with WWW-Authenticate", async () => {
    await bundleSrc.fetchOnce();
    const r = await get("/sdktest/basic/me", { authorization: `Bearer ${await iam.sign({ sub: "u_stale" })}` });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toBe('Bearer error="token_stale"');
    expect(((await r.json()) as { reason: string }).reason).toBe("TOKEN_STALE");
  });
  it("logs sub and perm on a protected route's access line, never the token", async () => {
    const t = await iam.sign();
    await get("/sdktest/basic/things/2", { authorization: `Bearer ${t}` });
    const line = log.lines.filter((l) => l.msg === "http_request" && l["http.route"] === "/sdktest/basic/things/:id").at(-1);
    expect(line).toMatchObject({ sub: "u_me", perm: "sdktest.basic.view", "http.request.method": "GET", "http.response.status_code": 200 });
    expect(line.trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(log.lines)).not.toContain(t);
  });
});

describe("limits and deadlines (P3.4–P3.6)", () => {
  const big = JSON.stringify({ x: "a".repeat(2 << 20) });
  it("413 BODY_TOO_LARGE above 1 MiB unless the route declares more", async () => {
    const r = await fetch(base + "/sdktest/basic/upload", { method: "POST", body: big, headers: { "content-type": "application/json" } });
    expect(r.status).toBe(413);
    expect(((await r.json()) as { reason: string }).reason).toBe("BODY_TOO_LARGE");
    expect((await fetch(base + "/sdktest/basic/upload-big", { method: "POST", body: big, headers: { "content-type": "application/json" } })).status).toBe(200);
  });
  it("504 DEADLINE_EXCEEDED at the route deadline, cancelling the handler's signal", async () => {
    const r = await get("/sdktest/basic/slow");
    expect(r.status).toBe(504);
    expect(await r.json()).toMatchObject({ code: "DEADLINE_EXCEEDED", reason: "DEADLINE_BUDGET_EXHAUSTED", domain: "be" });
    await new Promise((res) => setTimeout(res, 400));
    expect(aborted).toBe(true);
  });
  it("disconnects a client that sends headers slowly within 6 s", async () => {
    const port = Number(new URL(base).port);
    const t0 = Date.now();
    await new Promise<void>((res) => {
      const s = connect(port, "127.0.0.1", () => s.write("GET /healthz HTTP/1.1\r\nHost: x\r\n"));
      s.on("data", () => {});
      s.on("close", () => res());
    });
    expect(Date.now() - t0).toBeLessThan(6_500);
  }, 10_000);
});

describe("errors (P4)", () => {
  it("renders a component error with its own domain", async () => {
    const r = await get("/sdktest/basic/fail");
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ type: "urn:be:sdktest/basic:THING_NOT_DRAFT", code: "FAILED_PRECONDITION", domain: "sdktest/basic", metadata: { status: "APPROVED" }, instance: "/sdktest/basic/fail" });
  });
  it("hides an unexpected error behind INTERNAL and logs it at ERROR", async () => {
    const r = await get("/sdktest/basic/crash");
    const body = (await r.json()) as Record<string, string>;
    expect(r.status).toBe(500);
    expect(body).toMatchObject({ reason: "INTERNAL", domain: "be" });
    expect(JSON.stringify(body)).not.toContain("SELECT");
    expect(body.trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(log.lines.find((l) => l.level === "error" && String(l.error).includes("SELECT secret"))).toBeDefined();
  });
  it("answers a body that does not parse 400 REQUEST_INVALID of domain be, with a catalogue title", async () => {
    const r = await fetch(base + "/sdktest/basic/upload", { method: "POST", body: "{not json", headers: { "content-type": "application/json" } });
    expect(r.status).toBe(400);
    const body = (await r.json()) as Record<string, string>;
    expect(body).toMatchObject({ code: "INVALID_ARGUMENT", reason: "REQUEST_INVALID", domain: "be" });
    expect(body.title).toBeTruthy();
  });
  it("answers an unknown path 404 NOT_FOUND as a problem", async () => {
    const r = await get("/nope");
    expect(r.status).toBe(404);
    expect(((await r.json()) as { reason: string }).reason).toBe("NOT_FOUND");
  });
});

describe("errorDomain (P4.1, rc.2 Spec.errorDomain)", () => {
  it("a slot-family member answers its own errors with the family's ID", async () => {
    const s = buildHttpServer({
      memberId: "infra/iam-casdoor", errorDomain: "infra/iam", locale: "en", catalog: componentCatalog("infra/iam", undefined), logger: log.logger,
      metrics: newMemberRegistry("infra/iam-casdoor"), tracer: Telemetry.create("", {}).member("infra/iam-casdoor", "3.0.0").tracer, defaultTimeoutMs: 10_000,
      auth: { verifier: undefined, bundle: undefined }, ops: { readiness: () => ({ ok: true, waiting: [] }), info: () => ({}) },
    });
    s.router.get("/x", PUBLIC, async () => { throw beError("FAILED_PRECONDITION", "USER_DISABLED"); });
    const b = await s.listen(0);
    const body = (await (await fetch(`${b}/infra/iam-casdoor/x`)).json()) as Record<string, string>;
    await s.close();
    expect([body.domain, body.type]).toEqual(["infra/iam", "urn:be:infra/iam:USER_DISABLED"]);
  });
});

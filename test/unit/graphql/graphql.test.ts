import { createSchema } from "graphql-yoga";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BundleSource } from "../../../src/auth/bundle.js";
import { access } from "../../../src/auth/access.js";
import { JwtVerifier } from "../../../src/auth/jwt.js";
import { componentCatalog } from "../../../src/errors/catalog.js";
import { beError } from "../../../src/errors/beError.js";
import { createBatchGetLoader } from "../../../src/dataloader.js";
import { guard, mountGraphQL } from "../../../src/graphql/graphql.js";
import { PUBLIC } from "../../../src/auth/guard.js";
import { buildHttpServer, type HttpServer } from "../../../src/http/server.js";
import { newMemberRegistry } from "../../../src/obs/metrics.js";
import { Telemetry } from "../../../src/obs/telemetry.js";
import { captureLogger } from "../../support/capture.js";
import { fakeAuthz, type FakeAuthz } from "../../support/fakeAuthz.js";
import { fakeIam, type FakeIam } from "../../support/fakeIam.js";

let iam: FakeIam;
let authz: FakeAuthz;
let srv: HttpServer;
let base: string;

const typeDefs = `type Query { hello: String, me: String, secret: String, boom: String, refused: String }`;
const ops: Record<string, string> = {
  hello: "{ hello }", me: "{ me }", secret: "{ secret }", boom: "{ boom }", refused: "{ refused }",
};

beforeAll(async () => {
  iam = await fakeIam();
  authz = await fakeAuthz();
  const bundle = new BundleSource({ authzUrl: authz.url });
  await bundle.fetchOnce();
  const log = captureLogger("infra/bff-mobile");
  srv = buildHttpServer({
    memberId: "infra/bff-mobile", locale: "en", catalog: componentCatalog("infra/bff-mobile", undefined), logger: log.logger,
    metrics: newMemberRegistry("infra/bff-mobile"), tracer: Telemetry.create("", {}).member("infra/bff-mobile", "3.0.0").tracer, defaultTimeoutMs: 10_000,
    auth: { verifier: new JwtVerifier({ jwksUrl: `${iam.url}/.well-known/jwks.json`, issuer: iam.issuer, audience: iam.tenant }), bundle },
    ops: { readiness: () => ({ ok: true, waiting: [] }), info: () => ({}) },
  });
  const schema = createSchema({
    typeDefs,
    resolvers: {
      Query: {
        hello: guard(PUBLIC, () => "world"),
        me: guard("sdktest.basic.view", () => access().user().sub),
        secret: guard("other.key", () => "no"),
        boom: guard(PUBLIC, () => { throw new Error("SELECT leaked"); }),
        refused: guard(PUBLIC, () => { throw beError("FAILED_PRECONDITION", "ORDER_LOCKED", { order: "o1" }); }),
      },
    },
  });
  mountGraphQL(srv, { schema, getPersistedOperation: (k) => ops[k] ?? null });
  base = await srv.listen(0);
});
afterAll(async () => {
  await srv.close(100);
  await iam.close();
  await authz.close();
});

const q = (op: string, headers: Record<string, string> = {}) =>
  fetch(`${base}/graphql`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ extensions: { persistedQuery: { version: 1, sha256Hash: op } } }) });

describe("GraphQL for the mobile BFF (P4.5)", () => {
  it("serves a public field", async () => {
    expect(await (await q("hello")).json()).toEqual({ data: { hello: "world" } });
  });
  it("refuses an operation that is not persisted", async () => {
    const r = await fetch(`${base}/graphql`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "{ hello }" }) });
    expect(((await r.json()) as { errors?: unknown[] }).errors?.length).toBeGreaterThan(0);
  });
  it("answers a guarded field without a token with the problem members in extensions", async () => {
    const r = await q("me");
    expect(r.status).toBe(401);
    const body = (await r.json()) as any;
    expect(body.errors[0].extensions).toMatchObject({ code: "UNAUTHENTICATED", reason: "TOKEN_INVALID", domain: "be", metadata: {} });
    expect(body.errors[0].extensions.trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(body.errors[0].extensions.request_id).toBe(r.headers.get("x-request-id"));
  });
  it("decides the key and offers access() inside the resolver", async () => {
    const t = { authorization: `Bearer ${await iam.sign()}` };
    expect(await (await q("me", t)).json()).toEqual({ data: { me: "u_me" } });
    const r = await q("secret", t);
    expect(r.status).toBe(403);
    expect(((await r.json()) as any).errors[0].extensions).toMatchObject({ code: "PERMISSION_DENIED", reason: "MISSING_PERMISSION", metadata: { permission: "other.key" } });
  });
  it("relays a component error and hides an unexpected one", async () => {
    expect(((await (await q("refused")).json()) as any).errors[0].extensions).toMatchObject({ code: "FAILED_PRECONDITION", reason: "ORDER_LOCKED", domain: "infra/bff-mobile", metadata: { order: "o1" } });
    const boom = (await (await q("boom")).json()) as any;
    expect(boom.errors[0].extensions).toMatchObject({ code: "INTERNAL", reason: "INTERNAL", domain: "be" });
    expect(JSON.stringify(boom)).not.toContain("SELECT");
  });
});

describe("createBatchGetLoader", () => {
  it("splits batches at the downstream's limit", async () => {
    const calls: number[] = [];
    const l = createBatchGetLoader(async (ids: readonly number[]) => (calls.push(ids.length), ids.map((i) => i * 2)), { maxBatchSize: 3 });
    expect(await Promise.all([1, 2, 3, 4, 5].map((i) => l.load(i)))).toEqual([2, 4, 6, 8, 10]);
    expect(calls).toEqual([3, 2]);
  });
});

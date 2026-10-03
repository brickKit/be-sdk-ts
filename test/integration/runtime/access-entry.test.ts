// Access wired into the member (P6.6–P6.13): a component that declares resource types gets the projection tables at
// migrate, pulls the changefeed as be.authz.changes, answers 404 for a record the caller cannot see, mounts
// _authz/check and _authz/explain, and answers _shares 501 CAPABILITY_UNAVAILABLE until the provider client exists.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { access } from "../../../src/auth/access.js";
import type { ResourceType } from "../../../src/auth/evaluate.js";
import { runMain, type ServeHandle } from "../../../src/runtime/main.js";
import { defineComponent } from "../../../src/runtime/spec.js";
import type { Runtime } from "../../../src/runtime/runtime.js";
import { bundle, fakeAuthz, type FakeAuthz } from "../../support/fakeAuthz.js";
import { fakeIam, type FakeIam } from "../../support/fakeIam.js";
import { createTestDb, DB_MIGRATIONS, requirePg, type TestDb } from "../../support/pg.js";

const WIDGET: ResourceType = {
  type: "sdktest.basic.widget", owner_component: "sdktest/basic", view_key: "sdktest.basic.view", dimensions: ["owner"], derivation: "direct",
  relations: { viewer: { grants: ["sdktest.basic.view"] } },
};
const O1 = "0192f0c4-0000-7000-8000-000000000001";
const O2 = "0192f0c4-0000-7000-8000-000000000002";
let db: TestDb;
let iam: FakeIam;
let authz: FakeAuthz;
let h: ServeHandle;
let tok: Record<string, string>;
const stdout = new Writable({ write(_c, _e, cb) { cb(); } });

const spec = (manifest: string) => defineComponent({
  id: "sdktest/basic", migrations: DB_MIGRATIONS, manifest, resources: [WIDGET],
  create: async (rt: Runtime) => ({
    records: { [WIDGET.type]: async (tx, id) => (await tx.query<{ id: string; owner: string }>("SELECT id::text AS id, name AS owner FROM widgets WHERE id::text = $1", [id]))[0] },
    http: (r) => r.get("/widgets/:id", "sdktest.basic.view", async (req) => {
      const id = (req.params as { id: string }).id;
      return rt.store().tx(async (tx) => {
        const [row] = await tx.query<{ id: string; owner: string }>("SELECT id::text AS id, name AS owner FROM widgets WHERE id::text = $1", [id]);
        if (!row) throw new Error("fixture row missing");
        access().require(await access().check(tx, "sdktest.basic.view", WIDGET, row));
        return row;
      });
    }),
  }),
});

beforeAll(async () => {
  db = await createTestDb(requirePg("BE_TEST_PG16"));
  iam = await fakeIam();
  authz = await fakeAuthz(bundle({ rep: ["sdktest.basic.view"] }, { capabilities: { core: true, sharing: true, relation_sync: true } }));
  const manifest = join(mkdtempSync(join(tmpdir(), "besdk-acc-")), "component.yaml");
  writeFileSync(manifest, `apiVersion: brickkit/v1
kind: Component
metadata: {id: sdktest/basic, version: 3.0.0}
configSchema:
  type: object
  properties:
    PG_HOST: {type: string}
    PG_PORT: {type: integer, default: 5432}
    PG_DATABASE: {type: string}
    PG_USER: {type: string}
    PG_PASSWORD_FILE: {type: string, secret: true, mount: file}
    PG_OWNER_USER: {type: string}
    PG_OWNER_PASSWORD_FILE: {type: string, secret: true, mount: file}
    PG_SCHEMA: {type: string}
    AUTHZ_URL: {type: string}
    IAM_URL: {type: string}
    IAM_ISSUER: {type: string}
    TENANT_ID: {type: string}
    SHUTDOWN_GRACE: {type: string, default: 5s}
  required: [PG_HOST, PG_DATABASE, PG_USER, PG_PASSWORD_FILE, PG_OWNER_USER, PG_OWNER_PASSWORD_FILE, PG_SCHEMA]
deployment:
  port: 0
  protocol: http
`);
  const env = { ...db.env, AUTHZ_URL: authz.url, IAM_URL: iam.url, IAM_ISSUER: iam.issuer, TENANT_ID: iam.tenant };
  expect(await runMain(spec(manifest), { argv: ["migrate", "up"], env, stdout })).toEqual({ exitCode: 0 });
  await db.su(`INSERT INTO "${db.schema}".widgets (id, name, created_at) VALUES ($1, 'u_me', now()), ($2, 'someone', now())`, [O1, O2]);
  const r = await runMain(spec(manifest), { argv: [], env, stdout });
  if (!("handle" in r)) throw new Error(`exited ${JSON.stringify(r)}`);
  h = r.handle;
  for (let i = 0; i < 60 && (await fetch(`${h.baseUrl}/readyz`)).status !== 200; i++) await new Promise((res) => setTimeout(res, 50));
  tok = { authorization: `Bearer ${await iam.sign()}` };
});
afterAll(async () => {
  await h?.stop();
  await iam.close();
  await authz.close();
  await db.cleanup();
});

const url = (p: string) => `${h.baseUrl}/sdktest/basic${p}`;
const post = (p: string, body: unknown) => fetch(url(p), { method: "POST", headers: { ...tok, "content-type": "application/json" }, body: JSON.stringify(body) });

describe("single records (P6.6)", () => {
  it("answers 200 for an own record and 404 NOT_FOUND for one the caller cannot see", async () => {
    expect((await fetch(url(`/widgets/${O1}`), { headers: tok })).status).toBe(200);
    const r = await fetch(url(`/widgets/${O2}`), { headers: tok });
    expect([r.status, ((await r.json()) as { reason: string }).reason]).toEqual([404, "NOT_FOUND"]);
  });
  it("a share pulled from the changefeed makes the record visible (P6.12)", async () => {
    authz.changes.push({ revision: "1", op: "upsert", tuple: { object: { type: WIDGET.type, id: O2 }, relation: "viewer", subject: "user:u_me" } });
    let status = 0;
    for (let i = 0; i < 100 && status !== 200; i++) {
      await new Promise((res) => setTimeout(res, 100));
      status = (await fetch(url(`/widgets/${O2}`), { headers: tok })).status;
    }
    expect(status).toBe(200);
  });
});

describe("resource contract (P6.10)", () => {
  it("_authz/check decides each (key, type, id); a missing record is NOT_FOUND", async () => {
    const r = await post("/_authz/check", { checks: [
      { key: "sdktest.basic.view", type: WIDGET.type, id: O1 },
      { key: "sdktest.basic.edit", type: WIDGET.type, id: O1 },
      { key: "sdktest.basic.view", type: WIDGET.type, id: "0192f0c4-0000-7000-8000-00000000ffff" },
    ] });
    expect(await r.json()).toEqual({ results: [
      { visible: true, allowed: true, reason: "" },
      { visible: true, allowed: false, reason: "MISSING_PERMISSION" },
      { visible: false, allowed: false, reason: "NOT_FOUND" },
    ] });
  });
  it("refuses more than 500 checks with BATCH_TOO_LARGE", async () => {
    const r = await post("/_authz/check", { checks: Array.from({ length: 501 }, () => ({ key: "k.k.k", type: WIDGET.type, id: O1 })) });
    expect([r.status, ((await r.json()) as { reason: string }).reason]).toEqual([400, "BATCH_TOO_LARGE"]);
  });
  it("_authz/explain gives the decision and the facts", async () => {
    const r = await fetch(url(`/_authz/explain?key=sdktest.basic.view&type=${WIDGET.type}&id=${O1}`), { headers: tok });
    const body = (await r.json()) as { decision: string; reasons: { kind: string }[] };
    expect(body.decision).toBe("allowed");
    expect(body.reasons.map((x) => x.kind)).toContain("role_key");
  });
  it("_shares answers 501 CAPABILITY_UNAVAILABLE naming the capability", async () => {
    const r = await fetch(url(`/_shares/${WIDGET.type}/${O1}`), { headers: tok });
    expect([r.status, await r.json()]).toEqual([501, expect.objectContaining({ reason: "CAPABILITY_UNAVAILABLE", metadata: { capability: "sharing" } })]);
  });
});

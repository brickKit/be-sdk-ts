// The lifecycle engine wired into the member (P16): the migrate step creates the declared tables' window (P16.6,
// CP-LIFE-01), the resource contract is mounted with the three keys (P16.4, P16.8), unimplemented operations answer
// 501, `be.lifecycle` runs as a job, tx.seal reaches the engine, a bad lifecycle.yaml exits 78.
import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PUBLIC } from "../../../src/auth/guard.js";
import { runMain } from "../../../src/runtime/main.js";
import { defineComponent } from "../../../src/runtime/spec.js";
import type { Runtime } from "../../../src/runtime/runtime.js";
import { bundle, fakeAuthz } from "../../support/fakeAuthz.js";
import { fakeIam } from "../../support/fakeIam.js";
import { createTestDb, requirePg, type TestDb } from "../../support/pg.js";

const WIDGET = fileURLToPath(new URL("../../fixtures/lifecycle/widget/migrations", import.meta.url));
let db: TestDb;
let manifest: string;
const lines: any[] = [];
const stdout = new Writable({ write(c, _e, cb) { for (const l of String(c).split("\n").filter(Boolean)) lines.push(JSON.parse(l)); cb(); } });

beforeAll(async () => {
  db = await createTestDb(requirePg("BE_TEST_PG16"));
  manifest = join(mkdtempSync(join(tmpdir(), "besdk-lc-")), "component.yaml");
  writeFileSync(manifest, `apiVersion: brickkit/v1
kind: Component
metadata: {id: conformance/widget, version: 3.0.0}
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
    SHUTDOWN_GRACE: {type: string, default: 5s}
    AUTHZ_URL: {type: string}
    IAM_URL: {type: string}
    IAM_ISSUER: {type: string}
    TENANT_ID: {type: string}
  required: [PG_HOST, PG_DATABASE, PG_USER, PG_PASSWORD_FILE, PG_OWNER_USER, PG_OWNER_PASSWORD_FILE, PG_SCHEMA]
deployment:
  port: 0
  protocol: http
`);
  expect(await runMain(spec(), { argv: ["migrate", "up"], env: db.env, stdout })).toEqual({ exitCode: 0 });
});
afterAll(async () => db.cleanup());

const spec = (migrations = WIDGET) => defineComponent({
  id: "conformance/widget", migrations, manifest,
  create: async (rt: Runtime) => ({
    http: (r) => r.post("/seal", PUBLIC, async () => rt.store().tx((tx) => tx.seal("widget_ledger", "nope"))),
  }),
});

describe("migrate (P16.6, CP-LIFE-01)", () => {
  it("creates the current partition of a declared table, so it accepts writes the day it is migrated", async () => {
    const { rows } = await db.su(`SELECT count(*)::int AS n FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhparent JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = 'widgets'`, [db.schema]);
    expect(rows[0].n).toBeGreaterThanOrEqual(4); // this month + ahead 3
  });
});

describe("job run be.lifecycle", () => {
  it("runs one round of the engine", async () => {
    expect(await runMain(spec(), { argv: ["job", "run", "be.lifecycle"], env: db.env, stdout })).toEqual({ exitCode: 0 });
  });
  it("exits 78 for a lifecycle.yaml that breaks an invariant", async () => {
    const bad = mkdtempSync(join(tmpdir(), "besdk-lc-bad-"));
    cpSync(WIDGET, bad, { recursive: true });
    writeFileSync(join(bad, "lifecycle.yaml"), "lifecycle: v1\ntenant_key: none\ntables:\n  widget_ledger: {class: ledger, pii: [phone]}\n");
    expect(await runMain(spec(bad), { argv: ["job", "run", "be.lifecycle"], env: db.env, stdout })).toEqual({ exitCode: 78 });
  });
});

describe("serving with the lifecycle resource contract (P16.4, P16.8)", () => {
  it("mounts _lifecycle/* behind the three keys; unimplemented operations answer 501", async () => {
    const iam = await fakeIam();
    const authz = await fakeAuthz(bundle({ rep: ["conformance.widget.lifecycle.read"] }));
    const r = await runMain(spec(), { argv: [], env: { ...db.env, AUTHZ_URL: authz.url, IAM_URL: iam.url, IAM_ISSUER: iam.issuer, TENANT_ID: iam.tenant }, stdout });
    if (!("handle" in r)) throw new Error(`exited ${JSON.stringify(r)}`);
    try {
      const base = `${r.handle.baseUrl}/conformance/widget/_lifecycle`;
      for (let i = 0; i < 40 && (await fetch(`${r.handle.baseUrl}/readyz`)).status !== 200; i++) await new Promise((res) => setTimeout(res, 50));
      const tok = { authorization: `Bearer ${await iam.sign()}` };
      const units = await fetch(`${base}/units?table=widgets`, { headers: tok });
      expect(units.status).toBe(200);
      const exp = await fetch(`${base}/exports`, { method: "POST", headers: { ...tok, "content-type": "application/json" }, body: "{}" });
      expect([exp.status, ((await exp.json()) as { reason: string }).reason]).toEqual([501, "CAPABILITY_UNAVAILABLE"]);
      expect((await fetch(`${base}/holds`, { headers: tok })).status).toBe(403); // admin key not granted
      const seal = await fetch(`${r.handle.baseUrl}/conformance/widget/seal`, { method: "POST" });
      // tx.seal reaches the engine: an unknown unit is its NOT_FOUND, without a seal extension it would be 501 CAPABILITY_UNAVAILABLE
      expect([seal.status, ((await seal.json()) as { reason: string }).reason]).toEqual([404, "NOT_FOUND"]);
    } finally {
      await r.handle.stop();
      await iam.close();
      await authz.close();
    }
  });
});

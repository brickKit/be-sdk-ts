// Background work wired into the member (P14, P14.8): Module.jobs / workers / reconcilers start with the member,
// tx.enqueue works in a route, `job run <name>` exits 0 / 0 (no-op) / 1 / 64 / 78, /_be/info lists job_run.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PUBLIC } from "../../../src/auth/guard.js";
import { runMain } from "../../../src/runtime/main.js";
import { defineComponent } from "../../../src/runtime/spec.js";
import type { Runtime } from "../../../src/runtime/runtime.js";
import { bundle, fakeAuthz } from "../../support/fakeAuthz.js";
import { fakeIam } from "../../support/fakeIam.js";
import { createTestDb, DB_MIGRATIONS, requirePg, type TestDb } from "../../support/pg.js";

let db: TestDb;
let manifest: string;
const lines: any[] = [];
const stdout = new Writable({ write(c, _e, cb) { for (const l of String(c).split("\n").filter(Boolean)) lines.push(JSON.parse(l)); cb(); } });
const ran: string[] = [];

beforeAll(async () => {
  db = await createTestDb(requirePg("BE_TEST_PG16"));
  const dir = mkdtempSync(join(tmpdir(), "besdk-jobs-"));
  manifest = join(dir, "component.yaml");
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
    BUSINESS_TIMEZONE: {type: string, default: Asia/Shanghai}
    JOBS_OVERRIDES: {type: string, default: ""}
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

const spec = () => defineComponent({
  id: "sdktest/basic", migrations: DB_MIGRATIONS, manifest,
  create: async (rt: Runtime) => ({
    http: (r) => r.post("/mail", PUBLIC, async () => {
      await rt.store().tx((tx) => tx.enqueue("mail", { to: "x" }));
      return { queued: true };
    }),
    jobs: [
      { name: "daily", kind: "cron", cron: "0 3 * * *", timeoutMs: 5_000, run: async () => void ran.push("daily") },
      { name: "tick", kind: "every", intervalMs: 50, timeoutMs: 5_000, run: async () => void ran.push("tick") },
      { name: "boom", kind: "every", intervalMs: 60_000, timeoutMs: 5_000, run: async () => { throw new Error("boom"); } },
    ],
    workers: [{ kind: "mail", timeoutMs: 5_000, run: async () => void ran.push("mail") }],
  }),
});
const jobRun = (name: string, env: Record<string, string> = {}) => runMain(spec(), { argv: ["job", "run", name], env: { ...db.env, ...env }, stdout });

describe("job run <name> (P14.8, CP-JOBS-06)", () => {
  it("runs a cron slot once, then is a no-op; a failure exits 1; an unknown name 64", async () => {
    expect(await jobRun("daily")).toEqual({ exitCode: 0 });
    expect(await jobRun("daily")).toEqual({ exitCode: 0 });
    expect(ran.filter((x) => x === "daily")).toEqual(["daily"]);
    expect(lines.some((l) => l.msg === "job_noop" && l.job === "daily")).toBe(true);
    expect(await jobRun("boom")).toEqual({ exitCode: 1 });
    expect(await jobRun("nope")).toEqual({ exitCode: 64 });
  });
  it("exits 78 for an invalid JOBS_OVERRIDES schedule; enabled: false does not stop it", async () => {
    expect(await jobRun("daily", { JOBS_OVERRIDES: '{"daily":{"cron":"@daily"}}' })).toEqual({ exitCode: 78 });
    expect(await jobRun("tick", { JOBS_OVERRIDES: '{"tick":{"enabled":false}}' })).toEqual({ exitCode: 0 });
  });
});

describe("serving with jobs", () => {
  it("starts the jobs and the workers, and lists job_run in /_be/info", async () => {
    const iam = await fakeIam();
    const authz = await fakeAuthz(bundle({ rep: ["sdktest.basic.ops"] }));
    const r = await runMain(spec(), { argv: [], env: { ...db.env, AUTHZ_URL: authz.url, IAM_URL: iam.url, IAM_ISSUER: iam.issuer, TENANT_ID: iam.tenant }, stdout });
    if (!("handle" in r)) throw new Error(`exited ${JSON.stringify(r)}`);
    try {
      const base = r.handle.baseUrl;
      for (let i = 0; i < 40 && (await fetch(`${base}/readyz`)).status !== 200; i++) await new Promise((res) => setTimeout(res, 50));
      const ops = await fetch(`${base}/sdktest/basic/_ops/jobs`, { headers: { authorization: `Bearer ${await iam.sign()}` } });
      const body = (await ops.json()) as { jobs: { name: string; kind: string }[]; queues: { kind: string }[] };
      expect(body.jobs.map((j) => [j.name, j.kind])).toEqual(expect.arrayContaining([["daily", "cron"], ["tick", "every"], ["mail", "queue"], ["be.cleanup", "singleton"]]));
      expect(Array.isArray(body.queues)).toBe(true);
      expect((await fetch(`${base}/sdktest/basic/_ops/jobs`, { headers: { authorization: `Bearer ${await iam.sign({ roles: ["other"] })}` } })).status).toBe(403);
      expect(((await (await fetch(`${base}/_be/info`)).json()) as { capabilities?: string[] }).capabilities).toContain("job_run");
      await fetch(`${base}/sdktest/basic/mail`, { method: "POST" });
      for (let i = 0; i < 100 && !(ran.includes("mail") && ran.filter((x) => x === "tick").length >= 2); i++) await new Promise((res) => setTimeout(res, 50));
      expect(ran).toContain("mail");
      expect(ran.filter((x) => x === "tick").length).toBeGreaterThanOrEqual(2);
    } finally {
      await r.handle.stop();
      await iam.close();
      await authz.close();
    }
    expect(await runMain(spec(), { argv: [], env: { ...db.env, JOBS_OVERRIDES: '{"daily":{"cron":"61 * * * *"}}' }, stdout })).toEqual({ exitCode: 78 });
  });
});

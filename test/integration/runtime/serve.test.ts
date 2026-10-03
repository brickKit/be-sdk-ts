// The whole member on real PostgreSQL 16 and NATS: migrate (twice), serve, readiness gated on the database
// identity and the migrations, an HTTP command that publishes through the outbox, a subscription that applies it,
// a gRPC service on the extra port, /_be/info, graceful stop (P1, P10.7, P11, P12, P20).
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { credentials, Metadata } from "@grpc/grpc-js";
import { connect } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PUBLIC } from "../../../src/auth/guard.js";
import { system } from "../../../src/context.js";
import { newId } from "../../../src/ids.js";
import { runMain, type ServeHandle } from "../../../src/runtime/main.js";
import { defineComponent } from "../../../src/runtime/spec.js";
import type { Runtime } from "../../../src/runtime/runtime.js";
import { EchoReply, EchoServiceClient, EchoServiceService, GetRequest, protoMetadata } from "../../gen/sdktest/v1/echo.js";
import { requireEnv } from "../../support/env.js";
import { createTestDb, DB_MIGRATIONS, requirePg, type TestDb } from "../../support/pg.js";
import { Writable } from "node:stream";

const nats = requireEnv("BE_TEST_NATS");
const contracts = fileURLToPath(new URL("../../fixtures/basic/contracts", import.meta.url));
const CREATED = "sdktest.basic.thing.created.v1";
let db: TestDb;
let h: ServeHandle;
let env: Record<string, string>;
let manifestPath: string;
const lines: any[] = [];
const stdout = new Writable({ write(c, _e, cb) { for (const l of String(c).split("\n").filter(Boolean)) lines.push(JSON.parse(l)); cb(); } });

function writeManifest(): string {
  const dir = mkdtempSync(join(tmpdir(), "besdk-serve-"));
  const p = join(dir, "component.yaml");
  writeFileSync(p, `apiVersion: brickkit/v1
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
    NATS_URL: {type: string}
    EVENTS_BACKOFF: {type: string, default: "100ms"}
    LOG_LEVEL: {type: string, default: info}
    SHUTDOWN_GRACE: {type: string, default: 5s}
    GRPC_MAX_CONNECTION_AGE: {type: string, default: 5m}
  required: [PG_HOST, PG_DATABASE, PG_USER, PG_PASSWORD_FILE, PG_OWNER_USER, PG_OWNER_PASSWORD_FILE, PG_SCHEMA]
deployment:
  port: 0
  protocol: http
  extraPorts:
    - {name: grpc, port: 0, protocol: grpc}
events:
  publishes: [${CREATED}]
  subscribes: [${CREATED}]
`);
  return p;
}

const spec = () => defineComponent({
  id: "sdktest/basic", migrations: DB_MIGRATIONS, contracts, manifest: manifestPath,
  create: async (rt: Runtime) => ({
    http: (r) => {
      r.post("/things", PUBLIC, async (req) => {
        const id = newId();
        const name = (req.body as { name: string }).name;
        await rt.store().tx((tx) => tx.publish({ subject: CREATED, aggregateId: id, version: 1, payload: { thing_id: id, legal_entity_id: "LE01", amount: "1.00", note: name } }));
        return { id };
      });
      r.get("/things/:id", PUBLIC, async (req) => {
        const rows = await rt.store().tx((tx) => tx.query("SELECT name FROM widgets WHERE id = $1", [(req.params as { id: string }).id]));
        return { found: rows.length === 1, name: rows[0]?.name ?? null };
      });
    },
    grpc: (s) => s.addService(EchoServiceService, {
      get: async (call: { request: { id: string } }) => EchoReply.fromPartial({ id: call.request.id, caller: system()?.caller ?? "" }),
    }, { schema: protoMetadata }),
    events: {
      publishes: [CREATED],
      subscribe: [{ subject: CREATED, apply: async (tx, ev) => void (await tx.query("INSERT INTO widgets (id, name, created_at) VALUES ($1, $2, now())", [ev.aggregateId, String(ev.payload.note)])) }],
    },
  }),
});

beforeAll(async () => {
  db = await createTestDb(requirePg("BE_TEST_PG16"));
  manifestPath = writeManifest();
  env = { ...db.env, NATS_URL: nats, COMPONENT_ID: "sdktest/basic", COMPONENT_VERSION: "3.0.0" };
  const nc = await connect({ servers: nats });
  for (const s of ["BE_SDKTEST", "BE_DLQ"]) await (await jetstreamManager(nc)).streams.delete(s).catch(() => {});
  await nc.close();
});
afterAll(async () => {
  await h?.stop();
  await db?.cleanup();
});

describe("a member end to end", () => {
  it("migrates twice, both exiting 0, and creates the streams and durable", async () => {
    expect(await runMain(spec(), { argv: ["migrate", "up"], env, stdout })).toEqual({ exitCode: 0 });
    expect(await runMain(spec(), { argv: ["migrate", "up"], env, stdout })).toEqual({ exitCode: 0 });
    const nc = await connect({ servers: nats });
    const jsm = await jetstreamManager(nc);
    expect((await jsm.consumers.info("BE_SDKTEST", "sdktest_basic__sdktest__basic__thing__created__v1")).config.max_deliver).toBe(-1);
    await nc.close();
  });

  it("serves, and is ready once the identity probe and the migrations check pass", async () => {
    const r = await runMain(spec(), { argv: [], env, stdout });
    if (!("handle" in r)) throw new Error(`exited ${JSON.stringify(r)}: ${JSON.stringify(lines.filter((l) => l.level === "error"))}`);
    h = r.handle;
    for (let i = 0; i < 100 && (await fetch(`${h.baseUrl}/readyz`)).status !== 200; i++) await new Promise((res) => setTimeout(res, 100));
    expect((await fetch(`${h.baseUrl}/readyz`)).status).toBe(200);
    const info = (await (await fetch(`${h.baseUrl}/_be/info`)).json()) as any;
    expect(info.migrations).toEqual({ component: "0002_add-note", platform: 1 });
    expect(info.ports.grpc).toBeGreaterThan(0);
    expect(info.profiles).toEqual(expect.arrayContaining(["db", "grpc", "events-pub", "events-sub"]));
  });

  it("publishes from a request through the outbox and applies the event in a subscription", async () => {
    const res = await fetch(`${h.baseUrl}/sdktest/basic/things`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "gizmo" }) });
    const created = (await res.json()) as { id: string };
    expect(res.status, JSON.stringify([created, lines.filter((l) => l.level === "error").slice(-2)])).toBe(200);
    const { id } = created;
    let got: any;
    for (let i = 0; i < 100; i++) {
      got = await (await fetch(`${h.baseUrl}/sdktest/basic/things/${id}`)).json();
      if (got.found) break;
      await new Promise((r2) => setTimeout(r2, 100));
    }
    expect(got, JSON.stringify(lines.filter((l) => l.level === "error" || l.level === "warn").slice(-5))).toEqual({ found: true, name: "gizmo" });
  });

  it("serves its gRPC service on the extra port with the system principal", async () => {
    const info = (await (await fetch(`${h.baseUrl}/_be/info`)).json()) as any;
    const c = new EchoServiceClient(`127.0.0.1:${info.ports.grpc}`, credentials.createInsecure());
    const md = new Metadata();
    md.set("be-caller", "sdktest/caller");
    const reply = await new Promise<any>((res, rej) => c.get(GetRequest.fromPartial({ id: "x1" }), md, (e, v) => (e ? rej(e) : res(v))));
    expect(reply).toMatchObject({ id: "x1", caller: "sdktest/caller" });
    c.close();
  });

  it("stops cleanly", async () => {
    await h.stop();
    await expect(fetch(`${h.baseUrl}/healthz`)).rejects.toThrow();
  });
});

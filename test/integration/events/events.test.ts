// Outbox → pump → JetStream → durable consumer → cursor, on real PostgreSQL 16 and NATS 2.12 (P12).
import { fileURLToPath } from "node:url";
import { jetstreamManager } from "@nats-io/jetstream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Config } from "../../../src/config/config.js";
import { readManifest } from "../../../src/config/manifest.js";
import { runUnit, Unit } from "../../../src/context.js";
import { EventContracts } from "../../../src/events/contracts.js";
import { EventsRuntime } from "../../../src/events/runtime.js";
import { permanent, type ConsumedEvent } from "../../../src/events/types.js";
import { newId } from "../../../src/ids.js";
import { runMigrations } from "../../../src/migrate/index.js";
import { newMemberRegistry } from "../../../src/obs/metrics.js";
import { Telemetry } from "../../../src/obs/telemetry.js";
import { Supervisor } from "../../../src/runtime/supervisor.js";
import { Store } from "../../../src/store/index.js";
import type { TxExtensions } from "../../../src/store/index.js";
import { captureLogger } from "../../support/capture.js";
import { requireEnv } from "../../support/env.js";
import { createTestDb, DB_MIGRATIONS, requirePg, type TestDb } from "../../support/pg.js";

const nats = requireEnv("BE_TEST_NATS");
const manifest = readManifest(fileURLToPath(new URL("../../fixtures/events/component.yaml", import.meta.url)));
const contracts = EventContracts.load(fileURLToPath(new URL("../../fixtures/basic/contracts", import.meta.url)));
const CREATED = "sdktest.basic.thing.created.v1";

let db: TestDb;
let store: Store;
let events: EventsRuntime;
let sup: Supervisor;
const log = captureLogger("sdktest/basic", "debug");
const metrics = newMemberRegistry("sdktest/basic");
const handled: { id: string; version: bigint; delivery: number }[] = [];
let failNext = 0;
let poison = "";

async function streamMessages(): Promise<number> {
  const jsm = await jetstreamManager(events.busConnection()!);
  return (await jsm.streams.info("BE_SDKTEST")).state.messages;
}

const waitFor = async (pred: () => boolean | Promise<boolean>, ms = 15_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timed out waiting");
};

beforeAll(async () => {
  db = await createTestDb(requirePg("BE_TEST_PG16"));
  // purge the dev stream between runs so counts start from zero
  const env = { ...db.env, NATS_URL: nats, EVENTS_BACKOFF: "100ms,200ms", EVENTS_MAX_DELIVER: "3" };
  const config = Config.load(manifest, env);
  await runMigrations({ memberId: "sdktest/basic", config, logger: log.logger, migrationsDir: DB_MIGRATIONS, direction: "up" });
  const ext: TxExtensions = {};
  store = new Store({ memberId: "sdktest/basic", config, logger: log.logger, metrics, extensions: ext });
  events = new EventsRuntime({
    memberId: "sdktest/basic", version: "3.0.0", config, logger: log.logger, metrics, store, contracts,
    tracer: Telemetry.create("", {}).member("sdktest/basic", "3.0.0").tracer,
    declaration: {
      publishes: [CREATED, "sdktest.basic.thing.renamed.v1"],
      subscribe: [{
        subject: CREATED,
        apply: async (tx, ev: ConsumedEvent) => {
          if (ev.aggregateId === poison) throw permanent(new Error("poison"));
          if (failNext > 0) {
            failNext--;
            throw new Error("transient");
          }
          handled.push({ id: ev.aggregateId, version: ev.version, delivery: ev.delivery });
          await tx.query("INSERT INTO widgets (id, name, created_at) VALUES ($1, $2, now()) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name", [ev.aggregateId, String(ev.payload.note ?? "")]);
        },
      }],
    },
  });
  Object.assign(ext, events.extensions);
  const jsmClean = await import("@nats-io/transport-node").then((m) => m.connect({ servers: nats }));
  const jsmc = await jetstreamManager(jsmClean);
  for (const st of ["BE_SDKTEST", "BE_DLQ"]) {
    await jsmc.streams.delete(st).catch(() => {});
    await waitFor(async () => (await jsmc.streams.info(st).then(() => false, () => true)));
  }
  await jsmClean.close();
  sup = new Supervisor(log.logger, { initialBackoffMs: 100 });
  events.start(sup);
  await waitFor(() => events.ready());
});

afterAll(async () => {
  await sup?.stop(5_000);
  await events?.stop();
  await store?.close();
  await db?.cleanup();
});

const tracer = Telemetry.create("", {}).member("sdktest/basic", "3.0.0").tracer;
/** publishes as a request would: inside a unit of work and a server span */
const publish = (thing: string, version: number, note = "n", le: string | null = "LE01") =>
  tracer.startActiveSpan("request", (span) =>
    runUnit(new Unit({ memberId: "sdktest/basic", deadline: Date.now() + 10_000, signal: new AbortController().signal, requestId: "rq" }), () =>
      store.tx((tx) => tx.publish({ subject: CREATED, aggregateId: thing, version, payload: { thing_id: thing, ...(le ? { legal_entity_id: le } : {}), amount: "1.00", note } })))
      .finally(() => span.end()));

describe("publishing (P12.1, P12.2)", () => {
  it("writes the outbox row in the business transaction, the pump publishes it once with full headers", async () => {
    const thing = newId();
    await publish(thing, 1, "first");
    await waitFor(() => handled.some((h) => h.id === thing));
    const rows = (await db.su(`SELECT status, hop_count, causation_id FROM "${db.schema}".besdk_outbox`)).rows;
    expect(rows).toEqual([{ status: "PUBLISHED", hop_count: 0, causation_id: "" }]);
    const jsm = await jetstreamManager(events.busConnection()!);
    const m = (await jsm.streams.getMessage("BE_SDKTEST", { seq: 1 }))!;
    expect(m.header.get("ce-type")).toBe(CREATED);
    expect(m.header.get("ce-id")).toBe(m.header.get("Nats-Msg-Id"));
    expect(m.header.get("ce-aggregatetype")).toBe("sdktest.basic.thing");
    expect(m.header.get("ce-legalentity")).toBe("LE01");
    expect(m.header.get("ce-dataschema")).toBe(`sdktest/basic@3.0.0/contracts/events/basic.events.json#${CREATED}`);
    expect(m.header.get("traceparent")).toMatch(/^00-/);
  });

  it("refuses a payload that breaks the contract or misses the legal entity, rolling the transaction back", async () => {
    await expect(publish(newId(), 1, "x", null)).rejects.toThrow(/legal_entity_id|LEGAL_ENTITY/);
    await expect(runUnit(new Unit({ memberId: "sdktest/basic", deadline: Date.now() + 5000, signal: new AbortController().signal }), () =>
      store.tx((tx) => tx.publish({ subject: "sdktest.basic.thing.deleted.v1", aggregateId: "a", version: 1, payload: {} })))).rejects.toThrow(/not declared|publishes/);
  });
});

describe("consuming (P12.5–P12.8)", () => {
  it("applies each aggregate version once, skips duplicates and older versions", async () => {
    const thing = newId();
    await publish(thing, 3, "v3");
    await publish(thing, 2, "v2");
    await publish(thing, 3, "v3-again");
    await waitFor(async () => (await streamMessages()) >= 4);
    await new Promise((r) => setTimeout(r, 500));
    expect(handled.filter((h) => h.id === thing).map((h) => h.version)).toEqual([3n]);
    const cur = (await db.su(`SELECT version FROM "${db.schema}".besdk_event_cursor WHERE aggregate_id = $1`, [thing])).rows;
    expect(cur).toEqual([{ version: "3" }]);
  });

  it("naks a failing handler with the runtime's delay and applies on redelivery", async () => {
    const thing = newId();
    failNext = 1;
    await publish(thing, 1);
    await waitFor(() => handled.some((h) => h.id === thing));
    expect(handled.find((h) => h.id === thing)!.delivery).toBe(2);
  });

  it("dead-letters a permanent error at once and a message above EVENTS_MAX_DELIVER", async () => {
    poison = newId();
    await publish(poison, 1);
    const jsm = await jetstreamManager(events.busConnection()!);
    const durable = "sdktest_basic__sdktest__basic__thing__created__v1";
    await waitFor(async () => (await jsm.streams.getMessage("BE_DLQ", { last_by_subj: `dlq.${durable}.${CREATED}` }).catch(() => null))?.header.get("ce-subject") === poison);
    const last = (await jsm.streams.getMessage("BE_DLQ", { last_by_subj: `dlq.${durable}.${CREATED}` }))!;
    expect(last.header.get("be-dlq-reason")).toBe("PERMANENT");
    expect(last.header.get("be-dlq-consumer")).toBe(durable);
    expect(last.header.get("ce-subject")).toBe(poison);
    const thing = newId();
    failNext = 99;
    await publish(thing, 1);
    await waitFor(async () => {
      const m = await jsm.streams.getMessage("BE_DLQ", { last_by_subj: `dlq.${durable}.${CREATED}` }).catch(() => undefined);
      return m?.header.get("ce-subject") === thing;
    });
    const m2 = (await jsm.streams.getMessage("BE_DLQ", { last_by_subj: `dlq.${durable}.${CREATED}` }))!;
    expect(m2.header.get("be-dlq-reason")).toBe("MAX_DELIVER");
    expect(m2.header.get("be-dlq-delivery")).toBe("4");
    failNext = 0;
  });

  it("derives causation and hop count for events published inside a handler", async () => {
    const parent = { id: newId(), hopCount: 3 };
    const u = new Unit({ memberId: "sdktest/basic", deadline: Date.now() + 5000, signal: new AbortController().signal });
    u.handling = parent;
    const thing = newId();
    await runUnit(u, () => store.tx((tx) => tx.publish({ subject: CREATED, aggregateId: thing, version: 1, payload: { thing_id: thing, legal_entity_id: "LE01", amount: "1" } })));
    const row = (await db.su(`SELECT causation_id, hop_count FROM "${db.schema}".besdk_outbox WHERE aggregate_id = $1`, [thing])).rows[0];
    expect(row).toEqual({ causation_id: parent.id, hop_count: 4 });
  });
});

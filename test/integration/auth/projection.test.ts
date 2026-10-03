// The ACL projection (P6.12, P6.13, P6.11): besdk_authz_acl / besdk_authz_cursor created by the platform step for a
// component with resource types; changes pulled after the cursor; a 410 rebuilds from the tuples snapshot; the
// owner's relations written through the outbox; Access.check reads the projection.
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Access } from "../../../src/auth/access.js";
import type { Bundle } from "../../../src/auth/decide.js";
import type { ResourceType } from "../../../src/auth/evaluate.js";
import type { VerifiedUser } from "../../../src/auth/jwt.js";
import { Projection } from "../../../src/auth/projection.js";
import { runMigrations } from "../../../src/migrate/index.js";
import { newMemberRegistry } from "../../../src/obs/metrics.js";
import { Store, type TxExtensions } from "../../../src/store/index.js";
import { captureLogger } from "../../support/capture.js";
import { createTestDb, DB_MIGRATIONS, requirePg, type TestDb } from "../../support/pg.js";

const ORDER: ResourceType = {
  type: "sdktest.basic.order", owner_component: "sdktest/basic", view_key: "sdktest.basic.view", dimensions: ["owner"], derivation: "direct",
  relations: { viewer: { grants: ["sdktest.basic.view"] }, team: { grants: ["sdktest.basic.view"], owned_by: "component" } },
};
const log = captureLogger("sdktest/basic");
let db: TestDb;
let store: Store;
let srv: Server;
let url: string;
let changes: { revision: string; op: "upsert" | "delete"; tuple: Record<string, unknown> }[] = [];
let head = "0";
let gone = false;
const snapshot = { revision: "7", tuples: [{ object: { type: ORDER.type, id: "o9" }, relation: "viewer", subject: "role:clerk" }] };

beforeAll(async () => {
  db = await createTestDb(requirePg("BE_TEST_PG16"));
  await runMigrations({ memberId: "sdktest/basic", config: db.config(), logger: log.logger, migrationsDir: DB_MIGRATIONS, direction: "up", authzProjection: true });
  store = new Store({ memberId: "sdktest/basic", config: db.config(), logger: log.logger, metrics: newMemberRegistry("sdktest/basic"), extensions: {} as TxExtensions });
  srv = createServer((req, res) => {
    const u = new URL(req.url!, "http://x");
    if (u.pathname === "/authz/v2/changes") {
      if (gone) return void res.writeHead(410).end();
      const after = BigInt(u.searchParams.get("after") ?? "0");
      const page = changes.filter((c) => BigInt(c.revision) > after);
      return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ changes: page, next: page.at(-1)?.revision ?? String(after), watermark: head }));
    }
    if (u.pathname === "/authz/v2/tuples") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ...snapshot, next_cursor: "" }));
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
});
afterAll(async () => {
  await store.close();
  await new Promise((r) => srv.close(r));
  await db.cleanup();
});

const acl = async () => (await db.su(`SELECT rid, relation, subject, revision::text AS revision FROM "${db.schema}".besdk_authz_acl ORDER BY rid, relation, subject`)).rows;
const cursor = async () => (await db.su(`SELECT scope, revision::text AS revision FROM "${db.schema}".besdk_authz_cursor`)).rows;

describe("Projection (P6.12)", () => {
  const proj = () => new Projection({ store, authzUrl: url, types: [ORDER.type], logger: log.logger });
  it("applies upserts and deletes after the cursor and advances to the watermark", async () => {
    changes = [
      { revision: "1", op: "upsert", tuple: { object: { type: ORDER.type, id: "o1" }, relation: "viewer", subject: "user:u_me" } },
      { revision: "2", op: "upsert", tuple: { object: { type: ORDER.type, id: "o2" }, relation: "viewer", subject: "dept_tree:/1/" } },
      { revision: "3", op: "delete", tuple: { object: { type: ORDER.type, id: "o2" }, relation: "viewer", subject: "dept_tree:/1/" } },
    ];
    head = "5";
    await proj().pull();
    expect(await acl()).toEqual([{ rid: "o1", relation: "viewer", subject: "user:u_me", revision: "1" }]);
    expect(await cursor()).toEqual([{ scope: ORDER.type, revision: "5" }]);
  });
  it("rebuilds from the tuples snapshot after a 410 and continues from its revision", async () => {
    gone = true;
    const p = proj();
    await p.pull().catch(() => undefined);
    gone = false;
    changes = [{ revision: "8", op: "upsert", tuple: { object: { type: ORDER.type, id: "o9" }, relation: "viewer", subject: "user:u_x" } }];
    head = "8";
    await p.pull();
    expect((await acl()).map((r) => [r.rid, r.subject])).toEqual([["o9", "role:clerk"], ["o9", "user:u_x"]]);
    expect(await cursor()).toEqual([{ scope: ORDER.type, revision: "8" }]);
  });
  it("Access.check sees a share in the projection; the decision maps to 404 / 403", async () => {
    const bundle = { contract: "authz/2.0", roles: { clerk: [] }, grants: {}, profiles: {}, delegations: [], stale_since: {}, revoked_grants: {}, capabilities: { sharing: true, relation_sync: true } } as unknown as Bundle;
    const user = { sub: "u_y", roles: ["clerk"], deptPath: "", ceil: [], dg: "", iat: 1, tenantId: "t", locale: "en" } as unknown as VerifiedUser;
    const a = new Access(user, bundle, "sdktest.basic.view");
    const d9 = await store.tx((tx) => a.check(tx, "sdktest.basic.view", ORDER, { id: "o9", owner: "someone" }));
    expect(d9).toMatchObject({ visible: true, allowed: true, reason: "" });
    const d1 = await store.tx((tx) => a.check(tx, "sdktest.basic.view", ORDER, { id: "o1", owner: "someone" }));
    expect(d1).toMatchObject({ visible: false, reason: "NOT_FOUND" });
    expect(() => a.require(d1)).toThrow(expect.objectContaining({ code: "NOT_FOUND", reason: "NOT_FOUND" }));
  });
  it("tx.syncRelation writes infra.authz.relation.sync.v1 to the outbox with the group version", async () => {
    const { syncRelation } = await import("../../../src/auth/projection.js");
    await store.tx((tx) => syncRelation(tx, ORDER.type, "o5", "team", ["user:a", "user:b"], 3n));
    const { rows } = await db.su(`SELECT subject, aggregate_type, aggregate_id, aggregate_version::text AS v, payload FROM "${db.schema}".besdk_outbox`);
    expect(rows).toEqual([{ subject: "infra.authz.relation.sync.v1", aggregate_type: "infra.authz.relation_group", aggregate_id: `${ORDER.type}:o5#team`, v: "3",
      payload: { object: { type: ORDER.type, id: "o5" }, relation: "team", subjects: [{ subject: "user:a" }, { subject: "user:b" }] } }]);
  });
});

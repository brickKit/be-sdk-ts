// The start-up probe (P10.7) against real PostgreSQL 16 and 14.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newMemberRegistry } from "../../../src/obs/metrics.js";
import { probeDatabase, Store } from "../../../src/store/index.js";
import { captureLogger } from "../../support/capture.js";
import { createTestDb, requirePg, type TestDb } from "../../support/pg.js";

const MEMBER = "sdktest/db";

describe.each([
  ["PG16", "BE_TEST_PG16", 160_000],
  ["PG14", "BE_TEST_PG14", 140_000],
] as const)("probeDatabase on %s", (_label, envName, floor) => {
  const dsn = requirePg(envName);
  let db: TestDb;
  let store: Store;
  const metrics = newMemberRegistry(MEMBER);
  const cap = captureLogger(MEMBER);
  const probe = (over: { ownerRole?: string; shell?: boolean } = {}) =>
    probeDatabase(store, { ownerRole: db.owner, shell: false, metrics, logger: cap.logger, ...over });
  const gauge = async () => (await metrics.be.dbIdentityOk.get()).values[0]?.value;

  beforeAll(async () => {
    db = await createTestDb(dsn);
    await db.asOwner(`CREATE TABLE things (id int PRIMARY KEY); CREATE TABLE parts (id int, at timestamptz) PARTITION BY RANGE (at);
      CREATE TABLE parts_a PARTITION OF parts FOR VALUES FROM ('2026-01-01') TO ('2027-01-01')`);
    store = new Store({ memberId: MEMBER, config: db.config(), logger: cap.logger, metrics });
  });
  afterAll(async () => {
    await store?.close();
    await db?.cleanup();
  });

  it("passes for a correctly provisioned identity", async () => {
    const r = await probe();
    expect(r).toMatchObject({ capabilitiesOk: true, identityOk: true, problems: [] });
    expect(r.versionNum).toBeGreaterThanOrEqual(floor);
    expect(await gauge()).toBe(1);
  });

  it("requires PostgreSQL 16 in a shell", async () => {
    const r = await probe({ shell: true });
    expect(r.capabilitiesOk).toBe(floor >= 160_000);
  });

  it("fails when the runtime role may CREATE in the schema", async () => {
    await db.su(`GRANT CREATE ON SCHEMA ${db.schema} TO ${db.runtime}`);
    try {
      const r = await probe();
      expect(r.identityOk).toBe(false);
      expect(r.capabilitiesOk).toBe(true);
      expect(r.problems.join("\n")).toMatch(/CREATE on schema/);
      expect(await gauge()).toBe(0);
      expect(cap.lines.some((l) => l.level === "error" && /identity/.test(l.msg))).toBe(true);
    } finally {
      await db.su(`REVOKE CREATE ON SCHEMA ${db.schema} FROM ${db.runtime}`);
    }
    expect((await probe()).identityOk).toBe(true);
  });

  it("fails when the runtime role is a member of the owner", async () => {
    await db.su(`GRANT ${db.owner} TO ${db.runtime}`);
    try {
      const r = await probe();
      expect(r.problems.join("\n")).toMatch(/member of the owner role/);
    } finally {
      await db.su(`REVOKE ${db.owner} FROM ${db.runtime}`);
    }
  });

  it("fails for a table the owner does not own and the runtime role cannot write", async () => {
    await db.su(`CREATE TABLE ${db.schema}.stray (id int)`);
    try {
      const r = await probe();
      expect(r.identityOk).toBe(false);
      expect(r.problems).toContain(`table stray is owned by postgres, not ${db.owner}`);
      expect(r.problems.join("\n")).toMatch(/lacks SELECT, INSERT, UPDATE or DELETE on table stray/);
    } finally {
      await db.su(`DROP TABLE ${db.schema}.stray`);
    }
  });

  it("reports an owner role that does not exist instead of failing", async () => {
    const r = await probe({ ownerRole: "no_such_owner_role" });
    expect(r.identityOk).toBe(false);
    expect(r.problems.join("\n")).toMatch(/owner role no_such_owner_role does not exist/);
  });
});

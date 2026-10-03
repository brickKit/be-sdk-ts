// List/Can consistency on real PostgreSQL (be-protocol P6.7, CP-SCOPE-10; EVALUATION.md E10): for key K a row is
// selected by the canonical predicate with `scope(K).params` exactly when `visibleFor(K, row)` holds, and the
// UNION ALL branches select the same rows. Every decision vector with a row is checked for its key and its type's
// view key, then fast-check generates rows and ACL sets for a few vectors. Each case runs in one transaction that
// rolls back, so `now()` is fixed: ACL expiry is written as now() + (expires_at − vector now), boundaries included.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acceptBundle, checkToken } from "../../../src/auth/decide.js";
import { Evaluator, type AclRow, type ResourceType, type Row } from "../../../src/auth/evaluate.js";
import { scopeBranches, scopeSql, type ScopeColumns } from "../../../src/auth/predicate.js";
import { createTestDb, requirePg, type TestDb } from "../../support/pg.js";

const root = new URL("../../../protocol/", import.meta.url);
const vecDir = fileURLToPath(new URL("authz/decision/", root));
const DDL = readFileSync(fileURLToPath(new URL("ddl/07-authz-projection.sql", root)), "utf8");
const vectors = readdirSync(vecDir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(vecDir + f, "utf8")))
  .filter((v) => v.input.row && v.expected.token === "OK");

interface Case {
  ev: Evaluator;
  now: number;
  t: ResourceType;
  key: string;
  rows: Row[];
  acl: AclRow[];
  graphIds?: string[];
}

const resourceDims = (t: ResourceType) => (t.dimensions ?? []).filter((d) => d !== "owner" && d !== "org");
const columns = (t: ResourceType): ScopeColumns => ({
  alias: "o",
  id: "id",
  owner: "owner_id",
  dept: "dept_path",
  dims: Object.fromEntries(resourceDims(t).map((d) => [d, `dim_${d}`])),
});
const IDS = ["o1", "o2", "o3", "p1", "f1", "f2", "b1", "e1"];
const DEPTS = ["", "/", "/1/", "/1/12/", "/1/12/5/", "/1/123/", "/1/7/2/", "/1/3/", "/2/", "/4/", "/a_b/c%d/", "/a_b/c%d/x/", "/aXb/cYd/", "/A_B/C%D/", "/A_B/C%D/x/", "/1/12/X/", "/x\\y/", undefined];
const SUBJECTS = ["user:u_me", "user:u_a", "user:u_other", "role:rep", "role:mgr", "role:wh", "dept:/1/12/", "dept:/4/", "dept_tree:/", "dept_tree:/1/", "dept_tree:/2/"];
const DELTAS = [null, -86_400 * 400, -1, 0, 1, 86_400 * 400];
const VALUES = ["N", "S", "Z", "le1", "le2", "SECRET", undefined];
const unix = (s: string) => Math.floor(Date.parse(s) / 1000);

describe("List/Can consistency on PostgreSQL 16", () => {
  const dsn = requirePg("BE_TEST_PG16");
  let db: TestDb;
  let c: pg.Client;

  beforeAll(async () => {
    db = await createTestDb(dsn);
    await db.asOwner(DDL);
    c = await db.session("super");
  });
  afterAll(async () => db?.cleanup());

  /** Returns [ids by scopeSql, ids by the UNION ALL branches], each sorted. */
  async function listed(k: Case): Promise<[string[], string[]]> {
    const dims = resourceDims(k.t);
    await c.query("BEGIN");
    try {
      await c.query(`SET LOCAL search_path TO "${db.schema}"`);
      await c.query(`CREATE TABLE items (id text PRIMARY KEY, owner_id text, dept_path text${dims.map((d) => `, dim_${d} text`).join("")})`);
      for (const r of k.rows) {
        await c.query(`INSERT INTO items VALUES (${[1, 2, 3, ...dims.map((_, i) => i + 4)].map((n) => `$${n}`).join(", ")})`, [
          r.id,
          r.owner ?? null,
          r.dept_path ?? null,
          ...dims.map((d) => r.values?.[d] ?? null),
        ]);
      }
      for (const a of k.acl) {
        const delta = a.expires_at ? unix(a.expires_at) - k.now : null;
        await c.query(
          `INSERT INTO besdk_authz_acl (rtype, rid, relation, subject, expires_at, revision)
           VALUES ($1, $2, $3, $4, CASE WHEN $5::float8 IS NULL THEN NULL ELSE now() + make_interval(secs => $5::float8) END, 1)`,
          [a.rtype, a.rid, a.relation, a.subject, delta],
        );
      }
      const { params } = k.ev.scope(k.t, k.key, k.graphIds);
      const one = scopeSql(k.t, params, columns(k.t));
      const r1 = await c.query(`SELECT o.id FROM items o WHERE ${one.sql} ORDER BY o.id`, one.values);
      const b = scopeBranches(k.t, params, columns(k.t));
      const sel = (w: string) => `SELECT o.id FROM items o WHERE ${w}`;
      const r2 = await c.query(`${sel(b.rule)} UNION ALL ${sel(b.acl)} UNION ALL ${sel(b.graph)}`, b.values);
      return [r1.rows.map((x) => x.id), r2.rows.map((x) => x.id).sort()];
    } finally {
      await c.query("ROLLBACK");
    }
  }

  async function assertConsistent(k: Case): Promise<void> {
    const expected = k.rows.filter((r) => k.ev.visibleFor(k.t, k.key, r, k.acl, k.graphIds)).map((r) => r.id).sort();
    const [one, union] = await listed(k);
    expect(one, `scopeSql for ${k.key}`).toEqual(expected);
    expect(union, `UNION ALL for ${k.key}`).toEqual(expected);
  }

  function caseOf(v: any, t: ResourceType, key: string, rows: Row[], acl: AclRow[], graphIds?: string[]): Case {
    const ev = new Evaluator(acceptBundle(v.input.bundle)!, v.input.claims, v.input.now);
    return { ev, now: v.input.now, t, key, rows, acl, graphIds };
  }

  it("covers the vectors with a row", () => expect(vectors.length).toBeGreaterThan(40));

  /** Fixed extra rows around every vector's record: departments (case, LIKE metacharacters), owners, values. */
  const probes = (t: ResourceType): Row[] =>
    DEPTS.map((dept_path, i) => ({
      id: `z${i}`,
      owner: [undefined, "u_me", "u_a", "u_other"][i % 4],
      dept_path,
      values: Object.fromEntries(resourceDims(t).map((d, j) => [d, VALUES[(i + j) % VALUES.length]])) as Record<string, string>,
    }));

  for (const v of vectors) {
    it(`vector ${v.id}`, async () => {
      expect(checkToken(acceptBundle(v.input.bundle)!, v.input.claims)).toBe("OK");
      const row: Row = v.input.row;
      for (const dimensions of [v.input.resource_type.dimensions, []]) {
        const t: ResourceType = { ...v.input.resource_type, dimensions };
        for (const key of new Set([v.input.key, t.view_key])) {
          await assertConsistent(caseOf(v, t, key, [row, ...probes(t)], v.input.acl ?? [], v.input.graph_ids));
          // the record also reachable through a live ACL row and the graph ids: every branch at once, listed once
          const acl: AclRow[] = v.input.acl ?? [];
          const extra = Object.keys(t.relations)
            .map((relation) => ({ rtype: t.type, rid: row.id, relation, subject: `user:${v.input.claims.sub}` }))
            .filter((e) => !acl.some((a) => a.rtype === e.rtype && a.rid === e.rid && a.relation === e.relation && a.subject === e.subject));
          await assertConsistent(caseOf(v, t, key, [row, ...probes(t)], [...acl, ...extra], [row.id, "z1"]));
        }
      }
    });
  }

  const GENERATED = [
    "like-escaping",
    "org-custom-subtrees",
    "level-dept-same-department",
    "share-to-department-tree",
    "on-behalf-share-to-delegator",
    "component-relation-member",
    "graph-capability-on",
    "values-star",
    "explain-invisible-hides-attributes",
    "ceiling-drops-org-values",
  ];

  for (const id of GENERATED) {
    const v = vectors.find((x) => x.id === id);
    it(`generated rows and ACL for ${id}`, async () => {
      expect(v, id).toBeDefined();
      const base: ResourceType = v.input.resource_type;
      const now: number = v.input.now;
      const row = fc.record({
        id: fc.constantFrom(...IDS),
        owner: fc.constantFrom("u_me", "u_other", "u_a", undefined),
        dept_path: fc.constantFrom(...DEPTS),
        values: fc.record(Object.fromEntries(resourceDims(base).map((d) => [d, fc.constantFrom(...VALUES)]))),
      });
      const acl = fc.record({
        rtype: fc.constantFrom(base.type, "other.x.y"),
        rid: fc.constantFrom(...IDS),
        relation: fc.constantFrom(...Object.keys(base.relations), "member"),
        subject: fc.constantFrom(...SUBJECTS),
        expires_at: fc.constantFrom(...DELTAS).map((d) => (d === null ? null : new Date((now + d) * 1000).toISOString())),
      });
      const keys = [...new Set([v.input.key, base.view_key, ...(base.keys ?? [])])];
      const dimSets = [base.dimensions ?? [], [], ["owner"], ["org"], resourceDims(base)];
      await fc.assert(
        fc.asyncProperty(
          fc.uniqueArray(row, { selector: (r) => r.id, maxLength: 8 }),
          fc.uniqueArray(acl, { selector: (a) => `${a.rtype}|${a.rid}|${a.relation}|${a.subject}`, maxLength: 10 }),
          fc.constantFrom(...keys),
          fc.subarray(IDS),
          fc.constantFrom(...dimSets),
          async (rows, aclRows, key, graphIds, dimensions) => assertConsistent(caseOf(v, { ...base, dimensions }, key, rows as Row[], aclRows, graphIds)),
        ),
        { numRuns: 60 },
      );
    });
  }
});

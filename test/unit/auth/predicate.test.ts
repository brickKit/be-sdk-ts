// The canonical list predicate (be-protocol P6.5): static SQL text with positional parameters. Its result on real
// PostgreSQL (List/Can consistency) is proved in test/integration/auth/predicate.test.ts.
import { describe, expect, it } from "vitest";
import type { ResourceType, ScopeParams } from "../../../src/auth/evaluate.js";
import { scopeBranches, scopeSql } from "../../../src/auth/predicate.js";

const order: ResourceType = {
  type: "erp.sales.order",
  owner_component: "erp/sales",
  view_key: "erp.sales.view",
  dimensions: ["owner", "org", "warehouse"],
  relations: { viewer: { grants: ["erp.sales.view"] } },
  derivation: "direct",
};

const params: ScopeParams = {
  s_all: false,
  s_owners: ["u_me"],
  s_dept_exact: [],
  s_dept_prefix: ["/1/%"],
  s_dims: { warehouse: { all: false, ids: ["N"] } },
  s_acl: true,
  s_relations: ["viewer"],
  s_subjects: ["user:u_me"],
  s_graph_ids: [],
};

const cols = { alias: "o", id: "id", owner: "owner_id", dept: "dept_path", dims: { warehouse: "warehouse_id" } };

const ACL =
  `($8::boolean AND EXISTS (SELECT 1 FROM besdk_authz_acl besdk_acl WHERE besdk_acl.rtype = $9::text AND besdk_acl.rid = "o"."id"::text` +
  ` AND besdk_acl.relation = ANY($10::text[]) AND besdk_acl.subject = ANY($11::text[])` +
  ` AND (besdk_acl.expires_at IS NULL OR besdk_acl.expires_at > now())))`;

describe("scopeSql", () => {
  it("renders the canonical shape with parameters in order", () => {
    const { sql, values } = scopeSql(order, params, cols, 1);
    expect(sql).toBe(
      `((($1::boolean OR "o"."owner_id" = ANY($2) OR "o"."dept_path" = ANY($3::text[]) OR "o"."dept_path" LIKE ANY($4::text[]))` +
        ` AND ($5::boolean OR "o"."warehouse_id" = ANY($6)) AND $7::boolean)` +
        ` OR ${ACL} OR "o"."id"::text = ANY($12::text[]))`,
    );
    expect(values).toEqual([false, ["u_me"], [], ["/1/%"], false, ["N"], true, true, "erp.sales.order", ["viewer"], ["user:u_me"], []]);
  });

  it("numbers from firstParam and works without an alias", () => {
    const { sql, values } = scopeSql({ ...order, dimensions: ["owner"] }, params, { id: "id", owner: "owner_id" }, 4);
    expect(sql.startsWith(`((($4::boolean OR "owner_id" = ANY($5)) AND $6::boolean) OR ($7::boolean`)).toBe(true);
    expect(values).toHaveLength(8);
  });

  it("uses has(K) (a non-empty s_owners) as the identity part when the type declares neither owner nor org", () => {
    const t = { ...order, dimensions: ["warehouse"] };
    expect(scopeSql(t, params, cols, 1).sql.startsWith(`((($1::boolean OR "o"."warehouse_id" = ANY($2)) AND $3::boolean) OR`)).toBe(true);
    expect(scopeSql(t, params, cols, 1).values[2]).toBe(true);
    expect(scopeSql(t, { ...params, s_owners: [] }, cols, 1).values[2]).toBe(false);
  });

  it("treats a declared dimension without parameters as matching nothing", () => {
    const { values } = scopeSql(order, { ...params, s_dims: {} }, cols, 1);
    expect(values.slice(4, 6)).toEqual([false, []]);
  });

  it("refuses a missing or unsafe column identifier", () => {
    expect(() => scopeSql(order, params, { ...cols, owner: undefined }, 1)).toThrow(/owner/);
    expect(() => scopeSql(order, params, { ...cols, dims: {} }, 1)).toThrow(/warehouse/);
    expect(() => scopeSql(order, params, { ...cols, id: "id; DROP TABLE x" }, 1)).toThrow(/identifier/);
    expect(() => scopeSql(order, params, { ...cols, alias: 'o"' }, 1)).toThrow(/identifier/);
    expect(() => scopeSql(order, params, cols, 0)).toThrow(/firstParam/);
  });
});

describe("scopeBranches", () => {
  it("offers three disjoint branches over the same parameters", () => {
    const one = scopeSql(order, params, cols, 1);
    const br = scopeBranches(order, params, cols, 1);
    expect(br.values).toEqual(one.values);
    const rule = `(($1::boolean OR "o"."owner_id" = ANY($2) OR "o"."dept_path" = ANY($3::text[]) OR "o"."dept_path" LIKE ANY($4::text[])) AND ($5::boolean OR "o"."warehouse_id" = ANY($6)) AND $7::boolean)`;
    const graph = `"o"."id"::text = ANY($12::text[])`;
    expect(br.rule).toBe(rule);
    expect(br.acl).toBe(`(${ACL} AND NOT COALESCE(${rule}, false))`);
    expect(br.graph).toBe(`(${graph} AND NOT COALESCE(${rule} OR ${ACL}, false))`);
  });
});

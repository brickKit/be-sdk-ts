// The canonical list predicate (be-protocol P6.5) for node-postgres positional parameters. The SQL text is static:
// only column identifiers from the caller's code (validated, quoted) and placeholders; every value is a parameter
// taken from `Evaluator.scope().params` (EVALUATION.md E6–E9). A row passes exactly when vis(K, row) holds (E10):
//
//   ( [identity] AND [each resource dimension] AND has(K) )        -- rule branch
//   OR ( s_acl AND EXISTS (… besdk_authz_acl …) )                   -- ACL branch
//   OR id::text = ANY(s_graph_ids)                                  -- graph branch (empty array otherwise)
//
// The identity part has only the terms of the dimensions the type declares (owner, org) and is left out when it
// declares neither. has(K) is a parameter: s_owners is non-empty exactly when has(K) (E6), so it is derived from
// the parameters. Arrays compared with a component's own columns carry no cast, so PostgreSQL types them from the
// column (text, uuid, bigint); LIKE and the ACL table are text.
import { SpecError } from "../errors/specError.js";
import type { ResourceType, ScopeParams } from "./evaluate.js";

/** Column identifiers of the listed table: `id` always; `owner` / `dept` / `dims[d]` for each declared dimension. */
export interface ScopeColumns {
  alias?: string;
  id: string;
  owner?: string;
  dept?: string;
  dims?: Record<string, string>;
}

export interface SqlFragment {
  sql: string;
  values: unknown[];
}

/** The three branches for `UNION ALL`, made disjoint so the union equals the single predicate; one `values`. */
export interface ScopeBranches {
  rule: string;
  acl: string;
  graph: string;
  values: unknown[];
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

class Placeholders {
  readonly values: unknown[] = [];
  private next: number;

  constructor(first: number) {
    if (!Number.isInteger(first) || first < 1) throw new SpecError("PREDICATE_INVALID", `firstParam must be an integer >= 1: ${first}`);
    this.next = first;
  }

  add(value: unknown, cast = ""): string {
    this.values.push(value);
    return `$${this.next++}${cast}`;
  }
}

function ident(name: string): string {
  if (!IDENT.test(name)) throw new SpecError("PREDICATE_INVALID", `not a column identifier: ${JSON.stringify(name)}`);
  return `"${name}"`;
}

function column(cols: ScopeColumns, name: string | undefined, what: string): string {
  if (name === undefined) throw new SpecError("PREDICATE_INVALID", `the type declares ${what} but no column is given for it`);
  return cols.alias === undefined ? ident(name) : `${ident(cols.alias)}.${ident(name)}`;
}

function ruleBranch(t: ResourceType, p: ScopeParams, cols: ScopeColumns, ph: Placeholders): string {
  const dims = t.dimensions ?? [];
  const parts: string[] = [];
  if (dims.includes("owner") || dims.includes("org")) {
    const terms = [ph.add(p.s_all, "::boolean")];
    if (dims.includes("owner")) terms.push(`${column(cols, cols.owner, "owner")} = ANY(${ph.add(p.s_owners)})`);
    if (dims.includes("org")) {
      const dept = column(cols, cols.dept, "org");
      terms.push(`${dept} = ANY(${ph.add(p.s_dept_exact, "::text[]")})`, `${dept} LIKE ANY(${ph.add(p.s_dept_prefix, "::text[]")})`);
    }
    parts.push(`(${terms.join(" OR ")})`);
  }
  for (const d of dims) {
    if (d === "owner" || d === "org") continue;
    const v = p.s_dims[d] ?? { all: false, ids: [] };
    parts.push(`(${ph.add(v.all, "::boolean")} OR ${column(cols, cols.dims?.[d], `dimension ${d}`)} = ANY(${ph.add(v.ids)}))`);
  }
  parts.push(ph.add(p.s_owners.length > 0, "::boolean"));
  return `(${parts.join(" AND ")})`;
}

function aclBranch(t: ResourceType, p: ScopeParams, id: string, ph: Placeholders): string {
  const a = "besdk_acl";
  return (
    `(${ph.add(p.s_acl, "::boolean")} AND EXISTS (SELECT 1 FROM besdk_authz_acl ${a} WHERE ${a}.rtype = ${ph.add(t.type, "::text")} AND ${a}.rid = ${id}::text` +
    ` AND ${a}.relation = ANY(${ph.add(p.s_relations, "::text[]")}) AND ${a}.subject = ANY(${ph.add(p.s_subjects, "::text[]")})` +
    ` AND (${a}.expires_at IS NULL OR ${a}.expires_at > now())))`
  );
}

function branches(t: ResourceType, p: ScopeParams, cols: ScopeColumns, firstParam: number): ScopeBranches {
  const ph = new Placeholders(firstParam);
  const id = column(cols, cols.id, "id");
  const rule = ruleBranch(t, p, cols, ph);
  const acl = aclBranch(t, p, id, ph);
  const graph = `${id}::text = ANY(${ph.add(p.s_graph_ids, "::text[]")})`;
  return { rule, acl, graph, values: ph.values };
}

/** The canonical predicate as one parenthesised boolean expression: `WHERE <filters> AND ${sql}`. */
export function scopeSql(t: ResourceType, params: ScopeParams, cols: ScopeColumns, firstParam = 1): SqlFragment {
  const b = branches(t, params, cols, firstParam);
  return { sql: `(${b.rule} OR ${b.acl} OR ${b.graph})`, values: b.values };
}

/**
 * The same predicate as three branches for `UNION ALL` on one cursor (P6.5): each later branch excludes the rows
 * an earlier one already yields, so the union has no duplicates and equals `scopeSql`. All three strings use the
 * same placeholders: pass `values` once.
 */
export function scopeBranches(t: ResourceType, params: ScopeParams, cols: ScopeColumns, firstParam = 1): ScopeBranches {
  const b = branches(t, params, cols, firstParam);
  return {
    rule: b.rule,
    acl: `(${b.acl} AND NOT COALESCE(${b.rule}, false))`,
    graph: `(${b.graph} AND NOT COALESCE(${b.rule} OR ${b.acl}, false))`,
    values: b.values,
  };
}

// `access()`: the one entry point to the caller's authorization (sdk-redesign-apis §2.5, P6.3–P6.9). Feature keys
// (E5), the list scope as the canonical predicate's parameters (E6–E9), single-record decisions with the ACL
// projection (E10, 404 for a record the caller cannot see), explain facts (E12), field masks (E11), row actions.
// Decisions are never cached across requests (P6.14).
import { currentUnit } from "../context.js";
import { platformError } from "../errors/beError.js";
import type { Tx } from "../store/tx.js";
import { hasKey, type Bundle, type TokenClaims } from "./decide.js";
import { Evaluator, type AclRow, type Decision, type Fact, type FieldAccess, type ResourceType, type Row, type ScopeParams } from "./evaluate.js";
import { checkSortable, checkWritable, maskRows, type Masked } from "./fields.js";
import type { VerifiedUser } from "./jwt.js";
import { scopeBranches, scopeSql, type ScopeBranches, type ScopeColumns, type SqlFragment } from "./predicate.js";
import { aclOf } from "./projection.js";

export interface User {
  sub: string;
  tenantId: string;
  roles: string[];
  deptPath: string;
  hasDept: boolean;
  act?: VerifiedUser["act"];
  locale: string;
}

/** The list scope of one resource type for one key (P6.5): parameters, the SQL fragment, degradation. */
export class Scope {
  readonly params: ScopeParams;
  /** "graph" when the provider lacks it (P6.15): answer with X-Authz-Degraded */
  readonly degraded: string[];
  private readonly t: ResourceType;

  constructor(t: ResourceType, params: ScopeParams, degraded: string[]) {
    this.t = t;
    this.params = params;
    this.degraded = degraded;
  }

  /** The canonical predicate with node-postgres placeholders from `$firstParam` on. */
  sql(cols: ScopeColumns, firstParam = 1): SqlFragment {
    return scopeSql(this.t, this.params, cols, firstParam);
  }

  /** The three branches for a UNION ALL rewrite; the same rows as `sql`. */
  branches(cols: ScopeColumns, firstParam = 1): ScopeBranches {
    return scopeBranches(this.t, this.params, cols, firstParam);
  }
}

export class Access {
  private readonly u: VerifiedUser;
  private readonly b: Bundle | undefined;
  /** the permission key the route was decided with */
  readonly perm: string | undefined;

  constructor(u: VerifiedUser, b: Bundle | undefined, perm: string | undefined) {
    this.u = u;
    this.b = b;
    this.perm = perm;
  }

  user(): User {
    const u = this.u;
    return { sub: u.sub, tenantId: u.tenantId, roles: [...u.roles], deptPath: u.deptPath, hasDept: /^\/([^/]+\/)*$/.test(u.deptPath) && u.deptPath !== "", act: u.act, locale: u.locale };
  }

  private claims(): TokenClaims {
    const u = this.u;
    return { sub: u.sub, iat: u.iat, roles: u.roles, dept_path: u.deptPath, ceil: u.ceil, dg: u.dg, act: u.act };
  }

  private now(): number {
    return Math.floor(Date.now() / 1000);
  }

  private evaluator(): Evaluator {
    if (!this.b) throw platformError("AUTHZ_NOT_READY");
    return new Evaluator(this.b, this.claims(), this.now());
  }

  private key(k: string | undefined): string {
    const key = k ?? this.perm;
    if (!key) throw platformError("INTERNAL", undefined, "no permission key: the route is not guarded by one, pass the key");
    return key;
  }

  /** A feature key, ceilings applied (E4, E5). */
  has(key: string): boolean {
    return this.b !== undefined && hasKey(this.b, this.claims(), key, this.now());
  }

  /** The list scope of type `t` for `key` (default: the route's key), P6.3–P6.5. */
  scope(t: ResourceType, key?: string, graphIds?: readonly string[]): Scope {
    const s = this.evaluator().scope(t, this.key(key), graphIds);
    return new Scope(t, s.params, s.degraded);
  }

  /** One record with the ACL rows the caller already has (E10); see `check` to read them from the projection. */
  can(key: string, t: ResourceType, row: Row, acl: readonly AclRow[] = [], graphIds?: readonly string[]): Decision {
    return this.evaluator().decide(t, key, row, acl, graphIds);
  }

  /** One record, its ACL rows read from the member's projection in `tx` (P6.6, P6.12). */
  async check(tx: Tx, key: string, t: ResourceType, row: Row, graphIds?: readonly string[]): Promise<Decision> {
    return this.can(key, t, row, await aclOf(tx, t.type, row.id), graphIds);
  }

  /** Throws the decision's answer: 404 NOT_FOUND for a record the caller cannot see, 403 otherwise (P6.6). */
  require(d: Decision): void {
    if (d.allowed) return;
    if (d.reason === "NOT_FOUND" || !d.visible) throw platformError("NOT_FOUND");
    throw platformError(d.reason || "MISSING_PERMISSION", d.reason === "MISSING_PERMISSION" ? { permission: this.perm ?? "" } : undefined);
  }

  /** E12 facts for one record (R62: nothing about an invisible record's attributes). */
  explain(key: string, t: ResourceType, row: Row, acl: readonly AclRow[] = [], graphIds?: readonly string[]): { decision: Decision; reasons: Fact[]; missing: Fact[] } {
    const ev = this.evaluator();
    return { decision: ev.decide(t, key, row, acl, graphIds), ...ev.explain(t, key, row, acl, graphIds) };
  }

  /** Field access of type `t` (E11): masked and read-only columns. */
  fields(t: ResourceType): FieldAccess {
    return this.evaluator().fields(t);
  }

  /** P6.8: masked columns null at the source, listed in `_masked`. */
  mask<T extends Record<string, unknown>>(t: ResourceType, rows: readonly T[]): Masked<T>[] {
    return maskRows(rows, this.fields(t).masked);
  }

  /** P6.8: a write to a masked or read-only column → 403 FIELD_FORBIDDEN. */
  checkWritable(t: ResourceType, changed: Iterable<string>): void {
    checkWritable(this.fields(t), changed);
  }

  /** P6.8: sorting, filtering or aggregating by a masked column → 400 SORT_FORBIDDEN. */
  checkSortable(t: ResourceType, ...columns: string[]): void {
    checkSortable(this.fields(t), ...columns);
  }

  /** P6.9: `_access: {<action key>: bool}` for each row, from the rule branch and the given ACL rows. */
  rowActions(t: ResourceType, rows: readonly Row[], keys: readonly string[], acl: readonly AclRow[] = []): Record<string, Record<string, boolean>> {
    const ev = this.evaluator();
    const out: Record<string, Record<string, boolean>> = {};
    for (const r of rows) out[r.id] = Object.fromEntries(keys.map((k) => [k, ev.decide(t, k, r, acl.filter((a) => a.rid === r.id)).allowed]));
    return out;
  }
}

/** The caller's access; without a user (an event handler, a gRPC system call) throws 401 TOKEN_INVALID. */
export function access(): Access {
  const u = currentUnit();
  if (!u?.user) throw platformError("TOKEN_INVALID", undefined, "no user in this context");
  return new Access(u.user, u.bundle, u.perm);
}


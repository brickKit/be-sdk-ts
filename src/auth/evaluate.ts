// contract-infra-authz EVALUATION.md (authz/2.0) E6–E12, on top of E1–E5 in decide.ts: levels and the identity
// part, resource dimensions, subject sets and relations, the graph branch, single-record decisions, field masks and
// explain facts. Pure: one principal, one accepted bundle, one instant. Every array is deduplicated and sorted by
// byte order. The list predicate (predicate.ts) takes `scope().params`; a row is listed iff `visibleFor` holds.
import { activeRoles, ceilingsAllow, hasKey, type Bundle, type Delegation, type Profile, type TokenClaims } from "./decide.js";

export interface Relation {
  grants?: string[];
  includes?: string[];
  owned_by?: string;
}

export interface FieldSet {
  set: string;
  columns: string[];
  read: string;
  edit?: string;
}

/** `resource_type` of contract-infra-authz schemas/catalog.schema.json. */
export interface ResourceType {
  type: string;
  owner_component: string;
  view_key: string;
  keys?: string[];
  dimensions?: string[];
  relations: Record<string, Relation>;
  share?: { key: string; relations: string[]; subjects: string[] };
  fields?: FieldSet[];
  inherits?: { from: string; via: string; relation: string; as: string }[];
  derivation: "direct" | "graph";
}

export interface Row {
  id: string;
  owner?: string;
  dept_path?: string;
  values?: Record<string, string>;
}

export interface AclRow {
  rtype: string;
  rid: string;
  relation: string;
  subject: string;
  /** RFC 3339; absent or null never expires */
  expires_at?: string | null;
}

export interface ScopeParams {
  s_all: boolean;
  s_owners: string[];
  s_dept_exact: string[];
  s_dept_prefix: string[];
  s_dims: Record<string, { all: boolean; ids: string[] }>;
  s_acl: boolean;
  s_relations: string[];
  s_subjects: string[];
  s_graph_ids: string[];
}

export type Level = "own" | "dept" | "subtree" | "all";
export type Reason = "" | "NOT_FOUND" | "OUT_OF_SCOPE" | "MISSING_PERMISSION";

export interface Decision {
  visible: boolean;
  allowed: boolean;
  reason: Reason;
}

export interface Fact {
  kind: string;
  source: string;
  detail: string;
}

export interface FieldAccess {
  masked: string[];
  readOnly: string[];
}

const LEVELS: readonly Level[] = ["own", "dept", "subtree", "all"];
const IDENTITY_DIMS = new Set(["owner", "org"]);
const DEPT = /^\/([^/]+\/)*$/;
const EMPTY_PROFILE: Profile = { keys: [], fields: [], max_level: "own", relations: [] };

const rank = (l: string | undefined): number => Math.max(0, LEVELS.indexOf(l as Level));

const byteCompare = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

/** Deduplicated, ascending by byte order. */
export function sortUnique(xs: Iterable<string>): string[] {
  return [...new Set(xs)].sort(byteCompare);
}

function sortFacts(facts: Fact[]): Fact[] {
  const uniq = new Map(facts.map((f) => [JSON.stringify([f.kind, f.source, f.detail]), f]));
  return [...uniq.values()].sort((a, b) => byteCompare(a.kind, b.kind) || byteCompare(a.source, b.source) || byteCompare(a.detail, b.detail));
}

/** E6: a department path is `/` or `/<seg>/…/`; anything else (empty included) is no department (R60). */
export function validDept(path: unknown): path is string {
  return typeof path === "string" && DEPT.test(path);
}

/** E6: `\`, `%` and `_` preceded by `\`, then `%` — a LIKE pattern with PostgreSQL's default backslash escape. */
export function likePrefix(path: string): string {
  return path.replace(/[\\%_]/g, (c) => `\\${c}`) + "%";
}

const reEscape = (c: string): string => c.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");

/** SQL `LIKE` with backslash escape, evaluated in memory (the single-record side of List/Can consistency). */
export function likeMatch(value: string, pattern: string): boolean {
  let rx = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "\\" && i + 1 < pattern.length) rx += reEscape(pattern[++i]!);
    else if (c === "%") rx += "[\\s\\S]*";
    else if (c === "_") rx += "[\\s\\S]";
    else rx += reEscape(c);
  }
  return new RegExp(`^${rx}$`, "u").test(value);
}

/** '/1/12/' → ['/', '/1/', '/1/12/']. */
function ancestors(path: string): string[] {
  const out = ["/"];
  let acc = "/";
  for (const seg of path.split("/").filter(Boolean)) out.push((acc += `${seg}/`));
  return out;
}

function inWindow(now: number, from?: number, until?: number): boolean {
  return (from === undefined || now >= from) && (until === undefined || now < until);
}

/** The keys a relation gives: its own grants and those of the relations it includes, transitively (E8). */
function relationGrants(rels: Record<string, Relation>, name: string, seen = new Set<string>()): Set<string> {
  if (seen.has(name)) return new Set();
  seen.add(name);
  const spec = rels[name] ?? {};
  const out = new Set(spec.grants ?? []);
  for (const inc of spec.includes ?? []) for (const k of relationGrants(rels, inc, seen)) out.add(k);
  return out;
}

const relationCapability = (r: Relation): string => ((r.owned_by ?? "authz") === "component" ? "relation_sync" : "sharing");

/** What one key's branches say about one record (E10); explain reads the parts. */
interface Branches {
  params: ScopeParams;
  hasRule: boolean;
  identOk: boolean;
  failingDims: string[];
  rule: boolean;
  acl: AclRow[];
  graph: boolean;
  visible: boolean;
}

/** One principal against one accepted bundle at one instant (E6–E12). */
export class Evaluator {
  private readonly b: Bundle;
  private readonly c: TokenClaims;
  private readonly now: number;
  private readonly roles: string[];
  private readonly ceilings: [string, Profile][];
  private readonly dept: string;

  constructor(b: Bundle, c: TokenClaims, now: number) {
    this.b = b;
    this.c = c;
    this.now = now;
    this.roles = sortUnique(activeRoles(b, c, now));
    this.ceilings = sortUnique(c.ceil ?? []).map((code) => [code, b.profiles[code] ?? EMPTY_PROFILE]);
    this.dept = validDept(c.dept_path) ? c.dept_path : "";
  }

  private cap(name: string): boolean {
    return this.b.capabilities[name] === true;
  }

  /** E5 */
  has(key: string): boolean {
    return hasKey(this.b, this.c, key, this.now);
  }

  private holders(key: string): string[] {
    return this.roles.filter((r) => (this.b.roles[r] ?? []).includes(key));
  }

  /** D_K: on-behalf delegations of the key to this subject, inside their window (E5). */
  private delegations(key: string): Delegation[] {
    if (!this.cap("delegation")) return [];
    return this.b.delegations
      .filter((d) => d.mode === "on_behalf" && d.to === this.c.sub && d.keys.includes(key) && inWindow(this.now, d.from_ts, d.until))
      .sort((x, y) => byteCompare(x.id ?? "", y.id ?? ""));
  }

  private allows(key: string): boolean {
    return ceilingsAllow(this.b, this.c, key);
  }

  private roleLevel(role: string, key: string): number {
    const g = this.b.grants[role];
    return rank(g?.levels?.[key] || g?.default_level || "own");
  }

  /** The lowest `max_level` of the ceilings; `all` without ceilings (E4). */
  private levelCap(): number {
    return Math.min(rank("all"), ...this.ceilings.map(([, p]) => rank(p.max_level ?? "own")));
  }

  /** E6: the level and the first holder with the highest uncapped level. */
  private levelOf(key: string): { level: Level | "none"; best?: string } {
    const holders = this.holders(key);
    if (holders.length === 0 || !this.allows(key)) return { level: "none" };
    const top = Math.max(...holders.map((r) => this.roleLevel(r, key)));
    const best = holders.find((r) => this.roleLevel(r, key) === top);
    return { level: LEVELS[Math.min(top, this.levelCap())]!, best };
  }

  level(key: string): Level | "none" {
    return this.levelOf(key).level;
  }

  /** E6/E7: the union of a dimension's values over the holders; empty when the ceilings do not allow the key. */
  private values(key: string, dim: string): Set<string> {
    if (!this.allows(key)) return new Set();
    return new Set(this.holders(key).flatMap((r) => this.b.grants[r]?.values?.[dim] ?? []));
  }

  /** E8: S(K). */
  private subjects(key: string): string[] {
    const s = [`user:${this.c.sub}`, ...this.roles.map((r) => `role:${r}`)];
    if (this.dept) s.push(`dept:${this.dept}`, ...ancestors(this.dept).map((p) => `dept_tree:${p}`));
    s.push(...this.delegations(key).map((d) => `user:${d.from}`));
    return sortUnique(s);
  }

  /** E8: relations of T that give K under a true capability, intersected with every ceiling. */
  private relations(t: ResourceType, key: string): string[] {
    if (!this.allows(key)) return [];
    const rels = t.relations ?? {};
    const names = Object.keys(rels).filter((n) => this.cap(relationCapability(rels[n]!)) && relationGrants(rels, n).has(key));
    return sortUnique(names.filter((n) => this.ceilings.every(([, p]) => (p.relations ?? []).includes(n))));
  }

  /** E6: identity-part parameters; org values behave as subtree (paths) and all (`*`), dropped below that cap. */
  private identity(key: string): Pick<ScopeParams, "s_all" | "s_owners" | "s_dept_exact" | "s_dept_prefix"> {
    const level = this.level(key);
    const held = level !== "none";
    const owners = held ? [this.c.sub] : [];
    if (this.allows(key)) owners.push(...this.delegations(key).map((d) => d.from));
    const cap = this.levelCap();
    const org = [...this.values(key, "org")].filter((o) => (o === "*" ? cap >= rank("all") : cap >= rank("subtree")));
    const prefixes = org.filter((o) => o !== "*" && validDept(o)).map(likePrefix);
    if (level === "subtree" && this.dept) prefixes.push(likePrefix(this.dept));
    return {
      s_all: held && (level === "all" || org.includes("*")),
      s_owners: sortUnique(owners),
      s_dept_exact: level === "dept" && this.dept ? [this.dept] : [],
      s_dept_prefix: sortUnique(prefixes),
    };
  }

  /** E6–E9: the list parameters for key K and what is degraded. */
  scope(t: ResourceType, key: string, graphIds?: readonly string[] | null): { params: ScopeParams; degraded: string[] } {
    const s_dims: ScopeParams["s_dims"] = {};
    for (const d of t.dimensions ?? []) {
      if (IDENTITY_DIMS.has(d)) continue;
      const v = this.values(key, d);
      s_dims[d] = { all: v.has("*"), ids: sortUnique([...v].filter((x) => x !== "*")) };
    }
    const rels = this.relations(t, key);
    const graphOn = t.derivation === "graph" && this.cap("graph");
    const params: ScopeParams = {
      ...this.identity(key),
      s_dims,
      s_acl: rels.length > 0,
      s_relations: rels,
      s_subjects: this.subjects(key),
      s_graph_ids: graphOn && this.allows(key) ? sortUnique(graphIds ?? []) : [],
    };
    return { params, degraded: t.derivation === "graph" && !graphOn ? ["graph"] : [] };
  }

  private aclCounts(a: AclRow): boolean {
    return a.expires_at === undefined || a.expires_at === null || Math.floor(Date.parse(a.expires_at) / 1000) > this.now;
  }

  private branches(t: ResourceType, key: string, row: Row, acl: readonly AclRow[], graphIds?: readonly string[] | null): Branches {
    const { params: p } = this.scope(t, key, graphIds);
    const ident = (t.dimensions ?? []).filter((d) => IDENTITY_DIMS.has(d));
    const dept = row.dept_path ?? "";
    const identOk =
      ident.length === 0 ||
      p.s_all ||
      (ident.includes("owner") && row.owner !== undefined && p.s_owners.includes(row.owner)) ||
      (ident.includes("org") && (p.s_dept_exact.includes(dept) || p.s_dept_prefix.some((x) => likeMatch(dept, x))));
    const failingDims = Object.entries(p.s_dims)
      .filter(([d, v]) => !(v.all || (row.values?.[d] !== undefined && v.ids.includes(row.values[d]!))))
      .map(([d]) => d);
    const hasRule = this.has(key);
    const matches = !p.s_acl
      ? []
      : acl.filter((a) => a.rtype === t.type && a.rid === row.id && p.s_relations.includes(a.relation) && p.s_subjects.includes(a.subject) && this.aclCounts(a));
    const rule = hasRule && identOk && failingDims.length === 0;
    const graph = p.s_graph_ids.includes(row.id);
    return { params: p, hasRule, identOk, failingDims, rule, acl: matches, graph, visible: rule || matches.length > 0 || graph };
  }

  /** E10 vis(K, r): a row is in a list for K exactly when this holds (List/Can consistency). */
  visibleFor(t: ResourceType, key: string, row: Row, acl: readonly AclRow[], graphIds?: readonly string[] | null): boolean {
    return this.branches(t, key, row, acl, graphIds).visible;
  }

  /** E10: visibility by the type's view_key, the action by K. */
  decide(t: ResourceType, key: string, row: Row, acl: readonly AclRow[], graphIds?: readonly string[] | null): Decision {
    const visible = this.visibleFor(t, t.view_key, row, acl, graphIds);
    const allowed = visible && this.visibleFor(t, key, row, acl, graphIds);
    const reason: Reason = !visible ? "NOT_FOUND" : allowed ? "" : this.has(key) ? "OUT_OF_SCOPE" : "MISSING_PERMISSION";
    return { visible, allowed, reason };
  }

  /** E11: masked without the read key; read-only with read but without a held edit key. */
  fields(t: ResourceType): FieldAccess {
    const masked = new Set<string>();
    const readOnly = new Set<string>();
    for (const f of t.fields ?? []) {
      const into = !this.has(f.read) ? masked : !f.edit || !this.has(f.edit) ? readOnly : undefined;
      for (const col of f.columns) into?.add(col);
    }
    return { masked: sortUnique(masked), readOnly: sortUnique([...readOnly].filter((c) => !masked.has(c))) };
  }

  /** E12: the facts behind vis(K, r); a record the caller cannot see reveals none of its attributes (R62). */
  explain(t: ResourceType, key: string, row: Row, acl: readonly AclRow[], graphIds?: readonly string[] | null): { reasons: Fact[]; missing: Fact[] } {
    const br = this.branches(t, key, row, acl, graphIds);
    if (br.visible) return { reasons: sortFacts(this.reasonFacts(t, key, row, br)), missing: [] };
    const visible = this.visibleFor(t, t.view_key, row, acl, graphIds);
    return { reasons: [], missing: sortFacts(this.missingFacts(t, key, row, br, visible)) };
  }

  private reasonFacts(t: ResourceType, key: string, row: Row, br: Branches): Fact[] {
    const out: Fact[] = [];
    if (br.rule) {
      out.push(...this.holders(key).map((r) => ({ kind: "role_key", source: r, detail: key })));
      const { level, best } = this.levelOf(key);
      if (best !== undefined && (t.dimensions ?? []).some((d) => IDENTITY_DIMS.has(d))) out.push({ kind: "level", source: best, detail: level });
      out.push(...Object.keys(br.params.s_dims).map((d) => ({ kind: "dimension", source: d, detail: row.values?.[d] ?? "" })));
      for (const d of this.delegations(key)) if (row.owner === d.from) out.push({ kind: "delegation", source: d.id ?? "", detail: d.from });
      out.push(...this.ceilings.map(([code]) => ({ kind: "ceiling", source: code, detail: key })));
    }
    for (const a of br.acl) {
      const kind = (t.relations[a.relation]?.owned_by ?? "authz") === "component" ? "relation" : "share";
      out.push({ kind, source: a.relation, detail: a.subject });
    }
    if (br.graph) out.push({ kind: "relation", source: "graph", detail: row.id });
    return out;
  }

  private missingFacts(t: ResourceType, key: string, row: Row, br: Branches, visible: boolean): Fact[] {
    const out: Fact[] = [];
    const blocking = this.ceilings.filter(([, p]) => !((p.keys ?? []).includes(key) || (p.fields ?? []).includes(key)));
    if (blocking.length > 0) out.push(...blocking.map(([code]) => ({ kind: "ceiling", source: code, detail: key })));
    else if (!br.hasRule) out.push({ kind: "role_key", source: "", detail: key });
    else {
      if ((t.dimensions ?? []).some((d) => IDENTITY_DIMS.has(d)) && !br.identOk) out.push({ kind: "level", source: "", detail: this.level(key) });
      out.push(...br.failingDims.map((d) => ({ kind: "dimension", source: d, detail: visible ? (row.values?.[d] ?? "") : "" })));
    }
    for (const [name, rel] of Object.entries(t.relations ?? {})) {
      const cap = relationCapability(rel);
      if (!this.cap(cap) && relationGrants(t.relations, name).has(key)) out.push({ kind: "capability", source: cap, detail: "" });
    }
    if (t.derivation === "graph" && !this.cap("graph")) out.push({ kind: "capability", source: "graph", detail: "" });
    return out;
  }
}

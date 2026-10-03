// The core of contract-infra-authz EVALUATION.md (authz/2.0): E1 bundle acceptance, E2 token checks,
// E3 validity windows, E4 ceilings, E5 keys. Levels, dimensions, subject sets and single-record decisions
// (E6–E12) arrive with Access (T6).

export interface Grant {
  default_level?: string;
  levels?: Record<string, string>;
  values?: Record<string, string[]>;
  from_ts?: number;
  until?: number;
}

export interface Profile {
  keys?: string[];
  fields?: string[];
  max_level?: string;
  relations?: string[];
}

export interface Delegation {
  id?: string;
  mode: string;
  from: string;
  to: string;
  keys: string[];
  from_ts?: number;
  until?: number;
}

export interface Bundle {
  contract: string;
  revision?: string;
  roles: Record<string, string[]>;
  grants: Record<string, Grant>;
  profiles: Record<string, Profile>;
  delegations: Delegation[];
  stale_since: Record<string, number>;
  revoked_grants: Record<string, number>;
  capabilities: Record<string, unknown>;
}

export interface Act {
  sub: string;
  kind: string;
  act?: Act;
}

export interface TokenClaims {
  sub: string;
  iat: number;
  roles?: string[];
  dept_path?: string;
  act?: Act;
  ceil?: string[];
  dg?: string;
}

export type TokenVerdict = "OK" | "TOKEN_STALE" | "UNSUPPORTED_DELEGATION";

const CONTRACT = /^authz\/2\.(0|[1-9][0-9]*)$/;
const STALE_SKEW_S = 5;

/** E1: a bundle of `authz/2.x` is accepted (unknown members ignored); anything else is refused. */
export function acceptBundle(raw: unknown): Bundle | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const b = raw as Partial<Bundle>;
  if (typeof b.contract !== "string" || !CONTRACT.test(b.contract)) return undefined;
  return {
    contract: b.contract,
    revision: b.revision,
    roles: b.roles ?? {},
    grants: b.grants ?? {},
    profiles: b.profiles ?? {},
    delegations: b.delegations ?? [],
    stale_since: b.stale_since ?? {},
    revoked_grants: b.revoked_grants ?? {},
    capabilities: b.capabilities ?? {},
  };
}

function capability(b: Bundle, name: string): boolean {
  return b.capabilities[name] === true;
}

/** E2, in order; the first failure decides. */
export function checkToken(b: Bundle, c: TokenClaims): TokenVerdict {
  const since = b.stale_since[c.sub];
  if (since !== undefined && c.iat < since - STALE_SKEW_S) return "TOKEN_STALE";
  if (c.dg && Object.hasOwn(b.revoked_grants, c.dg)) return "TOKEN_STALE";
  const delegated = c.act !== undefined || (c.ceil?.length ?? 0) > 0 || (c.dg ?? "") !== "";
  if (delegated && !capability(b, "delegation")) return "UNSUPPORTED_DELEGATION";
  for (let a = c.act; a; a = a.act) {
    if (a.kind === "agent" && !capability(b, "agents")) return "UNSUPPORTED_DELEGATION";
    if (a.kind === "user" && !capability(b, "impersonation")) return "UNSUPPORTED_DELEGATION";
    if (a.kind !== "agent" && a.kind !== "user" && a.kind !== "svc") return "UNSUPPORTED_DELEGATION";
  }
  return "OK";
}

function inWindow(now: number, from?: number, until?: number): boolean {
  return (from === undefined || now >= from) && (until === undefined || now < until);
}

/** E3: the token's roles whose grant window contains `now`. */
export function activeRoles(b: Bundle, c: TokenClaims, now: number): string[] {
  return (c.roles ?? []).filter((r) => {
    const g = b.grants[r];
    return !g || inWindow(now, g.from_ts, g.until);
  });
}

/** E4: every ceiling lists the key in `keys` or `fields`; no ceilings allow every key. */
export function ceilingsAllow(b: Bundle, c: TokenClaims, key: string): boolean {
  return (c.ceil ?? []).every((code) => {
    const p = b.profiles[code];
    return p !== undefined && ((p.keys ?? []).includes(key) || (p.fields ?? []).includes(key));
  });
}

/** E5: holders or on-behalf delegations of the key, allowed by the ceilings. */
export function hasKey(b: Bundle, c: TokenClaims, key: string, now: number): boolean {
  const holders = activeRoles(b, c, now).filter((r) => (b.roles[r] ?? []).includes(key));
  const delegations = capability(b, "delegation")
    ? b.delegations.filter((d) => d.mode === "on_behalf" && d.to === c.sub && d.keys.includes(key) && inWindow(now, d.from_ts, d.until))
    : [];
  return (holders.length > 0 || delegations.length > 0) && ceilingsAllow(b, c, key);
}

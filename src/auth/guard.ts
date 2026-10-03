// The route decision chain (P6.2, P1.5): Public → verify the token → no bundle yet: 503 → token checks
// (stale, revoked grant, delegation; E2) → Authenticated → the route's key (E4, E5) → allow.
import type { Unit } from "../context.js";
import { BeError, platformError } from "../errors/beError.js";
import { checkToken, hasKey } from "./decide.js";
import type { BundleSource } from "./bundle.js";
import type { JwtVerifier } from "./jwt.js";

export type PermKey = string;
export const PUBLIC = "__public__";
export const AUTHENTICATED = "__authenticated__";
export type Guard = PermKey;

export interface AuthDeps {
  verifier: JwtVerifier | undefined;
  bundle: BundleSource | undefined;
  now?: () => number;
}

/** Decides one request and fills the unit (user, bundle, perm); throws the BeError to answer. */
export async function decide(guard: Guard, authorization: string | undefined, unit: Unit, deps: AuthDeps): Promise<void> {
  if (guard === PUBLIC) return;
  if (!deps.verifier) throw platformError("AUTHZ_NOT_READY", undefined, "IAM_URL is not configured");
  const m = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(authorization ?? "");
  if (!m) throw platformError("TOKEN_INVALID", undefined, "missing or malformed Authorization header");
  const user = await deps.verifier.verify(m[1]!);
  unit.user = user;
  unit.setToken(m[1]!);
  unit.perm = guard === AUTHENTICATED ? undefined : guard;
  const b = deps.bundle?.current();
  if (!b) throw platformError("AUTHZ_NOT_READY");
  unit.bundle = b;
  const claims = { sub: user.sub, iat: user.iat, roles: user.roles, act: user.act, ceil: user.ceil, dg: user.dg };
  const verdict = checkToken(b, claims);
  if (verdict === "TOKEN_STALE") throw staleError();
  if (verdict !== "OK") throw platformError(verdict);
  if (guard === AUTHENTICATED) return;
  if (!hasKey(b, claims, guard, Math.floor((deps.now?.() ?? Date.now()) / 1000))) {
    throw platformError("MISSING_PERMISSION", { permission: guard });
  }
}

function staleError(): BeError {
  const e = platformError("TOKEN_STALE");
  return Object.assign(e, { headers: { "www-authenticate": 'Bearer error="token_stale"' } });
}

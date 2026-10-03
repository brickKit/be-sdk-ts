// `access()`: the one entry point to the caller's authorization (sdk-redesign-apis §2.5). T1 offers the user and
// feature keys (E5); scopes, single-record decisions, masks and row actions arrive with T6.
import { currentUnit } from "../context.js";
import { platformError } from "../errors/beError.js";
import { hasKey, type Bundle } from "./decide.js";
import type { VerifiedUser } from "./jwt.js";

export interface User {
  sub: string;
  tenantId: string;
  roles: string[];
  deptPath: string;
  hasDept: boolean;
  act?: VerifiedUser["act"];
  locale: string;
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

  /** A feature key, ceilings applied (E4, E5). */
  has(key: string): boolean {
    return this.b !== undefined && hasKey(this.b, { sub: this.u.sub, iat: this.u.iat, roles: this.u.roles, ceil: this.u.ceil, dg: this.u.dg, act: this.u.act }, key, Math.floor(Date.now() / 1000));
  }
}

/** The caller's access; without a user (an event handler, a gRPC system call) throws 401 TOKEN_INVALID. */
export function access(): Access {
  const u = currentUnit();
  if (!u?.user) throw platformError("TOKEN_INVALID", undefined, "no user in this context");
  return new Access(u.user, u.bundle, u.perm);
}

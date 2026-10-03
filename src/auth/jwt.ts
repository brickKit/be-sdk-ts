// Access-token verification (P5): RS256 / ES256 / EdDSA only and equal to the JWKS key's alg, kid required,
// iss / aud / typ / sub / exp / iat / jti required, 60 s skew. JWKS cached at most 1 h, an unknown kid refetches
// at most once per 30 s, each fetch times out after 3 s, a failed fetch keeps the keys held (fail-static).
import { decodeProtectedHeader, importJWK, jwtVerify, type JWK, type JWTPayload } from "jose";
import { platformError } from "../errors/beError.js";
import type { Act } from "./decide.js";

const ALGS = ["RS256", "ES256", "EdDSA"];
const CACHE_MS = 3_600_000;
const REFETCH_MS = 30_000;
const FETCH_TIMEOUT_MS = 3_000;
const SKEW_S = 60;

export interface VerifiedUser {
  sub: string;
  tenantId: string;
  roles: string[];
  /** "" when absent or empty: no department (P6.4) */
  deptPath: string;
  act?: Act;
  ceil: string[];
  dg: string;
  azp: string;
  locale: string;
  iat: number;
  exp: number;
  jti: string;
}

export interface JwtVerifierOptions {
  jwksUrl: string;
  issuer: string;
  audience: string;
  now?: () => number;
  onFetchError?: (err: unknown) => void;
}

type KeyEntry = { key: Awaited<ReturnType<typeof importJWK>>; alg: string };

export class JwtVerifier {
  private readonly o: JwtVerifierOptions;
  private keys = new Map<string, KeyEntry>();
  private fetchedAt = -Infinity;
  private lastAttempt = -Infinity;
  private inflight: Promise<void> | undefined;

  constructor(o: JwtVerifierOptions) {
    this.o = o;
  }

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  /** Loads the keys in the background at start (P1.2); failures are only reported. */
  async warm(): Promise<void> {
    await this.refresh().catch(() => {});
  }

  async verify(token: string): Promise<VerifiedUser> {
    try {
      return await this.verifyInner(token);
    } catch (e) {
      throw platformError("TOKEN_INVALID", undefined, `access token refused: ${(e as Error).message}`, e);
    }
  }

  private async verifyInner(token: string): Promise<VerifiedUser> {
    const header = decodeProtectedHeader(token);
    if (typeof header.kid !== "string" || header.kid === "") throw new Error("kid is required");
    if (!ALGS.includes(String(header.alg))) throw new Error(`alg ${String(header.alg)} is not allowed`);
    const entry = await this.keyFor(header.kid);
    if (entry.alg !== header.alg) throw new Error("alg differs from the key's alg");
    const { payload } = await jwtVerify(token, entry.key, {
      algorithms: [entry.alg],
      issuer: this.o.issuer,
      audience: this.o.audience,
      clockTolerance: SKEW_S,
      currentDate: new Date(this.now()),
      requiredClaims: ["exp", "iat", "jti", "sub"],
    });
    return claimsOf(payload);
  }

  private async keyFor(kid: string): Promise<KeyEntry> {
    const now = this.now();
    if (now - this.fetchedAt > CACHE_MS && now - this.lastAttempt >= REFETCH_MS) await this.refresh().catch(() => {});
    let k = this.keys.get(kid);
    if (!k && this.now() - this.lastAttempt >= REFETCH_MS) {
      await this.refresh().catch(() => {});
      k = this.keys.get(kid);
    }
    if (!k) throw new Error(`unknown kid ${kid}`);
    return k;
  }

  private refresh(): Promise<void> {
    this.inflight ??= this.fetchKeys().finally(() => (this.inflight = undefined));
    return this.inflight;
  }

  private async fetchKeys(): Promise<void> {
    this.lastAttempt = this.now();
    try {
      const res = await fetch(this.o.jwksUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`JWKS answered ${res.status}`);
      const body = (await res.json()) as { keys?: JWK[] };
      const next = new Map<string, KeyEntry>();
      for (const jwk of body.keys ?? []) {
        if (typeof jwk.kid !== "string" || typeof jwk.alg !== "string" || !ALGS.includes(jwk.alg)) continue;
        next.set(jwk.kid, { key: await importJWK(jwk, jwk.alg), alg: jwk.alg });
      }
      this.keys = next;
      this.fetchedAt = this.now();
    } catch (e) {
      this.o.onFetchError?.(e);
      throw e;
    }
  }
}

function str(p: JWTPayload, k: string, required = false): string {
  const v = p[k];
  if (v === undefined || v === null) {
    if (required) throw new Error(`${k} is required`);
    return "";
  }
  if (typeof v !== "string") throw new Error(`${k} is not a string`);
  return v;
}

function strArray(p: JWTPayload, k: string): string[] {
  const v = p[k];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new Error(`${k} is not an array of strings`);
  return v as string[];
}

function actOf(v: unknown): Act | undefined {
  if (v === undefined || v === null) return undefined;
  const a = v as Act;
  if (typeof a !== "object" || typeof a.sub !== "string" || typeof a.kind !== "string") throw new Error("act is malformed");
  return { sub: a.sub, kind: a.kind, act: actOf(a.act) };
}

function claimsOf(p: JWTPayload): VerifiedUser {
  if (p.typ !== "access") throw new Error("typ is not access");
  const sub = str(p, "sub", true);
  if (sub === "") throw new Error("sub is empty");
  return {
    sub,
    tenantId: str(p, "tenant_id"),
    roles: strArray(p, "roles"),
    deptPath: str(p, "dept_path"),
    act: actOf(p.act),
    ceil: strArray(p, "ceil"),
    dg: str(p, "dg"),
    azp: str(p, "azp"),
    locale: str(p, "locale"),
    iat: Number(p.iat),
    exp: Number(p.exp),
    jti: str(p, "jti", true),
  };
}

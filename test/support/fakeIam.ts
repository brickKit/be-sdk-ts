// A JWKS endpoint and token signer for tests (the in-process fake-iam of sdk-redesign §4.2, reduced).
import { createServer, type Server } from "node:http";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";

export interface FakeIam {
  url: string;
  issuer: string;
  tenant: string;
  fetches: number;
  sign(claims?: Record<string, unknown>, opts?: { kid?: string | null; alg?: string; key?: string }): Promise<string>;
  addKey(kid: string, alg?: "RS256" | "ES256" | "EdDSA"): Promise<void>;
  publish(kids: string[]): void;
  down(isDown: boolean): void;
  close(): Promise<void>;
}

export async function fakeIam(): Promise<FakeIam> {
  const keys = new Map<string, { priv: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"]; jwk: JWK; alg: string }>();
  let published: string[] = [];
  let isDown = false;
  const state = { fetches: 0 };
  const server: Server = createServer((req, res) => {
    if (req.url !== "/.well-known/jwks.json") return void res.writeHead(404).end();
    state.fetches++;
    if (isDown) return void res.writeHead(503).end();
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ keys: published.map((k) => keys.get(k)!.jwk) }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const iam: FakeIam = {
    url,
    issuer: "urn:be:t1:iam",
    tenant: "t1",
    get fetches() {
      return state.fetches;
    },
    async addKey(kid, alg = "RS256") {
      const { privateKey, publicKey } = await generateKeyPair(alg, { extractable: true, ...(alg === "EdDSA" ? { crv: "Ed25519" } : {}) });
      keys.set(kid, { priv: privateKey, jwk: { ...(await exportJWK(publicKey)), kid, alg, use: "sig" }, alg });
    },
    publish(kids) {
      published = kids;
    },
    down(d) {
      isDown = d;
    },
    async sign(claims = {}, opts = {}) {
      const kid = opts.kid === undefined ? "k1" : opts.kid;
      const k = keys.get(opts.key ?? kid ?? "k1")!;
      const now = Math.floor(Date.now() / 1000);
      const body = { iss: iam.issuer, aud: iam.tenant, sub: "u_me", typ: "access", iat: now, exp: now + 600, jti: `j${Math.random()}`, roles: ["rep"], dept_path: "/1/", ...claims };
      for (const [k2, v] of Object.entries(body)) if (v === undefined) delete (body as Record<string, unknown>)[k2];
      const header: Record<string, unknown> = { alg: opts.alg ?? k.alg };
      if (kid !== null) header.kid = kid;
      return new SignJWT(body).setProtectedHeader(header as { alg: string }).sign(k.priv);
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
  await iam.addKey("k1");
  iam.publish(["k1"]);
  return iam;
}

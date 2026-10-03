import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JwtVerifier } from "../../../src/auth/jwt.js";
import { fakeIam, type FakeIam } from "../../support/fakeIam.js";

let iam: FakeIam;
let clock = Date.now();
const verifier = () => new JwtVerifier({ jwksUrl: `${iam.url}/.well-known/jwks.json`, issuer: iam.issuer, audience: iam.tenant, now: () => clock });
const reasonOf = async (p: Promise<unknown>) => p.then(() => "OK", (e) => `${e.code}/${e.reason}`);

beforeAll(async () => {
  iam = await fakeIam();
});
afterAll(() => iam.close());

describe("JwtVerifier (P5)", () => {
  it("accepts a valid access token and returns its claims", async () => {
    const u = await verifier().verify(await iam.sign({ roles: ["rep", "mgr"] }));
    expect(u.sub).toBe("u_me");
    expect(u.roles).toEqual(["rep", "mgr"]);
    expect(u.deptPath).toBe("/1/");
  });

  it.each([
    ["refresh token", { typ: "refresh" }],
    ["missing typ", { typ: undefined }],
    ["wrong issuer", { iss: "urn:be:other:iam" }],
    ["wrong audience", { aud: "t2" }],
    ["no exp", { exp: undefined }],
    ["no jti", { jti: undefined }],
    ["empty sub", { sub: "" }],
    ["expired beyond skew", { exp: Math.floor(Date.now() / 1000) - 120 }],
    ["roles of the wrong type", { roles: "rep" }],
  ])("refuses %s", async (_n, claims) => {
    expect(await reasonOf(verifier().verify(await iam.sign(claims)))).toBe("UNAUTHENTICATED/TOKEN_INVALID");
  });

  it("accepts exp within the 60 s skew and an audience array", async () => {
    const t = await iam.sign({ exp: Math.floor(Date.now() / 1000) - 30, aud: ["x", "t1"] });
    expect(await reasonOf(verifier().verify(t))).toBe("OK");
  });

  it("refuses a token without kid, HMAC and an alg other than the key's", async () => {
    const v = verifier();
    expect(await reasonOf(v.verify(await iam.sign({}, { kid: null, key: "k1" })))).toBe("UNAUTHENTICATED/TOKEN_INVALID");
    const hs = await new SignJWT({ sub: "x" }).setProtectedHeader({ alg: "HS256", kid: "k1" }).sign(new TextEncoder().encode("k".repeat(32)));
    expect(await reasonOf(v.verify(hs))).toBe("UNAUTHENTICATED/TOKEN_INVALID");
    await iam.addKey("ec1", "ES256");
    iam.publish(["k1", "ec1"]);
    expect(await reasonOf(v.verify(await iam.sign({}, { kid: "ec1" })))).toBe("OK");
    expect(await reasonOf(v.verify("not-a-jwt"))).toBe("UNAUTHENTICATED/TOKEN_INVALID");
  });

  it("refetches once for an unknown kid, at most every 30 s, and keeps old keys when the fetch fails", async () => {
    iam.publish(["k1"]);
    const v = verifier();
    await v.verify(await iam.sign());
    const before = iam.fetches;
    await iam.addKey("k2", "EdDSA");
    clock += 31_000; // the first load counts as the last fetch
    expect(await reasonOf(v.verify(await iam.sign({}, { kid: "k2" })))).toBe("UNAUTHENTICATED/TOKEN_INVALID");
    expect(iam.fetches).toBe(before + 1);
    iam.publish(["k1", "k2"]);
    expect(await reasonOf(v.verify(await iam.sign({}, { kid: "k2" })))).toBe("UNAUTHENTICATED/TOKEN_INVALID");
    expect(iam.fetches).toBe(before + 1); // within 30 s: no refetch
    clock += 31_000;
    expect(await reasonOf(v.verify(await iam.sign({}, { kid: "k2" })))).toBe("OK");
    iam.down(true);
    clock += 3_700_000; // past the 1 h cache: the refetch fails, the keys held stay (fail-static)
    const at = Math.floor(clock / 1000);
    expect(await reasonOf(v.verify(await iam.sign({ iat: at, exp: at + 600 }, { kid: "k1" })))).toBe("OK");
    iam.down(false);
  });
});

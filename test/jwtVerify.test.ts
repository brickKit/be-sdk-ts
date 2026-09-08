import { afterEach, describe, expect, it } from "vitest";
import { SignJWT, UnsecuredJWT } from "jose";
import { JWTVerifier } from "../src/jwtVerify.js";
import { startFakeJWKS, type FakeJWKS } from "./helpers.js";

describe("JWTVerifier", () => {
  let jwks: FakeJWKS;

  afterEach(async () => {
    await jwks?.close();
  });

  it("合法签名的 token 验签通过，claims 字段正确映射", async () => {
    jwks = await startFakeJWKS();
    const verifier = new JWTVerifier(jwks.url);
    const token = await jwks.sign({
      sub: "u_zhangsan",
      roles: ["sales_rep"],
      dept_path: "/root/china/east/sh-sales",
      org_id: "org_1",
    });

    const claims = await verifier.verify(token);

    expect(claims.sub).toBe("u_zhangsan");
    expect(claims.roles).toEqual(["sales_rep"]);
    expect(claims.deptPath).toBe("/root/china/east/sh-sales");
    expect(claims.orgId).toBe("org_1");
    expect(claims.issuedAt).toBeInstanceOf(Date);
  });

  it("签名被篡改的 token 拒绝验签", async () => {
    jwks = await startFakeJWKS();
    const verifier = new JWTVerifier(jwks.url);
    const token = await jwks.sign({ sub: "u1" });
    const parts = token.split(".");
    // ⚠️ 真机踩出来的一处坑：不能翻转签名段**最后一个**字符——RS256
    // 签名是 256 字节，Base64URL 无填充编码下最后一组只剩 1 个字节，
    // 编码用两个字符表示 8 位，但第二个字符只有**高 2 位**是有意义的
    // （低 4 位恒为 0），"A"(000000) 与 "B"(000001) 的高 2 位都是
    // "00"——Node 的 Buffer.from 对 base64url 解码是宽松的，不校验低位
    // 填充位，所以这么翻转解码出来的字节其实没变，测试会假绿。改成翻转
    // **中间**一个字符——那里的 6 位全部有意义，任何变动都会改变解码
    // 出来的字节。
    const midIndex = Math.floor(parts[2]!.length / 2);
    const midChar = parts[2]!.charAt(midIndex);
    const flipped = midChar === "A" ? "B" : "A";
    const tampered =
      parts[0] +
      "." +
      parts[1] +
      "." +
      parts[2]!.slice(0, midIndex) +
      flipped +
      parts[2]!.slice(midIndex + 1);

    await expect(verifier.verify(tampered)).rejects.toThrow();
  });

  it("alg: none 的 unsecured token 拒绝验签", async () => {
    jwks = await startFakeJWKS();
    const verifier = new JWTVerifier(jwks.url);
    // ⚠️ jose 的 jwtVerify 本身就"从不接受 unsecured JWT"（真机核对过
    // 的库行为，同 Go 的 golang-jwt、Python 的 PyJWT）——这条测试锁的
    // 是这个事实持续成立，不是我们自己实现了什么防御逻辑。
    const unsecured = new UnsecuredJWT({ sub: "u1", iat: Math.floor(Date.now() / 1000) }).encode();

    await expect(verifier.verify(unsecured)).rejects.toThrow();
  });

  it("缺少 sub 的 token 拒绝验签（requiredClaims 强制，不是手写判断）", async () => {
    jwks = await startFakeJWKS();
    const verifier = new JWTVerifier(jwks.url);
    const noSubToken = await new SignJWT({ iat: Math.floor(Date.now() / 1000) })
      .setProtectedHeader({ alg: "RS256", kid: jwks.kid })
      .sign(jwks.privateKey);

    await expect(verifier.verify(noSubToken)).rejects.toThrow();
  });

  it("缺少 iat 的 token 拒绝验签（requiredClaims 强制，不是手写判断）", async () => {
    jwks = await startFakeJWKS();
    const verifier = new JWTVerifier(jwks.url);
    const noIatToken = await new SignJWT({ sub: "u1" })
      .setProtectedHeader({ alg: "RS256", kid: jwks.kid })
      .sign(jwks.privateKey);

    await expect(verifier.verify(noIatToken)).rejects.toThrow();
  });
});

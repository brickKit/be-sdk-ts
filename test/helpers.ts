/**
 * 测试夹具——对应 be-sdk-go 的 newTestJWKS、be-sdk-python 的
 * tests/helpers.py。
 *
 * `infra-iam-casdoor`（真实签发方）要到阶段三 Task 7 才建仓库，这里自
 * 己起一对 RSA 密钥 + 一个真实绑定端口的 `node:http` 服务器当 JWKS
 * 端点——加密运算是真的（`jose` 的 `generateKeyPair`/`SignJWT` 都是真
 * 实实现，不是 mock），只是"发这个 JWKS 的人是谁"是测试夹具。
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  calculateJwkThumbprint,
  type JWK,
  type KeyLike,
} from "jose";

export interface SignOptions {
  /** 不传则用当前时间——测试 stale/expired 场景时显式传一个偏移过的时间戳（秒）。 */
  iat?: number;
  /** 相对 iat 的过期秒数，默认 600（与 infra-authz 的 accessTokenTtlSeconds 默认值一致）。 */
  expSeconds?: number;
}

export interface FakeJWKS {
  url: string;
  kid: string;
  privateKey: KeyLike;
  /** 用夹具私钥签一个合法 RS256 token——业务 claims 之外的 sub/iat/exp 由 opts 控制。 */
  sign: (claims: Record<string, unknown> & { sub: string }, opts?: SignOptions) => Promise<string>;
  close: () => Promise<void>;
}

export async function startFakeJWKS(): Promise<FakeJWKS> {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk: JWK = await exportJWK(publicKey);
  const kid = await calculateJwkThumbprint(jwk);
  jwk.kid = kid;
  jwk.alg = "RS256";
  jwk.use = "sig";

  const server: Server = createServer((req, res) => {
    if (req.url === "/jwks.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  const sign = async (
    claims: Record<string, unknown> & { sub: string },
    opts: SignOptions = {},
  ): Promise<string> => {
    const iat = opts.iat ?? Math.floor(Date.now() / 1000);
    const exp = iat + (opts.expSeconds ?? 600);
    return new SignJWT({ ...claims, iat, exp })
      .setProtectedHeader({ alg: "RS256", kid })
      .sign(privateKey);
  };

  return {
    url: `http://127.0.0.1:${port}/jwks.json`,
    kid,
    privateKey,
    sign,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

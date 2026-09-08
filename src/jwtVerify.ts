/**
 * JWT 本地验签——对应 be-sdk-go 的 jwt.go、be-sdk-python 的
 * jwt_verify.py。
 *
 * ⚠️ 用 `jose`（决策 32：有现成的就用现成的）——它的 `createRemoteJWKSet`
 * 自带 JWK Set 缓存与刷新（含失败冷却时间），不需要自己再写一份，同
 * be-sdk-go 用 `MicahParks/keyfunc`、be-sdk-python 用 `PyJWKClient` 的
 * 理由。`jose` 是原生 ESM + Web Crypto，`jwtVerify` 本身就是异步的，不
 * 存在 Python 版那种"同步库需要 `asyncio.to_thread` 包一层"的问题。
 */

import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

/** 本地验签后从 JWT 里取出的身份信息（设计书 §14.1.5：JWT 只带身份，权限键一个都不进）。 */
export interface Claims {
  sub: string;
  roles: string[];
  deptPath: string;
  orgId: string;
  issuedAt: Date;
}

/**
 * 包一层 `createRemoteJWKSet`——理由见模块文档。
 */
export class JWTVerifier {
  private readonly getKey: JWTVerifyGetKey;

  constructor(jwksUrl: string) {
    this.getKey = createRemoteJWKSet(new URL(jwksUrl));
  }

  /**
   * 验签 + 解析。⚠️ 只认 RS256——Casdoor（`infra-iam-casdoor` 的
   * slot:iam 默认实现）与绝大多数 JWKS 发布方的默认算法，显式白名单防
   * "alg: none" 之类的算法混淆攻击（`jose` 本身也从不接受 unsecured
   * JWT，这里的白名单是纵深防御，同 Go/Python 版判据）。
   *
   * `requiredClaims: ["sub", "iat"]` 交给 `jose` 自己校验并抛
   * `JWTClaimValidationFailed`——不手写 `if (!sub) throw` 那一套，同
   * be-sdk-python 真机测试发现的教训：库自己已经做了，手写的分支是
   * 永远走不到的死代码。
   */
  async verify(token: string): Promise<Claims> {
    const { payload } = await jwtVerify(token, this.getKey, {
      algorithms: ["RS256"],
      requiredClaims: ["sub", "iat"],
    });
    const roles = Array.isArray(payload["roles"])
      ? (payload["roles"] as unknown[]).filter((r): r is string => typeof r === "string")
      : [];
    const deptPath = typeof payload["dept_path"] === "string" ? payload["dept_path"] : "";
    const orgId = typeof payload["org_id"] === "string" ? payload["org_id"] : "";
    return {
      sub: payload.sub as string,
      roles,
      deptPath,
      orgId,
      issuedAt: new Date((payload.iat as number) * 1000),
    };
  }
}

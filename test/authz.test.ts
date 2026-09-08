import { afterEach, describe, expect, it } from "vitest";
import type { Logger } from "pino";
import {
  AUTHENTICATED,
  PUBLIC,
  requirePermission,
  setAuthzRuntime,
  setupAuthzRuntime,
} from "../src/authz.js";
import { BundleCache } from "../src/bundle.js";
import { scopeOf } from "../src/scope.js";
import { Config } from "../src/config.js";
import { startFakeJWKS, type FakeJWKS } from "./helpers.js";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

function fakeLogger(): Logger {
  return { warn: () => {}, error: () => {}, info: () => {} } as unknown as Logger;
}

/** 每个测试结束后把进程级 authzRuntime 恢复成初始状态（两个都是 null）——同 Go/Python 版的测试隔离手法。 */
function withAuthzRuntime() {
  afterEach(() => {
    setAuthzRuntime(null, null);
  });
}

function fakeContext(auth?: string): { request: Request } {
  const headers = new Headers();
  if (auth !== undefined) headers.set("authorization", auth);
  return { request: new Request("http://localhost/graphql", { headers }) };
}

async function callResolver(
  perm: string,
  context: { request: Request },
): Promise<{ ok: true; value: string } | { ok: false; error: Error }> {
  const resolver = requirePermission(perm, async () => "ok");
  try {
    const value = (await resolver(undefined, {}, context as never, undefined as never)) as string;
    return { ok: true, value };
  } catch (err) {
    return { ok: false, error: err as Error };
  }
}

function errCode(err: Error): unknown {
  return (err as unknown as { extensions?: { code?: unknown } }).extensions?.code;
}

function errStatus(err: Error): unknown {
  return (err as unknown as { extensions?: { http?: { status?: unknown } } }).extensions?.http
    ?.status;
}

describe("authz constants", () => {
  it("PUBLIC 是常量不是空字符串字面量的巧合", () => {
    expect(PUBLIC).toBe("");
    expect(typeof PUBLIC).toBe("string");
  });

  it("AUTHENTICATED 与 PUBLIC 不同——阶段三 Task 4 发现的哨兵值缺口", () => {
    expect(AUTHENTICATED).not.toBe(PUBLIC);
    expect(typeof AUTHENTICATED).toBe("string");
  });
});

describe("requirePermission", () => {
  withAuthzRuntime();

  it("PUBLIC 放行，不需要 authzRuntime、不需要 Authorization", async () => {
    const result = await callResolver(PUBLIC, fakeContext());
    expect(result).toEqual({ ok: true, value: "ok" });
  });

  it("authzRuntime 未配置（阶段二遗留）：非 PUBLIC 一律 403", async () => {
    const result = await callResolver("erp.sales.view", fakeContext("Bearer whatever"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(errCode(result.error)).toBe("FORBIDDEN");
      expect(errStatus(result.error)).toBe(403);
      expect(result.error.message).toMatch(/权限判定尚未配置/);
    }
  });

  describe("配置了 iamJwksUrl 之后", () => {
    let jwks: FakeJWKS;

    afterEach(async () => {
      await jwks?.close();
    });

    it("缺少 Authorization：401", async () => {
      jwks = await startFakeJWKS();
      setAuthzRuntime(await import("../src/jwtVerify.js").then((m) => new m.JWTVerifier(jwks.url)), null);

      const result = await callResolver("erp.sales.view", fakeContext());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(errStatus(result.error)).toBe(401);
        expect(result.error.message).toMatch(/缺少或格式不对/);
      }
    });

    it("Authorization 不是 Bearer 前缀：401", async () => {
      jwks = await startFakeJWKS();
      const { JWTVerifier } = await import("../src/jwtVerify.js");
      setAuthzRuntime(new JWTVerifier(jwks.url), null);

      const result = await callResolver("erp.sales.view", fakeContext("Basic abcdef"));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(errStatus(result.error)).toBe(401);
    });

    it("token 签名验不过：401", async () => {
      jwks = await startFakeJWKS();
      const { JWTVerifier } = await import("../src/jwtVerify.js");
      setAuthzRuntime(new JWTVerifier(jwks.url), null);

      const result = await callResolver("erp.sales.view", fakeContext("Bearer not-a-real-jwt"));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(errStatus(result.error)).toBe(401);
        expect(result.error.message).toMatch(/token 无效/);
      }
    });

    it("AUTHENTICATED：验签通过、不查权限键就放行", async () => {
      jwks = await startFakeJWKS();
      const { JWTVerifier } = await import("../src/jwtVerify.js");
      setAuthzRuntime(new JWTVerifier(jwks.url), null);
      const token = await jwks.sign({ sub: "u1", roles: [] });

      const result = await callResolver(AUTHENTICATED, fakeContext(`Bearer ${token}`));
      expect(result).toEqual({ ok: true, value: "ok" });
    });

    it("验签通过但 bundle 从没连上过：具体权限键 503（不是 403）", async () => {
      jwks = await startFakeJWKS();
      const { JWTVerifier } = await import("../src/jwtVerify.js");
      setAuthzRuntime(new JWTVerifier(jwks.url), null); // bundle 为 null，等价于"没配 authzBundleUrl"
      const token = await jwks.sign({ sub: "u1", roles: ["sales_rep"] });

      const result = await callResolver("erp.sales.view", fakeContext(`Bearer ${token}`));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(errStatus(result.error)).toBe(503);
        expect(errCode(result.error)).toBe("SERVICE_UNAVAILABLE");
      }
    });

    it("bundle 连上过、角色里没有这条权限：403", async () => {
      jwks = await startFakeJWKS();
      const { JWTVerifier } = await import("../src/jwtVerify.js");
      const bundle = new BundleCache();
      await bundle.fetchOnce(await startFakeBundleServing({ sales_rep: ["erp.sales.view"] }), fakeLogger());
      setAuthzRuntime(new JWTVerifier(jwks.url), bundle);
      const token = await jwks.sign({ sub: "u1", roles: ["someone_else"] });

      const result = await callResolver("erp.sales.view", fakeContext(`Bearer ${token}`));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(errStatus(result.error)).toBe(403);
        expect(errCode(result.error)).toBe("FORBIDDEN");
      }
    });

    it("bundle 连上过、角色里有这条权限：200，且 scopeOf(context) 能读到正确的 ScopeFilter", async () => {
      jwks = await startFakeJWKS();
      const { JWTVerifier } = await import("../src/jwtVerify.js");
      const bundle = new BundleCache();
      await bundle.fetchOnce(await startFakeBundleServing({ sales_rep: ["erp.sales.view"] }), fakeLogger());
      setAuthzRuntime(new JWTVerifier(jwks.url), bundle);
      const token = await jwks.sign({
        sub: "u_zhangsan",
        roles: ["sales_rep"],
        dept_path: "/root/china/east/sh-sales",
      });

      const context = fakeContext(`Bearer ${token}`);
      const resolver = requirePermission("erp.sales.view", async (_s, _a, ctx: { request: Request }) => {
        return scopeOf(ctx);
      });
      const scope = await resolver(undefined, {}, context as never, undefined as never);

      expect(scope).toEqual({
        all: false,
        prefix: "/root/china/east/sh-sales",
        exact: "/root/china/east/sh-sales",
        owner: "u_zhangsan",
        in: [],
      });
    });

    it("token_stale：jwt.iat 早于 bundle 的 stale_since[sub] → 401 + WWW-Authenticate", async () => {
      jwks = await startFakeJWKS();
      const { JWTVerifier } = await import("../src/jwtVerify.js");
      const bundle = new BundleCache();
      const now = Math.floor(Date.now() / 1000);
      // ⚠️ 同 Go/Python 版踩过的坑：iat 不能设得太早，否则 token 自身的
      // exp（默认 iat+600）会先触发"token 过期"，永远走不到 stale
      // 判断那一步——这里用 2 分钟前签发 + stale_since 设在 1 分钟前，
      // 把"签发在 stale_since 之前、但仍在 TTL 内"这个场景单独隔离出来。
      await bundle.fetchOnce(
        await startFakeBundleServing({ sales_rep: ["erp.sales.view"] }, { u1: now - 60 }),
        fakeLogger(),
      );
      setAuthzRuntime(new JWTVerifier(jwks.url), bundle);
      const token = await jwks.sign({ sub: "u1", roles: ["sales_rep"] }, { iat: now - 120 });

      const result = await callResolver("erp.sales.view", fakeContext(`Bearer ${token}`));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(errStatus(result.error)).toBe(401);
        expect(result.error.message).toMatch(/token_stale/);
        const headers = (result.error as unknown as {
          extensions?: { http?: { headers?: Record<string, string> } };
        }).extensions?.http?.headers;
        expect(headers?.["WWW-Authenticate"]).toMatch(/token_stale/);
      }
    });

    it("token_stale 方向验证：iat 晚于 stale_since 时不 stale，正常放行", async () => {
      jwks = await startFakeJWKS();
      const { JWTVerifier } = await import("../src/jwtVerify.js");
      const bundle = new BundleCache();
      const now = Math.floor(Date.now() / 1000);
      await bundle.fetchOnce(
        await startFakeBundleServing({ sales_rep: ["erp.sales.view"] }, { u1: now - 120 }),
        fakeLogger(),
      );
      setAuthzRuntime(new JWTVerifier(jwks.url), bundle);
      const token = await jwks.sign({ sub: "u1", roles: ["sales_rep"] }, { iat: now - 60 });

      const result = await callResolver("erp.sales.view", fakeContext(`Bearer ${token}`));
      expect(result).toEqual({ ok: true, value: "ok" });
    });
  });
});

describe("setupAuthzRuntime", () => {
  it("两项配置都缺失时都返回 null，不阻断（阶段二遗留 fail-closed 行为的来源）", () => {
    const { verifier, bundle } = setupAuthzRuntime({
      config: new Config({}),
      logger: fakeLogger(),
    });
    expect(verifier).toBeNull();
    expect(bundle).toBeNull();
  });

  it("配了 iamJwksUrl/authzBundleUrl 之后两者都非 null", async () => {
    const jwks = await startFakeJWKS();
    try {
      const { verifier, bundle } = setupAuthzRuntime({
        config: new Config({ IAM_JWKS_URL: jwks.url, AUTHZ_BUNDLE_URL: "http://127.0.0.1:1/nowhere" }),
        logger: fakeLogger(),
      });
      expect(verifier).not.toBeNull();
      expect(bundle).not.toBeNull();
    } finally {
      await jwks.close();
    }
  });
});

/** 起一个只吐一次固定 bundle 内容的最小 HTTP 服务，返回它的 URL——专供本文件内单次 fetchOnce 用。 */
async function startFakeBundleServing(
  roles: Record<string, string[]>,
  staleSince: Record<string, number> = {},
): Promise<string> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ roles, stale_since: staleSince }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  // 这个测试服务器只需要响应一次，不必等它 close——进程测试结束时一起回收。
  return `http://127.0.0.1:${port}/authz/bundle`;
}

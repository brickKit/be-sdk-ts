/**
 * BundleCache/startBundlePoller——对应 be-sdk-go 的 bundle_test.go、
 * be-sdk-python 的 tests/test_bundle.py。
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { Logger } from "pino";
import { BUNDLE_POLL_INTERVAL_MS, BundleCache, startBundlePoller } from "../src/bundle.js";

function fakeLogger(): Logger {
  return { warn: () => {}, error: () => {}, info: () => {} } as unknown as Logger;
}

interface FakeBundleServer {
  url: string;
  close: () => Promise<void>;
  /** 下一次响应体——传 null 表示这次返回 500。 */
  setBody: (body: { roles: Record<string, string[]>; stale_since: Record<string, number> } | null) => void;
  /** 下一次响应用的 ETag；若请求带的 If-None-Match 与此相同则回 304。 */
  setEtag: (etag: string) => void;
  notModifiedCount: number;
}

function startFakeBundleServer(): Promise<FakeBundleServer> {
  let body: { roles: Record<string, string[]>; stale_since: Record<string, number> } | null = {
    roles: {},
    stale_since: {},
  };
  let etag = "v1";
  let notModifiedCount = 0;

  const server: Server = createServer((req, res) => {
    if (body === null) {
      // ⚠️ 故意带一个"看起来像合法 bundle"的 JSON 体（而不是空 body）：
      // 空 body 会在 res.json() 那步天然抛异常、被动触发 fail-static，
      // 那样测不出"状态码判断本身"是否在生效。这里给一个真的能被解析成
      // BundleWireFormat 的body，只有状态码检查真的挡在前面时，这条
      // "非 200 时 fail-static" 的测试才有意义。
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ roles: {}, stale_since: {} }));
      return;
    }
    const ifNoneMatch = req.headers["if-none-match"];
    if (ifNoneMatch === etag) {
      notModifiedCount++;
      // ⚠️ 故意 res.end(body) 传非空内容——但真机测出来 Node 的
      // http.ServerResponse 会为 304 静默丢弃 body（同 204，属于 HTTP
      // 语义上"不允许带 body"的状态码集合），fetch() 收到的始终是空
      // body。所以这条测试即使去掉源码里的 304 分支也仍然会绿：那种
      // 情况下走的是"JSON 解析空 body 失败 → fail-static"这条另外的
      // 兜底路径，而不是 304 分支本身——两条路径叠在一起对结果没有
      // 影响，这里如实记录，不假装测试锁住了它没有真正锁住的那一支。
      res.writeHead(304, { etag, "content-type": "application/json" });
      res.end(JSON.stringify({ roles: {}, stale_since: {} }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json", etag });
    res.end(JSON.stringify(body));
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/authz/bundle`,
        close: () => new Promise<void>((r) => server.close(() => r())),
        setBody: (b) => {
          body = b;
        },
        setEtag: (e) => {
          etag = e;
        },
        get notModifiedCount() {
          return notModifiedCount;
        },
      });
    });
  });
}

describe("BundleCache", () => {
  let server: FakeBundleServer;

  afterEach(async () => {
    await server?.close();
  });

  it("fetchOnce 之前：hasEverFetched 为 false，任何权限查询都是 false", () => {
    const cache = new BundleCache();
    expect(cache.hasEverFetched()).toBe(false);
    expect(cache.hasPermission(["authz_admin"], "infra.authz.admin")).toBe(false);
  });

  it("fetchOnce 成功后：纯并集展开可以查到权限", async () => {
    server = await startFakeBundleServer();
    server.setBody({ roles: { sales_rep: ["erp.sales.view", "erp.sales.create"] }, stale_since: {} });
    const cache = new BundleCache();

    await cache.fetchOnce(server.url, fakeLogger());

    expect(cache.hasEverFetched()).toBe(true);
    expect(cache.hasPermission(["sales_rep"], "erp.sales.view")).toBe(true);
    expect(cache.hasPermission(["sales_rep"], "erp.sales.delete")).toBe(false);
    expect(cache.hasPermission(["someone_else"], "erp.sales.view")).toBe(false);
  });

  it("ETag 命中 304 时不清空旧内容", async () => {
    server = await startFakeBundleServer();
    server.setEtag("v1");
    server.setBody({ roles: { r1: ["p1"] }, stale_since: {} });
    const cache = new BundleCache();
    await cache.fetchOnce(server.url, fakeLogger());
    expect(cache.hasPermission(["r1"], "p1")).toBe(true);

    // 服务端把响应体换成"这个角色什么权限都没有"，但 ETag 不变——条件
    // GET 应该收到 304，缓存必须保持第一次拉到的内容不变。
    server.setBody({ roles: {}, stale_since: {} });
    await cache.fetchOnce(server.url, fakeLogger());

    expect(server.notModifiedCount).toBe(1);
    expect(cache.hasPermission(["r1"], "p1")).toBe(true);
  });

  it("单次拉取失败（非 200/304）时 fail-static：沿用内存里的旧内容", async () => {
    server = await startFakeBundleServer();
    server.setBody({ roles: { r1: ["p1"] }, stale_since: {} });
    const cache = new BundleCache();
    await cache.fetchOnce(server.url, fakeLogger());
    expect(cache.hasPermission(["r1"], "p1")).toBe(true);

    server.setBody(null); // 之后的请求都 500
    await cache.fetchOnce(server.url, fakeLogger());

    expect(cache.hasEverFetched()).toBe(true); // 不会被失败的这次拉取清空
    expect(cache.hasPermission(["r1"], "p1")).toBe(true);
  });

  it("网络级失败（连不上）时 fail-static，不抛异常", async () => {
    const cache = new BundleCache();
    await expect(cache.fetchOnce("http://127.0.0.1:1/nowhere", fakeLogger())).resolves.toBeUndefined();
    expect(cache.hasEverFetched()).toBe(false);
  });

  it(
    "startBundlePoller：15 秒后角色变更真的生效（真实等待，不 mock 定时器）",
    async () => {
      server = await startFakeBundleServer();
      server.setBody({ roles: { r1: ["p1"] }, stale_since: {} });
      server.setEtag("v1");

      const cache = startBundlePoller(server.url, fakeLogger());
      const deadline = Date.now() + 5000;
      while (!cache.hasEverFetched() && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(cache.hasPermission(["r1"], "p1")).toBe(true);
      expect(cache.hasPermission(["r1"], "p2")).toBe(false);

      // 换一个新 ETag + 新角色分配，模拟 infra-authz 那边角色变更——
      // 不重启这个进程，等下一轮轮询（15 秒）自然生效。
      server.setEtag("v2");
      server.setBody({ roles: { r1: ["p1", "p2"] }, stale_since: {} });

      await new Promise((r) => setTimeout(r, BUNDLE_POLL_INTERVAL_MS + 2000));

      expect(cache.hasPermission(["r1"], "p2")).toBe(true);
    },
    BUNDLE_POLL_INTERVAL_MS + 10_000,
  );
});
